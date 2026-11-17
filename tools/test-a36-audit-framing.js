// tools/test-a36-audit-framing.js - the base Audit Report is a full building automation system audit; ASHRAE 36 is one selectable section.
// SYNTHETIC project (fake names), headless bundled Chromium (never Edge). Run: CH_TMP_ROOT=<scratch> node tools/test-a36-audit-framing.js
//   1. With the "ASHRAE 36 Sequences" section off, no word "ASHRAE" or "Guideline" and no readiness score or table prints (Simple and Detailed).
//   2. With it on, the scores, the Building Readiness table and the per-building devices and sequences tables print inside that section only.
//   3. The cover has no "Report date" and no date line.
//   4. A per-building page has the library front photo, the equipment audited (an exhaust fan too) and the findings count.
//   5. No finding heading reads "Finding N:"; the headings use the section number (2.3.1) and a plain sentence.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('a36-audit-framing');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- synthetic project: two libraries, fake names ----
    const seed = await page.evaluate(async () => {
      const PID = 900001;
      const pts = (extra) => Object.assign({}, extra);
      const ahu = (id, b, name, p) => ({ id, building: b, category: 'ahu', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const vav = (id, b, name, p) => ({ id, building: b, category: 'vav', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const full = { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F', 'Duct Static Pressure': '1.1 in H2O', 'Outside Air Temp': '61 °F' };
      const noRat = { 'Supply Air Temp': '56.0 °F', 'Duct Static Pressure': '1.0 in H2O' };
      const zone = { 'Zone Temp': '72.4 °F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const rows = [
        ahu('r1', 'Alpha Library', 'AHU-1', pts(Object.assign({}, full, { 'Demand Level': '0.0', 'Heat Source Supply': '167.0' }))),
        ahu('r2', 'Alpha Library', 'AHU-2', pts(noRat)),
        vav('r3', 'Alpha Library', 'VAV-101', pts(zone)),
        vav('r4', 'Alpha Library', 'VAV-102', pts(zone)),
        vav('r5', 'Alpha Library', 'VAV-103', pts({ 'Zone Temp': '71.9 °F' })),
        { id: 'r6', building: 'Alpha Library', category: 'ef', equipName: 'EF-1', location: '', points: { 'Fan Status': 'On' } },
        ahu('r7', 'Beta Library', 'AHU-3', pts(full)),
        vav('r8', 'Beta Library', 'VAV-201', pts(zone)),
      ];
      const occ = (a, b, sm, em) => ({ startMin: sm, stopMin: em, startStr: '', stopStr: '', rawText: 'Unoccupied from 12:00 AM to ' + a + '\nOccupied from ' + a + ' to ' + b + '\nUnoccupied from ' + b + ' to 12:00 AM' });
      rows[2].existingSchedule = occ('6:00 AM', '9:00 PM', 360, 1260);
      rows[3].existingSchedule = occ('7:00 AM', '6:00 PM', 420, 1080);
      rows[7].existingSchedule = { startMin: 0, stopMin: 0, startStr: '0:00', stopStr: '0:00', rawText: 'Occupied from 12:00 AM to 12:00 AM' }; // BAS all-day schedule: start 0, stop 0
      rows[4].existingSchedule = { rawText: 'Unoccupied from 12:00 AM to 12:00 AM' }; // no occupied period: not counted
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, {
        findings: [
          { id: 'u1', rowId: 'r1', building: 'Alpha Library', equipment: 'AHU-1', type: 'AHU', issueType: 'Deficiency', issue: 'Fan runs at night', change: 'Add an occupancy schedule', how: '', picture: '', pictureLink: '', notes: '', needsMod: '', measureId: null, hours: 4, cost: 900, status: 'Open', deficiency: true, cscList: false },
        ],
        edits: {},
        evidence: {},
      });
      return PID;
    });

    const variants = {
      simple_off: { cover: true, executive: true, costEstimate: false, building: true, setpointReview: true, pointInventory: true },
      simple_on: { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true },
      det_off: { cover: true, executive: true, costEstimate: false, building: true, setpointReview: true, detailed: true },
      det_on: { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, detailed: true },
    };
    const out = {};
    for (const k of Object.keys(variants)) {
      out[k] = await page.evaluate(({ PID, sel }) => {
        const data = collectASHRAE36Data(PID, '2026-11-10', null);
        const cv = document.createElement('canvas');
        cv.width = 1248;
        cv.height = 672;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#6a8';
        cx.fillRect(0, 0, 1248, 672);
        const url = cv.toDataURL('image/jpeg', 0.5);
        data._a36LibraryPhotos = { 'Alpha Library': { url: url, w: 1248, h: 672 }, 'Beta Library': { url: url, w: 1248, h: 672 } };
        const html = generateASHRAE36AuditHTML(data, sel);
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        return Array.from(doc.querySelectorAll('.rpt-page')).map((p) => ({
          section: p.getAttribute('data-section'),
          text: p.textContent.replace(/\s+/g, ' '),
          photos: Array.from(p.querySelectorAll('img[alt^="Photo of"]')).map((i) => i.alt),
          h1: Array.from(p.querySelectorAll('h1')).map((h) => h.textContent.trim()),
        }));
      }, { PID: seed, sel: variants[k] });
    }
    const all = (k) => out[k].map((p) => p.text).join(' ');
    const base = (k) => out[k].filter((p) => p.section !== 'costEstimate').map((p) => p.text).join(' ');
    const a36 = (k) => out[k].filter((p) => p.section === 'costEstimate').map((p) => p.text).join(' ');

    ['simple_off', 'det_off'].forEach((k) => {
      ok(!/ASHRAE|Guideline|A36/.test(all(k)), k + ': the A36 section is off, so the report has no ASHRAE, Guideline or A36 text');
      ok(!/Overall Score|Sensor Coverage|Sequence Readiness|Devices to Install|Sequences to Program|Building Readiness/.test(all(k)), k + ': no readiness score, gap table or devices to install table prints');
    });
    ['simple_on', 'det_on'].forEach((k) => {
      ok(/ASHRAE 36/.test(a36(k)) && /Overall Score/.test(a36(k)) && /Sensor Coverage/.test(a36(k)) && /Sequence Readiness/.test(a36(k)), k + ': the A36 section holds the Overall Score, Sensor Coverage and Sequence Readiness');
      ok(/Building Readiness/.test(a36(k)) && /Devices to Install/.test(a36(k)) && /Sequences to Program/.test(a36(k)), k + ': the A36 section holds the Building Readiness table and the per-building devices to install and sequences to program tables');
      ok(!/ASHRAE|Guideline|Overall Score|Sensor Coverage|Sequence Readiness|Devices to Install/.test(base(k)), k + ': outside the A36 section there is no ASHRAE text and no score');
    });

    ['simple_off', 'simple_on', 'det_off', 'det_on'].forEach((k) => {
      const cover = out[k][0];
      ok(cover && !/Report date/i.test(cover.text) && !/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/.test(cover.text), k + ': the cover has no Report date and no date line');
      ok(/Audit Report/.test(cover.text) && /in 2 buildings/.test(cover.text) && /recorded \d+ findings?/.test(cover.text) && /Equipment Units/.test(cover.text) && !/Across /.test(cover.text), k + ': the cover states units, buildings and findings plainly and has the building table; no "Across" sentence; the equipment types and the findings count');
      const bp = out[k].filter((p) => p.section === 'building');
      ok(bp.length >= 2, k + ': the base Per-Building Detail pages print (' + bp.length + ')');
      ['Alpha Library', 'Beta Library'].forEach((n) => ok(bp.some((p) => p.photos.indexOf('Photo of ' + n) >= 0), k + ': the per-building page of ' + n + ' has the library front photo'));
      const alpha = bp.filter((p) => /Alpha Library/.test(p.text)).map((p) => p.text).join(' ');
      ok(/Exhaust Fan/.test(alpha) && /Air Handlers/.test(alpha) && /Variable Air Volume/.test(alpha) && /\d+ findings/.test(alpha) && !/None needed|No ASHRAE 36 sequence applies/.test(alpha), k + ': the per-building page lists every audited equipment type (exhaust fan too) and the findings count, with no "None needed"');
      ok(!/Finding \d+:/.test(all(k)), k + ': no "Finding N:" heading anywhere');
    });
    ok(/\d+\.3\.1 [A-Z]/.test(all('det_off')) && !/Finding \d+/.test(all('det_off')), 'det_off: the findings of a library chapter are numbered with the section number (N.3.1) and a one-sentence headline');
    ok(!/ASHRAE 36, Section/.test(all('det_off')) && !/ASHRAE 36, Section/.test(base('det_on')), 'no "ASHRAE 36, Section x" citation in the base report');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
