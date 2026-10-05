// test-assign-bill-create-meter-dom.js
// Acceptance test (item 4e1329b8): the Saved Bills "Assign" window must let the
// user create a new meter when the building has no meter of the bill's type.
// 100% SYNTHETIC data. Real app code, headless bundled Chromium, unique profile.
// Run: node test-assign-bill-create-meter-dom.js   (from the repo root)
const { chromium } = require('playwright');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PROFILE = 'C:/Temp/assign-create-meter-test-profile-' + Date.now();
const PID = 999000222;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1600, height: 900 },
  });
  try {
    const page = await context.newPage();
    const seed = {
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
                id: 'mGas1',
                commodity: 'Gas',
                provider: 'SynGas',
                account: 'G-111',
                bills: [{ id: 'rg1', start: '2026-01-01', end: '2026-01-31', therms: 10, totalCost: 10 }],
              },
            ],
          },
        ],
      },
      en_pdf_bills: [
        {
          id: 'pbSyn1',
          Commodity: 'Electric',
          UtilityCompany: 'SynElectric',
          AccountNumber: '555-0001',
          MeterNumber: '',
          BillingPeriodStart: '2026-02-01',
          BillingPeriodEnd: '2026-02-28',
          TotalCurrentCharges: 100,
          KWh: '1000',
          hasPDF: false,
        },
      ],
      ch_qs_seen: 1,
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((d) => {
      for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
    }, seed);
    await page.goto(SITE);
    await page.waitForTimeout(2500);

    const r = await page.evaluate(
      async ({ pid }) => {
        const out = {};
        loadUtilityData();
        openAssignModal('pbSyn1');
        document.getElementById('abm-proj').value = String(pid);
        populateAssignBuildings();
        document.getElementById('abm-bldg').value = 'bSyn1';
        populateAssignMeters();
        const sel = document.getElementById('abm-meter');
        out.options = Array.from(sel.options).map((o) => o.value + '|' + o.textContent);
        out.createVisible = (document.getElementById('abm-create-box') || {}).style
          ? document.getElementById('abm-create-box').style.display
          : 'missing';
        out.acctPrefill = (document.getElementById('abm-new-acct') || {}).value;
        const create = Array.from(sel.options).find((o) => o.value === '__CREATE_NEW__');
        if (create) {
          sel.value = '__CREATE_NEW__';
          sel.onchange && sel.onchange();
        }
        out.createVisibleAfter = (document.getElementById('abm-create-box') || { style: {} }).style.display;
        confirmAssignBill();
        await new Promise((res) => setTimeout(res, 300));
        const b = getUDBldg(pid, 'bSyn1');
        out.meters = b.meters.map((m) => ({
          id: m.id,
          commodity: m.commodity,
          account: m.account,
          bills: (m.bills || []).length,
        }));
        out.savedBillsLeft = (sget('en_pdf_bills', []) || []).length;
        return out;
      },
      { pid: PID },
    );

    ok(
      r.options.some((o) => o.startsWith('__CREATE_NEW__')),
      'meter list offers a Create new meter choice (got ' + JSON.stringify(r.options) + ')',
    );
    eq(r.options.length, 1, 'only the create choice when no Electric meter exists');
    eq(r.acctPrefill, '555-0001', 'account number prefilled from the bill');
    eq(r.createVisibleAfter, 'block', 'account box shown when create chosen');
    const gas = (r.meters || []).find((m) => m.id === 'mGas1');
    ok(gas && gas.bills === 1, 'existing Gas meter and its bill untouched');
    const elec = (r.meters || []).find((m) => m.commodity === 'Electric');
    ok(
      elec && elec.account === '555-0001' && elec.bills === 1,
      'new Electric meter holds the bill: ' + JSON.stringify(r.meters),
    );
    eq(r.savedBillsLeft, 0, 'bill removed from Saved Bills after assign');
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
