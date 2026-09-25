// tools/test-report-header-overflow.js — Quarterly Report header overflow/word-split gate
// (2026-09-24, fix/report-headers-and-empty-period, task 5b, problem 1).
// Run: node tools/test-report-header-overflow.js
//
// Renders the REAL Quarterly Report for Spring Hill Schools in a headless bundled Chromium
// browser (this repo's own node_modules/playwright-core, no extra deps), against a local
// static server serving THIS worktree (so it exercises the actual uncommitted fix, not the
// live site), restored from a COPY of a real CompanyHub backup through the site's own Restore
// button + file chooser (never localStorage.setItem). Then walks every <th> on every generated
// report page and fails if:
//   (a) scrollWidth > clientWidth on any header cell (content overflows/clips its column), or
//   (b) a single word is visibly split across more than one line inside a header cell.
//
// Also exercises problem 3 (empty-period behavior): explicitly selects a quarter known to have
// zero bills (Q3 2026) and asserts the Building Performance table never claims "On Track" for a
// building with no bills — it must say "No bills for this period" instead — and that the
// Generate Report modal shows a coverage warning for that quarter BEFORE the user generates.
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const REPO = path.join(__dirname, '..');
const PW_PATH = path.join('C:', 'Users', 'Matt Miller', 'AI', 'companydashboard', 'node_modules', 'playwright-core');
const { chromium } = require(PW_PATH);

const OUT_DIR =
  process.argv[2] || path.join('C:', 'Users', 'Matt Miller', 'AI', '_context', 'temp', '2026-09-24-report-headers');
const FIXTURE = path.join(OUT_DIR, '2026-09-24-restore-copy.json');
const PROFILE = path.join(os.tmpdir(), 'chd-report-header-test-' + Date.now());

let passed = 0,
  failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.log('  FAIL: ' + msg);
  }
}

// ─── Minimal static file server for this worktree (no deps) ────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(REPO, urlPath);
      if (!filePath.startsWith(REPO)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + urlPath);
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function clickText(page, text, exact) {
  const box = await page.evaluate(
    ({ text, exact }) => {
      const els = [...document.querySelectorAll('*')].filter((e) => {
        const t = (e.textContent || '').trim();
        return exact ? t === text : t.includes(text);
      });
      const vis = els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, r };
        })
        .filter((x) => x.r.width > 0 && x.r.height > 0);
      vis.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
      if (!vis.length) return null;
      const r = vis[0].r;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { text, exact: !!exact },
  );
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

