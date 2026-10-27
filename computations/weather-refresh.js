// computations/weather-refresh.js - the ONE place monthly weather (HDD / CDD / average temperature) is
// fetched from the weather source and merged into a ZIP's stored months (DB key en_wdd_<zip>).
//
// Source: api.weatherdatadepot.com (public, answers with "access-control-allow-origin: *", so the browser
// calls it directly: no Netlify function, no timer, no schedule). Station lookup by ZIP, then three chart calls.
// HDD and CDD come as running totals for the year; this file turns them into single months.
//
// Rules (Matt, 2026-10-27):
//   - A stored month is never changed. Only months NEWER than the newest stored month are appended.
//   - A month the source has not published (any of the 3 values absent) is left out. It is never saved as 0.
//   - The current calendar month is never saved (it is not complete). Newest month saved = last calendar month.
//   - Nothing happens when the newest stored month is last calendar month or later.
//
// Pure functions take `fetchFn` and the date as arguments so tests run on synthetic data.
// Browser entry: wddRefreshProjectWeather(projId) in app/utility-data.js (called from udSelectBldg).

const WX_API_BASE = 'https://api.weatherdatadepot.com/api';
const WX_FIRST_YEAR = 2020;
const WX_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Last complete calendar month as 'YYYY-MM' (the month before `now`).
function wxLastCompleteYm(now) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function wxNewestYm(rows) {
  let newest = null;
  (rows || []).forEach((r) => {
    if (r && r.ym && (!newest || r.ym > newest)) newest = r.ym;
  });
  return newest;
}

// True when the ZIP has no stored month, or its newest stored month is older than last calendar month.
function wxNeedsRefresh(rows, now) {
  const newest = wxNewestYm(rows);
  return !newest || newest < wxLastCompleteYm(now);
}

function _wxYm(year, monthAbbr) {
  const mo = WX_MONTHS[String(monthAbbr).slice(0, 3).toLowerCase()];
  return mo ? year + '-' + String(mo).padStart(2, '0') : null;
}

// Running yearly totals -> single months. A month is returned only when it is January (total starts at 0) or
// the month before it is in the same block; otherwise the difference would be wrong, so the month is left out.
function wxCumulativeToMonthly(yearBlocks) {
  const out = {};
  (yearBlocks || []).forEach((block) => {
    const cum = {};
    (block.data || []).forEach((e) => {
      const ym = _wxYm(block.year, e.month);
      const v = parseFloat(e.value);
      if (ym && Number.isFinite(v)) cum[ym] = v;
    });
    Object.keys(cum).forEach((ym) => {
      const mo = parseInt(ym.slice(5), 10);
      if (mo === 1) {
        out[ym] = Math.round(cum[ym]);
        return;
      }
      const prev = block.year + '-' + String(mo - 1).padStart(2, '0');
      if (prev in cum) out[ym] = Math.round(cum[ym] - cum[prev]);
    });
  });
  return out;
}

function wxMonthlyAverage(yearBlocks) {
  const out = {};
  (yearBlocks || []).forEach((block) => {
    (block.data || []).forEach((e) => {
      const ym = _wxYm(block.year, e.month);
      const v = parseFloat(e.value);
      if (ym && Number.isFinite(v)) out[ym] = v;
    });
  });
  return out;
}

// Months present in all 3 source series, sorted: [{ym, hdd, cdd, avgTemp}] (same shape as the stored rows).
function wxRowsFromBlocks(hddBlocks, cddBlocks, tempBlocks) {
  const h = wxCumulativeToMonthly(hddBlocks);
  const c = wxCumulativeToMonthly(cddBlocks);
  const t = wxMonthlyAverage(tempBlocks);
  return Object.keys(h)
    .filter((ym) => ym in c && ym in t)
    .sort()
    .map((ym) => ({ ym, hdd: h[ym], cdd: c[ym], avgTemp: t[ym] }));
}

// Fetch from the source. fetchFn(url) must return a fetch Response. Returns all rows from startYear..endYear.
async function wxFetchRows(fetchFn, zip, startYear, endYear) {
  const get = async (url, what) => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(what + ': HTTP ' + res.status);
    return res.json();
  };
  const st = await get(WX_API_BASE + '/locations/GetWeatherStation?locale=' + encodeURIComponent(zip), 'station ' + zip);
  if (!st || !st.stationID) throw new Error('no station for ZIP ' + zip);
  const q = '?station_id=' + st.stationID + '&startYear=' + startYear + '&endYear=' + endYear;
  const [hdd, cdd, tmp] = await Promise.all([
    get(WX_API_BASE + '/charts/heatingDegreeDays' + q + '&balancePoint=60&unit=f', 'hdd'),
    get(WX_API_BASE + '/charts/coolingDegreeDays' + q + '&balancePoint=60&unit=f', 'cdd'),
    get(WX_API_BASE + '/charts/averageDailyTemperature' + q + '&unit=f', 'temp'),
  ]);
  return wxRowsFromBlocks(hdd, cdd, tmp);
}

// Append-only merge. Returns {rows, added}: `rows` = every stored row unchanged + fetched months newer than the
// newest stored month and not newer than last calendar month. `added` = the new rows only.
function wxMergeAppend(existing, fetched, now) {
  const stored = Array.isArray(existing) ? existing : [];
  const newest = wxNewestYm(stored);
  const last = wxLastCompleteYm(now);
  const have = new Set(stored.map((r) => r.ym));
  const added = (fetched || []).filter((r) => !have.has(r.ym) && (!newest || r.ym > newest) && r.ym <= last);
  const rows = stored.concat(added).sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  return { rows, added };
}

// One ZIP: if stored months are stale, fetch and return the merged result; else null.
// loadFn(zip) -> stored rows, saveFn(zip, rows) writes. The stored rows are read again after the fetch so a save
// made in the meantime is never lost. Returns {zip, added:[...]} or null when nothing to do / nothing new.
async function wxRefreshZip(zip, deps) {
  const now = deps.now || new Date();
  if (!wxNeedsRefresh(deps.loadFn(zip), now)) return null;
  const newest = wxNewestYm(deps.loadFn(zip));
  const startYear = newest ? parseInt(newest.slice(0, 4), 10) : WX_FIRST_YEAR;
  const fetched = await wxFetchRows(deps.fetchFn, zip, startYear, now.getFullYear());
  const merged = wxMergeAppend(deps.loadFn(zip), fetched, now);
  if (!merged.added.length) return { zip, added: [] };
  deps.saveFn(zip, merged.rows);
  return { zip, added: merged.added };
}

// ZIPs to refresh for a project: every distinct non-blank ZIP of its buildings and the project's own ZIP.
function wxProjectZips(project, buildings) {
  const set = new Set();
  const add = (z) => {
    const s = String(z || '').replace(/\s/g, '');
    if (/^\d{5}$/.test(s)) set.add(s);
  };
  (buildings || []).forEach((b) => add(b && b.zip));
  if (project) add(project.zip);
  return Array.from(set);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    wxLastCompleteYm,
    wxNewestYm,
    wxNeedsRefresh,
    wxCumulativeToMonthly,
    wxMonthlyAverage,
    wxRowsFromBlocks,
    wxFetchRows,
    wxMergeAppend,
    wxRefreshZip,
    wxProjectZips,
  };
}
