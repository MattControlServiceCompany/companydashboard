// tools/test-bill-flag-rules.js - the bill-flag engine (computations/bill-flags.js).
// Run: node tools/test-bill-flag-rules.js
// SYNTHETIC data only. Loads the REAL functions through tools/bill-flags-sandbox.js.
//   1 gas usage resolver: null (blank) vs 0 (real zero); the numbers did not change
//   2 real zero is never "missing"; a blank with a real charge is
//   3 charge vs usage: a normal rate change does not flag, 3.5x does
//   4 same calendar month: 4x with 2 other years, 8x with 1, none with 0, dead months, bad peers
//   5 the month comes from the ONE month rule (normMonth chain)
//   6 billing errors: dates, gap, overlap, duplicate, propane, sums, gas cost column, reads
//   7 summary: bills vs flags, dismissal by rule, estimated bills, messages
const { makeContext } = require('./bill-flags-sandbox.js');
const ctx = makeContext();
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const rulesOf = (sum, id) => (sum.perBill[id] || []).map((f) => f.rule);
const has = (sum, id, rule) => rulesOf(sum, id).includes(rule);
const anyRule = (sum, rule) => Object.keys(sum.perBill).some((id) => has(sum, id, rule));
const d = (y, m, day) => y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
const nextMonth = (y, m) => (m === 12 ? [y + 1, 1] : [y, m + 1]);

// ── fixture: gas meter, monthly bills 1st to 1st, same seasonal shape every year ──
const SHAPE = [300, 250, 180, 100, 50, 30, 25, 25, 40, 90, 180, 280];
function gasMeter(years, tweak) {
  const bills = [];
  let reads = 1000;
  for (const y of years)
    for (let m = 1; m <= 12; m++) {
      const [ny, nm] = nextMonth(y, m);
      const th = SHAPE[m - 1];
      const cost = th + 23.33;
      const b = {
        id: 'g' + y + '-' + m,
        start: d(y, m, 1),
        end: d(ny, nm, 1),
        therms: String(th),
        gasCharge: String(th),
        customerCharge: '23.33',
        fuelAdjustment: '0',
        thermCost: cost.toFixed(2),
        totalCost: cost.toFixed(2),
        startRead: String(reads),
        endRead: String(reads + th),
        readDifference: String(th),
      };
      reads += th;
      bills.push(b);
    }
  const meter = { id: 'mg', commodity: 'Gas', bills };
  if (tweak) tweak(bills, meter);
  return meter;
}
const find = (meter, id) => meter.bills.find((b) => b.id === id);
const run = (meter) => ctx.computeMeterFlagSummary(meter, null);

// ── 1 resolver ──
console.log('=== 1. gas usage resolver ===');
{
  const r = ctx.resolveGasUsageThermsOrNull;
  assert(r({}) === null, 'no field at all -> null');
  assert(r({ therms: '', naturalGasTherms: '' }) === null, 'blank fields -> null (missing)');
  assert(r({ naturalGasTherms: '0' }) === 0, 'stored "0" -> 0 (real zero)');
  assert(r({ therms: '0', naturalGasTherms: '0' }) === 0, 'both 0 -> 0');
  assert(r({ therms: '12.5' }) === 12.5, 'therms read');
  assert(
    r({ therms: '0', naturalGasTherms: '7' }) === 7,
    'a zero first source does not hide a later non-zero source (old order kept)',
  );
  assert(Math.abs(r({ naturalGasCCF: '100' }) - 103.7) < 1e-6, 'CCF x the one factor');
  assert(r({ naturalGasMMbtu: '2' }) === 20, '1 MMBtu = 10 therms');
  assert(ctx.resolveGasUsageTherms({}) === 0, 'resolveGasUsageTherms: blank -> 0 (callers unchanged)');
  assert(ctx.resolveGasUsageTherms({ naturalGasTherms: '0' }) === 0, 'resolveGasUsageTherms: real 0 -> 0');
  assert(ctx.resolveGasUsageTherms({ therms: '3' }) === 3, 'resolveGasUsageTherms: value unchanged');
  assert(ctx.getBillUsageOrNull({ kwh: '' }, 'Electric') === null, 'electric blank kWh -> null');
  assert(ctx.getBillUsageOrNull({ kwh: '0' }, 'Electric') === 0, 'electric 0 kWh -> 0');
  assert(ctx.getBillUsageOrNull({}, 'Stormwater') === null, 'stormwater has no usage');
  assert(
    ctx.getBillUsageOrNull({ sewerUsage: '', waterUsage: '50' }, 'Sewer') === 50,
    'sewer falls back to water gallons',
  );
}

