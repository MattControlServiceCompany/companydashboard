/**
 * test-meter-dedupe-no-auto-merge.js
 * The duplicate check must not run on load, must only flag true duplicates, and must never
 * merge, delete or save. SYNTHETIC data only.
 * Usage: node tools/test-meter-dedupe-no-auto-merge.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'utility-data.js'), 'utf8').replace(/\r\n/g, '\n');
let fails = 0;
const check = (name, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) fails++;
};
const blk = src.match(/\/\/ ── duplicate check begin[\s\S]*?\/\/ ── duplicate check end/);
if (!blk) {
  console.log('FAIL duplicate check block not found');
  process.exit(1);
}
const sb = { console: { info() {}, warn() {}, log() {}, table() {} } };
vm.createContext(sb);
vm.runInContext(blk[0] + '\nthis.api={seed:_seedMeterBillCounts,collect:_collectDuplicateCandidates};', sb);
const api = sb.api;

const bill = (o) =>
  Object.assign({ start: '2025-01-01', end: '2025-02-01', totalCost: '100', kwh: '1000', rateSchedule: 'R1' }, o);
const meter = (id, o) =>
  Object.assign({ id, commodity: 'Electric', account: '000-111', meter: '', maddr: '1 Main St', bills: [bill()] }, o);
const cust = (meters) => ({ buildings: [{ id: 'b1', name: 'Bldg', meters }] });
const next = { start: '2025-02-01', end: '2025-03-01' };
// Seed (= end of load), confirm the untouched data reports nothing, then add a bill and collect.
const scenario = (build, mutate) => {
  const data = { c1: cust(build()) };
  api.seed(data);
  const baseOk = api.collect(data.c1).length === 0;
  mutate(data.c1.buildings[0].meters);
  const snap = JSON.stringify(data);
  const lines = api.collect(data.c1);
  return { baseOk, lines, untouched: JSON.stringify(data) === snap };
};

// (a) load does not run the check
sb.__x = cust([meter('a'), meter('b')]);
sb.__x.buildings[0].meters[0].bills.push(bill(next));
vm.runInContext('_meterBillCounts = null', sb);
check('(a) unseeded (save during load) -> no lines', api.collect(sb.__x).length === 0);
const loadFn = src.match(/function loadUtilityData\(\) \{[\s\S]*?\n}\n/)[0];
check(
  '(a) loadUtilityData only seeds, never collects',
  /_seedMeterBillCounts\(/.test(loadFn) && !/_collectDuplicateCandidates/.test(loadFn),
);

// (b) adding a bill to a meter with a same-account/address/rate twin -> one flag
let r = scenario(
  () => [meter('a'), meter('b')],
  (ms) => ms[0].bills.push(bill(next)),
);
check(
  '(b) twin meter (same acct+addr+rate) flagged once',
  r.baseOk && r.lines.length === 1 && /duplicate meter/.test(r.lines[0]) && r.untouched,
);

// HS/Ballfields-style: same account, different address and rate -> no flag
r = scenario(
  () => [
    meter('a', { bills: [bill({ rateSchedule: '2LGSF' })] }),
    meter('b', { maddr: '1 Main St, Ballfields', bills: [bill({ rateSchedule: '2MGSE' })] }),
  ],
  (ms) => ms[1].bills.push(bill(Object.assign({ rateSchedule: '2MGSE' }, next))),
);
check('Ballfields-style pair (diff address/rate) -> no flag', r.lines.length === 0 && r.untouched);
// same address but different rate -> no flag
r = scenario(
  () => [meter('a', { bills: [bill({ rateSchedule: 'X' })] }), meter('b', { bills: [bill({ rateSchedule: 'Y' })] })],
  (ms) => ms[0].bills.push(bill(Object.assign({ rateSchedule: 'X' }, next))),
);
check('same account+address, different rate -> no flag', r.lines.length === 0);
// blank meter numbers and blank address never match
r = scenario(
  () => [meter('a', { maddr: '' }), meter('b', { maddr: '' })],
  (ms) => ms[0].bills.push(bill(next)),
);
check('blank meter numbers / blank address -> no flag', r.lines.length === 0);
r = scenario(
  () => [meter('a', { meter: '77', maddr: 'x' }), meter('b', { meter: '77', maddr: 'y' })],
  (ms) => ms[0].bills.push(bill(next)),
);
check('same meter number + commodity -> flagged', r.lines.length === 1);
r = scenario(
  () => [meter('a', { meter: '11' }), meter('b', { meter: '22' })],
  (ms) => ms[0].bills.push(bill(next)),
);
check('different meter numbers -> no flag', r.lines.length === 0);

// bills
r = scenario(
  () => [meter('a')],
  (ms) => ms[0].bills.push(bill({ totalCost: '250' })),
);
check('same meter+period, different totals -> no flag', r.lines.length === 0 && r.untouched);
r = scenario(
  () => [meter('a')],
  (ms) => ms[0].bills.push(bill()),
);
check(
  'exact same bill saved twice -> one flag',
  r.lines.length === 1 && /duplicate bill/.test(r.lines[0]) && r.untouched,
);
r = scenario(
  () => [meter('a', { bills: [bill({ pdfKey: 'k', pdfPageStart: 3 })] })],
  (ms) =>
    ms[0].bills.push(bill({ start: '2025-05-01', end: '2025-06-01', totalCost: '9', pdfKey: 'k', pdfPageStart: 3 })),
);
check('same pdfKey + page -> flagged', r.lines.length === 1);
r = scenario(
  () => [meter('a', { bills: [bill({ pdfKey: 'k', pdfPageStart: 3 })] })],
  (ms) =>
    ms[0].bills.push(bill({ start: '2025-05-01', end: '2025-06-01', totalCost: '9', pdfKey: 'k', pdfPageStart: 4 })),
);
check('same pdfKey, different page -> no flag', r.lines.length === 0);

// (c) nothing saved / merged / deleted by the check
check(
  '(c) check block has no sset/DB.set/saveUtilityData/splice/delete',
  !/sset\(|DB\.set|saveUtilityData|\.splice\(|\bdelete\b/.test(blk[0].replace(/^\s*\/\/.*$/gm, '')),
);
const saveFn = src.match(/function saveUtilityData\(pid\) \{[\s\S]*?\n}\n/)[0];
check(
  '(c) saveUtilityData: collects per target, exactly one console.info',
  /_collectDuplicateCandidates\(/.test(saveFn) && (saveFn.match(/console\.info/g) || []).length === 1,
);
check(
  'old load-time merge removed',
  !/_meterDedupeMerged|_logMeterDedupeCandidates|overlapping bill periods/.test(src),
);
process.exit(fails ? 1 : 0);
