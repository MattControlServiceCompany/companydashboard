// test-a36-building-page-fit.js - the fit-first rule of the per-building page of the Audit Report (Matt 2026-11-19):
// a table that overflows the page by a few rows is fitted by a smaller photo (not below half of its size); a table that still runs on
// continues with a repeated header and at least 3 rows and the total on the next page. Synthetic data, the real functions of the flow engine.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../app/report-engine.js'), 'utf8');
function slice(a, b) {
  const s = src.indexOf(a);
  const e = src.indexOf(b, s + a.length);
  if (s < 0 || e < 0) throw new Error('not found: ' + a);
  return src.slice(s, e);
}
const sb = {};
vm.createContext(sb);
vm.runInContext(slice('var A36_DET_FIG_MIN_SCALE', '// Words of the listed page text'), sb);
vm.runInContext(slice('var A36_DET_TABLE_GAP_H', 'function _a36DetBody'), sb);
vm.runInContext(slice('function _a36AuditFitHead', 'function _a36AuditBuildingTokens'), sb);
vm.runInContext(slice('var A36_AUDIT_PHOTO_SCALE =', '// The first sentence of a text'), sb);
const pag = vm.runInContext('_a36DetPaginate', sb);
const fit = vm.runInContext('_a36AuditFitHead', sb);
const C = vm.runInContext('({ scale: A36_AUDIT_PHOTO_SCALE, last: A36_AUDIT_MIN_LAST_ROWS })', sb);

let failed = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) failed++;
};

// (Matt 2026-11-19) The photo is never shrunk; the rings are always a row below it; the fit steps are: tight facts, the rings one step smaller.
ok(!/A36_AUDIT_PHOTO_STEP|A36_AUDIT_PHOTO_MIN_FACTOR|A36_AUDIT_PHOTO_SCALE_SMALL/.test(src), 'no photo-shrink constants are left');
ok(/ringsTok\(72, true\)/.test(src) && /ringsTok\(64, true\)/.test(src) && !/ringsTok\((5|4)\d, true\)/.test(src), 'the fit steps use rings 72 and 64 only (no ring below 64); the table rows get tighter first');
ok(!/photoTok = function \(scale, tight, beside\)|mode 'beside'/.test(src), 'the beside layout (rings next to the photo) is gone');

const BUDGET = 900;
// A building page like the real one: band (50), photo and facts (214, full size), rings (150; 130 at the smaller step), table rows (30 each).
function build(nRows) {
  const tokens = [{ type: 'block', html: 'band', estH: 50, keepNext: true }];
  const headAt = tokens.length;
  const photo = { type: 'block', html: 'photo', estH: 214, keepNext: true };
  const rings = (h) => ({ type: 'block', html: 'rings', estH: h, keepNext: true });
  tokens.push(photo);
  tokens.push(rings(150));
  const tbl = { open: '<table>', theadH: 36, title: null, pageChunks: [], first: null };
  const rows = [];
  for (let i = 0; i < nRows; i++) rows.push({ type: 'row', html: i === nRows - 1 ? 'TOTAL' : 'row' + i, estH: 30, tbl });
  tbl.first = rows[0];
  rows.forEach((t, i) => {
    t.keepNext = i < rows.length - 1;
    tokens.push(t);
  });
  const steps = [() => [photo, rings(140)], () => [photo, rings(130)]];
  const fitted = fit(tokens, headAt, 2, steps, BUDGET);
  if (!fitted) {
    rows.forEach((t) => (t.keepNext = false));
    tbl.minLastRows = C.last;
  }
  return { tokens, fitted, tbl, rows, photo };
}
const ringsH = (tokens) => tokens.filter((t) => t.html === 'rings')[0].estH;
const ownRows = (chunk, tbl) => chunk.filter((t) => t.tbl === tbl);

// Costs: band 50 + photo 214 + rings 150 = 414; table = 36 + 10 + 30 * rows. 900 - 414 - 46 = 440 -> 14 rows fit.
let r = build(14);
let chunks = pag(r.tokens, BUDGET);
ok(chunks.length === 1 && r.fitted && ringsH(r.tokens) === 150, 'a table that fits keeps its page and the full rings');

// 16 rows (60 px over): the rings get one step smaller (130 = 20 px less) and the photo stays the same: still 40 over, so it runs on. 15 rows (30 over) fits.
r = build(15);
chunks = pag(r.tokens, BUDGET);
ok(chunks.length === 1 && r.fitted && ringsH(r.tokens) < 150 && r.photo.estH === 214, 'a table 1 row too long is fitted on one page by the smaller rings; the photo is not shrunk (rings ' + ringsH(r.tokens) + ')');

// A table too long for any step (30 rows): it runs on; the last part holds at least 3 rows and the total.
r = build(30);
chunks = pag(r.tokens, BUDGET);
const last = chunks[chunks.length - 1];
ok(!r.fitted && chunks.length === 2, 'a table far too long runs on to a second page (' + chunks.length + ' pages)');
ok(ownRows(last, r.tbl).length >= 4 && ownRows(last, r.tbl).some((t) => t.html === 'TOTAL'), 'the continuation holds at least 3 rows and the total (' + ownRows(last, r.tbl).length + ' rows)');
ok(chunks[0].some((t) => t.html === 'photo') && r.photo.estH === 214, 'the photo stays on the first page, full size');

