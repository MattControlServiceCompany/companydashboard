// computations/report-data.js — Report data collection (canonical source)

/**
 * collectUtilityAuditData — Utility Audit / EUI Report v1 (2026-09-06).
 *
 * Builds a per-building annual spend-by-commodity table + campus roll-up, and
 * per-building EUI where floor area exists, straight from the app's own loaded
 * utility data. Baseline-free — no regression, no baseline months required.
 *
 * Reused verbatim from existing shipped logic (do not re-derive):
 *   - getNormRows(m, bills, incl, null) (computations/normalization.js) — prorates
 *     each bill's usage/cost across the calendar months it spans.
 *   - computeKBtu(kwh, therms, propaneGal) (computations/eui.js) — canonical
 *     kBtu conversion factors (electric, gas, propane: computations/physics.js).
 *
 * Trust rule (per commodity row from getNormRows): `cost` is trustworthy for every
 * commodity. `usage` is only trustworthy for Electric/Gas/Propane — other commodities'
 * usage field in getNormRows falls back through mismatched bill fields and must not
 * be displayed or summed as a quantity.
 *
 * @param {number} projId - Project ID
 * @param {Array<string>|null} buildingIds - optional building-id filter; null/empty = all buildings
 * @returns {object|null} {
 *   project: { name, id },
 *   period: { startYm, endYm },            // trailing-12 window actually covered by bill data
 *   buildings: [{
 *     id, name, sqft, hasSqft, hasMeter,
 *     commodities: {
 *       Electric: { kwh, cost }, Gas: { therms, cost }, Water: { cost }, Sewer: { cost },
 *       Stormwater: { cost }, Steam: { cost }, Propane: { gal, cost },
 *     },
 *     totalCost, kBtu, eui,                // eui: number | null (null when no sqft or no kBtu)
 *   }],
 *   campus: {
 *     totalSqft, totalCost, totalKBtu, campusEUI,   // campusEUI: number | null
 *     flags: { noSqft: [names], noMeter: [names] },
 *   },
 * } or null if the project/buildings can't be found.
 */
function collectUtilityAuditData(projId, buildingIds) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return null;

  let bldgs = getUDBldgs(projId);
  if (buildingIds && buildingIds.length) bldgs = bldgs.filter((b) => buildingIds.includes(String(b.id)));
  if (!bldgs.length) return null;

  let earliestYm = null,
    latestYm = null;

  const outBuildings = bldgs.map((b) => {
    const sqft = parseFloat(b.sqft || 0);
    const hasSqft = sqft > 0;
    const meters = b.meters || [];
    let hasMeter = false;

    const commodities = {
      Electric: { kwh: 0, cost: 0 },
      Gas: { therms: 0, cost: 0 },
      Water: { cost: 0 },
      Sewer: { cost: 0 },
      Stormwater: { cost: 0 },
      Steam: { cost: 0 },
      Propane: { gal: 0, cost: 0 },
    };

    meters.forEach((m) => {
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      if (!bills.length) return;
      const incl = m.inclusive !== false;
      const allRows = getNormRows(m, bills, incl, null);
      // Trailing 12 months — mirrors the shipped loop at app/utility-data.js:1815-1848.
      // Exclude propane's explicit zero-fill rows (2026-09-10 guard) so they
      // don't displace real months out of the window — same fix as the
      // Building Comparison radar's trailing-12 gather.
      const t12 = allRows.filter((r) => !r.zeroFill).slice(-12);
      if (!t12.length) return;
      hasMeter = true;

      const c = commodities[m.commodity];
      t12.forEach((r) => {
        if (!earliestYm || r.ym < earliestYm) earliestYm = r.ym;
        if (!latestYm || r.ym > latestYm) latestYm = r.ym;
        if (!c) return; // commodity not tracked in this report (e.g. unknown/custom type)
        c.cost += r.cost || 0;
        // Usage is only trustworthy for Electric/Gas/Propane (see file header note).
        if (m.commodity === 'Electric') c.kwh += r.usage || 0;
        else if (m.commodity === 'Gas') c.therms += r.usage || 0;
        else if (m.commodity === 'Propane') c.gal += r.usage || 0;
      });
    });

    const totalCost = Object.values(commodities).reduce((s, c) => s + (c.cost || 0), 0);
    const kBtu = computeKBtu(commodities.Electric.kwh, commodities.Gas.therms, commodities.Propane.gal);
    const eui = hasSqft && kBtu > 0 ? kBtu / sqft : null;

    return {
      id: b.id,
      name: b.name || 'Building',
      sqft,
      hasSqft,
      hasMeter,
      commodities,
      totalCost,
      kBtu,
      eui,
    };
  });

  // Campus roll-up — mirrors the shipped math at app/utility-data.js:1397-1398. The shared/
  // central-plant meter case is handled implicitly: that meter simply lives under whichever
  // building record owns it, and its kBtu/cost roll into campusKBtu/campusCost like any other.
  let campusKBtu = 0,
    campusCost = 0,
    campusSqft = 0;
  const noSqft = [],
    noMeter = [];
  outBuildings.forEach((b) => {
    campusKBtu += b.kBtu;
    campusCost += b.totalCost;
    if (b.hasSqft) campusSqft += b.sqft;
    else noSqft.push(b.name);
    if (!b.hasMeter) noMeter.push(b.name);
  });

  return {
    project: { name: p.name, id: p.id },
    period: { startYm: earliestYm, endYm: latestYm },
    buildings: outBuildings,
    campus: {
      totalSqft: campusSqft,
      totalCost: campusCost,
      totalKBtu: campusKBtu,
      campusEUI: campusSqft > 0 ? campusKBtu / campusSqft : null,
      flags: { noSqft, noMeter },
    },
  };
}

