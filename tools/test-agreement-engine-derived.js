// test-agreement-engine-derived.js — WP-23 acceptance test (synthetic data only).
// Checks: D-11 minimum spend = recurring hours x live hourly rate (no literal); a stored value wins (R2);
// D-7 CSC % reads project cscCompensation unless the agreement store holds a value (R2);
// blank escalation warns and does not build; minimum spend shows cents when present.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }

function makeCtx(opts) {
  const store = Object.assign({}, opts.store || {});
  const toasts = [];
  const els = {};
  const ctx = {
    console, Math, Number, String, Object, Array, Date, isFinite, parseFloat,
    projects: [{ id: 1, name: 'Test Client', client: 'Test Client', cscCompensation: opts.projCsc }],
    sget: (k, d) => (k in store ? store[k] : d),
    sset: (k, v) => { store[k] = v; },
    _pricingGetConfig: () => ({ hourlyRate: opts.rate }),
    _pricingComputeMonthlyLaborBreakdown: () => ({ recurringPoolHours: opts.hours }),
    showToast: (m, t) => toasts.push({ m, t }),
    document: { getElementById: (id) => els[id] || null },
    rptPage: (n, title, body) => '<div class="rpt-page">' + body + '</div>',
    _rptContentBudget: () => 1000,
    _injectPageNumbers: (h) => h,
    showReportOverlay: () => {},
    _updateOverlayPageNumbers: () => {},
    window: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'agreement-engine.js'), 'utf8'), ctx);
  return { ctx, store, toasts, els };
}

// 1. New config, rate 170 x 16 hours -> 2720; no 2768 literal in the file.
let t = makeCtx({ rate: 170, hours: 16, projCsc: 55 });
let d = t.ctx.collectAgreementData(1, 'monthlyAllowance', {});
ok(d.minimumSpend === 2720, 'derived minimum spend = 16 x 170 = 2720 (got ' + d.minimumSpend + ')');
t = makeCtx({ rate: 181, hours: 16, projCsc: 55 });
d = t.ctx.collectAgreementData(1, 'monthlyAllowance', {});
ok(d.minimumSpend === 2896, 'minimum spend follows a changed live rate: 16 x 181 = 2896 (got ' + d.minimumSpend + ')');
ok(!/2768/.test(fs.readFileSync(path.join(root, 'app', 'agreement-engine.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no 2768 literal in code');

// 2. Stored user value wins (R2).
t = makeCtx({ rate: 170, hours: 16, projCsc: 55, store: { en_agreement_config_1: { minimumSpend: 6250, cscPct: 60 } } });
d = t.ctx.collectAgreementData(1, 'monthlyAllowance', {});
ok(d.minimumSpend === 6250, 'stored minimum spend 6250 is kept');
ok(d.cscPct === 60 && d.clientPct === 40, 'stored cscPct 60 is kept, client = 40 (got ' + d.cscPct + '/' + d.clientPct + ')');

// 3. D-7: no stored value -> project cscCompensation.
t = makeCtx({ rate: 170, hours: 16, projCsc: 55 });
d = t.ctx.collectAgreementData(1, 'profitSharing', {});
ok(d.cscPct === 55 && d.clientPct === 45, 'CSC % reads project cscCompensation 55, client 45 (got ' + d.cscPct + '/' + d.clientPct + ')');

// 4. Cents.
const html = t.ctx.generateAgreementHTML(1, 'monthlyAllowance', { minimumSpend: 2720.5 }).html;
ok(/\$2,720\.50/.test(html), 'minimum spend prints cents when present');
const html2 = t.ctx.generateAgreementHTML(1, 'monthlyAllowance', {}).html;
ok(/\$2,720 applies/.test(html2), 'whole-dollar minimum spend prints without cents');

// 5. Blank escalation warns and does not build.
t = makeCtx({ rate: 170, hours: 16, projCsc: 55 });
const fakeModal = { _agrProjId: 1, querySelector: () => null, classList: { remove() {}, add() {} } };
t.els.agreementReportModal = fakeModal;
t.els.agrEscalationRate = { value: '' };
t.els.agrMinimumSpend = { value: '' };
t.els.agrCscPct = { value: '55' };
t.ctx.generateAgreementPreview();
ok(t.toasts.length === 1 && /escalation/i.test(t.toasts[0].m), 'blank escalation shows a warning');
ok(!t.store.en_agreement_config_1, 'blank escalation saves nothing');

// 6. Minimum spend cannot be derived (no recurring hours) and none stored: warn, do not build.
t = makeCtx({ rate: 170, hours: NaN, projCsc: 55 });
t.els.agreementReportModal = { _agrProjId: 1, querySelector: () => null, classList: { remove() {}, add() {} } };
t.els.agrEscalationRate = { value: '4' };
t.els.agrMinimumSpend = { value: '' };
t.els.agrCscPct = { value: '55' };
t.ctx.generateAgreementPreview();
ok(t.toasts.length === 1 && /monthly budget/i.test(t.toasts[0].m), 'underivable minimum spend shows the budget warning');
ok(!t.store.en_agreement_config_1, 'underivable minimum spend saves nothing');

console.log(fails ? '\nFAILED ' + fails : '\nALL PASS');
process.exit(fails ? 1 : 0);
