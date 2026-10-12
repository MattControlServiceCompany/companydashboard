// test-meter-import-dom.js
// Acceptance test: Import List makes meters of any commodity from a CSV, and Import Bills sends several
// bill CSV files (or one CSV with Account # / Meter # columns) to the right meters.
// 100% SYNTHETIC data, headless bundled Chromium. Utility data is read only through getUDBldgs.
// Run: node test-meter-import-dom.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PID = 999555;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

const ACCT3 = 'ACCT-0003'; // synthetic
const BAD_ACCT = 'BAD-0001'; // synthetic, matches no meter
const ELEC13 = 'MTR-0001'; // long meter id kept as typed
const PIPE = 'G-77 | G-78';

(async () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'meterimport-'));
  const w = (name, text) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const bldgList = w(
    'synth-building-list.csv',
    'Building Name,Building SQFT,Address\nSynth Hall,10000,"1 Test St, Synthville"\nSynth Annex,2500,2 Test St\n',
  );
  const meterList = w(
    'synth-meter-list.csv',
    [
      'Building,Commodity,Provider,Account #,Meter #,Bill file',
      'Synth Hall,Electric,Synth Power,ACCT-0001,' + ELEC13 + ',synth-hall-elec.csv',
      'Synth Hall,Gas,Synth Gas,ACCT-0002,' + PIPE + ',synth-hall-gas.csv',
      'Synth Annex,Electric,Synth Power,ACCT-0003,MTR-0003,synth-annex-elec.csv',
      'Synth Annex,Plasma,Synth Power,ACCT-0004,MTR-0004,synth-annex-plasma.csv',
      'Synth Tower,Water,Synth Water,ACCT-0005,W-1,synth-tower-water.csv',
      '',
    ].join('\n'),
  );
  const legacy = w(
    'synth-legacy.csv',
    'Building Name,Building SQFT,Address,Baldwin Svc,Baldwin Acct,KGS Service Address,KGS Account #,KGS Meter #\n' +
      'Synth Old School,5000,9 Old St,,,9 Old St,ACCT-0006 / ACCT-0007,M-1 / M-2\n',
  );
  const hdrElec = 'start_date,end_date,kwh,actual_kw,total_cost\n';
  const hallElec = w(
    'synth-hall-elec.csv',
    hdrElec +
      '2024-01-01,2024-02-01,1000,50,100.50\n2024-02-01,2024-03-01,2000,60,200.25\n2024-03-01,2024-04-01,3000,70,300.00\n',
  );
  const hallGas = w(
    'synth-hall-gas.csv',
    'start_date,end_date,therms,therm_cost\n2024-01-01,2024-02-01,500,400\n2024-02-01,2024-03-01,600,450\n',
  );
  const annexElec = w(
    'synth-annex-elec.csv',
    hdrElec + '2024-01-01,2024-02-01,10,5,1.10\n2024-02-01,2024-03-01,20,6,2.20\n2024-03-01,2024-04-01,30,7,3.30\n',
  );
  const orphan = w('synth-orphan.csv', hdrElec + '2024-01-01,2024-02-01,99,9,9.99\n');
  const combined = w(
    'synth-combined.csv',
    [
      'Account #,Meter #,start_date,end_date,kwh,total_cost',
      'ACCT-0003,MTR-0003,2024-04-01,2024-05-01,40,4.40',
      'ACCT-0003,MTR-0003,2024-05-01,2024-06-01,50,5.50',
      'ACCT-0001,' + ELEC13 + ',2024-04-01,2024-05-01,4000,400.00',
      'BAD-0001,1,2024-04-01,2024-05-01,1,1.00',
    ].join('\n'),
  );

  const context = await launchBrowser('meterimport', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [
        {
          id: PID,
          name: 'SYNTH METER IMPORT',
          client: 'Synth',
          customerId: CID,
          status: 'active',
          scope: { buildingIds: [], meterExcludeIds: [] },
          savingsData: { measures: [] },
        },
      ],
      en_customers: [{ id: CID, name: 'Synth Customer' }],
      ch_qs_seen: 1,
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
    const state = () =>
      page
        .evaluate(
          (pid) =>
            JSON.stringify(
              getUDBldgs(pid).map((b) => ({
                n: b.name,
                sq: b.sqft,
                ms: (b.meters || []).map((m) => [
                  m.commodity,
                  m.provider,
                  m.account,
                  m.meter,
                  m.billFile || '',
                  (m.bills || []).length,
                ]),
              })),
            ),
          PID,
        )
        .then(JSON.parse);
    const openImport = async (file) => {
      await tab.locator('button', { hasText: 'Import List' }).click();
      await page.setInputFiles('#bldgImportInput', file);
      await page.waitForTimeout(500);
    };

    // 0. the entry point: Import Bills next to Add Building and Import List, with hover text
    const billsBtn = tab.locator('button', { hasText: 'Import Bills' });
    eq(await billsBtn.count(), 1, 'project tab shows Import Bills');
    ok(/several bill CSV files/.test((await billsBtn.getAttribute('title')) || ''), 'Import Bills has hover text');
    ok(
      /meters/.test((await tab.locator('button', { hasText: 'Import List' }).getAttribute('title')) || ''),
      'Import List hover text mentions meters',
    );

    // 1. building list first (old shape: 3 columns), then the meter list joins those buildings
    await openImport(bldgList);
    eq(await page.locator('#bldgImportCount').textContent(), '2', 'building list: 2 buildings');
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    let s = await state();
    eq(s.length, 2, '2 buildings after the building list');

    await openImport(meterList);
    // preview: the bad commodity row is shown and not ticked
    const prev = await page.locator('#bldgImportPreviewTable').innerText();
    ok(/Plasma/.test(prev) && /Not imported: Commodity "Plasma"/.test(prev), 'bad commodity row shown with its reason');
    eq(await page.locator('#bldgImportMeterNote').textContent(), ' · 5 meters found', 'preview counts 5 meter rows');
    eq(
      await page.locator('#bldgImportBtn').textContent(),
      'Import 1 Building + 4 Meters',
      'button counts new things only',
    );
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    s = await state();
    eq(s.map((b) => b.n).join('|'), 'Synth Hall|Synth Annex|Synth Tower', 'meter list joined 2 buildings and made 1');
    const hall = s.find((b) => b.n === 'Synth Hall');
    eq(hall.sq, 10000, 'joined building keeps its sq ft');
    eq(hall.ms.length, 2, '2 meters on one building');
    eq(hall.ms.map((m) => m[0]).join('|'), 'Electric|Gas', 'meters of 2 commodities from one CSV');
    eq(hall.ms[0][3], ELEC13, 'meter id stays exact');
    eq(hall.ms[1][3], PIPE, 'meter number with " | " stays as it is');
    eq(hall.ms[1][1], 'Synth Gas', 'provider kept');
    eq(hall.ms[0][4], 'synth-hall-elec.csv', 'bill file name kept on the meter');
    const annex = s.find((b) => b.n === 'Synth Annex');
    eq(annex.ms.length, 1, 'bad commodity row made no meter');
    eq(s.find((b) => b.n === 'Synth Tower').ms[0][0], 'Water', 'new building with a Water meter');
    eq(
      await page.evaluate((pid) => getUDBldgs(pid).reduce((n, b) => n + b.meters.length, 0), PID),
      4,
      '4 meters in total',
    );
    eq(
      await page.evaluate((pid) => {
        const ms = getUDBldgs(pid)[0].meters;
        // Not stored: the one default rule (getMeterBillUnit / getMeterDisplayUnit) answers, same as for a roster-made meter.
        return [ms[0].billUnit || '', ms[0].displayUnit || '', getMeterBillUnit(ms[0]), getMeterDisplayUnit(ms[0]), getMeterBillUnit(ms[1])].join('/');
      }, PID),
      '//kWh/kWh/Therms',
      'import stores no unit; the shared default rule gives kWh for Electric and Therms for Gas',
    );

    // 2. re-import of the same meter list adds nothing
    await openImport(meterList);
    const prev2 = await page.locator('#bldgImportPreviewTable').innerText();
    ok(/meter is already there/.test(prev2), 'second import says meters are already there');
    eq(await page.locator('#bldgImportBtn').textContent(), 'Nothing new to import', 'second import: nothing new');
    eq(await page.locator('#bldgImportBtn').isDisabled(), true, 'second import: button off');
    await page.evaluate(() => closeBldgImportModal());
    eq(JSON.stringify(await state()), JSON.stringify(s), 'second import changed nothing');

    // 3. older shape with gas columns F-H still works (2 gas meters split on "/")
    await openImport(legacy);
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    s = await state();
    const old = s.find((b) => b.n === 'Synth Old School');
    eq(
      old && old.ms.map((m) => m[0] + ':' + m[1] + ':' + m[2] + ':' + m[3]).join(','),
      'Gas:Kansas Gas Service:ACCT-0006:M-1,Gas:Kansas Gas Service:ACCT-0007:M-2',
      'gas columns F-H make 2 gas meters',
    );

    // 4. Import Bills: several files at once
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [hallElec, hallGas, annexElec, orphan]);
    await page.waitForTimeout(700);
    const bp = await page.locator('#billsMultiPreviewTable').innerText();
    ok(
      /synth-orphan\.csv/.test(bp) && /Not imported: No meter lists this file name/.test(bp),
      'unmatched file is listed with its reason',
    );
    ok(/Synth Hall/.test(bp) && /Synth Annex/.test(bp), 'matched files show their building');
    ok(/6,000 kWh/.test(bp) && /60 kWh/.test(bp), 'preview shows kWh per file');
    ok(/\$600\.75/.test(bp) && /\$6\.60/.test(bp), 'preview shows $ per file');
    ok(
      /Total \(3 files\)/.test(bp) && /6,060 kWh/.test(bp) && /\$1,457\.35/.test(bp),
      'total row adds only matched files',
    );
    eq(
      await page.locator('#billsMultiBtn').textContent(),
      'Import 8 Periods for 3 Meter(s)',
      'button counts matched periods',
    );
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(500);
    const bills = () =>
      page.evaluate((pid) => {
        const o = {};
        getUDBldgs(pid).forEach((b) =>
          b.meters.forEach((m) => {
            o[b.name + '|' + m.commodity] = (m.bills || []).map((x) => [
              x.start,
              x.kwh == null ? x.therms : x.kwh,
              x.totalCost,
            ]);
          }),
        );
        return o;
      }, PID);
    let b1 = await bills();
    eq(b1['Synth Hall|Electric'].length, 3, 'hall electric got 3 bills');
    eq(b1['Synth Hall|Gas'].length, 2, 'hall gas got 2 bills');
    eq(b1['Synth Annex|Electric'].length, 3, 'annex electric got 3 bills');
    eq(JSON.stringify(b1['Synth Hall|Electric'].map((x) => x[1])), '[1000,2000,3000]', 'hall kWh exact');
    eq(b1['Synth Hall|Electric'][0][2], 100.5, 'hall cost exact');
    eq(b1['Synth Tower|Water'].length, 0, 'unmatched file imported nowhere');
    ok(
      /Imported: 8 new, 0 updated/.test(await page.locator('#billsMultiPreviewTable').innerText()) ||
        /Imported: 3 new/.test(await page.locator('#billsMultiPreviewTable').innerText()),
      'modal shows imported result',
    );
    ok(
      /1 file\(s\) were not imported/.test(await page.locator('#billsMultiSummary').innerText()),
      'summary still lists the unmatched file after import',
    );
    await page.evaluate(() => closeBillsMultiModal());

    // 5. the same files again: nothing is added twice
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [hallElec, hallGas, annexElec, orphan]);
    await page.waitForTimeout(700);
    const bp2 = await page.locator('#billsMultiPreviewTable').innerText();
    ok(/will update stored bills/.test(bp2), 're-import preview says it will update stored bills');
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(500);
    const b2 = await bills();
    eq(JSON.stringify(b2), JSON.stringify(b1), 'second import of the same files adds 0 bills');
    await page.evaluate(() => closeBillsMultiModal());

    // 6. one CSV with Account # and Meter # columns
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [combined]);
    await page.waitForTimeout(700);
    const bp3 = await page.locator('#billsMultiPreviewTable').innerText();
    ok(
      new RegExp('account ' + BAD_ACCT).test(bp3) && /Not imported: No meter in this project has this account/.test(bp3),
      'combined file: unknown account listed, not imported',
    );
    eq(
      await page.locator('#billsMultiBtn').textContent(),
      'Import 3 Periods for 2 Meter(s)',
      'combined file: 3 periods for 2 meters',
    );
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(500);
    const b3 = await bills();
    eq(b3['Synth Annex|Electric'].length, 5, 'annex got its 2 rows from the combined file');
    eq(b3['Synth Hall|Electric'].length, 4, 'hall got its 1 row from the combined file');
    eq(b3['Synth Hall|Electric'][3][1], 4000, 'combined row kWh exact');
    await page.evaluate(() => closeBillsMultiModal());

    // 6b. L2: account numbers that differ only by dashes or spaces are the SAME number (the roster importer's rule).
    // Import List says so in the preview (not silent); Import Bills refuses when two stored meters fit.
    const tower = await page.evaluate((pid) => {
      const b = getUDBldgs(pid).find((x) => x.name === 'Synth Tower');
      b.meters.push({ id: 'mx1', commodity: 'Gas', provider: 'Synth Gas', account: 'G1', meter: '', bills: [] });
      return b.id;
    }, PID);
    const dashList = w('synth-dash-list.csv', 'Building,Commodity,Provider,Account #,Meter #\nSynth Tower,Gas,Synth Gas,G-1,\n');
    await openImport(dashList);
    ok(/meter is already there/.test(await page.locator('#bldgImportPreviewTable').innerText()), 'L2: G-1 is shown as already there when G1 is stored');
    eq(await page.locator('#bldgImportBtn').textContent(), 'Nothing new to import', 'L2: nothing is added silently');
    await page.evaluate(() => closeBldgImportModal());
    await page.evaluate((i) => {
      getUDBldgs(i.pid).find((x) => x.id === i.bid).meters.push({ id: 'mx2', commodity: 'Gas', provider: 'Synth Gas', account: 'G-1', meter: '', bills: [] });
    }, { pid: PID, bid: tower });
    const gHdr = 'Account #,Commodity,start_date,end_date,therms,therm_cost\n';
    const dashBills = w('synth-dash-bills.csv', gHdr + 'G 1,Gas,2025-01-01,2025-02-01,10,5\n');
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [dashBills]);
    await page.waitForTimeout(500);
    ok(/More than one meter fits \(2\)/.test(await page.locator('#billsMultiPreviewTable').innerText()), 'L2: two stored meters that fit are refused');
    eq(await page.locator('#billsMultiBtn').isDisabled(), true, 'L2: nothing to import');
    await page.evaluate(() => closeBillsMultiModal());
    await page.evaluate((i) => {
      const b = getUDBldgs(i.pid).find((x) => x.id === i.bid);
      b.meters = b.meters.filter((m) => m.id !== 'mx1' && m.id !== 'mx2');
    }, { pid: PID, bid: tower });

    // 6c. L4: an electric account number equal to a gas account number. A Commodity column tells them apart; a file
    // with no usage value for the meter it reached is refused.
    await page.evaluate(([pid, acct]) => {
      const b = getUDBldgs(pid).find((x) => x.name === 'Synth Annex');
      b.meters.push({ id: 'mx3', commodity: 'Gas', provider: 'Synth Gas', account: acct, meter: 'GM-3', bills: [] });
    }, [PID, ACCT3]);
    const oneAcct = (extraHdr, extra, usageHdr, usage) =>
      'Account #,' + extraHdr + 'start_date,end_date,' + usageHdr + ',total_cost\nACCT-0003,' + extra + '2025-01-01,2025-02-01,' + usage + ',7.00\n';
    const noComm = w('synth-nocomm.csv', oneAcct('', '', 'kwh', '10'));
    const elecComm = w('synth-eleccomm.csv', oneAcct('Commodity,', 'Electric,', 'kwh', '10'));
    const gasComm = w('synth-gascomm.csv', oneAcct('Commodity,', 'Gas,', 'therms', '10'));
    const wrongComm = w('synth-wrongcomm.csv', oneAcct('Commodity,', 'Gas,', 'kwh', '10'));
    const badComm = w('synth-badcomm.csv', oneAcct('Commodity,', 'Plasma,', 'kwh', '10'));
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [noComm, elecComm, gasComm, wrongComm, badComm]);
    await page.waitForTimeout(700);
    const l4 = await page.locator('#billsMultiPreviewTable').innerText();
    ok(/More than one meter fits \(2\)\. Add a Meter # or a Commodity column/.test(l4), 'L4: no Commodity column, 2 fit: refused with the way out');
    ok(/The rows have no therms values, so they do not fit this Gas meter/.test(l4), 'L4: kWh rows sent to the gas meter are refused');
    ok(/Commodity "Plasma" is not one CompanyHub has/.test(l4), 'L4: unknown commodity is listed');
    eq(await page.locator('#billsMultiBtn').textContent(), 'Import 2 Periods for 2 Meter(s)', 'L4: the Electric row and the Gas row go to their own meter');
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(400);
    const l4b = await page.evaluate((pid) => {
      const o = {};
      getUDBldgs(pid).find((x) => x.name === 'Synth Annex').meters.forEach((m) => (o[m.commodity] = (m.bills || []).filter((x) => x.start === '2025-01-01').length));
      return o;
    }, PID);
    eq(JSON.stringify(l4b), JSON.stringify({ Electric: 1, Gas: 1 }), 'L4: one 2025-01 bill on each meter');
    await page.evaluate(() => closeBillsMultiModal());
    await page.evaluate((pid) => {
      const b = getUDBldgs(pid).find((x) => x.name === 'Synth Annex');
      b.meters = b.meters.filter((m) => m.id !== 'mx3');
      b.meters.forEach((m) => (m.bills = m.bills.filter((x) => x.start !== '2025-01-01')));
    }, PID);

    // 6d. L5: a project reload (sync) while the window is open replaces the stored objects. The bills must land in
    // the stored meter, and a meter that is gone is listed, not written.
    const syncFile = w('synth-hall-elec.csv', hdrElec + '2025-03-01,2025-04-01,111,5,11.00\n');
    const syncOther = w('synth-annex-elec.csv', hdrElec + '2025-03-01,2025-04-01,222,5,22.00\n');
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [syncFile, syncOther]);
    await page.waitForTimeout(600);
    await page.evaluate((i) => {
      const arr = getCustomerBuildings(i.cid); // what a sync does: new objects, same ids
      arr.splice(0, arr.length, ...JSON.parse(JSON.stringify(arr)));
      const b = getUDBldgs(i.pid).find((x) => x.name === 'Synth Annex');
      b.meters = b.meters.filter((m) => m.commodity !== 'Electric'); // and one meter was deleted elsewhere
    }, { cid: CID, pid: PID });
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(500);
    const l5 = await page.evaluate((pid) => {
      const h = getUDBldgs(pid).find((x) => x.name === 'Synth Hall').meters.find((m) => m.commodity === 'Electric');
      return h.bills.filter((x) => x.start === '2025-03-01').length;
    }, PID);
    eq(l5, 1, 'L5: the bill went to the meter that is stored now');
    ok(/The meter is no longer in the project/.test(await page.locator('#billsMultiPreviewTable').innerText()), 'L5: a deleted meter is listed, not written');
    await page.evaluate(() => closeBillsMultiModal());
    // put the Annex electric meter back and drop the test bill, for the checks below
    await page.evaluate((i) => {
      const b = getUDBldgs(i.pid).find((x) => x.name === 'Synth Annex');
      b.meters.push({ id: 'mx4', commodity: 'Electric', provider: 'Synth Power', account: i.acct, meter: 'MTR-0003', bills: [] });
      const h = getUDBldgs(i.pid).find((x) => x.name === 'Synth Hall').meters.find((m) => m.commodity === 'Electric');
      h.bills = h.bills.filter((x) => x.start !== '2025-03-01');
    }, { pid: PID, acct: ACCT3 });

    // 6e. L3: one line splitter. A BOM and Windows line ends work for the list and for a bill file picked by name.
    const bomList = w('synth-bom-list.csv', '\ufeffBuilding Name,Building SQFT,Address\r\n\r\nSynth Bom Hall,1200,3 Bom St\r\n');
    await openImport(bomList);
    eq(await page.locator('#bldgImportCount').textContent(), '1', 'L3: list with a BOM and CRLF reads 1 building');
    await page.evaluate(() => closeBldgImportModal());
    const bomBill = w('synth-hall-elec.csv', '\ufeff' + hdrElec.replace('\n', '\r\n') + '2025-05-01,2025-06-01,333,5,33.00\r\n');
    await billsBtn.click();
    await page.setInputFiles('#billsMultiInput', [bomBill]);
    await page.waitForTimeout(500);
    const bomPrev = await page.locator('#billsMultiPreviewTable').innerText();
    ok(/Synth Hall/.test(bomPrev) && /333 kWh/.test(bomPrev), 'L3: bill file with a BOM and CRLF routes by name');
    await page.evaluate(() => closeBillsMultiModal());

    // 6f. .xlsx input (real SheetJS in the page): meter rows work. Number cells keep every digit (no 5.55E+12),
    // text cells keep " | ", a number sq ft reads, and an .xlsx made of the older 3-column shape still works.
    const xlsxBytes = (rows) =>
      page.evaluate((r) => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r), 'Sheet1');
        return Array.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
      }, rows);
    const xBytes = await xlsxBytes([
      ['Building Name', 'Building SQFT', 'Address', 'Commodity', 'Provider', 'Account #', 'Meter #', 'Bill file'],
      ['Synth Xlsx Hall', 4321, '5 Xlsx St', 'Electric', 'Synth Power', 700001, 555099, 'synth-xlsx-elec.csv'],
      ['Synth Xlsx Hall', 4321, '5 Xlsx St', 'Gas', 'Synth Gas', 'ACCT-0008', 'G-77 | G-78', ''],
      ['Synth Xlsx Annex', '', '', 'Plasma', 'Synth Power', 700003, 1, ''],
      ['', '', '', '', '', '', '', ''],
    ]);
    await tab.locator('button', { hasText: 'Import List' }).click();
    await page.setInputFiles('#bldgImportInput', { name: 'synth-meters.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xBytes) });
    await page.waitForTimeout(600);
    const xPrev = await page.locator('#bldgImportPreviewTable').innerText();
    ok(/555099/.test(xPrev) && !/E\+/.test(xPrev), 'xlsx: number cell shows every digit in the preview');
    ok(/Not imported: Commodity "Plasma"/.test(xPrev), 'xlsx: bad commodity row is listed with its reason');
    eq(await page.locator('#bldgImportMeterNote').textContent(), ' · 3 meters found', 'xlsx: 3 meter rows read');
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    s = await state();
    const xh = s.find((b) => b.n === 'Synth Xlsx Hall');
    eq(xh && xh.sq, 4321, 'xlsx: number sq ft read');
    eq(xh && xh.ms.map((m) => m[0] + ':' + m[2] + ':' + m[3] + ':' + m[4]).join(','), 'Electric:700001:555099:synth-xlsx-elec.csv,Gas:ACCT-0008:G-77 | G-78:', 'xlsx: meters keep every digit and the " | " text');
    eq((s.find((b) => b.n === 'Synth Xlsx Annex') || { ms: [] }).ms.length, 0, 'xlsx: the Plasma row made no meter');
    const xOld = await xlsxBytes([
      ['Building Name', 'Building SQFT', 'Address'],
      ['Synth Xlsx Old', 900, '6 Xlsx St'],
    ]);
    await tab.locator('button', { hasText: 'Import List' }).click();
    await page.setInputFiles('#bldgImportInput', { name: 'synth-old.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xOld) });
    await page.waitForTimeout(500);
    eq(await page.locator('#bldgImportCount').textContent(), '1', 'xlsx: older 3-column sheet reads 1 building');
    await page.evaluate(() => closeBldgImportModal());

    // 7. sidebar page shows the same three buttons
    await page.evaluate((pid) => {
      sv('utility', document.querySelector('.s-item[onclick*="utility"]'));
      loadUtilityData();
      udSelectProj(pid);
    }, PID);
    await page.waitForTimeout(500);
    eq(await page.locator('#udNavList button', { hasText: 'Import Bills' }).count(), 1, 'sidebar Import Bills shown');
    eq(await page.locator('#udNavList button', { hasText: 'Import List' }).count(), 1, 'sidebar Import List shown');
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
