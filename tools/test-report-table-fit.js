// tools/test-report-table-fit.js — quarterly report tables: no cell text runs past its cell or the page margin.
// Run: CH_TMP_ROOT=<scratch> node tools/test-report-table-fit.js
// Builds the Appendix D bill table and the Electricity by Building table with the report's own column widths and
// worst-case SYNTHETIC text (long building names, full date ranges, 7 digit totals) on a real report page in headless
// bundled Chromium, in screen media (the print path is checked by rendering the real PDF). Fails when a cell's text is wider than the cell,
// when a number or date wraps, or when a table reaches past the page margin.
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
  const ctx = await launchBrowser('report-table-fit');
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptQTable === 'function' && typeof rptPage === 'function', null, { timeout: 30000 });
    for (const media of ['screen']) {
      await page.emulateMedia({ media });
      const res = await page.evaluate(() => {
        const names = ['Test High School', 'Sample Valley Elementary School', 'Example Meadow Grove Elementary School', 'Demo Ridge Elementary School', 'Test Field House'];
        const bills = names
          .map((n) => ['Electricity', 'Natural gas'].map((u) => '<tr><td>' + n + '</td><td>' + u + '</td><td>City Gas Utility</td><td class="rpt-n" style="padding-left:10px">146,462 kWh</td><td class="rpt-n">476</td><td class="rpt-n">$18,236</td><td style="padding-left:12px;white-space:nowrap">12/29/2026&ndash;12/29/2026</td></tr>').join(''))
          .join('');
        const t1 = _rptQTable(_RPT_Q_W_BILLS, ['Building', 'Utility', 'Provider', 'Use', 'Billed kW', 'Cost', 'Billing period'], bills + '<tr class="rpt-tot"><td colspan="5">Total, July 2026</td><td class="rpt-n">$48,735</td><td></td></tr>', [1, 2, 6]);
        const e = (n, v) => '<tr><td>' + n + '</td>' + v.map((x) => '<td class="rpt-n">' + x + '</td>').join('') + '</tr>';
        const vals = ['1,225,480', '1,225,480', '-100.0%', '12,345', '12,345', '$188,236', '$188,236', '$188,236'];
        const t2 = _rptQTable(
          _RPT_Q_W_FUEL_ELEC,
          ['Building', 'Baseline kWh', 'Actual kWh', 'Change percent', 'Baseline billed kW', 'Actual billed kW', 'Baseline cost', 'Actual cost', 'Savings'],
          names.map((n) => e(n, vals)).join('') + '<tr class="rpt-tot"><td>Total</td>' + vals.map((x) => '<td class="rpt-n">' + x + '</td>').join('') + '</tr>',
        );
        const host = document.createElement('div');
        host.id = 'reportPages';
        host.innerHTML = rptPage(1, 'Fit test', t1, { letterhead: false }) + rptPage(2, 'Fit test', t2, { letterhead: false });
        document.body.appendChild(host);
        const bad = [];
        host.querySelectorAll('.rpt-page').forEach((pg) => {
          const pr = pg.getBoundingClientRect();
          pg.querySelectorAll('table').forEach((tb) => {
            const tr = tb.getBoundingClientRect();
            if (tr.right > pr.right - 20 || tr.left < pr.left + 20) bad.push('table outside margin ' + Math.round(pr.width) + 'w ' + Math.round(tr.left - pr.left) + '..' + Math.round(pr.right - tr.right));
            tb.querySelectorAll('td,th').forEach((c) => {
              const r = document.createRange();
              r.selectNodeContents(c);
              const cr = c.getBoundingClientRect();
              const cs = getComputedStyle(c);
              const inner = cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
              const txt = c.textContent.trim();
              const rects = [...r.getClientRects()];
              const maxR = Math.max(...rects.map((x) => x.right), 0);
              if (txt && (maxR > cr.right + 0.5 || c.scrollWidth > c.clientWidth + 1)) bad.push('overflow: ' + txt);
              if (txt && c.matches('td.rpt-n,td[style*="nowrap"]') && rects.length > 1 && new Set(rects.map((x) => Math.round(x.top))).size > 1) bad.push('wrapped: ' + txt);
              if (txt && c.tagName === 'TD' && c.classList.contains('rpt-n') && Math.max(...rects.map((x) => x.width), 0) > inner + 0.5) bad.push('wider than cell: ' + txt + ' ' + Math.round(Math.max(...rects.map((x) => x.width))) + '>' + Math.round(inner));
            });
          });
        });
        host.remove();
        return bad;
      });
      ok(res.length === 0, 'no cell overflows or wraps a number/date (' + media + '): ' + [...new Set(res)].slice(0, 6).join(' | '));
    }
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e);
  process.exit(1);
});
