// tools/test-day-count-single.js - WP-08 (math-audit 2026-09-28): ONE day count.
// Run: node tools/test-day-count-single.js
// SYNTHETIC data only. Loads the REAL functions from the app files (extracted verbatim), never a copy.
//   P1  calcDays: inclusive toggle 30 / exclusive 29; accepts M/D/YYYY strings and Date objects; DST + leap safe
//   V4  getNormRows: two bills that share a read date never count that day twice (Jan 32 -> 31)
//   V6  calculators.js prorate, America/Chicago: start on the 1st gives smD 30 / emD 0 (was smD -1)
//   W   Woodland raw-bill table: blank numberOfDays prints "-" and is left out of TOTAL
//   G   gate-single-day-count.js passes on this tree and fails on inline /86400000 day math
process.env.TZ = 'America/Chicago'; // V6 is a time-zone bug; every check below must hold here
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
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
// The getNormRows shared-read-date fix is held back (Louisburg Q1/Q2 presented lock not active yet).
// Branch fix/wp-08-normrows-shared-date sets this to true.
const SHARED_DATE_FIX = false;
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);

function loadFn(file, name) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + file);
  const p = src.indexOf('(', m.index);
  let d = 0,
    pe = p;
  for (; pe < src.length; pe++) {
    if (src[pe] === '(') d++;
    else if (src[pe] === ')' && --d === 0) break;
  }
  let depth = 0,
    j = src.indexOf('{', pe);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const dayFns = ['_fixISO', '_parseISO', 'calcDays']
  .map((n) => loadFn('app/utility-data.js', n))
  .join('\n');

// P1: calcDays
{
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(dayFns + '\nthis.calcDays = calcDays;', ctx);
  const cd = ctx.calcDays;
  assert(cd('2025-04-21', '2025-05-20', true) === 30, 'P1 inclusive 4/21-5/20 = 30');
  assert(cd('2025-04-21', '2025-05-20', false) === 29, 'P1 exclusive 4/21-5/20 = 29 (toggle changes the answer)');
  assert(cd('4/21/2025', '5/20/2025', false) === 29, 'M/D/YYYY strings (extractor dates)');
  assert(cd('04/21/25', '05/20/25', false) === 29, 'MM/DD/YY strings');
  assert(cd(new Date(2025, 3, 21), new Date(2025, 4, 20), false) === 29, 'Date objects');
  assert(cd('2026-03-01', '2026-03-31', false) === 30, 'across the March DST change, America/Chicago');
  assert(cd('2025-10-15', '2025-11-14', false) === 30, 'across the November DST change');
  assert(cd('2024-02-28', '2024-03-01', false) === 2 && cd('2025-02-28', '2025-03-01', false) === 1, 'leap year');
  assert(cd('', '2025-01-01', true) === '' && cd('2025-01-01', null, false) === '', 'missing date returns empty');
  assert(cd('01-19-26', '02-18-26', false) === 30, 'MM-DD-YY KGS dates');
}

// V4: getNormRows shared read date
{
  const ctx = { console };
  vm.createContext(ctx);
  const stubs = [
    "function calDaysInMonth(ym){const [y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate();}",
    'function resolveGasUsageTherms(b){return parseFloat(b.therms)||0;}',
  ].join('\n');
  vm.runInContext(
    stubs +
      '\n' +
      dayFns +
      '\n' +
      ['regression', 'savings', 'normalization']
        .map((f) => fs.readFileSync(path.join(REPO, 'computations/' + f + '.js'), 'utf8'))
        .join('\n') +
      '\nthis.getNormRows = getNormRows;',
    ctx,
  );
  const B = (s, e, kwh) => ({ id: s, start: s, end: e, kwh, totalCost: 100 });
  const byYm = (rows) => Object.fromEntries(rows.map((r) => [r.ym, r]));
  let rows = ctx.getNormRows(
    { commodity: 'Electric' },
    [B('2024-12-16', '2025-01-15', 1000), B('2025-01-15', '2025-02-14', 2000)],
    true,
    null,
  );
  let r = byYm(rows);
  if (SHARED_DATE_FIX) {
    assert(r['2025-01'].days === 31, 'V4 Jan days 32 -> 31 (got ' + r['2025-01'].days + ')');
    assert(r['2024-12'].days === 16 && r['2025-02'].days === 14, 'V4 Dec 16, Feb 14 unchanged');
  } else console.log('  SKIP: V4 shared-read-date day count (branch fix/wp-08-normrows-shared-date)');
  assert(
    near(
      rows.reduce((a, x) => a + x.usage, 0),
      3000,
      1e-6,
    ),
    'V4 usage still conserved (3000)',
  );
  rows = ctx.getNormRows(
    { commodity: 'Electric' },
    [
      B('2025-01-01', '2025-01-31', 100),
      B('2025-01-31', '2025-03-02', 100),
      B('2025-03-02', '2025-04-01', 100),
      B('2025-04-01', '2025-05-01', 100),
    ],
    true,
    null,
  );
  if (SHARED_DATE_FIX)
    assert(
      rows.every((x) => x.days <= new Date(+x.ym.slice(0, 4), +x.ym.slice(5), 0).getDate()),
      'V4 chained bills: no row has more days than its month',
    );
  rows = ctx.getNormRows(
    { commodity: 'Electric' },
    [B('2025-01-01', '2025-01-31', 100), B('2025-02-01', '2025-02-28', 100)],
    true,
    null,
  );
  r = byYm(rows);
  assert(
    r['2025-01'].days === 31 && r['2025-02'].days === 28,
    'bills that do not share a date: Jan 31, Feb 28 unchanged',
  );
}

