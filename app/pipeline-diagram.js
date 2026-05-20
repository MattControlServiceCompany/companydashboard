/* ═══════════════════════════════════════════════════════════════════════
   PIPELINE DIAGRAM — Computation Pipeline Visualizer
   Shows how data flows from Utility Bills → Savings for a selected meter.
   Rendered as the "🔀 Data Pipeline" tab in the meter workspace.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Node definitions (static metadata) ── */
const PD_NODES = [
  {
    id: 'bills',
    label: 'Utility Bills',
    icon: '🧾',
    col: 0,
    row: 0,
    color: 'var(--em2)',
    colorDim: 'var(--em2-dim)',
    desc: 'Raw billing periods imported from PDF or manual entry.',
  },
  {
    id: 'weather',
    label: 'Weather Data',
    icon: '🌡️',
    col: 0,
    row: 1,
    color: 'var(--accent)',
    colorDim: 'var(--accent-dim)',
    desc: 'HDD/CDD data loaded from NOAA ZIP-code weather cache.',
  },
  {
    id: 'norm',
    label: 'Normalization',
    icon: '📐',
    col: 1,
    row: 0,
    color: 'var(--teal)',
    colorDim: 'var(--teal-dim)',
    desc: 'Bills pro-rated to calendar months; propane HDD-distributed.',
  },
  {
    id: 'regression',
    label: 'Regression',
    icon: '📉',
    col: 2,
    row: 0,
    color: 'var(--violet)',
    colorDim: 'var(--violet-dim)',
    desc: 'OLS regression: usage/day vs. DD/day → slope, intercept, r².',
  },
  {
    id: 'baseline',
    label: 'Baseline',
    icon: '📊',
    col: 3,
    row: 0,
    color: 'var(--amber)',
    colorDim: 'var(--amber-dim)',
    desc: 'Frozen baseline period. Monthly values from regression or overrides.',
  },
  {
    id: 'savings',
    label: 'Savings Calc',
    icon: '💰',
    col: 4,
    row: 0,
    color: 'var(--green)',
    colorDim: 'rgba(34,197,94,0.1)',
    desc: '(Baseline − Actual) × Rate. Calculated monthly, summed annually.',
  },
  {
    id: 'anomaly',
    label: 'Anomaly Detection',
    icon: '⚠️',
    col: 3,
    row: 1,
    color: 'var(--warn)',
    colorDim: 'var(--warn-dim)',
    desc: 'Z-score check on monthly usage vs. regression baseline.',
  },
  {
    id: 'charts',
    label: 'Charts',
    icon: '📈',
    col: 5,
    row: 0,
    color: 'var(--lime)',
    colorDim: 'var(--lime-dim)',
    desc: 'Normalized usage, baseline overlay, savings waterfall charts.',
  },
];

/* ── Edge definitions ── */
const PD_EDGES = [
  { from: 'bills', to: 'norm', label: 'billing periods' },
  { from: 'weather', to: 'norm', label: 'HDD/CDD by month' },
  { from: 'norm', to: 'regression', label: 'norm rows' },
  { from: 'regression', to: 'baseline', label: 'slope + intercept' },
  { from: 'baseline', to: 'savings', label: 'baseline monthly values' },
  { from: 'norm', to: 'savings', label: 'actual monthly values' },
  { from: 'norm', to: 'anomaly', label: 'norm rows' },
  { from: 'regression', to: 'anomaly', label: 'predicted baseline' },
  { from: 'savings', to: 'charts', label: 'monthly savings $' },
  { from: 'baseline', to: 'charts', label: 'baseline trend' },
];

/* ── Active selection state ── */
let _pdActive = null; // 'bills' | 'weather' | 'norm' | ... | null
let _pdEdgeActive = null; // edge key 'from:to' | null

/* ── Utility functions ── */
function _pdFmt(n, decimals) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals != null ? decimals : 1 });
}
function _pdFmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function _pdFmtYm(ym) {
  if (!ym || typeof ym !== 'string') return ym;
  const parts = ym.split('-');
  return parts.length === 2 ? parts[1] + '/' + parts[0] : ym;
}

