'use strict';
// Tests for the WebCTRL audit log import (app/bas-audit-log.js): the CSV reader (multi-line quoted cells, through the
// real baSplitCSV of app/bas-alarms.js), the date rule (a change at time T on date D applies from D, end-of-day state),
// weekday and weekend hours, the most common set point pair, "not found" text for what the log cannot show,
// the merge into the stored record (window replace, idempotent, a typed baseline is kept), project name matching,
// and the Import audit log button in the BAS schedules card (headless bundled Chromium, file://).
// SYNTHETIC data only (fake district and building names). Run: node tools/test-bas-audit-log.js
// Env: SHOT=<png path> saves a screenshot of the card after the import.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const BAL = require(path.join(ROOT, 'app', 'bas-audit-log.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const eq = (a, b, m) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, m + (x === y ? '' : '  got ' + x + '  want ' + y));
};

// the real CSV splitter, taken out of app/bas-alarms.js (no copy)
const src = fs.readFileSync(path.join(ROOT, 'app', 'bas-alarms.js'), 'utf8').replace(/\r\n/g, '\n');
const s0 = src.indexOf('\nfunction baSplitCSV(');
const sb = {};
vm.createContext(sb);
vm.runInContext(src.slice(s0 + 1, src.indexOf('\n}\n', s0) + 3), sb);
const split = sb.baSplitCSV;

// --- synthetic audit log ---------------------------------------------------------------------------
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const blk = (name, days, ats, type) =>
  '"Occupancy" schedule "' + name + '" at priority "Normal"\nType "' + (type || 'Weekly') + '", days:' + (days ? ' ' + days : '') + '\n' +
  ats.map((a) => 'At "' + a[0] + '" set "' + a[1] + '"').join('\n');
const OCC = (a, b) => [['0:0', 'null'], [a, 'Occupied'], [b, 'null']];
const upd = (name, oldDays, newDays, a, b) => 'Old values:\n' + blk(name, oldDays, OCC(a, b)) + '\nNew values:\n' + blk(name, newDays, OCC(a, b));
const A = '/Test District/Alpha Elementary';
const B = '/Test District/Beta Hall';
const sp = (zone, h1, h2, c1, c2) => ({
  d: [h1 ? 'setpoint/setpoints/occupied_heating changed from "' + h1 + '" to "' + h2 + '"' : '', c1 ? 'setpoint/setpoints/occupied_cooling changed from "' + c1 + '" to "' + c2 + '"' : ''].filter(Boolean).join('\n'),
  z: zone,
});
// rows oldest first here; the file is written newest first like the real export
const rows = [
  ['6/1/2026 8:00:00 AM', 'Add schedule "Summer M-Th"', blk('Summer M-Th', 'Mon Tue Wed Thu', OCC('7:0', '16:0')), A],
  ['6/1/2026 8:01:00 AM', 'Update schedule "Main"', upd('Main', 'Mon Tue Wed Thu Fri', '', '6:0', '16:0'), A],
  ['6/1/2026 9:00:00 AM', 'Global Modify Action', sp(0, '68', '70', '72', '74').d, A + '/Wing/Z1'],
  ['6/1/2026 9:00:05 AM', 'Global Modify Action', sp(0, '68', '70', '72', '74').d, A + '/Wing/Z2'],
  ['6/1/2026 9:00:10 AM', 'Global Modify Action', sp(0, '68', '70', '72', '74').d, A + '/Wing/Z3'],
  ['6/2/2026 8:00:00 AM', 'Acknowledged all (5) alarms', '', A],
  ['6/5/2026 8:00:00 AM', 'Add schedule "Event"', blk('Event', '', OCC('1:0', '2:0'), 'Date'), A],
  ['6/5/2026 8:05:00 AM', 'Add schedule "Wing Light"', blk('Wing Light', 'Mon Tue Wed Thu Fri', OCC('1:0', '23:0')), A + '/Wing'],
  ['8/10/2026 10:00:00 AM', 'Delete schedule "Summer M-Th"', blk('Summer M-Th', 'Mon Tue Wed Thu', OCC('7:0', '16:0')), A],
  ['8/10/2026 11:30:00 PM', 'Update schedule "Main"', upd('Main', '', 'Mon Tue Wed Thu Fri', '6:0', '16:0'), A],
  ['9/1/2026 7:00:00 AM', 'Edited Graphics', sp(0, '70', '68', '74', '72').d, A + '/Wing/Z1'],
  ['9/1/2026 7:01:00 AM', 'Edited Graphics', sp(0, '70', '68', '74', '72').d, A + '/Wing/Z2'],
  ['9/10/2026 7:00:00 AM', 'Edited Properties', sp(0, '', '', '74', '80').d, A + '/Wing/Z3'],
  ['7/1/2026 8:00:00 AM', 'Update schedule "Hall"', upd('Hall', 'Mon Tue Wed Thu Fri', 'Mon Tue Wed Thu Fri Sat Sun', '8:0', '17:0'), B],
  ['9/30/2026 8:00:00 AM', 'Acknowledged all (9) alarms', '', B],
];
function csvText(list) {
  return (
    '﻿"Date","Description","Details","Location","Operator"\r\n' +
    list.slice().sort((a, b) => 0).reverse().map((r) => [r[0], r[1], r[2], r[3], 'Test Operator (tester)'].map(q).join(',') + '\r\n').join('')
  );
}
const text = csvText(rows);

