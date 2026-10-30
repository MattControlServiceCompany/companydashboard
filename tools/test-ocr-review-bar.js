// test-ocr-review-bar.js — PDF / OCR, a file with bills of more than one account (synthetic data, headless Chromium).
// No separate review window: each bill shows its destination issue at the top of its values (#pdfBillDest), and the
// review bar under the values (#pdfReviewBar) is always visible with counts, one link per issue and Save All.
//   1. A bill with no matching meter (address "825 Testcat Dr") shows the issue in its box and in the bar, and is
//      never green (box, building row, utility status).
//   2. Save All is on when the only bills with issues are unchecked.
//   3. Create meter on bill A at once sends bill B (same account) to the same new meter: "New ... meter for account ... (from
//      bill N)", checked. Save All makes exactly 1 meter, with both bills on it.
//   4. A bar link opens that bill. The Customer Charge row starts at the left edge. The Create button is a styled
//      button in the bill's box. The bar does not cover the last row at the end of the page.
// SHOTS=<dir>: also saves dark + light screenshots at 1920 and 640 px wide.
const path = require('path');
const { launchBrowser } = require('./launch-browser.js');
const REPO = path.resolve(__dirname, '..');
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const SHOTS = process.env.SHOTS || '';
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));

// Synthetic project: one building with an electric and a gas meter. The file has 4 bills:
// 0 electric, known account; 1 + 2 electric, unknown account at 825 Testcat Dr; 3 gas, known account, held.
function seed() {
  const P = { id: 990001, name: 'ZZ Synthetic District', customerId: 'cust_990001' };
  projects = projects.filter((p) => p.id !== P.id).concat([P]);
  sset('en_projects', projects);
  utilityData['cust_990001'] = {
    buildings: [
      {
        id: 'zb1',
        name: 'Synth Elementary',
        addr: '100 Test Ave',
        meters: [
          { id: 'zm1', commodity: 'Electric', account: 'TST-0001', bills: [] },
          { id: 'zm2', commodity: 'Gas', account: 'TST-0002', bills: [] },
        ],
      },
    ],
  };
  udSelProjId = P.id;
  const bill = (comm, acct, addr, s, e, extra) =>
    Object.assign(
      {
        Commodity: comm,
        UtilityCompany: 'Synthetic Power',
        AccountNumber: acct,
        ServiceAddress: addr,
        BillingPeriodStart: s,
        BillingPeriodEnd: e,
        CustomerCharge: '25.00',
        TotalCurrentCharges: '125.00',
        kWhConsumed: comm === 'Electric' ? '1000' : null,
        ElectricCharge: comm === 'Electric' ? '100.00' : null,
      },
      extra || {},
    );
  window._pdfMultiBills = [
    bill('Electric', 'TST-0001', '100 Test Ave', '08/15/2026', '09/14/2026'),
    bill('Electric', 'TST-0003', '825 Testcat Dr', '08/15/2026', '09/14/2026'),
    bill('Electric', 'TST-0003', '825 Testcat Dr', '07/15/2026', '08/14/2026'),
    bill('Gas', 'TST-0002', '100 Test Ave', '08/15/2026', '09/14/2026', {
      GasCharge: '100.00',
      NaturalGasTherms: '80',
      _gateTripped: true,
      _gateReasons: ['Total needs a check against the PDF'],
    }),
  ];
  window._pdfBillWarnings = [{ warnings: [] }, { warnings: [] }, { warnings: [] }, { warnings: [] }];
  window._pdfDupMap = {};
  window._pdfSourceFileName = 'synthetic-multi-account.pdf';
  window._pdfMultiIdx = 1;
  window._pdfBuildingTab = 'TST-0003';
  window._pdfCommTab = 'Electric';
  renderMultiBillUI(window._pdfMultiBills);
  renderPDFFields(window._pdfMultiBills[1], []);
  showAutoAssignBanner(null, window._pdfMultiBills[0]);
}

async function open(context, theme, width) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript((t) => {
    localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, theme: t }));
    localStorage.setItem('ch_theme', t);
    localStorage.setItem('ch_backend_mode', 'off');
    localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false }));
  }, theme);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(SITE);
  await page.waitForTimeout(2500);
  await page.evaluate(() => sv('pdf'));
  await page.waitForTimeout(300);
  await page.evaluate(seed);
  await page.waitForTimeout(300);
  return { page, errs };
}

