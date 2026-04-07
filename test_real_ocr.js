// Test extraction against REAL OCR text from the user's PDF
// Reads the debug file, runs extractAll on each section, reports every bill's issues

const fs = require('fs');
const path = require('path');

// Read the debug file
const debugPath = path.join(process.env.USERPROFILE || '', 'Downloads', 'evergy-debug.txt');
const debugText = fs.readFileSync(debugPath, 'utf8');
const rawMarker = '=== RAW OCR TEXT ===\n';
const rawStart = debugText.indexOf(rawMarker);
if (rawStart < 0) {
  console.error('No RAW OCR TEXT marker found');
  process.exit(1);
}
const rawText = debugText.slice(rawStart + rawMarker.length);

console.log(`Raw OCR text: ${rawText.length} chars, ${rawText.split('\n').length} lines\n`);

// Load _extractEvergy from the test file by running it in a sandbox-like way
// The test file defines _extractEvergy as a function declaration, so we extract and eval it
const testSrc = fs.readFileSync(path.join(__dirname, 'test_evergy_regex.js'), 'utf8');

// Extract everything from constants through end of _extractEvergy (before Test 1 assertions)
const endMarker = '// ─── Test 1:';
const codeEnd = testSrc.indexOf(endMarker);
const startIdx = testSrc.indexOf('const _EVG_BILLING_DETAILS');
const extractionCode = testSrc.slice(startIdx, codeEnd);
eval(extractionCode);

// Split raw text into bill sections using the same logic as extractAll
const _EVG_BD = /B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]{1,2}[s5]?\s*[-\u2013\u2014]\s*[s5]erv[il1]ce\s+from/i;
const _EVG_SF = /[s5]erv[il1]ce\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i;
const splitRe =
  /(?=(?:B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]{1,2}[s5]?\s*[-\u2013\u2014]\s*[s5]erv[il1]ce\s+from|Billing\s+Details\s*[-\u2013\-]\s*service\s+from))/gi;
const raw = rawText.split(splitRe);
const getDP = (s) => {
  const m = s.match(_EVG_SF) || s.match(/service\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i);
  return m ? m[1] + '|' + m[2] : null;
};
const sections = [];
for (const frag of raw) {
  const dates = getDP(frag);
  const isHdr = _EVG_BD.test(frag.trim()) || /^Billing\s+Details/i.test(frag.trim());
  if (!isHdr || !dates) {
    if (sections.length) sections[sections.length - 1] += frag;
    else sections.push(frag);
  } else if (sections.length && getDP(sections[sections.length - 1]) === dates) {
    sections[sections.length - 1] += frag;
  } else {
    sections.push(frag);
  }
}
const validSections = sections.filter((s) => _EVG_SF.test(s) || /service\s+from\s+\d{2}\/\d{2}\/\d{4}/i.test(s));

// Extract account/address from full text
const acct =
  rawText.match(/[Aa]ccount\s+(?:N[ou]mber\s*)?[:\s\u00a9\u00ae]\s*(\d[\d ]{4,18}\d)/m)?.[1]?.replace(/\s/g, '') ||
  null;
const addrM = rawText.match(/^(\d+\s+\w[\w\s,]{3,50}(?:KS|MO))\s*$/m);
const addr = addrM?.[1]?.trim() || null;

console.log(`Split into ${validSections.length} bill sections (acct=${acct}, addr=${addr})\n`);

// Extract each section
const bills = validSections.map((s) => _extractEvergy(s, acct, addr));

// Check each bill for issues
const criticalFields = [
  'CustomerCharge',
  'FacilitiesCharge',
  'BilledKWCharge',
  'EnergyOnPeakCharge',
  'TDCCharge',
  'ECACharge',
  'TotalCurrentCharges',
];

let totalIssues = 0;
for (let i = 0; i < bills.length; i++) {
  const b = bills[i];
  const period = `${b.BillingPeriodStart || '?'} to ${b.BillingPeriodEnd || '?'}`;
  const nullCritical = criticalFields.filter((f) => b[f] === null);

  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const calcSum =
    pf(b.CustomerCharge) +
    pf(b.FacilitiesCharge) +
    pf(b.BilledKWCharge) +
    pf(b.EnergyOnPeakCharge) +
    pf(b.EnergyOffPeakCharge) +
    pf(b.RkVACharge) +
    pf(b.ECACharge) +
    pf(b.EERCharge) +
    pf(b.PTSCharge) +
    pf(b.TDCCharge) +
    pf(b.TaxExemptDelivery) +
    pf(b.BillOffset) +
    pf(b.FranchiseFee);
  const total = pf(b.TotalCurrentCharges);
  const diff = Math.abs(calcSum - total);
  const sumMismatch = total > 0 && diff > 0.1;

  const taxExempt = pf(b.TaxExemptDelivery);
  const billOffset = pf(b.BillOffset);
  const offsetMismatch = taxExempt > 0 && Math.abs(Math.abs(billOffset) - taxExempt) > 0.1;

  const issues = [];
  if (nullCritical.length) issues.push(`NULL critical: ${nullCritical.join(', ')}`);
  if (sumMismatch)
    issues.push(`Sum mismatch: calc=${calcSum.toFixed(2)} vs total=${total.toFixed(2)} (diff=$${diff.toFixed(2)})`);
  if (offsetMismatch) issues.push(`BillOffset(${b.BillOffset}) != -TaxExempt(${b.TaxExemptDelivery})`);

  if (issues.length) {
    totalIssues += issues.length;
    console.log(`Bill ${i + 1}: ${period}`);
    for (const iss of issues) console.log(`  ⚠ ${iss}`);
    console.log(
      `  Cust=${b.CustomerCharge} Fac=${b.FacilitiesCharge} Dem=${b.BilledKWCharge} OnPk=${b.EnergyOnPeakCharge} OffPk=${b.EnergyOffPeakCharge} RkVA=${b.RkVACharge}`,
    );
    console.log(
      `  ECA=${b.ECACharge} EER=${b.EERCharge} PTS=${b.PTSCharge} TDC=${b.TDCCharge} TaxEx=${b.TaxExemptDelivery} Offset=${b.BillOffset} Fran=${b.FranchiseFee} Total=${b.TotalCurrentCharges}`,
    );
    console.log('');
  } else {
    console.log(`Bill ${i + 1}: ${period} — OK (sum=${calcSum.toFixed(2)}, total=${total.toFixed(2)})`);
  }
}

console.log(`\n=== Summary: ${bills.length} bills, ${totalIssues} issues ===`);
