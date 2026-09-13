/* ─────────────────────────────────────────────────────────────────────────
   app/soo-generator.js — Sequence of Operations (SOO) Generator, Phase 1
   Item 3f1415af. Design: AI/_context/research/2026-09-13-soo-in-site-design/
   blueprint.md. Clause source: AI/_context/research/
   2026-09-13-master-soo-template-inventory.md (verbatim excerpts from
   "Master Sequences of Operation 2023.docx", cross-checked directly against
   the docx paragraphs during implementation).

   SCOPE (Phase 1 — smallest end-to-end slice, per blueprint's build sequence):
   one equipment type (vav), the hot-water reheat VAV path, point/flag-driven
   clause selection, .rpt-page preview via the EXISTING report-engine page
   shell, .docx export via the EXISTING docx pipeline. No new UI view (that is
   Phase 3) — only a TEMPORARY entry point (see sooGenerateForRow below).

   Load order: after app/equipment-matrix.js (reads emGetNormalizedPoints /
   emComputeCompliance / emLoadEquipConfigFlags / emLoadCustomMappings /
   emLoadMatrix / emHtmlEsc) and after app/report-engine.js (reads rptPage /
   showReportOverlay / _rptContentBudget / _rptPaginateTokens /
   _injectPageNumbers). See energy-department.html script tag comment.

   HARD LESSON (blueprint, JOCO): reheat-actuator mechanism and CO2 function
   are NOT safely inferable from point presence — point presence only proves a
   wire exists, not what the program does with it. Phase 1 reads
   flags.reheatActuator / flags.co2Function if a caller has set them, but
   defaults them (pid-valve / dcv-reset) rather than guessing from points.
   Never add auto-detect-actuator-from-point-name logic here.

   Adjustable numeric values render literally where the master doc itself
   states a default (e.g. "74°F (adj.)") — that is the master template's own
   stated default, not an invented number. Where the master doc gives no
   default (box-specific airflow CFMs, runtimes), the clause text keeps the
   master's own descriptive "(adj.)" phrasing with no numeric fill — never
   invented.
   ───────────────────────────────────────────────────────────────────────── */

/* ── 1. SOO_BEHAVIOR_DEFAULTS — the 3 open JOCO decisions ───────────────────
   None of the 3 non-default options exist in the master doc (see inventory
   §3) — they are authored, sourced from 2026-09-13-joco-vav-soo-review/
   findings.md, never presented as docx quotations. Stored at en_soo_settings
   via sset/sget (never localStorage directly — architecture contract §6). */
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

/* ── 2. Master-doc-sourced verbatim numeric defaults ────────────────────────
   Only variables the master doc itself states a number for. Source: docx
   paragraphs 353-354, 361-362, 370, 407 ("Variable Air Volume – Terminal
   Units" heading). HIGH_CO2_ALARM is left blank in the master doc itself
   (never filled in) — rendered as a blank placeholder, not invented. */
var SOO_VAR_DEFAULTS = {
  OCC_CLG_SP: '74°F',
  OCC_HTG_SP: '70°F',
  UNOCC_CLG_SP: '80°F',
  UNOCC_HTG_SP: '60°F',
  CO2_SETPOINT: '1000 ppm',
  REHEAT_OAT_LOCKOUT: '65°F',
  HIGH_CO2_ALARM: '____',
  // DAT_FLOOR is JOCO working-document text, not master-doc text — see
  // 2026-09-13-joco-vav-soo-review/findings.md line 40 ("drive to max heating
  // airflow if valve 100% and DAT still below 50°F floor").
  DAT_FLOOR: '50°F',
};

/* ── 3. Zone types excluded from public-facing occupant controls ───────────
   Master doc (Zone Setpoint Adjust / Zone Unoccupied Override, docx 367/369):
   "Sensors in public areas will not have this functionality unless
   specifically requested." Excluded set per inventory §2 row 70. */
var SOO_PUBLIC_AREA_EXCLUDED_ZONE_TYPES = [
  'corridor',
  'restroom',
  'stairwell',
  'elevator_lobby',
  'mech_elec',
  'storage',
  'secure_cell',
];

/* ── 4. Clause text resolver ─────────────────────────────────────────────────
   clause.text is a template string with {{VAR}} tokens. clause.vars(ctx), if
   present, supplies per-render dynamic values (behavior-setting selectors,
   conditional row blocks) that take priority over SOO_VAR_DEFAULTS. Any token
   with neither resolves to a blank "(adj.)"-style placeholder — never an
   invented number. */
