/**
 * test-gap-marker.js - the gap chip (synthetic data only).
 * Checks: computeMeterGaps (computations/normalization.js) uses detectGap and finds each gap once, oldest first;
 * a 3 day read-date gap, a propane meter and a meter with no dates give no gap; building and project lists;
 * the chip is a dashed neutral outline with a calendar icon, no warning symbol, no flag-badge class;
 * the hover text gives the missing range; the click handler decodes to the right ids; the gap is never part of a
 * warning count (bill-flags.js does not call computeMeterGaps); and the three screens draw the chip.
 * Usage: node tools/test-gap-marker.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const problems = [];
const ok = (c, m) => { if (!c) problems.push(m); };
function fn(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(s, i + 1); }
  throw new Error('unbalanced ' + name);
}
const ud = rd('app/utility-data.js');
const norm = rd('computations/normalization.js');
const ctx = vm.createContext({});
vm.runInContext(
  ['_fixISO', '_parseISO', 'calcDays', 'fmtDate'].map((n) => fn(ud, n)).join('\n') +
    '\n' + fn(rd('lib/formatting.js'), '_escHtml') +
    '\n' + ['detectGap', 'computeMeterGaps', 'computeBuildingGaps', 'computeProjectGaps'].map((n) => fn(norm, n)).join('\n') +
    '\n' + fn(ud, 'udGapChipHtml'),
  ctx,
);
const run = (code) => vm.runInContext(code, ctx);
const B = (id, start, end) => ({ id, start, end });
const elec = {
  id: 'meter-a', commodity: 'Electric', account: 'SAMPLE-ACCT',
  bills: [B('b3', '2026-09-02', '2026-10-01'), B('b1', '2026-06-01', '2026-07-01'), B('b2', '2026-07-02', '2026-08-04'), B('b0', '2026-05-01', '2026-05-31')],
};
// b1 -> b2: 1 day apart (no gap). b2 end 08/04 -> b3 start 09/02: a gap. b0 end 05/31 -> b1 start 06/01: no gap.
ctx.m = elec;
let g = run('computeMeterGaps(m)');
ok(g.length === 1, 'one gap expected, got ' + g.length);
ok(g[0] && g[0].earlier === '2026-08-04' && g[0].later === '2026-09-02', 'gap dates wrong: ' + JSON.stringify(g[0]));
ok(g[0] && g[0].days === 30, 'gap days should be 30 (calcDays exclusive of the end dates in this data): ' + (g[0] && g[0].days));
ctx.m = { id: 'meter-p', commodity: 'Propane', bills: [B('p1', '2026-01-01', '2026-01-31'), B('p2', '2026-06-01', '2026-06-30')] };
ok(run('computeMeterGaps(m)').length === 0, 'propane meter must give no gap');
ctx.m = { id: 'meter-n', commodity: 'Gas', bills: [B('n1', '', ''), B('n2', '2026-01-01', '2026-01-31')] };
ok(run('computeMeterGaps(m)').length === 0, 'bills without dates must give no gap');
ctx.m = { id: 'meter-c', commodity: 'Gas', bills: [B('c1', '2026-01-01', '2026-01-31'), B('c2', '2026-02-03', '2026-02-28')] };
ok(run('computeMeterGaps(m)').length === 0, 'a 3 day gap is not a gap (detectGap threshold)');
ctx.bl = [{ id: 'bldg-1', meters: [elec] }, { id: 'bldg-2', meters: [{ id: 'meter-g', commodity: 'Gas', bills: [B('x1', '2026-01-01', '2026-01-31')] }] }];
const bg = run('computeBuildingGaps(bl[0])');
ok(bg.length === 1 && bg[0].meterId === 'meter-a', 'building gaps wrong');
const pg = run('computeProjectGaps(bl)');
ok(pg.length === 1 && pg[0].bldgId === 'bldg-1', 'project gaps wrong');
// chip
ctx.gaps = g;
const html = run('udGapChipHtml(gaps, { pid: "p1", bldgId: "bldg-1", meterId: "meter-a", later: gaps[0].later })');
ok(/border:\s*1px dashed/.test(rd('energy-department.html').replace(/\s+/g, ' ').match(/\.ud-gap-chip \{[^}]*\}/)[0]), 'chip CSS must be a dashed outline');
const css = rd('energy-department.html').match(/\.ud-gap-chip \{[^}]*\}/)[0];
ok(!/amber|orange|red|#f|rgba\(245|rgba\(239/i.test(css), 'chip CSS must not use warning colors');
ok(/📅/.test(html) && /> ?gap<\/span>$/.test(html.replace(/<span class="ud-gap-chip-ico"[^>]*>[^<]*<\/span>/, '')) || />gap</.test(html), 'chip text must be "gap"');
ok(!/⚠/.test(html) && !/ud-flag-badge/.test(html), 'chip must not look like a warning badge');
ok(/title="30 days missing 08\/04\/2026 – 09\/02\/2026\. Click/.test(html), 'hover text wrong: ' + html);
ok(run('udGapChipHtml(gaps)').indexOf('Click') < 0 && run('udGapChipHtml([])') === '', 'no click text without goto; empty list draws nothing');
ctx.two = g.concat(g);
ok(/>2 gaps</.test(run('udGapChipHtml(two)')), 'two gaps text');
// click decodes to the ids
const m = /onclick="([^"]*)"/.exec(html);
const dec = m[1].replace(/&(quot|amp|lt|gt|#39);/g, (x, n) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" })[n]);
const got = [];
vm.runInNewContext(dec, { udGoToGap: function () { got.push([].slice.call(arguments).slice(1)); }, event: {} });
ok(JSON.stringify(got[0]) === JSON.stringify(['p1', 'bldg-1', 'meter-a', false, '2026-09-02']), 'click args wrong: ' + JSON.stringify(got[0]));
// gap is not a warning
ok(!/computeMeterGaps|computeBuildingGaps|computeProjectGaps|udGapChipHtml/.test(rd('computations/bill-flags.js')), 'bill-flags.js must not use gaps');
ok(!/ud-gap-chip/.test(fn(ud, 'udFlagBadgeHtml')), 'the warning badge must not draw the gap chip');
// the three screens
ok(/udGapChipHtml\(_bGaps/.test(ud) && /udGapChipHtml\(_mGaps/.test(ud) && /udGapChipHtml\(_pGaps/.test(ud), 'building row, meter pill and project row in utility-data.js');
ok(/udGapChipHtml\(pGaps/.test(rd('app/energy-savings.js')), 'sidebar Projects nav');
ok(/udGapChipHtml\(bGaps/.test(rd('app/core.js')), 'project tab building list');
ok(/data-gap-later=/.test(ud), 'Bills gap row must carry data-gap-later');
// Bills-tab gap rows come from the same computeMeterGaps result as the chip (one gap finder)
const billsTab = ud.slice(ud.indexOf('bills.forEach((row, idx) => {'), ud.indexOf('const flags = billFlags[row.id]'));
ok(/computeMeterGaps\(m\)/.test(ud.slice(ud.indexOf('const _meterGaps'), ud.indexOf('const _meterGaps') + 60)), 'Bills tab must call computeMeterGaps');
ok(!/detectGap\(/.test(billsTab), 'Bills-tab row loop must not call detectGap itself');
const gapRowFn = ud.split(String.fromCharCode(10)).find((l) => l.indexOf("const _gapForRow = ") >= 0).trim();
ctx.m = elec;
[true, false].forEach((asc) => {
  const rows = elec.bills.filter((b) => b.start && b.end).sort((a, b) => (asc ? 1 : -1) * (new Date(a.start) - new Date(b.start)));
  const sandbox = { sortAsc: asc, _meterGaps: run('computeMeterGaps(m)') };
  const hits = rows.filter((r, i) => i > 0 && vm.runInNewContext(gapRowFn + '; _gapForRow(r)', Object.assign({ r }, sandbox)));
  ok(hits.length === sandbox._meterGaps.length && hits.length === 1, 'Bills-tab gap rows (' + (asc ? 'asc' : 'desc') + ') must equal chip gap count: ' + hits.length);
});
// XSS: a date or id with markup must reach attributes escaped
ok(/data-gap-later="\$\{_escHtml\(gapLater\)\}"/.test(ud), 'data-gap-later must be escaped with _escHtml');
const evil = '<img src=x onerror=1>"';
const evilHtml = run('_escHtml(' + JSON.stringify(evil) + ')');
ok(evilHtml.indexOf('<') < 0 && evilHtml.indexOf('"') < 0, 'escape helper must neutralise markup and quotes');
if (problems.length) { console.error('FAIL test-gap-marker:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('PASS test-gap-marker');
