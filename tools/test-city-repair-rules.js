/**
 * test-city-repair-rules.js
 *
 * The City bill repair rules (2026-10-20): a lost cents digit, the dollar cell, the history check (rejects only),
 * the text-layer usage cell, the Total Amount Due fill. A value fills when two or more independent sources agree;
 * otherwise the hold names the exact missing second source.
 *
 * SYNTHETIC data only (account 'SAMPLE-ACCT', page S9 of tools/synthetic-pages/bill-ground-truth-synthetic.json).
 * Loads the real functions from computations/bill-layout.js and app/energy-savings.js via vm.
 *
 * Usage: node tools/test-city-repair-rules.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const BL = require(path.join(root, 'computations', 'bill-layout.js'));
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', lib), 'utf8'), sandbox, { filename: lib });
// the day-parse functions billMonth needs (app/utility-data.js, loaded by source; the page module needs a DOM)
{
  const udSrc = fs.readFileSync(path.join(root, 'app', 'utility-data.js'), 'utf8');
  const fn = (name) => {
    const m = udSrc.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
    return m ? m[0].replace(/\r\n/g, '\n') : '';
  };
  vm.runInContext(fn('_fixISO') + fn('_parseISO') + fn('calcDays'), sandbox);
}
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'normalization.js'), 'utf8'), sandbox, { filename: 'normalization.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'rates.js'), 'utf8'), sandbox, { filename: 'rates.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8'), sandbox, { filename: 'energy-savings.js' });
const run = (name) => vm.runInContext(name, sandbox);
const cityRule = run("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')");
const extractFile = run('_extractFileBills');
const rejectReason = run('_lbg_historyRejectReason');
const textUsage = run('_lbg_textLayerGasUsage');
const applyGas = run('_lbg_applyGasUsageAutofix');

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const J = (x) => JSON.stringify(x);

// R1: one lost cents digit gives the ten candidates
const C = (t) => BL.candidatesFromText(t);
check('R1 "4.0" gives 4.00 .. 4.09', [4, 4.05, 4.09].every((v) => C('4.0').includes(v)), J(C('4.0')));
check('R1 "Aw" gives nothing', !C('Aw').length, J(C('Aw')));

// R2: the dollar cell (T10, T14, T15)
const D = (t) => BL.dollarCellValue(t);
check('R2 "(83,572.97 7)" = 3,572.97 (leading "(8" is the "$", " 7)" is noise)', D('(83,572.97 7)') === 3572.97, J(D('(83,572.97 7)')));
check('R2 "($3,572.97" = 3,572.97', D('($3,572.97') === 3572.97, J(D('($3,572.97')));
check('R2 "S2,584.70" "§0.00" "81.65" "845.32"', D('S2,584.70') === 2584.7 && D('§0.00') === 0 && D('81.65') === 1.65 && D('845.32') === 45.32, J([D('S2,584.70'), D('§0.00'), D('81.65'), D('845.32')]));
check('R2 "(82,541.03)" is negative (Payments)', D('(82,541.03)') === -2541.03, J(D('(82,541.03)')));
check('R2 "8,572.97": the rest has no comma-thousands shape, nothing dropped', D('8,572.97') === 8572.97, J(D('8,572.97')));

// R7: the history check rejects only (T16, T17, T18)
const hist = (values, months, total) => ({ values, months, total });
check('R7 Current Bill 83,572.97 rejected, 3,572.97 kept', !!rejectReason(hist([2479.08, 2610.4, 3105.22], 3, true), 'Current Bill', 83572.97) && rejectReason(hist([2479.08, 2610.4, 3105.22], 3, true), 'Current Bill', 3572.97) === null, '');
check('R7 a line with 3 summer bills is not checked (under 12 months)', rejectReason(hist([23.33, 23.33, 124.33], 3, false), 'GAS', 2980.11) === null, '');
check('R7 a line with 12 months is checked', !!rejectReason(hist([23.33, 23.33, 124.33], 12, false), 'GAS', 2980.11), '');
check('R7 2 saved bills only: no check', rejectReason(hist([2479.08, 2610.4], 2, true), 'Current Bill', 83572.97) === null, '');
check('R7 under a tenth of the smallest is rejected', !!rejectReason(hist([2479.08, 2610.4, 3105.22], 3, true), 'Current Bill', 74.65), '');

// text-layer usage cell
check('text layer "1.214.164" = 1,214.164', (textUsage('68,204 68,925 1.214.164 GAS 992.33') || {}).value === 1214.164, J(textUsage('68,204 68,925 1.214.164 GAS 992.33')));
check('text layer "1,086.18" = 1,086.18', (textUsage('66,245 66,890 1,086.18 GAS 900.00') || {}).value === 1086.18, '');
check('text layer: a bare integer is no decimal usage cell', textUsage('68,204 68,925 721 GAS 992.33') === null, '');
check('text layer: the position block is not text layer', textUsage('%%POSITION_READ%%\n68,204 68,925 1.214.164 GAS 992.33') === null, '');

// S9: the whole synthetic handwritten page, position path then the file-level autofix
const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-pages', 'bill-ground-truth-synthetic.json'), 'utf8'));
const pg = fix.pages.find((p) => p.id === 'S9-handwritten-gas');
const cacheKey = (box, cfg) => [cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all', box.x0, box.y0, box.x1, box.y1].join('|');
(async () => {
  const pass = { label: '2.5x', score: 1, text: pg.text, words: pg.words, w: pg.w, h: pg.h };
  const res = await BL.readPage([pass], async (box, cfg) => pg.rereads[cacheKey(box, cfg)] || '', {});
  check('S9 template matched', res.ok, J(res.reason));
  const full = '%%PAGE_1%%\n' + pg.text + BL.linesBlock(res.read, '2.5x');
  const bills = extractFile(full, cityRule);
  const by = {};
  for (const b of bills) by[b.Commodity] = b;
  const pt = bills[0]._pageTotals;
  check('S9 Gas line 1,001.51', by.Gas && by.Gas.PrintedGasLine === 1001.51, J(by.Gas && by.Gas.PrintedGasLine));
  check('S9 Fuel Adjustment -41.27 (handwriting on the cell)', by.Gas && by.Gas.FuelAdjustment === -41.27, J(by.Gas && by.Gas.FuelAdjustment));
  check('S9 Stormwater 4.00 (cents digit lost, empty cell)', by.Stormwater && by.Stormwater.StormWaterCharge === 4, J(by.Stormwater && by.Stormwater.StormWaterCharge));
  check('S9 Current Bill 2,883.70 printed, not derived', pt.currentBill === 2883.7 && pt.currentBillDerived === false, J(pt));
  check('S9 Current Bill hover names the page lines and the balance identity', /page lines add up/.test(pt.currentBillReason || '') && /balance carried 51\.20/.test(pt.currentBillReason || ''), J(pt.currentBillReason));
  check('S9 Total Amount Due 2,934.90', pt.totalAmountDue === 2934.9 && !pt.totalAmountDueHeld, J(pt));
  check('S9 therms 1,225.7 filled, hover names both sources', by.Gas && by.Gas.NaturalGasTherms === 1225.7 && /Gas charge fits/.test(by.Gas._auto_corrected_NaturalGasTherms.reason) && /1\.225\.700/.test(by.Gas._auto_corrected_NaturalGasTherms.reason), J(by.Gas && by.Gas._auto_corrected_NaturalGasTherms));
  check('S9 reads are the first two tokens', by.Gas && by.Gas.StartRead === 20100 && by.Gas.EndRead === 20821, J([by.Gas.StartRead, by.Gas.EndRead]));
  check('S9 zero holds on every bill', bills.every((b) => !b._manualReview && !b._gateTripped && !(b._gateReasons || []).length), J(bills.map((b) => [b.Commodity, b._gateReasons])));

  // T2-like: no text-layer usage cell and no meter factor: the charge alone is one source, the hold names the missing one
  const noCell = '%%PAGE_1%%\n' + pg.text.replace('1.225.700', '') + BL.linesBlock(res.read, '2.5x');
  const b2 = extractFile(noCell, cityRule).find((b) => b.Commodity === 'Gas');
  check('T2 no second source: therms stay null and held', b2 && b2.NaturalGasTherms === null && b2._manualReview === true, J(b2 && b2.NaturalGasTherms));

  // a meter factor from the account's other bills adds the third source (reads x factor)
  const g4 = JSON.parse(J(by.Gas));
  g4.NaturalGasTherms = null;
  g4._correction_pending_NaturalGasTherms = { original: 721, reason: 'x' };
  g4._gateTripped = true;
  g4._manualReview = true;
  g4._gateReasons = ['x'];
  applyGas([g4, { Commodity: 'Gas', AccountNumber: g4.AccountNumber, StartRead: 100, EndRead: 200, NaturalGasTherms: 170 }]);
  check('T1 reads x factor + charge: 721 x 1.7 = 1,225.7 filled without the text layer', g4.NaturalGasTherms === 1225.7 && /meter reads 721 x 1\.7/.test(g4._auto_corrected_NaturalGasTherms.reason), J(g4._auto_corrected_NaturalGasTherms));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
