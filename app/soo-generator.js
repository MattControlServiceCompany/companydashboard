/* ─────────────────────────────────────────────────────────────────────────
   app/soo-generator.js — Sequence of Operations (SOO) Generator
   Item 3f1415af. Design: AI/_context/research/2026-09-13-soo-in-site-design/
   blueprint.md. Clause source: AI/_context/research/
   2026-09-13-master-soo-template-inventory.md, cross-checked directly
   against "Master Sequences of Operation 2023.docx" paragraph-by-paragraph
   (python-docx + raw OOXML inspection) during implementation.

   PHASE 2 (2026-09-13, this pass) added, on top of Phase 1's unchanged
   render/selection machinery: reheatActuator (4-way, wired into
   EM_EQUIP_CONFIG_FLAGS.vav) selecting reheat-modulating vs reheat-staged;
   co2Function (2-way) gating min-vent-co2 on 'dcv-reset' only; a new
   occ-standby clause (JOCO-authored, no master text) gated on hasOccSensor;
   isSeries added to EM_EQUIP_CONFIG_FLAGS.vav (previously fpb-only) wiring
   the already-built fan-series clause for real VAV rows. All 3
   SOO_BEHAVIOR_DEFAULTS settings (standbyAirflowMode, datFloorFailureMode,
   seriesFanRunMode) were already wired end-to-end in Phase 1 — unchanged
   here, only exercised against the new flag combinations in verification.

   SCOPE (Phase 1 — smallest end-to-end slice, per blueprint's build
   sequence): one equipment type (vav), the hot-water reheat VAV path,
   point/flag-driven clause selection. No new UI view (that is Phase 3) —
   only a TEMPORARY entry point (see sooGenerateForRow below).

   FORMAT-CORRECTION PASS (2026-09-13, Matt's review): the FIRST cut of this
   file rendered the SOO through the CompanyHub report engine's `.rpt-page`
   shell (rptPage()/showReportOverlay()) and exported via the shared
   exportReportToDocx()/_docxTranslatePages() report pipeline. Matt: that is
   WRONG — the output must reproduce the MASTER SEQUENCES OF OPERATION
   document's own Word format (Heading 1 section headers, Normal paragraphs
   with a bold-label-colon lead-in, bold "(adj.)" value spans, no report
   chrome at all), not a branded report page. This pass replaces BOTH
   render layers (preview + Word export) while leaving the clause-selection
   logic (appliesWhen/ctx.points/ctx.flags) byte-for-byte unchanged — see
   `sooBuildContext`/`sooSelectClauses` below, untouched from Phase 1a.

   Clause data model: each clause's `paragraphs(ctx)` returns an array of
   paragraph objects `{ tight, runs: [{ text, bold }, ...] }`:
     - `runs` — a paragraph's content as bold/normal spans, matching the
       master doc's OWN run-level bold usage exactly (verified per clause
       against the real OOXML — see inline citations below). This is NOT a
       universal "bold everything ending in (adj.)" rule; the master itself
       is inconsistent between clauses (Flow Control/Reheat bold every
       "(adj.)" phrase; the VAV Alarms block bolds none of them) — each
       clause replicates its OWN observed pattern.
     - `tight` — true when the master's own paragraph has
       `<w:spacing w:after="0"/>` (paragraphs that visually hug the next
       line, e.g. a clause's own sub-rows); false uses the document
       default spacing (~8pt, docDefaults `w:after="160"`).
   Two renderers consume the same paragraph array with zero duplicated
   content: `sooParaToPreviewHtml` (plain on-screen preview) and
   `_sooParaToDocxXml` (real Heading 1/Normal/bold-run OOXML, spliced into
   SOO_DOCX_SKELETON_B64 — see app/soo-docx-skeleton.js — via
   `_sooDocxAssemble`, a SEPARATE assembler from app/docx-writer.js's
   `_docxAssemble`/CSC_DOCX_SKELETON_B64, which is report-specific and must
   never be reused here).

   HARD LESSON (blueprint, JOCO): reheat-actuator mechanism and CO2 function
   are NOT safely inferable from point presence — point presence only proves
   a wire exists, not what the program does with it. Phase 1 reads
   flags.reheatActuator / flags.co2Function if a caller has set them, but
   defaults them (pid-valve / dcv-reset) rather than guessing from points.
   Never add auto-detect-actuator-from-point-name logic here.

   Adjustable numeric values render literally where the master doc itself
   states a default (e.g. the Zone Setpoints table's "74 Degrees F (adj.)")
   — that is the master template's own stated default, not an invented
   number. Where the master doc gives no default (box-specific airflow
   CFMs, runtimes), the clause text keeps the master's own descriptive
   "(adj.)" phrasing with no numeric fill — never invented.
   ───────────────────────────────────────────────────────────────────────── */

