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
    words = words.concat(rowWords(r, y, s, ox, oy));
    y += 20;
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
  'C noise with several candidate slots stays unassigned, raw label kept',
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
p = synth({ s: 1.05, ox: -60, oy: -38, rows: TWO, totals: { cb: '$2,583.60', tad: '$2,583.60' } });
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
  'E a total with a comma for the point fails the format but is passed raw',
  r.ok && r.totals[0].value.ok === false && r.lines[6] === 'Current Bill $1,851,57',
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
  /BILL_LAYOUT\.readBestPass\(allPassTexts\[pgNum\]\)/.test(ba) &&
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

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
