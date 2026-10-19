#!/usr/bin/env node
/**
 * make-bill-ground-truth-synthetic.js — writes bill-ground-truth-synthetic.json, the committed SYNTHETIC
 * pages of tools/gate-bill-ground-truth.js. Fake school, fake street, fake account; word boxes built from
 * the City template's own reference coordinates (computations/bill-layout.js CITY_NEW), as in
 * tools/test-bill-layout.js. The re-read readings are canned per value cell (key = the gate's cache key
 * for the cell box and config), so the gate runs with no OCR engine. Re-run after a template change:
 *   node tools/synthetic-pages/make-bill-ground-truth-synthetic.js
 */
const fs = require('fs');
const path = require('path');
const BL = require(path.join(__dirname, '..', '..', 'computations', 'bill-layout.js'));
const T = BL.CITY_NEW;

function W(t, x0, y0, x1, y1) {
  return { t, c: 90, x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) };
}
function anchorWords(a, text) {
  const parts = (text || a.text).split(' ');
  const [x0, y0, x1, y1] = a.box;
  const gap = 6;
  const each = (x1 - x0 - gap * (parts.length - 1)) / parts.length;
  return parts.map((p, i) => W(p, x0 + i * (each + gap), y0, x0 + i * (each + gap) + each, y1));
}
const COLS = { prev: [591, 680], curr: [752, 842], usage: [937, 997] };
// row: { label, value, prev, curr, usage, tall } — tall: the label box spans this many row pitches
function rowWords(row, y) {
  const out = [];
  const y0 = y - 8,
    y1 = y + 8 + (row.tall ? (row.tall - 1) * T.rowPitch : 0);
  let x = 1022;
  for (const p of (row.label || '').split(' ').filter(Boolean)) {
    const w = p.length * 13;
    out.push(W(p, x, y0, x + w, y1));
    x += w + 6;
  }
  if (row.value != null) {
    const parts = String(row.value).split(' ');
    let xr = 1455;
    for (let i = parts.length - 1; i >= 0; i--) {
      const w = parts[i].length * 10;
      out.push(W(parts[i], xr - w, y - 8, xr, y + 8));
      xr -= w + 6;
    }
  }
  for (const k of ['prev', 'curr', 'usage']) if (row[k]) out.push(W(row[k], COLS[k][0], y - 8, COLS[k][1], y + 8));
  return out;
}
function synth(rows, totals) {
  let words = [];
  const n = rows.length;
  const cbY = 1097 + T.rowPitch * (n - 1) + 30,
    tadY = cbY + 36;
  for (const a of T.anchors) {
    const box = a.floating ? { ...a, box: [a.box[0], (a.id === 'currentBill' ? cbY : tadY) - 8, a.box[2], (a.id === 'currentBill' ? cbY : tadY) + 9] } : a;
    words = words.concat(anchorWords(box));
  }
  let y = 1097;
  for (const r of rows) {
    words = words.concat(rowWords(r, y));
    y += T.rowPitch;
  }
  if (totals.cb) words.push(W(totals.cb, 1367, cbY - 10, 1456, cbY + 10));
  if (totals.tad) words.push(W(totals.tad, 1367, tadY - 10, 1456, tadY + 10));
  return { words, w: T.ref.w, h: T.ref.h };
}
// page text as the text reader would get it (the same rows, printed as lines)
function pageText(rows, totals, balances) {
  const lines = [
    'Utility Bill',
    'Customer Account Information - Retain for your records',
    'SD 999 TEST SCHOOL        1 TEST ST        01-9001-00',
    '5/15/2026   6/15/2026   31   6/23/2026   7/13/2026   7/10/2026',
  ];
  const b = balances || { prev: '$0.00', pay: '$0.00', adj: '$0.00', pen: '$0.00', acct: '$0.00' };
  lines.push('Previous Balance: ' + b.prev, 'Payments: ' + b.pay, 'Adjustments: ' + b.adj, 'Penalty: ' + b.pen, 'Account Balance ' + b.acct);
  for (const r of rows) lines.push([r.prev, r.curr, r.usage, r.label, r.value].filter((x) => x != null).join(' '));
  if (totals.cb) lines.push('Current Bill ' + totals.cb);
  if (totals.tad) lines.push('Total Amount Due ' + totals.tad);
  return lines.join('\n');
}
const cacheKey = (box, cfg) => [cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all', box.x0, box.y0, box.x1, box.y1].join('|');
// canned readings: readingFor(label) -> text the "crop OCR" returns for that cell under every config
function rereadsFor(page, readingFor) {
  const r = BL.readPageByTemplate(page.words, { w: page.w, h: page.h }, T);
  const plan = BL.rereadPlan(r, T);
  const out = {};
  for (const p of plan) for (const cfg of BL.REREAD_CONFIGS) out[cacheKey(p.box, cfg)] = readingFor(p.label, p);
  return out;
}

// Gas 1000 therms x 0.798062 + 23.33 = 821.39 (the one gas rate, computations/rates.js)
const ROWS = [
  { label: 'WATER', value: '100.00', prev: '4,000', curr: '4,500', usage: '500' },
  { label: 'GAS', value: '821.39', prev: '2,000', curr: '3,000', usage: '1,000.00' },
  { label: 'FUEL ADJUSTMENT', value: '-30.00' },
  { label: 'WATER PROTECTION', value: '1.00' },
  { label: 'SEWER', value: '80.00' },
  { label: 'STORMWATER', value: '4.00' },
];
const TRUTH_ROWS = ROWS.map((r) => ({ label: r.label, amount: r.value, prev: r.prev, curr: r.curr, usage: r.usage }));
const TOT = { cb: '$976.39', tad: '$976.39' };
const pages = [];
function add(id, notes, rows, totals, truth, readingFor, expectStatus, balances) {
  const p = synth(rows, totals);
  pages.push({
    id,
    notes,
    text: pageText(rows, totals, balances),
    words: p.words,
    w: p.w,
    h: p.h,
    rows: truth.rows,
    currentBill: truth.cb,
    totalAmountDue: truth.tad,
    rereads: readingFor ? rereadsFor(p, readingFor) : {},
    expectStatus: expectStatus || {},
  });
}
const ALL_CORRECT = { Water: 'correct', WaterProtection: 'correct', Gas: 'correct', FuelAdjustment: 'correct', Sewer: 'correct', Stormwater: 'correct', CurrentBill: 'correct', TotalAmountDue: 'correct' };

// S1 clean page
add('S1-clean', 'every cell valid, page adds up', ROWS, TOT, { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' }, null, ALL_CORRECT);
// S2 STORMWATER read as "Aw": the cell is re-read and "4.00" makes the page add up
add(
  'S2-storm-aw',
  'STORMWATER value OCR\'d as letters; the re-read gives 4.00',
  ROWS.map((r) => (r.label === 'STORMWATER' ? { ...r, value: 'Aw' } : r)),
  TOT,
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  (label) => (label === 'STORMWATER' ? '4.00' : ''),
  ALL_CORRECT,
);
// S3 Fuel Adjustment lost its minus: every cell valid, the page does not add up, the re-read of the one
// cell gives the signed value (other cells re-read to themselves)
add(
  'S3-fa-sign-lost',
  'FUEL ADJUSTMENT read 30.00 for a printed -30.00; all cells valid, sum fails, re-read proves -30.00',
  ROWS.map((r) => (r.label === 'FUEL ADJUSTMENT' ? { ...r, value: '30.00' } : r)),
  TOT,
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  (label) => (label === 'FUEL ADJUSTMENT' ? '-30.00' : label === 'Current Bill' ? '$976.39' : ROWS.find((r) => r.label === label).value),
  ALL_CORRECT,
);
// S4 GAS cell unreadable in the page and in the re-read: held with the reason, never reconciled
add(
  'S4-gas-unreadable',
  'GAS value OCR\'d as "8Z1,39" and the re-read reads nothing: Gas held, never reconciled from Current Bill',
  ROWS.map((r) => (r.label === 'GAS' ? { ...r, value: '8Z1,39' } : r)),
  TOT,
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  () => '',
  { Water: 'correct', Sewer: 'correct', Stormwater: 'correct', CurrentBill: 'correct', Gas: 'held' },
);
// S5 gas page with NO Fuel Adjustment line: none is invented
const NO_FA = ROWS.filter((r) => r.label !== 'FUEL ADJUSTMENT').map((r) => (r.label === 'GAS' ? { ...r, value: '821.39' } : r));
add(
  'S5-no-fuel-adjustment',
  'no FUEL ADJUSTMENT row printed; Gas 821.39 with 1,000.00 therms; the page adds up without one',
  NO_FA,
  { cb: '$1,006.39', tad: '$1,006.39' },
  { rows: NO_FA.map((r) => ({ label: r.label, amount: r.value, prev: r.prev, curr: r.curr, usage: r.usage })), cb: '1,006.39', tad: '1,006.39' },
  null,
  ALL_CORRECT,
);
// S6 Total Amount Due contradicts Current Bill + carried balance (digit error): held
add(
  'S6-total-due-contradicted',
  'Total Amount Due OCR\'d 986.39 for a printed 976.39; Current Bill 976.39 and the balance lines prove it wrong',
  ROWS,
  { cb: '$976.39', tad: '$986.39' },
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  null,
  { Water: 'correct', Gas: 'correct', FuelAdjustment: 'correct', CurrentBill: 'correct', TotalAmountDue: 'held' },
  { prev: '$100.00', pay: '($100.00)', adj: '$0.00', pen: '$0.00', acct: '$0.00' },
);
// S7 a pen line merged the GAS and FUEL ADJUSTMENT labels into one tall OCR box: split by row pitch
add(
  'S7-merged-label-band',
  'the FUEL ADJUSTMENT label OCR\'d as one tall noise word spanning the GAS and FUEL ADJUSTMENT rows',
  ROWS.map((r) => (r.label === 'FUEL ADJUSTMENT' ? { ...r, label: 'avwsivent', tall: 1 } : r.label === 'GAS' ? { ...r, tall: 2 } : r)),
  TOT,
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  null,
  ALL_CORRECT,
);
// S8 Current Bill read "$1,851,57"-style garble and Fuel Adjustment "4335": both re-read, proved by the sum
add(
  'S8-two-cells-reread',
  'FUEL ADJUSTMENT read "3000" (point lost, sign lost) and Current Bill "$976,39" (comma for the point)',
  ROWS.map((r) => (r.label === 'FUEL ADJUSTMENT' ? { ...r, value: '3000' } : r)),
  { cb: '$976,39', tad: '$976.39' },
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  (label) => (label === 'FUEL ADJUSTMENT' ? '-30.00' : label === 'Current Bill' ? '$976.39' : ''),
  ALL_CORRECT,
);

const out = {
  _about:
    'SYNTHETIC City bill pages for tools/gate-bill-ground-truth.js (fake school, fake street, fake account 01-9001-00). Built by make-bill-ground-truth-synthetic.js from the City template reference coordinates. rereads = canned crop-OCR readings per value cell and config (gate cache key).',
  pages,
};
fs.writeFileSync(path.join(__dirname, 'bill-ground-truth-synthetic.json'), JSON.stringify(out, null, 1));
console.log('wrote', pages.length, 'synthetic pages');
