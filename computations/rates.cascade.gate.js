#!/usr/bin/env node
// computations/rates.cascade.gate.js — gate test for the missing-rate resolution
// cascade (resolveMeterRate, computations/rates.js). Loads the REAL on-disk
// rates.js + normalization.js + date-helpers.js into a Node vm sandbox (no
// reimplementation) and asserts each of the 5 cascade steps resolves synthetic
// gaps as designed.
//
// Spec:   _context/plans/2026-09-10-missing-rate-resolution-cascade.md
// Rates:  _context/research/2026-09-10-louisburg-published-utility-rates/findings.md
//
// Run:    node computations/rates.cascade.gate.js
// Exits nonzero on any assertion failure.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');

function buildSandbox() {
  const sandbox = { console, utilityData: {}, projects: [], udSelProjId: null, udSelBldgId: null };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const glue = `
    function _fixISO(d) {
      if (!d || typeof d !== 'string') return d;
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return d;
      const m = d.match(/^(\\d{2})-(\\d{2})-(\\d{2})$/);
      if (m) return '20' + m[3] + '-' + m[1] + '-' + m[2];
      return d;
    }
    function _parseISO(d) { return new Date(_fixISO(d) + 'T12:00:00'); }
    function calcDays(start, end, inclusive) {
      if (!start || !end) return '';
      const s = _parseISO(start), e = _parseISO(end);
      const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
      return inclusive ? diff + 1 : diff;
    }
    function getUDProj(pid) { return (utilityData[pid] || (utilityData[pid] = { buildings: [] }), utilityData[pid]); }
    function getUDBldgs(pid) { return getUDProj(pid).buildings; }
    function getUDBldg(pid, bid) { return getUDBldgs(pid).find(function(b){ return b.id === bid; }); }
    function getWeatherForBuilding() { return { byYm: null, cache: [], zip: '' }; }
  `;
  vm.runInContext(glue, sandbox, { filename: 'glue.js' });
  [
    'lib/date-helpers.js',
    'computations/regression.js',
    'computations/normalization.js',
    'computations/rates.js',
  ].forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  });
  return sandbox;
}

const sandbox = buildSandbox();
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
  }
}

function mkBill(start, end, fields) {
  return Object.assign({ start: start, end: end }, fields || {});
}

/* ═══════════════════════════════════════════════════════════════
   STEP 2 — Published seasonal rate (Circle Grove electric, 2MGSE)
   ═══════════════════════════════════════════════════════════════ */
check('step2: gapped Circle Grove electric SUMMER month (2026-07) resolves to 2MGSE published summer rate', () => {
  const meter = {
    id: 'cg-electric-test',
    commodity: 'Electric',
    rateSchedule: '2MGSE',
    bills: [mkBill('2026-07-01', '2026-07-31', {})], // usage/rate columns intentionally blank — the gap
  };
  const rKwh = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kwh', incl: {}, allMeters: [] });
  assert.ok(rKwh, 'kwh should resolve');
  assert.strictEqual(rKwh.step, 2, 'should resolve at step 2 (published)');
  assert.strictEqual(rKwh.source, 'published-summer');
  const expectedKwh = (0.10304 + 0.05734) / 2;
  assert.ok(Math.abs(rKwh.rate - expectedKwh) < 1e-9, 'kwh rate=' + rKwh.rate + ' expected=' + expectedKwh);

  const rKw = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kw', incl: {}, allMeters: [] });
  assert.ok(rKw, 'kw should resolve');
  assert.strictEqual(rKw.step, 2);
  const expectedKw = 11.54 + 2.854; // demand + facilities, summer
  assert.ok(Math.abs(rKw.rate - expectedKw) < 1e-9, 'kw rate=' + rKw.rate + ' expected=' + expectedKw);
});

