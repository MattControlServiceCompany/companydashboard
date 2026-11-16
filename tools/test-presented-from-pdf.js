// tools/test-presented-from-pdf.js - test for "Mark a quarter as presented" from the delivered PDF.
// Run: node tools/test-presented-from-pdf.js
// SYNTHETIC text only (no client names, no real figures). Checks parsePresentedPdfText (app/presented-savings.js):
//  - each figure is read with the text it came from; a figure that is not in the text is missing (never filled);
//  - the parser does not call any site calculation (every site global it could reach throws);
//  - a negative printed total is stored as printed by savePresentedRecord and kept by totalSavingsWithPresented.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let failed = 0;
function ok(c, msg) {
  if (!c) {
    failed++;
    console.log('FAIL: ' + msg);
  }
}
function src(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

const trap = () => {
  throw new Error('the parser called a site calculation');
};
const sb = { console, _escHtml: String };
['getBuildingSavingsByYM', 'collectReportData', 'totalSavingsWithPresented', 'billableSavingsWithPresented', 'getUDBldgs'].forEach((n) => (sb[n] = trap));
vm.createContext(sb);
vm.runInContext(src('app/presented-savings.js') + '\n;this.parse = parsePresentedPdfText; this.num = _ppNum;', sb);

const B = [
  { id: 'b1', name: 'North Hall' },
  { id: 'b2', name: 'South Annex' },
  { id: 'b3', name: 'East Barn' },
];

// Synthetic report in the layout of a quarterly report: narrative lines + one meter table per commodity.
const q3 = [
  [
    'Test District',
    'Q3 2026 Results',
    'July 2026 through September 2026',
    'Across all 3 buildings, savings measured were -$300 against the allocated target of $900.',
  ],
  [
    'North Hall: savings measured -$150 (-6.8%). Baseline cost $1,000 (2025 rates); actual cost $1,150 (2026',
    'rates). Natural gas: -$50. Electricity: -$100.',
    'South Annex: savings measured $20 (3.1%). Baseline cost $500; actual cost $480. Electricity: $25. Natural gas: -$5.',
    'East Barn: savings measured -$170 (-9.0%). Baseline cost $700; actual cost $870. Propane: $10. Electricity: -$180.',
    'Weather',
    'Cooling degree days were 100.',
  ],
  [
    'North Hall',
    'Electricity, Acct# 111 Performance',
    'Jul 2026 31 1,000 1,200 -200 -20.0% $0.0670 -$13.40',
    'Total 92 3,000 3,500 -500 -16.7% -$33.50',
    'Electricity, Acct# 222 Performance',
    'Total 92 1,000 900 +100 +10.0% $6.70',
    'Natural gas, Acct# 333 Performance',
    'Total 92 2,199 2,703 - 7 6 -22.9% -$50.00',
    'South Annex',
    'Electricity, Acct# 444 Performance',
    'Total 92 5,000 4,000 +1,000 +20.0% $25.00',
    'Electricity, 2025',
    'Total 1,602,932 1,615,411 5,737.6',
    'East Barn',
    'Propane, Acct# 555 Performance',
    'Total 92 24 0 +24 +100.0% $40.07',
  ],
];
const r = parseSyn(q3);
function parseSyn(p) {
  return sb.parse(p, B);
}
ok(r.period && r.period.start === '2026-07' && r.period.end === '2026-09', 'period read');
ok(r.totalDollars && r.totalDollars.value === -300 && /-\$300/.test(r.totalDollars.src), 'negative total read as printed');
ok(r.buildings.b1.dollars.value === -150 && /savings measured -\$150/.test(r.buildings.b1.dollars.src), 'building dollars + source');
ok(r.buildings.b2.dollars.value === 20, 'positive building dollars');
ok(r.buildings.b1.elecDollars.value === -100 && r.buildings.b1.gasDollars.value === -50, 'commodity dollars of building 1');
ok(r.buildings.b2.elecDollars.value === 25 && r.buildings.b2.gasDollars.value === -5, 'commodity dollars of building 2');
ok(r.buildings.b3.propaneDollars.value === 10 && r.buildings.b3.elecDollars.value === -180, 'commodity dollars of building 3');
ok(r.buildings.b1.kwhSaved.value === -400 && /sum of 2 meter totals/.test(r.buildings.b1.kwhSaved.src), 'two electric meters add up, and the source says so');
ok(r.buildings.b1.thermsSaved.value === -76, 'split digits "- 7 6" read as -76');
ok(r.buildings.b2.kwhSaved.value === 1000, 'positive kWh saved');
ok(r.buildings.b3.gallonsSaved.value === 24, 'gallons saved');
ok(!r.buildings.b2.thermsSaved && !r.buildings.b3.thermsSaved && !r.buildings.b1.gallonsSaved, 'a figure not in the text has no value');
ok(!r.buildings.b2.propaneDollars && !r.buildings.b1.propaneDollars, 'commodity dollars not printed stay missing');
ok(!r.buildings.b3.kwhSaved, 'a baseline-data Total row (no Performance heading) is not read');

// Older layout: dollars only in the narrative; the tables carry no readable text.
const q2 = [
  ['Test District Q2 2026 Results', 'April 2026 through June 2026', 'the portfolio achieved $1,500 in verified cost avoidance'],
  [
    'North Hall - On Track North Hall is performing at 13.8% savings ($600 saved) against a baseline cost of $4,000.',
    'South Annex is currently below the performance target at 12.3% savings ($300 saved) against a baseline of $2,000.',
  ],
];
const r2 = parseSyn(q2);
ok(r2.totalDollars.value === 1500, 'older layout total');
ok(r2.buildings.b1.dollars.value === 600 && r2.buildings.b2.dollars.value === 300, 'older layout building dollars');
ok(!r2.buildings.b3.dollars, 'a building the text does not name has no dollars');
ok(Object.keys(r2.buildings.b1).length === 1, 'older layout: only the dollars are read, nothing else is filled');

// Nothing readable at all: every building is empty, no period, no total.
const r3 = parseSyn([['A scanned page with no figures']]);
ok(r3.period === null && r3.totalDollars === null && Object.keys(r3.buildings.b1).length === 0, 'unreadable PDF reads nothing');

ok(sb.num('−$49') === -49 && sb.num('+33,182') === 33182 && sb.num('- 3') === -3 && sb.num('abc') === null, '_ppNum');

// A negative printed total is stored as printed and kept; only the billing floor makes it $0 (computations/savings.js).
const store = {};
const ss = {
  console,
  sget: (k, d) => (store[k] !== undefined ? JSON.parse(JSON.stringify(store[k])) : d),
  sset: (k, v) => {
    store[k] = JSON.parse(JSON.stringify(v));
  },
};
vm.createContext(ss);
const code = src('computations/savings.js');
function fn(name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(code);
  const i = code.indexOf('{', code.indexOf(')', m.index));
  let d = 0;
  let j = i;
  for (; j < code.length; j++) {
    if (code[j] === '{') d++;
    else if (code[j] === '}' && --d === 0) break;
  }
  return code.slice(m.index, j + 1);
}
vm.runInContext(
  'const PRESENTED_SAVINGS_KEY = "en_presented_savings";\n' +
    ['getPresentedRecords', 'presentedMonthRange', 'savePresentedRecord', '_presentedApplied', 'totalSavingsWithPresented', 'floorQuarterSavings'].map(fn).join('\n'),
  ss,
);
const res = vm.runInContext(
  'savePresentedRecord({ projectId: 7, periodStart: "2026-07", periodEnd: "2026-09", presentedAt: "2026-11-09T12:00:00.000Z", documentName: "x", totalDollars: -300, buildings: { b1: { dollars: -150 }, b2: { dollars: 20 }, b3: { dollars: -170 } }, pdfKey: "en_pdf_shared_0123456789abcdef", pdfName: "x.pdf" })',
  ss,
);
ok(res.ok && res.record.totalDollars === -300 && res.record.pdfKey === 'en_pdf_shared_0123456789abcdef', 'record saved with the negative total and the PDF key');
const tot = vm.runInContext(
  'totalSavingsWithPresented(7, ["2026-07","2026-08","2026-09"], { b1: {}, b2: {}, b3: {} }).total',
  ss,
);
ok(tot === -300, 'total of a presented quarter keeps the negative printed total (' + tot + ')');
ok(vm.runInContext('floorQuarterSavings(' + tot + ')', ss) === 0, 'billing floor makes the negative quarter $0 (unchanged)');

console.log(failed ? 'FAILED ' + failed : 'PASS all');
process.exit(failed ? 1 : 0);