function sooResolveClauseText(clause, ctx) {
  var dynamicVars = typeof clause.vars === 'function' ? clause.vars(ctx) || {} : {};
  var tokenRe = /\{\{([A-Z0-9_]+)\}\}/g;
  function resolveOnce(str) {
    return String(str).replace(tokenRe, function (_m, key) {
      if (dynamicVars.hasOwnProperty(key)) return dynamicVars[key];
      if (SOO_VAR_DEFAULTS.hasOwnProperty(key)) return SOO_VAR_DEFAULTS[key];
      return '____';
    });
  }
  // A dynamic var's own value (e.g. ZONE_SETPOINT_ROWS) can itself contain {{TOKEN}}
  // placeholders (e.g. the occ/unocc setpoint rows) — a single pass would leave those
  // literal. Re-run until no token remains or a hard iteration cap is hit (defends
  // against an accidental self-referencing token; 5 passes is far more than any real
  // clause nests).
  var out = String(clause.text);
  for (var i = 0; i < 5 && /\{\{[A-Z0-9_]+\}\}/.test(out); i++) {
    out = resolveOnce(out);
  }
  return out;
}

/* ── 5. SOO_TEMPLATES.vav — Phase 1 clause library ──────────────────────────
   Verbatim master-doc text (docx "Variable Air Volume – Terminal Units"
   heading) except where noted "JOCO-only" (no master-doc equivalent exists —
   see inventory §3). appliesWhen(ctx) reads ctx.flags (emLoadEquipConfigFlags
   output) and ctx.points (categoryKey -> true, from emComputeCompliance's
   coveredPoints — i.e. a point is actually present on this row, not just
   configured). reheatActuator/co2Function are read from flags if a caller
   has set them but are NOT yet EM_EQUIP_CONFIG_FLAGS.vav entries (that is
   Phase 2, per blueprint) — they default to the modulating/DCV-reset case
   rather than being inferred from points, per the hard lesson in the file
   header. */
