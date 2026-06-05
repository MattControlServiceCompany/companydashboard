// data-quality.js — per-meter data quality scoring
// Returns a 0-100 score across 5 components.

/**
 * computeMeterQualityScore(m)
 * @param {object} m — meter object with .bills, .baseline, ._flags
 * @returns {{ score: number, components: { dataMonths, baselineR2, gaps, fieldCompleteness, flags } }}
 *   Each component: { points: number, max: number, detail: string }
 */
function computeMeterQualityScore(m) {
  var bills = Array.isArray(m.bills) ? m.bills : [];

  // ── 1. dataMonths (max 25) ──
  var ymSet = {};
  bills.forEach(function (b) {
    if (b.start) {
      var ym = String(b.start).slice(0, 7); // "YYYY-MM"
      ymSet[ym] = true;
    }
  });
  var uniqueMonths = Object.keys(ymSet).length;
  var dataMonthsPts = uniqueMonths >= 24 ? 25 : Math.min(25, Math.round((uniqueMonths / 24) * 25));
  var dataMonths = {
    points: dataMonthsPts,
    max: 25,
    detail: uniqueMonths + ' mo. history',
  };

  // ── 2. baselineR2 (max 25) ──
  // Use the same fallback chain as report-engine.js: prefer frozen baseline reg,
  // fall back to live runtime reg (m._reg, set by getNormRows in normalization.js).
  // m.baseline.reg is null for inherited baselines and for baselines saved before
  // weather data was uploaded — in both cases m._reg has the real regression.
  var r2Val = null;
  var _blReg = (m.baseline && m.baseline.reg) || null;
  var _liveReg = m._reg || null;
  var reg = _blReg || _liveReg || null;
  if (reg) {
    if (reg.dual && reg.dual.r2 != null) {
      r2Val = reg.dual.r2;
    } else if (reg.hdd && reg.hdd.r2 != null) {
      r2Val = reg.hdd.r2;
    } else if (reg.cdd && reg.cdd.r2 != null) {
      r2Val = reg.cdd.r2;
    }
  }
  var r2Pts = 0;
  var r2Detail = 'no baseline';
  if (r2Val != null) {
    r2Pts = r2Val >= 0.9 ? 25 : Math.round(r2Val * 25);
    r2Detail = 'R² ' + r2Val.toFixed(3);
  }
  var baselineR2 = {
    points: r2Pts,
    max: 25,
    detail: r2Detail,
  };

  // ── 3. gaps (max 15) ──
  var sortedByStart = bills.slice().sort(function (a, b) {
    return (a.start || '') < (b.start || '') ? -1 : 1;
  });
  var gapCount = 0;
  for (var i = 1; i < sortedByStart.length; i++) {
    var prevEnd = sortedByStart[i - 1].end;
    var curStart = sortedByStart[i].start;
    if (prevEnd && curStart) {
      var prevDate = new Date(prevEnd + 'T00:00:00');
      var curDate = new Date(curStart + 'T00:00:00');
      var diffDays = (curDate - prevDate) / 86400000;
      if (diffDays > 45) gapCount++;
    }
  }
  var gapsPts = Math.max(0, 15 - gapCount * 3);
  var gaps = {
    points: gapsPts,
    max: 15,
    detail: gapCount + ' gap' + (gapCount !== 1 ? 's' : ''),
  };

  // ── 4. fieldCompleteness (max 20) ──
  // Check the last 3 bills for key fields
  var last3 = bills.slice(-3);
  var missingCount = 0;
  last3.forEach(function (b) {
    if (!b.start) missingCount++;
    if (!b.end) missingCount++;
    if (b.totalCost == null || b.totalCost === '') missingCount++;
    // Primary usage field by commodity
    var hasPrimary = b.kwh != null || b.therms != null || b.gallons != null || b.kgal != null || b.usage != null;
    if (!hasPrimary) missingCount++;
  });
  var fieldPts = Math.max(0, 20 - missingCount * 2);
  var fieldCompleteness = {
    points: fieldPts,
    max: 20,
    detail: missingCount + ' missing field' + (missingCount !== 1 ? 's' : ''),
  };

  // ── 5. flags (max 15) ──
  var totalFlags = bills.reduce(function (sum, bill) {
    if (!Array.isArray(bill._flags)) return sum;
    return (
      sum +
      bill._flags.filter(function (f) {
        return !f.dismissed;
      }).length
    );
  }, 0);
  var flagsPts = Math.max(0, 15 - totalFlags * 2);
  var flags = {
    points: flagsPts,
    max: 15,
    detail: totalFlags + ' flag' + (totalFlags !== 1 ? 's' : ''),
  };

  var score = dataMonthsPts + r2Pts + gapsPts + fieldPts + flagsPts;

  return {
    score: score,
    components: {
      dataMonths: dataMonths,
      baselineR2: baselineR2,
      gaps: gaps,
      fieldCompleteness: fieldCompleteness,
      flags: flags,
    },
  };
}

/**
 * getMeterQualityBadge(score)
 * @param {number} score — 0-100
 * @returns {{ textColor: string, bgColor: string, label: string }}
 */
function getMeterQualityBadge(score) {
  if (score >= 90) {
    return { textColor: '#22c55e', bgColor: 'rgba(34,197,94,.15)', label: 'A' };
  } else if (score >= 75) {
    return { textColor: '#4ade80', bgColor: 'rgba(34,197,94,.15)', label: 'B' };
  } else if (score >= 60) {
    return { textColor: 'var(--amber,#f59e0b)', bgColor: 'rgba(245,158,11,.12)', label: 'C' };
  } else if (score >= 40) {
    return { textColor: 'var(--amber,#f59e0b)', bgColor: 'rgba(245,158,11,.12)', label: 'D' };
  } else {
    return { textColor: 'var(--danger,#ef4444)', bgColor: 'rgba(239,68,68,.15)', label: 'F' };
  }
}

/**
 * qualityBreakdownTooltip(q)
 * @param {{ score: number, components: object }} q — result of computeMeterQualityScore
 * @returns {string}
 */
function qualityBreakdownTooltip(q) {
  var c = q.components;
  return (
    'History ' +
    c.dataMonths.points +
    '/' +
    c.dataMonths.max +
    ' · R² ' +
    c.baselineR2.points +
    '/' +
    c.baselineR2.max +
    ' · Gaps ' +
    c.gaps.points +
    '/' +
    c.gaps.max +
    ' · Fields ' +
    c.fieldCompleteness.points +
    '/' +
    c.fieldCompleteness.max +
    ' · Flags ' +
    c.flags.points +
    '/' +
    c.flags.max
  );
}