/* ── Build node detail content ── */
function _pdNodeDetail(nodeId, m, bills, incl) {
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';
  const isPropane = m.commodity === 'Propane';
  const unit = getMeterDisplayUnit
    ? getMeterDisplayUnit(m)
    : isElec
      ? 'kWh'
      : isGas
        ? 'Therms'
        : isPropane
          ? 'Gal'
          : 'units';

  // Helper: get norm rows (reusing existing function)
  function _getRows() {
    try {
      const { byYm } = getWeatherForBuilding ? getWeatherForBuilding() : { byYm: null };
      return getNormRows(m, bills, incl, byYm);
    } catch (e) {
      return [];
    }
  }

  switch (nodeId) {
    case 'bills': {
      if (!bills.length) return '<p style="color:var(--text3)">No bills entered yet.</p>';
      const sorted = bills.slice().sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const first = sorted[0]?.start || '—';
      const last = sorted[sorted.length - 1]?.end || '—';
      const commodities = [...new Set(bills.map(() => m.commodity))];
      const totalCost = bills.reduce((s, b) => s + (parseFloat(b.totalCost) || 0), 0);
      return (
        '<div class="pd-stat-grid">' +
        _pdStatCard('Bills', bills.length, 'periods') +
        _pdStatCard('Date Range', first.slice(0, 7) + ' → ' + last.slice(0, 7), '') +
        _pdStatCard('Commodity', m.commodity, '') +
        _pdStatCard('Total Cost', _pdFmtMoney(totalCost), '') +
        '</div>' +
        '<div class="pd-code-block">' +
        '<div class="pd-code-label">Storage path</div>' +
        '<code>en_utility_' +
        (udSelProjId || '?') +
        ' → buildings → meters → [' +
        m.id +
        '] → bills[]</code>' +
        '</div>'
      );
    }

    case 'weather': {
      let weatherInfo;
      try {
        const { byYm, cache, zip } = getWeatherForBuilding
          ? getWeatherForBuilding()
          : { byYm: null, cache: [], zip: '' };
        if (!zip) {
          return '<p style="color:var(--text3)">No ZIP code set on this building.<br>Add one in the building settings to enable weather normalization.</p>';
        }
        if (!cache || !cache.length) {
          return (
            '<p style="color:var(--text3)">ZIP code is set (' +
            zip +
            ') but no weather data uploaded yet.<br>Use the weather upload button in the Normalized tab.</p>'
          );
        }
        const sorted = cache.slice().sort((a, b) => (a.ym || '').localeCompare(b.ym || ''));
        const first = sorted[0]?.ym || '—';
        const last = sorted[sorted.length - 1]?.ym || '—';
        const avgHDD = cache.reduce((s, r) => s + (r.hdd || 0), 0) / cache.length;
        const avgCDD = cache.reduce((s, r) => s + (r.cdd || 0), 0) / cache.length;
        weatherInfo =
          '<div class="pd-stat-grid">' +
          _pdStatCard('ZIP Code', zip, '') +
          _pdStatCard('Months Available', cache.length, 'months') +
          _pdStatCard('Date Range', _pdFmtYm(first) + ' → ' + _pdFmtYm(last), '') +
          _pdStatCard('Avg HDD/mo', _pdFmt(avgHDD, 0), 'HDD') +
          _pdStatCard('Avg CDD/mo', _pdFmt(avgCDD, 0), 'CDD') +
          '</div>' +
          '<div class="pd-code-block">' +
          '<div class="pd-code-label">Source</div>' +
          "<code>localStorage['wdd_cache_" +
          zip +
          "'] — NOAA GHCND daily data, aggregated to monthly</code>" +
          '</div>';
      } catch (e) {
        weatherInfo = '<p style="color:var(--text3)">Could not load weather data.</p>';
      }
      return weatherInfo;
    }

    case 'norm': {
      const rows = _getRows();
      if (!rows.length) return '<p style="color:var(--text3)">No normalization rows available. Add bills first.</p>';
      const hasWeather = rows.some((r) => r.hdd != null || r.cdd != null);
      const partialCount = rows.filter((r) => r.partial).length;
      const funcName = isPropane ? 'normalizePropaneDeliveries()' : 'getNormRows()';
      const method = isPropane
        ? 'HDD-weighted distribution across months between deliveries'
        : 'Day-prorating: each bill split across calendar months by day fraction';
      return (
        '<div class="pd-stat-grid">' +
        _pdStatCard('Norm Rows', rows.length, 'months') +
        _pdStatCard('Partial Months', partialCount, 'excluded from regression') +
        _pdStatCard('Weather Available', hasWeather ? 'Yes' : 'No', '') +
        _pdStatCard('Method', isPropane ? 'HDD-weighted' : 'Day-prorate', '') +
        '</div>' +
        '<div class="pd-code-block">' +
        '<div class="pd-code-label">Function called</div>' +
        '<code>' +
        funcName +
        '</code>' +
        '</div>' +
        '<div class="pd-code-block" style="margin-top:8px">' +
        '<div class="pd-code-label">Method</div>' +
        '<code>' +
        method +
        '</code>' +
        '</div>'
      );
    }

    case 'regression': {
      const rows = _getRows();
      const reg = m._reg;
      if (!reg && !rows.length)
        return '<p style="color:var(--text3)">No regression data. Add bills and weather data first.</p>';

      const hddReg = reg?.hdd;
      const cddReg = reg?.cdd;
      const dualReg = reg?.dual;
      const frozenReg = m.baseline?.reg;
      const isFrozen = !!(frozenReg && frozenReg !== reg);

      let regHTML = '';
      if (dualReg) {
        regHTML +=
          '<div class="pd-eq-block">' +
          '<div class="pd-eq-label">Dual (HDD+CDD) Regression</div>' +
          '<div class="pd-eq">y = ' +
          dualReg.intercept.toFixed(3) +
          ' × days + ' +
          dualReg.slopeHDD.toFixed(3) +
          ' × HDD + ' +
          dualReg.slopeCDD.toFixed(3) +
          ' × CDD</div>' +
          '<div class="pd-eq-sub">r² = ' +
          (dualReg.r2 != null ? dualReg.r2.toFixed(3) : '—') +
          ' | n = ' +
          (dualReg.n || '—') +
          '</div>' +
          '</div>';
      }
      if (hddReg) {
        regHTML +=
          '<div class="pd-eq-block">' +
          '<div class="pd-eq-label">' +
          (isElec ? 'Fallback: ' : 'Primary: ') +
          'HDD Regression</div>' +
          '<div class="pd-eq">y = ' +
          hddReg.intercept.toFixed(3) +
          ' × days + ' +
          hddReg.slope.toFixed(3) +
          ' × HDD</div>' +
          '<div class="pd-eq-sub">r² = ' +
          (hddReg.r2 != null ? hddReg.r2.toFixed(3) : '—') +
          ' | n = ' +
          (hddReg.n || '—') +
          ' | bias = ' +
          (hddReg.bias != null ? hddReg.bias.toFixed(4) : '—') +
          '</div>' +
          '</div>';
      }
      if (cddReg) {
        regHTML +=
          '<div class="pd-eq-block">' +
          '<div class="pd-eq-label">' +
          (isElec ? 'Primary: ' : 'Fallback: ') +
          'CDD Regression</div>' +
          '<div class="pd-eq">y = ' +
          cddReg.intercept.toFixed(3) +
          ' × days + ' +
          cddReg.slope.toFixed(3) +
          ' × CDD</div>' +
          '<div class="pd-eq-sub">r² = ' +
          (cddReg.r2 != null ? cddReg.r2.toFixed(3) : '—') +
          ' | n = ' +
          (cddReg.n || '—') +
          ' | bias = ' +
          (cddReg.bias != null ? cddReg.bias.toFixed(4) : '—') +
          '</div>' +
          '</div>';
      }
      if (!regHTML) {
        regHTML =
          '<p style="color:var(--text3)">No regression coefficients computed. Upload weather data in the Normalized tab.</p>';
      }
      if (isFrozen) {
        regHTML +=
          '<div class="pd-frozen-badge">Frozen regression used for baseline — locked at baseline save time</div>';
      }
      return (
        '<div class="pd-code-block" style="margin-bottom:10px">' +
        '<div class="pd-code-label">Function</div>' +
        '<code>computeMeterRegression(rows) in computations/regression.js</code>' +
        '</div>' +
        regHTML
      );
    }

    case 'baseline': {
      const bl = m.baseline;
      if (!bl || !bl.months || !bl.months.length) {
        return '<p style="color:var(--text3)">No baseline set for this meter.<br>Go to the Baseline tab and select baseline months.</p>';
      }
      const rows = _getRows();
      const blRows = rows.filter((r) => bl.months.includes(r.ym));
      const avgMo = blRows.length
        ? blRows.reduce((s, r) => s + (r.regrBaseline != null ? r.regrBaseline : r.usage), 0) / blRows.length
        : null;
      const totalBl = blRows.reduce((s, r) => s + (r.regrBaseline != null ? r.regrBaseline : r.usage), 0);
      const hasFrozen = !!bl.reg;
      const overrideCount = bl.overrides ? Object.keys(bl.overrides).length : 0;

      return (
        '<div class="pd-stat-grid">' +
        _pdStatCard('Baseline Months', bl.months.length, 'months') +
        _pdStatCard('Period', _pdFmtYm(bl.months[0]) + ' → ' + _pdFmtYm(bl.months[bl.months.length - 1]), '') +
        _pdStatCard('Avg Monthly', avgMo != null ? _pdFmt(avgMo, 0) + ' ' + unit : '—', '') +
        _pdStatCard('Frozen Regression', hasFrozen ? 'Yes' : 'No', '') +
        _pdStatCard('Manual Overrides', overrideCount, overrideCount === 1 ? 'month' : 'months') +
        '</div>' +
        '<div class="pd-code-block">' +
        '<div class="pd-code-label">Storage path</div>' +
        '<code>meter.baseline.months[] + meter.baseline.reg + meter.baseline.overrides{}</code>' +
        '</div>'
      );
    }

    case 'savings': {
      // Pull savings from energy-savings data if available
      let savHTML = '';
      try {
        const proj = getUDProj ? getUDProj(udSelProjId) : null;
        const rows = _getRows();
        const bl = m.baseline;
        if (!bl || !bl.months || !bl.months.length) {
          return '<p style="color:var(--text3)">No baseline set — savings cannot be calculated.</p>';
        }
        // Calculate savings per month (last 12 non-baseline months vs regression baseline)
        const nonBlRows = rows.filter((r) => !bl.months.includes(r.ym) && r.regrBaseline != null);
        const last12 = nonBlRows.slice(-12);
        if (!last12.length) {
          return '<p style="color:var(--text3)">No post-baseline billing months found.</p>';
        }
        // Estimate rate from baseline bills
        const blBills = bills.filter((b) => {
          const ym = normMonth ? normMonth(b.start, b.end, incl, bills) : null;
          return ym && bl.months.includes(ym);
        });
        const avgRate = blBills.length
          ? blBills.reduce((s, b) => {
              const usage = isElec
                ? parseFloat(b.kwh) || 0
                : isGas
                  ? parseFloat(b.therms) || 0
                  : parseFloat(b.gallons) || 0;
              const cost = parseFloat(b.totalCost) || 0;
              return s + (usage > 0 ? cost / usage : 0);
            }, 0) /
            blBills.filter((b) => {
              const usage = isElec
                ? parseFloat(b.kwh) || 0
                : isGas
                  ? parseFloat(b.therms) || 0
                  : parseFloat(b.gallons) || 0;
              return usage > 0;
            }).length
          : null;

        let totalSav = 0;
        let monthRows = '';
        last12.forEach((r) => {
          const sav = r.regrBaseline - r.usage;
          const rate = avgRate || 0;
          const savDol = sav * rate;
          totalSav += savDol;
          monthRows +=
            '<tr>' +
            '<td style="padding:4px 8px;color:var(--text2)">' +
            _pdFmtYm(r.ym) +
            '</td>' +
            '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">' +
            _pdFmt(r.regrBaseline, 0) +
            '</td>' +
            '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">' +
            _pdFmt(r.usage, 0) +
            '</td>' +
            '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:' +
            (sav >= 0 ? 'var(--green)' : 'var(--red)') +
            '">' +
            _pdFmt(sav, 0) +
            '</td>' +
            '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:' +
            (savDol >= 0 ? 'var(--green)' : 'var(--red)') +
            '">' +
            (avgRate ? _pdFmtMoney(savDol) : '—') +
            '</td>' +
            '</tr>';
        });
        savHTML =
          '<div class="pd-code-block" style="margin-bottom:10px">' +
          '<div class="pd-code-label">Formula (per month)</div>' +
          '<code>Savings = (Baseline Usage − Actual Usage) × Current Rate</code>' +
          '</div>' +
          '<div class="pd-stat-grid" style="margin-bottom:12px">' +
          _pdStatCard(
            'Est. Annual Savings',
            avgRate ? _pdFmtMoney(totalSav) : 'Rate unknown',
            avgRate ? '(last ' + last12.length + ' months)' : 'Add rates in Savings tab',
          ) +
          _pdStatCard('Rate Used', avgRate ? '$' + avgRate.toFixed(4) + '/' + unit : '—', 'avg from baseline period') +
          '</div>' +
          '<div style="overflow-x:auto">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="border-bottom:1px solid var(--border)">' +
          '<th style="padding:4px 8px;text-align:left;color:var(--text3);font-weight:600">Month</th>' +
          '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Baseline ' +
          unit +
          '</th>' +
          '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Actual ' +
          unit +
          '</th>' +
          '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Saved ' +
          unit +
          '</th>' +
          '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Saved $</th>' +
          '</tr></thead>' +
          '<tbody>' +
          monthRows +
          '</tbody>' +
          '</table>' +
          '</div>' +
          '<p style="font-size:11px;color:var(--text3);margin-top:8px;font-style:italic">Note: ' +
          (bl.months[0] ? bl.months[0].slice(0, 4) : 'baseline year') +
          ' is excluded (baseline period).</p>';
      } catch (e) {
        savHTML = '<p style="color:var(--text3)">Could not compute savings: ' + e.message + '</p>';
      }
      return savHTML;
    }

    case 'anomaly': {
      try {
        const rows = _getRows();
        const reg = m._reg;
        if (!rows.length || !reg) {
          return '<p style="color:var(--text3)">Anomaly detection requires bills and regression data.</p>';
        }
        // Compute residuals and z-scores (exclude partial months to avoid false anomalies)
        const residuals = rows.filter((r) => r.regrBaseline != null && !r.partial).map((r) => r.usage - r.regrBaseline);
        if (!residuals.length) return '<p style="color:var(--text3)">No regression baseline rows to check.</p>';
        const mean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
        const variance = residuals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / residuals.length;
        const stddev = Math.sqrt(variance);
        const alerts = rows
          .filter((r) => r.regrBaseline != null && !r.partial)
          .map((r) => {
            const residual = r.usage - r.regrBaseline;
            const z = stddev > 0 ? (residual - mean) / stddev : 0;
            return { ym: r.ym, residual, z, usage: r.usage, baseline: r.regrBaseline };
          })
          .filter((r) => Math.abs(r.z) >= 2.0)
          .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

        const alertRows = alerts
          .slice(0, 8)
          .map(
            (a) =>
              '<tr>' +
              '<td style="padding:4px 8px;color:var(--text2)">' +
              _pdFmtYm(a.ym) +
              '</td>' +
              '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">' +
              _pdFmt(a.usage, 0) +
              ' ' +
              unit +
              '</td>' +
              '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">' +
              _pdFmt(a.baseline, 0) +
              ' ' +
              unit +
              '</td>' +
              '<td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:' +
              (a.z > 0 ? 'var(--red)' : 'var(--em2)') +
              '">' +
              (a.z > 0 ? '+' : '') +
              a.z.toFixed(2) +
              '</td>' +
              '</tr>',
          )
          .join('');

        return (
          '<div class="pd-stat-grid" style="margin-bottom:12px">' +
          _pdStatCard('Months Checked', rows.filter((r) => r.regrBaseline != null && !r.partial).length, '') +
          _pdStatCard('Anomalies (|z| ≥ 2)', alerts.length, 'months') +
          _pdStatCard('Std Dev', _pdFmt(stddev, 1) + ' ' + unit, 'residual std dev') +
          '</div>' +
          (alerts.length
            ? '<div style="overflow-x:auto">' +
              '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
              '<thead><tr style="border-bottom:1px solid var(--border)">' +
              '<th style="padding:4px 8px;text-align:left;color:var(--text3);font-weight:600">Month</th>' +
              '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Actual</th>' +
              '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Baseline</th>' +
              '<th style="padding:4px 8px;text-align:right;color:var(--text3);font-weight:600">Z-Score</th>' +
              '</tr></thead>' +
              '<tbody>' +
              alertRows +
              '</tbody>' +
              '</table></div>'
            : '<p style="color:var(--green)">No anomalies detected (all months within 2 standard deviations).</p>')
        );
      } catch (e) {
        return '<p style="color:var(--text3)">Anomaly detection error: ' + e.message + '</p>';
      }
    }

    case 'charts': {
      const rows = _getRows();
      const bl = m.baseline;
      const hasNorm = rows.length > 0;
      const hasBl = bl && bl.months && bl.months.length >= 3;
      const hasRegr = rows.some((r) => r.regrBaseline != null);
      return (
        '<div class="pd-stat-grid">' +
        _pdStatCard('Norm Chart', hasNorm ? 'Ready' : 'Needs bills', hasNorm ? '(Normalized tab)' : '') +
        _pdStatCard('Baseline Chart', hasBl ? 'Ready' : 'Needs baseline', hasBl ? '(Baseline tab)' : '') +
        _pdStatCard(
          'Regression Overlay',
          hasRegr ? 'Ready' : 'Needs weather',
          hasRegr ? 'visible in Normalized tab' : '',
        ) +
        _pdStatCard('Perf Chart', hasBl ? 'Ready' : 'Needs baseline', hasBl ? '(Meter Performance tab)' : '') +
        '</div>' +
        '<div class="pd-code-block">' +
        '<div class="pd-code-label">Rendering library</div>' +
        '<code>Chart.js via lib/shared-charts.js — renderLineChart(), renderBarChart()</code>' +
        '</div>'
      );
    }

    default:
      return '<p style="color:var(--text3)">No detail available for this node.</p>';
  }
}

