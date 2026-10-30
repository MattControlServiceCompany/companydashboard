// OCR values space, open on Bill 1, Create meter on the bar. Synthetic data only.
const fs = require('fs');
const vm = require('vm');
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const run = (c) => vm.runInContext(c, sb);
const src = fs.readFileSync(__dirname + '/../app/bill-analysis.js', 'utf8');

// #2: a file not open yet opens on Bill 1, even when an old index is left over; a pick stays within the file.
const rq = src.slice(src.indexOf('function renderQueueResults'), src.indexOf('function selectQueueFile'));
ok(/_pdfOpenedFor !== activeResult/.test(rq) && /_mbBillIdxAtNo\(1\)/.test(rq), 'queue view opens a new file on Bill 1');
ok(!/_pdfMultiIdx = window\._pdfMultiIdx \|\| 0/.test(rq), 'queue view does not keep the old index for a new file');
ok(/_pdfOpenedFor = null/.test(src.slice(src.indexOf('function selectQueueFile'), src.indexOf('function _fmtShortDate'))), 'switching file resets the open rule');

// #1 and #3 with 3 synthetic bills in 3 buildings; bills 2 and 3 have no building.
sb.window._pdfMultiBills = [{ AccountNumber: 'TST-0001', Commodity: 'Gas' }, { AccountNumber: 'TST-0002', Commodity: 'Water' }, { AccountNumber: 'TST-0003', Commodity: 'Water' }];
run('_mbRowOrder = {0:1,1:2,2:3}; _mbRowTargets = {}; _mbRowState = {}');
const nav = { multiAcct: true, bills: sb.window._pdfMultiBills, periods: [{ i: 0 }, { i: 1 }, { i: 2 }], monthOf: {}, groups: [
  { acct: 'TST-0001', name: 'Bldg One', review: 0, types: [{ comm: 'Gas', idxs: [0] }] },
  { acct: 'TST-0002', name: 'Bldg Two', review: 0, types: [{ comm: 'Water', idxs: [1] }] },
  { acct: 'TST-0003', name: 'Bldg Three', review: 1, types: [{ comm: 'Water', idxs: [2] }] },
  { acct: 'TST-0004', name: 'Bldg Four', review: 0, types: [{ comm: 'Water', idxs: [] }] }] };
sb.window._pdfBuildingTab = 'TST-0001';
sb.window._pdfBldgsAll = false;
const cards = (h) => (h.match(/class="pdf-bldg /g) || []).length;
let h = sb.get('_pdfBuildingListHtml')(nav);
ok(cards(h) === 2, 'collapsed: selected + issue building only (' + cards(h) + ')');
ok(/Show all 4 buildings/.test(h), 'toggle says Show all 4 buildings');
ok(/st-review/.test(h), 'issue building stays visible and marked');
sb.window._pdfBldgsAll = true;
h = sb.get('_pdfBuildingListHtml')(nav);
ok(cards(h) === 4 && /Show fewer buildings/.test(h), 'expanded: all 4 cards and a Show fewer toggle');
// one building only: no toggle
sb.window._pdfBldgsAll = false;
h = sb.get('_pdfBuildingListHtml')(Object.assign({}, nav, { groups: [nav.groups[0]] }));
ok(cards(h) === 1 && !/Show all/.test(h), 'one building: no toggle');

// #3: bar link plus Create meter button for no-building; no button for other issues.
run('_pdfDestIssue = function(b){ return b.AccountNumber === "TST-0001" ? null : { kind: "no-building", text: "No matching building or meter" }; }; _mbReviewLive = function(){ return true; }; _pdfBuildingName = function(b,a){ return "Bldg "+a; }; _buildDestCell = function(){ return "PICK"; };');
const bar = sb.get('_mbReviewBarHtml')();
ok((bar.match(/>Create meter</g) || []).length === 2, 'bar line has a Create meter button for each no-building bill');
ok(/onclick="_mbCreateForRow\(1\)"/.test(bar) && /onclick="_mbCreateForRow\(2\)"/.test(bar), 'button runs _mbCreateForRow (same function as the bill box)');
const box = sb.get('_mbBillBoxHtml')(1).html;
ok(/onclick="_mbCreateForRow\(1\)"/.test(box), 'bill box button runs the same function');
const gi = src.slice(src.indexOf('function _mbGoToIssue'), src.indexOf('window._mbGoToIssue'));
ok(/block: 'start'/.test(gi) && /kind === 'dest'/.test(gi), 'issue link scrolls the bill box top into view');
// ready bill: Saves-to and actions share one row
const ready = sb.get('_mbBillBoxHtml')(0).html;
ok(/pdf-dest-acts"><div class="pdf-dest-line">/.test(ready) && (ready.match(/pdf-dest-acts/g) || []).length === 1, 'Saves-to line and actions in one row');
process.exit(bad ? 1 : 0);
