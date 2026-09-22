// -----------------------------------------------------------------------
// report-engine-woodland.js
//
// Woodland Springs Middle School — 7-page Baseline + BAS Savings Report.
// New, self-contained report type (data._woodland = true), built entirely on
// the existing rptPage()/.rpt-page markup so the existing generic
// exportReportToPDF() / exportReportToDocx() (both in app/report-engine.js)
// work with ZERO changes. A fourth export surface, exportWoodlandReportToXlsx(),
// is added here (ExcelJS, one sheet per page).
//
// Plan: AI/_context/research/2026-09-22-woodland-7page-report-export-plan.md
//
// Data sources (read-only, one source feeds all 4 surfaces):
//  - Raw bills:       building.meters[].bills[]   (Electric + Gas meters)
//  - Baseline window: meter.baseline.months (12 'YYYY-MM' strings) / meter._reg (OLS regression)
//  - Weather:         wddLoadCache(building.zip) — {ym, hdd, cdd, avgTemp}[]
//  - Savings A/B/C:   project.savingsData.measures[] filtered to this building
//                      (kwh[]=cooling kWh saved, kw[]=demand kW saved, gas[]=heating therms
//                      saved — monthly, Jan..Dec — already the exact BAS savings-model output,
//                      see 2026-09-21-woodland-bas-3-option-savings.xlsx "Source Data" tab)
//
// Savings dollar formula (per Coordinator's audit): (quantity saved) x SEASONAL MARGINAL rate,
// monthly, then summed — never a blended rate, never a raw dollar delta. Seasonal rates below
// are the audited values (2026-09-21-woodland-bas-3-option-savings.xlsx, Savings Summary!Note 4).
// -----------------------------------------------------------------------

var WOODLAND_SEASONAL_RATES = {
  gasSummer: 0.327,
  gasWinter: 0.518,
  elecEnergySummer: 0.0485,
  elecEnergyWinter: 0.0363,
  demandSummer: 11.683,
  demandWinter: 5.598,
};
// Jun(5)-Sep(8), 0-indexed Jan=0 — matches Note 4 "Jun-Sep" / "Oct-May".
var WOODLAND_SUMMER_MONTH_IDX = [5, 6, 7, 8];
var WOODLAND_LABOR_HOURS = 8;
var WOODLAND_LABOR_RATE = 173;
var WOODLAND_INSTALL_COST = WOODLAND_LABOR_HOURS * WOODLAND_LABOR_RATE; // $1,384

