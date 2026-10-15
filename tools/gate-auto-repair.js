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
 *   6. a duplicate row is deleted, or a row that is not a duplicate (other page or other total) is reported as one
 *   7. a changed field has no history entry, or the entry does not hold the old and the new value, or Edit Billing Period
 *      does not show it, or editing the field does not clear it
 *   8. the new code holds a second copy of a rule: a field map, a date pattern, a therm conversion; or it does not call the
 *      shared extraction (extractBillsFromText), the shared mapper (_extractedToBillRowCosts, gasBillSaveTherms) and the
 *      shared page-text cache (_bcrLoadPdfText); or the queue does not call the shared extraction
 *   9. (not in this gate) the run on the real backup: tools/ has no real data; the result is kept in the work notes
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

const ctx = sandbox.makeContext();
vm.runInContext(fnSource('computations/savings.js', 'gasBillSaveTherms'), ctx);
vm.runInContext(fnSource('app/bill-analysis.js', '_acctFuzzyMatch'), ctx);
vm.runInContext(fnSource('app/bill-analysis.js', '_extractedToBillRowCosts'), ctx);
vm.runInContext(rd('computations/bill-repair.js'), ctx);
const ud = rd('app/utility-data.js');
const grab = (src, re) => {
  const m = re.exec(src);
  if (!m) throw new Error('source not found: ' + re);
  return m[0];
};
vm.runInContext(
  [
    "function _billSchemaFor(){ return [{key:'kwh',label:'kWh Consumed',type:'number',pdfKey:'kWhConsumed'}]; }",
    grab(ud, /const _READ_CORRECTION_LABELS[^\n]*\n/),
    grab(ud, /function _readCorrectionRecords[\s\S]*?\n\}\n/),
    grab(ud, /function _billChangeHistory\([\s\S]*?\n\}\n/),
  ].join('\n'),
  ctx,
);
const call = (name, ...args) => {
  ctx.__args = args;
  return vm.runInContext(name + '(...__args)', ctx);
};
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
      BillingPeriodStart: MONTHS[i][0].slice(5, 7) + '/' + MONTHS[i][0].slice(8) + '/' + MONTHS[i][0].slice(0, 4),
      BillingPeriodEnd: MONTHS[i][1].slice(5, 7) + '/' + MONTHS[i][1].slice(8) + '/' + MONTHS[i][1].slice(0, 4),
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
      BillingPeriodStart: MONTHS[i][0].slice(5, 7) + '/' + MONTHS[i][0].slice(8) + '/' + MONTHS[i][0].slice(0, 4),
      BillingPeriodEnd: MONTHS[i][1].slice(5, 7) + '/' + MONTHS[i][1].slice(8) + '/' + MONTHS[i][1].slice(0, 4),
      WaterUsage: '10000',
      WaterCharge: '50.00',
      TotalCurrentCharges: '50.00',
      _pageStart: i + 1,
      _pageEnd: i + 1,
    },
    o || {},
  );
}
const run = (m, pdfKey, exts) => call('repairMeterFromPdf', m, bldgOf(m), pdfKey, exts, META);
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
  if (r3.repaired.length || r3.added.length || stable(m) !== after1) fail('1', 'a second pass without the marker changed data');
  const w = waterMeter();
  w.bills[3].waterUsage = '900000';
  run(w, 'k2', MONTHS.map((_, i) => waterExt(i)));
  const wAfter = stable(w);
  w.bills.forEach((b) => delete b._pdfRepair);
  run(w, 'k2', MONTHS.map((_, i) => waterExt(i)));
  if (stable(w) !== wAfter) fail('1', 'a second water pass changed data');
}

