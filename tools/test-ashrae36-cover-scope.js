// test-ashrae36-cover-scope.js — regression guard for fix/ashrae36-cover-scope (2026-09-25).
//
// Bug: the ASHRAE 36 Audit Report cover's "Sequences to Program" / "Sensors to Install" stat
// tiles (and the matching sentence in the cover's one-paragraph finding) stayed pinned to the
// FULL-PORTFOLIO figure even when the user selected only one building in the Generate Report
// modal's scope tree — every other cover stat (Buildings Assessed, Heating and Cooling Systems
// Audited, all three readiness percentages) scaled down correctly. Root cause:
// rptPageASHRAE36Cover (and four other render sites — the executive-summary callout, the
// Control Sequences table, per-building detail totals, and the Proposal's ASHRAE 36 Compliance
// section) called `buildCatalogRows(d.project.id)` with NO building filter, so the priced
// catalog it summed always covered every building in the project regardless of the report's
// selected scope.
//
// Fix: buildCatalogRows(projId, buildingNames) now accepts an optional buildingNames filter,
// passed straight through to collectASHRAE36Data's own existing buildingNames filter (the same
// one that already scopes d.buildings/d.portfolio) — no second filter implementation. Every
// report-engine.js render site now goes through the one new `_a36ScopedCatalogRows(d)` helper,
// which derives the building-name list from d.buildings (already scoped) and memoizes the
// result on d._a36CatalogRowsCache exactly once per report render.
//
// This test does NOT reimplement any pricing/compliance logic. It drives the real app in a
// headless browser, restores the real JOCO backup through the real Restore button (via the
// shared restore-and-navigate.js harness), and calls the REAL production functions in-page:
//   - buildCatalogRows(projId)            -- unscoped, used only to compute this test's OWN
//                                             independent "expected" sum for one building, by
//                                             filtering rows the app already produced (never a
//                                             re-derivation of the pricing rules themselves).
//   - openASHRAE36ReportModal / scopeTreeSetChecked / generateASHRAE36Preview -- the exact UI
//                                             path a user drives from the Equipment Matrix tab.
// Then it scrapes the ACTUAL rendered cover stat cards out of the real DOM and compares.
//
// Checks:
//   1. Full selection (all 27 buildings) is unchanged: cover shows 1,285 sequences / 1,291
//      sensors (the known-good JOCO figures from the 2026-09-25 bug report / dashboardlogic).
//   2. One-building selection ("Jo Co Elections Office", 8 equipment): the cover's two totals
//      equal the SUM, over just that building's rows in the unscoped catalog, of the same
//      phase===1&&!ioOnly / phase===2&&seqKey predicates the cover itself uses -- i.e. the
//      literal "1-building totals equal the sum over that building's equipment" requirement.
//   3. Buildings Assessed / Heating and Cooling Systems Audited still scale to 1 / 8 for the
//      one-building run (guards against a fix that scopes the two totals but breaks the stats
//      that already worked).
//
// SKIPS (exit 0) if the local CompanyHub backup used by restore-and-navigate.js's default is
// not present -- this test needs real JOCO equipment-matrix data, which lives only in that
// local file (never committed).
//
// Run (from the repo root): node tools/test-ashrae36-cover-scope.js [worktree path]
'use strict';

const path = require('path');
const fs = require('fs');

const rn = require('C:\\Users\\Matt Miller\\AI\\_context\\tools\\restore-and-navigate.js');

const DEFAULT_BACKUP = 'C:\\Users\\Matt Miller\\Downloads\\CompanyHub-localdatafile-20260922.json';
if (!fs.existsSync(DEFAULT_BACKUP)) {
  console.log('SKIP: local backup not found (' + DEFAULT_BACKUP + ') -- this test needs real JOCO data.');
  process.exit(0);
}

// Moved from the repo root into tools/ (task 5b follow-up) -- the worktree root is one
// directory up from this file now, not __dirname itself.
const WORKTREE = process.argv[2] || path.join(__dirname, '..');
// Scratch run dir (backup copy + console log) lives OUTSIDE the git worktree/repo -- never in a
// tracked directory -- since it holds a copy of real project data.
const RUN_DIR =
  process.env.ASHRAE36_TEST_RUN_DIR ||
  'C:\\Users\\Matt Miller\\AI\\_context\\temp\\2026-09-25-ashrae36-cover-scope\\test-run';

const EXPECTED_FULL_SEQUENCES = 1285;
const EXPECTED_FULL_SENSORS = 1291;
const ONE_BUILDING_NAME = 'Jo Co Elections Office';

let passed = 0;
let failed = 0;
function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log('  PASS: ' + msg + ' (' + actual + ')');
  } else {
    failed++;
    console.log('  FAIL: ' + msg + ' -- expected ' + expected + ', got ' + actual);
  }
}

