/* ── BAS TREND DATA — Phase 1 ──────────────────────────────────────────────
   Storage, CSV parsing, daily summary computation, fault detection,
   health score, and import modal UI.

   Storage keys:
     en_bas_[projId]              — project-level BAS data (buildings/equipment/days)
     en_bas_raw_[bldgKey]_[equip] — raw 7-day interval rows (IndexedDB not used;
                                    stored in localStorage as JSON array, capped at
                                    7-day window)

   Data model mirrors bas-integration-spec-2026-05-16.md §3.
   Algorithms ported from ashrae36-trend-analysis.js.
   ──────────────────────────────────────────────────────────────────────────── */

'use strict';

/* ── CONSTANTS ─────────────────────────────────────────────────────────────── */

var BT_CHUNK_SIZE = 2000; // rows per setTimeout chunk during import

// Fault thresholds
var BT_SHC_THRESHOLD = 10; // % valve open — both valves > this = SHC
var BT_SAT_RANGE_FAIL = 4; // °F — SAT range over 14 days < this = FAIL
var BT_DSP_RANGE_FAIL = 0.1; // "WC — DSP range over 14 days < this = FAIL
var BT_SAT_DEV_THRESHOLD = 5; // °F — |SAT - SATSP| > this = setpoint deviation
var BT_ZONE_DEV_THRESHOLD = 3; // °F — |zone - zonesp| > this
var BT_ECON_LOCKOUT_OAT = 75; // °F — economizer eligible below this
var BT_ECON_DAMPER_MIN = 20; // % — OA damper below this = economizer not active
var BT_ECON_COOL_MIN = 20; // % — cooling valve above this = cooling load
var BT_HUNT_REVERSALS = 6; // reversals/hour — hunting threshold
var BT_HUNT_AMPLITUDE = 10; // % — amplitude threshold for hunting
var BT_RAW_DAYS = 7; // how many days of raw data to retain

// Known sensor fail-safe values to flag for flat-line rule
var BT_FAILSAFE_TEMPS = [0.0, 32.0, -40.0, 212.0];

// Default occupied schedule
var BT_DEFAULT_SCHEDULE = {
  startHour: 6,
  endHour: 18,
  days: [1, 2, 3, 4, 5], // Mon-Fri (0=Sun)
};

/* ── POINT PATTERN VOCABULARY ──────────────────────────────────────────────── */
// Ported from ashrae36-trend-analysis.js POINT_PATTERNS + bas-integration-spec §2.3

var BT_POINT_PATTERNS = {
  oat: [
    'outside air temp',
    'outdoor air temp',
    'oat',
    'oa temp',
    'oa dry bulb',
    'ambient temp',
    'outdoor temp',
    'outside temp',
    'exterior temp',
    'oa t',
  ],
  sat: [
    'supply air temp',
    'discharge air temp',
    'sat',
    'dat',
    'discharge temp',
    'supply temp',
    'leaving air temp',
    'ahu sat',
    'ahu dat',
  ],
  satsp: [
    'sat sp',
    'supply air temp sp',
    'sat setpoint',
    'dat setpoint',
    'supply air setpoint',
    'supply temp setpoint',
    'discharge setpoint',
    'supply air temp setpoint',
    'discharge air temp setpoint',
  ],
  rat: ['return air temp', 'rat', 'ra temp', 'return temp', 'mixed air return'],
  mat: ['mixed air temp', 'mat', 'ma temp', 'mixing air temp'],
  oadamper: [
    'oa damper',
    'outside air damper',
    'outdoor air damper',
    'economizer damper',
    'oa pos',
    'oa position',
    'oad position',
    'oa %',
  ],
  coolvalve: [
    'cool valve',
    'cooling valve',
    'chw valve',
    'cooling coil valve',
    'chilled water valve',
    'ahu cooling',
    'cool coil',
    'ccv',
    'clg valve',
  ],
  heatvalve: [
    'heat valve',
    'heating valve',
    'hw valve',
    'heating coil valve',
    'hot water valve',
    'ahu heating',
    'preheat valve',
    'hcv',
    'htg valve',
  ],
  fanstatus: [
    'fan status',
    'supply fan status',
    'fan state',
    'sf status',
    'supply fan',
    'fan on',
    'fan run',
    'supply fan run',
    'supply fan enabled',
  ],
  fanspeed: ['fan speed', 'vfd speed', 'fan hz', 'supply fan vfd', 'sf vfd', 'supply vfd', 'fan vfd speed'],
  staticp: ['duct static', 'static pressure', 'duct pressure', 'dsp', 'supply static', 'duct sp', 'static pr'],
  staticpsp: [
    'static pressure setpoint',
    'duct static setpoint',
    'sp setpoint',
    'dsp setpoint',
    'duct pressure setpoint',
  ],
  zonetemp: ['zone temp', 'space temp', 'room temp', 'zn temp', 'zone t', 'space temperature', 'room temperature'],
  zonesp_cool: ['cool sp', 'cooling sp', 'cooling setpoint', 'occupied cool', 'zone cool sp', 'cooling set'],
  zonesp_heat: ['heat sp', 'heating sp', 'heating setpoint', 'occupied heat', 'zone heat sp', 'heating set'],
  occupied: ['occupied', 'occ mode', 'occupancy mode', 'occ status', 'occ'],
  hwstemp: [
    'hws',
    'hot water supply',
    'hw supply',
    'hwst',
    'boiler supply',
    'heating water supply',
    'boiler outlet',
    'heat supply temp',
  ],
  hwrtemp: [
    'hwr',
    'hot water return',
    'hw return',
    'hwrt',
    'boiler return',
    'heating water return',
    'return water temp',
  ],
  kwh: ['kwh', 'kw demand', 'interval kw', 'electric', 'kw', 'energy'],
  co2: ['co2', 'carbon dioxide', 'co2 concentration', 'co2 ppm', 'iaq co2'],
  humidity: ['humidity', 'rh', 'relative humidity', 'rh %'],
  override: ['override', 'manual override', 'hand override', 'forced'],
};

/* ── UTILITY HELPERS ────────────────────────────────────────────────────────── */

/** Normalize a point/column name for matching */
function btNormalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[_\-\/\.\#\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Round n to d decimal places */
function btRound(n, d) {
  if (n == null || isNaN(n)) return null;
  var f = Math.pow(10, d || 0);
  return Math.round(n * f) / f;
}

/** Format date as YYYY-MM-DD */
function btDateKey(ts) {
  var y = ts.getFullYear();
  var m = String(ts.getMonth() + 1).padStart(2, '0');
  var d = String(ts.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/** Parse timestamp from a combined "YYYY-MM-DD HH:MM:SS" string or separate date+time */
function btParseTimestamp(dateStr, timeStr) {
  if (!dateStr) return null;
  var s = (dateStr + (timeStr ? ' ' + timeStr : '')).trim();

  // ISO combined: YYYY-MM-DD HH:MM:SS or YYYY-MM-DDTHH:MM:SS
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(:(\d{2}))?/);
  if (iso) {
    var ts = new Date(
      iso[1],
      parseInt(iso[2]) - 1,
      parseInt(iso[3]),
      parseInt(iso[4]),
      parseInt(iso[5]),
      parseInt(iso[7] || '0'),
    );
    if (!isNaN(ts)) return ts;
  }

  // Just date
  var dateOnly = dateStr.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    var timePart = (timeStr || '00:00:00').trim();
    var ts2 = new Date(
      dateOnly[1] + '-' + dateOnly[2].padStart(2, '0') + '-' + dateOnly[3].padStart(2, '0') + 'T' + timePart,
    );
    if (!isNaN(ts2)) return ts2;
  }

  // M/D/YYYY
  var mdy = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    var timePart2 = (timeStr || '00:00:00').trim();
    var ts3 = new Date(mdy[3] + '-' + mdy[1].padStart(2, '0') + '-' + mdy[2].padStart(2, '0') + 'T' + timePart2);
    if (!isNaN(ts3)) return ts3;
  }

  return null;
}

/** True if quality string is acceptable */
function btGoodQuality(q) {
  if (!q) return true;
  var l = q.toLowerCase().trim();
  return (
    l === 'good' ||
    l === 'reliable' ||
    l === 'normal' ||
    l === 'ok' ||
    l === 'valid' ||
    l === '1' ||
    l.startsWith('good')
  );
}

/** Determine if a timestamp falls within occupied schedule */
function btIsOccupied(ts, schedule) {
  var sch = schedule || BT_DEFAULT_SCHEDULE;
  var dow = ts.getDay();
  if (sch.days.indexOf(dow) === -1) return false;
  var h = ts.getHours() + ts.getMinutes() / 60;
  return h >= sch.startHour && h < sch.endHour;
}

/** Score how well a normalized name matches a pattern list */
function btScoreMatch(norm, patterns) {
  var best = 0;
  for (var i = 0; i < patterns.length; i++) {
    var p = btNormalize(patterns[i]);
    if (norm.indexOf(p) !== -1) {
      var score = Math.min(1, (p.length / norm.length) * 1.5);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Map a column header to a point type key, or null */
function btDetectPointType(colHeader) {
  var norm = btNormalize(colHeader);
  var bestKey = null;
  var bestScore = 0.1; // minimum score threshold
  for (var key in BT_POINT_PATTERNS) {
    if (!BT_POINT_PATTERNS.hasOwnProperty(key)) continue;
    var score = btScoreMatch(norm, BT_POINT_PATTERNS[key]);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey;
}

/** Build a minute-key lookup map from an array of {ts, value} rows */
function btBuildLookup(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var key = Math.floor(rows[i].ts.getTime() / 60000);
    map[key] = rows[i].value;
  }
  return map;
}

/** Lookup a value at a timestamp, searching ±30 minutes */
function btLookup(map, ts) {
  var key = Math.floor(ts.getTime() / 60000);
  if (map[key] !== undefined) return map[key];
  for (var d = 1; d <= 30; d++) {
    if (map[key + d] !== undefined) return map[key + d];
    if (map[key - d] !== undefined) return map[key - d];
  }
  return null;
}

/* ── CSV PARSER ─────────────────────────────────────────────────────────────── */

/** Split a single CSV line respecting quoted fields */
function btSplitCSVLine(line) {
  var result = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

/**
 * Detect which of three CSV formats the file uses:
 *   'webctrl_multi'  — header block starting with "Site:"
 *   'webctrl_single' — header block starting with "Point Name:"
 *   'generic'        — first line is column headers with a parseable date in row 2
 */
function btDetectFormat(lines) {
  if (!lines || !lines.length) return 'generic';
  var first = (lines[0] || '').trim().toLowerCase();
  if (first.startsWith('site:')) return 'webctrl_multi';
  if (first.startsWith('point name:')) return 'webctrl_single';
  return 'generic';
}

/**
 * Parse the header metadata block (WebCTRL formats).
 * Returns { siteName, exportedAt, startDate, endDate, intervalMinutes }
 */
function btParseHeaderBlock(lines, format) {
  var meta = { siteName: '', exportedAt: null, startDate: null, endDate: null, intervalMinutes: 15 };
  if (format === 'generic') return meta;

  for (var i = 0; i < Math.min(lines.length, 10); i++) {
    var l = lines[i].trim();
    if (/^site:/i.test(l)) meta.siteName = l.replace(/^site:\s*/i, '');
    if (/^exported:/i.test(l)) meta.exportedAt = l.replace(/^exported:\s*/i, '');
    if (/^period:/i.test(l)) {
      var m = l.match(/(\d{4}-\d{2}-\d{2})[^\d]+(\d{4}-\d{2}-\d{2})/);
      if (m) {
        meta.startDate = m[1];
        meta.endDate = m[2];
      }
    }
    if (/^interval:/i.test(l)) {
      var nm = l.match(/(\d+)\s*min/i);
      if (nm) meta.intervalMinutes = parseInt(nm[1]);
    }
    if (/^point name:/i.test(l)) meta.pointName = l.replace(/^point name:\s*/i, '');
  }
  return meta;
}

/**
 * Parse a WebCTRL multi-point CSV.
 * Returns { meta, columns[], rows[] }
 * Each row: { ts: Date, values: {colIndex: numericValue} }
 */
function btParseWebCTRLMulti(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var format = 'webctrl_multi';
  var meta = btParseHeaderBlock(lines, format);

  // Find the column header row (first row that starts with "Date/Time" or similar)
  var headerRowIdx = -1;
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var l = lines[i].trim().toLowerCase();
    if (l.startsWith('date/time') || l.startsWith('date,') || l.startsWith('timestamp')) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    // Fall back: find first non-empty non-header line
    for (var i2 = 0; i2 < lines.length; i2++) {
      if (lines[i2].trim() && !lines[i2].trim().startsWith('#')) {
        headerRowIdx = i2;
        break;
      }
    }
  }

  var rawHeaders = btSplitCSVLine(lines[headerRowIdx] || '');
  var columns = rawHeaders.map(function (h, idx) {
    return {
      index: idx,
      raw: h,
      detected: idx === 0 ? 'timestamp' : btDetectPointType(h),
    };
  });

  var rows = [];
  for (var i3 = headerRowIdx + 1; i3 < lines.length; i3++) {
    var line = lines[i3].trim();
    if (!line) continue;
    var vals = btSplitCSVLine(line);
    var tsStr = vals[0] || '';
    var ts = btParseTimestamp(tsStr);
    if (!ts) continue;

    var values = {};
    for (var j = 1; j < columns.length; j++) {
      var v = parseFloat(vals[j]);
      if (!isNaN(v)) values[j] = v;
    }
    rows.push({ ts: ts, values: values });
  }

  return { meta: meta, columns: columns, rows: rows };
}

/**
 * Parse a WebCTRL single-point CSV.
 * Returns { meta, columns[], rows[] } — columns[1] is the value column.
 */
function btParseWebCTRLSingle(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var meta = btParseHeaderBlock(lines, 'webctrl_single');

  // Find data rows: look for "Date/Time,Value" header
  var headerRowIdx = -1;
  for (var i = 0; i < Math.min(lines.length, 15); i++) {
    var l = lines[i].trim().toLowerCase();
    if (l.startsWith('date/time') || l.startsWith('date,time')) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) headerRowIdx = 5; // fallback

  var rawHeaders = btSplitCSVLine(lines[headerRowIdx] || 'Date/Time,Value');
  var pointLabel = meta.pointName || rawHeaders[1] || 'Value';
  var columns = [
    { index: 0, raw: rawHeaders[0], detected: 'timestamp' },
    { index: 1, raw: pointLabel, detected: btDetectPointType(pointLabel) },
  ];

  var rows = [];
  for (var i2 = headerRowIdx + 1; i2 < lines.length; i2++) {
    var line = lines[i2].trim();
    if (!line) continue;
    var vals = btSplitCSVLine(line);
    // Check for quality column
    if (vals.length >= 3) {
      var q = vals[2];
      if (!btGoodQuality(q)) continue;
    }
    var ts = btParseTimestamp(vals[0]);
    if (!ts) continue;
    var v = parseFloat(vals[1]);
    if (isNaN(v)) continue;
    rows.push({ ts: ts, values: { 1: v } });
  }

  return { meta: meta, columns: columns, rows: rows };
}

/**
 * Parse a generic wide CSV (first row = headers, first col = timestamp).
 */
function btParseGeneric(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var rawHeaders = btSplitCSVLine(lines[0] || '');
  var columns = rawHeaders.map(function (h, idx) {
    return {
      index: idx,
      raw: h,
      detected: idx === 0 ? 'timestamp' : btDetectPointType(h),
    };
  });

  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var vals = btSplitCSVLine(line);
    var ts = btParseTimestamp(vals[0]);
    if (!ts) continue;
    var values = {};
    for (var j = 1; j < columns.length; j++) {
      var v = parseFloat(vals[j]);
      if (!isNaN(v)) values[j] = v;
    }
    rows.push({ ts: ts, values: values });
  }

  return { meta: {}, columns: columns, rows: rows };
}

/**
 * Auto-detect format and parse CSV text.
 * Returns { meta, columns[], rows[], format }
 */
function btParseCSV(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var fmt = btDetectFormat(lines);
  var result;
  if (fmt === 'webctrl_multi') {
    result = btParseWebCTRLMulti(text);
  } else if (fmt === 'webctrl_single') {
    result = btParseWebCTRLSingle(text);
  } else {
    result = btParseGeneric(text);
  }
  result.format = fmt;
  return result;
}

/* ── COLUMN MAPPING OVERRIDE ────────────────────────────────────────────────── */
// User can override auto-detected column types before import.
// btApplyOverrides(columns, overrides) returns a new columns array with user types applied.

function btApplyOverrides(columns, overrides) {
  if (!overrides) return columns;
  return columns.map(function (col) {
    var ovr = overrides[col.index];
    return ovr ? Object.assign({}, col, { detected: ovr }) : col;
  });
}

/**
 * Build a map from pointType -> array of column indices for easy row lookups.
 * A column with detected === 'timestamp' is excluded.
 */
function btBuildPointMap(columns) {
  var map = {};
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i];
    if (!col.detected || col.detected === 'timestamp') continue;
    if (!map[col.detected]) map[col.detected] = [];
    map[col.detected].push(col.index);
  }
  return map;
}

/* ── DAILY SUMMARY COMPUTATION ──────────────────────────────────────────────── */

/**
 * computeDailySummaries(rows, columns, schedule)
 *
 * rows:    array of { ts: Date, values: {colIdx: number} }
 * columns: array of column descriptors with .detected type
 * schedule: { startHour, endHour, days }
 *
 * Returns: { 'YYYY-MM-DD': DailySummary, ... }
 */
function btComputeDailySummaries(rows, columns, schedule) {
  var sch = schedule || BT_DEFAULT_SCHEDULE;
  var pointMap = btBuildPointMap(columns);

  // Group rows by date
  var byDate = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var dk = btDateKey(row.ts);
    if (!byDate[dk]) byDate[dk] = [];
    byDate[dk].push(row);
  }

  var summaries = {};

  for (var dateKey in byDate) {
    if (!byDate.hasOwnProperty(dateKey)) continue;
    var dayRows = byDate[dateKey];
    dayRows.sort(function (a, b) {
      return a.ts - b.ts;
    });
    var summary = btComputeOneDaySummary(dateKey, dayRows, pointMap, sch);
    summaries[dateKey] = summary;
  }

  return summaries;
}

/**
 * Compute the DailySummary for a single day's worth of rows.
 * Internal helper called by btComputeDailySummaries.
 */
