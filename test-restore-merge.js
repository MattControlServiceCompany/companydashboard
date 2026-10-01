// Unit + property tests for app/restore-merge.js (synthetic fixtures only).
// Run: node test-restore-merge.js
// T1..T19 = test cases 1-19 from 2026-10-01-research-data-shapes.md section 6
// (T14 and T19 live in the e2e script; T20 = the gate scripts themselves).
const assert = require('assert');
const RM = require('./app/restore-merge.js');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('PASS ' + name);
}
const J = JSON.stringify;
const clone = (v) => JSON.parse(J(v));
const ids = (list) => list.map((r) => r.id);
const same = (a, b) => RM.canon(a) === RM.canon(b);
const isRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCont = (v) => isRec(v) || Array.isArray(v);
const mv = (key, c, b, mode, keys) => RM.mergeValue(key, c, b, mode, keys || [key]);
const MODES = ['add', 'merge', 'replace'];

// ---------------------------------------------------------------- invariant helpers (test-side walkers)
function leafPaths(v, path, out) {
  path = path || [];
  out = out || [];
  if (Array.isArray(v) && v.length) v.forEach((x, i) => leafPaths(x, path.concat(i), out));
  else if (isRec(v) && Object.keys(v).length) Object.keys(v).forEach((k) => leafPaths(v[k], path.concat(k), out));
  else out.push([path, v]);
  return out;
}
function arrayPaths(v, path, out) {
  path = path || [];
  out = out || [];
  if (Array.isArray(v)) {
    out.push([path, v.length]);
    v.forEach((x, i) => arrayPaths(x, path.concat(i), out));
  } else if (isRec(v)) Object.keys(v).forEach((k) => arrayPaths(v[k], path.concat(k), out));
  return out;
}
const MISSING = { missing: true };
function get(v, path) {
  for (const p of path) {
    if (Array.isArray(v) ? !(p < v.length) : !(isRec(v) && p in v)) return MISSING;
    v = v[p];
  }
  return v;
}
const idKey = (r, idOf) => {
  if (!isRec(r)) return null;
  const id = idOf(r);
  return id === undefined || id === null || id === '' ? null : String(id);
};
function allIds(v, idOf, out) {
  out = out || [];
  if (Array.isArray(v)) v.forEach((x) => allIds(x, idOf, out));
  else if (isRec(v)) {
    const k = idKey(v, idOf);
    if (k !== null) out.push(k);
    Object.keys(v).forEach((f) => allIds(v[f], idOf, out));
  }
  return out;
}
// Ids of records at the policy levels only (the merge identifies nothing below them).
function policyIds(v, pol, level, out) {
  out = out || [];
  if (level === undefined) {
    const top = pol.path.length ? (isRec(v) ? v[pol.path[0]] : undefined) : v;
    return policyIds(top, pol, pol.path.length ? 1 : 0, out);
  }
  (Array.isArray(v) ? v : []).forEach((r) => {
    const k = idKey(r, pol.idOf);
    if (k !== null) out.push(k);
    const child = pol.path[level];
    if (child && isRec(r)) policyIds(r[child], pol, level + 1, out);
  });
  return out;
}
function countBy(list) {
  const m = new Map();
  list.forEach((k) => m.set(k, (m.get(k) || 0) + 1));
  return m;
}
// Backup record matched to the current record that owns a leaf path (records policy levels only).
function matchedBackupRecord(bak, cur, path, pol) {
  if (pol.kind === 'map') return isRec(bak) && path.length && path[0] in bak ? { b: bak[path[0]], rest: path.slice(1) } : MISSING;
  let b = bak;
  let c = cur;
  let level = pol.path.length ? 0 : -1;
  let i = 0;
  if (pol.path.length) {
    if (!isRec(b) || !isRec(c) || path[0] !== pol.path[0]) return MISSING;
    b = b[pol.path[0]];
    c = c[pol.path[0]];
    i = 1;
    level = 1;
  } else level = 0;
  let rec = MISSING;
  for (; i < path.length; i++) {
    const p = path[i];
    if (!Array.isArray(b) || !Array.isArray(c)) break;
    const item = c[p];
    const k = idKey(item, pol.idOf);
    if (k === null || c.filter((x) => idKey(x, pol.idOf) === k).length > 1) return MISSING;
    const j = b.findIndex((x) => idKey(x, pol.idOf) === k);
    if (j === -1) return MISSING;
    rec = { b: b[j], rest: path.slice(i + 1) };
    const child = pol.path[level];
    level += 1;
    if (child && path[i + 1] === child) {
      b = b[j][child];
      c = item[child];
      i += 1;
    } else break;
  }
  return rec;
}
// Independent Replace oracle: items at policy levels in cur that res lacks (by id / deep-equal), plus
// descendants; for whole-key policies, list items and container fields that vanish.
function countIn(rec, pol, level) {
  const child = pol.path[level];
  const kids = child && isRec(rec) && Array.isArray(rec[child]) ? rec[child] : [];
  return 1 + kids.reduce((n, r) => n + countIn(r, pol, level + 1), 0);
}
function removedOracleLevels(c, r, pol, level) {
  const ca = Array.isArray(c) ? c : [];
  const ra = Array.isArray(r) ? r : [];
  let n = 0;
  ca.forEach((x) => {
    const k = idKey(x, pol.idOf);
    const j = k === null ? ra.findIndex((y) => same(x, y)) : ra.findIndex((y) => idKey(y, pol.idOf) === k);
    if (j === -1) n += countIn(x, pol, level);
    else if (pol.path[level]) n += removedOracleLevels(x[pol.path[level]], ra[j][pol.path[level]], pol, level + 1);
  });
  return n;
}
function removedOracleLoose(c, r) {
  if (Array.isArray(c)) {
    const ra = Array.isArray(r) ? r : [];
    let n = 0;
    c.forEach((x) => {
      const k = idKey(x, (q) => q.id);
      const j = k === null ? ra.findIndex((y) => same(x, y)) : ra.findIndex((y) => idKey(y, (q) => q.id) === k);
      if (j === -1) n += 1;
      else if (k !== null) n += removedOracleLoose(x, ra[j]);
    });
    return n;
  }
  if (isRec(c)) {
    let n = 0;
    Object.keys(c).forEach((k) => {
      if (!isCont(c[k])) return;
      const rv = isRec(r) ? r[k] : undefined;
      if (rv === undefined) n += Array.isArray(c[k]) ? c[k].length : 1;
      else n += removedOracleLoose(c[k], rv);
    });
    return n;
  }
  return 0;
}
function removedOracle(key, cur, res) {
  const pol = RM.policyFor(key, [key]);
  if (pol.kind === 'records' || pol.kind === 'frozen') {
    const list = (v) => (pol.path.length ? (isRec(v) ? v[pol.path[0]] : undefined) : v);
    let n = removedOracleLevels(list(cur), list(res), pol, pol.path.length ? 1 : 0);
    if (pol.path.length && isRec(cur)) {
      const c2 = Object.assign({}, cur);
      delete c2[pol.path[0]];
      n += removedOracleLoose(c2, res);
    }
    return n;
  }
  if (pol.kind === 'map') return Object.keys(cur).filter((k) => !(k in res)).length;
  return removedOracleLoose(cur, res);
}

