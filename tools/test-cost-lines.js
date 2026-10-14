/**
 * test-cost-lines.js  (Phase 7, 2026-10-14)
 *
 * Checks the cost lines and the ONE payback function (computations/cost-lines.js) with synthetic data only.
 *   1. Totals: third-party, parts and labor add to the total cost; the incentive is taken off to give the net cost.
 *   2. Labor is hours x the rate passed in (the pricing estimator hourly rate); a labor line with no hours costs 0 (no invented default).
 *   3. simplePayback = (total cost - incentive) / annual savings; no cost or no savings gives no payback (null); an incentive larger
 *      than the cost gives 0 years.
 *   4. The Fan Savings template brings one labor line "Reprogram BAS for variable speed" with NO hours; other templates bring none.
 *   5. Every displayed payback calls simplePayback: the app files hold no other payback (tools/gate-single-payback.js passes), and the
 *      gate FAILS on a second copy (a payback variable, a retired cost field, a second definition).
 *   6. Hostile text in a vendor, description, note, measure name or building name is escaped: real render (vm) of the Financials block and
 *      the Cost Estimate roll-up, no raw tag in the output.
 *   7. solarCostLines (kW x 1000 x $/W; credit % of cost; zero/blank inputs; Add as Measure gets exactly those lines).
 *   8. One-time data move of the old implCost / incentive fields to cost lines (idempotent).
 * Usage: node tools/test-cost-lines.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let fails = 0;
function ok(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) fails++;
}
function near(a, b) {
  return Math.abs(a - b) < 1e-9;
}

const CL = require(path.join(REPO, 'computations', 'cost-lines.js'));

// 1-2. totals
{
  const m = {
    costLines: [
      CL.newCostLine('thirdParty', { label: 'Drive supply and start-up', vendor: 'Example Partner A', amount: 12000 }),
      CL.newCostLine('parts', { label: 'Cabling', amount: 800 }),
      CL.newCostLine('labor', { label: 'Reprogram', hours: 8 }),
      CL.newCostLine('incentive', { label: 'Utility rebate', amount: 2500, note: 'Pre-approval 12345' }),
    ],
  };
  const t = CL.measureCostTotals(m, 170);
  ok(near(t.thirdParty, 12000) && near(t.parts, 800), 'third-party and parts totals');
  ok(near(t.labor, 8 * 170) && near(t.laborHours, 8), 'labor = hours x rate passed in (' + t.labor + ')');
  ok(near(t.gross, 12000 + 800 + 1360), 'total cost excludes the incentive (' + t.gross + ')');
  ok(near(t.incentive, 2500), 'incentive total');
  const noHours = CL.measureCostTotals({ costLines: [CL.newCostLine('labor', { label: 'x', hours: null })] }, 170);
  ok(noHours.gross === 0, 'a labor line with no hours costs 0');
  const bad = CL.measureCostTotals(
    { costLines: [CL.newCostLine('parts', { amount: 'abc' }), CL.newCostLine('parts', { amount: -5 })] },
    170,
  );
  ok(bad.gross === 0, 'text and negative amounts count as 0');
  ok(
    CL.measureCostTotals({}, 170).gross === 0 && CL.measureCostTotals(null, 170).gross === 0,
    'a measure with no cost lines costs 0',
  );
  const sum = CL.sumCostTotals([t, t]);
  ok(near(sum.gross, 2 * t.gross) && near(sum.incentive, 5000), 'sumCostTotals adds measures');

  // 3. payback
  const p = CL.simplePayback(t.gross, t.incentive, 4000);
  ok(
    near(p.net, t.gross - 2500) && near(p.years, (t.gross - 2500) / 4000),
    'simplePayback = (cost - incentive) / annual savings (' + p.years + ')',
  );
  ok(CL.simplePayback(0, 0, 4000).years === null, 'no cost: no payback');
  ok(CL.simplePayback(5000, 0, 0).years === null, 'no savings: no payback');
  ok(CL.simplePayback(5000, 6000, 1000).years === 0, 'incentive over the cost: 0 years');
}

// 4. template lines
{
  const fan = CL.defaultCostLinesFor('fan_savings');
  ok(
    fan.length === 1 && fan[0].kind === 'labor' && fan[0].label === 'Reprogram BAS for variable speed',
    'Fan Savings brings the reprogram labor line',
  );
  ok(fan[0].hours === null, 'the reprogram line has no default hours');
  ok(CL.defaultCostLinesFor('oa_dampers').length === 0, 'another template brings no cost line');
  const a = CL.defaultCostLinesFor('fan_savings')[0].id;
  const b = CL.defaultCostLinesFor('fan_savings')[0].id;
  ok(a !== b, 'each added line has its own id');
}

// 5. gate, and the gate fails on a second copy
{
  const gate = require('./gate-single-payback.js');
  const real = gate.check(REPO);
  ok(
    real.length === 0,
    'gate-single-payback passes on the tree' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''),
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-gate-'));
  try {
    const mk = (extra) => {
      fs.rmSync(path.join(tmp, 'app'), { recursive: true, force: true });
      fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'computations'), { recursive: true });
      fs.copyFileSync(
        path.join(REPO, 'computations', 'cost-lines.js'),
        path.join(tmp, 'computations', 'cost-lines.js'),
      );
      fs.writeFileSync(path.join(tmp, 'app', 'energy-savings.js'), 'function a(){ return simplePayback(1,0,1); }\n');
      Object.keys(extra).forEach((f) => fs.writeFileSync(path.join(tmp, 'app', f), extra[f]));
      return gate.check(tmp);
    };
    ok(mk({}).length === 0, 'gate passes on a clean mini tree');
    ok(mk({ 'x.js': 'const payback = net / annual;\n' }).length > 0, 'gate fails on a payback variable');
    ok(mk({ 'x.js': 'o.paybackYrs = c / s;\n' }).length > 0, 'gate fails on a payback field');
    ok(mk({ 'x.js': 'const t = m.implCost - 1;\n' }).length > 0, 'gate fails on the retired implCost');
    ok(mk({ 'x.js': 'const t = m.incentive;\n' }).length > 0, 'gate fails on a measure .incentive');
    ok(
      mk({ 'x.js': 'function simplePayback(a,b,c){ return 1; }\n' }).length > 0,
      'gate fails on a second simplePayback',
    );
    ok(
      mk({ 'x.js': "const lbl = 'Simple payback'; const h = `<b>Payback ${y}</b>`;\n" }).length === 0,
      'gate allows the text "payback" in a label',
    );
    ok(mk({ 'x.js': '// payback = a / b\n/* payback */\n' }).length === 0, 'gate allows the word in a comment');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Shared sandbox: the REAL render functions cut out of their files, with synthetic stand-ins for the data they read.
