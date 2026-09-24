// test-equipment-matrix-no-pagination-dom.js
// DOM acceptance test for the Equipment Matrix pagination-removal change (2026-09-23).
// Proves: ALL rows of a >100-row matrix render into a single scrollable table with no
// Prev/Next buttons, no "Rows per page" selector, no "Page X of Y" label, and no
// "Page Total"/"Page Average" footer row (only the single "Total" row remains) — in BOTH the
// Audit View and Raw View, in a real headless browser against the real app code (not a
// reimplementation).
//
// Fixture: 100% SYNTHETIC equipment (132 rows: 120 VAV boxes, 5 RTUs, 3 Lights, 2 Meters, 2
// room-monitor rows) seeded directly into IndexedDB via the app's own DB.set() — no real
// client/project/building data touches this test. 132 > the old default page size (100) so a
// pre-fix run of this same test would have failed (only 100 of 132 rows in the DOM, a visible
// Prev/Next bar, a "Page Total" row) — this is a genuine regression-proof threshold, not
// arbitrary.
//
// Browser: plain Chromium (NOT Edge — msedge channel is the repo's usual tools/verify.js
// convention, but this project's browser-safety rules for this task explicitly forbid it),
// headless, a unique C:\Temp profile per run, closed in a finally block. Per feedback_no_edge_
// headed_chrome.md / feedback_browser_process_safety.md.
//
// Run: node test-equipment-matrix-no-pagination-dom.js   (from the repo root)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const SITE_PATH = 'file:///' + REPO.replace(/\\/g, '/') + '/energy-department.html';
const PROFILE_DIR = 'C:\\Temp\\em-no-pagination-test-profile-' + Date.now();
const SYNTH_PID = 999000111; // fake numeric project id, never collides with a real project

let pass = 0;
let fail = 0;
const failures = [];

