// computations/anomaly-detection.js — Anomaly detection engine
// No DOM dependencies. No external libraries. Pure arithmetic on existing regression data.
// Dependencies (loaded before this file):
//   - computations/regression.js (olsRegression)
//   - computations/normalization.js (getNormRows)
//   - computations/savings.js (via renderPerfPane which provides blRows, allRows, etc.)
//
// Usage: called from renderPerfPane after getNormRows() and buildMoMap() are ready.
//   const anomalyMap = computeAnomalyScores(m, allRows, blRows, bills, incl);
//   anomalyMap[ym] → { z_score, alert_level, predicted, actual, residual, ... }

// ── computeAnomalyScores ──────────────────────────────────────────────────────
// For each post-baseline month, compute z-score of actual vs predicted usage.
// Uses regression prediction (regrBaseline) as expected value.
// Returns {ym: { z_score, alert_level, predicted, actual, residual, delta_pct }}
// where alert_level is 'normal' | 'watch' | 'alert' | 'critical'
//
// allRows: output of getNormRows() — all calendar month rows
// blRows:  rows where isBaseline === true (training set)
// bills:   meter's raw bill array
// incl:    meter's inclusive setting
function computeAnomalyScores(m, allRows, blRows, bills, incl) {
  if (!m || !allRows || !blRows || blRows.length < 3) return {};

  const bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return {};

  const blEnd = bl.months.slice().sort().pop();

  // Post-baseline rows only — skip partial months
  const postRows = allRows.filter((r) => r.ym > blEnd && !r.partial);
  if (postRows.length < 2) return {};

  // Build residuals: actual - predicted for each post-baseline month
  // Use regrBaseline as predicted; fall back to baseline calendar-month avg
  const isElec = m.commodity === 'Electric';
  const isPropane = m.commodity === 'Propane';

  // Build actual usage by norm-month from raw bills (matches renderPerfPane)
  const rawUsageByYm = {};
  if (isPropane) {
    allRows.forEach((r) => {
      rawUsageByYm[r.ym] = r.usage;
    });
  } else {
    bills.forEach((b) => {
      const ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      const val = isElec ? parseFloat(b.kwh || 0) : parseFloat(b.therms || b.usage || b.kwh || 0);
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + val;
    });
  }

  // Baseline calendar-month averages (fallback when no regression)
  const blByCalMo = {};
  blRows.forEach((r) => {
    const calMo = parseInt(r.ym.split('-')[1]) - 1;
    if (!blByCalMo[calMo]) blByCalMo[calMo] = { sum: 0, count: 0 };
    blByCalMo[calMo].sum += r.usage;
    blByCalMo[calMo].count += 1;
  });
  const blAvgByCalMo = {};
  Object.entries(blByCalMo).forEach(([mo, v]) => {
    blAvgByCalMo[mo] = v.count > 0 ? v.sum / v.count : 0;
  });
  const blAvgMo = blRows.length ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length : 0;

  // Compute residuals for post-baseline months
  const residuals = [];
  postRows.forEach((r) => {
    const calMo = parseInt(r.ym.split('-')[1]) - 1;
    const actual = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
    const predicted =
      r.regrBaseline != null ? r.regrBaseline : blAvgByCalMo[calMo] != null ? blAvgByCalMo[calMo] : blAvgMo;
    if (predicted > 0) {
      residuals.push({ ym: r.ym, actual, predicted, residual: actual - predicted });
    }
  });

  if (residuals.length < 2) return {};

  // Mean and standard deviation of residuals
  const meanRes = residuals.reduce((s, r) => s + r.residual, 0) / residuals.length;
  const variance = residuals.reduce((s, r) => s + (r.residual - meanRes) ** 2, 0) / residuals.length;
  const stdRes = Math.sqrt(variance);

  // Build result map
  const result = {};
  residuals.forEach(({ ym, actual, predicted, residual }) => {
    const z_score = stdRes > 0 ? (residual - meanRes) / stdRes : 0;
    const absZ = Math.abs(z_score);
    let alert_level = 'normal';
    if (absZ >= 3.0) alert_level = 'critical';
    else if (absZ >= 2.0) alert_level = 'alert';
    else if (absZ >= 1.5) alert_level = 'watch';

    const delta_pct = predicted > 0 ? ((actual - predicted) / predicted) * 100 : 0;

    result[ym] = {
      z_score: +z_score.toFixed(2),
      alert_level,
      predicted: +predicted.toFixed(0),
      actual: +actual.toFixed(0),
      residual: +residual.toFixed(0),
      delta_pct: +delta_pct.toFixed(1),
    };
  });

  return result;
}

