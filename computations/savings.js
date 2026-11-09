// computations/savings.js — Unified savings computation (canonical source)
// Depends on: normalization.js (getNormRows, buildMoMap, billMonth), regression.js (computeKwCddRegression),
//             rates.js (getStoredRate, getStoredKwRate), and getWeatherForBuilding() (still in energy-department.html)

// SAVINGS_CALC_VERSION — bump this any time the savings math in this file changes.
// It is folded into the _savingsCache fingerprint (_blFp) below so a code deploy
// invalidates every browser's stale in-memory cache instead of requiring a manual
// clear or an unrelated data edit to bust it. CH_VERSION (site-ui.js) is not
// reachable here (scoped inside an IIFE, not exposed on window), so this file
// carries its own version marker.
const SAVINGS_CALC_VERSION = '2026.11.03.contract1';

/* ─────────────────────────────────────────────────────────────
   Expected (baseline) usage for a meter-month - THE one rule: the CONTRACT method.
   kWh, therms, gallons: the baseline-year model value for that calendar month, at the baseline year's weather
   (else the regression, else the baseline average). kW: the kW-vs-CDD fit at the reporting month's CDD
   (computations/regression.js). The reporting month's weather decides only kW. A month whose CDD is missing,
   for a meter with a kW fit, has no kW baseline: it is flagged weatherMissing and left out of the savings until
   weather exists - never read as 0 degree days.
   Callers: getMeterSavings (below) and, through its rows, every report and page.
───────────────────────────────────────────────────────────── */

// baselineUsageByCalMo(m, moMaps) - baseline-year usage by calendar month (0-11) from the buildMoMap
// result {elecByMo, gasByMo, propaneByMo, waterByMo}. The one reader of those maps for usage.
function baselineUsageByCalMo(m, moMaps) {
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';
  const isPropane = m.commodity === 'Propane';
  const map = isElec ? moMaps.elecByMo : isGas ? moMaps.gasByMo : isPropane ? moMaps.propaneByMo : moMaps.waterByMo;
  const out = {};
  Object.entries(map).forEach(([mo, v]) => {
    out[mo] = isElec ? v.kwhPredicted : isGas ? v.thermsPredicted : isPropane ? v.gallons : v.kgal;
  });
  return out;
}

// expectedUsageForMonth(row, ctx) -> { usage, weatherMissing }
//   row: a getNormRows row ({ym, regrBaseline, hdd, cdd}); regrBaseline is the baseline regression at the
//        row's own weather, null when the month has no weather.
//   ctx: { blByCalMo, blAvg, kwWeatherNeeded }  (blByCalMo from baselineUsageByCalMo; kwWeatherNeeded = an
//        Electric meter with a kW-vs-CDD fit, so the month's CDD must exist)
function expectedUsageForMonth(row, ctx) {
  if (ctx.kwWeatherNeeded && (row.cdd == null || !isFinite(row.cdd))) return { usage: null, weatherMissing: true };
  const calMo = parseInt(row.ym.split('-')[1]) - 1;
  const hasBlCalMap = Object.keys(ctx.blByCalMo).length > 0;
  const usage =
    hasBlCalMap && ctx.blByCalMo[calMo] != null
      ? ctx.blByCalMo[calMo]
      : row.regrBaseline != null
        ? row.regrBaseline
        : ctx.blAvg;
  return { usage, weatherMissing: false };
}

// normalizedBillsAtBaselineWeather(postRows, blRows, commodity, normBasis) -> { usageByYm }
// COMPARISON ONLY (opts.normalizedBills of getMeterSavings; the billed contract method never calls it).
// The post-baseline bills (postRows = getNormRows rows, each scaled to its calendar month: usage x normDays / days) are fitted with
// computeMeterRegression, and that fit is evaluated with regressionBaseline at the BASELINE weather of each
// month's calendar month (the mean of blRows' HDD/CDD for that month; the baseline stays where it is). The result is
// the "normalized bill" of the month. kW is not normalized: the kW term is the contract's, identical in both methods.
// A month or a meter with no fit has no entry: the caller keeps the real bill.
function normalizedBillsAtBaselineWeather(postRows, blRows, commodity, normBasis) {
  const usageByYm = {};
  // Each row is scaled from its billing days to the calendar month's days (usage x normDays / days).
  const scaled = postRows.map((r) => (r.days > 0 && r.normDays > 0 ? Object.assign({}, r, { usage: (r.usage * r.normDays) / r.days }) : r));
  const reg = computeMeterRegression(scaled);
  const blWx = (ym) => {
    const mm = ym.slice(5, 7);
    const v = blRows.filter((b) => b.ym.slice(5, 7) === mm && b.hdd != null && b.cdd != null);
    if (!v.length) return null;
    return { hdd: v.reduce((a, b) => a + b.hdd, 0) / v.length, cdd: v.reduce((a, b) => a + b.cdd, 0) / v.length };
  };
  postRows.forEach((r) => {
    const w = blWx(r.ym);
    if (!w) return;
    const u = regressionBaseline({ ym: r.ym, days: r.days, hdd: w.hdd, cdd: w.cdd }, reg, commodity, normBasis);
    if (u != null) usageByYm[r.ym] = u;
  });
  return { usageByYm };
}

/* ─────────────────────────────────────────────────────────────
   projHasContract(projId)
   Single source of truth: does this project have a contract?
   Contract type set and not 'none' (getProjectContract); the
   Service Agreement # plays no part. No contract means no savings/compensation
   dollars should ever be shown for the project, anywhere in the
   app. Every savings-% fallback gate (perf-table, bpRecalc,
   bspRecalc, graphics-setpoints, etc.) must route through this
   instead of re-implementing the projects.find lookup.
───────────────────────────────────────────────────────────── */
function projHasContract(projId) {
  const p = (typeof projects !== 'undefined' ? projects : []).find((x) => String(x.id) === String(projId));
  return !!p && getProjectContract(p).hasContract; // keeper: computations/csc.js
}

/* ─────────────────────────────────────────────────────────────
   resolveGasUsageTherms(b)
   Canonical b.therms is only populated by saveBillRow()'s manual-
   edit sync — CSV import never wrote it — so CSV-imported gas
   bills computed usage as 0 here. Mirrors the fallback chain
   report-engine-woodland.js already uses (naturalGasTherms, then
   naturalGasMMbtu×10; 1 MMBtu = 10 Therms) so every gas usage
   read in this file sees real therms regardless of import path.

   WP-02 (2026-09-30): THE one gas unit resolver. Every save path, CSV
   import, rate reader and display reads gas usage through it. Order:
   therms, then CCF, then MMBtu, then generic usage.
     - CCF x the factor the bill printed (thermFactor / ThermFactor);
       no printed factor -> UNIT_TO_BASE.CCF.factor (app/utility-data.js,
       the one constant). A printed factor outside 1.0-1.2 (exclusive) is not a therm
       factor is ignored. This is a plausibility guard (typical natural-gas
       factors are 1.02-1.06), not a value taken from a bill.
     - MMBtu x the MMBtu->Therms factor in UNIT_TO_BASE_BY_COMMODITY
       (1 MMBtu = 10 Therms).
   - Mcf x 10 via UNIT_TO_BASE.DTh (naturalGasMCF, CSV import only): the same
     1 Mcf = 1 Dth = 10 therms the KGS extractor uses. UNIT_TO_BASE.MCF (10.37)
     is not used here; which Mcf factor is right is a decision for Matt.
   Accepts saved-bill names (naturalGasCCF) and extractor names
   (NaturalGasCCF). Converted values are rounded to 6 decimals, which
   removes float noise and changes no printed figure.
───────────────────────────────────────────────────────────── */
function resolveGasUsageThermsOrNull(b) {
  // null = no gas usage source on the bill at all (missing). 0 = a source says 0 and no source says more.
  // The first source with a non-zero value wins (same numbers as before); this only adds "was it blank?".
  const num = (k) => {
    const lo = parseBillNumber(b[k]);
    if (lo) return lo;
    const up = parseBillNumber(b[k.charAt(0).toUpperCase() + k.slice(1)]);
    return up || (lo === null ? up : lo);
  };
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  const sources = [
    () => num('therms'),
    () => num('naturalGasTherms'),
    () => {
      const ccf = num('naturalGasCCF');
      if (!ccf) return ccf;
      const printed = num('thermFactor');
      const factor = printed > 1 && printed < 1.2 ? printed : UNIT_TO_BASE.CCF.factor;
      return round6(ccf * factor);
    },
    () => {
      const mcf = num('naturalGasMCF');
      return mcf ? round6(convertUnit(mcf, 'DTh', 'Therms', 'Gas')) : mcf;
    },
    () => {
      const mmbtu = num('naturalGasMMbtu');
      return mmbtu ? round6(convertUnit(mmbtu, 'MMBtu', 'Therms', 'Gas')) : mmbtu;
    },
    () => num('usage'),
  ];
  let sawValue = false;
  for (const read of sources) {
    const v = read();
    if (v) return v;
    if (v !== null) sawValue = true;
  }
  return sawValue ? 0 : null;
}
function resolveGasUsageTherms(b) {
  const v = resolveGasUsageThermsOrNull(b);
  return v === null ? 0 : v;
}

