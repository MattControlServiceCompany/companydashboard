// detect-agreement-config.js — WP-23 READ-ONLY detection. Usage: node tools/detect-agreement-config.js <backup.json>
// Prints a CSV: stored agreement config vs project cscCompensation (D-7) and vs old minimum-spend literals (D-11).
// Never writes. Read a COPY of a backup.
'use strict';
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let projs = b.en_projects; if (typeof projs === 'string') projs = JSON.parse(projs);
const csv = s => '"' + String(s).replace(/"/g, '""') + '"';
console.log('projectId,projectName,agreementStored,storedCscPct,projectCscCompensation,cscStatus,storedMinimumSpend,minimumSpendNote');
for (const p of projs) {
  let a = b['en_agreement_config_' + p.id]; if (typeof a === 'string') a = JSON.parse(a);
  const pc = parseFloat(p.cscCompensation) || 0;
  let cscStatus = 'no agreement store', ms = '', note = '';
  if (a) {
    const sc = a.cscPct;
    if (sc == null) cscStatus = 'agreement unset - reads project';
    else if (!(pc > 0)) cscStatus = 'DIFFERS: project unset(0), agreement ' + sc + ' - STOP, Matt decides';
    else cscStatus = sc === pc ? 'agree - second store not needed' : 'DIFFERS: STOP, Matt decides';
    if (a.minimumSpend != null) {
      ms = a.minimumSpend;
      note = (ms === 2768 || ms === 2720) ? 'equals old default (kept; Matt decides)' : 'custom value (kept)';
    } else note = 'unset - derived';
  }
  console.log([p.id, csv(p.name || ''), !!a, a && a.cscPct != null ? a.cscPct : '', pc, csv(cscStatus), ms, csv(note)].join(','));
}
