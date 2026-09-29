// WP-22 detection (READ-ONLY): lists stored pricing config values that differ from, or freeze, the
// live code defaults. It never writes anything. Matt decides any correction.
// Usage: node tools/detect-frozen-pricing-config.js <backup.json> [out.csv]
// Backup shape: flat { "<storage key>": value, ... } (or under .data / .localStorage).
// Columns: storageKey,field,storedValue,liveDefault,reason
const fs = require('fs'),
  vm = require('vm'),
  path = require('path');
const backupPath = process.argv[2];
if (!backupPath) {
  console.error('usage: node tools/detect-frozen-pricing-config.js <backup.json> [out.csv]');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const data = raw.data || raw.localStorage || raw;
const val = (v) =>
  typeof v === 'string'
    ? (() => {
        try {
          return JSON.parse(v);
        } catch (e) {
          return v;
        }
      })()
    : v;

// Live defaults come straight from the code (the file is only evaluated, not modified).
const store = {};
const ctx = vm.createContext({
  console,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  parseFloat,
  parseInt,
  isNaN,
  Date,
  Set,
  Map,
  RegExp,
  document: {
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
    head: { appendChild() {} },
    body: {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  sget: (k, d) => (k in store ? store[k] : d),
  sset() {},
  showToast() {},
  setTimeout,
  clearTimeout,
  localStorage: { getItem: () => null, setItem() {} },
  navigator: {},
});
ctx.window = ctx;
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app/pricing-estimator.js'), 'utf8'), ctx);
const live = vm.runInContext('_pricingGetConfig()', ctx);

const rows = [];
const q = (x) =>
  '"' + String(x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : x).replace(/"/g, '""') + '"';
const add = (k, f, sv, ld, why) => rows.push([k, f, sv, ld, why].map(q).join(','));
Object.keys(data)
  .filter((k) => k === 'en_pricing_config' || /^en_pricing_config/.test(k))
  .forEach((k) => {
    const st = val(data[k]);
    if (!st || typeof st !== 'object') return;
    ['netMultiplier', 'hourlyRate', 'priceBasis', 'fanFraction'].forEach((f) => {
      if (f in st && st[f] !== live[f])
        add(
          k,
          f,
          st[f],
          live[f],
          f === 'hourlyRate' && st[f] === 173
            ? 'stored old default 173 (live default is ' + live[f] + ')'
            : 'stored value differs from live default (kept: user-saved value wins)',
        );
    });
    if ('contractPct' in st)
      add(
        k,
        'contractPct',
        st.contractPct,
        0.4,
        st.contractPct === 0.4
          ? 'no longer used (price is always 40% of list)'
          : 'stored value was never used for price; input removed',
      );
    ['perSequenceHours', 'installHoursByPoint'].forEach((t) => {
      const s = st[t];
      if (!s) return;
      Object.keys(live[t]).forEach((f) => {
        if (!(f in s)) add(k, t + '.' + f, '(missing)', live[t][f], 'missing key now reads live default');
      });
      Object.keys(s).forEach((f) => {
        if (f in live[t] && s[f] !== live[t][f])
          add(k, t + '.' + f, s[f], live[t][f], 'stored value differs from live default (kept)');
      });
    });
  });
const csv = 'storageKey,field,storedValue,liveDefault,reason\n' + rows.join('\n') + (rows.length ? '\n' : '');
const out = process.argv[3];
if (out) fs.writeFileSync(out, csv);
else process.stdout.write(csv);
console.error('rows: ' + rows.length);
