// regression-gate.js -- PRE-DEPLOY REGRESSION GATE for CompanyHub.
//
// WHY (Matt, 2026-10-05): "You often break features while adding new features and that is just
// unacceptable." Before this gate the only numeric deploy check was
// scripts/verify-report-reconciliation.js (8 JOCO report figures). Nothing checked the other
// clients' numbers or that pages still open. This is ONE command that does all three:
//   1. PROTECTED NUMBERS per client, computed by the APP itself (its own functions, in a real
//      headless Chromium page, from a COPY of a real backup) and compared to an oracle file that
//      lives OUTSIDE the repo (known-good-values/regression-oracle.json -- client dollar figures
//      never go into git; see feedback_known_good_values_no_git).
//   2. EVERY PAGE / TAB opens with no uncaught JS error and its main control is present.
//   3. The existing report reconciliation harness (child process, own browser, run last).
//
// USAGE
//   node scripts/regression-gate.js [--data <backup.json>] [--oracle <oracle.json>]
//        [--skip-reconcile] [--capture-baseline] [--json <out.json>]
//   Default --data   = newest C:\Users\Matt Miller\Downloads\CompanyHub-localdatafile-*.json
//   Default --oracle = C:\Users\Matt Miller\AI\_context\reference\known-good-values\regression-oracle.json
//   --capture-baseline: add every probe value that has NO oracle entry to the oracle file as tier
//     "baseline-current" (value = what current code computes, NOT a verified truth), then exit 0.
//     Existing entries are never changed. Upgrade an entry's tier/source by hand once a trusted
//     source exists.
// EXIT: 0 = no FAIL. 1 = any FAIL (value moved, probe missing, page error, selector missing,
//   reconciliation harness failed, harness crash).
//
// ORACLE ENTRY  { key, expect, tol?, tier, source, date, note?, knownDefect?: { actual, note } }
//   tier: user-verified | memory | handoff | agent-computed | baseline-current
//   knownDefect: a value that is KNOWN to differ from `expect` today (real pre-existing defect).
//     Reported as XFAIL (does not fail the exit code) ONLY while the app still returns exactly
//     knownDefect.actual. Any other value is FAIL. If the app returns `expect`, it prints
//     "FIXED" -- remove the knownDefect then.
//
// SAFETY: local http server over THIS tree only (127.0.0.1, random port). Bundled Playwright
// Chromium, headless, fresh profile per run, deleted after. Requests to /.netlify/ or any
// supabase/netlify host are aborted -- the gate never reaches live Supabase/Netlify. The backup is
// copied first; the original is never opened for write.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOWNLOADS = 'C:/Users/Matt Miller/Downloads';
const DEFAULT_ORACLE = 'C:/Users/Matt Miller/AI/_context/reference/known-good-values/regression-oracle.json';

