// READ-ONLY detection for WP-02 (math-03 E-2, D2, D12). Usage: node tools/detect-csv-gas-imports.js <backup-copy.json> <out.csv>
// Lists saved gas bills that the old CSV gas mapping likely stored wrong. It never writes to the backup or to the app.
//   CCF_EQ_THERMS   naturalGasCCF is set and therms equals the raw CCF (the CCF x factor step was skipped).
//   THERMS_EQ_COST  therms equals the gas charge or the total cost (a cost column was read as usage).
//   MMBTU_EQ_THERMS naturalGasMMbtu is set and therms equals the raw MMBtu (the x10 step was skipped).
// Only Gas meters. The user decides any correction; this script changes nothing.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
if (!src || !out) {
  console.error('Usage: node tools/detect-csv-gas-imports.js <backup-copy.json> <out.csv>');
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const pf = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const same = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 1e-6);
const rows = [
  [
    'reason',
    'projectId',
    'projectName',
    'buildingName',
    'meterId',
    'billStart',
    'billEnd',
    'therms',
    'naturalGasTherms',
    'naturalGasCCF',
    'naturalGasMMbtu',
    'gasCharge',
    'totalCost',
  ],
];
const counts = {};
(d.en_projects || []).forEach((p) => {
  const ud = d['en_utility_' + p.id];
  if (!ud || !Array.isArray(ud.buildings)) return;
  ud.buildings.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.commodity !== 'Gas') return;
      (m.bills || []).forEach((bill) => {
        const therms = pf(bill.therms);
        const ccf = pf(bill.naturalGasCCF);
        const mmbtu = pf(bill.naturalGasMMbtu);
        const cost = pf(bill.gasCharge);
        const total = pf(bill.totalCost);
        const reasons = [];
        if (ccf > 0 && same(therms, ccf)) reasons.push('CCF_EQ_THERMS');
        if (therms > 0 && (same(therms, cost) || same(therms, total))) reasons.push('THERMS_EQ_COST');
        if (mmbtu > 0 && same(therms, mmbtu)) reasons.push('MMBTU_EQ_THERMS');
        reasons.forEach((r) => {
          counts[r] = (counts[r] || 0) + 1;
          rows.push([
            r,
            p.id,
            p.name,
            b.name,
            m.id,
            bill.start,
            bill.end,
            bill.therms,
            bill.naturalGasTherms,
            bill.naturalGasCCF,
            bill.naturalGasMMbtu,
            bill.gasCharge,
            bill.totalCost,
          ]);
        });
      });
    }),
  );
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('detect-csv-gas-imports: ' + (rows.length - 1) + ' row(s) ' + JSON.stringify(counts) + ' -> ' + out);
