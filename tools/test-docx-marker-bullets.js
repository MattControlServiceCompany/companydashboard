// tools/test-docx-marker-bullets.js: a bullet row built as a padded block with an absolutely placed marker is ONE Word paragraph
// (marker, tab, text) with a hanging indent; its description line sits at the same left indent (Matt 2026-11-19).
// A page marked data-flow does not get a page break before it (flowed text, Matt 2026-11-19).
// Run: CH_TMP_ROOT=<scratch> node tools/test-docx-marker-bullets.js   Synthetic markup only, headless bundled Chromium.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('docx-marker-bullets');
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _docxTranslatePages === 'function' && typeof _docxStampLiveStyles === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      window._currentReportData = { _ashrae: true };
      const row = (t, d) => '<div style="font-size:9px;line-height:1.45;padding-left:14px;position:relative"><span style="position:absolute;left:0">&#8226;</span>' + t +
        (d ? '<div style="font-size:8px;line-height:1.4">' + d + '</div>' : '') + '</div>';
      const host = document.createElement('div');
      host.innerHTML = '<div class="rpt-page"><div class="rpt-body">' + row('Alpha item: $100', 'Devices: 2 Sensors.') + row('Beta item: $5', '') + '</div></div>' +
        '<div class="rpt-page" data-flow="1"><div class="rpt-body"><p>Flowed text</p></div></div><div class="rpt-page"><div class="rpt-body"><p>New section</p></div></div>';
      document.body.appendChild(host);
      const lives = Array.from(host.children);
      const clones = lives.map((l) => l.cloneNode(true));
      lives.forEach((l, i) => _docxStampLiveStyles(l, clones[i]));
      const xml = _docxTranslatePages(clones).xml;
      const paras = xml.match(/<w:p>.*?<\/w:p>/g) || [];
      const text = (p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('|');
      return { paras: paras.map((p) => ({ t: text(p), ind: (/<w:ind [^>]*>/.exec(p) || [''])[0], brk: /pageBreakBefore/.test(p) })) };
    });
    const P = r.paras;
    const a = P.find((p) => p.t.indexOf('Alpha item') > -1);
    ok(a && a.t.charCodeAt(0) === 0x2022 && a.t.indexOf('\t') > -1, 'bullet, tab and text are one paragraph: ' + (a && JSON.stringify(a.t)));
    ok(a && /w:left="210"/.test(a.ind) && /w:hanging="210"/.test(a.ind), 'hanging indent 14px = 210 twips: ' + (a && a.ind));
    ok(!P.some((p) => p.t === '\u2022'), 'no paragraph holds the bullet alone');
    const d = P.find((p) => p.t.indexOf('Devices: 2 Sensors.') > -1);
    ok(d && /w:left="210"/.test(d.ind) && !/hanging/.test(d.ind), 'description line at the same left indent: ' + (d && d.ind));
    ok(!!P.find((p) => p.t.indexOf('Beta item') > -1 && p.t.charCodeAt(0) === 0x2022), 'a row without a description is one paragraph');
    const fl = P.find((p) => p.t === 'Flowed text');
    const ns = P.find((p) => p.t === 'New section');
    ok(fl && !fl.brk, 'a data-flow page has no page break before it');
    ok(ns && ns.brk, 'the next normal page keeps its page break');
  } finally { await ctx.close(); }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