check('step2: gapped Circle Grove electric WINTER month (2026-05) resolves to 2MGSE published winter rate', () => {
  const meter = {
    id: 'cg-electric-test2',
    commodity: 'Electric',
    rateSchedule: '2MGSE',
    bills: [mkBill('2026-05-01', '2026-05-31', {})],
  };
  // May is a WINTER month on the Evergy Metro tariff (NOT May-Sep summer).
  const rKwh = sandbox.resolveMeterRate('proj-test', meter, '2026-05', { component: 'kwh', incl: {}, allMeters: [] });
  assert.strictEqual(rKwh.step, 2);
  assert.strictEqual(rKwh.source, 'published-winter');
  const expectedKwh = (0.05436 + 0.04769) / 2;
  assert.ok(Math.abs(rKwh.rate - expectedKwh) < 1e-9, 'kwh rate=' + rKwh.rate + ' expected=' + expectedKwh);
});

check('step2: Louisburg municipal gas resolves to the flat non-seasonal published rate', () => {
  const meter = {
    id: 'gas-test',
    commodity: 'Gas',
    provider: 'City of Louisburg',
    rateSchedule: '',
    bills: [mkBill('2026-03-01', '2026-03-31', {})],
  };
  const r = sandbox.resolveMeterRate('proj-test', meter, '2026-03', { component: 'gas', incl: {}, allMeters: [] });
  assert.strictEqual(r.step, 2);
  assert.strictEqual(r.rate, 0.798062);
});

check(
  'step2: Broadmoor/Field House (AE alias) kw component is NEVER guessed — falls through, energy still resolves',
  () => {
    const meter = {
      id: 'broadmoor-test',
      commodity: 'Electric',
      rateSchedule: '2LGAE',
      bills: [mkBill('2026-07-01', '2026-07-31', {})],
    };
    const rKwh = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kwh', incl: {}, allMeters: [] });
    assert.strictEqual(rKwh.step, 2, 'AE energy IS confirmed — reuses 2LGSE energy');
    const expectedKwh = (0.07852 + 0.04182) / 2; // reuses 2LGSE energy
    assert.ok(Math.abs(rKwh.rate - expectedKwh) < 1e-9);

    const rKw = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kw', incl: {}, allMeters: [] });
    assert.notStrictEqual(rKw && rKw.step, 2, 'AE demand is UNCONFIRMED — must never resolve at step 2');
  },
);

/* ═══════════════════════════════════════════════════════════════
   STEP 3 — Peer meter, same rate schedule, same billing month
   ═══════════════════════════════════════════════════════════════ */
check('step3 (isolated): gapped Middle School (2LGSE) resolves via Rockville peer for the same month', () => {
  const rockville = {
    id: 'rockville',
    commodity: 'Electric',
    rateSchedule: '2LGSE',
    bills: [mkBill('2026-03-01', '2026-03-31', { totalKwhRate: '0.05500' })],
  };
  const middleSchool = {
    id: 'middle-school',
    commodity: 'Electric',
    rateSchedule: '2LGSE',
    bills: [mkBill('2026-03-01', '2026-03-31', {})], // gap — no rate
  };
  const r = sandbox._cascadePeerRate([rockville, middleSchool], middleSchool, {}, '2026-03', 'kwh');
  assert.ok(r, 'peer step should resolve');
  assert.strictEqual(r.rate, 0.055);
  assert.strictEqual(r.peerMeterId, 'rockville');
});

check('step3 (end-to-end, non-published schedule): peer wins when published truly cannot resolve', () => {
  const peer = {
    id: 'peerB',
    commodity: 'Electric',
    rateSchedule: 'UNKNOWN-SCHEDULE-99',
    bills: [mkBill('2026-03-01', '2026-03-31', { totalKwhRate: '0.06100' })],
  };
  const gapped = {
    id: 'gapB',
    commodity: 'Electric',
    rateSchedule: 'UNKNOWN-SCHEDULE-99',
    bills: [mkBill('2026-03-01', '2026-03-31', {})],
  };
  const r = sandbox.resolveMeterRate('proj-test', gapped, '2026-03', {
    component: 'kwh',
    incl: {},
    allMeters: [peer, gapped],
  });
  assert.strictEqual(r.step, 3);
  assert.strictEqual(r.rate, 0.061);
  assert.ok(r.source.indexOf('peerB') >= 0);
});