// ---- playwright: this tree's install first, then the primary checkout's (worktrees have none) ----
function resolvePlaywright() {
  try {
    return require(path.join(REPO_ROOT, 'node_modules', 'playwright'));
  } catch (e) {
    return require('C:/Users/Matt Miller/AI/companydashboard/node_modules/playwright');
  }
}
const { chromium } = resolvePlaywright();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function newestBackup() {
  const files = fs
    .readdirSync(DOWNLOADS)
    .filter((f) => /^CompanyHub-localdatafile-.*\.json$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('no CompanyHub-localdatafile-*.json in ' + DOWNLOADS);
  return DOWNLOADS + '/' + files[0].f;
}

// ---- where each page's "main control" is. One simple selector per page. ----
const OTHER_PAGES = [
  { name: 'index.html', url: '/index.html', sel: '#loginForm' },
  { name: 'ems-leads.html', url: '/ems-leads.html', sel: '#sb-all' },
];
const SIDEBAR_VIEWS = [
  { id: 'home', sel: '#view-home button' },
  { id: 'projects', sel: '#projTableBody' },
  { id: 'utility', sel: '#view-utility button' },
  { id: 'pdf', sel: '#view-pdf button' },
  { id: 'drawings', sel: '#view-drawings button, #view-drawings input' },
  { id: 'specs', sel: '#view-specs button, #view-specs input' },
  { id: 'webctrl', sel: '#view-webctrl button, #view-webctrl input' },
  { id: 'ems', sel: '#view-ems button' },
];
const PROJECT_TAB_SEL = {
  dashboard: 'button',
  contacts: 'button',
  utility: 'button',
  hvacload: '*',
  energygfx: 'button',
  district: 'input, select',
  setpoints: '*',
  savings: 'button',
  docs: 'button',
  settings: 'input, select',
  'eq-matrix': 'button',
  'bas-trends': 'button',
  'bas-alarms': 'button',
  budget: 'input, select',
  hours: 'table',
  'cost-estimate': 'button',
};

// A console.error that is an actual JS failure (the app also uses console.error for its own
// "[tag] advisory" diagnostics, e.g. cost-estimate allowance notices -- those are not failures).
const JS_FAILURE_RE =
  /^(Uncaught|TypeError|ReferenceError|SyntaxError|RangeError)|is not defined|is not a function|Cannot read propert|Cannot set propert|Unexpected token/;

// ---- the probe: runs INSIDE the real app page. Every number comes from the app's own functions.
// Returns { key: number }. Keys are <project-slug>.<area>.<...>. Nothing here re-derives a metric.
function probeInPage() {
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const r2 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v);
  const out = {};
  const put = (k, v) => {
    out[k] = r2(v);
  };
  const projects = DB.get('en_projects', []) || [];
  const Q = {
    '2026Q1': ['2026-01', '2026-02', '2026-03'],
    '2026Q2': ['2026-04', '2026-05', '2026-06'],
  };
  const BAKER_BILLS = { 'bennett-art-building': 1, 'howard-hall': 1 };
  projects.forEach((p) => {
    const ps = slug(p.name);
    const errs = [];
    // portfolio shape + baseline totals (Utility Data "All Buildings" baseline panel functions)
    try {
      const bl = getUDBldgs(p.id) || [];
      put(ps + '.portfolio.buildings', bl.length);
      put(ps + '.portfolio.buildingsBaselineEligible', getBaselineEligibleBldgs(p.id).length);
      put(
        ps + '.portfolio.meters',
        bl.reduce((s, b) => s + (b.meters || []).length, 0),
      );
      put(
        ps + '.portfolio.bills',
        bl.reduce((s, b) => s + (b.meters || []).reduce((t, m) => t + (m.bills || []).length, 0), 0),
      );
      const months = _udProjBaselineMonthsFallback(bl);
      const rows = bl.map((b) => _udBuildingAllBaseline(b, months));
      const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
      put(ps + '.baseline.all.kwh', sum('kwh'));
      put(ps + '.baseline.all.therms', sum('therms'));
      put(ps + '.baseline.all.cost', sum('cost'));
      rows.forEach((r) => {
        if (!(r.kwh || r.therms || r.cost)) return;
        const bs = ps + '.baseline.bldg.' + slug(r.b.name);
        put(bs + '.kwh', r.kwh);
        put(bs + '.therms', r.therms);
        put(bs + '.cost', r.cost);
        // peak demand = highest metered demand kW across the building's electric meters
        let pk = 0;
        r.meterDetails.forEach((d) => {
          if (d.m.commodity === 'Electric') pk = Math.max(pk, d.totals.demandKW || 0);
        });
        put(bs + '.peakDemandKW', pk);
      });
    } catch (e) {
      errs.push('baseline: ' + e.message);
    }
    // savings totals (the one rollup every consumer uses)
    try {
      const bl = getUDBldgs(p.id) || [];
      const tot = getProjectSavingsTotal(p.id);
      put(ps + '.savings.total', tot.total);
      const perB = {};
      bl.forEach((b) => (perB[b.id] = getBuildingSavingsByYM(b, p.id)));
      Object.keys(Q).forEach((q) => {
        const t = totalSavingsWithPresented(p.id, Q[q], perB);
        put(ps + '.savings.' + q + '.total', t.total);
        if (p.sa) {
          bl.forEach((b) => {
            const v = t.byBldg[b.id];
            if (v) put(ps + '.savings.' + q + '.bldg.' + slug(b.name), v);
          });
        }
      });
      (getPresentedRecords(p.id) || []).forEach((rec) => {
        put(ps + '.presented.' + rec.periodStart + '_' + rec.periodEnd + '.totalDollars', rec.totalDollars);
      });
      put(ps + '.presented.count', (getPresentedRecords(p.id) || []).length);
    } catch (e) {
      errs.push('savings: ' + e.message);
    }
    // Equipment Matrix (rows after the app's own load + classification self-heal)
    try {
      const m = emLoadMatrix(p.id);
      const rows = (m && m.rows) || [];
      if (rows.length) {
        const s = emCalcSummaryStats(rows);
        const a = emComputeAuditStats(rows);
        put(ps + '.em.rows', rows.length);
        put(ps + '.em.buildings', s.buildings);
        put(ps + '.em.pointCoveragePct', a.avgCoverage);
        put(ps + '.em.sequenceReadyPct', a.seqReadinessPct);
        put(ps + '.em.pointTotal', emPointTotal(rows).total);
        const cat = {};
        rows.forEach((r) => (cat[r.category || '?'] = (cat[r.category || '?'] || 0) + 1));
        Object.keys(cat).forEach((c) => put(ps + '.em.cat.' + c, cat[c]));
      }
    } catch (e) {
      errs.push('equipment matrix: ' + e.message);
    }
    // Cost Estimate (all three tiers; workbook or app method, whichever the project is set to)
    try {
      const d = _pricingComputeSummaryData(p.id, _pricingGetEstimate(p.id));
      Object.keys(d.tierTotals).forEach((k) => {
        const t = d.tierTotals[k];
        if (!t || !t.total) return;
        put(ps + '.estimate.' + k + '.phase1', t.phase1);
        put(ps + '.estimate.' + k + '.phase2', t.phase2);
        put(ps + '.estimate.' + k + '.grand', t.grand);
        put(ps + '.estimate.' + k + '.itemsIncluded', t.included);
      });
    } catch (e) {
      errs.push('cost estimate: ' + e.message);
    }
    // Baker bill-level values (certified from KGS OCR debug files; resolveGasUsageTherms is the app's)
    if (/baker/i.test(p.name)) {
      try {
        (getUDBldgs(p.id) || []).forEach((b) => {
          const bs = slug(b.name);
          if (!BAKER_BILLS[bs]) return;
          (b.meters || []).forEach((m) => {
            (m.bills || []).forEach((x) => {
              if (!x.start) return;
              const k = ps + '.bill.' + bs + '.' + x.start;
              put(k + '.therms', resolveGasUsageTherms(x));
              put(k + '.totalCost', parseFloat(x.totalCost));
            });
          });
        });
      } catch (e) {
        errs.push('baker bills: ' + e.message);
      }
    }
    if (errs.length) out['__error.' + ps] = errs.join(' | ');
  });
  return out;
}

