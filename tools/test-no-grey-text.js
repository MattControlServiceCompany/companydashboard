// tools/test-no-grey-text.js - GATE (Matt, 2026-10-22): all text is pure #ffffff on dark and pure #000000 on light.
// No grey / navy / slate text of any shade; de-emphasis is size or weight, never color. Colored status text
// (green/red/amber), links and accent headings are allowed: a color passes only if it is #000, #fff, or SATURATED
// (HSL saturation >= 0.45 and lightness 0.2..0.78). Anything else visible = FAIL. Text faded by opacity between 0.05 and 0.9 = FAIL (fully hidden and mid-fade-in are not).
// Chart.js text (defaults, every live chart's ticks/legend/titles/tooltip, plus a probe chart) must resolve to exactly #fff / #000.
// There is NO allow-list of elements. Fix the token or the rule that sets the color.
// Loads index.html, ems-leads.html and energy-department.html (home, projects list, one synthetic project on every tab)
// headless, in light and dark. SYNTHETIC data only. Run: node tools/test-no-grey-text.js [--verbose]
const { launchBrowser } = require('./launch-browser.js');
const path = require('path');
const ROOT = 'file:///' + path.resolve(__dirname, '..').split(path.sep).join('/') + '/';
const verbose = process.argv.includes('--verbose');
const PID = 999000555;

// Runs in the page. Returns [{sel, color, why, text}] for every visible text element with a non-conforming color.
function scanInPage() {
  function parse(c) {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,\/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function ok(c) {
    if (!c) return true;
    if (c.a < 0.95) return c.a === 0;
    if (c.r === c.g && c.g === c.b && (c.r === 0 || c.r === 255)) return true;
    const r = c.r / 255,
      g = c.g / 255,
      b = c.b / 255;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b),
      l = (mx + mn) / 2;
    const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    return s >= 0.45 && l >= 0.2 && l <= 0.78;
  }
  function visible(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function effOpacity(el) {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  }
  function sig(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim())
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  }
  const out = [];
  const seen = new Set();
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEMPLATE|TITLE)$/;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || SKIP.test(el.tagName) || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const col = el.closest('svg') ? parse(cs.fill) || parse(cs.color) : parse(cs.color);
    const op = effOpacity(el);
    if (!ok(col)) out.push({ sel: sig(el), color: cs.color, why: 'color', text: n.nodeValue.trim().slice(0, 30) });
    else if (op > 0.05 && op < 0.9)
      out.push({
        sel: sig(el),
        color: 'opacity ' + op.toFixed(2),
        why: 'opacity',
        text: n.nodeValue.trim().slice(0, 30),
      });
  }
  document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((el) => {
    if (!visible(el)) return;
    const col = parse(getComputedStyle(el, '::placeholder').color);
    if (!ok(col))
      out.push({
        sel: sig(el) + '::placeholder',
        color: getComputedStyle(el, '::placeholder').color,
        why: 'placeholder',
        text: el.placeholder.slice(0, 30),
      });
  });
  return out;
}

// Runs in the page. Chart.js text colors (defaults + every live chart + one probe chart with no explicit colors) must be exactly #fff (dark) / #000 (light).
function scanChartsInPage() {
  const bad = [];
  if (typeof Chart === 'undefined') return bad; // page does not load Chart.js (index.html, ems-leads.html)
  function norm(c) {
    if (c === undefined || c === null) return 'unset';
    const d = document.createElement('canvas').getContext('2d');
    d.fillStyle = '#123456';
    d.fillStyle = String(c);
    return d.fillStyle; // '#rrggbb' or 'rgba(...)'
  }
  const theme = getComputedStyle(document.documentElement).getPropertyValue('--text').trim().toLowerCase();
  const expect = theme === '#000000' || theme === '#000' ? '#000000' : '#ffffff';
  function chk(where, key, val) {
    const n = norm(val);
    if (n !== expect) bad.push({ where, key, val: String(val) + ' => ' + n });
  }
  chk('Chart.defaults', 'color', Chart.defaults.color);
  const probe = document.createElement('canvas');
  probe.width = 300;
  probe.height = 150;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const pc = new Chart(probe, {
    type: 'bar',
    data: { labels: ['a'], datasets: [{ label: 'd', data: [1] }] },
    options: {
      animation: false,
      scales: { x: { title: { display: true, text: 'x' } }, y: { title: { display: true, text: 'y' } } },
      plugins: { title: { display: true, text: 't' }, legend: { title: { display: true, text: 'lt' } } },
    },
  });
  const charts = Object.values(Chart.instances || {});
  for (const c of charts) {
    const id = c === pc ? 'probe' : 'chart#' + (c.canvas && c.canvas.id);
    const o = c.options || {};
    chk(id, 'options.color', o.color);
    const pl = o.plugins || {};
    if (pl.legend && pl.legend.display !== false && pl.legend.labels) chk(id, 'legend.labels.color', pl.legend.labels.color);
    if (pl.legend && pl.legend.title && pl.legend.title.display) chk(id, 'legend.title.color', pl.legend.title.color);
    if (pl.title && pl.title.display) chk(id, 'title.color', pl.title.color);
    if (pl.tooltip) ['titleColor', 'bodyColor', 'footerColor'].forEach((k) => chk(id, 'tooltip.' + k, pl.tooltip[k]));
    for (const [sid, sc] of Object.entries(c.scales || {})) {
      const so = sc.options || {};
      if (so.display === false) continue;
      if (so.ticks && so.ticks.display !== false) chk(id, 'scale ' + sid + ' ticks.color', so.ticks.color);
      if (so.title && so.title.display) chk(id, 'scale ' + sid + ' title.color', so.title.color);
      if (so.pointLabels && so.pointLabels.display) chk(id, 'scale ' + sid + ' pointLabels.color', so.pointLabels.color);
    }
  }
  pc.destroy();
  probe.remove();
  return bad;
}