/* getBillUsageOrNull(bill, commodity): the one "usage of this bill, or null when blank" reader for the
   bill-flag rules. null = missing, 0 = a real zero. Stormwater has no usage (flat charge). */
function getBillUsageOrNull(bill, commodity) {
  const first = (...vals) => {
    for (const v of vals) {
      const n = parseBillNumber(v);
      if (n !== null) return n;
    }
    return null;
  };
  if (commodity === 'Electric') return parseBillNumber(bill.kwh);
  if (commodity === 'Gas') return resolveGasUsageThermsOrNull(bill);
  if (commodity === 'Water') return first(bill.waterUsage, bill.WaterUsage);
  if (commodity === 'Sewer') return first(bill.sewerUsage, bill.SewerUsage, bill.waterUsage);
  if (commodity === 'Propane') return first(bill.gallonsDelivered, bill.kwh);
  return null;
}

/* gasBillSaveTherms(src) - the ONE mapping of gas usage for a bill being saved: the stored
   `therms` ('' when missing, a real 0 stays 0). src = extractor bill (NaturalGasTherms ...) or
   saved-style bill. The gas charge is NOT copied any more: the stored copy `thermCost` is gone
   (2026-10-05 duplicate-bill-fields audit step 3); every reader calls getBillGasCost
   (computations/rates.js), which reads the visible `gasCharge`. */
function gasBillSaveTherms(src) {
  const usage = resolveGasUsageThermsOrNull(src);
  return usage === null ? '' : usage;
}

/* ─────────────────────────────────────────────────────────────
   checkRateIncomplete(opts)
   a67db8ce (2026-09-09) — single source of truth for "is this row's rate
   incomplete" per commodity component. Previously reimplemented independently
   in getMeterSavings() and lib/perf-table.js's
   buildMeterPerfTableHTML(). Since WP-04 the perf table renders getMeterSavings
   rows, so getMeterSavings is the only caller. It resolves its own
   rate/usage/cost values first — this function only decides whether that
   already-resolved state counts as "rate incomplete," not the $ math itself.

   opts (each sub-object optional — omit a component the caller doesn't have):
     kwh:  { enabled, rate, actUsage }   — electric $/kWh component
     kw:   { enabled, rate, actual }     — electric $/kW component
     unit: { enabled, rate, actUsage, actCost, reason } — gas/propane $/unit
           component; `reason` is the caller-supplied message string, since
           it differs by commodity ('propane $/gallon rate unavailable' /
           'gas $/therm rate unavailable').

   Returns { incomplete: bool, reason: string }.
───────────────────────────────────────────────────────────── */
function checkRateIncomplete(opts) {
  opts = opts || {};
  var incomplete = false;
  var reason = '';

  var kwh = opts.kwh;
  if (kwh && kwh.enabled && !(kwh.rate > 0) && kwh.actUsage > 0) {
    incomplete = true;
    reason = 'electric $/kWh rate unavailable';
  }

  var kw = opts.kw;
  if (kw && kw.enabled && kw.actual > 0 && !(kw.rate > 0)) {
    incomplete = true;
    reason = reason ? reason + '; $/kW rate unavailable' : 'electric $/kW rate unavailable';
  }

  var unit = opts.unit;
  if (unit && unit.enabled && !(unit.rate > 0) && (unit.actUsage > 0 || unit.actCost > 0)) {
    incomplete = true;
    reason = unit.reason;
  }

  return { incomplete: incomplete, reason: reason };
}

/* freezeContractBaseline(m, bills, incl, weatherByYm) - the contract baseline is written ONCE per meter (when none is
   stored for the current baseline months), from the values of that moment, and only read after that
   (getContractFrozenBaseline + buildMoMap, computations/normalization.js). Same pattern as the presented
   quarters: the stored record wins over any later bill edit. Callers: getMeterSavings (contracted project)
   and freezeContractBaselines. Returns true when it wrote. */
function freezeContractBaseline(m, bills, incl, weatherByYm) {
  if (getContractFrozenBaseline(m)) return false;
  const months = m.baseline.months;
  const rowsOf = (wx) => getNormRows(m, bills, incl, wx).filter((r) => months.includes(r.ym));
  const plain = rowsOf(null);
  if (!plain.length) return false;
  const wxRows = weatherByYm ? rowsOf(weatherByYm) : plain;
  m.baseline.contractFrozen = {
    months: months.slice(),
    blAvg: wxRows.reduce((s, r) => s + r.usage, 0) / wxRows.length,
    moMap: JSON.parse(JSON.stringify(buildMoMap(m, plain, bills, incl, true))),
    moMapWx: JSON.parse(JSON.stringify(buildMoMap(m, wxRows, bills, incl, true))),
    frozenAt: new Date().toISOString(),
  };
  return true;
}

// freezeContractBaselines() - store the baseline of every meter of every contracted project that has none.
// Runs at load (loadUtilityData, which then saves). Returns the number of meters it froze.
function freezeContractBaselines() {
  let n = 0;
  (typeof projects !== 'undefined' ? projects : []).forEach((p) => {
    if (!projHasContract(p.id)) return;
    getUDBldgs(p.id).forEach((b) =>
      (b.meters || []).forEach((m) => {
        if (!m.baseline || !m.baseline.months || m.baseline.months.length < 3 || getContractFrozenBaseline(m)) return;
        const bills = (m.bills || []).slice().sort((x, y) => String(x.start).localeCompare(String(y.start)));
        getMeterSavings(m, bills, m.inclusive !== false, p.id, b.id);
        if (getContractFrozenBaseline(m)) n++;
      }),
    );
  });
  return n;
}