const cut = (rel, startMark, endMark) => {
  const t = fs.readFileSync(path.join(REPO, rel), "utf8");
  const i = t.indexOf(startMark);
  if (i < 0) throw new Error("mark not found: " + startMark);
  return t.slice(i, t.indexOf(endMark, i));
};
const HOSTILE = "\"><img src=x onerror=1><script>alert(1)</script>'";
const proj = { id: "p1", savingsData: { measures: [], blRates: {} } };
const sb = {
  console,
  sget: () => null,
  sset() {},
  projects: [proj],
  getProjSavingsData: () => proj.savingsData,
  calcMeasureDollars: () => ({ total: 4000 }),
  measureRatesNow: () => ({}),
  _pricingGetConfig: () => ({ hourlyRate: 150 }),
  getUDBldg: () => ({ id: "b1", name: HOSTILE }),
  _pricingFmt: (n) => "$" + Math.round(n).toLocaleString(),
};
vm.createContext(sb);
vm.runInContext(
  fs.readFileSync(path.join(REPO, "lib", "formatting.js"), "utf8"),
  sb,
);
vm.runInContext(
  fs.readFileSync(path.join(REPO, "computations", "cost-lines.js"), "utf8"),
  sb,
);
vm.runInContext(
  cut(
    "app/energy-savings.js",
    "// ── Cost lines and payback (Phase 7",
    "function msrCostRefresh",
  ),
  sb,
);
vm.runInContext(
  cut(
    "app/pricing-estimator.js",
    "function _pricingSelectedMeasures",
    "function _pricingGetBudget",
  ),
  sb,
);

