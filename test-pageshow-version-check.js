// Real-browser test (headless bundled Chromium, local static server, synthetic version text, no real data):
// a Back/Forward restore from the page cache (pageshow with persisted=true) checks the live version.
//  1. same version        -> one site-ui.js check, NO second document load
//  2. persisted=false     -> no check at all
//  3. new version served  -> no reload while the user is on the page; the page reloads once the user is away (second document load)
//  4. check fails (500)   -> no reload
// Run: node test-pageshow-version-check.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const http = require('http');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let mode = 'same'; // same | new | fail
let docLoads = 0;
let verChecks = 0;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const f = path.join(__dirname, decodeURIComponent(u));
  if (!f.startsWith(__dirname)) return res.writeHead(403).end();
  if (u === '/energy-department.html') docLoads++;
  fs.readFile(f, 'utf8', (e, d) => {
    if (e) return res.writeHead(404).end();
    if (u === '/site-ui.js') {
      verChecks++;
      if (mode === 'fail') return res.writeHead(500).end();
      if (mode === 'new') d = d.replace(/CH_VERSION\s*=\s*'[^']+'/, "CH_VERSION = 'v9999.01.01.1'");
    }
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
});
let pass = 0;
let fail = 0;
function ok(c, l) {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL ' + l);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let ctx;
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  try {
    ctx = await launchBrowser('pageshow-version', { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const fire = (persisted) => page.evaluate((p) => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: p })), persisted);
    await page.goto('http://127.0.0.1:' + web.address().port + '/energy-department.html');
    await wait(2500);
    ok(docLoads === 1, 'one document load at start');

    let v0 = verChecks;
    await fire(false);
    await wait(800);
    ok(verChecks === v0, 'persisted=false: no version check');

    v0 = verChecks;
    await fire(true);
    await wait(4500);
    ok(verChecks === v0 + 1, 'same version: one version check (not held back by the 60 s gap)');
    ok(docLoads === 1, 'same version: no second document load');

    mode = 'fail';
    v0 = verChecks;
    await fire(true);
    await wait(4500);
    ok(verChecks === v0 + 1, 'failed check: the check ran');
    ok(docLoads === 1, 'failed check: no reload');

    // Rule since v.270 (tools/test-update-reload-state.js owns it): the update reload runs only while the user is away.
    mode = 'new';
    await fire(true);
    await wait(6000);
    ok(docLoads === 1, 'new version served, user still on the page: no reload');
    const secondLoad = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => null);
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await secondLoad;
    ok(docLoads === 2, 'new version served, user away: the page reloaded (second document load)');
  } finally {
    if (ctx) await ctx.close();
    web.close();
  }
  console.log(fail ? 'FAILED ' + fail + ' (passed ' + pass + ')' : 'ALL PASS (' + pass + ')');
  process.exit(fail ? 1 : 0);
})();