/* ── 1. SOO_BEHAVIOR_DEFAULTS — the 3 open JOCO decisions ───────────────────
   Unchanged from Phase 1a. None of the 3 non-default options exist in the
   master doc (see inventory §3) — they are authored, sourced from
   2026-09-13-joco-vav-soo-review/findings.md, never presented as docx
   quotations. Stored at en_soo_settings via sset/sget (never localStorage
   directly — architecture contract §6). */
var SOO_BEHAVIOR_DEFAULTS = {
  standbyAirflowMode: 'minimum', // | 'sameAsOccupiedMax'
  datFloorFailureMode: 'increaseAirflowToMax', // | 'dropToMinAndAlarm'
  seriesFanRunMode: 'continuous', // | 'occupiedOnly'
};

function sooLoadSettings() {
  var stored = typeof sget === 'function' ? sget('en_soo_settings', {}) : {};
  var merged = {};
  var k;
  for (k in SOO_BEHAVIOR_DEFAULTS) {
    if (SOO_BEHAVIOR_DEFAULTS.hasOwnProperty(k)) merged[k] = SOO_BEHAVIOR_DEFAULTS[k];
  }
  for (k in stored) {
    if (stored.hasOwnProperty(k)) merged[k] = stored[k];
  }
  return merged;
}

function sooSaveSettings(settings) {
  if (typeof sset === 'function') sset('en_soo_settings', settings);
}

// Temp console helper (Phase 1 — no settings UI yet): sooSetSetting('standbyAirflowMode','sameAsOccupiedMax')
function sooSetSetting(key, value) {
  var s = sooLoadSettings();
  s[key] = value;
  sooSaveSettings(s);
  return s;
}

/* ── 2. Zone types excluded from public-facing occupant controls ───────────
   Master doc (Zone Setpoint Adjust / Zone Unoccupied Override): "Sensors in
   public areas will not have this functionality unless specifically
   requested." Excluded set per inventory §2 row 70. Unchanged from Phase 1a. */
var SOO_PUBLIC_AREA_EXCLUDED_ZONE_TYPES = [
  'corridor',
  'restroom',
  'stairwell',
  'elevator_lobby',
  'mech_elec',
  'storage',
  'secure_cell',
];

/* ── 3. Paragraph/run helpers ────────────────────────────────────────────── */
function _sooRun(text, bold) {
  return { text: text, bold: !!bold };
}
function _sooPara(runs, tight) {
  return { runs: runs, tight: !!tight };
}

/* ── 4. SOO_TEMPLATES.vav — Phase 1 clause library ──────────────────────────
   appliesWhen(ctx) is UNCHANGED from Phase 1a (this is the point/flag-driven
   selection logic Matt confirmed is correct) — reads ctx.flags
   (emLoadEquipConfigFlags output) and ctx.points (categoryKey -> true, from
   emComputeCompliance's coveredPoints, i.e. a point actually present on this
   row). reheatActuator/co2Function are read from flags if a caller has set
   them but are NOT yet EM_EQUIP_CONFIG_FLAGS.vav entries (Phase 2) — default
   to the modulating/DCV-reset case, never inferred from points.

   paragraphs(ctx) replaces the old text/vars {{TOKEN}} model — each clause
   below cites the exact master-doc paragraph(s) it reproduces, or "JOCO-only"
   where no master text exists. */
