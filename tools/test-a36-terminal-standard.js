// tools/test-a36-terminal-standard.js - the terminal unit opportunity of the Audit Report: the control programs of the terminal units compared with the
// Control Service Company standard terminal unit sequence (2026-11-18, backlog f3b50ab2). SYNTHETIC names and values only; headless bundled Chromium; no network.
// Rules tested (each with a positive and a negative case):
//   - a terminal unit whose control program page was read (an en_auditseq row) and that lacks a feature of the standard is named by ONE opportunity per library;
//   - a feature counts against a unit only when the stored points show the unit can run it (heating device, occupancy sensor, CO2 sensor);
//   - a dual-duct terminal and a cooling-only terminal are never claimed to lack the reheat features;
//   - a unit with no row is unknown: it is not counted as read and never named;
//   - a feature the program shows (an enabled row) is not claimed; a row that is not enabled does not count as present;
//   - a library whose read units lack nothing has no opportunity;
//   - the opportunity counts with distinct units (_a36AuditAffectedUnits), reads from one table (A36_TERM_STD) in the headline, the Impact and the Executive Summary,
//     names no client, no county and no other project, and never says "finding".
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-terminal-standard.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('a36-terminal-standard');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36TerminalStandardUnits === 'function' && typeof A36_TERM_STD !== 'undefined' && typeof collectASHRAE36Data === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const r = await page.evaluate(async () => {
      const PID = 900189;
      const base = { zt: '72 °F', cs: '74', hs: '70' };
      const zone = { 'Zone Temp': base.zt, 'Zone Cooling Setpoint': base.cs, 'Zone Heating Setpoint': base.hs };
      const heat = Object.assign({}, zone, { 'Heating Valve': '0 %' });
      const occ = Object.assign({}, heat, { 'Occupancy Sensor': 'Occupied' });
      const full = Object.assign({}, occ, { 'Zone CO2': '600 ppm' });
      const row = (id, b, cat, name, pts) => ({ id, building: b, category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: pts });
      const rows = [
        row('a1', 'Test Library', 'vav', 'VAV-1', heat),
        row('a2', 'Test Library', 'vav', 'VAV-2', full),
        row('a3', 'Test Library', 'vav', 'VAV-3', full),
        row('a4', 'Test Library', 'vav', 'VAV-4', heat), // no row: unknown
        row('a5', 'Test Library', 'ddvav', 'DD-1', heat), // dual duct: reheat features do not apply
        row('a6', 'Test Library', 'vav', 'VAV-6', zone), // cooling only
        row('a7', 'Test Library', 'vav', 'VAV-7', heat), // lockout row that is not enabled: still lacks
        row('b1', 'Full Library', 'vav', 'VAV-1', heat), // the program shows both features
        row('c1', 'Quiet Library', 'vav', 'VAV-1', heat), // no program page read at all
      ];
      projects.push({ id: PID, name: 'Synthetic Terminal Project', client: 'Synthetic Terminal Project', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: [] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const on = (lib, name, id) => ({ library: lib, equipName: name, id: id, status: 'enabled', source: 'x.png' });
      await sset('en_auditseq_' + PID, {
        rows: [
          on('Test Library', 'VAV-1', 'optimal_start'),
          on('Test Library', 'VAV-2', 'optimal_start'),
          on('Test Library', 'VAV-3', 'optimal_start'),
          on('Test Library', 'VAV-3', 'zone_vacant_setback'),
          on('Test Library', 'VAV-3', 'co2_zone_airflow'),
          on('Test Library', 'VAV-3', 'heat_oa_lockout'),
          on('Test Library', 'DD-1', 'optimal_start'),
          on('Test Library', 'VAV-6', 'optimal_start'),
          on('Test Library', 'VAV-7', 'optimal_start'),
          Object.assign(on('Test Library', 'VAV-7', 'heat_oa_lockout'), { status: 'available_not_enabled' }),
          on('Full Library', 'VAV-1', 'optimal_start'),
          on('Full Library', 'VAV-1', 'terminal_dat_control'),
          on('Full Library', 'VAV-1', 'heat_oa_lockout'),
        ],
        updated: 'x',
      });
      const d = collectASHRAE36Data(PID, '2026-11-18', null);
      const cx = _a36DetContext(d);
      const fs = cx.model.findings.filter((f) => f.kind === 'terminalStd');
      const one = (lib) => fs.filter((f) => f.lib === lib)[0] || null;
      const t = one('Test Library');
      const out = {
        libs: fs.map((f) => f.lib),
        t: t && { units: t.units, total: t.total, read: t.read, affected: t.affected.slice().sort(), keys: t.stdKeys, headline: t.headline, impact: t.impact, label: t.label, effect: t.effect, category: t.category, groupLabel: t.groupLabel, key: t.key },
        distinct: Object.keys(_a36AuditAffectedUnits(fs.concat(fs), 'Test Library')).sort(),
        para: _a36ExecTerminalStandardParagraph(d),
        devGroups: _a36ExecDeviceGroups(d).map((g) => g.label),
        info: _a36AuditFindingInfo(d),
      };
      // the owner function directly, for the unread count
      const b = d.buildings.filter((x) => x.name === 'Test Library' || _a36DisplayName(x) === 'Test Library')[0];
      const ts = _a36TerminalStandardUnits(b, _a36DetGroups(b, _a36DetRowsById(PID)), _a36DetRowsById(PID), PID);
      out.ts = { total: ts.total, read: ts.read, items: ts.items.map((i) => i.name + ':' + i.lacks.join('+')).sort() };
      // no record at all: no opportunity anywhere
      await sset('en_auditseq_' + PID, { rows: [], updated: 'x' });
      const d2 = collectASHRAE36Data(PID, '2026-11-18', null);
      out.noRows = _a36DetContext(d2).model.findings.filter((f) => f.kind === 'terminalStd').length;
      out.noRowsPara = _a36ExecTerminalStandardParagraph(d2);
      return out;
    });

    ok(JSON.stringify(r.libs) === '["Test Library"]', 'one opportunity, at the library with units that lack features (not Full Library, not Quiet Library): ' + JSON.stringify(r.libs));
    ok(r.ts.total === 7 && r.ts.read === 6, 'owner function: 7 terminal units, 6 read (the unit with no row is unknown): ' + JSON.stringify(r.ts));
    ok(
      JSON.stringify(r.ts.items) === JSON.stringify(['VAV-1:dat+lockout', 'VAV-2:dat+lockout+standby+co2', 'VAV-3:dat', 'VAV-7:dat+lockout'].sort()),
      'each unit lacks only what its points show it can run and its program page does not show: ' + JSON.stringify(r.ts.items)
    );
    ok(r.t && r.t.units === 4 && r.t.total === 6 && r.t.read === 6, 'the opportunity counts 4 units of the 6 read: ' + JSON.stringify(r.t && [r.t.units, r.t.total]));
    ok(r.t && r.t.affected.join(',') === 'VAV-1,VAV-2,VAV-3,VAV-7', 'it names the four units, not the dual-duct, cooling-only or unread units');
    ok(r.distinct.length === 4 && r.distinct.join(',') === 'Test Library|vav-1,Test Library|vav-2,Test Library|vav-3,Test Library|vav-7', 'distinct units through _a36AuditAffectedUnits (the opportunity listed twice counts each unit once): ' + JSON.stringify(r.distinct));
    ok(r.t && r.t.keys.join(',') === 'dat,lockout,standby,co2', 'features named in the table order: ' + (r.t && r.t.keys.join(',')));
    ok(
      r.t && r.t.headline === 'The control programs of 4 of the 6 terminal units the audit read have no discharge air temperature control with a 50°F floor, no heating lockout above 50°F outdoor air, no occupancy standby and no CO2 ventilation reset. The Control Service Company standard terminal unit sequence includes each of these.',
      'headline, as printed: ' + (r.t && r.t.headline)
    );
    ok(
      r.t &&
        r.t.impact.indexOf('Discharge air temperature control with a 50°F floor holds the air') === 0 &&
        r.t.impact.indexOf('A heating lockout above 50°F outdoor air keeps the reheat off') > -1 &&
        r.t.impact.indexOf('Occupancy standby widens the zone setpoints by 3°F') > -1 &&
        r.t.impact.indexOf('CO2 ventilation reset raises the zone minimum airflow') > -1,
      'Impact holds one expert sentence per feature, in table order'
    );
    ok(
      r.t && /The audit read the control program page of 6 of the 7 terminal units of the library and states nothing about the other 1\. The audit recommends upgrading the terminal unit programs of the library to the Control Service Company standard terminal unit sequence\.$/.test(r.t.impact),
      'Impact ends with the extent of the reading and the recommendation: ' + (r.t && r.t.impact.slice(-260))
    );
    ok(r.t && r.t.key === 'terminalStandard' && r.t.effect === 'Energy use' && r.t.category === 'vav' && r.t.groupLabel === 'Zone terminal units', 'key, effect, equipment type and group of the opportunity');
    ok(
      r.para.indexOf('The audit compared the terminal unit control programs with the Control Service Company standard terminal unit sequence. At Test Library, the audit read the control programs of 6 terminal units. 4 of them lack one or more of the features of that sequence: discharge air temperature control with a 50°F floor, heating lockout above 50°F outdoor air, occupancy standby and CO2 ventilation reset. These features protect a zone in heating from cold discharge air, save reheat energy in mild weather, save heating, cooling and fan energy in vacant zones and save ventilation energy in lightly used zones.') === 0,
      'Executive Summary paragraph: ' + r.para
    );
    ok(/The audit recommends upgrading the terminal unit programs at these libraries to the standard\. Each library with such terminal units counts as one opportunity\.$/.test(r.para), 'Executive paragraph ends with the recommendation and the counting rule');
    ok(r.devGroups.every((g) => !/terminal unit programs/i.test(g)), 'the opportunity is not listed as a missing device');
    ok(r.noRows === 0 && r.noRowsPara === '', 'no program page read: no opportunity and no paragraph');
    ok(r.info && r.info.byLib['Test Library'] >= 1, 'the opportunity counts in the audit totals of the library');
    const all = JSON.stringify([r.t, r.para]);
    ok(!/\bfinding/i.test(all), 'the word finding is not used');
    ok(!/JOCO|Johnson|county|Lenexa|Monticello|Shawnee|Leawood|Gardner|Central Resource/i.test(all), 'no client, county or other project is named');
    ok(!/ASHRAE/i.test(all), 'no ASHRAE text outside its own section');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
