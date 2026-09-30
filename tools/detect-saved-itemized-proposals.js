// WP-21 detection (READ-ONLY): lists SAVED reports (en_report_history) whose proposal pages hold
//   (a) an itemized line "N x $unit = $total" where N x unit != total, or
//   (b) a "$X per Month" allowance, and the project's stored budget denomination when it is not monthly
//       (an annual/quarterly budget printed the raw amount as "per Month" before WP-21).
// It never writes anything. Matt decides any correction (saved reports are never rewritten).
// Usage: node tools/detect-saved-itemized-proposals.js <backup.json> [out.csv]
// Backup shape: flat { "<storage key>": value, ... } (or under .data / .localStorage).
// Columns: kind,projectId,reportId,savedAt,reportType,itemizedLines,wrongLines,perMonthText,budgetDenomination,budgetAmount,reason
const fs = require('fs');
const backupPath = process.argv[2];
if (!backupPath) {
  console.error('usage: node tools/detect-saved-itemized-proposals.js <backup.json> [out.csv]');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const data = raw.data || raw.localStorage || raw;
const val = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
};
const q = (x) => '"' + String(x === undefined || x === null ? '' : x).replace(/"/g, '""') + '"';
const usd = (s) => Number(String(s).replace(/[$,]/g, ''));
const rows = [];
const budgets = {};
Object.keys(data).forEach((k) => {
  const m = /^en_pricing_budget_(.+)$/.exec(k);
  if (m) budgets[m[1]] = val(data[k]);
});

const history = val(data.en_report_history);
(Array.isArray(history) ? history : []).forEach((h) => {
  const html = String((h && h.html) || '');
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&times;|&#215;/g, '×')
    .replace(/&nbsp;/g, ' ');
  const re = /(\d+)\s*[×x]\s*(\$[\d,]+)\s*=\s*(\$[\d,]+)/g;
  let mm,
    lines = 0,
    wrong = 0;
  while ((mm = re.exec(text))) {
    lines++;
    if (Number(mm[1]) * usd(mm[2]) !== usd(mm[3])) wrong++;
  }
  const pm = /(\$[\d,]+)\s+per Month/.exec(text);
  const b = budgets[h && h.projectId];
  const badDenom = pm && b && b.denomination && b.denomination !== 'monthly';
  if (wrong > 0 || badDenom) {
    const why = [];
    if (wrong > 0) why.push(wrong + ' itemized line(s) where qty x unit != total');
    if (badDenom) why.push('allowance printed as per Month but the stored budget is ' + b.denomination);
    rows.push(
      [
        'saved-report',
        h.projectId,
        h.id,
        h.savedAt,
        h.type,
        lines,
        wrong,
        pm ? pm[1] + ' per Month' : '',
        b ? b.denomination : '',
        b ? b.amount : '',
        why.join('; '),
      ]
        .map(q)
        .join(','),
    );
  }
});
Object.keys(budgets).forEach((pid) => {
  const b = budgets[pid];
  if (b && b.denomination && b.denomination !== 'monthly' && Number(b.amount) > 0) {
    rows.push(
      [
        'stored-budget',
        pid,
        '',
        '',
        '',
        '',
        '',
        '',
        b.denomination,
        b.amount,
        'not a monthly budget; old code printed the raw amount as per Month',
      ]
        .map(q)
        .join(','),
    );
  }
});
const head =
  'kind,projectId,reportId,savedAt,reportType,itemizedLines,wrongLines,perMonthText,budgetDenomination,budgetAmount,reason';
const csv = [head].concat(rows).join('\n') + '\n';
if (process.argv[3]) fs.writeFileSync(process.argv[3], csv);
else process.stdout.write(csv);
console.error(rows.length + ' row(s); saved reports scanned: ' + (Array.isArray(history) ? history.length : 0));