/* ── Edge detail content ── */
function _pdEdgeDetail(edge, m, bills, incl) {
  const edgeDetails = {
    'bills:norm': {
      title: 'Bills → Normalization',
      what: "Each billing record (start, end, usage, cost) is passed to getNormRows(). Bills are sorted by start date. The normalization function prorates each bill's usage/cost across calendar months by counting days per month.",
      fields: 'start, end, kwh/therms/gallons, totalCost, hdd (bill-level fallback)',
    },
    'weather:norm': {
      title: 'Weather → Normalization',
      what: 'Monthly HDD/CDD values from the ZIP weather cache (wdd_cache_{zip}) are merged into each normalized month row. These override any HDD/CDD values from individual bill records.',
      fields: 'ym, hdd, cdd, avgTemp — one row per calendar month',
    },
    'norm:regression': {
      title: 'Normalization → Regression',
      what: 'Normalized month rows with weather data (hdd/cdd != null, normDays > 0, not partial) are passed to computeMeterRegression(). OLS fits usage/day vs. DD/day.',
      fields: 'ym, usage, hdd, cdd, normDays, partial',
    },
    'regression:baseline': {
      title: 'Regression → Baseline',
      what: 'The fitted regression coefficients (slope, intercept, r²) are frozen at baseline save time and stored on meter.baseline.reg. During rendering, regressionBaseline(row, reg) is called for each month.',
      fields: 'reg.hdd.slope, reg.hdd.intercept, reg.cdd.slope, reg.cdd.intercept, reg.dual.*',
    },
    'baseline:savings': {
      title: 'Baseline → Savings Calc',
      what: 'For each post-baseline month, the frozen regression predicts a baseline usage. That value minus actual usage is the "savings" in native units.',
      fields: 'regrBaseline (kWh/Therms/Gal per month), baseline.months[], baseline.overrides{}',
    },
    'norm:savings': {
      title: 'Normalization → Savings Calc',
      what: 'Actual usage from the normalized rows is subtracted from the baseline prediction: Savings = Baseline − Actual. Multiplied by the rate from the Savings tab.',
      fields: 'usage (prorated monthly actual), cost (prorated monthly cost)',
    },
    'norm:anomaly': {
      title: 'Normalization → Anomaly Detection',
      what: 'All normalized month rows (including baseline period) are passed to anomaly detection. Residuals = actual − regression baseline. Z-scores identify months that deviate unusually.',
      fields: 'usage, ym, regrBaseline',
    },
    'regression:anomaly': {
      title: 'Regression → Anomaly Detection',
      what: "The regression's predicted baseline for each month is subtracted from actual usage to compute residuals. Standard deviation of residuals sets the z-score threshold.",
      fields: 'regrBaseline (per month) — attached to each norm row by getNormRows()',
    },
    'savings:charts': {
      title: 'Savings → Charts',
      what: 'Monthly savings in dollars are visualized as a bar/waterfall chart in the Meter Performance tab and the Savings view.',
      fields: 'month, baseline$, actual$, savings$',
    },
    'baseline:charts': {
      title: 'Baseline → Charts',
      what: 'The baseline monthly values (regression baseline or overrides) are plotted as a reference line on the Normalized and Baseline charts.',
      fields: 'regrBaseline per month, baseline.months[]',
    },
  };

  const key = edge.from + ':' + edge.to;
  const detail = edgeDetails[key];
  if (!detail) return '<p style="color:var(--text3)">No detail for this connection.</p>';

  return (
    '<div style="margin-bottom:10px">' +
    '<div style="font-weight:700;color:var(--text);margin-bottom:6px">' +
    detail.title +
    '</div>' +
    '<p style="color:var(--text2);font-size:13px;line-height:1.5;margin-bottom:10px">' +
    detail.what +
    '</p>' +
    '</div>' +
    '<div class="pd-code-block">' +
    '<div class="pd-code-label">Fields passed</div>' +
    '<code>' +
    detail.fields +
    '</code>' +
    '</div>'
  );
}