var SOO_TEMPLATES = {
  vav: [
    {
      id: 'zone-control-modes',
      order: 10,
      title: 'Zone Control Modes',
      appliesWhen: function () {
        return true;
      },
      // Master doc, "Zone Control Modes:" paragraph — bold label, normal
      // continuation, default (non-tight) spacing.
      paragraphs: function () {
        return [
          _sooPara([
            _sooRun('Zone Control Modes:', true),
            _sooRun(
              ' There are 5 modes for each zone: occupied and unoccupied as determined by an ' +
                'operator defined schedule, and 3 override demand levels as determined by the ' +
                'kilowatt meter and operator defined parameters. Each mode has individually ' +
                'adjustable heating and cooling setpoints. Each zone will have a color associated ' +
                'with the condition of the zone with respect to temperature and the applicable ' +
                'setpoint. The color will be green when the temperature is between the heating and ' +
                'cooling setpoint. The color will change progressively from green to yellow, ' +
                'orange, and then red as the temperature rises progressively above the cooling ' +
                'setpoint. The color will change progressively from green to light blue, dark blue, ' +
                'and then red as the temperature drops progressively below the heating setpoint. ' +
                'Gray will represent the unoccupied mode.',
              false,
            ),
          ]),
        ];
      },
    },
    {
      id: 'zone-setpoints',
      order: 20,
      title: 'Zone Setpoints',
      appliesWhen: function () {
        return true;
      },
      // Master doc, "Zone Setpoints:" + the 10-row default table — EVERY row
      // (including the intro line) is its own tight paragraph (spacing
      // after=0) in the master; Demand Level 1-3 rows only render when a
      // demandLevel point is actually mapped on this row (inventory §2 row
      // 20), matching Phase 1a's gating exactly.
      paragraphs: function (ctx) {
        var paras = [
          _sooPara(
            [_sooRun('Zone Setpoints:', true), _sooRun(' The default space setpoints for each state shall be:', false)],
            true,
          ),
        ];
        function row(label, value) {
          paras.push(_sooPara([_sooRun(label + ' – ', false), _sooRun(value, true)], true));
        }
        row('Occupied Cooling', '74 Degrees F (adj.)');
        row('Occupied Heating', '70 Degrees F (adj.)');
        if (ctx.points.demandLevel) {
          row('Demand Level 1 Cooling', '76 Degrees F (adj.)');
          row('Demand Level 1 Heating', '68 Degrees F (adj.)');
          row('Demand Level 2 Cooling', '78 Degrees F (adj.)');
          row('Demand Level 2 Heating', '66 Degrees F (adj.)');
          row('Demand Level 3 Cooling', '80 Degrees F (adj.)');
          row('Demand Level 3 Heating', '64 Degrees F (adj.)');
        }
        row('Unoccupied Cooling', '80 Degrees F (adj.)');
        row('Unoccupied Heating', '60 Degrees F (adj.)');
        return paras;
      },
    },
    {
      id: 'schedule',
      order: 30,
      title: 'Schedule',
      appliesWhen: function () {
        return true;
      },
      // Master doc, "Schedule:" paragraph — bold label, normal continuation,
      // default (non-tight) spacing.
      paragraphs: function () {
        return [
          _sooPara([
            _sooRun('Schedule:', true),
            _sooRun(' Zone will operate according to a user-definable schedule.', false),
          ]),
        ];
      },
    },
    {
      id: 'unocc-override',
      order: 70,
      title: 'Zone Unoccupied Override',
      appliesWhen: function (ctx) {
        var zt = (ctx.flags && ctx.flags.zoneType) || 'vav';
        return SOO_PUBLIC_AREA_EXCLUDED_ZONE_TYPES.indexOf(zt) === -1;
      },
      // Master doc, "Zone Unoccupied Override:" paragraph — bold label,
      // normal continuation (no bold spans in the master's own text),
      // default (non-tight) spacing. The master's trailing italic caveat
      // sentence ("Sensors in public areas will not have this
      // functionality...") is represented instead by this clause's
      // appliesWhen gate (Phase 1a's design decision, kept unchanged) rather
      // than shown as italic text.
      paragraphs: function () {
        return [
          _sooPara([
            _sooRun('Zone Unoccupied Override:', true),
            _sooRun(
              ' A timed local override control will allow an occupant to override the schedule ' +
                'and place the unit into an occupied mode for an adjustable period of time. At the ' +
                'expiration of this time, control of the unit will automatically return to the ' +
                'schedule.',
              false,
            ),
          ]),
        ];
      },
    },
    {
      id: 'occ-standby',
      order: 75,
      title: 'Zone Occupancy Standby',
      // Phase 2, JOCO-only — NO master-doc equivalent (inventory §2 row
      // "occ-sensor-standby": "(no equivalent text exists)"; findings.md §3
      // item 8 lists "occupancy-standby software preference" as an
      // unresolved minor open item — there is no JOCO-decided wording to
      // lift either). Authored fresh, gated strictly on the manual
      // hasOccSensor flag (default:false) AND the occSensor point actually
      // being mapped — same two-part gate as every other flag-driven clause
      // in this file. No numeric default is invented; the standby delay
      // stays a plain "(adj.)" phrase with no bold styling, matching the
      // plain (non-bolded) style of the master's own Zone Unoccupied
      // Override clause it sits next to, since neither has a stated
      // master-doc default to bold.
      appliesWhen: function (ctx) {
        return !!ctx.flags.hasOccSensor && !!ctx.points.occSensor;
      },
      paragraphs: function () {
        return [
          _sooPara([
            _sooRun('Zone Occupancy Standby:', true),
            _sooRun(
              ' When the zone is scheduled occupied and the zone occupancy sensor indicates the ' +
                'space has been vacant for an adjustable period of time (adj.), the zone will enter ' +
                'a standby mode and control to the unoccupied setpoints. When the occupancy sensor ' +
                'again indicates the space is occupied, the zone will immediately return to the ' +
                'occupied setpoints.',
              false,
            ),
          ]),
        ];
      },
    },
    {
      id: 'min-vent-co2',
      order: 80,
      title: 'Minimum Ventilation on Carbon Dioxide (CO2) Concentration',
      // Phase 2: co2Function is a manual flag (EM_EQUIP_CONFIG_FLAGS.vav,
      // default 'dcv-reset') — NOT inferable from the co2 point being mapped
      // (blueprint hard lesson; JOCO rev19 gap G: NE Offices VAV-10b was
      // upgraded alarm-only -> full DCV reset with zero point-side change).
      // 'alarm-only' selects THIS clause OUT — the master doc's own Alarms
      // block "High Zone Carbon Dioxide Concentration" row (below, gated
      // solely on hasCO2+co2 point) already IS the alarm-only behavior, so
      // no separate "alarm-only clause" body is fabricated; alarm-only rows
      // stay present either way since a DCV-reset zone still alarms on
      // failure.
      appliesWhen: function (ctx) {
        var co2Fn = (ctx.flags && ctx.flags.co2Function) || 'dcv-reset';
        return ctx.flags.hasCO2 !== false && !!ctx.points.co2 && co2Fn === 'dcv-reset';
      },
      // Master doc, "Minimum Ventilation on Carbon Dioxide (CO2)
      // Concentration:" paragraph — bold label, normal continuation, bold
      // "1000 ppm (adj.)." value span, default (non-tight) spacing.
      paragraphs: function () {
        return [
          _sooPara([
            _sooRun('Minimum Ventilation on Carbon Dioxide (CO2) Concentration:', true),
            _sooRun(
              ' When in the occupied mode, the controller will measure the zone CO2 concentration ' +
                'and modulate the zone damper open on rising CO2 concentrations, overriding normal ' +
                'damper operation to maintain a CO2 setpoint of not more than ',
              false,
            ),
            _sooRun('1000 ppm (adj.).', true),
          ]),
        ];
      },
    },
    {
      id: 'flow-control',
      order: 100,
      title: 'Variable Volume Terminal Unit – Flow Control',
      appliesWhen: function () {
        return true;
      },
      // Master doc, "Variable Volume Terminal Unit - Flow Control:" — 5
      // paragraphs, ALL tight (spacing after=0) in the master, each bolding
      // its own "(adj.)" airflow phrase(s) plus the "Occupied:"/"Unoccupied:"
      // sub-labels. standbyAirflowMode selector (SOO_BEHAVIOR_DEFAULTS)
      // swaps the Unoccupied block: 'minimum' is the ONLY option with
      // master-doc text; 'sameAsOccupiedMax' is authored/JOCO-sourced
      // (inventory §3.1), never presented as a docx quotation.
      paragraphs: function (ctx) {
        var mode = (ctx.settings && ctx.settings.standbyAirflowMode) || 'minimum';
        var paras = [
          _sooPara(
            [
              _sooRun('Variable Volume Terminal Unit – Flow Control:', true),
              _sooRun(
                ' The unit will maintain zone setpoints by controlling the airflow through one of the following:',
                false,
              ),
            ],
            true,
          ),
          _sooPara(
            [
              _sooRun('Occupied:  ', true),
              _sooRun(
                'When zone temperature is greater than its cooling setpoint, the zone damper will modulate between the ',
                false,
              ),
              _sooRun('minimum occupied airflow (adj.)', true),
              _sooRun(' and the ', false),
              _sooRun('maximum cooling airflow (adj.)', true),
              _sooRun(' until the zone is satisfied.', false),
            ],
            true,
          ),
          _sooPara(
            [
              _sooRun(
                'When the zone temperature is less than the cooling setpoint, the zone damper will maintain the ',
                false,
              ),
              _sooRun('minimum required zone ventilation (adj.).', true),
            ],
            true,
          ),
        ];
        if (mode === 'sameAsOccupiedMax') {
          // Authored alternate (JOCO review) — no master-doc equivalent.
          paras.push(
            _sooPara(
              [
                _sooRun('Unoccupied:  ', true),
                _sooRun('the zone damper will control to the same ', false),
                _sooRun('maximum cooling airflow (adj.)', true),
                _sooRun(' used in occupied mode — the unoccupied minimum airflow is not reduced.', false),
              ],
              true,
            ),
          );
        } else {
          paras.push(
            _sooPara(
              [
                _sooRun('Unoccupied:  ', true),
                _sooRun('When the zone is unoccupied the zone damper will control to its ', false),
                _sooRun('minimum unoccupied airflow (adj.).', true),
              ],
              true,
            ),
            _sooPara(
              [
                _sooRun(
                  'When the zone temperature is greater than its cooling setpoint, the zone damper will modulate between the ',
                  false,
                ),
                _sooRun('minimum unoccupied airflow (adj.)', true),
                _sooRun(' and the ', false),
                _sooRun('maximum cooling airflow (adj.)', true),
                _sooRun(' until the zone is satisfied.', false),
              ],
              true,
            ),
          );
        }
        return paras;
      },
    },
    {
      id: 'reheat-modulating',
      order: 120,
      title: 'Reheating Coil Valve',
      // hasReheat + reheatValve point present -> reheat clause family
      // (blueprint §"Point signal -> clause mapping"). reheatActuator is a
      // manual flag (Phase 2: now a real EM_EQUIP_CONFIG_FLAGS.vav select,
      // default 'pid-valve' — NOT point-derived); the 3 modulating
      // mechanisms (pid-valve/linear-valve/floating-motor, incl. the JOCO
      // "Three-Point Floating-Motor Reheat" type, findings.md coverage
      // table, 35 boxes) read as IDENTICAL master-doc prose — inventory §6:
      // "don't build three near-duplicate clause bodies for the three
      // modulating variants." Only electric-binary gets distinct staged
      // text (reheat-staged, below). Selection logic unchanged from Phase 1.
      appliesWhen: function (ctx) {
        if (ctx.flags.hasReheat === false || !ctx.points.reheatValve) return false;
        var actuator = ctx.flags.reheatActuator || 'pid-valve';
        return actuator !== 'electric-binary';
      },
      // Master doc, "Reheating Coil Valve:" paragraph pair — both tight,
      // bolding the two airflow "(adj.)" phrases.
      paragraphs: function () {
        return [
          _sooPara(
            [
              _sooRun('Reheating Coil Valve:', true),
              _sooRun(
                ' The controller will measure the zone temperature and modulate the reheating coil valve ' +
                  'open on dropping temperature to maintain its heating setpoint.',
                false,
              ),
            ],
            true,
          ),
          _sooPara(
            [
              _sooRun(
                'When cold air is available from the AHU and there is no fan present in the box, the zone ' +
                  'damper will modulate to the ',
                false,
              ),
              _sooRun('minimum occupied airflow (adj.).', true),
              _sooRun(' If more heat is required, the zone damper will modulate to the ', false),
              _sooRun('auxiliary heating airflow (adj.).', true),
            ],
            true,
          ),
        ];
      },
    },
    {
      id: 'reheat-staged',
      order: 110,
      title: 'Electric Reheating Stage',
      appliesWhen: function (ctx) {
        if (ctx.flags.hasReheat === false || !ctx.points.reheatValve) return false;
        var actuator = ctx.flags.reheatActuator || 'pid-valve';
        return actuator === 'electric-binary';
      },
      // Master doc, "Electric Reheating Stage:" — 5 tight paragraphs. Note
      // the master does NOT bold "a user definable (adj.) minimum runtime"
      // (unlike Flow Control's airflow phrases) — only the stated "65°F
      // (adj.)" OAT lockout number is bold. Replicated exactly, not
      // normalized to one universal bold rule.
      paragraphs: function () {
        return [
          _sooPara(
            [
              _sooRun('Electric Reheating Stage: ', true),
              _sooRun(
                'The controller will measure the zone temperature and stage the reheating to maintain its ' +
                  'setpoint. To prevent short cycling, the stage will have a user definable (adj.) minimum ' +
                  'runtime.',
                false,
              ),
            ],
            true,
          ),
          _sooPara([_sooRun('The reheating will be enabled whenever:', false)], true),
          _sooPara([_sooRun('Outside air temperature is less than ', false), _sooRun('65°F (adj.).', true)], true),
          _sooPara([_sooRun('AND the zone temperature is below setpoint.', false)], true),
          _sooPara([_sooRun('AND sufficient airflow is provided.', false)], true),
        ];
      },
    },
    {
      id: 'dat-floor-failure',
      order: 125,
      title: 'Discharge Air Temperature (DAT) Floor Interlock',
      // JOCO-only clause — no master-doc equivalent (inventory §2/§3). Gated
      // purely on the dat point being present (blueprint: "highest reach:
      // ~100% of reheat boxes"). Authored in the same visual convention as
      // Flow Control/Reheating Coil Valve (bold label, bold "(adj.)"
      // phrases) since it belongs to the same functional family.
      appliesWhen: function (ctx) {
        return !!ctx.points.dat;
      },
      paragraphs: function (ctx) {
        var mode = (ctx.settings && ctx.settings.datFloorFailureMode) || 'increaseAirflowToMax';
        var tailRuns =
          mode === 'dropToMinAndAlarm'
            ? [
                _sooRun(
                  'If the reheat valve is fully open (100%) and the discharge air temperature remains below ',
                  false,
                ),
                _sooRun('50°F (adj.)', true),
                _sooRun(', the zone damper will reduce to the ', false),
                _sooRun('minimum occupied airflow (adj.)', true),
                _sooRun(' and the controller will generate an alarm.', false),
              ]
            : [
                _sooRun(
                  'If the reheat valve is fully open (100%) and the discharge air temperature remains below ',
                  false,
                ),
                _sooRun('50°F (adj.)', true),
                _sooRun(', the zone damper will increase airflow toward the ', false),
                _sooRun('maximum heating airflow (adj.)', true),
                _sooRun(' until the discharge air temperature recovers above the floor.', false),
              ];
        return [
          _sooPara(
            [
              _sooRun('Discharge Air Temperature (DAT) Floor Interlock:', true),
              _sooRun(
                ' The controller will monitor the discharge air temperature (DAT) leaving the reheat coil. ',
                false,
              ),
            ].concat(tailRuns),
          ),
        ];
      },
    },
    {
      id: 'fan-series',
      order: 140,
      title: 'Fan Control – Series',
      // Phase 2: isSeries is now a real EM_EQUIP_CONFIG_FLAGS.vav entry
      // (default false — JOCO rev19 gap A: series fan-powered boxes are
      // field-tagged plain VAV, so this must be a manual override, never
      // inferred; setting it does NOT force EM to recategorize the row as
      // fpb, per blueprint's explicit constraint). Defaults false, so this
      // clause normally does not render for a plain VAV box.
      appliesWhen: function (ctx) {
        return ctx.flags.isSeries === true;
      },
      paragraphs: function (ctx) {
        var mode = (ctx.settings && ctx.settings.seriesFanRunMode) || 'continuous';
        var body =
          mode === 'occupiedOnly'
            ? 'The fan will run only when the zone is in occupied mode. The fan will run for a minimum ' +
              'user definable time (adj.).'
            : 'The fan will run anytime the unit is commanded to run. The fan will run for a minimum ' +
              'user definable time (adj.).';
        return [
          _sooPara([
            _sooRun('Fan Control – Series:', true),
            _sooRun(
              ' ' +
                body +
                ' The zone damper will close completely before the fan starts to prevent air from the AHU ' +
                'from causing the fan to spin backward. The zone damper will return to automatic control ' +
                'after the fan starts.',
              false,
            ),
          ]),
        ];
      },
    },
    {
      id: 'alarms',
      order: 900,
      title: 'Alarms',
      appliesWhen: function () {
        return true;
      },
      // Master doc, VAV-specific alarms block — "Alarms will be provided as
      // follows:" bold label (tight), then each alarm row its OWN tight
      // paragraph with NO bold anywhere (unlike Flow Control, the master
      // does not bold the "(adj.)" phrases in this block — replicated
      // exactly). CO2 row gated on hasCO2 + the co2 point, matching Phase
      // 1a. VOC row omitted — inventory §5 gap (no EM hasVOC/vocSensor flag
      // exists yet).
      paragraphs: function (ctx) {
        var paras = [
          _sooPara([_sooRun('Alarms will be provided as follows:', true)], true),
          _sooPara(
            [
              _sooRun(
                'High Zone Temp: If the zone temperature is greater than the cooling setpoint by a user definable amount (adj.).',
                false,
              ),
            ],
            true,
          ),
          _sooPara(
            [
              _sooRun(
                'Low Zone Temp: If the zone temperature is less than the heating setpoint by a user definable amount (adj.).',
                false,
              ),
            ],
            true,
          ),
        ];
        if (ctx.flags.hasCO2 !== false && ctx.points.co2) {
          paras.push(
            _sooPara(
              [
                _sooRun(
                  'High Zone Carbon Dioxide Concentration: If the zone CO2 concentration is greater than ____ ppm (adj.).',
                  false,
                ),
              ],
              true,
            ),
          );
        }
        return paras;
      },
    },
  ],
};

