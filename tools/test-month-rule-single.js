// tools/test-month-rule-single.js - ONE month rule (2026-10-13): billMonth(bill, meterBills) decides which
// calendar month a whole bill belongs to, for every field of buildMoMap and for every other reader.
// Run: node tools/test-month-rule-single.js     SYNTHETIC data only. Loads the REAL functions in a Node vm.
//   A  billMonth is the normMonth chain over the bill's own meter; one-date, start==end and no-date bills
//   B  buildMoMap: kWh, kW, cost, therms, rates all come from the same bills; no month empty while another holds two
//   C  the other readers (Budget actuals, Client B report raw-bill rows, data-quality month count, Solar baseline)
//      put the same bill in the same month
//   D  a bill ending on the 1st stays in its own month in a Central time zone run
//   E  gate: tools/gate-single-month-rule.js passes on this tree and FAILS on a temp tree with a second rule
process.env.TZ = 'America/Chicago';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const monthRuleSource = require('./month-rule-src.js');
const fnSource = monthRuleSource.fnSource;
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// Fixture meter (synthetic). Start month, end month and chain month differ on purpose:
//   Dec 29 -> Jan 29 (Jan), Jan 29 -> Mar 2 (Feb: 28 of 33 days), Mar 2 -> Mar 31 (Mar), Mar 31 -> Apr 30 (Apr)
// The end-month rule puts BOTH the Feb bill and the Mar bill in March and leaves February empty.
const B = (start, end, kwh, kw, cost) => ({
  start,
  end,
  kwh,
  billedKW: kw,
  demandKW: kw,
  totalCost: cost,
  therms: kwh / 10,
});
const ELEC = [
  B('2024-12-29', '2025-01-29', 1000, 100, 110),
  B('2025-01-29', '2025-03-02', 2000, 200, 220),
  B('2025-03-02', '2025-03-31', 3000, 300, 330),
  B('2025-03-31', '2025-04-30', 4000, 400, 440),
];
const MONTHS = ['2025-01', '2025-02', '2025-03', '2025-04'];

const src = [
  monthRuleSource(),
  fnSource(read('computations/normalization.js'), 'buildMoMap'),
  fnSource(read('app/budget.js'), 'getActualForMonth'),
  fnSource(
    fs
      .readdirSync(path.join(REPO, 'app'))
      .filter((f) => /^report-engine-.*\.js$/.test(f))
      .map((f) => read('app/' + f))
      .find((s) => s.includes('function _wdBuildMeterBaseline(')),
    '_wdBuildMeterBaseline',
  ),
  read('computations/data-quality.js').match(/function computeMeterQualityScore[\s\S]*$/)[0],
].join('\n\n');
const sandbox = {
  console,
  Math,
  parseFloat,
  Object,
  Array,
  getBillKwCost: () => 0,
  getBillFacKWCost: () => 0,
  getBillKwhCost: () => 0,
  getBillOtherCost: () => 0,
  getBillTaxCost: () => 0,
  getBillGasCost: () => 0,
  getMonthBillRate: () => 0,
  getStoredRate: () => 0,
  resolveGasUsageTherms: (b) => parseFloat(b.therms) || 0,
  computeMeterFlagSummary: () => ({ flaggedBills: 0 }),
};
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(src, ctx);
} catch (e) {
  console.log('load error: ' + e.message);
  process.exit(1);
}
const run = (code) => vm.runInContext(code, ctx);
ctx.__bills = ELEC;
const bm = (b) => ctx.billMonth(b, ELEC);

// ---- A ----
console.log('--- A. billMonth is the normMonth chain; one-date, start==end, no-date bills ---');
const chain = ELEC.map((b) => ctx.normMonth(b.start, b.end, true, ELEC));
assert(JSON.stringify(ELEC.map(bm)) === JSON.stringify(chain), 'billMonth equals the normMonth chain for every bill');
assert(
  JSON.stringify(chain) === JSON.stringify(['2025-01', '2025-02', '2025-03', '2025-04']),
  'chain months: ' + chain,
);
assert(ctx.billMonth({ start: '2025-06-15' }, []) === '2025-06', 'a bill with only a start date is in that date month');
assert(ctx.billMonth({ end: '2025-06-15' }, []) === '2025-06', 'a bill with only an end date is in that date month');
assert(
  ctx.billMonth({ start: '2025-06-30', end: '2025-06-30' }, [{ start: '2025-05-30', end: '2025-06-01' }]) === '2025-06',
  'start == end is that date month, not the next chain month',
);
assert(ctx.billMonth({}, ELEC) === '' && ctx.billMonth(null, ELEC) === '', 'a bill with no date is "" (left out)');
const other = [B('2025-02-10', '2025-03-10', 1, 1, 1)];
assert(ctx.billMonth(other[0], other) === '2025-02', 'meter B (own bills) gives its own month');
assert(ELEC.map(bm).join() === chain.join(), 'meter B bills never change meter A months');

