/**
 * test-bill-corrections-review.js
 *
 * Standalone regression test for the "Review Bill Corrections" one-time
 * panel (app/bill-corrections-review.js, 2026-09-24). The panel recomputes
 * three already-fixed extraction bugs against saved bills:
 *   1. Kansas Gas Service 100x OCR decimal-drop on TotalCurrentCharges
 *      (app/bill-analysis.js _postExtractionVerify).
 *   2. City of Louisburg new-format Bill Date reading the Penalty Date
 *      instead of the printed Bill Date (app/energy-savings.js
 *      City of Louisburg rule, _extractNew).
 *   3. Evergy RkVA rate OCR digit-misread (app/energy-savings.js
 *      _extractEvergy single-part rate cross-check).
 *
 * SYNTHETIC fixtures only — no real client data. Loads the REAL functions
 * (app/bill-corrections-review.js, app/energy-savings.js, app/bill-analysis.js,
 * app/utility-data.js, computations/rates.js) via Node's vm module, same as
 * tools/test-kgs-total-decimal-drop.js / tools/test-louisburg-billdate.js /
 * tools/test-rkva-rate-reconciliation.js. core.js/db.js/DOM are NOT loaded —
 * sget/sset/pdfLoad/extractPDFText are minimal in-memory stand-ins (an
 * in-memory store instead of IndexedDB/localStorage, a plain string-decode
 * instead of real PDF.js/Tesseract) so the REAL scanning, matching, and
 * apply-time re-check logic in bill-corrections-review.js runs unmodified
 * against controlled fixtures.
 *
 * Cases:
 *   1. Fabricated KGS bill with a 100x decimal-drop total — must be flagged.
 *   2. Fabricated Louisburg new-format bill whose stored billDate is the
 *      Penalty Date — must be flagged, corrected value = printed Bill Date.
 *   3. Fabricated Evergy bill with an OCR-misread RkVA rate (0.883 vs the
 *      meter's dominant 0.663) — must be flagged.
 *   4. Apply-time re-check: a row whose snapshot no longer matches the live
 *      stored value must be skipped with "value changed since review was
 *      opened", never applied.
 *
 * Usage: node tools/test-bill-corrections-review.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function buildSandbox() {
  const sandbox = {
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} },
    document: {
      getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      querySelectorAll: () => [],
    },
    console,
    navigator: { userAgent: 'node' },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error('fetch not available in test sandbox')),
    performance: { now: () => Date.now() },
    TextEncoder: global.TextEncoder,
    TextDecoder: global.TextDecoder,
    atob: global.atob,
    btoa: global.btoa,
    Uint8Array,
  };
  // Minimal stateful localStorage so sget/sset (if any real code path uses it)
  // don't crash — not actually exercised since we define our own sget/sset below.
  const lsStore = {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null),
    setItem: (k, v) => {
      lsStore[k] = v;
    },
    removeItem: (k) => delete lsStore[k],
  };
  vm.createContext(sandbox);
  return sandbox;
}

function loadFile(sandbox, relPath) {
  const full = path.join(__dirname, '..', relPath);
  const src = fs.readFileSync(full, 'utf8');
  vm.runInContext(src, sandbox, { filename: path.basename(relPath) });
}

function setup() {
  const sandbox = buildSandbox();
  for (const p of ['computations/rates.js', 'app/energy-savings.js', 'app/bill-analysis.js', 'app/utility-data.js']) {
    loadFile(sandbox, p);
  }
  // forEachCustomerBuilding's stub in the KGS-only test elsewhere is a no-op —
  // here we need the REAL implementation (already loaded from utility-data.js
  // above) since matching bills to projects/buildings/meters is exactly what
  // this test exercises.

  // ── in-memory data layer stand-ins (replace core.js's IndexedDB-backed sget/sset) ──
  const store = {};
  const pdfStore = {};
  vm.runInContext(
    `
    var __store = {};
    var __pdfStore = {};
    let projects = [];
    function sget(k, fb) { return Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : (fb !== undefined ? fb : null); }
    function sset(k, v) { __store[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }
    async function pdfLoad(id) { return __pdfStore[id] || null; }
    async function pdfStore_(id, b64) { __pdfStore[id] = b64; }
    async function extractPDFText(ab, cb) {
      const bytes = new Uint8Array(ab);
      return new TextDecoder('utf-8').decode(bytes);
    }
    function showToast() {}
    function renderMeterWorkspace() {}
    var _testAuditLog = [];
    var _origLogUtilityAudit = logUtilityAudit;
    logUtilityAudit = function(entry) { _testAuditLog.push(entry); _origLogUtilityAudit(entry); };
  `,
    sandbox,
  );
  loadFile(sandbox, 'app/bill-corrections-review.js');
  return sandbox;
}

// Helper: store a synthetic "PDF" — really just base64 of plain text, decoded
// back to text by the extractPDFText stand-in above (round-trips real UTF-8
// text exactly; no real PDF.js/Tesseract involved, matching this test's own
// documented scope).
function storePdfText(sandbox, key, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  vm.runInContext(`__pdfStore[${JSON.stringify(key)}] = ${JSON.stringify(b64)};`, sandbox);
}

function seedProjectsAndUtilityData(sandbox, projectsArr, utilityDataObj) {
  vm.runInContext(
    `
    projects = ${JSON.stringify(projectsArr)};
    utilityData = ${JSON.stringify(utilityDataObj)};
    __store['en_projects'] = ${JSON.stringify(projectsArr)};
  `,
    sandbox,
  );
}

// ── Louisburg synthetic new-format bill page (same structural markers as
// tools/test-louisburg-billdate.js's makeSyntheticPage) ──
function louisburgPage(startDate, endDate, billDate, penaltyDate, dueDate, account) {
  return (
    `%%PAGE_1%%\n` +
    `City of Louisburg Utility Bill\n` +
    `215 S. Broadway ${account}\n` +
    `Louisburg, KS 66053 Total Amount Due\n` +
    `Customer Service ${billDate} $45.67\n` +
    `louisburgkansas.gov Amount Due After ${dueDate} $47.67\n` +
    `Scan to pay\n` +
    `There will be a charge on all returned checks.\n` +
    `Please return this portion with your payment.\n` +
    `City of Louisburg\n` +
    `Customer Account Information - Retain for your records\n` +
    `USD 999 TEST BUILDING NAME 100 TEST ST ${account}\n` +
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

// ── Evergy synthetic bill text (same structural markers as
// tools/test-rkva-rate-reconciliation.js's makeSyntheticBill) ──
function evergyBillText(account, start, end, rkvaQty, rkvaRate, rkvaCharge) {
  return (
    `Billing Details - service from ${start} to ${end}\n` +
    `Account Number ${account}\n` +
    `999 TEST ST, TESTVILLE, KS 66000\n` +
    `Customer Chg $25.00\n` +
    `Facilities Chg 12.0000 kW at $8.500 per kW $102.00\n` +
    `Demand Chg 12.0000 kW at $9.250 per kW $111.00\n` +
    `Energy On Pk Chg 4,000.0000 kWh at $0.06000 per kWh $240.00\n` +
    `TDC Chg 12.0000 kW at $3.100 per kW $37.20\n` +
    `RkVA Chg ${rkvaQty.toFixed(4)} kW at $${rkvaRate.toFixed(3)} per kW $${rkvaCharge.toFixed(2)}\n` +
    `Current Charges $515.20\n`
  );
}

async function main() {
  let failures = 0;
  const sandbox = setup();

  // ── Case 1: KGS 100x decimal-drop in en_pdf_bills (Unmatched Bills) ──
  const kgsBill = {
    id: 'r_test_kgs_1',
    UtilityCompany: 'Kansas Gas Service',
    Commodity: 'Gas',
    commodity: 'gas',
    _utilityName: 'Kansas Gas Service',
    AccountNumber: '510000123 9999999 00',
    projName: 'Test University',
    McfBilled: '0.500',
    NaturalGasTherms: '5.00',
    CustomerCharge: '20.35',
    DeliveryCharge: '10.29',
    GasCharge: '4.00',
    TotalCurrentCharges: '3464.00',
    TotalAmountDue: '3464.00',
  };
  vm.runInContext(`__store['en_pdf_bills'] = ${JSON.stringify([kgsBill])};`, sandbox);

  // ── Case 2: Louisburg penalty-date bug ──
  const louMeter = {
    id: 'm_test_lou',
    commodity: 'Water',
    provider: 'City of Louisburg',
    account: '09-999999-99',
    meter: '1',
    bills: [
      {
        id: 'r_test_lou_1',
        start: '2026-03-01',
        end: '2026-04-01',
        billDate: '4/20/2026', // this is the PENALTY date — the bug
        accountNumber: '09-999999-99',
        commodity: 'Water',
        totalCost: '45.67',
        pdfKey: 'pdf_lou_1',
      },
    ],
  };
  const louBldg = { id: 'b_test_lou', name: 'Test Building', meters: [louMeter] };
  const louProj = { id: 'p_test_lou', customerId: 'cust_test_lou', name: 'Test Louisburg District' };
  storePdfText(
    sandbox,
    'pdf_lou_1',
    louisburgPage('3/1/2026', '4/1/2026', '4/5/2026', '4/20/2026', '4/19/2026', '09-999999-99'),
  );

  // ── Case 3: Evergy RkVA rate misread ── (3 bills on one meter: 2 correct, 1 misread)
  const evgMeter = {
    id: 'm_test_evg',
    commodity: 'Electric',
    provider: 'Evergy',
    account: '9999999999',
    meter: '1',
    bills: [
      {
        id: 'r_test_evg_ok1',
        start: '2026-05-14',
        end: '2026-06-13',
        billDate: '6/20/2026',
        accountNumber: '9999999999',
        commodity: 'Electric',
        rkvaCharge: '11.79',
        rkvaRate: '0.663',
        pdfKey: 'pdf_evg_ok1',
      },
      {
        id: 'r_test_evg_ok2',
        start: '2026-06-14',
        end: '2026-07-13',
        billDate: '7/20/2026',
        accountNumber: '9999999999',
        commodity: 'Electric',
        rkvaCharge: '11.79',
        rkvaRate: '0.663',
        pdfKey: 'pdf_evg_ok2',
      },
      {
        id: 'r_test_evg_bad',
        start: '2026-07-14',
        end: '2026-08-13',
        billDate: '8/20/2026',
        accountNumber: '9999999999',
        commodity: 'Electric',
        rkvaCharge: '11.79',
        rkvaRate: '0.883', // OCR digit misread (6 -> 8) — the bug
        pdfKey: 'pdf_evg_bad',
      },
    ],
  };
  const evgBldg = { id: 'b_test_evg', name: 'Test Rockville', meters: [evgMeter] };
  const evgProj = { id: 'p_test_evg', customerId: 'cust_test_evg', name: 'Test Louisburg Electric' };
  storePdfText(sandbox, 'pdf_evg_bad', evergyBillText('9999999999', '07/14/2026', '08/13/2026', 17.784, 0.883, 11.79));

  // ── Case 1b: KGS 100x decimal-drop on a normal SAVED meter.bills row (the
  // "Unmatched Bills" sentinel building shape real Baker University bills use —
  // mirrors the real saved-row field whitelist: lowercase names, no
  // DeliveryCharge/GasSystemReliability/etc.) ──
  const kgsMeter = {
    id: 'm_test_kgs2',
    commodity: 'Gas',
    provider: 'Kansas Gas Service',
    bills: [
      {
        id: 'r_test_kgs_2',
        start: '2026-01-01',
        end: '2026-02-01',
        billDate: '2/5/2026',
        accountNumber: '510000123 9999999 00',
        utilityCompany: 'Kansas Gas Service',
        commodity: 'Gas',
        customerCharge: '20.35',
        gasCharge: '4.00',
        franchiseFee: '10.29',
        naturalGasTherms: '5.00',
        totalCost: '3464.00', // true total is 34.64 — 100x decimal drop
        pdfKey: 'pdf_kgs_2',
      },
    ],
  };
  const kgsBldg2 = { id: 'b_test_kgs2', name: 'Unmatched Bills', meters: [kgsMeter] };
  const kgsProj2 = { id: 'p_test_kgs2', customerId: 'cust_test_kgs2', name: 'Test Baker University' };
  storePdfText(
    sandbox,
    'pdf_kgs_2',
    'synthetic Kansas Gas Service bill text (content unused — extractAll is stubbed below)',
  );
  // _bcrScanKGSMeterBills re-extracts the bill's stored PDF with the real "Gas
  // Utility" rule's extractAll(). Building a fully realistic KGS OCR page is out
  // of scope for this test (that parsing logic is pre-existing, unchanged code) —
  // instead, stub ONLY extractAll to return a fixed, full extractor-shaped bill
  // (every field a real KGS extraction would produce, including the components
  // that do NOT survive onto a saved meter.bills row). The real, unmodified
  // _postExtractionVerify still runs on this object — that is the function this
  // fix touches, and it is never stubbed.
  vm.runInContext(
    `
    (function () {
      var kgsRule = UTILITY_RULES.find((r) => r.name === 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)');
      kgsRule.extractAll = function () {
        return [{
          UtilityCompany: 'Kansas Gas Service',
          Commodity: 'Gas',
          commodity: 'gas',
          AccountNumber: '510000123 9999999 00',
          BillingPeriodStart: '1/1/2026',
          BillingPeriodEnd: '2/1/2026',
          McfBilled: '0.500',
          NaturalGasTherms: '5.00',
          CustomerCharge: '20.35',
          DeliveryCharge: '10.29',
          GasSystemReliability: null,
          WeatherNormalization: null,
          GasCharge: '4.00',
          FranchiseFee: null,
          WinterEventCost: null,
          DelayedPaymentCharge: null,
          TotalCurrentCharges: '3464.00',
          TotalAmountDue: '3464.00',
        }];
      };
    })();
  `,
    sandbox,
  );

  seedProjectsAndUtilityData(sandbox, [louProj, evgProj, kgsProj2], {
    cust_test_lou: { buildings: [louBldg] },
    cust_test_evg: { buildings: [evgBldg] },
    cust_test_kgs2: { buildings: [kgsBldg2] },
  });

  const scanAll = vm.runInContext('_bcrScanAll', sandbox);
  const { rows, skipped } = await scanAll();

  const kgsRow = rows.find((r) => r._rowId === 'kgs:r_test_kgs_1:TotalCurrentCharges');
  if (!kgsRow) {
    failures++;
    console.error('FAIL Case 1: KGS 100x bill was not flagged');
  } else if (Math.abs(parseFloat(kgsRow.correctedValue) - 34.64) > 0.01) {
    failures++;
    console.error('FAIL Case 1: KGS corrected value expected ~34.64, got ' + kgsRow.correctedValue);
  } else {
    console.log(
      'PASS Case 1: KGS 100x bill flagged, corrected ' + kgsRow.currentValue + ' -> ' + kgsRow.correctedValue,
    );
  }

  const kgsRow2 = rows.find((r) => r._rowId === 'kgs:r_test_kgs_2:totalCost');
  if (!kgsRow2) {
    failures++;
    console.error('FAIL Case 1b: KGS 100x bill on a saved meter.bills row was not flagged');
  } else if (Math.abs(parseFloat(kgsRow2.correctedValue) - 34.64) > 0.01) {
    failures++;
    console.error('FAIL Case 1b: KGS meter-bill corrected value expected ~34.64, got ' + kgsRow2.correctedValue);
  } else {
    console.log(
      'PASS Case 1b: KGS 100x bill on a saved meter.bills row flagged, corrected ' +
        kgsRow2.currentValue +
        ' -> ' +
        kgsRow2.correctedValue,
    );
  }

  const louRow = rows.find((r) => r._rowId === 'lou:r_test_lou_1:billDate');
  if (!louRow) {
    failures++;
    console.error('FAIL Case 2: Louisburg penalty-date bill was not flagged. Skipped: ' + JSON.stringify(skipped));
  } else if (louRow.correctedValue !== '4/5/2026') {
    failures++;
    console.error(
      'FAIL Case 2: Louisburg corrected billDate expected 4/5/2026 (the Bill Date), got ' + louRow.correctedValue,
    );
  } else {
    console.log(
      'PASS Case 2: Louisburg bill flagged, corrected ' + louRow.currentValue + ' -> ' + louRow.correctedValue,
    );
  }

  const evgRow = rows.find((r) => r._rowId === 'evg:r_test_evg_bad:rkvaRate');
  if (!evgRow) {
    failures++;
    console.error('FAIL Case 3: Evergy RkVA misread bill was not flagged. Skipped: ' + JSON.stringify(skipped));
  } else if (Math.abs(parseFloat(evgRow.correctedValue) - 0.663) > 0.001) {
    failures++;
    console.error('FAIL Case 3: Evergy corrected rate expected ~0.663, got ' + evgRow.correctedValue);
  } else {
    console.log(
      'PASS Case 3: Evergy RkVA bill flagged, corrected ' + evgRow.currentValue + ' -> ' + evgRow.correctedValue,
    );
  }
  // The two clean Evergy bills must NOT be flagged (no false positives).
  if (rows.find((r) => r._rowId === 'evg:r_test_evg_ok1:rkvaRate' || r._rowId === 'evg:r_test_evg_ok2:rkvaRate')) {
    failures++;
    console.error('FAIL Case 3b: a clean Evergy bill (rate already correct) was wrongly flagged');
  } else {
    console.log('PASS Case 3b: clean Evergy bills (rate already correct) left unflagged');
  }

  // ── Case 4: apply-time re-check — stale snapshot must be skipped, never applied ──
  const applyRow = vm.runInContext('_bcrApplyRow', sandbox);
  const staleRow = {
    store: 'en_pdf_bills',
    billId: 'r_test_kgs_1',
    fieldKey: 'TotalCurrentCharges',
    currentValue: '999999.99', // deliberately wrong snapshot — live value is '3464.00'
    correctedValue: '34.64',
    reason: 'test',
  };
  const applyResult = await applyRow(staleRow);
  const liveAfter = vm.runInContext("__store['en_pdf_bills'][0].TotalCurrentCharges", sandbox);
  if (applyResult.ok !== false || applyResult.reason !== 'value changed since review was opened') {
    failures++;
    console.error(
      'FAIL Case 4: stale-snapshot apply should have been skipped with "value changed since review was opened", got ' +
        JSON.stringify(applyResult),
    );
  } else if (liveAfter !== '3464.00') {
    failures++;
    console.error('FAIL Case 4: stale-snapshot apply mutated the live bill anyway — TotalCurrentCharges=' + liveAfter);
  } else {
    console.log('PASS Case 4: stale-snapshot row skipped at apply time, live bill left untouched');
  }

  // ── Case 5: a real (non-stale) apply DOES go through and logs an audit entry ──
  if (kgsRow) {
    const realResult = await applyRow(kgsRow);
    const liveAfter2 = vm.runInContext("__store['en_pdf_bills'][0].TotalCurrentCharges", sandbox);
    const auditLog = vm.runInContext('_testAuditLog', sandbox);
    if (!realResult.ok) {
      failures++;
      console.error('FAIL Case 5: valid KGS row failed to apply: ' + JSON.stringify(realResult));
    } else if (liveAfter2 !== kgsRow.correctedValue) {
      failures++;
      console.error(
        'FAIL Case 5: applied value not persisted — expected ' + kgsRow.correctedValue + ', got ' + liveAfter2,
      );
    } else if (!auditLog.length || auditLog[0].source !== 'bill_corrections_review') {
      failures++;
      console.error('FAIL Case 5: no audit log entry recorded for the applied correction');
    } else {
      console.log('PASS Case 5: valid row applied through the normal save path and audit-logged');
    }
    // Second apply of the same (now-stale) row must be a no-op skip.
    const secondResult = await applyRow(kgsRow);
    if (secondResult.ok !== false) {
      failures++;
      console.error(
        'FAIL Case 5b: re-applying an already-applied row should skip (live value no longer matches), got ' +
          JSON.stringify(secondResult),
      );
    } else {
      console.log('PASS Case 5b: re-applying an already-applied row is a no-op');
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s)');
    process.exit(1);
  } else {
    console.log('All bill-corrections-review tests passed');
  }
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
