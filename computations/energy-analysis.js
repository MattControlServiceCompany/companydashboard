// computations/energy-analysis.js - kWh vs kW analysis for one building (Energy Graphics tab).
// Canonical source for: load factor, equivalent full-load hours, baseload per day, use per degree day,
// and the one-line reading. Plain math functions have no DOM or app dependency (test-energy-analysis.js).
// getEnergyAnalysis() reads the building's bills through the shared rules already used by the page:
// billMonth() puts a whole bill in ONE month, calcDays() counts the days of a bill,
// resolveGasUsageTherms() reads gas therms, getWeatherForBuilding() gives the degree days.
// No other function in the app may compute load factor or full-load hours (single source of truth).

var EA_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _eaNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// Load factor = kWh / (peak kW x hours in the bill period). null when a part is missing or zero.
function eaLoadFactor(kwh, kw, hours) {
  if (!(_eaNum(kwh) && _eaNum(kw) && _eaNum(hours))) return null;
  if (!(kwh > 0 && kw > 0 && hours > 0)) return null;
  return kwh / (kw * hours);
}

// Equivalent full-load hours = kWh / peak kW (the hours the building would run at its peak to use that kWh).
function eaFullLoadHours(kwh, kw) {
  if (!(_eaNum(kwh) && _eaNum(kw))) return null;
  if (!(kwh > 0 && kw > 0)) return null;
  return kwh / kw;
}

// Fewer degree days than this in a month: the ratio is not meaningful (a tiny divisor gives a huge number).
// Same value for heating and cooling. Used ONLY by eaPerDegreeDay; the monthly cells, the same-months
// comparison and the reading line all go through that function.
var EA_MIN_DEGREE_DAYS = 50;

// Use per degree day = use / degree days. null when the month has fewer than EA_MIN_DEGREE_DAYS degree days.
function eaPerDegreeDay(use, dd) {
  if (!(_eaNum(use) && _eaNum(dd))) return null;
  if (!(use > 0 && dd >= EA_MIN_DEGREE_DAYS)) return null;
  return use / dd;
}

// Percent change of now against before, as a fraction (0.18 = +18%). null when before is not above 0.
function eaPctChange(now, before) {
  if (!(_eaNum(now) && _eaNum(before)) || !(before > 0)) return null;
  return (now - before) / before;
}

// Baseload = the lowest monthly kWh per day. rows: [{mo, kwh, days}], days = hours / 24.
// The lowest value is picked by _hvacLowestNAvg (computations/hvac-enduse.js) with n = 1, the same
// "lowest months" rule the HVAC End-Use Estimate uses (that one averages the 3 lowest months in kWh per month;
// this one is the single lowest month in kWh per day, so months of different length compare fairly).
// Returns { perDay, mo, kwh, days } or null.
function eaBaseloadPerDay(rows) {
  var ok = (rows || []).filter(function (r) {
    return r && r.kwh > 0 && r.days > 0;
  });
  if (!ok.length) return null;
  var perDay = _hvacLowestNAvg(
    ok.map(function (r) {
      return r.kwh / r.days;
    }),
    1,
  );
  var hit = ok.filter(function (r) {
    return r.kwh / r.days === perDay;
  })[0];
  return { perDay: perDay, mo: hit.mo, kwh: hit.kwh, days: hit.days };
}

// One month row from the meters' monthly parts. meterParts: [{kwh, kw, hours}] one per electric meter that has a
// bill in the month (kw = highest demand of that meter in the month, hours = bill-period hours of that meter).
// Building kWh = sum, building kW = sum of the meter kW, kWhours = sum of (meter kW x meter hours), the
// denominator of the load factor. hours = kWhours / kW (the same as the meter hours when there is one meter).
function eaMonthFromMeterParts(meterParts) {
  var out = { kwh: 0, kw: 0, kwHours: 0, hours: 0, hasElec: false };
  (meterParts || []).forEach(function (p) {
    if (!p) return;
    if (p.kwh > 0) out.hasElec = true;
    out.kwh += p.kwh || 0;
    out.kw += p.kw || 0;
    out.kwHours += (p.kw || 0) * (p.hours || 0);
  });
  out.hours = out.kw > 0 ? out.kwHours / out.kw : 0;
  return out;
}

