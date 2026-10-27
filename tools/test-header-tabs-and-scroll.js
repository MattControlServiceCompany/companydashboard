/**
 * test-header-tabs-and-scroll.js
 *
 * SYNTHETIC data only, headless bundled Chromium. Checks the one-row page header and the tab scroll rule:
 *  1. With a project open, the project tabs are in the header (#pdTabBar inside .topbar), text only, no scroll arrows,
 *     every tab inside the window, and the department tab is hidden.
 *  2. After Back, the department tab shows again and the tab bar is hidden.
 *  3. Energy Graphics -> Project Performance -> Energy Graphics: the tab card keeps its flex column layout
 *     (toggleProjDetailPanel used to clear display to '' and leave a block box, so the tab pane grew to its content
 *     and the page could not scroll), and a tall pane is clipped to the card so it can scroll.
 *
 * Usage: node tools/test-header-tabs-and-scroll.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { launchBrowser } = require('./launch-browser');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const PID = 990000111;

let failed = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + (extra || '')));
  if (!ok) failed++;
}

(async () => {
  const srv = http.createServer((q, r) => {
    const f = path.join(REPO, decodeURIComponent(q.url.split('?')[0]));
    if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const ctx = await launchBrowser('header-tabs', { viewport: { width: 1280, height: 800 } });
  try {
    const seed = {
      en_projects: [{ id: PID, name: 'SAMPLE PROJECT', client: 'Sample', customerId: 'cust_' + PID, status: 'active', scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } }],
      en_customers: [{ id: 'cust_' + PID, name: 'Sample' }],
      ch_settings: { showQuickStart: false },
      ch_activeView: 'projects',
      ch_user: { name: 'sample@example.com', email: 'sample@example.com', initials: 'S', isReal: false },
    };
    await ctx.addInitScript((d) => {
      if (!localStorage.getItem('__seeded')) { for (const k in d) localStorage.setItem(k, JSON.stringify(d[k])); localStorage.setItem('__seeded', '1'); }
    }, seed);
    const page = await ctx.newPage();
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(2500);
    await page.evaluate((p) => openDetail(p), PID);
    await page.waitForTimeout(800);

    const h = await page.evaluate(() => {
      const bar = document.getElementById('pdTabBar');
      const vw = document.documentElement.clientWidth;
      const tabs = [...bar.querySelectorAll('.pdt')];
      return {
        inHeader: !!bar.closest('.topbar'),
        n: tabs.length,
        outside: tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.left < -0.5 || r.right > vw + 0.5; }).length,
        icons: bar.querySelectorAll('.pdt-ico, img, svg').length,
        arrows: document.querySelectorAll('.pd-tabs-arrow, .pd-tabs-fade, .pd-tabs-wrap, .dept-nav').length,
        scrolls: bar.scrollWidth > bar.clientWidth + 1,
        deptHidden: getComputedStyle(document.getElementById('hdrDeptTab')).display === 'none',
      };
    });
    check('tabs are in the header row', h.inHeader && h.n > 10);
    check('every tab is inside the window', h.outside === 0, JSON.stringify(h));
    check('text only, no scroll arrows or old tab row', h.icons === 0 && h.arrows === 0);
    check('tab bar does not scroll sideways', !h.scrolls);
    check('department tab hidden while a project is open', h.deptHidden);

    // Energy Graphics -> Project Performance -> Energy Graphics
    await page.click('#pdTabBar .pdt[data-tab="energygfx"]');
    await page.waitForTimeout(500);
    await page.click('#pd-proj-perf-btn-' + PID);
    await page.waitForTimeout(500);
    await page.click('#pdTabBar .pdt[data-tab="energygfx"]');
    await page.waitForTimeout(500);
    const s = await page.evaluate((p) => {
      const card = document.getElementById('pd-tabs-card-' + p);
      const pane = document.getElementById('ptab-energygfx');
      // make the pane tall and see that it is clipped to the card, so it can scroll
      const pad = document.createElement('div'); pad.style.height = '5000px'; pane.appendChild(pad);
      const out = { cardDisplay: getComputedStyle(card).display, paneClient: pane.clientHeight, paneScroll: pane.scrollHeight, cardH: card.getBoundingClientRect().height };
      pad.remove();
      return out;
    }, PID);
    check('tab card keeps its flex layout after the panel closes', s.cardDisplay === 'flex', JSON.stringify(s));
    check('a tall tab pane is clipped to the card and scrolls', s.paneClient <= s.cardH + 1 && s.paneScroll > s.paneClient + 100, JSON.stringify(s));
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);

    // Back restores the department tab
    await page.evaluate(() => backToList());
    await page.waitForTimeout(200);
    const b = await page.evaluate(() => ({
      dept: getComputedStyle(document.getElementById('hdrDeptTab')).display !== 'none',
      bar: getComputedStyle(document.getElementById('pdTabBar')).display !== 'none',
    }));
    check('Back shows the department tab and hides the project tabs', b.dept && !b.bar, JSON.stringify(b));
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(failed ? 'FAILED ' + failed : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