// ---- B ----
console.log('--- B. buildMoMap: every field from the same bills ---');
const blRows = MONTHS.map((ym) => ({ ym, usage: 0, cost: 0, normDays: 30, regrBaseline: null, hdd: null, cdd: null }));
const meter = { commodity: 'Electric', id: 'm1' };
const map = ctx.buildMoMap(meter, blRows, ELEC, true);
const kwh = [1, 2, 3, 4].map((mo) => map.elecByMo[mo - 1].kwh);
assert(JSON.stringify(kwh) === JSON.stringify([1000, 2000, 3000, 4000]), 'kWh per month, one bill each: ' + kwh);
assert(map.elecByMo[1].kwh === 2000, 'Feb is not empty');
assert(map.elecByMo[2].kwh === 3000, 'Mar holds only the Mar bill (not doubled)');
const kw = [0, 1, 2, 3].map((mo) => map.elecByMo[mo].billedKW);
assert(JSON.stringify(kw) === JSON.stringify([100, 200, 300, 400]), 'billed kW comes from the same bill as kWh: ' + kw);
const cost = [0, 1, 2, 3].map((mo) => map.elecByMo[mo].totalCost);
assert(JSON.stringify(cost) === JSON.stringify([110, 220, 330, 440]), 'cost comes from the same bill as kWh: ' + cost);
const gmap = ctx.buildMoMap({ commodity: 'Gas', id: 'g1' }, blRows, ELEC, true);
assert(
  JSON.stringify([0, 1, 2, 3].map((mo) => gmap.gasByMo[mo].therms)) === JSON.stringify([100, 200, 300, 400]),
  'therms use the same month rule',
);
assert(
  JSON.stringify([0, 1, 2, 3].map((mo) => gmap.gasByMo[mo].cost)) === JSON.stringify([110, 220, 330, 440]),
  'gas cost uses the same month rule',
);
// two years of the same calendar month average over contributing years (cnt), each year by its own chain month
const yrBills = ELEC.concat([B('2026-01-01', '2026-01-31', 5000, 500, 550)]);
const map2 = ctx.buildMoMap(
  meter,
  blRows.concat([{ ym: '2026-01', usage: 0, cost: 0, normDays: 31, hdd: null, cdd: null }]),
  yrBills,
  true,
);
assert(
  near(map2.elecByMo[0].kwh, 3000) && near(map2.elecByMo[0].billedKW, 300),
  'two baseline years average: kWh 3000, kW 300',
);

// ---- C ----
console.log('--- C. other readers use the same month ---');
ctx.getUDBldgs = () => [{ id: 'b1', meters: [{ commodity: 'Electric', bills: ELEC }] }];
const act = (ym) => ctx.getActualForMonth(1, 'all', null, ym);
assert(
  act('2025-02') === 220 && act('2025-03') === 330,
  'Budget actual: Feb 220, Mar 330 (end-month rule gave Feb none, Mar 550)',
);
const wd = ctx._wdBuildMeterBaseline({ commodity: 'Electric', bills: ELEC, baseline: { months: MONTHS } });
assert(
  wd.rows.map((r) => r.ym).join() === MONTHS.join(),
  'Client B report raw-bill rows: one bill per month: ' + wd.rows.map((r) => r.ym),
);
const q = ctx.computeMeterQualityScore({ bills: ELEC, commodity: 'Electric' });
assert(q.components.dataMonths.rawValue === 4, 'data-quality month count 4, got ' + q.components.dataMonths.rawValue);

// ---- D ----
console.log('--- D. bill ending on the 1st, Central time ---');
const first = [B('2025-03-01', '2025-04-01', 1, 1, 1), B('2025-04-01', '2025-05-01', 1, 1, 1)];
assert(
  first.map((b) => ctx.billMonth(b, first)).join() === '2025-03,2025-04',
  'bills ending on the 1st: ' + first.map((b) => ctx.billMonth(b, first)),
);

// ---- E ----
console.log('--- E. gate ---');
const g = spawnSync(process.execPath, [path.join(REPO, 'tools', 'gate-single-month-rule.js')], { encoding: 'utf8' });
assert(g.status === 0, 'gate passes on this tree: ' + (g.stdout || '') + (g.stderr || ''));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'month-gate-'));
try {
  fs.mkdirSync(path.join(tmp, 'computations'));
  fs.mkdirSync(path.join(tmp, 'app'));
  fs.writeFileSync(path.join(tmp, 'computations', 'normalization.js'), 'function billMonth(b, all) { return ""; }\n');
  fs.writeFileSync(path.join(tmp, 'app', 'ok.js'), 'const ym = billMonth(bill, bills);\n');
  const ok = spawnSync(process.execPath, [path.join(REPO, 'tools', 'gate-single-month-rule.js'), tmp], {
    encoding: 'utf8',
  });
  assert(
    ok.status !== 0 && /stale ALLOWED/.test(ok.stdout),
    'temp tree without the allowed sites reports stale entries (gate is live)',
  );
  fs.writeFileSync(path.join(tmp, 'app', 'bad.js'), 'const bill = x;\nconst ym = bill.end.slice(0, 7);\n');
  const bad = spawnSync(process.execPath, [path.join(REPO, 'tools', 'gate-single-month-rule.js'), tmp], {
    encoding: 'utf8',
  });
  assert(
    bad.status === 1 && /app\/bad\.js:2 month cut near a bill date/.test(bad.stdout),
    'gate FAILS on an end-month copy: ' + bad.stdout,
  );
  fs.writeFileSync(path.join(tmp, 'app', 'bad.js'), 'function _wdAssignedYm(bill) { return 1; }\n');
  const old = spawnSync(process.execPath, [path.join(REPO, 'tools', 'gate-single-month-rule.js'), tmp], {
    encoding: 'utf8',
  });
  assert(old.status === 1 && /_wdAssignedYm/.test(old.stdout), 'gate FAILS when _wdAssignedYm comes back');
  fs.writeFileSync(path.join(tmp, 'computations', 'normalization.js'), 'function other() {}\n');
  fs.rmSync(path.join(tmp, 'app', 'bad.js'));
  const nofn = spawnSync(process.execPath, [path.join(REPO, 'tools', 'gate-single-month-rule.js'), tmp], {
    encoding: 'utf8',
  });
  assert(nofn.status === 1 && /does not define billMonth/.test(nofn.stdout), 'gate FAILS when billMonth is missing');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\ntest-month-rule-single: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
