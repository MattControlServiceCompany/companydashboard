// tools/test-a36-round3-rules.js: Detailed audit report round 3 rules (2026-11-14). SYNTHETIC names only.
//   1. Damper evidence: a terminal with a flow control loop (no zone damper point) has the damper command N/A (positive evidence); a bare terminal does not.
//   2. Supply fan: status and speed come from the air handler's own supply fan; a bypass fan or an ERV-prefixed supply fan never wins.
//   3. Dual-duct terminal: a cold deck air source and a hot deck air source (zone temperature, no supply fan) classify as dual-duct; an air handler with both does not.
//   4. Occupancy-based ventilation of a dual-duct box needs the two deck damper commands, not one damper command.
//   5. A numbered secondary pump drive status or speed is the hot water pump status or speed.
//   5b. Plant point mapping (2026-11-14): a present plant point is not missing (HWP drive status/enable/speed, hot water setpoint, chiller status on a chwp row);
//      alarms, amperage, setpoint limits and resets do not match. A plant stored as plumbing is priced like any other equipment (buildCatalogRows).
//   6. Reading format: CFM and ppm whole numbers with a thousands separator, degrees F one decimal, static pressure "in. w.c.".
//   7. Credible readings: a static pressure of 0 with the fan at speed, an outdoor airflow of 1 CFM with the damper open, a CO2 reading of exactly 400 ppm are dropped.
//   8. Client text: abbreviations spelled out (Temp, OA, CHW), "in H2O" becomes "in. w.c.", nested brackets flattened.
//   9. ASHRAE 36 section allow-list: every section cited in EM_SEQUENCE_DEFS, PRICE_POINT_MAP (g36Section), the point categories (ashrae36Section) and the report text is a
//      heading of the standard (verified against the 2021 text, 2026-11-14). A section that cannot be verified prints no number.
// Run: node tools/test-a36-round3-rules.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const SRC = read('app/equipment-matrix.js');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
const sandbox = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => fb,
  sset: () => Promise.resolve(),
  DB: { get: (k, fb) => fb, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
  _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'app/equipment-matrix.js' });
sandbox.window._emActivePid = 'synthetic';

function mkRow(id, name, category, pointsRaw, subtype) {
  return { id, building: 'Synthetic Hall', location: '', equipName: name, equipType: name, category, subtype: subtype || 'vav', points: Object.assign({}, pointsRaw), pointsRaw: pointsRaw || {}, checks: {}, schema: 2 };
}
const status = (row, key) => {
  const c = sandbox.emComputeCompliance(row, {}, []);
  if (c.coveredPoints.some((p) => p.categoryKey === key)) return 'covered';
  const na = c.naPoints.find((p) => p.categoryKey === key);
  if (na) return 'na:' + na.reason;
  return c.missingPoints.some((p) => p.categoryKey === key) ? 'missing' : 'absent';
};

// 1. damper evidence
const vavBase = { 'Zone Temp': '71 F', 'Air Flow': '300 cfm', 'Air Flow Set Point': '300 cfm' };
const withLoop = mkRow('v1', 'VAV-1', 'vav', Object.assign({ 'Flow Control': '' }, vavBase));
check(/^na/.test(status(withLoop, 'dampCmd')), '1. flow control loop: damper command is N/A (' + status(withLoop, 'dampCmd') + ')');
const bare = mkRow('v2', 'VAV-2', 'vav', vavBase);
check(status(bare, 'dampCmd') === 'missing', '1b. no damper and no flow control loop: still missing (' + status(bare, 'dampCmd') + ')');
const withDamper = mkRow('v3', 'VAV-3', 'vav', Object.assign({ 'Damper Position': '40 %' }, vavBase));
check(status(withDamper, 'dampCmd') === 'covered', '1c. a damper point counts as matched (' + status(withDamper, 'dampCmd') + ')');

// 2. supply fan source
const ahu = mkRow('a1', 'Building Air Handler', 'ahu', {
  'Bypass Fan Status': 'Off',
  'ERV Supply Fan VFD Speed': '100.0 %',
  'ERV Supply Fan VFD Status': 'On',
  'AHU-1 CD Supply Fan VFD Speed': '60.4 %',
  'AHU-1 CD Supply Fan VFD Status': 'On',
}, 'mtz');
const nrm = sandbox.emGetNormalizedPoints(ahu);
check(nrm.supplyFanStatus === 'On', '2. supply fan status is the air handler fan, not the bypass fan (' + nrm.supplyFanStatus + ')');
check(/60\.4/.test(String(nrm.supplyFanSpeed)), '2b. supply fan speed is the same fan as the status (' + nrm.supplyFanSpeed + ')');

