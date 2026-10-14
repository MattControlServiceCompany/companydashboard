// computations/bill-flags.js - the ONE bill-flag engine (pure, no DOM).
//
// computeMeterFlagSummary(meter, building) -> { flaggedBills, flagCount, perBill, countedPerBill }
//   perBill = every flag; countedPerBill / flaggedBills / flagCount = only BILL_COUNTED_FLAG_RULES.
// computeBuildingFlagSummary(building, isExcluded) -> { flaggedBills, flagCount, byMeter, firstFlaggedMeterId }
// computeProjectFlagSummary(buildings, isExcluded) -> { flaggedBills, flagCount, byBuilding, firstFlagged }
//   isExcluded(meter): a baseline-excluded meter adds nothing to the building or project count.
//
// Every flag count on the site calls these: the Bills tab banner, the meter pill, the building badge,
// the Review Bill Corrections panel and the data-quality score. A flag means "look at this bill":
// a billing error or a big usage change. Normal weather and normal rate changes never flag.
//
// Shared helpers used (never copied here): calcDays and fmtDate (app/utility-data.js), billMonth and
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
  printed_read_mismatch: { label: 'Usage', severity: 'warn' },
  usage_missing: { label: 'Usage', severity: 'warn' },
  usage_negative: { label: 'Usage', severity: 'warn' },
  cost_missing: { label: 'Total Cost', severity: 'warn' },
  charge_vs_usage: { label: 'Total Cost', severity: 'warn' },
  usage_charge_mismatch: { label: 'Usage', severity: 'warn' },
  water_sewer_parity: { label: 'Usage', severity: 'warn' },
  usage_vs_same_month: { label: 'Usage', severity: 'warn' },
  fac_kw_missing: { label: 'Facilities kW', severity: 'warn' },
};
// The ONE list of flag types that are counted (sidebar, building row, meter pill, Bills banner). A type is here only when
// the problem changes usage, kW, cost, billing dates or a missing bill, or the baseline rate (charge_vs_usage and
// usage_charge_mismatch drop the bill from the baseline rates). Left out: usage_vs_same_month and water_sewer_parity
// (statistical), days_mismatch, cost_field_mismatch (dead copy of a gas field) and the read notes read_continuity,
// read_rollback and read_usage_mismatch. A left-out flag still shows in that bill row's own hover. printed_read_mismatch is
// counted: the rule emits it only when the kWh was computed from reads that disagree (the usage is in doubt).
const BILL_COUNTED_FLAG_RULES = [
  'dates_missing',
  'period_length',
  'period_overlap',
  'period_gap',
  'duplicate_bill',
  'charge_sum_mismatch',
  'printed_read_mismatch',
  'usage_missing',
  'usage_negative',
  'cost_missing',
  'charge_vs_usage',
  'usage_charge_mismatch',
  'fac_kw_missing',
];
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
// Month index 0-11 and year of a bill from the ONE month rule (billMonth chain across the meter's bills).
function _bfChainMonth(b, incl, sortedAll) {
  if (!b.start || !b.end) return null;
  const ym = billMonth(b, sortedAll);
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

// Cache of the summaries, one entry per meter object. An entry is used only when the signature of everything the
// summary reads is unchanged: the meter's commodity, inclusive flag and bills (every field, dismissed flags too), and
// for water and sewer the bills of the partner meters in the same building. So a cached count can never differ from a
// fresh one, and no bill write path needs to clear it. Callers must not change the returned object.
const _bfSummaryCache = new WeakMap();
function _bfMeterSignature(meter, building) {
  let sig = JSON.stringify([meter.commodity, meter.inclusive, meter.bills || []]);
  if ((meter.commodity === 'Water' || meter.commodity === 'Sewer') && building) {
    (building.meters || []).forEach((x) => {
      if (x !== meter && (x.commodity === 'Water' || x.commodity === 'Sewer')) {
        sig += '|' + JSON.stringify([x.commodity, x.inclusive, x.bills || []]);
      }
    });
  }
  return sig;
}
function computeMeterFlagSummary(meter, building) {
  if (!meter || typeof meter !== 'object') return _computeMeterFlagSummaryFresh(meter, building);
  const sig = _bfMeterSignature(meter, building);
  const hit = _bfSummaryCache.get(meter);
  if (hit && hit.sig === sig) return hit.summary;
  const summary = _computeMeterFlagSummaryFresh(meter, building);
  _bfSummaryCache.set(meter, { sig, summary });
  return summary;
}
function _computeMeterFlagSummaryFresh(meter, building) {
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
    if (c === 'Electric' && b._printedReadCheck && b._printedReadCheck.kwhComputed) {
      // The ONLY visible flag from the printed read check: the PDF printed no kWh, the kWh was computed from the reads,
      // and the printed read difference disagrees with those reads, so the usage itself is in doubt. Every other
      // mismatch stays data on the bill (b._printedReadCheck) and shows no warning. The check runs again on the
      // stored values, so a corrected or edited read clears the flag.
      const hit = computePrintedReadMismatch({
        start: b.startRead,
        end: b.endRead,
        diff: b.readDifference,
        mult: b.meterMultiplier,
        usage: null,
      }).find((m) => m.field === 'readDifference');
      if (hit)
        add(
          b,
          'printed_read_mismatch',
          hit.message + ' The bill printed no kWh, so the kWh shown was computed from the reads and may be wrong.',
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
  // perBill keeps EVERY flag (the bill row's own hover and dots). The counts and the banner use only the counted types.
  const countedPerBill = {};
  Object.keys(perBill).forEach((id) => {
    const hit = perBill[id].filter((f) => BILL_COUNTED_FLAG_RULES.includes(f.rule));
    if (hit.length) countedPerBill[id] = hit;
  });
  const ids = Object.keys(countedPerBill);
  return {
    flaggedBills: ids.length,
    flagCount: ids.reduce((s, k) => s + countedPerBill[k].length, 0),
    perBill,
    countedPerBill,
  };
}

// The only loop over a building's meters.
// isExcluded(meter) -> true for a meter left out of the baseline (the caller passes isBaselineExcluded for its project);
// such a meter adds nothing to the building or project count. byMeter still holds its own summary.
function computeBuildingFlagSummary(building, isExcluded) {
  const out = { flaggedBills: 0, flagCount: 0, byMeter: {}, firstFlaggedMeterId: null };
  (building.meters || []).forEach((m) => {
    if (typeof isExcluded === 'function' && isExcluded(m)) return;
    const s = computeMeterFlagSummary(m, building);
    out.byMeter[m.id] = s;
    out.flaggedBills += s.flaggedBills;
    out.flagCount += s.flagCount;
    if (out.firstFlaggedMeterId === null && s.flaggedBills > 0) out.firstFlaggedMeterId = m.id;
  });
  return out;
}
// The only loop over a project's buildings. Sums computeBuildingFlagSummary, so the project badge, the building badge,
// the meter pill and the Bills banner always agree. firstFlagged = { bldgId, meterId } of the first flagged meter.
function computeProjectFlagSummary(buildings, isExcluded) {
  const out = { flaggedBills: 0, flagCount: 0, byBuilding: {}, firstFlagged: null };
  (buildings || []).forEach((b) => {
    const s = computeBuildingFlagSummary(b, isExcluded);
    out.byBuilding[b.id] = s;
    out.flaggedBills += s.flaggedBills;
    out.flagCount += s.flagCount;
    if (out.firstFlagged === null && s.firstFlaggedMeterId !== null)
      out.firstFlagged = { bldgId: b.id, meterId: s.firstFlaggedMeterId };
  });
  return out;
}
// The flag rules that say a bill's usage and its charge do not belong together (charge_vs_usage: total vs usage x the
// meter's usual rate; usage_charge_mismatch: water and sewer usage charge vs usage). A bill carrying one of them (not
// dismissed) gives a $/unit that is not a price, so the baseline rates leave it out. Thresholds stay in
// BILL_FLAG_THRESHOLDS (RATE_MULT, USAGE_CHARGE_MULT); nothing is copied from them.
const BILL_RATE_EXCLUDE_RULES = ['charge_vs_usage', 'usage_charge_mismatch'];
// computeMeterRateExclusions(meter, building) -> { [billId]: [{ rule, message }] } for the bills computeMeterFlagSummary
// flags with a BILL_RATE_EXCLUDE_RULES rule. The ONE predicate "is this bill left out of the baseline rates".
// Caller: computeSeasonalBldgRates (computations/rates.js). Bill data is never changed.
function computeMeterRateExclusions(meter, building) {
  const perBill = computeMeterFlagSummary(meter, building).perBill;
  const out = {};
  Object.keys(perBill).forEach((id) => {
    const hit = perBill[id].filter((f) => BILL_RATE_EXCLUDE_RULES.includes(f.rule));
    if (hit.length) out[id] = hit.map((f) => ({ rule: f.rule, message: f.message }));
  });
  return out;
}
// Text for the hover on every flag badge and pill. The number shown is counted BILLS (BILL_COUNTED_FLAG_RULES).
function billFlagHoverText(summary) {
  return (
    summary.flaggedBills +
    (summary.flaggedBills === 1 ? ' bill with a problem that changes' : ' bills with problems that change') +
    ' usage, cost or dates'
  );
}
// The ONE plain-language reason list for a bill's flags (one string per flag, dismissed flags are already removed).
// The Bills table row hover and the flag banner both call it. Callers must escape the text before putting it in HTML.
function billFlagReasonList(flags) {
  return (flags || []).map((f) => f.message);
}
/* PRINTED READ CHECK (2026-10-14). The ONE rule that compares the bill's printed read difference and printed usage with
   their own arithmetic. The PDF reader no longer rewrites a printed read difference to end read - start read or a
   printed kWh to read difference x multiplier (app/bill-analysis.js): the arithmetic is a CHECK, not a replacement,
   so a misread start or end read cannot make a bad bill look consistent. A value that was absent on the PDF is still
   computed by the reader, so it agrees with its inputs and never reports.
   A mismatch is DATA on the bill (b._printedReadCheck, written by readCorrectionMarkers), not a warning. The one visible
   flag (rule printed_read_mismatch) is a bill with NO printed kWh whose computed kWh rests on reads that disagree with
   the printed read difference: only then is the usage itself in doubt.
   Tolerance is the print precision. Reads and the difference each print rounded to their last digit, so end - start may
   differ from the difference by ONE unit of the coarsest of those digits (the same unit computeReadCorrection uses).
   The usage may differ from difference x multiplier by half a unit of the usage's last digit plus half a unit of the
   difference's last digit times the multiplier (the rounding of the difference, scaled).
   x = { start, end, diff, mult, usage } (raw text or numbers; null or '' when absent; usage null skips the kWh check).
   Returns [{ field: 'readDifference' | 'usage', message }]. A rollover (end under start) is never checked here. */
function computePrintedReadMismatch(x) {
  const n = parseBillNumber;
  const S = n(x.start),
    E = n(x.end),
    D = n(x.diff),
    M = n(x.mult),
    U = n(x.usage);
  const EPS = 1e-6; // floating-point slack only
  const out = [];
  const dDec = _rcDecimals(x.diff);
  if (S !== null && E !== null && D !== null && E >= S) {
    const tol = Math.pow(10, -Math.min(_rcDecimals(x.start), _rcDecimals(x.end), dDec)) + EPS;
    if (Math.abs(E - S - D) > tol)
      out.push({
        field: 'readDifference',
        message:
          'Printed read difference does not match end minus start read: the bill prints ' +
          _rcText(x.diff) +
          ', but end read ' +
          _rcText(x.end) +
          ' minus start read ' +
          _rcText(x.start) +
          ' is ' +
          (E - S).toFixed(Math.max(_rcDecimals(x.start), _rcDecimals(x.end))) +
          '. A start read or end read may be misread.',
      });
  }
  if (D !== null && M !== null && M > 0 && U !== null) {
    const tol = 0.5 * Math.pow(10, -Math.min(_rcDecimals(x.usage), 4)) + 0.5 * Math.pow(10, -dDec) * M + EPS;
    if (Math.abs(D * M - U) > tol)
      out.push({
        field: 'usage',
        message:
          'Printed kWh does not match read difference times multiplier: the bill prints ' +
          _rcText(x.usage) +
          ' kWh, but ' +
          _rcText(x.diff) +
          ' x ' +
          _rcText(x.mult) +
          ' is ' +
          (D * M).toFixed(Math.min(_rcDecimals(x.usage), 4)) +
          '. The read difference or the kWh may be misread.',
      });
  }
  return out;
}
/* ── READ-CHAIN CORRECTION (2026-10-14) ───────────────────────────────────────────────────────────
   The ONE rule that repairs a start read, end read or read difference the PDF reader misread, using the meter
   chain (the previous bill's end read E_prev, the next bill's start read N) and the bill's own usage U. Callers:
     - correctMeterReadChain(meter)       stored bills (bill loader, app/utility-data.js loadUtilityData, every meter)
     - correctExtractedReadChain(bills)   PDF extraction output (app/bill-analysis.js, read-chain step)
   Both reach computeReadCorrection. The read_continuity flag above is not changed: a bill this rule
   repairs now matches its chain, so it no longer flags. A bill this rule declines keeps its flag.

   EVIDENCE PRINCIPLE. A value is evidence only when the check that confirms it would FAIL for every 1- or 2-digit
   misread of that value. A check whose tolerance is wider than one step of the value's last printed digit cannot
   tell the value from a misread of itself, so it proves nothing. Two earlier versions broke this: a tolerance on
   D x M = U wider than one misread step of D made a misread D "trusted", and the rule then rewrote a CORRECT end read.
     - Reads compare to the printed digit, within ONE unit of the coarsest last printed digit (print rounding can make
       two printed values that should agree differ by one unit): S = E_prev confirms S; E = N confirms E; E - S = D.
       The read_continuity tolerance (1 unit or 0.1 percent) is NOT used here: it is wider than a misread step.
       A change of one unit is never made: one unit is print rounding, not evidence of a misread.
     - A read difference printed coarser than the reads is never evidence (nothing is corrected).
     - D is trusted (D x M = U is evidence for D) only when BOTH hold:
         |D x M - U| <= half a unit of U's last printed digit        (the printed usage agrees with D)
         |D x M - U| + half a unit of U < (one unit of D's last printed digit) x M
       The second line says: a D one step away would already fail the first line, so every misread of D fails it.
       Example that fails: reads to 4 decimals, multiplier 1, usage printed in whole kWh. Half a kWh covers 5,000
       misread steps of D, so D is not evidence and only rules that do not use D may run.
   Cases (S, E, D are the bill's own values; "exact" means equal to the printed digit):
     D trusted:
       a  S != E_prev, E - S = D exact: both reads off by the same amount.
          With the next bill: N = E_prev + D exact -> start = E_prev, end = E_prev + D.
          Without the next bill (the newest bill, where a fresh reader error always lands) -> a0, PROVISIONAL. The
          same corrections as a, when ALL of these hold:
            - S - E_prev and E - (E_prev + D) are the IDENTICAL offset (no print rounding between them), each read is
              a 1- or 2-digit misread of its chain value, and the offset is larger than print rounding;
            - S >= 10 x D and D > 0: a replaced meter starts near zero, so a start read that small is never changed;
            - the previous bill is itself clean: E_prev - S_prev = D_prev exact and D_prev is proven by its own usage;
            - the OTHER explanation is impossible. The chain break could also mean the PREVIOUS bill's end read is the
              misread and this bill is right. The PDF reader makes a bill with a misread end read look clean (it
              rewrites D = E - S and U = D x M), so that explanation cannot be ruled out by consistency. It can be
              ruled out by physics: it would give the previous bill a read difference of D_prev + (S - E_prev). When
              that is zero or negative the previous meter would have run backwards, so this bill IS the misread one.
              Hence a0 needs S < S_prev (this start read below the previous bill's START read). A shift upward, or a
              shift smaller than the previous bill's read difference, waits for the next bill.
       b  S != E_prev, E - E_prev = D exact: only the start is wrong      -> start = E_prev   (N, if present, = E)
       c  S = E_prev exact, E - S != D, N = S + D exact: only the end is wrong -> end = S + D. NEEDS the next bill.
     D not trusted (U cannot tell a misread D from the printed one):
       d  S = E_prev exact, N = E exact, E - S != D: the reads are pinned by both neighbors, so the READ DIFFERENCE is
          the misread -> difference = E - S. (E - S) x M must still agree with U within half a usage unit.
          NEEDS the next bill.
     Any other mix (two fields could be wrong, or the data cannot tell which): nothing changes, the flag stays.
     A missed correction is acceptable; a wrong one is not.
   D AND U ARE NOT INDEPENDENT. The stored usage can be the read difference times the multiplier (a misread can store
   D and U both misread, consistently: D x M = U to the digit while the PDF printed another D and another U). So
   "D x M = U" cannot decide E against D or D against E on its own: a change of the END READ (c) or of the READ
   DIFFERENCE (d) needs evidence from OUTSIDE this bill's D/U pair, and the only such evidence is the next bill's start
   read. Without it, c and d decline. The separately printed on-peak and off-peak kWh are NOT evidence: on actual bills
   their sum differs from the billed kWh by up to about 0.8 kWh, while one D-step is 0.016 kWh at multiplier 160.
   Case a is not in this trap: the reads, not D, are in question, and E - S = D ties the two reads to D with S != E_prev.
   SELF-CHECK of a provisional correction (a0; the reason text names it): on every walk, when the bill now has a
   linked next bill whose start read is present, that start read must equal the bill's corrected end read. If it
   does, the correction stays and its records become rule-a records. If it does not, the bill goes back to the reader
   values kept in the _auto_corrected_ records, the records are removed, and the read_continuity flag is on again
   (_rcRevertProvisional).
   What the data cannot tell: a replaced meter whose new reads are within 2 digits of the chain values AND start at ten
   read differences or more (a refurbished meter). tools/gate-read-chain-correction.js counts those coincidences; the
   self-check undoes any of them as soon as the next bill arrives.
   Guard: a value changes only when the new and old text have the same length and differ in at most 2
   characters (an OCR digit misread). A meter change, a rollover or a big jump never matches, so it keeps its flag.
   User wins: a bill with a field whose correction record holds a value other than the field's current value
   (the user typed a new one) is skipped, and editing a corrected field clears its record (clearReadCorrectionRecords).
   The original text is kept on the bill in the existing correction record _auto_corrected_<field>
   = { original, corrected, reason } (startRead / endRead / readDifference on stored bills, StartRead / EndRead /
   ReadDifference on extracted bills; the extraction screen already shows those records).
   Proof: tools/gate-read-chain-correction.js runs every 1- and 2-digit substitution of every field over multipliers,
   read precisions and usage precisions, and asserts a correct field is never changed and a changed field is right. */
const READ_CHAIN_FIELDS = {
  stored: {
    start: 'startRead',
    end: 'endRead',
    diff: 'readDifference',
    mult: 'meterMultiplier',
  },
  pdf: {
    start: 'StartRead',
    end: 'EndRead',
    diff: 'ReadDifference',
    mult: 'MeterMultiplier',
  },
};
function _rcText(v) {
  return v === null || v === undefined ? '' : String(v).replace(/[,\s]/g, '');
}
function _rcDecimals(v) {
  const p = _rcText(v).split('.');
  return p.length > 1 ? p[1].length : 0;
}
// OCR digit misread: same length, differs in 1 or 2 positions.
function _rcIsMisread(oldV, newV) {
  const a = _rcText(oldV),
    b = _rcText(newV);
  if (!a || a.length !== b.length || a === b) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff >= 1 && diff <= 2;
}
// x = { prevEnd, start, end, diff, mult, usage, nextStart } (raw text or numbers; null or '' when absent).
// Returns null (nothing to correct, or not safe) or { rule: 'a'|'b'|'c'|'d', start?, end?, diff?: text }.
// Evidence for a read difference d (text) from a usage u (text) at multiplier m: the usage agrees with d within half a
// unit of the usage's last printed digit AND a d one step of its own last digit away would already disagree. Only then
// does "d x m = u" prove d; a wider check cannot tell d from a misread of itself.
function _rcUsageProves(dText, mText, uText) {
  const D = parseBillNumber(dText),
    M = parseBillNumber(mText),
    U = parseBillNumber(uText);
  if (D === null || M === null || U === null || M === 0) return false;
  const EPS = 1e-6;
  const dUnit = Math.pow(10, -_rcDecimals(dText));
  const uHalf = 0.5 * Math.pow(10, -Math.min(_rcDecimals(uText), 4));
  const resid = Math.abs(D * M - U);
  return resid <= uHalf + EPS && resid + uHalf + EPS < dUnit * Math.abs(M);
}
// x = { prevEnd, start, end, diff, mult, usage, nextStart, prevStart, prevDiff, prevMult, prevUsage } (raw text or
// numbers; null or '' when absent; the prev* fields other than prevEnd are needed only by a0).
// Returns null (nothing to correct, or not safe) or { rule: 'a'|'a0'|'b'|'c'|'d', start?, end?, diff?: text }.
function computeReadCorrection(x) {
  const n = parseBillNumber;
  const Ep = n(x.prevEnd),
    S = n(x.start),
    E = n(x.end),
    D = n(x.diff),
    M = n(x.mult),
    U = n(x.usage),
    Nx = n(x.nextStart);
  if ([Ep, S, E, D, M, U].some((v) => v === null) || M === 0) return null;
  const EPS = 1e-6; // floating-point slack only
  const sDec = _rcDecimals(x.start),
    eDec = _rcDecimals(x.end),
    dDec = _rcDecimals(x.diff);
  if (dDec < Math.max(sDec, eDec)) return null; // a coarser difference cannot pin a read
  // Print rounding: a utility prints each read rounded to its last digit, so two printed values that should agree may
  // differ by ONE unit of that digit (end - start vs difference; this start vs the previous end). One unit is therefore
  // not evidence of a misread: reads compare within one unit of the coarsest printed digit, and a correction must move a
  // field by MORE than that. A misread of one unit is never corrected (declined); larger misreads break exactly one check.
  const tol = Math.pow(10, -Math.min(sDec, eDec, dDec, _rcDecimals(x.prevEnd))) + EPS;
  const eq = (a, b) => Math.abs(a - b) <= tol;
  const uHalf = 0.5 * Math.pow(10, -Math.min(_rcDecimals(x.usage), 4)); // half a unit of U's last printed digit
  const usageAgrees = (d) => Math.abs(d * M - U) <= uHalf + EPS;
  const diffTrusted = _rcUsageProves(x.diff, x.mult, x.usage);
  const startMatches = eq(S, Ep);
  const spanOk = eq(E - S, D);
  let rule = null,
    newStart = null,
    newEnd = null,
    newDiff = null,
    endNum = E;
  if (diffTrusted) {
    if (!startMatches && spanOk) {
      // a: both reads off by the same amount; the next bill tells this from a real jump
      if (Nx !== null) {
        if (!eq(Nx, Ep + D)) return null;
        rule = 'a';
      } else {
        // a0 (no next bill, provisional): see the block comment
        if (Math.abs(E - S - D) > EPS) return null; // identical offset in both reads
        if (!(D > 0) || S < 10 * D) return null; // a start read this small looks like a replaced meter
        const Sp = n(x.prevStart),
          Dp = n(x.prevDiff);
        if (Sp === null || Dp === null) return null;
        if (!eq(Ep - Sp, Dp) || !_rcUsageProves(x.prevDiff, x.prevMult, x.prevUsage)) return null; // previous bill clean
        if (S >= Sp - tol) return null; // the previous bill's end could be the misread instead: wait for the next bill
        rule = 'a0';
      }
      newStart = _rcText(x.prevEnd);
      endNum = Ep + D;
      newEnd = endNum.toFixed(eDec);
    } else if (!startMatches && eq(E - Ep, D)) {
      if (Nx !== null && !eq(Nx, E)) return null;
      rule = 'b';
      newStart = _rcText(x.prevEnd);
    } else if (startMatches && !spanOk) {
      // c: only the end is wrong. D x M = U alone cannot decide E against D (D and U can be jointly wrong), so the
      // next bill must start at S + D
      if (Nx === null) return null;
      rule = 'c';
      endNum = S + D;
      newEnd = endNum.toFixed(eDec);
    }
  } else if (startMatches && !spanOk && Nx !== null && eq(Nx, E)) {
    // d: both reads are pinned by the neighbors, so the difference is the misread
    const d2 = E - S;
    if (!usageAgrees(d2)) return null;
    rule = 'd';
    newDiff = d2.toFixed(dDec);
  }
  if (!rule) return null;
  if (newStart !== null && !_rcIsMisread(x.start, newStart)) return null;
  if (newEnd !== null && !_rcIsMisread(x.end, newEnd)) return null;
  if (newDiff !== null && !_rcIsMisread(x.diff, newDiff)) return null;
  // the next bill, when present, must start where the corrected end read is
  if (newEnd !== null && Nx !== null && !eq(Nx, endNum)) return null;
  // every change must be larger than print rounding (one unit of the last printed digit)
  if (newStart !== null && Math.abs(n(newStart) - S) <= tol) return null;
  if (newEnd !== null && Math.abs(n(newEnd) - E) <= tol) return null;
  if (newDiff !== null && Math.abs(n(newDiff) - D) <= tol) return null;
  const out = { rule };
  if (newStart !== null) out.start = newStart;
  if (newEnd !== null) out.end = newEnd;
  if (newDiff !== null) out.diff = newDiff;
  return out;
}
const READ_CHAIN_REASON = {
  a: "The PDF reader's start read and end read were both off by the same amount, and the next bill starts at the corrected end read. Start read set to the previous bill's end read; end read set to start read + read difference.",
  a0: "The PDF reader's start read and end read were both off by the same amount (a 1- or 2-digit misread in each), the usage proves the read difference, and the previous bill's reads cannot be the error (its meter would have run backwards). No later bill exists yet. Start read set to the previous bill's end read; end read set to start read + read difference. If the next bill does not start at this end read, the reader values come back.",
  b: "The PDF reader's start read did not match the previous bill's end read. End read minus the previous end read equals the read difference, so start read was set to the previous bill's end read.",
  c: "The PDF reader's end read minus start read did not equal the read difference, while the usage agrees with the read difference and the next bill starts at start read + read difference. End read set to start read + read difference.",
  d: "The PDF reader's read difference did not equal end read minus start read, while the start read matches the previous bill's end read and the next bill starts at this end read. Read difference set to end read minus start read.",
};
const READ_CHAIN_PROVISIONAL = [READ_CHAIN_REASON.a0];
function _rcIsReadChainRecord(rec) {
  return !!rec && Object.values(READ_CHAIN_REASON).includes(rec.reason);
}
// True when the user owns a read field of this bill: they typed a new value into a field this rule corrected (the
// record's corrected value no longer matches), or an edit path already stamped the field in _userCorrected. User wins:
// the rule leaves the whole bill alone.
function _rcUserEdited(bill, keys) {
  return [keys.start, keys.end, keys.diff].some((k) => {
    const rec = bill['_auto_corrected_' + k];
    if (bill._userCorrected && bill._userCorrected[k]) return true;
    return _rcIsReadChainRecord(rec) && _rcText(rec.corrected) !== _rcText(bill[k]);
  });
}
// Called by every bill edit path: an edited field is the user's value. Its auto-correction record goes and the field is
// stamped in _userCorrected (the existing "user changed this" record), so the rule never overwrites it on a later load.
// Editing ANY read field of a bill clears and stamps ALL of that bill's read-correction records together: the user now
// owns the bill's reads, so no other record (e.g. a provisional a0 record on the field not edited) stays behind.
function clearReadCorrectionRecords(row, fields) {
  if (row && (!fields || fields.includes('kwh'))) delete row._printedReadCheck; // an edited kWh is no longer computed
  const READ = ['startRead', 'endRead', 'readDifference'];
  if (fields && !fields.some((k) => READ.includes(k))) return; // only non-read fields were edited
  READ.forEach((k) => {
    const rec = row && row['_auto_corrected_' + k];
    if (!_rcIsReadChainRecord(rec)) return;
    delete row['_auto_corrected_' + k];
    if (!row._userCorrected) row._userCorrected = {};
    if (!row._userCorrected[k])
      row._userCorrected[k] = { original: rec.corrected, at: new Date().toISOString(), source: 'read_chain_user_edit' };
  });
}
// Apply one correction to a bill and keep the original in the existing record.
function _rcApply(bill, keys, fix) {
  const set = (k, v) => {
    if (v === undefined) return;
    const prior = bill['_auto_corrected_' + k];
    bill['_auto_corrected_' + k] = {
      original: _rcIsReadChainRecord(prior) ? prior.original : bill[k],
      corrected: v,
      reason: READ_CHAIN_REASON[fix.rule],
    };
    bill[k] = v;
  };
  set(keys.start, fix.start);
  set(keys.end, fix.end);
  set(keys.diff, fix.diff);
}
// Self-check of a provisional correction (a0) once the next bill's start read N is present: N must equal the
// bill's corrected end read. If it does, the records become plain rule-a records (the next bill now confirms them).
// If it does not, the reader values come back from the records, the records go, and the read_continuity flag is on
// again. Returns true when the bill changed.
function _rcRevertProvisional(bill, keys, nextStart) {
  const Nx = parseBillNumber(nextStart);
  if (Nx === null) return false;
  const recs = [keys.start, keys.end, keys.diff]
    .map((k) => ({ k, rec: bill['_auto_corrected_' + k] }))
    .filter((r) => r.rec && READ_CHAIN_PROVISIONAL.includes(r.rec.reason));
  if (!recs.length) return false;
  const E = parseBillNumber(bill[keys.end]);
  const tol = Math.pow(10, -Math.min(_rcDecimals(bill[keys.end]), _rcDecimals(nextStart))) + 1e-6;
  if (E !== null && Math.abs(Nx - E) <= tol) {
    recs.forEach((r) => (r.rec.reason = READ_CHAIN_REASON.a)); // confirmed: same correction as rule a
    return true;
  }
  recs.forEach((r) => {
    bill[r.k] = r.rec.original;
    delete bill['_auto_corrected_' + r.k];
  });
  return true;
}
// Walk bills in chain order. getUsage(bill) -> usage; link(prev, cur) -> true when cur follows prev in the chain.
// Fast path: a bill with no read-correction record whose start read equals the previous end read and whose end - start
// equals its read difference (all within print rounding, the same tolerance computeReadCorrection uses) cannot need a
// correction: every rule in computeReadCorrection needs the start read or the span to be off. Reads are parsed once per
// bill per walk (cache), so a clean chain costs one parse of each read, not a full evaluation of every bill.
function _rcReads(bill, keys, cache, i) {
  let r = cache[i];
  if (r === undefined) {
    r = cache[i] = {
      S: parseBillNumber(bill[keys.start]),
      E: parseBillNumber(bill[keys.end]),
      D: parseBillNumber(bill[keys.diff]),
      sd: _rcDecimals(bill[keys.start]),
      ed: _rcDecimals(bill[keys.end]),
      dd: _rcDecimals(bill[keys.diff]),
    };
  }
  return r;
}
function _rcCleanLink(prev, cur, keys, cache, i) {
  if (cur['_auto_corrected_' + keys.start] || cur['_auto_corrected_' + keys.end] || cur['_auto_corrected_' + keys.diff])
    return false;
  const p = _rcReads(prev, keys, cache, i - 1),
    c = _rcReads(cur, keys, cache, i);
  if (p.E === null || c.S === null || c.E === null || c.D === null) return false;
  const tol = Math.pow(10, -Math.min(c.sd, c.ed, c.dd, p.ed)) + 1e-6; // as computeReadCorrection (p.ed = decimals of the previous end read)
  return Math.abs(c.S - p.E) <= tol && Math.abs(c.E - c.S - c.D) <= tol;
}
function _rcWalk(ordered, keys, getUsage, link, skip) {
  let changed = 0;
  const cache = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1],
      cur = ordered[i],
      next = ordered[i + 1] || null;
    if (_rcCleanLink(prev, cur, keys, cache, i)) continue;
    if (skip(prev) || skip(cur) || !link(prev, cur) || _rcUserEdited(cur, keys)) continue;
    const nextStart = next && !skip(next) && link(cur, next) ? next[keys.start] : null;
    if (_rcRevertProvisional(cur, keys, nextStart)) {
      changed++;
      cache[i] = undefined; // reads changed: parse again when the next bill uses them
    }
    const fix = computeReadCorrection({
      prevEnd: prev[keys.end],
      prevStart: prev[keys.start],
      prevDiff: prev[keys.diff],
      prevMult: prev[keys.mult],
      prevUsage: getUsage(prev),
      start: cur[keys.start],
      end: cur[keys.end],
      diff: cur[keys.diff],
      mult: cur[keys.mult],
      usage: getUsage(cur),
      nextStart,
    });
    if (!fix) continue;
    _rcApply(cur, keys, fix);
    cache[i] = undefined;
    changed++;
  }
  return changed;
}
// The usage VALUE is the shared getBillUsageOrNull. For its printed precision the raw text is passed when it parses to
// the same number: a number drops trailing zeros ('100000.4000' becomes 100000.4, one decimal), which makes the usage
// look coarser than the bill printed it and declines a safe correction.
function _rcUsageForBill(b, commodity) {
  const n = getBillUsageOrNull(b, commodity);
  if (n === null) return null;
  const raw = commodity === 'Electric' ? b.kwh : null;
  return raw !== null && raw !== undefined && parseBillNumber(raw) === n ? raw : n;
}
// Stored bills of one meter. Returns the number of bills corrected (0 when the meter is already clean).
function correctMeterReadChain(meter) {
  if (!meter || !Array.isArray(meter.bills)) return 0;
  const T = BILL_FLAG_THRESHOLDS;
  const ordered = _bfSortByStart(meter.bills).filter((b) => !b.estimated);
  return _rcWalk(
    ordered,
    READ_CHAIN_FIELDS.stored,
    (b) => _rcUsageForBill(b, meter.commodity),
    // b follows a: b starts on or after a's end (a duplicate or overlapping bill starts earlier and is never linked)
    (a, b) => {
      const g = a.end && b.start ? calcDays(a.end, b.start, false) : '';
      return g !== '' && g >= 0 && g <= T.GAP_DAYS;
    },
    (b) => !!(b.Meter1_ReadDiff || b.Meter1_StartRead || b.Meter2_ReadDiff),
  );
}
// PDF extraction output, keys StartRead / EndRead / ReadDifference / MeterMultiplier. The bills are walked in date
// order (BillingPeriodStart), whatever order the PDF printed them in. sameMeter(a, b), dayGap(a, b), getUsage(b) and
// skip(b) come from the caller (account match, days between bills).
function correctExtractedReadChain(bills, sameMeter, dayGap, getUsage, skip) {
  const T = BILL_FLAG_THRESHOLDS;
  const dayKey = (b) => {
    const d = b && b.BillingPeriodStart ? calcDays('2000-01-01', b.BillingPeriodStart, false) : '';
    return d === '' || isNaN(d) ? Infinity : d;
  };
  const ordered = bills
    .map((b, i) => ({ b, i, k: dayKey(b) }))
    .sort((p, q) => p.k - q.k || p.i - q.i)
    .map((p) => p.b);
  return _rcWalk(
    ordered,
    READ_CHAIN_FIELDS.pdf,
    getUsage,
    (a, b) => {
      const g = sameMeter(a, b) ? dayGap(a, b) : '';
      return g !== '' && !isNaN(g) && g >= 0 && g <= T.GAP_DAYS + 2;
    },
    skip,
  );
}
// The correction records an extracted bill carries for its start and end read, in stored-bill field names, so a
// bill saved from a PDF keeps the original reader value. Used by every saved-bill builder in app/bill-analysis.js.
function readCorrectionMarkers(extracted) {
  const out = {};
  [
    ['StartRead', 'startRead'],
    ['EndRead', 'endRead'],
    ['ReadDifference', 'readDifference'],
  ].forEach((p) => {
    const r = extracted && extracted['_auto_corrected_' + p[0]];
    if (_rcIsReadChainRecord(r)) out['_auto_corrected_' + p[1]] = r;
  });
  // printed read check (data only): mismatching fields, and whether the kWh was computed because the PDF printed none
  if (extracted) {
    const rec = extracted._auto_recovered_kWhConsumed || extracted._auto_corrected_kWhConsumed;
    const kwhComputed = !!rec && !parseBillNumber(rec.original);
    const found = computePrintedReadMismatch({
      start: extracted.StartRead,
      end: extracted.EndRead,
      diff: extracted.ReadDifference,
      mult: extracted.MeterMultiplier,
      usage: kwhComputed ? null : extracted.kWhConsumed,
    });
    if (found.length)
      out._printedReadCheck = { fields: found.map((m) => m.field), messages: found.map((m) => m.message), kwhComputed };
    else if (extracted._printedReadCheck) out._printedReadCheck = extracted._printedReadCheck; // already stored
  }
  return out;
}
