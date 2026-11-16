// test-dashboard-target-and-header-eui.js -- Matt 2026-11-16, items D03 and D09. Synthetic data only; no browser: the real functions are cut
// from the app source into a Node vm context.
//  D03  the one target-allocation rule (allocateTargetByBaselineCost, lib/formatting.js) gives KNOWN per-building targets, and the quarterly
//       report's per-building target (_rptBuildingTarget) still returns exactly those figures; the Dashboard Status column compares each
//       building with its own share (source checks: no whole-project comparison is left).
//  D09  the header "est." Site EUI divides the energy of the buildings that have bills by the floor area of those same buildings; a project
//       where every building has bills keeps the value of the whole-area formula; the hover names the buildings and sf counted.
// Check: node tools/test-dashboard-target-and-header-eui.js   Exit 1 on any FAIL.
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
const same = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');

const ctx = makeContext();
['eui', 'regression', 'physics'].forEach((f) => vm.runInContext(read('computations/' + f + '.js'), ctx));
vm.runInContext(['_rptApportion', 'allocateTargetByBaselineCost'].map((n) => fnSource('lib/formatting.js', n)).join('\n'), ctx);
vm.runInContext(fnSource('app/report-engine.js', '_rptBuildingTarget'), ctx);

// ---- D03: known values (worked by hand: share = target x building baseline cost / project baseline cost, whole dollars adding to the target) ----
same(vm.runInContext('allocateTargetByBaselineCost(10000, [3000, 1000, 1000])', ctx), [6000, 2000, 2000], 'target 10,000 over costs 3,000/1,000/1,000');
same(vm.runInContext('allocateTargetByBaselineCost(1000, [1, 1, 1])', ctx), [334, 333, 333], 'target 1,000 over three equal costs: whole dollars that add to 1,000');
same(vm.runInContext('allocateTargetByBaselineCost(5000, [2000, 0, 6000])', ctx), [1250, 0, 3750], 'a building with no baseline cost has a target of 0');
same(vm.runInContext('allocateTargetByBaselineCost(0, [100, 200])', ctx), [0, 0], 'no target set: every building 0');
const d = { period: { type: 'quarterly', quarter: 3 }, contract: { quarterlyTargets: [0, 0, 1000, 0], annualTarget: 4000 },
  buildings: [{ blCost: 1 }, { blCost: 1 }, { blCost: 1 }] };
ctx.d = d;
same(vm.runInContext('d.buildings.map(b => _rptBuildingTarget(d, b))', ctx), [334, 333, 333], 'report per-building target = the same figures (quarter)');
d.period.type = 'annual';
same(vm.runInContext('d.buildings.map(b => _rptBuildingTarget(d, b))', ctx), [1334, 1333, 1333], 'report per-building target = the same figures (annual 4,000)');
d.contract.annualTarget = 0;
same(vm.runInContext('d.buildings.map(b => _rptBuildingTarget(d, b))', ctx), [0, 0, 0], 'report: no target gives 0');

const core = read('app/core.js');
check(/allocateTargetByBaselineCost\(\s*projectedAnnual,/.test(core), 'Dashboard allocates the project target with the shared function');
check(!/sav >= estSavings \* 0\.8/.test(core), 'Dashboard no longer compares a building with the whole-project target');
check(/r\.sav >= r\.target \* 0\.8/.test(core), 'Dashboard compares a building with 80% of its own target');
check(/building.{1,2}s share of the project target/.test(core), 'status hover names the basis (this building\'s share)');

// ---- D09: header est. Site EUI ----
const months = [];
for (let i = 1; i <= 12; i++) months.push('2025-' + String(i).padStart(2, '0'));
const meter = (id, kwh) => ({ id, commodity: 'Electric', inclusive: true,
  bills: months.map((ym) => ({ start: ym + '-01', end: ym + '-28', kwh, totalCost: kwh * 0.1 })) });
const setProj = (bl) => {
  const pr = { id: 1, name: 'S', calcCommodities: ['Electric', 'Gas', 'Propane', 'Unknown'], scope: { buildingIds: bl.map((b) => b.id), meterExcludeIds: [] } };
  ctx.projects = [pr]; ctx.utilityData = { c1: { buildings: bl } };
  ctx.sget = (k, dflt) => (k === 'en_projects' ? [pr] : dflt);
};
Object.assign(ctx, { udSelProjId: 1, _resolveCustomerId: () => 'c1', _escHtml: (s) => s, getBillGasCost: () => 0, _phcFullTitle: () => {} });
const els = {};
ctx.document = { getElementById: (id) => els[id] || (els[id] = { innerHTML: '', title: '', textContent: '' }) };
const uSrc = 'app/utility-data.js';
vm.runInContext(['getUDProj', 'getUDBldgs', 'isUnmatchedSentinelBldg', 'getIncludedBldgs', 'getBaselineEligibleBldgs', 'isBaselineExcluded', 'getProjectBaselineTotals'].map((n) => fnSource(uSrc, n)).join('\n'), ctx);
vm.runInContext(['isCalcCommodity', '_updateCompactHdrBaseline'].map((n) => fnSource('app/core.js', n)).join('\n'), ctx);
const kb = (kwh) => kwh * 12 * 3.412; // kBtu of one meter, 12 bills
const hdr = () => { vm.runInContext('_updateCompactHdrBaseline(1)', ctx); return { eui: (els['phc-eui-1'].innerHTML.match(/phc-val">([^<]+)</) || [])[1], est: /est\./.test(els['phc-eui-1'].innerHTML), title: els['phc-eui-1'].title }; };

// every building has bills: the value is the whole-area formula (all kBtu / all sf)
setProj([{ id: 'a', name: 'A', sqft: 40000, meters: [meter('m1', 30000)] }, { id: 'b', name: 'B', sqft: 20000, meters: [meter('m2', 12000)] }]);
let h = hdr();
check(h.est && h.eui === ((kb(30000) + kb(12000)) / 60000).toFixed(1), 'all buildings billed: est. Site EUI = all kBtu / all sf (' + h.eui + ')');
// one building has no bills: its sf is not counted
setProj([{ id: 'a', name: 'A', sqft: 40000, meters: [meter('m1', 30000)] }, { id: 'b', name: 'B', sqft: 20000, meters: [meter('m2', 12000)] },
  { id: 'c', name: 'C', sqft: 100000, meters: [{ id: 'm3', commodity: 'Electric', inclusive: true, bills: [] }] }]);
h = hdr();
check(h.est && h.eui === ((kb(30000) + kb(12000)) / 60000).toFixed(1), 'a building with no bills is left out of the area (' + h.eui + ', not ' + ((kb(30000) + kb(12000)) / 160000).toFixed(1) + ')');
check(/2 of 3 buildings, 60,000 sf/.test(h.title), 'hover names the buildings and sf counted (' + h.title + ')');

console.log(fails ? 'FAIL: ' + fails : 'PASS');
process.exit(fails ? 1 : 0);
