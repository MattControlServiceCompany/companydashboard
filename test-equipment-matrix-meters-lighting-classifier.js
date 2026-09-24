// test-equipment-matrix-meters-lighting-classifier.js
// Unit tests for the Equipment Matrix classifier changes (2026-09-23, backlog item adding a
// "Meters" type with Electric/Gas/Water subtypes, a generic "Lights" name match for the
// existing 'lighting' category, and a points-driven room-temperature-monitoring rule).
//
// Loads the REAL app/equipment-matrix.js source into a Node vm sandbox (same technique used by
// test-kwh-corroboration.mjs / the ocr-harness scripts) — no reimplementation of classifier
// logic here, every assertion calls the real emClassifyEquipType / emVerifyTypeByPoints.
//
// Fixtures are 100% SYNTHETIC — no real client/project/building names (per feedback_repo_test_
// fixtures_must_be_synthetic.md). Covers: lights, meters (all 3 subtypes, name-based AND
// points-fallback-based), rooms (points-driven monitoring), and proves RTU/VAV/AHU
// classification is byte-identical to before the change (never flips to a new type).
//
// Run: node test-equipment-matrix-meters-lighting-classifier.js   (from the repo root)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, 'app', 'equipment-matrix.js');

function loadSandbox() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const sandbox = {
    console: console,
    document: {
      addEventListener: function () {},
      getElementById: function () {
        return null;
      },
      querySelector: function () {
        return null;
      },
      createElement: function () {
        return { style: {}, classList: { add: function () {} } };
      },
    },
    localStorage: {
      getItem: function () {
        return null;
      },
      setItem: function () {},
    },
    navigator: {},
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: SRC_PATH });
  return sandbox;
}

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const sb = loadSandbox();

// ── (a) Classifier: name pass (emClassifyEquipType) ────────────────────────────────────────

// Lights — plain "Lights" fixture names (no word "lighting"), the exact bug pattern reported.
assertEqual(
  sb.emClassifyEquipType('Area Synth Emergency Lights'),
  'lighting',
  'name: Area Synth Emergency Lights -> lighting',
);
assertEqual(
  sb.emClassifyEquipType('Synth Parking Lot Lights'),
  'lighting',
  'name: Synth Parking Lot Lights -> lighting',
);
assertEqual(sb.emClassifyEquipType('Synth Sidewalk Lights'), 'lighting', 'name: Synth Sidewalk Lights -> lighting');
// Existing "Lighting" keyword pattern must keep working (no regression from adding "Lights").
assertEqual(
  sb.emClassifyEquipType('Synth Lighting Zone 1'),
  'lighting',
  'name: Synth Lighting Zone 1 -> lighting (pre-existing pattern)',
);

// Meters — name-based Gas/Water/kWh detection.
assertEqual(sb.emClassifyEquipType('Synth Gas Meter'), 'meter', 'name: Synth Gas Meter -> meter');
assertEqual(sb.emClassifyEquipType('Synth Water Meter'), 'meter', 'name: Synth Water Meter -> meter');
assertEqual(sb.emClassifyEquipType('KW Meter - Synth'), 'meter', 'name: KW Meter - Synth -> meter');
assertEqual(
  sb.emClassifyEquipType('Synth Electric Meter'),
  'meter',
  'name: Synth Electric Meter -> meter (dict, was power)',
);
assertEqual(sb.emClassifyEquipType('Synth Power Meter'), 'meter', 'name: Synth Power Meter -> meter (dict, was power)');

// Meters must NOT swallow more-specific process/plant submeters that already have a home —
// these prove the new meter regexes are correctly ordered LAST in the classify cascade.
assertEqual(sb.emClassifyEquipType('Synth Boiler Gas Meter'), 'hwp', 'name: Synth Boiler Gas Meter -> hwp (NOT meter)');
assertEqual(
  sb.emClassifyEquipType('Synth Domestic Water Meter'),
  'plumbing',
  'name: Synth Domestic Water Meter -> plumbing (NOT meter)',
);
assertEqual(
  sb.emClassifyEquipType('Synth Cooling Tower Makeup Water Meter'),
  'ct',
  'name: Synth Cooling Tower Makeup Water Meter -> ct (NOT meter)',
);
assertEqual(
  sb.emClassifyEquipType('Synth Irrigation Water Meter'),
  'plumbing',
  'name: Synth Irrigation Water Meter -> plumbing (NOT meter)',
);
// "chilled water" resolves to chwp (real JOCO row "Chilled Water System BTU Meter" -> chwp) —
// still proves the new meter regexes never shadow an earlier, more specific match.
assertEqual(
  sb.emClassifyEquipType('Synth Chilled Water System BTU Meter'),
  'chwp',
  'name: Synth Chilled Water System BTU Meter -> chwp (NOT meter)',
);

