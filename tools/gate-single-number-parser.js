/**
 * gate-single-number-parser.js  (WP-01, math-audit 2026-09-28)
 *
 * Gate: bill numbers are read by ONE function, parseBillNumber (lib/formatting.js).
 * Fails when:
 *   1. lib/formatting.js does not define parseBillNumber, or energy-department.html does not load it
 *      before the first computations/ or app/ script (app/ch-auth.js, the sign-in loader, is exempt:
 *      it reads no bill numbers and loads first on purpose).
 *   2. A file in app/, computations/, extraction/ or lib/ (other than lib/formatting.js) defines its own
 *      one-argument number parser: a function whose argument goes straight into parseFloat() and that
 *      strips commas or "$" first, or that carries one of the old copy names (pf, _pf, pf2, pn, ...).
 *          const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
 *          var pf = function (v) { return parseFloat(v) || 0; };
 * Not parsers (allowed): functions that read a DOM input by id, functions of more than one argument,
 * and unit converters that call parseFloat without a comma strip. Inline parseFloat(x) calls are not
 * definitions and are not flagged.
 *
 * Usage: node tools/gate-single-number-parser.js [repo-root]
 */
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const DIRS = ['app', 'computations', 'extraction', 'lib'];
const KEEPER = path.join('lib', 'formatting.js');
const OLD_NAMES = /^(pf\d?|_pf\d?|pn|pn0|pn0b|pnL|_pfe|_pfBills|_pfTE|pfR)$/;
const problems = [];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}
function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

// 1. keeper exists and is loaded first
const keeperPath = path.join(REPO, KEEPER);
const keeperSrc = fs.existsSync(keeperPath) ? fs.readFileSync(keeperPath, 'utf8') : '';
if (!/function\s+parseBillNumber\s*\(/.test(keeperSrc)) {
  problems.push(KEEPER + ' does not define parseBillNumber');
}
const htmlPath = path.join(REPO, 'energy-department.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const tags = [...html.matchAll(/<script[^>]*\ssrc="([^"?]+)/g)].map((m) => m[1]);
  const keeperIdx = tags.indexOf('lib/formatting.js');
  const firstUserIdx = tags.findIndex((t) => /^(app|computations)\//.test(t) && t !== 'app/ch-auth.js');
  if (keeperIdx < 0) problems.push('energy-department.html does not load lib/formatting.js');
  else if (firstUserIdx >= 0 && keeperIdx > firstUserIdx) {
    problems.push('energy-department.html loads lib/formatting.js AFTER ' + tags[firstUserIdx]);
  }
}

// 2. no second parser
// A one-argument function whose argument goes straight into parseFloat(...).
//   arrow:        name = (v) => ... parseFloat( [String(] v
//   function:     name = function (v) { [return] ... parseFloat( [String(] v
//   declaration:  function name(v) { [return] ... parseFloat( [String(] v
const ARG_INTO_PARSE = String.raw`parseFloat\(\s*(?:String\(\s*)?(?:\(\s*)?`;
const DEFS = [
  new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*\(\s*(\w+)\s*\)\s*=>\s*(?:\{\s*(?:return\s+)?)?[^;\n]{0,120}?` +
      ARG_INTO_PARSE +
      String.raw`\2\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*(?:return\s+)?[^;{}]{0,120}?` +
      ARG_INTO_PARSE +
      String.raw`\2\b`,
    'g',
  ),
  new RegExp(
    String.raw`\bfunction\s+(\w+)\s*\(\s*(\w+)\s*\)\s*\{\s*(?:return\s+)?[^;{}]{0,120}?` +
      ARG_INTO_PARSE +
      String.raw`\2\b`,
    'g',
  ),
];
const STRIPS_COMMA_OR_DOLLAR = /\.replace\(\s*\/[^/\n]*[,$]/;

for (const dir of DIRS) {
  for (const file of walk(path.join(REPO, dir), [])) {
    const rel = path.relative(REPO, file);
    if (rel === KEEPER) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const re of DEFS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const win = src.slice(m.index, m.index + 260);
        if (!OLD_NAMES.test(m[1]) && !STRIPS_COMMA_OR_DOLLAR.test(win)) continue;
        problems.push(rel + ':' + lineOf(src, m.index) + '  local number parser "' + m[1] + '" (use parseBillNumber)');
      }
    }
    // Old copy names, even when the body is not matched above.
    const nameRe = /\b(?:const|let|var|function)\s+(\w+)\s*(?:=|\()/g;
    let m2;
    while ((m2 = nameRe.exec(src))) {
      if (!OLD_NAMES.test(m2[1])) continue;
      const tail = src.slice(m2.index, m2.index + 160);
      if (/\(\s*id\s*,\s*def\s*\)/.test(tail)) continue; // DOM-input getter pf(id, def): not a parser
      if (/=\s*f\._persistFlag/.test(tail)) continue; // flag alias in utility-data.js: not a parser
      const at = rel + ':' + lineOf(src, m2.index) + '  old parser name "' + m2[1] + '"';
      if (!problems.some((p) => p.startsWith(rel + ':' + lineOf(src, m2.index) + ' '))) problems.push(at);
    }
  }
}

if (problems.length) {
  console.log('FAIL: single number parser gate - ' + problems.length + ' problem(s)');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('PASS: single number parser gate - parseBillNumber is the only bill-number parser');
