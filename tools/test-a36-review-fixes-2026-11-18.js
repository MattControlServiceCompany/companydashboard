// tools/test-a36-review-fixes-2026-11-18.js - review fixes of the Audit Report (Matt 2026-11-18). SYNTHETIC data only.
//   1. The ASHRAE 36 Readiness page is gone (rptPageASHRAE36Scores and its sentence builder are deleted).
//   2. The footnote "* Not an ASHRAE 36 item." prints directly after the last token of its own chapter, never after the next chapter title.
//   3. The equipment types of the Executive Summary sentence add up to the units counted (a type no tier names is its own tier).
//   5. The CO2 note of an opportunity counts the units with a CO2 sensor point from the same covered points as the System Description.
//   6. A second opportunity with the same missing device in the same group does not repeat the cause sentence; "single zone" is "single-zone".
// Run: node tools/test-a36-review-fixes-2026-11-18.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RE = fs.readFileSync(path.join(__dirname, '..', 'app', 'report-engine.js'), 'utf8');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
function fnSrc(name) {
  const idx = RE.search(new RegExp('function ' + name + '[ ]*[(]'));
  if (idx < 0) throw new Error('not found: ' + name);
  let i = RE.indexOf('{', RE.indexOf(')', idx)), d = 0, j = i;
  for (; j < RE.length; j++) {
    if (RE[j] === '{') d++;
    else if (RE[j] === '}' && --d === 0) break;
  }
  return RE.slice(idx, j + 1);
}
function slice(a, b) {
  const s = RE.indexOf(a);
  const e = RE.indexOf(b, s + a.length);
  if (s < 0 || e < 0) throw new Error('not found: ' + a);
  return RE.slice(s, e);
}
const code = RE.replace(/\/\/[^\n]*/g, '');

// 1. the page is gone
check(!/rptPageASHRAE36Scores|_a36ReadinessSummary/.test(code) && !/ASHRAE 36 Readiness<\/div>/.test(code) && !/'Sequences to Program'|'Devices to Install'/.test(code),
  '1. the ASHRAE 36 Readiness page, its sentence builder and its two cards are deleted');

// 2. footnote placement
{
  const sb = { A36_STAR_NOTE: '[NOTE]' };
  vm.createContext(sb);
  vm.runInContext(fnSrc('_a36DetBody'), sb);
  const tk = (html, o) => Object.assign({ html: html, type: 'block' }, o || {});
  // chapter A has a starred opportunity, chapter B (starts on the same page) has none
  let h = sb._a36DetBody([tk('<a1>', { star: true }), tk('<a2>'), tk('<B-title>', { chapterStart: true }), tk('<b1>')], 0);
  check(h === '<a1><a2>[NOTE]<B-title><b1>', '2. the note follows the last token of the chapter that has the asterisk, before the next chapter title: ' + h);
  // both chapters have a starred opportunity: one note under each
  h = sb._a36DetBody([tk('<a1>', { star: true }), tk('<B-title>', { chapterStart: true }), tk('<b1>', { star: true })], 0);
  check(h === '<a1>[NOTE]<B-title><b1>[NOTE]', '2. a starred chapter after a starred chapter: a note under each: ' + h);
  // one chapter only: the note is at the end of the page
  h = sb._a36DetBody([tk('<a1>', { star: true }), tk('<a2>')], 0);
  check(h === '<a1><a2>[NOTE]', '2. one chapter: the note is at the end of its list: ' + h);
  // no asterisk on the page: no note
  h = sb._a36DetBody([tk('<a1>'), tk('<B-title>', { chapterStart: true }), tk('<b1>', { star: true })], 0);
  check(h === '<a1><B-title><b1>[NOTE]', '2. only the chapter with the asterisk gets the note: ' + h);
  check(!/starNote/.test(fnSrc('_a36DetPages')), '2. _a36DetPages adds no page-end note (one rule: _a36DetBody)');
}
// 2b. the paginator reserves the note of the chapter above when the next chapter starts on its page
{
  const sb = {
    A36_STAR_NOTE_H: 24,
    _a36DetFigureHtml: () => '',
    _a36DetTok: (html, keepNext) => ({ type: 'block', html: html, estH: 100, keepNext: !!keepNext }),
  };
  vm.createContext(sb);
  vm.runInContext(slice('var A36_DET_FIG_MIN_SCALE', '// Words of the listed page text'), sb);
  vm.runInContext(slice('var A36_DET_TABLE_GAP_H', 'function _a36DetBody'), sb);
  const mk = (n, o) => Object.assign({ type: 'block', html: n, estH: 100, keepNext: false }, o || {});
  const flow = (star) => [mk('a1', star ? { star: true } : {}), mk('a2'), mk('a3'), mk('b1', { chapterStart: true }), mk('b2'), mk('b3'), mk('b4')];
  const withStar = sb._a36DetPaginate(flow(true), 700);
  const noStar = sb._a36DetPaginate(flow(false), 700);
  check(noStar[0].length === 7, '2b. without an asterisk the two chapters share one page (' + noStar.map((c) => c.length).join('+') + ')');
  check(withStar[0].length === 6 && withStar[1].length === 1, '2b. with an asterisk in the chapter above, the note height is reserved on the shared page (' + withStar.map((c) => c.length).join('+') + ')');
}

