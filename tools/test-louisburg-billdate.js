/**
 * test-louisburg-billdate.js
 *
 * Standalone regression test for backlog 9b6ff356 — the City of Louisburg
 * "new format" bill reader (app/energy-savings.js, City of Louisburg rule,
 * _extractNew) read the Penalty Date instead of the printed Bill Date on
 * every new-format bill (11/11 confirmed in the 2026-08-05 Track A
 * verification).
 *
 * The period row prints 5 dates in order:
 *   [BillingPeriodStart, BillingPeriodEnd, BillDate, PenaltyDate, DueDate]
 * confirmed against the printed values in the real fixture
 * AI/_context/reference/ocr-harness/fixtures/louisburg-gas-feb2026-hs-raw.txt
 * ("1/14/2026 2/18/2026 2/23/2026 3/11/2026 3/10/2026" against that
 * fixture's printed BillDate 2/23/2026 / PenaltyDate 3/11/2026). The buggy
 * code read dates[3] (Penalty Date) first instead of dates[2] (Bill Date).
 *
 * SYNTHETIC fixture only — a fabricated "City of Louisburg" new-format
 * bill page built from the same structural markers the real _extractNew
 * parser keys off (Customer Account Information header, "USD <district>
 * <name> <address> <account>" row, the 5-date period row, a Previous/
 * Current/Usage meter-read row), with a fake district number, fake
 * building name/address/account number, and fake dollar amounts — no
 * real client identifiers or bill data.
 *
 * Loads the REAL "City of Louisburg" rule from UTILITY_RULES in
 * app/energy-savings.js via Node's vm module (same source, same code path
 * as production, not a reimplementation).
 *
 * Usage: node tools/test-louisburg-billdate.js [path-to-energy-savings.js]
 *   (defaults to ../app/energy-savings.js relative to this file — pass the
 *   path to a PRE-FIX copy to confirm this test fails on the old code)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadLouisburgRule(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  if (!rules) throw new Error('UTILITY_RULES not found in ' + scriptPath);
  const rule = rules.find((r) => r.name === 'City of Louisburg');
  if (!rule) throw new Error('City of Louisburg rule not found in ' + scriptPath);
  return rule;
}

// Builds a synthetic new-format Louisburg bill page. Only `billDate`,
// `penaltyDate`, and `dueDate` vary between test cases below — everything
// else (fake district/name/address/account/amounts) stays fixed.
function makeSyntheticPage(startDate, endDate, billDate, penaltyDate, dueDate) {
  return (
    `%%PAGE_1%%\n` +
    `City of Louisburg Utility Bill\n` +
    `215 S. Broadway 09-999999-99\n` +
    `Louisburg, KS 66053 Total Amount Due\n` +
    `Customer Service ${billDate} $45.67\n` +
    `louisburgkansas.gov Amount Due After ${dueDate} $47.67\n` +
    `Scan to pay\n` +
    `There will be a charge on all returned checks.\n` +
    `Please return this portion with your payment.\n` +
    `City of Louisburg\n` +
    `Customer Account Information - Retain for your records\n` +
    `USD 999 TEST BUILDING NAME 100 TEST ST 09-999999-99\n` +
    `${startDate} ${endDate} ${billDate} ${penaltyDate} ${dueDate}\n` +
    `100- Water Utility Bill Previous Balance: $45.00\n` +
    `Payments: ($45.00)\n` +
    `Adjustments: $0.00\n` +
    `Penalty: $0.00\n` +
    `Previous Current\n` +
    `Reading Reading Usage\n` +
    `1000 1100 100 WATER 45.67\n` +
    `Current Bill $45.67\n` +
    `Total Amount Due $45.67\n`
  );
}

function main() {
  const rule = loadLouisburgRule(jsPath);
  let failures = 0;

  // Two independent synthetic cases (different fake dates each time) so a
  // hardcoded-return false-pass can't hide — the fix must derive BillDate
  // from the row's position, not memorize one value.
  const cases = [
    { start: '3/1/2026', end: '4/1/2026', bill: '4/5/2026', penalty: '4/20/2026', due: '4/19/2026' },
    { start: '6/2/2026', end: '7/3/2026', bill: '7/8/2026', penalty: '7/24/2026', due: '7/23/2026' },
  ];

  for (const c of cases) {
    const page = makeSyntheticPage(c.start, c.end, c.bill, c.penalty, c.due);
    if (!rule.detect(page)) {
      failures++;
      console.error('FAIL: synthetic page not detected as City of Louisburg new-format');
      continue;
    }
    const result = rule.extract(page);
    const bill = Array.isArray(result) ? result[0] : result;
    if (!bill) {
      failures++;
      console.error('FAIL: extract() returned nothing for synthetic page (bill=' + c.bill + ')');
      continue;
    }
    if (bill.BillDate !== c.bill) {
      failures++;
      console.error(
        'FAIL: BillDate expected ' +
          c.bill +
          ' (printed Bill Date), got ' +
          bill.BillDate +
          (bill.BillDate === c.penalty ? ' (this is the Penalty Date — the reported bug)' : ''),
      );
    } else {
      console.log('PASS: BillDate correctly read as ' + bill.BillDate + ' (not Penalty Date ' + c.penalty + ')');
    }
    if (bill.BillingPeriodStart !== c.start || bill.BillingPeriodEnd !== c.end) {
      failures++;
      console.error(
        'FAIL: BillingPeriodStart/End regressed — expected ' +
          c.start +
          '/' +
          c.end +
          ', got ' +
          bill.BillingPeriodStart +
          '/' +
          bill.BillingPeriodEnd,
      );
    } else {
      console.log(
        'PASS: BillingPeriodStart/End unaffected (' + bill.BillingPeriodStart + ' / ' + bill.BillingPeriodEnd + ')',
      );
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s) — energy-savings.js under test: ' + jsPath);
    process.exit(1);
  } else {
    console.log('All Louisburg BillDate tests passed — energy-savings.js under test: ' + jsPath);
  }
}

main();
