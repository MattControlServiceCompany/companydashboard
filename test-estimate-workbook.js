// Unit tests for app/estimate-workbook.js - SYNTHETIC inputs only.
// WORKBOOK_CACHED holds numeric cached values of the source workbook cells (numbers only, no text).
const assert = require('assert');
const W = require('./app/estimate-workbook.js');
let n = 0;
function eq(a, b, label) { n++; assert.strictEqual(a, b, label + ': got ' + a + ' expected ' + b); }
function close(a, b, label) { n++; assert.ok(Math.abs(a - b) < 1e-9, label + ': got ' + a + ' expected ' + b); }

const WORKBOOK_CACHED = {
  'LaborRates!D10': 82.5,
  'LaborRates!E10': 5.115,
  'LaborRates!F10': 1.19625,
  'LaborRates!G10': 0.495,
  'LaborRates!H10': 0.2904,
  'LaborRates!I10': 3.269475,
  'LaborRates!K10': 3.173125,
  'LaborRates!L10': 14.229999999999999,
  'LaborRates!M10': 2.475,
  'LaborRates!N10': 9.075,
  'LaborRates!O10': 39.31925,
  'LaborRates!P10': 121.81925,
  'LaborRates!Q10': 121.81925,
  'LaborRates!R10': 121.81925,
  'LaborRates!D11': 78.19999999999999,
  'LaborRates!E11': 4.848399999999999,
  'LaborRates!F11': 1.1339,
  'LaborRates!G11': 0.46919999999999995,
  'LaborRates!H11': 0.27526399999999995,
  'LaborRates!I11': 0.8938259999999998,
  'LaborRates!K11': 3.0077403846153845,
  'LaborRates!L11': 14.229999999999999,
  'LaborRates!M11': 2.3459999999999996,
  'LaborRates!N11': 8.601999999999999,
  'LaborRates!O11': 35.80633038461538,
  'LaborRates!P11': 114.00633038461537,
  'LaborRates!Q11': 114.00633038461537,
  'LaborRates!R11': 114.00633038461537,
  'LaborRates!D12': 78.19999999999999,
  'LaborRates!E12': 4.848399999999999,
  'LaborRates!F12': 1.1339,
  'LaborRates!G12': 0.46919999999999995,
  'LaborRates!H12': 0.27526399999999995,
  'LaborRates!I12': 0.8938259999999998,
  'LaborRates!K12': 3.0077403846153845,
  'LaborRates!L12': 14.229999999999999,
  'LaborRates!M12': 2.3459999999999996,
  'LaborRates!N12': 8.601999999999999,
  'LaborRates!O12': 35.80633038461538,
  'LaborRates!P12': 114.00633038461537,
  'LaborRates!Q12': 114.00633038461537,
  'LaborRates!R12': 114.00633038461537,
  'LaborRates!D13': 65.55,
  'LaborRates!E13': 4.0641,
  'LaborRates!F13': 0.950475,
  'LaborRates!G13': 0.3933,
  'LaborRates!H13': 0.230736,
  'LaborRates!I13': 2.20582305,
  'LaborRates!K13': 2.5212019230769234,
  'LaborRates!L13': 14.229999999999999,
  'LaborRates!M13': 1.9665,
  'LaborRates!N13': 7.2105,
  'LaborRates!O13': 33.77263597307692,
  'LaborRates!P13': 99.32263597307693,
  'LaborRates!Q13': 132.0976359730769,
  'LaborRates!R13': 164.8726359730769,
  'LaborRates!D14': 82.5,
  'LaborRates!E14': 5.115,
  'LaborRates!F14': 1.19625,
  'LaborRates!G14': 0.495,
  'LaborRates!H14': 0.2904,
  'LaborRates!I14': 2.7762075,
  'LaborRates!K14': 3.173125,
  'LaborRates!L14': 14.229999999999999,
  'LaborRates!M14': 2.475,
  'LaborRates!N14': 9.075,
  'LaborRates!O14': 38.825982499999995,
  'LaborRates!P14': 121.3259825,
  'LaborRates!Q14': 162.5759825,
  'LaborRates!R14': 203.8259825,
  'LaborRates!D15': 78.19999999999999,
  'LaborRates!E15': 4.848399999999999,
  'LaborRates!F15': 1.1339,
  'LaborRates!G15': 0.46919999999999995,
  'LaborRates!H15': 0.27526399999999995,
  'LaborRates!I15': 0.8938259999999998,
  'LaborRates!K15': 3.0077403846153845,
  'LaborRates!L15': 14.229999999999999,
  'LaborRates!M15': 2.3459999999999996,
  'LaborRates!N15': 8.601999999999999,
  'LaborRates!O15': 35.80633038461538,
  'LaborRates!P15': 114.00633038461537,
  'LaborRates!Q15': 114.00633038461537,
  'LaborRates!R15': 114.00633038461537,
  'LaborRates!D16': 66.612,
  'LaborRates!E16': 4.129944,
  'LaborRates!F16': 0.965874,
  'LaborRates!G16': 0.39967199999999997,
  'LaborRates!H16': 0.23447424,
  'LaborRates!I16': 2.241560412,
  'LaborRates!J16': 0.32999999999999996,
  'LaborRates!K16': 0.75,
  'LaborRates!L16': 10.25,
  'LaborRates!M16': 12.24836,
  'LaborRates!N16': 4.66284,
  'LaborRates!O16': 36.212724652,
  'LaborRates!P16': 102.82472465199999,
  'LaborRates!Q16': 136.130724652,
  'LaborRates!R16': 169.43672465199998,
  'LaborRates!D17': 69.012,
  'LaborRates!E17': 4.278744,
  'LaborRates!F17': 1.000674,
  'LaborRates!G17': 0.414072,
  'LaborRates!H17': 0.24292224,
  'LaborRates!I17': 2.322322812,
  'LaborRates!K17': 3.0300000000000002,
  'LaborRates!L17': 10.55,
  'LaborRates!M17': 13.35,
  'LaborRates!N17': 7.5913200000000005,
  'LaborRates!O17': 42.780055052,
  'LaborRates!P17': 111.792055052,
  'LaborRates!Q17': 146.298055052,
  'LaborRates!R17': 180.804055052,
  'LaborRates!D18': 67.5,
  'LaborRates!E18': 4.185,
  'LaborRates!F18': 0.97875,
  'LaborRates!G18': 0.405,
  'LaborRates!H18': 0.2376,
  'LaborRates!I18': 0.771525,
  'LaborRates!K18': 2.596201923076923,
  'LaborRates!L18': 14.229999999999999,
  'LaborRates!M18': 2.025,
  'LaborRates!N18': 7.425,
  'LaborRates!O18': 32.85407692307692,
  'LaborRates!P18': 100.35407692307692,
  'LaborRates!Q18': 100.35407692307692,
  'LaborRates!R18': 100.35407692307692,
  'Dash!E8': 52,
  'Dash!F8': 121.81925,
  'Dash!G8': 6335,
  'Dash!F9': 114.00633038461537,
  'Dash!F10': 114.00633038461537,
  'Dash!F11': 99.32263597307693,
  'Dash!F12': 121.3259825,
  'Dash!F13': 114.00633038461537,
  'Dash!F14': 102.82472465199999,
  'Dash!F15': 111.792055052,
  'Dash!F16': 100.35407692307692,
  'Dash!F17': 121.81925,
  'Dash!E18': 52,
  'Dash!G18': 6335,
  'Dash!F22': 0.05,
  'Dash!N26': 6430,
  'Dash!M27': 0.1,
  'Dash!N27': 643,
  'Dash!M28': 0.3,
  'Dash!N28': 2122,
  'Dash!N29': 9195,
  'Dash!M31': 0.05,
  'Dash!F32': 0.015,
  'Dash!G32': 95,
  'Dash!N33': 9195,
  'Dash!G34': 95,
  'Dash!N36': 9195,
  'Dash!F38': 100,
  'Dash!J40': 9195,
  'Dash!K40': 6335,
  'Dash!L40': 1,
  'Dash!J43': 9195,
  'Dash!K43': 6335,
  'Dash!L43': 176.82692307692307,
  'Dash!M43': 176.82692307692307,
  'MatEquip!F8': 36.67,
  'MatEquip!F9': 12.17,
  'MatEquip!F10': 22.52,
};