// ── 2 real zero ──
console.log('=== 2. real zero is not missing ===');
{
  const base = run(gasMeter([2023, 2024]));
  assert(
    base.flaggedBills === 0,
    'fixture sanity: a clean 24-month gas meter has no flags, got ' +
      JSON.stringify(
        Object.values(base.perBill)
          .flat()
          .map((f) => f.rule),
      ),
  );

  const zero = (mut) => {
    const m = gasMeter([2023, 2024], (bills) => Object.assign(find({ bills }, 'g2024-7'), mut));
    return run(m);
  };
  const zeroBill = { gasCharge: '0', fuelAdjustment: '0', totalCost: '23.33', thermCost: '23.33' };
  assert(
    !has(
      zero({ ...zeroBill, therms: '', naturalGasTherms: '0', readDifference: '0', endRead: '0', startRead: '0' }),
      'g2024-7',
      'usage_missing',
    ),
    'stored "0" therms: no usage_missing',
  );
  assert(
    !has(zero({ ...zeroBill, therms: '', readDifference: '0' }), 'g2024-7', 'usage_missing'),
    'blank therms, read difference 0: no usage_missing',
  );
  assert(
    !has(
      zero({ ...zeroBill, therms: '', readDifference: '', startRead: '5000', endRead: '5000' }),
      'g2024-7',
      'usage_missing',
    ),
    'blank therms, previous read = current read: no usage_missing',
  );
  assert(
    !has(zero({ ...zeroBill, therms: '', readDifference: '', startRead: '', endRead: '' }), 'g2024-7', 'usage_missing'),
    'blank therms, only the customer charge billed: no usage_missing',
  );
  assert(
    has(
      zero({
        therms: '',
        gasCharge: '500',
        totalCost: '523.33',
        thermCost: '523.33',
        readDifference: '',
        startRead: '',
        endRead: '',
      }),
      'g2024-7',
      'usage_missing',
    ),
    'blank therms with a $500 gas charge: usage_missing',
  );
  // a real zero never says "missing" in any message
  const s = zero({ ...zeroBill, therms: '', readDifference: '0' });
  assert(!JSON.stringify(s.perBill).includes('issing'), 'no message calls a real zero missing');
  // the stored value stays blank: the engine does not write to the bill
  const m = gasMeter([2023, 2024], (bills) =>
    Object.assign(find({ bills }, 'g2024-7'), { ...zeroBill, therms: '', readDifference: '0' }),
  );
  run(m);
  assert(find(m, 'g2024-7').therms === '', 'engine never changes stored bill values');
}

// ── 3 charge vs usage ──
console.log('=== 3. charge vs usage ===');
{
  // winter rate 40% above summer rate: normal
  const m = gasMeter([2023, 2024], (bills) =>
    bills.forEach((b) => {
      const mo = +b.start.slice(5, 7);
      if (mo === 12 || mo <= 2) {
        const th = +b.therms;
        b.gasCharge = (th * 1.4).toFixed(2);
        b.totalCost = (th * 1.4 + 23.33).toFixed(2);
        b.thermCost = b.totalCost;
      }
    }),
  );
  assert(!anyRule(run(m), 'charge_vs_usage'), 'a 40 percent winter rate change does not flag');
  const hi = gasMeter([2023, 2024], (bills) => {
    const b = find({ bills }, 'g2024-1');
    b.gasCharge = '1500';
    b.totalCost = '1523.33';
    b.thermCost = '1523.33';
  });
  const s = run(hi);
  assert(has(s, 'g2024-1', 'charge_vs_usage'), 'more than 3x the usual rate flags');
  assert(
    /x higher/.test(s.perBill['g2024-1'].find((f) => f.rule === 'charge_vs_usage').message),
    'message says how many times higher',
  );
  // zero-use bill at the meter minimum charge: no flag
  const z = gasMeter([2023, 2024], (bills) =>
    Object.assign(find({ bills }, 'g2024-7'), {
      therms: '0',
      gasCharge: '0',
      totalCost: '23.33',
      thermCost: '23.33',
      readDifference: '0',
      endRead: '0',
      startRead: '0',
    }),
  );
  assert(!has(run(z), 'g2024-7', 'charge_vs_usage'), 'zero-use bill at the usual minimum charge: no flag');
}

