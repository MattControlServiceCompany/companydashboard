// Test helper (2026-11-27): loads the owners of project savings into a node vm sandbox, for the tests that load app/pricing-estimator.js.
//   loadSavingsOwners(sb, vm, root): computations/project-savings.js and what it calls at run time: the one matrix pricing rule
//   (calcMeasureDollars and measureRateAt, cut from app/energy-savings.js with the rate code they use), the season table (computations/rates.js)
//   and the date helpers. Call it after computations/cost-lines.js, computations/measure-savings.js and computations/physics.js, before app/pricing-estimator.js.
// The sandbox needs projHasContract and getProjSavingsData; a test that has none gets safe stubs here (no contract, no matrix measures).
const fs = require('fs');
const path = require('path');

function loadSavingsOwners(sb, vm, root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  if (!sb.projHasContract) sb.projHasContract = () => false;
  if (!sb.getProjSavingsData) sb.getProjSavingsData = () => ({ measures: [], blRates: {} });
  if (!sb.projects) sb.projects = [];
  const has = (name) => vm.runInContext('typeof ' + name, sb) === 'function';
  if (!has('seasonOfMonth')) ['lib/date-helpers.js', 'computations/rates.js'].forEach((f) => vm.runInContext(read(f), sb, { filename: f }));
  const t = read('app/energy-savings.js');
  const a = t.indexOf('const RATE_WRITE_FIELDS');
  vm.runInContext(t.slice(a, t.indexOf('function _clMoney', a)), sb, { filename: 'app/energy-savings.js (savings owners)' });
  vm.runInContext(read('computations/project-savings.js'), sb, { filename: 'computations/project-savings.js' });
}

module.exports = { loadSavingsOwners };
