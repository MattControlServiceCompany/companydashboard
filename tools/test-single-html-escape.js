/**
 * test-single-html-escape.js  (single source of truth, 2026-10-07)
 *
 * Gate: HTML is escaped by ONE function, _escHtml (lib/formatting.js).
 * Fails when:
 *   1. _escHtml does not encode all five characters  & < > " '  (or does not turn null/undefined into '').
 *   2. A file in app/, computations/, extraction/, lib/ (other than lib/formatting.js) or a root/page .html
 *      or .js file holds its own copy of the escape (.replace(/&/g, '&amp;') or a '&': '&amp;' map).
 *      Allowed: the two XML escapers for Word files (_docxEscapeXml in docx-writer.js, _sooXmlEsc in
 *      soo-generator.js). They write XML, not HTML.
 *   3. A page that loads app scripts does not load lib/formatting.js before app/sync-ui.js.
 *
 * Usage: node tools/test-single-html-escape.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const KEEPER = path.join('lib', 'formatting.js');
const XML_ALLOWED = new Set([path.join('app', 'docx-writer.js'), path.join('app', 'soo-generator.js')]);
const COPY = /\/&\/g\s*,\s*'&amp;'|'&'\s*:\s*'&amp;'/;
const problems = [];

// 1. behavior
const fmt = fs.readFileSync(path.join(REPO, KEEPER), 'utf8');
const sb = {};
vm.createContext(sb);
vm.runInContext(fmt, sb);
if (typeof sb._escHtml !== 'function') {
  problems.push(KEEPER + ' does not define _escHtml');
} else {
  const got = sb._escHtml(`O'Brien & <b>x</b> "q"`);
  const want = 'O&#39;Brien &amp; &lt;b&gt;x&lt;/b&gt; &quot;q&quot;';
  if (got !== want) problems.push('_escHtml output wrong: ' + got);
  if (sb._escHtml(null) !== '' || sb._escHtml(undefined) !== '') problems.push('_escHtml(null/undefined) is not empty');
  if (sb._escHtml(0) !== '0') problems.push('_escHtml(0) is not "0"');
}

// 2. no private copies
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(full);
  }
  return out;
}
const files = ['app', 'computations', 'extraction', 'lib'].reduce((a, d) => walk(path.join(REPO, d), a), []);
for (const name of fs.readdirSync(REPO)) {
  if (/^(index|energy-department|ems-leads)\.html$|^(site-ui|feedback-widget)\.js$/.test(name)) files.push(path.join(REPO, name));
}
for (const file of files) {
  const rel = path.relative(REPO, file);
  if (rel === KEEPER || XML_ALLOWED.has(rel)) continue;
  const lines = fs.readFileSync(file, 'latin1').split('\n');
  lines.forEach((ln, i) => {
    if (COPY.test(ln)) problems.push(rel + ':' + (i + 1) + '  private HTML escape (use _escHtml from lib/formatting.js)');
  });
}

// 3. every page loads the shared module before sync-ui.js
for (const page of ['index.html', 'energy-department.html', 'ems-leads.html']) {
  const html = fs.readFileSync(path.join(REPO, page), 'utf8');
  const a = html.indexOf('lib/formatting.js');
  const b = html.indexOf('app/sync-ui.js');
  if (a < 0 || b < 0 || a > b) problems.push(page + ': lib/formatting.js must load before app/sync-ui.js');
}

if (problems.length) {
  console.log('FAIL: single HTML escape gate - ' + problems.length + ' problem(s)');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('PASS: single HTML escape gate - _escHtml (lib/formatting.js) is the only HTML escaper');
