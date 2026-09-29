/**
 * test-currency-format.js (WP-20, math-05 M7 / D4 / D3 / L6)
 * One currency formatter: lib/formatting.js _fmtUSD. Synthetic inputs only.
 * Gate: no local `$c =` / `$f =` copy and no second `_fmtUSD` definition may exist in app/.
 * Usage: node tools/test-currency-format.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let fails = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + JSON.stringify(got) + (ok ? '' : ' (want ' + JSON.stringify(want) + ')'));
}

const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', 'formatting.js'), 'utf8'), ctx);
} catch (e) {
  console.log('FAIL load lib/formatting.js: ' + e.message);
  fails++;
}
const f = ctx._fmtUSD;
if (typeof f !== 'function') {
  console.log('FAIL _fmtUSD is not defined in lib/formatting.js');
  fails++;
}
if (typeof f === 'function') {
eq('negative half rounds away from zero, keeps minus', f(-1234.5), '-$1,235');
eq('positive half rounds up', f(1234.5), '$1,235');
eq('negative small', f(-5), '-$5');
eq('thousands separator en-US', f(1234567), '$1,234,567');
eq('zero', f(0), '$0');
eq('rounds to zero has no minus', f(-0.4), '$0');
eq('numeric string', f('2500'), '$2,500');
eq('null -> null', f(null), null);
eq('undefined -> null', f(undefined), null);
eq('NaN -> null', f(NaN), null);
eq('missing with fallback', f(undefined, '$0'), '$0');
eq('present ignores fallback', f(-12, '$0'), '-$12');
}

// Gate: no local copies in the two files this WP cleaned (other files keep their own, see WP-20 result).
const bad = [];
['app', 'lib', 'computations'].forEach((d) => {
  fs.readdirSync(path.join(root, d)).forEach((fn) => {
    if (!fn.endsWith('.js')) return;
    const rel = d + '/' + fn;
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      if ((rel === 'app/report-engine.js' || rel === 'app/budget.js') && /(^|[^\w$])(const|var|let)\s+\$[cf]\s*=/.test(line)) bad.push(rel + ':' + (i + 1) + ' ' + line.trim());
      if (/function\s+_fmtUSD\s*\(/.test(line) && rel !== 'lib/formatting.js') bad.push(rel + ':' + (i + 1) + ' ' + line.trim());
    });
  });
});
bad.forEach((b) => console.log('COPY ' + b));
eq('no $c/$f copy in report-engine.js/budget.js and no _fmtUSD outside lib/formatting.js', bad.length, 0);
console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
