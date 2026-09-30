// READ-ONLY detection for WP-03 (math-03 E-3). Usage: node tools/detect-csv-partial-reimport.js <newer-backup.json> <older-backup.json> <out.csv>
// Compares each saved bill (same project, meter id, bill start) in the newer backup to the older backup.
// Lists every field that held a value in the older backup and is empty in the newer one.
//   ID_CHANGED = yes: the bill id differs between the two copies. The old CSV import replaced the id, so this
//                is the mark of a CSV re-import over that bill. no: the bill id is the same.
// It never writes to either backup or to the app. The user decides any restore.
'use strict';
const fs = require('fs');
const [, , newer, older, out] = process.argv;
if (!newer || !older || !out) {
  console.error('Usage: node tools/detect-csv-partial-reimport.js <newer-backup.json> <older-backup.json> <out.csv>');
  process.exit(2);
}
const N = JSON.parse(fs.readFileSync(newer, 'utf8'));
const O = JSON.parse(fs.readFileSync(older, 'utf8'));
const empty = (v) => v === null || v === undefined || v === '';
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const rows = [['projectId', 'projectName', 'buildingName', 'meterId', 'commodity', 'billStart', 'idChanged', 'field', 'olderValue']];
let fieldRows = 0;
let bills = 0;
const oldMap = {};
(O.en_projects || []).forEach((p) => {
  const ud = O['en_utility_' + p.id];
  ((ud && ud.buildings) || []).forEach((b) =>
    (b.meters || []).forEach((m) => (m.bills || []).forEach((bl) => (oldMap[p.id + '|' + m.id + '|' + bl.start] = bl))),
  );
});
(N.en_projects || []).forEach((p) => {
  const ud = N['en_utility_' + p.id];
  ((ud && ud.buildings) || []).forEach((b) =>
    (b.meters || []).forEach((m) =>
      (m.bills || []).forEach((bl) => {
        const ob = oldMap[p.id + '|' + m.id + '|' + bl.start];
        if (!ob) return;
        let hit = false;
        Object.keys(ob).forEach((k) => {
          if (k === '_flags' || k.charAt(0) === '_' || empty(ob[k]) || !empty(bl[k])) return;
          if (typeof ob[k] === 'object') return;
          hit = true;
          fieldRows++;
          rows.push([p.id, p.name, b.name, m.id, m.commodity, bl.start, ob.id !== bl.id ? 'yes' : 'no', k, ob[k]]);
        });
        if (hit) bills++;
      }),
    ),
  );
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('bills with a nulled field: ' + bills + '; field rows: ' + fieldRows + '; wrote ' + out);