// Every rule of the policy table, checked on one (key, cur, bak, mode).
function checkInvariants(key, cur, bak, mode, label) {
  const pol = Object.assign({ idOf: () => undefined }, RM.policyFor(key, [key]));
  const curIn = RM.canon(cur);
  const bakIn = RM.canon(bak);
  const r = mv(key, cur, bak, mode);
  assert.ok(RM.canon(cur) === curIn && RM.canon(bak) === bakIn, label + ': input mutated');
  const curP = RM.parseMaybe(cur);
  const bakP = RM.parseMaybe(bak);
  const res = RM.parseMaybe(r.value);
  if (typeof cur === 'string' && r.changed)
    assert.strictEqual(typeof r.value, 'string', label + ': representation changed');
  if (pol.kind === 'never') {
    assert.strictEqual(r.changed, false, label + ': never-restore key changed');
    return r;
  }
  if (cur === undefined) {
    if (RM.meaningful(bakP)) assert.ok(r.changed, label + ': absent key not written');
    else assert.strictEqual(r.changed, false, label + ': absent key, empty backup: no write');
    return r;
  }
  assert.strictEqual(r.changed, !same(curP, res), label + ': changed flag');
  if (!RM.meaningful(bakP)) assert.strictEqual(r.changed, false, label + ': empty backup changed something');
  const eff = pol.kind === 'frozen' ? 'add' : mode;
  if (eff === 'replace') {
    if (r.changed) {
      assert.ok(
        same(res, bakP) || !RM.meaningful(curP) || pol.kind === 'records',
        label + ': replace result is not the backup',
      );
      assert.strictEqual(r.removed, removedOracle(key, curP, res), label + ': removed count differs from oracle');
    }
    return r;
  }
  // add / merge: no current leaf changes (add) or only blanks are filled (merge); arrays never shrink; ids never disappear
  assert.strictEqual(r.removed, 0, label + ': add/merge reports removed');
  if (pol.kind === 'key') {
    assert.ok(!RM.meaningful(curP) || !r.changed, label + ': whole-key policy changed an existing value');
    return r;
  }
  if (pol.sortBy && Array.isArray(curP)) {
    // ordered lists: compare by record identity, not index
    curP.forEach((c) => {
      const k = idKey(c, pol.idOf);
      const m = k === null ? res.find((x) => same(x, c)) : res.find((x) => idKey(x, pol.idOf) === k);
      assert.ok(m, label + ': current record lost ' + J(c));
      if (eff === 'add' || k === null) assert.ok(same(m, c), label + ': add changed record ' + k);
      else if (!pol.newer) Object.keys(c).forEach((f) => assert.ok(!RM.meaningful(c[f]) || same(m[f], c[f]), label + ': merge overwrote ' + f));
    });
    assert.ok(res.length >= curP.length, label + ': list shrank');
    return r;
  }
  for (const [p, cv] of leafPaths(curP)) {
    const rv = get(res, p);
    assert.notStrictEqual(rv, MISSING, label + ': current leaf lost at ' + J(p));
    if (same(rv, cv)) continue;
    if (
      isCont(cv) &&
      !RM.meaningful(cv) &&
      Array.isArray(rv) === Array.isArray(cv) &&
      isRec(rv) === isRec(cv) &&
      pol.kind !== 'key'
    ) {
      // an empty list at a policy level may gain records; an empty field may be filled (merge)
      const atPolicyList =
        (Array.isArray(cv) && (p.length === 0 ? !pol.path.length : pol.path.indexOf(p[p.length - 1]) !== -1)) ||
        (pol.kind === 'map' && p.length === 0);
      if (eff === 'add' && !atPolicyList)
        assert.fail(label + ': add filled ' + J(p));
      continue;
    }
    if (eff === 'add') assert.fail(label + ': add changed ' + J(p) + ' ' + J(cv) + ' -> ' + J(rv));
    assert.ok(!RM.meaningful(cv), label + ': merge overwrote a filled value at ' + J(p));
    const m = matchedBackupRecord(bakP, curP, p, pol);
    assert.notStrictEqual(m, MISSING, label + ': merge filled ' + J(p) + ' from no matched record');
    const bv = get(m.b, m.rest);
    assert.ok(
      bv !== MISSING && RM.meaningful(bv) && same(rv, bv),
      label + ': merge fill at ' + J(p) + ' is not the backup value',
    );
  }
  const ci = countBy(policyIds(curP, pol));
  const ri = countBy(policyIds(res, pol));
  for (const [k, n] of ci) assert.ok((ri.get(k) || 0) >= n, label + ': record id disappeared ' + k);
  for (const [p, len] of arrayPaths(curP)) {
    if (len === 0 && eff === 'merge') continue; // an empty list is a blank: merge may fill it
    const rv = get(res, p);
    assert.ok(Array.isArray(rv) && rv.length >= len, label + ': array shrank at ' + J(p));
  }
  // backup records at the top policy level that current lacks are present in the result
  const top = (v) => (pol.path.length ? (isRec(v) ? v[pol.path[0]] : undefined) : v);
  if (Array.isArray(top(bakP)) && Array.isArray(top(curP))) {
    top(bakP).forEach((x) => {
      const k = idKey(x, pol.idOf);
      if (k !== null) assert.ok(ri.has(k), label + ': backup record ' + k + ' missing from result');
    });
  }
  return r;
}

