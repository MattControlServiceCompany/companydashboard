#!/usr/bin/env node
/**
 * gate-bill-ground-truth.js — the bill readers against printed ground truth (City and Utility E).
 *
 * Runs the REAL reader of each provider (app/energy-savings.js: the one City _extractNew rule; the one
 * Utility E extractAll rule) the two ways production runs it on a scanned page: the POSITION path
 * (computations/bill-layout.js readPage over the page's OCR word boxes, box re-read included, block
 * appended to the page text) and the TEXT path (page text alone, the fallback when no template matches).
 * Every field of every page is scored against what is printed:
 *   correct  the reader's value equals the printed value (an absent line: no value)
 *   held     the reader gave no value and the page carries a named reason (never a guess)
 *   wrong    a value differs from the printed one, a value for a line the page does not print, or a
 *            missing value with no reason
 * The gate FAILS on any WRONG value on the production path (position where the template matched, else
 * text). The text path is reported for every page as information.
 *
 * Inputs
 *   Committed, always: tools/synthetic-pages/bill-ground-truth-synthetic.json (SYNTHETIC pages of both
 *   providers: fake school, fake street, fake account; word boxes built from each template's own
 *   coordinates; `provider` 'city' (default) or 'utility-e').
 *   Local, real data (never in the repo), when both exist:
 *     BILL_GT_FILE         the City ground-truth file (C:\...\_context\ground-truth\2026-10-19-city-bill-pages.json)
 *     BILL_GT_UTILITY_E_FILE  the Utility E ground-truth file (...\the dated Utility E file)
 *     BILL_GT_WORDS_DIR    folder with <image>.png, <image>.png.ocr.json (words, text) and the re-read
 *                          cache <image>.png.rereads.json (default: pagesDir of the ground-truth file)
 *     BILL_GT_OCR_MODULES  optional: a node_modules folder with tesseract.js and @napi-rs/canvas; when
 *                          set, a re-read missing from the cache is OCR'd from the page PNG and cached
 *                          (one worker, one process). Without it a missing re-read reads as "".
 *     BILL_GT_LANG_PATH    optional: folder with eng.traineddata for that worker
 *     BILL_GT_HISTORY_FILE optional: a CompanyHub backup; its saved bills are the account history of the reader's
 *                          plausibility check (rejects only; absent: the check is a no-op)
 *     BILL_GT_OUT          optional: write the per-page results (one JSON per provider: <out> and
 *                          <out>.utility-e.json)
 *   Absent real inputs: the real part is skipped with a clear message (CI).
 *
 * Usage: node tools/gate-bill-ground-truth.js [--root <repo dir>] [--verbose]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const argVal = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const ROOT = argVal('--root') || path.join(__dirname, '..');
const VERBOSE = args.includes('--verbose');
const BL = require(path.join(ROOT, 'computations', 'bill-layout.js'));

// ── the real readers in a vm (same loads as tools/test-bill-layout.js) ──
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
sandbox.BILL_LAYOUT = BL; // the field formats the readers' autofix reads (computations/bill-layout.js)
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', lib), 'utf8'), sandbox, { filename: lib });
// The one day-count function (app/utility-data.js calcDays with its _parseISO): the Utility E reader's
// NumberOfDays comes from it. Loaded by source so the page module (DOM at load) is not run.
(() => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'utility-data.js'), 'utf8');
  const fn = (name) => {
    // the file has CRLF line endings
    const m = src.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
    return m ? m[0].replace(/\r\n/g, '\n') : '';
  };
  const code = fn('_fixISO') + fn('_parseISO') + fn('calcDays');
  if (/function calcDays/.test(code)) vm.runInContext(code, sandbox, { filename: 'utility-data.js(calcDays)' });
})();
// the one month function (billMonth): the history check counts the calendar months a bill list covers
vm.runInContext(fs.readFileSync(path.join(ROOT, 'computations', 'normalization.js'), 'utf8'), sandbox, { filename: 'normalization.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'computations', 'rates.js'), 'utf8'), sandbox, {
  filename: 'rates.js',
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'energy-savings.js'), 'utf8'), sandbox, {
  filename: 'energy-savings.js',
});
// Optional: the account history (BILL_GT_HISTORY_FILE = a CompanyHub backup). Gives the reader the saved
// bills of every account, so the history check (reject only) runs on the real pages as in production.
if (process.env.BILL_GT_HISTORY_FILE && fs.existsSync(process.env.BILL_GT_HISTORY_FILE)) {
  const hd = JSON.parse(fs.readFileSync(process.env.BILL_GT_HISTORY_FILE, 'utf8'));
  const ud = {};
  for (const k of Object.keys(hd)) if (/^en_utility_\d/.test(k)) ud[k] = typeof hd[k] === 'string' ? JSON.parse(hd[k]) : hd[k];
  sandbox.utilityData = ud;
}
const historyReject = vm.runInContext('_lbg_pageHistoryReject', sandbox);
const cityRule = vm.runInContext("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')", sandbox);
// the Utility E rule: the first rule of UTILITY_RULES (the electric utility), never the City rule
const utilityERule = vm.runInContext("UTILITY_RULES[0]", sandbox);
if (!utilityERule || typeof utilityERule._extractNew === 'function' || typeof utilityERule.extractAll !== 'function')
  throw new Error('UTILITY_RULES[0] is not the electric utility rule');
const labeledAmount = vm.runInContext('_lbg_labeledAmount', sandbox);
const CB_LABEL = vm.runInContext('_LBG_CURRENT_BILL_LABEL', sandbox);
const TAD_LABEL = vm.runInContext('_LBG_TOTAL_AMOUNT_DUE_LABEL', sandbox);

const num = (s) => {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const t = String(s).replace(/[\$,\s]/g, '');
  const neg = /^-|-$/.test(t) || /^\(.*\)$/.test(t);
  const v = parseFloat(t.replace(/[-()]/g, ''));
  return isNaN(v) ? null : neg ? -v : v;
};
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const same = (a, b) => (typeof a === 'string' || typeof b === 'string' ? a === b : a != null && b != null && Math.abs(a - b) < 0.005);
// a printed date as M/D/YYYY with two-digit month and day ("3/31/2026" and "03/31/2026" are one date)
const dateKey = (s) => {
  const m = String(s || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/);
  if (!m) return s == null || s === '' ? null : String(s);
  return m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + (m[3].length === 2 ? '20' + m[3] : m[3]);
};

// ── City ──
// Expected fields of a City page from its printed rows.
function cityExpected(pg) {
  const sum = (label) => {
    const rs = pg.rows.filter((r) => r.label === label);
    if (!rs.length) return { present: false, value: null };
    if (rs.some((r) => r.amount === 'unreadable')) return { present: true, value: null, unreadable: true };
    return { present: true, value: r2(rs.reduce((s, r) => s + num(r.amount), 0)) };
  };
  return {
    Water: sum('WATER'),
    WaterProtection: sum('WATER PROTECTION'),
    Gas: sum('GAS'),
    FuelAdjustment: sum('FUEL ADJUSTMENT'),
    Sewer: sum('SEWER'),
    Stormwater: sum('STORMWATER'),
    CurrentBill: { present: true, value: num(pg.currentBill) },
    TotalAmountDue: { present: true, value: num(pg.totalAmountDue) },
  };
}
const CITY_FIELDS = [
  'Water',
  'WaterProtection',
  'Gas',
  'FuelAdjustment',
  'Sewer',
  'Stormwater',
  'CurrentBill',
  'TotalAmountDue',
];
// The City reader's values from the bills it returned, and the reasons it gave.
function cityReaderValues(bills, totalsSrc) {
  const by = {};
  for (const b of bills || []) by[b.Commodity] = b;
  const gas = by.Gas;
  const gasLine =
    gas && gas.PrintedGasLine != null
      ? num(gas.PrintedGasLine)
      : gas && gas.GasCharge != null
        ? r2(num(gas.GasCharge) + (num(gas.CustomerCharge) || 0))
        : null;
  const reasons = [];
  for (const b of bills || []) {
    (b._gateReasons || []).forEach((r) => reasons.push(r));
    if (b._manualReviewLabel) reasons.push(b._manualReviewLabel);
    if (b._pageTotalMismatch) reasons.push('page total mismatch ' + JSON.stringify(b._pageTotalMismatch));
    for (const k of Object.keys(b))
      if (/^_(proposed|correction_pending)_/.test(k) && b[k] && b[k].reason) reasons.push(k + ': ' + b[k].reason);
  }
  // The page totals as the reader decided them (bill._pageTotals, every bill of the page carries
  // them); a reader without that record (an older tree under --root) falls back to the one labeled
  // reader on the rows text. A Current Bill the reader derived from the balance lines is not a
  // printed value: it counts as held.
  const pt = bills && bills.length && bills[0]._pageTotals ? bills[0]._pageTotals : null;
  const cbRaw = pt ? null : labeledAmount(totalsSrc, CB_LABEL, true);
  const tadRaw = pt ? null : labeledAmount(totalsSrc, TAD_LABEL);
  if (pt && pt.currentBillDerived)
    reasons.push('Current Bill derived from Total Amount Due and the balance lines (not printed)');
  if (pt && pt.totalAmountDueHeld) reasons.push(pt.totalAmountDueHeld);
  return {
    values: {
      Water: by.Water ? num(by.Water.WaterCharge) : null,
      WaterProtection: by.Water ? num(by.Water.WaterProtectionFee) : null,
      Gas: gasLine,
      FuelAdjustment: gas ? num(gas.FuelAdjustment) : null,
      Sewer: by.Sewer ? num(by.Sewer.SewerCharge) : null,
      Stormwater: by.Stormwater ? num(by.Stormwater.StormWaterCharge) : null,
      CurrentBill: pt ? (pt.currentBillDerived ? null : pt.currentBill) : cbRaw != null ? num(cbRaw) : null,
      TotalAmountDue: pt ? pt.totalAmountDue : tadRaw != null ? num(tadRaw) : null,
    },
    reasons,
    mode: bills && bills.length ? bills[0]._readMode : null,
  };
}

// ── Utility E ──
// Expected fields of a Utility E Billing Details page: the lines of one field add up (split Demand,
// ECA parts, the sales tax lines); Subtotal and Current Charges as printed (null = not on this page:
// the details continue on a page outside the scan); the service period and the printed Days of the
// meter table (skipped when the table is not on the page).
const UTILITY_E_FIELDS = [
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
  'NumberOfDays',
];
function utilityEExpected(pg) {
  const all = (pg.rows || []).concat(pg.belowSubtotal || []);
  const sum = (field) => {
    const rs = all.filter((r) => r.field === field);
    if (!rs.length) return { present: false, value: null };
    if (rs.some((r) => r.amount === 'unreadable')) return { present: true, value: null, unreadable: true };
    return { present: true, value: r2(rs.reduce((s, r) => s + num(r.amount), 0)) };
  };
  const printed = (v) => (v == null || v === '' ? { present: false, value: null } : v === 'unreadable' ? { present: true, value: null, unreadable: true } : { present: true, value: num(v) });
  const out = {};
  for (const f of UTILITY_E_FIELDS) out[f] = sum(f);
  out.Subtotal = printed(pg.subtotal);
  out.TotalCurrentCharges = printed(pg.currentCharges);
  const sp = pg.servicePeriod || {};
  out.BillingPeriodStart = sp.start ? { present: true, value: dateKey(sp.start) } : { present: false, value: null };
  out.BillingPeriodEnd = sp.end ? { present: true, value: dateKey(sp.end) } : { present: false, value: null };
  out.NumberOfDays =
    pg.printedDays == null || pg.printedDays === ''
      ? { present: true, value: null, unreadable: true }
      : pg.printedDays === 'unreadable'
        ? { present: true, value: null, unreadable: true }
        : { present: true, value: num(pg.printedDays) };
  return out;
}
// The Utility E reader's values from the bill it returned (one Billing Details page gives one bill), and
// the reasons it gave.
function utilityEReaderValues(bills) {
  const b = (bills || [])[0] || null;
  const reasons = [];
  for (const x of bills || []) {
    (x._gateReasons || []).forEach((r) => reasons.push(r));
    if (x._manualReviewLabel) reasons.push(x._manualReviewLabel);
    for (const k of Object.keys(x))
      if (/^_(proposed|correction_pending)_/.test(k) && x[k] && x[k].reason) reasons.push(k + ': ' + x[k].reason);
    if (x._customerChargePartial) reasons.push('Customer Chg cents unreadable: ' + JSON.stringify(x._customerChargePartial));
  }
  if (!b) reasons.push('the reader returned no bill for the page');
  const values = {};
  for (const f of UTILITY_E_FIELDS) values[f] = b ? num(b[f]) : null;
  values.Subtotal = b ? num(b._subtotal) : null;
  values.BillingPeriodStart = b ? dateKey(b.BillingPeriodStart) : null;
  values.BillingPeriodEnd = b ? dateKey(b.BillingPeriodEnd) : null;
  values.NumberOfDays = b ? num(b.NumberOfDays) : null;
  return { values, reasons, mode: b ? b._readMode : null };
}

const PROVIDERS = {
  city: {
    key: 'city',
    title: 'City',
    envFile: 'BILL_GT_FILE',
    fields: CITY_FIELDS,
    expected: cityExpected,
    read: (text) => cityRule.extractAll(text),
    values: cityReaderValues,
  },
  utilityE: {
    key: 'utility-e',
    title: 'Utility E',
    envFile: 'BILL_GT_UTILITY_E_FILE',
    fields: UTILITY_E_FIELDS,
    expected: utilityEExpected,
    read: (text) => utilityERule.extractAll(text),
    values: utilityEReaderValues,
  },
};

function score(exp, got, fields) {
  const out = {};
  for (const f of fields) {
    const e = exp[f],
      v = got.values[f];
    if (e.unreadable) out[f] = { status: 'skip', why: 'printed value unreadable by eye or not on the page' };
    else if (!e.present)
      out[f] =
        v == null
          ? { status: 'correct' }
          : { status: 'wrong', why: 'value ' + v + ' for a line the page does not print' };
    else if (v == null)
      out[f] = got.reasons.length
        ? { status: 'held', why: got.reasons[0] }
        : { status: 'wrong', why: 'missing, no reason given' };
    else if (same(v, e.value)) out[f] = { status: 'correct' };
    else out[f] = { status: 'wrong', why: 'read ' + v + ', printed ' + e.value };
  }
  return out;
}

// ── re-read cache / OCR for the real pages ──
let ocrWorker = null;
let canvasMod = null;
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  const mods = process.env.BILL_GT_OCR_MODULES;
  const T = require(path.join(mods, 'tesseract.js'));
  canvasMod = require(path.join(mods, '@napi-rs', 'canvas'));
  const lang = process.env.BILL_GT_LANG_PATH;
  ocrWorker = await T.createWorker('eng', 1, lang ? { langPath: lang, gzip: false, cachePath: lang } : {}, {
    load_system_dawg: '0',
    load_freq_dawg: '0',
  });
  await ocrWorker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
  return ocrWorker;
}
// Crop of one value cell at cfg.zoom x the page image, 8 px white margin, tesseract psm 7 and the
// whitelist when cfg says so: the same recipe app/bill-analysis.js uses in the browser.
async function ocrCrop(pngPath, box, cfg) {
  const w = await getWorker();
  const { createCanvas, loadImage } = canvasMod;
  const img = await loadImage(pngPath);
  const z = cfg.zoom,
    M = 8 * z;
  const sw = Math.round(box.x1 - box.x0),
    sh = Math.round(box.y1 - box.y0);
  const c = createCanvas(sw * z + 2 * M, sh * z + 2 * M);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round(box.x0), Math.round(box.y0), sw, sh, M, M, sw * z, sh * z);
  const r = await w.recognize(
    c.toBuffer('image/png'),
    {
      tessedit_pageseg_mode: String(cfg.psm),
      tessedit_char_whitelist: cfg.whitelist ? BL.REREAD_WHITELIST : '',
      rotateAuto: false,
    },
    { text: true },
  );
  return (r.data.text || '').replace(/\s+/g, ' ').trim();
}
const cacheKey = (box, cfg) =>
  [cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all', box.x0, box.y0, box.x1, box.y1].join('|');
function makeOcrBox(pngPath, cachePath, stats) {
  let cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  return async (box, cfg) => {
    const k = cacheKey(box, cfg);
    if (cache[k] != null) return cache[k];
    if (!process.env.BILL_GT_OCR_MODULES || !fs.existsSync(pngPath)) {
      stats.cacheMiss++;
      return '';
    }
    const txt = await ocrCrop(pngPath, box, cfg);
    cache[k] = txt;
    stats.ocr++;
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
    return txt;
  };
}

// ── one page through both paths ──
async function runPage(prov, pg, words, ocrBox) {
  const A = '%%PAGE_1%%\n' + words.text;
  const exp = prov.expected(pg);
  const textBills = prov.read(A);
  const text = prov.values(textBills, words.text);
  const pass = { label: '2.5x', score: 1, text: words.text, words: words.words, w: words.w, h: words.h };
  const res = typeof BL.readPage === 'function' ? await BL.readPage([pass], ocrBox, { reject: historyReject }) : BL.readBestPass([pass]);
  const B = A + (res.ok ? BL.linesBlock(res.read, pass.label) : BL.fallbackMarker(res.reason));
  const posBills = prov.read(B);
  const pos = prov.values(posBills, res.ok ? res.read.lines.join('\n') : words.text);
  if (res.ok && res.read.held && res.read.held.length)
    res.read.held.forEach((h) => pos.reasons.push(h.label + ': ' + h.reason));
  return {
    id: pg.id,
    matched: res.ok,
    template: res.ok ? res.read.template : null,
    reason: res.ok ? null : res.reason,
    text: { values: text.values, score: score(exp, text, prov.fields), reasons: text.reasons },
    position: {
      values: pos.values,
      score: score(exp, pos, prov.fields),
      reasons: pos.reasons,
      rereads: res.ok ? res.read.rereads : null,
      held: res.ok ? res.read.held : null,
      lines: res.ok ? res.read.lines : null,
    },
  };
}
function tally(results, pathName, fields) {
  const t = {};
  for (const f of fields) t[f] = { correct: 0, wrong: 0, held: 0, skip: 0 };
  for (const r of results) for (const f of fields) t[f][r[pathName].score[f].status]++;
  return t;
}
function printTally(title, t, fields) {
  console.log('\n' + title);
  console.log('  ' + 'field'.padEnd(22) + 'correct  wrong  held');
  let C = 0,
    W = 0,
    H = 0;
  for (const f of fields) {
    console.log(
      '  ' +
        f.padEnd(22) +
        String(t[f].correct).padStart(7) +
        String(t[f].wrong).padStart(7) +
        String(t[f].held).padStart(6),
    );
    C += t[f].correct;
    W += t[f].wrong;
    H += t[f].held;
  }
  console.log('  ' + 'ALL'.padEnd(22) + String(C).padStart(7) + String(W).padStart(7) + String(H).padStart(6));
  return { correct: C, wrong: W, held: H };
}
function printWrong(results, pathName, title, fields) {
  const rows = [];
  for (const r of results)
    for (const f of fields)
      if (r[pathName].score[f].status === 'wrong') rows.push('  ' + r.id + ' ' + f + ': ' + r[pathName].score[f].why);
  if (rows.length) console.log('\n' + title + ' (' + rows.length + '):\n' + rows.join('\n'));
}
function printHeld(results, pathName, title, fields) {
  const rows = [];
  for (const r of results)
    for (const f of fields)
      if (r[pathName].score[f].status === 'held')
        rows.push('  ' + r.id + ' ' + f + ': ' + r[pathName].score[f].why.slice(0, 200));
  if (rows.length) console.log('\n' + title + ' (' + rows.length + '):\n' + rows.join('\n'));
}

// The real ground truth of one provider: every page through both paths; FAIL on a wrong value on the
// production path. Returns true when the part ran and failed.
async function runReal(prov) {
  const gtFile = process.env[prov.envFile];
  if (!gtFile || !fs.existsSync(gtFile)) {
    console.log('\nREAL ' + prov.title + ' ground truth: skipped (' + prov.envFile + ' not set or not found; real data stays outside the repo)');
    return false;
  }
  const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
  const dir = process.env.BILL_GT_WORDS_DIR || gt.pagesDir;
  if (!dir || !fs.existsSync(dir)) {
    console.log('\nREAL ' + prov.title + ' ground truth: skipped (words folder not found: ' + dir + ')');
    return false;
  }
  const stats = { ocr: 0, cacheMiss: 0 };
  const results = [];
  for (const pg of gt.pages) {
    const wp = path.join(dir, pg.image + '.ocr.json');
    if (!fs.existsSync(wp)) {
      console.log('  no words for ' + pg.id + ' (' + wp + '), skipped');
      continue;
    }
    const words = JSON.parse(fs.readFileSync(wp, 'utf8'));
    const ocrBox = makeOcrBox(path.join(dir, pg.image), path.join(dir, pg.image + '.rereads.json'), stats);
    results.push(await runPage(prov, pg, words, ocrBox));
  }
  const matched = results.filter((r) => r.matched).length;
  console.log(
    '\nREAL ' +
      prov.title +
      ' ground truth: ' +
      results.length +
      ' pages, template matched ' +
      matched +
      ', re-read OCR calls ' +
      stats.ocr +
      ', re-read cache misses ' +
      stats.cacheMiss,
  );
  const tp = tally(results, 'position', prov.fields);
  const tt = tally(results, 'text', prov.fields);
  printTally('REAL ' + prov.title + ' pages, POSITION path (production path for a matched page)', tp, prov.fields);
  printTally('REAL ' + prov.title + ' pages, TEXT path (fallback; information)', tt, prov.fields);
  printWrong(results, 'position', 'REAL ' + prov.title + ' position WRONG', prov.fields);
  printHeld(results, 'position', 'REAL ' + prov.title + ' position held', prov.fields);
  if (VERBOSE) {
    printWrong(results, 'text', 'REAL ' + prov.title + ' text WRONG', prov.fields);
    for (const r of results) {
      if (r.position.rereads && r.position.rereads.length)
        console.log('  re-read ' + r.id + ': ' + JSON.stringify(r.position.rereads));
      if (!r.matched) console.log('  no match ' + r.id + ': ' + r.reason);
    }
  }
  // production path: position where matched, else text
  let prodWrong = 0;
  for (const r of results) {
    const p = r.matched ? r.position : r.text;
    for (const f of prov.fields) if (p.score[f].status === 'wrong') prodWrong++;
  }
  if (prodWrong) console.log('\nFAIL: ' + prodWrong + ' wrong ' + prov.title + ' value(s) on the production path');
  if (process.env.BILL_GT_OUT) {
    const out = prov.key === 'city' ? process.env.BILL_GT_OUT : process.env.BILL_GT_OUT + '.' + prov.key + '.json';
    fs.writeFileSync(out, JSON.stringify({ position: tp, text: tt, pages: results }, null, 1));
  }
  return prodWrong > 0;
}

(async () => {
  let fail = false;
  // 1. synthetic fixtures (always)
  const fixPath = path.join(__dirname, 'synthetic-pages', 'bill-ground-truth-synthetic.json'); // this tree's synthetic pages, also under --root
  if (!fs.existsSync(fixPath)) {
    console.log('FAIL: missing ' + fixPath);
    process.exit(1);
  }
  const fix = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
  for (const prov of [PROVIDERS.city, PROVIDERS.utilityE]) {
    const pagesOf = fix.pages.filter((pg) => (pg.provider || 'city') === prov.key);
    if (!pagesOf.length) continue;
    const synth = [];
    for (const pg of pagesOf) {
      const cache = pg.rereads || {};
      const ocrBox = async (box, cfg) =>
        cache[cacheKey(box, cfg)] != null
          ? cache[cacheKey(box, cfg)]
          : cache[[cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all'].join('|') + '|*'] || '';
      synth.push(await runPage(prov, pg, pg, ocrBox));
    }
    const ts = tally(synth, 'position', prov.fields);
    const synthTotals = printTally('SYNTHETIC ' + prov.title + ' pages (' + synth.length + '), position path', ts, prov.fields);
    printWrong(synth, 'position', 'synthetic ' + prov.title + ' WRONG', prov.fields);
    printHeld(synth, 'position', 'synthetic ' + prov.title + ' held', prov.fields);
    // every synthetic page expects a status per field: check against the fixture's own expectations
    for (const pg of pagesOf) {
      const r = synth.find((x) => x.id === pg.id);
      if (pg.expectMatched != null && r.matched !== pg.expectMatched) {
        console.log('FAIL synthetic ' + pg.id + ': expected template match ' + pg.expectMatched + ', got ' + r.matched + ' (' + (r.reason || '') + ')');
        fail = true;
      }
      for (const f of Object.keys(pg.expectStatus || {})) {
        if (r.position.score[f].status !== pg.expectStatus[f]) {
          console.log(
            'FAIL synthetic ' +
              pg.id +
              ' ' +
              f +
              ': expected ' +
              pg.expectStatus[f] +
              ', got ' +
              r.position.score[f].status +
              ' (' +
              (r.position.score[f].why || '') +
              ')',
          );
          fail = true;
        }
      }
    }
    if (synthTotals.wrong) fail = true;
  }

  // 2. real ground truth (local only), one provider after the other
  for (const prov of [PROVIDERS.city, PROVIDERS.utilityE]) {
    if (await runReal(prov)) fail = true;
  }
  if (ocrWorker) await ocrWorker.terminate();

  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' gate-bill-ground-truth');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
