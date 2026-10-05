// tools/bill-flags-sandbox.js - loads the REAL bill-flag functions (not copies) into a Node vm context.
// Used by tools/test-bill-flag-rules.js and the accept/compare scripts. No DOM.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// Source text of one top-level function.
function fnSource(file, name) {
  const src = read(file);
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + file);
  let d = 0,
    pe = src.indexOf('(', m.index);
  for (; pe < src.length; pe++) {
    if (src[pe] === '(') d++;
    else if (src[pe] === ')' && --d === 0) break;
  }
  let depth = 0,
    j = src.indexOf('{', pe);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, j + 1);
}
// Source text of one top-level `const NAME = {...};` block.
function constSource(file, name) {
  const src = read(file);
  const s = src.indexOf('const ' + name + ' = {');
  if (s < 0) throw new Error('const not found: ' + name);
  const e = src.indexOf('\n};', s);
  return src.slice(s, e + 3);
}

function makeContext() {
  const ctx = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(ctx);
  vm.runInContext(read('lib/formatting.js'), ctx);
  vm.runInContext(read('lib/date-helpers.js'), ctx);
  vm.runInContext(read('computations/normalization.js'), ctx);
  const ud = 'app/utility-data.js';
  vm.runInContext(
    [
      ...['_fixISO', '_parseISO', 'calcDays', 'fmtDate', '_unitInfo', 'convertUnit'].map((n) => fnSource(ud, n)),
      constSource(ud, 'UNIT_TO_BASE'),
      constSource(ud, 'UNIT_TO_BASE_BY_COMMODITY'),
    ].join('\n'),
    ctx,
  );
  const sv = 'computations/savings.js';
  vm.runInContext(
    ['resolveGasUsageThermsOrNull', 'resolveGasUsageTherms', 'getBillUsageOrNull']
      .map((n) => fnSource(sv, n))
      .join('\n'),
    ctx,
  );
  vm.runInContext(fnSource('computations/rates.js', 'getStoredRate'), ctx);
  vm.runInContext(read('computations/bill-flags.js'), ctx);
  return ctx;
}
module.exports = { makeContext, fnSource, constSource, REPO };