// ── getBaseloadTrend ──────────────────────────────────────────────────────────
// Isolates weather-independent usage for each post-baseline month and fits a
// linear trend. Returns { slope_per_year, intercept, is_creeping, months } or null.
//
// "Baseload" = actual_usage - (slope × DD) for each month.
// A positive slope_per_year means baseload is drifting upward over time.
function getBaseloadTrend(m, allRows, blRows) {
  if (!m || !allRows || !blRows || blRows.length < 3) return null;

  const bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return null;

  const frozenReg = m._reg;
  if (!frozenReg) return null;

  const isElec = m.commodity === 'Electric';
  const reg = isElec ? frozenReg.cdd : frozenReg.hdd;
  if (!reg) return null;

  const blEnd = bl.months.slice().sort().pop();
  const postRows = allRows.filter((r) => r.ym > blEnd && !r.partial);
  if (postRows.length < 6) return null; // need enough data for trend

  // Isolate weather-independent portion: actual_normalized - slope*DD
  const pts = [];
  postRows.forEach((r, idx) => {
    const dd = isElec ? (r.cdd != null ? r.cdd : 0) : r.hdd != null ? r.hdd : 0;
    const weatherLoad = reg.slope * dd;
    // normDays: calendar days in this month
    const normDays = r.normDays || 30;
    const baseload = r.usage - weatherLoad; // kWh (or therms) weather-independent
    const baseloadPerDay = normDays > 0 ? baseload / normDays : 0;
    pts.push({ x: idx, y: baseloadPerDay, ym: r.ym });
  });

  if (pts.length < 6) return null;

  const trendReg = olsRegression(
    pts.map((p) => p.x),
    pts.map((p) => p.y),
  );

  if (!trendReg) return null;

  // slope is in baseload_per_day per month — convert to per year
  const slopePerYear = trendReg.slope * 12;
  // Percent of baseline intercept (normalized baseload)
  const blInterceptPerDay = reg.intercept; // kWh/day baseload at baseline
  const pctChangePerYear = blInterceptPerDay > 0 ? (slopePerYear / blInterceptPerDay) * 100 : 0;

  // "Creeping" if slope is statistically meaningful: trend changes >3% per year
  const is_creeping = Math.abs(pctChangePerYear) > 3;

  return {
    slope_per_year: +slopePerYear.toFixed(3),
    pct_change_per_year: +pctChangePerYear.toFixed(1),
    is_creeping,
    trend_r2: +trendReg.r2.toFixed(3),
    months: pts.length,
    direction: slopePerYear > 0 ? 'increasing' : 'decreasing',
  };
}

// ── detectRateChanges ─────────────────────────────────────────────────────────
// Compare each post-baseline month's implied $/unit against trailing 6-month avg.
// Returns {ym: { implied_rate, trailing_avg, pct_above_avg, flag }} per month.
//
// bills: meter's raw bill array sorted ascending
// incl: meter's inclusive setting
function detectRateChanges(m, bills, incl) {
  if (!m || !bills || bills.length < 6) return {};

  const bl = m.baseline;
  if (!bl || !bl.months || !bl.months.length) return {};

  const blEnd = bl.months.slice().sort().pop();
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';
  const isPropane = m.commodity === 'Propane';

  // Build implied rate per norm-month from raw bills
  const rateByYm = {};
  bills.forEach((b) => {
    const ym = normMonth(b.start, b.end, incl, bills);
    if (!ym) return;
    let usage = 0;
    let cost = 0;
    if (isElec) {
      usage = parseFloat(b.kwh || 0);
      cost = parseFloat(b.totalCost || 0);
    } else if (isGas) {
      usage = parseFloat(b.therms || 0);
      cost = parseFloat(b.gasCharge || b.thermCost || b.totalCost || b.cost || 0);
    } else if (isPropane) {
      usage = parseFloat(b.gallonsDelivered || b.kwh || 0);
      cost = parseFloat(b.totalCost || b.cost || 0);
    } else {
      return; // Water/Sewer: no meaningful rate comparison
    }
    if (usage > 0 && cost > 0) {
      const rate = cost / usage;
      if (!rateByYm[ym] || rate > rateByYm[ym]) rateByYm[ym] = rate;
    }
  });

  const sortedYms = Object.keys(rateByYm).sort();
  const result = {};

  sortedYms.forEach((ym, idx) => {
    if (ym <= blEnd) return; // only post-baseline

    // Trailing 6-month average (from prior months, not current)
    const prior = sortedYms.slice(0, idx).slice(-6);
    if (prior.length < 3) return; // need at least 3 months of history

    const trailingAvg = prior.reduce((s, y) => s + rateByYm[y], 0) / prior.length;
    const implied = rateByYm[ym];
    const pct_above_avg = trailingAvg > 0 ? ((implied - trailingAvg) / trailingAvg) * 100 : 0;

    result[ym] = {
      implied_rate: +implied.toFixed(4),
      trailing_avg: +trailingAvg.toFixed(4),
      pct_above_avg: +pct_above_avg.toFixed(1),
      flag: Math.abs(pct_above_avg) >= 10, // flag if ±10% from trailing avg
    };
  });

  return result;
}