// ---------------------------------------------------------------- fixtures
const U = 'en_utility_cust_c1';
const util = () => ({
  buildings: [
    {
      id: 'b1',
      name: 'Main',
      sqft: 1000,
      meters: [
        {
          id: 'm1',
          label: 'Elec',
          baseline: { months: 12 },
          bills: [
            { id: 'r1', kwh: '100', cost: 10 },
            { id: 'r2', kwh: 120, cost: '' },
          ],
        },
        { id: 'm2', label: 'Gas', bills: [{ id: 'r3', therms: 5 }] },
      ],
    },
    {
      id: 'b2',
      name: 'Annex',
      meters: [
        { id: 'm9', label: 'Nine' },
        { id: 'm8', label: 'Eight', bills: [] },
      ],
    },
  ],
});
const proj = () => [
  {
    id: 1779664753271,
    name: 'P1',
    customerId: 'cust_1',
    status: 'active',
    progress: 40,
    scope: { buildingIds: ['b1', 'b2'], meterExcludeIds: ['m2'] },
    hvacLoadEst: { monthlyCoolKwh: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] },
    savingsData: { measures: [{ id: 'x1', kwh: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] },
    setpoints: [{ buildingId: 'b1', zones: [{ name: 'Z1', occ: 70 }] }],
    note: '',
  },
];

// ---------------------------------------------------------------- T1 positional arrays
t('T1 positional 12-month arrays stay current in add and merge', () => {
  const c = proj();
  const b = clone(c);
  b[0].hvacLoadEst.monthlyCoolKwh = b[0].hvacLoadEst.monthlyCoolKwh.map((x) => x - 1);
  b[0].savingsData.measures[0].kwh = b[0].savingsData.measures[0].kwh.map((x) => x + 1);
  for (const mode of ['add', 'merge']) {
    const r = checkInvariants('en_projects', c, b, mode, 'T1 ' + mode);
    assert.deepStrictEqual(r.value[0].hvacLoadEst.monthlyCoolKwh, c[0].hvacLoadEst.monthlyCoolKwh);
    assert.deepStrictEqual(r.value[0].savingsData.measures[0].kwh, c[0].savingsData.measures[0].kwh);
    assert.strictEqual(r.value[0].hvacLoadEst.monthlyCoolKwh.length, 12);
    assert.strictEqual(r.changed, false);
  }
});

// ---------------------------------------------------------------- T2 set arrays
t('T2 set arrays (meterExcludeIds, fitExcludedIds, hidden, projTabOrder) stay current', () => {
  const c = proj();
  const b = clone(c);
  b[0].scope.meterExcludeIds = ['m2', 'm1', 'm9'];
  b[0].scope.buildingIds = ['b1'];
  for (const mode of ['add', 'merge']) {
    const r = checkInvariants('en_projects', c, b, mode, 'T2 ' + mode);
    assert.deepStrictEqual(r.value[0].scope, c[0].scope);
    assert.strictEqual(r.changed, false);
    const pb = checkInvariants(
      'en_pricing_budget_1779664753271',
      { fitExcludedIds: ['a'] },
      { fitExcludedIds: ['a', 'b'] },
      mode,
      'T2 fit ' + mode,
    );
    assert.strictEqual(pb.changed, false);
    const vs = checkInvariants(
      'bills_view_state_m1',
      { hidden: ['x'] },
      { hidden: ['x', 'y'] },
      mode,
      'T2 hidden ' + mode,
    );
    assert.strictEqual(vs.changed, false);
    const tabs = checkInvariants('ch_projTabOrder', '["a","b"]', '["a","b","c"]', mode, 'T2 tabs ' + mode);
    assert.strictEqual(tabs.changed, false);
  }
});

// ---------------------------------------------------------------- T3 id-less edited records
t('T3 id-less edited records are not duplicated (alarm rows, setpoint zones, audit log, snapshots)', () => {
  const alarms = {
    importedAt: 'x',
    rows: [
      { sNo: 1, acknowledged: true, comment: 'ok' },
      { sNo: 2, acknowledged: false },
    ],
  };
  const bakAl = clone(alarms);
  bakAl.rows[0].acknowledged = false;
  bakAl.rows.push({ sNo: 3 });
  const c = proj();
  const b = clone(c);
  b[0].setpoints[0].zones[0].occ = 68;
  for (const mode of ['add', 'merge']) {
    const a = checkInvariants('en_alarms_1779664753271', alarms, bakAl, mode, 'T3 alarms ' + mode);
    assert.strictEqual(a.changed, false);
    assert.strictEqual(a.value.rows.length, 2);
    const p = checkInvariants('en_projects', c, b, mode, 'T3 zones ' + mode);
    assert.strictEqual(p.value[0].setpoints.length, 1);
    assert.strictEqual(p.value[0].setpoints[0].zones[0].occ, 70);
    const snap = checkInvariants(
      'en_report_history_1779664753271',
      [{ filename: 'a', n: 1 }],
      [{ filename: 'a', n: 2 }, { filename: 'b' }],
      mode,
      'T3 history ' + mode,
    );
    assert.strictEqual(snap.changed, false);
  }
});

// ---------------------------------------------------------------- T4 deletions / tombstones
t(
  'T4 deleted after the backup: Add re-adds only what the policy says; tombstoned key skipped unless ticked; preview names items',
  () => {
    const b = util();
    const c = clone(b);
    c.buildings.pop(); // building b2 deleted
    c.buildings[0].meters.pop(); // meter m2 (+ bill r3) deleted
    c.buildings[0].meters[0].bills.shift(); // bill r1 deleted
    const r = checkInvariants(U, c, b, 'add', 'T4 util');
    assert.strictEqual(r.added, 6); // r1; m2+r3; b2+m9+m8
    assert.deepStrictEqual(r.names, ['Gas (1 bills)', 'Annex (2 meters and bills)']);
    // project deleted: comes back only through en_projects (policy: add whole record)
    const pr = checkInvariants('en_projects', [], proj(), 'add', 'T4 proj');
    assert.deepStrictEqual(pr.names, ['P1']);
    // tombstoned key: skipped unless ticked
    const backup = { en_projects: proj(), en_tasks: [{ id: 1, text: 'x' }] };
    const p1 = RM.plan(backup, () => undefined, 'add', { isDeleted: (k) => k === 'en_projects' });
    const pj = p1.items.find((i) => i.key === 'en_projects');
    assert.ok(pj.tombstoned && !pj.changed && pj.value === undefined);
    assert.ok(p1.items.find((i) => i.key === 'en_tasks').changed);
    const p2 = RM.plan(backup, () => undefined, 'add', {
      isDeleted: (k) => k === 'en_projects',
      restoreDeleted: ['en_projects'],
    });
    const pj2 = p2.items.find((i) => i.key === 'en_projects');
    assert.ok(pj2.tombstoned && pj2.changed && pj2.names[0] === 'P1');
    const sum = RM.summarize(p1.items);
    assert.strictEqual(sum.find((s) => s.label === 'Projects').tombstoned, 1);
    // audit-log deletions after the backup are flagged
    const p3 = RM.plan(
      { en_utility_audit_log: [{ ts: '2026-01-01', action: 'add' }] },
      (k) =>
        k === 'en_utility_audit_log'
          ? [
              { ts: '2026-01-01', action: 'add' },
              { ts: '2026-02-01', action: 'delete' },
              { ts: '2026-02-02', action: 'delete_all' },
            ]
          : undefined,
      'add',
    );
    assert.ok(/2 bill deletion\(s\) were logged after this backup/.test(p3.notes.join(' ')), p3.notes.join(' '));
  },
);

