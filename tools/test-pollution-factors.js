// tools/test-pollution-factors.js — pins the emission factors in computations/pollution.js.
// Electricity: EPA eGRID2023 (rev 2) state total output rates (lb/MWh / 1000). On-site fuels: EPA GHG Emission Factors Hub.
// SYNTHETIC inputs only. Run: node tools/test-pollution-factors.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sb = {};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'computations/pollution.js'), 'utf8'), sb);
const F = vm.runInContext('EGRID_FACTORS', sb);
const calc = (k, t, g, st) => vm.runInContext('calculatePollutionCredits', sb)(k, t, g, st || 'KS', 'lbs');

// KS pinned to eGRID2023 rev 2 Table 3 (lb/MWh / 1000)
ok(F.KS.co2 === 0.7282 && F.KS.ch4 === 0.000077 && F.KS.n2o === 0.000011, 'KS CO2/CH4/N2O match eGRID2023');
ok(F.KS.nox === 0.0005 && F.KS.so2 === 0.000113, 'KS annual NOx and SO2 match eGRID2023');
ok(Object.keys(F).length === 52, '50 states + DC + PR in table');

// 1000 kWh in KS
const e = calc(1000, 0, 0);
ok(near(e.pollutants.co2, 728.2, 0.01), 'KS 1000 kWh -> 728.2 lb CO2');

// propane: 24 gal -> about 302 lb CO2 (61.71 kg/MMBtu, 0.091452 MMBtu/gal)
const p = calc(0, 0, 24);
ok(near(p.pollutants.co2, 24 * 0.091452 * 61.71 * 2.20462, 0.01) && near(p.pollutants.co2, 298.6, 1), 'propane 24 gal -> ~299 lb CO2 (' + p.pollutants.co2.toFixed(1) + ')');
ok(p.pollutants.co2 / 24 > 12 && p.pollutants.co2 / 24 < 13, 'propane about 12.4 lb CO2 per gallon');

// natural gas: 1 therm -> 11.7 lb CO2
const g = calc(0, 1, 0);
ok(near(g.pollutants.co2, 11.698, 0.01), 'gas 1 therm -> 11.7 lb CO2');

// Quarter mix: +107,310 kWh, -222 therms, -24 gal (signed inputs)
const q = calc(107310, -222, -24);
ok(near(q.pollutants.co2, 107310 * 0.7282 - 222 * 11.6978 - 24 * 0.091452 * 61.71 * 2.20462, 0.5), 'Q3 mix CO2 = ' + q.pollutants.co2.toFixed(1));

// More states pinned to the eGRID2023 rev 2 table (CO2, CH4, N2O, SO2, annual NOx; lb/MWh)
const PIN = {
  CA: [393.5, 0.021, 0.003, 0.013, 0.3],
  CO: [1085.0, 0.092, 0.013, 0.351, 0.5],
  IA: [630.2, 0.06, 0.009, 0.52, 0.4],
  KY: [1735.0, 0.181, 0.026, 1.116, 1.0],
  MO: [1444.1, 0.158, 0.023, 2.18, 1.1],
  WV: [1954.4, 0.218, 0.032, 1.498, 1.1],
  TX: [768.3, 0.044, 0.006, 0.389, 0.5],
};
Object.keys(PIN).forEach((k) => {
  const v = PIN[k], f = F[k];
  ok(
    near(f.co2 * 1000, v[0], 1e-6) && near(f.ch4 * 1000, v[1], 1e-6) && near(f.n2o * 1000, v[2], 1e-6) && near(f.so2 * 1000, v[3], 1e-6) && near(f.nox * 1000, v[4], 1e-6),
    k + ' matches eGRID2023 for all five gases',
  );
});

// signed net: no clamp; equivalents only for avoided emissions
const neg = calc(-1000, 0, 0);
ok(neg.pollutants.co2 < 0 && neg.equivalents.carsRemoved === 0, 'negative savings stay negative (no clamp); no equivalents');
const gw = vm.runInContext('[GWP_CH4, GWP_N2O]', sb);
ok(gw[0] === 28 && gw[1] === 265, 'GWP are AR5 (28, 265)');
const chg = vm.runInContext('emissionsChangeText', sb);
// Q3-style: electricity use ROSE by 107,310 kWh, gas and propane fell -> savings inputs are the negatives
const q3 = calc(-107310, 222, 24);
ok(chg(q3.pollutants.co2) === '+75,248' && q3.co2eMT < 0 && q3.equivalents.carsRemoved === 0, 'Q3 use rose: CO2 change +75,248 (plus = more), no equivalents');
ok(q3.increaseEquivalents.carsRemoved > 0 && red0().increaseEquivalents.carsRemoved === 0, 'net increase has increaseEquivalents; a reduction has none');
function red0() { return calc(10000, 0, 0); }
// synthetic reduction: 10,000 kWh saved -> fewer emissions, minus sign, equivalents shown
const red = calc(10000, 0, 0);
ok(chg(red.pollutants.co2) === '-7,282' && red.co2eMT > 0 && red.equivalents.carsRemoved > 0, 'reduction: CO2 change -7,282 (minus = fewer), equivalents shown');
ok(vm.runInContext('energyUseChangeLine', sb)(-107310, 222, 24) === 'Energy use compared with baseline: electricity +107,310 kWh, natural gas -222 therms, propane -24 gal', 'energy use line');
ok(vm.runInContext('EMISSIONS_SIGN_NOTE', sb) === 'A plus sign means more emissions than baseline.', 'sign note text');

// removed rows
ok(!('pm10' in e.pollutants) && !('voc_oz' in e.pollutants) && !('co_oz' in e.pollutants) && !('hg_oz' in e.pollutants), 'no PM10/VOC/CO/Hg or oz keys');

// source line
const line = vm.runInContext('emissionsSourceLine', sb)('KS');
ok(/eGRID2023 \(rev 2\), Kansas \(electricity\)/.test(line) && /GHG Emission Factors Hub/.test(line), 'source line names eGRID2023 rev 2, the state name Kansas and the GHG Hub: ' + line);

console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
