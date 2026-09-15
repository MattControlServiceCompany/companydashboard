// test-hdd-narrative-table-match.mjs — regression test for backlog 5e43c081.
//
// Bug: the Appendix A weather page's HDD table ("Baseline Period Avg" row) and its
// narrative paragraph ("baseline average of X") were computed from two different sums:
//   - Table: rptPageAppendixWeather (app/report-engine.js) re-derived its own totHddBl by
//     summing EVERY month.hddBl in the monthly array unconditionally (12+ months, effectively
//     an annual/inflated sum).
//   - Narrative: read d.weather.totals.hddBl (collectWeatherData, app/csv-import.js), which
//     sums hddBl ONLY for inPeriod (reporting-quarter) months.
// Real certified PDF ("Louisburg USD #416 - Quarterly Savings Report 2026.05.11 with Degree
// Day info.pdf") shipped both numbers side by side: table 5,535 vs narrative 2,114.
//
// Fix: rptPageAppendixWeather now reads totHddBl/totHddCur/totCddBl/totCddCur (and the
// narrative's own figures) from the SAME d.weather.totals object — single source of truth,
// so table and narrative cannot diverge again.
//
// This test loads the REAL app/csv-import.js (collectWeatherData) and app/report-engine.js
// (rptPageAppendixWeather) into a Node vm sandbox — no reimplementation of report logic —
// builds a synthetic 15-month weather fixture (12 baseline months + 3 reporting months) sized
// to reproduce the same order-of-magnitude annual-vs-quarter mismatch the certified PDF showed,
// then asserts:
//   1. The table's "Baseline Period Avg" HDD figure and the narrative's "baseline average of X"
//      HDD figure are numerically equal (the regression guard).
//   2. Both equal the correct apples-to-apples quarter-matched baseline sum (1,850 in this
//      fixture), not the old buggy annual/inflated sum (~5,490 in this fixture) — so a future
//      "fix" that just makes both sides wrong in the same way would still fail.
//
// Run: node test-hdd-narrative-table-match.mjs   (from the repo root)

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) < 1e-6 : String(actual) === String(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertTrue(actual, label) {
  if (actual) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}

function loadSandbox() {
  const sandboxWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: '', search: '' },
  };
  const sandboxDocument = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, getContext: () => null }),
  };
  const sandbox = {
    console,
    window: sandboxWindow,
    document: sandboxDocument,
    navigator: { userAgent: 'node-hdd-narrative-table-test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Chart: function () {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => Date.now() },
    Image: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const LOAD_ORDER = ['app/csv-import.js', 'app/report-engine.js'];
  const skipped = [];
  for (const rel of LOAD_ORDER) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) {
      skipped.push(rel + ' (not found)');
      continue;
    }
    try {
      vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      skipped.push(rel + ' (load error: ' + e.message + ')');
    }
  }
  vm.runInContext(
    [
      'this.__collectWeatherData = typeof collectWeatherData !== "undefined" ? collectWeatherData : null;',
      'this.__rptPageAppendixWeather = typeof rptPageAppendixWeather !== "undefined" ? rptPageAppendixWeather : null;',
    ].join('\n'),
    ctx,
    { filename: 'export-tags.js' },
  );
  return {
    collectWeatherData: ctx.__collectWeatherData,
    rptPageAppendixWeather: ctx.__rptPageAppendixWeather,
    skipped,
  };
}

// Synthetic fixture: baseline calendar months Jan-Dec 2025 with descending-then-rising HDD
// (a plausible KS-like heating curve), reporting period Q1 2026 (Jan-Mar) with lower actual HDD.
const BASELINE_HDD_BY_CAL_MONTH = [700, 650, 500, 300, 100, 20, 10, 10, 50, 200, 450, 650]; // Jan..Dec
const ACTUAL_HDD_Q1_2026 = [600, 500, 400]; // Jan, Feb, Mar 2026
const EXPECTED_QUARTER_BASELINE_SUM = 700 + 650 + 500; // = 1850, Jan+Feb+Mar baseline only

function buildFixture() {
  const allRows = [];
  const blMonths = [];
  for (let m = 0; m < 12; m++) {
    const ym = '2025-' + String(m + 1).padStart(2, '0');
    blMonths.push(ym);
    allRows.push({ ym, hdd: BASELINE_HDD_BY_CAL_MONTH[m], cdd: 5 });
  }
  const reportYMs = ['2026-01', '2026-02', '2026-03'];
  reportYMs.forEach((ym, i) => {
    allRows.push({ ym, hdd: ACTUAL_HDD_Q1_2026[i], cdd: 30 });
  });
  return {
    allBldgMeters: [{ allRows, bl: { months: blMonths } }],
    reportYMs,
  };
}

function main() {
  const X = loadSandbox();
  if (X.skipped.length) {
    console.log('SKIPPED FILES (not found or load error):');
    for (const s of X.skipped) console.log('  ' + s);
  }
  assertTrue(!!X.collectWeatherData, 'export: collectWeatherData');
  assertTrue(!!X.rptPageAppendixWeather, 'export: rptPageAppendixWeather');
  if (!X.collectWeatherData || !X.rptPageAppendixWeather) {
    report();
    return;
  }

  const { allBldgMeters, reportYMs } = buildFixture();
  const weather = X.collectWeatherData(allBldgMeters, reportYMs);

  // Sanity: the totals object (single source of truth) must itself be quarter-matched.
  assertEqual(weather.totals.hddBl, EXPECTED_QUARTER_BASELINE_SUM, 'weather.totals.hddBl (single source of truth)');

  const pageResult = X.rptPageAppendixWeather(
    1,
    { weather, period: { quarter: 1 }, project: { client: 'Test District' } },
    'A',
  );
  const html = pageResult && pageResult.html;
  assertTrue(typeof html === 'string' && html.length > 0, 'rptPageAppendixWeather returned HTML');

  const tableMatch = html.match(/Baseline Period Avg<\/td>\s*<td class="rpt-n">([\d,]+)<\/td>/);
  assertTrue(!!tableMatch, 'table: found "Baseline Period Avg" row');
  const tableHdd = tableMatch ? parseInt(tableMatch[1].replace(/,/g, ''), 10) : NaN;

  const narrativeMatch = html.match(/baseline average of ([\d,]+) \(/);
  assertTrue(!!narrativeMatch, 'narrative: found "baseline average of X (" phrase');
  const narrativeHdd = narrativeMatch ? parseInt(narrativeMatch[1].replace(/,/g, ''), 10) : NaN;

  // The regression guard: table and narrative must agree.
  assertEqual(tableHdd, narrativeHdd, 'table HDD baseline === narrative HDD baseline');

  // Correctness, not just self-consistency: both must be the quarter-matched sum (1,850),
  // not the old buggy annual/inflated sum (~5,490 for this fixture).
  assertEqual(tableHdd, EXPECTED_QUARTER_BASELINE_SUM, 'table HDD baseline === correct quarter-matched sum');
  assertEqual(narrativeHdd, EXPECTED_QUARTER_BASELINE_SUM, 'narrative HDD baseline === correct quarter-matched sum');

  report();
}

function report() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
}

main();
