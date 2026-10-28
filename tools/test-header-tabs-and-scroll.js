/**
 * test-header-tabs-and-scroll.js
 *
 * SYNTHETIC data only, headless bundled Chromium. Checks the two-row page header (row 1 project info, row 2 tab strip) and the tab scroll rule:
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
    check('text only tabs, no old arrow/fade elements or old tab row', h.icons === 0 && h.arrows === 0);
    // Page never scrolls sideways at 1280 or 640; at 640 the tab strip scrolls inside itself.
    for (const w of [1280, 640]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({
        pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOver: document.body.scrollWidth - document.documentElement.clientWidth,
        stripScrolls: document.getElementById('hdrTabs').scrollWidth > document.getElementById('hdrTabs').clientWidth + 1,
        stripOverflowX: getComputedStyle(document.getElementById('hdrTabs')).overflowX,
      }));
      check('page has no sideways scroll at ' + w + ' px', m.pageOver <= 0 && m.bodyOver <= 0, JSON.stringify(m));
      if (w === 640) check('tab strip scrolls inside itself at 640 px', m.stripScrolls && m.stripOverflowX === 'auto', JSON.stringify(m));
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    // Tab look: active tab background equals the content panel background; no bottom border; rounded top; inactive differs.
    const tl = await page.evaluate((p) => {
      const act = document.querySelector('#pdTabBar .pdt.active');
      const idle = document.querySelector('#pdTabBar .pdt:not(.active)');
      const panel = document.getElementById('pd-tabs-card-' + p);
      const a = getComputedStyle(act), i = getComputedStyle(idle);
      return { actBg: a.backgroundColor, panelBg: getComputedStyle(panel).backgroundColor, idleBg: i.backgroundColor, actBB: a.borderBottomWidth, idleBB: i.borderBottomWidth, radius: a.borderTopLeftRadius, topW: a.borderTopWidth, text: a.color };
    }, PID);
    check('active tab background equals the content panel background', tl.actBg === tl.panelBg, JSON.stringify(tl));
    check('inactive tab is a different background than the active tab', tl.idleBg !== tl.actBg, JSON.stringify(tl));
    check('tab has rounded top corners, a top border and no bottom border', parseFloat(tl.radius) >= 6 && parseFloat(tl.topW) >= 1 && tl.actBB === '0px' && tl.idleBB === '0px', JSON.stringify(tl));
    check('department tab hidden while a project is open', h.deptHidden);
    const rows = await page.evaluate(() => {
      const info = document.getElementById('hdrProjBar').getBoundingClientRect();
      const tabs = document.getElementById('hdrTabs').getBoundingClientRect();
      return { infoBottom: info.bottom, tabsTop: tabs.top, infoH: info.height, name: /\S/.test(document.querySelector('#hdrProjBar .phc-name')?.textContent || '') };
    });
    check('project info bar is on row 1, tab strip under it', rows.infoH > 0 && rows.tabsTop >= rows.infoBottom - 1 && rows.name, JSON.stringify(rows));

    const u = await page.evaluate(() => ({ t: document.getElementById('topName').textContent, title: document.getElementById('topUser').title, shown: getComputedStyle(document.getElementById('topUser')).display !== 'none' }));
    check('top bar shows an initials badge with the full email on hover', u.t === 'SA' && u.title === 'sample@example.com' && u.shown, JSON.stringify(u));

    // Account menu on the initials badge.
    const closedAtStart = await page.evaluate(() => document.getElementById('userMenu').hidden);
    check('account menu is closed at start and the old Sign Out button is gone', closedAtStart && (await page.evaluate(() => !document.querySelector('.signout') && !/Sign Out/.test(document.querySelector('.topbar').textContent))));
    await page.setViewportSize({ width: 640, height: 800 });
    await page.click('#topUser');
    const mn = await page.evaluate(() => {
      const m = document.getElementById('userMenu'); const r = m.getBoundingClientRect();
      return { open: !m.hidden, exp: document.getElementById('topUser').getAttribute('aria-expanded'), items: [...m.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim()), email: document.getElementById('userMenuEmail').textContent, left: r.left, right: r.right, vw: document.documentElement.clientWidth, focus: document.activeElement && document.activeElement.textContent.trim() };
    });
    check('menu opens with the full email and Switch or add account, Log out', mn.open && mn.exp === 'true' && mn.email === 'sample@example.com' && mn.items.join('|') === 'Switch or add account|Log out', JSON.stringify(mn));
    check('menu stays on screen at 640 px', mn.left >= 0 && mn.right <= mn.vw, JSON.stringify(mn));
    check('keyboard: first item focused on open', mn.focus === 'Switch or add account', JSON.stringify(mn));
    await page.keyboard.press('ArrowDown');
    check('keyboard: ArrowDown moves to the next item', (await page.evaluate(() => document.activeElement.textContent.trim())) === 'Log out');
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({ hidden: document.getElementById('userMenu').hidden, onBtn: document.activeElement.id }));
    check('Esc closes the menu and returns focus to the badge', esc.hidden && esc.onBtn === 'topUser', JSON.stringify(esc));
    await page.click('#topUser');
    await page.mouse.click(300, 600);
    check('outside click closes the menu', await page.evaluate(() => document.getElementById('userMenu').hidden));
    await page.keyboard.press('Tab');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);

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
      bar: getComputedStyle(document.getElementById('hdrTabs')).display !== 'none',
    }));
    check('Back shows the department tab and hides the project tabs', b.dept && !b.bar, JSON.stringify(b));
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(failed ? 'FAILED ' + failed : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
