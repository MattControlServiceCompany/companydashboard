// tools/test-a36-abbreviations.js - the abbreviation rule of the Audit Report (Matt, 2026-11-18): the first use of a term in the report prints
// "full words (ABBR)", every later use prints the abbreviation. SYNTHETIC names and values only; headless bundled Chromium; no network.
// Checked: first body use, later use, plural, an/a, a term already followed by its abbreviation, headings / table headers / title bands / captions /
// the cover unchanged, the state is per report (a second render starts again with the full form), and the wiring in generateASHRAE36Preview.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-abbreviations.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('a36-abbreviations');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36ApplyAbbreviations === 'function' && typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- 1. a fixed page fixture ----
    const f = await page.evaluate(() => {
      const mk = () => {
        const d = document.createElement('div');
        d.id = 'fixtureRoot';
        d.innerHTML =
          '<div class="rpt-page" data-section="cover"><p>Building automation system cover line.</p></div>' +
          '<div class="rpt-page"><div class="rpt-int-hdr"><div class="rpt-pg-title">Building Automation System Review</div></div><div class="rpt-body">' +
          '<h1>Building Automation System Overview</h1>' +
          '<p id="p1">The building automation system records every unit. The <b>air handling units</b> and one air handling unit are listed; an air handling unit runs.</p>' +
          '<p id="p2">The Building Automation System (BAS) stays. A rooftop unit and a rooftop unit and the fan coil units.</p>' +
          '<ul><li id="l1">Each variable air volume box has a damper. Two variable air volume boxes. The dedicated outdoor air system and an energy recovery ventilator (ERV).</li></ul>' +
          '<table><thead><tr><th id="th1">Air handling units</th></tr></thead><tbody><tr><td id="td1">Plain building automation system cell</td></tr></tbody></table>' +
          '<table><tr><td style="background:var(--rpt-blue);color:#fff" id="band">North Library building automation system</td></tr></table>' +
          '<div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="x"><div id="cap">Figure 1: Air handling unit 1</div></div>' +
          '</div></div>';
        return d;
      };
      const run = () => {
        const d = mk();
        document.body.appendChild(d);
        _a36ApplyAbbreviations(d);
        const t = (id) => d.querySelector('#' + id).textContent;
        const o = {
          cover: d.querySelector('[data-section="cover"]').textContent,
          hdr: d.querySelector('.rpt-pg-title').textContent,
          h1: d.querySelector('h1').textContent,
          p1: t('p1'), p2: t('p2'), l1: t('l1'), th1: t('th1'), td1: t('td1'), band: t('band'), cap: t('cap'),
          html1: d.querySelector('#p1').innerHTML,
        };
        d.remove();
        return o;
      };
      return { a: run(), b: run() };
    });
    const a = f.a;
    ok(a.cover === 'Building automation system cover line.', 'the cover is unchanged: ' + a.cover);
    ok(a.hdr === 'Building Automation System Review' && a.h1 === 'Building Automation System Overview', 'the heading bar and the h1 are unchanged');
    ok(a.p1.indexOf('The building automation system (BAS) records every unit.') === 0, 'first body use: full words then (BAS): ' + a.p1);
    ok(a.p1.indexOf('air handling units (AHUs) and one AHU are listed; an AHU runs.') > -1, 'first plural use gets (AHUs), later singular AHU, "an AHU": ' + a.p1);
    ok(a.html1.indexOf('<b>air handling units (AHUs)</b>') > -1, 'markup stays: the <b> tag is kept around the changed words: ' + a.html1);
    ok(a.p2 === 'The BAS stays. A rooftop unit (RTU) and an RTU and the fan coil units (FCUs).', 'a term already followed by (ERV) keeps one bracket (list item); a later Building Automation System (BAS) shortens; "a" becomes "an" before RTU: ' + a.p2);
    ok(a.l1 === 'Each variable air volume (VAV) box has a damper. Two VAV boxes. The dedicated outdoor air system (DOAS) and an energy recovery ventilator (ERV).', 'list item: VAV, DOAS, ERV: ' + a.l1);
    ok(a.th1 === 'Air handling units', 'a table header cell is unchanged: ' + a.th1);
    ok(a.td1 === 'Plain BAS cell', 'a table body cell is in scope (later use): ' + a.td1);
    ok(a.band === 'North Library building automation system', 'the blue title band is unchanged: ' + a.band);
    ok(a.cap === 'Figure 1: Air handling unit 1', 'a figure caption is unchanged: ' + a.cap);
    ok(f.b.p1 === a.p1 && f.b.l1 === a.l1, 'a second run on a fresh report starts again with the full form (state per report)');

    // ---- 2. a real synthetic Audit Report built by generateASHRAE36AuditHTML ----
    const r = await page.evaluate(async () => {
      const pid = 900301;
      const ahu = (id, n) => ({ id, building: 'Test Library', category: 'ahu', subtype: 'sz', equipName: n, location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F' } });
      projects.push({ id: pid, name: 'Synthetic Abbreviation Project', client: 'Synthetic Abbreviation Project', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + pid, { rows: [ahu('a1', 'AHU-1'), ahu('a2', 'AHU-2')], importedAt: null, buildings: ['Test Library'] });
      const render = () => {
        const d = collectASHRAE36Data(pid, '2026-11-18', null);
        const html = generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true });
        showReportOverlay(html, 'Test');
        _a36ApplyAbbreviations(document.getElementById('reportPages'));
        const pages = [...document.querySelectorAll('#reportPages .rpt-page')].filter((p) => p.getAttribute('data-section') !== 'cover');
        const body = pages.map((p) => [...p.querySelectorAll('p,li,td')].map((e) => e.textContent).join(' ')).join(' ');
        const heads = [...document.querySelectorAll('#reportPages h1,#reportPages h2,#reportPages h3,#reportPages h4,#reportPages th')].map((e) => e.textContent);
        return { body, heads };
      };
      const one = render();
      closeReportOverlay();
      const two = render();
      closeReportOverlay();
      return { one, two, wired: /_a36ApplyAbbreviations\(document\.getElementById\('reportPages'\)\)/.test(String(generateASHRAE36Preview)) };
    });
    const count = (txt, re) => (txt.match(re) || []).length;
    const spelled = (txt, w) => count(txt, new RegExp(w + 's?\\b', 'gi'));
    ['building automation system', 'air handling unit', 'variable air volume'].forEach((w) => {
      ok(spelled(r.one.body, w) <= 1, 'real report: "' + w + '" is spelled out at most once in the body: ' + spelled(r.one.body, w));
    });
    ok(/\(BAS\)/.test(r.one.body) ? count(r.one.body, /\bBAS\b/g) > 1 : true, 'real report: BAS is used again after the (BAS) definition');
    ok(r.one.body === r.two.body && r.one.body.length > 200, 'a second render of the same report gives the same text (starts again with the full form)');
    ok(r.one.heads.every((h) => !/\([A-Z]{3,4}s?\)/.test(h)), 'real report: no heading or table header got a bracket abbreviation: ' + r.one.heads.filter((h) => /\([A-Z]{3,4}s?\)/.test(h)).join(' | '));
    ok(r.wired, 'generateASHRAE36Preview calls _a36ApplyAbbreviations on #reportPages');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
