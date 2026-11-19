// tools/test-proposal-scope-of-work.js - the Recommended Scope of Work of the Service Proposal (Matt 2026-11-19). SYNTHETIC names and values only;
// headless bundled Chromium; no network.
// Rules tested:
//   1. One bullet per cost line of the Recommended option (an opportunity of one building, or an "Included" item of one building).
//   2. EVERY priced Recommended row is in exactly one bullet (no row twice, none missing).
//   3. The device quantities printed in the bullets add up, per building and device, to the quantities of the priced rows and of the
//      Install and Programming Detail lines (_rptA36OppDetail).
//   4. Every bullet names its step, and the step exists in the one step plan (_rptA36RecommendedStepPlan).
//   5. The wording says what is installed and what is programmed (override release, power meter, photocell, terminal unit upgrade).
//   6. The proposal prints "Recommended Scope of Work" (no "Recommended Work", no "Why This Approach", no step table); every building name
//      is followed by its first bullet on the same page; no table in the section; no "Guideline 36", no "finding".
// Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-scope-of-work.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('proposal-scope');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptA36RecommendedScope === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const PID = 900960;
      const mk = (id, b, cat, name, p) => ({ id, building: b, category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      const zone = (h, c) => ({ 'Zone Temp': '72.4 F', 'Air Flow': '200', 'Damper Position': '40', 'Zone Heating Setpoint': String(h), 'Zone Cooling Setpoint': String(c) });
      const sp = (h, c, uh, uc) => ({ 'Setpoint / Heating Occupied Setpoint': String(h), 'Setpoint / Cooling Occupied Setpoint': String(c), 'Setpoint / Heating Unoccupied Setpoint': String(uh), 'Setpoint / Cooling Unoccupied Setpoint': String(uc) });
      const rows = [
        mk('a1', 'Alpha Library', 'ahu', 'AHU-A', Object.assign({ 'Supply Air Temp': '55.2 F' }, sp(66, 71, 60, 79))),
        mk('a2', 'Alpha Library', 'ahu', 'AHU-B', Object.assign({ 'Supply Air Temp': '55.2 F' }, sp(66, 71, 60, 79))),
        mk('v1', 'Alpha Library', 'vav', 'Room 1 - VAV-1', zone(72, 74)),
        mk('v2', 'Alpha Library', 'vav', 'Room 2 - VAV-2', zone(73, 74)),
        mk('f1', 'Alpha Library', 'fpb', 'Room 4 - FPB-1', zone(72, 74)),
        mk('b1', 'Beta Library', 'vav', 'Room 6 - VAV-4', zone(70, 75)),
        mk('b2', 'Beta Library', 'vav', 'Room 7 - VAV-5', zone(70, 75)),
      ];
      projects.push({ id: PID, name: 'Synthetic Scope District', client: 'Synthetic Scope District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      emSaveEquipConfigFlags(PID, 'a1', { hasCO2: true });
      emSaveEquipConfigFlags(PID, 'a2', { hasCO2: true });

      // The opportunities of the first run: the stubbed list adds the override, photocell, occupancy and power meter lines.
      const real = window._a36OpportunityList;
      const S = (b, key, kind, units, label, aff) => ({ bName: b, lib: b, key, kind, label: label || key + ' label', units, affected: aff || [], missingKeys: [], groupLabel: kind === 'building' ? 'Building-wide' : 'Group' });
      const stub = real(collectASHRAE36Data(PID, '2026-11-19', null)).concat([
        S('Alpha Library', 'satOverride', 'building', 1, 'Supply air temperature reset overridden', ['AHU-A - Alpha']),
        S('Alpha Library', 'lightingPhotocell', 'building', 3),
        S('Beta Library', 'lightingOccupancy', 'building', 5),
        S('Beta Library', 'powerMeter', 'building', 0),
      ]);
      window._a36OpportunityList = () => stub;
      const d = collectASHRAE36Data(PID, '2026-11-19', null);
      const sd = _rptA36ProposalSummaryData(d);
      const est = _pricingGetEstimate(PID);
      const tg = est.rowToggles || {};
      const rowsRec = (sd.perTier.recommended || []).filter((r) => tg[r._baseId || r.id] !== false);
      const scope = _rptA36RecommendedScope(d);
      const det = _rptA36OppDetail(sd, est, 'recommended', sd.tierTotals);
      const plan = _rptA36RecommendedStepPlan(d);
      const norm = (l) => String(l).toLowerCase().replace(/\s+/g, ' ').replace(/s(?=( in | for | on |$))/, '');
      const fromRows = {};
      rowsRec.forEach((r) => {
        if (r.phase === 1 && !r.ioOnly) {
          const k = r.building + '|' + norm(_rptA36HardwareLabel(r));
          fromRows[k] = (fromRows[k] || 0) + (r.qty || 0);
        }
      });
      const fromDetail = {};
      det.lines.forEach((l) => {
        const dm = /Devices: (.*?)\.( Programming|$)/.exec(l.desc);
        if (dm)
          dm[1].split(/, (?=\d)/).forEach((p) => {
            const q = /^(\d+) (.*)$/.exec(p.trim());
            const k = l.opp.lib + '|' + norm(q[2]);
            fromDetail[k] = (fromDetail[k] || 0) + Number(q[1]);
          });
      });
      // the printed bullets (the page tokens)
      const toks = _rptA36ScopeTokens(d);
      const sdoc = new DOMParser().parseFromString('<div>' + toks.map((t) => t.html).join('') + '</div>', 'text/html');
      const fromScope = {};
      const bullets = [];
      let lib = null;
      [...sdoc.body.firstChild.children].forEach((el) => {
        if (el.tagName === 'DIV') lib = el.textContent;
        else
          el.querySelectorAll('li').forEach((li) => {
            const t = li.textContent;
            bullets.push({ lib, t });
            const im = /nstall (.*?)( and program| and connect|\.| \(Step)/.exec(t);
            if (im && /^\d/.test(im[1]))
              im[1].split(/, | and (?=\d)/).forEach((p) => {
                const q = /^(\d+) (.*)$/.exec(p.trim());
                if (q) {
                  const k = lib + '|' + norm(q[2]);
                  fromScope[k] = (fromScope[k] || 0) + Number(q[1]);
                }
              });
          });
      });
      const ids = [].concat(...scope.libs.map((l) => [].concat(...l.bullets.map((b) => b.rowIds))));
      const incGroups = det.included.reduce((s, it) => s + new Set((it.rows || []).map((r) => r.building)).size, 0);

      // the rendered proposal
      const sec = {};
      (ASHRAE36_SECTIONS.proposal || []).forEach((s) => (sec[s.key] = s.defaultOn !== false));
      sec.costEstimate = true;
      const html = generateASHRAE36ProposalHTML(d, sec);
      const host = document.createElement('div');
      host.innerHTML = html;
      const pagesEls = [...host.querySelectorAll('.rpt-page')];
      const scopePages = pagesEls.filter((pg) => /Recommended Scope of Work/.test(pg.textContent) || /Scope of Work \(\d+ of \d+\)/.test(pg.getAttribute('data-label') || ''));
      const bodies = pagesEls.map((pg) => pg.querySelector('.rpt-body') || pg);
      const headOrphans = [];
      pagesEls.forEach((pg, i) => {
        const body = pg.querySelector('.rpt-body') || pg;
        const heads = [...body.querySelectorAll('div')].filter((e) => e.style && e.style.fontWeight === '700' && e.style.fontSize === '14px' && /Library$/.test(e.textContent) && e.children.length === 0);
        heads.forEach((h) => {
          if (!(h.nextElementSibling && h.nextElementSibling.tagName === 'UL')) headOrphans.push(i + 1 + ': ' + h.textContent);
        });
      });
      const allText = host.textContent.replace(/\s+/g, ' ');
      const scopeStart = pagesEls.findIndex((pg) => /Recommended Scope of Work/.test(pg.textContent));
      const scopeEnd = pagesEls.findIndex((pg) => /Recommended: Order of Work|Cost Estimate/.test(pg.textContent));
      const tablesInScope = scopePages.filter((pg) => pg.querySelector('table')).length;
      const res = {
        nRows: rowsRec.length,
        nBullets: bullets.length,
        nLines: det.lines.length,
        incGroups,
        idsOnce: ids.length === new Set(ids).size,
        idsEqualRows: ids.length === rowsRec.length && rowsRec.every((r) => ids.indexOf(r.id) > -1),
        fromRows, fromDetail, fromScope,
        stepless: scope.libs.reduce((s, l) => s + l.bullets.filter((b) => !b.step).length, 0),
        maxStep: Math.max.apply(null, [0].concat([].concat(...scope.libs.map((l) => l.bullets.map((b) => Number((/(\d+)\)$/.exec(b.step) || [0, 0])[1])))))),
        stepCount: plan && plan.stepCount,
        texts: bullets.map((b) => b.lib + ' :: ' + b.t),
        libs: scope.libs.map((l) => l.name),
        hasHeading: /Recommended Scope of Work/.test(allText),
        oldHeading: /Recommended Work|Why This Approach|What you get:/.test(allText),
        tablesInScope,
        scopePages: scopePages.length,
        headOrphans,
        bad: /Guideline 36|\bfinding/i.test(scopePages.map((p) => p.textContent).join(' ')),
        orderTable: /Recommended: Order of Work/.test(allText),
        step1Once: (allText.match(/Step 1, all buildings:/g) || []).length,
      };
      window._a36OpportunityList = real;
      return res;
    });

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    ok(out.nRows > 0 && out.nLines > 0, 'the synthetic project has Recommended rows (' + out.nRows + ') and cost lines (' + out.nLines + ')');
    ok(out.nBullets === out.nLines + out.incGroups, '1. one bullet per cost line and per Included item of a building (' + out.nBullets + ' = ' + out.nLines + ' + ' + out.incGroups + ')');
    ok(out.idsOnce && out.idsEqualRows, '2. every priced Recommended row is in exactly one bullet (' + out.nRows + ' rows)');
    const eq = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    ok(sum(out.fromRows) > 0 && eq(out.fromRows, out.fromDetail), '3. the device quantities of the priced rows equal the Install and Programming Detail (' + sum(out.fromRows) + ' devices)');
    ok(eq(out.fromDetail, out.fromScope), '3. the device quantities of the bullets equal the Detail per building and device: ' + JSON.stringify(out.fromScope));
    ok(out.stepless === 0 && out.maxStep >= 2 && out.maxStep <= out.stepCount, '4. every bullet names its step; the steps exist in the step plan (max step ' + out.maxStep + ' of ' + out.stepCount + ')');
    const has = (re) => out.texts.some((t) => re.test(t));
    ok(has(/Alpha Library :: AHU-A: release the manual override on the supply air temperature reset, so it runs again \(Step \d\)\.$/), '5. an override reads "release the manual override on the ..., so it runs again" with the unit name');
    ok(has(/Beta Library :: Install 1 building power meter and connect it to the building automation system \(Step \d\)\.$/), '5. the power meter reads "Install 1 building power meter and connect it to the building automation system"');
    ok(has(/Alpha Library :: Install 1 exterior lighting photocell \(Step \d\)\.$/), '5. the photocell is installed: "Install 1 exterior lighting photocell"');
    ok(has(/Beta Library :: Install 5 occupancy sensors for interior lighting/), '5. the interior occupancy sensors: "Install 5 occupancy sensors for interior lighting"');
    ok(has(/:: Upgrade the programs of \d+ terminal units? to the ASHRAE 36 standard/) || !out.texts.some((t) => /terminal/i.test(t)), '5. a terminal unit upgrade names the units and the standard');
    ok(out.texts.every((t) => /\(Steps? \d( to \d)?\)\.$/.test(t)), '5. every bullet ends with its step and a period');
    ok(out.hasHeading && !out.oldHeading, '6. the proposal prints "Recommended Scope of Work" and no "Recommended Work", "Why This Approach" or "What you get:" (Matt 2026-11-19)');
    ok(out.tablesInScope === 0, '6. no table in the scope section (' + out.tablesInScope + ')');
    ok(out.headOrphans.length === 0, '6. every building name is followed by its first bullet: ' + JSON.stringify(out.headOrphans));
    ok(!out.bad, '6. no "Guideline 36" and no "finding" in the scope text');
    ok(out.orderTable && out.step1Once === 1, '6. the Order of Work table stays; Step 1 is said once in the scope head (' + out.step1Once + ')');
    ok(JSON.stringify(out.libs) === JSON.stringify(out.libs.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))), '6. the buildings are in alphabetical order: ' + out.libs.join(', '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
