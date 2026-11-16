// test-dashboard-labels-and-counts.js -- 2026-11-16 defects D02-D19, D39, D40, D49, D50, D55 (dashboard, header, utility, graphics, home).
// Synthetic data only. No browser: the real functions are cut from the app source into a Node vm context.
// Rules checked: one building count (listed vs in baseline), header dates never "-- -> --", header buttons carry a tooltip,
// the Building Performance table has a totals row, one empty state on Contacts, the Dashboard right panel never stays on "Loading...",
// Home labels say what they count, Energy Graphics leaves a year with no bar out of the legend, negative dollars read "-$5,000".
// Check: node tools/test-dashboard-labels-and-counts.js   Exit 1 on any FAIL.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeContext, fnSource } = require('./bill-flags-sandbox.js');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let fails = 0;
const check = (c, m) => {
  if (c) console.log('  ok   ' + m);
  else {
    fails++;
    console.log('  FAIL ' + m);
  }
};

// ---- one building count ----
const months = [];
for (let i = 1; i <= 12; i++) months.push('2025-' + String(i).padStart(2, '0'));
const meter = (id) => ({ id, commodity: 'Electric', baseline: { months: months.slice() }, bills: [] });
const bldgs = [
  { id: 'b1', name: 'In', sqft: 1000, meters: [meter('m1')] },
  { id: 'b2', name: 'Out', sqft: 1000, meters: [meter('m2')] },
  { id: 'b3', name: 'Bare', sqft: 1000, meters: [] },
  { id: 'bU', name: 'Unmatched Bills', sqft: 0, _unmatchedSentinel: true, meters: [meter('mU')] },
];
const project = { id: 1, name: 'Synthetic', calcCommodities: ['Electric'], scope: { buildingIds: ['b1', 'b2', 'b3', 'bU'], meterExcludeIds: ['m2'] } };
const ctx = makeContext();
Object.assign(ctx, { projects: [project], udSelProjId: 1, utilityData: { c1: { buildings: bldgs } }, sget: (k, d) => (k === 'en_projects' ? [project] : d), _resolveCustomerId: () => 'c1' });
vm.runInContext(['getUDProj', 'getUDBldgs', 'isUnmatchedSentinelBldg', 'getIncludedBldgs', 'getProjectBuildingCounts', 'isBaselineExcluded'].map((n) => fnSource('app/utility-data.js', n)).join('\n'), ctx);
vm.runInContext(fnSource('app/core.js', 'isCalcCommodity'), ctx);
const cnt = vm.runInContext('getProjectBuildingCounts(1)', ctx);
check(cnt.listed === 3, 'listed = 3 buildings (the Unmatched Bills bucket is never counted), got ' + cnt.listed);
check(cnt.inBaseline === 2, 'inBaseline = 2 (the building with every meter excluded is out), got ' + cnt.inBaseline);

// ---- header dates ----
const dctx = vm.createContext({ _parseISO: (s) => new Date(s + 'T12:00:00') });
vm.runInContext(fnSource('app/core.js', '_phcDatesHtml'), dctx);
const dates = (p) => vm.runInContext('_phcDatesHtml(' + JSON.stringify(p) + ')', dctx);
check(/No contract dates/.test(dates({})) && !/→/.test(dates({})), 'no dates reads "No contract dates", never "- -> -"');
check(/From/.test(dates({ start: '2026-05-26' })) && !/→/.test(dates({ start: '2026-05-26' })), 'start only reads "From <date>"');
check(/Until/.test(dates({ end: '2026-12-31' })), 'end only reads "Until <date>"');
check(/→/.test(dates({ start: '2025-12-17', end: '2028-12-17' })), 'both dates keep the arrow');

const core = read('app/core.js');
const util = read('app/utility-data.js');
const gfx = read('app/graphics-setpoints.js');
const html = read('energy-department.html');

