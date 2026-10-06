#!/usr/bin/env node
// computations/gas-rate-save-paths.gate.js — regression gate for the gas $/Therm rate.
//
// History: item 2026-09-23-gas-rate-fix2 found 3 of 4 gas-bill SAVE paths in app/bill-analysis.js
// dividing the charge by raw MMBtu (no x10 to Therms) and STORING that $/MMBtu number in
// bill.totalGasRate, mislabeled as $/Therm. The first fix routed every save path through one
// helper (_computeGasRate). The 2026-10-05 duplicate-bill-fields audit (step 5) removed the
// stored rate altogether: no save path writes totalGasRate (or any other total*Rate) any more,
// and every reader calls getStoredRate(bill, 'gas') (computations/rates.js), which divides the
// one gas cost accessor (getBillGasCost) by the one usage resolver (resolveGasUsageTherms).
//
// This gate does two things:
//   1. STRUCTURAL: app/bill-analysis.js has NO save-time `total*Rate:` assignment, no
//      _computeGasRate helper, and no bare `/ mmbtu` division (the original bug shape). If a
//      future edit stores a rate at ANY save site again, this fails before the numeric checks.
//   2. FUNCTIONAL: loads the REAL computations/rates.js (+ savings.js, formatting.js and the unit
//      table) into a Node vm sandbox and drives the REAL getStoredRate(bill, 'gas') with synthetic
//      bills shaped like each save path's input: raw OCR-extractor output (PascalCase
//      NaturalGasMMbtu / NaturalGasTherms / NaturalGasCCF) and an already-saved camelCase bill.
//
// Run:    node computations/gas-rate-save-paths.gate.js
// Exits nonzero on any assertion failure.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const BILL_ANALYSIS_SRC = fs.readFileSync(path.join(REPO, 'app/bill-analysis.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + ' — ' + e.message);
  }
}
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
const BA_CODE = stripComments(BILL_ANALYSIS_SRC);

// ── 1. STRUCTURAL ──
check('structural: no save path stores a total*Rate field any more', () => {
  const lines = BA_CODE.split('\n').filter((l) => /^\s+total\w+Rate:\s/.test(l));
  assert.strictEqual(lines.length, 0, 'stored rate reintroduced: ' + lines.map((l) => l.trim()).join(' | '));
});

check('structural: the _computeGasRate helper is gone (getStoredRate is the one gas rate)', () => {
  assert.ok(!/_computeGasRate/.test(BA_CODE), '_computeGasRate is back in app/bill-analysis.js');
});

check('structural: no bare charge/naturalGasMMbtu division remains (the original bug shape)', () => {
  const offending = BA_CODE.split('\n').filter((l) => /\/\s*mmbtu\b/.test(l));
  assert.strictEqual(offending.length, 0, 'found: ' + offending.map((l) => l.trim()).join(' | '));
});

check('structural: exactly one getStoredRate implementation (computations/rates.js)', () => {
  let n = 0;
  for (const dir of ['app', 'computations', 'lib']) {
    for (const f of fs.readdirSync(path.join(REPO, dir))) {
      if (!f.endsWith('.js')) continue;
      n += (fs.readFileSync(path.join(REPO, dir, f), 'utf8').match(/function getStoredRate\(/g) || []).length;
    }
  }
  assert.strictEqual(n, 1, 'expected one getStoredRate, found ' + n);
});

// ── 2. FUNCTIONAL ──
function loadUnitTable(sandbox) {
  const src = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  const start = src.indexOf('const UNIT_TO_BASE = {');
  const end = src.indexOf('function getMeterBillUnit');
  assert.ok(start > 0 && end > start, 'UNIT_TO_BASE block not found in app/utility-data.js');
  vm.runInContext(src.slice(start, end), sandbox, { filename: 'utility-data.js (unit table extract)' });
}
function buildSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['lib/formatting.js', 'computations/rates.js', 'computations/savings.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  }
  loadUnitTable(sandbox);
  return sandbox;
}
const sandbox = buildSandbox();
const rate = (bill) => sandbox.getStoredRate(bill, 'gas');
const near = (a, b) => Math.abs(a - b) < 1e-9;

check('MMBtu-only OCR extraction (Wood River Energy shape, PascalCase) = charge / (MMBtu x 10)', () => {
  // Synthetic — not a real bill. $200 charge, 5 MMBtu = 50 Therms -> $4.00/Therm.
  assert.ok(
    near(rate({ GasCharge: '200.00', NaturalGasMMbtu: '5' }), 4),
    'got ' + rate({ GasCharge: '200.00', NaturalGasMMbtu: '5' }),
  );
});
check('MMBtu-only, TotalCurrentCharges fallback (no GasCharge field)', () => {
  assert.ok(near(rate({ TotalCurrentCharges: '150.00', NaturalGasMMbtu: '3' }), 5));
});
check('Therms-branch bill (NaturalGasTherms present)', () => {
  assert.ok(near(rate({ GasCharge: '100.00', NaturalGasTherms: '250' }), 0.4));
});
check('CCF-branch bill (NaturalGasCCF present, unit-table conversion)', () => {
  const r = rate({ GasCharge: '103.70', NaturalGasCCF: '100' });
  const therms = sandbox.resolveGasUsageTherms({ NaturalGasCCF: '100' });
  assert.ok(therms > 100 && therms < 120 && near(r, 103.7 / therms), 'got ' + r + ' therms ' + therms);
});
check('same gas volume gives the SAME $/Therm whether reported as Therms or MMBtu', () => {
  assert.ok(
    near(rate({ GasCharge: '450', NaturalGasTherms: '900' }), rate({ GasCharge: '450', NaturalGasMMbtu: '90' })),
  );
});
check('already-saved camelCase bill (post-save shape) resolves the same way', () => {
  assert.ok(near(rate({ gasCharge: '52.4873', naturalGasTherms: '100' }), 0.524873));
});
check('a stale stored totalGasRate never wins over cost / usage', () => {
  assert.ok(near(rate({ gasCharge: '52.4873', naturalGasTherms: '100', totalGasRate: '31.80833' }), 0.524873));
});
check('stored totalGasRate is read only when the bill has no cost or no usage', () => {
  assert.ok(near(rate({ naturalGasTherms: '100', totalGasRate: '0.52' }), 0.52));
  assert.ok(near(rate({ gasCharge: '52', totalGasRate: '0.52' }), 0.52));
});
check('no usage and no charge -> 0 (never a fabricated rate)', () => {
  assert.strictEqual(rate({}), 0);
  assert.strictEqual(rate({ GasCharge: '', NaturalGasMMbtu: '' }), 0);
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