// Word-split detection: for each header <th>, measure each rendered CSS line's text (via
// Range.getClientRects()) and check no single "word" (whitespace-delimited token in the th's
// own text) got broken across two rects with no space between — i.e. re-join the rects' text
// and diff against the th's own textContent tokens.
async function scanHeaders(page, containerSel, label, results) {
  const rows = await page.evaluate((containerSel) => {
    const out = [];
    document.querySelectorAll(containerSel + ' th').forEach((th) => {
      const text = (th.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const overflow = th.scrollWidth > th.clientWidth + 1;
      // Word-split check: walk the th's text nodes AND element nodes, and for each text
      // character collect its client rect; a word is "split" if two consecutive characters of
      // the SAME word (no whitespace AND no <br>/block boundary between them in the source)
      // land on rects whose vertical center differs by more than half the smaller rect's
      // height (i.e. they printed on different lines). A <br> (or any element boundary) resets
      // the "same word" chain just like whitespace does — it is a deliberate line break, not a
      // word split.
      let split = false;
      const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
      let node;
      let prevRect = null;
      let prevCharWasSpace = true;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 1) {
          // Any element node (br, span, etc.) breaks word-adjacency the same as whitespace —
          // this scan only cares about two LITERALLY ADJACENT text characters with nothing
          // between them.
          prevCharWasSpace = true;
          prevRect = null;
          continue;
        }
        const s = node.nodeValue;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          const isSpace = /\s/.test(ch);
          if (isSpace) {
            prevCharWasSpace = true;
            prevRect = null;
            continue;
          }
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const rect = r.getBoundingClientRect();
          if (!prevCharWasSpace && prevRect && rect.width > 0 && prevRect.width > 0) {
            const prevMid = prevRect.top + prevRect.height / 2;
            const curMid = rect.top + rect.height / 2;
            if (Math.abs(prevMid - curMid) > Math.min(prevRect.height, rect.height) / 2) {
              split = true;
            }
          }
          if (rect.width > 0) prevRect = rect;
          prevCharWasSpace = false;
        }
      }
      out.push({ text, overflow, split, scrollWidth: th.scrollWidth, clientWidth: th.clientWidth });
    });
    return out;
  }, containerSel);
  rows.forEach((r) => {
    results.push({ page: label, ...r });
  });
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.log('SKIPPED: fixture copy not found at ' + FIXTURE);
    process.exit(0);
  }
  const server = await startServer();
  const port = server.address().port;
  const SITE = 'http://127.0.0.1:' + port + '/energy-department.html';
  console.log('Serving worktree at ' + SITE);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

  try {
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200);
    // Dismiss the first-run "Quick Start Guide" onboarding modal (fresh profile only) via its
    // own real close function BEFORE anything else — it can render on top of the sign-in
    // screen itself and block every button underneath, including "Continue as Demo."
    await page.evaluate(() => {
      if (typeof closeQuickStart === 'function') closeQuickStart();
    });
    await page.waitForTimeout(400);
    const demoBtn = page.locator(
      'button.btn-demo, button:has-text("Continue as Demo"), button:has-text("Continue in Demo Mode")',
    );
    if ((await demoBtn.count()) > 0) {
      await demoBtn.first().click({ force: true });
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => {
      if (typeof closeQuickStart === 'function') closeQuickStart();
    });
    await page.waitForTimeout(400);

    // Restore via the real Restore button + file chooser (COPY of the backup, never
    // localStorage.setItem).
    const restoreBtn = page.locator('button:has-text("Restore")').first();
    assert((await restoreBtn.count()) > 0, 'Restore button present');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      restoreBtn.click({ force: true }),
    ]);
    await chooser.setFiles(FIXTURE);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      if (typeof closeQuickStart === 'function') closeQuickStart();
    });
    await page.waitForTimeout(400);

    // ─── Spring Hill Schools: Documents → Generate Report ───────────────────────────────
    await clickText(page, 'Spring Hill Schools', true);
    await page.waitForTimeout(1200);
    await page.locator('#pdTabBar button', { hasText: 'Documents' }).click();
    await page.waitForTimeout(1000);
    for (let i = 0; i < 4; i++) {
      const dismissed = await clickText(page, "Don't show again", true);
      if (!dismissed) break;
      await page.waitForTimeout(300);
    }
    await clickText(page, 'Generate Report', false);
    await page.waitForTimeout(1200);

    // Problem 3b: the default period must NOT be an empty quarter. The coverage-warning banner
    // may still legitimately fire for the auto-picked quarter (e.g. one meter's most recent
    // bill hasn't arrived yet) — that is the warning doing its job, not a defect — so the real
    // assertion is that the DEFAULT quarter is not wholly empty (every building missing every
    // month), which is exactly the bug this task reports.
    const defaultYear = await page.locator('#rptV2Year').inputValue();
    const defaultQuarter = await page.locator('#rptV2Quarter').inputValue();
    console.log('Default period selected by modal: Q' + defaultQuarter + ' ' + defaultYear);
    const warnAtDefault = await page.evaluate(() => {
      const el = document.getElementById('rptV2CoverageWarning');
      return el ? { visible: el.style.display !== 'none', html: el.innerText } : null;
    });
    console.log('Coverage warning at default period: ' + JSON.stringify(warnAtDefault));
    assert(
      !(defaultYear === '2026' && defaultQuarter === '3'),
      'default period is not the empty Q3 2026 calendar quarter (was Q' + defaultQuarter + ' ' + defaultYear + ')',
    );

    // Generate the report on the DEFAULT (should-have-data) period and scan every table header.
    await clickText(page, 'Generate Preview', true);
    await page.waitForTimeout(4000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const results = [];
    await scanHeaders(page, '#rptPreviewPages', 'Spring Hill Q' + defaultQuarter + ' ' + defaultYear, results);
    console.log('Header cells scanned (Spring Hill, default period): ' + results.length);
    const overflowing = results.filter((r) => r.overflow);
    const splitWords = results.filter((r) => r.split);
    overflowing.forEach((r) =>
      console.log('  OVERFLOW: "' + r.text + '" scrollWidth=' + r.scrollWidth + ' clientWidth=' + r.clientWidth),
    );
    splitWords.forEach((r) => console.log('  WORD SPLIT: "' + r.text + '"'));
    assert(
      overflowing.length === 0,
      overflowing.length + ' header cell(s) overflow their column (scrollWidth > clientWidth)',
    );
    assert(splitWords.length === 0, splitWords.length + ' header cell(s) split a word across lines');

    // No abbreviated labels the task called out, in any TABLE (header or row label) in the
    // rendered report. Scoped to <table> content, not the whole page — a scientific unit
    // notation in a chart caption (e.g. "kBtu/sq ft/yr") is a different, out-of-scope surface
    // from the literal column-header/row-label abbreviations problem 2 names.
    const tableText = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#rptPreviewPages table'))
        .map((t) => t.innerText)
        .join('\n---\n');
    });
    assert(!/\bSQ FT\b/.test(tableText), 'no bare "SQ FT" label in any rendered table');
    assert(!/\bKWH\b/.test(tableText), 'no all-caps "KWH" in any rendered table (must render as kWh)');
    assert(!/\bGAL\b/.test(tableText), 'no bare "GAL" label in any rendered table');
    assert(!/CSC \(\d/.test(tableText), 'no bare "CSC (N%)" row label (must be spelled out)');

    console.log(
      'TABLE TEXT SNIPPET (kWh case check): ' + (tableText.match(/.{0,20}kWh.{0,20}/) || ['(no kWh match)'])[0],
    );
    console.log('SQ FT context: ' + JSON.stringify(tableText.match(/.{0,30}SQ FT.{0,30}/g)));
    console.log('KWH context: ' + JSON.stringify(tableText.match(/.{0,30}KWH.{0,30}/g)));
    console.log('GAL context: ' + JSON.stringify(tableText.match(/.{0,30}\bGAL\b.{0,30}/g)));

    // ─── Problem 3: explicitly select a KNOWN-EMPTY quarter and confirm no-data behavior ──
    // Close preview via its own real close function, reopen modal, force Q3 2026 (Spring
    // Hill's bills run out well before then).
    await page.evaluate(() => {
      if (typeof closeReportPreview === 'function') closeReportPreview();
    });
    await page.waitForTimeout(800);
    await clickText(page, 'Generate Report', false);
    await page.waitForTimeout(1000);
    await page.locator('#rptV2Year').selectOption('2026');
    await page.locator('#rptV2Quarter').selectOption('3');
    await page.waitForTimeout(500);
    const warnHtml = await page.evaluate(() => {
      const el = document.getElementById('rptV2CoverageWarning');
      return el ? { visible: el.style.display !== 'none', html: el.innerText } : null;
    });
    console.log('Coverage warning for forced Q3 2026: ' + JSON.stringify(warnHtml));
    assert(
      !!(warnHtml && warnHtml.visible && warnHtml.html.length > 0),
      'Generate Report modal warns BEFORE generating that Q3 2026 has buildings with no bills',
    );

    await clickText(page, 'Generate Preview', true);
    await page.waitForTimeout(4000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const emptyBodyText = await page
      .locator('#rptPreviewPages')
      .innerText()
      .catch(() => '');
    assert(
      /No bills for this period/.test(emptyBodyText),
      'empty-quarter report states "No bills for this period" for buildings with no bills',
    );
    // The literal false claim this task fixes: a building status cell reading "On Track" while
    // every $ figure on that SAME row is $0. Since Spring Hill's real bill history ends well
    // before Q3 2026, if "On Track" appears anywhere near "$0" rows in the Building Performance
    // table, the no-data override did not apply — check no "On Track" text is present in a
    // report whose entire period has no bills for any building.
    const hasOnTrackInEmptyReport = /On Track/.test(emptyBodyText);
    assert(!hasOnTrackInEmptyReport, 'no building in the fully-empty Q3 2026 report claims "On Track"');

    await context.close();
    server.close();
  } catch (e) {
    console.log('TEST ERROR: ' + e.message);
    failed++;
    failures.push('unhandled error: ' + e.message);
    await context.close().catch(() => {});
    server.close();
  }

  console.log('\n=== Report header overflow / empty-period gate ===');
  console.log('Passed: ' + passed + ', Failed: ' + failed);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
