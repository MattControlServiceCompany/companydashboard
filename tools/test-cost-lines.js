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
 *   6. Hostile text in a vendor name, description or note is escaped in the Financials block and in the Cost Estimate roll-up.
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

// 6. hostile text: static check that every user text of the two renderers goes through _escHtml
{
  const es = fs.readFileSync(path.join(REPO, 'app', 'energy-savings.js'), 'utf8');
  const pe = fs.readFileSync(path.join(REPO, 'app', 'pricing-estimator.js'), 'utf8');
  const body = es.slice(es.indexOf('function _msrFinancialsInner'), es.indexOf('function msrCostRefresh'));
  const raw = (body.match(/\$\{[^}]*\bl\.(label|vendor|note)\b[^}]*\}/g) || []).filter((x) => !/_escHtml\(/.test(x));
  ok(
    raw.length === 0,
    'Financials block: label, vendor and note are escaped' + (raw.length ? ' (raw: ' + raw.join(' ') + ')' : ''),
  );
  const rollup = pe.slice(
    pe.indexOf('function _pricingMeasureCostRollupHTML'),
    pe.indexOf('function _pricingMeasureCostRollupHTML') + 6000,
  );
  ok(
    /_escHtml\(m\.desc/.test(rollup) && /_escHtml\(b \? b\.name/.test(rollup),
    'Cost Estimate roll-up: measure and building names are escaped',
  );
  ok(!/onclick="[^"]*\$\{[^}]*(m\.id|l\.id)/.test(body), 'Financials block: no id is put inside a script string');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
