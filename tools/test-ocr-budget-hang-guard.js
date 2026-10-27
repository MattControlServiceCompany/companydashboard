/**
 * test-ocr-budget-hang-guard.js  (item efc38a78)
 *
 * The OCR time budget in app/bill-analysis.js is a hang guard only. A slow engine (Firefox runs the
 * same Tesseract wasm about 5.7x slower than Chromium) must never leave a page before the position
 * read. Checks the constants and that the two early returns still test the budget flag (the guard).
 *
 * Usage: node tools/test-ocr-budget-hang-guard.js
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'bill-analysis.js'), 'utf8').split('\r\n').join('\n');
let failed = 0;
function check(name, cond, detail) {
  if (!cond) {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}
const perPage = src.match(/const OCR_PER_PAGE_ALLOWANCE_MS = (\d+) \* 1000;/);
const ceiling = src.match(/const OCR_ABSOLUTE_CEILING_MS = (\d+) \* 60 \* 1000;/);
check('per-page allowance found', !!perPage);
check('ceiling found', !!ceiling);
if (perPage && ceiling) {
  const perPageSec = Number(perPage[1]);
  const ceilingMin = Number(ceiling[1]);
  // Slowest honest run measured: Firefox, about 215 s for one hard page. Allowance must be far above.
  check('allowance is at least 4 times the slowest measured page (215 s)', perPageSec >= 860, perPageSec);
  check('a real hang limit remains (allowance not above 1 hour a page)', perPageSec <= 3600, perPageSec);
  check('ceiling is a finite hang limit (at most 4 hours)', ceilingMin > 0 && ceilingMin <= 240, ceilingMin);
  check('ceiling is not below one allowance', ceilingMin * 60 >= perPageSec, { perPageSec, ceilingMin });
}
check('budget flag still guards the page loop', /if \(_ocrBudgetExceeded\) \{/.test(src));
console.log(failed ? failed + ' failure(s)' : 'all passed');
process.exit(failed ? 1 : 0);