// 3. dual-duct classification
const ddTerm = { 'Zone Temp': '71 F', 'CD Air Source Status': '7', 'HD Air Source Status': '7', 'CD Air Source Supply Temp': '56', 'HD Air Source Supply Temp': '73', 'Cold Deck Air Flow': '800' };
const classify = (name, pts) => {
  const g = { equipName: name, equipType: name, pointValues: pts, category: 'vav' };
  return sandbox.emVerifyTypeByPoints ? sandbox.emVerifyTypeByPoints(g) : null;
};
const r3 = classify('VAV-9', ddTerm);
check(r3 && r3.category === 'ddvav', '3. cold deck + hot deck air source with zone temperature: dual-duct (' + JSON.stringify(r3 && { c: r3.category, rule: r3.rule }) + ')');
const r3b = classify('AHU-9', Object.assign({}, ddTerm, { 'Supply Fan Status': 'On' }));
check(!r3b || r3b.category !== 'ddvav', '3b. the same points with a supply fan (an air handler) are not dual-duct (' + (r3b && r3b.category) + ')');
const r3c = classify('VAV-8', { 'Zone Temp': '71 F', 'CD Air Source Status': '7', 'Air Flow': '200 cfm' });
check(!r3c || r3c.category !== 'ddvav', '3c. a cold deck air source alone is not dual-duct (' + (r3c && r3c.category) + ')');

// 4. dual-duct occupancy-based ventilation
const dcv = sandbox.EM_SEQUENCE_DEFS.find((s) => s.key === 'vav_dcv');
check(dcv && dcv.requiredCatsByType && dcv.requiredCatsByType.ddvav.indexOf('coldDampCmd') > -1 && dcv.requiredCatsByType.ddvav.indexOf('dampCmd') === -1, '4. dual-duct box needs the deck damper commands, not dampCmd');

// 5. secondary pump drive points
const hwpStatus = sandbox.emNormalizePointWithCustom('Secondary Pump 1 VFD Status', 'hwp', []);
const hwpSpeed = sandbox.emNormalizePointWithCustom('Secondary Pump 2 VFD Speed', 'hwp', []);
const pidOut = sandbox.emNormalizePointWithCustom('Secondary Pump Speed PID', 'hwp', []);
check(hwpStatus && hwpStatus.categoryKey === 'hwPumpStatus', '5. Secondary Pump 1 VFD Status is the hot water pump status');
check(hwpSpeed && hwpSpeed.categoryKey === 'hwPumpSpeed', '5b. Secondary Pump 2 VFD Speed is the hot water pump speed');
check(!(pidOut && pidOut.categoryKey === 'hwPumpSpeed'), '5c. the pump speed PID loop is not counted as the speed point');

