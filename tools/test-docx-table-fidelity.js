// tools/test-docx-table-fidelity.js: an ASHRAE 36 report table in Word takes the PDF's cell padding, its measured column
// proportions, and keeps the colour and weight of each block of a two-block cell.
// Run: CH_TMP_ROOT=<scratch> node tools/test-docx-table-fidelity.js
// Synthetic markup only, in headless bundled Chromium: the live copy is stamped (_docxStampLiveStyles) and translated (_docxTranslatePages).
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('docx-table-fidelity');
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _docxTranslatePages === 'function' && typeof _docxStampLiveStyles === 'function', null, { timeout: 30000 });
    const run = (ashrae) => page.evaluate((isAshrae) => {
      window._currentReportData = isAshrae ? { _ashrae: { type: 'audit', title: 'Test' } } : {};
      const host = document.createElement('div');
      // The colgroup says 10/10/80 %, but the no-wrap name widens the first column in the browser. Word must follow the measured widths.
      host.innerHTML = '<div class="rpt-page"><div class="rpt-body"><table style="width:600px;border-collapse:collapse">' +
        '<colgroup><col style="width:10%"><col style="width:10%"><col style="width:80%"></colgroup>' +
        '<thead><tr><th style="padding:5px 8px;border:1px solid #333">Library</th><th style="padding:5px 8px;border:1px solid #333">Issue</th><th style="padding:5px 8px;border:1px solid #333">Status</th></tr></thead>' +
        '<tbody><tr><td style="padding:5px 8px;border:1px solid #333;white-space:nowrap">North Park Library Branch Office</td><td style="padding:5px 8px;border:1px solid #333">Alpha</td>' +
        '<td style="padding:5px 8px;border:1px solid #333"><span style="font-weight:700;color:rgb(230,126,34)">Change the setpoints of 3 of 3 zones</span>' +
        '<div style="margin-top:3px;color:rgb(0,0,0)">Recommended for this building: unoccupied 65F</div></td></tr></tbody></table></div></div>';
      document.body.appendChild(host);
      const live = host.firstChild;
      const clone = live.cloneNode(true);
      _docxStampLiveStyles(live, clone);
      const xml = _docxTranslatePages([clone]).xml;
      const grid = /<w:tblGrid>(.*?)<\/w:tblGrid>/.exec(xml);
      const cols = grid ? (grid[1].match(/w:w="(\d+)"/g) || []).map((s) => parseInt(s.slice(5), 10)) : [];
      const margins = (xml.match(/<w:tcMar>.*?<\/w:tcMar>/g) || []);
      const runOf = (word) => xml.split('<w:r>').find((x) => x.indexOf('>' + word) > -1) || '';
      const a = runOf('Change the setpoints');
      const b = runOf('Recommended for this building');
      const measured = Array.from(host.querySelectorAll('th')).map((c) => c.getBoundingClientRect().width);
      host.remove();
      return { measured, cols, margins, aOrange: /<w:color w:val="E67E22"/.test(a), aBold: /<w:b\/>/.test(a), bBold: /<w:b\/>/.test(b), bBlack: /<w:color w:val="000000"/.test(b) || !/<w:color /.test(b), margin0: margins[0] || '' };
    }, ashrae);
    const r = await run(true);
    // Padding: 5px 8px in the live table is 75 / 120 twips (1 px = 15 twips).
    ok(r.margins.length === 6, 'every cell carries its own w:tcMar (' + r.margins.length + ' of 6)');
    ok(/<w:top w:w="75"/.test(r.margin0) && /<w:left w:w="120"/.test(r.margin0) && /<w:bottom w:w="75"/.test(r.margin0) && /<w:right w:w="120"/.test(r.margin0), 'padding 5px 8px is 75/120/75/120 twips: ' + r.margin0);
    // Widths: the measured proportions of the live table, not the colgroup percentages.
    const sum = r.cols.reduce((x, y) => x + y, 0);
    ok(r.cols.length === 3 && sum === 10080, 'three columns fill the text width (sum ' + sum + ')');
    const share = r.cols.map((w) => w / sum);
    const mSum = r.measured.reduce((x, y) => x + y, 0);
    const want = r.measured.map((w) => w / mSum);
    ok(share.every((v, i) => Math.abs(v - want[i]) < 0.02), 'column shares follow the measured live widths: ' + share.map((v) => v.toFixed(3)).join(' / ') + ' vs ' + want.map((v) => v.toFixed(3)).join(' / '));
    ok(Math.abs(want[0] - 0.1) > 0.05, 'the measured first column differs from the colgroup 10% (' + want[0].toFixed(3) + '), so the test tells the two apart');
    // Two-block cell: the span keeps orange and bold, the div keeps black and is not bold.
    ok(r.aOrange && r.aBold, 'first block of the two-block cell keeps orange and bold');
    ok(r.bBlack && !r.bBold, 'second block of the two-block cell is black, not bold');
    // A report that is not an ASHRAE 36 report keeps the table default margins (no per-cell padding).
    const n = await run(false);
    ok(n.margins.length === 0, 'a non-ASHRAE 36 report gets no per-cell w:tcMar (' + n.margins.length + ')');
  } finally { await ctx.close(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
