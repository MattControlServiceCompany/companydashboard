// READ-ONLY detection for WP-04b (math-02 M14). Nothing is written except the CSV.
// Usage: node tools/detect-default-rate-changes.js <backup-copy.json> <out.csv> <old-repo-dir>
// Lists every building whose DEFAULT seasonal rates (computeSeasonalBldgRates) differ between the code in
// <old-repo-dir> (a checkout from before WP-04) and this repo. M14: every same-commodity meter of the
// building now feeds the rate, not only the first meter. Saved rates (m.rates on a measure) always win;
// the default is used when a measure is created or when a measure has no saved rates.
// Column savedRatesMeasures = measures of the building that already store their own rates (they do not move).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const [, , src, out, oldRepo] = process.argv;
if (!src || !out || !oldRepo) {
  console.error('usage: node tools/detect-default-rate-changes.js <backup.json> <out.csv> <old-repo-dir>');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const FILES = [
  'lib/formatting.js',
  'lib/date-helpers.js',
  'computations/normalization.js',
  'computations/rates.js',
  'computations/savings.js',
];
// Cut one top-level function verbatim out of app/utility-data.js (same technique as the other tools).
function cutFn(name) {
  const srcText = fs.readFileSync(path.join(__dirname, '..', 'app', 'utility-data.js'), 'utf8');
  const m = new RegExp('function ' + name + '\\s*\\(').exec(srcText);
  let i = srcText.indexOf('{', srcText.indexOf(')', m.index));
  let d = 0;
  let j = i;
  for (; j < srcText.length; j++) {
    if (srcText[j] === '{') d++;
    else if (srcText[j] === '}' && --d === 0) break;
  }
  return srcText.slice(m.index, j + 1);
}
function ctx(repo) {
  const sb = { console, projects: data.en_projects || [], utilityData: {} };
  sb.window = sb;
  sb.sget = (k, d) => (data[k] != null ? data[k] : d);
  vm.createContext(sb);
  Object.keys(data).forEach((k) => {
    const m = /^en_utility_(\d+)$/.exec(k);
    if (m) sb.utilityData[m[1]] = data[k];
  });
  vm.runInContext(
    'function getUDBldgs(p){return (utilityData[p]||{buildings:[]}).buildings;}' +
      'function getUDBldg(p,b){return getUDBldgs(p).find(function(x){return x.id===b;});}' +
      'function getWeatherForBuilding(){return {byYm:null,cache:[]};}' +
      ['_fixISO', '_parseISO', 'calcDays'].map(cutFn).join(String.fromCharCode(10)),
    sb,
  );
  FILES.forEach((f) => {
    const p = path.join(repo, f);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: p });
  });
  return sb;
}
const oldSb = ctx(path.resolve(oldRepo));
const newSb = ctx(path.resolve(__dirname, '..'));
const KEYS = ['kwhSummer', 'kwhWinter', 'kwSummer', 'kwWinter', 'thermRate', 'gasSummer', 'gasWinter', 'gallonRate'];
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const rows = [
  ['projectId', 'projectName', 'buildingId', 'buildingName', 'field', 'oldDefault', 'newDefault', 'savedRatesMeasures'],
];
(data.en_projects || []).forEach((p) => {
  const ud = data['en_utility_' + p.id];
  if (!ud || !Array.isArray(ud.buildings)) return;
  const measures = (p.savingsData && p.savingsData.measures) || (p.savings && p.savings.measures) || [];
  ud.buildings.forEach((b) => {
    const o = oldSb.computeSeasonalBldgRates(p.id, b.id);
    const n = newSb.computeSeasonalBldgRates(p.id, b.id);
    const saved = measures.filter(
      (m) => m.bldgId === b.id && m.rates && Object.values(m.rates).some((v) => Number(v) > 0),
    ).length;
    KEYS.forEach((k) => {
      if (Math.abs((o[k] || 0) - (n[k] || 0)) > 1e-9) rows.push([p.id, p.name, b.id, b.name, k, o[k], n[k], saved]);
    });
  });
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('rows', rows.length - 1, 'buildings', new Set(rows.slice(1).map((r) => r[2])).size);
