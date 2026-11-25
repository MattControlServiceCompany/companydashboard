// tools/test-a36-disabled-sequences.js - the Audit Report items of Matt 2026-11-25 (6e4b6e04). SYNTHETIC data only.
//   2. A disabled sequence of the control program is an opportunity: ONE opportunity "Enable the disabled sequences" for each library, one cost line,
//      a stated hours constant (DISABLED_SEQUENCE_HOURS_EACH).
//   1. The cover sentence refers to the Service Proposal; the library page says in words why a power meter is recommended.
//   5. The CO2 note puts every unit of the group into a named group.
//   6. A repeated cause folds into its root: each missing device counts once.
//   7. A type row with no point opportunity but units named by a building-wide opportunity says so.
//  10, 11, 12. The Appendix A words, the comfort sentence and the score note.
// Run: node tools/test-a36-disabled-sequences.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RE = fs.readFileSync(path.join(__dirname, '..', 'app', 'report-engine.js'), 'utf8');
const PE = fs.readFileSync(path.join(__dirname, '..', 'app', 'pricing-estimator.js'), 'utf8');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
function fnSrc(name) {
  const idx = RE.search(new RegExp('function ' + name + '[ ]*[(]'));
  if (idx < 0) throw new Error('not found: ' + name);
  let i = RE.indexOf('{', RE.indexOf(')', idx)), d = 0, j = i;
  for (; j < RE.length; j++) {
    if (RE[j] === '{') d++;
    else if (RE[j] === '}' && --d === 0) break;
  }
  return RE.slice(idx, j + 1);
}
function slice(a, b) {
  const s = RE.indexOf(a);
  const e = RE.indexOf(b, s + a.length);
  if (s < 0 || e < 0) throw new Error('not found: ' + a);
  return RE.slice(s, e);
}

// 2. the opportunity of the disabled sequences (the owner function, with the program rows stubbed)
{
  const rowsByUnit = {
    'Hot Water System': [{ id: 'pump_freeze_run', status: 'available_not_enabled' }, { id: 'plant_oa_lockout', status: 'available_not_enabled' }],
    'Chilled Water System': [{ id: 'plant_oa_lockout', status: 'enabled' }],
    'AHU-1': [{ id: 'econ_disabled', status: 'enabled' }, { id: 'sat_fixed_override', status: 'available_not_enabled' }],
    'AHU-2': [{ id: 'econ_disabled', status: 'enabled' }],
  };
  const sb = { A36_DET_TERMINALS: {}, _a36DisplayName: (b) => b.name, _a36DetEquipName: (n) => n, _a36DetSequenceIds: (n) => rowsByUnit[n] || [] };
  vm.createContext(sb);
  vm.runInContext([slice('var A36_DET_DISABLED', '// _a36DetDisabledSequences('), fnSrc('_a36DetJoin'), fnSrc('_a36DetUpperFirst'), fnSrc('_a36DetSeqClasses'), fnSrc('_a36DetDisabledSequences')].join('\n'), sb);
  const groups = [
    { category: 'hwp', units: [{ name: 'Hot Water System' }] },
    { category: 'chwp', units: [{ name: 'Chilled Water System' }] },
    { category: 'ahu', units: [{ name: 'AHU-1' }, { name: 'AHU-2' }, { name: 'AHU-3' }] },
  ];
  const f = sb._a36DetDisabledSequences({ name: 'Alpha Library' }, groups, 1);
  check(f && f.key === 'disabledSequences' && f.label === 'Enable the disabled sequences' && f.lib === 'Alpha Library', '2. one opportunity "Enable the disabled sequences" for the library');
  check(f && f.disabledCount === 4 && f.affected.join('|') === 'Hot Water System|AHU-1|AHU-2', '2. the freeze protection, the lockout of the hot water plant and the two economizers are disabled (4); an enabled lockout and a fixed override are not (units: ' + (f && f.affected.join('|')) + ')');
  check(f && /The program of Hot Water System has a cold weather freeze protection sequence for the pumps, but it is disabled; the program of Hot Water System has a plant lockout/.test(f.observed) && /; the programs of AHU-1 and AHU-2 each have an economizer, but it is disabled\.$/.test(f.observed) && f.observed.split('. ').length === 1, '2. one sentence names the units (the library page prints the first sentence only): ' + (f && f.observed));
  check(f && /plant lockout on high outdoor air temperature/.test(f.observed) && !/low outdoor air temperature/.test(f.observed), '2. the hot water plant has the lockout on high outdoor air temperature');
  check(f && f.category === null && /^Restores freeze protection and cuts energy use$/.test(f.effect), '2. the Effect is short and states the fix: ' + (f && f.effect));
  check(sb._a36DetDisabledSequences({ name: 'Beta Library' }, [{ category: 'ahu', units: [{ name: 'AHU-3' }] }], 1) === null, '2. a library with no disabled sequence has no opportunity');
}

