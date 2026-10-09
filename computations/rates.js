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

// getBillFacKWCost(bill) — the ONE accessor for a bill's Facilities kW Cost dollar amount.
// Two field names exist on a bill object for historical reasons: `facilitiesCharge` (the
// modern BILL_SCHEMA.Electric name) and `facKWCost` (legacy name, still written alongside it
// by both write paths — the PDF/OCR extractor in app/bill-analysis.js and the CSV importer's
// sync in app/csv-import.js — so new data always has both populated). A bill saved before that
// sync existed can still carry only one of the two. This function is the single place that
// resolves which value wins (facilitiesCharge first, falling back to facKWCost) — every reader
// (computations/normalization.js buildMoMap, app/core.js, app/graphics-setpoints.js,
// app/report-engine.js, app/report-engine-woodland.js, lib/perf-table.js, app/utility-data.js)
// must call this instead of reading bill.facKWCost / bill.facilitiesCharge directly, so a bill
// missing one of the two names is never silently read as $0 (2026-09-23 cold-review Q1/Q3 fix).
function getBillFacKWCost(bill) {
  if (!bill) return 0;
  var v = bill.facilitiesCharge;
  if (v === undefined || v === null || v === '') v = bill.facKWCost;
  return parseBillNumber(v) || 0;
}

// getBillUsageCharge(bill, type) - the ONE usage-charge dollars of a water or sewer bill: the bill's own
// charge line (waterCharge / sewerCharge), never the bill total and never a stored rate field.
// Callers: getStoredRate (water and sewer), the usage_charge_mismatch flag (computations/bill-flags.js).
function getBillUsageCharge(bill, type) {
  if (!bill) return 0;
  if (type === 'water') return parseBillNumber(bill.WaterCharge) || parseBillNumber(bill.waterCharge) || 0;
  if (type === 'sewer') return parseBillNumber(bill.SewerCharge) || parseBillNumber(bill.sewerCharge) || 0;
  return 0;
}

// billHasPdf(bill) — the ONE answer to "does this bill have an attached PDF?". A bill has a PDF when
// it carries a pdfKey (the storage key of the attached file) or the hasPDF mark the save paths set.
// The old third flag `fromPDF` (always true on every PDF save path, so it said nothing) is not
// written any more (2026-10-05 duplicate-bill-fields audit step 7) and is never read.
function billHasPdf(bill) {
  return !!(bill && (bill.hasPDF || bill.pdfKey));
}

// getBillKwCost(bill) / getBillKwhCost(bill) — the ONE accessors for the electric demand dollars
// (demandCharge + tdcCharge, the Bills table "kW Cost $" without the Facilities part) and the electric
// energy dollars (onPeakCost + offPeakCost + ecaCharge + eerCharge + ptsCharge, the Bills table
// "kWh Cost $"). They add up the visible component fields. The stored roll-up copies `kwCost` /
// `kwhCost` (written by the PDF save paths until 2026-10-05) are read ONLY when the bill has none of
// the component fields. On the 2026-09-30 backup all 263 electric bills agree to the cent.
function getBillKwCost(bill) {
  if (!bill) return 0;
  var d = parseBillNumber(bill.demandCharge);
  var t = parseBillNumber(bill.tdcCharge);
  if (d !== null || t !== null) return (d || 0) + (t || 0);
  return parseBillNumber(bill.kwCost) || 0;
}
function getBillKwhCost(bill) {
  if (!bill) return 0;
  var parts = [bill.onPeakCost, bill.offPeakCost, bill.ecaCharge, bill.eerCharge, bill.ptsCharge].map(parseBillNumber);
  var any = false;
  var sum = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] !== null) {
      any = true;
      sum += parts[i];
    }
  }
  if (any) return sum;
  return parseBillNumber(bill.kwhCost) || 0;
}
// getBillOtherCost(bill) / getBillTaxCost(bill) — the ONE accessors for the rest of an electric bill.
// "Other" = customerCharge + rkvaCharge + taxExemptDelivery + billOffset + miscellaneousCharge (every
// line that is not energy, not demand, not facilities, not tax). "Tax" = franchiseFee. This settles the
// two old formulas (the stored otherCost copy folded in miscellaneousCharge; the Bills table cell folded
// in franchiseFee instead): the Bills table "Other Charges $" is getBillOtherCost + getBillTaxCost, so
// the four accessors plus getBillFacKWCost add up to the whole bill. The stored copies otherCost /
// taxCost are read only when a bill has none of the component fields.
function getBillOtherCost(bill) {
  if (!bill) return 0;
  var parts = [bill.customerCharge, bill.rkvaCharge, bill.taxExemptDelivery, bill.billOffset, bill.miscellaneousCharge].map(
    parseBillNumber,
  );
  var any = false;
  var sum = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] !== null) {
      any = true;
      sum += parts[i];
    }
  }
  if (any) return sum;
  return parseBillNumber(bill.otherCost) || 0;
}
function getBillTaxCost(bill) {
  if (!bill) return 0;
  var v = parseBillNumber(bill.franchiseFee);
  if (v !== null) return v;
  return parseBillNumber(bill.taxCost) || 0;
}

