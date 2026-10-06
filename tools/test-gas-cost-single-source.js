// tools/test-gas-cost-single-source.js — gas commodity cost single-source-of-truth gate
// (2026-10-05 duplicate-bill-fields audit, step 1).
// Run: node tools/test-gas-cost-single-source.js
//
// Loads the REAL lib/formatting.js, computations/rates.js and computations/savings.js (plus the
// one unit table from app/utility-data.js) into a Node vm sandbox and proves, on SYNTHETIC
// bills only (never real client data in the repo):
//   1. getBillGasCost / getBillGasCostOrNull read the visible `gasCharge` field (camel or the
//      extractor's PascalCase), never the old stored copy `thermCost`.
//   2. A real 0 gas charge stays 0; a missing gas charge is null (OrNull) or 0 (plain).
//   3. The whole-bill total is the fallback ONLY when gasCharge is blank AND the bill has gas
//      usage — a Water/Sewer bill never gets a "gas cost" from its total.
//   4. STRUCTURAL: no reader anywhere in app/, computations/, lib/ or extraction/ reads bill.thermCost,
//      and no writer stores it (the hidden `bl-thermCost` modal input is gone).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

function buildSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = (rel) => vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  run('lib/formatting.js');
  run('computations/rates.js');
  run('computations/savings.js');
  // resolveGasUsageTherms reads UNIT_TO_BASE + convertUnit from app/utility-data.js.
  const ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  const start = ud.indexOf('const UNIT_TO_BASE = {');
  const end = ud.indexOf('function getMeterBillUnit');
  if (!(start > 0 && end > start)) throw new Error('UNIT_TO_BASE block not found in app/utility-data.js');
  vm.runInContext(ud.slice(start, end), sandbox, { filename: 'utility-data.js (unit table extract)' });
  return sandbox;
}

const S = buildSandbox();
const cost = (b) => S.getBillGasCost(b);
const costOrNull = (b) => S.getBillGasCostOrNull(b);

console.log('1. reads the visible gasCharge field, never thermCost');
assert(
  cost({ gasCharge: '4081.00', thermCost: '16716.39', totalCost: '3950.91' }) === 4081,
  'gasCharge wins over thermCost and totalCost',
);
assert(
  cost({ GasCharge: '52.49', TotalCurrentCharges: '80.00', NaturalGasTherms: '100' }) === 52.49,
  'extractor PascalCase GasCharge',
);
assert(
  cost({ gasCharge: '1,234.56', naturalGasTherms: '10' }) === 1234.56,
  'currency text parsed by the one bill-number parser',
);
assert(
  cost({ thermCost: '500', totalCost: '500', naturalGasTherms: '100' }) === 500,
  'no gasCharge + usage: whole bill total (not thermCost) is the fallback',
);
assert(
  cost({ thermCost: '500', naturalGasTherms: '100' }) === 0,
  'no gasCharge, no total: thermCost alone is never read',
);

console.log('2. a real 0 stays 0; missing is null / 0');
assert(
  costOrNull({ gasCharge: 0, totalCost: '55.00', naturalGasTherms: '0' }) === 0,
  'real 0 gasCharge stays 0 (OrNull)',
);
assert(cost({ gasCharge: '0', totalCost: '55.00', naturalGasTherms: '0' }) === 0, 'real 0 gasCharge stays 0 (plain)');
assert(costOrNull({ gasCharge: '', totalCost: '', naturalGasTherms: '10' }) === null, 'nothing on the bill: null');
assert(
  cost({ gasCharge: '', totalCost: '', naturalGasTherms: '10' }) === 0,
  'nothing on the bill: 0 from the plain accessor',
);
assert(costOrNull(null) === null && cost(undefined) === 0, 'no bill object');

console.log('3. whole-bill total fallback only with gas usage');
assert(cost({ totalCost: '120.00', naturalGasCCF: '50' }) === 120, 'blank gasCharge + CCF usage: total');
assert(
  cost({ TotalAmountDue: '120.00', NaturalGasMMbtu: '2' }) === 120,
  'blank GasCharge + MMBtu usage: TotalAmountDue',
);
assert(cost({ totalCost: '120.00', therms: '0' }) === 120, 'usage of 0 is still usage: total');
assert(
  costOrNull({ totalCost: '120.00', waterUsage: '3000', waterCharge: '90.00' }) === null,
  'water bill: no gas usage, no gas cost',
);
assert(costOrNull({ totalCost: '120.00' }) === null, 'no usage field at all: no gas cost');

console.log('4. structural: thermCost is never read or written in app code');
// Strip block and line comments first: a comment that names the old field is history, not a read.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}
const SCAN_DIRS = ['app', 'computations', 'lib', 'extraction'];
const offenders = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(REPO, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.js')) continue;
    const lines = stripComments(fs.readFileSync(path.join(full, f), 'utf8')).split('\n');
    lines.forEach((l, n) => {
      if (/\bthermCost\b/.test(l)) offenders.push(dir + '/' + f + ':' + (n + 1) + ' ' + l.trim());
    });
  }
}
assert(offenders.length === 0, 'thermCost still referenced in code:' + offenders.map((o) => '\n    ' + o).join(''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