// 6. hostile text: real render of the Financials block and the Cost Estimate roll-up (vendor, description, note, measure name, building name)
{
  const m = {
    id: "m1",
    selected: true,
    msrNum: "1",
    bldgId: "b1",
    desc: HOSTILE,
    costLines: [
      CL.newCostLine("thirdParty", {
        id: HOSTILE,
        label: HOSTILE,
        vendor: HOSTILE,
        note: HOSTILE,
        amount: 5000,
      }),
      CL.newCostLine("labor", { label: HOSTILE, hours: 4, note: HOSTILE }),
    ],
  };
  proj.savingsData.measures = [m];
  const fin = sb._msrFinancialsInner("p1", m);
  const host = sb.msrFinancialsHtml("p1", m);
  const roll = sb._pricingMeasureCostRollupHTML("p1");
  ok(
    fin.includes("&lt;img") && fin.includes("&lt;script"),
    "Financials block: hostile text shows as escaped text",
  );
  ok(
    !/<img|<script/i.test(fin),
    "Financials block: no raw <img or <script in the output",
  );
  ok(
    !/<img|<script/i.test(host),
    "Financials host div: no raw <img or <script in the output",
  );
  ok(
    !/value="[^"]*"[^>]*onerror/i.test(fin) && !/"\s*onerror=/i.test(fin),
    "Financials block: no quote break-out into a live attribute",
  );
  ok(
    roll.length > 200 && roll.includes("&lt;img"),
    "Cost Estimate roll-up rendered with escaped hostile text",
  );
  ok(
    !/<img|<script/i.test(roll),
    "Cost Estimate roll-up: no raw <img or <script in the output (measure and building name)",
  );
}

// 7. solarCostLines: kW x 1000 x $/W, credit % of cost, zero and blank inputs, and the measure gets exactly those lines
{
  const sc = { newCostLine: CL.newCostLine, Math, Date, parseFloat };
  const ctx = vm.createContext(sc);
  vm.runInContext(
    cut(
      "app/calculators.js",
      "// solarCostLines - the ONE owner",
      "function solarAddAsMeasure",
    ),
    ctx,
  );
  const f = sc.solarCostLines;
  const a = f(10, 2.5, 30);
  ok(
    a.length === 2 && a[0].kind === "thirdParty" && near(a[0].amount, 25000),
    "10 kW x $2.50/W = $25,000 third-party line",
  );
  ok(
    a[1].kind === "incentive" && near(a[1].amount, 7500),
    "30% credit = $7,500 incentive line (30% of the cost)",
  );
  const t = CL.measureCostTotals({ costLines: a }, 150);
  const pb = CL.simplePayback(t.gross, t.incentive, 3500);
  ok(
    near(t.gross, 25000) &&
      near(t.incentive, 7500) &&
      near(pb.years, 17500 / 3500),
    "totals and payback of the solar lines (" + pb.years + " yrs)",
  );
  ok(f(0, 2.5, 30).length === 0, "0 kW gives no lines");
  ok(
    f(10, 0, 30).length === 0 && f(10, "", 30).length === 0,
    "$0 or blank per Watt gives no lines",
  );
  ok(
    f("", "", "").length === 0 && f(undefined, null, undefined).length === 0,
    "blank inputs give no lines",
  );
  const b = f(10, 2.5, 0);
  ok(
    b.length === 1 && b[0].kind === "thirdParty",
    "0% credit gives the cost line only",
  );
  ok(
    f(10, 2.5, "").length === 1 && f(10, 2.5, "abc").length === 1,
    "blank or text credit gives the cost line only",
  );
  ok(
    near(f("10", "2.5", "30")[0].amount, 25000),
    "text numbers from the inputs are read",
  );
  // the measure gets exactly those lines: run the real solarAddAsMeasure with stand-ins
  const added = [];
  const p = {
    id: "p9",
    solarCalc: { arrayKw: 10, costPerWatt: 2.5, taxCredit: 30 },
  };
  Object.assign(sc, {
    projects: [p],
    getProjSavingsData: () => ({ measures: added }),
    getUDBldgs: () => [{ id: "b1" }],
    solarMonthlyProduction: () => Array(12).fill(1000),
    initMeasureRates() {},
    sset() {},
    closeCalcTemplate() {},
    showToast() {},
  });
  vm.runInContext(
    cut(
      "app/calculators.js",
      "function solarAddAsMeasure",
      "function solarApplyToMeasure",
    ),
    ctx,
  );
  sc.solarAddAsMeasure("p9");
  ok(
    added.length === 1 &&
      added[0].costLines.length === 2 &&
      near(added[0].costLines[0].amount, 25000) &&
      near(added[0].costLines[1].amount, 7500),
    "Add as Measure puts exactly the solarCostLines on the measure",
  );
}

