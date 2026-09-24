// test-equipment-matrix-render-performance.js
// Timing acceptance test for fix/em-render-performance (2026-09-23).
//
// Problem: JOCO (2,721 real equipment rows) took ~80s to open the Equipment Matrix's Raw View
// (and every other view, since they all funnel through emLoadMatrix()). Root cause (found by
// measuring, not guessing): emLoadMatrix()'s self-heal pass (Pass 0/A/B/C name+point-evidence
// reclassification + the hwp stale-row shim — emClassifyEquipType/emVerifyTypeByPoints run up to
// 3x per row) re-executed from scratch on EVERY view switch and filter change, not just when
// data actually changed. Fix: cache "already healed" per projId (_emSelfHealDone), invalidated
// only by emSaveMatrix (a real data write) — see the code comments at its declaration.
//
// This test builds a ~3,000-row 100% SYNTHETIC fixture (no real client/project data), seeds it
// into IndexedDB, and times how long each view takes to open/switch to. Target: under 2s each.
//
// Browser: plain Chromium (never Edge/msedge), headless, unique C:\Temp profile per run, closed
// in a finally block. Run: node test-equipment-matrix-render-performance.js

const { chromium } = require('playwright');

const REPO = __dirname;
const SITE_PATH = 'file:///' + REPO.replace(/\\/g, '/') + '/energy-department.html';
const PROFILE_DIR = 'C:\\Temp\\em-perf-test-profile-' + Date.now();
const SYNTH_PID = 999000222; // fake numeric project id, never collides with a real project
const ROW_COUNT = 3000;
const BUILDING_COUNT = 30; // 100 rows/building, roughly matches JOCO's real building density
const TARGET_MS = 2000;

let pass = 0;
let fail = 0;
const failures = [];
const timings = [];

function assertTrue(actual, label) {
  if (actual) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}

// ── Build the synthetic fixture matrix (~3,000 rows, realistic point density) ──────────────────
function buildSyntheticMatrix() {
  const rows = [];
  const categories = ['vav', 'rtu', 'ahu', 'fcu', 'ef', 'hwp', 'other'];

  // A realistic ~20-point VAV/terminal-unit signature — exercises emVerifyTypeByPoints'
  // hasPoint/hasPointNonDiag regex scans at a density comparable to real WebCTRL exports.
  function pointsFor(category, i) {
    const base = {
      'Zone Temp': (68 + (i % 8)).toFixed(1) + ' F',
      'Setpoint / Cooling Occupied Setpoint': '74.0 F',
      'Setpoint / Cooling Unoccupied Setpoint': '85.0 F',
      'Setpoint / Heating Occupied Setpoint': '70.0 F',
      'Setpoint / Heating Unoccupied Setpoint': '55.0 F',
      'Flow Control / Flow Input': 250 + (i % 400) + ' cfm',
      'Air Flow': (245 + (i % 400)).toString(),
      'Damper Position': 30 + (i % 60) + ' %',
      'Reheat Valve': (i % 2 === 0 ? '0' : '25') + ' %',
      'Zone CO2': (400 + (i % 400)).toString(),
      'Zone Relative Humidity': 35 + (i % 30) + ' %',
      Occupancy: i % 3 === 0 ? 'Occupied' : 'Unoccupied',
      Schedule: 'Auto',
      'High Zone Temperature': '85.0 F',
      'Low Zone Temperature': '55.0 F',
      'Zone Sensor Communications Alarm': 'Normal',
    };
    if (category === 'rtu' || category === 'ahu') {
      base['Supply Fan Status'] = 'On';
      base['Supply Air Temp'] = '55.0 F';
      base['Return Air Temp'] = '72.0 F';
      base['Mixed Air Temp'] = '60.0 F';
      base['Outside Air Damper'] = '20 %';
      base['Supply Fan Speed'] = '80 %';
    }
    if (category === 'ef') {
      base['Exhaust Fan Status'] = 'On';
      base['Exhaust Fan Speed'] = '75 %';
    }
    if (category === 'hwp') {
      base['Hot Water Pump Status'] = 'On';
      base['Pump Speed'] = '60 %';
      base['Discharge Pressure'] = '20 psi';
    }
    return base;
  }

  for (let i = 0; i < ROW_COUNT; i++) {
    const bldg = 'Synthetic Building ' + (1 + (i % BUILDING_COUNT));
    const category = categories[i % categories.length];
    const name = 'SYN-' + category.toUpperCase() + '-' + i;
    rows.push({
      id: bldg + '||' + name,
      building: bldg,
      location: '',
      floor: '',
      area: '',
      equipName: name,
      equipType: name,
      category: category,
      subtype: '',
      points: pointsFor(category, i),
      pointsRaw: pointsFor(category, i),
      checks: {},
      schema: 2,
    });
  }

  return {
    rows: rows,
    importedAt: new Date().toISOString(),
    buildings: Array.from({ length: BUILDING_COUNT }, (_, i) => 'Synthetic Building ' + (i + 1)),
    totalBASPoints: 0,
  };
}

