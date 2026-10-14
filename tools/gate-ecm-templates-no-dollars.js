// Gate: calc templates take their baseline from the HVAC Load Estimate and send MONTHLY quantities to the
// Energy Savings matrix (Phase 5, 2026-10-14). A template computes quantities only.
//   1. A template (ECM_TEMPLATES in app/ecm-calculators.js) never computes dollars, payback or a rate, and never
//      divides a yearly quantity by 12. The matrix prices (calcMeasureDollars) and getEndUse shapes the months.
//   2. The measure builder (ECM_MEASURE_FIELD_MAP .. calculateEcm) never divides by 12 and never calls ecmPrice.
//   3. Only computations/end-use.js (the owner) and the HVAC Load Estimate code (app/calculators.js) read the
//      estimate's end-use fields (coolKwhTotal, monthlyHvacGas, ...). Any other file asks getEndUse.
//   4. openBASCalc reads its Section D baseline through getEndUse only (no saved-versus-measured fork).
// Run: node tools/gate-ecm-templates-no-dollars.js   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const END_USE_FIELD_RE =
  /\.(?:coolKwhTotal|heatKwhTotal|hvacGasT|hvacKwh|nonHvacKwh|hvacKw|nonHvacKw|monthlyCoolKwh|monthlyHeatKwh|monthlyHvacGas|monthlyHvacKwh|monthlyNonHvacKwh|monthlyHvacKw|monthlyNonHvacKw)\b/;

function slice(text, startMark, endMark) {
  const a = text.indexOf(startMark);
  if (a < 0) return null;
  const b = text.indexOf(endMark, a);
  return b < 0 ? text.slice(a) : text.slice(a, b);
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

// files: { 'app/ecm-calculators.js': text, 'app/calculators.js': text, 'computations/end-use.js': text, others: { path: text } }
function check(files) {
  const bad = [];
  const ecm = files['app/ecm-calculators.js'];
  const tmplRegion = slice(ecm, 'const ECM_TEMPLATES = {', '/* ─── ECM Project Storage');
  if (!tmplRegion) bad.push('app/ecm-calculators.js: ECM_TEMPLATES region not found');
  else {
    const code = stripComments(tmplRegion);
    const rules = [
      [
        /\becmPrice\b|\bcalcMeasureDollars\b|\bmeasureRatesNow\b/,
        'a template prices (ecmPrice / calcMeasureDollars); the matrix prices',
      ],
      [/_dollar\b/, 'a template has a dollar value (*_dollar); the matrix prices'],
      [/payback/i, 'a template computes a payback (the only payback is simplePayback, computations/cost-lines.js)'],
      [/\bid:\s*'[a-z_]*_(?:rate|cost)'/, 'a template has a rate or cost input'],
      [/\binp\.[a-z_]*_(?:rate|cost)\b/, 'a template reads a rate or cost input'],
      [/\/\s*12\b(?!\d)/, 'a template divides by 12 (months come from getEndUse, not quantity / 12)'],
      [/\*\s*12\b(?!\d)|\b12\s*\*\s*(?!inp)/, 'a template multiplies by 12 months'],
      [/\.fill\(/, 'a template spreads a quantity with Array.fill'],
    ];
    rules.forEach(([re, why]) => {
      const m = code.match(re);
      if (m) bad.push('app/ecm-calculators.js templates: ' + why + '  near: ' + JSON.stringify(m[0]));
    });
  }
  const builder = slice(ecm, 'const ECM_MEASURE_FIELD_MAP', '/* ─── Render API');
  if (!builder) bad.push('app/ecm-calculators.js: measure builder region not found');
  else {
    const code = stripComments(builder);
    if (/\/\s*12\b(?!\d)/.test(code)) bad.push('app/ecm-calculators.js measure builder: divides by 12');
    if (/\becmPrice\b|\bECM_RATE_FIELD\b/.test(code))
      bad.push('app/ecm-calculators.js measure builder: ecmPrice came back');
    if (!/\bgetEndUseWeights\(/.test(code))
      bad.push('app/ecm-calculators.js measure builder: does not shape with getEndUseWeights');
    if (!/\bcalcMeasureDollars\(/.test(code) || !/\bmeasureRatesNow\(/.test(code))
      bad.push('app/ecm-calculators.js measure builder: dollars do not come from calcMeasureDollars + measureRatesNow');
  }
  if (/\becmPrice\b|\bECM_RATE_FIELD\b|\becmResultsToAnnualTotals\b/.test(stripComments(ecm)))
    bad.push(
      'app/ecm-calculators.js: a deleted pricing helper came back (ecmPrice / ECM_RATE_FIELD / ecmResultsToAnnualTotals)',
    );

  // 3. who reads the estimate's end-use fields
  Object.keys(files).forEach((p) => {
    if (p === 'app/calculators.js' || p === 'computations/end-use.js') return;
    if (!/^(app|computations|lib)\//.test(p)) return;
    const m = stripComments(files[p]).match(END_USE_FIELD_RE);
    if (m)
      bad.push(p + ': reads the load estimate end-use field ' + m[0] + ' (ask getEndUse, computations/end-use.js)');
  });

  // 3b. getEndUse never reads the stored snapshot (b.hvacLoad.est): it asks hvacEstimateForBuilding, which calculates
  // from the bills (measured split) so a moved-over snapshot can never freeze a rule-of-thumb split.
  const eu = stripComments(files['computations/end-use.js']);
  if (/hvacLoadStoredFor|hvacLoad\.est|computeHvacLoadEstimate|_hvlThumbDefaults/.test(eu))
    bad.push('computations/end-use.js: reads a stored estimate or calculates one itself (use hvacEstimateForBuilding)');
  if (!/\bhvacEstimateForBuilding\(/.test(eu)) bad.push('computations/end-use.js: getEndUse does not use hvacEstimateForBuilding');

  // 4. BAS Section D
  const calc = files['app/calculators.js'];
  const bas = slice(calc, 'function openBASCalc(', '\nfunction ');
  if (!bas) bad.push('app/calculators.js: openBASCalc not found');
  else {
    const code = stripComments(bas);
    if (!/\bgetEndUse\(/.test(code)) bad.push('openBASCalc: Section D does not read getEndUse');
    if (/\bhvacLoadStoredFor\b|\bhvacLoadProjectRollup\b|\buseSavedEst\b|\bhvacCompute\w+/.test(code))
      bad.push(
        'openBASCalc: the saved-versus-measured fork came back (hvacLoadStoredFor / hvacLoadProjectRollup / useSavedEst / hvacCompute*)',
      );
  }
  if (/function hvacCompute(?:GasThermsForBuilding|ElecCoolKwhForBuilding)\b/.test(calc))
    bad.push('app/calculators.js: a second end-use reader came back (hvacCompute*ForBuilding); use getEndUse');
  return bad;
}

function loadFiles() {
  const files = {};
  ['app', 'computations', 'lib'].forEach((d) => {
    fs.readdirSync(path.join(root, d))
      .filter((f) => f.endsWith('.js'))
      .forEach((f) => {
        files[d + '/' + f] = fs.readFileSync(path.join(root, d, f), 'utf8');
      });
  });
  return files;
}

module.exports = { check, loadFiles };

if (require.main === module) {
  const bad = check(loadFiles());
  if (bad.length) {
    console.log('FAIL gate-ecm-templates-no-dollars');
    bad.forEach((b) => console.log('  - ' + b));
    process.exit(1);
  }
  console.log('PASS gate-ecm-templates-no-dollars');
}
