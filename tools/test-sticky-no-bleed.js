// tools/test-sticky-no-bleed.js - GATE (Matt, 2026-10-29): text must never scroll behind other text.
// Rule (the Utility Data Bills table standard, energy-department.html ".ud-bill-tbl th.sticky-col" and ".bills-sticky-hdr"):
// every position:sticky / position:fixed element that sits over scrolled content
//   1. has an OPAQUE layer (own background alpha 1, or an opaque descendant that covers the point) - never transparent;
//   2. paints ABOVE the scrolled content (z-index / stacking) - elementsFromPoint inside the box never meets scrolled content first;
//   3. is flush with the top of its scroll container when stuck - no strip above it where scrolled text shows.
// The shared CSS lives in energy-department.html under "STICKY NO-BLEED STANDARD" (--z-sticky-col, --z-sticky-head, .ch-sticky-head).
// The page walk loads index.html, ems-leads.html and energy-department.html (home, projects, every project tab with a synthetic
// project that has 30 bills, PDF / OCR with a synthetic bill set, Settings), scrolls EVERY scroll container (down, and sideways), and
// checks every visible sticky / fixed element. Fail output: page | selector | reason. SYNTHETIC data only.
// Run: node tools/test-sticky-no-bleed.js [--verbose]   (CH_GATE_BROWSER=firefox for Firefox; CH_STICKY_SHOTS=<dir> to save a screenshot of each failing page)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { fastNet } = require(path.join(ROOT, 'tools', 'pdf-test-net.js'));
const verbose = process.argv.includes('--verbose');
const BROWSER = process.env.CH_GATE_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const SHOTS = process.env.CH_STICKY_SHOTS || '';
const PID = 999000777;

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

