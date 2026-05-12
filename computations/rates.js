// computations/rates.js — Rate lookup and validation (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

// ── RATE GUARDRAILS — validates implied rate (charge ÷ usage) for all commodity types ──
var KNOWN_RATES = {
  Electric: {
    kWh: { typical: 0.1, unit: '$/kWh', min: 0.01, max: 1.0 },
    kW: { typical: 10.0, unit: '$/kW', min: 1.0, max: 100.0 },
  },
  Gas: {
    therm: { typical: 0.798, unit: '$/Therm', min: 0.08, max: 8.0 },
  },
  Propane: {
    gallon: { typical: 2.5, unit: '$/Gal', min: 0.25, max: 25.0 },
  },
  Water: {
    unit: { typical: 5.0, unit: '$/1000gal', min: 0.5, max: 50.0 },
  },
  Sewer: {
    unit: { typical: 8.0, unit: '$/1000gal', min: 0.8, max: 80.0 },
  },
};

// New canonical function for rate lookup
function getStoredRate(bill, type) {
  switch (type) {
    case 'kwh': {
      var stored = parseFloat(bill.totalKwhRate);
      if (stored > 0) return stored;
      var usage = parseFloat(bill.kWhConsumed) || parseFloat(bill.totalKwh) || 0;
      var cost = parseFloat(bill.kwhCost) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'kw': {
      var stored = parseFloat(bill.totalKwRate);
      if (stored > 0) return stored;
      var usage = parseFloat(bill.BilledKW) || parseFloat(bill.ActualKW) || parseFloat(bill.FacilitiesKW) || 0;
      var cost = parseFloat(bill.kwCost) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'gas': {
      var stored = parseFloat(bill.totalGasRate);
      if (stored > 0) return stored;
      var usage = parseFloat(bill.NaturalGasTherms) || parseFloat(bill.therms) || 0;
      var cost = parseFloat(bill.GasCharge) || parseFloat(bill.totalCost) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'propane': {
      var stored = parseFloat(bill.totalPropaneRate);
      if (stored > 0) return stored;
      var cost = parseFloat(bill.totalCost) || parseFloat(bill.TotalAmountDue) || 0;
      var usage = parseFloat(bill.GallonsDelivered) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'water': {
      var stored = parseFloat(bill.totalWaterRate);
      if (stored > 0) return stored;
      var cost = parseFloat(bill.WaterCharge) || parseFloat(bill.totalCost) || 0;
      var usage = parseFloat(bill.WaterUsage) || 0;
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'sewer': {
      var stored = parseFloat(bill.totalSewerRate);
      if (stored > 0) return stored;
      return 0;
    }
    default:
      return 0;
  }
}

// Populate missing derived rate fields on a bill from its usage + cost data.
// Returns true if any field was added/updated, false if bill was already complete.
function ensureBillRates(bill) {
  var changed = false;
  var pf = function (v) {
    return parseFloat(v) || 0;
  };

  // Electric: totalKwhRate
  if (!pf(bill.totalKwhRate)) {
    var kwh = pf(bill.kWhConsumed) || pf(bill.totalKwh) || pf(bill.kwh);
    var kwhCost = pf(bill.kwhCost);
    if (kwh > 0 && kwhCost > 0) {
      bill.totalKwhRate = (kwhCost / kwh).toFixed(5);
      changed = true;
    }
  }

  // Electric: totalKwRate
  if (!pf(bill.totalKwRate)) {
    var kw = pf(bill.BilledKW) || pf(bill.billedKW) || pf(bill.ActualKW) || pf(bill.demandKW) || pf(bill.FacilitiesKW);
    var kwCost = pf(bill.kwCost);
    if (kw > 0 && kwCost > 0) {
      bill.totalKwRate = (kwCost / kw).toFixed(5);
      changed = true;
    }
  }

  // Gas: totalGasRate (use gasCharge/commodity cost, not total bill cost — bug d4c78f06)
  if (!pf(bill.totalGasRate)) {
    var therms = pf(bill.NaturalGasTherms) || pf(bill.therms) || pf(bill.NaturalGasCCF);
    var gasChg = pf(bill.GasCharge) || pf(bill.gasCharge) || pf(bill.thermCost);
    if (therms > 0 && gasChg > 0) {
      bill.totalGasRate = (gasChg / therms).toFixed(5);
      changed = true;
    }
  }

  // Propane: totalPropaneRate (prefer unitPrice if available)
  if (!pf(bill.totalPropaneRate)) {
    var up = pf(bill.UnitPrice) || pf(bill.unitPrice);
    if (up > 0) {
      bill.totalPropaneRate = up.toFixed(5);
      changed = true;
    } else {
      var gal = pf(bill.GallonsDelivered) || pf(bill.gallonsDelivered);
      var propCost = pf(bill.totalCost) || pf(bill.TotalAmountDue);
      if (gal > 0 && propCost > 0) {
        bill.totalPropaneRate = (propCost / gal).toFixed(5);
        changed = true;
      }
    }
  }

  // Water: totalWaterRate
  if (!pf(bill.totalWaterRate)) {
    var wUsage = pf(bill.WaterUsage) || pf(bill.waterUsage);
    var wChg = pf(bill.WaterCharge) || pf(bill.waterCharge);
    if (wUsage > 0 && wChg > 0) {
      bill.totalWaterRate = (wChg / wUsage).toFixed(5);
      changed = true;
    }
  }

  // Sewer: totalSewerRate
  if (!pf(bill.totalSewerRate)) {
    var sUsage = pf(bill.SewerUsage) || pf(bill.sewerUsage);
    var sChg = pf(bill.SewerCharge) || pf(bill.sewerCharge);
    if (sUsage > 0 && sChg > 0) {
      bill.totalSewerRate = (sChg / sUsage).toFixed(5);
      changed = true;
    }
  }

  return changed;
}

function validateImpliedRate(commodity, usage, charge, utilityName) {
  if (!usage || !charge || usage === 0) return null;
  const implied = Math.abs(charge / usage);
  const commRates = KNOWN_RATES[(commodity || '').charAt(0).toUpperCase() + (commodity || '').slice(1).toLowerCase()];
  if (!commRates) return null;
  const rateKey = Object.keys(commRates)[0];
  const expected = commRates[rateKey];
  if (!expected) return null;

  // Use utility-specific override if available (e.g. Louisburg gas)
  let expMin = expected.min,
    expMax = expected.max,
    expTypical = expected.typical;
  if ((commodity || '').toLowerCase() === 'gas' && utilityName && /louisburg/i.test(utilityName)) {
    const lbgRate = _LBG_GAS_RATES[0].rate;
    expTypical = lbgRate;
    expMin = lbgRate / 10;
    expMax = lbgRate * 10;
  }

  let severity = null;
  if (implied < expMin || implied > expMax) {
    severity = 'error';
  } else if (implied < expTypical / 3 || implied > expTypical * 3) {
    severity = 'warn';
  } else if (implied < expTypical / 1.5 || implied > expTypical * 1.5) {
    severity = 'info';
  }

  return {
    valid: severity === null,
    implied: implied,
    typical: expTypical,
    min: expMin,
    max: expMax,
    unit: expected.unit,
    severity: severity,
  };
}

function toKBtu(kwh, therms, gallons) {
  return (parseFloat(kwh) || 0) * 3.412 + (parseFloat(therms) || 0) * 100 + (parseFloat(gallons) || 0) * 91.5;
}

function getExtractedRate(parsed, type) {
  var pf = function (v) {
    return parseFloat(v) || 0;
  };
  switch (type) {
    case 'kwh': {
      var cost =
        pf(parsed.EnergyOnPeakCharge) +
        pf(parsed.EnergyOffPeakCharge) +
        pf(parsed.ECACharge) +
        pf(parsed.EERCharge) +
        pf(parsed.PTSCharge);
      var usage = pf(parsed.kWhConsumed);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'kw': {
      var cost = pf(parsed.FacilitiesCharge) + pf(parsed.BilledKWCharge) + pf(parsed.TDCCharge);
      var usage = pf(parsed.BilledKW) || pf(parsed.ActualKW) || pf(parsed.FacilitiesKW);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'gas': {
      var usage = pf(parsed.NaturalGasTherms);
      var cost = pf(parsed.GasCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'propane': {
      var up = pf(parsed.UnitPrice);
      if (up > 0) return up;
      var gal = pf(parsed.GallonsDelivered);
      var cost = pf(parsed.TotalCurrentCharges) || pf(parsed.TotalAmountDue);
      return gal > 0 && cost > 0 ? cost / gal : 0;
    }
    case 'water': {
      var usage = pf(parsed.WaterUsage);
      var cost = pf(parsed.WaterCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    case 'sewer': {
      var usage = pf(parsed.SewerUsage);
      var cost = pf(parsed.SewerCharge);
      return usage > 0 && cost > 0 ? cost / usage : 0;
    }
    default:
      return 0;
  }
}
