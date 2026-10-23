/**
 * test-city-all-pass-texts.js
 *
 * City bill with handwriting over the Fuel Adjustment cell, when only ONE OCR pass text (not the winning
 * position pass) carries the printed "FUEL ADR ... 53.42" line and the Gas usage cell. The page read must use
 * every pass text as a second source (computations/bill-layout.js textLineCandidates), the Gas usage must come
 * from the printed usage cell before the usage x rate check,.
 *
 * SYNTHETIC data only (fake school, fake account 01-9001-00, page S9 of tools/synthetic-pages).
 * Usage: node tools/test-city-all-pass-texts.js
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

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
};
const J = (x) => JSON.stringify(x);

// the S9 page moved to this case's amounts (every amount below is synthetic)
const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-pages', 'bill-ground-truth-synthetic.json'), 'utf8'));
const pg = fix.pages.find((p) => p.id === 'S9-handwritten-gas');
const MAP = [
  ['904.50', '1,254.80'],
  ['1,001.51', '992.33'],
  ['20,100', '68,204'],
  ['20,821', '68,925'],
  ['1.225.700', '1.214.164'],
  ['[1257700', '[2147164'],
  ['41.27', '53.42'],
  ['3.21', '4.44'],
  ['1,011.75', '1,370.82'],
  ['2,883.70', '3,572.97'],
  ['2,934.90', '3,618.29'],
  ['Previous Balance: $1,800.00', 'Previous Balance: $2,584.70'],
  ['($1,750.00)', '($2,541.03)'],
  ['Penalty: $1.20', 'Penalty: $1.65'],
  ['Account Balance $51.20', 'Account Balance $45.32'],
];
const mv = (s) => MAP.reduce((acc, [a, b]) => acc.split(a).join(b), s);
const words = pg.words.map((w) => ({ ...w, t: mv(w.t) }));
const fullText = mv(pg.text).replace('STORMWATER 4.0', 'STORMWATER 4.00');
// the winning (position) pass text: no Fuel line, the usage cell lost, no Stormwater amount
const winText = fullText
  .split('\n')
  .filter((l) => !/FUEL ADR/.test(l))
  .map((l) => l.replace('1.214.164 ', '').replace('STORMWATER 4.00', 'STORMWATER'))
  .join('\n');
const key = (box, cfg) => [cfg.zoom, cfg.psm, cfg.whitelist ? 'wl' : 'all', box.x0, box.y0, box.x1, box.y1].join('|');
const rereads = {};
Object.keys(pg.rereads).forEach((k) => (rereads[k] = pg.rereads[k] === '4.0' ? '' : '139550'));
const ocrBox = async (box, cfg) => rereads[key(box, cfg)] || '';

(async () => {
  const win = { label: '3.5x', score: 9, text: winText, words, w: pg.w, h: pg.h };
  const other = { label: '3x', score: 1, text: fullText };
  // control: the winning pass text alone cannot prove the Fuel line
  const only = await BL.readPage([win], ocrBox, {});
  check('control: winning pass text alone holds the Fuel Adjustment', only.ok && only.read.held.some((h) => /FUEL/i.test(h.label)), J(only.read && only.read.held));
  const res = await BL.readPage([win, other], ocrBox, {});
  check('template matched', res.ok, J(res.reason));
  check('no held box with all pass texts', res.ok && !res.read.held.length, J(res.read.held));
  const page = '%%PAGE_1%%\n' + fullText + BL.linesBlock(res.read, win.label);
  const bills = extractFile(page, cityRule);
  const by = {};
  for (const b of bills) by[b.Commodity] = b;
  const pt = bills[0]._pageTotals;
  check('Fuel Adjustment -53.42', by.Gas && by.Gas.FuelAdjustment === -53.42, J(by.Gas && by.Gas.FuelAdjustment));
  check('Stormwater 4.00', by.Stormwater && by.Stormwater.StormWaterCharge === 4, J(by.Stormwater && by.Stormwater.StormWaterCharge));
  check('Gas line 992.33', by.Gas && by.Gas.PrintedGasLine === 992.33, J(by.Gas && by.Gas.PrintedGasLine));
  check('Gas record total 938.91', by.Gas && by.Gas.TotalCurrentCharges === '938.91' && by.Gas.TotalAmountDue === '938.91', J([by.Gas && by.Gas.TotalCurrentCharges, by.Gas && by.Gas.TotalAmountDue]));
  check('page Current Bill 3,572.97 and Total Amount Due 3,618.29', pt.currentBill === 3572.97 && pt.totalAmountDue === 3618.29, J(pt));
  check('Gas therms 1,214.164 from the printed usage cell', by.Gas && by.Gas.NaturalGasTherms === 1214.164, J(by.Gas && by.Gas.NaturalGasTherms));
  check('no hold on any bill', bills.every((b) => !b._manualReview && !b._gateTripped && !(b._gateReasons || []).length), J(bills.map((b) => [b.Commodity, b._gateReasons])));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