// ---------------------------------------------------------------- T5 replace removed counts
t('T5 replace removed count: parent without children, id-less lists, nested object keys', () => {
  const c = util();
  const b = { buildings: [{ id: 'b1', name: 'Main', meters: [{ id: 'm1', bills: [{ id: 'r1' }] }] }] };
  const r = checkInvariants(U, c, b, 'replace', 'T5 util');
  assert.strictEqual(r.removed, 6); // r2; m2+r3; b2+m9+m8
  const only = checkInvariants(
    U,
    { buildings: [{ id: 'b1' }, { id: 'b2', meters: [{ id: 'm9' }, { id: 'm8' }] }] },
    { buildings: [{ id: 'b1' }] },
    'replace',
    'T5 nobills',
  );
  assert.strictEqual(only.removed, 3);
  const pres = checkInvariants(
    'en_presented_savings',
    [
      { projectId: 1, periodStart: 'a', periodEnd: 'b' },
      { projectId: 1, periodStart: 'c', periodEnd: 'd' },
    ],
    [{ projectId: 1, periodStart: 'a', periodEnd: 'b' }],
    'replace',
    'T5 presented',
  );
  assert.strictEqual(pres.changed, false); // frozen: never dropped
  const log = checkInvariants(
    'en_utility_audit_log',
    [
      { ts: '1', action: 'a' },
      { ts: '2', action: 'b' },
      { ts: '3', action: 'c' },
    ],
    [{ ts: '1', action: 'a' }],
    'replace',
    'T5 audit',
  );
  assert.strictEqual(log.removed, 2);
  const al = checkInvariants(
    'en_alarms_1',
    { rows: [{ sNo: 1 }, { sNo: 2 }, { sNo: 3 }], importedAt: 'x' },
    { rows: [{ sNo: 1 }], importedAt: 'y' },
    'replace',
    'T5 alarms',
  );
  assert.strictEqual(al.removed, 2);
  const eq = checkInvariants(
    'en_eqmatrix_5',
    { rows: [{ id: 'A||x', points: { p: 1 } }, { id: 'B||y' }], buildings: ['A', 'B'] },
    { rows: [{ id: 'A||x' }], buildings: ['A'] },
    'replace',
    'T5 eq',
  );
  assert.strictEqual(eq.removed, 3); // row B||y, points object of A||x, 1 building name
  const map = checkInvariants('en_pricing_catalog', { A: { n: 1 }, B: { n: 2 } }, { A: { n: 1 } }, 'replace', 'T5 map');
  assert.strictEqual(map.removed, 1);
  const cfg = checkInvariants('en_pricing_config', { a: 1 }, {}, 'replace', 'T5 empty');
  assert.strictEqual(cfg.changed, false);
  const empty = checkInvariants('en_tasks', [{ id: 1 }, { id: 2 }], [], 'replace', 'T5 empty list');
  assert.strictEqual(empty.changed, false);
  const dc = checkInvariants(
    'en_dc_events',
    {
      events: [
        { date: 'a', name: 'n', type: 't' },
        { date: 'b', name: 'n', type: 't' },
      ],
    },
    { events: [{ date: 'a', name: 'n', type: 't' }] },
    'replace',
    'T5 dc',
  );
  assert.strictEqual(dc.removed, 1);
  const cm = checkInvariants(
    'en_eqmatrix_cmaps_7',
    [{ rawName: 'A' }, { rawName: 'B' }],
    [{ rawName: 'A' }],
    'replace',
    'T5 cmaps',
  );
  assert.strictEqual(cm.removed, 1);
});

// ---------------------------------------------------------------- T6 presented savings frozen
t('T6 en_presented_savings: add adds a missing period; merge and replace never change or drop a record', () => {
  const c = [
    { projectId: 1, periodStart: '2026-01', periodEnd: '2026-03', dollars: 9056, buildings: { b1: { dollars: 1 } } },
  ];
  const b = [
    { projectId: 1, periodStart: '2026-01', periodEnd: '2026-03', dollars: 1, buildings: {} },
    { projectId: 1, periodStart: '2026-04', periodEnd: '2026-06', dollars: 2 },
  ];
  for (const mode of MODES) {
    const r = checkInvariants('en_presented_savings', c, b, mode, 'T6 ' + mode);
    assert.deepStrictEqual(r.value[0], c[0]);
    assert.strictEqual(r.value.length, 2);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.added, 1);
    const drop = checkInvariants('en_presented_savings', c, [], mode, 'T6 drop ' + mode);
    assert.strictEqual(drop.changed, false);
  }
});

// ---------------------------------------------------------------- T7 representation
t('T7 stringified JSON keeps its representation; scalars never change type', () => {
  const s1 = checkInvariants('bldgperf_cfg_b1', undefined, '{"cscPct":0}', 'add', 'T7 absent string');
  assert.strictEqual(s1.value, '{"cscPct":0}');
  const o1 = checkInvariants(
    'bldgperf_cfg_b1',
    { cscPct: 1 },
    '{"cscPct":0,"x":1}',
    'replace',
    'T7 object stays object',
  );
  assert.deepStrictEqual(o1.value, { cscPct: 0, x: 1 });
  const s2 = checkInvariants(
    'bldgperf_cfg_b1',
    '{"cscPct":1}',
    { cscPct: 0, x: 1 },
    'replace',
    'T7 string stays string',
  );
  assert.strictEqual(s2.value, '{"cscPct":0,"x":1}');
  const leadsStr = checkInvariants(
    'ems_leads_v1',
    J([{ id: 'l1' }]),
    [{ id: 'l1' }, { id: 'l2' }],
    'add',
    'T7 leads string',
  );
  assert.strictEqual(typeof leadsStr.value, 'string');
  assert.deepStrictEqual(JSON.parse(leadsStr.value), [{ id: 'l1' }, { id: 'l2' }]);
  const leadsArr = checkInvariants(
    'ems_leads_v1',
    [{ id: 'l1' }],
    J([{ id: 'l1' }, { id: 'l2' }]),
    'add',
    'T7 leads array',
  );
  assert.ok(Array.isArray(leadsArr.value));
  const flag = checkInvariants('en_utility_dates_migrated_v1', '1', 1, 'replace', 'T7 flag never');
  assert.strictEqual(flag.changed, false);
  const zoom = checkInvariants('en_perf_zoom', '1.25', 1.5, 'replace', 'T7 zoom');
  assert.strictEqual(zoom.value, '1.5');
  const str = checkInvariants('ch_theme', 'dark', 'light', 'replace', 'T7 theme');
  assert.strictEqual(str.value, 'light');
});

