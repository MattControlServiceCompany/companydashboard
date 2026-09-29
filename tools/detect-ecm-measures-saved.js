// READ-ONLY detection for WP-17. Usage: node tools/detect-ecm-measures-saved.js <backup-copy.json> <out.csv>
// Lists (1) savings-matrix measures created by ECM "Add as Measure" (source ecm_*) whose kW per month
// was stored as annual/12 (demand savings 12x too small), and (2) saved ECM records for the Outdoor Air
// / Energy Recovery calculator (results used the old formula). Nothing is rewritten.
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const projects = d.en_projects || [];
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const rows = [['projectId', 'projectName', 'kind', 'recordId', 'template', 'kwPerMonthStored', 'kwPerMonthCorrected', 'kwhAnnual', 'note']];
projects.forEach((p) => {
  ((p.savingsData && p.savingsData.measures) || []).forEach((m) => {
    if (!String(m.source || '').startsWith('ecm_')) return;
    const kw = (m.kw || []).map((x) => parseFloat(x) || 0);
    const kwh = (m.kwh || []).reduce((s, x) => s + (parseFloat(x) || 0), 0);
    const stored = kw.length ? kw[0] : 0;
    rows.push([p.id, p.name, 'matrix measure', m.id, String(m.source).slice(4), stored, Math.round(stored * 12 * 100) / 100, Math.round(kwh),
      stored > 0 ? 'kW per month is annual/12: demand savings 12x too small' : 'no kW saved']);
  });
  (p.ecms || []).forEach((e) => {
    if (e.templateId !== 'oa_erw' && e.template !== 'oa_erw') return;
    rows.push([p.id, p.name, 'saved ECM record', e.id || '', 'oa_erw', '', '', '', 'saved results used the old energy-recovery formula (3.412x cooling, remaining load as savings)']);
  });
});
fs.writeFileSync(out, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('rows', rows.length - 1);
