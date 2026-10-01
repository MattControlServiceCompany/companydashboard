// Unit tests for app/restore-merge.js (synthetic fixtures only). Run: node test-restore-merge.js
const assert = require('assert');
const RM = require('./app/restore-merge.js');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('PASS ' + name);
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const ids = (list) => list.map((r) => r.id);

// Nothing from the current value may be missing from the result (ids / keys).
function assertNothingRemoved(cur, out) {
  if (Array.isArray(cur)) {
    cur.forEach((r) =>
      assert.ok(
        out.some((o) => o.id === r.id),
        'record removed: ' + r.id,
      ),
    );
  } else if (cur && typeof cur === 'object') {
    Object.keys(cur).forEach((k) => assert.ok(k in out, 'field removed: ' + k));
  }
}

const cur = [
  { id: 1, name: 'A-current' },
  { id: 2, name: 'B-current' },
];
const bak = [
  { id: 2, name: 'B-backup' },
  { id: 3, name: 'C-backup' },
];

for (const mode of ['add', 'merge', 'replace']) {
  t('list-with-id / ' + mode, () => {
    const before = clone(cur);
    const r = RM.mergeValue('en_tasks', cur, bak, mode);
    assert.deepStrictEqual(cur, before, 'input mutated');
    if (mode === 'add') {
      assert.deepStrictEqual(r.value, [cur[0], cur[1], bak[1]]);
      assert.deepStrictEqual([r.added, r.updated, r.kept], [1, 0, 1]);
    } else if (mode === 'merge') {
      assert.deepStrictEqual(r.value, [cur[0], bak[0], bak[1]]);
      assert.deepStrictEqual([r.added, r.updated, r.kept], [1, 1, 0]);
    } else {
      assert.deepStrictEqual(r.value, bak); // replace is the explicit overwrite
    }
    if (mode !== 'replace') assertNothingRemoved(cur, r.value);
  });
}

for (const mode of ['add', 'merge']) {
  t('map-by-id (pricing catalog) / ' + mode, () => {
    const c = { SKU1: { net: 1 }, SKU2: { net: 2 } };
    const b = { SKU2: { net: 99 }, SKU3: { net: 3 } };
    const r = RM.mergeValue('en_pricing_catalog', c, b, mode);
    assert.deepStrictEqual(Object.keys(r.value).sort(), ['SKU1', 'SKU2', 'SKU3']);
    assert.strictEqual(r.value.SKU2.net, mode === 'add' ? 2 : 99);
    assert.strictEqual(r.value.SKU3.net, 3);
    assertNothingRemoved(c, r.value);
  });
}

for (const mode of ['add', 'merge']) {
  t('nested utility buildings/meters/bills / ' + mode, () => {
    const c = { buildings: [{ id: 'b1', name: 'Cur', meters: [{ id: 'm1', bills: [{ id: 'x1', kwh: 1 }] }] }] };
    const b = {
      buildings: [
        {
          id: 'b1',
          name: 'Bak',
          meters: [
            {
              id: 'm1',
              bills: [
                { id: 'x1', kwh: 9 },
                { id: 'x2', kwh: 2 },
              ],
            },
            { id: 'm2', bills: [{ id: 'x3', kwh: 3 }] },
          ],
        },
        { id: 'b2', name: 'New', meters: [{ id: 'm3', bills: [{ id: 'x4' }] }] },
      ],
    };
    const r = RM.mergeValue('en_utility_proj1', c, b, mode);
    const bl = r.value.buildings;
    assert.deepStrictEqual(ids(bl), ['b1', 'b2']);
    assert.deepStrictEqual(ids(bl[0].meters), ['m1', 'm2']);
    assert.deepStrictEqual(ids(bl[0].meters[0].bills), ['x1', 'x2']);
    assert.strictEqual(bl[0].meters[0].bills[0].kwh, mode === 'add' ? 1 : 9);
    assert.strictEqual(r.added, 3); // x2, x3, x4 (leaf bills)
    assert.strictEqual(bl[0].name, mode === 'add' ? 'Cur' : 'Bak');
  });
}

for (const mode of ['add', 'merge']) {
  t('scalar-exists is kept / ' + mode, () => {
    const r = RM.mergeValue('en_pricing_config', { hourlyRate: 100 }, { hourlyRate: 5, extra: 1 }, mode);
    assert.deepStrictEqual(r.value, { hourlyRate: 100 });
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.kept, 1);
    const s = RM.mergeValue('ch_theme', 'dark', 'light', mode);
    assert.strictEqual(s.value, 'dark');
    assert.strictEqual(s.changed, false);
    const rows = RM.mergeValue('en_alarms_p1', { rows: [{ sNo: 1 }] }, { rows: [{ sNo: 2 }] }, mode);
    assert.strictEqual(rows.changed, false); // alarm rows have no id: kept
  });
}

for (const mode of ['add', 'merge', 'replace']) {
  t('absent key is written / ' + mode, () => {
    const r = RM.mergeValue('en_tasks', undefined, bak, mode);
    assert.deepStrictEqual(r.value, bak);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.added, 2);
    const e = RM.mergeValue('en_tasks', [], bak, mode);
    assert.deepStrictEqual(e.value, bak);
  });
}

for (const mode of ['add', 'merge']) {
  t('backup lacking records / empty backup removes nothing / ' + mode, () => {
    const r = RM.mergeValue('en_tasks', cur, [], mode);
    assert.deepStrictEqual(r.value, cur);
    assert.strictEqual(r.changed, false);
    const r2 = RM.mergeValue('en_tasks', cur, [{ id: 1, name: 'A-current' }], mode);
    assert.strictEqual(r2.changed, false);
    assert.deepStrictEqual(r2.value, cur);
  });
}

t('plan never touches keys absent from the backup and skips engine keys', () => {
  const store = { en_tasks: cur, only_here: { keep: 1 } };
  const p = RM.plan(
    { en_tasks: bak, ch_backend_mode: 'on', ch_sync_queue: [], _companyHubBackup: true },
    (k) => store[k],
    'add',
  );
  assert.deepStrictEqual(
    p.items.map((i) => i.key),
    ['en_tasks'],
  );
  assert.deepStrictEqual(p.skipped.sort(), ['_companyHubBackup', 'ch_backend_mode', 'ch_sync_queue']);
  assert.ok(!p.items.some((i) => i.key === 'only_here'));
});

t('JSON-text backup values are parsed before merge', () => {
  const r = RM.mergeValue('en_tasks', cur, JSON.stringify(bak), 'add');
  assert.deepStrictEqual(ids(r.value), [1, 2, 3]);
});

console.log('\n' + pass + ' tests passed');
