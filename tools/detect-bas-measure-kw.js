// tools/detect-bas-measure-kw.js - READ-ONLY detector (WP-13). Never writes to the backup or the app.
// Lists saved measures with source 'bas' (BAS Calc "Add as Measure" / "Apply to Measure").
// Old code saved kW[mo] = peak-window kWh / peak hours (a monthly total, about 30x too big);
// the fixed value is kW[mo] / days-in-month. Gas: when the project's saved BAS Calc heat source is 1
// (thousand cubic feet) the saved gas array is in MCF, not therms (fixed = x UNIT_TO_BASE.MCF).
// Run: node tools/detect-bas-measure-kw.js <backup-copy.json> [out.csv]
'use strict';
const fs = require('fs');
const inFile = process.argv[2];
if (!inFile) {
  console.error('usage: node tools/detect-bas-measure-kw.js <backup-copy.json> [out.csv]');
  process.exit(2);
}
const MCF_TO_THERMS = 10.37; // UNIT_TO_BASE.MCF.factor (app/utility-data.js); read-only report figure
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
let projects = data.en_projects;
if (typeof projects === 'string') projects = JSON.parse(projects);
const sum = (a) => (a || []).reduce((x, y) => x + (parseFloat(y) || 0), 0);
const rows = [
  'project,measure,building,desc,saved_kw_sum,saved_kw_max,fixed_kw_avg_max,fixed_kw_sum,saved_gas_annual,bas_heat_source,fixed_gas_therms,saved_total_dollar',
];
let n = 0;
for (const p of projects || []) {
  for (const m of (p.savingsData && p.savingsData.measures) || []) {
    if (m.source !== 'bas') continue;
    n++;
    const kw = (m.kw || []).map((v) => parseFloat(v) || 0);
    const fixed = kw.map((v, i) => v / DAYS[i]);
    const hs = p.basCalc && p.basCalc.heatSrc;
    const gas = sum(m.gas);
    rows.push(
      [
        JSON.stringify(p.name || p.id),
        m.msrNum,
        JSON.stringify(m.bldgId || ''),
        JSON.stringify(m.desc || ''),
        sum(kw).toFixed(1),
        Math.max(0, ...kw).toFixed(1),
        Math.max(0, ...fixed).toFixed(1),
        sum(fixed).toFixed(1),
        Math.round(gas),
        hs === undefined ? '' : hs,
        // heat source is saved per project, not per measure: only a hint when it is 1 (MCF)
        hs === 1 ? Math.round(gas * MCF_TO_THERMS) : '',
        Math.round(m.totalDollar || 0),
      ].join(','),
    );
  }
}
const out = process.argv[3];
if (out) fs.writeFileSync(out, rows.join('\n') + '\n');
else console.log(rows.join('\n'));
console.log('BAS measures found: ' + n);