(async () => {
  const matrix = buildSyntheticMatrix();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

    const smallSeed = {
      en_projects: [
        {
          id: SYNTH_PID,
          name: 'SYNTHETIC PERF TEST PROJECT (auto-generated, safe to delete)',
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

    // Initial open lands on Audit View by default — time that first (includes the one
    // mandatory self-heal pass, since this is the very first load of this project's data).
    // waitReady supports two modes: a numeric expected row count (table views: Audit/Raw/Edit),
    // or a required substring of #em-table-wrap's text (non-tabular views: Summary's tfoot,
    // Sequence's building-picker placeholder — neither of those renders a <tbody> at all, so a
    // row-count wait would hang forever).
    // Manual poll via repeated page.evaluate() calls instead of page.waitForFunction — a
    // Playwright page.waitForFunction({polling: <ms>}) against this page reproducibly never
    // resolved even once the page-side condition was already true (confirmed via a standalone
    // diagnostic script: rowCount reached 3000 within 3s and stayed there, yet
    // page.waitForFunction still timed out at 180s) — a harness-side quirk, not an app bug.
    // This manual-poll approach is what the standalone diagnostic used successfully.
    async function waitReady(expectedTbodyRowsOrTextMatch, maxMs) {
      var deadline = Date.now() + (maxMs || 30000);
      while (Date.now() < deadline) {
        var ready = await page.evaluate((expected) => {
          var wrap = document.getElementById('em-table-wrap');
          if (!wrap) return false;
          // 'footer' — Raw View is now lazily virtualized (initial batch + append-on-scroll,
          // see emRenderTable's large-table branch), so it never reaches the full row count
          // without the test actually scrolling. The real "view is open and usable" signal for
          // Raw/Edit-mode is the Total Average footer existing (added immediately after the
          // first batch, independent of how many rows have been scrolled into view since).
          if (expected === 'footer') {
            return !!wrap.querySelector('tfoot tr');
          }
          if (typeof expected === 'string') {
            return (wrap.textContent || '').indexOf(expected) !== -1;
          }
          var tbody = wrap.querySelector('tbody');
          if (!tbody) return false;
          if (tbody.querySelector('tr[data-em-loading]')) return false;
          if (expected != null) return tbody.querySelectorAll('tr').length >= expected;
          return true;
        }, expectedTbodyRowsOrTextMatch);
        if (ready) return;
        await page.waitForTimeout(25);
      }
      throw new Error(
        'waitReady timed out after ' + (maxMs || 30000) + 'ms waiting for ' + expectedTbodyRowsOrTextMatch,
      );
    }

    async function timeAction(label, action, expectedTbodyRowsOrTextMatch) {
      const t0 = Date.now();
      await action();
      await waitReady(expectedTbodyRowsOrTextMatch);
      const elapsed = Date.now() - t0;
      timings.push({ label: label, ms: elapsed });
      console.log(label + ': ' + elapsed + ' ms');
      assertTrue(elapsed < TARGET_MS, label + ' renders in under ' + TARGET_MS + 'ms (got ' + elapsed + 'ms)');
      return elapsed;
    }

    console.log('--- Initial open (Audit View, first load = one self-heal pass) ---');
    await waitReady('footer');
    // Fresh navigation timing was already spent above; re-measure a clean Audit->Audit no-op
    // isn't meaningful, so the FIRST real measurement is the Raw View switch (second call to
    // emLoadMatrix for this project — this is the one that was ~80-100s pre-fix).
    await timeAction('Raw View', () => page.evaluate(() => document.getElementById('em-raw-btn').click()), 'footer');
    // Raw View is now lazily virtualized — confirm the initial batch is real (not the full
    // 3,000 rows, which would defeat the point of virtualizing) and that scrolling the
    // container loads more, proving the IntersectionObserver append actually works end to end.
    const rawInitialRowCount = await page.evaluate(() => document.querySelectorAll('#em-table-wrap tbody tr').length);
    assertTrue(
      rawInitialRowCount > 0 && rawInitialRowCount < ROW_COUNT,
      'Raw View: initial batch renders a subset of rows, not all ' +
        ROW_COUNT +
        ' at once (got ' +
        rawInitialRowCount +
        ')',
    );
    // Repeatedly jump to the (growing) bottom — each batch that loads pushes the sentinel
    // further down, so a single scroll only triggers one batch; keep nudging until every row
    // has loaded. IntersectionObserver callbacks are delivered asynchronously (batched to the
    // browser's own schedule), so each nudge needs a real pause afterward, not just a fast
    // re-check — a jump-to-bottom "scroll" that outruns the observer's own delivery cadence
    // silently stalls after only a few batches.
    var scrollDeadline = Date.now() + 30000;
    var rawAfterScrollRowCount = 0;
    while (Date.now() < scrollDeadline) {
      await page.evaluate(() => {
        var wrap = document.getElementById('em-table-wrap');
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      });
      await page.waitForTimeout(150);
      rawAfterScrollRowCount = await page.evaluate(() => document.querySelectorAll('#em-table-wrap tbody tr').length);
      if (rawAfterScrollRowCount >= ROW_COUNT) break;
    }
    assertTrue(
      rawAfterScrollRowCount >= ROW_COUNT,
      'Raw View: scrolling to the bottom lazily loads every remaining row (got ' + rawAfterScrollRowCount + ')',
    );

    // Audit View is now ALSO lazily virtualized (same fix, see emRenderAuditTable) — 'footer'
    // is the correct ready-signal here too.
    await timeAction(
      'Audit View (switch back)',
      () => page.evaluate(() => document.getElementById('em-audit-btn').click()),
      'footer',
    );

    await timeAction(
      'Summary View',
      () => page.evaluate(() => document.getElementById('em-summary-btn').click()),
      'Average', // Summary has no <tbody> — wait for the tfoot's "Filtered/Total Average" text
    );
    const summaryFooterRows = await page.evaluate(() => document.querySelectorAll('#em-table-wrap tfoot tr').length);
    assertTrue(summaryFooterRows === 2, 'Summary View: 2 footer rows (Filtered Average + Total Average)');
    const summaryFooterLabel = await page.evaluate(
      () => (document.querySelector('#em-table-wrap tfoot tr') || {}).textContent || '',
    );
    assertTrue(
      summaryFooterLabel.indexOf('Filtered Average') !== -1,
      'Summary View: footer row is labeled "Filtered Average" (got "' + summaryFooterLabel.slice(0, 60) + '")',
    );
    assertTrue(
      summaryFooterLabel.indexOf('Page Average') === -1,
      'Summary View: footer row does NOT say "Page Average"',
    );

    await timeAction(
      'Sequence View',
      () => page.evaluate(() => document.getElementById('em-sequence-btn').click()),
      'Select a building', // Sequence has no <tbody> by default — wait for the picker placeholder
    );
    const seqPlaceholder = await page.evaluate(
      () => (document.getElementById('em-table-wrap') || {}).textContent || '',
    );
    assertTrue(
      seqPlaceholder.indexOf('Select a building') !== -1,
      'Sequence View: shows the building-picker placeholder (no building filter set)',
    );

    // Back to Raw View, then time Edit Mode toggle (also funnels through emLoadMatrix).
    // Raw View re-renders fresh (virtualized initial batch again) on every view switch, so
    // 'footer' is the correct ready-signal here too — see the Raw View timing above.
    await page.evaluate(() => document.getElementById('em-raw-btn').click());
    await waitReady('footer');
    await timeAction(
      'Edit Mode toggle (Raw View)',
      () => page.evaluate(() => document.getElementById('em-edit-mode-btn').click()),
      'footer',
    );
    const editableCount = await page.evaluate(
      () => document.querySelectorAll('#em-table-wrap tbody td[contenteditable="true"]').length,
    );
    assertTrue(editableCount > 0, 'Edit Mode: contenteditable cells present (' + editableCount + ')');

    // Turn edit mode back off, then re-time Audit View a THIRD time — proves the self-heal
    // cache stays warm across repeated view switches, not just the first two calls.
    await page.evaluate(() => document.getElementById('em-edit-mode-btn').click());
    await waitReady('footer');
    await timeAction(
      'Audit View (3rd switch, cache should stay warm)',
      () => page.evaluate(() => document.getElementById('em-audit-btn').click()),
      'footer',
    );
  } finally {
    await context.close();
  }

  console.log('');
  console.log('--- Timing summary (target: <' + TARGET_MS + 'ms each) ---');
  timings.forEach((t) => console.log('  ' + t.label + ': ' + t.ms + ' ms'));
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    console.log('All equipment-matrix render-performance tests passed.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('SCRIPT ERROR', e);
  process.exit(1);
});