// ── 2. user-corrected fields never change ───────────────────────────────────────────────────
{
  const m = misreadMeter();
  m.bills[2]._userCorrected = { readDifference: { original: '100.1', at: 'x' } };
  const before = m.bills[2].readDifference;
  run(m, 'k1', allExts());
  if (m.bills[2].readDifference !== before) fail('2', 'a user-corrected read difference was replaced');
  const control = waterMeter();
  control.bills[3].waterUsage = '900000';
  run(control, 'k2', MONTHS.map((_, i) => waterExt(i)));
  if (control.bills[3].waterUsage === '900000') fail('2', 'control: the usage was not repaired without the user mark, so this check proves nothing');
  const w = waterMeter();
  w.bills[3].waterUsage = '900000';
  w.bills[3]._userCorrected = { waterUsage: { original: '10000', at: 'x' } };
  run(w, 'k2', MONTHS.map((_, i) => waterExt(i)));
  if (w.bills[3].waterUsage !== '900000') fail('2', 'a user-corrected usage was replaced');
  // a user-corrected start date
  const w2 = waterMeter();
  w2.bills[1].start = '2025-02-01';
  w2.bills[1]._userCorrected = { start: { original: '2025-01-31', at: 'x' } };
  run(w2, 'k2', MONTHS.map((_, i) => waterExt(i)));
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
    const w = waterMeter();
    w.bills[2].waterUsage = '900000';
    const wb = stable(w);
    const wx = MONTHS.map((_, i) => waterExt(i));
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
    const w = waterMeter();
    w.bills[2].waterUsage = '900000';
    const wb = clone(w);
    const wx = MONTHS.map((_, i) => waterExt(i));
    wx.forEach((e) => keysW.forEach((k) => rnd() < 0.3 && (e[k] = rnd() < 0.5 ? '' : null)));
    run(w, 'k2', wx);
    check(wb, w, 'water run ' + t);
  }
}

