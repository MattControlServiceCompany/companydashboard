// computations/bill-flags.js - the ONE bill-flag engine (pure, no DOM).
//
// computeMeterFlagSummary(meter, building) -> { flaggedBills, flagCount, perBill }
// computeBuildingFlagSummary(building)     -> { flaggedBills, flagCount, byMeter }
//
// Every flag count on the site calls these: the Bills tab banner, the meter pill, the building badge,
// the Review Bill Corrections panel and the data-quality score. A flag means "look at this bill":
// a billing error or a big usage change. Normal weather and normal rate changes never flag.
//
// Shared helpers used (never copied here): calcDays and fmtDate (app/utility-data.js), normMonth and
// detectGap (computations/normalization.js), parseBillNumber (lib/formatting.js), getBillUsageOrNull
// (computations/savings.js), getBillUsageCharge and getStoredRate (computations/rates.js).
// A blank value is null (missing); a real 0 is 0.
// Tests: tools/test-bill-flag-rules.js. Gate: tools/gate-single-bill-flag-count.js.

// Every threshold lives here and nowhere else. Each is justified from the 2026-09-30 backup
// (plan 2026-10-05-bill-flag-rules-redesign.md section 3.3).
const BILL_FLAG_THRESHOLDS = {
  GAP_DAYS: 3, // same as detectGap and the Bills table gap row
  OVERLAP_DAYS: 3,
  PERIOD_LO: 0.5, // billing period vs the meter's usual period
  PERIOD_HI: 2.0,
  PERIOD_MIN_BILLS: 6,
  DAYS_PRINTED_TOL: 1, // printed days vs date span
  SUM_ABS: 0.1, // charge parts vs total, dollars
  SUM_REL: 0.001,
  READ_REL: 0.02, // read difference x multiplier vs kWh
  READ_ABS: 5,
  GAS_READ_RATIO_TOL: 0.1, // gas therms per read unit vs the meter's usual
  READ_CONTINUITY_REL: 0.001, // start read vs previous end read
  READ_CONTINUITY_ABS: 1,
  USAGE_MULT: 4, // same calendar month, 2 or more other years
  USAGE_MULT_ONE_PEER: 8, // same calendar month, only 1 other year
  USAGE_MIN_PEERS: 1,
  MATERIAL_FRAC: 0.1, // skip dead months: larger daily use under this share of the meter's 90th percentile
  RATE_MULT: 3, // total charge vs usage x the meter's usual rate
  USAGE_CHARGE_MIN_USAGE_FRAC: 0.5, // only bills with at least this share of the meter's middle usage are tested
  USAGE_CHARGE_MULT: 2, // the bill's own rate (usage charge / usage, getStoredRate) vs the meter's usual own rate
  FLAT_CHARGE_BILLS: 3, // a usage charge repeated (to the cent) on this many bills is flat or a minimum: those bills are not tested
  RATE_MIN_BILLS: 6,
  RATE_MIN_USAGE_FRAC: 0.1,
  ZERO_CHARGE_MULT: 2,
  PARITY_MULT: 3, // water gallons vs sewer gallons, same month
  GAS_COST_FIELD_TOL: 1, // gas "Cost" column vs the bill's own parts, dollars
  MIN_BILL_USAGE_FRAC: 0.25, // a "usual minimum bill" comes from bills at or under this share of median usage
};

// Rule id -> column label shown on the flagged cell. The dismissal id of a flag is its rule id.
const BILL_FLAG_RULES = {
  dates_missing: { label: 'Billing Dates', severity: 'error' },
  period_length: { label: 'Billing Days', severity: 'warn' },
  days_mismatch: { label: 'Billing Days', severity: 'warn' },
  period_overlap: { label: 'Start Date', severity: 'error' },
  period_gap: { label: 'Start Date', severity: 'warn' },
  duplicate_bill: { label: 'Start Date', severity: 'error' },
  charge_sum_mismatch: { label: 'Total Cost', severity: 'error' },
  cost_field_mismatch: { label: 'Gas Charge', severity: 'error' },
  read_usage_mismatch: { label: 'Usage', severity: 'error' },
  read_continuity: { label: 'Start Read', severity: 'warn' },
  read_rollback: { label: 'Read Difference', severity: 'error' },
  usage_missing: { label: 'Usage', severity: 'warn' },
  usage_negative: { label: 'Usage', severity: 'warn' },
  cost_missing: { label: 'Total Cost', severity: 'warn' },
  charge_vs_usage: { label: 'Total Cost', severity: 'warn' },
  usage_charge_mismatch: { label: 'Usage', severity: 'warn' },
  water_sewer_parity: { label: 'Usage', severity: 'warn' },
  usage_vs_same_month: { label: 'Usage', severity: 'warn' },
  fac_kw_missing: { label: 'Facilities kW', severity: 'warn' },
};
// Persisted by the facilities-kW backfill (app/csv-import.js); the only flag still stored on the bill.
const FAC_KW_MISSING_STORED_ID = 'facKWMissing_warn';

