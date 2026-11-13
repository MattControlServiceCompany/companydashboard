// tools/test-em-na-states.js: Equipment Matrix Audit View cell states (Matt, 2026-11-13).
// Checks (SYNTHETIC names only):
//   1. Legend: each state has visible text, not hover only.
//   2. Every N/A cell title gives the reason in plain words (type, space type, default flag, explicit flag).
//   3. A point that exists is never hidden: a covered point under a space-type exemption is matched, not N/A.
//   4. Air handler / rooftop return air CO2 fills ONE column (co2); no dead co2Return column for ahu or rtu.
//   5. Space type: "Electrical <id>" and "Electric/Water" rooms are electrical rooms; "Electric Heat" is not.
//   6. Sort uses the same N/A rule as the cells.
// Run: node tools/test-em-na-states.js   (exit 0 = all pass)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8');
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
  DB: { get: (k, fb) => fb, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
  _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'app/equipment-matrix.js' });

function mkRow(id, name, category, pointsRaw) {
  return { id, building: 'Synthetic Hall', location: '', equipName: name, equipType: name, category, points: Object.assign({}, pointsRaw), pointsRaw: pointsRaw || {}, checks: {}, schema: 2 };
}
const ahu = mkRow('a1', 'AHU-1', 'ahu', { 'Return Air CO2': '574.8', 'Return Air Humidity': '45' });
const rtu = mkRow('r1', 'RTU-1', 'rtu', { 'Return Air CO2': '600' });
const doas = mkRow('d1', 'DOAS-1', 'doas', { 'Return Air CO2': '500' });
const vavCorridor = mkRow('v1', 'Central Hallway | VAV-1', 'vav', {});
const vavCorridorCo2 = mkRow('v2', 'East Hallway | VAV-2', 'vav', { 'Zone CO2': '536' });
const vavOffice = mkRow('v3', 'Office 101 | VAV-3', 'vav', {});
const vavOcc = mkRow('v4', 'Office 102 | VAV-4', 'vav', { 'Occupancy Sensor': 'On' });
const allRows = [ahu, rtu, doas, vavCorridor, vavCorridorCo2, vavOffice, vavOcc];
sandbox.window._emActivePid = 'synthetic';

const defs = sandbox.emGetAuditColDefs(allRows).filter((d) => d.isAuditCat);
const defOf = (k) => defs.find((d) => d.catKey === k);
function cell(row, catKey, flags) {
  const c = sandbox.emComputeCompliance(row, flags || {}, []);
  const cm = {},
    nm = {},
    mm = {};
  c.coveredPoints.forEach((p) => (cm[p.categoryKey] = p));
  c.naPoints.forEach((p) => (nm[p.categoryKey] = p));
  c.missingPoints.forEach((p) => (mm[p.categoryKey] = true));
  return { html: sandbox.emRenderAuditCell(row, defOf(catKey), c, cm, nm, mm, {}, {}), comp: c };
}
const title = (html) => (/title="([^"]*)"/.exec(html) || [])[1] || '';

// ---- 1. legend text ----
[
  'Matched',
  'Likely match',
  'Not found (required)',
  'not needed for this unit (hover for why)',
  'optional, not present',
].forEach((t) => {
  check(SRC.indexOf('>' + t + '</span>') !== -1, 'legend has visible text: ' + t);
});

// ---- 2. N/A titles carry the reason ----
check(/does not have this point/.test(title(cell(vavOffice, 'rhReturn').html)), 'type N/A title says the type does not have the point');
const spaceNa = cell(vavCorridor, 'co2').html;
check(/>N\/A<\/td>/.test(spaceNa) && /Corridor \(space type\)/.test(title(spaceNa)), 'space type N/A title names Corridor (space type): ' + title(spaceNa));
const defNa = cell(vavOffice, 'occSensor').html;
check(/>N\/A<\/td>/.test(defNa) && /optional point/.test(title(defNa)), 'default-flag N/A title says optional point: ' + title(defNa));
const setNa = cell(vavOffice, 'occSensor', { hasOccSensor: false }).html;
check(/Set to not needed on this unit/.test(title(setNa)), 'explicit-flag N/A title says set to not needed: ' + title(setNa));