// ── getAnomalySummary ─────────────────────────────────────────────────────────
// Returns a summary object for the meter card badge.
// { alertCount, highestSeverity, recentAlerts, hasBaseloadCreep, hasRateChange }
//
// scoreMap: output of computeAnomalyScores()
// rateMap:  output of detectRateChanges()
// baseloadTrend: output of getBaseloadTrend()
function getAnomalySummary(scoreMap, rateMap, baseloadTrend) {
  const severityOrder = { critical: 4, alert: 3, watch: 2, normal: 1 };
  let alertCount = 0;
  let highestSeverity = 'normal';

  const recentAlerts = [];
  const sortedYms = Object.keys(scoreMap).sort().slice(-12); // last 12 months

  sortedYms.forEach((ym) => {
    const s = scoreMap[ym];
    if (!s || s.alert_level === 'normal') return;
    alertCount++;
    if (severityOrder[s.alert_level] > severityOrder[highestSeverity]) {
      highestSeverity = s.alert_level;
    }
    recentAlerts.push({
      ym,
      alert_level: s.alert_level,
      z_score: s.z_score,
      delta_pct: s.delta_pct,
      actual: s.actual,
      predicted: s.predicted,
    });
  });

  // Rate change flags
  const rateAlerts = Object.entries(rateMap || {})
    .filter(([, v]) => v && v.flag)
    .map(([ym, v]) => ({ ym, pct_above_avg: v.pct_above_avg }));

  if (rateAlerts.length > 0 && highestSeverity === 'normal') highestSeverity = 'watch';

  return {
    alertCount,
    highestSeverity,
    recentAlerts: recentAlerts.sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score)).slice(0, 5),
    hasBaseloadCreep: !!(baseloadTrend && baseloadTrend.is_creeping),
    baseloadTrend: baseloadTrend || null,
    hasRateChange: rateAlerts.length > 0,
    rateAlerts: rateAlerts.slice(-3),
  };
}

// ── attachAnomalyToBills ──────────────────────────────────────────────────────
// Attach _anomaly object to each bill row (transient — not persisted to localStorage).
// This makes the score accessible anywhere that has the bill object.
// scoreMap: output of computeAnomalyScores()
// bills: meter's raw bill array
// incl: meter's inclusive setting
function attachAnomalyToBills(scoreMap, bills, incl) {
  if (!scoreMap || !bills) return;
  bills.forEach((b) => {
    const ym = normMonth(b.start, b.end, incl, bills);
    if (ym && scoreMap[ym]) {
      b._anomaly = scoreMap[ym];
    } else {
      b._anomaly = null;
    }
  });
}

