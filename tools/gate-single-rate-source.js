// Gate: the $/kWh, $/kW and $/Therm rate has ONE owner, computeSeasonalBldgRates (computations/rates.js).
// Fails when app code brings back a second rate rule: a private cost / usage loop, an invented
// fallback or default rate (electric 0.1 / 0.085, gas_rate, demand_rate), or one of the deleted copies.
// Run: node tools/gate-single-rate-source.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const RULES = [
  [
    /\bgetProjectRates\b|\bbtGetBlendedRate\b|\b_pricingGetProjectAnnualElec\b|\bcalcBldgDefaultRates\b/,
    'deleted rate copy came back',
  ],
  [/\*\s*inp\.(?:elec|gas|demand)_rate\b/, 'ECM template prices a flat rate outside ecmPrice'],
  [/(?:elecRate|elec_rate|rate)\s*(?::|=)\s*[^;\n]*\|\|\s*0\.1\b/, 'invented 0.1 fallback rate'],
  [/default:\s*0\.085\b/, 'invented 0.085 default rate'],
  [/totalCost\s*\/\s*total(?:Kwh|Usage)\b/, 'private totalCost / kWh rate loop'],
];
// Multi-line: a gas_rate or demand_rate input must not carry a number default (use null; bills prefill it).
const INPUT_DEFAULT = /id:\s*'(?:gas_rate|demand_rate)'[^{}]*?default:\s*(?!null\b)[-\d.]+/g;
const files = [];
['app', 'computations'].forEach((d) =>
  fs.readdirSync(path.join(root, d)).forEach((f) => /\.js$/.test(f) && files.push(path.join(d, f))),
);
const bad = [];
files.forEach((f) => {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  let m;
  INPUT_DEFAULT.lastIndex = 0;
  while ((m = INPUT_DEFAULT.exec(text))) {
    const ln = text.slice(0, m.index).split('\n').length;
    bad.push(f + ':' + ln + ' invented gas or demand default rate: ' + m[0].replace(/\s+/g, ' ').slice(0, 100));
  }
  text.split(/\r?\n/).forEach((line, i) => {
    RULES.forEach(
      ([re, why]) => re.test(line) && bad.push(f + ':' + (i + 1) + ' ' + why + ': ' + line.trim().slice(0, 100)),
    );
  });
});
if (bad.length) {
  console.log('FAIL single rate source gate\n' + bad.join('\n'));
  process.exit(1);
}
console.log('PASS - no second rate rule found in app/ or computations/');