// ---- 3. a point that exists is never hidden ----
const hid = cell(vavCorridorCo2, 'co2');
check(!/>N\/A<\/td>/.test(hid.html) && /536/.test(hid.html), 'covered CO2 in a corridor shows the value, not N/A');
check(
  hid.comp.naPoints.every((p) => p.categoryKey !== 'co2') && hid.comp.coveredPoints.some((p) => p.categoryKey === 'co2'),
  'covered CO2 under space-type exemption is matched in compliance, not naPoints',
);

const seqR = sandbox.emComputeSequenceReadiness(vavCorridorCo2, hid.comp);
check(seqR.vav_dcv && seqR.vav_dcv.status === 'na' && /space type/.test(seqR.vav_dcv.naReason || ''), 'exempt corridor VAV with a CO2 point: value shown AND vav_dcv is N/A with a reason: ' + JSON.stringify(seqR.vav_dcv && seqR.vav_dcv.status));

// ---- 4. one CO2 column per type ----
const cats = sandbox.EM_POINT_CATEGORIES;
['ahu', 'rtu'].forEach((t) => check(!cats[t].some((d) => d.key === 'co2Return'), t + ' has no dead co2Return category'));
check(cats.doas.some((d) => d.key === 'co2Return'), 'doas keeps co2Return (its only CO2 column)');
[ahu, rtu].forEach((r) => {
  const c = cell(r, 'co2');
  check(/574|600/.test(c.html) && !/>N\/A<\/td>/.test(c.html), r.category + ': return air CO2 value fills the co2 column');
});
check(cell(doas, 'co2Return').comp.coveredPoints.some((p) => p.categoryKey === 'co2Return'), 'doas return air CO2 covers co2Return');
check(!defs.some((d) => d.catKey === 'co2Return' && d.catEquipTypes.some((t) => t === 'ahu' || t === 'rtu')), 'co2Return column lists no ahu/rtu');

// ---- 5. space type names ----
const st = (n, cat) => (sandbox.emClassifySpaceType(mkRow('x', n, cat || 'vav')) || {}).spaceType || null;
check(st('Electrical M1Q01 - VBR-M1Q01') === 'mech_elec', 'Electrical M1Q01 is an electrical room');
check(st('Main Electrical | VAV-1') === 'mech_elec', 'Main Electrical (end of name) is still an electrical room');
check(st('123 Electric/Water | VAV-205') === 'mech_elec', '123 Electric/Water is an electrical room');
check(st('Electric Room | VAV-3') === 'mech_elec', 'Electric Room is an electrical room');
check(st('Electric Heat - VAV-3') === null, 'Electric Heat is not an electrical room');
check(st('Electrical Heat - VAV-3') === null, 'Electrical Heat is not an electrical room');
check(st('Storage/Office | VAV-4') === null, 'Storage/Office (two rooms) still does not classify');
check(st('Storage, DA, Detox | VAV-5') === null, 'comma room list still does not classify');
check(st('Electrical M1Q01 - AHU-1', 'ahu') === null, 'ahu never classifies');

// ---- 6. sort uses the cell rule ----
const sortOf = (row, k) => sandbox.emAuditGetSortVal(row, defOf(k));
check(sortOf(vavCorridor, 'co2') === -1, 'sort: space-type N/A cell sorts as N/A (-1), got ' + sortOf(vavCorridor, 'co2'));
check(sortOf(vavCorridorCo2, 'co2') >= 0 && sortOf(vavCorridorCo2, 'co2') <= 2, 'sort: covered corridor CO2 sorts as matched, got ' + sortOf(vavCorridorCo2, 'co2'));
check(sortOf(vavOffice, 'co2') === 99, 'sort: required and missing sorts as 99');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
