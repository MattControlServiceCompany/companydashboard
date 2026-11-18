// tools/test-a36-lighting-audit.js: the Audit Report audits the lighting controls (backlog 50b0ecdc, 2026-11-18).
// Lighting is audited equipment (units, chapters, building pages, opportunities) but it is NOT ASHRAE 36 equipment: the scores do not move
// and no lighting text names ASHRAE 36. The three lighting opportunity rules come from the points the units have or lack. SYNTHETIC rows only.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-lighting-audit.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('a36-lighting-audit');
  let fails = 0;
  const ok = (c, m) => {
    if (!c) fails++;
    console.log((c ? 'PASS ' : 'FAIL ') + m);
  };
  const errs = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app|localhost/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof a36LightingFacts === 'function' && typeof collectASHRAE36Data === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      const PID = 'synthetic-lighting-audit';
      const mk = (id, bld, name, cat, pts, loc) => ({ id, building: bld, location: '', equipName: name, equipType: name, category: cat, subtype: '', points: Object.assign({}, pts), pointsRaw: Object.assign({}, pts), checks: {}, schema: 2, bacnetLocation: loc || '' });
      const ahuPts = { 'Supply Air Temp': '55', 'Return Air Temp': '72', 'Supply Fan Status': 'On', 'Supply Fan Speed': '60' };
      const zone = { Schedule: 'On', 'Occupied Control Mode': 'Auto', 'Unoccupied Control Mode': 'Auto', 'Occupancy Sensor Status': 'On', 'Load 1-3 CMD': '2', relayXXX: '0' };
      const base = [
        mk('a1', 'Alpha Hall', 'AHU-1', 'ahu', ahuPts),
        mk('v1', 'Alpha Hall', 'VAV-1', 'vav', { 'Zone Temp': '70', 'Damper Position': '40' }),
        mk('a3', 'Beta Annex', 'AHU-3', 'ahu', ahuPts),
        mk('a4', 'Beta Annex', 'VAV-2', 'vav', { 'Zone Temp': '70' }),
      ];
      const lights = [
        // Alpha Hall: two full interior zones, an exterior unit with a schedule only, a sign left in "other", a statistics program (not a unit)
        mk('l1', 'Alpha Hall', 'LZ-01 Reading Room', 'lighting', zone),
        mk('l2', 'Alpha Hall', 'LZ-02 Stacks', 'lighting', Object.assign({}, zone, { 'Lighting Zone Override': '0' })),
        mk('l3', 'Alpha Hall', 'Exterior Lighting', 'lighting', { Schedule: 'On', 'Load 1 CMD': '1' }),
        mk('l4', 'Alpha Hall', 'Entry Sign', 'other', { Schedule: 'On', relayXXX: '0' }, '/Site/Alpha Hall/Exterior Lighting'),
        mk('l5', 'Alpha Hall', 'Lighting Controller Statistics', 'lighting', { 'CPU Utilization ANI': '3', 'High Carbon Dioxide Level': '0' }),
        // Beta Annex: an exterior unit with a photocell, an interior zone on a schedule only, an interior zone with no schedule point
        mk('l6', 'Beta Annex', 'Exterior Lighting', 'lighting', { Schedule: 'On', 'Exterior Photocell': 'On', relayXXX: '0' }),
        mk('l7', 'Beta Annex', 'LZ-01 Lobby', 'lighting', { Schedule: 'On', relayXXX: '0' }),
        mk('l8', 'Beta Annex', 'LZ-02 Hall', 'lighting', { relayXXX: '0', 'Occupied Control Mode': 'Auto' }),
      ];
      const store = { rows: base, importedAt: null, buildings: [] };
      const realLoad = emLoadMatrix;
      window.emLoadMatrix = (pid) => (pid === PID ? store : realLoad(pid));
      const out = {};
      out.without = collectASHRAE36Data(PID);
      out.scoresWithout = a36ComputeScores(PID);
      store.rows = base.concat(lights);
      const d = collectASHRAE36Data(PID);
      out.scoresWith = a36ComputeScores(PID);
      const sc = (x) => ({ c: x.portfolio.composite, p: x.portfolio.pointPct, s: x.portfolio.seqPct, e: x.portfolio.totalEquip });
      out.scW = sc(out.without);
      out.scL = sc(d);
      out.bldScoresWithout = out.without.buildings.map((b) => [b.name, b.equipCount, b.composite, b.pointPct, b.seqPct]);
      out.bldScoresWith = d.buildings.map((b) => [b.name, b.equipCount, b.composite, b.pointPct, b.seqPct]);
      out.lightN = d.portfolio.totalLighting;
      out.allN = _a36AuditUnitsTotal(d.portfolio);
      out.facts = d.buildings.map((b) => ({ name: b.name, n: b.lighting && b.lighting.count, ext: b.lighting && b.lighting.exterior.length, opps: b.lighting ? b.lighting.opps.map((o) => o.key + ':' + o.n + '/' + o.total) : null }));
      out.ownerEquip = [out.scoresWith.portfolio.equipCount, out.scoresWithout.portfolio.equipCount];
      // Report parts
      const rctx = _a36DetContext(d);
      out.modelKeys = rctx.model.findings.filter((f) => f.category === 'lighting').map((f) => f.lib + '|' + f.key + '|' + f.headline);
      out.cover = rptPageASHRAE36Cover(1, d, true, false);
      out.types = _a36AuditEquipTypes(d);
      out.lightSentence = _a36ExecLightingSentence(d);
      out.bldTokens = d.buildings.map((b) => _a36AuditBuildingTokens(d, b, rctx, false).map((t) => t.html || '').join(' '));
      out.paras = d.buildings.map((b) => _a36DetLightingParas(b.lighting, rctx).join(' '));
      out.overview = d.buildings.map((b) => _a36DetOverviewText(b.name, rctx.model.libs.filter((m) => m.b === b)[0].groups, b.lighting));
      const exec = rptPageASHRAE36Executive(2, d, { execNo: 1, readinessNo: 2 }, 'base');
      out.exec = Array.isArray(exec) ? exec.join(' ') : String(exec);
      out.noLightEquip = d.buildings.every((b) => b.equipResults.every((e) => e.category !== 'lighting'));
      out.statsOf = _a36AuditRingStats(d);
      return out;
    });
    ok(JSON.stringify(r.scW) === JSON.stringify({ c: r.scL.c, p: r.scL.p, s: r.scL.s, e: r.scL.e }), 'lighting rows do not move the portfolio scores or the equipment count: ' + JSON.stringify(r.scW) + ' vs ' + JSON.stringify(r.scL));
    ok(JSON.stringify(r.bldScoresWithout) === JSON.stringify(r.bldScoresWith), 'lighting rows do not move any building score or equipCount: ' + JSON.stringify(r.bldScoresWith));
    ok(r.ownerEquip[0] === r.ownerEquip[1], 'a36ComputeScores equipCount unchanged by lighting: ' + r.ownerEquip);
    ok(r.noLightEquip, 'no lighting row is in equipResults (never scored)');
    // Alpha: LZ-01, LZ-02, Exterior Lighting, Entry Sign (other) = 4 units; the statistics program is not a unit. Beta: 3 units.
    ok(r.lightN === 7 && r.allN === r.scL.e + 7, 'lighting units counted (4 + 3) and added to units audited: ' + r.lightN + ' / ' + r.allN);
    const alpha = r.facts.filter((f) => /Alpha/.test(f.name))[0];
    const beta = r.facts.filter((f) => /Beta/.test(f.name))[0];
    ok(alpha.n === 4 && alpha.ext === 2, 'Alpha: 4 units (the "other" sign counts, the statistics program does not), 2 exterior: ' + JSON.stringify(alpha));
    ok(alpha.opps.length === 1 && alpha.opps[0] === 'lightingPhotocell:2/2', 'Alpha: no photocell on any exterior unit is the only opportunity: ' + JSON.stringify(alpha.opps));
    ok(beta.n === 3 && beta.ext === 1, 'Beta: 3 units, 1 exterior: ' + JSON.stringify(beta));
    ok(beta.opps.length === 2 && beta.opps.indexOf('lightingSchedule:1/3') > -1 && beta.opps.indexOf('lightingOccupancy:1/2') > -1, 'Beta: no schedule point (1 of 3) and no occupancy point (1 of 2 interior): ' + JSON.stringify(beta.opps));
    ok(r.modelKeys.length === 3, 'the findings model holds the 3 lighting opportunities: ' + JSON.stringify(r.modelKeys));
    ok(/lighting control units/i.test(r.cover) && />\s*(\d+)\s*</.test(r.cover), 'the cover counts the lighting units');
    ok(r.types[r.types.length - 1] === '7 Lighting Control Units', 'the equipment-by-type line ends with the lighting units: ' + JSON.stringify(r.types));
    ok(r.bldTokens.every((t) => /Lighting Control Units/.test(t)), 'each building page has a Lighting Control Units row');
    ok(/The building automation system controls .*lighting control units/.test(r.paras[0]) && /photocell point/.test(r.paras[0]), 'Alpha lighting description states units and the missing photocell: ' + r.paras[0]);
    ok(r.overview.every((t) => /lighting control unit/.test(t)), 'the System Overview names the lighting units: ' + r.overview[0]);
    ok(/Lighting Controls/.test(r.exec) && /lighting control units/.test(r.exec), 'the Detailed Executive Summary has a Lighting Controls part');
    const lightText = [r.paras.join(' '), r.modelKeys.join(' '), r.lightSentence, r.overview.join(' ')].join(' ');
    ok(!/ASHRAE|Guideline 36|G36/i.test(lightText), 'no ASHRAE 36 text in any lighting description, opportunity or summary sentence');
    ok(!/\bfinding/i.test(lightText), 'no "finding" in lighting text (opportunity)');
    ok(r.statsOf && r.statsOf.units === r.allN, 'the unit rings count the lighting units: ' + JSON.stringify(r.statsOf));
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e);
  process.exit(1);
});