// 1. Fixture reproducing the workbook: 52 h PE, KS, no tax/bond/subs, 3 priced parts at qty 0.
const base = W.compute({
  hours: { PE: 52 }, ot: 'Not Applicable', state: 'Kansas', taxRate: 0, bond: false,
  parts: [{ unit: 36.67, qty: 0 }, { unit: 12.17, qty: 0 }, { unit: 22.52, qty: 0 }]
});
let exact = 0, near = 0;
Object.keys(WORKBOOK_CACHED).forEach(function (ref) {
  const got = base.cells[ref], want = WORKBOOK_CACHED[ref];
  assert.ok(got != null, 'missing cell ' + ref);
  if (got === want) { exact++; eq(got, want, ref); } else { near++; close(got, want, ref); }
});
console.log('cached cells checked: ' + Object.keys(WORKBOOK_CACHED).length + ' (bit-exact ' + exact + ', within 1e-9 ' + near + ')');

// 2. Headline numbers
const s = base.summary;
eq(s.labor, 6335, 'labor'); eq(base.cells['Dash!G32'], 95, 'tools'); eq(s.direct, 6430, 'direct');
eq(s.overhead, 643, 'overhead'); eq(s.profit, 2122, 'profit'); eq(s.total, 9195, 'total');
eq(s.tax, 0, 'tax'); eq(s.bond, 0, 'bond');
close(W.rateTable()[0].P, 121.81925, 'PE rate = 66*1.25 build-up');