// getBillGasCostOrNull(bill) — the ONE accessor for a bill's gas commodity cost (dollars).
// Source field: `gasCharge` (BILL_SCHEMA.Gas "Gas Charge", the field the Bills table and the
// Edit modal show) or the extractor's `GasCharge`. Nothing else is read first. The old stored
// copy `thermCost` (written by the PDF save paths and the modal's hidden inputs until
// 2026-10-05, and often equal to the whole bill total or stale after a modal edit) is never read.
// Fallback: when the bill has NO gas charge at all but does carry gas usage, the whole bill
// total (totalCost / TotalCurrentCharges / TotalAmountDue) is the only gas dollar figure on the
// bill, so that is returned. A bill with no gas usage never gets a gas cost from its total
// (this accessor also runs for Water/Sewer meters inside the shared non-electric branches).
// Returns null when the bill has neither (missing is not 0). getBillGasCost returns 0 instead.
// Every reader — flag rule (app/bill-analysis.js), savings (computations/savings.js), rates
// (this file), normalization, anomaly detection, budget, dashboard roll-ups, report engine,
// Utility Data roll-ups — must call one of these two, never bill.gasCharge/thermCost directly.
function getBillGasCostOrNull(bill) {
  if (!bill) return null;
  var v = billValueOrNull(bill.gasCharge, bill.GasCharge);
  if (v === null) {
    var hasUsage =
      typeof resolveGasUsageThermsOrNull === 'function' ? resolveGasUsageThermsOrNull(bill) !== null : false;
    if (!hasUsage) return null;
    v = billValueOrNull(bill.totalCost, bill.TotalCurrentCharges, bill.TotalAmountDue);
  }
  return parseBillNumber(v);
}
function getBillGasCost(bill) {
  var v = getBillGasCostOrNull(bill);
  return v === null ? 0 : v;
}

