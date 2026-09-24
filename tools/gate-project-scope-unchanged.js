#!/usr/bin/env node
// tools/gate-project-scope-unchanged.js — gate test for the Customer/Multi-Project
// self-healing migration (app/utility-data.js: _selfHealCustomersAndScope).
//
// Loads the REAL on-disk app/utility-data.js into a Node vm sandbox (no
// reimplementation — same pattern as computations/rates.cascade.gate.js) with a
// synthetic, in-memory localStorage-shaped store standing in for 4 existing projects
// (never real customer data — synthetic fixtures only, per repo convention), runs the
// self-heal migration, and asserts:
//   1. For each of the 4 synthetic pre-existing projects, getUDBldgs(pid) after
//      migration returns the EXACT SAME set of building ids (same count, same
//      members, order-independent) as the project's own pre-migration blob had —
//      this is the automated version of the acceptance test's "all N buildings
//      unchanged" check, run against every project, not just one.
//   2. A synthetic NEW project with scope.buildingIds already scoped to one of two
//      buildings a customer has returns only that one building from getUDBldgs — the
//      "new project shows only its picked buildings" half of the design's item 3.
//   3. Running the self-heal a SECOND time (idempotency) does not change any
//      project's scope.buildingIds or duplicate any en_customers row.
//
// Spec: AI/_context/plans/2026-09-23-customer-multi-project-design.md, section 3,
// "BLOCKER A fix" point 7 ("Gate tests").
//
// Run:  node tools/gate-project-scope-unchanged.js
// Exits nonzero on any assertion failure.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');

function buildSandbox(store) {
  const sandbox = { console, TextEncoder, TextDecoder };
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};
  sandbox.document = {
    body: {
      contains: function () {
        return false;
      },
    },
  };
  vm.createContext(sandbox);
  const glue = `
    function sget(k, fb) {
      return Object.prototype.hasOwnProperty.call(__store, k) ? JSON.parse(JSON.stringify(__store[k])) : fb;
    }
    function sset(k, v) { __store[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); }
    var DB = { get: function(k, fb) { return sget(k, fb); }, set: function(k, v) { return sset(k, v); }, remove: function(k) { delete __store[k]; }, isReady: function() { return false; } };
    var showToast = function(){};
  `;
  sandbox.__store = store;
  vm.runInContext(glue, sandbox, { filename: 'glue.js' });
  // Load ONLY the real accessor/self-heal source — app/utility-data.js is a large
  // browser script with many optional (typeof-guarded) dependencies; the functions
  // this gate exercises (_selfHealCustomersAndScope, getUDBldgs/getUDProj/
  // getCustomerBuildings/isBaselineExcluded/setBaselineExcluded) depend only on
  // sget/sset, defined above.
  vm.runInContext(fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8'), sandbox, {
    filename: 'app/utility-data.js',
  });
  return sandbox;
}

// Synthetic fixture — 4 pre-existing projects, shaped like the real migration's
// invariant (each project 1:1-owns its own pre-migration en_utility_<projId> blob),
// but with NO real customer data (names/ids/addresses are all placeholders).
function mkBldg(id, meterIds) {
  return {
    id,
    name: 'Building ' + id,
    addr: '',
    sqft: 1000,
    meters: meterIds.map((mid, i) => ({
      id: mid,
      commodity: i % 2 === 0 ? 'Electric' : 'Gas',
      account: 'acct-' + mid,
      bills: [],
      baselineInclude: i === 0 ? false : undefined, // one pre-migration excluded meter per building
    })),
  };
}

function buildFixtureStore() {
  const projects = [
    { id: 1001, name: 'Synthetic Project A', client: 'Synthetic Client A', status: 'active' },
    { id: 1002, name: 'Synthetic Project B', client: 'Synthetic Client B', status: 'active' },
    { id: 1003, name: 'Synthetic Project C', client: 'Synthetic Client C', status: 'planning' },
    { id: 1004, name: 'Synthetic Project D', client: 'Synthetic Client D', status: 'planning' },
  ];
  const store = { en_projects: projects };
  // Project A: 3 buildings; Project B: 1 building; Project C: 2 buildings; Project D: 0 buildings.
  store['en_utility_1001'] = {
    buildings: [
      mkBldg('a-bldg-1', ['a-m1', 'a-m2']),
      mkBldg('a-bldg-2', ['a-m3']),
      mkBldg('a-bldg-3', ['a-m4', 'a-m5']),
    ],
  };
  store['en_utility_1002'] = { buildings: [mkBldg('b-bldg-1', ['b-m1'])] };
  store['en_utility_1003'] = { buildings: [mkBldg('c-bldg-1', ['c-m1']), mkBldg('c-bldg-2', ['c-m2'])] };
  store['en_utility_1004'] = { buildings: [] };
  return { store, projects };
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.error(
      'FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 20).join('\n      ') : e),
    );
  }
}

/* ═══════════════════════════════════════════════════════════════
   Check 1 — post-migration getUDBldgs(pid) matches pre-migration building-id set,
   for all 4 synthetic projects (not just one).
   ═══════════════════════════════════════════════════════════════ */
const { store, projects } = buildFixtureStore();
const preMigrationIds = {};
for (const p of projects) {
  const blob = store['en_utility_' + p.id];
  preMigrationIds[p.id] = (blob.buildings || []).map((b) => b.id).sort();
}

