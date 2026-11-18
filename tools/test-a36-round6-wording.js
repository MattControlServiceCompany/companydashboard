// tools/test-a36-round6-wording.js - round 6 report wording and layout fixes F1-F8 (2026-11-14). SYNTHETIC data only, headless bundled Chromium.
//   F1 the Order of Work table has a row for every step of the plan; a step whose groups all began earlier reads "Finish ...".
//   F2 a single-zone unit with no fan speed point: the finding says "variable frequency drive" (point finding and sequence finding).
//   F3 the single-zone supply fan speed command finding cites ASHRAE 36 Section 5.18.4.
//   F4 Control Sequences cites the sections of the equipment it counts: single-zone 5.18, mixed both, multi-zone 5.16.
//   F5 the Recommended Work step table clears the page footer (the page-fit probe measures at the width a table really gets).
//   F6 the zone damper in a Requires list reads "Terminal Damper Actuator".
//   F7 the cover sentence about the two device counts is in plain words.
//   F8 the Optional cost row says which option "does not program the sensors".
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-round6-wording.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const RE = fs.readFileSync(path.join(ROOT, 'app', 'report-engine.js'), 'utf8');

(async () => {
  const ctx = await launchBrowser('a36-round6');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- F1: Order of Work rows ----
    const f1 = await page.evaluate(() => {
      const realPlan = window._rptA36RecommendedStepPlan;
      const g = (label, isNew) => ({ label: label, isNew: isNew, buildings: [] });
      window._rptA36RecommendedStepPlan = () => ({
        steps: [
          { groups: [], rows: [] },
          { groups: [g('Supply Air Temperature Reset', true), g('Minimum Outdoor Air', true)], rows: [] },
          { groups: [g('Supply Air Temperature Reset', false), g('Economizer', true)], rows: [] },
          { groups: [g('Minimum Outdoor Air', false)], rows: [] },
          { groups: [g('Economizer', false), g('Minimum Outdoor Air', false)], rows: [] },
        ],
        stepCount: 5,
      });
      try {
        const html = _rptA36RecommendedTimelineHTML({ project: { id: 1 } });
        const box = document.createElement('div');
        box.innerHTML = html;
        return [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
      } finally {
        window._rptA36RecommendedStepPlan = realPlan;
      }
    });
    ok(f1.length === 5 && f1.every((r, i) => r[0] === 'Step ' + (i + 1)), 'F1. five steps in the plan give five rows with the same step numbers: ' + JSON.stringify(f1.map((r) => r[0])));
    // Review fix 2026-11-14: the row names every group of its step (the proposal step table names them all); "finish" = the
    // group's last step, "continue" = the group is also in a later step.
    ok(f1[2] && f1[2][1] === 'Economizer; finish Supply Air Temperature Reset.', 'F1. a step with new and ending groups names the new group, then "finish" the earlier one: ' + (f1[2] && f1[2][1]));
    ok(f1[3] && f1[3][1] === 'Continue Minimum Outdoor Air.', 'F1. a group that is also in a later step reads "Continue <name>.": ' + (f1[3] && f1[3][1]));
    ok(f1[4] && f1[4][1] === 'Finish Economizer and Minimum Outdoor Air.', 'F1. two continued groups: "Finish X and Y.": ' + (f1[4] && f1[4][1]));

    // ---- synthetic projects: single-zone only, mixed, multi-zone only ----
    const scen = await page.evaluate(async () => {
      const ahu = (id, b, name, sub, p) => ({ id, building: b, category: 'ahu', subtype: sub, equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const vav = (id, b, name, p) => ({ id, building: b, category: 'vav', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const p1 = { 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F' };
      const p2 = Object.assign({ 'Duct Static Pressure': '1' }, p1);
      const zone = { 'Zone Temp': '72.4 F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const sets = {
        sz: [ahu('s1', 'Alpha Hall', 'AHU-1', 'sz', p1), ahu('s2', 'Alpha Hall', 'AHU-2', 'sz', p1)],
        // single-zone units that read their fan speed (Supply Fan Speed Feedback) but have no speed command: the unit has the drive, so no drive is priced
        szSpeed: [ahu('s1', 'Alpha Hall', 'AHU-1', 'sz', Object.assign({ 'Supply Fan Speed Feedback': '60 %' }, p1)), ahu('s2', 'Alpha Hall', 'AHU-2', 'sz', Object.assign({ 'Supply Fan Speed Feedback': '60 %' }, p1))],
        mixed: [ahu('s1', 'Alpha Hall', 'AHU-1', 'sz', p1), ahu('m1', 'Beta Hall', 'AHU-3', 'mz', p2)],
        mz: [ahu('m1', 'Beta Hall', 'AHU-3', 'mz', p2), vav('v1', 'Beta Hall', 'VAV-1', zone), vav('v2', 'Beta Hall', 'VAV-2', zone)],
      };
      const out = {};
      let pid = 900100;
      for (const k of Object.keys(sets)) {
        pid++;
        projects.push({ id: pid, name: 'Synthetic ' + k, client: 'Synthetic ' + k, type: 'K-12', start: '2025-01-01' });
        await sset('en_eqmatrix_' + pid, { rows: sets[k], importedAt: null, buildings: ['Alpha Hall', 'Beta Hall'] });
        const d = collectASHRAE36Data(pid, '2026-11-10', null);
        const c = _a36DetContext(d);
        const html = generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true });
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const rows = [...tmp.querySelectorAll('tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ')).filter((t) => /Requires:/.test(t));
        out[k] = {
          findings: c.model.findings.map((f) => ({ g: f.groupLabel, kind: f.kind, key: f.key, section: f.section, head: f.headline, impact: f.impact, observed: f.observed })),
          rows: rows,
          text: tmp.textContent.replace(/\s+/g, ' '),
        };
      }
      return out;
    });

    // ---- F2 and F3: findings ----
    const sz = scen.sz.findings;
    const cmd = sz.find((f) => f.kind === 'sensor' && f.key === 'sfSpeedCmd');
    ok(cmd && /no variable frequency drive on (its|their) supply fans?/.test(cmd.head), 'F2. single-zone point finding: the heading says the supply fan has no drive: ' + (cmd && cmd.head));
    ok(cmd && cmd.impact === 'Lets the system change the fan speed. Without a variable frequency drive the fan runs at full speed all the time.', 'F2. single-zone point finding: plain Impact line: ' + (cmd && cmd.impact));
    ok(cmd && cmd.section === '5.18.4' && !/ASHRAE 36, Section/.test(cmd.observed), 'F3. the single-zone supply fan speed command finding keeps section 5.18.4 in the data and cites none in the text: ' + (cmd && cmd.section + ' | ' + cmd.observed));
    const sat = sz.find((f) => f.kind === 'seq' && f.key === 'ahu_sat_reset');
    ok(sat && /no variable frequency drive on (its|their) supply fans?, so .* cannot run\./.test(sat.head) && /Outdoor Air Temp/.test(sat.observed), 'F2. single-zone sequence finding: the heading names the missing drive, Missing keeps the other points: ' + (sat && sat.head + ' | ' + sat.observed));
    ok(sz.every((f) => !/Solution/.test(f.head + ' ' + f.observed)), 'F2. no finding text carries a Solution');
    const mzSeq = scen.mixed.findings.find((f) => f.kind === 'seq' && f.key === 'ahu_sat_reset' && f.section === '5.16.2');
    ok(mzSeq && !/variable frequency drive/i.test(mzSeq.head) && /Outdoor Air Temp/.test(mzSeq.observed) && /Supply Fan Speed/.test(mzSeq.observed), 'F2. a multi-zone unit: no drive in the heading, Missing names both points: ' + (mzSeq && mzSeq.head + ' | ' + mzSeq.observed));
    ok(scen.mixed.findings.some((f) => f.key === 'sfSpeedCmd') === scen.mixed.findings.some((f) => f.key === 'sfSpeedCmd' && f.section === '5.18.4'), 'F3. every single-zone sfSpeedCmd finding has a section');

    // ---- F2 (drive wording follows the price): units that cover sfSpeed but miss sfSpeedCmd ----
    const sp = scen.szSpeed.findings;
    ok(sp.length > 0 && sp.every((f) => !/variable frequency drive/i.test(f.head + ' ' + f.impact)), 'F2. a single-zone group that reads its fan speed but has no speed command: no finding says "variable frequency drive" (the speed command is a $0 controller point): ' + sp.map((f) => f.key + ': ' + f.head));

    // ---- F4: Control Sequences sections ----
    const satRow = (k) => (scen[k].rows.find((t) => /^Supply Air Temperature Reset/.test(t)) || '');
    ok(/Section 5\.18\.4/.test(satRow('sz')) && !/5\.16\.2/.test(satRow('sz')), 'F4. single-zone only: the 5.18 section only: ' + satRow('sz').slice(0, 130));
    ok(/Sections 5\.16\.2 and 5\.18\.4/.test(satRow('mixed')), 'F4. mixed: "Sections 5.16.2 and 5.18.4": ' + satRow('mixed').slice(0, 130));
    ok(/Section 5\.16\.2/.test(satRow('mz')) && !/5\.18/.test(satRow('mz')), 'F4. multi-zone only: unchanged: ' + satRow('mz').slice(0, 130));

    // ---- F6: Requires list ----
    const obv = scen.mz.rows.find((t) => /^Occupancy-Based Ventilation/.test(t)) || '';
    ok(/Terminal Damper Actuator/.test(obv) && !/Actuator, Damper Actuator/.test(obv), 'F6. Occupancy-Based Ventilation lists the zone damper as "Terminal Damper Actuator": ' + obv.slice(0, 150));

    // ---- F5: probe width ----
    ok(/inner\.style\.cssText = 'padding:0 96px'/.test(RE), 'F5. the page-fit probe uses the real content width (96px each side, 624px)');

    // ---- F7, F8: wording ----
    ok(!/zone setpoint control path/.test(RE) && /points on units that do not control a room temperature are not counted/.test(RE), 'F7. the cover sentence uses plain words');
    ok(!/not program the sensors/.test(RE) && !/_rptA36OptionalZoneCo2HTML/.test(RE), 'F8. (2026-11-18) the Optional row is gone: Full Scope includes the room CO2 sensors and sequences');

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