// The Bills table column that holds a commodity's usage (where the flag dot is drawn).
const _BF_USAGE_COLUMN = {
  Electric: 'kwh',
  Gas: 'naturalGasTherms',
  Water: 'waterUsage',
  Sewer: 'sewerUsage',
  Propane: 'gallonsDelivered',
};

const _BF_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _BF_MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function _bfFmt(n, d) {
  return n === null || n === undefined
    ? 'blank'
    : Number(n).toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 1 : d });
}
function _bfMoney(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _bfDate(d) {
  return d ? fmtDate(d) : 'blank';
}
function _bfPeriod(b) {
  return _bfDate(b.start) + ' to ' + _bfDate(b.end);
}
function _bfMedian(a) {
  const s = a.filter((v) => v !== null && isFinite(v)).sort((x, y) => x - y);
  if (!s.length) return null;
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
function _bfUnit(commodity) {
  return commodity === 'Electric' ? 'kWh' : commodity === 'Gas' ? 'therms' : 'gal';
}
// Whole days between two dates through the one day-count function; null when a date is blank.
function _bfDays(start, end, incl) {
  const d = calcDays(start, end, incl);
  return d === '' || d === null || isNaN(d) ? null : d;
}
function _bfSortByStart(bills) {
  return bills.slice().sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
}
// Month index 0-11 and year of a bill from the ONE month rule (normMonth chain across the meter's bills).
function _bfChainMonth(b, incl, sortedAll) {
  if (!b.start || !b.end) return null;
  const ym = normMonth(b.start, b.end, incl, sortedAll);
  const m = /^(\d{4})-(\d{2})/.exec(ym || '');
  return m ? { yr: +m[1], mo: +m[2] - 1 } : null;
}
function _bfMonthLabel(cm) {
  return cm ? _BF_MONTHS[cm.mo] + ' ' + cm.yr : '';
}

function _bfVarCharge(b, c, total) {
  const pick = { Gas: 'gasCharge', Water: 'waterCharge', Sewer: 'sewerCharge' }[c];
  if (pick) {
    const g = parseBillNumber(b[pick]);
    if (g !== null) return g;
  }
  return total;
}
function _bfComponents(b, c) {
  const num = parseBillNumber;
  const s = (...k) => k.reduce((a, x) => a + (num(b[x]) || 0), 0);
  if (c === 'Electric' && num(b.kwhCost) !== null)
    return {
      sum: s('kwCost', 'kwhCost', 'otherCost', 'taxCost', 'facKWCost', 'solarCredit'),
      label: 'kW cost + kWh cost + other + tax + facilities + solar credit',
    };
  if (c === 'Gas' && num(b.gasCharge) !== null && num(b.customerCharge) !== null && num(b.fuelAdjustment) !== null)
    return {
      sum: s('customerCharge', 'gasCharge', 'fuelAdjustment'),
      label: 'customer charge + gas charge + fuel adjustment',
    };
  if (c === 'Water' && num(b.waterCharge) !== null)
    return { sum: s('waterCharge', 'waterProtectionFee'), label: 'water charge + protection fee' };
  if (c === 'Sewer' && num(b.sewerCharge) !== null) return { sum: s('sewerCharge'), label: 'sewer charge' };
  if (c === 'Stormwater' && num(b.stormWaterCharge) !== null)
    return { sum: s('stormWaterCharge'), label: 'stormwater charge' };
  return null;
}
// A solar credit lowers the total; add it back before comparing a total with usage x rate.
function _bfCostBasis(b, cost) {
  return cost !== null && parseBillNumber(b.solarCredit) < 0 ? cost - parseBillNumber(b.solarCredit) : cost;
}
// A blank usage is a real zero (not missing) when the bill itself proves it: the meter read did not move,
// or only the fixed customer charge was billed. Never flag these as "usage missing".
function _bfProvenZeroUsage(b, c, total) {
  const rd = parseBillNumber(b.readDifference);
  if (rd === 0) return true;
  const sr = parseBillNumber(b.startRead),
    er = parseBillNumber(b.endRead);
  if (sr !== null && er !== null && sr === er) return true;
  // Only the fixed customer charge was billed. A read difference that moved says otherwise, so that bill still flags.
  if (c === 'Gas' && rd === null) {
    const cu = parseBillNumber(b.customerCharge);
    if (cu !== null && total !== null && Math.abs(total - cu) <= 0.01) return true;
  }
  return false;
}

function computeMeterFlagSummary(meter, building) {
  const T = BILL_FLAG_THRESHOLDS;
  const num = parseBillNumber;
  const c = meter.commodity;
  const incl = meter.inclusive !== false;
  const sortedAll = _bfSortByStart(meter.bills || []); // chain months use every bill, as the Bills table does
  const perBill = {};
  const add = (b, rule, message, field) => {
    (perBill[b.id] = perBill[b.id] || []).push({
      rule,
      field: (field === 'usage' ? _BF_USAGE_COLUMN[c] : field) || rule,
      label: BILL_FLAG_RULES[rule].label,
      severity: BILL_FLAG_RULES[rule].severity,
      message,
      dismissId: rule === 'fac_kw_missing' ? FAC_KW_MISSING_STORED_ID : rule,
    });
  };

  const rows = sortedAll
    .filter((b) => !b.estimated)
    .map((b) => {
      const cm = _bfChainMonth(b, incl, sortedAll);
      return {
        b,
        days: b.start && b.end ? _bfDays(b.start, b.end, incl) : null,
        u: getBillUsageOrNull(b, c),
        cost: num(b.totalCost),
        cm,
        nm: cm ? cm.mo : -1,
        yr: cm ? cm.yr : 0,
      };
    });
  const okDays = rows.filter((r) => r.days > 0);
  const medDays = okDays.length >= T.PERIOD_MIN_BILLS ? _bfMedian(okDays.map((r) => r.days)) : null;
  const medU = _bfMedian(rows.filter((r) => r.u > 0).map((r) => r.u));
  const medUperDay = _bfMedian(rows.filter((r) => r.u > 0 && r.days > 0).map((r) => r.u / r.days));
  const perDay = rows
    .filter((r) => r.u > 0 && r.days > 0)
    .map((r) => r.u / r.days)
    .sort((a, b) => a - b);
  const p90UperDay = perDay.length ? perDay[Math.min(perDay.length - 1, Math.floor(0.9 * perDay.length))] : 0;
  const rateTot = rows
    .filter((r) => r.u > 0 && r.cost > 0 && r.u >= T.RATE_MIN_USAGE_FRAC * (medU || 0))
    .map((r) => _bfCostBasis(r.b, r.cost) / r.u);
  // Each bill's own $ per unit = its usage charge / its usage, from the one rate function (getStoredRate,
  // computations/rates.js). Never the stored totalWaterRate / totalSewerRate: those can be stale.
  // Water and sewer only: their usage charge is a clean $ per gallon. (Electric and gas bills carry demand, fixed and
  // index charges, so they keep the 3x charge_vs_usage rule.) Bills with tiny usage are left out: fixed fees swamp the rate.
  // A charge that repeats to the cent on FLAT_CHARGE_BILLS or more bills of the meter is a flat or minimum charge
  // (Site H Sewer $695.85 x 9, Maintenance Sewer $27.00 x 8): those bills have no $ per gallon. They are neither
  // tested nor used for the meter's usual rate. Skipping the whole meter would lose real errors on its other bills
  // (Site H Sewer 2024-07-15, Maintenance Sewer 2024-12-15; review 2026-10-05).
  const _rateKey = { Water: 'water', Sewer: 'sewer' }[c];
  const ownRates = new Map();
  if (_rateKey) {
    const chargeCount = {};
    rows.forEach((r) => {
      const chg = getBillUsageCharge(r.b, _rateKey);
      if (chg > 0) chargeCount[chg.toFixed(2)] = (chargeCount[chg.toFixed(2)] || 0) + 1;
    });
    rows.forEach((r) => {
      const chg = getBillUsageCharge(r.b, _rateKey);
      const flat = chg > 0 && chargeCount[chg.toFixed(2)] >= T.FLAT_CHARGE_BILLS;
      const v =
        chg > 0 && !flat && r.u !== null && r.u >= T.USAGE_CHARGE_MIN_USAGE_FRAC * (medU || 0) && r.u > 0
          ? getStoredRate(r.b, _rateKey)
          : 0;
      if (v > 0) ownRates.set(r, v);
    });
  }
  const medOwnRate = ownRates.size >= T.RATE_MIN_BILLS ? _bfMedian([...ownRates.values()]) : null;
  const medRateTot = rateTot.length >= T.RATE_MIN_BILLS ? _bfMedian(rateTot) : null;
  const gasRatio =
    c === 'Gas'
      ? _bfMedian(
          rows.filter((r) => r.u > 0 && num(r.b.readDifference)).map((r) => r.u / Math.abs(num(r.b.readDifference))),
        )
      : null;
  // usual minimum bill = smallest total among bills with little usage (needs 2 such bills)
  const minCharge = (() => {
    const t = rows
      .filter((r) => r.u !== null && r.u <= T.MIN_BILL_USAGE_FRAC * (medU || 0) && r.cost > 0)
      .map((r) => r.cost)
      .sort((x, y) => x - y);
    return t.length >= 2 ? t[0] : 0;
  })();

  // Water vs sewer: same month (each meter's own chain month), partner meter in the same building.
  const parity = {};
  if ((c === 'Water' || c === 'Sewer') && building) {
    const other = c === 'Water' ? 'Sewer' : 'Water';
    const pm = (building.meters || []).find((x) => x.commodity === other && x !== meter && (x.bills || []).length);
    if (pm) {
      const pAll = _bfSortByStart(pm.bills);
      const pIncl = pm.inclusive !== false;
      const pmap = {};
      pAll.forEach((b) => {
        if (b.estimated) return;
        const cm = _bfChainMonth(b, pIncl, pAll);
        if (cm) pmap[cm.yr + '-' + cm.mo] = b;
      });
      rows.forEach((r) => {
        const pb = r.cm && pmap[r.cm.yr + '-' + r.cm.mo];
        if (!pb) return;
        const wu = c === 'Water' ? r.u : getBillUsageOrNull(pb, 'Water');
        const su = c === 'Sewer' ? r.u : getBillUsageOrNull(pb, 'Sewer');
        if (wu > 0 && su > 0) {
          const ratio = wu / su;
          if (ratio >= T.PARITY_MULT || ratio <= 1 / T.PARITY_MULT)
            parity[r.b.id] =
              'Water and sewer gallons should match in the same month. ' +
              _bfMonthLabel(r.cm) +
              ': water ' +
              _bfFmt(wu, 0) +
              ' gal, sewer ' +
              _bfFmt(su, 0) +
              ' gal (' +
              (ratio >= 1 ? _bfFmt(ratio) + 'x more water than sewer' : _bfFmt(1 / ratio) + 'x more sewer than water') +
              '; ' +
              other.toLowerCase() +
              ' bill ' +
              _bfPeriod(pb) +
              '). Flag at ' +
              T.PARITY_MULT +
              'x or more.';
        }
      });
    }
  }

  const BILLING_ERROR_RULES = [
    'charge_vs_usage',
    'cost_field_mismatch',
    'read_usage_mismatch',
    'usage_missing',
    'dates_missing',
    'charge_sum_mismatch',
    'period_length',
  ];
  const untrusted = (p) => (perBill[p.b.id] || []).some((f) => BILLING_ERROR_RULES.includes(f.rule));
  const later = []; // same-month check runs after every bill's billing errors are known

  rows.forEach((r) => {
    const b = r.b;
    const si = sortedAll.indexOf(b);
    if (!b.start || !b.end) {
      add(
        b,
        'dates_missing',
        'Billing dates are missing: start date is ' +
          (b.start ? _bfDate(b.start) : 'blank') +
          ', end date is ' +
          (b.end ? _bfDate(b.end) : 'blank') +
          '. Every bill needs both dates.',
        'start',
      );
    } else if (c !== 'Propane') {
      // propane is one delivery per bill: no billing period to check
      if (r.days !== null && r.days <= 0)
        add(
          b,
          'period_length',
          'The end date ' + _bfDate(b.end) + ' is not after the start date ' + _bfDate(b.start) + '.',
          'days',
        );
      else if (medDays && r.days > 0 && (r.days / medDays < T.PERIOD_LO || r.days / medDays > T.PERIOD_HI))
        add(
          b,
          'period_length',
          'This bill covers ' +
            r.days +
            ' days. This meter usually has ' +
            _bfFmt(medDays, 0) +
            ' days (middle value of ' +
            okDays.length +
            ' bills). Flag under ' +
            T.PERIOD_LO +
            'x or over ' +
            T.PERIOD_HI +
            'x.',
          'days',
        );
      const nd = num(b.numberOfDays);
      const excl = _bfDays(b.start, b.end, false);
      if (nd !== null && excl !== null && r.days > 0 && Math.abs(nd - excl) > T.DAYS_PRINTED_TOL)
        add(
          b,
          'days_mismatch',
          'The bill prints ' +
            nd +
            ' days, but its dates (' +
            _bfPeriod(b) +
            ') span ' +
            excl +
            ' days. Flag when they differ by more than ' +
            T.DAYS_PRINTED_TOL +
            ' day.',
          'days',
        );
      // overlap with any earlier bill (estimated bills count as neighbours)
      let ov = null;
      for (let j = 0; j < si; j++) {
        const o = sortedAll[j];
        if (!o.start || !o.end) continue;
        const lo = o.start > b.start ? o.start : b.start;
        const hi = o.end < b.end ? o.end : b.end;
        const od = calcDays(lo, hi, false);
        if (od > T.OVERLAP_DAYS && (!ov || od > ov.od)) ov = { od, o };
      }
      if (ov)
        add(
          b,
          'period_overlap',
          'This bill (' +
            _bfPeriod(b) +
            ') overlaps the bill ' +
            _bfPeriod(ov.o) +
            ' by ' +
            ov.od +
            ' days. Flag at more than ' +
            T.OVERLAP_DAYS +
            ' days.',
          'start',
        );
      let prev = null;
      for (let j = si - 1; j >= 0; j--) {
        if (sortedAll[j].end) {
          prev = sortedAll[j];
          break;
        }
      }
      if (prev && !ov && detectGap(prev.end, b.start)) {
        const g = calcDays(prev.end, b.start, false);
        add(
          b,
          'period_gap',
          'No bill covers ' +
            _bfDate(prev.end) +
            ' to ' +
            _bfDate(b.start) +
            ' (' +
            g +
            ' days): a bill is probably missing. The previous bill ends ' +
            _bfDate(prev.end) +
            ' and this bill starts ' +
            _bfDate(b.start) +
            '. Flag at more than ' +
            T.GAP_DAYS +
            ' days.',
          'start',
        );
      }
      for (let j = 0; j < si; j++) {
        const o = sortedAll[j];
        if (o.estimated || !o.start) continue;
        if (
          (o.start === b.start && o.end === b.end) ||
          (o.start === b.start && num(o.totalCost) !== null && num(o.totalCost) === r.cost)
        ) {
          add(
            b,
            'duplicate_bill',
            'This bill has the same dates or the same start date and total as the bill ' +
              _bfPeriod(o) +
              ' (total ' +
              _bfMoney(num(o.totalCost) || 0) +
              ').',
            'start',
          );
          break;
        }
      }
    }

    const comp = _bfComponents(b, c);
    if (comp && r.cost !== null) {
      const diff = comp.sum - r.cost;
      if (Math.abs(diff) > Math.max(T.SUM_ABS, T.SUM_REL * Math.abs(r.cost)))
        add(
          b,
          'charge_sum_mismatch',
          'The charge parts (' +
            comp.label +
            ') add up to ' +
            _bfMoney(comp.sum) +
            ' but the bill total is ' +
            _bfMoney(r.cost) +
            ' (difference ' +
            _bfMoney(Math.abs(diff)) +
            '). Flag at more than ' +
            _bfMoney(T.SUM_ABS) +
            ' or ' +
            T.SUM_REL * 100 +
            '%.',
          'totalCost',
        );
    }
    if (c === 'Gas') {
      // Integrity check of the old stored copy thermCost (no longer written) against the bill's own parts. Not a cost
      // reader: every cost reader calls getBillGasCost. Kept so existing flag counts do not move (Matt 2026-10-06).
      const th = num(b.thermCost),
        g = num(b.gasCharge),
        cu = num(b.customerCharge);
      if (th !== null && r.cost !== null && g !== null) {
        const ok = [r.cost, g + (cu || 0), g].some((v) => Math.abs(th - v) <= T.GAS_COST_FIELD_TOL);
        if (!ok)
          add(
            b,
            'cost_field_mismatch',
            'The gas cost column shows ' +
              _bfMoney(th) +
              ", but the bill's own parts give gas charge " +
              _bfMoney(g) +
              ' + customer charge ' +
              _bfMoney(cu || 0) +
              ' = ' +
              _bfMoney(g + (cu || 0)) +
              ' (bill total ' +
              _bfMoney(r.cost) +
              '). Flag when the column matches neither within ' +
              _bfMoney(T.GAS_COST_FIELD_TOL) +
              '.',
            'thermCost',
          );
      }
    }
    const rd = num(b.readDifference),
      mult = num(b.meterMultiplier);
    if (c === 'Electric' && r.u !== null) {
      // multi-meter bills list each meter as Meter1_, Meter2_; the bill kWh is their sum
      let exp = null;
      const m1 = num(b.Meter1_ReadDiff),
        m1m = num(b.Meter1_Multiplier),
        m2 = num(b.Meter2_ReadDiff),
        m2m = num(b.Meter2_Multiplier);
      if (m1 !== null && m1m !== null) exp = m1 * m1m + (m2 !== null && m2m !== null ? m2 * m2m : 0);
      else if (rd !== null && mult !== null) exp = rd * mult;
      if (exp !== null && Math.abs(exp - r.u) > Math.max(T.READ_ABS, T.READ_REL * Math.abs(r.u)))
        add(
          b,
          'read_usage_mismatch',
          'Meter read difference x multiplier gives ' +
            _bfFmt(exp) +
            ' kWh, but the bill shows ' +
            _bfFmt(r.u) +
            ' kWh. Flag at more than ' +
            T.READ_REL * 100 +
            '% or ' +
            T.READ_ABS +
            ' kWh.',
          'kwh',
        );
    }
    if (c === 'Gas' && rd !== null && r.u !== null && gasRatio) {
      const exp = Math.abs(rd);
      if (exp > 0 && r.u > 0) {
        const ratio = r.u / exp;
        if (Math.abs(ratio / gasRatio - 1) > T.GAS_READ_RATIO_TOL && Math.abs(exp * gasRatio - r.u) > T.READ_ABS)
          add(
            b,
            'read_usage_mismatch',
            'The meter read difference is ' +
              _bfFmt(exp, 2) +
              ' (about ' +
              _bfFmt(exp * gasRatio) +
              " therms at this meter's usual " +
              gasRatio.toFixed(2) +
              ' therms per read unit), but the bill shows ' +
              _bfFmt(r.u) +
              ' therms. Flag when the ratio is more than ' +
              T.GAS_READ_RATIO_TOL * 100 +
              '% off.',
            'usage',
          );
      } else if (exp === 0 && r.u > T.READ_ABS)
        add(
          b,
          'read_usage_mismatch',
          'The meter read difference is 0, but the bill shows ' + _bfFmt(r.u) + ' therms.',
          'usage',
        );
      else if (exp > T.READ_ABS && r.u === 0)
        add(
          b,
          'read_usage_mismatch',
          'The meter read difference is ' + _bfFmt(exp, 2) + ', but the bill shows 0 therms.',
          'usage',
        );
    }
    if (c === 'Electric' && rd !== null && rd < 0)
      add(
        b,
        'read_rollback',
        'The meter read goes backwards: start read ' +
          _bfFmt(num(b.startRead), 2) +
          ' to end read ' +
          _bfFmt(num(b.endRead), 2) +
          ' (difference ' +
          _bfFmt(rd, 2) +
          ').',
        'readDifference',
      );

    if (c !== 'Stormwater') {
      const vc = _bfVarCharge(b, c, r.cost);
      const evidenceCharge = vc > 0 && vc > (minCharge || 0) * T.ZERO_CHARGE_MULT;
      const evidenceRead = rd !== null && rd !== 0 && Math.abs(rd) > T.READ_ABS;
      if (r.u === null && !_bfProvenZeroUsage(b, c, r.cost) && (evidenceCharge || evidenceRead))
        add(
          b,
          'usage_missing',
          'Usage is blank (not 0), but the bill shows ' +
            (evidenceCharge ? 'a charge of ' + _bfMoney(vc) : 'a meter read difference of ' + _bfFmt(rd, 2)) +
            '. Flag when usage is blank and a charge or a read difference shows use.',
          'usage',
        );
      if (r.u !== null && r.u < 0)
        add(b, 'usage_negative', 'Usage is negative (' + _bfFmt(r.u) + ' ' + _bfUnit(c) + ').', 'usage');
      if (r.u === 0 && minCharge && vc > minCharge * T.ZERO_CHARGE_MULT)
        add(
          b,
          'usage_missing',
          'Usage is 0, but the charge is ' +
            _bfMoney(vc) +
            ', more than ' +
            T.ZERO_CHARGE_MULT +
            "x this meter's smallest usual bill (" +
            _bfMoney(minCharge) +
            ').',
          'usage',
        );
    }
    if (r.cost === null) add(b, 'cost_missing', 'Total cost is blank.', 'totalCost');
    if (parity[b.id]) add(b, 'water_sewer_parity', parity[b.id], 'usage');

    later.push(() => {
      if (!(r.u !== null && r.u >= 0 && r.days > 0 && r.nm >= 0 && medUperDay)) return;
      const peers = rows.filter(
        (p, j) =>
          p !== r &&
          p.nm === r.nm &&
          p.u !== null &&
          p.days > 0 &&
          p.yr !== r.yr &&
          !untrusted(p) &&
          (!medDays || (p.days >= T.PERIOD_LO * medDays && p.days <= T.PERIOD_HI * medDays)),
      );
      if (peers.length < T.USAGE_MIN_PEERS) return;
      const mp = _bfMedian(peers.map((p) => p.u / p.days));
      const me = r.u / r.days;
      const material = Math.max(me, mp) >= T.MATERIAL_FRAC * p90UperDay;
      if (!material) return;
      const mname = _BF_MONTHS_LONG[r.nm];
      const list = peers.map((p) => p.yr + ': ' + _bfFmt(p.u) + ' in ' + p.days + ' days').join(', ');
      if (mp > 0) {
        const ratio = me / mp;
        const need = peers.length >= 2 ? T.USAGE_MULT : T.USAGE_MULT_ONE_PEER;
        if (ratio >= need || ratio <= 1 / need)
          add(
            b,
            'usage_vs_same_month',
            _bfMonthLabel(r.cm) +
              ' ' +
              _bfUnit(c) +
              ' ' +
              _bfFmt(r.u) +
              ' (' +
              r.days +
              ' days) is ' +
              (ratio >= 1 ? _bfFmt(ratio) + 'x higher' : _bfFmt(1 / ratio) + 'x lower') +
              ' per day than the other ' +
              mname +
              's (' +
              list +
              '). Flag at ' +
              need +
              'x or more (' +
              (peers.length >= 2 ? 'two or more other years' : 'only one other year') +
              ' to compare).',
            'usage',
          );
      } else if (me > 0)
        add(
          b,
          'usage_vs_same_month',
          _bfMonthLabel(r.cm) +
            ' ' +
            _bfUnit(c) +
            ' ' +
            _bfFmt(r.u) +
            ' where the other ' +
            mname +
            's were 0 (' +
            list +
            ').',
          'usage',
        );
    });

    if (medRateTot && r.u !== null && r.u >= 0 && r.cost !== null && r.cost > 0) {
      const expected = Math.max(r.u * medRateTot, minCharge);
      const ratio = _bfCostBasis(b, r.cost) / expected;
      if (ratio >= T.RATE_MULT || ratio <= 1 / T.RATE_MULT)
        add(
          b,
          'charge_vs_usage',
          'The charge ' +
            _bfMoney(r.cost) +
            ' for ' +
            _bfFmt(r.u) +
            ' ' +
            _bfUnit(c) +
            ' is ' +
            (ratio >= 1 ? _bfFmt(ratio) + 'x higher' : _bfFmt(1 / ratio) + 'x lower') +
            ' than expected. This meter usually pays ' +
            medRateTot.toFixed(4) +
            ' per ' +
            _bfUnit(c) +
            ' (or its smallest usual bill ' +
            _bfMoney(minCharge) +
            ', whichever is more), which gives about ' +
            _bfMoney(expected) +
            '. Flag at ' +
            T.RATE_MULT +
            'x or more.',
          'totalCost',
        );
    }
    // Usage x the meter's usual own rate must match the bill's own usage charge (getBillUsageCharge, getStoredRate).
    if (medOwnRate && ownRates.has(r) && !perBill[b.id]?.some((f) => f.rule === 'charge_vs_usage')) {
      const charge = getBillUsageCharge(b, _rateKey);
      // the meter's usual minimum bill is a floor: fixed fees on a small bill are not a mismatch
      const expected = Math.max(medOwnRate * r.u, minCharge);
      const ratio = charge / expected;
      if (ratio >= T.USAGE_CHARGE_MULT || ratio <= 1 / T.USAGE_CHARGE_MULT) {
        add(
          b,
          'usage_charge_mismatch',
          'Usage does not match charge: ' +
            _bfFmt(r.u, 0) +
            ' ' +
            _bfUnit(c) +
            " at this meter's usual " +
            medOwnRate.toFixed(4) +
            ' per ' +
            _bfUnit(c) +
            ' (or its smallest usual bill ' +
            _bfMoney(minCharge) +
            ', whichever is more) would cost about ' +
            _bfMoney(expected) +
            ', but the bill charges ' +
            _bfMoney(charge) +
            ' (' +
            (ratio >= 1 ? _bfFmt(ratio) + 'x higher' : _bfFmt(1 / ratio) + 'x lower') +
            '). Flag at ' +
            T.USAGE_CHARGE_MULT +
            'x or more.',
          'usage',
        );
      }
    }
    if (Array.isArray(b._flags) && b._flags.some((f) => f.id === FAC_KW_MISSING_STORED_ID && !f.dismissed)) {
      const f = b._flags.find((x) => x.id === FAC_KW_MISSING_STORED_ID && !x.dismissed);
      add(b, 'fac_kw_missing', f.label || 'Facilities kW is missing on this bill.', 'facKW');
    }
  });
  later.forEach((fn) => fn());

  // start read vs the previous bill's end read (either read direction)
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].b,
      b = rows[i].b;
    const ae = num(a.endRead),
      as = num(a.startRead),
      bs = num(b.startRead),
      be = num(b.endRead);
    if (ae === null || bs === null || as === null || be === null) continue;
    const fwd = Math.abs(ae - bs),
      rev = Math.abs(as - be);
    const tol = Math.max(T.READ_CONTINUITY_ABS, T.READ_CONTINUITY_REL * Math.abs(ae));
    if (fwd > tol && rev > tol && a.end && b.start && calcDays(a.end, b.start, false) <= T.GAP_DAYS)
      add(
        b,
        'read_continuity',
        "This bill's start read " +
          _bfFmt(bs, 2) +
          " does not match the previous bill's (" +
          _bfPeriod(a) +
          ') end read ' +
          _bfFmt(ae, 2) +
          ' (difference ' +
          _bfFmt(Math.min(fwd, rev), 2) +
          '). Flag at more than ' +
          T.READ_CONTINUITY_REL * 100 +
          '% or ' +
          T.READ_CONTINUITY_ABS +
          ' unit.',
        'startRead',
      );
  }

  // Dismissed flags (stored on the bill by rule id) are removed. Dismissing one flag never hides another.
  const billsById = {};
  rows.forEach((r) => (billsById[r.b.id] = r.b));
  Object.keys(perBill).forEach((id) => {
    const dismissed = new Set(
      (Array.isArray(billsById[id]._flags) ? billsById[id]._flags : []).filter((f) => f.dismissed).map((f) => f.id),
    );
    perBill[id] = perBill[id].filter((f) => !dismissed.has(f.dismissId));
    if (!perBill[id].length) delete perBill[id];
  });
  const ids = Object.keys(perBill);
  return {
    flaggedBills: ids.length,
    flagCount: ids.reduce((s, k) => s + perBill[k].length, 0),
    perBill,
  };
}

// The only loop over a building's meters.
function computeBuildingFlagSummary(building) {
  const out = { flaggedBills: 0, flagCount: 0, byMeter: {} };
  (building.meters || []).forEach((m) => {
    const s = computeMeterFlagSummary(m, building);
    out.byMeter[m.id] = s;
    out.flaggedBills += s.flaggedBills;
    out.flagCount += s.flagCount;
  });
  return out;
}
// Text for the hover on every badge and pill. The number shown is flagged BILLS; flags only appear here.
function billFlagHoverText(summary) {
  return (
    summary.flaggedBills +
    ' bill' +
    (summary.flaggedBills === 1 ? '' : 's') +
    ' flagged for review (' +
    summary.flagCount +
    ' flag' +
    (summary.flagCount === 1 ? '' : 's') +
    ')'
  );
}
