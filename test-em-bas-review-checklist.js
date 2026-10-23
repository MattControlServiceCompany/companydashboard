// test-em-bas-review-checklist.js
// Unit tests for the BAS review checklist in the Equipment Matrix Raw view: Heating Type, Points,
// Review and Screenshot columns, and the shared column dropdown filter.
// Loads the REAL app/equipment-matrix.js into a Node vm sandbox - no reimplementation of any rule.
// Fixtures are 100% SYNTHETIC (fake building and equipment names).
// Run: node test-em-bas-review-checklist.js   (from the repo root)

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
    localStorage: { getItem: () => null, setItem: function () {} },
    navigator: {},
    window: {},
    _escHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
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
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function assertTrue(v, label) {
  assertEqual(!!v, true, label);
}

const sb = loadSandbox();

function row(o) {
  return Object.assign(
    {
      id: 'Fake Library A||' + o.equipName,
      building: 'Fake Library A',
      category: 'vav',
      subtype: '',
      bacnetLocation: '/Fake/Library A',
      schema: 2,
      pointsRaw: { 'Air Flow': '800' },
      checks: {},
    },
    o
  );
}

const rows = [
  // VAV-1-10 listed first on purpose: tree order must put VAV-1-2 first (numeric collation).
  row({ equipName: 'Zone | VAV-1-10' }),
  row({
    equipName: 'Zone | VAV-1-2',
    pointsRaw: {
      'Air Flow': '800',
      'Maximum Cooling Airflow': '1000',
      'Minimum Occupied Airflow': '600',
      'Maximum Heating Airflow': '1200',
    },
  }),
  row({ id: 'B1', building: 'Fake Library B', bacnetLocation: '/Fake/Library B', equipName: 'Zone | VAV-9-1' }),
  row({
    equipName: 'AHU-1',
    category: 'ahu',
    existingScheduleText: 'Occupied from 12:00 AM to 11:59 PM',
    pointsRaw: { 'Supply Fan Status': 'On' },
  }),
  row({
    equipName: 'AHU-2',
    category: 'ahu',
    existingScheduleText: 'Occupied from 7:00 AM to 5:00 PM',
    pointsRaw: { 'Supply Fan Status': 'On' },
  }),
  row({ equipName: '', pointsRaw: {} }),
  row({ equipName: 'Zone | VAV-2-1', pointsRaw: { 'Zone CO2': '0.0 ppm', 'Air Flow': '300' } }),
  row({ equipName: 'Zone | VAV-2-2', pointsRaw: { 'Unoccupied Heating Setpoint': '?', 'Air Flow': '300' } }),
  row({ equipName: 'AHU-3 | VFD Integration', category: 'ahu', pointsRaw: { 'Supply Fan Status': 'On' } }),
];
const rev = (i) => sb.emReviewReasons(rows[i], rows);

// 1. One sample per type per building, tree order (location then control program, numeric).
assertEqual(rev(1).indexOf('Sample of ') === 0, true, 'VAV-1-2 is the sample of its building');
assertEqual(rev(0).indexOf('Sample of'), -1, 'VAV-1-10 is not a sample');
assertTrue(/^Sample of /.test(rev(2)), 'second building gets its own sample');
assertTrue(/^Sample of /.test(rev(3)), 'AHU gets a sample');
assertEqual(rev(4).indexOf('Sample of'), -1, 'second AHU is not a sample');
assertEqual(rev(8), '', 'sub-component row is never a sample and has no reason');

// 2. Schedule occupied 24 hours.
assertTrue(rev(3).indexOf('Occupied 24 h') !== -1, 'full day schedule flagged');
assertEqual(rev(4), '', 'normal schedule not flagged');

// 3. Airflow rules (row 1: min 600 of max 1000 = 60%, heat 1200 > cool 1000).
assertTrue(rev(1).indexOf('Min airflow > 50% of max') !== -1, 'min airflow above half of max');
assertTrue(rev(1).indexOf('Heat airflow > cool airflow') !== -1, 'heat airflow above cool airflow');
assertEqual(rev(1), 'Sample of ' + sb.emFormatEquipTypeLabel(rows[1]) + '; Min airflow > 50% of max; Heat airflow > cool airflow', 'reasons joined with "; " in rule order');

// 4. No control program.
assertTrue(rev(5).indexOf('No control program') !== -1, 'blank control program flagged');

// 5. Dead sensor.
assertTrue(/Dead .* reading/.test(rev(6)), 'dead CO2 sensor flagged: ' + rev(6));

// 6. Offline setpoint point.
assertTrue(rev(7).indexOf('Offline points') !== -1, 'setpoint "?" flagged');