// ── 4 same calendar month ──
console.log('=== 4. same calendar month ===');
{
  const scale = (id, factor) => (bills) => {
    const b = find({ bills }, id);
    const th = Math.round(+b.therms * factor);
    b.therms = String(th);
    b.gasCharge = String(th);
    b.totalCost = (th + 23.33).toFixed(2);
    b.thermCost = b.totalCost;
    b.endRead = String(+b.startRead + th);
    b.readDifference = String(th);
  };
  const jan = (years, factor) => run(gasMeter(years, scale('g' + years[years.length - 1] + '-1', factor)));
  assert(
    !has(jan([2022, 2023, 2024], 1.6), 'g2024-1', 'usage_vs_same_month'),
    '+60 percent January with 2 other years: no flag',
  );
  const s5 = jan([2022, 2023, 2024], 5);
  assert(has(s5, 'g2024-1', 'usage_vs_same_month'), '5x with 2 other years: flag');
  const msg = s5.perBill['g2024-1'].find((f) => f.rule === 'usage_vs_same_month').message;
  assert(
    /Jan 2024 therms 1,500/.test(msg) &&
      /other Januarys/.test(msg) &&
      /2022: 300 in 32 days, 2023: 300 in 32 days/.test(msg),
    'message names the bill and the compared years: ' + msg,
  );
  assert(!has(jan([2023, 2024], 5), 'g2024-1', 'usage_vs_same_month'), '5x with only 1 other year: no flag');
  assert(has(jan([2023, 2024], 9), 'g2024-1', 'usage_vs_same_month'), '9x with 1 other year: flag');
  assert(!has(jan([2024], 9), 'g2024-1', 'usage_vs_same_month'), 'no other year: no flag');
  // dead month: July 25 -> 250 is 10x but under 10 percent of the 90th percentile daily use
  assert(
    !has(run(gasMeter([2022, 2023, 2024], scale('g2024-7', 0.04))), 'g2024-7', 'usage_vs_same_month'),
    'dead summer month: no flag',
  );
  // a peer with a billing error is not used: 2022 January has a wrong cost column
  const peer = gasMeter([2021, 2022, 2023, 2024], (bills) => {
    scale('g2024-1', 5)(bills);
    const p = find({ bills }, 'g2022-1');
    p.thermCost = '9999.00';
  });
  const ps = run(peer);
  assert(has(ps, 'g2022-1', 'cost_field_mismatch'), 'fixture: the 2022 peer carries a billing error');
  assert(has(ps, 'g2024-1', 'usage_vs_same_month'), 'still flagged against the two clean peers');
  assert(
    !/2022:/.test(ps.perBill['g2024-1'].find((f) => f.rule === 'usage_vs_same_month').message),
    'the peer with a billing error is not named as a comparison',
  );
}

// ── 5 month rule ──
console.log('=== 5. month comes from normMonth ===');
{
  const bills = [];
  const days = (y, m) => d(y, m, 15);
  for (const y of [2023, 2024, 2025])
    for (let m = 1; m <= 12; m++) {
      const [ny, nm] = nextMonth(y, m);
      const th = SHAPE[m - 1];
      bills.push({
        id: 'p' + y + m,
        start: days(y, m),
        end: days(ny, nm),
        therms: String(th),
        totalCost: String(th + 23.33),
        gasCharge: String(th),
        customerCharge: '23.33',
        fuelAdjustment: '0',
      });
    }
  const meter = { id: 'm15', commodity: 'Gas', bills };
  const sorted = bills.slice();
  const chain = sorted.map((b) => ctx.normMonth(b.start, b.end, true, sorted));
  const target = bills.find((b) => b.id === 'p20259');
  target.therms = String(5000);
  target.gasCharge = '5000';
  target.totalCost = '5023.33';
  const s = ctx.computeMeterFlagSummary(meter, null);
  const f = (s.perBill.p20259 || []).find((x) => x.rule === 'usage_vs_same_month');
  const ym = ctx.normMonth(target.start, target.end, true, sorted);
  const label =
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+ym.slice(5) - 1] +
    ' ' +
    ym.slice(0, 4);
  assert(
    !!f && f.message.startsWith(label),
    'the flag names the normMonth month (' + label + '): ' + (f && f.message.slice(0, 30)),
  );
  assert(chain[0] === '2023-01', '15th-to-15th bills: first bill is January (' + chain[0] + ')');
}

