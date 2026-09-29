// app/report-printed.js — the figures of a presented (printed) report, applied to the updated report.
// A presented period keeps every number the client saw (Matt 2026-09-29). The figures live on the
// presented record (record.printed, computations/savings.js). This file has two jobs:
//   _rptPV()                  one printed figure for a cell of a report table, or the current value
//                             when the document did not print that cell;
//   rptApplyPrintedToData(d)  copies printed figures into the report data object so that every page
//                             that reads those fields shows the printed value.
// No figure is derived here. A cell with no printed source keeps the current math.
// Depends on: computations/savings.js (getPresentedPrintedValue).

// Printed value of one cell. row = building id or the printed row label; commodity and month may be ''.
function _rptPV(d, section, row, commodity, month, column, fallback) {
  var v = d && d.printed ? getPresentedPrintedValue(d.printed, section, row, commodity, month, column) : undefined;
  return v === undefined ? fallback : v;
}

// Printed number only (text and missing cells return the fallback).
function _rptPVn(d, section, row, commodity, month, column, fallback) {
  var v = _rptPV(d, section, row, commodity, month, column, undefined);
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

var _RPT_PRINTED_STATUS = { 'On Track': 'on_track', 'Near Target': 'near_target', 'Below Target': 'below_target' };

function rptApplyPrintedToData(d) {
  if (!d || !d.printed) return d;
  var pn = function (s, r, c, m, col, fb) {
    return _rptPVn(d, s, r, c, m, col, fb);
  };
  var q = d.period && d.period.quarter ? d.period.quarter : 1;
  var starRows = (d.buildings || []).some(function (b) {
    return _rptPV(d, 'key findings', b.id, '', '', 'energy_star', undefined) !== undefined;
  });
  (d.buildings || []).forEach(function (b) {
    var id = b.id;
    ['building table', 'building status'].forEach(function (sec) {
      b.sqft = pn(sec, id, '', '', 'sqft', b.sqft);
      b.blCost = pn(sec, id, '', '', 'baseline_cost', b.blCost);
      b.curCost = pn(sec, id, '', '', 'actual_cost', b.curCost);
      b.savings = pn(sec, id, '', '', 'savings', b.savings);
      b.savingsPct = pn(sec, id, '', '', 'pct', b.savingsPct);
      var st = _RPT_PRINTED_STATUS[_rptPV(d, sec, id, '', '', 'status', '')];
      if (st) b.status = st;
    });
    b.electric.kwhBl = pn('annual summary', id, '', 'baseline', 'kwh', b.electric.kwhBl);
    b.electric.kwBl = pn('annual summary', id, '', 'baseline', 'kw', b.electric.kwBl);
    b.gas.thermsBl = pn('annual summary', id, '', 'baseline', 'therms', b.gas.thermsBl);
    b.propane.galBl = pn('annual summary', id, '', 'baseline', 'propane_gal', b.propane.galBl);
    b.electric.kwhCur = pn('annual summary', id, '', 'current', 'kwh', b.electric.kwhCur);
    b.electric.kwCur = pn('annual summary', id, '', 'current', 'kw', b.electric.kwCur);
    b.gas.thermsCur = pn('annual summary', id, '', 'current', 'therms', b.gas.thermsCur);
    b.propane.galCur = pn('annual summary', id, '', 'current', 'propane_gal', b.propane.galCur);
    b.eui.baseline = pn('eui rankings', id, '', '', 'baseline_eui', b.eui.baseline);
    b.eui.current = pn('eui rankings', id, '', '', 'current_eui', b.eui.current);
    b.eui.cbecs = pn('eui rankings', id, '', '', 'cbecs', b.eui.cbecs);
    b.eui.costPerSqft = pn('eui rankings', id, '', '', 'cost_per_sqft', b.eui.costPerSqft);
    var pct = _rptPV(d, 'eui rankings', id, '', '', 'percentile', undefined);
    if (typeof pct === 'string') b.eui.percentile = pct;
    if (starRows) b.eui.energyStar = _rptPV(d, 'key findings', id, '', '', 'energy_star', '') === 'Yes';
  });
  var T = 'Total Portfolio';
  var t = d.totals;
  d.project.sqft = pn('building table', T, '', '', 'sqft', d.project.sqft);
  t.savings = pn('building table', T, '', '', 'savings', t.savings);
  t.blCost = pn('building table', T, '', '', 'baseline_cost', t.blCost);
  t.curCost = pn('building table', T, '', '', 'actual_cost', t.curCost);
  t.savingsPct = pn('building table', T, '', '', 'pct', t.savingsPct);
  t.kwhBl = pn('quarterly table', 'quarter', '', '', 'baseline_kwh', t.kwhBl);
  t.kwhCur = pn('quarterly table', 'quarter', '', '', 'actual_kwh', t.kwhCur);
  t.thermsBl = pn('quarterly table', 'quarter', '', '', 'baseline_therms', t.thermsBl);
  t.thermsCur = pn('quarterly table', 'quarter', '', '', 'actual_therms', t.thermsCur);
  t.propaneBl = pn('quarterly table', 'quarter', '', '', 'baseline_gal', t.propaneBl);
  t.propaneCur = pn('quarterly table', 'quarter', '', '', 'actual_gal', t.propaneCur);
  t.peakKwBl = pn('usage summary', 'baseline', '', '', 'peak_kw', t.peakKwBl);
  t.peakKwCur = pn('usage summary', 'current', '', '', 'peak_kw', t.peakKwCur);
  t.euiBaseline = pn('usage summary', 'baseline', '', '', 'site_eui', t.euiBaseline);
  t.euiCurrent = pn('usage summary', 'current', '', '', 'site_eui', t.euiCurrent);
  t.kwhSaved = pn('key findings', 'Portfolio', '', '', 'kwh_avoided', t.kwhSaved);
  t.thermsSaved = pn('key findings', 'Portfolio', '', '', 'therms_reduced', t.thermsSaved);
  var c = d.contract;
  ['q1', 'q2', 'q3', 'q4'].forEach(function (col, i) {
    c.quarterlyTargets[i] = pn('quarterly targets', 'projected', '', '', col, c.quarterlyTargets[i]);
  });
  c.quarterlyTargets[q - 1] = pn('cover', 'Portfolio', '', '', 'q_target', c.quarterlyTargets[q - 1]);
  c.annualTarget = pn('quarterly targets', 'projected', '', '', 'annual', c.annualTarget);
  c.escalation = pn('contract projection', 'Portfolio', '', '', 'escalation_pct', c.escalation);
  var pol = d.pollution;
  var POL = ['co2', 'ch4', 'n2o', 'so2', 'nox', 'hg_oz', 'pm10_oz', 'voc_oz', 'co_oz'];
  var EQ = [
    'carsRemoved',
    'gallonsGasoline',
    'tankerTrucks',
    'barrelsOil',
    'households',
    'treeSeedlings',
    'acresForest',
    'railcarsCoal',
    'tonsRecycled',
    'propaneCylinders',
    'coalPlants',
  ];
  POL.forEach(function (k) {
    pol.pollutants[k] = pn('environmental', 'Portfolio', '', '', k, pol.pollutants[k]);
  });
  EQ.forEach(function (k) {
    pol.equivalents[k] = pn('environmental', 'Portfolio', '', '', k, pol.equivalents[k]);
  });
  ['kwhSaved', 'thermsSaved', 'propaneGalSaved'].forEach(function (k) {
    pol.inputs[k] = pn('environmental', 'Portfolio', '', '', k, pol.inputs[k]);
  });
  return d;
}

// Cell reader for one building + commodity meter table of a presented report, or undefined when
// the document printed no such table. cell(monthYmOrTotal, column) -> printed number/text or undefined.
function rptPrintedMeterCells(d, bldgId, commodity) {
  if (!d || !d.printed) return undefined;
  var prefix = 'meter table|' + bldgId + '|' + commodity + '|';
  var any = Object.keys(d.printed).some(function (k) {
    return k.indexOf(prefix) === 0;
  });
  if (!any) return undefined;
  return function (month, col) {
    return getPresentedPrintedValue(d.printed, 'meter table', bldgId, commodity, month, col);
  };
}