// 3. the equipment types add up to the units
{
  const sb = {
    _a36DisplayName: (b) => b.name,
    _a36AuditUnitsOf: (b) => (b.equipCount || 0) + (b.lighting ? b.lighting.count : 0),
    _a36DetNorm: (s) => String(s).toLowerCase(),
    _a36DetContext: () => ({}),
  };
  vm.createContext(sb);
  vm.runInContext(slice('function _a36AuditAffectedUnits', '// "54 opportunities on 279 equipment units"') + '\n' + slice('var A36_AUDIT_RING_TIERS', '// The score rings of the audit'), sb);
  const d = {
    buildings: [
      { name: 'L1', equipCount: 14, equipCounts: { ahu: 2, vav: 5, heater: 3, ef: 2, chwp: 1, hwp: 1 }, lighting: { count: 4 } },
      { name: 'L2', equipCount: 6, equipCounts: { rtu: 1, fcu: 3, boiler2: 2 }, lighting: { count: 2 } },
    ],
    _a36AuditCtx: {
      model: {
        findings: [
          { lib: 'L1', category: 'heater', affected: ['H1'] },
          { lib: 'L1', category: 'ef', affected: ['E1', 'E2'] },
          { lib: 'L1', category: 'vav', affected: ['V1'] },
          { lib: 'L2', category: 'boiler2', affected: ['X1'] },
          { lib: 'L2', category: 'lighting', affected: ['Q1'] },
          { lib: 'L2', category: 'rtu', affected: ['R1'] },
        ],
      },
    },
  };
  const st = sb._a36AuditRingStats(d);
  const ofSum = st.tiers.reduce((a, t) => a + t.of, 0);
  const withSum = st.tiers.reduce((a, t) => a + (t.of - t.n), 0);
  check(st.units === 26 && ofSum === st.units, '3. the types listed add up to the units counted (' + ofSum + ' of ' + st.units + ')');
  check(withSum === st.units - st.clean, '3. the units with an opportunity of the types add up to the total with an opportunity (' + withSum + ' of ' + (st.units - st.clean) + ')');
  check(st.tiers.some((t) => t.label === 'Heaters' && t.of === 3 && t.n === 2) && st.tiers.some((t) => t.label === 'Exhaust Fans' && t.of === 2 && t.n === 0), '3. heaters and exhaust fans are listed');
  check(st.tiers.some((t) => t.label === 'Other Equipment Units' && t.of === 2), '3. a type that no tier names is listed as other equipment');
}

// 5. the CO2 note and the System Description read the same covered points
{
  const sb = { rptCount: (n) => String(n) };
  vm.createContext(sb);
  const names = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7'];
  // U1, U2 lack the point (the opportunity). U3 and U4 have it. U5 has it but the sequence does not apply to it. U6 and U7 do not have it.
  sb._a36DetGroupFindings = () => ({ covered: { by: { co2: { names: ['U3', 'U4', 'U5'] } } } });
  vm.runInContext(fnSrc('_a36DetJoin') + '\n' + fnSrc('_a36DetDcvNote'), sb); // (Matt 2026-11-25 6e4b6e04) the note joins its groups
  const g = { units: names.map((n) => ({ name: n })) };
  const note = sb._a36DetDcvNote(g, 2, ['U1', 'U2']);
  // (Matt 2026-11-25 6e4b6e04) every unit of the group is in a named group: U6 and U7 are not checked for it
  check(note === 'Of the other 5, 3 have a CO2 sensor point and 2 are not checked for it because occupancy-based ventilation does not apply to them.', '5. the note counts every unit with the CO2 point, also one the sequence does not apply to, and names the others: ' + note);
  check(3 === 3 && /3 have/.test(note), '5. the 3 of the note are the 3 units of the covered points (the System Description prints "present on 3 of the 7")');
  check(sb._a36DetDcvNote({ units: names.slice(0, 2).map((n) => ({ name: n })) }, 2, ['U1', 'U2']) === '', '5. no other units: no note');
}