/* ── Stat card helper ── */
function _pdStatCard(label, value, unit) {
  return (
    '<div class="pd-stat">' +
    '<div class="pd-stat-lbl">' +
    label +
    '</div>' +
    '<div class="pd-stat-val">' +
    value +
    (unit ? '<span class="pd-stat-unit"> ' + unit + '</span>' : '') +
    '</div>' +
    '</div>'
  );
}

/* ── Animation ── */
let _pdAnimTimer = null;
let _pdAnimStep = 0;
const _pdAnimFlow = ['bills', 'weather', 'norm', 'regression', 'baseline', 'savings', 'charts'];

function _pdStartAnim(pane) {
  _pdStopAnim();
  _pdAnimStep = 0;
  function step() {
    const id = _pdAnimFlow[_pdAnimStep % _pdAnimFlow.length];
    const nodes = pane.querySelectorAll('.pd-node');
    nodes.forEach((n) => n.classList.remove('pd-node-pulse'));
    const el = pane.querySelector('.pd-node[data-id="' + id + '"]');
    if (el) el.classList.add('pd-node-pulse');
    _pdAnimStep++;
    _pdAnimTimer = setTimeout(step, 700);
  }
  step();
}
function _pdStopAnim() {
  if (_pdAnimTimer) {
    clearTimeout(_pdAnimTimer);
    _pdAnimTimer = null;
  }
}

