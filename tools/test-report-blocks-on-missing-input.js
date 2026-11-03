// tools/test-report-blocks-on-missing-input.js - a quarterly report is NOT built while a bill or a month of weather
// is missing (Matt 2026-11-03). Weather is tested directly: the reporting months' CDD (kW baseline) and the baseline months' HDD and CDD. The reason is an internal message in the Generate Report dialog.
// Run: node tools/test-report-blocks-on-missing-input.js   SYNTHETIC stubs only.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.env.APP_ROOT || path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) { passed++; console.log('  ok   ' + m); } else { failed++; console.log('  FAIL ' + m); }
}
function sandbox(state) {
  const els = { rptV2BlockedMsg: { style: { display: 'none' }, textContent: '' }, rptPreviewPages: { innerHTML: '' } };
  const sb = {
    console, state, els, window: { addEventListener() {} }, collected: 0, toasts: [],
    document: { getElementById: (id) => els[id] || null },
    showToast: (t) => sb.toasts.push(t),
    getReportCoverage: () => state.cov,
    getUDBldgs: () => [{ id: 'b', meters: [state.meter] }],
    getWeatherForBuilding: () => ({ byYm: state.wx }),
    _rptMeterEligible: () => '',
    _presentedApplied: () => [],
    billMonth: (b) => b.ym,
    weatherWaitingLabel: (y) => y.map((x) => ({ '2026-09': 'Sep 2026' }[x] || x)).join(', '),
    _rptV2ReadConfig: () => ({ projId: 1, reportType: 'quarterly', buildingIds: ['b'], meterIds: [], sections: ['x'] }),
    _rptSelectedPeriod: () => ({ quarter: 3, year: 2026 }),
    reportRequestRange: () => ({ startYm: '2026-07', endYm: '2026-09' }),
    collectReportData: () => { sb.collected++; return null; },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/report-data.js'), 'utf8'), sb);
  vm.runInContext('getReportCoverage = function () { return state.cov; }', sb); // the stub replaces the real coverage rule
  vm.runInContext(fs.readFileSync(path.join(REPO, 'app/report-preview.js'), 'utf8'), sb);
  return sb;
}
const BL = ['2025-07', '2025-08', '2025-09'];
const RP = ['2026-07', '2026-08', '2026-09'];
const meter = { id: 'm', commodity: 'Electric', baseline: { months: BL }, bills: RP.map((ym) => ({ ym })) };
function wxOf(skip) {
  const o = {};
  BL.concat(RP).forEach((ym) => (o[ym] = { hdd: 10, cdd: 20 }));
  Object.keys(skip || {}).forEach((ym) => (o[ym] = skip[ym]));
  return o;
}
const complete = { hasData: true, complete: true, missing: [], yms: ['2026-07', '2026-08', '2026-09'] };

console.log('--- missing weather month: no report, internal message names the month ---');
let sb = sandbox({ cov: complete, meter, wx: wxOf({ '2026-09': { hdd: 5, cdd: null } }) });
vm.runInContext('_rptGeneratePreviewNow({}, { added: [], errors: [] })', sb);
assert(sb.collected === 0, 'collectReportData not called, so no report is built');
assert(sb.els.rptV2BlockedMsg.style.display === '' && /Report not generated/.test(sb.els.rptV2BlockedMsg.textContent), 'message shown inline in the dialog');
assert(/Weather data missing: Sep 2026/.test(sb.els.rptV2BlockedMsg.textContent), 'message names Sep 2026: ' + sb.els.rptV2BlockedMsg.textContent);

console.log('--- missing baseline month HDD: no report, message names the baseline month ---');
sb = sandbox({ cov: complete, meter, wx: wxOf({ '2025-08': { hdd: null, cdd: 3 } }) });
vm.runInContext('_rptGeneratePreviewNow({}, { added: [], errors: [] })', sb);
assert(sb.collected === 0, 'collectReportData not called');
assert(/Baseline weather data missing: 2025-08/.test(sb.els.rptV2BlockedMsg.textContent), 'message names the baseline month: ' + sb.els.rptV2BlockedMsg.textContent);

console.log('--- reporting month with HDD missing but CDD present: report is built (contract needs only CDD there) ---');
sb = sandbox({ cov: complete, meter, wx: wxOf({ '2026-09': { hdd: null, cdd: 4 } }) });
vm.runInContext('_rptGeneratePreviewNow({}, { added: [], errors: [] })', sb);
assert(sb.collected === 1, 'collectReportData called');

console.log('--- missing bill: no report, message names the bill ---');
sb = sandbox({ cov: { hasData: true, complete: false, missing: [{ commodity: 'Gas', building: 'High School', ym: '2026-09' }], yms: ['2026-07', '2026-08', '2026-09'] }, meter, wx: wxOf() });
vm.runInContext('_rptGeneratePreviewNow({}, { added: [], errors: [] })', sb);
assert(sb.collected === 0, 'collectReportData not called');
assert(/Bills missing: Gas High School 2026-09/.test(sb.els.rptV2BlockedMsg.textContent), 'message names the bill: ' + sb.els.rptV2BlockedMsg.textContent);

console.log('--- complete data: report is built, no message ---');
sb = sandbox({ cov: complete, meter, wx: wxOf() });
vm.runInContext('_rptGeneratePreviewNow({}, { added: [], errors: [] })', sb);
assert(sb.collected === 1, 'collectReportData called');
assert(sb.els.rptV2BlockedMsg.style.display === 'none' && sb.els.rptV2BlockedMsg.textContent === '', 'no message');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
