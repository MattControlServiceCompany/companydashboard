// Unit test: getReportCoverage (computations/report-data.js) - the one rule for which months a report covers.
// Synthetic fixture only. Run: node tools/test-report-coverage.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.resolve(__dirname, '..');
const sb = { console, Set, Map, WeakMap, Date, Math, Number, String, Array, Object, JSON, RegExp, parseInt, parseFloat };
sb.window = sb;
sb.DELIVERY_COMMODITIES = new Set(['Propane']);
const ctx = vm.createContext(sb);
// _fixISO and _parseISO live in app/utility-data.js (a big file): copy just those two functions.
const ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
['_fixISO', '_parseISO'].forEach((n) => {
  const i = ud.indexOf('function ' + n + '(');
  new vm.Script(ud.slice(i, ud.indexOf('\n}', i) + 2)).runInContext(ctx);
});
['lib/date-helpers.js', 'computations/normalization.js', 'computations/report-data.js'].forEach((f) =>
  new vm.Script(fs.readFileSync(path.join(REPO, f), 'utf8'), { filename: f }).runInContext(ctx),
);
const mkBills = (list) => list.map((x) => ({ start: x[0], end: x[1] }));
const baseline = { months: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'] };
let meters;
sb.getUDBldgs = () => [{ id: 'b1', name: 'High School', meters }];
sb._rptMeterEligible = (p, m) => (m.excluded ? 'excluded' : '');
function setMeters() {
  meters = [
    { id: 'e1', commodity: 'Electric', baseline, bills: mkBills([['2026-01-05', '2026-02-05'], ['2026-02-05', '2026-03-05'], ['2026-08-06', '2026-09-06'], ['2026-09-06', '2026-10-06']]) },
    { id: 'g1', commodity: 'Gas', baseline, bills: mkBills([['2026-01-15', '2026-02-15'], ['2026-07-15', '2026-08-15']]) },
    // propane: last delivery before the baseline end -> no post-baseline bill; the normalizer zero-fills months to today.
    { id: 'p1', commodity: 'Propane', baseline, bills: mkBills([['2025-11-20', '2025-11-20']]) },
    { id: 'x1', commodity: 'Electric', excluded: true, baseline, bills: mkBills([['2026-11-01', '2026-12-01']]) },
  ];
}
let fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)));
};
setMeters();
let c = ctx.getReportCoverage('p', null);
eq('start is first post-baseline month with a bill', c.startYm, '2026-01');
eq('end is last month with a real bill (September, not October)', c.endYm, '2026-09');
eq('yms run first to last', c.yms.length, 9);
eq('latest bill date is clamped to the period end (Sep 30, not Oct 6)', c.lastBillDate, '2026-09-30');
eq('gas through date', c.gasThrough, '2026-08-15');
eq('excluded meter (Dec 2026 bill) never extends the period', c.yms.indexOf('2026-12'), -1);
c = ctx.getReportCoverage('p', ['g1']);
eq('selection of the gas meter only ends in July', c.endYm, '2026-07');
c = ctx.getReportCoverage('p', null, '2026-03', '2026-06');
eq('user range clamps start and end', [c.startYm, c.endYm], ['2026-03', '2026-06']);
c = ctx.getReportCoverage('p', null, '2026-01', '2026-12');
eq('user range past the last bill does not extend the period', c.endYm, '2026-09');
c = ctx.getReportCoverage('p', ['p1']);
eq('propane with no post-baseline delivery gives no coverage', [c.hasData, c.startYm, c.endYm, c.yms.length], [false, '', '', 0]);
// Completeness: a quarter is complete only when every included monthly meter has a bill for every month.
setMeters();
meters[0].bills = mkBills([['2026-07-06', '2026-08-06'], ['2026-08-06', '2026-09-06'], ['2026-09-06', '2026-10-06']]);
meters[1].bills = mkBills([['2026-07-15', '2026-08-15'], ['2026-08-15', '2026-09-15'], ['2026-09-15', '2026-10-15']]);
let rr = ctx.reportRequestRange({ quarter: 3, year: 2026 });
eq('request range of Q3 2026', rr, { startYm: '2026-07', endYm: '2026-09' });
c = ctx.getReportCoverage('p', null, rr.startYm, rr.endYm);
eq('all meters billed Jul-Sep: Q3 complete', [c.complete, c.missing.length, c.waitingText], [true, 0, '']);
meters[1].bills = mkBills([['2026-07-15', '2026-08-15'], ['2026-08-15', '2026-09-15']]);
c = ctx.getReportCoverage('p', null, rr.startYm, rr.endYm);
eq('gas meter missing one month: Q3 incomplete', c.complete, false);
eq('missing entry names the meter month', c.missing.map((x) => x.commodity + ' ' + x.ym), ['Gas 2026-09']);
eq('waiting text is plain words', c.waitingText, 'waiting for Gas High School Sep 2026 bills');
eq('incomplete quarter still reports its months with bills', c.yms.length, 3);
rr = ctx.reportRequestRange({ quarter: 4, year: 2026 });
c = ctx.getReportCoverage('p', null, rr.startYm, rr.endYm);
eq('Q4 with bills only through Sep is incomplete and has no months', [c.complete, c.hasData], [false, false]);
// Building selection: the coverage uses the same building set as the report.
sb.getUDBldgs = () => [
  { id: 'b1', name: 'High School', meters: [{ id: 'e1', commodity: 'Electric', baseline, bills: mkBills([['2026-01-05', '2026-02-05'], ['2026-02-05', '2026-03-05']]) }] },
  { id: 'b2', name: 'Middle School', meters: [{ id: 'e2', commodity: 'Electric', baseline, bills: mkBills([['2026-05-05', '2026-06-05'], ['2026-06-05', '2026-07-05']]) }] },
];
c = ctx.getReportCoverage('p', null);
eq('both buildings: Jan to Jun', [c.startYm, c.endYm], ['2026-01', '2026-06']);
c = ctx.getReportCoverage('p', null, '', '', ['b2']);
eq('building b2 only: period from its own bills', [c.startYm, c.endYm], ['2026-05', '2026-06']);
c = ctx.getReportCoverage('p', null, '', '', ['b1']);
eq('building b1 only: period from its own bills', [c.startYm, c.endYm], ['2026-01', '2026-02']);
c = ctx.getReportCoverage('p', null, '2026-01', '2026-03', ['b1']);
eq('through date never passes the period end', c.electricThrough, '2026-02-28');
process.exit(fail ? 1 : 0);
