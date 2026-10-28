/**
 * gate-contract-rates-frozen.js
 *
 * Under a signed contract a measure's saved rates and projected dollars are frozen: nothing may change
 * `rates`, `rateSource`, `rateFlag` or `totalDollar`. This gate loads the real page (headless bundled Chromium,
 * SYNTHETIC fixture with fake ids and fake numbers) and runs every program path that writes a measure rate or
 * totalDollar: the Savings tab render, followOwnerMeasureRates, a building change on a measure, the rate input
 * (svUpdateMsrRate), reset rates (svResetMsrRates), calcProjSavingsMatrix, svRecalc, writeRateField, writeRateSet,
 * ensureMeasureRates, the solar and BAS apply, and the setpoint options apply. After each path the
 * four fields of every measure must be byte-identical. A control project WITHOUT a contract must change under the
 * same paths, so the test cannot pass because nothing ran.
 *
 * Usage: node tools/gate-contract-rates-frozen.js [repo-root]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const problems = [];

const CPID = 990011; // contracted
const NPID = 990012; // control, no contract
const mk = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const gas = mk(12, (i) => {
  const th = [300, 250, 180, 100, 50, 30, 25, 25, 40, 90, 180, 280][i];
  const cost = (th * 1.5 + 23.33).toFixed(2);
  const m = String(i + 1).padStart(2, '0');
  const em = String(((i + 1) % 12) + 1).padStart(2, '0');
  return {
    id: 'g' + i,
    start: '2025-' + m + '-01',
    end: (i === 11 ? '2026-' : '2025-') + em + '-01',
    therms: String(th),
    gasCharge: String(th * 1.5),
    customerCharge: '23.33',
    fuelAdjustment: '0',
    thermCost: cost,
    totalCost: cost,
  };
});
const udData = { buildings: [{ id: 'fb1', name: 'Fixture School', sqft: '1000', meters: [{ id: 'fm1', commodity: 'Gas', provider: 'Test', bills: gas, baseline: { months: mk(12, (i) => '2025-' + String(i + 1).padStart(2, '0')) } }] }] };
const measures = () =>
  [1, 2].map((n) => ({
    id: 'fx_m' + n,
    name: 'Fixture measure ' + n,
    bldgId: 'fb1',
    selected: true,
    kwh: Array(12).fill(10 * n),
    kw: Array(12).fill(1 * n),
    gas: Array(12).fill(5 * n),
    propane: Array(12).fill(0),
    rates: { kwSummer: 7.77, kwWinter: 6.66, kwhSummer: 0.0123, kwhWinter: 0.0111, thermRate: 0.4321 },
    totalDollar: 1234.5 * n,
  }));
// fx_m3: a contract measure with NO saved rates (ensureMeasureRates / initMeasureRates must not fill it).
// fx_m4: a saved setpoint-option measure (letter A) that the setpoint options apply would rewrite.
const extraMeasures = () => [
  { id: 'fx_m3', name: 'Fixture measure 3', bldgId: 'fb1', selected: true, kwh: Array(12).fill(3), kw: Array(12).fill(0), gas: Array(12).fill(0), propane: Array(12).fill(0), totalDollar: 999 },
  {
    id: 'fx_m4',
    name: 'Fixture option',
    bldgId: 'fb1',
    selected: true,
    basOption: { letter: 'A', heatSP: 68, coolSP: 76 },
    kwh: Array(12).fill(4),
    kw: Array(12).fill(0),
    gas: Array(12).fill(4),
    propane: Array(12).fill(0),
    rates: { kwSummer: 7.77, kwWinter: 6.66, kwhSummer: 0.0123, kwhWinter: 0.0111, thermRate: 0.4321 },
    rateSource: 'manual',
    totalDollar: 777,
  },
];
const mkProj = (id, contract) =>
  Object.assign(
    {
      id,
      name: 'Fixture ' + id,
      type: 'school',
      solarCalc: { arrayKw: 5, production: Array(12).fill(111) },
      _bcResults: { kwhSavings: Array(12).fill(50), gasSavings: Array(12).fill(10), gasUnit: 'Therms', peakKwhSavings: null },
      savingsData: { measures: measures().concat(extraMeasures()), blRates: {} },
    },
    contract ? { contractType: 'fixedProject', sa: { signed: true } } : {},
  );
const fixture = { en_projects: [mkProj(CPID, true), mkProj(NPID, false)] };
[CPID, NPID].forEach((id) => {
  fixture['en_utility_' + id] = udData;
  fixture['en_utility_cust_' + id] = udData;
});

async function main() {
  const PW_MODULES =
    process.env.CH_PLAYWRIGHT_NODE_MODULES ||
    path.join(process.env.CH_CONTEXT_DIR || path.join(os.homedir(), 'AI', '_context'), 'tools', 'playwright-runtime', 'node_modules');
  const { chromium } = require(path.join(PW_MODULES, 'playwright'));
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    fs.readFile(path.join(REPO, p), (e, b) => {
      if (e) {
        r.writeHead(404);
        r.end();
        return;
      }
      r.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
      r.end(b);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const prof = path.join(os.tmpdir(), 'contract-frozen-gate-profile-' + Date.now());
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, args: ['--disable-gpu'], viewport: { width: 1600, height: 1000 } });
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    page.on('pageerror', (e) => problems.push('page error: ' + e.message));
    await page.addInitScript(() => {
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false }));
      localStorage.setItem('ch_backend_mode', 'off');
      localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo', email: 'demo@example.com', demo: true }));
    });
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(3000);
    await page.evaluate(async (fx) => {
      for (const k of Object.keys(fx)) {
        if (typeof _restoreIsLsKey === 'function' && _restoreIsLsKey(k)) localStorage.setItem(k, JSON.stringify(fx[k]));
        else await DB.set(k, fx[k]);
      }
    }, fixture);
    await page.reload();
    await page.waitForTimeout(4000);
    const res = await page.evaluate(
      async ([cpid, npid]) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const rows = (ms) =>
          JSON.stringify(
            ms.map((m) => [m.id, JSON.stringify(m.rates), m.rateSource === undefined ? 'U' : m.rateSource, JSON.stringify(m.rateFlag === undefined ? null : m.rateFlag), m.totalDollar, JSON.stringify([m.kwh, m.kw, m.gas])]),
          );
        const snap = (pid) => rows(getProjSavingsData(pid).measures);
        const paths = {
          'ensureMeasureRates (no saved rates)': (pid) => ensureMeasureRates(getProjSavingsData(pid).measures.find((x) => x.id === 'fx_m3'), pid, 'gate'),
          'Savings tab render': (pid) => {
            const d = document.createElement('div');
            document.body.appendChild(d);
            _renderSavingsContent(d, pid);
            d.remove();
          },
          'Savings tab (open project)': async (pid) => {
            openDetail(pid);
            await sleep(500);
            sPTab('savings', document.querySelector('#pdTabBar button[data-tab="savings"]'));
            await sleep(800);
          },
          followOwnerMeasureRates: (pid) => followOwnerMeasureRates(pid, getProjSavingsData(pid)),
          'building change write': (pid) => updateMsrField(pid, 'fx_m1', 'bldgId', 'fb1'),
          svUpdateMsrRate: async (pid) => {
            svSelProjId = pid;
            await svUpdateMsrRate('fx_m1', 'kwhSummer', '0.5', null);
          },
          svResetMsrRates: (pid) => {
            svSelProjId = pid;
            svResetMsrRates('fx_m1');
          },
          calcProjSavingsMatrix: (pid) => calcProjSavingsMatrix(pid),
          svRecalc: (pid) => {
            svSelProjId = pid;
            svRecalc();
          },
          'writeRateField (direct)': (pid) => writeRateField(getProjSavingsData(pid).measures[0], 'rates', 'kwhSummer', 0.9, pid),
          'writeMeasureTotal (direct)': (pid) => writeMeasureTotal(pid, getProjSavingsData(pid).measures[0], 42),
          'writeRateSet (direct)': (pid) => writeRateSet(getProjSavingsData(pid).measures[0], 'rates', { kwhSummer: 0.9, thermRate: 0.9 }, pid, 'fb1', 'gate', true),
          'solar apply': (pid) => {
            _calcTemplateContext = { projId: pid, returnTo: 'sv', targetMeasureId: 'fx_m3', bldgId: 'fb1' };
            solarApplyToMeasure(pid);
          },
          'BAS apply': (pid) => {
            _calcTemplateContext = { projId: pid, returnTo: 'sv', targetMeasureId: 'fx_m3', bldgId: 'fb1' };
            bcApplyToMeasure(pid);
          },
          'setpoint options apply': (pid) => {
            const r = { kwhSummer: 0.5, kwhWinter: 0.5, kwSummer: 5, kwWinter: 5, gasSummer: 0.9, gasWinter: 0.9 };
            wdApplySetpointOptions(pid, 'fb1', { options: [{ letter: 'A', heatSP: 66, coolSP: 78 }], rates: r, zonesTotal: 10, zonesActive: 10, pctPerDegF: 3, occCoolSharePct: 40, occHeatSharePct: 40, unoccNetTherms: 500, curOccCool: 74, curOccHeat: 70, demandFloorKw: 0 });
          },
        };
        const out = { contracted: {}, control: {}, persisted: null, baseline: snap(cpid) };
        for (const [name, fn] of Object.entries(paths)) {
          const before = snap(cpid);
          try {
            await fn(cpid);
          } catch (e) {
            out.contracted[name] = 'threw ' + e.message;
            continue;
          }
          await sleep(300);
          out.contracted[name] = snap(cpid) === before ? 'same' : 'CHANGED';
        }
        // control: the same paths on a project with no contract must change something
        const cb = snap(npid);
        const moved = [];
        for (const [name, fn] of Object.entries(paths)) {
          const b = snap(npid);
          try {
            // the control rate input opens the rate-check popup and waits for a click: do not wait for it
            await Promise.race([Promise.resolve(fn(npid)), sleep(1500)]);
          } catch (e) {
            /* a path that throws on the control moves nothing */
          }
          if (snap(npid) !== b) moved.push(name);
        }
        out.errors = [];
        out.dbg = JSON.stringify(computeSeasonalBldgRates(npid, 'fb1')).slice(0, 300);
        out.control = { baselineDiffers: snap(npid) !== cb, moved };
        out.persisted = rows(DB.get('en_projects', []).find((p) => p.id === cpid).savingsData.measures);
        out.final = snap(cpid);
        return out;
      },
      [CPID, NPID],
    );
    Object.entries(res.contracted).forEach(([name, v]) => {
      if (v !== 'same') problems.push('contracted project: ' + name + ' -> ' + v);
    });
    if (res.final !== res.baseline) problems.push('contracted project: rates / rateSource / rateFlag / totalDollar differ from the fixture after all paths');
    if (res.persisted !== res.baseline) problems.push('contracted project: the saved en_projects copy differs from the fixture');
    ['writeRateField (direct)', 'writeRateSet (direct)', 'writeMeasureTotal (direct)', 'ensureMeasureRates (no saved rates)', 'solar apply', 'BAS apply', 'setpoint options apply'].forEach((n) => {
      if (!res.control.moved.includes(n)) problems.push('control (no contract) did not change under "' + n + '": that path is not exercised');
    });
    if (!res.control.moved.length) problems.push('control (no contract) did not change under any path: the fixture does not exercise the writers');
    if (process.env.GATE_DEBUG) console.log(res.dbg);
    console.log('paths that changed the no-contract control: ' + res.control.moved.join(', '));
  } finally {
    await ctx.close();
    srv.close();
    try {
      fs.rmSync(prof, { recursive: true, force: true });
    } catch (e) {
      /* profile already gone */
    }
  }
}
main()
  .then(() => {
    if (problems.length) {
      console.log('FAIL\n- ' + problems.join('\n- '));
      process.exit(1);
    }
    console.log('PASS gate-contract-rates-frozen: 14 write paths leave a contracted project byte-identical');
  })
  .catch((e) => {
    console.log('FAIL ' + e.stack);
    process.exit(1);
  });
