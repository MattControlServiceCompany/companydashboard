// READ-ONLY detection for WP-04 (D-10). Usage: node tools/detect-stored-multibaselines.js <backup-copy.json> <out.csv>
// Lists every meter that holds a stored `baselines` array (the multi-baseline path). Prints the count.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const rows = [['key', 'projectId', 'buildingId', 'meterId', 'commodity', 'baselinesLength']];
let metersSeen = 0;
Object.keys(d).forEach((k) => {
  const v = d[k];
  if (!v || typeof v !== 'object' || !Array.isArray(v.buildings)) return;
  v.buildings.forEach((b) =>
    (b.meters || []).forEach((m) => {
      metersSeen++;
      if (Object.prototype.hasOwnProperty.call(m, 'baselines')) {
        rows.push([k, k.replace('en_utility_', ''), b.id, m.id, m.commodity, Array.isArray(m.baselines) ? m.baselines.length : 'notArray']);
      }
    }),
  );
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('meters scanned', metersSeen, 'meters with baselines key', rows.length - 1);