// ── 6 billing errors ──
console.log('=== 6. billing errors ===');
{
  const m1 = gasMeter([2023, 2024], (bills) => {
    const b = find({ bills }, 'g2024-3');
    b.start = '';
    b.end = '';
  });
  const s1 = run(m1);
  assert(
    rulesOf(s1, 'g2024-3').filter((r) => r === 'dates_missing').length === 1,
    'blank start and end: ONE dates_missing flag',
  );

  // gap: 3 days no flag, 4 days flag
  const gapMeter = (gap) =>
    gasMeter([2023, 2024], (bills) => {
      const b = find({ bills }, 'g2024-4');
      const dt = new Date(b.start + 'T12:00:00');
      dt.setDate(dt.getDate() + gap);
      b.start = dt.toISOString().slice(0, 10);
    });
  assert(!anyRule(run(gapMeter(3)), 'period_gap'), 'gap of 3 days: no flag');
  const g4 = run(gapMeter(4));
  assert(has(g4, 'g2024-4', 'period_gap'), 'gap of 4 days: flag');
  assert(
    /No bill covers 04\/01\/2024 to 04\/05\/2024/.test(
      g4.perBill['g2024-4'].find((f) => f.rule === 'period_gap').message,
    ),
    'gap message names the missing date range',
  );
  // overlap: 3 days no flag, 4 days flag
  const ovMeter = (n) =>
    gasMeter([2023, 2024], (bills) => {
      const b = find({ bills }, 'g2024-4');
      const dt = new Date(b.start + 'T12:00:00');
      dt.setDate(dt.getDate() - n);
      b.start = dt.toISOString().slice(0, 10);
    });
  assert(!anyRule(run(ovMeter(3)), 'period_overlap'), 'overlap of 3 days: no flag');
  assert(has(run(ovMeter(4)), 'g2024-4', 'period_overlap'), 'overlap of 4 days: flag on the later bill');
  assert(!has(run(ovMeter(4)), 'g2024-3', 'period_overlap'), 'overlap is flagged once, not on both bills');
  // duplicate
  const dup = gasMeter([2023, 2024], (bills) => bills.push({ ...find({ bills }, 'g2024-5'), id: 'dupe' }));
  assert(
    has(run(dup), 'dupe', 'duplicate_bill') || has(run(dup), 'g2024-5', 'duplicate_bill'),
    'same dates: duplicate_bill',
  );
  // propane: one delivery per bill, no gap or overlap check
  const prop = {
    id: 'mp',
    commodity: 'Propane',
    bills: [
      { id: 'p1', start: '2024-01-01', end: '2024-01-02', gallonsDelivered: '100', totalCost: '300' },
      { id: 'p2', start: '2024-03-01', end: '2024-03-02', gallonsDelivered: '100', totalCost: '300' },
      { id: 'p3', start: '2024-03-01', end: '2024-03-02', gallonsDelivered: '100', totalCost: '301' },
    ],
  };
  const ps = run(prop);
  assert(
    !anyRule(ps, 'period_gap') && !anyRule(ps, 'period_overlap') && !anyRule(ps, 'duplicate_bill'),
    'propane skips gap, overlap and duplicate checks',
  );
  // charge parts vs total
  const cs = (diff) =>
    run(
      gasMeter([2023, 2024], (bills) => {
        const b = find({ bills }, 'g2024-2');
        b.totalCost = (+b.totalCost + diff).toFixed(2);
        b.thermCost = b.totalCost;
      }),
    );
  assert(!anyRule(cs(0.1), 'charge_sum_mismatch'), 'parts differ from total by $0.10: no flag');
  assert(has(cs(0.5), 'g2024-2', 'charge_sum_mismatch'), 'parts differ from total by $0.50: flag');
  // gas cost column: $16,716.39 vs parts giving $4,104.33
  const cc = run(
    gasMeter([2023, 2024], (bills) => {
      const b = find({ bills }, 'g2024-11');
      b.gasCharge = '4080.99';
      b.customerCharge = '23.34';
      b.totalCost = '4104.33';
      b.thermCost = '16716.39';
    }),
  );
  const ccf = (cc.perBill['g2024-11'] || []).find((f) => f.rule === 'cost_field_mismatch');
  assert(
    !!ccf && /\$16,716\.39/.test(ccf.message) && /\$4,104\.33/.test(ccf.message),
    'gas cost column $16,716.39 vs total $4,104.33: flagged with both numbers',
  );
  // electric: Meter1 + Meter2 reads x multipliers
  const elec = (kwh) => ({
    id: 'me',
    commodity: 'Electric',
    bills: [
      {
        id: 'e1',
        start: '2024-01-01',
        end: '2024-02-01',
        kwh: String(kwh),
        totalCost: '500',
        Meter1_ReadDiff: '100',
        Meter1_Multiplier: '10',
        Meter2_ReadDiff: '50',
        Meter2_Multiplier: '10',
      },
    ],
  });
  assert(!anyRule(run(elec(1500)), 'read_usage_mismatch'), 'electric: Meter1 + Meter2 = 1500 kWh: no flag');
  assert(anyRule(run(elec(1000)), 'read_usage_mismatch'), 'electric: kWh 1000 vs 1500 from reads: flag');
  // continuity both directions and rollback
  const cont = (sr) =>
    run({
      id: 'mc',
      commodity: 'Electric',
      bills: [
        {
          id: 'c1',
          start: '2024-01-01',
          end: '2024-02-01',
          kwh: '100',
          totalCost: '10',
          startRead: '1000',
          endRead: '1100',
          readDifference: '100',
          meterMultiplier: '1',
        },
        {
          id: 'c2',
          start: '2024-02-01',
          end: '2024-03-01',
          kwh: '100',
          totalCost: '10',
          startRead: String(sr),
          endRead: String(sr + 100),
          readDifference: '100',
          meterMultiplier: '1',
        },
      ],
    });
  assert(!anyRule(cont(1100), 'read_continuity'), 'reads chain: no flag');
  assert(anyRule(cont(1200), 'read_continuity'), 'start read 100 off the previous end read: flag');
  const roll = run({
    id: 'mr',
    commodity: 'Electric',
    bills: [
      {
        id: 'r1',
        start: '2024-01-01',
        end: '2024-02-01',
        kwh: '100',
        totalCost: '10',
        startRead: '1100',
        endRead: '1000',
        readDifference: '-100',
        meterMultiplier: '1',
      },
    ],
  });
  assert(anyRule(roll, 'read_rollback'), 'read goes backwards: read_rollback');
}

