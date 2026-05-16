// computations/normalization.js — Normalization functions (canonical source)
// Dependencies (loaded before this file):
//   - _parseISO, calcDays (energy-department.html globals)
//   - calDaysInMonth (lib/date-helpers.js)
//   - computeMeterRegression, regressionBaseline (computations/regression.js)
//   - getUDProj, getUDBldg, udSelProjId (energy-department.html globals)

// Determine which calendar month a billing period "belongs to" for normalization.
// Assign each bill to a calendar month.
// For continuous billing cycles (gap ≤ 3 days between bills), months are assigned
// sequentially — each bill gets the next month after the previous one.
// The sequence is anchored by the first bill's majority-days month.
// For non-continuous gaps, the next bill restarts from its own majority-days month.
// allBills: full sorted bill array. If omitted, falls back to majority-only.
function normMonth(startStr, endStr, incl, allBills) {
  if (!startStr || !endStr) return startStr || '';

  // Helper: month with most days in a date range.
  // Tie-break (Update 83): when two months have the same day count, the
  // month with the higher ratio-of-days-in-that-month wins (e.g. 18/28
  // Feb beats 18/31 Jan). Prevents end-date-dependent misclassification
  // on bills like 1/14→2/18 being labeled Jan while sibling 1/14→2/20
  // bills are labeled Feb.
  function majorityMonth(s, e) {
    if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) {
      return s && !isNaN(s.getTime()) ? s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') : null;
    }
    const counts = {};
    let cur = new Date(s);
    const limit = 120;
    let iter = 0;
    while (cur <= e && iter++ < limit) {
      const key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      counts[key] = (counts[key] || 0) + 1;
      cur.setDate(cur.getDate() + 1);
    }
    const entries = Object.entries(counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const [yA, mA] = a[0].split('-').map(Number);
      const [yB, mB] = b[0].split('-').map(Number);
      const dimA = new Date(yA, mA, 0).getDate();
      const dimB = new Date(yB, mB, 0).getDate();
      return b[1] / dimB - a[1] / dimA;
    });
    return entries.length ? entries[0][0] : null;
  }

  // Helper: advance a YYYY-MM string by 1 month
  function nextMonth(ym) {
    let [y, mo] = ym.split('-').map(Number);
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
    return y + '-' + String(mo).padStart(2, '0');
  }

  if (!allBills || allBills.length === 0) {
    const s = _parseISO(startStr),
      e = _parseISO(endStr);
    return majorityMonth(s, e);
  }

  const sorted = allBills
    .filter((b) => b.start && b.end)
    .slice()
    .sort((a, b) => _parseISO(a.start) - _parseISO(b.start));

  const assignments = [];
  for (let i = 0; i < sorted.length; i++) {
    const bill = sorted[i];
    const s = _parseISO(bill.start),
      e = _parseISO(bill.end);
    let ym;
    if (i === 0) {
      // First bill: anchor on majority-days month
      ym = majorityMonth(s, e);
    } else {
      const prev = assignments[i - 1];
      const gapDays = (s - _parseISO(prev.end)) / (1000 * 60 * 60 * 24);
      if (gapDays <= 3) {
        // Continuous: always just increment from previous month
        ym = nextMonth(prev.ym);
      } else {
        // Gap in data: restart from majority-days
        ym = majorityMonth(s, e);
      }
    }
    assignments.push({ start: bill.start, end: bill.end, ym });
  }

  const match = assignments.find((a) => a.start === startStr && a.end === endStr);
  if (match) return match.ym;

  // Fallback
  const s = _parseISO(startStr),
    e = _parseISO(endStr);
  return majorityMonth(s, e);
}

// Detect gap between two consecutive bills (>3 day gap between end of prev and start of next)
function detectGap(prevEnd, nextStart) {
  if (!prevEnd || !nextStart) return false;
  const e = _parseISO(prevEnd),
    s = _parseISO(nextStart);
  return (s - e) / (1000 * 60 * 60 * 24) > 3;
}