// -----------------------------------------------------------------------
// Real per-zone setpoint data (Matt, 2026-09-22: "use REAL client data everywhere — no
// template defaults"). Sourced verbatim from:
//   2026-09-21-woodland-per-zone-setpoint-decomposition.csv (87 zones, current occ/unocc SP)
//   2026-09-21-woodland-setpoint-ecm-scenarios.csv (per-zone A/B/C scenario deltas)
//   2026-09-21-woodland-setpoint-schedule-ecm-table.csv + its NOTES.md (proposed policy,
//   schedule change, and the specialty-room/monitoring-only exception lists below)
// 87 of 87 zones reconcile: 72 standard (move to the uniform A/B/C target setpoints) + 1
// Kitchen RTU-7 (kept fixed, cooking-equipment load) + 14 monitoring-only/no-actuator zones
// (kept fixed, excluded from savings — matches the "14 of 87" excluded count independently
// cited in 2026-09-21-woodland-bas-3-option-savings.xlsx Note 3).
// -----------------------------------------------------------------------
var WOODLAND_ZONE_COUNTS = { total: 87, standard: 72, kitchenFixed: 1, monitorOnly: 14, hydronic: 59, electricRTU: 14 };
var WOODLAND_KITCHEN_ZONE = { zone: 'B125-B129 Kitchen RTU-7', heat: 65, cool: 70 };
var WOODLAND_MONITOR_ONLY_ZONES = [
  { zone: 'A116 Exhaust Fan', heat: 70, cool: 76 },
  { zone: 'A121 Electrical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'A133 Electrical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'A135 Telecomm', heat: 64, cool: 72 },
  { zone: 'B131 Ice Machine Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'B135 Mechanical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'B136 Office/Storage', heat: 70, cool: 74 },
  { zone: 'B138 Electrical', heat: 65, cool: 76 },
  { zone: 'C108 Electrical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'C135 Telecomm', heat: 65, cool: 76 },
  { zone: 'C143 Electrical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'D113 Electrical Exhaust Fan', heat: 68, cool: 70 },
  { zone: 'D118 Main Telecomm', heat: 65, cool: 72 },
  { zone: 'D127 Electrical Exhaust Fan', heat: 68, cool: 70 },
];
// The 10 (of 72) standard/actuated zones whose EXISTING occupied setpoint is not the 68°F/70°F
// building norm — still moved to the same uniform A/B/C target as every other standard zone.
var WOODLAND_NONSTANDARD_STANDARD_ZONES = [
  { zone: 'B110 Assistant Principal', heat: 70, cool: 70 },
  { zone: "B111 Principal's Office", heat: 70, cool: 70 },
  { zone: 'B115 Reception', heat: 68, cool: 71 },
  { zone: 'C102 Computer Lab - 139', heat: 66, cool: 70 },
  { zone: 'C119-C121 F.C.S./Stor./Pantry', heat: 69, cool: 71 },
  { zone: 'D119 Media Center RTU-5', heat: 67, cool: 71 },
  { zone: 'D130/A Small Group/Resource', heat: 69, cool: 70 },
  { zone: 'D131 South Corridor', heat: 69, cool: 70 },
  { zone: 'D133 Classroom', heat: 70, cool: 70 },
  { zone: 'D134 Classroom', heat: 69, cool: 70 },
];

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
function _wdN(v, dec) {
  var n = parseFloat(v) || 0;
  return n.toLocaleString(undefined, { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
}
function _wdC(v) {
  var n = parseFloat(v) || 0;
  return (
    (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}
function _wdIsSummer(moIdx) {
  return WOODLAND_SUMMER_MONTH_IDX.indexOf(moIdx) !== -1;
}

// -----------------------------------------------------------------------
// _rptTotalAvgRow — generic Total + Average row builder (Coordinator constraint 4: every
// table on every page needs BOTH a bold Total row and an Average row; confirmed net-new,
// no existing helper does this — every current report table emits Total only).
// cols: array of {sum:number, dec:number, fmt:'n'|'c'|'text'} — one entry per numeric column,
// in the same left-to-right order as the table's <td> cells (label column excluded).
// labelColspan/labelText: the leading label cell for each row ("TOTAL" / "AVERAGE").
// nMonths: divisor for the Average row (defaults 12).
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
      return '<td class="rpt-n">' + (c.fmt === 'text' ? c.text || '' : fmtCell(c, c.sum)) + '</td>';
    })
    .join('');
  var avgCells = cols
    .map(function (c) {
      return '<td class="rpt-n">' + (c.fmt === 'text' ? '' : fmtCell(c, c.sum / n)) + '</td>';
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
        regrCoeffs = { type: 'cdd', intercept: reg.cdd.intercept, slope: reg.cdd.slope };
        regrType = 'OLS / CDD';
        r2 = reg.cdd.r2;
      } else if (reg.hdd && reg.hdd.r2 != null) {
        regrCoeffs = { type: 'hdd', intercept: reg.hdd.intercept, slope: reg.hdd.slope };
        regrType = 'OLS / HDD';
        r2 = reg.hdd.r2;
      }
    }
    return { months: months, rows: rows, regrCoeffs: regrCoeffs, regrType: regrType, r2: r2 };
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
      };
    })
    .sort(function (a, c) {
      return a.letter < c.letter ? -1 : a.letter > c.letter ? 1 : 0;
    });

  // Dollarize each option with SEASONAL MARGINAL rates, monthly then summed (never blended,
  // never a raw dollar delta) — the audit-corrected formula.
  options.forEach(function (o) {
    var R = WOODLAND_SEASONAL_RATES;
    var monthly = [];
    var totGas = 0,
      totElec = 0,
      totDem = 0;
    for (var i = 0; i < 12; i++) {
      var summer = _wdIsSummer(i);
      var gasR = summer ? R.gasSummer : R.gasWinter;
      var elecR = summer ? R.elecEnergySummer : R.elecEnergyWinter;
      var demR = summer ? R.demandSummer : R.demandWinter;
      var gas$ = (o.gas[i] || 0) * gasR;
      var elec$ = (o.kwh[i] || 0) * elecR;
      var dem$ = (o.kw[i] || 0) * demR;
      monthly.push({ gas$: gas$, elec$: elec$, dem$: dem$, total$: gas$ + elec$ + dem$, summer: summer });
      totGas += gas$;
      totElec += elec$;
      totDem += dem$;
    }
    o.monthly = monthly;
    o.annualGas$ = totGas;
    o.annualElec$ = totElec;
    o.annualDem$ = totDem;
    o.annualTotal$ = totGas + totElec + totDem;
    o.installCost = WOODLAND_INSTALL_COST;
    o.paybackYrs = o.annualTotal$ > 0 ? o.installCost / o.annualTotal$ : null;
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

  return {
    project: { id: p.id, name: p.name, client: p.client || p.name || '' },
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
// generateWoodlandReportHTML(data) — 7 rptPage()-wrapped pages
// -----------------------------------------------------------------------
function generateWoodlandReportHTML(data) {
  // rptPageWoodlandBASCalc (logical page 5, "BAS Savings Calculation") renders as 2 physical
  // sheets (5 and 6) — see its own doc comment — so Options/Charts shift to physical pages 7/8.
  var pages = [
    rptPageWoodlandBills(1, data),
    rptPageWoodlandBaseline(2, data),
    rptPageWoodlandSummary(3, data),
    rptPageWoodlandHVAC(4, data),
    rptPageWoodlandBASCalc(5, data), // returns pages 5 AND 6
    rptPageWoodlandOptions(7, data),
    rptPageWoodlandCharts(8, data),
  ];
  return pages.join('');
}
window.generateWoodlandReportHTML = generateWoodlandReportHTML;

// =========================================================================
// PAGE 1 — Raw Utility Data
// =========================================================================
function rptPageWoodlandBills(n, d) {
  function meterTable(bl, meter, unitLabel, isElec) {
    if (!bl || !bl.rows.length) {
      return '<div class="rpt-su">No baseline bill data found for this meter.</div>';
    }
    var head = isElec
      ? '<tr><th>Month</th><th class="rpt-n">Days</th><th class="rpt-n">Billed kWh</th><th class="rpt-n">Demand kW</th><th class="rpt-n">Total Cost</th><th class="rpt-n">Effective $/kWh</th></tr>'
      : '<tr><th>Month</th><th class="rpt-n">Days</th><th class="rpt-n">Billed Therms</th><th class="rpt-n">Total Cost</th><th class="rpt-n">Effective $/Therm</th></tr>';
    var rowsHtml = '';
    var sums = isElec
      ? [
          { sum: 0, dec: 0 }, // kWh
          { sum: 0, dec: 1 }, // kW (avg, not summed meaningfully but shown for completeness)
          { sum: 0, dec: 2, fmt: 'c' }, // cost
          { sum: 0, dec: 4, fmt: 'text', text: '' },
        ]
      : [
          { sum: 0, dec: 1 }, // Therms
          { sum: 0, dec: 2, fmt: 'c' }, // cost
          { sum: 0, dec: 4, fmt: 'text', text: '' },
        ];
    bl.rows.forEach(function (r) {
      var bill = r.bill;
      var moIdx = parseInt(r.ym.split('-')[1], 10) - 1;
      var moLabel = WOODLAND_MO_ABBR[moIdx] + ' ' + r.ym.split('-')[0];
      var days = parseFloat(bill.numberOfDays) || _wdDaysInMonth(r.ym);
      var cost = parseFloat(bill.totalCost) || 0;
      if (isElec) {
        var kwh = parseFloat(bill.kwh) || 0;
        var kw = parseFloat(bill.billedKW || bill.demandKW) || 0;
        var effRate = kwh > 0 ? cost / kwh : 0;
        sums[0].sum += kwh;
        sums[1].sum += kw;
        sums[2].sum += cost;
        rowsHtml +=
          '<tr><td>' +
          moLabel +
          '</td><td class="rpt-n">' +
          days +
          '</td><td class="rpt-n">' +
          _wdN(kwh) +
          '</td><td class="rpt-n">' +
          _wdN(kw, 1) +
          '</td><td class="rpt-n">' +
          _wdC(cost) +
          '</td><td class="rpt-n">$' +
          effRate.toFixed(4) +
          '</td></tr>';
      } else {
        var therms = parseFloat(bill.naturalGasTherms) || (parseFloat(bill.naturalGasMMbtu) || 0) * 10;
        var effRateT = therms > 0 ? cost / therms : 0;
        sums[0].sum += therms;
        sums[1].sum += cost;
        rowsHtml +=
          '<tr><td>' +
          moLabel +
          '</td><td class="rpt-n">' +
          days +
          '</td><td class="rpt-n">' +
          _wdN(therms, 1) +
          '</td><td class="rpt-n">' +
          _wdC(cost) +
          '</td><td class="rpt-n">$' +
          effRateT.toFixed(4) +
          '</td></tr>';
      }
    });
    // Average column for demand kW should be an average of the 12 monthly demands, not a sum —
    // handled naturally since _rptTotalAvgRow divides every column's sum by n; for demand that
    // still reads as "average monthly demand kW", which is the meaningful figure for that column.
    var totAvg = _rptTotalAvgRow(sums, 'TOTAL (Annual)', 12);
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
    '<div class="rpt-su">Raw utility bills for the 12-month baseline period (' +
    (d.elecBL
      ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[0].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[0].split('-')[0]
      : '—') +
    ' – ' +
    (d.elecBL
      ? WOODLAND_MO_FULL[parseInt(d.elecBL.months[11].split('-')[1], 10) - 1] + ' ' + d.elecBL.months[11].split('-')[0]
      : '—') +
    "), read directly from each meter's stored monthly bills. Kilowatt-hours (kWh) measure electric energy use; kilowatts (kW) measure peak electric demand; Therms measure natural gas use.</div>" +
    '<h2>Electric — ' +
    (d.elecMeter ? 'Account ' + (d.elecMeter.account || '—') : 'No electric meter') +
    '</h2>' +
    meterTable(d.elecBL, d.elecMeter, 'kWh', true) +
    '<h2>Natural Gas — ' +
    (d.gasMeter ? 'Account ' + (d.gasMeter.account || '—') : 'No gas meter') +
    '</h2>' +
    meterTable(d.gasBL, d.gasMeter, 'Therms', false);

  return rptPage(n, 'Raw Utility Bill Data', body, { data: { project: d.project }, letterhead: false });
}

// =========================================================================
// PAGE 2 — Baseline Selection + Weather Normalization
// =========================================================================
function rptPageWoodlandBaseline(n, d) {
  var bl = d.elecBL;
  var body = '';
  body +=
    '<div class="rpt-su">The 12-month baseline period is ' +
    (bl ? bl.months.length : 0) +
    ' consecutive calendar months of billed usage, selected as the most recent full year of data available for this building: ' +
    (bl ? WOODLAND_MO_FULL[parseInt(bl.months[0].split('-')[1], 10) - 1] + ' ' + bl.months[0].split('-')[0] : '—') +
    ' through ' +
    (bl ? WOODLAND_MO_FULL[parseInt(bl.months[11].split('-')[1], 10) - 1] + ' ' + bl.months[11].split('-')[0] : '—') +
    ". Weather normalization adjusts each month's predicted usage for that month's actual heating degree days (HDD) and cooling degree days (CDD), so the baseline reflects typical weather rather than one specific year's conditions.</div>";

  if (bl && bl.regrCoeffs) {
    var rc = bl.regrCoeffs;
    var eqn = 'Electric kWh = ' + rc.intercept.toFixed(4) + ' × Days';
    if (rc.type === 'dual') eqn += ' + ' + rc.slopeHDD.toFixed(4) + ' × HDD + ' + rc.slopeCDD.toFixed(4) + ' × CDD';
    else if (rc.type === 'hdd') eqn += ' + ' + rc.slope.toFixed(4) + ' × HDD';
    else eqn += ' + ' + rc.slope.toFixed(4) + ' × CDD';

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
    var sums = [
      { sum: 0, dec: 0 }, // HDD
      { sum: 0, dec: 0 }, // CDD
      { sum: 0, dec: 0 }, // Predicted
      { sum: 0, dec: 0 }, // Actual
    ];
    bl.months.forEach(function (ym) {
      var moIdx = parseInt(ym.split('-')[1], 10) - 1;
      var moLabel = WOODLAND_MO_FULL[moIdx] + ' ' + ym.split('-')[0];
      var days = _wdDaysInMonth(ym);
      var wx = d.wxByYm[ym] || { hdd: 0, cdd: 0 };
      var predicted = rc.intercept * days;
      var calc = rc.intercept.toFixed(2) + '×' + days;
      if (rc.type === 'dual') {
        predicted += rc.slopeHDD * wx.hdd + rc.slopeCDD * wx.cdd;
        calc +=
          ' + ' +
          rc.slopeHDD.toFixed(2) +
          '×' +
          Math.round(wx.hdd) +
          ' + ' +
          rc.slopeCDD.toFixed(2) +
          '×' +
          Math.round(wx.cdd);
      } else if (rc.type === 'hdd') {
        predicted += rc.slope * wx.hdd;
        calc += ' + ' + rc.slope.toFixed(2) + '×' + Math.round(wx.hdd);
      } else {
        predicted += rc.slope * wx.cdd;
        calc += ' + ' + rc.slope.toFixed(2) + '×' + Math.round(wx.cdd);
      }
      predicted = Math.max(0, predicted);
      var row = bl.rows.find(function (r) {
        return r.ym === ym;
      });
      var actual = row ? parseFloat(row.bill.kwh) || 0 : 0;
      sums[0].sum += wx.hdd || 0;
      sums[1].sum += wx.cdd || 0;
      sums[2].sum += predicted;
      sums[3].sum += actual;
      rows +=
        '<tr><td>' +
        moLabel +
        '</td><td class="rpt-n">' +
        days +
        '</td><td class="rpt-n">' +
        Math.round(wx.hdd || 0) +
        '</td><td class="rpt-n">' +
        Math.round(wx.cdd || 0) +
        '</td><td style="font-family:var(--rpt-mono);font-size:9px">' +
        calc +
        '</td><td class="rpt-n">' +
        _wdN(predicted) +
        '</td><td class="rpt-n">' +
        _wdN(actual) +
        '</td></tr>';
    });
    body +=
      '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr><th style="width:15%">Month</th><th class="rpt-n" style="width:5%">Days</th><th class="rpt-n" style="width:6%">HDD</th><th class="rpt-n" style="width:6%">CDD</th><th style="width:40%">Calculation</th><th class="rpt-n" style="width:14%">Predicted kWh</th><th class="rpt-n" style="width:14%">Actual kWh</th></tr></thead><tbody>' +
      rows +
      _rptTotalAvgRow(sums, 'TOTAL (Annual)', 12) +
      '</tbody></table>';
  }

  body +=
    '<h2>Natural Gas Baseline</h2>' +
    '<div class="rpt-su">Natural gas is billed under a Trigger-Fixed / Index (FOM) / SWE commodity structure (Wood River Energy) — driven by the monthly price index, not weather. The gas baseline uses the 12 billed Therms totals from the previous page directly, with no weather adjustment.</div>';

  return rptPage(n, 'Baseline Selection & Weather Normalization', body, {
    data: { project: d.project },
    letterhead: false,
  });
}

// =========================================================================
// PAGE 3 — Baseline Summary
// =========================================================================
function rptPageWoodlandSummary(n, d) {
  var elecKwh = 0,
    elecKw = 0,
    elecCost = 0,
    gasTherms = 0,
    gasCost = 0;
  if (d.elecBL) {
    d.elecBL.rows.forEach(function (r) {
      elecKwh += parseFloat(r.bill.kwh) || 0;
      elecCost += parseFloat(r.bill.totalCost) || 0;
      elecKw = Math.max(elecKw, parseFloat(r.bill.billedKW || r.bill.demandKW) || 0);
    });
  }
  if (d.gasBL) {
    d.gasBL.rows.forEach(function (r) {
      gasTherms += parseFloat(r.bill.naturalGasTherms) || (parseFloat(r.bill.naturalGasMMbtu) || 0) * 10;
      gasCost += parseFloat(r.bill.totalCost) || 0;
    });
  }
  var totalCost = elecCost + gasCost;
  var sqft = d.building.sqft || 0;
  var elecKbtu = elecKwh * 3.412;
  var gasKbtu = gasTherms * 100;
  var totalKbtu = elecKbtu + gasKbtu;
  var eui = sqft > 0 ? totalKbtu / sqft : 0;

  var body =
    '<div class="rpt-su">Annual baseline usage and cost by commodity, for the 12-month baseline period.</div>' +
    '<table class="rpt-table"><thead><tr><th>Commodity</th><th class="rpt-n">Annual Usage</th><th class="rpt-n">Peak Demand (kW)</th><th class="rpt-n">Annual Cost</th></tr></thead><tbody>' +
    '<tr><td>Electric</td><td class="rpt-n">' +
    _wdN(elecKwh) +
    ' kWh</td><td class="rpt-n">' +
    _wdN(elecKw, 2) +
    '</td><td class="rpt-n">' +
    _wdC(elecCost) +
    '</td></tr>' +
    '<tr><td>Natural Gas</td><td class="rpt-n">' +
    _wdN(gasTherms, 1) +
    ' Therms</td><td class="rpt-n">—</td><td class="rpt-n">' +
    _wdC(gasCost) +
    '</td></tr>' +
    '<tr class="rpt-tot"><td>TOTAL (Combined)</td><td class="rpt-n">—</td><td class="rpt-n">—</td><td class="rpt-n">' +
    _wdC(totalCost) +
    '</td></tr>' +
    '</tbody></table>' +
    '<h2>Energy Use Intensity (EUI)</h2>' +
    '<div class="rpt-su">EUI converts every commodity to one common energy unit (thousand British Thermal Units, kBtu) per square foot per year, so electric and gas usage can be compared and benchmarked on one scale.</div>' +
    '<table class="rpt-table"><tbody>' +
    '<tr><td>Electric energy in kBtu</td><td class="rpt-n">' +
    _wdN(elecKwh) +
    ' kWh × 3.412 kBtu/kWh = ' +
    _wdN(elecKbtu) +
    ' kBtu</td></tr>' +
    '<tr><td>Gas energy in kBtu</td><td class="rpt-n">' +
    _wdN(gasTherms, 1) +
    ' Therms × 100 kBtu/Therm = ' +
    _wdN(gasKbtu) +
    ' kBtu</td></tr>' +
    '<tr class="rpt-tot"><td>Total site energy</td><td class="rpt-n">' +
    _wdN(totalKbtu) +
    ' kBtu</td></tr>' +
    '<tr><td>Building floor area</td><td class="rpt-n">' +
    _wdN(sqft) +
    ' sq ft</td></tr>' +
    '<tr class="rpt-tot"><td>Baseline EUI</td><td class="rpt-n">' +
    _wdN(totalKbtu) +
    ' kBtu ÷ ' +
    _wdN(sqft) +
    ' sq ft = ' +
    eui.toFixed(1) +
    ' kBtu/sq ft/yr</td></tr>' +
    '</tbody></table>';

  return rptPage(n, 'Baseline Summary', body, { data: { project: d.project }, letterhead: false });
}

// =========================================================================
// PAGE 4 — Estimated HVAC Cooling and Heating
// =========================================================================
function rptPageWoodlandHVAC(n, d) {
  var elecKwh = 0;
  if (d.elecBL)
    d.elecBL.rows.forEach(function (r) {
      elecKwh += parseFloat(r.bill.kwh) || 0;
    });
  var coolKwh = 185665; // Site HVAC Load Estimation — verified baseline cooling energy estimate
  var coolPct = elecKwh > 0 ? (coolKwh / elecKwh) * 100 : 0;
  var heatPct = 72; // Site HVAC Load Estimation — verified baseline heating share of HVAC load

  var body =
    '<div class="rpt-su">The building\'s heating is served primarily by a central hydronic hot-water system (58 of 59 zones) with electric-heat rooftop units serving the remaining zones; cooling is served by direct-expansion (DX) rooftop and split-system equipment. The HVAC Load Estimation splits the annual baseline electric usage into a cooling-attributable share and a non-cooling share, and characterizes the relative size of the heating load using the gas-fired hydronic system\'s dominant role at this site.</div>' +
    '<h2>Cooling — Electric-Attributable Share of Baseline</h2>' +
    '<table class="rpt-table"><tbody>' +
    '<tr><td>Annual baseline electric usage</td><td class="rpt-n">' +
    _wdN(elecKwh) +
    ' kWh</td></tr>' +
    '<tr><td>Estimated annual cooling energy</td><td class="rpt-n">' +
    _wdN(coolKwh) +
    ' kWh</td></tr>' +
    '<tr class="rpt-tot"><td>Cooling share of baseline electric</td><td class="rpt-n">' +
    _wdN(coolKwh) +
    ' ÷ ' +
    _wdN(elecKwh) +
    ' = ' +
    coolPct.toFixed(1) +
    '%</td></tr>' +
    '</tbody></table>' +
    '<h2>Heating — Dominant HVAC End Use</h2>' +
    '<div class="rpt-su">Heating is the larger of the building\'s two conditioning loads: an estimated ' +
    heatPct +
    "% of the site's total HVAC thermal energy (gas heating plus HVAC-attributable electric) is heating-dominated, versus " +
    coolPct.toFixed(1) +
    '% cooling-dominated, consistent with a gas-fired hydronic heating plant serving nearly the entire building.</div>' +
    '<table class="rpt-table"><tbody>' +
    '<tr><td>Estimated heating share of total HVAC load</td><td class="rpt-n">' +
    heatPct +
    '%</td></tr>' +
    '<tr><td>Estimated cooling share of total HVAC load</td><td class="rpt-n">' +
    coolPct.toFixed(1) +
    '%</td></tr>' +
    '</tbody></table>';

  return rptPage(n, 'Estimated HVAC Cooling & Heating', body, { data: { project: d.project }, letterhead: false });
}

// =========================================================================
// PAGE 5 — BAS Savings Calculation — Method and Detail
// =========================================================================
// rptPageWoodlandBASCalc renders as TWO physical .rpt-page sheets (n and n+1) — the real,
// per-zone setpoint/schedule data (Matt, 2026-09-22: "use REAL client data everywhere") plus the
// full per-month calculation grid does not fit one 8.5x11 page without clipping (measured:
// ~1660px of content against an 876px page-body budget). Zero clipping is a hard requirement
// (Coordinator VERIFY step); the "7 pages" content structure still holds — this is one logical
// page (5, "BAS Savings Calculation") split across 2 physical sheets, same as this codebase's
// own multi-page appendices. Callers must reserve n AND n+1 for this function and shift every
// following page number by 1 (see generateWoodlandReportHTML).
function rptPageWoodlandBASCalc(n, d) {
  var optA = d.options[0];
  var zc = WOODLAND_ZONE_COUNTS;
  var monitorList = WOODLAND_MONITOR_ONLY_ZONES.map(function (z) {
    return z.zone + ' ' + z.heat + '°F/' + z.cool + '°F';
  }).join('; ');
  var nonstdList = WOODLAND_NONSTANDARD_STANDARD_ZONES.map(function (z) {
    return z.zone + ' ' + z.heat + '°F/' + z.cool + '°F';
  }).join('; ');

  var body =
    '<div class="rpt-su">This page reproduces the BAS occupied-setpoint savings model using the real, per-zone current setpoints from the site\'s BAS points decomposition (87 of 87 zones) — inputs, the per-month calculation grid, the method notes (calibration), and the result — worked in full for Option ' +
    (optA ? optA.letter : 'A') +
    ' (' +
    (optA ? optA.heatSP + '°F / ' + optA.coolSP + '°F' : '') +
    '), the safest first move of the three options.</div>' +
    '<h2>Occupied Schedule Change (all 87 zones, uniform, verified)</h2>' +
    '<table class="rpt-table rpt-mp-dense"><thead><tr><th></th><th>Occupied Hours, Monday–Friday</th><th>Occupied, Saturday &amp; Sunday</th></tr></thead><tbody>' +
    '<tr><td>Existing (Effective Schedules export)</td><td>6:00 AM – 6:00 PM</td><td>None (fully unoccupied)</td></tr>' +
    '<tr><td>Proposed (all 3 options)</td><td>8:00 AM – 4:00 PM</td><td>None (fully unoccupied)</td></tr>' +
    '</tbody></table>' +
    '<h2>Occupied Setpoint Change by Zone Group (real per-zone data, 87 of 87 zones)</h2>' +
    '<table class="rpt-table rpt-mp-dense rpt-table-wrap"><thead><tr><th style="width:26%">Zone Group</th><th class="rpt-n" style="width:8%">Zones</th><th style="width:22%">Existing Occupied Setpoint</th><th class="rpt-n" style="width:14%">Option A</th><th class="rpt-n" style="width:14%">Option B</th><th class="rpt-n" style="width:14%">Option C</th></tr></thead><tbody>' +
    '<tr><td>Standard zones (moved to uniform target)</td><td class="rpt-n">' +
    zc.standard +
    ' of ' +
    zc.total +
    '</td><td>68°F/70°F typical (62 zones); 10 zones differ — see below</td><td class="rpt-n">68°F / 72°F</td><td class="rpt-n">69°F / 73°F</td><td class="rpt-n">70°F / 74°F</td></tr>' +
    '<tr><td>Kitchen RTU-7 (cooking-equipment load, kept fixed)</td><td class="rpt-n">' +
    zc.kitchenFixed +
    ' of ' +
    zc.total +
    '</td><td>' +
    WOODLAND_KITCHEN_ZONE.heat +
    '°F / ' +
    WOODLAND_KITCHEN_ZONE.cool +
    '°F</td><td class="rpt-n">No change</td><td class="rpt-n">No change</td><td class="rpt-n">No change</td></tr>' +
    '<tr><td>Monitoring-only, no heating actuator (excluded from savings)</td><td class="rpt-n">' +
    zc.monitorOnly +
    ' of ' +
    zc.total +
    '</td><td>Varies — see below</td><td class="rpt-n">Not applicable</td><td class="rpt-n">Not applicable</td><td class="rpt-n">Not applicable</td></tr>' +
    '</tbody></table>' +
    '<div class="rpt-su" style="font-size:10px">10 standard zones start from a non-68°F/70°F existing occupied setpoint today, still converging to the same Option A/B/C target as every other standard zone: ' +
    nonstdList +
    '.</div>' +
    '<div class="rpt-su" style="font-size:10px">14 zones have no local heating actuator (exhaust-fan or monitoring points only) and are excluded from the savings calculation; their existing occupied setpoints are unchanged: ' +
    monitorList +
    '.</div>' +
    '<h2>Unoccupied Setpoint Standard by Heat Type</h2>' +
    '<table class="rpt-table rpt-mp-dense"><thead><tr><th>Heat Type</th><th class="rpt-n">Zones</th><th>Existing Unoccupied</th><th>Proposed Unoccupied</th></tr></thead><tbody>' +
    '<tr><td>Hydronic hot-water reheat</td><td class="rpt-n">' +
    zc.hydronic +
    ' of ' +
    zc.total +
    '</td><td>65°F / 85°F</td><td>55°F / 85°F (58 of 59 zones changed)</td></tr>' +
    '<tr><td>Electric heat (packaged RTU heat strip)</td><td class="rpt-n">' +
    zc.electricRTU +
    ' of ' +
    zc.total +
    '</td><td>65°F / 85°F</td><td>65°F / 85°F (already met, 0 zones changed)</td></tr>' +
    '<tr><td>No local heat actuator</td><td class="rpt-n">' +
    zc.monitorOnly +
    ' of ' +
    zc.total +
    '</td><td>Existing value retained</td><td>No new standard assigned (no actuator to act on)</td></tr>' +
    '</tbody></table>';

  var page5a = rptPage(n, 'BAS Savings Calculation — Setpoints & Method', body, {
    data: { project: d.project },
    letterhead: false,
  });

  var body2 =
    '<div class="rpt-su" style="font-size:10px;margin-bottom:2px">Basis: 4% HVAC energy change per 1°F setpoint shift, occupied-hours only (3–5%/°F planning range); 73 of 87 zones (83.9%) carry both actuators; 30 of 87 zones already hold a persistent occupant +2°F adjustment matching Option A, the lowest-risk option.</div>' +
    '<h2 style="margin:4px 0 2px">Seasonal Marginal Rates (Calibration)</h2>' +
    '<div class="rpt-su" style="font-size:10px;margin-bottom:2px">Savings are dollarized at the seasonal MARGINAL rate, monthly, then summed — never blended, never a raw dollar delta.</div>' +
    '<table class="rpt-table rpt-mp-dense"><thead><tr><th>Rate</th><th class="rpt-n">Summer (Jun–Sep)</th><th class="rpt-n">Winter (Oct–May)</th></tr></thead><tbody>' +
    '<tr><td>Natural gas ($/Therm)</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.gasSummer.toFixed(3) +
    '</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.gasWinter.toFixed(3) +
    '</td></tr>' +
    '<tr><td>Electric energy ($/kWh)</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.elecEnergySummer.toFixed(4) +
    '</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.elecEnergyWinter.toFixed(4) +
    '</td></tr>' +
    '<tr><td>Electric demand ($/kW)</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.demandSummer.toFixed(3) +
    '</td><td class="rpt-n">$' +
    WOODLAND_SEASONAL_RATES.demandWinter.toFixed(3) +
    '</td></tr>' +
    '</tbody></table>';
  if (optA) {
    var rows = '';
    var sums = [
      { sum: 0, dec: 1 }, // heat therms
      { sum: 0, dec: 2, fmt: 'c' }, // gas $
      { sum: 0, dec: 0 }, // cool kwh
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
        _wdN(optA.gas[i] || 0, 1) +
        '</td><td class="rpt-n">' +
        _wdC(mo.gas$) +
        '</td>' +
        '<td class="rpt-n">' +
        _wdN(optA.kwh[i] || 0) +
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
      _rptTotalAvgRow(sums, 'TOTAL (Annual)', 12) +
      '</tbody></table>' +
      '<h2 style="margin:4px 0 2px">Result</h2>' +
      '<table class="rpt-table rpt-mp-dense" style="margin:2px 0"><tbody>' +
      '<tr class="rpt-tot"><td style="padding:2px 6px">Annual $ saved</td><td class="rpt-n" style="padding:2px 6px">' +
      _wdC(optA.annualTotal$) +
      '</td></tr>' +
      '<tr><td style="padding:2px 6px">Install cost (BAS labor)</td><td class="rpt-n" style="padding:2px 6px">' +
      WOODLAND_LABOR_HOURS +
      ' hr × $' +
      WOODLAND_LABOR_RATE +
      '/hr = ' +
      _wdC(optA.installCost) +
      '</td></tr>' +
      '<tr class="rpt-tot"><td style="padding:2px 6px">Simple payback</td><td class="rpt-n" style="padding:2px 6px">' +
      _wdC(optA.installCost) +
      ' ÷ ' +
      _wdC(optA.annualTotal$) +
      ' = ' +
      optA.paybackYrs.toFixed(2) +
      ' years</td></tr>' +
      '</tbody></table>';
  }

  var page5b = rptPage(n + 1, 'BAS Savings Calculation — Per-Month Detail & Result', body2, {
    data: { project: d.project },
    letterhead: false,
  });

  return page5a + page5b;
}

// =========================================================================
// PAGE 6 — Table of All Savings Options (A/B/C)
// =========================================================================
function rptPageWoodlandOptions(n, d) {
  var body =
    '<div class="rpt-su">Estimated projected savings from a setpoint-change ECM — not measured M&V. Each option raises occupied cooling setpoint and lowers occupied heating setpoint by 1°F relative to the prior option; savings are dollarized at the seasonal marginal rate, monthly, then summed.</div>' +
    '<table class="rpt-table rpt-table-wrap rpt-mp-dense" style="table-layout:fixed"><thead><tr>' +
    '<th style="width:8%">Option</th>' +
    '<th class="rpt-n" style="width:9%">Occ. Heat / Cool SP</th>' +
    '<th class="rpt-n" style="width:9%">Heat Therms Saved</th>' +
    '<th class="rpt-n" style="width:9%">Cool kWh Saved</th>' +
    '<th class="rpt-n" style="width:9%">Peak Demand kW Saved</th>' +
    '<th class="rpt-n" style="width:9%">Gas $ Saved</th>' +
    '<th class="rpt-n" style="width:10%">Electric Energy $ Saved</th>' +
    '<th class="rpt-n" style="width:9%">Demand $ Saved</th>' +
    '<th class="rpt-n" style="width:10%">Total $ Saved</th>' +
    '<th class="rpt-n" style="width:9%">Install Cost</th>' +
    '<th class="rpt-n" style="width:9%">Payback (yrs)</th>' +
    '</tr></thead><tbody>';

  var sums = [
    { sum: 0, dec: 1, fmt: 'text', text: '' }, // SP col — not summable
    { sum: 0, dec: 1 },
    { sum: 0, dec: 0 },
    { sum: 0, dec: 2 },
    { sum: 0, dec: 2, fmt: 'c' },
    { sum: 0, dec: 2, fmt: 'c' },
    { sum: 0, dec: 2, fmt: 'c' },
    { sum: 0, dec: 2, fmt: 'c' },
    { sum: 0, dec: 2, fmt: 'c' },
    { sum: 0, dec: 2, fmt: 'text', text: '' }, // payback — not summable
  ];

  d.options.forEach(function (o) {
    sums[1].sum += o.annualHeatTherms;
    sums[2].sum += o.annualCoolKwh;
    sums[3].sum += o.peakDemandKw;
    sums[4].sum += o.annualGas$;
    sums[5].sum += o.annualElec$;
    sums[6].sum += o.annualDem$;
    sums[7].sum += o.annualTotal$;
    sums[8].sum += o.installCost;

    body +=
      '<tr><td>Option ' +
      o.letter +
      '</td><td class="rpt-n">' +
      o.heatSP +
      '°F / ' +
      o.coolSP +
      '°F</td>' +
      '<td class="rpt-n">' +
      _wdN(o.annualHeatTherms, 1) +
      '</td><td class="rpt-n">' +
      _wdN(o.annualCoolKwh) +
      '</td>' +
      '<td class="rpt-n">' +
      _wdN(o.peakDemandKw, 2) +
      '</td><td class="rpt-n">' +
      _wdC(o.annualGas$) +
      '</td>' +
      '<td class="rpt-n">' +
      _wdC(o.annualElec$) +
      '</td><td class="rpt-n">' +
      _wdC(o.annualDem$) +
      '</td>' +
      '<td class="rpt-n" style="font-weight:700">' +
      _wdC(o.annualTotal$) +
      '</td><td class="rpt-n">' +
      _wdC(o.installCost) +
      '</td>' +
      '<td class="rpt-n">' +
      o.paybackYrs.toFixed(2) +
      '</td></tr>';

    // Show-your-work sub-rows: one peak-summer month (August) and one peak-winter month
    // (January), literally spelled out — Coordinator constraint 2.
    var aug = o.monthly[7],
      jan = o.monthly[0];
    body +=
      '<tr><td colspan="11" style="font-size:10px;font-style:italic;color:var(--rpt-page-text);border-top:none">' +
      'Show your work — August (peak summer): ' +
      _wdN(o.kwh[7]) +
      ' kWh × $' +
      WOODLAND_SEASONAL_RATES.elecEnergySummer.toFixed(4) +
      ' + ' +
      _wdN(o.kw[7], 2) +
      ' kW × $' +
      WOODLAND_SEASONAL_RATES.demandSummer.toFixed(3) +
      ' + ' +
      _wdN(o.gas[7], 1) +
      ' Therms × $' +
      WOODLAND_SEASONAL_RATES.gasSummer.toFixed(3) +
      ' = ' +
      _wdC(aug.total$) +
      ' &nbsp; | &nbsp; January (peak winter): ' +
      _wdN(o.kwh[0]) +
      ' kWh × $' +
      WOODLAND_SEASONAL_RATES.elecEnergyWinter.toFixed(4) +
      ' + ' +
      _wdN(o.kw[0], 2) +
      ' kW × $' +
      WOODLAND_SEASONAL_RATES.demandWinter.toFixed(3) +
      ' + ' +
      _wdN(o.gas[0], 1) +
      ' Therms × $' +
      WOODLAND_SEASONAL_RATES.gasWinter.toFixed(3) +
      ' = ' +
      _wdC(jan.total$) +
      '</td></tr>';
  });

  body += _rptTotalAvgRow(sums, 'TOTAL (All Options)', d.options.length || 1) + '</tbody></table>';

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
  var paybackChart = _woodlandGroupedBarSVG(
    opts,
    [{ key: 'paybackYrs', label: 'Simple Payback (yrs)', colorVar: 'var(--rpt-green)' }],
    'Simple Payback by Option (Years)',
    function (v) {
      return v.toFixed(1);
    },
  );

  var body =
    '<div class="rpt-su">Side-by-side comparison of the three setpoint options: total annual dollar savings by end use, and simple payback in years.</div>' +
    '<div id="woodlandChartsPage">' +
    '<div style="margin:10px 0">' +
    dollarChart +
    '</div>' +
    '<div style="margin:10px 0">' +
    paybackChart +
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

  // ---- Sheet 1: Bills ----
  var ws1 = wb.addWorksheet('Page 1 - Bills');
  ws1.columns = [{ width: 14 }, { width: 8 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 16 }];
  titleRow(ws1, 'Raw Utility Bill Data — Woodland Springs Middle School');
  if (data.elecBL && data.elecBL.rows.length) {
    ws1.addRow(['Electric']);
    var hRow1 = ws1.addRow(['Month', 'Days', 'Billed kWh', 'Demand kW', 'Total Cost', 'Eff. $/kWh']);
    styleHeaderRow(hRow1);
    var firstDataRow1 = ws1.rowCount + 1;
    data.elecBL.rows.forEach(function (r) {
      var b = r.bill;
      var kwh = parseFloat(b.kwh) || 0;
      var kw = parseFloat(b.billedKW || b.demandKW) || 0;
      var cost = parseFloat(b.totalCost) || 0;
      ws1.addRow([r.ym, parseFloat(b.numberOfDays) || _wdDaysInMonth(r.ym), kwh, kw, cost, kwh > 0 ? cost / kwh : 0]);
    });
    var lastDataRow1 = ws1.rowCount;
    var totR1 = ws1.addRow([
      'TOTAL (Annual)',
      null,
      { formula: 'SUM(C' + firstDataRow1 + ':C' + lastDataRow1 + ')' },
      { formula: 'AVERAGE(D' + firstDataRow1 + ':D' + lastDataRow1 + ')' },
      { formula: 'SUM(E' + firstDataRow1 + ':E' + lastDataRow1 + ')' },
      null,
    ]);
    styleTotalRow(totR1);
    var avgR1 = ws1.addRow([
      'Average (per month)',
      null,
      { formula: 'AVERAGE(C' + firstDataRow1 + ':C' + lastDataRow1 + ')' },
      { formula: 'AVERAGE(D' + firstDataRow1 + ':D' + lastDataRow1 + ')' },
      { formula: 'AVERAGE(E' + firstDataRow1 + ':E' + lastDataRow1 + ')' },
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
      var therms = parseFloat(b.naturalGasTherms) || (parseFloat(b.naturalGasMMbtu) || 0) * 10;
      var cost = parseFloat(b.totalCost) || 0;
      ws1.addRow([
        r.ym,
        parseFloat(b.numberOfDays) || _wdDaysInMonth(r.ym),
        therms,
        null,
        cost,
        therms > 0 ? cost / therms : 0,
      ]);
    });
    var lastDataRow2 = ws1.rowCount;
    var totR2 = ws1.addRow([
      'TOTAL (Annual)',
      null,
      { formula: 'SUM(C' + firstDataRow2 + ':C' + lastDataRow2 + ')' },
      null,
      { formula: 'SUM(E' + firstDataRow2 + ':E' + lastDataRow2 + ')' },
      null,
    ]);
    styleTotalRow(totR2);
    var avgR2 = ws1.addRow([
      'Average (per month)',
      null,
      { formula: 'AVERAGE(C' + firstDataRow2 + ':C' + lastDataRow2 + ')' },
      null,
      { formula: 'AVERAGE(E' + firstDataRow2 + ':E' + lastDataRow2 + ')' },
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
  titleRow(ws2, 'Baseline Selection & Weather Normalization');
  if (data.elecBL && data.elecBL.regrCoeffs) {
    var rc = data.elecBL.regrCoeffs;
    var eqnParts = ['Electric kWh = ' + rc.intercept.toFixed(4) + ' x Days'];
    if (rc.type === 'dual')
      eqnParts.push('+ ' + rc.slopeHDD.toFixed(4) + ' x HDD + ' + rc.slopeCDD.toFixed(4) + ' x CDD');
    ws2.addRow(['Regression (' + data.elecBL.regrType + ', R2=' + data.elecBL.r2.toFixed(3) + ')']);
    ws2.addRow([eqnParts.join(' ')]);
    ws2.addRow([]);
    var hRow3 = ws2.addRow(['Month', 'Days', 'HDD', 'CDD', 'Calculation', 'Predicted kWh', 'Actual kWh']);
    styleHeaderRow(hRow3);
    var firstDataRow3 = ws2.rowCount + 1;
    data.elecBL.months.forEach(function (ym) {
      var days = _wdDaysInMonth(ym);
      var wx = data.wxByYm[ym] || { hdd: 0, cdd: 0 };
      var predicted = rc.intercept * days;
      var calc = rc.intercept.toFixed(2) + 'x' + days;
      if (rc.type === 'dual') {
        predicted += rc.slopeHDD * wx.hdd + rc.slopeCDD * wx.cdd;
        calc +=
          ' + ' +
          rc.slopeHDD.toFixed(2) +
          'x' +
          Math.round(wx.hdd) +
          ' + ' +
          rc.slopeCDD.toFixed(2) +
          'x' +
          Math.round(wx.cdd);
      }
      predicted = Math.max(0, predicted);
      var row = data.elecBL.rows.find(function (r) {
        return r.ym === ym;
      });
      var actual = row ? parseFloat(row.bill.kwh) || 0 : 0;
      ws2.addRow([
        ym,
        days,
        Math.round(wx.hdd || 0),
        Math.round(wx.cdd || 0),
        calc,
        Math.round(predicted),
        Math.round(actual),
      ]);
    });
    var lastDataRow3 = ws2.rowCount;
    var totR3 = ws2.addRow([
      'TOTAL (Annual)',
      { formula: 'SUM(B' + firstDataRow3 + ':B' + lastDataRow3 + ')' },
      { formula: 'SUM(C' + firstDataRow3 + ':C' + lastDataRow3 + ')' },
      { formula: 'SUM(D' + firstDataRow3 + ':D' + lastDataRow3 + ')' },
      null,
      { formula: 'SUM(F' + firstDataRow3 + ':F' + lastDataRow3 + ')' },
      { formula: 'SUM(G' + firstDataRow3 + ':G' + lastDataRow3 + ')' },
    ]);
    styleTotalRow(totR3);
    var avgR3 = ws2.addRow([
      'Average (per month)',
      { formula: 'AVERAGE(B' + firstDataRow3 + ':B' + lastDataRow3 + ')' },
      { formula: 'AVERAGE(C' + firstDataRow3 + ':C' + lastDataRow3 + ')' },
      { formula: 'AVERAGE(D' + firstDataRow3 + ':D' + lastDataRow3 + ')' },
      null,
      { formula: 'AVERAGE(F' + firstDataRow3 + ':F' + lastDataRow3 + ')' },
      { formula: 'AVERAGE(G' + firstDataRow3 + ':G' + lastDataRow3 + ')' },
    ]);
    styleAvgRow(avgR3);
  }
  ws2.addRow([]);
  ws2.addRow([
    'Natural gas is billed under a Trigger-Fixed / Index (FOM) / SWE commodity structure — no weather regression fitted; the 12 billed monthly Therms totals (Page 1) are used directly.',
  ]);

  // ---- Sheet 3: Baseline Summary ----
  var ws3 = wb.addWorksheet('Page 3 - Summary');
  ws3.columns = [{ width: 26 }, { width: 20 }, { width: 16 }, { width: 16 }];
  titleRow(ws3, 'Baseline Summary');
  var elecKwh = 0,
    elecKw = 0,
    elecCost = 0,
    gasTherms = 0,
    gasCost = 0;
  if (data.elecBL)
    data.elecBL.rows.forEach(function (r) {
      elecKwh += parseFloat(r.bill.kwh) || 0;
      elecCost += parseFloat(r.bill.totalCost) || 0;
      elecKw = Math.max(elecKw, parseFloat(r.bill.billedKW || r.bill.demandKW) || 0);
    });
  if (data.gasBL)
    data.gasBL.rows.forEach(function (r) {
      gasTherms += parseFloat(r.bill.naturalGasTherms) || (parseFloat(r.bill.naturalGasMMbtu) || 0) * 10;
      gasCost += parseFloat(r.bill.totalCost) || 0;
    });
  var hRow4 = ws3.addRow(['Commodity', 'Annual Usage', 'Peak Demand (kW)', 'Annual Cost']);
  styleHeaderRow(hRow4);
  var elecRowNum = ws3.rowCount + 1;
  ws3.addRow(['Electric', elecKwh, elecKw, elecCost]);
  var gasRowNum = ws3.rowCount + 1;
  ws3.addRow(['Natural Gas', gasTherms, null, gasCost]);
  var totR4 = ws3.addRow(['TOTAL (Combined)', null, null, { formula: 'D' + elecRowNum + '+D' + gasRowNum }]);
  styleTotalRow(totR4);
  ws3.addRow([]);
  var sqft = data.building.sqft || 0;
  var elecKbtu = elecKwh * 3.412,
    gasKbtu = gasTherms * 100,
    totalKbtu = elecKbtu + gasKbtu;
  ws3.addRow(['Energy Use Intensity (EUI)']);
  ws3.addRow(['Electric energy (kBtu)', elecKbtu]);
  ws3.addRow(['Gas energy (kBtu)', gasKbtu]);
  var totKbtuRow = ws3.rowCount + 1;
  ws3.addRow(['Total site energy (kBtu)', totalKbtu]);
  ws3.addRow(['Building floor area (sq ft)', sqft]);
  var euiRow = ws3.addRow(['Baseline EUI (kBtu/sq ft/yr)', { formula: 'B' + totKbtuRow + '/B' + (totKbtuRow + 1) }]);
  styleTotalRow(euiRow);

  // ---- Sheet 4: HVAC ----
  var ws4 = wb.addWorksheet('Page 4 - HVAC Split');
  ws4.columns = [{ width: 40 }, { width: 20 }];
  titleRow(ws4, 'Estimated HVAC Cooling & Heating');
  var coolKwh = 185665;
  ws4.addRow(['Annual baseline electric usage (kWh)', elecKwh]);
  ws4.addRow(['Estimated annual cooling energy (kWh)', coolKwh]);
  var coolPctRow = ws4.addRow(['Cooling share of baseline electric', { formula: 'B3/B2' }]);
  styleTotalRow(coolPctRow);
  ws4.getCell('B' + coolPctRow.number).numFmt = '0.0%';
  ws4.addRow([]);
  ws4.addRow(['Estimated heating share of total HVAC load (%)', 0.72]);
  ws4.getCell('B' + ws4.rowCount).numFmt = '0.0%';
  ws4.addRow(['Estimated cooling share of total HVAC load (%)', coolKwh / (elecKwh || 1)]);
  ws4.getCell('B' + ws4.rowCount).numFmt = '0.0%';

  // ---- Sheet 5: BAS Savings Calc ----
  var ws5 = wb.addWorksheet('Page 5 - BAS Calc');
  ws5.columns = [
    { width: 22 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];
  titleRow(ws5, 'BAS Savings Calculation — Method & Detail');
  var optA = data.options[0];
  ws5.addRow(['Occupied schedule', 'Existing 6:00 AM-6:00 PM', 'Proposed 8:00 AM-4:00 PM (all options)']);
  ws5.addRow(['Standard zones (moved to target)', WOODLAND_ZONE_COUNTS.standard + ' of ' + WOODLAND_ZONE_COUNTS.total]);
  ws5.addRow(['Kitchen RTU-7 (kept fixed)', WOODLAND_KITCHEN_ZONE.heat + '/' + WOODLAND_KITCHEN_ZONE.cool]);
  ws5.addRow([
    'Monitoring-only zones (excluded)',
    WOODLAND_ZONE_COUNTS.monitorOnly + ' of ' + WOODLAND_ZONE_COUNTS.total,
  ]);
  ws5.addRow(['Hydronic unoccupied standard', '65/85 -> 55/85 (58 of 59 zones)']);
  ws5.addRow(['Electric RTU unoccupied standard', '65/85 (already met, 0 changed)']);
  ws5.addRow([]);
  if (optA) {
    ws5.addRow(['Seasonal Marginal Rates', 'Summer (Jun-Sep)', 'Winter (Oct-May)']);
    ws5.addRow(['Gas ($/Therm)', WOODLAND_SEASONAL_RATES.gasSummer, WOODLAND_SEASONAL_RATES.gasWinter]);
    ws5.addRow([
      'Electric energy ($/kWh)',
      WOODLAND_SEASONAL_RATES.elecEnergySummer,
      WOODLAND_SEASONAL_RATES.elecEnergyWinter,
    ]);
    ws5.addRow(['Electric demand ($/kW)', WOODLAND_SEASONAL_RATES.demandSummer, WOODLAND_SEASONAL_RATES.demandWinter]);
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
        return { formula: 'SUM(' + c + firstDataRow5 + ':' + c + lastDataRow5 + ')' };
      }),
    ]);
    styleTotalRow(totR5);
    var avgR5 = ws5.addRow([
      'Average (per month)',
      ...cols5.map(function (c) {
        return { formula: 'AVERAGE(' + c + firstDataRow5 + ':' + c + lastDataRow5 + ')' };
      }),
    ]);
    styleAvgRow(avgR5);
    ws5.addRow([]);
    ws5.addRow(['Annual $ saved', { formula: 'G' + totR5.number }]);
    ws5.addRow(['Install cost (8 hr x $173/hr)', optA.installCost]);
    var pbRow = ws5.addRow(['Simple payback (years)', { formula: 'B' + ws5.rowCount + '/B' + (ws5.rowCount - 1) }]);
    styleTotalRow(pbRow);
  }

  // ---- Sheet 6: Options A/B/C ----
  var ws6 = wb.addWorksheet('Page 6 - Options ABC');
  ws6.columns = [
    { width: 12 },
    { width: 16 },
    { width: 16 },
    { width: 14 },
    { width: 18 },
    { width: 12 },
    { width: 16 },
    { width: 18 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
  ];
  titleRow(ws6, 'Savings Options Comparison — A / B / C');
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
    'Install Cost',
    'Payback (yrs)',
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
      o.installCost,
      o.paybackYrs,
    ]);
  });
  var lastDataRow6 = ws6.rowCount;
  var cols6 = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  var totR6 = ws6.addRow([
    'TOTAL (All Options)',
    null,
    ...cols6.map(function (c) {
      return { formula: 'SUM(' + c + firstDataRow6 + ':' + c + lastDataRow6 + ')' };
    }),
    null,
  ]);
  styleTotalRow(totR6);
  var avgR6 = ws6.addRow([
    'Average',
    null,
    ...cols6.map(function (c) {
      return { formula: 'AVERAGE(' + c + firstDataRow6 + ':' + c + lastDataRow6 + ')' };
    }),
    null,
  ]);
  styleAvgRow(avgR6);

  // ---- Sheet 7: Charts ----
  var ws7 = wb.addWorksheet('Page 7 - Charts');
  ws7.columns = [{ width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  titleRow(ws7, 'Charts — Savings Options Comparison');
  ws7.addRow(['Option', 'Gas $ Saved', 'Electric Energy $ Saved', 'Demand $ Saved', 'Payback (yrs)']);
  data.options.forEach(function (o) {
    ws7.addRow(['Option ' + o.letter, o.annualGas$, o.annualElec$, o.annualDem$, o.paybackYrs]);
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
