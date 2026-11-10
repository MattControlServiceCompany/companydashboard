/**
 * test-bldgname-needs-review.js
 *
 * Regression test for the building list in the top row of the PDF / OCR page (app/bill-analysis.js _pdfGroupBills,
 * _pdfBuildingName, _pdfSelectorsHtml): name, "(N to review)", counts by building and type.
 *
 * FIX(2026-09-25, wre-needs-review-all-branches): before this fix, the
 * `_fieldsClean` (missing-field) warning check ran ONLY inside the
 * address-implausible, non-unassigned branch. A bill that took the
 * plausible-address branch or the isUnassigned branch never got checked
 * against `window._pdfBillWarnings`, so a tab could show a clean label even
 * though its own bill had real missing critical/important fields (the "Mid
 * Sch So" case documented in
 * AI/_context/temp/2026-09-25-wre-needs-review/2026-09-25-findings.md).
 *
 * Loads the REAL renderMultiBillUI() (app/bill-analysis.js) plus its real
 * dependency _looksLikeAddress/_stripAddressTrailingJunk (app/energy-savings.js)
 * via Node's vm module — not a reimplementation of the label logic — and reads
 * the rendered building list (a select in the top row) back out of a captured DOM stub element.
 *
 * Covers all 3 label-source branches _bldgName() can take:
 *   1. Plausible address branch (final return in the function)
 *   2. Address-implausible, non-unassigned branch
 *   3. isUnassigned branch (no AccountNumber at all)
 * ...crossed with clean vs. missing-fields, to prove the tag now applies
 * uniformly.
 *
 * Usage: node tools/test-bldgname-needs-review.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function buildSandbox() {
  // The top row of the page: only the selector box is read back; the other boxes just need to exist.
  const bldgBarStub = { style: {}, innerHTML: '' };
  const stubs = { pdfTopBar: { style: {} }, pdfTopSel: { style: {}, innerHTML: '' }, pdfTopBldgs: bldgBarStub, pdfTopChips: { style: {}, innerHTML: '' }, pdfTopSave: { style: {}, innerHTML: '' }, pdfTopPop: { style: {}, innerHTML: '' }, pdfMorePop: { style: {} }, pdfMoreSave: { style: {}, innerHTML: '' } };
  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => stubs[id] || null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    console,
    Date,
    Set,
    JSON,
    Math,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    navigator: { userAgent: 'node' },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  vm.createContext(sandbox);
  // Real projects list is empty — findMeterMatch() must fall through to the
  // address heuristic for every test bill (no meter/building identity match).
  vm.runInContext(
    `
    var projects = [];
    function _parseISO(d) { return new Date(d + 'T12:00:00'); }
    function forEachCustomerBuilding(projectsList, fn) {
      (projectsList || []).forEach((p) => (p.buildings || p.buildings === 0 ? p.buildings : []).forEach((b) => fn(b, p)));
    }
  `,
    sandbox,
  );
  return { sandbox, bldgBarStub };
}

function loadFile(sandbox, relPath) {
  const full = path.join(__dirname, '..', relPath);
  const src = fs.readFileSync(full, 'utf8');
  vm.runInContext(src, sandbox, { filename: path.basename(relPath) });
}

function setup() {
  const { sandbox, bldgBarStub } = buildSandbox();
  for (const p of [
    'lib/formatting.js',
    'lib/date-helpers.js',
    'computations/normalization.js',
    'computations/physics.js', 'computations/rates.js',
    'app/energy-savings.js',
    'app/bill-analysis.js',
  ]) {
    loadFile(sandbox, p);
  }
  return { sandbox, bldgBarStub };
}

// Extracts { acct: label text } from the building list in the top row (one button for each building).
// Label = the building name, then the status text of the button (for example "1 to review").
function extractLabels(html) {
  const out = {};
  const re = /<button[^>]*data-acct="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = /<span class="pdf-bldg-name">([\s\S]*?)<\/span>/.exec(m[2]);
    const spans = [...m[2].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => x[1]);
    out[m[1]] = ((name ? name[1] : '') + ' ' + (spans[spans.length - 1] || '')).replace(/\s+/g, ' ').trim();
  }
  return out;
}

function runCase(sandbox, bldgBarStub, name, bills, billWarnings) {
  vm.runInContext(
    `
    window._pdfMultiIdx = 0;
    window._pdfBuildingTab = undefined;
    window._pdfCommTab = undefined;
    window._pdfDupMap = {};
    window._pdfQueue = null;
    window._pdfBillChips = null;
  `,
    sandbox,
  );
  const renderMultiBillUI = vm.runInContext('renderMultiBillUI', sandbox);
  const setBills = vm.runInContext('(function(b, w) { bills = b; window._pdfBillWarnings = w; })', sandbox);
  setBills(bills, billWarnings);
  vm.runInContext('(function(b) { window._pdfMultiBills = b; })', sandbox)(bills);
  // The review state of the file: every bill has a meter (this test counts value and held issues), except a bill
  // marked _noMeter, which has no destination (case 8).
  vm.runInContext(
    `_mbInitFor = window._pdfMultiBills;
    _mbRowTargets = {};
    _mbRowState = {};
    window._pdfMultiBills.forEach((b, i) => {
      _mbRowTargets[i] = b._noMeter ? null : { meter: { id: 'm' + i }, proj: { name: 'P' }, bldg: { name: 'B' }, matchType: 'identity' };
      _mbRowState[i] = { checked: !b._noMeter, skipped: false };
    });`,
    sandbox,
  );
  bldgBarStub.innerHTML = '';
  const box = { innerHTML: '' };
  renderMultiBillUI(bills, box);
  return extractLabels(bldgBarStub.innerHTML);
}

function makeBill(acct, addr, extra) {
  return Object.assign(
    {
      AccountNumber: acct,
      ServiceAddress: addr,
      UtilityCompany: 'Wood River Energy',
      Commodity: 'Gas',
      BillingPeriodStart: '1/1/2026',
      BillingPeriodEnd: '2/1/2026',
    },
    extra,
  );
}

function warn(level, field) {
  return { warnings: [{ level, field, message: 'test' }] };
}
function clean() {
  return { warnings: [] };
}

let failures = 0;
function expect(name, cond, detail) {
  if (cond) {
    console.log('PASS ' + name);
  } else {
    failures++;
    console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function main() {
  const { sandbox, bldgBarStub } = setup();

  const review = (l) => /(\d+) to review/.exec(l || '');
  const noOld = (l) => !/\(needs review\)/.test(l || '');
  // 1. plausible address + error -> name, "1 bill", "1 need review", no old tag
  {
    const bills = [makeBill('ACCT001', '307 E Sample St', {}), makeBill('ACCT002', '999 Other St', {})];
    const labels = runCase(sandbox, bldgBarStub, 'plausible+missing', bills, [warn('error', 'TotalCurrentCharges'), clean()]);
    const l = labels['ACCT001'];
    expect('1. warning -> "1 to review" after the building name', review(l) && review(l)[1] === '1' && /^307 E Sample St/.test(l) && noOld(l), JSON.stringify(l));
    expect('1b. no utility type in the label', !/Gas|Electric|Water/.test(l), JSON.stringify(l));
    expect('1c. every building is listed', Object.keys(labels).length === 2, JSON.stringify(labels));
  }
  // 2. clean -> no review text
  {
    const bills = [makeBill('ACCT001', '307 E Sample St', {}), makeBill('ACCT002', '999 Other St', {})];
    const labels = runCase(sandbox, bldgBarStub, 'plausible+clean', bills, [clean(), clean()]);
    expect('2. clean -> no review text', !review(labels['ACCT001']) && noOld(labels['ACCT001']), JSON.stringify(labels['ACCT001']));
  }
  // 3. garbled address -> account number as name, review text when warned
  {
    const bills = [makeBill('SE019HNGO0TE1340', '= == ==', {}), makeBill('ACCT002', '999 Other St', {})];
    const labels = runCase(sandbox, bldgBarStub, 'implausible+missing', bills, [warn('error', 'TotalCurrentCharges'), clean()]);
    const l = labels['SE019HNGO0TE1340'];
    expect('3. garbled address -> account name + review text', /^SE019HNGO0TE1340/.test(l) && review(l) && noOld(l), JSON.stringify(l));
  }
  // 4. no account -> "Unassigned"
  {
    const bills = [makeBill(undefined, undefined, {}), makeBill('ACCT002', '999 Other St', {}), makeBill('ACCT003', '111 Third St', {})];
    const labels = runCase(sandbox, bldgBarStub, 'unassigned+missing', bills, [warn('warn', 'InvoiceNumber'), clean(), clean()]);
    const l = labels['_unknown'];
    expect('4. no account -> Unassigned + review text', /^Unassigned/.test(l) && review(l) && noOld(l), JSON.stringify(l));
  }
  // 5. building counts add up to the bills in the file, and types are per building
  {
    const bills = [
      makeBill('ACCT001', '307 E Sample St', { Commodity: 'Gas' }),
      makeBill('ACCT001', '307 E Sample St', { Commodity: 'Water' }),
      makeBill('ACCT002', '999 Other St', { Commodity: 'Gas' }),
    ];
    const warns = [warn('error', 'TotalCurrentCharges'), clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'counts', bills, warns);
    const grp = vm.runInContext('_pdfGroupBills', sandbox)(bills, warns, true);
    expect('5. counts: 2 bills + 1 bill, one review line on the building with the warning', grp[0].total === 2 && grp[1].total === 1 && /1 to review/.test(labels['ACCT001']) && !review(labels['ACCT002']), JSON.stringify(labels));
    const t = (g, c) => g.types.find((x) => x.comm === c);
    expect('5b. warning counted only inside its own building and type', t(grp[0], 'Gas').warn === 1 && t(grp[0], 'Water').warn === 0 && t(grp[1], 'Gas').warn === 0, JSON.stringify(grp));
    expect('5c. sum of building bills = bills in file', grp.reduce((n, g) => n + g.total, 0) === bills.length);
  }

  {
    // No whole-PDF warning count anywhere in the PDF / OCR view (Matt, 2026-10-19).
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'bill-analysis.js'), 'utf8');
    expect('6a. no "elsewhere in this batch" message', !/elsewhere in this batch/.test(src) && !/_pdfBatchWarnCount/.test(src));
    expect('6b. file bar, badge and toast carry no period or warning count', !/' periods'|' periods, |' warnings\)'|warning found|' found'/.test(src.slice(src.indexOf("dz.textContent = file.name + ' ✓'") - 600, src.indexOf("dz.textContent = file.name + ' ✓'") + 600)));
  }

  {
    // 7. Held bills (gate tripped and not confirmed, or Manual Review) count as need-review / warning.
    const bills = [
      makeBill('ACCT001', '307 E Sample St', { Commodity: 'Gas', _gateTripped: true }),
      makeBill('ACCT001', '307 E Sample St', { Commodity: 'Gas', _gateTripped: true, _gateOverrideConfirmed: true }),
      makeBill('ACCT001', '307 E Sample St', { Commodity: 'Water', _manualReview: true }),
      makeBill('ACCT002', '999 Other St', { Commodity: 'Gas' }),
    ];
    const warns = [clean(), clean(), clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'held', bills, warns);
    const grp = vm.runInContext('_pdfGroupBills', sandbox)(bills, warns, true);
    const t = (g, c) => g.types.find((x) => x.comm === c);
    expect('7a. held bills counted: building shows 2 to review', review(labels['ACCT001']) && review(labels['ACCT001'])[1] === '2', JSON.stringify(labels));
    expect('7b. held bills counted per type; confirmed one is not', t(grp[0], 'Gas').warn === 1 && t(grp[0], 'Water').warn === 1 && grp[1].review === 0, JSON.stringify(grp));
    const issues = vm.runInContext('_pdfBillIssues', sandbox);
    expect('7c. one issue rule: held bill -> any', issues(bills[0], []).any === true && issues(bills[3], []).any === false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'bill-analysis.js'), 'utf8');
    expect('7d. the period list calls _pdfBillIssues only', /const bad = _pdfBillIssues\(bills\[p\.i\]/.test(src));
    expect('7e. no whole-PDF count text in the review panel or gate notice', !/ across ' \+|bill\(s\) flagged for review and held/.test(src));
    const vb = src.slice(src.indexOf('async function viewCurrentExtractionPDF'), src.indexOf('function _pdfDockRevoke'));
    expect('7f. View PDF always uses the dock (no modal path)', !/_showPdfModal|_pdfSideBySideOn/.test(vb));
  }

  {
    // 8. A bill with no matching meter (multi-building file) is a bill to review: one issue rule, _pdfBillIssues.
    const bills = [makeBill('ACCT001', '825 Testcat Dr', { Commodity: 'Electric', _noMeter: true }), makeBill('ACCT002', '999 Other St', { Commodity: 'Gas' })];
    const warns = [clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'no-meter', bills, warns);
    const issues = vm.runInContext('_pdfBillIssues', sandbox);
    expect('8a. no matching meter -> 1 to review', review(labels['ACCT001']) && review(labels['ACCT001'])[1] === '1' && !review(labels['ACCT002']), JSON.stringify(labels));
    expect('8b. no matching meter -> dest issue', (issues(bills[0], []).dest || {}).kind === 'no-building' && issues(bills[1], []).dest === null);
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s)');
    process.exit(1);
  } else {
    console.log('All building button tests passed');
  }
}

main();