var SOO_TEMPLATES = {
  vav: [
    {
      id: 'zone-control-modes',
      order: 10,
      title: 'Zone Control Modes',
      appliesWhen: function () {
        return true;
      },
      text:
        'There are 5 modes for each zone: occupied and unoccupied as determined by an ' +
        'operator-defined schedule, and 3 override demand levels as determined by the ' +
        'kilowatt meter and operator-defined parameters. Each mode has individually ' +
        'adjustable heating and cooling setpoints. Each zone will have a color associated ' +
        'with the condition of the zone with respect to temperature and the applicable ' +
        'setpoint. The color will be green when the temperature is between the heating ' +
        'and cooling setpoint. The color will change progressively from green to yellow, ' +
        'orange, and then red as the temperature rises progressively above the cooling ' +
        'setpoint. The color will change progressively from green to light blue, dark ' +
        'blue, and then red as the temperature drops progressively below the heating ' +
        'setpoint. Gray will represent the unoccupied mode.',
    },
    {
      id: 'zone-setpoints',
      order: 20,
      title: 'Zone Setpoints',
      appliesWhen: function () {
        return true;
      },
      // Demand Level 1-3 rows only render when a demandLevel point is actually mapped on
      // this row (inventory §2 row 20) — otherwise the table is occ/unocc only.
      vars: function (ctx) {
        var rows = ['Occupied Cooling – {{OCC_CLG_SP}} (adj.)', 'Occupied Heating – {{OCC_HTG_SP}} (adj.)'];
        if (ctx.points.demandLevel) {
          rows.push(
            'Demand Level 1 Cooling – 76°F (adj.)',
            'Demand Level 1 Heating – 68°F (adj.)',
            'Demand Level 2 Cooling – 78°F (adj.)',
            'Demand Level 2 Heating – 66°F (adj.)',
            'Demand Level 3 Cooling – 80°F (adj.)',
            'Demand Level 3 Heating – 64°F (adj.)',
          );
        }
        rows.push('Unoccupied Cooling – {{UNOCC_CLG_SP}} (adj.)', 'Unoccupied Heating – {{UNOCC_HTG_SP}} (adj.)');
        return { ZONE_SETPOINT_ROWS: rows.join('\n') };
      },
      text: 'The space setpoints for each state shall be:\n{{ZONE_SETPOINT_ROWS}}',
    },
    {
      id: 'schedule',
      order: 30,
      title: 'Schedule',
      appliesWhen: function () {
        return true;
      },
      text: 'Zone will operate according to a user-definable schedule.',
    },
    {
      id: 'unocc-override',
      order: 70,
      title: 'Zone Unoccupied Override',
      appliesWhen: function (ctx) {
        var zt = (ctx.flags && ctx.flags.zoneType) || 'vav';
        return SOO_PUBLIC_AREA_EXCLUDED_ZONE_TYPES.indexOf(zt) === -1;
      },
      text:
        'A timed local override control will allow an occupant to override the schedule ' +
        'and place the unit into an occupied mode for an adjustable period of time (adj.). ' +
        'At the expiration of this time, control of the unit will automatically return to ' +
        'the schedule.',
    },
    {
      id: 'min-vent-co2',
      order: 80,
      title: 'Minimum Ventilation on Carbon Dioxide (CO2) Concentration',
      appliesWhen: function (ctx) {
        return ctx.flags.hasCO2 !== false && !!ctx.points.co2;
      },
      text:
        'When in the occupied mode, the controller will measure the zone CO2 concentration ' +
        'and modulate the zone damper open on rising CO2 concentrations, overriding normal ' +
        'damper operation to maintain a CO2 setpoint of not more than {{CO2_SETPOINT}} (adj.).',
    },
    {
      id: 'flow-control',
      order: 100,
      title: 'Variable Volume Terminal Unit – Flow Control',
      appliesWhen: function () {
        return true;
      },
      // standbyAirflowMode selector (SOO_BEHAVIOR_DEFAULTS) — 'minimum' is the ONLY option
      // with master-doc text (docx 383-384); 'sameAsOccupiedMax' is authored, JOCO-sourced,
      // never presented as a docx quotation (inventory §3.1).
      vars: function (ctx) {
        var mode = (ctx.settings && ctx.settings.standbyAirflowMode) || 'minimum';
        var unoccText =
          mode === 'sameAsOccupiedMax'
            ? 'Unoccupied: the zone damper will control to the same maximum cooling airflow ' +
              '(adj.) used in occupied mode — the unoccupied minimum airflow is not reduced.'
            : 'Unoccupied: when the zone is unoccupied the zone damper will control to its ' +
              'minimum unoccupied airflow (adj.). When the zone temperature is greater than ' +
              'its cooling setpoint, the zone damper will modulate between the minimum ' +
              'unoccupied airflow (adj.) and the maximum cooling airflow (adj.) until the ' +
              'zone is satisfied.';
        return { UNOCC_FLOW_TEXT: unoccText };
      },
      text:
        'The unit will maintain zone setpoints by controlling the airflow through the ' +
        'following: Occupied: when zone temperature is greater than its cooling setpoint, ' +
        'the zone damper will modulate between the minimum occupied airflow (adj.) and the ' +
        'maximum cooling airflow (adj.) until the zone is satisfied. When the zone ' +
        'temperature is less than the cooling setpoint, the zone damper will maintain the ' +
        'minimum required zone ventilation (adj.).\n{{UNOCC_FLOW_TEXT}}',
    },
    {
      id: 'reheat-modulating',
      order: 120,
      title: 'Reheating Coil Valve',
      // hasReheat + reheatValve point present -> reheat clause family (blueprint §"Point
      // signal -> clause mapping"). reheatActuator is a manual flag (NOT point-derived —
      // see file header); the 3 modulating mechanisms (pid-valve/linear-valve/
      // floating-motor) read as IDENTICAL master-doc prose (inventory §2 row 120) — only
      // electric-binary gets distinct staged text (reheat-staged, below).
      appliesWhen: function (ctx) {
        if (ctx.flags.hasReheat === false || !ctx.points.reheatValve) return false;
        var actuator = ctx.flags.reheatActuator || 'pid-valve';
        return actuator !== 'electric-binary';
      },
      text:
        'The controller will measure the zone temperature and modulate the reheating coil ' +
        'valve open on dropping temperature to maintain its heating setpoint. When cold air ' +
        'is available from the AHU and there is no fan present in the box, the zone damper ' +
        'will modulate to the minimum occupied airflow (adj.). If more heat is required, the ' +
        'zone damper will modulate to the auxiliary heating airflow (adj.).',
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
      text:
        'The controller will measure the zone temperature and stage the reheating to ' +
        'maintain its setpoint. To prevent short cycling, the stage will have a user-' +
        'definable minimum runtime (adj.). The reheating will be enabled whenever: outside ' +
        'air temperature is less than {{REHEAT_OAT_LOCKOUT}} (adj.); AND the zone ' +
        'temperature is below setpoint; AND sufficient airflow is provided.',
    },
    {
      id: 'dat-floor-failure',
      order: 125,
      title: 'Discharge Air Temperature (DAT) Floor Interlock',
      // JOCO-only clause — no master-doc equivalent (inventory §2/§3). Gated purely on the
      // dat point being present (blueprint: "highest reach: ~100% of reheat boxes").
      appliesWhen: function (ctx) {
        return !!ctx.points.dat;
      },
      vars: function (ctx) {
        var mode = (ctx.settings && ctx.settings.datFloorFailureMode) || 'increaseAirflowToMax';
        var t =
          mode === 'dropToMinAndAlarm'
            ? 'If the reheat valve is fully open (100%) and the discharge air temperature ' +
              'remains below {{DAT_FLOOR}} (adj.), the zone damper will reduce to the ' +
              'minimum occupied airflow (adj.) and the controller will generate an alarm.'
            : 'If the reheat valve is fully open (100%) and the discharge air temperature ' +
              'remains below {{DAT_FLOOR}} (adj.), the zone damper will increase airflow ' +
              'toward the maximum heating airflow (adj.) until the discharge air ' +
              'temperature recovers above the floor.';
        // {{DAT_FLOOR}} inside t resolves automatically — sooResolveClauseText re-scans
        // dynamic-var output for nested tokens (see its header comment).
        return { DAT_FLOOR_TEXT: t };
      },
      text: 'The controller will monitor the discharge air temperature (DAT) leaving the reheat coil. {{DAT_FLOOR_TEXT}}',
    },
    {
      id: 'fan-series',
      order: 140,
      title: 'Fan Control – Series',
      // isSeries is not yet an EM_EQUIP_CONFIG_FLAGS.vav entry (Phase 2 per blueprint) — reads
      // ctx.flags.isSeries if a caller has set it; defaults false (Phase 1 target variant has
      // no fan), so this clause normally does not render. Kept here so seriesFanRunMode has a
      // clause to resolve into (requirement: all 3 SOO_BEHAVIOR settings must be wired).
      appliesWhen: function (ctx) {
        return ctx.flags.isSeries === true;
      },
      vars: function (ctx) {
        var mode = (ctx.settings && ctx.settings.seriesFanRunMode) || 'continuous';
        var t =
          mode === 'occupiedOnly'
            ? 'The fan will run only when the zone is in occupied mode. The fan will run for ' +
              'a minimum user-definable time (adj.).'
            : 'The fan will run anytime the unit is commanded to run. The fan will run for a ' +
              'minimum user-definable time (adj.).';
        return { FAN_SERIES_MODE_TEXT: t };
      },
      text:
        '{{FAN_SERIES_MODE_TEXT}} The zone damper will close completely before the fan ' +
        'starts to prevent air from the AHU from causing the fan to spin backward. The zone ' +
        'damper will return to automatic control after the fan starts.',
    },
    {
      id: 'alarms',
      order: 900,
      title: 'Alarms',
      appliesWhen: function () {
        return true;
      },
      vars: function (ctx) {
        var co2Row =
          ctx.flags.hasCO2 !== false && ctx.points.co2
            ? '\nHigh Zone Carbon Dioxide Concentration: if the zone CO2 concentration is ' +
              'greater than {{HIGH_CO2_ALARM}} ppm (adj.).'
            : '';
        return { CO2_ALARM_ROW: co2Row };
      },
      text:
        'Alarms will be provided as follows:\n' +
        'High Zone Temp: if the zone temperature is greater than the cooling setpoint by a ' +
        'user-definable amount (adj.).\n' +
        'Low Zone Temp: if the zone temperature is less than the heating setpoint by a ' +
        'user-definable amount (adj.).{{CO2_ALARM_ROW}}',
    },
  ],
};

