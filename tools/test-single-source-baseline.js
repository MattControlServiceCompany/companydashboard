// tools/test-single-source-baseline.js — Single-source-of-truth baseline regression gate.
// Run: node tools/test-single-source-baseline.js [path-to-backup.json]
//
// Loads the REAL app functions (computations/normalization.js buildMoMap/getNormRows/
// getMeterBaselineTotals, computations/eui.js computeKBtu/computeBaselineEUI, and
// app/report-engine.js rptBuildBaselineDataTable — extracted verbatim, not reimplemented) into
// a Node vm sandbox and proves every baseline-reading surface computes the SAME number from the
// SAME meter data:
//   - header strip                (core.js _updateCompactHdrBaseline's helper: getMeterBaselineTotals)
//   - Project Baseline panel      (utility-data.js renderUDProjAggPanel's getNormRows+buildMoMap loop)
//   - Energy Graphics EUI card    (graphics-setpoints.js egfxRefresh's buildMoMap loop + computeBaselineEUI)
//   - Baseline report table       (report-engine.js rptBuildBaselineDataTable, called directly)
//   - xlsx export data            (report-engine-woodland.js exportWoodlandReportToXlsx ws3 loop —
//                                  same eM.kwh/eM.totalCost/gM.therms/gM.cost field reads, verified
//                                  both numerically against the same buildMoMap object and by a
//                                  source-text assertion that the exporter reads those exact fields)
//
// SYNTHETIC fixture only is used for the committed pass/fail gate (never real client data in the
// repo). When a local CompanyHub backup is available (arg or latest in Downloads), this also runs
// the same 5-surface comparison against Woodland Spring Middle's real May 2025–Apr 2026 baseline
// and prints the surface x value table — informational only, not required for CI to pass.
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ─── Extract one top-level function verbatim from a source file (same technique as the
// 2026-09-22-project-baseline-divergence investigation's recompute.js) ──────────────────────────
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('function ' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + fnName + ' in ' + file);
  // Find the parameter list's matching close-paren first (2026-09-22 fix: a function with a
  // default-object param, e.g. `function rptPage(pageNum, title, bodyHTML, options = {})`, has
  // its FIRST '{' inside that default value, not the function body — the old version's
  // src.indexOf('{', m.index) grabbed that empty {} and truncated the extraction there).
  let p = src.indexOf('(', m.index);
  let pDepth = 0,
    pEnd = p;
  for (; pEnd < src.length; pEnd++) {
    if (src[pEnd] === '(') pDepth++;
    else if (src[pEnd] === ')') {
      pDepth--;
      if (pDepth === 0) break;
    }
  }
  let i = src.indexOf('{', pEnd);
  let depth = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, j + 1);
}

const sandbox = { console };
vm.createContext(sandbox);

const stubs = [
  "function calDaysInMonth(ym){const [y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate();}",
  'function getStoredRate(){return 0;}',
  'var udSelProjId = null;',
  'function getUDProj(){ return {}; }',
  'function isCalcCommodity(){ return true; }',
].join('\n');

const fns = [
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  loadFn(REPO + '/app/report-engine.js', 'rptBuildBaselineDataTable'),
];

const regressionSrc = fs.readFileSync(REPO + '/computations/regression.js', 'utf8');
const normalizationSrc = fs.readFileSync(REPO + '/computations/normalization.js', 'utf8');
const euiSrc = fs.readFileSync(REPO + '/computations/eui.js', 'utf8');
const ratesSrc = fs.readFileSync(REPO + '/computations/rates.js', 'utf8');
// resolveGasUsageTherms (2026-09-22): the ONE canonical gas-usage-field-chain helper
// (therms/naturalGasTherms/naturalGasMMbtu/naturalGasCCF/usage) — normalization.js's isGas
// branch now calls it instead of duplicating the chain inline, so it must load here too.
const savingsSrc = fs.readFileSync(REPO + '/computations/savings.js', 'utf8');

vm.runInContext(
  stubs +
    '\n' +
    fns.join('\n\n') +
    '\n\n' +
    regressionSrc +
    '\n\n' +
    savingsSrc +
    '\n\n' +
    normalizationSrc +
    '\n\n' +
    euiSrc +
    '\n\n' +
    ratesSrc,
  sandbox,
);

