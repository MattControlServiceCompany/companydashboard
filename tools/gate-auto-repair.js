/**
 * gate-auto-repair.js
 *
 * Gate: the automatic repair of stored bills from their own PDF page (computations/bill-repair.js, run by
 * app/auto-repair.js). SYNTHETIC values only; it runs the real functions from the source files.
 *
 * Fails when:
 *   1. a second pass changes anything (same data, markers cleared and kept)
 *   2. a field the user corrected (_userCorrected) changes
 *   3. any value becomes blank (extracted fields blanked one at a time and in random sets)
 *   4. a printed read difference, kWh or read is replaced by a value inside the print rounding
 *   5. a bill of the meter gains a flag (the repair is kept only when no flag is added)
 *   6. a duplicate row is deleted, or a row that is not a duplicate (other page or other total) is reported as one, or
 *      a duplicate row that was not read gets a version marker
 *   7. a changed field has no record in the one automatic-correction store (_auto_corrected_<field>), or the record does
 *      not hold the old and the new value, or Edit Billing Period does not show it, or editing the field does not clear it,
 *      or a second history store (_autoRepairHistory) exists
 *   8. the new code holds a second copy of a rule: a field map, a date pattern, a therm conversion; or it does not call the
 *      shared extraction (extractBillsFromText), the shared mapper (_extractedToBillRowCosts, gasBillSaveTherms), the
 *      shared page-text cache (_bcrLoadPdfText) and the one utility-data accessor; or the queue does not call the shared
 *      extraction
 *   9. a page that holds one bill of ANOTHER meter number (same account) repairs this bill
 *  10. a PDF page with no row is added to the meter, or is reported when a meter number is missing on either side, when
 *      the period lies within 5 days of a stored one, or when a row of the PDF has no page number
 *  11. an extracted 0 replaces a stored value that is not 0
 *  12. a field the user owns by any marker (_userCorrected_<Field>, any spelling, _chg_ parts, a value retyped over an
 *      automatic record) changes; or the read-chain rule does not use the same predicate
 *  13. applyRepairChanges itself writes a blank, NaN, undefined or 0-over-value (direct call, through planMeterRepair,
 *      and a mutation run with the guard removed must FAIL)
 *  14. the browser pass (app/auto-repair.js, run here with stubs): writes to a utilityData object replaced during the
 *      read; marks a missing PDF with a version (never retried); does not cap a PDF that throws; reads again on a second
 *      pass; adds a row for a missing page instead of an audit entry; runs when the storage is not ready
 *  15. the browser pass sweeps every meter per PDF (flag summaries bounded by meters + a constant)
 *  16. (not in this gate) the run on the real backup: tools/ has no real data; the result is kept in the work notes
 *  17. the one write decision (repairMayWrite; Matt 2026-10-15: never fill a value that is not printed, held is better
 *      than guessed): a stored value that passes the bill's checks stays when the re-read differs (noise); a stored
 *      value the bill contradicts is replaced by the page value that passes (alone or as a pair); a value that is only
 *      on a neighbor page, or that the reader filled or changed (_auto_recovered_/_auto_corrected_), or a 0, is never
 *      written; every held value is reported with its reason (res.held, audit pdf_reread_held); the decision is one
 *      function on the one write path; a mutation run without the page test must FAIL
 *
 * Usage: node tools/gate-auto-repair.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').split(String.fromCharCode(13)).join('');
const sandbox = require(path.join(REPO, 'tools', 'bill-flags-sandbox.js'));
const { fnSource } = sandbox;
const problems = [];
const fail = (n, msg) => problems.push(n + ': ' + msg);

const ud = rd('app/utility-data.js');
const grab = (src, re) => {
  const m = re.exec(src);
  if (!m) throw new Error('source not found: ' + re);
  return m[0];
};
const repairSource = rd('computations/bill-repair.js');
function makeRepairContext(repairSrc) {
  const ctx = sandbox.makeContext();
  vm.runInContext(fnSource('computations/savings.js', 'gasBillSaveTherms'), ctx);
  vm.runInContext(fnSource('app/bill-analysis.js', '_acctFuzzyMatch'), ctx);
  vm.runInContext(fnSource('app/bill-analysis.js', '_extractedToBillRowCosts'), ctx);
  vm.runInContext(repairSrc, ctx);
  vm.runInContext(
    [
      "function _billSchemaFor(){ return [{key:'kwh',label:'kWh Consumed',type:'number',pdfKey:'kWhConsumed'},{key:'totalCost',label:'Total Cost',type:'currency',pdfKey:'TotalCurrentCharges'}]; }",
      grab(ud, /const _READ_CORRECTION_LABELS[^\n]*\n/),
      grab(ud, /function _readCorrectionRecords[\s\S]*?\n\}\n/),
      grab(ud, /function _billChangeHistory\([\s\S]*?\n\}\n/),
    ].join('\n'),
    ctx,
  );
  return ctx;
}
const ctx = makeRepairContext(repairSource);
const callIn = (c, name, ...args) => {
  c.__args = args;
  return vm.runInContext(name + '(...__args)', c);
};
const call = (name, ...args) => callIn(ctx, name, ...args);
const clone = (o) => JSON.parse(JSON.stringify(o));
const META = { at: '2026-01-01T00:00:00.000Z', version: 7 };

// ── synthetic fixtures ───────────────────────────────────────────────────────────────────────
const MONTHS = [
  ['2025-01-01', '2025-01-31'],
  ['2025-01-31', '2025-03-02'],
  ['2025-03-02', '2025-04-01'],
  ['2025-04-01', '2025-05-01'],
  ['2025-05-01', '2025-05-31'],
  ['2025-05-31', '2025-06-30'],
];
const f4 = (n) => n.toFixed(4);
const mdy = (iso) => iso.slice(5, 7) + '/' + iso.slice(8) + '/' + iso.slice(0, 4);
// Electric meter: reads 1000 + 100 per month, multiplier 160, so D = 100.0000 and kWh = 16000.0000.
function electricMeter() {
  const bills = MONTHS.map((p, i) => ({
    id: 'e' + i,
    start: p[0],
    end: p[1],
    commodity: 'Electric',
    accountNumber: 'ACCT-1',
    startRead: f4(1000 + 100 * i),
    endRead: f4(1100 + 100 * i),
    readDifference: f4(100),
    meterMultiplier: '160',
    kwh: '16000.0000',
    totalCost: '1600.00',
    kwCost: '0.00',
    kwhCost: '1600.00',
    otherCost: '0.00',
    taxCost: '0.00',
    pdfKey: 'k1',
    pdfPageStart: i + 1,
    pdfPageEnd: i + 1,
  }));
  return { id: 'm1', commodity: 'Electric', account: 'ACCT-1', meter: 'M-1', bills };
}
function electricExt(i, o) {
  return Object.assign(
    {
      Commodity: 'Electric',
      AccountNumber: 'ACCT-1',
      BillingPeriodStart: mdy(MONTHS[i][0]),
      BillingPeriodEnd: mdy(MONTHS[i][1]),
      StartRead: f4(1000 + 100 * i),
      EndRead: f4(1100 + 100 * i),
      ReadDifference: f4(100),
      MeterMultiplier: '160',
      kWhConsumed: '16000.0000',
      TotalCurrentCharges: '1600.00',
      _pageStart: i + 1,
      _pageEnd: i + 1,
    },
    o || {},
  );
}
const allExts = () => MONTHS.map((_, i) => electricExt(i));
const bldgOf = (m) => ({ id: 'b1', name: 'Synthetic Building', meters: [m] });
// Water meter with a usage that fails the rate check until the page value is read.
function waterMeter() {
  const bills = MONTHS.map((p, i) => ({
    id: 'w' + i,
    start: p[0],
    end: p[1],
    commodity: 'Water',
    accountNumber: 'ACCT-2',
    waterUsage: '10000',
    waterCharge: '50.00',
    totalCost: '50.00',
    pdfKey: 'k2',
    pdfPageStart: i + 1,
    pdfPageEnd: i + 1,
  }));
  return { id: 'm2', commodity: 'Water', account: 'ACCT-2', meter: '', bills };
}
function waterExt(i, o) {
  return Object.assign(
    {
      Commodity: 'Water',
      AccountNumber: 'ACCT-2',
      BillingPeriodStart: mdy(MONTHS[i][0]),
      BillingPeriodEnd: mdy(MONTHS[i][1]),
      WaterUsage: '10000',
      WaterCharge: '50.00',
      TotalCurrentCharges: '50.00',
      _pageStart: i + 1,
      _pageEnd: i + 1,
    },
    o || {},
  );
}
const waterExts = () => MONTHS.map((_, i) => waterExt(i));
// The page text the reader saw, built from the extracted bills: every value of a bill stands on its page, as a PDF
// prints it (dates as read, numbers with a thousands comma). An ext with _noPageText keeps its values off the page.
const pageTextOf = (exts) =>
  (exts || [])
    .map((e) => {
      const pg = e._pageStart != null ? e._pageStart : e._pageIndex;
      const vals = e._noPageText
        ? []
        : Object.keys(e)
            .filter((k) => k[0] !== '_' && e[k] !== null && e[k] !== undefined && e[k] !== '')
            .map((k) => (isFinite(Number(e[k])) && Math.abs(Number(e[k])) >= 1000 ? Number(e[k]).toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(e[k])));
      return '%%PAGE_' + pg + '%%\n' + vals.join('   ') + (e._pageText ? '\n' + e._pageText : '');
    })
    .join('\n');
const run = (m, pdfKey, exts, text) => call('repairMeterFromPdf', m, bldgOf(m), pdfKey, exts, META, text === undefined ? pageTextOf(exts) : text);
// A water bill the bill itself contradicts: the stored water charge is 500.00 while the total is 50.00 (charge parts
// vs total fails); the page prints 50.00.
const misreadWater = (w, i) => {
  w.bills[i].waterCharge = '500.00';
  return w;
};
const stable = (m) => {
  const c = clone(m);
  c.bills.forEach((b) => {
    delete b._pdfRepair;
  });
  return JSON.stringify(c);
};

// A misread electric bill: bill 2 has D 100.1 (reads say 100.0), kWh 16016 (D x 160). The fresh read has the page values.
function misreadMeter() {
  const m = electricMeter();
  m.bills[2].readDifference = '100.1000';
  m.bills[2].kwh = '16016.0000';
  return m;
}

// ── 0. sanity: the fixture repairs ──────────────────────────────────────────────────────────
{
  const m = misreadMeter();
  const r = run(m, 'k1', allExts());
  const row = m.bills[2];
  if (!(r.repaired.length === 1 && row.readDifference === '100.0000' && Math.abs(parseFloat(row.kwh) - 16000) < 0.001))
    fail('0', 'the fixture misread was not repaired: D=' + row.readDifference + ' kwh=' + row.kwh + ' result=' + JSON.stringify(r.declined));
}

// ── 1. idempotent ───────────────────────────────────────────────────────────────────────────
{
  const m = misreadMeter();
  run(m, 'k1', allExts());
  const after1 = stable(m);
  const r2 = run(m, 'k1', allExts()); // markers kept: nothing is eligible
  if (r2.read !== 0 || stable(m) !== after1) fail('1', 'a second pass with the marker changed or read something');
  m.bills.forEach((b) => delete b._pdfRepair);
  const r3 = run(m, 'k1', allExts()); // markers cleared: the reader runs again and must change nothing
  if (r3.repaired.length || r3.missing.length || stable(m) !== after1) fail('1', 'a second pass without the marker changed data');
  const w = waterMeter();
  w.bills[3].waterUsage = '900000';
  run(w, 'k2', waterExts());
  const wAfter = stable(w);
  w.bills.forEach((b) => delete b._pdfRepair);
  run(w, 'k2', waterExts());
  if (stable(w) !== wAfter) fail('1', 'a second water pass changed data');
}

// ── 2. user-corrected fields never change ───────────────────────────────────────────────────
{
  const m = misreadMeter();
  m.bills[2]._userCorrected = { readDifference: { original: '100.1', at: 'x' } };
  const before = m.bills[2].readDifference;
  run(m, 'k1', allExts());
  if (m.bills[2].readDifference !== before) fail('2', 'a user-corrected read difference was replaced');
  const control = misreadWater(waterMeter(), 3);
  run(control, 'k2', waterExts());
  if (control.bills[3].waterCharge === '500.00') fail('2', 'control: the charge was not repaired without the user mark, so this check proves nothing');
  const w = misreadWater(waterMeter(), 3);
  w.bills[3]._userCorrected = { waterCharge: { original: '50.00', at: 'x' } };
  run(w, 'k2', waterExts());
  if (w.bills[3].waterCharge !== '500.00') fail('2', 'a user-corrected charge was replaced');
  // a user-corrected start date
  const w2 = waterMeter();
  w2.bills[1].start = '2025-02-01';
  w2.bills[1]._userCorrected = { start: { original: '2025-01-31', at: 'x' } };
  run(w2, 'k2', waterExts());
  if (w2.bills[1].start !== '2025-02-01') fail('2', 'a user-corrected date was replaced');
}

// ── 3. never blank ──────────────────────────────────────────────────────────────────────────
{
  const keysE = ['StartRead', 'EndRead', 'ReadDifference', 'kWhConsumed', 'TotalCurrentCharges', 'BillingPeriodStart', 'BillingPeriodEnd'];
  const keysW = ['WaterUsage', 'WaterCharge', 'TotalCurrentCharges', 'BillingPeriodStart', 'BillingPeriodEnd'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const check = (before, after, label) => {
    before.bills.forEach((b, i) => {
      Object.keys(b).forEach((k) => {
        const was = b[k] !== undefined && b[k] !== null && String(b[k]).trim() !== '';
        const now = after.bills[i][k] !== undefined && after.bills[i][k] !== null && String(after.bills[i][k]).trim() !== '';
        if (was && !now) fail('3', label + ': ' + k + ' of bill ' + i + ' became blank');
      });
    });
  };
  // every extracted value blank: the stored bills stay exactly as they were
  {
    const m = misreadMeter();
    const before = stable(m);
    const exts = allExts();
    exts.forEach((e) => keysE.forEach((k) => (e[k] = '')));
    run(m, 'k1', exts);
    if (stable(m) !== before) fail('3', 'blank extracted values changed an electric bill');
    const w = misreadWater(waterMeter(), 2);
    const wb = stable(w);
    const wx = waterExts();
    wx.forEach((e) => keysW.forEach((k) => (e[k] = '')));
    run(w, 'k2', wx);
    if (stable(w) !== wb) fail('3', 'blank extracted values changed a water bill');
  }
  for (let t = 0; t < 120; t++) {
    const m = misreadMeter();
    const before = clone(m);
    const exts = allExts();
    exts.forEach((e) => keysE.forEach((k) => rnd() < 0.3 && (e[k] = rnd() < 0.5 ? '' : null)));
    run(m, 'k1', exts);
    check(before, m, 'electric run ' + t);
    const w = misreadWater(waterMeter(), 2);
    const wb = clone(w);
    const wx = waterExts();
    wx.forEach((e) => keysW.forEach((k) => rnd() < 0.3 && (e[k] = rnd() < 0.5 ? '' : null)));
    run(w, 'k2', wx);
    check(wb, w, 'water run ' + t);
  }
}

// ── 4. printed values inside the print rounding stay ───────────────────────────────────────
{
  const m = electricMeter();
  const exts = allExts();
  exts.forEach((e) => {
    e.StartRead = f4(parseFloat(e.StartRead) + 0.0001);
    e.EndRead = f4(parseFloat(e.EndRead) + 0.0001);
    e.ReadDifference = f4(parseFloat(e.ReadDifference) + 0.0001);
  });
  m.bills[2].startRead = f4(1200);
  m.bills[1].startRead = ''; // force eligibility: the bill before is blank-read, so bills 1..3 are read
  const snap = clone(m);
  run(m, 'k1', exts);
  ['readDifference', 'kwh'].forEach((k) => {
    m.bills.forEach((b, i) => {
      if (String(b[k]) !== String(snap.bills[i][k])) fail('4', k + ' of bill ' + i + ' was replaced by a value inside the print rounding');
    });
  });
  const m2 = electricMeter();
  m2.bills[1].startRead = '';
  const exts2 = allExts();
  exts2[2].ReadDifference = '100.0009';
  exts2[2].EndRead = '1300.0009';
  exts2[3].StartRead = '1300.0009';
  const s2 = clone(m2);
  run(m2, 'k1', exts2);
  if (m2.bills[2].readDifference !== s2.bills[2].readDifference) fail('4', 'a printed difference that the stored reads confirm was replaced');
  if (m2.bills[2].kwh !== s2.bills[2].kwh) fail('4', 'a printed kWh changed although its difference did not');
}

// ── 5. do no harm ───────────────────────────────────────────────────────────────────────────
{
  const flagsOf = (m) => {
    const s = call('computeMeterFlagSummary', m, bldgOf(m));
    const out = {};
    const guard = call('repairGuardRules', m);
    Object.keys(s.perBill || {}).forEach((id) => (out[id] = (s.perBill[id] || []).map((f) => f.rule).filter((r) => guard.includes(r))));
    return out;
  };
  const gained = (before, after) => {
    const g = [];
    Object.keys(after).forEach((id) => after[id].forEach((r) => !(before[id] || []).includes(r) && g.push(id + ':' + r)));
    return g;
  };
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let rejectedSeen = 0;
  for (let t = 0; t < 80; t++) {
    const w = waterMeter();
    w.bills.forEach((b) => {
      if (rnd() < 0.3) b.waterUsage = String(Math.round(10000 * (5 + 100 * rnd())));
    });
    const wx = waterExts();
    wx.forEach((e) => {
      if (rnd() < 0.35) e.BillingPeriodStart = '03/15/2025';
      if (rnd() < 0.35) e.TotalCurrentCharges = String(Math.round(rnd() * 9000) / 100 + 1);
      if (rnd() < 0.2) e.WaterUsage = String(Math.round(rnd() * 90000) + 10);
    });
    const before = flagsOf(w);
    const r = run(w, 'k2', wx);
    rejectedSeen += r.declined.filter((d) => /would add the flag/.test(d.reason)).length;
    const g = gained(before, flagsOf(w));
    if (g.length) fail('5', 'run ' + t + ' added flags: ' + g.join(', '));
    const e = misreadMeter();
    e.bills.forEach((b) => {
      if (rnd() < 0.3) b.readDifference = f4(100 + rnd());
    });
    const ex = allExts();
    ex.forEach((x) => {
      if (rnd() < 0.3) x.EndRead = f4(parseFloat(x.EndRead) + 5);
      if (rnd() < 0.3) x.BillingPeriodEnd = '12/31/2025';
    });
    const eb = flagsOf(e);
    run(e, 'k1', ex);
    const g2 = gained(eb, flagsOf(e));
    if (g2.length) fail('5', 'electric run ' + t + ' added flags: ' + g2.join(', '));
  }
  // a blank start date (the bill contradicts nothing else) filled from the page with a date that overlaps the bill
  // before: the write decision lets it through (dates_missing is cleared), the plan must reject it (period_overlap)
  const w = waterMeter();
  w.bills[2].start = '';
  const wx = waterExts();
  wx[2].BillingPeriodStart = '02/10/2025'; // would overlap the bill before
  const r5 = run(w, 'k2', wx);
  rejectedSeen += r5.declined.filter((d) => /would add the flag/.test(d.reason)).length;
  if (w.bills[2].start !== '') fail('5', 'a date that creates an overlap was kept: ' + w.bills[2].start);
  if (!rejectedSeen) fail('5', 'no repair was rejected by the flag check in any run: the check is not exercised');
}

// ── 6. duplicates are reported and kept; an unread duplicate gets no version ───────────────
{
  const w = waterMeter();
  const dup = clone(w.bills[3]);
  dup.id = 'wdup';
  dup.start = '2025-04-16'; // second row took another start date
  w.bills.push(dup);
  const other = clone(w.bills[4]);
  other.id = 'wother';
  other.totalCost = '99.00'; // same page, other total: not a duplicate
  other._userCorrected = { totalCost: { original: '50.00', at: 'x' } }; // so the repair keeps the other total
  w.bills.push(other);
  w.bills[1].waterUsage = '900000'; // make the meter eligible (bills 0 to 2 are read; w3 and wdup are not)
  const n = w.bills.length;
  const r = run(w, 'k2', waterExts());
  if (w.bills.length !== n) fail('6', 'a row was deleted or added: ' + n + ' -> ' + w.bills.length);
  const ids = r.duplicates.map((g) => g.map((b) => b.id).sort().join('+'));
  if (!ids.includes('w3+wdup')) fail('6', 'the duplicate pair was not reported: ' + JSON.stringify(ids));
  if (ids.some((x) => /wother/.test(x))) fail('6', 'a row with another total was reported as a duplicate');
  const again = call('findDuplicateRowGroups', w);
  if (again.length !== 1) fail('6', 'expected one duplicate group, found ' + again.length);
  // a duplicate pair that this run does not read (estimated rows are never read) gets the dup mark only, no version:
  // when it later needs a repair it is still eligible
  const u = waterMeter();
  const udup = clone(u.bills[3]);
  udup.id = 'udup';
  u.bills[3].estimated = true;
  udup.estimated = true;
  u.bills.push(udup);
  u.bills[1].waterUsage = ''; // bills 0 to 2 are read (usage missing); w3 and udup are not
  const ru = run(u, 'k2', waterExts());
  if (!ru.duplicates.some((g) => g.map((b) => b.id).sort().join('+') === 'udup+w3')) fail('6', 'the unread duplicate pair was not reported');
  ['w3', 'udup'].forEach((id) => {
    const b = u.bills.find((x) => x.id === id);
    if (!b._pdfRepair || !b._pdfRepair.dup) fail('6', id + ' is not marked dup');
    else if (b._pdfRepair.v !== undefined) fail('6', id + ' was not read in this run but got the version marker ' + JSON.stringify(b._pdfRepair));
  });
  u.bills.forEach((b) => delete b.estimated);
  u.bills[3].waterUsage = '';
  if (!call('repairEligibleBills', u, bldgOf(u), META.version).some((x) => x.row.id === 'w3')) fail('6', 'an unread duplicate row is no longer eligible');
  const orchestrator = rd('app/auto-repair.js');
  if (!/pdf_duplicate_rows/.test(orchestrator)) fail('6', 'the duplicate is not written to the audit log');
  if (/\.splice\(|bills\s*=\s*[^=]*\.filter\(|bills\.push\(/.test(orchestrator + repairSource)) fail('6', 'the repair code removes rows from, or adds rows to, a bills list');
}

// ── 7. one history: the automatic-correction record ────────────────────────────────────────
{
  const m = misreadMeter();
  m.bills[4].kwh = '1';
  const before = clone(m);
  run(m, 'k1', allExts());
  let changedFields = 0;
  m.bills.forEach((b, i) => {
    const o = before.bills[i];
    Object.keys(b).forEach((k) => {
      if (k === '_pdfRepair' || k.indexOf('_auto_corrected_') === 0) return;
      if (String(b[k]) === String(o[k])) return;
      changedFields++;
      const h = b['_auto_corrected_' + k];
      if (!h) fail('7', 'bill ' + i + ' field ' + k + ' changed with no _auto_corrected_ record');
      else {
        if (String(h.original) !== String(o[k] === undefined ? '' : o[k])) fail('7', 'record original wrong for ' + k + ': ' + h.original);
        if (String(h.corrected) !== String(b[k])) fail('7', 'record corrected wrong for ' + k);
        if (!h.at || h.ruleVersion !== META.version || h.source !== 'pdf_reread') fail('7', 'record has no time, rule version or source for ' + k);
      }
    });
  });
  if (!changedFields) fail('7', 'the fixture changed nothing: the check is not exercised');
  const row = m.bills[2];
  const shown = call('_billChangeHistory', row, 'Electric');
  if (!shown.some((h) => /Re-read from the PDF/.test(h.note) && String(h.corrected) === String(row.readDifference) && h.label === 'Read Difference'))
    fail('7', 'Edit Billing Period history does not show the re-read: ' + JSON.stringify(shown));
  const edited = clone(row);
  edited.readDifference = '55.0000';
  if (call('_billChangeHistory', edited, 'Electric').some((h) => /Re-read from the PDF/.test(h.note) && h.label === 'Read Difference'))
    fail('7', 'an edited value still shows the old repair');
  call('clearReadCorrectionRecords', row, ['readDifference']);
  if (row._auto_corrected_readDifference) fail('7', 'editing the field did not clear its record');
  if (!row._auto_corrected_kwh) fail('7', 'editing one field cleared the record of another');
  const srcAll = ['app', 'computations', 'lib']
    .map((d) => fs.readdirSync(path.join(REPO, d)).filter((f) => /\.js$/.test(f)).map((f) => d + '/' + f))
    .reduce((a, b) => a.concat(b), [])
    .map((f) => f + '\n' + rd(f))
    .join('\n');
  if (/_autoRepairHistory|clearAutoRepairHistory/.test(srcAll)) fail('7', 'a second history store (_autoRepairHistory) still exists in app/, computations/ or lib/');
  if (!/PDF_REREAD_SOURCE/.test(grab(rd('computations/bill-flags.js'), /function clearReadCorrectionRecords[\s\S]*?\n\}\n/)))
    fail('7', 'clearReadCorrectionRecords (every edit path) does not drop the re-read record');
}

// ── 8. one copy of every rule, one accessor ─────────────────────────────────────────────────
{
  const code = (f) =>
    rd(f)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  const files = ['app/auto-repair.js', 'computations/bill-repair.js'];
  files.forEach((f) => {
    const src = code(f);
    if (/FIELD_MAP/.test(src)) fail('8', f + ' holds a FIELD_MAP');
    if (/\\d\{?[0-9,]*\}?\s*[\\/-]\s*\\d/.test(src) || /\[\\\/-\]/.test(src)) fail('8', f + ' holds a date pattern');
    if (/thermFactor|1\.037|100000|\/\s*10\b|\*\s*10\b|MMbtu\s*\*|UNIT_TO_BASE/.test(src)) fail('8', f + ' holds a therm conversion');
  });
  const rep = code('computations/bill-repair.js');
  const orch = code('app/auto-repair.js');
  if (!/_extractedToBillRowCosts\(/.test(rep) || !/gasBillSaveTherms\(/.test(rep)) fail('8', 'the repair does not use the shared mapper');
  if (!/billFieldUserOwned\(/.test(rep)) fail('8', 'the repair does not use the shared user-owned predicate');
  if (!/extractBillsFromText\(/.test(orch)) fail('8', 'the repair pass does not use the shared extraction');
  if (!/_bcrLoadPdfText\(/.test(orch)) fail('8', 'the repair pass does not use the shared page-text cache');
  if (/sset\(|localStorage|indexedDB/.test(orch)) fail('8', 'the repair pass writes storage itself instead of the shared cache');
  if (!/DB\.isReady\(\)/.test(orch)) fail('8', 'the repair pass does not wait for the IndexedDB-backed store');
  if (!/correctMeterReadChain\(/.test(orch)) fail('8', 'the repair pass does not run the existing read-chain rule');
  if (/Promise\.all|Promise\.allSettled/.test(orch)) fail('8', 'the repair pass reads PDFs in parallel');
  if (!/requestIdleCallback/.test(orch)) fail('8', 'the repair pass does not wait for an idle browser');
  if (/\butilityData\s*\[/.test(orch)) fail('8', 'the repair pass indexes utilityData instead of the accessor');
  if (!/getCustomerBuildings\(/.test(orch)) fail('8', 'the repair pass does not use getCustomerBuildings');
  const ba = rd('app/bill-analysis.js');
  const count = (re) => (ba.match(re) || []).length;
  if (count(/\nasync function extractBillsFromText\(/g) !== 1) fail('8', 'extractBillsFromText is not defined exactly once');
  const queue = /async function _extractSingleFileForQueue[\s\S]*?\n\}\n/.exec(ba);
  if (!queue || !/extractBillsFromPdfBytes\(/.test(queue[0]) || /_pickFileRule\(/.test(queue[0]))
    fail('8', 'the upload queue does not use the shared extraction');
  if (!/matchExtractedToBill\(/.test(/async function _checkDuplicates[\s\S]*?\nasync function|async function _checkDuplicates[\s\S]*$/.exec(ba)[0]))
    fail('8', '_checkDuplicates does not use matchExtractedToBill');
  if (!/EXTRACTOR_RULES_VERSION\s*=/.test(rd('app/energy-savings.js'))) fail('8', 'EXTRACTOR_RULES_VERSION is not defined');
  if (!/scheduleAutoRepair\(\)/.test(ud)) fail('8', 'loadUtilityData does not schedule the repair pass');
  const html = rd('energy-department.html');
  if (!/computations\/bill-repair\.js/.test(html) || !/app\/auto-repair\.js/.test(html)) fail('8', 'energy-department.html does not load the repair files');
}

// ── 9. a page of another meter number never repairs this bill ──────────────────────────────
{
  // Meter M-1, bill 2 (page 3) is misread. Page 3 holds ONE bill, of meter M-2 on the same account, with other reads.
  const other = (i) => electricExt(i, { MeterNumber: 'M-2', StartRead: f4(5000), EndRead: f4(5100), ReadDifference: f4(100), BillingPeriodStart: '03/03/2025' });
  const m = misreadMeter();
  const exts = allExts();
  exts[2] = other(2);
  const snap = clone(m.bills[2]);
  const r = run(m, 'k1', exts);
  const b = m.bills[2];
  if (b.startRead !== snap.startRead || b.start !== snap.start || b.readDifference !== snap.readDifference)
    fail('9', "another meter's page was written onto this bill: " + JSON.stringify(b));
  const d = r.declined.find((x) => x.row.id === 'e2');
  if (!d || !/another meter number/.test(d.reason)) fail('9', 'the other-meter page was not declined with its reason: ' + JSON.stringify(r.declined.map((x) => x.reason)));
  // control: the same page with this meter's number repairs
  const c = misreadMeter();
  const cx = allExts();
  cx[2].MeterNumber = 'M-1';
  run(c, 'k1', cx);
  if (c.bills[2].readDifference !== '100.0000') fail('9', 'control: the page with the same meter number did not repair');
  // one side without a number: no comparison (the page is used)
  const n = misreadMeter();
  n.meter = '';
  const nx = allExts();
  nx[2].MeterNumber = 'M-9';
  run(n, 'k1', nx);
  if (n.bills[2].readDifference !== '100.0000') fail('9', 'a meter without a stored number did not use its page');
  // the direct test: one candidate, meter numbers differ
  const one = call('findRepairMatch', [other(2)], misreadMeter().bills[2], misreadMeter());
  if (!one.declined) fail('9', 'findRepairMatch accepted the one candidate of another meter number');
}

// ── 10. a missing page is reported, never added ────────────────────────────────────────────
{
  const base = () => {
    const w = waterMeter();
    w.meter = 'W-1';
    w.bills[1].waterUsage = '900000';
    return w;
  };
  const extra = (o) => waterExt(0, Object.assign({ MeterNumber: 'W-1', BillingPeriodStart: '07/01/2025', BillingPeriodEnd: '07/31/2025', _pageStart: 9, _pageEnd: 9 }, o || {}));
  const exts = () => waterExts().map((e) => Object.assign(e, { MeterNumber: 'W-1' }));
  {
    const w = base();
    const n = w.bills.length;
    const r = run(w, 'k2', exts().concat([extra()]));
    if (w.bills.length !== n) fail('10', 'a missing page was added to the meter: ' + n + ' -> ' + w.bills.length);
    if (!Array.isArray(r.missing) || r.missing.length !== 1 || r.missing[0].page !== 9 || r.missing[0].start !== '2025-07-01')
      fail('10', 'the missing page was not reported: ' + JSON.stringify(r.missing));
  }
  const none = (label, w, ex) => {
    const n = w.bills.length;
    const r = run(w, 'k2', ex);
    if (w.bills.length !== n || (r.missing && r.missing.length)) fail('10', label + ': a page was reported or added: ' + JSON.stringify(r.missing));
  };
  none('page without a meter number', base(), exts().concat([extra({ MeterNumber: '' })]));
  {
    const w = base();
    w.meter = '';
    none('meter without a number', w, exts().concat([extra()]));
  }
  none('page of another meter number', base(), exts().concat([extra({ MeterNumber: 'W-2' })]));
  none('period within 5 days of a stored bill', base(), exts().concat([extra({ BillingPeriodStart: '04/03/2025', BillingPeriodEnd: '05/03/2025' })]));
  {
    const w = base();
    delete w.bills[5].pdfPageStart; // a row of this PDF without a page number: the stored pages are unknown
    none('a row with pdfKey and no page number', w, exts().concat([extra()]));
  }
  none('page the reader holds', base(), exts().concat([extra({ _manualReview: true })]));
  if (!/pdf_bill_missing/.test(rd('app/auto-repair.js'))) fail('10', 'the missing page is not written to the audit log');
}

// ── 11. an extracted 0 never replaces a stored value ───────────────────────────────────────
{
  // the stored total 1234.56 fails the sum check (charge 50.00); the re-read gives 0: never written
  const w = waterMeter();
  w.bills[3].totalCost = '1234.56';
  const wx = waterExts();
  wx[3].TotalCurrentCharges = '0.00';
  wx[3].WaterCharge = '0';
  const f = call('repairFieldsFromExtracted', wx[3], w.bills[3], 'Water', w, bldgOf(w), pageTextOf(wx)).changes;
  if (f.totalCost || f.waterCharge) fail('11', 'repairFieldsFromExtracted offered 0 over a stored value: ' + JSON.stringify(f));
  run(w, 'k2', wx);
  if (w.bills[3].totalCost !== '1234.56' || w.bills[3].waterCharge !== '50.00') fail('11', 'an extracted 0 replaced a stored value: ' + JSON.stringify(w.bills[3]));
  // control: the same bill with the page total 50.00 is repaired
  const c = waterMeter();
  c.bills[3].totalCost = '1234.56';
  run(c, 'k2', waterExts());
  if (c.bills[3].totalCost !== 50) fail('11', 'control: the total on the same bill was not repaired: ' + c.bills[3].totalCost);
  // a value may replace a stored 0 the bill contradicts (total 0, charge 50.00); a 0 never fills a blank, and never
  // replaces the charge (a 0 cannot be tied to a field on the page)
  const z = waterMeter();
  z.bills[3].totalCost = '0';
  const zx = waterExts();
  zx[3].WaterCharge = '0';
  const fz = call('repairFieldsFromExtracted', zx[3], z.bills[3], 'Water', z, bldgOf(z), pageTextOf(zx)).changes;
  if (fz.waterCharge) fail('11', 'a 0 replaced the charge: ' + JSON.stringify(fz));
  if (!fz.totalCost || fz.totalCost.to !== 50) fail('11', 'a value did not replace a stored 0: ' + JSON.stringify(fz));
  const zb = waterMeter();
  zb.bills[3].waterCharge = '';
  const zbx = waterExts();
  zbx[3].WaterCharge = '0';
  const fzb = call('repairFieldsFromExtracted', zbx[3], zb.bills[3], 'Water', zb, bldgOf(zb), pageTextOf(zbx)).changes;
  if (fzb.waterCharge) fail('11', 'a 0 filled a blank charge: ' + JSON.stringify(fzb));
  if (call('repairValueAllowed', '12.00', '0.00') || call('repairValueAllowed', 5, 0) || !call('repairValueAllowed', '0', 3) || !call('repairValueAllowed', '', 0))
    fail('11', 'repairValueAllowed does not apply the zero rule');
}

// ── 12. every user-owned marker protects the field ─────────────────────────────────────────
{
  const owned = (label, mark) => {
    const w = misreadWater(waterMeter(), 3);
    mark(w.bills[3]);
    run(w, 'k2', waterExts());
    if (w.bills[3].waterCharge !== '500.00') fail('12', label + ': a user-owned charge was replaced');
    if (!call('billFieldUserOwned', w.bills[3], 'waterCharge')) fail('12', label + ': billFieldUserOwned is false');
  };
  owned('_userCorrected_<Field> in the PDF spelling', (b) => (b._userCorrected_WaterCharge = { original: '1', corrected: '500.00', ts: 1 }));
  owned('_userCorrected_<field> in the stored spelling', (b) => (b._userCorrected_waterCharge = { original: '1', corrected: '500.00', ts: 1 }));
  owned('_userCorrected_<FIELD> in any spelling', (b) => (b._userCorrected_WATERCHARGE = { original: '1', corrected: '500.00', ts: 1 }));
  owned('_userCorrected__chg_<field>_<i> part marker', (b) => (b._userCorrected__chg_waterCharge_0 = { original: '1', corrected: '500.00', ts: 1 }));
  owned('a derived stamp without original/corrected', (b) => (b._userCorrected_waterCharge = { derivedFrom: 'x', value: '500.00', ts: 1 }));
  owned('a value retyped over a re-read record', (b) => (b._auto_corrected_waterCharge = { original: '1', corrected: '20.00', source: 'pdf_reread', reason: 'Re-read from the PDF' }));
  owned('a value retyped over a read-chain record', (b) => (b._auto_corrected_waterCharge = { original: '1', corrected: '20.00', reason: vm.runInContext('READ_CHAIN_REASON.a', ctx) }));
  // the schema maps the stored name to the PDF name: kwh <-> kWhConsumed (the stub schema), totalCost <-> TotalCurrentCharges
  if (!call('billFieldUserOwned', { kwh: '5', _userCorrected_kWhConsumed: { original: '1', corrected: '5', ts: 1 } }, 'kwh')) fail('12', 'a PDF-name stamp from the schema is not honored');
  if (call('billFieldUserOwned', { kwh: '5', _userCorrected_TotalCurrentCharges: { original: '1', corrected: '5', ts: 1 } }, 'kwh')) fail('12', 'a stamp of another field counts as this field');
  // a record whose value still stands is not a user edit (control)
  if (call('billFieldUserOwned', { waterUsage: '20000', _auto_corrected_waterUsage: { original: '1', corrected: '20000', source: 'pdf_reread' } }, 'waterUsage'))
    fail('12', 'control: a standing re-read record counts as a user edit');
  if (!/billFieldUserOwned\(/.test(grab(rd('computations/bill-flags.js'), /function _rcUserEdited[\s\S]*?\n\}\n/))) fail('12', 'the read-chain rule does not use the shared predicate');
}

// ── 13. applyRepairChanges itself never writes a blank, NaN, undefined or 0 over a value ───
{
  const bad = [
    ['', 'blank'],
    [null, 'null'],
    [undefined, 'undefined'],
    [NaN, 'NaN'],
    [0, '0 over 5'],
    ['0.00', '"0.00" over 5'],
  ];
  const direct = (c, label) => {
    bad.forEach((p) => {
      const row = { id: 'x', k: '5', pdfPageStart: 1 };
      const w = callIn(c, 'applyRepairChanges', row, { k: { from: '5', to: p[0] } }, META);
      if (row.k !== '5' || row._auto_corrected_k || (w && w.length)) fail(label, 'applyRepairChanges wrote ' + p[1] + ': ' + JSON.stringify(row));
    });
  };
  direct(ctx, '13');
  // through the plan: the trial applies only what the write applies
  bad.forEach((p) => {
    const w = waterMeter();
    const row = w.bills[3];
    const plan = call('planMeterRepair', w, bldgOf(w), [{ row, changes: { waterUsage: { from: row.waterUsage, to: p[0] } } }]);
    plan.accepted.forEach((it) => call('applyRepairChanges', it.row, it.changes, META));
    if (row.waterUsage !== '10000') fail('13', 'the plan let ' + p[1] + ' through: ' + row.waterUsage);
  });
  // mutation run: the guard removed from applyRepairChanges must make the direct case FAIL
  const guard = /\n(\s*)if \(!repairValueAllowed\(row\[k\], to\)\) return;\n/;
  if (!guard.test(repairSource)) fail('13', 'the guard line in applyRepairChanges was not found (the mutation run cannot prove the gate)');
  else {
    const mutated = repairSource.replace(guard, '\n');
    const before = problems.length;
    direct(makeRepairContext(mutated), '13-mutation');
    const caught = problems.length - before;
    problems.length = before;
    if (!caught) fail('13', 'the direct blank case passes with the guard removed: the check does not catch the guard');
  }
}

// ── 14. the browser pass with stubs ────────────────────────────────────────────────────────
function makeOrchestrator(opts) {
  const c = makeRepairContext(repairSource);
  c.setTimeout = setTimeout;
  c.window = { requestIdleCallback: null };
  c.DB = { isReady: () => opts.ready !== false };
  c.projects = [];
  c._resolveCustomerId = (x) => x;
  c.EXTRACTOR_RULES_VERSION = META.version;
  c.audit = [];
  c.saves = [];
  c.loads = [];
  c.logUtilityAudit = (e) => c.audit.push(e);
  c.saveUtilityData = (cid) => c.saves.push(cid);
  c.showToast = () => {};
  c.console = { log() {}, warn() {}, error() {} };
  c.utilityData = opts.data;
  vm.runInContext(grab(ud, /function getCustomerBuildings[\s\S]*?\n\}\n/), c);
  c._bcrLoadPdfText = async (k) => {
    c.loads.push(k);
    if (opts.onLoad) opts.onLoad(c, k);
    if (opts.throwOn && opts.throwOn(k)) throw new Error('synthetic read error');
    return opts.text && opts.text[k] !== undefined ? opts.text[k] : 'text:' + k + '\n' + pageTextOf(opts.exts[k] || []);
  };
  c.extractBillsFromText = async (text) => ({ bills: opts.exts[text.split('\n')[0].replace(/^text:/, '')] || [] });
  vm.runInContext(rd('app/auto-repair.js'), c);
  return c;
}
const dataOf = (meters) => ({ c1: { buildings: [{ id: 'b1', name: 'Synthetic Building', meters }] } });
async function check14() {
  // a. the write goes to the objects that are live after the await, never to the replaced ones
  {
    const old = misreadMeter();
    const c = makeOrchestrator({
      data: dataOf([old]),
      exts: { k1: allExts() },
      onLoad: (cx) => {
        cx.utilityData.c1 = JSON.parse(JSON.stringify(cx.utilityData.c1)); // a reload during the read
      },
    });
    await callIn(c, 'runAutoRepair');
    const fresh = c.utilityData.c1.buildings[0].meters[0].bills[2];
    if (fresh.readDifference !== '100.0000' || !fresh._pdfRepair || fresh._pdfRepair.status !== 'repaired')
      fail('14a', 'the repair did not reach the live object after the read: ' + JSON.stringify(fresh._pdfRepair));
    if (old.bills[2].readDifference !== '100.1000' || old.bills[2]._pdfRepair) fail('14a', 'the repair was written to the replaced object');
    if (!c.saves.includes('c1')) fail('14a', 'the customer was not saved');
  }
  // b. a missing PDF: no version, read again on a later load, one read per run
  {
    const m = misreadMeter();
    const c = makeOrchestrator({ data: dataOf([m]), exts: {}, text: { k1: null } });
    await callIn(c, 'runAutoRepair');
    const b = m.bills[2];
    if (!b._pdfRepair || b._pdfRepair.status !== 'waiting' || b._pdfRepair.v !== undefined) fail('14b', 'a missing PDF was marked with a version: ' + JSON.stringify(b._pdfRepair));
    if (c.loads.length !== 1) fail('14b', 'the missing PDF was tried ' + c.loads.length + ' times in one run');
    if (!callIn(c, 'repairEligibleBills', m, c.utilityData.c1.buildings[0], META.version).length) fail('14b', 'the bill is no longer eligible after a missing PDF');
    if (!(c.window._autoRepairStats && c.window._autoRepairStats.waiting === 1)) fail('14b', 'stats.waiting wrong: ' + JSON.stringify(c.window._autoRepairStats));
    await callIn(c, 'runAutoRepair'); // a later load, the PDF still missing: tried once more, marker unchanged
    if (c.loads.length !== 2 || b._pdfRepair.v !== undefined) fail('14b', 'the second load did not retry once: ' + c.loads.length);
  }
  // c. a PDF that throws: tries counted on the bill, declined for this version after AUTO_REPAIR_MAX_TRIES
  {
    const m = misreadMeter();
    const c = makeOrchestrator({ data: dataOf([m]), exts: {}, throwOn: () => true });
    const b = m.bills[2];
    await callIn(c, 'runAutoRepair');
    if (!b._pdfRepair || b._pdfRepair.status !== 'error' || b._pdfRepair.tries !== 1 || b._pdfRepair.v !== undefined) fail('14c', 'first error not counted: ' + JSON.stringify(b._pdfRepair));
    await callIn(c, 'runAutoRepair');
    if (!b._pdfRepair || b._pdfRepair.tries !== 2) fail('14c', 'second error not counted: ' + JSON.stringify(b._pdfRepair));
    await callIn(c, 'runAutoRepair');
    if (!b._pdfRepair || b._pdfRepair.status !== 'declined' || b._pdfRepair.v !== META.version || !/3 tries/.test(b._pdfRepair.reason))
      fail('14c', 'not declined after the cap: ' + JSON.stringify(b._pdfRepair));
    const n = c.loads.length;
    await callIn(c, 'runAutoRepair');
    if (c.loads.length !== n) fail('14c', 'a declined PDF was read again');
    if (b.readDifference !== '100.1000') fail('14c', 'an error changed a value');
  }
  // d. a second pass after every row has a marker reads nothing
  {
    const m = misreadMeter();
    const c = makeOrchestrator({ data: dataOf([m]), exts: { k1: allExts() } });
    await callIn(c, 'runAutoRepair');
    const n = c.loads.length;
    await callIn(c, 'runAutoRepair');
    if (c.loads.length !== n || c.window._autoRepairStats.read !== 0) fail('14d', 'a second pass read a PDF again');
  }
  // e. a missing page: audit entry, no row
  {
    const w = waterMeter();
    w.meter = 'W-1';
    w.bills[1].waterUsage = '900000';
    const ex = waterExts().map((e) => Object.assign(e, { MeterNumber: 'W-1' }));
    ex.push(waterExt(0, { MeterNumber: 'W-1', BillingPeriodStart: '07/01/2025', BillingPeriodEnd: '07/31/2025', _pageStart: 9, _pageEnd: 9 }));
    const c = makeOrchestrator({ data: dataOf([w]), exts: { k2: ex } });
    const n = w.bills.length;
    await callIn(c, 'runAutoRepair');
    if (w.bills.length !== n) fail('14e', 'the browser pass added a row');
    const a = c.audit.find((x) => x.action === 'pdf_bill_missing');
    if (!a || !/page 9|Page 9/.test(a.note) || !a.changes || a.changes[0].start !== '2025-07-01') fail('14e', 'no audit entry for the missing page: ' + JSON.stringify(c.audit));
  }
  // g. a held value (the stored usage passes every check; the re-read differs) goes to the audit log with its reason
  {
    const w = misreadWater(waterMeter(), 1);
    const ex = waterExts();
    ex[1].WaterUsage = '10006';
    const c = makeOrchestrator({ data: dataOf([w]), exts: { k2: ex } });
    await callIn(c, 'runAutoRepair');
    if (w.bills[1].waterUsage !== '10000') fail('14g', 'the browser pass wrote a value the bill does not contradict: ' + w.bills[1].waterUsage);
    const h = c.audit.find((x) => x.action === 'pdf_reread_held');
    if (!h || !h.changes || h.changes[0].field !== 'waterUsage' || String(h.changes[0].read) !== '10006' || !/passes every check/.test(h.changes[0].reason))
      fail('14g', 'no audit entry for the held value: ' + JSON.stringify(c.audit.map((x) => x.action)));
    if (!(c.window._autoRepairStats && c.window._autoRepairStats.held === 1)) fail('14g', 'stats.held wrong: ' + JSON.stringify(c.window._autoRepairStats));
  }
  // f. storage not ready: nothing runs
  {
    const m = misreadMeter();
    const c = makeOrchestrator({ data: dataOf([m]), exts: { k1: allExts() }, ready: false });
    await callIn(c, 'runAutoRepair');
    if (c.loads.length || m.bills[2]._pdfRepair) fail('14f', 'the pass ran while the storage was not ready');
  }
  // 15. no sweep of every meter per PDF: 40 meters, one eligible: summaries bounded by meters + a constant
  {
    const meters = [misreadMeter()];
    for (let i = 1; i < 40; i++) {
      const w = waterMeter();
      w.id = 'w' + i;
      w.bills.forEach((b) => (b.pdfKey = 'kx' + i));
      meters.push(w);
    }
    const c = makeOrchestrator({ data: dataOf(meters), exts: { k1: allExts() } });
    vm.runInContext('var __n = 0; const __orig = computeMeterFlagSummary; computeMeterFlagSummary = function () { __n++; return __orig.apply(this, arguments); };', c);
    await callIn(c, 'runAutoRepair');
    const n = vm.runInContext('__n', c);
    if (n > 40 + 15) fail('15', 'the pass ran ' + n + ' flag summaries for 40 meters and one PDF (sweeps every meter per PDF)');
    if (c.utilityData.c1.buildings[0].meters[0].bills[2].readDifference !== '100.0000') fail('15', 'the bounded pass did not repair');
  }
}

// ── 17. the one write decision ─────────────────────────────────────────────────────────────
function check17(c, label) {
  const runIn = (m, pdfKey, exts, text) => callIn(c, 'repairMeterFromPdf', m, bldgOf(m), pdfKey, exts, META, text === undefined ? pageTextOf(exts) : text);
  const heldReason = (r, id, k) => {
    const h = r.held.find((x) => x.row.id === id);
    return h && h.fields[k] ? h.fields[k].reason : '';
  };
  // a. stored value correct, re-read noisy: unchanged, the reason recorded
  {
    const w = misreadWater(waterMeter(), 1); // bill 1 is eligible; bills 0 and 2 are its neighbors
    const ex = waterExts();
    ex[2].WaterUsage = '10006'; // OCR noise on a usage the bill does not contradict
    ex[0].WaterCharge = '53.00'; // noise on a charge: 53 + 0 != 50, the fresh value fails the sum check
    const r = runIn(w, 'k2', ex);
    if (w.bills[2].waterUsage !== '10000') fail(label, 'a usage the bill does not contradict was replaced by the re-read: ' + w.bills[2].waterUsage);
    if (!/passes every check/.test(heldReason(r, 'w2', 'waterUsage'))) fail(label, 'the held usage has no reason: ' + JSON.stringify(r.held.map((h) => h.fields)));
    if (w.bills[0].waterCharge !== '50.00') fail(label, 'a charge the bill does not contradict was replaced: ' + w.bills[0].waterCharge);
    if (w.bills[1].waterCharge !== 50) fail(label, 'control: the contradicted charge was not repaired: ' + w.bills[1].waterCharge);
    const e = electricMeter();
    e.bills[1].startRead = ''; // bills 0..2 are read
    const ex2 = allExts();
    ex2[2].StartRead = f4(1200.2);
    ex2[2].EndRead = f4(1300.2); // consistent with each other, but the stored reads already prove the bill
    const r2 = runIn(e, 'k1', ex2);
    if (e.bills[2].startRead !== f4(1200) || e.bills[2].endRead !== f4(1300)) fail(label, 'consistent stored reads were replaced by a re-read: ' + JSON.stringify(e.bills[2]));
    if (!/passes every check/.test(heldReason(r2, 'e2', 'startRead'))) fail(label, 'the held read has no reason');
    if (e.bills[1].startRead !== f4(1100)) fail(label, 'control: the blank read was not filled from the page: ' + e.bills[1].startRead);
  }
  // b. the bill contradicts the stored value, the re-read fixes it: replaced (alone, and as a pair)
  {
    const m = misreadMeter();
    runIn(m, 'k1', allExts());
    if (m.bills[2].readDifference !== '100.0000' || Math.abs(parseFloat(m.bills[2].kwh) - 16000) > 0.001) fail(label, 'a contradicted read difference and kWh were not repaired as a pair: ' + JSON.stringify(m.bills[2]));
    const w = waterMeter();
    w.bills[2].waterCharge = '45.00';
    w.bills[2].totalCost = '55.00'; // 45 != 55: both wrong, each alone still fails, together they pass
    runIn(w, 'k2', waterExts());
    if (w.bills[2].waterCharge !== 50 || w.bills[2].totalCost !== 50) fail(label, 'a charge and total that prove each other were not repaired as a pair: ' + JSON.stringify(w.bills[2]));
    const s = waterMeter();
    s.bills[2].totalCost = '550.00'; // only the total is wrong
    runIn(s, 'k2', waterExts());
    if (s.bills[2].totalCost !== 50) fail(label, 'a contradicted total was not repaired alone: ' + s.bills[2].totalCost);
  }
  // c. a value that is only on a neighbor page is declined, with the reason
  {
    const e = electricMeter();
    e.bills[1].startRead = '';
    const ex = allExts();
    ex[1]._noPageText = true; // page 2 prints nothing the reader can point at: its StartRead came from elsewhere
    ex[0]._pageText = '1,100.0000'; // the value stands on page 1 only
    const r = runIn(e, 'k1', ex);
    if (e.bills[1].startRead !== '') fail(label, 'a value printed only on a neighbor page was written: ' + e.bills[1].startRead);
    if (!/not printed/.test(heldReason(r, 'e1', 'startRead'))) fail(label, 'the neighbor-page value has no reason: ' + JSON.stringify(r.held.map((h) => h.fields)));
    const e2 = electricMeter();
    e2.bills[1].startRead = '';
    const ex2 = allExts();
    ex2[1]._auto_recovered_StartRead = { original: null, corrected: '1100.0000', reason: "Copied from previous bill's EndRead" };
    const r2 = runIn(e2, 'k1', ex2);
    if (e2.bills[1].startRead !== '') fail(label, 'a read the reader copied from the neighbor bill was written: ' + e2.bills[1].startRead);
    if (!/filled or changed StartRead/.test(heldReason(r2, 'e1', 'startRead'))) fail(label, 'the copied read has no reason');
  }
  // d. a derived value is never written: a computed read, a corrected charge, a 0, a converted usage
  {
    const e = electricMeter();
    e.bills[2].endRead = '';
    const ex = allExts();
    ex[2]._auto_recovered_EndRead = { original: null, corrected: '1300.0000', reason: 'StartRead + ReadDifference' };
    runIn(e, 'k1', ex);
    if (e.bills[2].endRead !== '') fail(label, 'a computed end read was written: ' + e.bills[2].endRead);
    const w = misreadWater(waterMeter(), 2);
    const wx = waterExts();
    wx[2]._auto_corrected_WaterCharge = { original: '500.00', corrected: '50.00', reason: 'rate x qty' };
    runIn(w, 'k2', wx);
    if (w.bills[2].waterCharge !== '500.00') fail(label, 'a charge the reader changed was written: ' + w.bills[2].waterCharge);
    const z = waterMeter();
    z.bills[2].waterUsage = '';
    const zx = waterExts();
    zx[2].WaterUsage = '0';
    runIn(z, 'k2', zx);
    if (z.bills[2].waterUsage !== '') fail(label, 'a 0 filled a blank usage: ' + z.bills[2].waterUsage);
    const g = waterMeter();
    g.bills[2].waterUsage = '';
    const gx = waterExts();
    gx[2].WaterUsage = '12161';
    gx[2]._noPageText = true;
    gx[2]._pageText = '1216.1'; // the page prints the value in another unit; 12161 is a conversion (not a thousands form)
    runIn(g, 'k2', gx);
    if (g.bills[2].waterUsage !== '') fail(label, 'a converted value that is not printed was written: ' + g.bills[2].waterUsage);
  }
}
check17(ctx, '17');
// e. one decision, one write path
{
  const rep = repairSource
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if ((rep.match(/repairMayWrite\(/g) || []).length !== 2) fail('17e', 'repairMayWrite must be defined once and called once (in repairFieldsFromExtracted)');
  if ((rep.match(/applyRepairChanges\(/g) || []).length !== 2) fail('17e', 'applyRepairChanges must be defined once and called once (plan.accepted in repairMeterFromPdf)');
  if ((rep.match(/repairFieldsFromExtracted\(/g) || []).length !== 2) fail('17e', 'repairFieldsFromExtracted must be defined once and called once');
  if (!/repairMeterFromPdf\([^)]*\btext\b/.test(rep) || !/repairPageText\(text/.test(rep)) fail('17e', 'repairMeterFromPdf does not take the page text for the page test');
  if (!/repairMeterFromPdf\(t\.meter, t\.bldg, pdfKey, ex\.bills, meta, text\)/.test(rd('app/auto-repair.js'))) fail('17e', 'the browser pass does not pass the page text');
}
// f. mutation: without the page-provenance test the neighbor-page case must FAIL
{
  const guard = /\n(\s*)if \(provenance\) return \{ ok: false, code: 'source', reason: provenance \};\n/;
  if (!guard.test(repairSource)) fail('17f', 'the provenance line in repairMayWrite was not found (the mutation run cannot prove the gate)');
  else {
    const before = problems.length;
    check17(makeRepairContext(repairSource.replace(guard, '\n')), '17-mutation');
    const caught = problems.length - before;
    problems.length = before;
    if (!caught) fail('17f', 'the neighbor-page and derived cases pass with the provenance test removed: the check does not catch it');
  }
}

check14()
  .catch((e) => fail('14', 'the browser pass threw: ' + (e && e.stack ? e.stack : e)))
  .then(() => {
    if (problems.length) {
      console.error('gate-auto-repair FAIL\n  ' + problems.join('\n  '));
      process.exit(1);
    }
    console.log('gate-auto-repair PASS (checks 0-15 and 17; check 16, the run on a real backup, is a local check and is not in this gate)');
  });