// ---------------------------------------------------------------- T8 derived caches
t('T8 derived meter caches are stripped and ignored; a no-op restore shows 0 changes', () => {
  const c = util();
  const b = clone(c);
  RM.METER_CACHE_FIELDS.forEach((f) => (b.buildings[0].meters[0][f] = { stale: true }));
  for (const mode of ['add', 'merge']) {
    const r = checkInvariants(U, c, b, mode, 'T8 ' + mode);
    assert.strictEqual(r.changed, false);
  }
  const b2 = clone(b);
  b2.buildings[0].meters.push({ id: 'm7', label: 'New', _savingsCache: 1, _reg: 2, bills: [{ id: 'r9' }] });
  const r2 = checkInvariants(U, c, b2, 'add', 'T8 new meter');
  const m7 = r2.value.buildings[0].meters.find((m) => m.id === 'm7');
  assert.ok(m7 && !('_savingsCache' in m7) && !('_reg' in m7));
  const abs = checkInvariants(U, undefined, b2, 'add', 'T8 absent');
  assert.ok(!('_savingsCache' in abs.value.buildings[0].meters[0]));
  const rep = checkInvariants(U, c, b2, 'replace', 'T8 replace');
  assert.ok(!('_savingsCache' in rep.value.buildings[0].meters[0]));
});

// ---------------------------------------------------------------- T9 numeric strings
t('T9 numeric string vs number bill fields are not a difference; current type kept', () => {
  const c = util();
  const b = clone(c);
  b.buildings[0].meters[0].bills[0].kwh = 100;
  b.buildings[0].meters[0].bills[1].kwh = '120';
  for (const mode of ['add', 'merge']) {
    const r = checkInvariants(U, c, b, mode, 'T9 ' + mode);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.value.buildings[0].meters[0].bills[0].kwh, '100');
  }
  const fillNum = checkInvariants(U, c, b, 'merge', 'T9 fill');
  assert.strictEqual(fillNum.value.buildings[0].meters[0].bills[1].cost, '');
  b.buildings[0].meters[0].bills[1].cost = '7';
  const f2 = checkInvariants(U, c, b, 'merge', 'T9 fill2');
  assert.strictEqual(f2.value.buildings[0].meters[0].bills[1].cost, '7'); // blank filled
  assert.strictEqual(f2.updated, 1);
});

// ---------------------------------------------------------------- T10 cross-key
t('T10 cross-key: dependencies name the owner key; added building outside project scope is listed', () => {
  const backup = {
    en_customers: [{ id: 'cust_1', name: 'C' }],
    en_projects: proj(),
    en_utility_cust_cust_1: util(),
    en_budget_1779664753271: { a: 1 },
    en_tasks: [{ id: 1 }],
  };
  const none = () => undefined;
  assert.strictEqual(RM.dependsOn('en_utility_cust_cust_1', backup, none), 'en_customers');
  assert.strictEqual(RM.dependsOn('en_budget_1779664753271', backup, none), 'en_projects');
  assert.strictEqual(RM.dependsOn('en_tasks', backup, none), null);
  // owner already present in current: no dependency
  const has = (k) => (k === 'en_customers' ? [{ id: 'cust_1' }] : k === 'en_projects' ? proj() : undefined);
  assert.strictEqual(RM.dependsOn('en_utility_cust_cust_1', backup, has), null);
  assert.strictEqual(RM.dependsOn('en_budget_1779664753271', backup, has), null);
  // building added to the blob that no project scope lists
  const curUtil = util();
  const bakUtil = util();
  bakUtil.buildings.push({ id: 'b3', name: 'Orphan', meters: [] });
  const p = RM.plan(
    { en_utility_cust_cust_1: bakUtil },
    (k) => (k === 'en_utility_cust_cust_1' ? curUtil : k === 'en_projects' ? proj() : undefined),
    'add',
  );
  assert.ok(/1 added building\(s\) are not in any project scope: Orphan/.test(p.notes.join(' ')), p.notes.join(' '));
  const inScope = clone(proj());
  inScope[0].scope.buildingIds.push('b3');
  const p2 = RM.plan(
    { en_utility_cust_cust_1: bakUtil },
    (k) => (k === 'en_utility_cust_cust_1' ? curUtil : k === 'en_projects' ? inScope : undefined),
    'add',
  );
  assert.strictEqual(p2.notes.length, 0);
});

// ---------------------------------------------------------------- T11 equipment matrix
t('T11 equipment matrix: renamed row does not duplicate; re-imports never mix; totals unchanged', () => {
  const c = {
    rows: [{ id: 'A||new name', points: { p: 1 } }],
    importedAt: '2026-09-01',
    buildings: ['A'],
    totalBASPoints: 5,
  };
  const b = {
    rows: [{ id: 'A||old name', points: { p: 1 } }, { id: 'B||x' }],
    importedAt: '2026-08-01',
    buildings: ['A', 'B'],
    totalBASPoints: 9,
  };
  for (const mode of ['add', 'merge']) {
    const r = checkInvariants('en_eqmatrix_1779664753271', c, b, mode, 'T11 ' + mode);
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual(r.value, c);
  }
  const abs = checkInvariants('en_eqmatrix_1779664753271', undefined, b, 'add', 'T11 absent');
  assert.deepStrictEqual(abs.value, b);
  const rep = checkInvariants('en_eqmatrix_1779664753271', c, b, 'replace', 'T11 replace');
  assert.deepStrictEqual(rep.value, b);
  assert.strictEqual(rep.removed, 1); // row A||new name (a dropped record counts once)
});

