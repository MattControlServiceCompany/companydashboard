// tools/test-baseline-savings-report.js — Baseline & BAS Savings report regression gate.
// Run: node tools/test-baseline-savings-report.js [path-to-backup.json]
//
// Loads the REAL app files into a Node vm sandbox (no browser, no network) seeded from a local
// CompanyHub backup export, then runs the real collectWoodlandReportData() /
// generateWoodlandReportHTML() / wdCheckReportInputs() / wdApplySetpointOptions() and asserts:
//
//   0. Source hygiene — no building-specific constants remain (rates, install cost, zone lists,
//      client-share %); the xlsx exporter reads its narration from WD_TEXT (no duplicated prose).
//   1. Canonical backup: option annual $ totals equal the audited values to the cent, COMPUTED
//      from the measures' own stored quantities x rates (two rate scenarios, both computed).
//   2. Page 3 is the SHARED site table (actual recorded rptBuildBaselineDataTable() output).
//   3. Page 4 cooling kWh equals sum(round(CDD coefficient x CDD)) — nothing hardcoded.
//   4. Page 5 zones: fallback sentence with no Equipment Matrix rows; zone table with a
//      SYNTHETIC matrix.
//   5-7. Payback/shares/electric-heating structural checks.
//   8. SYNTHETIC building, complete inputs: wdApplySetpointOptions() writes A/B/C measures whose
//      monthly quantities equal an independent hand recomputation; the guard passes; the report's
//      annual $ equal the hand-computed monthly-then-summed dollars; rendered text carries no
//      placeholder or internal-narration token.
//   9. SYNTHETIC building, missing inputs: the guard names what is missing and where; no report
//      renders (showReportOverlay is never called) via either entry point.
//  10. Canonical backup: the in-site calculator, fed the memo's inputs, reproduces the stored
//      (externally modelled) monthly arrays within 0.2% and the annual $ within $2.
//
// Rate/config backfill note (canonical backup only): that backup pre-dates the per-building
// savings inputs (project.savingsData.basSetpoint) and the seasonal gas rates on the measures.
// The gate applies them IN MEMORY (never writes the backup) and says so loudly.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.log('  FAIL: ' + msg);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ─── Backup ────────────────────────────────────────────────────────────────────
function findLatestBackup() {
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^CompanyHub-localdatafile-\d{8}\.json$/.test(f));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}
const backupPath = process.argv[2] || findLatestBackup();
if (!backupPath || !fs.existsSync(backupPath)) {
  console.log('=== Baseline & Savings report gate: SKIPPED (no local backup found) ===');
  process.exit(0);
}
console.log('Using backup: ' + backupPath);
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ─── Woodland memo inputs (2026-09-21 savings-calc memo) — the values the Manager enters in
// the report's Inputs dialog; used here ONLY as in-memory backfill for the canonical backup. ──
const OPT_RE = /Option\s+([A-Z])\s+(\d+)\s*\/\s*(\d+)/i;
const AUDITED = {
  projId: 1781636180197,
  bldgId: 'b1781636210689',
  // Measures' own stored rates (thermRate for both gas seasons) — the live-verified triple.
  totalsThermRate: { A: 1816.15, B: 2144.8, C: 2473.72 },
  // Seasonal gas 0.327/0.518 (audited workbook Note 4) — the workbook triple.
  totalsSeasonal: { A: 1816.15, B: 2144.77, C: 2473.72 },
  cfg: {
    curOccHeat: 68,
    curOccCool: 70,
    pctPerDegF: 4,
    occHeatSharePct: 38,
    occCoolSharePct: 90,
    zonesTotal: 87,
    zonesActive: 73,
    unoccNetTherms: 1800,
    demandFloorKw: 200,
    clientSharePct: 70,
    rates: {
      kwhSummer: 0.0485,
      kwhWinter: 0.0363,
      kwSummer: 11.683,
      kwWinter: 5.598,
      gasSummer: 0.327,
      gasWinter: 0.518,
    },
    options: [
      { letter: 'A', heatSP: 68, coolSP: 72 },
      { letter: 'B', heatSP: 69, coolSP: 73 },
      { letter: 'C', heatSP: 70, coolSP: 74 },
    ],
  },
};