// 7. Heating Type: the column reads the same function the export reads.
sb.emPrepareRowCalc('p1', rows);
rows.forEach((r, i) => {
  const direct = sb._emDeriveHeatingType(r, sb.emGetNormalizedPoints(r) || {}, undefined);
  assertEqual(sb.emRowHeatingType(r, null), direct, 'emRowHeatingType equals _emDeriveHeatingType #' + i);
  assertEqual(sb.emRowCalc(r).heatingType, sb.EM_HEATING_TYPE_LABELS[direct.key], 'column label #' + i);
  assertEqual(sb.emRowCalc(r).heatKnown, direct.known, 'known flag #' + i);
});
const hp = row({ equipName: 'VRF-1', category: 'vrf' });
assertEqual(sb.emRowCalc(hp).heatingType, 'Heat pump', 'heat pump label');
assertEqual(sb.emRowCalc(hp).heatKnown, true, 'heat pump is confirmed');
assertTrue(sb.emFormatCell('Hydronic', { key: 'heatingType' }, rows[0]).indexOf('Not confirmed from points') !== -1, 'default heating type has hover');
assertEqual(sb.emFormatCell('Heat pump', { key: 'heatingType' }, hp), 'Heat pump', 'confirmed heating type has no hover');

// 8. Points: count from emRowPointCount; names from the one list builder.
assertEqual(sb.emRowCalc(rows[1]).pointCount, sb.emRowPointCount(rows[1]), 'point count');
assertEqual(sb.emRowPointNames(rows[1]).length, 4, 'point names');
const cell = sb.emFormatCell(4, { key: 'pointCount' }, rows[1]);
assertTrue(cell.indexOf('Air Flow') !== -1 && cell.indexOf('Maximum Cooling Airflow') !== -1, 'Points hover lists names');
assertTrue(sb.emBuildAllPointsTableHtml(rows[1]).indexOf('All Building Automation System Points (4 captured)') !== -1, 'drawer uses the same list');

// 9. Columns exist and Screenshot saves as an edit like Notes.
const defs = sb.emGetColDefs();
const keys = defs.map((d) => d.key);
['heatingType', 'pointCount', 'review', 'screenshot', 'notes'].forEach((k) => assertTrue(keys.indexOf(k) !== -1, 'column ' + k));
const shotDef = defs.filter((d) => d.key === 'screenshot')[0];
assertEqual(sb.emGetCellValByDef(rows[0], shotDef, {}), '', 'screenshot empty by default');
assertEqual(sb.emGetCellValByDef(rows[0], shotDef, { [rows[0].id + '::screenshot']: 'Y' }), 'Y', 'screenshot read from edits');
assertTrue(sb.emFormatCell('Y', shotDef, rows[0]).indexOf(' checked') !== -1, 'checkbox checked when Y');
assertEqual(sb.emFormatCell('', shotDef, rows[0]).indexOf(' checked'), -1, 'checkbox clear when blank');

// 10. Shared column dropdown filter.
const revDef = defs.filter((d) => d.key === 'review')[0];
const htDef = defs.filter((d) => d.key === 'heatingType')[0];
sb.emPrepareRowCalc('p1', rows);
const nonBlank = sb.emFilterByCols(rows, defs, { review: '(non-blank)' }, {});
assertEqual(nonBlank.length, rows.filter((r, i) => rev(i) !== '').length, '(non-blank) keeps only rows with a reason');
const blank = sb.emFilterByCols(rows, defs, { review: '(blank)' }, {});
assertEqual(blank.length + nonBlank.length, rows.length, '(blank) is the complement');
assertEqual(sb.emFilterByCols(rows, defs, { review: 'Occupied 24 h' }, {}).length, 1, 'one reason');
const opts = sb.emColFilterOptions(revDef, rows, {}).map((o) => o.value);
assertTrue(opts.indexOf('(non-blank)') !== -1 && opts.indexOf('Occupied 24 h') !== -1, 'review options');
assertEqual(sb.emColFilterOptions(shotDef, rows, {}).map((o) => o.value), ['Done', 'Not done'], 'screenshot options');
const edits = { [rows[2].id + '::screenshot']: 'Y' };
assertEqual(sb.emFilterByCols(rows, defs, { screenshot: 'Done' }, edits).length, 1, 'Done');
assertEqual(sb.emFilterByCols(rows, defs, { screenshot: 'Not done' }, edits).length, rows.length - 1, 'Not done');
assertEqual(sb.emFilterByCols(rows, defs, { heatingType: sb.emRowCalc(hp).heatingType }, {}).length, 0, 'heating type filter, none match');
assertEqual(sb.emFilterByCols(rows, defs, {}, {}).length, rows.length, 'no filter keeps all rows');
assertTrue(sb.emColFilterSelectHtml(revDef, rows, {}, '(non-blank)').indexOf('selected') !== -1, 'current choice stays selected');

// 11. CSV export reads the same cells (emGetCellVal delegates to emGetCellValByDef).
const ci = defs.findIndex((d) => d.key === 'review');
assertEqual(sb.emGetCellVal(rows[1], ci, {}), sb.emGetCellValByDef(rows[1], revDef, {}), 'export cell equals table cell');
void htDef;

console.log('em bas review checklist: pass ' + pass + ', fail ' + fail);
if (fail) {
  failures.forEach((f) => console.log('FAIL ' + f));
  process.exit(1);
}
