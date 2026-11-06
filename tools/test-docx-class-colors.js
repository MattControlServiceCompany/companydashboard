// tools/test-docx-class-colors.js: a colour that comes from a CSS class (.rpt-g green, .rpt-r red) reaches the Word file as a w:color run.
// Run: CH_TMP_ROOT=<scratch> node tools/test-docx-class-colors.js
// Synthetic markup only, in headless bundled Chromium: the live copy is stamped (_docxStampLiveStyles) and translated (_docxTranslatePages).
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('docx-class-colors');
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _docxTranslatePages === 'function' && typeof _docxStampLiveStyles === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<div class="rpt-page"><div class="rpt-body"><div class="rpt-g">Alpha</div><div class="rpt-r">Beta</div>' +
        '<table class="rpt-table"><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gamma</td><td class="rpt-g">Delta</td></tr><tr><td>Epsilon</td><td class="rpt-r">Zeta</td></tr></tbody></table></div></div>';
      document.body.appendChild(host);
      const live = host.firstChild;
      const clone = live.cloneNode(true);
      _docxStampLiveStyles(live, clone);
      const xml = _docxTranslatePages([clone]).xml;
      const colorOf = (word) => {
        const run = xml.split('<w:r>').find((x) => x.indexOf('>' + word + '</w:t>') > -1);
        const m = run && /<w:color w:val="([0-9A-F]{6})"/.exec(run);
        return m ? m[1] : null;
      };
      const live2 = (sel) => _docxCssColorToHex(getComputedStyle(host.querySelector(sel)).color);
      return { xml: xml.slice(0,300), alpha: colorOf('Alpha'), beta: colorOf('Beta'), delta: colorOf('Delta'), zeta: colorOf('Zeta'), g: live2('div.rpt-g'), rr: live2('div.rpt-r') };
    });
    if (process.env.DUMP) console.log(r.xml);
    ok(r.g && r.rr && r.g !== r.rr, 'the live green and red differ: ' + r.g + ' / ' + r.rr);
    ok(r.alpha === r.g, 'green div has the green run colour: ' + r.alpha);
    ok(r.beta === r.rr, 'red div has the red run colour: ' + r.beta);
    ok(r.delta === r.g, 'green table cell has the green run colour: ' + r.delta);
    ok(r.zeta === r.rr, 'red table cell has the red run colour: ' + r.zeta);
  } finally { await ctx.close(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
