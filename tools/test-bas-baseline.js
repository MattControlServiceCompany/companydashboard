'use strict';
// Tests for the baseline import (app/bas-baseline.js): the Set Points sheet CSV -> baseline entries of the
// en_bas_schedhistory_<pid> record. Header names must be names the Equipment Matrix export writes
// (EM_SETPOINT_EXPORT_HEADERS), most common value per building, a secondary group at 15% or more is noted,
// a baseline typed by a person is kept, the audit log import and this import leave each other's entries alone,
// and the "Import baseline (Set Points sheet)" button saves the record. SYNTHETIC data only.
// Run: node tools/test-bas-baseline.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const BBL = require(path.join(ROOT, 'app', 'bas-baseline.js'));
const BAL = require(path.join(ROOT, 'app', 'bas-audit-log.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const eq = (a, b, m) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, m + (same ? '' : '  got ' + JSON.stringify(a) + '  want ' + JSON.stringify(b)));
};

// the real CSV splitter and the real export header list, taken out of the app files (no copy)
const sb = {};
vm.createContext(sb);
const alarms = fs.readFileSync(path.join(ROOT, 'app', 'bas-alarms.js'), 'utf8').replace(/\r\n/g, '\n');
const i0 = alarms.indexOf('\nfunction baSplitCSV(');
vm.runInContext(alarms.slice(i0 + 1, alarms.indexOf('\n}\n', i0) + 3), sb);
const em = fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8').replace(/\r\n/g, '\n');
const hs = em.indexOf('var EM_SETPOINT_EXPORT_HEADERS = [');
vm.runInContext(em.slice(hs, em.indexOf('];', hs) + 2), sb);
const split = sb.baSplitCSV;

ok(Object.values(BBL.COLS).every((n) => sb.EM_SETPOINT_EXPORT_HEADERS.indexOf(n) >= 0), 'every column name read is a column name the Equipment Matrix export writes');

const H = ['', 'Building Name', 'Building location or equipment affected', 'Type of Equipment', 'Existing Occupied Heating', 'Existing Occupied Cooling', 'Existing Occupied Start Time Monday-Friday', 'Existing Occupied Stop Time Monday-Friday', 'Existing Occupied Sat & Sun'];
const row = (b, loc, h, c, s, e, w) => ['', b, loc, 'VAV', h, c, s, e, w || 'None'];
const q = (r) => r.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(',') + '\r\n';
const R = [];
for (let i = 0; i < 17; i++) R.push(row('Alpha Elementary', 'Area A - Room ' + i, '68', '72', '06:00:00', '16:00:00'));
for (let i = 0; i < 4; i++) R.push(row('Alpha Elementary', 'Area G - Gym ' + i, '66', '70', '06:00:00', '20:00:00'));
R.push(row('Alpha Elementary', 'Area A - Odd', '70', '74', '05:30:00', '16:30:00'));
for (let i = 0; i < 4; i++) R.push(row('Beta Hall', 'Wing ' + i, '68', '72', '07:00:00', '15:00:00'));
R.push(row('Beta Hall', 'Blank hours', '68', '72', '', ''));
R.push(row('Gamma Wing', 'x', '?', '?', '05:00:00', '15:00:00'));
const text = '﻿' + q(H) + R.map(q).join('');
const p = BBL.parseRows(split(text));
const pick = (n) => p.buildings.filter((b) => b.building === n)[0];
const A = pick('Alpha Elementary');
const B = pick('Beta Hall');
const G = pick('Gamma Wing');
eq(A.baselineWeekday, '6:00 to 16:00 (Area G 6:00 to 20:00)', 'most common hours; a 15% group in one area is noted with its area');
ok(A.baselineWeekday.indexOf('5:30') < 0, 'a group under 15% of rows is not noted');
eq(A.setPoints, 'heating 68, cooling 72', 'most common set point pair');
eq(A.weekend, 'None', 'weekend value');
eq(B.baselineWeekday, '7:00 to 15:00', 'rows without hours are left out of the count');
eq(G.setPoints, null, 'no numeric set points: nothing written');
ok(BBL.parseRows(split('"Building Name","x"\r\n')).error, 'a file with other columns is refused');

const R2 = [];
for (let i = 0; i < 6; i++) R2.push(row('Delta', 'Area A - r' + i, '68', '72', '05:00:00', '15:00:00'));
for (let i = 0; i < 2; i++) R2.push(row('Delta', 'Area B - r' + i, '68', '72', '05:00:00', '19:00:00'), row('Delta', 'Area C - r' + i, '68', '72', '05:00:00', '19:00:00'));
eq(BBL.parseRows(split(q(H) + R2.map(q).join(''))).buildings[0].baselineWeekday, '5:00 to 15:00 (some 5:00 to 19:00)', 'a secondary group over several areas is "some"');

const names = ['Alpha Elementary School', 'Beta Hall'];
const m1 = BBL.apply(null, p.buildings, names);
eq(m1.rec.buildings.map((b) => b.building), ['Alpha Elementary School', 'Beta Hall'], 'project building names are used; Gamma Wing has no project building and is not saved (same match as the audit log import)');
eq(m1.matched.filter((m) => !m.project).map((m) => m.log), ['Gamma Wing'], 'and is listed as not matched');
const a1 = m1.rec.buildings[0];
eq([a1.baselineWeekday[0].src, a1.weekend[0].kind, a1.setPoints[0].src], [BBL.SOURCE, 'baseline', BBL.SOURCE], 'baseline entries carry the source mark');
eq(BBL.apply(m1.rec, p.buildings, names).rec, m1.rec, 'second import gives the same record');
const typed = JSON.parse(JSON.stringify(m1.rec));
typed.buildings[0].baselineWeekday = [{ text: 'typed' }];
eq(BBL.apply(typed, p.buildings, names).rec.buildings[0].baselineWeekday, [{ text: 'typed' }], 'a baseline typed by a person is kept');
const changed = p.buildings.map((b) => (b.building === 'Beta Hall' ? Object.assign({}, b, { baselineWeekday: '8:00 to 9:00' }) : b));
eq(BBL.apply(m1.rec, changed, names).rec.buildings[1].baselineWeekday[0].text, '8:00 to 9:00', 'an entry with this import source mark is replaced');

const log =
  '"Date","Description","Details","Location","Operator"\r\n' +
  q([
    '7/1/2026 8:00:00 AM',
    'Update schedule "Main"',
    'Old values:\n"Occupancy" schedule "Main" at priority "Normal"\nType "Weekly", days: Mon Tue Wed Thu Fri\nAt "0:0" set "null"\nAt "6:0" set "Occupied"\nAt "16:0" set "null"\nNew values:\n"Occupancy" schedule "Main" at priority "Normal"\nType "Weekly", days: Mon Tue Wed Thu Fri\nAt "0:0" set "null"\nAt "7:0" set "Occupied"\nAt "16:0" set "null"',
    '/Test District/Alpha Elementary',
    'Op',
  ]);
const res = BAL.analyze(BAL.parseRows(split(log)).events);
const one = BAL.apply(BBL.apply(null, p.buildings, names).rec, res, names).rec;
const two = BBL.apply(BAL.apply(null, res, names).rec, p.buildings, names).rec;
const get = (r) => r.buildings.filter((b) => b.building === 'Alpha Elementary School')[0];
eq(get(one), get(two), 'audit log import and baseline import give the same record in either order');
ok(get(one).baselineWeekday[0].text.indexOf('6:00 to 16:00') === 0 && get(one).weekday.length === 1, 'both are in the record: baseline and dated weekday');

// set points from the stored points list (Equipment Matrix rows)
const pr = (b, t, h, c) => ({ building: b, type: t, heat: h, cool: c });
eq(BBL.fromPoints([pr('Zed', 'Unit Heater', '45.0 F', '90.0 F'), pr('Zed', 'Unit Heater', '45.0 F', '90.0 F'), pr('Zed', 'Unit Heater', '50.0 F', '90.0 F'), pr('Zed', 'Unit Heater', '', '')]), [{ building: 'Zed', text: 'Unit heaters: heating 45, cooling 90' }], 'points list: most common pair, labelled by type when every row has the same type; rows without both are left out');
eq(BBL.fromPoints([pr('Zed', 'Unit Heater', '45 F', '90 F'), pr('Zed', 'Monitoring', '45 F', '90 F')]), [{ building: 'Zed', text: 'heating 45, cooling 90' }], 'points list: mixed types give no type label');
// a baseline written by the audit log fallback is replaced by the sheet; a typed one is not
const auto = { version: 1, buildings: [{ building: 'Beta Hall', baselineWeekday: [{ text: 'from log', src: BAL.AUDIT_SRC }], weekday: [], weekend: [], setPoints: [{ kind: 'baseline', text: 'from list', src: BAL.POINTS_SRC }] }] };
const over = BBL.apply(auto, p.buildings, names).rec.buildings[0];
ok(over.baselineWeekday[0].src === BBL.SOURCE && over.setPoints[0].src === BBL.SOURCE, 'the sheet replaces a baseline written by the audit log fallback');

(async () => {
  const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
  const ctx = await launchBrowser('bas-baseline');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => window.__siteUI && typeof window.basRender === 'function' && window.BasBaseline, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.getUDBldgs = () => [{ name: 'Alpha Elementary School' }, { name: 'Beta Hall' }];
      const host = document.createElement('div');
      host.id = 'bas-panel-9';
      host.style.cssText = 'position:fixed;left:0;top:0;width:1100px;background:var(--bg);z-index:99999';
      document.body.appendChild(host);
      window.basRender(9);
    });
    ok((await page.locator('#bas-panel-9 button', { hasText: 'Import baseline (Set Points sheet)' }).count()) === 1, 'the card has the "Import baseline (Set Points sheet)" button');
    await page.setInputFiles('#bas-bfile-9', [{ name: 'sp.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }]);
    await page.waitForFunction(() => /Saved the baseline/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    const rec = await page.evaluate(() => DB.get('en_bas_schedhistory_9', null));
    eq(rec, m1.rec, 'the record saved by the button equals the record from the module');
    await page.setInputFiles('#bas-bfile-9', [{ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('"A"\r\n"1"\r\n') }]);
    await page.waitForFunction(() => /not the Set Points sheet/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    ok(true, 'a wrong file shows a message');
    const before = await page.evaluate(() => JSON.stringify(DB.get('en_bas_schedhistory_9', null)));
    await page.setInputFiles('#bas-bfile-9', [{ name: 'zero.csv', mimeType: 'text/csv', buffer: Buffer.from('') }, { name: 'other.csv', mimeType: 'text/csv', buffer: Buffer.from('"A"\r\n"1"\r\n') }]);
    await page.waitForFunction(() => /Nothing was imported/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    const allBad = await page.evaluate(() => ({ s: JSON.stringify(DB.get('en_bas_schedhistory_9', null)), m: document.getElementById('bas-msg-9').textContent }));
    ok(allBad.s === before && /Skipped 2 files: zero\.csv/.test(allBad.m) && /other\.csv/.test(allBad.m), 'only bad files: nothing saved, both named: ' + allBad.m);
    await page.evaluate(() => DB.set('en_bas_schedhistory_9', null));
    await page.setInputFiles('#bas-bfile-9', [{ name: 'zero.csv', mimeType: 'text/csv', buffer: Buffer.from('') }, { name: 'sp.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }]);
    await page.waitForFunction(() => /Saved the baseline/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    const mixed = await page.evaluate(() => ({ rec: DB.get('en_bas_schedhistory_9', null), m: document.getElementById('bas-msg-9').textContent }));
    ok(/Skipped 1 file: zero\.csv/.test(mixed.m), 'good + 0-byte pick: the good file imports and the bad file is named: ' + mixed.m);
    eq(mixed.rec, m1.rec, 'the record after a mixed pick equals the record of the good file alone');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL ' + e.message);
  process.exit(1);
});
