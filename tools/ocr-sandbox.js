// Shared loader for the OCR first-use tests: loads the real app/bill-analysis.js into a node vm sandbox.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
module.exports = function load(extra) {
  const sandbox = Object.assign(
    {
      window: {},
      document: { getElementById: () => null, addEventListener: () => {} },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      navigator: { userAgent: 'node' },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      requestAnimationFrame: () => 0,
      addEventListener: () => {},
      fetch: () => Promise.reject(new Error('no fetch')),
    },
    extra || {}
  );
  vm.createContext(sandbox);
  for (const p of ['lib/formatting.js', 'computations/rates.js', 'app/energy-savings.js', 'app/bill-analysis.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'), sandbox, { filename: path.basename(p) });
  }
  sandbox.get = (n) => vm.runInContext('typeof ' + n + ' !== "undefined" ? ' + n + ' : null', sandbox);
  return sandbox;
};
