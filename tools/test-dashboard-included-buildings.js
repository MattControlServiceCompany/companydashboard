// test-dashboard-included-buildings.js -- backlog 1acc4f2d. A client Dashboard showed 7 buildings and 8 rows: the
// Maintenance Building (excluded) and the "Unmatched Bills" sentinel. Rules:
// (1) getIncludedBldgs drops a building flagged _unmatchedSentinel and a building whose calc meters are all excluded;
//     a real building with no meters or no sqft stays.
// (2) The Dashboard header counts and the Building Performance rows come from that ONE list (no second filter).
// (3) The headline quarter card shows a floored quarter through savingsFlooredShown; a positive quarter is unchanged.
// Synthetic data only. No browser: real functions are cut from the app source into a Node vm context.
// Check: node tools/test-dashboard-included-buildings.js   Exit 1 on any FAIL.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeContext, fnSource } = require('./bill-flags-sandbox.js');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let fails = 0;
const fail = (m) => { fails++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);
const check = (c, m) => (c ? ok(m) : fail(m));

const m = (id, commodity) => ({ id, commodity: commodity || 'Electric', bills: [] });
const bldgs = [
  { id: 'b1', name: 'Alpha', sqft: 40000, meters: [m('m1')] },
  { id: 'b2', name: 'Maintenance', sqft: 8000, meters: [m('m2')] },
  { id: 'b3', name: 'Unmatched Bills', sqft: 0, _unmatchedSentinel: true, meters: [m('m3', 'Water'), m('m4', 'Water')] },
  { id: 'b4', name: 'Empty Real Building', sqft: 0, meters: [] },
  { id: 'b5', name: 'No Sqft', meters: [m('m5')] },
  { id: 'b6', name: 'Sentinel With Electric', _unmatchedSentinel: true, meters: [m('m6')] },
];
const project = { id: 1, name: 'Synthetic', calcCommodities: ['Electric', 'Gas'],
  scope: { buildingIds: bldgs.map((b) => b.id), meterExcludeIds: ['m2'] } };
const ctx = makeContext();
Object.assign(ctx, {
  projects: [project], sget: (k, d) => (k === 'en_projects' ? [project] : d),
  getUDBldgs: () => bldgs,
});
vm.runInContext(fnSource('app/utility-data.js', 'getIncludedBldgs') + '\n' + fnSource('app/utility-data.js', 'isBaselineExcluded') +
  '\n' + fnSource('app/core.js', 'isCalcCommodity'), ctx);
const names = vm.runInContext('getIncludedBldgs(1).map(b => b.name)', ctx);
check(JSON.stringify(names) === '["Alpha","Empty Real Building","No Sqft"]', 'included list = real buildings only (got ' + JSON.stringify(names) + ')');
check(!names.includes('Unmatched Bills') && !names.includes('Sentinel With Electric'), 'sentinel dropped, also when it holds a calc meter');
check(!names.includes('Maintenance'), 'excluded maintenance-only building dropped');
check(names.includes('Empty Real Building') && names.includes('No Sqft'), 'real building with no meters or no sqft kept');

// ---- Dashboard: one list for header and rows ----
const core = read('app/core.js');
const i0 = core.indexOf('function initDashboardTab');
const i1 = core.indexOf('\nfunction ', i0 + 10);
const dash = core.slice(i0, i1);
check(/const _eligBldgs = getIncludedBldgs\(projId\)/.test(dash), 'Dashboard builds its list with getIncludedBldgs');
check(/const bldgs = _eligBldgs;/.test(dash), 'Dashboard bldgs IS the included list (header counts, bill count, rows)');
const udUses = dash.match(/getUDBldgs\(/g) || [];
check(udUses.length === 1 && /const _exclWithBills = getUDBldgs\(projId\)\.filter\(\(b\) => !bldgs\.includes\(b\)/.test(dash),
  'Dashboard has no second building list (getUDBldgs only counts excluded buildings with bills for the empty-state text)');
check(/all of their meters are excluded from savings/.test(dash), 'empty state names the exclusion when excluded buildings hold bills');
check(/const bldgRows = bldgs\.map/.test(dash), 'Building Performance rows map the included list');
check(/const _totalMeterCount = bldgs\.reduce/.test(dash) && /const billCount = bldgs\.reduce/.test(dash) &&
  /const _blInclCount = bldgs\.reduce/.test(dash) && /const blMeterCount = bldgs\.reduce/.test(dash), 'meter, bill and baseline counts reduce the same list');

// ---- headline quarter card ----
const sv = makeContext();
vm.runInContext(read('computations/savings.js'), sv);
const c0 = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
const fl = vm.runInContext('savingsFlooredShown', sv)(-6495.54, 0, 0, c0, 'P', 'N', 'Z');
check(fl.floored && fl.text === '−$6,496 → $0', 'floored quarter text shows measured and the floor (got ' + fl.text + ')');
const pos = vm.runInContext('savingsFlooredShown', sv)(8048.4, 8048.4, 0, c0, 'P', 'N', 'Z');
check(!pos.floored && pos.text === c0(8048.4), 'positive quarter text equals the old $c text (got ' + pos.text + ')');
check(/savingsFlooredShown\(curQtrMeasured, curQtrActual, 0, \$c/.test(dash), 'headline card uses savingsFlooredShown with the measured quarter');
check(/\$c\(curQtrActual\)\}<\/div>/.test(dash) === false, 'headline card no longer prints $c(curQtrActual) alone');
check(/measuredByQtr\[qi\] = qr\.measured/.test(dash), 'measured quarter comes from billableSavingsWithPresented .measured');
console.log(fails ? '\n' + fails + ' FAIL' : '\nall ok');
process.exit(fails ? 1 : 0);
