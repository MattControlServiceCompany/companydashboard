// tools/audit-test-sandbox.js - loads the REAL Facility Audit code beside the REAL Equipment Matrix into a
// Node vm sandbox. Used by test-audit-rules.js and test-audit-import.js. Fixtures stay SYNTHETIC.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

function loadAuditSandbox() {
  const store = {};
  const sandbox = {
    console: console,
    document: {
      addEventListener() {},
      getElementById() {
        return null;
      },
      querySelector() {
        return null;
      },
      createElement() {
        return { style: {}, classList: { add() {} } };
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    sget: (k, d) => (store[k] === undefined ? d : JSON.parse(store[k])),
    sset: (k, v) => {
      store[k] = JSON.stringify(v);
      return Promise.resolve();
    },
    DB: { isReady: () => true, get: (k, d) => (store[k] === undefined ? d : JSON.parse(store[k])) },
    getUDBldgs: () => [],
  };
  sandbox.window = sandbox;
  sandbox.__store = store;
  vm.createContext(sandbox);
  ['lib/formatting.js', 'app/equipment-matrix.js', 'computations/audit-rules.js', 'computations/audit-import.js', 'app/facility-audit.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

function makeCounter() {
  const c = { pass: 0, fail: 0, failures: [] };
  c.ok = (cond, label) => {
    if (cond) c.pass++;
    else {
      c.fail++;
      c.failures.push(label);
    }
  };
  c.eq = (a, b, label) => c.ok(JSON.stringify(a) === JSON.stringify(b), label + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  c.done = (name) => {
    console.log(name + ': ' + c.pass + ' passed, ' + c.fail + ' failed');
    c.failures.forEach((f) => console.log('  FAIL ' + f));
    process.exit(c.fail ? 1 : 0);
  };
  return c;
}

module.exports = { loadAuditSandbox, makeCounter, ROOT };