/* ── 5. Context builder — reuses EM's existing point/flag machinery ─────────
   UNCHANGED from Phase 1a. Zero re-derivation of point presence:
   emGetNormalizedPoints (indirectly, via emComputeCompliance) and
   emLoadEquipConfigFlags are the SAME functions the Equipment Matrix
   audit/compliance view already uses. ctx.points is built from
   compliance.coveredPoints (a point actually matched on this row), not from
   configFlag defaults — a flag can say hasReheat:true with no reheatValve
   point actually mapped, and the reheat clause correctly will not render. */
function sooBuildContext(pid, rowId) {
  var data = emLoadMatrix(pid);
  if (!data) return null;
  var row = null;
  for (var i = 0; i < (data.rows || []).length; i++) {
    if (data.rows[i].id === rowId) {
      row = data.rows[i];
      break;
    }
  }
  if (!row) return null;

  var flags = emLoadEquipConfigFlags(pid, rowId);
  var customMappings = emLoadCustomMappings(pid);
  var compliance = emComputeCompliance(row, flags, customMappings);

  var points = {};
  (compliance.coveredPoints || []).forEach(function (p) {
    points[p.categoryKey] = true;
  });

  return {
    pid: pid,
    row: row,
    flags: flags,
    points: points,
    settings: sooLoadSettings(),
  };
}

