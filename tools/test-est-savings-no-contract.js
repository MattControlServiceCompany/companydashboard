// tools/test-est-savings-no-contract.js - SHW-3 (Matt 2026-09-21): ESTIMATED savings show without a contract;
// only ACTUAL (bill-based) savings need a contract (GLB-1: contract type, never the SA#).
// Run: node tools/test-est-savings-no-contract.js
// SYNTHETIC data only. Runs the REAL gate lines cut from app/core.js and the REAL projHasContract.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const core = read('app/core.js');
const line = (re) => {
  const m = core
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => re.test(l));
  if (!m) throw new Error('line not found: ' + re);
  return m.trim();
};

// real projHasContract + its keeper
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(read('computations/csc.js'), ctx);
const sv = read('computations/savings.js');
const s0 = sv.indexOf('function projHasContract');
vm.runInContext(sv.slice(s0, sv.indexOf('\n}', s0) + 2), ctx);
vm.runInContext(
  'var projects = [' +
    '{id:"n",contractType:"none",sa:"",savings:12000},' +
    '{id:"c",contractType:"sharedSavings",sa:"SA-1",savings:12000}];',
  ctx,
);
assert(vm.runInContext('projHasContract("n")', ctx) === false, 'no-contract project has no contract');
assert(vm.runInContext('projHasContract("c")', ctx) === true, 'contract project has a contract');

// 1 Dashboard header: Est. Savings target and ECM projected total
const estLine = line(/^const estSavings =/);
const ecmLine = line(/^const ecmTotal =/);
function dash(projId, p, ecm) {
  const c = Object.assign(vm.createContext({}), { projHasContract: (id) => vm.runInContext('projHasContract("' + id + '")', ctx) });
  c.p = p;
  c.projId = projId;
  c._ecmResult = { total: ecm };
  c._hasContract = c.projHasContract(projId);
  return vm.runInContext(estLine.replace(/^const /, 'var ') + '\n' + ecmLine.replace(/^const /, 'var ') + '\n[estSavings, ecmTotal]', c);
}
const none = dash('n', { savings: 12000 }, 8000);
assert(none[0] === 12000, 'no contract: Est. Savings target shows 12000, got ' + none[0]);
assert(none[1] === 8000, 'no contract: ECM projected total shows 8000, got ' + none[1]);
const con = dash('c', { savings: 12000 }, 8000);
assert(con[0] === 12000 && con[1] === 8000, 'contract project unchanged: ' + con);

// 2 project detail "Est. Savings/yr" cell and the compact header "Savings" item
for (const re of [/Est\. Savings\/yr/, /phc-item">Savings/]) {
  const l = line(re);
  assert(!/projHasContract/.test(l), 'no contract gate on: ' + l.slice(0, 80));
}

// 3 ACTUAL savings stay gated by the contract in computations/savings.js
assert(/savings: hasContract \? finalCostSav : 0/.test(sv), 'actual cost savings still 0 without a contract');
assert(/kwhCostSav: hasContract \? kwhCostSav : 0/.test(sv), 'actual kWh cost savings still gated');
assert(/kwCostSav: hasContract \? kwCostSav : 0/.test(sv), 'actual kW cost savings still gated');

console.log(`est-savings-no-contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