// 3. Rounding
eq(W.round0(0.5), 1, '0.5'); eq(W.round0(-0.5), -1, '-0.5'); eq(W.round0(1.5), 2, '1.5'); eq(W.round0(-1.5), -2, '-1.5');
eq(W.round0(2.5), 3, '2.5'); eq(W.round0(-2.5), -3, '-2.5');
eq(W.round0(0.49), 0, '0.49'); eq(W.round0(-0.49), 0, '-0.49'); eq(Object.is(W.round0(-0.2), -0), false, 'no -0');
eq(W.round0(0.285 * 100), 29, 'float guard: 28.499999999999996 -> 29 (Excel 15-digit)');
eq(W.round0(2.4999999999999996), 3, '15-digit cut treats 2.4999999999999996 as 2.5 (Excel behavior)');

// 4. Tax: Kansas on whole subtotal; Missouri on materials+freight and tools
const mat = { hours: { PE: 52 }, taxRate: 0.1, parts: [{ unit: 100, qty: 3 }] };
const ks = W.compute(Object.assign({ state: 'Kansas' }, mat)).cells;
eq(ks['Dash!G21'], 300, 'KS mat'); eq(ks['Dash!G22'], 15, 'KS freight'); eq(ks['Dash!G23'], 0, 'KS no material tax');
eq(ks['Dash!G33'], 10, 'tools tax uses Info rate even in KS: round(95*0.1=9.5)');
eq(ks['Dash!N26'], 6335 + 315 + (95 + 10), 'KS direct');
eq(ks['Dash!N34'], Math.floor(ks['Dash!N33'] * 0.1 + 0.5), 'KS tax on whole subtotal');
eq(ks['Dash!N36'], ks['Dash!N33'] + ks['Dash!N34'], 'KS total');
const mo = W.compute(Object.assign({ state: 'Missouri' }, mat)).cells;
eq(mo['Dash!G23'], 32, 'MO material tax round(31.5)=32'); eq(mo['Dash!N34'], 0, 'MO no summary tax');
eq(mo['Dash!L34'], 'N/A', 'MO label');
eq(mo['Dash!N26'], 6335 + 347 + 105, 'MO direct');
eq(mo['Dash!N36'], mo['Dash!N33'], 'MO total has no summary tax');

// 5. Bond on / off
const noB = W.compute({ hours: { PE: 52 } }).cells, yesB = W.compute({ hours: { PE: 52 }, bond: true }).cells;
eq(noB['Dash!N35'], 0, 'bond off'); eq(yesB['Dash!M35'], 0.011, 'bond rate');
eq(yesB['Dash!N35'], 101, 'bond on: round(9195*0.011=101.145)'); eq(yesB['Dash!N36'], 9195 + 101, 'bond total');

// 6. Subs: N8 = R(L + L*M); sub profit 5%
const sub = W.compute({ hours: { PE: 52 }, subs: [{ amount: 1000, bondPct: 0.015 }, { amount: 333.33, bondPct: 0 }] }).cells;
eq(sub['Dash!N8'], 1015, 'sub 1'); eq(sub['Dash!N9'], 333, 'sub 2'); eq(sub['Dash!N22'], 1348, 'subs total');
eq(sub['Dash!N31'], 67, 'sub profit round(67.4)'); eq(sub['Dash!N32'], 1415, 'sub total');
eq(sub['Dash!N33'], 9195 + 1415, 'subtotal'); eq(sub['Dash!N36'], 10610, 'total with subs');
eq(sub['Dash!J42'], 1415, 'subs breakout');
close(sub['Dash!J40'] + sub['Dash!J41'] + sub['Dash!J42'], 10610, 'breakout sums to N36');

// 7. Materials: per-line rounding, freight 5%
const mt = W.compute({ parts: [{ unit: 10.5, qty: 1 }, { unit: 2.49, qty: 2 }, { unit: 0.333, qty: 3 }] }).cells;
eq(mt['MatEquip!G8'], 11, '10.5 -> 11'); eq(mt['MatEquip!G9'], 5, '4.98 -> 5'); eq(mt['MatEquip!G10'], 1, '0.999 -> 1');
eq(mt['MatEquip!G33'], 17, 'sum of rounded lines'); eq(mt['Dash!G22'], 1, 'freight round(.85)'); eq(mt['Dash!G24'], 18, 'material total');