// ── anomalyAlertHTML ──────────────────────────────────────────────────────────
// Builds the HTML for the anomaly alert panel (injected into renderPerfPane).
// scoreMap: output of computeAnomalyScores()
// rateMap:  output of detectRateChanges()
// baseloadTrend: output of getBaseloadTrend()
// unit: 'kWh' | 'Therms' | 'Gallons' | etc.
function anomalyAlertHTML(scoreMap, rateMap, baseloadTrend, unit) {
  const summary = getAnomalySummary(scoreMap, rateMap, baseloadTrend);

  const alertRows = Object.entries(scoreMap)
    .filter(([, s]) => s && s.alert_level !== 'normal')
    .sort((a, b) => Math.abs(b[1].z_score) - Math.abs(a[1].z_score))
    .slice(0, 10);

  const rateRows = Object.entries(rateMap || {}).filter(([, v]) => v && v.flag);

  if (alertRows.length === 0 && rateRows.length === 0 && !summary.hasBaseloadCreep) {
    return (
      '<div style="font-size:12px;color:var(--text3);padding:8px 12px;background:var(--s3);border-radius:6px;border:1px solid var(--border)">' +
      '<span style="color:#22c55e;font-weight:700">✓ No anomalies detected</span>' +
      ' — All post-baseline months are within expected range.' +
      '</div>'
    );
  }

  const colorMap = {
    watch: '#3b82f6',
    alert: '#f97316',
    critical: '#ef4444',
  };
  const labelMap = {
    watch: 'WATCH',
    alert: 'ALERT',
    critical: 'CRITICAL',
  };

  let html =
    '<div style="background:var(--s3);border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:10px">';
  html +=
    '<div style="padding:8px 12px;background:var(--s2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">';
  html +=
    '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Anomaly Alerts</span>';
  if (summary.alertCount > 0) {
    const badgeColor = colorMap[summary.highestSeverity] || '#3b82f6';
    html +=
      '<span style="font-size:10px;font-weight:700;color:' +
      badgeColor +
      ';background:' +
      badgeColor +
      '22;padding:1px 6px;border-radius:10px;border:1px solid ' +
      badgeColor +
      '55">' +
      summary.alertCount +
      ' flagged</span>';
  }
  html += '</div>';
  html += '<div style="padding:8px 0">';

  // Usage z-score alerts
  alertRows.forEach(([ym, s]) => {
    const color = colorMap[s.alert_level] || '#3b82f6';
    const label = labelMap[s.alert_level] || s.alert_level;
    const dir = s.delta_pct >= 0 ? '+' : '';
    const [yr, mo] = ym.split('-');
    const moLabel = new Date(parseInt(yr), parseInt(mo) - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    const dirWord = s.delta_pct >= 0 ? 'above' : 'below';
    html +=
      '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.04)">';
    html +=
      '<span style="font-size:9px;font-weight:700;color:' +
      color +
      ';background:' +
      color +
      '22;padding:2px 5px;border-radius:3px;margin-top:1px;white-space:nowrap;border:1px solid ' +
      color +
      '55">' +
      label +
      '</span>';
    html += '<div style="font-size:11px;color:var(--text)">';
    html +=
      '<strong style="color:var(--text2)">' +
      moLabel +
      '</strong> · Usage ' +
      dir +
      s.delta_pct.toFixed(1) +
      '% ' +
      dirWord +
      ' expected ';
    html +=
      '<span style="color:var(--text3)">(z=' +
      s.z_score.toFixed(1) +
      ' · Expected ' +
      s.predicted.toLocaleString() +
      ' ' +
      unit +
      ', Actual ' +
      s.actual.toLocaleString() +
      ' ' +
      unit +
      ')</span>';
    html += '</div></div>';
  });

  // Rate change alerts
  rateRows.forEach(([ym, v]) => {
    const [yr, mo] = ym.split('-');
    const moLabel = new Date(parseInt(yr), parseInt(mo) - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    const dir = v.pct_above_avg >= 0 ? '+' : '';
    html +=
      '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.04)">';
    html +=
      '<span style="font-size:9px;font-weight:700;color:#3b82f6;background:#3b82f622;padding:2px 5px;border-radius:3px;margin-top:1px;white-space:nowrap;border:1px solid #3b82f655">RATE</span>';
    html += '<div style="font-size:11px;color:var(--text)">';
    html +=
      '<strong style="color:var(--text2)">' +
      moLabel +
      '</strong> · Implied rate ' +
      dir +
      v.pct_above_avg.toFixed(1) +
      '% vs trailing avg ';
    html +=
      '<span style="color:var(--text3)">($' +
      v.implied_rate.toFixed(4) +
      '/' +
      unit.toLowerCase().replace('kwh', 'kWh') +
      ' vs avg $' +
      v.trailing_avg.toFixed(4) +
      ')</span>';
    html += '</div></div>';
  });

  // Baseload creep
  if (summary.hasBaseloadCreep && baseloadTrend) {
    const t = baseloadTrend;
    const dir = t.slope_per_year >= 0 ? 'increasing' : 'decreasing';
    const pct = Math.abs(t.pct_change_per_year).toFixed(1);
    html += '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 12px">';
    html +=
      '<span style="font-size:9px;font-weight:700;color:#f97316;background:#f9731622;padding:2px 5px;border-radius:3px;margin-top:1px;white-space:nowrap;border:1px solid #f9731655">CREEP</span>';
    html += '<div style="font-size:11px;color:var(--text)">';
    html +=
      '<strong style="color:var(--text2)">Baseload Creep</strong> · Weather-independent usage is ' +
      dir +
      ' ~' +
      pct +
      '% per year';
    html +=
      ' <span style="color:var(--text3)">(R²=' +
      t.trend_r2.toFixed(2) +
      ', ' +
      t.months +
      ' months of post-baseline data)</span>';
    html += '</div></div>';
  }

  html += '</div></div>';
  return html;
}

// ── anomalyBadgeHTML ──────────────────────────────────────────────────────────
// Returns a small colored dot HTML string for the meter pill badge.
// severity: 'normal' | 'watch' | 'alert' | 'critical'
function anomalyBadgeHTML(severity) {
  if (!severity || severity === 'normal') return '';
  const map = {
    watch: { color: '#3b82f6', title: 'Usage anomaly detected — watch level' },
    alert: { color: '#f97316', title: 'Usage anomaly detected — alert level' },
    critical: { color: '#ef4444', title: 'Usage anomaly detected — critical level' },
  };
  const cfg = map[severity];
  if (!cfg) return '';
  return (
    '<span title="' +
    cfg.title +
    '" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' +
    cfg.color +
    ';margin-left:3px;flex-shrink:0;box-shadow:0 0 4px ' +
    cfg.color +
    '88;vertical-align:middle"></span>'
  );
}

// ── anomalyChartDatasets ──────────────────────────────────────────────────────
// Returns Chart.js dataset(s) to overlay anomaly markers on the perf chart.
// scoreMap: {ym: { z_score, alert_level, ... }}
// rows: chartRows array from renderPerfPane (same order as x-axis)
// isTotal: true = monthly total metric, false = per-day metric
// unit: display unit string
function anomalyChartDatasets(scoreMap, rows, isTotal, unit) {
  if (!scoreMap || !rows || !rows.length) return [];

  const colorMap = {
    watch: 'rgba(59,130,246,0.9)',
    alert: 'rgba(249,115,22,0.9)',
    critical: 'rgba(239,68,68,0.9)',
  };

  // Build point arrays — null for months without anomaly flags
  // We overlay a scatter-like dataset using the actual bar value plus a small offset
  const watchData = [];
  const alertData = [];
  const criticalData = [];

  rows.forEach((r) => {
    const score = scoreMap[r.ym];
    const hasFlag = score && score.alert_level !== 'normal';
    const val = hasFlag ? (isTotal ? +(r.usage || 0).toFixed(0) : +(r.usagePerDay || 0).toFixed(2)) : null;

    watchData.push(score && score.alert_level === 'watch' ? val : null);
    alertData.push(score && score.alert_level === 'alert' ? val : null);
    criticalData.push(score && score.alert_level === 'critical' ? val : null);
  });

  const datasets = [];
  const hasWatch = watchData.some((v) => v !== null);
  const hasAlert = alertData.some((v) => v !== null);
  const hasCritical = criticalData.some((v) => v !== null);

  function makeTooltipLabel(scoreMap, rows, levelFilter) {
    return function (ctx) {
      const row = rows[ctx.dataIndex];
      if (!row) return null;
      const score = scoreMap[row.ym];
      if (!score || score.alert_level !== levelFilter) return null;
      const dir = score.delta_pct >= 0 ? 'above' : 'below';
      const sign = score.delta_pct >= 0 ? '+' : '';
      return (
        ' Anomaly: ' + sign + score.delta_pct.toFixed(1) + '% ' + dir + ' expected (z=' + score.z_score.toFixed(1) + ')'
      );
    };
  }

  if (hasWatch) {
    datasets.push({
      label: 'Watch',
      data: watchData,
      type: 'bubble',
      backgroundColor: colorMap.watch,
      borderColor: 'rgba(59,130,246,1)',
      borderWidth: 1.5,
      radius: 6,
      hoverRadius: 8,
      order: 0,
      _tooltipLabel: makeTooltipLabel(scoreMap, rows, 'watch'),
    });
  }

  if (hasAlert) {
    datasets.push({
      label: 'Alert',
      data: alertData,
      type: 'bubble',
      backgroundColor: colorMap.alert,
      borderColor: 'rgba(249,115,22,1)',
      borderWidth: 1.5,
      radius: 7,
      hoverRadius: 9,
      order: 0,
      _tooltipLabel: makeTooltipLabel(scoreMap, rows, 'alert'),
    });
  }

  if (hasCritical) {
    datasets.push({
      label: 'Critical',
      data: criticalData,
      type: 'bubble',
      backgroundColor: colorMap.critical,
      borderColor: 'rgba(239,68,68,1)',
      borderWidth: 2,
      radius: 8,
      hoverRadius: 10,
      order: 0,
      _tooltipLabel: makeTooltipLabel(scoreMap, rows, 'critical'),
    });
  }

  return datasets;
}
