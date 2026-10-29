// test-building-count-and-baseline-eui.js -- Matt, 2026-10-29: the Dashboard said "7 buildings" while the project had 6
// included ones, and the project header Site EUI (43.4) differed from Energy Graphics (43.6).
// Rules: (1) the Dashboard counts and sizes ONLY getBaselineEligibleBldgs; (2) the header Site EUI and the
// Energy Graphics Baseline Site EUI both come from getProjectBaselineTotals (one function, no second formula).
// Synthetic data only. No browser: the real functions are cut from the app source into a Node vm context.
// Check: node tools/test-building-count-and-baseline-eui.js   Exit 1 on any FAIL.
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

// ---- synthetic project: Alpha and Beta are included; Gamma has sqft but every meter is excluded ----
const months = [];
for (let i = 1; i <= 12; i++) months.push('2025-' + String(i).padStart(2, '0'));
const meter = (id, kwh) => ({
  id, commodity: 'Electric', inclusive: true,
  baseline: { months: months.slice() },
  bills: months.map((ym) => ({ start: ym + '-01', end: ym + '-28', kwh, totalCost: kwh * 0.1, demandKW: 50 })),
});
const bldgs = [
  { id: 'bA', name: 'Alpha', sqft: 40000, meters: [meter('mA', 30000)] },
  { id: 'bB', name: 'Beta', sqft: 20000, meters: [meter('mB', 12000)] },
  { id: 'bG', name: 'Gamma', sqft: 5000, meters: [meter('mG', 90000)] },
];
const project = { id: 1, name: 'Synthetic', calcCommodities: ['Electric', 'Gas', 'Propane', 'Unknown'],
  scope: { buildingIds: ['bA', 'bB', 'bG'], meterExcludeIds: ['mG'] } };

const ctx = makeContext();
['eui', 'regression', 'physics'].forEach((f) => vm.runInContext(read('computations/' + f + '.js'), ctx));
Object.assign(ctx, {
  projects: [project], udSelProjId: 1, utilityData: { c1: { buildings: bldgs } },
  sget: (k, d) => (k === 'en_projects' ? [project] : d),
  _resolveCustomerId: () => 'c1', _escHtml: (s) => s,
  getBillGasCost: () => 0,
});
const uSrc = 'app/utility-data.js';
vm.runInContext(['getUDProj', 'getUDBldgs', 'getBaselineEligibleBldgs', 'isBaselineExcluded', 'getProjectBaselineTotals'].map((n) => {
  try { return fnSource(uSrc, n); } catch (e) { fail('app/utility-data.js has no function ' + n); return ''; }
}).join('\n'), ctx);
vm.runInContext(['isCalcCommodity', '_updateCompactHdrBaseline'].map((n) => fnSource('app/core.js', n)).join('\n'), ctx);

// ---- counts ----
const elig = vm.runInContext('getBaselineEligibleBldgs(1).map(b => b.name)', ctx);
check(JSON.stringify(elig) === '["Alpha","Beta"]', 'eligible list = included buildings only (got ' + JSON.stringify(elig) + ')');
const core = read('app/core.js');
check(/const _eligBldgs = getBaselineEligibleBldgs\(projId\)/.test(core), 'Dashboard builds its building list with getBaselineEligibleBldgs');
check(/\$\{_eligBldgs\.length\} building/.test(core), 'Dashboard header count uses the eligible list');
check(!/\$\{bldgs\.length\} building\$\{/.test(core), 'Dashboard header count does not use the raw building list');
check(!/: bldgs\.length \+ ' building'/.test(core) && !/throughDate : bldgs\.length/.test(core), 'Dashboard savings cards do not count the raw building list');

// ---- EUI: header call site, run for real; Energy Graphics call site, by source ----
const els = {};
ctx.document = { getElementById: (id) => els[id] || (els[id] = { innerHTML: '', title: '', textContent: '' }) };
ctx._phcFullTitle = () => {};
vm.runInContext('_updateCompactHdrBaseline(1)', ctx);
const hdrEui = (els['phc-eui-1'].innerHTML.match(/phc-val">([^<]+)</) || [])[1];
const tot = vm.runInContext('getProjectBaselineTotals(1)', ctx);
const expected = (((30000 + 12000) * 12 * 3.412) / 12 * 12) / 60000; // kWh x 3.412 kBtu, 12 months, included sqft only
check(Math.abs(tot.eui - expected) < 0.01, 'getProjectBaselineTotals EUI = ' + tot.eui.toFixed(2) + ' (expect ' + expected.toFixed(2) + ', excluded building left out)');
check(tot.sqft === 60000, 'EUI area = included buildings only (' + tot.sqft + ')');
check(hdrEui === tot.eui.toFixed(1), 'header Site EUI (' + hdrEui + ') = shared function (' + tot.eui.toFixed(1) + ')');
const gfx = read('app/graphics-setpoints.js');
const egfx = gfx.slice(gfx.indexOf('function egfxRefresh'));
check(/const blEui = getProjectBaselineTotals\(projId\)\.eui/.test(egfx), 'Energy Graphics Baseline Site EUI calls getProjectBaselineTotals');
check(!/const blEui = sqft > 0 \? blKbtu \/ sqft/.test(egfx), 'Energy Graphics has no second Baseline Site EUI formula');

console.log(fails ? 'FAIL: ' + fails : 'PASS');
process.exit(fails ? 1 : 0);
