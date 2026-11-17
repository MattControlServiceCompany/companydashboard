// test-bill-save-once-dom.js
// Acceptance test (2026-11-17, "same billing period 27 times"): saving ONE extracted bill with the Save
// button must put the bill on the matching meter and leave exactly ONE en_pdf_bills record, however many
// times Save is pressed; a failed save must show a toast, keep no hidden duplicate, and the Save button
// must be usable again. 100% SYNTHETIC data. Real app code, headless bundled Chromium, unique profile.
// Run: CH_TMP_ROOT=<scratch dir> node test-bill-save-once-dom.js   (from the repo root)
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PID = 999000333;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

function seed(extraPdfBills) {
  return {
    en_projects: [
      {
        id: PID,
        name: 'SYNTH PROJECT',
        client: 'Synth',
        customerId: CID,
        status: 'active',
        scope: { buildingIds: ['bSyn1'], meterExcludeIds: [] },
        savingsData: { measures: [] },
      },
    ],
    en_customers: [{ id: CID, name: 'Synth Customer' }],
    ['en_utility_' + CID]: {
      buildings: [
        {
          id: 'bSyn1',
          name: 'Synth Hall',
          addr: '1 Test St',
          meters: [
            {
              id: 'mElec1',
              commodity: 'Electric',
              provider: 'SynElectric',
              account: '1000200030',
              bills: [{ id: 'rOld', start: '2026-08-06', end: '2026-09-05', kwh: 1000, totalCost: 100 }],
            },
          ],
        },
      ],
    },
    en_pdf_bills: extraPdfBills || [],
    ch_settings: { showQuickStart: false },
    ch_theme: 'dark',
    ch_activeView: 'projects',
    ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
  };
}

