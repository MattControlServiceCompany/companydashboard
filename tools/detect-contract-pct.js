// detect-contract-pct.js — WP-29 READ-ONLY detection. Usage: node tools/detect-contract-pct.js <backup.json>
// Per project: contract type saved, the % in each place (Project Settings, agreement config, building
// settings copies), and what the user must set in Project Settings. Never writes. Read a COPY of a backup.
'use strict';
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const projs = J(b.en_projects);
const csv = (s) => '"' + String(s).replace(/"/g, '""') + '"';
// Business decisions (Matt 2026-09-29). Matched by project name.
const MUST = [
  [/louisburg/i, 'sharedSavings', 60],
  [/joco/i, 'fixedProject', ''],
  [/baker/i, 'none', ''],
  [/spring hill/i, 'sharedSavings', 80],
];
console.log('projectId,projectName,savedContractType,projectSettingsPct,agreementConfigPct,buildingCopiesWithPct_allProjects,mustSetType,mustSetPct,action');
for (const p of projs) {
  const a = b['en_agreement_config_' + p.id] ? J(b['en_agreement_config_' + p.id]) : null;
  let copies = 0;
  for (const k of Object.keys(b)) if (/^(bldgperf|bldgsavproj)_cfg_/.test(k)) { const c = J(b[k]); if (c && c.cscPct != null) copies++; }
  const m = MUST.find((r) => r[0].test(p.name || ''));
  const pct = parseFloat(p.cscCompensation) || 0;
  const acts = [];
  if (m) {
    if (p.contractType !== m[1]) acts.push('set contract type to ' + m[1] + ' in Project Settings');
    if (m[2] !== '' && pct !== m[2]) acts.push('set CSC share to ' + m[2]);
    if (m[2] === '' && pct > 0) acts.push('clear CSC share (' + pct + ') in Project Settings');
  } else acts.push('decide contract type');
  if (a && a.cscPct != null) acts.push('agreement config cscPct ' + a.cscPct + ' is ignored now; Matt approved removal (JOCO) - remove through the UI, not written here');
  console.log([p.id, csv(p.name || ''), p.contractType || '', pct, a && a.cscPct != null ? a.cscPct : '', copies, m ? m[1] : '', m ? m[2] : '', csv(acts.join('; ') || 'none')].join(','));
}
