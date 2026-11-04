/**
 * test-meeting-preview-blob.js
 *
 * The meeting agenda/minutes editor "PDF PREVIEW" frame must load a blob: URL, never a data: URI
 * (the page CSP frame-src allows 'self' blob: only). Opens the real editor on a SYNTHETIC meeting
 * (agenda, then minutes), asserts: frame src is blob:, no CSP violation in the console, the blob is a
 * valid PDF (%PDF header, page count via pdf.js), editing a field re-renders to a NEW blob and revokes the old
 * one, closing the editor revokes the last one. Source check: no 'datauristring' in the preview code.
 * Headless bundled Chromium (never Edge). Network to supabase/netlify is blocked.
 * Env: CH_PDFJS_CACHE (folder with pdf.min.js + pdf.worker.min.js), APP_ROOT, SHOT_DIR (optional screenshots).
 *
 * Usage: node tools/test-meeting-preview-blob.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const CACHE = process.env.CH_PDFJS_CACHE;

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'csv-import.js'), 'utf8');
  const fn = src.slice(src.indexOf('function mtgRenderPreview'), src.indexOf('function closeMeetingModal'));
  ok(fn.length > 100 && !/datauristring|data:application/.test(fn), 'source: mtgRenderPreview does not build a data: URI');
  ok(/createObjectURL/.test(fn) && /revokeObjectURL/.test(fn), 'source: mtgRenderPreview uses createObjectURL and revokeObjectURL');

  const ctx = await launchBrowser('meeting-preview-blob');
  try {
    const page = await ctx.newPage();
    const viol = [];
    page.on('console', (m) => {
      if (/Content Security Policy|violates|frame-src/i.test(m.text())) viol.push(m.text());
    });
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    if (CACHE) {
      await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\//, (r) => {
        const f = path.join(CACHE, r.request().url().split('/').pop());
        r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) });
      });
    }
    await page.addInitScript(() => {
      window.__revoked = [];
      const rev = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (u) => {
        window.__revoked.push(u);
        rev(u);
      };
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const login = document.getElementById('loginScreen');
      if (login) login.remove();
      document.getElementById('app').classList.add('visible');
      projects.push({
        id: 9002, client: 'Test District', name: 'Test District', contacts: [],
        meetings: [{
          id: 78, type: 'agenda', date: '2026-03-03T10:00', projectNickname: 'Test District',
          sectionHeading: 'Energy Management Services Program',
          contactTables: [{ label: 'Test Key Contacts', contacts: [{ name: 'Pat Example', phone: '555-0101', email: 'pat@example.test' }] }],
          topics: [{ text: 'Review test bills', subItems: ['First sub item'] }], history: [],
        }],
        recurringMeetings: [],
      });
      openMeetingEditor(9002, 78);
    });

    async function frameInfo() {
      return page.evaluate(async () => {
        const src = document.getElementById('mtgPreviewFrame').getAttribute('src') || '';
        const out = { src: src.slice(0, 5), url: src };
        if (src.startsWith('blob:')) {
          const buf = await (await fetch(src)).arrayBuffer();
          out.head = new TextDecoder('latin1').decode(buf.slice(0, 5));
          if (window.pdfjsLib) {
            try {
              window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
              out.pages = (await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise).numPages;
            } catch (e) {
              out.pdfjsErr = String(e);
            }
          }
        }
        return out;
      });
    }

    for (const mode of ['agenda', 'minutes']) {
      if (mode === 'minutes') {
        await page.evaluate(() => {
          _editingMeeting.type = 'minutes';
          renderMeetingEditorBody();
        });
      }
      await page.waitForTimeout(1200);
      const a = await frameInfo();
      ok(a.src === 'blob:', mode + ': preview frame src is blob: (' + a.src + ')');
      ok(a.head === '%PDF-', mode + ': blob is a PDF (' + a.head + ')');
      ok(a.pages >= 1, mode + ': pdf.js page count ' + a.pages + (a.pdfjsErr ? ' ' + a.pdfjsErr : ''));
      const before = await page.evaluate(() => window.__revoked.length);
      await page.fill('#mtg-heading', 'Edited heading ' + mode);
      await page.waitForTimeout(1200);
      const b = await frameInfo();
      const rev = await page.evaluate(() => window.__revoked.slice());
      ok(b.src === 'blob:' && b.url !== a.url, mode + ': editing a field re-renders to a new blob');
      ok(rev.length > before && rev.includes(a.url), mode + ': the old blob URL was revoked');
      ok(b.head === '%PDF-', mode + ': re-rendered blob is a PDF');
      if (process.env.SHOT_DIR) {
        for (const w of [1600, 960]) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(process.env.SHOT_DIR, '2026-11-03-meeting-preview-' + mode + '-' + w + '.png') });
        }
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
    }
    const last = (await frameInfo()).url;
    await page.evaluate(() => closeMeetingModal());
    ok((await page.evaluate(() => window.__revoked)).includes(last), 'close: the last blob URL was revoked');
    // Date line: month, day, superscript suffix and the rest sit with no extra gap (st, nd, rd, th, two-digit day).
    await page.evaluate(() => closeMeetingModal());
    for (const [iso, want] of [
      ['2026-03-01T10:00', 'Meeting Date: Sunday March 1st, 2026 10 AM'],
      ['2026-03-22T10:00', 'Meeting Date: Sunday March 22nd, 2026 10 AM'],
      ['2026-03-03T10:00', 'Meeting Date: Tuesday March 3rd, 2026 10 AM'],
      ['2026-03-11T10:00', 'Meeting Date: Wednesday March 11th, 2026 10 AM'],
      ['2026-03-30T10:00', 'Meeting Date: Monday March 30th, 2026 10 AM'],
    ]) {
      const r = await page.evaluate(async (iso) => {
        const m = { id: 1, type: 'agenda', date: iso, projectNickname: 'Test District', sectionHeading: 'Energy Management Services Program', contactTables: [], topics: [], history: [] };
        const buf = buildMeetingPDF(m, true).output('arraybuffer');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        const pg = await pdf.getPage(1);
        const items = (await pg.getTextContent()).items.filter((i) => i.str);
        const k = items.findIndex((i) => /^Meeting Date:/.test(i.str));
        const e = items.findIndex((i, n) => n >= k && /AM|PM/.test(i.str));
        const row = items.slice(k, e + 1).map((i) => ({ str: i.str, x: i.transform[4], w: i.width }));
        const vp = pg.getViewport({ scale: 1.5 });
        const cv = document.createElement('canvas');
        cv.width = vp.width;
        cv.height = vp.height;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        return { row, png: cv.toDataURL('image/png') };
      }, iso);
      const txt = r.row.map((i) => i.str).join('');
      ok(txt === want, 'date line text "' + txt + '"');
      const gaps = r.row.slice(1).map((it, i) => it.x - (r.row[i].x + r.row[i].w));
      ok(r.row.every((i) => i.str.trim() || i.w > 2.5) && r.row.length <= 4, 'date line: the space before the day is a full space (no squeezed gap)');
      ok(gaps.every((g) => Math.abs(g) < 0.6), 'date line parts abut, gaps pt: ' + gaps.map((g) => g.toFixed(2)).join(', '));
      if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, '2026-11-03-meeting-date-' + want.match(/\d+\w\w/)[0] + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));
    }
    ok(viol.length === 0, 'no CSP violation in the console' + (viol.length ? ': ' + viol[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
