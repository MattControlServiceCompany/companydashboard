// tools/test-a36-picture-store.js - the Detailed audit report reads its pictures from the site picture store (app/picture-folder.js:
// pictureStore*), so the user never picks a folder again, and pictures added later reach the report.
// SYNTHETIC project (4 libraries, synthetic file names). Headless Firefox AND Chromium. The page is served by a LOCAL http server that also
// plays pdf-sync (GET ?key=, PUT {key, base64, sha256}, same shapes as netlify/functions/pdf-sync.js). No live database, no network.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-picture-store.js [chromium|firefox]   (no argument = both)
//   0. Outside the backend (the real pictureStoreAvailable) the store is off.
//   a. Index + blobs in the store, no folder, no saved set: the report has the graphic and 3 of 4 front photos; ONE warning toast names the
//      library with no photo; the status line says what is missing and that it uploads on a folder pick or by the automatic sync.
//   b. The 4th front photo is added to the store (index changed) after that first report: the next report has all 4 photos, no toast,
//      the status line says "<N> pictures from the site store (all 4 library front photos)." No folder pick, no saved set.
//   d. Cache: the next report downloads only what is new (b: 1 file), and a third report downloads nothing (0 pdf-sync GET).
//   c. A folder is picked (the Firefox input path): the files the index lacks upload (PUT) and the index gets their entries; a file with
//      the same content is not sent again; a non-picture file is ignored; the status line shows progress; Generate does not wait.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const pw = require('playwright');
const { profilePath, rmTmp } = require(path.join(__dirname, 'tmp-root.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const LIBS = ['Alpha Library', 'Beta Library', 'Gamma Library', 'Delta Library'];
const PID = 900007;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

// A local server: the repo files and a pdf-sync stand-in that keeps the blobs in memory.
function startServer() {
  const blobs = new Map();
  const stats = { get: 0, put: 0, putNoop: 0, getKeys: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/.netlify/functions/pdf-sync') {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET') {
        stats.get++;
        const key = u.searchParams.get('key');
        stats.getKeys.push(key);
        const buf = blobs.get(key);
        if (!buf) return send(404, { found: false });
        return send(200, { found: true, key, chunked: false, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), base64: buf.toString('base64') });
      }
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const b = JSON.parse(body);
          const buf = Buffer.from(b.base64, 'base64');
          if (crypto.createHash('sha256').update(buf).digest('hex') !== b.sha256) return send(400, { error: 'sha256 mismatch' });
          stats.put++;
          if (blobs.has(b.key)) {
            stats.putNoop++;
            return send(200, { ok: true, key: b.key, noop: true });
          }
          setTimeout(() => {
            blobs.set(b.key, buf);
            send(200, { ok: true, key: b.key, sha256: b.sha256, size: buf.length, noop: false });
          }, 120);
        });
        return;
      }
      return send(405, {});
    }
    if (u.pathname.indexOf('/.netlify/') === 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"no backend in this test"}');
    }
    const file = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, blobs, stats, port: server.address().port })));
}

