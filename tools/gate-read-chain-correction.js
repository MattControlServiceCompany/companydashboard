/**
 * gate-read-chain-correction.js
 *
 * Gate: a start read, end read or read difference the PDF reader misread is repaired by ONE rule,
 * computeReadCorrection (computations/bill-flags.js), reached by the bill loader (correctMeterReadChain) and by PDF
 * extraction (correctExtractedReadChain). SYNTHETIC numbers only.
 *
 * Fails when:
 *   1. PROPERTY TEST. For multipliers {1, 2, 10, 80, 120, 160, 300, 600, 2400}, read decimals {0, 1, 2, 4} and usage
 *      decimals {0, 1, 2, 3, 4}, with and without a next bill, every 1-digit and 2-digit substitution of every
 *      position of the start read, the end read and the read difference is run through the rule:
 *        (a) a field that was correct is NEVER changed;
 *        (b) a field that is changed becomes its true value;
 *        (c) a clean bill is never changed.
 *      The same holds through correctMeterReadChain (every 1-digit substitution; neighbor bills untouched).
 *      TWO-FIELD: start and end shifted by the same 1- or 2-digit misread offset, with and without a next bill: the
 *      result is the truth or a decline, never anything else.
 *      a0 (no next bill) also needs the previous bill clean and the shift DOWN past the previous bill's start read
 *      (otherwise the previous bill's end read could be the misread; the reader makes such a bill look clean).
 *      ADVERSARIAL: a REAL meter replacement with no next bill (new start read 0, 1 unit, 1, 10, 100, ..., half, one,
 *      two, five, nine, ten, eleven, twenty and a hundred read differences; previous end reads with 1 or 2 nonzero
 *      digits so the coincidence is as close as it can be). A replacement that starts under ten read differences is
 *      NEVER changed. Coincidences at ten read differences or more (a refurbished meter within 2 digits of the chain
 *      values) are counted and printed; the self-check reverts them when the next bill arrives.
 *      CORRELATED: every 1- and 2-digit misread of the read difference with the usage recomputed from it (U = D' x M,
 *      as a misread can store it), with and without a next bill: a correct read is never changed.
 *   2. Scenario cases: both reads off by the same amount (rule a with the next bill, a0 without it), start only (b),
 *      end only (c, needs the next bill), read difference only (d, needs the next bill), the correlated D/usage
 *      misread (end read never moves), a usage too coarse to pin the read difference (declined unless the next bill
 *      pins the end read), two possible culprits (declined); and NO correction for a meter replacement, a multiplier
 *      change, a duplicate bill, bills out of order, an estimated bill, a gap between bills, a rollover, a next bill
 *      that disagrees, a usage that disagrees, the first bill of a chain, a start read under ten read differences
 *      without a next bill.
 *      SELF-CHECK: a provisional (a0) correction stays (its records become rule-a records) when the next bill starts
 *      at the corrected end read and is reverted (reader values back, records gone, read_continuity flag on) when it
 *      does not.
 *   3. A second run changes anything (not idempotent); the original is not kept in _auto_corrected_<field>; the
 *      read_continuity flag stays after a repair; a user-typed value is overwritten; an edit path keeps the record.
 *   4. computeReadCorrection is defined more than once, or the loader / extraction step / bill builders / banner do
 *      not use the shared pieces.
 *
 * Usage: node tools/gate-read-chain-correction.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { makeContext } = require(path.join(REPO, 'tools', 'bill-flags-sandbox.js'));
const problems = [];
const ok = (c, m) => {
  if (!c) problems.push(m);
};
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

let ctx;
try {
  ctx = makeContext();
} catch (e) {
  problems.push('could not load the bill-flag engine: ' + e.message);
}
const have = ctx && typeof ctx.correctMeterReadChain === 'function' && typeof ctx.computeReadCorrection === 'function';
ok(have, 'computations/bill-flags.js does not define computeReadCorrection and correctMeterReadChain');

/* ── synthetic chain ──────────────────────────────────────────────────────────────────────────────
   Three bills on one electric meter. Values are built from integer ticks at the read precision, so every text is
   exact: previous end = cur start, cur end = cur start + difference, next start = cur end, usage = difference x
   multiplier printed at the usage precision. */
const BASE = { start: 413572468, diff: 9036871, prevDiff: 10795312, nextDiff: 5000321 }; // ticks at 4 decimals
function chain(M, rDec, uDec, withNext) {
  const scale = Math.pow(10, 4 - rDec);
  const t = (v) => Math.floor(v / scale); // ticks at rDec
  const txt = (ticks) => (ticks / Math.pow(10, rDec)).toFixed(rDec);
  const S = t(BASE.start),
    D = t(BASE.diff),
    E = S + D,
    P0 = S - t(BASE.prevDiff),
    N1 = E + t(BASE.nextDiff);
  const usage = (dTicks) => ((dTicks * M) / Math.pow(10, rDec)).toFixed(uDec);
  const mk = (id, mo, s, e, d) => ({
    id,
    start: '2020-' + String(mo).padStart(2, '0') + '-01',
    end: '2020-' + String(mo + 1).padStart(2, '0') + '-01',
    startRead: txt(s),
    endRead: txt(e),
    readDifference: txt(d),
    meterMultiplier: String(M),
    kwh: usage(d),
    totalCost: '1000.00',
  });
  const bills = [mk('p', 5, P0, S, S - P0), mk('c', 6, S, E, D)];
  if (withNext) bills.push(mk('n', 7, E, N1, N1 - E));
  return bills;
}
const meter = (bills) => ({ id: 'mt', commodity: 'Electric', bills });
const asInput = (bills) => ({
  prevEnd: bills[0].endRead,
  prevStart: bills[0].startRead,
  prevDiff: bills[0].readDifference,
  prevMult: bills[0].meterMultiplier,
  prevUsage: bills[0].kwh,
  start: bills[1].startRead,
  end: bills[1].endRead,
  diff: bills[1].readDifference,
  mult: bills[1].meterMultiplier,
  usage: bills[1].kwh,
  nextStart: bills[2] ? bills[2].startRead : null,
});
// every 1-digit and (when two is true) 2-digit substitution of a numeric text
function* substitutions(text, two) {
  const pos = [];
  for (let i = 0; i < text.length; i++) if (/\d/.test(text[i])) pos.push(i);
  for (const p of pos)
    for (let c = 0; c <= 9; c++) {
      if (String(c) === text[p]) continue;
      yield text.slice(0, p) + c + text.slice(p + 1);
    }
  if (!two) return;
  for (let a = 0; a < pos.length; a++)
    for (let b = a + 1; b < pos.length; b++)
      for (let c1 = 0; c1 <= 9; c1++) {
        if (String(c1) === text[pos[a]]) continue;
        for (let c2 = 0; c2 <= 9; c2++) {
          if (String(c2) === text[pos[b]]) continue;
          const arr = text.split('');
          arr[pos[a]] = String(c1);
          arr[pos[b]] = String(c2);
          yield arr.join('');
        }
      }
}
const FIELD_KEY = { start: 'startRead', end: 'endRead', diff: 'readDifference' };
const MULTS = [1, 2, 10, 80, 120, 160, 300, 600, 2400];
const RDECS = [0, 1, 2, 4];
const UDECS = [0, 1, 2, 3, 4];
const rc = (m) => ctx.computeMeterFlagSummary(m, null).flaggedBills;
const hasContinuity = (m) =>
  Object.values(ctx.computeMeterFlagSummary(m, null).perBill).some((fl) =>
    fl.some((f) => f.rule === 'read_continuity'),
  );