let worst = 99;
let allThree = true;
for (let n = 20; n <= 40; n++) {
  r = build(n);
  chunks = pag(r.tokens, BUDGET);
  if (chunks.length > 1) {
    const k = ownRows(chunks[chunks.length - 1], r.tbl).length;
    worst = Math.min(worst, k);
    if (k < 4) allThree = false;
  }
}
ok(allThree, 'for 20 to 40 rows, every continuation holds at least 3 rows and the total (smallest: ' + worst + ')');

ok(/_a36AuditFitHead\(tokens, headAt, headEnd - headAt, steps, budget\)/.test(src) && /minLastRows = A36_AUDIT_MIN_LAST_ROWS/.test(src), 'the building page calls the fit rule and sets the minimum rows of the last part');
ok(/var minRows = tbl\.minLastRows \|\| A36_DET_MIN_LAST_ROWS/.test(src), 'the move of rows to the last part honors the minimum of the table');
ok(/_a36AuditBuildingBudget\(\)\)/.test(src) && /var A36_DET_PAGE_SAFETY_H = 12;/.test(src), 'only the building pages get the budget down to the footer wave; the safety margin of other pages is unchanged');
ok(!/RPT_MIN_TEXT_PX\s*=\s*[0-9]/.test(slice('function _a36AuditFitHead', 'function _a36AuditBuildingTokens')), 'the fit rule does not touch the text size');

// (Matt 2026-11-19) every building page shows 3 rings; a score that does not exist is an empty ring with N/A.
const sb3 = { rptCount: (v) => v };
vm.createContext(sb3);
vm.runInContext(slice('function _a36GaugeSVG', '// A finding label in a sentence') .replace(/\/\/ A finding label[\s\S]*$/, ''), sb3);
const rings3 = vm.runInContext('_a36ScoreRingsHtml', sb3);
const html3 = rings3({ composite: 100, pointPct: 100, seqPct: null }, 72, () => 'green', false);
ok((html3.match(/<svg /g) || []).length === 3 && /N\/A/.test(html3) && /Sequence Readiness/.test(html3), 'a missing score is an N/A ring with its label (3 rings)');
ok(rings3({ composite: null, pointPct: null, seqPct: null }, 72, () => 'green', false) === '', 'no score at all: no ring row');

// (Matt 2026-11-19) One bullet for the missing points of the same units; repeated-cause lines are left out; other opportunities stay.
const sb2 = { _a36NeedsStar: (f) => !!f.star };
vm.createContext(sb2);
vm.runInContext(slice('function _a36DetJoin', '// The headline of a finding'), sb2);
vm.runInContext(slice('function _a36DetPlainNoun', '// Opportunities of one group'), sb2);
vm.runInContext(slice('function _a36FirstSentence', '// Utility use of the audit buildings'), sb2);
vm.runInContext(slice('function _a36AuditBulletTexts', '// Fit-first rule of the per-building page'), sb2);
const bul = vm.runInContext('_a36AuditBulletTexts', sb2);
const F = (kind, headline, extra) => Object.assign({ kind, headline }, extra);
const list = [
  F('seq', 'Both multi-zone RTUs lack the return air damper actuator point for economizer.', { missing: ['Return Air Damper Actuator'] }),
  F('seq', 'Both multi-zone RTUs lack the supply fan speed command point for duct static pressure reset.', { missing: ['Supply Fan Speed Command'] }),
  F('seq', 'The missing supply fan speed command point also stops minimum outdoor air.', { missing: ['Supply Fan Speed Command'], repeatCause: true }),
  F('sensor', 'Both multi-zone RTUs have no CO2 sensor.', { label: 'CO2 Sensor (Zone)' }),
  F('seq', 'The duct static pressure setpoints of RTU-1 are held at 1 in. w.c. by a manual override, so the reset does not run.', { missing: [], star: true }),
  F('sensor', '24 of the 25 zone terminal units have no CO2 sensor.', { label: 'CO2 Sensor' }),
];
const outB = bul(list, {});
ok(outB.length === 3, 'seven opportunities of one row become 3 bullets: merged points, the override, the other units (' + outB.length + ')');
ok(/^Both multi-zone RTUs lack the return air damper actuator, supply fan speed command and CO2 sensor points\.$/.test(outB[0].text), 'the points of the same units are one bullet: ' + outB[0].text);
ok(!outB.some((o) => /also stops/.test(o.text)), 'a repeated-cause line is left out');
ok(/manual override/.test(outB[1].text) && outB[1].star, 'an override stays one short bullet (with its mark)');
ok(/^24 of the 25 zone terminal units/.test(outB[2].text), 'units that differ stay a separate bullet: ' + outB[2].text);
ok(bul([list[0]], {})[0].text === list[0].headline, 'a single opportunity keeps its own sentence');
ok(/margin-top:' \+ \(4 - Math\.round\(size \* 0\.28\)\)/.test(src), 'the ring label sits 4 px under its ring');

process.exit(failed ? 1 : 0);
