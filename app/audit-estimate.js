/* ── app/audit-estimate.js — Audit Estimate + Audit Proposal ────────────────
   2026-09-25 (feat/audit-estimate-proposal): estimates the labor hours and cost to run a
   "Building Automation System Audit" or a "Full Facility Audit" for a project, from the
   project's own Equipment Matrix (building count, equipment count by type, points per
   equipment — see auditEstGetEquipmentSummary()) plus an editable per-hour-per-equipment-type
   table of assumptions (see AUDIT_EST_HOURS_PER_EQUIP_DEFAULT below).

   WHY here, not a new top-level tab: the Cost Estimate tab (app/pricing-estimator.js) is
   already CompanyHub's home for internal labor-hours/cost modeling (COST_LABOR_RATE_DEFAULT,
   the Recommended/Compliance/Full Scope tiers). Audit estimating is the same kind of
   internal estimating tool, reading the same Equipment Matrix, so it renders as a section
   BELOW the existing pricing table inside initCostEstimateTab() (app/pricing-estimator.js)
   rather than a new peer tier button — the tier toggle (_pricingTierToggleHTML) is
   Recommended/Compliance/Full Scope-specific (project_cost_estimate_tiers.md's hard cost
   ordering) and a "Summary" 4th button was explicitly removed from it once already (Matt,
   2026-07-22: "just remove completely") for adding information he did not want there. A
   separate section avoids repeating that mistake.

   Data sources for the default hours-per-equipment-type table: the Louisburg SD Optimization
   Strategy Sheet's "Equipment Data" sheet ("Time it takes to go through equipment", B2:C13,
   h:mm elapsed time) — see AUDIT_EST_HOURS_PER_EQUIP_DEFAULT for the cell citation on every
   value that sheet provides. Equipment types that sheet has no row for use a clearly labeled
   starting estimate (never derived, never invented from nothing — flagged as "estimate" in
   both the code comment and the rendered UI so it can be adjusted, per Matt's "use some
   estimates for now and we can adjust them").

   Company-wide assumptions live in sget/sset key 'audit_estimate_config' (mirrors
   'en_pricing_config' in app/pricing-estimator.js) with a persisted `history` array (date,
   field, old, new) per reference_cost_estimate_labor_model.md's "keep a HISTORY of the labor
   assumptions ... for analysis and refinement against actuals over time." No separate
   per-project override store is added — the labor RATE already has a per-project setting
   (app/pricing-estimator.js's _pricingGetConfig().hourlyRate, 'en_pricing_config'); this file
   reads that one existing value (auditEstGetHourlyRate()); it keeps no second rate. That is the "per-project override
   only if trivial" the task asked for — reusing what already exists, not building a second
   override mechanism.
   ────────────────────────────────────────────────────────────────────────────────────────── */

/* ── Equipment categories counted per-unit for audit hours ──────────────────────────────────
   Same set report-engine.js's collectASHRAE36Data() already treats as "Auditable equipment
   categories (excludes 'other')" for ASHRAE 36 scoring — reused here so the Audit Estimate and
   the ASHRAE 36 Audit Report agree on what counts as inspectable BAS equipment. */
var AUDIT_EST_CATEGORIES = [
  'ahu',
  'rtu',
  'vav',
  'fpb',
  'ddvav',
  'hwp',
  'chwp',
  'ct',
  'doas',
  'fcu',
  'zone',
  'furnace',
  'heater',
  'ef',
];

var AUDIT_EST_CAT_LABELS = {
  ahu: 'Air Handling Unit',
  rtu: 'Rooftop Unit',
  vav: 'Variable Air Volume Terminal',
  fpb: 'Fan-Powered Terminal',
  ddvav: 'Dual-Duct Terminal',
  hwp: 'Hot Water Plant',
  chwp: 'Chilled Water Plant',
  ct: 'Cooling Tower',
  doas: 'Dedicated Outdoor Air System',
  fcu: 'Fan Coil Unit',
  zone: 'Zone Terminal',
  furnace: 'Furnace',
  heater: 'Unit Heater',
  ef: 'Exhaust Fan',
};

// Equipment Matrix categories EXCLUDED from per-equipment audit hours in BOTH audit types —
// building-level systems (lighting circuits, fire/life-safety, plumbing, power metering,
// weather sensors, VFD/controls wrappers, standalone A/C, VRF outdoor units, elevator,
// monitoring, security) rather than individually-inspected HVAC control equipment. Full
// Facility Audit covers lighting/envelope/utility review as flat PER-BUILDING line items
// instead (see AUDIT_EST_DEFAULTS.fullFacility below) — never priced twice.
var AUDIT_EST_EXCLUDED_CATEGORIES = [
  'lighting',
  'fire',
  'plumbing',
  'power',
  'sensor',
  'controls',
  'vrf',
  'ac',
  'elevator',
  'monitoring',
  'security',
  'lifesafety',
  'other',
];

/* ── Hours per equipment type, "time it takes to go through" one unit during an audit walk-
   through. SOURCE: Optimization Strategy Sheet - Louisburg SD 2026.01.09.xlsx, sheet
   "Equipment Data", B2 "Time it takes to go through equipment", table B3:C13 (headers
   "Equipment Type" | "Time"), number format h:mm (elapsed HOURS:MINUTES, verified via the
   cell's number_format, not guessed). Cited per value; categories the sheet has no row for
   carry a clearly labeled STARTING ESTIMATE, not a derived value. */
var AUDIT_EST_HOURS_PER_EQUIP_DEFAULT = {
  vav: 1.12, // xlsx C4 "VAV Terminal Unit with HW" = 1:07
  heater: 2.1, // xlsx C5 "Unit Heater with HW" = 2:06
  fpb: 1.07, // xlsx C6 "Parallel Fan Terminal Box with HW" = 1:04
  rtu: 5.37, // xlsx C7 "DX RTU with gas heat" = 5:22
  ahu: 2.83, // xlsx C9 "VAV AHU with HW/CW" = 2:50
  fcu: 2.0, // xlsx C10 "Unit Vent with HW/CW" = 2:00
  // Starting estimates — xlsx has no row for these equipment types:
  doas: 2.5, // estimate — similar scale to an Air Handling Unit
  chwp: 4.0, // estimate — central plant equipment, more complex than a terminal unit
  hwp: 4.0, // estimate — central plant equipment, more complex than a terminal unit
  ct: 2.0, // estimate — central plant equipment
  ddvav: 1.5, // estimate — dual-duct terminal, more complex than a single-duct VAV
  zone: 1.0, // estimate — similar scale to a VAV terminal
  furnace: 2.1, // estimate — matched to Unit Heater (same class of single-zone heating equipment)
  ef: 0.5, // estimate — simple equipment
};

// The labor rate is NOT stored here: auditEstGetHourlyRate() reads the one rate,
// _pricingGetConfig().hourlyRate (default COST_LABOR_RATE_DEFAULT in app/pricing-estimator.js).
var AUDIT_EST_DEFAULTS = {
  hoursPerEquip: Object.assign({}, AUDIT_EST_HOURS_PER_EQUIP_DEFAULT),
  hoursPerBuilding: 2, // estimate — site visit + travel time, per building (Full Facility Audit ONLY)
  hoursReport: 4, // estimate — fixed report writing/analysis hours (BAS Audit)
  // Sample-based review (2026-10-01): one unit per group of units with the same control features.
  matrixReviewHours: 0.5, // estimate — fixed Equipment Matrix review per equipment type
  fullFacility: {
    hoursMechanicalWalkthroughPerBuilding: 2, // estimate — non-BAS mechanical walk-through
    hoursLightingReviewPerBuilding: 1, // estimate
    hoursEnvelopeReviewPerBuilding: 1, // estimate
    hoursUtilityBillReviewPerBuilding: 1, // estimate
    hoursReportExtra: 4, // estimate — additional report/analysis hours for the larger scope
  },
};

/* ── Company-wide assumptions store (sget/sset key 'audit_estimate_config'), with history ── */
function auditEstGetConfig() {
  var stored = sget('audit_estimate_config', null);
  var dflt = JSON.parse(JSON.stringify(AUDIT_EST_DEFAULTS));
  dflt.history = [];
  if (!stored) return dflt;
  var merged = Object.assign({}, dflt, stored);
  // Read-side clamp: a non-number, NaN, Infinity or negative stored value is treated as absent.
  var okHours = {};
  Object.keys(stored.hoursPerEquip || {}).forEach(function (k) {
    var h = stored.hoursPerEquip[k];
    if (typeof h === 'number' && isFinite(h) && h >= 0) okHours[k] = h;
  });
  merged.hoursPerEquip = Object.assign({}, dflt.hoursPerEquip, okHours);
  merged.fullFacility = Object.assign({}, dflt.fullFacility, stored.fullFacility || {});
  merged.history = stored.history || [];
  return merged;
}