if (have) {
  /* ── 1. property test on the rule ── */
  const stat = { cases: 0, corrections: 0, declines: 0, clean: 0, wrongField: 0, wrongValue: 0, cleanChanged: 0 };
  const examples = [];
  const note = (kind, M, rDec, uDec, withNext, field, bad, fix) => {
    if (examples.length < 8)
      examples.push(
        `${kind}: M=${M} readDec=${rDec} usageDec=${uDec} next=${withNext} field=${field} misread=${bad} -> ${JSON.stringify(fix)}`,
      );
  };
  for (const M of MULTS)
    for (const rDec of RDECS)
      for (const uDec of UDECS)
        for (const withNext of [true, false]) {
          const bills = chain(M, rDec, uDec, withNext);
          const truth = asInput(bills);
          stat.clean++;
          if (ctx.computeReadCorrection(truth) !== null) {
            stat.cleanChanged++;
            note('clean bill changed', M, rDec, uDec, withNext, '-', '-', ctx.computeReadCorrection(truth));
          }
          for (const field of ['start', 'end', 'diff']) {
            for (const bad of substitutions(truth[field], true)) {
              const x = Object.assign({}, truth, { [field]: bad });
              const fix = ctx.computeReadCorrection(x);
              stat.cases++;
              if (!fix) {
                stat.declines++;
                continue;
              }
              const keys = Object.keys(fix).filter((k) => k !== 'rule');
              const other = keys.filter((k) => k !== field);
              if (other.length) {
                stat.wrongField++;
                note('correct field changed', M, rDec, uDec, withNext, field, bad, fix);
                continue;
              }
              if (fix[field] !== truth[field]) {
                stat.wrongValue++;
                note('wrong value', M, rDec, uDec, withNext, field, bad, fix);
                continue;
              }
              stat.corrections++;
            }
          }
        }
  ok(stat.cleanChanged === 0, 'property: a clean bill was changed (' + stat.cleanChanged + ' of ' + stat.clean + ')');
  ok(
    stat.wrongField === 0,
    'property: a CORRECT field was changed in ' + stat.wrongField + ' of ' + stat.cases + ' cases',
  );
  ok(
    stat.wrongValue === 0,
    'property: a changed field got a WRONG value in ' + stat.wrongValue + ' of ' + stat.cases + ' cases',
  );
  ok(stat.corrections > 0, 'property: the rule never corrected anything');
  console.log(
    `property test: ${stat.cases} misread cases, ${stat.corrections} corrected, ${stat.declines} declined, ` +
      `${stat.wrongField} correct-field changes, ${stat.wrongValue} wrong values, ${stat.cleanChanged}/${stat.clean} clean bills changed`,
  );
  examples.forEach((e) => console.log('  ' + e));

  /* ── 1b. the same through the loader path (1-digit substitutions; neighbors untouched; idempotent) ── */
  const walk = { cases: 0, corrections: 0, bad: 0 };
  for (const M of MULTS)
    for (const rDec of RDECS)
      for (const uDec of UDECS)
        for (const withNext of [true, false])
          for (const field of ['start', 'end', 'diff']) {
            const truthBills = chain(M, rDec, uDec, withNext);
            const key = FIELD_KEY[field];
            for (const bad of substitutions(truthBills[1][key], false)) {
              const m = meter(truthBills.map((b) => ({ ...b })));
              m.bills[1][key] = bad;
              const expectUnchanged = JSON.stringify(truthBills.filter((b, i) => i !== 1));
              const n = ctx.correctMeterReadChain(m);
              walk.cases++;
              const cur = m.bills[1];
              const neighborsSame = JSON.stringify(m.bills.filter((b, i) => i !== 1)) === expectUnchanged;
              const otherKeys = Object.keys(FIELD_KEY)
                .map((f) => FIELD_KEY[f])
                .filter((k) => k !== key);
              const othersSame = otherKeys.every((k) => cur[k] === truthBills[1][k] && !cur['_auto_corrected_' + k]);
              let good = neighborsSame && othersSame;
              if (n === 0) good = good && cur[key] === bad && !cur['_auto_corrected_' + key];
              else {
                walk.corrections++;
                const r = cur['_auto_corrected_' + key];
                good =
                  good &&
                  n === 1 &&
                  cur[key] === truthBills[1][key] &&
                  r &&
                  r.original === bad &&
                  r.corrected === truthBills[1][key];
                const snap = JSON.stringify(m);
                good = good && ctx.correctMeterReadChain(m) === 0 && JSON.stringify(m) === snap;
              }
              if (!good) {
                walk.bad++;
                if (examples.length < 12)
                  examples.push(
                    `loader: M=${M} readDec=${rDec} usageDec=${uDec} next=${withNext} ${key}=${bad} n=${n}`,
                  );
              }
            }
          }
  ok(
    walk.bad === 0,
    'loader path: ' +
      walk.bad +
      ' of ' +
      walk.cases +
      ' 1-digit cases changed a correct value, lost the record or were not idempotent',
  );
  console.log(`loader path: ${walk.cases} 1-digit cases, ${walk.corrections} corrected, ${walk.bad} bad`);
  examples.slice(8).forEach((e) => console.log('  ' + e));

  /* ── 1c. TWO-FIELD: start and end shifted by the same offset (every 1- and 2-digit misread of the start), with and
     without a next bill. The rule must return the truth (both reads) or decline. ── */
  const two = { cases: 0, corrections: 0, declines: 0, wrong: 0 };
  const twoEx = [];
  for (const M of MULTS)
    for (const rDec of RDECS)
      for (const uDec of UDECS)
        for (const withNext of [true, false]) {
          const bills = chain(M, rDec, uDec, withNext);
          const truth = asInput(bills);
          for (const badS of substitutions(truth.start, true)) {
            const off = parseFloat(badS) - parseFloat(truth.start);
            const badE = (parseFloat(truth.end) + off).toFixed(rDec);
            if (parseFloat(badE) < 0) continue;
            const fix = ctx.computeReadCorrection(Object.assign({}, truth, { start: badS, end: badE }));
            two.cases++;
            if (!fix) {
              two.declines++;
              continue;
            }
            if (fix.start === truth.start && fix.end === truth.end && fix.diff === undefined) two.corrections++;
            else {
              two.wrong++;
              if (twoEx.length < 6)
                twoEx.push(`two-field: M=${M} readDec=${rDec} usageDec=${uDec} next=${withNext} S=${badS} E=${badE} -> ${JSON.stringify(fix)}`);
            }
          }
        }
  ok(two.wrong === 0, 'two-field shift: ' + two.wrong + ' of ' + two.cases + ' cases got a wrong result');
  ok(two.corrections > 0, 'two-field shift: nothing was ever corrected');
  console.log(`two-field shift: ${two.cases} cases, ${two.corrections} corrected, ${two.declines} declined, ${two.wrong} wrong`);
  twoEx.forEach((e) => console.log('  ' + e));

  /* ── 1d. ADVERSARIAL: a REAL meter replacement with no next bill. The old meter ends at E_prev; the new meter starts
     at S' and ends at S' + D with the same usage. The bill is right as printed: ANY change is wrong. S' runs over
     realistic new-meter starts; E_prev runs over the closest values the chain can offer (1 or 2 nonzero digits, so a
     near-zero start is within 2 digits of it) plus the normal E_prev. A coincidence = the stored reads are within 2
     digits of the chain values, so the data alone cannot tell the replacement from a misread. ── */
  const advBy = {};
  const adv = { cases: 0, coincidences: 0, coincUnder10D: 0, coincFrom10D: 0, wrong: 0, wrongUnder10D: 0, wrongFrom10D: 0 };
  const advEx = [];
  const misread = (a, b) => {
    if (a.length !== b.length || a === b) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d <= 2;
  };
  for (const M of MULTS)
    for (const rDec of RDECS)
      for (const uDec of UDECS) {
        const bills = chain(M, rDec, uDec, false);
        const truth = asInput(bills);
        const D = parseFloat(truth.diff);
        const width = truth.prevEnd.length; // same digit count as the old meter (leading zeros kept)
        const pad = (v) => {
          let t = Math.max(0, v).toFixed(rDec);
          while (t.length < width) t = '0' + t;
          return t;
        };
        const intDigits = truth.prevEnd.split('.')[0].length;
        const prevEnds = new Set([truth.prevEnd]);
        for (let p = 0; p < intDigits; p++)
          for (let c = 1; c <= 9; c++) {
            prevEnds.add(pad(c * Math.pow(10, p)));
            for (let q = 0; q < p; q++) for (let c2 = 1; c2 <= 9; c2++) prevEnds.add(pad(c * Math.pow(10, p) + c2 * Math.pow(10, q)));
          }
        const starts = new Set();
        [0, Math.pow(10, -rDec), 1, 10, 100, 1000, 10000, D / 2, D, 2 * D, 5 * D, 9 * D, 10 * D, 11 * D, 20 * D, 100 * D].forEach(
          (v) => starts.add(pad(v)),
        );
        for (const Ep of prevEnds)
          for (const Sp of starts) {
            const S = parseFloat(Sp);
            const Ep2 = parseFloat(Ep);
            const Epl = pad(Ep2 + D);
            const E = pad(S + D);
            if (E.length !== width || Epl.length !== width) continue;
            const Dp = parseFloat(truth.prevDiff);
            if (Ep2 - Dp < 0) continue;
            const prevStart = pad(Ep2 - Dp); // the previous bill stays clean (its start moves with its end)
            if (prevStart.length !== width) continue;
            const x = Object.assign({}, truth, { prevEnd: Ep, prevStart, start: Sp, end: E });
            adv.cases++;
            const coinc = misread(Sp, Ep) && misread(E, Epl);
            const under = S < 10 * D;
            if (coinc) {
              adv.coincidences++;
              if (under) adv.coincUnder10D++;
              else adv.coincFrom10D++;
            }
            const fix = ctx.computeReadCorrection(x);
            if (fix) {
              adv.wrong++;
              const k = 'readDec=' + rDec;
              advBy[k] = (advBy[k] || 0) + 1;
              if (under) adv.wrongUnder10D++;
              else adv.wrongFrom10D++;
              if (advEx.length < 6)
                advEx.push(`replacement changed: M=${M} readDec=${rDec} usageDec=${uDec} prevEnd=${Ep} start=${Sp} end=${E} -> ${JSON.stringify(fix)}`);
            }
          }
      }
  ok(
    adv.wrongUnder10D === 0,
    'adversarial: ' + adv.wrongUnder10D + ' real meter replacements starting under ten read differences were changed',
  );
  ok(adv.coincUnder10D > 0, 'adversarial: the generated space holds no near coincidence (test is too weak)');
  console.log(
    `adversarial replacements (no next bill): ${adv.cases} cases, ${adv.coincidences} within 2 digits of the chain ` +
      `(${adv.coincUnder10D} start under 10 x D, ${adv.coincFrom10D} at or above), changed: ${adv.wrongUnder10D} under 10 x D, ` +
      `${adv.wrongFrom10D} at or above (refurbished-meter coincidences; the self-check reverts them on the next bill)`,
  );
  console.log('  refurbished-meter coincidences changed, by read precision: ' + JSON.stringify(advBy));
  advEx.forEach((e) => console.log('  ' + e));

  /* ── 1e. CORRELATED MISREAD: every 1- and 2-digit misread D' of the read difference with the usage recomputed from it
     (U = D' x M), reads correct, with and without a next bill. Nothing may change except D back to the truth. ── */
  const cor = { cases: 0, corrections: 0, declines: 0, wrong: 0 };
  const corEx = [];
  for (const M of MULTS)
    for (const rDec of RDECS)
      for (const uDec of UDECS)
        for (const withNext of [true, false]) {
          const truth = asInput(chain(M, rDec, uDec, withNext));
          for (const badD of substitutions(truth.diff, true)) {
            const x = Object.assign({}, truth, { diff: badD, usage: (parseFloat(badD) * M).toFixed(uDec) });
            const fix = ctx.computeReadCorrection(x);
            cor.cases++;
            if (!fix) {
              cor.declines++;
              continue;
            }
            if (fix.start === undefined && fix.end === undefined && fix.diff === truth.diff) cor.corrections++;
            else {
              cor.wrong++;
              if (corEx.length < 6)
                corEx.push(`correlated: M=${M} readDec=${rDec} usageDec=${uDec} next=${withNext} D=${badD} -> ${JSON.stringify(fix)}`);
            }
          }
        }
  ok(cor.wrong === 0, 'correlated D/usage misread: ' + cor.wrong + ' of ' + cor.cases + ' cases changed a correct read');
  console.log(`correlated D/usage misread: ${cor.cases} cases, ${cor.corrections} D repaired, ${cor.declines} declined, ${cor.wrong} wrong`);
  corEx.forEach((e) => console.log('  ' + e));

  /* ── 2. scenario cases (multiplier 160, 4-decimal reads, 4-decimal usage) ── */
  const base = () => chain(160, 4, 4, true);
  const fixture = (edit, withNext = true) => {
    const b = chain(160, 4, 4, withNext);
    edit(b);
    return meter(b);
  };
  const unchanged = (m, label) => {
    const s = JSON.stringify(m);
    ok(ctx.correctMeterReadChain(m) === 0 && JSON.stringify(m) === s, label + ': something was corrected');
  };
  const T = base();
  const S = T[1].startRead,
    E = T[1].endRead,
    D = T[1].readDifference; // fixture base: start / end / read difference
  const shift = (txt, delta) => (parseFloat(txt) + delta).toFixed(4);

  // clean meter
  unchanged(meter(base()), 'clean meter');

  // rule a: both reads 90 high (two digits swapped in each), next bill pins the end
  const a = fixture((b) => {
    b[1].startRead = shift(S, 90);
    b[1].endRead = shift(E, 90);
  });
  ok(hasContinuity(a), 'setup: rule-a fixture is not flagged by read_continuity before the repair');
  ok(ctx.correctMeterReadChain(a) === 1, 'rule a: expected 1 bill corrected');
  ok(
    a.bills[1].startRead === S && a.bills[1].endRead === E,
    'rule a: wrong result ' + a.bills[1].startRead + ' / ' + a.bills[1].endRead,
  );
  ok(
    a.bills[1]._auto_corrected_startRead &&
      a.bills[1]._auto_corrected_startRead.original === shift(S, 90) &&
      a.bills[1]._auto_corrected_endRead &&
      a.bills[1]._auto_corrected_endRead.original === shift(E, 90) &&
      /start read/i.test(a.bills[1]._auto_corrected_startRead.reason),
    'rule a: the original reader values and the reason are not kept in _auto_corrected_<field>',
  );
  ok(!hasContinuity(a), 'rule a: read_continuity still flags after the repair');
  ok(rc(a) === 0, 'rule a: the bill is still flagged for another rule');
  const aSnap = JSON.stringify(a);
  ok(
    ctx.correctMeterReadChain(a) === 0 && JSON.stringify(a) === aSnap,
    'rule a: a second run changed the bill (not idempotent)',
  );
  // rule a0: the same misread on the NEWEST bill (no next bill): corrected, provisional reason, flag cleared
  const a0 = fixture((b) => {
    b[1].startRead = shift(S, -1100);
    b[1].endRead = shift(E, -1100);
  }, false);
  ok(ctx.correctMeterReadChain(a0) === 1, 'rule a0: the newest bill with both reads shifted was not corrected');
  ok(
    a0.bills[1].startRead === S &&
      a0.bills[1].endRead === E &&
      a0.bills[1]._auto_corrected_startRead &&
      a0.bills[1]._auto_corrected_startRead.original === shift(S, -1100) &&
      /No later bill exists yet/.test(a0.bills[1]._auto_corrected_startRead.reason) &&
      a0.bills[1]._auto_corrected_endRead &&
      a0.bills[1]._auto_corrected_endRead.original === shift(E, -1100),
    'rule a0: wrong result or record ' + JSON.stringify(a0.bills[1]),
  );
  ok(!hasContinuity(a0), 'rule a0: read_continuity still flags after the repair');
  const a0Snap = JSON.stringify(a0);
  ok(ctx.correctMeterReadChain(a0) === 0 && JSON.stringify(a0) === a0Snap, 'rule a0: not idempotent');
  // a0 is declined when the two offsets differ (print rounding between them cannot be ruled out)
  unchanged(
    fixture((b) => {
      b[1].startRead = shift(S, 90);
      b[1].endRead = shift(E, 90.0001);
    }, false),
    'rule a0 with two different offsets',
  );
  // a0 is declined when the start read is under ten read differences (a replaced meter starts near zero)
  unchanged(
    meter(
      (() => {
        const bills = chain(160, 4, 4, false);
        bills[0].startRead = '05000.0000';
        bills[0].endRead = '05900.0000';
        bills[0].readDifference = '900.0000';
        bills[0].kwh = (900 * 160).toFixed(4);
        bills[1].startRead = '04900.0000';
        bills[1].endRead = '05500.0000';
        bills[1].readDifference = '600.0000';
        bills[1].kwh = (600 * 160).toFixed(4);
        return bills;
      })(),
    ),
    'rule a0 with a start read under ten read differences',
  );
  // a0 is declined when the shift is UP, or down by less than the previous bill's read difference: the previous
  // bill's end read could be the misread instead, so the bill waits for the next bill
  unchanged(
    fixture((b) => {
      b[1].startRead = shift(S, 1100);
      b[1].endRead = shift(E, 1100);
    }, false),
    'rule a0 with an upward shift',
  );
  unchanged(
    fixture((b) => {
      b[1].startRead = shift(S, -990);
      b[1].endRead = shift(E, -990);
    }, false),
    'rule a0 with a shift smaller than the previous read difference',
  );
  // THE OTHER EXPLANATION, really: the PREVIOUS bill's end read was misread 1100 high and the reader rewrote its
  // read difference and usage to match (D = E - S, U = D x M). The newest bill is right. It must NOT change.
  unchanged(
    fixture((b) => {
      b[0].endRead = shift(b[0].endRead, 1100);
      b[0].readDifference = shift(b[0].readDifference, 1100);
      b[0].kwh = (parseFloat(b[0].readDifference) * 160).toFixed(4);
    }, false),
    'previous bill end read misread high with its difference and usage rewritten',
  );
  // the previous bill's end read misread, difference rewritten, usage kept: the previous bill is not clean -> declined
  unchanged(
    fixture((b) => {
      b[0].endRead = shift(b[0].endRead, 1100);
      b[0].readDifference = shift(b[0].readDifference, 1100);
    }, false),
    'previous bill end read misread high with its difference rewritten',
  );
  // the previous bill's end read misread LOW by 1100 with difference and usage rewritten; the newest bill is right.
  // Under a0 the newest bill looks shifted up: declined (upward), so nothing changes.
  unchanged(
    fixture((b) => {
      b[0].endRead = shift(b[0].endRead, -1000);
      b[0].readDifference = shift(b[0].readDifference, -1000);
      b[0].kwh = (parseFloat(b[0].readDifference) * 160).toFixed(4);
    }, false),
    'previous bill end read misread low with its difference and usage rewritten',
  );
  // SELF-CHECK a0: the next bill arrives. It starts at the corrected end read -> the correction stays.
  const a0keep = fixture((b) => {
    b[1].startRead = shift(S, -1100);
    b[1].endRead = shift(E, -1100);
  }, false);
  ctx.correctMeterReadChain(a0keep);
  a0keep.bills.push(chain(160, 4, 4, true)[2]);
  ok(ctx.correctMeterReadChain(a0keep) === 1, 'self-check a0 confirm: the records were not upgraded');
  ok(
    a0keep.bills[1].startRead === S &&
      a0keep.bills[1].endRead === E &&
      a0keep.bills[1]._auto_corrected_startRead.original === shift(S, -1100) &&
      !/No later bill exists yet/.test(a0keep.bills[1]._auto_corrected_startRead.reason) &&
      !/No later bill exists yet/.test(a0keep.bills[1]._auto_corrected_endRead.reason) &&
      /next bill starts at the corrected end read/.test(a0keep.bills[1]._auto_corrected_endRead.reason),
    'self-check a0 confirm: values or records wrong ' + JSON.stringify(a0keep.bills[1]),
  );
  const a0keepSnap = JSON.stringify(a0keep);
  ok(
    ctx.correctMeterReadChain(a0keep) === 0 && JSON.stringify(a0keep) === a0keepSnap,
    'self-check a0 confirm: a later run changed the confirmed bill',
  );
  ok(!hasContinuity(a0keep), 'self-check a0 confirm: the chain flags');
  // SELF-CHECK a0: the next bill starts at the READER end read (the shift was real) -> revert, records gone, flag on
  const a0rev = fixture((b) => {
    b[1].startRead = shift(S, -1100);
    b[1].endRead = shift(E, -1100);
  }, false);
  ctx.correctMeterReadChain(a0rev);
  const nextReal = chain(160, 4, 4, true)[2];
  nextReal.startRead = shift(E, -1100);
  nextReal.endRead = shift(nextReal.endRead, -1100);
  a0rev.bills.push(nextReal);
  ok(ctx.correctMeterReadChain(a0rev) === 1, 'self-check a0 contradict: no change reported');
  ok(
    a0rev.bills[1].startRead === shift(S, -1100) &&
      a0rev.bills[1].endRead === shift(E, -1100) &&
      !a0rev.bills[1]._auto_corrected_startRead &&
      !a0rev.bills[1]._auto_corrected_endRead,
    'self-check a0 contradict: the reader values and records were not restored ' + JSON.stringify(a0rev.bills[1]),
  );
  ok(hasContinuity(a0rev), 'self-check a0 contradict: the read_continuity flag is not back on');
  const a0revSnap = JSON.stringify(a0rev);
  ok(
    ctx.correctMeterReadChain(a0rev) === 0 && JSON.stringify(a0rev) === a0revSnap,
    'self-check a0 contradict: a later run changed the reverted bill again',
  );

  // rule b: only the start is wrong (one digit)
  const b = fixture((bb) => (bb[1].startRead = shift(S, 900)));
  ok(
    ctx.correctMeterReadChain(b) === 1 && b.bills[1].startRead === S && b.bills[1].endRead === E,
    'rule b: start not repaired alone',
  );
  ok(!b.bills[1]._auto_corrected_endRead, 'rule b: the end read must not be marked');
  // rule b also when the misread is far inside the read_continuity tolerance (two units of the last digit)
  const b2 = fixture((bb) => (bb[1].startRead = shift(S, 0.0002)));
  ok(
    ctx.correctMeterReadChain(b2) === 1 && b2.bills[1].startRead === S,
    'rule b: a two-unit start misread was not repaired',
  );
  // PRINT ROUNDING: one unit of the last printed digit is never evidence and is never changed
  unchanged(
    fixture((bb) => (bb[1].startRead = shift(S, 0.0001))),
    'one-unit start difference (print rounding)',
  );
  unchanged(
    fixture((bb) => (bb[1].endRead = shift(E, -0.0001))),
    'one-unit end difference (print rounding)',
  );
  unchanged(
    fixture((bb) => (bb[1].readDifference = shift(D, 0.0001))),
    'one-unit difference difference (print rounding)',
  );
  unchanged(
    fixture((bb) => {
      bb[1].endRead = shift(E, -0.0001);
      bb[2].startRead = E; // the next bill starts one unit above this end: the pattern print rounding makes
    }),
    'one-unit chain step (print rounding, next bill pins the other value)',
  );
  unchanged(
    fixture((bb) => {
      bb[1].startRead = shift(S, 0.0001);
      bb[1].endRead = shift(E, 0.0001);
    }),
    'one-unit shift of both reads (print rounding)',
  );

  // rule c: only the end is wrong (one digit); the next bill starts at the true end
  const c = fixture((bb) => (bb[1].endRead = shift(E, -10)));
  ok(
    ctx.correctMeterReadChain(c) === 1 && c.bills[1].endRead === E && c.bills[1].startRead === S,
    'rule c: end not repaired alone',
  );
  ok(!c.bills[1]._auto_corrected_startRead, 'rule c: the start read must not be marked');

  // rule d: the read difference is the misread (tenths digit), the reads are right and the next bill pins the end
  const d = fixture((bb) => (bb[1].readDifference = shift(D, 0.1)));
  ok(ctx.correctMeterReadChain(d) === 1, 'rule d: expected only the read difference corrected');
  ok(d.bills[1].endRead === E && d.bills[1].startRead === S, 'rule d: a correct read was rewritten');
  ok(
    d.bills[1].readDifference === D &&
      d.bills[1]._auto_corrected_readDifference &&
      d.bills[1]._auto_corrected_readDifference.original === shift(D, 0.1) &&
      d.bills[1]._auto_corrected_readDifference.corrected === D &&
      !d.bills[1]._auto_corrected_endRead &&
      !d.bills[1]._auto_corrected_startRead,
    'rule d: the read difference must be corrected with its record',
  );
  // rule d without a next bill: D x M = U cannot decide D against the reads (D and U can be jointly wrong) -> declined
  unchanged(
    fixture((bb) => (bb[1].readDifference = shift(D, 0.1)), false),
    'rule d without a next bill',
  );
  // rule c without a next bill: the same trap in the other direction -> declined
  unchanged(
    fixture((bb) => (bb[1].endRead = shift(E, -10)), false),
    'rule c without a next bill',
  );
  // CORRELATED MISREAD (read-difference misread case): the reader misread D and the stored usage is D x M to the digit, the end read is
  // right, no next bill. The end read must NOT change (an earlier version moved it to start + misread D).
  unchanged(
    fixture((bb) => {
      bb[1].readDifference = shift(D, 0.001);
      bb[1].kwh = (parseFloat(shift(D, 0.001)) * 160).toFixed(4);
    }, false),
    'correlated misread of D and usage, no next bill',
  );
  // the same bill once the next bill starts at the (correct) end read: the end read still never moves
  const corr = fixture((bb) => {
    bb[1].readDifference = shift(D, 0.001);
    bb[1].kwh = (parseFloat(shift(D, 0.001)) * 160).toFixed(4);
  });
  ctx.correctMeterReadChain(corr);
  ok(
    corr.bills[1].endRead === E && corr.bills[1].startRead === S && !corr.bills[1]._auto_corrected_endRead,
    'correlated misread with the next bill: a correct read was rewritten ' + JSON.stringify(corr.bills[1]),
  );
  // a next bill WITHOUT a start read gives no information: a provisional correction stays
  const a0blank = fixture((b) => {
    b[1].startRead = shift(S, -1100);
    b[1].endRead = shift(E, -1100);
  }, false);
  ctx.correctMeterReadChain(a0blank);
  a0blank.bills.push({ ...chain(160, 4, 4, true)[2], startRead: '' });
  const a0blankSnap = JSON.stringify(a0blank);
  ok(
    ctx.correctMeterReadChain(a0blank) === 0 && JSON.stringify(a0blank) === a0blankSnap,
    'self-check: a next bill without a start read changed the provisional correction',
  );
  // a user edit of a provisionally corrected field wins over the self-check too
  const a0user = fixture((b) => {
    b[1].startRead = shift(S, -1100);
    b[1].endRead = shift(E, -1100);
  }, false);
  ctx.correctMeterReadChain(a0user);
  a0user.bills[1].endRead = shift(E, 5);
  a0user.bills.push(nextReal);
  const a0userSnap = JSON.stringify(a0user);
  ok(
    ctx.correctMeterReadChain(a0user) === 0 && JSON.stringify(a0user) === a0userSnap,
    'self-check: a user-typed value on a provisionally corrected bill was touched',
  );

  // COARSE USAGE (the twice-rejected class): multiplier 1, whole-kWh usage, 4-decimal reads. A read difference one
  // tenth off still agrees with the usage, so the usage is NOT evidence for the difference. The correct end read must
  // not change. Without a next bill nothing changes; with it, only the difference changes.
  const coarse = (withNext) => {
    const bills = chain(1, 4, 0, withNext);
    bills[1].readDifference = shift(bills[1].readDifference, 0.1);
    return meter(bills);
  };
  unchanged(coarse(false), 'coarse usage, difference misread, no next bill');
  const co = coarse(true);
  const coTrue = chain(1, 4, 0, true)[1];
  ok(
    ctx.correctMeterReadChain(co) === 1 &&
      co.bills[1].endRead === coTrue.endRead &&
      co.bills[1].startRead === coTrue.startRead &&
      co.bills[1].readDifference === coTrue.readDifference,
    'coarse usage with next bill: expected the difference repaired and the reads untouched, got ' +
      JSON.stringify(co.bills[1]),
  );
  // coarse usage, END misread: the usage cannot say which of end / difference is wrong -> declined
  unchanged(
    meter(
      (() => {
        const bills = chain(1, 4, 0, true);
        bills[1].endRead = shift(bills[1].endRead, 0.1);
        return bills;
      })(),
    ),
    'coarse usage, end misread',
  );

  // two possible culprits: end and difference agree with each other, the usage and the next bill disagree
  const amb = fixture((bb) => {
    bb[1].endRead = shift(E, 0.1);
    bb[1].readDifference = shift(D, 0.1);
    bb[2].startRead = shift(E, 0.1);
    bb[2].endRead = shift(bb[2].endRead, 0.1);
  });
  unchanged(amb, 'two possible culprits (end and difference consistent, usage disagrees)');
  // usage 16 kWh off the difference: not trusted; start matches; end - start = difference -> nothing to do
  unchanged(
    fixture((bb) => (bb[1].kwh = (parseFloat(bb[1].kwh) + 16).toFixed(4))),
    'usage disagrees with a consistent bill',
  );
  // usage far off and reads shifted: declined
  unchanged(
    fixture((bb) => {
      bb[1].startRead = shift(S, 90);
      bb[1].endRead = shift(E, 90);
      bb[1].kwh = '99999.0000';
    }),
    'untrusted usage with shifted reads',
  );

  // NO-CORRECTION SCENARIOS
  // meter replacement: the new meter starts at zero (same text length as the old reads)
  unchanged(
    fixture((bb) => {
      bb[1].startRead = '00000.0000';
      bb[1].endRead = '00902.5000';
      bb[2].startRead = '00902.5000';
      bb[2].endRead = '01402.5000';
    }),
    'meter replacement (same digit count)',
  );
  unchanged(
    fixture((bb) => {
      bb[1].startRead = '12.4000';
      bb[1].endRead = '914.5000';
      bb[2].startRead = '914.5000';
      bb[2].endRead = '1414.5000';
    }),
    'meter replacement (fewer digits)',
  );
  unchanged(
    fixture((bb) => {
      bb[1].startRead = '00000.0000';
      bb[1].endRead = '00902.5000';
    }, false),
    'meter replacement, no next bill',
  );
  // multiplier change mid-chain: reads continue, usage follows the new multiplier
  unchanged(
    fixture((bb) => {
      bb[1].meterMultiplier = '80';
      bb[1].kwh = (parseFloat(D) * 80).toFixed(4);
      bb[2].meterMultiplier = '80';
      bb[2].kwh = (parseFloat(bb[2].readDifference) * 80).toFixed(4);
    }),
    'multiplier change mid-chain',
  );
  // duplicate bill for the same period (an exact copy, and a copy whose start was misread)
  unchanged(
    meter(
      (() => {
        const bills = base();
        bills.splice(2, 0, { ...bills[1], id: 'dup' });
        return bills;
      })(),
    ),
    'duplicate bill',
  );
  unchanged(
    meter(
      (() => {
        const bills = base();
        bills.splice(2, 0, { ...bills[1], id: 'dup', startRead: shift(S, 900) });
        return bills;
      })(),
    ),
    'duplicate bill with a misread copy',
  );
  // bills out of order in storage: sorted by start date, so the clean chain stays clean
  unchanged(meter(base().reverse()), 'bills out of order');
  // estimated bill: never corrected, and the bill after it has no chain link
  unchanged(
    fixture((bb) => {
      bb[1].estimated = true;
      bb[1].startRead = shift(S, 900);
    }),
    'estimated bill',
  );
  unchanged(
    fixture((bb) => {
      bb[0].estimated = true;
      bb[1].startRead = shift(S, 900);
    }),
    'bill after an estimated bill',
  );
  // gap between bills: no chain link
  unchanged(
    fixture((bb) => {
      bb[0].end = '2020-05-20';
      bb[1].startRead = shift(S, 900);
    }),
    'gap between bills',
  );
  // overlapping bill: the next starts before the previous ends -> no link
  unchanged(
    fixture((bb) => {
      bb[1].start = '2020-05-25';
      bb[1].startRead = shift(S, 900);
    }),
    'overlapping bill',
  );
  // rollover: the counter wraps
  unchanged(
    meter([
      {
        ...base()[0],
        startRead: '99000.0000',
        endRead: '99990.0000',
        readDifference: '990.0000',
        kwh: (990 * 160).toFixed(4),
      },
      {
        ...base()[1],
        startRead: '0000.0000',
        endRead: '0925.0000',
        readDifference: '925.0000',
        kwh: (925 * 160).toFixed(4),
      },
      {
        ...base()[2],
        startRead: '0925.0000',
        endRead: '1500.0000',
        readDifference: '575.0000',
        kwh: (575 * 160).toFixed(4),
      },
    ]),
    'rollover',
  );
  // 3-digit change in the start read
  unchanged(
    fixture((bb) => {
      bb[1].startRead = shift(S, 3210);
      bb[1].endRead = shift(E, 3210);
    }),
    '3-digit change',
  );
  // next bill disagrees with the corrected end
  unchanged(
    fixture((bb) => {
      bb[1].endRead = shift(E, -10);
      bb[2].startRead = shift(E, 1000);
    }),
    'next bill disagrees',
  );
  // the first bill of a chain
  ok(
    ctx.correctMeterReadChain(meter(base().slice(1))) === 0
      ? ctx.correctMeterReadChain(meter([{ ...base()[1], startRead: shift(S, 900) }, base()[2]])) === 0
      : false,
    'the first bill of a chain was corrected',
  );
  // read difference printed coarser than the reads: never evidence
  unchanged(
    fixture((bb) => {
      bb[1].readDifference = '902';
      bb[1].kwh = (902 * 160).toFixed(4);
      bb[1].endRead = shift(E, -10);
    }),
    'coarse read difference',
  );

  /* ── 3. user wins, records, edit paths ── */
  const ue = fixture((bb) => (bb[1].endRead = shift(E, -10)));
  ok(ctx.correctMeterReadChain(ue) === 1, 'setup: user-edit fixture not corrected first');
  ue.bills[1].endRead = shift(E, -20); // the user types a read that breaks the chain
  const ues = JSON.stringify(ue);
  ok(
    ctx.correctMeterReadChain(ue) === 0 && JSON.stringify(ue) === ues,
    'a user-typed read after a correction was overwritten again (or its record changed)',
  );
  ok(ue.bills[1]._auto_corrected_endRead.original === shift(E, -10), 'user edit: the original reader value was lost');
  if (typeof ctx.clearReadCorrectionRecords !== 'function') ok(false, 'clearReadCorrectionRecords is not defined');
  else {
    const two = fixture((bb) => {
      bb[1].startRead = shift(S, 90);
      bb[1].endRead = shift(E, 90);
    });
    ctx.correctMeterReadChain(two);
    ctx.clearReadCorrectionRecords(two.bills[1], ['endRead']);
    ok(
      !two.bills[1]._auto_corrected_endRead && !two.bills[1]._auto_corrected_startRead,
      'clearReadCorrectionRecords must clear all read-correction records of the bill when one read field is edited',
    );
    ok(
      two.bills[1]._userCorrected && two.bills[1]._userCorrected.endRead && two.bills[1]._userCorrected.startRead,
      'clearReadCorrectionRecords must stamp _userCorrected for every cleared record',
    );
    // provisional a0 record on both fields, user edits only the end read: the start record must not stay provisional
    const prov = fixture((bb) => {
      bb[1].startRead = shift(S, -1100);
      bb[1].endRead = shift(E, -1100);
    }, false);
    ctx.correctMeterReadChain(prov);
    ok(
      !!prov.bills[1]._auto_corrected_startRead && !!prov.bills[1]._auto_corrected_endRead,
      'setup: the a0 fixture was not repaired',
    );
    prov.bills[1].endRead = shift(E, -1100);
    ctx.clearReadCorrectionRecords(prov.bills[1], ['endRead']);
    ok(
      !prov.bills[1]._auto_corrected_startRead && !prov.bills[1]._auto_corrected_endRead,
      'editing one field of a provisional a0 correction left the other field record behind',
    );
    // editing a non-read field leaves the records alone
    const keep = fixture((bb) => (bb[1].startRead = shift(S, 90)));
    ctx.correctMeterReadChain(keep);
    ctx.clearReadCorrectionRecords(keep.bills[1], ['totalCost']);
    ok(!!keep.bills[1]._auto_corrected_startRead, 'editing a non-read field cleared a read-correction record');
    const ue2 = fixture((bb) => (bb[1].endRead = shift(E, -10)));
    ctx.correctMeterReadChain(ue2);
    ue2.bills[1].endRead = shift(E, -20);
    ctx.clearReadCorrectionRecords(ue2.bills[1], ['endRead']);
    ok(
      ctx.correctMeterReadChain(ue2) === 0 && ue2.bills[1].endRead === shift(E, -20),
      'a user value whose record was cleared was overwritten on the next load',
    );
    const other = { endRead: '1', _auto_corrected_endRead: { original: '2', corrected: '1', reason: 'another rule' } };
    ctx.clearReadCorrectionRecords(other, ['endRead']);
    ok(!!other._auto_corrected_endRead, 'clearReadCorrectionRecords removed a record written by another rule');
  }

  /* ── extraction caller (PDF keys), including a PDF printed newest-first ── */
  const ex = (bill) => ({
    StartRead: bill.startRead,
    EndRead: bill.endRead,
    ReadDifference: bill.readDifference,
    MeterMultiplier: bill.meterMultiplier,
    kWhConsumed: bill.kwh,
    BillingPeriodStart: bill.start,
    BillingPeriodEnd: bill.end,
    Commodity: 'Electric',
  });
  const dayGap = (p, q) => ctx.calcDays(p.BillingPeriodEnd, q.BillingPeriodStart, false);
  const runPdf = (bills) =>
    ctx.correctExtractedReadChain(
      bills,
      () => true,
      dayGap,
      (x) => parseFloat(x.kWhConsumed),
      () => false,
    );
  const pdfBills = base().map(ex);
  pdfBills[1].StartRead = shift(S, 900);
  ok(
    runPdf(pdfBills) === 1 && pdfBills[1].StartRead === S && pdfBills[1]._auto_corrected_StartRead,
    'extraction caller did not repair the PDF-key bill',
  );
  const pdfRev = base().map(ex).reverse();
  pdfRev[1].StartRead = shift(S, 900);
  ok(
    runPdf(pdfRev) === 1 && pdfRev[1].StartRead === S,
    'extraction caller: a PDF printed newest-first was not repaired',
  );
  const pdfDup = base().map(ex);
  pdfDup.splice(2, 0, { ...pdfDup[1] });
  const pdfDupSnap = JSON.stringify(pdfDup);
  ok(
    runPdf(pdfDup) === 0 && JSON.stringify(pdfDup) === pdfDupSnap,
    'extraction caller: a duplicate PDF bill was corrected',
  );
  const pdfOther = base().map(ex);
  pdfOther[1].StartRead = shift(S, 900);
  ok(
    ctx.correctExtractedReadChain(
      pdfOther,
      () => false,
      dayGap,
      (x) => parseFloat(x.kWhConsumed),
      () => false,
    ) === 0,
    'extraction caller: bills of different meters were linked',
  );
  ok(
    JSON.stringify(ctx.readCorrectionMarkers(pdfBills[1])).includes('_auto_corrected_startRead'),
    'readCorrectionMarkers does not map the PDF record to the stored key',
  );
}