async function run(browserName) {
  console.log('--- ' + browserName + ' ---');
  const srv = await startServer();
  const dir = profilePath('picture-store-' + browserName);
  const ctx = await pw[browserName].launchPersistentContext(dir, { headless: true, viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|netlify\.app/, (r) => r.abort());
    await page.goto('http://127.0.0.1:' + srv.port + '/energy-department.html');
    await page.waitForFunction(() => typeof generateASHRAE36Preview === 'function' && typeof pictureFolderRestore === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    await page.evaluate(() => {
      ['loginScreen', 'qsOverlay'].forEach((id) => {
        const e = document.getElementById(id);
        if (e) e.remove();
      });
      document.getElementById('app').classList.add('visible');
    });
    await page.evaluate(
      async ({ libs, PID }) => {
        const rows = libs.map((b, i) => ({ id: 'r' + i, building: b, category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55.2 °F' } }));
        projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
        await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: libs });
        await sset('en_audit_' + PID, {
          findings: [],
          edits: {},
          evidence: {},
          pictureMap: [
            { file: 'syn-1.png', building: libs[0], equipName: 'AHU-1', page: 'graphic', cited: true },
            { file: 'syn-2.png', building: libs[0], equipName: 'AHU-1', page: 'graphic', cited: false },
          ],
        });
        delete window.showDirectoryPicker; // the Firefox path
        window.__toasts = [];
        const orig = window.showToast;
        window.showToast = function (m) {
          window.__toasts.push(String(m));
          return orig.apply(this, arguments);
        };
        // A synthetic picture: same name = same bytes.
        window.__mk = (name) =>
          new Promise((res) => {
            let seed = 0;
            for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
            const c = document.createElement('canvas');
            c.width = 80;
            c.height = 60;
            const g = c.getContext('2d');
            g.fillStyle = '#000';
            g.fillRect(0, 0, 80, 60);
            g.fillStyle = '#fff';
            g.fillRect(seed % 60, (seed * 7) % 40, 12, 9);
            c.toBlob(async (b) => {
              const bytes = new Uint8Array(await b.arrayBuffer());
              res({ bytes, file: new File([bytes], name, { type: 'image/png' }) });
            }, 'image/png');
          });
        window.__b64 = async (name) => {
          const { bytes } = await window.__mk(name);
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          return btoa(s);
        };
        window.__setIndex = async (files) => {
          await sset('en_auditpics_' + PID, { files: files, updated: new Date().toISOString() });
        };
        window.__openDetailed = async () => {
          _pictureFolderState = {}; // what a reload does to the module state
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
          for (let i = 0; i < 200 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 300));
          const d = window._currentReportData || {};
          const out = { pages: document.querySelectorAll('#reportPages .rpt-page').length, photos: Object.keys(d._a36LibraryPhotos || {}).length, graphics: Object.keys(d._a36Pictures || {}), toasts: window.__toasts.slice() };
          if (typeof closeReportOverlay === 'function') closeReportOverlay();
          return out;
        };
      },
      { libs: LIBS, PID }
    );

    // Put a picture into the store the way the upload does: blob in the server, entry in the index.
    let mtime = 1700000000000;
    async function seed(names) {
      const entries = {};
      for (const n of names) {
        const b64 = await page.evaluate((n) => window.__b64(n), n);
        const buf = Buffer.from(b64, 'base64');
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        const key = 'pictures/' + PID + '/' + sha;
        srv.blobs.set(key, buf);
        entries[n] = { key, sha256: sha, size: buf.length, mtime: (mtime += 1000) };
      }
      await page.evaluate(
        async ({ entries, PID }) => {
          const cur = (sget('en_auditpics_' + PID, null) || { files: {} }).files;
          await window.__setIndex(Object.assign({}, cur, entries));
        },
        { entries, PID }
      );
    }
    const frontOf = (i) => LIBS[i] + ' - Front.png';

    const cls = await page.evaluate((PID) => SyncClassification.classifyKey('en_auditpics_' + PID), PID);
    ok(cls === 'synced', '0. the index key en_auditpics_<pid> is a synced key: ' + cls);
    // 0. outside the backend the store is off
    const off = await page.evaluate(() => (typeof pictureStoreAvailable === 'function' ? pictureStoreAvailable() : 'missing'));
    ok(off === false || off === 'missing', '0. outside the backend (no sign-in) the store is off: ' + off);
    await page.evaluate(() => {
      window.pictureStoreAvailable = () => true; // stand-in for "backend on" (the real test is CH_AUTH.backendMode() === 'on')
    });

    // a. index + blobs, no folder, no saved set; 3 of 4 front photos
    await seed(['syn-1.png', 'syn-2.png', frontOf(0), frontOf(1), frontOf(2)]);
    const statusA = await page.evaluate(() => window.__openDetailed());
    ok(/in the site store/.test(statusA) && /1 missing: they upload when you pick the picture folder or by the automatic sync\./.test(statusA), 'a. status names what is missing and the upload paths: "' + statusA + '"');
    const rA = await page.evaluate(() => window.__generate());
    ok(rA.pages > 0 && rA.graphics.length > 0, 'a. no folder, no saved set: the report has the graphic from the store (' + rA.graphics + ', ' + rA.pages + ' pages)');
    ok(rA.photos === 3, 'a. 3 library front photos from the store (' + rA.photos + ')');
    const warnsA = rA.toasts.filter((t) => /^No front photo/.test(t));
    ok(warnsA.length === 1 && /No front photo for 1 library: /.test(warnsA[0]), 'a. ONE warning toast for the library with no photo: "' + warnsA.join(' | ') + '"');
    const getsAfterA = srv.stats.get;
    ok(getsAfterA > 0, 'a. the pictures were downloaded from the store (' + getsAfterA + ' GET)');

    // b. a new file is added to the store; the next report has it, no pick
    await seed([frontOf(3)]);
    const statusB = await page.evaluate(() => window.__openDetailed());
    if (process.env.CH_SHOT) await page.screenshot({ path: process.env.CH_SHOT + '-' + browserName + '.png' }); // optional picture of the dialog
    ok(/^2 pictures from the site store \(all 4 library front photos\)\.$/.test(statusB), 'b. status "' + statusB + '"');
    const rB = await page.evaluate(() => window.__generate());
    ok(rB.photos === 4 && rB.toasts.filter((t) => /^No front photo/.test(t)).length === 0, 'b. the new front photo is in the next report: ' + rB.photos + ' photos, no warning toast (' + rB.toasts.join(' | ') + ')');
    ok(rB.graphics.join() === rA.graphics.join(), 'b. the same graphics as the first report (' + rB.graphics + ')');

    // d. cache: only the new file was downloaded; a third report downloads nothing
    ok(srv.stats.get - getsAfterA === 1, 'd. the second report downloaded only the 1 new file (' + (srv.stats.get - getsAfterA) + ' GET)');
    const getsBeforeC3 = srv.stats.get;
    const rC3 = await page.evaluate(() => window.__generate());
    ok(srv.stats.get === getsBeforeC3 && rC3.photos === 4, 'd. a third report downloads nothing (cache): ' + (srv.stats.get - getsBeforeC3) + ' GET, ' + rC3.photos + ' photos');

    // c. a folder is picked: the files the index lacks upload
    await page.evaluate(async () => {
      const keep = (sget('en_auditpics_900007', null) || { files: {} }).files['syn-1.png'];
      await window.__setIndex({ 'syn-1.png': keep });
    });
    const putsBefore = srv.stats.put;
    const names = ['syn-1.png', 'syn-2.png', 'syn-3.png'].concat(LIBS.map((_, i) => frontOf(i)));
    const status0 = await page.evaluate(
      async (names) => {
        await window.__openDetailed();
        const dt = new DataTransfer();
        for (const n of names) dt.items.add((await window.__mk(n)).file);
        dt.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
        const input = document.getElementById('a36PictureDir');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        return document.getElementById('a36PictureStatus').textContent;
      },
      names
    );
    ok(/Uploading to the site store: 0 of 7\./.test(status0), 'c. the status line shows the upload progress at once: "' + status0 + '"');
    const gen = page.evaluate(() => window.__generate()); // Generate does not wait for the upload
    await page.waitForFunction(() => !_pictureStoreUploads['900007'].running, null, { timeout: 30000 });
    await gen;
    const idxC = await page.evaluate(() => Object.keys((sget('en_auditpics_900007', null) || { files: {} }).files).sort());
    ok(srv.stats.put - putsBefore === 6, 'c. 6 files were sent (syn-2, syn-3, 4 front photos; syn-1 has the same content): ' + (srv.stats.put - putsBefore) + ' PUT');
    ok(idxC.length === 7 && idxC.indexOf('notes.txt') < 0, 'c. the index holds the 7 pictures and not notes.txt: ' + idxC.length);
    const putsAfter = srv.stats.put;
    await page.evaluate(async (names) => {
      const dt = new DataTransfer();
      for (const n of names) dt.items.add((await window.__mk(n)).file);
      const input = document.getElementById('a36PictureDir');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    }, names);
    await page.waitForFunction(() => !_pictureStoreUploads['900007'].running, null, { timeout: 30000 });
    ok(srv.stats.put === putsAfter, 'c. the same folder picked again sends nothing: ' + (srv.stats.put - putsAfter) + ' PUT');
    const statusC = await page.evaluate(() => document.getElementById('a36PictureStatus').textContent);
    ok(/found in the folder/.test(statusC), 'c. after the pick the status line shows the folder count: "' + statusC + '"');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
    srv.server.close();
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