// getStoredRate(bill, type) — the ONE $/unit rate for a bill ('kwh' | 'gas' | 'propane' | 'water' |
// 'sewer' | 'stormwater'). It is COMPUTED from the bill's own dollars and usage through the one
// cost accessors above and the one usage resolver (resolveGasUsageTherms), so the rate can never
// disagree with the cost and usage the Bills table shows. The old stored copies (totalKwhRate,
// totalGasRate, totalWaterRate, totalSewerRate, totalPropaneRate, totalStormwaterRate — written by
// the PDF save paths, the CSV import and ensureBillRates until 2026-10-05, and stale after any edit)
// are read ONLY when the bill has no cost or no usage to compute from. Nothing writes them any more.
// Propane is the all-in rate (whole delivered cost / gallons), the same rule the savings engine
// uses (computations/savings.js D-9), not the printed unit price.
function getStoredRate(bill, type) {
  if (!bill) return 0;
  var computed = 0;
  var stored = 0;
  switch (type) {
    case 'kwh': {
      var kwh = parseBillNumber(bill.kWhConsumed) || parseBillNumber(bill.totalKwh) || parseBillNumber(bill.kwh) || 0;
      var kwhCost = getBillKwhCost(bill);
      computed = kwh > 0 && kwhCost > 0 ? kwhCost / kwh : 0;
      stored = parseBillNumber(bill.totalKwhRate);
      break;
    }
    case 'gas': {
      var gasCost = getBillGasCost(bill);
      // resolveGasUsageTherms (computations/savings.js) converts CCF / MMBtu to Therms, so this is
      // always $/Therm whichever usage field the bill carries.
      var therms = typeof resolveGasUsageTherms === 'function' ? resolveGasUsageTherms(bill) : 0;
      computed = therms > 0 && gasCost > 0 ? gasCost / therms : 0;
      stored = parseBillNumber(bill.totalGasRate);
      break;
    }
    case 'propane': {
      var gal = parseBillNumber(bill.gallonsDelivered) || parseBillNumber(bill.GallonsDelivered) || 0;
      var propCost =
        parseBillNumber(bill.totalCost) || parseBillNumber(bill.TotalCurrentCharges) || parseBillNumber(bill.TotalAmountDue) || 0;
      computed = gal > 0 && propCost > 0 ? propCost / gal : 0;
      stored = parseBillNumber(bill.totalPropaneRate);
      break;
    }
    case 'water': {
      // getBillUsageCharge = the bill's own water charge line; with no charge line, the bill total.
      var wUsage = getBillUsageOrNull(bill, 'Water') || 0;
      var wCost =
        getBillUsageCharge(bill, 'water') || parseBillNumber(bill.totalCost) || parseBillNumber(bill.TotalCurrentCharges) || 0;
      computed = wUsage > 0 && wCost > 0 ? wCost / wUsage : 0;
      stored = parseBillNumber(bill.totalWaterRate);
      break;
    }
    case 'sewer': {
      var sUsage = getBillUsageOrNull(bill, 'Sewer') || 0;
      var sCost = getBillUsageCharge(bill, 'sewer');
      computed = sUsage > 0 && sCost > 0 ? sCost / sUsage : 0;
      stored = parseBillNumber(bill.totalSewerRate);
      break;
    }
    case 'stormwater': {
      // Stormwater has no usage: the "rate" column is the charge itself.
      computed = parseBillNumber(bill.stormWaterCharge) || parseBillNumber(bill.StormWaterCharge) || 0;
      stored = parseBillNumber(bill.totalStormwaterRate);
      break;
    }
    default:
      return 0;
  }
  if (computed > 0) return computed;
  return stored > 0 ? stored : 0;
}

// getStoredKwRate(bill) - the ONE $/kW (demand) rate for a bill.
// SSOT for the Bills table, Meter Performance, the savings engine and the missing-rate cascade.
// Computed: demand dollars (getBillKwCost: demandCharge + tdcCharge, or the legacy kwCost) plus the
// Facilities kW cost (getBillFacKWCost), divided by billed kW. Older bills that hold only kwCost and
// facKWCost therefore give the same rate as newer bills that hold the same dollars under demandCharge
// and facilitiesCharge (WP-04, math-02 H12/D6). The stored totalKwRate is read only when the bill has
// no dollars or no kW to compute from (same rule as getStoredRate).
function getStoredKwRate(bill) {
  if (!bill) return 0;
  var billedKW =
    parseBillNumber(bill.billedKW) ||
    parseBillNumber(bill.demandKW) ||
    parseBillNumber(bill.BilledKW) ||
    parseBillNumber(bill.ActualKW) ||
    parseBillNumber(bill.FacilitiesKW) ||
    0;
  var cost = getBillKwCost(bill) + getBillFacKWCost(bill);
  if (billedKW > 0 && cost > 0) return cost / billedKW;
  var stored = parseBillNumber(bill.totalKwRate);
  return stored > 0 ? stored : 0;
}

