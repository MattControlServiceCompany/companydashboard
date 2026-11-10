// Test: one rule for the savings months (getSavingsPostRows, computations/savings.js).
// (1) Known values: rows after the baseline end book savings; incompleteCycle (stub) rows do not; a partial row that is a
//     complete cycle (straddles a month boundary) still does.
// (2) The quarterly report lists the same months: report-engine.js reads getSavingsPostRows, and no app/computations file
//     makes its own "after the baseline end" savings filter (anomaly detection is a different, stricter rule: allowed).
// Before this rule the report kept stub rows; getMeterSavings had no row for them, so the month's baseline was NaN.
// Run: node tools/test-savings-post-rows.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL ' + m)));

const src = fs.readFileSync(path.join(root, 'computations/savings.js'), 'utf8');
const i = src.indexOf('function getSavingsPostRows(');
ok(i >= 0, 'getSavingsPostRows is defined in computations/savings.js');
if (i >= 0) {
  let j = src.indexOf('{', src.indexOf(')', i)),
    d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(i, j + 1), ctx);
  const rows = [
    { ym: '2025-12' }, // baseline year
    { ym: '2026-01' },
    { ym: '2026-02', partial: true, incompleteCycle: false }, // complete cycle across a month boundary
    { ym: '2026-03', partial: true, incompleteCycle: true }, // stub bill: no savings
    { ym: '2026-04' },
  ];
  const got = ctx.getSavingsPostRows(rows, '2025-12').map((r) => r.ym);
  ok(JSON.stringify(got) === JSON.stringify(['2026-01', '2026-02', '2026-04']), 'post rows ' + JSON.stringify(got));
  ok(ctx.getSavingsPostRows(null, '2025-12').length === 0, 'null rows -> []');
  ok(ctx.getSavingsPostRows(rows, '2026-04').length === 0, 'nothing after the baseline end -> []');
}

const sav = src.replace(/function getSavingsPostRows\([\s\S]*?\r?\n}\r?\n/, '');
ok(/getSavingsPostRows\(allRows, blEnd\)/.test(sav), 'getMeterSavings reads getSavingsPostRows');
const rpt = fs.readFileSync(path.join(root, 'app/report-engine.js'), 'utf8');
ok(/const postRows = getSavingsPostRows\(allRows, blEnd\)/.test(rpt), 'report-engine.js reads getSavingsPostRows');

// No second savings-month filter. Allowed: anomaly detection (excludes every partial/zero-fill row on purpose) and the
// Meter Performance display rows (utility-data.js truePostRows, which then drops incompleteCycle for its totals).
const ALLOW = [/computations[\\/]anomaly-detection\.js$/, /app[\\/]utility-data\.js$/];
const files = [];
for (const dir of ['app', 'computations'])
  for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
for (const f of files) {
  if (ALLOW.some((re) => re.test(f))) continue;
  const t = /computations[\\/]savings\.js$/.test(f) ? sav : fs.readFileSync(path.join(root, f), 'utf8'); // savings.js without the owner
  const hits = t.split('\n').filter((l) => /\.filter\(\(?r\)?\s*=>\s*r\.ym\s*>\s*blEnd/.test(l));
  ok(!hits.length, f + ': own savings-month filter (use getSavingsPostRows): ' + hits.join(' | ').trim());
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
