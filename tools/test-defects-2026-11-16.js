// Source checks for the 2026-11-16 defect pass (synthetic, no client data).
const fs = require('fs'), path = require('path');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } else console.log('ok  ', m); };
const em = rd('app/equipment-matrix.js'), es = rd('app/energy-savings.js'), cal = rd('app/calculators.js');
const bud = rd('app/budget.js'), pe = rd('app/pricing-estimator.js'), sf = rd('app/site-functions.js'), ems = rd('ems-leads.html');
ok(em.indexOf(">about ' + fmt(Math.round(t.hpSu") > -1, 'D24: hpCell uses "about " not a tilde');
ok(!/!bldg\) \{[^}]*Sequence[^}]*All Buildings/.test(em), 'D27: no Sequence-needs-one-building branch');
ok(/class="card" style="flex-shrink:0"/.test(es), 'D35: matrix card does not shrink in the flex column');
ok(/function _fyLabel\(year, fyStart\)/.test(bud), 'D-budget: fiscal-year label takes the start month');
ok(/_hvlSavedLabel/.test(cal), 'D34: saved label function present');
ok(/Equipment Matrix tab first/.test(rd('app/audit-estimate.js')), 'D48: wording says Equipment Matrix tab');
ok(/STAGE_CARD_LIMIT/.test(ems) && /with a value entered/.test(ems), 'D51: stage column limit and won-value note');
ok(/uiCustomToggleCalc\(this\.checked\);this\.nextSibling/.test(sf), 'D52: Show Calculations label follows the checkbox');
ok(/minWidth: 190 \}, \/\/ 2/.test(pe), 'D45: cost table columns widened');
process.exit(bad ? 1 : 0);