function validateImpliedRate(commodity, usage, charge, utilityName) {
  if (!usage || !charge || usage === 0) return null;
  const implied = Math.abs(charge / usage);
  const commRates = KNOWN_RATES[(commodity || '').charAt(0).toUpperCase() + (commodity || '').slice(1).toLowerCase()];
  if (!commRates) return null;
  const rateKey = Object.keys(commRates)[0];
  const expected = commRates[rateKey];
  if (!expected) return null;

  // Use utility-specific override if available (e.g. Client A gas)
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

// Single list of Utility E electric component charge fields that add up to
// TotalCurrentCharges. Used by validateBillData, the Gate C/D line-item check
// and the Stage 3 charge reconciliation. Add a new charge field here only.
var UTILITY_E_COMPONENT_CHARGE_FIELDS = [
  'CustomerCharge',
  'FacilitiesCharge',
  'BilledKWCharge',
  'EnergyOnPeakCharge',
  'EnergyOffPeakCharge',
  'ECACharge',
  'EERCharge',
  'PTSCharge',
  'TDCCharge',
  'RkVACharge',
  'TaxExemptDelivery',
  'BillOffset',
  'FranchiseFee',
  'SolarCredit',
  'RenewableCharge',
  'MiscellaneousCharge',
  'SalesTax',
];

// Sum of the Utility E component charges, rounded to cents. The extractor's charge
// reconciliation (app/energy-savings.js) compares this with TotalCurrentCharges.
function sumElectricComponentCharges(parsed) {
  parsed = parsed || {};
  var total = 0;
  for (var i = 0; i < UTILITY_E_COMPONENT_CHARGE_FIELDS.length; i++) {
    total += parseBillNumber(parsed[UTILITY_E_COMPONENT_CHARGE_FIELDS[i]]);
  }
  return Math.round(total * 100) / 100;
}

// Canonical electric energy-charge sum — the 5 charge fields that make up the
// implied $/kWh rate (OnPeak + OffPeak + ECA + EER + PTS). SSOT for
// getExtractedRate('kwh'), validateBillData's electric branch, and
// detectStatisticalOutliers's electric rate check (bill-analysis.js) — all
// three must sum the same fields or a bill's "checked" rate can disagree with
// its "displayed" rate and false-flag a valid bill (item 377ea7f0).
function sumElectricEnergyCharges(parsed) {
  parsed = parsed || {};
  return (
    parseBillNumber(parsed.EnergyOnPeakCharge) +
    parseBillNumber(parsed.EnergyOffPeakCharge) +
    parseBillNumber(parsed.ECACharge) +
    parseBillNumber(parsed.EERCharge) +
    parseBillNumber(parsed.PTSCharge)
  );
}

// getExtractedRate(parsed, type) - a DIFFERENT value from getStoredRate: the preview rate of a freshly
// extracted PDF (extractor field names, before any save). Propane uses the printed UnitPrice and
// gas without therms uses $/MMBtu; getStoredRate is the all-in $/Therm of a saved bill. Same cost
// accessors; do not use it for saved bills.
function getExtractedRate(parsed, type) {
  switch (type) {
    case 'kwh': {
      var cost = sumElectricEnergyCharges(parsed);
      var usage = parseBillNumber(parsed.kWhConsumed);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'kw': {
      var cost =
        parseBillNumber(parsed.FacilitiesCharge) +
        parseBillNumber(parsed.BilledKWCharge) +
        parseBillNumber(parsed.TDCCharge);
      var usage =
        parseBillNumber(parsed.BilledKW) || parseBillNumber(parsed.ActualKW) || parseBillNumber(parsed.FacilitiesKW);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'gas': {
      var cost = getBillGasCost(parsed);
      var usage = resolveGasUsageTherms({
        NaturalGasTherms: parsed.NaturalGasTherms,
        NaturalGasCCF: parsed.NaturalGasCCF,
        ThermFactor: parsed.ThermFactor,
      });
      if (usage > 0 && cost > 0) return cost / usage;
      // MMBtu fallback: WRE meters store usage as naturalGasMMbtu; divide charge by MMBtu
      // so the result is $/MMBtu rather than $/Therm (getStoredRate converts to Therms instead).
      var mmbtu = parseBillNumber(parsed.naturalGasMMbtu) || parseBillNumber(parsed.NaturalGasMMbtu) || 0;
      return mmbtu > 0 && cost > 0 ? cost / mmbtu : 0;
    }
    case 'propane': {
      var up = parseBillNumber(parsed.UnitPrice);
      if (up > 0) return up;
      var gal = parseBillNumber(parsed.GallonsDelivered);
      var cost = parseBillNumber(parsed.TotalCurrentCharges) || parseBillNumber(parsed.TotalAmountDue);
      return gal > 0 && cost > 0 ? cost / gal : 0;
    }
    case 'water': {
      var usage = parseBillNumber(parsed.WaterUsage);
      var cost = parseBillNumber(parsed.WaterCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'sewer': {
      var usage = parseBillNumber(parsed.SewerUsage);
      var cost = parseBillNumber(parsed.SewerCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    default:
      return 0;
  }
}
/* ══════════════════════════════════════════════════════════════════════════
   Missing-rate resolution cascade (SSOT) — resolveMeterRate()
   Spec: _context/plans/2026-09-10-missing-rate-resolution-cascade.md
   Rates: _context/research/2026-09-10-client-a-published-utility-rates/findings.md

   5-step cascade, stop at first hit:
     1. Own bill rate for the month (getStoredRate / getStoredKwRate)
     2. Published seasonal tariff rate (table below; Utility E Metro + Client A gas only)
     3. Peer meter on the SAME rate schedule with a rate for the SAME month
     4. Same-meter previous month WITHIN the same rate season (never crosses the
        Jun-Sep / Oct-May boundary)
     5. Rate-escalation-normalized historical average (last resort — modeled)

   computations/savings.js and lib/perf-table.js both call this for the
   missing-rate case only (own-bill / step 1 is already resolved inline by each
   consumer for the fast path — this function re-derives step 1 too so it can
   be called standalone, e.g. by the gate test).
   ══════════════════════════════════════════════════════════════════════════ */

// Utility E Metro tariff season: Summer = Jun-Sep, Winter = Oct-May (Docket
// 23-EKCE-775-RTS + bill cross-check — NOT the May-Sep initial assumption).
var _EVERGY_METRO_SUMMER_MONTHS = [6, 7, 8, 9];

// Published rates ($/kWh energy on/off-peak, $/kW demand, $/kW facilities).
// Building -> code: High School=2LGSF, Middle School & Site H=2LGSE,
// Site G=2MGSE. Penny-exact cross-check against Client A bills.
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
// Site F (2LGAE) / Field House (2MGAE): energy matches 2LGSE / 2MGSE exactly
// (bill cross-check); demand does NOT — no public AE demand sheet was found, so
// per the plan we never hardcode a guessed AE demand. Energy-only alias; the kW
// (demand) component for these two codes falls through to cascade steps 3-5.
var PUBLISHED_ELECTRIC_ENERGY_ALIAS = { '2LGAE': '2LGSE', '2MGAE': '2MGSE' };

// City of Client A municipal gas: flat, non-seasonal.
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

   Season: Utility E Metro Jun-Sep = summer, Oct-May = winter (docket
   23-EKCE-775-RTS + bill cross-check — see _EVERGY_METRO_SUMMER_MONTHS
   above). A bill's calendar month is resolved with normMonth() — the same
   majority-days-in-month resolver the missing-rate cascade and every
   baseline table use — NOT a naive `new Date(bill.start).getMonth()`, which
   misclassifies billing periods that straddle the season boundary (e.g. a
   bill starting May 20 and ending June 19 is mostly June, but a naive
   start-month read calls it May/winter — see the Client B Spring Middle
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
  // Every meter of a commodity feeds that commodity's rate (WP-04, math-02 M14), not only the first.
  var elecMeters = meters.filter(function (m) {
    return m.commodity === 'Electric';
  });
  var gasMeters = meters.filter(function (m) {
    return m.commodity === 'Gas';
  });
  var propaneMeters = meters.filter(function (m) {
    return m.commodity === 'Propane';
  });

  // One bill -> { ym, season, rate } for every bill with a positive rate from `rateFn`.
  function billRates(meterList, rateFn) {
    var out = [];
    meterList.forEach(function (meter) {
      (meter.bills || []).forEach(function (bill) {
        var rate = rateFn(bill);
        if (!(rate > 0)) return;
        var ym = typeof normMonth === 'function' ? normMonth(bill.start, bill.end, {}, meter.bills) : null;
        var season = ym ? _evergyMetroSeason(ym) : 'winter';
        out.push({ ym: ym, season: season, rate: rate });
      });
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

  if (elecMeters.length) {
    var kwhRows = billRates(elecMeters, function (bill) {
      return getStoredRate(bill, 'kwh');
    });
    var kwRows = billRates(elecMeters, getStoredKwRate);
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

  if (gasMeters.length) {
    // Gas rate per bill: getStoredRate(bill, 'gas') — the one $/Therm rate (gas cost accessor /
    // resolveGasUsageTherms). Nothing stores a rate any more (2026-10-05 audit step 5).
    var gasRows = billRates(gasMeters, function (bill) {
      return getStoredRate(bill, 'gas');
    });
    var gasSplit = seasonSplit(gasRows);
    out.gasSummer = Math.round(mean(gasSplit.summer) * 1000) / 1000;
    out.gasWinter = Math.round(mean(gasSplit.winter) * 1000) / 1000;
    out.thermRate = Math.round(mean(gasRows) * 1000) / 1000;
    out.months.gas = yms(gasRows);
  }

  if (propaneMeters.length) {
    var propaneRows = billRates(propaneMeters, function (bill) {
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