/* ─────────────────────────────────────────────────────────────
         buildMoMap — single authoritative source for per-calendar-month
         baseline data. Used by Meter Data, Performance, Building Stats,
         and Building Performance tabs. Always call this instead of
         recomputing from raw bills independently.

         Returns { elecByMo, gasByMo, waterByMo } where keys are 0–11.
         elecByMo[mo]: { kwh, demandKW, billedKW, facKW, kwCost,
                         facKWCost, energyCost, totalCost, normDays }
         gasByMo[mo]:  { therms, cost }
         waterByMo[mo]:{ kgal,   cost }
      ───────────────────────────────────────────────────────────── */
function buildMoMap(m, blRows, bills, incl) {
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';
  const isPropane = m.commodity === 'Propane';
  const elecByMo = {},
    gasByMo = {},
    waterByMo = {},
    propaneByMo = {};
  // Two-pass accumulate-then-average for multi-year baselines.
  // Pass 1: group all blRows by calendar month (mo = 0-11).
  //   Each mo may have entries from multiple years (e.g. 2024-01 and 2025-01 both → mo=0).
  // Pass 2: average all values across years for each mo.
  // For kW: use average across years (per Manager decision — matches kWh behavior).
  const _moAccum = {}; // { mo: [rowEntry, ...] }
  blRows.forEach((r) => {
    const mo = parseInt(r.ym.split('-')[1]) - 1;
    if (!_moAccum[mo]) _moAccum[mo] = [];
    const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
    const normUsage = r.regrBaseline != null ? r.regrBaseline : r.usage;
    _moAccum[mo].push({ r, bfr, normUsage });
  });
  Object.entries(_moAccum).forEach(([mo, entries]) => {
    const cnt = entries.length; // number of years contributing to this calendar month
    if (isElec) {
      const kwh = entries.reduce((s, e) => s + e.normUsage, 0) / cnt;
      const demandKW =
        entries.reduce(
          (s, e) => s + (e.bfr.length ? Math.max(...e.bfr.map((b) => parseFloat(b.demandKW || 0))) : 0),
          0,
        ) / cnt;
      const billedKW =
        entries.reduce(
          (s, e) => s + (e.bfr.length ? Math.max(...e.bfr.map((b) => parseFloat(b.billedKW || b.demandKW || 0))) : 0),
          0,
        ) / cnt;
      const facKW =
        entries.reduce((s, e) => s + (e.bfr.length ? Math.max(...e.bfr.map((b) => parseFloat(b.facKW || 0))) : 0), 0) /
        cnt;
      const kwCost = entries.reduce((s, e) => s + e.bfr.reduce((ss, b) => ss + parseFloat(b.kwCost || 0), 0), 0) / cnt;
      const facKWCost =
        entries.reduce((s, e) => s + e.bfr.reduce((ss, b) => ss + parseFloat(b.facKWCost || 0), 0), 0) / cnt;
      const kwhCostSum =
        entries.reduce((s, e) => s + e.bfr.reduce((ss, b) => ss + (parseFloat(b.kwhCost) || 0), 0), 0) / cnt;
      const kwCostSum =
        entries.reduce((s, e) => s + e.bfr.reduce((ss, b) => ss + parseFloat(b.kwCost || 0), 0), 0) / cnt;
      const facKWCostSum =
        entries.reduce((s, e) => s + e.bfr.reduce((ss, b) => ss + (parseFloat(b.facKWCost) || 0), 0), 0) / cnt;
      const totalCost = entries.reduce((s, e) => s + e.r.cost, 0) / cnt;
      const normDays = entries.reduce((s, e) => s + e.r.normDays, 0) / cnt;
      elecByMo[mo] = {
        kwh,
        demandKW,
        billedKW,
        facKW,
        kwCost,
        facKWCost,
        energyCost: kwhCostSum,
        totalCost,
        commodityCost: kwhCostSum + kwCostSum + facKWCostSum,
        normDays,
      };
    } else if (isGas) {
      const therms = entries.reduce((s, e) => s + e.normUsage, 0) / cnt;
      const cost = entries.reduce((s, e) => s + (e.normUsage > 0 ? e.r.cost : 0), 0) / cnt;
      const rate =
        entries.reduce(
          (s, e) =>
            s + (e.bfr.length > 0 ? e.bfr.reduce((ss, b) => ss + getStoredRate(b, 'gas'), 0) / e.bfr.length : 0),
          0,
        ) / cnt;
      gasByMo[mo] = { therms, cost, rate };
    } else if (isPropane) {
      const gallons = entries.reduce((s, e) => s + e.normUsage, 0) / cnt;
      const cost = entries.reduce((s, e) => s + e.r.cost, 0) / cnt;
      const rate =
        entries.reduce(
          (s, e) =>
            s + (e.bfr.length > 0 ? e.bfr.reduce((ss, b) => ss + getStoredRate(b, 'propane'), 0) / e.bfr.length : 0),
          0,
        ) / cnt;
      propaneByMo[mo] = { gallons, cost, rate };
    } else {
      const kgal = entries.reduce((s, e) => s + e.normUsage, 0) / cnt;
      const cost = entries.reduce((s, e) => s + e.r.cost, 0) / cnt;
      waterByMo[mo] = { kgal, cost };
    }
  });
  return { elecByMo, gasByMo, waterByMo, propaneByMo };
}

