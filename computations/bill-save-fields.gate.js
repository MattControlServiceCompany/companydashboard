#!/usr/bin/env node
// computations/bill-save-fields.gate.js — deploy gate for the shape of a saved bill row.
//
// WHY (2026-10-05 duplicate-bill-fields audit, step 8): for a year the bill save paths stored
// copies and roll-ups next to the real fields (thermCost next to gasCharge, kwCost/kwhCost/
// otherCost/taxCost next to the charge lines, total*Rate next to cost and usage, facKWCost next
// to facilitiesCharge, kwh on gas bills, fromPDF next to hasPDF/pdfKey) and the Edit modal
// round-tripped them through hidden inputs. Each copy went stale the moment the visible field
// was edited, and readers disagreed about which one to trust (Client A Q1 Appendix D listed 6
// February bills while the savings math used 11). Steps 1-7 removed every copy. This gate keeps
// them out:
//   1. Every key a bill-row builder in app/bill-analysis.js writes is either a BILL_SCHEMA key
//      (app/csv-import.js — the fields the Bills table and the Edit modal show) or on the short,
//      explicit META list below (identity, PDF link, extractor detail with no column yet).
//      A retired copy, or any new unlisted key, fails the gate.
//   2. openBillModal (app/csv-import.js) renders no hidden `bl-` input: nothing is round-tripped
//      behind the user's back.
//   3. billHasPdf (computations/rates.js) is the one "has a PDF" answer.
//
// Run:    node computations/bill-save-fields.gate.js
// Exits nonzero on any failure.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').split('\r\n').join('\n');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');

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

// ── BILL_SCHEMA keys (the visible fields) ──
const CSV = read('app/csv-import.js');
const schemaStart = CSV.indexOf('const BILL_SCHEMA = {');
const schemaEnd = CSV.indexOf('\n};', schemaStart) + 3;
assert.ok(schemaStart > 0 && schemaEnd > schemaStart, 'BILL_SCHEMA block not found in app/csv-import.js');
const sb = { console };
vm.createContext(sb);
vm.runInContext(CSV.slice(schemaStart, schemaEnd) + '\nthis.BILL_SCHEMA = BILL_SCHEMA;', sb);
const SCHEMA_KEYS = new Set();
Object.values(sb.BILL_SCHEMA).forEach((list) => list.forEach((e) => e.key && SCHEMA_KEYS.add(e.key)));

// ── META keys a saved row may carry that are not Bills-table columns. Each one is a fact of its
// own (not a copy of another field). Add to this list only with a reason. ──
const META_KEYS = new Set([
  'id', // row identity
  'commodity', // the extractor's commodity label on the row (meter commodity is the source for math)
  'pdfBillId', // link to the en_pdf_bills record
  'hasPDF', // set by the save path when the PDF file store succeeded (billHasPdf reads it)
  'pdfKey', // storage key of the attached PDF file
  'pdfPageStart', // page range inside a multi-bill PDF
  'pdfPageEnd',
  'therms', // canonical Therms figure (resolveGasUsageTherms reads it first; one unit conversion at save time)
  'thermFactor', // printed CCF->Therm factor (resolveGasUsageTherms uses it)
  'renewableCharge', // electric line items with no schema column yet (shown in the extracted-fields panel)
  'solarCredit',
  'generationKwh',
  'miscellaneousCharge', // part of getBillOtherCost
  'franchiseFee1', // KGS prints two franchise-fee lines; franchiseFee is the sum
  'franchiseFee2',
  'facilitiesRate', // printed unit rates from the bill (not computed, not copies)
  'demandRate',
  'tdcRate',
  'ecaRate',
  'eerRate',
  'ptsRate',
  'rkvaRate',
  'mcfBilled', // KGS / Constellation detail lines
  'deliveryCharge',
  'gasSystemReliability',
  'winterEventCost',
  'previouslyBilled',
  'previousBalance', // statement facts printed on the bill (no column yet)
  'paymentsReceived',
  'statementDate',
  '_manualReview', // extractor review markers
  '_manualReviewLabel',
  '_mmbtuRateMismatch',
  '_mmbtuMissingWithCharge',
]);
const META_PREFIX = [/^_wre/, /^Meter[12]_/]; // WoodRiver per-site components; per-meter split of a two-meter bill

// ── The copies that steps 1-7 retired. These must never come back under any name. ──
const RETIRED = new Set([
  'thermCost',
  'kwCost',
  'kwhCost',
  'otherCost',
  'taxCost',
  'usage',
  'cost',
  'facKWCost',
  'fromPDF',
  'totalKwhRate',
  'totalKwRate',
  'totalGasRate',
  'totalWaterRate',
  'totalSewerRate',
  'totalPropaneRate',
  'totalStormwaterRate',
  '_anomaly',
]);

