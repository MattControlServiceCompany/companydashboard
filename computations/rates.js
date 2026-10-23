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

// getBillRateParts(bill, type) — the ONE answer to "which dollars and which quantity make this bill's rate".
// type 'kwh' | 'kw' | 'gas' | 'propane' | 'water' | 'sewer' | 'stormwater'. Returns { charge, usage }, 0 for a missing
// part. getStoredRate and getStoredKwRate divide them; computeSeasonalBldgRates weights each bill by `usage`.
// Propane is the all-in rate (whole delivered cost / gallons), the same rule the savings engine uses
// (computations/savings.js D-9), not the printed unit price. Stormwater has no usage: the charge is the whole
// "rate" and the quantity is one bill. The electric energy part is the kWh dollars only (getBillKwhCost); the
// demand part is demand + facilities dollars over billed kW. Gas goes through the one cost accessor and
// resolveGasUsageTherms (CCF / MMBtu become Therms).
function getBillRateParts(bill, type) {
  if (!bill) return { charge: 0, usage: 0 };
  switch (type) {
    case 'kwh':
      return {
        charge: getBillKwhCost(bill),
        usage: parseBillNumber(bill.kWhConsumed) || parseBillNumber(bill.totalKwh) || parseBillNumber(bill.kwh) || 0,
      };
    case 'kw':
      return {
        charge: getBillKwCost(bill) + getBillFacKWCost(bill),
        usage:
          parseBillNumber(bill.billedKW) ||
          parseBillNumber(bill.demandKW) ||
          parseBillNumber(bill.BilledKW) ||
          parseBillNumber(bill.ActualKW) ||
          parseBillNumber(bill.FacilitiesKW) ||
          0,
      };
    case 'gas':
      return {
        charge: getBillGasCost(bill),
        usage: typeof resolveGasUsageTherms === 'function' ? resolveGasUsageTherms(bill) : 0,
      };
    case 'propane':
      return {
        charge:
          parseBillNumber(bill.totalCost) || parseBillNumber(bill.TotalCurrentCharges) || parseBillNumber(bill.TotalAmountDue) || 0,
        usage: parseBillNumber(bill.gallonsDelivered) || parseBillNumber(bill.GallonsDelivered) || 0,
      };
    case 'water':
      // getBillUsageCharge = the bill's own water charge line; with no charge line, the bill total.
      return {
        charge:
          getBillUsageCharge(bill, 'water') || parseBillNumber(bill.totalCost) || parseBillNumber(bill.TotalCurrentCharges) || 0,
        usage: getBillUsageOrNull(bill, 'Water') || 0,
      };
    case 'sewer':
      return { charge: getBillUsageCharge(bill, 'sewer'), usage: getBillUsageOrNull(bill, 'Sewer') || 0 };
    case 'stormwater': {
      var sw = parseBillNumber(bill.stormWaterCharge) || parseBillNumber(bill.StormWaterCharge) || 0;
      return { charge: sw, usage: sw > 0 ? 1 : 0 };
    }
    default:
      return { charge: 0, usage: 0 };
  }
}

// getStoredRate(bill, type) — the ONE $/unit rate for a bill ('kwh' | 'gas' | 'propane' | 'water' |
// 'sewer' | 'stormwater'). It is COMPUTED from the bill's own dollars and usage (getBillRateParts: the one cost
// accessors above and the one usage resolver), so the rate can never disagree with the cost and usage the Bills
// table shows. The old stored copies (totalKwhRate, totalGasRate, totalWaterRate, totalSewerRate,
// totalPropaneRate, totalStormwaterRate — written by the PDF save paths, the CSV import and ensureBillRates
// until 2026-10-05, and stale after any edit) are read ONLY when the bill has no cost or no usage to compute from.
// Nothing writes them any more.
var _STORED_RATE_FIELD = {
  kwh: 'totalKwhRate',
  gas: 'totalGasRate',
  propane: 'totalPropaneRate',
  water: 'totalWaterRate',
  sewer: 'totalSewerRate',
  stormwater: 'totalStormwaterRate',
};
function getStoredRate(bill, type) {
  if (!bill || !_STORED_RATE_FIELD[type]) return 0;
  var p = getBillRateParts(bill, type);
  var computed = p.usage > 0 && p.charge > 0 ? p.charge / p.usage : 0;
  if (computed > 0) return computed;
  var stored = parseBillNumber(bill[_STORED_RATE_FIELD[type]]);
  return stored > 0 ? stored : 0;
}

// getStoredKwRate(bill) - the ONE $/kW (demand) rate for a bill.
// SSOT for the Bills table, Meter Performance, the savings engine and the missing-rate cascade.
// Computed from getBillRateParts(bill, 'kw'): demand dollars (getBillKwCost: demandCharge + tdcCharge, or the legacy
// kwCost) plus the Facilities kW cost (getBillFacKWCost), divided by billed kW. Older bills that hold only kwCost
// and facKWCost therefore give the same rate as newer bills that hold the same dollars under demandCharge
// and facilitiesCharge (WP-04, math-02 H12/D6). The stored totalKwRate is read only when the bill has
// no dollars or no kW to compute from (same rule as getStoredRate).
function getStoredKwRate(bill) {
  if (!bill) return 0;
  var p = getBillRateParts(bill, 'kw');
  if (p.usage > 0 && p.charge > 0) return p.charge / p.usage;
  var stored = parseBillNumber(bill.totalKwRate);
  return stored > 0 ? stored : 0;
}

