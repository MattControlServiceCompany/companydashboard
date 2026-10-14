/**
 * gate-flag-badge-onclick-escape.js
 *
 * Gate: udFlagBadgeHtml (app/utility-data.js) must put ids into its onclick attribute so the browser decodes
 * exactly the ids back, and no id can break out of the JS string. Loads the real function, feeds it ids with
 * "&quot;" text, quotes, ampersands and angle brackets, decodes the attribute the way an HTML parser does
 * (one pass), runs it in a vm, and fails when script ran or the decoded arguments differ from the ids.
 *
 * Usage: node tools/gate-flag-badge-onclick-escape.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const problems = [];
const src = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
const start = src.indexOf('function udFlagBadgeHtml(');
if (start < 0) {
  console.error('FAIL: udFlagBadgeHtml not found in app/utility-data.js');
  process.exit(1);
}
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const fnSrc = src.slice(start, end);
const fmt = fs.readFileSync(path.join(REPO, 'lib/formatting.js'), 'utf8');
const esc = /function _escHtml\([\s\S]*?\n\}/.exec(fmt);
if (!esc) { console.error('FAIL: _escHtml not found in lib/formatting.js'); process.exit(1); }
const ctx = vm.createContext({ billFlagHoverText: () => 'hover' });
vm.runInContext(esc[0] + '\n' + fnSrc, ctx);

function decodeOnce(s) {
  const map = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" };
  return s.replace(/&(quot|amp|lt|gt|apos|#39);/g, (m, n) => map[n]);
}
const IDS = [
  'plain-1',
  'x&quot;);window.__x=1;//',
  'a"b\'c&d<e>f',
  '&quot;',
  '&amp;quot;',
  '\\");window.__x=1;//',
  "');window.__x=1;//",
];
const cases = IDS.map((v) => ({ pid: v, bldgId: v, meterId: v }));
cases.push({ pid: 'p', bldgId: 'x&quot;);window.__x=1;//', meterId: 'm', embed: true });
for (const g of cases) {
  const html = vm.runInContext('udFlagBadgeHtml', ctx)({ flaggedBills: 1 }, g);
  // a summary with zero counted bills draws no badge at all (an outlier-only bill counts 0)
  if (vm.runInContext('udFlagBadgeHtml', ctx)({ flaggedBills: 0, flagCount: 0, perBill: { b1: [{}] } }, g) !== '')
    problems.push('a summary with 0 counted bills must draw no badge');
  const m = /onclick="([^"]*)"/.exec(html);
  if (!m) { problems.push('no onclick attribute for ' + JSON.stringify(g)); continue; }
  const code = decodeOnce(m[1]);
  const got = [];
  const sandbox = { udGoToFlagged: function () { got.push([].slice.call(arguments).slice(1)); }, event: {} };
  try { vm.runInNewContext(code, sandbox, { timeout: 1000 }); } catch (e) { problems.push('onclick threw for ' + JSON.stringify(g) + ': ' + e.message); continue; }
  if (sandbox.__x) problems.push('script ran from id ' + JSON.stringify(g.bldgId));
  const want = [g.pid, g.bldgId, g.meterId].concat(g.embed ? [true] : []);
  if (JSON.stringify(got[0]) !== JSON.stringify(want))
    problems.push('decoded args differ: got ' + JSON.stringify(got[0]) + ' want ' + JSON.stringify(want));
}
if (problems.length) {
  console.error('FAIL gate-flag-badge-onclick-escape:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('PASS gate-flag-badge-onclick-escape (' + cases.length + ' id sets)');