function _auditEstGetPath(obj, path) {
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}
function _auditEstSetPath(obj, path, val) {
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

// path examples: 'hourlyRate', 'hoursPerBuilding', 'hoursReport', 'hoursPerEquip.vav',
// 'fullFacility.hoursReportExtra'. Records a history entry only when the value actually changes.
function auditEstSetConfig(path, newValue) {
  var cfg = auditEstGetConfig();
  var oldValue = _auditEstGetPath(cfg, path);
  if (oldValue === newValue) return cfg;
  _auditEstSetPath(cfg, path, newValue);
  cfg.history = cfg.history || [];
  cfg.history.push({ date: new Date().toISOString(), field: path, old: oldValue, new: newValue });
  sset('audit_estimate_config', cfg);
  return cfg;
}

// Rate already exists per-project on the Cost Estimate tab (app/pricing-estimator.js's
// _pricingGetConfig().hourlyRate) — read that first so Audit Estimate never disagrees with
// Cost Estimate about what CSC charges per hour on this project. One rate, no second default.
function auditEstGetHourlyRate() {
  return _pricingGetConfig().hourlyRate;
}

/* ── Per-project Hours Each overrides ─────────────────────────────────────────────────────────
   Key en_pricing_audit_hours_<projId> = { <category>: hoursEach }. Starts with 'en_pricing_', so
   app/sync-classification.js rule { pattern: 'en_pricing_', prefix: true } syncs it with the
   project's other pricing data. Missing category = the default (company assumptions value).
   auditEstComputeBreakdown() is the ONLY reader; every table and the proposal use its rows. */
function _auditEstHoursKey(projId) {
  return 'en_pricing_audit_hours_' + projId;
}
function auditEstGetHourOverrides(projId) {
  var raw = null;
  try {
    raw = sget(_auditEstHoursKey(projId), null);
  } catch (e) {
    raw = null;
  }
  var out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (k) {
      var n = raw[k];
      if (typeof n === 'number' && isFinite(n) && n >= 0) out[k] = n;
    });
  }
  return out;
}
function _auditEstWriteHourOverrides(projId, obj) {
  try {
    var p = sset(_auditEstHoursKey(projId), obj);
    if (p && p.catch) p.catch(function () {});
    return true;
  } catch (e) {
    return false;
  }
}
// value: '' / null = back to default. Returns 'ok' | 'invalid' | 'failed'.
function auditEstSetHourOverride(projId, cat, value) {
  var o = auditEstGetHourOverrides(projId);
  var txt = value == null ? '' : String(value).trim();
  if (txt === '') {
    delete o[cat];
  } else {
    var n = Number(txt);
    if (!isFinite(n) || n < 0) return 'invalid';
    o[cat] = n;
  }
  return _auditEstWriteHourOverrides(projId, o) ? 'ok' : 'failed';
}
// Where the default Hours Each of a type comes from: 'company' (saved in audit_estimate_config
// .hoursPerEquip) or 'built-in' (AUDIT_EST_HOURS_PER_EQUIP_DEFAULT). Reads the stored object
// directly because auditEstGetConfig() merges the two.
function auditEstDefaultSource(cat) {
  var stored = sget('audit_estimate_config', null);
  var v = stored && stored.hoursPerEquip ? stored.hoursPerEquip[cat] : null;
  // auditEstSetConfig() saves the whole merged object, so a stored value equal to the built-in one is not a company choice.
  var b = AUDIT_EST_HOURS_PER_EQUIP_DEFAULT[cat];
  return typeof v === 'number' && isFinite(v) && v >= 0 && v !== b ? 'company' : 'built-in';
}
function auditEstClearHourOverrides(projId) {
  return _auditEstWriteHourOverrides(projId, {}) ? 'ok' : 'failed';
}

/* ── Equipment Matrix accessors — number of buildings, equipment count by type, points per
   equipment. Reuses emLoadMatrix()/emIsPhantomRow() (app/equipment-matrix.js) — the SAME
   equipment rows the Equipment Matrix tab and the ASHRAE 36 Audit Report read, so counts here
   always agree with what the Equipment Matrix tab shows. */
// Control concepts: units of a type that have the same SET of these concepts are one group (one
// unit of the group is sampled). Each concept is found from the Equipment Matrix normalized point
// keys (emGetNormalizedPoints): curated column keys plus a few vendor "auto_" name patterns
// (scr, circuit, baseboard, vfd). Validated on real BAS data 2026-10-01 for air-side equipment.
var AUDIT_EST_CONCEPTS = [
  ['Economizer', /econom|^oaDamperPosition$|returnAirDamper|reliefDamper|mixedAirTemp|returnAirEnthalpy|exhaustAirDamper/i],
  ['Fan speed/VFD', /vfd|^supplyFanSpeed$|^returnFanSpeed$|^exhaustFanSpeed$|fanSpeedCommand/i],
  ['Electric heat', /(?<!de)scr|baseboard|electricHeat|unitHeater/i],
  ['Hot-water heat', /^heatingValve$|^reheatValve$|heatingCoil|heatSourceSupplyTemp|hotDeck|preheat/i],
  ['DX cooling', /circuit|condensing|compressor|cuStage|cuEnable/i],
  ['Chilled-water cooling', /^coolingValve$|coolingCoil|coolSourceSupplyTemp|chw/i],
  ['CO2', /co2|carbonDioxide/i],
  ['Zone temp', /^zoneAirTemp$|^zoneTemp$/i],
];
// Types the concept list was NOT validated for (plants, zones): the group is the exact set of
// mapped keys (auto_ keys left out).
var AUDIT_EST_MAPPED_KEY_TYPES = ['hwp', 'chwp', 'ct', 'zone'];

// Group signature of one equipment row: { sig, concepts } where concepts is a readable list.
// emGetNormalizedPoints reads the project's custom aliases through window._emActivePid, so set it
// to this project for the call and restore it after.
function auditEstPointSetSignature(row, projId, cat) {
  var prev = window._emActivePid;
  window._emActivePid = projId;
  var keys;
  try {
    keys = Object.keys(emGetNormalizedPoints(row));
  } finally {
    window._emActivePid = prev;
  }
  if (AUDIT_EST_MAPPED_KEY_TYPES.indexOf(cat) !== -1) {
    var mapped = keys
      .filter(function (k) {
        return k.indexOf('auto_') !== 0;
      })
      .sort();
    return { sig: mapped.join('|'), concepts: [] };
  }
  var found = {};
  keys.forEach(function (k) {
    for (var i = 0; i < AUDIT_EST_CONCEPTS.length; i++) {
      if (AUDIT_EST_CONCEPTS[i][1].test(k)) {
        found[AUDIT_EST_CONCEPTS[i][0]] = true;
        return; // a key counts toward the first matching concept only
      }
    }
  });
  var names = AUDIT_EST_CONCEPTS.map(function (c) {
    return c[0];
  }).filter(function (n) {
    return found[n];
  });
  return { sig: names.join('|'), concepts: names };
}

function auditEstGetEquipmentSummary(projId) {
  if (typeof emLoadMatrix !== 'function') return null;
  var matData = emLoadMatrix(projId);
  if (!matData || !matData.rows || !matData.rows.length) return null;
  var rows = matData.rows.filter(function (r) {
    return typeof emIsPhantomRow !== 'function' || !emIsPhantomRow(r);
  });
  if (!rows.length) return null;

  var buildings = {};
  var allBuildings = {};
  var byCat = {};
  var excluded = {};

  // Buildings the matrix lists that have no rows yet still get a line in Cost by Building.
  (matData.buildings || []).forEach(function (n) {
    if (typeof n === 'string' && n) allBuildings[n] = true;
  });
  rows.forEach(function (r) {
    var bName = r.building || 'Unknown Building';
    var cat = r.category || 'other';
    var pts = r.points ? Object.keys(r.points).length : 0;
    allBuildings[bName] = true; // every project building, also ones with no auditable equipment
    if (AUDIT_EST_CATEGORIES.indexOf(cat) !== -1) {
      // Only a building with an auditable category is priced (same set the proposal lists).
      buildings[bName] = true;
      if (!byCat[cat])
        byCat[cat] = {
          category: cat,
          label: AUDIT_EST_CAT_LABELS[cat] || cat,
          count: 0,
          totalPoints: 0,
          groups: {},
          groupOrder: [],
          byBuilding: {},
        };
      byCat[cat].count++;
      byCat[cat].byBuilding[bName] = (byCat[cat].byBuilding[bName] || 0) + 1;
      byCat[cat].totalPoints += pts;
      // Group = units with the same control concepts (see AUDIT_EST_CONCEPTS). The first unit of
      // a group in matrix order is its representative: one per group is sampled.
      var g = auditEstPointSetSignature(r, projId, cat);
      if (!byCat[cat].groups[g.sig]) {
        byCat[cat].groups[g.sig] = { concepts: g.concepts, count: 0, rep: r.name || r.id || '', repBuilding: bName };
        byCat[cat].groupOrder.push(g.sig);
      }
      byCat[cat].groups[g.sig].count++;
    } else {
      if (!excluded[cat])
        excluded[cat] = {
          category: cat,
          label: typeof EM_CATEGORY_LABELS !== 'undefined' && EM_CATEGORY_LABELS[cat] ? EM_CATEGORY_LABELS[cat] : cat,
          count: 0,
        };
      excluded[cat].count++;
    }
  });

  var equipTypes = AUDIT_EST_CATEGORIES.filter(function (c) {
    return byCat[c];
  }).map(function (c) {
    var e = byCat[c];
    e.avgPoints = e.count > 0 ? Math.round((e.totalPoints / e.count) * 10) / 10 : 0;
    e.groupCount = e.groupOrder.length;
    e.groupList = e.groupOrder.map(function (k) {
      return e.groups[k];
    });
    return e;
  });

  return {
    buildingCount: Object.keys(buildings).length,
    buildingList: Object.keys(buildings).sort(),
    allBuildingList: Object.keys(allBuildings).sort(),
    equipTypes: equipTypes,
    excluded: Object.keys(excluded).map(function (c) {
      return excluded[c];
    }),
  };
}

