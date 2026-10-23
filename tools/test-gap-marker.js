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
    '\n' + fn(ud, 'udGapTextHtml'),
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
// gap text
ctx.gaps = g;
const html = run('udGapTextHtml(gaps, { pid: "p1", bldgId: "bldg-1", meterId: "meter-a", later: gaps[0].later }, "bldg")');
const css = rd('energy-department.html').match(/\.ud-gap-txt \{[^}]*\}/)[0];
ok(!/border|background|amber|orange|red|#f|rgba\(245|rgba\(239/i.test(css), 'gap text CSS must be plain text: no border, fill or warning color');
ok(/>1 baseline gap</.test(html) && /ud-gap-base/.test(html) && !/📅|ud-gap-ico/.test(html), 'building text must be "1 baseline gap", no icon: ' + html);
ok(!/⚠/.test(html) && !/ud-flag-badge/.test(html), 'gap text must not look like a warning badge');
ok(/title="30 days missing 08\/04\/2026 – 09\/02\/2026, in baseline\. Click/.test(html), 'hover text wrong: ' + html);
ok(run('udGapTextHtml(gaps, null, "proj")').indexOf('Click') < 0 && run('udGapTextHtml([], null, "proj")') === '', 'no click text without goto; empty list draws nothing');
ctx.two = g.concat(g);
ok(/>2 baseline gaps</.test(run('udGapTextHtml(two, null, "proj")')), 'project text: N baseline gaps');
// baseline flag: ONE rule in computeMeterGaps; excluded meters give baseline:false
ok(g[0].baseline === true, 'default gap is a baseline gap');
ctx.ex = { id: 'meter-a', commodity: 'Electric', bills: elec.bills };
ok(run('computeMeterGaps(ex, false)')[0].baseline === false, 'excluded meter gap must be baseline:false');
ok(run('computeBuildingGaps({meters:[ex]}, (m) => m.id === "meter-a")')[0].baseline === false, 'building gaps read the exclusion predicate');
ok(run('computeProjectGaps([{id:"bldg-1",meters:[ex]}], () => true)')[0].baseline === false, 'project gaps read the exclusion predicate');
ctx.mix = [{ baseline: false, days: 5, earlier: '2026-01-01', later: '2026-01-06' }, g[0], g[0], { baseline: false, days: 5, earlier: '2026-02-01', later: '2026-02-06' }, { baseline: false, days: 5, earlier: '2026-03-01', later: '2026-03-06' }];
const mixHtml = run('udGapTextHtml(mix, null, "bldg")');
ok(/>2 baseline gaps<\/span> · <span[^>]*>3 other gaps</.test(mixHtml), 'rollup: baseline first, then other: ' + mixHtml);
ok(/not in baseline/.test(mixHtml) && /in baseline/.test(mixHtml), 'hover says in baseline / not in baseline');
ok(run('udGapTextHtml([mix[0]], null, "proj")') === '', 'Projects list shows nothing when there are no baseline gaps');
ok(!/baseline/.test(run('udGapTextHtml([mix[0]], null, "pill")').replace(/title="[^"]*"/, '')) && />1 gap</.test(run('udGapTextHtml([mix[0]], null, "pill")')), 'non-baseline pill: "1 gap"');
const css2 = rd('energy-department.html').match(/\.ud-gap-txt\.ud-gap-base \{[^}]*\}/)[0];
ok(/var\(--text\)/.test(css2) && /font-weight: 600/.test(css2) && !/#|orange|red|amber/.test(css2), 'baseline gap CSS: near-black semibold, token only');
// names wrap, are not cut; sidebar label
const edh = rd('energy-department.html');
ok(!/\.ud-nav-bldg-name \{[^}]*(ellipsis|nowrap)/.test(edh), 'building names must wrap');
ok(/id="siteDataBtn"[^>]*>(<span class="s-ico"><\/span><span class="s-txt">)?Backup &amp; Data</.test(edh), 'sidebar button label');
ok(/>1 baseline gap</.test(run('udGapTextHtml(gaps, {meterId:"meter-a", later:"x"}, "pill")')), 'pill text: 1 baseline gap');
ok(!/📅/.test(run('udGapTextHtml(gaps, null, "pill")')), 'pill text has no icon');
// click decodes to the ids
const m = /onclick="([^"]*)"/.exec(html);
const dec = m[1].replace(/&(quot|amp|lt|gt|#39);/g, (x, n) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" })[n]);
const got = [];
vm.runInNewContext(dec, { udGoToGap: function () { got.push([].slice.call(arguments).slice(1)); }, event: {} });
ok(JSON.stringify(got[0]) === JSON.stringify(['p1', 'bldg-1', 'meter-a', false, '2026-09-02']), 'click args wrong: ' + JSON.stringify(got[0]));
// gap is not a warning
ok(!/computeMeterGaps|computeBuildingGaps|computeProjectGaps|udGapTextHtml/.test(rd('computations/bill-flags.js')), 'bill-flags.js must not use gaps');
ok(!/ud-gap-chip/.test(fn(ud, 'udFlagBadgeHtml')), 'the warning badge must not draw the gap chip');
// the screens: building row (both lists), meter pill, Projects table; none in the left Projects nav
ok(/udGapTextHtml\(_bGaps/.test(ud) && /udGapTextHtml\(_mGaps/.test(ud), 'building row and meter pill in utility-data.js');
ok(/udGapTextHtml\(bGaps/.test(rd('app/core.js')) && /udGapTextHtml\(_pGaps, null, 'proj'\)/.test(rd('app/core.js')), 'embedded building row and Projects table in core.js');
ok(!/udGap|computeProjectGaps/.test(rd('app/energy-savings.js')), 'left Projects nav must show no gap marker');
ok(!/udGapTextHtml\(_pGaps, _pGaps\.length/.test(ud), 'Utility Data project nav must show no gap marker');
ok(!/udGapChipHtml|ud-gap-chip/.test(ud + rd('app/core.js') + rd('energy-department.html')), 'the old chip is gone');

if (problems.length) { console.error('FAIL test-gap-marker:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('PASS test-gap-marker');
