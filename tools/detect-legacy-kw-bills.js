// READ-ONLY detection for WP-04 (math-02 H12, D6). Usage: node tools/detect-legacy-kw-bills.js <backup-copy.json> <out.csv>
// Lists electric bills with NO stored totalKwRate where the old $/kW rule and the new one give different numbers:
// bills that hold only the legacy kwCost + facKWCost (old rule returned the Facilities part only).
// Old rule = granular (demandCharge + tdcCharge + facilities) first, else legacy (kwCost + facilities).
// New rule = (demandCharge + tdcCharge, or kwCost) + facilities. Nothing is rewritten.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const pf = (v) => parseFloat(v) || 0;
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const fac = (b) => {
  let v = b.facilitiesCharge;
  if (v === undefined || v === null || v === '') v = b.facKWCost;
  return pf(v);
};
function oldRate(b) {
  if (pf(b.totalKwRate) > 0) return pf(b.totalKwRate);
  const kw = pf(b.billedKW) || pf(b.demandKW);
  if (!(kw > 0)) return 0;
  const g = pf(b.demandCharge) + pf(b.tdcCharge) + fac(b);
  if (g > 0) return g / kw;
  const l = pf(b.kwCost) + fac(b);
  return l > 0 ? l / kw : 0;
}
function newRate(b) {
  if (pf(b.totalKwRate) > 0) return pf(b.totalKwRate);
  const kw = pf(b.billedKW) || pf(b.demandKW) || pf(b.BilledKW) || pf(b.ActualKW) || pf(b.FacilitiesKW);
  if (!(kw > 0)) return 0;
  const cost = (pf(b.demandCharge) + pf(b.tdcCharge) || pf(b.kwCost)) + fac(b);
  return cost > 0 ? cost / kw : 0;
}
const rows = [
  [
    'projectId',
    'projectName',
    'buildingName',
    'meterId',
    'billStart',
    'billEnd',
    'billedKW',
    'kwCost',
    'facKWCost',
    'demandCharge',
    'oldRate',
    'newRate',
  ],
];
let bills = 0;
(d.en_projects || []).forEach((p) => {
  const ud = d['en_utility_' + p.id];
  if (!ud || !Array.isArray(ud.buildings)) return;
  ud.buildings.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.commodity !== 'Electric') return;
      (m.bills || []).forEach((bill) => {
        bills++;
        if (pf(bill.totalKwRate) > 0) return;
        const o = oldRate(bill),
          n = newRate(bill);
        if (Math.abs(o - n) < 1e-9) return;
        rows.push([
          p.id,
          p.name,
          b.name,
          m.id,
          bill.start,
          bill.end,
          bill.billedKW ?? bill.demandKW ?? '',
          bill.kwCost ?? '',
          bill.facKWCost ?? bill.facilitiesCharge ?? '',
          bill.demandCharge ?? '',
          o.toFixed(5),
          n.toFixed(5),
        ]);
      });
    }),
  );
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('electric bills scanned', bills, 'rows', rows.length - 1);