// 2. the cost line: one line, hours = the constant for each sequence
check(/const DISABLED_SEQUENCE_HOURS_EACH = 0\.5;/.test(PE) && /f\.key === 'disabledSequences'/.test(PE) && /DISABLED_SEQUENCE_HOURS_EACH \* nDis/.test(PE), '2. the cost line of the disabled sequences: hours = DISABLED_SEQUENCE_HOURS_EACH (0.5) for each sequence, one line for each library');
check(/o\.foldedKeys/.test(PE), '6. a priced row of a folded sequence maps to the root opportunity (byKey reads foldedKeys)');

// 1. the cover and the library page
{
  const sb = { _a36AuditFindingInfo: () => ({}), _rptA36OppCounts: () => ({ total: 81, recommended: 41, fullScope: 50 }), rptCount: (n) => String(n) };
  vm.createContext(sb);
  vm.runInContext(fnSrc('_a36RecommendedCoverText'), sb);
  const t = sb._a36RecommendedCoverText({});
  check(/The Service Proposal that follows this audit recommends work on 41 of them\./.test(t) && !/Recommended option/.test(t), '1. the cover refers to the Service Proposal, not to "the Recommended option": ' + t);
  check(/'Recommended: the equipment is large enough for a meter to be worth it'/.test(RE), '1. the library page says in words why the power meter is recommended');
}

// 5. the CO2 note: every unit in a named group
{
  const sb = { rptCount: (n) => String(n) };
  vm.createContext(sb);
  sb._a36DetGroupFindings = () => ({ covered: { by: { co2: { names: ['U3', 'U4'] } } } });
  sb._pricingIsMonitoringOnlyZoneUnit = (u) => u.name === 'U6';
  vm.runInContext(fnSrc('_a36DetJoin') + '\n' + fnSrc('_a36DetDcvNote'), sb);
  const names = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'];
  const note = sb._a36DetDcvNote({ units: names.map((n) => ({ name: n })) }, 2, ['U1', 'U2']);
  check(note === 'Of the other 4, 2 have a CO2 sensor point and 1 is not checked for it because occupancy-based ventilation does not apply to it and 1 has no zone heating or cooling setpoint in the building automation system.', '5. the 4 other units are 2 + 1 + 1: ' + note);
  const only = sb._a36DetDcvNote({ units: ['U1', 'U2', 'U5'].map((n) => ({ name: n })) }, 2, ['U1', 'U2']);
  check(only === 'The other unit is not checked for it because occupancy-based ventilation does not apply to it.', '5. one other unit, no CO2 point: it is named: ' + only);
}

// 7. the type row of units that a building-wide opportunity names
check(/No sensor or point opportunities; see the building-wide items below\./.test(RE) && /function _a36NoFindingNamed\(/.test(RE), '7. a type row with no point opportunity but units named by a building-wide opportunity does not say "No opportunities"');

// 8, 9, 10, 11, 12. the words
check(/Schedules, setpoints and lighting controls are not part of the score\./.test(RE), '12. the score note says schedules are not in the score');
check(/the library pages also count its lighting control units/.test(RE), '8. the note says what Equipment counts');
check(/'scheduled heating and cooling unit'/.test(RE), '9. the scheduled units are heating and cooling units');
check(/The Control Service Company standard is set for comfort, which most clients prefer to the small extra savings of the ASHRAE 36 default setpoints\. The owner keeps control of the setpoints\./.test(RE), '10. the comfort sentence is in the Appendix A text');
check(!/for three zone types/.test(RE) && /compares the average zone setpoints/.test(RE), '11. the Appendix A text has no zone-type split and says averages');
check(/The zone setpoint data of the building automation system holds no carbon dioxide setpoint/.test(RE) && !/No carbon dioxide setpoints are programmed for occupancy-based ventilation/.test(RE), '3. the CO2 note says what the data holds, not what the program lacks');

process.exit(failed ? 1 : 0);