function makePdf(pageLines) {
  const n = pageLines.length;
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(3 + i * 2 + ' 0 R');
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    let ops = 'BT /F1 14 Tf 40 740 Td 18 TL\n';
    pageLines[i].forEach((l) => (ops += `(${l}) Tj T*\n`));
    ops += 'ET';
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`;
    objs[4 + i * 2] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  objs[3 + n * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let s = '%PDF-1.4\n';
  const o = [];
  const N = 3 + n * 2;
  for (let i = 1; i <= N; i++) { o[i] = s.length; s += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = s.length;
  s += `xref\n0 ${N + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= N; i++) s += String(o[i]).padStart(10, '0') + ' 00000 n \n';
  s += `trailer\n<< /Size ${N + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(s, 'latin1');
}
const billPage = (acct, from, to, amt) => [
  'SYNTHETIC UTILITY BILL TEST', 'Account Number ' + acct, 'Service Address 202 TEST ST',
  'Billing Details - service from ' + from + ' to ' + to, 'Customer Chg 25.00', 'Energy Chg 1000 kWh 80.00',
  'Demand Chg 10 kW 90.00', 'TDC Chg 5.00', 'Current Charges ' + amt, 'Total Amount Due ' + amt,
];
const pdfA = makePdf(
  ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m, i) =>
    billPage('1000001', m + '/01/2025', m + (i === 1 ? '/28' : '/28') + '/2025', (200 + i).toFixed(2)),
  ),
);

// Runs in the page. Scrolls every scroll container, then checks every visible sticky / fixed element. Returns [{sel, why}].
function scanInPage() {
  const out = [];
  const sigOf = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const p = el.parentElement;
    if (p) {
      let ps = p.tagName.toLowerCase();
      if (p.id) ps += '#' + p.id;
      else if (typeof p.className === 'string' && p.className.trim()) ps += '.' + p.className.trim().split(/\s+/)[0];
      s = ps + ' > ' + s;
    }
    return s;
  };
  const rgba = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return { a: 0 };
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { a: p.length > 3 ? p[3] : 1 };
  };
  // Opaque layer: alpha 1 background colour, or a gradient/image (opaque gradient stops).
  const opaque = (el) => {
    const cs = getComputedStyle(el);
    if (rgba(cs.backgroundColor).a >= 0.99) return true;
    if (/gradient\(/.test(cs.backgroundImage)) {
      const stops = cs.backgroundImage.match(/rgba?\([^)]*\)/g) || [];
      return stops.length > 0 && stops.every((s) => rgba(s).a >= 0.99);
    }
    return false;
  };
  const visible = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  // e is "floating" for the box el when e, or an ancestor of e below the common ancestor, is itself sticky/fixed:
  // that is another bar or popup, judged on its own. A scroller that CONTAINS el is the page el scrolls in, not another bar.
  const isFloating = (e, el) => {
    for (let x = e; x && x.nodeType === 1 && !(el && x.contains(el)); x = x.parentElement) {
      const p = getComputedStyle(x).position;
      if (p === 'sticky' || p === 'fixed') return true;
    }
    return false;
  };
  const scrollers = () => {
    const l = [];
    document.querySelectorAll('*').forEach((e) => {
      const cs = getComputedStyle(e);
      const oy = /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4;
      const ox = /(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 4;
      if ((oy || ox) && visible(e)) l.push(e);
    });
    const de = document.scrollingElement;
    if (de && (de.scrollHeight > de.clientHeight + 4 || de.scrollWidth > de.clientWidth + 4)) l.push(de);
    return l;
  };
  const stickies = () => {
    const l = [];
    document.querySelectorAll('body *').forEach((e) => {
      const p = getComputedStyle(e).position;
      if ((p === 'sticky' || p === 'fixed') && visible(e)) l.push(e);
    });
    return l;
  };
  const seen = new Set();
  const flag = (el, why) => {
    const k = sigOf(el) + ' | ' + why;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ sel: sigOf(el), why });
  };
  const checkOne = (el) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const cs = getComputedStyle(el);
    // A full-viewport translucent backdrop is a modal dimmer, not a bar; its panels are checked on their own.
    if (r.width * r.height >= 0.9 * vw * vh && !opaque(el)) return;
    // An invisible helper with no text anywhere inside paints nothing to hide behind.
    if (!el.textContent.trim() && !el.querySelector('input,select,textarea,button,canvas,svg,img')) return;
    const xs = [0.1, 0.35, 0.65, 0.9];
    const ys = [0.25, 0.75];
    for (const fy of ys) for (const fx of xs) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 1 || y < 1 || x > vw - 1 || y > vh - 1) continue;
      const list = document.elementsFromPoint(x, y);
      if (!list.some((e) => el.contains(e))) continue; // clipped away by an ancestor: nothing shows here
      const iOp = list.findIndex((e) => el.contains(e) && opaque(e));
      const outside = (e) => !el.contains(e) && !e.contains(el) && !isFloating(e, el);
      const iTop = list.findIndex((e) => el.contains(e)); // the sticky box's own topmost layer
      const over = list.find((e, i) => outside(e) && i < (iOp >= 0 ? iOp : iTop) && hasOwnText(e));
      if (over) {
        flag(el, 'scrolled text of ' + sigOf(over) + ' paints above it (z-index)');
        return;
      }
      if (iOp < 0) {
        const under = list.find((e) => outside(e) && hasOwnText(e));
        if (under) {
          flag(el, 'transparent: text of ' + sigOf(under) + ' shows through (no opaque background)');
          return;
        }
      }
    }
  };
  // Gap check: a STUCK sticky box that sits below the top of its scroll container (padding of the container, or top:Npx)
  // leaves a strip above it where scrolled text shows. Stuck = its top did not move between two scroll positions.
  const scrollParent = (el) => {
    let sc = el.parentElement;
    while (sc && sc !== document.body && sc !== document.documentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) return sc;
      sc = sc.parentElement;
    }
    return null;
  };
  const gapOf = (el) => {
    const sc = scrollParent(el);
    const cr = sc ? sc.getBoundingClientRect() : { top: 0 };
    return el.getBoundingClientRect().top - cr.top - (sc ? sc.clientTop : 0);
  };
  const checkGap = (el, g1, g2) => {
    const gap = g2;
    if (Math.abs(g1 - g2) > 0.5 || gap < 2) return; // not stuck, or flush with the top of the scroll container
    const sc = scrollParent(el);
    const cr = sc ? sc.getBoundingClientRect() : { top: 0 };
    const r = el.getBoundingClientRect();
    const y = cr.top + (sc ? sc.clientTop : 0) + gap / 2;
    const hit = document.elementsFromPoint(r.left + r.width / 2, y).find((e) => !e.contains(el) && !el.contains(e) && !isFloating(e, el));
    if (hit && (hasOwnText(hit) || hit.querySelector('*')))
      flag(el, 'gap above it: stuck ' + Math.round(gap) + 'px below the top of its scroll container; scrolled content shows in that strip (' + sigOf(hit) + ')');
  };
  const run = () => {
    stickies().forEach((el) => checkOne(el));
  };
  const gapRun = (sc) => {
    const els = stickies().filter((e) => getComputedStyle(e).position === 'sticky' && (scrollParent(e) || document.scrollingElement) === sc);
    return els.map((e) => [e, gapOf(e)]);
  };
  const scs = scrollers();
  window.__stickyInfo = { scrollers: scs.map(sigOf), stickies: stickies().map((e) => sigOf(e) + ' [' + getComputedStyle(e).position + ']') };
  const saved = scs.map((s) => [s, s.scrollTop, s.scrollLeft]);
  run(); // at rest
  for (const s of scs) {
    for (const frac of [0.25, 1]) {
      for (const dir of ['y', 'x', 'xy']) {
        s.scrollTop = dir.includes('y') ? Math.max(0, (s.scrollHeight - s.clientHeight) * frac) : 0;
        s.scrollLeft = dir.includes('x') ? Math.max(0, (s.scrollWidth - s.clientWidth) * frac) : 0;
        run();
      }
    }
    // Gap: two vertical scroll positions; a sticky box whose gap is the same at both is stuck.
    const max = s.scrollHeight - s.clientHeight;
    if (max > 20) {
      s.scrollTop = max * 0.6;
      const a = gapRun(s);
      s.scrollTop = max;
      const b = new Map(gapRun(s));
      a.forEach(([e, g1]) => { if (b.has(e)) checkGap(e, g1, b.get(e)); });
    }
    s.scrollTop = 0; s.scrollLeft = 0;
  }
  saved.forEach(([s, t, l]) => { s.scrollTop = t; s.scrollLeft = l; });
  return out;
}

// Static rule: a position:sticky declaration (CSS rule or inline style string) must not set a translucent background
// (rgba / transparent / none). A tint goes in background-image over an opaque background-color.
function staticStickyLint() {
  const bad = [];
  const files = ['energy-department.html', 'ems-leads.html', 'index.html', 'feedback-widget.css', 'sidebar-rail.css', 'lib/theme.css'];
  for (const d of ['app', 'lib']) for (const f of fs.readdirSync(path.join(ROOT, d))) if (/\.(js|css)$/.test(f)) files.push(d + '/' + f);
  let n = 0;
  for (const f of files) {
    let t;
    try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
    const re = /position:\s*sticky/g;
    let m;
    while ((m = re.exec(t))) {
      n++;
      const open = t.lastIndexOf('{', m.index), close = t.lastIndexOf('}', m.index);
      const lineStart = t.lastIndexOf('\n', m.index);
      const inRule = open > close;
      const start = inRule ? open : lineStart;
      const end = inRule ? t.indexOf('}', m.index) : t.indexOf('\n', m.index);
      const seg = t.slice(start, end < 0 ? t.length : end);
      const bg = /background(?:-color)?:\s*(rgba?\(\s*[^)]*,\s*0?\.\d+\s*\)|transparent|none)/.exec(seg);
      if (bg) bad.push(f + ':' + (t.slice(0, m.index).split('\n').length) + ' sticky with a translucent background (' + bg[1] + ')');
    }
  }
  return { n, bad };
}

// The gate must be able to fail: inject known-bad boxes, then known-good ones, and check the scan sees exactly the bad ones.
async function selfTest(page) {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'stickyProbe';
    host.style.cssText = 'position:fixed;left:300px;top:100px;width:900px;height:240px;z-index:1;display:flex;gap:10px;background:var(--bg)';
    const box = (id, pad, headStyle) => {
      let rows = '';
      for (let i = 0; i < 30; i++) rows += '<div class="pr" style="height:20px;position:relative;z-index:5">row text ' + i + '</div>';
      return '<div id="' + id + '" style="width:200px;height:240px;overflow:auto;padding:' + pad + 'px 0 0 0;background:var(--s2)">' +
        '<div class="ph" style="' + headStyle + '">HEAD ' + id + '</div>' + rows + '</div>';
    };
    host.innerHTML =
      box('pTransparent', 0, 'position:sticky;top:0;z-index:30;height:24px') +
      box('pLowZ', 0, 'position:sticky;top:0;z-index:1;height:24px;background:var(--s1)') +
      box('pPadGap', 16, 'position:sticky;top:0;z-index:30;height:24px;background:var(--s1)') +
      box('pGood', 0, 'position:sticky;top:0;z-index:30;height:24px;background:var(--s1)');
    document.body.appendChild(host);
  });
  const found = await page.evaluate(scanInPage);
  await page.evaluate(() => document.getElementById('stickyProbe').remove());
  const has = (id, re) => found.some((f) => f.sel.includes(id) && re.test(f.why));
  return {
    transparent: has('pTransparent', /transparent/),
    lowz: has('pLowZ', /z-index/),
    gap: has('pPadGap', /gap above/),
    goodClean: !found.some((f) => f.sel.includes('pGood')),
    raw: found.map((f) => f.sel + ' | ' + f.why),
  };
}

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-files-'));
  const fA = path.join(dir, 'synthA.pdf');
  fs.writeFileSync(fA, pdfA);
  let total = 0;
  const fails = {};
  const counts = {};
  const ctx = await launch('sticky-no-bleed', { viewport: { width: 1280, height: 960 } });
  try {
    await fastNet(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => verbose && console.log('PAGEERR ' + e.message));
    await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
    await ctx.addInitScript((a) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      const cid = 'cust_' + a.pid;
      localStorage.setItem('en_projects', JSON.stringify([{ id: a.pid, name: 'SYNTHETIC', client: 'S', customerId: cid, addr: '', type: 'Test', status: 'active', phase: '', contacts: [], scope: { buildingIds: ['bs1', 'bs2'], meterExcludeIds: [] }, savingsData: { measures: [] } }]));
      localStorage.setItem('en_customers', JSON.stringify([{ id: cid, name: 'Synth Customer' }]));
      const mk = (bid, k) => {
        const bills = [];
        for (let i = 0; i < 36; i++) {
          const y = 2023 + Math.floor(i / 12), m = (i % 12) + 1, mm = String(m).padStart(2, '0');
          bills.push({ id: bid + 'b' + i, start: y + '-' + mm + '-01', end: y + '-' + mm + '-28', kwh: 10000 + k * 500 + i * 37, kw: 40 + (i % 7), totalCost: 1000 + i * 11 + k * 90 });
        }
        return bills;
      };
      localStorage.setItem('en_utility_' + cid, JSON.stringify({ buildings: [
        { id: 'bs1', name: 'Synth Hall', addr: '1 Test St', sqft: 20000, meters: [{ id: 'ms1', commodity: 'Electric', provider: 'SynElectric', account: 'E-111', bills: mk('a', 1) }] },
        { id: 'bs2', name: 'Synth Annex', addr: '2 Test St', sqft: 15000, meters: [{ id: 'ms2', commodity: 'Electric', provider: 'SynElectric', account: 'E-222', bills: mk('b', 2) }] },
      ] }));
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, rnShowMode: 'never' }));
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    }, { pid: PID });
    const record = async (label) => {
      await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} }));
      const found = await page.evaluate(scanInPage);
      counts[label] = (await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { const p = getComputedStyle(e).position; if (p !== 'sticky' && p !== 'fixed') return false; const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; }).length));
      if (verbose) { const inf = await page.evaluate(() => window.__stickyInfo); console.log('== ' + label + ' | scrollers: ' + inf.scrollers.join(' ; ') + ' | sticky/fixed: ' + inf.stickies.join(' ; ')); }
      for (const f of found) {
        const k = f.sel + ' | ' + f.why;
        if (!fails[k]) { fails[k] = []; total++; }
        fails[k].push(label);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label.replace(/\W+/g, '-') + '.png') }).catch(() => {});
      }
    };
    const dirOk = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} };
    if (SHOTS) dirOk(SHOTS);
    for (const p of ['index.html', 'ems-leads.html']) {
      await page.goto(base + p);
      await page.waitForTimeout(1500);
      await record(p);
    }
    await page.goto(base + 'energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof _pdfExportAllKeys === 'function' && window.CH_AUTH, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await record('home');
    const st = await selfTest(page);
    if (verbose) console.log('self-test: ' + JSON.stringify(st));
    if (!(st.transparent && st.lowz && st.gap && st.goodClean)) { total++; fails['gate self-test | the scan did not flag the known-bad probes (or flagged the good one): ' + JSON.stringify(st)] = ['self-test']; }
    // PDF / OCR with a synthetic 12-bill file, scrolled.
    await page.evaluate(() => sv('pdf', null));
    await page.waitForTimeout(500);
    await record('pdf-empty');
    await page.setInputFiles('#pdfInput', fA);
    await page.waitForFunction(() => (window._pdfMultiBills && window._pdfMultiBills.length) || (window._pdfQueue && window._pdfQueue.status === 'done'), null, { timeout: 90000 });
    await page.waitForTimeout(900);
    await record('pdf-ocr loaded');
    for (const w of [960, 640]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(500);
      await record('pdf-ocr loaded @' + w);
    }
    if (SHOTS) {
      for (const w of [960, 640]) {
        await page.setViewportSize({ width: w, height: 1000 });
        await page.waitForTimeout(500);
        await page.evaluate(() => { document.getElementById('view-pdf').scrollTop = 300; const t = document.getElementById('toast'); if (t) t.style.display = 'none'; });
        await page.screenshot({ path: path.join(SHOTS, 'pdf-' + w + '-scrolled.png') });
        await page.evaluate(() => { document.getElementById('view-pdf').scrollTop = 0; });
      }
    }
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.waitForTimeout(300);
    // Save the bills to a meter so the project has a real Utility Data bills table.
    await page.evaluate(() => { try { return savePDFAllBills(); } catch (e) { return String(e); } });
    await page.waitForTimeout(2000);
    await page.evaluate(() => sv('projects', document.querySelector('.s-item[onclick*="\'projects\'"]')));
    await page.waitForTimeout(500);
    await record('projects');
    await page.evaluate((id) => openDetail(id), PID);
    await page.waitForTimeout(800);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#pdTabBar button[data-tab]')].map((b) => b.dataset.tab));
    for (const t of tabs) {
      await page.evaluate((tab) => sPTab(tab, document.querySelector('#pdTabBar button[data-tab="' + tab + '"]')), t);
      await page.waitForTimeout(600);
      await record('tab ' + t);
      if (SHOTS && t === 'utility') {
        await page.evaluate(() => { const b = document.getElementById('billsScrollBody'); b.scrollTop = 400; b.scrollLeft = 300; });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOTS, 'utility-bills-scrolled.png') });
      }
    }
    for (const v of ['settings', 'backlog', 'pricing', 'calendar']) {
      const ok = await page.evaluate((view) => { const it = document.querySelector('.s-item[onclick*="\'' + view + '\'"]'); if (!it) return false; sv(view, it); return true; }, v);
      if (!ok) continue;
      await page.waitForTimeout(700);
      await record('view ' + v);
    }
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const lint = staticStickyLint();
  lint.bad.forEach((b) => { total++; fails[b] = ['static']; });
  console.log('static: ' + lint.n + ' position:sticky declarations read; ' + lint.bad.length + ' with a translucent background');
  if (verbose) Object.keys(counts).forEach((k) => console.log('sticky/fixed elements on [' + k + ']: ' + counts[k]));
  console.log('browser: ' + BROWSER + '; pages scanned: ' + Object.keys(counts).length + '; sticky/fixed elements seen (sum): ' + Object.values(counts).reduce((a, b) => a + b, 0));
  console.log('sticky/fixed bleed failures: ' + total);
  Object.keys(fails).forEach((k) => console.log('  FAIL ' + k + '  [' + [...new Set(fails[k])].slice(0, 4).join(', ') + ']'));
  if (total) { console.log('FAIL: text must never show through or above a sticky/fixed element; see header of tools/test-sticky-no-bleed.js'); process.exit(1); }
  console.log('PASS');
})().catch((e) => { console.log('ERROR ' + e.stack); try { srv.close(); } catch (x) {} process.exit(2); });
