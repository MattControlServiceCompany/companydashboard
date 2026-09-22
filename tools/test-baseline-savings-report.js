// tools/test-baseline-savings-report.js — Baseline & Savings report regression gate (oracle A).
// Run: node tools/test-baseline-savings-report.js [path-to-backup.json]
//
// Same pattern as test_eui_source_of_truth.js: loads the REAL app files into a Node vm sandbox
// (no browser, no network) seeded from a local CompanyHub backup export, then runs the real
// collectWoodlandReportData() / generateWoodlandReportHTML() and asserts:
//
//   1. Option annual $ totals equal the audited values to the cent — computed from the
//      measures' OWN stored rates (kwhSummer/kwhWinter, kwSummer/kwWinter, gasSummer/gasWinter)
//      and NOT from any constant in app/report-engine-woodland.js (the source is grepped for
//      the retired constants).
//   2. Page 3 is the SHARED site table — the report's Baseline Summary HTML contains the exact
//      output of an actual recorded rptBuildBaselineDataTable() call (app/report-engine.js),
//      fed by collectReportData()'s building record, never a parallel re-summation.
//   3. Page 4 has no hardcoded cooling kWh / heating % — the cooling figure equals the sum of
//      (rounded CDD coefficient x rounded monthly CDD) over the baseline months.
//   4. Page 5 zone data: with zero Equipment Matrix rows for the building the documented
//      fallback sentence renders and no zone table; with a SYNTHETIC matrix (fake zone names,
//      never real client rows) the per-zone table renders one row per zone.
//   5. Per-option install cost / payback come from m.implCost (null payback when 0).
//
// The audited totals belong to one specific project (matched by id) and are only asserted when
// that project is present in the backup; otherwise sections 1/3 report "not applicable" and
// the structural checks (2/4/5) still run on whichever building has A/B/C option measures.
// SKIPS (exit 0) when no backup is found.
//
// Rate backfill note: the audited totals require gasSummer=0.327 / gasWinter=0.518 on the
// three option measures (entered through the Energy Savings rate UI). If the backup's measures
// do not carry them yet, the gate applies that backfill IN MEMORY (never writes the backup) and
// says so loudly — the totals then prove the code path, and a re-exported backup after the UI
// backfill will pass with no patch at all.
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

// ─── Locate the target: a building with "Option A/B/C h/c" savings measures ───
const OPT_RE = /Option\s+([A-C])\s+(\d+)\s*\/\s*(\d+)/i;
const projects = J(backup.en_projects) || [];
let target = null;
projects.forEach((p) => {
  const ms = ((p.savingsData && p.savingsData.measures) || []).filter((m) => OPT_RE.test(m.desc || ''));
  if (ms.length >= 3 && !target) target = { projId: p.id, bldgId: ms[0].bldgId, measures: ms };
});
if (!target) {
  console.log('=== Baseline & Savings report gate: SKIPPED — no project in this backup has A/B/C option measures ===');
  process.exit(0);
}
// Audited targets for the reference project (2026-09-22 — sum-of-rounded-cents convention,
// identical to the pre-rebuild constants-based engine output). Only asserted for that project.
const AUDITED = {
  projId: 1781636180197,
  totals: { A: 1816.15, B: 2144.77, C: 2473.72 },
  gasSummer: 0.327,
  gasWinter: 0.518,
  implCost: 1384,
};
const isAudited = String(target.projId) === String(AUDITED.projId);