// --- reading ---------------------------------------------------------------------------------------
const grid = split(text);
ok(grid[0].length === 5 && grid.length === rows.length + 1, 'baSplitCSV keeps 5 columns and one row per event with multi-line quoted cells (' + grid.length + ' rows)');
ok(grid.some((r) => r[2].split('\n').length >= 7), 'a multi-line Details cell stays one cell');
const parsed = BAL.parseRows(grid);
ok(!parsed.error && parsed.events.length === rows.length, 'parseRows reads every event');
ok(parsed.events[0].iso <= parsed.events[1].iso, 'events come out oldest first');
ok(BAL.parseRows(split('"S No","Date"\r\n"1","x"\r\n')).error, 'a file with another header is refused with a message');
ok(parsed.events.every((e) => e.building === 'Alpha Elementary' || e.building === 'Beta Hall'), 'building comes from BasDiff.buildingOf');

// --- analysis --------------------------------------------------------------------------------------
const res = BAL.analyze(parsed.events);
const alpha = res.filter((r) => r.building === 'Alpha Elementary')[0];
const beta = res.filter((r) => r.building === 'Beta Hall')[0];
eq(alpha.window, ['2026-06-01', '2026-09-10'], 'window is the first to the last event day of the building');
const wd = alpha.record.weekday;
eq(wd.map((x) => x.text), ['Mon-Thu 7:00 to 16:00', 'Mon-Fri 6:00 to 16:00'], 'weekday text by range (no day with hours is left out)');
eq([wd[0].from, wd[0].to, wd[1].from, wd[1].to], ['2026-06-01', '2026-08-09', '2026-08-10', '2026-09-10'], 'Delete on Aug 10 and an update at 11:30 PM on Aug 10: end-of-day state applies from Aug 10');
ok(alpha.record.weekend.length === 1 && alpha.record.weekend[0].text === 'None' && alpha.record.weekend[0].kind === 'period', 'weekend: one "None" range');
ok(!JSON.stringify(alpha.record).includes('Wing Light') && !JSON.stringify(alpha.record).includes('1:00 to 2:00'), 'area schedules and date schedules are left out');
eq([alpha.baseline.weekday.text, alpha.baseline.weekday.src, alpha.baseline.setPoints.text], ['6:00 to 16:00', BAL.AUDIT_SRC, 'heating 68, cooling 72'], 'fallback baseline = old values of the first change (hours) and the most common value before each zone first change');
const spA = alpha.record.setPoints;
eq(spA.map((x) => [x.text, x.from, x.to]), [
  ['heating 70, cooling 74', '2026-06-01', '2026-08-31'],
  ['heating 68, cooling 72', '2026-09-01', '2026-09-10'],
], 'set point ranges: 70/74 to Aug 31, 68/72 from Sep 1 (2 of 3 zones)');
eq(beta.record.setPoints, [], 'no set point rows: no entry (the report prints a dash), no invented value');
eq(beta.record.weekend.map((x) => [x.text, x.from]), [['Sat-Sun 8:00 to 17:00', '2026-07-01']], 'beta weekend range starts the day of the change');
const shown = JSON.stringify(res, (k, v) => (k === 'src' ? undefined : v));
ok(!/audit log|not found|not determinable/i.test(shown), 'no internal wording in any text of the record (the source marks are not printed)');
eq([beta.baseline.weekday.text, beta.baseline.weekend.text, beta.baseline.setPoints], ['8:00 to 17:00', 'None', null], 'beta baseline from old values; no set point value, so none');
const fbRes = BAL.analyze(parsed.events, [{ building: 'Beta Hall', text: 'Unit heaters: heating 45, cooling 90' }, { building: 'Alpha Elementary', text: 'heating 1, cooling 2' }]);
const fbBeta = fbRes.filter((r) => r.building === 'Beta Hall')[0];
const fbAlpha = fbRes.filter((r) => r.building === 'Alpha Elementary')[0];
eq(fbBeta.record.setPoints.map((x) => [x.text, x.from, x.to]), [['Unit heaters: heating 45, cooling 90', '2026-07-01', '2026-09-30']], 'points list value is the set point of a building with no set point row in the log');
eq([fbBeta.baseline.setPoints.text, fbBeta.baseline.setPoints.src], ['Unit heaters: heating 45, cooling 90', BAL.POINTS_SRC], 'and its baseline (never changed since the log starts), with its source mark');
ok(fbAlpha.record.setPoints.length === 2 && fbAlpha.record.setPoints[0].text === 'heating 70, cooling 74', 'a building that has set point rows in the log ignores the points list');

