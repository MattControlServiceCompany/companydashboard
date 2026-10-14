// Gate: every write of a $/kWh, $/kW, $/therm or $/gallon rate goes through the rate guard.
// The writers are writeRateSet and writeRateField (app/energy-savings.js). They use rateGuardCheck
// (computations/rates.js). Fails when:
//   1. code outside those two functions writes a rate (".rates = ", ".rates[x] = ", "blRates[x] = ", a
//      non-empty "rates:" literal, delete of a rate, Object.assign into rates);
//   2. a function that calls writeRateField does not call rateGuardAccept (a typed rate saved unasked);
//   3. a function that calls writeRateSet with accepted = true does not call rateGuardAccept, and has no
//      "rate-guard accepted upstream:" comment saying where the user said yes;
//   4. a rate input handler (svUpdateMsrRate, wdInputsSetRate) in markup does not pass its input (",this)");
//   5. the writers do not run the check, or the ECM form skips it.
// A new rate write path that skips the validator fails here.
// Run: node tools/gate-rate-write-guard.js
const fs = require('fs');
const path = require('path');
const root = process.env.RATE_GATE_ROOT || path.join(__dirname, '..'); // RATE_GATE_ROOT: tools/test-rate-guard.js points the gate at a temp copy
const files = [];
['app', 'computations', 'lib'].forEach((d) =>
  fs.readdirSync(path.join(root, d)).forEach((f) => /\.js$/.test(f) && files.push(d + '/' + f)),
);
files.push('site-ui.js');

// body of `function NAME(...) {...}` as [start, end) offsets, or null
function funcSpan(text, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(text);
  if (!m) return null;
  let i = text.indexOf('{', text.indexOf(')', m.index));
  let d = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') d++;
    else if (text[j] === '}' && --d === 0) return [m.index, j + 1];
  }
  return null;
}
function allFuncSpans(text) {
  const out = [];
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const sp = funcSpan(text.slice(m.index), m[1]);
    if (sp) out.push({ name: m[1], start: m.index, end: m.index + sp[1] });
  }
  return out;
}
const blank = (s) => s.replace(/[^\r\n]/g, ' ');

const WRITE_PATTERNS = [
  [/\.rates\s*=(?!=)/, 'writes .rates directly'],
  [/\.rates\[[^\]]*\]\s*=(?!=)/, 'writes .rates[x] directly'],
  [/\.rates\.\w+\s*=(?!=)/, 'writes .rates.<field> directly'],
  [/\bblRates\[[^\]]*\]\s*=(?!=)/, 'writes blRates[x] directly'],
  [/\bblRates\s*=(?!=)/, 'writes blRates directly'],
  [/delete\s+[\w.]*\.rates\b/, 'deletes a rate'],
  [/Object\.assign\(\s*[\w.]*\brates\b/, 'Object.assign into rates'],
];

const bad = [];
const texts = {};
files.forEach((f) => {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  texts[f] = text;
  let scan = text;
  ['writeRateSet', 'writeRateField'].forEach((n) => {
    const sp = funcSpan(scan, n);
    if (sp) scan = scan.slice(0, sp[0]) + blank(scan.slice(sp[0], sp[1])) + scan.slice(sp[1]);
  });
  scan.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    WRITE_PATTERNS.forEach(
      ([re, why]) => re.test(line) && bad.push(f + ':' + (i + 1) + ' ' + why + ': ' + line.trim().slice(0, 100)),
    );
  });
  allFuncSpans(text).forEach((fn) => {
    if (fn.name === 'writeRateField' || fn.name === 'writeRateSet') return;
    const body = text.slice(fn.start, fn.end);
    if (/\bwriteRateField\(/.test(body) && !/\brateGuardAccept\(/.test(body))
      bad.push(f + ' function ' + fn.name + ' calls writeRateField without rateGuardAccept');
    // a measure built here must not carry a non-empty rates: literal (use writeRateSet / initMeasureRates)
    if (/\.measures\.push\(/.test(body))
      body.split(/\r?\n/).forEach((l) => {
        if (/^\s*rates:\s*(?!\{\s*\}|null|undefined)\S/.test(l))
          bad.push(f + ' function ' + fn.name + ' builds a measure with a rates: literal: ' + l.trim().slice(0, 80));
      });
    const setTrue = body.split(/\r?\n/).some((l, i, arr) => {
      if (!/\bwriteRateSet\([^;]*\btrue\)/.test(l) || /\{\}/.test(l)) return false;
      return !arr.slice(Math.max(0, i - 3), i + 1).some((x) => /rate-guard accepted upstream:/.test(x));
    });
    if (setTrue && !/\brateGuardAccept(?:All)?\(/.test(body))
      bad.push(
        f +
          ' function ' +
          fn.name +
          ' calls writeRateSet(accepted = true) without rateGuardAccept or a "rate-guard accepted upstream:" comment',
      );
  });
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /(svUpdateMsrRate|wdInputsSetRate)\('[^"]*"/.exec(line);
    if (m && /on(?:change|input)=/.test(line.slice(Math.max(0, m.index - 20), m.index)) && !/,this\)/.test(m[0]))
      bad.push(f + ':' + (i + 1) + ' ' + m[1] + ' input handler does not pass the input (",this)")');
  });
});

// the writers run the ONE check
const es = texts['app/energy-savings.js'];
[
  ['writeRateSet', 'rateGuardCheckSet'],
  ['rateGuardCheckSet', 'rateGuardCheck('],
  ['rateGuardAccept', 'rateGuardCheckSet'],
  ['ensureMeasureRates', 'rateGuardCheckSet'],
].forEach(([fn, needs]) => {
  const sp = funcSpan(es, fn);
  if (!sp) bad.push('app/energy-savings.js missing function ' + fn);
  else if (es.slice(sp[0], sp[1]).indexOf(needs) < 0)
    bad.push('app/energy-savings.js ' + fn + ' does not call ' + needs);
});
// ECM form: since phase 5 (2026-10-14) a calc template has no rate input at all: the matrix prices a template
// result with the measure's own rates (initMeasureRates / measureRatesNow). A rate input there would be a
// second rate entry point outside the guard.
const ecm = texts['app/ecm-calculators.js'];
if (/\bid:\s*'[a-z_]*_rate'/.test(ecm)) bad.push('app/ecm-calculators.js: an ECM template has a rate input again');
if (/_ecmGuardRateInput/.test(ecm)) bad.push('app/ecm-calculators.js: the ECM rate-input guard helper came back');

if (bad.length) {
  console.log('FAIL rate write guard gate\n' + bad.join('\n'));
  process.exit(1);
}
console.log('PASS - every rate write goes through writeRateSet / writeRateField and the rate guard');