/* ── 6. Clause selection — UNCHANGED from Phase 1a ──────────────────────── */
function sooSelectClauses(category, ctx) {
  var lib = SOO_TEMPLATES[category] || [];
  var selected = lib.filter(function (c) {
    return c.appliesWhen(ctx);
  });
  selected.sort(function (a, b) {
    return a.order - b.order;
  });
  return selected;
}

/* ── 7. Master-format paragraph list for one equipment row ─────────────────
   Builds the FULL ordered paragraph list for the document: an identifying
   line for which equipment this covers (the master template has no
   per-box identification — it is a library, not a project deliverable),
   then the equipment-type Heading 1 (verbatim master section title), then
   each selected clause's paragraphs in order. */
function sooBuildDocParagraphs(ctx) {
  var row = ctx.row;
  var idLabel = (row.equipName || row.name || row.id) + (row.building ? ' — ' + row.building : '');
  var clauses = sooSelectClauses(row.category || 'vav', ctx);

  var paras = [];
  paras.push(_sooPara([_sooRun(idLabel, true)], false));
  paras.push({ heading1: true, runs: [_sooRun('Variable Air Volume – Terminal Units', false)], tight: false });
  clauses.forEach(function (clause) {
    var clauseParas = clause.paragraphs(ctx) || [];
    for (var i = 0; i < clauseParas.length; i++) paras.push(clauseParas[i]);
  });
  return paras;
}

