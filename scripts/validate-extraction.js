// Extraction validator (backlog: bill-extraction ground-truth diff).
//
// Diffs the app's real bill extraction against a human-verified ground-truth
// fixture, field by field. Does NOT change any extraction logic — read-only
// diagnostic. Two inputs:
//   1. Ground truth (authoritative, single source of truth, never forked):
//      C:\Users\Matt Miller\AI\_context\ground-truth\louisburg-bills.json
//   2. Extraction output: a headless sweep result JSON produced by running
//      the app's own client-side extraction (app/bill-analysis.js +
//      app/energy-savings.js) against every source PDF referenced by the
//      ground truth. Generate it with:
//        node "C:\Users\Matt Miller\AI\_context\temp\validator-sweep\run-sweep.js"
//      (adapted from the investigator's full-sweep-v2.js harness — same
//      window._pdfMultiBills completion signal, no fixed-timeout race).
//      Override the sweep results path with SWEEP_RESULTS=<path>.
//
// Matching (bill -> extracted record) reuses the app's OWN dup-matcher
// normalization from _checkDuplicates() in app/bill-analysis.js:
//   - account numbers: strip whitespace/dashes, strip leading zeros, lowercase
//   - billing periods: "close" when both start AND end are within
//     FUZZY_DAY_TOLERANCE (5) days of each other
//
// Usage:
//   node scripts/validate-extraction.js
//
// Exit code: 0 if every compared field matched, 1 if any field failed
// (report is always printed in full before exiting, either way).

const fs = require('fs');
const path = require('path');

const GT_PATH = 'C:\\Users\\Matt Miller\\AI\\_context\\ground-truth\\louisburg-bills.json';
const SWEEP_RESULTS_PATH =
  process.env.SWEEP_RESULTS || 'C:\\Users\\Matt Miller\\AI\\_context\\temp\\validator-sweep\\sweep-results.json';
// Deliberately SEPARATE from SWEEP_RESULTS_PATH. The 11 PDFs the gas ground
// truth references (louisburg-gt-gas-1/-2.json) were never part of the
// original 17-file electric sweep. Two of them (SKM_C551i26081114010.pdf,
// SKM_C551i26080715250.pdf) also happen to contain Evergy electric pages —
// merging their extraction into sweep-results.json would silently change
// which electric ground-truth bills get matched (50->54, 1180->1253 fields)
// even though no electric scoring LOGIC changed. Keeping the gas sweep in
// its own file guarantees the electric path stays byte-for-byte unchanged.
const GAS_SWEEP_RESULTS_PATH =
  process.env.GAS_SWEEP_RESULTS ||
  'C:\\Users\\Matt Miller\\AI\\_context\\temp\\validator-sweep\\sweep-results-gas.json';
const OUT_PATH =
  process.env.VALIDATION_OUT || 'C:\\Users\\Matt Miller\\AI\\_context\\temp\\validator-sweep\\validation-results.json';

const FUZZY_DAY_TOLERANCE = 5; // matches _checkDuplicates() in app/bill-analysis.js

// ---------------------------------------------------------------------------
// Field maps: ground-truth dotted-path -> extracted record field name.
// Electric (Evergy) bills use the `meter` / `energy` / `charges` ground-truth
// objects. The one City-of-Louisburg combined municipal bill (bill_type:
// "gas") uses a different, non-Evergy field set (see GAS_FIELD_MAP below) —
// it has no kWh/on-off-peak/demand columns at all.
// ---------------------------------------------------------------------------
const ELECTRIC_FIELD_MAP = {
  meter: {
    start_read: 'StartRead',
    end_read: 'EndRead',
    read_difference: 'ReadDifference',
    meter_multiplier: 'MeterMultiplier',
    kwh_used: 'kWhConsumed',
    kw_used: 'ActualKW',
    rkva_used: 'ActualRKVA',
  },
  energy: {
    on_peak_kwh: 'OnPeakKWh',
    on_peak_rate: 'OnPeakRate',
    off_peak_kwh: 'OffPeakKWh',
    off_peak_rate: 'OffPeakRate',
  },
  charges: {
    customer_charge: 'CustomerCharge',
    facilities_charge: 'FacilitiesCharge',
    facilities_kw: 'FacilitiesKW',
    facilities_rate: 'FacilitiesRate',
    demand_charge: 'BilledKWCharge',
    demand_kw: 'BilledKW',
    demand_rate: 'DemandRate',
    energy_on_peak_charge: 'EnergyOnPeakCharge',
    energy_off_peak_charge: 'EnergyOffPeakCharge',
    eca_charge: 'ECACharge',
    eer_charge: 'EERCharge',
    pts_charge: 'PTSCharge',
    tdc_charge: 'TDCCharge',
    tdc_kw: 'TDCkW',
    tdc_rate: 'TDCRate',
    tax_exempt_delivery_cost: 'TaxExemptDelivery',
    bill_offset: 'BillOffset',
    subtotal: 'TotalCurrentCharges',
    current_charges: 'TotalCurrentCharges',
    rkva_charge: 'RkVACharge',
    rkva_rate: 'RkVARate',
    franchise_fee: 'FranchiseFee',
    total_amount_due: 'TotalAmountDue',
  },
};