// ---- static server over this tree ----
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
};
function startServer() {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(REPO_ROOT, p);
    if (!f.startsWith(REPO_ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      r.writeHead(404);
      return r.end();
    }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)));
}

// ---- results ----
const results = []; // { group, name, status: PASS|FAIL|XFAIL|FIXED|INFO, detail }
const diffs = []; // short diff lines for changed values
function add(group, name, status, detail) {
  results.push({ group, name, status, detail: detail || '' });
}

function fmt(v) {
  return typeof v === 'number' ? String(v) : JSON.stringify(v);
}

function compareNumbers(probe, oracle) {
  const seen = new Set();
  oracle.values.forEach((e) => {
    seen.add(e.key);
    const group = 'numbers:' + e.key.split('.')[0];
    const actual = probe[e.key];
    if (actual === undefined) {
      add(group, e.key, 'FAIL', 'protected value is no longer produced by the app (oracle ' + fmt(e.expect) + ')');
      diffs.push(e.key + ': ' + fmt(e.expect) + ' -> MISSING');
      return;
    }
    const tol = e.tol != null ? e.tol : 0.01;
    if (Math.abs(actual - e.expect) <= tol) {
      if (e.knownDefect) {
        add(group, e.key, 'FIXED', 'now equals oracle ' + fmt(e.expect) + ' - remove knownDefect from the oracle');
      } else {
        add(group, e.key, 'PASS', fmt(actual));
      }
      return;
    }
    if (e.knownDefect && Math.abs(actual - e.knownDefect.actual) <= tol) {
      add(
        group,
        e.key,
        'XFAIL',
        'known defect: app ' + fmt(actual) + ' vs oracle ' + fmt(e.expect) + ' (' + e.knownDefect.note + ')',
      );
      return;
    }
    add(
      group,
      e.key,
      'FAIL',
      'expected ' + fmt(e.expect) + ' got ' + fmt(actual) + ' (diff ' + r6(actual - e.expect) + ') [' + e.tier + ']',
    );
    diffs.push(e.key + ': ' + fmt(e.expect) + ' -> ' + fmt(actual));
  });
  const uncovered = Object.keys(probe).filter((k) => !k.startsWith('__') && !seen.has(k));
  return uncovered;
}
function r6(v) {
  return Math.round(v * 1e6) / 1e6;
}