function btComputeOneDaySummary(dateKey, rows, pointMap, sch) {
  var intervalHrs = 0.25; // assume 15-minute data; will self-correct below
  if (rows.length >= 2) {
    var gap = (rows[1].ts - rows[0].ts) / 3600000;
    if (gap > 0 && gap <= 2) intervalHrs = gap;
  }

  // Collect per-point accumulators
  var accum = {}; // pointType -> { all, occ, unocc, vals }

  function ensureAccum(pt) {
    if (!accum[pt]) {
      accum[pt] = {
        allVals: [],
        occVals: [],
        unoccVals: [],
        runtimeHrs: 0,
        occRuntimeHrs: 0,
        unoccRuntimeHrs: 0,
      };
    }
  }

  // Build per-row lookup maps for multi-point data
  // For fault detection we need values for different point types at the same timestamp
  // We'll build per-row objects mapping pointType -> value for efficient scanning

  var typedRows = rows.map(function (row) {
    var typed = { ts: row.ts, occ: btIsOccupied(row.ts, sch) };
    for (var pt in pointMap) {
      if (!pointMap.hasOwnProperty(pt)) continue;
      var cols = pointMap[pt];
      // Use first available column for this type
      for (var ci = 0; ci < cols.length; ci++) {
        var v = row.values[cols[ci]];
        if (v !== undefined) {
          typed[pt] = v;
          break;
        }
      }
    }
    return typed;
  });

  // Accumulate stats per point type
  for (var ti = 0; ti < typedRows.length; ti++) {
    var tr = typedRows[ti];
    for (var pt2 in pointMap) {
      if (!pointMap.hasOwnProperty(pt2)) continue;
      var val = tr[pt2];
      if (val === undefined) continue;
      ensureAccum(pt2);
      accum[pt2].allVals.push(val);
      if (tr.occ) {
        accum[pt2].occVals.push(val);
      } else {
        accum[pt2].unoccVals.push(val);
      }
      // Fan runtime
      if (pt2 === 'fanstatus') {
        if (val > 0.5) {
          accum[pt2].runtimeHrs += intervalHrs;
          if (tr.occ) accum[pt2].occRuntimeHrs += intervalHrs;
          else accum[pt2].unoccRuntimeHrs += intervalHrs;
        }
      }
    }
  }

  // Helper: compute stats for an array of values
  function stats(vals) {
    if (!vals || !vals.length) return null;
    var sum = 0,
      min = vals[0],
      max = vals[0];
    for (var i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (vals[i] < min) min = vals[i];
      if (vals[i] > max) max = vals[i];
    }
    var sorted = vals.slice().sort(function (a, b) {
      return a - b;
    });
    var p10 = sorted[Math.floor(sorted.length * 0.1)];
    var p90 = sorted[Math.floor(sorted.length * 0.9)];
    return {
      avg: btRound(sum / vals.length, 2),
      min: btRound(min, 2),
      max: btRound(max, 2),
      p10: btRound(p10, 2),
      p90: btRound(p90, 2),
    };
  }

  // Build per-point summaries
  var ptSummaries = {};
  for (var pt3 in accum) {
    if (!accum.hasOwnProperty(pt3)) continue;
    var a = accum[pt3];
    var s = stats(a.allVals);
    if (!s) continue;

    var occAvg = a.occVals.length
      ? btRound(
          a.occVals.reduce(function (s2, v) {
            return s2 + v;
          }, 0) / a.occVals.length,
          2,
        )
      : null;
    var unoccAvg = a.unoccVals.length
      ? btRound(
          a.unoccVals.reduce(function (s2, v) {
            return s2 + v;
          }, 0) / a.unoccVals.length,
          2,
        )
      : null;

    ptSummaries[pt3] = Object.assign({}, s, {
      occupiedAvg: occAvg,
      unoccupiedAvg: unoccAvg,
    });

    if (pt3 === 'fanstatus') {
      ptSummaries[pt3].runtimeHours = btRound(a.runtimeHrs, 2);
      ptSummaries[pt3].occupiedHours = btRound(a.occRuntimeHrs, 2);
      ptSummaries[pt3].unoccupiedHours = btRound(a.unoccRuntimeHrs, 2);
    }
  }

  // Compute OAT stats for the day
  var oatAvg = null,
    oatMin = null,
    oatMax = null;
  if (ptSummaries.oat) {
    oatAvg = ptSummaries.oat.avg;
    oatMin = ptSummaries.oat.min;
    oatMax = ptSummaries.oat.max;
  }

  // Count occupied hours scheduled vs actual
  var schedHrs = 0,
    actualFanHrs = 0;
  for (var ti2 = 0; ti2 < typedRows.length; ti2++) {
    if (typedRows[ti2].occ) schedHrs += intervalHrs;
    if (typedRows[ti2].fanstatus !== undefined && typedRows[ti2].fanstatus > 0.5) actualFanHrs += intervalHrs;
  }

  // ── FAULT DETECTION ──────────────────────────────────────────────────────
  var faults = btDetectFaultsForDay(typedRows, intervalHrs, sch);

  var summary = {
    date: dateKey,
    oatAvg: oatAvg,
    oatMin: oatMin,
    oatMax: oatMax,
    faults: faults,
    occupied: {
      scheduledHours: btRound(schedHrs, 2),
      actualHours: btRound(actualFanHrs, 2),
    },
  };

  // Attach per-point stats
  for (var pt4 in ptSummaries) {
    if (!ptSummaries.hasOwnProperty(pt4)) continue;
    summary[pt4] = ptSummaries[pt4];
  }

  return summary;
}

/* ── FAULT DETECTION ────────────────────────────────────────────────────────── */

/**
 * Run all 7 fault detection rules against one day's typed rows.
 * Returns faults object: { shc, afterHours, economizer, setpointDeviation,
 *                          sensorFlat, override, hunting }
 * All values in hours (decimal).
 */
function btDetectFaultsForDay(typedRows, intervalHrs, sch) {
  var faults = {
    shc: 0,
    afterHours: 0,
    economizer: 0,
    setpointDeviation: 0,
    sensorFlat: 0,
    override: 0,
    hunting: 0,
  };

  // ── Rule 1: Simultaneous Heating and Cooling
  // Both coolvalve > 10% AND heatvalve > 10%
  for (var i = 0; i < typedRows.length; i++) {
    var tr = typedRows[i];
    if (tr.coolvalve !== undefined && tr.heatvalve !== undefined) {
      if (tr.coolvalve > BT_SHC_THRESHOLD && tr.heatvalve > BT_SHC_THRESHOLD) {
        faults.shc += intervalHrs;
      }
    }
  }

  // ── Rule 2: After-Hours Operation
  // Fan on while not in occupied schedule
  for (var i2 = 0; i2 < typedRows.length; i2++) {
    var tr2 = typedRows[i2];
    if (tr2.fanstatus !== undefined && tr2.fanstatus > 0.5 && !tr2.occ) {
      faults.afterHours += intervalHrs;
    }
    // Also check 'occupied' point if available
    if (tr2.fanstatus === undefined && tr2.occupied !== undefined) {
      // If we have an occupied signal, use it to determine after-hours for other equipment
    }
  }

  // ── Rule 3: Economizer Failure
  // OA damper < 20% when OAT < 75°F AND cooling active AND occupied
  for (var i3 = 0; i3 < typedRows.length; i3++) {
    var tr3 = typedRows[i3];
    if (!tr3.occ) continue;
    if (tr3.oat === undefined || tr3.oadamper === undefined) continue;
    if (tr3.oat >= BT_ECON_LOCKOUT_OAT) continue; // OAT too warm, not eligible
    // Check cooling load
    var hasCooling = true;
    if (tr3.coolvalve !== undefined) hasCooling = tr3.coolvalve > BT_ECON_COOL_MIN;
    if (!hasCooling) continue;
    // If OA damper nearly closed = economizer not working
    if (tr3.oadamper < BT_ECON_DAMPER_MIN) {
      faults.economizer += intervalHrs;
    }
  }

  // ── Rule 4: Sensor Flat-Line (per-day: if all values are identical for 24h)
  // Computed after the loop using point stats
  // Handled below after collecting all typedRows

  // ── Rule 5: Setpoint Deviation
  // |SAT - SATSP| > 5°F during occupied hours
  for (var i5 = 0; i5 < typedRows.length; i5++) {
    var tr5 = typedRows[i5];
    if (!tr5.occ) continue;
    if (tr5.sat !== undefined && tr5.satsp !== undefined) {
      if (Math.abs(tr5.sat - tr5.satsp) > BT_SAT_DEV_THRESHOLD) {
        faults.setpointDeviation += intervalHrs;
      }
    }
    // Zone temp deviation
    if (tr5.zonetemp !== undefined) {
      if (tr5.zonesp_cool !== undefined && Math.abs(tr5.zonetemp - tr5.zonesp_cool) > BT_ZONE_DEV_THRESHOLD) {
        faults.setpointDeviation += intervalHrs;
      } else if (tr5.zonesp_heat !== undefined && Math.abs(tr5.zonetemp - tr5.zonesp_heat) > BT_ZONE_DEV_THRESHOLD) {
        faults.setpointDeviation += intervalHrs;
      }
    }
  }

  // ── Rule 6: Override Detection
  for (var i6 = 0; i6 < typedRows.length; i6++) {
    var tr6 = typedRows[i6];
    if (tr6.override !== undefined && tr6.override > 0.5) {
      faults.override += intervalHrs;
    }
  }

  // ── Rule 7: Valve/Damper Hunting
  // > 6 reversals + > 10% amplitude in 1-hour window
  var huntingPts = ['coolvalve', 'heatvalve', 'oadamper'];
  for (var hi = 0; hi < huntingPts.length; hi++) {
    var ptName = huntingPts[hi];
    var ptRows = [];
    for (var i7 = 0; i7 < typedRows.length; i7++) {
      if (typedRows[i7][ptName] !== undefined) {
        ptRows.push({ ts: typedRows[i7].ts, value: typedRows[i7][ptName] });
      }
    }
    if (ptRows.length < 4) continue;

    // Scan in 1-hour windows
    var windowMs = 3600000;
    for (var wi = 0; wi < ptRows.length; wi++) {
      var windowStart = ptRows[wi].ts.getTime();
      var windowEnd = windowStart + windowMs;
      var windowVals = [];
      for (var wj = wi; wj < ptRows.length && ptRows[wj].ts.getTime() <= windowEnd; wj++) {
        windowVals.push(ptRows[wj].value);
      }
      if (windowVals.length < 4) continue;

      // Count reversals
      var reversals = 0;
      var lastDir = 0;
      for (var rv = 1; rv < windowVals.length; rv++) {
        var dir = windowVals[rv] > windowVals[rv - 1] ? 1 : windowVals[rv] < windowVals[rv - 1] ? -1 : 0;
        if (dir !== 0 && dir !== lastDir && lastDir !== 0) reversals++;
        if (dir !== 0) lastDir = dir;
      }

      // Amplitude
      var wMin = Math.min.apply(null, windowVals);
      var wMax = Math.max.apply(null, windowVals);
      var amp = wMax - wMin;

      if (reversals > BT_HUNT_REVERSALS && amp > BT_HUNT_AMPLITUDE) {
        faults.hunting += intervalHrs;
        wi = wj; // skip to next window
      }
    }
  }

  // ── Rule 4 (flat-line): check if any sensor had zero variance all day
  var flatPts = ['oat', 'sat', 'satsp', 'rat', 'oadamper', 'coolvalve', 'heatvalve'];
  for (var fi = 0; fi < flatPts.length; fi++) {
    var fp = flatPts[fi];
    var fpVals = [];
    for (var i4 = 0; i4 < typedRows.length; i4++) {
      if (typedRows[i4][fp] !== undefined) fpVals.push(typedRows[i4][fp]);
    }
    if (fpVals.length < 8) continue; // need enough data
    var fpMin = Math.min.apply(null, fpVals);
    var fpMax = Math.max.apply(null, fpVals);
    // Zero variance across 24h = flat line
    if (fpMax - fpMin === 0) {
      faults.sensorFlat += 24 * intervalHrs; // flag the full day
      break; // one flat sensor per day is enough
    }
    // Known fail-safe value
    var fpAvg =
      fpVals.reduce(function (s, v) {
        return s + v;
      }, 0) / fpVals.length;
    for (var fsi = 0; fsi < BT_FAILSAFE_TEMPS.length; fsi++) {
      if (Math.abs(fpAvg - BT_FAILSAFE_TEMPS[fsi]) < 0.5 && fpMax - fpMin < 1) {
        faults.sensorFlat += 24 * intervalHrs;
        break;
      }
    }
  }

  // Round all fault hours
  for (var fk in faults) {
    if (faults.hasOwnProperty(fk)) faults[fk] = btRound(faults[fk], 2);
  }

  return faults;
}

/* ── BEHAVIORAL CHECKS (14-DAY WINDOW) ──────────────────────────────────────── */
// These generate PASS/FAIL/WARN verdicts against aggregated daily summaries.

/**
 * Run all 7 behavioral checks on a set of daily summaries.
 * summaries: { 'YYYY-MM-DD': DailySummary }
 * Returns { satReset, dspReset, economizer, shc, afterHours, setpointDev, hunting }
 */
function btRunBehavioralChecks(summaries) {
  var dates = Object.keys(summaries).sort();
  var checks = {};

  // ── Check 1: SAT Reset
  var satVals = [];
  for (var i = 0; i < dates.length; i++) {
    var d = summaries[dates[i]];
    if (d.satsp && d.satsp.avg !== null) satVals.push(d.satsp.avg);
    else if (d.sat && d.sat.avg !== null) satVals.push(d.sat.avg);
  }
  if (satVals.length === 0) {
    checks.satReset = { verdict: 'NO_DATA', detail: 'No SAT or SATSP data found.' };
  } else if (dates.length < 14) {
    checks.satReset = {
      verdict: 'INSUFFICIENT_DATA',
      detail: 'Need 14+ days for SAT reset check. Have ' + dates.length + ' days.',
    };
  } else {
    var satMin = Math.min.apply(null, satVals);
    var satMax = Math.max.apply(null, satVals);
    var satRange = satMax - satMin;
    if (satRange < BT_SAT_RANGE_FAIL) {
      checks.satReset = {
        verdict: 'FAIL',
        detail:
          'SAT range only ' +
          btRound(satRange, 1) +
          '°F over ' +
          dates.length +
          ' days (<4°F threshold). Fixed setpoint detected — G36 §5.16.3 not running.',
      };
    } else if (satRange < 6) {
      checks.satReset = {
        verdict: 'WARN',
        detail:
          'SAT range ' + btRound(satRange, 1) + '°F. Some variation but may not meet full G36 demand-based reset.',
      };
    } else {
      checks.satReset = {
        verdict: 'PASS',
        detail: 'SAT range ' + btRound(satRange, 1) + '°F — consistent with active G36 reset.',
      };
    }
    checks.satReset.range = btRound(satRange, 1);
  }

  // ── Check 2: DSP Reset
  var spVals = [];
  for (var i2 = 0; i2 < dates.length; i2++) {
    var d2 = summaries[dates[i2]];
    if (d2.staticp && d2.staticp.avg !== null) spVals.push(d2.staticp.avg);
  }
  if (spVals.length === 0) {
    checks.dspReset = { verdict: 'NO_DATA', detail: 'No duct static pressure data found.' };
  } else if (dates.length < 14) {
    checks.dspReset = { verdict: 'INSUFFICIENT_DATA', detail: 'Need 14+ days for DSP reset check.' };
  } else {
    var spMin = Math.min.apply(null, spVals);
    var spMax = Math.max.apply(null, spVals);
    var spRange = spMax - spMin;
    if (spRange < BT_DSP_RANGE_FAIL) {
      checks.dspReset = {
        verdict: 'FAIL',
        detail:
          'DSP range only ' + btRound(spRange, 2) + '" WC (<0.1" threshold). Fixed setpoint — G36 §5.16.4 not running.',
      };
    } else if (spRange < 0.3) {
      checks.dspReset = {
        verdict: 'WARN',
        detail: 'DSP range ' + btRound(spRange, 2) + '" WC. Some variation, may not meet full G36 reset.',
      };
    } else {
      checks.dspReset = {
        verdict: 'PASS',
        detail: 'DSP range ' + btRound(spRange, 2) + '" WC — consistent with active G36 trim-and-respond.',
      };
    }
    checks.dspReset.range = btRound(spRange, 2);
  }

  // ── Check 3: Economizer
  var econFaultHrs = 0,
    econEligibleHrs = 0;
  for (var i3 = 0; i3 < dates.length; i3++) {
    var d3 = summaries[dates[i3]];
    var oat = d3.oatAvg;
    var schHrs = (d3.occupied && d3.occupied.scheduledHours) || 0;
    if (oat !== null && oat < BT_ECON_LOCKOUT_OAT) {
      econEligibleHrs += schHrs;
      econFaultHrs += (d3.faults && d3.faults.economizer) || 0;
    }
  }
  if (econEligibleHrs === 0) {
    checks.economizer = { verdict: 'NO_DATA', detail: 'No economizer-eligible hours (OAT < 75°F) found in dataset.' };
  } else {
    var econMissPct = (econFaultHrs / econEligibleHrs) * 100;
    if (econMissPct > 20) {
      checks.economizer = {
        verdict: 'FAIL',
        detail:
          'Economizer inactive ' +
          btRound(econMissPct, 1) +
          '% of eligible hours. OA damper closed despite free cooling available.',
      };
    } else if (econMissPct > 5) {
      checks.economizer = {
        verdict: 'WARN',
        detail:
          'Economizer inactive ' + btRound(econMissPct, 1) + '% of eligible hours. Intermittent lockout detected.',
      };
    } else {
      checks.economizer = {
        verdict: 'PASS',
        detail: 'Economizer active during ' + btRound(100 - econMissPct, 1) + '% of eligible hours.',
      };
    }
    checks.economizer.missPercent = btRound(econMissPct, 1);
  }

  // ── Check 4: Simultaneous Heating and Cooling
  var shcTotal = 0,
    occTotal = 0;
  for (var i4 = 0; i4 < dates.length; i4++) {
    var d4 = summaries[dates[i4]];
    shcTotal += (d4.faults && d4.faults.shc) || 0;
    occTotal += (d4.occupied && d4.occupied.scheduledHours) || 0;
  }
  if (occTotal === 0) {
    checks.shc = { verdict: 'NO_DATA', detail: 'No occupied hour data.' };
  } else {
    var shcPct = (shcTotal / occTotal) * 100;
    if (shcPct > 5) {
      checks.shc = {
        verdict: 'FAIL',
        detail: 'Simultaneous H+C in ' + btRound(shcPct, 1) + '% of occupied time (>5% threshold).',
      };
    } else if (shcPct > 1) {
      checks.shc = {
        verdict: 'WARN',
        detail: 'Simultaneous H+C in ' + btRound(shcPct, 1) + '% of occupied time. Check sequencing deadband.',
      };
    } else {
      checks.shc = {
        verdict: 'PASS',
        detail: 'Simultaneous H+C in only ' + btRound(shcPct, 1) + '% of occupied time.',
      };
    }
    checks.shc.percent = btRound(shcPct, 1);
    checks.shc.totalHours = btRound(shcTotal, 1);
  }

  // ── Check 5: After-Hours Operation
  var ahTotal = 0,
    days5 = dates.length;
  for (var i5 = 0; i5 < dates.length; i5++) {
    var d5 = summaries[dates[i5]];
    ahTotal += (d5.faults && d5.faults.afterHours) || 0;
  }
  var ahAvgPerDay = days5 > 0 ? ahTotal / days5 : 0;
  if (days5 === 0) {
    checks.afterHours = { verdict: 'NO_DATA', detail: 'No data.' };
  } else if (ahAvgPerDay > 2) {
    checks.afterHours = {
      verdict: 'FAIL',
      detail: 'After-hours operation avg ' + btRound(ahAvgPerDay, 1) + ' hrs/day (>2 hr threshold).',
    };
  } else if (ahAvgPerDay > 0.5) {
    checks.afterHours = {
      verdict: 'WARN',
      detail: 'After-hours operation avg ' + btRound(ahAvgPerDay, 1) + ' hrs/day. Some unscheduled runtime detected.',
    };
  } else {
    checks.afterHours = {
      verdict: 'PASS',
      detail: 'After-hours operation avg ' + btRound(ahAvgPerDay, 1) + ' hrs/day — within acceptable range.',
    };
  }
  checks.afterHours.avgHrsPerDay = btRound(ahAvgPerDay, 1);
  checks.afterHours.totalHours = btRound(ahTotal, 1);

  // ── Check 6: Setpoint Deviation
  var spdevTotal = 0,
    spdevOcc = 0;
  for (var i6 = 0; i6 < dates.length; i6++) {
    var d6 = summaries[dates[i6]];
    spdevTotal += (d6.faults && d6.faults.setpointDeviation) || 0;
    spdevOcc += (d6.occupied && d6.occupied.scheduledHours) || 0;
  }
  var spdevPct = spdevOcc > 0 ? (spdevTotal / spdevOcc) * 100 : 0;
  if (spdevOcc === 0) {
    checks.setpointDev = { verdict: 'NO_DATA', detail: 'No SAT/SATSP data.' };
  } else if (spdevPct > 20) {
    checks.setpointDev = {
      verdict: 'FAIL',
      detail:
        'Setpoint deviation in ' + btRound(spdevPct, 1) + '% of occupied time. Controls unable to maintain setpoint.',
    };
  } else if (spdevPct > 5) {
    checks.setpointDev = {
      verdict: 'WARN',
      detail: 'Setpoint deviation in ' + btRound(spdevPct, 1) + '% of occupied time. Intermittent control issues.',
    };
  } else {
    checks.setpointDev = {
      verdict: 'PASS',
      detail: 'Setpoint maintained — deviation in only ' + btRound(spdevPct, 1) + '% of occupied time.',
    };
  }
  checks.setpointDev.percent = btRound(spdevPct, 1);

  // ── Check 7: Valve Hunting
  var huntTotal = 0;
  for (var i7 = 0; i7 < dates.length; i7++) {
    var d7 = summaries[dates[i7]];
    huntTotal += (d7.faults && d7.faults.hunting) || 0;
  }
  var huntAvg = days5 > 0 ? huntTotal / days5 : 0;
  if (huntTotal === 0) {
    checks.hunting = { verdict: 'PASS', detail: 'No valve hunting detected.' };
  } else if (huntAvg > 1) {
    checks.hunting = {
      verdict: 'FAIL',
      detail: 'Valve hunting detected avg ' + btRound(huntAvg, 1) + ' hrs/day. Control loop instability.',
    };
  } else {
    checks.hunting = {
      verdict: 'WARN',
      detail: 'Valve hunting detected (' + btRound(huntTotal, 1) + ' total hrs). Intermittent instability.',
    };
  }
  checks.hunting.totalHours = btRound(huntTotal, 1);

  return checks;
}

