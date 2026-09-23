// tools/test-calc-autofill.js — BAS Savings Calc autofill regression gate.
// Run: node tools/test-calc-autofill.js
//
// Loads the REAL app/calc-autofill.js verbatim into a Node vm sandbox (same technique as
// tools/test-single-source-baseline.js) and proves:
//   1. chCalcAutofillFields pulls sqft/heatSrc/setpoints from a synthetic building + Set Points
//      record, with the correct source label on each field.
//   2. chResolveCalcField fixes the actual reported bug: a previously-saved field that still
//      equals the shipped default (e.g. sqft:0, a project's stale pre-autofill basCalc) does NOT
//      block autofill — this is the exact Spring Hill Schools / Woodland Spring Middle failure
//      mode from the 2026-09-22 report.
//   3. chResolveCalcField never overwrites a real user override — neither a saved value that
//      differs from the shipped default, nor a field explicitly marked touched this session — and
//      that the override survives a simulated re-open.
//
// SYNTHETIC fixture only for the committed pass/fail gate. When a local CompanyHub backup is
// available, also runs chCalcAutofillFields against Spring Hill Schools / Woodland Spring Middle
// real data (informational cross-check, not required for the gate to pass).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

const src = fs.readFileSync(REPO + '/app/calc-autofill.js', 'utf8');

function makeSandbox(projectsArr) {
  const sandbox = {
    console,
    projects: projectsArr,
    getUDBldg: (pid, bid) => {
      const p = projectsArr.find((x) => x.id === pid);
      return ((p && p.__buildings) || []).find((b) => b.id === bid) || null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'calc-autofill.js' });
  return sandbox;
}

console.log('--- 1. chCalcAutofillFields — synthetic building + Set Points ---');
{
  const bldgId = 'bSynth1';
  const projId = 1;
  const projectsArr = [
    {
      id: projId,
      __buildings: [{ id: bldgId, sqft: 42000, meters: [{ commodity: 'Electric' }, { commodity: 'Gas' }] }],
      setpoints: [
        {
          buildingId: bldgId,
          zones: [
            { occCool: 54, unoccCool: 68, occHeat: 71, unoccHeat: 61 },
            { occCool: 56, unoccCool: 72, occHeat: 69, unoccHeat: 59 },
          ],
        },
      ],
    },
  ];
  const sb = makeSandbox(projectsArr);
  const auto = sb.chCalcAutofillFields(projId, bldgId);
  assert(
    auto.sqft.value === 42000 && auto.sqft.source === 'building record' && !auto.sqft.isDefault,
    'sqft from building record',
  );
  assert(auto.heatSrc.value === 4 && /gas \+ electric/.test(auto.heatSrc.source), 'heatSrc=4 (Both) from meters');
  assert(
    auto.exCoolOcc.value === 55 && auto.exCoolOcc.source === 'Set Points',
    'exCoolOcc averaged from Set Points zones (54,56->55)',
  );
  assert(auto.exCoolUnocc.value === 70, 'exCoolUnocc averaged (68,72->70)');
  assert(auto.exHeatOcc.value === 70, 'exHeatOcc averaged (71,69->70)');
  assert(auto.exHeatUnocc.value === 60, 'exHeatUnocc averaged (61,59->60)');

  // No building match / no bldgId -> every field comes back flagged default, never throws
  const empty = sb.chCalcAutofillFields(projId, 'nope');
  assert(empty.sqft.isDefault && empty.heatSrc.isDefault, 'unknown building -> all fields default, no throw');
}

console.log('--- 2. chResolveCalcField — stale shipped-default save no longer blocks autofill ---');
{
  const projectsArr = [{ id: 1, __buildings: [] }];
  const sb = makeSandbox(projectsArr);
  const autoSqft = { value: 102817, source: 'building record', isDefault: false };

  // This IS the Spring Hill Schools bug: openBASCalc's old gate saw `p.basCalc` already existed
  // (sqft:0, the shipped default) and skipped autofill entirely, forever.
  const staleDefaultSave = sb.chResolveCalcField(0, 0, autoSqft, new Set(), 'sqft');
  assert(staleDefaultSave.value === 102817, 'sqft autofills to 102817 even though a stale basCalc had saved 0');
  assert(
    staleDefaultSave.hint === 'from building record',
    'stale-default save gets the "from" hint, not treated as a real user value',
  );

  // Field never saved at all (brand new calc) behaves the same way
  const neverSaved = sb.chResolveCalcField(undefined, 0, autoSqft, new Set(), 'sqft');
  assert(neverSaved.value === 102817 && neverSaved.hint === 'from building record', 'never-saved field also autofills');
}