async function main() {
  const t0 = Date.now();
  const dataSrc = args.data && args.data !== true ? args.data : newestBackup();
  const oraclePath = args.oracle && args.oracle !== true ? args.oracle : DEFAULT_ORACLE;
  if (!fs.existsSync(dataSrc)) throw new Error('backup not found: ' + dataSrc);
  if (!fs.existsSync(oraclePath)) throw new Error('oracle not found: ' + oraclePath + ' (lives outside the repo)');
  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));

  const work = path.join('C:/Temp', 'regression-gate-' + Date.now());
  fs.mkdirSync(work, { recursive: true });
  const dataCopy = path.join(work, 'backup-copy.json');
  fs.copyFileSync(dataSrc, dataCopy);
  const seed = JSON.parse(fs.readFileSync(dataCopy, 'utf8'));
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch (e) {}
  let dirty = '';
  try {
    dirty = execSync('git status --porcelain --untracked-files=no', { cwd: REPO_ROOT }).toString().trim()
      ? '+local-edits'
      : '';
  } catch (e) {}
  console.log('REGRESSION GATE  tree=' + REPO_ROOT + '  commit=' + sha + dirty);
  console.log('backup copy of : ' + dataSrc);
  console.log('oracle         : ' + oraclePath + '  (' + oracle.values.length + ' protected values)');

  const srv = await startServer();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const profile = path.join(work, 'profile');
  let ctx;
  let probe = {};
  try {
    ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1600, height: 1100 } });
    const page = await ctx.newPage();
    // Never reach live Supabase/Netlify. (The app is already hard-wired to 'off' on non-netlify hosts.)
    await page.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
    let pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && JS_FAILURE_RE.test(m.text()))
        pageErrors.push('console.error: ' + m.text().slice(0, 200));
    });
    const takeErrors = () => {
      const e = pageErrors;
      pageErrors = [];
      return e;
    };

    // ---- load + restore the backup copy (real restore engine, replace mode, fresh profile) ----
    await page.goto(base + '/energy-department.html');
    await page.waitForFunction(() => window.__siteUI, null, { timeout: 30000 });
    const nav = page.waitForNavigation({ waitUntil: 'load' });
    nav.catch(() => {});
    const seeded = await page.evaluate(
      (d) => window.__siteUI.restoreData(d, { mode: 'replace', confirm: true, safetyCopy: false }),
      seed,
    );
    await nav;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await page.waitForTimeout(300);
      ready = await page.evaluate(
        () => DB.isReady() && !DB.hasPendingWrites() && (DB.get('en_projects', []) || []).length > 0,
      );
    }
    if (!ready) throw new Error('DB did not settle after restore: ' + JSON.stringify(seeded));
    await page.waitForTimeout(1000);
    const loadErrs = takeErrors();
    add('pages', 'energy-department.html load + restore', loadErrs.length ? 'FAIL' : 'PASS', loadErrs.join(' ; '));

    // ---- 0. weather cache must survive the restore (savings use weather; an empty cache
    // silently moves every weather-normalized savings value) ----
    const wddKeys = Object.keys(seed).filter((k) => /^en_wdd_/.test(k) && seed[k] && Object.keys(seed[k]).length);
    const wddLoaded = await page.evaluate(
      (ks) => ks.filter((k) => { const v = DB.get(k, null); return v && Object.keys(v).length; }),
      wddKeys,
    );
    const wddMissing = wddKeys.filter((k) => wddLoaded.indexOf(k) < 0);
    console.log('weather cache  : ' + wddLoaded.length + '/' + wddKeys.length + ' en_wdd_* keys loaded after restore (' + wddKeys.join(', ') + ')');
    add(
      'pages',
      'weather cache present after restore',
      wddMissing.length ? 'FAIL' : 'PASS',
      wddMissing.length
        ? 'backup has weather but the app cache is empty for: ' + wddMissing.join(', ') + ' -- savings values are NOT weather-normalized'
        : wddLoaded.length + ' keys',
    );

    // ---- 1. protected numbers ----
    probe = await page.evaluate(probeInPage);
    Object.keys(probe)
      .filter((k) => k.startsWith('__error.'))
      .forEach((k) => add('numbers:' + k.slice(8), 'probe ran without exception', 'FAIL', probe[k]));
    const uncovered = compareNumbers(probe, oracle);

    if (args['capture-baseline']) {
      const stamp = new Date().toISOString().slice(0, 10);
      let n = 0;
      uncovered.forEach((k) => {
        oracle.values.push({
          key: k,
          expect: probe[k],
          tol: 0.01,
          tier: 'baseline-current',
          source:
            'captured from current code (commit ' +
            sha +
            dirty +
            ') on ' +
            path.basename(dataSrc) +
            ' -- NOT independently verified',
          date: stamp,
        });
        n++;
      });
      fs.writeFileSync(oraclePath, JSON.stringify(oracle, null, 1));
      console.log('CAPTURE: added ' + n + ' baseline-current entries to ' + oraclePath);
      await ctx.close();
      ctx = null;
      srv.close();
      fs.rmSync(work, { recursive: true, force: true });
      process.exit(0);
    }
    if (uncovered.length) {
      add(
        'numbers:uncovered',
        uncovered.length + ' probe values have no oracle entry',
        'INFO',
        'run --capture-baseline to protect them',
      );
    }

    // ---- 2a. sidebar views ----
    for (const v of SIDEBAR_VIEWS) {
      takeErrors();
      const r = await page.evaluate((a) => {
        const btn = document.querySelector(`.s-item[onclick*="'${a.id}'"]`);
        let thrown = '';
        try {
          sv(a.id, btn);
        } catch (e) {
          thrown = 'threw: ' + e.message;
        }
        const el = document.getElementById('view-' + a.id);
        return { active: !!(el && el.classList.contains('active')), thrown };
      }, v);
      await page.waitForTimeout(350);
      const has = await page.evaluate((s) => document.querySelectorAll(s).length, v.sel);
      const errs = takeErrors();
      if (r.thrown) errs.push(r.thrown);
      const ok = r.active && has > 0 && !errs.length;
      add(
        'pages',
        'view: ' + v.id,
        ok ? 'PASS' : 'FAIL',
        ok ? '' : `active=${r.active} controls(${v.sel})=${has} ${errs.join(' ; ')}`,
      );
    }

    // ---- 2b. every project tab on every project ----
    const projs = await page.evaluate(() => DB.get('en_projects', []).map((p) => ({ id: p.id, name: p.name })));
    for (const p of projs) {
      const openThrown = await page.evaluate((id) => {
        try {
          openDetail(isNaN(Number(id)) ? id : Number(id));
          return '';
        } catch (e) {
          return 'openDetail threw: ' + e.message;
        }
      }, p.id);
      if (openThrown) add('pages', p.name + ': open project', 'FAIL', openThrown);
      await page.waitForTimeout(500);
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#pdTabBar button[data-tab]')].map((b) => b.dataset.tab),
      );
      const expectTabs = Object.keys(PROJECT_TAB_SEL);
      const missingTabs = expectTabs.filter((t) => !tabs.includes(t));
      add(
        'pages',
        p.name + ': tab bar has all tabs',
        missingTabs.length ? 'FAIL' : 'PASS',
        missingTabs.length ? 'missing: ' + missingTabs.join(',') : tabs.length + ' tabs',
      );
      for (const t of tabs) {
        takeErrors();
        const act = await page.evaluate((tab) => {
          const b = document.querySelector(`#pdTabBar button[data-tab="${tab}"]`);
          let thrown = '';
          try {
            sPTab(tab, b);
          } catch (e) {
            thrown = 'threw: ' + e.message;
          }
          const el = document.getElementById('ptab-' + tab);
          return { active: !!(el && el.classList.contains('active')), thrown };
        }, t);
        await page.waitForTimeout(350);
        const sel = PROJECT_TAB_SEL[t] || '*';
        const info = await page.evaluate(
          (a) => {
            const el = document.getElementById('ptab-' + a.t);
            return { has: el ? el.querySelectorAll(a.sel).length : 0, len: el ? el.innerText.length : 0 };
          },
          { t, sel },
        );
        const errs = takeErrors();
        if (act.thrown) errs.push(act.thrown);
        const ok = act.active && info.has > 0 && info.len > 20 && !errs.length;
        add(
          'pages',
          p.name + ': tab ' + t,
          ok ? 'PASS' : 'FAIL',
          ok ? '' : `active=${act.active} controls(${sel})=${info.has} textLen=${info.len} ${errs.join(' ; ')}`,
        );
      }
    }

    // ---- 2c. the other HTML pages ----
    for (const o of OTHER_PAGES) {
      const pg = await ctx.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
      pg.on('console', (m) => {
        if (m.type() === 'error' && JS_FAILURE_RE.test(m.text())) errs.push('console.error: ' + m.text().slice(0, 200));
      });
      await pg.route(/\/\.netlify\/|supabase\.|netlify\.app/i, (r) => r.abort());
      let has = 0;
      try {
        await pg.goto(base + o.url);
        await pg.waitForTimeout(1200);
        has = await pg.evaluate((s) => document.querySelectorAll(s).length, o.sel);
      } catch (e) {
        errs.push('goto: ' + e.message);
      }
      add(
        'pages',
        o.name,
        has > 0 && !errs.length ? 'PASS' : 'FAIL',
        has > 0 && !errs.length ? '' : `controls(${o.sel})=${has} ${errs.join(' ; ')}`,
      );
      await pg.close();
    }
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    srv.close();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {}
  }

  // ---- 3. existing report reconciliation harness (own browser; runs after ours is closed) ----
  if (args['skip-reconcile']) {
    add('reconciliation', 'verify-report-reconciliation.js', 'INFO', 'skipped (--skip-reconcile)');
  } else {
    const rc = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'verify-report-reconciliation.js')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = (rc.stdout || '') + (rc.stderr || '');
    const bad = text
      .split(/\r?\n/)
      .filter((l) => /FAIL|VIOLATION|FATAL|ERROR/i.test(l))
      .slice(0, 6);
    add(
      'reconciliation',
      'verify-report-reconciliation.js (exit ' + rc.status + ')',
      rc.status === 0 ? 'PASS' : 'FAIL',
      rc.status === 0 ? '' : bad.join(' ; ') || text.slice(-300),
    );
  }

  // ---- report ----
  const groups = {};
  results.forEach((r) => {
    const g = r.group.startsWith('numbers:') ? 'numbers' : r.group;
    groups[g] = groups[g] || { PASS: 0, FAIL: 0, XFAIL: 0, FIXED: 0, INFO: 0 };
    groups[g][r.status]++;
  });
  console.log('\n---- per-check results (non-PASS shown; PASS lines collapsed) ----');
  results.forEach((r) => {
    if (r.status !== 'PASS') console.log(`[${r.status}] ${r.group} :: ${r.name}${r.detail ? '  -- ' + r.detail : ''}`);
  });
  console.log('\n---- per-client number checks ----');
  const perClient = {};
  results
    .filter((r) => r.group.startsWith('numbers:'))
    .forEach((r) => {
      const c = r.group.slice(8);
      perClient[c] = perClient[c] || { PASS: 0, FAIL: 0, XFAIL: 0, FIXED: 0, INFO: 0 };
      perClient[c][r.status]++;
    });
  Object.keys(perClient).forEach((c) => {
    const x = perClient[c];
    console.log(`  ${c}: PASS ${x.PASS}  FAIL ${x.FAIL}  XFAIL ${x.XFAIL}  FIXED ${x.FIXED}`);
  });
  console.log('\n---- totals ----');
  Object.keys(groups).forEach((g) => {
    const x = groups[g];
    console.log(`  ${g}: PASS ${x.PASS}  FAIL ${x.FAIL}  XFAIL ${x.XFAIL}  FIXED ${x.FIXED}  INFO ${x.INFO}`);
  });
  if (diffs.length) {
    console.log('\n---- CHANGED VALUES (oracle -> app) ----');
    diffs.slice(0, 40).forEach((d) => console.log('  ' + d));
    if (diffs.length > 40) console.log('  ... ' + (diffs.length - 40) + ' more');
  }
  const nFail = results.filter((r) => r.status === 'FAIL').length;
  const nX = results.filter((r) => r.status === 'XFAIL').length;
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\nREGRESSION GATE ${nFail ? 'FAIL' : 'PASS'}: ${results.filter((r) => r.status === 'PASS').length} pass, ${nFail} fail, ${nX} known-defect (XFAIL)  in ${secs}s`,
  );
  if (args.json && args.json !== true) fs.writeFileSync(args.json, JSON.stringify({ results, probe, diffs }, null, 1));
  process.exit(nFail ? 1 : 0);
}

main().catch((e) => {
  console.error('REGRESSION GATE FAIL: harness crash:', (e && e.stack) || e);
  process.exit(1);
});