// getMonthBillRate(bills, type) - the ONE rate of a calendar month that holds one or several bills
// (type 'kwh' | 'kw' | 'gas'). It is the usage-weighted rate: sum of the bills' charges / sum of their usage, each
// from getBillRateParts. It is never a plain mean of the per-bill rates (a small bill would then count as much as a
// large one). A bill with no charge or no usage is left out, never counted as 0. When no bill has both, the first
// bill's stored rate (getStoredRate / getStoredKwRate) is returned, else 0. With one bill it equals that bill's own rate.
function getMonthBillRate(bills, type) {
  var charge = 0,
    usage = 0;
  (bills || []).forEach(function (b) {
    var p = getBillRateParts(b, type);
    if (p.usage > 0 && p.charge > 0) {
      charge += p.charge;
      usage += p.usage;
    }
  });
  if (usage > 0) return charge / usage;
  for (var i = 0; i < (bills || []).length; i++) {
    var r = type === 'kw' ? getStoredKwRate(bills[i]) : getStoredRate(bills[i], type);
    if (r > 0) return r;
  }
  return 0;
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

// The component charges a Utility E bill prints BELOW its Subtotal line (the rest are above it, so they add up
// to the Subtotal). Printed Current Charges = Subtotal + these. One list; the extractor's customer-charge
// derivation, its printed-total check and the Stage 3 corroboration all read it.
var UTILITY_E_BELOW_SUBTOTAL_FIELDS = ['FranchiseFee', 'SalesTax', 'MiscellaneousCharge'];

// Sum of the component charges printed above the Subtotal, rounded to cents.
function sumElectricSubtotalCharges(parsed) {
  parsed = parsed || {};
  var total = 0;
  for (var i = 0; i < UTILITY_E_COMPONENT_CHARGE_FIELDS.length; i++) {
    var f = UTILITY_E_COMPONENT_CHARGE_FIELDS[i];
    if (UTILITY_E_BELOW_SUBTOTAL_FIELDS.indexOf(f) >= 0) continue;
    total += parseBillNumber(parsed[f]);
  }
  return Math.round(total * 100) / 100;
}

// The two printed-total identities of a Utility E bill, checked to the cent (tolerance $0.01):
//   linesMatchSubtotal:    the lines above the Subtotal add up to the printed Subtotal (parsed._subtotal)
//   subtotalPlusFeesMatchTotal: Subtotal + the lines below it = the printed Current Charges (TotalCurrentCharges)
// A check whose printed value was not read is null (not false).
function checkElectricPrintedTotals(parsed) {
  parsed = parsed || {};
  var subtotal = parseBillNumber(parsed._subtotal);
  var total = parseBillNumber(parsed.TotalCurrentCharges);
  var linesSum = sumElectricSubtotalCharges(parsed);
  var below = 0;
  for (var i = 0; i < UTILITY_E_BELOW_SUBTOTAL_FIELDS.length; i++) below += parseBillNumber(parsed[UTILITY_E_BELOW_SUBTOTAL_FIELDS[i]]);
  below = Math.round(below * 100) / 100;
  var subtotalPlusFees = Math.round((subtotal + below) * 100) / 100;
  return {
    subtotal: subtotal > 0 ? subtotal : null,
    linesSum: linesSum,
    belowSubtotal: below,
    total: total > 0 ? total : null,
    linesMatchSubtotal: subtotal > 0 ? Math.abs(linesSum - subtotal) <= 0.01 : null,
    subtotalPlusFeesMatchTotal: subtotal > 0 && total > 0 ? Math.abs(subtotalPlusFees - total) <= 0.01 : null,
  };
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
  while (incl === false ? cur < e : cur <= e) {
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
    return billMonth(b, bills) === ym;
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
          return billMonth(b, bills);
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
          return billMonth(b, bills);
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
//   incl:       proj.inclMonths (billMonth's inclusive/exclusive setting)
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
   SEASONAL ON-PEAK / OFF-PEAK ENERGY LINES (Matt, 2026-10-23)
   A bill that crosses the Jun 1 / Oct 1 season edge prints up to four energy lines: On-Pk Sum, On-Pk Win,
   Off-Pk Sum, Off-Pk Win, each with kWh, rate and charge. These functions are the ONE place that decides:
     touResolveLines  - raw parsed lines -> season, kWh recovery, slot, reconcile with kWh used
     touApplyToBill   - lines -> the per-line fields and the On / Off totals on a bill (the only writer)
     touRatesEntry    - lines -> the _rates entry of one side (each part carries its season)
     touHoldOf        - the one plain hold sentence when the lines do not add up to kWh used
     touLinesOfBill   - bill -> lines to show (the fields; an older bill derives its labels, display only)
   Raw line: { kind: 'on'|'off'|null, word: 'Sum'|'Win'|null, from, to (ISO or null), qty, qtyRaw (text), rate, charge }.
   ══════════════════════════════════════════════════════════════════════════ */
var TOU_SLOTS = [
  { kind: 'on', season: 'Sum', prefix: 'OnPkSum', label: 'Energy On-Pk Summer' },
  { kind: 'on', season: 'Win', prefix: 'OnPkWin', label: 'Energy On-Pk Winter' },
  { kind: 'off', season: 'Sum', prefix: 'OffPkSum', label: 'Energy Off-Pk Summer' },
  { kind: 'off', season: 'Win', prefix: 'OffPkWin', label: 'Energy Off-Pk Winter' },
];
var TOU_FIELD_NAMES = [].concat.apply(
  [],
  TOU_SLOTS.map(function (s) {
    return [s.prefix + 'KWh', s.prefix + 'Rate', s.prefix + 'Charge'];
  }),
);
var TOU_HOLD_TEXT = 'On-peak and off-peak kWh do not add up to kWh used. Check the PDF.';
function touSlotOf(kind, season) {
  for (var i = 0; i < TOU_SLOTS.length; i++) {
    if (TOU_SLOTS[i].kind === kind && TOU_SLOTS[i].season === season) return TOU_SLOTS[i];
  }
  return null;
}
function _touVerifies(q, r, charge) {
  return q > 0 && r > 0 && charge > 0 && Math.abs(Math.round(q * r * 100) / 100 - charge) < 0.005;
}
// 'Sum' | 'Win' for a raw line: the printed word, else the printed date range (SEASON_TABLE), else the period start.
function _touSeasonOf(raw, provider, periodStartIso) {
  if (raw.word) return raw.word;
  var iso = raw.from || periodStartIso;
  var s = iso ? seasonOfDate(provider || SEASON_DEFAULT_PROVIDER, iso) : 'none';
  return s === 'summer' ? 'Sum' : s === 'winter' ? 'Win' : null;
}
// The kWh of one line. Returns { kwh, rate, how } or null.
//   'read'        the printed quantity x rate = the charge (to the cent); a missing rate is charge / quantity
//   'repaired'    the thousands digits are garbled; the last 3 digits and the 4 decimals are read, the thousands are
//                 the whole number that makes quantity x rate = the charge
//   'read-unverified' a clean printed quantity and rate whose product is not the charge: the charge is the doubtful
//                 value (a misread digit); the quantity stays as printed and the older line checks decide the charge
//   'from-charge' no usable quantity: charge / rate, accepted only when round(kWh x rate, 2) = the charge
function _touLineKwh(raw) {
  var charge = raw.charge;
  if (!(charge > 0)) return null;
  var rate = raw.rate > 0 ? raw.rate : null;
  var qty = raw.qty > 0 ? raw.qty : null;
  if (!rate) {
    // A rate worked out from charge / quantity proves something only for a large quantity (below 1,000 kWh a 5-decimal
    // rate cannot miss the cent), so a small quantity with no rate stays open.
    if (!qty || qty < 1000) return null;
    var r5 = Math.round((charge / qty) * 100000) / 100000;
    return _touVerifies(qty, r5, charge) ? { kwh: qty, rate: r5, how: 'read' } : null;
  }
  if (qty && _touVerifies(qty, rate, charge)) return { kwh: qty, rate: rate, how: 'read' };
  var qr = String(raw.qtyRaw || '');
  var dec = qr.match(/[.,:]\s*(\d{4})(?!\d)/g);
  if (dec) {
    var last = dec[dec.length - 1];
    var head = qr.slice(0, qr.lastIndexOf(last)).replace(/\D/g, '');
    var tailVal = parseFloat((head.slice(-3) || '0') + '.' + last.match(/(\d{4})/)[1]);
    var k = Math.round((charge / rate - tailVal) / 1000);
    if (k >= 0) {
      var q = k * 1000 + tailVal;
      if (_touVerifies(q, rate, charge)) return { kwh: q, rate: rate, how: 'repaired' };
    }
  }
  if (qty && /^\d{1,3}(,\d{3})*\.\d{4}$/.test(qr.trim())) return { kwh: qty, rate: rate, how: 'read-unverified' };
  var qc = Math.round((charge / rate) * 10000) / 10000;
  return _touVerifies(qc, rate, charge) ? { kwh: qc, rate: rate, how: 'from-charge' } : null;
}
// raws -> { lines, complete, reconciled, sum, labelRecovered, unplaced } or null when the lines cannot be placed
// (fewer than two lines, a line with no charge, two lines for one slot, a line whose side or season cannot be told).
// lines are ordered as TOU_SLOTS. kwhUsed: the bill's kWh used (number or null).
// opts.provider, opts.periodStartIso (ISO date), opts.kwhTol (kWh of slack for a rounded kWh used).
function touResolveLines(raws, kwhUsed, opts) {
  opts = opts || {};
  if (!raws || raws.length < 2) return null;
  var items = [];
  for (var i = 0; i < raws.length; i++) {
    var raw = raws[i];
    if (!(raw.charge > 0)) return null;
    var res = _touLineKwh(raw);
    items.push({
      kind: raw.kind,
      season: _touSeasonOf(raw, opts.provider, opts.periodStartIso),
      kwh: res ? res.kwh : null,
      rate: res ? res.rate : raw.rate > 0 ? raw.rate : null,
      how: res ? res.how : null,
      charge: raw.charge,
      from: raw.from || null,
      to: raw.to || null,
    });
  }
  // One line left without a printed quantity (none, or only charge / rate): kWh used minus the other lines, kept only
  // when it fits its own charge to the cent.
  var open = items.filter(function (it) {
    return it.kwh == null || it.how === 'from-charge';
  });
  if (open.length === 1 && kwhUsed > 0) {
    var others = items.reduce(function (s, it) {
      return it === open[0] ? s : s + (it.kwh || 0);
    }, 0);
    var qI = Math.round((kwhUsed - others) * 10000) / 10000;
    var rI = open[0].rate;
    if (rI && qI > 0 && _touVerifies(qI, rI, open[0].charge)) {
      open[0].kwh = qI;
      open[0].rate = rI;
      open[0].how = 'identity';
    }
  }
  // A line with no side label (OCR lost it) takes the one free slot of its season, else the one free slot.
  var taken = {};
  var clash = false;
  items.forEach(function (it) {
    if (it.kind && it.season) {
      if (taken[it.kind + it.season]) clash = true;
      taken[it.kind + it.season] = true;
    }
  });
  if (clash) return null;
  var labelRecovered = false;
  for (var u = 0; u < items.length; u++) {
    var it2 = items[u];
    if (it2.kind && it2.season) continue;
    var free = TOU_SLOTS.filter(function (s) {
      return !taken[s.kind + s.season] && (!it2.kind || s.kind === it2.kind) && (!it2.season || s.season === it2.season);
    });
    if (free.length !== 1) return null;
    it2.kind = free[0].kind;
    it2.season = free[0].season;
    taken[it2.kind + it2.season] = true;
    labelRecovered = true;
  }
  var lines = [];
  TOU_SLOTS.forEach(function (s) {
    items.forEach(function (it) {
      if (it.kind === s.kind && it.season === s.season) {
        lines.push({
          kind: s.kind,
          season: s.season,
          prefix: s.prefix,
          label: s.label,
          kwh: it.kwh,
          rate: it.rate,
          charge: it.charge,
          from: it.from,
          to: it.to,
          how: it.how,
        });
      }
    });
  });
  if (lines.length !== items.length) return null;
  var complete = lines.every(function (l) {
    return l.kwh > 0;
  });
  var sum = lines.reduce(function (s, l) {
    return s + (l.kwh || 0);
  }, 0);
  var tol = lines.reduce(function (s, l) {
    return s + (l.how === 'from-charge' && l.rate > 0 ? 0.005 / l.rate : 0);
  }, opts.kwhTol || 0.0051);
  var reconciled = complete && kwhUsed > 0 && Math.abs(sum - kwhUsed) <= tol;
  return { lines: lines, complete: complete, reconciled: reconciled, sum: sum, tol: tol, labelRecovered: labelRecovered, unplaced: labelRecovered && !reconciled };
}
function _touSideSum(lines, kind, f) {
  var s = 0;
  var n = 0;
  lines.forEach(function (l) {
    if (l.kind === kind) {
      s += l[f] || 0;
      n++;
    }
  });
  return n ? s : null;
}
// The only writer of the per-line fields and the On / Off totals on a bill. A total is the sum of its lines; the
// kWh total is written only when every line of that side has a kWh (never a partial quantity).
function touApplyToBill(bill, lines) {
  TOU_FIELD_NAMES.forEach(function (f) {
    delete bill[f];
  });
  lines.forEach(function (l) {
    if (l.kwh > 0) bill[l.prefix + 'KWh'] = l.kwh.toFixed(4);
    if (l.rate > 0) bill[l.prefix + 'Rate'] = String(l.rate);
    bill[l.prefix + 'Charge'] = l.charge.toFixed(2);
  });
  [
    ['on', 'EnergyOnPeakCharge', 'OnPeakKWh', 'OnPeakRate'],
    ['off', 'EnergyOffPeakCharge', 'OffPeakKWh', 'OffPeakRate'],
  ].forEach(function (d) {
    var side = lines.filter(function (l) {
      return l.kind === d[0];
    });
    if (!side.length) return;
    var chg = Math.round(_touSideSum(side, d[0], 'charge') * 100) / 100;
    bill[d[1]] = chg.toFixed(2);
    var whole = side.every(function (l) {
      return l.kwh > 0;
    });
    var kwh = whole ? _touSideSum(side, d[0], 'kwh') : null;
    bill[d[2]] = kwh > 0 ? kwh.toFixed(4) : null;
    bill[d[3]] = kwh > 0 ? chg / kwh : null;
  });
}
// The _rates entry of one side from its lines (each part carries its season). Null when a line has no kWh or rate.
function touRatesEntry(lines, kind) {
  var side = lines.filter(function (l) {
    return l.kind === kind;
  });
  if (!side.length) return null;
  // A line with no kWh or rate keeps a part with qty / rate null: its amount is still a charge of the bill.
  var whole = side.every(function (l) {
    return l.kwh > 0 && l.rate > 0;
  });
  var amt = function (l) {
    return l.kwh > 0 && l.rate > 0 ? Math.round(l.kwh * l.rate * 100) / 100 : l.charge;
  };
  var qty = whole
    ? side.reduce(function (s, l) {
        return s + l.kwh;
      }, 0)
    : null;
  var computed = side.reduce(function (s, l) {
    return s + amt(l);
  }, 0);
  return {
    qty: qty,
    rate: whole ? computed / qty : null,
    unit: 'kWh',
    computed: computed,
    parts: side.map(function (l) {
      var p = {
        qty: l.kwh > 0 ? l.kwh : null,
        rate: l.rate > 0 ? l.rate : null,
        unit: 'kWh',
        computed: amt(l),
        ocrCharge: l.charge,
        season: l.season,
      };
      if (l.from && l.to) {
        p.from = l.from;
        p.to = l.to;
      }
      return p;
    }),
  };
}
// The hold sentence for a bill whose lines do not add up to kWh used, or null. Reads the per-line fields and the
// bill's kWh used as they stand now (so a later correction of kWh used is honoured).
// basisTotal: the kWh the bill's ECA / EER / PTS lines are billed on (the caller's _chargeBasisTotal), or null. The
// utility sometimes prints it a little apart from the meter-table kWh used; the lines may add up to either.
function touHoldOf(bill, basisTotal) {
  var present = TOU_SLOTS.filter(function (s) {
    return parseBillNumber(bill[s.prefix + 'Charge']) > 0;
  });
  if (!present.length) return null;
  var sum = 0;
  for (var i = 0; i < present.length; i++) {
    var q = parseBillNumber(bill[present[i].prefix + 'KWh']);
    if (!(q > 0)) return TOU_HOLD_TEXT;
    sum += q;
  }
  var used = parseBillNumber(bill.kWhConsumed);
  if (used > 0 && Math.abs(sum - used) <= (bill._touTol || 0.0051)) return null;
  if (basisTotal > 0 && Math.abs(sum - basisTotal) <= (bill._touTol || 0.0051)) return null;
  return TOU_HOLD_TEXT;
}
// After the older charge checks ran (a misread digit fixed by quantity x rate, a total corrected from the printed
// subtotal), write what they decided onto the line fields and derive the totals again from the lines.
//   1. a part amount in bill._rates that changed -> that line
//   2. a side total that changed with no part change: a side with one line -> that line; a side whose quantity x rate
//      amounts add up to the new total -> each line takes its quantity x rate amount
//   3. otherwise the lines win and the total follows them
function touSyncFromRates(bill) {
  if (!bill._touLines) return;
  var all = [];
  [
    ['on', 'EnergyOnPeakCharge'],
    ['off', 'EnergyOffPeakCharge'],
  ].forEach(function (d) {
    var side = touLinesOfBill(bill, d[0]).filter(function (l) {
      return l.stored;
    });
    if (!side.length) return;
    var r = bill._rates && bill._rates[d[1]];
    var parts = (r && r.parts) || [];
    var partOf = function (l) {
      return parts.filter(function (p) {
        return p.season === l.season;
      })[0];
    };
    side.forEach(function (l) {
      var p = partOf(l);
      var amt = p ? (p.ocrCharge != null ? p.ocrCharge : p.computed) : null;
      if (amt > 0 && Math.abs(amt - l.charge) > 0.005) l.charge = amt;
    });
    var sum = side.reduce(function (s, l) {
      return s + l.charge;
    }, 0);
    var total = parseBillNumber(bill[d[1]]);
    if (total > 0 && Math.abs(sum - total) > 0.005) {
      if (side.length === 1) side[0].charge = total;
      else {
        var comp = side.map(function (l) {
          var p = partOf(l);
          return p && p.computed != null ? p.computed : null;
        });
        var compSum = comp.reduce(function (s, c) {
          return s + (c || 0);
        }, 0);
        if (comp.every(function (c) { return c > 0; }) && Math.abs(compSum - total) <= 0.005) {
          side.forEach(function (l, i) {
            l.charge = comp[i];
          });
        }
      }
    }
    all = all.concat(side);
  });
  if (all.length) touApplyToBill(bill, all);
}
// Which of two lines is the summer line, from evidence on the lines: their printed dates (season of the dates), else
// their quantities against the share of summer days. froms = ['YYYY-MM-DD'|null, ...], q = the 2 quantities that must
// match the day split. Returns { idx, how } (idx 0 or 1, or -1 when the evidence does not decide).
function seasonIdxOfPair(provider, froms, q, dayShare, tol) {
  var tot = q[0] + q[1];
  if (!(tot > 0)) return { idx: -1 };
  var share0 = q[0] / tot;
  var errA = Math.abs(share0 - dayShare); // line 1 is summer
  var errB = Math.abs(share0 - (1 - dayShare)); // line 1 is winter
  var s0 = froms[0] ? seasonOfDate(provider, froms[0]) : '';
  var s1 = froms[1] ? seasonOfDate(provider, froms[1]) : '';
  if ((s0 === 'summer' && s1 === 'winter') || (s0 === 'winter' && s1 === 'summer')) {
    var i = s0 === 'summer' ? 0 : 1;
    return (i === 0 ? errA : errB) <= tol ? { idx: i, how: 'label' } : { idx: -1 };
  }
  if (Math.min(errA, errB) > tol || Math.abs(errA - errB) <= tol) return { idx: -1 };
  return { idx: errA < errB ? 0 : 1, how: 'qty' };
}
// Season labels for the two parts of one side of an older bill, or null.
function _touPairSeasons(norm, provider, bill) {
  var iso = function (s) {
    var m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : /^\d{4}-\d{2}-\d{2}/.test(s || '') ? String(s).slice(0, 10) : null;
  };
  var days = seasonDaysOfPeriod(provider, iso(bill.BillingPeriodStart), iso(bill.BillingPeriodEnd), true);
  if (!days) return null;
  var pick = seasonIdxOfPair(provider, [norm[0].from || null, norm[1].from || null], [norm[0].kwh || 0, norm[1].kwh || 0], days.summer / days.total, 0.1);
  if (pick.idx < 0) return null;
  return pick.idx === 0 ? ['Sum', 'Win'] : ['Win', 'Sum'];
}
// Lines to show for a bill, one side ('on' | 'off'). The per-line fields when the bill has them. An older bill has
// only the totals and _chargeParts: the season comes from the part's own label, else its printed dates, else the
// quantity against the day split of the period; with no evidence a line shows no season. Display only; no stored
// value changes.
function touLinesOfBill(bill, kind, provider) {
  provider = provider || SEASON_DEFAULT_PROVIDER;
  var out = [];
  TOU_SLOTS.forEach(function (s) {
    if (s.kind !== kind) return;
    var ch = parseBillNumber(bill[s.prefix + 'Charge']);
    if (ch > 0) {
      out.push({
        kind: kind,
        season: s.season,
        prefix: s.prefix,
        label: s.label,
        kwh: parseBillNumber(bill[s.prefix + 'KWh']) || null,
        rate: parseBillNumber(bill[s.prefix + 'Rate']) || null,
        charge: ch,
        stored: true,
      });
    }
  });
  if (out.length) return out;
  var key = kind === 'on' ? 'EnergyOnPeakCharge' : 'EnergyOffPeakCharge';
  var parts =
    (bill._chargeParts && bill._chargeParts[key]) || (bill._rates && bill._rates[key] && bill._rates[key].parts) || null;
  if (!parts || !parts.length) return out;
  var norm = parts.map(function (p) {
    return {
      kwh: parseBillNumber(p.qty) || null,
      rate: parseBillNumber(p.rate) || null,
      charge: p.charge != null ? parseBillNumber(p.charge) : p.ocrCharge != null ? parseBillNumber(p.ocrCharge) : parseBillNumber(p.computed),
      from: p.from || null,
      season: p.season || null,
    };
  });
  if (norm.length === 2 && !(norm[0].season && norm[1].season)) {
    var pair = _touPairSeasons(norm, provider, bill);
    if (pair) {
      norm[0].season = pair[0];
      norm[1].season = pair[1];
    }
  }
  norm.forEach(function (p, i) {
    var slot = p.season ? touSlotOf(kind, p.season) : null;
    out.push({
      kind: kind,
      season: p.season,
      prefix: slot ? slot.prefix : null,
      label: slot ? slot.label : kind === 'on' ? 'Energy On-Pk' : 'Energy Off-Pk',
      kwh: p.kwh,
      rate: p.rate,
      charge: p.charge,
      stored: false,
      idx: i,
    });
  });
  return out;
}

// _billSeasonRates(bill, kind, days, provider) -> { summer, winter, summerQty, winterQty, how } rates from the bill's OWN split
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
      return { rate: parseFloat(x.rate), qty: parseFloat(x.qty), charge: parseFloat(x.charge), from: x.from, to: x.to, season: x.season };
    });
    var ok = out.every(function (x) {
      return isFinite(x.rate) && isFinite(x.qty) && isFinite(x.charge) && x.rate > 0;
    });
    return ok ? out : null;
  }
  // Index (0 or 1) of the summer line of a pair, or -1. q = the two quantities that must match the day split.
  function summerIdx(l, q) {
    // 1. the season the extractor printed on the line (bill._chargeParts season: Sum / Win)
    if ((l[0].season === 'Sum' && l[1].season === 'Win') || (l[0].season === 'Win' && l[1].season === 'Sum')) {
      var tot = q[0] + q[1];
      if (!(tot > 0)) return { idx: -1 };
      var i0 = l[0].season === 'Sum' ? 0 : 1;
      var sh = q[0] / tot;
      return Math.abs(i0 === 0 ? sh - dayShare : sh - (1 - dayShare)) <= TOL ? { idx: i0, how: 'label' } : { idx: -1 };
    }
    // 2. the printed dates, 3. the quantities against the day split (one function: seasonIdxOfPair)
    return seasonIdxOfPair(provider, [l[0].from, l[1].from], q, dayShare, TOL);
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
    return {
      summer: dS.rate + otherKw / billedKW,
      winter: dW.rate + otherKw / billedKW,
      summerQty: kwEq(dS),
      winterQty: kwEq(dW),
      how: pk.how,
    };
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
      summerQty: kwhS,
      winterQty: kwhW,
      how: pe.how,
    };
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   computeSeasonalBldgRates(projId, bldgId[, meterId]) — the ONE canonical seasonal
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
   SEASONAL MARGINAL rate, monthly then summed, so the charge and usage behind
   the rate are the same per-bill dollars and quantity (getBillRateParts, the
   exact charge fields) that getStoredRate/getStoredKwRate divide everywhere
   else in the app — never a different charge-field subset.

   USAGE-WEIGHTED (2026-10-13): every rate here (kWh, kW, Therm, gallon, water, sewer, stormwater; per season, per
   calendar month, annual) = sum of the charges / sum of the usage over the bills in that bucket, never the plain
   mean of per-bill rates (one bill with tiny usage or a wrong usage must not outweigh the rest). Where a straddling
   Evergy bill gives printed split lines, each season takes its line rate and is weighted by that line's quantity;
   a straddling bill without split lines gives its usage prorated by its days in each season.
   LEFT-OUT BILLS: a baseline bill that computeMeterRateExclusions (computations/bill-flags.js) flags as a usage /
   charge mismatch gives no rate; each is listed in `excluded`. Bill data is never changed.

   Season: SEASON_TABLE (above) by meter.provider, applied to the SERVICE DATES of each day: summer Jun 1 -
   Sep 30, winter Oct 1 - May 31 (Utility E bill definitions). A bill that crosses a season edge counts in BOTH
   seasons, weighted by its days in each. For electric kWh and kW the seasons come from the bill's own split
   charge lines (bill._chargeParts: two lines per charge; the line printed date range, else the line quantities
   against the day split, say which is summer; never the higher rate. Checked against the day
   split); a bill without usable split lines gives its one blended rate to both seasons, weighted by days. A
   provider with no seasonal tariff (the gas providers) gets ONE annual rate: summer = winter = the baseline mean.

   Returns (0, never null, so every existing `|| 0` guard keeps working):
     {
       kwhSummer, kwhWinter,   // $/kWh, electric energy, usage-weighted over the bills in season
       kwhRate, kwRate,        // $/kWh and $/kW, usage-weighted across the
                                // baseline bills (BAS Trends display lookup only)
       kwSummer, kwWinter,     // $/kW, electric demand, usage-weighted (billed kW) over the bills in season
       thermRate,              // $/Therm, gas — usage-weighted across baseline months
                                // (gas has no confirmed seasonal tariff split
                                // for the providers in use; gasSummer/
                                // gasWinter below are additive detail only)
       gasSummer, gasWinter,   // $/Therm, gas — seasonal weighted rate, same bills as
                                // thermRate, bucketed by season (0 when a
                                // season has no gas bills)
       kwhMonthly, kwMonthly,  // [12] $ per unit by calendar month, only for a provider with no
       gasMonthly,             // seasonal tariff (gas, propane, a blank provider name): that month's
       gallonMonthly,          // weighted rate, else the annual rate. [] when the provider has seasons.
       waterRate, sewerRate,   // $ per bill unit (waterUnit / sewerUnit = the meter's own bill unit), usage-weighted;
       stormwaterRate,         // $ per bill (mean monthly charge); *Monthly = month-by-month like gas
       gallonRate,             // $/Gallon, propane — usage-weighted (gallonMonthly is the month-by-month rate)
       months: {                // which bill months fed each bucket, for the
         kwhSummer: [...ym],    // "which bill months it came from" label
         kwhWinter: [...ym],    // every surface must show (plan step 3)
         kwSummer: [...ym],
         kwWinter: [...ym],
         gas: [...ym],
         propane: [...ym],
       },
       excluded: [{ meterId, commodity, billId, start, end, ym, usage, charge, rules, reason }]
                                // baseline bills left out of every rate above (see LEFT-OUT BILLS)
     }
