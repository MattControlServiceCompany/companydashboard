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

function makeSandbox(projectsArr, opts) {
  opts = opts || {};
  const sandbox = {
    console,
    projects: projectsArr,
    getUDBldg: (pid, bid) => {
      const p = projectsArr.find((x) => x.id === pid);
      return ((p && p.__buildings) || []).find((b) => b.id === bid) || null;
    },
  };
  // Equipment Matrix / Setpoint Export hooks are duck-typed (`typeof X === 'function'`) in
  // calc-autofill.js — real equipment-matrix.js logic (EM row join, heating-type
  // classification, effective-schedules import) is that file's own domain and already has its
  // own coverage; these are SYNTHETIC stand-ins so this test isolates calc-autofill.js's own
  // resolution logic (what changed 2026-09-23), not a reimplementation of equipment-matrix.js.
  if (opts.emRows !== undefined) sandbox.emBuildSetpointExportRows = () => opts.emRows;
  if (opts.proposedSchedule !== undefined) sandbox._emComputeProposedSchedule = () => opts.proposedSchedule;
  if (opts.emSpDefaults !== undefined) sandbox.EM_SP_DEFAULTS = opts.emSpDefaults;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'calc-autofill.js' });
  // Top-level `const`/`let` in a vm-executed script are lexical bindings, not properties of the
  // context/global object — a plain `sandbox.CH_LEGACY_CALC_PLACEHOLDERS` read would see
  // `undefined` even though calc-autofill.js's own top-level code (and, in the real browser
  // page, calculators.js loaded after it in the same document) sees it fine. Explicitly copy it
  // onto the sandbox object so this test can assert against it directly.
  vm.runInContext('this.CH_LEGACY_CALC_PLACEHOLDERS = CH_LEGACY_CALC_PLACEHOLDERS;', sandbox, {
    filename: 'calc-autofill-export-shim.js',
  });
  return sandbox;
}

