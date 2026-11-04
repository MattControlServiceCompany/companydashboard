// tools/test-scorecard-environmental.js — the Scorecard Environmental Impact panel shows equivalents when the
// building has savings. SYNTHETIC data only. Run: node tools/test-scorecard-environmental.js
// The saved energy comes from getMeterSavings().unitsByYM, totalled by totalUnitsWithPresented over the
// SAME months as the dollar figure (billableSavingsWithPresented), then calculatePollutionCredits (real file).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

function render(unitsByYM, byYM) {
  const calls = { dollarYms: null, unitYms: null, unitIn: null };
  const sb = { console, window: {}, document: {}, requestAnimationFrame: function () {} };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/pollution.js'), 'utf8'), sb);
  vm.runInContext(
    [
      'function isBaselineExcluded(){return false;}',
      'function getMeterSavings(){return {byYM:' + JSON.stringify(byYM) + ',unitsByYM:' + JSON.stringify(unitsByYM) + '};}',
      'function weatherWaitingQuarters(){return {};}',
      'function quarterKeyOfYM(y){return y.slice(0,4);}',
      'function getBillKwhCost(){return 0;} function getBillKwCost(){return 0;} function getBillOtherCost(){return 0;} function getBillTaxCost(){return 0;}',
      'function billMonth(b){return b.start.slice(0,7);}',
      'function resolveGasUsageTherms(b){return b.therms||0;}',
      'function computeKBtu(){return 0;} function computeSourceEUI(){return 0;} function estimateEnergyStarScore(){return 0;}',
      'function weatherWaitingLabel(){return "";} function savingsSignColor(){return "x";} function _escHtml(s){return s;}',
      'function billableSavingsWithPresented(p,yms,pb){__calls.dollarYms=yms.slice();var t=0;Object.keys(pb).forEach(function(k){yms.forEach(function(y){t+=pb[k][y]||0;});});var o={};Object.keys(pb).forEach(function(k){o[k]=t;});return {byBldg:o};}',
      'function totalUnitsWithPresented(p,yms,pu){__calls.unitYms=yms.slice();__calls.unitIn=pu;var r={kwh:0,therms:0,gallons:0};Object.keys(pu).forEach(function(k){yms.forEach(function(y){var u=pu[k][y];if(u){r.kwh+=u.kwh;r.therms+=u.therms;r.gallons+=u.gallons;}});});return r;}',
    ].join('\n'),
    Object.assign(sb, { __calls: calls }),
  );
  const src = fs.readFileSync(path.join(REPO, 'app/scorecard.js'), 'utf8');
  vm.runInContext(src, sb, { filename: 'app/scorecard.js' });
  const pane = { innerHTML: '' };
  const b = { id: 'b1', name: 'Synthetic Hall', sqft: 50000, state: 'KS', meters: [{ id: 'm1', commodity: 'Electric', bills: [{ start: '2026-01-01', kwh: 1 }] }] };
  vm.runInContext('renderBuildingScorecardPane', sb);
  sb.renderBuildingScorecardPane(pane, b, 1);
  return { html: pane.innerHTML, calls, sb };
}

const ym = (n) => '2026-' + String(n).padStart(2, '0');
const unitsByYM = {};
const byYM = {};
for (let i = 1; i <= 6; i++) {
  unitsByYM[ym(i)] = { kwh: 20000, kw: 5, therms: 100, gallons: 0 };
  byYM[ym(i)] = 500;
}
let r = render(unitsByYM, byYM);
ok(/cars removed/.test(r.html), 'savings present: panel shows cars removed');
ok(!/Savings data required/.test(r.html), 'savings present: no fallback message');
ok(JSON.stringify(r.calls.unitYms) === JSON.stringify(r.calls.dollarYms), 'units and dollars use the same months');
ok(r.calls.unitIn.b1['2026-03'].kwh === 20000, 'units are keyed by building and month');
const pc = r.sb.calculatePollutionCredits(120000, 600, 0, 'KS', 'lbs');
ok(pc.equivalents.carsRemoved > 0, 'pollution factors give cars for 120000 kWh');
const cars = new RegExp('<strong>' + r.sb._scFmtN(pc.equivalents.carsRemoved) + '</strong><span>cars removed').test(r.html);
ok(cars, 'cars shown = calculatePollutionCredits for the 6-month kWh and therms total');

r = render({}, {});
ok(/Savings data required/.test(r.html), 'no savings: fallback message still shows');
process.exit(fails ? 1 : 0);
