#!/usr/bin/env node
/**
 * make-bill-ground-truth-synthetic.js — writes bill-ground-truth-synthetic.json, the committed SYNTHETIC
 * pages of tools/gate-bill-ground-truth.js: City pages and (since 2026-10-19) Utility E Billing Details
 * pages. Fake school, fake street, fake account; word boxes built from each template's own reference
 * coordinates (computations/bill-layout.js CITY_NEW, UTILITY_E_BD), as in tools/test-bill-layout.js. The re-read readings are canned per value cell (key = the gate's cache key
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
// S6 Total Amount Due contradicts Current Bill + carried balance by one digit: two sources (the identity, the
// one-digit repair of the scan) agree on 976.39 and the page lines prove the Current Bill: filled
add(
  'S6-total-due-contradicted',
  'Total Amount Due read as 986.39 for a printed 976.39; Current Bill 976.39 (the lines add up to it) + the balance lines and the one-digit repair both give 976.39',
  ROWS,
  { cb: '$976.39', tad: '$986.39' },
  { rows: TRUTH_ROWS, cb: '976.39', tad: '976.39' },
  null,
  ALL_CORRECT,
  { prev: '$100.00', pay: '($100.00)', adj: '$0.00', pen: '$0.00', acct: '$0.00' },
);
// S6b the same, but the read is two digits off the identity: one source only, held with the missing source named
add(
  'S6b-total-due-two-digits',
  'Total Amount Due read as 918.39 for a printed 976.39: the identity gives 976.39, no one-digit repair of the scan does: held',
  ROWS,
  { cb: '$976.39', tad: '$918.39' },
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

// S9 a handwritten gas bill (fake school, fake figures): handwriting on the Fuel Adjustment cell, an empty
// Stormwater cell (re-read "4.0", one cents digit lost), the Current Bill "$" read as "(8" with a stray "7)",
// and a Gas usage cell that fails the usage format. Nothing is held: every value has two agreeing sources.
//   Gas 1,001.51 = 23.33 + 1,225.700 therms x 0.798062; reads 20,100 / 20,821 = 721 x 1.7 = 1,225.7
//   lines 904.50 + 1,001.51 - 41.27 + 3.21 + 1,011.75 + 4.00 = 2,883.70; carried 1,800.00 - 1,750.00 + 1.20 = 51.20
const S9_ROWS = [
  { label: 'WATER', value: '904.50', prev: '4,000,000', curr: '4,010,000', usage: '10,000' },
  { label: 'GAS', value: '1,001.51', prev: '20,100', curr: '20,821', usage: '[1257700' },
  { label: 'FUEL ADJUSTMENT', value: '9389' },
  { label: 'WATER PROTECTION', value: '3.21' },
  { label: 'SEWER', value: '1,011.75' },
  { label: 'STORMWATER', value: null },
];
const S9_TEXT_ROWS = [
  { label: 'WATER', value: '904.50', prev: '4,000,000', curr: '4,010,000', usage: '10,000' },
  { label: 'GAS', value: '1,001.51', prev: '20,100', curr: '20,821', usage: '1.225.700' },
  { label: 'FUEL ADR', value: '¢ 41.27' },
  { label: 'WATER PROTECTION', value: '3.21' },
  { label: 'SEWER', value: '1,011.75' },
  { label: 'STORMWATER', value: '4.0' },
];
const S9_TRUTH = [
  { label: 'WATER', amount: '904.50' },
  { label: 'GAS', amount: '1,001.51' },
  { label: 'FUEL ADJUSTMENT', amount: '-41.27' },
  { label: 'WATER PROTECTION', amount: '3.21' },
  { label: 'SEWER', amount: '1,011.75' },
  { label: 'STORMWATER', amount: '4.00' },
];
const S9_BAL = { prev: '$1,800.00', pay: '($1,750.00)', adj: '$0.00', pen: '$1.20', acct: '$51.20' };
add(
  'S9-handwritten-gas',
  'handwriting on FUEL ADJUSTMENT (9389), STORMWATER cell empty (re-read 4.0), Current Bill "(82,883.70 7)", Gas usage cell [1257700 (text layer 1.225.700): no hold',
  S9_ROWS,
  { cb: '(82,883.70 7)', tad: '$2,934.90' },
  { rows: S9_TRUTH, cb: '2,883.70', tad: '2,934.90' },
  (label) => (label === 'FUEL ADJUSTMENT' ? '41391' : label === 'STORMWATER' ? '4.0' : label === 'Current Bill' ? '($2,883.70' : ''),
  ALL_CORRECT,
  S9_BAL,
);
pages[pages.length - 1].text = pageText(S9_TEXT_ROWS, { cb: '$2,883.70', tad: '$2,934.90' }, S9_BAL);
pages[pages.length - 1].account = 'SAMPLE-ACCT-9';
pages[pages.length - 1].expectTherms = 1225.7;

// ── Utility E synthetic pages (template UTILITY_E_BD; fake school, fake address, synthetic account id) ──
// Word boxes built from the template's own reference coordinates: the fixed anchors at their boxes, the
// Billing Details header at its box, the charge lines as label-column bands (a two-line label is two
// bands; the amount sits on the second), the Subtotal, the rows below it and Current Charges under the
// last row, the meter table header under those. The page text for the text path prints the same lines.
const E = BL.UTILITY_E_BD;
const E_LABEL_X = 797;
const E_AMOUNT_X1 = 1443;
function eLineWords(text, y, opts) {
  const out = [];
  let x = E_LABEL_X;
  for (const p of (text || '').split(' ').filter(Boolean)) {
    const w = p.length * 11;
    out.push(W(p, x, y - 9, x + w, y + 9));
    x += w + 6;
  }
  if (opts && opts.value != null) {
    const parts = String(opts.value).split(' ');
    let xr = E_AMOUNT_X1;
    for (let i = parts.length - 1; i >= 0; i--) {
      const w = parts[i].length * 10;
      out.push(W(parts[i], xr - w, y - 9, xr, y + 9));
      xr -= w + 6;
    }
  }
  return out;
}
// row: { lines: ['Energy Chg On Pk Sum 1,000.0000 kWh at', '$0.10000 per kWh'], value: '$100.00' }
// (value on the last line); totals: { subLabel, sub, ccLabel, cc } (a null label = the label OCR lost:
// only the amount word prints; a null amount = the line is not on the page at all)
function eSynth(rows, below, totals) {
  let words = [];
  for (const a of E.anchors) if (!a.floating) words = words.concat(anchorWords(a));
  const bd = E.anchors.find((a) => a.id === 'billingDetails');
  words = words.concat(anchorWords(bd));
  let y = bd.box[3] + 14 + 9;
  const lineOf = (text, value) => {
    words = words.concat(eLineWords(text, y, { value }));
    y += E.rowPitch;
  };
  for (const r of rows) r.lines.forEach((l, i) => lineOf(l, i === r.lines.length - 1 ? r.value : null));
  if (totals.sub !== null) lineOf(totals.subLabel === null ? '' : totals.subLabel || 'Subtotal', totals.sub);
  for (const r of below || []) r.lines.forEach((l, i) => lineOf(l, i === r.lines.length - 1 ? r.value : null));
  if (totals.cc !== null) lineOf(totals.ccLabel === null ? '' : totals.ccLabel || 'Current Charges', totals.cc);
  y += 120;
  words.push(W('Meter', 891, y - 24, 940, y - 10));
  words.push(W('Multiplier', 889, y - 9, 960, y + 9));
  words.push(W('kWh', 1035, y - 9, 1065, y + 9));
  words.push(W('Used', 1075, y - 9, 1110, y + 9));
  return { words, w: E.ref.w, h: E.ref.h };
}
function ePageText(rows, below, totals) {
  const lines = [
    'Customer Name : SAMPLE SCHOOL',
    'Account Number : 900123                                     Page 2 of 2',
    'Billing Date: 06/30/2026',
    '100 SAMPLE DR SAMPLE KS',
    'LGS Secondary Voltage - 2LGSE          Billing Details - service from 05/31/2026 to 06/29/2026',
  ];
  const put = (r) => r.lines.forEach((l, i) => lines.push(i === r.lines.length - 1 ? l + ' ........ ' + r.value : l));
  for (const r of rows) put(r);
  if (totals.sub !== null) lines.push((totals.subLabel === null ? '' : totals.subLabel || 'Subtotal') + ' ........ ' + totals.sub);
  for (const r of below || []) put(r);
  if (totals.cc !== null) lines.push((totals.ccLabel === null ? '' : totals.ccLabel || 'Current Charges') + ' ........ ' + totals.cc);
  return lines.join('\n');
}
// canned readings for every re-readable box of both sum groups: readingFor(label, plan) -> text
function eRereadsFor(page, readingFor) {
  const r = BL.readPageByTemplate(page.words, { w: page.w, h: page.h }, E);
  const out = {};
  for (const g of BL.sumGroups(E))
    for (const p of BL.rereadPlan(r, E, true, g)) for (const cfg of BL.REREAD_CONFIGS) out[cacheKey(p.box, cfg)] = readingFor(p.label, p);
  return out;
}
// the printed lines of the sample page (every qty x rate equals its charge; On + Off = the ECA kWh)
const E_ROWS = [
  { field: 'CustomerCharge', lines: ['Customer Chg'], value: '$48.90' },
  { field: 'FacilitiesCharge', lines: ['Facilities Chg 40.0000 kW at $2.500 per kW'], value: '$100.00' },
  { field: 'BilledKWCharge', lines: ['Demand Chg 40.0000 kW at $10.000 per kW'], value: '$400.00' },
  { field: 'EnergyOnPeakCharge', lines: ['Energy Chg On Pk Sum 1,000.0000 kWh at', '$0.10000 per kWh'], value: '$100.00' },
  { field: 'EnergyOffPeakCharge', lines: ['Energy Chg Off Pk Sum 5,000.0000 kWh at', '$0.05000 per kWh'], value: '$250.00' },
  { field: 'TaxExemptDelivery', lines: ['Tax exempt delivery cost from bill'], value: '$200.00' },
  { field: 'ECACharge', lines: ['ECA Chg 06-01-2026-06-29-2026 for', '6,000.0000 kWh at $0.02000 per kWh'], value: '$120.00' },
  { field: 'EERCharge', lines: ['EER Chg 06-01-2026-06-29-2026 for', '6,000.0000 kWh at $0.00050 per kWh'], value: '$3.00' },
  { field: 'PTSCharge', lines: ['PTS Chg 06-01-2026-06-29-2026 for', '6,000.0000 kWh at $0.00100 per kWh'], value: '$6.00' },
  { field: 'TDCCharge', lines: ['TDC Chg 06-01-2026-06-29-2026 for 40.0000', 'kW at $2.50000 per kW'], value: '$100.00' },
  { field: 'BillOffset', lines: ['Bill offset'], value: '-$200.00' },
];
const E_SUB = '$1,127.90'; // the rows add up to this
const E_BELOW = [{ field: 'FranchiseFee', lines: ['Sample City Franchise Fee'], value: '$56.45' }];
const E_CC_WITH_FEE = '$1,184.35';
const eTruth = (rows, below, sub, cc) => ({
  rows: rows.map((r) => ({ field: r.field, label: r.lines.join(' '), amount: r.value.replace('$', '') })),
  belowSubtotal: (below || []).map((r) => ({ field: r.field, label: r.lines.join(' '), amount: r.value.replace('$', '') })),
  subtotal: sub == null ? null : sub.replace('$', ''),
  currentCharges: cc == null ? null : cc.replace('$', ''),
});
const E_PRINTED = {};
for (const r of E_ROWS.concat(E_BELOW)) E_PRINTED[r.field] = r.value;
E_PRINTED.Subtotal = E_SUB;
E_PRINTED['Current Charges'] = E_CC_WITH_FEE;
const eReadingTrue = (label) => E_PRINTED[label] || '';
function eAdd(id, notes, rows, below, totals, truth, readingFor, expectStatus, expectMatched) {
  const p = eSynth(rows, below, totals);
  pages.push({
    id,
    provider: 'utility-e',
    notes,
    text: ePageText(rows, below, totals),
    words: p.words,
    w: p.w,
    h: p.h,
    rows: truth.rows,
    belowSubtotal: truth.belowSubtotal,
    subtotal: truth.subtotal,
    currentCharges: truth.currentCharges,
    servicePeriod: { start: '05/31/2026', end: '06/29/2026' },
    readDates: null,
    printedDays: null,
    rereads: readingFor ? eRereadsFor(p, readingFor) : {},
    expectStatus: expectStatus || {},
    expectMatched: expectMatched == null ? true : expectMatched,
  });
}
const E_ALL_CORRECT = {};
for (const f of [
  'CustomerCharge',
  'FacilitiesCharge',
  'BilledKWCharge',
  'EnergyOnPeakCharge',
  'EnergyOffPeakCharge',
  'RkVACharge',
  'TaxExemptDelivery',
  'ECACharge',
  'EERCharge',
  'PTSCharge',
  'TDCCharge',
  'BillOffset',
  'SolarCredit',
  'FranchiseFee',
  'SalesTax',
  'Subtotal',
  'TotalCurrentCharges',
  'BillingPeriodStart',
  'BillingPeriodEnd',
])
  E_ALL_CORRECT[f] = 'correct';
const withValue = (rows, field, value) => rows.map((r) => (r.field === field ? { ...r, value } : r));
const withLabel = (rows, field, line0) => rows.map((r) => (r.field === field ? { ...r, lines: [line0].concat(r.lines.slice(1)) } : r));

// E1 clean page: every line valid, both identities hold
eAdd('E1-clean', 'every cell valid; rows = Subtotal = Current Charges', E_ROWS, [], { sub: E_SUB, cc: E_SUB }, eTruth(E_ROWS, [], E_SUB, E_SUB), null, E_ALL_CORRECT);
// E2 the Customer Chg label OCR'd "CUSIOMET CRG" and its amount "$48}": the kind by position, the amount
// by the re-read proved by the Subtotal
eAdd(
  'E2-customer-garbled',
  'label "CUSIOMET CRG" is Customer Chg by its slot; "$48}" re-read as $48.90 and proved by the Subtotal',
  withValue(withLabel(E_ROWS, 'CustomerCharge', 'CUSIOMET CRG'), 'CustomerCharge', '$48}'),
  [],
  { sub: E_SUB, cc: E_SUB },
  eTruth(E_ROWS, [], E_SUB, E_SUB),
  (label) => (label === 'CustomerCharge' ? '$48.90' : ''),
  E_ALL_CORRECT,
);
// E3 the Current Charges label OCR lost: the label-less amount under the Subtotal that equals Subtotal
// plus the Franchise Fee is the printed Current Charges box
eAdd(
  'E3-cc-label-lost',
  'no "Current Charges" words on the page; its amount equals Subtotal + Franchise Fee and is taken by structure',
  E_ROWS,
  E_BELOW,
  { sub: E_SUB, ccLabel: null, cc: E_CC_WITH_FEE },
  eTruth(E_ROWS, E_BELOW, E_SUB, E_CC_WITH_FEE),
  null,
  E_ALL_CORRECT,
);
// E4 the Current Charges amount unreadable on the page and in the re-read: the total is HELD (never the
// Subtotal, never the sum); every row stays correct
eAdd(
  'E4-cc-unreadable',
  'Current Charges read "$1,1Z7.90" and the re-read reads nothing: TotalCurrentCharges held with the reason',
  E_ROWS,
  [],
  { sub: E_SUB, cc: '$1,1Z7.90' },
  eTruth(E_ROWS, [], E_SUB, E_SUB),
  (label) => (label === 'Current Charges' ? '' : eReadingTrue(label)),
  { ...E_ALL_CORRECT, TotalCurrentCharges: 'held' },
);
// E5 the Subtotal label OCR'd beyond the fuzzy match ("SUBLOLEL"): found by structure (the rows add up to it)
eAdd(
  'E5-subtotal-label-garbled',
  'Subtotal label "SUBLOLEL": the label-less amount equal to the sum of the rows is the Subtotal; Current Charges proved from it',
  E_ROWS,
  [],
  { subLabel: 'SUBLOLEL', sub: E_SUB, cc: E_SUB },
  eTruth(E_ROWS, [], E_SUB, E_SUB),
  null,
  E_ALL_CORRECT,
);
// E6 ECA "$120.00-" (a sign after the figure is not the printed format) and Bill offset "$200.00" (minus
// lost, format-valid): the re-read of the group proves both (two changes)
eAdd(
  'E6-sign-reread',
  'ECA "$120.00-" fails the page format; Bill offset "$200.00" lost its minus; the re-read proves $120.00 and -$200.00 by the Subtotal',
  withValue(withValue(E_ROWS, 'ECACharge', '$120.00-'), 'BillOffset', '$200.00'),
  [],
  { sub: E_SUB, cc: E_SUB },
  eTruth(E_ROWS, [], E_SUB, E_SUB),
  eReadingTrue,
  E_ALL_CORRECT,
);
// E7 the details continue on another page: no Subtotal and no Current Charges printed here; rows read,
// both totals null and the bill held
eAdd(
  'E7-no-totals-on-page',
  'Billing Details continue on a page outside the scan: no Subtotal, no Current Charges; rows stay as read, totals null',
  E_ROWS,
  [],
  { sub: null, cc: null },
  eTruth(E_ROWS, [], null, null),
  null,
  { ...E_ALL_CORRECT, Subtotal: 'correct', TotalCurrentCharges: 'correct' },
);
// E8 a page with the frame anchors but no Billing Details header (the bill's summary page) is not this
// template: no match, the text reader runs
(() => {
  let words = [];
  for (const a of E.anchors) if (!a.floating) words = words.concat(anchorWords(a));
  words.push(W('Current', 797, 700, 880, 718), W('Charges', 890, 700, 980, 718), W('(details', 990, 700, 1060, 718), W('on', 1070, 700, 1090, 718), W('back)', 1100, 700, 1150, 718), W('$1,127.90', 1360, 700, 1443, 718));
  pages.push({
    id: 'E8-summary-page-no-match',
    provider: 'utility-e',
    notes: 'the summary page: frame anchors present, no Billing Details header: the template does not match',
    text: 'Customer Name : SAMPLE SCHOOL\nAccount Number : 900123\nCurrent Charges (details on back) ........ $1,127.90\n',
    words,
    w: E.ref.w,
    h: E.ref.h,
    rows: [],
    belowSubtotal: [],
    subtotal: null,
    currentCharges: '1,127.90', // the summary page prints the bill total; the text reader reads it
    servicePeriod: {},
    readDates: null,
    printedDays: null,
    rereads: {},
    expectStatus: {},
    expectMatched: false,
  });
})();

const out = {
  _about:
    'SYNTHETIC bill pages for tools/gate-bill-ground-truth.js: City pages (provider city; fake school, fake street, fake account 01-9001-00) and Utility E Billing Details pages (provider utility-e; fake school, fake address, synthetic account id). Built by make-bill-ground-truth-synthetic.js from the reference coordinates of each template (computations/bill-layout.js CITY_NEW, UTILITY_E_BD). rereads = canned crop-OCR readings per value cell and config (gate cache key).',
  pages,
};
fs.writeFileSync(path.join(__dirname, 'bill-ground-truth-synthetic.json'), JSON.stringify(out, null, 1));
console.log('wrote', pages.length, 'synthetic pages');