/* ── 6. Context builder — reuses EM's existing point/flag machinery ─────────
   Zero re-derivation of point presence: emGetNormalizedPoints (indirectly, via
   emComputeCompliance) and emLoadEquipConfigFlags are the SAME functions the
   Equipment Matrix audit/compliance view already uses. ctx.points is built
   from compliance.coveredPoints (a point actually matched on this row), not
   from configFlag defaults — a flag can say hasReheat:true with no reheatValve
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

/* ── 7. Clause selection + page rendering ────────────────────────────────────
   Renders selected clauses into .rpt-page-shaped HTML via the EXISTING
   rptPage()/_rptPaginateTokens()/_rptContentBudget() report-engine helpers —
   zero new visual language, per blueprint. */
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

function sooBuildPagesHTML(ctx) {
  var row = ctx.row;
  var category = row.category || 'vav';
  var clauses = sooSelectClauses(category, ctx);

  // Uses ONLY existing report-engine tokens (--rpt-border, --rpt-page-text — both defined in
  // energy-department.html's #report-styles) — zero new hex/tokens, per report-standard.md
  // Rule 4.1 (no grey/faded text in report chrome) and the "one shade of blue for titles"
  // convention (--rpt-blue stays reserved for .rpt-pg-title; body/sub-headings inherit
  // .rpt-page's --rpt-page-text like every other report body section, e.g.
  // rptPageObservations's per-building paragraphs).
  var idBlockHTML =
    '<div style="margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid var(--rpt-border)">' +
    '<div style="font:700 13px Arial,Helvetica,sans-serif">' +
    emHtmlEsc(row.equipName || row.name || row.id) +
    '</div>' +
    '<div style="font:11px Arial,Helvetica,sans-serif">' +
    emHtmlEsc(row.building || '') +
    (row.location ? ' — ' + emHtmlEsc(row.location) : '') +
    '</div>' +
    '</div>';

  var idBlockEstH = 60;

  var tokens = clauses.map(function (clause) {
    var body = sooResolveClauseText(clause, ctx);
    var html =
      '<div class="soo-clause" style="margin-bottom:16px">' +
      '<h3 style="font:700 12px Arial,Helvetica,sans-serif;margin:0 0 6px">' +
      emHtmlEsc(clause.title) +
      '</h3>' +
      '<div style="font:11px/1.4 Georgia,\'Times New Roman\',serif;white-space:pre-line">' +
      emHtmlEsc(body) +
      '</div></div>';
    // Hand-estimated height (same convention as other rptPage* builders in report-engine.js):
    // ~20px heading line + ~20px per ~95-char wrapped line of body text + padding.
    var estH = 30 + Math.ceil(body.length / 95) * 18 + 16;
    return { type: 'block', html: html, estH: estH };
  });

  var budget = typeof _rptContentBudget === 'function' ? _rptContentBudget() : 500;
  var firstPageBudget = Math.max(budget - idBlockEstH, 100);
  var chunks =
    typeof _rptPaginateTokens === 'function' ? _rptPaginateTokens(tokens, firstPageBudget, budget) : [tokens];
  if (!chunks.length) chunks = [[]];

  var fakeData = { project: { client: ctx.projectName || '', name: ctx.projectName || '' } };

  var pagesHTML = [];
  for (var p = 0; p < chunks.length; p++) {
    var bodyHTML =
      (p === 0 ? idBlockHTML : '') +
      chunks[p]
        .map(function (t) {
          return t.html;
        })
        .join('');
    pagesHTML.push(
      rptPage(p + 1, 'Sequence of Operations', bodyHTML, {
        data: fakeData,
        label: 'Page ' + (p + 1),
      }),
    );
  }

  return typeof _injectPageNumbers === 'function' ? _injectPageNumbers(pagesHTML.join('\n')) : pagesHTML.join('\n');
}

/* ── 8. TEMPORARY entry point (Phase 1 only — Phase 3 builds the real UI) ───
   Generates a SOO for one VAV row, previews it in the existing report
   overlay (#reportPages / #reportOverlay, same chrome/export buttons every
   other report type uses), and marks the report data with `_soo` so
   exportReportToDocx() picks the right filename branch. */
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

  var html = sooBuildPagesHTML(ctx);
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
window.SOO_VAR_DEFAULTS = SOO_VAR_DEFAULTS;
window.SOO_TEMPLATES = SOO_TEMPLATES;
window.sooLoadSettings = sooLoadSettings;
window.sooSaveSettings = sooSaveSettings;
window.sooSetSetting = sooSetSetting;
window.sooResolveClauseText = sooResolveClauseText;
window.sooBuildContext = sooBuildContext;
window.sooSelectClauses = sooSelectClauses;
window.sooBuildPagesHTML = sooBuildPagesHTML;
window.sooGenerateForRow = sooGenerateForRow;