// 5d. Round 3 plant mapping, 2026-11-14: present plant points are not missing. Synthetic names, one category per call (category-scoped).
const keyOf = (name, cat) => {
  const r = sandbox.emNormalizePointWithCustom(name, cat, []);
  return r && r.categoryKey;
};
[
  ['HWP-1 VFD Status', 'hwp', 'hwPumpStatus'], ['HWP-2 VFD Status', 'hwp', 'hwPumpStatus'], ['HWP-1/2 VFD Status', 'hwp', 'hwPumpStatus'],
  ['HWP-1 Enable', 'hwp', 'hwPumpEnable'], ['HWP-1/2 Enable', 'hwp', 'hwPumpEnable'], ['Secondary Pump 1 VFD Enable', 'hwp', 'hwPumpEnable'], ['Secondary Pump 2 Enable', 'hwp', 'hwPumpEnable'],
  ['HWP-1 VFD Speed', 'hwp', 'hwPumpSpeed'], ['Secondary Pump 1 VFD Speed', 'hwp', 'hwPumpSpeed'],
  ['Hot Water Set Point', 'hwp', 'hwSetpoint'], ['System Setpoint', 'hwp', 'hwSetpoint'], ['Active System Setpoint', 'hwp', 'hwSetpoint'],
  ['Chiller 1 Status BNI', 'chwp', 'chillerStatus'], ['Chiller Status BNI', 'chwp', 'chillerStatus'], ['Chiller Status', 'chwp', 'chillerStatus'],
].forEach((t) => check(keyOf(t[0], t[1]) === t[2], '5d. "' + t[0] + '" on a ' + t[1] + ' row is ' + t[2] + ' (' + keyOf(t[0], t[1]) + ')'));
[
  ['HWP-1 Enabled, Status Is Off', 'hwp'], ['HWP-1 Disabled, Status Is On', 'hwp'], ['Latched HWP-1 Run Status Failure', 'hwp'], ['Latched HWP-1 Failure', 'hwp'], ['HWP-1 Runtime Hours Exceeded', 'hwp'],
  ['Hot Water Pump 1 Amperage', 'hwp'], ['HWP-1 VFD Amps', 'hwp'], ['HWP-1 VFD Fault', 'hwp'], ['Hot Water Set Point Reset Signal', 'hwp'], ['Hot Water Set Point High Limit', 'hwp'],
  ['System Setpoint Low Limit', 'hwp'], ['Active System Setpoint Alarm', 'hwp'], ['Secondary Pump 1 VFD Fault', 'hwp'], ['Secondary Pump 1 Enabled, Status Is Off', 'hwp'],
].forEach((t) => {
  const k = keyOf(t[0], t[1]);
  check(!['hwPumpStatus', 'hwPumpEnable', 'hwPumpSpeed', 'hwSetpoint'].includes(k), '5e. "' + t[0] + '" does not map to a plant pump or setpoint point (' + k + ')');
});
check(keyOf('Chiller 1 Status BNI', 'ahu') !== 'chillerStatus' && keyOf('Chiller 1 Status BNI', 'hwp') !== 'chillerStatus', '5f. the BNI exception is scoped to a chwp row: on an ahu or hwp row the global BNI rule still holds (' + keyOf('Chiller 1 Status BNI', 'ahu') + ')');
check(keyOf('Chiller 1 Alarm BNI', 'chwp') !== 'chillerStatus' && keyOf('Chiller 1 Disabled, Status Is On', 'chwp') !== 'chillerStatus', '5g. a chiller alarm BNI or alarm text on a chwp row is not the chiller status');
const plantRow = mkRow('p1', 'Hot Water System - X', 'hwp', { 'HWP-1 VFD Status': 'On', 'HWP-1 Enable': 'On', 'Secondary Pump 1 VFD Speed': '50 %', 'Hot Water Set Point': '160 F' }, 'hwp');
check(['hwPumpStatus', 'hwPumpEnable', 'hwPumpSpeed', 'hwSetpoint'].every((k) => status(plantRow, k) === 'covered'), '5h. a plant row with these points has pump status, enable, speed and setpoint covered, none missing (' + ['hwPumpStatus', 'hwPumpEnable', 'hwPumpSpeed', 'hwSetpoint'].map((k) => status(plantRow, k)).join(',') + ')');
const chwRow = mkRow('p2', 'Chilled Water System - X', 'chwp', { 'Chiller 1 Status BNI': 'On' }, 'chwp');
check(status(chwRow, 'chillerStatus') === 'covered', '5i. a chilled water plant row with "Chiller 1 Status BNI" has the chiller status covered (' + status(chwRow, 'chillerStatus') + ')');

// 6-8. report engine text functions (pure; sliced out of the source)
const RE = read('app/report-engine.js');
function slice(name) {
  const i = RE.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  const m = /\n}\r?\n/.exec(RE.slice(i));
  return RE.slice(i, i + m.index + 2);
}
const rsb = {};
vm.createContext(rsb);
vm.runInContext(['_a36DetReadingValue', '_a36DetCredibleReadings', '_a36DetNormalizeText'].map(slice).join('\n'), rsb);
const rv = (l, v) => rsb._a36DetReadingValue(l, v);
check(rv('Outdoor Air Flow', '22903.4 cfm') === '22,903 CFM' || rv('Outdoor Air Flow', '22903.4 cfm') === '22,903 cfm', '6. airflow whole number with a thousands separator (' + rv('Outdoor Air Flow', '22903.4 cfm') + ')');
check(rv('CO2', '575.0 ppm') === '575 ppm', '6b. ppm whole number (' + rv('CO2', '575.0 ppm') + ')');
check(rv('Supply Air Temperature', '55 F') === '55.0°F', '6c. degrees F one decimal (' + rv('Supply Air Temperature', '55 F') + ')');
check(rv('Duct Static Pressure', '1.25 in H2O') === '1.3 in. w.c.' || rv('Duct Static Pressure', '1.25 in H2O') === '1.2 in. w.c.', '6d. static pressure unit (' + rv('Duct Static Pressure', '1.25 in H2O') + ')');

const cr = (o) => rsb._a36DetCredibleReadings(Object.assign({}, o));
check(cr({ dsp: '0.0 in. w.c.', sfSpeed: '80' }).dsp === undefined, '7. static pressure 0 with the fan at 80% is dropped');
check(cr({ dsp: '0.0 in. w.c.', sfSpeed: '0' }).dsp !== undefined, '7b. static pressure 0 with the fan off is kept');
check(cr({ oaFlow: '1 CFM', oaDamp: '40' }).oaFlow === undefined, '7c. outdoor airflow 1 CFM with the damper at 40% is dropped');
check(cr({ oaFlow: '2,000 CFM', oaDamp: '0' }).oaFlow === undefined, '7d. outdoor airflow 2,000 CFM with the damper closed is dropped');
check(cr({ co2: '400 ppm' }).co2 === undefined && cr({ co2: '575 ppm' }).co2 === '575 ppm', '7e. CO2 of exactly 400 ppm is dropped, 575 ppm is kept');

