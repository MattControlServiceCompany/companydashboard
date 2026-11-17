// tools/test-a36-library-photo-warning.js - the Detailed audit report warns when library front photos are missing.
// SYNTHETIC project (4 libraries), headless Firefox AND Chromium, no showDirectoryPicker (the Firefox path: saved pictures only).
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-library-photo-warning.js [chromium|firefox]   (no argument = both)
//   1. A saved set with no front photo: status says "(0 of 4 library front photos)"; generate with no pick shows ONE warning toast that
//      names the libraries (3, then "and 1 more") and says "Change folder"; the report is still made, with 0 library photos.
//   2. A folder with the front photos is picked once; later, no pick: status "(4 of 4 ...)", 4 photos, no warning toast.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const pw = require('playwright');
const { profilePath, rmTmp } = require(path.join(ROOT, 'tools', 'tmp-root.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const LIBS = ['Alpha Library', 'Beta Library', 'Gamma Library', 'Delta Library'];

async function run(browserName) {
  console.log('--- ' + browserName + ' ---');
  const dir = profilePath('lib-photo-warning-' + browserName);
  const ctx = await pw[browserName].launchPersistentContext(dir, { headless: true, viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36Preview === 'function' && typeof pictureFolderRestore === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    await page.evaluate(() => {
      ['loginScreen', 'qsOverlay'].forEach((id) => {
        const e = document.getElementById(id);
        if (e) e.remove();
      });
      document.getElementById('app').classList.add('visible');
    });
    await page.evaluate(async (libs) => {
      const PID = 900005;
      const rows = libs.map((b, i) => ({ id: 'r' + i, building: b, category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55.2 °F' } }));
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: libs });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {}, pictureMap: [{ file: 'syn-1.png', building: libs[0], equipName: 'AHU-1', page: 'graphic', cited: true }] });
      delete window.showDirectoryPicker; // the Firefox path
      window.__toasts = [];
      const orig = window.showToast;
      window.showToast = function (m) {
        window.__toasts.push(String(m));
        return orig.apply(this, arguments);
      };
      window.__png = (name) =>
        new Promise((res) => {
          const c = document.createElement('canvas');
          c.width = 80;
          c.height = 60;
          c.getContext('2d').fillRect(0, 0, 80, 60);
          c.toBlob((b) => res(new File([b], name, { type: 'image/png' })), 'image/png');
        });
      window.__openDetailed = async () => {
        _pictureFolderState = {}; // what a reload does to the module state; the saved set stays in IndexedDB
        openASHRAE36ReportModal(PID, 'audit');
        document.querySelector('input[name="a36Style"][value="detailed"]').checked = true;
        _a36StyleChanged();
        await new Promise((r) => setTimeout(r, 1500));
        return document.getElementById('a36PictureStatus').textContent;
      };
      window.__generate = async () => {
        window.__toasts = [];
        document.querySelectorAll('#reportPages .rpt-page').forEach((p) => p.remove());
        generateASHRAE36Preview();
        for (let i = 0; i < 150 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        const out = { pages: document.querySelectorAll('#reportPages .rpt-page').length, photos: Object.keys(window._currentReportData._a36LibraryPhotos || {}).length, toasts: window.__toasts.slice() };
        if (typeof closeReportOverlay === 'function') closeReportOverlay();
        return out;
      };
      window.__pick = async (names) => {
        const dt = new DataTransfer();
        for (const n of names) dt.items.add(await window.__png(n));
        const input = document.getElementById('a36PictureDir');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      };
    }, LIBS);

    // 1. saved set without front photos
    await page.evaluate(async () => {
      await window.__openDetailed();
      await window.__pick(['syn-1.png']);
      await window.__generate(); // saves syn-1.png only
    });
    const status1 = await page.evaluate(() => window.__openDetailed());
    ok(/The report uses the 1 pictures this browser saved; 0 of 4 library front photos are saved\. Click \"Change folder\" and select the picture folder to add them\./.test(status1), 'no front photos: status "' + status1 + '"');
    const r1 = await page.evaluate(() => window.__generate());
    const warns = r1.toasts.filter((t) => /^No front photo/.test(t));
    const names = await page.evaluate(() => window._currentReportData.buildings.map(_a36DisplayName));
    const want = 'No front photo for 4 libraries: ' + names.slice(0, 3).join(', ') + ' and 1 more. Click Change folder and choose the picture folder again.';
    ok(warns.length === 1 && warns[0] === want, 'no front photos: ONE warning toast "' + warns.join(' | ') + '"');
    ok(r1.pages > 0 && r1.photos === 0, 'no front photos: the report is still made (' + r1.pages + ' pages, ' + r1.photos + ' photos)');

    // 2. pick the folder with the front photos, then a later report with no pick
    await page.evaluate(async (libs) => {
      await window.__openDetailed();
      await window.__pick(['syn-1.png'].concat(libs.map((b) => b + ' - Front.png')));
      await window.__generate();
    }, LIBS);
    const status2 = await page.evaluate(() => window.__openDetailed());
    ok(/\(all 4 library front photos\)\. \"Change folder\" selects the folder again\./.test(status2), 'front photos saved: status "' + status2 + '"');
    const r2 = await page.evaluate(() => window.__generate());
    ok(r2.photos === 4 && r2.toasts.filter((t) => /^No front photo/.test(t)).length === 0, 'front photos saved: ' + r2.photos + ' photos, no warning toast (' + r2.toasts.join(' | ') + ')');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
    rmTmp(dir);
  }
}

(async () => {
  const which = process.argv[2] ? [process.argv[2]] : ['chromium', 'firefox'];
  for (const b of which) await run(b);
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