/* ── Click handlers ── */
function pdSelectNode(nodeId) {
  _pdStopAnim();
  _pdActive = _pdActive === nodeId ? null : nodeId;
  _pdEdgeActive = null;
  const pane = document.getElementById('maPane');
  if (pane) _pdRefreshDetail(pane);
}

function pdSelectEdge(fromId, toId) {
  _pdStopAnim();
  const key = fromId + ':' + toId;
  _pdEdgeActive = _pdEdgeActive === key ? null : key;
  _pdActive = null;
  const pane = document.getElementById('maPane');
  if (pane) _pdRefreshDetail(pane);
}

function _pdRefreshDetail(pane) {
  // Update node highlight styles
  pane.querySelectorAll('.pd-node').forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle('pd-node-active', id === _pdActive);
  });

  // Update edge highlight styles
  pane.querySelectorAll('.pd-edge-btn').forEach((el) => {
    const key = el.dataset.from + ':' + el.dataset.to;
    el.classList.toggle('pd-edge-active', key === _pdEdgeActive);
  });

  // Show/hide detail panel
  const detail = pane.querySelector('#pdDetailPanel');
  if (!detail) return;

  if (!_pdActive && !_pdEdgeActive) {
    detail.style.display = 'none';
    return;
  }

  detail.style.display = 'block';

  // Get m, bills, incl from current meter workspace context
  const b = getUDBldg ? getUDBldg(udSelProjId, udSelBldgId) : null;
  const m = b ? b.meters.find((x) => x.id === udActiveMid) : null;
  const bills = m ? (m.bills || []).slice().sort((a, c) => (a.start || '').localeCompare(c.start || '')) : [];
  const incl = m ? m.inclusive !== false : true;

  let node = null;
  let edgeObj = null;
  let title = '';
  let content = '';

  if (_pdActive) {
    node = PD_NODES.find((n) => n.id === _pdActive);
    title = node ? node.icon + ' ' + node.label : _pdActive;
    content = m ? _pdNodeDetail(_pdActive, m, bills, incl) : '<p style="color:var(--text3)">No meter selected.</p>';
  } else if (_pdEdgeActive) {
    const parts = _pdEdgeActive.split(':');
    edgeObj = PD_EDGES.find((e) => e.from === parts[0] && e.to === parts[1]);
    const fromNode = PD_NODES.find((n) => n.id === parts[0]);
    const toNode = PD_NODES.find((n) => n.id === parts[1]);
    title =
      (fromNode ? fromNode.icon : '') +
      ' ' +
      (fromNode ? fromNode.label : parts[0]) +
      ' → ' +
      (toNode ? toNode.icon : '') +
      ' ' +
      (toNode ? toNode.label : parts[1]);
    content = m
      ? _pdEdgeDetail(edgeObj || { from: parts[0], to: parts[1] }, m, bills, incl)
      : '<p style="color:var(--text3)">No meter selected.</p>';
  }

  detail.querySelector('#pdDetailTitle').textContent = title;
  detail.querySelector('#pdDetailBody').innerHTML = content;
}