const nt = (t) => rsb._a36DetNormalizeText('<p>' + t + '</p>');
check(/Mixed Air Temperature/.test(nt('Mixed Air Temp')) && !/\bTemp\b/.test(nt('Mixed Air Temp')), '8. Temp becomes Temperature');
check(/Outdoor Air/.test(nt('OA Damper')) && /Chilled Water/.test(nt('CHW Supply')), '8b. OA and CHW are spelled out');
check(/1\.2 in\. w\.c\./.test(nt('1.2 in H2O')), '8c. in H2O becomes in. w.c.');
check(nt('(FPB-101 (Electrical))') === '<p>FPB-101 (Electrical)</p>', '8d. nested brackets flattened (' + nt('(FPB-101 (Electrical))') + ')');

// 9. section allow-list: headings of the 2021 standard (full.txt, verified 2026-11-14). x.y.z level at most.
const ALLOW = new Set([
  '3.1.1.1', '3.1.1.2', '3.1.1.3', '5.1', '5.1.17', '5.2.1', '5.3', '5.3.2', '5.3.4', '5.6', '5.6.5', '5.7', '5.8', '5.8.5', '5.9', '5.10', '5.11', '5.12', '5.13', '5.14',
  '5.16', '5.16.1', '5.16.2', '5.16.3', '5.16.4', '5.16.5', '5.16.6', '5.16.10', '5.16.11', '5.16.12', '5.18', '5.18.4', '5.18.5', '5.18.6', '5.18.7', '5.18.10', '5.18.11', '5.19', '5.20', '5.20.4', '5.20.5', '5.20.6', '5.20.7',
  '5.20.9', '5.20.12', '5.20.13', '5.21', '5.21.3', '5.21.4', '5.21.6', '5.21.7', '5.22',
]);
function cited(str) {
  // "5.16.4 to 5.16.6", "5.7 to 5.10 / DCV", "5.2.1 and 5.16.3": every dotted number
  return (String(str).match(/\d+(?:\.\d+)+/g) || []);
}
const bad = [];
const seen = new Set();
function audit(where, str) {
  cited(str).forEach((n) => {
    seen.add(n);
    if (!ALLOW.has(n)) bad.push(where + ' cites ' + n);
  });
}
sandbox.EM_SEQUENCE_DEFS.forEach((s) => audit('sequence ' + s.key, s.ashrae36));
Object.keys(sandbox.EM_SZ_AIR_UNIT_SECTIONS).forEach((k) => audit('single-zone section ' + k, sandbox.EM_SZ_AIR_UNIT_SECTIONS[k]));
(SRC.match(/ashrae36Section: '[^']*'/g) || []).forEach((m) => audit('point category', m));
const PE = read('app/pricing-estimator.js');
(PE.match(/g36Section: '[^']*'/g) || []).forEach((m) => audit('price map', m));
(PE.match(/(?:vav|fpb|ddvav|fcu): '§[^']*'/g) || []).forEach((m) => audit('price map category', m));
// report text: "Section N", "Table N" in string literals
(RE.match(/(?:Section|Table|§)\s?\d+(?:\.\d+)+/g) || []).forEach((m) => audit('report text', m));
(SRC.match(/(?:'|")[^'"\n]*(?:Section|Table|§)\s?\d+(?:\.\d+)+[^'"\n]*(?:'|")/g) || []).forEach((m) => audit('matrix text', m));
check(bad.length === 0, '9. every cited ASHRAE 36 section is a verified heading' + (bad.length ? ': ' + bad.slice(0, 12).join('; ') : ' (' + seen.size + ' distinct)'));
// the wrong citations of round 1b are gone
const sq = (k) => (sandbox.EM_SEQUENCE_DEFS.find((s) => s.key === k) || {}).ashrae36;
check(sq('ahu_economizer') === '§5.16.4 to 5.16.6' && sq('chwp_staging') === '§5.20.4' && sq('hwp_supply_reset') === '§5.21.4', '9b. economizer, chiller staging and hot water reset cite the verified sections');
check(!/g36Section: '§5\.(24|22\.[13]|16\.7)/.test(PE), '9c. no section that does not exist (5.24, 5.22.1, 5.22.3, 5.16.7) in the price map');
check(!/Table 3\.1\.1\.3/.test(RE) && !/Table 3\.1\.1\.3/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')), '9d. no "Table 3.1.1.3" (carbon dioxide setpoints are Section 3.1.1.3)');

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
