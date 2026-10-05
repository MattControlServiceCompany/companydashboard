// tools/test-backup-strips-derived-caches.js — backlog 9914423a regression gate.
// Run: node tools/test-backup-strips-derived-caches.js
// DB.getAllForExport() and the kv-sync push body must never carry derived per-meter caches
// (_savingsCache/_savingsCacheKey/_savingsByYM/_reg/_unitSavByCalMo), even when getMeterSavings has
// re-stamped them onto the live meter objects held in DB's cache. User data must stay intact.
// Fails before the fix: DB.getAllForExport/stripDerivedCaches do not exist.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const DB = require('./load-db-for-test.js');
assert.ok(typeof DB.getAllForExport === 'function' && typeof DB.stripDerivedCaches === 'function', 'export strip API missing');

const meter = { id: 'm1', label: 'Gas', bills: [{ id: 'b1', cost: 5 }], costSavOverrides: { '2026-02': 364.6 },
  _savingsCache: { x: 1 }, _savingsCacheKey: 'k', _savingsByYM: { a: 1 }, _reg: { r2: 0.9 }, _unitSavByCalMo: { 1: 2 } };
const util = { buildings: [{ id: 'b', name: 'B', meters: [meter, { id: 'm2', bills: [] }] }], other: 7 };
const before = JSON.stringify(util);
const out = DB.stripDerivedCaches('en_utility_cust_123', util);
const s = JSON.stringify(out);
['_savingsCache', '_savingsCacheKey', '_savingsByYM', '_reg', '_unitSavByCalMo'].forEach((f) => assert.ok(!s.includes('"' + f + '"'), f + ' leaked'));
assert.strictEqual(JSON.stringify(util), before, 'live object must not be mutated');
const m = out.buildings[0].meters[0];
assert.deepStrictEqual(m.bills, meter.bills);
assert.deepStrictEqual(m.costSavOverrides, meter.costSavOverrides);
assert.strictEqual(out.other, 7);
// non-utility keys and JSON-string values pass through untouched
const other = { _reg: 1 };
assert.strictEqual(DB.stripDerivedCaches('en_projects', other), other);
// single source: restore-merge and utility-data take the list from DB, not their own copy
global.DB = DB;
assert.strictEqual(require('../app/restore-merge.js').METER_CACHE_FIELDS, DB.DERIVED_METER_FIELDS);
['app/utility-data.js', 'app/restore-merge.js'].forEach((f) =>
  assert.ok(!/delete m\._savingsCacheKey|'_savingsCacheKey'/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ' keeps its own field list')
);

// Conflict short-circuit and hash: a cache-only difference is not a conflict (strip both sides).
const a = { buildings: [{ meters: [{ id: 'm', bills: [1], _savingsCache: { s: 1 }, _reg: {} }] }] };
const b = { buildings: [{ meters: [{ id: 'm', bills: [1] }] }] };
assert.strictEqual(
  JSON.stringify(DB.stripDerivedCaches('en_utility_cust_9', a)),
  JSON.stringify(DB.stripDerivedCaches('en_utility_cust_9', b))
);
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'db.js'), 'utf8');
assert.ok(/JSON\.stringify\(stripDerivedCaches\(key, payload\.value\)\)\s*===\s*JSON\.stringify\(stripDerivedCaches\(key, current\.value\)\)/.test(dbSrc), 'short-circuit must compare stripped vs stripped');
assert.ok(/_canonicalJSON\(stripDerivedCaches\(localKey, origLocal\)\)/.test(dbSrc), 'pull-side local hash must be stripped');
assert.ok(/_canonicalJSON\(stripDerivedCaches\(key, payload\.value\)\)/.test(dbSrc), 'push-ack hash must be stripped');
console.log('PASS test-backup-strips-derived-caches');
