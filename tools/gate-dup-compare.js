/**
 * gate-dup-compare.js
 * 1. A blank new value is not a difference (_buildDiffFields); only blanks differing -> 0 fields differ.
 * 2. Overwrite, Merge and Apply Selected (_applyDupUpdate), and the save-row copy (_dupApplyRow), never replace a
 *    saved value with a blank.
 * 3. The duplicate strip text (_dupDiffSummaryText) names the differing fields with both values; 2 named + "+N more".
 * 4. A gas bill compares and labels usage as Therms, not kWh Consumed.
 * Synthetic data only. Usage: node tools/gate-dup-compare.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};

const src = read('app/bill-analysis.js');
function grab(startMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('not found: ' + startMarker);
  let i = src.indexOf('{', a);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(a, i + 1) + (startMarker.startsWith('const') ? ';' : '');
}
let savedBills = [];
const ctx = vm.createContext({
  console,
  sget: async () => savedBills,
  sset: async (k, v) => {
    savedBills = v;
  },
  saveUtilityData: () => {},
  findMeterMatch: () => null,
  convertUnit: (v) => v,
  UNIT_TO_BASE: { CCF: { factor: 1.037 } },
});
vm.runInContext(read('lib/formatting.js'), ctx);
vm.runInContext(read('computations/savings.js'), ctx);
[
  'function _dupHasValue',
  'function _dupApplyRow',
  'const _DUP_FIELD_LABELS',
  'function _dupDiffSummaryText',
  'function _buildDiffFields',
  'function _syncDupGasTherms',
  'async function _applyDupUpdate',
].forEach((m) => {
  vm.runInContext(grab(m), ctx);
});
const run = (code) => vm.runInContext(code, ctx);
const diffs = (ext, ex) => {
  ctx._e = ext;
  ctx._x = ex;
  return run('_buildDiffFields(_e, _x)');
};

// 1. blank new value is not a difference (saved-style bill: same raw keys)
const savedElec = {
  BillingPeriodStart: '07/15/2026',
  BillingPeriodEnd: '08/15/2026',
  AccountNumber: 'SAMPLE-ACCT',
  kWhConsumed: '68139',
  TotalCurrentCharges: '100.00',
};
const newBlank = Object.assign({}, savedElec, { kWhConsumed: '' });
check(diffs(newBlank, savedElec).length === 0, '1: a blank new value counted as a difference');
const newOther = Object.assign({}, savedElec, { kWhConsumed: '70200' });
check(diffs(newOther, savedElec).length === 1, '1: a real difference was not counted');

// 4. gas bill: therms compared and labelled Therms; an empty kWh is not a row
const gasSaved = { start: '2026-07-15', end: '2026-08-15', accountNumber: 'SAMPLE-ACCT', commodity: 'Gas', kwh: 68.139 };
const gasNew = {
  Commodity: 'Gas',
  BillingPeriodStart: '07/15/2026',
  BillingPeriodEnd: '08/15/2026',
  AccountNumber: 'SAMPLE-ACCT',
  NaturalGasTherms: '70.2',
};
const gd = diffs(gasNew, gasSaved);
check(
  gd.length === 1 && gd[0].key === 'NaturalGasTherms',
  '4: gas usage difference not keyed on therms: ' + JSON.stringify(gd),
);
check(run('_DUP_FIELD_LABELS.NaturalGasTherms') === 'Therms', '4: gas label is not Therms');
check(!JSON.stringify(gd).includes('kWhConsumed'), '4: gas bill shows a kWh row');
check(diffs(Object.assign({}, gasNew, { NaturalGasTherms: '68.139' }), gasSaved).length === 0, '4: equal therms counted');
check(diffs(Object.assign({}, gasNew, { NaturalGasTherms: '' }), gasSaved).length === 0, '4: blank therms counted');

// 3. strip text
ctx._d1 = [{ key: 'NaturalGasTherms', existVal: '68.139', newVal: '70.2' }];
check(
  run('_dupDiffSummaryText(_d1)') === 'Therms differ: saved 68.139, new 70.2',
  '3: one-field text: ' + run('_dupDiffSummaryText(_d1)'),
);
ctx._d3 = [
  { key: 'NaturalGasTherms', existVal: '1', newVal: '2' },
  { key: 'TotalCurrentCharges', existVal: '3', newVal: '4' },
  { key: 'AccountNumber', existVal: '5', newVal: '6' },
  { key: 'MeterNumber', existVal: '7', newVal: '8' },
];
const t3 = run('_dupDiffSummaryText(_d3)');
check(
  /Therms/.test(t3) && /Total Current Charges/.test(t3) && !/Account Number/.test(t3) && /\+2 more/.test(t3),
  '3: 4-field text: ' + t3,
);
check(/saved 1, new 2/.test(t3) && /saved 3, new 4/.test(t3), '3: values missing from text: ' + t3);
check(run('_dupDiffSummaryText([])') === 'identical', '3: no-difference text');

// 2. no write of a blank, on every action
const newRow = {
  Commodity: 'Gas',
  NaturalGasTherms: '',
  TotalCurrentCharges: '',
  AccountNumber: 'SAMPLE-ACCT',
  CustomerName: 'New Name',
};
async function apply(action, locationType) {
  const base =
    locationType === 'saved'
      ? {
          id: 's1',
          NaturalGasTherms: '68.139',
          TotalCurrentCharges: '100.00',
          AccountNumber: 'SAMPLE-ACCT',
          CustomerName: 'Old Name',
        }
      : {
          therms: 68.139,
          naturalGasTherms: '68.139',
          totalCost: '100.00',
          accountNumber: 'SAMPLE-ACCT',
          customerName: 'Old Name',
        };
  const existing = JSON.parse(JSON.stringify(base));
  savedBills = [existing];
  ctx._ext = JSON.parse(JSON.stringify(newRow));
  ctx._dup = {
    locationType,
    action,
    existing,
    savedBillId: 's1',
    projId: 'SAMPLE-PROJ',
    diffFields: [{ key: 'NaturalGasTherms' }, { key: 'TotalCurrentCharges' }, { key: 'CustomerName' }],
    fieldSelections: {},
  };
  await run('_applyDupUpdate(0, _ext, _dup)');
  return locationType === 'saved' ? savedBills[0] : ctx._dup.existing;
}
(async () => {
  for (const loc of ['assigned', 'saved']) {
    for (const act of ['overwrite', 'merge', 'field-select']) {
      const r = await apply(act, loc);
      const th = loc === 'saved' ? r.NaturalGasTherms : r.therms;
      const tot = loc === 'saved' ? r.TotalCurrentCharges : r.totalCost;
      check(String(th) === '68.139', '2: ' + loc + ' ' + act + ' lost the saved therms: ' + th);
      check(tot === '100.00', '2: ' + loc + ' ' + act + ' lost the saved total: ' + tot);
    }
  }
  const ow = await apply('overwrite', 'saved');
  check(ow.CustomerName === 'New Name', '2: overwrite did not copy a non-blank new value');
  ctx._t = { a: 'keep', b: '', c: 'old' };
  run("_dupApplyRow(_t, { a: '', b: 'fill', c: 'new', d: null }, 'overwrite')");
  check(
    ctx._t.a === 'keep' && ctx._t.b === 'fill' && ctx._t.c === 'new' && !('d' in ctx._t),
    '2: _dupApplyRow overwrite: ' + JSON.stringify(ctx._t),
  );
  ctx._t = { a: 'keep', b: '', c: 'old' };
  run("_dupApplyRow(_t, { a: '', b: 'fill', c: 'new' }, 'merge')");
  check(
    ctx._t.a === 'keep' && ctx._t.b === 'fill' && ctx._t.c === 'old',
    '2: _dupApplyRow merge: ' + JSON.stringify(ctx._t),
  );
  check(!/Object\.assign\(dup, billRow\)/.test(src), '2: a second overwrite copy remains in the save-row path');
  if (problems.length) {
    console.log('FAIL gate-dup-compare');
    problems.forEach((p) => console.log(' - ' + p));
    process.exit(1);
  }
  console.log('PASS gate-dup-compare');
})().catch((e) => {
  console.log('FAIL gate-dup-compare: ' + e.stack);
  process.exit(1);
});
