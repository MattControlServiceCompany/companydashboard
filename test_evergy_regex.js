// test_evergy_regex.js — Evergy OCR regex extraction tests
// Run: node test_evergy_regex.js
// All 24 fields must pass (per CLAUDE.md).
//
// This file extracts the core regex patterns and charge-extraction helpers
// from energy-department.html and tests them against real OCR garble samples.

'use strict';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; failures.push(msg); console.log(`  FAIL: ${msg}`); }
}

// ─── Patterns copied from energy-department.html ───────────────────────────────
// These MUST stay in sync with the source. If the source changes, update here.

const _EVG_BILLING_DETAILS = /B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]{1,2}[s5]?\s*[-\u2013\u2014]\s*[s5]erv[il1]ce\s+from/i;
const _EVG_SERVICE_FROM = /[s5]erv[il1]ce\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i;
const _EVG_ACCT = /[Aa]ccount\s+(?:N[ou]mber\s*)?[:\s\u00a9\u00ae]\s*(\d[\d ]{4,18}\d)/m;

// OCR-tolerant "Chg" keyword
const C = '(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[.:]?';

// ─── Facilities keyword pattern (THE PATTERN UNDER TEST) ───────────────────────
// NEW (prefix): Fac\w* — match "Fac" + any word chars. The charge keyword (C)
// after the whitespace anchors the match, preventing false positives.
const FAC_KEYWORD = 'Fac\\S*';

// ─── Charge extraction helpers (from energy-department.html lines 5605-5639) ───
const CHG_STOP = /(?:Cust|Fac\S|Demand|Energy\s+C|ECA|EER|PTS|TDC|RkVA|Subtotal|Current\s+Charges)/i;

function getAmt(line) {
  const ms = [...line.matchAll(/\$([\d,]+\.\d{2})/g)];
  let best = null;
  for (const m of ms) {
    const before = line.slice(Math.max(0, m.index - 4), m.index);
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
    if (/at\s*$/.test(before)) continue;
    if (/\s*[Pp][eo]r\s+k/i.test(after)) continue;
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val < 1 && /\.\d{3,}/.test(m[1])) continue;
    best = parseFloat(m[1].replace(/,/g, ''));
  }
  return best;
}

function xChg(keyword, text, excludeRe) {
  const lines = text.split('\n');
  let total = 0, found = false;
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(keyword, 'i').test(lines[i])) continue;
    if (excludeRe && excludeRe.test(lines[i])) continue;
    const a = getAmt(lines[i]);
    if (a !== null) { total += a; found = true; }
    else {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const l = lines[j];
        if (CHG_STOP.test(l) && !/per\s+k[Wh]/i.test(l) && !/^[\d,]+\.\d+\s+kWh\s+at/i.test(l)) break;
        const ja = getAmt(l);
        if (ja !== null) { total += ja; found = true; break; }
      }
    }
  }
  return found ? total.toFixed(2) : null;
}

function extractFacKW(text) {
  return text.match(new RegExp(FAC_KEYWORD + '\\s+' + C + '\\s+([\\d,.]+)\\s*[kK][Ww]', 'i'))?.[1]?.replace(/,/g, '') || null;
}

function extractFacChg(text) {
  return xChg(FAC_KEYWORD + '\\s+' + C, text);
}

// ─── Detect function (from UTILITY_RULES, line 5958) ───────────────────────────
function detectFacilitiesLine(text) {
  return new RegExp('Fac\\S*\\s+' + C, 'i').test(text);
}

// ─── Reconciliation fallback pattern (line 5932) ───────────────────────────────
function reconciliationMatch(line) {
  return /fac/i.test(line);
}


// =============================================================================
//  TEST SUITE
// =============================================================================

console.log('\n=== Evergy Facilities Regex Tests ===\n');

// ── Group 1: Clean / lightly garbled text (should already pass) ──────────────
console.log('--- Group 1: Clean text (regression) ---');

const clean_samples = [
  { label: 'Clean "Facilities Chg"',           line: 'Facilities Chg 210.00 kW at $6.577 per kW $1,381.17' },
  { label: 'Lowercase "facilities chg"',        line: 'facilities chg 210.00 kW $1,381.17' },
  { label: 'OCR i→1 "Fac1l1t1es Chg"',         line: 'Fac1l1t1es Chg 210.00 kW $1,381.17' },
  { label: 'OCR g→q "Facilities Chq"',          line: 'Facilities Chq 210.00 kW $1,381.17' },
  { label: 'OCR g→9 "Facilities Ch9"',          line: 'Facilities Ch9 210.00 kW $1,381.17' },
  { label: 'OCR Ghg "Facilities Ghg"',          line: 'Facilities Ghg 210.00 kW $1,394.55' },
  { label: 'OCR CNG "Facilities CNG"',          line: 'Facilities CNG 210.00 kW $1,394.55' },
  { label: 'Missing i "Facilties Chg"',         line: 'Facilties Chg 210.00 kW $1,381.17' },
  { label: 'Double l "Facillties Chg"',         line: 'Facillties Chg 210.00 kW $1,381.17' },
];

for (const s of clean_samples) {
  assert(extractFacChg(s.line) !== null, `FacChg: ${s.label}`);
  assert(extractFacKW(s.line) !== null, `FacKW: ${s.label}`);
  assert(detectFacilitiesLine(s.line), `Detect: ${s.label}`);
}

// ── Group 2: Heavily garbled OCR text (currently FAILS — this is the bug) ────
console.log('\n--- Group 2: Heavy OCR garble (bug reproduction) ---');