/* ─────────────────────────────────────────────────────────────
   getMeterSavings(m, bills, incl, projId, bldgId, opts)
   THE savings function. Every dollar of "savings" on every page and report comes from this
   one function: the dashboards, the reports, the portal, AND the Meter Performance table
   (lib/perf-table.js renders the `rows` returned here and does no money math of its own).

   Returns:
   {
     byYM:         {YYYY-MM: totalCostSav},
     byCalMo:      {0-11: totalCostSav},
     unitsByYM:    {YYYY-MM: {kwh, kw, therms, gallons}},
     unitsByCalMo: {0-11: {kwh, kw, therms, gallons}},
     incompleteYM: {YYYY-MM: {commodity, reason, weather?}} (weather:true = month waits for weather; pages show "Waiting for weather data", not the rate warning),
     rows:         [one detail row per post-baseline month, oldest first - see `rowsOut` below]
   }
   A project with no Service Agreement gets `rows` with every dollar set to 0 and empty
   byYM/byCalMo/unitsByYM/unitsByCalMo/incompleteYM (usage columns still show).

   opts.effectiveRows: rows to predict with instead of the actual-weather rows (the Meter
   Performance "normal weather" view). The baseline fit still uses actual weather. A call with
   effectiveRows is not cached.
───────────────────────────────────────────────────────────── */
function getMeterSavings(m, bills, incl, projId, bldgId, opts) {
  opts = opts || {};
  const empty = {
    byYM: {},
    byCalMo: {},
    unitsByYM: {},
    unitsByCalMo: {},
    incompleteYM: {},
    rows: [],
  };

  // 2026-09-15 (SA-gate fix): savings only compute for a CONTRACTED project. The contract
  // signal is projHasContract (contract type; the SA# plays no part, 2026-11-03) - a project with no contract
  // must show ZERO savings everywhere, not a phantom
  // number from a bill that happens to look complete. String(x.id) === String(projId) is
  // required because some callers pass projId as a String while projects[].id
  // are numbers - a strict === here would silently fail that caller.
  const _proj =
    typeof projects !== "undefined"
      ? projects.find((x) => String(x.id) === String(projId))
      : null;
  const hasContract = projHasContract(projId);

  const bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return empty;

  // Cache: return stored result if the inputs have not changed. The key holds everything the
  // result depends on that is not in the bills: project, contract flag, day-count basis,
  // inclusive setting, and the full baseline (reg included - freeze invalidates).
  // SAVINGS_CALC_VERSION and the 'v3|' prefix purge any older cache (see saveUtilityData()
  // strip-on-save + bcbc84e0).
  const _blFp = JSON.stringify({
    fz: getContractFrozenBaseline(m) ? 1 : 0,
    ver: SAVINGS_CALC_VERSION,
    reg: bl.reg || null,
    months: bl.months || null,
    overrides: bl.overrides || null,
    costSavOverrides: bl.costSavOverrides || null,
  });
  // The weather the result was computed at is part of the key: a month whose weather arrives later (the
  // automatic weather refresh, a CSV upload) must not be served from a result computed while it was missing.
  const _wxFp = getWeatherFingerprint(projId, bldgId);
  const cacheKey =
    "v3|p:" +
    projId +
    "|hc:" +
    (hasContract ? 1 : 0) +
    "|nb:" +
    ((_proj && _proj.normBasis) || "calendar") +
    "|i:" +
    JSON.stringify(incl == null ? null : incl) +
    "|" +
    bills.length +
    "_" +
    (bills[0]?.start || "") +
    "_" +
    (bills[bills.length - 1]?.end || "") +
    "|w:" +
    _wxFp +
    "|" +
    _blFp;
  if (!opts.effectiveRows && !opts.normalizedBills && m._savingsCache && m._savingsCacheKey === cacheKey)
    return m._savingsCache;

  const byYM = {};
  const byCalMo = {};
  const unitsByYM = {};
  const unitsByCalMo = {};
  // a67db8ce (2026-09-09 savings-integrity investigation): months where the rate could not
  // be resolved (blank stored rate and no cost fallback) - flagged here instead of being
  // silently written as $0.00, which is indistinguishable on screen from a real break-even
  // month. Consumed by the renderers (meter/building/project views, lib/perf-table.js).
  const incompleteYM = {};
  const rowsOut = [];

  const { byYm: weatherByYm } = getWeatherForBuilding(projId, bldgId);
  const isElec = m.commodity === "Electric";
  const isGas = m.commodity === "Gas";
  const isPropane = m.commodity === "Propane";
  const _actualRows = bills.length
    ? getNormRows(m, bills, incl, weatherByYm)
    : [];
  const allRows = opts.effectiveRows || _actualRows;
  const blRows = allRows.filter((r) => bl.months.includes(r.ym));
  // The regression is always FIT on actual weather; only the predictions use effectiveRows.
  const blRowsActual = opts.effectiveRows
    ? _actualRows.filter((r) => bl.months.includes(r.ym))
    : blRows;
  // Contracted project: store the baseline once (freezeContractBaseline), then buildMoMap and blAvg read it.
  if (hasContract && bills.length) freezeContractBaseline(m, bills, incl, weatherByYm);
  const _fzBl = opts.effectiveRows ? null : getContractFrozenBaseline(m);
  const blEnd = bl.months.slice().sort().pop();
  // 2026-09-15 (phantom-savings fix): exclude incompleteCycle rows - a genuinely short/stub
  // bill that hasn't completed a real billing cycle yet must not book savings (Client C:
  // baseline-only project with only a partial artifact bill after baseline end -> $0
  // savings everywhere, not a phantom number). incompleteCycle does NOT exclude complete
  // bills that merely straddle a calendar-month boundary (water/sewer irregular cycles),
  // so those keep booking real savings. See computations/normalization.js getNormRows().
  const postRows = allRows.filter((r) => r.ym > blEnd && !r.incompleteCycle);
  if (!postRows.length) {
    if (!opts.effectiveRows && !opts.normalizedBills) {
      m._savingsCache = empty;
      m._savingsCacheKey = cacheKey;
    }
    return empty;
  }

  const {
    elecByMo: eMo,
    gasByMo: gMo,
    propaneByMo: pMo,
    waterByMo: wMo,
  } = buildMoMap(m, blRows, bills, incl, !!opts.effectiveRows);
  const blByCalMo = baselineUsageByCalMo(m, {
    elecByMo: eMo,
    gasByMo: gMo,
    propaneByMo: pMo,
    waterByMo: wMo,
  });
  // Baseline-year kW of each calendar month, per kW basis (kwBasisForYm, computations/rates.js): the fallback baseline
  // of a meter with no kW fit.
  const blDemKWByCalMo = { billed: {}, actual: {} };
  if (isElec)
    Object.entries(eMo).forEach(([mo, v]) => {
      blDemKWByCalMo.billed[mo] = v.billedKW || v.demandKW || 0;
      blDemKWByCalMo.actual[mo] = v.demandKW || v.billedKW || 0;
    });
  const hasRegrP = allRows.some((r) => r.regrBaseline != null);
  const blAvg = _fzBl
    ? _fzBl.blAvg
    : blRows.length
      ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length
      : 0;

  // kW weather normalization: the one kW CDD regression (computations/regression.js).
  const _kwNormByYm =
    isElec && hasRegrP
      ? computeKwCddRegression(blRowsActual, allRows, bills, incl)
      : {};
  // The fits behind those kW values, per kW basis (null: no fit, the kW baseline is the kW of the same calendar month of the baseline year).
  const _kwFits =
    isElec && hasRegrP
      ? { actual: fitKwCdd(blRowsActual, bills, "actual"), billed: fitKwCdd(blRowsActual, bills, "billed") }
      : null;

  const rawUsageByYm = {};
  if (isPropane) {
    allRows.forEach((r) => {
      rawUsageByYm[r.ym] = r.usage;
    });
  } else {
    bills.forEach((b) => {
      const ym = billMonth(b, bills);
      if (!ym) return;
      const actUsage = isElec
        ? parseBillNumberOrZero(b.kwh) || parseBillNumberOrZero(b.usage)
        : isGas
          ? resolveGasUsageTherms(b)
          : parseBillNumberOrZero(b.waterUsage) || parseBillNumberOrZero(b.sewerUsage) || parseBillNumberOrZero(b.usage);
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + actUsage;
    });
  }

  // The ONE baseline-usage rule for a month: expectedUsageForMonth (above). Used by every row,
  // including pinned rows below.
  const expCtx = {
    blByCalMo,
    blAvg,
    kwWeatherNeeded: isElec && Object.keys(_kwNormByYm).length > 0,
    weatherDriven: isElec || isGas || isPropane,
    hasRegr: hasRegrP,
  };

  // Comparison only (opts.normalizedBills, getMeterSavingsComparison): the post-baseline bills moved to the baseline
  // weather of their calendar month. The baseline, the rates and the months are the contract's, unchanged.
  const nz = opts.normalizedBills
    ? normalizedBillsAtBaselineWeather(postRows, blRows, m.commodity, getProjectNormBasis(projId))
    : { usageByYm: {} };

  // 2026-09-11 (FIX 3, propane zeroFill savings booking): carry-forward propane rate -
  // updated to the most recent real all-in $/gal seen as postRows (sorted ascending by ym)
  // are walked, so a zeroFill month (no delivery yet) can book real savings using the last
  // known delivered rate instead of galRate=0 forcing totalCostSav to 0.
  let _lastGalRate = 0;
  postRows.forEach((r) => {
    const calMo = parseInt(r.ym.split("-")[1]) - 1;
    const bfr = isPropane
      ? []
      : bills.filter((b) => billMonth(b, bills) === r.ym);
    if (!isPropane && !bfr.length) return;

    let totalCostSav = 0;
    const unitSav = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
    let _rateIncomplete = false;
    let _rateReason = "";
    // Row detail for the Meter Performance table.
    let kwhRate = 0,
      kwhCostSav = 0,
      unitRate = 0,
      unitCostSav = 0,
      blExpKW = 0,
      actDemKW = 0,
      actBilKW = 0,
      moKwRate = 0,
      kwCostSav = 0;

    const _exp = expectedUsageForMonth(r, expCtx);
    if (_exp.weatherMissing) {
      // Weather for this month is not available yet: no expected usage, so no savings. The month is
      // listed (incompleteYM, row flag) and booked as $0 until weather exists.
      const _wxReason = "weather not yet available";
      if (hasContract) {
        incompleteYM[r.ym] = { commodity: m.commodity, reason: _wxReason, weather: true };
        byYM[r.ym] = byYM[r.ym] || 0;
        byCalMo[calMo] = byCalMo[calMo] || 0;
      }
      rowsOut.push({
        ym: r.ym,
        normDays: r.normDays,
        expUsage: null,
        actUsage: rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage,
        kwhRate: 0,
        kwhCostSav: 0,
        unitRate: 0,
        unitCostSav: 0,
        blExpKW: 0,
        demKW: 0,
        bilKW: 0,
        kwRate: 0,
        kwCostSav: 0,
        savings: 0,
        pinned: false,
        weatherMissing: true,
        rateIncomplete: hasContract,
        rateReason: hasContract ? _wxReason : "",
      });
      return;
    }
    const expUsage = _exp.usage;
    const actUsage = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
    // The usage the saving is figured from: the bill, or (comparison only) the bill moved to baseline weather.
    // The rate below always comes from the real bill (actUsage).
    const savUsage = nz.usageByYm[r.ym] != null ? nz.usageByYm[r.ym] : actUsage;

    if (isElec) {
      const actKwh = actUsage;
      // Rate of this month's bill(s): getMonthBillRate (computations/rates.js), usage-weighted over
      // the month's bills; a bill with no resolvable rate is left out, never counted as 0 (math-02 M1).
      const _sKwhRate = getMonthBillRate(bfr, "kwh");
      const kwhCostAmt = bfr.reduce(
        (s, b) => s + getBillKwhCost(b),
        0,
      );
      kwhRate =
        _sKwhRate || (actKwh > 0 && kwhCostAmt > 0 ? kwhCostAmt / actKwh : 0);
      const kwhSaved = expUsage - savUsage;
      kwhCostSav = kwhRate > 0 ? kwhSaved * kwhRate : 0;
      blExpKW =
        _kwNormByYm[r.ym] != null
          ? _kwNormByYm[r.ym]
          : blDemKWByCalMo[kwBasisForYm(r.ym)][calMo] || 0;
      // The kW the savings compare: Actual kW from 2026-07 on, Billed kW before (getMonthSavingsKw, rates.js). The row
      // field `bilKW` keeps its name because the report column and its printed-value key (bld_kw) use it.
      actBilKW = getMonthSavingsKw(bfr, r.ym);
      actDemKW = Math.max(...bfr.map((b) => parseBillNumberOrZero(b.demandKW)));
      // getMonthKwRate() (computations/rates.js) is the ONE $/kW rate of a month: from 2026-07 on the total actual kW
      // rate (each charge over its own kW), before it demand + facilities dollars over Billed kW (see its header).
      moKwRate = getMonthKwRate(bfr, r.ym);
      // Missing-rate cascade (steps 2-5, computations/rates.js resolveMeterRate): only when
      // the own-bill rate above is genuinely absent AND there is real billed kW that month
      // (a savings-feeding month) - see _context/plans/2026-09-10-missing-rate-resolution-cascade.md.
      if (
        !(moKwRate > 0) &&
        actBilKW > 0 &&
        typeof resolveMeterRate === "function"
      ) {
        const _allMeters =
          typeof getUDBldg === "function"
            ? (getUDBldg(projId, bldgId) || {}).meters || []
            : [];
        const _resolved = resolveMeterRate(projId, m, r.ym, {
          bills,
          incl,
          allMeters: _allMeters,
          component: "kw",
        });
        if (_resolved && _resolved.rate > 0) moKwRate = _resolved.rate;
      }
      const _chk = checkRateIncomplete({
        kwh: { enabled: true, rate: kwhRate, actUsage: actKwh },
        kw: { enabled: blExpKW > 0, rate: moKwRate, actual: actBilKW },
      });
      _rateIncomplete = _chk.incomplete;
      _rateReason = _chk.reason;
      const kwSaved = blExpKW - actBilKW;
      kwCostSav = blExpKW > 0 && moKwRate > 0 ? kwSaved * moKwRate : 0;
      totalCostSav = kwhCostSav + kwCostSav;
      unitSav.kwh = kwhSaved;
      unitSav.kw = kwSaved;
    } else if (isPropane) {
      const actGallons = actUsage;
      const actCost = r.cost;
      // D-9: propane $/gal is the ALL-IN rate (whole delivered cost / gallons), not the
      // bill's printed unit price - same whole-bill rule as gas.
      let galRate = actGallons > 0 && actCost > 0 ? actCost / actGallons : 0;
      if (galRate > 0) {
        _lastGalRate = galRate;
      } else if (r.zeroFill && _lastGalRate > 0) {
        galRate = _lastGalRate;
      }
      const _chk = checkRateIncomplete({
        unit: {
          enabled: !r.zeroFill,
          rate: galRate,
          actUsage: actGallons,
          actCost: actCost,
          reason: "propane $/gallon rate unavailable",
        },
      });
      _rateIncomplete = _chk.incomplete;
      _rateReason = _chk.reason;
      unitRate = galRate;
      totalCostSav = galRate > 0 ? (expUsage - savUsage) * galRate : 0;
      unitCostSav = totalCostSav;
      unitSav.gallons = galRate > 0 ? expUsage - savUsage : 0;
    } else {
      const actTherms = actUsage;
      // getBillGasCost (computations/rates.js) — the ONE gas cost accessor (visible Gas Charge).
      const actThermCost = bfr.reduce((s, b) => s + getBillGasCost(b), 0);
      // Rate of this month's bill(s): getMonthBillRate (computations/rates.js), usage-weighted; blank
      // bills left out, not counted as 0 - math-02 M1. Only a Gas meter derives a rate from the
      // bill's gas fields; this branch also runs for Water/Sewer/Stormwater/Steam meters.
      const _sGasRate = isGas ? getMonthBillRate(bfr, "gas") : 0;
      // A gas month with no gas use and no gas charge still saves its baseline therms at the current monthly rate of the
      // utility: getPeerMonthGasRate (computations/rates.js), from ZERO_USE_GAS_FROM_YM on.
      const thermRate =
        _sGasRate ||
        (actTherms > 0 && actThermCost > 0 ? actThermCost / actTherms : 0) ||
        (isGas && !(actTherms > 0) && !(actThermCost > 0) ? getPeerMonthGasRate(projId, m, r.ym) : 0);
      // Gate on Gas specifically - this "else" branch also runs for Water/Sewer/Stormwater/
      // Steam meters (ALL_COMMODITIES, app/core.js). This is NOT "no rate by design": real
      // bills for those commodities DO carry their own rate (totalWaterRate/waterCharge,
      // totalSewerRate/sewerCharge, totalStormwaterRate) - most
      // Water/Sewer/Stormwater bills in stored project data carry a real rate. This branch
      // simply never reads those fields, so $ savings for them has
      // never been computed by this engine - a real, separate gap, out of scope for
      // a67db8ce (gas/electric/propane rate-incompleteness). Gating here on Gas prevents
      // that pre-existing, always-$0 state from being misreported as "rate incomplete."
      const _chk = checkRateIncomplete({
        unit: {
          enabled: isGas,
          rate: thermRate,
          actUsage: actTherms,
          actCost: actThermCost,
          reason: "gas $/therm rate unavailable",
        },
      });
      _rateIncomplete = _chk.incomplete;
      _rateReason = _chk.reason;
      unitRate = thermRate;
      totalCostSav = thermRate > 0 ? (expUsage - savUsage) * thermRate : 0;
      unitCostSav = totalCostSav;
      unitSav.therms = thermRate > 0 ? expUsage - savUsage : 0;
    }

    // Apply costSavOverrides if present (per year-month)
    const _costOvr = m.baseline?.costSavOverrides?.[r.ym];
    const finalCostSav = _costOvr != null ? _costOvr : totalCostSav;
    // a67db8ce: flag this month as rate-incomplete unless a human has already resolved it
    // with an explicit costSavOverride. Never applies to a month with a complete rate -
    // this only fires when the $0.00 above was manufactured by a missing rate.
    const flagIncomplete = _rateIncomplete && _costOvr == null;

    rowsOut.push({
      ym: r.ym,
      normDays: r.normDays,
      expUsage: expUsage,
      actUsage: actUsage,
      kwhRate: kwhRate,
      kwhCostSav: hasContract ? kwhCostSav : 0,
      unitRate: unitRate,
      unitCostSav: hasContract ? unitCostSav : 0,
      blExpKW: blExpKW,
      demKW: actDemKW,
      bilKW: actBilKW,
      kwRate: moKwRate,
      kwCostSav: hasContract ? kwCostSav : 0,
      savings: hasContract ? finalCostSav : 0,
      // The month by the contract formula, before any pinned override (display of a month; a pin is never read here).
      formulaSavings: hasContract ? totalCostSav : 0,
      pinned: hasContract && _costOvr != null,
      rateIncomplete: hasContract && flagIncomplete,
      rateReason: hasContract && flagIncomplete ? _rateReason : "",
      ...(opts.normalizedBills ? { normUsage: savUsage } : {}),
    });
    // No Service Agreement: rows above show usage with $0; nothing books into the rollups.
    if (!hasContract) return;

    if (flagIncomplete)
      incompleteYM[r.ym] = { commodity: m.commodity, reason: _rateReason };

    byYM[r.ym] = (byYM[r.ym] || 0) + finalCostSav;
    byCalMo[calMo] = (byCalMo[calMo] || 0) + finalCostSav;

    if (!unitsByYM[r.ym])
      unitsByYM[r.ym] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
    unitsByYM[r.ym].kwh += unitSav.kwh;
    unitsByYM[r.ym].kw += unitSav.kw;
    unitsByYM[r.ym].therms += unitSav.therms;
    unitsByYM[r.ym].gallons += unitSav.gallons;

    if (!unitsByCalMo[calMo])
      unitsByCalMo[calMo] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
    unitsByCalMo[calMo].kwh += unitSav.kwh;
    unitsByCalMo[calMo].kw += unitSav.kw;
    unitsByCalMo[calMo].therms += unitSav.therms;
    unitsByCalMo[calMo].gallons += unitSav.gallons;
  });

  // Inject overrides for months that have no postRow (e.g. propane with no delivery that month)
  if (hasContract) {
    const _allOverrides = bl.costSavOverrides || {};
    Object.entries(_allOverrides).forEach(([ym, val]) => {
      if (val == null || ym <= blEnd) return;
      const calMo = parseInt(ym.split("-")[1]) - 1;
      if (byYM[ym] == null) {
        byYM[ym] = val;
        byCalMo[calMo] = (byCalMo[calMo] || 0) + val;
      }
      // A pinned (presented) month always has a table row, even when the bills give it no
      // usage (propane spread puts 0 gal in it, or no bill falls in it). Its usage is the real
      // value from the data: propane 0 when the spread gives it nothing, null (shown as a dash)
      // when there is no bill. Never invented usage. Pinned dollars are the override.
      if (!rowsOut.some((o) => o.ym === ym)) {
        const _hasUsage = rawUsageByYm[ym] != null;
        rowsOut.push({
          ym: ym,
          normDays: null,
          expUsage: expectedUsageForMonth(allRows.find((x) => x.ym === ym) || { ym }, expCtx).usage,
          actUsage: _hasUsage ? rawUsageByYm[ym] : isPropane ? 0 : null,
          kwhRate: 0,
          kwhCostSav: 0,
          unitRate: 0,
          unitCostSav: 0,
          blExpKW: 0,
          demKW: 0,
          bilKW: 0,
          kwRate: 0,
          kwCostSav: 0,
          savings: val,
          formulaSavings: 0,
          pinned: true,
          rateIncomplete: false,
          rateReason: "",
        });
        if (!unitsByYM[ym]) unitsByYM[ym] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
        if (!unitsByCalMo[calMo])
          unitsByCalMo[calMo] = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
      }
    });
    rowsOut.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  }

  const result = {
    byYM,
    byCalMo,
    unitsByYM,
    unitsByCalMo,
    incompleteYM,
    rows: rowsOut,
    blKwFits: _kwFits,
  };
  if (!opts.effectiveRows && !opts.normalizedBills) {
    m._savingsCache = result;
    m._savingsCacheKey = cacheKey;
  }
  return result;
}