const BA = stripComments(read('app/bill-analysis.js'));

// Every bill-row object literal a save path builds: `const billRow = {` / `const newBillRow = {`.
function builderLiterals(src) {
  const out = [];
  const re = /^([ \t]+)const (billRow|newBillRow) = \{\n/gm;
  let m;
  while ((m = re.exec(src))) {
    const indent = m[1];
    const end = src.indexOf('\n' + indent + '};', m.index);
    assert.ok(end > 0, 'unterminated builder literal at offset ' + m.index);
    const body = src.slice(m.index + m[0].length, end);
    const line = src.slice(0, m.index).split('\n').length;
    const keys = [];
    const keyRe = new RegExp('^' + indent + '  ([A-Za-z_$][\\w$]*)\\s*:', 'gm');
    let k;
    while ((k = keyRe.exec(body))) keys.push(k[1]);
    out.push({ line, keys });
  }
  return out;
}
const builders = builderLiterals(BA);

check('every bill-row builder in app/bill-analysis.js was found (6 save paths)', () => {
  assert.strictEqual(
    builders.length,
    6,
    'found ' + builders.length + ' builders at lines ' + builders.map((b) => b.line).join(', '),
  );
});

check(
  'no builder writes a retired copy (thermCost, kwCost, kwhCost, otherCost, taxCost, usage, cost, facKWCost, fromPDF, total*Rate)',
  () => {
    const bad = [];
    builders.forEach((b) => b.keys.forEach((k) => RETIRED.has(k) && bad.push('line ' + b.line + ': ' + k)));
    assert.strictEqual(bad.length, 0, bad.join(' | '));
  },
);

check('every key a builder writes is a BILL_SCHEMA key or a listed META key', () => {
  const bad = [];
  builders.forEach((b) =>
    b.keys.forEach((k) => {
      if (SCHEMA_KEYS.has(k) || META_KEYS.has(k) || META_PREFIX.some((re) => re.test(k))) return;
      bad.push('line ' + b.line + ': ' + k);
    }),
  );
  assert.strictEqual(
    bad.length,
    0,
    'unlisted keys (a new copy, or add to META_KEYS with a reason): ' + bad.join(' | '),
  );
});

check('the shared mapper _extractedToBillRowCosts no longer feeds stored roll-ups into a row', () => {
  const bad = BA.split('\n').filter((l) => /^\s+(kwCost|kwhCost|otherCost|taxCost|thermCost),\s*$/.test(l));
  assert.strictEqual(bad.length, 0, bad.map((l) => l.trim()).join(' | '));
});

check('openBillModal renders no hidden bl- input (nothing is round-tripped behind the user)', () => {
  const csv = stripComments(CSV);
  const a = csv.indexOf('function openBillModal(');
  const b = csv.indexOf('\nfunction ', a + 10);
  const fn = csv.slice(a, b);
  assert.ok(fn.length > 100, 'openBillModal not found');
  assert.ok(
    !/type="hidden"\s+id="bl-/.test(fn) && !/LEGACY_PASSTHROUGH/.test(fn),
    'hidden bl- input or LEGACY_PASSTHROUGH is back in openBillModal',
  );
  const sa = csv.indexOf('function saveBillRow(');
  const sfn = csv.slice(sa, csv.indexOf('\nfunction ', sa + 10));
  assert.ok(!/LEGACY_PASSTHROUGH/.test(sfn), 'saveBillRow still round-trips legacy fields');
});

check('billHasPdf is the one "has a PDF" answer; fromPDF is never read', () => {
  const rs = { console };
  rs.window = rs;
  vm.createContext(rs);
  vm.runInContext(read('lib/formatting.js') + '\n' + read('computations/rates.js'), rs);
  assert.strictEqual(rs.billHasPdf({ hasPDF: true }), true);
  assert.strictEqual(rs.billHasPdf({ pdfKey: 'en_pdf_shared_1' }), true);
  assert.strictEqual(rs.billHasPdf({ fromPDF: true }), false, 'fromPDF alone is not a PDF');
  assert.strictEqual(rs.billHasPdf({}), false);
  assert.strictEqual(rs.billHasPdf(null), false);
  const reads = [];
  for (const dir of ['app', 'computations', 'lib']) {
    for (const f of fs.readdirSync(path.join(REPO, dir))) {
      if (!f.endsWith('.js') || f.endsWith('.gate.js')) continue;
      stripComments(read(dir + '/' + f))
        .split('\n')
        .forEach((l, i) => {
          if (/\.fromPDF\b/.test(l)) reads.push(dir + '/' + f + ':' + (i + 1));
        });
    }
  }
  assert.strictEqual(reads.length, 0, 'fromPDF read at ' + reads.join(', '));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
