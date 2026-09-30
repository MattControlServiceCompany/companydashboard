// tools/detect-hvac-split-saved.js - READ-ONLY detector (WP-15).
// Lists projects whose saved BAS Calc holds an "Existing Heating kWh" (calHeatKwh) or
// "Existing Cooling kWh" (calCoolKwh). Since v2026.09.28.21 the BAS Calc filled calHeatKwh from a
// weather-regression split, which the 2026-09-20 directive forbids (HVAC split = 3-lowest-month
// baseload only). A value is "possibly regression" when the field is saved, was not typed by the
// user (not in __userTouched), and no saved HVAC Load Estimate holds heatKwhTotal. Also lists BAS
// measures added on/after 2026-09-28 (their electric kWh came from a calc that could hold it).
// It never writes to the backup or to the app. Matt decides what to clear.
// Run: node tools/detect-hvac-split-saved.js <backup-copy.json> [out.csv]
'use strict';
const fs = require('fs');
const inFile = process.argv[2];
if (!inFile) {
  console.error('usage: node tools/detect-hvac-split-saved.js <backup-copy.json> [out.csv]');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
let projects = data.en_projects;
if (typeof projects === 'string') projects = JSON.parse(projects);
const CUTOFF = Date.parse('2026-09-28T00:00:00');
const rows = [
  [
    'project',
    'saved_calHeatKwh',
    'heat_user_touched',
    'saved_calCoolKwh',
    'cool_user_touched',
    'load_est_saved_at',
    'load_est_heatKwhTotal',
    'possibly_regression_fill',
    'bas_measures_since_v21',
  ],
];
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
for (const p of projects || []) {
  const bc = p.basCalc;
  if (!bc) continue;
  const heat = parseFloat(bc.calHeatKwh);
  const cool = parseFloat(bc.calCoolKwh);
  if (!(heat > 0) && !(cool > 0)) continue;
  const touched = new Set(bc.__userTouched || []);
  const le = p.hvacLoadEst || {};
  const leHeat = p.hvacLoadSavedAt && le.heatKwhTotal ? Math.round(le.heatKwhTotal) : '';
  const possible = heat > 0 && !touched.has('calHeatKwh') && leHeat === '';
  const ms = ((p.savingsData && p.savingsData.measures) || []).filter((m) => {
    if (m.source !== 'bas') return false;
    const ts = parseInt(String(m.id).replace(/^m/, ''), 10);
    return ts >= CUTOFF;
  });
  rows.push([
    p.name || p.id,
    heat > 0 ? heat : '',
    touched.has('calHeatKwh') ? 'yes' : 'no',
    cool > 0 ? cool : '',
    touched.has('calCoolKwh') ? 'yes' : 'no',
    p.hvacLoadSavedAt || '',
    leHeat,
    possible ? 'yes' : 'no',
    ms.map((m) => m.id + ' ' + (m.desc || '')).join(' | '),
  ]);
}
const csv = rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
if (process.argv[3]) fs.writeFileSync(process.argv[3], csv);
console.log(csv);
console.log('rows: ' + (rows.length - 1));
