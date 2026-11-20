// test-equipment-matrix-damper-classifier.js
// Known-value test: a damper control program that carries an RTU/AHU tag in its name is a Damper, not a unit,
// and is not scored (Sensor Coverage / Sequence Readiness / Overall / equipment count). A real RTU stays a Rooftop Unit.
// Rule under test: emDamperCategory (app/equipment-matrix.js), called by emParseEquipBaseName and emClassifyEquipType.
// Fixtures are 100% SYNTHETIC (no client names). Real headless Chromium, real app code, synthetic matrix through DB.set().
// Run: node test-equipment-matrix-damper-classifier.js   (from the repo root; set CH_TMP_ROOT first)
const { launchBrowser } = require('./tools/launch-browser.js');

const REPO = __dirname;
const SITE_PATH = 'file:///' + REPO.replace(/\\/g, '/') + '/energy-department.html';
const SYNTH_PID = 999000444;

let pass = 0;
let fail = 0;
const failures = [];
function assertEqual(actual, expected, label) {
  if (actual === expected) pass++;
  else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const RTU_POINTS = {
  'Zone Temp': '71 F',
  'Zone Cooling Setpoint': '72 F',
  'Zone Heating Setpoint': '68 F',
  'Supply Fan Status': 'On',
  'Supply Air Temp': '60 F',
  'Zone CO2': '600',
};
function baseRow(bldg, name, category, points) {
  return { id: bldg + '||' + name, building: bldg, location: '', floor: '', area: '', equipName: name, equipType: name, category: category, subtype: '', points: points || {}, pointsRaw: points || {}, checks: {}, schema: 2 };
}
function matrix(rows, bldg) {
  return { rows: rows, importedAt: new Date().toISOString(), buildings: [bldg], totalBASPoints: 0 };
}

(async () => {
  const context = await launchBrowser('damper-classifier', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [{ id: SYNTH_PID, name: 'SYNTHETIC TEST PROJECT', client: 'Synthetic Test Client', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
      ch_settings: { showQuickStart: false },
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((data) => { for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k])); }, seed);
    await page.goto(SITE_PATH);
    await page.waitForTimeout(2000);

    // 1. Classifier: name rule (both classifiers) and the real-RTU control
    const c = await page.evaluate(() => {
      const names = ['SYN RTU-1-2 Cross Tie Damper', 'RTU-1-2 Cross Tie Damper', 'RTU-1/RTU-2 Cross Tie Damper', 'AHU-4 Isolation Damper', 'Outside Damper Lockout', 'Smoke Damper 12-RD-1', 'AHU-1 Smoke Dampers', 'AHU-5 Smoke Damper', 'RTU-2 Relief Damper', 'Building Relief Dampers | GV-1', 'RTU-3', 'Room 12 - RTU-3', 'AHU-2', 'Synth Rooftop Unit 7'];
      const out = {};
      names.forEach((n) => { out[n] = [emParseEquipBaseName(n), emClassifyEquipType(n)]; });
      return out;
    });
    ['SYN RTU-1-2 Cross Tie Damper', 'RTU-1-2 Cross Tie Damper', 'AHU-4 Isolation Damper', 'Outside Damper Lockout'].forEach((n) => {
      assertEqual(c[n][0], 'damper', 'parse: ' + n + ' -> damper');
      assertEqual(c[n][1], 'damper', 'classify: ' + n + ' -> damper');
    });
    assertEqual(c['RTU-1/RTU-2 Cross Tie Damper'][1], 'damper', 'classify: slash name with damper -> damper');
    assertEqual(c['Smoke Damper 12-RD-1'][1], 'fire', 'classify: smoke damper stays fire (unchanged)');
    assertEqual(c['AHU-1 Smoke Dampers'][0], 'fire', 'parse: unit-tagged smoke damper -> fire');
    assertEqual(c['AHU-1 Smoke Dampers'][1], 'fire', 'classify: unit-tagged smoke damper -> fire');
    assertEqual(c['AHU-5 Smoke Damper'][0], 'fire', 'parse: AHU-5 Smoke Damper -> fire');
    assertEqual(c['RTU-2 Relief Damper'][0], 'fire', 'parse: unit-tagged relief damper -> fire');
    assertEqual(c['Building Relief Dampers | GV-1'][1], 'fire', 'classify: relief damper stays fire (unchanged)');
    assertEqual(c['RTU-3'][0], 'rtu', 'parse: RTU-3 -> rtu (unchanged)');
    assertEqual(c['RTU-3'][1], 'rtu', 'classify: RTU-3 -> rtu (unchanged)');
    assertEqual(c['Room 12 - RTU-3'][0], 'rtu', 'parse: Room 12 - RTU-3 -> rtu (unchanged)');
    assertEqual(c['AHU-2'][0], 'ahu', 'parse: AHU-2 -> ahu (unchanged)');
    assertEqual(c['Synth Rooftop Unit 7'][1], 'rtu', 'classify: Rooftop Unit 7 -> rtu (unchanged)');

    // 2. Matrix load + labels + compliance + scores
    const A = 'Synthetic Hall A';
    const rtuOnly = matrix([baseRow(A, 'SYN-RTU-3', 'rtu', RTU_POINTS)], A);
    // stored with the old wrong type 'rtu' and points that look like an air unit: the app must still show a Damper
    const withDamper = matrix([baseRow(A, 'SYN-RTU-3', 'rtu', RTU_POINTS), baseRow(A, 'SYN-AHU-1 Smoke Dampers', 'ahu', { 'Damper Status': 'Open' }), baseRow(A, 'SYN-RTU-1-2 Cross Tie Damper', 'rtu', { 'Damper Position': '0 %', 'Air Flow': '295', 'Air Source Mode': 'On', 'Zone Temp': '70 F' })], A);
    const r = await page.evaluate(async ({ pid, m1, m2 }) => {
      await window.DB.set('en_eqmatrix_' + pid, m1);
      const s1 = a36ComputeScores(pid);
      await window.DB.set('en_eqmatrix_' + pid, m2);
      _emSelfHealDone[pid] = false; // DB.set does not clear the load-pass cache (emSaveMatrix does)
      const d = emLoadMatrix(pid);
      const s2 = a36ComputeScores(pid);
      const dmp = d.rows.find((x) => /Cross Tie/.test(x.equipName));
      const rtu = d.rows.find((x) => /RTU-3/.test(x.equipName));
      const smk = d.rows.find((x) => /Smoke/.test(x.equipName));
      const cmp = emComputeCompliance(dmp);
      const rtuCmp = emComputeCompliance(rtu);
      const st = emCalcSummaryStats(d.rows);
      return {
        s1: s1 && s1.portfolio, s2: s2 && s2.portfolio,
        smkCat: smk.category, dmpCat: dmp.category, dmpLabel: emFormatEquipTypeLabel(dmp), rtuCat: rtu.category,
        dmpRequired: cmp.totalRequired, rtuRequired: rtuCmp.totalRequired,
        statsAhu: st.ahu, statsDamper: st.damper,
        inLabels: EM_CATEGORY_LABELS.damper, inOrder: EM_TYPE_FILTER_ORDER.indexOf('damper') > -1,
      };
    }, { pid: SYNTH_PID, m1: rtuOnly, m2: withDamper });
    assertEqual(r.dmpCat, 'damper', 'matrix: damper row category = damper (even with air-unit-like points)');
    assertEqual(r.dmpLabel, 'Damper', 'matrix: Equipment Type label = Damper');
    assertEqual(r.smkCat, 'fire', 'matrix: unit-tagged smoke damper row category = fire (not graded as an AHU)');
    assertEqual(r.rtuCat, 'rtu', 'matrix: real RTU row stays rtu');
    assertEqual(r.dmpRequired, 0, 'compliance: damper row has 0 required points (not scored)');
    assertEqual(r.rtuRequired > 0, true, 'compliance: real RTU row has required points');
    assertEqual(r.statsAhu, 1, 'stats: air unit count counts only the real RTU');
    assertEqual(r.statsDamper, 1, 'stats: damper counted in its own bucket');
    assertEqual(r.inLabels, 'Damper', 'label list: damper -> Damper');
    assertEqual(r.inOrder, true, 'filter order: damper present');
    assertEqual(JSON.stringify(r.s2), JSON.stringify(r.s1), 'scores: adding the damper row does not move Sensor Coverage / Sequence Readiness / Overall / equipment count');
    assertEqual(r.s1 && r.s1.equipCount, 1, 'scores: one scored unit (the RTU)');
  } finally {
    await context.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('All damper classifier tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
