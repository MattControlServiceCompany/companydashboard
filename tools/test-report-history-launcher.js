/**
 * test-report-history-launcher.js
 *
 * (1) The Meetings/docs header has a "Report History" button that opens #reportHistoryModal and lists the
 *     project's saved reports. (2) History labels come from one map on entry.type: quarterly -> Quarterly,
 *     annual -> Annual, audit/proposal -> no suffix. SYNTHETIC fixtures only. Headless bundled Chromium.
 *
 * Usage: node tools/test-report-history-launcher.js   (env APP_ROOT=<checkout> to test another tree)
 */
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('report-history-launcher', {});
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const login = document.getElementById('loginScreen');
      if (login) login.remove();
      const e = (id, type, period) => ({ id, projectId: 7, projectName: 'Test Project', type, period, savedAt: '2026-01-02T10:00:00Z' });
      DB.set('en_report_history', [
        e('a', 'quarterly', 'Q1 2026'),
        e('b', 'annual', '2025'),
        e('c', 'audit', 'Test ASHRAE 36 Audit Report'),
        e('d', 'proposal', 'Test Service Proposal'),
      ]);
      projects.push({ id: 7, name: 'Test Project', meetings: [], recurringMeetings: [] });
      const body = document.createElement('div');
      document.body.appendChild(body);
      _renderDocsMeetings(body, 7);
      const btn = [...body.querySelectorAll('button')].find((b) => /Report History/.test(b.textContent));
      const out = { hasBtn: !!btn, labels: [reportHistoryLabel({ type: 'quarterly', period: 'P' }), reportHistoryLabel({ type: 'annual', period: 'P' }), reportHistoryLabel({ type: 'audit', period: 'P' }), reportHistoryLabel({ type: 'proposal', period: 'P' })] };
      out.mtg = [...document.querySelectorAll('.mtg-title')].map((x) => x.textContent.replace(/\s+/g, ' ').trim().replace(/ . [0-9:]+ [AP]M$/, ''));
      if (btn) btn.click();
      out.open = getComputedStyle(document.getElementById('reportHistoryModal')).display;
      out.rows = [...document.querySelectorAll('#reportHistoryList > div > div:first-child > div:first-child')].map((x) => x.textContent.trim());
      return out;
    });
    ok(r.hasBtn, 'Meetings/docs header has a Report History button');
    ok(r.open === 'flex', 'button opens the history modal (display=' + r.open + ')');
    ok(JSON.stringify(r.labels) === JSON.stringify(['P Quarterly', 'P Annual', 'P', 'P']), 'label map: ' + JSON.stringify(r.labels));
    ok(JSON.stringify(r.rows) === JSON.stringify(['Q1 2026 Quarterly', '2025 Annual', 'Test ASHRAE 36 Audit Report', 'Test Service Proposal']), 'rows: ' + JSON.stringify(r.rows));
    ok(r.mtg.length === 4 && r.mtg.every((t) => !/Annual/.test(t) || /^2025 Annual$/.test(t)), 'meetings list uses the same labels: ' + JSON.stringify(r.mtg));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