function assertTrue(actual, label) {
  if (actual) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

// ── Build the synthetic fixture matrix ──────────────────────────────────────────────────────
function buildSyntheticMatrix() {
  const rows = [];
  const bldg = 'Synthetic Test Building';

  function baseRow(name, category, points) {
    return {
      id: bldg + '||' + name,
      building: bldg,
      location: '',
      floor: '',
      area: '',
      equipName: name,
      equipType: name,
      category: category,
      subtype: '',
      points: points || {},
      pointsRaw: points || {},
      checks: {},
      schema: 2,
    };
  }

  // 120 synthetic VAV boxes (terminal box point signature: zone temp + flow + damper)
  for (let i = 1; i <= 120; i++) {
    rows.push(
      baseRow('SYN-VAV-' + i, 'vav', {
        'Zone Temp': '70.0 F',
        'Flow Control / Flow Input': '300 cfm',
        'Air Flow': '295',
        'Damper Position': '40 %',
      }),
    );
  }
  // 5 synthetic RTUs — the specific "is the RTU still visible with no pagination" proof
  for (let i = 1; i <= 5; i++) {
    rows.push(baseRow('SYN-RTU-' + i, 'rtu', { 'Zone Temp': '72.0 F', 'Supply Fan Status': 'On' }));
  }
  // 3 synthetic Lights (name-only "Lights", the exact bug pattern)
  ['SYN Area Emergency Lights', 'SYN Parking Lot Lights', 'SYN Sidewalk Lights'].forEach((n) => {
    rows.push(baseRow(n, 'other', { 'Lighting Status': 'On', Schedule: 'On' }));
  });
  // 2 synthetic Meters (Gas + Water, name-driven)
  rows.push(baseRow('SYN Gas Meter', 'other', { 'Meter Input': '1', Demand: '2' }));
  rows.push(baseRow('SYN Water Meter', 'other', { 'Meter Input': '1', Demand: '2' }));
  // 2 synthetic room-monitor rows (points-driven, matches the real Woodland MS pattern)
  ['SYN Room A101', 'SYN Room B202'].forEach((n) => {
    rows.push(
      baseRow(n, 'other', {
        'Setpoint / Cooling Occupied Setpoint': '70.0 F',
        'Zone Temp': '70.5 F',
        'Zone Sensor Communications Alarm': 'Normal',
      }),
    );
  });

  return { rows: rows, importedAt: new Date().toISOString(), buildings: [bldg], totalBASPoints: 0 };
}

(async () => {
  const matrix = buildSyntheticMatrix();
  const EXPECTED_ROW_COUNT = matrix.rows.length; // 132

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await context.newPage();

    // Minimal seed: a single synthetic project + onboarding/login bypass flags. No real
    // project/client data is ever written by this test.
    const smallSeed = {
      en_projects: [
        {
          id: SYNTH_PID,
          name: 'SYNTHETIC TEST PROJECT (auto-generated, safe to delete)',
          client: 'Synthetic Test Client',
          addr: '',
          type: 'Test',
          status: 'active',
          phase: '',
          contacts: [],
          savingsData: { measures: [] },
        },
      ],
      ch_qs_seen: 1,
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((data) => {
      for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
    }, smallSeed);

    await page.goto(SITE_PATH);
    await page.waitForTimeout(2000);

    await page.evaluate(
      async ({ pid, matrixData }) => {
        await window.DB.set('en_eqmatrix_' + pid, matrixData);
      },
      { pid: SYNTH_PID, matrixData: matrix },
    );

    await page.evaluate((pid) => {
      openDetail(pid);
      var btn = document.querySelector('.pdt[data-tab="eq-matrix"]');
      if (typeof sPTab === 'function') sPTab('eq-matrix', btn);
    }, SYNTH_PID);
    await page.waitForTimeout(2000);

    async function checkCurrentView(viewLabel) {
      // Wait for row count to stabilize (chunked async render).
      let rowCount = 0;
      let prev = -1;
      let stable = 0;
      for (let i = 0; i < 100; i++) {
        await page.waitForTimeout(100);
        rowCount = await page.evaluate(() => {
          var tbody = document.querySelector('#em-table-wrap tbody');
          return tbody ? tbody.querySelectorAll('tr').length : 0;
        });
        if (rowCount === prev) {
          stable++;
          if (stable >= 5 && rowCount > 0) break;
        } else {
          stable = 0;
        }
        prev = rowCount;
      }

      const check = await page.evaluate(() => {
        var wrap = document.getElementById('em-table-wrap');
        var tbody = wrap ? wrap.querySelector('tbody') : null;
        var trList = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
        // Count DISTINCT rows whose VISIBLE cell text names a synthetic RTU — not a raw
        // innerHTML substring count, which double/triple-counts every row because the same
        // rowId also appears inside onclick/title attribute values (drawer toggle, compliance
        // detail link), not just the visible Equipment Name cell.
        var rtuRowMatches = trList.filter((tr) =>
          Array.from(tr.querySelectorAll('td')).some((td) => /^SYN-RTU-\d$/.test(td.textContent.trim())),
        );
        // Toolbar text (search box, row-count pill, "Rows per page" label if any) lives
        // alongside #em-table-wrap, not inside it — scope the pagination-text search to that
        // shared parent so it catches a real leftover pagination bar/label, but EXCLUDES the
        // unrelated "What's New" release-notes panel elsewhere in the DOM, which legitimately
        // mentions "Page Total" as historical changelog text (see RELEASE_NOTES in
        // app/site-functions.js — that text is intentionally left alone by this fix).
        var scopeEl = (wrap && wrap.parentElement) || wrap || document.body;
        var scopeText = scopeEl.textContent || '';
        var footerRows = wrap ? Array.from(wrap.querySelectorAll('tfoot tr')) : [];
        return {
          pagBarPresent: !!document.querySelector('.em-pagination'),
          prevBtnPresent: !!document.querySelector('[data-em-prev-page]'),
          nextBtnPresent: !!document.querySelector('[data-em-next-page]'),
          pageSizeSelPresent: !!document.querySelector('[data-em-page-size]'),
          pageXofYPresent: /Page \d+ of \d+/.test(scopeText),
          pageTotalTextPresent: scopeText.indexOf('Page Total') !== -1 || scopeText.indexOf('Page Average') !== -1,
          footerRowCount: footerRows.length,
          footerLabel: footerRows.length ? footerRows[footerRows.length - 1].textContent.trim().slice(0, 40) : '',
          rtuRowCount: rtuRowMatches.length,
        };
      });

      assertEqual(rowCount, EXPECTED_ROW_COUNT, viewLabel + ': all ' + EXPECTED_ROW_COUNT + ' synthetic rows in DOM');
      assertTrue(!check.pagBarPresent, viewLabel + ': no .em-pagination bar');
      assertTrue(!check.prevBtnPresent, viewLabel + ': no Prev button');
      assertTrue(!check.nextBtnPresent, viewLabel + ': no Next button');
      assertTrue(!check.pageSizeSelPresent, viewLabel + ': no Rows-per-page selector');
      assertTrue(!check.pageXofYPresent, viewLabel + ': no "Page X of Y" text anywhere');
      assertTrue(!check.pageTotalTextPresent, viewLabel + ': no "Page Total"/"Page Average" text');
      assertEqual(check.footerRowCount, 1, viewLabel + ': exactly one footer row (Total, not Page Total + Total)');
      assertTrue(
        /total/i.test(check.footerLabel),
        viewLabel + ': footer row is labeled Total (got "' + check.footerLabel + '")',
      );
      assertEqual(
        check.rtuRowCount,
        5,
        viewLabel + ': all 5 synthetic RTU rows reachable in one scroll (no page cutoff)',
      );

      return check;
    }

    console.log('--- Audit View (default) ---');
    await checkCurrentView('Audit View');

    await page.evaluate(() => {
      var btn = document.getElementById('em-raw-btn');
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
    console.log('--- Raw View ---');
    const rawCheck = await checkCurrentView('Raw View');

    // Confirm the Lights/Meters/Room rows actually show the new types in Raw View (Equipment
    // Type column), proving the classifier result is reflected in the rendered DOM, not just
    // in isolated function calls.
    const typeLabels = await page.evaluate(() => {
      var wrap = document.getElementById('em-table-wrap');
      var rows = wrap ? Array.from(wrap.querySelectorAll('tbody tr')) : [];
      var out = {};
      var targets = ['SYN Area Emergency Lights', 'SYN Gas Meter', 'SYN Water Meter', 'SYN Room A101'];
      rows.forEach((tr) => {
        var cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
        targets.forEach((t) => {
          if (cells.indexOf(t) !== -1 && !out[t]) out[t] = cells;
        });
      });
      return out;
    });
    const cellIdx = 3; // expand-toggle(0) building(1) floor(2) equipName(3)? verified below by scanning for the type text
    // Equipment Type is whatever cell contains a known label string — check by substring instead
    // of a hardcoded column index (column order can legitimately change).
    function typeOf(cells) {
      var known = ['Lighting', 'Meters (Gas)', 'Meters (Water)', 'Monitoring'];
      for (var i = 0; i < cells.length; i++) {
        if (known.indexOf(cells[i]) !== -1) return cells[i];
      }
      return null;
    }
    assertEqual(
      typeOf(typeLabels['SYN Area Emergency Lights'] || []),
      'Lighting',
      'Raw View: SYN Area Emergency Lights shows Lighting',
    );
    assertEqual(
      typeOf(typeLabels['SYN Gas Meter'] || []),
      'Meters (Gas)',
      'Raw View: SYN Gas Meter shows Meters (Gas)',
    );
    assertEqual(
      typeOf(typeLabels['SYN Water Meter'] || []),
      'Meters (Water)',
      'Raw View: SYN Water Meter shows Meters (Water)',
    );
    assertEqual(typeOf(typeLabels['SYN Room A101'] || []), 'Monitoring', 'Raw View: SYN Room A101 shows Monitoring');
  } finally {
    await context.close();
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    console.log('All equipment-matrix no-pagination DOM tests passed.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('SCRIPT ERROR', e);
  process.exit(1);
});