/* ── 8. Plain preview renderer (NOT .rpt-page) ──────────────────────────────
   Per Matt's correction: the preview must be a plain white document page —
   heading + bold-label paragraphs — not the branded report shell. No
   pagination (the overlay's own .report-pages container already scrolls);
   "fine for the preview to be simple" per the correction brief. */
function sooParaToPreviewHtml(para) {
  if (para.heading1) {
    var htext = para.runs
      .map(function (r) {
        return emHtmlEsc(r.text);
      })
      .join('');
    return (
      '<h2 style="font-family:Calibri,Arial,sans-serif;font-size:16pt;font-weight:700;' +
      'color:#2E74B5;margin:16pt 0 0 0">' +
      htext +
      '</h2>'
    );
  }
  var inner = para.runs
    .map(function (r) {
      var t = emHtmlEsc(r.text);
      return r.bold ? '<strong>' + t + '</strong>' : t;
    })
    .join('');
  var marginBottom = para.tight ? '0' : '8pt';
  return (
    '<p style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.15;' +
    'color:#000;margin:0 0 ' +
    marginBottom +
    ' 0">' +
    inner +
    '</p>'
  );
}

function sooBuildPreviewHtml(ctx) {
  var paras = sooBuildDocParagraphs(ctx);
  var body = paras.map(sooParaToPreviewHtml).join('');
  return (
    '<div class="soo-doc-page" style="background:#fff;width:8.5in;min-height:11in;' +
    'box-sizing:border-box;padding:0.5in;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.25)">' +
    body +
    '</div>'
  );
}

