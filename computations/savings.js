// computations/savings.js — Unified savings computation (canonical source)
// Depends on: normalization.js (getNormRows, buildMoMap, normMonth), regression.js (computeKwCddRegression),
//             rates.js (getStoredRate), and getWeatherForBuilding() (still in energy-department.html)

/* ─────────────────────────────────────────────────────────────
   getMeterSavings(m, bills, incl)
   Unified savings function — single pass, populates both byYM
   and byCalMo, applies costSavOverrides to BOTH formats.

   Returns:
   {
     byYM:         {YYYY-MM: totalCostSav},
     byCalMo:      {0-11: totalCostSav},
     unitsByYM:    {YYYY-MM: {kwh, kw, therms, gallons}},
     unitsByCalMo: {0-11: {kwh, kw, therms, gallons}}
   }
───────────────────────────────────────────────────────────── */
function getMeterSavings(m, bills, incl) {
  const empty = { byYM: {}, byCalMo: {}, unitsByYM: {}, unitsByCalMo: {} };
  const bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return empty;

  // Cache: return stored result if bills haven't changed
  const cacheKey = bills.length + '_' + (bills[0]?.start || '') + '_' + (bills[bills.length - 1]?.end || '');
  if (m._savingsCache && m._savingsCacheKey === cacheKey) return m._savingsCache;

  const byYM = {};
  const byCalMo = {};
  const unitsByYM = {};
  const unitsByCalMo = {};

  const isElec = m.commodity === 'Electric';
  const isPropane = m.commodity === 'Propane';
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const allRows = bills.length ? getNormRows(m, bills, incl, weatherByYm) : [];
  const blRows = allRows.filter((r) => bl.months.includes(r.ym));
  const blEnd = bl.months.slice().sort().pop();
  const postRows = allRows.filter((r) => r.ym > blEnd);
  if (!postRows.length) {
    const result = empty;
    m._savingsCache = result;
    m._savingsCacheKey = cacheKey;
    return result;
  }

  const { elecByMo: eMo, gasByMo: gMo, propaneByMo: pMo } = buildMoMap(m, blRows, bills, incl);
  const _moMap = isElec ? eMo : m.commodity === 'Gas' ? gMo : isPropane ? pMo : {};
  const blByCalMo = {};
  const blDemKWByCalMo = {};
  Object.entries(_moMap).forEach(([mo, v]) => {
    blByCalMo[mo] = isElec ? v.kwh : m.commodity === 'Gas' ? v.therms : isPropane ? v.gallons : v.kgal;
    if (isElec) blDemKWByCalMo[mo] = v.billedKW || v.demandKW || 0;
  });
  const hasBlCalMap = Object.keys(blByCalMo).length > 0;
  const hasRegrP = allRows.some((r) => r.regrBaseline != null);
  const blAvg = blRows.length ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length : 0;

  // kW weather normalization via CDD regression (matches renderPerfPane)
  const _kwNormByYm = {};
  if (isElec && hasRegrP) {
    const pts = blRows
      .map((r) => {
        const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
        const kw = bfr.length ? bfr.reduce((s, b) => s + (parseFloat(b.demandKW) || 0), 0) / bfr.length : 0;
        return { x: r.cdd != null ? r.cdd : 0, y: kw };
      })
      .filter((p) => p.y > 0);
    if (pts.length >= 3) {
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p.x, 0) / n;
      const my = pts.reduce((s, p) => s + p.y, 0) / n;
      const ssxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
      const ssxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
      if (ssxx > 0) {
        const slope = ssxy / ssxx;
        const intercept = my - slope * mx;
        allRows.forEach((r) => {
          const cdd = r.cdd != null ? r.cdd : 0;
          _kwNormByYm[r.ym] = Math.max(0, intercept + slope * cdd);
        });
      }
    }
  }

  const rawUsageByYm = {};
  if (!isElec) {
    if (isPropane) {
      allRows.forEach((r) => {
        rawUsageByYm[r.ym] = r.usage;
      });
    } else {
      bills.forEach((b) => {
        const ym = normMonth(b.start, b.end, incl, bills);
        if (!ym) return;
        rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + parseFloat(b.therms || b.usage || 0);
      });
    }
  }
  if (isElec) {
    bills.forEach((b) => {
      const ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + (parseFloat(b.kwh) || parseFloat(b.usage) || 0);
    });
  }

  postRows.forEach((r) => {
    const calMo = parseInt(r.ym.split('-')[1]) - 1;
    const bfr = isPropane ? [] : bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
    if (!isPropane && !bfr.length) return;

    let totalCostSav = 0;
    let unitSav = { kwh: 0, kw: 0, therms: 0, gallons: 0 };

    const expUsage =
      hasBlCalMap && blByCalMo[calMo] != null
        ? blByCalMo[calMo]
        : hasRegrP && r.regrBaseline != null
          ? r.regrBaseline
          : blAvg;
    const actUsage = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;

    if (isElec) {
      const actKwh = actUsage;
      const n = bfr.length || 1;
      const _sKwhRate = bfr.reduce((s, b) => s + (parseFloat(b.totalKwhRate) || 0), 0) / n;
      const _sKwRate = bfr.reduce((s, b) => s + (parseFloat(b.totalKwRate) || 0), 0) / n;
      const kwhCostAmt = bfr.reduce((s, b) => s + parseFloat(b.kwhCost || 0), 0);
      const kwhRate = _sKwhRate || (actKwh > 0 && kwhCostAmt > 0 ? kwhCostAmt / actKwh : 0);
      const kwhSaved = expUsage - actKwh;
      const kwhCostSav = kwhRate > 0 ? kwhSaved * kwhRate : 0;
      const blExpKW = _kwNormByYm[r.ym] != null ? _kwNormByYm[r.ym] : blDemKWByCalMo[calMo] || 0;
      const actBilKW = bfr.length ? Math.max(...bfr.map((b) => parseFloat(b.billedKW || b.demandKW || 0))) : 0;
      const actDemKW = bfr.length ? Math.max(...bfr.map((b) => parseFloat(b.demandKW || 0))) : 0;
      const kwCostAmt = bfr.reduce((s, b) => s + parseFloat(b.kwCost || 0), 0);
      const facKWCostAmt = bfr.reduce((s, b) => s + parseFloat(b.facKWCost || 0), 0);
      const moKwRate = _sKwRate || (actDemKW > 0 ? (kwCostAmt + facKWCostAmt) / actDemKW : 0);
      const kwSaved = blExpKW - actBilKW;
      const kwCostSav = blExpKW > 0 && moKwRate > 0 ? kwSaved * moKwRate : 0;
      totalCostSav = kwhCostSav + kwCostSav;
      unitSav.kwh = kwhSaved;
      unitSav.kw = kwSaved;
    } else if (isPropane) {
      const actGallons = actUsage;
      const actCost = r.cost;
      const _sPropRate = bfr.length ? parseFloat(bfr[0].totalPropaneRate) || 0 : 0;
      const galRate = _sPropRate || (actGallons > 0 && actCost > 0 ? actCost / actGallons : 0);
      totalCostSav = galRate > 0 ? (expUsage - actGallons) * galRate : 0;
      unitSav.gallons = expUsage - actGallons;
    } else {
      const actTherms = actUsage;
      const actThermCost = bfr.reduce(
        (s, b) => s + (parseFloat(b.gasCharge) || parseFloat(b.thermCost) || parseFloat(b.cost) || 0),
        0,
      );
      const _sGasRate = bfr.length ? bfr.reduce((s, b) => s + (parseFloat(b.totalGasRate) || 0), 0) / bfr.length : 0;
      const thermRate = _sGasRate || (actTherms > 0 && actThermCost > 0 ? actThermCost / actTherms : 0);
      totalCostSav = thermRate > 0 ? (expUsage - actTherms) * thermRate : 0;
      unitSav.therms = expUsage - actTherms;
    }

    // Apply costSavOverrides if present (per year-month)
    const _costOvr = m.baseline?.costSavOverrides?.[r.ym];
    const finalCostSav = _costOvr != null ? _costOvr : totalCostSav;

    // Populate byYM
    byYM[r.ym] = (byYM[r.ym] || 0) + finalCostSav;

    // Populate byCalMo (same override applied — THIS IS THE BUG FIX)
    byCalMo[calMo] = (byCalMo[calMo] || 0) + finalCostSav;

    // Populate unit savings
    if (!unitsByYM[r.ym]) unitsByYM[r.ym] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
    unitsByYM[r.ym].kwh += unitSav.kwh;
    unitsByYM[r.ym].kw += unitSav.kw;
    unitsByYM[r.ym].therms += unitSav.therms;
    unitsByYM[r.ym].gallons += unitSav.gallons;

    if (!unitsByCalMo[calMo]) unitsByCalMo[calMo] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
    unitsByCalMo[calMo].kwh += unitSav.kwh;
    unitsByCalMo[calMo].kw += unitSav.kw;
    unitsByCalMo[calMo].therms += unitSav.therms;
    unitsByCalMo[calMo].gallons += unitSav.gallons;
  });

  // Also set legacy m._unitSavByCalMo for any remaining references
  m._unitSavByCalMo = unitsByCalMo;

  const result = { byYM, byCalMo, unitsByYM, unitsByCalMo };
  m._savingsCache = result;
  m._savingsCacheKey = cacheKey;
  // Legacy: also set m._savingsByYM for any direct references
  m._savingsByYM = byYM;
  return result;
}