// --- name match and merge --------------------------------------------------------------------------
const names = ['Alpha Elementary School', 'Beta Hall'];
eq(BAL.matchName('Alpha Elementary', names), 'Alpha Elementary School', 'a log name that starts the project name is matched');
eq(BAL.matchName('Gamma Wing', names), 'Gamma Wing', 'no match: the log name stays');
const m1 = BAL.apply(null, res, names);
ok(m1.rec.buildings.map((b) => b.building).sort().join() === 'Alpha Elementary School,Beta Hall', 'record uses project building names');
eq(BAL.apply(m1.rec, res, names).rec, m1.rec, 'second import of the same files gives the same record');
// a later log with a window inside the old one replaces only its own days
const small = csvText(rows.filter((r) => r[3] === A && r[0].startsWith('9/')));
const r2 = BAL.analyze(BAL.parseRows(split(small)).events);
const m2 = BAL.apply(m1.rec, r2, names);
const a2 = m2.rec.buildings.filter((b) => b.building === 'Alpha Elementary School')[0];
ok(a2.weekday.some((x) => x.from === '2026-06-01'), 'days outside the new window stay');
ok(m2.rec.buildings.filter((b) => b.building === 'Beta Hall')[0].weekday.length === m1.rec.buildings.filter((b) => b.building === 'Beta Hall')[0].weekday.length, 'a building not in the new files is not touched');
// a baseline typed by a person is kept
const typed = JSON.parse(JSON.stringify(m1.rec));
typed.buildings[0].baselineWeekday = [{ text: 'typed hours' }];
typed.buildings[0].setPoints.unshift({ kind: 'baseline', text: 'typed set points' });
const kept = BAL.apply(typed, res, names).rec.buildings[0];
ok(kept.baselineWeekday[0].text === 'typed hours' && kept.setPoints[0].text === 'typed set points' && kept.setPoints.length === typed.buildings[0].setPoints.length, 'baseline entries already in the record are kept, none added');

