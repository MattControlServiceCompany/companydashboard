// tools/test-proposal-plain-words.js - Service Proposal: one-time costs, covering prices, plain words.
// 1. Covering prices: the three formerly blank points carry a coverPrice and the rule comment.
// 2. A priced row that has no typed price is never dropped from a total (never null / NaN).
// 3. The Service Proposal builders hold no monthly allowance, no "upon request", no calendar months.
// 4. "1 point" / "N points" are pluralized from the count.
// SYNTHETIC data only. Loads the REAL repo functions into a vm sandbox.
// Run: node tools/test-proposal-plain-words.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
function fnSrc(src, name) {
  const idx = src.search(new RegExp('function ' + name + '[ ]*[(]'));
  const m = idx < 0 ? null : { index: idx };
  if (!m) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', m.index)),
    d = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const PE = rd('app/pricing-estimator.js');
const RE = rd('app/report-engine.js');

// ---- 1. covering prices ----------------------------------------------------------------------------
const map = PE;
[['freezeStat', 250], ['oaFlow', 2500], ['enable', 75]].forEach(([k, v]) => {
  const at = map.indexOf('\n  ' + k + ': {');
  const m = at < 0 ? null : /coverPrice: *([0-9]+)/.exec(map.slice(at, at + 500));
  assert(m && Number(m[1]) === v, k + ' has coverPrice ' + v);
});
assert(/covering estimate, Manager 2026-11-14, Matt: estimated guess that will cover us/.test(PE), 'rule comment is in the code');
assert(/enable:\s*'currentSwitchStatusRelay'/.test(PE), 'enable point has install hours');

// ---- 2. a no-price row is never dropped -------------------------------------------------------------
const sb = { console, Math, parseFloat, isNaN, Object };
vm.createContext(sb);
vm.runInContext(
  [
    'function _pricingWorkbookSettings(){ return null; }',
    'function sget(){ return null; }',
    fnSrc(PE, '_pricingComputeTotals'),
  ].join('\n'),
  sb,
);
const rows = [
  { id: 'a', noSku: true, qty: 2, lineTotal: 500, installLaborTotal: 340, phase: 1 },
  { id: 'b', noSku: true, qty: 1, lineTotal: 75, installLaborTotal: 170, phase: 1 },
  { id: 'c', sku: 'X', qty: 1, lineTotal: 100, phase: 1 },
];
let t = null;
try {
  t = sb._pricingComputeTotals(rows, { rowToggles: {}, manualPrices: {} }, 'p1');
} catch (e) {
  console.log('  total threw: ' + e.message);
}
assert(t && t.pendingPriceCount === 0, 'no pending (excluded) rows when covering prices exist');
assert(t && t.phase1 === 675, 'covering rows are in the phase 1 total (got ' + (t && t.phase1) + ')');
const t2 = sb._pricingComputeTotals(rows, { rowToggles: {}, manualPrices: { a: '1000' } }, 'p1');
assert(t2.phase1 === 100 + 75 + 1000 * 2 + 340, 'a typed price replaces the covering price (got ' + t2.phase1 + ')');
assert(!isNaN(t.phase1) && !isNaN(t2.phase1), 'totals are numbers, never NaN');

// ---- 3. Service Proposal text -----------------------------------------------------------------------
const proposalFns = [
  'rptPageASHRAE36ProposalCover',
  'rptPageASHRAE36ProposalPricing',
  '_rptA36CostSummaryHTML',
  '_rptA36TierDetailPanelHTML',
  '_rptA36TierScopeFacts',
  '_rptA36ProposalSummaryData',
  '_rptA36RecommendedTimelineHTML',
  '_rptA36RecommendedServicesInnerHTML',
  '_rptA36RecommendedScope',
  '_rptA36ScopeLineText',
  '_rptA36ScopeAction',
  '_rptA36ScopeIncludedText',
  '_rptA36VisionInnerHTML',
  '_rptA36ComplianceScopeInnerHTML',
  '_rptA36FullScopeInnerHTML',
];
proposalFns.forEach((f) => {
  const s = fnSrc(RE, f).replace(/^[ 	]*\/\/.*$/gm, '').replace(/[ 	]\/\/ .*$/gm, '');
  assert(!/Available upon request/i.test(s), f + ': no "Available upon request"');
  assert(!/Monthly Allowance|monthly service allowance|_rptMonthlyAllowance/i.test(s), f + ': no monthly allowance');
  assert(!/\b(January|February|March|April|June|July|August|September|October|November|December)\b/.test(s.replace(/\/\/.*$/gm, '')), f + ': no calendar month names');
  assert(!/Hardware & Installation|M&V|Guideline 36/.test(s), f + ': no jargon heading');
});

// ---- 4. plural from the count -----------------------------------------------------------------------
const sb2 = {};
vm.createContext(sb2);
vm.runInContext(fnSrc(RE, '_rptA36ExistingPointsLine'), sb2);
assert(/^1 existing control point needs programming only/.test(sb2._rptA36ExistingPointsLine(1)), '1 point (singular)');
assert(/^181 existing control points need programming only/.test(sb2._rptA36ExistingPointsLine(181)), '181 points (plural)');
assert(/\(no device to install\)\.$/.test(sb2._rptA36ExistingPointsLine(3)), 'says there is no device to install');


// ---- 5. round 3: plain names, one count, one step plan, estimated cost said twice ----------------------
const sb3 = {};
vm.createContext(sb3);
['_rptA36PlainName', '_rptA36PlainRowLabel'].forEach((f) => vm.runInContext(fnSrc(RE, f), sb3));
assert(sb3._rptA36PlainName('Minimum Outside Air') === 'Minimum Outdoor Air', 'Outside Air becomes Outdoor Air');
const chk = sb3._rptA36PlainRowLabel({ isSensorInvestigation: true, category: 'Zone Air Temperature', item: 'Zone Air Temperature Sensor Investigation' });
assert(/^Check a .* sensor that reads wrong$/.test(chk) && !/Investigation/.test(chk), 'investigation row is named in plain words: ' + chk);
const noCmt = (x) => x.replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]\/\/ .*$/gm, '');
const proposalSrc = noCmt(fnSrc(RE, '_rptA36TopGaps') + fnSrc(RE, '_rptA36RecommendedStepPlan') + fnSrc(RE, '_rptA36HardwareCategoryAgg'));
assert(!/Other Hardware|Flow Meters/.test(proposalSrc), 'no Other Hardware / Flow Meters labels');
assert(/_rptA36RoomCo2Qty/.test(fnSrc(RE, '_rptA36TopGaps')), 'top gaps read the room CO2 count from the shared tier data');
// (Matt 2026-11-19) the five-column step table is gone: the scope of work and the Order of Work table read the one step plan.
assert(/_rptA36RecommendedStepPlan/.test(fnSrc(RE, '_rptA36RecommendedScope')) && /_rptA36RecommendedStepPlan/.test(fnSrc(RE, '_rptA36RecommendedTimelineHTML')), 'scope of work and order table read one step plan');
assert(!/Later/.test(noCmt(fnSrc(RE, '_rptA36RecommendedTimelineHTML'))), 'order table has no Later row');
assert(!/plantsByName/.test(RE) && !/plantsByName/.test(fnSrc(RE, 'generateASHRAE36Preview')), 'one plant classification for every report: no plantsByName option (was: proposal data built with plantsByName)');
const oneTime = noCmt(['rptPageASHRAE36ProposalCover', '_rptA36CostSummaryHTML', 'rptPageASHRAE36ProposalPricing', '_rptA36RecommendedServicesInnerHTML', '_rptA36VisionInnerHTML'].map((f) => fnSrc(RE, f)).join('\n')).match(/Each cost is an estimate for the work/g) || [];
assert(oneTime.length === 2, 'estimated cost sentence appears twice (page 1 and Cost Estimate page; Matt 2026-11-18: no number sounds final): ' + oneTime.length);
assert(!/One-time cost|One-Time Cost|Each cost is a one-time cost/.test(noCmt(['_rptA36CostSummaryHTML', 'rptPageASHRAE36ProposalPricing'].map((f) => fnSrc(RE, f)).join('\n'))), 'no One-Time Cost label in the Service Proposal (Estimated Cost)');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