check('precedence: published (step 2) wins over an available peer (step 3) when both could resolve', () => {
  const peer = {
    id: 'peerC',
    commodity: 'Electric',
    rateSchedule: '2LGSE',
    bills: [mkBill('2026-07-01', '2026-07-31', { totalKwhRate: '0.99999' })], // deliberately way off — must NOT be used
  };
  const gapped = {
    id: 'gapC',
    commodity: 'Electric',
    rateSchedule: '2LGSE',
    bills: [mkBill('2026-07-01', '2026-07-31', {})],
  };
  const r = sandbox.resolveMeterRate('proj-test', gapped, '2026-07', {
    component: 'kwh',
    incl: {},
    allMeters: [peer, gapped],
  });
  assert.strictEqual(r.step, 2, 'published must win over peer per the cascade order');
  assert.notStrictEqual(r.rate, 0.99999);
});

/* ═══════════════════════════════════════════════════════════════
   STEP 4 — Same-season carryforward, NEVER crosses the season boundary
   ═══════════════════════════════════════════════════════════════ */
check('step4: gapped May (winter) carries forward from April (winter) — literal spec case', () => {
  // AE alias + kw component: step 2 is deliberately unreachable (AE demand
  // unconfirmed) so this exercises step 4 end-to-end via the real season table.
  const meter = {
    id: 'field-house-test',
    commodity: 'Electric',
    rateSchedule: '2MGAE',
    bills: [
      mkBill('2026-04-01', '2026-04-30', { totalKwRate: '8.00000' }), // April = winter
      mkBill('2026-05-01', '2026-05-31', {}), // gap — May = winter (target)
    ],
  };
  const r = sandbox.resolveMeterRate('proj-test', meter, '2026-05', { component: 'kw', incl: {}, allMeters: [] });
  assert.strictEqual(r.step, 4);
  assert.strictEqual(r.rate, 8);
  assert.ok(r.source.indexOf('2026-04') >= 0);
});

check('step4: gapped July (summer) carries forward from June (summer) — literal spec case', () => {
  const meter = {
    id: 'field-house-test2',
    commodity: 'Electric',
    rateSchedule: '2MGAE',
    bills: [
      mkBill('2026-06-01', '2026-06-30', { totalKwRate: '9.00000' }), // June = summer
      mkBill('2026-07-01', '2026-07-31', {}), // gap — July = summer (target)
    ],
  };
  const r = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kw', incl: {}, allMeters: [] });
  assert.strictEqual(r.step, 4);
  assert.strictEqual(r.rate, 9);
  assert.ok(r.source.indexOf('2026-06') >= 0);
});

check(
  'step4: NEVER crosses the boundary — skips the nearer WRONG-season month for the correct one further back',
  () => {
    // Gapped June (summer, first month of the season): the immediately-prior
    // calendar month (May) is WINTER on this tariff — a naive "nearest prior
    // month" carry would wrongly grab it. Step 4 must skip May and use the
    // older SUMMER month (prior-year August) instead.
    const meter = {
      id: 'boundary-skip-test',
      commodity: 'Electric',
      rateSchedule: '2MGAE',
      bills: [
        mkBill('2025-08-01', '2025-08-31', { totalKwRate: '7.50000' }), // summer, prior year — CORRECT answer
        mkBill('2026-05-01', '2026-05-31', { totalKwRate: '6.00000' }), // winter, immediately prior — must be SKIPPED
        mkBill('2026-06-01', '2026-06-30', {}), // gap — June = summer (target)
      ],
    };
    const r = sandbox.resolveMeterRate('proj-test', meter, '2026-06', { component: 'kw', incl: {}, allMeters: [] });
    assert.strictEqual(r.step, 4);
    assert.strictEqual(r.rate, 7.5, 'must skip the nearer winter month (rate 6) and use the summer month (rate 7.5)');
    assert.ok(r.source.indexOf('2025-08') >= 0);
  },
);

/* ═══════════════════════════════════════════════════════════════
   STEP 5 — Rate-escalation-normalized historical average (last resort)
   Tested via the internal function directly: per the cascade's own design,
   step 4's unlimited same-season look-back is a superset of what step 5 would
   use, so step 4 legitimately wins ANY time step 5's own historical pool is
   non-empty (both draw from the same bill history) — this isolated call
   proves step 5's histRate + escalation MATH is correct on its own terms.
   ═══════════════════════════════════════════════════════════════ */