/* ─────────────────────────────────────────────────────────────
   getBuildingSavingsByYM(bldg, projId)
   Rollup: sum meter savings for a building (by year-month)
───────────────────────────────────────────────────────────── */
function getBuildingSavingsByYM(bldg, projId) {
  // Field relocation (2026-09-24): inclMonths lives on the project record, not the
  // shared customer blob.
  const _gbProjList =
    typeof projects !== 'undefined' ? projects : typeof sget === 'function' ? sget('en_projects', []) : [];
  const proj = (_gbProjList || []).find((p) => String(p.id) === String(projId));
  if (!proj || !bldg || !bldg.meters) return {};
  const incl = proj.inclMonths || {};
  const result = {};
  bldg.meters.forEach((m) => {
    if (isBaselineExcluded(projId, m.id)) return;
    const bills = (m.bills || []).slice().sort((a, c) => (a.start || '').localeCompare(c.start || ''));
    const mSav = getMeterSavings(m, bills, incl, projId, bldg.id).byYM;
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
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : null;
  if (!bldgs) return {};
  const result = {};
  bldgs.forEach((b) => {
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
  // 2026-09-15 (SA-gate fix): String(x.id) === String(projId) matches the getMeterSavings
  // gate above — some callers pass projId as a String while projects[].id are numbers,
  // so a strict === here silently failed that caller.
  // 2026-09-21 (SA-gate scope fix): the SA# (Service Agreement #) requirement was removed
  // from this path. It belongs only to ACTUAL/bill-based savings (getMeterSavings, above),
  // which need a contracted baseline to book real $ against. This function computes
  // ESTIMATED/PROJECTED measure-based savings (a planned measure x its own rates) — that
  // is independent of whether the project has a signed SA yet and must display regardless
  // (Client C, Client D, Client E: sa="" but still need to show projected/estimated savings).
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!p || !p.savingsData) return null;
  const measures = (p.savingsData.measures || []).filter((m) => m.bldgId === bldgId && m.selected !== false);
  if (!measures.length) return null;
  // Pricing is calcMeasureDollars (app/energy-savings.js), the one owner; this only sums its months.
  const monthlySavings = Array(12).fill(0);
  measures.forEach((m) => {
    const r = measureRatesNow(p.id, m, (p.savingsData.blRates || {})[bldgId]);
    calcMeasureDollars(m, r).monthly.forEach((d, mo) => (monthlySavings[mo] += d.total));
  });
  return monthlySavings;
}
/* ─────────────────────────────────────────────────────────────
   PRESENTED-TO-CLIENT LOCK (WP-04a, 2026-09-29)
   Rule (Matt): savings figures already presented to the client can not change.
   The lock stores the figures PRINTED in the presented document, not the site's math at
   the time of the click (re-running the math later moves printed numbers by a few dollars).
   One storage key, one record per project + period, written only by the user's confirm:
     { projectId, periodStart, periodEnd, presentedAt, documentName, totalDollars,
       buildings: { <bldgId>: { dollars, kwhSaved?, thermsSaved?, gallonsSaved?,
         elecDollars?, gasDollars?, propaneDollars? } } }  (commodity dollars = the printed split)
     printed?: { "<section>|<row>|<commodity>|<month>|<column>": number | text }  every other figure of
       the printed document (row = building id, or the printed row label when it is not a building).
       Read only through getPresentedPrintedMap() / getPresentedPrintedValue().
   totalSavingsWithPresented() is the ONE place a period / building / project savings total
   is decided; every consumer that adds up months calls it. Monthly rows stay recalculated.
───────────────────────────────────────────────────────────── */
const PRESENTED_SAVINGS_KEY = "en_presented_savings";

function getPresentedRecords(projId) {
  return (sget(PRESENTED_SAVINGS_KEY, []) || [])
    .filter((r) => String(r.projectId) === String(projId))
    .sort(
      (a, b) =>
        a.periodStart.localeCompare(b.periodStart) ||
        a.presentedAt.localeCompare(b.presentedAt),
    );
}

// Every YYYY-MM from a to z inclusive.
function presentedMonthRange(a, z) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [zy, zm] = z.split("-").map(Number);
  while (y < zy || (y === zy && m <= zm)) {
    out.push(y + "-" + String(m).padStart(2, "0"));
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// The quarter the project headline shows: the first quarter after the newest presented record. With no
// presented record it is the latest quarter that has any bill. Never a quarter after the newest bill month.
// Meters counted = the ones in the baseline (isBaselineExcluded) and in a calculated commodity (isCalcCommodity).
// Returns { year, q (0-3), yms: [3 x 'YYYY-MM'], label: 'Qn YYYY', complete, billsThrough: 'YYYY-MM-DD' or null }
// or null when the project has no bills. billsThrough = the earliest latest-bill end date among the non-delivery meters (propane is skipped).
function nextQuarterToPresent(projId) {
  const lastByMeter = [];
  getUDBldgs(projId).forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id) || !isCalcCommodity(projId, m.commodity)) return;
      const bills = (m.bills || []).filter((x) => x && x.end);
      if (!bills.length) return;
      const last = bills.reduce((a, x) => (x.end > a.end ? x : a));
      lastByMeter.push({ end: last.end, ym: billMonth(last, m.bills), delivery: DELIVERY_COMMODITIES.has(m.commodity) });
    }),
  );
  if (!lastByMeter.length) return null;
  const qIdx = (ym) => Number(ym.slice(0, 4)) * 4 + Math.floor((Number(ym.slice(5, 7)) - 1) / 3);
  const newestQ = qIdx(lastByMeter.reduce((a, x) => (x.ym > a ? x.ym : a), ''));
  const recs = getPresentedRecords(projId);
  let idx = newestQ;
  if (recs.length) {
    const lastEnd = recs.reduce((a, r) => (r.periodEnd > a ? r.periodEnd : a), '');
    idx = Math.min(qIdx(lastEnd) + 1, newestQ);
  }
  const year = Math.floor(idx / 4);
  const q = idx % 4;
  const yms = [1, 2, 3].map((k) => year + '-' + String(q * 3 + k).padStart(2, '0'));
  // Delivery commodities (DELIVERY_COMMODITIES, app/core.js) are left out of both: a delivery date is not a monthly bill date.
  const monthly = lastByMeter.filter((x) => !x.delivery);
  const complete = monthly.every((x) => x.ym >= yms[2]);
  const billsThrough = complete || !monthly.length ? null : monthly.reduce((a, x) => (x.end < a ? x.end : a), monthly[0].end);
  return { year, q, yms, label: 'Q' + (q + 1) + ' ' + year, complete, billsThrough };
}

