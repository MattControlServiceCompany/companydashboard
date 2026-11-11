// tools/test-dashboard-performance-table.js -- item d61eb6cd (Matt, 2026-11-11): the Dashboard "Building Performance" table and the
// quarter card. Synthetic data only; the real app (initDashboardTab) runs in headless Chromium. getMeterSavings is replaced by fixed
// monthly savings so the table logic is checked without weather; Savings $ / % must come out exactly as the stub says (not touched).
// Checks:
//  A  headers say "Baseline Site EUI" / "Current Site EUI" with the full-words title; no "Energy Use Intensity" in the header text
//  B  the header is one line (every th white-space:nowrap, row height of one line) at 1920 px
//  C  Current Site EUI = trailing 12 complete bill months ending at the newest bill month (computePeriodEUI); "--" with 9 months; tooltip names the months
//  D  the Unmatched Bills bucket is not a row
//  E  a building with every meter excluded reads "Not in scope"; a building with in-scope meters and no data keeps "No Data"
//  F  Period = the savings months; Baseline $ = baseline cost of those months; Current $ = that less the savings; Savings $ and % unchanged
//  G  the quarter card shows "-$X -> $0" when the quarter floors to $0 (measured value beside the billed value)
// Run: CH_TMP_ROOT=<scratch> node tools/test-dashboard-performance-table.js   Exit 1 on any FAIL.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const TMP = require('./tmp-root.js');
const ROOT = path.join(__dirname, '..');
const { fastNet } = require(path.join(ROOT, 'tools', 'pdf-test-net.js'));
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const PID = 999000555;
let fails = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => { fails++; console.log('  FAIL ' + m); };
const check = (c, m) => (c ? ok(m) : fail(m));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/energy-department.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.normalize(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}/`;
  const ctx = await launchBrowser('dash-perf-table', { viewport: { width: 1920, height: 1080 } });
  try {
    await fastNet(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
    await ctx.addInitScript((a) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      const cid = 'cust_' + a.pid;
      localStorage.setItem('en_projects', JSON.stringify([{
        id: a.pid, name: 'SYNTHETIC', client: 'S', customerId: cid, addr: '', type: 'Test', status: 'active', phase: '', contacts: [],
        baselineComparison: 'normalized',
        scope: { buildingIds: ['bAlpha', 'bBeta', 'bMaint', 'bUnm', 'bEmpty'], meterExcludeIds: ['mMaint'] }, savingsData: { measures: [] },
      }]));
      localStorage.setItem('en_customers', JSON.stringify([{ id: cid, name: 'Synth Customer' }]));
      const ymOf = (i) => { const t = 2025 * 12 + i; return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0'); };
      // Alpha: 21 monthly bills 2025-01 .. 2026-09; baseline = the 2025 months; the cost of 2025 month k is 1000 + 10k.
      const mk = (id, n, kwh) => {
        const bills = [];
        for (let i = 0; i < n; i++) {
          const ym = ymOf(i);
          bills.push({ id: id + 'b' + i, start: ym + '-01', end: ym + '-28', kwh, totalCost: 1000 + 10 * (i % 12), kwKw: 50, demandKW: 50 });
        }
        return bills;
      };
      const blMonths = []; for (let i = 0; i < 12; i++) blMonths.push(ymOf(i));
      const elec = (id, n, kwh, bl) => ({ id, commodity: 'Electric', provider: 'Syn', account: id, inclusive: true, bills: mk(id, n, kwh), baseline: bl ? { months: blMonths.slice() } : undefined });
      localStorage.setItem('en_utility_' + cid, JSON.stringify({ buildings: [
        { id: 'bAlpha', name: 'Alpha', sqft: 10000, meters: [elec('mAlpha', 21, 10000, true)] },
        // Beta: baseline + only 9 bills after... 2025-01..2025-12 baseline but bills end 2026-02 -> window Mar 2025 - Feb 2026 is complete; use 8 bills so it is NOT complete
        { id: 'bBeta', name: 'Beta', sqft: 5000, meters: [elec('mBeta', 8, 4000, true)] },
        { id: 'bMaint', name: 'Maintenance', sqft: 0, meters: [elec('mMaint', 21, 500, false)] },
        { id: 'bUnm', name: 'Unmatched Bills', sqft: 0, _unmatchedSentinel: true, meters: [Object.assign(elec('mUnm', 2, 0, false), { commodity: 'Water' })] },
        { id: 'bEmpty', name: 'Empty Hall', sqft: 3000, meters: [{ id: 'mEmpty', commodity: 'Electric', provider: 'Syn', account: 'x', inclusive: true, bills: [] }] },
      ] }));
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, rnShowMode: 'never' }));
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    }, { pid: PID });
    await page.goto(base + 'energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof initDashboardTab === 'function' && window.CH_AUTH, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    // Fixed monthly savings for Alpha (Jan..Jun +100, Jul..Sep -50, so Q3 floors to $0) and Beta (+20 for 2026-01, 2026-02).
    await page.evaluate(() => {
      window.getMeterSavings = function (m) {
        const byYM = {};
        if (m.id === 'mAlpha') ['01', '02', '03', '04', '05', '06'].forEach((k) => (byYM['2026-' + k] = 100));
        if (m.id === 'mAlpha') ['07', '08', '09'].forEach((k) => (byYM['2026-' + k] = -50));
        if (m.id === 'mBeta') { byYM['2026-01'] = 20; byYM['2026-02'] = 20; }
        return { byYM, rows: [], total: 0 };
      };
    });
    await page.evaluate((id) => openDetail(id), PID);
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#pdTabBar button[data-tab]')).find((x) => x.dataset.tab === 'dashboard'); if (b) sPTab('dashboard', b); });
    await page.evaluate((id) => initDashboardTab(id), PID);
    await page.waitForTimeout(800);
    const got = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('table.dtbl')).find((x) => /Savings/.test(x.textContent) && /Building/.test(x.textContent) && x.querySelectorAll('tbody tr').length);
      const rows = Array.from(t.querySelectorAll('tbody tr')).map((r) => Array.from(r.children).map((c) => ({ t: c.textContent.trim().replace(/\s+/g, ' '), title: c.getAttribute('title') || '' })));
      const ths = Array.from(t.querySelectorAll('thead th')).map((c) => ({ t: c.textContent.trim().replace(/\s+/g, ' '), title: c.getAttribute('title') || '', ws: getComputedStyle(c).whiteSpace, h: c.getBoundingClientRect().height }));
      const card = Array.from(document.querySelectorAll('.card')).map((c) => c.textContent.replace(/\s+/g, ' ')).find((s) => /Total Cumulative Savings/.test(s)) || '';
      return { rows, ths, card, tw: t.getBoundingClientRect().width, cw: t.parentElement.clientWidth };
    });
    const row = (name) => got.rows.find((r) => r[1].t === name);
    const col = (hdr) => got.ths.findIndex((h) => h.t.replace(/[↕↑↓]/g, '').trim() === hdr);
    const money = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

    // A
    const hdrs = got.ths.map((h) => h.t.replace(/[↕↑↓]/g, '').trim());
    check(hdrs.includes('Baseline Site EUI') && hdrs.includes('Current Site EUI'), 'A headers are "Baseline Site EUI" and "Current Site EUI" (got ' + hdrs.join(' | ') + ')');
    check(!/Energy Use Intensity/.test(hdrs.join(' ')), 'A no spelled-out label in the header text');
    const tipOk = got.ths.filter((h) => /Site EUI/.test(h.t)).every((h) => h.title === 'Site Energy Use Intensity, kBtu per square foot per year');
    check(tipOk, 'A both EUI headers carry the full-words title');
    // B
    check(got.ths.every((h) => h.ws === 'nowrap'), 'B every th is white-space:nowrap (' + got.ths.map((h) => h.ws).join(',') + ')');
    check(got.ths.every((h) => h.h < 45), 'B every header cell is one line high at 1920 px (heights ' + got.ths.map((h) => Math.round(h.h)).join(',') + ')');
    // D
    check(!row('Unmatched Bills'), 'D no Unmatched Bills row (rows: ' + got.rows.map((r) => r[1].t).join(', ') + ')');
    // E
    const iSt = col('Status');
    check(row('Maintenance') && row('Maintenance')[iSt].t === 'Not in scope', 'E all-excluded building reads "Not in scope" (got ' + (row('Maintenance') && row('Maintenance')[iSt].t) + ')');
    check(row('Empty Hall') && row('Empty Hall')[iSt].t === 'No Data', 'E in-scope building with no data keeps "No Data" (got ' + (row('Empty Hall') && row('Empty Hall')[iSt].t) + ')');
    // C
    const iCE = col('Current Site EUI');
    const a = row('Alpha'), b = row('Beta');
    // Alpha window = 2025-10 .. 2026-09 (12 months, 10000 kWh each) = 120000 kWh x 3.412 kBtu over 10000 sf
    const expEui = (120000 * 3.412) / 10000;
    check(a && Math.abs(Number(a[iCE].t) - expEui) < 0.06, 'C Alpha Current Site EUI = ' + expEui.toFixed(1) + ' (got ' + (a && a[iCE].t) + ')');
    check(a && a[iCE].title === 'Trailing 12 months: Oct 2025 – Sep 2026', 'C Alpha tooltip names the months (got "' + (a && a[iCE].title) + '")');
    check(b && b[iCE].t === '—', 'C Beta with 8 bill months shows "—" (got ' + (b && b[iCE].t) + ')');
    // F: period Jan 26 - Sep 26 (earliest 2026-01, latest 2026-09). Baseline cost of calendar month k = 1000 + 10 (k-1) for Alpha.
    const iP = col('Period'), iBl = col('Baseline $'), iCu = col('Current $'), iSv = col('Savings $'), iPc = col('%');
    check(a && a[iP].t === 'Jan 26 – Sep 26', 'F Period = the savings months (got ' + (a && a[iP].t) + ')');
    let blP = 0; for (let k = 1; k <= 9; k++) blP += 1000 + 10 * (k - 1);
    check(a && money(a[iBl].t) === blP, 'F Alpha Baseline $ = baseline cost of Jan-Sep = ' + blP + ' (got ' + (a && a[iBl].t) + ')');
    // Alpha billed savings: quarter net Q1 300, Q2 300, Q3 -150; the building row is the net sum, 450
    check(a && money(a[iCu].t) === blP - 450, 'F Alpha Current $ = Baseline $ less the savings of those months = ' + (blP - 450) + ' (got ' + (a && a[iCu].t) + ')');
    check(a && money(a[iSv].t) === 450, 'F Alpha Savings $ unchanged = 450 (got ' + (a && a[iSv].t) + ')');
    check(a && a[iPc].t === (450 / blP * 100).toFixed(1) + '%', 'F Alpha % = Savings $ / the Baseline $ shown in the same row (' + (450 / blP * 100).toFixed(1) + '%, got ' + (a && a[iPc].t) + ')');
    check(/Baseline\s*\$[\d,]+\s*Current\s*\$[\d,]+\s*for Jan 26 – Sep 26/.test(got.card), 'F header card names the period (card text: ' + got.card.slice(got.card.indexOf('Baseline') > 0 ? got.card.indexOf('Baseline') : 0, 260).slice(0, 120) + ')');
    // B at 1366: the table fits its card, headers on one line
    await page.setViewportSize({ width: 1366, height: 1080 });
    await page.waitForTimeout(600);
    const n = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('table.dtbl')).find((x) => /Savings/.test(x.textContent) && /Building/.test(x.textContent) && x.querySelectorAll('tbody tr').length);
      const w = t.parentElement;
      return { sw: w.scrollWidth, cw: w.clientWidth, h: Array.from(t.querySelectorAll('thead th')).map((c) => Math.round(c.getBoundingClientRect().height)) };
    });
    check(n.sw <= n.cw, 'B at 1366 px no sideways scroll (scrollWidth ' + n.sw + ' <= clientWidth ' + n.cw + ')');
    check(n.h.every((h) => h < 45), 'B at 1366 px every header cell is one line high (' + n.h.join(',') + ')');
    // G: Q3 net -150, floored to 0
    check(/Q3 2026 Total Savings\s*−\$150 → \$0/i.test(got.card) || /−\$150 → \$0/.test(got.card), 'G quarter card shows the measured value beside the floored $0 (card: ' + (got.card.match(/Q\d 2026 Total Savings[^%]{0,40}/i) || [''])[0] + ')');
    // G (source): "bills through" and the shared floored-display call
    const core = fs.readFileSync(path.join(ROOT, 'app', 'core.js'), 'utf8');
    check(/_curQtrShown = savingsFlooredShown\(/.test(core) && !/function _?quarterFloorText/.test(core), 'G the quarter card reuses savingsFlooredShown (no second formatter)');
    check(/Bills through /.test(core) && /headQtr\.billsThrough/.test(core), 'G an incomplete quarter prints "Bills through <date>" (nextQuarterToPresent.billsThrough)');
    check(/isUnmatchedSentinelBldg/.test(fs.readFileSync(path.join(ROOT, 'app', 'utility-data.js'), 'utf8')) && !/b\._unmatchedSentinel === true\) return false/.test(fs.readFileSync(path.join(ROOT, 'app', 'utility-data.js'), 'utf8')), 'D getIncludedBldgs uses the one sentinel helper');
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(fails ? fails + ' FAIL(s)' : 'PASS: dashboard performance table');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('  CRASH ' + e.stack); process.exit(1); });