// 8. Overtime x1.5 / x2.0 and role differences
const rt = {}; W.rateTable().forEach(r => { rt[r.code] = r; });
const hrs = { PE: 10, SC: 10, CO: 10, EI: 10, PI: 10, SE: 10, IT: 10 };
const o15 = W.compute({ hours: hrs, ot: 'x1.5' }).cells, o20 = W.compute({ hours: hrs, ot: 'x2.0' }).cells;
close(o15['Dash!F11'], rt.SC.D * 1.5 + rt.SC.O, 'SC x1.5'); close(o20['Dash!F11'], rt.SC.D * 2 + rt.SC.O, 'SC x2.0');
close(o15['Dash!F8'], rt.PE.P, 'PE no premium x1.5'); close(o20['Dash!F8'], rt.PE.P, 'PE no premium x2.0');
close(o15['Dash!F10'], rt.SE.P, 'SE no OT'); close(o20['Dash!F16'], rt.IT.P, 'IT no OT');
close(o20['Dash!F14'], rt.EI.D * 2 + rt.EI.O, 'EI x2.0'); close(o15['Dash!F15'], rt.PI.D * 1.5 + rt.PI.O, 'PI x1.5');
close(o15['Dash!F12'], 82.5 * 1.5 + rt.CO.O, 'CO x1.5');
eq(o15['Dash!G11'], Math.round(10 * (rt.SC.D * 1.5 + rt.SC.O)), 'SC OT line');
close(rt.SC.Q, 132.0976359730769, 'SC Q'); close(rt.SC.R, 164.8726359730769, 'SC R');
close(rt.CO.Q, 162.5759825, 'CO Q'); close(rt.CO.R, 203.8259825, 'CO R');
close(rt.EI.Q, 136.130724652, 'EI Q'); close(rt.EI.R, 169.43672465199998, 'EI R');
close(rt.PI.Q, 146.298055052, 'PI Q'); close(rt.PI.R, 180.804055052, 'PI R');
eq(rt.PE.Q, rt.PE.P, 'PE Q=P'); eq(rt.PE.R, rt.PE.P, 'PE R=P');

// 9. Warranty, safety, vans, misc, tools
const w = W.compute({ hours: { PE: 10, SE: 10 }, pct: { warrantyFactor: 0.1, safety: 0.02 }, vans: { qty: 3 },
  misc: [{ qty: 2, rate: 250.5 }], tools: [{ qty: 2, hrs: 3, rate: 7.25 }] }).cells;
eq(w['Dash!E17'], 2, 'warranty hours'); eq(w['Dash!G17'], Math.round(2 * 121.81925), 'warranty line');
eq(w['Dash!E18'], 22, 'hours total'); eq(w['Dash!G38'], 300, 'vans'); eq(w['Dash!G39'], 501, 'misc');
eq(w['Dash!G27'], 44, 'tool 43.5 -> 44');
eq(w['Dash!G37'], Math.round(w['Dash!G18'] * 0.02), 'safety');
eq(w['Dash!G45'], w['Dash!G37'] + 300 + 501, 'misc total');

// 10. Empty input: all zeros, no NaN, breakout shares null
const z = W.compute({});
eq(z.summary.total, 0, 'empty total'); eq(z.cells['Dash!L40'], null, 'div0 share'); eq(z.cells['Dash!L43'], null, 'div0 blended');
Object.keys(z.cells).forEach(k => { const v = z.cells[k]; assert.ok(v === null || typeof v === 'string' || Number.isFinite(v), k + ' not finite'); });

// 11. Defaults data
const M = W.DEFAULTS.taskRoleMap;
eq(M.audit_equipment_review, 'PE', 'audit'); eq(M.bas_programming, 'SE', 'bas'); eq(M.install_per_point, 'EI', 'install');
eq(M.install_pneumatic_valve, 'PI', 'pneu'); eq(M.startup_checkout, 'SC', 'startup'); eq(M.commissioning, 'CO', 'cx');
eq(M.training, 'TR', 'training'); eq(M.network_ip, 'IT', 'IT'); eq(M.engineering_design, 'DE', 'DE'); eq(M.monthly_service, 'PE', 'monthly');
eq(W.DEFAULTS.taskTypes.every(t => W.DEFAULTS.roles.some(r => r.code === t.role)), true, 'every task maps to a real role');
eq(W.rateTable({ PE: 100 })[0].D, 100, 'base override');

console.log('PASS: ' + n + ' assertions');