// Step list "How this total is built" from an EstimateWorkbook.compute() result. Shared by the
// Audit Estimate and the Cost Estimate (app/pricing-estimator.js).
function auditEstWorkbookChain(calc) {
  var D = EstimateWorkbook.DEFAULTS;
  var sm = calc.summary;
  var pctOf = function (v) {
    return Math.round(v * 10000) / 100 + '%';
  };
  var chain = [
    { key: 'labor', label: 'Labor', amount: sm.labor },
    { key: 'tools', label: 'Tools (' + pctOf(D.pct.smallTools) + ' of labor)', amount: calc.cells['Dash!G32'] },
    { key: 'rentalTax', label: 'Tool rental tax (paid by CSC)', amount: calc.cells['Dash!G33'] },
    { key: 'direct', label: 'Direct cost', amount: sm.direct, sub: true },
    { key: 'overhead', label: 'Overhead (' + pctOf(D.pct.overhead) + ')', amount: sm.overhead },
    { key: 'profit', label: 'Profit (' + pctOf(D.pct.profit) + ')', amount: sm.profit },
  ];
  if (sm.tax) chain.push({ key: 'tax', label: 'Project sales tax (Kansas)', amount: sm.tax });
  if (sm.bond) chain.push({ key: 'bond', label: 'Bond (' + pctOf(D.pct.bond) + ')', amount: sm.bond });
  chain.push({ key: 'total', label: 'Total', amount: sm.total, sub: true });
  return chain;
}

/* ── Pricing method + workbook settings (per project) ─────────────────────────────────────────
   Key en_pricing_workbook_<projId> (en_pricing_ prefix, so it syncs). Fields, all optional:
   method ('hourly'; absent = 'workbook'), roles { <taskTypeId>: <role code> } (only changed
   tasks), ot ('Not Applicable' | 'x1.5' | 'x2.0'), state ('Kansas' | 'Missouri'), taxRate
   (0.0875 = 8.75%), bond (boolean). Absent field = the EstimateWorkbook.DEFAULTS value. */
var AUDIT_EST_OT_OPTIONS = ['Not Applicable', 'x1.5', 'x2.0'];
var AUDIT_EST_STATE_OPTIONS = ['Kansas', 'Missouri'];
function _auditEstWbKey(projId) {
  return 'en_pricing_workbook_' + projId;
}
function _auditEstWbRaw(projId) {
  var raw = null;
  try {
    raw = sget(_auditEstWbKey(projId), null);
  } catch (e) {
    raw = null;
  }
  return raw && typeof raw === 'object' ? raw : {};
}
function auditEstGetWorkbookSettings(projId) {
  var raw = _auditEstWbRaw(projId);
  var D = EstimateWorkbook.DEFAULTS;
  var roles = {};
  var stored = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  Object.keys(stored).forEach(function (t) {
    var code = stored[t];
    if (
      D.taskRoleMap[t] != null &&
      D.roles.some(function (r) {
        return r.code === code;
      })
    )
      roles[t] = code;
  });
  var tax = typeof raw.taxRate === 'number' && isFinite(raw.taxRate) && raw.taxRate >= 0 ? raw.taxRate : D.taxRate;
  return {
    method: raw.method === 'hourly' ? 'hourly' : 'workbook',
    roles: roles,
    ot: AUDIT_EST_OT_OPTIONS.indexOf(raw.ot) !== -1 ? raw.ot : D.ot,
    state: AUDIT_EST_STATE_OPTIONS.indexOf(raw.state) !== -1 ? raw.state : D.state,
    taxRate: tax,
    bond: raw.bond === true,
  };
}
// Stores only what differs from the defaults (method 'workbook' = field absent).
// field: 'method' | 'ot' | 'state' | 'taxRate' | 'bond' | 'role' (value {task, role}).
// Returns 'ok' | 'invalid' | 'failed'.
function auditEstSetWorkbookSetting(projId, field, value) {
  var o = JSON.parse(JSON.stringify(_auditEstWbRaw(projId)));
  var D = EstimateWorkbook.DEFAULTS;
  if (field === 'method') {
    if (value === 'hourly') o.method = 'hourly';
    else if (value === 'workbook') delete o.method;
    else return 'invalid';
  } else if (field === 'ot' || field === 'state') {
    var opts = field === 'ot' ? AUDIT_EST_OT_OPTIONS : AUDIT_EST_STATE_OPTIONS;
    if (opts.indexOf(value) === -1) return 'invalid';
    if (value === D[field]) delete o[field];
    else o[field] = value;
  } else if (field === 'taxRate') {
    var txt = value == null ? '' : String(value).trim();
    var n = txt === '' ? D.taxRate : Number(txt);
    if (!isFinite(n) || n < 0 || n > 1) return 'invalid';
    if (n === D.taxRate) delete o.taxRate;
    else o.taxRate = n;
  } else if (field === 'bond') {
    if (value) o.bond = true;
    else delete o.bond;
  } else if (field === 'role') {
    var okRole = D.roles.some(function (r) {
      return r.code === value.role;
    });
    if (D.taskRoleMap[value.task] == null || !okRole) return 'invalid';
    o.roles = o.roles || {};
    if (value.role === D.taskRoleMap[value.task]) delete o.roles[value.task];
    else o.roles[value.task] = value.role;
    if (!Object.keys(o.roles).length) delete o.roles;
  } else return 'invalid';
  try {
    var p = sset(_auditEstWbKey(projId), o);
    if (p && p.catch) p.catch(function () {});
    return 'ok';
  } catch (e) {
    return 'failed';
  }
}

/* ── Hours + cost breakdown for one audit type ('bas' | 'full') ──────────────────────────────
   Full Facility Audit = BAS Audit's own equipment/building/report hours, PLUS four flat
   per-building line items (mechanical walk-through, lighting review, envelope review, utility
   bill review) and additional report hours — never a per-equipment multiplier, since none of
   those four activities are counted per piece of BAS equipment. */
// Largest-remainder split of the whole number `total` across `weights`. Integers sum exactly to
// `total`; a zero weight always gets 0.
function _auditEstAllocate(total, weights) {
  var sum = weights.reduce(function (s, w) {
    return s + w;
  }, 0);
  var out = weights.map(function () {
    return 0;
  });
  if (!(sum > 0) || !total) return out;
  var rem = [];
  var given = 0;
  weights.forEach(function (w, i) {
    var exact = (total * w) / sum;
    out[i] = Math.floor(exact + 1e-9);
    given += out[i];
    rem.push({ i: i, r: exact - out[i], w: w });
  });
  rem
    .filter(function (x) {
      return x.w > 0;
    })
    .sort(function (a, b) {
      return b.r - a.r || b.w - a.w || a.i - b.i;
    })
    .slice(0, Math.max(0, total - given))
    .forEach(function (x) {
      out[x.i]++;
    });
  return out;
}