/* ── Main render function ── */
function renderPipelinePane(pane, m, bills, incl) {
  _pdActive = null;
  _pdEdgeActive = null;
  _pdStopAnim();

  // ── Build status indicators per node ──
  function _nodeStatus(nodeId) {
    try {
      switch (nodeId) {
        case 'bills':
          return bills.length > 0 ? 'ok' : 'empty';
        case 'weather': {
          const { byYm, zip } = getWeatherForBuilding ? getWeatherForBuilding() : {};
          if (!zip) return 'missing';
          if (!byYm || !Object.keys(byYm).length) return 'empty';
          return 'ok';
        }
        case 'norm': {
          if (!bills.length) return 'empty';
          const { byYm } = getWeatherForBuilding ? getWeatherForBuilding() : {};
          const rows = getNormRows(m, bills, incl, byYm || null);
          return rows.length > 0 ? 'ok' : 'empty';
        }
        case 'regression': {
          if (!m._reg) return 'empty';
          const reg = m._reg;
          if (reg.hdd || reg.cdd || reg.dual) return 'ok';
          return 'empty';
        }
        case 'baseline': {
          const bl = m.baseline;
          if (!bl || !bl.months || bl.months.length < 3) return 'empty';
          return 'ok';
        }
        case 'savings': {
          const bl = m.baseline;
          if (!bl || !bl.months || bl.months.length < 3) return 'empty';
          const { byYm } = getWeatherForBuilding ? getWeatherForBuilding() : {};
          const rows = getNormRows(m, bills, incl, byYm || null);
          const nonBl = rows.filter((r) => !bl.months.includes(r.ym) && r.regrBaseline != null);
          return nonBl.length > 0 ? 'ok' : 'empty';
        }
        case 'anomaly': {
          if (!m._reg) return 'empty';
          const { byYm } = getWeatherForBuilding ? getWeatherForBuilding() : {};
          const rows = getNormRows(m, bills, incl, byYm || null);
          const hasAnomaly = (() => {
            const pts = rows.filter((r) => r.regrBaseline != null);
            if (pts.length < 4) return false;
            const res = pts.map((r) => r.usage - r.regrBaseline);
            const mean = res.reduce((s, v) => s + v, 0) / res.length;
            const std = Math.sqrt(res.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / res.length);
            return std > 0 && res.some((r) => Math.abs((r - mean) / std) >= 2.0);
          })();
          return hasAnomaly ? 'warn' : m._reg ? 'ok' : 'empty';
        }
        case 'charts': {
          if (!bills.length) return 'empty';
          return 'ok';
        }
        default:
          return 'ok';
      }
    } catch (e) {
      return 'error';
    }
  }

  const statusColors = {
    ok: 'var(--green)',
    empty: 'var(--text3)',
    missing: 'var(--red)',
    warn: 'var(--warn)',
    error: 'var(--red)',
  };
  const statusLabels = {
    ok: '●',
    empty: '○',
    missing: '✕',
    warn: '⚠',
    error: '!',
  };

  // ── Grid layout: interleaved columns ──
  // Nodes occupy odd grid columns (1, 3, 5, 7, 9, 11)
  // Connector slots occupy even grid columns (2, 4, 6, 8, 10)
  // Rows: 1 = top node row, 2 = connector row (vertical arrows), 3 = bottom node row
  // This prevents edges from overlapping node cells.
  // Grid cols per node: nodeCol * 2 + 1
  // Grid rows: row 0 nodes → grid-row 1; row 1 nodes → grid-row 3; vertical arrows → grid-row 2

  // ── Build node HTML ──
  function buildNode(n) {
    const status = _nodeStatus(n.id);
    const sc = statusColors[status];
    const gridCol = n.col * 2 + 1;
    const gridRow = n.row === 0 ? 1 : 3;
    return (
      '<div class="pd-node" data-id="' +
      n.id +
      '" onclick="pdSelectNode(\'' +
      n.id +
      '\')" ' +
      'style="grid-column:' +
      gridCol +
      ';grid-row:' +
      gridRow +
      ';--nd-color:' +
      n.color +
      ';--nd-dim:' +
      n.colorDim +
      '">' +
      '<div class="pd-node-status" style="color:' +
      sc +
      '" title="' +
      status +
      '">' +
      statusLabels[status] +
      '</div>' +
      '<div class="pd-node-icon">' +
      n.icon +
      '</div>' +
      '<div class="pd-node-label">' +
      n.label +
      '</div>' +
      '</div>'
    );
  }

  // ── Build edge buttons (connectors between nodes) ──
  // Same-row edges: placed in even grid column between two nodes, spanning same row span
  // Cross-row edges: placed in the vertical connector row (grid-row 2) at the node's column
  function buildEdges() {
    return PD_EDGES.map((e) => {
      const fromNode = PD_NODES.find((n) => n.id === e.from);
      const toNode = PD_NODES.find((n) => n.id === e.to);
      if (!fromNode || !toNode) return '';

      const sameRow = fromNode.row === toNode.row;
      const rightward = toNode.col > fromNode.col;
      const downward = toNode.row > fromNode.row;

      let style = '';
      if (sameRow) {
        // Place in the even connector column between the two node columns
        // If nodes are adjacent (col diff = 1), connector col = fromNode.col*2 + 2
        // If nodes span multiple columns (like norm→savings skipping baseline),
        // center in the middle even column
        const fromGridCol = fromNode.col * 2 + 1;
        const toGridCol = toNode.col * 2 + 1;
        const connCol = Math.round((fromGridCol + toGridCol) / 2); // always an even number
        const gridRow = fromNode.row === 0 ? 1 : 3;
        style = 'grid-column:' + connCol + ';grid-row:' + gridRow + ';align-self:center;justify-self:center;';
      } else {
        // Vertical connector: place in grid-row 2 (middle row) at the source node's grid column
        const gridCol = fromNode.col * 2 + 1;
        style = 'grid-column:' + gridCol + ';grid-row:2;align-self:center;justify-self:center;';
      }

      const arrow = sameRow ? (rightward ? '→' : '←') : downward ? '↓' : '↑';
      const label = e.label;

      return (
        '<button class="pd-edge-btn" data-from="' +
        e.from +
        '" data-to="' +
        e.to +
        '" ' +
        'onclick="pdSelectEdge(\'' +
        e.from +
        "','" +
        e.to +
        '\')" ' +
        'style="' +
        style +
        '" title="' +
        label +
        '">' +
        '<span class="pd-edge-arrow">' +
        arrow +
        '</span>' +
        '<span class="pd-edge-label">' +
        label +
        '</span>' +
        '</button>'
      );
    }).join('');
  }

  const nodesHTML = PD_NODES.map(buildNode).join('');
  const edgesHTML = buildEdges();

  pane.innerHTML =
    // Header bar
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">' +
    '<div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--text)">Computation Pipeline</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:2px">How data flows from bills to savings for <strong style="color:var(--text2)">' +
    (m.name || m.commodity + ' meter') +
    '</strong></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn btn-ghost btn-sm" onclick="_pdStartAnim(document.getElementById(\'maPane\'))" title="Animate data flow">▶ Animate</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="_pdStopAnim();document.querySelectorAll(\'.pd-node-pulse\').forEach(n=>n.classList.remove(\'pd-node-pulse\'))" title="Stop animation">■ Stop</button>' +
    '</div>' +
    '</div>' +
    // Diagram grid
    '<div class="pd-diagram">' +
    nodesHTML +
    edgesHTML +
    '</div>' +
    // Legend
    '<div class="pd-legend">' +
    '<span class="pd-legend-item"><span style="color:var(--green)">●</span> Ready</span>' +
    '<span class="pd-legend-item"><span style="color:var(--text3)">○</span> Needs data</span>' +
    '<span class="pd-legend-item"><span style="color:var(--warn)">⚠</span> Alert</span>' +
    '<span class="pd-legend-item"><span style="color:var(--red)">✕</span> Missing</span>' +
    '<span class="pd-legend-item" style="margin-left:auto;color:var(--text3)">Click any node or arrow for details</span>' +
    '</div>' +
    // Detail panel (hidden until selection)
    '<div id="pdDetailPanel" style="display:none;margin-top:14px;border:1px solid var(--border);border-radius:10px;background:var(--s1);overflow:hidden">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)">' +
    '<div id="pdDetailTitle" style="font-weight:700;font-size:14px;color:var(--text)"></div>' +
    '<button class="btn btn-ghost btn-sm" onclick="_pdActive=null;_pdEdgeActive=null;_pdRefreshDetail(document.getElementById(\'maPane\'))">✕</button>' +
    '</div>' +
    '<div id="pdDetailBody" style="padding:16px"></div>' +
    '</div>';
}