console.log('--- 3. chResolveCalcField — real user overrides are never clobbered ---');
{
  const sb = makeSandbox([{ id: 1, __buildings: [] }]);
  const autoSqft = { value: 102817, source: 'building record', isDefault: false };

  // (a) Saved value differs from the shipped default -> treated as a real prior edit, protected.
  const realOverride = sb.chResolveCalcField(95000, 0, autoSqft, new Set(), 'sqft');
  assert(
    realOverride.value === 95000 && realOverride.hint === null,
    'a saved value that differs from the shipped default is never overwritten by autofill',
  );

  // (b) User explicitly touched the field this session, even to a value equal to the default.
  const explicitTouch = sb.chResolveCalcField(0, 0, autoSqft, new Set(['sqft']), 'sqft');
  assert(
    explicitTouch.value === 0 && explicitTouch.hint === null,
    'a field marked touched this session is never overwritten, even if its value equals the shipped default',
  );

  // (c) Nothing found at all -> default, flagged.
  const nothingFound = sb.chResolveCalcField(undefined, 0, null, new Set(), 'sqft');
  assert(
    nothingFound.value === 0 && nothingFound.hint === 'default — not from building data',
    'no autofill + no saved value -> flagged default',
  );

  // (d) Simulated re-open: session 1 autofills, user then types an override, saves, reopens.
  let saved = undefined;
  const session1 = sb.chResolveCalcField(saved, 0, autoSqft, new Set(), 'sqft');
  assert(session1.value === 102817 && session1.hint === 'from building record', 're-open sim session 1: autofilled');
  saved = 50000; // user typed a real override and saved
  const session2 = sb.chResolveCalcField(saved, 0, autoSqft, new Set(), 'sqft');
  assert(
    session2.value === 50000 && session2.hint === null,
    're-open sim session 2: user override survives, autofill does not reassert itself',
  );
}

console.log('--- 4. chCalcFieldHintHTML ---');
{
  const sb = makeSandbox([{ id: 1, __buildings: [] }]);
  assert(sb.chCalcFieldHintHTML(null) === '', 'no hint -> no marker');
  assert(
    /from building record/.test(sb.chCalcFieldHintHTML('from building record')),
    'autofill hint renders source text',
  );
  assert(
    /default — not from building data/.test(sb.chCalcFieldHintHTML('default — not from building data')),
    'default hint renders',
  );
}

// ─── Informational: real backup cross-check (Spring Hill Schools / Woodland Spring Middle) ───
function findLatestBackup() {
  const dl = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dl)) return null;
  const files = fs
    .readdirSync(dl)
    .filter((f) => /^CompanyHub-localdatafile-\d{8}\.json$/.test(f))
    .sort();
  return files.length ? path.join(dl, files[files.length - 1]) : null;
}

const backupPath = process.argv[2] || findLatestBackup();
if (backupPath && fs.existsSync(backupPath)) {
  console.log('\n--- 5. Real backup cross-check: Spring Hill Schools / Woodland Spring Middle ---');
  console.log('Using backup: ' + backupPath);
  const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const data = raw.data || raw;
  const getLS = (key) => {
    const v = data[key];
    if (v == null) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch (e) {
        return v;
      }
    }
    return v;
  };
  const realProjects = getLS('en_projects') || [];
  const springHill = realProjects.find((p) => /spring hill/i.test(p.name || ''));
  if (springHill) {
    const ud = getLS('en_utility_' + springHill.id) || {};
    springHill.__buildings = ud.buildings || [];
    const sb = makeSandbox([springHill]);
    const woodland = springHill.__buildings.find((b) => /woodland spring middle/i.test(b.name || ''));
    if (woodland) {
      const auto = sb.chCalcAutofillFields(springHill.id, woodland.id);
      console.log('  Woodland Spring Middle sqft:', auto.sqft.value, '(source:', auto.sqft.source + ')');
      console.log('  Woodland Spring Middle heatSrc:', auto.heatSrc.value, '(source:', auto.heatSrc.source + ')');
      assert(auto.sqft.value === 102817, 'real backup: Woodland Spring Middle sqft autofills to 102817');
      assert(
        auto.heatSrc.value === 4,
        'real backup: Woodland Spring Middle heatSrc autofills to 4 (Both — has gas + electric meters)',
      );

      // Reproduce the exact reported bug end-to-end: the real stale basCalc this project already
      // has on disk (sqft:0, heatSrc:2) must no longer block autofill.
      const staleBc = springHill.basCalc || {};
      const resolvedSqft = sb.chResolveCalcField(
        staleBc.sqft,
        0,
        auto.sqft,
        new Set(staleBc.__userTouched || []),
        'sqft',
      );
      const resolvedHeatSrc = sb.chResolveCalcField(
        staleBc.heatSrc,
        2,
        auto.heatSrc,
        new Set(staleBc.__userTouched || []),
        'heatSrc',
      );
      console.log(
        '  Resolved (as openBASCalc would render): sqft=' + resolvedSqft.value + ' heatSrc=' + resolvedHeatSrc.value,
      );
      assert(
        resolvedSqft.value === 102817,
        'real backup: stale saved basCalc.sqft=0 no longer blocks the sqft autofill',
      );
      assert(
        resolvedHeatSrc.value === 4,
        'real backup: stale saved basCalc.heatSrc=2 no longer blocks the heatSrc autofill',
      );
    } else {
      console.log('  (Woodland Spring Middle building not found in this backup — skipping)');
    }
  } else {
    console.log('  (Spring Hill Schools project not found in this backup — skipping)');
  }
} else {
  console.log('\n--- 5. Real backup cross-check: SKIPPED (no local backup found) ---');
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
