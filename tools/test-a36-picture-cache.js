// tools/test-a36-picture-cache.js - the Detailed audit report opens its pictures in a bounded parallel pool and keeps each scaled
// picture (memory + IndexedDB, app/picture-folder.js pictureScaledRun), so a second report does no pixel work.
// SYNTHETIC items and pictures only. Headless Firefox AND Chromium. A local http server serves the repo files; no network, no live data.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-picture-cache.js [chromium|firefox]   (no argument = both)
//   1. Pool: the opens of 14 items overlap (more than 1 at a time, never more than PICTURE_SCALED_PARALLEL); the results keep the item order;
//      the first scale starts while other opens are still running (the opens are not one after the other).
//   2. Second run in the same page: 0 scale calls, 0 opens (memory). After the memory is cleared: still 0 scale calls and 0 opens of store
//      items (IndexedDB).
//   3. The key follows the scale tag and the variant: another tag or variant scales again; the keys of an old tag are deleted.
//   4. A folder file with no sha: the key is name, size and time; another time scales again.
//   5. A scale that returns null is not cached.
//   6. No IndexedDB: same results, no error; the memory cache still stops a second scale.
//   7. _a36DetLoadPictures end to end with real synthetic PNGs: the same objects in a second call with 0 _a36DetScalePicture calls; the
//      scale tag changes when a scaling constant changes.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const pw = require('playwright');
const { profilePath, rmTmp } = require(path.join(__dirname, 'tmp-root.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function run(browserName) {
  console.log('--- ' + browserName + ' ---');
  const srv = await startServer();
  const dir = profilePath('picture-cache-' + browserName);
  const ctx = await pw[browserName].launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|netlify\.app/, (r) => r.abort());
    await page.goto('http://127.0.0.1:' + srv.port + '/energy-department.html');
    await page.waitForFunction(() => typeof pictureScaledRun === 'function' && typeof _a36DetLoadPictures === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // 1-3, 5: store items (sha256) whose openFile is a stand-in download of 40 ms.
    const r = await page.evaluate(async () => {
      const out = {};
      const N = 14;
      const st = { cur: 0, max: 0, opens: 0, scales: 0, opensAtFirstScale: -1 };
      const mkItems = (tagPrefix) =>
        Array.from({ length: N }, (_, i) => ({
          name: 'syn-' + i + '.png',
          size: 100 + i,
          lastModified: 1000 + i,
          sha256: tagPrefix + 'sha' + i,
          openFile: () => {
            st.cur++;
            st.opens++;
            st.max = Math.max(st.max, st.cur);
            return new Promise((res) =>
              setTimeout(() => {
                st.cur--;
                const f = new File(['x' + i], 'syn-' + i + '.png');
                f.chStoreSha = tagPrefix + 'sha' + i;
                res(f);
              }, 40)
            );
          },
        }));
      const scale = (file) => {
        if (st.opensAtFirstScale < 0) st.opensAtFirstScale = st.opens;
        st.scales++;
        return new Promise((res) => setTimeout(() => res({ url: 'data:' + file.name, w: 1, h: 1 }), 5));
      };
      const same = () => '';
      const reset = () => {
        st.cur = 0; st.max = 0; st.opens = 0; st.scales = 0; st.opensAtFirstScale = -1;
      };
      let items = mkItems('a');
      let res1 = await pictureScaledRun(items, 'tst', 'tagA', same, scale);
      out.max = st.max;
      out.limit = PICTURE_SCALED_PARALLEL;
      out.order = res1.map((x) => x.url).join() === items.map((x) => 'data:' + x.name).join();
      out.opens1 = st.opens;
      out.scales1 = st.scales;
      out.opensAtFirstScale = st.opensAtFirstScale;
      // 2. same page, memory
      reset();
      let res2 = await pictureScaledRun(items, 'tst', 'tagA', same, scale);
      out.memScales = st.scales;
      out.memOpens = st.opens;
      out.memSame = JSON.stringify(res2) === JSON.stringify(res1);
      // 2b. memory cleared: IndexedDB
      await new Promise((r) => setTimeout(r, 300)); // the IndexedDB writes are not awaited by the run
      _pictureScaledMemo = {};
      reset();
      let res3 = await pictureScaledRun(items, 'tst', 'tagA', same, scale);
      out.idbScales = st.scales;
      out.idbOpens = st.opens;
      out.idbSame = JSON.stringify(res3) === JSON.stringify(res1);
      // 3. another tag
      _pictureScaledMemo = {};
      reset();
      await pictureScaledRun(items, 'tst', 'tagB', same, scale);
      out.tagScales = st.scales;
      // 3b. another variant
      reset();
      await pictureScaledRun(items, 'tst', 'tagB', () => 'v2', scale);
      out.variantScales = st.scales;
      // 3c. old tag keys deleted (the prune runs once per page: reset the flag, as a new page load does)
      await new Promise((r) => setTimeout(r, 300));
      _pictureScaledPruned = {};
      _pictureScaledMemo = {};
      await pictureScaledRun(items, 'tst', 'tagB', same, scale);
      await new Promise((r) => setTimeout(r, 300));
      const keys = await new Promise((resolve) => {
        const rq = indexedDB.open(PICTURE_FOLDER_DB);
        rq.onsuccess = () => {
          const tx = rq.result.transaction(PICTURE_STORE_CACHE, 'readonly');
          const k = tx.objectStore(PICTURE_STORE_CACHE).getAllKeys();
          tx.oncomplete = () => {
            rq.result.close();
            resolve(k.result.map(String).filter((x) => x.indexOf('scaled|tst|') === 0));
          };
        };
      });
      out.keysTagA = keys.filter((k) => k.indexOf('|tagA|') > 0).length;
      out.keysTagB = keys.filter((k) => k.indexOf('|tagB|') > 0).length;
      // 5. a null result is not cached
      _pictureScaledMemo = {};
      reset();
      const nul = (file) => {
        st.scales++;
        return Promise.resolve(null);
      };
      const items5 = mkItems('n');
      const n1 = await pictureScaledRun(items5, 'tst', 'tagN', same, nul);
      await new Promise((r) => setTimeout(r, 200));
      const before = st.scales;
      await pictureScaledRun(items5, 'tst', 'tagN', same, nul);
      out.nullResults = n1.every((x) => x === null);
      out.nullRescaled = st.scales - before === N;
      return out;
    });
    ok(r.max > 1 && r.max <= r.limit, '1. opens overlap and stay within the limit: max ' + r.max + ' at a time (limit ' + r.limit + ')');
    ok(r.order, '1. results keep the item order');
    ok(r.opens1 === 14 && r.scales1 === 14, '1. 14 opens and 14 scales: ' + r.opens1 + ' / ' + r.scales1);
    ok(r.opensAtFirstScale >= r.limit, '1. the first scale starts after ' + r.opensAtFirstScale + ' opens were started (the downloads are not one after the other)');
    ok(r.memScales === 0 && r.memOpens === 0 && r.memSame, '2. second run, same page: 0 scale calls, 0 opens, same results (' + r.memScales + ' / ' + r.memOpens + ')');
    ok(r.idbScales === 0 && r.idbOpens === 0 && r.idbSame, '2. memory cleared: 0 scale calls and 0 opens (IndexedDB), same results (' + r.idbScales + ' / ' + r.idbOpens + ')');
    ok(r.tagScales === 14, '3. another scale tag scales all 14 again: ' + r.tagScales);
    ok(r.variantScales === 14, '3. another variant scales all 14 again: ' + r.variantScales);
    ok(r.keysTagA === 0 && r.keysTagB >= 14, '3. the keys of the old tag are deleted, those of the new tag stay: tagA ' + r.keysTagA + ', tagB ' + r.keysTagB);
    ok(r.nullResults && r.nullRescaled, '5. a scale that returns null gives null and is not cached');

    // 4. folder files (no sha): name, size, time
    const r4 = await page.evaluate(async () => {
      let scales = 0;
      const scale = (file) => {
        scales++;
        return Promise.resolve({ url: 'data:' + file.name + file.lastModified, w: 1, h: 1 });
      };
      const same = () => '';
      const f1 = new File(['abc'], 'fold-1.png', { lastModified: 5000 });
      await pictureScaledRun([f1], 'tstf', 'tagF', same, scale);
      _pictureScaledMemo = {};
      await new Promise((r) => setTimeout(r, 200));
      await pictureScaledRun([f1], 'tstf', 'tagF', same, scale);
      const same2 = scales;
      const f2 = new File(['abc'], 'fold-1.png', { lastModified: 6000 });
      const res = await pictureScaledRun([f2], 'tstf', 'tagF', same, scale);
      return { same2, after: scales, url: res[0].url };
    });
    ok(r4.same2 === 1, '4. the same folder file (name, size, time) is not scaled again: ' + r4.same2 + ' scale');
    ok(r4.after === 2 && /6000$/.test(r4.url), '4. the same name with another time is scaled again: ' + r4.after + ' scales');

    // 6. no IndexedDB
    const r6 = await page.evaluate(async () => {
      const real = _pictureFolderOpenDb;
      _pictureFolderOpenDb = () => Promise.reject(new Error('IndexedDB is not available in this browser.'));
      _pictureScaledPruned = {};
      _pictureScaledMemo = {};
      let scales = 0;
      const scale = (file) => {
        scales++;
        return Promise.resolve({ url: 'data:' + file.name, w: 1, h: 1 });
      };
      const items = [1, 2, 3].map((i) => ({ name: 'noidb-' + i + '.png', size: i, lastModified: i, sha256: 'noidb' + i, openFile: () => Promise.resolve(Object.assign(new File(['z' + i], 'noidb-' + i + '.png'), { chStoreSha: 'noidb' + i })) }));
      let err = '';
      let res;
      try {
        res = await pictureScaledRun(items, 'tstn', 'tagZ', () => '', scale);
        await pictureScaledRun(items, 'tstn', 'tagZ', () => '', scale);
      } catch (e) {
        err = String(e);
      }
      _pictureFolderOpenDb = real;
      return { err, scales, urls: res && res.map((x) => x.url).join() };
    });
    ok(!r6.err && r6.urls === 'data:noidb-1.png,data:noidb-2.png,data:noidb-3.png', '6. no IndexedDB: same results, no error ' + r6.err);
    ok(r6.scales === 3, '6. no IndexedDB: the memory cache still stops the second scale: ' + r6.scales + ' scales for 2 runs of 3');

    // 7. _a36DetLoadPictures end to end with real PNGs
    const r7 = await page.evaluate(async () => {
      const mk = (name, seed) =>
        new Promise((res) => {
          const c = document.createElement('canvas');
          c.width = 160;
          c.height = 120;
          const g = c.getContext('2d');
          g.fillStyle = '#000';
          g.fillRect(0, 0, 160, 120);
          g.fillStyle = '#fff';
          g.fillRect(10 + seed * 7, 20 + seed * 3, 60, 40);
          c.toBlob((b) => res(new File([b], name, { type: 'image/png', lastModified: 7000 + seed })), 'image/png');
        });
      const files = [];
      for (let i = 0; i < 4; i++) files.push(await mk('e2e-' + i + '.png', i));
      const names = files.map((f) => f.name);
      let scales = 0;
      const realScale = _a36DetScalePicture;
      window._a36DetScalePicture = function () {
        scales++;
        return realScale.apply(this, arguments);
      };
      const a = await _a36DetLoadPictures(files, names, null);
      const first = scales;
      _pictureScaledMemo = {};
      await new Promise((r) => setTimeout(r, 400));
      const b = await _a36DetLoadPictures(files, names, null);
      window._a36DetScalePicture = realScale; // the tag hashes the real function source
      const tag1 = _a36DetScaleTag();
      const q = A36_DET_PICTURE_QUALITY;
      A36_DET_PICTURE_QUALITY = 0.5;
      const tag2 = _a36DetScaleTag();
      A36_DET_PICTURE_QUALITY = q;
      return { first, second: scales - first, same: JSON.stringify(a) === JSON.stringify(b), n: Object.keys(a).length, mod: a['e2e-1.png'] && a['e2e-1.png'].modified, url: a['e2e-0.png'] && a['e2e-0.png'].url.slice(0, 23), tagDiffers: tag1 !== tag2, tagBack: _a36DetScaleTag() === tag1, t: [tag1, tag2, _a36DetScaleTag()].join() };
    });
    ok(r7.n === 4 && r7.first === 4, '7. 4 pictures scaled once: ' + r7.n + ' results, ' + r7.first + ' scale calls');
    ok(r7.second === 0 && r7.same, '7. the second call (memory cleared) makes 0 scale calls and returns the same objects: ' + r7.second);
    ok(r7.mod === 7001 && /^data:image\/jpeg;base64,/.test(r7.url), '7. the capture time is set on the result and the picture is a JPEG data URL: ' + r7.mod + ' ' + r7.url);
    ok(r7.tagDiffers && r7.tagBack, '7. the scale tag changes with a scaling constant and returns when it is restored: ' + r7.t);

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
    srv.server.close();
    rmTmp(dir);
  }
}

(async () => {
  const which = process.argv[2];
  const list = which ? [which] : ['chromium', 'firefox'];
  for (const b of list) await run(b);
  console.log(fails ? fails + ' FAIL' : '0 FAIL');
  process.exit(fails ? 1 : 0);
})();