function getPresentedRecordFor(projId, yms) {
  if (!yms || !yms.length) return null;
  const sorted = yms.slice().sort();
  const a = sorted[0];
  const z = sorted[sorted.length - 1];
  return (
    getPresentedRecords(projId).find(
      (r) => r.periodStart === a && r.periodEnd === z,
    ) || null
  );
}

// The records that lock part of `yms`: whole period inside yms, no month claimed twice
// (earliest period wins an overlap).
function _presentedApplied(projId, yms) {
  const inSet = new Set(yms);
  const claimed = new Set();
  const applied = [];
  getPresentedRecords(projId).forEach((rec) => {
    const rm = presentedMonthRange(rec.periodStart, rec.periodEnd);
    if (!rm.every((y) => inSet.has(y)) || rm.some((y) => claimed.has(y)))
      return;
    rm.forEach((y) => claimed.add(y));
    applied.push({ rec, months: rm });
  });
  return applied;
}

function _presentedDateLabel(rec) {
  return new Date(rec.presentedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function _presentedMonthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

// Plain-words line for a report period, or '' when nothing in the period was presented.
function getPresentedNotice(projId, yms) {
  if (!yms || !yms.length) return "";
  const tail = " monthly detail is recalculated and may differ slightly.";
  const exact = getPresentedRecordFor(projId, yms);
  if (exact)
    return (
      "Presented to client on " +
      _presentedDateLabel(exact) +
      ". Figures are locked;" +
      tail
    );
  return _presentedApplied(projId, yms)
    .map(
      (a) =>
        "Includes figures presented to client on " +
        _presentedDateLabel(a.rec) +
        " for " +
        _presentedMonthLabel(a.rec.periodStart) +
        " through " +
        _presentedMonthLabel(a.rec.periodEnd) +
        ". Those figures are locked;" +
        tail,
    )
    .join(" ");
}

// Savings total for the months `yms`, for the buildings in `perBldg` = { <bldgId>: { <ym>: dollars } }
// (current values, however the caller built them). A presented period inside yms replaces the
// current months with the printed building figure; the printed portfolio total replaces the sum
// of the printed building figures when every building of that record is in scope.
// Returns { total, byBldg: { <bldgId>: dollars }, applied: [record] }.
function totalSavingsWithPresented(projId, yms, perBldg) {
  const applied = _presentedApplied(projId, yms);
  const claimed = new Set();
  applied.forEach((a) => a.months.forEach((y) => claimed.add(y)));
  const byBldg = {};
  let total = 0;
  Object.keys(perBldg).forEach((b) => {
    const cur = perBldg[b] || {};
    let t = 0;
    yms.forEach((y) => {
      if (!claimed.has(y)) t += cur[y] || 0;
    });
    applied.forEach((a) => {
      const f = a.rec.buildings[b];
      t +=
        f && f.dollars != null
          ? f.dollars
          : a.months.reduce((s, y) => s + (cur[y] || 0), 0);
    });
    byBldg[b] = t;
    total += t;
  });
  applied.forEach((a) => {
    const ids = Object.keys(a.rec.buildings);
    if (a.rec.totalDollars == null || !ids.every((id) => id in perBldg)) return;
    total +=
      a.rec.totalDollars -
      ids.reduce((s, id) => s + (a.rec.buildings[id].dollars || 0), 0);
  });
  return { total, byBldg, applied: applied.map((a) => a.rec) };
}

// Savings never go negative for billing: the contract pays nothing for a quarter below baseline and
// bills per calendar quarter (Agreement 3.1). The ONE floor.
function floorQuarterSavings(dollars) {
  return Math.max(0, dollars || 0);
}

// savingsShown(v, decimals) - v rounded to the precision it is displayed at (0 for whole dollars). A value that
// shows as "$0" is 0 here, whatever its raw size. Not a number -> 0.
function savingsShown(v, decimals) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  const f = Math.pow(10, decimals || 0);
  return Math.round(Math.abs(n) * f) / f * (n < 0 ? -1 : 1) || 0;
}

// savingsSignColor(v, decimals, pos, neg, neutral) - the ONE colour rule for a savings (or use-change) figure, tested on
// the value as DISPLAYED at `decimals`: `pos` only when it shows > 0, `neg` only when it shows < 0, `neutral` when it shows 0
// (or is not a number). So "$0" and "-$0" are never green or red.
function savingsSignColor(v, decimals, pos, neg, neutral) {
  const s = savingsShown(v, decimals);
  return s > 0 ? pos : s < 0 ? neg : neutral;
}

// savingsSign(v, decimals) - the ONE sign rule: '+' only when the figure shows > 0, the minus sign (U+2212) only when it shows
// < 0, '' when it shows 0. Same rounding as savingsSignColor. minusOnly=true: no '+' (cost figures show no plus).
function savingsSign(v, decimals, minusOnly) {
  const s = savingsShown(v, decimals);
  return s > 0 ? (minusOnly ? '' : '+') : s < 0 ? '−' : '';
}

// savingsFlooredShown(measured, billable, decimals, fmtAbs, pos, neg, neutral) -> { text, color, floored } - how to show a
// billable (floored) figure. When the measured value is negative and the floor made it $0 (floorQuarterSavings), show both,
// "−$2,023 → $0", in `neg` (floored = true). Otherwise the figure with savingsSign and savingsSignColor (plus = true adds '+' to a positive; a true zero has
// no sign and is `neutral`). fmtAbs(n) formats |n|. The same call serves a percent: pass the two percents and a percent fmtAbs.
function savingsFlooredShown(measured, billable, decimals, fmtAbs, pos, neg, neutral, plus) {
  const floored = savingsShown(measured, decimals) < 0 && savingsShown(billable, decimals) === 0;
  if (floored)
    return { floored, color: neg, text: '−' + fmtAbs(Math.abs(measured)) + ' → ' + fmtAbs(0) };
  return {
    floored,
    color: savingsSignColor(billable, decimals, pos, neg, neutral),
    text: savingsSign(billable, decimals, !plus) + fmtAbs(Math.abs(billable)),
  };
}

// sumPositiveSavings(values) - the total of only the positive savings values in a list (negatives and nulls left out).
// Display-only companion to a column total; it adds no savings math, the values are the ones already computed.
function sumPositiveSavings(values) {
  return values.reduce((s, v) => (v > 0 ? s + v : s), 0);
}

// The 'YYYY-Qn' calendar quarter of a 'YYYY-MM'.
function quarterKeyOfYM(ym) {
  return ym.slice(0, 4) + "-Q" + (Math.floor((parseInt(ym.slice(5, 7), 10) - 1) / 3) + 1);
}

// quarterMissingBills(projId, qKey) - the bills a calendar quarter ('YYYY-Qn') still lacks, one line per
// missing meter-month, e.g. "Building A Gas Sep". The rule is NOT here: it is getReportCoverage
// (computations/report-data.js), the one rule for "which bills are missing for a period"; this only asks it
// for the quarter's three months and words each gap. A presented quarter lacks none. [] = complete.
// The app shows the list as a "Waiting for bills" chip; it never goes into a client document.
function quarterMissingBills(projId, qKey) {
  const y = qKey.slice(0, 4);
  const q = Number(qKey.slice(6)) - 1;
  const yms = [1, 2, 3].map((k) => y + "-" + String(q * 3 + k).padStart(2, "0"));
  if (_presentedApplied(projId, yms).some((a) => a.months.length === 3)) return [];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return getReportCoverage(projId, null, yms[0], yms[2]).missing.map(
    (x) => x.building + " " + x.commodity + " " + MON[Number(x.ym.slice(5, 7)) - 1],
  );
}

// billableSavingsWithPresented(projId, yms, perBldg) - the savings value to SHOW OR BILL for the months
// `yms`: the project total of each calendar quarter (totalSavingsWithPresented, so a presented quarter keeps
// its printed figure) floored at $0 by floorQuarterSavings, then added up. A quarter still missing bills
// (quarterMissingBills) is counted from the bills we have, and named in `missing` ({ 'YYYY-Qn': [lines] }) so
// the app can show "Waiting for bills". For one quarter it is that quarter's billable savings; for a longer
// period, or all months to date, it is the CUMULATIVE savings to date = the sum of the floored quarters
// (Matt, 2026-10-27; the 60% cap in Agreement 3.1 is for rebates and incentives and does not net a shortfall
// quarter). To change the cumulative rule, change it here only.
// A quarter with a month that has no weather yet (quarterWeatherMissing) is left out of total AND byBldg and named
// in weatherWaiting ({ 'YYYY-Qn': [ym] }): it is never floored, billed or added to the cumulative.
// Returns { total, measured, byBldg, applied, missing, weatherWaiting }. measured = the same quarters before the floor. byBldg stays the NET per-building sum over the other yms (building
// rows are not floored). Monthly and per-meter values are never floored.
function billableSavingsWithPresented(projId, yms, perBldg) {
  const byQtr = {};
  yms.forEach((y) => (byQtr[quarterKeyOfYM(y)] = byQtr[quarterKeyOfYM(y)] || []).push(y));
  const wx = _weatherSplit(projId, yms);
  const net = totalSavingsWithPresented(projId, wx.open, perBldg);
  let total = 0;
  let measured = 0; // the same quarters NOT floored: what was measured, shown beside a floored $0
  const missing = {};
  Object.keys(byQtr).forEach((q) => {
    const gaps = quarterMissingBills(projId, q);
    if (gaps.length) missing[q] = gaps;
    if (wx.waiting[q]) return; // no weather for a month: no figure for the quarter, never floored or billed
    const qNet = totalSavingsWithPresented(projId, byQtr[q], perBldg).total;
    measured += qNet;
    total += floorQuarterSavings(qNet);
  });
  return { total, measured, byBldg: net.byBldg, applied: net.applied, missing, weatherWaiting: wx.waiting };
}

// quarterWeatherMissing(projId, qKey) - the months ('YYYY-MM') of a calendar quarter ('YYYY-Qn') for which
// some meter has bills but no weather yet (getMeterSavings row.weatherMissing, from expectedUsageForMonth, the
// one rule). A quarter with any such month has no savings figure: the app and every report show "Waiting for
// weather data: <month>" in place of a dollar amount, and leave the quarter out of the cumulative and contract
// totals. A presented quarter keeps its printed figure and is never waiting. [] = every month has weather.
function quarterWeatherMissing(projId, qKey) {
  const y = qKey.slice(0, 4);
  const q = Number(qKey.slice(6)) - 1;
  const yms = [1, 2, 3].map((k) => y + '-' + String(q * 3 + k).padStart(2, '0'));
  if (_presentedApplied(projId, yms).some((a) => a.months.length === 3)) return [];
  const out = {};
  getUDBldgs(projId).forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id)) return;
      const bills = (m.bills || []).slice().sort((a, c) => (a.start || '').localeCompare(c.start || ''));
      getMeterSavings(m, bills, m.inclusive !== false, projId, b.id).rows.forEach((r) => {
        if (r.weatherMissing && yms.indexOf(r.ym) >= 0) out[r.ym] = true;
      });
    }),
  );
  return Object.keys(out).sort();
}

