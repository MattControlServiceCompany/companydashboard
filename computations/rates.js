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

/* ── SEASON TABLE (SSOT) ── the ONE definition of summer and winter, keyed by utility + territory.
   Every Utility E general service schedule says: summer = the four monthly billing periods June-September,
   winter = the eight billing periods October-May, and "Customer bills for meter reading periods including one
   or more days in both seasons will reflect the number of days in each season." The Utility E bill definitions:
   summer June 1 - September 30 in all territories. So the season follows the SERVICE DATES of each day and a
   bill can change season in the middle. Tariff sheets (Utility E rate books):
     Kansas Metro   : SGS p29, SGA p35, MGS p41, MGA p48, LGS p56, LGA p65
     Kansas Central : general service schedules (Kansas Central rate book)
     Missouri Metro : SGS p33, MGS p39, LGS p45
     Missouri West  : general service schedules (Missouri West rate book)
   (Kansas Metro Schedule 12 uses May 16 - Sep 15; it is not a general service schedule and is not used.)
   SEASON_UTILITY is tested against meter.provider; `territory` picks the row, and the last row (any territory)
   is used when the meter says only the utility name (the dates are the same in every territory).
   A provider that is not SEASON_UTILITY has NO seasonal tariff: Kansas Gas Service (cost of gas changes every
   billing month), the gas marketer (monthly price), a city gas utility (flat), the propane supplier (per
   delivery). Its projected rate is the baseline mean of each calendar month (computeSeasonalBldgRates
   kwhMonthly / kwMonthly / gasMonthly).
   from / to are 'MM-DD', inclusive. Rows must start on the first day and end on the last day of a month. */
var SEASON_UTILITY = 'Evergy';
var SEASON_TABLE = [
  { name: 'Utility E Missouri Metro', territory: /missouri.*metro/i, summer: { from: '06-01', to: '09-30' } },
  { name: 'Utility E Missouri West', territory: /missouri.*west/i, summer: { from: '06-01', to: '09-30' } },
  { name: 'Utility E Kansas Central', territory: /central/i, summer: { from: '06-01', to: '09-30' } },
  { name: 'Utility E Kansas Metro', territory: /metro/i, summer: { from: '06-01', to: '09-30' } },
  { name: 'Utility E (territory not stated)', territory: /[\s\S]*/, summer: { from: '06-01', to: '09-30' } },
];
var SEASON_DEFAULT_PROVIDER = SEASON_UTILITY;

function seasonRowForProvider(provider) {
  if (!new RegExp(SEASON_UTILITY, 'i').test(provider || '')) return null;
  for (var i = 0; i < SEASON_TABLE.length; i++) {
    if (SEASON_TABLE[i].territory.test(provider)) return SEASON_TABLE[i];
  }
  return null;
}

// 'summer' | 'winter' for a service date 'YYYY-MM-DD' or 'YYYY-MM-..'; 'none' when the provider has no seasonal tariff.
function seasonOfDate(provider, iso) {
  var row = seasonRowForProvider(provider);
  if (!row) return 'none';
  var md = String(iso || '').slice(5, 10);
  return md >= row.summer.from && md <= row.summer.to ? 'summer' : 'winter';
}

// Season of a whole calendar month ('YYYY-MM' or month index 0-11): the season of its first day.
function seasonOfMonth(provider, ymOrIdx) {
  var mo = typeof ymOrIdx === 'number' ? ymOrIdx + 1 : parseInt(String(ymOrIdx || '').split('-')[1], 10);
  return seasonOfDate(provider, '0000-' + String(mo).padStart(2, '0') + '-01');
}

// Days of a service period in each season: { summer, winter, total } (the period's first and last day count
// when incl, the last day is left out when not). null when the provider has no seasonal tariff or dates are bad.
function seasonDaysOfPeriod(provider, start, end, incl) {
  if (!seasonRowForProvider(provider)) return null;
  var s = parseLocalISODate(start);
  var e = parseLocalISODate(end);
  if (!s || !e || s > e) return null;
  var out = { summer: 0, winter: 0, total: 0 };
  var cur = new Date(s);
  var n = 0;
  while ((incl === false ? cur < e : cur <= e) && n++ < 400) {
    var iso = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
    out[seasonOfDate(provider, iso)]++;
    out.total++;
    cur.setDate(cur.getDate() + 1);
  }
  return out.total ? out : null;
}

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

