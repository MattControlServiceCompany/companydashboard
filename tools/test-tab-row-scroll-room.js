// tools/test-tab-row-scroll-room.js - GATE (Matt, 2026-10-29): the project tab row scrolls sideways, and its scrollbar must
// sit BELOW the tab labels (own space), never over the label text. The row must stay ONE row (no wrapping).
// Checks at 1536 px and 640 px: (1) every tab label box is on one line (same top within 2 px); (2) the horizontal scrollbar
// strip (bottom of #hdrTabs minus the scrollbar thickness) starts at or below the bottom of every label box, and the row keeps
// >= 10 px of its own space under the labels (an overlay scrollbar takes no layout space and would cover them);
// (3) the row really does scroll sideways (scrollWidth > clientWidth), so the check is not vacuous.
// SYNTHETIC data only. Run: node tools/test-tab-row-scroll-room.js   (CH_GATE_BROWSER=firefox for Firefox)
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { fastNet } = require(path.join(ROOT, 'tools', 'pdf-test-net.js'));
const BROWSER = process.env.CH_GATE_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const PID = 999000778;

async function launch(task, opts) {
  if (BROWSER === 'chromium') return require(path.join(ROOT, 'tools', 'launch-browser.js')).launchBrowser(task, opts);
  const dir = 'C:/Temp/' + (process.env.CH_GATE_TAG ? process.env.CH_GATE_TAG + '-' : '') + task + '-ff-profile-' + Date.now() + '-' + process.pid;
  const ctx = await require('playwright').firefox.launchPersistentContext(dir, Object.assign({ headless: true }, opts));
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    try { await close(); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
  };
  return ctx;
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/energy-department.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.normalize(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

// headless Chromium hides scrollbars by default; ignoreDefaultArgs brings back the real ones so the check is meaningful.
function measure() {
  const nav = document.getElementById('hdrTabs');
  const tabs = [...document.querySelectorAll('#pdTabBar button[data-tab]')].filter((b) => b.offsetWidth > 0);
  const cs = getComputedStyle(nav);
  const nr = nav.getBoundingClientRect();
  const bw = parseFloat(cs.borderBottomWidth) || 0;
  const sbThick = nav.offsetHeight - nav.clientHeight - (parseFloat(cs.borderTopWidth) || 0) - bw;
  const sbTop = nr.bottom - bw - sbThick;
  const clientBottom = nr.top + (parseFloat(cs.borderTopWidth) || 0) + nav.clientHeight; // above any classic scrollbar
  const tops = tabs.map((b) => b.getBoundingClientRect().top);
  const maxBottom = Math.max(...tabs.map((b) => b.getBoundingClientRect().bottom));
  return {
    n: tabs.length, reserve: clientBottom - Math.max(...tabs.map((b) => b.getBoundingClientRect().bottom)), scrolls: nav.scrollWidth > nav.clientWidth, sbThick, sbTop, maxBottom,
    oneRow: Math.max(...tops) - Math.min(...tops) <= 2,
  };
}

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}/`;
  const fails = [];
  const ctx = await launch('tab-row-scroll-room', { viewport: { width: 1536, height: 900 }, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    await fastNet(ctx);
    const page = await ctx.newPage();
    await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
    await ctx.addInitScript((a) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('en_projects', JSON.stringify([{ id: a.pid, name: 'SYNTHETIC', client: 'S', customerId: 'cust_s', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } }]));
      localStorage.setItem('en_customers', JSON.stringify([{ id: 'cust_s', name: 'Synth Customer' }]));
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, rnShowMode: 'never' }));
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    }, { pid: PID });
    await page.goto(base + 'energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof openDetail === 'function' && window.CH_AUTH, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => sv('projects', document.querySelector('.s-item[onclick*="\'projects\'"]')));
    await page.waitForTimeout(500);
    await page.evaluate((id) => openDetail(id), PID);
    await page.waitForTimeout(800);
    for (const w of [1536, 640]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(500);
      const m = await page.evaluate(measure);
      console.log(BROWSER + ' @' + w + ': ' + JSON.stringify(m));
      if (m.n < 10) fails.push('@' + w + ' only ' + m.n + ' tabs found (expected the full tab row)');
      if (!m.scrolls) fails.push('@' + w + ' tab row does not scroll sideways (check is vacuous)');
      if (!m.oneRow) fails.push('@' + w + ' tab row is not one row (tabs wrapped)');
      // Overlay scrollbars (Windows default) take no layout space, so the row itself must keep >= 10 px free under the labels.
      if (m.reserve < 10) fails.push('@' + w + ' only ' + m.reserve + ' px free under the labels (need >= 10 for the scrollbar)');
      if (m.sbTop < m.maxBottom - 0.5) fails.push('@' + w + ' scrollbar strip starts at y=' + m.sbTop + ' but labels end at y=' + m.maxBottom + ' (scrollbar covers label text)');
    }
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log('tab row scroll-room failures: ' + fails.length);
  fails.forEach((f) => console.log('  FAIL ' + f));
  if (fails.length) process.exit(1);
  console.log('PASS');
})().catch((e) => { console.log('ERROR ' + e.stack); try { srv.close(); } catch (x) {} process.exit(2); });
