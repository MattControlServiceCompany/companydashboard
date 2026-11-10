// tools/test-ud-missing-zip.js - Utility Data warns when a building has no ZIP (weather cannot load). SYNTHETIC data only.
// One rule: _weatherZipFor(projId, bldgId) === '' (no building ZIP and no project ZIP).
//   Project P1 has a ZIP: building A has its own ZIP, building B has none -> no warning anywhere, no count line.
//   Project P2 has no ZIP: building C has none -> header warning + count 1; building D has a ZIP -> no header warning.
// Run: CH_TMP_ROOT=<scratch> node tools/test-ud-missing-zip.js   (CH_ZIP_SHOTS=<dir> also saves screenshots: dark/light x 1920/960)
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.CH_ZIP_SHOTS || '';
const { fastNet } = require(path.join(ROOT, 'tools', 'pdf-test-net.js'));
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const WARN = 'No ZIP code: weather cannot load';
let failed = 0;
const assert = (c, m) => {
  if (!c) {
    failed++;
    console.log('  FAIL: ' + m);
  } else console.log('  ok: ' + m);
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/energy-department.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.normalize(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    r.writeHead(404);
    return r.end();
  }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const ctx = await launchBrowser('ud-missing-zip');
  try {
    await fastNet(ctx);
    const page = await ctx.newPage();
    await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
    await ctx.addInitScript(() => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      const proj = (id, name, cid, zip, ids) => ({ id, name, client: 'S', customerId: cid, addr: '', zip, type: 'Test', status: 'active', phase: '', contacts: [], scope: { buildingIds: ids, meterExcludeIds: [] }, savingsData: { measures: [] } });
      localStorage.setItem('en_projects', JSON.stringify([proj(999000001, 'Synthetic Project One', 'cz1', '66000', ['za', 'zb']), proj(999000002, 'Synthetic Project Two', 'cz2', '', ['zc', 'zd'])]));
      localStorage.setItem('en_customers', JSON.stringify([{ id: 'cz1', name: 'Synth One' }, { id: 'cz2', name: 'Synth Two' }]));
      const mtr = (id) => ({ id, commodity: 'Electric', provider: 'SynElectric', account: 'E-' + id, bills: [{ id: id + 'b', start: '2025-01-01', end: '2025-01-28', kwh: 10000, kw: 40, totalCost: 1000 }] });
      localStorage.setItem('en_utility_cz1', JSON.stringify({ buildings: [
        { id: 'za', name: 'Synth Hall', addr: '1 Test St', zip: '66001', sqft: 20000, meters: [mtr('ma')] },
        { id: 'zb', name: 'Synth Annex', addr: '2 Test St', sqft: 15000, meters: [mtr('mb')] } ] }));
      localStorage.setItem('en_utility_cz2', JSON.stringify({ buildings: [
        { id: 'zc', name: 'Synth Gym', addr: '3 Test St', sqft: 12000, meters: [mtr('mc')] },
        { id: 'zd', name: 'Synth Shop', addr: '4 Test St', zip: '66002', sqft: 9000, meters: [mtr('md')] } ] }));
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false, rnShowMode: 'never' }));
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    });
    await page.goto(base + 'energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof udSelectProj === 'function' && window.CH_AUTH, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => sv('utility', document.querySelector('.s-item[onclick*="utility"]')));
    await page.waitForTimeout(500);
    const state = async (pid, bid) => {
      await page.evaluate(([p, b]) => { udSelectProj(p); if (b) udSelectBldg(b); }, [pid, bid]);
      await page.waitForTimeout(400);
      return page.evaluate(() => ({
        nav: document.getElementById('udNavList').innerText,
        hdr: (document.getElementById('udDetailHdrSub') || {}).innerText || '',
        hdrColor: (() => {
          const s = [...document.querySelectorAll('#udDetailHdrSub span')].find((e) => /No ZIP/.test(e.textContent));
          return s ? getComputedStyle(s).color : '';
        })(),
      }));
    };
    const shot = async (name, theme, w) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: w, height: 800 });
      await page.evaluate((t) => {
        if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, '2026-11-10-' + name + '-' + theme + '-' + w + '.png') });
    };

    let s = await state(999000001, 'za');
    assert(!s.hdr.includes(WARN), 'building with own ZIP: no header warning');
    assert(!/no ZIP code/.test(s.nav), 'project with ZIP: no count line');
    s = await state(999000001, 'zb');
    assert(!s.hdr.includes(WARN), 'no building ZIP but project ZIP: no header warning');
    assert(!/no ZIP code/.test(s.nav), 'project with ZIP: still no count line');
    s = await state(999000002, 'zd');
    assert(!s.hdr.includes(WARN), 'building with own ZIP in no-ZIP project: no header warning');
    assert(/1 building has no ZIP code: weather cannot load/.test(s.nav), 'project two count line shown: ' + JSON.stringify(s.nav));
    s = await state(999000002, 'zc');
    assert(s.hdr.includes(WARN), 'building with neither: header warning shown');
    assert(/1 building has no ZIP code/.test(s.nav), 'project two count = 1');
    assert(!!s.hdrColor, 'header warning computed colour: ' + s.hdrColor);
    for (const theme of ['dark', 'light']) for (const w of [1920, 960]) await shot('missing-zip', theme, w);
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(failed ? 'FAILED ' + failed : 'PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('ERROR ' + e.stack);
  process.exit(1);
});
