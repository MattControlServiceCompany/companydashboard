#!/usr/bin/env node
/**
 * gate-bill-ground-truth.js — the City bill reader against printed ground truth.
 *
 * Runs the REAL City rule (app/energy-savings.js, the one _extractNew rule) the two ways production runs
 * it on a scanned page: the POSITION path (computations/bill-layout.js readPage over the page's OCR word
 * boxes, box re-read included, block appended to the page text) and the TEXT path (page text alone, the
 * fallback when no template matches). Every field of every page is scored against what is printed:
 *   correct  the reader's value equals the printed value (an absent line: no value)
 *   held     the reader gave no value and the page carries a named reason (never a guess)
 *   wrong    a value differs from the printed one, a value for a line the page does not print, or a
 *            missing value with no reason
 * The gate FAILS on any WRONG value on the production path (position where the template matched, else
 * text). The text path is reported for every page as information.
 *
 * Inputs
 *   Committed, always: tools/synthetic-pages/bill-ground-truth-synthetic.json (SYNTHETIC pages: fake school,
 *   fake street, fake account; word boxes built from the template's own coordinates).
 *   Local, real data (never in the repo), when both exist:
 *     BILL_GT_FILE       the ground-truth file (C:\...\_context\ground-truth\2026-10-19-city-bill-pages.json)
 *     BILL_GT_WORDS_DIR  folder with <image>.png, <image>.png.ocr.json (words, text) and the re-read
 *                        cache <image>.png.rereads.json (default: pagesDir of the ground-truth file)
 *     BILL_GT_OCR_MODULES  optional: a node_modules folder with tesseract.js and @napi-rs/canvas; when
 *                        set, a re-read missing from the cache is OCR'd from the page PNG and cached
 *                        (one worker, one process). Without it a missing re-read reads as "".
 *     BILL_GT_LANG_PATH  optional: folder with eng.traineddata for that worker
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

// ── the real City rule in a vm (same loads as tools/test-bill-layout.js) ──
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', lib), 'utf8'), sandbox, { filename: lib });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'computations', 'rates.js'), 'utf8'), sandbox, {
  filename: 'rates.js',
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'energy-savings.js'), 'utf8'), sandbox, {
  filename: 'energy-savings.js',
});
const rule = vm.runInContext("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')", sandbox);
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
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

// Expected fields of a page from its printed rows.
function expected(pg) {
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
const FIELDS = [
  'Water',
  'WaterProtection',
  'Gas',
  'FuelAdjustment',
  'Sewer',
  'Stormwater',
  'CurrentBill',
  'TotalAmountDue',
];

// The reader's values from the bills it returned, and the reasons it gave.
function readerValues(bills, totalsSrc) {
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
function score(exp, got) {
  const out = {};
  for (const f of FIELDS) {
    const e = exp[f],
      v = got.values[f];
    if (e.unreadable) out[f] = { status: 'skip', why: 'printed value unreadable by eye' };
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
async function runPage(pg, words, ocrBox) {
  const A = '%%PAGE_1%%\n' + words.text;
  const exp = expected(pg);
  const textBills = rule.extractAll(A);
  const text = readerValues(textBills, words.text);
  const pass = { label: '2.5x', score: 1, words: words.words, w: words.w, h: words.h };
  const res = typeof BL.readPage === 'function' ? await BL.readPage([pass], ocrBox) : BL.readBestPass([pass]);
  const B = A + (res.ok ? BL.linesBlock(res.read, pass.label) : BL.fallbackMarker(res.reason));
  const posBills = rule.extractAll(B);
  const pos = readerValues(posBills, res.ok ? res.read.lines.join('\n') : words.text);
  if (res.ok && res.read.held && res.read.held.length)
    res.read.held.forEach((h) => pos.reasons.push(h.label + ': ' + h.reason));
  return {
    id: pg.id,
    matched: res.ok,
    reason: res.ok ? null : res.reason,
    text: { values: text.values, score: score(exp, text), reasons: text.reasons },
    position: {
      values: pos.values,
      score: score(exp, pos),
      reasons: pos.reasons,
      rereads: res.ok ? res.read.rereads : null,
      held: res.ok ? res.read.held : null,
      lines: res.ok ? res.read.lines : null,
    },
  };
}
function tally(results, pathName) {
  const t = {};
  for (const f of FIELDS) t[f] = { correct: 0, wrong: 0, held: 0, skip: 0 };
  for (const r of results) for (const f of FIELDS) t[f][r[pathName].score[f].status]++;
  return t;
}
function printTally(title, t) {
  console.log('\n' + title);
  console.log('  ' + 'field'.padEnd(18) + 'correct  wrong  held');
  let C = 0,
    W = 0,
    H = 0;
  for (const f of FIELDS) {
    console.log(
      '  ' +
        f.padEnd(18) +
        String(t[f].correct).padStart(7) +
        String(t[f].wrong).padStart(7) +
        String(t[f].held).padStart(6),
    );
    C += t[f].correct;
    W += t[f].wrong;
    H += t[f].held;
  }
  console.log('  ' + 'ALL'.padEnd(18) + String(C).padStart(7) + String(W).padStart(7) + String(H).padStart(6));
  return { correct: C, wrong: W, held: H };
}
function printWrong(results, pathName, title) {
  const rows = [];
  for (const r of results)
    for (const f of FIELDS)
      if (r[pathName].score[f].status === 'wrong') rows.push('  ' + r.id + ' ' + f + ': ' + r[pathName].score[f].why);
  if (rows.length) console.log('\n' + title + ' (' + rows.length + '):\n' + rows.join('\n'));
}
function printHeld(results, pathName, title) {
  const rows = [];
  for (const r of results)
    for (const f of FIELDS)
      if (r[pathName].score[f].status === 'held')
        rows.push('  ' + r.id + ' ' + f + ': ' + r[pathName].score[f].why.slice(0, 200));
  if (rows.length) console.log('\n' + title + ' (' + rows.length + '):\n' + rows.join('\n'));
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
  const synth = [];
  for (const pg of fix.pages) {
    const cache = pg.rereads || {};
    const ocrBox = async (box, cfg) =>
      cache[cacheKey(box, cfg)] != null
        ? cache[cacheKey(box, cfg)]
        : cache[[cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all'].join('|') + '|*'] || '';
    synth.push(await runPage(pg, pg, ocrBox));
  }
  const ts = tally(synth, 'position');
  const synthTotals = printTally('SYNTHETIC fixtures (' + synth.length + ' pages), position path', ts);
  printWrong(synth, 'position', 'synthetic WRONG');
  printHeld(synth, 'position', 'synthetic held');
  // every synthetic page expects a status per field: check against the fixture's own expectations
  for (const pg of fix.pages) {
    const r = synth.find((x) => x.id === pg.id);
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

  // 2. real ground truth (local only)
  const gtFile = process.env.BILL_GT_FILE;
  if (!gtFile || !fs.existsSync(gtFile)) {
    console.log('\nREAL ground truth: skipped (BILL_GT_FILE not set or not found; real data stays outside the repo)');
  } else {
    const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
    const dir = process.env.BILL_GT_WORDS_DIR || gt.pagesDir;
    if (!dir || !fs.existsSync(dir)) {
      console.log('\nREAL ground truth: skipped (words folder not found: ' + dir + ')');
    } else {
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
        results.push(await runPage(pg, words, ocrBox));
      }
      if (ocrWorker) await ocrWorker.terminate();
      const matched = results.filter((r) => r.matched).length;
      console.log(
        '\nREAL ground truth: ' +
          results.length +
          ' pages, template matched ' +
          matched +
          ', re-read OCR calls ' +
          stats.ocr +
          ', re-read cache misses ' +
          stats.cacheMiss,
      );
      const tp = tally(results, 'position');
      const tt = tally(results, 'text');
      const posTotals = printTally('REAL pages, POSITION path (production path for a matched page)', tp);
      printTally('REAL pages, TEXT path (fallback; information)', tt);
      printWrong(results, 'position', 'REAL position WRONG');
      printHeld(results, 'position', 'REAL position held');
      if (VERBOSE) {
        printWrong(results, 'text', 'REAL text WRONG');
        for (const r of results) {
          if (r.position.rereads && r.position.rereads.length)
            console.log('  re-read ' + r.id + ': ' + JSON.stringify(r.position.rereads));
        }
      }
      // production path: position where matched, else text
      let prodWrong = 0;
      for (const r of results) {
        const p = r.matched ? r.position : r.text;
        for (const f of FIELDS) if (p.score[f].status === 'wrong') prodWrong++;
      }
      if (prodWrong) {
        console.log('\nFAIL: ' + prodWrong + ' wrong value(s) on the production path');
        fail = true;
      }
      if (process.env.BILL_GT_OUT)
        fs.writeFileSync(process.env.BILL_GT_OUT, JSON.stringify({ position: tp, text: tt, pages: results }, null, 1));
    }
  }
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' gate-bill-ground-truth');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
