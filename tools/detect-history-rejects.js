#!/usr/bin/env node
/**
 * detect-history-rejects.js — the history plausibility rule (R7, app/energy-savings.js) over a CompanyHub
 * backup: for every saved value of every account, leave that value out and ask the rule whether it would
 * reject it. A saved bill is the best proof of a true value, so the answer must be 0.
 *
 * Usage: node tools/detect-history-rejects.js <CompanyHub-localdatafile.json> [--list]
 * Prints the age of the backup, the count of values checked per label and the rejects (with --list, each).
 * Read only; it writes nothing.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.log('usage: node tools/detect-history-rejects.js <CompanyHub-localdatafile.json> [--list]');
  process.exit(2);
}
const LIST = process.argv.includes('--list');
const root = path.join(__dirname, '..');
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', lib), 'utf8'), sandbox, { filename: lib });
// the day-parse functions billMonth needs (app/utility-data.js, loaded by source; the page module needs a DOM)
{
  const udSrc = fs.readFileSync(path.join(root, 'app', 'utility-data.js'), 'utf8');
  const fn = (name) => {
    const m = udSrc.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
    return m ? m[0].replace(/\r\n/g, '\n') : '';
  };
  vm.runInContext(fn('_fixISO') + fn('_parseISO') + fn('calcDays'), sandbox);
}
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'normalization.js'), 'utf8'), sandbox, { filename: 'normalization.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'rates.js'), 'utf8'), sandbox, { filename: 'rates.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8'), sandbox, { filename: 'energy-savings.js' });

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const utilityData = {};
for (const k of Object.keys(data)) {
  if (!/^en_utility_\d/.test(k)) continue;
  utilityData[k] = typeof data[k] === 'string' ? JSON.parse(data[k]) : data[k];
}
sandbox.utilityData = utilityData;
const ageDays = ((Date.now() - fs.statSync(file).mtimeMs) / 86400000).toFixed(1);
console.log('backup ' + path.basename(file) + ', age ' + ageDays + ' days');

const FIELDS = vm.runInContext('_LBG_HISTORY_FIELDS', sandbox);
const accountHistory = vm.runInContext('_lbg_accountHistory', sandbox);
const rejectReason = vm.runInContext('_lbg_historyRejectReason', sandbox);
const num = vm.runInContext('parseBillNumber', sandbox);

const bills = [];
for (const cust of Object.values(utilityData))
  for (const bl of cust.buildings || []) for (const m of bl.meters || []) for (const sb of m.bills || []) bills.push(sb);

const stats = {};
const rejects = [];
const accounts = new Set(bills.map((b) => b.accountNumber).filter(Boolean));
const seen = new Set();
for (const sb of bills) {
  if (!sb.accountNumber) continue;
  for (const [label, spec] of Object.entries(FIELDS)) {
    let v;
    let except;
    if (spec.statement) {
      if (!sb.billDate) continue;
      const key = sb.accountNumber + '|' + sb.billDate + '|' + label;
      if (seen.has(key)) continue;
      seen.add(key);
      v = bills
        .filter((o) => o.accountNumber === sb.accountNumber && o.billDate === sb.billDate)
        .reduce((s, o) => s + (num(o.totalCost) || 0), 0);
      except = (o) => o.accountNumber === sb.accountNumber && o.billDate === sb.billDate;
    } else if (spec.gasLine) {
      if (num(sb.gasCharge) == null) continue;
      v = num(sb.gasCharge) + (num(sb.customerCharge) || 0);
      except = (o) => o === sb;
    } else {
      v = num(sb[spec.key]);
      except = (o) => o === sb;
    }
    if (v == null || !isFinite(v) || v === 0) continue;
    stats[label] = stats[label] || { checked: 0, rejected: 0 };
    stats[label].checked++;
    const hist = accountHistory(sb.accountNumber, label, except);
    const why = rejectReason(hist, label, v);
    if (why) {
      stats[label].rejected++;
      rejects.push({ account: sb.accountNumber, label, value: v, period: (sb.start || '') + ' ' + (sb.end || ''), why, lo: Math.min(...hist.values), hi: Math.max(...hist.values), n: hist.values.length });
    }
  }
}
let checked = 0;
for (const [label, s] of Object.entries(stats)) {
  checked += s.checked;
  console.log('  ' + label.padEnd(20) + String(s.checked).padStart(6) + ' checked' + String(s.rejected).padStart(5) + ' rejected');
}
console.log('accounts ' + accounts.size + ', values checked ' + checked + ', would reject ' + rejects.length);
if (rejects.length && (LIST || rejects.length <= 30))
  for (const r of rejects)
    console.log('  REJECT ' + r.account + ' ' + r.label + ' ' + r.value + ' [' + r.period + '] normal range ' + r.lo + ' to ' + r.hi + ' (' + r.n + ' other values): ' + r.why);