───────────────────────────────────────────────────────────────────────── */
function computeSeasonalBldgRates(projId, bldgId, onlyMeterId) {
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
    waterRate: 0,
    sewerRate: 0,
    stormwaterRate: 0,
    waterUnit: '',
    sewerUnit: '',
    stormwaterUnit: '',
    waterMonthly: [],
    sewerMonthly: [],
    stormwaterMonthly: [],
    kwhMonthly: [],
    kwMonthly: [],
    gasMonthly: [],
    gallonMonthly: [],
    months: { kwhSummer: [], kwhWinter: [], kwSummer: [], kwWinter: [], gas: [], propane: [], water: [], sewer: [], stormwater: [] },
    excluded: [],
  };
  var b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return empty;
  // onlyMeterId (optional): the same rule for one meter (the Baseline tab pills of that meter).
  var meters = (b.meters || []).filter(function (m) {
    return onlyMeterId == null || m.id === onlyMeterId;
  });
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
  // billMonth is in m.baseline.months). A meter with no baseline months of its own uses the project's
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
  // Baseline bills left out of every rate: the bills computeMeterRateExclusions (computations/bill-flags.js, the one
  // predicate) flags as a usage / charge mismatch. One record per bill, listed in out.excluded. Bill data is not changed.
  var exclusionsByMeter = {};
  var excludedLog = [];
  var excludedSeen = {};
  function exclusionsOf(meter) {
    if (!exclusionsByMeter[meter.id]) exclusionsByMeter[meter.id] = computeMeterRateExclusions(meter, b);
    return exclusionsByMeter[meter.id];
  }
  var commodityKey = { Electric: 'kwh', Gas: 'gas', Propane: 'propane', Water: 'water', Sewer: 'sewer', Stormwater: 'stormwater' };
  function noteExcluded(meter, bill, ym, hit) {
    var id = meter.id + '|' + bill.id;
    if (excludedSeen[id]) return;
    excludedSeen[id] = true;
    var key = commodityKey[meter.commodity];
    var parts = getBillRateParts(bill, key);
    excludedLog.push({
      meterId: meter.id,
      commodity: meter.commodity,
      billId: bill.id,
      start: bill.start,
      end: bill.end,
      ym: ym,
      usage: parts.usage,
      charge: meter.commodity === 'Water' || meter.commodity === 'Sewer' ? parts.charge : parseBillNumber(bill.totalCost) || 0,
      rules: hit.map(function (h) {
        return h.rule;
      }),
      reason: hit
        .map(function (h) {
          return h.message;
        })
        .join(' '),
    });
  }
  // Straddling bills by how their two seasons were set, per kind: label (printed date range), qty (line
  // quantities match the day split), days (no usable split: the bill's blended rate prorated by days).
  var straddle = { kwh: { bills: 0, label: 0, qty: 0, days: 0 }, kw: { bills: 0, label: 0, qty: 0, days: 0 } };
  // One BASELINE-PERIOD bill -> rows { ym, season, rate, q } for every bill with a positive rate. `type` is the
  // getBillRateParts type; rate = charge / usage of the bill, q = the usage the row stands for (its weight). A bill
  // on the exclusion list gives no row. kind 'kwh' | 'kw' asks _billSeasonRates for the bill's own split lines: each
  // season then carries its own line rate and the quantity of that line. A bill without split lines, or in one season,
  // carries its usage (prorated by its days in each season when it straddles).
  function billRates(meterList, type, kind) {
    var out = [];
    meterList.forEach(function (meter) {
      var incl = meter.inclusive !== false;
      var all = meter.bills || [];
      baselineBillsOf(meter).forEach(function (bill) {
        var parts = getBillRateParts(bill, type);
        if (!(parts.usage > 0 && parts.charge > 0)) return;
        var rate = parts.charge / parts.usage;
        var ym = billMonth(bill, all);
        var hit = exclusionsOf(meter)[bill.id];
        if (hit) {
          noteExcluded(meter, bill, ym, hit);
          return;
        }
        var days = seasonDaysOfPeriod(meter.provider, bill.start, bill.end, incl);
        if (!days) {
          out.push({ ym: ym, season: 'none', rate: rate, q: parts.usage });
          return;
        }
        if (!days.summer || !days.winter) {
          out.push({ ym: ym, season: days.summer ? 'summer' : 'winter', rate: rate, q: parts.usage });
          return;
        }
        var split = kind ? _billSeasonRates(bill, kind, days, meter.provider) : null;
        if (kind) {
          straddle[kind].bills++;
          straddle[kind][split ? split.how : 'days']++;
        }
        ['summer', 'winter'].forEach(function (sn) {
          out.push({
            ym: ym,
            season: sn,
            rate: split ? split[sn] : rate,
            q: split ? split[sn + 'Qty'] : (parts.usage * days[sn]) / days.total,
          });
        });
      });
    });
    return out;
  }

  // Usage-weighted: sum of (rate x quantity) / sum of quantity = sum of charges / sum of usage over the rows.
  function mean(rows) {
    var sw = 0;
    var sum = 0;
    rows.forEach(function (r) {
      sw += r.q;
      sum += r.rate * r.q;
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

  // A provider with no seasonal tariff (gas, propane, or a blank / other provider name): the rate of each
  // CALENDAR month = the mean of the baseline bills in that month (the monthly cost is captured, no season is
  // invented); a month with no baseline bill takes the annual mean. When a building mixes such a meter with a
  // seasonal-tariff meter, the seasonal meter's bills count in the months of their own season (the array wins
  // over the flat summer / winter rates in measureRateAt, so it must carry both).
  // [] when no row is of such a provider (the seasonal summer / winter rates price instead).
  function monthlyMeans(rows, digits) {
    if (
      !rows.some(function (r) {
        return r.season === 'none';
      })
    )
      return [];
    var annual = mean(rows);
    var scale = Math.pow(10, digits);
    var arr = [];
    for (var mo = 1; mo <= 12; mo++) {
      var moSeason = seasonOfMonth(SEASON_DEFAULT_PROVIDER, mo - 1);
      var inMo = rows.filter(function (r) {
        return (
          parseInt(String(r.ym || '').split('-')[1], 10) === mo && (r.season === 'none' || r.season === moSeason)
        );
      });
      arr.push(Math.round((inMo.length ? mean(inMo) : annual) * scale) / scale);
    }
    return arr;
  }

  var out = empty;
  out.months = { kwhSummer: [], kwhWinter: [], kwSummer: [], kwWinter: [], gas: [], propane: [], water: [], sewer: [], stormwater: [] };

  if (elecMeters.length) {
    var kwhRows = billRates(elecMeters, 'kwh', 'kwh');
    var kwRows = billRates(elecMeters, 'kw', 'kw');
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
    // Gas: cost and Therms of each bill from getBillRateParts(bill, 'gas') (gas cost accessor / resolveGasUsageTherms).
    var gasRows = billRates(gasMeters, 'gas');
    var gasSplit = seasonSplit(gasRows);
    out.gasSummer = Math.round(mean(gasSplit.summer) * 1000) / 1000;
    out.gasWinter = Math.round(mean(gasSplit.winter) * 1000) / 1000;
    out.thermRate = Math.round(mean(gasRows) * 1000) / 1000;
    out.gasMonthly = monthlyMeans(gasRows, 3);
    out.months.gas = yms(gasRows);
  }

  if (propaneMeters.length) {
    var propaneRows = billRates(propaneMeters, 'propane');
    out.gallonRate = Math.round(mean(propaneRows) * 1000) / 1000;
    out.gallonMonthly = monthlyMeans(propaneRows, 3);
    out.months.propane = yms(propaneRows);
  }

  // Water, sewer, stormwater: the bill's own unit (meter.billUnit: gal, kgal, ccf ...), never converted. Water and
  // sewer are $/unit; stormwater has no usage, its rate is the mean monthly charge ($/bill). Meters of one commodity
  // with different bill units cannot be averaged: no rate (0) and no unit. Monthly array like gas.
  [
    ['Water', 'water', 'waterRate', 'waterUnit', 'waterMonthly'],
    ['Sewer', 'sewer', 'sewerRate', 'sewerUnit', 'sewerMonthly'],
    ['Stormwater', 'stormwater', 'stormwaterRate', 'stormwaterUnit', 'stormwaterMonthly'],
  ].forEach(function (c) {
    var ms = meters.filter(function (m) {
      return m.commodity === c[0];
    });
    if (!ms.length) return;
    var units = {};
    ms.forEach(function (m) {
      units[c[1] === 'stormwater' ? 'bill' : getMeterBillUnit(m)] = 1;
    });
    if (Object.keys(units).length !== 1) return;
    var rows = billRates(ms, c[1]);
    out[c[2]] = Math.round(mean(rows) * 100000) / 100000;
    out[c[3]] = Object.keys(units)[0];
    out[c[4]] = monthlyMeans(rows, 5);
    out.months[c[1]] = yms(rows);
  });

  out.excluded = excludedLog;
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
function _rateMonthLabel(ym) {
  var parts = ym.split('-');
  var mo = parseInt(parts[1], 10) - 1;
  return (_RATE_MO_ABBR[mo] || ym) + ' ' + parts[0];
}
function formatBillMonthsLabel(ymList) {
  var list = (ymList || []).filter(Boolean).slice().sort();
  if (!list.length) return 'no bills';
  var first = _rateMonthLabel(list[0]);
  var last = _rateMonthLabel(list[list.length - 1]);
  var countLabel = list.length + (list.length === 1 ? ' bill' : ' bills');
  return first === last ? first + ' (' + countLabel + ')' : first + ' – ' + last + ' (' + countLabel + ')';
}
// formatExcludedBillsLabel(excluded) — "2 bills excluded: Nov 2025, Dec 2025" for the owner's `excluded` list
// (computeSeasonalBldgRates), '' when none. The text every rate surface shows next to a rate.
function formatExcludedBillsLabel(excluded) {
  var list = (excluded || []).slice().sort(function (x, y) {
    return String(x.ym).localeCompare(String(y.ym));
  });
  if (!list.length) return '';
  return (
    list.length +
    (list.length === 1 ? ' bill' : ' bills') +
    ' excluded: ' +
    list
      .map(function (e) {
        return e.ym ? _rateMonthLabel(e.ym) : e.start;
      })
      .join(', ')
  );
}