// The one bill_type:"gas" record (City of Louisburg combined municipal bill,
// not Evergy — no kWh/on-off-peak/demand columns).
const GAS_FIELD_MAP = {
  charges: {
    water: 'WaterCharge',
    gas: 'GasCharge',
    fuel_adjustment: 'FuelAdjustment',
    water_protection: 'WaterProtectionFee',
    sewer: 'SewerCharge',
    stormwater: 'StormWaterCharge',
    current_bill: 'TotalAmountDue',
    total_amount_due: 'TotalAmountDue',
  },
};
const GAS_METER_READING_FIELDS = [{ gtPath: 'meter_readings.gas.usage', extField: 'NaturalGasTherms' }];

// ---------------------------------------------------------------------------
// GAS GROUND TRUTH (louisburg-gt-gas-1.json / -gas-2.json), added
// 2026-08-25. Separate ground-truth fixture set covering all City of
// Louisburg combined municipal bills (gas+water+sewer+stormwater and
// water-only accounts), 25 bills total. Schema differs from the single
// bill_type:"gas" record embedded in the electric fixture (see
// GAS_FIELD_MAP above, left untouched) — here `water`/`gas` are top-level
// objects (or, for multi-meter water service, an array of per-meter
// objects), and `sewer_charge`/`stormwater_charge`/`water_protection_fee`
// are top-level siblings, not nested under `charges`.
//
// Extraction model note: app/bill-analysis.js does NOT emit one combined
// record per account+period for these bills. It splits each municipal-bill
// page into ONE EXTRACTED RECORD PER COMMODITY (Commodity: 'Gas' | 'Water'
// | 'Sewer' | 'Stormwater'), all sharing the same AccountNumber/billing
// period. So matching a gas-ground-truth bill requires finding the right
// *commodity-tagged* extracted record for each field group, not a single
// merged record like the electric path uses.
// ---------------------------------------------------------------------------
const GAS_GT_PATHS = [
  'C:\\Users\\Matt Miller\\AI\\_context\\ground-truth\\louisburg-gt-gas-1.json',
  'C:\\Users\\Matt Miller\\AI\\_context\\ground-truth\\louisburg-gt-gas-2.json',
];

// gt dotted-path -> extractor field, grouped by which Commodity-tagged
// extracted record to read it from.
const MUNICIPAL_COMMODITY_FIELDS = {
  gas: {
    commodity: 'Gas',
    fields: {
      'gas.meter_start_read': 'StartRead',
      'gas.meter_end_read': 'EndRead',
      'gas.therms': 'NaturalGasTherms',
      'gas.gas_charge': 'GasCharge',
      'gas.fuel_adjustment': 'FuelAdjustment',
    },
  },
  sewer: {
    commodity: 'Sewer',
    fields: { sewer_charge: 'SewerCharge' },
  },
  stormwater: {
    commodity: 'Stormwater',
    fields: { stormwater_charge: 'StormWaterCharge' },
  },
};

