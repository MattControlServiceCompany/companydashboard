/* computations/project-savings.js - the ONE total of project savings (2026-11-27, single source of truth for savings).

   A project has ONE list of measures: the hand-entered measures of the Energy Savings matrix (sd.measures, priced by calcMeasureDollars) and the
   DERIVED measures: the savings items of the Service Proposal estimate (computations/measure-savings.js, msEstimate), computed on read from the
   Cost Estimate rows, never stored. A derived measure is tagged source 'proposal:<key>' and carries its option membership
   { compliance, recommended, fullScope, optional }.

   Owners in this file (every page, report and export calls these; none computes its own copy):
     psBuildingUse / psRateOf / psProjectGasRate / psBuildingRates / psBlendedMeasureRates   the ONE rate reader of an estimate: the building's
                    blended rate of its newest 12 complete bill months (cost / use); a building with no gas meter takes the mean gas rate of the
                    buildings of the project that have one.
     psDollars      quantities x rate, priced through calcMeasureDollars (app/energy-savings.js, the one pricing rule of a matrix measure)
     psRollUp       a list of items to the total: the overlap rule, the per building roll-up, the payback (simplePayback), the display values
     psSavings      the total of ONE option of the derived list (psRollUp over the members of the option)
     psExternalUse  the end-use quantities of a hand-entered ECM measure, which reduce the derived measures of the same building
   Payback is simplePayback (computations/cost-lines.js). Overlap per building and end use: what is left after several measures = the product of
   (1 - saving / end-use base), not the sum; an override and its own sequence count once (msReleases). Estimates only: low / likely / high.
   Loaded after computations/cost-lines.js and computations/measure-savings.js. */

var PS_OPTIONS = ['compliance', 'recommended', 'fullScope', 'optional']; // option keys of a derived measure
// The end use names of the ECM Calculator (computations/end-use.js) as the end uses of msEstimate (byUse).
var PS_ENDUSE_TO_MS = { cooling: 'cool', heatingGas: 'heatGas', heatingElectric: 'heatEl' };

// ── Display rounding: dollars to the nearest $100, payback to whole years (at least 1). ──
function psRound100(v) {
  return Math.round(v / 100) * 100;
}
function psYears(y) {
  return y === null || y === undefined ? null : Math.max(1, Math.round(y));
}

// ── The rate reader ──
// The newest 12 complete bill months of a building of the project (buildingAnnualUse), or null.
function psBuildingUse(projId, name) {
  var ud =
    typeof _a36UtilityBuilding === 'function' && typeof buildingAnnualUse === 'function'
      ? _a36UtilityBuilding({ project: { id: projId } }, { name: name })
      : null;
  return ud ? buildingAnnualUse(projId, ud.id) : null;
}
// The blended rate of a fuel: cost / use (null when either is missing).
function psRateOf(cost, use) {
  return cost > 0 && use > 0 ? cost / use : null;
}
// The mean gas rate of the buildings of the project that have a gas meter: the gas rate of a building with none. 0 when none has one.
function psProjectGasRate(projId) {
  var rates = [];
  ((typeof getUDBldgs === 'function' && getUDBldgs(projId)) || []).forEach(function (ub) {
    var u = typeof buildingAnnualUse === 'function' ? buildingAnnualUse(projId, ub.id) : null;
    var g = u && u.hasGas ? psRateOf(u.gasCost, u.therms) : null;
    if (g) rates.push(g);
  });
  return rates.length
    ? rates.reduce(function (x, y) {
        return x + y;
      }, 0) / rates.length
    : 0;
}
// The rates of a building from its use (buildingAnnualUse): { use, elec, gas } or null (no electric rate). gas = null when there is none.
function psRatesOfUse(projId, use) {
  var elec = use ? psRateOf(use.electricCost, use.kwh) : null;
  if (!use || !elec) return null;
  var gas = use.hasGas ? psRateOf(use.gasCost, use.therms) : psProjectGasRate(projId) || null;
  return { use: use, elec: elec, gas: gas };
}
function psBuildingRates(projId, name) {
  return psRatesOfUse(projId, psBuildingUse(projId, name));
}
// The rate set of a matrix measure that has no rate at all (calcMeasureDollars format), from the building's blended rates, or null.
// bldgId = the utility building id of the measure.
function psBlendedMeasureRates(projId, bldgId) {
  var use = bldgId && typeof buildingAnnualUse === 'function' ? buildingAnnualUse(projId, bldgId) : null;
  var r = psRatesOfUse(projId, use);
  if (!r) return null;
  return { kwhSummer: r.elec, kwhWinter: r.elec, thermRate: r.gas || 0 };
}