/**
 * getReportCoverage — the ONE rule for which months a report covers (Matt 2026-10-27).
 *
 * The period ends at the last month that has a REAL bill for an included meter. A month filled
 * with zero by getNormRows (a delivery meter such as propane with no bill after the last
 * delivery, flag zeroFill) is not a bill and never extends the period. The report-date month
 * does not extend it either. Every report page, chart and table reads its month list and the
 * "bills through" dates from this one result (collectReportData -> data.period).
 *
 * Eligible meters: the rule _rptMeterEligible (app/report-engine.js), energy commodities with a
 * baseline of 3 months or more, and meterIds when the caller passes a selection.
 * A bill counts when billMonth(bill) is after the meter's last baseline month.
 *
 * @param {string|number} projId
 * @param {Array<string>|null} meterIds   user selection; null/empty = every eligible meter
 * @param {Array<string>|null} buildingIds user building selection; null/empty = every building (the same
 *   building/meter set collectReportData reports on)
 * @param {string} [reqStartYm]           optional YYYY-MM: the user's first month (clamps start)
 * @param {string} [reqEndYm]             optional YYYY-MM: the user's last month (clamps end)
 * electricThrough/gasThrough/deliveryThrough/lastBillDate are the latest bill dates INSIDE startYm..endYm
 * (a date after the last day of endYm shows that last day). They are for the Generate Report dialog only; no printed page uses them.
 * @returns {{startYm:string, endYm:string, yms:string[], lastBillDate:string,
 *   gasThrough:string, electricThrough:string, deliveryThrough:string, hasData:boolean,
 *   complete:boolean, missing:Array, waitingText:string}}
 *   yms = every month from startYm to endYm, startYm/endYm '' when no meter has a bill after its baseline.
 *
 * Completeness (Matt 2026-10-27): the period is complete only when EVERY included monthly meter
 * (electric, gas) has a bill for EVERY month of the requested range (reqStartYm..reqEndYm, else
 * startYm..endYm). `missing` lists {commodity, building, meter, ym} for each gap and `waitingText`
 * is the plain line "waiting for Gas High School Sep 2026, ... bills". A delivery meter (propane)
 * has no monthly bill, so it never makes a period incomplete. Completeness does NOT change any
 * printed number and the report never prints it; the Generate Report dialog and the file name use it.
 */