/* ── 9. Word export — real Heading 1 / Normal / bold-run OOXML ─────────────
   Splices into SOO_DOCX_SKELETON_B64 (app/soo-docx-skeleton.js, built
   directly from the master .docx's own styles.xml/numbering.xml/theme1.xml
   so Heading 1's color/font and Normal's default font come from the master
   itself, not a hand-authored approximation). This is a SEPARATE assembler
   from app/docx-writer.js's _docxAssemble()/CSC_DOCX_SKELETON_B64 — that
   pipeline is report-specific (CSC letterhead, "Page N of M" footers,
   report-table numbering) and must never be reused here. */
function _sooXmlEsc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _sooRunToDocxXml(run) {
  var rPr = run.bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return '<w:r>' + rPr + '<w:t xml:space="preserve">' + _sooXmlEsc(run.text) + '</w:t></w:r>';
}

function _sooParaToDocxXml(para) {
  var pPrParts = [];
  if (para.heading1) pPrParts.push('<w:pStyle w:val="Heading1"/>');
  if (para.tight) pPrParts.push('<w:spacing w:after="0"/>');
  var pPr = pPrParts.length ? '<w:pPr>' + pPrParts.join('') + '</w:pPr>' : '';
  var runsXml = para.runs.map(_sooRunToDocxXml).join('');
  return '<w:p>' + pPr + runsXml + '</w:p>';
}

function sooBuildDocxBodyXml(ctx) {
  var paras = sooBuildDocParagraphs(ctx);
  return paras.map(_sooParaToDocxXml).join('');
}

/**
 * _sooDocxAssemble — splice bodyXml into SOO_DOCX_SKELETON_B64 and trigger a
 * download. Mirrors app/docx-writer.js's _docxAssemble() splice technique
 * (locate <w:body>/<w:sectPr>, preserve the skeleton's tail verbatim) but
 * against the SOO's own plain-document skeleton — no letterhead spacer, no
 * "Page N of M" footer rewrite, no report-table numbering splice, none of
 * which apply to a plain master-format document.
 */