// ── Propane Normalization ──────────────────────────────────────────────
// Propane is delivered in bulk (e.g. 500 gal on Jan 16, 800 gal on Apr 29).
// These deliveries don't match monthly billing periods. To get monthly usage,
// we spread each delivery's gallons across the months between the previous
// delivery and this one, weighted by Heating Degree Days (HDD).
//
// hddByMonth: {YYYY-MM: {hdd}} from ZIP weather cache (same as weatherByYm).
// Returns [{month: 'YYYY-MM', gallons: N, cost: N}, ...] sorted by month.
function normalizePropaneDeliveries(bills, hddByMonth) {
  if (!bills || bills.length === 0) return [];
  // Sort deliveries by date (start === end === DeliveryDate for propane)
  const sorted = bills
    .filter((b) => b.start)
    .slice()
    .sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  if (sorted.length === 0) return [];

  const result = {}; // {YYYY-MM: {gallons, cost}}

  // Helper: enumerate months between two dates (inclusive of partial months)
  // Returns [{ym, days}] — each entry is a calendar month with the number of
  // days that fall within [startDate, endDate).
  function monthSpans(startDate, endDate) {
    const spans = [];
    if (startDate >= endDate) return spans;
    let cur = new Date(startDate);
    while (cur < endDate) {
      const ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      // Count days in this month that fall within [startDate, endDate)
      const moEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); // 1st of next month
      const spanEnd = endDate < moEnd ? endDate : moEnd;
      const days = Math.round((spanEnd - cur) / (1000 * 60 * 60 * 24));
      if (days > 0) spans.push({ ym, days });
      cur = moEnd;
    }
    return spans;
  }

  for (let i = 1; i < sorted.length; i++) {
    const prevDelivery = sorted[i - 1];
    const thisDelivery = sorted[i];
    // The gallons from thisDelivery were consumed between prevDelivery date and thisDelivery date
    const gallons = parseFloat(thisDelivery.gallonsDelivered || thisDelivery.kwh) || 0;
    const cost = parseFloat(thisDelivery.totalCost) || 0;
    if (gallons <= 0) continue;

    const spanStart = _parseISO(prevDelivery.start);
    const spanEnd = _parseISO(thisDelivery.start);
    const spans = monthSpans(spanStart, spanEnd);
    if (spans.length === 0) continue;

    // Get HDD for each spanned month
    let totalHDD = 0;
    let totalDays = 0;
    const spanHDD = spans.map((s) => {
      const w = hddByMonth && hddByMonth[s.ym];
      // Scale monthly HDD by fraction of month covered
      const calDays = calDaysInMonth(s.ym);
      const frac = calDays > 0 ? s.days / calDays : 0;
      const hdd = w && w.hdd != null ? w.hdd * frac : 0;
      totalHDD += hdd;
      totalDays += s.days;
      return { ym: s.ym, days: s.days, hdd };
    });

    // Allocate gallons and cost proportionally
    spanHDD.forEach((s) => {
      let share;
      if (totalHDD > 0) {
        // Weight by HDD
        share = s.hdd / totalHDD;
      } else {
        // Summer / no HDD data: weight by days
        share = totalDays > 0 ? s.days / totalDays : 0;
      }
      const mGal = gallons * share;
      const mCost = cost * share;
      if (!result[s.ym]) {
        result[s.ym] = { gallons: 0, cost: 0 };
      }
      result[s.ym].gallons += mGal;
      result[s.ym].cost += mCost;
    });
  }

  // First delivery: estimate how far back consumption started using
  // the gal/HDD rate from the next inter-delivery period, then distribute
  // backwards via HDD weighting. If only 1 delivery exists, assign as lump.
  if (sorted.length >= 1) {
    const d = sorted[0];
    const gal = parseFloat(d.gallonsDelivered || d.kwh) || 0;
    const cost = parseFloat(d.totalCost) || 0;
    if (gal > 0) {
      if (sorted.length === 1) {
        const ym = d.start.slice(0, 7);
        result[ym] = { gallons: gal, cost: cost };
      } else {
        // Estimate consumption rate from the first measured period
        const d2 = sorted[1];
        const g2 = parseFloat(d2.gallonsDelivered || d2.kwh) || 0;
        const s1 = _parseISO(d.start),
          s2 = _parseISO(d2.start);
        const period1Spans = monthSpans(s1, s2);
        let period1HDD = 0;
        period1Spans.forEach(function (s) {
          const w = hddByMonth && hddByMonth[s.ym];
          const calDays = calDaysInMonth(s.ym);
          period1HDD += w && w.hdd ? w.hdd * (s.days / calDays) : 0;
        });
        const galPerHDD = period1HDD > 0 && g2 > 0 ? g2 / period1HDD : 0;
        // Walk backwards from delivery date until accumulated HDD accounts
        // for the first delivery's gallons (or max 6 months back)
        const targetHDD = galPerHDD > 0 ? gal / galPerHDD : 0;
        let accHDD = 0;
        const backSpans = [];
        const deliveryDate = _parseISO(d.start);
        for (let mo = 0; mo < 6; mo++) {
          const dt = new Date(deliveryDate);
          dt.setMonth(dt.getMonth() - mo);
          const ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
          const w = hddByMonth && hddByMonth[ym];
          const moHDD = w && w.hdd ? w.hdd : 0;
          // First month: only count days up to delivery date
          const calDays = calDaysInMonth(ym);
          const frac = mo === 0 ? Math.max(1, deliveryDate.getDate()) / calDays : 1;
          const hdd = moHDD * frac;
          backSpans.unshift({ ym, hdd });
          accHDD += hdd;
          if (targetHDD > 0 && accHDD >= targetHDD) break;
        }
        // Distribute first delivery's gallons across back-spans by HDD
        const totalBackHDD = backSpans.reduce(function (s, b) {
          return s + b.hdd;
        }, 0);
        backSpans.forEach(function (s) {
          const share = totalBackHDD > 0 ? s.hdd / totalBackHDD : 1 / backSpans.length;
          if (!result[s.ym]) result[s.ym] = { gallons: 0, cost: 0 };
          result[s.ym].gallons += gal * share;
          result[s.ym].cost += cost * share;
        });
      }
    }
  }

  // Last delivery: estimate forward consumption from the delivery date using
  // the gal/HDD rate from the last measured inter-delivery period.
  // The main loop already distributed the last delivery's gallons backward into
  // the pre-delivery span (delivery[N-1] → delivery[N]). This block adds
  // projected gallons for POST-delivery months (delivery date forward), using
  // the consumption rate as a model. These are estimated values, capped at
  // galLast to avoid over-projecting beyond the tank capacity.
  if (sorted.length >= 2) {
    const dLast = sorted[sorted.length - 1];
    const dPrev = sorted[sorted.length - 2];
    const galLast = parseFloat(dLast.gallonsDelivered || dLast.kwh) || 0;
    const costPerGal = galLast > 0 ? (parseFloat(dLast.totalCost) || 0) / galLast : 0;
    if (galLast > 0) {
      // Derive gal/HDD rate from the last measured inter-delivery period
      const galSecondLast = parseFloat(dPrev.gallonsDelivered || dPrev.kwh) || 0;
      const sLast = _parseISO(dPrev.start);
      const eLast = _parseISO(dLast.start);
      const prevPeriodSpans = monthSpans(sLast, eLast);
      let prevPeriodHDD = 0;
      prevPeriodSpans.forEach(function (s) {
        const w = hddByMonth && hddByMonth[s.ym];
        const calDays = calDaysInMonth(s.ym);
        prevPeriodHDD += w && w.hdd ? w.hdd * (s.days / calDays) : 0;
      });
      const galPerHDD = prevPeriodHDD > 0 && galSecondLast > 0 ? galSecondLast / prevPeriodHDD : 0;
      if (galPerHDD > 0) {
        // Walk forward from delivery date, up to 6 months, capped at galLast total
        let projAccum = 0;
        const deliveryDateFwd = _parseISO(dLast.start);
        for (let mo = 0; mo < 6 && projAccum < galLast; mo++) {
          const dt = new Date(deliveryDateFwd);
          dt.setMonth(dt.getMonth() + mo);
          const ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
          const w = hddByMonth && hddByMonth[ym];
          const moHDD = w && w.hdd ? w.hdd : 0;
          const calDays = calDaysInMonth(ym);
          // First month: only count days FROM delivery date to end of month
          const frac = mo === 0 ? Math.max(1, calDays - deliveryDateFwd.getDate() + 1) / calDays : 1;
          const hdd = moHDD * frac;
          const projGal = Math.min(galPerHDD * hdd, galLast - projAccum);
          if (projGal > 0) {
            if (!result[ym]) result[ym] = { gallons: 0, cost: 0 };
            result[ym].gallons += projGal;
            result[ym].cost += projGal * costPerGal;
            projAccum += projGal;
          }
        }
      }
    }
  }

  return Object.entries(result)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, gallons: v.gallons, cost: v.cost }));
}

