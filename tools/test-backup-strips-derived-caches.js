// tools/test-backup-strips-derived-caches.js — backlog 9914423a regression gate.
// Run: node tools/test-backup-strips-derived-caches.js
// DB.getAllForExport() and the kv-sync push body must never carry derived per-meter caches
// (_savingsCache/_savingsCacheKey/_savingsByYM/_reg/_unitSavByCalMo), even when getMeterSavings has
// re-stamped them onto the live meter objects held in DB's cache. User data must stay intact.
// Fails before the fix: DB.getAllForExport/stripDerivedCaches do not exist.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'db.js'), 'utf8');
const win = { addEventListener() {}, dispatchEvent() {}, location: { hostname: 'x' } };
const sandbox = {
  window: win, document: { addEventListener() {}, visibilityState: 'visible' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, CustomEvent: function () {}, Event: function () {}, navigator: {},
  indexedDB: undefined, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
const DB = sandbox.__DB;
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
// restore-merge must use the same field list
const RM = require('../app/restore-merge.js');
assert.deepStrictEqual([...RM.METER_CACHE_FIELDS].sort(), [...DB.DERIVED_METER_FIELDS].sort());
console.log('PASS test-backup-strips-derived-caches');