// Months shared by two years: index list where both years have kWh. a, b: arrays of 12 month rows (or null).
function eaCommonMonths(a, b, test) {
  var t =
    test ||
    function (r) {
      return r && r.kwh > 0;
    };
  var out = [];
  for (var i = 0; i < 12; i++) if (a && b && t(a[i]) && t(b[i])) out.push(i);
  return out;
}

// "Jan to Sep" for a run of months, "Jan, Mar, Apr" otherwise.
function eaMonthsLabel(list) {
  if (!list || !list.length) return '';
  if (list.length === 1) return EA_MONTHS[list[0]];
  var run = true;
  for (var i = 1; i < list.length; i++) if (list[i] !== list[i - 1] + 1) run = false;
  if (run) return EA_MONTHS[list[0]] + ' to ' + EA_MONTHS[list[list.length - 1]];
  return list
    .map(function (m) {
      return EA_MONTHS[m];
    })
    .join(', ');
}

// Totals of one year over a list of month indexes. months: array of 12 month rows
// {kwh, kw, hours, cdd, hdd, therms}. Every figure carries the numbers it came from (for the hover text).
function eaYearSummary(months, idx, gasIdx) {
  var s = {
    kwh: 0,
    peakKw: null,
    peakMo: null,
    hours: 0,
    lfKwh: 0,
    loadFactor: null,
    fullLoadHours: null,
    baseload: null,
    cddKwh: 0,
    cddSum: 0,
    kwhPerCdd: null,
    therms: 0,
    hddSum: 0,
    thermsPerHdd: null,
  };
  idx.forEach(function (i) {
    var m = months[i];
    if (!m) return;
    s.kwh += m.kwh || 0;
    if (m.kw > 0 && (s.peakKw === null || m.kw > s.peakKw)) {
      s.peakKw = m.kw;
      s.peakMo = i;
    }
    if (m.kw > 0 && m.hours > 0) {
      s.lfKwh += m.kwh || 0;
      s.hours += m.hours;
    }
    if (eaPerDegreeDay(m.kwh, m.cdd) !== null) {
      s.cddKwh += m.kwh;
      s.cddSum += m.cdd;
    }
  });
  (gasIdx || idx).forEach(function (i) {
    var m = months[i];
    if (m && eaPerDegreeDay(m.therms, m.hdd) !== null) {
      s.therms += m.therms;
      s.hddSum += m.hdd;
    }
  });
  s.loadFactor = eaLoadFactor(s.lfKwh, s.peakKw, s.hours);
  s.fullLoadHours = eaFullLoadHours(s.kwh, s.peakKw);
  s.baseload = eaBaseloadPerDay(
    idx.map(function (i) {
      var m = months[i] || {};
      return { mo: i, kwh: m.kwh, days: m.hours / 24 };
    }),
  );
  s.kwhPerCdd = eaPerDegreeDay(s.cddKwh, s.cddSum);
  s.thermsPerHdd = eaPerDegreeDay(s.therms, s.hddSum);
  return s;
}

// Reading text: plain facts only. cur and prev are eaYearSummary results over the SAME months.
// "Same" when the change is under 2 percent (whole-number rounding would show +1% or -1%).
function eaReadingText(curYear, prevYear, cur, prev, monthsLabel) {
  if (!cur || !prev || !monthsLabel) return 'Not enough months in both years to compare.';
  var part = function (label, now, before, sameWord) {
    var c = eaPctChange(now, before);
    if (c === null) return null;
    if (Math.abs(c) < 0.02) return sameWord;
    return (c > 0 ? '+' : '-') + Math.round(Math.abs(c) * 100) + '% ' + label;
  };
  var bits = [
    part('peak kW', cur.peakKw, prev.peakKw, 'Same peak kW'),
    part('full-load hours', cur.fullLoadHours, prev.fullLoadHours, 'same full-load hours'),
    part('kWh', cur.kwh, prev.kwh, 'same kWh'),
  ].filter(Boolean);
  if (!bits.length) return 'Not enough months in both years to compare.';
  var t = bits.join(', ');
  // a sentence starts with a capital letter
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t + ' in ' + curYear + ' vs ' + prevYear + ' (' + monthsLabel + ').';
}

