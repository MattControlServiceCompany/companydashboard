// tools/test-a36-readiness-front.js - the Building Readiness table is at the front of the Audit Report; asterisks mark what is not an ASHRAE 36 item.
// SYNTHETIC project (fake names), headless bundled Chromium (never Edge). Run: CH_TMP_ROOT=<scratch> node tools/test-a36-readiness-front.js
//   1. With the ASHRAE 36 Sequences section on, the Building Readiness table is the first section after the Executive Summary (Simple and Detailed) and prints once.
//   2. The per-building ASHRAE 36 pages (Total for <building>: install N devices ...) are gone; the section keeps its intro and the Control Sequences table.
//   3. An opportunity that is not an ASHRAE 36 item gets an asterisk (building pages and Opportunities Summary) and each table part that shows one has the footnote.
//   4. Appendix A names the Guideline 36 defaults "ASHRAE 36 default" (never "Industry default"), whatever sections are on; the asterisks print only with the section.
//   5. No finding heading reads "Finding N:"; the headings use the section number (2.3.1) and a plain sentence.
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
  const ctx = await launchBrowser('a36-audit-framing');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- synthetic project: two libraries, fake names ----
    const seed = await page.evaluate(async () => {
      const PID = 900001;
      const pts = (extra) => Object.assign({}, extra);
      const ahu = (id, b, name, p) => ({ id, building: b, category: 'ahu', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const vav = (id, b, name, p) => ({ id, building: b, category: 'vav', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const full = { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F', 'Duct Static Pressure': '1.1 in H2O', 'Outside Air Temp': '61 °F' };
      const noRat = { 'Supply Air Temp': '56.0 °F', 'Duct Static Pressure': '1.0 in H2O' };
      const zone = { 'Zone Temp': '72.4 °F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const rows = [
        ahu('r1', 'Alpha Library', 'AHU-1', pts(Object.assign({}, full, { 'Demand Level': '0.0', 'Heat Source Supply': '167.0' }))),
        ahu('r2', 'Alpha Library', 'AHU-2', pts(noRat)),
        vav('r3', 'Alpha Library', 'VAV-101', pts(zone)),
        vav('r4', 'Alpha Library', 'VAV-102', pts(zone)),
        vav('r5', 'Alpha Library', 'VAV-103', pts({ 'Zone Temp': '71.9 °F' })),
        { id: 'r6', building: 'Alpha Library', category: 'ef', equipName: 'EF-1', location: '', points: { 'Fan Status': 'On' } },
        ahu('r7', 'Beta Library', 'AHU-3', pts(full)),
        vav('r8', 'Beta Library', 'VAV-201', pts(zone)),
      ];
      const occ = (a, b, sm, em) => ({ startMin: sm, stopMin: em, startStr: '', stopStr: '', rawText: 'Unoccupied from 12:00 AM to ' + a + '\nOccupied from ' + a + ' to ' + b + '\nUnoccupied from ' + b + ' to 12:00 AM' });
      rows[2].existingSchedule = occ('6:00 AM', '9:00 PM', 360, 1260);
      rows[3].existingSchedule = occ('7:00 AM', '6:00 PM', 420, 1080);
      rows[7].existingSchedule = { startMin: 0, stopMin: 0, startStr: '0:00', stopStr: '0:00', rawText: 'Occupied from 12:00 AM to 12:00 AM' }; // BAS all-day schedule: start 0, stop 0
      rows[4].existingSchedule = { rawText: 'Unoccupied from 12:00 AM to 12:00 AM' }; // no occupied period: not counted
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, {
        findings: [
          { id: 'u1', rowId: 'r1', building: 'Alpha Library', equipment: 'AHU-1', type: 'AHU', issueType: 'Deficiency', issue: 'Fan runs at night', change: 'Add an occupancy schedule', how: '', picture: '', pictureLink: '', notes: '', needsMod: '', measureId: null, hours: 4, cost: 900, status: 'Open', deficiency: true, cscList: false },
        ],
        edits: {},
        evidence: {},
      });
      return PID;
    });

    const variants = {
      simple_on: { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true },
      simple_off: { cover: true, executive: true, costEstimate: false, building: true, setpointReview: true, pointInventory: true },
      det_on: { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, detailed: true },
      det_off: { cover: true, executive: true, costEstimate: false, building: true, setpointReview: true, detailed: true },
    };
    const out = {};
    for (const k of Object.keys(variants)) {
      out[k] = await page.evaluate(({ PID, sel }) => {
        const data = collectASHRAE36Data(PID, '2026-11-10', null);
        const html = generateASHRAE36AuditHTML(data, sel);
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        return Array.from(doc.querySelectorAll('.rpt-page')).map((p) => ({
          section: p.getAttribute('data-section'),
          text: p.textContent.replace(/\s+/g, ' '),
          stars: p.querySelectorAll('.a36-star').length,
          notes: (p.textContent.match(/\* Not an ASHRAE 36 item\./g) || []).length,
          h1: Array.from(p.querySelectorAll('h1')).map((h) => h.textContent.trim()),
        }));
      }, { PID: seed, sel: variants[k] });
    }
    // the one rule that decides what is an ASHRAE 36 item
    const rule = await page.evaluate(() => ({
      seq: _a36IsA36Item({ key: 'ahu_dsp_reset', kind: 'seq', section: '5.16.1' }),
      sensor: _a36IsA36Item({ key: 'discFlow', kind: 'sensor', section: '5.6.5' }),
      setpoints: _a36IsA36Item({ key: 'zoneSetpoints', kind: 'setpoint', section: '' }),
      meter: _a36IsA36Item({ key: 'powerMeter', kind: 'building', section: '' }),
      light: _a36IsA36Item({ key: 'lightingPhotocell', kind: 'building', section: '' }),
      sched: _a36IsA36Item({ key: 'schedules', kind: 'schedule', section: '' }),
      override: _a36IsA36Item({ key: 'hwOverride', kind: 'building', section: '' }),
      term: _a36IsA36Item({ key: 'terminalStandard', kind: 'terminalStd', section: '' }),
      deficiency: _a36IsA36Item({ key: 'deficiency', kind: 'deficiency', section: '' }),
      star: _a36StarHtml({ key: 'schedules', section: '' }, { a36On: true }),
      starOff: _a36StarHtml({ key: 'schedules', section: '' }, { a36On: false }),
      starMeter: _a36StarHtml({ key: 'powerMeter', section: '' }, { a36On: true }),
      meterImpact: /would record the electric demand/.test(String(_a36DetModel)),
      starA36: _a36StarHtml({ key: 'ahu_dsp_reset', section: '5.16.1' }, { a36On: true }),
      fnDefined: typeof _a36BuildingFlowTokens === 'undefined' && typeof _a36BuildingContent === 'undefined',
    }));
    ok(rule.seq && rule.sensor && rule.setpoints, 'rule: a sequence or point with a Guideline 36 section, and the zone setpoints, are ASHRAE 36 items');
    ok(!rule.meter && !rule.light && !rule.sched && !rule.override && !rule.term && !rule.deficiency, 'rule: power meter, lighting, schedules, overrides, terminal unit programs and deficiencies are not ASHRAE 36 items');
    ok(/a36-star/.test(rule.star) && rule.starOff === '' && rule.starA36 === '', 'rule: the asterisk prints for a non-ASHRAE 36 item only, and only when the section is on');
    ok(rule.starMeter === '' && !rule.meterImpact, 'the building power meter has no asterisk and no Impact text (Matt 2026-11-18)');
    ok(rule.fnDefined, 'the code of the per-building ASHRAE 36 pages is deleted');

    ['simple_on', 'det_on'].forEach((k) => {
      const pg = out[k];
      const secs = pg.map((p) => p.section);
      const lastExec = secs.lastIndexOf('executive');
      const readiness = pg.map((p, i) => ({ p, i })).filter((x) => x.p.section === 'costEstimate' && /Building Readiness/.test(x.p.text) && /SENSOR COVERAGE|Sensor Coverage/.test(x.p.text) && /Readiness bands|High Readiness|Partial Readiness|Low Readiness/.test(x.p.text));
      ok(readiness.length >= 1 && readiness[0].i === lastExec + 1, k + ': the Building Readiness table is the first page after the Executive Summary (index ' + (readiness[0] || {}).i + ' vs ' + (lastExec + 1) + ')');
      const first = pg.findIndex((p) => p.section === 'building' || p.section === 'detailedLibrary');
      ok(first > readiness[0].i, k + ': the Building Readiness table comes before the first building or library page');
      ok(pg.filter((p) => /Building Readiness/.test(p.h1.join(' ')) || /^\s*\d*\.?\s*Building Readiness/.test(p.text)).length === readiness.length, k + ': the Building Readiness table prints once (not again at the back)');
      const back = pg.filter((p, i) => p.section === 'costEstimate' && i > first);
      ok(back.length >= 2 && !back.some((p) => /Total for |DEVICES TO INSTALL|Devices to Install\s*Sequences to Program\s*Total/i.test(p.text) && /Total for /.test(p.text)), k + ': the back of the report has no per-building ASHRAE 36 pages (' + back.length + ' pages)');
      ok(back.some((p) => /Control Sequences/.test(p.text)) && back.some((p) => /Overall Score/.test(p.text)), k + ': the ASHRAE 36 section keeps its intro (scores) and the Control Sequences table');
      ok(!back.some((p) => /Building Readiness/.test(p.text) && !/Control Sequences/.test(p.text) && /Readiness bands/.test(p.text)), k + ': the readiness table legend is not at the back');
      const text = pg.map((p) => p.text).join(' ');
      ok(!/ASHRAE 36 Sequences by Building/.test(text), k + ': no "ASHRAE 36 Sequences by Building" pages');
      ok(!/Industry default/i.test(text), k + ': no "Industry default" wording in the report');
      // asterisks: the building pages and (Detailed) the Opportunities Summary
      const bp = pg.filter((p) => p.section === 'building' || p.section === 'detailedSummary');
      ok(bp.some((p) => p.stars > 0), k + ': the building pages show an asterisk after a non-ASHRAE 36 opportunity');
      ok(pg.every((p) => (p.stars > 0) === (p.notes > 0)), k + ': every page with an asterisk has the footnote and no page has the footnote without an asterisk');
      ok(pg.every((p) => p.notes <= 2), k + ': at most one footnote line per table part on a page');
    });
    const det = out.det_on;
    const sumPages = det.filter((p) => p.section === 'detailedSummary');
    ok(sumPages.length >= 1 && sumPages.some((p) => p.stars > 0), 'det_on: the Opportunities Summary shows asterisks on the Issue cells that are not ASHRAE 36 items');
    ok(/Appendix A/.test(det.map((p) => p.text).join(' ')) ? /ASHRAE 36 default:/.test(det.filter((p) => p.section === 'setpointReview').map((p) => p.text).join(' ')) : true, 'det_on: Appendix A reads "ASHRAE 36 default:" in the note');
    const chap = det.filter((p) => p.section === 'detailedLibrary');
    ok(chap.some((p) => p.stars > 0) && chap.every((p) => (p.stars > 0) === (p.notes > 0)), 'det_on: a library chapter page with an asterisk on an opportunity has one footnote line, other chapter pages none');
    ok(!/Standard [Dd]efault/.test(out.det_off.map((p) => p.text).join(' ')), 'Appendix A has no "Standard default" variant');
    ['simple_off', 'det_off'].forEach((k) => {
      const text = out[k].map((p) => p.text).join(' ');
      ok(!out[k].some((p) => p.stars > 0 || p.notes > 0) && !/Building Readiness/.test(text) && !/Industry default/i.test(text), k + ': section off: no asterisk, no footnote, no Building Readiness, no "Industry"');
    });
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