// total_current_charges / total_amount_due are intentionally NOT compared:
// the extractor has no single field representing the full combined-bill
// total across commodities (each commodity's own TotalAmountDue is only
// that commodity's subtotal) -- comparing gt's grand total against any one
// commodity record would be a structurally-guaranteed mismatch, not a real
// extraction defect. Logged as unmapped instead.
const MUNICIPAL_KNOWN_UNMAPPED_TOP = ['total_current_charges', 'total_amount_due'];

// Fields intentionally NOT diffed (no corresponding extractor field / not
// captured by the app's model, e.g. account-balance bookkeeping on the
// municipal bill). Logged separately, never counted as pass or fail.
const KNOWN_UNMAPPED = new Set([
  'charges.previous_balance',
  'charges.payments',
  'charges.adjustments',
  'charges.penalty',
  'charges.account_balance',
  'charges.amount_due_after_due_date',
  'charges.eca_charge_parts',
  'charges.pts_charge_parts',
  'charges.demand_charges',
  'charges.eca_charges',
  'charges.tdc_charges',
  'charges.facilities_charge_note',
  'charges.facilities_charge_kw',
  'charges.facilities_charge_rate',
  'charges.demand_charge_kw',
  'charges.demand_charge_rate',
  'charges.rkva_charge_kw',
  'charges.rkva_charge_rate',
  'charges.rkva_kw',
  'charges.louisburg_franchise_fee',
  'charges.kansas_state_sales_tax_6.5pct',
  'charges.louisburg_city_sales_tax_1.5pct',
  'charges.miami_county_sales_tax_1.5pct',
  'energy.on_peak_note',
  'energy.off_peak_note',
  'energy.on_peak_sum_kwh',
  'energy.on_peak_sum_rate',
  'energy.off_peak_sum_kwh',
  'energy.off_peak_sum_rate',
  'energy.on_peak_win_kwh',
  'energy.on_peak_win_rate',
  'energy.off_peak_win_kwh',
  'energy.off_peak_win_rate',
  'charges.energy_on_peak_sum_charge',
  'charges.energy_off_peak_sum_charge',
  'charges.energy_on_peak_win_charge',
  'charges.energy_off_peak_win_charge',
]);

// ---------------------------------------------------------------------------
// Matching helpers — reused verbatim from _checkDuplicates() in
// app/bill-analysis.js so this validator's notion of "same bill" matches the
// app's own duplicate detector.
// ---------------------------------------------------------------------------
const normAcct = (v) =>
  (v || '')
    .toString()
    .replace(/[\s\-]/g, '')
    .replace(/^0+/, '')
    .toLowerCase();