(async () => {
  const context = await launchBrowser('ocr-review-bar');
  try {
    const { page, errs } = await open(context, 'dark', 1920);
    const r1 = await page.evaluate(() => {
      const box = document.getElementById('pdfBillDest');
      const bar = document.getElementById('pdfReviewBar');
      const bldg = [...document.querySelectorAll('.pdf-bldg')].find((b) => b.dataset.acct === 'TST-0003');
      const create = box.querySelector('button.primary');
      const cs = create && getComputedStyle(create);
      return {
        reviewWindow: !!document.getElementById('pdfMultiBldgPanel') || !!document.getElementById('pdfSavePop'),
        boxVisible: box.offsetParent !== null,
        boxText: box.textContent,
        boxCls: box.className,
        barVisible: bar.offsetParent !== null,
        barText: bar.textContent,
        bldgCls: bldg ? bldg.className : '(no row)',
        createText: create ? create.textContent : '',
        createBg: cs ? cs.backgroundColor : '',
        createRadius: cs ? cs.borderRadius : '',
        emColor: getComputedStyle(document.documentElement).getPropertyValue('--em').trim(),
        saveAllDisabled: document.getElementById('mbSaveAllBtn').disabled,
        saveAllText: document.getElementById('mbSaveAllBtn').textContent,
        checked2: _mbRowState[2].checked,
      };
    });
    ok(!r1.reviewWindow, 'the separate Review and save window is gone');
    ok(r1.boxVisible && /No matching building or meter/.test(r1.boxText), 'bill view shows "No matching building or meter": ' + r1.boxText);
    ok(/825 Testcat Dr/.test(r1.boxText), 'bill view names the address');
    ok(/st-err/.test(r1.boxCls) && !/st-ok/.test(r1.boxCls), 'bill box is not green: ' + r1.boxCls);
    ok(/st-review/.test(r1.bldgCls), 'building row of the no-match bills is not green: ' + r1.bldgCls);
    ok(r1.barVisible && /No matching building or meter/.test(r1.barText) && /825 Testcat Dr|Testcat/.test(r1.barText), 'bar lists the no-match issue: ' + r1.barText);
    ok(/4 bills · 1 ready · 3 with issues/.test(r1.barText), 'bar counts: ' + r1.barText.slice(0, 60));
    ok(r1.createText === 'Create building + meter', 'Create button in the bill box: ' + r1.createText);
    ok(r1.createBg !== 'rgba(0, 0, 0, 0)' && r1.createRadius !== '0px', 'Create button is a styled button: ' + r1.createBg + ' ' + r1.createRadius);
    ok(r1.saveAllDisabled === false && /Save All \(1\)/.test(r1.saveAllText), 'Save All on while only the issue bills are unchecked: ' + r1.saveAllText);
    ok(r1.checked2 === false, 'bill 2 starts unchecked');

    // A bar link opens that bill: the held gas bill.
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('#pdfReviewBar .pdf-rb-link')].find((x) => /Held/.test(x.textContent));
      a.click();
    });
    await page.waitForTimeout(400);
    const r2 = await page.evaluate(() => ({ idx: window._pdfMultiIdx, box: document.getElementById('pdfBillDest').textContent }));
    ok(r2.idx === 3 && /Bill \d of 4/.test(r2.box), 'bar link opens the held bill: idx ' + r2.idx);

    // Customer Charge row starts at the left edge of the values.
    const r3 = await page.evaluate(() => {
      const inp = document.querySelector('.ef-input[data-key="CustomerCharge"]');
      const item = inp && inp.closest('.ef-item');
      const grid = document.querySelector('#extractedFieldsGrid .ef-grid');
      return item && grid ? { item: item.getBoundingClientRect().left, grid: grid.getBoundingClientRect().left } : null;
    });
    ok(r3 && Math.abs(r3.item - r3.grid) <= 2, 'Customer Charge starts at the left edge: ' + JSON.stringify(r3));

    // Create meter on bill 1: bill 2 (same account) follows at once.
    await page.evaluate(() => {
      window._pdfBuildingTab = 'TST-0003';
      selectMultiBill(1);
    });
    await page.waitForTimeout(200);
    await page.click('#pdfBillDest button.primary');
    await page.waitForTimeout(200);
    const r4 = await page.evaluate(() => {
      selectMultiBill(2);
      return {
        t2: _mbRowTargets[2] && _mbRowTargets[2].matchType,
        from: _mbRowTargets[2] && _mbRowTargets[2].fromRow,
        checked2: _mbRowState[2].checked,
        box2: document.getElementById('pdfBillDest').textContent,
        bill1No: _mbBillNo(1),
        bar: document.getElementById('pdfReviewBar').textContent,
      };
    });
    ok(r4.t2 === 'create' && r4.from === 1 && r4.checked2 === true, 'bill 2 follows bill 1 to the new meter, checked: ' + JSON.stringify(r4).slice(0, 120));
    ok(new RegExp('New [A-Za-z]+ meter for account [^ ]+ in .*\\(from bill ' + r4.bill1No + '\\)').test(r4.box2), 'bill 2 shows "New ... meter ... (from bill N)": ' + r4.box2);
    ok(!/No matching/.test(r4.bar), 'bar no longer lists the no-match issue');
    ok(/on new building 825 Testcat Dr/.test(r4.box2), 'Saves-to line names the new building from the service address: ' + r4.box2);
    // Undo removes the pending building and meter for both bills (nothing is made before Save).
    await page.evaluate(() => { selectMultiBill(1); });
    await page.click('#pdfBillDest .pdf-dest-line a');
    await page.waitForTimeout(200);
    const rU = await page.evaluate(() => ({ t1: _mbRowTargets[1] && _mbRowTargets[1].matchType, t2: _mbRowTargets[2] && _mbRowTargets[2].matchType, n: utilityData['cust_990001'].buildings.length }));
    ok(rU.t1 !== 'create' && rU.t2 !== 'create' && rU.n === 1, 'Undo clears both bills and made no building: ' + JSON.stringify(rU));
    await page.evaluate(() => { selectMultiBill(1); });
    await page.click('#pdfBillDest button.primary');
    await page.waitForTimeout(200);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '2026-10-29-review-bar-dark-1920-after-create.png') });

    // Save All: exactly one new meter for account TST-0003, both bills on it.
    await page.evaluate(() => confirmMultiBuildingSave('save'));
    await page.waitForTimeout(800);
    const r5 = await page.evaluate(() => {
      const ms = [];
      utilityData['cust_990001'].buildings.forEach((b) =>
        (b.meters || []).forEach((m) => {
          if (String(m.account || '') === 'TST-0003') ms.push((m.bills || []).length);
        }),
      );
      return { meters: ms, saved: window._pdfMultiBills.map((b) => !!b._mbSaved), bar: document.getElementById('pdfReviewBar').textContent };
    });
    const r5b = await page.evaluate(() => utilityData['cust_990001'].buildings.map((b) => b.name + ':' + (b.meters || []).length));
    ok(r5b.length === 2 && r5b.includes('825 Testcat Dr:1') && !r5b.some((x) => /Unmatched/.test(x)), 'one new building from the address with the one new meter: ' + JSON.stringify(r5b));
    ok(r5.meters.length === 1 && r5.meters[0] === 2, 'one new meter with both bills: ' + JSON.stringify(r5.meters));
    ok(JSON.stringify(r5.saved) === '[true,true,true,false]', 'saved bills 0,1,2, the held bill stays: ' + JSON.stringify(r5.saved));
    ok(/3 saved/.test(r5.bar), 'bar shows saved count: ' + r5.bar.slice(0, 60));
    ok(!errs.length, 'no page errors: ' + errs.slice(0, 2).join(' | '));
    await page.close();

    // Layout: dark + light at 1920 and 640. The bar is in view at the top of the page, and at the end of the page it
    // does not cover the last row. Nothing in the box or the bar overflows.
    for (const theme of ['dark', 'light']) {
      for (const width of [1920, 640]) {
        const v = await open(context, theme, width);
        const top = await v.page.evaluate(() => {
          const r = document.getElementById('pdfReviewBar').getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
        });
        ok(top.bottom <= top.vh + 1 && top.top < top.vh, theme + ' ' + width + ': bar in view at the top of the page ' + JSON.stringify(top));
        if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, '2026-10-29-review-bar-' + theme + '-' + width + '.png') });
        const end = await v.page.evaluate(() => {
          const sc = document.getElementById('pdfValuesScroll'); // the values scroll region; the bar is a row under it
          sc.scrollTop = sc.scrollHeight;
          const rows = [...document.querySelectorAll('#extractedFieldsGrid .ef-item, #extractedFieldsGrid .ef-tools')];
          const last = rows[rows.length - 1].getBoundingClientRect();
          const bar = document.getElementById('pdfReviewBar').getBoundingClientRect();
          const over = [];
          document.querySelectorAll('#pdfReviewBar *, #pdfBillDest *').forEach((el) => {
            if (el.classList.contains('pdf-rb-link') || el.classList.contains('pdf-rb-links')) return; // ellipsis / own scroll by design
            if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX !== 'visible')
              over.push(el.className + ':' + el.textContent.slice(0, 30));
          });
          return { lastBottom: last.bottom, barTop: bar.top, barBottom: bar.bottom, vh: window.innerHeight, over };
        });
        ok(end.lastBottom <= end.barTop + 1, theme + ' ' + width + ': bar does not cover the last row ' + JSON.stringify(end));
        ok(end.barBottom <= end.vh + 1, theme + ' ' + width + ': bar still on screen after the values scroll to the end ' + JSON.stringify(end));
        ok(!end.over.length, theme + ' ' + width + ': no overflow in box/bar ' + end.over.join(' | '));
        if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, '2026-10-29-review-bar-' + theme + '-' + width + '-end.png') });
        ok(!v.errs.length, theme + ' ' + width + ': no page errors ' + v.errs.slice(0, 2).join(' | '));
        await v.page.close();
      }
    }

    // Issue list in the bar: at most 3 links, then "+N more issues"; expand shows all; no link is ever cut.
    for (const theme of ['dark', 'light']) {
      for (const n of [18, 2]) {
        const v = await open(context, theme, 1536);
        await v.page.setViewportSize({ width: 1536, height: 800 });
        await v.page.evaluate((n) => {
          const bills = [];
          for (let i = 0; i < n; i++)
            bills.push(Object.assign({}, window._pdfMultiBills[1], { AccountNumber: 'TST-' + String(100 + i).padStart(4, '0'), ServiceAddress: i + ' Testcat Dr' }));
          window._pdfMultiBills = bills;
          window._pdfBillWarnings = bills.map(() => ({ warnings: [] }));
          window._pdfRbExpanded = false;
          window._pdfMultiIdx = 0;
          window._pdfBuildingTab = bills[0].AccountNumber;
          renderMultiBillUI(bills);
          renderPDFFields(bills[0], []);
        }, n);
        await v.page.waitForTimeout(300);
        const cut = () =>
          v.page.evaluate(() => {
            const bar = document.getElementById('pdfReviewBar').getBoundingClientRect();
            const list = document.querySelector('#pdfReviewBar .pdf-rb-links');
            const lr = list ? list.getBoundingClientRect() : null;
            const links = [...document.querySelectorAll('#pdfReviewBar .pdf-rb-link')];
            const inside = (r, c) => r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
            const vis = links.filter((a) => {
              const r = a.getBoundingClientRect();
              return !lr || (r.bottom > lr.top && r.top < lr.bottom);
            });
            return {
              total: links.length,
              cutLinks: vis.filter((a) => !inside(a.getBoundingClientRect(), bar) || (lr && !inside(a.getBoundingClientRect(), lr))).length,
              more: (document.querySelector('#pdfReviewBar .pdf-rb-more:not(.pdf-rb-create)') || {}).textContent || '',
              barBottom: bar.bottom,
              barH: bar.height,
              vh: window.innerHeight,
              scrollerH: document.getElementById('pdfValuesScroll').getBoundingClientRect().height,
            };
          });
        const c1 = await cut();
        const tag = theme + ' ' + n + ' issues: ';
        if (n === 18) {
          ok(c1.total === 3 && c1.more === '+15 more issues', tag + '3 links and "+15 more issues": ' + JSON.stringify(c1));
          ok(c1.cutLinks === 0, tag + 'no link cut ' + JSON.stringify(c1));
          if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, '2026-10-29-ocrbar-list-after-' + theme + '-18.png') });
          await v.page.click('#pdfReviewBar .pdf-rb-more:not(.pdf-rb-create)');
          const c2 = await cut();
          ok(c2.total === 18 && c2.more === 'Show less', tag + 'expanded shows all 18: ' + JSON.stringify(c2));
          ok(c2.cutLinks === 0 && c2.barBottom <= c2.vh + 1 && c2.barH <= c2.vh * 0.5 + 60, tag + 'expanded: none cut, bar on screen, list capped ' + JSON.stringify(c2));
          if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, '2026-10-29-ocrbar-list-after-' + theme + '-18-expanded.png') });
          await v.page.click('#pdfReviewBar .pdf-rb-more:not(.pdf-rb-create)');
          const c3 = await cut();
          ok(c3.total === 3 && /^\+15/.test(c3.more), tag + 'Show less collapses again');
        } else {
          ok(c1.total === 2 && c1.more === '' && c1.cutLinks === 0, tag + 'both links, no button, none cut: ' + JSON.stringify(c1));
          if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, '2026-10-29-ocrbar-list-after-' + theme + '-2.png') });
        }
        ok(!v.errs.length, tag + 'no page errors ' + v.errs.slice(0, 2).join(' | '));
        await v.page.close();
      }
    }
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