(async () => {
  let total = 0;
  const bySig = {};
  for (const theme of ['dark', 'light']) {
    const ctx = await launchBrowser('greytext', { viewport: { width: 1280, height: 900 } });
    try {
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e)));
      await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
      await page.addInitScript(
        (a) => {
          if (window.localStorage.getItem('en_projects')) return;
          window.localStorage.setItem(
            'en_projects',
            JSON.stringify([
              {
                id: a.pid,
                name: 'SYNTHETIC',
                client: 'S',
                addr: '',
                type: 'Test',
                status: 'active',
                phase: '',
                contacts: [],
                savingsData: { measures: [] },
              },
            ]),
          );
          window.localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, theme: a.theme }));
          window.localStorage.setItem('ch_theme', a.theme);
          window.localStorage.setItem(
            'ch_user',
            JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false }),
          );
        },
        { pid: PID, theme },
      );
      const record = async (label) => {
        await page.evaluate(() =>
          document.getAnimations().forEach((a) => {
            try {
              a.finish();
            } catch (e) {}
          }),
        ); // a tip fading in is not a faded label
        const found = await page.evaluate(scanInPage);
        const chartBad = await page.evaluate(scanChartsInPage);
        chartBad.forEach((b) => found.push({ sel: 'chart ' + b.where + ' ' + b.key, color: b.val, why: 'chart-text', text: '' }));
        found.forEach((f) => {
          const k = theme + ' | ' + f.sel + ' | ' + f.color + ' | ' + f.why;
          if (!bySig[k]) total++; // the count is DISTINCT (theme, element rule, color): the same sidebar on 20 tabs counts once
          bySig[k] = bySig[k] || { n: 0, where: label, text: f.text };
          bySig[k].n++;
        });
      };
      for (const p of ['index.html', 'ems-leads.html']) {
        await page.goto(ROOT + p);
        await page.waitForTimeout(1200);
        await record(p);
      }
      await page.goto(ROOT + 'energy-department.html');
      await page.waitForTimeout(2000);
      await record('home');
      await page.evaluate(() => sv('projects', document.querySelector('.s-item[onclick*="\'projects\'"]')));
      await page.waitForTimeout(500);
      await record('projects');
      await page.evaluate((id) => openDetail(id), PID);
      await page.waitForTimeout(600);
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#pdTabBar button[data-tab]')].map((b) => b.dataset.tab),
      );
      for (const t of tabs) {
        await page.evaluate((tab) => sPTab(tab, document.querySelector('#pdTabBar button[data-tab="' + tab + '"]')), t);
        await page.waitForTimeout(350);
        await record('tab ' + t);
      }
      if (errs.length) console.log('page errors (' + theme + '): ' + errs.slice(0, 3).join(' | '));
      await page.close();
    } finally {
      await ctx.close();
    }
  }
  const keys = Object.keys(bySig);
  if (verbose)
    keys
      .sort()
      .forEach((k) => console.log(bySig[k].n + 'x ' + k + '  [' + bySig[k].where + '] "' + bySig[k].text + '"'));
  console.log('grey text rules: ' + total);
  if (total) {
    keys.slice(0, 12).forEach((k) => console.log('  ' + k));
    console.log('FAIL: text must be #fff (dark) / #000 (light); see header of tools/test-no-grey-text.js');
    process.exit(1);
  }
  console.log('PASS');
})().catch((e) => {
  console.log('ERROR ' + e.stack);
  process.exit(2);
});