// ── RTU / VAV / AHU must be completely unaffected by the classifier change ─────────────────
assertEqual(sb.emClassifyEquipType('RTU-1'), 'rtu', 'name: RTU-1 -> rtu (unchanged)');
assertEqual(sb.emClassifyEquipType('Rooftop Unit 7'), 'rtu', 'name: Rooftop Unit 7 -> rtu (unchanged)');
assertEqual(sb.emClassifyEquipType('VAV-12'), 'vav', 'name: VAV-12 -> vav (unchanged)');
assertEqual(sb.emClassifyEquipType('Air Handling Unit 3'), 'ahu', 'name: Air Handling Unit 3 -> ahu (unchanged)');

// ── (a) Classifier: meter subtype helper (emClassifyMeterSubtype) ──────────────────────────
assertEqual(sb.emClassifyMeterSubtype('Synth Electric Meter', {}), 'electric', 'subtype: name "Electric" -> electric');
assertEqual(sb.emClassifyMeterSubtype('Synth Gas Meter', {}), 'gas', 'subtype: name "Gas" -> gas');
assertEqual(sb.emClassifyMeterSubtype('Synth Water Meter', {}), 'water', 'subtype: name "Water" -> water');
assertEqual(
  sb.emClassifyMeterSubtype('KW Meter - Synth', {}),
  'electric',
  'subtype: name "KW Meter" (no "electric" word) -> electric via kwh pattern',
);
// Points-only fallback (name gives no hint) — mirrors real Gas/Water meter BACnet point sets.
assertEqual(
  sb.emClassifyMeterSubtype('Synth Utility Meter A', {
    'Meter Input': '1',
    Demand: '2',
    'Heat Content': '3',
    'Energy Constant': '4',
    'Conversion Constant': '5',
  }),
  'gas',
  'subtype: points-only (Heat Content/Energy Constant/Conversion Constant) -> gas',
);
assertEqual(
  sb.emClassifyMeterSubtype('Synth Utility Meter B', { 'KW Demand Level': '1', Demand: '2' }),
  'electric',
  'subtype: points-only (KW Demand Level) -> electric',
);
assertEqual(
  sb.emClassifyMeterSubtype('Synth Utility Meter C', { 'Meter Input': '1', Demand: '2', Meter: '3' }),
  '',
  'subtype: points-only, no gas/electric signal -> "" (never guesses water)',
);

// ── (a) Classifier: emVerifyTypeByPoints — meter subtype short-circuit, gated on category ──
const meterGroupElectric = { category: 'meter', equipName: 'Synth Electric Meter', pointValues: { Demand: '1' } };
assertEqual(sb.emVerifyTypeByPoints(meterGroupElectric).category, 'meter', 'verify: meter category stays meter');
assertEqual(sb.emVerifyTypeByPoints(meterGroupElectric).subtype, 'electric', 'verify: meter subtype = electric');

const meterGroupGas = { category: 'meter', equipName: 'Synth Gas Meter', pointValues: {} };
assertEqual(sb.emVerifyTypeByPoints(meterGroupGas).subtype, 'gas', 'verify: meter subtype = gas');

const meterGroupWater = { category: 'meter', equipName: 'Synth Water Meter', pointValues: {} };
assertEqual(sb.emVerifyTypeByPoints(meterGroupWater).subtype, 'water', 'verify: meter subtype = water');

// ── (a) Classifier: Rule 16 room-temperature monitoring (points-driven, name-independent) ──
// Fixture mirrors the real Woodland MS "B136 Office/Storage"-style point set: setpoints + zone
// temp + comms alarm, but NO flow/damper/valve/fan/VFD points — i.e. a monitored space, not a
// terminal box. Category name is deliberately generic/synthetic ("Synth Room A") to prove the
// classification comes from POINTS, never a hardcoded room-name list.
const roomGroup = {
  category: 'other',
  equipName: 'Synth Room A',
  pointValues: {
    'Setpoint / Cooling Occupied Setpoint': '70.0 F',
    'Setpoint / Heating Occupied Setpoint': '68.0 F',
    'Zone Temp': '70.5 F',
    'High Zone Temperature': 'Normal',
    'Zone Sensor Communications Alarm': 'Normal',
  },
};
const roomResult = sb.emVerifyTypeByPoints(roomGroup);
assertEqual(roomResult.category, 'monitoring', 'verify: room (zone temp, no flow/valve) -> monitoring (Rule 16)');