// "Sep 2026" style names for a list of 'YYYY-MM', for the "Waiting for weather data: ..." line.
function weatherWaitingLabel(yms) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return yms.map((y) => MON[Number(y.slice(5, 7)) - 1] + ' ' + y.slice(0, 4)).join(', ');
}

// savingsOrWaiting(waitingYMs, dollars) - the text a savings figure is shown as: the dollars, or, when the
// period has a month with no weather yet (weatherWaiting from billableSavingsWithPresented), the words in
// place of the dollars. The ONE wording; every report and page uses it.
function savingsOrWaiting(waitingYMs, dollars) {
  return waitingYMs && waitingYMs.length
    ? 'Waiting for weather data: ' + weatherWaitingLabel(waitingYMs)
    : _fmtUSD(dollars, '$0');
}

// weatherWaitingMonths(projId, yms) -> the months ('YYYY-MM') of yms that have no weather yet and so block their
// quarter from billing. Pages pass it to savingsOrWaiting to show "Waiting for weather data" instead of dollars.
// [] = nothing is blocked. weatherWaitingQuarters names the blocked quarters.
function weatherWaitingMonths(projId, yms) {
  const w = _weatherSplit(projId, yms).waiting;
  return [].concat.apply([], Object.values(w)).sort();
}

// weatherWaitingQuarters(projId, yms) -> { 'YYYY-Qn': [ym] } of the quarters of yms that are waiting for weather.
function weatherWaitingQuarters(projId, yms) {
  return _weatherSplit(projId, yms).waiting;
}