const garbled_samples = [
  { label: 'OCR l→r "Facriities Chg"',          line: 'Facriities Chg 210.00 kW at $6.577 per kW $1,381.17' },
  { label: 'OCR il→H "FacHities Chg"',          line: 'FacHities Chg 210.00 kW $1,381.17' },
  { label: 'OCR dropped chars "Facties Chg"',   line: 'Facties Chg 210.00 kW $1,381.17' },
  { label: 'OCR extra char "Facillities Chg"',  line: 'Facillities Chg 210.00 kW $1,381.17' },
  { label: 'OCR severe "Fac11t1es CNG"',        line: 'Fac11t1es CNG 210.00 kW $1,381.17' },
  { label: 'OCR l→| "Fac|lities Chg"',          line: 'Fac|lities Chg 210.00 kW $1,381.17' },
  { label: 'OCR itit swap "Facitities Chg"',    line: 'Facitities Chg 210.00 kW $1,381.17' },
  { label: 'OCR mangled "Faclilties Chg"',      line: 'Faclilties Chg 210.00 kW $1,381.17' },
  { label: 'OCR truncated "Fac Chg"',           line: 'Fac Chg 210.00 kW $1,381.17' },
  { label: 'Multiline garble amount next line',  line: 'Facriities Chg 210.00 kW at $6.577 per kW\n$1,381.17' },
];

for (const s of garbled_samples) {
  assert(extractFacChg(s.line) !== null, `FacChg: ${s.label}`);
  // FacKW — some garble drops kW, test where it's on the line
  if (s.line.includes('kW')) {
    assert(extractFacKW(s.line.split('\n')[0]) !== null, `FacKW: ${s.label}`);
  }
  assert(detectFacilitiesLine(s.line.split('\n')[0]), `Detect: ${s.label}`);
}

// ── Group 3: Full bill text extraction (end-to-end) ──────────────────────────
console.log('\n--- Group 3: Full bill text (end-to-end) ---');

const fullBillText = `Account Number: 1234567890
Customer Name: CONTROL SERVICE COMPANY
123 Main St Kansas City KS

LGS
Billing Details - service from 01/15/2025 to 02/14/2025

01/15 02/14 30 51225.2699 49100.5432 2124.7267 1.000 2124.73 210.00 45.20

Customer Chg $105.97
Facriities Chg 210.00 kW at $6.577 per kW $1,381.17
Demand Chg 210.00 kW at $2.577 per kW $541.17
Energy Chg On Pk 1,500.00 kWh at $0.06407 per kWh $96.11
Energy Chg Off Pk 624.73 kWh at $0.04205 per kWh $26.28
ECA Chg for 2,124.73 kWh $158.97
EER Chg for 2,124.73 kWh $22.45
PTS Chg for 2,124.73 kWh $5.31
TDC Chg 210.00 kW at $1.234 per kW $259.14
RkVA Chg 45.20 kW at $0.50 per kW $22.60
Tax exempt delivery $45.00
Franchise Fee $12.50
Subtotal $2,676.67
Current Charges $2,676.67`;

assert(extractFacChg(fullBillText) === '1381.17', `Full bill: FacChg = 1381.17 (got ${extractFacChg(fullBillText)})`);
assert(extractFacKW(fullBillText) === '210.00', `Full bill: FacKW = 210.00 (got ${extractFacKW(fullBillText)})`);

// Same bill but with different garble pattern
const fullBillGarbled2 = fullBillText.replace('Facriities', 'FacHities');
assert(extractFacChg(fullBillGarbled2) === '1381.17', `Full bill garbled2: FacChg = 1381.17 (got ${extractFacChg(fullBillGarbled2)})`);

const fullBillGarbled3 = fullBillText.replace('Facriities', 'Facties');
assert(extractFacChg(fullBillGarbled3) === '1381.17', `Full bill garbled3: FacChg = 1381.17 (got ${extractFacChg(fullBillGarbled3)})`);

// ── Group 4: CHG_STOP pattern (Facilities should stop scan for previous charge) ─
console.log('\n--- Group 4: CHG_STOP boundary ---');

const stopText = 'Customer Chg $105.97\nFacriities Chg 210.00 kW $1,381.17';
// When scanning for Customer Chg, the scan should stop at the Facilities line
const custResult = xChg('C[ua][s5][t1iI][o0][mM][eao][r1tT]\\s+' + C, stopText);
assert(custResult === '105.97', `CHG_STOP: Customer charge stops before Facilities (got ${custResult})`);

// ── Group 5: Reconciliation fallback pattern ─────────────────────────────────
console.log('\n--- Group 5: Reconciliation fallback ---');

assert(reconciliationMatch('Facriities Chg 210.00 kW $1,381.17'), 'Reconciliation: "Facriities" should match');
assert(reconciliationMatch('FacHities Chg $1,381.17'), 'Reconciliation: "FacHities" should match');
assert(reconciliationMatch('Facties Chg $1,381.17'), 'Reconciliation: "Facties" should match');
assert(reconciliationMatch('Fac Chg $1,381.17'), 'Reconciliation: "Fac Chg" should match');

// ── Group 6: False positive guard ────────────────────────────────────────────
console.log('\n--- Group 6: False positive guard ---');

// "Factor" or "Fact" should NOT match as Facilities charge
assert(extractFacChg('Factor analysis $500.00') === null, 'No false positive: "Factor analysis"');
assert(extractFacChg('Fact sheet $200.00') === null, 'No false positive: "Fact sheet"');

// =============================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