// Source-text assertion: the xlsx exporter's Baseline Summary sheet must read the same billed
// fields as every other surface (never the predicted/commodityCost fields it used to read).
const wdSrc = fs.readFileSync(REPO + '/app/report-engine-woodland.js', 'utf8');
assert(/var kwhM = eM\.kwh \|\| 0;/.test(wdSrc), 'xlsx export: kwhM reads eM.kwh (billed), not eM.kwhPredicted');
assert(
  /var elecCostM = eM\.totalCost \|\| 0;/.test(wdSrc),
  'xlsx export: elecCostM reads eM.totalCost (full billed), not eM.commodityCost',
);
assert(
  /var thermsM = gM\.therms \|\| 0;/.test(wdSrc),
  'xlsx export: thermsM reads gM.therms (billed), not gM.thermsPredicted',
);
assert(
  /sumF\('C', firstDataRow4, lastDataRow4\)/.test(wdSrc),
  'xlsx export: Annual kW (Actual) is a SUM, not avgF/peak',
);
assert(
  /sumF\('D', firstDataRow4, lastDataRow4\)/.test(wdSrc),
  'xlsx export: Annual kW (Billed) is a SUM, not avgF/peak',
);

// Same source-text assertion for the HTML report table (report-engine.js rptBuildBaselineDataTable).
const rptSrc = fs.readFileSync(REPO + '/app/report-engine.js', 'utf8');
assert(/var kwh = eM\.kwh \|\| 0,/.test(rptSrc), 'HTML report: kwh reads eM.kwh (billed)');
assert(
  /var elecCost = eM\.totalCost \|\| 0;/.test(rptSrc),
  'HTML report: elecCost reads eM.totalCost, not eM.commodityCost',
);
assert(/var therms = gM\.therms \|\| 0,/.test(rptSrc), 'HTML report: therms reads gM.therms (billed)');
assert(
  !/\(peak\)/.test(
    rptSrc.slice(
      rptSrc.indexOf('function rptBuildBaselineDataTable'),
      rptSrc.indexOf('function rptBuildBaselineDataTable') + 12000,
    ),
  ),
  'HTML report: Annual kW row never labeled "(peak)"',
);

