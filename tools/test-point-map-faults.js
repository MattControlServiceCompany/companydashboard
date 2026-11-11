// tools/test-point-map-faults.js: point mapping must not turn a fault, alarm or status point into a command (item 45832938),
// and a boiler outlet must not win over a system hot water supply point.
// Run: node tools/test-point-map-faults.js
// Loads the real app/equipment-matrix.js into a vm sandbox. SYNTHETIC point names only.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log('PASS ' + msg);
  } else {
    failed++;
    console.log('FAIL ' + msg);
  }
}

const sandbox = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => fb,
  sset: () => Promise.resolve(),
  DB: { get() {}, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8'), sandbox, { filename: 'app/equipment-matrix.js' });
const CATS = vm.runInContext('EM_POINT_CATEGORIES', sandbox);

// ---- 1. a fault, alarm, failure, status or diagnostic point never maps to a command category ----
const isCmdKey = (k) => /(Cmd|Command)$/.test(k);
const SUFFIXES = ['Faulted', 'Fault', 'Alarm', 'Failure', 'Failed', 'Status', 'Diagnostic'];
let cmdCats = 0;
let bad = [];
Object.keys(CATS).forEach((equip) => {
  if (equip === '_broadcast') return;
  CATS[equip].forEach((cat) => {
    if (!isCmdKey(cat.key)) return;
    cmdCats++;
    const bases = [cat.label, cat.ashrae36Name].concat(cat.aliases || []);
    bases.forEach((base) => {
      if (!base) return;
      SUFFIXES.forEach((sfx) => {
        const name = base + ' ' + sfx;
        const m = sandbox.emNormalizePoint(name, equip);
        if (m && m.categoryKey === cat.key) bad.push(equip + ': "' + name + '" -> ' + cat.key);
      });
    });
  });
});
check(cmdCats > 5, 'found ' + cmdCats + ' command categories to test');
check(bad.length === 0, 'no fault/alarm/status name maps to a command category' + (bad.length ? ' (' + bad.length + ' bad, first: ' + bad[0] + ')' : ''));

// The case that was wrong: an air handler with a supply fan drive fault point.
const m1 = sandbox.emNormalizePoint('Supply Fan VFD Faulted', 'ahu');
check(!m1 || m1.categoryKey !== 'sfSpeedCmd', '"Supply Fan VFD Faulted" does not map to sfSpeedCmd');
const m2 = sandbox.emNormalizePoint('Supply Fan VFD Status', 'ahu');
check(!m2 || m2.categoryKey !== 'sfSpeedCmd', '"Supply Fan VFD Status" does not map to sfSpeedCmd');
const m2b = sandbox.emNormalizePoint('OA Damper Enabled, Status Is Closed', 'ahu');
check(!m2b || m2b.categoryKey !== 'oaDampCmd', '"OA Damper Enabled, Status Is Closed" does not map to oaDampCmd');
// Round 3: a drive measurement (amps, voltage, current) or a bypass state is feedback, never a command.
[
  ['Supply Fan VFD Amps', 'rtu'],
  ['Supply Fan VFD Voltage', 'rtu'],
  ['Supply Fan VFD Current', 'ahu'],
  ['Supply Fan 2 VFD Bypass Initiated', 'ahu'],
  ['Return Fan VFD Amps', 'ahu'],
].forEach(([name, equip]) => {
  const m = sandbox.emNormalizePoint(name, equip);
  check(!m || !/(Cmd|Command)$/.test(m.categoryKey), '"' + name + '" does not map to a command (got ' + (m && m.categoryKey) + ')');
});
const mSig = sandbox.emNormalizePoint('Supply Fan VFD Signal', 'ahu');
check(mSig && mSig.categoryKey === 'sfSpeedCmd', '"Supply Fan VFD Signal" (the speed output) still maps to sfSpeedCmd (got ' + (mSig && mSig.categoryKey) + ')');

// Real command points still map.
const cmdOk = [
  ['Supply VFD Speed', 'ahu', 'sfSpeedCmd'],
  ['Supply Fan VFD', 'ahu', 'sfSpeedCmd'],
  ['OA Damper Command', 'ahu', 'oaDampCmd'],
];
cmdOk.forEach(([name, equip, key]) => {
  const m = sandbox.emNormalizePoint(name, equip);
  check(m && m.categoryKey === key, '"' + name + '" still maps to ' + key + ' (got ' + (m && m.categoryKey) + ')');
});

// ---- 1b. a VFD speed point with no feedback word is the speed command; feedback needs a feedback word ----
[
  ['Supply Fan VFD Speed', 'ahu', 'sfSpeedCmd'],
  ['SF VFD Speed', 'ahu', 'sfSpeedCmd'],
  ['Supply Fan VFD Speed Feedback', 'ahu', 'sfSpeed'],
  ['Supply Fan VFD Speed Actual', 'ahu', 'sfSpeed'],
  ['Supply Fan VFD Hz', 'ahu', 'sfSpeed'],
  ['Return Fan VFD Speed', 'ahu', 'rfSpeedCmd'],
  ['Supply Fan VFD Speed', 'rtu', 'sfSpeedCmd'],
].forEach(([name, equip, key]) => {
  const m = sandbox.emNormalizePoint(name, equip);
  check(m && m.categoryKey === key, '"' + name + '" (' + equip + ') -> ' + key + ' (got ' + (m && m.categoryKey) + ')');
});

// ---- 1c. one alias belongs to one category: no normalized alias or canonical name is in a command category and another category of the same equipment list ----
const dup = [];
Object.keys(CATS).forEach((equip) => {
  const owner = {};
  CATS[equip].forEach((cat) => {
    [cat.ashrae36Name || cat.label].concat(cat.aliases || []).forEach((a) => {
      const k = sandbox.emNormalizePointName(a);
      (owner[k] = owner[k] || new Set()).add(cat.key);
    });
  });
  Object.keys(owner).forEach((k) => {
    const keys = Array.from(owner[k]);
    if (keys.length > 1 && keys.some(isCmdKey)) dup.push(equip + ': "' + k + '" in ' + keys.join(', '));
  });
});
check(dup.length === 0, 'no alias is in a command category and a feedback category of one list' + (dup.length ? ' (' + dup.length + ' shared, first: ' + dup[0] + ')' : ''));

// ---- 2. hwSupplyTemp: a system supply point wins over a boiler outlet; a boiler outlet is used only when no system point exists ----
const hw = (raw) => sandbox.emGetNormalizedPoints({ id: 'r' + Math.random(), category: 'hwp', pointsRaw: raw }).hwSupplyTemp;
check(
  hw({ 'Boiler 1 Outlet Temperature': '81.6 F', 'Heating Water Supply Temperature': '125.0 F' }) === '125.0 F',
  'boiler outlet listed first: the system supply (125.0 F) wins',
);
check(
  hw({ 'Heating Water Supply Temperature': '125.0 F', 'Boiler 1 Outlet Temperature': '81.6 F' }) === '125.0 F',
  'system supply listed first: the system supply wins',
);
check(
  hw({ 'Boiler 1 Outlet Temperature': '81.6 F', 'Boiler 2 Outlet Temperature': '124.8 F' }) === '81.6 F',
  'no system supply: the first boiler outlet is used',
);
check(hw({ 'Boiler 2 Outlet Temperature': '124.8 F' }) === '124.8 F', 'only a boiler outlet: it is used');
check(
  hw({ 'Boiler 1 Outlet Temperature': '81.6 F', 'HW Supply Temp': '119.0 F' }) === '119.0 F',
  'HW Supply Temp wins over a boiler outlet',
);
// pass 2 path (row.points holds raw names)
const hwPts = sandbox.emGetNormalizedPoints({
  id: 'r-pts',
  category: 'hwp',
  points: { 'Boiler 1 Outlet Temperature': '81.6 F', 'Hot Water Supply Temperature': '121.0 F' },
}).hwSupplyTemp;
check(hwPts === '121.0 F', 'row.points path: the system supply wins');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
