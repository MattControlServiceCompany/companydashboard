// Setpoint Programming Review makes no "Not Scheduled"/"no setpoint programmed" claim for data
// that is merely absent. SYNTHETIC data only. Run: node test-audit-setpoint-review-claims.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/report-engine.js', 'utf8');
const start = src.indexOf('function rptPageASHRAE36SetpointReview(');
let i = src.indexOf('{', start), depth = 0, end = i;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
const ctx = {
  console,
  rptBuildingDisplayName: (n) => n,
  rptBuildingNameSort: (a, b) => a.localeCompare(b),
  rptPage: (n, t, body) => body,
  _rptPaginateTokens: () => [],
};
vm.createContext(ctx);
// Capture the table body by stubbing the paginator-facing helpers is fragile; instead run and
// collect all strings that reach rptPage / the paginator via a recording stub.
let seen = '';
ctx.rptPage = (n, t, body) => { seen += body; return body; };

Object.assign(ctx, {
  _a36DisplayName: (b) => b.name, _rptMeasureTableTokens: () => null, _rptMeasureHtmlH: () => null,
  _rptContentBudget: () => 1000, RPT_SECTION_HEAD_PX: 14,
  _rptPaginateWithTail: (tokens) => { tokens.forEach((t) => { seen += t.html; }); return [tokens]; },
  _injectPageNumbers: (x) => x,
});
vm.runInContext(src.slice(start, end + 1), ctx);
const res = (st, a) => ({ checkKey: st, actualValue: a, gl36Default: 70, status: a === null ? 'NOT_SCHEDULED' : 'PASS', intentionalFlag: false });
const sp = (h, c) => ({
  hasAnyData: h !== null || c !== null, hasAnyNotScheduled: h === null || c === null,
  results: [res('occHeat', h), res('occCool', c), res('unoccHeat', null), res('unoccCool', null), res('deadband', null), res('co2', null)],
});
const d = {
  project: { name: 'Synthetic' }, rawDate: '2026-01-01',
  buildings: [
    { name: 'Has Data', equipResults: [{ category: 'vav', spCompliance: sp(70, 75) }, { category: 'vav', spCompliance: sp(null, null) }] },
    { name: 'No Data', equipResults: [{ category: 'vav', spCompliance: sp(null, null) }] },
  ],
};
try { ctx.rptPageASHRAE36SetpointReview(1, d); } catch (e) { console.log('threw', e.message); }
assert(!/Not Scheduled|no setpoint programmed/i.test(seen), 'no absent-data claim');
assert(/Has Data/.test(seen) && /1 zone match/.test(seen), 'data building listed, zone count excludes no-data zone');
assert(!/No Data/.test(seen), 'no-data building not listed as a row');
console.log('OK');
