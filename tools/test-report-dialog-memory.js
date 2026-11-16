// tools/test-report-dialog-memory.js - the Generate Audit Report / Service Proposal dialog remembers its choices (backlog f1a2858f).
// Run: CH_TMP_ROOT=<scratch> node tools/test-report-dialog-memory.js   (headless bundled Chromium, file://, synthetic data)
// Optional: SHOT=<png path> saves a 1920x1080 screenshot of the dialog.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const A = 991101;
const B = 991102;

(async () => {
  const ctx = await launchBrowser('report-dialog-memory');
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    const url = pathToFileURL(path.join(ROOT, 'energy-department.html')).href;
    await page.goto(url);
    const ready = () => page.waitForFunction(() => typeof openASHRAE36ReportModal === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    await ready();
    const stub = () =>
      page.evaluate(() => {
        window.__html = [];
        window.generateASHRAE36AuditHTML = (d, s) => { window.__html.push(['audit', s]); return '<p>x</p>'; };
        window.generateASHRAE36ProposalHTML = (d, s) => { window.__html.push(['proposal', s]); return '<p>x</p>'; };
        window.showReportOverlay = function () {};
      });
    await page.evaluate(async ([A, B]) => {
      const vav = (id, b, n) => ({ id, building: b, category: 'vav', equipName: n, location: '', controllerType: 'Sample Controller', points: { 'Zone Temp': '72 °F' } });
      const ahu = (id, b, n) => ({ id, building: b, category: 'ahu', equipName: n, location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55 °F' } });
      projects.push({ id: A, name: 'Synthetic One', client: 'Synthetic One', type: 'K-12', start: '2025-01-01' });
      projects.push({ id: B, name: 'Synthetic Two', client: 'Synthetic Two', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + A, { rows: [ahu('a1', 'Alpha', 'AHU-1'), vav('a2', 'Beta', 'VAV-1'), vav('a3', 'Gamma', 'VAV-2')], buildings: [] });
      await sset('en_eqmatrix_' + B, { rows: [ahu('b1', 'Delta', 'AHU-1')], buildings: [] });
    }, [A, B]);
    await stub();

    const state = (pid, type) =>
      page.evaluate(([pid, type]) => {
        openASHRAE36ReportModal(pid, type);
        const m = document.getElementById('ashrae36ReportModal');
        return {
          style: (m.querySelector('input[name="a36Style"]:checked') || {}).value || null,
          blds: [...m.querySelectorAll('#a36Scope input.st-cb')].filter((c) => c.checked).map((c) => c.dataset.id),
          secs: [...m.querySelectorAll('.a36SecCheck')].filter((c) => c.checked).map((c) => c.dataset.key),
          allSecs: [...m.querySelectorAll('.a36SecCheck')].map((c) => c.dataset.key),
        };
      }, [pid, type]);

    const def = await state(A, 'audit');
    ok(def.style === 'simple' && def.blds.length === 3, 'default: Simple, all 3 buildings: ' + JSON.stringify(def.blds));
    const defP = await state(A, 'proposal');

    // Choose non-default options: Detailed, drop Gamma, flip two sections.
    const flip = def.allSecs.filter((k) => k !== 'pointInventory' && k !== 'setpointReview').slice(0, 2);
    await page.evaluate(([flip, A]) => {
      openASHRAE36ReportModal(A, 'audit');
      const m = document.getElementById('ashrae36ReportModal');
      m.querySelector('input[name="a36Style"][value="detailed"]').click();
      m.querySelector('#a36Scope input.st-cb[data-id="Gamma"]').click();
      flip.forEach((k) => m.querySelector('.a36SecCheck[data-key="' + k + '"]').click());
      generateASHRAE36Preview();
    }, [flip, A]);
    await page.waitForTimeout(500);
    const want = await page.evaluate(() => window.__html[window.__html.length - 1][1]);
    ok(want.detailed === true, 'Generate ran (stubbed render) with Detailed');

    const re = await state(A, 'audit');
    ok(re.style === 'detailed', 'reopen: style Detailed');
    ok(re.blds.join() === 'Alpha,Beta', 'reopen: Alpha and Beta only: ' + re.blds);
    ok(flip.every((k) => def.secs.includes(k) !== re.secs.includes(k)), 'reopen: the two flipped sections kept');
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }); // only when asked: the gate temp folder must stay empty

    const propAfter = await state(A, 'proposal');
    ok(JSON.stringify(propAfter) === JSON.stringify(defP), 'proposal dialog of the same project is still at its defaults');

    const other = await state(B, 'audit');
    ok(other.style === 'simple' && other.blds.join() === 'Delta' && other.secs.join() === def.secs.join(), 'other project: its own defaults');

    // Reload: choices follow.
    await page.waitForTimeout(1000);
    await page.reload();
    await ready();
    const reloaded = await state(A, 'audit');
    ok(reloaded.style === 'detailed' && reloaded.blds.join() === 'Alpha,Beta' && reloaded.secs.join() === re.secs.join(), 'after page reload: same choices');

    // New building defaults checked; removed building dropped silently.
    const nb = await page.evaluate(async (A) => {
      const m = emLoadMatrix(A);
      m.rows = m.rows.filter((r) => r.building !== 'Alpha');
      m.rows.push({ id: 'n1', building: 'Zeta', category: 'vav', equipName: 'VAV-9', location: '', points: { 'Zone Temp': '70 °F' } });
      await sset('en_eqmatrix_' + A, m);
      openASHRAE36ReportModal(A, 'audit');
      return [...document.querySelectorAll('#a36Scope input.st-cb')].map((c) => c.dataset.id + (c.checked ? '+' : '-')).join();
    }, A);
    ok(nb === 'Beta+,Gamma-,Zeta+', 'new building checked, removed building dropped, Gamma stays off: ' + nb);

    // Proposal saves separately.
    await stub();
    await page.evaluate((A) => {
      openASHRAE36ReportModal(A, 'proposal');
      document.querySelector('#a36Scope input.st-cb[data-id="Beta"]').click();
      generateASHRAE36Preview();
    }, A);
    const sep = await page.evaluate((A) => {
      const d = faLoad(A).reportDialog;
      return [Object.keys(d).sort().join(), d.proposal.buildings.join(), d.audit.style];
    }, A);
    ok(sep[0] === 'audit,proposal' && sep[1] === 'Gamma,Zeta' && sep[2] === 'detailed', 'proposal saved apart from audit: ' + sep);

    // Reset to defaults.
    const rs = await page.evaluate((A) => {
      openASHRAE36ReportModal(A, 'audit');
      [...document.querySelectorAll('#ashrae36ReportModalBody a')].find((a) => a.textContent === 'Reset to defaults').click();
      const m = document.getElementById('ashrae36ReportModal');
      return {
        style: m.querySelector('input[name="a36Style"]:checked').value,
        n: [...m.querySelectorAll('#a36Scope input.st-cb')].filter((c) => c.checked).length,
        saved: !!(faLoad(A).reportDialog || {}).audit,
        propKept: !!(faLoad(A).reportDialog || {}).proposal,
      };
    }, A);
    ok(rs.style === 'simple' && rs.n === 3, 'reset: Simple and all buildings checked (' + rs.n + ')');
    ok(!rs.saved && rs.propKept, 'reset: audit memory cleared, proposal memory kept');
    ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
