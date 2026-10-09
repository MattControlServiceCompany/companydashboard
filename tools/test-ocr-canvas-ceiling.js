/**
 * test-ocr-canvas-ceiling.js  (item 60ebfd0c)
 *
 * _renderPageHQ must keep the supersample canvas inside a pixel ceiling. Synthetic page sizes only.
 * Loads _clampOcrSuperScale and its two limits from app/bill-analysis.js through Node's vm module.
 *
 * Usage: node tools/test-ocr-canvas-ceiling.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'bill-analysis.js'), 'utf8').split('\r\n').join('\n');
function grab(re, what) {
  const m = src.match(re);
  if (!m) {
    console.log('FAIL: cannot find ' + what);
    process.exit(1);
  }
  return m[0];
}
const code =
  grab(/const OCR_MAX_CANVAS_PIXELS = [^;]+;/, 'OCR_MAX_CANVAS_PIXELS') +
  '\n' +
  grab(/const OCR_MAX_CANVAS_SIDE = [^;]+;/, 'OCR_MAX_CANVAS_SIDE') +
  '\n' +
  grab(/function _clampOcrSuperScale\([\s\S]*?\n}\n/, '_clampOcrSuperScale') +
  '\n;this.clamp=_clampOcrSuperScale;this.maxPx=OCR_MAX_CANVAS_PIXELS;this.maxSide=OCR_MAX_CANVAS_SIDE;';
const ctx = vm.createContext({});
vm.runInContext(code, ctx);

let failed = 0;
function check(name, cond, detail) {
  if (!cond) {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}
// Page size in points at scale 1: letter 612x792, legal 612x1008, a very large sheet 2592x3456.
function run(wPt, hPt, target) {
  const sup = target * 1.6;
  const out = ctx.clamp(sup, target, wPt * sup, hPt * sup);
  return { sup, out, px: wPt * out * (hPt * out) };
}
let r = run(612, 792, 4.0);
check('letter at 4.0 is not changed', r.out === r.sup, r);
r = run(612, 1008, 4.0);
check('legal at 4.0 is not changed', r.out === r.sup, r);
r = run(2592, 3456, 4.0);
check('very large sheet at 4.0 is lowered', r.out < r.sup, r);
check('very large sheet drops to the target scale (the floor)', r.out === 4.0, r);
r = run(1800, 2400, 2.5);
check('mid-size sheet at 2.5 stays inside the pixel ceiling', r.px <= ctx.maxPx * 1.0001, r);
r = run(30000, 100, 1.0);
check('long thin sheet stays inside the side limit', 30000 * r.out <= ctx.maxSide * 1.0001 || r.out === 1.0, r);
r = run(9000, 9000, 4.0);
check('never below the target scale', r.out >= 4.0, r);
console.log(failed ? failed + ' failure(s)' : 'all passed');
process.exit(failed ? 1 : 0);