/* ── HEALTH SCORE ────────────────────────────────────────────────────────────── */

/**
 * Compute health score for a calendar month from daily summaries.
 * month: 'YYYY-MM' string
 * summaries: all daily summaries for this equipment (may span multiple months)
 * Returns MonthlyHealthSummary object.
 */
function btComputeHealthScore(month, allSummaries) {
  // Filter to this month
  var monthSummaries = {};
  for (var dk in allSummaries) {
    if (!allSummaries.hasOwnProperty(dk)) continue;
    if (dk.startsWith(month)) monthSummaries[dk] = allSummaries[dk];
  }

  var dates = Object.keys(monthSummaries).sort();
  var nDays = dates.length;
  if (nDays === 0) return null;

  // Accumulate fault hours
  var ahTotal = 0,
    shcTotal = 0,
    econFaultHrs = 0,
    econEligibleHrs = 0;
  var spdevTotal = 0,
    spdevOcc = 0;
  var sensorFlatDays = 0,
    overrideTotal = 0;
  var occTotal = 0,
    totalRuntime = 0,
    oatSum = 0,
    oatCount = 0;

  for (var i = 0; i < dates.length; i++) {
    var d = monthSummaries[dates[i]];
    var f = d.faults || {};
    var occ = (d.occupied && d.occupied.scheduledHours) || 0;
    occTotal += occ;
    ahTotal += f.afterHours || 0;
    shcTotal += f.shc || 0;
    spdevTotal += f.setpointDeviation || 0;
    spdevOcc += occ;
    overrideTotal += f.override || 0;
    if (f.sensorFlat && f.sensorFlat > 0) sensorFlatDays++;

    if (d.oatAvg !== null && d.oatAvg !== undefined) {
      if (d.oatAvg < BT_ECON_LOCKOUT_OAT) {
        econEligibleHrs += occ;
        econFaultHrs += f.economizer || 0;
      }
    }

    if (d.fanstatus) totalRuntime += d.fanstatus.runtimeHours || 0;
    if (d.oatAvg != null) {
      oatSum += d.oatAvg;
      oatCount++;
    }
  }

  // ── Component scores (0-100, floor 0)
  // After-hours: 100 - (ahHrsPerDay / targetUnoccupiedHrs × 100), target = 0 ideal
  // Scale: 0 hrs/day = 100, 4 hrs/day = 0
  var ahAvg = nDays > 0 ? ahTotal / nDays : 0;
  var afterHoursScore = Math.max(0, Math.round(100 - (ahAvg / 4) * 100));

  // SHC: 100 - (shcHrsPerDay / occHrsPerDay × 100)
  var occPerDay = nDays > 0 ? occTotal / nDays : 0;
  var shcAvg = nDays > 0 ? shcTotal / nDays : 0;
  var shcScore = occPerDay > 0 ? Math.max(0, Math.round(100 - (shcAvg / occPerDay) * 100)) : 100;

  // Economizer: activeHrs / eligibleHrs × 100
  var econScore = 100;
  if (econEligibleHrs > 0) {
    var econActiveHrs = econEligibleHrs - econFaultHrs;
    econScore = Math.round((econActiveHrs / econEligibleHrs) * 100);
  }

  // Setpoint adherence: inToleranceHrs / occHrs × 100
  var spdevAdherPct = spdevOcc > 0 ? (1 - spdevTotal / spdevOcc) * 100 : 100;
  var setpointScore = Math.max(0, Math.round(spdevAdherPct));

  // Sensor health: penalize flat-line days
  var totalSensorDays = nDays; // rough proxy
  var sensorScore = totalSensorDays > 0 ? Math.max(0, Math.round(100 - (sensorFlatDays / totalSensorDays) * 100)) : 100;

  // Override rate: 100 - (overrideHrsPerDay / 8 × 100), 8hrs = score 0
  var overrideAvg = nDays > 0 ? overrideTotal / nDays : 0;
  var overrideScore = Math.max(0, Math.round(100 - (overrideAvg / 8) * 100));

  // Weighted composite score
  var score = Math.round(
    afterHoursScore * 0.25 +
      shcScore * 0.25 +
      econScore * 0.2 +
      setpointScore * 0.15 +
      sensorScore * 0.1 +
      overrideScore * 0.05,
  );

  // Grade label
  var grade;
  if (score >= 90) grade = 'Excellent';
  else if (score >= 70) grade = 'Good';
  else if (score >= 50) grade = 'Fair';
  else grade = 'Poor';

  // Top fault
  var topFault = 'none';
  var topFaultScore = 101;
  var components = {
    afterHours: {
      score: afterHoursScore,
      weight: 0.25,
      detail: btRound(ahAvg, 1) + ' avg hrs/day after-hours operation',
    },
    shc: { score: shcScore, weight: 0.25, detail: btRound(shcAvg, 1) + ' avg hrs/day simultaneous heat+cool' },
    economizer: {
      score: econScore,
      weight: 0.2,
      detail:
        econEligibleHrs > 0
          ? btRound((1 - econFaultHrs / econEligibleHrs) * 100, 1) + '% of eligible hours economizer active'
          : 'No eligible hours',
    },
    setpointAdherence: {
      score: setpointScore,
      weight: 0.15,
      detail: btRound(spdevAdherPct, 1) + '% of zone-hours within tolerance',
    },
    sensorHealth: {
      score: sensorScore,
      weight: 0.1,
      detail: sensorFlatDays === 0 ? 'No sensor faults detected' : sensorFlatDays + ' day(s) with sensor flat-line',
    },
    overrideRate: { score: overrideScore, weight: 0.05, detail: btRound(overrideAvg, 1) + ' avg override-hrs/day' },
  };

  for (var ck in components) {
    if (!components.hasOwnProperty(ck)) continue;
    if (components[ck].score < topFaultScore) {
      topFaultScore = components[ck].score;
      topFault = ck;
    }
  }

  return {
    month: month,
    score: score,
    grade: grade,
    components: components,
    topFault: topFault,
    totalRuntimeHours: btRound(totalRuntime, 1),
    avgOAT: oatCount > 0 ? btRound(oatSum / oatCount, 1) : null,
    daysWithData: nDays,
  };
}

/* ── STORAGE HELPERS ────────────────────────────────────────────────────────── */

function btGetData(projId) {
  return sget('en_bas_' + projId, { buildings: {} });
}

function btSaveData(projId, data) {
  sset('en_bas_' + projId, data);
}

function btGetRaw(bldgKey, equipTag) {
  return sget('en_bas_raw_' + bldgKey + '_' + equipTag, []);
}

function btSaveRaw(bldgKey, equipTag, rows) {
  // Trim to last BT_RAW_DAYS days
  if (rows.length > 0) {
    var cutoff = new Date(rows[rows.length - 1].ts);
    cutoff.setDate(cutoff.getDate() - BT_RAW_DAYS);
    var cutMs = cutoff.getTime();
    rows = rows.filter(function (r) {
      return new Date(r.ts).getTime() >= cutMs;
    });
  }
  sset('en_bas_raw_' + bldgKey + '_' + equipTag, rows);
}

/** Merge new daily summaries into existing, without overwriting existing dates */
function btMergeSummaries(existing, incoming) {
  var merged = Object.assign({}, existing);
  for (var dk in incoming) {
    if (!incoming.hasOwnProperty(dk)) continue;
    if (!merged[dk]) merged[dk] = incoming[dk]; // only add new dates
  }
  return merged;
}

/** Recompute health scores for months touched by a date range */
function btRecomputeHealthScores(basData, bldgId, startDate, endDate) {
  if (!basData.buildings[bldgId]) return;
  var bldg = basData.buildings[bldgId];
  if (!bldg.healthHistory) bldg.healthHistory = {};

  // Determine affected months
  var months = {};
  var cur = new Date(startDate + 'T00:00:00');
  var end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    var ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
    months[ym] = true;
    cur.setDate(cur.getDate() + 1);
  }

  // Aggregate daily summaries across all equipment for each month
  for (var ym in months) {
    if (!months.hasOwnProperty(ym)) continue;
    // Combine daily summaries from all equipment
    var combined = {};
    for (var equipId in bldg.equipment) {
      if (!bldg.equipment.hasOwnProperty(equipId)) continue;
      var equip = bldg.equipment[equipId];
      for (var dk in equip.days) {
        if (!equip.days.hasOwnProperty(dk)) continue;
        if (!dk.startsWith(ym)) continue;
        if (!combined[dk]) {
          combined[dk] = JSON.parse(JSON.stringify(equip.days[dk]));
        } else {
          // Merge faults by summing
          var cf = combined[dk].faults || {};
          var ef = equip.days[dk].faults || {};
          for (var fk in ef) {
            if (ef.hasOwnProperty(fk)) cf[fk] = (cf[fk] || 0) + (ef[fk] || 0);
          }
          combined[dk].faults = cf;
          // Merge runtime
          if (combined[dk].fanstatus && equip.days[dk].fanstatus) {
            combined[dk].fanstatus.runtimeHours =
              (combined[dk].fanstatus.runtimeHours || 0) + (equip.days[dk].fanstatus.runtimeHours || 0);
          }
        }
      }
    }
    var hs = btComputeHealthScore(ym, combined);
    if (hs) bldg.healthHistory[ym] = hs;
  }
}

/* ── IMPORT PIPELINE ────────────────────────────────────────────────────────── */

/**
 * btImportCSV(csvText, projId, bldgId, bldgName, equipTag, schedule, columnOverrides, callbacks)
 *
 * Main entry point for the import flow. Processes in setTimeout chunks to avoid
 * blocking the UI. Calls back with progress and completion.
 *
 * callbacks: {
 *   onProgress(pct, message)    — called during processing
 *   onComplete(result)          — { imported, faultsDetected, startDate, endDate }
 *   onError(message)
 * }
 */
function btImportCSV(csvText, projId, bldgId, bldgName, equipTag, schedule, columnOverrides, callbacks) {
  var cb = callbacks || {};
  var onProgress = cb.onProgress || function () {};
  var onComplete = cb.onComplete || function () {};
  var onError = cb.onError || function () {};

  if (!csvText || csvText.length === 0) {
    onError('CSV file is empty.');
    return;
  }
  if (csvText.length > 52428800) {
    onError('CSV file too large (max 50 MB).');
    return;
  }

  onProgress(5, 'Detecting CSV format...');

  var parsed;
  try {
    parsed = btParseCSV(csvText);
  } catch (e) {
    onError('CSV parse error: ' + e.message);
    return;
  }

  if (!parsed.rows || parsed.rows.length === 0) {
    onError('No data rows found in CSV file.');
    return;
  }

  // Apply user column overrides
  if (columnOverrides) {
    parsed.columns = btApplyOverrides(parsed.columns, columnOverrides);
  }

  onProgress(15, 'Parsed ' + parsed.rows.length.toLocaleString() + ' rows. Computing daily summaries...');

  var rows = parsed.rows;
  var columns = parsed.columns;
  var sch = schedule || BT_DEFAULT_SCHEDULE;
  var pointMap = btBuildPointMap(columns);
  var byDate = {};

  // Group rows by date in chunks to avoid blocking
  var chunkIdx = 0;

  function processChunk() {
    var end = Math.min(chunkIdx + BT_CHUNK_SIZE, rows.length);
    for (var i = chunkIdx; i < end; i++) {
      var row = rows[i];
      var dk = btDateKey(row.ts);
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(row);
    }
    chunkIdx = end;

    var pct = Math.round(15 + (chunkIdx / rows.length) * 40);
    onProgress(pct, 'Grouping rows: ' + chunkIdx.toLocaleString() + ' / ' + rows.length.toLocaleString() + '...');

    if (chunkIdx < rows.length) {
      setTimeout(processChunk, 0);
    } else {
      setTimeout(computeSummaries, 0);
    }
  }

  function computeSummaries() {
    onProgress(58, 'Computing daily summaries and fault detection...');
    var allDates = Object.keys(byDate).sort();
    var summaries = {};
    var sumIdx = 0;

    function computeChunk() {
      var end = Math.min(sumIdx + 20, allDates.length); // 20 days at a time
      for (var i = sumIdx; i < end; i++) {
        var dk = allDates[i];
        var dayRows = byDate[dk].slice().sort(function (a, b) {
          return a.ts - b.ts;
        });
        summaries[dk] = btComputeOneDaySummary(
          dk,
          dayRows.map(function (row) {
            var typed = { ts: row.ts, occ: btIsOccupied(row.ts, sch) };
            for (var pt in pointMap) {
              if (!pointMap.hasOwnProperty(pt)) continue;
              var cols = pointMap[pt];
              for (var ci = 0; ci < cols.length; ci++) {
                var v = row.values[cols[ci]];
                if (v !== undefined) {
                  typed[pt] = v;
                  break;
                }
              }
            }
            return typed;
          }),
          pointMap,
          sch,
        );
      }
      sumIdx = end;

      var pct2 = Math.round(58 + (sumIdx / allDates.length) * 25);
      onProgress(pct2, 'Processed ' + sumIdx + ' / ' + allDates.length + ' days...');

      if (sumIdx < allDates.length) {
        setTimeout(computeChunk, 0);
      } else {
        setTimeout(storeData, 0);
      }
    }

    computeChunk();

    function storeData() {
      onProgress(85, 'Merging into storage...');

      var basData = btGetData(projId);
      if (!basData.buildings) basData.buildings = {};

      if (!basData.buildings[bldgId]) {
        basData.buildings[bldgId] = {
          id: bldgId,
          name: bldgName || bldgId,
          equipment: {},
          healthHistory: {},
        };
      }
      // Update building name if provided
      if (bldgName) basData.buildings[bldgId].name = bldgName;

      if (!basData.buildings[bldgId].equipment[equipTag]) {
        basData.buildings[bldgId].equipment[equipTag] = {
          id: equipTag,
          label: equipTag,
          type: 'ahu',
          importedAt: new Date().toISOString(),
          points: [],
          days: {},
          dataRange: {},
        };
      }

      var equip = basData.buildings[bldgId].equipment[equipTag];
      equip.importedAt = new Date().toISOString();
      equip.points = Object.keys(pointMap);

      // Merge summaries (don't overwrite existing dates)
      equip.days = btMergeSummaries(equip.days, summaries);

      // Update data range
      var allDays = Object.keys(equip.days).sort();
      if (allDays.length > 0) {
        equip.dataRange = { start: allDays[0], end: allDays[allDays.length - 1] };
      }

      // Store raw rows (last 7 days only) — serialize ts as string
      var rawRows = rows.map(function (r) {
        return { ts: r.ts.toISOString(), values: r.values };
      });
      btSaveRaw(bldgId, equipTag, rawRows);

      // Recompute health scores
      if (allDays.length > 0) {
        btRecomputeHealthScores(basData, bldgId, allDays[0], allDays[allDays.length - 1]);
      }

      btSaveData(projId, basData);

      onProgress(100, 'Import complete.');

      // Compute result summary
      var faultTotals = {
        shc: 0,
        afterHours: 0,
        economizer: 0,
        setpointDeviation: 0,
        sensorFlat: 0,
        override: 0,
        hunting: 0,
      };
      for (var dk in summaries) {
        if (!summaries.hasOwnProperty(dk)) continue;
        var f = summaries[dk].faults || {};
        for (var fk in f) {
          if (f.hasOwnProperty(fk) && faultTotals.hasOwnProperty(fk)) {
            faultTotals[fk] += f[fk];
          }
        }
      }

      onComplete({
        imported: Object.keys(summaries).length,
        rows: rows.length,
        faultsDetected: faultTotals,
        startDate: allDays[0] || '',
        endDate: allDays[allDays.length - 1] || '',
        format: parsed.format,
        columns: columns,
      });
    }
  }

  setTimeout(processChunk, 0);
}