// ---------------------------------------------------------------- T12 never-restore keys
t('T12 never-restore keys untouched in all modes; per-user key added only when absent', () => {
  const never = [
    'ch_user',
    'ch_seen_version',
    'ch_idb_migrated',
    'ch_verification_results',
    'ch_notifs',
    'en_utility_dates_migrated_v1',
    'en_utility_rates_backfilled_v2',
    '_claude_bill_dump',
    '_debug_propane_bills',
    'en_sewer_backfill_report_v1',
    'en_utility_null',
    'en_wdd_90001',
    'ch_backend_mode',
    '_companyHubBackup',
  ];
  for (const k of never) {
    for (const mode of MODES) {
      const r = checkInvariants(k, { a: 1 }, { a: 2 }, mode, 'T12 ' + k + ' ' + mode);
      assert.strictEqual(r.changed, false);
      assert.strictEqual(r.policy, 'never');
      const abs = checkInvariants(k, undefined, { a: 2 }, mode, 'T12 absent ' + k);
      assert.strictEqual(abs.changed, false);
    }
  }
  // legacy en_utility_<pid>: never when the backup has live customer keys; live data in old backups
  assert.strictEqual(
    RM.policyFor('en_utility_1779664753271', ['en_utility_1779664753271', 'en_utility_cust_c1']).kind,
    'never',
  );
  assert.strictEqual(
    RM.policyFor('en_utility_1779664753271', ['en_utility_1779664753271', 'en_projects']).kind,
    'records',
  );
  const p = RM.plan(
    { en_utility_1779664753271: util(), en_utility_cust_c1: util(), ch_user: { a: 1 } },
    () => undefined,
    'add',
  );
  assert.deepStrictEqual(p.skipped.map((s) => s.key).sort(), ['ch_user', 'en_utility_1779664753271']);
  assert.ok(p.skipped.every((s) => s.why));
  // per-user prefs: only when absent
  for (const k of ['ch_lastProjTab_1', 'ch_settings', 'bills_view_state_m1', 'en_bills_zoom_m1', 'ch_tbl_x']) {
    for (const mode of ['add', 'merge']) {
      assert.strictEqual(checkInvariants(k, { a: 1 }, { a: 2 }, mode, 'T12 user ' + k).changed, false);
      assert.strictEqual(checkInvariants(k, undefined, { a: 2 }, mode, 'T12 user absent ' + k).changed, true);
    }
  }
});

// ---------------------------------------------------------------- T13 per-user namespace (plan level; e2e checks the wire key)
t('T13 per-user backup keys: add fills only absent keys, existing per-user values stay', () => {
  const backup = { ch_lastProjTab_1: 'summary', ch_settings: { a: 1 }, ch_user: { name: 'Owner' } };
  const p = RM.plan(backup, (k) => (k === 'ch_settings' ? { a: 9 } : undefined), 'merge');
  assert.deepStrictEqual(
    p.items.filter((i) => i.changed).map((i) => i.key),
    ['ch_lastProjTab_1'],
  );
  assert.deepStrictEqual(
    p.skipped.map((s) => s.key),
    ['ch_user'],
  );
});

// ---------------------------------------------------------------- T15 size
t('T15 size: a 9.5 MB eqmatrix-shaped key and a 23 MB plan run under 5 s', () => {
  const rows = [];
  for (let i = 0; i < 2700; i++) {
    const points = {};
    for (let j = 0; j < 40; j++)
      points['Point name number ' + j + ' with a long label'] = { v: j, raw: 'x'.repeat(40) };
    rows.push({
      id: 'Building ' + (i % 30) + '||Equipment ' + i,
      building: 'Building ' + (i % 30),
      points,
      checks: { c1: true },
      editedAt: null,
    });
  }
  const eq = { rows, importedAt: 'x', buildings: [], totalBASPoints: 1 };
  const size = J(eq).length;
  assert.ok(size > 9e6, 'fixture is ' + size + ' bytes');
  const cur = clone(eq);
  cur.rows[5].editedAt = 'y';
  let t0 = Date.now();
  const r = mv('en_eqmatrix_1', cur, eq, 'replace');
  assert.ok(r.changed && r.removed === 0);
  const backup = { en_eqmatrix_1: eq, en_eqmatrix_2: eq, en_utility_cust_1: util() };
  const current = { en_eqmatrix_1: cur, en_eqmatrix_2: cur, en_utility_cust_1: util() };
  const p = RM.plan(backup, (k) => current[k], 'merge');
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  assert.ok(p.items.every((i) => !i.changed));
  console.log('  T15 ' + Math.round(size / 1e6) + ' MB key x2 plan in ' + ms + ' ms');
});

// ---------------------------------------------------------------- T16 idempotence
t('T16 idempotence: Add or Merge applied twice changes nothing the second time', () => {
  const cases = [
    [
      U,
      util(),
      (() => {
        const b = util();
        b.buildings[0].meters[0].bills.push({ id: 'r9', kwh: 1, _flags: [] });
        b.buildings[0].meters[1]._savingsCache = 1;
        b.buildings[0].meters[1].label = '';
        return b;
      })(),
    ],
    [
      'en_projects',
      proj(),
      (() => {
        const b = proj();
        b[0].note = 'filled';
        b.push({ id: 2, name: 'P2', hvacLoadEst: { m: [1, 2] } });
        return b;
      })(),
    ],
    ['en_pricing_catalog', { A: { net: 1 } }, { A: { net: 2, list: 3 }, B: { net: 4 } }],
    [
      'en_dc_events',
      { events: [{ date: 'a', name: 'n', type: 't' }] },
      { events: [{ date: 'b', name: 'n', type: 't' }] },
    ],
    [
      'en_utility_audit_log',
      [{ ts: '2', action: 'b' }],
      [
        { ts: '1', action: 'a' },
        { ts: '2', action: 'b' },
      ],
    ],
    [
      'ems_leads_v1',
      J([{ id: 'l1', updatedAt: '1', _origIdx: 0 }]),
      J([
        { id: 'l1', updatedAt: '2', _origIdx: 0 },
        { id: 'l2', _origIdx: 1 },
      ]),
    ],
    ['en_alarms_1', { rows: [{ sNo: 1 }] }, { rows: [{ sNo: 1 }, { sNo: 2 }] }],
  ];
  for (const [key, c, b] of cases) {
    for (const mode of ['add', 'merge']) {
      const r1 = checkInvariants(key, c, b, mode, 'T16 ' + key + ' ' + mode);
      const r2 = checkInvariants(key, r1.value, b, mode, 'T16 again ' + key + ' ' + mode);
      assert.strictEqual(r2.changed, false, 'T16 second run changed ' + key + ' ' + mode);
    }
  }
});