// _weatherSplit(projId, yms) -> { waiting: { 'YYYY-Qn': [ym] }, open: yms outside the waiting quarters }.
function _weatherSplit(projId, yms) {
  const waiting = {};
  const seen = {};
  yms.forEach((y) => {
    const q = quarterKeyOfYM(y);
    if (seen[q]) return;
    seen[q] = true;
    const w = quarterWeatherMissing(projId, q);
    if (w.length) waiting[q] = w;
  });
  return { waiting, open: yms.filter((y) => !waiting[quarterKeyOfYM(y)]) };
}

// savingsNotBilledWithPresented(projId, yms, perBldg) - the gap between the real rows a report prints and
// the billable total under them, so the columns add up. perBldg is the same { <bldgId>: { <ym>: dollars } }
// that billableSavingsWithPresented takes (current values).
//   shortfall = billable total - net total: what the contract does not bill, because a quarter below
//               baseline is floored at $0 ("Shortfall not billed (contract minimum $0)"). Never negative.
//   presented = net total - the sum of the current month values: a presented quarter keeps the figure that was
//               printed to the client (never re-derived, Matt 2026-09-29), so it can differ from the current
//               month rows. 0 when nothing in yms was presented.
// Building rows (totalSavingsWithPresented byBldg) add up to total - shortfall; month rows (current values)
// add up to total - shortfall - presented. This is the ONE rule for that gap; every report table calls it.
function savingsNotBilledWithPresented(projId, yms, perBldg) {
  const open = _weatherSplit(projId, yms).open; // a quarter waiting for weather has no figure to compare
  const billable = billableSavingsWithPresented(projId, yms, perBldg).total;
  const net = totalSavingsWithPresented(projId, open, perBldg).total;
  let rows = 0;
  Object.keys(perBldg).forEach((b) => {
    open.forEach((y) => (rows += (perBldg[b] || {})[y] || 0));
  });
  return { shortfall: billable - net, presented: net - rows };
}

// Shared engine of the two functions below. perBldgVals = { <bldgId>: { <ym>: { <key>: number } } };
// fieldOf maps each key to its printed field name on the presented building record.
function _sumWithPresented(projId, yms, perBldgVals, fieldOf) {
  const applied = _presentedApplied(projId, yms);
  const claimed = new Set();
  applied.forEach((a) => a.months.forEach((y) => claimed.add(y)));
  const out = {};
  Object.keys(fieldOf).forEach((k) => (out[k] = 0));
  Object.keys(perBldgVals).forEach((b) => {
    const cur = perBldgVals[b] || {};
    Object.keys(out).forEach((k) => {
      yms.forEach((y) => {
        if (!claimed.has(y)) out[k] += (cur[y] && cur[y][k]) || 0;
      });
      applied.forEach((a) => {
        const f = a.rec.buildings[b];
        out[k] +=
          f && f[fieldOf[k]] != null
            ? f[fieldOf[k]]
            : a.months.reduce((s, y) => s + ((cur[y] && cur[y][k]) || 0), 0);
      });
    });
  });
  return out;
}

// Unit totals ({kwh, therms, gallons}) for the months `yms`, for `perBldgUnits` =
// { <bldgId>: { <ym>: {kwh, therms, gallons} } } (current values). Same rule as the dollar total:
// a presented period inside yms replaces that building's months with the printed unit figure
// (a unit the document did not print stays current).
function totalUnitsWithPresented(projId, yms, perBldgUnits) {
  return _sumWithPresented(projId, yms, perBldgUnits, {
    kwh: "kwhSaved",
    therms: "thermsSaved",
    gallons: "gallonsSaved",
  });
}

// Per-commodity dollar totals ({electric, gas, propane}); same rule, printed split fields.
function totalCommodityDollarsWithPresented(projId, yms, perBldgComm) {
  return _sumWithPresented(projId, yms, perBldgComm, {
    electric: "elecDollars",
    gas: "gasDollars",
    propane: "propaneDollars",
  });
}

// Printed unit and commodity-dollar figures ({kwhSaved, thermsSaved, gallonsSaved, elecDollars,
// gasDollars, propaneDollars}) for one building, only when a
// record covers exactly this period (units cannot be re-cut for a different month set).
function getPresentedUnits(projId, yms, bldgId) {
  const rec = getPresentedRecordFor(projId, yms);
  return (rec && rec.buildings[bldgId]) || null;
}

// Every printed figure of the document for exactly this period, or null. Keys are built by
// presentedPrintedKey(); a period that is not exactly the presented one has no printed figures.
function getPresentedPrintedMap(projId, yms) {
  const rec = getPresentedRecordFor(projId, yms);
  return rec && rec.printed ? rec.printed : null;
}

function presentedPrintedKey(section, row, commodity, month, column) {
  return [section, row, commodity || "", month || "", column].join("|");
}

// One printed figure (number or text), or undefined when the document did not print it.
function getPresentedPrintedValue(printed, section, row, commodity, month, column) {
  if (!printed) return undefined;
  const k = presentedPrintedKey(section, row, commodity, month, column);
  return Object.prototype.hasOwnProperty.call(printed, k) ? printed[k] : undefined;
}

// Project total across every building of the project (portal, dashboards). yms defaults to
// every month any building has savings for.
function getProjectSavingsTotal(projId, yms) {
  const bldgs =
    typeof getUDBldgs === "function" ? getUDBldgs(projId) || [] : [];
  const perBldg = {};
  const all = new Set();
  bldgs.forEach((b) => {
    perBldg[b.id] = getBuildingSavingsByYM(b, projId);
    Object.keys(perBldg[b.id]).forEach((y) => all.add(y));
  });
  const months = yms || Array.from(all).sort();
  return billableSavingsWithPresented(projId, months, perBldg);
}

// Validate and store one presented record. Only the confirm button of the Mark-as-presented
// form calls this. Returns { ok, reason?, record? }.
function savePresentedRecord(rec) {
  if (
    !rec ||
    rec.projectId == null ||
    !/^\d{4}-\d{2}$/.test(rec.periodStart) ||
    !/^\d{4}-\d{2}$/.test(rec.periodEnd)
  ) {
    return { ok: false, reason: "The period is missing." };
  }
  if (rec.periodStart > rec.periodEnd)
    return { ok: false, reason: "The period ends before it starts." };
  const ids = Object.keys(rec.buildings || {});
  if (
    !ids.length ||
    ids.some((id) => !Number.isFinite(rec.buildings[id].dollars))
  ) {
    return {
      ok: false,
      reason:
        "Enter the presented savings in dollars for at least one building.",
    };
  }
  const months = presentedMonthRange(rec.periodStart, rec.periodEnd);
  const clash = getPresentedRecords(rec.projectId).some((r) =>
    presentedMonthRange(r.periodStart, r.periodEnd).some((y) =>
      months.includes(y),
    ),
  );
  if (clash)
    return {
      ok: false,
      reason: "A period that overlaps this one is already marked as presented.",
    };
  const clean = {
    projectId: String(rec.projectId),
    periodStart: rec.periodStart,
    periodEnd: rec.periodEnd,
    presentedAt: rec.presentedAt,
    documentName: rec.documentName || "",
    totalDollars: Number.isFinite(rec.totalDollars) ? rec.totalDollars : null,
    buildings: rec.buildings,
  };
  if (rec.printed && typeof rec.printed === "object" && Object.keys(rec.printed).length) {
    clean.printed = rec.printed;
  }
  if (rec.pdfKey) {
    clean.pdfKey = String(rec.pdfKey);
    clean.pdfName = rec.pdfName || "";
  }
  sset(
    PRESENTED_SAVINGS_KEY,
    (sget(PRESENTED_SAVINGS_KEY, []) || []).concat([clean]),
  );
  return { ok: true, record: clean };
}