// ── 7 summary ──
console.log('=== 7. summary ===');
{
  const m = gasMeter([2023, 2024], (bills) => {
    const b = find({ bills }, 'g2024-11');
    b.gasCharge = '4080.99';
    b.customerCharge = '23.34';
    b.totalCost = '4104.33';
    b.thermCost = '16716.39';
    b.numberOfDays = '40'; // dates span 30 days
  });
  const s = run(m);
  assert(
    s.flaggedBills === 1 && s.flagCount >= 2,
    'a bill with 2 flags counts as 1 flagged bill and 2+ flags: ' + s.flaggedBills + '/' + s.flagCount,
  );
  assert(ctx.billFlagHoverText(s).startsWith('1 bill flagged for review ('), 'hover text: ' + ctx.billFlagHoverText(s));
  // dismissing one rule leaves the other flags on the same field
  const before = s.perBill['g2024-11'].length;
  find(m, 'g2024-11')._flags = [{ id: 'days_mismatch', dismissed: true }];
  const s2 = run(m);
  assert(
    s2.perBill['g2024-11'].length === before - 1 &&
      !has(s2, 'g2024-11', 'days_mismatch') &&
      has(s2, 'g2024-11', 'cost_field_mismatch'),
    'dismissing one rule removes only that flag',
  );
  find(m, 'g2024-11')._flags = s.perBill['g2024-11'].map((f) => ({ id: f.dismissId, dismissed: true }));
  assert(run(m).flaggedBills === 0, 'all flags dismissed: bill no longer counts');
  // every message states a threshold or compared value, no jargon
  const all = Object.values(s.perBill).flat();
  assert(
    all.every((f) => f.message && /\d/.test(f.message) && f.rule && f.dismissId && f.label && f.severity),
    'every flag has a message with numbers, a rule, a label and a severity',
  );
  assert(
    all.every((f) => !/median|trailing|avg|z-score/i.test(f.message)),
    'no jargon words in messages',
  );
  // building summary = sum of meters
  const bld = { id: 'b1', meters: [gasMeter([2023, 2024]), m] };
  find(m, 'g2024-11')._flags = [];
  const sNow = run(m);
  const bs = ctx.computeBuildingFlagSummary(bld);
  assert(
    bs.flaggedBills === sNow.flaggedBills && bs.flagCount === sNow.flagCount,
    'building summary equals the sum of its meters',
  );
  // the stored facilities-kW flag still counts, and dismissing it works
  const fk = {
    id: 'mk',
    commodity: 'Electric',
    bills: [
      {
        id: 'k1',
        start: '2024-01-01',
        end: '2024-02-01',
        kwh: '100',
        totalCost: '10',
        _flags: [{ id: 'facKWMissing_warn', label: 'Facilities kW is missing.', dismissed: false }],
      },
    ],
  };
  assert(run(fk).flaggedBills === 1, 'stored facilities-kW flag counts');
  fk.bills[0]._flags[0].dismissed = true;
  assert(run(fk).flaggedBills === 0, 'dismissed facilities-kW flag does not count');
  // stale stored flags from the old engine are ignored
  fk.bills[0]._flags = [{ id: 'therms_warn', label: 'old', dismissed: false }];
  assert(run(fk).flaggedBills === 0, 'old stored flags are not read');
}

