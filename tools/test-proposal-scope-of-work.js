// tools/test-proposal-scope-of-work.js - the Recommended Scope of Work of the Service Proposal (Matt 2026-11-19, redesign: devices and
// programming in total, then ONE line per piece of equipment, then the optional room CO2 scope). SYNTHETIC names and values only;
// headless bundled Chromium; no network.
// Rules tested:
//   1. EVERY priced Recommended row id is in exactly one equipment line (no row twice, none missing); one line per piece of equipment
//      (no two lines of a library have the same lead).
//   2. The device totals of "Devices we furnish and install" equal the device quantities of the priced rows and of the Install and
//      Programming Detail lines (_rptA36OppDetail), per device.
//   3. Every kind of programming shown has a plain definition in A36_SCOPE_PROGRAM; every sequence of EM_SEQUENCE_DEFS has one; every
//      manual override has a plain setpoint name.
//   4. No "(Step" tag, no "Step 1, all buildings:" and no table in the section; the Order of Work table stays.
//   5. The lines say what is installed, programmed and fixed (override release, power meter, photocell, terminal unit upgrade).
//   6. The optional room CO2 scope: its quantity and price are the sum of buildOptionalZoneCo2Rows for the tier, priced by the one totals
//      function; the line "Optional room CO2 sensors (N): $X" is on the Cost Summary and the Cost Estimate for the options that have it;
//      the base totals do not change.
//   7. The proposal prints "Recommended Scope of Work" (no "Recommended Work", no "Why This Approach"); every library name is followed
//      by its first line on the same page; no "Guideline 36", no "finding"; libraries in alphabetical order; "Not included" line.
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
      const norm = (l) => String(l).toLowerCase().replace(/\s+/g, ' ');
      const fromRows = {};
      rowsRec.forEach((r) => {
        if (r.phase === 1 && !r.ioOnly) {
          const k = norm(_rptA36HardwareLabel(r));
          fromRows[k] = (fromRows[k] || 0) + (r.qty || 0);
        }
      });
      const fromDetail = {};
      det.lines.forEach((l) =>
        l.devices.forEach((x) => {
          const k = norm(x.label);
          fromDetail[k] = (fromDetail[k] || 0) + x.qty;
        }),
      );
      const fromScope = {};
      scope.devices.forEach((x) => (fromScope[norm(x.label)] = x.qty));
      // the printed head (the lists) and the printed library blocks (the page tokens)
      const headHtml = _rptA36RecommendedServicesInnerHTML(d);
      const hdoc = new DOMParser().parseFromString('<div>' + headHtml + '</div>', 'text/html');
      const lists = [...hdoc.body.firstChild.querySelectorAll('ul')];
      const printedDev = lists[0] ? [...lists[0].querySelectorAll('li')].map((li) => li.textContent) : [];
      const printedProg = lists[1] ? [...lists[1].querySelectorAll('li')].map((li) => li.textContent) : [];
      const toks = _rptA36ScopeTokens(d);
      const sdoc = new DOMParser().parseFromString('<div>' + toks.map((t) => t.html).join('') + '</div>', 'text/html');
      const lines = [];
      scope.libs.forEach((L) => L.lines.forEach((ln) => lines.push({ lib: L.name, t: ln.text, lead: ln.lead })));
      const ids = [].concat(...scope.libs.map((l) => [].concat(...l.lines.map((b) => b.rowIds))));
      const dupLead = scope.libs.some((L) => new Set(L.lines.map((x) => x.lead)).size !== L.lines.length);
      const scopeText = (hdoc.body.textContent + ' ' + sdoc.body.textContent).replace(/\s+/g, ' ');
      const emKeys = (typeof EM_SEQUENCE_DEFS !== 'undefined' ? EM_SEQUENCE_DEFS : []).map((x) => x.key);
      const noDef = emKeys.concat(['terminalStandard', 'override', 'offlineCheck', 'sensorCheck']).filter((k) => !(A36_SCOPE_PROGRAM[k] && A36_SCOPE_PROGRAM[k].plain && A36_SCOPE_PROGRAM[k].does && A36_SCOPE_PROGRAM[k].noun));
      const shownNoDef = scope.programs.filter((p) => !A36_SCOPE_PROGRAM[p.key]).map((p) => p.key);
      const noOvPlain = A36_DET_OVERRIDE_KEYS.filter((k) => !A36_SCOPE_OVERRIDE_PLAIN[k]);

      // the optional room CO2 scope (Matt 2026-11-13, 2026-11-19)
      const optRows = {};
      const optSum = {};
      ['recommended', 'compliance'].forEach((t) => {
        const rws = buildOptionalZoneCo2Rows(PID, t);
        const on = rws.filter((r) => tg[r._baseId || r.id] !== false);
        const priced = _pricingApplyQtyOverrides(PID, _pricingApplyLaborOverrides(PID, rws));
        const foot = _rptA36FootOf(_pricingComputeTotals(priced, est, PID));
        optRows[t] = { qty: on.filter((r) => r.phase === 1).reduce((a, r) => a + (r.qty || 0), 0), price: foot ? foot.totalR : null };
        const o = _rptA36TierCostData(d).optionalCo2[t];
        optSum[t] = o ? { qty: o.qty, price: o.price, line: _rptA36OptionalCo2Line(o) } : null;
      });
      const baseGrand = {};
      const baseSame = ['recommended', 'compliance', 'full-scope'].every((t) => {
        const split = _pricingTierRowsSplit(PID, t).base;
        const tot = _pricingComputeTotals(_pricingApplyQtyOverrides(PID, _pricingApplyLaborOverrides(PID, split)), est, PID);
        baseGrand[t] = tot.grand;
        return sd.tierTotals[t] && sd.tierTotals[t].grand === tot.grand;
      });
      const fullOpt = _rptA36TierCostData(d).optionalCo2['full-scope'] || null;

      // the rendered proposal
      const sec = {};
      (ASHRAE36_SECTIONS.proposal || []).forEach((s) => (sec[s.key] = s.defaultOn !== false));
      sec.costEstimate = true;
      const html = generateASHRAE36ProposalHTML(d, sec);
      const host = document.createElement('div');
      host.innerHTML = html;
      const pagesEls = [...host.querySelectorAll('.rpt-page')];
      const scopePages = pagesEls.filter((pg) => /Recommended Scope of Work/.test(pg.textContent) || /Scope of Work \(\d+ of \d+\)/.test(pg.getAttribute('data-label') || ''));
      const headOrphans = [];
      pagesEls.forEach((pg, i) => {
        const body = pg.querySelector('.rpt-body') || pg;
        const heads = [...body.querySelectorAll('div')].filter((e) => e.style && e.style.fontWeight === '700' && e.style.fontSize === '14px' && /Library$/.test(e.textContent) && e.children.length === 0);
        heads.forEach((h) => {
          if (!(h.nextElementSibling && h.nextElementSibling.tagName === 'UL')) headOrphans.push(i + 1 + ': ' + h.textContent);
        });
      });
      const allText = host.textContent.replace(/\s+/g, ' ');
      const optLineCount = (allText.match(/Optional: \d+ room CO2 sensors?( with occupancy-based ventilation| \(sensors only\))?: \+\$[\d,]+/g) || []).length;
      const tablesInScope = scopePages.filter((pg) => pg.querySelector('table')).length;
      const res = {
        nRows: rowsRec.length,
        idsOnce: ids.length === new Set(ids).size,
        idsEqualRows: ids.length === rowsRec.length && rowsRec.every((r) => ids.indexOf(r.id) > -1),
        dupLead,
        fromRows, fromDetail, fromScope, printedDev, printedProg,
        noDef, shownNoDef, noOvPlain,
        texts: lines.map((b) => b.lib + ' :: ' + b.t),
        libs: scope.libs.map((l) => l.name),
        stepTag: /\(Steps? \d/.test(scopeText) || /Step 1, all buildings:/.test(allText),
        hasHeading: /Recommended Scope of Work/.test(allText),
        oldHeading: /Recommended Work|Why This Approach|What you get:/.test(allText),
        tablesInScope,
        headOrphans,
        bad: /Guideline 36|\bfinding/i.test(scopePages.map((p) => p.textContent).join(' ')),
        orderTable: /Recommended: Order of Work/.test(allText),
        notIncluded: /Not included in Recommended:/.test(scopeText),
        optRows, optSum, baseSame, baseGrand, fullOpt, optLineCount,
        optText: /Optional: \d+ room CO2 sensors/.test(scopeText),
        oldCo2Wording: /Recommended and Compliance do not\.|Compliance does not include the/.test(allText),
      };
      window._a36OpportunityList = real;
      return res;
    });

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    ok(out.nRows > 0, 'the synthetic project has Recommended rows (' + out.nRows + ')');
    ok(out.idsOnce && out.idsEqualRows, '1. every priced Recommended row id is in exactly one equipment line (' + out.nRows + ' rows) (Matt 2026-11-19)');
    ok(!out.dupLead, '1. one line per piece of equipment: no two lines of a library have the same lead (Matt 2026-11-19)');
    const eq = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    ok(sum(out.fromRows) > 0 && eq(out.fromRows, out.fromDetail), '2. the device quantities of the priced rows equal the Install and Programming Detail (' + sum(out.fromRows) + ' devices)');
    ok(eq(out.fromDetail, out.fromScope), '2. the device totals of the scope equal the Detail, per device: ' + JSON.stringify(out.fromScope) + ' (Matt 2026-11-19)');
    const printedQty = out.printedDev.map((t) => Number((/^(\d+) /.exec(t) || [0, 0])[1])).reduce((a, b) => a + b, 0);
    ok(out.printedDev.length === Object.keys(out.fromDetail).length && printedQty === sum(out.fromDetail), '2. the printed list "Devices we furnish and install" adds up to the Detail: ' + printedQty + ' of ' + sum(out.fromDetail) + ' (Matt 2026-11-19)');
    ok(out.printedProg.length > 0 && out.printedProg.every((t) => /^[A-Z].*\((all )?\d[\d,]* .*\): [a-z]/.test(t)), '3. every programming bullet is "Name (N units): what it does": ' + out.printedProg.join(' || '));
    ok(out.noDef.length === 0 && out.shownNoDef.length === 0, '3. every sequence type has a plain definition in A36_SCOPE_PROGRAM (missing: ' + out.noDef.concat(out.shownNoDef).join(', ') + ') (Matt 2026-11-19)');
    ok(out.noOvPlain.length === 0, '3. every manual override has a plain setpoint name (missing: ' + out.noOvPlain.join(', ') + ')');
    ok(!out.stepTag, '4. no "(Step N)" tag and no "Step 1, all buildings:" in the scope section (Matt 2026-11-19)');
    ok(out.tablesInScope === 0, '4. no table in the scope section (' + out.tablesInScope + ')');
    ok(out.orderTable, '4. the Order of Work table stays');
    const has = (re) => out.texts.some((t) => re.test(t));
    ok(has(/Alpha Library :: AHU-A[^:]*: .*Fix: remove the manual override on the supply air temperature setpoint\.$/), '5. an override is "Fix: remove the manual override on the ... setpoint" on the line of its unit');
    ok(has(/Beta Library :: Building: Install 1 building power meter and connect it to the BAS\.$/), '5. the power meter: "Building: Install 1 building power meter and connect it to the BAS."');
    ok(has(/Alpha Library :: Lighting: Install \d+ exterior lighting photocell/), '5. the photocell: "Lighting: Install ... exterior lighting photocell"');
    ok(has(/Beta Library :: Lighting: Install .*5 occupancy sensors for interior lighting/), '5. the interior occupancy sensors are in the Lighting line');
    ok(has(/:: \d+ zone terminal units?: Program: terminal unit program upgrade\.$/) || !out.texts.some((t) => /terminal/i.test(t)), '5. a terminal unit upgrade names the units: "N zone terminal units: Program: terminal unit program upgrade."');
    ok(out.texts.every((t) => /Install:|Program:|Fix:|: Install /.test(t)), '5. every line has an Install, Program or Fix part');
    ok(out.optRows.recommended.qty > 0 && out.optSum.recommended && out.optSum.recommended.qty === out.optRows.recommended.qty, '6. the optional room CO2 sensors of Recommended = the sum of buildOptionalZoneCo2Rows (' + out.optRows.recommended.qty + ') (Matt 2026-11-19)');
    ok(out.optSum.recommended && out.optSum.recommended.price === out.optRows.recommended.price, '6. the optional price of Recommended is the one totals function on those rows (' + out.optRows.recommended.price + ') (Matt 2026-11-19)');
    // The synthetic Compliance sensors have no price: an unpriced optional scope is left out, never printed with a null price.
    ok(out.optRows.compliance.qty > 0 && (out.optRows.compliance.price === null ? out.optSum.compliance === null : out.optSum.compliance && out.optSum.compliance.qty === out.optRows.compliance.qty && out.optSum.compliance.price === out.optRows.compliance.price), '6. the same for Compliance (' + out.optRows.compliance.qty + ' sensors, price ' + out.optRows.compliance.price + '; an unpriced scope is left out)');
    ok(out.fullOpt === null, '6. Full Scope has no optional scope');
    ok(out.optSum.recommended && /^Optional: \d+ room CO2 sensors with occupancy-based ventilation: \+\$[\d,]+$/.test(out.optSum.recommended.line), '6. the line reads "Optional: N room CO2 sensors with occupancy-based ventilation: +$X": ' + (out.optSum.recommended && out.optSum.recommended.line));
    const expLines = (out.optRows.recommended.price !== null ? 3 : 0) + (out.optRows.compliance.price !== null ? 3 : 0);
    ok(out.optLineCount === expLines && expLines >= 2, '6. the line is on the Cost Summary, the Cost Estimate and the scope (Compliance: its Work sentence) for each priced option that has it (' + out.optLineCount + ' of ' + expLines + ')');
    ok(out.baseSame, '6. the base totals do not change: the tier totals are the totals of the base rows only ' + JSON.stringify(out.baseGrand));
    ok(out.optText && !out.oldCo2Wording, '6. the optional block is in the scope and the old "do not include" wording is gone');
    ok(out.hasHeading && !out.oldHeading, '7. the proposal prints "Recommended Scope of Work" and no "Recommended Work", "Why This Approach" or "What you get:"');
    ok(out.headOrphans.length === 0, '7. every library name is followed by its first line: ' + JSON.stringify(out.headOrphans));
    ok(!out.bad, '7. no "Guideline 36" and no "finding" in the scope text');
    ok(out.notIncluded, '7. the "Not included in Recommended:" line is printed');
    ok(JSON.stringify(out.libs) === JSON.stringify(out.libs.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))), '7. the libraries are in alphabetical order: ' + out.libs.join(', '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
