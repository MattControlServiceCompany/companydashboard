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
        ahu('r1', 'Alpha Library', 'AHU-1', pts(full)),
        ahu('r2', 'Alpha Library', 'AHU-2', pts(noRat)),
        vav('r3', 'Alpha Library', 'VAV-101', pts(zone)),
        vav('r4', 'Alpha Library', 'VAV-102', pts(zone)),
        vav('r5', 'Alpha Library', 'VAV-103', pts({ 'Zone Temp': '71.9 °F' })),
        { id: 'r6', building: 'Alpha Library', category: 'ef', equipName: 'EF-1', location: '', points: { 'Fan Status': 'On' } },
        ahu('r7', 'Beta Library', 'AHU-3', pts(full)),
        vav('r8', 'Beta Library', 'VAV-201', pts(zone)),
      ];
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
    ok(s.indexOf('detailedAppendixA') > s.lastIndexOf('detailedLibrary') && s.indexOf('pointInventory') > s.indexOf('detailedAppendixA'), 'Appendix A (deficiencies) then Appendix B (point inventory) after the chapters');
    ok(/Appendix A: Deficiency List/.test(det.text) && /Fan runs at night/.test(det.text) && /Appendix B: Point Inventory/.test(det.text), 'Appendix A lists the deficiency, Appendix B has its heading');
    ok(!/Appendix C/.test(det.text), 'no Appendix C when the project has no zone set point data to review (or none is shown)');
    const t = det.libText;
    ['Alpha Library: System Overview', 'Beta Library: System Overview', 'Equipment Descriptions', 'Findings', 'Alpha Library: Recommended Work', 'Beta Library: Recommended Work', 'Missing against ASHRAE 36'].forEach((x) => ok(t.indexOf(x) >= 0, 'chapters contain "' + x + '"'));
    ok(/Air Handling Unit[^\n]*2/.test(t) || /Air Handling Unit.{0,40}2/.test(t), 'System Overview counts the 2 air handling units of Alpha Library');
    ok(/Total\s*6/.test(t) && /Total\s*2/.test(t), 'System Overview totals: Alpha Library 6, Beta Library 2');
    ok(/Building automation controller: Sample Controller \(5 of 6 units\)/.test(t), 'BAS controller line from the rows (5 of 6 units in Alpha Library: the exhaust fan row has none)');
    ok(/Readings at the time of the audit on AHU-1: .*55\.2 °F/.test(t), 'Equipment Descriptions: readings from the row data with units as stored');
    ok(!/\$|\bhours?\b|\bprice\b|\bcost\b/i.test(t), 'no price, no hours, no cost text in the Detailed chapters');
    ok(!/metered kW|Next Steps/i.test(t), 'no "metered kW", no Next Steps');

    // figures
    const nums = (det.figs.join('\n').match(/Figure (\d+):/g) || []).map((x) => parseInt(x.replace(/\D/g, ''), 10));
    ok(nums.length === 4 && nums.every((v, i) => v === i + 1), 'figure numbers run 1..N in page order (' + nums.join(',') + ')');
    ok(det.imgInfo.length === 4 && det.imgInfo.every((i) => i.src === 'data:image/jpeg;base64,'.slice(0, 22) && i.w > 0 && i.w <= 1000), 'figures are JPEG data: URLs at most 1000 px wide (' + det.imgInfo.map((i) => i.w).join(',') + ')');
    ok(det.figs.some((f) => /Figure \d+: AHU-1, graphic \(air handler\)/.test(f)), 'caption names the equipment and the page shown');
    ok(!/syn-5/.test(det.text) && det.figs.length === 4, 'the skipped "Not used" picture is not used');
    ok(det.figs.filter((f) => /AHU-1/.test(f)).length === 2 && det.figs.filter((f) => /VAV-101/.test(f)).length === 1 && det.figs.filter((f) => /AHU-3/.test(f)).length === 1, 'at most 2 figures per equipment group, from that group equipment');
    ok(/Figure 1: AHU-1, graphic \(air handler\)/.test(det.figs[0]), 'cited picture comes first');

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
        return { section: p.getAttribute('data-section'), gap: Math.round(foot.getBoundingClientRect().top - maxBottom), scrollOver: body.scrollHeight - body.clientHeight };
      });
      const sp = pages.filter((p) => p.getAttribute('data-section') === 'setpointReview');
      return { fit: fit, count: pages.length, sections: pages.map((p) => p.getAttribute('data-section')), spPages: sp.length, spHead: sp.length ? sp[0].textContent.indexOf('Appendix C: Setpoint Programming Review') >= 0 : null };
    });
    const bigBad = big.fit.filter((f) => f.gap < 0 || f.scrollOver > 1);
    ok(big.count > 40 && bigBad.length === 0, 'large project (' + big.count + ' pages): every page fits above the footer' + (bigBad.length ? ': ' + JSON.stringify(bigBad) : ''));
    console.log('INFO Appendix C pages in the large project: ' + big.spPages);
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
