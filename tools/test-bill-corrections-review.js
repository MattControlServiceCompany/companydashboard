/**
 * test-bill-corrections-review.js
 *
 * Standalone regression test for the "Review Bill Corrections" per-project,
 * resumable panel (app/bill-corrections-review.js, rebuilt 2026-09-25). The
 * panel recomputes four already-fixed extraction bugs against saved bills,
 * plus reuses the Utility Data page's own statistical flag computation:
 *   1. Kansas Gas Service 100x OCR decimal-drop on TotalCurrentCharges
 *      (app/bill-analysis.js _postExtractionVerify).
 *   2. City of Louisburg new-format Bill Date reading the Penalty Date
 *      instead of the printed Bill Date (app/energy-savings.js
 *      City of Louisburg rule, _extractNew).
 *   3. Evergy RkVA rate OCR digit-misread (app/energy-savings.js
 *      _extractEvergy single-part rate cross-check).
 *   4. City of Louisburg account-number OCR misread.
 *   5. computeLiveBillFlags (extraction/bill-validation.js) — the same
 *      statistical-flag computation as the Utility Data building badge.
 *
 * SYNTHETIC fixtures only — no real client data. Loads the REAL functions
 * (app/bill-corrections-review.js, extraction/bill-validation.js,
 * app/energy-savings.js, app/bill-analysis.js, app/utility-data.js,
 * computations/rates.js) via Node's vm module. core.js/db.js/DOM are NOT
 * loaded — sget/sset/pdfLoad/extractPDFText are minimal in-memory stand-ins
 * (an in-memory store instead of IndexedDB, a page-aware plain-text decode
 * instead of real PDF.js/Tesseract, but one that DOES honor
 * opts.cachedPages/opts.onPageText the same shape the real extractPDFText
 * does) so the REAL scanning, caching, matching, and apply-time re-check
 * logic in bill-corrections-review.js runs unmodified against controlled
 * fixtures.
 *
 * Each fixture project's scan is run through the REAL per-project entry
 * points (_bcrGetOrCreateCtl / _bcrRunProjectScan), exactly the functions
 * openBillCorrectionsReviewModal() calls — never a bypassed "scan
 * everything" helper — so project scoping is exercised for real, not
 * asserted after the fact.
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
    setTimeout: (fn, ms) => setTimeout(fn, ms), // real timers — bcr.js's 60s Promise.race relies on this
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error('fetch not available in test sandbox')),
    performance: { now: () => Date.now() },
    TextEncoder: global.TextEncoder,
    TextDecoder: global.TextDecoder,
    atob: global.atob,
    btoa: global.btoa,
    Uint8Array,
    Promise,
    Date,
  };
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
  // Same load order as energy-department.html: bill-analysis before
  // bill-validation (computeLiveBillFlags/dismissBillFlag) before utility-data.
  for (const p of [
    'computations/rates.js',
    'app/energy-savings.js',
    'app/bill-analysis.js',
    'extraction/bill-validation.js',
    'app/utility-data.js',
  ]) {
    loadFile(sandbox, p);
  }

  // ── in-memory data layer stand-ins (replace core.js's IndexedDB-backed sget/sset) ──
  vm.runInContext(
    `
    var __store = {};
    var __pdfStore = {};
    var __pageReadLog = []; // pushed once per page actually decoded (not served from cachedPages)
    let projects = [];
    function sget(k, fb) { return Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : (fb !== undefined ? fb : null); }
    function sset(k, v) { __store[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }
    async function pdfLoad(id) { return __pdfStore[id] || null; }
    async function pdfStore_(id, b64) { __pdfStore[id] = b64; }
    // Page-aware stand-in: "pages" are separated by %%TESTPAGE%% in the fake
    // stored PDF text. Honors opts.cachedPages (skip a page's own "read") and
    // opts.onPageText (fired per page, real-shape) so bcr.js's own caching/
    // resume logic — not real PDF.js/Tesseract — is what's under test.
    async function extractPDFText(ab, cb, opts) {
      opts = opts || {};
      const bytes = new Uint8Array(ab);
      const fullText = new TextDecoder('utf-8').decode(bytes);
      const pages = fullText.split('%%TESTPAGE%%');
      const pageCount = pages.length;
      const cachedPages = opts.cachedPages || {};
      for (let i = 0; i < pages.length; i++) {
        if (cachedPages[i] != null) {
          if (opts.onPageText) opts.onPageText(i, cachedPages[i], pageCount);
          continue;
        }
        __pageReadLog.push(i);
        if (opts.onPageText) opts.onPageText(i, pages[i], pageCount);
      }
      return pages.map((t, i) => '%%PAGE_' + (i + 1) + '%%\\n' + t).join('\\n');
    }
    function showToast() {}
    function renderMeterWorkspace() {}
    function openBillModal() {}
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
// back to text by the extractPDFText stand-in above.
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

// Runs the REAL per-project scan entry points for one project id and returns
// a FRESH controller object populated by the scan (bypasses the cached
// module-level _bcrControllers map so each call is a clean "cold start" —
// exactly what a real page reload produces, since persisted sget/sset state
// is what's expected to carry the resume information, not any in-memory
// controller object).
async function runProjectScanCold(sandbox, pid) {
  const getOrCreateCtl = vm.runInContext('_bcrGetOrCreateCtl', sandbox);
  const runProjectScan = vm.runInContext('_bcrRunProjectScan', sandbox);
  // Clear this pid's cached in-memory controller so getOrCreateCtl builds a
  // fresh one (simulates the module state being wiped by a page reload).
  vm.runInContext(`delete _bcrControllers[${JSON.stringify(pid)}];`, sandbox);
  const ctl = getOrCreateCtl(pid);
  await runProjectScan(ctl);
  return ctl;
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
    projId: 'p_test_kgs1',
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
  const kgs1Proj = { id: 'p_test_kgs1', customerId: 'cust_test_kgs1', name: 'Test KGS Unmatched Co' };

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

  // ── Case 1b: KGS 100x decimal-drop on a normal SAVED meter.bills row ──
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
  kgsMeter.bills.push(
    {
      id: 'r_test_kgs_2_hist1',
      start: '2025-11-01',
      end: '2025-12-01',
      accountNumber: '510000123 9999999 00',
      utilityCompany: 'Kansas Gas Service',
      commodity: 'Gas',
      totalCost: '33.10',
    },
    {
      id: 'r_test_kgs_2_hist2',
      start: '2025-12-01',
      end: '2026-01-01',
      accountNumber: '510000123 9999999 00',
      utilityCompany: 'Kansas Gas Service',
      commodity: 'Gas',
      totalCost: '36.20',
    },
  );
  const kgsBldg2 = { id: 'b_test_kgs2', name: 'Unmatched Bills', meters: [kgsMeter] };
  const kgsProj2 = { id: 'p_test_kgs2', customerId: 'cust_test_kgs2', name: 'Test Baker University' };
  storePdfText(
    sandbox,
    'pdf_kgs_2',
    'MARKER_KGS2 synthetic Kansas Gas Service bill text (content unused — extractAll is stubbed below)',
  );

  // ── Case 6 fix regression: a KGS bill whose re-extraction UNDER-counts the
  // component sum must NOT be proposed when the meter's own bill history
  // shows the SAVED total is normal for this meter. ──
  const kgsMeterFP = {
    id: 'm_test_kgsfp',
    commodity: 'Gas',
    provider: 'Kansas Gas Service',
    bills: [
      {
        id: 'r_test_kgsfp_hist1',
        start: '2025-11-01',
        end: '2025-12-01',
        accountNumber: '777000001 1111111 00',
        utilityCompany: 'Kansas Gas Service',
        commodity: 'Gas',
        totalCost: '498.00',
      },
      {
        id: 'r_test_kgsfp_hist2',
        start: '2025-12-01',
        end: '2026-01-01',
        accountNumber: '777000001 1111111 00',
        utilityCompany: 'Kansas Gas Service',
        commodity: 'Gas',
        totalCost: '512.00',
      },
      {
        id: 'r_test_kgsfp_target',
        start: '2026-01-01',
        end: '2026-02-01',
        accountNumber: '777000001 1111111 00',
        utilityCompany: 'Kansas Gas Service',
        commodity: 'Gas',
        totalCost: '500.00', // already correct — matches this meter's normal bill size
        pdfKey: 'pdf_kgsfp_target',
      },
    ],
  };
  const kgsBldgFP = { id: 'b_test_kgsfp', name: 'Test False Positive Hall', meters: [kgsMeterFP] };
  const kgsProjFP = { id: 'p_test_kgsfp', customerId: 'cust_test_kgsfp', name: 'Test Baker University FP' };
  storePdfText(sandbox, 'pdf_kgsfp_target', 'MARKER_KGSFP synthetic re-read text');

  vm.runInContext(
    `
    (function () {
      var kgsRule = UTILITY_RULES.find((r) => r.name === 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)');
      kgsRule.extractAll = function (t) {
        if (t && t.indexOf('MARKER_KGSFP') !== -1) {
          return [{
            UtilityCompany: 'Kansas Gas Service',
            Commodity: 'Gas',
            commodity: 'gas',
            AccountNumber: '777000001 1111111 00',
            BillingPeriodStart: '1/1/2026',
            BillingPeriodEnd: '2/1/2026',
            McfBilled: '5.000',
            NaturalGasTherms: '50.00',
            CustomerCharge: '5.00',
            DeliveryCharge: null,
            GasSystemReliability: null,
            WeatherNormalization: null,
            GasCharge: null,
            FranchiseFee: null,
            WinterEventCost: null,
            DelayedPaymentCharge: null,
            TotalCurrentCharges: '500.00',
            TotalAmountDue: '500.00',
          }];
        }
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

  // ── Case 7: Louisburg account-number OCR misread ──
  const louAcctMeter = {
    id: 'm_test_louacct',
    commodity: 'Electric',
    provider: 'City of Louisburg',
    bills: [
      {
        id: 'r_test_louacct_1',
        start: '2025-01-16',
        end: '2025-02-16',
        accountNumber: '1800100',
        utilityCompany: 'City of Louisburg',
        commodity: 'Electric',
        totalCost: '210.00',
      },
      {
        id: 'r_test_louacct_2',
        start: '2025-02-16',
        end: '2025-03-16',
        accountNumber: '1800100',
        utilityCompany: 'City of Louisburg',
        commodity: 'Electric',
        totalCost: '198.00',
      },
      {
        id: 'r_test_louacct_bad',
        start: '2025-04-16',
        end: '2025-05-16',
        accountNumber: '1600100', // OCR misread of 1800100 — the bug
        utilityCompany: 'City of Louisburg',
        commodity: 'Electric',
        totalCost: '205.00',
      },
    ],
  };
  const louAcctBldg = { id: 'b_test_louacct', name: 'Test Rockville Elementary', meters: [louAcctMeter] };
  const louAcctProj = { id: 'p_test_louacct', customerId: 'cust_test_louacct', name: 'Test Louisburg USD 416' };

  // ── Case 8 (new, 2026-09-25): resumed-scan fixture — a 3-"page" synthetic
  // PDF (real content on page 2) for a fresh Louisburg-date bug, its own
  // project so cross-project isolation and resume don't interact. ──
  const louResumeMeter = {
    id: 'm_test_louresume',
    commodity: 'Water',
    provider: 'City of Louisburg',
    bills: [
      {
        id: 'r_test_louresume_1',
        start: '2026-05-01',
        end: '2026-06-01',
        billDate: '6/20/2026', // penalty date — the bug
        accountNumber: '09-888888-88',
        commodity: 'Water',
        totalCost: '45.67',
        pdfKey: 'pdf_louresume_1',
      },
    ],
  };
  const louResumeBldg = { id: 'b_test_louresume', name: 'Test Resume Building', meters: [louResumeMeter] };
  const louResumeProj = { id: 'p_test_louresume', customerId: 'cust_test_louresume', name: 'Test Louisburg Resume Co' };
  const louResumePage2 = louisburgPage('5/1/2026', '6/1/2026', '6/5/2026', '6/20/2026', '6/19/2026', '09-888888-88');
  storePdfText(
    sandbox,
    'pdf_louresume_1',
    'FILLER PAGE ONE — no bill data\n%%TESTPAGE%%\n' +
      louResumePage2 +
      '\n%%TESTPAGE%%\nFILLER PAGE THREE — no bill data',
  );

  seedProjectsAndUtilityData(sandbox, [kgs1Proj, louProj, evgProj, kgsProj2, kgsProjFP, louAcctProj, louResumeProj], {
    cust_test_kgs1: { buildings: [] }, // KGS unmatched bucket has no meter tree — projId on the bill is what scopes it
    cust_test_lou: { buildings: [louBldg] },
    cust_test_evg: { buildings: [evgBldg] },
    cust_test_kgs2: { buildings: [kgsBldg2] },
    cust_test_kgsfp: { buildings: [kgsBldgFP] },
    cust_test_louacct: { buildings: [louAcctBldg] },
    cust_test_louresume: { buildings: [louResumeBldg] },
  });

  // ── Run each fixture project's scan through the REAL per-project entry
  // point, one project at a time — exactly what openBillCorrectionsReviewModal()
  // does for whichever project is open. Results are merged for the existing
  // (still-unique) rowId assertions below. ──
  const allRows = [];
  const allSkipped = [];
  const ctlByPid = {};
  for (const pid of [kgs1Proj.id, louProj.id, evgProj.id, kgsProj2.id, kgsProjFP.id, louAcctProj.id]) {
    const ctl = await runProjectScanCold(sandbox, pid);
    ctlByPid[pid] = ctl;
    allRows.push(...ctl.rows);
    allSkipped.push(...ctl.skipped);
  }
  const rows = allRows;
  const skipped = allSkipped;

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
  if (rows.find((r) => r._rowId === 'evg:r_test_evg_ok1:rkvaRate' || r._rowId === 'evg:r_test_evg_ok2:rkvaRate')) {
    failures++;
    console.error('FAIL Case 3b: a clean Evergy bill (rate already correct) was wrongly flagged');
  } else {
    console.log('PASS Case 3b: clean Evergy bills (rate already correct) left unflagged');
  }

  const kgsfpRow = rows.find((r) => r._rowId === 'kgs:r_test_kgsfp_target:totalCost');
  const kgsfpSkip = skipped.find((s) => s.label && s.label.indexOf('r_test_kgsfp_target') !== -1);
  if (kgsfpRow) {
    failures++;
    console.error(
      "FAIL Case 6: an under-counted re-extraction ($500.00 -> $5.00) was wrongly proposed despite disagreeing with this meter's own $498-$512 bill history",
    );
  } else if (!kgsfpSkip || kgsfpSkip.kind !== 'could-not-check' || !/typical bill amount/.test(kgsfpSkip.reason)) {
    failures++;
    console.error(
      'FAIL Case 6: expected the false-positive KGS bill to be skipped with a "typical bill amount" reason, got ' +
        JSON.stringify(kgsfpSkip),
    );
  } else {
    console.log('PASS Case 6: false-positive KGS re-extraction suppressed by the meter-history plausibility guard');
  }

  const louAcctRow = rows.find((r) => r._rowId === 'louacct:r_test_louacct_bad:accountNumber');
  if (!louAcctRow) {
    failures++;
    console.error('FAIL Case 7: Louisburg account-number OCR misread bill was not flagged');
  } else if (louAcctRow.correctedValue !== '1800100' || louAcctRow.currentValue !== '1600100') {
    failures++;
    console.error(
      'FAIL Case 7: expected 1600100 -> 1800100, got ' + louAcctRow.currentValue + ' -> ' + louAcctRow.correctedValue,
    );
  } else {
    console.log(
      'PASS Case 7: Louisburg account-number OCR misread flagged, corrected ' +
        louAcctRow.currentValue +
        ' -> ' +
        louAcctRow.correctedValue,
    );
  }
  if (
    rows.find(
      (r) =>
        r._rowId === 'louacct:r_test_louacct_1:accountNumber' || r._rowId === 'louacct:r_test_louacct_2:accountNumber',
    )
  ) {
    failures++;
    console.error('FAIL Case 7b: a clean Louisburg account-number bill was wrongly flagged');
  } else {
    console.log('PASS Case 7b: clean Louisburg account-number bills left unflagged');
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

  // ── Case 9 (new, 2026-09-25): cross-project isolation — running Project A's
  // scan must never surface Project B's bills. Re-run each fixture project's
  // scan in isolation (fresh, cold) and confirm only that project's own rows
  // come back. ──
  {
    const louOnly = await runProjectScanCold(sandbox, louProj.id);
    const leaked =
      louOnly.rows.find((r) => r.projId !== louProj.id) || louOnly.flagged.find((r) => r.projId !== louProj.id);
    const hasOwn = louOnly.rows.some((r) => r._rowId === 'lou:r_test_lou_1:billDate');
    if (leaked) {
      failures++;
      console.error(
        'FAIL Case 9: scanning Test Louisburg District leaked a row from another project: ' + JSON.stringify(leaked),
      );
    } else if (!hasOwn) {
      failures++;
      console.error('FAIL Case 9: scanning Test Louisburg District did not find its own bill');
    } else {
      console.log("PASS Case 9: cross-project isolation — scanning one project never surfaces another project's bills");
    }
  }

  // ── Case 10 (new, 2026-09-25): resumed scan does not re-read a cached page.
  // First cold scan of the 3-page Louisburg-resume PDF reads all 3 pages and
  // finds the correction; a second cold scan (simulating a reload — fresh
  // controller, same persisted store) must read ZERO pages (served entirely
  // from the persisted bcr_pdftext_ cache) and still surface the same row. ──
  {
    vm.runInContext('__pageReadLog.length = 0;', sandbox);
    const firstScan = await runProjectScanCold(sandbox, louResumeProj.id);
    const firstReadCount = vm.runInContext('__pageReadLog.length', sandbox);
    const firstRow = firstScan.rows.find((r) => r._rowId === 'lou:r_test_louresume_1:billDate');
    if (!firstRow) {
      failures++;
      console.error(
        'FAIL Case 10 setup: resume fixture bill was not flagged on the first scan. Skipped: ' +
          JSON.stringify(firstScan.skipped),
      );
    } else if (firstReadCount !== 3) {
      failures++;
      console.error('FAIL Case 10 setup: expected the first scan to read all 3 pages, read ' + firstReadCount);
    } else {
      console.log('PASS Case 10 setup: first scan read all 3 pages of the resume fixture and found the correction');
    }
    vm.runInContext('__pageReadLog.length = 0;', sandbox);
    const secondScan = await runProjectScanCold(sandbox, louResumeProj.id);
    const secondReadCount = vm.runInContext('__pageReadLog.length', sandbox);
    const secondRow = secondScan.rows.find((r) => r._rowId === 'lou:r_test_louresume_1:billDate');
    if (secondReadCount !== 0) {
      failures++;
      console.error(
        'FAIL Case 10: resumed (second) scan re-read ' +
          secondReadCount +
          ' page(s) instead of serving them from cache',
      );
    } else if (!secondRow) {
      failures++;
      console.error('FAIL Case 10: resumed (second) scan did not reproduce the same correction from cache');
    } else {
      console.log(
        'PASS Case 10: resumed scan served all 3 pages from the persisted cache — zero pages re-read — and reproduced the same correction',
      );
    }
  }

  // ── Case 11 (new, 2026-09-25): dismiss persists across a simulated reopen. ──
  {
    const firstScan = await runProjectScanCold(sandbox, evgProj.id);
    const evgRowToDismiss = firstScan.rows.find((r) => r._rowId === 'evg:r_test_evg_bad:rkvaRate');
    if (!evgRowToDismiss) {
      failures++;
      console.error('FAIL Case 11 setup: Evergy row to dismiss was not found');
    } else {
      // Attach this controller object directly (no JSON round-trip needed — vm
      // contexts share the Node heap, so a Node-side reference to an
      // in-context object works as an argument to another in-context call).
      const attachCtl = vm.runInContext(
        '(function(pid, ctl) { _bcrControllers[pid] = ctl; _bcrOpenProjId = pid; })',
        sandbox,
      );
      attachCtl(evgProj.id, firstScan);
      const dismissFn = vm.runInContext('_bcrDismissCorrectionRow', sandbox);
      await dismissFn(evgRowToDismiss._rowId);
      const reopened = await runProjectScanCold(sandbox, evgProj.id);
      const stillThere = reopened.rows.find((r) => r._rowId === 'evg:r_test_evg_bad:rkvaRate');
      if (stillThere) {
        failures++;
        console.error('FAIL Case 11: dismissed correction reappeared after a simulated reopen');
      } else {
        console.log('PASS Case 11: dismissed correction did not reappear after a simulated reopen — dismiss persisted');
      }
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
