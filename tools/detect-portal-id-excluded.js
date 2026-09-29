// READ-ONLY detection for WP-07. Usage: node tools/detect-portal-id-excluded.js <backup-copy.json> <out.csv>
// Lists each project: id type (numeric ids were empty in the portal), excluded meters
// that still hold bills (were counted in the portal), and contract vs savings target.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const projects = d.en_projects || [];
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const rows = [['projectId', 'projectName', 'idType', 'hasSA', 'portalEnabled', 'contract', 'savingsTarget', 'metersTotal', 'metersExcluded', 'excludedWithBills', 'excludedBillCount', 'portalWasWrong']];
projects.forEach((p) => {
  const ud = d['en_utility_' + p.id] || { buildings: [] };
  const ex = (p.scope && p.scope.meterExcludeIds) || [];
  let total = 0, exMeters = 0, exWith = 0, exBills = 0;
  (ud.buildings || []).forEach((b) => (b.meters || []).forEach((m) => {
    total++;
    if (ex.includes(m.id)) {
      exMeters++;
      const n = (m.bills || []).length;
      if (n) { exWith++; exBills += n; }
    }
  }));
  const numeric = typeof p.id === 'number';
  rows.push([p.id, p.name, typeof p.id, !!p.sa, !!p.portalEnabled, p.contract || '', p.savings || '', total, exMeters, exWith, exBills, (numeric && !!p.sa) || exWith > 0 ? 'yes' : 'no']);
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('rows', rows.length - 1);
