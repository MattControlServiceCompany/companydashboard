#!/usr/bin/env node
// tools/test-report-bills-through-note.js - SYNTHETIC data only.
// _rptV2CoverageNote (app/report-engine.js) decides the "Bills through" line in the Generate Report dialog:
// neutral note when the bills cover the selected period, warning only when they do not.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function assert(c, msg) { if (c) passed++; else { failed++; console.log('  FAIL: ' + msg); } }
const src = fs.readFileSync(path.join(__dirname, '..', 'app/report-engine.js'), 'utf8');
const i = src.indexOf('function _rptV2CoverageNote(');
const S = {};
vm.createContext(S);
if (i < 0) { console.log('  FAIL: _rptV2CoverageNote not found'); process.exit(1); }
vm.runInContext(src.slice(i, src.indexOf('\n}', i) + 2), S);
const note = S._rptV2CoverageNote;

console.log('1. Q3 complete, bills through Sep 30: neutral note, no warning');
let r = note({ complete: true, hasData: true, lastBillDate: '2026-09-30', electricThrough: '2026-09-30', gasThrough: '2026-09-30', missing: [], waitingText: '' });
assert(r && r.text === 'Bills through Sep 30, 2026', 'text, got ' + (r && r.text));
assert(r && r.warn === false, 'no warning when complete');

console.log('2. Q3 incomplete, bills through Aug 31, September missing: warning, plain words');
r = note({ complete: false, hasData: true, lastBillDate: '2026-08-31', electricThrough: '2026-08-31', gasThrough: '2026-08-31',
  missing: [{ commodity: 'Electric', building: 'High School', ym: '2026-09' }], waitingText: 'waiting for Electric High School Sep 2026 bills' });
assert(r && r.warn === true, 'warning when incomplete');
assert(r && /^Bills only through Aug 31, 2026; September is missing/.test(r.text), 'plain-words text, got ' + (r && r.text));

console.log('3. Electric and gas end on different dates, complete: neutral');
r = note({ complete: true, hasData: true, lastBillDate: '2026-09-30', electricThrough: '2026-09-30', gasThrough: '2026-09-28', missing: [], waitingText: '' });
assert(r && r.warn === false && /\(electric\)/.test(r.text), 'neutral two-commodity line, got ' + (r && r.text));

console.log('4. Nothing to say: no bills, complete');
assert(note({ complete: true, hasData: false, lastBillDate: '', electricThrough: '', gasThrough: '', missing: [], waitingText: '' }) === null, 'null');

console.log('5. No bills at all but waiting: warning without a through date');
r = note({ complete: false, hasData: false, lastBillDate: '', electricThrough: '', gasThrough: '', missing: [{ commodity: 'Gas', building: 'A', ym: '2026-07' }, { commodity: 'Gas', building: 'A', ym: '2026-08' }], waitingText: 'waiting for Gas A Jul 2026, Gas A Aug 2026 bills' });
assert(r && r.warn === true && /July and August are missing/.test(r.text), 'got ' + (r && r.text));

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