// 2026-09-22 regression gate: Woodland page 1 raw-bills table (rptPageWoodlandBills) had its
// OWN separate "TOTAL (Annual)" kW cell bug — Math.max + a "(peak)" suffix — independent of
// rptBuildBaselineDataTable above (different function, different table). Same rule: a Total
// row is always a SUM of the 12 monthly billed kW, never a peak/max.
const rptPageWoodlandBillsSrc = wdSrc.slice(
  wdSrc.indexOf('function rptPageWoodlandBills'),
  wdSrc.indexOf('function rptPageWoodlandBaseline'),
);
assert(!/\(peak\)/.test(rptPageWoodlandBillsSrc), 'Woodland page 1 HTML: Annual kW row never labeled "(peak)"');
assert(
  !/Math\.max\(sums\[2\]\.sum/.test(rptPageWoodlandBillsSrc),
  'Woodland page 1 HTML: kW Total is not computed with Math.max',
);
assert(
  /sums\[2\]\.sum \+= kw;/.test(rptPageWoodlandBillsSrc),
  'Woodland page 1 HTML: kW Total accumulates as a running sum',
);

// Same rule for the Woodland xlsx export's Page 1 (Bills) sheet — ws1's Electric block.
const ws1Src = wdSrc.slice(
  wdSrc.indexOf('async function exportWoodlandReportToXlsx'),
  wdSrc.indexOf("ws1.addRow(['Natural Gas']);"),
);
assert(
  /sumF\('D', firstDataRow1, lastDataRow1\)/.test(ws1Src),
  'Woodland xlsx Page 1 sheet: Billed kW Total is SUM(D...), not MAX(D...)',
);
assert(!/MAX\(D/.test(ws1Src), 'Woodland xlsx Page 1 sheet: no MAX() formula on the kW Total cell');
assert(!/\(peak\)/i.test(ws1Src), 'Woodland xlsx Page 1 sheet: no "(peak)" note on the kW Total cell');

// ─── Page 7 "Demand kW Saved" (rptPageWoodlandOptions HTML + exportWoodlandReportToXlsx ws6) ────
// 2026-09-22 fix: this column was Math.max(monthly kW saved) — the single August peak — mislabeled
// "Peak Demand kW Saved". Rule: an annual kW figure is the SUM of the 12 monthly values.
assert(!/peakDemandKw/.test(wdSrc), 'Woodland options: no peakDemandKw field name remains anywhere in the file');
const demandKwSavedFormulaM =
  /o\.demandKwSaved = o\.kw\.reduce\(function \(s, v\) \{\s*return s \+ \(v \|\| 0\);\s*\}, 0\);/.exec(wdSrc);
assert(
  !!demandKwSavedFormulaM,
  'Woodland options: demandKwSaved is computed as a running SUM of the monthly kw[] array',
);
assert(
  !/Math\.max\.apply\(\s*null,\s*o\.kw\.map/.test(wdSrc),
  'Woodland options: no Math.max peak computation remains',
);

const optionsFnSrc = wdSrc.slice(
  wdSrc.indexOf('function rptPageWoodlandOptions'),
  wdSrc.indexOf('function _woodlandGroupedBarSVG'),
);
const optionHeaders = [...optionsFnSrc.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
assert(optionHeaders.length > 0, 'Woodland options page: header cells found for scan');
assert(
  optionHeaders.every((h) => !/peak/i.test(h)),
  'Woodland options page: no header cell contains "peak" (' + JSON.stringify(optionHeaders) + ')',
);
assert(optionHeaders.includes('Demand kW Saved'), 'Woodland options page: header reads exactly "Demand kW Saved"');
assert(/_wdN\(o\.demandKwSaved, 2\)/.test(optionsFnSrc), 'Woodland options HTML: data cell renders o.demandKwSaved');

const ws6HeaderRowM = /var hRow6 = ws6\.addRow\(\[([\s\S]*?)\]\);/.exec(wdSrc);
assert(!!ws6HeaderRowM, 'Woodland xlsx sheet 6: header row array found');
assert(ws6HeaderRowM && !/peak/i.test(ws6HeaderRowM[1]), 'Woodland xlsx sheet 6 header row: no cell contains "peak"');
assert(
  ws6HeaderRowM && /'Demand kW Saved'/.test(ws6HeaderRowM[1]),
  'Woodland xlsx sheet 6 header row: "Demand kW Saved" present',
);
const ws6BodyM = /data\.options\.forEach\(function \(o\) \{\s*ws6\.addRow\(\[([\s\S]*?)\]\);/.exec(wdSrc);
assert(
  ws6BodyM && /o\.demandKwSaved,/.test(ws6BodyM[1]),
  'Woodland xlsx sheet 6 row: reads o.demandKwSaved — the SAME field name the HTML page renders (single source of truth => HTML and xlsx agree)',
);

// Execute the REAL demandKwSaved formula (extracted verbatim above) against a synthetic 12-month
// kw[] array whose August value (19.2) is deliberately the max but NOT the sum, then render the
// REAL rptPageWoodlandOptions() HTML with that computed value — proving computation and rendering
// both land on the sum, end to end, not just via source-text pattern matching.
const wdOptionFns = [
  loadFn(REPO + '/app/report-engine.js', 'rptPage'),
  loadFn(REPO + '/app/report-engine-woodland.js', '_wdRoundHalfUp'),
  loadFn(REPO + '/app/report-engine-woodland.js', '_wdN'),
  loadFn(REPO + '/app/report-engine-woodland.js', '_wdC'),
  loadFn(REPO + '/app/report-engine-woodland.js', '_rptTotalAvgRow'),
  loadFn(REPO + '/app/report-engine-woodland.js', 'rptPageWoodlandOptions'),
];
function loadVarBlock(file, varName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('var ' + varName + '\\s*=\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + varName + ' in ' + file);
  let i = src.indexOf('{', m.index);
  let depth = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  let end = j + 1;
  if (src[end] === ';') end++;
  return src.slice(m.index, end);
}
const wdTextBlock = loadVarBlock(REPO + '/app/report-engine-woodland.js', 'WD_TEXT');
vm.runInContext(
  'var RPT_PAGENUM_DIV = \'<div class="rpt-pg-footer-pagenum"></div>\';\n' +
    wdTextBlock +
    '\n\n' +
    wdOptionFns.join('\n\n'),
  sandbox,
);
const wdKwByMo = [10, 12, 8, 5, 3, 2, 4, 19.2, 15, 9, 11, 13]; // August (index 7) = 19.2 = the peak, not the sum
const wdKwhByMo = [0, 0, 0, 50, 300, 900, 1200, 1100, 600, 100, 0, 0];
const wdGasByMo = [50, 45, 30, 10, 2, 0, 0, 0, 1, 15, 35, 48];
const wdOracleSum = wdKwByMo.reduce((a, v) => a + v, 0); // hand-computed, not the app's code
// Execute the exact statement captured from the real source file above (demandKwSavedFormulaM[0]),
// not a hand-retyped copy — a real regression in the app's formula would fail to match the regex
// and demandKwSavedFormulaM would already be null, failing the assertion above before we get here.
sandbox.__wdTestOption = { kw: wdKwByMo.slice() };
vm.runInContext('(function (o) { ' + demandKwSavedFormulaM[0] + ' })(__wdTestOption);', sandbox);
assert(
  near(sandbox.__wdTestOption.demandKwSaved, wdOracleSum, 0.001),
  'Woodland options: real demandKwSaved formula = SUM of monthly kw[] (' +
    sandbox.__wdTestOption.demandKwSaved +
    ' vs oracle ' +
    wdOracleSum +
    ')',
);
assert(
  !near(sandbox.__wdTestOption.demandKwSaved, 19.2, 0.001),
  'Woodland options: demandKwSaved is not just the August peak value (19.2)',
);
const wdOption = {
  letter: 'B',
  heatSP: 69,
  coolSP: 73,
  annualHeatTherms: wdGasByMo.reduce((a, v) => a + v, 0),
  annualCoolKwh: wdKwhByMo.reduce((a, v) => a + v, 0),
  demandKwSaved: sandbox.__wdTestOption.demandKwSaved,
  annualGas$: 500,
  annualElec$: 800,
  annualDem$: 700,
  annualTotal$: 2000,
  clientShare$: 1400,
  cscShare$: 600,
  gas: wdGasByMo,
  kwh: wdKwhByMo,
  kw: wdKwByMo,
  rates: {
    gasSummer: 0.5,
    gasWinter: 0.5,
    elecEnergySummer: 0.09,
    elecEnergyWinter: 0.08,
    demandSummer: 12,
    demandWinter: 8,
  },
  monthly: (() => {
    const arr = new Array(12);
    arr[0] = { gas$: 25, elec$: 0, dem$: 64, total$: 89, summer: false };
    arr[7] = { gas$: 0, elec$: 99, dem$: 230.4, total$: 329.4, summer: true };
    return arr;
  })(),
};
const wdD = { cfg: { clientSharePct: 70 }, options: [wdOption], project: { client: 'Test Building' } };
const optionsHTML = sandbox.rptPageWoodlandOptions(6, wdD);
assert(
  !/peak/i.test((optionsHTML.match(/<th[^>]*>[^<]*<\/th>/g) || []).join('')),
  'Rendered page 7 HTML: no <th> header contains "peak"',
);
assert(
  optionsHTML.includes('<td class="rpt-n">' + sandbox._wdN(wdOracleSum, 2) + '</td>'),
  'Rendered page 7 HTML: Demand kW Saved data cell shows the SUM (' +
    sandbox._wdN(wdOracleSum, 2) +
    '), not the August peak',
);

function runSurfaces(label, em, gm, sqft, blMonths) {
  const eBills = (em.bills || []).slice().sort((a, c) => sandbox._parseISO(a.start) - sandbox._parseISO(c.start));
  const gBills = (gm.bills || []).slice().sort((a, c) => sandbox._parseISO(a.start) - sandbox._parseISO(c.start));
  const eIncl = em.inclusive !== false,
    gIncl = gm.inclusive !== false;

  // 1. Header strip — getMeterBaselineTotals (the exact helper core.js now calls)
  const eTot = sandbox.getMeterBaselineTotals(em, eBills, eIncl);
  const gTot = sandbox.getMeterBaselineTotals(gm, gBills, gIncl);
  const header = {
    kwh: eTot.kwh,
    therms: gTot.therms,
    cost: eTot.cost + gTot.cost,
    kwTotal: eTot.billedKW,
  };

  // 2. Project Baseline panel — getNormRows + buildMoMap loop (utility-data.js renderUDProjAggPanel)
  const eRows = sandbox.getNormRows(em, eBills, eIncl, null);
  const eBlRows = eRows.filter((r) => blMonths.includes(r.ym));
  const eMap = sandbox.buildMoMap(em, eBlRows, eBills, eIncl).elecByMo;
  const gRows = sandbox.getNormRows(gm, gBills, gIncl, null);
  const gBlRows = gRows.filter((r) => blMonths.includes(r.ym));
  const gMap = sandbox.buildMoMap(gm, gBlRows, gBills, gIncl).gasByMo;
  let panelKwh = 0,
    panelCost = 0,
    panelTherms = 0,
    panelGasCost = 0,
    panelKwTotal = 0;
  for (let mo = 0; mo < 12; mo++) {
    panelKwh += eMap[mo]?.kwh || 0;
    panelCost += eMap[mo]?.totalCost || 0;
    panelKwTotal += eMap[mo]?.billedKW || 0;
    panelTherms += gMap[mo]?.therms || 0;
    panelGasCost += gMap[mo]?.cost || 0;
  }
  const panel = { kwh: panelKwh, therms: panelTherms, cost: panelCost + panelGasCost, kwTotal: panelKwTotal };

  // 3. Energy Graphics EUI card — same buildMoMap sums -> computeKBtu/computeBaselineEUI
  const blKBtu = sandbox.computeKBtu(panelKwh, panelTherms, 0);
  const eui = sandbox.computeBaselineEUI(blKBtu, blMonths.length, sqft);
  const graphics = { kwh: panelKwh, therms: panelTherms, eui };

  // 4. Baseline report table — the REAL rptBuildBaselineDataTable(), called directly
  const b = {
    sqft,
    commodities: ['Electric', 'Gas'],
    electric: { kwhBl: panelKwh },
    gas: { thermsBl: panelTherms },
    baselineMaps: { elecByMo: eMap, gasByMo: gMap, propaneByMo: {}, waterByMo: {} },
  };
  const d = { project: { id: 1 }, reportOptions: null };
  const opts = { has: { electric: true, gas: true, propane: false } };
  const reportHTML = sandbox.rptBuildBaselineDataTable(b, d, opts);
  // Annual row cell order (elec+gas both shown): kWh, Actual kW, Billed kW, kW Cost, Energy Cost,
  // Electric Cost, $/kWh, Therms, Gas Cost, $/Therm, Total Cost — pull all 11 cells in one shot.
  const annualRowM = /<tr class="rpt-tot"><td>Annual<\/td>((?:<td class="rpt-n">[^<]*<\/td>)+)<\/tr>/.exec(reportHTML);
  const annualCells = annualRowM
    ? [...annualRowM[1].matchAll(/<td class="rpt-n">([^<]*)<\/td>/g)].map((m) => m[1])
    : [];
  const num = (s) => (s ? parseFloat(String(s).replace(/[$,]/g, '')) : null);
  const euiStatM = /Site EUI \(kBtu\/SF\)<\/div><div class="bl-stat-val">([\d.]+)<\/div>/.exec(reportHTML);
  const report = {
    kwh: num(annualCells[0]),
    // Billed kW (3rd cell) — the plan's "kW Total = SUM of the 12 monthly billed kW".
    kwTotal: num(annualCells[2]),
    therms: num(annualCells[7]),
    cost: num(annualCells[10]),
    eui: euiStatM ? parseFloat(euiStatM[1]) : null,
  };

  // 5. xlsx export data — same eM.kwh/eM.totalCost/gM.therms/gM.cost field reads the exporter
  // uses (verified against wdBaselineBlock above); summed here over the SAME buildMoMap object.
  let xlsxKwh = 0,
    xlsxCost = 0,
    xlsxTherms = 0,
    xlsxGasCost = 0,
    xlsxKwTotal = 0;
  for (let mi = 0; mi < 12; mi++) {
    const eM = eMap[mi] || {},
      gM = gMap[mi] || {};
    xlsxKwh += eM.kwh || 0;
    xlsxCost += eM.totalCost || 0;
    xlsxKwTotal += eM.billedKW || 0;
    xlsxTherms += gM.therms || 0;
    xlsxGasCost += gM.cost || 0;
  }
  const xlsx = { kwh: xlsxKwh, therms: xlsxTherms, cost: xlsxCost + xlsxGasCost, kwTotal: xlsxKwTotal };

  console.log('\n=== ' + label + ' — surface x value ===');
  console.log('  surface              kWh            Therms         $              kW Total       EUI');
  const row = (name, v) =>
    console.log(
      '  ' +
        name.padEnd(20) +
        (v.kwh != null ? v.kwh.toFixed(1) : '—').padEnd(15) +
        (v.therms != null ? v.therms.toFixed(1) : '—').padEnd(15) +
        (v.cost != null ? v.cost.toFixed(2) : '—').padEnd(15) +
        (v.kwTotal != null ? v.kwTotal.toFixed(1) : '—').padEnd(15) +
        (v.eui != null ? v.eui.toFixed(2) : '—'),
    );
  row('header strip', header);
  row('Project Baseline panel', panel);
  row('Energy Graphics card', graphics);
  row('report page 1/3 table', report);
  row('xlsx export data', xlsx);

  return { header, panel, graphics, report, xlsx };
}

// ─── 1. SYNTHETIC fixture (committed gate — never real client data) ────────────────────────────
const sqft = 10000;
const blMonths = [];
const eBills = [],
  gBills = [];
const kwhByMo = [8000, 8200, 9000, 9500, 11000, 14000, 16000, 15500, 12500, 9800, 8600, 8100];
const kwByMo = [40, 41, 43, 46, 52, 62, 68, 66, 55, 47, 42, 40];
const eRateKwh = 0.09,
  eRateKw = 9.5;
const thermsByMo = [1200, 1050, 800, 400, 120, 20, 10, 10, 30, 300, 750, 1100];
const gRate = 0.85;
for (let mo = 0; mo < 12; mo++) {
  const y = 2025,
    m = mo + 1;
  const ym = y + '-' + String(m).padStart(2, '0');
  blMonths.push(ym);
  const dim = new Date(y, m, 0).getDate();
  const start = ym + '-01',
    end = ym + '-' + String(dim).padStart(2, '0');
  const kwh = kwhByMo[mo],
    kw = kwByMo[mo];
  const kwhCost = +(kwh * eRateKwh).toFixed(2);
  const kwCost = +(kw * eRateKw).toFixed(2);
  const customerCharge = 25;
  eBills.push({
    id: 'e' + mo,
    start,
    end,
    kwh,
    demandKW: kw,
    billedKW: kw,
    kwhCost,
    kwCost,
    totalCost: +(kwhCost + kwCost + customerCharge).toFixed(2),
  });
  const therms = thermsByMo[mo];
  const gasCharge = +(therms * gRate).toFixed(2);
  const gCustCharge = 15;
  gBills.push({
    id: 'g' + mo,
    start,
    end,
    therms,
    gasCharge,
    totalCost: +(gasCharge + gCustCharge).toFixed(2),
  });
}
const synthEM = { commodity: 'Electric', inclusive: true, bills: eBills, baseline: { months: blMonths } };
const synthGM = { commodity: 'Gas', inclusive: true, bills: gBills, baseline: { months: blMonths } };
const synthTotKwh = kwhByMo.reduce((a, b) => a + b, 0);
const synthTotTherms = thermsByMo.reduce((a, b) => a + b, 0);
const synthTotKw = kwByMo.reduce((a, b) => a + b, 0);
const synthTotCost = eBills.reduce((s, b) => s + b.totalCost, 0) + gBills.reduce((s, b) => s + b.totalCost, 0);
const synthEUI = sandbox.computeBaselineEUI(sandbox.computeKBtu(synthTotKwh, synthTotTherms, 0), 12, sqft);

const synth = runSurfaces('SYNTHETIC fixture', synthEM, synthGM, sqft, blMonths);

console.log(
  '\n  oracle (hand-computed from the fixture, not the app): kWh=' +
    synthTotKwh +
    ' Therms=' +
    synthTotTherms +
    ' $=' +
    synthTotCost.toFixed(2) +
    ' kWTotal=' +
    synthTotKw +
    ' EUI=' +
    synthEUI.toFixed(2),
);

// Not every surface displays every metric (the Energy Graphics EUI card shows kWh/Therms/EUI
// only, never $ or a kW total) — only assert a field where the surface actually reports it.
for (const [name, v] of Object.entries(synth)) {
  assert(near(v.kwh, synthTotKwh, 0.5), name + ': kWh matches oracle (' + v.kwh + ' vs ' + synthTotKwh + ')');
  assert(
    near(v.therms, synthTotTherms, 0.5),
    name + ': Therms matches oracle (' + v.therms + ' vs ' + synthTotTherms + ')',
  );
  if (v.cost != null)
    assert(
      near(v.cost, synthTotCost, 1),
      name + ': $ matches oracle (' + v.cost + ' vs ' + synthTotCost.toFixed(2) + ')',
    );
  if (v.kwTotal != null)
    assert(
      near(v.kwTotal, synthTotKw, 0.5),
      name + ': kW Total = SUM of monthly billed kW (' + v.kwTotal + ' vs ' + synthTotKw + ')',
    );
  if (v.eui != null)
    assert(
      near(v.eui, synthEUI, 0.1),
      name + ': EUI matches oracle (' + v.eui.toFixed(2) + ' vs ' + synthEUI.toFixed(2) + ')',
    );
}
// Cross-surface equality (the actual point of this gate): every surface must agree with every
// other surface on every field both of them report.
const surfaceNames = Object.keys(synth);
for (let i = 1; i < surfaceNames.length; i++) {
  const a = synth[surfaceNames[0]],
    b = synth[surfaceNames[i]];
  assert(near(a.kwh, b.kwh, 0.5), surfaceNames[0] + ' kWh == ' + surfaceNames[i] + ' kWh');
  assert(near(a.therms, b.therms, 0.5), surfaceNames[0] + ' Therms == ' + surfaceNames[i] + ' Therms');
  if (a.cost != null && b.cost != null)
    assert(near(a.cost, b.cost, 1), surfaceNames[0] + ' $ == ' + surfaceNames[i] + ' $');
  if (a.kwTotal != null && b.kwTotal != null)
    assert(near(a.kwTotal, b.kwTotal, 0.5), surfaceNames[0] + ' kW Total == ' + surfaceNames[i] + ' kW Total');
}

// ─── 2. Real backup (informational, NOT part of the committed pass/fail gate) ───────────────────
function findLatestBackup() {
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^CompanyHub-localdatafile-\d{8}\.json$/.test(f));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}
const backupPath = process.argv[2] || findLatestBackup();
if (backupPath && fs.existsSync(backupPath)) {
  console.log('\nUsing real backup (informational only): ' + backupPath);
  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const projId = 1781636180197; // Spring Hill Schools
  const ud = data['en_utility_' + projId];
  const b = ud && ud.buildings.find((x) => x.id === 'b1781636210689'); // Woodland Spring Middle
  if (b) {
    const em = b.meters.find((m) => m.commodity === 'Electric');
    const gm = b.meters.find((m) => m.commodity === 'Gas');
    const realSqft = parseInt(b.sqft) || 0;
    const realBlMonths = (em.baseline && em.baseline.months) || [];
    const real = runSurfaces('Woodland Spring Middle (real backup)', em, gm, realSqft, realBlMonths);
    console.log('\n  oracle (May 2025 - Apr 2026): kWh=739,249 Therms=24,092.7 EUI=47.96 $=117,281 (task spec)');
    for (const [name, v] of Object.entries(real)) {
      console.log(
        '  ' +
          name.padEnd(24) +
          'kWh diff=' +
          (v.kwh != null ? (v.kwh - 739249).toFixed(1) : '—') +
          '  Therms diff=' +
          (v.therms != null ? (v.therms - 24092.7).toFixed(1) : '—') +
          '  $ diff=' +
          (v.cost != null ? (v.cost - 117281).toFixed(1) : '—'),
      );
    }
  } else {
    console.log('\n(Woodland Spring Middle not found in this backup — skipping real-data section)');
  }
} else {
  console.log('\n(no local backup found — real-data section skipped, synthetic gate above is authoritative)');
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
