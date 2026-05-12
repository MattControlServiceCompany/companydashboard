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
