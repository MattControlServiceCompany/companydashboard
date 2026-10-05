/**
 * gate-single-bill-flag-count.js
 *
 * Gate: every bill-flag count on the site comes from ONE function, computeMeterFlagSummary
 * (computations/bill-flags.js). Fails when:
 *   1. computations/bill-flags.js does not define computeMeterFlagSummary and computeBuildingFlagSummary,
 *      or energy-department.html does not load it.
 *   2. Any file in app/, computations/, extraction/ or lib/ still uses a removed second copy
 *      (computeLiveBillFlags, _analyzeMeterBills, _billNormMonth, _monthToSeason, runBillValidation,
 *      runBuildingValidation, _analyzeWaterSewerParity, getBillFlagCount, _bcrFlagInstanceTotal,
 *      _PERSISTED_UI_FLAG_IDS) as code (comment lines are ignored).
 *   3. The Bills tab banner, the meter pill and the building badge (app/utility-data.js), the Review Bill
 *      Corrections panel (app/bill-corrections-review.js) or the data-quality score
 *      (computations/data-quality.js) does not call the shared function.
 *   4. computeMeterFlagSummary is defined more than once.
 *
 * Usage: node tools/gate-single-bill-flag-count.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const DIRS = ['app', 'computations', 'extraction', 'lib'];
const REMOVED = [
  'computeLiveBillFlags',
  '_analyzeMeterBills',
  '_billNormMonth',
  '_monthToSeason',
  'runBillValidation',
  'runBuildingValidation',
  '_analyzeWaterSewerParity',
  'getBillFlagCount',
  '_bcrFlagInstanceTotal',
  '_PERSISTED_UI_FLAG_IDS',
];
const problems = [];
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

const keeper = fs.existsSync(path.join(REPO, 'computations/bill-flags.js')) ? read('computations/bill-flags.js') : '';
if (!/function\s+computeMeterFlagSummary\s*\(/.test(keeper))
  problems.push('computations/bill-flags.js does not define computeMeterFlagSummary');
if (!/function\s+computeBuildingFlagSummary\s*\(/.test(keeper))
  problems.push('computations/bill-flags.js does not define computeBuildingFlagSummary');
if (!/computations\/bill-flags\.js/.test(read('energy-department.html')))
  problems.push('energy-department.html does not load computations/bill-flags.js');

let defs = 0;
for (const d of DIRS) {
  for (const file of walk(path.join(REPO, d), [])) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/function\s+computeMeterFlagSummary\s*\(/.test(line)) defs++;
        for (const name of REMOVED) {
          // used as code: a call, an assignment, a definition, or a property access
          const re = new RegExp('\\b' + name + '\\b\\s*(\\(|=|\\.)|function\\s+' + name + '\\b');
          if (re.test(line))
            problems.push(rel + ':' + (i + 1) + ' uses removed second copy ' + name + ': ' + line.trim().slice(0, 100));
        }
      });
  }
}
if (defs !== 1) problems.push('computeMeterFlagSummary must be defined exactly once, found ' + defs);

const ud = read('app/utility-data.js');
if (!/computeMeterFlagSummary\(m, getUDBldg\(/.test(ud))
  problems.push('app/utility-data.js: the Bills tab banner does not call computeMeterFlagSummary');
if (!/const _mFlags = computeMeterFlagSummary\(/.test(ud))
  problems.push('app/utility-data.js: the meter pill does not call computeMeterFlagSummary');
if (!/computeBuildingFlagSummary\(b\)/.test(ud))
  problems.push('app/utility-data.js: the building badge does not call computeBuildingFlagSummary');
if (!/computeMeterFlagSummary\(/.test(read('app/bill-corrections-review.js')))
  problems.push('app/bill-corrections-review.js does not call computeMeterFlagSummary');
if (!/computeMeterFlagSummary\(/.test(read('computations/data-quality.js')))
  problems.push('computations/data-quality.js does not call computeMeterFlagSummary');

if (problems.length) {
  console.log('FAIL gate-single-bill-flag-count');
  problems.forEach((p) => console.log('  ' + p));
  process.exit(1);
}
console.log('PASS gate-single-bill-flag-count');
