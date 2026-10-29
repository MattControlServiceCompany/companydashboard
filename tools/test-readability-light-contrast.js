// test-readability-light-contrast.js -- readability fixes 4, 5, 6 and 19 (Matt, 2026-10-29).
//   4: light theme defines --green and --amber (dark values were 1.5-1.9:1 on white).
//   5: Projected Savings text uses var(--violet-text) / var(--violet-label) (dark: the old #c084fc / #a78bfa;
//      light: the site violet #6d28d9), not hard-coded #c084fc / #a78bfa.
//   6: Equipment Matrix coverage / readiness text uses var(--green) / var(--warn) (stats bar, on white) and
//      var(--amber) on the tinted likely-match cells (--warn is 4.3:1 there), not #27ae60 / #e67e22.
//  19: the pinned Total column on the Utility Data bills table has a left shadow.
// Static source checks, then a headless Chromium page (synthetic data only, network to Netlify/Supabase blocked)
// in the light theme: every visible text that uses these tokens must be >= 4.5:1 on the fill it sits on.
// Check: node tools/test-readability-light-contrast.js  (NODE_PATH = Playwright copy). Exit 1 on any FAIL.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const PID = 990077;
let fails = 0;
const fail = (m) => { fails++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

// ---- static ----
const html = fs.readFileSync(path.join(ROOT, 'energy-department.html'), 'utf8');
const light = (html.match(/\[data-theme='light'\]\s*\{([^}]*)\}/) || [])[1] || '';
['--green', '--amber'].forEach((t) => (new RegExp(t + ':\\s*#').test(light) ? ok('light theme defines ' + t) : fail('light theme does not define ' + t)));
const core = fs.readFileSync(path.join(ROOT, 'app', 'core.js'), 'utf8');
const ps = core.indexOf('margin-bottom:8px;font-weight:600">Projected Savings</div>');
const psBlock = ps > 0 ? core.slice(ps - 400, ps + 6000) : '';
if (!psBlock) fail('Projected Savings card not found in app/core.js');
else if (/color:#(c084fc|a78bfa)/i.test(psBlock) || !/color:var\(--violet-text\)/.test(psBlock)) fail('Projected Savings card text does not use var(--violet-text) / var(--violet-label)');
else ok('Projected Savings card text uses tokens');
const em = fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8');
const pick = em.split('\n').filter((l) => /var (covColor|seqColor|pctColor|_seqPctColor) =/.test(l));
if (pick.length < 7) fail('expected 7 coverage/readiness color pickers in equipment-matrix.js, found ' + pick.length);
pick.forEach((l) => { if (/#27ae60|#e67e22/i.test(l)) fail('hard-coded green/amber text color: ' + l.trim()); });
if (/color:#(27ae60|e67e22);font-weight:700/i.test(em)) fail('matrix cell text still uses color:#27ae60 / #e67e22');
else ok('matrix cell text uses tokens');
const shadowRule = /\.ud-bill-tbl td\.sticky-col-right:not\(\.td-actions\)\s*\{\s*box-shadow:/.test(html);
shadowRule ? ok('sticky Total column has a box-shadow rule') : fail('no box-shadow rule on the sticky Total column');

// ---- browser ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const srv = http.createServer((q, r) => {
  if (q.method !== 'GET' && q.method !== 'HEAD') { r.writeHead(405); return r.end(); }
  let p = decodeURIComponent(q.url.split('?')[0]);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

// In the page: contrast of every visible text whose color comes from the listed tokens, on its composited fill.
function scan(tokens) {
  const rgb = (s) => { const m = String(s).match(/[\d.]+/g) || []; return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] === undefined ? 1 : +m[3] }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const fillOf = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let out = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) }; }
    return out;
  };
  const root = getComputedStyle(document.documentElement);
  const want = {};
  tokens.forEach((t) => { const d = document.createElement('i'); d.style.color = 'var(' + t + ')'; document.body.appendChild(d); want[getComputedStyle(d).color.replace(/\s/g, '')] = t; d.remove(); });
  const res = [];
  document.querySelectorAll('body *').forEach((e) => {
    if (!e.offsetParent || !e.childNodes.length) return;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
    const col = getComputedStyle(e).color.replace(/\s/g, '');
    if (!want[col]) return;
    const a = lum(rgb(col)), b = lum(fillOf(e));
    res.push({ token: want[col], text: e.textContent.trim().slice(0, 30), ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 });
  });
  return { root: root.getPropertyValue('--green').trim(), res };
}

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + srv.address().port + '/';
  const ctx = await launchBrowser('readability-contrast', { viewport: { width: 1536, height: 900 } });
  try {
    await ctx.route('**/*', (r) => { const q = r.request(); if (q.method() !== 'GET' && q.method() !== 'HEAD') return r.abort(); if (/\/\.netlify\/|supabase\.|netlify\.app/i.test(q.url())) return r.abort(); return r.continue(); });
    await ctx.addInitScript((pid) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      const cid = 'cust_' + pid;
      localStorage.setItem('en_projects', JSON.stringify([{ id: pid, name: 'SYNTHETIC', client: 'S', customerId: cid, addr: '', type: 'Test', status: 'active', phase: '', contacts: [], scope: { buildingIds: ['bs1'], meterExcludeIds: [] }, savingsData: { measures: [] } }]));
      localStorage.setItem('en_customers', JSON.stringify([{ id: cid, name: 'Synth Customer' }]));
      const bills = [];
      for (let i = 0; i < 24; i++) { const y = 2024 + Math.floor(i / 12), mm = String((i % 12) + 1).padStart(2, '0'); bills.push({ id: 'b' + i, start: y + '-' + mm + '-01', end: y + '-' + mm + '-28', kwh: 10000 + i * 37, kw: 40 + (i % 7), totalCost: 1000 + i * 11 }); }
      localStorage.setItem('en_utility_' + cid, JSON.stringify({ buildings: [{ id: 'bs1', name: 'Synth Hall', addr: '1 Test St', sqft: 20000, meters: [{ id: 'ms1', commodity: 'Electric', provider: 'SynElectric', account: 'E-111', bills }] }] }));
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, rnShowMode: 'never', theme: 'light' }));
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    }, PID);
    const page = await ctx.newPage();
    await page.goto(base + 'energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof openDetail === 'function' && window.DB && DB.isReady(), null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => (window.siteApplyTheme ? siteApplyTheme('light') : document.documentElement.setAttribute('data-theme', 'light')));
    await page.evaluate((id) => { sv('projects'); openDetail(id); }, PID);
    await page.waitForTimeout(1200);
    const tok = ['--green', '--amber', '--violet-text', '--warn'];
    let seen = 0;
    for (const tab of ['dashboard', 'eq-matrix', 'utility']) {
      await page.evaluate((t) => sPTab(t, document.querySelector('#pdTabBar [data-tab="' + t + '"]')), tab);
      await page.waitForTimeout(1500);
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (theme !== 'light') fail('page is not in the light theme (' + theme + ')');
      const { res } = await page.evaluate(scan, tok);
      seen += res.length;
      const bad = res.filter((x) => x.ratio < 4.5);
      bad.forEach((x) => fail(tab + ': ' + x.token + ' text "' + x.text + '" is ' + x.ratio + ':1 (< 4.5)'));
      ok(tab + ': ' + res.length + ' token-colored texts checked, ' + bad.length + ' below 4.5:1');
    }
    // Same cell styles as the matrix (matched cell, likely-match cell, violet card) rendered on the light page fill.
    const probes = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;background:var(--s2);z-index:99999';
      host.innerHTML = '<span id="pg" style="background:rgba(39,174,96,0.15);color:var(--green)">100%</span>' + '<span id="pw" style="background:rgba(230,126,34,0.15);color:var(--amber)">59%</span>' + '<span id="ps" style="color:var(--warn)">74%</span>' + '<span id="pv" style="background:var(--violet-dim);color:var(--violet-text)">$9,811</span>' + '<span id="pa" style="color:var(--amber)">5</span>';
      document.body.appendChild(host);
      return null;
    });
    void probes;
    const { res: pr } = await page.evaluate(scan, tok);
    ['100%', '59%', '74%', '$9,811', '5'].forEach((t) => {
      const x = pr.find((q) => q.text === t);
      if (!x) fail('probe "' + t + '" not measured');
      else if (x.ratio < 4.5) fail('probe ' + x.token + ' "' + t + '" is ' + x.ratio + ':1 (< 4.5)');
      else ok('probe ' + x.token + ' "' + t + '" ' + x.ratio + ':1');
    });
    if (!seen) fail('no token-colored text found on the project tabs');
    // 19: the Total column (pinned right, not the Actions column) has a visible shadow in both themes.
    for (const th of ['light', 'dark']) {
      await page.evaluate((t) => (window.siteApplyTheme ? siteApplyTheme(t) : document.documentElement.setAttribute('data-theme', t)), th);
      await page.waitForTimeout(500);
      const sh = await page.evaluate(() => [...document.querySelectorAll('.ud-bill-tbl .sticky-col-right:not(.td-actions)')].filter((e) => e.offsetParent).map((e) => getComputedStyle(e).boxShadow));
      if (!sh.length) fail(th + ': no pinned Total column cells on the Utility Data bills table');
      else if (sh.some((s) => !s || s === 'none')) fail(th + ': pinned Total column cell without a shadow');
      else ok(th + ': ' + sh.length + ' pinned Total cells have a shadow');
    }
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + e.stack); try { srv.close(); } catch (x) {} process.exit(2); });
