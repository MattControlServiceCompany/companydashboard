// tools/test-normmonth-one-pass.js - normMonth one-pass/cached version must equal the original per-call version.
// Run: node tools/test-normmonth-one-pass.js
// SYNTHETIC data only. The reference is the original algorithm, embedded below.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const fixISO = (d) => {
  if (!d || typeof d !== 'string') return d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  return m ? '20' + m[3] + '-' + m[1] + '-' + m[2] : d;
};
const ctx = { _parseISO: (d) => new Date(fixISO(d) + 'T12:00:00'), console };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(REPO, 'computations/normalization.js'), 'utf8') + '\nthis.normMonth = normMonth;',
  ctx,
);
const newNM = ctx.normMonth;

// ORIGINAL implementation (verbatim logic from origin/main before this change)
function oldNM(startStr, endStr, incl, allBills) {
  const _parseISO = ctx._parseISO;
  if (!startStr || !endStr) return startStr || '';
  function majorityMonth(s, e) {
    if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) {
      return s && !isNaN(s.getTime()) ? s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') : null;
    }
    const counts = {};
    let cur = new Date(s);
    let iter = 0;
    while (cur <= e && iter++ < 120) {
      const key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      counts[key] = (counts[key] || 0) + 1;
      cur.setDate(cur.getDate() + 1);
    }
    const entries = Object.entries(counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const [yA, mA] = a[0].split('-').map(Number);
      const [yB, mB] = b[0].split('-').map(Number);
      return b[1] / new Date(yB, mB, 0).getDate() - a[1] / new Date(yA, mA, 0).getDate();
    });
    return entries.length ? entries[0][0] : null;
  }
  function nextMonth(ym) {
    let [y, mo] = ym.split('-').map(Number);
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
    return y + '-' + String(mo).padStart(2, '0');
  }
  if (!allBills || allBills.length === 0) return majorityMonth(_parseISO(startStr), _parseISO(endStr));
  const sorted = allBills
    .filter((b) => b.start && b.end)
    .slice()
    .sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  const assignments = [];
  for (let i = 0; i < sorted.length; i++) {
    const bill = sorted[i];
    const s = _parseISO(bill.start),
      e = _parseISO(bill.end);
    let ym;
    if (i === 0) ym = majorityMonth(s, e);
    else {
      const prev = assignments[i - 1];
      const gap = (s - _parseISO(prev.end)) / 86400000;
      ym = gap >= -3 && gap <= 3 ? nextMonth(prev.ym) : majorityMonth(s, e);
    }
    assignments.push({ start: bill.start, end: bill.end, ym });
  }
  const match = assignments.find((a) => a.start === startStr && a.end === endStr);
  if (match) return match.ym;
  return majorityMonth(_parseISO(startStr), _parseISO(endStr));
}

// deterministic PRNG
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const iso = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addD = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const mdy = (s) => s.slice(5, 7) + '-' + s.slice(8) + '-' + s.slice(2, 4);

function series(kind) {
  const bills = [];
  let cur = new Date(2022, 0, 1 + Math.floor(rnd() * 28));
  const n = 24 + Math.floor(rnd() * 20);
  for (let i = 0; i < n; i++) {
    const start = new Date(cur);
    const end = addD(start, 28 + Math.floor(rnd() * 6));
    let gap = 0;
    if (kind === 'jitter') gap = Math.floor(rnd() * 7) - 3;
    if (kind === 'gaps' && rnd() < 0.2) gap = 5 + Math.floor(rnd() * 60);
    if (kind === 'overlap' && rnd() < 0.2) gap = -(4 + Math.floor(rnd() * 10));
    bills.push({ start: iso(start), end: iso(end) });
    cur = addD(end, gap);
  }
  if (kind === 'dups') {
    bills.push(
      { ...bills[3] },
      { ...bills[3], extra: 1 },
      { start: bills[5].start, end: iso(addD(new Date(bills[5].end), 2)) },
    );
  }
  if (kind === 'legacy')
    bills.forEach((b, i) => {
      if (i % 3 === 0) {
        b.start = mdy(b.start);
        b.end = mdy(b.end);
      }
    });
  if (kind === 'boundary') {
    for (const [s, e] of [
      ['2023-12-16', '2024-01-15'],
      ['2024-01-14', '2024-02-18'],
      ['2024-01-14', '2024-02-20'],
      ['2024-02-01', '2024-02-29'],
      ['2023-12-31', '2024-01-01'],
    ])
      bills.push({ start: s, end: e });
  }
  if (kind === 'blank')
    bills.push({ start: '', end: '2024-01-01' }, { start: '2024-05-01' }, { start: null, end: null });
  if (kind === 'shuffled')
    for (let i = bills.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [bills[i], bills[j]] = [bills[j], bills[i]];
    }
  return bills;
}

let compared = 0;
for (const kind of ['plain', 'jitter', 'gaps', 'overlap', 'dups', 'legacy', 'boundary', 'blank', 'shuffled']) {
  for (let rep = 0; rep < 12; rep++) {
    const bills = series(kind);
    for (const incl of [false, true]) {
      for (const b of bills) {
        const o = oldNM(b.start, b.end, incl, bills);
        const nn = newNM(b.start, b.end, incl, bills);
        compared++;
        assert(o === nn, kind + ' ' + b.start + '->' + b.end + ' old=' + o + ' new=' + nn);
      }
      assert(
        oldNM('2023-03-05', '2023-04-04', incl, bills) === newNM('2023-03-05', '2023-04-04', incl, bills),
        kind + ' fallback',
      );
      assert(
        oldNM('2023-03-05', '2023-04-04', incl, []) === newNM('2023-03-05', '2023-04-04', incl, []),
        kind + ' empty',
      );
      assert(
        oldNM('2023-03-05', '2023-04-04', incl, null) === newNM('2023-03-05', '2023-04-04', incl, null),
        kind + ' null',
      );
    }
  }
}
// cache must invalidate when the same array is mutated
const arr = series('plain');
newNM(arr[4].start, arr[4].end, false, arr);
arr[2].start = iso(addD(new Date(arr[2].start), 40));
arr.push({ start: '2030-01-01', end: '2030-01-31' });
for (const b of arr)
  assert(oldNM(b.start, b.end, false, arr) === newNM(b.start, b.end, false, arr), 'after mutation ' + b.start);
arr.splice(1, 2);
for (const b of arr)
  assert(oldNM(b.start, b.end, false, arr) === newNM(b.start, b.end, false, arr), 'after splice ' + b.start);
console.log('compared ' + compared + ' bills; passed ' + passed + ', failed ' + failed);
process.exit(failed ? 1 : 0);