// Same 20-column shape emBuildSetpointExportRows (app/equipment-matrix.js) produces, matching
// EM_SETPOINT_EXPORT_HEADERS' push order — see calc-autofill.js's avgCol(3..6), '?'-filtered
// columns 9/10, and avgCol(14..15) usage.
function mkEmRow(overrides) {
  const row = [
    'Bldg',
    'Zone',
    'VAV',
    '70',
    '74',
    '55',
    '85',
    '±2',
    '?',
    '?',
    '?',
    '?', // 8-11: existing schedule — '?' unless an Effective Schedules import matched
    '70',
    '74',
    '60',
    '85',
    '±2',
    '6:00',
    '17:00',
    'None', // 12-19: proposed
  ];
  Object.keys(overrides || {}).forEach((idx) => (row[Number(idx)] = overrides[idx]));
  return row;
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

console.log('--- 5. Proposed Conditions always company-standard, even with zero building data ---');
{
  const sb = makeSandbox([{ id: 1, __buildings: [{ id: 'bEmpty', meters: [{ commodity: 'Electric' }] }] }], {
    emRows: [],
    proposedSchedule: { start: '6:00', stop: '17:00' },
    emSpDefaults: {
      unocc: {
        hydronic: { heat: 55, cool: 85 },
        electricReheat: { heat: 60, cool: 85 },
        heatpump: { heat: 65, cool: 85 },
      },
    },
  });
  const auto = sb.chCalcAutofillFields(1, 'bEmpty');
  assert(auto.newHeatOcc.value === 70 && !auto.newHeatOcc.isDefault, 'newHeatOcc always 70, never flagged default');
  assert(auto.newCoolOcc.value === 74 && !auto.newCoolOcc.isDefault, 'newCoolOcc always 74, never flagged default');
  assert(
    auto.newMfOn.value === 6 && auto.newMfOff.value === 17,
    'newMfOn/newMfOff from company-standard schedule (6:00-17:00)',
  );
  assert(
    auto.newSatOn.value === 0 && auto.newSatOff.value === 0 && auto.newSunOn.value === 0 && auto.newSunOff.value === 0,
    'weekend schedule always company-standard unoccupied (0/0)',
  );
  // No Gas meter -> hasGas===false -> electricReheat bucket (60/85), never the blind hydronic default
  assert(
    auto.newHeatUnocc.value === 60 && auto.newCoolUnocc.value === 85 && !auto.newHeatUnocc.isDefault,
    'newHeatUnocc/newCoolUnocc fall back to electricReheat bucket for an all-electric building with zero EM rows',
  );

  // Building WITH a Gas meter and zero EM rows -> hydronic bucket (55/85), not electricReheat
  const sbGas = makeSandbox([{ id: 1, __buildings: [{ id: 'bGas', meters: [{ commodity: 'Gas' }] }] }], {
    emRows: [],
    proposedSchedule: { start: '6:00', stop: '17:00' },
    emSpDefaults: sb.EM_SP_DEFAULTS,
  });
  const autoGas = sbGas.chCalcAutofillFields(1, 'bGas');
  assert(
    autoGas.newHeatUnocc.value === 55 && autoGas.newCoolUnocc.value === 85,
    'gas building falls back to hydronic bucket (55/85)',
  );
}

console.log('--- 6. Equipment Matrix fallback — Existing + Proposed Unoccupied from synthetic EM rows ---');
{
  const rows = [
    mkEmRow({ 3: '68', 4: '76', 5: '58', 6: '82', 9: '7:00', 10: '16:00', 14: '62', 15: '84' }),
    mkEmRow({ 3: '72', 4: '78', 5: '60', 6: '84', 9: '7:30', 10: '15:30', 14: '58', 15: '84' }),
  ];
  const sb = makeSandbox(
    [{ id: 1, __buildings: [{ id: 'bEM', meters: [{ commodity: 'Gas' }, { commodity: 'Electric' }] }] }],
    {
      emRows: rows,
      proposedSchedule: { start: '6:00', stop: '17:00' },
    },
  );
  const auto = sb.chCalcAutofillFields(1, 'bEM');
  assert(
    auto.exHeatOcc.value === 70 && auto.exHeatOcc.source === 'Equipment Matrix',
    'exHeatOcc averaged from EM col 3 (68,72->70)',
  );
  assert(
    auto.exCoolOcc.value === 77 && auto.exCoolOcc.source === 'Equipment Matrix',
    'exCoolOcc averaged from EM col 4 (76,78->77)',
  );
  assert(auto.exHeatUnocc.value === 59, 'exHeatUnocc averaged from EM col 5 (58,60->59)');
  assert(auto.exCoolUnocc.value === 83, 'exCoolUnocc averaged from EM col 6 (82,84->83)');
  assert(
    auto.exMfOn.value === 7 && /Effective Schedules import/.test(auto.exMfOn.source),
    'exMfOn parsed+averaged+rounded from EM Effective Schedules columns (7:00,7:30->7.25->7)',
  );
  assert(
    auto.exMfOff.value === 16,
    'exMfOff parsed+averaged+rounded from EM Effective Schedules columns (16:00,15:30->15.75->16)',
  );
  assert(
    auto.newHeatUnocc.value === 60 && auto.newHeatUnocc.source === 'Equipment Matrix',
    'newHeatUnocc averaged from EM col 14 (62,58->60)',
  );
  assert(
    auto.newCoolUnocc.value === 84 && auto.newCoolUnocc.source === 'Equipment Matrix',
    'newCoolUnocc averaged from EM col 15 (84,84->84)',
  );

  // A real Set Points record still wins over the Equipment Matrix fallback for the same building.
  const sbSp = makeSandbox(
    [
      {
        id: 1,
        __buildings: [{ id: 'bEM', meters: [] }],
        setpoints: [{ buildingId: 'bEM', zones: [{ occCool: 74, unoccCool: 85, occHeat: 70, unoccHeat: 55 }] }],
      },
    ],
    { emRows: rows, proposedSchedule: { start: '6:00', stop: '17:00' } },
  );
  const autoSp = sbSp.chCalcAutofillFields(1, 'bEM');
  assert(
    autoSp.exHeatOcc.value === 70 && autoSp.exHeatOcc.source === 'Set Points',
    'Set Points wins over Equipment Matrix when both exist',
  );

  // A row where the Effective Schedules columns are still '?' (never imported) never invents a
  // schedule — exMfOn/exMfOff stay flagged default.
  const sbNoSched = makeSandbox([{ id: 1, __buildings: [{ id: 'bEM2', meters: [] }] }], {
    emRows: [mkEmRow({})],
    proposedSchedule: { start: '6:00', stop: '17:00' },
  });
  const autoNoSched = sbNoSched.chCalcAutofillFields(1, 'bEM2');
  assert(
    autoNoSched.exMfOn.isDefault && autoNoSched.exMfOff.isDefault,
    "'?' Effective Schedules columns never invent a schedule",
  );
}

console.log('--- 7. _chParseClockHM ---');
{
  const sb = makeSandbox([{ id: 1, __buildings: [] }]);
  assert(sb._chParseClockHM('6:00') === 6, '"6:00" -> 6');
  assert(sb._chParseClockHM('15:05') === 15.08, '"15:05" -> 15.08 (5/60 rounded to 2 decimals)');
  assert(sb._chParseClockHM('?') === null, "'?' -> null, never guessed");
  assert(sb._chParseClockHM('') === null, 'empty string -> null');
  assert(sb._chParseClockHM(undefined) === null, 'undefined -> null, never throws');
}

console.log('--- 8. chIsLegacyCalcPlaceholderSave ---');
{
  const sb = makeSandbox([{ id: 1, __buildings: [] }]);
  const legacyBc = { ...sb.CH_LEGACY_CALC_PLACEHOLDERS };
  assert(sb.chIsLegacyCalcPlaceholderSave(legacyBc) === true, 'exact 22-field legacy Excel placeholder match -> true');
  assert(sb.chIsLegacyCalcPlaceholderSave(null) === false, 'empty/missing bc -> false, never matches');
  assert(sb.chIsLegacyCalcPlaceholderSave({}) === false, 'empty object -> false');

  // A single real user edit among the 22 fields breaks the exact match — never mistaken for the
  // frozen legacy set.
  const oneEdited = { ...legacyBc, exCoolOcc: 72 };
  assert(
    sb.chIsLegacyCalcPlaceholderSave(oneEdited) === false,
    'one real edit among the 22 fields -> false (not a legacy match)',
  );

  // Partial save (fewer than all 22 keys present) never matches either.
  const partial = { exCoolOcc: 55, exCoolUnocc: 70 };
  assert(sb.chIsLegacyCalcPlaceholderSave(partial) === false, 'partial bc (not all 22 keys) -> false');
}

console.log(
  '--- 9. Legacy-placeholder forgiveness composes correctly with chResolveCalcField (as openBASCalc wires it) ---',
);
{
  const sb = makeSandbox([{ id: 1, __buildings: [] }]);
  const legacyBc = { ...sb.CH_LEGACY_CALC_PLACEHOLDERS };
  const isLegacy = sb.chIsLegacyCalcPlaceholderSave(legacyBc);
  assert(isLegacy, 'fixture is recognized as the legacy placeholder set');
  const autoExHeatOcc = { value: 68, source: 'Equipment Matrix', isDefault: false };
  // This is exactly the _bcResolve composition added to openBASCalc: blank the saved value for
  // a CH_LEGACY_CALC_PLACEHOLDERS key when the whole bc matches, so autofill runs instead of the
  // frozen legacy value (exHeatOcc:70) winning as a "real" saved value.
  const savedValue = isLegacy && 'exHeatOcc' in sb.CH_LEGACY_CALC_PLACEHOLDERS ? undefined : legacyBc.exHeatOcc;
  const resolved = sb.chResolveCalcField(savedValue, 70, autoExHeatOcc, new Set(), 'exHeatOcc');
  assert(
    resolved.value === 68 && resolved.hint === 'from Equipment Matrix',
    'legacy placeholder exHeatOcc (70) is forgiven -> Equipment Matrix autofill (68) wins',
  );

  // A field the user genuinely touched this session, even while the rest of bc still matches the
  // legacy set, must still be protected (the `touched` Set check is independent of the
  // savedValue-blanking above).
  const touchedResolved = sb.chResolveCalcField(
    isLegacy ? undefined : legacyBc.exHeatOcc,
    70,
    autoExHeatOcc,
    new Set(['exHeatOcc']),
    'exHeatOcc',
  );
  assert(
    touchedResolved.value === 70 && touchedResolved.hint === null,
    'a field touched this session is still protected even under legacy-placeholder forgiveness',
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