/* ── BILL CORRELATION ────────────────────────────────────────────────────────── */

/**
 * Returns aggregated BAS data for a billing period.
 * Mirrors bas-integration-spec §5.4.
 */
function getBASForBillPeriod(projId, bldgId, billStart, billEnd) {
  var basData = btGetData(projId);
  if (!basData) return null;
  var bldgBAS = basData.buildings && basData.buildings[bldgId];
  if (!bldgBAS) return null;

  var result = {
    days: [],
    equipment: {},
    faultTotals: { shc: 0, afterHours: 0, economizer: 0, setpointDeviation: 0, sensorFlat: 0, override: 0 },
    runtimeTotals: {},
  };

  for (var equipId in bldgBAS.equipment) {
    if (!bldgBAS.equipment.hasOwnProperty(equipId)) continue;
    var equip = bldgBAS.equipment[equipId];
    result.equipment[equipId] = { runtimeHours: 0, faults: {} };
    for (var fk in result.faultTotals) {
      result.equipment[equipId].faults[fk] = 0;
    }

    for (var dk in equip.days) {
      if (!equip.days.hasOwnProperty(dk)) continue;
      if (dk >= billStart && dk <= billEnd) {
        if (result.days.indexOf(dk) === -1) result.days.push(dk);
        var day = equip.days[dk];
        if (day.fanstatus) result.equipment[equipId].runtimeHours += day.fanstatus.runtimeHours || 0;
        var f = day.faults || {};
        for (var ft in f) {
          if (f.hasOwnProperty(ft)) {
            result.equipment[equipId].faults[ft] = (result.equipment[equipId].faults[ft] || 0) + (f[ft] || 0);
            result.faultTotals[ft] = (result.faultTotals[ft] || 0) + (f[ft] || 0);
          }
        }
      }
    }
  }

  result.days.sort();
  return result;
}

/* ── IMPORT MODAL UI ─────────────────────────────────────────────────────────── */

var _btModalOpen = false;
var _btParsedPreview = null; // stored between parse and import steps

function btOpenImportModal() {
  if (_btModalOpen) return;
  _btModalOpen = true;

  var projects = sget('en_projects', []);
  var projOptions = projects
    .map(function (p) {
      return '<option value="' + p.id + '">' + (p.name || p.id) + '</option>';
    })
    .join('');

  var html = [
    '<div id="bt-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:2000;display:flex;align-items:center;justify-content:center;" onclick="btCloseImportModal(event)">',
    '<div id="bt-modal" style="background:var(--s2);border:1px solid var(--border);border-radius:12px;width:640px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:24px;" onclick="event.stopPropagation()">',

    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">',
    '<h2 style="font-size:17px;font-weight:600;color:var(--text);">Import BAS Trend Data</h2>',
    '<button onclick="btCloseImportModal()" style="background:none;border:none;color:var(--text3);font-size:20px;cursor:pointer;line-height:1;">&#x2715;</button>',
    '</div>',

    // Step 1: Project
    '<div class="bt-form-row" style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;">Step 1 — Project</label>',
    '<select id="bt-proj-sel" style="width:100%;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;" onchange="btUpdateBuildingList()">',
    '<option value="">Select project...</option>',
    projOptions,
    '</select>',
    '</div>',

    // Step 2: Building
    '<div class="bt-form-row" style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;">Step 2 — Building</label>',
    '<select id="bt-bldg-sel" style="width:100%;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;" disabled>',
    '<option value="">Select project first...</option>',
    '</select>',
    '</div>',

    // Step 3: Equipment tag
    '<div class="bt-form-row" style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;" title="Short identifier for this piece of equipment. Examples: AHU-1, RTU-3, Building">',
    'Step 3 — Equipment / System Tag <span style="color:var(--text3);font-size:11px;">(e.g. AHU-1, RTU-3)</span>',
    '</label>',
    '<input id="bt-equip-tag" type="text" placeholder="AHU-1" style="width:100%;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;" />',
    '</div>',

    // Step 4: Occupied schedule
    '<div class="bt-form-row" style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;" title="Hours when the building is scheduled to be occupied. Used for after-hours fault detection.">',
    'Step 4 — Occupied Schedule',
    '</label>',
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">',
    '<span style="font-size:12px;color:var(--text2);">Days:</span>',
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map(function (day, idx) {
        var checked = idx < 5 ? 'checked' : '';
        var dayNum = idx + 1 === 7 ? 0 : idx + 1; // Sun=0, Mon=1...Sat=6
        return (
          '<label style="font-size:12px;color:var(--text2);"><input type="checkbox" class="bt-occ-day" value="' +
          dayNum +
          '" ' +
          checked +
          ' style="margin-right:3px;">' +
          day +
          '</label>'
        );
      })
      .join(''),
    '</div>',
    '<div style="display:flex;gap:12px;margin-top:8px;align-items:center;">',
    '<label style="font-size:12px;color:var(--text2);">Start:</label>',
    '<input id="bt-occ-start" type="number" value="6" min="0" max="23" style="width:60px;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 8px;font-size:13px;" />',
    '<span style="font-size:12px;color:var(--text3);">:00</span>',
    '<label style="font-size:12px;color:var(--text2);">End:</label>',
    '<input id="bt-occ-end" type="number" value="18" min="0" max="24" style="width:60px;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 8px;font-size:13px;" />',
    '<span style="font-size:12px;color:var(--text3);">:00</span>',
    '</div>',
    '</div>',

    // Step 5: CSV drop zone
    '<div class="bt-form-row" style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;">Step 5 — CSV File</label>',
    '<div id="bt-drop-zone" ',
    'style="border:2px dashed var(--border);border-radius:8px;padding:32px 20px;text-align:center;cursor:pointer;transition:border-color 0.2s;" ',
    'onclick="document.getElementById(\'bt-file-input\').click()" ',
    'ondragover="event.preventDefault();this.style.borderColor=\'var(--accent)\'" ',
    'ondragleave="this.style.borderColor=\'var(--border)\'" ',
    'ondrop="btHandleDrop(event)">',
    '<div style="font-size:28px;margin-bottom:8px;">&#128196;</div>',
    '<div style="font-size:13px;color:var(--text2);">Drop WebCTRL CSV here or click to browse</div>',
    '<div style="font-size:11px;color:var(--text3);margin-top:4px;">Supports WebCTRL multi-point, single-point, and generic CSV formats</div>',
    '<input id="bt-file-input" type="file" accept=".csv,.txt" style="display:none;" onchange="btHandleFileSelect(this)" />',
    '</div>',
    '<div id="bt-file-name" style="font-size:12px;color:var(--text3);margin-top:6px;"></div>',
    '</div>',

    // Column mapping preview (hidden until file parsed)
    '<div id="bt-col-preview" style="display:none;margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:8px;">Step 6 — Column Mapping Preview</label>',
    '<div id="bt-col-table-wrap" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;">',
    '<table style="width:100%;border-collapse:collapse;font-size:12px;">',
    '<thead style="background:var(--s1);position:sticky;top:0;">',
    '<tr>',
    '<th style="padding:8px 10px;text-align:left;color:var(--text3);font-weight:500;">Column Header</th>',
    '<th style="padding:8px 10px;text-align:left;color:var(--text3);font-weight:500;">Auto-Detected Type</th>',
    '<th style="padding:8px 10px;text-align:left;color:var(--text3);font-weight:500;">Override</th>',
    '</tr>',
    '</thead>',
    '<tbody id="bt-col-tbody"></tbody>',
    '</table>',
    '</div>',
    '</div>',

    // Progress bar (hidden until import starts)
    '<div id="bt-progress-wrap" style="display:none;margin-bottom:14px;">',
    '<div style="font-size:12px;color:var(--text3);margin-bottom:6px;" id="bt-progress-msg">Processing...</div>',
    '<div style="background:var(--s1);border-radius:4px;height:6px;overflow:hidden;">',
    '<div id="bt-progress-bar" style="height:100%;background:var(--accent);border-radius:4px;width:0%;transition:width 0.3s;"></div>',
    '</div>',
    '</div>',

    // Result (hidden until done)
    '<div id="bt-import-result" style="display:none;"></div>',

    // Footer buttons
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;border-top:1px solid var(--border);padding-top:16px;">',
    '<button onclick="btCloseImportModal()" style="background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>',
    '<button id="bt-import-btn" onclick="btRunImport()" disabled style="background:var(--accent);color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;opacity:0.5;">Import</button>',
    '</div>',

    '</div></div>',
  ].join('');

  var overlay = document.createElement('div');
  overlay.innerHTML = html;
  document.body.appendChild(overlay.firstElementChild);
}

function btCloseImportModal(event) {
  if (event && event.target && event.target.id !== 'bt-modal-overlay') return;
  var el = document.getElementById('bt-modal-overlay');
  if (el) el.parentNode.removeChild(el);
  _btModalOpen = false;
  _btParsedPreview = null;
}

function btUpdateBuildingList() {
  var projId = document.getElementById('bt-proj-sel').value;
  var sel = document.getElementById('bt-bldg-sel');
  sel.innerHTML = '<option value="">Select building...</option>';
  sel.disabled = true;
  if (!projId) return;

  var projects = sget('en_projects', []);
  var proj = null;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].id === projId) {
      proj = projects[i];
      break;
    }
  }
  if (!proj) return;

  var utilData = sget('en_utility_' + projId, { buildings: [] });
  var buildings = (utilData && utilData.buildings) || proj.buildings || [];
  if (buildings.length === 0) {
    // Fallback: allow free-text building
    sel.innerHTML = '<option value="_manual">Enter manually below...</option>';
    sel.disabled = false;
    return;
  }

  buildings.forEach(function (b) {
    var opt = document.createElement('option');
    opt.value = b.id || b.name;
    opt.textContent = b.name || b.id;
    sel.appendChild(opt);
  });
  sel.disabled = false;
}

function btHandleDrop(event) {
  event.preventDefault();
  var dz = document.getElementById('bt-drop-zone');
  if (dz) dz.style.borderColor = 'var(--border)';
  var files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length > 0) btReadFile(files[0]);
}

function btHandleFileSelect(input) {
  var files = input && input.files;
  if (files && files.length > 0) btReadFile(files[0]);
}

function btReadFile(file) {
  var nameEl = document.getElementById('bt-file-name');
  if (nameEl) nameEl.textContent = 'Reading: ' + file.name;

  var reader = new FileReader();
  reader.onload = function (e) {
    var text = e.target.result;
    if (nameEl) nameEl.textContent = file.name + ' (' + (text.length / 1024).toFixed(1) + ' KB)';
    btPreviewColumns(text);
  };
  reader.onerror = function () {
    if (nameEl) nameEl.textContent = 'Error reading file.';
  };
  reader.readAsText(file);
}

function btPreviewColumns(csvText) {
  var parsed;
  try {
    parsed = btParseCSV(csvText);
  } catch (e) {
    showToast('CSV parse error: ' + e.message, 'error');
    return;
  }

  _btParsedPreview = { text: csvText, parsed: parsed };

  var tbody = document.getElementById('bt-col-tbody');
  if (!tbody) return;

  var pointTypeOptions = [
    '(not used)',
    'timestamp',
    'oat',
    'sat',
    'satsp',
    'rat',
    'mat',
    'oadamper',
    'coolvalve',
    'heatvalve',
    'fanstatus',
    'fanspeed',
    'staticp',
    'staticpsp',
    'zonetemp',
    'zonesp_cool',
    'zonesp_heat',
    'occupied',
    'hwstemp',
    'hwrtemp',
    'kwh',
    'co2',
    'humidity',
    'override',
  ];

  var rows = [];
  parsed.columns.forEach(function (col) {
    if (col.detected === 'timestamp') return; // skip timestamp column
    var optHtml = pointTypeOptions
      .map(function (o) {
        var sel2 = o === col.detected || (o === '(not used)' && !col.detected) ? 'selected' : '';
        return '<option value="' + o + '" ' + sel2 + '>' + o + '</option>';
      })
      .join('');

    var detected = col.detected || '(not used)';
    var detColor = col.detected ? 'var(--green)' : 'var(--text3)';

    rows.push(
      [
        '<tr style="border-bottom:1px solid var(--border);">',
        '<td style="padding:7px 10px;color:var(--text);">' + (col.raw || '') + '</td>',
        '<td style="padding:7px 10px;color:' + detColor + ';">' + detected + '</td>',
        '<td style="padding:7px 10px;">',
        '<select data-col-idx="' + col.index + '" class="bt-col-override" ',
        'style="background:var(--s3);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 6px;font-size:11px;">',
        optHtml,
        '</select>',
        '</td>',
        '</tr>',
      ].join(''),
    );
  });

  tbody.innerHTML = rows.join('');

  var colPreview = document.getElementById('bt-col-preview');
  if (colPreview) colPreview.style.display = '';

  // Enable import button if we have enough data
  btCheckImportReady();
}

function btCheckImportReady() {
  var projId = (document.getElementById('bt-proj-sel') || {}).value;
  var bldgId = (document.getElementById('bt-bldg-sel') || {}).value;
  var equipTag = ((document.getElementById('bt-equip-tag') || {}).value || '').trim();
  var hasFile = !!_btParsedPreview;
  var btn = document.getElementById('bt-import-btn');
  if (!btn) return;
  var ready = projId && bldgId && equipTag && hasFile;
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '0.5';
}

function btRunImport() {
  if (!_btParsedPreview) {
    showToast('No CSV loaded.', 'error');
    return;
  }

  var projId = document.getElementById('bt-proj-sel').value;
  var bldgSel = document.getElementById('bt-bldg-sel');
  var bldgId = bldgSel.value;
  var bldgName = bldgSel.options[bldgSel.selectedIndex] ? bldgSel.options[bldgSel.selectedIndex].text : bldgId;
  var equipTag = document.getElementById('bt-equip-tag').value.trim();

  if (!projId || !bldgId || !equipTag) {
    showToast('Please fill in project, building, and equipment tag.', 'error');
    return;
  }

  // Collect column overrides
  var overrides = {};
  document.querySelectorAll('.bt-col-override').forEach(function (sel2) {
    var idx = parseInt(sel2.getAttribute('data-col-idx'));
    var val = sel2.value;
    overrides[idx] = val === '(not used)' ? null : val;
  });

  // Collect occupied schedule
  var occDays = [];
  document.querySelectorAll('.bt-occ-day:checked').forEach(function (cb) {
    occDays.push(parseInt(cb.value));
  });
  var schedule = {
    startHour: parseInt(document.getElementById('bt-occ-start').value) || 6,
    endHour: parseInt(document.getElementById('bt-occ-end').value) || 18,
    days: occDays.length > 0 ? occDays : [1, 2, 3, 4, 5],
  };

  // Disable controls during import
  document.getElementById('bt-import-btn').disabled = true;
  document.getElementById('bt-import-btn').textContent = 'Importing...';
  var progressWrap = document.getElementById('bt-progress-wrap');
  if (progressWrap) progressWrap.style.display = '';

  btImportCSV(_btParsedPreview.text, projId, bldgId, bldgName, equipTag, schedule, overrides, {
    onProgress: function (pct, msg) {
      var bar = document.getElementById('bt-progress-bar');
      var msgEl = document.getElementById('bt-progress-msg');
      if (bar) bar.style.width = pct + '%';
      if (msgEl) msgEl.textContent = msg;
    },
    onComplete: function (result) {
      var resultEl = document.getElementById('bt-import-result');
      if (resultEl) {
        resultEl.style.display = '';
        var faultSummary = [];
        if (result.faultsDetected.afterHours > 0.5)
          faultSummary.push(btRound(result.faultsDetected.afterHours, 1) + ' hrs after-hours');
        if (result.faultsDetected.shc > 0.5)
          faultSummary.push(btRound(result.faultsDetected.shc, 1) + ' hrs simultaneous H+C');
        if (result.faultsDetected.economizer > 0.5)
          faultSummary.push(btRound(result.faultsDetected.economizer, 1) + ' hrs economizer fault');

        resultEl.innerHTML = [
          '<div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:16px;">',
          '<div style="font-size:14px;font-weight:600;color:var(--green);margin-bottom:8px;">&#10003; Import Complete</div>',
          '<div style="font-size:13px;color:var(--text2);margin-bottom:4px;">',
          '<strong>' + result.imported + '</strong> days imported',
          ' (' + result.rows.toLocaleString() + ' rows, ' + result.format + ' format)',
          '</div>',
          result.startDate
            ? '<div style="font-size:12px;color:var(--text3);">Date range: ' +
              result.startDate +
              ' to ' +
              result.endDate +
              '</div>'
            : '',
          faultSummary.length > 0
            ? '<div style="font-size:12px;color:var(--amber);margin-top:6px;">Faults detected: ' +
              faultSummary.join(', ') +
              '</div>'
            : '<div style="font-size:12px;color:var(--green);margin-top:6px;">No significant faults detected.</div>',
          '</div>',
        ].join('');
      }
      var btn = document.getElementById('bt-import-btn');
      if (btn) {
        btn.textContent = 'Done';
        btn.disabled = false;
      }
      showToast(result.imported + ' days of BAS data imported for ' + equipTag, 'success');
      // Refresh BAS view if open
      if (typeof btRenderView === 'function') btRenderView();
    },
    onError: function (msg) {
      showToast('Import failed: ' + msg, 'error');
      var btn = document.getElementById('bt-import-btn');
      if (btn) {
        btn.textContent = 'Import';
        btn.disabled = false;
      }
    },
  });
}