/* ── 4. one definition, and the callers use it ── */
const flags = read('computations/bill-flags.js');
ok(
  (flags.match(/function computeReadCorrection\s*\(/g) || []).length === 1,
  'computeReadCorrection must be defined exactly once',
);
ok(
  /correctMeterReadChain\s*\(\s*mt\s*\)/.test(read('app/utility-data.js')),
  'loadUtilityData does not call correctMeterReadChain',
);
ok(
  /correctExtractedReadChain\s*\(/.test(read('app/bill-analysis.js')),
  'PDF extraction does not call correctExtractedReadChain',
);
ok(
  (read('app/bill-analysis.js').match(/readCorrectionMarkers\(/g) || []).length >= 5,
  'a saved-bill builder in app/bill-analysis.js does not keep the read correction record',
);
const ud = read('app/utility-data.js');
ok(/Corrected\. PDF reader value: /.test(ud), 'the Bills table does not give the corrected cell its hover text');
ok(
  !/billReadCorrectionBanner|read-corrected-mark|showReadCorrectionDetails/.test(ud) &&
    !/billReadCorrectionBanner/.test(read('energy-department.html')),
  'the Auto-corrected banner and its diamond mark must be gone (a corrected read changes no number)',
);
// the flag reason list scrolls inside a capped box
ok(
  /id="billFlagBanner"[^]*?<div class="bill-banner-list">/.test(ud),
  'the flag banner list is not wrapped in .bill-banner-list',
);
ok(
  /#billFlagBanner \.bill-banner-list\s*\{[^}]*max-height:\s*120px;[^}]*overflow-y:\s*auto/.test(read('energy-department.html')),
  'energy-department.html has no max-height/overflow rule for the flag banner list',
);
['app/csv-import.js', 'app/bill-corrections-review.js'].forEach((f) => {
  ok(/clearReadCorrectionRecords\(/.test(read(f)), f + ' edit path does not clear the read correction record');
});
ok(
  (read('app/csv-import.js').match(/clearReadCorrectionRecords\(/g) || []).length >= 3,
  'saveBillRow, submitValueCorrection and updateBillField must each clear the record',
);
ok(
  (read('app/bill-corrections-review.js').match(/clearReadCorrectionRecords\(/g) || []).length >= 2,
  'Review Bill Corrections apply (both stores) must clear the record',
);

if (problems.length) {
  console.log('FAIL gate-read-chain-correction:');
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('PASS gate-read-chain-correction');