// 8. one-time data move of the old implCost / incentive fields (synthetic measures)
{
  const OLDC = "implCost";
  const OLDI = "incentive";
  const mk = (cost, inc, lines) => {
    const m = { id: "x", desc: "Synthetic measure" };
    if (cost !== undefined) m[OLDC] = cost;
    if (inc !== undefined) m[OLDI] = inc;
    if (lines) m.costLines = lines;
    return m;
  };
  const m1 = mk(12000, 2000);
  ok(
    CL.moveOldCostFieldsToLines(m1) === true,
    "a measure with old fields is changed",
  );
  ok(
    m1.costLines.length === 2 &&
      m1.costLines[0].kind === "thirdParty" &&
      m1.costLines[0].label === "Implementation cost (moved from old field)" &&
      near(m1.costLines[0].amount, 12000) &&
      m1.costLines[1].kind === "incentive" &&
      near(m1.costLines[1].amount, 2000),
    "implCost 12000 -> third-party line, incentive 2000 -> incentive line",
  );
  ok(!(OLDC in m1) && !(OLDI in m1), "the old fields are deleted");
  const snap = JSON.stringify(m1);
  ok(
    CL.moveOldCostFieldsToLines(m1) === false && JSON.stringify(m1) === snap,
    "a second run changes nothing (idempotent)",
  );
  const m2 = mk(0, 0);
  ok(
    CL.moveOldCostFieldsToLines(m2) === true && !m2.costLines && !(OLDC in m2),
    "old fields of 0 give no line and are deleted",
  );
  const m3 = mk("", null);
  CL.moveOldCostFieldsToLines(m3);
  ok(
    !m3.costLines && !(OLDC in m3) && !(OLDI in m3),
    "blank old fields give no line",
  );
  const m4 = mk(5000, undefined);
  CL.moveOldCostFieldsToLines(m4);
  ok(
    m4.costLines.length === 1 && m4.costLines[0].kind === "thirdParty",
    "cost only gives one third-party line",
  );
  const m5 = mk(undefined, 700);
  CL.moveOldCostFieldsToLines(m5);
  ok(
    m5.costLines.length === 1 && m5.costLines[0].kind === "incentive",
    "incentive only gives one incentive line",
  );
  const keep = [CL.newCostLine("parts", { label: "Kept", amount: 1 })];
  const m6 = mk(9000, 100, keep);
  CL.moveOldCostFieldsToLines(m6);
  ok(
    m6.costLines.length === 1 &&
      m6.costLines[0].label === "Kept" &&
      !(OLDC in m6),
    "a measure that has cost lines keeps them; old fields deleted",
  );
  ok(
    CL.moveOldCostFieldsToLines({ id: "n" }) === false &&
      CL.moveOldCostFieldsToLines(null) === false,
    "a measure with no old fields is untouched",
  );
  // the load-time caller moves every measure of every project and saves once
  const saved = [];
  const psList = [
    {
      id: "a",
      savingsData: { measures: [mk(300, 50), mk(undefined, undefined)] },
    },
    { id: "b" },
  ];
  const sb2 = {
    console,
    sget: () => psList,
    sset: (k, v) => saved.push([k, v]),
  };
  vm.createContext(sb2);
  vm.runInContext(
    fs.readFileSync(path.join(REPO, "computations", "cost-lines.js"), "utf8"),
    sb2,
  );
  vm.runInContext(
    cut(
      "app/energy-savings.js",
      "// One-time data move on load",
      "// Internal labor $/hr",
    ),
    sb2,
  );
  ok(
    sb2.migrateOldCostFieldsToLines() === 1 &&
      saved.length === 1 &&
      saved[0][0] === "en_projects",
    "load move: 1 measure moved, projects saved once",
  );
  ok(
    sb2.migrateOldCostFieldsToLines() === 0 && saved.length === 1,
    "load move: second load moves nothing and does not save",
  );
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