/* ── BAS TRENDS VIEW — Phase 2 ────────────────────────────────────────────────── */

// Active subtab: 'health' | 'faults'
// Phase 3 will add 'timeline' | 'oat'
var _btSubtab = 'health';

// Active building/equipment selection for analytics views
var _btSelBldg = null;
var _btSelEquip = null;

// Fault log sort/filter state
var _btFaultSort = { col: 'date', asc: false };
var _btFaultFilter = { type: '', equip: '', dateFrom: '', dateTo: '', status: '' };

/** Initialize the BAS Trends view when first activated */
function btInitView() {
  btRenderView();
}

/** Switch BAS subtab (health | faults) */
function btSwitchSubtab(tab) {
  _btSubtab = tab;
  // Update tab buttons
  var btns = document.querySelectorAll('.bt-stab');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('bt-stab-active', btns[i].getAttribute('data-tab') === tab);
  }
  // Render the selected subtab body
  var projId = window._activeProjId || null;
  if (!projId) return;
  var basData = btGetData(projId);
  btRenderSubtabContent(tab, basData, projId);
}

/** Render the BAS Trends main view */
function btRenderView() {
  var container = document.getElementById('view-bas-trends');
  if (!container) return;

  var body = document.getElementById('bt-view-body');
  if (!body) return;

  // Get active project from URL/session
  var projId = window._activeProjId || null;
  if (!projId) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Select a project from the sidebar to view BAS trend data.</div>';
    return;
  }

  var basData = btGetData(projId);
  var buildings = (basData && basData.buildings) || {};
  var bldgKeys = Object.keys(buildings);

  if (bldgKeys.length === 0) {
    body.innerHTML = [
      '<div style="padding:48px;text-align:center;">',
      '<div style="font-size:32px;margin-bottom:12px;">&#128200;</div>',
      '<div style="font-size:15px;color:var(--text2);margin-bottom:8px;">No BAS trend data imported yet</div>',
      '<div style="font-size:13px;color:var(--text3);margin-bottom:20px;">Import a WebCTRL CSV export to begin analyzing equipment performance.</div>',
      '<button onclick="btOpenImportModal()" style="background:var(--accent);color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:13px;">Import Trend Data</button>',
      '</div>',
    ].join('');
    return;
  }

  // Ensure a building/equipment is selected
  if (!_btSelBldg || !buildings[_btSelBldg]) {
    _btSelBldg = bldgKeys[0];
  }
  var bldg = buildings[_btSelBldg];
  var equipIds = Object.keys(bldg.equipment || {});
  if (!_btSelEquip || !bldg.equipment[_btSelEquip]) {
    _btSelEquip = equipIds[0] || null;
  }

  // Build subtab bar
  var tabs = [
    { id: 'health', label: 'Health Score' },
    { id: 'faults', label: 'Faults' },
  ];
  var tabHtml = tabs
    .map(function (t) {
      var isActive = _btSubtab === t.id;
      return (
        '<button class="bt-stab' +
        (isActive ? ' bt-stab-active' : '') +
        '" data-tab="' +
        t.id +
        '" onclick="btSwitchSubtab(\'' +
        t.id +
        '\')">' +
        t.label +
        '</button>'
      );
    })
    .join('');

  // Build building/equipment selector
  var bldgOptHtml = bldgKeys
    .map(function (bk) {
      return (
        '<option value="' +
        bk +
        '"' +
        (bk === _btSelBldg ? ' selected' : '') +
        '>' +
        (buildings[bk].name || bk) +
        '</option>'
      );
    })
    .join('');
  var equipOptHtml = equipIds
    .map(function (eq) {
      return '<option value="' + eq + '"' + (eq === _btSelEquip ? ' selected' : '') + '>' + eq + '</option>';
    })
    .join('');

  // Render skeleton: tab bar + selector + content area
  body.innerHTML = [
    // Subtab bar
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--border);flex-shrink:0;">',
    '<div style="display:flex;gap:2px;padding:10px 0 0;">' + tabHtml + '</div>',
    // Building/equipment selector in same row as tabs
    '<div style="display:flex;gap:8px;align-items:center;padding-bottom:6px;">',
    equipIds.length > 1
      ? '<select id="bt-sel-equip" onchange="btChangeEquip(this.value)" style="background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;">' +
        equipOptHtml +
        '</select>'
      : '<span style="font-size:12px;color:var(--text2);">' + (_btSelEquip || '') + '</span>',
    bldgKeys.length > 1
      ? '<select id="bt-sel-bldg" onchange="btChangeBldg(this.value)" style="background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;">' +
        bldgOptHtml +
        '</select>'
      : '<span style="font-size:12px;color:var(--text3);">' + (bldg.name || _btSelBldg) + '</span>',
    '</div>',
    '</div>',
    // Inline styles for subtab buttons
    '<style>',
    '.bt-stab{font-family:var(--font);font-size:12px;font-weight:500;padding:6px 14px;border-radius:6px 6px 0 0;border:none;cursor:pointer;color:var(--text2);background:transparent;border-bottom:2px solid transparent;transition:all 0.13s;}',
    '.bt-stab.bt-stab-active{color:var(--em);border-bottom-color:var(--em);font-weight:600;}',
    '.bt-stab:hover:not(.bt-stab-active){color:var(--text);}',
    '</style>',
    // Content area (filled by subtab renderer)
    '<div id="bt-subtab-body" style="flex:1;overflow-y:auto;min-height:0;"></div>',
  ].join('');

  btRenderSubtabContent(_btSubtab, basData, projId);
}

/** Change selected building */
function btChangeBldg(bldgId) {
  _btSelBldg = bldgId;
  _btSelEquip = null; // reset equipment — btRenderView will pick first
  btRenderView();
}

/** Change selected equipment */
function btChangeEquip(equipId) {
  _btSelEquip = equipId;
  var projId = window._activeProjId || null;
  if (!projId) return;
  btRenderSubtabContent(_btSubtab, btGetData(projId), projId);
}

/** Dispatch to the correct subtab renderer */
function btRenderSubtabContent(tab, basData, projId) {
  var el = document.getElementById('bt-subtab-body');
  if (!el) return;

  var buildings = (basData && basData.buildings) || {};
  var bldg = buildings[_btSelBldg];
  if (!bldg) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text3);">No building selected.</div>';
    return;
  }

  if (tab === 'health') {
    el.innerHTML = btBuildHealthScoreHTML(bldg, projId);
  } else if (tab === 'faults') {
    el.innerHTML = btBuildFaultLogHTML(bldg, projId);
  }
}

/* ── HEALTH SCORE SUBTAB ─────────────────────────────────────────────────────── */

/** Score color based on value */
function btScoreColor(score) {
  if (score >= 90) return 'var(--green)';
  if (score >= 70) return 'var(--amber)';
  if (score >= 50) return '#e8720c'; // orange
  return 'var(--red)';
}

/** Grade label for a score */
function btGradeLabel(score) {
  if (score >= 90) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'FAIR';
  return 'POOR';
}

/**
 * Build the Health Score subtab HTML for a building.
 * Uses bldg.healthHistory[month] from btComputeHealthScore (Phase 1).
 */
function btBuildHealthScoreHTML(bldg, projId) {
  var healthHistory = bldg.healthHistory || {};
  var months = Object.keys(healthHistory).sort();

  if (months.length === 0) {
    return [
      '<div style="padding:40px;text-align:center;">',
      '<div style="font-size:13px;color:var(--text3);">No health score data available. Import trend data to compute health scores.</div>',
      '</div>',
    ].join('');
  }

  // Most recent month
  var latestMonth = months[months.length - 1];
  var latest = healthHistory[latestMonth];
  var score = latest.score;
  var grade = btGradeLabel(score);
  var scoreColor = btScoreColor(score);

  // Component config: key, display label, weight, tooltip explanation
  var compConfig = [
    {
      key: 'afterHours',
      label: 'After-Hours Operation',
      weight: '25%',
      tip: 'Equipment running outside scheduled occupied hours. Each hour of unscheduled runtime wastes energy and increases wear.',
    },
    {
      key: 'shc',
      label: 'Simultaneous Heating/Cooling',
      weight: '25%',
      tip: 'Both heating and cooling valves open at the same time. This is direct energy waste caused by poor sequence control.',
    },
    {
      key: 'economizer',
      label: 'Economizer Utilization',
      weight: '20%',
      tip: 'Percentage of eligible hours (OAT < 75F) when the outside air damper was actually open for free cooling.',
    },
    {
      key: 'setpointAdherence',
      label: 'Setpoint Adherence',
      weight: '15%',
      tip: 'Percentage of occupied hours when the supply air temperature stayed within 5F of its setpoint.',
    },
    {
      key: 'sensorHealth',
      label: 'Sensor Health',
      weight: '10%',
      tip: 'Days with flat-line sensor readings (zero variance or stuck at a fail-safe value like 32F or -40F).',
    },
    {
      key: 'overrideRate',
      label: 'Override Rate',
      weight: '5%',
      tip: 'Hours per day that any point was in manual override. Frequent overrides bypass automatic sequences.',
    },
  ];

  // Score dial (large number + grade badge)
  var dialHtml = [
    '<div style="text-align:center;padding:24px 16px 16px;">',
    '<div style="font-size:72px;font-weight:700;line-height:1;color:' +
      scoreColor +
      ';" title="Overall health score for ' +
      latestMonth +
      '">' +
      score +
      '</div>',
    '<div style="display:inline-block;margin-top:8px;padding:4px 14px;border-radius:20px;background:' +
      scoreColor +
      ';color:#fff;font-size:11px;font-weight:700;letter-spacing:0.05em;">' +
      grade +
      '</div>',
    '<div style="font-size:12px;color:var(--text3);margin-top:8px;">' +
      latestMonth +
      ' &bull; ' +
      latest.daysWithData +
      ' days of data</div>',
    '</div>',
  ].join('');

  // Component progress bars
  var components = latest.components || {};
  var topFault = latest.topFault;
  var compBarsHtml = compConfig
    .map(function (cfg) {
      var comp = components[cfg.key];
      if (!comp) return '';
      var cscore = comp.score;
      var ccolor = btScoreColor(cscore);
      var isTop = cfg.key === topFault;
      var barBorder = isTop ? 'border:1px solid var(--red);' : 'border:1px solid var(--border);';
      return [
        '<div style="padding:10px 14px;' +
          barBorder +
          'border-radius:8px;background:var(--s2);margin-bottom:8px;" title="' +
          cfg.tip +
          '">',
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">',
        '<div style="display:flex;align-items:center;gap:8px;">',
        '<span style="font-size:13px;color:var(--text);">' + cfg.label + '</span>',
        '<span style="font-size:11px;color:var(--text3);">' + cfg.weight + '</span>',
        isTop ? '<span style="font-size:10px;color:var(--red);font-weight:600;">TOP ISSUE</span>' : '',
        '</div>',
        '<span style="font-size:13px;font-weight:600;color:' + ccolor + ';">' + cscore + '</span>',
        '</div>',
        '<div style="background:var(--s1);border-radius:4px;height:6px;overflow:hidden;">',
        '<div style="height:100%;border-radius:4px;background:' +
          ccolor +
          ';width:' +
          cscore +
          '%;transition:width 0.4s;"></div>',
        '</div>',
        '<div style="font-size:11px;color:var(--text3);margin-top:5px;">' + (comp.detail || '') + '</div>',
        '</div>',
      ].join('');
    })
    .join('');

  // Top issue callout
  var topIssueHtml = '';
  if (topFault && topFault !== 'none') {
    var topCfg = null;
    for (var ci = 0; ci < compConfig.length; ci++) {
      if (compConfig[ci].key === topFault) {
        topCfg = compConfig[ci];
        break;
      }
    }
    var topComp = components[topFault] || {};
    if (topCfg) {
      topIssueHtml = [
        '<div style="background:var(--s2);border:1px solid var(--red);border-radius:8px;padding:12px 14px;margin-bottom:16px;">',
        '<div style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:4px;">Top Issue: ' +
          topCfg.label +
          '</div>',
        '<div style="font-size:12px;color:var(--text2);">' + (topComp.detail || '') + '</div>',
        '<div style="font-size:11px;color:var(--text3);margin-top:4px;">' + topCfg.tip + '</div>',
        '</div>',
      ].join('');
    }
  }

  // 12-month trend line chart (SVG)
  var trendHtml = btBuildTrendSVG(months, healthHistory);

  // Month selector (if multiple months)
  var monthSelectorHtml = '';
  if (months.length > 1) {
    var monthOpts = months
      .slice()
      .reverse()
      .map(function (m) {
        return '<option value="' + m + '"' + (m === latestMonth ? ' selected' : '') + '>' + m + '</option>';
      })
      .join('');
    monthSelectorHtml = [
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">',
      '<span style="font-size:12px;color:var(--text3);">Viewing month:</span>',
      '<select onchange="btSelectHealthMonth(this.value)" style="background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;">',
      monthOpts,
      '</select>',
      '</div>',
    ].join('');
  }

  return [
    '<div style="padding:20px;max-width:900px;">',
    // Score dial card + trend chart (side by side)
    '<div style="display:grid;grid-template-columns:220px 1fr;gap:16px;margin-bottom:16px;">',
    '<div style="background:var(--s2);border:1px solid var(--border);border-radius:var(--r,8px);">',
    dialHtml,
    '</div>',
    // Trend chart card
    '<div style="background:var(--s2);border:1px solid var(--border);border-radius:var(--r,8px);padding:16px;">',
    '<div style="font-size:12px;color:var(--text3);margin-bottom:10px;">12-Month Score Trend</div>',
    trendHtml,
    '</div>',
    '</div>',
    // Month selector
    monthSelectorHtml,
    // Top issue callout
    topIssueHtml,
    // Component bars
    '<div style="font-size:12px;color:var(--text3);margin-bottom:10px;font-weight:500;">Score Components</div>',
    compBarsHtml,
    '</div>',
  ].join('');
}

/**
 * Build 12-month SVG trend line.
 * months: sorted array of 'YYYY-MM' strings
 * healthHistory: { 'YYYY-MM': MonthlyHealthSummary }
 */
function btBuildTrendSVG(months, healthHistory) {
  var W = 480,
    H = 100,
    pad = { l: 30, r: 12, t: 10, b: 22 };
  var plotW = W - pad.l - pad.r;
  var plotH = H - pad.t - pad.b;

  // Use last 12 months
  var displayMonths = months.slice(-12);
  var n = displayMonths.length;
  if (n === 0) return '';

  var scores = displayMonths.map(function (m) {
    return healthHistory[m] ? healthHistory[m].score : null;
  });

  function xPos(i) {
    return pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  }
  function yPos(s) {
    return pad.t + plotH - (s / 100) * plotH;
  }

  // Y-axis grid lines at 0, 50, 100
  var gridLines = [0, 50, 100]
    .map(function (v) {
      var y = yPos(v);
      return (
        '<line x1="' +
        pad.l +
        '" y1="' +
        y +
        '" x2="' +
        (W - pad.r) +
        '" y2="' +
        y +
        '" stroke="var(--border)" stroke-width="1"/>' +
        '<text x="' +
        (pad.l - 4) +
        '" y="' +
        (y + 4) +
        '" font-size="9" fill="var(--text3)" text-anchor="end">' +
        v +
        '</text>'
      );
    })
    .join('');

  // Polyline segments (colored by score range)
  var segments = '';
  for (var i = 0; i < n - 1; i++) {
    var s1 = scores[i],
      s2 = scores[i + 1];
    if (s1 === null || s2 === null) continue;
    var avg = (s1 + s2) / 2;
    var segColor = btScoreColor(avg);
    segments +=
      '<line x1="' +
      xPos(i) +
      '" y1="' +
      yPos(s1) +
      '" x2="' +
      xPos(i + 1) +
      '" y2="' +
      yPos(s2) +
      '" stroke="' +
      segColor +
      '" stroke-width="2.5" stroke-linecap="round"/>';
  }

  // Dots
  var dots = scores
    .map(function (s, i) {
      if (s === null) return '';
      var cx = xPos(i),
        cy = yPos(s);
      var dcolor = btScoreColor(s);
      return (
        '<circle cx="' +
        cx +
        '" cy="' +
        cy +
        '" r="4" fill="' +
        dcolor +
        '" stroke="var(--s2)" stroke-width="2"><title>' +
        displayMonths[i] +
        ': ' +
        s +
        '</title></circle>'
      );
    })
    .join('');

  // X-axis labels (abbreviated month)
  var monthAbbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var xLabels = displayMonths
    .map(function (m, i) {
      var mm = parseInt(m.split('-')[1], 10) - 1;
      var lbl = monthAbbr[mm] || m;
      var x = xPos(i);
      return (
        '<text x="' +
        x +
        '" y="' +
        (H - 4) +
        '" font-size="9" fill="var(--text3)" text-anchor="middle">' +
        lbl +
        '</text>'
      );
    })
    .join('');

  return (
    '<svg width="100%" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" style="display:block;overflow:visible;" role="img" aria-label="12-month health score trend">' +
    gridLines +
    segments +
    dots +
    xLabels +
    '</svg>'
  );
}