// ── Pricing: quantities x the blended rate, through the one matrix pricing rule (calcMeasureDollars: each month's quantity x that month's rate) ──
// unitCost = { elec, gas } ($ per kWh, $ per therm). A flat year (quantity / 12 a month) at one rate = quantity x rate.
function psDollars(kwh, therms, unitCost) {
  var rates = { kwhSummer: unitCost.elec || 0, kwhWinter: unitCost.elec || 0, thermRate: unitCost.gas || 0 };
  var flat = function (q) {
    return Array(12).fill((q || 0) / 12);
  };
  return calcMeasureDollars({ kwh: flat(kwh), gas: flat(therms) }, rates).total;
}

// ── The roll-up ──
// The end-use quantities a hand-entered ECM measure saves: { building (utility building id), byUse: { cool | heatEl | heatGas: qty } }, or null.
// ecmMap = ECM_MEASURE_FIELD_MAP (app/ecm-calculators.js). Only an Energy Savings measure built from an ECM template carries an end use.
function psExternalUse(m, ecmMap) {
  var src = m && typeof m.source === 'string' && m.source.indexOf('ecm_') === 0 ? m.source.slice(4) : null;
  var map = src && ecmMap ? ecmMap[src] : null;
  if (!map || !m.bldgId) return null;
  var byUse = {};
  var sum = function (a) {
    return (a || []).reduce(function (s, v) {
      return s + (parseFloat(v) || 0);
    }, 0);
  };
  map.forEach(function (e) {
    var use = e.by ? null : e.endUse && e.endUse.length ? PS_ENDUSE_TO_MS[e.endUse[0]] : null;
    if (!use) return;
    var q = e.kind === 'kwh' ? sum(m.kwh) : e.kind === 'gas' ? sum(m.gas) : 0;
    if (q > 0) byUse[use] = (byUse[use] || 0) + q;
  });
  return Object.keys(byUse).length ? { building: m.bldgId, byUse: byUse } : null;
}

/* psRollUp(items, o): the total of a list of items. An item = { key, building, price, claimed, exempt, hasData, bldOk, ms, unitCost, useLabel }
   (a savings item of the Service Proposal estimate) or { co2: true, building, hasData, kwh, therms, usd } (the room CO2 line of a building:
   quantities per case, added after the overlap). o = { totalPrice (the option price from the workbook, or null = the sum), external: [{ building
   (name), byUse }] (hand-entered measures of the same building: they act first on the end uses) }.
   Returns { claims, complete, year, buildings: [{ building, price, hasClaim, hasData, kwh, therms, usd, years }],
             total: { price, kwh, therms, usd, years } (each { low, likely, high }), display: { low, likely, high, years } | null }. */
