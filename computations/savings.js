// computations/savings.js — Unified savings computation (canonical source)
// Depends on: normalization.js (getNormRows, buildMoMap, billMonth), regression.js (computeKwCddRegression),
//             rates.js (getStoredRate, getStoredKwRate), and getWeatherForBuilding() (still in energy-department.html)

// SAVINGS_CALC_VERSION — bump this any time the savings math in this file changes.
// It is folded into the _savingsCache fingerprint (_blFp) below so a code deploy
// invalidates every browser's stale in-memory cache instead of requiring a manual
// clear or an unrelated data edit to bust it. CH_VERSION (site-ui.js) is not
// reachable here (scoped inside an IIFE, not exposed on window), so this file
// carries its own version marker.
const SAVINGS_CALC_VERSION = '2026.10.31.rptwx2';

/* ─────────────────────────────────────────────────────────────
   Expected (baseline) usage for a meter-month - THE one rule (Matt, 2026-10-31).
   From REPORTING_WEATHER_FROM_YM on (Q3-2026), the baseline regression is evaluated at the weather of
   the month being reported (IPMVP avoided energy), for kWh, therms, gallons and kW alike. A month whose
   weather is not yet available has NO expected usage: it is flagged weatherMissing and left out of the
   savings until weather exists - never read as 0 degree days. Months before that (the quarters already
   presented) keep the earlier rule: baseline-year calendar-month value, else regression, else average.
   Callers: getMeterSavings (below) and, through its rows, every report and page.
───────────────────────────────────────────────────────────── */
const REPORTING_WEATHER_FROM_YM = '2026-07';

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
//   ctx: { blByCalMo, blAvg, weatherDriven, hasRegr }  (blByCalMo from baselineUsageByCalMo; weatherDriven = an
//        energy meter - Electric, Gas, Propane - the only meters whose dollars weather decides; hasRegr = the
//        meter has a fitted baseline regression, so a month without weather cannot be evaluated;
//        allMonthsAtReportingWeather = apply the contract rule to every month - only the internal
//        savings-methods view sets it, see getMeterSavingsMethods)
function expectedUsageForMonth(row, ctx) {
  if (ctx.weatherDriven && ctx.hasRegr && (ctx.allMonthsAtReportingWeather || row.ym >= REPORTING_WEATHER_FROM_YM)) {
    // One missing of HDD / CDD is a missing month: never fall back to the baseline-year weather.
    if (row.hdd == null || row.cdd == null) return { usage: null, weatherMissing: true };
    if (row.regrBaseline != null) return { usage: row.regrBaseline, weatherMissing: false };
  }
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

/* ─────────────────────────────────────────────────────────────
   projHasContract(projId)
   Single source of truth: does this project have a Service
   Agreement (sa) number? No SA means no savings/compensation
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
     incompleteYM: {YYYY-MM: {commodity, reason}},
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
  // signal is the project record's `sa` field (Service Agreement #) - a project with no SA
  // (Client C, Client D, Client E: sa="") must show ZERO savings everywhere, not a phantom
  // number from a bill that happens to look complete. String(x.id) === String(projId) is
  // required because some callers pass projId as a String while projects[].id
  // are numbers - a strict === here would silently fail that caller.
  const _proj =
    typeof projects !== "undefined"
      ? projects.find((x) => String(x.id) === String(projId))
      : null;
  const hasContract = !!(_proj && _proj.sa);

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
  const cacheKey =
    "v3|p:" +
    projId +
    "|sa:" +
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
    "|" +
    _blFp;
  if (!opts.effectiveRows && !opts.allMonthsAtReportingWeather && m._savingsCache && m._savingsCacheKey === cacheKey)
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

  const isElec = m.commodity === "Electric";
  const isGas = m.commodity === "Gas";
  const isPropane = m.commodity === "Propane";
  const { byYm: weatherByYm } = getWeatherForBuilding(projId, bldgId);
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
    if (!opts.effectiveRows && !opts.allMonthsAtReportingWeather) {
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
  const blDemKWByCalMo = {};
  if (isElec)
    Object.entries(eMo).forEach(([mo, v]) => {
      blDemKWByCalMo[mo] = v.billedKW || v.demandKW || 0;
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

  // Fitted baseline kW at the baseline-year weather for a calendar month (average over the baseline years).
  const _blFitKWOf = (calMo) => {
    const v = bl.months
      .filter((ym) => parseInt(ym.split("-")[1]) - 1 === calMo)
      .map((ym) => _kwNormByYm[ym])
      .filter((x) => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  // Propane raw baseline-year gallons for a calendar month: the same spread usage the actual months use (row.usage),
  // not the weather-fitted value pMo holds. Average over the baseline years.
  const _blRawPropane = (calMo) => {
    const v = blRows.filter((r) => parseInt(r.ym.split("-")[1]) - 1 === calMo).map((r) => r.usage);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  // The ONE baseline-usage rule for a month: expectedUsageForMonth (above). Used by every row,
  // including pinned rows below.
  const expCtx = {
    blByCalMo,
    blAvg,
    weatherDriven: isElec || isGas || isPropane,
    hasRegr: hasRegrP,
    allMonthsAtReportingWeather: !!opts.allMonthsAtReportingWeather,
  };

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
        incompleteYM[r.ym] = { commodity: m.commodity, reason: _wxReason };
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
      const kwhSaved = expUsage - actKwh;
      kwhCostSav = kwhRate > 0 ? kwhSaved * kwhRate : 0;
      blExpKW =
        _kwNormByYm[r.ym] != null
          ? _kwNormByYm[r.ym]
          : blDemKWByCalMo[calMo] || 0;
      actBilKW = Math.max(
        ...bfr.map((b) => parseBillNumberOrZero(b.billedKW) || parseBillNumberOrZero(b.demandKW)),
      );
      actDemKW = Math.max(...bfr.map((b) => parseBillNumberOrZero(b.demandKW)));
      // getStoredKwRate() (computations/rates.js) is the ONE $/kW rate: stored totalKwRate,
      // else demand dollars / billed kW (see its header).
      moKwRate = getMonthBillRate(bfr, "kw");
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
      totalCostSav = galRate > 0 ? (expUsage - actGallons) * galRate : 0;
      unitCostSav = totalCostSav;
      unitSav.gallons = galRate > 0 ? expUsage - actGallons : 0;
    } else {
      const actTherms = actUsage;
      // getBillGasCost (computations/rates.js) — the ONE gas cost accessor (visible Gas Charge).
      const actThermCost = bfr.reduce((s, b) => s + getBillGasCost(b), 0);
      // Rate of this month's bill(s): getMonthBillRate (computations/rates.js), usage-weighted; blank
      // bills left out, not counted as 0 - math-02 M1. Only a Gas meter derives a rate from the
      // bill's gas fields; this branch also runs for Water/Sewer/Stormwater/Steam meters.
      const _sGasRate = isGas ? getMonthBillRate(bfr, "gas") : 0;
      const thermRate =
        _sGasRate ||
        (actTherms > 0 && actThermCost > 0 ? actThermCost / actTherms : 0);
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
      totalCostSav = thermRate > 0 ? (expUsage - actTherms) * thermRate : 0;
      unitCostSav = totalCostSav;
      unitSav.therms = thermRate > 0 ? expUsage - actTherms : 0;
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
      pinned: hasContract && _costOvr != null,
      rateIncomplete: hasContract && flagIncomplete,
      rateReason: hasContract && flagIncomplete ? _rateReason : "",
      // Baseline-year references for the same calendar month (read by getMeterSavingsMethods only):
      // raw billed usage / peak kW, and the fitted values at the baseline-year weather.
      blRawUsage: isElec ? (eMo[calMo] || {}).kwh : isGas ? (gMo[calMo] || {}).therms : isPropane ? _blRawPropane(calMo) : null,
      blFitUsage: blByCalMo[calMo] != null ? blByCalMo[calMo] : null,
      blRawKW: isElec ? blDemKWByCalMo[calMo] || 0 : 0,
      blFitKW: isElec ? _blFitKWOf(calMo) : null,
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
  };
  if (!opts.effectiveRows && !opts.allMonthsAtReportingWeather) {
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
// Returns { total, byBldg, applied, missing, weatherWaiting }. byBldg stays the NET per-building sum over the other yms (building
// rows are not floored). Monthly and per-meter values are never floored.
function billableSavingsWithPresented(projId, yms, perBldg) {
  const byQtr = {};
  yms.forEach((y) => (byQtr[quarterKeyOfYM(y)] = byQtr[quarterKeyOfYM(y)] || []).push(y));
  const wx = _weatherSplit(projId, yms);
  const net = totalSavingsWithPresented(projId, wx.open, perBldg);
  let total = 0;
  const missing = {};
  Object.keys(byQtr).forEach((q) => {
    const gaps = quarterMissingBills(projId, q);
    if (gaps.length) missing[q] = gaps;
    if (wx.waiting[q]) return; // no weather for a month: no figure for the quarter, never floored or billed
    total += floorQuarterSavings(totalSavingsWithPresented(projId, byQtr[q], perBldg).total);
  });
  return { total, byBldg: net.byBldg, applied: net.applied, missing, weatherWaiting: wx.waiting };
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
   Internal savings methods (Matt, 2026-11-01) - NEVER shown to a client, never in a report or export.
   Four ways to read the same month, all (baseline - actual) x this month's rate, then summed:
     M1 raw baseline-year billed         vs raw actual
     M2 fitted baseline, baseline weather vs raw actual
     M3 raw baseline-year billed         vs actual moved to baseline weather
     M4 fitted baseline, actual weather  vs raw actual   = the contract method (getMeterSavings rule)
   The fitted values are the row fields of getMeterSavings (expUsage, blExpKW, blFitUsage, blFitKW): no
   second regression, no second rate. Bridge: M4 = M1 + fit gap (M2 - M1) + weather credit (M4 - M2).
───────────────────────────────────────────────────────────── */
// savingsMethodsForRow(row, isElec) -> { waiting:true } when the month has no weather yet (never 0),
// else { E:{m1,m2,m3,m4}, K:{m1,m2,m3,m4} } in dollars (E = kWh / therms / gallons, K = kW demand).
function savingsMethodsForRow(row, isElec) {
  if (row.weatherMissing) return { waiting: true };
  const E = { m1: 0, m2: 0, m3: 0, m4: 0 };
  const K = { m1: 0, m2: 0, m3: 0, m4: 0 };
  const rate = isElec ? row.kwhRate : row.unitRate;
  const act = row.actUsage;
  if (rate > 0 && act != null) {
    const fit26 = row.expUsage;
    const fit25 = row.blFitUsage;
    const raw25 = row.blRawUsage;
    if (raw25 != null) E.m1 = (raw25 - act) * rate;
    if (fit25 != null) E.m2 = (fit25 - act) * rate;
    if (raw25 != null && fit25 != null) E.m3 = (raw25 - (act - (fit26 - fit25))) * rate;
    E.m4 = (fit26 - act) * rate;
  }
  if (isElec && row.kwRate > 0) {
    const kwAct = row.bilKW;
    if (row.blRawKW > 0) K.m1 = (row.blRawKW - kwAct) * row.kwRate;
    if (row.blFitKW != null) K.m2 = (row.blFitKW - kwAct) * row.kwRate;
    if (row.blRawKW > 0 && row.blFitKW != null) K.m3 = (row.blRawKW - (kwAct - (row.blExpKW - row.blFitKW))) * row.kwRate;
    if (row.blExpKW > 0) K.m4 = (row.blExpKW - kwAct) * row.kwRate;
  }
  return { E, K };
}

// getMeterSavingsMethods(m, bills, incl, projId, bldgId) -> [{ ym, isElec, ...savingsMethodsForRow }]
// One entry per post-baseline month with bills. The contract rule runs on every month (not only Q3-2026 on).
function getMeterSavingsMethods(m, bills, incl, projId, bldgId) {
  const isElec = m.commodity === 'Electric';
  const sav = getMeterSavings(m, bills, incl, projId, bldgId, { allMonthsAtReportingWeather: true });
  return sav.rows
    .filter((r) => r.blRawUsage !== undefined || r.weatherMissing)
    .map((r) => Object.assign({ ym: r.ym, isElec }, savingsMethodsForRow(r, isElec)));
}

// getProjectSavingsMethods(projId) -> null (no contract) or
//   { quarters: [{ key, label, months:[ym], buildings:[{ id, name, waiting:[ym], E:{m1..m4}, K:{m1..m4} }], total }] }
// Newest quarter first. A building with a month still waiting for weather has waiting.length > 0.
function getProjectSavingsMethods(projId) {
  if (!projHasContract(projId)) return null;
  const qOf = (ym) => ym.slice(0, 4) + '-Q' + (Math.floor((parseInt(ym.slice(5, 7)) - 1) / 3) + 1);
  const add = (a, b) => ['m1', 'm2', 'm3', 'm4'].forEach((k) => (a[k] += b[k]));
  const mk = () => ({ m1: 0, m2: 0, m3: 0, m4: 0 });
  const proj = (typeof projects !== 'undefined' ? projects : []).find((p) => String(p.id) === String(projId));
  const incl = (proj && proj.inclMonths) || {};
  const qs = {};
  getUDBldgs(projId).forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id) || !isCalcCommodity(projId, m.commodity)) return;
      const bills = (m.bills || []).slice().sort((x, y) => (x.start || '').localeCompare(y.start || ''));
      getMeterSavingsMethods(m, bills, incl, projId, b.id).forEach((r) => {
        const key = qOf(r.ym);
        const q = (qs[key] = qs[key] || { key, months: [], bldgs: {} });
        if (!q.months.includes(r.ym)) q.months.push(r.ym);
        const bl = (q.bldgs[b.id] = q.bldgs[b.id] || { id: b.id, name: b.name, waiting: [], E: mk(), K: mk() });
        if (r.waiting) {
          if (!bl.waiting.includes(r.ym)) bl.waiting.push(r.ym);
          return;
        }
        add(bl.E, r.E);
        add(bl.K, r.K);
      });
    });
  });
  const quarters = Object.values(qs)
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .map((q) => {
      q.months.sort();
      const buildings = Object.values(q.bldgs).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const total = { waiting: [], E: mk(), K: mk() };
      buildings.forEach((bl) => {
        add(total.E, bl.E);
        add(total.K, bl.K);
        bl.waiting.forEach((ym) => total.waiting.includes(ym) || total.waiting.push(ym));
      });
      total.waiting.sort();
      return { key: q.key, label: q.key.replace('-Q', ' Q'), months: q.months, buildings, total };
    });
  return { quarters };
}

