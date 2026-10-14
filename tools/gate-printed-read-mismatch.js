/**
 * gate-printed-read-mismatch.js
 *
 * Gate: a PRINTED read difference and a PRINTED kWh are kept as extracted. End read - start read and
 * read difference x multiplier are only a CHECK, done by ONE function, computePrintedReadMismatch
 * (computations/bill-flags.js), reached through the bill-flag engine (rule printed_read_mismatch).
 * SYNTHETIC numbers only.
 *
 * Fails when:
 *   1. printed values agree                        -> a flag is raised
 *   2. printed read difference wrong vs the reads  -> no flag
 *   3. printed kWh differs from difference x mult  -> no flag
 *   4. a printed value is absent                   -> a flag is raised (the computed value is used, it agrees)
 *   5. a difference at print rounding (one unit of the coarsest read digit; half a unit of the kWh digit plus
 *      half a unit of the difference digit x multiplier) -> a flag is raised
 *   6. the visible flag is raised for anything but a bill with no printed kWh whose reads disagree with the printed difference, or readCorrectionMarkers does not store the data record (_printedReadCheck)
 *   7. app/bill-analysis.js overwrites a printed read difference or kWh again (the old tolerance tests are back), or
 *      computePrintedReadMismatch is defined more than once, or the flag engine does not call it
 *
 * Usage: node tools/gate-printed-read-mismatch.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { makeContext } = require(path.join(REPO, 'tools', 'bill-flags-sandbox.js'));
const problems = [];
const ok = (c, m) => {
  if (!c) problems.push(m);
};
const ctx = makeContext();
const check = (x) =>
  JSON.parse(vm.runInContext('JSON.stringify(computePrintedReadMismatch(' + JSON.stringify(x) + '))', ctx));
const fields = (x) =>
  check(x)
    .map((m) => m.field)
    .join(',');

// 1. printed values agree (4-decimal reads, multiplier 100)
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5000', mult: '100', usage: '1050' }) === '',
  'agree: flagged',
);
// 2. printed read difference wrong vs the reads (a misread end read, ten units off)
const wrongD = { start: '1000.0000', end: '1010.5010', diff: '10.5000', mult: '100', usage: '1050' };
ok(fields(wrongD) === 'readDifference', 'wrong difference: not flagged only on readDifference');
ok(
  /^Printed read difference does not match end minus start read/.test(check(wrongD)[0].message),
  'reason is not plain words',
);
// 3. printed kWh differs from difference x multiplier
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5000', mult: '100', usage: '1062' }) === 'usage',
  'wrong kWh: not flagged',
);
// 4. printed values absent: nothing to check
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '', mult: '100', usage: '' }) === '',
  'absent difference and kWh: flagged',
);
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5000', mult: '100', usage: null }) === '',
  'absent kWh: flagged',
);
ok(fields({ start: '', end: '', diff: '10.5000', mult: '100', usage: '1050' }) === '', 'absent reads: flagged');
// 5. rounding at the printed precision
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5001', mult: '1', usage: '10.5001' }) === '',
  'one unit read rounding flagged',
);
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5002', mult: '1', usage: '10.5002' }) === 'readDifference',
  'two units not flagged',
);
ok(
  fields({ start: '1000.00', end: '1010.50', diff: '10.51', mult: '10', usage: '105.1' }) === '',
  'one unit at 2 decimals flagged',
);
ok(
  fields({ start: '1000.00', end: '1010.50', diff: '10.52', mult: '10', usage: '105.2' }) === 'readDifference',
  'two units at 2 decimals not flagged',
);
// usage: a difference rounded to 4 decimals x 300 may differ from the printed kWh by 0.015 plus half a kWh digit
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5000', mult: '300', usage: '3150.01' }) === '',
  'kWh inside difference rounding flagged',
);
ok(
  fields({ start: '1000.0000', end: '1010.5000', diff: '10.5000', mult: '300', usage: '3150.1' }) === 'usage',
  'kWh outside rounding not flagged',
);
ok(
  fields({ start: '1000', end: '1010', diff: '10', mult: '100', usage: '1100' }) === 'usage',
  'whole-unit kWh miss not flagged',
);
// rollover is never checked here
ok(fields({ start: '99990', end: '10', diff: '20', mult: '1', usage: '20' }) === '', 'rollover flagged');
// commas in the text
ok(
  fields({ start: '1,000.0000', end: '1,010.5000', diff: '10.5000', mult: '100', usage: '1,050' }) === '',
  'commas flagged',
);

// 6. visible flag: ONLY a bill with no printed kWh (computed kWh, marker kwhComputed) whose reads disagree with the
// printed read difference. A printed-kWh mismatch and a read mismatch with a printed kWh are DATA only (no flag, no badge).
const bill = (id, start, end, o) =>
  Object.assign(
    { id, start, end, startRead: '', endRead: '', readDifference: '', meterMultiplier: '100', kwh: '', totalCost: '100' },
    o,
  );
const meterOf = (second) => ({
  id: 'm',
  commodity: 'Electric',
  inclusive: true,
  bills: [
    bill('b1', '2024-01-01', '2024-02-01', {
      startRead: '1000.0000',
      endRead: '1010.5000',
      readDifference: '10.5000',
      kwh: '1050',
    }),
    bill('b2', '2024-02-01', '2024-03-01', second),
  ],
});
const okReads = { startRead: '1010.5000', endRead: '1021.0000', readDifference: '10.5000', kwh: '1050' };
const badReads = { startRead: '1010.5000', endRead: '1021.0010', readDifference: '10.5000', kwh: '1050' };
const cases = [
  ['agree, kWh computed', { ...okReads, _printedReadCheck: { fields: [], kwhComputed: true } }, 0],
  ['reads wrong, kWh printed (data only)', { ...badReads, _printedReadCheck: { fields: ['readDifference'], kwhComputed: false } }, 0],
  ['reads wrong, no marker (data only)', { ...badReads }, 0],
  ['printed kWh wrong (data only)', { ...okReads, kwh: '1062' }, 0],
  ['reads wrong, kWh computed (the one flag)', { ...badReads, _printedReadCheck: { fields: ['readDifference'], kwhComputed: true } }, 1],
  ['rounding, kWh computed', { ...okReads, readDifference: '10.5001', _printedReadCheck: { fields: [], kwhComputed: true } }, 0],
];
for (const [name, second, want] of cases) {
  const res = vm.runInContext(
    '(function(){var s=computeMeterFlagSummary(' +
      JSON.stringify(meterOf(second)) +
      ',{});var f=(s.perBill.b2||[]).filter(function(x){return x.rule==="printed_read_mismatch"});' +
      'return JSON.stringify({n:f.length,reasons:billFlagReasonList(f),all:s.flaggedBills});})()',
    ctx,
  );
  const r = JSON.parse(res);
  ok(r.n === want, 'engine case "' + name + '": expected ' + want + ' printed_read_mismatch flag(s), got ' + r.n);
  if (want) ok(r.reasons.length === want && /^Printed read difference does not match/.test(r.reasons[0]), 'engine case "' + name + '": reason text missing');
  if (!want) ok(r.all === 0, 'engine case "' + name + '": a warning showed for a data-only mismatch (flagged bills ' + r.all + ')');
}
// the stored data record: written for every mismatch, with the computed-kWh marker
const mk = (x) => JSON.parse(vm.runInContext('JSON.stringify(readCorrectionMarkers(' + JSON.stringify(x) + '))', ctx));
const ex = { StartRead: '1000.0000', EndRead: '1010.5010', ReadDifference: '10.5000', MeterMultiplier: '100', kWhConsumed: '1050' };
ok(mk(ex)._printedReadCheck && mk(ex)._printedReadCheck.fields.join() === 'readDifference' && mk(ex)._printedReadCheck.kwhComputed === false, 'marker: printed kWh case wrong');
ok(
  mk({ ...ex, kWhConsumed: '1050.0000', _auto_corrected_kWhConsumed: { original: null, corrected: '1050.0000', reason: 'x' } })._printedReadCheck
    .kwhComputed === true,
  'marker: computed kWh not recorded',
);
ok(!mk({ ...ex, EndRead: '1010.5000' })._printedReadCheck, 'marker written for a clean bill');
ok(mk({ ...ex, EndRead: '1010.5000', kWhConsumed: '1062' })._printedReadCheck.fields.join() === 'usage', 'marker: kWh mismatch not recorded');

// 7. source checks
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const flags = src('computations/bill-flags.js');
const ba = src('app/bill-analysis.js');
ok(
  (flags.match(/function computePrintedReadMismatch\s*\(/g) || []).length === 1,
  'computePrintedReadMismatch not defined exactly once',
);
ok(/computePrintedReadMismatch\(\{/.test(flags), 'flag engine does not call computePrintedReadMismatch');
ok(
  !/Math\.abs\(curDiff - computedDiff\) > 0\.005/.test(ba),
  'bill-analysis overwrites a printed read difference again',
);
ok(!/Math\.abs\(curKwhForChain - expectedKwh\) > 1/.test(ba), 'bill-analysis overwrites a printed kWh again (Step 2)');
ok(
  !/OCR value \$\{kC\.toFixed\(4\)\} differs by/.test(ba),
  'bill-analysis overwrites a printed kWh again (recovery pass)',
);
for (const f of fs.readdirSync(path.join(REPO, 'app')).filter((n) => /\.js$/.test(n)))
  ok(!/function computePrintedReadMismatch/.test(src('app/' + f)), 'second copy of the check in app/' + f);

if (problems.length) {
  console.error('FAIL gate-printed-read-mismatch:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('PASS gate-printed-read-mismatch');
