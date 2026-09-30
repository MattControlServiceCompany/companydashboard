/**
 * test-ocr-hidden-tab.js
 *
 * Acceptance test: the OCR render path (_renderPageHQ, _lanczosResize in app/bill-analysis.js)
 * must not depend on the tab being visible. Synthetic PDF only. Headless Chromium, own profile.
 *
 *  1. HIDDEN vs VISIBLE timing. "Hidden" is emulated the way a hidden tab behaves in Chromium:
 *     requestAnimationFrame never fires, and setTimeout has a 1 s minimum. Message events are not
 *     throttled. Both functions must finish, and hidden time must be near visible time.
 *  2. PIXEL IDENTITY. pdf.js render with intent 'print' (no rAF) must give the same pixels as
 *     intent 'display' at scale 3.0 x 1.6 and at zoom 12 x 1.6 (the Louisburg crop zoom).
 *
 * The real functions are cut out of the app file and run in the page. pdf.js 3.11.174 (the version
 * energy-department.html loads) is cached in C:\Temp\ocr-hidden-tab-cache from cdnjs on first run.
 *
 * Usage: node tools/test-ocr-hidden-tab.js [path-to-bill-analysis.js]
 * Exit code 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PW = [
  path.join('C:', 'Users', 'Matt Miller', 'AI', 'companydashboard', 'node_modules', 'playwright-core'),
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
].find((p) => fs.existsSync(p));
const { chromium } = require(PW);

const SRC = process.argv[2] || path.join(__dirname, '..', 'app', 'bill-analysis.js');
const CACHE = path.join('C:', 'Temp', 'ocr-hidden-tab-cache');
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const CAP_MS = 20000; // a step that takes longer than this counts as stalled
const HIDDEN_EXTRA_MS = 3000; // hidden may exceed visible by at most this

let passed = 0,
  failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(url + ' -> ' + res.statusCode));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          fs.writeFileSync(dest, Buffer.concat(chunks));
          resolve();
        });
      })
      .on('error', reject);
  });
}

// Synthetic one-page PDF: a title line and stroked lines. No client data.
function makePdf(w, h, lines) {
  let ops = 'BT /F1 ' + Math.round(w / 25) + ' Tf 10 ' + (h - 40) + ' Td (Synthetic test page 123.45) Tj ET\n';
  for (let i = 0; i < lines; i++) {
    ops += `${((i * 7) % (w - 20)) + 10} ${((i * 13) % (h - 60)) + 5} m ${((i * 11) % (w - 20)) + 10} ${((i * 17) % (h - 60)) + 5} l S\n`;
  }
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  objs[4] = `<< /Length ${ops.length} >>\nstream\n${ops}endstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i <= 5; i++) {
    offs[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xr = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) pdf += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

// Cut the real OCR helpers out of the app file (same slice every time).
function appSlice() {
  const s = fs.readFileSync(SRC, 'utf8');
  const a = s.indexOf('function _lanczosKernel(');
  const b = s.indexOf('const OCR_TIMEOUT_MS');
  if (a < 0 || b < 0 || b < a) throw new Error('cannot find OCR helpers in ' + SRC);
  return s.slice(a, b);
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
    if (!fs.existsSync(path.join(CACHE, f))) await download(PDFJS + f, path.join(CACHE, f));
  }
  const profile = path.join('C:', 'Temp', 'ocr-hidden-tab-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const cacheUrl = 'file:///' + CACHE.replace(/\\/g, '/');
  fs.writeFileSync(
    path.join(profile, 'page.html'),
    `<html><body><script src="${cacheUrl}/pdf.min.js"></script><script src="${cacheUrl}/pdf.worker.min.js"></script></body></html>`,
  );
  const pageUrl = 'file:///' + profile.replace(/\\/g, '/') + '/page.html';
  const code = appSlice();
  const letterPdf = makePdf(612, 792, 1500);
  const smallPdf = makePdf(100, 130, 60);

  const ctx = await chromium.launchPersistentContext(profile, { headless: true });
  const out = {};
  try {
    for (const mode of ['visible', 'hidden']) {
      const p = await ctx.newPage();
      if (mode === 'hidden') {
        await p.addInitScript(() => {
          window.requestAnimationFrame = () => 0; // rAF never fires in a hidden tab
          const st = window.setTimeout;
          window.setTimeout = (f, ms, ...a) => st(f, Math.max(ms || 0, 1000), ...a); // 1 s timer floor
        });
      }
      await p.goto(pageUrl);
      await p.addScriptTag({ content: code });
      out[mode] = await p.evaluate(
        async ({ letterPdf, CAP_MS }) => {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          const RT = setTimeout;
          const cap = (pr) =>
            Promise.race([pr, new Promise((_, j) => RT(() => j(new Error('stalled > ' + CAP_MS + ' ms')), CAP_MS))]);
          const timed = async (fn) => {
            const t = performance.now();
            try {
              await cap(fn());
              return { ms: Math.round(performance.now() - t) };
            } catch (e) {
              return { ms: Math.round(performance.now() - t), err: e.message };
            }
          };
          const data = Uint8Array.from(atob(letterPdf), (c) => c.charCodeAt(0));
          const doc = await pdfjsLib.getDocument({
            data,
            useWorkerFetch: false,
            isEvalSupported: false,
            useSystemFonts: true,
          }).promise;
          const pg = await doc.getPage(1);
          const r = { vis: document.visibilityState };
          r.renderPageHQ = await timed(() => _renderPageHQ(pg, 0.5));
          const src = document.createElement('canvas');
          src.width = 240;
          src.height = 240;
          const sctx = src.getContext('2d');
          sctx.fillStyle = 'white';
          sctx.fillRect(0, 0, 240, 240);
          sctx.fillStyle = 'black';
          sctx.fillRect(40, 40, 100, 100);
          r.lanczosResize = await timed(() => _lanczosResize(src, 120, 120, 3));
          return r;
        },
        { letterPdf, CAP_MS },
      );
      await p.close();
    }

    // Pixel identity (visible page): display vs print intent.
    const p = await ctx.newPage();
    await p.goto(pageUrl);
    out.pixels = await p.evaluate(
      async ({ letterPdf, smallPdf }) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        const open = async (b64) => {
          const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const doc = await pdfjsLib.getDocument({
            data,
            useWorkerFetch: false,
            isEvalSupported: false,
            useSystemFonts: true,
          }).promise;
          return doc.getPage(1);
        };
        const draw = async (pg, scale, intent) => {
          const vp = pg.getViewport({ scale });
          const c = document.createElement('canvas');
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          const cx = c.getContext('2d');
          await pg.render({ canvasContext: cx, viewport: vp, intent }).promise;
          return cx.getImageData(0, 0, c.width, c.height).data;
        };
        const cmp = async (pg, scale) => {
          const a = await draw(pg, scale, 'display');
          const b = await draw(pg, scale, 'print');
          let diff = 0,
            ink = 0;
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) diff++;
            if (i % 4 === 0 && a[i] < 128) ink++;
          }
          return { bytes: a.length, diffBytes: diff, darkPixels: ink };
        };
        const res = {};
        res.scale3 = await cmp(await open(letterPdf), 3.0 * 1.6);
        res.zoom12 = await cmp(await open(smallPdf), 12 * 1.6);
        return res;
      },
      { letterPdf, smallPdf },
    );
    await p.close();
  } finally {
    await ctx.close();
  }

  console.log(JSON.stringify(out, null, 1));
  for (const fn of ['renderPageHQ', 'lanczosResize']) {
    for (const mode of ['visible', 'hidden']) check(fn + ' finishes (' + mode + ')', !out[mode][fn].err, out[mode][fn]);
    check(
      fn + ' hidden time close to visible',
      !out.hidden[fn].err && out.hidden[fn].ms <= out.visible[fn].ms + HIDDEN_EXTRA_MS,
      {
        visible: out.visible[fn].ms,
        hidden: out.hidden[fn].ms,
      },
    );
  }
  for (const k of ['scale3', 'zoom12']) {
    check('pixels identical display vs print (' + k + ')', out.pixels[k].diffBytes === 0, out.pixels[k]);
    check('canvas has drawn content (' + k + ')', out.pixels[k].darkPixels > 0, out.pixels[k]);
  }
  console.log('\nPassed: ' + passed + '  Failed: ' + failed);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
