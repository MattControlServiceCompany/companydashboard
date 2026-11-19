// tools/test-a36-round4-wording.js - round 4 wording fixes (2026-11-14). SYNTHETIC data only.
//   A1 Summary sentence has a subject. A2 "zones" (one word) in the Summary gaps; no Glossary.
//   A3 airflow point labels are plain words (one label map). A4 "Affects N of M units: names". A5 heating coil text is true for any coil.
//   A6 "(on 1 of 3 fans)" (no reading in a description). P1 Recommended "What you get" makes no alarm/report claim. P2 Order of Work joins with "and", lower-case "check".
// Run: node tools/test-a36-round4-wording.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const PE = rd('app/pricing-estimator.js');
const RE = rd('app/report-engine.js');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
function fnSrc(src, name) {
  const idx = src.search(new RegExp('function ' + name + '[ ]*[(]'));
  if (idx < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', idx)), d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(idx, j + 1);
}
const sb = { console };
vm.createContext(sb);
vm.runInContext(
  [
    'var EM_POINT_CATEGORIES = [];',
    fnSrc(PE, '_pricingPointLabel'),
    fnSrc(RE, '_a36DetJoin'),
    fnSrc(RE, '_a36DetLibraryTag'),
    fnSrc(RE, '_a36DetEquipNameIn'),
    fnSrc(RE, '_a36DetEquipName'),
    fnSrc(RE, '_a36DetFraction'),
    'function _escHtml(s){ return String(s); }',
    fnSrc(RE, '_a36DetSummaryIssue'),
  ].join('\n'),
  sb,
);

// A3
const dl = sb._pricingPointLabel('discFlow');
const pl = sb._pricingPointLabel('primaryFlow');
check(!/Controller|\(Flow\)/.test(dl + pl) && /Airflow Sensor/.test(dl) && /Airflow Sensor/.test(pl), 'A3. airflow point labels are plain: "' + dl + '" / "' + pl + '"');

// A3b: a label that ends in "Sensor" does not print "sensor sensor"
check(RE.includes("noun + (/ sensor$/i.test(noun) ? '' : ' sensor')"), 'A3. the heading "has no X sensor" has no doubled word');

// A4
const f = { kind: 'seq', issueShort: 'Reheat Valve Control sequence not fully in place', total: 35, units: 1, affected: ['Electrical | FPB-101'], missing: ['x'], missingText: ['Reheat Valve'], section: '5.6.5' };
const html = sb._a36DetSummaryIssue(f);
check(html === 'Reheat Valve Control', 'A4. the Opportunities Summary Issue cell is the short name only, one line (Matt 2026-11-18): ' + html);

// A5
const coilText = 'Controls the heat output of the heating coil; required for morning warm-up, freeze protection and supply air control.';
check(RE.includes(coilText) && PE.includes(coilText) && !/hot water flow through the heating coil/.test(RE + PE), 'A5. heating coil text names no hot water and is the same in both text sources');

// A1
// The Detailed Executive Summary was rewritten 2026-11-16 (Matt: "not really an executive summary"); its work counts now open the Recommendations sentence.
check(!/_todo\.push\('install ' \+/.test(RE) && !/_subHtml\('Recommendations'\)/.test(RE) && !/'The work needed is '/.test(RE), 'A1. Detailed summary has no Recommendations paragraph (removed 2026-11-17, facts only); the old "The work needed is" line is gone');

// A2
check(/_co2Parts\.push\(rptCount\(_dcvZonesMissing\) \+ ' zone terminal unit'/.test(RE) && !/ rooms? have no carbon dioxide/.test(RE) && !/zones have no carbon dioxide sensor, so ventilation/.test(RE), 'A2. Summary gaps say "zones", not "rooms"');
check(!/Glossary/.test(RE.replace(/\/\/[^\n]*/g, '')) &&!/A room or area that one terminal unit controls/.test(RE), 'A2. the Glossary is gone (no Zone row)');

// A6 (a reading and a share join with "for") is gone: a description holds no reading (2026-11-15, no narration).
check(!/bits\[0\] \+ ' for '/.test(RE) && /function some\(keys, noun\)/.test(RE), 'A6. a description holds no reading; a share of units leads the sentence ("On 1 of the 3 fans, ...")');

// P1
// (Matt 2026-11-19) the "What you get" sentence went with the step table: no alarm or report claim, and no sentence left.
check(!/Alarms and reports that show/.test(RE) && !/'Better comfort and efficiency from '/.test(RE), 'P1. Recommended "What you get" is removed: no alarm or report claim');

// P2
check(/parts\.push\(_a36DetJoin\(newNames\)\)/.test(RE) && /l\.charAt\(0\)\.toLowerCase\(\) \+ l\.slice\(1\)/.test(RE), 'P2. Order of Work joins with "and" and lower-cases the first letter of a later name (Matt 2026-11-19: the names are the A36_SCOPE_PROGRAM names)');
const names = ['Duct Static Pressure Reset', 'Check a zone air temperature sensor that reads wrong', 'Check a discharge airflow sensor that reads wrong'].map((l, gi) => (gi > 0 ? l.replace(/^Check /, 'check ') : l));
check(sb._a36DetJoin(names) === 'Duct Static Pressure Reset, check a zone air temperature sensor that reads wrong and check a discharge airflow sensor that reads wrong', 'P2. joined text reads as one sentence');

console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