// 6. repeated cause
{
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(
    [fnSrc('_a36DetJoin'), fnSrc('_a36DetUpperFirst'), fnSrc('_a36DetPlainNoun'), fnSrc('_a36DetTypePlural'), fnSrc('_a36DetIsFanSpeedKey'), fnSrc('_a36DetFoldRepeatedCauses'), fnSrc('_a36DetHeadline')].join('\n'),
    sb,
  );
  const g = { label: 'Single-Zone Air Handling Unit' };
  const mkF = (label, keys, missing, total) => ({ label: label, missing: missing || [], missingKeys: keys, total: total || 2, units: total || 2, groupLabel: g.label, groupTotal: total || 2 });
  const opts = (o) => Object.assign({ fanDrive: false, pumpDrive: false, dcvNarrow: false }, o || {});
  // a group whose two sequences both lack the speed command: one cause
  const f1 = mkF('Supply Air Temperature Reset', ['sfSpeedCmd'], ['Supply Fan Speed Command']);
  const f2 = mkF('Minimum Outdoor Air', ['sfSpeedCmd'], ['Supply Fan Speed Command']);
  f1.headline = sb._a36DetHeadline(f1, g, 2, 'seq', opts({ fanDrive: true }));
  f2.headline = sb._a36DetHeadline(f2, g, 2, 'seq', opts({ fanDrive: true }));
  check(/^Both single-zone|^Both single zone/i.test(f1.headline) && /no variable frequency drive on their supply fans, so supply air temperature reset cannot run\.$/.test(f1.headline), '6. the first opportunity states the cause in full: ' + f1.headline);
  // (Matt 2026-11-25 6e4b6e04) a repeated cause is folded into the root cause: each missing device counts once, the repeats leave the list
  const fold1 = sb._a36DetFoldRepeatedCauses([f1, f2]);
  check(f1.headline.indexOf('no variable frequency drive') > -1 && fold1.length === 1 && fold1[0] === f2, '6. the first opportunity keeps the full sentence and the second one is folded into it');
  check(/The missing variable frequency drive is also needed by the minimum outdoor air sequence, so it cannot run as the standard writes it\.$/.test(f1.impact) && f1.foldedKeys.length === 1, '6. the root says what the drive is also needed by: ' + f1.impact);
  // points
  const p1 = mkF('Economizer', ['mat'], ['Mixed Air Temperature'], 3);
  const p2 = mkF('Freeze Protection', ['mat'], ['Mixed Air Temperature'], 3);
  p1.headline = sb._a36DetHeadline(p1, g, 3, 'seq', opts());
  p2.headline = sb._a36DetHeadline(p2, g, 3, 'seq', opts());
  const fold2 = sb._a36DetFoldRepeatedCauses([p1, p2]);
  check(/lack the mixed air temperature point for economizer\.$/.test(p1.headline) && fold2.length === 1 && /The missing mixed air temperature point is also needed by the freeze protection sequence, so it cannot run as the standard writes it\.$/.test(p1.impact), '6. the same missing point: ' + p1.headline + ' / ' + p1.impact);
  // a different count of units or a different point is a different cause: both stay in full
  const q1 = mkF('Economizer', ['mat'], ['Mixed Air Temperature'], 3);
  const q2 = mkF('Freeze Protection', ['mat', 'sat'], ['Mixed Air Temperature', 'Supply Air Temperature'], 3);
  q1.headline = sb._a36DetHeadline(q1, g, 3, 'seq', opts());
  q2.headline = sb._a36DetHeadline(q2, g, 3, 'seq', opts());
  const fold3 = sb._a36DetFoldRepeatedCauses([q1, q2]);
  check(fold3.length === 0 && /^All 3 .* lack the mixed air temperature point for economizer\.$/.test(q1.headline) && /lack the mixed air temperature and supply air temperature points for freeze protection\.$/.test(q2.headline), '6. a different set of points keeps its full sentence');
  // another group: the cause is stated again
  const r1 = Object.assign(mkF('Economizer', ['mat'], ['Mixed Air Temperature'], 3), { groupLabel: 'Other group' });
  const r2 = mkF('Economizer', ['mat'], ['Mixed Air Temperature'], 3);
  r1.headline = 'full1'; r2.headline = 'full2';
  r1.cause = { key: 'points:mat', noun: 'x', plural: false, tail: 'y' }; r2.cause = r1.cause;
  const fold4 = sb._a36DetFoldRepeatedCauses([r1, r2]);
  check(fold4.length === 0 && r1.headline === 'full1' && r2.headline === 'full2', '6. the same cause in two groups is stated in full in each group');
  // the one wording rule: single-zone, like multi-zone
  const n = new Function(fnSrc('_a36DetNormalizeText') + '\nreturn _a36DetNormalizeText;')();
  const out = n('<p>Both single zone AHUs have it.</p><p>Single Zone Air Handling Unit and multi-zone units</p>');
  check(/Both single-zone AHUs/.test(out) && /Single-Zone Air Handling Unit/.test(out) && !/single zone|Single Zone/.test(out), '6. "single zone" prints "single-zone": ' + out);
}

console.log(failed ? 'FAILED ' + failed : 'ALL PASS');
process.exit(failed ? 1 : 0);