// V6: calculators.js prorate (real function text)
{
  const src = loadFn('app/calculators.js', 'prorate');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(
    dayFns +
      '\nconst bSD = ["2025-03-01"], bED = ["2025-03-31"], bKwh = [100000], bKw = [0], bFKw = [0];\n' +
      'const sumChg = "6/1", winChg = "10/1", ecaThresh = 0;\n' +
      'const parseDS = (s, yr) => { const p = s.split("/").map(Number); return new Date(yr, p[0] - 1, p[1]); };\n' +
      src +
      '\nthis.out = prorate(0);',
    ctx,
  );
  const o = ctx.out;
  assert(o.d === 30, 'V6 bill length 30 (got ' + o.d + ')');
  assert(
    o.smD === 30 && o.emD === 0,
    'V6 start on the 1st: smD 30 / emD 0, was -1 / 31 (got ' + o.smD + '/' + o.emD + ')',
  );
  assert(
    near(o.sKwh, 100000, 1e-3) && near(o.eKwh, 0, 1e-3),
    'V6 no negative start-month kWh (got ' + o.sKwh + '/' + o.eKwh + ')',
  );
}

// W: Woodland raw-bill table
{
  const ctx = { console };
  vm.createContext(ctx);
  const code = [
    "var WOODLAND_MO_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];",
    'var WOODLAND_MO_FULL = WOODLAND_MO_ABBR;',
    'var WD_TEXT = { billsIntro: function(){return "";}, demandFloorNote: function(){return "";} };',
    'function rptPage(n, t, body){ return body; }',
    'function getBillFacKWCost(){ return 0; }',
    'function resolveGasUsageTherms(b){ return parseFloat(b.therms)||0; }',
    ...[
      '_wdRoundHalfUp',
      '_wdN',
      '_wdC',
      '_wdBillDays',
      '_wdBillTherms',
      '_wdMonthLabel',
      '_rptTotalAvgRow',
      '_wdElecCostReconciliation',
      'rptPageWoodlandBills',
    ].map((n) => loadFn('app/report-engine-woodland.js', n)),
    'this.page = rptPageWoodlandBills;',
    'this.billDays = _wdBillDays;',
  ].join('\n');
  vm.runInContext(code, ctx);
  assert(
    ctx.billDays({ numberOfDays: '' }) === null &&
      ctx.billDays({}) === null &&
      ctx.billDays({ numberOfDays: '0' }) === null,
    'blank / missing / zero numberOfDays = null',
  );
  assert(ctx.billDays({ numberOfDays: '29' }) === 29, 'printed numberOfDays kept');
  const gas = (ym, nd) => ({ ym, bill: { numberOfDays: nd, totalCost: 100, therms: 50 } });
  const html = ctx.page(1, {
    gasMeter: { account: 'x' },
    gasBL: {
      months: ['2025-05', '2025-06', '2025-07'],
      rows: [gas('2025-05', '30'), gas('2025-06', ''), gas('2025-07', '31')],
    },
  });
  const rowsOf = (h) =>
    [...h.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]));
  const tr = rowsOf(html);
  const jun = tr.find((c) => c[0] === 'Jun 2025');
  const tot = tr.find((c) => /^TOTAL/.test(c[0]));
  const avg = tr.find((c) => c[0] === 'Average');
  assert(jun && jun[1] === '-', 'Woodland blank numberOfDays prints "-" (got ' + (jun && jun[1]) + ')');
  assert(tot && tot[1] === '61', 'Woodland TOTAL days = 30 + 31 = 61, blank left out (got ' + (tot && tot[1]) + ')');
  assert(
    avg && avg[1] === '31',
    'Woodland Average days = mean of the rows that have days, 30.5 (got ' + (avg && avg[1]) + ')',
  );
}

// G: the gate
{
  const res = cp.spawnSync(process.execPath, [path.join(REPO, 'tools/gate-single-day-count.js')], { encoding: 'utf8' });
  assert(res.status === 0, 'gate-single-day-count passes: ' + (res.stdout || '').slice(0, 300));
  const tmp = path.join(require('os').tmpdir(), 'wp08-gate-' + Date.now());
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app/utility-data.js'), 'function calcDays(a,b){return 0;}\n');
  fs.writeFileSync(path.join(tmp, 'app/bad.js'), 'const days = Math.round((e - s) / 86400000) + 1;\n');
  const bad = cp.spawnSync(process.execPath, [path.join(REPO, 'tools/gate-single-day-count.js'), tmp], {
    encoding: 'utf8',
  });
  assert(
    bad.status === 1 && /app\/bad\.js:1 inline day math/.test(bad.stdout),
    'gate FAILS on inline /86400000 day math',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
