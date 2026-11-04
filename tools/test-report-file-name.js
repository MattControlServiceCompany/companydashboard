// tools/test-report-file-name.js - the one report file-name rule (lib/report-file-name.js). SYNTHETIC data only.
// Run: node tools/test-report-file-name.js
'use strict';
const path = require('path');
const { rptReportFileName } = require(path.join(__dirname, '..', 'lib', 'report-file-name.js'));
let passed = 0,
  failed = 0;
function eq(actual, expected, msg) {
  if (actual === expected) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg + '\n    got:      ' + actual + '\n    expected: ' + expected);
  }
}
const NOW = new Date(2026, 10, 3, 23, 30); // local 2026-11-03, late evening: must not roll to tomorrow
const proj = { client: 'Test District', name: 'Test Project' };

eq(
  rptReportFileName({ project: proj, period: { type: 'quarterly', quarter: 3, year: 2026, } }, '.pdf', NOW),
  'Test District - Quarterly Q3-2026 Savings Report 2026.11.03.pdf',
  'quarterly',
);
eq(
  rptReportFileName({ project: proj, period: { type: 'annual', year: 2026 } }, '.pdf', NOW),
  'Test District - Annual 2026 Savings Report 2026.11.03.pdf',
  'annual',
);
eq(
  rptReportFileName({ project: proj, period: { type: 'cumulative', year: 2026, yearMonths: ['2026-01', '2026-02', '2026-09'] } }, '.pdf', NOW),
  'Test District - Cumulative 2026-01 to 2026-09 Savings Report 2026.11.03.pdf',
  'cumulative names its months, not Annual',
);
eq(
  rptReportFileName({ project: proj, period: { type: 'quarterly', quarter: 1, year: 2026 } }, '.docx', NOW),
  'Test District - Quarterly Q1-2026 Savings Report 2026.11.03.docx',
  'docx extension',
);
eq(rptReportFileName({ project: { name: 'Only Name' }, _ashrae: { type: 'proposal' } }, '.pdf', NOW), 'Only Name - Service Proposal 2026.11.03.pdf', 'proposal uses project name when no client');
eq(rptReportFileName({ project: proj, _ashrae: { type: 'audit' } }, '', NOW), 'Test District - ASHRAE 36 Audit Report 2026.11.03', 'audit, no extension');
eq(rptReportFileName({ project: proj, _soo: true }, '.pdf', NOW), 'Test District - Sequence of Operations 2026.11.03.pdf', 'sequence of operations');
eq(rptReportFileName({ project: proj, _agreement: true }, '.pdf', NOW), 'Test District - Energy Management Services Agreement 2026.11.03.pdf', 'agreement');
eq(
  rptReportFileName({ project: proj, ['_wood' + 'land']: true, building: { name: 'Hall A' } }, '.pdf', NOW),
  'Hall A - Baseline & BAS Savings Report 2026.11.03.pdf',
  'building report uses building name',
);
eq(
  rptReportFileName({ project: { client: 'A/B: "C"?' }, period: { type: 'annual', year: 2026 } }, '.pdf', NOW),
  'A-B- -C- - Annual 2026 Savings Report 2026.11.03.pdf',
  'characters Windows rejects become a dash',
);
eq(rptReportFileName({ project: proj, _utilityAudit: true }, '.docx', NOW), 'Test District - Utility Audit 2026.11.03.docx', 'utility audit');
eq(rptReportFileName({ project: proj, _scorecard: true }, '.pdf', NOW), 'Test District - Building Scorecard 2026.11.03.pdf', 'scorecard');
const fnm = require('../lib/report-file-name.js');
eq(
  fnm.meetingFileName({ projectNickname: 'Test Site', sectionHeading: 'Energy Program', type: 'agenda', date: '2026-11-03T10:00' }, '.docx'),
  'Test Site - Energy Meeting Agenda 2026.11.03.docx',
  'meeting agenda',
);
eq(
  fnm.meetingFileName({ projectNickname: '', sectionHeading: '', type: 'minutes', date: '2026-01-05' }, '.pdf'),
  'Meeting - Meeting Minutes 2026.01.05.pdf',
  'meeting minutes, empty fields',
);
eq(fnm.hvacFileName('Hall/A', '.docx'), 'HVAC Load Estimation - HallA.docx', 'hvac');
eq(fnm.hvacFileName('Hall\\A:B*C?D"E<F>G|H', '.pdf'), 'HVAC Load Estimation - HallABCDEFGH.pdf', 'hvac strips backslash and all unsafe characters');
eq(fnm.meetingFileName({ projectNickname: 'A\\B/C', sectionHeading: 'X:Y', type: 'agenda', date: '2026-11-03' }, '.docx'), 'A-B-C - X-Y Meeting Agenda 2026.11.03.docx', 'meeting strips backslash');
eq(fnm.rptReportFileName({ project: { client: 'A\\B' }, _scorecard: {} }, '.pdf', new Date(2026, 10, 3)), 'A-B - Building Scorecard 2026.11.03.pdf', 'report strips backslash');
console.log('=== report file name: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
