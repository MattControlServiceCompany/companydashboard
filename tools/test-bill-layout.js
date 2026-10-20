/**
 * test-bill-layout.js
 *
 * Position-based bill reading (computations/bill-layout.js): templates as data, anchors by fuzzy match
 * give scale and offset, the label slot sets the label, the value comes from the amount column, a format
 * regex validates. SYNTHETIC word boxes only (fake school, fake street, fake account ids). The City
 * template is exercised with synthetic pages built from its own reference coordinates, then through the
 * REAL City rule in app/energy-savings.js (vm) to prove the block is the one path for the rows.
 *
 *   A  clean page at another scale and offset: 6 anchors, every slot, every value, the lines
 *   B  "WALER" and "WALLER PROTECTION" sit in the WATER and WATER PROTECTION slots
 *   C  a label that OCR'd to noise between GAS and WATER PROTECTION is FUEL ADJUSTMENT (order rule)
 *   D  two WATER lines and two WATER PROTECTION lines (one per meter) all keep their slot
 *   E  value format: "Aw" is no value (slot kept, amount empty); "-" and "53.42" as two words read "-53.42"
 *   F  two fixed anchors are enough; one is not; a stub "Total Amount Due" at the page top is never the
 *      total; the totals float under the last row and are found there; a lost label is never guessed
 *   G  a rotated page does not match; readBestPass picks the pass with the most valid values
 *   H  the City rule reads the block: Water from the WALER row, Fuel Adjustment a credit, page sum ok,
 *      _readMode 'position'; the fallback marker and no marker give _readMode 'text' with a reason
 *   I  one copy: the crop cells live in the template, every OCR pass keeps its words, the page loads
 *      the engine before the readers
 *   J  box re-read (phase 3): candidate readings, the page-sum proof, a held cell and its marker, the
 *      City rule holding a Gas bill, a dropped noise row, an ambiguous cell, Total Amount Due never
 *      re-read, the two stages, a pen fragment is no label
 *   K  the proof rules: a whole-page sign flip is no proof (credit rows only may be negative), the sum
 *      is exact to the cent (a one-cent error is re-read; a dropped-leading-digit candidate a cent off
 *      is held), one crop zoom scale for every turn of the page, the browser crop site adopts a
 *      replacement worker and builds the turned render once per page
 *
 * Usage: node tools/test-bill-layout.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BL = require(path.join(ROOT, 'computations', 'bill-layout.js'));
const T = BL.CITY_NEW;

let fails = 0;
let passes = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (ok) passes++;
  else fails++;
}
const j = (v) => JSON.stringify(v);

// ── Synthetic page builder (template reference coordinates, then scale s and offset ox/oy) ──
function W(t, x0, y0, x1, y1) {
  return { t, c: 90, x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) };
}
function anchorWords(a, s, ox, oy, text) {
  const parts = (text || a.text).split(' ');
  const [x0, y0, x1, y1] = a.box;
  const gap = 6;
  const each = (x1 - x0 - gap * (parts.length - 1)) / parts.length;
  return parts.map((p, i) =>
    W(p, s * (x0 + i * (each + gap)) + ox, s * y0 + oy, s * (x0 + i * (each + gap) + each) + ox, s * y1 + oy),
  );
}
const COLS = { prev: [591, 680], curr: [752, 842], usage: [937, 997] };
function rowWords(row, y, s, ox, oy) {
  const out = [];
  const y0 = y - 8,
    y1 = y + 8;
  let x = 1022;
  for (const p of (row.label || '').split(' ').filter(Boolean)) {
    const w = p.length * 13;
    out.push(W(p, s * x + ox, s * y0 + oy, s * (x + w) + ox, s * y1 + oy));
    x += w + 6;
  }
  if (row.value != null) {
    const parts = String(row.value).split(' ');
    let xr = 1455;
    for (let i = parts.length - 1; i >= 0; i--) {
      const w = parts[i].length * 10;
      out.push(W(parts[i], s * (xr - w) + ox, s * y0 + oy, s * xr + ox, s * y1 + oy));
      xr -= w + 6;
    }
  }
  for (const k of ['prev', 'curr', 'usage'])
    if (row[k]) out.push(W(row[k], s * COLS[k][0] + ox, s * y0 + oy, s * COLS[k][1] + ox, s * y1 + oy));
  return out;
}
// opts: { s, ox, oy, anchors: {id: true|false|'text'} (default all), rows: [{label, value, prev, curr, usage}],
//         totals: {cb, tad}, extra: [words] }
function synth(opts) {
  const s = opts.s || 1,
    ox = opts.ox || 0,
    oy = opts.oy || 0;
  let words = [];
  const tot = opts.totals || {};
  // Floating anchors sit right under the last row: cbY / tadY (reference centre y) move them.
  const floatY = { currentBill: tot.cbY || 1265, totalDue: tot.tadY || 1301 };
  for (const a of T.anchors) {
    const use = opts.anchors ? opts.anchors[a.id] : true;
    if (!use) continue;
    const box = a.floating ? { ...a, box: [a.box[0], floatY[a.id] - 8, a.box[2], floatY[a.id] + 9] } : a;
    words = words.concat(anchorWords(box, s, ox, oy, typeof use === 'string' ? use : null));
  }
  let y = 1097;
  for (const r of opts.rows || []) {
    if (r) words = words.concat(rowWords(r, y, s, ox, oy)); // null = an empty row (skip one pitch)
    y += T.rowPitch; // printed row pitch (reference px)
  }
  if (tot.cb)
    words.push(
      W(tot.cb, s * 1367 + ox, s * (floatY.currentBill - 10) + oy, s * 1456 + ox, s * (floatY.currentBill + 10) + oy),
    );
  if (tot.tad)
    words.push(
      W(tot.tad, s * 1367 + ox, s * (floatY.totalDue - 10) + oy, s * 1456 + ox, s * (floatY.totalDue + 10) + oy),
    );
  words = words.concat(opts.extra || []);
  return { words, w: Math.round(T.ref.w * s), h: Math.round(T.ref.h * s) };
}
const ROWS = [
  { label: 'WATER', value: '100.00', prev: '4,000', curr: '4,500', usage: '500' },
  { label: 'GAS', value: '821.39', prev: '2,000', curr: '3,000', usage: '1,000.00' },
  { label: 'FUEL ADJUSTMENT', value: '-30.00' },
  { label: 'WATER PROTECTION', value: '1.00' },
  { label: 'SEWER', value: '80.00' },
  { label: 'STORMWATER', value: '4.00' },
];
const TOTALS = { cb: '$976.39', tad: '$976.39' };
const read = (p) => BL.readPageByTemplate(p.words, { w: p.w, h: p.h }, T);
const slots = (r) => r.rows.map((x) => x.slot);
const values = (r) => r.rows.map((x) => x.value.text);

// A. clean page, scale 1.08, offset (25, -30)
let p = synth({ s: 1.08, ox: 25, oy: -30, rows: ROWS, totals: TOTALS });
let r = read(p);
check('A match with 6 anchors', r.ok && r.anchorCount === 6, j(r.reason || r.anchorCount));
check(
  'A scale and offset recovered',
  r.ok && Math.abs(r.fit.s - 1.08) < 0.01 && Math.abs(r.fit.ox - 25) < 4 && Math.abs(r.fit.oy + 30) < 4,
  j(r.fit),
);
check('A slots in print order', r.ok && j(slots(r)) === j(T.slots), j(r.ok && slots(r)));
check(
  'A every value valid',
  r.ok && r.rows.every((x) => x.value.ok) && r.totals.every((t) => t.value.ok),
  j(r.ok && values(r)),
);
check(
  'A lines for the reader',
  r.ok &&
    j(r.lines) ===
      j([
        '4,000 4,500 500 WATER 100.00',
        '2,000 3,000 1,000.00 GAS 821.39',
        'FUEL ADJUSTMENT -30.00',
        'WATER PROTECTION 1.00',
        'SEWER 80.00',
        'STORMWATER 4.00',
        'Current Bill $976.39',
        'Total Amount Due $976.39',
      ]),
  j(r.ok && r.lines),
);

// B. WALER / WALLER PROTECTION / 5T0RMWATFR / G4S labels
p = synth({
  rows: ROWS.map((x) => ({
    ...x,
    label:
      { WATER: 'WALER', 'WATER PROTECTION': 'WALLER PROTECTION', STORMWATER: '5T0RMWATFR', GAS: 'G4S' }[x.label] ||
      x.label,
  })),
  totals: TOTALS,
});
r = read(p);
check(
  'B garbled labels take their slot',
  r.ok && j(slots(r)) === j(T.slots) && r.rows.every((x) => !x.byOrder),
  j(r.ok && r.rows.map((x) => [x.labelRaw, x.slot])),
);
check(
  'B lines carry the canonical label',
  r.ok && r.lines[0] === '4,000 4,500 500 WATER 100.00' && r.lines[3] === 'WATER PROTECTION 1.00',
  j(r.ok && r.lines),
);

// C. a noise label between GAS and WATER PROTECTION is FUEL ADJUSTMENT by order
p = synth({
  rows: ROWS.map((x) => (x.label === 'FUEL ADJUSTMENT' ? { ...x, label: 'kus apustvnt' } : x)),
  totals: TOTALS,
});
r = read(p);
check(
  'C noise label between GAS and WATER PROTECTION is FUEL ADJUSTMENT',
  r.ok && r.rows[2].slot === 'FUEL ADJUSTMENT' && r.rows[2].byOrder === true,
  j(r.ok && r.rows[2]),
);
// Noise between two slots that are not neighbours stays unassigned, its raw label kept
p = synth({ rows: [ROWS[0], { label: 'xyzzy', value: '9.99' }, ROWS[4], ROWS[5]], totals: TOTALS });
r = read(p);
check(
  'C noise with several candidate slots takes the slot at its row pitch (one under WATER is GAS)',
  r.ok && r.rows[1].slot === 'GAS' && r.rows[1].byOrder && r.lines[1] === 'GAS 9.99',
  j(r.ok && r.lines),
);
// the same noise row two pitches under WATER is FUEL ADJUSTMENT; four pitches under (past SEWER) stays unassigned
p = synth({ rows: [ROWS[0], null, { label: 'xyzzy', value: '9.99' }, ROWS[4], ROWS[5]], totals: TOTALS });
r = read(p);
check(
  'C noise two pitches under WATER is FUEL ADJUSTMENT',
  r.ok && r.rows[1].slot === 'FUEL ADJUSTMENT' && r.rows[1].byOrder,
  j(r.ok && slots(r)),
);
p = synth({
  rows: [ROWS[0], null, null, null, { label: 'xyzzy', value: '9.99' }, ROWS[4], ROWS[5]],
  totals: { ...TOTALS, cbY: 1300, tadY: 1336 },
});
r = read(p);
check(
  'C noise whose pitch lands on its lower neighbour (SEWER) stays unassigned, raw label kept',
  r.ok && r.rows[1].slot === null && r.lines[1] === 'xyzzy 9.99',
  j(r.ok && r.lines),
);

// D. two meters: WATER, WATER, GAS, FA, WP, WP, SEWER, STORM
const TWO = [
  { label: 'WATER', value: '1,151.30', prev: '6,743,980', curr: '6,871,100', usage: '127,120' },
  { label: 'WALER', value: '645.32', prev: '6,714,760', curr: '6,787,760', usage: '73,000' },
  { label: 'GAS', value: '77.33', prev: '15,962', curr: '16,029', usage: '68.139' },
  { label: 'FUEL ADJUSTMENT', value: '-3.00' },
  { label: 'WATER PROTECTION', value: '6.40' },
  { label: 'WALLER PROTECTION', value: '6.40' },
  { label: 'SEWER', value: '695.85' },
  { label: 'STORMWATER', value: '4.00' },
];
p = synth({ s: 1.05, ox: -60, oy: -38, rows: TWO, totals: { cb: '$2,583.60', tad: '$2,583.60', cbY: 1330, tadY: 1366 } });
r = read(p);
check(
  'D slots repeat for a second meter',
  r.ok &&
    j(slots(r)) ===
      j(['WATER', 'WATER', 'GAS', 'FUEL ADJUSTMENT', 'WATER PROTECTION', 'WATER PROTECTION', 'SEWER', 'STORMWATER']),
  j(r.ok && slots(r)),
);
check(
  'D the second WATER line keeps its reads and value',
  r.ok && r.lines[1] === '6,714,760 6,787,760 73,000 WATER 645.32',
  j(r.ok && r.lines[1]),
);
check(
  'D totals',
  r.ok && r.lines[8] === 'Current Bill $2,583.60' && r.lines[9] === 'Total Amount Due $2,583.60',
  j(r.ok && r.lines.slice(8)),
);

// E. value format
p = synth({
  rows: ROWS.map((x) =>
    x.label === 'STORMWATER' ? { ...x, value: 'Aw' } : x.label === 'FUEL ADJUSTMENT' ? { ...x, value: '- 53.42' } : x,
  ),
  totals: TOTALS,
});
r = read(p);
check(
  'E "Aw" is not a value: the row keeps its slot with no amount',
  r.ok && r.rows[5].value.ok === false && r.rows[5].value.text === null && r.lines[5] === 'STORMWATER',
  j(r.ok && r.rows[5].value),
);
check(
  'E minus as its own word joins the amount',
  r.ok && r.rows[2].value.ok === true && r.lines[2] === 'FUEL ADJUSTMENT -53.42',
  j(r.ok && r.rows[2].value),
);
p = synth({ rows: ROWS, totals: { cb: '$1,851,57', tad: '$976.39' } });
r = read(p);
check(
  'E a total with a comma for the point fails the format: no value, raw kept for the re-read',
  r.ok && r.totals[0].value.ok === false && r.totals[0].value.text === null && r.totals[0].value.raw === '$1,851,57' && !/Current Bill/.test(r.lines.join('|')),
  j(r.ok && r.totals[0]),
);
check(
  'E money format',
  ['1,151.30', '-3.00', '$2,583.60', '4.00', '77.33-', '-$0.69'].every(
    (v) =>
      BL.readPageByTemplate(
        synth({ rows: [{ label: 'SEWER', value: v }], totals: TOTALS }).words,
        { w: 1520, h: 1970 },
        T,
      ).rows[0].value.ok,
  ),
  '',
);
check(
  'E not money',
  ['Aw', '4,00', '1.851.57', '4032', 'abc'].every(
    (v) =>
      !BL.readPageByTemplate(
        synth({ rows: [{ label: 'SEWER', value: v }], totals: TOTALS }).words,
        { w: 1520, h: 1970 },
        T,
      ).rows[0].value.ok,
  ),
  '',
);

// F. anchors
p = synth({ anchors: { prevBal: true, acctBal: true, currentBill: true, totalDue: true }, rows: ROWS, totals: TOTALS });
r = read(p);
check(
  'F two fixed anchors (close together) still fit, scale from the page size',
  r.ok && Math.abs(r.fit.s - 1) < 0.01 && j(slots(r)) === j(T.slots) && r.lines[6] === 'Current Bill $976.39',
  j(r.ok ? [r.anchorCount, r.fit, r.lines] : r.reason),
);
p = synth({
  anchors: { cai: true, usage: true, currentBill: true, totalDue: true },
  rows: ROWS,
  totals: TOTALS,
  s: 1.1,
  ox: 40,
  oy: 10,
});
r = read(p);
check(
  'F two fixed anchors far apart give the scale',
  r.ok && Math.abs(r.fit.s - 1.1) < 0.01 && r.lines[6] === 'Current Bill $976.39',
  j(r.ok ? r.fit : r.reason),
);
p = synth({ anchors: { cai: true, currentBill: true, totalDue: true }, rows: ROWS, totals: TOTALS });
r = read(p);
check(
  'F one fixed anchor is not a match (floating ones never fit), reason says so',
  !r.ok && /anchors found 1 of 4/.test(r.reason),
  j(r),
);
// A stub "Total Amount Due" near the page top: wrong column and above the rows, so it is never the total.
const stub = [
  W('Total', 1253, 157, 1304, 173),
  W('Amount', 1309, 157, 1389, 173),
  W('Due', 1394, 157, 1433, 173),
  W('$1.00', 1311, 193, 1387, 209),
];
p = synth({
  anchors: { cai: true, prevBal: true, acctBal: true, usage: true, currentBill: true },
  rows: ROWS,
  totals: TOTALS,
  extra: stub,
});
r = read(p);
check(
  'F a stub total at the page top is not the Total Amount Due',
  r.ok && r.totals[1].found === false && r.totals[1].value.text === null && r.lines.length === 7,
  j(r.ok ? r.totals : r.reason),
);
p = synth({ rows: ROWS, totals: TOTALS, extra: stub });
r = read(p);
check(
  'F the stub is ignored when the real total is present',
  r.ok && r.anchorCount === 6 && r.lines[7] === 'Total Amount Due $976.39',
  j(r.ok ? r.lines : r.reason),
);
// A short page: one WATER row, the totals printed right under it (they float), fixed anchors unchanged
p = synth({ s: 0.97, ox: 12, oy: 30, rows: [ROWS[0]], totals: { cb: '$27.56', tad: '$27.56', cbY: 1130, tadY: 1166 } });
r = read(p);
check(
  'F short page: totals found where they moved to, fit from the fixed anchors',
  r.ok &&
    Math.abs(r.fit.s - 0.97) < 0.01 &&
    j(r.lines) === j(['4,000 4,500 500 WATER 100.00', 'Current Bill $27.56', 'Total Amount Due $27.56']),
  j(r.ok ? [r.fit, r.lines] : r.reason),
);
// A lost Current Bill label: no value is guessed from the fit
p = synth({
  anchors: { cai: true, prevBal: true, acctBal: true, usage: true, totalDue: true },
  rows: ROWS,
  totals: TOTALS,
});
r = read(p);
check(
  'F a lost Current Bill label: no Current Bill line (never guessed)',
  r.ok && r.totals[0].found === false && r.totals[0].value.text === null && r.lines.length === 7,
  j(r.ok && r.totals),
);
// A ruled line (no digits) above Current Bill is not a row and does not take the total
p = synth({
  rows: ROWS,
  totals: TOTALS,
  extra: [W('Hn', 1255, 1243, 1309, 1267), W('———————', 1329, 1243, 1461, 1267)],
});
r = read(p);
check(
  'F a ruled line above the totals is ignored',
  r.ok && r.rows.length === 6 && r.lines[6] === 'Current Bill $976.39',
  j(r.ok ? r.lines : r.reason),
);
check('F no words: reason', !BL.readPageByTemplate([], { w: 10, h: 10 }, T).ok, '');

// G. rotation and pass choice
p = synth({ rows: ROWS, totals: TOTALS });
const rotated = {
  words: p.words.map((w) => ({ t: w.t, c: w.c, x0: w.y0, y0: w.x0, x1: w.y1, y1: w.x1 })),
  w: p.h,
  h: p.w,
};
check('G a rotated page does not match', !read(rotated).ok, j(read(rotated)));
const weak = synth({ rows: ROWS.map((x) => ({ ...x, value: 'xx' })), totals: TOTALS });
let best = BL.readBestPass([
  { label: 'rot', score: 9, words: rotated.words, w: rotated.w, h: rotated.h },
  { label: 'weak', score: 8, ...weak },
  { label: 'good', score: 1, ...p },
  { label: 'none', score: 5 },
]);
check(
  'G readBestPass picks the pass with the most valid values',
  best.ok && best.pass.label === 'good',
  j(best.ok && best.pass.label),
);
const oneAnchor = synth({ anchors: { cai: true }, rows: ROWS, totals: TOTALS });
best = BL.readBestPass([
  { label: 'rot', score: 9, ...rotated },
  { label: 'one', score: 2, ...oneAnchor },
  { label: 'none', score: 5 },
]);
check(
  'G no pass matches: one reason per cause',
  !best.ok && /rot city-new: anchors found/.test(best.reason) && /anchors found 1 of 4/.test(best.reason),
  j(best),
);
check('G no passes at all', !BL.readBestPass([]).ok && !BL.readBestPass(null).ok, '');
const block = BL.linesBlock(read(p), '2.5x');
check(
  'G block markers',
  block.indexOf(BL.MARK.start + ' template=city-new pass=2.5x anchors=') === 1 && block.trim().endsWith(BL.MARK.end),
  j(block),
);
check(
  'G fallback marker',
  BL.fallbackMarker('x  y\nz') === '\n' + BL.MARK.fallback + ' x y z\n',
  j(BL.fallbackMarker('x  y\nz')),
);
check(
  'G wordsFromOcr reads v5 words and v7 blocks',
  (() => {
    const v5 = BL.wordsFromOcr({
      data: {
        words: [
          { text: ' GAS ', confidence: 80.4, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
          { text: '  ', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        ],
      },
    });
    const v7 = BL.wordsFromOcr({
      data: {
        blocks: [
          {
            paragraphs: [
              { lines: [{ words: [{ text: 'GAS', confidence: 80, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }] }] },
            ],
          },
        ],
      },
    });
    return (
      j(v5) === j([{ t: 'GAS', c: 80, x0: 1, y0: 2, x1: 3, y1: 4 }]) &&
      j(v7) === j(v5) &&
      BL.wordsFromOcr(null).length === 0
    );
  })(),
  '',
);
check(
  'G debugRecord has no word boxes',
  (() => {
    const d = BL.debugRecord(BL.readBestPass([{ label: '2.5x', score: 1, ...p }]));
    return d.mode === 'position' && d.rows.length === 6 && !JSON.stringify(d).includes('"x0"');
  })(),
  '',
);

// H. the real City rule reads the block
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', lib), 'utf8'), sandbox, { filename: lib });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'energy-savings.js'), 'utf8'), sandbox, {
  filename: 'energy-savings.js',
});
const rule = vm.runInContext("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')", sandbox);
// Synthetic page text as OCR would give it: the WATER label came out "WALER" (the text reader cannot
// read it), the Fuel Adjustment lost its minus. Gas 1000 therms x 0.798062 + 23.33 = 821.39.
const textPage = [
  '%%PAGE_1%%',
  'Customer Account Information - Retain for your records',
  'SD 999 TEST SCHOOL        1 TEST ST        01-9001-00',
  '5/15/2026   6/15/2026   31   6/23/2026   7/13/2026   7/10/2026',
  'Previous Balance: 0.00',
  'Account Balance $0.00',
  '4,000 4,500 500 WALER 100.00',
  '2,000 3,000 1,000.00 GAS 821.39',
  'FUEL ADJUSTMENT 30.00',
  'WATER PROTECTION 1.00',
  'SEWER 80.00',
  'STORMWATER 4.00',
  'Current Bill 976.39',
  'Total Amount Due 976.39',
].join('\n');
const wordPage = synth({
  rows: ROWS.map((x) =>
    x.label === 'WATER' ? { ...x, label: 'WALER' } : x.label === 'FUEL ADJUSTMENT' ? { ...x, value: '30.00' } : x,
  ),
  totals: TOTALS,
});
const by = (bills, c) => (bills || []).find((b) => b.Commodity === c);
let bills = rule.extractAll(textPage);
check(
  'H text reader alone: no Water line, page held',
  !by(bills, 'Water') && bills.some((b) => b._pageTotalMismatch),
  j(bills.map((b) => [b.Commodity, !!b._pageTotalMismatch])),
);
check(
  'H text reader alone: _readMode text with the default reason',
  bills[0]._readMode === 'text' && /no position read/.test(bills[0]._readFallbackReason),
  j([bills[0]._readMode, bills[0]._readFallbackReason]),
);
bills = rule.extractAll(textPage + BL.linesBlock(read(wordPage), '2.5x'));
const water = by(bills, 'Water'),
  gas = by(bills, 'Gas');
check(
  'H with the block: Water read from the WALER row',
  water && water.WaterCharge === 100 && water.WaterUsage === 500,
  j(water && [water.WaterCharge, water.WaterUsage]),
);
check(
  'H with the block: Fuel Adjustment is a credit, Gas line kept',
  gas && gas.FuelAdjustment === -30 && gas.TotalCurrentCharges === '791.39',
  j(gas && [gas.FuelAdjustment, gas.TotalCurrentCharges]),
);
check(
  'H with the block: page lines add up, nothing held',
  !bills.some((b) => b._pageTotalMismatch) && !bills.some((b) => b._manualReview),
  j(bills.map((b) => [b.Commodity, b._gateReasons])),
);
check(
  'H with the block: every bill says position',
  bills.every((b) => b._readMode === 'position' && b._readFallbackReason === null),
  j(bills.map((b) => b._readMode)),
);
check(
  'H the block is not left in the page text',
  !bills.some((b) => b._rawPage && /POSITION_READ/.test(b._rawPage)),
  '',
);
bills = rule.extractAll(textPage + BL.fallbackMarker('city-new: anchors found 1 of 6'));
check(
  'H fallback marker: text mode with the engine reason',
  bills[0]._readMode === 'text' && bills[0]._readFallbackReason === 'city-new: anchors found 1 of 6',
  j([bills[0]._readMode, bills[0]._readFallbackReason]),
);
// A row the position read could not value (raw "Aw") is held by the page sum, never guessed
const awPage = synth({ rows: ROWS.map((x) => (x.label === 'STORMWATER' ? { ...x, value: 'Aw' } : x)), totals: TOTALS });
bills = rule.extractAll(textPage + BL.linesBlock(read(awPage), '2.5x'));
check(
  'H an unreadable value is held by the page sum, not guessed',
  !by(bills, 'Stormwater') && bills.some((b) => b._pageTotalMismatch && b._pageTotalMismatch.diff === -4),
  j(bills.map((b) => [b.Commodity, b._pageTotalMismatch])),
);

// I. one copy of each rule
const ba = fs.readFileSync(path.join(ROOT, 'app', 'bill-analysis.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'app', 'energy-savings.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'energy-department.html'), 'utf8');
const pushes = (ba.match(/allPassTexts\[pgNum\]\.push\(/g) || []).length;
const withWords = (ba.match(/words: BILL_LAYOUT\.wordsFromOcr\(/g) || []).length;
check('I every OCR pass keeps its word boxes', pushes >= 6 && pushes === withWords, j([pushes, withWords]));
check(
  'I the crop cells live in the template only',
  !/x: 0\.855/.test(ba) && /BILL_LAYOUT\.CITY_NEW\.cropCells/.test(ba) && T.cropCells.length === 3,
  '',
);
check(
  'I bill-analysis appends the block, energy-savings reads it',
  /BILL_LAYOUT\.readPage\(allPassTexts\[pgNum\], _rereadBox\)/.test(ba) &&
    es.includes(BL.MARK.start) &&
    es.includes(BL.MARK.fallback),
  '',
);
check(
  'I the page loads the engine before the readers',
  html.indexOf('computations/bill-layout.js') > 0 &&
    html.indexOf('computations/bill-layout.js') < html.indexOf('app/energy-savings.js'),
  '',
);
check(
  'I template slots and totals are the printed labels',
  j(T.slots) === j(['WATER', 'GAS', 'FUEL ADJUSTMENT', 'WATER PROTECTION', 'SEWER', 'STORMWATER']) &&
    T.totals.length === 2,
  '',
);

// J. box re-read (phase 3): candidates, the page-sum proof, holds, the absent row, the two stages
const readPage = (p, ocrBox) => BL.readPage([{ label: '2.5x', score: 1, ...p }], ocrBox);
const C = (txt) => BL.candidatesFromText(txt);
check(
  'J candidates: a lost "$" read as a digit, a lost point, a lost sign, pen digits beside the amount',
  C('(83,572.97').includes(3572.97) &&
    C('82756').includes(27.56) &&
    C('9399 -53.42').includes(-53.42) &&
    C('24337').includes(24.33) &&
    C('0.17').includes(-0.17) &&
    C('2333').includes(23.33) &&
    !C('Aw').length,
  j([C('(83,572.97'), C('82756'), C('24337')]),
);
// every ocrBox call is recorded; the reading per box label comes from `answers`
const fakeOcr = (answers, calls) => (box, cfg) => {
  const hit = Object.keys(answers).find((label) => Math.abs(box.y0 + (box.y1 - box.y0) / 2 - answers[label].y) < 6);
  if (calls) calls.push(hit || '?');
  return Promise.resolve(hit ? answers[hit].text : '');
};
// row centre y of slot n on the synthetic page (reference px) and the totals
const rowY = (n) => 1097 + T.rowPitch * n;
const CB_Y = 1265;
(async () => {
  // J2 "Aw" for 4.00: only the STORMWATER cell is re-read (stage 1), 4.00 makes the page add up
  let calls = [];
  let res = await readPage(
    synth({ rows: ROWS.map((x) => (x.label === 'STORMWATER' ? { ...x, value: 'Aw' } : x)), totals: TOTALS }),
    fakeOcr({ STORM: { y: rowY(5), text: '4.00' } }, calls),
  );
  check(
    'J "Aw" cell re-read: 4.00 proved by the page sum, only that cell was read',
    res.ok && res.read.rows[5].value.text === '4.00' && res.read.rows[5].value.reread && res.read.lines[5] === 'STORMWATER 4.00' && calls.every((c) => c === 'STORM') && calls.length === BL.REREAD_CONFIGS.length,
    j([res.ok && res.read.lines, calls]),
  );
  check('J the re-read is recorded', res.ok && res.read.rereads.length === 1 && res.read.rereads[0].label === 'STORMWATER' && res.read.rereads[0].chosen === '4.00', j(res.ok && res.read.rereads));
  // J3 every cell valid, Fuel Adjustment lost its minus: all cells re-read, the one change that adds up
  calls = [];
  res = await readPage(
    synth({ rows: ROWS.map((x) => (x.label === 'FUEL ADJUSTMENT' ? { ...x, value: '30.00' } : x)), totals: TOTALS }),
    fakeOcr({ FA: { y: rowY(2), text: '-30.00' }, W: { y: rowY(0), text: '100.00' }, G: { y: rowY(1), text: '821.39' }, WP: { y: rowY(3), text: '1.00' }, S: { y: rowY(4), text: '80.00' }, ST: { y: rowY(5), text: '4.00' }, CB: { y: CB_Y, text: '$976.39' } }, calls),
  );
  check(
    'J a lost minus on a valid-looking page: the sum fails, the re-read proves -30.00',
    res.ok && res.read.lines[2] === 'FUEL ADJUSTMENT -30.00' && res.read.rereads.length === 1,
    j(res.ok && [res.read.lines, res.read.rereads]),
  );
  // J4 a cell nothing can read: held with the reason, no value, the held marker before the block
  res = await readPage(synth({ rows: ROWS.map((x) => (x.label === 'GAS' ? { ...x, value: '8Z1,39' } : x)), totals: TOTALS }), fakeOcr({}));
  check(
    'J an unreadable cell is held with the reason (row, what was read)',
    res.ok && res.read.rows[1].value.text === null && /GAS box read "8Z1,39"/.test(res.read.rows[1].value.held) && res.read.held.length === 1 && res.read.lines[1] === '2,000 3,000 1,000.00 GAS',
    j(res.ok && res.read.held),
  );
  const blk = res.ok && BL.linesBlock(res.read, '2.5x');
  check('J the held marker sits before the block, never inside the rows', blk && blk.indexOf(BL.MARK.held + ' GAS:: ') < blk.indexOf(BL.MARK.start) && !blk.slice(blk.indexOf(BL.MARK.start)).includes('HELD'), blk);
  let bills = rule.extractAll(textPage.replace('GAS 821.39', 'GAS 8Z1,39') + blk);
  const gasHeld = by(bills, 'Gas');
  check(
    'J the City rule holds the Gas bill with the engine reason and never reconciles it from Current Bill',
    gasHeld && gasHeld.GasCharge == null && gasHeld._manualReview && /GAS box read/.test((gasHeld._gateReasons || []).join(' ')) && !gasHeld._auto_corrected_GasCharge,
    j(gasHeld && [gasHeld.GasCharge, gasHeld._gateReasons]),
  );
  // J5 a noise label with no value between GAS and WATER PROTECTION is not a Fuel Adjustment when the
  // page adds up without it: the row is dropped
  const NOFA = [ROWS[0], { ...ROWS[1], value: '791.39' }, { label: 'xyzzy' }, ROWS[3], ROWS[4], ROWS[5]]; // 100 + 791.39 + 1 + 80 + 4 = 976.39
  res = await readPage(synth({ rows: NOFA, totals: TOTALS }), fakeOcr({}));
  check(
    'J a noise row with no value is dropped when the page adds up without it',
    res.ok && res.read.rows[2].absent === true && !res.read.lines.some((l) => /FUEL/.test(l)) && res.read.held.length === 0,
    j(res.ok && [res.read.lines, res.read.held]),
  );
  // J6 two digit words in one cell ("3237" pen digits, "3.90" printed): ambiguous, the page's own 3.90 proves
  res = await readPage(synth({ rows: ROWS.map((x) => (x.label === 'WATER PROTECTION' ? { ...x, value: '3237 1.00' } : x)), totals: TOTALS }), fakeOcr({}));
  check(
    'J pen digits left of the printed amount: the cell is ambiguous, the rightmost reading proves',
    res.ok && res.read.rows[3].value.text === '1.00' && res.read.rows[3].value.reread,
    j(res.ok && res.read.rows[3].value),
  );
  // J7 Total Amount Due is never re-read (no sum proof): a failed read stays empty
  calls = [];
  res = await readPage(synth({ rows: ROWS, totals: { cb: '$976.39', tad: '$976,39' } }), fakeOcr({}, calls));
  check('J Total Amount Due is never re-read', res.ok && res.read.totals[1].value.text === null && calls.length === 0, j(res.ok && [res.read.totals[1], calls]));
  // J8 two stages: a failing Fuel Adjustment beside a valid-looking but wrong Current Bill
  calls = [];
  res = await readPage(
    synth({ rows: ROWS.map((x) => (x.label === 'FUEL ADJUSTMENT' ? { ...x, value: '3000' } : x)), totals: { cb: '$1,976.39', tad: '$976.39' } }),
    fakeOcr({ FA: { y: rowY(2), text: '30.00' }, W: { y: rowY(0), text: '100.00' }, G: { y: rowY(1), text: '821.39' }, WP: { y: rowY(3), text: '1.00' }, S: { y: rowY(4), text: '80.00' }, ST: { y: rowY(5), text: '4.00' }, CB: { y: CB_Y, text: '$976.39' } }, calls),
  );
  check(
    'J stage 2 re-reads the valid cells when the failing cells alone cannot add up: Current Bill corrected',
    res.ok && res.read.lines[2] === 'FUEL ADJUSTMENT -30.00' && res.read.lines[6] === 'Current Bill 976.39' && calls.slice(0, 3).every((c) => c === 'FA') && calls.length > 3,
    j(res.ok && [res.read.lines, calls]),
  );
  // J9 a pen-line fragment in the label column is not a label
  const frag = synth({ rows: ROWS, totals: TOTALS, extra: [W('Co', 1195, 1150, 1246, 1152)] });
  check('J a 2 px word in the label column opens no row', read(frag).rows.length === 6, j(read(frag).rows.map((r) => r.labelRaw)));

  // K. the proof rules (2026-10-19 review fuzz: 20000 pages, two patterns the old solver wrote wrong)
  // K1 whole-page sign flip: every cell but the Fuel Adjustment is unreadable on the page, the Fuel
  // Adjustment lost its minus (valid "30.00"). The re-reads give the digits; the set of negated rows with
  // the +30.00 adds up to a negated Current Bill with ZERO changes to a valid cell, so the old solver took
  // it. A negative charge outside the credit rows is no proof: the one holding set is -30.00 with every
  // other row positive.
  const LETTERS = { WATER: 'lOO.OO', GAS: 'BZl.3g', 'WATER PROTECTION': 'l.OO', SEWER: 'BO.OO', STORMWATER: 'A.OO' };
  calls = [];
  res = await readPage(
    synth({ rows: ROWS.map((x) => ({ ...x, value: x.label === 'FUEL ADJUSTMENT' ? '30.00' : LETTERS[x.label] })), totals: { cb: '$g76.3g', tad: '$976.39' } }),
    fakeOcr({ W: { y: rowY(0), text: '100.00' }, G: { y: rowY(1), text: '821.39' }, FA: { y: rowY(2), text: '30.00' }, WP: { y: rowY(3), text: '1.00' }, S: { y: rowY(4), text: '80.00' }, ST: { y: rowY(5), text: '4.00' }, CB: { y: CB_Y, text: '976.39' } }, calls),
  );
  check(
    'K a whole-page sign flip is never a proof: the rows are positive, the Fuel Adjustment -30.00, Current Bill 976.39',
    res.ok &&
      j(res.read.lines) ===
        j(['4,000 4,500 500 WATER 100.00', '2,000 3,000 1,000.00 GAS 821.39', 'FUEL ADJUSTMENT -30.00', 'WATER PROTECTION 1.00', 'SEWER 80.00', 'STORMWATER 4.00', 'Current Bill 976.39', 'Total Amount Due $976.39']) &&
      res.read.held.length === 0,
    j(res.ok && [res.read.lines, res.read.held]),
  );
  check(
    'K the sum rule names the credit rows; a negative WATER or a negative Current Bill fails the sum',
    j(T.sumRule.creditRows) === j(['FUEL ADJUSTMENT']) &&
      T.sumRule.tolerance === undefined &&
      (() => {
        const rd = read(synth({ rows: ROWS, totals: TOTALS }));
        const neg = { rows: { 0: -100 }, totals: {} };
        const negTotal = { rows: {}, totals: { 0: -976.39 } };
        const fa = { rows: { 2: -30 }, totals: {} };
        return (
          BL.pageSum(rd, T, neg).negative === 'WATER' &&
          !BL.sumHolds(BL.pageSum(rd, T, neg)) &&
          BL.pageSum(rd, T, negTotal).negative === 'Current Bill' &&
          BL.pageSum(rd, T, fa).negative === null &&
          BL.sumHolds(BL.pageSum(rd, T, fa))
        );
      })(),
    j([T.sumRule, BL.pageSum(read(synth({ rows: ROWS, totals: TOTALS })), T)]),
  );
  // K2 the sum is exact to the cent: SEWER read "80.01" for a printed 80.00 (every cell valid) is a failed
  // sum (the old 0.01 tolerance passed it and the page kept the wrong cent); every cell is re-read and the
  // one change that adds up is 80.00
  calls = [];
  res = await readPage(
    synth({ rows: ROWS.map((x) => (x.label === 'SEWER' ? { ...x, value: '80.01' } : x)), totals: TOTALS }),
    fakeOcr({ W: { y: rowY(0), text: '100.00' }, G: { y: rowY(1), text: '821.39' }, FA: { y: rowY(2), text: '-30.00' }, WP: { y: rowY(3), text: '1.00' }, S: { y: rowY(4), text: '80.00' }, ST: { y: rowY(5), text: '4.00' }, CB: { y: CB_Y, text: '$976.39' } }, calls),
  );
  check(
    'K a one-cent digit error fails the sum: the cell is re-read and corrected',
    res.ok && res.read.lines[4] === 'SEWER 80.00' && res.read.rereads.length === 1 && res.read.rereads[0].label === 'SEWER' && calls.length === 7 * BL.REREAD_CONFIGS.length,
    j(res.ok && [res.read.lines, res.read.rereads, calls.length]),
  );
  check('K the page sum is integer cents, zero on a page that adds up', (() => {
    const s = BL.pageSum(read(synth({ rows: ROWS, totals: TOTALS })), T);
    return s.known && s.diffCents === 0 && Number.isInteger(BL.pageSum(read(synth({ rows: ROWS.map((x) => (x.label === 'SEWER' ? { ...x, value: '80.01' } : x)), totals: TOTALS })), T).diffCents);
  })(), '');
  // K3 a dropped leading digit absorbing a cent error: GAS unreadable on the page, the re-read "5821.38"
  // (a "$" read as 5 and a cent off). The dropped-digit candidate 821.38 is one cent from the proof; the
  // old tolerance wrote it. Now no reading adds up and the Gas cell is held.
  res = await readPage(
    synth({ rows: ROWS.map((x) => (x.label === 'GAS' ? { ...x, value: '8Z1,39' } : x)), totals: TOTALS }),
    fakeOcr({ W: { y: rowY(0), text: '100.00' }, G: { y: rowY(1), text: '5821.38' }, FA: { y: rowY(2), text: '-30.00' }, WP: { y: rowY(3), text: '1.00' }, S: { y: rowY(4), text: '80.00' }, ST: { y: rowY(5), text: '4.00' }, CB: { y: CB_Y, text: '$976.39' } }),
  );
  check(
    'K a dropped-leading-digit candidate one cent off is no proof: Gas held, never 821.38',
    res.ok && res.read.rows[1].value.text === null && /GAS box read "8Z1,39"/.test(res.read.rows[1].value.held) && res.read.held.length === 1 && !res.read.lines.some((l) => /821\.38/.test(l)),
    j(res.ok && [res.read.lines, res.read.held]),
  );
  // K4 the crop zoom for every turn of the page: the render is LBG_CROP_ZOOM (12x) of a letter page, the
  // pass 2.5x (1520 x 1970); a 90/270 pass is 1970 x 1520 and its render is turned the same way. The
  // scale that brings the crop to the engine zoom is the same for every turn (the 180 case used the render
  // height before: a wrong zoom).
  check(
    'K rereadCrop: one zoom scale for 0, 90, 180 and 270',
    (() => {
      const hi = { width: 1520 * 4.8, height: 1970 * 4.8 }; // 12x / 2.5x
      const turned = { width: hi.height, height: hi.width };
      const up = { w: 1520, h: 1970 },
        side = { w: 1970, h: 1520 };
      const box = { x0: 1367, y0: 1255, x1: 1456, y1: 1275 };
      const sideBox = { x0: 1255, y0: 64, x1: 1275, y1: 153 };
      const c0 = BL.rereadCrop(box, up, hi, 4),
        c180 = BL.rereadCrop(box, up, hi, 4),
        c90 = BL.rereadCrop(sideBox, side, turned, 4),
        c270 = BL.rereadCrop(sideBox, side, turned, 4);
      const near = (a, b) => Math.abs(a - b) < 1e-9;
      return (
        [c0, c90, c180, c270].every((c) => near(c.scale, 4 / 4.8)) &&
        near(c0.x, 1367 / 1520) && near(c0.y, 1255 / 1970) && near(c0.w, 89 / 1520) && near(c0.h, 20 / 1970) &&
        near(c90.x, 1255 / 1970) && near(c90.y, 64 / 1520) && near(c90.w, 20 / 1970) && near(c90.h, 89 / 1520) &&
        !near(hi.height / up.w, 4.8) && // the old 180 formula
        near(BL.rereadCrop(box, up, hi, 2).scale, 2 / 4.8)
      );
    })(),
    '',
  );
  // K5 the browser crop site: one oriented render per page, the geometry from rereadCrop, a timeout's
  // replacement worker adopted (as every other recognize site does)
  const rb = ba.slice(ba.indexOf('const _rereadBox = async'), ba.indexOf('BILL_LAYOUT.readPage(allPassTexts[pgNum], _rereadBox)'));
  check(
    'K _rereadBox adopts err._replacementWorker, uses rereadCrop, never the render height',
    /_replacementWorker\) workerBox\.current = rereadErr\._replacementWorker/.test(rb) && /BILL_LAYOUT\.rereadCrop\(box, pass, _oriented, cfg\.zoom\)/.test(rb) && !/_hi\.height \/ pass\.w/.test(ba),
    '',
  );
  check(
    'K the oriented 12x render is built once per page and released after the read',
    /if \(_orientedRender\) return _orientedRender\.canvas;/.test(ba) && !/rotateCanvas90\(_hi\)/.test(rb) && /_posRes = await BILL_LAYOUT\.readPage\(allPassTexts\[pgNum\], _rereadBox\);\s*\} finally \{\s*_releaseOriented\(\);/.test(ba),
    '',
  );

  // L. Utility E Billing Details page (template UTILITY_E_BD, rowMode 'list'), on the committed synthetic
  //    pages of tools/synthetic-pages/bill-ground-truth-synthetic.json (provider 'utility-e'): kinds by the
  //    band start, two-line labels, the two identities, lost total labels found by structure, a held
  //    Current Charges, the group re-read, no match on the summary page, and the real Utility E rule
  //    reading the block (TotalCurrentCharges only from the printed box).
  const E = BL.UTILITY_E_BD;
  const efix = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'synthetic-pages', 'bill-ground-truth-synthetic.json'), 'utf8'));
  const ePage = (id) => efix.pages.find((p) => p.id === id);
  const eRead = (id) => {
    const p = ePage(id);
    return BL.readPageByTemplate(p.words, { w: p.w, h: p.h }, E);
  };
  const canned = (pg) => (box, cfg) => {
    const k = [cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all', box.x0, box.y0, box.x1, box.y1].join('|');
    return Promise.resolve(pg.rereads[k] != null ? pg.rereads[k] : '');
  };
  const e1 = eRead('E1-clean');
  check('L E1 the template matches the clean page with every anchor', e1.ok && e1.anchorCount === 10, j(e1.ok ? e1.anchorCount : e1.reason));
  check(
    'L E1 eleven rows in print order, every kind set, every value valid',
    e1.ok &&
      e1.rows.length === 11 &&
      e1.rows.map((r) => r.slot).join(',') ===
        'CustomerCharge,FacilitiesCharge,BilledKWCharge,EnergyOnPeakCharge,EnergyOffPeakCharge,TaxExemptDelivery,ECACharge,EERCharge,PTSCharge,TDCCharge,BillOffset' &&
      e1.rows.every((r) => r.value.ok),
    e1.ok ? j(e1.rows.map((r) => [r.slot, r.value.text])) : '',
  );
  check(
    'L E1 a two-line label is one row with its amount on the second line; the line keeps the "$"',
    e1.ok && e1.lines[3] === 'Energy Chg On Pk Sum 1,000.0000 kWh at $0.10000 per kWh $100.00' && e1.lines[10] === 'Bill offset -$200.00',
    e1.ok ? j(e1.lines) : '',
  );
  check(
    'L E1 both identities hold (rows = Subtotal; Subtotal + below = Current Charges) and the totals lines',
    e1.ok &&
      BL.sumHolds(BL.pageSum(e1, E, null, 'rows')) &&
      BL.sumHolds(BL.pageSum(e1, E, null, 'below')) &&
      e1.lines.slice(-2).join('|') === 'Subtotal $1,127.90|Current Charges $1,127.90',
    e1.ok ? j(e1.lines.slice(-2)) : '',
  );
  const e2 = eRead('E2-customer-garbled');
  check(
    'L E2 "CUSIOMET CRG" at the first row is Customer Chg by its slot; "$48}" is no value',
    e2.ok && e2.rows[0].slot === 'CustomerCharge' && e2.rows[0].labelText === 'Customer Chg' && !e2.rows[0].value.ok && e2.rows[0].value.raw === '$48}',
    e2.ok ? j(e2.rows[0]) : '',
  );
  await BL.rereadBoxes(e2, E, canned(ePage('E2-customer-garbled')));
  check(
    'L E2 the re-read "$48.90" is proved by the Subtotal and the line carries it',
    e2.rows[0].value.text === '48.90' && e2.rows[0].value.reread === true && e2.lines[0] === 'Customer Chg $48.90' && e2.held.length === 0,
    j([e2.rows[0].value, e2.lines[0], e2.held]),
  );
  const e3 = eRead('E3-cc-label-lost');
  // without the Current Charges label the band runs to the meter table header: its "Meter" word (the line
  // above "Multiplier") opens a kind-less, value-less row that the re-read drops as ABSENT
  await BL.rereadBoxes(e3, E, canned(ePage('E3-cc-label-lost')));
  check(
    'L E3 a lost Current Charges label: the label-less amount equal to Subtotal + Franchise Fee is the total, by structure; the meter header word is no row',
    e3.ok &&
      e3.totals[1].found &&
      e3.totals[1].byStructure === true &&
      e3.totals[1].value.text === '$1,184.35' &&
      e3.rows.filter((r) => r.below && !r.absent).length === 1 &&
      e3.rows.find((r) => r.below && !r.absent).slot === 'FranchiseFee' &&
      e3.rows.some((r) => r.absent && r.labelText === 'Meter') &&
      e3.held.length === 0 &&
      BL.sumHolds(BL.pageSum(e3, E, null, 'below')),
    e3.ok ? j([e3.totals, e3.rows.map((r) => [r.slot, r.below, r.absent, r.labelText]), e3.held]) : '',
  );
  const e4 = eRead('E4-cc-unreadable');
  await BL.rereadBoxes(e4, E, canned(ePage('E4-cc-unreadable')));
  const e4block = BL.linesBlock(e4, '2.5x');
  check(
    'L E4 an unreadable Current Charges box is HELD with the reason; the rows stay proved; the block names the hold before the rows and prints no total',
    e4.held.length === 1 &&
      e4.held[0].label === 'Current Charges' &&
      !e4.totals[1].value.ok &&
      e4.rows.every((r) => r.value.ok) &&
      /^\n%%POSITION_HELD%% Current Charges:: /.test(e4block) &&
      !/Current Charges \$/.test(e4block),
    j([e4.held, e4.totals[1].value]),
  );
  const e5 = eRead('E5-subtotal-label-garbled');
  check(
    'L E5 a Subtotal label OCR\'d "SUBLOLEL": the amount equal to the sum of the rows is the Subtotal, by structure',
    e5.ok && e5.totals[0].found && e5.totals[0].byStructure === true && e5.totals[0].value.text === '$1,127.90' && e5.rows.length === 11,
    e5.ok ? j(e5.totals[0]) : '',
  );
  const e6 = eRead('E6-sign-reread');
  check('L E6 "$120.00-" fails the page format (a sign after the figure is not printed)', e6.ok && !e6.rows[6].value.ok, e6.ok ? j(e6.rows[6].value) : '');
  await BL.rereadBoxes(e6, E, canned(ePage('E6-sign-reread')));
  check(
    'L E6 the group re-read proves ECA $120.00 and Bill offset -$200.00 (two changes)',
    e6.rows[6].value.text === '120.00' && e6.rows[10].value.text === '-200.00' && e6.held.length === 0 && BL.sumHolds(BL.pageSum(e6, E, null, 'rows')),
    j([e6.rows[6].value, e6.rows[10].value, e6.held]),
  );
  const e8 = BL.readPageByTemplate(ePage('E8-summary-page-no-match').words, { w: E.ref.w, h: E.ref.h }, E);
  check('L E8 the summary page (no Billing Details header) is not this template', !e8.ok && /Billing Details/.test(e8.reason), j(e8));
  const wsOf = (s) => s.split(' ').map((t, i) => ({ t, x0: i * 60, x1: i * 60 + 50, y0: 0, y1: 18 }));
  check(
    'L kinds: "ECR Chg" as close to ECA and EER is no kind; "Chg On Pk Sum" is Energy Chg On Pk (first word lost); "Chg" alone names nothing; "CUSIOMET CRG" is Customer Chg',
    BL.kindOfBand(wsOf('ECR Chg 06-01-2026 for'), E.kinds) === null &&
      BL.kindOfBand(wsOf('Chg On Pk Sum 14.6736 kWh at'), E.kinds).kind.field === 'EnergyOnPeakCharge' &&
      BL.kindOfBand(wsOf('Chg 36.1680 kW at'), E.kinds) === null &&
      BL.kindOfBand(wsOf('CUSIOMET CRG ........'), E.kinds).kind.field === 'CustomerCharge',
    '',
  );
  // the Utility E rule sums its charges through computations/rates.js (loaded before the readers on the page)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'computations', 'rates.js'), 'utf8'), sandbox, { filename: 'rates.js' });
  const utilityERule = vm.runInContext('UTILITY_RULES[0]', sandbox); // the electric utility rule (the first rule)
  const e4b = utilityERule.extractAll('%%PAGE_1%%\n' + ePage('E4-cc-unreadable').text + e4block)[0];
  check(
    'L the Utility E rule in position mode: TotalCurrentCharges null and held with the engine reason, never the Subtotal; _subtotal and the rows read',
    e4b &&
      e4b._readMode === 'position' &&
      e4b.TotalCurrentCharges == null &&
      /Current Charges/.test(e4b._manualReviewLabel || '') &&
      e4b._subtotal === '1127.90' &&
      e4b.CustomerCharge === '48.90' &&
      e4b.BillOffset === '-200.00' &&
      e4b.ECACharge === '120.00',
    e4b ? j([e4b._readMode, e4b.TotalCurrentCharges, e4b._manualReviewLabel, e4b._subtotal, e4b.CustomerCharge, e4b.BillOffset, e4b.ECACharge]) : 'no bill',
  );
  const e1b = utilityERule.extractAll('%%PAGE_1%%\n' + ePage('E1-clean').text + BL.linesBlock(e1, '2.5x'))[0];
  check(
    'L the Utility E rule in position mode reads every charge, Subtotal and Current Charges from the block',
    e1b &&
      e1b._readMode === 'position' &&
      e1b.TotalCurrentCharges === '1127.90' &&
      e1b.EnergyOnPeakCharge === '100.00' &&
      e1b.TDCCharge === '100.00' &&
      e1b.TaxExemptDelivery === '200.00' &&
      !e1b._manualReview,
    e1b ? j([e1b._readMode, e1b.TotalCurrentCharges, e1b.EnergyOnPeakCharge, e1b.TDCCharge, e1b._manualReviewLabel]) : 'no bill',
  );
  const e1t = utilityERule.extractAll('%%PAGE_1%%\n' + ePage('E1-clean').text + BL.fallbackMarker('utility-e-bd: "Billing Details" not found on the page'))[0];
  check(
    'L without a block the Utility E rule reads the text and keeps the fallback reason',
    e1t && e1t._readMode === 'text' && /Billing Details/.test(e1t._readFallbackReason) && e1t.TotalCurrentCharges === '1127.90',
    e1t ? j([e1t._readMode, e1t._readFallbackReason, e1t.TotalCurrentCharges]) : 'no bill',
  );

  // M the position holds are re-checked against the FINAL values (2026-10-20): a Customer Chg the engine held ("$48}",
  // no re-read proved) and filled later by the sum gap, with the printed Current Charges and the lines below the
  // Subtotal adding up to the cent, drops the hold; the Subtotal "not read" hold goes with it. A hold on a field
  // that stays empty stays.
  const heldBlock = (omitSubtotal) =>
    ['%%POSITION_HELD%% CustomerCharge:: CustomerCharge box read "$48}" on the page and "", "" in the re-read; no reading makes the page lines add up to the printed Subtotal']
      .concat(omitSubtotal ? ['%%POSITION_HELD%% Subtotal:: no "Subtotal" box was found on the page (its label was not read)'] : [])
      .join('\n') + '\n';
  const stripLines = (blk, re) => blk.split('\n').filter((l) => !re.test(l)).join('\n');
  const e2lines = BL.linesBlock(e2, '2.5x');
  const mkHeld = (omitSubtotal, dropField) => {
    let body = stripLines(e2lines, /^Customer Chg /);
    if (omitSubtotal) body = stripLines(body, /^Subtotal /);
    if (dropField) body = stripLines(body, new RegExp('^' + dropField));
    return heldBlock(omitSubtotal) + body;
  };
  const m1 = utilityERule.extractAll('%%PAGE_1%%\n' + ePage('E2-customer-garbled').text + mkHeld(true, null))[0];
  check(
    'M the final values resolve the holds: Customer Chg filled by the sum gap ($48.90), lines + printed total agree to the cent, no hold left',
    m1 && m1._readMode === 'position' && m1.CustomerCharge === '48.90' && m1.TotalCurrentCharges === '1127.90' && !m1._manualReview && !m1._gateReasons && !m1._positionHeld,
    m1 ? j([m1.CustomerCharge, m1.TotalCurrentCharges, m1._manualReview, m1._gateReasons, m1._positionHeld]) : 'no bill',
  );
  const m2 = utilityERule.extractAll('%%PAGE_1%%\n' + ePage('E2-customer-garbled').text + mkHeld(true, 'ECA Chg 06'))[0];
  check(
    'M two cells missing: the sum gap fills no field, both holds stay, the bill stays held',
    m2 && m2._manualReview === true && Array.isArray(m2._positionHeld) && m2._positionHeld.length === 2 && m2.CustomerCharge == null,
    m2 ? j([m2.CustomerCharge, m2._manualReview, m2._positionHeld]) : 'no bill',
  );

  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
})();