function getNormRows(m, bills, incl, weatherByYm) {
  // Build one entry per calendar month by prorating each bill across every month it spans.
  // A bill from 2/1–2/15 and a bill from 2/15–3/1 will correctly populate both Feb AND March:
  //   2/1–2/15:  15 days entirely in Feb  → all usage/cost to Feb
  //   2/15–3/1:  14 days in Feb, 1 day in March → 14/15 of usage/cost to Feb, 1/15 to March
  // This handles both split-month billing and normal billing (majority already goes to the right month).
  //
  // weatherByYm: optional map of {YYYY-MM: {hdd, cdd, avgTemp}} loaded from the ZIP weather cache.
  // When provided, HDD/CDD/avgTemp for each calendar month come from the weather CSV directly,
  // rather than being prorated from bill-row values. This is the preferred source.

  const byMonth = {};
  const isElec = m.commodity === 'Electric',
    isGas = m.commodity === 'Gas',
    isPropane = m.commodity === 'Propane',
    isSewer = m.commodity === 'Sewer';

  // ── Propane: use HDD-weighted normalization instead of day-prorating ──
  // Propane deliveries have start===end (DeliveryDate), so the normal
  // day-prorating logic produces a single day per delivery. Instead, we
  // spread each delivery's gallons across the months between deliveries,
  // weighted by HDD (heating load).
  if (isPropane) {
    const normRows = normalizePropaneDeliveries(bills, weatherByYm);
    normRows.forEach((nr) => {
      const calDays = calDaysInMonth(nr.month);
      byMonth[nr.month] = {
        ym: nr.month,
        start: nr.month + '-01',
        end: nr.month + '-' + String(calDays).padStart(2, '0'),
        days: calDays,
        usage: nr.gallons,
        cost: nr.cost,
        hddSum: 0,
        cddSum: 0,
        tmpSum: 0,
        wSum: 0,
        hasHdd: false,
        hasCdd: false,
        hasTmp: false,
        _ids: ['propane_norm'],
      };
    });
  } else {
    // ── Standard commodity (Electric / Gas / Water): day-prorate across months ──
    bills.forEach((row) => {
      if (!row.start || !row.end) return;
      const totalDays = Math.max(1, parseInt(calcDays(row.start, row.end, incl)) || 1);
      const usage = isElec
        ? parseFloat(row.kwh) || 0
        : isGas
          ? parseFloat(row.therms) || 0
          : isSewer
            ? parseFloat(row.sewerUsage) || parseFloat(row.waterUsage) || 0
            : parseFloat(row.waterUsage) || 0;
      const cost = isElec
        ? parseFloat(row.totalCost) || 0
        : isGas
          ? // Bug d4c78f06: prefer gasCharge (commodity cost) for the $/therm rate
            // calculation. thermCost was historically set to TotalCurrentCharges (total
            // bill cost), so gasCharge gives a more accurate energy-only rate.
            // Fall back: gasCharge → thermCost → totalCost → cost.
            parseFloat(row.gasCharge) ||
            parseFloat(row.thermCost) ||
            parseFloat(row.totalCost) ||
            parseFloat(row.cost) ||
            0
          : parseFloat(row.cost) || parseFloat(row.totalCost) || 0;
      // Bill-level weather — only used as fallback if no ZIP weather cache
      const hdd = parseFloat(row.hdd) || 0;
      const cdd = parseFloat(row.cdd) || 0;
      const avgTmp = parseFloat(row.avgTemp) || 0;

      // Count actual days per calendar month that this bill spans
      const monthDays = {};
      const s = _parseISO(row.start);
      const e = _parseISO(row.end);
      let cur = new Date(s);
      while (cur <= e) {
        const ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
        monthDays[ym] = (monthDays[ym] || 0) + 1;
        cur.setDate(cur.getDate() + 1);
      }

      // Prorate usage/cost/days into each spanned month
      const spannedTotal = Object.values(monthDays).reduce((a, b) => a + b, 0) || 1;
      Object.entries(monthDays).forEach(([ym, daysInMonth]) => {
        const frac = daysInMonth / spannedTotal;
        const pUsage = usage * frac;
        const pCost = cost * frac;
        const pDays = daysInMonth;

        if (byMonth[ym]) {
          byMonth[ym].usage += pUsage;
          byMonth[ym].cost += pCost;
          byMonth[ym].days += pDays;
          // Only accumulate bill-level weather if no ZIP weather cache
          if (!weatherByYm) {
            if (hdd) {
              byMonth[ym].hddSum = (byMonth[ym].hddSum || 0) + hdd * frac;
              byMonth[ym].hasHdd = true;
            }
            if (cdd) {
              byMonth[ym].cddSum = (byMonth[ym].cddSum || 0) + cdd * frac;
              byMonth[ym].hasCdd = true;
            }
            if (avgTmp) {
              byMonth[ym].tmpSum = (byMonth[ym].tmpSum || 0) + avgTmp * frac;
              byMonth[ym].hasTmp = true;
            }
            byMonth[ym].wSum = (byMonth[ym].wSum || 0) + frac;
          }
          byMonth[ym]._ids.push(row.id);
        } else {
          byMonth[ym] = {
            ym,
            start: row.start,
            end: row.end,
            days: pDays,
            usage: pUsage,
            cost: pCost,
            hddSum: !weatherByYm && hdd ? hdd * frac : 0,
            cddSum: !weatherByYm && cdd ? cdd * frac : 0,
            tmpSum: !weatherByYm && avgTmp ? avgTmp * frac : 0,
            wSum: !weatherByYm ? frac : 0,
            hasHdd: !weatherByYm && !!hdd,
            hasCdd: !weatherByYm && !!cdd,
            hasTmp: !weatherByYm && !!avgTmp,
            _ids: [row.id],
          };
        }
      });
    });
  } // end non-propane branch

  // Build rows first pass — compute weather, usage, etc.
  const rawRows = Object.entries(byMonth)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ym, r]) => {
      const usagePerDay = r.days > 0 ? r.usage / r.days : 0;
      const calDays = calDaysInMonth(ym);
      // Flag months where bill coverage is less than 90% of calendar days — partial first/last months
      const partial = r.days < calDays * 0.9;
      let hdd, cdd, avgTemp;
      if (weatherByYm && weatherByYm[ym]) {
        const w = weatherByYm[ym];
        hdd = w.hdd != null ? w.hdd : null;
        cdd = w.cdd != null ? w.cdd : null;
        avgTemp = w.avgTemp != null ? w.avgTemp : null;
      } else {
        hdd = r.hasHdd ? (r.wSum > 0 ? r.hddSum / r.wSum : 0) : null;
        cdd = r.hasCdd ? (r.wSum > 0 ? r.cddSum / r.wSum : 0) : null;
        avgTemp = r.hasTmp ? (r.wSum > 0 ? r.tmpSum / r.wSum : 0) : null;
      }
      const hddNorm = hdd != null && hdd > 0 ? r.usage / hdd : null;
      const cddNorm = cdd != null && cdd > 0 ? r.usage / cdd : null;
      const isElecMeter = m.commodity === 'Electric';
      const weatherNorm = isElecMeter ? cddNorm : hddNorm;
      const weatherDenom = isElecMeter ? cdd : hdd;
      const [yr, mo] = ym.split('-');
      const dt = new Date(parseInt(yr), parseInt(mo) - 1, 1);
      const label = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      // normDays: calendar days in this YYYY-MM (used for regression baseline with 'calendar' basis)
      const normDays = calDaysInMonth(ym);
      return {
        id: r._ids[0],
        ym,
        start: r.start,
        end: r.end,
        days: r.days,
        normDays,
        partial,
        usage: r.usage,
        usagePerDay,
        cost: r.cost,
        hdd,
        cdd,
        avgTemp,
        hddNorm,
        cddNorm,
        weatherNorm,
        weatherDenom,
        label,
        isBaseline: !!(m.baseline && m.baseline.months && m.baseline.months.includes(ym)),
        regrBaseline: null, // filled in second pass below
      };
    });

  // Second pass: compute regression using ALL rows for display purposes,
  // but for baseline months use the FROZEN regression stored at baseline-save time.
  // This prevents post-baseline bills from changing the baseline normalized values.
  const proj = getUDProj(udSelProjId);
  const normBasis = proj?.normBasis || 'calendar';
  const reg = computeMeterRegression(rawRows); // full regression for non-baseline months
  const _rawFrozenReg = m.baseline?.reg || null;
  // A frozen regression with null coefficients means the baseline was saved
  // before weather data was uploaded. Treat it as absent so the live
  // regression (computed from current weather data) can take over.
  const isElecMeter = m.commodity === 'Electric';
  const frozenRegValid = _rawFrozenReg && ((isElecMeter && _rawFrozenReg.cdd) || (!isElecMeter && _rawFrozenReg.hdd));
  const frozenReg = frozenRegValid ? _rawFrozenReg : null;

  const blOverrides = m.baseline?.overrides || {};
  rawRows.forEach((row) => {
    if (blOverrides[row.ym] != null) {
      row.regrBaseline = blOverrides[row.ym];
    } else if (frozenReg && row.isBaseline) {
      row.regrBaseline = regressionBaseline(row, frozenReg, m.commodity, normBasis);
    } else if (frozenReg) {
      row.regrBaseline = regressionBaseline(row, frozenReg, m.commodity, normBasis);
    } else {
      row.regrBaseline = regressionBaseline(row, reg, m.commodity, normBasis);
    }
  });
  // Attach regression to meter object for display in UI (not persisted, recomputed each render)
  m._reg = frozenReg || reg;

  return rawRows;
}
