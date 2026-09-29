// tools/test-presented-savings-lock.js — acceptance test for the "presented to client" savings lock (WP-04a).
// Run: node tools/test-presented-savings-lock.js
// SYNTHETIC data only. Rule (Matt, 2026-09-29): quarterly savings already presented to the client
// can not change. Asserts: after marking a period, changing a bill or the savings math does not
// change that period's numbers in the keeper (getMeterSavings), the rollups, the Meter Performance
// table and the report notice; unmarked months still recompute; removing the mark restores recompute.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('FAIL: ' + msg);
  }
}
function near(a, b) {
  return typeof a === 'number' && Math.abs(a - b) < 0.005;
}

const store = {};
const sb = { console, projects: [{ id: 9001, sa: 'SA-TEST', inclMonths: {} }], utilityData: {} };
sb.window = sb;
sb.sget = (k, d) => (store[k] !== undefined ? JSON.parse(JSON.stringify(store[k])) : d);
sb.sset = (k, v) => {
  store[k] = JSON.parse(JSON.stringify(v));
  return Promise.resolve();
};
vm.createContext(sb);
const ymList = (y, a, b) => {
  const o = [];
  for (let i = a; i <= b; i++) o.push(y + '-' + String(i).padStart(2, '0'));
  return o;
};
function bill(ym, therms, rate) {
  const [y, mo] = ym.split('-');
  const last = new Date(+y, +mo, 0).getDate();
  return {
    start: ym + '-01',
    end: ym + '-' + String(last).padStart(2, '0'),
    therms,
    usage: therms,
    totalGasRate: rate,
    gasCharge: therms * rate,
  };
}
const bills = ymList('2024', 1, 12)
  .map((ym) => bill(ym, 1000, 1.0))
  .concat(ymList('2025', 1, 6).map((ym) => bill(ym, 800, 1.0)));
const meter = { id: 'm-syn-1', commodity: 'Gas', bills, baseline: { months: ymList('2024', 1, 12) } };
const bldg = { id: 'b-syn-1', name: 'Synthetic Hall', meters: [meter] };
sb.utilityData[9001] = { buildings: [bldg] };

vm.runInContext(
  [
    'function getUDProj(pid){return utilityData[pid]||(utilityData[pid]={buildings:[]});}',
    'function getUDBldgs(pid){return getUDProj(pid).buildings;}',
    'function getUDBldg(pid,bid){return getUDBldgs(pid).find(function(b){return b.id===bid;});}',
    'var DB={get:function(k,d){return sget(k,d===undefined?null:d);}};',
    'function isBaselineExcluded(){return false;}',
    'function getWeatherForBuilding(){return {byYm:{}};}',
    'function isCalcCommodity(){return true;}',
    'var udSelProjId=9001, udSelBldgId=null;',
    'function projHasContract(pid){return true;}',
  ].join('\n'),
  sb,
);
function readSrc(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
function loadFn(rel, name) {
  const src = readSrc(rel);
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('fn not found ' + name);
  const i = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
vm.runInContext(['_fixISO', '_parseISO', 'calcDays'].map((n) => loadFn('app/utility-data.js', n)).join('\n'), sb);
const html = readSrc('energy-department.html');
const libs = [];
const re = /<script\s+src="((?:lib|computations)\/[^"?]+\.js)/g;
let mm;
while ((mm = re.exec(html))) if (libs.indexOf(mm[1]) < 0) libs.push(mm[1]);
libs.forEach((rel) => {
  try {
    vm.runInContext(readSrc(rel), sb, { filename: rel });
  } catch (e) {
    console.log('WARN load ' + rel + ': ' + e.message);
  }
});
const SUMMER = /const SUMMER_MOS = \[[^\]]*\];/.exec(readSrc('app/energy-savings.js'));
if (SUMMER) vm.runInContext(SUMMER[0].replace('const ', 'var '), sb);

function sortedBills() {
  return meter.bills.slice().sort((a, c) => a.start.localeCompare(c.start));
}
function sav() {
  meter._savingsCache = null;
  meter._savingsCacheKey = null;
  return sb.getMeterSavings(meter, sortedBills(), {}, 9001, bldg.id);
}
function billOf(start) {
  return meter.bills.find((x) => x.start === start);
}
const Q = ymList('2025', 1, 3);
const before = sav();
assert(
  Q.every((ym) => near(before.byYM[ym], 200)),
  'setup: each Q1 month saves 200 therms x $1.00 = $200 (got ' + JSON.stringify(before.byYM) + ')',
);
assert(near(before.byYM['2025-04'], 200), 'setup: April also saves $200');

