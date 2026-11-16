// tools/test-defects-rest-2026-11-16.js - SYNTHETIC checks for the full-site review rows D07, D14, D17, D29, D39, D46, D48, D54
// and the HVAC Load Estimate building count. Fixtures are synthetic. Run: node tools/test-defects-rest-2026-11-16.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
let passed = 0,
  failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
function fnSource(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let e = src.indexOf('(', m.index),
    d = 0;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let j = src.indexOf('{', e);
  d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const CSV = read('app/csv-import.js');
const CORE = read('app/core.js');
const SP = read('app/graphics-setpoints.js');
const CHARTS = read('lib/shared-charts.js');
const PRICE = read('app/pricing-estimator.js');
const RPT = read('app/report-engine.js');
const CALC = read('app/calculators.js');
const UTIL = read('app/utility-data.js');

// D07: Documents rows use text labels and each delete asks first
const mtg = fnSource(CSV, 'renderMeetingsList');
ok(!/[\u{1F5D1}\u{1F4DD}\u{1F4C4}\u{1F4CA}]/u.test(mtg.split('mtg-actions')[1] || ''), 'D07 no emoji-only icons in the row actions');
['>Word</button>', '>PDF</button>', '>To Minutes</button>', '>Delete</button>', '>Open</button>'].forEach((t) => ok(mtg.includes(t), 'D07 label ' + t));
ok(/confirmAsync\('Delete this meeting\?'\)/.test(fnSource(CSV, 'deleteMeeting')), 'D07 deleteMeeting confirms');
ok(/confirm\('Delete this saved report\?'\)/.test(fnSource(RPT, 'deleteReport')), 'D07 deleteReport confirms');

// D14 + D17: the badge and the warning icons say why; the meter change icon explains itself
ok(/ud-bill-est-badge" title="\$\{\('ESTIMATED: this row is marked estimated \(the bill record has estimated = true\)/.test(CSV), 'D14 badge tooltip names the field');
ok(/_warnDetail/.test(CSV) && /Object\.values\(_fieldWarningsEarly\)/.test(CSV), 'D14 warning tooltip lists the actual field warnings');
ok(/title="Meter change: this bill has more than one meter line/.test(UTIL), 'D17 meter change icon tooltip');

// D29: Set Points buttons explain themselves; Delete All confirms; empty schedule field says why
ok(/id="sp-delete-all-btn-\$\{projId\}" title="Delete every zone row/.test(SP), 'D29 Delete All tooltip');
ok(/title="Save the zone rows you see now/.test(SP) && /title="Save your edits, then keep a dated copy/.test(SP), 'D29 Save and Save As tooltips');
ok(/confirm\('Delete all ' \+ count/.test(fnSource(SP, 'spDeleteAllZones')), 'D29 Delete All confirms');
ok(/placeholder="No schedule imported"/.test(SP) && !/e\.g\. Monday/.test(SP), 'D29 schedule placeholder is honest');

// D39: the CBECS Median legend entry gets a swatch (the dataset itself is invisible)
ok(/generateLabels/.test(CHARTS) && /ds\._isCbecsRef/.test(CHARTS) && /it\.lineDash = \[6, 4\]/.test(CHARTS), 'D39 legend swatch for CBECS Median');

// D46: an empty measure says so
ok(/emptyMeasure/.test(PRICE) && /empty: no description, savings or cost lines yet/.test(PRICE), 'D46 empty measure label');

// D48: the tab name
ok(!/on the Equipment tab first/.test(RPT) && (RPT.match(/on the Equipment Matrix tab first/g) || []).length === 2, 'D48 Equipment Matrix tab wording');

// D54: CSC share tooltip and save feedback
ok(/title="CSC share: the percent of the verified energy savings/.test(CORE), 'D54 label tooltip');
ok(/'CSC share of savings saved: ' \+ value/.test(fnSource(CORE, 'updateProjPerfSetting')), 'D54 toast names the setting and value');

// HVAC roll-up: "of N buildings" is the one building count (never the Unmatched Bills bucket)
const bldgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'u', _unmatchedSentinel: true }];
const sb = { getUDBldgs: () => bldgs, getIncludedBldgs: () => bldgs.slice(0, 2), hvacEstimateForBuilding: (pid, id) => (id === 'c' || id === 'u' ? null : { savedAt: null, est: { hvacKwh: 10 } }), _HVL_ROLLUP_FIELDS: ['hvacKwh'] };
vm.createContext(sb);
vm.runInContext([fnSource(UTIL, 'isUnmatchedSentinelBldg'), fnSource(UTIL, 'getProjectBuildingCounts'), fnSource(CALC, 'hvacLoadProjectRollup')].join('\n') + '\nthis.r = hvacLoadProjectRollup(1); this.c = getProjectBuildingCounts(1);', sb);
ok(sb.r.of === 3 && sb.c.listed === 3, 'HVAC "of" = ' + sb.r.of + ' equals the Dashboard count ' + sb.c.listed + ' (bucket not counted)');
ok(sb.r.buildings === 2, 'HVAC buildings with an estimate = ' + sb.r.buildings);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
