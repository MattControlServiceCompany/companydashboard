// test-paginate-keep-with-prev.js — _rptPaginateTokens never starts a page with a keepWithPrev token alone
// (2026-11-14: the Control Sequences "Total control sequences to program" row printed alone on the next page).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(REPO, 'app/report-engine.js'), 'utf8');
const start = src.indexOf('function _rptPaginateTokens(');
const end = src.indexOf('\nfunction ', start + 10);
if (start < 0 || end < 0) throw new Error('_rptPaginateTokens not found');
const sb = {};
vm.createContext(sb);
vm.runInContext(src.slice(start, end), sb);
const pag = (tokens, a, b) => vm.runInContext('_rptPaginateTokens', sb)(tokens, a, b);

let failed = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) failed++;
};
const row = (id, h) => ({ type: 'row', html: id, estH: h });
const ids = (chunks) => chunks.map((c) => c.map((t) => t.html).join(',')).join(' | ');

// 1. Rows fill page 1 exactly; the total does not fit: the last row moves down with it.
let r = pag([row('a', 100), row('b', 100), row('c', 100), Object.assign(row('T', 30), { keepWithPrev: true })], 300, 300);
ok(ids(r) === 'a,b | c,T', 'total row moves to the next page with the last row (' + ids(r) + ')');

// 2. Everything fits: no change.
r = pag([row('a', 100), row('b', 100), Object.assign(row('T', 30), { keepWithPrev: true })], 300, 300);
ok(ids(r) === 'a,b,T', 'one page when everything fits (' + ids(r) + ')');

// 3. Without the flag the old greedy split is kept.
r = pag([row('a', 100), row('b', 100), row('c', 100), row('T', 30)], 300, 300);
ok(ids(r) === 'a,b,c | T', 'no flag: plain greedy split (' + ids(r) + ')');

// 4. A page with one row only keeps that row (no empty page, no endless loop).
r = pag([row('a', 300), Object.assign(row('T', 30), { keepWithPrev: true })], 300, 300);
ok(ids(r) === 'a | T', 'single-row page is not emptied (' + ids(r) + ')');

// 5. The Control Sequences total row carries the flag.
ok(/Total control sequences to program[\s\S]{0,1200}keepWithPrev: true/.test(src), 'Control Sequences total row has keepWithPrev');

console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
