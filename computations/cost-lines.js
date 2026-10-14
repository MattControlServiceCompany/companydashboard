// computations/cost-lines.js - the ONE place a measure's cost lines are totalled and a simple payback is computed
// (Phase 7, 2026-10-14).
//
// A measure of the Energy Savings matrix holds its cost in m.costLines (app data en_projects, savingsData.measures).
// A cost line: { id, kind, label, vendor, hours, amount, note }
//   kind 'thirdParty'  price from a third party (vendor name optional)       amount in $
//   kind 'labor'       internal labor                                         hours x the shared hourly rate
//   kind 'parts'       parts bought by us                                     amount in $
//   kind 'incentive'   incentive or rebate (taken off the cost)               amount in $
// Labor has no stored rate and no stored dollar amount: the rate comes from the pricing estimator config
// (_pricingGetConfig().hourlyRate, app/pricing-estimator.js) when the cost is read.
//
// Savings are NOT computed here. The caller passes the annual savings $ of the Energy Savings matrix
// (calcMeasureDollars, app/energy-savings.js).
//
// simplePayback is the ONLY payback formula in the app: (total cost - incentive) / annual savings $.
// tools/gate-single-payback.js fails on a second one.

const COST_LINE_KINDS = [
  { key: 'thirdParty', label: 'Third-party price' },
  { key: 'labor', label: 'Internal labor' },
  { key: 'parts', label: 'Parts' },
  { key: 'incentive', label: 'Incentive / rebate' },
];

// Lines a template adds with its measure. Hours stay empty: the labor model has no task for this work, so no hours are invented.
const COST_LINE_TEMPLATE_DEFAULTS = {
  fan_savings: [{ kind: 'labor', label: 'Reprogram BAS for variable speed', hours: null }],
};

function _costNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function newCostLine(kind, fields) {
  return Object.assign(
    {
      id: 'cl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: kind,
      label: '',
      vendor: '',
      hours: null,
      amount: null,
      note: '',
    },
    fields || {},
  );
}

function defaultCostLinesFor(templateId) {
  return (COST_LINE_TEMPLATE_DEFAULTS[templateId] || []).map(function (d) {
    return newCostLine(d.kind, d);
  });
}

// Dollars of one line. A labor line is hours x laborRate.
function costLineAmount(line, laborRate) {
  if (line.kind === 'labor') return _costNum(line.hours) * _costNum(laborRate);
  return _costNum(line.amount);
}

// Totals of one measure's lines: { thirdParty, labor, parts, gross, incentive, laborHours, lineCount }.
function measureCostTotals(m, laborRate) {
  const t = { thirdParty: 0, labor: 0, parts: 0, gross: 0, incentive: 0, laborHours: 0, lineCount: 0 };
  ((m && m.costLines) || []).forEach(function (line) {
    const amt = costLineAmount(line, laborRate);
    t.lineCount++;
    if (line.kind === 'incentive') {
      t.incentive += amt;
    } else if (t[line.kind] !== undefined) {
      t[line.kind] += amt;
      t.gross += amt;
      if (line.kind === 'labor') t.laborHours += _costNum(line.hours);
    }
  });
  return t;
}

// Add measure totals into one total (a project roll-up).
function sumCostTotals(list) {
  const t = { thirdParty: 0, labor: 0, parts: 0, gross: 0, incentive: 0, laborHours: 0, lineCount: 0 };
  list.forEach(function (x) {
    Object.keys(t).forEach(function (k) {
      t[k] += x[k];
    });
  });
  return t;
}

// THE payback. gross = total cost, incentive = rebate, annual = annual savings $ from the matrix.
// Returns { gross, incentive, net, annual, years }. years is null when there is no cost or no savings to divide by.
function simplePayback(gross, incentive, annual) {
  const g = _costNum(gross);
  const inc = _costNum(incentive);
  const a = _costNum(annual);
  const net = g - inc;
  return { gross: g, incentive: inc, net: net, annual: a, years: g > 0 && a > 0 ? Math.max(0, net) / a : null };
}

// One-time DATA MOVE (2026-10-14), not a reader: a measure saved before the cost lines had two typed fields, implCost (implementation
// cost) and incentive (rebate). This moves them onto the measure as cost lines, then deletes the two old fields. A measure that already has
// cost lines keeps them (the old value is dropped with the field, as the cost lines are the newer entry). Idempotent: with the old fields
// gone, a second run changes nothing. Returns true when it changed the measure. The keys are text so no code reads the retired names.
function moveOldCostFieldsToLines(m) {
  if (!m || typeof m !== 'object') return false;
  const OLD_COST = 'implCost';
  const OLD_INCENTIVE = 'incentive';
  const hasOld = OLD_COST in m || OLD_INCENTIVE in m;
  if (!hasOld) return false;
  const cost = _costNum(m[OLD_COST]);
  const inc = _costNum(m[OLD_INCENTIVE]);
  const hasLines = Array.isArray(m.costLines) && m.costLines.length > 0;
  if (!hasLines) {
    const lines = [];
    if (cost > 0) lines.push(newCostLine('thirdParty', { label: 'Implementation cost (moved from old field)', amount: cost }));
    if (inc > 0) lines.push(newCostLine('incentive', { label: 'Incentive / rebate (moved from old field)', amount: inc }));
    if (lines.length) m.costLines = lines;
  }
  delete m[OLD_COST];
  delete m[OLD_INCENTIVE];
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    moveOldCostFieldsToLines,
    COST_LINE_KINDS,
    newCostLine,
    defaultCostLinesFor,
    costLineAmount,
    measureCostTotals,
    sumCostTotals,
    simplePayback,
  };
}
