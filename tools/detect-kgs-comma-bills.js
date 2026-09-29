/**
 * detect-kgs-comma-bills.js  (WP-01, math-audit 2026-09-28)  READ-ONLY
 *
 * Lists saved bills that the comma bug may have damaged (audit E-1: a Kansas Gas Service (KGS) total of
 * "$1,234.56" was stored as text with a comma; readers that use parseFloat read it as 1).
 * It never writes to the backup file and never changes any bill. It prints a CSV.
 *
 * Reads a COPY of a CompanyHub backup JSON (the whole localStorage export). Bills live in the keys
 * en_utility_<id> and en_utility_cust_<id>: { buildings: [ { meters: [ { bills: [...] } ] } ] }.
 *
 * A row is listed when a KGS gas bill (or any gas bill) meets one of these tests:
 *   comma_text     a money or usage field holds text with a thousands comma (e.g. "4,271.50")
 *   total_lt_100   KGS only: totalCost reads under $100 (a comma bill of $1,234 reads as 1 under parseFloat)
 *   rate_gt_10     KGS only: total cost / therms is above $10 per therm
 *   reads_as_1_9   parseFloat(totalCost) differs from the comma-safe value (the reader mistake itself)
 * "Stored under $1,000 where the PDF total is $1,000 or more" needs the PDF text. This script cannot
 * see PDFs, so that test stays a manual check on the rows listed here.
 *
 * Usage: node tools/detect-kgs-comma-bills.js <backup-copy.json> [out.csv]
 *   Output goes to out.csv when given, else to the screen. Keep the CSV outside the repo (client data).
 */
const fs = require('fs');
const path = require('path');
const { parseBillNumber } = require('../lib/formatting.js');

const input = process.argv[2];
const out = process.argv[3];
if (!input) {
  console.error('Usage: node tools/detect-kgs-comma-bills.js <backup-copy.json> [out.csv]');
  process.exit(2);
}
const backup = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));

const MONEY_FIELDS = [
  'totalCost',
  'gasCharge',
  'thermCost',
  'customerCharge',
  'fuelAdjustment',
  'franchiseFee',
  'cost',
];
const USAGE_FIELDS = ['therms', 'naturalGasTherms', 'naturalGasCCF', 'naturalGasMMbtu', 'usage'];
const COMMA_TEXT = /^\s*\$?\s*\d{1,3}(,\d{3})+(\.\d+)?\s*$/;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const rows = [];
const seenBills = new Set();

for (const key of Object.keys(backup)) {
  if (!/^en_utility_(cust_)?\w+$/.test(key)) continue;
  let store = backup[key];
  if (typeof store === 'string') {
    try {
      store = JSON.parse(store);
    } catch (e) {
      continue;
    }
  }
  if (!store || !Array.isArray(store.buildings)) continue;
  for (const bldg of store.buildings) {
    for (const meter of bldg.meters || []) {
      for (const bill of meter.bills || []) {
        const commodity = String(bill.commodity || meter.commodity || '').toLowerCase();
        const company = String(bill.utilityCompany || meter.utilityCompany || meter.utility || '');
        const isKgs = /kansas\s+gas/i.test(company);
        if (commodity !== 'gas' && !isKgs) continue;
        const uid = (bill.id || '') + '|' + meter.id;
        if (seenBills.has(uid)) continue; // en_utility_<id> and en_utility_cust_<id> hold the same bills
        seenBills.add(uid);
        const tests = [];
        const commaFields = [];
        for (const f of MONEY_FIELDS.concat(USAGE_FIELDS)) {
          if (typeof bill[f] === 'string' && COMMA_TEXT.test(bill[f])) commaFields.push(f);
        }
        if (commaFields.length) tests.push('comma_text');
        const total = parseBillNumber(bill.totalCost);
        if (isKgs && total !== null && total < 100) tests.push('total_lt_100');
        const therms = parseBillNumber(bill.therms) || parseBillNumber(bill.naturalGasTherms);
        if (isKgs && total !== null && therms !== null && therms > 0 && total / therms > 10) tests.push('rate_gt_10');
        const naive = parseFloat(bill.totalCost);
        if (total !== null && !(Math.abs(naive - total) < 0.005)) tests.push('reads_as_1_9');
        if (!tests.length) continue;
        rows.push([
          bldg.name || '',
          meter.id,
          company,
          bill.start || '',
          bill.end || '',
          bill.totalCost === undefined ? '' : bill.totalCost,
          total === null ? '' : total,
          isNaN(naive) ? '' : naive,
          bill.therms || bill.naturalGasTherms || '',
          commaFields.join(' '),
          tests.join(' '),
          key,
        ]);
      }
    }
  }
}

const header = [
  'building',
  'meter_id',
  'utility',
  'start',
  'end',
  'totalCost_stored_text',
  'totalCost_comma_safe',
  'totalCost_parseFloat',
  'therms',
  'comma_fields',
  'tests',
  'store_key',
];
const csv =
  [header]
    .concat(rows)
    .map((r) => r.map(csvCell).join(','))
    .join('\n') + '\n';
if (out) {
  fs.writeFileSync(path.resolve(out), csv);
  console.log('detect-kgs-comma-bills: ' + rows.length + ' bill(s) listed -> ' + path.resolve(out));
} else {
  process.stdout.write(csv);
}