// ── 8 the Bills tab puts message text (with dollar amounts) into the row title ──
console.log('=== 8. dollar amounts in a row title ===');
{
  const ud = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/utility-data.js'), 'utf8');
  assert(!/'\$1 title="' \+ _flagTitle/.test(ud) && !/'\$1 class="bill-flagged" title="' \+ _flagTitle/.test(ud), 'row title is inserted with a function replacer (a "$1" in a message must not be read as a group)');
}

// -- 9 usage vs usage charge (water and sewer, the meter's own rate from getStoredRate) --
console.log('=== 9. usage does not match charge ===');
{
  const sewer = (mut) => {
    const bills = [];
    for (let i = 0; i < 12; i++) {
      const m = i + 1;
      const gal = 100000 + (i % 3) * 5000;
      bills.push({ id: 's' + i, start: d(2024, m, 1), end: m === 12 ? d(2025, 1, 1) : d(2024, m + 1, 1), sewerUsage: String(gal), sewerCharge: (gal * 0.01).toFixed(2), totalCost: (gal * 0.01).toFixed(2) });
    }
    if (mut) mut(bills);
    return { id: 'ms', commodity: 'Sewer', bills };
  };
  const setCharge = (id, factor) => (bills) => {
    const b = bills.find((x) => x.id === id);
    b.sewerCharge = (+b.sewerCharge * factor).toFixed(2);
    b.totalCost = b.sewerCharge;
  };
  assert(!anyRule(run(sewer()), 'usage_charge_mismatch'), 'clean sewer meter: no flag');
  assert(!anyRule(run(sewer(setCharge('s4', 1.5))), 'usage_charge_mismatch'), 'rate 1.5x the usual: normal rate change, no flag');
  const hi = run(sewer(setCharge('s4', 2.3)));
  assert(has(hi, 's4', 'usage_charge_mismatch'), 'charge 2.3x what the usage costs: flag');
  assert(/Usage does not match charge: 1\d\d,\d{3} gal/.test(hi.perBill.s4.find((f) => f.rule === 'usage_charge_mismatch').message), 'message names the usage and the cost');
  assert(has(run(sewer(setCharge('s4', 0.4))), 's4', 'usage_charge_mismatch'), 'charge 2.5x lower than the usage costs: flag');
  // a tiny bill carrying fixed fees is not tested
  const tiny = run(sewer((bills) => Object.assign(bills[5], { sewerUsage: '300', sewerCharge: '30.00', totalCost: '30.00' })));
  assert(!has(tiny, 's5', 'usage_charge_mismatch'), 'tiny usage with fixed fees: not tested');
  // electric and gas keep the 3x charge rule only
  assert(!anyRule(run(gasMeter([2023, 2024], setCharge2())), 'usage_charge_mismatch'), 'gas is not tested by this rule');
  function setCharge2() {
    return (bills) => {
      const b = find({ bills }, 'g2024-1');
      b.gasCharge = '600';
      b.totalCost = '623.33';
      b.thermCost = '623.33';
    };
  }
}

console.log('test-bill-flag-rules: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