// ─── vm sandbox (black-hole proxy for DOM) ─────────────────────────────────────
function makeBlackHole() {
  const target = function () {};
  return new Proxy(target, {
    get(t, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (!(p in t)) t[p] = makeBlackHole();
      return t[p];
    },
    apply() {
      return makeBlackHole();
    },
    construct() {
      return makeBlackHole();
    },
  });
}
function buildCtx(extraKeys) {
  const sandbox = {};
  sandbox.console = console;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = makeBlackHole();
  sandbox.navigator = {};
  sandbox.fetch = () => Promise.reject(new Error('fetch disabled'));
  sandbox.CustomEvent = class {
    constructor(t, o) {
      this.type = t;
      this.detail = o && o.detail;
    }
  };
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => {};
  sandbox.location = { href: 'file:///gate', search: '', pathname: '/gate' };
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  sandbox.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  sandbox.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  sandbox.performance = { now: () => Date.now() };
  sandbox.crypto = require('crypto').webcrypto;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.URL = URL;
  sandbox.Blob = Blob;
  sandbox.__toasts = [];
  sandbox.showToast = (msg) => sandbox.__toasts.push(String(msg));
  sandbox._mkbh = makeBlackHole;
  sandbox.__blTableCalls = [];
  sandbox.__overlayCalls = [];
  sandbox.__modalHtml = [];
  // document.body.insertAdjacentHTML is the Inputs dialog's mount point — record it.
  sandbox.document.body = {
    insertAdjacentHTML: (pos, html) => sandbox.__modalHtml.push(html),
    appendChild: () => {},
    removeChild: () => {},
  };

  const store = new Map();
  Object.keys(backup).forEach((k) =>
    store.set(k, typeof backup[k] === 'string' ? backup[k] : JSON.stringify(backup[k])),
  );
  Object.keys(extraKeys || {}).forEach((k) => store.set(k, JSON.stringify(extraKeys[k])));
  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
  sandbox.DB = {
    get(k, d) {
      if (typeof k === 'string' && k.indexOf('en_wdd_') === 0) {
        if (store.has(k)) {
          try {
            const v = JSON.parse(store.get(k));
            if (Array.isArray(v) && v.length) return v;
          } catch (e) {}
        }
        const p = path.join(REPO, 'weather-data', k.slice(7) + '.json');
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
      return d;
    },
    // Customer/Multi-Project: self-heal now WRITES (en_projects/en_customers, via sset)
    // as well as reads — a no-op stub silently dropped those writes, so a later read
    // (even the localStorage fallback this stub's own get() relies on) never saw them.
    // Persist through to the same store the localStorage stub reads from.
    set: (k, v) => {
      store.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
    isReady: () => true,
  };
  const ctx = vm.createContext(sandbox);
  const load = (rel) =>
    new vm.Script(fs.readFileSync(path.join(REPO, rel), 'utf8'), { filename: rel }).runInContext(ctx);
  [
    'lib/date-helpers.js',
    'computations/regression.js',
    'computations/rates.js',
    'computations/normalization.js',
    'computations/savings.js',
    'computations/eui.js',
    'computations/hvac-enduse.js',
    'app/utility-data.js',
    'app/core.js',
    'app/data/bas-weather-bins.js',
    'app/calculators.js',
    'app/energy-savings.js',
    'app/report-engine.js',
  ].forEach(load);
  new vm.Script(
    `(function(){ var _o = rptBuildBaselineDataTable; rptBuildBaselineDataTable = function(b, d, opts){ var r = _o(b, d, opts); __blTableCalls.push({ name: b && b.name, html: r }); return r; };
      showReportOverlay = function(html, title){ __overlayCalls.push({ html: html, title: title }); };
      _injectPageNumbers = function(h){ return h; }; })();`,
    { filename: 'instrument' },
  ).runInContext(ctx);
  ['app/equipment-matrix.js', 'app/report-engine-woodland.js'].forEach(load);
  // Customer/Multi-Project (2026-09-24): buildings/meters/bills now live per-customer
  // (en_utility_<customerId>), not per-project — mirrors loadUtilityData()'s own
  // self-heal-then-load sequence (self-heal seeds customerId/scope on every project
  // missing it, deterministically, then each customer's blob is loaded by its own key)
  // WITHOUT running loadUtilityData()'s other one-time bill-content migrations (rate
  // fixes, dedupe, sewer backfill, etc.), which are unrelated to this test and could
  // alter the synthetic fixture's numbers.
  run(
    ctx,
    `projects = JSON.parse(localStorage.getItem('en_projects')) || [];
     _selfHealCustomersAndScope();
     projects = JSON.parse(localStorage.getItem('en_projects')) || [];
     (JSON.parse(localStorage.getItem('en_customers')) || []).forEach(function(c){ var ud = JSON.parse(localStorage.getItem('en_utility_' + c.id) || 'null'); if (ud) utilityData[c.id] = ud; });`,
  );
  return ctx;
}
function run(ctx, src) {
  for (let attempts = 0; attempts < 80; attempts++) {
    try {
      return new vm.Script(src, { filename: 'run' }).runInContext(ctx);
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      new vm.Script(m[1] + ' = _mkbh();', { filename: 'stub' }).runInContext(ctx);
    }
  }
  throw new Error('Too many self-heal retries');
}
const textOf = (html) =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
// Tokens that must never reach a client page: placeholders and internal/uncertainty narration.
const FORBIDDEN = [
  '?',
  'null',
  'NaN',
  'undefined',
  'to be confirmed',
  'assum',
  'estimat',
  'uncertain',
  'TBD',
  'Equipment Matrix',
  'the site',
  'stored',
  'read directly',
];
function assertClean(label, html) {
  const txt = textOf(html);
  FORBIDDEN.forEach((tok) => {
    const idx = txt.toLowerCase().indexOf(tok.toLowerCase());
    assert(
      idx === -1,
      label +
        ': no "' +
        tok +
        '" in rendered text' +
        (idx >= 0 ? ' — "' + txt.slice(Math.max(0, idx - 60), idx + 60).replace(/\s+/g, ' ') + '"' : ''),
    );
  });
}

// ─── 0. Source hygiene ─────────────────────────────────────────────────────────
console.log('\n--- 0. Source: no building-specific constants; xlsx narration comes from WD_TEXT ---');
const src = fs.readFileSync(path.join(REPO, 'app', 'report-engine-woodland.js'), 'utf8');
[
  'WOODLAND_SEASONAL_RATES',
  'WOODLAND_INSTALL_COST',
  'WOODLAND_ZONE_COUNTS',
  'WOODLAND_MONITOR_ONLY_ZONES',
  'WOODLAND_NONSTANDARD_STANDARD_ZONES',
  'WOODLAND_CLIENT_SHARE_PCT',
  '185665',
  'heatPct = 72',
  'to be confirmed',
  'Trigger-Fixed',
].forEach((s) => assert(!src.includes(s), 'source must not contain "' + s + '"'));
const xlsxSrc = src.slice(src.indexOf('async function exportWoodlandReportToXlsx'));
assert(xlsxSrc.length > 1000, 'xlsx exporter located');
['Shared-savings', 'Cooling load could not', 'Zone-level setpoint', 'gas baseline is', 'Basis:'].forEach((s) =>
  assert(!xlsxSrc.includes(s), 'xlsx exporter has no duplicated narration literal "' + s + '" (reads WD_TEXT)'),
);
assert(
  (xlsxSrc.match(/WD_TEXT\./g) || []).length >= 8,
  'xlsx exporter references WD_TEXT (' + (xlsxSrc.match(/WD_TEXT\./g) || []).length + ' uses)',
);

// ─── Locate the target in the backup ───────────────────────────────────────────
const projects = J(backup.en_projects) || [];
let target = null;
projects.forEach((p) => {
  const ms = ((p.savingsData && p.savingsData.measures) || []).filter(
    (m) => (m.basOption && m.basOption.letter) || OPT_RE.test(m.desc || ''),
  );
  if (ms.length >= 3 && !target) target = { projId: p.id, bldgId: ms[0].bldgId, measures: ms };
});
const isAudited = !!target && String(target.projId) === String(AUDITED.projId);

if (target) {
  // ─── Canonical: in-memory backfill (cfg + seasonal gas rates), announced ──────
  const p = projects.find((x) => x.id === target.projId);
  if (isAudited) {
    p.savingsData.basSetpoint = p.savingsData.basSetpoint || {};
    if (!p.savingsData.basSetpoint[target.bldgId]) {
      // Scenario 1 keeps the measures' OWN rates: cfg rates mirror the thermRate they carry.
      const thermRate = parseFloat(target.measures[0].rates.thermRate) || 0;
      p.savingsData.basSetpoint[target.bldgId] = Object.assign({}, AUDITED.cfg, {
        rates: Object.assign({}, AUDITED.cfg.rates, { gasSummer: thermRate, gasWinter: thermRate }),
      });
      console.log(
        'NOTE: savings inputs (basSetpoint) backfilled IN MEMORY for the audited building — the backup pre-dates them. Enter them in the report Inputs dialog and re-export to run unpatched.',
      );
    }
  }
  const ctx = buildCtx({ en_projects: projects });
  run(ctx, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
  const chk = run(
    ctx,
    'wdCheckReportInputs(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
  );
  console.log('\n--- 1. Canonical backup: guard + option annual $ (computed from stored quantities x rates) ---');
  assert(chk.ok, 'guard passes on the backfilled canonical data (missing: ' + JSON.stringify(chk.missing) + ')');
  const d = run(
    ctx,
    'collectWoodlandReportData(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
  );
  assert(d && d.options && d.options.length >= 3, 'collector returns >= 3 options');
  ctx.__d = d;
  const html = run(ctx, 'generateWoodlandReportHTML(__d)');
  d.options.forEach((o) => {
    const r = o.rates;
    console.log(
      '  Option ' +
        o.letter +
        ' (' +
        o.heatSP +
        '/' +
        o.coolSP +
        '): $' +
        o.annualTotal$.toFixed(2) +
        '  gas ' +
        r.gasSummer.toFixed(4) +
        '/' +
        r.gasWinter.toFixed(4) +
        ' kWh ' +
        r.elecEnergySummer +
        '/' +
        r.elecEnergyWinter +
        ' kW ' +
        r.demandSummer +
        '/' +
        r.demandWinter,
    );
    assert(
      r.elecEnergySummer > 0 && r.demandSummer > 0,
      'Option ' + o.letter + ': electric rates come from m.rates (non-zero)',
    );
    assert(
      o.letter !== '?' && o.heatSP != null && o.coolSP != null,
      'Option ' + o.letter + ': letter/setpoints resolved',
    );
  });
  if (isAudited) {
    d.options.forEach((o) => {
      const exp = AUDITED.totalsThermRate[o.letter];
      assert(
        near(o.annualTotal$, exp, 0.005),
        'Option ' +
          o.letter +
          ' annual $' +
          o.annualTotal$.toFixed(2) +
          ' == live-verified $' +
          exp.toFixed(2) +
          ' (measure thermRate both seasons)',
      );
    });
    // Scenario 2: seasonal gas rates on the measures (audited workbook Note 4).
    const ctxS = buildCtx({ en_projects: projects });
    run(ctxS, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
    run(
      ctxS,
      `projects.find(function(p){ return String(p.id) === ${JSON.stringify(String(target.projId))}; }).savingsData.measures.forEach(function(m){ if (m.bldgId === ${JSON.stringify(target.bldgId)} && _wdOptionMeta(m)) { m.rates.gasSummer = ${AUDITED.cfg.rates.gasSummer}; m.rates.gasWinter = ${AUDITED.cfg.rates.gasWinter}; } });`,
    );
    const dS = run(
      ctxS,
      'collectWoodlandReportData(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
    );
    dS.options.forEach((o) => {
      const exp = AUDITED.totalsSeasonal[o.letter];
      assert(
        near(o.annualTotal$, exp, 0.005),
        'Option ' +
          o.letter +
          ' annual $' +
          o.annualTotal$.toFixed(2) +
          ' == audited workbook $' +
          exp.toFixed(2) +
          ' (gas 0.327/0.518)',
      );
    });
  } else console.log('  (not the audited project — cent-exact totals not applicable)');
  assertClean('canonical report', html);

  // ─── 2. Page 3 = the shared site table (actual recorded call) ──────────────────
  console.log('\n--- 2. Page 3 Baseline Summary reuses rptBuildBaselineDataTable() ---');
  const calls = ctx.__blTableCalls;
  assert(calls.length >= 1, 'rptBuildBaselineDataTable() was actually called by the report');
  const call = calls.find((c) => c.html && html.includes(c.html));
  assert(
    !!call,
    "Page 3 HTML contains a recorded rptBuildBaselineDataTable() output byte-for-byte (building '" +
      (calls[0] && calls[0].name) +
      "')",
  );
  assert(
    html.includes('Building Baseline Data') && html.includes('Site EUI'),
    'Page 3 carries the site table title and the Site EUI stat',
  );
  assert(
    html.includes('.rpt-bl-tight th,.rpt-bl-tight td{padding:3px 3px;font-size:8.5px}'),
    'Page 3 table cells carry the 8.5px cell font (header/total overflow fix)',
  );

  // ─── 3. Page 4 cooling from the regression, not a literal ──────────────────────
  console.log('\n--- 3. Page 4 HVAC split derived from the CDD regression ---');
  if (d.hvac && d.hvac.coolKwh != null) {
    const recomputed = d.hvac.months.reduce((s, m) => s + Math.round(d.hvac.slopeCDD * m.cdd + 1e-9), 0);
    assert(
      recomputed === d.hvac.coolKwh,
      'coolKwh (' + d.hvac.coolKwh + ') equals sum of round(slopeCDD x CDD) (' + recomputed + ')',
    );
    assert(d.hvac.heatPct > 0 && d.hvac.heatPct < 100, 'heating share in (0,100): ' + d.hvac.heatPct);
    console.log(
      '  coolKwh ' + d.hvac.coolKwh + ' (' + d.hvac.coolPct + '% of electric), heating share ' + d.hvac.heatPct + '%',
    );
  } else {
    assert(html.includes(run(ctx, 'WD_TEXT.hvacNoSplit')), 'no CDD term => documented fallback sentence renders');
  }

  // ─── 4. Page 5 zones: fallback vs synthetic Equipment Matrix ───────────────────
  console.log('\n--- 4. Page 5 zone setpoints: fallback (no EM rows) and synthetic-matrix table ---');
  const emKey = 'en_eqmatrix_' + target.projId;
  const zoneFallback = run(ctx, 'WD_TEXT.zoneFallback');
  if (!backup[emKey]) {
    assert(d.zones.length === 0, 'no Equipment Matrix rows => zones []');
    assert(html.includes(zoneFallback), 'fallback sentence renders verbatim');
    assert(!html.includes('Current Zone Setpoints'), 'no zone table without matrix rows');
  } else console.log('  (backup has real matrix rows for this project — fallback branch not exercised here)');
  const bName = run(ctx, 'getUDBldg(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ').name');
  const synth = {
    rows: [
      {
        building: bName.toUpperCase(),
        category: 'vav',
        equipName: 'Test Zone 101',
        points: [
          { name: 'Zone Heating Setpoint', value: 68 },
          { name: 'Zone Cooling Setpoint', value: 72 },
          { name: 'Unoccupied Heating Setpoint', value: 60 },
          { name: 'Unoccupied Cooling Setpoint', value: 85 },
        ],
      },
      {
        building: bName,
        category: 'fcu',
        equipName: 'Test Zone 102',
        points: [{ name: 'Zone Heating Setpoint', value: 70 }],
      },
      {
        building: 'Some Other Building',
        category: 'vav',
        equipName: 'Test Zone 999',
        points: [
          { name: 'Zone Heating Setpoint', value: 65 },
          { name: 'Zone Cooling Setpoint', value: 75 },
        ],
      },
    ],
    importedAt: null,
    buildings: [bName],
  };
  const ctx2 = buildCtx({ en_projects: projects, [emKey]: synth });
  run(ctx2, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
  run(
    ctx2,
    `(function(){ var _o = emGetNormalizedPoints; emGetNormalizedPoints = function(row){ var p = _o(row) || {}; if (row && row.points && p.zoneHtgSetpoint === undefined && p.zoneCoolSetpoint === undefined) { var m = { 'Zone Heating Setpoint':'zoneHtgSetpoint','Zone Cooling Setpoint':'zoneCoolSetpoint','Unoccupied Heating Setpoint':'zoneUnoccHtgSetpoint','Unoccupied Cooling Setpoint':'zoneUnoccCoolSetpoint' }; p = {}; row.points.forEach(function(pt){ if (m[pt.name]) p[m[pt.name]] = pt.value; }); } return p; }; })();`,
  );
  const d2 = run(
    ctx2,
    'collectWoodlandReportData(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
  );
  ctx2.__d = d2;
  const html2 = run(ctx2, 'generateWoodlandReportHTML(__d)');
  assert(
    d2.zones.length === 2,
    'case-insensitive building match yields exactly the 2 synthetic zones (got ' + d2.zones.length + ')',
  );
  assert(
    d2.zones.some(
      (z) =>
        z.zone === 'Test Zone 101' &&
        z.occHeat === 68 &&
        z.occCool === 72 &&
        z.unoccHeat === 60 &&
        z.unoccCool === 85 &&
        z.complete,
    ),
    'zone 101 setpoints resolved (occ 68/72, unocc 60/85)',
  );
  assert(
    d2.zones.some((z) => z.zone === 'Test Zone 102' && z.complete === false),
    'zone 102 flagged incomplete (missing occupied cooling)',
  );
  assert(
    html2.includes('Current Zone Setpoints') && html2.includes('Test Zone 101') && !html2.includes('Test Zone 999'),
    'zone table renders this building only',
  );
  assert(!html2.includes(zoneFallback), 'fallback sentence absent when zones exist');
  const pages2 = (html2.match(/class="rpt-page/g) || []).length;
  const pages1 = (html.match(/class="rpt-page/g) || []).length;
  assert(pages2 === pages1 + 1, 'one extra physical page for the zone sheet (' + pages1 + ' -> ' + pages2 + ')');

  // ─── 5. Payback null when the measure carries no implementation cost ───────────
  console.log('\n--- 5. Install cost / payback come from the measure (never rendered) ---');
  assert(
    d.options.every((o) => o.installCost > 0 === (o.paybackYrs != null)),
    'payback present only with an implementation cost',
  );
  assert(
    !html.includes('Install Cost') && !html.includes('Simple payback'),
    'report HTML has no Install Cost / Simple payback text',
  );

  // ─── 6. Shared-savings split from the stored input ──────────────────────────────
  console.log('\n--- 6. Financials: shared-savings split from cfg.clientSharePct ---');
  const pct = d.cfg.clientSharePct;
  d.options.forEach((o) => {
    assert(
      near(o.clientShare$ + o.cscShare$, o.annualTotal$, 0.005),
      'Option ' + o.letter + ': clientShare$ + cscShare$ cross-foots to annualTotal$',
    );
    assert(
      near(o.clientShare$, o.annualTotal$ * (pct / 100), 0.005),
      'Option ' + o.letter + ': clientShare$ = ' + pct + '% of annualTotal$',
    );
  });
  assert(
    html.includes('Client Share (' + pct + '%)') && html.includes('CSC Share (' + (100 - pct) + '%)'),
    'report HTML shows Client/CSC Share with the stored %',
  );

  // ─── 7. HVAC: electric heating kWh line only when slopeHDD is positive ─────────
  console.log('\n--- 7. HVAC: electric heating (kWh) shown only when the regression supports it ---');
  if (d.hvac && d.hvac.heatKwh != null) {
    assert(d.hvac.slopeHDD > 0, 'heatKwh present implies slopeHDD > 0');
    assert(html.includes('Heating Energy — Elec (kWh)'), 'electric heating kWh line renders');
  } else {
    console.log('  (this building/backup has no positive electric-heating HDD term — line correctly omitted)');
    assert(!html.includes('Heating Energy — Elec (kWh)'), 'electric heating kWh line absent when not applicable');
  }

  // ─── 10. In-site calculator vs the stored (externally modelled) arrays ─────────
  if (isAudited) {
    console.log('\n--- 10. In-site calculator (memo inputs, building bills) vs stored arrays / oracle $ ---');
    ctx.__cfg = AUDITED.cfg;
    const calc = run(
      ctx,
      `(function(){ var b = getUDBldg(${JSON.stringify(target.projId)}, ${JSON.stringify(target.bldgId)}); var bls = _wdBldgBaselines(b); return wdComputeSetpointOptions(__cfg, bls.elecBL, bls.gasBL); })()`,
    );
    let maxRel = 0;
    calc.options.forEach((o) => {
      const stored = target.measures.find((m) => (OPT_RE.exec(m.desc || '') || [])[1] === o.letter);
      ['kwh', 'kw', 'gas'].forEach((k) => {
        for (let i = 0; i < 12; i++) {
          const a = o[k][i],
            s = parseFloat(stored[k][i]) || 0;
          // Both sides are stored at 2 decimals: a 0.01 difference on a 2.84-Therm month is
          // rounding, not model drift — measure relative error only above that floor.
          if (Math.abs(a - s) > 0.02) maxRel = Math.max(maxRel, Math.abs(a - s) / Math.max(1, Math.abs(s)));
        }
      });
      // Dollars at the seasonal rates, monthly then summed (report convention).
      const R = AUDITED.cfg.rates;
      let tot = 0;
      for (let i = 0; i < 12; i++) {
        const s = [5, 6, 7, 8].includes(i);
        tot += Math.round(o.gas[i] * (s ? R.gasSummer : R.gasWinter) * 100 + 1e-9) / 100;
        tot += Math.round(o.kwh[i] * (s ? R.kwhSummer : R.kwhWinter) * 100 + 1e-9) / 100;
        tot += Math.round(o.kw[i] * (s ? R.kwSummer : R.kwWinter) * 100 + 1e-9) / 100;
      }
      console.log(
        '  Option ' +
          o.letter +
          ': in-site $' +
          tot.toFixed(2) +
          ' vs audited $' +
          AUDITED.totalsSeasonal[o.letter].toFixed(2),
      );
      assert(
        near(tot, AUDITED.totalsSeasonal[o.letter], 2),
        'Option ' + o.letter + ' in-site annual $ within $2 of the audited total',
      );
    });
    console.log('  max relative difference vs stored monthly arrays: ' + (maxRel * 100).toFixed(3) + '%');
    assert(maxRel < 0.002, 'calculator reproduces the stored monthly arrays within 0.2%');
  }
} else console.log('\n(no building with A/B/C option measures in this backup — sections 1-7/10 not applicable)');

// Hoisted so section 11's kW-comma-formatting check can reuse section 8's rendered Page 3 table.
let ctx8;

// ─── 8. SYNTHETIC building, complete inputs → guard passes, arrays == hand recomputation ───
console.log(
  '\n--- 8. Synthetic building: Save & Compute writes A/B/C; quantities == hand recomputation; report clean ---',
);
const SID = 990000001;
const SBID = 'bsynth1';
const KWH = [40000, 40000, 40000, 50000, 60000, 70000, 80000, 90000, 80000, 60000, 45000, 40000];
const KW = [200, 200, 200, 250, 300, 350, 400, 450, 400, 300, 220, 200];
const THERMS = [3000, 2500, 2000, 1000, 500, 300, 300, 300, 400, 800, 1500, 2500];
function mkBills() {
  const e = [],
    g = [];
  for (let i = 0; i < 12; i++) {
    const ym = '2025-' + String(i + 1).padStart(2, '0');
    const last = new Date(2025, i + 1, 0).getDate();
    e.push({
      id: 'se' + i,
      start: ym + '-01',
      end: ym + '-' + last,
      kwh: KWH[i],
      billedKW: KW[i],
      demandKW: KW[i],
      kwhCost: KWH[i] * 0.05,
      kwCost: KW[i] * 8,
      totalCost: KWH[i] * 0.05 + KW[i] * 8,
      numberOfDays: last,
    });
    g.push({
      id: 'sg' + i,
      start: ym + '-01',
      end: ym + '-' + last,
      therms: THERMS[i],
      totalCost: THERMS[i] * 0.45,
      numberOfDays: last,
    });
  }
  return { e, g };
}
const MONTHS = Array.from({ length: 12 }, (_, i) => '2025-' + String(i + 1).padStart(2, '0'));
function synthProject(withCfg) {
  const { e, g } = mkBills();
  const proj = {
    id: SID,
    name: 'Synthetic Test District',
    client: 'Synthetic Client',
    buildings: [],
    savingsData: { measures: [], blRates: {} },
  };
  if (withCfg) proj.savingsData.basSetpoint = { [SBID]: JSON.parse(JSON.stringify(SCFG)) };
  const ud = {
    buildings: [
      {
        id: SBID,
        name: 'Synthetic Test Building',
        addr: '1 Test St',
        sqft: 50000,
        zip: '',
        meters: [
          {
            id: 'sm-e',
            commodity: 'Electric',
            account: 'TEST-E',
            inclusive: true,
            baselineInclude: true,
            billUnit: 'kWh',
            baseline: { months: MONTHS.slice() },
            bills: e,
          },
          {
            id: 'sm-g',
            commodity: 'Gas',
            account: 'TEST-G',
            inclusive: true,
            baselineInclude: true,
            billUnit: 'Therms',
            baseline: { months: MONTHS.slice() },
            bills: g,
          },
        ],
      },
    ],
  };
  return { proj, ud };
}
const SCFG = {
  curOccHeat: 68,
  curOccCool: 70,
  pctPerDegF: 4,
  occHeatSharePct: 40,
  occCoolSharePct: 90,
  zonesTotal: 10,
  zonesActive: 8,
  unoccNetTherms: 1000,
  demandFloorKw: 200,
  clientSharePct: 70,
  rates: { kwhSummer: 0.05, kwhWinter: 0.04, kwSummer: 10, kwWinter: 5, gasSummer: 0.3, gasWinter: 0.5 },
  options: [
    { letter: 'A', heatSP: 68, coolSP: 72 },
    { letter: 'B', heatSP: 69, coolSP: 73 },
    { letter: 'C', heatSP: 70, coolSP: 74 },
  ],
};
// Independent hand recomputation of the documented formula (plain arithmetic, no app code).
function handCompute(cfg) {
  const lo = (arr) =>
    arr
      .slice()
      .sort((a, b) => a - b)
      .slice(0, 3)
      .reduce((s, v) => s + v, 0) / 3;
  const eBase = lo(KWH),
    gBase = lo(THERMS);
  const cool = KWH.map((v) => Math.max(0, v - eBase));
  const heat = THERMS.map((v) => Math.max(0, v - gBase));
  const sumHeat = heat.reduce((s, v) => s + v, 0);
  const act = cfg.zonesActive / cfg.zonesTotal;
  const r2 = (x) => Math.round(x * 100 + 1e-9) / 100;
  return cfg.options.map((o) => {
    const pctC = (cfg.occCoolSharePct / 100) * act * (cfg.pctPerDegF / 100) * (o.coolSP - cfg.curOccCool);
    const pctH = (cfg.occHeatSharePct / 100) * act * (cfg.pctPerDegF / 100) * (o.heatSP - cfg.curOccHeat);
    const kwh = cool.map((c) => r2(c * pctC));
    const gas = heat.map((h) => r2(cfg.unoccNetTherms * (h / sumHeat) - h * pctH));
    const kw = KW.map((k, i) => ([5, 6, 7, 8].includes(i) ? r2(Math.max(0, k - cfg.demandFloorKw) * pctC) : 0));
    let tot = 0;
    for (let i = 0; i < 12; i++) {
      const s = [5, 6, 7, 8].includes(i);
      tot += r2(gas[i] * (s ? cfg.rates.gasSummer : cfg.rates.gasWinter));
      tot += r2(kwh[i] * (s ? cfg.rates.kwhSummer : cfg.rates.kwhWinter));
      tot += r2(kw[i] * (s ? cfg.rates.kwSummer : cfg.rates.kwWinter));
    }
    return { letter: o.letter, kwh, kw, gas, total: r2(tot) };
  });
}
{
  const { proj, ud } = synthProject(true);
  ctx8 = buildCtx({ en_projects: projects.concat([proj]), ['en_utility_' + SID]: ud });
  run(ctx8, 'udSelProjId = ' + SID + '; udSelBldgId = ' + JSON.stringify(SBID) + ';');
  // Before compute: the guard must name the un-computed options (cfg saved, measures absent).
  const pre = run(ctx8, 'wdCheckReportInputs(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(
    !pre.ok && pre.missing.length === 3 && pre.missing.every((m) => /monthly savings/.test(m.label)),
    'before compute: guard lists exactly the 3 un-computed options (' +
      pre.missing.map((m) => m.label).join('; ') +
      ')',
  );
  ctx8.__cfg = SCFG;
  run(ctx8, 'wdApplySetpointOptions(' + SID + ',' + JSON.stringify(SBID) + ', JSON.parse(JSON.stringify(__cfg)))');
  const post = run(ctx8, 'wdCheckReportInputs(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(post.ok, 'after compute: guard passes (' + JSON.stringify(post.missing) + ')');
  const measures = run(
    ctx8,
    'JSON.parse(JSON.stringify(_wdOptionMeasures(projects.find(function(p){return p.id===' +
      SID +
      '}), ' +
      JSON.stringify(SBID) +
      ')))',
  );
  assert(measures.length === 3, 'exactly 3 option measures written (' + measures.length + ')');
  const hand = handCompute(SCFG);
  hand.forEach((h) => {
    const m = measures.find((x) => x.basOption && x.basOption.letter === h.letter);
    assert(!!m, 'measure for option ' + h.letter + ' exists with basOption');
    if (!m) return;
    ['kwh', 'kw', 'gas'].forEach((k) => {
      const same = m[k].length === 12 && m[k].every((v, i) => near(v, h[k][i], 0.005));
      assert(
        same,
        'Option ' +
          h.letter +
          ' ' +
          k +
          ' == hand recomputation (' +
          JSON.stringify(m[k]) +
          ' vs ' +
          JSON.stringify(h[k]) +
          ')',
      );
    });
    assert(
      m.rates.gasSummer === 0.3 && m.rates.gasWinter === 0.5 && m.rates.kwhSummer === 0.05 && m.rates.kwSummer === 10,
      'Option ' + h.letter + ' measure carries the dialog rates',
    );
    assert(
      m.desc ===
        'BAS Setpoint Option ' +
          h.letter +
          ' — ' +
          SCFG.options.find((o) => o.letter === h.letter).heatSP +
          '°F / ' +
          SCFG.options.find((o) => o.letter === h.letter).coolSP +
          '°F occupied',
      'Option ' + h.letter + ' measure description',
    );
  });
  // Hand-checkable worked example for Option A August (index 7): cooling = 90000 - 40000 = 50000
  // kWh; pctC = 0.9 x 0.8 x 0.04 x 2 = 0.0576 -> 2880 kWh; demand (450-200) x 0.0576 = 14.4 kW.
  const mA = measures.find((x) => x.basOption.letter === 'A');
  assert(
    mA && near(mA.kwh[7], 2880, 0.005) && near(mA.kw[7], 14.4, 0.005),
    'Option A August: 2,880 kWh and 14.40 kW (worked example)',
  );
  // Option A January gas: baseload = mean of 3 lowest gas months = 300; heating Jan = 3000 - 300 =
  // 2700; annual heating = 11,500; 1000 x (2700 / 11500) = 234.78 (no occupied-heat cost for A).
  assert(mA && near(mA.gas[0], 234.78, 0.005), 'Option A January: 234.78 Therms (worked example)');
  const d8 = run(ctx8, 'collectWoodlandReportData(' + SID + ',' + JSON.stringify(SBID) + ')');
  hand.forEach((h) => {
    const o = d8.options.find((x) => x.letter === h.letter);
    assert(
      o && o.annualTotal$ > 0 && near(o.annualTotal$, h.total, 0.005),
      'Option ' +
        h.letter +
        ' report annual $' +
        (o ? o.annualTotal$.toFixed(2) : '?') +
        ' == hand $' +
        h.total.toFixed(2) +
        ' (monthly then summed)',
    );
  });
  assert(
    d8.options[0].annualTotal$ < d8.options[1].annualTotal$ && d8.options[1].annualTotal$ < d8.options[2].annualTotal$,
    'A < B < C (cooling gain outweighs heating cost in the fixture)',
  );
  ctx8.__d = d8;
  const html8 = run(ctx8, 'generateWoodlandReportHTML(__d)');
  assertClean('synthetic report', html8);
  const t8 = textOf(html8);
  assert(
    t8.includes('Basis: a 4.0% change in HVAC energy per 1°F') &&
      t8.includes('8 of 10 zones') &&
      t8.includes('1,000 Therms per year') &&
      t8.includes('200 kW minimum'),
    'basis sentence prints the stored inputs',
  );
  assert(
    t8.includes("this building's own BAS control settings and engineering inputs for this savings calculation"),
    'basis sentence states where the percent-per-degree/shares/zone-count/setback inputs come from',
  );
  assert(
    t8.includes('This savings calculation applies to the 8 of 10 zones') && t8.includes('remaining 2 zones'),
    'actuator-coverage sentence prints the stored zone counts (8 active, 2 excluded of 10 total)',
  );
  assert(
    t8.includes(
      'Shared-savings structure: 70% of the annual dollars saved to the client and 30% to CSC (Control Service Company).',
    ),
    'shared-savings sentence prints the stored split and expands CSC on first use',
  );
  assert(
    t8.includes('68°F') && t8.includes('72°F') && /Current\s+68°F\s+70°F/.test(t8.replace(/\s+/g, ' ')),
    'current + proposed setpoints table renders',
  );
  assert(!t8.includes('$0.00 / yr'), 'no zero-dollar option rows');
  // Full entry point: Save & Generate renders through wdRenderReport when the guard passes.
  run(ctx8, 'wdRenderReport(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(
    ctx8.__overlayCalls.length === 1 && ctx8.__overlayCalls[0].title.indexOf('Baseline & BAS Savings Report') > 0,
    'wdRenderReport renders the report when inputs are complete',
  );
  assertClean('wdRenderReport output', ctx8.__overlayCalls[0].html);
}

// ─── 9. SYNTHETIC building, missing inputs → guard fires, nothing renders ───────
console.log('\n--- 9. Synthetic building: missing inputs block the report and are named ---');
{
  const { proj, ud } = synthProject(false);
  const ctx9 = buildCtx({ en_projects: projects.concat([proj]), ['en_utility_' + SID]: ud });
  run(ctx9, 'udSelProjId = ' + SID + '; udSelBldgId = ' + JSON.stringify(SBID) + ';');
  const chk = run(ctx9, 'wdCheckReportInputs(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(
    !chk.ok && chk.missing.some((m) => /Savings inputs/.test(m.label) && /Inputs/.test(m.where)),
    'no saved inputs => guard names "Savings inputs" and where to set them',
  );
  run(ctx9, 'generateWoodlandReport(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(ctx9.__overlayCalls.length === 0, 'report button never renders a page while inputs are missing');
  assert(
    ctx9.__modalHtml.length === 1 &&
      /cannot be generated until these inputs are set/.test(ctx9.__modalHtml[0]) &&
      /Savings inputs/.test(ctx9.__modalHtml[0]),
    'report button opens the Inputs dialog listing the missing inputs',
  );
  run(ctx9, 'wdRenderReport(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(
    ctx9.__overlayCalls.length === 0 && /Report blocked/.test(ctx9.__toasts.join('|')),
    'wdRenderReport refuses and toasts the missing inputs',
  );
  // Partial inputs: one field blank, rates blank, one option without setpoints.
  const partial = JSON.parse(JSON.stringify(SCFG));
  partial.zonesTotal = null;
  partial.rates.gasWinter = 0;
  partial.options[2].coolSP = null;
  ctx9.__partial = partial;
  run(ctx9, '_wdSaveCfg(' + SID + ',' + JSON.stringify(SBID) + ', __partial)');
  const chk2 = run(ctx9, 'wdCheckReportInputs(' + SID + ',' + JSON.stringify(SBID) + ')');
  const labels = chk2.missing.map((m) => m.label).join(' | ');
  assert(
    !chk2.ok &&
      /Zones with room setpoints/.test(labels) &&
      /Gas \$\/Therm — Winter/.test(labels) &&
      /Option C occupied heating \/ cooling setpoints/.test(labels),
    'partial inputs => each missing field is named (' + labels + ')',
  );
  run(ctx9, 'wdRenderReport(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(ctx9.__overlayCalls.length === 0, 'still no report with partial inputs');
  // Button flag: the header button carries the warning until inputs are complete.
  run(
    ctx9,
    'document.__btn = { style: {} }; document.getElementById = function(id){ return id === "ud-woodland-report-btn" ? document.__btn : null; }; wdUpdateReportButton(' +
      SID +
      ',' +
      JSON.stringify(SBID) +
      ')',
  );
  const btn = run(ctx9, 'document.__btn');
  assert(
    btn.style.display === '' && /^⚠/.test(btn.textContent) && /Zones with room setpoints/.test(btn.title),
    'building header button is visible and flagged ⚠ with the missing list in its tooltip',
  );
  // Baseline missing entirely: a building with no 12-month baseline is named too.
  const { proj: p2, ud: ud2 } = synthProject(true);
  ud2.buildings[0].meters[1].baseline.months = MONTHS.slice(0, 6);
  const ctx9b = buildCtx({ en_projects: projects.concat([p2]), ['en_utility_' + SID]: ud2 });
  run(ctx9b, 'udSelProjId = ' + SID + ';');
  const chk3 = run(ctx9b, 'wdCheckReportInputs(' + SID + ',' + JSON.stringify(SBID) + ')');
  assert(
    chk3.missing.some((m) => /Gas meter with a 12-month baseline/.test(m.label)),
    'gas baseline shorter than 12 months is named',
  );
}

// ─── 11. Regression: gas prefill non-zero on naturalGasTherms-only bills; kW comma formatting ──
// (2026-09-22) Root cause: calcBldgDefaultRates() (app/energy-savings.js, feeds
// report-engine-woodland.js's Inputs-dialog prefill) read bill.therms directly. Woodland's own
// CSV-imported gas bills carry the value ONLY in naturalGasTherms (bill.therms is absent), so the
// prefill silently computed $0.00/Therm for both seasons. Fixed by routing every gas-usage read
// through the single canonical resolveGasUsageTherms() (computations/savings.js).
console.log('\n--- 11. Gas $/Therm prefill non-zero on naturalGasTherms-only bills; Annual kW has commas ---');
{
  const GID = 990000003;
  const GBID = 'bsynthgas1';
  const SUMMER_THERMS = [0, 0, 0, 0, 0, 120, 140, 130, 110, 0, 0, 0]; // Jun-Sep only
  const WINTER_THERMS = [900, 800, 700, 400, 200, 0, 0, 0, 0, 300, 600, 850];
  const gBills = [];
  for (let i = 0; i < 12; i++) {
    const ym = '2025-' + String(i + 1).padStart(2, '0');
    const last = new Date(2025, i + 1, 0).getDate();
    const th = SUMMER_THERMS[i] + WINTER_THERMS[i];
    gBills.push({
      id: 'ngt' + i,
      start: ym + '-01',
      end: ym + '-' + last,
      // Deliberately NO `therms` field — mirrors Woodland's real CSV-imported gas bills, which
      // store the value only in naturalGasTherms (report-engine-woodland.js / calcBldgDefaultRates
      // bug this section regression-guards).
      naturalGasTherms: th,
      totalCost: th * 0.6,
      numberOfDays: last,
    });
  }
  const gasProj = {
    id: GID,
    name: 'Synthetic Gas-Only Fixture',
    client: 'Synthetic Client',
    buildings: [],
    savingsData: { measures: [], blRates: {} },
  };
  const gasUd = {
    buildings: [
      {
        id: GBID,
        name: 'Synthetic Gas Fixture Building',
        addr: '1 Test St',
        sqft: 20000,
        zip: '',
        meters: [
          {
            id: 'sm-ngt',
            commodity: 'Gas',
            account: 'TEST-NGT',
            inclusive: true,
            baselineInclude: true,
            billUnit: 'Therms',
            baseline: { months: MONTHS.slice() },
            bills: gBills,
          },
        ],
      },
    ],
  };
  const ctx11 = buildCtx({ en_projects: projects.concat([gasProj]), ['en_utility_' + GID]: gasUd });
  const rates11 = run(ctx11, 'calcBldgDefaultRates(' + GID + ',' + JSON.stringify(GBID) + ')');
  assert(
    rates11.gasSummer > 0,
    'calcBldgDefaultRates: gasSummer prefill is non-zero on naturalGasTherms-only bills (' + rates11.gasSummer + ')',
  );
  assert(
    rates11.gasWinter > 0,
    'calcBldgDefaultRates: gasWinter prefill is non-zero on naturalGasTherms-only bills (' + rates11.gasWinter + ')',
  );
  const expSummerRate = SUMMER_THERMS.reduce((s, v) => s + v * 0.6, 0) / SUMMER_THERMS.reduce((s, v) => s + v, 0);
  const expWinterRate = WINTER_THERMS.reduce((s, v) => s + v * 0.6, 0) / WINTER_THERMS.reduce((s, v) => s + v, 0);
  assert(
    near(rates11.gasSummer, expSummerRate, 0.001),
    'gasSummer == cost/therms computed from the bills own naturalGasTherms (' +
      rates11.gasSummer +
      ' vs ' +
      expSummerRate.toFixed(4) +
      ')',
  );
  assert(
    near(rates11.gasWinter, expWinterRate, 0.001),
    'gasWinter == cost/therms computed from the bills own naturalGasTherms (' +
      rates11.gasWinter +
      ' vs ' +
      expWinterRate.toFixed(4) +
      ')',
  );
  run(ctx11, 'udSelProjId = ' + GID + ';');
  const cfg11 = run(ctx11, '_wdDefaultCfg(' + GID + ',' + JSON.stringify(GBID) + ')');
  assert(
    cfg11.rates.gasSummer > 0 && cfg11.rates.gasWinter > 0,
    'Inputs dialog prefill (_wdDefaultCfg): gas $/Therm summer/winter both non-zero (' +
      cfg11.rates.gasSummer +
      ', ' +
      cfg11.rates.gasWinter +
      ')',
  );

  // kW comma formatting — reuse section 8's synthetic building/report (Annual Metered/Billed kW
  // sum to 3,470.0, which must render WITH a thousands separator, matching every other cell in
  // the Building Baseline Data table (app/report-engine.js rptBuildBaselineDataTable Annual row)).
  const html8Again = ctx8 && ctx8.__blTableCalls.length ? ctx8.__blTableCalls[ctx8.__blTableCalls.length - 1].html : '';
  assert(html8Again.length > 0, 'Page 3 Building Baseline Data table was captured for the kW-formatting check');
  assert(
    /3,470\.0/.test(html8Again),
    'Annual row Metered kW / Billed kW render WITH thousands separators ("3,470.0"), not "3470.0"',
  );
  assert(!/[^,\d]3470\.0\b/.test(html8Again), 'Annual row kW never renders the un-comma\'d "3470.0" form');
}

// ─── 12. Cold-review fix pass (2026-09-22): forbidden tokens, distinct rate labels ─────────────
console.log('\n--- 12. Forbidden jargon tokens; distinct energy-only vs. blended rate labels ---');
{
  // (a) Forbidden internal/process/jargon tokens must never reach the client HTML — extends the
  // section-8/9 assertClean() scan with the specific terms this fix pass removed.
  const t8b = textOf(ctx8.__overlayCalls[0].html);
  ['OLS', 'Show your work', '(dual)'].forEach((tok) => {
    assert(!t8b.includes(tok), 'rendered report text does not contain internal/jargon term "' + tok + '"');
  });
  assert(t8b.includes('Building Automation System (BAS)'), 'BAS is expanded on first use');
  assert(t8b.includes('CSC (Control Service Company)'), 'CSC is expanded on first use');
  assert(t8b.includes('Sample calculation'), '"Sample calculation" replaces "Show your work"');

  // (b) Forbidden tokens in the xlsx exporter's OWN source text (static scan — exportWoodlandReportToXlsx
  // needs a real DOM/canvas for its chart images and is not executed in this vm sandbox; every
  // narrative string it prints is asserted, above, to come from WD_TEXT, so the html8 scan already
  // covers the shared text — this additionally guards against a literal re-introduced directly in
  // the xlsx sheet-building code).
  ['OLS', 'Show your work', "'$/kWh'", '"$/kWh"'].forEach((tok) => {
    assert(!xlsxSrc.includes(tok), 'xlsx exporter source has no internal/jargon literal "' + tok + '"');
  });

  // (c) Distinct rate labels: the energy-only rate and the blended (energy+demand) rate must
  // never share a label anywhere the shared Building Baseline Data table renders (Page 3).
  const html8Rate = ctx8 && ctx8.__blTableCalls.length ? ctx8.__blTableCalls[ctx8.__blTableCalls.length - 1].html : '';
  assert(html8Rate.length > 0, 'Page 3 Building Baseline Data table was captured for the rate-label check');
  assert(html8Rate.includes('Energy<br>$/kWh'), 'Page 3 table header reads "Energy $/kWh" (energy-only, distinct)');
  assert(
    html8Rate.includes('Blended Electric Rate'),
    'Page 3 stats strip reads "Blended Electric Rate" (energy + demand, distinct)',
  );
  assert(
    !/(?<!Energy<br>)\$\/kWh<\/th>/.test(html8Rate),
    'no bare "$/kWh" header remains once the Energy $/kWh column is labeled',
  );
  // The two labeled figures must actually differ (energy-only < blended) on real data, not just
  // carry different names on the same number.
  // 8 numeric tds precede the Energy $/kWh cell in the Annual row: Heating, Cooling (Degree
  // Days columns, added 2026-09-22), kWh, Metered kW, Billed kW, kW Cost, Energy Cost,
  // Electric Cost — was {6} before Degree Days existed.
  const energyOnlyM =
    /Energy<br>\$\/kWh<\/th>[\s\S]*?<tr class="rpt-tot"><td>Annual<\/td>(?:<td class="rpt-n">[^<]*<\/td>){8}<td class="rpt-n">\$([\d.]+)<\/td>/.exec(
      html8Rate,
    );
  // Note: the label text itself contains a literal "$" (the "($/kWh)" parenthetical), so the
  // match must skip to the stat's own value cell rather than stopping at the label's own "$".
  const blendedM = /Blended Electric Rate[\s\S]*?bl-stat-val">\$([\d.]+)/.exec(html8Rate);
  if (energyOnlyM && blendedM) {
    const eOnly = parseFloat(energyOnlyM[1]),
      blended = parseFloat(blendedM[1]);
    assert(
      blended > eOnly,
      'Blended Electric Rate ($' + blended + ') > Energy $/kWh (energy-only, $' + eOnly + ') — distinct values',
    );
  } else {
    assert(false, 'could not locate both the Energy $/kWh Annual cell and the Blended Electric Rate stat to compare');
  }
}

// ─── 13. 2026-09-23 kWh overflow fix: Annual kWh column widens for 7/8-digit buildings, and
// ONLY for them (SYNTHETIC fixtures — this is the layout fix's own regression gate; the fix
// itself, and why a fixed static weight can't work, is documented in app/report-engine.js's
// rptBuildBaselineDataTable, the _BL_COL_WEIGHT/_blKwhNeedPx block). This can't assert real
// pixel overflow (no browser/layout engine in this vm sandbox — that was verified separately,
// headless, against Woodland/Louisburg HS/synthetic 7- and 8-digit fixtures, see
// 2026-09-23-report-kwh-overflow/2026-09-23-result.md), but it DOES prove the dynamic-width
// code path actually fires (and by how much) from the table's own rendered colgroup HTML, so a
// future revert/regression of the fix fails loudly here instead of silently.
console.log('\n--- 13. Annual kWh column width grows only for 7+ digit annual totals ---');
{
  function colWidthPx(html, colIndex) {
    const m = [...html.matchAll(/<col style="width:(\d+)px">/g)];
    return m[colIndex] ? parseInt(m[colIndex][1], 10) : null;
  }
  // Section 8's already-captured Page 3 table: 6-digit annual kWh (695,000 — sums KWH above),
  // kwh is column index 3 (Month, HDD, CDD, kWh, ...). Baseline case: weight untouched.
  const html6 = ctx8.__blTableCalls[ctx8.__blTableCalls.length - 1].html;
  const kwhPx6 = colWidthPx(html6, 3);
  assert(kwhPx6 != null, '6-digit fixture: kwh column width found in colgroup');

  // A second, independent SYNTHETIC building/project — same shape as section 8's, scaled up to
  // a 7-digit annual kWh (own local KWH/KW/THERMS arrays; does not touch section 8's).
  const KWH7 = [110000, 105000, 110000, 120000, 135000, 150000, 165000, 175000, 160000, 135000, 120000, 110000];
  const KW7 = [500, 500, 520, 560, 620, 700, 760, 800, 760, 660, 560, 500];
  const THERMS7 = THERMS.slice();
  function mkBills7() {
    const e = [],
      g = [];
    for (let i = 0; i < 12; i++) {
      const ym = '2025-' + String(i + 1).padStart(2, '0');
      const last = new Date(2025, i + 1, 0).getDate();
      e.push({
        id: 'se7' + i,
        start: ym + '-01',
        end: ym + '-' + last,
        kwh: KWH7[i],
        billedKW: KW7[i],
        demandKW: KW7[i],
        kwhCost: KWH7[i] * 0.05,
        kwCost: KW7[i] * 8,
        totalCost: KWH7[i] * 0.05 + KW7[i] * 8,
        numberOfDays: last,
      });
      g.push({
        id: 'sg7' + i,
        start: ym + '-01',
        end: ym + '-' + last,
        therms: THERMS7[i],
        totalCost: THERMS7[i] * 0.45,
        numberOfDays: last,
      });
    }
    return { e, g };
  }
  const SID7 = 990000006,
    SBID7 = 'bsynth7d1';
  const { e: e7, g: g7 } = mkBills7();
  const proj7 = {
    id: SID7,
    name: 'Synthetic 7Digit Gate District',
    client: 'Synthetic Client',
    buildings: [],
    savingsData: { measures: [], blRates: {}, basSetpoint: { [SBID7]: JSON.parse(JSON.stringify(SCFG)) } },
  };
  const ud7 = {
    buildings: [
      {
        id: SBID7,
        name: 'Synthetic 7Digit Gate Building',
        addr: '1 Test St',
        sqft: 100000,
        zip: '',
        meters: [
          {
            id: 'sm-e7',
            commodity: 'Electric',
            account: 'TEST-E7',
            inclusive: true,
            baselineInclude: true,
            billUnit: 'kWh',
            baseline: { months: MONTHS.slice() },
            bills: e7,
          },
          {
            id: 'sm-g7',
            commodity: 'Gas',
            account: 'TEST-G7',
            inclusive: true,
            baselineInclude: true,
            billUnit: 'Therms',
            baseline: { months: MONTHS.slice() },
            bills: g7,
          },
        ],
      },
    ],
  };
  const ctx13 = buildCtx({ en_projects: projects.concat([proj7]), ['en_utility_' + SID7]: ud7 });
  run(ctx13, 'udSelProjId = ' + SID7 + '; udSelBldgId = ' + JSON.stringify(SBID7) + ';');
  ctx13.__cfg = SCFG;
  run(ctx13, 'wdApplySetpointOptions(' + SID7 + ',' + JSON.stringify(SBID7) + ', JSON.parse(JSON.stringify(__cfg)))');
  const d13 = run(ctx13, 'collectWoodlandReportData(' + SID7 + ',' + JSON.stringify(SBID7) + ')');
  const kwh7Sum = KWH7.reduce((a, b) => a + b, 0);
  assert(String(kwh7Sum).length === 7, 'fixture sanity: annual kWh is 7 digits (' + kwh7Sum + ')');
  ctx13.__d = d13;
  run(ctx13, 'generateWoodlandReportHTML(__d)');
  const html7 = ctx13.__blTableCalls[ctx13.__blTableCalls.length - 1].html;
  const kwhPx7 = colWidthPx(html7, 3);
  assert(kwhPx7 != null, '7-digit fixture: kwh column width found in colgroup');
  assert(
    html7.includes(kwh7Sum.toLocaleString()),
    '7-digit fixture: Annual row shows the correct total (' + kwh7Sum.toLocaleString() + ')',
  );
  if (kwhPx6 != null && kwhPx7 != null) {
    assert(
      kwhPx7 > kwhPx6,
      'kwh column widens for a 7-digit annual total (6-digit: ' + kwhPx6 + 'px, 7-digit: ' + kwhPx7 + 'px)',
    );
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(failed > 0 ? 1 : 0);
