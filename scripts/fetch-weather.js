#!/usr/bin/env node
// fetch-weather.js
// Usage: node scripts/fetch-weather.js [zip1] [zip2] ...
// If no args, reads ZIP codes from scripts/zips.json
//
// Fetches HDD/CDD/avgTemp from weatherdatadepot.com for each ZIP and writes
// weather-data/{ZIP}.json in the format:
//   [{ym: "2026-01", hdd: 650, cdd: 0, avgTemp: 32}, ...]
//
// HDD and CDD values from the API are cumulative YTD running totals.
// This script diffs them month-to-month (resetting at January) to get
// individual monthly values — matching the logic from the original VBA macro.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const API_BASE = 'https://api.weatherdatadepot.com/api';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getStationId(zip) {
  const url = `${API_BASE}/locations/GetWeatherStation?locale=${zip}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Station lookup failed for ZIP ${zip}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.stationID) throw new Error(`No stationID in response for ZIP ${zip}: ${JSON.stringify(data)}`);
  return data.stationID;
}

async function fetchChart(endpoint, stationId, startYear, endYear, extraParams) {
  extraParams = extraParams || '';
  const url = `${API_BASE}/charts/${endpoint}?station_id=${stationId}&startYear=${startYear}&endYear=${endYear}${extraParams}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Chart fetch failed (${endpoint}): HTTP ${res.status}`);
  return res.json(); // [{year, data: [{month, value}]}]
}

// Convert the API month abbreviation + year string to "YYYY-MM"
function toYm(year, monthAbbr) {
  const mo = MONTHS[monthAbbr.toLowerCase()];
  if (!mo) return null;
  return `${year}-${String(mo).padStart(2, '0')}`;
}

// HDD and CDD are cumulative YTD in the API response.
// Diff month-to-month; January resets the running total to 0 before it.
function cumulativeToMonthly(yearBlocks) {
  const result = {}; // keyed by "YYYY-MM"
  for (const block of yearBlocks) {
    const year = block.year;
    let prev = 0; // reset each year — January is already the monthly value
    for (const entry of block.data) {
      const cumVal = parseFloat(entry.value) || 0;
      const monthly = cumVal - prev;
      prev = cumVal;
      const ym = toYm(year, entry.month);
      if (ym) result[ym] = Math.round(monthly);
    }
  }
  return result;
}

// avgTemp is already a monthly average (not cumulative) — map directly.
function mapAvgTemp(yearBlocks) {
  const result = {};
  for (const block of yearBlocks) {
    const year = block.year;
    for (const entry of block.data) {
      const ym = toYm(year, entry.month);
      if (ym) result[ym] = parseFloat(entry.value) || 0;
    }
  }
  return result;
}

// ── Core fetch for one ZIP ────────────────────────────────────────────────────

async function fetchWeatherForZip(zip) {
  console.log(`\nFetching weather for ZIP ${zip}...`);

  // 1. Get station ID
  const stationId = await getStationId(zip);
  console.log(`  Station ID: ${stationId}`);

  // 2. Determine year range (API min is 1995; start at 2020 for practical baseline use)
  const currentYear = new Date().getFullYear();
  const startYear = 2020;
  const endYear = currentYear;
  console.log(`  Fetching ${startYear}–${endYear}...`);

  // 3. Fetch all three endpoints in parallel
  const [hddBlocks, cddBlocks, tempBlocks] = await Promise.all([
    fetchChart('heatingDegreeDays', stationId, startYear, endYear, '&balancePoint=60&unit=f'),
    fetchChart('coolingDegreeDays', stationId, startYear, endYear, '&balancePoint=60&unit=f'),
    fetchChart('averageDailyTemperature', stationId, startYear, endYear, '&unit=f'),
  ]);

  // 4. Convert cumulative → monthly for HDD and CDD; avgTemp is already monthly
  const hddByYm = cumulativeToMonthly(hddBlocks);
  const cddByYm = cumulativeToMonthly(cddBlocks);
  const tempByYm = mapAvgTemp(tempBlocks);

  // 5. Build output array sorted by ym
  const allYms = new Set([...Object.keys(hddByYm), ...Object.keys(cddByYm), ...Object.keys(tempByYm)]);
  const rows = [...allYms].sort().map((ym) => ({
    ym,
    hdd: hddByYm[ym] !== undefined ? hddByYm[ym] : 0,
    cdd: cddByYm[ym] !== undefined ? cddByYm[ym] : 0,
    avgTemp: tempByYm[ym] !== undefined ? tempByYm[ym] : 0,
  }));

  console.log(
    `  Got ${rows.length} months (${rows[0] && rows[0].ym} – ${rows[rows.length - 1] && rows[rows.length - 1].ym})`,
  );
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Get ZIPs from CLI args or zips.json
  let zips = process.argv.slice(2);
  if (!zips.length) {
    const zipsPath = path.join(__dirname, 'zips.json');
    try {
      zips = JSON.parse(fs.readFileSync(zipsPath, 'utf8'));
      console.log(`Read ${zips.length} ZIP(s) from scripts/zips.json: ${zips.join(', ')}`);
    } catch (e) {
      console.error(`No ZIP args and could not read scripts/zips.json: ${e.message}`);
      process.exit(1);
    }
  }

  if (!zips.length) {
    console.error('No ZIP codes provided. Pass them as arguments or add to scripts/zips.json.');
    process.exit(1);
  }

  // Ensure output directory exists
  const outDir = path.join(REPO_ROOT, 'weather-data');
  fs.mkdirSync(outDir, { recursive: true });

  let successCount = 0;
  let failCount = 0;

  for (const zip of zips) {
    try {
      const rows = await fetchWeatherForZip(String(zip).trim());
      const outPath = path.join(outDir, `${zip}.json`);
      fs.writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8');
      console.log(`  Saved to weather-data/${zip}.json`);
      successCount++;
    } catch (err) {
      console.error(`  ERROR for ZIP ${zip}: ${err.message}`);
      failCount++;
    }
  }

  console.log(`\nDone. ${successCount} succeeded, ${failCount} failed.`);
  if (failCount > 0) process.exit(1);
}

main().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
