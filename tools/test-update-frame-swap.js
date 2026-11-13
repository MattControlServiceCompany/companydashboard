// Real-browser test (synthetic data, headless Chromium AND Firefox, own local HTTP server): update by frame swap
// (Matt 2026-11-12: "Remove the blank screen too, do it without a reload").
// energy-department.html opened as the top window over http becomes a shell with ONE frame that runs the app. A new version
// is found: the shell starts a second frame behind the first, and when it has drawn the saved page it removes the old one.
//   (a) the top page is a shell with one frame; the app works in the frame; file:// still starts the app directly (g);
//   (b) pending version + user page change + safe = swap; the top window never navigates; the new frame shows the page the
//       user chose, no What's New dialog, no login screen, a toast announces the version; the page change check finds it;
//   (c) every captured frame across the swap shows the loaded app (defined in frameLooksLoaded below), frame count reported;
//   (d) input during the start, or an unsafe state = no swap, the new frame is removed, the next page change swaps;
//   (e) once per version: the same version does not swap twice, a newer version does; (f) the away rule swaps;
//   (h) the sidebar "New version" link starts the same swap.
// Run: node tools/test-update-frame-swap.js [chromium|firefox|both] [frames-folder]   (CH_TMP_ROOT must be set)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./launch-browser.js');
const { profilePath, rmTmp } = require('./tmp-root.js');
const { XFO, startServer, seed, SEED, appState, frameTools, PID } = require('./update-test-helpers.js');
const ROOT = path.join(__dirname, '..');
const FILE_URL = 'file:///' + ROOT.split(path.sep).join('/') + '/energy-department.html';
const WHICH = process.argv[2] || 'both';
const FRAMES_DIR = process.argv[3] || '';
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
function ok(c, l, extra) {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + (extra === undefined ? '' : ': ' + JSON.stringify(extra)));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the per-frame check (c): decode a captured PNG in a helper page and compare it with the settled page after the swap.
// A frame "looks loaded" when: (1) its sidebar strip (left 240 px) carries the settled sidebar's content (at least 80 % of
// its ink share, and no more than 12 % of the pixels differ: the footer link of the old frame shifts a few lines), (2) its main area carries content (the share of pixels that are not the main background is at least
// half of the settled page's share), and (3) the whole image matches the settled page except for at most 30 % of the pixels
// (a toast or an animation). A blank frame, a login card or an empty shell fails (1) or (2).
const ANALYZE = async (args) => {
  const load = (b64) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.width;
        c.height = im.height;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0);
        res(x.getImageData(0, 0, c.width, c.height));
      };
      im.onerror = rej;
      im.src = 'data:image/png;base64,' + b64;
    });
  const SB = 240;
  const modal = (d, x0, x1) => {
    const cnt = new Map();
    for (let y = 0; y < d.height; y += 3) for (let x = x0; x < x1; x += 3) { const i = (y * d.width + x) * 4; const k = (d.data[i] >> 3) + ',' + (d.data[i + 1] >> 3) + ',' + (d.data[i + 2] >> 3); cnt.set(k, (cnt.get(k) || 0) + 1); }
    let best = null, n = 0;
    cnt.forEach((v, k) => { if (v > n) { n = v; best = k; } });
    return best;
  };
  const inkShare = (d, x0, x1) => {
    const m = modal(d, x0, x1);
    let ink = 0, tot = 0;
    for (let y = 0; y < d.height; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * d.width + x) * 4; const k = (d.data[i] >> 3) + ',' + (d.data[i + 1] >> 3) + ',' + (d.data[i + 2] >> 3); tot++; if (k !== m) ink++; }
    return ink / tot;
  };
  const diffShare = (a, b, x0, x1) => {
    let df = 0, tot = 0;
    for (let y = 0; y < a.height; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * a.width + x) * 4; tot++; if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) df++; }
    return df / tot;
  };
  const ref = await load(args.ref);
  const out = [];
  for (const b64 of args.frames) {
    const f = await load(b64);
    if (f.width !== ref.width || f.height !== ref.height) { out.push({ size: f.width + 'x' + f.height }); continue; }
    out.push({
      sidebarDiff: diffShare(f, ref, 0, SB),
      sidebarInk: inkShare(f, 0, SB),
      refSidebarInk: inkShare(ref, 0, SB),
      mainInk: inkShare(f, SB, f.width),
      refMainInk: inkShare(ref, SB, ref.width),
      wholeDiff: diffShare(f, ref, 0, f.width),
    });
  }
  return out;
};
const frameLooksLoaded = (m) => !m.size && m.sidebarInk >= 0.8 * m.refSidebarInk && m.sidebarDiff <= 0.12 && m.mainInk >= 0.5 * m.refMainInk && m.wholeDiff <= 0.3;