const sandbox = buildSandbox(store);
sandbox.__store.en_projects = JSON.parse(JSON.stringify(projects));
vm.runInContext('_selfHealCustomersAndScope();', sandbox, { filename: 'run-self-heal.js' });
// Mirror loadUtilityData()'s "load each customer's blob from its own key" loop — the
// self-heal migration only writes storage; the in-memory utilityData object is
// populated by loadUtilityData() on a real page load, which this harness doesn't run.
const LOAD_CUSTOMER_BLOBS =
  "utilityData = {}; (sget('en_customers', []) || []).forEach(function(c) { var d = sget('en_utility_' + c.id, null); if (d) utilityData[c.id] = d; });";
vm.runInContext(LOAD_CUSTOMER_BLOBS, sandbox, { filename: 'load-customer-blobs.js' });

// vm.runInContext returns values constructed in the SANDBOX realm — deepStrictEqual
// treats a cross-realm Array as unequal to a host-realm Array even with identical
// contents (different [[Prototype]]), so every value pulled out of the sandbox is
// round-tripped through JSON to get a plain host-realm value.
function fromSandbox(expr) {
  return JSON.parse(vm.runInContext('JSON.stringify(' + expr + ')', sandbox));
}

for (const p of projects) {
  check('project ' + p.id + ' (' + p.name + '): getUDBldgs returns the exact pre-migration building set', () => {
    const ids = fromSandbox('getUDBldgs(' + JSON.stringify(p.id) + ').map(function(b){return b.id;}).sort()');
    assert.deepStrictEqual(ids, preMigrationIds[p.id], 'building id set must match exactly, order-independent');
  });
}

check('every existing project got customerId + scope.buildingIds seeded (never left undefined)', () => {
  const healedProjects = sandbox.__store.en_projects;
  for (const p of healedProjects) {
    assert.ok(p.customerId, 'project ' + p.id + ' missing customerId');
    assert.ok(p.scope && Array.isArray(p.scope.buildingIds), 'project ' + p.id + ' missing scope.buildingIds');
  }
});

check('customerId is deterministic (cust_<projectId>) — two independent runs converge', () => {
  const { store: store2 } = buildFixtureStore();
  const sandbox2 = buildSandbox(store2);
  sandbox2.__store.en_projects = JSON.parse(JSON.stringify(projects));
  vm.runInContext('_selfHealCustomersAndScope();', sandbox2, { filename: 'run-self-heal-2.js' });
  for (const p of sandbox.__store.en_projects) {
    const p2 = sandbox2.__store.en_projects.find((x) => x.id === p.id);
    assert.strictEqual(p.customerId, p2.customerId, 'customerId diverged across independent runs for project ' + p.id);
  }
});

/* ═══════════════════════════════════════════════════════════════
   Check 2 — new project scoped to one of a customer's two buildings sees only that one.
   ═══════════════════════════════════════════════════════════════ */
check('a new project scoped to one of two customer buildings returns only that one building', () => {
  const custId = 'cust_synthetic_test';
  sandbox.__store['en_utility_' + custId] = {
    buildings: [mkBldg('bldg-X', ['mx1']), mkBldg('bldg-Y', ['my1'])],
  };
  // Load the new customer's blob into the in-memory utilityData object — mirrors
  // loadUtilityData()'s per-customer load loop (see LOAD_CUSTOMER_BLOBS above).
  vm.runInContext(
    'utilityData[' + JSON.stringify(custId) + "] = sget('en_utility_' + " + JSON.stringify(custId) + ', null);',
    sandbox,
  );
  sandbox.__store.en_projects = sandbox.__store.en_projects.concat([
    {
      id: 9999,
      name: 'New Synthetic Project',
      customerId: custId,
      scope: { buildingIds: ['bldg-X'], meterExcludeIds: [] },
    },
  ]);
  const ids = fromSandbox('getUDBldgs(9999).map(function(b){return b.id;})');
  assert.deepStrictEqual(ids, ['bldg-X'], 'scoped project must see ONLY bldg-X, not bldg-Y');
  const allIds = fromSandbox(
    'getCustomerBuildings(' + JSON.stringify(custId) + ').map(function(b){return b.id;}).sort()',
  );
  assert.deepStrictEqual(allIds, ['bldg-X', 'bldg-Y'], 'getCustomerBuildings must still see BOTH (unfiltered)');
});

/* ═══════════════════════════════════════════════════════════════
   Check 3 — idempotency: running self-heal a second time is a no-op.
   ═══════════════════════════════════════════════════════════════ */
check('running the self-heal a second time does not change scope or duplicate customers', () => {
  const before = JSON.stringify(sandbox.__store.en_projects.filter((p) => p.id < 2000));
  const beforeCustCount = (sandbox.__store.en_customers || []).length;
  vm.runInContext('_selfHealCustomersAndScope();', sandbox, { filename: 'run-self-heal-again.js' });
  const after = JSON.stringify(sandbox.__store.en_projects.filter((p) => p.id < 2000));
  assert.strictEqual(before, after, 'a second self-heal pass must be a no-op for already-healed projects');
  const afterCustCount = (sandbox.__store.en_customers || []).length;
  assert.strictEqual(beforeCustCount, afterCustCount, 'a second self-heal pass must not create duplicate customers');
});

if (failures > 0) {
  console.error('\ngate-project-scope-unchanged: FAILED — ' + failures + ' check(s) failed.');
  process.exitCode = 1;
} else {
  console.log('\ngate-project-scope-unchanged: PASSED — all checks passed.');
}
