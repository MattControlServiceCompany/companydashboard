// tools/test-calendar-p3-fixes.js - DHW out of scope, exterior lights not waste, own action history list, manual event times.
// SYNTHETIC data only. Run: node tools/test-calendar-p3-fixes.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BC = require('../computations/bas-coverage.js');
const SA = require('../computations/sched-actions.js');
const CD = require('../app/calendar-diff.js');
let fails = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fails++;
    console.log('FAIL: ' + msg + '\n  got  ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b));
  }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// 1. DHW is NOT a serving unit; it is out of scope, by its own rule (one function: isUnchecked)
eq(BC.isServingProgram('Domestic Hot Water System'), false, 'DHW is not a serving unit');
eq(BC.isServingProgram('DHW-1'), false, 'DHW tag is not a serving unit');
eq(BC.isOutOfScopeProgram('Domestic Hot Water System') && BC.isOutOfScopeProgram('DHW Recirc #2'), true, 'DHW is out of scope');
eq(BC.isServingProgram('HW-1 Boiler') && BC.isServingProgram('ERV-2'), true, 'plants and ERV stay serving');
eq(BC.isUnchecked('DHW-1') && BC.isUnchecked('HW Pump') && !BC.isUnchecked('Room 101'), true, 'isUnchecked = serving or out of scope');
const LOC = '/D/Test Alpha Hall/A';
eq(BC.suggestPrograms('TAH Gym', [LOC + '|Gym DHW', LOC + '|Gym Room']), [LOC + '|Gym Room'], 'DHW never suggested');

// 2. Exterior and site lights are not waste unless the caller flags no light-level point
const allDay = [[0, 0, 'occ']];
const snaps = {
  '2026-10-30': {
    rows: {
      [LOC + '|Parking Lot Lighting']: allDay,
      [LOC + '|Flag Pole Lights']: allDay,
      [LOC + '|Building Exterior Lights 2']: allDay,
      [LOC + '|Hall Lights']: allDay,
      [LOC + '|DHW Recirc']: allDay,
    },
  },
};
const o = { events: {}, map: { spaces: {} }, snaps, groups: {}, tz: 'America/Chicago', today: '2026-10-30' };
eq(SA.wasteFindings(o).map((f) => f.program), ['Hall Lights'], 'only the interior light is waste');
eq(
  SA.wasteFindings(Object.assign({}, o, { noLightLevel: { [LOC + '|Parking Lot Lighting']: true } })).map((f) => f.program),
  ['Hall Lights', 'Parking Lot Lighting'],
  'exterior light with no photocell/astro point is waste',
);
eq(BC.isExteriorLighting('Parking Lot Lighting') && !BC.isExteriorLighting('Room 12 Lighting') && !BC.isExteriorLighting('Parking Ventilation'), true, 'exterior light name test');

// 3. Actions have their own history list; imports are never pushed out
const store = {
  en_bas_hist_1: Array.from({ length: 50 }, (_, i) => ({ id: 'bash_i' + i, kind: 'schedules', at: '2026-01-01T00:00:' + String(i).padStart(2, '0') + 'Z' })),
};
const win = {};
const sb = {
  window: win,
  document: { getElementById: () => null },
  DB: { get: (k, d) => (store[k] === undefined ? d : store[k]), set: async (k, v) => { store[k] = v; } },
  CalendarDiff: CD,
  _escHtml: (x) => x,
  SchedActions: Object.assign({}, SA, { reconcile: () => ({ stored: { actions: {} }, changes: [{ id: 'a', text: 't', what: 'Opened' }] }) }),
};
vm.createContext(sb);
vm.runInContext(read('app/sched-actions.js'), sb);
(async () => {
  for (let i = 0; i < 3; i++) await win.sactPersist(1);
  eq(store.en_bas_hist_1.length, 50, 'BAS import history list is untouched by actions');
  eq(store.en_bas_hist_1.every((r) => r.kind === 'schedules'), true, 'no action record in the import list');
  eq(Array.isArray(store.en_bas_acthist_1) && store.en_bas_acthist_1.length === 3 && store.en_bas_acthist_1.every((r) => r.kind === 'action'), true, 'actions go to en_bas_acthist_');
  eq(/en_bas_acthist_'\) === 0\) return MERGE_ONLY_CONFIG\.calHist/.test(read('app/db.js')), true, 'db.js merges en_bas_acthist_ by id like the other history lists');
  eq(/en_bas_\(snap\|hist\|acthist\|groups\)_/.test(read('app/restore-merge.js')), true, 'restore-merge groups en_bas_acthist_ with District calendar');
  eq(/'en_bas_acthist_'/.test(read('app/sync-ui.js')), true, 'sync-ui names en_bas_acthist_');
  const bs = read('app/bas-schedules.js');
  eq(/histSection\(shownHistOf\(pid\)\)/.test(bs) && /hist: histOf\(pid\)/.test(bs), true, 'screen shows both lists; imports save only the import list');
  eq(/en_bas_hist_/.test(read('app/sched-actions.js').replace(/\/\/.*$/gm, '')), false, 'sched-actions.js code never writes en_bas_hist_');

  // 5. Manual events: start, end, space become event rows the BAS check and actions use
  const tz = 'America/Chicago';
  eq(CD.localToIso('2026-10-30', '18:30', tz), '2026-10-30T23:30:00.000Z', 'local time to ISO (CDT)');
  eq(CD.localToIso('2026-12-01', '8:00', tz), '2026-12-01T14:00:00.000Z', 'local time to ISO (CST)');
  eq(CD.localToIso('2026-10-30', '', tz), '', 'blank time gives no ISO');
  const rows = CD.manualRows(
    [
      { id: 5, date: '2026-10-30', start: '18:00', end: '21:00', space: 'TAH Gym', name: 'Test Meeting' },
      { id: 6, date: '2026-10-30', name: 'No times' },
      { id: 7, date: '', name: 'No date' },
    ],
    tz,
  );
  eq(Object.keys(rows), ['m5', 'm6'], 'manual rows keyed m<id>; no-date row dropped');
  eq(rows.m5, ['Test Meeting', '2026-10-30T23:00:00.000Z', '2026-10-31T02:00:00.000Z', 0, 'TAH Gym'], 'manual row has the feed row shape');
  eq(BC.eventCoverage(rows.m6, { tz, map: null, snaps: {} }).status, 'allday', 'no start time = all-day, no BAS check');
  const rowsL = { [LOC + '|AHU-1 Gym']: [[0, 300, 'unocc'], [300, 960, 'occ'], [960, 0, 'unocc']] };
  const map = { spaces: { [BC.spaceKey('TAH Gym')]: { space: 'TAH Gym', programs: [LOC + '|AHU-1 Gym'], confirmed: true } } };
  const snp = { '2026-10-30': { rows: rowsL } };
  eq(BC.eventCoverage(rows.m5, { tz, map, snaps: snp }).status, 'short', 'manual event is checked against the BAS');
  const acts = SA.computeActions({ events: rows, map, snaps: snp, groups: {}, tz, today: '2026-10-29' });
  eq(acts.length === 1 && /Test Meeting/.test(acts[0].text), true, 'manual event creates an action like a feed event');
  const dc = read('app/district-calendar.js');
  eq(/type="time"[^>]*'start'/.test(dc) && /type="time"[^>]*'end'/.test(dc) && /distcal-spaces-/.test(dc) && /pcalBasCell/.test(dc), true, 'manual table has start, end, space (list + free text) and BAS');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
