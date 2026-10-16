/**
 * alternate-pass outlier test
 *
 * Node test (real functions from app/*.js and computations/*.js in a vm, SYNTHETIC data only) for:
 *  1. _findAltPassBill: two meters on ONE account with the SAME billing period never swap rows.
 *  2. Statistical outliers: history comes from the meter by id (older bills saved with other address
 *     text still count), is compared by the same calendar month in other years (the one month rule,
 *     billsInSameMonthOtherYears in computations/bill-flags.js), and needs 2 or more such bills.
 *  3. The one-digit ECA rate repair (_evgRateOneDigitRepair) and its sum gate (_evgChargesReconcile).
 *  4. The implied-rate warning comes from validateBillData only.
 * Usage: node <path to this file>
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const bfs = require('./bill-flags-sandbox.js');

const root = path.join(__dirname, '..');
const el = () => ({
  style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  appendChild() {},
  addEventListener() {},
  setAttribute() {},
  querySelectorAll: () => [],
  querySelector: () => null,
});
const sb = {
  document: {
    getElementById: () => null,
    addEventListener() {},
    createElement: el,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: el(),
  },
  console: { log() {}, warn() {}, error() {} },
  navigator: { userAgent: 'node' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  clearTimeout() {},
  requestAnimationFrame: () => 0,
  addEventListener() {},
  fetch: () => Promise.reject(new Error('no network in test')),
};
sb.window = sb;
vm.createContext(sb);
const files = [
  'lib/formatting.js',
  'computations/rates.js',
  'computations/savings.js',
  'lib/date-helpers.js',
  'computations/normalization.js',
  'computations/bill-flags.js',
  'computations/bill-repair.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
];
vm.runInContext(
  ['_fixISO', '_parseISO', 'calcDays', 'fmtDate'].map((n) => bfs.fnSource('app/utility-data.js', n)).join(String.fromCharCode(10)),
  sb,
);
for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f });
vm.runInContext(
  `sget = function (k, fb) { return fb; };
   forEachCustomerBuilding = function () {};`,
  sb,
);
// Test doubles are set; call the real functions through the context.
const run = (code) => vm.runInContext(code, sb);

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

// ---- 1. alternate-pass twin ------------------------------------------------------------
{
  const mk = (addr, page, kwh) => ({
    AccountNumber: '900123',
    BillingPeriodStart: '08/01/2026',
    BillingPeriodEnd: '08/31/2026',
    ServiceAddress: addr,
    _pageStart: page,
    _pageEnd: page,
    kWhConsumed: kwh,
  });
  const main = mk('100 SAMPLE DR,MAIN BLDG EXAMPLETON KS', 4, '197931');
  const side = mk('100 SAMPLE DR,SIDE FIELD EXAMPLETON KS', 3, '957');
  sb.__alt = [side, main];
  sb.__b = main;
  check('altpass: both meters share account+period, the main row is chosen for the main bill', run('_findAltPassBill(__alt, __b)') === main);
  sb.__b = side;
  check('altpass: the side row is chosen for the side bill', run('_findAltPassBill(__alt, __b)') === side);
  // Only the side meter's row exists in the alternate pass: the main bill must get NO twin.
  sb.__alt = [side];
  sb.__b = main;
  check('altpass: a shared-account sibling is never taken as the twin', run('_findAltPassBill(__alt, __b)') === null);
  // Address text garbled by OCR: the address no longer agrees, so no twin (safe direction: consensus skipped).
  const garbled = mk('1OO SAMPL DR MAIN', 4, '197931');
  sb.__alt = [garbled];
  sb.__b = main;
  check('altpass: a noisy address matches nothing even on the same page', run('_findAltPassBill(__alt, __b)') === null);
  // Same address but the pages do not overlap: not the same place.
  const farPage = mk('100 SAMPLE DR,MAIN BLDG EXAMPLETON KS', 9, '197931');
  sb.__alt = [farPage];
  sb.__b = main;
  check('altpass: same address on a different page matches nothing', run('_findAltPassBill(__alt, __b)') === null);
  // Two meters sharing account + period + page + address: ambiguous, no twin.
  const dupA = mk('100 SAMPLE DR,MAIN BLDG EXAMPLETON KS', 4, '197931');
  const dupB = mk('100 SAMPLE DR,MAIN BLDG EXAMPLETON KS', 4, '957');
  sb.__alt = [dupB, dupA];
  sb.__b = main;
  check('altpass: two rows share account+period+page+address, ambiguous, no twin', run('_findAltPassBill(__alt, __b)') === null);
  // Neither address nor page: nothing to verify, nothing matched.
  const bare = { AccountNumber: '900123', BillingPeriodStart: '08/01/2026', BillingPeriodEnd: '08/31/2026' };
  sb.__alt = [bare];
  sb.__b = Object.assign({}, bare);
  check('altpass: no address and no page matches nothing', run('_findAltPassBill(__alt, __b)') === null);
}

// ---- 2. statistical outliers ---------------------------------------------------------
{
  // Fixture: one meter, an account shared with nothing else. Older bills carry another address text.
  const mkHist = (year, kwh, addr) => ({
    id: 'b' + year,
    start: year + '-08-27',
    end: year + '-09-28',
    kwh: String(kwh),
    totalCost: String(Math.round(kwh * 0.12)),
    serviceAddress: addr,
  });
  const meter = {
    id: 'm-1',
    account: '123456789',
    meter: '',
    maddr: '10 EXAMPLE ST,TEST SCHOOL EXAMPLETON KS',
    bills: [
      mkHist(2023, 55000, '10\nOLD DISTRICT NAME'),
      mkHist(2024, 58000, '10\nOLD DISTRICT NAME'),
      mkHist(2025, 56000, '10 EXAMPLE ST'),
      // spring bills of the same meter
      { id: 'sp1', start: '2026-04-01', end: '2026-04-30', kwh: '30000', totalCost: '3600', serviceAddress: '10 EXAMPLE ST' },
      { id: 'sp2', start: '2026-05-01', end: '2026-05-31', kwh: '31000', totalCost: '3700', serviceAddress: '10 EXAMPLE ST' },
    ],
  };
  sb.__meter = meter;
  run('_tagHistoryMeterBills(__meter)');
  const cache = { 123456789: meter.bills };
  sb.__cache = cache;
  const bill = (kwh, start, end) => ({
    Commodity: 'Electric',
    AccountNumber: '123456789',
    ServiceAddress: '10 EXAMPLE ST,TEST SCHOOL EXAMPLETON KS',
    BillingPeriodStart: start,
    BillingPeriodEnd: end,
    kWhConsumed: String(kwh),
    TotalCurrentCharges: String(Math.round(kwh * 0.12)) + '.00',
  });
  sb.__b = bill(60000, '08/27/2026', '09/28/2026');
  const hist = run('_historyForBill(__b, __cache)');
  check('outlier: all 5 bills of the meter count, whatever address text they were saved with', hist.length === 5, 'got ' + hist.length);
  const peers = run('billsInSameMonthOtherYears(__b, _historyForBill(__b, __cache)).map(function (x) { return x.id; })');
  check('outlier: same-month peers are the 3 older September-ending bills', peers.join() === 'b2023,b2024,b2025', peers.join());
  check('outlier: a normal same-month swing gives no warning', run('detectStatisticalOutliers(__b, __cache, {})').length === 0);
  sb.__b = bill(500000, '08/27/2026', '09/28/2026');
  const wBig = run('detectStatisticalOutliers(__b, __cache, {})');
  check('outlier: a value 9x its same-month mean still warns', wBig.some((w) => w.field === 'kWhConsumed' && /outlier/.test(w.message)), JSON.stringify(wBig));
  // Spring average (30-31k) must not be the yardstick for a September bill.
  sb.__b = bill(57000, '08/27/2026', '09/28/2026');
  check('outlier: a September bill is not judged against spring bills', run('detectStatisticalOutliers(__b, __cache, {})').length === 0);
  // Fewer than 2 same-month bills: no statistical warning at all.
  meter.bills = meter.bills.filter((b) => b.id !== 'b2023' && b.id !== 'b2024');
  cache['123456789'] = meter.bills;
  sb.__b = bill(500000, '08/27/2026', '09/28/2026');
  check('outlier: only 1 same-month bill, no warning even for a huge value', run('detectStatisticalOutliers(__b, __cache, {})').length === 0);
  // Two meters on one account: the bill goes to the meter its address fits, by id.
  const other = {
    id: 'm-2',
    account: '123456789',
    maddr: '10 EXAMPLE ST,TEST FIELD EXAMPLETON KS',
    bills: [mkHist(2024, 900, '10 EXAMPLE ST'), mkHist(2025, 950, '10 EXAMPLE ST')],
  };
  sb.__other = other;
  run('_tagHistoryMeterBills(__other)');
  cache['123456789'] = meter.bills.concat(other.bills);
  sb.__b = bill(57000, '08/27/2026', '09/28/2026');
  const two = run('_historyForBill(__b, __cache)');
  check('outlier: two meters on one account, the bill takes only its own meter\'s bills', two.length === meter.bills.length && two.every((b) => meter.bills.includes(b)), 'got ' + two.length);
}

// ---- 2b. history by meter id, outlier swing -------------------------------------------------
{
  const mkM = (id, maddr, kwhs) => ({
    id,
    account: '100200300',
    meter: '',
    maddr,
    bills: kwhs.map((k, i) => ({
      id: id + '-' + i,
      start: 2023 + i + '-08-27',
      end: 2023 + i + '-09-28',
      kwh: String(k),
      totalCost: String(k * 0.1),
      serviceAddress: '10 EXAMPLE ST',
    })),
  });
  const bill = (kwh, addr) => ({
    Commodity: 'Electric',
    AccountNumber: '100200300',
    ServiceAddress: addr,
    BillingPeriodStart: '08/27/2026',
    BillingPeriodEnd: '09/28/2026',
    kWhConsumed: String(kwh),
    TotalCurrentCharges: String(kwh * 0.1),
  });
  const ADDR = '10 EXAMPLE ST,TEST SCHOOL EXAMPLETON KS';
  const warns = (m, b) => {
    sb.__ms = Array.isArray(m) ? m : [m];
    sb.__ms.forEach((x) => (sb.__x = x) && run('_tagHistoryMeterBills(__x)'));
    sb.__cache = { 100200300: [].concat(...sb.__ms.map((x) => x.bills)) };
    sb.__b = b;
    return run('detectStatisticalOutliers(__b, __cache, {})');
  };
  const school = () => mkM('m-s', ADDR, [50000, 52000, 54000]); // same-month mean 52000
  check('outlier: a normal seasonal bill (1.1x) does not warn', warns(school(), bill(57000, ADDR)).length === 0);
  check('outlier: a doubled bill warns', warns(school(), bill(104000, ADDR)).some((w) => w.level === 'warn' && w.field === 'kWhConsumed'));
  check('outlier: a 0.5x bill warns', warns(school(), bill(26000, ADDR)).some((w) => w.level === 'warn' && w.field === 'kWhConsumed'));
  check('outlier: a 1.9x bill does not warn', warns(school(), bill(98000, ADDR)).filter((w) => w.level === 'warn').length === 0);
  // Meter with no recorded address: no history, no warning, even for a huge value.
  check('history: a meter with no address gives no history', warns(mkM('m-n', '', [50000, 52000, 54000]), bill(900000, ADDR)).length === 0);
  // Bill with no address: no history, no warning (a lone meter is not assumed).
  check('history: a bill with no address gives no history', warns(school(), bill(900000, '')).length === 0);
  // Sibling meter with no bills in the cache must not borrow the school's history.
  const sibling = { id: 'm-f', account: '100200300', maddr: '10 EXAMPLE ST,TEST FIELD EXAMPLETON KS', bills: [] };
  check(
    'history: a bill whose address fits no stored meter clearly gets no history',
    warns([school(), sibling], bill(900000, '77 OTHER RD,NOWHERE KS')).length === 0,
  );
}

// ---- 3. ECA one-digit rate repair -------------------------------------------------------
{
  const f = (r, q, c) => run('_evgRateOneDigitRepair(' + r + ',' + q + ',' + c + ')');
  check('eca: 0.01817 read for 0.01917 is repaired', f(0.01817, 56585.2665, 1084.74) === 0.01917, String(f(0.01817, 56585.2665, 1084.74)));
  check('eca: a rate that already reconciles is left alone', f(0.01917, 56585.2665, 1084.74) === null);
  check('eca: two digits wrong is not repaired', f(0.01827, 56585.2665, 1084.74) === null);
  check('eca: a charge that does not match any one-digit rate is not repaired', f(0.01817, 56585.2665, 1090.1) === null);
  check('eca: a blank charge or qty is never filled', f(0.01817, 56585.2665, 0) === null && f(0.01817, 0, 1084.74) === null);
  const ok = { CustomerCharge: '100.00', ECACharge: '900.00', TotalCurrentCharges: '1000.00' };
  const off = { CustomerCharge: '100.00', ECACharge: '900.00', TotalCurrentCharges: '1000.50' };
  sb.__ok = ok;
  sb.__off = off;
  check('eca: charges that sum to the printed total pass the gate', run('_evgChargesReconcile(__ok)') === true);
  check('eca: charges that do not sum to the printed total fail the gate', run('_evgChargesReconcile(__off)') === false);
}

// ---- 4. one implied-rate warning ------------------------------------------------------
{
  sb.__b = {
    Commodity: 'Electric',
    AccountNumber: '123456789',
    kWhConsumed: '100',
    EnergyOnPeakCharge: '5000.00',
    BillingPeriodStart: '08/01/2026',
    BillingPeriodEnd: '08/31/2026',
    TotalCurrentCharges: '5000.00',
  };
  const v = run("validateBillData(__b, 'Utility E')").filter((w) => /rate/i.test(w.message));
  const s = run('detectStatisticalOutliers(__b, {}, {})').filter((w) => /rate/i.test(w.message));
  check('rate: validateBillData reports the implied rate once', v.length === 1, JSON.stringify(v));
  check('rate: detectStatisticalOutliers does not repeat it', s.length === 0, JSON.stringify(s));
  check('rate: no stray dollar sign in the unit', !v.some((w) => /\$\/kWh\$|kWh\$/.test(w.message)));
}

console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
