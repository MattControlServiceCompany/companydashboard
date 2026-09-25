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
   reads that existing value first (auditEstGetHourlyRate()) and only falls back to its own
   company-wide default when pricing config isn't available. That is the "per-project override
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

var AUDIT_EST_RATE_DEFAULT = 170; // mirrors COST_LABOR_RATE_DEFAULT (app/pricing-estimator.js); see auditEstGetHourlyRate()

var AUDIT_EST_DEFAULTS = {
  hourlyRate: AUDIT_EST_RATE_DEFAULT,
  hoursPerEquip: Object.assign({}, AUDIT_EST_HOURS_PER_EQUIP_DEFAULT),
  hoursPerBuilding: 2, // estimate — site visit + travel time, per building (BAS Audit)
  hoursReport: 4, // estimate — fixed report writing/analysis hours (BAS Audit)
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
  merged.hoursPerEquip = Object.assign({}, dflt.hoursPerEquip, stored.hoursPerEquip || {});
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
// Cost Estimate about what CSC charges per hour on this project. Falls back to the Audit
// Estimate's own company-wide default only when pricing config isn't loaded.
function auditEstGetHourlyRate() {
  if (typeof _pricingGetConfig === 'function') {
    var cfg = _pricingGetConfig();
    if (cfg && cfg.hourlyRate) return cfg.hourlyRate;
  }
  return auditEstGetConfig().hourlyRate;
}

/* ── Equipment Matrix accessors — number of buildings, equipment count by type, points per
   equipment. Reuses emLoadMatrix()/emIsPhantomRow() (app/equipment-matrix.js) — the SAME
   equipment rows the Equipment Matrix tab and the ASHRAE 36 Audit Report read, so counts here
   always agree with what the Equipment Matrix tab shows. */
function auditEstGetEquipmentSummary(projId) {
  if (typeof emLoadMatrix !== 'function') return null;
  var matData = emLoadMatrix(projId);
  if (!matData || !matData.rows || !matData.rows.length) return null;
  var rows = matData.rows.filter(function (r) {
    return typeof emIsPhantomRow !== 'function' || !emIsPhantomRow(r);
  });
  if (!rows.length) return null;

  var buildings = {};
  var byCat = {};
  var excluded = {};

  rows.forEach(function (r) {
    var bName = r.building || 'Unknown Building';
    buildings[bName] = true;
    var cat = r.category || 'other';
    var pts = r.points ? Object.keys(r.points).length : 0;
    if (AUDIT_EST_CATEGORIES.indexOf(cat) !== -1) {
      if (!byCat[cat])
        byCat[cat] = { category: cat, label: AUDIT_EST_CAT_LABELS[cat] || cat, count: 0, totalPoints: 0 };
      byCat[cat].count++;
      byCat[cat].totalPoints += pts;
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
    return e;
  });

  return {
    buildingCount: Object.keys(buildings).length,
    buildingList: Object.keys(buildings).sort(),
    equipTypes: equipTypes,
    excluded: Object.keys(excluded).map(function (c) {
      return excluded[c];
    }),
  };
}

/* ── Hours + cost breakdown for one audit type ('bas' | 'full') ──────────────────────────────
   Full Facility Audit = BAS Audit's own equipment/building/report hours, PLUS four flat
   per-building line items (mechanical walk-through, lighting review, envelope review, utility
   bill review) and additional report hours — never a per-equipment multiplier, since none of
   those four activities are counted per piece of BAS equipment. */
function auditEstComputeBreakdown(projId, auditType) {
  var summary = auditEstGetEquipmentSummary(projId);
  if (!summary) return null;
  var cfg = auditEstGetConfig();
  var rate = auditEstGetHourlyRate();

  var rows = summary.equipTypes.map(function (e) {
    var hoursEach = cfg.hoursPerEquip[e.category] != null ? cfg.hoursPerEquip[e.category] : 1;
    var hours = Math.round(e.count * hoursEach * 100) / 100;
    return {
      category: e.category,
      label: e.label,
      count: e.count,
      avgPoints: e.avgPoints,
      hoursEach: hoursEach,
      hours: hours,
      cost: Math.round(hours * rate * 100) / 100,
    };
  });

  var equipHours = rows.reduce(function (s, r) {
    return s + r.hours;
  }, 0);
  var buildingLineHours = Math.round(summary.buildingCount * cfg.hoursPerBuilding * 100) / 100;
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
  extras.forEach(function (x) {
    x.cost = Math.round(x.hours * rate * 100) / 100;
  });
  var extrasHours = extras.reduce(function (s, x) {
    return s + x.hours;
  }, 0);

  var totalHours = Math.round((equipHours + buildingLineHours + reportHours + extrasHours) * 100) / 100;
  var totalCost = Math.round(totalHours * rate * 100) / 100;

  return {
    auditType: auditType,
    buildingCount: summary.buildingCount,
    buildingList: summary.buildingList,
    excluded: summary.excluded,
    rows: rows,
    buildingLineHours: buildingLineHours,
    buildingLineCost: Math.round(buildingLineHours * rate * 100) / 100,
    reportHours: reportHours,
    reportCost: Math.round(reportHours * rate * 100) / 100,
    extras: extras,
    totalHours: totalHours,
    totalCost: totalCost,
    hourlyRate: rate,
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

/* ── UI: breakdown table for one audit type ──────────────────────────────────────────────── */
function _auditEstBreakdownTableHTML(b, titleText) {
  if (!b) {
    return '<div style="padding:12px;color:var(--text3);font-size:12px">No Equipment Matrix data — import a BAS point list on the Equipment tab first.</div>';
  }
  var rowsHTML = b.rows
    .map(function (r) {
      return (
        '<tr>' +
        '<td class="ch-tbl-col-type-label">' +
        _auditEstEsc(r.label) +
        '</td>' +
        '<td class="ch-tbl-col-type-number">' +
        r.count +
        '</td>' +
        '<td class="ch-tbl-col-type-number">' +
        r.avgPoints +
        '</td>' +
        '<td class="ch-tbl-col-type-number">' +
        r.hoursEach.toFixed(2) +
        '</td>' +
        '<td class="ch-tbl-col-type-number">' +
        r.hours.toFixed(1) +
        '</td>' +
        '<td class="ch-tbl-col-type-currency">' +
        _auditEstFmt(r.cost) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  var extraRowsHTML = b.extras
    .map(function (x) {
      return (
        '<tr>' +
        '<td class="ch-tbl-col-type-label">' +
        _auditEstEsc(x.label) +
        '</td>' +
        '<td class="ch-tbl-col-type-number">' +
        b.buildingCount +
        ' buildings</td>' +
        '<td class="ch-tbl-col-type-number">—</td>' +
        '<td class="ch-tbl-col-type-number">—</td>' +
        '<td class="ch-tbl-col-type-number">' +
        x.hours.toFixed(1) +
        '</td>' +
        '<td class="ch-tbl-col-type-currency">' +
        _auditEstFmt(x.cost) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  return (
    '<div style="flex:1;min-width:320px">' +
    '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px">' +
    _auditEstEsc(titleText) +
    '</div>' +
    // No inner overflow:auto here (ui-standards.md "one scroll region per panel") — the
    // outer flex-shrink:0 wrap (app/pricing-estimator.js's initCostEstimateTab patch) is the
    // ONE scroll region for the whole Audit Estimate section; nesting a second overflow:auto
    // scroll box around just the table rows made the totals row/buttons unreachable by
    // scrolling the outer wrap (caught in headless verification, 2026-09-25).
    '<div class="ch-tbl-outer">' +
    '<table class="ch-tbl" style="width:100%">' +
    '<thead><tr>' +
    '<th>Equipment Type</th><th>Count</th><th>Average Points</th><th>Hours Each</th><th>Hours</th><th>Cost</th>' +
    '</tr></thead>' +
    '<tbody>' +
    rowsHTML +
    '<tr><td class="ch-tbl-col-type-label">Site Visit &amp; Travel</td><td class="ch-tbl-col-type-number">' +
    b.buildingCount +
    ' buildings</td><td class="ch-tbl-col-type-number">—</td><td class="ch-tbl-col-type-number">—</td>' +
    '<td class="ch-tbl-col-type-number">' +
    b.buildingLineHours.toFixed(1) +
    '</td><td class="ch-tbl-col-type-currency">' +
    _auditEstFmt(b.buildingLineCost) +
    '</td></tr>' +
    extraRowsHTML +
    '<tr><td class="ch-tbl-col-type-label">Report &amp; Analysis</td><td class="ch-tbl-col-type-number">—</td>' +
    '<td class="ch-tbl-col-type-number">—</td><td class="ch-tbl-col-type-number">—</td>' +
    '<td class="ch-tbl-col-type-number">' +
    b.reportHours.toFixed(1) +
    '</td><td class="ch-tbl-col-type-currency">' +
    _auditEstFmt(b.reportCost) +
    '</td></tr>' +
    '</tbody>' +
    '<tfoot><tr>' +
    '<td>Total</td><td>—</td><td>—</td><td>—</td>' +
    '<td class="ch-tbl-col-type-number">' +
    b.totalHours.toFixed(1) +
    '</td><td class="ch-tbl-col-type-currency">' +
    _auditEstFmt(b.totalCost) +
    '</td>' +
    '</tr></tfoot>' +
    '</table></div></div>'
  );
}

/* ── UI: editable assumptions table ──────────────────────────────────────────────────────── */
function _auditEstAssumptionsHTML(projId) {
  var cfg = auditEstGetConfig();
  var rate = auditEstGetHourlyRate();
  var rows = AUDIT_EST_CATEGORIES.map(function (cat) {
    var val = cfg.hoursPerEquip[cat] != null ? cfg.hoursPerEquip[cat] : '';
    var sourced =
      AUDIT_EST_HOURS_PER_EQUIP_DEFAULT[cat] != null &&
      ['vav', 'heater', 'fpb', 'rtu', 'ahu', 'fcu'].indexOf(cat) !== -1;
    return (
      '<tr><td class="ch-tbl-col-type-label">' +
      _auditEstEsc(AUDIT_EST_CAT_LABELS[cat]) +
      '</td><td class="ch-tbl-col-type-number">' +
      '<input type="number" step="0.01" min="0" value="' +
      val +
      '" id="auditEstHrs_' +
      projId +
      '_' +
      cat +
      '" style="width:70px;text-align:right;background:var(--s1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveHours(\'' +
      projId +
      "','" +
      cat +
      '\', this.value)">' +
      '</td><td class="ch-tbl-col-type-label" style="font-size:11px;color:var(--text3)">' +
      (sourced ? 'Optimization Strategy Sheet xlsx' : 'Starting estimate') +
      '</td></tr>'
    );
  }).join('');

  return (
    '<div id="auditEstAssumptions_' +
    projId +
    '" style="display:none;margin-top:10px;padding:12px;background:var(--s1);border:1px solid var(--border);border-radius:6px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">Audit Estimate Assumptions (company-wide — editable, applies to every project)</div>' +
    '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px">' +
    '<div><label style="font-size:11px;color:var(--text3)">Hours per building (site visit and travel)</label><br>' +
    '<input type="number" step="0.25" min="0" value="' +
    cfg.hoursPerBuilding +
    '" id="auditEstBldgHrs_' +
    projId +
    '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
    projId +
    "','hoursPerBuilding', this.value)\"></div>" +
    '<div><label style="font-size:11px;color:var(--text3)">Report and analysis hours (fixed)</label><br>' +
    '<input type="number" step="0.25" min="0" value="' +
    cfg.hoursReport +
    '" id="auditEstRptHrs_' +
    projId +
    '" style="width:80px;text-align:right;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px" onchange="auditEstSaveField(\'' +
    projId +
    "','hoursReport', this.value)\"></div>" +
    '<div><label style="font-size:11px;color:var(--text3)">Labor rate ($/hour, from Cost Estimate)</label><br>' +
    '<div style="font-size:13px;font-weight:700;color:var(--text);padding:3px 0">' +
    _auditEstFmt(rate) +
    '/hour</div></div>' +
    '</div>' +
    '<div style="font-size:12px;font-weight:700;color:var(--text2);margin:10px 0 6px">Hours per equipment type (one walk-through unit)</div>' +
    '<div class="ch-tbl-outer" style="max-width:480px"><table class="ch-tbl" style="width:100%">' +
    '<thead><tr><th>Equipment Type</th><th>Hours</th><th>Source</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></div>' +
    '<div style="font-size:12px;font-weight:700;color:var(--text2);margin:10px 0 6px">Full Facility Audit — additional per-building hours</div>' +
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
    '</div>' +
    '<div style="margin-top:10px"><button onclick="auditEstShowHistory(\'' +
    projId +
    '\')" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer">View Change History (' +
    (cfg.history || []).length +
    ')</button></div>' +
    '</div>'
  );
}

/* ── Main render entry — called from initCostEstimateTab (app/pricing-estimator.js) ────────── */
function auditEstRenderHTML(projId) {
  var basB = auditEstComputeBreakdown(projId, 'bas');
  var fullB = auditEstComputeBreakdown(projId, 'full');
  var excludedNote = '';
  if (basB && basB.excluded && basB.excluded.length) {
    excludedNote =
      '<div style="font-size:11px;color:var(--text3);margin-top:6px">Not counted per unit in either audit (covered as building-level items, or out of scope): ' +
      basB.excluded
        .map(function (x) {
          return _auditEstEsc(x.label) + ' (' + x.count + ')';
        })
        .join(', ') +
      '.</div>';
  }
  return (
    '<div class="ch-panel" style="margin-top:16px;border-top:2px solid var(--border2);padding-top:14px">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">' +
    '<div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--text)">Building Automation System Audit Estimate</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:2px">Estimated hours and cost to run a Building Automation System Audit or a Full Facility Audit on this project, computed from the Equipment Matrix.</div>' +
    '</div>' +
    '<button onclick="auditEstToggleAssumptions(\'' +
    projId +
    '\')" style="font-size:11px;padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer">Edit Assumptions</button>' +
    '</div>' +
    _auditEstAssumptionsHTML(projId) +
    '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:14px">' +
    _auditEstBreakdownTableHTML(basB, 'Building Automation System Audit') +
    _auditEstBreakdownTableHTML(fullB, 'Full Facility Audit') +
    '</div>' +
    excludedNote +
    (basB
      ? '<div style="margin-top:12px;display:flex;gap:8px">' +
        '<button onclick="auditEstGenerateProposal(\'' +
        projId +
        '\',\'bas\')" class="rpt-toolbar-btn" style="font-size:12px;padding:6px 12px;border-radius:4px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer">Generate Building Automation System Audit Proposal</button>' +
        '<button onclick="auditEstGenerateProposal(\'' +
        projId +
        '\',\'full\')" style="font-size:12px;padding:6px 12px;border-radius:4px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer">Generate Full Facility Audit Proposal</button>' +
        '</div>'
      : '') +
    '</div>'
  );
}

function auditEstToggleAssumptions(projId) {
  var el = document.getElementById('auditEstAssumptions_' + projId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function auditEstSaveHours(projId, cat, value) {
  var n = parseFloat(value);
  if (isNaN(n) || n < 0) {
    showToast('Enter a valid number of hours', 'error');
    return;
  }
  auditEstSetConfig('hoursPerEquip.' + cat, n);
  if (typeof initCostEstimateTab === 'function') initCostEstimateTab(projId);
  if (typeof showToast === 'function') showToast('Assumption updated', 'success');
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
