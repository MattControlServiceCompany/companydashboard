// test-contract-type-csc.js — WP-29 acceptance test (synthetic data only).
// One keeper (getProjectContract in computations/csc.js) gives the contract type and the one CSC %.
// Project Settings cscCompensation is the only store. No built-in 60, no agreement-config cscPct.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function makeCtx(projs, store) {
  store = store || {};
  const toasts = [];
  const ctx = {
    console, Math, Number, String, Object, Array, Date, isFinite, parseFloat, JSON,
    projects: projs,
    sget: (k, d) => (k in store ? store[k] : d),
    sset: (k, v) => { store[k] = v; },
    _pricingGetConfig: () => ({ hourlyRate: 170 }),
    _pricingComputeMonthlyLaborBreakdown: () => ({ recurringPoolHours: 16 }),
    showToast: (m, t) => toasts.push({ m, t }),
    document: { getElementById: () => null },
    rptPage: (n, title, body) => '<div class="rpt-page">' + body + '</div>',
    _rptContentBudget: () => 1000, _injectPageNumbers: (h) => h,
    _pricingGetBudget: () => ({ amount: 6250 }), _pricingGetEstimate: () => ({}),
    _pricingComputeSummaryData: () => ({ tierTotals: { recommended: { grand: 50000 } } }),
    showReportOverlay: () => {}, _updateOverlayPageNumbers: () => {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(rd('computations/csc.js'), ctx);
  vm.runInContext(rd('app/agreement-engine.js'), ctx);
  return { ctx, toasts, store };
}

// 1. Keeper.
const P = (o) => Object.assign({ id: 1, name: 'Test Client' }, o);
let t = makeCtx([P({})]);
const gc = t.ctx.getProjectContract;
ok(typeof gc === 'function', 'keeper getProjectContract exists');
if (typeof gc === 'function') {
  let c = gc(P({ contractType: 'sharedSavings', cscCompensation: 55 }));
  ok(c.type === 'sharedSavings' && c.cscPct === 55 && c.clientPct === 45 && !c.needsPct, 'shared savings 55 -> csc 55, client 45');
  c = gc(P({ contractType: 'sharedSavings', cscCompensation: 0 }));
  ok(c.cscPct === null && c.needsPct === true, 'shared savings with no % -> cscPct null, needsPct true');
  c = gc(P({ contractType: 'fixedProject', cscCompensation: 60 }));
  ok(c.type === 'fixedProject' && c.cscPct === null && !c.needsPct, 'fixed project ignores a stored %');
  c = gc(P({ contractType: 'none', cscCompensation: 60 }));
  ok(c.type === 'none' && c.cscPct === null && !c.needsPct, 'no contract ignores a stored %');
  c = gc(P({ cscCompensation: 80 }));
  ok(c.type === 'sharedSavings' && c.cscPct === 80, 'type not saved + % saved -> read as shared savings 80');
  c = gc(P({}));
  ok(c.type === null && c.cscPct === null && !c.needsPct, 'nothing saved -> no type, no %, no warning');
}

// 2. Agreement engine reads the keeper; agreement-config cscPct is gone.
t = makeCtx([P({ contractType: 'sharedSavings', cscCompensation: 55 })], { en_agreement_config_1: { cscPct: 60 } });
let d = t.ctx.collectAgreementData(1, 'profitSharing', {});
ok(d && d.cscPct === 55 && d.clientPct === 45, 'agreement CSC % = project 55 even with a stored agreement cscPct 60 (got ' + (d && d.cscPct) + ')');
t = makeCtx([P({ contractType: 'sharedSavings', cscCompensation: 0 })]);
ok(t.ctx.generateAgreementHTML(1, 'profitSharing', {}) === null, 'profit sharing agreement is blocked when shared savings has no %');
t = makeCtx([P({ contractType: 'fixedProject', cscCompensation: 0 })]);
d = t.ctx.collectAgreementData(1, 'oneTimeCost', {});
ok(d && d.cscPct === null, 'fixed project agreement data has no CSC % (no default 60)');
ok(!!t.ctx.generateAgreementHTML(1, 'oneTimeCost', {}), 'one-time cost agreement still builds for a fixed project');

// 2b. hasContract: one gate (projHasContract in savings.js reads the keeper).
if (typeof gc === 'function') {
  ok(gc(P({ contractType: 'none', sa: 'SA-1' })).hasContract === false, "'none' + SA number -> no contract");
  ok(gc(P({ contractType: 'fixedProject', sa: 'SA-1' })).hasContract === true, 'fixed project + SA number -> contract');
  ok(gc(P({ contractType: 'sharedSavings', cscCompensation: 50 })).hasContract === false, 'no SA number -> no contract');
  const t2 = makeCtx([P({ contractType: 'none', sa: 'SA-1' }), P({ id: 2, contractType: 'fixedProject', sa: 'SA-2' })]);
  vm.runInContext(rd('computations/savings.js'), t2.ctx);
  ok(t2.ctx.projHasContract(1) === false && t2.ctx.projHasContract(2) === true, 'projHasContract follows the keeper');
}

// 2c. Reports: fixed project / none prints no CSC or Client Net rows (no 0% / 100%).
{
  const src = strip(rd('app/report-engine.js'));
  ok(/hasCsc:\s*cscComp\s*!==\s*null/.test(src), 'report data carries hasCsc from the keeper');
  ok(!/cscComp\s*=\s*_contract\.cscPct\s*===\s*null\s*\?\s*0/.test(src), 'report data no longer turns a missing share into 0');
  ok((src.match(/hasCsc/g) || []).length >= 6, 'report CSC tables and rows are gated by hasCsc');
  const ud = strip(rd('app/utility-data.js'));
  ok((ud.match(/_showCsc/g) || []).length >= 14, 'Utility Data CSC rows, cards, inputs and chart series are gated by _showCsc');
}

// 3. Code checks.
const ae = strip(rd('app/agreement-engine.js'));
ok(!/\?\s*pc\s*:\s*60/.test(ae) && !/return\s+pc\s*>\s*0\s*\?\s*pc\s*:\s*60/.test(ae), 'agreement engine has no built-in 60 default');
ok(!/cfg\.cscPct|stored\.cscPct|cscPct:\s*null/.test(ae), 'agreement config has no cscPct copy');
ok(!/cscPct:\s*60/.test(strip(rd('app/energy-savings.js'))), 'energy-savings.js has no cscPct: 60 default');
const ud = strip(rd('app/utility-data.js'));
ok(!/_customCsc/.test(ud) && !/cscPct:\s*cscPct\s*\*\s*100/.test(ud), 'building settings no longer store a CSC % copy');
ok(!/_customCsc/.test(strip(rd('app/core.js'))) && !/bpCfg\.cscPct|bspCfg\.cscPct/.test(strip(rd('app/core.js')) + strip(rd('app/energy-savings.js'))), 'Project Settings save no longer copies the % into building settings');
ok(/id="mp-contractType"/.test(rd('energy-department.html')), 'Project Settings has a contract type field');

console.log(fails ? '\nFAILED: ' + fails : '\nALL PASS');
process.exit(fails ? 1 : 0);