// Season for a given electric rate schedule + month. 'none' = no known seasonal
// split for this schedule (whole year is one season) — the safe default for a
// schedule this cascade doesn't recognize.
function _seasonForSchedule(rateSchedule, ym) {
  var code = rateSchedule || '';
  if (PUBLISHED_ELECTRIC_RATES[code] || PUBLISHED_ELECTRIC_ENERGY_ALIAS[code]) {
    return seasonOfMonth(SEASON_DEFAULT_PROVIDER, ym);
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
      var season = seasonOfMonth(SEASON_DEFAULT_PROVIDER, ym);
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

// _billSeasonRates(bill, kind, days, provider) -> { summer, winter, how } rates from the bill's OWN split
// charge lines (bill._chargeParts), or null when the bill has no usable split (the caller then prorates the
// bill's blended rate by days). A seasonal charge on a bill that crosses a season edge has two printed lines.
// Which line is summer comes from evidence on the lines, never from which rate is higher:
//   1. the line's own printed date range (part.from / part.to, saved by the extractor): the season of those
//      dates by SEASON_TABLE. how = 'label'.
//   2. the line's quantity against the day split: kW lines carry charge / rate (kW for the days of the line),
//      kWh lines carry their kWh. The assignment whose quantity share matches the share of summer days
//      (within 0.1) wins, and only when the other assignment is more than 0.1 worse. how = 'qty'.
// Either way the chosen assignment must pass the quantity check. A bill that fails both is not split.
//   kwh: on-peak + off-peak energy lines of the season, plus the non-seasonal energy charges (ECA, EER, PTS)
//        spread by the season's share of kWh, over the season's kWh.
//   kw : the season's demand line rate, plus the other demand-side charges (TDC, facilities) per billed kW.
function _billSeasonRates(bill, kind, days, provider) {
  var parts = bill && bill._chargeParts;
  if (!parts || !days || !days.total) return null;
  var dayShare = days.summer / days.total;
  var TOL = 0.1;
  function line(key) {
    var l = parts[key];
    if (!l || l.length !== 2) return null;
    var out = l.map(function (x) {
      return { rate: parseFloat(x.rate), qty: parseFloat(x.qty), charge: parseFloat(x.charge), from: x.from, to: x.to };
    });
    var ok = out.every(function (x) {
      return isFinite(x.rate) && isFinite(x.qty) && isFinite(x.charge) && x.rate > 0;
    });
    return ok ? out : null;
  }
  // Index (0 or 1) of the summer line of a pair, or -1. q = the two quantities that must match the day split.
  function summerIdx(l, q) {
    var tot = q[0] + q[1];
    if (!(tot > 0)) return { idx: -1 };
    var share0 = q[0] / tot;
    var errA = Math.abs(share0 - dayShare); // line 1 is summer
    var errB = Math.abs(share0 - (1 - dayShare)); // line 1 is winter
    var s0 = l[0].from ? seasonOfDate(provider, l[0].from) : '';
    var s1 = l[1].from ? seasonOfDate(provider, l[1].from) : '';
    if ((s0 === 'summer' && s1 === 'winter') || (s0 === 'winter' && s1 === 'summer')) {
      var i = s0 === 'summer' ? 0 : 1;
      return (i === 0 ? errA : errB) <= TOL ? { idx: i, how: 'label' } : { idx: -1 };
    }
    if (Math.min(errA, errB) > TOL || Math.abs(errA - errB) <= TOL) return { idx: -1 };
    return { idx: errA < errB ? 0 : 1, how: 'qty' };
  }
  function kwEq(x) {
    return x.charge / x.rate;
  }
  if (kind === 'kw') {
    var d = line('BilledKWCharge');
    var billedKW = parseBillNumber(bill.billedKW) || parseBillNumber(bill.demandKW) || 0;
    if (!d || !(billedKW > 0)) return null;
    var pk = summerIdx(d, [kwEq(d[0]), kwEq(d[1])]);
    if (pk.idx < 0) return null;
    var dS = d[pk.idx];
    var dW = d[1 - pk.idx];
    var otherKw = getBillKwCost(bill) + getBillFacKWCost(bill) - dS.charge - dW.charge;
    if (otherKw < -0.5) return null;
    return { summer: dS.rate + otherKw / billedKW, winter: dW.rate + otherKw / billedKW, how: pk.how };
  }
  if (kind === 'kwh') {
    var on = line('EnergyOnPeakCharge');
    var off = line('EnergyOffPeakCharge');
    if (!on || !off) return null;
    // The on-peak and off-peak lines must sit in the same order: line 1 is the same season for both.
    if (on[0].rate > on[1].rate !== off[0].rate > off[1].rate) return null;
    var pe = summerIdx(on, [on[0].qty + off[0].qty, on[1].qty + off[1].qty]);
    if (pe.idx < 0) return null;
    var onS = on[pe.idx];
    var onW = on[1 - pe.idx];
    var offS = off[pe.idx];
    var offW = off[1 - pe.idx];
    var kwhS = onS.qty + offS.qty;
    var kwhW = onW.qty + offW.qty;
    var kwhAll = kwhS + kwhW;
    if (!(kwhS > 0) || !(kwhW > 0)) return null;
    var seasonal = onS.charge + onW.charge + offS.charge + offW.charge;
    var other = getBillKwhCost(bill) - seasonal;
    if (other < -0.5) return null;
    return {
      summer: (onS.charge + offS.charge + (other * kwhS) / kwhAll) / kwhS,
      winter: (onW.charge + offW.charge + (other * kwhW) / kwhAll) / kwhW,
      how: pe.how,
    };
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   computeSeasonalBldgRates(projId, bldgId) — the ONE canonical seasonal
   marginal rate function for a building.
   Item: 2026-09-23-rate-source (single source of truth for utility rates).

   BASELINE-PERIOD rates only: the bills are each meter's baseline bills
   (m.baseline.months; project fallback months when the meter has none), never
   all history. Used for PROJECTED / estimated savings (measures, matrix, ECM
   templates). Bill-based actual savings (Project Performance / Meter Performance) do NOT use this: they use each bill's own
   rate (getStoredRate / resolveMeterRate).

   Every surface that shows or uses a building's seasonal marginal utility
   rate — the Energy Savings measure table, the Baseline & BAS Savings Report Inputs
   dialog prefill, the BAS Savings Calc rate-card autofill, and the ECM
   calculators' "Add as Measure" default — MUST call this function and MUST
   NOT re-derive its own copy. Savings dollars are always (quantity saved) x
   SEASONAL MARGINAL rate, monthly then summed, so the rate here is the same
   per-bill implied rate (cost / usage, the exact charge fields) that
   getStoredRate/getStoredKwRate already use everywhere else in the app —
   never a different charge-field subset.

   Season: SEASON_TABLE (above) by meter.provider, applied to the SERVICE DATES of each day: summer Jun 1 -
   Sep 30, winter Oct 1 - May 31 (Utility E bill definitions). A bill that crosses a season edge counts in BOTH
   seasons, weighted by its days in each. For electric kWh and kW the seasons come from the bill's own split
   charge lines (bill._chargeParts: two lines per charge; the line printed date range, else the line quantities
   against the day split, say which is summer; never the higher rate. Checked against the day
   split); a bill without usable split lines gives its one blended rate to both seasons, weighted by days. A
   provider with no seasonal tariff (the gas providers) gets ONE annual rate: summer = winter = the baseline mean.

   Returns (0, never null, so every existing `|| 0` guard keeps working):
     {
       kwhSummer, kwhWinter,   // $/kWh, electric energy, mean of per-bill
                                // getStoredRate(bill,'kwh') for bills in season
       kwhRate, kwRate,        // $/kWh and $/kW, mean of per-bill rates across the
                                // baseline bills (BAS Trends display lookup only)
       kwSummer, kwWinter,     // $/kW, electric demand, mean of per-bill
                                // getStoredKwRate(bill) for bills in season
       thermRate,              // $/Therm, gas — flat mean across baseline months
                                // (gas has no confirmed seasonal tariff split
                                // for the providers in use; gasSummer/
                                // gasWinter below are additive detail only)
       gasSummer, gasWinter,   // $/Therm, gas — seasonal mean, same bills as
                                // thermRate, bucketed by season (0 when a
                                // season has no gas bills)
       kwhMonthly, kwMonthly,  // [12] $ per unit by calendar month, only for a provider with no
       gasMonthly,             // seasonal tariff (gas): that month's baseline mean, else the annual
                                // mean. [] when the provider has seasons.
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
    kwhRate: 0,
    kwSummer: 0,
    kwWinter: 0,
    kwRate: 0,
    thermRate: 0,
    gasSummer: 0,
    gasWinter: 0,
    gallonRate: 0,
    kwhMonthly: [],
    kwMonthly: [],
    gasMonthly: [],
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

  // One BASELINE-PERIOD bill -> { ym, season, rate } for every bill with a positive rate from `rateFn`.
  // The bills are the meter's baseline bills only (_dashGetBaselineBills, app/core.js: bills whose
  // normMonth is in m.baseline.months). A meter with no baseline months of its own uses the project's
  // fallback months (_udProjBaselineMonthsFallback, app/utility-data.js), the same rule the All
  // Buildings baseline table uses. No baseline anywhere -> no rows -> rate 0.
  var fallbackMonths = null;
  var fallbackLoaded = false;
  function baselineBillsOf(meter) {
    if (meter.baseline && meter.baseline.months && meter.baseline.months.length) return _dashGetBaselineBills(meter);
    if (!fallbackLoaded) {
      fallbackLoaded = true;
      fallbackMonths = _udProjBaselineMonthsFallback(getUDBldgs(projId));
    }
    if (!fallbackMonths) return [];
    return _dashGetBaselineBills({
      bills: meter.bills,
      inclusive: meter.inclusive,
      baseline: { months: fallbackMonths },
    });
  }
  // Straddling bills by how their two seasons were set, per kind: label (printed date range), qty (line
  // quantities match the day split), days (no usable split: the bill's blended rate prorated by days).
  var straddle = { kwh: { bills: 0, label: 0, qty: 0, days: 0 }, kw: { bills: 0, label: 0, qty: 0, days: 0 } };
  // One BASELINE-PERIOD bill -> rows { ym, season, rate, w } for every bill with a positive rate from `rateFn`.
  // kind 'kwh' | 'kw' asks _billSeasonRates for the bill's own split lines. Weight w = share of the bill's days.
  function billRates(meterList, rateFn, kind) {
    var out = [];
    meterList.forEach(function (meter) {
      var incl = meter.inclusive !== false;
      var all = meter.bills || [];
      baselineBillsOf(meter).forEach(function (bill) {
        var rate = rateFn(bill);
        if (!(rate > 0)) return;
        var ym = normMonth(bill.start, bill.end, incl, all);
        var days = seasonDaysOfPeriod(meter.provider, bill.start, bill.end, incl);
        if (!days) {
          out.push({ ym: ym, season: 'none', rate: rate, w: 1 });
          return;
        }
        if (!days.summer || !days.winter) {
          out.push({ ym: ym, season: days.summer ? 'summer' : 'winter', rate: rate, w: 1 });
          return;
        }
        var split = kind ? _billSeasonRates(bill, kind, days, meter.provider) : null;
        if (kind) {
          straddle[kind].bills++;
          straddle[kind][split ? split.how : 'days']++;
        }
        ['summer', 'winter'].forEach(function (sn) {
          out.push({ ym: ym, season: sn, rate: split ? split[sn] : rate, w: days[sn] / days.total });
        });
      });
    });
    return out;
  }

  function mean(rows) {
    var sw = 0;
    var sum = 0;
    rows.forEach(function (r) {
      sw += r.w;
      sum += r.rate * r.w;
    });
    return sw > 0 ? sum / sw : 0;
  }

  // A 'none' row (provider with no seasons) counts in both seasons: one annual rate.
  function seasonSplit(rows) {
    return {
      summer: rows.filter(function (r) {
        return r.season === 'summer' || r.season === 'none';
      }),
      winter: rows.filter(function (r) {
        return r.season === 'winter' || r.season === 'none';
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

  // Provider with no seasonal tariff: the rate of each CALENDAR month = the mean of the baseline bills
  // in that month (the monthly cost of gas is captured); a month with no baseline bill takes the annual mean.
  // [] when no row is of such a provider (the seasonal summer / winter rates price instead).
  function monthlyMeans(rows, digits) {
    var flat = rows.filter(function (r) {
      return r.season === 'none';
    });
    if (!flat.length) return [];
    var annual = mean(flat);
    var scale = Math.pow(10, digits);
    var arr = [];
    for (var mo = 1; mo <= 12; mo++) {
      var inMo = flat.filter(function (r) {
        return parseInt(String(r.ym || '').split('-')[1], 10) === mo;
      });
      arr.push(Math.round((inMo.length ? mean(inMo) : annual) * scale) / scale);
    }
    return arr;
  }

  var out = empty;
  out.months = { kwhSummer: [], kwhWinter: [], kwSummer: [], kwWinter: [], gas: [], propane: [] };

  if (elecMeters.length) {
    var kwhRows = billRates(elecMeters, function (bill) {
      return getStoredRate(bill, 'kwh');
    }, 'kwh');
    var kwRows = billRates(elecMeters, getStoredKwRate, 'kw');
    var kwhSplit = seasonSplit(kwhRows);
    var kwSplit = seasonSplit(kwRows);
    out.kwhSummer = Math.round(mean(kwhSplit.summer) * 10000) / 10000;
    out.kwhWinter = Math.round(mean(kwhSplit.winter) * 10000) / 10000;
    out.kwSummer = Math.round(mean(kwSplit.summer) * 100) / 100;
    out.kwWinter = Math.round(mean(kwSplit.winter) * 100) / 100;
    // Single all-season $/kWh and $/kW for surfaces that show ONE rate (ECM form, BAS Trends).
    out.kwhRate = Math.round(mean(kwhRows) * 10000) / 10000;
    out.kwRate = Math.round(mean(kwRows) * 100) / 100;
    out.kwhMonthly = monthlyMeans(kwhRows, 4);
    out.kwMonthly = monthlyMeans(kwRows, 2);
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
    out.gasMonthly = monthlyMeans(gasRows, 3);
    out.months.gas = yms(gasRows);
  }

  if (propaneMeters.length) {
    var propaneRows = billRates(propaneMeters, function (bill) {
      return getStoredRate(bill, 'propane');
    });
    out.gallonRate = Math.round(mean(propaneRows) * 1000) / 1000;
    out.months.propane = yms(propaneRows);
  }

  out.straddle = straddle;
  return out;
}

/* ── Rate guard: the ONE check every rate write path runs ─────────────────────
   A rate typed, imported or applied by a calculator is checked two ways:
   1. Against the building's own baseline rate (computeSeasonalBldgRates), when that rate exists:
      the value must be between 0.5x and 2x of it.
   2. Against fixed plausibility bounds for the unit. The bounds come from the real bills in the
      2026-10-12 backup (all 5 projects): $/kWh 0.0200 to 0.1056 over 264 bills, $/kW 6.60 to 22.50
      over 262 bills, $/therm 0.318 to 0.900 over 520 bills, $/gallon 1.60 to 1.94 over 3 bills.
      Each bound is half the lowest and twice the highest bill rate seen, rounded outward.
   A blank or 0 value is not a rate and always passes (it clears the field).
   rateGuardCheck is pure. The write paths in app/energy-savings.js call it through
   rateGuardCheckSet (app/energy-savings.js) and ask the user, or block and log when no user is present. */
var RATE_GUARD_BOUNDS = {
  kwh: { min: 0.01, max: 0.25, unit: '$/kWh', digits: 4 },
  kw: { min: 3, max: 45, unit: '$/kW', digits: 2 },
  therm: { min: 0.15, max: 2, unit: '$/therm', digits: 3 },
  gallon: { min: 0.8, max: 4, unit: '$/gallon', digits: 3 },
};
var RATE_GUARD_BASELINE_RATIO = { low: 0.5, high: 2 };
// field name (savings matrix, baseline table or ECM template input) -> unit kind, label and the
// key of computeSeasonalBldgRates that is that field's baseline rate.
var RATE_GUARD_FIELDS = {
  kwhSummer: { kind: 'kwh', label: 'kWh summer', base: 'kwhSummer' },
  kwhWinter: { kind: 'kwh', label: 'kWh winter', base: 'kwhWinter' },
  kwSummer: { kind: 'kw', label: 'kW summer', base: 'kwSummer' },
  kwWinter: { kind: 'kw', label: 'kW winter', base: 'kwWinter' },
  thermRate: { kind: 'therm', label: 'gas', base: 'thermRate' },
  gasSummer: { kind: 'therm', label: 'gas summer', base: 'gasSummer' },
  gasWinter: { kind: 'therm', label: 'gas winter', base: 'gasWinter' },
  gallonRate: { kind: 'gallon', label: 'propane', base: 'gallonRate' },
  elec_rate: { kind: 'kwh', label: 'electric', base: 'kwhRate' },
  btm_rate: { kind: 'kwh', label: 'blended electric', base: 'kwhRate' },
  gas_rate: { kind: 'therm', label: 'gas', base: 'thermRate' },
  demand_rate: { kind: 'kw', label: 'demand', base: 'kwRate' },
};
function rateGuardKnowsField(field) {
  return Object.prototype.hasOwnProperty.call(RATE_GUARD_FIELDS, field);
}
// rateGuardCheck(field, value, baselineRates, bldgName) -> { ok:true } or
// { ok:false, field, value, baseline, min, max, unit, message }.
function rateGuardCheck(field, value, baselineRates, bldgName) {
  var f = RATE_GUARD_FIELDS[field];
  var v = typeof value === 'number' ? value : parseFloat(value);
  if (!f || !isFinite(v) || v === 0) return { ok: true };
  var b = RATE_GUARD_BOUNDS[f.kind];
  var base = baselineRates && parseFloat(baselineRates[f.base]);
  var hasBase = isFinite(base) && base > 0;
  var outAbs = v < b.min || v > b.max;
  var outBase = hasBase && (v < base * RATE_GUARD_BASELINE_RATIO.low || v > base * RATE_GUARD_BASELINE_RATIO.high);
  if (!outAbs && !outBase) return { ok: true };
  var money = function (n) {
    return '$' + n.toFixed(b.digits);
  };
  var msg =
    'The ' + f.label + ' rate ' + money(v) + ' per ' + b.unit.slice(2) + ' looks wrong. ' +
    (hasBase
      ? 'The baseline rate' + (bldgName ? ' for ' + bldgName : '') + ' is ' + money(base) + '. '
      : 'This building has no baseline rate. ') +
    'The normal range is ' + money(b.min) + ' to ' + money(b.max) + ' per ' + b.unit.slice(2) +
    (hasBase
      ? ', and within ' + RATE_GUARD_BASELINE_RATIO.low + ' to ' + RATE_GUARD_BASELINE_RATIO.high + ' times the baseline rate'
      : '') +
    '. Keep this value?';
  return {
    ok: false,
    field: field,
    value: v,
    baseline: hasBase ? base : null,
    min: b.min,
    max: b.max,
    unit: b.unit,
    message: msg,
  };
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