// One page per scenario, so a scenario never sees another one's data.
async function scenario(_unused, seedData, fn) {
  // A fresh browser profile per scenario: the site keeps a warm copy of its data in the profile.
  const context = await launchBrowser('bill-save-once', { viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((d) => {
    if (window.sessionStorage.getItem('seeded')) return;
    window.sessionStorage.setItem('seeded', '1');
    for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
  }, seedData);
  await page.goto(SITE);
  await page.waitForTimeout(2500);
  try {
    return await page.evaluate(fn);
  } finally {
    await context.close();
  }
}

const COMMON = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkBill = (over) => Object.assign({
    UtilityCompany: 'SynElectric', Commodity: 'Electric', AccountNumber: '1000200030',
    BillingPeriodStart: '10/06/2026', BillingPeriodEnd: '11/04/2026',
    kWhConsumed: '58543.7120', TotalCurrentCharges: '6205.24', BilledKWCharge: '1000.00',
    ElectricCharge: '5000.00', FranchiseFee: '205.24', _pageStart: 1, _pageEnd: 1 }, over || {});
  const toasts = [];
  const origToast = window.showToast;
  window.showToast = (m, t) => { toasts.push(String(m)); };
  const setup = (bill) => {
    loadUtilityData();
    const sel = document.getElementById('pdfProjSel');
    sel.innerHTML = '<option value="' + pid + '">p</option>';
    sel.value = String(pid);
    window._pdfMultiBills = [bill];
    window._pdfMultiIdx = 0;
    const host = document.createElement('div');
    host.innerHTML = _pdfSaveControl('single').html;
    document.body.appendChild(host);
    return host.querySelector('button');
  };
  const meterRows = () => getUDMeter(pid, 'bSyn1', 'mElec1').bills.filter((r) => r.start === '2026-10-06');
  const recs = () => (sget('en_pdf_bills', []) || []);
`;

(async () => {
  const context = null;
  try {
    // 1. One Save: the bill lands on the matching meter, one record, record assigned (projId set).
    let r = await scenario(
      context,
      seed(),
      `(async () => { const pid = ${PID}; ${COMMON}
        const bill = mkBill(); const btn = setup(bill);
        btn.click();
        const disabledDuring = btn.disabled;
        await wait(1500);
        return { disabledDuring, disabledAfter: btn.disabled, rows: meterRows(), recs: recs(), toasts, stamp: bill._savedPdfBillId };
      })()`,
    );
    eq(r.disabledDuring, true, '1: Save button disabled while the save runs');
    eq(r.disabledAfter, false, '1: Save button enabled again after the save');
    eq(r.rows.length, 1, '1: bill is on the matching meter once');
    eq(r.rows[0] && r.rows[0].totalCost, 6205.24, '1: meter row total');
    eq(r.rows[0] && r.rows[0].kwh, 58543.712, '1: meter row kWh');
    eq(r.recs.length, 1, '1: one en_pdf_bills record');
    eq(r.recs[0] && r.recs[0].projId, PID, '1: record is marked assigned (projId)');
    eq(r.rows[0] && r.recs[0] && r.rows[0].pdfBillId, r.recs[0].id, '1: meter row points at the record');
    eq(r.stamp, r.recs[0] && r.recs[0].id, '1: extracted bill stamped with the record id');
    ok(r.recs[0] && !('_savedPdfBillId' in r.recs[0]) && !('_pdfBillsRecordId' in r.recs[0]), '1: stamps are not stored in the record');
    ok(r.toasts.some((t) => /Saved to SYNTH PROJECT/.test(t)), '1: success toast ' + JSON.stringify(r.toasts));

    // 2. Save pressed twice (second press after the first ended) and a fast double click.
    r = await scenario(
      context,
      seed(),
      `(async () => { const pid = ${PID}; ${COMMON}
        const bill = mkBill(); const btn = setup(bill);
        btn.click(); await wait(1500);
        btn.click(); await wait(1500);
        const afterTwo = { rows: meterRows().length, recs: recs().length };
        const bill2 = mkBill({ BillingPeriodStart: '11/05/2026', BillingPeriodEnd: '12/04/2026', TotalCurrentCharges: '5000.00' });
        window._pdfMultiBills = [bill2];
        btn.click(); btn.click(); btn.click(); // fast double / triple click
        await wait(1800);
        const rows2 = getUDMeter(pid, 'bSyn1', 'mElec1').bills.filter((x) => x.start === '2026-11-05');
        return { afterTwo, rows2: rows2.length, recs: recs().length, busy: window._pdfSaveBusy, dis: btn.disabled };
      })()`,
    );
    eq(r.afterTwo.rows, 1, '2: two Saves, one meter row');
    eq(r.afterTwo.recs, 1, '2: two Saves, one record');
    eq(r.rows2, 1, '2: fast triple click, one meter row');
    eq(r.recs, 2, '2: fast triple click adds exactly one more record (2 bills in total)');
    eq(r.dis, false, '2: button enabled at the end');

    // 3. Two concurrent saves of the same extracted bill without the button (join, not duplicate).
    r = await scenario(
      context,
      seed(),
      `(async () => { const pid = ${PID}; ${COMMON}
        const bill = mkBill(); setup(bill);
        const p1 = _saveSinglePDFBill(bill, pid); const p2 = _saveSinglePDFBill(bill, pid);
        await Promise.all([p1, p2]);
        const p3 = await _saveSinglePDFBill(bill, pid); // a later save of the same bill
        return { same: p1 === p2, recs: recs().length, rows: meterRows().length, p3 };
      })()`,
    );
    eq(r.same, true, '3: a running save is joined');
    eq(r.recs, 1, '3: concurrent + later save, one record');
    eq(r.rows, 1, '3: concurrent + later save, one meter row');

    // 4. Failure after the record write: toast, no hidden duplicate, button usable, retry replaces.
    r = await scenario(
      context,
      seed(),
      `(async () => { const pid = ${PID}; ${COMMON}
        const bill = mkBill(); const btn = setup(bill);
        const realMap = window._extractedToBillRowCosts;
        window._extractedToBillRowCosts = () => { throw new ReferenceError('kwCost is not defined (simulated)'); };
        btn.click(); await wait(1500);
        const failed = { toasts: toasts.slice(), recs: recs().map((x) => ({ id: x.id, projId: x.projId })), rows: meterRows().length, dis: btn.disabled };
        window._extractedToBillRowCosts = realMap;
        btn.click(); await wait(1500);
        return { failed, recs: recs(), rows: meterRows().length, dis: btn.disabled };
      })()`,
    );
    ok(r.failed.toasts.some((t) => /Save failed: kwCost is not defined/.test(t)), '4: failure shows a toast ' + JSON.stringify(r.failed.toasts));
    eq(r.failed.dis, false, '4: button enabled after a failure');
    eq(r.failed.recs.length, 1, '4: failed save left one record');
    eq(r.failed.recs[0] && r.failed.recs[0].projId, null, '4: failed save record is visible in Saved Bills (unassigned)');
    eq(r.failed.rows, 0, '4: failed save put nothing on the meter');
    eq(r.recs.length, 1, '4: retry replaced the record (no duplicate)');
    eq(r.recs[0] && r.recs[0].projId, PID, '4: retry assigned the record');
    eq(r.rows, 1, '4: retry put the bill on the meter');

    // 5. An identical unassigned record already exists (earlier broken saves): reuse it.
    const old = {
      id: 'pbOld1', savedAt: '2026-11-17T15:00:00.000Z', projId: null, UtilityCompany: 'SynElectric', Commodity: 'Electric',
      AccountNumber: '1000200030', BillingPeriodStart: '10/06/2026', BillingPeriodEnd: '11/04/2026',
      kWhConsumed: '58543.7120', TotalCurrentCharges: '6205.24',
    };
    const other = Object.assign({}, old, { id: 'pbOther', BillingPeriodStart: '09/06/2026', BillingPeriodEnd: '10/05/2026' });
    r = await scenario(
      context,
      seed([old, other]),
      `(async () => { const pid = ${PID}; ${COMMON}
        const bill = mkBill(); const btn = setup(bill);
        btn.click(); await wait(1500);
        return { ids: recs().map((x) => x.id + ':' + (x.projId || 'none')), rows: meterRows().length };
      })()`,
    );
    eq(r.ids.length, 2, '5: identical unassigned record reused, other period untouched: ' + JSON.stringify(r.ids));
    ok(r.ids.includes('pbOld1:' + PID) && r.ids.includes('pbOther:none'), '5: reused id and untouched record: ' + JSON.stringify(r.ids));
    eq(r.rows, 1, '5: bill on the meter');
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
