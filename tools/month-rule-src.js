// tools/month-rule-src.js - test helper. Returns the REAL source of the one month rule (billMonth and the
// normMonth chain behind it, with the date helpers they call) as a string, so a test that runs app code in a
// Node vm loads the real rule and never stubs its own. Used by the HVAC and BAS Calc tests.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

function fnSource(src, name) {
  const idx = src.indexOf('function ' + name + '(');
  const m = idx < 0 ? null : { index: idx };
  if (!m) throw new Error('not found: ' + name);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

module.exports = monthRuleSource;
module.exports.fnSource = fnSource;

function monthRuleSource() {
  const ud = fs.readFileSync(path.join(REPO, 'app', 'utility-data.js'), 'utf8');
  const nm = fs.readFileSync(path.join(REPO, 'computations', 'normalization.js'), 'utf8');
  return [
    fs.readFileSync(path.join(REPO, 'lib', 'date-helpers.js'), 'utf8'),
    fnSource(ud, '_fixISO'),
    fnSource(ud, '_parseISO'),
    // normMonth, billMonth, the chain cache and the majority-days helper: everything before buildMoMap,
    // minus the day-split and gap helpers (they are not part of the month rule).
    nm.slice(0, nm.indexOf('// Project normalization basis')),
  ].join('\n\n');
}
