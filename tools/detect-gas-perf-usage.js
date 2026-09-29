// READ-ONLY detection for WP-04 (math-02 H1). Usage: node tools/detect-gas-perf-usage.js <backup-copy.json> <out.csv>
// Lists gas bills that have no `therms` and no `usage` but do carry naturalGasTherms / naturalGasMMbtu /
// naturalGasCCF. The old Meter Performance table read those bills as 0 therms; getMeterSavings reads them
// with resolveGasUsageTherms. Only meters in projects with a Service Agreement (sa) can show savings.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const pf = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const projects = d.en_projects || [];
const rows = [
  [
    'projectId',
    'projectName',
    'projectHasSA',
    'buildingName',
    'meterId',
    'billStart',
    'billEnd',
    'therms',
    'usage',
    'naturalGasTherms',
    'naturalGasMMbtu',
    'naturalGasCCF',
    'resolvedTherms(new)',
    'perfTableRead(old)',
  ],
];
projects.forEach((p) => {
  const ud = d['en_utility_' + p.id];
  if (!ud || !Array.isArray(ud.buildings)) return;
  ud.buildings.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.commodity !== 'Gas') return;
      (m.bills || []).forEach((bill) => {
        if (pf(bill.therms) || pf(bill.usage)) return;
        const resolved = pf(bill.naturalGasTherms) || pf(bill.naturalGasMMbtu) * 10 || pf(bill.naturalGasCCF) * 1.037;
        if (!resolved) return;
        rows.push([
          p.id,
          p.name,
          !!p.sa,
          b.name,
          m.id,
          bill.start,
          bill.end,
          bill.therms ?? '',
          bill.usage ?? '',
          bill.naturalGasTherms ?? '',
          bill.naturalGasMMbtu ?? '',
          bill.naturalGasCCF ?? '',
          resolved,
          0,
        ]);
      });
    }),
  );
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('rows', rows.length - 1);
