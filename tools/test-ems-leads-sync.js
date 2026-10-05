/**
 * test-ems-leads-sync.js
 *
 * Acceptance test for Netlify blocker B3: EMS Leads must use the db.js sync layer.
 * SYNTHETIC data only. No browser, no network.
 *
 * Usage: node tools/test-ems-leads-sync.js   (env APP_ROOT=<checkout> to test another tree)
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

// 1. Classification
const SC = require(path.join(ROOT, 'app', 'sync-classification.js'));
['ems_leads_v1', 'ems_field_defs', 'ems_client_types'].forEach((k) =>
  ok(SC.classifyKey(k) === 'synced', 'classified synced: ' + k),
);

// 2. No raw localStorage on the EMS keys in either page
const stripMigrationOk = (file) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const raw =
    /localStorage\.(getItem|setItem|removeItem)\(\s*(EMS_KEY|EMS_FIELDS_KEY|EMS_CLIENT_TYPES_KEY|STORAGE_KEY|'ems_)/.test(
      src,
    );
  ok(!raw, file + ': no raw localStorage access to EMS keys');
  ok(/app\/ems-leads-store\.js/.test(src), file + ': loads app/ems-leads-store.js');
};
stripMigrationOk('energy-department.html');
stripMigrationOk('ems-leads.html');

// 3. Store behaviour
let Store;
try {
  Store = require(path.join(ROOT, 'app', 'ems-leads-store.js'));
} catch (e) {
  ok(false, 'app/ems-leads-store.js loads (' + e.message + ')');
  console.log(fails + ' failure(s)');
  process.exit(1);
}

function mk(rawInit, dbInit, fallback) {
  const raw = new Map(Object.entries(rawInit || {}).map(([k, v]) => [k, JSON.stringify(v)]));
  const cache = new Map(Object.entries(dbInit || {}));
  const writes = [];
  const ls = {
    getItem: (k) => (raw.has(k) ? raw.get(k) : null),
    removeItem: (k) => raw.delete(k),
    setItem: (k, v) => raw.set(k, v),
  };
  const db = {
    get: (k, fb) => (cache.has(k) ? cache.get(k) : fb !== undefined ? fb : null),
    set: (k, v) => {
      cache.set(k, JSON.parse(JSON.stringify(v)));
      writes.push(k);
      return Promise.resolve();
    },
    isFallback: () => !!fallback,
  };
  return { raw, cache, writes, ls, db, store: Store.create(db, ls) };
}
const L = (id, t) => ({ id, company: 'Co ' + id, updatedAt: t, createdAt: t });
const leads = [L('a', '2026-01-01T00:00:00Z'), L('b', '2026-02-01T00:00:00Z'), L('c', '2026-03-01T00:00:00Z')];

(async () => {
  // moved: raw only
  let t = mk({
    ems_leads_v1: leads,
    ems_field_defs: { labels: { city: 'Town' }, custom: [] },
    ems_client_types: ['X'],
  });
  let r = await t.store.migrateRawStorage();
  ok(
    r.ems_leads_v1 === 'moved' && t.cache.get('ems_leads_v1').length === 3,
    'raw-only leads moved into sync layer (3 of 3)',
  );
  ok(
    t.cache.get('ems_field_defs').labels.city === 'Town' && t.cache.get('ems_client_types')[0] === 'X',
    'field defs + client types moved',
  );
  ok(t.raw.size === 0, 'raw copies removed after move');
  ok(t.store.loadLeads().length === 3, 'loadLeads reads through DB');

  // second run is a no-op
  r = await t.store.migrateRawStorage();
  ok(t.cache.get('ems_leads_v1').length === 3 && r.ems_leads_v1 === 'none', 'second run is a no-op');

  // identical
  t = mk({ ems_leads_v1: leads }, { ems_leads_v1: leads });
  r = await t.store.migrateRawStorage();
  ok(
    r.ems_leads_v1 === 'identical' && !t.cache.has('en_conflict_archive') && t.raw.size === 0,
    'identical: no archive, raw removed',
  );

  // both, raw newer
  const sync2 = [L('a', '2026-01-01T00:00:00Z'), L('z', '2026-01-05T00:00:00Z')];
  t = mk({ ems_leads_v1: leads }, { ems_leads_v1: sync2 });
  r = await t.store.migrateRawStorage();
  let arch = t.cache.get('en_conflict_archive') || [];
  ok(r.ems_leads_v1 === 'kept-raw' && t.cache.get('ems_leads_v1').length === 3, 'both differ, raw newer: raw kept');
  ok(
    arch.length === 1 && arch[0].key === 'ems_leads_v1' && arch[0].losingValue.length === 2,
    'older sync-layer copy archived (2 leads)',
  );

  // both, sync newer
  const sync3 = [L('a', '2026-06-01T00:00:00Z'), L('z', '2026-06-05T00:00:00Z')];
  t = mk({ ems_leads_v1: leads }, { ems_leads_v1: sync3 });
  r = await t.store.migrateRawStorage();
  arch = t.cache.get('en_conflict_archive') || [];
  ok(r.ems_leads_v1 === 'kept-sync' && t.cache.get('ems_leads_v1').length === 2, 'both differ, sync newer: sync kept');
  ok(
    arch.length === 1 && arch[0].losingValue.length === 3 && t.raw.size === 0,
    'older raw copy archived (3 leads), raw removed',
  );

  // unreadable raw is never deleted
  t = mk({});
  t.raw.set('ems_leads_v1', '{not json');
  r = await t.store.migrateRawStorage();
  ok(r.ems_leads_v1 === 'unreadable' && t.raw.has('ems_leads_v1'), 'unreadable raw text left in place');

  // fallback mode: untouched
  t = mk({ ems_leads_v1: leads }, { ems_leads_v1: leads }, true);
  await t.store.migrateRawStorage();
  ok(t.raw.has('ems_leads_v1'), 'IndexedDB-fallback mode: localStorage copy not removed');

  // save writes through DB
  t = mk({}, {});
  await t.store.saveLeads(leads);
  await t.store.saveClientTypes(['A']);
  await t.store.saveFieldDefs({ labels: {}, custom: [] });
  ok(
    t.writes.join() === 'ems_leads_v1,ems_client_types,ems_field_defs' && t.raw.size === 0,
    'saves go through DB.set only',
  );

  console.log(fails ? fails + ' failure(s)' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