function psRollUp(items, o) {
  o = o || {};
  var zero = function () {
    return { low: 0, likely: 0, high: 0 };
  };
  var order = [];
  var seen = {};
  items.forEach(function (it) {
    if (it.building && !seen[it.building]) {
      seen[it.building] = true;
      order.push(it.building);
    }
  });
  var buildings = order.map(function (name) {
    var mine = items.filter(function (it) {
      return it.building === name && !it.co2;
    });
    var cb = null;
    items.forEach(function (it) {
      if (it.co2 && it.building === name) cb = it;
    });
    var B = mine.some(function (it) {
      return it.bldOk;
    });
    var unitCost = null;
    mine.forEach(function (it) {
      if (!unitCost && it.unitCost) unitCost = it.unitCost;
    });
    var out = {
      building: name,
      price: mine.reduce(function (s, it) {
        return s + (it.price || 0);
      }, 0),
      hasClaim: mine.some(function (it) {
        return it.claimed && !it.exempt;
      }),
      kwh: zero(),
      therms: zero(),
      usd: zero(),
      years: null,
    };
    var haveEst = B && mine.some(function (it) {
      return it.hasData && it.claimed && !it.exempt;
    });
    out.hasData = (out.hasClaim ? B : true) && (!cb || !!cb.hasData);
    if (cb) out.hasClaim = true;
    if (!out.hasData) return out;
    // An override and its own sequence in the set count once.
    var keys = {};
    mine.forEach(function (it) {
      keys[it.key] = true;
    });
    var counted = mine.filter(function (it) {
      if (!it.hasData || !it.ms) return false;
      var rel = msReleases(it.key);
      return !(rel && keys[rel]);
    });
    var ext = (o.external || []).filter(function (x) {
      return x.building === name;
    });
    MS_CASES.forEach(function (k) {
      if (haveEst) {
        // per end use: remaining = product of (1 - share of the end-use base that each measure saves); a measure never saves more than its base
        var rem = {};
        var base = {};
        counted.forEach(function (it) {
          var r = it.ms[k];
          Object.keys(r.byUse).forEach(function (u) {
            var b = r.baseByUse[u] || 0;
            base[u] = Math.max(base[u] || 0, b);
            var f = b > 0 ? Math.min(1, r.byUse[u] / b) : 0;
            rem[u] = (rem[u] === undefined ? 1 : rem[u]) * (1 - f);
          });
        });
        // the hand-entered measures of the building take their share of the same end use first

        Object.keys(rem).forEach(function (u) {
          ext.forEach(function (x) {
            var q = x.byUse[u] || 0;
            if (q > 0 && base[u] > 0) rem[u] = rem[u] * (1 - Math.min(1, q / base[u]));
          });
        });
        Object.keys(rem).forEach(function (u) {
          var s = base[u] * (1 - rem[u]);
          if (u === 'heatGas') {
            out.therms[k] += s;
            out.usd[k] += psDollars(0, s, unitCost);
          } else {
            out.kwh[k] += s;
            out.usd[k] += psDollars(s, 0, unitCost);
          }
        });
      }
      if (cb && cb.hasData) {
        out.kwh[k] += cb.kwh[k];
        out.therms[k] += cb.therms[k];
        out.usd[k] += cb.usd[k];
      }
    });
    out.years = simplePayback(out.price, 0, out.usd.likely).years;
    return out;
  });
  var sum = function (f) {
    return buildings.reduce(function (s, b) {
      return s + f(b);
    }, 0);
  };
  var total = {
    price: o.totalPrice !== null && o.totalPrice !== undefined ? o.totalPrice : sum(function (b) { return b.price; }),
    kwh: zero(),
    therms: zero(),
    usd: zero(),
    years: { low: null, likely: null, high: null },
  };
  var claims = buildings.some(function (b) {
    return b.hasClaim;
  });
  var complete = claims && buildings.every(function (b) {
    return !b.hasClaim || b.hasData;
  });
  MS_CASES.forEach(function (k) {
    total.kwh[k] = sum(function (b) { return b.kwh[k]; });
    total.therms[k] = sum(function (b) { return b.therms[k]; });
    total.usd[k] = sum(function (b) { return b.usd[k]; });
    total.years[k] = complete ? simplePayback(total.price, 0, total.usd[k]).years : null;
  });
  var labels = [];
  buildings.forEach(function (b) {
    var lab = null;
    items.forEach(function (it) {
      if (!lab && it.building === b.building && it.useLabel) lab = it.useLabel;
    });
    if (b.hasClaim && lab && labels.indexOf(lab) === -1) labels.push(lab);
  });
  return {
    claims: claims,
    complete: complete,
    year: labels.length === 1 ? labels[0] : null,
    buildings: buildings,
    total: total,
    display: complete
      ? {
          low: psRound100(total.usd.low),
          likely: psRound100(total.usd.likely),
          high: psRound100(total.usd.high),
          years: psYears(total.years.likely),
        }
      : null,
  };
}

/* The roll-up items of ONE option of a derived list (derived = { measures, optionPrice, external }; see _pricingDerivedMeasures).
   The total of the option: psRollUp over the measures that belong to it, at the price each has in that option. Returns the psRollUp result
   plus members: the derived measures of the option. */
function psSavings(derived, option) {
  var members = ((derived && derived.measures) || []).filter(function (m) {
    return m.options && m.options[option];
  });
  var items = members.map(function (m) {
    var it = {};
    Object.keys(m).forEach(function (k) {
      it[k] = m[k];
    });
    it.price = (m.prices && m.prices[option]) || 0;
    return it;
  });
  var r = psRollUp(items, {
    totalPrice: derived.optionPrice && derived.optionPrice[option] !== undefined ? derived.optionPrice[option] : null,
    external: derived.external || [],
  });
  r.members = members;
  return r;
}