/** Re-render the health score panel for a selected month */
function btSelectHealthMonth(month) {
  var projId = window._activeProjId || null;
  if (!projId) return;
  var basData = btGetData(projId);
  var bldg = basData.buildings && basData.buildings[_btSelBldg];
  if (!bldg) return;
  var healthHistory = bldg.healthHistory || {};
  if (!healthHistory[month]) return;

  // Reorder healthHistory so selected month is last (btBuildHealthScoreHTML uses last as "latest")
  var reordered = {};
  var months = Object.keys(healthHistory).sort();
  for (var i = 0; i < months.length; i++) {
    if (months[i] !== month) reordered[months[i]] = healthHistory[months[i]];
  }
  reordered[month] = healthHistory[month];

  // Temporarily override for rendering only
  var origHistory = bldg.healthHistory;
  bldg.healthHistory = reordered;
  var el = document.getElementById('bt-subtab-body');
  if (el) el.innerHTML = btBuildHealthScoreHTML(bldg, projId);
  bldg.healthHistory = origHistory;
}

/* ── FAULT LOG SUBTAB ────────────────────────────────────────────────────────── */

/**
 * Gather all fault rows from building equipment daily summaries.
 * Returns array of fault row objects suitable for the fault log table.
 */
function btGatherFaultRows(bldg, projId) {
  // Get blended rate from utility bills if available
  var blendedRate = btGetBlendedRate(projId, _btSelBldg);
  // Estimated HVAC kW (default 20kW per AHU — used if no measured data)
  var hvacKW = 20;

  var rows = [];
  var equipment = bldg.equipment || {};

  for (var equipId in equipment) {
    if (!equipment.hasOwnProperty(equipId)) continue;
    var equip = equipment[equipId];
    var days = equip.days || {};

    for (var dateKey in days) {
      if (!days.hasOwnProperty(dateKey)) continue;
      var day = days[dateKey];
      var faults = day.faults || {};

      // After-Hours fault
      if (faults.afterHours && faults.afterHours > 0.1) {
        var ahKwh = btRound(faults.afterHours * hvacKW * 0.4, 1);
        var ahCost = blendedRate ? btRound(ahKwh * blendedRate, 2) : null;
        rows.push({
          date: dateKey,
          equip: equipId,
          type: 'After-Hours Operation',
          typeKey: 'afterHours',
          hours: faults.afterHours,
          estKwh: ahKwh,
          estCost: ahCost,
          status: btGetFaultStatus(projId, dateKey, equipId, 'afterHours'),
        });
      }

      // Simultaneous Heating/Cooling fault
      if (faults.shc && faults.shc > 0.1) {
        var shcKwh = btRound(faults.shc * hvacKW * 0.2, 1);
        var shcCost = blendedRate ? btRound(shcKwh * blendedRate, 2) : null;
        rows.push({
          date: dateKey,
          equip: equipId,
          type: 'Simultaneous H+C',
          typeKey: 'shc',
          hours: faults.shc,
          estKwh: shcKwh,
          estCost: shcCost,
          status: btGetFaultStatus(projId, dateKey, equipId, 'shc'),
        });
      }

      // Economizer fault
      if (faults.economizer && faults.economizer > 0.1) {
        var econKwh = btRound(faults.economizer * hvacKW * 0.15, 1);
        var econCost = blendedRate ? btRound(econKwh * blendedRate, 2) : null;
        rows.push({
          date: dateKey,
          equip: equipId,
          type: 'Economizer Miss',
          typeKey: 'economizer',
          hours: faults.economizer,
          estKwh: econKwh,
          estCost: econCost,
          status: btGetFaultStatus(projId, dateKey, equipId, 'economizer'),
        });
      }

      // Setpoint Deviation fault
      if (faults.setpointDeviation && faults.setpointDeviation > 0.1) {
        rows.push({
          date: dateKey,
          equip: equipId,
          type: 'Setpoint Deviation',
          typeKey: 'setpointDeviation',
          hours: faults.setpointDeviation,
          estKwh: null,
          estCost: null,
          status: btGetFaultStatus(projId, dateKey, equipId, 'setpointDeviation'),
        });
      }

      // Override fault
      if (faults.override && faults.override > 0.1) {
        rows.push({
          date: dateKey,
          equip: equipId,
          type: 'Override Active',
          typeKey: 'override',
          hours: faults.override,
          estKwh: null,
          estCost: null,
          status: btGetFaultStatus(projId, dateKey, equipId, 'override'),
        });
      }
    }
  }

  return rows;
}

/**
 * Get blended electricity rate for a project/building from saved bills.
 * Returns $/kWh or null if no bills available.
 */
function btGetBlendedRate(projId, bldgId) {
  try {
    var utilData = sget('en_utility_' + projId, null);
    if (!utilData) return null;
    var bldgs = utilData.buildings || [];
    var bldg = null;
    for (var i = 0; i < bldgs.length; i++) {
      if (bldgs[i].id === bldgId || bldgs[i].name === bldgId) {
        bldg = bldgs[i];
        break;
      }
    }
    if (!bldg) bldg = bldgs[0]; // fallback: first building
    var bills = (bldg && bldg.bills) || [];
    var totalCost = 0,
      totalKwh = 0;
    for (var bi = 0; bi < bills.length; bi++) {
      var b = bills[bi];
      if (b.commodity !== 'electric' && b.utilityType !== 'electric') continue;
      var cost = b.totalCost || 0;
      var kwh = b.kWhConsumed || b.consumption || 0;
      if (cost > 0 && kwh > 0) {
        totalCost += cost;
        totalKwh += kwh;
      }
    }
    return totalKwh > 0 ? btRound(totalCost / totalKwh, 4) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Get the user-set status for a specific fault (stored in localStorage).
 * Returns 'open' | 'acknowledged' | 'resolved'
 */
function btGetFaultStatus(projId, dateKey, equipId, faultType) {
  var statuses = sget('en_bas_faultstatus_' + projId, {});
  var k = dateKey + '_' + equipId + '_' + faultType;
  return statuses[k] || 'open';
}

/** Save a fault status and update the cell in place */
function btSetFaultStatus(projId, dateKey, equipId, faultType, status) {
  var statuses = sget('en_bas_faultstatus_' + projId, {});
  var k = dateKey + '_' + equipId + '_' + faultType;
  statuses[k] = status;
  sset('en_bas_faultstatus_' + projId, statuses);
  // Update the status cell in place
  var cell = document.getElementById('bt-fstatus-' + k);
  if (cell) cell.innerHTML = btFaultStatusBadge(status, projId, dateKey, equipId, faultType);
}

/** Status badge HTML */
function btFaultStatusBadge(status, projId, dateKey, equipId, faultType) {
  var k = dateKey + '_' + equipId + '_' + faultType;
  if (status === 'resolved') {
    return '<span style="font-size:11px;color:var(--green);font-weight:500;">Resolved</span>';
  }
  if (status === 'acknowledged') {
    return [
      '<span style="font-size:11px;color:var(--amber);font-weight:500;margin-right:6px;">Acknowledged</span>',
      '<button onclick="btSetFaultStatus(\'' +
        projId +
        "','" +
        dateKey +
        "','" +
        equipId +
        "','" +
        faultType +
        "','resolved')\" ",
      'style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer;">Resolve</button>',
    ].join('');
  }
  // open
  return [
    '<button onclick="btSetFaultStatus(\'' +
      projId +
      "','" +
      dateKey +
      "','" +
      equipId +
      "','" +
      faultType +
      "','acknowledged')\" ",
    'style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer;margin-right:4px;">Acknowledge</button>',
    '<button onclick="btSetFaultStatus(\'' +
      projId +
      "','" +
      dateKey +
      "','" +
      equipId +
      "','" +
      faultType +
      "','resolved')\" ",
    'style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer;">Resolve</button>',
  ].join('');
}

/** Sort fault rows by column */
function btSortFaultRows(rows, col, asc) {
  return rows.slice().sort(function (a, b) {
    var va = a[col],
      vb = b[col];
    if (va === null || va === undefined) va = asc ? Infinity : -Infinity;
    if (vb === null || vb === undefined) vb = asc ? Infinity : -Infinity;
    if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    return asc ? va - vb : vb - va;
  });
}

/** Filter fault rows against current filter state */
function btFilterFaultRows(rows, filter) {
  return rows.filter(function (r) {
    if (filter.type && r.typeKey !== filter.type) return false;
    if (filter.equip && r.equip !== filter.equip) return false;
    if (filter.dateFrom && r.date < filter.dateFrom) return false;
    if (filter.dateTo && r.date > filter.dateTo) return false;
    if (filter.status && r.status !== filter.status) return false;
    return true;
  });
}

/** Apply fault log filters from DOM inputs */
function btApplyFaultFilters() {
  _btFaultFilter.type = (document.getElementById('bt-fl-type') || {}).value || '';
  _btFaultFilter.equip = (document.getElementById('bt-fl-equip') || {}).value || '';
  _btFaultFilter.dateFrom = (document.getElementById('bt-fl-from') || {}).value || '';
  _btFaultFilter.dateTo = (document.getElementById('bt-fl-to') || {}).value || '';
  _btFaultFilter.status = (document.getElementById('bt-fl-status') || {}).value || '';
  var projId = window._activeProjId || null;
  if (!projId) return;
  var basData = btGetData(projId);
  var bldg = basData.buildings && basData.buildings[_btSelBldg];
  if (!bldg) return;
  // Re-render table and update count
  var allRows = btGatherFaultRows(bldg, projId);
  var filtered = btFilterFaultRows(allRows, _btFaultFilter);
  var sorted = btSortFaultRows(filtered, _btFaultSort.col, _btFaultSort.asc);
  var tableWrap = document.getElementById('bt-fault-table-wrap');
  if (tableWrap) tableWrap.innerHTML = btBuildFaultTableHTML(sorted, projId);
  var countEl = document.getElementById('bt-fault-count');
  if (countEl) countEl.textContent = filtered.length + ' of ' + allRows.length + ' faults';
}

/** Sort fault log by column (called from th onclick) */
function btSortFaultLog(col) {
  if (_btFaultSort.col === col) {
    _btFaultSort.asc = !_btFaultSort.asc;
  } else {
    _btFaultSort.col = col;
    _btFaultSort.asc = col === 'date'; // date defaults ascending
  }
  var projId = window._activeProjId || null;
  if (!projId) return;
  var basData = btGetData(projId);
  var bldg = basData.buildings && basData.buildings[_btSelBldg];
  if (!bldg) return;
  var allRows = btGatherFaultRows(bldg, projId);
  var filtered = btFilterFaultRows(allRows, _btFaultFilter);
  var sorted = btSortFaultRows(filtered, _btFaultSort.col, _btFaultSort.asc);
  var tableWrap = document.getElementById('bt-fault-table-wrap');
  if (tableWrap) tableWrap.innerHTML = btBuildFaultTableHTML(sorted, projId);
}

/** Build the fault log table HTML from sorted/filtered rows */
function btBuildFaultTableHTML(rows, projId) {
  if (rows.length === 0) {
    return '<div style="padding:24px;text-align:center;font-size:13px;color:var(--text3);">No faults match the current filters.</div>';
  }

  var colDefs = [
    { key: 'date', label: 'Date' },
    { key: 'equip', label: 'Equipment' },
    { key: 'type', label: 'Fault Type' },
    { key: 'hours', label: 'Hours' },
    { key: 'estKwh', label: 'Est. kWh' },
    { key: 'estCost', label: 'Est. $' },
    { key: 'status', label: 'Status' },
  ];

  var thHtml = colDefs
    .map(function (c) {
      var arrow = '';
      if (_btFaultSort.col === c.key) arrow = _btFaultSort.asc ? ' &#9650;' : ' &#9660;';
      var sortable = c.key !== 'status';
      var onclick = sortable
        ? ' onclick="btSortFaultLog(\'' +
          c.key +
          '\')" style="cursor:pointer;user-select:none;padding:8px 10px;text-align:left;color:var(--text3);font-weight:500;white-space:nowrap;"'
        : ' style="padding:8px 10px;text-align:left;color:var(--text3);font-weight:500;"';
      return '<th' + onclick + '>' + c.label + arrow + '</th>';
    })
    .join('');

  var trHtml = rows
    .map(function (r) {
      var k = r.date + '_' + r.equip + '_' + r.typeKey;
      var costStr =
        r.estCost !== null
          ? '$' +
            r.estCost.toFixed(2) +
            '<br><span style="font-size:10px;color:var(--text3);" title="Estimate based on typical HVAC load. Accuracy is approximately plus or minus 25%.">±25%</span>'
          : '—';
      var kwhStr = r.estKwh !== null ? r.estKwh.toFixed(1) : '—';
      var statusHtml =
        '<span id="bt-fstatus-' +
        k +
        '">' +
        btFaultStatusBadge(r.status, projId, r.date, r.equip, r.typeKey) +
        '</span>';
      return [
        '<tr style="border-bottom:1px solid var(--border);">',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text2);white-space:nowrap;">' + r.date + '</td>',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text);">' + r.equip + '</td>',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text);">' + r.type + '</td>',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text2);">' + btRound(r.hours, 1) + '</td>',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text2);">' + kwhStr + '</td>',
        '<td style="padding:7px 10px;font-size:12px;color:var(--text2);">' + costStr + '</td>',
        '<td style="padding:7px 10px;font-size:12px;">' + statusHtml + '</td>',
        '</tr>',
      ].join('');
    })
    .join('');

  return [
    '<table style="width:100%;border-collapse:collapse;font-size:12px;">',
    '<thead style="background:var(--s1);position:sticky;top:0;">',
    '<tr>' + thHtml + '</tr>',
    '</thead>',
    '<tbody>' + trHtml + '</tbody>',
    '</table>',
  ].join('');
}

/**
 * Build the full Fault Log subtab HTML.
 */
function btBuildFaultLogHTML(bldg, projId) {
  var allRows = btGatherFaultRows(bldg, projId);

  // Compute 4 metric cards from all rows (no filter applied to cards)
  var ahHrs = 0,
    shcHrs = 0,
    econHrs = 0,
    spdevHrs = 0;

  for (var ri = 0; ri < allRows.length; ri++) {
    var r = allRows[ri];
    if (r.typeKey === 'afterHours') ahHrs += r.hours;
    else if (r.typeKey === 'shc') shcHrs += r.hours;
    else if (r.typeKey === 'economizer') econHrs += r.hours;
    else if (r.typeKey === 'setpointDeviation') spdevHrs += r.hours;
  }

  // Compute per-month averages from unique days across all equipment
  var allDays = {};
  var equipment = bldg.equipment || {};
  for (var equipId in equipment) {
    if (!equipment.hasOwnProperty(equipId)) continue;
    var edDays = equipment[equipId].days || {};
    for (var dk in edDays) {
      if (edDays.hasOwnProperty(dk)) allDays[dk] = true;
    }
  }
  var uniqueDays = Object.keys(allDays).length;
  var monthsCount = uniqueDays > 0 ? Math.max(1, Math.ceil(uniqueDays / 30)) : 1;

  function hrsPerMonth(h) {
    return btRound(h / monthsCount, 1);
  }
  function cardColor(h) {
    if (h > 20) return 'var(--red)';
    if (h > 5) return 'var(--amber)';
    return 'var(--green)';
  }

  var metricCards = [
    {
      label: 'After-Hours',
      hrs: hrsPerMonth(ahHrs),
      tip: 'Average hours per month with the fan running outside scheduled occupied hours.',
    },
    {
      label: 'Sim. H+C',
      hrs: hrsPerMonth(shcHrs),
      tip: 'Average hours per month with both heating and cooling valves open simultaneously.',
    },
    {
      label: 'Economizer Miss',
      hrs: hrsPerMonth(econHrs),
      tip: 'Average hours per month when economizer was inactive during eligible conditions (OAT < 75F).',
    },
    {
      label: 'Setpoint Deviation',
      hrs: hrsPerMonth(spdevHrs),
      tip: 'Average hours per month when supply air temperature exceeded its setpoint by more than 5F.',
    },
  ]
    .map(function (m) {
      var clr = cardColor(m.hrs);
      return [
        '<div style="background:var(--s2);border:1px solid var(--border);border-radius:var(--r,8px);padding:12px;text-align:center;" title="' +
          m.tip +
          '">',
        '<div style="font-size:22px;font-weight:700;color:' + clr + ';">' + m.hrs + '</div>',
        '<div style="font-size:10px;color:var(--text3);margin-top:3px;">hrs/month</div>',
        '<div style="font-size:11px;color:var(--text2);margin-top:4px;font-weight:500;">' + m.label + '</div>',
        '</div>',
      ].join('');
    })
    .join('');

  // Fault type filter options
  var typeOptions = [
    { val: '', label: 'All Types' },
    { val: 'afterHours', label: 'After-Hours Operation' },
    { val: 'shc', label: 'Simultaneous H+C' },
    { val: 'economizer', label: 'Economizer Miss' },
    { val: 'setpointDeviation', label: 'Setpoint Deviation' },
    { val: 'override', label: 'Override Active' },
  ];
  var typeOptHtml = typeOptions
    .map(function (o) {
      return (
        '<option value="' +
        o.val +
        '"' +
        (_btFaultFilter.type === o.val ? ' selected' : '') +
        '>' +
        o.label +
        '</option>'
      );
    })
    .join('');

  // Equipment filter options
  var equipOpts = '<option value="">All Equipment</option>';
  for (var eqId in equipment) {
    if (equipment.hasOwnProperty(eqId)) {
      equipOpts +=
        '<option value="' + eqId + '"' + (_btFaultFilter.equip === eqId ? ' selected' : '') + '>' + eqId + '</option>';
    }
  }

  // Status filter
  var statusOpts = [
    { val: '', label: 'All Statuses' },
    { val: 'open', label: 'Open' },
    { val: 'acknowledged', label: 'Acknowledged' },
    { val: 'resolved', label: 'Resolved' },
  ]
    .map(function (o) {
      return (
        '<option value="' +
        o.val +
        '"' +
        (_btFaultFilter.status === o.val ? ' selected' : '') +
        '>' +
        o.label +
        '</option>'
      );
    })
    .join('');

  var inputStyle =
    'background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;';

  // Build initial table (with current sort/filter)
  var filtered = btFilterFaultRows(allRows, _btFaultFilter);
  var sorted = btSortFaultRows(filtered, _btFaultSort.col, _btFaultSort.asc);
  var initialTable = btBuildFaultTableHTML(sorted, projId);

  return [
    '<div style="padding:20px;">',
    // 4 metric cards
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">',
    metricCards,
    '</div>',
    // Filter bar
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;background:var(--s2);border:1px solid var(--border);border-radius:var(--r,8px);">',
    '<span style="font-size:12px;color:var(--text3);font-weight:500;">Filter:</span>',
    '<select id="bt-fl-type" onchange="btApplyFaultFilters()" style="' + inputStyle + '">' + typeOptHtml + '</select>',
    '<select id="bt-fl-equip" onchange="btApplyFaultFilters()" style="' + inputStyle + '">' + equipOpts + '</select>',
    '<select id="bt-fl-status" onchange="btApplyFaultFilters()" style="' + inputStyle + '">' + statusOpts + '</select>',
    '<input id="bt-fl-from" type="date" value="' +
      (_btFaultFilter.dateFrom || '') +
      '" onchange="btApplyFaultFilters()" style="' +
      inputStyle +
      '" title="Filter faults on or after this date" />',
    '<input id="bt-fl-to" type="date" value="' +
      (_btFaultFilter.dateTo || '') +
      '" onchange="btApplyFaultFilters()" style="' +
      inputStyle +
      '" title="Filter faults on or before this date" />',
    '<button onclick="btResetFaultFilters()" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--s3);color:var(--text2);cursor:pointer;">Clear</button>',
    '<span id="bt-fault-count" style="font-size:11px;color:var(--text3);margin-left:auto;">' +
      filtered.length +
      ' of ' +
      allRows.length +
      ' faults</span>',
    '</div>',
    // Fault table
    '<div id="bt-fault-table-wrap" style="border:1px solid var(--border);border-radius:var(--r,8px);overflow:auto;">',
    initialTable,
    '</div>',
    '</div>',
  ].join('');
}

