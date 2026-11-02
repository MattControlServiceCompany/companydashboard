// tools/test-savings-zero-neutral-positive-total.js - synthetic values only.
// Run: node tools/test-savings-zero-neutral-positive-total.js
// Rule (Matt): a savings figure that DISPLAYS as zero is neutral; green only if it displays > 0, red only if it displays < 0;
// '+' only for > 0. A billable (floored) $0 whose measured value is negative shows both values in red: "-$2,023 -> $0".
// Part 1: the shared helpers in computations/savings.js (behaviour, run in a vm).
// Part 2: the real Energy Graphics quarterly table and Project Performance quarter table, rendered in headless Chromium.
//         Part 2 needs a CompanyHub backup file (CH_TEST_BACKUP, or the newest nightly backup) and skips without it.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  FAIL: ' + m); } };

// ---- Part 1: helpers ----
function fnSrc(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
}
const sav = path.join(REPO, 'computations', 'savings.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(['savingsShown', 'savingsSignColor', 'savingsSign', 'savingsFlooredShown', 'sumPositiveSavings'].map((n) => fnSrc(sav, n)).join('\n'), ctx);
const col = (v, d) => ctx.savingsSignColor(v, d, 'G', 'R', 'N');
const MINUS = '\u2212';
// 0, 0.004, -0.004, 0.006 at 2 and 0 decimals
ok(col(0, 2) === 'N' && col(0, 0) === 'N', '0 neutral');
ok(col(0.004, 2) === 'N', '0.004 at 2 decimals shows $0.00: neutral');
ok(col(-0.004, 2) === 'N', '-0.004 at 2 decimals shows $0.00: neutral (not red)');
ok(col(0.006, 2) === 'G', '0.006 at 2 decimals shows $0.01: green');
ok(col(0.004, 0) === 'N' && col(-0.004, 0) === 'N' && col(0.006, 0) === 'N', 'near-zero at 0 decimals is neutral');
ok(col(-0.006, 2) === 'R', '-0.006 at 2 decimals shows -$0.01: red');
ok(col(0.5, 0) === 'G' && col(-0.5, 0) === 'R', '0.5 at 0 decimals rounds away from zero: shows 1');
ok(col(null, 2) === 'N' && col(undefined, 2) === 'N' && col(NaN, 2) === 'N', 'null/undefined/NaN neutral');
ok(col(5, 0) === 'G' && col(-5, 0) === 'R', 'whole positive green, negative red');
const sg = (v, d, mo) => ctx.savingsSign(v, d, mo);
ok(sg(0, 2) === '' && sg(0.004, 2) === '' && sg(-0.004, 2) === '', 'no sign for a figure that shows 0 (no "+0")');
ok(sg(0.006, 2) === '+' && sg(-0.006, 2) === MINUS, '+ only for > 0, minus only for < 0');
ok(sg(0.004, 0) === '' && sg(-0.004, 0) === '' && sg(0.006, 0) === '', 'near-zero at 0 decimals: no sign');
ok(sg(5, 0, true) === '' && sg(-5, 0, true) === MINUS, 'minusOnly: no plus');
ok(ctx.sumPositiveSavings([100, -40, 25.5, 0, -1]) === 125.5, 'positive-only sum');
ok(ctx.sumPositiveSavings([-1, -2]) === 0 && ctx.sumPositiveSavings([]) === 0, 'all negative / empty sums to 0');
// floored negative vs true zero
const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fl = ctx.savingsFlooredShown(-2023.4, 0, 0, fmt$, 'G', 'R', 'N');
ok(fl.floored === true && fl.color === 'R' && fl.text === MINUS + '$2,023 \u2192 $0', 'floored negative: both values, red: ' + fl.text);
const flp = ctx.savingsFlooredShown(-1.2, 0, 1, (n) => n.toFixed(1) + '%', 'G', 'R', 'N');
ok(flp.floored && flp.color === 'R' && flp.text === MINUS + '1.2% \u2192 0.0%', 'floored percent: ' + flp.text);
const z = ctx.savingsFlooredShown(0, 0, 0, fmt$, 'G', 'R', 'N');
ok(!z.floored && z.color === 'N' && z.text === '$0', 'true zero: neutral, one value: ' + z.text);
const z2 = ctx.savingsFlooredShown(-0.004, 0, 2, (n) => '$' + n.toFixed(2), 'G', 'R', 'N');
ok(!z2.floored && z2.color === 'N' && z2.text === '$0.00', 'measured -0.004 shows $0.00: not floored, neutral');
const p = ctx.savingsFlooredShown(1500, 1500, 0, fmt$, 'G', 'R', 'N');
ok(!p.floored && p.color === 'G' && p.text === '$1,500', 'positive: green, no plus');
const pp = ctx.savingsFlooredShown(2.4, 2.4, 1, (n) => n.toFixed(1) + '%', 'G', 'R', 'N', true);
ok(pp.text === '+2.4%' && pp.color === 'G', 'plus option: ' + pp.text);

// ---- Part 2: rendered tables ----
function findBackup() {
  if (process.env.CH_TEST_BACKUP && fs.existsSync(process.env.CH_TEST_BACKUP)) return process.env.CH_TEST_BACKUP;
  const root = 'C:/Users/Matt Miller/OneDrive - Control Service Company/CompanyHub Database Backups';
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter((n) => /^\d{4}-\d\d-\d\d-companyhub-db-backup$/.test(n)).sort().reverse();
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(root, d)).find((n) => /^CompanyHub-localdatafile-\d+\.json$/.test(n));
    if (f) return path.join(root, d, f);
  }
  return null;
}