assert(typeof sb.markSavingsPresented === 'function', 'markSavingsPresented exists');
assert(typeof sb.removePresentedMark === 'function', 'removePresentedMark exists');
assert(typeof sb.getPresentedNotice === 'function', 'getPresentedNotice exists');
if (typeof sb.markSavingsPresented !== 'function') {
  console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}

assert(sb.getPresentedNotice(9001, Q) === '', 'no notice before marking');
const rec = sb.markSavingsPresented(9001, Q);
assert(
  rec && rec.projectId === '9001' && rec.periodStart === '2025-01' && rec.periodEnd === '2025-03',
  'record has project and period',
);
assert(rec && near(rec.totalDollars, 600), 'record total is $600');
const r2 = rec && rec.months[meter.id] && rec.months[meter.id]['2025-02'];
assert(
  r2 && near(r2.dollars, 200) && near(r2.thermsSaved, 200) && near(r2.rate.unit, 1),
  'record holds per-meter per-month therms, $ and rate',
);
assert(!!rec && !!rec.presentedAt, 'record has presentedAt');
assert(
  /^Presented to client on .+\. Figures are locked\.$/.test(sb.getPresentedNotice(9001, Q)),
  'notice text after marking: ' + sb.getPresentedNotice(9001, Q),
);
assert(sb.getPresentedNotice(9001, ymList('2025', 4, 6)) === '', 'no notice for an unmarked quarter');

// Change a bill (Feb usage up) and the math (rate on Mar, override on Jan); change April (unmarked).
billOf('2025-02-01').therms = 1500;
billOf('2025-02-01').usage = 1500;
billOf('2025-03-01').totalGasRate = 2.5;
meter.baseline.costSavOverrides = { '2025-01': 12345 };
billOf('2025-04-01').therms = 500;
billOf('2025-04-01').usage = 500;
const after = sav();
Q.forEach((ym) =>
  assert(near(after.byYM[ym], 200), 'presented ' + ym + ' unchanged at $200 (got ' + after.byYM[ym] + ')'),
);
assert(after.unitsByYM['2025-02'] && near(after.unitsByYM['2025-02'].therms, 200), 'presented Feb therms unchanged');
assert(near(after.byYM['2025-04'], 500), 'unmarked April recomputes to $500 (got ' + after.byYM['2025-04'] + ')');
assert(near(after.byCalMo[0], 200) && near(after.byCalMo[3], 500), 'byCalMo follows the same locked values');
const roll = sb.getProjectSavingsByYM(9001);
assert(near(roll['2025-02'], 200) && near(roll['2025-04'], 500), 'project rollup uses locked + recomputed months');
assert(near(before.byYM['2025-01'], 200), 'earlier result object not mutated');

// Meter Performance table rows.
if (typeof sb.buildMeterPerfTableHTML === 'function') {
  const pt = sb.buildMeterPerfTableHTML(meter, sortedBills(), {}, { projId: 9001, bldgId: bldg.id, mode: 'report' });
  const byYm = {};
  (pt.rows || []).forEach((r) => {
    byYm[r.ym] = r;
  });
  assert(
    Q.every((ym) => byYm[ym] && near(byYm[ym].savings, 200)),
    'perf table presented months show locked $ (' + JSON.stringify(Q.map((y) => byYm[y] && byYm[y].savings)) + ')',
  );
  assert(byYm['2025-04'] && near(byYm['2025-04'].savings, 500), 'perf table unmarked April recomputes');
} else assert(false, 'buildMeterPerfTableHTML loaded');

// Remove the mark: everything recomputes; notice gone.
assert(sb.removePresentedMark(9001, Q) === true, 'removePresentedMark returns true');
const restored = sav();
assert(
  near(restored.byYM['2025-01'], 12345) && near(restored.byYM['2025-03'], 200 * 2.5),
  'after remove, Jan/Mar recompute (Jan ' + restored.byYM['2025-01'] + ', Mar ' + restored.byYM['2025-03'] + ')',
);
assert(sb.getPresentedNotice(9001, Q) === '', 'no notice after remove');
assert(sb.removePresentedMark(9001, Q) === false, 'second remove returns false');

console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
