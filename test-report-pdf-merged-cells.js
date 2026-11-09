// Real-browser test (headless bundled Chromium, synthetic table, no real data):
// _rptPdfFlattenTables (app/report-pdf.js) must give a table with a rowspan cell solid, straight borders
// in the PDF raster. html2canvas paints a row background over the lower half of a merged cell, and the old
// code matched neighbours by position in the row, not by grid slot.
// Run: node test-report-pdf-merged-cells.js
const { launchBrowser } = require('./tools/launch-browser.js');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app', 'report-pdf.js'), 'utf8');
const a = src.indexOf('function _rptPdfFlattenTables');
const b = src.indexOf('async function downloadReportPdf');
let pass = 0;
let fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.log('FAIL ' + l); } }
(async () => {
  if (a < 0 || b < a) { console.log('FAIL flatten function not found'); process.exit(1); }
  const ctx = await launchBrowser('pdf-merged-cells', { viewport: { width: 800, height: 600 } });
  try {
    const page = await ctx.newPage();
    await page.setContent('<style>table{border-collapse:collapse}td{border:1px solid #333;padding:4px}</style>' +
      '<div id="r"><table><tr style="background:#f8fafb"><td rowspan="2" id="m" style="background:#f8fafb">B</td><td id="p1">Base</td><td>1</td></tr>' +
      '<tr style="background:#f8fafb"><td id="p2">Act</td><td>2</td></tr>' +
      '<tr><td id="n" rowspan="2">C</td><td id="p3">Base</td><td>3</td></tr><tr><td id="p4">Act</td><td>4</td></tr></table></div>');
    const r = await page.evaluate((fn) => {
      (0, eval)(fn);
      const root = document.getElementById('r');
      _rptPdfFlattenTables(root, window);
      const g = (id) => getComputedStyle(document.getElementById(id));
      const rows = root.querySelectorAll('tr');
      return {
        mLeft: g('m').borderLeftWidth, mRight: g('m').borderRightWidth, mTop: g('m').borderTopWidth, mBottom: g('m').borderBottomWidth,
        p1Left: g('p1').borderLeftWidth, p2Left: g('p2').borderLeftWidth, p4Left: g('p4').borderLeftWidth,
        p2Top: g('p2').borderTopWidth, p3Top: g('p3').borderTopWidth,
        rowBg: [...rows].map((t) => getComputedStyle(t).backgroundColor),
        p2Bg: g('p2').backgroundColor,
      };
    }, src.slice(a, b));
    ok(r.mLeft === '1px' && r.mRight === '1px' && r.mTop === '1px' && r.mBottom === '1px', 'merged cell keeps all four borders');
    ok(r.p1Left === '0px' && r.p2Left === '0px' && r.p4Left === '0px', 'cells right of a merged cell draw no left border (both rows)');
    ok(r.p2Top === '0px', 'cell below a cell in the same column draws no top border');
    ok(r.p3Top === '0px', 'cell below a merged cell draws no top border');
    ok(r.rowBg[0] === 'rgba(0, 0, 0, 0)' && r.rowBg[1] === 'rgba(0, 0, 0, 0)', 'row backgrounds are cleared (they would paint over a merged cell)');
    ok(r.p2Bg === 'rgb(248, 250, 251)', 'row background moved onto the cells of the row');
  } finally {
    await ctx.close();
  }
  console.log('pass ' + pass + ' fail ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
