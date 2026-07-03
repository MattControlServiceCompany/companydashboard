// tools/ce-totals-check.js — Cost Estimate tab regression guard (b771dec6 plan Batch 0)
//
// Loads app/pricing-estimator.js (real, unmodified) via file:// against the synthetic
// ASHRAE-36 dummy-data harness at tools/ce-totals-check-harness.html (dummy data copied
// from the b771dec6 investigation harness — no real project data) and snapshots:
//   - collectPricingEstimate(9001, tier) totals for 'compliance' | 'recommended' | 'full-scope'
//   - per-row fingerprints {id, building, item, qty, lineTotal, phase} (sorted by id) from
//     buildComplianceRows / buildRecommendedRows / buildFullScopeRows
//
// Per-row fingerprints exist because totals could coincidentally match while an individual
// row's math changed (e.g. a swap that double-counts one row and drops another of equal $).
//
// Usage:
//   node tools/ce-totals-check.js --write   # capture baseline (run once, before Batch 1)
//   node tools/ce-totals-check.js           # compare current state to baseline; PASS/FAIL
//                                            # (exit 0 on PASS, exit 1 on FAIL)
//
// Baseline file (NOT committed to git — lives outside the repo):
//   C:\Users\Matt Miller\AI\_context\temp\ce-totals-baseline.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const HARNESS_URL = 'file:///' + path.join(__dirname, 'ce-totals-check-harness.html').replace(/\\/g, '/');
const BASELINE_PATH = 'C:\\Users\\Matt Miller\\AI\\_context\\temp\\ce-totals-baseline.json';

function deepDiff(base, cur, prefix, out) {
  if (base === cur) return;
  if (typeof base !== typeof cur || base === null || cur === null || typeof base !== 'object') {
    out.push(prefix + ': baseline=' + JSON.stringify(base) + ' current=' + JSON.stringify(cur));
    return;
  }
  var keys = Array.from(new Set(Object.keys(base).concat(Object.keys(cur))));
  keys.forEach(function (k) {
    deepDiff(base[k], cur[k], prefix ? prefix + '.' + k : k, out);
  });
}

(async () => {
  const context = await chromium.launchPersistentContext('C:\\Temp\\edge-ce-totals-check-profile', {
    channel: 'msedge',
    headless: true,
    args: ['--disable-gpu'],
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.__ceReady === true, { timeout: 10000 });

  const snapshot = await page.evaluate(() => window.__ceSnapshot());

  await context.close();

  if (WRITE) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2));
    console.log('WROTE BASELINE:', BASELINE_PATH);
    ['compliance', 'recommended', 'full-scope'].forEach(function (tier) {
      var t = snapshot[tier].totals;
      console.log('  ' + tier + ': grandTotal=' + (t ? t.grandTotal : null) + ' rows=' + snapshot[tier].rows.length);
    });
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('FAIL: no baseline found at', BASELINE_PATH, '— run with --write first.');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  const diffs = [];
  deepDiff(baseline, snapshot, '', diffs);

  if (diffs.length === 0) {
    console.log('PASS: ce-totals-check — all tiers match baseline (totals + per-row fingerprints).');
    ['compliance', 'recommended', 'full-scope'].forEach(function (tier) {
      var t = snapshot[tier].totals;
      console.log('  ' + tier + ': grandTotal=' + (t ? t.grandTotal : null) + ' rows=' + snapshot[tier].rows.length);
    });
    process.exit(0);
  } else {
    console.error('FAIL: ce-totals-check — ' + diffs.length + ' difference(s) vs baseline:');
    diffs.slice(0, 40).forEach(function (d) {
      console.error('  ' + d);
    });
    if (diffs.length > 40) console.error('  ... (' + (diffs.length - 40) + ' more)');
    process.exit(1);
  }
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