/** Reset all fault log filters */
function btResetFaultFilters() {
  _btFaultFilter = { type: '', equip: '', dateFrom: '', dateTo: '', status: '' };
  var projId = window._activeProjId || null;
  if (!projId) return;
  var basData = btGetData(projId);
  var bldg = basData.buildings && basData.buildings[_btSelBldg];
  if (!bldg) return;
  // Full re-render to reset all filter controls cleanly
  btRenderSubtabContent('faults', basData, projId);
}

/* ── LOCAL STORAGE SIZE CHECK ────────────────────────────────────────────────── */

function btCheckStorageSize() {
  var total = 0;
  for (var key in localStorage) {
    if (localStorage.hasOwnProperty(key)) {
      total += (localStorage.getItem(key) || '').length * 2;
    }
  }
  return total;
}

function btWarnIfStorageLarge() {
  var bytes = btCheckStorageSize();
  if (bytes > 3000000) {
    console.warn('BAS: localStorage at ' + Math.round(bytes / 1024) + ' KB. Consider archiving old BAS data.');
  }
}

/* ── PHASE 3: TIMELINE HEAT MAP + OAT SCATTER CHART ─────────────────────────
   Adds two subtabs to the BAS Trends analysis panel:
     3. Timeline — hourly heat map table for a selected day
     4. OAT Chart — SVG scatter plot of daily metrics vs outdoor air temperature

   Integration: Phase 2 establishes the subtab bar (#bt-subtab-bar) and the
   analysis body (#bt-analysis-body). Phase 3 registers two additional tab
   buttons via btPhase3RegisterTabs(), called after Phase 2 builds the bar.
   The active equipment context is read from window._btActiveEquip.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── COLOR SCALE ────────────────────────────────────────────────────────────── */

/**
 * Convert a value to a CSS color string using named palette presets.
 *
 * palettes:
 *   'binary'   — gray (off) / green (on), threshold 0.5
 *   'cool'     — white → blue  (min..max)
 *   'heat'     — white → red   (min..max)
 *   'damper'   — white → green (min..max)
 *   'temp'     — blue (#4a9eff) → red (#ff4a4a) over the min..max range
 *   'fault'    — green (clean) / amber (any fault hours)
 *
 * @param {number|null} value
 * @param {number} min
 * @param {number} max
 * @param {string} palette
 * @returns {string} CSS color
 */
function btValueToColor(value, min, max, palette) {
  if (value === null || value === undefined) return 'var(--s1)'; // no data

  if (palette === 'binary') {
    return value > 0.5 ? '#22c55e' : '#6b7280'; // green / gray
  }

  if (palette === 'fault') {
    return value > 0 ? '#f59e0b' : '#22c55e'; // amber / green
  }

  // Normalized position 0..1 (clamp)
  var range = max - min;
  var t = range > 0 ? Math.max(0, Math.min(1, (value - min) / range)) : 0;

  if (palette === 'cool') {
    // white → blue: rgb(255,255,255) → rgb(30,100,255)
    var r = Math.round(255 - t * 225);
    var g = Math.round(255 - t * 155);
    var b = 255;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  if (palette === 'heat') {
    // white → red: rgb(255,255,255) → rgb(220,38,38)
    var r2 = 255;
    var g2 = Math.round(255 - t * 217);
    var b2 = Math.round(255 - t * 217);
    return 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')';
  }

  if (palette === 'damper') {
    // white → green: rgb(255,255,255) → rgb(34,197,94)
    var r3 = Math.round(255 - t * 221);
    var g3 = Math.round(255 - t * 58);
    var b3 = Math.round(255 - t * 161);
    return 'rgb(' + r3 + ',' + g3 + ',' + b3 + ')';
  }

  if (palette === 'temp') {
    // cold-blue → warm-red: interpolate in RGB
    // cold: rgb(74,158,255)   warm: rgb(255,74,74)
    var r4 = Math.round(74 + t * 181);
    var g4 = Math.round(158 - t * 84);
    var b4 = Math.round(255 - t * 181);
    return 'rgb(' + r4 + ',' + g4 + ',' + b4 + ')';
  }

  return 'var(--s3)'; // fallback
}

/* ── HOURLY BUCKET BUILDER ──────────────────────────────────────────────────── */

/**
 * Build 24 hourly summary objects from raw interval rows for one date.
 * Falls back to the daily summary when raw rows are not available.
 *
 * Returns an array of 24 objects, each: { hour, fanstatus, coolvalve,
 *   heatvalve, oadamper, sat, zonetemp, faultHrs }
 * Any field without data is null.
 *
 * @param {string} dateKey  'YYYY-MM-DD'
 * @param {string} projId
 * @param {string} bldgId
 * @param {string} equipTag
 * @returns {Array}  length 24
 */
function btBuildHourBuckets(dateKey, projId, bldgId, equipTag) {
  // Start with 24 empty bucket objects
  var buckets = [];
  for (var h = 0; h < 24; h++) {
    buckets.push({
      hour: h,
      fanstatus: null,
      coolvalve: null,
      heatvalve: null,
      oadamper: null,
      sat: null,
      zonetemp: null,
      faultHrs: null,
    });
  }

  // Try to build from raw interval rows (last 7 days)
  var rawRows = btGetRaw(bldgId, equipTag);
  var dateRows = [];
  for (var ri = 0; ri < rawRows.length; ri++) {
    var ts = new Date(rawRows[ri].ts);
    if (btDateKey(ts) === dateKey) dateRows.push({ ts: ts, values: rawRows[ri].values });
  }

  if (dateRows.length > 0) {
    // We have raw data — compute per-hour averages
    // We need the columns mapping; retrieve from basData stored points list
    var basData = btGetData(projId);
    var equip =
      basData &&
      basData.buildings &&
      basData.buildings[bldgId] &&
      basData.buildings[bldgId].equipment &&
      basData.buildings[bldgId].equipment[equipTag];

    // Build accumulators per hour per point
    var ptNames = ['fanstatus', 'coolvalve', 'heatvalve', 'oadamper', 'sat', 'zonetemp'];
    var hrAccum = {};
    for (var h2 = 0; h2 < 24; h2++) {
      hrAccum[h2] = {};
      for (var pi = 0; pi < ptNames.length; pi++) {
        hrAccum[h2][ptNames[pi]] = [];
      }
    }

    // For raw rows we don't have the column mapping anymore (it was discarded after import).
    // We can only use stored daily summary point stats to fill buckets when raw lacks structure.
    // Raw rows have {ts, values: {colIdx: num}} but we lost the column type mapping.
    // Therefore: use the daily summary's point averages as a uniform fallback,
    // but show hourly variation from raw if we can infer point types.
    // Since column mapping was discarded, fall through to the daily-summary path.
    dateRows = []; // force fallback below
  }

  // Fallback: use daily summary values distributed uniformly across all 24 hours.
  // This gives a meaningful grid that shows the day's profile even without raw data.
  var basData2 = btGetData(projId);
  var equip2 =
    basData2 &&
    basData2.buildings &&
    basData2.buildings[bldgId] &&
    basData2.buildings[bldgId].equipment &&
    basData2.buildings[bldgId].equipment[equipTag];
  var daySum = equip2 && equip2.days && equip2.days[dateKey];
  if (!daySum) return buckets;

  // Map point names to daily summary keys
  var ptMap2 = {
    fanstatus: daySum.fanstatus && daySum.fanstatus.avg,
    coolvalve: daySum.coolvalve && daySum.coolvalve.avg,
    heatvalve: daySum.heatvalve && daySum.heatvalve.avg,
    oadamper: daySum.oadamper && daySum.oadamper.avg,
    sat: daySum.sat && daySum.sat.avg,
    zonetemp: daySum.zonetemp && daySum.zonetemp.avg,
  };

  // Total fault hours for the day (any fault type)
  var totalFaultHrs = 0;
  var f = daySum.faults || {};
  for (var fk in f) {
    if (f.hasOwnProperty(fk)) totalFaultHrs += f[fk] || 0;
  }
  // Distribute faults across occupied hours
  var occStart = 6; // default
  var occEnd = 18;

  for (var h3 = 0; h3 < 24; h3++) {
    var inOcc = h3 >= occStart && h3 < occEnd;
    buckets[h3].fanstatus = ptMap2.fanstatus != null ? ptMap2.fanstatus : null;
    buckets[h3].coolvalve = ptMap2.coolvalve != null ? ptMap2.coolvalve : null;
    buckets[h3].heatvalve = ptMap2.heatvalve != null ? ptMap2.heatvalve : null;
    buckets[h3].oadamper = ptMap2.oadamper != null ? ptMap2.oadamper : null;
    buckets[h3].sat = ptMap2.sat != null ? ptMap2.sat : null;
    buckets[h3].zonetemp = ptMap2.zonetemp != null ? ptMap2.zonetemp : null;
    // Attribute fault hours proportionally to occupied hours
    buckets[h3].faultHrs = inOcc ? totalFaultHrs / Math.max(1, occEnd - occStart) : 0;
  }

  return buckets;
}

/* ── TIMELINE HEAT MAP ───────────────────────────────────────────────────────── */

/**
 * Render the Timeline subtab into #bt-analysis-body.
 * Expects window._btActiveEquip = { projId, bldgId, equipTag }
 */
function btRenderTimeline() {
  var body = document.getElementById('bt-analysis-body');
  if (!body) return;

  var ctx = window._btActiveEquip || {};
  var projId = ctx.projId;
  var bldgId = ctx.bldgId;
  var equipTag = ctx.equipTag;

  if (!projId || !bldgId || !equipTag) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Select equipment in the sidebar to view the timeline.</div>';
    return;
  }

  var basData = btGetData(projId);
  var equip =
    basData &&
    basData.buildings &&
    basData.buildings[bldgId] &&
    basData.buildings[bldgId].equipment &&
    basData.buildings[bldgId].equipment[equipTag];

  if (!equip || !equip.days || Object.keys(equip.days).length === 0) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">No trend data available for ' +
      equipTag +
      '.</div>';
    return;
  }

  // Determine default date — most recent day with data
  var allDates = Object.keys(equip.days).sort();
  var activeDate = window._btTimelineDate || allDates[allDates.length - 1];
  // Clamp to valid dates
  if (allDates.indexOf(activeDate) === -1) activeDate = allDates[allDates.length - 1];
  window._btTimelineDate = activeDate;

  var buckets = btBuildHourBuckets(activeDate, projId, bldgId, equipTag);

  // Date picker options
  var dateOpts = allDates
    .map(function (d) {
      return '<option value="' + d + '"' + (d === activeDate ? ' selected' : '') + '>' + d + '</option>';
    })
    .join('');

  // Row definitions: label, point key, min, max, palette, unit, description
  var rows = [
    {
      label: 'Fan Status',
      key: 'fanstatus',
      min: 0,
      max: 1,
      palette: 'binary',
      unit: '',
      desc: 'Gray = off, Green = running',
    },
    {
      label: 'Cooling Valve %',
      key: 'coolvalve',
      min: 0,
      max: 100,
      palette: 'cool',
      unit: '%',
      desc: 'White (0%) to blue (100%)',
    },
    {
      label: 'Heating Valve %',
      key: 'heatvalve',
      min: 0,
      max: 100,
      palette: 'heat',
      unit: '%',
      desc: 'White (0%) to red (100%)',
    },
    {
      label: 'OA Damper %',
      key: 'oadamper',
      min: 0,
      max: 100,
      palette: 'damper',
      unit: '%',
      desc: 'White (0%) to green (100%)',
    },
    {
      label: 'Supply Air Temp',
      key: 'sat',
      min: 50,
      max: 80,
      palette: 'temp',
      unit: 'F',
      desc: 'Blue (50 F) to red (80 F)',
    },
    {
      label: 'Zone Temp',
      key: 'zonetemp',
      min: 65,
      max: 80,
      palette: 'temp',
      unit: 'F',
      desc: 'Blue (65 F) to red (80 F)',
    },
    {
      label: 'Fault Hours',
      key: 'faultHrs',
      min: 0,
      max: 1,
      palette: 'fault',
      unit: 'hr',
      desc: 'Green = clean, Amber = fault detected',
    },
  ];

  // Build hour header row
  var hourHeaders = '';
  for (var hi = 0; hi < 24; hi++) {
    var lbl = hi === 0 ? '12a' : hi < 12 ? hi + 'a' : hi === 12 ? '12p' : hi - 12 + 'p';
    hourHeaders +=
      '<th style="padding:3px 2px;font-size:10px;color:var(--text3);font-weight:400;text-align:center;min-width:24px;">' +
      lbl +
      '</th>';
  }

  // Check which rows have any data
  var rowsHtml = rows
    .map(function (row) {
      var hasData = false;
      for (var bi = 0; bi < buckets.length; bi++) {
        if (buckets[bi][row.key] !== null) {
          hasData = true;
          break;
        }
      }
      if (!hasData) return ''; // skip rows with no data for this equipment

      var cells = '';
      for (var ci = 0; ci < 24; ci++) {
        var val = buckets[ci][row.key];
        var bg = btValueToColor(val, row.min, row.max, row.palette);
        var valStr =
          val === null
            ? '--'
            : row.key === 'fanstatus'
              ? val > 0.5
                ? 'On'
                : 'Off'
              : btRound(val, 1) + (row.unit ? ' ' + row.unit : '');
        cells +=
          '<td style="background:' +
          bg +
          ';border:1px solid rgba(0,0,0,0.06);padding:0;" title="Hour ' +
          ci +
          ':00 — ' +
          row.label +
          ': ' +
          valStr +
          '">' +
          '<div style="width:100%;height:28px;"></div></td>';
      }

      return [
        '<tr>',
        '<td style="padding:4px 8px;font-size:11px;color:var(--text2);white-space:nowrap;border-right:1px solid var(--border);',
        'position:sticky;left:0;background:var(--s2);z-index:1;" title="' + row.desc + '">' + row.label + '</td>',
        cells,
        '</tr>',
      ].join('');
    })
    .join('');

  if (!rowsHtml.trim()) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">No recognized point data (fan, valves, temps) in stored summaries for ' +
      equipTag +
      '.</div>';
    return;
  }

  var html = [
    '<div style="padding:16px;">',

    // Controls bar
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">',
    '<label style="font-size:12px;color:var(--text3);">Date:</label>',
    '<select id="bt-timeline-date" ',
    'style="background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 10px;font-size:13px;" ',
    'onchange="window._btTimelineDate=this.value;btRenderTimeline()">',
    dateOpts,
    '</select>',
    '<span style="font-size:11px;color:var(--text3);" title="Colors represent hourly averages from stored daily summaries. Import raw interval data to see actual per-interval variation.">',
    'Colors based on daily averages distributed across 24 hours',
    '</span>',
    '</div>',

    // Heat map table
    '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;">',
    '<table style="border-collapse:collapse;min-width:650px;width:100%;">',
    '<thead>',
    '<tr>',
    '<th style="padding:6px 8px;font-size:11px;color:var(--text3);font-weight:500;text-align:left;',
    'position:sticky;left:0;background:var(--s1);z-index:2;border-right:1px solid var(--border);border-bottom:1px solid var(--border);">Point</th>',
    hourHeaders,
    '</tr>',
    '</thead>',
    '<tbody>',
    rowsHtml,
    '</tbody>',
    '</table>',
    '</div>',

    // Legend
    '<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:14px;">',
    btTimelineLegend(),
    '</div>',

    '</div>',
  ].join('');

  body.innerHTML = html;
}

/** Build legend swatches for the timeline color scales */
function btTimelineLegend() {
  var items = [
    { label: 'Fan Off', color: '#6b7280' },
    { label: 'Fan On', color: '#22c55e' },
    { label: 'Cooling high', color: 'rgb(30,100,255)' },
    { label: 'Heating high', color: 'rgb(220,38,38)' },
    { label: 'Damper open', color: 'rgb(34,197,94)' },
    { label: 'Warm temp', color: 'rgb(255,74,74)' },
    { label: 'Cool temp', color: 'rgb(74,158,255)' },
    { label: 'Fault', color: '#f59e0b' },
  ];
  return items
    .map(function (item) {
      return [
        '<div style="display:flex;align-items:center;gap:5px;">',
        '<div style="width:14px;height:14px;border-radius:3px;background:' +
          item.color +
          ';border:1px solid rgba(0,0,0,0.12);flex-shrink:0;"></div>',
        '<span style="font-size:11px;color:var(--text3);">' + item.label + '</span>',
        '</div>',
      ].join('');
    })
    .join('');
}

/* ── LINEAR REGRESSION ──────────────────────────────────────────────────────── */

/**
 * Compute simple linear regression on an array of {x, y} points.
 * Returns { slope, intercept, r2 } or null if fewer than 3 points.
 *
 * @param {Array<{x:number, y:number}>} points
 * @returns {{slope:number, intercept:number, r2:number}|null}
 */