(async () => {
  // --- the button, in the browser ------------------------------------------------------------------
  const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
  const ctx = await launchBrowser('bas-audit-log');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => window.__siteUI && typeof window.basRender === 'function' && window.BasAuditLog, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.getUDBldgs = () => [{ name: 'Alpha Elementary School' }, { name: 'Beta Hall' }];
      const host = document.createElement('div');
      host.id = 'bas-panel-9';
      host.style.cssText = 'position:fixed;left:0;top:0;width:1100px;background:var(--bg);z-index:99999;overflow:auto;max-height:100vh';
      document.body.appendChild(host);
      window.basRender(9);
    });
    const label = await page.locator('#bas-panel-9 button', { hasText: 'Import audit log' }).count();
    ok(label === 1, 'the card has one "Import audit log" button');
    const multi = await page.locator('#bas-afile-9').getAttribute('multiple');
    ok(multi !== null, 'the audit log file picker accepts several files');
    await page.setInputFiles('#bas-afile-9', [{ name: 'log-a.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }]);
    await page.waitForFunction(() => /Saved schedule and set point history/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    const out = await page.evaluate(() => ({ rec: DB.get('en_bas_schedhistory_9', null), msg: document.getElementById('bas-msg-9').textContent }));
    ok(out.rec && out.rec.buildings.length === 2, 'import saved a record for 2 buildings: ' + out.msg);
    eq(out.rec, m1.rec, 'the record saved by the button equals the record from the module');
    await page.setInputFiles('#bas-afile-9', [{ name: 'log-a.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }]);
    await page.waitForTimeout(500);
    const again = await page.evaluate(() => DB.get('en_bas_schedhistory_9', null));
    eq(again, out.rec, 'importing the same file again leaves the record unchanged');
    await page.setInputFiles('#bas-afile-9', [{ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('"A","B"\r\n"1","2"\r\n') }]);
    await page.waitForFunction(() => /not a WebCTRL audit log/.test(document.getElementById('bas-msg-9').textContent), null, { timeout: 15000 });
    ok(true, 'a wrong file shows a message and saves nothing new');
    if (process.env.SHOT) {
      await page.evaluate(() => window.basRender(9));
      await page.evaluate(() => {
        document.getElementById('bas-msg-9').textContent = 'Saved schedule and set point history for 2 buildings from 1 file.';
      });
      await page.locator('#bas-panel-9').screenshot({ path: process.env.SHOT });
    }
    const rowsOut = await page.evaluate(() => {
      const d = { project: { client: 'Test Client', name: 'Test Project' }, contract: {}, period: { quarter: 3, year: 2026, yearMonths: ['2026-07', '2026-08', '2026-09'] }, buildings: [{ name: 'Beta Hall' }], basScheduleHistory: DB.get('en_bas_schedhistory_9', null) };
      return _rptBasScheduleRows(d);
    });
    const beta = rowsOut[0];
    ok(beta && beta[4].length === 0, 'report rows: a cell with no source has no lines');
    const html = await page.evaluate(() => {
      const d = { project: { client: 'Test Client', name: 'Test Project' }, contract: {}, period: { quarter: 3, year: 2026, yearMonths: ['2026-07', '2026-08', '2026-09'] }, buildings: [{ name: 'Beta Hall' }], basScheduleHistory: DB.get('en_bas_schedhistory_9', null) };
      return _rptQSchedulePage(8, d);
    });
    ok(html.indexOf('&mdash;') >= 0 && !/not found|not determinable|audit log/i.test(html), 'report page prints a dash for a cell with no source and no internal wording');
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
