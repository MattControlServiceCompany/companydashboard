/**
 * gate-printed-read-mismatch.js
 *
 * Gate: a PRINTED read difference and a PRINTED kWh are kept as extracted. End read - start read and
 * read difference x multiplier are only a CHECK, done by ONE function, computePrintedReadMismatch
 * (computations/bill-flags.js), reached through the bill-flag engine (rule printed_read_mismatch).
 * SYNTHETIC numbers only.
 *
 * Fails when:
 *   1. printed values agree                        -> the check reports a mismatch
 *   2. printed read difference wrong vs the reads  -> the check does NOT report it
 *   3. printed kWh differs from difference x mult  -> the check does NOT report it
 *   4. a printed value is absent                   -> the check reports a mismatch (nothing to check)
 *   5. a difference at print rounding (one unit of the coarsest read digit; half a unit of the kWh digit plus
 *      half a unit of the difference digit x multiplier, plus the multiplier's own rounding) -> the check reports it
 *   6. the visible flag is raised for anything but a bill with no printed kWh whose reads disagree with the printed
 *      difference, or readCorrectionMarkers does not store the data record (_printedReadCheck)
 *   7. the reader (_postExtractionVerify, run on synthetic extracted bills) changes a printed read difference or a
 *      printed kWh (also across a meter rollover), does not compute a missing one, or does not record a rollover
 *      disagreement; computePrintedReadMismatch is defined more than once, or the flag engine does not call it
 *   8. the stored record does not follow a repaired or edited read; a number with a suffix (12.00CR) miscounts decimals
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
    {
      id,
      start,
      end,
      startRead: '',
      endRead: '',
      readDifference: '',
      meterMultiplier: '100',
      kwh: '',
      totalCost: '100',
    },
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
  [
    'reads wrong, kWh printed (data only)',
    { ...badReads, _printedReadCheck: { fields: ['readDifference'], kwhComputed: false } },
    0,
  ],
  ['reads wrong, no marker (data only)', { ...badReads }, 0],
  ['printed kWh wrong (data only)', { ...okReads, kwh: '1062' }, 0],
  [
    'reads wrong, kWh computed (the one flag)',
    { ...badReads, _printedReadCheck: { fields: ['readDifference'], kwhComputed: true } },
    1,
  ],
  [
    'rounding, kWh computed',
    { ...okReads, readDifference: '10.5001', _printedReadCheck: { fields: [], kwhComputed: true } },
    0,
  ],
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
  if (want)
    ok(
      r.reasons.length === want && /^Printed read difference does not match/.test(r.reasons[0]),
      'engine case "' + name + '": reason text missing',
    );
  if (!want)
    ok(
      r.all === 0,
      'engine case "' + name + '": a warning showed for a data-only mismatch (flagged bills ' + r.all + ')',
    );
}
// the stored data record: written for every mismatch, with the computed-kWh marker
const mk = (x) => JSON.parse(vm.runInContext('JSON.stringify(readCorrectionMarkers(' + JSON.stringify(x) + '))', ctx));
const ex = {
  StartRead: '1000.0000',
  EndRead: '1010.5010',
  ReadDifference: '10.5000',
  MeterMultiplier: '100',
  kWhConsumed: '1050',
};
ok(
  mk(ex)._printedReadCheck &&
    mk(ex)._printedReadCheck.fields.join() === 'readDifference' &&
    mk(ex)._printedReadCheck.kwhComputed === false,
  'marker: printed kWh case wrong',
);
ok(
  mk({
    ...ex,
    kWhConsumed: '1050.0000',
    _auto_corrected_kWhConsumed: { original: null, corrected: '1050.0000', reason: 'x' },
  })._printedReadCheck.kwhComputed === true,
  'marker: computed kWh not recorded',
);
ok(!mk({ ...ex, EndRead: '1010.5000' })._printedReadCheck, 'marker written for a clean bill');
ok(
  mk({ ...ex, EndRead: '1010.5000', kWhConsumed: '1062' })._printedReadCheck.fields.join() === 'usage',
  'marker: kWh mismatch not recorded',
);

// 7. the reader itself: run _postExtractionVerify (app/bill-analysis.js) on synthetic extracted bills
const rctx = makeContext();
Object.assign(rctx, {
  window: {},
  document: { getElementById: () => null, addEventListener: () => {} },
  navigator: { userAgent: 'node' },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  clearTimeout() {},
  requestAnimationFrame: () => 0,
  addEventListener() {},
  fetch: () => Promise.reject(new Error('no network in gate')),
  forEachCustomerBuilding: () => {},
});
for (const f of ['app/energy-savings.js', 'app/bill-analysis.js'])
  vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), rctx, {
    filename: f,
  });
const extract = async (over, utility, withPrior) => {
  rctx.__bill = Object.assign(
    {
      UtilityName: 'Evergy',
      AccountNumber: '111',
      MeterNumber: 'M1',
      BillingPeriodStart: '2024-01-01',
      BillingPeriodEnd: '2024-02-01',
      StartRead: '1000.0000',
      EndRead: '1010.5000',
      ReadDifference: '10.5000',
      MeterMultiplier: '100',
      kWhConsumed: '1050',
      TotalCurrentCharges: '100.00',
      _rates: {}, // the validation chain runs for a bill that carries parsed rate lines
    },
    over,
  );
  // the recovery pass runs for a PDF with 2 or more bills: withPrior adds the clean bill of the month before
  rctx.__bills = withPrior
    ? [
        {
          ...rctx.__bill,
          BillingPeriodStart: '2023-12-01',
          BillingPeriodEnd: '2024-01-01',
          StartRead: '989.5000',
          EndRead: '1000.0000',
          ReadDifference: '10.5000',
        },
        rctx.__bill,
      ]
    : [rctx.__bill];
  const r = await vm.runInContext(
    '_postExtractionVerify(__bills, ' + JSON.stringify(utility || 'Evergy') + ', "")',
    rctx,
  );
  return r.bills[r.bills.length - 1];
};
const sameNum = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 1e-9;
const markers = (b) =>
  JSON.parse(vm.runInContext('JSON.stringify(readCorrectionMarkers(' + JSON.stringify(b) + '))', rctx));

async function behavior() {
  // reads disagree with the printed difference: printed D and printed kWh stay
  let b = await extract({ EndRead: '1010.5010' });
  ok(
    sameNum(b.ReadDifference, 10.5) && !b._auto_corrected_ReadDifference,
    'reader replaced a printed read difference that disagrees with the reads',
  );
  ok(sameNum(b.kWhConsumed, 1050) && !b._auto_corrected_kWhConsumed, 'reader replaced a printed kWh');
  // printed kWh disagrees with difference x multiplier: printed kWh stays
  b = await extract({ kWhConsumed: '1062' });
  ok(
    sameNum(b.kWhConsumed, 1062) && !b._auto_corrected_kWhConsumed,
    'reader replaced a printed kWh that disagrees with difference x multiplier',
  );
  // rollover with a printed difference that disagrees: printed D stays, dial limit and disagreement are recorded
  const ro = {
    StartRead: '99990',
    EndRead: '12',
    ReadDifference: '25',
    MeterMultiplier: '1',
    kWhConsumed: '25',
  };
  b = await extract(ro);
  ok(
    sameNum(b.ReadDifference, 25) && !b._auto_corrected_ReadDifference,
    'reader replaced a printed read difference across a rollover',
  );
  ok(b._meterRollover && b._meterRollover.boundary === 99999, 'rollover dial limit not recorded');
  const rm = markers(b)._printedReadCheck;
  ok(
    rm && rm.fields.join() === 'readDifference' && rm.limit === 99999,
    'rollover disagreement not recorded in _printedReadCheck',
  );
  // rollover with a printed difference that agrees: kept, no record
  b = await extract({ ...ro, ReadDifference: '22', kWhConsumed: '22' });
  ok(
    sameNum(b.ReadDifference, 22) && !markers(b)._printedReadCheck,
    'agreeing rollover difference changed or recorded',
  );
  // rollover with no printed difference: computed
  b = await extract({ ...ro, ReadDifference: '', kWhConsumed: '22' });
  ok(
    sameNum(b.ReadDifference, 22) && !!b._auto_corrected_ReadDifference,
    'missing difference across a rollover not computed',
  );
  // missing difference: computed from the reads
  b = await extract({ ReadDifference: '' });
  ok(sameNum(b.ReadDifference, 10.5), 'missing read difference not computed');
  // missing kWh: computed from difference x multiplier by the recovery pass (any utility)
  b = await extract({ kWhConsumed: '' }, 'Other Utility', true);
  ok(sameNum(b.kWhConsumed, 1050) && !!b._auto_recovered_kWhConsumed, 'missing kWh not computed');
  ok(markers(b)._printedReadCheck === undefined, 'computed kWh with agreeing reads recorded a mismatch');

  // missing kWh on a bill from the default utility with a read difference x multiplier witness: the reader must not throw, the
  // verification must complete, and kWh is computed (Step 2 of the read chain for one bill, the recovery pass for a PDF
  // with 2 or more bills)
  for (const withPrior of [false, true]) {
    let threw = null;
    try {
      b = await extract({ kWhConsumed: '' }, undefined, withPrior);
    } catch (e) {
      threw = e;
    }
    ok(!threw, 'missing kWh on a default-utility bill made the reader throw: ' + (threw && threw.message));
    if (!threw) {
      ok(sameNum(b.kWhConsumed, 1050), 'missing kWh on a default-utility bill not computed (withPrior=' + withPrior + ')');
      ok(!b._verificationIncomplete && !(b._gateReasons || []).length, 'missing kWh left a verification reason');
    }
  }

  // 8a. the stored record follows a repaired read and an edited read (stored bill shape)
  const rec = {
    fields: ['readDifference'],
    messages: ['x'],
    kwhComputed: true,
  };
  const run = (js, o) =>
    JSON.parse(
      vm.runInContext(
        '(function(){var r=' +
          JSON.stringify(
            Object.assign(
              {
                startRead: '1000.0000',
                endRead: '1010.5010',
                readDifference: '10.5000',
                meterMultiplier: '100',
                kwh: '1050',
                _printedReadCheck: rec,
              },
              o,
            ),
          ) +
          ';' +
          js +
          ';return JSON.stringify(r)})()',
        ctx,
      ),
    );
  ok(
    !run('r.endRead="1010.5000";clearReadCorrectionRecords(r,["endRead"])')._printedReadCheck,
    'edited read: stale record kept',
  );
  const e2 = run('r.endRead="1010.7000";clearReadCorrectionRecords(r,["endRead"])');
  ok(e2._printedReadCheck && /1010\.7000/.test(e2._printedReadCheck.messages[0]), 'edited read: record not recomputed');
  ok(
    !run('_rcApply(r,READ_CHAIN_FIELDS.stored,{end:"1010.5000"})')._printedReadCheck,
    'repaired read: stale record kept',
  );

  // 8b. decimals of the number only; multiplier decimals widen the kWh tolerance
  const dec = (t) => vm.runInContext('_rcDecimals(' + JSON.stringify(t) + ')', ctx);
  ok(
    dec('12.00CR') === 2 && dec('(12.00)') === 2 && dec('$1,234.5') === 1 && dec('12.00 kWh') === 2 && dec('12') === 0,
    'decimals counted on the suffix',
  );
  ok(
    fields({
      start: '1000.0',
      end: '1010.5',
      diff: '10.5',
      mult: '1.5',
      usage: '16.2',
    }) === '',
    'multiplier rounding not in tolerance',
  );
  ok(
    fields({
      start: '1000.0',
      end: '1010.5',
      diff: '10.5',
      mult: '1.5',
      usage: '17.5',
    }) === 'usage',
    'far kWh not reported',
  );
}

// single owner of the check
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const flags = src('computations/bill-flags.js');
ok(
  (flags.match(/function computePrintedReadMismatch\s*\(/g) || []).length === 1,
  'computePrintedReadMismatch not defined exactly once',
);
ok(/computePrintedReadMismatch\(\{/.test(flags), 'flag engine does not call computePrintedReadMismatch');
for (const f of fs.readdirSync(path.join(REPO, 'app')).filter((n) => /\.js$/.test(n)))
  ok(!/function computePrintedReadMismatch/.test(src('app/' + f)), 'second copy of the check in app/' + f);

behavior()
  .catch((e) => problems.push('gate error: ' + ((e && e.stack) || e)))
  .then(() => {
    if (problems.length) {
      console.error('FAIL gate-printed-read-mismatch:\n - ' + problems.join('\n - '));
      process.exit(1);
    }
    console.log('PASS gate-printed-read-mismatch');
  });