// ---------------------------------------------------------------- T17 id types
t('T17 id 1 and "1" match; the current record keeps its own id type', () => {
  const a = checkInvariants(
    'en_projects',
    [{ id: 1, name: 'a', note: '' }],
    [
      { id: '1', name: 'z', note: 'n' },
      { id: '2', name: 'c' },
    ],
    'add',
    'T17 add',
  );
  assert.deepStrictEqual(a.value, [
    { id: 1, name: 'a', note: '' },
    { id: '2', name: 'c' },
  ]);
  const m = checkInvariants(
    'en_projects',
    [{ id: 1, name: 'a', note: '' }],
    [{ id: '1', name: 'z', note: 'n' }],
    'merge',
    'T17 merge',
  );
  assert.deepStrictEqual(m.value, [{ id: 1, name: 'a', note: 'n' }]);
  const r = checkInvariants('en_tasks', [{ id: 1 }, { id: 2 }], [{ id: '1' }], 'replace', 'T17 replace');
  assert.strictEqual(r.removed, 1);
  const dup = checkInvariants(
    'en_tasks',
    [
      { id: 1, t: 'a' },
      { id: '1', t: 'b' },
    ],
    [{ id: 1, t: 'z', n: 1 }],
    'merge',
    'T17 current dup',
  );
  assert.strictEqual(dup.changed, false); // current duplicates are left untouched
});

// ---------------------------------------------------------------- T18 order
t('T18 order: audit log stays chronological; leads keep _origIdx order after Add', () => {
  const log = checkInvariants(
    'en_utility_audit_log',
    [
      { ts: '2026-02', action: 'edit' },
      { ts: '2026-04', action: 'delete' },
    ],
    [
      { ts: '2026-03', action: 'add' },
      { ts: '2026-01', action: 'add' },
    ],
    'add',
    'T18 audit',
  );
  assert.deepStrictEqual(
    log.value.map((e) => e.ts),
    ['2026-01', '2026-02', '2026-03', '2026-04'],
  );
  const leads = checkInvariants(
    'ems_leads_v1',
    [
      { id: 'l2', _origIdx: 2 },
      { id: 'l4', _origIdx: 4 },
    ],
    [
      { id: 'l3', _origIdx: 3 },
      { id: 'l1', _origIdx: 1 },
    ],
    'add',
    'T18 leads',
  );
  assert.deepStrictEqual(
    leads.value.map((l) => l._origIdx),
    [1, 2, 3, 4],
  );
  const newer = checkInvariants(
    'ems_leads_v1',
    [{ id: 'l1', updatedAt: '2026-01-01', n: 'old' }],
    [{ id: 'l1', updatedAt: '2026-02-01', n: 'new' }],
    'merge',
    'T18 newer',
  );
  assert.strictEqual(newer.value[0].n, 'new');
  const older = checkInvariants(
    'ems_leads_v1',
    [{ id: 'l1', updatedAt: '2026-03-01', n: 'cur' }],
    [{ id: 'l1', updatedAt: '2026-02-01', n: 'old' }],
    'merge',
    'T18 older',
  );
  assert.strictEqual(older.value[0].n, 'cur');
});

// ---------------------------------------------------------------- review-1 / review-2 probes kept as explicit cases
t('R1/R2 probes: current-only fields survive; empty backup never blanks; nested shapes', () => {
  const c = {
    buildings: [
      {
        id: 'b1',
        name: 'X',
        cfg: { a: 1 },
        extra: 'e',
        meters: [
          {
            id: 'm1',
            label: 'L',
            keep: 7,
            bills: [
              { id: 'bi1', amt: 5, note: 'n' },
              { id: 'bi2', amt: 6 },
            ],
          },
          { id: 'm2', bills: [] },
        ],
      },
      { id: 'b2', meters: [] },
    ],
    topField: 9,
  };
  const b = {
    buildings: [
      {
        id: 'b1',
        name: 'Y',
        meters: [
          {
            id: 'm1',
            bills: [
              { id: 'bi1', amt: 50 },
              { id: 'bi3', amt: 1 },
            ],
          },
          { id: 'm3', bills: [{ id: 'x' }] },
        ],
      },
    ],
  };
  for (const key of ['en_utility_cust_55', 'en_utility_123']) {
    for (const mode of ['add', 'merge']) {
      const v = checkInvariants(key, c, b, mode, 'probe ' + key + ' ' + mode).value;
      const b1 = v.buildings.find((x) => x.id === 'b1');
      assert.deepStrictEqual(b1.cfg, { a: 1 });
      assert.strictEqual(b1.name, 'X'); // merge is fill-only: a filled name never changes
      assert.strictEqual(b1.meters[0].label, 'L');
      assert.strictEqual(b1.meters[0].bills[0].amt, 5);
      assert.ok(b1.meters[0].bills.find((x) => x.id === 'bi3') && b1.meters.find((x) => x.id === 'm3'));
      assert.ok(v.buildings.find((x) => x.id === 'b2') && b1.meters.find((x) => x.id === 'm2'));
      assert.strictEqual(v.topField, 9);
    }
  }
  const blank = checkInvariants(
    'en_tasks',
    [{ id: 1, t: 'keep', n: 5 }],
    [{ id: 1, t: '', n: null }],
    'merge',
    'probe blank',
  );
  assert.strictEqual(blank.changed, false);
  const nochild = checkInvariants(
    U,
    { buildings: [{ id: 'b', meters: [{ id: 'm' }] }] },
    { buildings: [{ id: 'b', meters: null }] },
    'merge',
    'probe nochild',
  );
  assert.strictEqual(nochild.changed, false);
  const ev = checkInvariants(
    'en_dc_events',
    { events: [{ date: '2026-01-01', name: 'A', type: 'x' }] },
    {
      events: [
        { date: '2026-02-02' },
        { date: '2026-02-02', note: 'two' },
        { date: '2026-01-01', name: 'A', type: 'x' },
      ],
    },
    'add',
    'probe dc',
  );
  assert.strictEqual(ev.value.events.length, 3);
  const cm = checkInvariants(
    'en_eqmatrix_cmaps_77',
    [{ rawName: 'A', m: 1, cur: 2 }, { rawName: 'B' }],
    [{ rawName: 'A', m: 5, extra: 1 }],
    'merge',
    'probe cmaps',
  );
  assert.deepStrictEqual(cm.value, [{ rawName: 'A', m: 1, cur: 2, extra: 1 }, { rawName: 'B' }]);
  const plan = RM.plan(
    { en_tasks: [{ id: 3 }], ch_backend_mode: 'on', ch_sync_queue: [], _companyHubBackup: true },
    () => undefined,
    'add',
  );
  assert.deepStrictEqual(
    plan.items.map((i) => i.key),
    ['en_tasks'],
  );
  assert.deepStrictEqual(plan.skipped.map((s) => s.key).sort(), [
    '_companyHubBackup',
    'ch_backend_mode',
    'ch_sync_queue',
  ]);
  assert.ok(RM.plan({ ch_seen_version: 'v2026.09.30.53' }, () => undefined, 'add').backupVersion === 'v2026.09.30.53');
});