/* ─────────────────────────────────────────────────────────────
   getBuildingSavingsByYM(bldg, projId)
   Rollup: sum meter savings for a building (by year-month)
───────────────────────────────────────────────────────────── */
function getBuildingSavingsByYM(bldg, projId) {
  const proj = getUDProj(projId);
  if (!proj || !bldg || !bldg.meters) return {};
  const incl = proj.inclMonths || {};
  const result = {};
  bldg.meters.forEach((m) => {
    const bills = (m.bills || []).slice().sort((a, c) => (a.start || '').localeCompare(c.start || ''));
    const mSav = getMeterSavings(m, bills, incl).byYM;
    Object.entries(mSav).forEach(([ym, v]) => {
      result[ym] = (result[ym] || 0) + v;
    });
  });
  return result;
}

/* ─────────────────────────────────────────────────────────────
   getProjectSavingsByYM(projId)
   Rollup: sum building savings for a project (by year-month)
───────────────────────────────────────────────────────────── */
function getProjectSavingsByYM(projId) {
  const proj = getUDProj(projId);
  if (!proj || !proj.buildings) return {};
  const result = {};
  proj.buildings.forEach((b) => {
    const bSav = getBuildingSavingsByYM(b, projId);
    Object.entries(bSav).forEach(([ym, v]) => {
      result[ym] = (result[ym] || 0) + v;
    });
  });
  return result;
}