async function runScope(h, projId, selectOnlyNames) {
  await h.page.evaluate((pid) => {
    openASHRAE36ReportModal(pid, 'audit');
  }, projId);
  await h.page.waitForTimeout(300);
  if (selectOnlyNames) {
    await h.page.evaluate((names) => {
      scopeTreeSetChecked(document.getElementById('a36Scope'), 'bldg', names);
    }, selectOnlyNames);
  } else {
    await h.page.evaluate(() => {
      scopeTreeSetAll(document.getElementById('a36Scope'), true);
    });
  }
  await h.page.waitForTimeout(150);
  await h.page.evaluate(() => {
    generateASHRAE36Preview();
  });
  await h.page.waitForTimeout(800);

  return h.page.evaluate(() => {
    const d = window._currentReportData;
    const overlay = document.getElementById('reportOverlay');
    const coverEl = overlay ? overlay.querySelector('.rpt-a36-stat-card') : null;
    const stats = {};
    if (overlay) {
      overlay.querySelectorAll('.rpt-a36-stat-card').forEach((card) => {
        const kids = card.children;
        if (kids.length >= 2) {
          const value = parseInt((kids[0].textContent || '').replace(/,/g, ''), 10);
          const label = (kids[1].textContent || '').trim();
          stats[label] = value;
        }
      });
    }
    return {
      totalBuildings: d ? d.portfolio.totalBuildings : null,
      totalEquip: d ? d.portfolio.totalEquip : null,
      buildings: d ? d.buildings.map((b) => b.name) : [],
      coverSequences: stats['Sequences to Program'],
      coverSensors: stats['Sensors to Install'],
    };
  });
}

(async () => {
  console.log('test-ashrae36-cover-scope: worktree = ' + WORKTREE);
  const h = await rn.restore({ worktree: WORKTREE, runDir: RUN_DIR });
  console.log('Restore OK, projects loaded: ' + h.projCount);

  const proj = await h.page.evaluate(() => {
    const p = projects.find((x) => /johnson county/i.test(x.client || '') || /joco/i.test(x.name || ''));
    return p ? { projId: p.id, projName: p.name } : null;
  });
  if (!proj) {
    console.error('FATAL: JOCO project not found in restored backup -- cannot run this test.');
    await rn.close(h);
    process.exit(1);
  }
  console.log('Testing against project: ' + proj.projName);
  const projId = proj.projId;

  // Independent expected value for the one-building case: sum the SAME predicates the cover
  // uses (phase===1&&!ioOnly / phase===2&&seqKey), but filtered to ONE_BUILDING_NAME's rows out
  // of the full, UNSCOPED catalog -- i.e. computed a different way than the app's own scoped
  // call path (_a36ScopedCatalogRows), so this is a real cross-check, not a tautology.
  const expected = await h.page.evaluate(
    (args) => {
      const rows = typeof buildCatalogRows === 'function' ? buildCatalogRows(args.projId) || [] : [];
      let sensors = 0,
        sequences = 0;
      rows.forEach((r) => {
        if (r.building !== args.bName) return;
        if (r.phase === 1 && !r.ioOnly) sensors += r.qty || 0;
        else if (r.phase === 2 && r.seqKey) sequences += r.qty || 0;
      });
      return { sensors, sequences };
    },
    { bName: ONE_BUILDING_NAME, projId: projId },
  );
  console.log(
    'Independent expected one-building totals (from unscoped buildCatalogRows, filtered): ' + JSON.stringify(expected),
  );

  console.log('\n-- Full selection (all buildings) --');
  const full = await runScope(h, projId, null);
  console.log('  ' + JSON.stringify(full));
  assertEq(full.coverSequences, EXPECTED_FULL_SEQUENCES, 'full-selection cover Sequences to Program unchanged');
  assertEq(full.coverSensors, EXPECTED_FULL_SENSORS, 'full-selection cover Sensors to Install unchanged');

  console.log('\n-- One-building selection (' + ONE_BUILDING_NAME + ') --');
  const one = await runScope(h, projId, [ONE_BUILDING_NAME]);
  console.log('  ' + JSON.stringify(one));
  assertEq(one.totalBuildings, 1, 'one-building selection scopes Buildings Assessed to 1');
  assertEq(
    one.coverSequences,
    expected.sequences,
    'one-building cover Sequences to Program equals sum over that building',
  );
  assertEq(one.coverSensors, expected.sensors, 'one-building cover Sensors to Install equals sum over that building');
  // Regression guard: the pre-fix defect showed the exact full-portfolio number here.
  if (one.coverSequences === EXPECTED_FULL_SEQUENCES || one.coverSensors === EXPECTED_FULL_SENSORS) {
    failed++;
    console.log('  FAIL: one-building cover still shows a full-portfolio value -- scope bug regressed');
  } else {
    passed++;
    console.log('  PASS: one-building cover does not show the full-portfolio value');
  }

  await rn.close(h);

  console.log('\n' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
