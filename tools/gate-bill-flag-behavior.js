/**
 * gate-bill-flag-behavior.js
 *
 * Behavior gate for the one bill-flag engine. It renders the real page (headless bundled Chromium, a
 * SYNTHETIC fixture, never a real backup) and requires, for every meter, that the meter pill, the Bills tab
 * banner and the flagged table rows all equal computeMeterFlagSummary(...).flaggedBills; for the building,
 * that the nav badge equals computeBuildingFlagSummary(...).flaggedBills; and that the Review Bill
 * Corrections panel shows one row per flagged bill. A second copy of the flag logic under ANY name would
 * count differently somewhere and fail here (a name list cannot catch that).
 *
 * A table row is tinted (class bill-flagged) only when the bill has a counted flag (BILL_COUNTED_FLAG_RULES); a bill whose
 * flags are all outside that list shows its reasons in the row hover only.
 * Counted types only (BILL_COUNTED_FLAG_RULES): a bill with only an outlier or read note flag counts 0, a meter excluded
 * from the baseline adds nothing to the building or project count, and an auto-corrected read draws no banner.
 *
 * Usage: node tools/gate-bill-flag-behavior.js [repo-root]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const problems = [];

const PID = 990001;
const mk = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const ymd = (y, m) => y + '-' + String(m).padStart(2, '0') + '-01';
const month = (i) => [2024 + Math.floor(i / 12), (i % 12) + 1];
// gas: a blank total cost (bill 10, counted), a wrong cost column (bill 20) and a printed day count that does not match
// the dates (bill 22): the last two are NOT counted types, so they show on the bill row only
let reads = 1000;
const gas = mk(24, (i) => {
  const [y, m] = month(i);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const th = [300, 250, 180, 100, 50, 30, 25, 25, 40, 90, 180, 280][m - 1];
  const cost = (th + 23.33).toFixed(2);
  return {
    id: 'g' + i,
    start: ymd(y, m),
    end: ymd(ny, nm),
    therms: String(th),
    gasCharge: String(th),
    customerCharge: '23.33',
    fuelAdjustment: '0',
    thermCost: i === 20 ? '9999.00' : cost,
    totalCost: i === 10 ? '' : cost,
    numberOfDays: i === 22 ? '60' : '',
    startRead: String(reads),
    endRead: String((reads += th)),
    readDifference: String(th),
  };
});
// water and sewer: one sewer bill with 5x the gallons of its water bill, one sewer charge 2.5x too high
const wat = (kind) =>
  mk(12, (i) => {
    const [y, m] = month(i);
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const gal = 100000 + (i % 3) * 5000;
    const charge = (gal * 0.01 * (kind === 'sewer' && i === 7 ? 2.5 : 1)).toFixed(2);
    const b = { id: kind[0] + i, start: ymd(y, m), end: ymd(ny, nm), totalCost: charge };
    if (kind === 'water') Object.assign(b, { waterUsage: String(gal), waterCharge: charge });
    else Object.assign(b, { sewerUsage: String(i === 3 ? gal * 5 : gal), sewerCharge: charge });
    return b;
  });
// a second gas meter that will be excluded from the baseline: its blank total cost must not reach the building count
const xgas = mk(12, (i) => {
  const [y, m] = month(i);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const cost = (60 + 23.33).toFixed(2);
  return {
    id: 'x' + i,
    start: ymd(y, m),
    end: ymd(ny, nm),
    therms: '60',
    gasCharge: '60',
    customerCharge: '23.33',
    fuelAdjustment: '0',
    thermCost: cost,
    totalCost: i === 4 ? '' : cost,
  };
});
const udData = {
  buildings: [
    {
      id: 'fb1',
      name: 'Fixture School',
      sqft: '1000',
      meters: [
        { id: 'fm1', commodity: 'Gas', provider: 'Test', bills: gas },
        { id: 'fm2', commodity: 'Water', provider: 'Test', bills: wat('water') },
        { id: 'fm3', commodity: 'Sewer', provider: 'Test', bills: wat('sewer') },
        { id: 'fm4', commodity: 'Gas', provider: 'Test', bills: xgas },
      ],
    },
  ],
};
const fixture = { en_projects: [{ id: PID, name: 'Fixture District', type: 'school' }] };
fixture['en_utility_' + PID] = udData;
fixture['en_utility_cust_' + PID] = udData;

async function main() {
  const PW_MODULES =
    process.env.CH_PLAYWRIGHT_NODE_MODULES ||
    path.join(process.env.CH_CONTEXT_DIR || path.join(require('os').homedir(), 'AI', '_context'), 'tools', 'playwright-runtime', 'node_modules');
  const { chromium } = require(path.join(PW_MODULES, 'playwright'));
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    fs.readFile(path.join(REPO, p), (e, b) => {
      if (e) {
        r.writeHead(404);
        r.end();
        return;
      }
      r.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
      r.end(b);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const prof = path.join(os.tmpdir(), 'bill-flag-gate-profile-' + Date.now());
  const ctx = await chromium.launchPersistentContext(prof, {
    headless: true,
    args: ['--disable-gpu'],
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      localStorage.setItem('ch_backend_mode', 'off');
      localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo', email: 'demo@example.com', demo: true }));
    });
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(3000);
    await page.evaluate(async (fx) => {
      for (const k of Object.keys(fx)) {
        if (typeof _restoreIsLsKey === 'function' && _restoreIsLsKey(k)) localStorage.setItem(k, JSON.stringify(fx[k]));
        else await DB.set(k, fx[k]);
      }
    }, fixture);
    await page.reload();
    await page.waitForTimeout(4000);
    const res = await page.evaluate(async (pid) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { meters: [], bldg: null, panel: null, refresh: null, excl: null, corr: null };
      setBaselineExcluded(pid, 'fm4', true);
      sv('utility');
      await sleep(800);
      udSelectProj(pid);
      await sleep(600);
      const b = getUDProj(pid).buildings[0];
      udSelectBldg(b.id);
      await sleep(400);
      const nav = [...document.querySelectorAll('.ud-nav-bldg-item')].find((e) => e.innerText.includes(b.name));
      const isExcl = (m) => isBaselineExcluded(pid, m.id);
      const bs = computeBuildingFlagSummary(b, isExcl);
      out.bldg = { want: bs.flaggedBills, badge: nav ? +((nav.querySelector('.ud-flag-badge') || { innerText: '' }).innerText.replace(/\D/g, '') || 0) : -1 };
      for (const m of b.meters) {
        udSelectMeter(m.id);
        await sleep(500);
        const s = computeMeterFlagSummary(m, b);
        const pane = document.getElementById('maPane');
        const pills = [...document.querySelectorAll('.ma-meter-pill')];
        const pill = pills.find((e) => e.classList.contains('active')) || pills[0];
        out.meters.push({
          commodity: m.commodity,
          want: s.flaggedBills,
          pill: +((pill.innerText.match(/⚠\s*(\d+)/) || [])[1] || 0),
          banner: +((pane.innerText.match(/(\d+) bills? (?:have|has) a problem/) || [])[1] || 0),
          rows: pane.querySelectorAll('tr.bill-flagged').length,
          wantRows: Object.keys(s.perBill).length,
        });
      }
      // A bill change (saveUtilityData) must redraw the meter pills, and the summary cache must match a fresh run.
      const gasM = b.meters.find((m) => m.commodity === 'Gas');
      udSelectMeter(gasM.id);
      await sleep(400);
      const before = computeMeterFlagSummary(gasM, b).flaggedBills;
      const badBill = gasM.bills.find((x) => x.id === 'g10');
      badBill.totalCost = badBill.thermCost; // the cost copy equals the bill's own total
      saveUtilityData(pid);
      await sleep(600);
      const bs2 = computeBuildingFlagSummary(b, isExcl);
      const pillNums = [...document.querySelectorAll('.ma-meter-pill:not(.ma-add-meter-pill)')].map((e) =>
        +((e.innerText.match(/⚠\s*(\d+)/) || [])[1] || 0),
      );
      out.refresh = {
        before,
        after: computeMeterFlagSummary(gasM, b).flaggedBills,
        pillSum: pillNums.reduce((a, c) => a + c, 0),
        want: b.meters.reduce((a, m) => a + computeMeterFlagSummary(m, b).flaggedBills, 0),
        stale: b.meters.filter(
          (m) => JSON.stringify(computeMeterFlagSummary(m, b)) !== JSON.stringify(_computeMeterFlagSummaryFresh(m, b)),
        ).length,
      };
      // Excluded meter: its flagged bills are in its own pill, not in the building or project count.
      const fm4 = b.meters.find((m) => m.id === 'fm4');
      const proj = computeProjectFlagSummary([b], isExcl);
      const projAll = computeProjectFlagSummary([b]);
      out.excl = {
        ownFlagged: computeMeterFlagSummary(fm4, b).flaggedBills,
        building: bs2.flaggedBills,
        project: proj.flaggedBills,
        sumIncluded: b.meters.filter((m) => !isExcl(m)).reduce((a, m) => a + computeMeterFlagSummary(m, b).flaggedBills, 0),
        withExcluded: projAll.flaggedBills,
      };
      // Auto-corrected read: tinted cell with a hover, no banner, count unchanged.
      const cb = gasM.bills.find((x) => x.id === 'g5');
      cb._auto_corrected_startRead = { original: '999999', corrected: cb.startRead, reason: READ_CHAIN_REASON.a };
      const countBefore = computeMeterFlagSummary(gasM, b).flaggedBills;
      udSelectMeter(gasM.id);
      await sleep(600);
      out.corr = {
        banner: !!document.getElementById('billReadCorrectionBanner'),
        diamond: !!document.querySelector('#maPane .read-corrected-mark'),
        hoverCells: document.querySelectorAll('#maPane td[title^="Corrected. PDF reader value: 999999"]').length,
        countBefore,
        countAfter: computeMeterFlagSummary(gasM, b).flaggedBills,
      };
      await openBillCorrectionsReviewModal();
      await sleep(3000);
      const g = document.querySelector('[data-groupkey="__flagged__"]');
      out.panel = {
        want: b.meters.reduce((a, m) => a + Object.keys(computeMeterFlagSummary(m, b).perBill).length, 0),
        rows: g ? g.querySelectorAll('tbody tr').length : 0,
      };
      return out;
    }, PID);
    if (errs.length) problems.push('page errors: ' + errs.slice(0, 2).join(' | '));
    if (!res.meters.length || res.meters.every((m) => m.want === 0))
      problems.push('the fixture produced no flags, so the check proves nothing');
    res.meters.forEach((m) => {
      if (!(m.want === m.pill && m.want === m.banner && m.rows === m.want))
        problems.push(
          m.commodity +
            ' meter: shared function ' +
            m.want +
            ', pill ' +
            m.pill +
            ', banner ' +
            m.banner +
            ', flagged rows ' +
            m.rows,
        );
    });
    if (!(res.refresh.after < res.refresh.before))
      problems.push('the bill fix did not lower the flag count (' + res.refresh.before + ' -> ' + res.refresh.after + ')');
    if (res.refresh.pillSum !== res.refresh.want)
      problems.push(
        'after saveUtilityData the meter pills add up to ' + res.refresh.pillSum + ' but shared function ' + res.refresh.want,
      );
    if (res.refresh.stale) problems.push(res.refresh.stale + ' meter(s) have a cached flag summary that differs from a fresh one');
    if (res.bldg.want !== res.bldg.badge)
      problems.push('building badge ' + res.bldg.badge + ' but shared function ' + res.bldg.want);
    // the Review Bill Corrections panel is the full review list: one row per bill with ANY flag (counted or not)
    if (res.panel.want !== res.panel.rows)
      problems.push(
        'Review Bill Corrections panel has ' + res.panel.rows + ' rows but ' + res.panel.want + ' bills have a flag',
      );
    const gasRes = res.meters.find((m) => m.commodity === 'Gas');
    // bills with only a not-counted flag (a wrong gas cost copy, a printed day count): on the row, not in the count
    if (!gasRes || !(gasRes.wantRows > gasRes.want))
      problems.push('fixture: the gas meter must hold flagged bills that are not counted');
    if (!res.excl || res.excl.ownFlagged < 1) problems.push('fixture: the excluded meter has no counted flag');
    else {
      if (res.excl.building !== res.excl.sumIncluded)
        problems.push('building count ' + res.excl.building + ' includes the excluded meter (want ' + res.excl.sumIncluded + ')');
      if (res.excl.project !== res.excl.building)
        problems.push('project count ' + res.excl.project + ' differs from building ' + res.excl.building);
      if (res.excl.withExcluded <= res.excl.project) problems.push('fixture: the excluded meter does not change the count');
    }
    if (!res.corr || res.corr.banner || res.corr.diamond)
      problems.push('an auto-corrected read still draws a banner or diamond');
    else if (res.corr.hoverCells !== 1)
      problems.push('the auto-corrected read cell has no hover text (' + res.corr.hoverCells + ')');
    if (res.corr && res.corr.countBefore !== res.corr.countAfter)
      problems.push('an auto-corrected read changed the flag count');
    console.log('behavior: ' + JSON.stringify(res));
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(prof, { recursive: true, force: true });
  }
}

main()
  .catch((e) => problems.push('behavior check could not run: ' + e.message))
  .then(() => {
    if (problems.length) {
      console.log('FAIL gate-bill-flag-behavior');
      problems.forEach((p) => console.log('  ' + p));
      process.exit(1);
    }
    console.log('PASS gate-bill-flag-behavior');
  });
