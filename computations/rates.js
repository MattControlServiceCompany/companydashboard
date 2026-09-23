// computations/rates.js — Rate lookup and validation (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

// ── RATE GUARDRAILS — validates implied rate (charge ÷ usage) for all commodity types ──
var KNOWN_RATES = {
  Electric: {
    kWh: { typical: 0.1, unit: '$/kWh', min: 0.01, max: 1.0 },
    kW: { typical: 10.0, unit: '$/kW', min: 1.0, max: 100.0 },
  },
  Gas: {
    therm: { typical: 0.798, unit: '$/Therm', min: 0.08, max: 8.0 },
  },
  Propane: {
    gallon: { typical: 2.5, unit: '$/Gal', min: 0.25, max: 25.0 },
  },
  Water: {
    unit: { typical: 5.0, unit: '$/1000gal', min: 0.5, max: 50.0 },
  },
  Sewer: {
    unit: { typical: 8.0, unit: '$/1000gal', min: 0.8, max: 80.0 },
  },
};

// New canonical function for rate lookup
function getStoredRate(bill, type) {
  switch (type) {
    case 'kwh': {
      var stored = parseFloat(bill.totalKwhRate);
      if (stored > 0) return stored;
      var usage = parseFloat(bill.kWhConsumed) || parseFloat(bill.totalKwh) || parseFloat(bill.kwh) || 0;
      // CSV-imported bills (BILL_SCHEMA.Electric, app/csv-import.js) use camelCase
      // onPeakCost/offPeakCost instead of the PDF extractor's kwhCost — fall back to
      // their sum so CSV-imported electric bills derive a real $/kWh (item 2026-09-21
      // rate-calc-and-electric-components.md gap #2).
      var cost =
        parseFloat(bill.kwhCost) || (parseFloat(bill.onPeakCost) || 0) + (parseFloat(bill.offPeakCost) || 0) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'kw': {
      var stored = parseFloat(bill.totalKwRate);
      if (stored > 0) return stored;
      var usage =
        parseFloat(bill.BilledKW) ||
        parseFloat(bill.ActualKW) ||
        parseFloat(bill.FacilitiesKW) ||
        parseFloat(bill.billedKW) ||
        parseFloat(bill.demandKW) ||
        0;
      // CSV-imported bills store demand $ under camelCase demandCharge/facilitiesCharge/
      // facKWCost/tdcCharge instead of the PDF extractor's kwCost — sum those as the
      // fallback so CSV-imported electric bills derive a real $/kW.
      var cost =
        parseFloat(bill.kwCost) ||
        (parseFloat(bill.demandCharge) || 0) +
          (parseFloat(bill.facilitiesCharge || bill.facKWCost) || 0) +
          (parseFloat(bill.tdcCharge) || 0) ||
        0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'gas': {
      var stored = parseFloat(bill.totalGasRate);
      if (stored > 0) return stored;
      var cost =
        parseFloat(bill.GasCharge) ||
        parseFloat(bill.gasCharge) ||
        parseFloat(bill.thermCost) ||
        parseFloat(bill.totalCost) ||
        0;
      // 2026-09-23 (item 2026-09-23-gas-rate-fix): route usage through the single canonical
      // resolveGasUsageTherms() (computations/savings.js) instead of a second, duplicate
      // PascalCase-only Therms/CCF check + a separate MMBtu-fallback that divided cost by raw
      // naturalGasMMbtu (a $/MMBtu number, not $/Therm — see ensureBillRates below, the
      // companyhub-single-rate-source-and-gas-mmbtu-bug.md wiki article). resolveGasUsageTherms
      // already converts naturalGasMMbtu x10 to a Therms-equivalent, so this always returns
      // $/Therm regardless of which usage field a bill actually carries.
      var usage = typeof resolveGasUsageTherms === 'function' ? resolveGasUsageTherms(bill) : 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'propane': {
      var stored = parseFloat(bill.totalPropaneRate);
      if (stored > 0) return stored;
      var cost = parseFloat(bill.totalCost) || parseFloat(bill.TotalAmountDue) || 0;
      var usage = parseFloat(bill.GallonsDelivered) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'water': {
      var stored = parseFloat(bill.totalWaterRate);
      if (stored > 0) return stored;
      var cost = parseFloat(bill.WaterCharge) || parseFloat(bill.totalCost) || 0;
      var usage = parseFloat(bill.WaterUsage) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'sewer': {
      var stored = parseFloat(bill.totalSewerRate);
      if (stored > 0) return stored;
      return 0;
    }
    default:
      return 0;
  }
}

// getStoredKwRate(bill) — canonical $/kW (demand) rate for ONE bill.
// SSOT for the Bills table, Meter Performance, and the savings engine (all three must
// return the same number for the same bill — see missing-rate-cascade.md step 1).
// Bug (2026-09-10, Circle Grove 2026-05): savings.js and perf-table.js both derived
// $/kW purely from (bill.kwCost + bill.facKWCost) / billedKW. Newer-schema bills store
// the same dollars under granular fields (demandCharge, tdcCharge, facilitiesCharge)
// instead — kwCost/facKWCost are blank on those bills — so the blind sum silently
// produced 0 even though the bill's own totalKwRate (and the Bills table, which already
// reads demandCharge+tdcCharge+facilitiesCharge — app/utility-data.js ~2842-2846) had a
// real rate. Precedence: stored totalKwRate first (cheapest, already validated at save
// time by ensureBillRates), then the granular charge fields, then the legacy
// kwCost+facKWCost sum for older-schema bills that only ever populated those two fields.
function getStoredKwRate(bill) {
  var pf = function (v) {
    return parseFloat(v) || 0;
  };
  var stored = pf(bill.totalKwRate);
  if (stored > 0) return stored;
  var billedKW = pf(bill.billedKW) || pf(bill.demandKW) || 0;
  if (billedKW > 0) {
    var granularCost = pf(bill.demandCharge) + pf(bill.tdcCharge) + pf(bill.facilitiesCharge || bill.facKWCost);
    if (granularCost > 0) return granularCost / billedKW;
    var legacyCost = pf(bill.kwCost) + pf(bill.facKWCost);
    if (legacyCost > 0) return legacyCost / billedKW;
  }
  return 0;
}

// Populate missing derived rate fields on a bill from its usage + cost data.
// Returns true if any field was added/updated, false if bill was already complete.
function ensureBillRates(bill) {
  var changed = false;
  var pf = function (v) {
    return parseFloat(v) || 0;
  };

  // Electric: totalKwhRate
  if (!pf(bill.totalKwhRate)) {
    var kwh = pf(bill.kWhConsumed) || pf(bill.totalKwh) || pf(bill.kwh);
    var kwhCost = pf(bill.kwhCost);
    if (kwh > 0 && kwhCost > 0) {
      bill.totalKwhRate = (kwhCost / kwh).toFixed(5);
      changed = true;
    }
  }

  // Electric: totalKwRate (includes facKWCost — the full per-kW cost)
  if (!pf(bill.totalKwRate)) {
    var kw = pf(bill.BilledKW) || pf(bill.billedKW) || pf(bill.ActualKW) || pf(bill.demandKW) || pf(bill.FacilitiesKW);
    var kwCost = pf(bill.kwCost) + pf(bill.facKWCost);
    if (kw > 0 && kwCost > 0) {
      bill.totalKwRate = (kwCost / kw).toFixed(5);
      changed = true;
    }
  }

  // Gas: totalGasRate (use gasCharge/commodity cost, not total bill cost — bug d4c78f06)
  if (!pf(bill.totalGasRate)) {
    // 2026-09-23 (item 2026-09-23-gas-rate-fix): was a PascalCase-only Therms/CCF check with a
    // separate MMBtu fallback that stored cost/naturalGasMMbtu — a $/MMBtu number — in this same
    // field, mislabeled as $/Therm, for any MMBtu-only meter (e.g. WRE bills, no
    // NaturalGasTherms/NaturalGasCCF). Confirmed 6-16x too high on Spring Hill High. Now routes
    // through resolveGasUsageTherms(bill) — the same canonical Therms-usage resolver
    // computeSeasonalBldgRates uses (computations/savings.js) — so this always writes a real
    // $/Therm value, one usage definition, no duplicate math.
    var gasChg = pf(bill.GasCharge) || pf(bill.gasCharge) || pf(bill.thermCost);
    var gasUsage = typeof resolveGasUsageTherms === 'function' ? resolveGasUsageTherms(bill) : 0;
    if (gasUsage > 0 && gasChg > 0) {
      bill.totalGasRate = (gasChg / gasUsage).toFixed(5);
      changed = true;
    }
  }

  // Propane: totalPropaneRate (prefer unitPrice if available)
  if (!pf(bill.totalPropaneRate)) {
    var up = pf(bill.UnitPrice) || pf(bill.unitPrice);
    if (up > 0) {
      bill.totalPropaneRate = up.toFixed(5);
      changed = true;
    } else {
      var gal = pf(bill.GallonsDelivered) || pf(bill.gallonsDelivered);
      var propCost = pf(bill.totalCost) || pf(bill.TotalAmountDue);
      if (gal > 0 && propCost > 0) {
        bill.totalPropaneRate = (propCost / gal).toFixed(5);
        changed = true;
      }
    }
  }

  // Water: totalWaterRate
  if (!pf(bill.totalWaterRate)) {
    var wUsage = pf(bill.WaterUsage) || pf(bill.waterUsage);
    var wChg = pf(bill.WaterCharge) || pf(bill.waterCharge);
    if (wUsage > 0 && wChg > 0) {
      bill.totalWaterRate = (wChg / wUsage).toFixed(5);
      changed = true;
    }
  }

  // Sewer: totalSewerRate
  if (!pf(bill.totalSewerRate)) {
    var sUsage = pf(bill.SewerUsage) || pf(bill.sewerUsage);
    var sChg = pf(bill.SewerCharge) || pf(bill.sewerCharge);
    if (sUsage > 0 && sChg > 0) {
      bill.totalSewerRate = (sChg / sUsage).toFixed(5);
      changed = true;
    }
  }

  return changed;
}

function validateImpliedRate(commodity, usage, charge, utilityName) {
  if (!usage || !charge || usage === 0) return null;
  const implied = Math.abs(charge / usage);
  const commRates = KNOWN_RATES[(commodity || '').charAt(0).toUpperCase() + (commodity || '').slice(1).toLowerCase()];
  if (!commRates) return null;
  const rateKey = Object.keys(commRates)[0];
  const expected = commRates[rateKey];
  if (!expected) return null;

  // Use utility-specific override if available (e.g. Louisburg gas)
  let expMin = expected.min,
    expMax = expected.max,
    expTypical = expected.typical;
  if ((commodity || '').toLowerCase() === 'gas' && utilityName && /louisburg/i.test(utilityName)) {
    const lbgRate = _LBG_GAS_RATES[0].rate;
    expTypical = lbgRate;
    expMin = lbgRate / 10;
    expMax = lbgRate * 10;
  }

  let severity = null;
  if (implied < expMin || implied > expMax) {
    severity = 'error';
  } else if (implied < expTypical / 3 || implied > expTypical * 3) {
    severity = 'warn';
  } else if (implied < expTypical / 1.5 || implied > expTypical * 1.5) {
    severity = 'info';
  }

  return {
    valid: severity === null,
    implied: implied,
    typical: expTypical,
    min: expMin,
    max: expMax,
    unit: expected.unit,
    severity: severity,
  };
}

function toKBtu(kwh, therms, gallons) {
  return (parseFloat(kwh) || 0) * 3.412 + (parseFloat(therms) || 0) * 100 + (parseFloat(gallons) || 0) * 91.5;
}

// Canonical electric energy-charge sum — the 5 charge fields that make up the
// implied $/kWh rate (OnPeak + OffPeak + ECA + EER + PTS). SSOT for
// getExtractedRate('kwh'), validateBillData's electric branch, and
// detectStatisticalOutliers's electric rate check (bill-analysis.js) — all
// three must sum the same fields or a bill's "checked" rate can disagree with
// its "displayed" rate and false-flag a valid bill (item 377ea7f0).
function sumElectricEnergyCharges(parsed) {
  var pf = function (v) {
    return parseFloat(v) || 0;
  };
  parsed = parsed || {};
  return (
    pf(parsed.EnergyOnPeakCharge) +
    pf(parsed.EnergyOffPeakCharge) +
    pf(parsed.ECACharge) +
    pf(parsed.EERCharge) +
    pf(parsed.PTSCharge)
  );
}

function getExtractedRate(parsed, type) {
  var pf = function (v) {
    return parseFloat(v) || 0;
  };
  switch (type) {
    case 'kwh': {
      var cost = sumElectricEnergyCharges(parsed);
      var usage = pf(parsed.kWhConsumed);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'kw': {
      var cost = pf(parsed.FacilitiesCharge) + pf(parsed.BilledKWCharge) + pf(parsed.TDCCharge);
      var usage = pf(parsed.BilledKW) || pf(parsed.ActualKW) || pf(parsed.FacilitiesKW);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'gas': {
      var cost = pf(parsed.GasCharge) || pf(parsed.gasCharge) || pf(parsed.thermCost) || pf(parsed.totalCost) || 0;
      var usage = pf(parsed.NaturalGasTherms) || 0;
      if (!usage) {
        var ccf = pf(parsed.NaturalGasCCF) || 0;
        if (ccf > 0) usage = Math.round(ccf * 1.037 * 100) / 100;
      }
      if (usage > 0 && cost > 0) return cost / usage;
      // MMBtu fallback: WRE meters store usage as naturalGasMMbtu; divide charge by MMBtu
      // so the result is $/MMBtu rather than $/Therm — mirrors getStoredRate('gas') above.
      var mmbtu = pf(parsed.naturalGasMMbtu) || pf(parsed.NaturalGasMMbtu) || 0;
      return mmbtu > 0 && cost > 0 ? cost / mmbtu : 0;
    }
    case 'propane': {
      var up = pf(parsed.UnitPrice);
      if (up > 0) return up;
      var gal = pf(parsed.GallonsDelivered);
      var cost = pf(parsed.TotalCurrentCharges) || pf(parsed.TotalAmountDue);
      return gal > 0 && cost > 0 ? cost / gal : 0;
    }
    case 'water': {
      var usage = pf(parsed.WaterUsage);
      var cost = pf(parsed.WaterCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'sewer': {
      var usage = pf(parsed.SewerUsage);
      var cost = pf(parsed.SewerCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    default:
      return 0;
  }
}
/* ══════════════════════════════════════════════════════════════════════════
   Missing-rate resolution cascade (SSOT) — resolveMeterRate()
   Spec: _context/plans/2026-09-10-missing-rate-resolution-cascade.md
   Rates: _context/research/2026-09-10-louisburg-published-utility-rates/findings.md

   5-step cascade, stop at first hit:
     1. Own bill rate for the month (getStoredRate / getStoredKwRate)
     2. Published seasonal tariff rate (table below; Evergy Metro + Louisburg gas only)
     3. Peer meter on the SAME rate schedule with a rate for the SAME month
     4. Same-meter previous month WITHIN the same rate season (never crosses the
        Jun-Sep / Oct-May boundary)
     5. Rate-escalation-normalized historical average (last resort — modeled)

   computations/savings.js and lib/perf-table.js both call this for the
   missing-rate case only (own-bill / step 1 is already resolved inline by each
   consumer for the fast path — this function re-derives step 1 too so it can
   be called standalone, e.g. by the gate test).
   ══════════════════════════════════════════════════════════════════════════ */

// Evergy Metro tariff season: Summer = Jun-Sep, Winter = Oct-May (Docket
// 23-EKCE-775-RTS + bill cross-check — NOT the May-Sep initial assumption).
var _EVERGY_METRO_SUMMER_MONTHS = [6, 7, 8, 9];

// Published rates ($/kWh energy on/off-peak, $/kW demand, $/kW facilities).
// Building -> code: High School=2LGSF, Middle School & Rockville=2LGSE,
// Circle Grove=2MGSE. Penny-exact cross-check against Louisburg bills.
var PUBLISHED_ELECTRIC_RATES = {
  '2LGSE': {
    onPkSu: 0.07852,
    onPkWi: 0.04146,
    offPkSu: 0.04182,
    offPkWi: 0.03538,
    demSu: 11.683,
    demWi: 5.598,
    facil: 2.979,
  },
  '2LGSF': {
    onPkSu: 0.07299,
    onPkWi: 0.03854,
    offPkSu: 0.03888,
    offPkWi: 0.03288,
    demSu: 11.744,
    demWi: 5.698,
    facil: 2.501,
  },
  '2MGSE': {
    onPkSu: 0.10304,
    onPkWi: 0.05436,
    offPkSu: 0.05734,
    offPkWi: 0.04769,
    demSu: 11.54,
    demWi: 2.171,
    facil: 2.854,
  },
};
// Broadmoor (2LGAE) / Field House (2MGAE): energy matches 2LGSE / 2MGSE exactly
// (bill cross-check); demand does NOT — no public AE demand sheet was found, so
// per the plan we never hardcode a guessed AE demand. Energy-only alias; the kW
// (demand) component for these two codes falls through to cascade steps 3-5.
var PUBLISHED_ELECTRIC_ENERGY_ALIAS = { '2LGAE': '2LGSE', '2MGAE': '2MGSE' };

// City of Louisburg municipal gas: flat, non-seasonal.
var PUBLISHED_GAS_FLAT_RATES = { louisburg: 0.798062 };

function _evergyMetroSeason(ym) {
  var mo = parseInt((ym || '').split('-')[1], 10);
  return _EVERGY_METRO_SUMMER_MONTHS.indexOf(mo) >= 0 ? 'summer' : 'winter';
}

// Season for a given electric rate schedule + month. 'none' = no known seasonal
// split for this schedule (whole year is one season) — the safe default for a
// schedule this cascade doesn't recognize.
function _seasonForSchedule(rateSchedule, ym) {
  var code = rateSchedule || '';
  if (PUBLISHED_ELECTRIC_RATES[code] || PUBLISHED_ELECTRIC_ENERGY_ALIAS[code]) {
    return _evergyMetroSeason(ym);
  }
  return 'none';
}

// Step 1: the meter's own bill(s) for month `ym`, blended (mean of the nonzero
// per-bill rates — matches the existing kwh-rate blending pattern in
// savings.js/perf-table.js). Works standalone (doesn't require resolveMeterRate).
function _cascadeOwnBillRate(bills, incl, ym, component) {
  if (!bills || !bills.length || !ym) return null;
  var bfr = bills.filter(function (b) {
    return normMonth(b.start, b.end, incl, bills) === ym;
  });
  if (!bfr.length) return null;
  var rates = bfr
    .map(function (b) {
      return component === 'kw' ? getStoredKwRate(b) : getStoredRate(b, component);
    })
    .filter(function (r) {
      return r > 0;
    });
  if (!rates.length) return null;
  var avg =
    rates.reduce(function (s, r) {
      return s + r;
    }, 0) / rates.length;
  return avg > 0 ? avg : null;
}

// Step 2: published seasonal tariff rate. component: 'kwh' | 'kw' | 'gas'.
// Propane/Water/Sewer/Stormwater have no confirmed public rate — returns null so
// the cascade proceeds to steps 3-5, per the research findings.
function _cascadePublishedRate(meter, ym) {
  return function (component) {
    if (meter.commodity === 'Electric' && (component === 'kwh' || component === 'kw')) {
      var code = meter.rateSchedule || '';
      var energyCode = PUBLISHED_ELECTRIC_RATES[code] ? code : PUBLISHED_ELECTRIC_ENERGY_ALIAS[code];
      if (!energyCode) return null;
      var t = PUBLISHED_ELECTRIC_RATES[energyCode];
      var season = _evergyMetroSeason(ym);
      if (component === 'kwh') {
        var onPk = season === 'summer' ? t.onPkSu : t.onPkWi;
        var offPk = season === 'summer' ? t.offPkSu : t.offPkWi;
        // No per-month on/off-peak usage split is knowable for a month with zero
        // bills — the simple average of the two published legs is the best
        // available blended $/kWh estimate (consumers only use one blended rate).
        return { rate: (onPk + offPk) / 2, season: season };
      }
      // component === 'kw': only for schedules with a CONFIRMED demand sheet —
      // energyCode !== code means `code` was an AE alias (demand unconfirmed).
      if (energyCode !== code) return null;
      var dem = season === 'summer' ? t.demSu : t.demWi;
      return { rate: dem + t.facil, season: season };
    }
    if (meter.commodity === 'Gas' && component === 'gas') {
      var provider = (meter.provider || '').toLowerCase();
      if (/louisburg/.test(provider)) return { rate: PUBLISHED_GAS_FLAT_RATES.louisburg, season: 'none' };
      return null;
    }
    return null;
  };
}

// Step 3: a peer meter on the SAME rate schedule with a rate for the SAME month.
function _cascadePeerRate(allMeters, meter, incl, ym, component) {
  if (!allMeters || !allMeters.length || !meter.rateSchedule) return null;
  for (var i = 0; i < allMeters.length; i++) {
    var peer = allMeters[i];
    if (peer === meter || peer.id === meter.id) continue;
    if (peer.commodity !== meter.commodity) continue;
    if ((peer.rateSchedule || '') !== meter.rateSchedule) continue;
    var r = _cascadeOwnBillRate(peer.bills || [], incl, ym, component);
    if (r != null && r > 0) return { rate: r, peerMeterId: peer.id };
  }
  return null;
}

// Step 4: same-meter previous month WITHIN the same rate season. Never crosses
// the season boundary (a gapped May pulls a WINTER month; a gapped July pulls a
// SUMMER month; never the reverse).
function _cascadeSameSeasonCarry(bills, incl, ym, component, meter) {
  if (!bills || !bills.length) return null;
  var season = _seasonForSchedule(meter.rateSchedule, ym);
  var allYms = Array.from(
    new Set(
      bills
        .map(function (b) {
          return normMonth(b.start, b.end, incl, bills);
        })
        .filter(Boolean),
    ),
  );
  var candidates = allYms
    .filter(function (y) {
      return y < ym;
    })
    .sort()
    .reverse();
  for (var i = 0; i < candidates.length; i++) {
    var cym = candidates[i];
    if (season !== 'none' && _seasonForSchedule(meter.rateSchedule, cym) !== season) continue;
    var r = _cascadeOwnBillRate(bills, incl, cym, component);
    if (r != null && r > 0) return { rate: r, fromYm: cym };
  }
  return null;
}

// Step 5 (last resort): rate-escalation-normalized historical average.
// histRate(M) = avg of the rate for the SAME calendar month across prior years
// (falls back to the same SEASON if that exact month never has a real rate).
// escalation = (current year's known avg rate for the same known months) /
//              (the same prior-years' avg rate for those months).
// estimatedRate(M) = histRate(M) x escalation.
function _cascadeEscalationEstimate(bills, incl, ym, component, meter) {
  if (!bills || !bills.length) return null;
  var targetMo = ym.split('-')[1];
  var targetYear = parseInt(ym.split('-')[0], 10);
  var season = _seasonForSchedule(meter.rateSchedule, ym);
  var allYms = Array.from(
    new Set(
      bills
        .map(function (b) {
          return normMonth(b.start, b.end, incl, bills);
        })
        .filter(Boolean),
    ),
  );
  var pairs = allYms
    .map(function (y) {
      return { ym: y, rate: _cascadeOwnBillRate(bills, incl, y, component) };
    })
    .filter(function (p) {
      return p.rate != null && p.rate > 0;
    });
  if (!pairs.length) return null;

  var sameMonthPrior = pairs.filter(function (p) {
    return p.ym.split('-')[1] === targetMo && parseInt(p.ym.split('-')[0], 10) < targetYear;
  });
  var histPool = sameMonthPrior.length
    ? sameMonthPrior
    : pairs.filter(function (p) {
        return _seasonForSchedule(meter.rateSchedule, p.ym) === season && parseInt(p.ym.split('-')[0], 10) < targetYear;
      });
  if (!histPool.length) return null;
  var histRate =
    histPool.reduce(function (s, p) {
      return s + p.rate;
    }, 0) / histPool.length;

  // escalation = (current year's known average rate for this meter/schedule) /
  // (the same prior-years' average rate for THOSE SAME known months) — the
  // "known months" set is driven by whatever the CURRENT year actually has data
  // for (not restricted to the target month M's own history pool above).
  var curYearPairs = pairs.filter(function (p) {
    return parseInt(p.ym.split('-')[0], 10) === targetYear;
  });
  var escalation = 1;
  if (curYearPairs.length) {
    var curAvg =
      curYearPairs.reduce(function (s, p) {
        return s + p.rate;
      }, 0) / curYearPairs.length;
    var curMonths = curYearPairs.map(function (p) {
      return p.ym.split('-')[1];
    });
    // Prior-years' average for those SAME known months (searched across ALL prior
    // years in `pairs`, not just the target month's histPool).
    var priorForSameMonths = pairs.filter(function (p) {
      return curMonths.indexOf(p.ym.split('-')[1]) >= 0 && parseInt(p.ym.split('-')[0], 10) < targetYear;
    });
    var priorAvg = priorForSameMonths.length
      ? priorForSameMonths.reduce(function (s, p) {
          return s + p.rate;
        }, 0) / priorForSameMonths.length
      : histRate;
    escalation = priorAvg > 0 ? curAvg / priorAvg : 1;
  }
  var estimated = histRate * escalation;
  return estimated > 0 ? { rate: estimated, histRate: histRate, escalation: escalation } : null;
}

// resolveMeterRate(projId, meter, ym, opts) — the canonical entry point.
// opts: { bills, incl, allMeters, component }
//   bills:      meter.bills (or an override — e.g. a synthetic gap-test copy)
//   incl:       proj.inclMonths (normMonth's inclusive/exclusive setting)
//   allMeters:  sibling meters in the same building (step 3 peer lookup) — pass
//               the building's full meters array (any commodity; filtered internally)
//   component:  'kwh' | 'kw' | 'gas' | 'propane' | 'water' | 'sewer' (required)
// Returns { rate, step, source, ...stepDetail } or null if every step fails (the
// caller must NOT invent a number on null — let the completeness-warning path
// flag it, per the plan).
function resolveMeterRate(projId, meter, ym, opts) {
  opts = opts || {};
  var component = opts.component;
  if (!meter || !ym || !component) return null;
  var bills = opts.bills || meter.bills || [];
  var incl = opts.incl || {};
  var allMeters = opts.allMeters || [];

  var s1 = _cascadeOwnBillRate(bills, incl, ym, component);
  if (s1 != null && s1 > 0) return { rate: s1, step: 1, source: 'own-bill' };

  var s2 = _cascadePublishedRate(meter, ym)(component);
  if (s2 && s2.rate > 0) return { rate: s2.rate, step: 2, source: 'published-' + s2.season };

  var s3 = _cascadePeerRate(allMeters, meter, incl, ym, component);
  if (s3 && s3.rate > 0) return { rate: s3.rate, step: 3, source: 'peer:' + s3.peerMeterId };

  var s4 = _cascadeSameSeasonCarry(bills, incl, ym, component, meter);
  if (s4 && s4.rate > 0) return { rate: s4.rate, step: 4, source: 'carry-forward:' + s4.fromYm };

  var s5 = _cascadeEscalationEstimate(bills, incl, ym, component, meter);
  if (s5 && s5.rate > 0)
    return { rate: s5.rate, step: 5, source: 'modeled', histRate: s5.histRate, escalation: s5.escalation };

  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   computeSeasonalBldgRates(projId, bldgId) — the ONE canonical seasonal
   marginal rate function for a building.
   Item: 2026-09-23-rate-source (single source of truth for utility rates).

   Every surface that shows or uses a building's seasonal marginal utility
   rate — the Energy Savings measure table (calcBldgDefaultRates, a thin
   wrapper around this function), the Baseline & BAS Savings Report Inputs
   dialog prefill, the BAS Savings Calc rate-card autofill, and the ECM
   calculators' "Add as Measure" default — MUST call this function and MUST
   NOT re-derive its own copy. Savings dollars are always (quantity saved) x
   SEASONAL MARGINAL rate, monthly then summed, so the rate here is the same
   per-bill implied rate (cost / usage, the exact charge fields) that
   getStoredRate/getStoredKwRate already use everywhere else in the app —
   never a different charge-field subset.

   Season: Evergy Metro Jun-Sep = summer, Oct-May = winter (docket
   23-EKCE-775-RTS + bill cross-check — see _EVERGY_METRO_SUMMER_MONTHS
   above). A bill's calendar month is resolved with normMonth() — the same
   majority-days-in-month resolver the missing-rate cascade and every
   baseline table use — NOT a naive `new Date(bill.start).getMonth()`, which
   misclassifies billing periods that straddle the season boundary (e.g. a
   bill starting May 20 and ending June 19 is mostly June, but a naive
   start-month read calls it May/winter — see the Woodland Spring Middle
   2025-05-20 bill, which the utility itself bills at the SUMMER demand
   rate).

   Returns (0, never null, so every existing `|| 0` guard keeps working):
     {
       kwhSummer, kwhWinter,   // $/kWh, electric energy, mean of per-bill
                                // getStoredRate(bill,'kwh') for bills in season
       kwSummer, kwWinter,     // $/kW, electric demand, mean of per-bill
                                // getStoredKwRate(bill) for bills in season
       thermRate,              // $/Therm, gas — flat mean across all months
                                // (gas has no confirmed seasonal tariff split
                                // for the providers in use; gasSummer/
                                // gasWinter below are additive detail only)
       gasSummer, gasWinter,   // $/Therm, gas — seasonal mean, same bills as
                                // thermRate, bucketed by season (0 when a
                                // season has no gas bills)
       gallonRate,             // $/Gallon, propane — flat mean, no seasonal
                                // tariff for propane
       months: {                // which bill months fed each bucket, for the
         kwhSummer: [...ym],    // "which bill months it came from" label
         kwhWinter: [...ym],    // every surface must show (plan step 3)
         kwSummer: [...ym],
         kwWinter: [...ym],
         gas: [...ym],
         propane: [...ym],
       },
     }
───────────────────────────────────────────────────────────────────────── */
function computeSeasonalBldgRates(projId, bldgId) {
  var empty = {
    kwhSummer: 0,
    kwhWinter: 0,
    kwSummer: 0,
    kwWinter: 0,
    thermRate: 0,
    gasSummer: 0,
    gasWinter: 0,
    gallonRate: 0,
    months: { kwhSummer: [], kwhWinter: [], kwSummer: [], kwWinter: [], gas: [], propane: [] },
  };
  var b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return empty;
  var meters = b.meters || [];
  var elecM = meters.find(function (m) {
    return m.commodity === 'Electric';
  });
  var gasM = meters.find(function (m) {
    return m.commodity === 'Gas';
  });
  var propaneM = meters.find(function (m) {
    return m.commodity === 'Propane';
  });

  // One bill -> { ym, season, rate } for every bill with a positive rate from `rateFn`.
  function billRates(meter, rateFn) {
    var out = [];
    (meter.bills || []).forEach(function (bill) {
      var rate = rateFn(bill);
      if (!(rate > 0)) return;
      var ym = typeof normMonth === 'function' ? normMonth(bill.start, bill.end, {}, meter.bills) : null;
      var season = ym ? _evergyMetroSeason(ym) : 'winter';
      out.push({ ym: ym, season: season, rate: rate });
    });
    return out;
  }

  function mean(rows) {
    if (!rows.length) return 0;
    var sum = rows.reduce(function (s, r) {
      return s + r.rate;
    }, 0);
    return sum / rows.length;
  }

  function seasonSplit(rows) {
    return {
      summer: rows.filter(function (r) {
        return r.season === 'summer';
      }),
      winter: rows.filter(function (r) {
        return r.season === 'winter';
      }),
    };
  }

  function yms(rows) {
    return rows
      .map(function (r) {
        return r.ym;
      })
      .filter(Boolean);
  }

  var out = empty;
  out.months = { kwhSummer: [], kwhWinter: [], kwSummer: [], kwWinter: [], gas: [], propane: [] };

  if (elecM) {
    var kwhRows = billRates(elecM, function (bill) {
      return getStoredRate(bill, 'kwh');
    });
    var kwRows = billRates(elecM, getStoredKwRate);
    var kwhSplit = seasonSplit(kwhRows);
    var kwSplit = seasonSplit(kwRows);
    out.kwhSummer = Math.round(mean(kwhSplit.summer) * 10000) / 10000;
    out.kwhWinter = Math.round(mean(kwhSplit.winter) * 10000) / 10000;
    out.kwSummer = Math.round(mean(kwSplit.summer) * 100) / 100;
    out.kwWinter = Math.round(mean(kwSplit.winter) * 100) / 100;
    out.months.kwhSummer = yms(kwhSplit.summer);
    out.months.kwhWinter = yms(kwhSplit.winter);
    out.months.kwSummer = yms(kwSplit.summer);
    out.months.kwWinter = yms(kwSplit.winter);
  }

  if (gasM) {
    // Gas rate per bill: cost / resolveGasUsageTherms(bill) — deliberately NOT
    // bill.totalGasRate (ensureBillRates's one-time-migration field). ensureBillRates has the
    // same PascalCase-only usage gap resolveGasUsageTherms's own header comment documents for
    // getStoredRate, PLUS a second, worse bug found while building this function (2026-09-23):
    // for an MMBtu-only meter (naturalGasMMbtu, no NaturalGasTherms/NaturalGasCCF — e.g. Spring
    // Hill High), ensureBillRates's usage detection is 0, so it falls to its MMBtu branch and
    // stores cost/naturalGasMMbtu (a $/MMBtu number) in totalGasRate — but bill.therms is
    // SEPARATELY, correctly canonicalized elsewhere to naturalGasMMbtu*10 (Therms-equivalent),
    // so that stored totalGasRate is 10x too high relative to every other bill's real $/Therm
    // (confirmed on Spring Hill High: March's totalGasRate correctly used NaturalGasTherms and
    // reads $0.52/Therm, but June-Apr's used the MMBtu branch and read $3.32-$8.35/Therm — same
    // meter, same rate schedule, 6-16x apart). Recomputing fresh via resolveGasUsageTherms here
    // avoids trusting that stale/wrong-unit stored value; ensureBillRates itself is a separate,
    // already-shipped one-time migration outside this item's scope — logged to the backlog
    // instead of changed here.
    var gasRows = billRates(gasM, function (bill) {
      var cost =
        parseFloat(bill.GasCharge) ||
        parseFloat(bill.gasCharge) ||
        parseFloat(bill.thermCost) ||
        parseFloat(bill.totalCost) ||
        0;
      var usage = typeof resolveGasUsageTherms === 'function' ? resolveGasUsageTherms(bill) : 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    });
    var gasSplit = seasonSplit(gasRows);
    out.gasSummer = Math.round(mean(gasSplit.summer) * 1000) / 1000;
    out.gasWinter = Math.round(mean(gasSplit.winter) * 1000) / 1000;
    out.thermRate = Math.round(mean(gasRows) * 1000) / 1000;
    out.months.gas = yms(gasRows);
  }

  if (propaneM) {
    var propaneRows = billRates(propaneM, function (bill) {
      return getStoredRate(bill, 'propane');
    });
    out.gallonRate = Math.round(mean(propaneRows) * 1000) / 1000;
    out.months.propane = yms(propaneRows);
  }

  return out;
}

// formatBillMonthsLabel(yms) — turns a list of 'YYYY-MM' strings into the plain-words
// "which bill months this came from" label every rate surface must show (plan step 3).
// e.g. ['2025-06','2025-07','2025-08','2025-09'] -> 'Jun 2025 – Sep 2025 (4 bills)'.
var _RATE_MO_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatBillMonthsLabel(ymList) {
  var list = (ymList || []).filter(Boolean).slice().sort();
  if (!list.length) return 'no bills';
  function label(ym) {
    var parts = ym.split('-');
    var mo = parseInt(parts[1], 10) - 1;
    return (_RATE_MO_ABBR[mo] || ym) + ' ' + parts[0];
  }
  var first = label(list[0]);
  var last = label(list[list.length - 1]);
  var countLabel = list.length + (list.length === 1 ? ' bill' : ' bills');
  return first === last ? first + ' (' + countLabel + ')' : first + ' – ' + last + ' (' + countLabel + ')';
}