let backfilled = false;
if (isAudited) {
  target.measures.forEach((m) => {
    m.rates = m.rates || {};
    if (!(parseFloat(m.rates.gasSummer) > 0) || !(parseFloat(m.rates.gasWinter) > 0)) {
      m.rates.gasSummer = AUDITED.gasSummer;
      m.rates.gasWinter = AUDITED.gasWinter;
      backfilled = true;
    }
    if (!(parseFloat(m.implCost) > 0)) {
      m.implCost = AUDITED.implCost;
      backfilled = true;
    }
  });
  if (backfilled)
    console.log(
      'NOTE: measure rates/implCost backfilled IN MEMORY (gasSummer ' +
        AUDITED.gasSummer +
        ', gasWinter ' +
        AUDITED.gasWinter +
        ', implCost ' +
        AUDITED.implCost +
        ') — the backup does not carry them yet. Enter them in the Energy Savings rate UI and re-export to run this gate unpatched.',
    );
  backup.en_projects = JSON.stringify(projects);
}

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
  sandbox.showToast = () => {};
  sandbox._mkbh = makeBlackHole;
  sandbox.__blTableCalls = [];

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
  // Weather: the backup's own en_wdd_<zip> rows, else weather-data/<zip>.json.
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
    set: () => Promise.resolve(),
    // "Ready" so emLoadMatrix() does not return its cold-cache null sentinel; sget() then
    // reads DB.get (undefined for non-weather keys) and falls through to localStorage.
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
    'app/calculators.js',
    'app/energy-savings.js',
    'app/report-engine.js',
  ].forEach(load);
  // Instrument the shared site table BEFORE the report engine loads so section 2 can prove the
  // report's Page 3 is an ACTUAL recorded call's output (test_eui pattern).
  new vm.Script(
    `(function(){ var _o = rptBuildBaselineDataTable; rptBuildBaselineDataTable = function(b, d, opts){ var r = _o(b, d, opts); __blTableCalls.push({ name: b && b.name, html: r }); return r; }; })();`,
    { filename: 'instrument' },
  ).runInContext(ctx);
  ['app/equipment-matrix.js', 'app/report-engine-woodland.js'].forEach(load);
  run(
    ctx,
    `projects = JSON.parse(localStorage.getItem('en_projects')) || []; projects.forEach(function(p){ var ud = JSON.parse(localStorage.getItem('en_utility_' + p.id) || 'null'); if (ud) utilityData[p.id] = ud; });`,
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

// ─── 0. Source hygiene: retired constants are gone ─────────────────────────────
console.log('\n--- 0. Source: no building-specific constants remain in app/report-engine-woodland.js ---');
const src = fs.readFileSync(path.join(REPO, 'app', 'report-engine-woodland.js'), 'utf8');
[
  'WOODLAND_SEASONAL_RATES',
  'WOODLAND_INSTALL_COST',
  'WOODLAND_ZONE_COUNTS',
  'WOODLAND_MONITOR_ONLY_ZONES',
  'WOODLAND_NONSTANDARD_STANDARD_ZONES',
  '185665',
  'heatPct = 72',
].forEach((s) => assert(!src.includes(s), 'source must not contain "' + s + '"'));

// ─── Run the real collector + renderer ─────────────────────────────────────────
const ctx = buildCtx();
run(ctx, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
const d = run(
  ctx,
  'collectWoodlandReportData(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
);
assert(d && d.options && d.options.length >= 3, 'collector returns >= 3 options');
ctx.__d = d;
const html = run(ctx, 'generateWoodlandReportHTML(__d)');

// ─── 1. Audited totals from the measures' OWN rates ────────────────────────────
console.log(
  '\n--- 1. Option annual $ totals from stored measure rates (' +
    (backfilled ? 'in-memory backfill applied' : 'no patch') +
    ') ---',
);
d.options.forEach((o) => {
  const r = o.rates;
  console.log(
    '  Option ' +
      o.letter +
      ': $' +
      o.annualTotal$.toFixed(2) +
      '  rates gas ' +
      r.gasSummer +
      '/' +
      r.gasWinter +
      ' kWh ' +
      r.elecEnergySummer +
      '/' +
      r.elecEnergyWinter +
      ' kW ' +
      r.demandSummer +
      '/' +
      r.demandWinter +
      '  implCost ' +
      o.installCost +
      ' payback ' +
      o.paybackYrs,
  );
  assert(
    r.elecEnergySummer > 0 && r.demandSummer > 0,
    'Option ' + o.letter + ': electric rates come from m.rates (non-zero)',
  );
});
if (isAudited) {
  d.options.forEach((o) => {
    const exp = AUDITED.totals[o.letter];
    assert(
      Math.abs(o.annualTotal$ - exp) < 0.005,
      'Option ' + o.letter + ' annual total $' + o.annualTotal$.toFixed(2) + ' must equal audited $' + exp.toFixed(2),
    );
    assert(
      o.paybackYrs != null && Math.abs(o.paybackYrs - +(AUDITED.implCost / exp).toFixed(2)) < 0.005,
      'Option ' + o.letter + ' payback from m.implCost',
    );
  });
} else console.log('  (not the audited project — cent-exact totals not applicable)');

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
assert(!/Energy Use Intensity \(EUI\)<\/h2>/.test(html), 'no separate invented EUI-formula table remains');

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
  assert(html.includes('not statistically separable'), 'no CDD term => documented fallback sentence renders');
}

// ─── 4. Page 5 zones: fallback vs synthetic Equipment Matrix ───────────────────
console.log('\n--- 4. Page 5 zone setpoints: fallback (no EM rows) and synthetic-matrix table ---');
const emKey = 'en_eqmatrix_' + target.projId;
const hasRealEm = !!backup[emKey];
if (!hasRealEm) {
  assert(d.zones.length === 0, 'no Equipment Matrix rows => zones []');
  assert(
    html.includes(
      'Per-zone BAS point data is not available for this building; setpoints below are the proposed building-wide targets only.',
    ),
    'fallback sentence renders verbatim',
  );
  assert(!html.includes('Current Zone Setpoints'), 'no zone table without matrix rows');
} else console.log('  (backup has real matrix rows for this project — fallback branch not exercised here)');
// Synthetic matrix: fake zone names only. Points use the raw-name shape emGetNormalizedPoints
// resolves; a zone with no occupied setpoints must be reported as incomplete, not dropped.
const bName = run(
  ctx,
  'getUDBldg(' +
    JSON.stringify(target.projId) +
    ',' +
    JSON.parse(JSON.stringify(JSON.stringify(target.bldgId))) +
    ').name',
);
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
const ctx2 = buildCtx({ [emKey]: synth });
run(ctx2, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
// The synthetic rows only need the resolver to map their names; if this build's point mapper
// does not resolve these raw names, force the normalized points so the TABLE path is still
// exercised (the resolver itself is the Equipment Matrix's own, tested elsewhere).
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
assert(!html2.includes('Per-zone BAS point data is not available'), 'fallback sentence absent when zones exist');
const pages2 = (html2.match(/class="rpt-page/g) || []).length;
const pages1 = (html.match(/class="rpt-page/g) || []).length;
assert(pages2 === pages1 + 1, 'one extra physical page for the zone sheet (' + pages1 + ' -> ' + pages2 + ')');

// ─── 5. Install cost / payback from m.implCost ─────────────────────────────────
console.log('\n--- 5. Install cost / payback come from the measure ---');
const ctx3 = buildCtx();
run(ctx3, 'udSelProjId = ' + JSON.stringify(target.projId) + ';');
run(
  ctx3,
  `projects.find(function(p){ return String(p.id) === ${JSON.stringify(String(target.projId))}; }).savingsData.measures.forEach(function(m){ if (/Option\\s+[A-C]/i.test(m.desc || '')) m.implCost = 0; });`,
);
const d3 = run(
  ctx3,
  'collectWoodlandReportData(' + JSON.stringify(target.projId) + ',' + JSON.stringify(target.bldgId) + ')',
);
assert(
  d3.options.every((o) => o.installCost === 0 && o.paybackYrs === null),
  'implCost 0 => installCost 0 and payback null (no invented cost)',
);
ctx3.__d = d3;
const html3 = run(ctx3, 'generateWoodlandReportHTML(__d)');
assert(!html3.includes('1,384'), 'no $1,384 anywhere when the measure carries no implementation cost');

// ─── 6. Shared-savings split (2026-09-22, Matt) replaces install cost / payback in the report ──
console.log('\n--- 6. Financials: shared-savings split (client/CSC), no install cost or payback shown ---');
d.options.forEach((o) => {
  assert(
    Math.abs(o.clientShare$ + o.cscShare$ - o.annualTotal$) < 0.005,
    'Option ' + o.letter + ': clientShare$ + cscShare$ cross-foots to annualTotal$',
  );
  assert(
    Math.abs(o.clientShare$ / o.annualTotal$ - 0.7) < 0.01,
    'Option ' + o.letter + ': clientShare$ is ~70% of annualTotal$ (default split)',
  );
});
assert(
  !html.includes('Install Cost') && !html.includes('Simple payback'),
  'report HTML has no Install Cost / Simple payback text',
);
assert(html.includes('Client Share') && html.includes('CSC Share'), 'report HTML shows Client Share / CSC Share');

// ─── 7. HVAC: electric heating kWh line only when slopeHDD is positive ─────────────────────────
console.log('\n--- 7. HVAC: electric heating (kWh) shown only when the regression supports it ---');
if (d.hvac && d.hvac.heatKwh != null) {
  assert(d.hvac.slopeHDD > 0, 'heatKwh present implies slopeHDD > 0');
  assert(html.includes('Estimated Heating Energy — Electric (kWh)'), 'electric heating kWh line renders');
} else {
  console.log('  (this building/backup has no positive electric-heating HDD term — line correctly omitted)');
  assert(
    !html.includes('Estimated Heating Energy — Electric (kWh)'),
    'electric heating kWh line absent when not applicable',
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(failed > 0 ? 1 : 0);
