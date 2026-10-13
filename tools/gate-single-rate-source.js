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
  [
    /\b_wdSeasonalRates\b|\bwdOptionAnnualDollar\b|\bwdOptionDollarByMonth\b|\b_?(?:kwh|kw|gas|prop)RateFn\b/,
    'deleted monthly pricing copy came back',
  ],
  // The summer / winter definition lives ONLY in SEASON_TABLE (computations/rates.js, keyed by provider).
  // Every reader asks seasonOfMonth / seasonOfDate. A month-number list for summer is a second table.
  // A private month list such as sumMos / winMos is a second season rule (the old one used Dec-Mar for winter).
  [/\b(?:sumMos|winMos|summerMonths|winterMonths)\s*=\s*\[/, 'second season definition (use computeSeasonalBldgRates / measureRateAt)'],
  [/\bSUMMER_MOS\s*=\s*\[/, 'second season table (ask seasonOfMonth / seasonOfDate in computations/rates.js)'],
  [/\[\s*(?:5\s*,\s*6\s*,\s*7\s*,\s*8|6\s*,\s*7\s*,\s*8\s*,\s*9)\s*\]/, 'summer month list (Jun-Sep) outside SEASON_TABLE'],
  // Monthly pricing has ONE owner path: measureRateAt / calcMeasureDollars (app/energy-savings.js).
  // A season test or a multiply by a stored rate field anywhere else is a second copy of the rule.
  [/\bSUMMER_MOS\.includes\(/, 'second season test for monthly pricing (use measureRateAt / calcMeasureDollars)'],
  [
    /\*\s*\(?\s*[\w.]*\b(?:rates?|r)\.(?:kwhSummer|kwhWinter|kwSummer|kwWinter|gasSummer|gasWinter|thermRate|gallonRate)\b/,
    'quantity x stored rate multiplied outside the owner path (use calcMeasureDollars)',
  ],
];
// Multi-line: a gas_rate or demand_rate input must not carry a number default (use null; bills prefill it).
const INPUT_DEFAULT = /id:\s*'(?:gas_rate|demand_rate)'[^{}]*?default:\s*(?!null\b)[-\d.]+/g;
const files = [];
['app', 'computations'].forEach((d) =>
  fs.readdirSync(path.join(root, d)).forEach((f) => /\.js$/.test(f) && files.push(path.join(d, f))),
);
const bad = [];
// SEASON_TABLE is defined exactly once, in computations/rates.js; season edge dates ('06-01', '09-30', '10-01',
// '05-31') are written only in that table.
const SEASON_EDGE = /['"](?:06-01|09-30|10-01|05-31)['"]/;
let tableDefs = 0;
files.forEach((f) => {
  let text = fs.readFileSync(path.join(root, f), 'utf8');
  // The owner of the season rule is exempt: blank measureRateAt (keeps line numbers).
  text = text.replace(/function measureRateAt\b[\s\S]*?\r?\n\}\r?\n/, (m) => m.replace(/[^\r\n]/g, ' '));
  tableDefs += (text.match(/\b(?:var|let|const)\s+SEASON_TABLE\b/g) || []).length;
  if (f !== path.join('computations', 'rates.js'))
    text.split(/\r?\n/).forEach((line, i) => {
      if (SEASON_EDGE.test(line)) bad.push(f + ':' + (i + 1) + ' season edge date outside SEASON_TABLE: ' + line.trim().slice(0, 100));
    });
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
if (tableDefs !== 1) bad.push('SEASON_TABLE must be defined exactly once in app/ + computations/ (found ' + tableDefs + ')');
if (bad.length) {
  console.log('FAIL single rate source gate\n' + bad.join('\n'));
  process.exit(1);
}
console.log('PASS - no second rate rule found in app/ or computations/');
