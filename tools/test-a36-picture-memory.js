// tools/test-a36-picture-memory.js - the memory the Detailed ASHRAE 36 Audit Report uses for its pictures. Headless bundled Chromium, synthetic files.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-picture-memory.js
//   1. _a36DetScalePicture frees every canvas it makes (width and height 0 when it resolves) and gives the same result as before
//      (crop, bad flag) for a synthetic capture.
//   2. _a36DetPickPictures asks "was this file read and is it usable" only as far as the limit needs (the first usable file: one check).
//   3. _a36DetLoadShownPictures reads the first-ranked file of a group, then the next one only when the first is bad; it never reads the
//      remaining candidates; the result holds only the shown file.
//   4. closeReportOverlay frees the picture data (_a36Pictures, _a36LibraryPhotos) of the open report and keeps the rest of the report data.
//   5. document._currentReportHTML is no longer set when a report is shown.
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

(async () => {
  const ctx = await launchBrowser('a36-picture-memory');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36DetLoadShownPictures === 'function' && typeof _a36DetScalePicture === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- 1. canvases freed ----
    const scale = await page.evaluate(async () => {
      const made = [];
      const orig = document.createElement.bind(document);
      document.createElement = function (tag) {
        const el = orig(tag);
        if (String(tag).toLowerCase() === 'canvas') made.push(el);
        return el;
      };
      const cv = orig('canvas');
      cv.width = 1400;
      cv.height = 800;
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, 1400, 800);
      g.fillStyle = '#ddd';
      for (let yy = 20; yy < 780; yy += 14) for (let xx = 20; xx < 1300; xx += 80) g.fillRect(xx, yy, 60, 4);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      const r = await _a36DetScalePicture(new File([blob], 'x.png', { type: 'image/png' }));
      document.createElement = orig;
      return { r: r && { w: r.w, h: r.h, bad: r.bad, url: r.url.slice(0, 22), hasCanvas: 'canvas' in r }, canvases: made.length, open: made.filter((c) => c.width !== 0 || c.height !== 0).length };
    });
    ok(scale.r && scale.r.url === 'data:image/jpeg;base64' && scale.r.w > 0 && scale.r.h > 0, 'scale: a JPEG data URL comes back: ' + JSON.stringify(scale.r));
    ok(scale.canvases >= 3 && scale.open === 0, 'scale: every canvas made while reading a picture is freed when it resolves (' + scale.open + ' of ' + scale.canvases + ' still hold pixels)');
    ok(scale.r && scale.r.hasCanvas === false, 'scale: the result does not hold a canvas');

    // ---- 2. pick: the check stops at the limit ----
    const pick = await page.evaluate(() => {
      const picMap = ['a', 'b', 'c', 'd'].map((n) => ({ file: n + '.png', page: 'graphic', cited: false, building: 'L', equipName: 'E' }));
      function run(badSet) {
        const asked = [];
        const view = new Proxy({}, {
          get(t, k) {
            asked.push(k);
            return { bad: badSet[k] ? 'x' : '' };
          },
        });
        const got = _a36DetPickPictures(picMap, ['L'], ['E'], view, { limit: 1 }).map((p) => p.file);
        return { got, asked };
      }
      return { first: run({}), second: run({ 'a.png': true }) };
    });
    ok(pick.first.got.join() === 'a.png' && pick.first.asked.join() === 'a.png', 'pick: the first file is usable: one check, the others are not asked (' + pick.first.asked + ')');
    ok(pick.second.got.join() === 'b.png' && pick.second.asked.join() === 'a.png,b.png', 'pick: the first file is bad: the next one is taken, two checks (' + pick.second.asked + ')');

    // ---- 3. load only the shown pictures ----
    const load = await page.evaluate(async () => {
      const picMap = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ file: n + '.png', page: 'graphic', cited: false, building: 'L', equipName: 'E' }));
      const origModel = _a36DetModel;
      const origLoad = _a36DetLoadPictures;
      const read = [];
      _a36DetModel = function (d, rows, pm, loaded) {
        const picks = _a36DetPickPictures(pm, ['L'], ['E'], loaded, { limit: loaded ? 1 : 8 });
        return { libs: [{ descPics: [picks], findings: [] }], findings: [] };
      };
      _a36DetLoadPictures = function (files, names) {
        names.forEach((n) => read.push(n));
        const out = {};
        names.forEach((n) => {
          out[n] = { url: 'data:image/jpeg;base64,' + n, w: 10, h: 10, bad: n === 'a.png' ? 'no connection' : '' };
        });
        return Promise.resolve(out);
      };
      try {
        const needed = picMap.map((p) => p.file);
        const shown = await _a36DetLoadShownPictures([], needed, picMap, {}, {});
        return { read: read.slice(), shown: Object.keys(shown) };
      } finally {
        _a36DetModel = origModel;
        _a36DetLoadPictures = origLoad;
      }
    });
    ok(load.read.join() === 'a.png,b.png', 'load: a is read first, b only because a is bad; c, d and e are never read (read: ' + load.read + ')');
    ok(load.shown.join() === 'b.png', 'load: only the shown picture is kept (' + load.shown + ')');

    // ---- 4 and 5. close frees the picture data; no _currentReportHTML ----
    const close = await page.evaluate(() => {
      showReportOverlay('<div class="rpt-page">x</div>', 'T');
      const html = document._currentReportHTML;
      window._currentReportData = { project: { id: 1 }, _ashrae: { type: 'audit', title: 'T' }, _a36Pictures: { 'a.png': { url: 'u' } }, _a36LibraryPhotos: { L: { url: 'u' } } };
      closeReportOverlay();
      const d = window._currentReportData;
      return { html: typeof html, pics: '_a36Pictures' in d, photos: '_a36LibraryPhotos' in d, kept: !!(d._ashrae && d.project), pages: document.getElementById('reportPages').innerHTML };
    });
    ok(close.html === 'undefined', 'show: document._currentReportHTML is not set');
    ok(!close.pics && !close.photos && close.kept && close.pages === '', 'close: the pictures and photos are freed, the rest of the report data stays, the pages are empty');

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