function dayDiff(a, b) {
  if (!a || !b) return Infinity;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da) || isNaN(db)) return Infinity;
  return Math.abs((da - db) / 86400000);
}
function periodClose(s1, e1, s2, e2) {
  return (
    !!s1 && !!e1 && !!s2 && !!e2 && dayDiff(s1, s2) <= FUZZY_DAY_TOLERANCE && dayDiff(e1, e2) <= FUZZY_DAY_TOLERANCE
  );
}
function toISO(d) {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  let p = d.split('/');
  if (p.length !== 3) p = d.split('-');
  if (p.length !== 3) return d;
  const yr = p[2].length === 2 ? '20' + p[2] : p[2];
  return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Numeric compare: round to 4 decimals, exact match required after rounding.
// ---------------------------------------------------------------------------
function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,$]/g, ''));
  return isNaN(n) ? null : n;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function numbersMatch(expected, actual) {
  const e = parseNum(expected);
  const a = parseNum(actual);
  if (e === null && a === null) return true;
  if (e === null || a === null) return false;
  return round4(e) === round4(a);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------
if (!fs.existsSync(GT_PATH)) {
  console.error('FATAL: ground truth not found at ' + GT_PATH);
  process.exit(2);
}
if (!fs.existsSync(SWEEP_RESULTS_PATH)) {
  console.error(
    'FATAL: extraction sweep results not found at ' +
      SWEEP_RESULTS_PATH +
      '\nGenerate it first with: node "C:\\Users\\Matt Miller\\AI\\_context\\temp\\validator-sweep\\run-sweep.js"',
  );
  process.exit(2);
}

const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
const sweep = JSON.parse(fs.readFileSync(SWEEP_RESULTS_PATH, 'utf8'));
// Gas sweep is optional at load time (only needed once we reach the gas run
// near the end of the file) but checked eagerly here so failures surface
// before burning time on the electric run.
if (!fs.existsSync(GAS_SWEEP_RESULTS_PATH)) {
  console.error(
    'FATAL: gas extraction sweep results not found at ' +
      GAS_SWEEP_RESULTS_PATH +
      '\nGenerate it first with: node "C:\\Users\\Matt Miller\\AI\\_context\\temp\\validator-sweep\\run-gas-sweep.js"',
  );
  process.exit(2);
}
const sweepGas = JSON.parse(fs.readFileSync(GAS_SWEEP_RESULTS_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Match each ground-truth bill to an extracted record
// ---------------------------------------------------------------------------
function findExtractedBill(gtBill) {
  const file = gtBill.source.split('#')[0];
  const fileResult = sweep[file];
  if (!fileResult) return { status: 'NO_SWEEP_DATA', file };
  if (!fileResult.ok) return { status: 'SWEEP_FAILED', file, error: fileResult.error };

  const wantAcct = normAcct(gtBill.account_number);
  const wantStart = gtBill.billing_period_start;
  const wantEnd = gtBill.billing_period_end;

  const candidates = (fileResult.bills || []).filter((b) => normAcct(b.AccountNumber) === wantAcct);
  if (candidates.length === 0) return { status: 'NO_ACCOUNT_MATCH', file, candidateCount: fileResult.bills.length };

  // Prefer an exact ISO period match, then fall back to the 5-day fuzz window.
  let best = candidates.find((b) => toISO(b.BillingPeriodStart) === wantStart && toISO(b.BillingPeriodEnd) === wantEnd);
  if (!best) {
    best = candidates.find((b) =>
      periodClose(wantStart, wantEnd, toISO(b.BillingPeriodStart), toISO(b.BillingPeriodEnd)),
    );
  }
  if (!best) {
    return {
      status: 'NO_PERIOD_MATCH',
      file,
      candidatePeriods: candidates.map((b) => toISO(b.BillingPeriodStart) + '..' + toISO(b.BillingPeriodEnd)),
    };
  }
  return { status: 'MATCHED', file, bill: best };
}

// ---------------------------------------------------------------------------
// Commodity-aware matcher for the municipal (gas ground-truth) bills — same
// account/period matching as findExtractedBill() above, but also filters on
// Commodity, since the extractor emits one record per commodity per page.
// ---------------------------------------------------------------------------
function findExtractedCommodityBill(gtBill, commodity) {
  const file = gtBill.source.split('#')[0];
  const fileResult = sweepGas[file];
  if (!fileResult) return { status: 'NO_SWEEP_DATA', file };
  if (!fileResult.ok) return { status: 'SWEEP_FAILED', file, error: fileResult.error };

  const wantAcct = normAcct(gtBill.account_number);
  const wantStart = gtBill.billing_period_start;
  const wantEnd = gtBill.billing_period_end;

  const candidates = (fileResult.bills || []).filter(
    (b) => normAcct(b.AccountNumber) === wantAcct && b.Commodity === commodity,
  );
  if (candidates.length === 0)
    return { status: 'NO_ACCOUNT_MATCH', file, commodity, candidateCount: fileResult.bills.length };

  let best = candidates.find((b) => toISO(b.BillingPeriodStart) === wantStart && toISO(b.BillingPeriodEnd) === wantEnd);
  if (!best) {
    best = candidates.find((b) =>
      periodClose(wantStart, wantEnd, toISO(b.BillingPeriodStart), toISO(b.BillingPeriodEnd)),
    );
  }
  if (!best) {
    return {
      status: 'NO_PERIOD_MATCH',
      file,
      commodity,
      candidatePeriods: candidates.map((b) => toISO(b.BillingPeriodStart) + '..' + toISO(b.BillingPeriodEnd)),
    };
  }
  return { status: 'MATCHED', file, commodity, bill: best };
}

// ---------------------------------------------------------------------------
// Diff one municipal (gas ground-truth) bill. Unlike diffBill() below, this
// pulls fields from up to four different Commodity-tagged extracted records
// (Gas/Water/Sewer/Stormwater), matched independently, since that's how the
// extractor represents these bills.
// ---------------------------------------------------------------------------
function diffMunicipalBill(gtBill) {
  const fields = []; // { field, extractedField, expected, actual, pass }
  const unmapped = [];
  const matchNotes = [];

  function compareOne(dottedGt, extField, expected, actualBill, commodity) {
    if (expected === undefined || expected === null) return;
    const actual = actualBill ? actualBill[extField] : undefined;
    fields.push({
      field: dottedGt,
      extractedField: extField,
      commodity,
      expected,
      actual,
      pass: numbersMatch(expected, actual),
    });
  }

  // --- gas / sewer / stormwater: straightforward single-object groups ---
  for (const [groupName, spec] of Object.entries(MUNICIPAL_COMMODITY_FIELDS)) {
    const groupHasAnyGtValue = Object.keys(spec.fields).some((gtPath) => getPath(gtBill, gtPath) !== undefined);
    if (!groupHasAnyGtValue) continue; // GT doesn't record this commodity for this bill (e.g. water-only account)
    const match = findExtractedCommodityBill(gtBill, spec.commodity);
    if (match.status !== 'MATCHED') {
      matchNotes.push({ commodity: spec.commodity, ...match });
      for (const [gtPath, extField] of Object.entries(spec.fields)) {
        const expected = getPath(gtBill, gtPath);
        if (expected === undefined) continue;
        fields.push({
          field: gtPath,
          extractedField: extField,
          commodity: spec.commodity,
          expected,
          actual: undefined,
          pass: false,
        });
      }
      continue;
    }
    for (const [gtPath, extField] of Object.entries(spec.fields)) {
      compareOne(gtPath, extField, getPath(gtBill, gtPath), match.bill, spec.commodity);
    }
  }

  // --- water: object or array-of-meters, plus water_protection_fee which is
  // either top-level (gas-1 fixture schema) or nested per-meter (gas-2
  // fixture schema) ---
  if (gtBill.water !== undefined) {
    const isMultiMeter = Array.isArray(gtBill.water);
    const waterMatch = findExtractedCommodityBill(gtBill, 'Water');
    const waterBill = waterMatch.status === 'MATCHED' ? waterMatch.bill : null;
    if (waterMatch.status !== 'MATCHED') matchNotes.push({ commodity: 'Water', ...waterMatch });

    if (isMultiMeter) {
      unmapped.push(
        `water[] — ${gtBill.water.length} meters, multi-meter account — skipped per-meter read/usage diff (extractor emits one Water record per page, not per meter), summed water_charge/water_protection_fee compared instead`,
      );
      const sumCharge = gtBill.water.reduce((s, w) => s + (parseNum(w.water_charge) || 0), 0);
      compareOne('water[].water_charge (summed)', 'WaterCharge', sumCharge, waterBill, 'Water');
      if (gtBill.water.some((w) => w.water_protection_fee !== undefined)) {
        const sumFee = gtBill.water.reduce((s, w) => s + (parseNum(w.water_protection_fee) || 0), 0);
        compareOne('water[].water_protection_fee (summed)', 'WaterProtectionFee', sumFee, waterBill, 'Water');
      }
    } else {
      compareOne('water.meter_start_read', 'StartRead', gtBill.water.meter_start_read, waterBill, 'Water');
      compareOne('water.meter_end_read', 'EndRead', gtBill.water.meter_end_read, waterBill, 'Water');
      compareOne('water.usage', 'WaterUsage', gtBill.water.usage, waterBill, 'Water');
      compareOne('water.water_charge', 'WaterCharge', gtBill.water.water_charge, waterBill, 'Water');
      if (gtBill.water.water_protection_fee !== undefined) {
        compareOne(
          'water.water_protection_fee',
          'WaterProtectionFee',
          gtBill.water.water_protection_fee,
          waterBill,
          'Water',
        );
      }
    }
    // gas-1 fixture schema: top-level water_protection_fee sibling (not nested per-meter)
    if (gtBill.water_protection_fee !== undefined) {
      compareOne('water_protection_fee', 'WaterProtectionFee', gtBill.water_protection_fee, waterBill, 'Water');
    }
  }

  for (const gtPath of MUNICIPAL_KNOWN_UNMAPPED_TOP) {
    if (getPath(gtBill, gtPath) !== undefined) {
      unmapped.push(
        `${gtPath} (structural — extractor has no single combined-bill-total field across commodities, not compared)`,
      );
    }
  }

  return { fields, unmapped, matchNotes };
}

// ---------------------------------------------------------------------------
// Diff one ground-truth bill against its matched extracted record
// ---------------------------------------------------------------------------
// eer_charge / pts_charge / tdc_charge are recorded in the ground truth as
// either a plain dollar number OR an object {kwh|kw, rate, amount} (both
// forms appear across the 55 bills, as printed on the source bill). The
// extractor only ever produces a single dollar-amount field for these
// (EERCharge/PTSCharge/TDCCharge), so compare against `.amount` when the GT
// value is an object, and note the object's `.rate` as a second, separate
// field to compare against the extractor's own *Rate field where one exists
// (EER/PTS have no separate top-level GT rate field to double up on; TDC's
// rate is already compared via charges.tdc_rate, so it's excluded here).
const CHARGE_OBJECT_RATE_FIELDS = { eer_charge: 'EERRate', pts_charge: 'PTSRate' };
function chargeAmount(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && 'amount' in v ? v.amount : v;
}

function diffBill(gtBill, extBill) {
  const fields = []; // { field, expected, actual, pass }
  const unmapped = [];

  function compareGroup(map, gtGroupObj, groupName) {
    if (!gtGroupObj) return;
    for (const [gtKey, extField] of Object.entries(map)) {
      const dottedGt = groupName + '.' + gtKey;
      if (!(gtKey in gtGroupObj)) continue; // GT doesn't record this field for this bill — nothing to check
      let expected = gtGroupObj[gtKey];
      const isChargeObj = expected && typeof expected === 'object' && !Array.isArray(expected) && 'amount' in expected;
      if (isChargeObj) expected = chargeAmount(expected);
      const actual = extBill ? extBill[extField] : undefined;
      const pass = numbersMatch(expected, actual);
      fields.push({ field: dottedGt, extractedField: extField, expected, actual, pass });

      if (isChargeObj && CHARGE_OBJECT_RATE_FIELDS[gtKey]) {
        const rateExtField = CHARGE_OBJECT_RATE_FIELDS[gtKey];
        const rateExpected = gtGroupObj[gtKey].rate;
        const rateActual = extBill ? extBill[rateExtField] : undefined;
        fields.push({
          field: dottedGt + '.rate',
          extractedField: rateExtField,
          expected: rateExpected,
          actual: rateActual,
          pass: numbersMatch(rateExpected, rateActual),
        });
      }
    }
  }

  const isGas = gtBill.bill_type === 'gas';
  const isMultiMeter = Array.isArray(gtBill.meters) && !gtBill.meter;

  if (isGas) {
    compareGroup(GAS_FIELD_MAP.charges, gtBill.charges, 'charges');
    for (const { gtPath, extField } of GAS_METER_READING_FIELDS) {
      const expected = getPath(gtBill, gtPath);
      if (expected === undefined) continue;
      const actual = extBill ? extBill[extField] : undefined;
      fields.push({ field: gtPath, extractedField: extField, expected, actual, pass: numbersMatch(expected, actual) });
    }
  } else {
    if (isMultiMeter) {
      unmapped.push(
        `meter[] — ${gtBill.meters.length} meters, multi-meter account (0669287870-style) — skipped per-meter field diff, see task edge-case note`,
      );
    } else {
      compareGroup(ELECTRIC_FIELD_MAP.meter, gtBill.meter, 'meter');
    }
    compareGroup(ELECTRIC_FIELD_MAP.energy, gtBill.energy, 'energy');
    compareGroup(ELECTRIC_FIELD_MAP.charges, gtBill.charges, 'charges');
  }

  // Note any GT leaf field present but not in our map (visibility only).
  function noteUnmapped(map, gtGroupObj, groupName) {
    if (!gtGroupObj) return;
    for (const gtKey of Object.keys(gtGroupObj)) {
      const dotted = groupName + '.' + gtKey;
      if (map[gtKey]) continue;
      if (KNOWN_UNMAPPED.has(dotted)) continue;
      unmapped.push(dotted + ' (no extractor field mapping — not compared)');
    }
  }
  if (!isGas) {
    if (!isMultiMeter) noteUnmapped(ELECTRIC_FIELD_MAP.meter, gtBill.meter, 'meter');
    noteUnmapped(ELECTRIC_FIELD_MAP.energy, gtBill.energy, 'energy');
    noteUnmapped(ELECTRIC_FIELD_MAP.charges, gtBill.charges, 'charges');
  } else {
    noteUnmapped(GAS_FIELD_MAP.charges, gtBill.charges, 'charges');
  }

  return { fields, unmapped };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  groundTruthPath: GT_PATH,
  sweepResultsPath: SWEEP_RESULTS_PATH,
  bills: [],
};

let totalFields = 0;
let totalCorrect = 0;
let totalWrong = 0;
const unmatchedBills = [];
const failuresByBill = [];

for (const gtBill of gt.bills) {
  const match = findExtractedBill(gtBill);
  if (match.status !== 'MATCHED') {
    unmatchedBills.push({ id: gtBill.id, source: gtBill.source, reason: match.status, detail: match });
    report.bills.push({ id: gtBill.id, source: gtBill.source, matchStatus: match.status, fields: [], unmapped: [] });
    continue;
  }
  const { fields, unmapped } = diffBill(gtBill, match.bill);
  totalFields += fields.length;
  const wrong = fields.filter((f) => !f.pass);
  totalCorrect += fields.length - wrong.length;
  totalWrong += wrong.length;
  if (wrong.length) failuresByBill.push({ id: gtBill.id, source: gtBill.source, failures: wrong });
  report.bills.push({
    id: gtBill.id,
    source: gtBill.source,
    matchStatus: 'MATCHED',
    fieldCount: fields.length,
    wrongCount: wrong.length,
    fields,
    unmapped,
  });
}

report.summary = {
  totalGroundTruthBills: gt.bills.length,
  billsMatched: gt.bills.length - unmatchedBills.length,
  billsUnmatched: unmatchedBills.length,
  totalFieldsCompared: totalFields,
  totalFieldsCorrect: totalCorrect,
  totalFieldsWrong: totalWrong,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------
// Print human summary
// ---------------------------------------------------------------------------
console.log('='.repeat(78));
console.log('EXTRACTION VALIDATION REPORT');
console.log('='.repeat(78));
console.log(`Ground truth bills: ${gt.bills.length}`);
console.log(`Matched to an extracted record: ${report.summary.billsMatched}`);
console.log(`NOT matched (see below): ${report.summary.billsUnmatched}`);
console.log(`Fields compared: ${totalFields}`);
console.log(`Correct: ${totalCorrect}`);
console.log(`Wrong: ${totalWrong}`);
console.log('');

if (unmatchedBills.length) {
  console.log('-'.repeat(78));
  console.log('UNMATCHED GROUND-TRUTH BILLS (no extracted record found)');
  console.log('-'.repeat(78));
  for (const u of unmatchedBills) {
    console.log(`  ${u.id}  [${u.reason}]  source=${u.source}`);
    if (u.detail.error) console.log(`      error: ${u.detail.error}`);
    if (u.detail.candidatePeriods)
      console.log(`      candidate periods in file: ${JSON.stringify(u.detail.candidatePeriods)}`);
  }
  console.log('');
}

if (failuresByBill.length) {
  console.log('-'.repeat(78));
  console.log('FIELD FAILURES (grouped by bill)');
  console.log('-'.repeat(78));
  for (const b of failuresByBill) {
    console.log(`\n  ${b.id}  (source=${b.source})`);
    for (const f of b.failures) {
      console.log(`    ${f.field} | expected=${JSON.stringify(f.expected)} | actual=${JSON.stringify(f.actual)}`);
    }
  }
  console.log('');
} else {
  console.log('No field failures among matched bills.');
}

console.log('='.repeat(78));
console.log(`Full machine-readable report: ${OUT_PATH}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// GAS run — separate ground-truth fixtures (louisburg-gt-gas-1/-2.json),
// separate matcher/diff path (findExtractedCommodityBill/diffMunicipalBill
// above). Does not touch anything in the electric run above.
// ---------------------------------------------------------------------------
let gasBills = [];
const missingGasGtFiles = GAS_GT_PATHS.filter((p) => !fs.existsSync(p));
if (missingGasGtFiles.length) {
  console.error('FATAL: gas ground truth not found: ' + missingGasGtFiles.join(', '));
  process.exit(2);
}
for (const p of GAS_GT_PATHS) {
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const b of doc.bills) gasBills.push({ ...b, _gtFile: p });
}

const gasReport = { gasGroundTruthPaths: GAS_GT_PATHS, gasSweepResultsPath: GAS_SWEEP_RESULTS_PATH, bills: [] };
let gasTotalFields = 0;
let gasTotalCorrect = 0;
let gasTotalWrong = 0;
const gasUnmatchedBills = [];
const gasFailuresByBill = [];

for (const gtBill of gasBills) {
  const { fields, unmapped, matchNotes } = diffMunicipalBill(gtBill);
  if (fields.length === 0 && matchNotes.length) {
    // No comparable field got a match at all (e.g. whole source file missing from sweep)
    gasUnmatchedBills.push({ id: gtBill.id, source: gtBill.source, matchNotes });
  }
  gasTotalFields += fields.length;
  const wrong = fields.filter((f) => !f.pass);
  gasTotalCorrect += fields.length - wrong.length;
  gasTotalWrong += wrong.length;
  if (wrong.length) gasFailuresByBill.push({ id: gtBill.id, source: gtBill.source, failures: wrong });
  gasReport.bills.push({
    id: gtBill.id,
    source: gtBill.source,
    fieldCount: fields.length,
    wrongCount: wrong.length,
    fields,
    unmapped,
    matchNotes,
  });
}

gasReport.summary = {
  totalGroundTruthBills: gasBills.length,
  totalFieldsCompared: gasTotalFields,
  totalFieldsCorrect: gasTotalCorrect,
  totalFieldsWrong: gasTotalWrong,
};

const combinedSummary = {
  totalFieldsCompared: totalFields + gasTotalFields,
  totalFieldsCorrect: totalCorrect + gasTotalCorrect,
  totalFieldsWrong: totalWrong + gasTotalWrong,
};

console.log('');
console.log('='.repeat(78));
console.log('GAS EXTRACTION VALIDATION REPORT (louisburg-gt-gas-1/-2.json)');
console.log('='.repeat(78));
console.log(`Ground truth bills: ${gasBills.length}`);
console.log(`Fields compared: ${gasTotalFields}`);
console.log(`Correct: ${gasTotalCorrect}`);
console.log(`Wrong: ${gasTotalWrong}`);
console.log('');

if (gasFailuresByBill.length) {
  console.log('-'.repeat(78));
  console.log('GAS FIELD FAILURES (grouped by bill)');
  console.log('-'.repeat(78));
  for (const b of gasFailuresByBill) {
    console.log(`\n  ${b.id}  (source=${b.source})`);
    for (const f of b.failures) {
      console.log(
        `    [${f.commodity}] ${f.field} | expected=${JSON.stringify(f.expected)} | actual=${JSON.stringify(f.actual)}`,
      );
    }
  }
  console.log('');
} else {
  console.log('No gas field failures among matched commodity records.');
}

console.log('='.repeat(78));
console.log('COMBINED ELECTRIC + GAS TOTAL');
console.log('='.repeat(78));
console.log(
  `Fields compared: ${combinedSummary.totalFieldsCompared}  |  Correct: ${combinedSummary.totalFieldsCorrect}  |  Wrong: ${combinedSummary.totalFieldsWrong}`,
);
console.log('='.repeat(78));

report.gasGroundTruthPaths = GAS_GT_PATHS;
report.gasBills = gasReport.bills;
report.gasSummary = gasReport.summary;
report.combinedSummary = combinedSummary;
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(`Full machine-readable report (electric + gas): ${OUT_PATH}`);
console.log('='.repeat(78));

process.exit(totalWrong > 0 || unmatchedBills.length > 0 || gasTotalWrong > 0 ? 1 : 0);