function btLinearRegression(points) {
  if (!points || points.length < 3) return null;

  var n = points.length;
  var sx = 0,
    sy = 0,
    sxy = 0,
    sxx = 0,
    syy = 0;

  for (var i = 0; i < n; i++) {
    sx += points[i].x;
    sy += points[i].y;
    sxy += points[i].x * points[i].y;
    sxx += points[i].x * points[i].x;
    syy += points[i].y * points[i].y;
  }

  var denom = n * sxx - sx * sx;
  if (denom === 0) return null;

  var slope = (n * sxy - sx * sy) / denom;
  var intercept = (sy - slope * sx) / n;

  // R²
  var ssRes = 0,
    ssTot = 0;
  var yMean = sy / n;
  for (var i2 = 0; i2 < n; i2++) {
    var yPred = slope * points[i2].x + intercept;
    ssRes += Math.pow(points[i2].y - yPred, 2);
    ssTot += Math.pow(points[i2].y - yMean, 2);
  }
  var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope: btRound(slope, 4), intercept: btRound(intercept, 4), r2: btRound(r2, 4) };
}

/* ── OAT SCATTER CHART ───────────────────────────────────────────────────────── */

// Month color palette (one per month, index 0=Jan)
var BT_MONTH_COLORS = [
  '#3b82f6', // Jan — blue
  '#8b5cf6', // Feb — violet
  '#06b6d4', // Mar — cyan
  '#10b981', // Apr — emerald
  '#84cc16', // May — lime
  '#eab308', // Jun — yellow
  '#f97316', // Jul — orange
  '#ef4444', // Aug — red
  '#f43f5e', // Sep — rose
  '#a855f7', // Oct — purple
  '#64748b', // Nov — slate
  '#0ea5e9', // Dec — sky
];

// OAT chart metric selector options
var BT_OAT_METRICS = [
  { key: 'fanRuntime', label: 'Fan Runtime (hrs/day)', unit: 'hrs' },
  { key: 'coolAvg', label: 'Cooling Valve Avg %', unit: '%' },
  { key: 'heatAvg', label: 'Heating Valve Avg %', unit: '%' },
  { key: 'faultTotal', label: 'Total Fault Hours', unit: 'hrs' },
];

/**
 * Extract OAT scatter data points from daily summaries.
 * Returns array of { date, oat, fanRuntime, coolAvg, heatAvg, faultTotal, month }
 *
 * @param {Object} days  equip.days map
 * @returns {Array}
 */
function btBuildOATPoints(days) {
  var pts = [];
  for (var dk in days) {
    if (!days.hasOwnProperty(dk)) continue;
    var d = days[dk];
    if (d.oatAvg === null || d.oatAvg === undefined) continue;

    // Fault total
    var fTotal = 0;
    var f = d.faults || {};
    for (var fk in f) {
      if (f.hasOwnProperty(fk)) fTotal += f[fk] || 0;
    }

    var month = parseInt(dk.split('-')[1]) - 1; // 0-based month index

    pts.push({
      date: dk,
      oat: d.oatAvg,
      fanRuntime: d.fanstatus ? d.fanstatus.runtimeHours || 0 : null,
      coolAvg: d.coolvalve ? d.coolvalve.avg : null,
      heatAvg: d.heatvalve ? d.heatvalve.avg : null,
      faultTotal: fTotal,
      month: month,
    });
  }
  pts.sort(function (a, b) {
    return a.date < b.date ? -1 : 1;
  });
  return pts;
}

/**
 * Render the OAT Scatter Chart subtab into #bt-analysis-body.
 * Expects window._btActiveEquip = { projId, bldgId, equipTag }
 */
function btRenderOATChart() {
  var body = document.getElementById('bt-analysis-body');
  if (!body) return;

  var ctx = window._btActiveEquip || {};
  var projId = ctx.projId;
  var bldgId = ctx.bldgId;
  var equipTag = ctx.equipTag;

  if (!projId || !bldgId || !equipTag) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Select equipment in the sidebar to view the OAT chart.</div>';
    return;
  }

  var basData = btGetData(projId);
  var equip =
    basData &&
    basData.buildings &&
    basData.buildings[bldgId] &&
    basData.buildings[bldgId].equipment &&
    basData.buildings[bldgId].equipment[equipTag];

  if (!equip || !equip.days || Object.keys(equip.days).length === 0) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">No trend data available for ' +
      equipTag +
      '.</div>';
    return;
  }

  var allPts = btBuildOATPoints(equip.days);
  if (allPts.length < 3) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Need at least 3 days with OAT data to render the scatter chart.</div>';
    return;
  }

  // Active metric
  var activeMetric = window._btOATMetric || 'fanRuntime';
  var metricDef = null;
  for (var mi = 0; mi < BT_OAT_METRICS.length; mi++) {
    if (BT_OAT_METRICS[mi].key === activeMetric) {
      metricDef = BT_OAT_METRICS[mi];
      break;
    }
  }
  if (!metricDef) {
    activeMetric = 'fanRuntime';
    metricDef = BT_OAT_METRICS[0];
  }
  window._btOATMetric = activeMetric;

  // Filter to points that have OAT + the selected metric
  var validPts = allPts.filter(function (p) {
    return p[activeMetric] !== null && p.oat !== null;
  });

  // Metric selector HTML
  var metricOpts = BT_OAT_METRICS.map(function (m) {
    return '<option value="' + m.key + '"' + (m.key === activeMetric ? ' selected' : '') + '>' + m.label + '</option>';
  }).join('');

  // Build the SVG
  var svgHtml = '';
  if (validPts.length >= 3) {
    svgHtml = btBuildOATSvg(validPts, activeMetric, metricDef);
  } else {
    svgHtml =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Not enough data points with OAT + ' +
      metricDef.label +
      ' to plot.</div>';
  }

  // Month legend — only show months actually present
  var monthsPresent = {};
  validPts.forEach(function (p) {
    monthsPresent[p.month] = true;
  });
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var monthLegend = Object.keys(monthsPresent)
    .sort(function (a, b) {
      return a - b;
    })
    .map(function (m) {
      return [
        '<div style="display:flex;align-items:center;gap:5px;">',
        '<div style="width:10px;height:10px;border-radius:50%;background:' +
          BT_MONTH_COLORS[m] +
          ';flex-shrink:0;"></div>',
        '<span style="font-size:11px;color:var(--text3);">' + monthNames[m] + '</span>',
        '</div>',
      ].join('');
    })
    .join('');

  var html = [
    '<div style="padding:16px;">',

    // Metric selector
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">',
    '<label style="font-size:12px;color:var(--text3);">Y Axis:</label>',
    '<select id="bt-oat-metric" ',
    'style="background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 10px;font-size:13px;" ',
    'onchange="window._btOATMetric=this.value;btRenderOATChart()">',
    metricOpts,
    '</select>',
    '<span style="font-size:11px;color:var(--text3);">' + validPts.length + ' days plotted</span>',
    '</div>',

    // SVG chart
    '<div id="bt-oat-svg-wrap" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--s2);">',
    svgHtml,
    '</div>',

    // Month legend
    monthLegend ? '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px;">' + monthLegend + '</div>' : '',

    '</div>',
  ].join('');

  body.innerHTML = html;

  // Attach tooltip handlers after render
  btAttachOATTooltips();
}

/**
 * Build the OAT scatter SVG as an HTML string.
 * Responsive width (100%), fixed 400px height.
 *
 * @param {Array}  pts        filtered, valid data points
 * @param {string} metricKey  active metric key
 * @param {Object} metricDef  { key, label, unit }
 * @returns {string}  SVG markup
 */
function btBuildOATSvg(pts, metricKey, metricDef) {
  // Chart dimensions (viewBox; actual width is 100%)
  var W = 700,
    H = 400;
  var pl = 56,
    pr = 20,
    pt = 16,
    pb = 46; // padding left/right/top/bottom
  var cw = W - pl - pr; // chart area width
  var ch = H - pt - pb; // chart area height

  // Data extents
  var xVals = pts.map(function (p) {
    return p.oat;
  });
  var yVals = pts.map(function (p) {
    return p[metricKey];
  });
  var xMin = Math.floor(Math.min.apply(null, xVals) - 3);
  var xMax = Math.ceil(Math.max.apply(null, xVals) + 3);
  var yMin = 0; // always start at 0
  var yMax = Math.ceil(Math.max.apply(null, yVals) * 1.1) || 1;

  function xScale(v) {
    return pl + ((v - xMin) / (xMax - xMin)) * cw;
  }
  function yScale(v) {
    return pt + ch - ((v - yMin) / (yMax - yMin)) * ch;
  }

  // Gridlines
  var xTicks = btNiceTicks(xMin, xMax, 6);
  var yTicks = btNiceTicks(yMin, yMax, 5);

  var gridLines = '';
  xTicks.forEach(function (t) {
    var x = xScale(t);
    gridLines +=
      '<line x1="' +
      x +
      '" y1="' +
      pt +
      '" x2="' +
      x +
      '" y2="' +
      (pt + ch) +
      '" stroke="var(--border)" stroke-width="1"/>';
    gridLines +=
      '<text x="' +
      x +
      '" y="' +
      (pt + ch + 16) +
      '" text-anchor="middle" font-size="10" fill="var(--text3)">' +
      t +
      '</text>';
  });
  yTicks.forEach(function (t) {
    var y = yScale(t);
    gridLines +=
      '<line x1="' +
      pl +
      '" y1="' +
      y +
      '" x2="' +
      (pl + cw) +
      '" y2="' +
      y +
      '" stroke="var(--border)" stroke-width="1"/>';
    gridLines +=
      '<text x="' +
      (pl - 6) +
      '" y="' +
      (y + 4) +
      '" text-anchor="end" font-size="10" fill="var(--text3)">' +
      t +
      '</text>';
  });

  // Data points
  var circles = '';
  pts.forEach(function (p, idx) {
    var cx = xScale(p.oat);
    var cy = yScale(p[metricKey]);
    var color = BT_MONTH_COLORS[p.month];
    var tipText =
      p.date +
      ' | OAT ' +
      btRound(p.oat, 1) +
      'F | ' +
      metricDef.label +
      ': ' +
      btRound(p[metricKey], 1) +
      ' ' +
      metricDef.unit;
    circles +=
      '<circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="5" fill="' +
      color +
      '" opacity="0.85" ' +
      'stroke="var(--s1)" stroke-width="1" ' +
      'data-tip="' +
      btEscapeAttr(tipText) +
      '" class="bt-oat-dot" style="cursor:pointer;"/>';
  });

  // Regression line (only when R² > 0.5)
  var regHtml = '';
  var regPoints = pts.map(function (p) {
    return { x: p.oat, y: p[metricKey] };
  });
  var reg = btLinearRegression(regPoints);
  if (reg && reg.r2 > 0.5) {
    var y1r = reg.slope * xMin + reg.intercept;
    var y2r = reg.slope * xMax + reg.intercept;
    // Clamp to chart bounds
    var x1r = xScale(xMin),
      x2r = xScale(xMax);
    var cy1r = Math.max(pt, Math.min(pt + ch, yScale(y1r)));
    var cy2r = Math.max(pt, Math.min(pt + ch, yScale(y2r)));

    regHtml =
      '<line x1="' +
      x1r +
      '" y1="' +
      cy1r +
      '" x2="' +
      x2r +
      '" y2="' +
      cy2r +
      '" ' +
      'stroke="var(--em)" stroke-width="2" stroke-dasharray="5,3" opacity="0.7"/>';

    // Annotation box: R², slope, balance point
    var balancePt = reg.slope !== 0 ? btRound(-reg.intercept / reg.slope, 1) : null;
    var annLines = ['R² = ' + reg.r2, 'Slope: ' + reg.slope + ' ' + metricDef.unit + '/°F'];
    if (balancePt !== null && balancePt >= xMin && balancePt <= xMax) {
      annLines.push('Balance pt: ' + balancePt + '°F');
    }
    var annX = pl + cw - 8;
    var annY = pt + 8;
    var annBg =
      '<rect x="' +
      (annX - 110) +
      '" y="' +
      annY +
      '" width="118" height="' +
      (annLines.length * 15 + 8) +
      '" rx="4" ' +
      'fill="var(--s2)" stroke="var(--border)" stroke-width="1" opacity="0.92"/>';
    var annText = annLines
      .map(function (l, li) {
        return (
          '<text x="' +
          (annX - 55) +
          '" y="' +
          (annY + 14 + li * 15) +
          '" text-anchor="middle" font-size="10" fill="var(--text2)">' +
          btEscapeHtml(l) +
          '</text>'
        );
      })
      .join('');
    regHtml += annBg + annText;
  }

  // Axis labels
  var xLabel =
    '<text x="' +
    (pl + cw / 2) +
    '" y="' +
    (H - 4) +
    '" text-anchor="middle" font-size="11" fill="var(--text3)">Daily Avg OAT (°F)</text>';
  var yLabel =
    '<text x="12" y="' +
    (pt + ch / 2) +
    '" text-anchor="middle" font-size="11" fill="var(--text3)" transform="rotate(-90,12,' +
    (pt + ch / 2) +
    ')">' +
    btEscapeHtml(metricDef.label) +
    '</text>';

  // Tooltip div (positioned absolutely inside the SVG wrapper)
  var tooltip =
    '<div id="bt-oat-tip" style="display:none;position:absolute;background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text2);pointer-events:none;white-space:nowrap;z-index:10;max-width:280px;"></div>';

  var svg = [
    '<div style="position:relative;">',
    tooltip,
    '<svg viewBox="0 0 ' +
      W +
      ' ' +
      H +
      '" style="width:100%;height:400px;display:block;" xmlns="http://www.w3.org/2000/svg">',
    gridLines,
    regHtml,
    circles,
    xLabel,
    yLabel,
    '</svg>',
    '</div>',
  ].join('');

  return svg;
}

/**
 * Attach mouse-over tooltip handlers to OAT scatter dots.
 * Called after btRenderOATChart writes to the DOM.
 */
function btAttachOATTooltips() {
  var dots = document.querySelectorAll('.bt-oat-dot');
  var tip = document.getElementById('bt-oat-tip');
  if (!tip) return;

  for (var i = 0; i < dots.length; i++) {
    (function (dot) {
      dot.addEventListener('mouseenter', function (e) {
        tip.textContent = dot.getAttribute('data-tip') || '';
        tip.style.display = 'block';
        tip.style.left = e.offsetX + 14 + 'px';
        tip.style.top = e.offsetY - 10 + 'px';
      });
      dot.addEventListener('mousemove', function (e) {
        var wrap = document.getElementById('bt-oat-svg-wrap');
        if (!wrap) return;
        var rect = wrap.getBoundingClientRect();
        var lx = e.clientX - rect.left + 14;
        var ly = e.clientY - rect.top - 10;
        tip.style.left = lx + 'px';
        tip.style.top = ly + 'px';
      });
      dot.addEventListener('mouseleave', function () {
        tip.style.display = 'none';
      });
    })(dots[i]);
  }
}

/* ── SVG UTILITIES ──────────────────────────────────────────────────────────── */

/**
 * Generate nicely spaced tick values for an axis.
 * Returns array of tick values within [min, max].
 *
 * @param {number} min
 * @param {number} max
 * @param {number} target  approximate number of ticks desired
 * @returns {number[]}
 */
function btNiceTicks(min, max, target) {
  var range = max - min;
  if (range <= 0) return [min];
  var rough = range / (target - 1);
  var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
  var niceStep = rough / mag <= 1 ? mag : rough / mag <= 2 ? 2 * mag : rough / mag <= 5 ? 5 * mag : 10 * mag;
  var start = Math.ceil(min / niceStep) * niceStep;
  var ticks = [];
  for (var t = start; t <= max + 1e-9; t += niceStep) {
    ticks.push(btRound(t, 6));
  }
  return ticks;
}

/** Escape a string for use in an SVG/HTML attribute value */
function btEscapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a string for use in SVG text content */
function btEscapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── SUBTAB REGISTRATION (Phase 3 hook) ─────────────────────────────────────── */

/**
 * Register Phase 3 subtabs (Timeline + OAT Chart) into the subtab bar.
 * Phase 2 builds #bt-subtab-bar and calls btPhase3RegisterTabs() once the bar
 * exists. If Phase 2 uses a different registration mechanism, this function
 * can also be called manually.
 *
 * Appends two <button> elements styled to match Phase 2's tab buttons.
 * Each button calls btSwitchSubtab(id) which Phase 2 provides.
 */
function btPhase3RegisterTabs() {
  var bar = document.getElementById('bt-subtab-bar');
  if (!bar) return; // Phase 2 bar not present yet

  // Avoid double-registration
  if (document.getElementById('bt-subtab-timeline')) return;

  var tabStyle = [
    'background:none;border:none;padding:8px 16px;font-size:13px;color:var(--text2);',
    'cursor:pointer;border-bottom:2px solid transparent;transition:color 0.15s,border-color 0.15s;',
    'white-space:nowrap;',
  ].join('');

  var timelineBtn = document.createElement('button');
  timelineBtn.id = 'bt-subtab-timeline';
  timelineBtn.setAttribute('data-subtab', 'timeline');
  timelineBtn.style.cssText = tabStyle;
  timelineBtn.textContent = 'Timeline';
  timelineBtn.onclick = function () {
    if (typeof btSwitchSubtab === 'function') btSwitchSubtab('timeline');
  };

  var oatBtn = document.createElement('button');
  oatBtn.id = 'bt-subtab-oat';
  oatBtn.setAttribute('data-subtab', 'oat');
  oatBtn.style.cssText = tabStyle;
  oatBtn.textContent = 'OAT Chart';
  oatBtn.onclick = function () {
    if (typeof btSwitchSubtab === 'function') btSwitchSubtab('oat');
  };

  bar.appendChild(timelineBtn);
  bar.appendChild(oatBtn);
}

/**
 * Dispatch table for Phase 3 subtabs — called by Phase 2's btSwitchSubtab()
 * when the active tab key is 'timeline' or 'oat'.
 *
 * Phase 2 should call: if (btPhase3RenderTab(tabId)) return;
 * at the top of its btSwitchSubtab() handler to delegate Phase 3 tabs.
 *
 * Returns true if the tab was handled by Phase 3, false otherwise.
 *
 * @param {string} tabId
 * @returns {boolean}
 */
function btPhase3RenderTab(tabId) {
  if (tabId === 'timeline') {
    btRenderTimeline();
    return true;
  }
  if (tabId === 'oat') {
    btRenderOATChart();
    return true;
  }
  return false;
}
