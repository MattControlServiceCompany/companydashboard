// tools/test-a36-effect-text.js: the Effect column of the Opportunities Summary of the Audit Report says HOW the fix helps, energy first
// (Matt 2026-11-22 3f54bb50; replaces the two labels "Energy use" and "Equipment control"). SYNTHETIC rows only, no client names.
// Rules tested: a missing point, a savings sequence, a non-savings sequence, the power meter, a lighting item and an override each print their short
// phrase in the Effect cell; no row prints "Equipment control" or "Energy use"; every phrase is 3 to 7 words with no digit, no ASHRAE section and no
// word "finding"; every sequence of EM_SEQUENCE_DEFS has a phrase in SEQUENCE_SAVINGS_IMPACT.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-effect-text.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('a36-effect-text');
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
    await page.waitForFunction(() => typeof a36LightingFacts === 'function' && typeof collectASHRAE36Data === 'function' && typeof _a36DetSummaryTokens === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      const PID = 'synthetic-effect-text';
      const mk = (id, bld, name, cat, pts) => ({ id, building: bld, location: '', equipName: name, equipType: name, category: cat, subtype: '', points: Object.assign({}, pts), pointsRaw: Object.assign({}, pts), checks: {}, schema: 2, bacnetLocation: '' });
      const ahuPts = { 'Supply Air Temp': '55', 'Return Air Temp': '72', 'Supply Fan Status': 'On', 'Supply Fan Speed': '60' };
      const zone = { Schedule: 'On', 'Occupied Control Mode': 'Auto', 'Unoccupied Control Mode': 'Auto', 'Occupancy Sensor Status': 'On', 'Load 1-3 CMD': '2', relayXXX: '0' };
      const rows = [
        mk('a1', 'Alpha Hall', 'AHU-1', 'ahu', ahuPts),
        mk('a2', 'Alpha Hall', 'AHU-2', 'ahu', ahuPts),
        mk('a3', 'Alpha Hall', 'AHU-3', 'ahu', ahuPts),
        mk('v1', 'Alpha Hall', 'VAV-1', 'vav', { 'Zone Temp': '70', 'Damper Position': '40' }),
        mk('l3', 'Alpha Hall', 'Exterior Lighting', 'lighting', { Schedule: 'On', 'Load 1 CMD': '1' }),
        mk('l7', 'Alpha Hall', 'LZ-01 Lobby', 'lighting', { Schedule: 'On', relayXXX: '0' }),
      ];
      const store = { rows: rows, importedAt: null, buildings: [] };
      const realLoad = emLoadMatrix;
      window.emLoadMatrix = (pid) => (pid === PID ? store : realLoad(pid));
      const d = collectASHRAE36Data(PID);
      const cx = _a36DetContext(d);
      const list = cx.model.findings;
      const toks = _a36DetSummaryTokens(cx, 5);
      const cells = toks.filter((t) => t.type === 'row').map((t) => {
        const tr = document.createElement('table');
        tr.innerHTML = '<tbody>' + t.html + '</tbody>';
        return Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
      });
      const gapOk = Object.keys(ASHRAE36_GAP_DESCRIPTIONS).filter((k) => !/^(ahu_|vav_|hwp_|chwp_|sp[A-Z])/.test(k)).filter((k) => !ASHRAE36_GAP_DESCRIPTIONS[k].effect);
      const words = (x) => String(x).trim().split(/\s+/).length;
      const allPhrases = Object.keys(ASHRAE36_GAP_DESCRIPTIONS).map((k) => ASHRAE36_GAP_DESCRIPTIONS[k].effect).filter(Boolean)
        .concat(Object.keys(SEQUENCE_SAVINGS_IMPACT).map((k) => SEQUENCE_SAVINGS_IMPACT[k].effect))
        .concat(A36_DET_OVERRIDE.map((o) => o.effect), [A36_TERM_STD_EFFECT]);
      return {
        gapMissing: gapOk,
        seqDefsMissing: EM_SEQUENCE_DEFS.map((s) => s.key).filter((k) => !(SEQUENCE_SAVINGS_IMPACT[k] && SEQUENCE_SAVINGS_IMPACT[k].effect)),
        badPhrases: allPhrases.filter((x) => !x || words(x) < 3 || words(x) > 7 || /\d|finding|ASHRAE|Section/i.test(x)),
        // Matt 2026-11-23 00b22d26: an effect is a reduction ("Less energy wasted on outdoor air"), never an absolute claim ("No ...", "Prevents", "Avoids").
        absolutePhrases: allPhrases.concat(list.map((f) => f.effect)).filter((x) => /^(No|Prevents|Avoids)|not wasted/.test(String(x))),
        overrideMissing: A36_DET_OVERRIDE.filter((o) => !o.effect).map((o) => o.key),
        keys: list.map((f) => [f.kind, f.key, f.effect]),
        cells: cells,
        savingsDsp: SEQUENCE_SAVINGS_IMPACT.ahu_dsp_reset.effect + '|' + SEQUENCE_SAVINGS_IMPACT.ahu_dsp_reset.type,
        enabler: SEQUENCE_SAVINGS_IMPACT.hwp_staging.effect + '|' + SEQUENCE_SAVINGS_IMPACT.hwp_staging.type,
        dspGap: ASHRAE36_GAP_DESCRIPTIONS.dsp.effect,
      };
    });
    ok(r.gapMissing.length === 0, 'every missing-point entry of ASHRAE36_GAP_DESCRIPTIONS has an effect phrase; without: ' + (r.gapMissing.join(',') || 'none'));
    ok(r.seqDefsMissing.length === 0, 'every sequence of EM_SEQUENCE_DEFS has an effect phrase in SEQUENCE_SAVINGS_IMPACT; without: ' + (r.seqDefsMissing.join(',') || 'none'));
    ok(r.overrideMissing.length === 0, 'every override of A36_DET_OVERRIDE has an effect phrase');
    ok(r.badPhrases.length === 0, 'every phrase is 3 to 7 words, no digit, no ASHRAE section, no "finding": ' + JSON.stringify(r.badPhrases));
    ok(r.absolutePhrases.length === 0, 'no effect phrase claims an absolute result (No/Prevents/Avoids) (Matt 2026-11-23 00b22d26): ' + JSON.stringify(r.absolutePhrases));
    ok(r.savingsDsp === 'Cuts fan energy at part load|savings', 'a savings sequence: ' + r.savingsDsp);
    ok(r.enabler === 'Only the boilers needed run|enabler', 'a non-savings sequence: ' + r.enabler);
    ok(r.dspGap === 'Cuts fan energy at part load', 'a missing point (duct static pressure sensor): ' + r.dspGap);
    const eff = (kind, key) => r.keys.filter((k) => k[0] === kind && (key === null || k[1] === key)).map((k) => k[2]);
    ok(r.keys.length > 0 && r.keys.every((k) => k[2] && k[2] !== 'Equipment control' && k[2] !== 'Energy use'), 'no opportunity of the model has the old labels: ' + JSON.stringify(r.keys.filter((k) => !k[2] || /^(Equipment control|Energy use)$/.test(k[2]))));
    ok(eff('building', 'powerMeter').join() === 'Shows where energy is used', 'the power meter: ' + eff('building', 'powerMeter').join());
    ok(eff('building', 'lightingPhotocell').join() === 'Lights off in daylight', 'a lighting item (photocell): ' + eff('building', 'lightingPhotocell').join());
    ok(eff('building', 'lightingOccupancy').join() === 'Lights off when rooms are empty', 'a lighting item (occupancy): ' + eff('building', 'lightingOccupancy').join());
    ok(eff('seq', null).length > 0 && eff('seq', null).every((x) => x.split(' ').length >= 3), 'sequence opportunities carry their phrase: ' + JSON.stringify(eff('seq', null)));
    ok(eff('sensor', null).length > 0, 'a missing point opportunity exists in the synthetic project: ' + JSON.stringify(eff('sensor', null)));
    ok(r.cells.length === r.keys.length && r.cells.every((c) => c.length === 5 && c[4] && !/^(Equipment control|Energy use)$/.test(c[4])), 'every Opportunities Summary row prints its phrase in the Effect cell, never "Equipment control" or "Energy use": ' + JSON.stringify(r.cells.map((c) => c[4])));
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