/* ─────────────────────────────────────────────────────────────
   getBldgMeasureSavingsByMo(projId, bldgId)
   Computes measure-based projected savings per calendar month.
   Returns Array(12) of monthly dollar savings, or null if no measures.
───────────────────────────────────────────────────────────── */
function getBldgMeasureSavingsByMo(projId, bldgId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.savingsData) return null;
  const measures = (p.savingsData.measures || []).filter((m) => m.bldgId === bldgId && m.selected !== false);
  if (!measures.length) return null;
  const monthlySavings = Array(12).fill(0);
  measures.forEach((m) => {
    const r = m.rates || (p.savingsData.blRates || {})[bldgId] || {};
    for (let mo = 0; mo < 12; mo++) {
      const s = SUMMER_MOS.includes(mo);
      monthlySavings[mo] += ((m.kwh || [])[mo] || 0) * (s ? r.kwhSummer || 0 : r.kwhWinter || 0);
      monthlySavings[mo] += ((m.kw || [])[mo] || 0) * (s ? r.kwSummer || 0 : r.kwWinter || 0);
      monthlySavings[mo] += ((m.gas || [])[mo] || 0) * (r.thermRate || 0);
      monthlySavings[mo] += ((m.propane || [])[mo] || 0) * (r.gallonRate || 0);
    }
  });
  return monthlySavings;
}