async function _sooDocxAssemble(bodyXml, opts) {
  opts = opts || {};
  if (typeof JSZip === 'undefined') throw new Error('_sooDocxAssemble: JSZip is not loaded');
  if (typeof SOO_DOCX_SKELETON_B64 === 'undefined') {
    throw new Error('_sooDocxAssemble: SOO_DOCX_SKELETON_B64 is not loaded (app/soo-docx-skeleton.js)');
  }
  if (typeof _docxBase64ToUint8Array !== 'function') {
    throw new Error('_sooDocxAssemble: _docxBase64ToUint8Array is not loaded (app/docx-writer.js)');
  }

  var skeletonBytes = _docxBase64ToUint8Array(SOO_DOCX_SKELETON_B64);
  var zip = await JSZip.loadAsync(skeletonBytes);
  var skeletonDocXml = await zip.file('word/document.xml').async('string');

  var bodyOpenTag = '<w:body>';
  var bodyOpenIdx = skeletonDocXml.indexOf(bodyOpenTag);
  var sectPrIdx = skeletonDocXml.indexOf('<w:sectPr');
  if (bodyOpenIdx === -1 || sectPrIdx === -1) {
    throw new Error('_sooDocxAssemble: skeleton word/document.xml missing <w:body> or <w:sectPr>');
  }
  var head = skeletonDocXml.slice(0, bodyOpenIdx + bodyOpenTag.length);
  var tail = skeletonDocXml.slice(sectPrIdx);

  zip.file('word/document.xml', head + bodyXml + tail);

  var blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  if (opts.download !== false && typeof document !== 'undefined') {
    var filename = opts.filename || 'Sequence of Operations.docx';
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  return blob;
}

/**
 * sooExportToDocx — the SOO's own Word-export entry point. Called by
 * exportReportToDocx() (app/report-engine.js) when window._currentReportData
 * carries `_soo`, BEFORE that function reads any `.rpt-page` DOM — the SOO
 * export never touches the report translator.
 */
async function sooExportToDocx() {
  if (!_sooLastCtx) {
    if (typeof showToast === 'function') showToast('No Sequence of Operations generated yet');
    return;
  }
  if (typeof showToast === 'function') showToast('Generating Word document...');
  try {
    var bodyXml = sooBuildDocxBodyXml(_sooLastCtx);
    var client = _sooLastCtx.projectName || '';
    var _fnNow = new Date();
    var dateStr =
      _fnNow.getFullYear() +
      '.' +
      String(_fnNow.getMonth() + 1).padStart(2, '0') +
      '.' +
      String(_fnNow.getDate()).padStart(2, '0');
    var filename = (client ? client + ' - ' : '') + 'Sequence of Operations ' + dateStr + '.docx';
    await _sooDocxAssemble(bodyXml, { filename: filename });
    if (typeof showToast === 'function') showToast('Word document generated ✓');
  } catch (err) {
    console.error('SOO Word export failed:', err);
    if (typeof showToast === 'function')
      showToast('Word export failed: ' + (err && err.message ? err.message : err), 'error');
  }
}

/* ── 10. TEMPORARY entry point (Phase 1 only — Phase 3 builds the real UI) ─
   Generates a SOO for one VAV row and previews it in the existing report
   overlay (#reportPages / #reportOverlay, same Save/Export toolbar every
   other report type uses) — but the CONTENT rendered inside is the plain
   master-format document (sooBuildPreviewHtml), not `.rpt-page` markup.
   window._currentReportData._soo tells exportReportToDocx() to delegate to
   sooExportToDocx() instead of its own report translator. */
var _sooLastCtx = null;

function sooGenerateForRow(rowId) {
  var pid = window._emActivePid || '';
  if (!pid) {
    if (typeof showToast === 'function') showToast('No active project — open a project in Equipment Matrix first');
    return;
  }
  var ctx = sooBuildContext(pid, rowId);
  if (!ctx) {
    if (typeof showToast === 'function') showToast('Equipment row not found');
    return;
  }
  if ((ctx.row.category || '') !== 'vav') {
    if (typeof showToast === 'function') showToast('SOO Generator (Phase 1, temp): VAV only for now');
    return;
  }

  var projects = typeof sget === 'function' ? sget('en_projects', []) : [];
  // String() coercion: project ids in en_projects can be stored as JS numbers (Date.now()-based)
  // while window._emActivePid is always a string (DOM value attributes are strings) — a strict
  // === here silently fails to match and falls through to showing the raw id in the filename.
  var proj = projects.filter(function (p) {
    return String(p.id) === String(pid);
  })[0];
  ctx.projectName = proj ? proj.name || proj.id : pid;

  _sooLastCtx = ctx;

  var html = sooBuildPreviewHtml(ctx);
  var title = ctx.projectName + ' — Sequence of Operations (' + (ctx.row.equipName || ctx.row.id) + ')';

  window._currentReportData = {
    _soo: { rowId: rowId, equipName: ctx.row.equipName || ctx.row.id },
    project: { client: ctx.projectName, name: ctx.projectName },
  };

  if (typeof showReportOverlay === 'function') {
    showReportOverlay(html, title);
  } else if (typeof showToast === 'function') {
    showToast('showReportOverlay not available — report-engine.js not loaded');
  }
}

window.SOO_BEHAVIOR_DEFAULTS = SOO_BEHAVIOR_DEFAULTS;
window.SOO_TEMPLATES = SOO_TEMPLATES;
window.sooLoadSettings = sooLoadSettings;
window.sooSaveSettings = sooSaveSettings;
window.sooSetSetting = sooSetSetting;
window.sooBuildContext = sooBuildContext;
window.sooSelectClauses = sooSelectClauses;
window.sooBuildDocParagraphs = sooBuildDocParagraphs;
window.sooBuildPreviewHtml = sooBuildPreviewHtml;
window.sooBuildDocxBodyXml = sooBuildDocxBodyXml;
window.sooExportToDocx = sooExportToDocx;
window.sooGenerateForRow = sooGenerateForRow;