async function run(kind) {
  const srv = await startServer();
  const SITE = srv.base + '/energy-department.html?shell=1'; // shell=1: automation otherwise starts the app directly
  const tag = kind === 'firefox' ? 'ff' : 'cr';
  let ctx;
  const profile = profilePath('update-frame-swap-' + tag);
  if (kind === 'firefox') ctx = await require('playwright').firefox.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 900 } });
  else ctx = await launchBrowser('update-frame-swap-' + tag, { viewport: { width: 1400, height: 900 } });
  const out = { kind, frames: 0, captured: [] };
  try {
    await ctx.addInitScript(seed, SEED);
    const page = await ctx.newPage();
    const errs = [];
    let topNavs = 0;
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource/.test(m.text()) && errs.push(m.text()));
    page.on('framenavigated', (f) => f === page.mainFrame() && topNavs++);
    const { kids, app, waitSwap, markOld } = frameTools(page);
    const st = async () => app().evaluate(appState);
    const openProject = () =>
      app().evaluate((pid) => {
        openDetail(pid);
        sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'), 'setpoints');
      }, PID);

    // ---- (a) shell
    await page.goto(SITE);
    await page.waitForFunction(() => document.querySelector('iframe'), null, { timeout: 15000 });
    await app().waitForFunction(() => document.getElementById('app') && document.getElementById('app').classList.contains('visible'), null, { timeout: 20000, polling: 100 }).catch(async (e) => { console.log('DEBUG', JSON.stringify(await app().evaluate(() => ({ login: getComputedStyle(document.getElementById('loginScreen')).display, ses: !!sessionStorage.getItem('ch_sb_session'), user: localStorage.getItem('ch_user') || sessionStorage.getItem('ch_user'), seeded: sessionStorage.getItem('__seeded'), href: location.href })).catch((x) => String(x))), errs); throw e; });
    await page.waitForTimeout(1500);
    await app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    const top = await page.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, appInTop: !!document.getElementById('app'), url: location.href, title: document.title, src: document.querySelector('iframe').src, scripts: document.scripts.length }));
    eq(XFO, 'SAMEORIGIN', '(a) netlify.toml sends X-Frame-Options SAMEORIGIN (the test server sends the same header)');
    eq([top.iframes, top.appInTop], [1, false], '(a) the top page holds one frame and no app');
    const hist0 = await page.evaluate(() => history.length);
    ok(/[?&]frame=1/.test(top.src) && !/frame=1/.test(top.url), '(a) the frame URL has frame=1, the address bar does not', [top.src, top.url]);
    const fr0 = await app().evaluate(() => ({ title: document.title, app: document.getElementById('app').classList.contains('visible'), sv: typeof sv, framed: window.top !== window }));
    eq([fr0.app, fr0.sv, fr0.framed], [true, 'function', true], '(a) the app runs inside the frame');
    eq(top.title, fr0.title, '(a) the tab title is the title of the app in the frame');
    await openProject();
    await page.waitForTimeout(800);
    const s0 = await st();
    eq([s0.view, s0.detail, s0.proj, s0.tab, s0.sub], ['view-projects', true, PID, 'eq-matrix', 'setpoints'], '(a) the app works in the frame: project, tab, sub-tab open');
    // (a) things the app does from inside a frame: a download, a new tab, a file chooser, the folder picker API, focus
    const dl = page.waitForEvent('download', { timeout: 10000 });
    await app().evaluate(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['x']));
      a.download = 'frame-check.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    eq((await dl).suggestedFilename(), 'frame-check.txt', '(a) a download made inside the frame works');
    const pop = page.waitForEvent('popup', { timeout: 10000 });
    await app().evaluate(() => window.open('about:blank', '_blank'));
    const popup = await pop;
    ok(!!popup, '(a) window.open inside the frame opens a new tab');
    await popup.close();
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await app().evaluate(() => {
      const i = document.createElement('input');
      i.type = 'file';
      i.setAttribute('webkitdirectory', '');
      document.body.appendChild(i);
      i.click();
      i.remove();
    });
    ok(!!(await chooser), '(a) a file chooser (directory input) opens from inside the frame');
    if (kind === 'chromium') eq(await app().evaluate(() => typeof window.showDirectoryPicker), 'function', '(a) showDirectoryPicker exists in the frame (Chromium)');
    const foc = await app().evaluate(() => ({ focus: document.hasFocus(), hidden: document.hidden }));
    eq(foc, { focus: true, hidden: false }, '(a) the frame has focus and is not hidden (the away rule reads these)');
    eq(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'IFRAME', '(a) the shell keeps focus on the frame');
    await page.evaluate(() => (window.__topMarker = 'alive'));
    const navsBefore = topNavs;

    // ---- (b)+(c) pending version found by the check of a page change: swap, with a frame-by-frame capture
    srv.liveVer = 'v9999.01.01.1';
    await markOld();
    await app().evaluate(() => localStorage.setItem('ch_seen_version', 'v0.0.0.0'));
    await page.waitForTimeout(3300); // past the 3 s that follow the page change of the setup
    const reqsBefore = srv.reqs.length;
    // Frame capture: Chromium = CDP screencast (every compositor frame); Firefox = back-to-back screenshots.
    const startCapture = async () => {
      const cap = [];
      let stop;
      if (kind === 'chromium') {
        const cdp = await ctx.newCDPSession(page);
        cdp.on('Page.screencastFrame', (f) => {
          cap.push({ t: Date.now(), data: f.data });
          cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        });
        await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1400, maxHeight: 900 });
        stop = async () => cdp.send('Page.stopScreencast').catch(() => {});
      } else {
        let go = true;
        const loop = (async () => {
          while (go) {
            const b = await page.screenshot({ type: 'png' }).catch(() => null);
            if (b) cap.push({ t: Date.now(), data: b.toString('base64') });
          }
        })();
        stop = async () => {
          go = false;
          await loop;
        };
      }
      return { cap, stop };
    };
    // Score captured frames against the settled page.
    const scoreFrames = async (frames, ref) => {
      const helper = await ctx.newPage();
      await helper.goto('about:blank');
      const m = await helper.evaluate(ANALYZE, { ref, frames: frames.map((c) => c.data) });
      await helper.close();
      return m;
    };
    const capture = await startCapture();
    const cap = capture.cap;
    const stopCap = capture.stop;
    await sleep(300);
    await app().evaluate(() => {
      _chVerLastCheck = Date.now() - 61000;
      sv('utility'); // the user changes page: the check finds the new version and the swap starts at once
    });
    await sleep(600); // the page change itself (old frame) has drawn; the frames from here on belong to the swap
    const tSwap0 = Date.now();
    const swapped = await waitSwap();
    await sleep(2500); // let the toast draw
    await stopCap();
    ok(swapped, '(b) the swap finished: one frame, and it is not the old one');
    const s1 = await st();
    eq([s1.view, s1.loginShown, s1.whatsNewOpen, s1.appVisible, s1.old], ['view-utility', false, false, true, false], '(b) the new frame shows the page the user chose, no login, no What\'s New, not the old frame');
    ok(/Updated to/.test(s1.toast), '(b) a toast announces the new version', s1.toast);
    eq(await page.evaluate(() => window.__topMarker), 'alive', '(b) the top window survived (marker alive)');
    eq(topNavs, navsBefore, '(b) the top window did not navigate during the swap');
    eq(await page.evaluate(() => history.length), hist0, '(b) the swap added no history entry');
    eq(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1, '(b) the top window has one navigation entry');
    eq((await page.evaluate(() => document.querySelectorAll('iframe').length)), 1, '(b) one frame in the shell after the swap');
    ok(srv.reqs.slice(reqsBefore).some((r) => /energy-department\.html\?.*ch_v=v9999/.test(r)), '(b) the new frame asked for the page with a version parameter');
    eq(await page.evaluate(() => document.title), await app().evaluate(() => document.title), '(b) the tab title still mirrors the frame');
    // (c) the frames
    const settled = (await page.screenshot({ type: 'png' })).toString('base64');
    const swapFrames = cap.filter((c) => c.t >= tSwap0 - 50);
    const metrics = await scoreFrames(swapFrames, settled);
    const bad = [];
    metrics.forEach((m, i) => {
      if (!frameLooksLoaded(m)) bad.push({ i, m });
      if (FRAMES_DIR) fs.writeFileSync(path.join(FRAMES_DIR, tag + '-' + String(i).padStart(3, '0') + (frameLooksLoaded(m) ? '' : '-BAD') + '.png'), Buffer.from(swapFrames[i].data, 'base64'));
    });
    out.frames = swapFrames.length;
    ok(swapFrames.length >= 3, '(c) at least 3 frames were captured across the swap', swapFrames.length);
    ok(bad.length === 0, '(c) every captured frame shows the loaded app (' + swapFrames.length + ' frames)', bad.slice(0, 3));
    console.log('[' + kind + '] frames captured across the swap: ' + swapFrames.length + ', failing the loaded-app check: ' + bad.length + ', worst sidebarDiff ' + Math.max(0, ...metrics.map((m) => m.sidebarDiff || 0)).toFixed(3) + ', lowest main ink ratio ' + Math.min(...metrics.map((m) => (m.mainInk || 0) / (m.refMainInk || 1))).toFixed(2));

    // ---- (e) once per version: the same version again = no second swap; the next version swaps
    await markOld();
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.1';
      sv('home');
    });
    await page.waitForTimeout(1500);
    eq([kids().length, await app().evaluate(() => !!window.__oldFrame)], [1, true], '(e) same version: no second swap');
    srv.liveVer = 'v9999.01.01.2';
    await app().evaluate(() => {
      _chPendingVer = null;
      _chVerLastCheck = Date.now() - 61000;
      sv('utility');
    });
    ok(await waitSwap(), '(e) a newer version swaps again (the new frame can swap too)');
    eq((await st()).view, 'view-utility', '(e) the second swap lands on the page the user chose');

    // ---- (d) input during the start = no swap; the new frame is removed; the next page change swaps
    await markOld();
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('home');
    });
    await sleep(200);
    ok(kids().length === 2, '(d) the second frame exists while it starts', kids().length);
    await page.keyboard.press('Shift'); // real input in the old frame
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1, null, { timeout: 30000 });
    await sleep(500);
    const d1 = await app().evaluate(() => ({ old: !!window.__oldFrame, guard: sessionStorage.getItem('ch_update_swap_ver'), marker: sessionStorage.getItem('ch_update_reload'), saved: sessionStorage.getItem('ch_page_state_ver_update') }));
    eq(d1, { old: true, guard: null, marker: null, saved: null }, '(d) input during the start: the old frame stays, the new one is gone, guard and markers cleared');
    // unsafe at the moment of the swap (an edited view): also no swap
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('utility');
    });
    await sleep(200);
    await kids()[0].evaluate(() => (window.chViewIsDirty = () => true)); // the old frame (first), not the one that starts
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1, null, { timeout: 30000 });
    await sleep(500);
    eq(await app().evaluate(() => !!window.__oldFrame), true, '(d) unsafe state during the start: no swap');
    // the new frame never gets ready (its page never answers): the shell removes it after 30 s and the old frame stays
    await app().evaluate(() => {
      window.chViewIsDirty = () => false;
      _chPendingVer = 'v9999.01.01.3';
    });
    srv.stallNewFrame = true;
    await app().evaluate(() => sv('utility'));
    await sleep(500);
    ok(kids().length === 2, '(d) the second frame exists while its page does not answer', kids().length);
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1, null, { timeout: 40000, polling: 250 });
    eq(await app().evaluate(() => ({ old: !!window.__oldFrame, guard: sessionStorage.getItem('ch_update_swap_ver'), marker: sessionStorage.getItem('ch_update_reload') })), { old: true, guard: null, marker: null }, '(d) a new frame that never gets ready is removed after 30 s: the old frame stays, guard and markers cleared');
    srv.stallNewFrame = false;
    await app().evaluate(() => sv('home'));
    ok(await waitSwap(), '(d) the next page change swaps');
    eq((await st()).view, 'view-home', '(d) lands on the page of that page change');

    // ---- (f) the away rule: another program has focus, no page change
    await markOld();
    await sleep(3400);
    srv.liveVer = 'v9999.01.01.4';
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.4';
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    ok(await waitSwap(), '(f) away (no focus): the swap runs');
    eq((await st()).view, 'view-home', '(f) the page is kept');

    // ---- (h) the sidebar link starts the same swap
    await markOld();
    await sleep(3400);
    srv.liveVer = 'v9999.01.01.5';
    await app().evaluate(() => {
      _chVerLastCheck = Date.now() - 61000;
      return _checkForVersionUpdate();
    });
    await sleep(800);
    const linkShown = await app().evaluate(() => {
      const l = document.getElementById('ch-ver-update-link');
      return !!l && getComputedStyle(l).display !== 'none';
    });
    ok(linkShown || kids().length === 2 || !(await app().evaluate(() => !!window.__oldFrame)), '(h) the link is shown (or the swap already started)');
    if ((await app().evaluate(() => !!window.__oldFrame)) && kids().length === 1) {
      await app().evaluate(() => document.getElementById('ch-ver-update-link').click());
      ok(await waitSwap(), '(h) the link starts the swap');
    }
    eq(await page.evaluate(() => window.__topMarker), 'alive', 'the top window survived every swap');
    eq(topNavs, navsBefore, 'the top window never navigated');
    eq(errs, [], 'no console or page errors');

    // ---- control: the same capture and check on a plain reload of the app frame (what the old update did) must FAIL,
    // otherwise the check could not tell a blank frame from the loaded app.
    await sleep(1000);
    const ctlRef = (await page.screenshot({ type: 'png' })).toString('base64');
    const ctl = await startCapture();
    const ctlT0 = Date.now();
    await app().evaluate(() => setTimeout(() => location.reload(), 0)).catch(() => {});
    await sleep(500);
    await app().waitForFunction(() => document.getElementById('app') && document.getElementById('app').classList.contains('visible'), null, { timeout: 20000, polling: 100 }).catch(() => {});
    await sleep(1500);
    await ctl.stop();
    const ctlM = await scoreFrames(ctl.cap.filter((c) => c.t >= ctlT0), ctlRef);
    const ctlBad = ctlM.filter((m) => !frameLooksLoaded(m)).length;
    ok(ctlBad > 0, 'control: a reload of the app frame has frames that fail the loaded-app check (' + ctlBad + ' of ' + ctlM.length + ')');
    console.log('[' + kind + '] control (reload of the frame): ' + ctlBad + ' of ' + ctlM.length + ' captured frames fail the check');

    // ---- (g) file:// starts the app directly, no shell
    const fp = await ctx.newPage();
    await fp.goto(FILE_URL);
    await fp.waitForTimeout(2500);
    const g = await fp.evaluate(() => ({ shell: typeof window.chShell, frames: document.querySelectorAll('iframe[src*="frame=1"]').length, app: !!document.getElementById('app'), sv: typeof sv }));
    eq(g, { shell: 'undefined', frames: 0, app: true, sv: 'function' }, '(g) file:// starts the app in the top window, no shell');
    // automation without shell=1 (all other tests) also starts the app directly
    const dp = await ctx.newPage();
    await dp.goto(srv.base + '/energy-department.html');
    await dp.waitForTimeout(1500);
    eq(await dp.evaluate(() => ({ shell: typeof window.chShell, app: !!document.getElementById('app'), top: window.top === window })), { shell: 'undefined', app: true, top: true }, '(g) webdriver without shell=1: the app starts in the top window (existing http tests)');
    await dp.close();
    await fp.close();
  } finally {
    await ctx.close().catch(() => {});
    rmTmp(profile);
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    srv.server.close();
  }
  return out;
}

(async () => {
  const kinds = WHICH === 'both' ? ['chromium', 'firefox'] : [WHICH];
  for (const k of kinds) await run(k);
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