function auditEstComputeBreakdown(projId, auditType) {
  var summary = auditEstGetEquipmentSummary(projId);
  if (!summary) return null;
  var cfg = auditEstGetConfig();
  var rate = auditEstGetHourlyRate();
  var hourOverrides = auditEstGetHourOverrides(projId);

  var bList = summary.allBuildingList;
  // Per-building accumulators (hours in hundredths of an hour so sums are exact).
  var bEquip = bList.map(function () {
    return 0;
  });
  var bSampled = bEquip.slice();
  var bHrs = bEquip.slice();
  var projHrs = 0;
  // Buildings that carry the Full Facility per-building line items (same set as buildingCount).
  var bPriced = bList.map(function (n) {
    return summary.buildingList.indexOf(n) !== -1 ? 1 : 0;
  });

  var rows = summary.equipTypes.map(function (e) {
    var defaultHoursEach = cfg.hoursPerEquip[e.category] != null ? cfg.hoursPerEquip[e.category] : 1;
    var overridden = hourOverrides[e.category] != null;
    var hoursEach = overridden ? hourOverrides[e.category] : defaultHoursEach;
    // Sample model: review one unit per group (units with the same control features), plus a
    // fixed Equipment Matrix review. Never more than reviewing every unit.
    var fullHours = e.count * hoursEach;
    var reviewedUnits = Math.min(e.count, e.groupCount);
    var sampleHours = cfg.matrixReviewHours + reviewedUnits * hoursEach;
    if (sampleHours >= fullHours) reviewedUnits = e.count;
    var hours = Math.round(Math.min(fullHours, sampleHours) * 100) / 100;
    // Per-building split of this type: Sampled by largest remainder on the building counts; the
    // unit hours (hours minus the fixed matrix review) follow the allocated Sampled; the matrix
    // review is project-wide. A capped type (every unit reviewed) has no matrix review.
    var counts = bList.map(function (n) {
      return e.byBuilding[n] || 0;
    });
    var sampAlloc = _auditEstAllocate(reviewedUnits, counts);
    var hoursC = Math.round(hours * 100);
    var reviewC = reviewedUnits === e.count ? 0 : Math.min(hoursC, Math.round(cfg.matrixReviewHours * 100));
    var unitAlloc = _auditEstAllocate(hoursC - reviewC, sampAlloc);
    projHrs += reviewC;
    bList.forEach(function (n, i) {
      bEquip[i] += counts[i];
      bSampled[i] += sampAlloc[i];
      bHrs[i] += unitAlloc[i];
    });
    return {
      category: e.category,
      label: e.label,
      count: e.count,
      groupCount: e.groupCount,
      groupList: e.groupList,
      sampled: reviewedUnits,
      avgPoints: e.avgPoints,
      hoursEach: hoursEach,
      defaultHoursEach: defaultHoursEach,
      defaultSource: auditEstDefaultSource(e.category),
      overridden: overridden,
      hours: hours,
      matrixHours: reviewC / 100,
      cost: Math.round(hours * rate * 100) / 100,
    };
  });

  var equipHours = rows.reduce(function (s, r) {
    return s + r.hours;
  }, 0);
  // Site visit & travel exists only for the Full Facility Audit; the BAS Audit is a remote review.
  var buildingLineHours =
    auditType === 'full' ? Math.round(summary.buildingCount * cfg.hoursPerBuilding * 100) / 100 : 0;
  var reportHours = cfg.hoursReport;

  var extras = [];
  if (auditType === 'full') {
    var ff = cfg.fullFacility;
    extras = [
      {
        label: 'Mechanical System Walk-Through',
        hours: Math.round(summary.buildingCount * ff.hoursMechanicalWalkthroughPerBuilding * 100) / 100,
      },
      {
        label: 'Lighting System Review',
        hours: Math.round(summary.buildingCount * ff.hoursLightingReviewPerBuilding * 100) / 100,
      },
      {
        label: 'Building Envelope Review',
        hours: Math.round(summary.buildingCount * ff.hoursEnvelopeReviewPerBuilding * 100) / 100,
      },
      {
        label: 'Utility Bill Review',
        hours: Math.round(summary.buildingCount * ff.hoursUtilityBillReviewPerBuilding * 100) / 100,
      },
    ];
    reportHours = Math.round((reportHours + ff.hoursReportExtra) * 100) / 100;
  }
  // Full Facility per-building line items go to their own building (equal split in hundredths).
  var lineItems = extras.slice();
  if (auditType === 'full') lineItems.push({ hours: buildingLineHours });
  lineItems.forEach(function (x) {
    _auditEstAllocate(Math.round(x.hours * 100), bPriced).forEach(function (v, i) {
      bHrs[i] += v;
    });
  });
  projHrs += Math.round(reportHours * 100);
  extras.forEach(function (x) {
    x.cost = Math.round(x.hours * rate * 100) / 100;
  });
  var extrasHours = extras.reduce(function (s, x) {
    return s + x.hours;
  }, 0);

  var totalHours = Math.round((equipHours + buildingLineHours + reportHours + extrasHours) * 100) / 100;
  var totalCost = Math.round(totalHours * rate * 100) / 100;
  var wbSet = auditEstGetWorkbookSettings(projId);
  var isWorkbook = wbSet.method === 'workbook';
  var wb = null;
  var siteCost = 0;
  var reportCost = 0;

  if (isWorkbook) {
    // Hours by task type -> roles (plan 2, editable per project) -> EstimateWorkbook.compute().
    // No $100 round-up in this mode.
    var D = EstimateWorkbook.DEFAULTS;
    var matrixC = rows.reduce(function (s, r) {
      return s + Math.round(r.matrixHours * 100);
    }, 0);
    var tasks = [
      { id: 'audit_equipment_review', hours: (Math.round(equipHours * 100) - matrixC) / 100 },
      { id: 'audit_matrix_review', hours: matrixC / 100 },
      { id: 'audit_report', hours: reportHours },
    ];
    if (auditType === 'full') {
      tasks.push({ id: 'audit_site_visit_travel', hours: buildingLineHours });
      [
        'audit_mechanical_review',
        'audit_lighting_review',
        'audit_envelope_review',
        'audit_utility_review',
      ].forEach(function (id, i) {
        tasks.push({ id: id, hours: extras[i].hours });
      });
    }
    var roleC = {};
    tasks.forEach(function (t) {
      t.role = wbSet.roles[t.id] || D.taskRoleMap[t.id];
      t.label = D.taskTypes.filter(function (x) {
        return x.id === t.id;
      })[0].label;
      roleC[t.role] = (roleC[t.role] || 0) + Math.round(t.hours * 100);
    });
    var roleHours = {};
    Object.keys(roleC).forEach(function (k) {
      roleHours[k] = roleC[k] / 100;
    });
    var wbInput = { hours: roleHours, ot: wbSet.ot, state: wbSet.state, taxRate: wbSet.taxRate, bond: wbSet.bond };
    var calc = EstimateWorkbook.compute(wbInput);
    var sm = calc.summary;
    var chain = auditEstWorkbookChain(calc);
    wb = { input: wbInput, tasks: tasks, roleHours: roleHours, summary: sm, settings: wbSet, chain: chain };
    totalCost = sm.total;
    // Each line's cost is its share of the total (largest remainder, whole dollars), so the
    // type rows, site items and report add up to the total exactly.
    var weights = rows.map(function (r) {
      return Math.round(r.hours * 100);
    });
    weights.push(Math.round(buildingLineHours * 100));
    extras.forEach(function (x) {
      weights.push(Math.round(x.hours * 100));
    });
    weights.push(Math.round(reportHours * 100));
    var shares = _auditEstAllocate(totalCost, weights);
    rows.forEach(function (r, i) {
      r.cost = shares[i];
    });
    var k = rows.length;
    siteCost = shares[k++];
    extras.forEach(function (x) {
      x.cost = shares[k++];
    });
    reportCost = shares[k];
  } else {
    siteCost = Math.round(buildingLineHours * rate * 100) / 100;
    reportCost = Math.round(reportHours * rate * 100) / 100;
  }

  // Cost by building: split totalCost by hours so the entries sum to it exactly
  // (to the cent; whole dollars in workbook mode).
  var unit = isWorkbook ? 1 : 100;
  var costC = _auditEstAllocate(Math.round(totalCost * unit), bHrs.concat([projHrs]));
  var byBuilding = bList.map(function (n, i) {
    return { building: n, equipment: bEquip[i], sampled: bSampled[i], hours: bHrs[i] / 100, cost: costC[i] / unit };
  });
  byBuilding.push({
    building: 'Project-wide',
    projectWide: true,
    equipment: null,
    sampled: null,
    hours: projHrs / 100,
    cost: costC[bList.length] / unit,
  });

  return {
    auditType: auditType,
    method: wbSet.method,
    workbook: wb,
    proposalPrice: isWorkbook ? totalCost : auditEstRoundProposalPrice(totalCost),
    byBuilding: byBuilding,
    buildingCount: summary.buildingCount,
    buildingList: summary.buildingList,
    excluded: summary.excluded,
    rows: rows,
    buildingLineHours: buildingLineHours,
    buildingLineCost: siteCost,
    reportHours: reportHours,
    reportCost: reportCost,
    extras: extras,
    totalHours: totalHours,
    totalCost: totalCost,
    hourlyRate: rate,
    projId: projId,
  };
}

/* ── Formatting helpers (reuse the Cost Estimate tab's currency formatter if present) ──────── */
function _auditEstFmt(n) {
  if (typeof _pricingFmt === 'function') return _pricingFmt(n);
  if (n == null || isNaN(n)) return '—';
  return (
    '$' +
    Number(n)
      .toFixed(2)
      .replace(/\B(?=(\d{3})+(?!\d)\.\d{2}$)/g, ',')
  );
}
function _auditEstEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ── Client-facing proposal price rounding (2026-09-25) ──────────────────────────────────────
   The internal breakdown above keeps the exact computed totalCost, in dollars and cents, for
   internal review — never touched by this. The client-facing Audit Proposal (report-engine.js's
   _rptAuditProposalDetailInnerHTML) shows one rounded, whole-dollar price instead: client price
   pages never show cents (per Matt, 2026-09-25). Round UP (ceiling) to the next $100 —
   $84,377.80 -> $84,400; $96,107.80 -> $96,200. This is the ONE rounding function; both this
   file's breakdown totals row and report-engine.js's proposal price call it, so they can never
   disagree. */
