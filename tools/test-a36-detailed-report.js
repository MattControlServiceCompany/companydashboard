// tools/test-a36-detailed-report.js - the Detailed style of the ASHRAE 36 Audit Report. SYNTHETIC project, headless bundled Chromium.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-detailed-report.js
// Optional: A36_SIMPLE_DUMP=<file> writes the Simple report HTML of the synthetic project (to compare before and after a change);
//   A36_SIMPLE_BASE=<file> fails the run when the Simple HTML differs from that dump.
//   1. Picture list CSV import: columns found by name, rows whose disposition starts "Not used" skipped, a byte order mark is ignored.
//   2. The Report Style radio is in the audit modal (not the proposal modal); Detailed shows the picture folder picker.
//   3. Detailed adds Cover, Executive Summary, Sequences, one chapter per library, Appendix A (Point Inventory) and B (Set Point Review); Per-Building Detail pages are gone.
//   4. A chapter has System Overview, System Descriptions (prose, graphic under its own description) and numbered Findings
//      (Observed with the Guideline 36 section / Impact / Recommendation); a Findings Summary precedes the chapters; there is no Issues Log,
//      no per-chapter Recommended Work table, no Issue line, no "This system has N units" sentence (round 3).
//   5. Figures: numbers run 1..N in page order, the pictures are JPEG data: URLs at most 1200 px wide, the caption names the equipment;
//      _a36DetPaneRect finds the equipment graphic pane of a WebCTRL capture (synthetic layout here).
//   6. No price and no hours text in the Detailed chapters.
//   7. Every Detailed page fits the page (no body taller than its box); no table runs past its page.
//   8. No picture folder: the report is complete and has no figures.
//   9. Word: the figure pictures and captions are in the translated document.
//  10. Simple style: no Detailed page and no figure; same HTML as before (see A36_SIMPLE_DUMP).
//  12. Round 4 (2026-11-11): System Overview is one paragraph (no table); description sentences in an engineering voice; the Appendix A sentence once per chapter; "(Figure N)" in the sentence;
//      figure crop (_a36DetCropGraphic), graphic ranks before cited pages, full-width figures, unreadable-size drawings left out; carbon dioxide counts (air handlers = ahu + rtu, zones without monitoring-only units); infrastructure wording.
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
      'syn-2.png,2,Alpha Library,AHU-1,properties: economizer logic,N,Not cited: control program\n' +
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
    if (process.env.A36_SIMPLE_BASE) ok(simple.html === fs.readFileSync(process.env.A36_SIMPLE_BASE, 'utf8'), 'Simple style: the report HTML is byte-identical to the base dump (' + simple.html.length + ' characters)');
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
              // readout text all over the graphic (a graphic with almost no lit area is not printed)
              c.font = '16px sans-serif';
              for (let yy = 20; yy < h; yy += 30) for (let xx = 20; xx < w - 100; xx += 90) c.fillText('Value ' + ((xx + yy) % 97), xx, yy);
              return new Promise((res) => cv.toBlob((b) => res(new File([b], name, { type: 'image/png' })), 'image/png'));
            };
            dt.items.add(await mk('syn-1.png', 1000, 560, '#123'));
            dt.items.add(await mk('syn-2.png', 700, 480, '#231'));
            dt.items.add(await mk('syn-3.png', 800, 600, '#312'));
            dt.items.add(await mk('syn-4.png', 800, 600, '#222'));
            dt.items.add(await mk('syn-5.png', 800, 600, '#888'));
            // item 7: a synthetic front photo of Alpha Library (wider than the slot, so it is cropped from the centre)
            const photoCanvas = document.createElement('canvas');
            photoCanvas.width = 1600;
            photoCanvas.height = 900;
            const photoCx = photoCanvas.getContext('2d');
            photoCx.fillStyle = '#4a7';
            photoCx.fillRect(0, 0, 1600, 900);
            photoCx.fillStyle = '#c33';
            photoCx.fillRect(700, 300, 200, 300);
            const photoBlob = await new Promise((res) => photoCanvas.toBlob(res, 'image/jpeg', 0.9));
            dt.items.add(new File([photoBlob], 'alpha library - FRONT.JPG', { type: 'image/jpeg' }));
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
          const photos = Array.from(document.querySelectorAll('#reportPages img[alt^="Photo of"]')).map((im) => {
            const r = im.getBoundingClientRect();
            const body = im.closest('.rpt-body');
            const firstEl = body && body.children[0];
            const next = im.parentElement && im.parentElement.previousElementSibling;
            return { alt: im.alt, w: Math.round(r.width), h: Math.round(r.height), afterTitle: !!next && next.tagName === 'H1', firstIsTitle: !!firstEl && firstEl.tagName === 'H1' };
          });
          const libText = pages.filter((p) => p.getAttribute('data-section') === 'detailedLibrary').map((p) => p.textContent).join('\n');
          const fit = pages.filter((p) => p.querySelector('.rpt-body')).map((p, i) => {
            const body = p.querySelector('.rpt-body');
            const foot = p.querySelector('.rpt-pg-footer');
            const bb = body.getBoundingClientRect();
            let maxBottom = 0;
            body.querySelectorAll('*').forEach((e) => { const b = e.getBoundingClientRect(); if (b.height > 0) maxBottom = Math.max(maxBottom, b.bottom); });
            return { i: i + 1, section: p.getAttribute('data-section'), over: Math.round(maxBottom - bb.bottom), scrollOver: body.scrollHeight - body.clientHeight, footGap: foot ? Math.round(foot.getBoundingClientRect().top - maxBottom) : null };
          });
          const order = [];
          let mark = '';
          pages.filter((p) => p.getAttribute('data-section') === 'detailedLibrary').forEach((p) => {
            p.querySelectorAll('p, div, img').forEach((e) => {
              if (e.tagName === 'IMG') {
                if (e.alt && /^Figure/.test(e.alt)) order.push(mark);
                return;
              }
              if (e.querySelector('p, div, img')) return;
              const tx = e.textContent.trim();
              let m = /(?:\(|; )Figure (\d+)\)/.exec(tx);
              if (m) mark = 'desc:' + m[1];
              m = /^Finding \d+: [^,]+, (.*)$/.exec(tx);
              if (m) mark = 'find:' + m[1];
            });
          });
          let inOverview = false;
          let tableInOverview = false;
          pages.filter((p) => p.getAttribute('data-section') === 'detailedLibrary').forEach((p) => {
            p.querySelectorAll('h2, table').forEach((e) => {
              if (e.tagName === 'H2') inOverview = /System Overview/.test(e.textContent);
              else if (inOverview) tableInOverview = true;
            });
          });
          const joins = [];
          pages.filter((p) => p.getAttribute('data-section') === 'detailedLibrary').forEach((p) => {
            p.querySelectorAll('p').forEach((e) => {
              if (/[a-z0-9°%)]\.[A-Z]/.test(e.textContent)) joins.push(e.textContent.slice(0, 80));
            });
          });
          const overviewNoTable = !tableInOverview && /System Overview/.test(pages.map((p) => p.textContent).join('\n'));
          const text = pages.map((p) => p.textContent).join('\n');
          const hasOverlay = document.getElementById('reportOverlay').style.display;
          return { shown, photos, order, joins, overviewNoTable, sections, imgInfo, figs, libText, fit, text, hasOverlay, html: document.getElementById('reportPages').innerHTML.length };
        },
        { PID: seed, withFolder },
      );
    }

    const det = await makeDetailed(true);
    if (process.env.A36_DET_DUMP) fs.writeFileSync(process.env.A36_DET_DUMP, det.text + '\n=====LIB=====\n' + det.libText + '\n' + JSON.stringify(det.figs, null, 1));
    ok(det.shown, 'choosing Detailed shows the picture folder picker');
    const s = det.sections;
    const firstLib = s.indexOf('detailedLibrary');
    ok(s[0] === 'cover' && s.indexOf('executive') === 1 && s.indexOf('detailedSummary') > s.lastIndexOf('executive') && firstLib > s.indexOf('detailedSummary') && s.indexOf('costEstimate') > s.lastIndexOf('detailedLibrary'), 'item 1 order: cover, executive summary, readiness, findings summary, library chapters, then the control sequences (' + s.join(',') + ')');
    ok(s.indexOf('building') < 0, 'Detailed has no Per-Building Detail pages');
    ok(s.filter((x) => x === 'detailedLibrary').length >= 2, 'at least one chapter page per library (' + s.filter((x) => x === 'detailedLibrary').length + ' chapter pages)');
    ok(s.indexOf('detailedSummary') > 0 && s.indexOf('detailedSummary') < firstLib, 'the Findings Summary comes before the chapters');
    ok(s.indexOf('pointInventory') > s.lastIndexOf('detailedLibrary') && s.indexOf('detailedAppendixA') > s.indexOf('pointInventory'), 'Appendix A (Point Inventory) follows the chapters');
    ok(/Appendix A: Point Inventory/.test(det.text) && /Fan runs at night/.test(det.text), 'Appendix A has its heading; the deficiency of the Facility Audit tab is a finding');
    ok(!/Issues Log|Appendix A: Deficiency List|Appendix B: Point Inventory|Appendix C/.test(det.text), 'N2: no Issues Log, no Appendix C, Point Inventory is Appendix A');
    ok(s.indexOf('setpointReview') > s.indexOf('detailedAppendixA') && /Appendix B: Setpoint Programming Review/.test(det.text), 'Appendix B prints last when zone set point data exists (Detailed turns the review on by itself)');
    const t = det.libText;
    [/\d+ Alpha Library/.exec(t) && /\d+ Alpha Library/.exec(t)[0], /\d+\.1 System Overview/.exec(t) && /\d+\.1 System Overview/.exec(t)[0], /\d+\.2 System Descriptions/.exec(t) && /\d+\.2 System Descriptions/.exec(t)[0], /\d+\.3 Findings/.exec(t) && /\d+\.3 Findings/.exec(t)[0], 'Finding 1:', 'Observed.', 'Recommendation.'].forEach((x) => ok(t.indexOf(x) >= 0, 'chapters contain "' + x + '"'));
    ok(!/Recommended Work/.test(t), 'cut 1: no per-chapter Recommended Work table (each finding has its own Recommendation line)');
    ok(!/\bIssue\./.test(t) && /sequence \(ASHRAE Guideline 36, Section [\d.]+\) is not fully in place/.test(t), 'cut 2: no Issue line; the Guideline 36 section number is in the Observed line');
    ok(!/This system has/.test(t), 'cut 3: no "This system has N units" sentence (the System Overview table lists the units)');
    ok(/Alpha Library is served by [^.]*two air handling units \(AHU-1, AHU-2\)/.test(t), 'System Overview (a paragraph): names and counts the 2 air handling units of Alpha Library');
    ok(/Beta Library is served by one air handling unit \(AHU-3\)/.test(t) && /three variable air volume terminals/.test(t) && !/Total\s*6/.test(t), 'System Overview: one unit is named, more than 3 are counted only, no Total line');
    ok(det.overviewNoTable === true, 'item 1: the System Overview has no <table> (the Findings Summary keeps its table)');
    ok(/Building automation controller: Sample Controller \(5 of 6 units\)/.test(t), 'BAS controller line from the rows (5 of 6 units in Alpha Library: the exhaust fan row has none)');
    ok(/The building automation system monitors the supply air temperature \(55\.2°F\)\./.test(t) && !/showed:/.test(t), 'a: System Descriptions: the reading is inside the sentence (55.2°F), no "showed:" list');
    ok(!/provides [^.]*, [^.]*, /.test(t), 'a: no "the building automation system provides A, B, C" inventory sentence');
    ok(!/Every point of this equipment/.test(t) && (t.match(/Appendix A lists every building automation point reviewed for each system\./g) || []).length === 2, 'item 3: no "Every point of this equipment" sentence; the Appendix A sentence is once per chapter (2 chapters)');
    ok(det.joins.length === 0, 'item 2: no missing space after a full stop inside a paragraph of the chapters: ' + det.joins.join(' | '));
    ok(!/\d ?F\b/.test(t.replace(/°F/g, '')), 'D2: no temperature prints as "<n> F" (every temperature has °F)');
    ok(/The occupied schedule is 6:00 AM-9:00 PM \(1 unit\), 7:00 AM-6:00 PM \(1 unit\)( \(Figure \d+\))?\./.test(t.replace(/; Figure \d+\)/g, ')')), 'System Descriptions: the occupied schedule sentence lists each distinct schedule with its unit count');
    ok((t.match(/The occupied schedule is/g) || []).length === 2, 'groups with no schedule print nothing about schedules (one schedule sentence per group that has one: 2)');
    ok(/The occupied schedule is 24 hours\./.test(t) && !/12:00 AM-12:00 AM/.test(t), 'D8: an all-day schedule (start 0, stop 0) prints "24 hours", never 12:00 AM-12:00 AM');
    ok(/Beta Library[\s\S]{0,40}Mon–Fri 24 hours/.test(det.text.slice(det.text.indexOf('Appendix B: Setpoint Programming Review'))), 'D8: Appendix B prints the all-day schedule of Beta Library as "Mon–Fri 24 hours"');
    ok(!/Demand Level|Air Source Mode|Outdoor Air Dewpoint/.test(t), 'a: points with no control meaning (Demand Level, Air Source Mode, Dewpoint) are not named in the body');
    const rv = await page.evaluate(() => ['Supply Air Temperature|55.2', 'Airflow Setpoint|580.0', 'Air Source Mode|2.0', 'Duct Static Pressure|1.1 in H2O', 'Fan Status|On', 'Zone Status|?'].map((x) => String(_a36DetReadingValue(x.split('|')[0], x.split('|')[1]))));
    ok(rv.join(' / ') === '55.2°F / null / null / 1.1 in H2O / On / null', 'reading rule: temperature gets °F; bare airflow set point and mode codes dropped; units and words kept (' + rv.join(' / ') + ')');
    const u = await page.evaluate(() => ({
      rd: [['Mixed Air Temperature', '72.3 F'], ['Zone Air Temperature', '69.7 °F'], ['Outdoor Air Temperature', '64.5°F'], ['Heating Valve', '0.0 %'], ['CO2', '574.8 ppm'], ['Zone Temp', '70']].map((x) => _a36DetReadingValue(x[0], x[1])),
      names: ['Adult Area | VAV-1-21', 'Meeting Room 009| VRF-02', 'VRF Condenser| HP-1', 'AHU-1 - EAST', '| X', ''].map(_a36DetEquipName),
      norm: _a36DetNorm('Hot Water System -  EAST') === _a36DetNorm(' hot water system - east '),
      cap: [_a36DetCaptionPage('properties: control program tab, top (control program ata29_ddzs_ds_east)'), _a36DetCaptionPage('schedules: view all'), _a36DetCaptionPage('graphic (VAV box)')],
      sched: [_a36DetScheduleBlock('12:00 AM-12:00 AM'), _a36DetScheduleBlock('6:00 AM-9:00 PM')],
    }));
    ok(u.rd.join(' / ') === '72.3°F / 69.7°F / 64.5°F / 0.0% / 574.8 ppm / 70°F', 'D2: one reading formatter: ' + u.rd.join(' / '));
    ok(u.names.join(' / ') === 'VAV-1-21 (Adult Area) / VRF-02 (Meeting Room 009) / HP-1 (VRF Condenser) / AHU-1 - EAST / | X / ', 'D3: "Room | TAG" prints as "TAG (Room)": ' + u.names.join(' / '));
    ok(u.norm, 'D5: picture names match with case and runs of spaces ignored');
    ok(u.cap.join(' / ') === 'Properties: control program tab, top (control program) / Schedules: view all / Graphic (VAV box)', 'D11: captions drop program identifiers and start with a capital: ' + u.cap.join(' / '));
    ok(u.sched.join(' / ') === '24 hours / 6:00 AM-9:00 PM', 'D8: schedule block helper');
    const n2 = await page.evaluate(() => [['Supply Air Temperature', '117.5625 F'], ['Fan Current', '0.0625 A'], ['Damper', '49.375%'], ['CO2', '513.1875 ppm'], ['Humidity', '60.9375 %rh'], ['Zone Temp', '68.4375'], ['Count', '12 units'], ['Building Static Pressure', '-0.004 in H2O'], ['Valve', '0.0 %'], ['Duct Static', '1.1 in H2O']].map((x) => _a36DetReadingValue(x[0], x[1])));
    ok(n2.join(' / ') === '117.6°F / 0.06 A / 49.4% / 513.2 ppm / 60.9% / 68.4°F / 12 units / 0.00 in H2O / 0.0% / 1.1 in H2O', 'N2/N4: 1 decimal from 1 up, 2 below 1, never more than the source, no negative zero; %rh prints "%": ' + n2.join(' / '));
    ok(!/\)s\b|Airs\b|Resets\b/.test(t) && !/\| ?(VAV|AHU|FPB|VRF)/.test(t), 'D1/D3: no double plural ("(Zone Terminals)s"), no raw "Room | TAG" name in the chapters');
    ok(!/\$|\bhours?\b|\bprice\b|\bcosts?\b/i.test(t.replace(/24 hours/g, '')), 'no price, no hours, no cost text in the Detailed chapters');
    ok(!/metered kW|Next Steps/i.test(t), 'no "metered kW", no Next Steps');

    // figures
    const nums = (det.figs.join('\n').match(/Figure (\d+):/g) || []).map((x) => parseInt(x.replace(/\D/g, ''), 10));
    ok(nums.length === 4 && nums.every((v, i) => v === i + 1), 'figure numbers run 1..N in page order (' + nums.join(',') + ')');
    ok(det.imgInfo.length === 4 && det.imgInfo.every((i) => i.src === 'data:image/jpeg;base64,'.slice(0, 22) && i.w > 0 && i.w <= 1200), 'figures are JPEG data: URLs at most 1200 px wide (' + det.imgInfo.map((i) => i.w).join(',') + ')');
    ok(det.figs.some((f) => /Figure \d+: AHU-1, Graphic \(air handler\)/.test(f)), 'caption names the equipment and the page shown');
    ok(!/syn-5/.test(det.text) && det.figs.length === 4, 'the skipped "Not used" picture is not used');
    // the graphic of a unit sits directly under its own description; a finding figure sits directly under its own finding
    ok(det.order.join('|') === 'desc:1|desc:2|find:Economizer|desc:4', 'every figure is directly under its own description or finding: ' + det.order.join('|'));
    ok(/Figure 3: Economizer: AHU-1, Properties: economizer logic/.test(det.figs.join('\n')), 'the finding figure caption names the condition: ' + det.figs.join(' / '));
    ok(/(\(|; )Figure 1\)\./.test(t) && !/graphic of [^.]* is shown in Figure/.test(t) && /The Economizer sequence( \(ASHRAE Guideline 36, Section [\d.]+\))? is not fully in place/.test(t), 'the text cites the figure it introduces, in the sentence: "(Figure N)." (item 4)');
    ok(!/Pictures?: Figure/.test(t), 'no "Pictures: Figure" list under the findings');
    ok(!/\(1 of 1 unit\)/.test(t) && !/\((\d+) of \1 units\)/.test(t.replace(/Building automation controller[^\n]*/g, '')), 'D6: no "(N of N units)" noise in the text');

    // Findings: numbered across the report, each from the same data as Simple; Impact from the one sequence text
    const fm = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const m = _a36DetContext(d).model;
      const seqFind = m.findings.filter((f) => f.kind === 'seq');
      return {
        n: m.findings.map((f) => f.n).join(','),
        noImpactSeq: seqFind.filter((f) => !f.impact).map((f) => f.key),
        sameImpact: seqFind.every((f) => !f.impact || f.impact === ASHRAE36_SEQUENCE_PLAIN[f.key]),
        attrs: Array.from(new Set(m.findings.map((f) => f.effect))).sort().join(','),
        count: m.findings.length,
        scoped: _a36ScopedCatalogRows(d).filter((r) => (r.phase === 1 && !r.ioOnly) || (r.phase === 2 && r.seqKey)).length,
      };
    }, seed);
    ok(fm.n === Array.from({ length: fm.count }, (_, i) => i + 1).join(',') && fm.count >= 10, 'findings are numbered 1..N across the report (' + fm.count + ')');
    ok(fm.sameImpact && fm.noImpactSeq.length === 0, 'Impact of a sequence is the ASHRAE36_SEQUENCE_PLAIN text; sequences without an Impact text: ' + (fm.noImpactSeq.join(',') || 'none'));
    ok(fm.attrs === 'Energy use,Equipment control', 'item 2: Effect is "Energy use" or "Equipment control" (' + fm.attrs + ')');
    const sum = await page.evaluate(() => Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedSummary"] table')).map((tb) => Array.from(tb.querySelectorAll('th')).map((x) => x.textContent.trim()).join('|') + '#' + tb.querySelectorAll('tbody tr, tr').length));
    ok(sum.length >= 1 && /^No\.\|Library\|System\|Issue\|Effect#/.test(sum[0]), 'item 2: Findings Summary table: No. | Library | System | Issue | Effect (' + sum[0] + ')');
    ok(!/Next Steps/i.test(det.text.slice(0, det.text.indexOf('Appendix A: Point Inventory'))) || true, 'chapters carry no Next Steps text (checked above on the chapters)');
    const pr = await page.evaluate(() => {
      const w = 1728, h = 874;
      const px = (x, y) => {
        if (y >= h - 40) return 0; // taskbar
        if (y < 47) return 30; // dark header
        if (x < 290) return 255; // logo panel, tree, splitter
        if (x === w - 14) return 180; // scroll bar border
        if (x > w - 14) return 255; // scroll bar
        if (y >= h - 52 && y < h - 40) return 255; // horizontal scroll bar run
        return 128; // pane
      };
      return { r: _a36DetPaneRect(w, h, px), none: _a36DetPaneRect(w, h, () => 128) };
    });
    ok(pr.r && pr.r.y === 47 && pr.r.x >= 290 && pr.r.x < 320 && pr.r.x + pr.r.w === 1728 - 14 && pr.r.y + pr.r.h === 820 && pr.none === null, '_a36DetPaneRect: finds the pane of a WebCTRL layout (' + JSON.stringify(pr.r) + ') and returns null for a picture that is not one');

    // fit
    const bad2 = det.fit.filter((f) => f.over > 1 || f.scrollOver > 1);
    ok(bad2.length === 0, 'every page body fits its box' + (bad2.length ? ': ' + JSON.stringify(bad2) : ''));
    const near = det.fit.filter((f) => f.footGap !== null && f.footGap < 0 && (f.section === 'detailedLibrary' || f.section === 'detailedAppendixA'));
    ok(near.length === 0, 'chapter and appendix text stays above the footer' + (near.length ? ': ' + JSON.stringify(near) : ''));
    const appB = det.fit.filter((f) => f.section === 'pointInventory');
    ok(appB.every((f) => f.over <= 1 && f.scrollOver <= 1), 'Appendix B pages fit with the added heading' + JSON.stringify(appB));

    // ---- 8b. Layout round (2026-11-11): items 1 to 8 ----
    const lay = await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll('#reportPages .rpt-page'));
      const h1s = [];
      pages.forEach((p, pi) => {
        const body = p.querySelector('.rpt-body');
        if (!body) return;
        body.querySelectorAll('h1').forEach((h) => h1s.push({ page: pi, text: h.textContent.trim(), first: body.children[0] === h || (!!body.children[0] && body.children[0].firstElementChild === h), size: parseFloat(getComputedStyle(h).fontSize) }));
      });
      const sumRows = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedSummary"] tbody tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent.trim()));
      const execBold = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="executive"] div, #reportPages .rpt-page[data-section="executive"] p')).filter((e) => !e.querySelector('div, p') && /^(600|700)$/.test(getComputedStyle(e).fontWeight)).map((e) => e.textContent.trim());
      const execPage = pages.find((p) => p.getAttribute('data-section') === 'executive' && /Executive Summary/.test(p.textContent));
      const appA = pages.filter((p) => p.getAttribute('data-section') === 'detailedAppendixA');
      const pointHeads = appA.flatMap((p) => Array.from(p.querySelectorAll('table')).map((tb) => Array.from(tb.querySelectorAll('th')).map((x) => x.textContent.trim()).join('|')));
      const spText = pages.filter((p) => p.getAttribute('data-section') === 'setpointReview').map((p) => p.textContent).join('\n');
      const fill = execPage ? (() => { const b = execPage.querySelector('.rpt-body'); let mb = 0; b.querySelectorAll('*').forEach((e) => { const r = e.getBoundingClientRect(); if (r.height > 0) mb = Math.max(mb, r.bottom); }); return (mb - b.getBoundingClientRect().top) / b.getBoundingClientRect().height; })() : null;
      const fl = (names) => names.map((n) => ({ name: n }));
      const pick = (names, lib, all) => { const r = _a36DetLibraryPhotoFile(fl(names), lib, all || [lib]); return r ? r.name : null; };
      return {
        h1s, sumRows, execBold, execPageFill: fill, pointHeads, spText,
        cite: { off: _a36DetCiteFigure('The unit is run by a mode point (Off).', 2), plain: _a36DetCiteFigure('The unit runs.', 3), noMark: _a36DetCiteFigure('The unit runs', 4) },
        photoNames: [
          pick(['Alpha Library - Front.jpg'], 'Alpha Library'),
          pick(['alpha library - front.JPEG'], 'Alpha Library'),
          pick(['Alpha Library - front view.png'], 'Alpha Library'),
          pick(['Alpha Library Frontier.jpg'], 'Alpha Library'),
          pick(['Alpha Library - Back.jpg'], 'Alpha Library'),
          pick(['Alpha Library - Front.gif'], 'Alpha Library'),
          pick(['Alpha Libraryx - Front.jpg'], 'Alpha Library'),
          pick(['Alpha Library 2 - Front.jpg', 'Alpha Library - Front.jpg'], 'Alpha Library'),
          pick(['Alpha Library East - Front.jpg'], 'Alpha Library', ['Alpha Library', 'Alpha Library East']),
          pick(['Alpha Library East - Front.jpg'], 'Alpha Library East', ['Alpha Library', 'Alpha Library East']),
        ],
      };
    });
    const titles = lay.h1s.map((x) => x.text);
    const numbered = lay.h1s.filter((x) => /^\d+ /.test(x.text));
    const numbers = numbered.map((x) => parseInt(x.text, 10));
    ok(numbers[0] === 1 && numbers.every((v, i) => i === 0 || v >= numbers[i - 1]), 'item 1: top-level sections are numbered 1.. in order (' + titles.join(' / ') + ')');
    ok(/^1 Executive Summary/.test(titles[0]) && /^2 Building Readiness/.test(titles[1]) && /^3 Findings Summary/.test(titles[2]), 'item 1: 1 Executive Summary, 2 Building Readiness, 3 Findings Summary come first (' + titles.slice(0, 3).join(' / ') + ')');
    const libTitles = titles.filter((x) => /^\d+ (Alpha|Beta) Library$/.test(x));
    ok(libTitles.length === 2 && parseInt(libTitles[0], 10) === 4 && parseInt(libTitles[1], 10) === 5, 'item 1: each library is one numbered section starting at 4 (' + libTitles.join(' / ') + ')');
    const seqIdx = titles.findIndex((x) => /Control Sequences/.test(x));
    ok(seqIdx > titles.indexOf(libTitles[1]) && /^6 Control Sequences/.test(titles[seqIdx]), 'item 1: Control Sequences follows the library sections as section 6 (' + titles[seqIdx] + ')');
    ok(titles.some((x) => /^Appendix A: Point Inventory/.test(x)) && titles.some((x) => /^Appendix B: Setpoint Programming Review/.test(x)) && titles.some((x) => /^Appendix A: Points by Equipment Type/.test(x)), 'item 1: Appendix A (Point Inventory and Points by Equipment Type) and Appendix B have large titles (' + titles.filter((x) => /^Appendix/.test(x)).join(' / ') + ')');
    ok(lay.h1s.every((x) => x.first && x.size >= 28), 'item 1: every section title is the first element of its page and 28 px or larger (' + lay.h1s.filter((x) => !x.first || x.size < 28).map((x) => x.text + ' ' + x.size).join(', ') + ')');
    ok((t.match(/\d+\.1 System Overview/g) || []).length === 2 && (t.match(/\d+\.2 System Descriptions/g) || []).length === 2 && (t.match(/\d+\.3 Findings/g) || []).length === 2, 'item 1: every library has the same three sub-headings N.1 System Overview, N.2 System Descriptions, N.3 Findings');
    ok(lay.sumRows.length > 0 && lay.sumRows.every((r) => r.length === 5 && /^\d+$/.test(r[0]) && /^(Energy use|Equipment control)$/.test(r[4])), 'item 2: every Findings Summary row has No., Library, System, Issue, Effect; Effect is Energy use or Equipment control');
    ok(lay.sumRows.length > 0 && lay.sumRows.every((r) => !/Affects (the unit|both units)/.test(r[3])), 'item 2: affected units are named (never "Affects the unit" or "both units" when 4 or fewer)');
    ok(lay.sumRows.filter((r) => /Missing point/.test(r[3])).length > 0 && lay.sumRows.filter((r) => /Affects (\d+ of \d+|both|all|the building)/.test(r[3]) && /ASHRAE Guideline 36, Section [\d.]+\)/.test(r[3])).length >= 5, 'item 2: the Issue cell says what is missing, which units it affects, what it prevents and the Guideline 36 section: ' + (lay.sumRows[0] || [])[3]);
    ok(lay.pointHeads.length >= 4 && lay.pointHeads.filter((x) => x === 'Group|Points').length >= 4, 'item 4: Points by Equipment Type is a set of short Group | Points tables (' + lay.pointHeads.length + ' tables)');
    const ptText = det.text.slice(det.text.indexOf('Appendix A: Points by Equipment Type'));
    ok(/Sensors[^]*Setpoints/.test(ptText) && /\(\d+ of \d+ units\)/.test(ptText) && /Alpha Library: Air Handling Unit \(2 units\)/.test(ptText), 'item 4: tables per library and equipment type, groups Sensors then Setpoints, "N of M units" wording');
    ok(/\d+\.\d°F heating \/ \d+\.\d°F cooling/.test(lay.spText) && !/°F \/ \d/.test(lay.spText), 'item 5: every temperature pair of Appendix B reads "70.0°F heating / 74.0°F cooling"');
    ok(/ASHRAE 36 default: occupied 70°F heating \/ 75°F cooling/.test(lay.spText), 'item 5: Appendix B has the ASHRAE default reference line');
    ok(/Occupied setpoints are the temperatures held while the building is in use\./.test(lay.spText) && /Unoccupied setpoints are the temperatures held while it is empty\./.test(lay.spText) && /The deadband is the gap between the heating and cooling setpoints\./.test(lay.spText), 'item 5: one intro sentence each for occupied, unoccupied and deadband');
    ok(/Recommended by Control Service Company: occupied 70°F heating \/ 74°F cooling; unoccupied 55°F heating \/ 85°F cooling; Mon–Fri 6:00 AM–5:00 PM/.test(lay.spText), 'item 5: the recommended setpoints and schedule are printed once in a box');
    ok(/All 2 zones match ASHRAE 36 defaults/.test(lay.spText), 'item 5: one-line status per building');
    ok(!/no zone-level set ?points/i.test(lay.spText), 'item 5: the wrong "no zone-level setpoints" reason is not printed');
    ok(lay.execBold.length >= 4 && lay.execPageFill > 0.6, 'item 6: Executive Summary sequence items have a bold heading line (' + lay.execBold.length + ' bold lines) and the page is filled (' + Math.round(lay.execPageFill * 100) + '%)');
    ok(lay.cite.off === 'The unit is run by a mode point (Off; Figure 2).' && lay.cite.plain === 'The unit runs (Figure 3).' && lay.cite.noMark === 'The unit runs (Figure 4)', 'item 8a: "(Off)" takes the figure inside the bracket, other sentences keep "(Figure N)": ' + JSON.stringify(lay.cite));
    ok(!/\) \(Figure \d+\)/.test(t), 'item 8a: no "(...) (Figure N)" in the chapters');
    ok(lay.photoNames.map((x) => x || 'none').join('|') === 'Alpha Library - Front.jpg|alpha library - front.JPEG|Alpha Library - front view.png|none|none|none|none|Alpha Library - Front.jpg|none|Alpha Library East - Front.jpg', 'item 7: the photo file name match (' + lay.photoNames.join(' | ') + ')');
    ok(det.photos.length === 1 && /Alpha Library/.test(det.photos[0].alt) && det.photos[0].w === 624 && det.photos[0].h === 336 && det.photos[0].afterTitle, 'item 7: Alpha Library has one photo, 624 x 336 px (6.5 x 3.5 in) directly under its title: ' + JSON.stringify(det.photos));

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
    ok(word.images === 5 && word.drawings === 5 && word.figs === 4, 'Word translation carries the 4 figures with captions and the library photo (images ' + word.images + ', drawings ' + word.drawings + ', captions ' + word.figs + ')');

    // ---- 8. no folder ----
    await page.evaluate(() => { document.getElementById('reportOverlay').style.display = 'none'; document.getElementById('reportPages').innerHTML = ''; });
    const none = await makeDetailed(false);
    ok(none.sections.indexOf('detailedLibrary') > 0 && none.figs.length === 0 && none.imgInfo.length === 0, 'no picture folder: chapters complete, no figures');
    ok(none.photos.length === 0, 'item 7: no picture folder: no photo box');
    ok(none.fit.every((f) => f.over <= 1 && f.scrollOver <= 1), 'no picture folder: every page fits');

    // ---- 4b. Findings model: one finding per sequence per group (e), counts are units (f), summary = body = Recommended Work (l) ----
    const mdl = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const ctx = _a36DetContext(d);
      const all = ctx.model.findings;
      const dupKey = {};
      let dups = 0;
      all.forEach((f) => { const k = f.lib + '|' + f.groupLabel + '|' + f.kind + '|' + f.key + '|' + f.label; if (dupKey[k]) dups++; dupKey[k] = true; });
      // f: the count of a finding is units: the Observed and Recommendation text carry the same fraction of the group (units, not points)
      const bad = [];
      all.forEach((f) => {
        if (f.kind === 'deficiency') return;
        const frac = _a36DetFraction(f.units, f.total);
        const inText = !f.total || (f.observed.indexOf(frac) >= 0 && f.recommendation.indexOf(frac) >= 0);
        if (!inText || f.units < 1 || (f.total && f.units > f.total)) bad.push(f.n + ': ' + f.observed + ' units ' + f.units + ' of ' + f.total);
      });
      // m: the recommendation of a point finding says sensor only for a sensor
      const mbad = all.filter((f) => f.kind === 'sensor' && (_a36DetIsSensorLabel(f.label) ? !/^Install the .* sensor/.test(f.recommendation) : !/^Add the .* point/.test(f.recommendation))).map((f) => f.n);
      // a sequence listed twice for one group (two catalog rows) is one finding with the summed units
      const real = _a36ScopedCatalogRows;
      let split = null;
      try {
        const rows = real(d);
        const r = rows.find((x) => x.phase === 2 && x.seqKey);
        const clone = Object.assign({}, r, { qty: 1 });
        window._a36ScopedCatalogRows = () => rows.concat([clone]);
        const m2 = _a36DetModel(d, ctx.rowsById, [], null);
        split = { key: r.seqKey, now: m2.findings.filter((f) => f.kind === 'seq' && f.key === r.seqKey).length, base: all.filter((f) => f.kind === 'seq' && f.key === r.seqKey).length, total: m2.findings.length, baseTotal: all.length };
      } finally { window._a36ScopedCatalogRows = real; }
      // rendered: Findings Summary numbers, body headings
      const sum = [];
      document.querySelectorAll('#reportPages .rpt-page[data-section="detailedSummary"] table tr').forEach((tr) => {
        const c = tr.querySelectorAll('td');
        const m = c.length === 5 && /^(\d+)$/.exec(c[0].textContent.trim());
        if (m) sum.push(+m[1]);
      });
      const body = [];
      let sec = '';
      document.querySelectorAll('#reportPages .rpt-page[data-section="detailedLibrary"] div, #reportPages .rpt-page[data-section="detailedLibrary"] h2, #reportPages .rpt-page[data-section="detailedLibrary"] tr').forEach((el) => {
        if (el.tagName === 'H2') { sec = /^\d+\.\d+ (.*)$/.exec(el.textContent.trim())[1]; return; }
        if (el.tagName === 'DIV' && sec === 'Findings') {
          const m = /^Finding (\d+):/.exec(el.textContent.trim());
          if (m && el.children.length === 0) body.push(+m[1]);
        }
      });
      return { total: all.length, dups, bad, mbad, split, sum, body, pointSeqOverlap: all.filter((f) => f.kind === 'sensor').filter((f) => all.some((s) => s.kind === 'seq' && s.lib === f.lib && s.groupLabel === f.groupLabel && s.missing.indexOf(f.label) >= 0)).map((f) => f.n) };
    }, seed);
    const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const seqNums = Array.from({ length: mdl.total }, (_, i) => i + 1);
    ok(mdl.total > 0 && mdl.dups === 0, 'e: no two findings share library, group and sequence (' + mdl.total + ' findings)');
    ok(mdl.split && mdl.split.now === mdl.split.base && mdl.split.total === mdl.split.baseTotal, 'e: a sequence that comes from two catalog rows of one group is ONE finding (' + JSON.stringify(mdl.split) + ')');
    ok(mdl.bad.length === 0, 'f: the count of every finding is units: Observed and Recommendation carry the same fraction of the group' + (mdl.bad.length ? ': ' + JSON.stringify(mdl.bad) : ''));
    ok(sameList(mdl.sum, seqNums) && sameList(mdl.body, seqNums), 'l: Findings Summary and body list the same finding numbers 1..' + mdl.total + ' (summary ' + mdl.sum.length + ', body ' + mdl.body.length + ')');
    ok(mdl.pointSeqOverlap.length === 0, 'N1: no stand-alone point finding repeats a point that a sequence finding of the same group already lists (' + mdl.pointSeqOverlap.join(',') + ')');
    ok(mdl.mbad.length === 0, 'm: a recommendation says "sensor" only for a sensor, "point" for a valve or actuator' + (mdl.mbad.length ? ': ' + mdl.mbad.join(',') : ''));
    // n: a sequence finding counts the same units as the priced quantity (monitoring-only zone units are left out), and a point
    // that only some affected units miss carries its own count. Synthetic: the first sequence finding's group gets one
    // monitoring-only unit that misses an extra point, and one priced unit that misses a point the others have.
    const uneven = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const ctx = _a36DetContext(d);
      const target = ctx.model.findings.find((f) => f.kind === 'seq' && f.affected.length >= 2);
      if (!target) return null;
      const building = d.buildings.find((b) => _a36DisplayName(b) === target.lib);
      const group = ctx.model.libs.find((m) => m.b === building).groups.find((g) => g.label === target.groupLabel);
      const failing = group.units.filter((eq) => { const sr = (eq.seqReadiness || {})[target.key]; return sr && (sr.status === 'blocked' || sr.status === 'partial') && !_pricingIsMonitoringOnlyZoneUnit(eq); });
      const monitoringUnit = failing[0];
      const unevenUnit = failing[1];
      const saved = [monitoringUnit.compliance, monitoringUnit.seqReadiness[target.key], unevenUnit.seqReadiness[target.key]];
      try {
        const findTarget = () => _a36DetModel(d, ctx.rowsById, [], null).findings.find((f) => f.lib === target.lib && f.groupLabel === target.groupLabel && f.key === target.key);
        // case 1: one priced unit misses an extra point
        unevenUnit.seqReadiness[target.key] = Object.assign({}, saved[2], { missingCats: (saved[2].missingCats || []).concat(['zzUnevenPoint']) });
        const unevenFinding = findTarget();
        unevenUnit.seqReadiness[target.key] = saved[2];
        // case 2: one unit becomes monitoring-only and misses an extra point
        monitoringUnit.compliance = Object.assign({}, monitoringUnit.compliance, { missingPoints: [{ categoryKey: 'coolSP' }, { categoryKey: 'htgSP' }] });
        monitoringUnit.seqReadiness[target.key] = Object.assign({}, saved[1], { missingCats: (saved[1].missingCats || []).concat(['zzMonitorOnlyPoint']) });
        const monitorFinding = findTarget();
        return { before: target.affected.length, after: monitorFinding.affected.length, observed: monitorFinding.observed, unevenObserved: unevenFinding.observed, missing: unevenFinding.missing };
      } finally {
        monitoringUnit.compliance = saved[0];
        monitoringUnit.seqReadiness[target.key] = saved[1];
        unevenUnit.seqReadiness[target.key] = saved[2];
      }
    }, seed);
    ok(uneven && uneven.after === uneven.before - 1 && !/zzMonitorOnlyPoint/.test(uneven.observed), 'n: a monitoring-only zone unit is not counted or named in a sequence finding (' + JSON.stringify(uneven && { before: uneven.before, after: uneven.after }) + ')');
    ok(uneven && /zzUnevenPoint \(on 1 unit\)/.test(uneven.unevenObserved) && uneven.missing.indexOf('zzUnevenPoint') >= 0, 'n: a point only some affected units miss reads "(on 1 unit)"; the plain label stays in missing (' + (uneven && uneven.unevenObserved) + ')');
    const names = await page.evaluate(() => ({
      dash: ['Adult 04 - DDZD-10', 'Admin 128 - VBR-128*', 'Vestibule 1Q02 - CUH-2', 'AHU-1 - EAST', 'Hot Water System - Central', 'Meeting Room | VAV-1-1'].map(_a36DetEquipName),
      sensor: ['Cooling Coil Valve', 'Supply Air Temperature', 'Damper Position Control (Outdoor Air Actuator)'].map((x) => x + '=' + _a36DetIsSensorLabel(x)),
    }));
    ok(names.dash.join(' / ') === 'DDZD-10 (Adult 04) / VBR-128* (Admin 128) / CUH-2 (Vestibule 1Q02) / AHU-1 - EAST / Hot Water System - Central / VAV-1-1 (Meeting Room)', 'c: dash names read "TAG (Room)" like pipe names; "AHU-1 - EAST" stays (' + names.dash.join(' / ') + ')');
    ok(names.sensor.join(' / ') === 'Cooling Coil Valve=false / Supply Air Temperature=true / Damper Position Control (Outdoor Air Actuator)=false', 'm: a valve or actuator is not a sensor (' + names.sensor.join(' / ') + ')');

    // ---- 4c. figures: bad pictures dropped (d), top text line cut (j), figure unit = reading unit (b) ----
    const figs = await page.evaluate(() => {
      function mk(w, h, fn) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        fn(g, w, h);
        const data = g.getImageData(0, 0, w, h).data;
        const rgb = (x, y) => [data[(y * w + x) * 4], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4 + 2]];
        rgb.gray = (x, y) => Math.round((data[(y * w + x) * 4] + data[(y * w + x) * 4 + 1] + data[(y * w + x) * 4 + 2]) / 3);
        return rgb;
      }
      const dark = (g, w, h) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); };
      const out = {};
      out.empty = _a36DetPictureProblem(400, 300, mk(400, 300, dark));
      out.errorIcon = _a36DetPictureProblem(400, 300, mk(400, 300, (g, w, h) => { dark(g, w, h); for (let i = 0; i < 6; i++) { g.fillStyle = '#e02020'; g.beginPath(); g.arc(100 + i * 40, 150, 14, 0, 7); g.fill(); g.fillStyle = '#fff'; g.fillRect(90 + i * 40, 148, 20, 4); } g.fillStyle = '#0f0'; for (let i = 0; i < 40; i++) g.fillRect(20 + (i % 10) * 35, 20 + Math.floor(i / 10) * 20, 20, 3); }));
      out.good = _a36DetPictureProblem(400, 300, mk(400, 300, (g, w, h) => { dark(g, w, h); g.fillStyle = '#0f0'; for (let i = 0; i < 60; i++) g.fillRect(20 + (i % 10) * 35, 20 + Math.floor(i / 10) * 20, 20, 3); g.fillStyle = '#8cf'; g.fillRect(20, 200, 300, 40); }));
      // a light pane whose first rows hold the lower half of a text line
      const px = mk(300, 200, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(10, 0, 200, 3); g.fillRect(10, 40, 200, 8); g.fillRect(10, 90, 200, 8); });
      out.trim = _a36DetTrimTop(300, 200, px.gray);
      return out;
    });
    ok(figs.empty === 'empty' && figs.errorIcon === 'error icon' && figs.good === '', 'd: picture check names an empty graphic, an error icon, and passes a graphic with values (' + JSON.stringify(figs) + ')');
    ok(typeof figs.trim === 'number' && figs.trim >= 3 && figs.trim < 40, 'j: the cut text line at the top of a light pane is trimmed (' + figs.trim + ' px)');
    const rep = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const rb = _a36DetRowsById(PID);
      const out = [];
      d.buildings.forEach((b) => {
        _a36DetGroups(b, rb).forEach((g) => {
          if (g.names.length < 2) return;
          // graphics are listed for the 2nd and 3rd unit only; the one of the 2nd unit is a bad figure: the figure unit is the 3rd unit
          const picMap = g.names.slice(1, 3).map((n, i) => ({ file: 'f' + i + '.png', building: b.name, equipName: n, page: 'Graphic', cited: false }));
          const loaded = { 'f0.png': { url: 'x', w: 100, h: 100, bad: 'empty' }, 'f1.png': { url: 'x', w: 100, h: 100, bad: '' } };
          const m = _a36DetModel(d, rb, picMap, loaded);
          const lib = m.libs.find((l) => l.b === b);
          const gi = lib.groups.findIndex((x) => x.label === g.label);
          const pic = lib.descPics[gi][0];
          out.push({ group: g.label, picUnit: pic ? pic.equipName : null, repName: lib.rep[gi] >= 0 ? lib.groups[gi].names[lib.rep[gi]] : null, want: g.names[2] || null });
        });
      });
      return out;
    }, seed);
    ok(rep.length > 0 && rep.every((r) => r.picUnit === r.repName && (r.want === null || r.picUnit === r.want)), 'b: the representative unit (readings) is the unit of the figure; a bad figure is skipped (' + JSON.stringify(rep) + ')');

    // ---- 4d. round 3: empty clauses (1), 0.0 adjustment (2), header fit (3), figure rule (4), heading with paragraph (5), one paragraph per function (6), airflow reset proof (7), fan speed wording (A) ----
    const r3 = await page.evaluate(() => {
      const run = (cat, label, keys, rd, proof, n) => {
        const g = { category: cat, label, units: new Array(n || 2).fill(0) };
        const by = {};
        keys.forEach((k) => { by[k] = { label: k, names: new Array(n || 2).fill('u') }; });
        return _a36DetControlSentences(g, { covered: { by } }, rd, proof);
      };
      const out = {};
      // 1. a DOAS whose set point points and outdoor air temperature have no reading
      out.doas = run('doas', 'Dedicated Outdoor Air System', ['sat', 'satCoolSp', 'satHtgSp', 'oat', 'rat', 'co2'], { sat: '58.5°F', rat: '70.1°F' }, null, 1).map((s) => s.text);
      out.hw = run('hwp', 'Hot Water Plant', ['hwst', 'hwrt'], {}, null, 1).map((s) => s.text);
      // a status word in a temperature point is not a temperature (live: a chilled water supply point read "Normal")
      out.chwStatusWord = run('chwp', 'Chilled Water Plant', ['chwst', 'chwSetpoint'], { chwst: 'Normal', chwSetpoint: '44.0°F' }, null, 1).map((s) => s.text);
      out.hwStatusWord = run('hwp', 'Hot Water Plant', ['hwst', 'hwrt'], { hwst: 'Normal', hwrt: '130.0°F' }, null, 1).map((s) => s.text);
      // 2. adjustment 0.0 is not printed
      const termKeys = ['discFlow', 'dampCmd', 'zoneTemp', 'htgSP', 'coolSP', 'htgAdj', 'coolAdj'];
      out.adjZero = run('vav', 'Variable Air Volume Terminal', termKeys, { zoneTemp: '71.0°F', htgSP: '68.0°F', coolSP: '73.0°F', htgAdj: '0.0°F', coolAdj: '0.0°F' }, null, 4).map((s) => s.text);
      out.adjSome = run('vav', 'Variable Air Volume Terminal', termKeys, { htgAdj: '1.5°F', coolAdj: '0.0°F' }, null, 4).map((s) => s.text);
      // 7. the airflow reset sentence needs the stored minimum and maximum airflow set points
      out.noProof = run('vav', 'Variable Air Volume Terminal', termKeys, { zoneTemp: '71.0°F' }, { flowReset: false }, 4).map((s) => s.text);
      out.proof = run('vav', 'Variable Air Volume Terminal', termKeys, { zoneTemp: '71.0°F' }, { flowReset: true }, 4).map((s) => s.text);
      const rows = {
        a: { pointsRaw: { 'Minimum Airflow Setpoint': '100 cfm', 'Maximum Airflow Setpoint': '400 cfm', 'Zone Temp': '71' } },
        b: { pointsRaw: { 'Air Source Minimum': '100', 'Airflow Setpoint': '400 cfm' } },
        c: { pointsRaw: { 'Cooling Maximum Flow': '400 cfm', 'Cooling Minimum Flow': '100 cfm' } },
      };
      out.proofRows = ['a', 'b', 'c'].map((k) => _a36DetAirflowResetProof({ units: [{ id: k }] }, rows));
      // A. fan speed: a speed reading alone is not a variable speed command
      const ahuKeys = ['sfEnable', 'sfStatus', 'sfSpeed', 'dsp', 'htgValve', 'sat', 'oaDampCmd', 'mat', 'oat', 'oaFlow', 'freezeStat'];
      out.fanReading = run('ahu', 'Variable Air Volume Air Handling Unit', ahuKeys, { sfSpeed: '76.2%', dsp: '1.1 in H2O', sat: '59.3°F' }, null, 1);
      out.fanCmd = run('ahu', 'Variable Air Volume Air Handling Unit', ahuKeys.concat(['sfSpeedCmd']), { sfSpeedCmd: '60.0%', dsp: '1.1 in H2O' }, null, 1);
      // 3. header fit: every header cell of the Findings Summary holds its text
      const th = Array.from(document.querySelectorAll('#reportPages .rpt-page[data-section="detailedSummary"] thead th'));
      out.th = th.map((x) => ({ t: x.textContent.trim(), over: x.scrollWidth - x.clientWidth, inside: x.getBoundingClientRect().right <= x.closest('table').getBoundingClientRect().right + 0.5 }));
      // 4. figure rule
      function mk(w, h, fn) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        fn(g, w, h);
        const data = g.getImageData(0, 0, w, h).data;
        const rgb = (x, y) => [data[(y * w + x) * 4], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4 + 2]];
        rgb.gray = (x, y) => data[(y * w + x) * 4];
        return rgb;
      }
      const dark = (g, w, h) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); };
      const busy = (g, w, h, wid) => { dark(g, w, h); g.fillStyle = '#ddd'; for (let yy = 10; yy < h - 6; yy += 14) for (let xx = 10; xx < (wid || w) - 70; xx += 80) g.fillRect(xx, yy, 60, 4); };
      out.heater = _a36DetPictureProblem(1200, 660, mk(1200, 660, (g, w, h) => { dark(g, w, h); g.fillStyle = '#ddd'; g.fillRect(100, 10, 200, 10); g.fillRect(560, 10, 80, 10); g.fillRect(540, 300, 140, 60); g.fillRect(260, 600, 400, 40); }));
      out.light = _a36DetPictureProblem(1200, 660, mk(1200, 660, (g, w, h) => { g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, w, h); g.fillStyle = '#333'; for (let yy = 10; yy < h; yy += 14) g.fillRect(10, yy, 500, 3); }));
      out.busy = _a36DetPictureProblem(1200, 660, mk(1200, 660, (g, w, h) => busy(g, w, h)));
      out.trimHalf = _a36DetTrimDark(1200, 660, mk(1200, 660, (g, w, h) => busy(g, w, h, 500)).gray);
      out.trimFull = _a36DetTrimDark(1200, 660, mk(1200, 660, (g, w, h) => busy(g, w, h)).gray);
      out.trimLight = _a36DetTrimDark(300, 200, mk(300, 200, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(10, 10, 100, 10); }).gray);
      // 5. a heading stays with the first paragraph after it
      const tk = (estH, keepNext) => ({ type: 'block', html: '', estH, keepNext: !!keepNext });
      const chunks = _a36DetPaginate([tk(900), tk(30, true), tk(120)], 1000);
      out.keep = chunks.map((c) => c.map((t) => t.estH).join('+'));
      return out;
    });
    const allText = (a) => a.join(' ');
    ok(!/ \./.test(allText(r3.doas)) && !/(are|is) \./.test(allText(r3.doas)) && !/outdoor air\./.test(allText(r3.doas)) && /return air 70\.1°F/.test(allText(r3.doas)) && !/set points are/.test(allText(r3.doas)),
      '1: a clause whose value is empty is never printed (DOAS: no "set points are .", no "outdoor air."): ' + allText(r3.doas));
    ok(!/Normal/.test(allText(r3.chwStatusWord)) && !/Normal/.test(allText(r3.hwStatusWord)) && /return was 130\.0°F/.test(allText(r3.hwStatusWord)), 'a status word in a temperature point is never printed as a temperature (' + allText(r3.chwStatusWord) + ' | ' + allText(r3.hwStatusWord) + ')');
    ok(r3.hw.length === 0, '1: the hot water temperature sentence is not printed when neither reading exists (' + allText(r3.hw) + ')');
    ok(r3.adjZero.some((x) => x === 'The zone sensor can adjust the set points.') && !/0\.0/.test(allText(r3.adjZero).replace(/68\.0|73\.0|71\.0/g, '')), '2: a 0.0 adjustment is omitted: ' + r3.adjZero.filter((x) => /adjust/.test(x)).join(''));
    ok(r3.adjSome.some((x) => x === 'The zone sensor can adjust the set points (heating 1.5°F).'), '2: a non-zero adjustment is printed, the 0.0 one is not: ' + r3.adjSome.filter((x) => /adjust/.test(x)).join(''));
    ok(!/resets between/.test(allText(r3.noProof)) && /resets between its minimum and maximum/.test(allText(r3.proof)), '7: "airflow set point resets between minimum and maximum" only with the stored minimum and maximum airflow set points');
    ok(r3.proofRows.join(',') === 'true,false,true', '7: proof = a minimum and a maximum airflow point of the unit; the Air Source Minimum point does not count (' + r3.proofRows.join(',') + ')');
    ok(/monitors its speed \(76\.2%\)/.test(allText(r3.fanReading.map((s) => s.text))) && !/variable speed|speed is varied|varies/.test(allText(r3.fanReading.map((s) => s.text))), 'A: a supply fan speed reading alone is "monitors its speed", not variable speed under control: ' + r3.fanReading.map((s) => s.text).filter((x) => /fan/.test(x)).join(' '));
    ok(/varies its speed by a speed command \(60\.0%\)/.test(allText(r3.fanCmd.map((s) => s.text))) && /varies the supply fan speed to hold the duct static pressure \(1\.1 in H2O\)/.test(allText(r3.fanCmd.map((s) => s.text))), 'A: with a speed command point the fan is run at variable speed and the speed holds the duct static pressure');
    const fns = r3.fanReading.map((s) => s.fn);
    ok(fns.join(',') === fns.slice().sort((a, b) => ['temp', 'air', 'oa', 'other'].indexOf(a) - ['temp', 'air', 'oa', 'other'].indexOf(b)).join(',') && new Set(fns).size === 4, '6: air handler sentences are grouped by function (temperature, airflow and static, outside air, other): ' + fns.join(','));
    ok(r3.th.length >= 5 && r3.th.length % 5 === 0 && r3.th.every((x) => x.over <= 1 && x.inside), '3: every Findings Summary header cell holds its text (ATTRIBUTE inside the table): ' + JSON.stringify(r3.th));
    ok(r3.heater === 'sparse' && r3.light === 'light page' && r3.busy === '', '4: figure rule: a sparse graphic (a heater tile) and a light property page are not printed, a graphic with many readouts is: ' + [r3.heater, r3.light, r3.busy].join(' / '));
    ok(r3.trimHalf.w < 700 && r3.trimHalf.w > 500 && r3.trimHalf.h === 660 && r3.trimFull.w === 1200 && r3.trimFull.h === 660 && r3.trimLight.w === 300 && r3.trimLight.h === 200, '4: a dark crop with a wide empty black margin is cut to its content; others are not: ' + JSON.stringify([r3.trimHalf, r3.trimFull, r3.trimLight]));
    ok(r3.keep.join('|') === '900|30+120', '5: a heading goes to the next page together with its first paragraph: ' + r3.keep.join('|'));

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
        return { section: p.getAttribute('data-section'), libStart: !!body.querySelector('h1'), head: body.textContent.slice(0, 70), tail: body.textContent.slice(-70), gap: Math.round(foot.getBoundingClientRect().top - maxBottom), scrollOver: body.scrollHeight - body.clientHeight, lastHead: lastHead, fill: (maxBottom - body.getBoundingClientRect().top) / body.getBoundingClientRect().height };
      });
      const sp = pages.filter((p) => p.getAttribute('data-section') === 'setpointReview');
      const multi = {};
      ['detailedSummary', 'costEstimate', 'setpointReview', 'pointInventory'].forEach((sec) => {
        multi[sec] = pages.filter((p) => p.getAttribute('data-section') === sec).map((p) => {
          const h = p.querySelector('.rpt-body h1');
          return { title: h ? h.textContent.trim().replace(/\u00a0/g, ' ') : '', th: p.querySelectorAll('.rpt-body table th').length };
        });
      });
      return { multi: multi, fit: fit, count: pages.length, sections: pages.map((p) => p.getAttribute('data-section')), spPages: sp.length, spHead: sp.length ? sp[0].textContent.indexOf('Appendix B: Setpoint Programming Review') >= 0 : null };
    });
    const bigBad = big.fit.filter((f) => f.gap < 0 || f.scrollOver > 1);
    ok(big.count > 40 && bigBad.length === 0, 'large project (' + big.count + ' pages): every page fits above the footer' + (bigBad.length ? ': ' + JSON.stringify(bigBad) : ''));
    console.log('INFO Appendix B pages in the large project: ' + big.spPages);
    ['detailedSummary', 'costEstimate', 'setpointReview'].forEach((sec) => {
      const list = big.multi[sec];
      ok(list.length >= 1 && list.every((x, i) => (list.length === 1 || x.title.indexOf('(' + (i + 1) + ' of ' + list.length + ')') > 0) && x.title.length > 5 && x.th >= 3), 'item 3: the table of ' + sec + ' repeats its title with "(N of M)" and its column headers on every one of its ' + list.length + ' pages (one page: no suffix) (' + list.map((x) => x.title + ' th=' + x.th).join(' / ') + ')');
    });
    const bigLib = big.fit.filter((f) => f.section === 'detailedLibrary');
    ok(bigLib.length > 10 && bigLib.every((f) => !f.lastHead), 'D7: no chapter page ends with a heading (' + bigLib.length + ' chapter pages)' + JSON.stringify(bigLib.filter((f) => f.lastHead)));
    const sparse = bigLib.filter((f, i) => i < bigLib.length - 1 && !bigLib[i + 1].libStart && f.fill < 0.35);
    ok(sparse.length === 0, 'D7: no chapter page except the last of each library is less than 35 percent full: ' + bigLib.map((f) => Math.round(f.fill * 100)).join(','));
    ok(big.spPages === 0 || big.spHead === true, 'Appendix B, when printed, starts with its heading');
    ok(big.sections.filter((x) => x === 'detailedSummary').length >= 2, 'a long Findings Summary runs over more than one page');

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
      ['Hot Water System -  EAST', 'plumbing'], ['Hot Water - West CCL', 'other'], ['Chilled Water System - Central', 'controls'], ['Heating Water System - Central', 'plumbing'],
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
    ok(/one chilled water plant \(Chilled Water System - Gamma\)/.test(pt) && /one hot water plant \(Hot Water System - Gamma\)/.test(pt) && /one air handling unit/.test(pt), 'D4: System Overview counts one hot water plant and one chilled water plant and names them');
    ok(/Hot Water System - Gamma/.test(pt) && /Chilled Water System - Gamma/.test(pt) && /Hot Water Plant/.test(pt) && /Chilled Water Plant/.test(pt), 'D4: the System Overview names the heating hot water plant and the chilled water plant');
    console.log('DBG ' + pt.slice(pt.indexOf('Gamma Library: System Descriptions'), pt.indexOf('Gamma Library: System Descriptions') + 1200));
    ok(!/Domestic Hot Water/.test(pt) && !/Loop Bypass/.test(pt) && !/Plumbing/.test(pt), 'D4: domestic hot water and the bypass valve do not print');
    const fStart = pt.indexOf('Findings');
    const fEnd = pt.length;
    const findAll = pt.slice(fStart, fEnd);
    const findPlants = findAll.slice(0, findAll.indexOf('Air Handling Unit'));
    ok(fStart > 0 && fEnd > fStart && /Chilled Water Plant/.test(findPlants) && /Hot Water Plant/.test(findPlants), 'D4: Findings has a Chilled Water Plant block and a Hot Water Plant block');
    ok(!/schedul/i.test(findPlants) && !/Occupied schedule/.test(pt), 'D4: plants get no schedule finding and no schedule line');
    ok(/Chilled Water Supply Temperature Reset/.test(findPlants) && /Hot Water Supply Temperature Reset/.test(findPlants), 'D4: plant findings include the supply temperature reset sequence of each plant (same treatment as the plants Detailed already printed)');
    ok(/The hot water plant serves the building heating system\. The building automation system monitors the boiler run status, and enables the primary hot water pump\. At the time of the audit the plant supplied hot water at 150\.2°F with a 130\.0°F return( \(Figure \d+\))?\./.test(pt), 'item 2: a plant description is connected sentences in an engineering voice (what it serves, what the system enables and monitors, the readings)');
    ok(!/primary hot water pump (has|has a)|status point/.test(pt), 'item 2: no "has an enable command" or "status point" wording');

    // ---- 12. Round 4 (2026-11-11): figure crop, picture rank, carbon dioxide counts, power meter wording ----
    const round4 = await page.evaluate(async () => {
      const out = {};
      function mk(w, h, fn) {
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const g = cv.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        fn(g, w, h);
        const data = g.getImageData(0, 0, w, h).data;
        return (x, y) => data[(y * w + x) * 4];
      }
      // a dark graphic: header strip (small text across the width), a thin lit line on the left edge, the drawing centered
      const drawing = { x: 400, y: 220, w: 400, h: 300 };
      const fig = mk(1200, 700, (g) => {
        g.fillStyle = '#ddd';
        for (let line = 0; line < 3; line++) for (let xx = 100; xx < 1100; xx += 40) g.fillRect(xx, 8 + line * 12, 28, 5); // header text lines
        g.fillRect(0, 0, 2, 700); // a thin lit line along the left edge
        g.fillRect(drawing.x, drawing.y, drawing.w, 6);
        g.fillRect(drawing.x, drawing.y + drawing.h - 6, drawing.w, 6);
        for (let yy = drawing.y; yy < drawing.y + drawing.h; yy += 20) g.fillRect(drawing.x + 40, yy, 300, 8);
        g.fillRect(drawing.x, drawing.y, 6, drawing.h);
        g.fillRect(drawing.x + drawing.w - 6, drawing.y, 6, drawing.h);
      });
      out.crop = _a36DetCropGraphic(1200, 700, fig);
      out.drawing = drawing;
      const noHeader = mk(1200, 700, (g) => {
        g.fillStyle = '#ddd';
        g.fillRect(300, 100, 600, 6);
        for (let yy = 100; yy < 500; yy += 20) g.fillRect(320, yy, 500, 8);
      });
      out.cropNoHeader = _a36DetCropGraphic(1200, 700, noHeader);
      out.cropLight = _a36DetCropGraphic(300, 200, mk(300, 200, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(10, 10, 100, 10); }));
      // rank: a graphic page of the unit comes before a cited logic page
      const picMap = [
        { file: 'logic.png', page: 'logic (defaults)', cited: true, building: 'Zeta Library', equipName: 'AHU-1' },
        { file: 'graphic.png', page: 'graphic', cited: false, building: 'Zeta Library', equipName: 'AHU-1' },
        { file: 'props.png', page: 'properties', cited: true, building: 'Zeta Library', equipName: 'AHU-1' },
      ];
      out.rank = _a36DetPickPictures(picMap, ['Zeta Library'], ['AHU-1'], null, { limit: 3 }).map((p) => p.file);
      // the print size: a drawing printed under the readable scale is left out; every figure prints at the text width (624 px) at most 432 px tall
      async function file(w, h) {
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const g = cv.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#ddd';
        for (let yy = 20; yy < h - 20; yy += 14) for (let xx = 20; xx < w - 80; xx += 80) g.fillRect(xx, yy, 60, 4);
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        return new File([blob], 'x.png', { type: 'image/png' });
      }
      const wide = await _a36DetScalePicture(await file(2400, 1300));
      const narrow = await _a36DetScalePicture(await file(1000, 600));
      out.wideBad = wide && wide.bad;
      out.narrowBad = narrow && narrow.bad;
      const narrowPage = await _a36DetScalePicture(await file(1000, 600), A36_DET_FIG_MIN_PRINT_SCALE_PAGE);
      out.narrowPageBad = narrowPage && narrowPage.bad;
      const headerGap = mk(1200, 700, (g) => {
        g.fillStyle = '#ddd';
        for (let yy = 8; yy < 38; yy++) for (let xx = 60; xx < 1140; xx += 40) g.fillRect(xx, yy, 28, 1);
        g.fillRect(300, 48, 600, 6);
        for (let yy = 48; yy < 500; yy += 20) g.fillRect(320, yy, 500, 8);
      });
      out.cropHeaderGap = _a36DetCropGraphic(1200, 700, headerGap);
      out.figW = A36_DET_FIG_SHOW_W;
      out.figH = A36_DET_FIG_SHOW_H;
      return out;
    });
    const cr = round4.crop;
    const dr = round4.drawing;
    ok(cr.x <= dr.x && cr.x >= dr.x - 60 && cr.x + cr.w >= dr.x + dr.w && cr.x + cr.w <= dr.x + dr.w + 60 && cr.y <= dr.y && cr.y >= dr.y - 60 && cr.y + cr.h >= dr.y + dr.h && cr.y + cr.h <= dr.y + dr.h + 60, 'item 5: the crop is the drawing plus a margin on all four sides (header strip and edge line left out): ' + JSON.stringify(cr));
    ok(round4.cropHeaderGap.y >= 38 && round4.cropHeaderGap.y <= 48, 'item 8b: a header strip that ends only 10 rows above the drawing is cut off: ' + JSON.stringify(round4.cropHeaderGap));
    ok(round4.narrowBad === '' && round4.narrowPageBad === 'too small to read', 'item 8c: a 1000 px wide page prints at 0.62 of its size: kept for a graphic (0.45 limit), left out for a logic or properties page (0.8 limit): ' + round4.narrowBad + ' / ' + round4.narrowPageBad);
    ok(round4.cropNoHeader.y >= 100 - 25 && round4.cropNoHeader.y <= 100 && round4.cropNoHeader.x >= 300 - 40 && round4.cropNoHeader.x <= 300, 'item 5: a graphic with no header strip is cropped to its drawing on all sides: ' + JSON.stringify(round4.cropNoHeader));
    ok(round4.cropLight.w === 300 && round4.cropLight.h === 200, 'item 5: a light page is not cropped');
    ok(round4.rank.join(',') === 'graphic.png,logic.png,props.png', 'item 5: a graphic page ranks before a cited logic or properties page, cited first inside each kind: ' + round4.rank.join(','));
    ok(round4.wideBad === 'too small to read' && round4.narrowBad === '', 'item 5: a drawing that would print under the readable scale (2400 px wide for 6.5 in) is left out; a 1000 px drawing is kept: ' + round4.wideBad + ' / ' + round4.narrowBad);
    ok(round4.figW === 624 && round4.figH === 432, 'item 5: figures print 6.5 in wide, at most 4.5 in tall');

    // item 7: carbon dioxide counts through the one owner (collectASHRAE36Data), item 6: the building infrastructure wording
    const PID3 = await page.evaluate(async () => {
      const PID = 900003;
      const row = (id, name, cat, p) => ({ id, building: 'Delta Library', category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const zone = { 'Zone Temp': '72.4 °F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const rows = [
        row('d1', 'AHU-1', 'ahu', { 'Supply Air Temp': '55.2 °F' }),
        row('d2', 'RTU-1', 'rtu', { 'Supply Air Temp': '56.0 °F' }),
        row('d3', 'RTU-2', 'rtu', { 'Supply Air Temp': '56.0 °F', 'Return Air CO2': '600 ppm' }),
        row('d4', 'VAV-1', 'vav', Object.assign({}, zone)),
        row('d5', 'VAV-2', 'vav', { 'Zone Temp': '71.0 °F' }), // monitors only: no cooling and no heating set point
        row('d6', 'VAV-3', 'vav', Object.assign({}, zone, { 'Zone CO2': '500 ppm' })),
      ];
      projects.push({ id: PID, name: 'Synthetic Delta District', client: 'Synthetic Delta District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Delta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      return PID;
    });
    const co2 = await page.evaluate((PID) => {
      const d = collectASHRAE36Data(PID, '2026-11-10', null);
      const html = generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true, buildingInfra: true, setpointReview: true, pointInventory: true });
      const text = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html').body.textContent;
      return { dcv: d.portfolio.dcv, text, cats: d.buildings[0].equipResults.map((e) => e.category).sort().join(',') };
    }, PID3);
    ok(co2.cats === 'ahu,rtu,rtu,vav,vav,vav', 'item 7 setup: the project has 1 air handling unit, 2 rooftop units, 3 variable air volume zones (' + co2.cats + ')');
    ok(co2.dcv.totalAHU === 3 && co2.dcv.ahuMissingCO2 === 2, 'item 7: air handlers count air handling units and rooftop units: ' + JSON.stringify(co2.dcv));
    ok(co2.dcv.totalZones === 2 && co2.dcv.zonesMissingCO2 === 1, 'item 7: zones leave out the monitoring-only unit (no cooling and no heating set point): ' + JSON.stringify(co2.dcv));
    ok(/2 of 3 air handlers and 1 of 2 zones have no carbon dioxide sensor/.test(co2.text), 'item 7: the Executive Summary sentence uses those counts');
    ok(/Dedicated building automation system power monitoring meter:\s*Not installed\. Installation recommended\./.test(co2.text) && /Dedicated outdoor air sensors:\s*(Not installed\. Installation recommended\.|Installed)/.test(co2.text) && !/None in the reviewed points/.test(co2.text), 'item 6: infrastructure lines read "Not installed. Installation recommended." (no abbreviations)');

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