// Gather one building's electric and gas months by year.
// Returns { years: [y,...] ascending, byYear: {y: {months:[12 rows]}}, hasGas }.
// Month row: { kwh, kw, hours, kwHours, hasElec, therms, hasGas, cdd, hdd }.
// Meter filter is the one the charts above use: skip baseline-excluded meters and commodities the project does not calculate.
function getEnergyAnalysis(projId, b) {
  var out = { years: [], byYear: {}, hasGas: false };
  if (!b) return out;
  var wx = getWeatherForBuilding(projId, b.id);
  var byYm = wx && wx.byYm ? wx.byYm : null;
  var elecParts = {}; // 'YYYY-MM' -> [{kwh, kw, hours}] one per meter
  var gasTherms = {}; // 'YYYY-MM' -> therms
  (b.meters || []).forEach(function (m) {
    if (isBaselineExcluded(projId, m.id)) return;
    if (!isCalcCommodity(projId, m.commodity)) return;
    var isElec = m.commodity === 'Electric';
    var isGas = m.commodity === 'Gas';
    if (!isElec && !isGas) return;
    var bills = m.bills || [];
    var inclusive = m.inclusive !== false;
    var perMeter = {};
    bills.forEach(function (bill) {
      var ym = billMonth(bill, bills);
      if (!/^\d{4}-\d{2}/.test(ym)) return;
      if (isGas) {
        gasTherms[ym] = (gasTherms[ym] || 0) + resolveGasUsageTherms(bill);
        return;
      }
      var pm = perMeter[ym] || (perMeter[ym] = { kwh: 0, kw: 0, hours: 0 });
      pm.kwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
      pm.kw = Math.max(pm.kw, parseFloat(bill.demandKW) || 0);
      var days = parseFloat(calcDays(bill.start, bill.end, inclusive));
      if (days > 0) pm.hours += days * 24;
    });
    Object.keys(perMeter).forEach(function (ym) {
      (elecParts[ym] = elecParts[ym] || []).push(perMeter[ym]);
    });
  });
  var yms = Object.keys(elecParts).concat(Object.keys(gasTherms));
  yms.forEach(function (ym) {
    var y = parseInt(ym.slice(0, 4), 10);
    var mo = parseInt(ym.slice(5, 7), 10) - 1;
    if (!out.byYear[y]) {
      out.byYear[y] = { months: [] };
      for (var i = 0; i < 12; i++) {
        out.byYear[y].months.push({
          kwh: 0,
          kw: 0,
          hours: 0,
          kwHours: 0,
          hasElec: false,
          therms: 0,
          hasGas: false,
          cdd: null,
          hdd: null,
        });
      }
    }
    var row = out.byYear[y].months[mo];
    if (elecParts[ym] && !row.hasElec) {
      var e = eaMonthFromMeterParts(elecParts[ym]);
      row.kwh = e.kwh;
      row.kw = e.kw;
      row.hours = e.hours;
      row.kwHours = e.kwHours;
      row.hasElec = e.hasElec;
    }
    if (gasTherms[ym] > 0) {
      row.therms = gasTherms[ym];
      row.hasGas = true;
      out.hasGas = true;
    }
    var w = byYm && byYm[ym];
    if (w) {
      row.cdd = w.cdd != null ? w.cdd : null;
      row.hdd = w.hdd != null ? w.hdd : null;
    }
  });
  out.years = Object.keys(out.byYear)
    .map(Number)
    .filter(function (y) {
      return out.byYear[y].months.some(function (m) {
        return m.hasElec;
      });
    })
    .sort(function (a, c) {
      return a - c;
    });
  return out;
}
