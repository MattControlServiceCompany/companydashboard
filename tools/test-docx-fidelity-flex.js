// tools/test-docx-fidelity-flex.js: the Word file lays out a flex row and inline spans as the PDF page does.
// Run: CH_TMP_ROOT=<scratch> node tools/test-docx-fidelity-flex.js
// Synthetic markup only, in headless bundled Chromium: the live copy is stamped (_docxStampLiveStyles) and translated (_docxTranslatePages).
//   (a) a flex row with three fixed-width children and one growing child: cell widths follow the page, not equal.
//   (b) inline spans with a margin between them keep a separator in the Word text.
//   (c) left-aligned text in a flex row stays left; a centered cell stays centered.
//   (d) a picture line in a table cell has no space after it (the readiness table's score bar).
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('docx-fidelity-flex');
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _docxTranslatePages === 'function' && typeof _docxStampLiveStyles === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.cssText = 'width:700px';
      const ring = '<div style="text-align:center"><div style="width:70px;height:77px">R</div></div>';
      host.innerHTML = '<div class="rpt-page"><div class="rpt-body">' +
        '<div style="display:flex;gap:14px;margin-bottom:12px;align-items:center">' + ring + ring + ring +
        '<div style="flex:1"><h2 style="margin:0 0 4px 0">Blue Valley</h2>' +
        '<div style="font-size:11px;margin-bottom:6px">26 equipment units audited</div>' +
        '<div style="margin-bottom:4px"><span style="font-size:10px;margin-right:8px">1 Air Handlers</span><span style="font-size:10px;margin-right:8px">19 Dual-Duct Terminals</span><span style="font-size:10px;margin-right:8px">2 Variable Air Volume Terminals</span></div>' +
        '<span style="font-size:10px">High Readiness<br>129/152 sensors<br>28/48 sequences</span></div></div>' +
        '<div style="display:flex"><div style="text-align:center">Mid</div><div style="width:200px;text-align:right">Right</div></div>' +
        '<table class="rpt-table"><tbody><tr><td>Name</td><td><div><img alt="bar" style="width:40px;height:8px" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">79%</div></td></tr></tbody></table>' +
        '</div></div>';
      document.body.appendChild(host);
      const live = host.firstChild;
      const clone = live.cloneNode(true);
      _docxStampLiveStyles(live, clone);
      const xml = _docxTranslatePages([clone]).xml;
      const tbls = xml.split('<w:tbl>').slice(1);
      const grid = (t) => (t.match(/<w:gridCol w:w="(\d+)"/g) || []).map((x) => +x.replace(/\D/g, ''));
      const text = (t) => (t.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('');
      const jcOf = (t, word) => {
        const p = t.split('<w:p>').find((x) => x.indexOf('>' + word) > -1);
        const m = p && /<w:jc w:val="(\w+)"/.exec(p);
        return m ? m[1] : null;
      };
      return { grid: grid(tbls[0]), text: text(tbls[0]), grid2: grid(tbls[1]), jcName: jcOf(tbls[0], 'Blue Valley'), jcUnits: jcOf(tbls[0], '26 equipment'), jcMid: jcOf(tbls[1], 'Mid'), jcRight: jcOf(tbls[1], 'Right'), cellMar: /<w:tblCellMar>/.test(tbls[0]), barAfter: (tbls[2].split('<w:p>').find((p) => p.indexOf('<w:drawing') > -1).match(/<w:spacing[^>]*w:after="(\d+)"/) || [])[1] };
    });
    if (process.env.DUMP) console.log(JSON.stringify(r));
    const g = r.grid;
    ok(g.length === 4, 'four columns: ' + g.join(','));
    ok(g[0] === g[1] && g[1] === g[2] && g[3] > 2 * g[0], 'three equal ring cells and a wider text cell: ' + g.join(','));
    ok(g[0] < 10080 / 4 - 200, 'the ring cells are narrower than an equal split (' + g[0] + ' < ' + (10080 / 4) + ')');
    ok(g.reduce((a, b) => a + b, 0) === 10080, 'the columns add up to the text width: ' + g.reduce((a, b) => a + b, 0));
    ok(r.grid2.length === 2 && r.grid2[1] > 2000 && r.grid2[1] < 3200 && r.grid2[0] < 800, 'a packed row keeps the page widths (200px cell = about 2900 twips), not an equal split: ' + r.grid2.join(','));
    ok(/1 Air Handlers\s+19 Dual-Duct Terminals\s+2 Variable Air Volume Terminals/.test(r.text), 'inline spans keep a separator: ' + r.text.slice(0, 200));
    ok(!/Handlers19/.test(r.text), 'the type counts do not run together');
    ok(r.jcName === 'left' || r.jcName === null, 'the building name stays left: ' + r.jcName);
    ok(r.jcUnits === 'left' || r.jcUnits === null, 'the units line stays left: ' + r.jcUnits);
    ok(r.jcMid === 'center', 'a centered cell stays centered: ' + r.jcMid);
    ok(r.barAfter === '0', 'the score bar line in a table cell has 0 after: ' + r.barAfter);
    ok(r.jcRight === 'right', 'a right cell stays right: ' + r.jcRight);
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