function getReportCoverage(projId, meterIds, reqStartYm, reqEndYm, buildingIds) {
  const idSet = meterIds && meterIds.length ? new Set(meterIds.map(String)) : null;
  const bldgSet = buildingIds && buildingIds.length ? new Set(buildingIds.map(String)) : null;
  const energy = ['Electric', 'Gas', 'Propane'];
  let first = '',
    last = '';
  const billDates = []; // {commodity, ym, d}: clamped to the period below
  const monthly = []; // monthly-billed meters: {m, building, blEnd, have}
  getUDBldgs(projId).forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (bldgSet && !bldgSet.has(String(b.id))) return;
      if (_rptMeterEligible(projId, m)) return;
      if (idSet && !idSet.has(String(m.id))) return;
      if (energy.indexOf(m.commodity) < 0) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const blEnd = bl.months.slice().sort().pop();
      const bills = (m.bills || []).filter((x) => x && (x.end || x.start));
      const have = {};
      if (!DELIVERY_COMMODITIES.has(m.commodity))
        monthly.push({ m: m, building: b.name || 'Unnamed', blEnd: blEnd, have: have });
      bills.forEach((x) => {
        const ym = billMonth(x, m.bills);
        if (!ym || ym <= blEnd) return;
        have[ym] = true;
        if (!first || ym < first) first = ym;
        if (!last || ym > last) last = ym;
        billDates.push({ commodity: m.commodity, ym: ym, d: String(x.end || x.start).slice(0, 10) });
      });
    }),
  );
  let startYm = first,
    endYm = last;
  if (reqStartYm && startYm && reqStartYm > startYm) startYm = reqStartYm;
  if (reqEndYm && endYm && reqEndYm < endYm) endYm = reqEndYm;
  const span = (a, z) => {
    const out = [];
    if (!a || !z) return out;
    let y = Number(a.slice(0, 4)),
      mo = Number(a.slice(5, 7));
    while (y + '-' + String(mo).padStart(2, '0') <= z) {
      out.push(y + '-' + String(mo).padStart(2, '0'));
      if (++mo > 12) {
        mo = 1;
        y++;
      }
    }
    return out;
  };
  const yms = span(startYm, endYm);
  const through = { Electric: '', Gas: '', Propane: '' };
  const periodEndDate = endYm ? endYm + '-' + String(new Date(Number(endYm.slice(0, 4)), Number(endYm.slice(5, 7)), 0).getDate()).padStart(2, '0') : '';
  billDates.forEach((x) => {
    if (x.ym < startYm || x.ym > endYm) return;
    const d = x.d > periodEndDate ? periodEndDate : x.d; // a bill that runs past the period end shows the period end
    if (d > through[x.commodity]) through[x.commodity] = d;
  });
  if (!yms.length) {
    startYm = '';
    endYm = '';
  }
  // Completeness over the range the user asked for (not clamped to the months with bills).
  const wantYms = span(reqStartYm || first, reqEndYm || last);
  const missing = [];
  monthly.forEach((x) =>
    wantYms.forEach((ym) => {
      if (ym > x.blEnd && !x.have[ym])
        missing.push({ commodity: x.m.commodity, building: x.building, meter: x.m.id, ym: ym });
    }),
  );
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const names = missing.map(
    (x) => x.commodity + ' ' + x.building + ' ' + MON[Number(x.ym.slice(5, 7)) - 1] + ' ' + x.ym.slice(0, 4),
  );
  const waitingText = names.length
    ? 'waiting for ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ' and ' + (names.length - 6) + ' more' : '') + ' bills'
    : '';
  const lastBillDate = [through.Electric, through.Gas].reduce((a, x) => (x > a ? x : a), '');
  return {
    startYm: startYm,
    endYm: endYm,
    yms: yms,
    lastBillDate: lastBillDate,
    electricThrough: through.Electric,
    gasThrough: through.Gas,
    deliveryThrough: through.Propane,
    hasData: yms.length > 0,
    complete: yms.length > 0 && missing.length === 0,
    missing: missing,
    waitingText: waitingText,
  };
}

// The first and last month a report request asks for: a quarter picked -> its 3 months; a custom
// range -> the two months typed; anything else -> null (the months with bills decide). Used with
// getReportCoverage by collectReportData and by the Generate Report dialog.
function reportRequestRange(selectedPeriod) {
  const sp = selectedPeriod;
  if (!sp) return null;
  if (sp.quarter && sp.year) {
    const a = (Number(sp.quarter) - 1) * 3 + 1;
    return {
      startYm: sp.year + '-' + String(a).padStart(2, '0'),
      endYm: sp.year + '-' + String(a + 2).padStart(2, '0'),
    };
  }
  return sp.startYm || sp.endYm ? { startYm: sp.startYm || '', endYm: sp.endYm || '' } : null;
}