// Negative control: a REAL VAV terminal box fixture (zone temp + flow control + damper) — Rule
// 16 must NOT fire for this; it should be caught by the earlier VAV/FCU rules or left alone,
// never demoted to 'monitoring'. Proves Rule 16 doesn't over-fire on real terminal units.
const vavGroup = {
  category: 'other',
  equipName: 'Synth VAV Box 1',
  pointValues: {
    'Setpoint / Cooling Occupied Setpoint': '70.0 F',
    'Zone Temp': '70.5 F',
    'Flow Control / Flow Input': '300 cfm',
    'Air Flow': '295',
    'Damper Position': '40 %',
    'Air Source Mode': '2',
  },
};
const vavResult = sb.emVerifyTypeByPoints(vavGroup);
assertEqual(vavResult.category, 'vav', 'verify: VAV fixture (has airflow+damper) -> vav (Rule 16 does not over-fire)');

// Negative control: an actual hydronic fan coil (zone temp + heating valve, no flow) must still
// classify as 'fcu' via the pre-existing Rule 10 — Rule 16's valve exclusion must not eat it.
const fcuGroup = {
  category: 'other',
  equipName: 'Synth FCU 1',
  pointValues: { 'Zone Temp': '72 F', 'Heating Valve': '10 %' },
};
assertEqual(
  sb.emVerifyTypeByPoints(fcuGroup).category,
  'fcu',
  'verify: FCU fixture (zone temp + heating valve) -> fcu (Rule 10, unaffected)',
);

// ── 2026-09-24: misspelled "Enviromental Index" (JOCO's real BAS source data — missing the
// second "n") must classify the same as the correctly-spelled "Environmental Index", not fall
// to 'other'. Synthetic fixture mirrors the JOCO Control-Program naming shape. ──────────────
assertEqual(
  sb.emClassifyEquipType('Enviromental Index'),
  'sensor',
  'name: Enviromental Index (typo, JOCO source data) -> sensor, matches Environmental Index',
);
assertEqual(
  sb.emClassifyEquipType('Environmental Index'),
  'sensor',
  'name: Environmental Index (correct spelling) -> sensor (unchanged)',
);
const envTypoParsed = sb.emParseControlProgram('Enviromental Index - Synth ADC');
assertEqual(envTypoParsed.equipName, 'Enviromental Index', 'parse: Enviromental Index - Synth ADC -> JOCO-style split');

// ── 2026-09-24: dropdown-list-matches-classifier — every category the classifier can produce
// (EM_CATEGORY_LABELS) must have an entry in the "All Types" filter dropdown (EM_TYPE_FILTER_
// ORDER), and vice versa. Regression guard for the bug where elevator/security/lifesafety/vrf/
// ac were classifier outputs never added to the dropdown's old hand-kept option list. ────────
const labelKeys = Object.keys(sb.EM_CATEGORY_LABELS).sort();
const orderKeys = sb.EM_TYPE_FILTER_ORDER.slice().sort();
assertEqual(
  JSON.stringify(labelKeys),
  JSON.stringify(orderKeys),
  'dropdown: EM_TYPE_FILTER_ORDER contains exactly the keys of EM_CATEGORY_LABELS (no classifier type missing, no stale extra)',
);
['elevator', 'security', 'lifesafety', 'vrf', 'ac'].forEach(function (k) {
  assertEqual(
    sb.EM_TYPE_FILTER_ORDER.indexOf(k) !== -1,
    true,
    'dropdown: ' + k + ' is present in EM_TYPE_FILTER_ORDER',
  );
});
assertEqual(sb.EM_CATEGORY_LABELS.elevator, 'Elevator', 'label: elevator -> "Elevator"');
assertEqual(sb.EM_CATEGORY_LABELS.security, 'Security', 'label: security -> "Security"');
assertEqual(sb.EM_CATEGORY_LABELS.lifesafety, 'Life Safety', 'label: lifesafety -> "Life Safety"');
assertEqual(sb.EM_CATEGORY_LABELS.vrf, 'Variable Refrigerant Flow', 'label: vrf -> "Variable Refrigerant Flow"');
assertEqual(sb.EM_CATEGORY_LABELS.ac, 'Air Conditioning', 'label: ac -> "Air Conditioning"');

// ── Summary ──
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('All equipment-matrix classifier tests passed.');
  process.exit(0);
}
