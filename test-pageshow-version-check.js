// Real-browser test (headless bundled Chromium, local static server, synthetic version text, no real data):
// a Back/Forward restore from the page cache (pageshow with persisted=true) checks the live version.
//  1. same version        -> one site-ui.js check, NO second document load
//  2. persisted=false     -> no check at all
//  3. new version served  -> no swap while the user is on the page; once the user is away the new frame takes the place of the old one (no reload of the top page)
//  4. check fails (500)   -> no swap
// The app runs in the frame of the update shell (?shell=1), so the page is loaded twice at start (the shell and its frame).
// Run: node test-pageshow-version-check.js
const { launchBrowser } = require('./tools/launch-browser.js');
const { seed, SEED } = require('./tools/update-test-helpers.js');
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
    await ctx.addInitScript(seed, SEED); // a signed-in synthetic user: a frame that shows the sign-in page never reports ready
    const page = await ctx.newPage();
    const frame = () => page.frames().filter((f) => f.parentFrame() === page.mainFrame()).slice(-1)[0];
    const fire = (persisted) => frame().evaluate((p) => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: p })), persisted);
    await page.goto('http://127.0.0.1:' + web.address().port + '/energy-department.html?shell=1');
    await wait(3500);
    ok(docLoads === 2, 'two document loads at start (the shell and its frame)');

    let v0 = verChecks;
    await fire(false);
    await wait(800);
    ok(verChecks === v0, 'persisted=false: no version check');

    v0 = verChecks;
    await fire(true);
    await wait(4500);
    ok(verChecks === v0 + 1, 'same version: one version check (not held back by the 60 s gap)');
    ok(docLoads === 2, 'same version: no second document load');

    mode = 'fail';
    v0 = verChecks;
    await fire(true);
    await wait(4500);
    ok(verChecks === v0 + 1, 'failed check: the check ran');
    ok(docLoads === 2, 'failed check: no swap');

    // The update swap (tools/test-update-reload-state.js owns the rule): it runs only while the user is away or changing page.
    mode = 'new';
    await fire(true);
    await wait(6000);
    ok(docLoads === 2, 'new version served, user still on the page: no swap');
    let topNavs = 0;
    page.on('framenavigated', (f) => f === page.mainFrame() && topNavs++);
    await frame().evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    for (let i = 0; i < 150 && docLoads < 3; i++) await wait(100);
    for (let i = 0; i < 200 && page.frames().filter((f) => f.parentFrame() === page.mainFrame()).length !== 1; i++) await wait(100);
    ok(docLoads === 3, 'new version served, user away: the new frame loaded the page (third document load)');
    ok(page.frames().filter((f) => f.parentFrame() === page.mainFrame()).length === 1, 'new version served, user away: one frame after the swap');
    ok(topNavs === 0, 'new version served, user away: the top page did not navigate');
  } finally {
    if (ctx) await ctx.close();
    web.close();
  }
  console.log(fail ? 'FAILED ' + fail + ' (passed ' + pass + ')' : 'ALL PASS (' + pass + ')');
  process.exit(fail ? 1 : 0);
})();