function auditEstRoundProposalPrice(totalCost) {
  if (totalCost == null || isNaN(totalCost)) return 0;
  return Math.ceil(Number(totalCost) / 100) * 100;
}
window.auditEstRoundProposalPrice = auditEstRoundProposalPrice;

// _auditEstFmtWhole — whole-dollar formatting (no cents), for the rounded proposal price only.
// The exact-figure breakdown keeps using _auditEstFmt (always 2 decimals) everywhere else.
function _auditEstFmtWhole(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

// Money formatter of a breakdown: whole dollars in workbook mode, dollars and cents in hourly mode.
function _auditEstMoney(b) {
  return b && b.method === 'workbook' ? _auditEstFmtWhole : _auditEstFmt;
}

/* ── UI: expandable "Units to sample" detail under a type row ──────────────────────────────── */
window._auditEstUnitsOpen = window._auditEstUnitsOpen || {};
function _auditEstUnitsKey(projId, auditType, cat) {
  return projId + '|' + auditType + '|' + cat;
}
function _auditEstUnitsToggleHTML(projId, auditType, r) {
  var open = !!window._auditEstUnitsOpen[_auditEstUnitsKey(projId, auditType, r.category)];
  return (
    '<button type="button" class="ae-exp" aria-expanded="' +
    open +
    '" title="Units to sample" onclick="auditEstToggleUnits(\'' +
    projId +
    "','" +
    auditType +
    "','" +
    r.category +
    "')\">" +
    (open ? '&#9662;' : '&#9656;') +
    '</button>'
  );
}
function _auditEstUnitsDetailHTML(projId, auditType, r) {
  if (!window._auditEstUnitsOpen[_auditEstUnitsKey(projId, auditType, r.category)]) return '';
  var items = (r.groupList || [])
    .map(function (g) {
      var others = g.count - 1;
      return (
        '<div class="ae-unit"><b>' +
        _auditEstEsc(g.rep) +
        '</b>' +
        (g.repBuilding ? ' &middot; ' + _auditEstEsc(g.repBuilding) : '') +
        ' &middot; ' +
        _auditEstEsc(g.concepts && g.concepts.length ? g.concepts.join(' + ') : 'No listed control features') +
        ' &middot; ' +
        (others > 0 ? others + ' similar unit' + (others === 1 ? '' : 's') : 'no similar units') +
        '</div>'
      );
    })
    .join('');
  return (
    '<tr class="ae-detail"><td colspan="7" style="padding:0"><div class="ae-detail-in"><div class="ae-detail-h">Units to sample: ' +
    _auditEstEsc(r.label) +
    '</div>' +
    items +
    '</div></td></tr>'
  );
}
function auditEstToggleUnits(projId, auditType, cat) {
  var k = _auditEstUnitsKey(projId, auditType, cat);
  window._auditEstUnitsOpen[k] = !window._auditEstUnitsOpen[k];
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}

/* ── UI: breakdown table for one audit type ──────────────────────────────────────────────── */
function _auditEstBreakdownTableHTML(b, titleText) {
  if (!b) {
    return '<div style="padding:12px;color:var(--text3);font-size:12px">No Equipment Matrix data — import a BAS point list on the Equipment tab first.</div>';
  }
  var numTd = function (v) {
    return '<td class="ch-tbl-col-type-number">' + v + '</td>';
  };
  var money = _auditEstMoney(b);
  var isWb = b.method === 'workbook';
  var rowsHTML = b.rows
    .map(function (r) {
      return (
        '<tr><td class="ch-tbl-col-type-label">' +
        _auditEstUnitsToggleHTML(b.projId, b.auditType, r) +
        _auditEstEsc(r.label) +
        '</td>' +
        numTd(r.count) +
        numTd(r.groupCount) +
        numTd(r.sampled) +
        numTd(
          (r.overridden
            ? '<span class="ae-ovr" title="Project value. Changed from the ' + r.defaultSource + ' default ' + r.defaultHoursEach.toFixed(2) + '">&bull;</span> '
            : '') + r.hoursEach.toFixed(2)
        ) +
        numTd(r.hours.toFixed(1)) +
        '<td class="ch-tbl-col-type-currency">' +
        money(r.cost) +
        '</td></tr>' +
        _auditEstUnitsDetailHTML(b.projId, b.auditType, r)
      );
    })
    .join('');

  var extraRowsHTML = b.extras
    .map(function (x) {
      return (
        '<tr><td class="ch-tbl-col-type-label">' +
        _auditEstEsc(x.label) +
        '</td>' +
        numTd(b.buildingCount + ' buildings') +
        numTd('—') +
        numTd('—') +
        numTd('—') +
        numTd(x.hours.toFixed(1)) +
        '<td class="ch-tbl-col-type-currency">' +
        money(x.cost) +
        '</td></tr>'
      );
    })
    .join('');
  var siteVisitRowHTML =
    b.auditType === 'full'
      ? '<tr><td class="ch-tbl-col-type-label">Site Visit &amp; Travel</td>' +
        numTd(b.buildingCount + ' buildings') +
        numTd('—') +
        numTd('—') +
        numTd('—') +
        numTd(b.buildingLineHours.toFixed(1)) +
        '<td class="ch-tbl-col-type-currency">' +
        money(b.buildingLineCost) +
        '</td></tr>'
      : '';
  var th = function (label, tip) {
    return '<th title="' + _auditEstEsc(tip) + '">' + label + '</th>';
  };

  return (
    '<div class="ae-wrap">' +
    '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px">' +
    _auditEstEsc(titleText) +
    '</div>' +
    // No inner overflow:auto here (ui-standards.md "one scroll region per panel") — the
    // outer flex-shrink:0 wrap (app/pricing-estimator.js's initCostEstimateTab patch) is the
    // ONE scroll region for the whole Audit Estimate section; nesting a second overflow:auto
    // scroll box around just the table rows made the totals row/buttons unreachable by
    // scrolling the outer wrap (caught in headless verification, 2026-09-25).
    '<div class="ch-tbl-outer ae-tbl-outer">' +
    '<table class="ch-tbl ae-tbl">' +
    '<thead><tr>' +
    '<th class="ae-left">Equipment Type</th>' +
    th('Count', 'Number of units of this type in the Equipment Matrix.') +
    th('Groups', 'Units with the same control features (economizer, VFD, heating, cooling, CO2, zone temp) count as one group. One unit per group is sampled.') +
    th('Sampled', 'Units reviewed: one per group. Never more than Count.') +
    th('Hours Each', 'Hours to review one unit.') +
    th('Hours', 'Matrix review time plus the Sampled units times Hours Each. Never more than Count times Hours Each.') +
    th('Cost', isWb ? 'This line\'s share of the total price, split by hours.' : 'Hours times the labor rate.') +
    '</tr></thead>' +
    '<tbody>' +
    rowsHTML +
    siteVisitRowHTML +
    extraRowsHTML +
    '<tr><td class="ch-tbl-col-type-label">Report &amp; Analysis</td>' +
    '<td class="ch-tbl-col-type-number">—</td><td class="ch-tbl-col-type-number">—</td>' +
    '<td class="ch-tbl-col-type-number">—</td><td class="ch-tbl-col-type-number">—</td>' +
    '<td class="ch-tbl-col-type-number">' +
    b.reportHours.toFixed(1) +
    '</td><td class="ch-tbl-col-type-currency">' +
    money(b.reportCost) +
    '</td></tr>' +
    '</tbody>' +
    '<tfoot><tr>' +
    '<td>' + (isWb ? 'Total price' : 'Total') + '</td><td>—</td><td>—</td><td>—</td><td>—</td>' +
    '<td class="ch-tbl-col-type-number">' +
    b.totalHours.toFixed(1) +
    '</td><td class="ch-tbl-col-type-currency">' +
    money(b.totalCost) +
    '</td>' +
    '</tr>' +
    (isWb
      ? ''
      : '<tr><td>Proposal price (rounded up to the next $100)</td><td>—</td><td>—</td><td>—</td><td>—</td>' +
        '<td class="ch-tbl-col-type-number">—</td>' +
        '<td class="ch-tbl-col-type-currency">' +
        _auditEstFmtWhole(b.proposalPrice) +
        '</td>' +
        '</tr>') +
    '</tfoot>' +
    '</table></div>' +
    _auditEstWorkbookPanelHTML(b) +
    _auditEstByBuildingTableHTML(b) +
    '</div>'
  );
}

/* ── UI: Workbook method panel — "How this total is built" + labor by task type ──────────────
   Shown only in workbook mode. The chain lines come from EstimateWorkbook.compute() (see
   auditEstComputeBreakdown); each task type's role is a select saved per project. */
function _auditEstWorkbookPanelHTML(b) {
  if (!b || b.method !== 'workbook' || !b.workbook) return '';
  return auditEstWorkbookPanelHTML(b.projId, b.workbook, 'Labor by task');
}
// w = { settings, chain, tasks:[{id,label,hours,role}] }. Also used by the Cost Estimate.
function auditEstWorkbookPanelHTML(pid, w, taskHead) {
  var D = EstimateWorkbook.DEFAULTS;
  var selStyle =
    'font-size:11px;padding:2px 4px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px;max-width:100%';
  var opt = function (list, cur) {
    return list
      .map(function (o) {
        return '<option' + (o === cur ? ' selected' : '') + '>' + _auditEstEsc(o) + '</option>';
      })
      .join('');
  };
  var ctl =
    '<div class="ae-ctl">' +
    '<label>Overtime <select style="' + selStyle + '" onchange="auditEstSaveWorkbook(\'' + pid + "','ot',this.value)\">" +
    opt(AUDIT_EST_OT_OPTIONS, w.settings.ot) + '</select></label>' +
    '<label>Tax state <select style="' + selStyle + '" onchange="auditEstSaveWorkbook(\'' + pid + "','state',this.value)\">" +
    opt(AUDIT_EST_STATE_OPTIONS, w.settings.state) + '</select></label>' +
    '<label>Tax rate % <input type="number" min="0" max="100" step="0.001" value="' +
    Math.round(w.settings.taxRate * 100000) / 1000 +
    '" style="width:64px;text-align:right;' + selStyle + '" onchange="auditEstSaveWorkbook(\'' + pid +
    "','taxRate',this.value/100)\"></label>" +
    '<label><input type="checkbox"' + (w.settings.bond ? ' checked' : '') + ' onchange="auditEstSaveWorkbook(\'' + pid +
    "','bond',this.checked)\"> Bond</label>" +
    (auditEstOtHasNoEffect(w.tasks) ? '<span class="ae-note">Overtime has no effect: no role used here has an overtime rate.</span>' : '') +
    '</div>';
  var chainRows = w.chain
    .map(function (c) {
      return (
        '<tr' + (c.sub ? ' class="ae-sub"' : '') + '><td class="ch-tbl-col-type-label">' + _auditEstEsc(c.label) +
        '</td><td class="ch-tbl-col-type-currency">' + _auditEstFmtWhole(c.amount) + '</td></tr>'
      );
    })
    .join('');
  var taskRows = w.tasks
    .map(function (t) {
      var sel =
        '<select style="' + selStyle + '" title="Labor role for this task type" onchange="auditEstSaveWorkbookRole(\'' +
        pid + "','" + t.id + "',this.value)\">" +
        D.roles
          .map(function (r) {
            return '<option value="' + r.code + '"' + (r.code === t.role ? ' selected' : '') + ' title="' + _auditEstEsc(r.name) + '">' + r.code + '</option>';
          })
          .join('') +
        '</select>';
      return (
        '<tr><td class="ch-tbl-col-type-label">' + _auditEstEsc(t.label) + '</td><td class="ch-tbl-col-type-number">' +
        t.hours.toFixed(2) + '</td><td class="ch-tbl-col-type-label">' + sel + '</td></tr>'
      );
    })
    .join('');
  return (
    '<div class="ae-wb">' +
    '<div style="font-size:12px;font-weight:700;color:var(--text);margin:12px 0 4px">How this total is built (workbook)</div>' +
    ctl +
    '<div class="ae-wb-grid">' +
    (w.chain.length
      ? '<div class="ch-tbl-outer ae-tbl-outer"><table class="ch-tbl ae-tbl ae-chain-tbl">' +
        '<thead><tr><th class="ae-left">Step</th><th>Amount</th></tr></thead><tbody>' + chainRows + '</tbody></table></div>'
      : '') +
    '<div class="ch-tbl-outer ae-tbl-outer"><table class="ch-tbl ae-tbl ae-chain-tbl">' +
    '<thead><tr><th class="ae-left">' + _auditEstEsc(taskHead) + '</th><th>Hours</th><th class="ae-left">Role</th></tr></thead><tbody>' +
    taskRows + '</tbody></table></div>' +
    '</div></div>'
  );
}

// True when no role that has hours can be paid overtime (PE, DE, SE, TR, IT have none).
function auditEstOtHasNoEffect(tasks) {
  var ot = {};
  EstimateWorkbook.DEFAULTS.roles.forEach(function (r) {
    ot[r.code] = r.ot;
  });
  return !tasks.some(function (t) {
    return t.hours > 0 && ot[t.role];
  });
}

function auditEstSaveWorkbook(projId, field, value) {
  var res = auditEstSetWorkbookSetting(projId, field, value);
  if (res === 'invalid') showToast('That value is not valid', 'error');
  else if (res === 'failed') showToast('Could not save the setting', 'error');
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}
function auditEstSaveWorkbookRole(projId, task, role) {
  auditEstSaveWorkbook(projId, 'role', { task: task, role: role });
}

// Segmented "Workbook | Hourly $170" switch, shown in the Estimate type bar (app/pricing-estimator.js).
function auditEstMethodSwitchHTML(projId) {
  var cur = auditEstGetWorkbookSettings(projId).method;
  var rate = auditEstGetHourlyRate();
  var btn = function (m, label, tip) {
    return (
      '<button type="button" class="ae-seg-btn' + (cur === m ? ' on' : '') + '" aria-pressed="' + (cur === m) +
      '" title="' + _auditEstEsc(tip) + '" onclick="auditEstSetMethod(\'' + projId + "','" + m + "')\">" + label + '</button>'
    );
  };
  return (
    '<span class="ae-seg" role="group" aria-label="Pricing method">' +
    btn('workbook', 'Workbook', 'Price with the CSC cost estimate workbook: labor by role, tools, overhead, profit') +
    btn('hourly', 'Hourly ' + _auditEstFmtWhole(rate), 'Price as hours times the labor rate, proposal rounded up to the next $100') +
    '</span>'
  );
}
function auditEstSetMethod(projId, method) {
  if (auditEstSetWorkbookSetting(projId, 'method', method) === 'failed') showToast('Could not save the method', 'error');
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}

/* ── Excel export (workbook method) ───────────────────────────────────────────────────────────
   Writes the breakdown's EstimateWorkbook input into the estimate template with
   EstimateWorkbookExport (app/estimate-workbook-export.js). ExcelJS is a CDN global; the export
   throws synchronously when it is missing, so the call is wrapped. */
function auditEstExportExcel(projId, auditType) {
  var b = auditEstComputeBreakdown(projId, auditType);
  if (!b || !b.workbook) {
    showToast('Switch to the Workbook method to export to Excel', 'error');
    return;
  }
  var typeName = auditType === 'full' ? 'Full Facility Audit' : 'Building Automation System Audit';
  var proj = (typeof projects !== 'undefined' ? projects : []).find(function (x) {
    return String(x.id) === String(projId);
  });
  var projName = proj ? proj.client || proj.name || 'Project' : 'Project';
  var d = new Date();
  var pad = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  var meta = {
    customer: projName,
    project: projName + ' ' + typeName,
    title: typeName + ' Estimate',
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    preparedBy: 'Control Service Company',
  };
  var p;
  try {
    p = EstimateWorkbookExport.exportBlob(b.workbook.input, meta);
  } catch (e) {
    showToast('Excel export is not available: ' + (e && e.message ? e.message : e), 'error');
    return;
  }
  p.then(function (blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = EstimateWorkbookExport.fileName(meta);
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    showToast('Exported ' + a.download, 'success');
  }).catch(function (e) {
    showToast('Excel export failed: ' + (e && e.message ? e.message : e), 'error');
  });
}

/* ── UI: Cost by Building table (screen only; not in the proposal) ─────────────────────────── */
function _auditEstByBuildingTableHTML(b) {
  if (!b || !b.byBuilding) return '';
  var num = function (v) {
    return '<td class="ch-tbl-col-type-number">' + v + '</td>';
  };
  var body = b.byBuilding
    .map(function (x) {
      var dash = function (v) {
        return v ? v : '—';
      };
      return (
        '<tr><td class="ch-tbl-col-type-label">' +
        _auditEstEsc(x.building) +
        '</td>' +
        num(dash(x.equipment)) +
        num(dash(x.sampled)) +
        num(x.hours ? x.hours.toFixed(1) : '—') +
        '<td class="ch-tbl-col-type-currency">' +
        (x.cost ? _auditEstMoney(b)(x.cost) : '—') +
        '</td></tr>'
      );
    })
    .join('');
  var eq = b.byBuilding.reduce(function (s, x) {
    return s + (x.equipment || 0);
  }, 0);
  var sm = b.byBuilding.reduce(function (s, x) {
    return s + (x.sampled || 0);
  }, 0);
  var th = function (l, tip) {
    return '<th title="' + _auditEstEsc(tip) + '">' + l + '</th>';
  };
  return (
    '<div style="font-size:12px;font-weight:700;color:var(--text);margin:12px 0 4px">Cost by Building</div>' +
    '<div class="ch-tbl-outer ae-tbl-outer"><table class="ch-tbl ae-tbl ae-bldg-tbl">' +
    '<thead><tr><th class="ae-left">Building</th>' +
    th('Equipment', 'Units of auditable equipment in this building.') +
    th('Sampled', 'Sampled units of each type, shared across buildings by how many units each has.') +
    th('Hours', 'Sampled units times Hours Each, plus the site items of this building.') +
    th('Cost', 'Hours times the labor rate. Project-wide is the matrix review and the report.') +
    '</tr></thead><tbody>' +
    body +
    '</tbody><tfoot><tr><td>Total</td>' +
    num(eq) +
    num(sm) +
    num(b.totalHours.toFixed(1)) +
    '<td class="ch-tbl-col-type-currency">' +
    _auditEstMoney(b)(b.totalCost) +
    '</td></tr></tfoot></table></div>'
  );
}

/* ── UI: editable assumptions table ──────────────────────────────────────────────────────── */
function _auditEstAssumptionsHTML(projId, auditType) {
  var isFull = auditType === 'full';
  var cfg = auditEstGetConfig();
  var rate = auditEstGetHourlyRate();
  var ovr = auditEstGetHourOverrides(projId);
  var typeRows = (auditEstComputeBreakdown(projId, 'bas') || { rows: [] }).rows;
  var rows = typeRows
    .map(function (r) {
      var cat = r.category;
      var has = ovr[cat] != null;
      var sourced = ['vav', 'heater', 'fpb', 'rtu', 'ahu', 'fcu'].indexOf(cat) !== -1;
      return (
        '<tr><td class="ch-tbl-col-type-label">' +
        _auditEstEsc(r.label) +
        '</td><td class="ch-tbl-col-type-number">' +
        '<input type="number" step="0.01" min="0" value="' +
        (has ? ovr[cat] : '') +
        '" placeholder="' +
        r.defaultHoursEach.toFixed(2) +
        '" title="Blank = ' +
        r.defaultSource +
        ' default ' +
        r.defaultHoursEach.toFixed(2) +
        '" id="auditEstHrs_' +
        projId +
        '_' +
        cat +
        '" style="width:70px;text-align:right;background:var(--s1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveHours(\'' +
        projId +
        "','" +
        cat +
        "', this.value)\">" +
        '</td><td class="ch-tbl-col-type-number" title="From the ' +
        r.defaultSource +
        ' default">' +
        r.defaultHoursEach.toFixed(2) +
        (r.defaultSource === 'company' ? ' *' : '') +
        '</td><td class="ch-tbl-col-type-label"><button type="button" ' +
        (has ? '' : 'disabled ') +
        'onclick="auditEstSaveHours(\'' +
        projId +
        "','" +
        cat +
        "', '')\" style=\"font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer\">Reset</button> <button type=\"button\" " +
        (has ? '' : 'disabled ') +
        "title=\"Save this value as the company default for every project\" onclick=\"auditEstSaveCompanyHours('" +
        projId +
        "','" +
        cat +
        "')\" style=\"font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer\">Set company default</button> <button type=\"button\" " +
        (r.defaultSource === 'company' ? '' : 'disabled ') +
        "title=\"Put the company default back to the built-in " +
        (AUDIT_EST_HOURS_PER_EQUIP_DEFAULT[cat] != null ? AUDIT_EST_HOURS_PER_EQUIP_DEFAULT[cat].toFixed(2) : '1.00') +
        "\" onclick=\"auditEstResetCompanyHours('" +
        projId +
        "','" +
        cat +
        "')\" style=\"font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer\">Built-in default</button></td>" +
        '<td class="ch-tbl-col-type-label" style="font-size:11px;color:var(--text3)">' +
        (sourced ? 'Optimization Strategy Sheet xlsx' : 'Starting estimate') +
        '</td></tr>'
      );
    })
    .join('');

  return (
    '<div id="auditEstAssumptions_' +
    projId +
    '" style="display:' +
    (window._auditEstAssumOpen && window._auditEstAssumOpen[projId] ? 'block' : 'none') +
    ';margin-top:10px;padding:12px;background:var(--s1);border:1px solid var(--border);border-radius:6px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">Audit Estimate Assumptions (Hours Each is for this project; the other values are company-wide)</div>' +
    '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px">' +
    (isFull
      ? '<div><label style="font-size:11px;color:var(--text3)">Hours per building (site visit and travel)</label><br>' +
        '<input type="number" step="0.25" min="0" value="' +
        cfg.hoursPerBuilding +
        '" id="auditEstBldgHrs_' +
        projId +
        '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
        projId +
        "','hoursPerBuilding', this.value)\"></div>"
      : '') +
    '<div><label style="font-size:11px;color:var(--text3)">Matrix review hours (per equipment type)</label><br>' +
    '<input type="number" step="0.25" min="0" value="' +
    cfg.matrixReviewHours +
    '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
    projId +
    "','matrixReviewHours', this.value)\"></div>" +
    '<div><label style="font-size:11px;color:var(--text3)">Report and analysis hours (fixed)</label><br>' +
    '<input type="number" step="0.25" min="0" value="' +
    cfg.hoursReport +
    '" id="auditEstRptHrs_' +
    projId +
    '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
    projId +
    "','hoursReport', this.value)\"></div>" +
    (auditEstGetWorkbookSettings(projId).method === 'workbook'
      ? '<div><label style="font-size:11px;color:var(--text3)">Labor rate</label><br>' +
        '<div style="font-size:13px;font-weight:700;color:var(--text);padding:3px 0">By role (workbook)</div></div>'
      : '<div><label style="font-size:11px;color:var(--text3)">Labor rate ($/hour, from Cost Estimate)</label><br>' +
        '<div style="font-size:13px;font-weight:700;color:var(--text);padding:3px 0">' +
        _auditEstFmt(rate) +
        '/hour</div></div>') +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:12px;margin:10px 0 6px"><div style="font-size:12px;font-weight:700;color:var(--text2)">Hours Each per equipment type (this project; blank = default)</div>' +
    '<button type="button" ' +
    (Object.keys(ovr).length ? '' : 'disabled ') +
    'onclick="auditEstResetAllHours(\'' +
    projId +
    "')\" style=\"font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer\">Reset all</button></div>" +
    '<div class="ch-tbl-outer ae-assum"><table class="ch-tbl" style="width:100%">' +
    '<thead><tr><th>Equipment Type</th><th>Hours Each</th><th>Default (* = company)</th><th>Actions</th><th>Default source</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></div>' +
    (isFull
      ? '<div style="font-size:12px;font-weight:700;color:var(--text2);margin:10px 0 6px">Full Facility Audit — additional per-building hours</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
        [
          'hoursMechanicalWalkthroughPerBuilding',
          'hoursLightingReviewPerBuilding',
          'hoursEnvelopeReviewPerBuilding',
          'hoursUtilityBillReviewPerBuilding',
          'hoursReportExtra',
        ]
          .map(function (k) {
            var lbl = {
              hoursMechanicalWalkthroughPerBuilding: 'Mechanical Walk-Through / Building',
              hoursLightingReviewPerBuilding: 'Lighting Review / Building',
              hoursEnvelopeReviewPerBuilding: 'Envelope Review / Building',
              hoursUtilityBillReviewPerBuilding: 'Utility Bill Review / Building',
              hoursReportExtra: 'Additional Report Hours (fixed)',
            }[k];
            return (
              '<div><label style="font-size:11px;color:var(--text3)">' +
              lbl +
              '</label><br><input type="number" step="0.25" min="0" value="' +
              cfg.fullFacility[k] +
              '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
              projId +
              "','fullFacility." +
              k +
              '\', this.value)"></div>'
            );
          })
          .join('') +
        '</div>'
      : '') +
    '<div style="margin-top:10px"><button onclick="auditEstShowHistory(\'' +
    projId +
    '\')" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer">View Change History (' +
    (cfg.history || []).length +
    ')</button></div>' +
    '</div>'
  );
}

/* Table look for the two audit tables (ui-standards.md Tables: outer border, --s1 header, grid
   lines, totals footer). Scoped to .ae-tbl so it touches no other table. The outer box scrolls
   sideways only when the window is too narrow for the columns, never the page. */
var AUDIT_EST_TABLE_CSS =
  '<style>' +
  '.ae-tbl-outer{border:1px solid var(--border);border-radius:6px;overflow:hidden;width:fit-content;max-width:100%}' +
  '.ae-tbl{border-collapse:separate;border-spacing:0;width:auto;font-size:12px;font-variant-numeric:tabular-nums}' +
  '.ae-tbl th,.ae-tbl td{padding:5px 6px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);color:var(--text)}.ae-tbl td.ch-tbl-col-type-number,.ae-tbl td.ch-tbl-col-type-currency{white-space:nowrap}.ae-tbl td.ch-tbl-col-type-label{overflow-wrap:anywhere}.ae-tbl th{overflow-wrap:normal}' +
  '.ae-assum{max-width:560px}.ae-assum td{overflow-wrap:anywhere}.ae-wrap{flex:0 1 auto;min-width:0;max-width:100%}.ae-wb-grid{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}' +
  '.ae-ctl{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:11px;color:var(--text2);margin-bottom:6px}.ae-ctl label{display:flex;align-items:center;gap:4px}' +
  '.ae-tbl tr.ae-sub td{background:var(--s1);font-weight:700}' +
  '.ae-seg{display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden}.ae-seg-btn{font-size:11px;padding:3px 10px;border:none;background:var(--s3);color:var(--text2);cursor:pointer}.ae-seg-btn+.ae-seg-btn{border-left:1px solid var(--border)}.ae-seg-btn.on{background:var(--accent);color:#fff;font-weight:700}' +
  '@media (max-width:900px){.ae-tbl{font-size:11px}.ae-tbl th,.ae-tbl td{padding:3px 4px}.ae-tbl thead th{font-size:9px;letter-spacing:0}.ae-exp{padding:0 2px 0 0}}' +
  '.ae-tbl th:last-child,.ae-tbl td:last-child{border-right:none}' +
  '.ae-tbl tbody tr:last-child td{border-bottom:none}' +
  '.ae-tbl thead th{background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;text-align:right;border-bottom:1px solid var(--border2);cursor:help}' +
  '.ae-tbl thead th.ae-left{text-align:left;cursor:default}' +
  '.ae-tbl td.ch-tbl-col-type-label{text-align:left}' +
  '.ae-tbl td.ch-tbl-col-type-number,.ae-tbl td.ch-tbl-col-type-currency{text-align:right}' +
  '.ae-tbl tfoot td{background:var(--s1);font-weight:700;border-top:2px solid var(--border2);border-bottom:none}' +
  '.ae-tbl tbody tr:hover td{background:var(--s4)}' +
  '.ae-bldg-tbl th,.ae-bldg-tbl td{padding:3px 6px}' +
  '.ae-exp{background:none;border:none;color:var(--text2);cursor:pointer;padding:0 4px 0 0;font-size:11px}' +
  '.ae-ovr{color:var(--accent);cursor:help}' +
  '.ae-tbl tr.ae-detail td{white-space:normal;background:var(--s1)}' +
  '.ae-detail-in{width:0;min-width:100%;padding:5px 8px;font-size:11px;line-height:1.4;color:var(--text2);box-sizing:border-box}' +
  '.ae-detail-h{font-weight:700;color:var(--text);margin-bottom:2px}.ae-unit{padding:1px 0}' +
  '</style>';

/* ── Main render entry — called from initCostEstimateTab (app/pricing-estimator.js) ────────── */
function auditEstRenderHTML(projId, auditType) {
  var isFull = auditType === 'full';
  var typeName = isFull ? 'Full Facility Audit' : 'Building Automation System Audit';
  var b = auditEstComputeBreakdown(projId, isFull ? 'full' : 'bas');
  var excludedNote = '';
  if (b && b.excluded && b.excluded.length) {
    excludedNote =
      '<div style="font-size:11px;color:var(--text3);margin-top:6px">Not counted per unit (covered as building-level items, or out of scope): ' +
      b.excluded
        .map(function (x) {
          return _auditEstEsc(x.label) + ' (' + x.count + ')';
        })
        .join(', ') +
      '.</div>';
  }
  return (
    AUDIT_EST_TABLE_CSS +
    '<div class="ch-panel" style="margin-top:16px;border-top:2px solid var(--border2);padding-top:14px">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">' +
    '<div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--text)">' +
    typeName +
    ' Estimate</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:2px">Estimated hours and cost to run a ' +
    typeName +
    ' on this project, computed from the Equipment Matrix.</div>' +
    '</div>' +
    '<button onclick="auditEstToggleAssumptions(\'' +
    projId +
    '\')" style="font-size:11px;padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer">Edit Assumptions</button>' +
    '</div>' +
    _auditEstAssumptionsHTML(projId, isFull ? 'full' : 'bas') +
    '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:14px">' +
    _auditEstBreakdownTableHTML(b, typeName) +
    '</div>' +
    excludedNote +
    (b
      ? '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button onclick="auditEstGenerateProposal(\'' +
        projId +
        "','" +
        (isFull ? 'full' : 'bas') +
        '\')" class="rpt-toolbar-btn" style="font-size:12px;padding:6px 12px;border-radius:4px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer">Generate ' +
        typeName +
        ' Proposal</button>' +
        '<button onclick="auditEstExportExcel(\'' +
        projId +
        "','" +
        (isFull ? 'full' : 'bas') +
        '\')" class="rpt-toolbar-btn"' +
        (b.method === 'workbook' ? '' : ' disabled') +
        ' title="' +
        (b.method === 'workbook' ? 'Download this estimate as an Excel file' : 'Switch to the Workbook method to export') +
        '" style="font-size:12px;padding:6px 12px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text);cursor:' +
        (b.method === 'workbook' ? 'pointer' : 'not-allowed;opacity:.5') +
        '">Export to Excel</button>' +
        '</div>'
      : '') +
    '</div>'
  );
}

function auditEstToggleAssumptions(projId) {
  var el = document.getElementById('auditEstAssumptions_' + projId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  window._auditEstAssumOpen = window._auditEstAssumOpen || {};
  window._auditEstAssumOpen[projId] = el.style.display === 'block';
}

function auditEstSaveHours(projId, cat, value) {
  var res = auditEstSetHourOverride(projId, cat, value);
  if (res === 'invalid') showToast('Enter hours of 0 or more, or leave blank for the default', 'error');
  else if (res === 'failed') showToast('Could not save the hours', 'error');
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}
// Save the project's value as the company default (shared by every project). The project
// override is cleared so the row now shows the new default. Existing stored values are only
// replaced by this explicit action, with a history entry.
function auditEstSaveCompanyHours(projId, cat) {
  var v = auditEstGetHourOverrides(projId)[cat];
  if (v == null) return;
  auditEstSetConfig('hoursPerEquip.' + cat, v);
  auditEstSetHourOverride(projId, cat, '');
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}
// Company default back to the built-in value (written as that value; history records it).
function auditEstResetCompanyHours(projId, cat) {
  var b = AUDIT_EST_HOURS_PER_EQUIP_DEFAULT[cat];
  auditEstSetConfig('hoursPerEquip.' + cat, b != null ? b : 1);
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}
function auditEstResetAllHours(projId) {
  if (auditEstClearHourOverrides(projId) === 'failed') showToast('Could not reset the hours', 'error');
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
}

function auditEstSaveField(projId, path, value) {
  var n = parseFloat(value);
  if (isNaN(n) || n < 0) {
    showToast('Enter a valid number', 'error');
    return;
  }
  auditEstSetConfig(path, n);
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
  if (typeof showToast === 'function') showToast('Assumption updated', 'success');
}

function auditEstShowHistory(projId) {
  var cfg = auditEstGetConfig();
  var hist = (cfg.history || []).slice().reverse();
  if (!hist.length) {
    showToast('No assumption changes recorded yet', 'info');
    return;
  }
  var rowsHTML = hist
    .map(function (h) {
      var d = new Date(h.date);
      return (
        '<tr><td>' +
        (isNaN(d) ? h.date : d.toLocaleString()) +
        '</td><td>' +
        _auditEstEsc(h.field) +
        '</td><td>' +
        h.old +
        '</td><td>' +
        h.new +
        '</td></tr>'
      );
    })
    .join('');
  var html =
    '<div class="ch-tbl-outer"><table class="ch-tbl" style="width:100%"><thead><tr><th>Date</th><th>Field</th><th>Previous Value</th><th>New Value</th></tr></thead><tbody>' +
    rowsHTML +
    '</tbody></table></div>';
  _auditEstShowHistoryModal(html);
}

// Lightweight in-page modal (DOM construction — never document.write/innerHTML-from-window.open,
// which opens an XSS surface) for the assumption change history. Appended to and removed from
// document.body; no persistent DOM footprint when closed.
function _auditEstShowHistoryModal(bodyHTML) {
  var existing = document.getElementById('auditEstHistoryModal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'auditEstHistoryModal';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:var(--z-modal,800);display:flex;align-items:center;justify-content:center';
  var box = document.createElement('div');
  box.style.cssText =
    'background:var(--s2);border:1px solid var(--border);border-radius:8px;max-width:640px;max-height:80vh;overflow:auto;padding:16px 18px';
  var heading = document.createElement('div');
  heading.style.cssText = 'font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px';
  heading.textContent = 'Audit Estimate — Assumption Change History';
  var content = document.createElement('div');
  content.innerHTML = bodyHTML; // built entirely from _auditEstEsc()-escaped/numeric values above
  var closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText =
    'margin-top:12px;font-size:12px;padding:5px 12px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer';
  closeBtn.onclick = function () {
    overlay.remove();
  };
  overlay.onclick = function (e) {
    if (e.target === overlay) overlay.remove();
  };
  box.appendChild(heading);
  box.appendChild(content);
  box.appendChild(closeBtn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

/* ── Bridge to the Audit Proposal report (app/report-engine.js) ─────────────────────────────
   generateAuditProposalPreview() (app/report-engine.js) reuses this file's
   auditEstComputeBreakdown() and auditEstGetEquipmentSummary() for its ONE full price and its
   facility/equipment-count table — no separate pricing math lives in the report generator. */
function auditEstGenerateProposal(projId, auditType) {
  if (typeof generateAuditProposalPreview !== 'function') {
    showToast('Audit Proposal report is not loaded', 'error');
    return;
  }
  generateAuditProposalPreview(projId, auditType);
}