async function part2() {
  const bk = findBackup();
  if (!bk) { console.log('  SKIP part 2 (no backup file)'); return; }
  const { launchBrowser } = require('./launch-browser.js');
  const bctx = await launchBrowser('zeroneutral', { viewport: { width: 1700, height: 1000 } });
  try {
    await bctx.route((u) => !u.protocol.startsWith('file'), (r) => {
      if (r.request().url().startsWith('https://cdnjs.cloudflare.com/') && r.request().method() === 'GET') return r.continue();
      r.abort();
    });
    await bctx.addInitScript(() => {
      if (!localStorage.getItem('__seeded')) {
        const d = { ch_settings: { showQuickStart: false }, ch_theme: 'dark', ch_activeView: 'projects', ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false } };
        for (const k in d) localStorage.setItem(k, JSON.stringify(d[k]));
        localStorage.setItem('__seeded', '1');
      }
    });
    const page = await bctx.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message.slice(0, 200)));
    const site = 'file:///' + REPO.replace(/\\/g, '/') + '/energy-department.html';
    await page.goto(site);
    await page.waitForTimeout(3000);
    const data = JSON.parse(fs.readFileSync(bk, 'utf8'));
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length; i += 20) {
      const chunk = {};
      keys.slice(i, i + 20).forEach((k) => (chunk[k] = data[k]));
      await page.evaluate(async (c) => { for (const k in c) await DB.set(k, c[k]); }, chunk);
    }
    await page.goto(site);
    await page.waitForTimeout(5000);
    const wantName = process.env.CH_TEST_PROJECT || ''; // optional project name; default is the first project
    const pid = await page.evaluate((n) => (projects.find((p) => p.name === n) || projects[0]).id, wantName);
    // The colours the page resolves for the palette names, so a cell colour can be compared by name.
    const pal = await page.evaluate(() => {
      const probe = (v) => { const e = document.createElement('span'); e.style.color = v; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { text: probe('var(--text)'), green: probe('var(--green)'), red: probe('var(--red)'), danger: probe('var(--danger)'), em: probe('var(--em)') };
    });
    // Replace the ONE billable function with a fixed answer (the renderers call it by name at render time).
    const setBill = (total, measured) => page.evaluate(([t, m]) => {
      window.billableSavingsWithPresented = () => ({ total: t, measured: m, byBldg: {}, applied: [], missing: {}, weatherWaiting: {} });
    }, [total, measured]);
    const egfxRows = async () => {
      await page.evaluate((id) => { openDetail(id); sPTab('energygfx', document.querySelector('.pdt[data-tab="energygfx"]')); }, pid);
      await page.waitForTimeout(5000);
      return page.evaluate(() => {
        const t = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && /Quarterly Savings vs Baseline$/.test(d.textContent.trim()));
        const card = t && t.closest('.card');
        if (!card) return null;
        return [...card.querySelectorAll('tbody tr')].filter((tr) => tr.cells.length >= 4).map((tr) => { const c = tr.cells; return [c[c.length - 2], c[c.length - 1]].map((x) => ({ text: x.textContent.trim(), color: getComputedStyle(x).color })); });
      });
    };
    // Floored negative: measured -2023.4, billable 0.
    await setBill(0, -2023.4);
    let rows = await egfxRows();
    ok(rows && rows.length > 0, 'Energy Graphics quarterly table rendered rows');
    const redOk = (c) => c === pal.red || c === pal.danger;
    const flooredRows = (rows || []).filter((r) => /\u2192/.test(r[0].text));
    ok(flooredRows.length > 0, 'EG quarterly: a floored row shows measured -> $0 (' + JSON.stringify((rows || [])[0]) + ')');
    flooredRows.forEach((r) => {
      ok(/^\u2212\$[\d,]+ \u2192 \$0$/.test(r[0].text) && redOk(r[0].color), 'EG quarterly savings cell red, both values: ' + r[0].text);
      ok(/^\u2212[\d.]+% \u2192 0\.0%$/.test(r[1].text) && redOk(r[1].color), 'EG quarterly percent cell red, both values: ' + r[1].text);
    });
    // True zero (measured 0.004, billable 0.004): neutral, no sign, no arrow.
    await setBill(0.004, 0.004);
    rows = await egfxRows();
    (rows || []).filter((r) => !/Waiting/.test(r[0].text)).forEach((r) => {
      ok(r[0].text === '$0' && r[0].color === pal.text, 'EG quarterly near-zero cell neutral "$0": ' + r[0].text + ' ' + r[0].color);
      ok(/^0\.0%$/.test(r[1].text) && r[1].color === pal.text, 'EG quarterly near-zero percent neutral "0.0%" (no +): ' + r[1].text);
    });
    // Project Performance quarter table.
    const ppFoot = async () => {
      await page.evaluate((id) => { toggleProjDetailPanel(id, 'perf'); }, pid);
      await page.waitForTimeout(3000);
      const hasQ = await page.evaluate(() => { const e = document.getElementById('pp-qtr-sel'); return !!(e && e.options.length); });
      if (!hasQ) { console.log('  note: no pp-qtr-sel; panel text: ' + (await page.evaluate((id) => (document.getElementById('pd-proj-panel-content-' + id) || {}).innerText || 'none', pid)).slice(0, 200)); return null; }
      return page.evaluate(() => [...document.querySelectorAll('#pp-qtr-table tfoot tr')].filter((tr) => tr.cells.length >= 2).map((tr) => ({ label: tr.cells[0].textContent.trim(), text: tr.cells[1].textContent.trim(), color: getComputedStyle(tr.cells[1]).color })));
    };
    await setBill(0, -2023.4);
    let foot = await ppFoot();
    ok(foot && foot[0] && foot[0].label === 'Total (billable, not below $0)', 'PP quarter footer label: ' + (foot && foot[0] && foot[0].label));
    ok(foot && foot[0] && foot[0].text === MINUS + '$2,023.40 \u2192 $0.00' && redOk(foot[0].color), 'PP quarter footer floored: red, both values: ' + (foot && foot[0] && foot[0].text));
    await page.evaluate((id) => { toggleProjDetailPanel(id, 'perf'); }, pid); // close
    await setBill(0.004, 0.004);
    foot = await ppFoot();
    ok(foot && foot[0] && foot[0].text === '$0.00' && foot[0].color === pal.text, 'PP quarter footer near-zero neutral "$0.00": ' + (foot && foot[0] && foot[0].text));
  } finally {
    await bctx.close();
  }
}

part2()
  .catch((e) => { failed++; console.log('  FAIL: part 2 error: ' + e.message); })
  .then(() => {
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log(failed ? 'FAILED' : 'ALL PASS');
    process.exit(failed ? 1 : 0);
  });
