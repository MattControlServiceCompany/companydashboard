// Layout test: nothing sits over the page or the tabs, and the page uses the full window height.
// Synthetic data, headless bundled Chromium, file://. Pending conflict entry + pending remote change + a notice are shown.
// Run: node test-no-overlay-layout.js [outDir]   (outDir: saves layout-*.png)
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const OUT = process.argv[2] || '';
const PID = 999000555;
const failures = [];
(async () => {
  for (const vp of [{ width: 1920, height: 1080 }, { width: 960, height: 1080 }]) {
    const ctx = await launchBrowser('overlay-layout', { viewport: vp });
    try {
      const page = await ctx.newPage();
      const seed = {
        en_projects: [{ id: PID, name: 'SYNTH LAYOUT', client: 'Synth', customerId: 'cust_' + PID, status: 'active', scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } }],
        en_customers: [{ id: 'cust_' + PID, name: 'Synth Customer' }],
        en_conflict_archive: [{ key: 'en_tasks', reason: 'write-conflict-server-wins', losingSide: 'local', losingValue: [], archivedAt: '2026-11-02T10:05:00' }],
        ch_settings: { showQuickStart: false }, ch_theme: 'dark', ch_activeView: 'projects',
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      };
      await ctx.addInitScript((d) => {
        if (!window.localStorage.getItem('__seeded')) {
          for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
          window.localStorage.setItem('__seeded', '1');
        }
      }, seed);
      await page.goto(SITE);
      await page.waitForTimeout(2500);
      await page.evaluate((pid) => {
        openDetail(pid);
        addUDBldg('cust_' + pid, { id: 'synb1', name: 'Synth Hall', sqft: 1000, meters: [{ id: 'synm1', commodity: 'Gas', bills: [
          { id: 'synr1', start: '2025-01-01', end: '2025-01-31', commodity: 'Gas', naturalGasTherms: '500', gasCharge: '400.00', totalCost: '400.00', utilityCompany: 'Synth Gas' } ] }] });
        projects.find((x) => x.id === pid).scope.buildingIds.push('synb1');
      }, PID);
      // a pending remote change (db.js announces dbRemoteApplied) and a notice in the stack
      await page.evaluate(async (pid) => {
        const d = window.dispatchEvent;
        window.dispatchEvent = (ev) => (ev.type === 'dataUpdated' ? true : d.call(window, ev));
        try { await DB.set('en_tasks', []); } finally { window.dispatchEvent = d; }
        window.dispatchEvent(new CustomEvent('dbRemoteApplied', { detail: { keys: ['en_tasks'] } }));
        window.dispatchEvent(new CustomEvent('chArchiveChanged'));
        if (window.SyncConflictUI && window.SyncConflictUI.refreshArchiveLink) window.SyncConflictUI.refreshArchiveLink();
        _showVersionUpdateBanner('9.9.9');
      }, PID);
      const tabs = ['dashboard', 'utility-norm', 'eq-matrix', 'cost-estimate'];
      for (const t of tabs) {
        await page.evaluate(async (a) => {
          const tab = a.t === 'utility-norm' ? 'utility' : a.t;
          sPTab(tab, document.querySelector('.pdt[data-tab="' + tab + '"]'));
          if (a.t === 'utility-norm') {
            projUDSelectBldg(a.pid, 'synb1');
            await new Promise((r) => setTimeout(r, 800));
            const body = document.getElementById('proj-ud-body-' + a.pid);
            udSelectMeter('synm1', body);
            maSetTab('norm', body);
          }
        }, { t, pid: PID });
        await page.waitForTimeout(1200);
        const r = await page.evaluate(() => {
          const vh = window.innerHeight;
          const rect = (e) => e.getBoundingClientRect();
          const main = rect(document.querySelector('main.content'));
          const tabbar = document.getElementById('pdTabBar');
          const tb = tabbar ? rect(tabbar) : null;
          const inScroller = (el) => {
            for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
              const o = getComputedStyle(n).overflow + getComputedStyle(n).overflowY;
              if (/auto|scroll/.test(o)) return true;
            }
            return false;
          };
          const hit = (a, b) => a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          const bad = [];
          document.querySelectorAll('body *').forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            const fixed = cs.position === 'fixed';
            const sticky = cs.position === 'sticky' && !inScroller(el);
            if (!fixed && !sticky) return;
            if (el.closest('#loginScreen') || el.offsetParent === null && !fixed) return;
            const b = rect(el);
            if (b.width === 0 || b.height === 0) return;
            if (hit(b, main) || (tb && hit(b, tb))) bad.push((el.id || el.className || el.tagName) + '');
          });
          return { vh, mainBottom: main.bottom, mainTop: main.top, docH: document.documentElement.scrollHeight, bodyH: document.body.scrollHeight,
            link: (document.getElementById('ch-archive-link') || {}).textContent || '', linkVisible: !!document.getElementById('ch-archive-link') && getComputedStyle(document.getElementById('ch-archive-link')).display !== 'none',
            noticeBar: !!document.getElementById('ch-ver-update-banner'),
            barText: Array.from(document.querySelectorAll('main.content *, .app-col > *')).some((e) => !e.closest('.sidebar') && /new version .*available|Reload now/i.test(e.textContent || '') && e.children.length === 0),
            verLink: (() => { const l = document.getElementById('ch-ver-update-link'); return l && l.closest('.sb-version') && getComputedStyle(l).display !== 'none' ? l.textContent : ''; })(),
            bad };
        });
        // Tab strip controls (scroll arrows) must not overlap any visible tab label. Checked at scroll start and at scroll end.
        const ctl = await page.evaluate(async () => {
          const sc = document.getElementById('pdTabScroll');
          const R = (e) => e.getBoundingClientRect();
          const hit = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
          const out = { arrowsShown: [], overlaps: [] };
          for (const pos of ['start', 'end']) {
            sc.scrollLeft = pos === 'start' ? 0 : sc.scrollWidth;
            sc.dispatchEvent(new Event('scroll'));
            await new Promise((r) => setTimeout(r, 100));
            const sr = R(sc);
            ['hdrTabsL', 'hdrTabsR'].forEach((id) => {
              const a = document.getElementById(id);
              if (!a || a.hidden || getComputedStyle(a).display === 'none') return;
              out.arrowsShown.push(pos + ':' + id);
              const ar = R(a);
              if (hit(ar, sr)) out.overlaps.push(pos + ':' + id + ' overlaps the tab scroller');
              document.querySelectorAll('#pdTabBar .pdt').forEach((tb) => {
                const tr = R(tb);
                const vis = { left: Math.max(tr.left, sr.left), right: Math.min(tr.right, sr.right), top: tr.top, bottom: tr.bottom };
                if (vis.right > vis.left && hit(ar, vis)) out.overlaps.push(pos + ':' + id + ' overlaps tab ' + tb.textContent.trim());
              });
            });
          }
          sc.scrollLeft = 0;
          sc.dispatchEvent(new Event('scroll'));
          return out;
        });
        if (ctl.overlaps.length) failures.push(vp.width + '-' + t + ' tab strip control over a tab: ' + ctl.overlaps.join('; '));
        if (vp.width === 960 && ctl.arrowsShown.length < 2) failures.push(vp.width + '-' + t + ' expected scroll arrows at start and end, saw ' + ctl.arrowsShown.join(','));
        if (OUT && vp.width === 960 && t === 'dashboard') {
          await page.evaluate(() => { const sc = document.getElementById('pdTabScroll'); sc.scrollLeft = sc.scrollWidth; sc.dispatchEvent(new Event('scroll')); });
          await page.waitForTimeout(200);
          await page.screenshot({ path: OUT + '/layout-960-dashboard-scrolled-end.png' });
          await page.evaluate(() => { const sc = document.getElementById('pdTabScroll'); sc.scrollLeft = 0; sc.dispatchEvent(new Event('scroll')); });
        }
        console.log(vp.width + '-' + t + ' tab controls', JSON.stringify(ctl));
        if (t === 'utility-norm' && !(await page.evaluate(() => !!document.querySelector('.ma-tab.active') && /Normalized/.test(document.querySelector('.ma-tab.active').textContent)))) failures.push(vp.width + ' Normalized sub-tab not active');
        const label = vp.width + '-' + t;
        console.log(label, JSON.stringify(r));
        if (r.bad.length) failures.push(label + ' overlay over page/tabs: ' + r.bad.join(','));
        if (Math.abs(r.mainBottom - r.vh) > 1) failures.push(label + ' main bottom ' + r.mainBottom + ' != window ' + r.vh);
        if (r.docH > r.vh + 1) failures.push(label + ' page taller than window');
        if (r.linkVisible || r.link) failures.push(label + ' Past conflicts sidebar link must not exist');
        if (r.noticeBar || r.barText) failures.push(label + ' version bar text found in the main column');
        if (r.verLink !== 'New version: update') failures.push(label + ' new-version link missing in sidebar footer: "' + r.verLink + '"');
        if (OUT) await page.screenshot({ path: OUT + '/layout-' + label + '.png' });
      }
    } finally {
      await ctx.close();
    }
  }
  if (failures.length) { console.error('FAIL test-no-overlay-layout\n' + failures.join('\n')); process.exit(1); }
  console.log('PASS test-no-overlay-layout');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