// ---- header and dashboard ----
['baseline', 'savproj', 'perf'].forEach((k) =>
  check(new RegExp("toggleProjDetailPanel\\(\\$\\{p\\.id\\},'" + k + "'\\)\" title=\"[^\"]{20,}\"").test(core), 'header button ' + k + ' has a tooltip that says what it opens'),
);
check(/openProjModal\(\);editProj\(\$\{p\.id\}\)" title="/.test(core), 'Edit Project has a tooltip');
check(/blEl\.title = blTitle/.test(core) && /blPeriod/.test(core), 'header Baseline carries its period and a tooltip');
check(/_bCounts\.listed > _eligBldgs\.length \? ' in baseline \(' \+ _bCounts\.listed \+ ' listed\)'/.test(core), 'Dashboard header says "N in baseline (M listed)" when they differ');
check(/<tfoot><tr>[\s\S]*?Total<\/td>/.test(core), 'Building Performance table has a totals row');
check(/Baseline column: /.test(core), 'Building Performance table has a legend for the Baseline icons');
check(/_stTip\[r\.status\]/.test(core), 'every status cell has a tooltip');
check(/renderDashCalendar\(projId\); \/\/ the calendar panel must not stay on "Loading..."/.test(core), 'the no-bills early return still fills the right-hand panel');
check((core.match(/No contacts yet/g) || []).length === 0, 'core.js no longer prints a second "No contacts yet"');
check(/Back to tabs/.test(core) && /_syncProjPanelTabs/.test(core), 'a header panel has a Back button and the tabs stop looking active');
check(/\.pd-tabs\.panel-open \.pdt\.active/.test(html), 'CSS drops the active tab look while a header panel is open');
check(/bldgs\.find\(\(b\) => \(b\.meters \|\| \[\]\)\.length\) \|\| bldgs\[0\]/.test(core), 'Utility Data opens on the first building that has meters');
check(!/white-space: nowrap;\s*text-overflow: ellipsis;\s*}\s*\.pd-hero-compact \.phc-info > \.phc-name/.test(html), 'the header info bar no longer cuts its text with an ellipsis');

// ---- utility ----
check(/getProjectBuildingCounts\(udSelProjId\)/.test(util) && /\$\{_bCounts\.listed\}/.test(util), 'Projected Savings panel reads the one building count');
check(/Destructive actions: each one asks you to confirm first/.test(util) && /margin-left:14px;padding-left:14px;border-left/.test(util), 'Clear Bills and Delete meter sit apart from the normal buttons');
check(/title="How the Days column counts a billing period/.test(util), 'Day calc label has a tooltip');

// ---- home and projects list ----
check(/Savings to Date/.test(html) && !/Est\. Savings\/yr/.test(html), 'Home card says Savings to Date, not Est. Savings/yr');
check(/id="h-base-meta"/.test(html) && /'of ' \+ projects\.length/.test(core), 'Baselines Set says "of N projects"');
check(/en_eqmatrix_' \+ p\.id/.test(core), 'Equipment Records counts the Equipment Matrix rows');
check(/<th title="Share of the time/.test(html), 'Projects list Progress column says what it measures');

// ---- graphics ----
check(/_yrsWithBars/.test(gfx), 'Year-over-year charts leave a year with no bar out of the legend');
check(/\(v < 0 \? '-\$' : '\$'\) \+ Math\.abs\(v\)\.toLocaleString\(\)/.test(gfx), 'dollar axis writes negatives as -$5,000');
check(/_blNote/.test(gfx) && /qInBl/.test(gfx), 'baseline months are not compared with the baseline ("0.0% vs BL")');
check(/title="Eligible: the current Site Energy Use Intensity is at or below/.test(gfx), 'EnergyStar column header explains Eligible / Above');

// the negative-dollar callback, run for real
const axis = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString();
check(axis(-5000) === '-$5,000' && axis(15000) === '$15,000' && axis(0) === '$0', 'axis callback: -5000 -> -$5,000, 15000 -> $15,000');

console.log(fails ? 'FAIL: ' + fails : 'PASS');
process.exit(fails ? 1 : 0);