// ── 4. printed values inside the print rounding stay ───────────────────────────────────────
{
  // Stored reads and difference agree (the printed difference). The fresh read differs by one unit in the last digit
  // (print rounding) in every field: nothing changes.
  const m = electricMeter();
  const exts = allExts();
  exts.forEach((e) => {
    e.StartRead = f4(parseFloat(e.StartRead) + 0.0001);
    e.EndRead = f4(parseFloat(e.EndRead) + 0.0001);
    e.ReadDifference = f4(parseFloat(e.ReadDifference) + 0.0001);
  });
  m.bills.forEach((b) => delete b._pdfRepair);
  const before = stable(m);
  m.bills[2].startRead = f4(1200);
  // force eligibility: the bill before is blank-read, so bills 1..3 are read
  m.bills[1].startRead = '';
  const snap = clone(m);
  run(m, 'k1', exts);
  ['readDifference', 'kwh'].forEach((k) => {
    m.bills.forEach((b, i) => {
      if (String(b[k]) !== String(snap.bills[i][k])) fail('4', k + ' of bill ' + i + ' was replaced by a value inside the print rounding');
    });
  });
  // The stored difference agrees with the stored reads, the fresh difference is a different value: the stored one stays,
  // and so does the kWh (it only follows a difference that changed).
  const m2 = electricMeter();
  m2.bills[1].startRead = ''; // a blank-read neighbor makes bills 0 to 2 eligible
  const exts2 = allExts();
  exts2[2].ReadDifference = '100.0009';
  exts2[2].EndRead = '1300.0009';
  exts2[3].StartRead = '1300.0009';
  const s2 = clone(m2);
  run(m2, 'k1', exts2);
  if (m2.bills[2].readDifference !== s2.bills[2].readDifference) fail('4', 'a printed difference that the stored reads confirm was replaced');
  if (m2.bills[2].kwh !== s2.bills[2].kwh) fail('4', 'a printed kWh changed although its difference did not');
  void before;
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
    // stored defects
    w.bills.forEach((b, i) => {
      if (rnd() < 0.3) b.waterUsage = String(Math.round(10000 * (5 + 100 * rnd())));
    });
    const wx = MONTHS.map((_, i) => waterExt(i));
    // fresh reads that are wrong in ways that would add flags: wrong dates, wrong totals
    wx.forEach((e, i) => {
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
    e.bills.forEach((b, i) => {
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
  if (!rejectedSeen) fail('5', 'no repair was rejected by the flag check in any run: the check is not exercised');
  // a repair that adds a flag is declined and the bill keeps its value
  const w = waterMeter();
  w.bills[2].waterUsage = '900000';
  const wx = MONTHS.map((_, i) => waterExt(i));
  wx[2].BillingPeriodStart = '03/10/2025'; // would overlap the bill before
  const startBefore = w.bills[2].start;
  run(w, 'k2', wx);
  if (w.bills[2].start !== startBefore && flagsOf(w)['w2'] && flagsOf(w)['w2'].includes('period_overlap'))
    fail('5', 'a date that creates an overlap was kept');
}

// ── 6. duplicates are reported and kept ─────────────────────────────────────────────────────
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
  w.bills[1].waterUsage = '900000'; // make the meter eligible
  const n = w.bills.length;
  const r = run(w, 'k2', MONTHS.map((_, i) => waterExt(i)));
  if (w.bills.length !== n) fail('6', 'a row was deleted or added: ' + n + ' -> ' + w.bills.length);
  const ids = r.duplicates.map((g) => g.map((b) => b.id).sort().join('+'));
  if (!ids.includes('w3+wdup')) fail('6', 'the duplicate pair was not reported: ' + JSON.stringify(ids));
  if (ids.some((x) => /wother/.test(x))) fail('6', 'a row with another total was reported as a duplicate');
  const again = call('findDuplicateRowGroups', w);
  if (again.length !== 1) fail('6', 'expected one duplicate group, found ' + again.length);
  const orchestrator = rd('app/auto-repair.js');
  if (!/pdf_duplicate_rows/.test(orchestrator)) fail('6', 'the duplicate is not written to the audit log');
  if (/\.splice\(|bills\s*=\s*[^=]*\.filter\(/.test(orchestrator + rd('computations/bill-repair.js')))
    fail('6', 'the repair code removes rows from a bills list');
}

// ── 7. history ──────────────────────────────────────────────────────────────────────────────
{
  const m = misreadMeter();
  m.bills[4].kwh = '1';
  const before = clone(m);
  run(m, 'k1', allExts());
  let changedFields = 0;
  m.bills.forEach((b, i) => {
    const o = before.bills[i];
    Object.keys(b).forEach((k) => {
      if (k === '_pdfRepair' || k === '_autoRepairHistory' || k.indexOf('_auto_corrected_') === 0) return;
      if (String(b[k]) === String(o[k])) return;
      changedFields++;
      const h = (b._autoRepairHistory || []).find((x) => x.field === k);
      if (!h) fail('7', 'bill ' + i + ' field ' + k + ' changed with no history entry');
      else {
        if (String(h.original) !== String(o[k] === undefined ? '' : o[k])) fail('7', 'history original wrong for ' + k + ': ' + h.original);
        if (String(h.corrected) !== String(b[k])) fail('7', 'history corrected wrong for ' + k);
        if (!h.at || h.ruleVersion !== META.version) fail('7', 'history entry has no time or rule version for ' + k);
      }
    });
  });
  if (!changedFields) fail('7', 'the fixture changed nothing: the check is not exercised');
  const row = m.bills[2];
  const shown = call('_billChangeHistory', row, 'Electric');
  if (!shown.some((h) => /Re-read from the PDF/.test(h.note) && String(h.corrected) === String(row.readDifference)))
    fail('7', 'Edit Billing Period history does not show the re-read: ' + JSON.stringify(shown));
  const edited = clone(row);
  edited.readDifference = '55.0000';
  if (call('_billChangeHistory', edited, 'Electric').some((h) => /Re-read from the PDF/.test(h.note) && h.label === 'Read Difference'))
    fail('7', 'an edited value still shows the old repair');
  call('clearAutoRepairHistory', row, ['readDifference']);
  if ((row._autoRepairHistory || []).some((h) => h.field === 'readDifference')) fail('7', 'editing the field did not clear its history entry');
  const wired = rd('computations/bill-flags.js');
  if (!/clearAutoRepairHistory\(row, fields\)/.test(wired)) fail('7', 'the edit paths (clearReadCorrectionRecords) do not clear the repair history');
}

// ── 8. one copy of every rule ───────────────────────────────────────────────────────────────
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
  if (!/extractBillsFromText\(/.test(orch)) fail('8', 'the repair pass does not use the shared extraction');
  if (!/_bcrLoadPdfText\(/.test(orch)) fail('8', 'the repair pass does not use the shared page-text cache');
  if (!/correctMeterReadChain\(/.test(orch)) fail('8', 'the repair pass does not run the existing read-chain rule');
  if (/Promise\.all|Promise\.allSettled/.test(orch)) fail('8', 'the repair pass reads PDFs in parallel');
  if (!/requestIdleCallback/.test(orch)) fail('8', 'the repair pass does not wait for an idle browser');
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

if (problems.length) {
  console.error('gate-auto-repair FAIL\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('gate-auto-repair PASS (checks 0-8; check 9, the run on a real backup, is a local check and is not in this gate)');
