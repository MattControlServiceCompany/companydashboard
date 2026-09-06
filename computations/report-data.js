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
 *     kBtu conversion factors (electric 3.412, gas 100, propane 91.5).
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
      const t12 = allRows.slice(-12);
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
