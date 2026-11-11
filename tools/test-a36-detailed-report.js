// tools/test-a36-detailed-report.js - the Detailed style of the ASHRAE 36 Audit Report. SYNTHETIC project, headless bundled Chromium.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-detailed-report.js
// Optional: A36_SIMPLE_DUMP=<file> writes the Simple report HTML of the synthetic project (to compare before and after a change).
//   1. Picture list CSV import: columns found by name, rows whose disposition starts "Not used" skipped, a byte order mark is ignored.
//   2. The Report Style radio is in the audit modal (not the proposal modal); Detailed shows the picture folder picker.
//   3. Detailed adds Cover, Executive Summary, Sequences, one chapter per library, Appendix A and B; Per-Building Detail pages are gone.
//   4. A chapter has System Overview, Equipment Descriptions, Findings, Recommended Work; the quantities add up to the equipment rows.
//   5. Figures: numbers run 1..N in page order, the pictures are JPEG data: URLs at most 1000 px wide, the caption names the equipment.
//   6. No price and no hours text in the Detailed chapters.
//   7. Every Detailed page fits the page (no body taller than its box); no table runs past its page.
//   8. No picture folder: the report is complete and has no figures.
//   9. Word: the figure pictures and captions are in the translated document.
//  10. Simple style: no Detailed page and no figure; same HTML as before (see A36_SIMPLE_DUMP).
//  11. D4: a heating hot water plant and a chilled water plant print in Detailed (overview, description, findings, no schedule finding); domestic hot water does not; Simple keeps the stored categories.
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('a36-detailed');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && typeof faParsePictureList === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

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

    // ---- 1. picture list CSV ----
    const csv =
      '﻿file,time,library,equipment_or_program,page_shown,cited_in_audit,disposition\n' +
      'syn-1.png,1,Alpha Library,AHU-1,graphic (air handler),Y,Cited in audit\n' +
      'syn-2.png,2,Alpha Library,AHU-1,properties: control program,N,Not cited: control program\n' +
      'syn-3.png,3,Alpha Library,VAV-101,graphic,Y,Cited in audit\n' +
      'syn-4.png,4,Beta Library,AHU-3,graphic,N,Not cited: supporting\n' +
      'syn-5.png,5,Beta Library,AHU-3,graphic,N,Not used: not a library\n';
    const parsed = await page.evaluate((t) => faParsePictureList(t), csv);
    ok(parsed.map && parsed.map.length === 4, 'picture list: 4 rows kept, the "Not used" row skipped (' + (parsed.map ? parsed.map.length : parsed.error) + ')');
    ok(parsed.map && parsed.map[0].file === 'syn-1.png' && parsed.map[0].building === 'Alpha Library' && parsed.map[0].equipName === 'AHU-1' && parsed.map[0].cited === true && parsed.map[1].cited === false, 'picture list: file, building, equipName, cited fields set');
    const bad = await page.evaluate(() => faParsePictureList('a,b\n1,2\n'));
    ok(!!bad.error, 'picture list without the needed columns gives an error');
    await page.evaluate(async ({ PID, map }) => {
      const d = faLoad(PID);
      d.pictureMap = map;
      await faSave(PID, d);
    }, { PID: seed, map: parsed.map });
    ok((await page.evaluate((PID) => faLoad(PID).pictureMap.length, seed)) === 4, 'picture list is stored in en_audit_<pid>.pictureMap');

    // ---- Simple report (also the "unchanged" evidence) ----
    const simple = await page.evaluate((PID) => {
      const data = collectASHRAE36Data(PID, '2026-11-10', null);
      return { html: generateASHRAE36AuditHTML(data, { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true }) };
    }, seed);
    if (process.env.A36_SIMPLE_DUMP) fs.writeFileSync(process.env.A36_SIMPLE_DUMP, simple.html);
    ok(simple.html.length > 1000 && !/data-section="detailedLibrary"/.test(simple.html) && !/Figure \d/.test(simple.html), 'Simple style: no Detailed page, no figure');
    ok(/Mon–Fri 12:00 AM–12:00 AM/.test(simple.html.replace(/<[^>]+>/g, '')) && !/24 hours/.test(simple.html), 'Simple style: the Setpoint Programming Review keeps its clock times (the 24 hours wording is Detailed only)');

    // ---- 2. modal ----
    const modal = await page.evaluate((PID) => {
      openASHRAE36ReportModal(PID, 'audit');
      const a = { radio: !!document.querySelector('input[name="a36Style"][value="detailed"]'), simpleChecked: document.querySelector('input[name="a36Style"][value="simple"]').checked, boxShown: document.getElementById('a36PictureBox').style.display !== 'none' };
      document.getElementById('ashrae36ReportModal').classList.remove('open');
      openASHRAE36ReportModal(PID, 'proposal');
      a.proposalRadio = !!document.querySelector('input[name="a36Style"]');
      document.getElementById('ashrae36ReportModal').classList.remove('open');
      return a;
    }, seed);
    ok(modal.radio && modal.simpleChecked && !modal.boxShown, 'audit modal: Report Style radio, Simple is the default, picture picker hidden');
    ok(!modal.proposalRadio, 'proposal modal: no Report Style radio');

    // ---- 2b. picture panel: visible only for Detailed; status text for an empty list, the list, and a chosen folder ----
    const panel = await page.evaluate(async (PID) => {
      const q = (id) => document.getElementById(id);
      const vis = () => q('a36PictureBox').style.display !== 'none';
      const pick = (names) => { const dt = new DataTransfer(); names.forEach((n) => dt.items.add(new File(['x'], n, { type: 'image/png' }))); q('a36PictureDir').files = dt.files; q('a36PictureDir').dispatchEvent(new Event('change')); };
      const radio = (v) => { document.querySelector('input[name="a36Style"][value="' + v + '"]').checked = true; _a36StyleChanged(); };
      const out = {};
      const saved = faLoad(PID).pictureMap;
      let d = faLoad(PID); d.pictureMap = []; await faSave(PID, d);
      openASHRAE36ReportModal(PID, 'audit');
      out.simpleHidden = !vis();
      radio('detailed');
      out.shownForDetailed = vis();
      out.title = q('a36PictureBox').textContent.indexOf('Add pictures to the report') >= 0;
      out.btn = q('a36PictureBtn').tagName === 'BUTTON' && q('a36PictureBtn').textContent === 'Choose picture folder' && q('a36PictureDir').type === 'file' && q('a36PictureDir').hasAttribute('webkitdirectory');
      out.emptyNote = q('a36PictureNoList').style.display !== 'none' && q('a36PictureNoList').textContent.indexOf('No picture list yet.') >= 0 && q('a36PictureCsvBtn').textContent === 'Import picture list (CSV)';
      // import the list from the panel, modal stays open
      const csv = 'file,library,equipment_or_program,page_shown,cited_in_audit,disposition\nsyn-1.png,Alpha Library,AHU-1,graphic,Y,Cited\nsyn-2.png,Alpha Library,AHU-1,graphic,N,Not cited\nsyn-3.png,Alpha Library,VAV-101,graphic,Y,Cited\nsyn-4.png,Beta Library,AHU-3,graphic,N,Not cited\n';
      const dt = new DataTransfer(); dt.items.add(new File([csv], 'list.csv', { type: 'text/csv' }));
      q('a36PictureCsv').files = dt.files;
      q('a36PictureCsv').dispatchEvent(new Event('change'));
      for (let i = 0; i < 50 && q('a36PictureStatus').textContent === ''; i++) await new Promise((r) => setTimeout(r, 100));
      out.afterImport = q('a36PictureStatus').textContent;
      out.noteGone = q('a36PictureNoList').style.display === 'none';
      out.modalOpen = document.getElementById('ashrae36ReportModal').classList.contains('open');
      pick(['syn-1.png', 'syn-3.png', 'other.png']);
      out.found = q('a36PictureStatus').textContent;
      pick(['other.png']);
      out.none = q('a36PictureStatus').textContent;
      radio('simple');
      out.hiddenAgain = !vis();
      document.getElementById('ashrae36ReportModal').classList.remove('open');
      d = faLoad(PID); d.pictureMap = saved; await faSave(PID, d);
      return out;
    }, seed);
    ok(panel.simpleHidden && panel.shownForDetailed && panel.hiddenAgain, 'picture panel: hidden for Simple, shown for Detailed, hidden again for Simple');
    ok(panel.title && panel.btn, 'picture panel: titled "Add pictures to the report", real button "Choose picture folder" for the folder input');
    ok(panel.emptyNote, 'empty list: panel says "No picture list yet." with an Import picture list (CSV) button');
    ok(panel.afterImport === '4 pictures in the picture list' && panel.noteGone && panel.modalOpen, 'import from the panel: status "' + panel.afterImport + '", modal still open');
    ok(panel.found === '2 of 4 pictures found in the folder', 'folder chosen: "' + panel.found + '"');
    ok(panel.none === 'No listed pictures found in this folder', 'no match: "' + panel.none + '"');

    // ---- make Detailed through the modal, with a picture folder ----
    async function makeDetailed(withFolder) {
      return page.evaluate(
        async ({ PID, withFolder }) => {
          openASHRAE36ReportModal(PID, 'audit');
          const det = document.querySelector('input[name="a36Style"][value="detailed"]');
          det.checked = true;
          _a36StyleChanged();
          const shown = document.getElementById('a36PictureBox').style.display !== 'none';
          if (withFolder) {
            const dt = new DataTransfer();
            const mk = (name, w, h, color) => {
              const cv = document.createElement('canvas');
              cv.width = w;
              cv.height = h;
              const c = cv.getContext('2d');
              c.fillStyle = color;
              c.fillRect(0, 0, w, h);
              c.fillStyle = '#fff';
              c.font = '80px sans-serif';
              c.fillText(name, 40, h / 2);
              return new Promise((res) => cv.toBlob((b) => res(new File([b], name, { type: 'image/png' })), 'image/png'));
            };
            dt.items.add(await mk('syn-1.png', 1600, 900, '#246'));
            dt.items.add(await mk('syn-2.png', 1200, 700, '#462'));
            dt.items.add(await mk('syn-3.png', 800, 600, '#624'));
            dt.items.add(await mk('syn-4.png', 800, 600, '#444'));
            dt.items.add(await mk('syn-5.png', 800, 600, '#888'));
            document.getElementById('a36PictureDir').files = dt.files;
          }
          generateASHRAE36Preview();
          for (let i = 0; i < 100 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 300));
          const pages = Array.from(document.querySelectorAll('#reportPages .rpt-page'));
          const sections = pages.map((p) => p.getAttribute('data-section'));
          const imgs = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"] img[alt^="Figure"]'));
          const figs = imgs.map((im) => im.parentElement.textContent.trim());
          const imgInfo = await Promise.all(imgs.map((im) => new Promise((res) => { const t = new Image(); t.onload = () => res({ src: im.src.slice(0, 22), w: t.naturalWidth }); t.onerror = () => res({ src: 'err', w: 0 }); t.src = im.src; })));
          const libText = pages.filter((p) => p.getAttribute('data-section') === 'detailedLibrary').map((p) => p.textContent).join('\n');
          const fit = pages.filter((p) => p.querySelector('.rpt-body')).map((p, i) => {
            const body = p.querySelector('.rpt-body');
            const foot = p.querySelector('.rpt-pg-footer');
            const bb = body.getBoundingClientRect();
            let maxBottom = 0;
            body.querySelectorAll('*').forEach((e) => { const b = e.getBoundingClientRect(); if (b.height > 0) maxBottom = Math.max(maxBottom, b.bottom); });
            return { i: i + 1, section: p.getAttribute('data-section'), over: Math.round(maxBottom - bb.bottom), scrollOver: body.scrollHeight - body.clientHeight, footGap: foot ? Math.round(foot.getBoundingClientRect().top - maxBottom) : null };
          });
          const text = pages.map((p) => p.textContent).join('\n');
          const hasOverlay = document.getElementById('reportOverlay').style.display;
          return { shown, sections, imgInfo, figs, libText, fit, text, hasOverlay, html: document.getElementById('reportPages').innerHTML.length };
        },
        { PID: seed, withFolder },
      );
    }

    const det = await makeDetailed(true);
    ok(det.shown, 'choosing Detailed shows the picture folder picker');
    const s = det.sections;
    const firstLib = s.indexOf('detailedLibrary');
    ok(s[0] === 'cover' && s.indexOf('executive') > 0 && s.indexOf('costEstimate') > s.indexOf('executive') && firstLib > s.indexOf('costEstimate'), 'order: cover, executive summary, sequences, then the library chapters (' + s.join(',') + ')');
    ok(s.indexOf('building') < 0, 'Detailed has no Per-Building Detail pages');
    ok(s.filter((x) => x === 'detailedLibrary').length >= 2, 'at least one chapter page per library (' + s.filter((x) => x === 'detailedLibrary').length + ' chapter pages)');
    ok(s.indexOf('detailedAppendixA') < 0 && s.indexOf('pointInventory') > s.lastIndexOf('detailedLibrary'), 'a short Appendix A shares the first page of Appendix B (no page of its own); Appendix B follows the chapters');
    ok(/Appendix A: Deficiency List/.test(det.text) && /Fan runs at night/.test(det.text) && /Appendix B: Point Inventory/.test(det.text), 'Appendix A lists the deficiency, Appendix B has its heading');
    ok(det.text.indexOf('Appendix A: Deficiency List') < det.text.indexOf('Appendix B: Point Inventory'), 'Appendix A comes before Appendix B on that page');
    ok(s.indexOf('setpointReview') > s.indexOf('pointInventory') && /Appendix C: Setpoint Programming Review/.test(det.text), 'Appendix C prints last when zone set point data exists (Detailed turns the review on by itself)');
    const t = det.libText;
    ['Alpha Library: System Overview', 'Beta Library: System Overview', 'Equipment Descriptions', 'Findings', 'Alpha Library: Recommended Work', 'Beta Library: Recommended Work', 'Missing against ASHRAE 36'].forEach((x) => ok(t.indexOf(x) >= 0, 'chapters contain "' + x + '"'));
    ok(/Air Handling Unit[^\n]*2/.test(t) || /Air Handling Unit.{0,40}2/.test(t), 'System Overview counts the 2 air handling units of Alpha Library');
    ok(/Total\s*6/.test(t) && /Total\s*2/.test(t), 'System Overview totals: Alpha Library 6, Beta Library 2');
    ok(/Building automation controller: Sample Controller \(5 of 6 units\)/.test(t), 'BAS controller line from the rows (5 of 6 units in Alpha Library: the exhaust fan row has none)');
    ok(/Readings at the time of the audit on AHU-1: .*55\.2°F/.test(t), 'Equipment Descriptions: readings from the row data, temperature as 55.2°F');
    ok(!/\d ?F\b/.test(t.replace(/°F/g, '')), 'D2: no temperature prints as "<n> F" (every temperature has °F)');
    ok(/VAV[^\n]*Occupied schedule: 6:00 AM-9:00 PM \(1 unit\), 7:00 AM-6:00 PM \(1 unit\)\./.test(t), 'Equipment Descriptions: occupied schedule line lists each distinct schedule with its unit count');
    ok((t.match(/Occupied schedule:/g) || []).length === 2, 'groups with no schedule print nothing about schedules (one schedule line per group that has one: 2)');
    ok(/Occupied schedule: 24 hours\./.test(t) && !/12:00 AM-12:00 AM/.test(t), 'D8: an all-day schedule (start 0, stop 0) prints "24 hours", never 12:00 AM-12:00 AM');
    ok(/Beta Library[\s\S]{0,40}Mon–Fri 24 hours/.test(det.text.slice(det.text.indexOf('Appendix C: Setpoint Programming Review'))), 'D8: Appendix C prints the all-day schedule of Beta Library as "Mon–Fri 24 hours"');
    ok(!/Demand Level 0/.test(t) && /Readings at the time of the audit on AHU-1: .*Heat Source Supply Temperature/.test(t), 'a coded reading (Demand Level 0.0) is left out while the other readings stay');
    ok(/Heat Source Supply Temperature 167\.0°F/.test(t), 'a bare temperature reading gets °F');
    const rv = await page.evaluate(() => ['Supply Air Temperature|55.2', 'Airflow Setpoint|580.0', 'Air Source Mode|2.0', 'Duct Static Pressure|1.1 in H2O', 'Fan Status|On', 'Zone Status|?'].map((x) => String(_a36DetReadingValue(x.split('|')[0], x.split('|')[1]))));
    ok(rv.join(' / ') === '55.2°F / null / null / 1.1 in H2O / On / null', 'reading rule: temperature gets °F; bare airflow set point and mode codes dropped; units and words kept (' + rv.join(' / ') + ')');
    const u = await page.evaluate(() => ({
      rd: [['Mixed Air Temperature', '72.3 F'], ['Zone Air Temperature', '69.7 °F'], ['Outdoor Air Temperature', '64.5°F'], ['Heating Valve', '0.0 %'], ['CO2', '574.8 ppm'], ['Zone Temp', '70']].map((x) => _a36DetReadingValue(x[0], x[1])),
      names: ['Adult Area | VAV-1-21', 'Meeting Room 009| VRF-02', 'VRF Condenser| HP-1', 'AHU-1 - BVL', '| X', ''].map(_a36DetEquipName),
      norm: _a36DetNorm('Hot Water System -  BVL') === _a36DetNorm(' hot water system - bvl '),
      cap: [_a36DetCaptionPage('properties: control program tab, top (control program ata29_ddzs_ds_bvl)'), _a36DetCaptionPage('schedules: view all'), _a36DetCaptionPage('graphic (VAV box)')],
      sched: [_a36DetScheduleBlock('12:00 AM-12:00 AM'), _a36DetScheduleBlock('6:00 AM-9:00 PM')],
    }));
    ok(u.rd.join(' / ') === '72.3°F / 69.7°F / 64.5°F / 0.0% / 574.8 ppm / 70°F', 'D2: one reading formatter: ' + u.rd.join(' / '));
    ok(u.names.join(' / ') === 'VAV-1-21 (Adult Area) / VRF-02 (Meeting Room 009) / HP-1 (VRF Condenser) / AHU-1 - BVL / | X / ', 'D3: "Room | TAG" prints as "TAG (Room)": ' + u.names.join(' / '));
    ok(u.norm, 'D5: picture names match with case and runs of spaces ignored');
    ok(u.cap.join(' / ') === 'Properties: control program tab, top (control program) / Schedules: view all / Graphic (VAV box)', 'D11: captions drop program identifiers and start with a capital: ' + u.cap.join(' / '));
    ok(u.sched.join(' / ') === '24 hours / 6:00 AM-9:00 PM', 'D8: schedule block helper');
    const n2 = await page.evaluate(() => [['Supply Air Temperature', '117.5625 F'], ['Fan Current', '0.0625 A'], ['Damper', '49.375%'], ['CO2', '513.1875 ppm'], ['Humidity', '60.9375 %rh'], ['Zone Temp', '68.4375'], ['Count', '12 units'], ['Building Static Pressure', '-0.004 in H2O'], ['Valve', '0.0 %'], ['Duct Static', '1.1 in H2O']].map((x) => _a36DetReadingValue(x[0], x[1])));
    ok(n2.join(' / ') === '117.6°F / 0.06 A / 49.4% / 513.2 ppm / 60.9% / 68.4°F / 12 units / 0.00 in H2O / 0.0% / 1.1 in H2O', 'N2/N4: 1 decimal from 1 up, 2 below 1, never more than the source, no negative zero; %rh prints "%": ' + n2.join(' / '));
    const n1 = await page.evaluate(() => _a36DetListToks(['a', 'b', 'c', 'd', 'e', 'f']).map((t) => (/margin:0 0 (\d+)px 0/.exec(t.html) || [])[1]));
    ok(n1.join(',') === '0,4', 'N1: the bullet blocks of one list have no gap between them, only below the last block (' + n1.join(',') + ')');
    ok(!/\)s\b|Airs\b|Resets\b/.test(t) && !/\| ?(VAV|AHU|FPB|VRF)/.test(t), 'D1/D3: no double plural ("(Zone Terminals)s"), no raw "Room | TAG" name in the chapters');
    const recEq = await page.evaluate(() => {
      const libs = {};
      let lib = null;
      Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"]')).forEach((pg) => {
        pg.querySelectorAll('h2, table tr').forEach((el) => {
          if (el.tagName === 'H2') {
            const m = /^(.*): (System Overview|Recommended Work)$/.exec(el.textContent.trim());
            if (m) lib = m[1];
            return;
          }
          if (!lib) return;
          const c = el.querySelectorAll('td');
          if (c.length === 2 && !/^Total/.test(c[0].textContent)) (libs[lib + '|type'] = libs[lib + '|type'] || []).push(c[0].textContent.trim());
          if (c.length === 3 && /^(Install sensor|Program sequence)/.test(c[2].textContent)) (libs[lib + '|rec'] = libs[lib + '|rec'] || []).push(c[1].textContent.trim());
        });
      });
      const bad = [];
      let n = 0;
      Object.keys(libs).filter((k) => /\|rec$/.test(k)).forEach((k) => libs[k].forEach((e) => {
        n++;
        if (!e || !e.split(', ').every((x) => x === 'Building-wide' || (libs[k.replace('|rec', '|type')] || []).indexOf(x) >= 0)) bad.push(k + ': ' + e);
      }));
      return { bad, n };
    });
    ok(recEq.n > 0 && recEq.bad.length === 0, 'D1: every Recommended Work Equipment cell (' + recEq.n + ' rows) is made of System Overview type names of that library (or Building-wide)' + (recEq.bad.length ? ': ' + JSON.stringify(recEq.bad) : ''));
    ok(!/\$|\bhours?\b|\bprice\b|\bcost\b/i.test(t.replace(/24 hours/g, '')), 'no price, no hours, no cost text in the Detailed chapters');
    ok(!/metered kW|Next Steps/i.test(t), 'no "metered kW", no Next Steps');

    // figures
    const nums = (det.figs.join('\n').match(/Figure (\d+):/g) || []).map((x) => parseInt(x.replace(/\D/g, ''), 10));
    ok(nums.length === 4 && nums.every((v, i) => v === i + 1), 'figure numbers run 1..N in page order (' + nums.join(',') + ')');
    ok(det.imgInfo.length === 4 && det.imgInfo.every((i) => i.src === 'data:image/jpeg;base64,'.slice(0, 22) && i.w > 0 && i.w <= 1000), 'figures are JPEG data: URLs at most 1000 px wide (' + det.imgInfo.map((i) => i.w).join(',') + ')');
    ok(det.figs.some((f) => /Figure \d+: AHU-1, Graphic \(air handler\)/.test(f)), 'caption names the equipment and the page shown');
    ok(!/syn-5/.test(det.text) && det.figs.length === 4, 'the skipped "Not used" picture is not used');
    ok(det.figs.filter((f) => /AHU-1/.test(f)).length === 2 && det.figs.filter((f) => /VAV-101/.test(f)).length === 1 && det.figs.filter((f) => /AHU-3/.test(f)).length === 1, 'at most 2 figures per equipment group, from that group equipment');
    ok(/Figure 1: AHU-1, Graphic \(air handler\)/.test(det.figs[0]), 'cited picture comes first');
    ok(/Pictures: Figure 1, Figure 2\./.test(t) && /Picture: Figure 3\./.test(t) && /Picture: Figure 4\./.test(t), 'D6: each group that has pictures cites them by figure number in its findings');
    ok(!/\(1 of 1 unit\)/.test(t) && !/\((\d+) of \1 units\)/.test(t.replace(/Building automation controller[^\n]*/g, '')), 'D6: no "(N of N units)" noise in the findings');

    // fit
    const bad2 = det.fit.filter((f) => f.over > 1 || f.scrollOver > 1);
    ok(bad2.length === 0, 'every page body fits its box' + (bad2.length ? ': ' + JSON.stringify(bad2) : ''));
    const near = det.fit.filter((f) => f.footGap !== null && f.footGap < 0 && (f.section === 'detailedLibrary' || f.section === 'detailedAppendixA'));
    ok(near.length === 0, 'chapter and appendix text stays above the footer' + (near.length ? ': ' + JSON.stringify(near) : ''));
    const appB = det.fit.filter((f) => f.section === 'pointInventory');
    ok(appB.every((f) => f.over <= 1 && f.scrollOver <= 1), 'Appendix B pages fit with the added heading' + JSON.stringify(appB));

    // ---- 9. Word ----
    const word = await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"]'));
      const clones = pages.map((p) => {
        const c = p.cloneNode(true);
        if (typeof _docxStampLiveStyles === 'function') _docxStampLiveStyles(p, c);
        ['.rpt-footer', '.rpt-footer-label', '.rpt-pg-footer-pagenum'].forEach((sel) => c.querySelectorAll(sel).forEach((el) => el.remove()));
        return c;
      });
      const r = _docxTranslatePages(clones);
      return { images: r.images.length, figs: (r.xml.match(/Figure \d+:/g) || []).length, drawings: (r.xml.match(/<w:drawing>/g) || []).length };
    });
    ok(word.images === 4 && word.drawings === 4 && word.figs === 4, 'Word translation carries the 4 pictures and 4 captions (images ' + word.images + ', drawings ' + word.drawings + ', captions ' + word.figs + ')');

    // ---- 8. no folder ----
    await page.evaluate(() => { document.getElementById('reportOverlay').style.display = 'none'; document.getElementById('reportPages').innerHTML = ''; });
    const none = await makeDetailed(false);
    ok(none.sections.indexOf('detailedLibrary') > 0 && none.figs.length === 0 && none.imgInfo.length === 0, 'no picture folder: chapters complete, no figures');
    ok(none.fit.every((f) => f.over <= 1 && f.scrollOver <= 1), 'no picture folder: every page fits');

    // ---- 4b. Missing and Recommended Work come from the priced-scope rows only (same totals as Per-Building Detail) ----
    // VAV-103 has a zone temperature and no set points: a monitoring-only zone unit. Its raw gaps must not reach the lists.
    const work = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const rows = _a36ScopedCatalogRows(d);
      const out = {};
      d.buildings.forEach((b) => {
        const t = { sensors: 0, seqs: 0, raw: 0, monitoringOnlyRaw: 0 };
        rows.forEach((r) => {
          if (r.building !== b.name) return;
          if (r.phase === 1 && !r.ioOnly) t.sensors += r.qty || 0;
          else if (r.phase === 2 && r.seqKey) t.seqs += r.qty || 0;
        });
        b.equipResults.forEach((eq) => {
          const n = ((eq.compliance && eq.compliance.missingPoints) || []).length;
          t.raw += n;
          if (eq.name === 'VAV-103') t.monitoringOnlyRaw = n;
        });
        out[b.name] = t;
      });
      let lib = null;
      const got = {};
      Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"]')).forEach((pg) => {
        pg.querySelectorAll('h2, table tr').forEach((el) => {
          if (el.tagName === 'H2') {
            const m = /^(.*): Recommended Work$/.exec(el.textContent.trim());
            if (m) { lib = m[1]; got[lib] = got[lib] || { sensors: 0, seqs: 0, text: '' }; }
            else if (/: System Overview$/.test(el.textContent)) lib = null;
            return;
          }
          if (!lib) return;
          const c = el.querySelectorAll('td');
          const m2 = c.length === 3 && /^(Install sensor|Program sequence): .*\((\d+)\)$/.exec(c[2].textContent.trim());
          if (m2) {
            got[lib][m2[1] === 'Install sensor' ? 'sensors' : 'seqs'] += parseInt(m2[2], 10);
            got[lib].text += c[2].textContent + ' ';
          }
        });
      });
      return { out, got };
    }, seed);
    Object.keys(work.out).forEach((name) => {
      const w = work.out[name];
      const g = work.got[name] || { sensors: -1, seqs: -1 };
      ok(g.sensors === w.sensors && g.seqs === w.seqs, name + ': Recommended Work sums (sensors ' + g.sensors + ', sequences ' + g.seqs + ') equal Per-Building Detail totals (' + w.sensors + ', ' + w.seqs + ')');
    });
    ok(work.out['Alpha Library'].monitoringOnlyRaw > 0 && work.out['Alpha Library'].raw > work.out['Alpha Library'].sensors, 'monitoring-only unit VAV-103 has raw gaps (' + work.out['Alpha Library'].monitoringOnlyRaw + ') that the priced scope leaves out (raw ' + work.out['Alpha Library'].raw + ' vs ' + work.out['Alpha Library'].sensors + ')');
    ok(!/VAV-103/.test(work.got['Alpha Library'].text), 'monitoring-only unit VAV-103 is not in the Recommended Work rows');

    // ---- 7b. a large project: many libraries, long tables, long deficiency list; every page still fits ----
    const big = await page.evaluate(async () => {
      const PID = 900002;
      const rows = [];
      const findings = [];
      for (let b = 1; b <= 14; b++) {
        const lib = 'Library ' + String.fromCharCode(64 + b);
        rows.push({ id: 'a' + b, building: lib, category: 'ahu', equipName: 'AHU-' + b, location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55 °F', 'Duct Static Pressure': '1.1 in H2O' } });
        for (let v = 1; v <= 12 + b; v++) {
          rows.push({ id: 'v' + b + '-' + v, building: lib, category: 'vav', equipName: 'VAV-' + b + '0' + v, location: '', controllerType: 'Sample Controller', points: { 'Zone Temp': 70 + (v % 5) + ' °F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' } });
        }
        for (let k = 1; k <= 4; k++) {
          findings.push({ id: 'u' + b + '-' + k, rowId: null, building: lib, equipment: 'AHU-' + b, type: 'AHU', issueType: 'Deficiency', issue: 'Synthetic issue number ' + k + ' on this unit that has a long description so that the cell wraps over several lines in the table', change: 'Synthetic change ' + k, how: '', status: 'Open', deficiency: true, cscList: false });
        }
      }
      projects.push({ id: PID, name: 'Synthetic Large District', client: 'Synthetic Large District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: [] });
      await sset('en_audit_' + PID, { findings: findings, edits: {}, evidence: {} });
      const data = collectASHRAE36Data(PID, '2026-11-10', null);
      const html = generateASHRAE36AuditHTML(data, { cover: true, executive: true, costEstimate: true, setpointReview: true, pointInventory: true, detailed: true });
      showReportOverlay(html, 'Large');
      await new Promise((r) => setTimeout(r, 400));
      const pages = Array.from(document.querySelectorAll('#reportPages .rpt-page')).filter((p) => p.querySelector('.rpt-body'));
      const fit = pages.map((p, i) => {
        const body = p.querySelector('.rpt-body');
        const foot = p.querySelector('.rpt-pg-footer');
        let maxBottom = 0;
        body.querySelectorAll('*').forEach((e) => { const bb = e.getBoundingClientRect(); if (bb.height > 0) maxBottom = Math.max(maxBottom, bb.bottom); });
        // last block of the page: a heading is an h2, or a bold line (group heading, In place, Missing against ASHRAE 36)
        const last = Array.from(body.children).filter((e) => e.getBoundingClientRect().height > 0).pop();
        const lastHead = !!last && (last.tagName === 'H2' || (last.tagName === 'DIV' && !last.querySelector('img') && /^(600|700)$/.test(getComputedStyle(last).fontWeight)));
        return { section: p.getAttribute('data-section'), gap: Math.round(foot.getBoundingClientRect().top - maxBottom), scrollOver: body.scrollHeight - body.clientHeight, lastHead: lastHead, fill: (maxBottom - body.getBoundingClientRect().top) / body.getBoundingClientRect().height };
      });
      const sp = pages.filter((p) => p.getAttribute('data-section') === 'setpointReview');
      return { fit: fit, count: pages.length, sections: pages.map((p) => p.getAttribute('data-section')), spPages: sp.length, spHead: sp.length ? sp[0].textContent.indexOf('Appendix C: Setpoint Programming Review') >= 0 : null };
    });
    const bigBad = big.fit.filter((f) => f.gap < 0 || f.scrollOver > 1);
    ok(big.count > 40 && bigBad.length === 0, 'large project (' + big.count + ' pages): every page fits above the footer' + (bigBad.length ? ': ' + JSON.stringify(bigBad) : ''));
    console.log('INFO Appendix C pages in the large project: ' + big.spPages);
    const bigLib = big.fit.filter((f) => f.section === 'detailedLibrary');
    ok(bigLib.length > 10 && bigLib.every((f) => !f.lastHead), 'D7: no chapter page ends with a heading (' + bigLib.length + ' chapter pages)' + JSON.stringify(bigLib.filter((f) => f.lastHead)));
    const sparse = bigLib.slice(0, -1).filter((f) => f.fill < 0.35);
    ok(sparse.length === 0, 'D7: no chapter page except the last is less than 35 percent full: ' + bigLib.map((f) => Math.round(f.fill * 100)).join(','));
    ok(big.spPages === 0 || big.spHead === true, 'Appendix C, when printed, starts with its heading');
    ok(big.sections.filter((x) => x === 'detailedAppendixA').length >= 2, 'a long Appendix A runs over more than one page');

    // ---- 10. Simple through the modal ----
    await page.evaluate(() => { document.getElementById('reportOverlay').style.display = 'none'; document.getElementById('reportPages').innerHTML = ''; });
    const simpleModal = await page.evaluate(async (PID) => {
      openASHRAE36ReportModal(PID, 'audit');
      generateASHRAE36Preview();
      await new Promise((r) => setTimeout(r, 400));
      return Array.from(document.querySelectorAll('#reportPages .rpt-page')).map((p) => p.getAttribute('data-section'));
    }, seed);
    ok(simpleModal.length > 2 && simpleModal.indexOf('detailedLibrary') < 0 && simpleModal.indexOf('detailedAppendixA') < 0, 'Simple style through the modal prints no Detailed page (' + simpleModal.join(',') + ')');
    // ---- 11. D4: heating and chilled water plants print in Detailed only; domestic hot water never prints ----
    const PID2 = await page.evaluate(async () => {
      const PID = 900002;
      const pl = (id, name, cat, p) => ({ id, building: 'Gamma Library', category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const rows = [
        pl('g1', 'AHU-1', 'ahu', { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F', 'Duct Static Pressure': '1.1 in H2O', 'Outside Air Temp': '61 °F' }),
        pl('g2', 'Hot Water System - Gamma', 'plumbing', { 'Hot Water Supply Temperature': '150.2 °F', 'Hot Water Return Temperature': '130.0 °F', 'Hot Water Set Point': '160', 'Boiler 1 Status': 'On', 'Hot Water Pump 1 Enable': 'On', 'Heat Request 1': '1' }),
        pl('g3', 'Chilled Water System - Gamma', 'controls', { 'Chilled Water Supply Temperature': '44.1 °F', 'Chilled Water Return Temperature': '54.0 °F', 'Chilled Water Setpoint': '44', 'Chiller 1 Enable': 'On', 'Chilled Water Pump 1 Enable': 'On', 'Cool Request 1': '1' }),
        pl('g4', 'Domestic Hot Water', 'plumbing', { 'Domestic Hot Water Temperature': '120.0 °F', 'Recirculation Pump Status': 'On' }),
        pl('g5', 'Hot Water Loop Bypass Valve', 'plumbing', { 'Bypass Valve Position': '20 %' }),
      ];
      projects.push({ id: PID, name: 'Synthetic Plant District', client: 'Synthetic Plant District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Gamma Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      return PID;
    });
    const rule = await page.evaluate(() => [
      ['Hot Water System -  BVL', 'plumbing'], ['Hot Water - Lenexa CCL', 'other'], ['Chilled Water System - Central', 'controls'], ['Heating Water System - Central', 'plumbing'],
      ['Domestic Hot Water System - ADC', 'plumbing'], ['Domestic Hot Water', 'plumbing'], ['Hot Water Loop Bypass Valve', 'plumbing'], ['Hot Water System Differential Pressure', 'plumbing'],
      ['Hot Water System BTU Meter', 'plumbing'], ['Hot Water Makeup Water Meter', 'meter'], ['Chiller Integration', 'controls'], ['Hot Water System - HS', 'ahu'],
    ].map((x) => _a36PlantCategoryByName(x[0], x[1])));
    ok(rule.join(',') === 'hwp,hwp,chwp,hwp,plumbing,plumbing,plumbing,plumbing,plumbing,meter,controls,ahu', 'D4: the plant rule: "Hot Water System - X", "Hot Water - X", "Chilled Water System - X" are plants; domestic, bypass valve, pressure, BTU meter, makeup meter and integration stub are not (' + rule.join(',') + ')');
    const simplePlants = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const html = generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true });
      return { cats: d.buildings[0].equipResults.map((e) => e.category).sort().join(','), flag: d.plantsByName, plantText: /Hot Water Plant|Chilled Water Plant/.test(html) };
    }, PID2);
    ok(simplePlants.cats === 'ahu' && simplePlants.flag === false && !simplePlants.plantText, 'D4: Simple and every other caller keep the stored categories: only the air handler is audited (' + simplePlants.cats + ')');
    await page.evaluate(() => { document.getElementById('reportOverlay').style.display = 'none'; document.getElementById('reportPages').innerHTML = ''; });
    const plants = await page.evaluate(async (PID) => {
      openASHRAE36ReportModal(PID, 'audit');
      document.querySelector('input[name="a36Style"][value="detailed"]').checked = true;
      _a36StyleChanged();
      generateASHRAE36Preview();
      for (let i = 0; i < 100 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      const text = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"]')).map((p) => p.textContent).join('\n');
      return { text, cats: window._currentReportData.buildings[0].equipResults.map((e) => e.category).sort().join(',') };
    }, PID2);
    const pt = plants.text;
    ok(plants.cats === 'ahu,chwp,hwp', 'D4: Detailed audits the air handler and the two plants: ' + plants.cats);
    ok(/Chilled Water Plant\s*1/.test(pt) && /Hot Water Plant\s*1/.test(pt) && /Total\s*3/.test(pt), 'D4: System Overview counts one Hot Water Plant and one Chilled Water Plant (total 3)');
    ok(/Hot Water Plant\.\s*1 unit: Hot Water System - Gamma\./.test(pt) && /Chilled Water Plant\.\s*1 unit: Chilled Water System - Gamma\./.test(pt), 'D4: Equipment Descriptions name the heating hot water plant and the chilled water plant');
    ok(/Readings at the time of the audit on Hot Water System - Gamma: .*Hot Water Supply Temperature 150\.2°F/.test(pt) && /Readings at the time of the audit on Chilled Water System - Gamma: .*Chilled Water Supply Temperature 44\.1°F/.test(pt), 'D4: plants print their readings');
    ok(!/Domestic Hot Water/.test(pt) && !/Loop Bypass/.test(pt) && !/Plumbing/.test(pt), 'D4: domestic hot water and the bypass valve do not print');
    const fStart = pt.indexOf('Findings');
    const fEnd = pt.indexOf('Gamma Library: Recommended Work');
    const findAll = pt.slice(fStart, fEnd);
    const findPlants = findAll.slice(0, findAll.indexOf('Air Handling Unit'));
    ok(fStart > 0 && fEnd > fStart && /Chilled Water Plant/.test(findPlants) && /Hot Water Plant/.test(findPlants), 'D4: Findings has a Chilled Water Plant block and a Hot Water Plant block');
    ok(!/schedul/i.test(findPlants) && !/Occupied schedule/.test(pt), 'D4: plants get no schedule finding and no schedule line');
    ok(/Chilled Water Supply Temperature Reset/.test(findPlants) && /Hot Water Supply Temperature Reset/.test(findPlants), 'D4: plant findings include the supply temperature reset sequence of each plant (same treatment as the plants Detailed already printed)');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
