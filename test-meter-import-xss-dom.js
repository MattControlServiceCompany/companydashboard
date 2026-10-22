// test-meter-import-xss-dom.js
// Acceptance test: hostile text in an imported CSV (Import List, Import Bills, one-meter bill dialog) or in a
// file name never runs as HTML. It must show as literal text in the previews, the building list, the project
// tab, the building view and every meter tab. 100% SYNTHETIC data, headless bundled Chromium.
// Run: node test-meter-import-xss-dom.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PID = 999556;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));

// Three attack shapes: a tag in text, a break-out of a double-quoted attribute, a break-out of a single-quoted one.
const P1 = '<img src=x onerror=window.__xss=1>';
const P2 = '"><svg onload=window.__xss=1>';
const P3 = "'><svg onload=window.__xss=1>";
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'; // CSV cell
// The CSV reader drops double quotes, so a payload with one arrives without it.
const seen = (s) => s.replace(/"/g, '');
const row = (cells) => cells.map(q).join(',');

(async () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'meterxss-'));
  const w = (name, text) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, text);
    return f;
  };
  // Import List: one building per attack shape, every text field hostile.
  const BILLFILE1 = P1 + '.csv';
  const BILLFILE3 = P3 + '.csv';
  const listText = [
    'Building Name,Building SQFT,Address,Commodity,Provider,Account #,Meter #,Bill file',
    row([P1 + ' B1', '1000', P1 + ' St', 'Electric', P1 + ' Co', P1 + '11', P1 + '12', BILLFILE1]),
    row([P2 + ' B2', '2000', P2 + ' St', 'Gas', P2 + ' Co', P2 + '21', P2 + '22', P2 + '.csv']),
    row([P3 + ' B3', '3000', P3 + ' St', 'Electric', P3 + ' Co', P3 + '31', P3 + '32', BILLFILE3]),
    '',
  ].join('\n');
  const listFile = w('synth-xss-list.csv', listText);
  const billHdr =
    'start_date,end_date,kwh,total_cost,utilityCompany,customerName,serviceAddress,rateSchedule,meterReadStart,meterReadEnd';
  const hostileRow = (d, p) => row([d, '2024-02-01', '1000', '100.5', p, p, p, p, p, p]);
  const bill1 = billHdr + '\n' + hostileRow('2024-01-01', P1) + '\n';
  const bill3 = billHdr + '\n' + hostileRow('2024-01-01', P3) + '\n';
  const orphanName = P2 + 'orphan.csv'; // a file that fits no meter: listed in "Not imported"
  // one CSV with hostile Account # / Meter # cells that fit no meter
  const combined =
    'Account #,Meter #,start_date,end_date,kwh,total_cost\n' +
    row([P1, P3, '2024-01-01', '2024-02-01', '1', '1']) +
    '\n';
  // one-meter dialog: a row whose date is hostile text makes a warning that quotes the text
  const oneMeter =
    'start_date,end_date,kwh,total_cost\n2024-05-01,2024-06-01,1,1\n' + row([P1, '2024-06-01', '1', '1']) + '\n';

  const context = await launchBrowser('meterxss', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss());
    const seed = {
      en_projects: [
        {
          id: PID,
          name: 'SYNTH XSS',
          client: 'Synth',
          customerId: CID,
          status: 'active',
          scope: { buildingIds: [], meterExcludeIds: [] },
          savingsData: { measures: [] },
        },
      ],
      en_customers: [{ id: CID, name: 'Synth Customer' }],
      ch_settings: { showQuickStart: false },
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((d) => {
      if (!window.localStorage.getItem('__seeded')) {
        for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
        window.localStorage.setItem('__seeded', '1');
      }
    }, seed);
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('utility', document.querySelector('.pdt[data-tab="utility"]'));
    }, PID);
    await page.waitForTimeout(600);
    const tab = page.locator('#ptab-utility');
    // window.__xss stays undefined, and no element was made from the payload text.
    const check = async (label) => {
      await page.waitForTimeout(250);
      const x = await page.evaluate(() => ({
        flag: window.__xss,
        made: document.querySelectorAll('img[src="x"], svg[onload], [onerror], [onload]').length,
        where: Array.from(document.querySelectorAll('img[src="x"], svg[onload], [onerror], [onload]'))
          .slice(0, 3)
          .map((e) => (e.closest('[id]') ? e.closest('[id]').id : '?') + ' ' + e.parentElement.outerHTML.slice(0, 140))
          .join(' | '),
      }));
      await page.evaluate(() => { delete window.__xss; });
      ok(x.flag === undefined, label + ': window.__xss is still undefined');
      ok(x.made === 0, label + ': no element was made from the hostile text (' + x.made + ') ' + x.where);
    };

    // ---- Import List preview (cells, hover text) and a hostile file name
    await tab.locator('button', { hasText: 'Import List' }).click();
    await page.setInputFiles('#bldgImportInput', listFile);
    await page.waitForTimeout(500);
    const prev = await page.locator('#bldgImportPreviewTable').innerText();
    ok(
      prev.includes(P1 + ' B1') && prev.includes(seen(P2) + ' B2') && prev.includes(P3 + ' B3'),
      'list preview shows names as text',
    );
    ok(
      prev.includes(P1 + ' St') && prev.includes(seen(P2) + ' Co') && prev.includes(P3 + '32'),
      'list preview shows other cells as text',
    );
    const titles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#bldgImportPreviewTable td[title]')).map((t) => t.title),
    );
    ok(titles.includes(seen(P2) + ' B2') && titles.includes(P3 + ' B3'), 'hover text holds the full payload as text');
    await check('Import List preview');
    await page.evaluate(() => closeBldgImportModal());
    await tab.locator('button', { hasText: 'Import List' }).click();
    await page.setInputFiles('#bldgImportInput', {
      name: P1 + 'list.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(listText),
    });
    await page.waitForTimeout(500);
    ok(
      (await page.locator('#bldgImportDropLabel').textContent()).includes(P1 + 'list.csv'),
      'list file name shown as text',
    );
    await check('Import List file name');
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    await check('Import List saved (toast, project tab)');
    ok((await page.evaluate((pid) => getUDBldgs(pid).length, PID)) === 3, 'three hostile buildings were stored');

    // ---- Import Bills preview: matched by hostile bill file name, unmatched file, hostile Account # / Meter # cells
    await tab.locator('button', { hasText: 'Import Bills' }).click();
    await page.setInputFiles('#billsMultiInput', [
      { name: BILLFILE1, mimeType: 'text/csv', buffer: Buffer.from(bill1) },
      { name: BILLFILE3, mimeType: 'text/csv', buffer: Buffer.from(bill3) },
      { name: orphanName, mimeType: 'text/csv', buffer: Buffer.from(bill3) },
      { name: 'combined.csv', mimeType: 'text/csv', buffer: Buffer.from(combined) },
    ]);
    await page.waitForTimeout(700);
    const bp = await page.locator('#billsMultiPreviewTable').innerText();
    ok(bp.includes(seen(orphanName)), 'bills preview lists the hostile unmatched file name as text');
    ok(bp.includes(P1 + ' B1') && bp.includes(P3 + ' B3'), 'bills preview shows matched building names as text');
    ok(bp.includes('account ' + P1), 'bills preview shows hostile Account # / Meter # cells as text');
    await check('Import Bills preview');
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(500);
    await check('Import Bills done (preview, toast)');
    const nb = await page.evaluate(
      (pid) => getUDBldgs(pid).reduce((a, b) => a + b.meters.reduce((c, m) => c + m.bills.length, 0), 0),
      PID,
    );
    ok(nb === 2, 'two hostile bills were stored (' + nb + ')');
    await page.evaluate(() => closeBillsMultiModal());

    // ---- one-meter bill dialog: the warning quotes the bad date text
    const first = await page.evaluate((pid) => {
      const b = getUDBldgs(pid)[0];
      return { bid: b.id, mid: b.meters[0].id };
    }, PID);
    await page.evaluate((i) => {
      udSelectBldg(i.bid);
      udSelectMeter(i.mid);
    }, first);
    await page.waitForTimeout(400);
    await page.evaluate(
      (a) => {
        _csvImportMid = a.mid;
        parseBillCsv(a.text, 'one.csv');
      },
      { mid: first.mid, text: oneMeter },
    );
    const warn = await page.locator('#billCsvWarnings').innerText();
    ok(warn.includes(P1), 'one-meter dialog warning shows the bad date as text');
    await check('one-meter dialog warnings');
    await page.evaluate(() => closeBillCsvModal());

    // ---- a building saved WITH double quotes in every field (a CSV drops quotes; a backup or a PDF does not)
    await page.evaluate(
      (a) => {
        const proj = projects.find((p) => p.id == a.pid);
        const b = {
          id: 'bq1',
          name: a.p2 + ' Q',
          addr: a.p2 + ' Qaddr',
          zip: a.p2,
          sqft: 10,
          addrAliases: [a.p2 + ' alias'],
          meters: [
            {
              id: 'mq1',
              commodity: 'Electric',
              provider: a.p2 + ' prov',
              account: a.p2 + ' acct',
              meter: a.p2 + ' mtr',
              billFile: a.p2 + '.csv',
              bills: [
                {
                  id: 'rq1',
                  start: '2024-01-01',
                  end: '2024-02-01',
                  kwh: 5,
                  totalCost: 5,
                  utilityCompany: a.p2,
                  customerName: a.p2,
                  serviceAddress: a.p2,
                  accountNumber: a.p2,
                  meterNumber: a.p2,
                  rateSchedule: a.p3,
                },
              ],
            },
          ],
        };
        addUDBldg(proj.customerId, b);
        proj.scope.buildingIds.push(b.id);
        saveUtilityData(a.pid);
      },
      { pid: PID, p2: P2, p3: P3 },
    );

    // ---- every stored place: sidebar building list, building view, meter view, every meter tab, every edit window
    await page.evaluate((pid) => {
      sv('utility', document.querySelector('.s-item[onclick*="utility"]'));
      loadUtilityData();
      udSelectProj(pid);
    }, PID);
    await check('sidebar building list');
    const all = await page.evaluate(
      (pid) => getUDBldgs(pid).map((b) => ({ bid: b.id, mids: b.meters.map((m) => ({ id: m.id, rid: m.bills[0] && m.bills[0].id })) })),
      PID,
    );
    ok(all.length === 4, 'four stored buildings to look at (' + all.length + ')');
    let literal = false;
    const close = () =>
      page.evaluate(() => {
        document.querySelectorAll('.modal-bg.open').forEach((e) => e.classList.remove('open'));
        const sp = document.getElementById('billSplitPanel');
        if (sp) sp.remove();
      });
    for (const b of all) {
      await page.evaluate((id) => udSelectBldg(id), b.bid);
      await check('building view');
      await page.evaluate((a) => openBldgModalForProj(a.pid, a.bid), { pid: PID, bid: b.bid });
      await check('Edit Building window');
      await close();
      for (const m of b.mids) {
        await page.evaluate((id) => udSelectMeter(id), m.id);
        await check('meter view');
        for (const t of ['bills', 'norm', 'baseline', 'stats', 'perf', 'pipeline']) {
          await page.evaluate((tt) => maSetTab(tt), t);
          await check('meter tab ' + t);
        }
        await page.evaluate(() => maSetTab('bills'));
        const txt = await page.evaluate(() => document.body.innerText);
        if (txt.includes(P1) || txt.includes(P2) || txt.includes(P3)) literal = true;
        await page.evaluate((a) => openMeterModal(a.mid, a.pid, a.bid), { mid: m.id, pid: PID, bid: b.bid });
        await check('Edit Meter window');
        await close();
        if (m.rid) {
          await page.evaluate((a) => openBillModal(a.mid, a.rid), { mid: m.id, rid: m.rid });
          await check('Edit Bill window');
          await close();
          await page.evaluate((a) => showBillSplitPanel(a.mid, a.rid, { target: document.body, stopPropagation() {} }), { mid: m.id, rid: m.rid }).catch(() => {});
          await check('bill detail panel');
          await close();
        }
        await page.evaluate((id) => openExportModal('meter', id), m.id).catch(() => {});
        await check('Export window');
        await close();
        await page.evaluate(() => openAuditLogModal()).catch(() => {});
        await check('History window');
        await close();
      }
    }
    ok(literal, 'building / meter views show the payload as literal text');
    await page.evaluate((pid) => {
      sv('projects', document.querySelector('.s-item[onclick*="projects"]'));
      openDetail(pid);
      sPTab('utility', document.querySelector('.pdt[data-tab="utility"]'));
    }, PID);
    await check('project Utility Data tab');
    // every other tab of the project page (building names show on several)
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.pdt[data-tab]')).map((e) => e.dataset.tab));
    for (const t of tabs) {
      await page.evaluate((tt) => sPTab(tt, document.querySelector('.pdt[data-tab="' + tt + '"]')), t).catch(() => {});
      await check('project tab ' + t);
    }
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
