// -----------------------------------------------------------------------
// report-engine-woodland.js
//
// Baseline + BAS Savings Report (7 logical pages) for ONE building with BAS setpoint
// savings options (A/B/C) stored as savings measures. Self-contained report type
// (data._woodland = true), built entirely on the existing rptPage()/.rpt-page markup so the
// generic exportReportToPDF() / exportReportToDocx() (app/report-engine.js) work with ZERO
// changes. A fourth export surface, exportWoodlandReportToXlsx(), is added here (ExcelJS,
// one sheet per page).
//
// Rebuild (2026-09-22): every page REUSES the site's own components and is sourced from the
// selected building's OWN data — no building-specific constants remain in this file.
//  - Page 3 Baseline Summary = rptBuildBaselineDataTable() (app/report-engine.js), the SAME
//    "Building Baseline Data" table (stats strip incl. Site EUI + monthly grid + Annual row)
//    the standard report's per-building summary page renders, fed by collectReportData()'s
//    b.baselineMaps (the site path).
//  - Page 4 Estimated HVAC = the electric regression's CDD coefficient (Page 2) x monthly CDD
//    (cooling kWh) vs gas energy (heating), presented as a stats strip + monthly table like the
//    site's HVAC Load Estimation tab. Documented fallback when the regression has no CDD term.
//  - Page 5 setpoints = Equipment Matrix rows for this building (emLoadMatrix +
//    emGetNormalizedPoints) as a dense per-zone table; documented one-sentence fallback when the
//    project has no Equipment Matrix rows for the building.
//  - Rates / install cost = the source savings measure's own m.rates (kwhSummer/kwhWinter,
//    kwSummer/kwWinter, gasSummer/gasWinter with thermRate fallback) and m.implCost.
//
// Data sources (read-only, one source feeds all 4 surfaces):
//  - Raw bills:       building.meters[].bills[]   (Electric + Gas meters)
//  - Baseline window: meter.baseline.months (12 'YYYY-MM' strings) / meter._reg (OLS regression)
//  - Weather:         wddLoadCache(building.zip) — {ym, hdd, cdd, avgTemp}[]
//  - Site baseline:   collectReportData(projId, [buildingId]) -> buildings[0].baselineMaps
//  - Savings A/B/C:   project.savingsData.measures[] filtered to this building
//                      (kwh[]=cooling kWh saved, kw[]=demand kW saved, gas[]=heating therms
//                      saved — monthly, Jan..Dec — the BAS savings-model output)
//  - Zone setpoints:  en_eqmatrix_<projId> rows whose building name matches (case-insensitive)
//
// Savings dollar formula (per Coordinator's audit): (quantity saved) x SEASONAL MARGINAL rate,
// monthly, then summed — never a blended rate, never a raw dollar delta. Summer = SUMMER_MOS
// (Jun-Sep, app/energy-savings.js), the same bucket the Energy Savings matrix uses.
// -----------------------------------------------------------------------

var WOODLAND_MO_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
var WOODLAND_MO_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Shared-savings split (Matt, 2026-09-22): the deal structure for this report is a shared-
// savings split, not a capital install-cost-with-payback contract. Default 70% of annual $
// savings to the client, 30% to CSC — a single editable constant, never hardcoded per-option.
// implCost/payback stay on the measure record for other deal types; this report just doesn't
// render them.
var WOODLAND_CLIENT_SHARE_PCT = 70;

function _wdDaysInMonth(ym) {
  var parts = (ym || '').split('-');
  var y = parseInt(parts[0], 10),
    m = parseInt(parts[1], 10);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}