// ---------------------------------------------------------------- property tests (seeded, synthetic)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function genFields(r, nextId) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const o = {};
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const k = pick(['name', 'note', 'cfg', 'n', 'kwh', 'tags', 'months', 'date', 'type']);
    const x = r();
    if (x < 0.35) o[k] = pick([0, 1, 2.5, 'x', '', null, true, '12', 12]);
    else if (x < 0.6) o[k] = [pick([1, 'a']), pick([2, 'b', ''])].slice(0, Math.floor(r() * 3));
    else if (x < 0.85) o[k] = r() < 0.5 ? {} : { a: pick([1, '', null]), b: { c: r() < 0.5 ? 1 : [] } };
    else o[k] = [{ x: 1 }, { y: '' }].slice(0, Math.floor(r() * 3));
  }
  return o;
}
function genList(r, pol, level, nextId) {
  const n = Math.floor(r() * 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const rec = genFields(r, nextId);
    if (r() < 0.9) {
      const id = nextId();
      rec.id = r() < 0.3 ? String(id) : id;
      rec.rawName = 'R' + id;
      rec.date = 'd' + id;
      rec.type = 't';
      rec.ts = String(id).padStart(4, '0');
      rec.action = 'a';
    }
    if (r() < 0.2) RM.METER_CACHE_FIELDS.forEach((f) => (rec[f] = { stale: 1 }));
    const child = pol.path[level];
    if (child && r() < 0.8) rec[child] = genList(r, pol, level + 1, nextId);
    out.push(rec);
  }
  if (out.length && r() < 0.1) out.push(clone(out[0])); // duplicate id in current
  return out;
}
function genValue(r, key, nextId) {
  const pol = RM.policyFor(key, [key]);
  if (pol.kind === 'key')
    return r() < 0.5 ? genFields(r, nextId) : { rows: genList(r, { path: [] }, 0, nextId), importedAt: 'x' };
  if (pol.kind === 'map') {
    const o = {};
    for (let i = Math.floor(r() * 4); i > 0; i--) o['SKU' + nextId()] = genFields(r, nextId);
    return o;
  }
  const l = genList(r, pol, pol.path.length ? 1 : 0, nextId);
  return pol.path.length ? Object.assign(genFields(r, nextId), { [pol.path[0]]: l }) : l;
}
// Backup derived from current: deletions, blanks, changes, additions, reorders, id-type flips.
function mutate(r, v, nextId, key) {
  if (r() < 0.08) return genValue(r, key, nextId);
  if (Array.isArray(v)) {
    let out = v.map((x) => (r() < 0.3 ? x : mutate(r, x, nextId, key)));
    out = out.filter(() => r() > 0.2);
    if (r() < 0.4) {
      const id = nextId();
      out.push(
        Object.assign(genFields(r, nextId), {
          id,
          rawName: 'R' + id,
          date: 'd' + id,
          type: 't',
          ts: String(id).padStart(4, '0'),
          action: 'a',
        }),
      );
    }
    if (r() < 0.3) out.reverse();
    if (r() < 0.2)
      out = out.map((x) => (isRec(x) && typeof x.id === 'number' ? Object.assign({}, x, { id: String(x.id) }) : x));
    if (r() < 0.1 && out.length) out.push(clone(out[0]));
    return out;
  }
  if (isRec(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      const y = r();
      if (['id', 'rawName', 'date', 'type', 'ts', 'action'].indexOf(k) !== -1) {
        out[k] = v[k];
        continue;
      }
      if (y < 0.15) continue;
      if (y < 0.3) out[k] = [null, '', [], {}][Math.floor(r() * 4)];
      else out[k] = mutate(r, v[k], nextId, key);
    }
    if (r() < 0.3) out['f' + Math.floor(r() * 3)] = [1, 'x', '', { a: 1 }, [1, 2]][Math.floor(r() * 5)];
    return out;
  }
  return r() < 0.5 ? v : [0, 1, 'x', 'z', '', null, true, '7', 7][Math.floor(r() * 9)];
}

const COUNTS = { add: 0, merge: 0, replace: 0 };
const KEYS = [
  'en_tasks',
  U,
  'en_dc_events',
  'en_eqmatrix_cmaps_1',
  'en_utility_audit_log',
  'en_presented_savings',
  'en_alarms_1',
  'en_pricing_catalog',
  'en_budget_1',
];
for (const key of KEYS) {
  for (const mode of MODES) {
    t('property / ' + key + ' / ' + mode + ' (seeded, 600 cases)', () => {
      const r = rng(mode.length * 1000 + key.length * 7);
      for (let i = 0; i < 600; i++) {
        let n = 0;
        const nextId = () => ++n;
        const c = r() < 0.05 ? undefined : genValue(r, key, nextId);
        const b =
          r() < 0.1 ? genValue(r, key, nextId) : mutate(r, c === undefined ? genValue(r, key, nextId) : c, nextId, key);
        const asText = r() < 0.15;
        checkInvariants(
          key,
          asText && c !== undefined ? J(c) : c,
          asText ? J(b) : b,
          mode,
          key + '/' + mode + ' case ' + i + ' cur=' + J(c) + ' bak=' + J(b),
        );
        COUNTS[mode]++;
      }
    });
  }
}
// Idempotence over the generated cases
t('property / idempotence over generated cases (add, merge)', () => {
  const r = rng(99);
  for (const key of KEYS) {
    for (let i = 0; i < 150; i++) {
      let n = 0;
      const nextId = () => ++n;
      const c = genValue(r, key, nextId);
      const b = mutate(r, c, nextId, key);
      for (const mode of ['add', 'merge']) {
        const r1 = mv(key, c, b, mode);
        const r2 = mv(key, r1.value, b, mode);
        assert.strictEqual(
          r2.changed,
          false,
          'idempotence ' +
            key +
            ' ' +
            mode +
            ' cur=' +
            J(c) +
            ' bak=' +
            J(b) +
            ' first=' +
            J(r1.value) +
            ' second=' +
            J(r2.value),
        );
      }
    }
  }
});
console.log('property cases: ' + J(COUNTS));
console.log('\n' + pass + ' tests passed');
