/**
 * test-bldgname-needs-review.js
 *
 * Regression test for the "(needs review)" tab-label decision in
 * app/bill-analysis.js renderMultiBillUI()'s internal `_bldgName()` closure.
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
 * the rendered building-tab HTML back out of a captured DOM stub element.
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
  const bldgBarStub = { style: {}, innerHTML: '' };
  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => (id === 'pdfBldgTabsBar' ? bldgBarStub : null),
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
  for (const p of ['app/energy-savings.js', 'app/bill-analysis.js']) {
    loadFile(sandbox, p);
  }
  return { sandbox, bldgBarStub };
}

// Extracts { acct: label } pairs from the rendered tab-bar HTML by matching
// each button's onclick account literal against its visible label text.
function extractLabels(html) {
  const out = {};
  const re = /selectMultiBill\(\d+\)"[^>]*>([\s\S]*?)\s*\((\d+)\)<\/button>/g;
  // The account key is embedded earlier in the onclick attribute
  // (window._pdfBuildingTab='ACCT'); capture that too.
  const re2 = /window\._pdfBuildingTab='([^']*)';selectMultiBill\(\d+\)"[^>]*>([\s\S]*?)\s*\(\d+\)<\/button>/g;
  let m;
  while ((m = re2.exec(html))) {
    out[m[1]] = m[2].trim();
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
  `,
    sandbox,
  );
  const renderMultiBillUI = vm.runInContext('renderMultiBillUI', sandbox);
  const setBills = vm.runInContext('(function(b, w) { bills = b; window._pdfBillWarnings = w; })', sandbox);
  setBills(bills, billWarnings);
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

  // ── Case 1: plausible address branch + missing critical field -> MUST tag ──
  {
    const bills = [makeBill('ACCT001', '307 E South St', {}), makeBill('ACCT002', '999 Other St', {})];
    const warnings = [warn('error', 'TotalCurrentCharges'), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'plausible+missing', bills, warnings);
    expect(
      '1. plausible address + missing critical field -> tagged',
      /\(needs review\)$/.test(labels['ACCT001'] || ''),
      'label=' + JSON.stringify(labels['ACCT001']),
    );
  }

  // ── Case 2: plausible address branch + all fields clean -> NO tag ──
  {
    const bills = [makeBill('ACCT001', '307 E South St', {}), makeBill('ACCT002', '999 Other St', {})];
    const warnings = [clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'plausible+clean', bills, warnings);
    expect(
      '2. plausible address + clean fields -> NOT tagged',
      !/\(needs review\)$/.test(labels['ACCT001'] || ''),
      'label=' + JSON.stringify(labels['ACCT001']),
    );
  }

  // ── Case 3: implausible (garbled) address + missing field -> tagged
  //    (this branch already worked before the fix — no-regression check) ──
  {
    const bills = [makeBill('SE019HNGO0TE1340', '= == ==', {}), makeBill('ACCT002', '999 Other St', {})];
    const warnings = [warn('error', 'TotalCurrentCharges'), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'implausible+missing', bills, warnings);
    expect(
      '3. implausible address + missing critical field -> tagged',
      /\(needs review\)$/.test(labels['SE019HNGO0TE1340'] || ''),
      'label=' + JSON.stringify(labels['SE019HNGO0TE1340']),
    );
  }

  // ── Case 3b: implausible address + clean fields -> NO tag (no-regression) ──
  {
    const bills = [makeBill('SE019HNGO0TE1340', '= == ==', {}), makeBill('ACCT002', '999 Other St', {})];
    const warnings = [clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'implausible+clean', bills, warnings);
    expect(
      '3b. implausible address + clean fields -> NOT tagged',
      !/\(needs review\)$/.test(labels['SE019HNGO0TE1340'] || ''),
      'label=' + JSON.stringify(labels['SE019HNGO0TE1340']),
    );
  }

  // ── Case 4: isUnassigned (no AccountNumber at all) + missing field ──
  // Already always says "(needs review)" for the missing-AccountNumber
  // reason itself; confirm it still does (no double-suffix regression) even
  // with the new uniform check layered on top.
  {
    const bills = [
      makeBill(undefined, undefined, {}),
      makeBill('ACCT002', '999 Other St', {}),
      makeBill('ACCT003', '111 Third St', {}),
    ];
    const warnings = [warn('warn', 'InvoiceNumber'), clean(), clean()];
    const labels = runCase(sandbox, bldgBarStub, 'unassigned+missing', bills, warnings);
    const lbl = labels['_unknown'] || '';
    expect(
      '4. isUnassigned + missing field -> tagged, no double suffix',
      /\(needs review\)$/.test(lbl) && !/\(needs review\).*\(needs review\)/.test(lbl),
      'label=' + JSON.stringify(lbl),
    );
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s)');
    process.exit(1);
  } else {
    console.log('All _bldgName "(needs review)" branch tests passed');
  }
}

main();