// Attach (or replace) the PDF of the report given to the client. pdfKey is a blob key in the
// PDF store (en_pdf_shared_<hash16>). Only a user action calls this. Returns true when a
// record for the period exists.
function setPresentedPdf(projId, yms, pdfKey, pdfName) {
  const rec = getPresentedRecordFor(projId, yms);
  if (!rec) return false;
  sset(
    PRESENTED_SAVINGS_KEY,
    (sget(PRESENTED_SAVINGS_KEY, []) || []).map((r) =>
      String(r.projectId) === String(projId) &&
      r.periodStart === rec.periodStart &&
      r.periodEnd === rec.periodEnd
        ? Object.assign({}, r, { pdfKey: String(pdfKey), pdfName: pdfName || "" })
        : r,
    ),
  );
  return true;
}

function removePresentedMark(projId, yms) {
  const rec = getPresentedRecordFor(projId, yms);
  if (!rec) return false;
  sset(
    PRESENTED_SAVINGS_KEY,
    (sget(PRESENTED_SAVINGS_KEY, []) || []).filter(
      (r) =>
        !(
          String(r.projectId) === String(projId) &&
          r.periodStart === rec.periodStart &&
          r.periodEnd === rec.periodEnd
        ),
    ),
  );
  return true;
}

// CSV of printed figures: rows "building,figure,value". figure = savings_dollars | kwh_saved |
// therms_saved | gallons_saved | electric_savings_dollars | gas_savings_dollars | propane_savings_dollars,
// or printed:<section>|<commodity>|<month>|<column> for any other printed figure (number or text; `printed`
// in the result; the building column is a building name or the printed row label). A building named "Portfolio total" (or "Total") holds the printed
// portfolio total. `bldgs` = [{id, name}] of the project. Returns
// { buildings: {<id>: {...}}, totalDollars, unmatched: [names], bad: [lines] }.
function parsePresentedCsv(text, bldgs) {
  const FIELD = {
    savings_dollars: "dollars",
    kwh_saved: "kwhSaved",
    therms_saved: "thermsSaved",
    gallons_saved: "gallonsSaved",
    electric_savings_dollars: "elecDollars",
    gas_savings_dollars: "gasDollars",
    propane_savings_dollars: "propaneDollars",
  };
  const out = { buildings: {}, totalDollars: null, printed: {}, unmatched: [], bad: [] };
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase();
  String(text || "")
    .split(/\r?\n/)
    .forEach((line) => {
      if (!line.trim()) return;
      const cells = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) {
          cells.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      cells.push(cur.trim());
      if (cells.length < 3) return void out.bad.push(line);
      const [name, fig, val] = cells;
      if (norm(fig) === "figure") return;
      if (/^printed:/i.test(fig)) {
        // printed:<section>|<commodity>|<month>|<column>  (any other figure of the printed document)
        const parts = fig.replace(/^printed:/i, "").split("|");
        if (parts.length !== 4) return void out.bad.push(line);
        const pb = (bldgs || []).find((x) => norm(x.name) === norm(name));
        const pnum = typeof parseBillNumber === "function" ? parseBillNumber(val) : parseFloat(val);
        const isNum = /^[-+]?[\d,]*\.?\d+$/.test(String(val).trim());
        out.printed[
          presentedPrintedKey(parts[0], pb ? pb.id : name, parts[1], parts[2], parts[3])
        ] = isNum && Number.isFinite(pnum) ? pnum : val;
        return;
      }
      const field = FIELD[norm(fig)];
      const num =
        typeof parseBillNumber === "function"
          ? parseBillNumber(val)
          : parseFloat(val);
      if (!field || !Number.isFinite(num)) return void out.bad.push(line);
      if (norm(name) === "portfolio total" || norm(name) === "total") {
        if (field === "dollars") out.totalDollars = num;
        else out.bad.push(line);
        return;
      }
      const b = (bldgs || []).find((x) => norm(x.name) === norm(name));
      if (!b) {
        if (out.unmatched.indexOf(name) < 0) out.unmatched.push(name);
        return;
      }
      (out.buildings[b.id] = out.buildings[b.id] || {})[field] = num;
    });
  return out;
}


/* ─────────────────────────────────────────────────────────────
   Savings Methods comparison (Matt, 2026-11-03) - Project > Performance, NEVER in a report, export, portal or print.
   Two ways to read the same months, both (baseline - bill) x that month's rate, summed:
     Contract method (billed): the bill as it is. getMeterSavings, unchanged.
     Bills normalized for weather and dates (comparison only): the SAME baseline; the post-baseline bills are prorated to
       calendar months (getNormRows), fitted (computeMeterRegression) and read at the baseline weather of the month
       (normalizedBillsAtBaselineWeather). getMeterSavings with the option normalizedBills. Same baseline, same rate, same months.
   No second regression and no second rate. Nothing here is billed.
───────────────────────────────────────────────────────────── */
// getMeterSavingsComparison(m, bills, incl, projId, bldgId) -> [{ ym, waiting, contract:{E,K}, normalized:{E,K} }]
// E = kWh / therms / gallons dollars, K = kW demand dollars. One entry per post-baseline month with bills.
function getMeterSavingsComparison(m, bills, incl, projId, bldgId) {
  const con = getMeterSavings(m, bills, incl, projId, bldgId).rows;
  const nrm = getMeterSavings(m, bills, incl, projId, bldgId, { normalizedBills: true }).rows;
  const split = (r) => ({ E: (r.kwhCostSav || 0) + (r.unitCostSav || 0), K: r.kwCostSav || 0 });
  return con
    .filter((r) => r.normDays != null)
    .map((r) => {
      const n = nrm.find((x) => x.ym === r.ym && x.normDays != null);
      return { ym: r.ym, waiting: !!r.weatherMissing, contract: split(r), normalized: n ? split(n) : split(r) };
    });
}

// getProjectSavingsComparison(projId) -> null (no contract) or { years: [{ year, quarters:[{ key, label, months:[ym],
//   monthly:{ym:{contract,normalized}}, waiting:[ym], contract:{raw, billed, E, K}, normalized:{raw, E, K} }],
//   total:{ contractRaw, contractBilled, normalizedRaw } }] }  newest year and quarter first.
// raw = the quarter before the $0 floor. billed = billableSavingsWithPresented for the quarter (the printed figure for a
// presented quarter, floored at $0). A quarter with a month waiting for weather has no figures. Years come from the data.
function getProjectSavingsComparison(projId) {
  if (!projHasContract(projId)) return null;
  const proj = (typeof projects !== 'undefined' ? projects : []).find((p) => String(p.id) === String(projId));
  const incl = (proj && proj.inclMonths) || {};
  const qs = {};
  getUDBldgs(projId).forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id) || !isCalcCommodity(projId, m.commodity)) return;
      const bills = (m.bills || []).slice().sort((x, y) => (x.start || '').localeCompare(y.start || ''));
      getMeterSavingsComparison(m, bills, incl, projId, b.id).forEach((r) => {
        const key = quarterKeyOfYM(r.ym);
        const q = (qs[key] = qs[key] || { key, months: [], monthly: {}, waiting: [], contract: { E: 0, K: 0 }, normalized: { E: 0, K: 0 } });
        if (!q.months.includes(r.ym)) q.months.push(r.ym);
        const mo = (q.monthly[r.ym] = q.monthly[r.ym] || { contract: 0, normalized: 0 });
        if (r.waiting) {
          if (!q.waiting.includes(r.ym)) q.waiting.push(r.ym);
          return;
        }
        ['E', 'K'].forEach((k) => {
          q.contract[k] += r.contract[k];
          q.normalized[k] += r.normalized[k];
        });
        mo.contract += r.contract.E + r.contract.K;
        mo.normalized += r.normalized.E + r.normalized.K;
      });
    });
  });
  // The billed side reads the site's own monthly savings (getBuildingSavingsByYM), as every page does.
  const perBldg = {};
  getUDBldgs(projId).forEach((b) => (perBldg[b.id] = getBuildingSavingsByYM(b, projId)));
  const years = {};
  Object.values(qs)
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .forEach((q) => {
      q.months.sort();
      q.waiting.sort();
      q.label = q.key.replace('-Q', ' Q');
      const yms = [1, 2, 3].map((k) => q.key.slice(0, 4) + '-' + String((Number(q.key.slice(6)) - 1) * 3 + k).padStart(2, '0'));
      q.contract.raw = q.contract.E + q.contract.K;
      q.normalized.raw = q.normalized.E + q.normalized.K;
      q.contract.billed = q.waiting.length ? null : billableSavingsWithPresented(projId, yms, perBldg).total;
      const y = (years[q.key.slice(0, 4)] = years[q.key.slice(0, 4)] || { year: q.key.slice(0, 4), quarters: [], total: { contractRaw: 0, contractBilled: 0, normalizedRaw: 0, waiting: [] } });
      y.quarters.push(q);
      if (q.waiting.length) {
        y.total.waiting.push(q.label);
        return;
      }
      y.total.contractRaw += q.contract.raw;
      y.total.contractBilled += q.contract.billed;
      y.total.normalizedRaw += q.normalized.raw;
    });
  return { years: Object.values(years).sort((a, b) => (a.year < b.year ? 1 : -1)) };
}