check('step5: histRate x escalation — modeled rate shown with its math', () => {
  const meter = { id: 'escalation-test', commodity: 'Electric', rateSchedule: 'UNKNOWN-SCHEDULE-99' };
  const bills = [
    mkBill('2024-07-01', '2024-07-31', { totalKwhRate: '0.08000' }), // July, 2 yrs back
    mkBill('2025-07-01', '2025-07-31', { totalKwhRate: '0.09000' }), // July, 1 yr back
    mkBill('2024-03-01', '2024-03-31', { totalKwhRate: '0.06000' }), // March, 2 yrs back (escalation anchor)
    mkBill('2025-03-01', '2025-03-31', { totalKwhRate: '0.06600' }), // March, 1 yr back (escalation anchor)
    mkBill('2026-03-01', '2026-03-31', { totalKwhRate: '0.09000' }), // March, CURRENT year (known month)
    // 2026-07 deliberately has NO bill at all — this is the gap under test.
  ];
  const histRate = (0.08 + 0.09) / 2; // same-month (July) prior years
  const curAvg = 0.09; // current year's only known month (March)
  const priorAvgSameMonths = (0.06 + 0.066) / 2; // prior years' March average
  const expectedEscalation = curAvg / priorAvgSameMonths;
  const expectedRate = histRate * expectedEscalation;

  const r = sandbox._cascadeEscalationEstimate(bills, {}, '2026-07', 'kwh', meter);
  assert.ok(r, 'step5 should resolve a modeled rate');
  assert.ok(Math.abs(r.histRate - histRate) < 1e-9, 'histRate=' + r.histRate + ' expected=' + histRate);
  assert.ok(
    Math.abs(r.escalation - expectedEscalation) < 1e-9,
    'escalation=' + r.escalation + ' expected=' + expectedEscalation,
  );
  assert.ok(Math.abs(r.rate - expectedRate) < 1e-9, 'rate=' + r.rate + ' expected=' + expectedRate);
  console.log(
    '      histRate=' +
      r.histRate.toFixed(5) +
      ' x escalation=' +
      r.escalation.toFixed(5) +
      ' = modeled rate ' +
      r.rate.toFixed(5),
  );
});

check('step5: falls back to same-SEASON pool when the exact same month has no prior-year data', () => {
  const meter = { id: 'escalation-season-fallback', commodity: 'Electric', rateSchedule: 'UNKNOWN-SCHEDULE-88' };
  const bills = [
    // No July history at all — only OTHER summer months (June, August) from prior years.
    mkBill('2024-06-01', '2024-06-30', { totalKwhRate: '0.07000' }),
    mkBill('2024-08-01', '2024-08-31', { totalKwhRate: '0.09000' }),
    // 2026-07 gap under test; no current-year data at all -> escalation defaults to 1.
  ];
  const r = sandbox._cascadeEscalationEstimate(bills, {}, '2026-07', 'kwh', meter);
  assert.ok(r, 'should resolve via the same-season fallback pool');
  const expectedHistRate = (0.07 + 0.09) / 2;
  assert.ok(Math.abs(r.histRate - expectedHistRate) < 1e-9);
  assert.strictEqual(r.escalation, 1, 'no current-year data at all -> escalation must default to 1 (no invented lift)');
});

/* ═══════════════════════════════════════════════════════════════
   Null case — every step genuinely fails: must return null, never invent
   ═══════════════════════════════════════════════════════════════ */
check('resolveMeterRate returns null (never a fabricated number) when every step fails', () => {
  const meter = {
    id: 'no-data-anywhere',
    commodity: 'Electric',
    rateSchedule: 'TOTALLY-UNKNOWN-SCHEDULE',
    bills: [mkBill('2026-07-01', '2026-07-31', {})],
  };
  const r = sandbox.resolveMeterRate('proj-test', meter, '2026-07', { component: 'kwh', incl: {}, allMeters: [] });
  assert.strictEqual(r, null);
});

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