// smProjectMethods(quarters, project) - the 3-year projection of each method (internal panel).
// It adds NO projection rule: each method's completed quarters (each floored at $0, floorQuarterSavings, the
// same floor billing uses) become the quarterlyActuals of the ONE shared projection, which `project(acts, q)`
// runs (_rptContractProjection -> computeContractProjection, the call every report page prints).
// billedOf(q) -> the site's billed dollars for quarter q (M4 only; omit to use the recomputed M4).
// A quarter is complete when it has 3 billed months and none waits for weather; others are left out and named.
// Returns null (no complete quarter) or { year, quarter, excluded:[{label, why}], rows:[{ k, toDate, remaining,
// total, target }] }  toDate = all complete quarters; remaining = total - toDate; target = the contract target.
function smProjectMethods(quarters, project, billedOf) {
  const done = quarters.filter((q) => q.months.length === 3 && !q.total.waiting.length);
  if (!done.length) return null;
  const excluded = quarters
    .filter((q) => done.indexOf(q) < 0)
    .map((q) => ({ label: q.label, why: q.total.waiting.length ? 'waiting for weather' : q.months.length + ' of 3 months billed' }));
  const last = done.slice().sort((a, b) => (a.key < b.key ? 1 : -1))[0]; // newest complete quarter
  const year = last.key.slice(0, 4);
  const qNum = Number(last.key.slice(6));
  const byKey = {};
  done.forEach((q) => (byKey[q.key] = q));
  const rows = ['m1', 'm2', 'm3', 'm4'].map((k) => {
    // M4 is the contract method: its quarter is the billed figure the site uses (billedOf; a presented quarter keeps
    // its printed figure). M1 to M3 are the recomputed quarters, floored at $0.
    const val = (q) => (k === 'm4' && billedOf ? billedOf(q) : floorQuarterSavings(q.total.E[k] + q.total.K[k]));
    const acts = [null, null, null, null];
    for (let i = 0; i < qNum; i++) acts[i] = byKey[year + '-Q' + (i + 1)] ? val(byKey[year + '-Q' + (i + 1)]) : 0;
    const proj = project(acts, qNum);
    const toDate = done.reduce((s, q) => s + val(q), 0);
    return { k, toDate, remaining: proj.totalSavings - toDate, total: proj.totalSavings, target: proj.targetOnly.totalSavings };
  });
  return { year, quarter: qNum, excluded, rows };
}

// getProjectSavingsMethodsProjection(projId, data) -> smProjectMethods(...) with the project's own contract
// (term, years, escalation, targets, split) read by collectReportData, the data every report page prints.
function getProjectSavingsMethodsProjection(projId, data) {
  const done = data.quarters.filter((q) => q.months.length === 3 && !q.total.waiting.length);
  if (!done.length) return null;
  const last = done.slice().sort((a, b) => (a.key < b.key ? 1 : -1))[0];
  const ids = getUDBldgs(projId).map((b) => String(b.id));
  const rd = (q) => collectReportData(projId, ids, null, 'quarterly', { quarter: Number(q.key.slice(6)), year: Number(q.key.slice(0, 4)), _noQuarterlyActuals: true });
  const d = rd(last);
  if (!d) return null;
  return smProjectMethods(data.quarters, (acts, q) =>
    _rptContractProjection({
      contract: Object.assign({}, d.contract, { quarterlyActuals: acts, actualsThroughQuarter: q }),
      period: { quarter: q },
    }),
    (q) => floorQuarterSavings(rd(q).totals.savings), // the site's billed quarter (totals.savings is already billable)
  );
}