function _wdAssignedYm(bill) {
  var d = bill.end || bill.start || '';
  return (d + '').slice(0, 7);
}
// _wdRoundHalfUp — the ONE rounding convention for every displayed value in this report
// (Calc re-audit, 2026-09-22, defect #3/#8). Plain Math.round()/toFixed() are NOT safe here:
// toFixed() can round a true .xx5 boundary the wrong way when the value's binary float
// representation sits a hair below the boundary (the classic (1.005).toFixed(2) === "1.00"
// bug), and this report multiplies real regression coefficients / rates against real
// quantities, which routinely lands exactly on those boundaries. A small epsilon nudge before
// Math.round() (itself already round-half-up for positive numbers) makes the rounding direction
// depend only on the true decimal value, never on binary-float noise.
function _wdRoundHalfUp(x, dec) {
  var n = parseFloat(x) || 0;
  var f = Math.pow(10, dec || 0);
  var sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * f + 1e-9)) / f;
}
function _wdN(v, dec) {
  var n = _wdRoundHalfUp(v, dec || 0);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: dec || 0,
    maximumFractionDigits: dec || 0,
  });
}
function _wdC(v) {
  var n = _wdRoundHalfUp(v, 2);
  return (
    (n < 0 ? '-$' : '$') +
    Math.abs(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function _wdIsSummer(moIdx) {
  return SUMMER_MOS.indexOf(moIdx) !== -1;
}
// Gas usage field chain — identical to computations/normalization.js getNormRows so Page 1's
// raw bill table and the site path (Page 3) read the same value off the same bill.
function _wdBillTherms(bill) {
  return (
    parseFloat(bill.therms) || parseFloat(bill.naturalGasTherms) || (parseFloat(bill.naturalGasMMbtu) || 0) * 10 || 0
  );
}
// Seasonal marginal rates from a savings measure's own m.rates (the fields the Energy Savings
// matrix stores/edits). gasSummer/gasWinter are additive (2026-09-22): absent or 0 => thermRate,
// which is exactly the matrix's non-seasonal gas behavior.
function _wdSeasonalRates(r) {
  r = r || {};
  var therm = parseFloat(r.thermRate) || 0;
  var gs = parseFloat(r.gasSummer) || 0,
    gw = parseFloat(r.gasWinter) || 0;
  return {
    gasSummer: gs > 0 ? gs : therm,
    gasWinter: gw > 0 ? gw : therm,
    elecEnergySummer: parseFloat(r.kwhSummer) || 0,
    elecEnergyWinter: parseFloat(r.kwhWinter) || 0,
    demandSummer: parseFloat(r.kwSummer) || 0,
    demandWinter: parseFloat(r.kwWinter) || 0,
  };
}

// -----------------------------------------------------------------------
// _rptTotalAvgRow — generic Total + Average row builder (Coordinator constraint 4: every
// table on every page needs BOTH a bold Total row and an Average row; confirmed net-new,
// no existing helper does this — every current report table emits Total only).
// cols: array of {sum:number, dec:number, fmt:'n'|'c'|'text'} — one entry per numeric column,
// in the same left-to-right order as the table's <td> cells (label column excluded). MUST have
// exactly one entry per non-label column, in order — a short array silently shifts every later
// column's total/average left under the wrong header (Calc re-audit defect #1, 2026-09-22).
// Optional per-column fields:
//   avgSum   — a SEPARATE running sum to use for the Average row (divided by n). Use this when
//              the Total row is not a sum at all (e.g. a peak/max) so the Average row can still
//              show the true mean of the monthly values, not (peak / n). Defaults to c.sum.
//   suffix   — text appended after the Total-row value only (e.g. " (peak)"), never the Average.
//   text/avgText — for fmt:'text' columns (e.g. a combined "$X / $Y / $Z" cell that isn't a
//              single number): literal HTML for the Total row (text) and Average row (avgText).
//              avgText defaults to '' if not given (e.g. a genuinely non-averageable column).
// labelText: the leading label cell for the Total row ("TOTAL (Annual)" etc.); the Average row's
// label is always literally "Average".
// nMonths: divisor for the Average row.
// -----------------------------------------------------------------------
function _rptTotalAvgRow(cols, labelText, nMonths) {
  var n = nMonths || 12;
  function fmtCell(c, val) {
    if (c.fmt === 'c') return _wdC(val);
    if (c.fmt === 'text') return c.text || '';
    return _wdN(val, c.dec || 0);
  }
  var totCells = cols
    .map(function (c) {
      if (c.fmt === 'text') return '<td class="rpt-n">' + (c.text || '') + '</td>';
      return '<td class="rpt-n">' + fmtCell(c, c.sum) + (c.suffix || '') + '</td>';
    })
    .join('');
  var avgCells = cols
    .map(function (c) {
      if (c.fmt === 'text') return '<td class="rpt-n">' + (c.avgText || '') + '</td>';
      var basis = c.avgSum != null ? c.avgSum : c.sum;
      return '<td class="rpt-n">' + fmtCell(c, basis / n) + '</td>';
    })
    .join('');
  return (
    '<tr class="rpt-tot"><td>' +
    labelText +
    '</td>' +
    totCells +
    '</tr>' +
    '<tr class="rpt-avg"><td>Average</td>' +
    avgCells +
    '</tr>'
  );
}

// -----------------------------------------------------------------------
// _wdComputeHvacSplit — Page 4 inputs from the building's OWN baseline data.
// coolKwh = sum over the 12 baseline months of (electric regression CDD coefficient x that
// month's CDD), using the SAME 4-decimal coefficient and whole-number CDD Page 2 prints, so a
// reader reproduces every monthly figure from the printed pages. Heating share is on a common
// kBtu basis: gasKbtu / (gasKbtu + coolKwh x 3.412). Fallback (documented): a regression with
// no positive CDD term => coolKwh null; the page states cooling is not separable, no numbers
// are invented.
// -----------------------------------------------------------------------
function _wdComputeHvacSplit(elecBL, gasBL, wxByYm) {
  var out = {
    elecKwh: 0,
    gasTherms: 0,
    slopeCDD: null,
    coolKwh: null,
    coolPct: null,
    heatPct: null,
    coolSharePct: null,
    // Electric heating (2026-09-22, Matt): heating is not only gas. When the electric
    // baseline's dual-OLS regression has a positive HDD term (electric heat/reheat/fan
    // energy), heatKwh = sum(round4(slopeHDD) x round0(HDD)) over the baseline months —
    // independent of whether the cooling/CDD term is present. heatKwhPct is its share of
    // total HVAC load on the same kBtu basis as heatPct/coolSharePct below.
    slopeHDD: null,
    heatKwh: null,
    heatKwhPct: null,
    months: [],
  };
  var gasByYm = {};
  if (gasBL)
    gasBL.rows.forEach(function (r) {
      gasByYm[r.ym] = (gasByYm[r.ym] || 0) + _wdBillTherms(r.bill);
      out.gasTherms += _wdBillTherms(r.bill);
    });
  if (!elecBL) return out;
  var kwhByYm = {};
  elecBL.rows.forEach(function (r) {
    var k = parseFloat(r.bill.kwh) || 0;
    kwhByYm[r.ym] = (kwhByYm[r.ym] || 0) + k;
    out.elecKwh += k;
  });
  var rc = elecBL.regrCoeffs;

  // Electric heating share — computed first, independent of the cooling/CDD branch below,
  // so it still renders even on a building whose regression has no usable CDD term.
  var heatKwh = null;
  if (rc && rc.type === 'dual' && rc.slopeHDD != null && rc.slopeHDD > 0) {
    var slopeHDD4 = _wdRoundHalfUp(rc.slopeHDD, 4);
    var heat = 0;
    elecBL.months.forEach(function (ym) {
      var wxh = (wxByYm && wxByYm[ym]) || { hdd: 0 };
      var hddR = _wdRoundHalfUp(wxh.hdd || 0, 0);
      heat += _wdRoundHalfUp(slopeHDD4 * hddR, 0);
    });
    out.slopeHDD = slopeHDD4;
    out.heatKwh = heat;
    heatKwh = heat;
  }

  var slope = null;
  if (rc && rc.type === 'dual' && rc.slopeCDD != null) slope = rc.slopeCDD;
  else if (rc && rc.type === 'cdd' && rc.slope != null) slope = rc.slope;
  var slope4 = slope != null ? _wdRoundHalfUp(slope, 4) : null;
  if (slope4 == null || slope4 <= 0) {
    // No usable cooling term — still report the electric-heating share (on gas+elec-heat basis)
    // if we found one above, since it doesn't depend on cooling being separable.
    if (heatKwh != null) {
      var gasKbtuNoCool = out.gasTherms * 100;
      var heatKbtuNoCool = heatKwh * 3.412;
      out.heatKwhPct =
        gasKbtuNoCool + heatKbtuNoCool > 0
          ? _wdRoundHalfUp((heatKbtuNoCool / (gasKbtuNoCool + heatKbtuNoCool)) * 100, 1)
          : null;
    }
    return out;
  }
  out.slopeCDD = slope4;
  var cool = 0;
  elecBL.months.forEach(function (ym) {
    var wx = (wxByYm && wxByYm[ym]) || { cdd: 0 };
    var cddR = _wdRoundHalfUp(wx.cdd || 0, 0);
    var c = _wdRoundHalfUp(slope4 * cddR, 0);
    var actual = _wdRoundHalfUp(kwhByYm[ym] || 0, 0);
    cool += c;
    out.months.push({
      ym: ym,
      cdd: cddR,
      coolKwh: c,
      actualKwh: actual,
      otherKwh: Math.max(0, actual - c),
      therms: _wdRoundHalfUp(gasByYm[ym] || 0, 1),
    });
  });
  out.coolKwh = cool;
  out.coolPct = out.elecKwh > 0 ? _wdRoundHalfUp((cool / out.elecKwh) * 100, 1) : null;
  // Total HVAC load on one kBtu basis: gas heating + electric heating (when present) + cooling.
  // heatPct/coolSharePct/heatKwhPct all share this same denominator so the three shown shares
  // sum to 100% of HVAC load — never invented, always the printed Therms/kWh x their kBtu factor.
  var gasKbtu = out.gasTherms * 100;
  var coolKbtu = cool * 3.412;
  var heatKbtu = (heatKwh || 0) * 3.412;
  var totalHvacKbtu = gasKbtu + coolKbtu + heatKbtu;
  out.heatPct = totalHvacKbtu > 0 ? _wdRoundHalfUp((gasKbtu / totalHvacKbtu) * 100, 1) : null;
  out.coolSharePct = totalHvacKbtu > 0 ? _wdRoundHalfUp((coolKbtu / totalHvacKbtu) * 100, 1) : null;
  out.heatKwhPct = heatKwh != null && totalHvacKbtu > 0 ? _wdRoundHalfUp((heatKbtu / totalHvacKbtu) * 100, 1) : null;
  return out;
}

// -----------------------------------------------------------------------
// _wdLoadZoneSetpoints — Page 5 per-zone current setpoints from the Equipment Matrix.
// Rows are joined to the building by case-insensitive name match on row.building. Zone-type
// categories mirror emComputeBuildingZoneStats (vav/fpb/ddvav/fcu, plus single-zone ahu/rtu
// rows that expose an occupied zone setpoint). Setpoints come from emGetNormalizedPoints(row)
// — the same resolver every Equipment Matrix view uses. Returns [] when the project has no
// matrix rows for this building (the page then renders its documented fallback sentence).
// -----------------------------------------------------------------------
function _wdLoadZoneSetpoints(projId, bldgName) {
  if (typeof emLoadMatrix !== 'function' || typeof emGetNormalizedPoints !== 'function') return [];
  var em = emLoadMatrix(projId);
  if (!em || !em.rows || !em.rows.length) return [];
  var want = (bldgName || '').trim().toLowerCase();
  if (!want) return [];
  if (typeof window !== 'undefined') window._emActivePid = projId;
  var zoneCats = { vav: true, fpb: true, ddvav: true, fcu: true, zone: true };
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  var zones = [];
  em.rows.forEach(function (row) {
    if (!row || (row.building || '').trim().toLowerCase() !== want) return;
    var pts = emGetNormalizedPoints(row) || {};
    var occHeat = num(pts.zoneHtgSetpoint),
      occCool = num(pts.zoneCoolSetpoint);
    if (!zoneCats[row.category]) {
      if (row.category !== 'ahu' && row.category !== 'rtu') return;
      if (occHeat == null && occCool == null) return; // multizone unit — no zone setpoint
    }
    zones.push({
      zone: row.equipName || row.name || '(unnamed)',
      occHeat: occHeat,
      occCool: occCool,
      unoccHeat: num(pts.zoneUnoccHtgSetpoint),
      unoccCool: num(pts.zoneUnoccCoolSetpoint),
      complete: occHeat != null && occCool != null,
    });
  });
  zones.sort(function (a, c) {
    return a.zone < c.zone ? -1 : a.zone > c.zone ? 1 : 0;
  });
  return zones;
}

// -----------------------------------------------------------------------
// collectWoodlandReportData(projId, buildingId)
// -----------------------------------------------------------------------
function collectWoodlandReportData(projId, buildingId) {
  var p = projects.find(function (x) {
    return x.id === projId;
  });
  if (!p) return null;
  var b = getUDBldg(projId, buildingId);
  if (!b) return null;

  var elecMeter = (b.meters || []).find(function (m) {
    return m.commodity === 'Electric';
  });
  var gasMeter = (b.meters || []).find(function (m) {
    return m.commodity === 'Gas';
  });

  function buildMeterBaseline(m) {
    if (!m || !m.baseline || !m.baseline.months || !m.baseline.months.length) return null;
    var months = m.baseline.months.slice().sort();
    var rows = [];
    (m.bills || []).forEach(function (bill) {
      var ym = _wdAssignedYm(bill);
      if (months.indexOf(ym) === -1) return;
      rows.push({ ym: ym, bill: bill });
    });
    rows.sort(function (a, c) {
      return a.ym < c.ym ? -1 : a.ym > c.ym ? 1 : 0;
    });
    var reg = m._reg || (m.baseline && m.baseline.reg) || null;
    var regrCoeffs = null,
      regrType = '—',
      r2 = null;
    if (reg) {
      if (reg.dual && reg.dual.r2 != null) {
        regrCoeffs = {
          type: 'dual',
          intercept: reg.dual.intercept,
          slopeHDD: reg.dual.slopeHDD,
          slopeCDD: reg.dual.slopeCDD,
        };
        regrType = 'OLS / HDD + CDD (dual)';
        r2 = reg.dual.r2;
      } else if (m.commodity === 'Electric' && reg.cdd && reg.cdd.r2 != null) {
        regrCoeffs = {
          type: 'cdd',
          intercept: reg.cdd.intercept,
          slope: reg.cdd.slope,
        };
        regrType = 'OLS / CDD';
        r2 = reg.cdd.r2;
      } else if (reg.hdd && reg.hdd.r2 != null) {
        regrCoeffs = {
          type: 'hdd',
          intercept: reg.hdd.intercept,
          slope: reg.hdd.slope,
        };
        regrType = 'OLS / HDD';
        r2 = reg.hdd.r2;
      }
    }
    return {
      months: months,
      rows: rows,
      regrCoeffs: regrCoeffs,
      regrType: regrType,
      r2: r2,
    };
  }

  var elecBL = buildMeterBaseline(elecMeter);
  var gasBL = buildMeterBaseline(gasMeter);

  // Weather (HDD/CDD) by 'YYYY-MM', looked up by the building's own zip.
  var wxByYm = {};
  if (b.zip && typeof wddLoadCache === 'function') {
    (wddLoadCache(b.zip) || []).forEach(function (r) {
      wxByYm[r.ym] = r;
    });
  }

  // ---- Savings measures A/B/C (already-computed BAS savings-model output; see file header) ----
  var sd = (p.savingsData && p.savingsData.measures) || [];
  var bldgMeasures = sd.filter(function (m) {
    return m.bldgId === b.id;
  });
  var OPT_RE = /Option\s+([A-C])\s+(\d+)\s*\/\s*(\d+)/i;
  var options = bldgMeasures
    .map(function (m) {
      var mm = OPT_RE.exec(m.desc || '');
      return {
        id: m.id,
        letter: mm ? mm[1].toUpperCase() : '?',
        heatSP: mm ? parseInt(mm[2], 10) : null,
        coolSP: mm ? parseInt(mm[3], 10) : null,
        desc: m.desc || '',
        kwh: (m.kwh || []).slice(), // cooling kWh saved, Jan..Dec
        kw: (m.kw || []).slice(), // demand kW saved, Jan..Dec
        gas: (m.gas || []).slice(), // heating therms saved (net), Jan..Dec
        rates: _wdSeasonalRates(m.rates), // the measure's OWN stored rates (Energy Savings matrix)
        implCost: parseFloat(m.implCost) || 0, // the measure's OWN Implementation Cost field
      };
    })
    .sort(function (a, c) {
      return a.letter < c.letter ? -1 : a.letter > c.letter ? 1 : 0;
    });

  // Dollarize each option with SEASONAL MARGINAL rates, monthly then summed (never blended,
  // never a raw dollar delta) — the audit-corrected formula.
  //
  // Rounding methodology (Calc re-audit, 2026-09-22, defect #8 — Matt's hard reproducibility
  // rule): every monthly $ component is rounded to the CENT (round-half-up) immediately, and
  // every larger figure (a row's Total $, a column's annual Total, the report-wide annual $
  // saved) is built by SUMMING those already-rounded cents values, never by rounding a
  // full-precision sum once at the end. Concretely:
  //   monthly total$  = round(gas$) + round(elec$) + round(dem$)         [row cross-foots]
  //   annual Gas/Elec/Dem$ = sum of the 12 (already-rounded) monthly components
  //   annual Total$   = sum of the 12 (already-rounded) monthly total$ values
  // A reader who takes the PRINTED monthly Gas $/Elec $/Demand $ cells and adds them by hand
  // reaches the PRINTED Total $ cell every time, and summing the 12 printed Total $ cells
  // reaches the PRINTED annual total every time — by construction, not by coincidence.
  options.forEach(function (o) {
    var R = o.rates;
    var monthly = [];
    var totGas = 0,
      totElec = 0,
      totDem = 0,
      totAll = 0;
    for (var i = 0; i < 12; i++) {
      var summer = _wdIsSummer(i);
      var gasR = summer ? R.gasSummer : R.gasWinter;
      var elecR = summer ? R.elecEnergySummer : R.elecEnergyWinter;
      var demR = summer ? R.demandSummer : R.demandWinter;
      var gas$ = _wdRoundHalfUp((o.gas[i] || 0) * gasR, 2);
      var elec$ = _wdRoundHalfUp((o.kwh[i] || 0) * elecR, 2);
      var dem$ = _wdRoundHalfUp((o.kw[i] || 0) * demR, 2);
      var total$ = _wdRoundHalfUp(gas$ + elec$ + dem$, 2);
      monthly.push({
        gas$: gas$,
        elec$: elec$,
        dem$: dem$,
        total$: total$,
        summer: summer,
      });
      totGas += gas$;
      totElec += elec$;
      totDem += dem$;
      totAll += total$;
    }
    o.monthly = monthly;
    o.annualGas$ = _wdRoundHalfUp(totGas, 2);
    o.annualElec$ = _wdRoundHalfUp(totElec, 2);
    o.annualDem$ = _wdRoundHalfUp(totDem, 2);
    o.annualTotal$ = _wdRoundHalfUp(totAll, 2);
    o.installCost = o.implCost;
    // Payback only when the measure carries an Implementation Cost — never invented. Kept on
    // the record (implCost stays a measure field for other deal types) but NOT rendered by this
    // report — see WOODLAND_CLIENT_SHARE_PCT / clientShare$ / cscShare$ below.
    o.paybackYrs = o.installCost > 0 && o.annualTotal$ > 0 ? _wdRoundHalfUp(o.installCost / o.annualTotal$, 2) : null;
    // Shared-savings split — client share rounds to the cent, CSC share is the remainder so the
    // two always cross-foot to annualTotal$ exactly (never two independent roundings).
    o.clientShare$ = _wdRoundHalfUp(o.annualTotal$ * (WOODLAND_CLIENT_SHARE_PCT / 100), 2);
    o.cscShare$ = _wdRoundHalfUp(o.annualTotal$ - o.clientShare$, 2);
    o.annualCoolKwh = o.kwh.reduce(function (s, v) {
      return s + (v || 0);
    }, 0);
    o.annualHeatTherms = o.gas.reduce(function (s, v) {
      return s + (v || 0);
    }, 0);
    o.peakDemandKw = Math.max.apply(
      null,
      o.kw.map(function (v) {
        return v || 0;
      }),
    );
  });

  // ---- Site path (Page 3): the SAME per-building record + baselineMaps the standard
  // report's per-building summary page renders from. ----
  var siteBuilding = null;
  if (typeof collectReportData === 'function') {
    var site = collectReportData(projId, [String(b.id)], null, 'annual', undefined);
    if (site && site.buildings)
      siteBuilding =
        site.buildings.find(function (x) {
          return x.id === b.id;
        }) ||
        site.buildings.find(function (x) {
          return x.name === b.name;
        }) ||
        null;
  }
  function _mapHas(map, field) {
    return Object.values(map || {}).some(function (v) {
      return v && v[field] > 0;
    });
  }
  var bm = (siteBuilding && siteBuilding.baselineMaps) || {};
  var baselineHas = {
    electric: _mapHas(bm.elecByMo, 'kwh'),
    gas: _mapHas(bm.gasByMo, 'therms'),
    propane: _mapHas(bm.propaneByMo, 'gallons'),
  };

  // ---- Page 4 / Page 5 inputs ----
  var hvac = _wdComputeHvacSplit(elecBL, gasBL, wxByYm);
  var zones = _wdLoadZoneSetpoints(projId, b.name);

  // Every page's header (.rpt-info, via rptPage()) reads data.project.client — the building
  // name alone (not district + building) so the fixed-height header bar stays one line.
  return {
    project: {
      id: p.id,
      name: p.name,
      client: b.name || p.client || p.name || '',
    },
    building: {
      id: b.id,
      name: b.name,
      addr: b.addr || '',
      zip: b.zip || '',
      sqft: parseFloat(b.sqft) || (bldgMeasures[0] && bldgMeasures[0].sqft) || 0,
    },
    elecMeter: elecMeter,
    gasMeter: gasMeter,
    elecBL: elecBL,
    gasBL: gasBL,
    wxByYm: wxByYm,
    options: options,
    siteBuilding: siteBuilding,
    baselineHas: baselineHas,
    hvac: hvac,
    zones: zones,
  };
}

// -----------------------------------------------------------------------
// generateWoodlandReport(projId, buildingId) — UI entry point
// -----------------------------------------------------------------------
function generateWoodlandReport(projId, buildingId) {
  var data = collectWoodlandReportData(projId, buildingId);
  if (!data) {
    showToast('No baseline + savings data found for this building', 'error');
    return;
  }
  if (!data.options.length) {
    showToast('No BAS savings options (A/B/C) found for this building — generate them first', 'error');
    return;
  }
  data._woodland = true;
  window._currentReportData = data;
  var html = _injectPageNumbers(generateWoodlandReportHTML(data));
  showReportOverlay(html, data.building.name + ' — Baseline & BAS Savings Report');
  var xlsxBtn = document.getElementById('rptXlsxBtn');
  if (xlsxBtn) xlsxBtn.style.display = '';
}
window.generateWoodlandReport = generateWoodlandReport;

// -----------------------------------------------------------------------
// generateWoodlandReportHTML(data) — 7 logical pages, numbered sequentially. The BAS Savings
// Calculation page returns a variable number of physical sheets (zone-setpoint pages when the
// Equipment Matrix has rows for this building, then Method, then Per-Month Detail), so page
// numbers are assigned by a running counter rather than literals.
// -----------------------------------------------------------------------
function generateWoodlandReportHTML(data) {
  var n = 1;
  var html = '';
  html += rptPageWoodlandBills(n++, data);
  html += rptPageWoodlandBaseline(n++, data);
  html += rptPageWoodlandSummary(n++, data);
  html += rptPageWoodlandHVAC(n++, data);
  var calc = rptPageWoodlandBASCalc(n, data);
  html += calc.html;
  n += calc.count;
  html += rptPageWoodlandOptions(n++, data);
  html += rptPageWoodlandCharts(n++, data);
  return html;
}
window.generateWoodlandReportHTML = generateWoodlandReportHTML;

// =========================================================================
// PAGE 1 — Raw Utility Data
// Electric shows ENERGY and DEMAND separately — Energy Cost (kWh charges) with its
// energy-only $/kWh, and Demand Cost (kW charges) with its $/kW — the same split the site's
// Building Baseline Data table uses (kW Cost / Energy Cost / $/kWh). Bill fields: kwhCost =
// on/off-peak + ECA + EER + PTS; kwCost (+ facKWCost) = billed-kW + TDC + facilities demand.
// =========================================================================
function rptPageWoodlandBills(n, d) {
  function meterTable(bl, meter, isElec) {
    if (!bl || !bl.rows.length) {
      return '<div class="rpt-su">No baseline bill data found for this meter.</div>';
    }
    // .rpt-table-compact is table-layout:fixed; explicit widths keep every centered header
    // over its right-aligned data (widths sum to 100%).
    var head = isElec
      ? '<tr><th style="width:14%">Month</th><th class="rpt-n" style="width:6%">Days</th><th class="rpt-n" style="width:11%">Billed kWh</th><th class="rpt-n" style="width:12%">Billed kW</th><th class="rpt-n" style="width:11.5%">Energy Cost</th><th class="rpt-n" style="width:11.5%">Demand Cost</th><th class="rpt-n" style="width:12%">Total Cost</th><th class="rpt-n" style="width:11%">Energy $/kWh</th><th class="rpt-n" style="width:11%">Demand $/kW</th></tr>'
      : '<tr><th style="width:19%">Month</th><th class="rpt-n" style="width:8%">Days</th><th class="rpt-n" style="width:22%">Billed Therms</th><th class="rpt-n" style="width:22.5%">Total Cost</th><th class="rpt-n" style="width:28.5%">Effective $/Therm</th></tr>';
    var rowsHtml = '';
    // `sums` MUST have exactly one entry per non-label column, in order (Calc re-audit defect
    // #1). Billed kW's Total cell is the ANNUAL PEAK (max), never a sum (defect #4); `avgSum`
    // keeps the Average row a true mean. The two rate columns' Total cells are the ANNUAL
    // effective rates (annual $ / annual quantity) — a real figure, not a sum of rates.
    var sums = isElec
      ? [
          { sum: 0, dec: 0 }, // Days
          { sum: 0, dec: 0 }, // kWh
          { sum: 0, avgSum: 0, dec: 2, suffix: ' (peak)' }, // kW — Total = MAX, Average = mean
          { sum: 0, dec: 2, fmt: 'c' }, // energy $
          { sum: 0, dec: 2, fmt: 'c' }, // demand $
          { sum: 0, dec: 2, fmt: 'c' }, // total $
          { sum: 0, fmt: 'text', text: '' }, // energy $/kWh (annual effective, filled below)
          { sum: 0, fmt: 'text', text: '' }, // demand $/kW (annual effective, filled below)
        ]
      : [
          { sum: 0, dec: 0 }, // Days
          { sum: 0, dec: 1 }, // Therms
          { sum: 0, dec: 2, fmt: 'c' }, // cost
          { sum: 0, fmt: 'text', text: '' }, // effective $/Therm (annual effective, filled below)
        ];
    bl.rows.forEach(function (r) {
      var bill = r.bill;
      var moIdx = parseInt(r.ym.split('-')[1], 10) - 1;
      var moLabel = WOODLAND_MO_ABBR[moIdx] + ' ' + r.ym.split('-')[0];
      var days = parseFloat(bill.numberOfDays) || _wdDaysInMonth(r.ym);
      var cost = parseFloat(bill.totalCost) || 0;
      sums[0].sum += days;
      if (isElec) {
        var kwh = parseFloat(bill.kwh) || 0;
        var kw = parseFloat(bill.billedKW || bill.demandKW) || 0;
        var energy$ = parseFloat(bill.kwhCost) || 0;
        var demand$ = (parseFloat(bill.kwCost) || 0) + (parseFloat(bill.facKWCost) || 0);
        var effKwh = kwh > 0 && energy$ > 0 ? energy$ / kwh : 0;
        var effKw = kw > 0 && demand$ > 0 ? demand$ / kw : 0;
        sums[1].sum += kwh;
        sums[2].sum = Math.max(sums[2].sum, kw);
        sums[2].avgSum += kw;
        sums[3].sum += energy$;
        sums[4].sum += demand$;
        sums[5].sum += cost;
        rowsHtml +=
          '<tr><td>' +
          moLabel +
          '</td><td class="rpt-n">' +
          days +
          '</td><td class="rpt-n">' +
          _wdN(kwh) +
          '</td><td class="rpt-n">' +
          _wdN(kw, 2) +
          '</td><td class="rpt-n">' +
          (energy$ ? _wdC(energy$) : '—') +
          '</td><td class="rpt-n">' +
          (demand$ ? _wdC(demand$) : '—') +
          '</td><td class="rpt-n">' +
          _wdC(cost) +
          '</td><td class="rpt-n">' +
          (effKwh ? '$' + effKwh.toFixed(4) : '—') +
          '</td><td class="rpt-n">' +
          (effKw ? '$' + effKw.toFixed(2) : '—') +
          '</td></tr>';
      } else {
        var therms = _wdBillTherms(bill);
        var effRateT = therms > 0 ? cost / therms : 0;
        sums[1].sum += therms;
        sums[2].sum += cost;
        rowsHtml +=
          '<tr><td>' +
          moLabel +
          '</td><td class="rpt-n">' +
          days +
          '</td><td class="rpt-n">' +
          _wdN(therms, 1) +
          '</td><td class="rpt-n">' +
          _wdC(cost) +
          '</td><td class="rpt-n">' +
          (effRateT ? '$' + effRateT.toFixed(4) : '—') +
          '</td></tr>';
      }
    });
    if (isElec) {
      sums[6].text = sums[1].sum > 0 && sums[3].sum > 0 ? '$' + (sums[3].sum / sums[1].sum).toFixed(4) : '—';
      sums[7].text = sums[2].avgSum > 0 && sums[4].sum > 0 ? '$' + (sums[4].sum / sums[2].avgSum).toFixed(2) : '—';
    } else {
      sums[3].text = sums[1].sum > 0 ? '$' + (sums[2].sum / sums[1].sum).toFixed(4) : '—';
    }
    var totAvg = _rptTotalAvgRow(sums, 'TOTAL (Annual)', bl.rows.length || 1);
    return (
      '<table class="rpt-table rpt-table-compact rpt-mp-dense"><thead>' +
      head +
      '</thead><tbody>' +
      rowsHtml +
      totAvg +
      '</tbody></table>'
    );
  }

  var body =
    '<div class="rpt-su">The building\'s utility use and cost for the 12-month baseline period, ' +
    (d.elecBL
      ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[0].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[0].split('-')[0]
      : '—') +
    ' through ' +
    (d.elecBL
      ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[11].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[11].split('-')[0]
      : '—') +
    '. Electric cost is shown separately for energy (kilowatt-hours) and demand (peak kilowatts), with the effective rate for each. Natural gas is shown in therms with its effective rate.</div>' +
    '<h2>Electric — ' +
    (d.elecMeter ? 'Account ' + (d.elecMeter.account || '—') : 'No electric meter') +
    '</h2>' +
    meterTable(d.elecBL, d.elecMeter, true) +
    '<h2>Natural Gas — ' +
    (d.gasMeter ? 'Account ' + (d.gasMeter.account || '—') : 'No gas meter') +
    '</h2>' +
    meterTable(d.gasBL, d.gasMeter, false);

  return rptPage(n, 'Raw Utility Bill Data', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 2 — Baseline Selection + Weather Normalization
// =========================================================================
function rptPageWoodlandBaseline(n, d) {
  var bl = d.elecBL;
  var body = '';
  body +=
    '<div class="rpt-su">The 12-month baseline period for this building is ' +
    (bl ? WOODLAND_MO_FULL[parseInt(bl.months[0].split('-')[1], 10) - 1] + ' ' + bl.months[0].split('-')[0] : '—') +
    ' through ' +
    (bl ? WOODLAND_MO_FULL[parseInt(bl.months[11].split('-')[1], 10) - 1] + ' ' + bl.months[11].split('-')[0] : '—') +
    ", the most recent full year of billing available. Each month's expected electric use is adjusted for that month's actual heating degree days (HDD) and cooling degree days (CDD), so the baseline reflects typical weather rather than one specific year's conditions.</div>";

  if (bl && bl.regrCoeffs) {
    var rc = bl.regrCoeffs;
    // Calc re-audit defect #3 (2026-09-22): the regression coefficients are rounded to 4
    // decimals ONCE, here, and that SAME rounded value is used for the equation box, every
    // row's Calculation cell, AND the actual Predicted-kWh arithmetic below — previously the
    // equation box showed 4dp, the per-row Calculation cell independently re-rounded to 2dp,
    // and the real math used the full, unrounded coefficient, so a reader plugging the PRINTED
    // (4dp) coefficients into the PRINTED formula got a different Predicted kWh than what was
    // printed (March 2026: reader's 57,484.51 → rounds to 57,485; printed value was 57,484,
    // computed from a hidden, more-precise intercept/slope). Rounding the coefficient to the
    // printed precision before using it for the calculation makes the printed formula the
    // ACTUAL formula — no hidden precision anywhere.
    var rc4 = {
      type: rc.type,
      intercept: _wdRoundHalfUp(rc.intercept, 4),
      slopeHDD: rc.slopeHDD != null ? _wdRoundHalfUp(rc.slopeHDD, 4) : null,
      slopeCDD: rc.slopeCDD != null ? _wdRoundHalfUp(rc.slopeCDD, 4) : null,
      slope: rc.slope != null ? _wdRoundHalfUp(rc.slope, 4) : null,
    };
    var eqn = 'Electric kWh = ' + rc4.intercept.toFixed(4) + ' × Days';
    if (rc4.type === 'dual') eqn += ' + ' + rc4.slopeHDD.toFixed(4) + ' × HDD + ' + rc4.slopeCDD.toFixed(4) + ' × CDD';
    else if (rc4.type === 'hdd') eqn += ' + ' + rc4.slope.toFixed(4) + ' × HDD';
    else eqn += ' + ' + rc4.slope.toFixed(4) + ' × CDD';

    body +=
      '<h2>Electric Regression Model (' +
      bl.regrType +
      ', R² = ' +
      bl.r2.toFixed(3) +
      ')</h2>' +
      '<div style="font-family:var(--rpt-mono);font-size:11px;background:var(--rpt-code-bg);border:1px solid var(--rpt-code-border);border-radius:3px;padding:5px 8px;margin:2px 0 8px;color:var(--rpt-code-text)">' +
      eqn +
      '</div>';

    var rows = '';
    // Calc re-audit defect #1 (2026-09-22): 6 non-label columns (Days, HDD, CDD, Calculation,
    // Predicted kWh, Actual kWh) need exactly 6 entries here — this table previously had only 4,
    // silently shifting the HDD total under Days, the CDD total under HDD, etc., and never
    // showing a Days total/average at all.
    var sums = [
      { sum: 0, dec: 0 }, // Days
      { sum: 0, dec: 0 }, // HDD
      { sum: 0, dec: 0 }, // CDD
      { sum: 0, fmt: 'text', text: '' }, // Calculation — no meaningful total/average
      { sum: 0, dec: 0 }, // Predicted kWh
      { sum: 0, dec: 0 }, // Actual kWh
    ];
    bl.months.forEach(function (ym) {
      var moIdx = parseInt(ym.split('-')[1], 10) - 1;
      var moLabel = WOODLAND_MO_FULL[moIdx] + ' ' + ym.split('-')[0];
      var days = _wdDaysInMonth(ym);
      var wx = d.wxByYm[ym] || { hdd: 0, cdd: 0 };
      var hddR = _wdRoundHalfUp(wx.hdd || 0, 0);
      var cddR = _wdRoundHalfUp(wx.cdd || 0, 0);
      // Use the SAME rounded HDD/CDD shown in the row for the actual arithmetic too, for the
      // same reproducibility reason the coefficients are pre-rounded above.
      var predicted = rc4.intercept * days;
      var calc = rc4.intercept.toFixed(4) + '×' + days;
      if (rc4.type === 'dual') {
        predicted += rc4.slopeHDD * hddR + rc4.slopeCDD * cddR;
        calc += ' + ' + rc4.slopeHDD.toFixed(4) + '×' + hddR + ' + ' + rc4.slopeCDD.toFixed(4) + '×' + cddR;
      } else if (rc4.type === 'hdd') {
        predicted += rc4.slope * hddR;
        calc += ' + ' + rc4.slope.toFixed(4) + '×' + hddR;
      } else {
        predicted += rc4.slope * cddR;
        calc += ' + ' + rc4.slope.toFixed(4) + '×' + cddR;
      }
      predicted = _wdRoundHalfUp(Math.max(0, predicted), 0);
      var row = bl.rows.find(function (r) {
        return r.ym === ym;
      });
      var actual = _wdRoundHalfUp(row ? parseFloat(row.bill.kwh) || 0 : 0, 0);
      sums[0].sum += days;
      sums[1].sum += hddR;
      sums[2].sum += cddR;
      sums[4].sum += predicted;
      sums[5].sum += actual;
      rows +=
        '<tr><td>' +
        moLabel +
        '</td><td class="rpt-n">' +
        days +
        '</td><td class="rpt-n">' +
        hddR +
        '</td><td class="rpt-n">' +
        cddR +
        '</td><td style="font-family:var(--rpt-mono);font-size:9px">' +
        calc +
        '</td><td class="rpt-n">' +
        _wdN(predicted) +
        '</td><td class="rpt-n">' +
        _wdN(actual) +
        '</td></tr>';
    });
    body +=
      '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr><th style="width:14%">Month</th><th class="rpt-n" style="width:6%">Days</th><th class="rpt-n" style="width:8%">HDD</th><th class="rpt-n" style="width:8%">CDD</th><th style="width:38%">Calculation</th><th class="rpt-n" style="width:13%">Predicted kWh</th><th class="rpt-n" style="width:13%">Actual kWh</th></tr></thead><tbody>' +
      rows +
      _rptTotalAvgRow(sums, 'TOTAL (Annual)', bl.months.length || 1) +
      '</tbody></table>';
  }

  body +=
    '<h2>Natural Gas Baseline</h2>' +
    '<div class="rpt-su">Natural gas is billed under a Trigger-Fixed / Index (FOM) / SWE commodity structure (Wood River Energy), driven by the monthly price index rather than weather. The gas baseline is this building\'s 12 billed therm totals for the period, with no weather adjustment applied.</div>';

  return rptPage(n, 'Baseline Selection & Weather Normalization', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 3 — Baseline Summary
// REUSES rptBuildBaselineDataTable() (app/report-engine.js) — the site's own "Building
// Baseline Data" table from the standard report's per-building summary page: stats strip
// (Square Feet, Electric Use/SF, Utility Cost/SF, Avg Electric Rate, Avg Gas Rate, Site EUI,
// Total Annual Utility Cost) + Jan-Dec grid with Electric (kWh, Actual kW, Billed kW, kW Cost,
// Energy Cost, Electric Cost, $/kWh), Gas (Therms, Gas Cost, $/Therm) and Total Cost columns +
// the Annual row (kW columns = 12-month average, the site's convention). Sourced from
// collectReportData()'s b.baselineMaps — the same aggregation every other site view uses —
// never a second, parallel re-summation of raw bills.
// =========================================================================
function rptPageWoodlandSummary(n, d) {
  var start = d.elecBL
    ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[0].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[0].split('-')[0]
    : '—';
  var end = d.elecBL
    ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[11].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[11].split('-')[0]
    : '—';
  var body =
    '<div class="rpt-su">A 12-month summary of the building\'s energy use, peak demand, and cost for the baseline period (' +
    start +
    ' – ' +
    end +
    "). Monthly electric use, gas use, and demand are the billed values for each month; the annual demand figure is the period's peak, not a sum or average. Electric energy and demand costs are shown separately with their own rates, and the summary includes Site Energy Use Intensity (EUI, in kBtu per square foot per year) for benchmarking.</div>";
  var tbl = d.siteBuilding
    ? rptBuildBaselineDataTable(d.siteBuilding, { project: d.project, reportOptions: null }, { has: d.baselineHas })
    : '';
  body += tbl || '<div class="rpt-su">No baseline month data is available for this building.</div>';
  return rptPage(n, 'Baseline Summary', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 4 — Estimated HVAC Cooling and Heating
// Same presentation as the site's HVAC Load Estimation tab: a results strip (annual totals +
// HVAC shares) over a monthly breakdown table. Numbers come from d.hvac (_wdComputeHvacSplit):
// cooling kWh = Page 2's CDD coefficient x monthly CDD; heating share on a common kBtu basis.
// =========================================================================
function rptPageWoodlandHVAC(n, d) {
  var h = d.hvac || {};
  function stat(label, val) {
    return '<div><div class="bl-stat-label">' + label + '</div><div class="bl-stat-val">' + val + '</div></div>';
  }
  var body =
    '<div class="rpt-su">The building\'s heating and cooling loads, estimated from a full year of billing and local weather. Cooling is carried by the electric service and rises with warmer weather; heating is carried by natural gas, with an electric heating contribution shown separately where present. Heating and cooling are compared on one common energy scale (kBtu: Therms × 100, kWh × 3.412) so their relative shares of the building\'s HVAC load can be seen side by side.</div>';

  var stats = [
    stat('Annual Electric Use (kWh)', _wdN(h.elecKwh || 0)),
    stat('Annual Gas Use (Therms)', _wdN(h.gasTherms || 0, 1)),
  ];
  // Heating Therms (gas) — always shown when there's any gas baseline, independent of cooling.
  if (h.gasTherms > 0) stats.push(stat('Heating Energy — Gas (Therms)', _wdN(h.gasTherms, 1)));
  // Heating kWh (electric) — shown only when the electric baseline's regression has a positive
  // HDD term (2026-09-22, Matt: heating is not only gas).
  if (h.heatKwh != null) {
    stats.push(stat('Heating Energy — Elec (kWh)', _wdN(h.heatKwh)));
    if (h.heatKwhPct != null) stats.push(stat('Elec Heating Share of HVAC', h.heatKwhPct.toFixed(1) + '%'));
  }
  if (h.coolKwh != null) {
    stats.push(stat('Estimated Cooling Energy (kWh)', _wdN(h.coolKwh)));
    stats.push(stat('Cooling Share of Electric Use', h.coolPct.toFixed(1) + '%'));
    stats.push(stat('Heating (Gas) Share of HVAC Load', h.heatPct.toFixed(1) + '%'));
    stats.push(stat('Cooling Share of HVAC Load', h.coolSharePct.toFixed(1) + '%'));
  }
  body +=
    '<div style="border:1px solid var(--rpt-page-text);margin:8px 0 10px"><div class="rpt-bl-stats">' +
    stats.join('') +
    '</div></div>';

  if (h.coolKwh == null) {
    body +=
      '<div class="rpt-su">Cooling load could not be separated from this building\'s overall electric use based on a full year of billing and weather data, so no cooling / heating split is shown below. The annual totals above are this building\'s billed baseline values.</div>';
    return rptPage(n, 'Estimated HVAC Cooling & Heating', body, {
      data: { project: d.project },
      letterhead: false,
    });
  }

  var sums = [
    { sum: 0, dec: 0 }, // CDD
    { sum: 0, dec: 0 }, // cooling kWh
    { sum: 0, dec: 0 }, // actual kWh
    { sum: 0, dec: 0 }, // non-cooling kWh
    { sum: 0, dec: 1 }, // therms
  ];
  var rows = '';
  h.months.forEach(function (m) {
    var moIdx = parseInt(m.ym.split('-')[1], 10) - 1;
    sums[0].sum += m.cdd;
    sums[1].sum += m.coolKwh;
    sums[2].sum += m.actualKwh;
    sums[3].sum += m.otherKwh;
    sums[4].sum += m.therms;
    rows +=
      '<tr><td>' +
      WOODLAND_MO_ABBR[moIdx] +
      ' ' +
      m.ym.split('-')[0] +
      '</td><td class="rpt-n">' +
      _wdN(m.cdd) +
      '</td><td class="rpt-n">' +
      _wdN(m.coolKwh) +
      '</td><td class="rpt-n">' +
      _wdN(m.actualKwh) +
      '</td><td class="rpt-n">' +
      _wdN(m.otherKwh) +
      '</td><td class="rpt-n">' +
      _wdN(m.therms, 1) +
      '</td></tr>';
  });
  body +=
    '<h2>Monthly Cooling / Heating Breakdown</h2>' +
    '<table class="rpt-table rpt-table-compact rpt-mp-dense"><thead><tr><th style="width:16%">Month</th><th class="rpt-n" style="width:12%">Cooling Degree Days</th><th class="rpt-n" style="width:18%">Cooling kWh (' +
    h.slopeCDD.toFixed(4) +
    ' × CDD)</th><th class="rpt-n" style="width:18%">Billed kWh</th><th class="rpt-n" style="width:18%">Non-cooling kWh</th><th class="rpt-n" style="width:18%">Gas Therms</th></tr></thead><tbody>' +
    rows +
    _rptTotalAvgRow(sums, 'TOTAL (Annual)', h.months.length || 1) +
    '</tbody></table>' +
    '<div class="rpt-su" style="font-size:10px">HVAC load shares are all on one kBtu basis (Therms × 100, kWh × 3.412), each divided by ' +
    (h.heatKwh != null ? 'gas + electric-heating + cooling' : 'gas + cooling') +
    ' energy: gas heating ' +
    _wdN(h.gasTherms, 1) +
    ' Therms × 100 = ' +
    _wdN(h.gasTherms * 100) +
    ' kBtu' +
    (h.heatKwh != null
      ? '; electric heating ' + _wdN(h.heatKwh) + ' kWh × 3.412 = ' + _wdN(h.heatKwh * 3.412) + ' kBtu'
      : '') +
    '; cooling ' +
    _wdN(h.coolKwh) +
    ' kWh × 3.412 = ' +
    _wdN(h.coolKwh * 3.412) +
    ' kBtu — gas heating share ' +
    h.heatPct.toFixed(1) +
    '%' +
    (h.heatKwhPct != null ? ', electric heating share ' + h.heatKwhPct.toFixed(1) + '%' : '') +
    ', cooling share ' +
    h.coolSharePct.toFixed(1) +
    '%. Non-cooling kWh = billed kWh − cooling kWh (lighting, plug loads, fans, and other year-round use).</div>';

  return rptPage(n, 'Estimated HVAC Cooling & Heating', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 5 — BAS Savings Calculation — Setpoints, Method and Per-Month Detail
// Returns { html, count }: zero or more "Current Zone Setpoints" sheets (Equipment Matrix
// rows for this building, 42 zones per sheet), then the Setpoints & Method sheet, then the
// Per-Month Detail & Result sheet. Callers reserve `count` consecutive page numbers.
// =========================================================================
var WOODLAND_ZONES_PER_PAGE = 42;

function rptPageWoodlandBASCalc(n, d) {
  var optA = d.options[0];
  var zones = d.zones || [];
  var pages = [];
  var pageNo = n;

  function sp(v) {
    return v == null ? '—' : _wdN(v, 0) + '°F';
  }

  // ---- Zone setpoint sheets (only when the Equipment Matrix has rows for this building) ----
  var zoneChunks = [];
  for (var zi = 0; zi < zones.length; zi += WOODLAND_ZONES_PER_PAGE)
    zoneChunks.push(zones.slice(zi, zi + WOODLAND_ZONES_PER_PAGE));
  zoneChunks.forEach(function (chunk, ci) {
    var rows = chunk
      .map(function (z) {
        return (
          '<tr><td>' +
          z.zone +
          '</td><td class="rpt-n">' +
          sp(z.occHeat) +
          '</td><td class="rpt-n">' +
          sp(z.occCool) +
          '</td><td class="rpt-n">' +
          sp(z.unoccHeat) +
          '</td><td class="rpt-n">' +
          sp(z.unoccCool) +
          '</td><td>' +
          (z.complete ? 'Both occupied setpoints found' : 'Occupied setpoint missing') +
          '</td></tr>'
        );
      })
      .join('');
    var complete = chunk.filter(function (z) {
      return z.complete;
    }).length;
    var body =
      '<div class="rpt-su">Current setpoints for each zone in this building (' +
      zones.length +
      ' zones, sheet ' +
      (ci + 1) +
      ' of ' +
      zoneChunks.length +
      '). ' +
      complete +
      ' of ' +
      chunk.length +
      ' zones on this sheet have both occupied setpoints on record.</div>' +
      '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr><th style="width:34%">Zone</th><th class="rpt-n" style="width:12%">Occupied Heating</th><th class="rpt-n" style="width:12%">Occupied Cooling</th><th class="rpt-n" style="width:12%">Unoccupied Heating</th><th class="rpt-n" style="width:12%">Unoccupied Cooling</th><th style="width:18%">Status</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>';
    pages.push(
      rptPage(pageNo++, 'BAS Savings Calculation — Current Zone Setpoints', body, {
        data: { project: d.project },
        letterhead: false,
      }),
    );
  });

  // ---- Setpoints & Method sheet ----
  var body =
    '<div class="rpt-su">The proposed occupied setpoints for each option, the seasonal rates used to value the savings, and the calculation method, worked in full for Option ' +
    (optA ? optA.letter : 'A') +
    ' (' +
    (optA ? optA.heatSP + '°F / ' + optA.coolSP + '°F' : '') +
    ') in the section that follows.</div>';
  if (!zones.length) {
    body +=
      '<div class="rpt-su">Zone-level setpoint data is not available for this building; the setpoints below are proposed building-wide targets.</div>';
  } else {
    body +=
      '<div class="rpt-su">Current setpoints for each of the building\'s ' +
      zones.length +
      ' zones are listed on the preceding sheet' +
      (zoneChunks.length > 1 ? 's' : '') +
      '; the targets below apply building-wide.</div>';
  }
  body +=
    '<h2>Proposed Occupied Setpoints by Option</h2>' +
    '<table class="rpt-table rpt-mp-dense"><thead><tr><th>Option</th><th class="rpt-n">Occupied Heating Setpoint</th><th class="rpt-n">Occupied Cooling Setpoint</th></tr></thead><tbody>' +
    d.options
      .map(function (o) {
        return (
          '<tr><td>Option ' +
          o.letter +
          '</td><td class="rpt-n">' +
          sp(o.heatSP) +
          '</td><td class="rpt-n">' +
          sp(o.coolSP) +
          '</td></tr>'
        );
      })
      .join('') +
    '</tbody></table>';
  if (optA) {
    var R = optA.rates;
    body +=
      '<h2>Seasonal Marginal Rates (Calibration)</h2>' +
      '<div class="rpt-su" style="font-size:10px">Option ' +
      optA.letter +
      "'s seasonal utility rates are shown below. Savings are valued at the seasonal marginal rate each month, then summed for the year — not a single blended rate.</div>" +
      '<table class="rpt-table rpt-mp-dense"><thead><tr><th>Rate</th><th class="rpt-n">Summer (Jun–Sep)</th><th class="rpt-n">Winter (Oct–May)</th></tr></thead><tbody>' +
      '<tr><td>Natural gas ($/Therm)</td><td class="rpt-n">$' +
      R.gasSummer.toFixed(3) +
      '</td><td class="rpt-n">$' +
      R.gasWinter.toFixed(3) +
      '</td></tr>' +
      '<tr><td>Electric energy ($/kWh)</td><td class="rpt-n">$' +
      R.elecEnergySummer.toFixed(4) +
      '</td><td class="rpt-n">$' +
      R.elecEnergyWinter.toFixed(4) +
      '</td></tr>' +
      '<tr><td>Electric demand ($/kW)</td><td class="rpt-n">$' +
      R.demandSummer.toFixed(3) +
      '</td><td class="rpt-n">$' +
      R.demandWinter.toFixed(3) +
      '</td></tr>' +
      '</tbody></table>';
  }
  pages.push(
    rptPage(pageNo++, 'BAS Savings Calculation — Setpoints & Method', body, {
      data: { project: d.project },
      letterhead: false,
    }),
  );

  // ---- Per-Month Detail & Result sheet ----
  var body2 =
    '<div class="rpt-su" style="font-size:10px;margin-bottom:2px">Basis: a 4% change in HVAC energy per 1°F occupied setpoint shift, applied during occupied hours only (an industry planning range of 3–5% per °F). The monthly heating therms, cooling kWh, and demand kW saved below apply this basis to the building\'s own baseline usage.</div>';
  if (optA) {
    var rows = '';
    // Heat Therms / Cool kWh are shown at 2 decimal places — the SAME precision they're stored
    // at in the measure data (lossless) — so a reader multiplying the shown operand by the shown
    // seasonal rate reproduces the shown $ cell to the penny, and the row's Gas+Elec+Demand $
    // cells (summed left to right, matching mo.total$'s own order) reproduce Total $ Saved.
    var sums = [
      { sum: 0, dec: 2 }, // heat therms
      { sum: 0, dec: 2, fmt: 'c' }, // gas $
      { sum: 0, dec: 2 }, // cool kwh
      { sum: 0, dec: 2, fmt: 'c' }, // elec $
      { sum: 0, dec: 2, fmt: 'c' }, // demand $
      { sum: 0, dec: 2, fmt: 'c' }, // total $
    ];
    for (var i = 0; i < 12; i++) {
      var mo = optA.monthly[i];
      sums[0].sum += optA.gas[i] || 0;
      sums[1].sum += mo.gas$;
      sums[2].sum += optA.kwh[i] || 0;
      sums[3].sum += mo.elec$;
      sums[4].sum += mo.dem$;
      sums[5].sum += mo.total$;
      rows +=
        '<tr><td>' +
        WOODLAND_MO_ABBR[i] +
        (mo.summer ? ' (S)' : ' (W)') +
        '</td>' +
        '<td class="rpt-n">' +
        _wdN(optA.gas[i] || 0, 2) +
        '</td><td class="rpt-n">' +
        _wdC(mo.gas$) +
        '</td>' +
        '<td class="rpt-n">' +
        _wdN(optA.kwh[i] || 0, 2) +
        '</td><td class="rpt-n">' +
        _wdC(mo.elec$) +
        '</td>' +
        '<td class="rpt-n">' +
        _wdC(mo.dem$) +
        '</td><td class="rpt-n" style="font-weight:600">' +
        _wdC(mo.total$) +
        '</td></tr>';
    }
    body2 +=
      '<h2 style="margin:4px 0 2px">Per-Month Calculation Grid — Option ' +
      optA.letter +
      '</h2>' +
      '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr><th style="width:13%">Month (S/W = rate season)</th><th class="rpt-n" style="width:15%">Heat Therms Saved</th><th class="rpt-n" style="width:14%">Gas $ Saved</th><th class="rpt-n" style="width:15%">Cool kWh Saved</th><th class="rpt-n" style="width:15%">Elec Energy $ Saved</th><th class="rpt-n" style="width:14%">Demand $ Saved</th><th class="rpt-n" style="width:14%">Total $ Saved</th></tr></thead><tbody>' +
      rows +
      _rptTotalAvgRow(sums, 'TOTAL (Annual)', optA.monthly.length || 1) +
      '</tbody></table>' +
      '<h2 style="margin:4px 0 2px">Result</h2>' +
      '<table class="rpt-table rpt-mp-dense" style="margin:2px 0"><tbody>' +
      '<tr class="rpt-tot"><td style="padding:2px 6px">Annual $ saved</td><td class="rpt-n" style="padding:2px 6px">' +
      _wdC(optA.annualTotal$) +
      '</td></tr>' +
      '<tr><td style="padding:2px 6px">Client share (' +
      WOODLAND_CLIENT_SHARE_PCT +
      '%)</td><td class="rpt-n" style="padding:2px 6px">' +
      _wdC(optA.clientShare$) +
      '</td></tr>' +
      '<tr class="rpt-tot"><td style="padding:2px 6px">CSC share (' +
      (100 - WOODLAND_CLIENT_SHARE_PCT) +
      '%)</td><td class="rpt-n" style="padding:2px 6px">' +
      _wdC(optA.cscShare$) +
      '</td></tr>' +
      '</tbody></table>' +
      '<div class="rpt-su" style="font-size:10px;margin-top:2px">Shared-savings structure — assumes a ' +
      WOODLAND_CLIENT_SHARE_PCT +
      '% client / ' +
      (100 - WOODLAND_CLIENT_SHARE_PCT) +
      '% CSC split of the annual $ saved (to be confirmed with the client), not an install-cost/payback contract.</div>';
  }
  pages.push(
    rptPage(pageNo++, 'BAS Savings Calculation — Per-Month Detail & Result', body2, {
      data: { project: d.project },
      letterhead: false,
    }),
  );

  return { html: pages.join(''), count: pages.length };
}

// =========================================================================
// PAGE 6 — Table of All Savings Options (A/B/C)
// =========================================================================
function rptPageWoodlandOptions(n, d) {
  var body =
    '<div class="rpt-su">Estimated, projected savings from an occupied-setpoint change, projected from a full year of billing and weather data, not savings measured after installation. Each option raises the occupied cooling setpoint and lowers the occupied heating setpoint by 1°F relative to the prior option; savings are valued at the seasonal marginal utility rate each month, then summed for the year. The shared-savings split below assumes ' +
    WOODLAND_CLIENT_SHARE_PCT +
    '% to the client and ' +
    (100 - WOODLAND_CLIENT_SHARE_PCT) +
    '% to CSC of the annual dollars saved (to be confirmed), rather than a capital cost with payback period.</div>' +
    // 8 columns, widths sum to exactly 100% (table-layout:fixed truncates every column
    // proportionally when widths overrun). Option+Setpoint merged into one cell and the three
    // $ components merged into one "$ Saved: Gas / Electric / Demand" cell so Word's narrower
    // usable width never wraps a dollar figure mid-number; the per-component breakdown is also
    // in full in the Show-your-work line below each row and in the Page 5 per-month grid.
    '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr>' +
    '<th style="width:16%">Option</th>' +
    '<th class="rpt-n" style="width:9%">Heat Therms Saved</th>' +
    '<th class="rpt-n" style="width:9%">Cool kWh Saved</th>' +
    '<th class="rpt-n" style="width:9%">Peak Demand kW Saved</th>' +
    '<th class="rpt-n" style="width:22%">$ Saved: Gas / Electric / Demand</th>' +
    '<th class="rpt-n" style="width:12%">Total $ Saved</th>' +
    '<th class="rpt-n" style="width:12%">Client Share (' +
    WOODLAND_CLIENT_SHARE_PCT +
    '%)</th>' +
    '<th class="rpt-n" style="width:11%">CSC Share (' +
    (100 - WOODLAND_CLIENT_SHARE_PCT) +
    '%)</th>' +
    '</tr></thead><tbody>';

  // sums[3] (the combined $ column) is filled in AFTER the loop below — its Total/Average rows
  // can't be a single _wdC(sum), each running sum (gas/elec/demand) is tracked separately
  // (gasSumAll/elecSumAll/demSumAll) and formatted into one "$X / $Y / $Z" cell.
  var sums = [
    { sum: 0, dec: 1 }, // Heat Therms Saved
    { sum: 0, dec: 0 }, // Cool kWh Saved
    { sum: 0, dec: 2 }, // Peak Demand kW Saved
    { sum: 0, fmt: 'text', text: '', avgText: '' }, // $ Saved: Gas / Electric / Demand
    { sum: 0, dec: 2, fmt: 'c' }, // Total $ Saved
    { sum: 0, dec: 2, fmt: 'c' }, // Client Share
    { sum: 0, dec: 2, fmt: 'c' }, // CSC Share
  ];
  var gasSumAll = 0,
    elecSumAll = 0,
    demSumAll = 0;

  d.options.forEach(function (o) {
    var R = o.rates;
    sums[0].sum += o.annualHeatTherms;
    sums[1].sum += o.annualCoolKwh;
    sums[2].sum += o.peakDemandKw;
    sums[4].sum += o.annualTotal$;
    sums[5].sum += o.clientShare$;
    sums[6].sum += o.cscShare$;
    gasSumAll += o.annualGas$;
    elecSumAll += o.annualElec$;
    demSumAll += o.annualDem$;

    body +=
      '<tr><td>Option ' +
      o.letter +
      ' (' +
      o.heatSP +
      '°F / ' +
      o.coolSP +
      '°F)</td>' +
      '<td class="rpt-n">' +
      _wdN(o.annualHeatTherms, 1) +
      '</td><td class="rpt-n">' +
      _wdN(o.annualCoolKwh) +
      '</td>' +
      '<td class="rpt-n">' +
      _wdN(o.peakDemandKw, 2) +
      '</td><td class="rpt-n">' +
      _wdC(o.annualGas$) +
      ' / ' +
      _wdC(o.annualElec$) +
      ' / ' +
      _wdC(o.annualDem$) +
      '</td>' +
      '<td class="rpt-n" style="font-weight:700">' +
      _wdC(o.annualTotal$) +
      '</td><td class="rpt-n">' +
      _wdC(o.clientShare$) +
      '</td>' +
      '<td class="rpt-n">' +
      _wdC(o.cscShare$) +
      '</td></tr>';

    // Show-your-work sub-rows: one peak-summer month (August) and one peak-winter month
    // (January), literally spelled out, using THIS option's own stored rates. Every operand is
    // shown at its stored 2dp precision and summed in the same gas-then-electric-then-demand
    // order the code uses, so a reader's hand computation lands on the printed cent.
    var aug = o.monthly[7],
      jan = o.monthly[0];
    body +=
      '<tr><td colspan="8" style="font-size:10px;font-style:italic;color:var(--rpt-page-text);border-top:none">' +
      'Show your work — August (peak summer): ' +
      _wdN(o.gas[7], 2) +
      ' Therms × $' +
      R.gasSummer.toFixed(3) +
      ' + ' +
      _wdN(o.kwh[7], 2) +
      ' kWh × $' +
      R.elecEnergySummer.toFixed(4) +
      ' + ' +
      _wdN(o.kw[7], 2) +
      ' kW × $' +
      R.demandSummer.toFixed(3) +
      ' = ' +
      _wdC(aug.total$) +
      ' &nbsp; | &nbsp; January (peak winter): ' +
      _wdN(o.gas[0], 2) +
      ' Therms × $' +
      R.gasWinter.toFixed(3) +
      ' + ' +
      _wdN(o.kwh[0], 2) +
      ' kWh × $' +
      R.elecEnergyWinter.toFixed(4) +
      ' + ' +
      _wdN(o.kw[0], 2) +
      ' kW × $' +
      R.demandWinter.toFixed(3) +
      ' = ' +
      _wdC(jan.total$) +
      '</td></tr>';
  });

  var nOpts = d.options.length || 1;
  sums[3].text = _wdC(gasSumAll) + ' / ' + _wdC(elecSumAll) + ' / ' + _wdC(demSumAll);
  sums[3].avgText = _wdC(gasSumAll / nOpts) + ' / ' + _wdC(elecSumAll / nOpts) + ' / ' + _wdC(demSumAll / nOpts);
  body += _rptTotalAvgRow(sums, 'TOTAL', nOpts) + '</tbody></table>';

  return rptPage(n, 'Savings Options Comparison — A / B / C', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 7 — Charts of All Options (SVG <rect> idiom — survives PDF + docx rasterization)
// =========================================================================
function _woodlandGroupedBarSVG(options, series, title, unitFmt) {
  // series: [{key, label, colorVar}], one grouped bar cluster per option.
  var W = 700,
    H = 260,
    padL = 60,
    padR = 20,
    padT = 30,
    padB = 40;
  var chartW = W - padL - padR,
    chartH = H - padT - padB;
  var groupW = chartW / options.length;
  var barW = Math.min(38, (groupW - 20) / series.length);
  var maxVal = 0;
  options.forEach(function (o) {
    series.forEach(function (s) {
      maxVal = Math.max(maxVal, Math.abs(o[s.key]));
    });
  });
  if (maxVal === 0) maxVal = 1;

  var gridLines = '',
    yLabels = '';
  for (var gi = 0; gi <= 4; gi++) {
    var gv = (maxVal / 4) * gi;
    var gy = padT + chartH - (gv / maxVal) * chartH;
    gridLines +=
      '<line x1="' +
      padL +
      '" y1="' +
      gy.toFixed(1) +
      '" x2="' +
      (W - padR) +
      '" y2="' +
      gy.toFixed(1) +
      '" stroke="var(--rpt-progress-bg)" stroke-width="0.5"/>';
    yLabels +=
      '<text x="' +
      (padL - 6) +
      '" y="' +
      (gy + 3).toFixed(1) +
      '" text-anchor="end" font-size="9" fill="var(--rpt-page-text)">' +
      unitFmt(gv) +
      '</text>';
  }

  var bars = '',
    xLabels = '';
  options.forEach(function (o, gi2) {
    var gx = padL + gi2 * groupW + (groupW - series.length * barW) / 2;
    series.forEach(function (s, si) {
      var v = o[s.key] || 0;
      var barH = Math.max(1, (v / maxVal) * chartH);
      var bx = gx + si * barW;
      var by = padT + chartH - barH;
      bars +=
        '<rect x="' +
        bx.toFixed(1) +
        '" y="' +
        by.toFixed(1) +
        '" width="' +
        (barW - 2) +
        '" height="' +
        barH.toFixed(1) +
        '" fill="' +
        s.colorVar +
        '" rx="1"/>';
    });
    xLabels +=
      '<text x="' +
      (padL + gi2 * groupW + groupW / 2).toFixed(1) +
      '" y="' +
      (H - 20) +
      '" text-anchor="middle" font-size="11" font-weight="700" fill="var(--rpt-page-text)">Option ' +
      o.letter +
      '</text>';
  });

  var legend = '';
  var legendX = padL;
  series.forEach(function (s, si2) {
    var lx = legendX;
    // Estimate label width at 9px font (~5.3px/char) plus the swatch (13px) and gap (24px)
    // between legend entries — a fixed 140px slot (the previous approach) overlapped the next
    // swatch/label whenever a label ran longer than ~23 characters (e.g. "Electric Energy $
    // Saved", measured colliding with "Demand $ Saved" in headed-browser verification).
    legendX = lx + 13 + s.label.length * 5.3 + 24;
    legend +=
      '<rect x="' +
      lx +
      '" y="' +
      (H - 8) +
      '" width="9" height="9" fill="' +
      s.colorVar +
      '"/><text x="' +
      (lx + 13) +
      '" y="' +
      (H - 1) +
      '" font-size="9" fill="var(--rpt-page-text)">' +
      s.label +
      '</text>';
  });

  return (
    '<svg width="' +
    W +
    '" height="' +
    H +
    '" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" xmlns="http://www.w3.org/2000/svg">' +
    '<text x="' +
    W / 2 +
    '" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="var(--rpt-blue)">' +
    title +
    '</text>' +
    gridLines +
    yLabels +
    bars +
    xLabels +
    legend +
    '<line x1="' +
    padL +
    '" y1="' +
    padT +
    '" x2="' +
    padL +
    '" y2="' +
    (padT + chartH) +
    '" stroke="var(--rpt-page-text)" stroke-width="0.5"/>' +
    '<line x1="' +
    padL +
    '" y1="' +
    (padT + chartH) +
    '" x2="' +
    (W - padR) +
    '" y2="' +
    (padT + chartH) +
    '" stroke="var(--rpt-page-text)" stroke-width="0.5"/>' +
    '</svg>'
  );
}

function rptPageWoodlandCharts(n, d) {
  var opts = d.options;
  var dollarChart = _woodlandGroupedBarSVG(
    opts,
    [
      { key: 'annualGas$', label: 'Gas $ Saved', colorVar: 'var(--rpt-orange)' },
      { key: 'annualElec$', label: 'Electric Energy $ Saved', colorVar: 'var(--rpt-blue)' },
      { key: 'annualDem$', label: 'Demand $ Saved', colorVar: 'var(--rpt-green)' },
    ],
    'Annual $ Saved by Option — Gas / Electric Energy / Demand',
    function (v) {
      return '$' + Math.round(v).toLocaleString();
    },
  );
  var shareChart = _woodlandGroupedBarSVG(
    opts,
    [
      { key: 'clientShare$', label: 'Client Share (' + WOODLAND_CLIENT_SHARE_PCT + '%)', colorVar: 'var(--rpt-blue)' },
      {
        key: 'cscShare$',
        label: 'CSC Share (' + (100 - WOODLAND_CLIENT_SHARE_PCT) + '%)',
        colorVar: 'var(--rpt-eui-purple)',
      },
    ],
    'Shared-Savings Split by Option — Client / CSC',
    function (v) {
      return '$' + Math.round(v).toLocaleString();
    },
  );

  var body =
    '<div class="rpt-su">Side-by-side comparison of the three setpoint options: total annual dollar savings by end use, and the shared-savings split (' +
    WOODLAND_CLIENT_SHARE_PCT +
    '% client / ' +
    (100 - WOODLAND_CLIENT_SHARE_PCT) +
    '% CSC, to be confirmed with the client).</div>' +
    '<div id="woodlandChartsPage">' +
    '<div style="margin:10px 0">' +
    dollarChart +
    '</div>' +
    '<div style="margin:10px 0">' +
    shareChart +
    '</div>' +
    '</div>';

  return rptPage(n, 'Charts — Savings Options Comparison', body, { data: { project: d.project }, letterhead: false });
}

// =========================================================================
// exportWoodlandReportToXlsx(data) — 4th export surface (ExcelJS, one sheet per page)
// =========================================================================
function _wdHexFromComputedColor(str) {
  if (!str) return 'FFFFFF';
  str = str.trim();
  if (str[0] === '#') return str.slice(1).toUpperCase();
  var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str);
  if (!m) return 'FFFFFF';
  function h(n) {
    return (parseInt(n, 10) & 255).toString(16).padStart(2, '0').toUpperCase();
  }
  return h(m[1]) + h(m[2]) + h(m[3]);
}
function _wdArgb(hex6) {
  return 'FF' + hex6;
}

// Reuses the exact rasterization technique _rptSwapChartSvgForPng (report-engine.js) already
// uses for the docx pipeline: resolve --rpt-* against the live root, draw as an Image, paint to
// an offscreen canvas, read back a PNG data URL. Kept as a separate small helper here (rather
// than importing the docx one) because it must NOT remove/replace the live preview's <svg> —
// docx's version mutates the DOM clone it's given; this one only reads.
function _wdSvgToPngDataUrl(svgEl, scale) {
  return new Promise(function (resolve) {
    var vb = (svgEl.getAttribute('viewBox') || '').trim().split(/\s+/).map(parseFloat);
    var vbW = vb.length === 4 ? vb[2] : 0,
      vbH = vb.length === 4 ? vb[3] : 0;
    var wCss = parseFloat(svgEl.getAttribute('width')) || vbW;
    var hCss = parseFloat(svgEl.getAttribute('height')) || vbH;
    if (!wCss || !hCss) return resolve(null);
    var clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    var pxW = Math.round(wCss * (scale || 2)),
      pxH = Math.round(hCss * (scale || 2));
    clone.setAttribute('width', String(pxW));
    clone.setAttribute('height', String(pxH));
    var markup =
      typeof _rptResolveCssVarsAgainstRoot === 'function'
        ? _rptResolveCssVarsAgainstRoot(new XMLSerializer().serializeToString(clone))
        : new XMLSerializer().serializeToString(clone);
    var img = new Image();
    var timer = setTimeout(function () {
      resolve(null);
    }, 5000);
    img.onload = function () {
      clearTimeout(timer);
      try {
        var canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pxW, pxH);
        ctx.drawImage(img, 0, 0, pxW, pxH);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: wCss, height: hCss });
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = function () {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  });
}

async function exportWoodlandReportToXlsx(data) {
  if (!data) {
    showToast('No report data available');
    return;
  }
  if (typeof ExcelJS === 'undefined') {
    showToast('ExcelJS library not loaded', 'error');
    return;
  }
  showToast('Generating Excel workbook...');

  var rootStyle = getComputedStyle(document.documentElement);
  var HDR_HEX = _wdHexFromComputedColor(rootStyle.getPropertyValue('--rpt-table-th-bg'));
  var HDR_TEXT_HEX = _wdHexFromComputedColor(rootStyle.getPropertyValue('--rpt-table-th-text')) || 'FFFFFF';
  var TOT_HEX = _wdHexFromComputedColor(rootStyle.getPropertyValue('--rpt-table-tot-bg'));
  var TITLE_HEX = _wdHexFromComputedColor(rootStyle.getPropertyValue('--rpt-blue'));

  var wb = new ExcelJS.Workbook();
  wb.creator = 'CompanyHub';
  wb.created = new Date();

  function styleHeaderRow(row) {
    row.eachCell(function (cell) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: _wdArgb(HDR_HEX) } };
      cell.font = { bold: true, color: { argb: _wdArgb(HDR_TEXT_HEX) } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
  }
  function styleTotalRow(row) {
    row.eachCell(function (cell) {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: _wdArgb(TOT_HEX) } };
    });
  }
  function styleAvgRow(row) {
    row.eachCell(function (cell) {
      cell.font = { bold: true, italic: true };
    });
  }
  function titleRow(ws, text) {
    var row = ws.addRow([text]);
    row.font = { bold: true, size: 14, color: { argb: _wdArgb(TITLE_HEX) } };
    ws.addRow([]);
    return row;
  }
  function sumF(col, first, last) {
    return { formula: 'SUM(' + col + first + ':' + col + last + ')' };
  }
  function avgF(col, first, last) {
    return { formula: 'AVERAGE(' + col + first + ':' + col + last + ')' };
  }

  // ---- Sheet 1: Bills (energy vs demand split, same as Page 1) ----
  var ws1 = wb.addWorksheet('Page 1 - Bills');
  ws1.columns = [
    { width: 14 },
    { width: 8 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];
  titleRow(ws1, 'Raw Utility Bill Data — ' + data.building.name);
  if (data.elecBL && data.elecBL.rows.length) {
    ws1.addRow(['Electric']);
    var hRow1 = ws1.addRow([
      'Month',
      'Days',
      'Billed kWh',
      'Billed kW',
      'Energy Cost',
      'Demand Cost',
      'Total Cost',
      'Energy $/kWh',
      'Demand $/kW',
    ]);
    styleHeaderRow(hRow1);
    var firstDataRow1 = ws1.rowCount + 1;
    data.elecBL.rows.forEach(function (r) {
      var b = r.bill;
      var kwh = parseFloat(b.kwh) || 0;
      var kw = parseFloat(b.billedKW || b.demandKW) || 0;
      var energy$ = parseFloat(b.kwhCost) || 0;
      var demand$ = (parseFloat(b.kwCost) || 0) + (parseFloat(b.facKWCost) || 0);
      var cost = parseFloat(b.totalCost) || 0;
      var rn = ws1.rowCount + 1;
      ws1.addRow([
        r.ym,
        parseFloat(b.numberOfDays) || _wdDaysInMonth(r.ym),
        kwh,
        kw,
        energy$,
        demand$,
        cost,
        { formula: 'IF(C' + rn + '>0,E' + rn + '/C' + rn + ',0)' },
        { formula: 'IF(D' + rn + '>0,F' + rn + '/D' + rn + ',0)' },
      ]);
    });
    var lastDataRow1 = ws1.rowCount;
    // Billed kW Total = ANNUAL PEAK (MAX), never a sum of monthly peaks. Rate totals = annual
    // cost / annual quantity (a real effective rate, not a sum of rates).
    var totR1 = ws1.addRow([
      'TOTAL (Annual)',
      sumF('B', firstDataRow1, lastDataRow1),
      sumF('C', firstDataRow1, lastDataRow1),
      { formula: 'MAX(D' + firstDataRow1 + ':D' + lastDataRow1 + ')' },
      sumF('E', firstDataRow1, lastDataRow1),
      sumF('F', firstDataRow1, lastDataRow1),
      sumF('G', firstDataRow1, lastDataRow1),
      {
        formula:
          'IF(SUM(C' +
          firstDataRow1 +
          ':C' +
          lastDataRow1 +
          ')>0,SUM(E' +
          firstDataRow1 +
          ':E' +
          lastDataRow1 +
          ')/SUM(C' +
          firstDataRow1 +
          ':C' +
          lastDataRow1 +
          '),0)',
      },
      {
        formula:
          'IF(SUM(D' +
          firstDataRow1 +
          ':D' +
          lastDataRow1 +
          ')>0,SUM(F' +
          firstDataRow1 +
          ':F' +
          lastDataRow1 +
          ')/SUM(D' +
          firstDataRow1 +
          ':D' +
          lastDataRow1 +
          '),0)',
      },
    ]);
    styleTotalRow(totR1);
    ws1.getCell('D' + totR1.number).note = 'Annual peak (MAX of the 12 monthly demand readings) — not a sum.';
    var avgR1 = ws1.addRow([
      'Average (per month)',
      avgF('B', firstDataRow1, lastDataRow1),
      avgF('C', firstDataRow1, lastDataRow1),
      avgF('D', firstDataRow1, lastDataRow1),
      avgF('E', firstDataRow1, lastDataRow1),
      avgF('F', firstDataRow1, lastDataRow1),
      avgF('G', firstDataRow1, lastDataRow1),
      null,
      null,
    ]);
    styleAvgRow(avgR1);
    ws1.addRow([]);
  }
  if (data.gasBL && data.gasBL.rows.length) {
    ws1.addRow(['Natural Gas']);
    var hRow2 = ws1.addRow(['Month', 'Days', 'Billed Therms', '', 'Total Cost', 'Eff. $/Therm']);
    styleHeaderRow(hRow2);
    var firstDataRow2 = ws1.rowCount + 1;
    data.gasBL.rows.forEach(function (r) {
      var b = r.bill;
      var therms = _wdBillTherms(b);
      var cost = parseFloat(b.totalCost) || 0;
      var rn2 = ws1.rowCount + 1;
      ws1.addRow([
        r.ym,
        parseFloat(b.numberOfDays) || _wdDaysInMonth(r.ym),
        therms,
        null,
        cost,
        { formula: 'IF(C' + rn2 + '>0,E' + rn2 + '/C' + rn2 + ',0)' },
      ]);
    });
    var lastDataRow2 = ws1.rowCount;
    var totR2 = ws1.addRow([
      'TOTAL (Annual)',
      sumF('B', firstDataRow2, lastDataRow2),
      sumF('C', firstDataRow2, lastDataRow2),
      null,
      sumF('E', firstDataRow2, lastDataRow2),
      {
        formula:
          'IF(SUM(C' +
          firstDataRow2 +
          ':C' +
          lastDataRow2 +
          ')>0,SUM(E' +
          firstDataRow2 +
          ':E' +
          lastDataRow2 +
          ')/SUM(C' +
          firstDataRow2 +
          ':C' +
          lastDataRow2 +
          '),0)',
      },
    ]);
    styleTotalRow(totR2);
    var avgR2 = ws1.addRow([
      'Average (per month)',
      avgF('B', firstDataRow2, lastDataRow2),
      avgF('C', firstDataRow2, lastDataRow2),
      null,
      avgF('E', firstDataRow2, lastDataRow2),
      null,
    ]);
    styleAvgRow(avgR2);
  }

  // ---- Sheet 2: Baseline & Weather Normalization ----
  var ws2 = wb.addWorksheet('Page 2 - Baseline Norm');
  ws2.columns = [
    { width: 14 },
    { width: 8 },
    { width: 10 },
    { width: 10 },
    { width: 34 },
    { width: 14 },
    { width: 14 },
  ];
  titleRow(ws2, 'Baseline Selection & Weather Normalization — ' + data.building.name);
  if (data.elecBL && data.elecBL.regrCoeffs) {
    var rc = data.elecBL.regrCoeffs;
    // Same rc4 pre-rounding as the PDF/docx page — the equation shown here and the Predicted
    // kWh values below must come from the SAME rounded coefficient.
    var rc4x = {
      type: rc.type,
      intercept: _wdRoundHalfUp(rc.intercept, 4),
      slopeHDD: rc.slopeHDD != null ? _wdRoundHalfUp(rc.slopeHDD, 4) : null,
      slopeCDD: rc.slopeCDD != null ? _wdRoundHalfUp(rc.slopeCDD, 4) : null,
      slope: rc.slope != null ? _wdRoundHalfUp(rc.slope, 4) : null,
    };
    var eqnParts = ['Electric kWh = ' + rc4x.intercept.toFixed(4) + ' x Days'];
    if (rc4x.type === 'dual')
      eqnParts.push('+ ' + rc4x.slopeHDD.toFixed(4) + ' x HDD + ' + rc4x.slopeCDD.toFixed(4) + ' x CDD');
    ws2.addRow(['Regression (' + data.elecBL.regrType + ', R2=' + data.elecBL.r2.toFixed(3) + ')']);
    ws2.addRow([eqnParts.join(' ')]);
    ws2.addRow([]);
    var hRow3 = ws2.addRow(['Month', 'Days', 'HDD', 'CDD', 'Calculation', 'Predicted kWh', 'Actual kWh']);
    styleHeaderRow(hRow3);
    var firstDataRow3 = ws2.rowCount + 1;
    data.elecBL.months.forEach(function (ym) {
      var days = _wdDaysInMonth(ym);
      var wx = data.wxByYm[ym] || { hdd: 0, cdd: 0 };
      var hddR = _wdRoundHalfUp(wx.hdd || 0, 0);
      var cddR = _wdRoundHalfUp(wx.cdd || 0, 0);
      var predicted = rc4x.intercept * days;
      var calc = rc4x.intercept.toFixed(4) + 'x' + days;
      if (rc4x.type === 'dual') {
        predicted += rc4x.slopeHDD * hddR + rc4x.slopeCDD * cddR;
        calc += ' + ' + rc4x.slopeHDD.toFixed(4) + 'x' + hddR + ' + ' + rc4x.slopeCDD.toFixed(4) + 'x' + cddR;
      } else if (rc4x.type === 'hdd') {
        predicted += rc4x.slope * hddR;
        calc += ' + ' + rc4x.slope.toFixed(4) + 'x' + hddR;
      } else if (rc4x.type === 'cdd') {
        predicted += rc4x.slope * cddR;
        calc += ' + ' + rc4x.slope.toFixed(4) + 'x' + cddR;
      }
      predicted = _wdRoundHalfUp(Math.max(0, predicted), 0);
      var row = data.elecBL.rows.find(function (r) {
        return r.ym === ym;
      });
      var actual = _wdRoundHalfUp(row ? parseFloat(row.bill.kwh) || 0 : 0, 0);
      ws2.addRow([ym, days, hddR, cddR, calc, predicted, actual]);
    });
    var lastDataRow3 = ws2.rowCount;
    var totR3 = ws2.addRow([
      'TOTAL (Annual)',
      sumF('B', firstDataRow3, lastDataRow3),
      sumF('C', firstDataRow3, lastDataRow3),
      sumF('D', firstDataRow3, lastDataRow3),
      null,
      sumF('F', firstDataRow3, lastDataRow3),
      sumF('G', firstDataRow3, lastDataRow3),
    ]);
    styleTotalRow(totR3);
    var avgR3 = ws2.addRow([
      'Average (per month)',
      avgF('B', firstDataRow3, lastDataRow3),
      avgF('C', firstDataRow3, lastDataRow3),
      avgF('D', firstDataRow3, lastDataRow3),
      null,
      avgF('F', firstDataRow3, lastDataRow3),
      avgF('G', firstDataRow3, lastDataRow3),
    ]);
    styleAvgRow(avgR3);
  }
  ws2.addRow([]);
  ws2.addRow([
    'Natural gas: no weather regression fitted; the 12 billed monthly Therms totals (Page 1) are used directly.',
  ]);

  // ---- Sheet 3: Baseline Summary (mirror of the site's Building Baseline Data table) ----
  var ws3 = wb.addWorksheet('Page 3 - Summary');
  ws3.columns = [
    { width: 10 },
    { width: 12 },
    { width: 11 },
    { width: 11 },
    { width: 12 },
    { width: 12 },
    { width: 13 },
    { width: 10 },
    { width: 11 },
    { width: 12 },
    { width: 10 },
    { width: 13 },
  ];
  titleRow(ws3, 'Baseline Summary (Building Baseline Data) — ' + data.building.name);
  var sbm = (data.siteBuilding && data.siteBuilding.baselineMaps) || { elecByMo: {}, gasByMo: {} };
  var sqft = data.building.sqft || 0;
  if (Object.keys(sbm.elecByMo || {}).length || Object.keys(sbm.gasByMo || {}).length) {
    var hRow4 = ws3.addRow([
      'Month',
      'kWh',
      'Actual kW',
      'Billed kW',
      'kW Cost',
      'Energy Cost',
      'Electric Cost',
      '$/kWh',
      'Therms',
      'Gas Cost',
      '$/Therm',
      'Total Cost',
    ]);
    styleHeaderRow(hRow4);
    var firstDataRow4 = ws3.rowCount + 1;
    for (var mi = 0; mi < 12; mi++) {
      var eM = (sbm.elecByMo || {})[mi] || {};
      var gM = (sbm.gasByMo || {})[mi] || {};
      var kwhM = eM.kwh || 0;
      var kwCostM = (eM.kwCost || 0) + (eM.facKWCost || 0);
      var enCostM = eM.energyCost || 0;
      var elecCostM = eM.commodityCost || eM.totalCost || 0;
      var thermsM = gM.therms || 0;
      var gasCostM = gM.cost || 0;
      var rn4 = ws3.rowCount + 1;
      ws3.addRow([
        WOODLAND_MO_ABBR[mi],
        kwhM,
        eM.demandKW || 0,
        eM.billedKW || 0,
        kwCostM,
        enCostM,
        elecCostM,
        { formula: 'IF(B' + rn4 + '>0,F' + rn4 + '/B' + rn4 + ',0)' },
        thermsM,
        gasCostM,
        gM.rate > 0 ? gM.rate : { formula: 'IF(I' + rn4 + '>0,J' + rn4 + '/I' + rn4 + ',0)' },
        { formula: 'G' + rn4 + '+J' + rn4 },
      ]);
    }
    var lastDataRow4 = ws3.rowCount;
    // Annual row — same convention as the site table: kW columns are the 12-month AVERAGE.
    var totR4 = ws3.addRow([
      'Annual',
      sumF('B', firstDataRow4, lastDataRow4),
      avgF('C', firstDataRow4, lastDataRow4),
      avgF('D', firstDataRow4, lastDataRow4),
      sumF('E', firstDataRow4, lastDataRow4),
      sumF('F', firstDataRow4, lastDataRow4),
      sumF('G', firstDataRow4, lastDataRow4),
      { formula: 'IF(B' + (lastDataRow4 + 1) + '>0,G' + (lastDataRow4 + 1) + '/B' + (lastDataRow4 + 1) + ',0)' },
      sumF('I', firstDataRow4, lastDataRow4),
      sumF('J', firstDataRow4, lastDataRow4),
      { formula: 'IF(I' + (lastDataRow4 + 1) + '>0,J' + (lastDataRow4 + 1) + '/I' + (lastDataRow4 + 1) + ',0)' },
      sumF('L', firstDataRow4, lastDataRow4),
    ]);
    styleTotalRow(totR4);
    ws3.getCell('C' + totR4.number).note = 'Annual = 12-month average kW (site convention), not a sum.';
    var A = totR4.number;
    ws3.addRow([]);
    ws3.addRow(['Square Feet', sqft]);
    ws3.addRow(['Electric Use / SF (kWh)', sqft > 0 ? { formula: 'B' + A + '/' + sqft } : null]);
    ws3.addRow(['Utility Cost / SF', sqft > 0 ? { formula: 'L' + A + '/' + sqft } : null]);
    ws3.addRow(['Avg Electric Rate ($/kWh)', { formula: 'H' + A }]);
    ws3.addRow(['Avg Gas Rate ($/Therm)', { formula: 'K' + A }]);
    var euiRow = ws3.addRow([
      'Site EUI (kBtu/SF)',
      sqft > 0 ? { formula: '(B' + A + '*3.412+I' + A + '*100)/' + sqft } : null,
    ]);
    styleTotalRow(euiRow);
    ws3.addRow(['Total Annual Utility Cost', { formula: 'L' + A }]);
  } else {
    ws3.addRow(["No baseline month data is available for this building in the site's utility records."]);
  }

  // ---- Sheet 4: HVAC (same inputs as Page 4) ----
  var ws4 = wb.addWorksheet('Page 4 - HVAC Split');
  ws4.columns = [{ width: 14 }, { width: 14 }, { width: 18 }, { width: 14 }, { width: 16 }, { width: 14 }];
  titleRow(ws4, 'Estimated HVAC Cooling & Heating — ' + data.building.name);
  var hv = data.hvac || {};
  var elecKwhRow = ws4.addRow(['Annual electric use (kWh)', hv.elecKwh || 0]);
  var gasThermsRow = ws4.addRow(['Annual gas use (Therms)', hv.gasTherms || 0]);
  if (hv.coolKwh != null) {
    ws4.addRow(['CDD coefficient (kWh per cooling degree day, Page 2)', hv.slopeCDD]);
    ws4.addRow([]);
    var hRowH = ws4.addRow([
      'Month',
      'Cooling Degree Days',
      'Cooling kWh (coef x CDD)',
      'Billed kWh',
      'Non-cooling kWh',
      'Gas Therms',
    ]);
    styleHeaderRow(hRowH);
    var firstH = ws4.rowCount + 1;
    hv.months.forEach(function (m) {
      ws4.addRow([m.ym, m.cdd, m.coolKwh, m.actualKwh, m.otherKwh, m.therms]);
    });
    var lastH = ws4.rowCount;
    var totH = ws4.addRow([
      'TOTAL (Annual)',
      sumF('B', firstH, lastH),
      sumF('C', firstH, lastH),
      sumF('D', firstH, lastH),
      sumF('E', firstH, lastH),
      sumF('F', firstH, lastH),
    ]);
    styleTotalRow(totH);
    var avgH = ws4.addRow([
      'Average (per month)',
      avgF('B', firstH, lastH),
      avgF('C', firstH, lastH),
      avgF('D', firstH, lastH),
      avgF('E', firstH, lastH),
      avgF('F', firstH, lastH),
    ]);
    styleAvgRow(avgH);
    ws4.addRow([]);
    var coolPctRow = ws4.addRow([
      'Cooling share of electric use',
      { formula: 'IF(B' + elecKwhRow.number + '>0,C' + totH.number + '/B' + elecKwhRow.number + ',0)' },
    ]);
    ws4.getCell('B' + coolPctRow.number).numFmt = '0.0%';
    var heatPctRow = ws4.addRow([
      'Heating share of HVAC load',
      {
        formula: '(B' + gasThermsRow.number + '*100)/((B' + gasThermsRow.number + '*100)+(C' + totH.number + '*3.412))',
      },
    ]);
    ws4.getCell('B' + heatPctRow.number).numFmt = '0.0%';
    styleTotalRow(heatPctRow);
    var coolShareRow = ws4.addRow(['Cooling share of HVAC load', { formula: '1-B' + heatPctRow.number }]);
    ws4.getCell('B' + coolShareRow.number).numFmt = '0.0%';
  } else {
    ws4.addRow([]);
    ws4.addRow([
      "Cooling load is not statistically separable from this building's baseline electric regression (no positive cooling-degree-day term); no split shown.",
    ]);
  }

  // ---- Sheet 5: BAS Savings Calc ----
  var ws5 = wb.addWorksheet('Page 5 - BAS Calc');
  ws5.columns = [
    { width: 30 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];
  titleRow(ws5, 'BAS Savings Calculation — Setpoints, Method & Detail — ' + data.building.name);
  var optA = data.options[0];
  var zones = data.zones || [];
  if (zones.length) {
    ws5.addRow(['Current Zone Setpoints (Equipment Matrix, ' + zones.length + ' zones)']);
    var hRowZ = ws5.addRow([
      'Zone',
      'Occupied Heating',
      'Occupied Cooling',
      'Unoccupied Heating',
      'Unoccupied Cooling',
      'Status',
    ]);
    styleHeaderRow(hRowZ);
    zones.forEach(function (z) {
      ws5.addRow([
        z.zone,
        z.occHeat,
        z.occCool,
        z.unoccHeat,
        z.unoccCool,
        z.complete ? 'Both occupied setpoints found' : 'Occupied setpoint missing',
      ]);
    });
  } else {
    ws5.addRow([
      'Per-zone BAS point data is not available for this building; setpoints below are the proposed building-wide targets only.',
    ]);
  }
  ws5.addRow([]);
  var hRowT = ws5.addRow(['Option', 'Occupied Heating Setpoint', 'Occupied Cooling Setpoint']);
  styleHeaderRow(hRowT);
  data.options.forEach(function (o) {
    ws5.addRow(['Option ' + o.letter, o.heatSP, o.coolSP]);
  });
  ws5.addRow([]);
  if (optA) {
    var RA = optA.rates;
    ws5.addRow([
      'Seasonal Marginal Rates (Option ' + optA.letter + ' measure)',
      'Summer (Jun-Sep)',
      'Winter (Oct-May)',
    ]);
    ws5.addRow(['Gas ($/Therm)', RA.gasSummer, RA.gasWinter]);
    ws5.addRow(['Electric energy ($/kWh)', RA.elecEnergySummer, RA.elecEnergyWinter]);
    ws5.addRow(['Electric demand ($/kW)', RA.demandSummer, RA.demandWinter]);
    ws5.addRow([]);
    var hRow5 = ws5.addRow([
      'Month',
      'Heat Therms Saved',
      'Gas $ Saved',
      'Cool kWh Saved',
      'Elec Energy $ Saved',
      'Demand $ Saved',
      'Total $ Saved',
    ]);
    styleHeaderRow(hRow5);
    var firstDataRow5 = ws5.rowCount + 1;
    for (var i = 0; i < 12; i++) {
      var mo = optA.monthly[i];
      ws5.addRow([WOODLAND_MO_ABBR[i], optA.gas[i] || 0, mo.gas$, optA.kwh[i] || 0, mo.elec$, mo.dem$, mo.total$]);
    }
    var lastDataRow5 = ws5.rowCount;
    var cols5 = ['B', 'C', 'D', 'E', 'F', 'G'];
    var totR5 = ws5.addRow([
      'TOTAL (Annual)',
      ...cols5.map(function (c) {
        return sumF(c, firstDataRow5, lastDataRow5);
      }),
    ]);
    styleTotalRow(totR5);
    var avgR5 = ws5.addRow([
      'Average (per month)',
      ...cols5.map(function (c) {
        return avgF(c, firstDataRow5, lastDataRow5);
      }),
    ]);
    styleAvgRow(avgR5);
    ws5.addRow([]);
    var annRow = ws5.addRow(['Annual $ saved', { formula: 'G' + totR5.number }]);
    var clientRow = ws5.addRow(['Client share (' + WOODLAND_CLIENT_SHARE_PCT + '%)', optA.clientShare$]);
    var cscRow = ws5.addRow(['CSC share (' + (100 - WOODLAND_CLIENT_SHARE_PCT) + '%)', optA.cscShare$]);
    styleTotalRow(cscRow);
    ws5.addRow([
      'Shared-savings split — assumes ' +
        WOODLAND_CLIENT_SHARE_PCT +
        '% client / ' +
        (100 - WOODLAND_CLIENT_SHARE_PCT) +
        '% CSC (to be confirmed with the client), not an install-cost/payback contract.',
    ]);
  }

  // ---- Sheet 6: Options A/B/C ----
  var ws6 = wb.addWorksheet('Page 6 - Options ABC');
  ws6.columns = [
    { width: 12 }, // Option
    { width: 16 }, // Occ SP
    { width: 16 }, // Heat Therms Saved
    { width: 14 }, // Cool kWh Saved
    { width: 18 }, // Peak Demand kW Saved
    { width: 12 }, // Gas $ Saved
    { width: 18 }, // Electric Energy $ Saved
    { width: 14 }, // Demand $ Saved
    { width: 14 }, // Total $ Saved
    { width: 16 }, // Client Share
    { width: 14 }, // CSC Share
  ];
  titleRow(ws6, 'Savings Options Comparison — A / B / C — ' + data.building.name);
  var hRow6 = ws6.addRow([
    'Option',
    'Occ SP',
    'Heat Therms Saved',
    'Cool kWh Saved',
    'Peak Demand kW Saved',
    'Gas $ Saved',
    'Electric Energy $ Saved',
    'Demand $ Saved',
    'Total $ Saved',
    'Client Share (' + WOODLAND_CLIENT_SHARE_PCT + '%)',
    'CSC Share (' + (100 - WOODLAND_CLIENT_SHARE_PCT) + '%)',
  ]);
  styleHeaderRow(hRow6);
  var firstDataRow6 = ws6.rowCount + 1;
  data.options.forEach(function (o) {
    ws6.addRow([
      'Option ' + o.letter,
      o.heatSP + '/' + o.coolSP,
      o.annualHeatTherms,
      o.annualCoolKwh,
      o.peakDemandKw,
      o.annualGas$,
      o.annualElec$,
      o.annualDem$,
      o.annualTotal$,
      o.clientShare$,
      o.cscShare$,
    ]);
  });
  var lastDataRow6 = ws6.rowCount;
  // C..K: Heat Therms .. CSC Share — every one of these columns is summable now that Client
  // Share/CSC Share (both plain $ amounts) replaced Install Cost/Payback (the old K, Payback,
  // was the only non-summable column, so the previous version stopped at J with a trailing null).
  var cols6 = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  var totR6 = ws6.addRow([
    'TOTAL (All Options)',
    null,
    ...cols6.map(function (c) {
      return sumF(c, firstDataRow6, lastDataRow6);
    }),
  ]);
  styleTotalRow(totR6);
  var avgR6 = ws6.addRow([
    'Average',
    null,
    ...cols6.map(function (c) {
      return avgF(c, firstDataRow6, lastDataRow6);
    }),
  ]);
  styleAvgRow(avgR6);

  // ---- Sheet 7: Charts ----
  // Calc re-audit defect #6 (2026-09-22): a NATIVE Excel chart object (bar chart driven live off
  // the data cells above, editable/repointable in Excel) was requested in addition to the PNG
  // images below. Confirmed via direct source inspection: ExcelJS 4.4.0 (the exact bundle this
  // page loads from jsdelivr, energy-department.html's exceljs CDN <script> tag) contains ZERO
  // occurrences of the string "chart" anywhere in its ~948KB minified source — there is no
  // addChart()/Chart class/chart-part writer of any kind in this library, undocumented or
  // otherwise (grep-verified against the literal cached bundle, not just the public docs).
  // ExcelJS can only read pre-existing native charts from a workbook it opens, never author one.
  // Producing a real DrawingML chart part would require either a different, unbudgeted library
  // (e.g. a paid tier, or hand-writing the xl/charts/chart1.xml OOXML part itself — a
  // significant, separately-scoped undertaking, not a one-line addition) — out of scope for this
  // fix pass per the plan's "no new export mechanism" decision. The data cells directly above
  // (Option/Gas $/Electric $/Demand $/Client Share/CSC Share) ARE plain values, so Matt can
  // select them and insert his own native Excel chart in seconds if he wants one; the embedded
  // PNGs below remain as the built-in visual.
  var ws7 = wb.addWorksheet('Page 7 - Charts');
  ws7.columns = [{ width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  titleRow(ws7, 'Charts — Savings Options Comparison — ' + data.building.name);
  ws7.addRow([
    'Option',
    'Gas $ Saved',
    'Electric Energy $ Saved',
    'Demand $ Saved',
    'Client Share (' + WOODLAND_CLIENT_SHARE_PCT + '%)',
    'CSC Share (' + (100 - WOODLAND_CLIENT_SHARE_PCT) + '%)',
  ]);
  data.options.forEach(function (o) {
    ws7.addRow(['Option ' + o.letter, o.annualGas$, o.annualElec$, o.annualDem$, o.clientShare$, o.cscShare$]);
  });
  ws7.addRow([]);
  var chartAnchorRow = ws7.rowCount + 2;
  var chartsHost = document.getElementById('woodlandChartsPage');
  if (chartsHost) {
    var svgs = chartsHost.querySelectorAll('svg');
    for (var si = 0; si < svgs.length; si++) {
      var raster = await _wdSvgToPngDataUrl(svgs[si], 2);
      if (raster) {
        var imgId = wb.addImage({ base64: raster.dataUrl, extension: 'png' });
        ws7.addImage(imgId, {
          tl: { col: 0, row: chartAnchorRow - 1 },
          ext: { width: raster.width, height: raster.height },
        });
        chartAnchorRow += Math.ceil(raster.height / 20) + 2;
      }
    }
  }

  var buf = await wb.xlsx.writeBuffer();
  var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var client = (data.building && data.building.name) || data.project.client || data.project.name || 'Report';
  var dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  a.href = url;
  a.download = client + ' - Baseline & BAS Savings Report ' + dateStr + '.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 5000);
  showToast('Excel workbook generated ✓');
}
window.exportWoodlandReportToXlsx = exportWoodlandReportToXlsx;
