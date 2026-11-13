// Shared by tools/test-update-frame-swap.js, tools/test-update-on-page-change.js and tools/test-update-reload-state.js:
// a local static HTTP server of the work tree (the update shell only starts over http), the synthetic signed-in seed,
// and the app state read. The server answers the version check with the "live" version the test sets (st.liveVer):
// site-ui.js (CH_VERSION, read by the check) and the first release note (the version a page has loaded).
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PID = 999000416;
// The frame header the site sends (netlify.toml). The test server sends the same, so a DENY there fails every swap test.
const XFO = ((fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8').match(/X-Frame-Options\s*=\s*"([^"]+)"/) || [])[1]) || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };

function startServer() {
  const st = { liveVer: null, reqs: [], stallNewFrame: false }; // stallNewFrame: never answer the page request of a new frame (?ch_v=)
  st.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/energy-department.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    st.reqs.push(p + u.search);
    if (st.stallNewFrame && /[?&]ch_v=/.test(u.search)) return;
    let buf = fs.readFileSync(f);
    if (p === '/site-ui.js' && st.liveVer) buf = Buffer.from(buf.toString('utf8').replace(/(CH_VERSION\s*=\s*')[^']+/, '$1' + st.liveVer));
    if (p === '/app/site-functions.js' && st.liveVer) buf = Buffer.from(buf.toString('utf8').replace(/(RELEASE_NOTES = \[\s*\{ v: ')[^']+/, '$1' + st.liveVer));
    const h = { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (XFO) h['X-Frame-Options'] = XFO;
    if (req.headers.range && p === '/site-ui.js') {
      h['Content-Range'] = 'bytes 0-' + (Math.min(4096, buf.length) - 1) + '/' + buf.length;
      res.writeHead(206, h);
      return res.end(buf.subarray(0, 4096));
    }
    res.writeHead(200, h);
    res.end(buf);
  });
  return new Promise((r) => st.server.listen(0, '127.0.0.1', () => ((st.base = 'http://127.0.0.1:' + st.server.address().port), r(st))));
}

// Init script: a signed-in synthetic user, seeded once per tab (fake token; this host never syncs). `data` is SEED.
function seed(data) {
  window.__toasts = [];
  window.__loginFrames = 0; // frames drawn while the login screen was visible (any load, any frame)
  const tick = () => {
    const l = document.getElementById('loginScreen');
    if (l && getComputedStyle(l).display !== 'none') window.__loginFrames++;
    if (document.readyState !== 'complete') requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.addEventListener('DOMContentLoaded', () => {
    const m = document.getElementById('toastMsg');
    if (m) new MutationObserver(() => m.textContent && window.__toasts.push(m.textContent)).observe(m, { childList: true, characterData: true, subtree: true });
  });
  if (!window.sessionStorage.getItem('ch_sb_session'))
    window.sessionStorage.setItem('ch_sb_session', JSON.stringify({ access_token: ['fake', 'a'].join('-'), refresh_token: ['fake', 'r'].join('-'), expires_at: 4102444800, user_id: 'u1', email: 'demo@example.com' }));
  if (window.sessionStorage.getItem('__seeded')) return; // seed once per tab (the app clears localStorage once while it moves data to IndexedDB)
  window.sessionStorage.setItem('__seeded', '1');
  for (const k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
  window.localStorage.setItem('ch_activeView', 'projects');
}
const SEED = {
  en_projects: [{ id: PID, name: 'Alpha SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
  ch_settings: { showQuickStart: false },
  ch_theme: 'dark',
  ch_seen_version: 'v0.0.0.0', // an older version was seen: What's New would open on a fresh visit
  ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
};
// Page function: what the user sees in the app (run in the frame).
const appState = () => ({
  view: document.querySelector('.view.active')?.id,
  detail: document.getElementById('projDetailView').style.display === 'flex',
  proj: window._activeProjId,
  tab: window._activeProjTab,
  tabActive: document.querySelector('#pdTabBar .pdt.active')?.dataset.tab,
  sub: document.querySelector('.ptab.active .ptpill.sel')?.dataset.sub,
  loginShown: getComputedStyle(document.getElementById('loginScreen')).display !== 'none',
  whatsNewOpen: !!document.querySelector('.rn-overlay.open'),
  appVisible: document.getElementById('app').classList.contains('visible'),
  toast: (window.__toasts || []).concat((document.getElementById('toastMsg') || {}).textContent || '').join('|'),
  loginFrames: window.__loginFrames,
  old: !!window.__oldFrame, // set by a test on the frame it wants to tell apart; the new frame does not have it
});

// The frames of the shell (direct children of the top window), the one the user sees (the last one is the one behind,
// while a swap runs: use kids()[0] for the old frame), and a wait for a finished swap.
function frameTools(page) {
  const kids = () => page.frames().filter((f) => f.parentFrame() === page.mainFrame());
  const app = () => kids()[kids().length - 1];
  const waitApp = (ms) => app().waitForFunction(() => document.getElementById('app') && document.getElementById('app').classList.contains('visible'), null, { timeout: ms || 20000, polling: 100 });
  const waitSwap = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
      if (kids().length === 1) {
        const o = await app()
          .evaluate(() => (document.getElementById('app') && document.getElementById('app').classList.contains('visible') ? !!window.__oldFrame : true))
          .catch(() => true);
        if (!o) return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const markOld = () => app().evaluate(() => (window.__oldFrame = 1));
  return { kids, app, waitApp, waitSwap, markOld };
}

module.exports = { XFO, startServer, seed, SEED, appState, frameTools, PID };
