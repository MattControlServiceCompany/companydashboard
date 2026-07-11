// ══════════════════════════════════════════════════════════════════════════════
// BILL DATA VALIDATION & STATISTICAL ANALYSIS
// Validates extracted bill data, flags missing fields, detects statistical
// outliers by comparing against historical bills for the same account/meter.
// ══════════════════════════════════════════════════════════════════════════════

// Expected fields per utility type — fields that should almost always have values
const EXPECTED_FIELDS = {
  Evergy: {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'kWhConsumed', 'TotalCurrentCharges'],
    important: [
      'ActualKW',
      'CustomerCharge',
      'AccountNumber',
      'NumberOfDays',
      'RateSchedule',
      'CustomerName',
      'FacilitiesKW',
      'FacilitiesCharge',
      'BilledKWCharge',
      'EnergyOnPeakCharge',
    ],
    chargeFields: [
      'CustomerCharge',
      'FacilitiesCharge',
      'BilledKWCharge',
      'EnergyOnPeakCharge',
      'ECACharge',
      'EERCharge',
      'TDCCharge',
    ],
  },
  'Spire / Laclede Gas': {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'NaturalGasTherms', 'TotalAmountDue'],
    important: ['AccountNumber', 'NumberOfDays'],
    chargeFields: [],
  },
  'City of Louisburg': {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'TotalAmountDue'],
    important: ['AccountNumber'],
    chargeFields: [],
  },
  'City of Baldwin City': {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'TotalAmountDue'],
    important: ['AccountNumber', 'ServiceAddress'],
    chargeFields: [],
  },
  'Propane / Fuel Oil Delivery': {
    critical: ['GallonsDelivered', 'TotalCurrentCharges'],
    important: ['DeliveryDate', 'UnitPrice'],
    chargeFields: [],
  },
  'Wood River Energy': {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'NaturalGasMMbtu', 'TotalCurrentCharges'],
    important: ['InvoiceNumber', 'AccountNumber', 'ProductionMonth'],
    chargeFields: [],
  },
  _default: {
    critical: ['BillingPeriodStart', 'BillingPeriodEnd', 'TotalAmountDue'],
    important: ['AccountNumber'],
    chargeFields: [],
  },
};

// Validate a single extracted bill — returns array of {level, field, message}
function validateBillData(extracted, utilityName) {
  const warnings = [];
  if (!extracted) return [{ level: 'error', field: '_all', message: 'No data extracted' }];
  const spec = EXPECTED_FIELDS[utilityName] || EXPECTED_FIELDS._default;

  // Check critical fields
  for (const f of spec.critical) {
    const v = extracted[f];
    if (v === null || v === undefined || v === '') {
      warnings.push({
        level: 'error',
        field: f,
        message: 'Missing — this field is normally present on ' + utilityName + ' bills',
      });
    }
  }
  // Check important fields
  for (const f of spec.important) {
    const v = extracted[f];
    if (v === null || v === undefined || v === '') {
      // Check if this field was auto-recovered (don't warn about recovered fields)
      if (extracted['_auto_recovered_' + f]) {
        warnings.push({
          level: 'info',
          field: f,
          message: 'Auto-recovered ' + extracted['_auto_recovered_' + f],
        });
      } else {
        warnings.push({
          level: 'warn',
          field: f,
          message: 'Missing — usually present on ' + utilityName + ' bills',
        });
      }
    }
  }

  // Validate charge math: component charges should sum to ~total
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);

  // Negative total check — no utility bill should ever have a negative total
  const _totalForSign = pf(extracted.TotalCurrentCharges);
  if (_totalForSign < 0) {
    warnings.push({
      level: 'error',
      field: 'TotalCurrentCharges',
      message:
        'Total Current Charges is negative ($' +
        _totalForSign.toFixed(2) +
        ') — utility bills cannot have negative totals',
    });
  }

  if (utilityName === 'Evergy') {
    const total = pf(extracted.TotalCurrentCharges);
    if (total > 0) {
      const compSum =
        Math.round(
          (pf(extracted.CustomerCharge) +
            pf(extracted.FacilitiesCharge) +
            pf(extracted.BilledKWCharge) +
            pf(extracted.EnergyOnPeakCharge) +
            pf(extracted.EnergyOffPeakCharge) +
            pf(extracted.ECACharge) +
            pf(extracted.EERCharge) +
            pf(extracted.PTSCharge) +
            pf(extracted.TDCCharge) +
            pf(extracted.RkVACharge) +
            pf(extracted.TaxExemptDelivery) +
            pf(extracted.BillOffset) +
            pf(extracted.FranchiseFee) +
            pf(extracted.SolarCredit) +
            pf(extracted.RenewableCharge)) *
            100,
        ) / 100;
      const diff = Math.abs(compSum - total);
      if (diff > 1.0) {
        warnings.push({
          level: 'warn',
          field: 'TotalCurrentCharges',
          message:
            'Charges sum to $' +
            compSum.toFixed(2) +
            ' but total is $' +
            total.toFixed(2) +
            ' (diff $' +
            diff.toFixed(2) +
            ')',
        });
      }
    }
    // Zero charge fields that should have values
    for (const f of spec.chargeFields) {
      if (extracted[f] !== null && extracted[f] !== undefined && extracted[f] !== '' && pf(extracted[f]) === 0) {
        warnings.push({ level: 'info', field: f, message: 'Value is $0.00 — verify this is correct' });
      }
    }
  }

  // Gas charge sum validation
  const _extComm = (extracted.Commodity || '').toLowerCase();
  if (_extComm === 'gas') {
    const gasTotal = pf(extracted.TotalCurrentCharges);
    if (gasTotal !== 0) {
      const gasCompSum =
        Math.round(
          (pf(extracted.CustomerCharge) +
            pf(extracted.GasCharge) +
            pf(extracted.FuelAdjustment) +
            (pf(extracted.DeliveryCharge) || 0) +
            (pf(extracted.GasSystemReliability) || 0) +
            (pf(extracted.WeatherNormalization) || 0) +
            (pf(extracted.WinterEventCost) || 0) +
            (pf(extracted.FranchiseFee) || 0) +
            (pf(extracted.DelayedPaymentCharge) || 0)) *
            100,
        ) / 100;
      if (gasCompSum > 0) {
        const gasDiff = Math.abs(gasCompSum - gasTotal);
        if (gasDiff > gasTotal * 0.15 && gasDiff > 5) {
          warnings.push({
            level: 'warn',
            field: 'TotalCurrentCharges',
            message:
              'Gas charges sum to $' +
              gasCompSum.toFixed(2) +
              ' but total is $' +
              gasTotal.toFixed(2) +
              ' (diff $' +
              gasDiff.toFixed(2) +
              ')',
          });
        }
      }
    }
  }

  // Implied rate guardrail — flags rates outside expected range for any commodity
  const _vComm = (extracted.Commodity || '').toLowerCase();
  const _vUtilName = extracted._utilityName || extracted.UtilityCompany || utilityName || '';
  if (_vComm === 'gas') {
    const _vUsage = pf(extracted.NaturalGasTherms);
    const _vCharge = pf(extracted.GasCharge);
    if (_vUsage > 0 && _vCharge > 0) {
      const rr = validateImpliedRate('Gas', _vUsage, _vCharge, _vUtilName);
      if (rr && rr.severity) {
        warnings.push({
          level: rr.severity,
          field: 'GasCharge',
          message: formatRateWarning(rr, 'Implied gas rate', '/Therm'),
        });
      }
    }
    // Wood River Energy: validate $/MMbtu rate (expected ~$3–$9/MMbtu)
    const _vMMbtu = pf(extracted.NaturalGasMMbtu);
    const _vTotal = pf(extracted.TotalCurrentCharges);
    if (_vMMbtu > 0 && _vTotal > 0 && /wood\s*river/i.test(_vUtilName)) {
      const impliedRate = _vTotal / _vMMbtu;
      if (impliedRate < 1.0 || impliedRate > 20.0) {
        warnings.push({
          level: 'warn',
          field: 'NaturalGasMMbtu',
          message:
            'Implied Wood River rate $' + impliedRate.toFixed(4) + '/MMbtu is outside expected range ($1–$20/MMbtu)',
        });
      }
    }
  } else if (_vComm === 'propane') {
    const _vUsage = pf(extracted.PropaneGallons || extracted.Quantity);
    const _vCharge = pf(extracted.Subtotal || extracted.PropaneCharge);
    if (_vUsage > 0 && _vCharge > 0) {
      const rr = validateImpliedRate('Propane', _vUsage, _vCharge, _vUtilName);
      if (rr && rr.severity) {
        warnings.push({
          level: rr.severity,
          field: 'PropaneGallons',
          message: formatRateWarning(rr, 'Implied propane rate', '/Gal'),
        });
      }
    }
  } else if (_vComm === 'electric' || _vComm === '') {
    const _vKwh = pf(extracted.kWhConsumed);
    const _vKwhCharge =
      pf(extracted.EnergyOnPeakCharge) +
      pf(extracted.EnergyOffPeakCharge) +
      pf(extracted.ECACharge) +
      pf(extracted.EERCharge) +
      pf(extracted.PTSCharge);
    if (_vKwh > 0 && _vKwhCharge > 0) {
      const rr = validateImpliedRate('Electric', _vKwh, _vKwhCharge, _vUtilName);
      if (rr && rr.severity) {
        warnings.push({
          level: rr.severity,
          field: 'kWhConsumed',
          message: formatRateWarning(rr, 'Implied electric rate', '/kWh'),
        });
      }
    }
  }

  const isPropaneBill = (extracted.Commodity || '').toLowerCase() === 'propane' || (extracted.FuelType || '') !== '';
  const days = pf(extracted.NumberOfDays);
  if (days > 0 && (days < 10 || days > 90) && !isPropaneBill) {
    warnings.push({
      level: 'warn',
      field: 'NumberOfDays',
      message: days + ' days is unusual — typical billing period is 28-33 days',
    });
  }

  // Validate date format and logic
  if (extracted.BillingPeriodStart && extracted.BillingPeriodEnd) {
    try {
      const s = new Date(extracted.BillingPeriodStart),
        e = new Date(extracted.BillingPeriodEnd);
      if (e < s) {
        const tmp = extracted.BillingPeriodStart;
        extracted.BillingPeriodStart = extracted.BillingPeriodEnd;
        extracted.BillingPeriodEnd = tmp;
        warnings.push({
          level: 'info',
          field: 'BillingPeriodEnd',
          message: 'Dates were reversed — swapped start/end',
        });
      } else if (+e === +s) {
        warnings.push({
          level: 'error',
          field: 'BillingPeriodEnd',
          message: 'End date equals start date',
        });
      }
      if (e > new Date(Date.now() + 86400000 * 60))
        warnings.push({
          level: 'warn',
          field: 'BillingPeriodEnd',
          message: 'End date is in the future — possible OCR misread',
        });
    } catch (ex) {}
  }

  // Validate kWh is reasonable (non-zero for electric)
  if (utilityName === 'Evergy') {
    const kwh = pf(extracted.kWhConsumed);
    if (kwh > 0 && kwh < 10)
      warnings.push({
        level: 'warn',
        field: 'kWhConsumed',
        message: kwh + ' kWh seems very low — possible OCR misread',
      });
    if (kwh > 5000000)
      warnings.push({
        level: 'warn',
        field: 'kWhConsumed',
        message: kwh.toLocaleString() + ' kWh seems very high — possible OCR misread',
      });
  }

  // kWh identity check: On-Peak + Off-Peak should equal kWh Consumed
  if (extracted._kwh_identity_mismatch) {
    const m = extracted._kwh_identity_mismatch;
    warnings.push({
      level: 'warn',
      field: 'kWhConsumed',
      message:
        'On-Peak (' +
        m.onPeakKwh.toLocaleString() +
        ') + Off-Peak (' +
        m.offPeakKwh.toLocaleString() +
        ') = ' +
        (m.onPeakKwh + m.offPeakKwh).toLocaleString() +
        ' but kWh Consumed = ' +
        m.total.toLocaleString() +
        ' (diff: ' +
        m.diff.toFixed(1) +
        ')',
    });
  }

  // Gas: usage > 0 should have charge > 0 — attempt recovery from total
  const gasUsage = pf(extracted.NaturalGasTherms) || pf(extracted.NaturalGasCCF) || pf(extracted.NaturalGasMMbtu);
  const gasCharge = pf(extracted.GasCharge);
  if (gasUsage > 0 && gasCharge <= 0) {
    const total = pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
    const custCharge = pf(extracted.CustomerCharge);
    const fuelAdj = pf(extracted.FuelAdjustment);
    // For KGS bills (identified by the presence of DeliveryCharge or GasSystemReliability),
    // subtract all KGS-specific line items so the recovery doesn't absorb them into GasCharge.
    // On non-KGS bills those fields are null/undefined so pf() returns 0 — this is safe.
    const isKGSGas =
      pf(extracted.DeliveryCharge) > 0 ||
      (extracted.GasSystemReliability !== null && extracted.GasSystemReliability !== undefined);
    let recovered;
    if (isKGSGas) {
      // Signed subtraction is intentional. Credit line items (e.g. GasSystemReliability /
      // WeatherNormalization "CR" credits) are stored as NEGATIVE numbers by the extractor.
      // The bill total already reflects those signed credits, so isolating GasCharge requires
      // subtracting the signed value. Using Math.abs() on a credit would REMOVE the credit
      // from the total twice and undercount GasCharge by 2× the credit amount.
      // Example: Total=105.34, CustChg=54.00, Delivery=2.58, GSRS=-1.24 (credit)
      //   Signed: 105.34 - 54.00 - 2.58 - (-1.24) = 50.00  ← correct
      //   Abs:    105.34 - 54.00 - 2.58 - 1.24    = 48.52  ← wrong (off by 2 × credit)
      recovered =
        total -
        custCharge -
        fuelAdj -
        pf(extracted.DeliveryCharge) -
        pf(extracted.GasSystemReliability) -
        pf(extracted.WeatherNormalization) -
        pf(extracted.WinterEventCost) -
        pf(extracted.FranchiseFee) -
        pf(extracted.DelayedPaymentCharge);
    } else {
      recovered = total - custCharge - fuelAdj;
    }
    if (recovered > 0) {
      // Round to 2 decimal places to prevent floating-point accumulation
      // (e.g. 104.48 - 54.00 = 50.480000000000004 without rounding)
      extracted.GasCharge = Number(recovered).toFixed(2);
      extracted['_auto_corrected_GasCharge'] = {
        original: gasCharge || 0,
        corrected: Number(recovered).toFixed(2),
        reason:
          'Derived from Total ($' +
          total.toFixed(2) +
          ') - Base ($' +
          custCharge.toFixed(2) +
          ')' +
          (fuelAdj ? ' - Fuel Adj ($' + fuelAdj.toFixed(2) + ')' : '') +
          (isKGSGas ? ' - KGS line items' : ''),
      };
    } else {
      warnings.push({
        level: 'warn',
        field: 'GasCharge',
        message: 'Gas usage is ' + gasUsage + ' but Gas Charge is $0 — could not auto-recover',
      });
    }
  }
  // Louisburg gas rate cross-check with date-aware rate schedule
  const _lbgGasRates = [{ effectiveDate: '2000-01-01', rate: 0.798062 }];
  if (gasUsage > 0 && (extracted.UtilityCompany || '').includes('Louisburg')) {
    let billDate = extracted.BillingPeriodEnd || extracted.BillingPeriodStart || extracted.BillDate || '';
    const _bdParts = billDate.split('/');
    const billISO =
      _bdParts.length === 3
        ? (_bdParts[2].length === 2 ? '20' + _bdParts[2] : _bdParts[2]) +
          '-' +
          _bdParts[0].padStart(2, '0') +
          '-' +
          _bdParts[1].padStart(2, '0')
        : '';
    let _lbgRate = _lbgGasRates[0].rate;
    for (const r of _lbgGasRates) {
      if (billISO >= r.effectiveDate) _lbgRate = r.rate;
    }
    const actualGasCharge = pf(extracted.GasCharge);
    if (actualGasCharge > 0) {
      const expectedCharge = gasUsage * _lbgRate;
      const chargeDiff = Math.abs(actualGasCharge - expectedCharge);
      if (chargeDiff > 1.0) {
        const actualRate = actualGasCharge / gasUsage;
        warnings.push({
          level: 'info',
          field: 'GasCharge',
          message:
            'Rate check: $' +
            actualRate.toFixed(6) +
            '/therm (expected $' +
            _lbgRate.toFixed(6) +
            '/therm as of ' +
            billISO +
            '). Charge diff: $' +
            chargeDiff.toFixed(2),
        });
      }
    }
  }

  return warnings;
}

// Statistical outlier detection — compare against historical bills for same account/meter
// historicalCache (optional): pre-built { [normalizedAccountNumber]: bill[] } map from _postExtractionVerify.
// When provided, skips the redundant project walk; falls back to walking projects if absent.
function detectStatisticalOutliers(extracted, historicalCache, pdfBillsIndex) {
  const warnings = [];
  if (!extracted || !extracted.AccountNumber) return warnings;
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const acct = (extracted.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();

  const extComm = (extracted.Commodity || '').toLowerCase();
  const historicalBills = [];

  if (historicalCache && historicalCache[acct]) {
    // Use pre-built cache: filter by commodity match, same as the original walk
    for (const b of historicalCache[acct]) {
      const bc = (b.commodity || b.Commodity || '').toLowerCase();
      if (!extComm || !bc || extComm === bc) historicalBills.push(b);
    }
  } else {
    // Fallback: original project walk (keeps backward compatibility)
    for (const proj of typeof projects !== 'undefined' ? projects : []) {
      const udProj = getUDProj(proj.id);
      for (const bldg of udProj.buildings || []) {
        for (const m of bldg.meters || []) {
          const ma = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
          if (acct && ma && acct === ma) {
            const mc = (m.commodity || '').toLowerCase();
            if (!extComm || !mc || extComm === mc) {
              for (const b of m.bills || []) {
                historicalBills.push(b);
              }
            }
          }
        }
      }
    }
  }

  const candidates = (pdfBillsIndex && pdfBillsIndex[acct]) || (!pdfBillsIndex ? sget('en_pdf_bills', []) || [] : []);
  for (const b of candidates) {
    const ba = (b.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    const bc = (b.Commodity || b.commodity || '').toLowerCase();
    if (acct && ba && acct === ba && (!extComm || !bc || extComm === bc)) historicalBills.push(b);
  }

  if (historicalBills.length < 3) return warnings; // Need at least 3 historical bills for meaningful stats

  // Helper: compute mean and stddev for a numeric field across historical bills
  function getStats(bills, fieldOrFn) {
    const vals = bills
      .map((b) => (typeof fieldOrFn === 'function' ? fieldOrFn(b) : pf(b[fieldOrFn])))
      .filter((v) => v !== null && v !== undefined && !isNaN(v));
    if (vals.length < 3) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const stddev = Math.sqrt(variance);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { mean, stddev, min, max, count: vals.length };
  }

  // Check kWh
  const kwhVal = pf(extracted.kWhConsumed);
  if (kwhVal > 0) {
    const kwhStats = getStats(historicalBills, (b) => pf(b.kwh || b.kWhConsumed));
    if (kwhStats) {
      const zScore = kwhStats.stddev > 0 ? Math.abs(kwhVal - kwhStats.mean) / kwhStats.stddev : 0;
      if (zScore > 3) {
        warnings.push({
          level: 'warn',
          field: 'kWhConsumed',
          message:
            'Statistical outlier: ' +
            kwhVal.toLocaleString() +
            ' kWh is ' +
            zScore.toFixed(1) +
            'σ from average ' +
            Math.round(kwhStats.mean).toLocaleString() +
            ' kWh (based on ' +
            kwhStats.count +
            ' bills)',
        });
      } else if (kwhVal > kwhStats.max * 2 || kwhVal < kwhStats.min * 0.3) {
        warnings.push({
          level: 'info',
          field: 'kWhConsumed',
          message:
            'Unusual: ' +
            kwhVal.toLocaleString() +
            ' kWh vs historical range ' +
            Math.round(kwhStats.min).toLocaleString() +
            '–' +
            Math.round(kwhStats.max).toLocaleString() +
            ' kWh',
        });
      }
    }
  }

  // Check total charges
  const totalVal = pf(extracted.TotalCurrentCharges || extracted.TotalAmountDue);
  if (totalVal > 0) {
    const totalStats = getStats(historicalBills, (b) => pf(b.totalCost || b.TotalCurrentCharges || b.TotalAmountDue));
    if (totalStats) {
      const zScore = totalStats.stddev > 0 ? Math.abs(totalVal - totalStats.mean) / totalStats.stddev : 0;
      if (zScore > 3) {
        warnings.push({
          level: 'warn',
          field: 'TotalCurrentCharges',
          message:
            'Statistical outlier: $' +
            totalVal.toFixed(2) +
            ' is ' +
            zScore.toFixed(1) +
            'σ from average $' +
            totalStats.mean.toFixed(2) +
            ' (based on ' +
            totalStats.count +
            ' bills)',
        });
      } else if (totalVal > totalStats.max * 2 || totalVal < totalStats.min * 0.3) {
        warnings.push({
          level: 'info',
          field: 'TotalCurrentCharges',
          message:
            'Unusual: $' +
            totalVal.toFixed(2) +
            ' vs historical range $' +
            totalStats.min.toFixed(2) +
            '–$' +
            totalStats.max.toFixed(2),
        });
      }
    }
  }

  // Check demand kW (electric only)
  const demandVal = pf(extracted.ActualKW || extracted.BilledKW);
  if (demandVal > 0) {
    const demStats = getStats(historicalBills, (b) => pf(b.demandKW || b.ActualKW || b.billedKW || b.BilledKW));
    if (demStats) {
      const zScore = demStats.stddev > 0 ? Math.abs(demandVal - demStats.mean) / demStats.stddev : 0;
      if (zScore > 3) {
        warnings.push({
          level: 'warn',
          field: 'ActualKW',
          message:
            'Statistical outlier: ' +
            demandVal +
            ' kW is ' +
            zScore.toFixed(1) +
            'σ from average ' +
            demStats.mean.toFixed(1) +
            ' kW',
        });
      }
    }
  }

  // Implied rate check — works with 0 historical bills using KNOWN_RATES
  const _rateChecks = [];
  const _comm = (extracted.Commodity || '').toLowerCase();
  if (_comm === 'gas') {
    const gasUsage = pf(extracted.NaturalGasTherms);
    const gasCharge = pf(extracted.GasCharge);
    if (gasUsage > 0 && gasCharge > 0) {
      const utilName = extracted._utilityName || extracted.UtilityCompany || '';
      _rateChecks.push({
        field: 'GasCharge',
        usage: gasUsage,
        charge: gasCharge,
        label: '$/Therm',
        comm: 'Gas',
        utilName,
      });
    }
    // Wood River: $/MMbtu rate check
    const mmbtuUsage = pf(extracted.NaturalGasMMbtu);
    const mmbtuCharge = pf(extracted.TotalCurrentCharges);
    if (mmbtuUsage > 0 && mmbtuCharge > 0) {
      const utilName = extracted._utilityName || extracted.UtilityCompany || '';
      _rateChecks.push({
        field: 'NaturalGasMMbtu',
        usage: mmbtuUsage,
        charge: mmbtuCharge,
        label: '$/MMbtu',
        comm: 'Gas',
        utilName,
      });
    }
  } else if (_comm === 'electric' || _comm === '') {
    const kwhUsage = pf(extracted.kWhConsumed);
    const kwhCharge = pf(extracted.EnergyOnPeakCharge) + pf(extracted.EnergyOffPeakCharge);
    if (kwhUsage > 0 && kwhCharge > 0) {
      _rateChecks.push({
        field: 'kWhConsumed',
        usage: kwhUsage,
        charge: kwhCharge,
        label: '$/kWh',
        comm: 'Electric',
        utilName: '',
      });
    }
  } else if (_comm === 'propane') {
    const propUsage = pf(extracted.PropaneGallons || extracted.Quantity);
    const propCharge = pf(extracted.Subtotal || extracted.PropaneCharge);
    if (propUsage > 0 && propCharge > 0) {
      _rateChecks.push({
        field: 'PropaneGallons',
        usage: propUsage,
        charge: propCharge,
        label: '$/Gal',
        comm: 'Propane',
        utilName: '',
      });
    }
  }
  for (const rc of _rateChecks) {
    const rateResult = validateImpliedRate(rc.comm, rc.usage, rc.charge, rc.utilName);
    if (rateResult && rateResult.severity) {
      warnings.push({
        level: rateResult.severity,
        field: rc.field,
        message: formatRateWarning(rateResult, 'Implied rate', rc.label),
      });
    }
  }

  return warnings;
}

// Analyze saved meter bills for statistical outliers — returns {billId: [{msg,level},...]}
function _billNormMonth(b) {
  if (!b.start || !b.end) return -1;
  const s = _parseISO(b.start);
  const e = _parseISO(b.end);
  if (isNaN(s) || isNaN(e)) return -1;
  const sm = s.getMonth(),
    em = e.getMonth();
  if (sm === em) return sm;
  const lastOfStart = new Date(s.getFullYear(), sm + 1, 0).getDate();
  const daysInStart = lastOfStart - s.getDate() + 1;
  const daysInEnd = e.getDate();
  return daysInStart >= daysInEnd ? sm : em;
}
function _monthToSeason(m) {
  if (m === 11 || m === 0 || m === 1) return 'winter';
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  return 'fall';
}
const _MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _analyzeMeterBills(bills, m) {
  const flags = {};
  if (bills.length < 4) return flags;
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';

  function stats(vals) {
    // Include 0 as valid data; only exclude null/undefined/NaN (missing readings)
    const clean = vals.filter((v) => v !== null && v !== undefined && !isNaN(v) && typeof v === 'number');
    if (clean.length < 2) return null;
    const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
    const stddev = Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length);
    return { mean, stddev, count: clean.length };
  }
  function medianOf(arr) {
    // Compute median of a numeric array, ignoring null/undefined/NaN.
    const clean = arr.filter((v) => v !== null && v !== undefined && !isNaN(v) && typeof v === 'number' && v > 0);
    if (clean.length === 0) return null;
    const sorted = clean.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  // rawFn: null-preserving variant used only for stats() so the null-aware filter
  // at stats() line can actually exclude missing readings from mean/stddev.
  // fn remains unchanged (always returns a number) for the z-score path.
  const _raw = (v) => (v != null && v !== '' ? parseFloat(String(v).replace(/,/g, '')) : null);
  const checks = [];
  if (isElec) {
    checks.push({ field: 'kwh', label: 'kWh', fn: (b) => pf(b.kwh), rawFn: (b) => _raw(b.kwh), seasonal: true });
    checks.push({
      field: 'totalCost',
      label: 'Total Cost',
      fn: (b) => pf(b.totalCost),
      rawFn: (b) => _raw(b.totalCost),
      seasonal: true,
    });
    checks.push({
      field: 'demandKW',
      label: 'Demand kW',
      fn: (b) => pf(b.demandKW),
      rawFn: (b) => _raw(b.demandKW),
      seasonal: true,
    });
  } else if (isGas) {
    checks.push({
      field: 'therms',
      label: 'Therms',
      fn: (b) => pf(b.therms),
      rawFn: (b) => _raw(b.therms),
      seasonal: true,
    });
    checks.push({
      field: 'thermCost',
      label: 'Cost',
      fn: (b) => pf(b.thermCost || b.totalCost),
      rawFn: (b) => _raw(b.thermCost != null ? b.thermCost : b.totalCost),
      seasonal: true,
    });
  } else {
    checks.push({
      field: 'usage',
      label: 'Usage',
      fn: (b) => pf(b.usage || b.kwh),
      rawFn: (b) => _raw(b.usage != null ? b.usage : b.kwh),
      seasonal: true,
    });
    checks.push({
      field: 'cost',
      label: 'Cost',
      fn: (b) => pf(b.cost || b.totalCost),
      rawFn: (b) => _raw(b.cost != null ? b.cost : b.totalCost),
      seasonal: true,
    });
  }
  checks.push({
    field: 'days',
    label: 'Days',
    seasonal: false,
    fn: (b) => {
      if (!b.start || !b.end) return 0;
      return Math.round((_parseISO(b.end) - _parseISO(b.start)) / 86400000) + 1;
    },
    rawFn: (b) => {
      if (!b.start || !b.end) return null;
      return Math.round((_parseISO(b.end) - _parseISO(b.start)) / 86400000) + 1;
    },
  });

  const missingChecks = isElec
    ? ['kwh', 'totalCost', 'start', 'end']
    : isGas
      ? ['therms', 'start', 'end']
      : ['start', 'end'];

  const normMonths = bills.map(_billNormMonth);
  const seasons = normMonths.map((nm) => (nm >= 0 ? _monthToSeason(nm) : null));

  const allStats = {};
  const monthStats = {};
  const seasonStats = {};
  for (const c of checks) {
    // Use rawFn (null-preserving) for stats so missing readings don't
    // contribute a false 0 to mean/stddev. fn is kept for the z-score path.
    const rawVals = bills.map(c.rawFn);
    allStats[c.field] = stats(rawVals);
    if (!c.seasonal) continue;
    const byMonth = {};
    const bySeason = {};
    for (let i = 0; i < bills.length; i++) {
      const v = rawVals[i];
      const nm = normMonths[i];
      const sn = seasons[i];
      if (nm >= 0) {
        if (!byMonth[nm]) byMonth[nm] = [];
        byMonth[nm].push(v);
      }
      if (sn) {
        if (!bySeason[sn]) bySeason[sn] = [];
        bySeason[sn].push(v);
      }
    }
    monthStats[c.field] = {};
    for (const k in byMonth) monthStats[c.field][k] = stats(byMonth[k]);
    seasonStats[c.field] = {};
    for (const k in bySeason) seasonStats[c.field][k] = stats(bySeason[k]);
  }

  bills.forEach((b, idx) => {
    const rowFlags = [];
    const nm = normMonths[idx];
    const sn = seasons[idx];

    for (const c of checks) {
      const val = c.fn(b);
      if (val <= 0) continue;

      let s = null;
      let compLabel = 'avg';

      // sameMonthPeers: array of { val, days } for same-month leave-one-out peers.
      // Used for per-day normalization in the ratio check below.
      let sameMonthPeers = null;
      const sameMonthVals = [];
      if (c.seasonal && nm >= 0) {
        // Leave-one-out: build same-month stats excluding the current bill (idx)
        // so an outlier cannot inflate its own peer group and escape detection.
        // rawFn is used (null-preserving) to match how monthStats was built.
        sameMonthPeers = [];
        for (let i = 0; i < bills.length; i++) {
          if (i === idx) continue; // exclude self
          if (normMonths[i] === nm) {
            const v = c.rawFn(bills[i]);
            sameMonthVals.push(v);
            // Collect per-peer day count for per-day normalization
            const peerDays =
              bills[i].start && bills[i].end
                ? Math.round((_parseISO(bills[i].end) - _parseISO(bills[i].start)) / 86400000) + 1
                : null;
            sameMonthPeers.push({ val: v, days: peerDays });
          }
        }
        const ms = stats(sameMonthVals);
        if (ms && ms.count >= 2) {
          s = ms;
          compLabel = _MONTH_LABELS[nm] + ' avg';
        }
      }
      if (!s && c.seasonal && sn) {
        const ss = seasonStats[c.field] && seasonStats[c.field][sn];
        if (ss && ss.count >= 3) {
          s = ss;
          compLabel = sn + ' avg';
        }
      }
      if (!s) {
        s = allStats[c.field];
        compLabel = 'avg';
      }

      if (!s || s.count < 2) continue;

      // ── Order-of-magnitude ratio-to-median band check ──
      // Purpose: catch only decimal-shift / digit-loss errors (e.g. 11,000 or
      // 1,110,000 vs a ~110,000 norm). Normal weather/occupancy variation (±13%)
      // must never flag. Bands:
      //   usage/cost/demand: flag if ratio < 0.2 or > 5.0
      //   days (billing period length): flag if ratio < 0.5 or > 2.0
      // For usage/cost/demand fields, compare on a per-day basis so different-
      // length billing periods don't create false positives.

      const isDaysField = c.field === 'days';
      const loBand = isDaysField ? 0.5 : 0.2;
      const hiBand = isDaysField ? 2.0 : 5.0;

      // Determine the this-bill's day count for per-day normalization.
      const thisDays =
        !isDaysField && b.start && b.end ? Math.round((_parseISO(b.end) - _parseISO(b.start)) / 86400000) + 1 : null;

      // Compute the median peer value.
      // Same-month path: compute from the raw sameMonthVals list directly.
      // Season/all-bills path: only s.mean is available — use it as median proxy.
      let medianPeer;
      let medianPeerLabel;
      if (sameMonthPeers !== null && sameMonthVals.length >= 2) {
        if (!isDaysField && thisDays > 0) {
          // Per-day median: divide each peer value by its own day count.
          const perDayPeerVals = sameMonthPeers
            .filter((p) => p.val !== null && !isNaN(p.val) && p.val > 0 && p.days > 0)
            .map((p) => p.val / p.days);
          medianPeer = medianOf(perDayPeerVals);
          medianPeerLabel = compLabel + ' median/day';
        } else {
          medianPeer = medianOf(sameMonthVals);
          medianPeerLabel = compLabel + ' median';
        }
      } else {
        // Season or all-bills fallback: use mean as proxy for median.
        // Per-day normalization not possible (no per-peer day counts stored).
        medianPeer = s.mean > 0 ? s.mean : null;
        medianPeerLabel = compLabel + ' median';
      }

      if (!medianPeer || medianPeer <= 0) continue;

      // Compute the ratio to flag.
      let compareVal = val;
      let compareMedian = medianPeer;
      if (!isDaysField && thisDays > 0 && sameMonthPeers !== null && sameMonthVals.length >= 2) {
        // Use per-day ratio for same-month path when day counts available.
        compareVal = val / thisDays;
        compareMedian = medianPeer; // already per-day from the block above
      }

      const ratio = compareVal / compareMedian;
      if (ratio < loBand || ratio > hiBand) {
        rowFlags.push({
          field: c.field,
          msg:
            c.label +
            ' (' +
            val.toLocaleString(undefined, { maximumFractionDigits: 1 }) +
            ') is ' +
            ratio.toFixed(2) +
            '× of ' +
            medianPeerLabel +
            ' ' +
            (isDaysField
              ? medianPeer.toLocaleString(undefined, { maximumFractionDigits: 1 })
              : (
                  medianPeer *
                  (!isDaysField && thisDays > 0 && sameMonthPeers !== null && sameMonthVals.length >= 2 ? thisDays : 1)
                ).toLocaleString(undefined, { maximumFractionDigits: 1 })),
          level: 'warn',
        });
      }
    }

    // ── Overlap detection ──
    // Flag bills where date ranges overlap with other bills on the same meter
    // by more than 3 days (matches the renderBillsPane visual overlap threshold).
    if (b.start && b.end) {
      const bStart = _parseISO(b.start);
      const bEnd = _parseISO(b.end);
      for (const other of bills) {
        if (other.id === b.id || !other.start || !other.end) continue;
        const oStart = _parseISO(other.start);
        const oEnd = _parseISO(other.end);
        if (oStart <= bEnd && oEnd >= bStart) {
          const overlapMs = Math.min(bEnd, oEnd) - Math.max(bStart, oStart);
          const overlapDays = Math.round(overlapMs / 86400000);
          if (overlapDays > 3) {
            rowFlags.push({
              field: 'start',
              msg:
                'Overlapping billing period — ' +
                overlapDays +
                ' day' +
                (overlapDays !== 1 ? 's' : '') +
                ' overlap with ' +
                other.start +
                '–' +
                other.end,
              level: 'error',
            });
            break; // one overlap flag per bill is sufficient
          }
        }
      }
    }

    // ── Year-over-year spike ──
    // Flag usage that deviates >150% vs the same normalized month in the prior year.
    // Threshold is intentionally high (150%) so only order-of-magnitude errors flag —
    // normal weather-driven YoY variation (even ±50–80%) must not trigger this check.
    // "Normalized month" = the calendar month the billing period represents by majority
    // billing days — computed via _billNormMonth(), the same function used by the ratio
    // path above. This replaces the former month*30+day linearization that
    // selected the wrong prior-year bill for meters billed mid-month (e.g. Evergy Kansas).
    // When ≥2 prior same-month bills exist the ratio path already handles the comparison;
    // this YoY check is the fallback for when exactly 1 prior same-month bill is available.
    // P2: use full multi-year history — skip YoY check when monthStats has ≥2 same-month
    // bills so the ratio path (which uses all years) is the sole decision-maker.
    const _usageField = isElec ? 'kwh' : isGas ? 'therms' : 'usage';
    const _usageFn = checks.find((c) => c.field === _usageField);
    if (_usageFn && b.start && b.end) {
      const thisUsage = _usageFn.fn(b);
      const thisNormMonth = nm; // nm = normMonths[idx], already computed above at line 763
      if (thisUsage > 0 && thisNormMonth >= 0) {
        // Skip YoY check when ≥2 PRIOR same-normalized-month bills exist (i.e. total
        // count in monthStats ≥ 3, since monthStats includes the current bill itself).
        // When count ≥ 3, the ratio-band path above already ran a multi-year comparison.
        // When count = 2 (exactly 1 prior same-month bill + current), the ratio band
        // can be ambiguous with only one peer, so we keep this 150% raw YoY fallback.
        const sameMonthCount =
          (_usageFn.seasonal !== false &&
            monthStats[_usageField] &&
            monthStats[_usageField][thisNormMonth] &&
            monthStats[_usageField][thisNormMonth].count) ||
          0;
        if (sameMonthCount < 3) {
          const thisDate = _parseISO(b.start);
          const thisYear = thisDate.getFullYear();
          // Find the bill whose normalized month matches this bill's normalized month
          // AND whose start year is exactly thisYear - 1.
          const priorYearBill = bills.find((other) => {
            if (!other.start || !other.end || other.id === b.id) return false;
            const otherYear = _parseISO(other.start).getFullYear();
            if (otherYear !== thisYear - 1) return false;
            return _billNormMonth(other) === thisNormMonth;
          });
          if (priorYearBill) {
            const priorUsage = _usageFn.fn(priorYearBill);
            if (priorUsage > 0) {
              const deviation = Math.abs(thisUsage - priorUsage) / priorUsage;
              if (deviation > 1.5) {
                const pct = Math.round(deviation * 100);
                rowFlags.push({
                  field: _usageField,
                  msg:
                    'Year-over-year spike: ' +
                    thisUsage.toLocaleString(undefined, { maximumFractionDigits: 1 }) +
                    ' vs prior year ' +
                    priorUsage.toLocaleString(undefined, { maximumFractionDigits: 1 }) +
                    ' (' +
                    (thisUsage > priorUsage ? '+' : '-') +
                    pct +
                    '%)',
                  level: 'warn',
                });
              }
            }
          }
        }
      }
    }

    // ── Rate anomaly ──
    // Flag bills where the implied $/unit deviates >30% from the trailing 6-bill average.
    // Requires at least 3 prior bills to compute a baseline.
    {
      const _rateFn = (() => {
        if (isElec) {
          return (bill) => {
            const u = pf(bill.kwh);
            const c = pf(bill.totalCost);
            return u > 0 && c > 0 ? c / u : 0;
          };
        } else if (isGas) {
          return (bill) => {
            const u = pf(bill.therms);
            const c = pf(bill.gasCharge) || pf(bill.thermCost) || pf(bill.totalCost);
            return u > 0 && c > 0 ? c / u : 0;
          };
        } else {
          return (bill) => {
            const u = pf(bill.usage || bill.waterUsage || bill.gallonsDelivered);
            const c = pf(bill.cost || bill.totalCost);
            return u > 0 && c > 0 ? c / u : 0;
          };
        }
      })();
      const thisRate = _rateFn(b);
      if (thisRate > 0) {
        // Build trailing 6-bill window (bills before this one by start date)
        const billIdx = bills.indexOf(b);
        const priorBills = bills.filter((_, i) => i !== billIdx).slice(0, billIdx < 6 ? billIdx : 6);
        const priorRates = priorBills.map(_rateFn).filter((r) => r > 0);
        if (priorRates.length >= 3) {
          const trailingAvg = priorRates.reduce((a, v) => a + v, 0) / priorRates.length;
          if (trailingAvg > 0) {
            const deviation = Math.abs(thisRate - trailingAvg) / trailingAvg;
            if (deviation > 0.3) {
              rowFlags.push({
                field: 'totalCost',
                msg:
                  'Rate anomaly: $' +
                  thisRate.toFixed(4) +
                  '/unit vs trailing avg $' +
                  trailingAvg.toFixed(4) +
                  '/unit (' +
                  (thisRate > trailingAvg ? '+' : '-') +
                  Math.round(deviation * 100) +
                  '%)',
                level: 'warn',
              });
            }
          }
        }
      }
    }

    for (const f of missingChecks) {
      const v = b[f];
      if (v === null || v === undefined || v === '') {
        rowFlags.push({ field: f, msg: 'Missing ' + f + ' — this field is typically present', level: 'warn' });
      }
    }

    // ── Charge-without-usage detection ──
    // Flag rows where a commodity charge exists but the corresponding usage quantity is missing.
    if (isGas) {
      const _gc = pf(b.gasCharge) + pf(b.fuelAdjustment);
      const _gu = pf(b.naturalGasTherms) + pf(b.naturalGasCCF) + pf(b.therms);
      if (_gc > 0 && _gu === 0) {
        rowFlags.push({
          field: 'therms',
          msg: 'Gas charge ($' + _gc.toFixed(2) + ') but no gas usage — check for missing Therms/CCF',
          level: 'warn',
        });
      }
    } else if (isElec) {
      const _ec = pf(b.kwhCost) + pf(b.onPeakCost) + pf(b.offPeakCost);
      const _eu = pf(b.kwh);
      if (_ec > 0 && _eu === 0) {
        rowFlags.push({
          field: 'kwh',
          msg: 'Electric charge ($' + _ec.toFixed(2) + ') but no kWh usage — check for missing consumption',
          level: 'warn',
        });
      }
    }
    const isWater = (m.commodity || '').toLowerCase() === 'water';
    if (isWater) {
      const _wc = pf(b.waterCharge);
      const _wu = pf(b.waterUsage);
      if (_wc > 0 && _wu === 0) {
        rowFlags.push({
          field: 'waterUsage',
          msg: 'Water charge ($' + _wc.toFixed(2) + ') but no water usage — check for missing gallons',
          level: 'warn',
        });
      }
    }

    if (rowFlags.length) flags[b.id] = rowFlags;
  });
  return flags;
}

// ── WATER vs SEWER PARITY CHECK ──
// Detects months where water and sewer usage diverge beyond a plausible band,
// which is a strong signal of an OCR misread on one side.
//
// Thresholds: flag when water/sewer ratio < LO or > HI.
// City of Louisburg charges sewer as a fraction of water, so the ratio can
// legitimately be >1.0. The band is intentionally wide — this is a dismissible
// warning, never an auto-correction.
const _WSP_LO = 0.5; // flag if wu/su < 0.5 (sewer >> water by >2×)
const _WSP_HI = 2.0; // flag if wu/su > 2.0 (water >> sewer by >2×)

/**
 * Cross-meter parity check: compares Water and Sewer meter bills for the same
 * building by normalized month+year. Appends warning flags to both bills when
 * usage diverges beyond the _WSP_LO / _WSP_HI band.
 *
 * NON-DESTRUCTIVE: never mutates usage values. Only appends to bill._flags.
 *
 * @param {object} building  - Building object with .meters[]
 */
function _analyzeWaterSewerParity(building) {
  if (!building || !Array.isArray(building.meters)) return;

  const waterMeter = building.meters.find((m) => (m.commodity || '') === 'Water');
  const sewerMeter = building.meters.find((m) => (m.commodity || '') === 'Sewer');
  if (!waterMeter || !sewerMeter) return;

  const waterBills = waterMeter.bills || [];
  const sewerBills = sewerMeter.bills || [];
  if (!waterBills.length || !sewerBills.length) return;

  const FLAG_ID = 'waterSewerParity_warn';
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const today = new Date().toISOString().slice(0, 10);

  // Build an index of sewer bills by normalized month+year key.
  // Key: "YYYY-MM" where MM is the 0-based month from _billNormMonth.
  // Uses end-date year so the key stays stable regardless of billing period start.
  function _wspNormKey(bill) {
    const nm = _billNormMonth(bill);
    if (nm < 0) return null;
    const e = _parseISO(bill.end);
    if (!e || isNaN(e)) return null;
    return e.getFullYear() + '-' + String(nm).padStart(2, '0');
  }

  const sewerByKey = {};
  for (const sb of sewerBills) {
    const k = _wspNormKey(sb);
    if (k) sewerByKey[k] = sb;
  }

  // Helper: compute a flag message for a (water, sewer) bill pair, or null if no flag.
  function _wspFlagMsg(wb, sb) {
    const wu = pf(wb.waterUsage);
    // Sewer bills may store usage in sewerUsage or waterUsage depending on provider.
    const su = pf(sb.sewerUsage) || pf(sb.waterUsage);
    const wCharge = pf(wb.waterCharge) || pf(wb.totalCost);
    const sCharge = pf(sb.sewerCharge) || pf(sb.totalCost);

    if (wu > 0 && su > 0) {
      const ratio = wu / su;
      if (ratio < _WSP_LO || ratio > _WSP_HI) {
        return (
          'Water vs sewer usage diverge: water=' +
          wu.toLocaleString() +
          ' gal, sewer=' +
          su.toLocaleString() +
          ' gal (' +
          ratio.toFixed(2) +
          '\xd7 ratio — likely OCR misread)'
        );
      }
    } else if (wu === 0 && su === 0) {
      // Both zero and both missing — no data to compare
      return null;
    } else if (wu === 0 && (su > 0 || sCharge > 0)) {
      return (
        'Water usage is 0 but sewer has usage/charge — water bill may be missing usage (sewer=' +
        su.toLocaleString() +
        ' gal, sewer charge=$' +
        sCharge.toFixed(2) +
        ')'
      );
    } else if (su === 0 && (wu > 0 || wCharge > 0)) {
      return (
        'Sewer usage is 0 but water has usage/charge — sewer bill may be missing usage (water=' +
        wu.toLocaleString() +
        ' gal, water charge=$' +
        wCharge.toFixed(2) +
        ')'
      );
    }
    return null;
  }

  // Helper: upsert or remove a parity flag on a bill object (mutates _flags only).
  function _wspApplyFlag(bill, flagMsg) {
    bill._flags = Array.isArray(bill._flags) ? bill._flags : [];
    const prev = bill._flags.find((f) => f.id === FLAG_ID);
    if (flagMsg) {
      if (!prev) {
        bill._flags.push({
          id: FLAG_ID,
          label: flagMsg,
          severity: 'warning',
          firedAt: today,
          dismissed: false,
          dismissNote: '',
        });
      } else {
        // Update label in case usage values changed (e.g. re-import after correction)
        prev.label = flagMsg;
      }
    } else {
      // No flag warranted — remove any non-dismissed parity flag
      if (prev && !prev.dismissed) {
        bill._flags = bill._flags.filter((f) => f.id !== FLAG_ID);
      }
    }
  }

  for (const wb of waterBills) {
    const k = _wspNormKey(wb);
    if (!k) continue;
    const sb = sewerByKey[k];
    if (!sb) continue;

    const flagMsg = _wspFlagMsg(wb, sb);
    _wspApplyFlag(wb, flagMsg);
    _wspApplyFlag(sb, flagMsg);
  }
}

// ── POST-EXTRACTION VERIFICATION ──
// Uses historical meter data + logical rules to fix extraction errors
async function _postExtractionVerify(bills, utilityName, rawText) {
  try {
    if (!bills.length) return { bills, historicalCache: {} };
    const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);

    // Calculate NumberOfDays from billing period dates when not extracted
    for (const b of bills) {
      if (!b.NumberOfDays && b.BillingPeriodStart && b.BillingPeriodEnd) {
        const _ps = String(b.BillingPeriodStart).split('/');
        const _pe = String(b.BillingPeriodEnd).split('/');
        if (_ps.length === 3 && _pe.length === 3) {
          const _ds = new Date(+(_ps[2].length === 2 ? '20' + _ps[2] : _ps[2]), +_ps[0] - 1, +_ps[1]);
          const _de = new Date(+(_pe[2].length === 2 ? '20' + _pe[2] : _pe[2]), +_pe[0] - 1, +_pe[1]);
          const _diff = Math.round((_de - _ds) / 86400000);
          if (_diff > 0 && _diff < 120) b.NumberOfDays = String(_diff);
        }
      }
    }

    // ── CROSS-BILL CONSENSUS ──
    // OCR misreads are random — the same field on 19 of 20 bills will be
    // correct while 1 has a garbled digit. For every identity/metadata field
    // that should be consistent across bills from the same account, find the
    // most common value and correct outliers. Groups bills by normalized
    // ServiceAddress to handle multi-building PDFs.
    //
    // FIX(2026-06-11): AccountNumber is intentionally EXCLUDED from consensus.
    // In multi-account PDFs (e.g. City of Baldwin City), each page is a distinct
    // building with its own account number.  Pages with garbled OCR account numbers
    // all cluster into the same "unknown" address group and the consensus logic was
    // overwriting their individual account numbers with the most-common one
    // (407070400), merging ~16 different buildings under one identity.
    // Account numbers must never be borrowed from other pages — use the page's own
    // value (P1-P5) or fall back to ServiceAddress as the identity key.
    //
    // FIX(2026-06-22): MeterNumber is ALSO EXCLUDED from address-based consensus.
    // Two DISTINCT gas meters can legitimately share one building/ServiceAddress
    // with DIFFERENT account AND meter numbers (e.g. the two Spring Hill Elementary
    // meters 540295/02446156C and 567885/9445777C at "Elem - 300 S Webster St", and
    // the two BofE meters 560189/T920419C and 560190/G0016134C). Address-grouped
    // "consensus" was a 1-of-2 coin flip that overwrote one meter's number with the
    // other's, collapsing two real meters into one identity and breaking/mis-routing
    // auto-match in findMeterMatch. Distinct meters sharing an address must NEVER be
    // merged or corrected toward each other. Only the SAME meter's own historical
    // readings may inform a digit correction — that lives in the per-bill recovery
    // loop below (gated on hist.length, a no-op when there is no prior history, e.g.
    // a first import like Spring Hill). Identity fields (AccountNumber, MeterNumber)
    // are never borrowed from sibling bills.
    if (bills.length > 1) {
      const _CONSENSUS_FIELDS = ['ServiceAddress', 'CustomerName', 'UtilityCompany', 'RateSchedule'];
      const _addrNorm = (s) => {
        let n = (s || 'unknown')
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, '')
          .trim();
        n = n
          .replace(/\b(drive|drv)\b/g, 'dr')
          .replace(/\b(street|str)\b/g, 'st')
          .replace(/\b(avenue|aven)\b/g, 'ave')
          .replace(/\b(boulevard|blvd)\b/g, 'blvd')
          .replace(/\b(road)\b/g, 'rd')
          .replace(/\b(lane)\b/g, 'ln')
          .replace(/\b(court)\b/g, 'ct')
          .replace(/\b(circle|cir)\b/g, 'cir')
          .replace(/\b(place)\b/g, 'pl');
        return n.replace(/\s+/g, '');
      };
      const _addrGroups = {};
      for (const b of bills) {
        const addr = _addrNorm(b.ServiceAddress);
        if (!_addrGroups[addr]) _addrGroups[addr] = [];
        _addrGroups[addr].push(b);
      }
      // If address OCR is garbled, most bills cluster at the same normalized
      // address. Merge tiny groups (≤2 bills) into the largest group — they're
      // almost certainly the same building with a garbled address.
      //
      // Two-tier identity check to prevent merging different accounts:
      //   PRIMARY (stable fields): AccountNumber, ServiceAddress
      //   SECONDARY (can change over time): RateSchedule, MeterNumber
      //
      // Primary determines the decision. Secondary verifies:
      //   - Account number conflict → always block (definitive)
      //   - Address conflict → block UNLESS secondary data says same (false positive)
      //   - No primary conflict but both secondaries conflict → block (false negative)
      const groupKeys = Object.keys(_addrGroups);
      if (groupKeys.length > 1) {
        const largest = groupKeys.reduce((a, b) => (_addrGroups[a].length >= _addrGroups[b].length ? a : b));
        const _idNorm = (v) => (v || '').replace(/[\s\-]/g, '').toLowerCase();
        const _addrWords = (v) =>
          (v || '')
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, '')
            .split(/\s+/)
            .filter(Boolean);
        const _valsFor = (group, field) => group.map((b) => _idNorm(b[field])).filter(Boolean);
        const _setsConflict = (smallVals, largeVals) => {
          if (smallVals.length === 0 || largeVals.length === 0) return false;
          const largeSet = new Set(largeVals);
          return smallVals.some((v) => !largeSet.has(v));
        };
        const _lgAccts = _valsFor(_addrGroups[largest], 'AccountNumber');
        const _lgAddrW = new Set(_addrGroups[largest].flatMap((b) => _addrWords(b.ServiceAddress)));
        const _lgRates = _valsFor(_addrGroups[largest], 'RateSchedule');
        const _lgMeters = _valsFor(_addrGroups[largest], 'MeterNumber');
        for (const k of groupKeys) {
          if (k !== largest && _addrGroups[k].length <= 2) {
            const sm = _addrGroups[k];
            const _acctConflict = _setsConflict(_valsFor(sm, 'AccountNumber'), _lgAccts);
            const _smAddrW = sm.flatMap((b) => _addrWords(b.ServiceAddress));
            const _addrOverlap =
              _smAddrW.length > 0 && _lgAddrW.size > 0
                ? _smAddrW.filter((w) => _lgAddrW.has(w)).length / _smAddrW.length
                : 1;
            const _addrConflict = _addrOverlap < 0.5;
            const _rateConflict = _setsConflict(_valsFor(sm, 'RateSchedule'), _lgRates);
            const _meterConflict = _setsConflict(_valsFor(sm, 'MeterNumber'), _lgMeters);
            if (_acctConflict) {
              continue;
            }
            if (_addrConflict) {
              const _hasSecondary = _lgRates.length > 0 || _lgMeters.length > 0;
              const _secondarySame = _hasSecondary && !_rateConflict && !_meterConflict;
              if (!_secondarySame) {
                continue;
              }
            }
            if (_rateConflict && _meterConflict) {
              continue;
            }
            _addrGroups[largest].push(..._addrGroups[k]);
            delete _addrGroups[k];
          }
        }
      }
      const _groupEntries = Object.entries(_addrGroups);
      for (const [_gKey, group] of _groupEntries) {
        if (group.length < 2) continue;
        for (const field of _CONSENSUS_FIELDS) {
          const counts = {};
          for (const b of group) {
            const v = b[field];
            if (v === null || v === undefined || v === '') continue;
            counts[v] = (counts[v] || 0) + 1;
          }
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          if (sorted.length < 2) continue;
          const winner = sorted[0][0];
          const winCount = sorted[0][1];
          let corrected = 0;
          for (const b of group) {
            if (b[field] && b[field] !== winner) {
              b['_auto_corrected_' + field] = {
                original: b[field],
                corrected: winner,
                reason: 'Consensus: ' + winCount + '/' + group.length + ' bills use "' + winner + '"',
              };
              b[field] = winner;
              corrected++;
            }
          }
        }
      }
    }

    // Gather historical bills for the same account
    function getHistorical(acct) {
      const hist = [];
      if (!acct) return hist;
      const acctClean = acct.replace(/[\s\-]/g, '').toLowerCase();
      for (const proj of typeof projects !== 'undefined' ? projects : []) {
        const udProj = getUDProj(proj.id);
        for (const bldg of udProj.buildings || []) {
          for (const m of bldg.meters || []) {
            if ((m.account || '').replace(/[\s\-]/g, '').toLowerCase() === acctClean) {
              for (const b of m.bills || []) hist.push(b);
            }
          }
        }
      }
      return hist;
    }

    // Fields that are almost always present on every bill for a given account
    const ALWAYS_PRESENT_FIELDS = {
      Evergy: [
        'CustomerCharge',
        'FacilitiesCharge',
        'BilledKWCharge',
        'EnergyOnPeakCharge',
        'ECACharge',
        'TDCCharge',
        'FranchiseFee',
        'TotalCurrentCharges',
        'kWhConsumed',
        'ActualKW',
        'RateSchedule',
        'CustomerName',
        'FacilitiesKW',
      ],
      _default: ['TotalCurrentCharges', 'TotalAmountDue'],
    };

    const alwaysFields = ALWAYS_PRESENT_FIELDS[utilityName] || ALWAYS_PRESENT_FIELDS._default;

    // Build account-number → historical bills map ONCE before the loop.
    // Replaces per-bill O(n) walk with a single O(stored) pass + O(1) lookups.
    const _historicalCache = {};
    (function _buildHistoricalCache() {
      for (const proj of typeof projects !== 'undefined' ? projects : []) {
        const udProj = getUDProj(proj.id);
        for (const bldg of udProj.buildings || []) {
          for (const m of bldg.meters || []) {
            const acct = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
            if (!acct) continue;
            if (!_historicalCache[acct]) _historicalCache[acct] = [];
            for (const b of m.bills || []) _historicalCache[acct].push(b);
          }
        }
      }
    })();

    const YIELD_EVERY = 10; // yield to event loop every N bills so cancel events and UI updates can process
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];

      // Yield every YIELD_EVERY bills so cancel-button clicks and progress updates can process
      if (i > 0 && i % YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const _acctKey = (b.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
      const hist = _historicalCache[_acctKey] || [];

      // 1. Auto-recover missing fields using raw text structure + historical data
      //    These fields are 100% present on every bill — if null, it's an OCR garble, not a missing field.
      //    Use structural position in the raw text as primary recovery, historical data as validation.
      if (hist.length >= 2) {
        const FIELD_MAP = {
          CustomerCharge: { saved: 'customerCharge' },
          FacilitiesCharge: { saved: 'facilitiesCharge' },
          FacilitiesKW: { saved: 'facKW' },
          RateSchedule: { saved: 'rateSchedule' },
          CustomerName: { saved: 'customerName' },
          BilledKWCharge: { saved: 'demandCharge' },
          EnergyOnPeakCharge: { saved: 'onPeakCost' },
        };
        for (const field of alwaysFields) {
          const val = b[field];
          if (val !== null && val !== undefined && val !== '') continue;
          const mapping = FIELD_MAP[field];
          if (!mapping) continue;
          // Include 0 as valid (a $0 charge is still a present field); exclude NaN (truly missing)
          const histVals = hist.map((h) => parseFloat(h[mapping.saved])).filter((v) => !isNaN(v));
          const presence = histVals.length / hist.length;
          if (presence >= 0.8) {
            // Try to recover from raw text using structural position before flagging
            let recovered = false;

            // For RateSchedule: grab from historical if consistent (rate doesn't change often)
            if (field === 'RateSchedule' && !recovered) {
              const histRates = hist.map((h) => h[mapping.saved]).filter((v) => v && v !== '');
              if (histRates.length > 0) {
                // Use most recent rate schedule
                b.RateSchedule = histRates[histRates.length - 1];
                b['_auto_recovered_' + field] = 'from historical data';
                recovered = true;
              }
            }

            // For CustomerName: grab from historical (name doesn't change)
            if (field === 'CustomerName' && !recovered) {
              const histNames = hist.map((h) => h[mapping.saved]).filter((v) => v && v !== '');
              if (histNames.length > 0) {
                b.CustomerName = histNames[histNames.length - 1];
                b['_auto_recovered_' + field] = 'from historical data';
                recovered = true;
              }
            }

            if (!recovered) {
              b['_likely_missing_' + field] = true;
            }
          }
        }

        // 2. Flag order-of-magnitude outliers (10x or 100x off) — do NOT auto-correct
        const numericChecks = [
          'kWhConsumed',
          'ActualKW',
          'TotalCurrentCharges',
          'CustomerCharge',
          'BilledKWCharge',
          'EnergyOnPeakCharge',
          'FacilitiesCharge',
        ];
        for (const field of numericChecks) {
          const val = pf(b[field]);
          if (val <= 0) continue;
          const SAVED_MAP = {
            kWhConsumed: 'kwh',
            ActualKW: 'demandKW',
            TotalCurrentCharges: 'totalCost',
            CustomerCharge: 'customerCharge',
            BilledKWCharge: 'demandCharge',
            EnergyOnPeakCharge: 'onPeakCost',
            FacilitiesCharge: 'facilitiesCharge',
          };
          const savedField = SAVED_MAP[field];
          if (!savedField) continue;
          const bComm = (b.Commodity || '').toLowerCase();
          const commHist = bComm ? hist.filter((h) => (h.commodity || '').toLowerCase() === bComm) : hist;
          // Include 0 as valid data; exclude NaN (truly missing). Keep mean<=0 guard for ratio safety.
          const histVals = commHist.map((h) => parseFloat(h[savedField])).filter((v) => !isNaN(v));
          if (histVals.length < 3) continue;
          const mean = histVals.reduce((a, c) => a + c, 0) / histVals.length;
          if (mean <= 0) continue;
          const ratio = val / mean;
          if (ratio >= 8 || ratio <= 0.12) {
            b['_magnitude_flag_' + field] = { value: val, mean, ratio };
          }
        }
      }

      // ── STORMWATER OCR DECIMAL-DROP FIX ──
      // City of Louisburg stormwater is always ~$4. OCR sometimes drops the
      // decimal, producing $400 instead of $4.00. Auto-correct when dividing
      // by 100 lands in the plausible $2–$10 range.
      if (b.Commodity === 'Stormwater' && typeof b.StormWaterCharge === 'number' && b.StormWaterCharge > 20) {
        const corrected = b.StormWaterCharge / 100;
        if (corrected >= 2 && corrected <= 10) {
          const original = b.StormWaterCharge;
          b._auto_corrected_StormWaterCharge = {
            original: original,
            corrected: corrected,
            reason: 'OCR decimal-drop: ' + original + ' → ' + corrected,
          };
          b.StormWaterCharge = corrected;
          b.TotalCurrentCharges = corrected.toFixed(2);
          b.TotalAmountDue = corrected.toFixed(2);
          console.log('[PostVerify] Stormwater decimal-drop corrected: $' + original + ' → $' + corrected);
        }
      }

      // ── GAS CHARGE OCR DECIMAL-DROP FIX (rate-validated) ──
      // Only apply decimal corrections when the corrected values produce
      // an implied rate closer to the known rate. Never blindly divide by
      // 100 based on magnitude alone — large buildings legitimately have
      // charges > $5k and usage > 10k therms.
      if (b.Commodity === 'Gas') {
        const _gc = pf(b.GasCharge);
        const _th = pf(b.NaturalGasTherms);
        const _utilName = b._utilityName || b.UtilityCompany || '';
        if (_gc > 0 && _th > 0) {
          const origRate = validateImpliedRate('Gas', _th, _gc, _utilName);
          if (origRate && origRate.severity === 'error') {
            // Rate is way off — try decimal correction candidates
            const candidates = [];
            // Candidate 1: correct charge only
            if (_gc > 500) {
              const cGC = Math.round(_gc) / 100;
              const r1 = validateImpliedRate('Gas', _th, cGC, _utilName);
              if (r1) candidates.push({ gc: cGC, th: _th, rate: r1, label: 'charge' });
            }
            // Candidate 2: correct therms only
            if (_th > 1000) {
              const cTh = Math.round(_th) / 100;
              const r2 = validateImpliedRate('Gas', cTh, _gc, _utilName);
              if (r2) candidates.push({ gc: _gc, th: cTh, rate: r2, label: 'therms' });
            }
            // Candidate 3: correct both
            if (_gc > 500 && _th > 1000) {
              const cGC = Math.round(_gc) / 100;
              const cTh = Math.round(_th) / 100;
              const r3 = validateImpliedRate('Gas', cTh, cGC, _utilName);
              if (r3) candidates.push({ gc: cGC, th: cTh, rate: r3, label: 'both' });
            }
            // Pick the candidate closest to the typical rate
            const best = candidates
              .filter((c) => !c.rate.severity || c.rate.severity === 'info')
              .sort((a, b) => Math.abs(a.rate.implied - a.rate.typical) - Math.abs(b.rate.implied - b.rate.typical))[0];
            if (best) {
              if (best.gc !== _gc) {
                b._auto_corrected_GasCharge = {
                  original: _gc,
                  corrected: best.gc,
                  reason:
                    'OCR decimal-drop: $' +
                    _gc +
                    ' → $' +
                    best.gc +
                    ' (implied rate $' +
                    best.rate.implied.toFixed(4) +
                    best.rate.unit +
                    ' matches expected)',
                };
                b.GasCharge = best.gc;
                console.log('[PostVerify] Gas charge rate-validated correction: $' + _gc + ' → $' + best.gc);
              }
              if (best.th !== _th) {
                b._auto_corrected_NaturalGasTherms = {
                  original: _th,
                  corrected: best.th,
                  reason:
                    'OCR decimal-drop: ' +
                    _th +
                    ' → ' +
                    best.th +
                    ' (implied rate $' +
                    best.rate.implied.toFixed(4) +
                    best.rate.unit +
                    ' matches expected)',
                };
                b.NaturalGasTherms = best.th;
                console.log('[PostVerify] Gas therms rate-validated correction: ' + _th + ' → ' + best.th);
              }
              // Recompute total from corrected components
              const _cust = pf(b.CustomerCharge);
              const _fa = pf(b.FuelAdjustment);
              if (best.gc > 0 && _cust > 0) {
                const newTotal = best.gc + _cust + _fa;
                b.TotalCurrentCharges = newTotal.toFixed(2);
                b.TotalAmountDue = newTotal.toFixed(2);
              }
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────────
      // Stage 3: Total validation + coherent per-charge reconciliation (Update 86)
      // ──────────────────────────────────────────────────────────────
      // The old code clobbered `TotalCurrentCharges` with compSum whenever they
      // disagreed by >$0.50, BEFORE running the per-charge math validators. If a
      // single charge had an OCR bleed (e.g. EER regex reaching forward to PTS's
      // $86.61), compSum was inflated and the clean OCR'd total got thrown away.
      //
      // Re-ordered so that reconciliation is purposeful:
      //   3a. Measure — read ocrTotal, compute compSum from current charges.
      //   3b. Reconcile per-charge math (Strategy B: rate×qty corrections that
      //       close the gap to ocrTotal → apply high-confidence fix).
      //   3c. Subtraction inference (Strategy C: a lone charge with no _rates
      //       entry absorbs the residual — OCR single-digit misread).
      //   3d. Final total decision:
      //       - ocrTotal missing  → use compSum.
      //       - compSum matches ocrTotal within $0.02 → keep ocrTotal.
      //       - compSum still > ocrTotal AND no _rate_mismatch_* flags remain
      //         → ocrTotal was likely a page-1 summary missing detail charges;
      //           accept compSum and mark _totalFromChargeSum with reason.
      //       - Residual remains → flag _sum_mismatch, keep ocrTotal for review.
      //       NEVER silently clobber ocrTotal when there's evidence of per-charge
      //       contamination.
      if (utilityName === 'Evergy') {
        const CHARGE_FIELDS = [
          'CustomerCharge',
          'FacilitiesCharge',
          'BilledKWCharge',
          'EnergyOnPeakCharge',
          'EnergyOffPeakCharge',
          'ECACharge',
          'EERCharge',
          'PTSCharge',
          'TDCCharge',
          'RkVACharge',
          'TaxExemptDelivery',
          'BillOffset',
          'FranchiseFee',
          'SolarCredit',
          'RenewableCharge',
        ];
        // Round to cents to prevent floating-point accumulation errors
        // across 15 addends from producing phantom ±$0.01 mismatches.
        const _sumCharges = () => Math.round(CHARGE_FIELDS.reduce((s, f) => s + pf(b[f]), 0) * 100) / 100;

        // 3a. Measure
        const ocrTotal = pf(b.TotalCurrentCharges);
        let compSum = _sumCharges();

        if (!ocrTotal) {
          // No OCR'd total — compSum is the only evidence we have.
          if (compSum > 0) {
            b.TotalCurrentCharges = compSum.toFixed(2);
            b._totalFromChargeSum = true;
            b._totalSource = 'compSum (no OCR total available)';
          }
        } else if (Math.abs(compSum - ocrTotal) < 0.02) {
          // 3a'. Already consistent — done, no mutation needed.
        } else {
          // Disagreement between ocrTotal and compSum. Run principled diagnosis.

          // 3b-pre. TDC CHARGE VERIFICATION FALLBACK (#43)
          // Strategy B can only verify charges that have _rates entries (from xRate).
          // When OCR garbled the TDC rate line so xRate returned nothing, TDC is
          // unverifiable and any OCR misread on its charge silently persists. Fallback:
          // if _rates.TDCCharge is missing but we have both the charge amount and the
          // kW quantity, derive rate = charge / qty and synthesize a _rates entry.
          // This gives Strategy B a computed value to cross-check against.
          if (b._rates && !b._rates.TDCCharge && pf(b.TDCCharge) > 0 && pf(b.TDCkW) > 0) {
            const _tdcChg = pf(b.TDCCharge);
            const _tdcQty = pf(b.TDCkW);
            const _tdcRate = _tdcChg / _tdcQty;
            // Sanity: Evergy TDC rates are typically $1-$5/kW. Accept $0.10-$50/kW range.
            if (_tdcRate >= 0.1 && _tdcRate <= 50) {
              b._rates.TDCCharge = {
                qty: _tdcQty,
                rate: _tdcRate,
                unit: 'kW',
                computed: Math.round(_tdcQty * _tdcRate * 100) / 100,
                _derived: true,
              };
            }
          }

          // 3b. Strategy B — apply ALL rate×qty corrections where the direction
          // matches the gap (charge too low when sum is too low, or too high when
          // sum is too high). Multiple corrections may be needed to close the gap
          // (e.g., ECA + PTS both under-extracted on a changeover bill).
          let targetDelta = compSum - ocrTotal;
          if (b._rates && Math.abs(targetDelta) >= 0.02) {
            for (const [field, ri] of Object.entries(b._rates)) {
              const ocrVal = pf(b[field]);
              if (!ocrVal || !ri.computed) continue;
              if (ri.computed > 1e6 || ri.rate > 10000) continue;
              const chargeDelta = ocrVal - ri.computed;
              if (Math.abs(chargeDelta) < 0.02) continue;
              const sameDirection = (targetDelta < 0 && chargeDelta < 0) || (targetDelta > 0 && chargeDelta > 0);
              // Don't replace a charge value when xChg found more parts
              // than xRate. xChg correctly summed all OCR'd dollar amounts
              // but xRate couldn't parse the rate info from garbled lines.
              // Replacing the correct xChg total with the incomplete xRate
              // computed value CREATES a mismatch that didn't exist.
              const xChgParts = b._xChgParts && b._xChgParts[field];
              const xRateParts = ri.parts || [ri];
              if (xChgParts && xChgParts.length > xRateParts.length) continue;
              if (sameDirection) {
                b['_auto_corrected_' + field] = {
                  original: b[field],
                  corrected: ri.computed.toFixed(2),
                  rate: ri.rate,
                  qty: ri.qty,
                  unit: ri.unit,
                  reason:
                    ri.qty.toFixed(4) + ' ' + ri.unit + ' × $' + ri.rate.toFixed(5) + ' = $' + ri.computed.toFixed(2),
                };
                b[field] = ri.computed.toFixed(2);
              }
            }
            compSum = _sumCharges();
            targetDelta = compSum - ocrTotal;
          }

          // 3c. Strategy C — subtraction inference for a lone unverified field.
          // Only runs if a gap remains AND exactly one rate-based charge has no
          // _rates entry (meaning we can't verify it by math).
          if (Math.abs(compSum - ocrTotal) >= 0.02) {
            const RATE_BASED = [
              'FacilitiesCharge',
              'BilledKWCharge',
              'EnergyOnPeakCharge',
              'EnergyOffPeakCharge',
              'ECACharge',
              'EERCharge',
              'PTSCharge',
              'TDCCharge',
              'RkVACharge',
            ];
            const unverified = RATE_BASED.filter((f) => {
              const v = pf(b[f]);
              if (v <= 0) return false;
              if (b._rates && b._rates[f]) return false;
              if (b['_auto_corrected_' + f]) return false;
              if (b['_ocr_consensus_' + f]) return false;
              return true;
            });
            if (unverified.length === 1) {
              const f = unverified[0];
              const origVal = pf(b[f]);
              const residual = ocrTotal - (compSum - origVal);
              if (residual > 0) {
                b['_auto_corrected_' + f] = {
                  original: b[f],
                  corrected: residual.toFixed(2),
                  reason:
                    'Derived from TotalCurrentCharges − Σ(other charges). No rate data for ' +
                    f +
                    '; every other charge verified, so this field absorbs the residual.',
                };
                b[f] = residual.toFixed(2);
                compSum = _sumCharges();
              }
            }
          }

          // 3d. Final decision — evidence-weighted, never blind.
          const finalDelta = compSum - ocrTotal;
          // SUBTOTAL CORROBORATION GUARD: on Evergy tax-exempt bills the
          // printed Subtotal and Current Charges are always equal. When
          // both OCR'd cleanly to the same value, that pair is ground
          // truth — a compSum disagreement points to a per-charge bug
          // (wrong sign, missed line item), not a wrong total. Don't let
          // compSum clobber a corroborated ocrTotal.
          const _subVal = pf(b._subtotal);
          const subtotalCorroborates = _subVal > 0 && Math.abs(_subVal - ocrTotal) < 0.02;
          if (Math.abs(finalDelta) < 0.02) {
            // Reconciled. Keep ocrTotal. No flag needed.
          } else {
            // Still disagree. Check if any per-charge rate mismatches remain
            // (signal that compSum is still contaminated).
            const hasRateMismatch = Object.keys(b).some((k) => k.startsWith('_rate_mismatch_'));
            if (finalDelta > 0.5 && !hasRateMismatch && !subtotalCorroborates) {
              // compSum > ocrTotal, all per-charge math verifies → ocrTotal was
              // likely a page-1 summary that excluded some detail charges that
              // extracted cleanly. Trust compSum.
              b.TotalCurrentCharges = compSum.toFixed(2);
              b._totalFromChargeSum = true;
              b._totalSource =
                'compSum (ocrTotal of $' +
                ocrTotal.toFixed(2) +
                ' appears to be an incomplete summary; no per-charge rate mismatches remain to cast doubt on compSum)';
            } else {
              // Can't confidently reconcile — flag for user, keep ocrTotal.
              b._sum_mismatch = {
                compSum,
                total: ocrTotal,
                diff: Math.abs(finalDelta),
                reason:
                  'Charges sum to $' +
                  compSum.toFixed(2) +
                  ' vs OCR total $' +
                  ocrTotal.toFixed(2) +
                  (hasRateMismatch
                    ? '. Per-charge rate mismatches remain after correction attempts — user review needed.'
                    : finalDelta > 0
                      ? '. No rate mismatches to pinpoint, but compSum exceeds OCR total by less than the switch threshold.'
                      : '. A charge was likely missed during extraction.'),
              };
            }
          }
        }
      }
    }

    // ── CROSS-FIELD VALIDATION: kWhConsumed and ActualKW consensus from charge lines ──
    // Per Evergy bill structure, several charge lines carry the SAME quantity:
    //   - PTS Chg qty = total kWh for the period
    //   - EER Chg qty = total kWh for the period
    //   - ECA Chg qty (sum of parts if seasonal) = total kWh
    //   - Energy On-Peak + Off-Peak qty sum = total kWh
    //   - TDC Chg qty = ActualKW (current month billed demand)
    // When the meter table is OCR-garbled but the charge lines extracted cleanly, we can recover
    // kWhConsumed and ActualKW from this charge-line consensus. The CSC Evergy bill format rules:
    //   - kW sanity: single monthly kW almost never exceeds 9,999.9999
    //   - kWh sanity: single monthly kWh almost never exceeds 999,999.9999
    // Anything outside those bounds is an OCR/parse error; reject and recover from consensus.
    if (utilityName === 'Evergy') {
      for (let i = 0; i < bills.length; i++) {
        const b = bills[i];
        if (!b._rates) continue;
        // kWh charge line parts represent portions of the SAME total period (seasonal split,
        // prorated days, etc.) so their qty should sum to kWhConsumed.
        const getPartsQtySum = (rateKey) => {
          const r = b._rates[rateKey];
          if (!r || !r.parts || !r.parts.length) return null;
          const s = r.parts.reduce((a, p) => a + (p.qty || 0), 0);
          return s > 0 ? s : null;
        };
        // kW charge line parts can represent DIFFERENT kW values on meter-change bills
        // (old meter + new meter mid-month), so summing is wrong — the true ActualKW is the MAX.
        // On seasonal rate changeover bills, both parts have the same kW and MAX == either one.
        const getPartsQtyMax = (rateKey) => {
          const r = b._rates[rateKey];
          if (!r || !r.parts || !r.parts.length) return null;
          const m = Math.max(...r.parts.map((p) => p.qty || 0));
          return m > 0 ? m : null;
        };
        // Collect implied kWh from each charge line that spans the full period
        const kwhImplied = [];
        for (const key of ['PTSCharge', 'EERCharge', 'ECACharge']) {
          const q = getPartsQtySum(key);
          if (q) kwhImplied.push({ source: key, value: q });
        }
        // Energy On+Off peak sum (both may exist; total = on + off)
        const onQ = getPartsQtySum('EnergyOnPeakCharge') || 0;
        const offQ = getPartsQtySum('EnergyOffPeakCharge') || 0;
        if (onQ + offQ > 0) kwhImplied.push({ source: 'Energy On+Off', value: onQ + offQ });
        // Find the mode (most common value within 2% tolerance) — gives a robust consensus
        const consensusKwh = (() => {
          if (kwhImplied.length < 2) return kwhImplied[0]?.value || null;
          const buckets = [];
          for (const item of kwhImplied) {
            const bkt = buckets.find((b2) => Math.abs(b2.value - item.value) / item.value < 0.02);
            if (bkt) {
              bkt.count++;
              bkt.sources.push(item.source);
            } else {
              buckets.push({ value: item.value, count: 1, sources: [item.source] });
            }
          }
          buckets.sort((a, b2) => b2.count - a.count);
          return buckets[0].count >= 2 ? buckets[0].value : null;
        })();
        // Decide whether current kWhConsumed is suspect
        const curKwh = pf(b.kWhConsumed);
        const kwhOutOfRange = curKwh > 0 && (curKwh > 500000 || curKwh < 1);
        const kwhOffFromConsensus = consensusKwh && curKwh > 0 && Math.abs(curKwh - consensusKwh) / consensusKwh > 0.05;
        if (consensusKwh && (kwhOutOfRange || kwhOffFromConsensus || !curKwh)) {
          b['_auto_corrected_kWhConsumed'] = {
            original: b.kWhConsumed,
            corrected: consensusKwh.toFixed(4),
            reason:
              'Cross-validated from charge line qty consensus (' +
              kwhImplied
                .filter((x) => Math.abs(x.value - consensusKwh) / consensusKwh < 0.02)
                .map((x) => x.source)
                .join(', ') +
              ')',
          };
          b.kWhConsumed = consensusKwh.toFixed(4);
        }
        // ActualKW recovery rule (Evergy LGS Secondary minimum 200 kW billed demand):
        //   BilledKW = max(ActualKW, 200)
        // Corollary: when BilledKW > 200, the floor is NOT applied, so ActualKW == BilledKW
        // by mathematical identity — we can recover ActualKW from the Demand Chg line.
        // When BilledKW <= 200, we keep whatever the meter table reading was; the user can
        // see it and correct it manually if it's garbled (ActualKW < 200 is legitimate on
        // low-demand months and shouldn't be nulled).
        const curKw = pf(b.ActualKW);
        const kwOutOfRange = curKw > 0 && (curKw > 10000 || curKw < 0.1);
        const demandKwMax = getPartsQtyMax('BilledKWCharge');
        if ((!curKw || kwOutOfRange) && demandKwMax && demandKwMax > 200 && demandKwMax < 10000) {
          b['_auto_corrected_ActualKW'] = {
            original: b.ActualKW,
            corrected: demandKwMax.toFixed(4),
            reason:
              'BilledKW (' +
              demandKwMax.toFixed(4) +
              ' kW) exceeds the 200 kW LGS Secondary minimum, so ActualKW = BilledKW by identity',
          };
          b.ActualKW = demandKwMax.toFixed(4);
        }
        const tdcKwMax = getPartsQtyMax('TDCCharge');
        const curTdcKw = pf(b.TDCkW);
        const tdcKwParts = b._rates?.TDCCharge?.parts || [];
        const tdcKwMatchesPart = curTdcKw > 0 && tdcKwParts.some((p) => Math.abs(curTdcKw - (p.qty || 0)) < 0.01);
        if (tdcKwMax && curTdcKw > 0 && !tdcKwMatchesPart && Math.abs(curTdcKw - tdcKwMax) / tdcKwMax > 0.05) {
          b['_auto_corrected_TDCkW'] = {
            original: b.TDCkW,
            corrected: tdcKwMax.toFixed(4),
            reason: 'Derived from TDC Chg qty (max of parts)',
          };
          b.TDCkW = tdcKwMax.toFixed(4);
        } else if (!curTdcKw && tdcKwMax) {
          b.TDCkW = tdcKwMax.toFixed(4);
        }
        // FacilitiesKW: on rate changeover bills, the Facilities Chg line splits into two parts
        // with different per-period kW values. Only override if the extracted value doesn't
        // match any part's qty — matching means the meter table reading is valid for that period.
        const facKwMax = getPartsQtyMax('FacilitiesCharge');
        const curFacKw = pf(b.FacilitiesKW);
        const facKwParts = b._rates?.FacilitiesCharge?.parts || [];
        const facKwMatchesPart = curFacKw > 0 && facKwParts.some((p) => Math.abs(curFacKw - (p.qty || 0)) < 0.01);
        if (
          facKwMax &&
          facKwMax > 0 &&
          facKwMax < 10000 &&
          curFacKw > 0 &&
          !facKwMatchesPart &&
          Math.abs(curFacKw - facKwMax) / facKwMax > 0.05
        ) {
          b['_auto_corrected_FacilitiesKW'] = {
            original: b.FacilitiesKW,
            corrected: facKwMax.toFixed(4),
            reason: 'Cross-validated from Facilities Chg qty (max of parts)',
          };
          b.FacilitiesKW = facKwMax.toFixed(4);
        } else if (!curFacKw && facKwMax && facKwMax < 10000) {
          b.FacilitiesKW = facKwMax.toFixed(4);
        }
        // BilledKW: on changeover bills, parts have different per-period kW values.
        // Only override if the extracted value doesn't match ANY part's qty —
        // matching any part means the meter table reading is valid for that period.
        const billedKwMax = getPartsQtyMax('BilledKWCharge');
        const curBilledKw = pf(b.BilledKW);
        const billedKwParts = b._rates?.BilledKWCharge?.parts || [];
        const billedKwMatchesPart =
          curBilledKw > 0 && billedKwParts.some((p) => Math.abs(curBilledKw - (p.qty || 0)) < 0.01);
        if (
          billedKwMax &&
          billedKwMax > 0 &&
          billedKwMax < 10000 &&
          curBilledKw > 0 &&
          !billedKwMatchesPart &&
          Math.abs(curBilledKw - billedKwMax) / billedKwMax > 0.05
        ) {
          b['_auto_corrected_BilledKW'] = {
            original: b.BilledKW,
            corrected: billedKwMax.toFixed(4),
            reason: 'Cross-validated from Demand Chg qty (max of parts)',
          };
          b.BilledKW = billedKwMax.toFixed(4);
        } else if (!curBilledKw && billedKwMax && billedKwMax < 10000) {
          b.BilledKW = billedKwMax.toFixed(4);
        }
        // ── ActualKW sanity clamp: ActualKW ≤ BilledKW (physical constraint) ──
        // BilledKW is derived by the utility as max(ActualKW, LGS floor, 12-month ratchet).
        // That means BilledKW is ALWAYS ≥ ActualKW by construction — if OCR produces an
        // ActualKW that exceeds BilledKW, the meter-table reading is wrong (common garble:
        // "475.5360" read as "4755360", "578.784" as "5787840", etc.). Clamp down to the
        // smaller of BilledKW and FacilitiesKW so the correction respects both physical
        // constraints ("Actual kW can never be more than Billed kW or Facilities kW") in
        // one shot. Runs AFTER BilledKW and FacilitiesKW have been cross-validated against
        // their rate-line qty, so the clamp target is trustworthy.
        //
        // This rule intentionally does NOT fire on ActualKW > FacilitiesKW alone — a real
        // new 12-month peak has ActualKW == BilledKW > prior FacilitiesKW, and is handled
        // by the downstream "new peak + forward propagation" logic. Firing here would
        // swallow legitimate peak growth. The strict trigger is ActualKW > BilledKW,
        // which is physically impossible and therefore always an OCR error.
        //
        // Respects prior _auto_corrected_ActualKW markers: if an earlier rule (e.g. the
        // 200 kW LGS floor recovery above) already wrote one, we don't overwrite it.
        const curActual = pf(b.ActualKW);
        const curBilledFinal = pf(b.BilledKW);
        const curFacFinal = pf(b.FacilitiesKW);
        if (curActual > 0 && curBilledFinal > 0 && curActual > curBilledFinal + 0.001) {
          // CHARGE-LINE CONSENSUS FIRST: BilledKW == TDCkW proves the real demand.
          // When two independent charge lines (Demand Chg and TDC Chg) agree on the
          // kW value AND it has decimals (not a round minimum floor), ActualKW must
          // equal them — no floor was applied, so Actual = Billed = TDC by identity.
          // This is stronger evidence than decimal-shift guessing because the charge
          // lines were extracted cleanly even when the meter table was garbled.
          const curTdcFinal = pf(b.TDCkW);
          const billedTdcAgree =
            curBilledFinal > 0 &&
            curTdcFinal > 0 &&
            Math.abs(curBilledFinal - curTdcFinal) < 0.01 &&
            curBilledFinal % 1 !== 0;
          if (!b['_auto_corrected_ActualKW'] && billedTdcAgree) {
            b['_auto_corrected_ActualKW'] = {
              original: b.ActualKW,
              corrected: curBilledFinal.toFixed(4),
              reason:
                'BilledKW (' +
                curBilledFinal.toFixed(4) +
                ') == TDCkW (' +
                curTdcFinal.toFixed(4) +
                ') with decimals — no minimum floor applied, so ActualKW = BilledKW by identity',
            };
            b.ActualKW = curBilledFinal.toFixed(4);
          }
          // DECIMAL-SHIFT RECOVERY (Bill 29 Nov 2025 Louis Elementary):
          // OCR commonly drops the decimal on the meter table kW column
          // (e.g. "198.7920" → "1987920"). When curActual is far larger than
          // BilledKW (>2x), try shifting the decimal left by powers of 10 and
          // pick the largest result that still fits under BilledKW AND
          // FacilitiesKW. This preserves the real sub-floor reading instead
          // of clamping to the LGS 200 kW minimum, which would wipe it out.
          else {
            let decimalShifted = null;
            if (!b['_auto_corrected_ActualKW'] && curActual > curBilledFinal * 2) {
              const facLimit = curFacFinal > 0 ? curFacFinal : Infinity;
              let best = null;
              for (const div of [10, 100, 1000, 10000, 100000]) {
                const v = curActual / div;
                if (v > 0.1 && v <= curBilledFinal + 0.001 && v <= facLimit + 0.001) {
                  if (best === null || v > best) best = v;
                }
              }
              if (best !== null) decimalShifted = best;
            }
            if (decimalShifted !== null) {
              b['_auto_corrected_ActualKW'] = {
                original: b.ActualKW,
                corrected: decimalShifted.toFixed(4),
                reason:
                  'OCR dropped the decimal point on the meter table kW reading — recovered ' +
                  decimalShifted.toFixed(4) +
                  ' kW (fits under BilledKW ' +
                  curBilledFinal.toFixed(4) +
                  (curFacFinal > 0 ? ' and FacilitiesKW ' + curFacFinal.toFixed(4) : '') +
                  ')',
              };
              b.ActualKW = decimalShifted.toFixed(4);
            } else {
              let clampTarget = curBilledFinal;
              let clampSource = 'BilledKW';
              if (curFacFinal > 0 && curFacFinal < clampTarget) {
                clampTarget = curFacFinal;
                clampSource = 'FacilitiesKW';
              }
              if (!b['_auto_corrected_ActualKW']) {
                const facPart = curFacFinal > 0 ? ' or FacilitiesKW (' + curFacFinal.toFixed(4) + ')' : '';
                b['_auto_corrected_ActualKW'] = {
                  original: b.ActualKW,
                  corrected: clampTarget.toFixed(4),
                  reason:
                    'ActualKW (' +
                    curActual.toFixed(4) +
                    ') cannot exceed BilledKW (' +
                    curBilledFinal.toFixed(4) +
                    ')' +
                    facPart +
                    ' — clamped to ' +
                    clampSource +
                    ' = ' +
                    clampTarget.toFixed(4),
                };
                b.ActualKW = clampTarget.toFixed(4);
              }
            }
          } // end else (decimal-shift / clamp branch)
        }
        // ── Meter table cross-validation: ReadDifference / MeterMultiplier / kWhConsumed ──
        // Two identities anchor the meter table:
        //   (1) EndRead - StartRead = ReadDifference
        //   (2) ReadDifference × MeterMultiplier = kWhConsumed
        // And one sanity rule:
        //   ReadDifference ≤ EndRead  (unless EndRead < StartRead, which is a meter rollover)
        // MeterMultiplier is almost always consistent across bills for the same meter, so
        // neighbor bills provide a trustworthy reference when OCR garbles the current bill.
        const _getNeighborMult = () => {
          const acct = (b.AccountNumber || '').replace(/[\s\-]/g, '');
          const multCounts = {};
          for (let j = Math.max(0, i - 6); j < Math.min(bills.length, i + 7); j++) {
            if (j === i) continue;
            const nb = bills[j];
            if ((nb.AccountNumber || '').replace(/[\s\-]/g, '') !== acct) continue;
            const nm = pf(nb.MeterMultiplier);
            if (nm > 0 && nm <= 10000) {
              const key = nm.toFixed(4);
              multCounts[key] = (multCounts[key] || 0) + 1;
            }
          }
          const sorted = Object.entries(multCounts).sort((a, c) => c[1] - a[1]);
          return sorted.length ? parseFloat(sorted[0][0]) : null;
        };
        const curMult = pf(b.MeterMultiplier);
        const neighborMult = _getNeighborMult();
        // Correct an obviously-garbled multiplier (> 10k or way off neighbor consensus)
        if (neighborMult && neighborMult > 0) {
          const multOutOfRange = curMult > 10000;
          const multOffNeighbor = curMult > 0 && Math.abs(curMult - neighborMult) / neighborMult > 0.05;
          if (multOutOfRange || multOffNeighbor || !curMult) {
            b['_auto_corrected_MeterMultiplier'] = {
              original: b.MeterMultiplier,
              corrected: neighborMult.toFixed(4),
              reason: 'Neighbor bills on the same account use ' + neighborMult.toFixed(4),
            };
            b.MeterMultiplier = neighborMult.toFixed(4);
          }
        } else if (curMult > 10000) {
          b['_likely_missing_MeterMultiplier'] = true;
          b.MeterMultiplier = null;
        }
        // Bug #18: ReadDifference must always be positive (current read - previous read).
        // Negative values occur when OCR reverses the subtraction order or the sign is
        // included in the extracted text. Abs() here before any downstream identity checks.
        if (b.ReadDifference) {
          const _rdRaw = parseFloat(String(b.ReadDifference).replace(/,/g, ''));
          if (!isNaN(_rdRaw) && _rdRaw < 0) b.ReadDifference = Math.abs(_rdRaw).toFixed(4);
        }
        // ── DETERMINISTIC VALIDATION CHAIN (Update 139 / #127) ──
        // Meter reads are the most trustworthy OCR values (5-7 digit numbers
        // are hard to garble significantly). ReadDifference is derived and OCR
        // frequently misreads a single digit (e.g. 41.8176 vs 41.6176).
        // ALWAYS compute ReadDifference from reads when both are available,
        // then cascade corrections through kWhConsumed → On-Peak kWh.
        const endR = pf(b.EndRead);
        const startR = pf(b.StartRead);
        const multNow = pf(b.MeterMultiplier);
        const curDiff = pf(b.ReadDifference);

        // Step 1: ReadDifference = EndRead - StartRead (authoritative)
        // For meter rollovers (endR < startR but near a boundary), compute the
        // wrap-around usage: boundary + 1 - startR + endR (Feature 0de6c188).
        if (endR > 0 && startR > 0 && endR < startR) {
          const _rvBounds = [99999, 999999, 9999999];
          for (const _rvB of _rvBounds) {
            if (startR > _rvB * 0.9 && endR < _rvB * 0.1) {
              const rolloverDiff = _rvB + 1 - startR + endR;
              if (rolloverDiff > 0 && rolloverDiff < _rvB) {
                if (!curDiff || Math.abs(curDiff - rolloverDiff) > 0.005) {
                  b['_auto_corrected_ReadDifference'] = {
                    original: b.ReadDifference,
                    corrected: rolloverDiff.toFixed(4),
                    reason:
                      'Meter rollover: boundary ' +
                      _rvB +
                      '+1 − StartRead(' +
                      startR +
                      ') + EndRead(' +
                      endR +
                      ') = ' +
                      rolloverDiff.toFixed(4),
                  };
                  b.ReadDifference = rolloverDiff.toFixed(4);
                  b._meterRollover = {
                    boundary: _rvB,
                    startRead: startR,
                    endRead: endR,
                    rolloverUsage: rolloverDiff,
                  };
                }
              }
              break;
            }
          }
        } else if (endR > 0 && startR > 0 && endR > startR) {
          const computedDiff = endR - startR;
          if (computedDiff > 0 && computedDiff < 1000000) {
            if (!curDiff || Math.abs(curDiff - computedDiff) > 0.005) {
              b['_auto_corrected_ReadDifference'] = {
                original: b.ReadDifference,
                corrected: computedDiff.toFixed(4),
                reason: 'EndRead (' + endR + ') − StartRead (' + startR + ') = ' + computedDiff.toFixed(4),
              };
              b.ReadDifference = computedDiff.toFixed(4);
            }
          }
        } else if (!curDiff) {
          // No reads available — try kWh / multiplier fallback
          const kwhNow = pf(b.kWhConsumed);
          const kwhDerivedDiff = kwhNow > 0 && multNow > 0 ? kwhNow / multNow : null;
          if (kwhDerivedDiff !== null && kwhDerivedDiff > 0 && kwhDerivedDiff < 1000000) {
            b.ReadDifference = kwhDerivedDiff.toFixed(4);
            b['_auto_recovered_ReadDifference'] = {
              original: null,
              corrected: b.ReadDifference,
              reason: 'kWhConsumed ÷ MeterMultiplier = ' + kwhDerivedDiff.toFixed(4),
            };
          }
        }
        // Sanity: ReadDifference must not exceed EndRead (unless rollover)
        const newDiff = pf(b.ReadDifference);
        if (newDiff > 0 && endR > 0 && startR > 0 && endR >= startR && newDiff > endR) {
          b['_likely_missing_ReadDifference'] = true;
          b.ReadDifference = null;
        }

        // Step 2: kWhConsumed = ReadDifference × MeterMultiplier (cascade)
        // Guard: don't cascade if the result is outside commercial range (0–2M kWh)
        // or if the current value is reasonable and the cascade would change it by 10x+.
        // Garbled multi-meter OCR can produce huge ReadDifference × Multiplier values
        // that destroy correct charge-line-derived kWhConsumed.
        const cascadeDiff = pf(b.ReadDifference);
        if (cascadeDiff > 0 && multNow > 0) {
          const expectedKwh = cascadeDiff * multNow;
          const curKwhForChain = pf(b.kWhConsumed);
          const _kwhSane = expectedKwh > 0 && expectedKwh < 2000000;
          const _wouldClobber = curKwhForChain > 0 && expectedKwh / curKwhForChain > 10;
          if (_kwhSane && !_wouldClobber && (!curKwhForChain || Math.abs(curKwhForChain - expectedKwh) > 1)) {
            b['_auto_corrected_kWhConsumed'] = {
              original: b.kWhConsumed,
              corrected: expectedKwh.toFixed(4),
              reason:
                'Cascaded: ReadDifference (' +
                cascadeDiff.toFixed(4) +
                ') × MeterMultiplier (' +
                multNow.toFixed(4) +
                ') = ' +
                expectedKwh.toFixed(4),
            };
            b.kWhConsumed = expectedKwh.toFixed(4);
          }
        }

        // Step 3: On-Peak kWh = kWhConsumed - Off-Peak kWh (cascade)
        const chainKwh = pf(b.kWhConsumed);
        const chainOffPk = pf(b.OffPeakKWh);
        const chainOnPk = pf(b.OnPeakKWh);
        if (chainKwh > 0 && chainOffPk > 0 && chainOnPk > 0) {
          const expectedOnPk = chainKwh - chainOffPk;
          if (expectedOnPk > 0 && Math.abs(chainOnPk - expectedOnPk) > 0.5) {
            // Cross-check: does On-Peak charge / On-Peak rate agree?
            const onRi = b._rates && b._rates.EnergyOnPeakCharge;
            const onCharge = pf(b.EnergyOnPeakCharge);
            let useExpected = true;
            if (onRi && onRi.rate > 0 && onCharge > 0) {
              const rateImplied = onCharge / onRi.rate;
              if (Math.abs(rateImplied - chainOnPk) < Math.abs(rateImplied - expectedOnPk)) {
                useExpected = false; // rate×qty agrees with current On-Peak, not the subtraction
              }
            }
            if (useExpected) {
              b['_auto_corrected_OnPeakKWh'] = {
                original: b.OnPeakKWh,
                corrected: expectedOnPk.toFixed(4),
                reason:
                  'Cascaded: kWhConsumed (' +
                  chainKwh.toFixed(4) +
                  ') − OffPeakKWh (' +
                  chainOffPk.toFixed(4) +
                  ') = ' +
                  expectedOnPk.toFixed(4),
              };
              b.OnPeakKWh = expectedOnPk.toFixed(4);
            }
          }
        }
        // Final sanity strip: if ActualKW/BilledKW/FacilitiesKW are still in the insane range, null them
        for (const kwField of ['ActualKW', 'BilledKW', 'FacilitiesKW', 'TDCkW', 'ActualRKVA']) {
          const v = pf(b[kwField]);
          if (v > 10000) {
            b['_likely_missing_' + kwField] = true;
            b[kwField] = null;
          }
        }
        // kW can never exceed kWh — if it does, the kW value is garbage
        const _finalKwh = pf(b.kWhConsumed);
        if (_finalKwh > 0) {
          for (const kwField of ['ActualKW', 'BilledKW', 'FacilitiesKW', 'TDCkW']) {
            const v = pf(b[kwField]);
            if (v > 0 && v > _finalKwh) {
              b['_likely_missing_' + kwField] = true;
              b[kwField] = null;
            }
          }
        }
        // ── FINAL ActualKW consensus: BilledKW == TDCkW → ActualKW must match ──
        // Runs after all other kW corrections. If BilledKW and TDCkW agree
        // (within 0.01) and ActualKW differs by any amount, correct it.
        const _fAct = pf(b.ActualKW),
          _fBil = pf(b.BilledKW),
          _fTdc = pf(b.TDCkW);
        if (
          _fAct > 0 &&
          _fBil > 0 &&
          _fTdc > 0 &&
          Math.abs(_fBil - _fTdc) < 0.01 &&
          _fBil % 1 !== 0 &&
          Math.abs(_fAct - _fBil) > 0.001
        ) {
          b['_auto_corrected_ActualKW'] = {
            original: b.ActualKW,
            corrected: _fBil.toFixed(4),
            reason: 'BilledKW (' + _fBil.toFixed(4) + ') == TDCkW (' + _fTdc.toFixed(4) + ') — ActualKW aligned',
          };
          b.ActualKW = _fBil.toFixed(4);
        }
      }
    }

    // ── SEQUENTIAL READ VALIDATION + CROSS-BILL RECOVERY (Update 98) ──
    // Multi-bill Evergy PDFs are a chain of continuous readings on one
    // account. A bill's period should abut its neighbors' periods and a
    // bill's StartRead should equal the previous bill's EndRead (unless
    // there was a meter change or an odometer rollover). We lean on this
    // structure to:
    //   1. Flag non-matching reads between adjacent bills (OCR digit errors).
    //   2. Recover a missing StartRead from the previous EndRead when
    //      periods are continuous.
    //   3. Recover a missing EndRead from the next StartRead.
    //   4. Apply arithmetic recovery on every bill: given any 3 of
    //      {StartRead, EndRead, ReadDifference, MeterMultiplier,
    //      kWhConsumed}, compute the 4th via the two relations:
    //         EndRead − StartRead = ReadDifference
    //         ReadDifference × MeterMultiplier = kWhConsumed
    if (bills.length > 1) {
      const pfR = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
      const sameAcct = (a, b) => {
        const x = (a.AccountNumber || '').replace(/[\s\-]/g, '');
        const y = (b.AccountNumber || '').replace(/[\s\-]/g, '');
        if (x && y && x !== y) return false;
        const ca = (a.Commodity || '').toLowerCase();
        const cb = (b.Commodity || '').toLowerCase();
        if (ca && cb && ca !== cb) return false;
        return true;
      };
      const dayDiff = (d1, d2) => {
        if (!d1 || !d2) return Infinity;
        const p1 = new Date(d1 + 'T12:00:00');
        const p2 = new Date(d2 + 'T12:00:00');
        if (isNaN(p1) || isNaN(p2)) return Infinity;
        return Math.abs((p1 - p2) / 86400000);
      };
      // 1. Sequential-read mismatch flags — with meter-change / rollover
      //    auto-detection. When next.StartRead is near-zero while
      //    curr.EndRead is large, that's a new meter install or a
      //    physical odometer rollover, NOT an OCR error. Record a
      //    `_meterChange` marker instead of a mismatch so the UI can
      //    treat it as expected continuity.
      for (let i = 0; i < bills.length - 1; i++) {
        const curr = bills[i],
          next = bills[i + 1];
        if (!curr.EndRead || !next.StartRead) continue;
        if (!sameAcct(curr, next)) continue;
        const endR = pfR(curr.EndRead);
        const startR = pfR(next.StartRead);
        if (endR > 0 && startR > 0 && Math.abs(endR - startR) > 0.001) {
          // Meter change / odometer rollover: next.StartRead < 10 AND
          // prev.EndRead > 1000 (substantially different magnitudes).
          // Don't flag — the near-zero read is the new meter's zero point.
          const isMeterChange = startR < 10 && endR > 1000;
          if (isMeterChange) {
            next._meterChange = {
              priorEnd: curr.EndRead,
              newStart: next.StartRead,
              reason:
                'New meter installed (or odometer rollover) — StartRead of ' +
                next.StartRead +
                ' is the zero point of the replacement, not a continuation of ' +
                curr.EndRead +
                '.',
            };
            continue;
          }
          curr._seqReadMismatch = {
            field: 'EndRead',
            value: curr.EndRead,
            expected: next.StartRead,
            nextBill: next.BillingPeriodStart + '–' + next.BillingPeriodEnd,
          };
          next._seqReadMismatch = {
            field: 'StartRead',
            value: next.StartRead,
            expected: curr.EndRead,
            prevBill: curr.BillingPeriodStart + '–' + curr.BillingPeriodEnd,
          };
        }
      }
      // 2. Cross-bill continuity recovery — copy a missing read from the
      //    neighbor when billing periods abut (within 5 days).
      for (let i = 0; i < bills.length; i++) {
        const curr = bills[i];
        const prev = i > 0 ? bills[i - 1] : null;
        const next = i < bills.length - 1 ? bills[i + 1] : null;
        if (!curr.StartRead && prev && sameAcct(curr, prev) && prev.EndRead) {
          if (dayDiff(prev.BillingPeriodEnd, curr.BillingPeriodStart) <= 5) {
            curr.StartRead = prev.EndRead;
            curr._auto_recovered_StartRead = {
              original: null,
              corrected: curr.StartRead,
              reason:
                "Copied from previous bill's EndRead (" +
                prev.EndRead +
                ') — billing period continuous with ' +
                prev.BillingPeriodEnd +
                '.',
            };
          }
        }
        if (!curr.EndRead && next && sameAcct(curr, next) && next.StartRead) {
          if (dayDiff(curr.BillingPeriodEnd, next.BillingPeriodStart) <= 5) {
            curr.EndRead = next.StartRead;
            curr._auto_recovered_EndRead = {
              original: null,
              corrected: curr.EndRead,
              reason:
                "Copied from next bill's StartRead (" +
                next.StartRead +
                ') — billing period continuous with ' +
                next.BillingPeriodStart +
                '.',
            };
          }
        }
      }
      // 3. Arithmetic recovery pass: fill any remaining missing value
      //    from the two identities above. Cascaded so a recovered
      //    ReadDifference can subsequently yield a missing StartRead/EndRead.
      for (const b of bills) {
        for (let pass = 0; pass < 2; pass++) {
          const sR = pfR(b.StartRead),
            eR = pfR(b.EndRead),
            dR = pfR(b.ReadDifference),
            mM = pfR(b.MeterMultiplier),
            kC = pfR(b.kWhConsumed);
          // EndRead − StartRead = ReadDifference
          if (sR > 0 && eR > 0 && !dR) {
            const v = eR - sR;
            b.ReadDifference = v.toFixed(4);
            b._auto_recovered_ReadDifference = {
              original: null,
              corrected: b.ReadDifference,
              reason: `EndRead (${eR}) − StartRead (${sR}) = ${v.toFixed(4)}.`,
            };
          } else if (dR > 0 && sR > 0 && !eR) {
            const v = sR + dR;
            b.EndRead = v.toFixed(4);
            b._auto_recovered_EndRead = {
              original: null,
              corrected: b.EndRead,
              reason: `StartRead (${sR}) + ReadDifference (${dR}) = ${v.toFixed(4)}.`,
            };
          } else if (dR > 0 && eR > 0 && !sR) {
            const v = eR - dR;
            b.StartRead = v.toFixed(4);
            b._auto_recovered_StartRead = {
              original: null,
              corrected: b.StartRead,
              reason: `EndRead (${eR}) − ReadDifference (${dR}) = ${v.toFixed(4)}.`,
            };
          }
          // ReadDifference × MeterMultiplier = kWhConsumed
          // Gas and propane bills use NaturalGasTherms/GallonsDelivered for usage;
          // injecting kWhConsumed on these bills causes usageQty to resolve to the
          // wrong field (kWh instead of therms). Skip both inject and differs arms
          // for gas/propane — leave the reverse arms below as-is (they only fire
          // when kC>0, which gas/propane won't have after this guard).
          const _isGasOrPropane = /gas|propane/i.test(b.Commodity || b.commodity || '');
          if (!_isGasOrPropane && dR > 0 && mM > 0 && !kC) {
            const v = dR * mM;
            if (v > 0 && v < 2000000) {
              b.kWhConsumed = v.toFixed(4);
              b._auto_recovered_kWhConsumed = {
                original: null,
                corrected: b.kWhConsumed,
                reason: `ReadDifference (${dR}) × MeterMultiplier (${mM}) = ${v.toFixed(4)}.`,
              };
            }
          } else if (!_isGasOrPropane && dR > 0 && mM > 0 && kC > 0) {
            const expected = dR * mM;
            const mismatch = Math.abs(kC - expected);
            const _expectedSane = expected > 0 && expected < 2000000;
            const _wouldClobber2 = kC > 0 && expected / kC > 10;
            if (_expectedSane && !_wouldClobber2 && mismatch > 1 && mismatch / expected > 0.001) {
              b['_auto_corrected_kWhConsumed'] = {
                original: b.kWhConsumed,
                corrected: expected.toFixed(4),
                reason: `ReadDifference (${dR}) × MeterMultiplier (${mM}) = ${expected.toFixed(4)}. OCR value ${kC.toFixed(4)} differs by ${mismatch.toFixed(4)}.`,
              };
              b.kWhConsumed = expected.toFixed(4);
            }
          } else if (kC > 0 && mM > 0 && !dR) {
            const v = kC / mM;
            b.ReadDifference = v.toFixed(4);
            b._auto_recovered_ReadDifference = {
              original: null,
              corrected: b.ReadDifference,
              reason: `kWhConsumed (${kC}) / MeterMultiplier (${mM}) = ${v.toFixed(4)}.`,
            };
          } else if (kC > 0 && dR > 0 && !mM) {
            const v = kC / dR;
            b.MeterMultiplier = v.toFixed(4);
            b._auto_recovered_MeterMultiplier = {
              original: null,
              corrected: b.MeterMultiplier,
              reason: `kWhConsumed (${kC}) / ReadDifference (${dR}) = ${v.toFixed(4)}.`,
            };
          }
        }
      }
    }

    // ── HELPER: find consensus Facilities rate from neighboring bills ──
    // When OCR garbles the rate (e.g. "$2079" instead of "$2.979"), the rate used to
    // recompute FacilitiesCharge will be wrong. Compare against neighbors on same account.
    function _getNeighborFacRate(bills, idx) {
      const acct = (bills[idx].AccountNumber || '').replace(/[\s\-]/g, '');
      const rates = [];
      for (let j = Math.max(0, idx - 6); j < Math.min(bills.length, idx + 7); j++) {
        if (j === idx) continue;
        const b = bills[j];
        if ((b.AccountNumber || '').replace(/[\s\-]/g, '') !== acct) continue;
        if (b._rates && b._rates.FacilitiesCharge && b._rates.FacilitiesCharge.rate > 0) {
          rates.push(b._rates.FacilitiesCharge.rate);
        }
      }
      if (rates.length === 0) return null;
      // Find the most common rate (mode)
      const counts = {};
      for (const r of rates) {
        const key = r.toFixed(5);
        counts[key] = (counts[key] || 0) + 1;
      }
      return parseFloat(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
    }

    // ── FACILITIES KW ROLLING PEAK VALIDATION ──
    // FacilitiesKW is the highest demand in the past 12 months (rolling peak).
    // It only changes when a new monthly BilledKW exceeds the previous peak.
    // If FacilitiesKW changes between consecutive bills, verify it's legitimate:
    //   Legitimate: new FacilitiesKW = current BilledKW (new peak set this month)
    //   OCR error:  new FacilitiesKW ≠ BilledKW, and decimal digits match prior value
    //               (e.g. 576.7840 vs 578.7840 — same .7840, just integer digit swap)
    if (bills.length > 1 && utilityName === 'Evergy') {
      for (let i = 1; i < bills.length; i++) {
        const prev = bills[i - 1],
          curr = bills[i];
        // Only compare same account
        const acct1 = (prev.AccountNumber || '').replace(/[\s\-]/g, '');
        const acct2 = (curr.AccountNumber || '').replace(/[\s\-]/g, '');
        if (acct1 && acct2 && acct1 !== acct2) continue;
        const prevFac = pf(prev.FacilitiesKW),
          currFac = pf(curr.FacilitiesKW);
        const currBilled = pf(curr.BilledKW);
        if (!prevFac || !currFac || Math.abs(prevFac - currFac) < 0.001) continue;
        // FacilitiesKW changed — is it legitimate?
        if (Math.abs(currFac - currBilled) < 0.001) {
          // New FacilitiesKW = current BilledKW → could be a new peak.
          // Check: were all previous BilledKW values below this?
          // Look back up to 11 bills for the same account.
          let allBelow = true;
          for (let j = Math.max(0, i - 11); j < i; j++) {
            const pAcct = (bills[j].AccountNumber || '').replace(/[\s\-]/g, '');
            if (pAcct && acct2 && pAcct !== acct2) continue;
            if (pf(bills[j].BilledKW) >= currFac - 0.001) {
              allBelow = false;
              break;
            }
          }
          if (allBelow) continue; // Legitimate new peak — skip correction
        }
        // Check if decimal digits match (strong indicator of integer-digit OCR error)
        const prevDec = String(prev.FacilitiesKW).split('.')[1] || '';
        const currDec = String(curr.FacilitiesKW).split('.')[1] || '';
        if (prevDec === currDec && prevDec.length >= 3) {
          // Same decimal portion (e.g. both .7840) — integer digit OCR error.
          // Use the previous bill's FacilitiesKW (the established rolling peak).
          curr['_auto_corrected_FacilitiesKW'] = {
            original: curr.FacilitiesKW,
            corrected: prev.FacilitiesKW,
            rate: 0,
            qty: 0,
            unit: 'kW',
            reason:
              'Rolling 12-month peak: decimal .' +
              currDec +
              ' matches prior bill, integer digit OCR error (' +
              curr.FacilitiesKW +
              ' → ' +
              prev.FacilitiesKW +
              ')',
          };
          curr.FacilitiesKW = prev.FacilitiesKW;
          // Also recompute FacilitiesCharge if we have the rate
          // Validate rate against neighbors — OCR may garble it (e.g. "$2079" → 2.079 instead of 2.979)
          if (curr._rates && curr._rates.FacilitiesCharge) {
            let facRate = curr._rates.FacilitiesCharge.rate;
            const neighborRate = _getNeighborFacRate(bills, i);
            if (neighborRate && Math.abs(neighborRate - facRate) > 0.01) {
              facRate = neighborRate; // neighbor consensus rate is more reliable
            }
            const newCharge = Math.round(pf(prev.FacilitiesKW) * facRate * 100) / 100;
            if (newCharge > 0) {
              curr['_auto_corrected_FacilitiesCharge'] = {
                original: curr.FacilitiesCharge,
                corrected: newCharge.toFixed(2),
                rate: facRate,
                qty: pf(prev.FacilitiesKW),
                unit: 'kW',
                reason: prev.FacilitiesKW + ' kW × $' + facRate.toFixed(5) + ' = $' + newCharge.toFixed(2),
              };
              curr.FacilitiesCharge = newCharge.toFixed(2);
            }
          }
        }
      }
    }

    // ── NEIGHBOR-BILL FALLBACK ──
    // When a bill has null fields, borrow from adjacent bills in the same multi-bill PDF
    // that share the same AccountNumber (and MeterNumber when both have one).
    const NEIGHBOR_FIELDS = ['UtilityCompany', 'CustomerName', 'ServiceAddress', 'RateSchedule'];
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      if (!b.AccountNumber) continue;
      const needsFill = NEIGHBOR_FIELDS.some((f) => b[f] === null || b[f] === undefined || b[f] === '');
      if (!needsFill) continue;
      const prev = i > 0 ? bills[i - 1] : null;
      const next = i < bills.length - 1 ? bills[i + 1] : null;
      const acctClean = (s) => (s || '').replace(/[\s\-]/g, '').toLowerCase();
      const isNeighbor = (n) => {
        if (!n || !n.AccountNumber) return false;
        if (acctClean(n.AccountNumber) !== acctClean(b.AccountNumber)) return false;
        if (b.MeterNumber && n.MeterNumber && b.MeterNumber !== n.MeterNumber) return false;
        return true;
      };
      const donors = []; // prefer previous, then next
      if (isNeighbor(prev)) donors.push(prev);
      if (isNeighbor(next)) donors.push(next);
      for (const f of NEIGHBOR_FIELDS) {
        if (b[f] !== null && b[f] !== undefined && b[f] !== '') continue;
        for (const donor of donors) {
          if (donor[f] !== null && donor[f] !== undefined && donor[f] !== '') {
            b[f] = donor[f];
            b['_neighbor_filled_' + f] = true;
            break;
          }
        }
      }
    }

    // ── CROSS-BILL CONSISTENCY: CustomerCharge and FacilitiesKW ──
    // CustomerCharge is a fixed monthly fee — should be identical across all bills on the same rate.
    // FacilitiesKW is a rolling 12-month peak — shouldn't all be identical unless demand never changed.
    // If all bills have the same value, flag for OCR review (likely copied from one good read).
    if (bills.length >= 3) {
      const custCharges = bills.map((b) => pf(b.CustomerCharge)).filter((v) => v > 0);
      const facKWs = bills.map((b) => pf(b.FacilitiesKW)).filter((v) => v > 0);
      // CustomerCharge: all same is expected (fixed fee) — no action needed
      // FacilitiesKW: if ALL are identical across 3+ bills, that's suspicious
      // (real FacilitiesKW changes when a new peak is set)
      if (facKWs.length >= 3) {
        const allSame = facKWs.every((v) => Math.abs(v - facKWs[0]) < 0.001);
        if (allSame) {
          bills.forEach((b) => {
            if (!b._warnings) b._warnings = [];
            b._warnings.push(
              'FacilitiesKW is identical across all bills (' + facKWs[0].toFixed(4) + ') — verify OCR accuracy',
            );
          });
        }
      }
    }

    // ── NEW PEAK LOGIC + FORWARD PROPAGATION ──
    // When ActualKW exceeds the rolling 12-month peak, a new peak is set.
    // FacilitiesKW = ActualKW = BilledKW for that month.
    // Then propagate: all subsequent bills must have FacilitiesKW >= the new peak
    // (the peak can only decrease when it rolls off after 12 months).
    // This also undoes any incorrect rolling peak corrections applied earlier.
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      const actualKW = pf(b.ActualKW);
      const facKW = pf(b.FacilitiesKW);
      const billedKW = pf(b.BilledKW);
      if (actualKW > 0 && facKW > 0 && actualKW > facKW) {
        // New peak set this month
        b.FacilitiesKW = b.ActualKW;
        if (billedKW > 0 && Math.abs(billedKW - actualKW) > 0.01) {
          b.BilledKW = b.ActualKW;
        }
        b['_auto_corrected_FacilitiesKW'] = {
          original: facKW.toFixed(4),
          corrected: b.FacilitiesKW,
          reason:
            'New 12-month peak: ActualKW (' +
            actualKW.toFixed(4) +
            ') exceeds prior FacilitiesKW (' +
            facKW.toFixed(4) +
            ')',
        };
        // Forward propagation: update all subsequent bills within 12 months
        const newPeak = pf(b.FacilitiesKW);
        for (let j = i + 1; j < bills.length && j < i + 12; j++) {
          const nb = bills[j];
          const nbFacKW = pf(nb.FacilitiesKW);
          // If a subsequent bill's FacilitiesKW is less than the new peak, it's wrong
          if (nbFacKW > 0 && nbFacKW < newPeak) {
            const nbOriginal = nb._auto_corrected_FacilitiesKW?.original || nb.FacilitiesKW;
            nb.FacilitiesKW = newPeak.toFixed(4);
            nb['_auto_corrected_FacilitiesKW'] = {
              original: nbOriginal,
              corrected: nb.FacilitiesKW,
              reason:
                'Forward propagation: peak of ' +
                newPeak.toFixed(4) +
                ' kW set in bill ' +
                (i + 1) +
                ' carries forward',
            };
            // Recompute FacilitiesCharge if rate is available
            // Validate rate against neighbors — OCR may garble it
            if (nb._rates && nb._rates.FacilitiesCharge && nb._rates.FacilitiesCharge.rate > 0) {
              let facRate = nb._rates.FacilitiesCharge.rate;
              const neighborRate = _getNeighborFacRate(bills, j);
              if (neighborRate && Math.abs(neighborRate - facRate) > 0.01) {
                facRate = neighborRate;
              }
              const newCharge = Math.round(newPeak * facRate * 100) / 100;
              if (newCharge > 0) {
                nb['_auto_corrected_FacilitiesCharge'] = {
                  original: nb.FacilitiesCharge,
                  corrected: newCharge.toFixed(2),
                  rate: facRate,
                  qty: newPeak,
                  unit: 'kW',
                  reason:
                    newPeak.toFixed(4) +
                    ' kW × $' +
                    facRate.toFixed(5) +
                    ' = $' +
                    newCharge.toFixed(2) +
                    ' (peak propagated)',
                };
                nb.FacilitiesCharge = newCharge.toFixed(2);
              }
            }
          }
          // If a subsequent bill sets an even higher peak, stop propagating this one
          const nbActual = pf(nb.ActualKW);
          if (nbActual > newPeak) break;
        }
      }
    }

    // Clean up no-op corrections: if a field was corrected then corrected back to its original value, remove the correction record
    for (const b of bills) {
      for (const key of Object.keys(b)) {
        if (!key.startsWith('_auto_corrected_')) continue;
        const corr = b[key];
        if (!corr) continue;
        const field = key.replace('_auto_corrected_', '');
        const origVal = String(corr.original || '').replace(/,/g, '');
        const finalVal = String(b[field] || '').replace(/,/g, '');
        if (origVal && finalVal && parseFloat(origVal).toFixed(4) === parseFloat(finalVal).toFixed(4)) {
          delete b[key]; // No net change — remove the correction warning
        }
      }
      // Clear magnitude flags when the CORRECTED value is within normal range.
      // Magnitude flags are set against original (pre-correction) values in Stage 2,
      // but auto-corrections in Stage 3+ may have fixed the value. Re-evaluate using
      // the final corrected value — only keep the flag if it's still an outlier.
      for (const key of Object.keys(b)) {
        if (!key.startsWith('_magnitude_flag_')) continue;
        const field = key.replace('_magnitude_flag_', '');
        const correctedVal = pf(b[field]);
        if (correctedVal <= 0) continue;
        const flag = b[key];
        const correctedRatio = correctedVal / flag.mean;
        if (correctedRatio < 8 && correctedRatio > 0.12) {
          delete b[key];
        }
      }
    }

    // ── BILLING PERIOD GAP DETECTION ──
    // Flag gaps between consecutive bills of the same commodity.
    // Groups by Commodity (or 'Electric' default), sorts by start date,
    // checks for gaps > 5 days between one bill's end and the next's start.
    if (bills.length > 1) {
      const _commGroups = {};
      for (const b of bills) {
        const c = b.Commodity || 'Electric';
        if (!_commGroups[c]) _commGroups[c] = [];
        _commGroups[c].push(b);
      }
      for (const [comm, group] of Object.entries(_commGroups)) {
        const sorted = group
          .filter((b) => b.BillingPeriodStart && b.BillingPeriodEnd)
          .sort((a, b) => {
            const da = new Date(
              a.BillingPeriodStart.replace(
                /(\d+)\/(\d+)\/(\d+)/,
                (_, m, d, y) => (y.length === 2 ? '20' + y : y) + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0'),
              ),
            );
            const db = new Date(
              b.BillingPeriodStart.replace(
                /(\d+)\/(\d+)\/(\d+)/,
                (_, m, d, y) => (y.length === 2 ? '20' + y : y) + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0'),
              ),
            );
            return da - db;
          });
        for (let i = 1; i < sorted.length; i++) {
          const prevEnd = sorted[i - 1].BillingPeriodEnd;
          const curStart = sorted[i].BillingPeriodStart;
          const toDate = (d) => {
            if (!d) return null; // guard: undefined date would crash on .split()
            const p = d.split(/[\/\-]/); // accept both "/" and "-" separators (KGS uses MM-DD-YY)
            return new Date(
              (p[2].length === 2 ? '20' + p[2] : p[2]) +
                '-' +
                p[0].padStart(2, '0') +
                '-' +
                p[1].padStart(2, '0') +
                'T12:00:00',
            );
          };
          const gapDays = Math.round((toDate(curStart) - toDate(prevEnd)) / 86400000);
          if (gapDays > 5) {
            sorted[i]._billing_gap = {
              days: gapDays,
              afterPeriod: prevEnd,
              commodity: comm,
              reason:
                gapDays +
                '-day gap in ' +
                comm +
                ' billing: previous period ended ' +
                prevEnd +
                ', this period starts ' +
                curStart,
            };
          }
        }
      }
    }

    // ── RE-VALIDATE: OnPeakKWh + OffPeakKWh = kWhConsumed ──
    // The extractor corrects On-Peak kWh early, but _postExtractionVerify may
    // later change kWhConsumed (via charge-line consensus or meter-table identity).
    // Re-check the identity and re-correct On-Peak/Off-Peak to match the final kWhConsumed.
    if (utilityName === 'Evergy') {
      for (const b of bills) {
        const onPk = pf(b.OnPeakKWh);
        const offPk = pf(b.OffPeakKWh);
        const total = pf(b.kWhConsumed);
        if (onPk > 0 && offPk > 0 && total > 0 && Math.abs(onPk + offPk - total) > 1) {
          const onRi = b._rates && b._rates.EnergyOnPeakCharge;
          const offRi = b._rates && b._rates.EnergyOffPeakCharge;
          let fixed = false;
          if (onRi && onRi.rate > 0 && pf(b.EnergyOnPeakCharge) > 0) {
            const derivedOn = pf(b.EnergyOnPeakCharge) / onRi.rate;
            if (derivedOn > 0 && Math.abs(derivedOn + offPk - total) < 1) {
              b['_auto_corrected_OnPeakKWh'] = {
                original: b.OnPeakKWh,
                corrected: derivedOn.toFixed(4),
                reason: 'Re-validated after kWhConsumed correction: charge / rate = ' + derivedOn.toFixed(4),
              };
              b.OnPeakKWh = derivedOn.toFixed(4);
              fixed = true;
            }
          }
          if (!fixed && offRi && offRi.rate > 0 && pf(b.EnergyOffPeakCharge) > 0) {
            const derivedOff = pf(b.EnergyOffPeakCharge) / offRi.rate;
            if (derivedOff > 0 && Math.abs(onPk + derivedOff - total) < 1) {
              b['_auto_corrected_OffPeakKWh'] = {
                original: b.OffPeakKWh,
                corrected: derivedOff.toFixed(4),
                reason: 'Re-validated after kWhConsumed correction: charge / rate = ' + derivedOff.toFixed(4),
              };
              b.OffPeakKWh = derivedOff.toFixed(4);
              fixed = true;
            }
          }
          if (!fixed) {
            const derivedOn = total - offPk;
            if (derivedOn > 0) {
              b['_auto_corrected_OnPeakKWh'] = {
                original: b.OnPeakKWh,
                corrected: derivedOn.toFixed(4),
                reason:
                  'Re-validated: kWhConsumed (' +
                  total.toFixed(2) +
                  ') - OffPeakKWh (' +
                  offPk.toFixed(2) +
                  ') = ' +
                  derivedOn.toFixed(4),
              };
              b.OnPeakKWh = derivedOn.toFixed(4);
            }
          }
        }
      }
    }

    // ── FINAL SANITY PASS: catch impossible values set by late-stage corrections ──
    // Sequential-read arithmetic and meter-table identity can produce garbage
    // kWhConsumed (e.g. garbled ReadDifference × MeterMultiplier = 999,539).
    // This runs AFTER all correction stages so nothing slips through.
    for (const b of bills) {
      const comm = (b.Commodity || '').toLowerCase();
      if (comm && comm !== 'electric') continue;
      const _kwhVal = pf(b.kWhConsumed);
      if (_kwhVal > 500000) {
        const _eR = pf(b.EndRead),
          _sR = pf(b.StartRead),
          _mM = pf(b.MeterMultiplier);
        const _recomputed = _eR > 0 && _sR > 0 && _eR > _sR && _mM > 0 ? (_eR - _sR) * _mM : 0;
        const _crossCheck = b._kwhCrossCheck ? b._kwhCrossCheck.calculated : 0;
        const _recovery =
          _recomputed > 0 && _recomputed < 500000
            ? _recomputed
            : _crossCheck > 0 && _crossCheck < 500000
              ? _crossCheck
              : 0;
        if (_recovery > 0) {
          b['_auto_corrected_kWhConsumed'] = {
            original: b.kWhConsumed,
            corrected: _recovery.toFixed(4),
            reason:
              'Value ' +
              _kwhVal +
              ' exceeded 500k ceiling; recovered from ' +
              (_recomputed > 0 ? 'EndRead-StartRead×Mult' : 'charge-line cross-check'),
          };
          b.kWhConsumed = _recovery.toFixed(4);
        } else {
          b['_likely_missing_kWhConsumed'] = true;
          b.kWhConsumed = null;
        }
      }
      const _kwhNow = pf(b.kWhConsumed);
      for (const kwField of ['ActualKW', 'BilledKW', 'FacilitiesKW', 'TDCkW']) {
        const v = pf(b[kwField]);
        if (v > 10000) {
          b['_likely_missing_' + kwField] = true;
          b[kwField] = null;
        } else if (_kwhNow > 0 && v > _kwhNow) {
          b['_likely_missing_' + kwField] = true;
          b[kwField] = null;
        }
      }
    }

    // ── KGS PER-MCF VALIDATION & RECOVERY PASS ──────────────────────────────
    // Runs over ALL gas bills together (cross-bill statistics).
    // Three passes:
    //   Pass A — printed-rate cross-check for WeatherNormalization and GasCharge.
    //            Uses WNAPerMcf / CostOfGasPerMcf from the meter table row.
    //            If actual/McfBilled is >5% off the printed rate, recover = printed_rate × McfBilled.
    //   Pass B — statistical per-Mcf median for DeliveryCharge, GasSystemReliability, FuelAdjustment.
    //            OOM band (ratio >10× or <0.1×): decimal-shift recovery when EXACTLY ONE candidate
    //            lands in band; else _decimal_recovery_ambiguous (no mutate).
    //            Digit-loss band (ratio <0.75× or >1.33× but not OOM): flag-only, no mutate.
    //   Pass C — CustomerCharge cross-bill stability: flag >20% off cross-bill median.
    // Rules: validate-before-mutate; always store raw original in diagnostic; surface ambiguity
    // (no silent mutate); digit-loss = flag+suggest only; Sum Mismatch warning stays as backstop.
    {
      const PRINTED_RATE_TOL = 0.05;
      const OOM_FACTOR = 10;
      const DIGIT_LO = 0.75;
      const DIGIT_HI = 1.33;
      const CUST_TOL = 0.2;

      // Helper: generate decimal-insertion candidates from a whole-number string.
      // Returns values that are >0 and plausible (< total current charges × 2 as upper cap).
      function _decimalCandidates(digits, cap) {
        const candidates = [];
        for (let i = 1; i < digits.length; i++) {
          const c = parseFloat(digits.slice(0, i) + '.' + digits.slice(i));
          if (c > 0 && c < cap) candidates.push(c);
        }
        return candidates;
      }

      // Helper: cross-bill median of per-Mcf rates from "clean" samples.
      // A sample is clean if: value has a decimal point, value > 0, value < TotalCurrentCharges.
      function _perMcfMedian(bills, field) {
        const rates = [];
        for (const b of bills) {
          const comm = (b.Commodity || b.commodity || '').toLowerCase();
          if (comm !== 'gas') continue;
          const v = b[field];
          if (v == null) continue;
          const vStr = String(v).replace(/[$,\s]/g, '');
          if (!vStr.includes('.')) continue; // not clean (no decimal)
          const vNum = parseFloat(vStr);
          if (!(vNum > 0)) continue;
          const total = pf(b.TotalCurrentCharges);
          if (vNum >= total) continue; // not clean (exceeds total)
          const mcf = pf(b.McfBilled);
          if (!(mcf > 0)) continue;
          rates.push(vNum / mcf);
        }
        if (rates.length === 0) return null;
        rates.sort((a, b) => a - b);
        const mid = Math.floor(rates.length / 2);
        return rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];
      }

      // ── PASS A: Printed-rate cross-check for WeatherNormalization and GasCharge ──
      const PASS_A_FIELDS = [
        { field: 'WeatherNormalization', rateField: 'WNAPerMcf' },
        { field: 'GasCharge', rateField: 'CostOfGasPerMcf' },
      ];
      for (const b of bills) {
        const comm = (b.Commodity || b.commodity || '').toLowerCase();
        if (comm !== 'gas') continue;
        const mcf = pf(b.McfBilled);
        if (!(mcf > 0)) continue;
        for (const { field, rateField } of PASS_A_FIELDS) {
          const printedRate = pf(b[rateField]);
          if (!(printedRate > 0)) continue; // no printed rate captured — skip
          const v = b[field];
          if (v == null) continue;
          const vNum = pf(v);
          const expected = printedRate * mcf;
          if (!(expected > 0)) continue;
          const relErr = Math.abs(vNum - expected) / expected;
          if (relErr > PRINTED_RATE_TOL) {
            // Recover: printed_rate × McfBilled
            const corrected = Number(expected).toFixed(2);
            b['_auto_recovered_' + field] = {
              original: v,
              corrected,
              reason:
                'Pass A printed-rate cross-check: actual ' +
                vNum.toFixed(4) +
                ' vs printed_rate(' +
                printedRate +
                ') × McfBilled(' +
                mcf +
                ') = ' +
                expected.toFixed(4) +
                '; rel error ' +
                (relErr * 100).toFixed(1) +
                '% > ' +
                PRINTED_RATE_TOL * 100 +
                '% threshold. Recovered = ' +
                corrected +
                '.',
            };
            b[field] = corrected;
          }
        }
      }

      // ── PASS B: Statistical per-Mcf median for delivery/surcharge/adjustment fields ──
      const PASS_B_FIELDS = ['DeliveryCharge', 'GasSystemReliability', 'FuelAdjustment'];
      for (const field of PASS_B_FIELDS) {
        const medianPerMcf = _perMcfMedian(bills, field);
        if (medianPerMcf === null) continue; // no clean samples — skip

        for (const b of bills) {
          const comm = (b.Commodity || b.commodity || '').toLowerCase();
          if (comm !== 'gas') continue;
          const mcf = pf(b.McfBilled);
          if (!(mcf > 0)) continue;
          const v = b[field];
          if (v == null) continue;
          const vStr = String(v).replace(/[$,\s]/g, '');
          const vNum = parseFloat(vStr);
          if (!(vNum > 0)) continue;
          const total = pf(b.TotalCurrentCharges);

          const actualPerMcf = vNum / mcf;
          const ratio = actualPerMcf / medianPerMcf;

          if (ratio > OOM_FACTOR || ratio < 1 / OOM_FACTOR) {
            // OOM band — attempt decimal-shift recovery
            const digits = vStr.replace(/\D/g, '');
            const cap = total > 0 ? total : 9999;
            const candidates = _decimalCandidates(digits, cap);
            // Filter candidates whose per-Mcf rate looks "normal" — within the
            // digit-loss band of the cross-bill median (DIGIT_LO to DIGIT_HI).
            // Using the full non-OOM range would allow ambiguous candidates like
            // 23.7 (ratio 9.4×) that are clearly not the right value.
            const inBand = candidates.filter((c) => {
              const r = c / mcf / medianPerMcf;
              return r >= DIGIT_LO && r <= DIGIT_HI;
            });
            if (inBand.length === 1) {
              const corrected = inBand[0].toFixed(2);
              b['_auto_recovered_' + field] = {
                original: v,
                corrected,
                originalPerMcf: actualPerMcf.toFixed(4),
                medianPerMcf: medianPerMcf.toFixed(4),
                reason:
                  'Pass B OOM decimal recovery: raw ' +
                  vStr +
                  ' (' +
                  actualPerMcf.toFixed(2) +
                  '/Mcf) is >' +
                  OOM_FACTOR +
                  '× or <1/' +
                  OOM_FACTOR +
                  '× of cross-bill median ' +
                  medianPerMcf.toFixed(4) +
                  '/Mcf. Single in-band candidate: ' +
                  corrected +
                  '.',
              };
              b[field] = corrected;
            } else {
              b['_decimal_recovery_ambiguous'] = b['_decimal_recovery_ambiguous'] || [];
              b['_decimal_recovery_ambiguous'].push({
                field,
                rawValue: vStr,
                candidates: candidates.map((c) => c.toFixed(2)),
                inBandCandidates: inBand.map((c) => c.toFixed(2)),
                originalPerMcf: actualPerMcf.toFixed(4),
                medianPerMcf: medianPerMcf.toFixed(4),
                reason:
                  (inBand.length === 0 ? 'No in-band candidate' : inBand.length + ' in-band candidates') +
                  ' for OOM field ' +
                  field +
                  ' (raw ' +
                  vStr +
                  ', ' +
                  actualPerMcf.toFixed(2) +
                  '/Mcf vs median ' +
                  medianPerMcf.toFixed(4) +
                  '/Mcf). Cannot safely auto-correct. Sum Mismatch warning retained.',
              });
            }
          } else if (ratio < DIGIT_LO || ratio > DIGIT_HI) {
            // Digit-loss band — flag and suggest, never mutate
            const suggestedValue = Number(medianPerMcf * mcf).toFixed(2);
            b['_digit_loss_suspected_' + field] = {
              original: v,
              originalPerMcf: actualPerMcf.toFixed(4),
              medianPerMcf: medianPerMcf.toFixed(4),
              ratio: ratio.toFixed(4),
              suggestedValue,
              confidence: 'low',
              reason:
                'Pass B digit-loss band: ' +
                field +
                ' = ' +
                vStr +
                ' (' +
                actualPerMcf.toFixed(4) +
                '/Mcf) is ' +
                (ratio < DIGIT_LO ? 'below DIGIT_LO (' + DIGIT_LO + ')' : 'above DIGIT_HI (' + DIGIT_HI + ')') +
                ' vs cross-bill median ' +
                medianPerMcf.toFixed(4) +
                '/Mcf. Suggested = median × McfBilled = ' +
                suggestedValue +
                '. NOT mutated — digit loss cannot be safely recovered without the missing digit.',
            };
            // Do NOT mutate b[field]
          }
          // else: ratio within band — no flag
        }
      }

      // ── PASS B2: KGS TotalCurrentCharges residual recovery (Mode 3 — period-as-digit) ──
      // Runs only for Kansas Gas Service bills, immediately after Pass B.
      // Purpose: Pass B's _decimalCandidates cannot recover a value like 2.52→2152 (Tesseract
      // reads the decimal point as the digit '1'). Pass B selects 2.152→2.15 (wrong by $0.37)
      // with no warning. Pass B2 computes the KGS component sum, detects the residual against
      // TotalCurrentCharges, and attempts a residual-based correction gated by the same
      // DIGIT_LO/DIGIT_HI per-Mcf band. If unambiguous and in-band: applies correction and sets
      // _auto_recovered_B2_* flag. If ambiguous or out-of-band: sets _sum_mismatch_kgs backstop.
      // Never guesses. Never mutates on ambiguity.
      // Scoped strictly to KGS — no other provider is affected.
      if (utilityName === 'Kansas Gas Service') {
        const B2_TOLERANCE = 0.02; // $0.02 — allows for floating-point rounding across addends

        for (const b of bills) {
          const comm = (b.Commodity || b.commodity || '').toLowerCase();
          if (comm !== 'gas') continue;

          const total = pf(b.TotalCurrentCharges);
          if (!(total > 0)) continue; // no reconciliation target — skip

          const mcf = pf(b.McfBilled);
          if (!(mcf > 0)) continue; // no usage — per-Mcf gate cannot run

          // Component sum — EXCLUDES PreviousBalance, PaymentsReceived, BalanceForward.
          // TotalCurrentCharges is the correct reconciliation target (not TotalAmountDue).
          const kgsSum =
            Math.round(
              (pf(b.CustomerCharge) +
                pf(b.DeliveryCharge) +
                pf(b.GasSystemReliability) +
                pf(b.WeatherNormalization) +
                pf(b.GasCharge) +
                pf(b.FranchiseFee) +
                pf(b.WinterEventCost) +
                pf(b.DelayedPaymentCharge)) *
                100,
            ) / 100;

          const residual = Math.round((total - kgsSum) * 100) / 100;

          if (Math.abs(residual) < B2_TOLERANCE) {
            // Sum already reconciles within tolerance — Pass B was correct; no action.
            continue;
          }

          // Guard: if ANY field on this bill has a _digit_loss_suspected_* flag, the sum
          // residual may be wholly or partially caused by that under-read field. We cannot
          // safely attribute the residual to a different Pass-B-corrected field without
          // risking a wrong correction. Back off entirely and set _sum_mismatch_kgs so the
          // UI shows a red banner naming the digit-loss field(s).
          const digitLossFields = Object.keys(b).filter((k) => k.startsWith('_digit_loss_suspected_'));
          if (digitLossFields.length > 0) {
            const fieldNames = digitLossFields.map((k) => k.replace('_digit_loss_suspected_', '')).join(', ');
            b._sum_mismatch_kgs = {
              kgsSum,
              totalCurrentCharges: total,
              residual,
              reason:
                'KGS component sum $' +
                kgsSum.toFixed(2) +
                ' does not match TotalCurrentCharges $' +
                total.toFixed(2) +
                ' (residual $' +
                residual.toFixed(2) +
                '). Digit-loss detected on field(s): ' +
                fieldNames +
                ' — residual may be caused by the under-read digit-loss field. No B2 correction applied.',
            };
            continue;
          }

          // Identify which Pass-B-corrected fields are candidates for residual correction.
          // A field is a candidate if Pass B set _auto_recovered_* on it (OOM decimal recovery).
          // Fields with _digit_loss_suspected_* are EXCLUDED — digit-loss cannot be recovered
          // by arithmetic and must not be mutated.
          const candidates = [];
          for (const field of PASS_B_FIELDS) {
            if (b['_digit_loss_suspected_' + field]) continue; // digit-loss — skip
            if (!b['_auto_recovered_' + field]) continue; // not corrected by Pass B — skip
            candidates.push(field);
          }

          if (candidates.length === 0) {
            // Sum mismatch exists but no Pass-B-corrected field to attribute it to.
            // Could be a missed extraction line or an uncorrectable corruption.
            b._sum_mismatch_kgs = {
              kgsSum,
              totalCurrentCharges: total,
              residual,
              reason:
                'KGS component sum $' +
                kgsSum.toFixed(2) +
                ' does not match TotalCurrentCharges $' +
                total.toFixed(2) +
                ' (residual $' +
                residual.toFixed(2) +
                '). No Pass-B-corrected field to attribute — possible missed extraction line.',
            };
            continue;
          }

          // For each Pass-B-corrected candidate field, compute what the residual-based
          // correction would be: residual_F = TotalCurrentCharges - (kgsSum - correctedValue_F).
          // Then gate by: positive, < TotalCurrentCharges, per-Mcf ratio in [DIGIT_LO, DIGIT_HI].
          const validCandidates = [];
          for (const field of candidates) {
            const correctedByPassB = pf(b[field]);
            const sumWithoutF = Math.round((kgsSum - correctedByPassB) * 100) / 100;
            const residualF = Math.round((total - sumWithoutF) * 100) / 100;

            // Gate 1: must be a positive charge
            if (!(residualF > 0)) continue;
            // Gate 2: must be less than total (sanity)
            if (residualF >= total) continue;
            // Gate 3: per-Mcf rate must be in the digit-loss band relative to cross-bill median
            const medianF = _perMcfMedian(bills, field);
            if (medianF === null || !(medianF > 0)) continue;
            const perMcfF = residualF / mcf;
            const bandRatioF = perMcfF / medianF;
            if (bandRatioF < DIGIT_LO || bandRatioF > DIGIT_HI) continue;

            validCandidates.push({ field, correctedByPassB, residualF, medianF, perMcfF, bandRatioF });
          }

          if (validCandidates.length === 1) {
            // Exactly one unambiguous candidate — apply residual correction.
            const { field, correctedByPassB, residualF, medianF, perMcfF, bandRatioF } = validCandidates[0];
            const originalOcr =
              (b['_auto_recovered_' + field] && b['_auto_recovered_' + field].original) || '(unknown)';
            const correctedStr = residualF.toFixed(2);

            b['_auto_recovered_B2_' + field] = {
              passB_value: correctedByPassB,
              corrected_to: parseFloat(correctedStr),
              original_ocr: String(originalOcr),
              medianPerMcf: medianF.toFixed(4),
              perMcf_corrected: perMcfF.toFixed(4),
              bandRatio: bandRatioF.toFixed(4),
              reason:
                'Pass B2 TotalCurrentCharges residual: $' +
                total.toFixed(2) +
                ' - sum_without(' +
                field +
                ')=$' +
                (kgsSum - correctedByPassB).toFixed(2) +
                ' = $' +
                residualF.toFixed(2) +
                '; per-Mcf $' +
                perMcfF.toFixed(4) +
                '/Mcf; band ratio ' +
                bandRatioF.toFixed(4) +
                ' in [' +
                DIGIT_LO +
                ', ' +
                DIGIT_HI +
                ']. Replaced Pass B value $' +
                correctedByPassB.toFixed(2) +
                ' with residual-derived $' +
                correctedStr +
                '.',
            };
            b[field] = correctedStr;
          } else if (validCandidates.length === 0) {
            // Residual exists but no candidate passes the per-Mcf gate — ambiguous or out-of-band.
            b._sum_mismatch_kgs = {
              kgsSum,
              totalCurrentCharges: total,
              residual,
              candidates: candidates,
              reason:
                'KGS component sum $' +
                kgsSum.toFixed(2) +
                ' does not match TotalCurrentCharges $' +
                total.toFixed(2) +
                ' (residual $' +
                residual.toFixed(2) +
                '). ' +
                (candidates.length === 0
                  ? 'No Pass-B-corrected field available.'
                  : 'Pass-B-corrected field(s) [' +
                    candidates.join(', ') +
                    '] did not pass per-Mcf gate (out-of-band or gate conditions failed). Cannot safely auto-correct.'),
            };
          } else {
            // Multiple candidates all pass the gate — ambiguous, cannot safely pick one.
            b._sum_mismatch_kgs = {
              kgsSum,
              totalCurrentCharges: total,
              residual,
              ambiguousCandidates: validCandidates.map((c) => ({
                field: c.field,
                residualF: c.residualF,
                bandRatio: c.bandRatioF,
              })),
              reason:
                'KGS component sum $' +
                kgsSum.toFixed(2) +
                ' does not match TotalCurrentCharges $' +
                total.toFixed(2) +
                ' (residual $' +
                residual.toFixed(2) +
                '). ' +
                validCandidates.length +
                ' Pass-B-corrected fields all pass per-Mcf gate — ambiguous. Cannot safely auto-correct without guessing.',
            };
          }
        }
      }

      // ── PASS C: CustomerCharge cross-bill stability ──
      // Compute cross-bill median CustomerCharge from bills that have a decimal
      const custValues = [];
      for (const b of bills) {
        const comm = (b.Commodity || b.commodity || '').toLowerCase();
        if (comm !== 'gas') continue;
        const v = b.CustomerCharge;
        if (v == null) continue;
        const vStr = String(v).replace(/[$,\s]/g, '');
        if (!vStr.includes('.')) continue;
        const vNum = parseFloat(vStr);
        if (vNum > 0) custValues.push(vNum);
      }
      if (custValues.length > 0) {
        custValues.sort((a, b) => a - b);
        const mid = Math.floor(custValues.length / 2);
        const custMedian = custValues.length % 2 === 0 ? (custValues[mid - 1] + custValues[mid]) / 2 : custValues[mid];
        for (const b of bills) {
          const comm = (b.Commodity || b.commodity || '').toLowerCase();
          if (comm !== 'gas') continue;
          const v = b.CustomerCharge;
          if (v == null) continue;
          const vNum = pf(v);
          if (!(vNum > 0)) continue;
          const relDev = Math.abs(vNum - custMedian) / custMedian;
          if (relDev > CUST_TOL) {
            b._customer_charge_unstable = {
              value: v,
              crossBillMedian: custMedian.toFixed(2),
              relativeDeviation: (relDev * 100).toFixed(1) + '%',
              reason:
                'Pass C: CustomerCharge ' +
                vNum.toFixed(2) +
                ' deviates ' +
                (relDev * 100).toFixed(1) +
                '% from cross-bill median ' +
                custMedian.toFixed(2) +
                ' (threshold ' +
                CUST_TOL * 100 +
                '%). NOT mutated.',
            };
          }
        }
      }
    }

    // ── GAS SANITY PASS: catch impossible therms, charges, and fuel adjustments ──
    for (const b of bills) {
      const comm = (b.Commodity || '').toLowerCase();
      if (comm !== 'gas') continue;
      const therms = pf(b.NaturalGasTherms);
      const gasChg = pf(b.GasCharge);
      const custChg = pf(b.CustomerCharge);
      const fa = pf(b.FuelAdjustment);
      if (therms > 10000) {
        b['_likely_garbled_NaturalGasTherms'] = {
          original: b.NaturalGasTherms,
          reason: 'Therms > 10,000 ceiling for monthly bill',
        };
        b.NaturalGasTherms = null;
      }
      if (therms > 0 && gasChg > 0) {
        const rate = gasChg / therms;
        if (rate > 2.0) {
          b['_likely_garbled_GasCharge'] = {
            original: b.GasCharge,
            rate: rate.toFixed(4),
            reason: 'Rate $' + rate.toFixed(2) + '/therm exceeds $2.00 ceiling',
          };
          b.GasCharge = null;
        }
      }
      // FA ratio check: in summer months with very low gas usage the
      // GasCharge can be just a few dollars (e.g. $2.39) while the FA is a
      // flat credit (e.g. -$12). The 50% ratio test false-positives on those
      // bills. Only apply the ratio check when GasCharge > $25 (roughly the
      // base charge); for small charges, only flag when |FA| > 2× GasCharge
      // to catch truly garbled values while keeping legitimate small-bill FAs.
      if (fa !== 0 && gasChg > 0) {
        const faAbs = Math.abs(fa);
        const isGarbledFA = gasChg > 25 ? faAbs > gasChg * 0.5 : faAbs > gasChg * 2;
        if (isGarbledFA) {
          b['_likely_garbled_FuelAdjustment'] = {
            original: b.FuelAdjustment,
            reason:
              gasChg > 25
                ? '|FA| exceeds 50% of GasCharge ($' + gasChg.toFixed(2) + ')'
                : '|FA| exceeds 2× GasCharge ($' + gasChg.toFixed(2) + ') [small-charge threshold]',
          };
          b.FuelAdjustment = null;
          const fixedTotal = gasChg + custChg;
          b.TotalCurrentCharges = fixedTotal.toFixed(2);
          b.TotalAmountDue = fixedTotal.toFixed(2);
        }
      }
      let total = pf(b.TotalCurrentCharges);
      if (total < 0 && gasChg > 0 && custChg > 0) {
        const fixedTotal = gasChg + custChg + (pf(b.FuelAdjustment) || 0);
        b.TotalCurrentCharges = fixedTotal.toFixed(2);
        b.TotalAmountDue = fixedTotal.toFixed(2);
        total = fixedTotal;
      }
      if (total > 0 && gasChg > 0 && custChg > 0) {
        const expectedTotal =
          gasChg +
          custChg +
          (pf(b.FuelAdjustment) || 0) +
          (pf(b.DeliveryCharge) || 0) +
          (pf(b.GasSystemReliability) || 0) +
          (pf(b.WeatherNormalization) || 0) +
          (pf(b.WinterEventCost) || 0) +
          (pf(b.FranchiseFee) || 0);
        if (Math.abs(expectedTotal - total) > total * 0.15 && Math.abs(expectedTotal - total) > 5) {
          b._warnings = b._warnings || [];
          b._warnings.push({
            level: 'warn',
            field: 'TotalCurrentCharges',
            message: 'Gas total $' + total.toFixed(2) + ' differs from components sum $' + expectedTotal.toFixed(2),
          });
        }
      }
    }

    // ── GENERAL VALIDATION: line item exceeds total (all utilities) ──
    // A bill where any single charge field is greater than TotalCurrentCharges
    // is physically impossible and indicates a parse/OCR error. Recalculate
    // the total from charge components when possible; only warn when data is
    // genuinely missing and can't be computed.
    const COMMODITY_CHARGE_FIELDS = {
      Gas: [
        'CustomerCharge',
        'GasCharge',
        'FuelAdjustment',
        'DeliveryCharge',
        'GasSystemReliability',
        'WeatherNormalization',
        'WinterEventCost',
        'FranchiseFee',
        'DelayedPaymentCharge',
      ],
      Water: ['WaterCharge', 'WaterProtectionFee', 'WaterDebtPayment', 'WaterFranchiseFee'],
      Sewer: ['SewerCharge', 'SewerFranchiseFee'],
      Stormwater: ['StormWaterCharge'],
      Propane: ['PropaneCharge'],
      Electric: [
        'CustomerCharge',
        'FacilitiesCharge',
        'BilledKWCharge',
        'EnergyOnPeakCharge',
        'EnergyOffPeakCharge',
        'ECACharge',
        'EERCharge',
        'PTSCharge',
        'TDCCharge',
        'RkVACharge',
        'TaxExemptDelivery',
        'BillOffset',
        'FranchiseFee',
        'SolarCredit',
        'RenewableCharge',
      ],
    };
    const ALL_CHARGE_FIELDS = [...new Set(Object.values(COMMODITY_CHARGE_FIELDS).flat())];
    for (const b of bills) {
      const total = pf(b.TotalCurrentCharges);
      if (total <= 0) continue;
      const comm = (b.Commodity || '').replace(/\s/g, '');
      const chargeFields = COMMODITY_CHARGE_FIELDS[comm] || ALL_CHARGE_FIELDS;
      const compSum =
        Math.round(
          chargeFields.reduce(function (s, f) {
            return s + pf(b[f]);
          }, 0) * 100,
        ) / 100;
      // If sum of all components (including negatives like Fuel Adjustment)
      // matches total within tolerance, no violation — individual items can
      // legitimately exceed total when credits/adjustments bring it down.
      if (Math.abs(compSum - total) < 0.5) continue;
      const violations = [];
      for (const f of chargeFields) {
        const v = pf(b[f]);
        if (v > 0 && v > total + 0.1) {
          violations.push({ field: f, value: v });
        }
      }
      if (violations.length === 0) continue;
      if (compSum > total + 0.1) {
        const origTotal = b.TotalCurrentCharges;
        b.TotalCurrentCharges = compSum.toFixed(2);
        b.TotalAmountDue = compSum.toFixed(2);
        b._auto_corrected_TotalCurrentCharges = {
          original: origTotal,
          corrected: compSum.toFixed(2),
          reason:
            violations
              .map(function (vi) {
                return vi.field + ' ($' + vi.value.toFixed(2) + ') exceeded total ($' + pf(origTotal).toFixed(2) + ')';
              })
              .join('; ') +
            ' — recalculated from charge components: $' +
            compSum.toFixed(2),
        };
        console.log(
          '[PostVerify] Total corrected for ' + comm + ': $' + pf(origTotal).toFixed(2) + ' → $' + compSum.toFixed(2),
        );
      } else {
        b._charge_exceeds_total = {
          total: total,
          violations: violations,
          reason:
            violations
              .map(function (vi) {
                return vi.field + ' ($' + vi.value.toFixed(2) + ') > TotalCurrentCharges ($' + total.toFixed(2) + ')';
              })
              .join('; ') + ' — could not auto-correct, verify against PDF',
        };
      }
    }

    // ── RECALCULATE RATES after all corrections ──
    // TotalKWhRate and TotalKWRate are computed during extraction but charge
    // values may have been corrected by Strategy B, subtraction inference, or
    // other post-extraction fixes. Recalculate from final charge values.
    if (utilityName === 'Evergy') {
      for (const b of bills) {
        const kwhChargeSum =
          pf(b.EnergyOnPeakCharge) + pf(b.EnergyOffPeakCharge) + pf(b.ECACharge) + pf(b.EERCharge) + pf(b.PTSCharge);
        const totalKwh = pf(b.kWhConsumed);
        b.TotalKWhRate = totalKwh > 0 && kwhChargeSum > 0 ? kwhChargeSum / totalKwh : null;
        b._rateCalcTrace = {
          OnPeak: pf(b.EnergyOnPeakCharge),
          OffPeak: pf(b.EnergyOffPeakCharge),
          ECA: pf(b.ECACharge),
          EER: pf(b.EERCharge),
          PTS: pf(b.PTSCharge),
          chargeSum: kwhChargeSum,
          kWh: totalKwh,
          rate: b.TotalKWhRate,
        };
        const kwChargeSum = pf(b.FacilitiesCharge) + pf(b.BilledKWCharge) + pf(b.TDCCharge);
        const totalKw = pf(b.BilledKW) || pf(b.ActualKW) || pf(b.FacilitiesKW);
        b.TotalKWRate = totalKw > 0 && kwChargeSum > 0 ? kwChargeSum / totalKw : null;
      }
    }

    return { bills, historicalCache: _historicalCache };
  } catch (e) {
    console.warn('[PDF] _postExtractionVerify failed:', e.message);
    return { bills, historicalCache: {} }; // Return bills unchanged if verification crashes
  }
}

// Build account-number -> en_pdf_bills[] index ONCE per batch.
// Mirrors _buildHistoricalCache (line ~1505) and _checkDuplicates's assignedByAcct
// (line ~7545) — same idiom, applied to the one remaining per-bill full-array scan.
function _buildPdfBillsIndex() {
  const idx = Object.create(null);
  const pdfBills = sget('en_pdf_bills', []) || [];
  for (const b of pdfBills) {
    const k = (b.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    if (!k) continue;
    if (!idx[k]) idx[k] = [];
    idx[k].push(b);
  }
  return idx;
}

// Run full validation + stats on extracted bill(s), return combined warnings per bill index
async function analyzeBillExtraction(bills, utilityName, historicalCache, statusCb) {
  const pdfBillsIndex = _buildPdfBillsIndex();
  const results = [];
  const YIELD_EVERY = 10; // same cadence as _postExtractionVerify's own pattern
  for (let i = 0; i < bills.length; i++) {
    if (statusCb && (i === 0 || i % YIELD_EVERY === 0)) {
      statusCb('Verifying bill ' + (i + 1) + ' of ' + bills.length + '...');
    }
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const b = bills[i];
    const vWarnings = validateBillData(b, utilityName || b.UtilityCompany || '_default');
    const sWarnings = detectStatisticalOutliers(b, historicalCache, pdfBillsIndex);
    results.push({ billIndex: i, warnings: [...vWarnings, ...sWarnings] });
  }
  return results;
}

// Count critical missing fields that OCR retry might fix
function countCriticalMissing(extracted, utilityName) {
  const spec = EXPECTED_FIELDS[utilityName] || EXPECTED_FIELDS._default;
  let count = 0;
  for (const f of spec.critical) {
    const v = extracted[f];
    if (v === null || v === undefined || v === '') count++;
  }
  return count;
}

// ── Auto-assign: scan all meters across all projects/buildings for account or meter number match ──
let _autoAssignTarget = null; // {projId, bldgId, meterId}
let _mbRowTargets = {}; // keyed by _pdfMultiBills index -> match obj or null
function _isMultiAcctFile() {
  return new Set((window._pdfMultiBills || []).map((b) => b.AccountNumber).filter(Boolean)).size > 1;
}
function _normalizeAddr(a) {
  return (a || '')
    .toLowerCase()
    .replace(/\b(drive|dr\.?)\b/g, 'dr')
    .replace(/\b(street|st\.?)\b/g, 'st')
    .replace(/\b(avenue|ave\.?)\b/g, 'ave')
    .replace(/\b(boulevard|blvd\.?)\b/g, 'blvd')
    .replace(/\b(lane|ln\.?)\b/g, 'ln')
    .replace(/\b(road|rd\.?)\b/g, 'rd')
    .replace(/\b(court|ct\.?)\b/g, 'ct')
    .replace(/\b(circle|cir\.?)\b/g, 'cir')
    .replace(/\b(place|pl\.?)\b/g, 'pl')
    .replace(/[^a-z0-9]/g, '');
}
function _levenshtein(a, b) {
  var m = a.length,
    n = b.length;
  var d = Array.from({ length: m + 1 }, function (_, i) {
    return i;
  });
  for (var j = 1; j <= n; j++) {
    var prev = d[0];
    d[0] = j;
    for (var i = 1; i <= m; i++) {
      var tmp = d[i];
      d[i] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, d[i], d[i - 1]) + 1;
      prev = tmp;
    }
  }
  return d[m];
}
function _addressSimilarity(a, b) {
  var na = _normalizeAddr(a),
    nb = _normalizeAddr(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  var maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - _levenshtein(na, nb) / maxLen;
}
// Flexible account/meter number comparison that survives utility format changes.
// Strips dashes, spaces, and leading zeros before comparing, then falls back
// to substring containment so e.g. "123456" matches "0123456-00" after stripping.
function _acctFuzzyMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) =>
    s
      .replace(/[\s\-]/g, '')
      .replace(/^0+/, '')
      .toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}
function findMeterMatch(extracted) {
  if (!extracted) return null;
  const acct = (extracted.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
  const meterNum = (extracted.MeterNumber || '').replace(/[\s\-]/g, '').toLowerCase();
  const billComm = (extracted.Commodity || '').toLowerCase();
  const billAddr = _normalizeAddr(extracted.ServiceAddress);
  let bestMatch = null;
  let addrMatch = null;
  let addrBestScore = 0; // tracks highest score seen so far for address fallback
  for (const proj of projects) {
    const udProj = getUDProj(proj.id);
    for (const bldg of udProj.buildings || []) {
      for (const m of bldg.meters || []) {
        const mAcct = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
        const mMeter = (m.meter || '').replace(/[\s\-]/g, '').toLowerCase();
        if (_acctFuzzyMatch(acct, mAcct) || (meterNum && mMeter && meterNum === mMeter)) {
          const mComm = (m.commodity || '').toLowerCase();
          const commMatch = billComm && mComm && billComm === mComm;
          // matchType: 'identity' — account/meter-number hit, as opposed to the
          // fuzzy address-only fallback below. Fix b-46a984a0: the batch queue UI
          // uses this to decide whether a match can render as plain confirmed text
          // or must force an explicit user pick (never silently misattach a
          // lower-confidence address match).
          if (commMatch)
            return { proj, bldg, meter: m, projId: proj.id, bldgId: bldg.id, meterId: m.id, matchType: 'identity' };
          if (!bestMatch)
            bestMatch = {
              proj,
              bldg,
              meter: m,
              projId: proj.id,
              bldgId: bldg.id,
              meterId: m.id,
              matchType: 'identity',
            };
        }
      }
      // Bug 86d02961: address fallback runs even when bestMatch exists so that
      // a commodity-matched address hit can override a commodity-mismatched
      // account hit. Also picks the commodity-matching meter within the
      // building rather than always defaulting to the first meter.
      // Fixed: was reading bldg.address (always undefined); correct field is bldg.addr.
      // Extended: checks addrAliases array and uses fuzzy similarity for near-matches.
      if (billAddr && billAddr.length >= 5) {
        const bldgAddrNorm = _normalizeAddr(bldg.addr);
        const aliases = (bldg.addrAliases || []).map(_normalizeAddr).filter(Boolean);
        // Check exact match against primary addr or any alias
        const exactHit = (bldgAddrNorm && bldgAddrNorm === billAddr) || aliases.some((a) => a === billAddr);
        // Compute best fuzzy score across primary + aliases
        let bestScore = bldgAddrNorm ? _addressSimilarity(bldg.addr, extracted.ServiceAddress) : 0;
        let isAlias = false;
        for (const rawAlias of bldg.addrAliases || []) {
          const s = _addressSimilarity(rawAlias, extracted.ServiceAddress);
          if (s > bestScore) {
            bestScore = s;
            isAlias = true;
          }
        }
        if (bldgAddrNorm && _addressSimilarity(bldg.addr, extracted.ServiceAddress) >= bestScore) {
          isAlias = false;
        }
        // Threshold: 0.60+ qualifies; keep the BEST-scoring building across all
        // buildings (not just the first one above 0.6). This prevents
        // cross-contamination when two buildings share a similar base address
        // (e.g. "301 6th St" vs "305 6th St") — the bill routes to whichever
        // building scores highest rather than whichever is iterated first.
        const candidateScore = exactHit ? 1.0 : bestScore;
        if ((exactHit || bestScore >= 0.6) && candidateScore > addrBestScore) {
          const commMeter = billComm
            ? (bldg.meters || []).find((m) => (m.commodity || '').toLowerCase() === billComm)
            : null;
          const candidateMeter = commMeter || (bldg.meters || [])[0];
          if (candidateMeter) {
            addrBestScore = candidateScore;
            addrMatch = {
              proj,
              bldg,
              meter: candidateMeter,
              projId: proj.id,
              bldgId: bldg.id,
              meterId: candidateMeter.id,
              fuzzyScore: candidateScore,
              isAlias,
              matchType: 'address',
            };
          }
        }
      }
    }
  }
  return bestMatch || addrMatch;
}
// Save a new address alias to a building (called after fuzzy match).
// Adds aliasString to bldg.addrAliases if not already present, then persists.
function saveAddressAlias(projId, bldgId, aliasString) {
  const alias = (aliasString || '').trim();
  if (!alias) return;
  const bldg = getUDBldg(projId, bldgId);
  if (!bldg) return;
  if (!Array.isArray(bldg.addrAliases)) bldg.addrAliases = [];
  const normNew = _normalizeAddr(alias);
  const already = bldg.addrAliases.some((a) => _normalizeAddr(a) === normNew);
  if (already) return;
  bldg.addrAliases.push(alias);
  saveUtilityData();
}
window.saveAddressAlias = saveAddressAlias;
function showAutoAssignBanner(match, extracted) {
  if (!match) return;
  if (_isMultiAcctFile()) {
    showMultiBuildingReviewPanel();
    return;
  }
  _autoAssignTarget = match;
  const banner = document.getElementById('pdfAutoAssignBanner');
  const msg = document.getElementById('pdfAutoAssignMsg');
  const bills = Array.isArray(window._pdfMultiBills) ? window._pdfMultiBills : [];
  const periods = bills.length || 1;
  const commodities = [...new Set(bills.map((b) => b.Commodity).filter(Boolean))];
  const commText = commodities.length > 1 ? ' (' + commodities.join(', ') + ')' : '';
  msg.textContent =
    'Account ' +
    (match.meter.account || match.meter.meter || '#') +
    ' found in ' +
    match.proj.name +
    ' → ' +
    match.bldg.name +
    '. Save ' +
    (periods > 1 ? 'all ' + periods + ' billing periods' : 'this bill') +
    commText +
    ' to matched meters?';
  banner.style.display = 'block';
  // Sync the manual override dropdowns with the auto-detected match
  const bldgSel = document.getElementById('pdfBldgSel');
  const meterSel = document.getElementById('pdfMeterSel');
  if (bldgSel && match.bldgId) {
    pdfUpdateBldgMeterOpts();
    bldgSel.value = match.bldgId;
    pdfUpdateMeterOpts();
    if (meterSel && match.meterId) meterSel.value = match.meterId;
  }
}

// ── Multi-building review panel (Option A) ────────────────────────────────────
function showMultiBuildingReviewPanel() {
  const bills = window._pdfMultiBills || [];
  const panel = document.getElementById('pdfMultiBldgPanel');
  if (!panel) return;

  // Reset row targets and pre-fill from findMeterMatch
  _mbRowTargets = {};
  bills.forEach(function (bill, i) {
    _mbRowTargets[i] = findMeterMatch(bill) || null;
  });

  // Count unique accounts for header
  const uniqueAccts = new Set(
    bills
      .map(function (b) {
        return b.AccountNumber;
      })
      .filter(Boolean),
  );

  // Build project options HTML (shared across unmatched rows)
  const projOpts = (projects || [])
    .map(function (p) {
      return '<option value="' + p.id + '">' + (p.name || 'Project ' + p.id) + '</option>';
    })
    .join('');

  // Build table rows
  const rows = [];
  bills.forEach(function (bill, i) {
    const match = _mbRowTargets[i];
    const period = (bill.BillingPeriodStart || '') + (bill.BillingPeriodEnd ? ' – ' + bill.BillingPeriodEnd : '');
    const addr = bill.ServiceAddress || '—';
    const acct = bill.AccountNumber || '—';
    const dupInfo = (window._pdfDupMap || {})[i];
    const isDupSkip = dupInfo && dupInfo.action === 'skip';

    let destCell = '';
    let statusCell = '';

    if (isDupSkip) {
      destCell = '<span style="color:var(--text3);font-size:12px;">Duplicate — skipped</span>';
      statusCell =
        '<span id="mbStatus_' +
        i +
        '" style="color:var(--text3);font-size:11px;padding:2px 6px;border-radius:3px;background:var(--s3);">Skip</span>';
    } else if (match) {
      destCell = [
        '<span id="mbStaticDest_' + i + '" style="font-size:12px;">',
        '<strong>' + (match.proj ? match.proj.name : '') + '</strong>',
        ' → ' +
          (match.bldg ? match.bldg.name : '') +
          ' → ' +
          (match.meter ? match.meter.commodity || match.meter.account || match.meter.id : ''),
        '</span>',
        ' <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 6px;" onclick="_mbToggleRowOverride(' +
          i +
          ')">Change</button>',
        '<div id="mbOverride_' + i + '" style="display:none;margin-top:6px;">',
        '<select class="fs" id="mbProjSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbUpdateBldgOpts(' +
          i +
          ')">',
        projOpts,
        '</select>',
        '<select class="fs" id="mbBldgSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbUpdateMeterOpts(' +
          i +
          ')"><option value="">— building —</option></select>',
        '<select class="fs" id="mbMeterSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbCommitRowTarget(' +
          i +
          ')"><option value="">— meter —</option></select>',
        '</div>',
      ].join('');
      statusCell =
        '<span id="mbStatus_' +
        i +
        '" style="color:var(--em);font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(var(--em-rgb),.1);">Matched</span>';
    } else {
      destCell = [
        '<select class="fs" id="mbProjSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbUpdateBldgOpts(' +
          i +
          ')">',
        '<option value="">— project —</option>',
        projOpts,
        '</select>',
        '<select class="fs" id="mbBldgSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbUpdateMeterOpts(' +
          i +
          ')"><option value="">— building —</option></select>',
        '<select class="fs" id="mbMeterSel_' +
          i +
          '" style="min-width:120px;font-size:12px;" onchange="_mbCommitRowTarget(' +
          i +
          ')"><option value="">— meter —</option></select>',
      ].join('');
      statusCell =
        '<span id="mbStatus_' +
        i +
        '" style="color:var(--accent);font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(128,128,128,.12);">No match — pick below</span>';
    }

    rows.push(
      [
        '<tr style="border-bottom:1px solid var(--s3);">',
        '<td style="padding:6px 8px;color:var(--text3);font-size:12px;">' + (i + 1) + '</td>',
        '<td style="padding:6px 8px;font-size:12px;">' + period + '</td>',
        '<td style="padding:6px 8px;font-size:12px;">' + addr + '</td>',
        '<td style="padding:6px 8px;font-size:12px;">' + acct + '</td>',
        '<td style="padding:6px 8px;">' + destCell + '</td>',
        '<td style="padding:6px 8px;">' + statusCell + '</td>',
        '</tr>',
      ].join(''),
    );
  });

  const html = [
    '<div style="border:1px solid var(--s2);border-radius:6px;background:var(--s4);padding:12px;">',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">',
    '<strong style="font-size:13px;color:var(--em);">Review — ' +
      bills.length +
      ' period' +
      (bills.length !== 1 ? 's' : '') +
      ' across ' +
      uniqueAccts.size +
      ' account' +
      (uniqueAccts.size !== 1 ? 's' : '') +
      '</strong>',
    '</div>',
    '<div style="overflow-x:auto;">',
    '<table style="width:100%;border-collapse:collapse;font-size:12px;">',
    '<thead>',
    '<tr style="background:var(--s1);border-bottom:2px solid var(--s2);">',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">#</th>',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">Period</th>',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">Service Address</th>',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">Account</th>',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">Destination</th>',
    '<th style="padding:6px 8px;text-align:left;font-weight:600;">Status</th>',
    '</tr>',
    '</thead>',
    '<tbody>',
    rows.join(''),
    '</tbody>',
    '</table>',
    '</div>',
    '<div style="display:flex;gap:8px;margin-top:12px;">',
    '<button class="btn btn-primary btn-sm" id="mbSaveAllBtn" onclick="confirmMultiBuildingSave()" disabled>Save All</button>',
    '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'pdfMultiBldgPanel\').style.display=\'none\'">Cancel</button>',
    '</div>',
    '</div>',
  ].join('');

  panel.innerHTML = html;
  panel.style.display = 'block';

  // Hide single-account banner and save row while panel is open
  const banner = document.getElementById('pdfAutoAssignBanner');
  if (banner) banner.style.display = 'none';
  const saveRow = document.getElementById('pdfSaveRow');
  if (saveRow) saveRow.style.display = 'none';

  _mbUpdateSaveAllBtn();
}
window.showMultiBuildingReviewPanel = showMultiBuildingReviewPanel;

function _mbUpdateBldgOpts(rowIdx) {
  const projSel = document.getElementById('mbProjSel_' + rowIdx);
  const bldgSel = document.getElementById('mbBldgSel_' + rowIdx);
  const meterSel = document.getElementById('mbMeterSel_' + rowIdx);
  if (!projSel || !bldgSel || !meterSel) return;
  const projId = parseInt(projSel.value);
  _mbRowTargets[rowIdx] = null;
  if (!projId) {
    bldgSel.innerHTML = '<option value="">— building —</option>';
    meterSel.innerHTML = '<option value="">— meter —</option>';
    _mbUpdateSaveAllBtn();
    return;
  }
  const bldgs = getUDProj(projId).buildings || [];
  if (!bldgs.length) {
    bldgSel.innerHTML = '<option value="">No buildings in this project — add one first</option>';
    meterSel.innerHTML = '<option value="">— meter —</option>';
    _mbUpdateSaveAllBtn();
    return;
  }
  bldgSel.innerHTML =
    '<option value="">— building —</option>' +
    bldgs
      .map(function (b) {
        return '<option value="' + b.id + '">' + (b.name || b.id) + '</option>';
      })
      .join('');
  meterSel.innerHTML = '<option value="">— meter —</option>';
  _mbUpdateSaveAllBtn();
}
window._mbUpdateBldgOpts = _mbUpdateBldgOpts;

function _mbUpdateMeterOpts(rowIdx) {
  const projSel = document.getElementById('mbProjSel_' + rowIdx);
  const bldgSel = document.getElementById('mbBldgSel_' + rowIdx);
  const meterSel = document.getElementById('mbMeterSel_' + rowIdx);
  if (!projSel || !bldgSel || !meterSel) return;
  const projId = parseInt(projSel.value);
  const bldgId = bldgSel.value;
  _mbRowTargets[rowIdx] = null;
  if (!projId || !bldgId) {
    meterSel.innerHTML = '<option value="">— meter —</option>';
    _mbUpdateSaveAllBtn();
    return;
  }
  const bldg = getUDBldg(projId, bldgId);
  const meters = bldg ? bldg.meters || [] : [];
  meterSel.innerHTML =
    '<option value="">— meter —</option>' +
    meters
      .map(function (m) {
        const label = [m.commodity, m.account || m.meter, m.provider].filter(Boolean).join(' · ') || m.id;
        return '<option value="' + m.id + '">' + label + '</option>';
      })
      .join('');
  _mbUpdateSaveAllBtn();
}
window._mbUpdateMeterOpts = _mbUpdateMeterOpts;

function _mbCommitRowTarget(rowIdx) {
  const projSel = document.getElementById('mbProjSel_' + rowIdx);
  const bldgSel = document.getElementById('mbBldgSel_' + rowIdx);
  const meterSel = document.getElementById('mbMeterSel_' + rowIdx);
  const statusEl = document.getElementById('mbStatus_' + rowIdx);
  if (!projSel || !bldgSel || !meterSel) return;
  const projId = parseInt(projSel.value);
  const bldgId = bldgSel.value;
  const meterId = meterSel.value;
  if (projId && bldgId && meterId) {
    const proj = (projects || []).find(function (p) {
      return p.id === projId;
    });
    const bldg = getUDBldg(projId, bldgId);
    const meter = bldg
      ? (bldg.meters || []).find(function (m) {
          return m.id === meterId;
        })
      : null;
    if (proj && bldg && meter) {
      _mbRowTargets[rowIdx] = {
        proj: proj,
        bldg: bldg,
        meter: meter,
        projId: projId,
        bldgId: bldgId,
        meterId: meterId,
        // Fix 11e47d64/9de73981: tag explicit user picks so
        // confirmMultiBuildingSave()'s identity gate lets them through
        // regardless of account/matchType — an explicit Project->Building->
        // Meter choice via this "Change" override is authoritative, same as
        // the _meterOverride exemption saveQueuedBills already grants manual
        // picks. findMeterMatch() never produces this value, so it cannot be
        // spoofed by an auto-match.
        matchType: 'manual',
      };
      if (statusEl) {
        statusEl.textContent = 'Assigned';
        statusEl.style.color = 'var(--em)';
        statusEl.style.background = 'rgba(var(--em-rgb),.1)';
      }
    } else {
      _mbRowTargets[rowIdx] = null;
    }
  } else {
    _mbRowTargets[rowIdx] = null;
    if (statusEl) {
      statusEl.textContent = 'No match — pick below';
      statusEl.style.color = 'var(--accent)';
      statusEl.style.background = 'rgba(128,128,128,.12)';
    }
  }
  _mbUpdateSaveAllBtn();
}
window._mbCommitRowTarget = _mbCommitRowTarget;

function _mbUpdateSaveAllBtn() {
  const btn = document.getElementById('mbSaveAllBtn');
  if (!btn) return;
  const bills = window._pdfMultiBills || [];
  const dupMap = window._pdfDupMap || {};
  const nonSkipped = bills.filter(function (b, i) {
    const d = dupMap[i];
    return !(d && d.action === 'skip');
  });
  if (!nonSkipped.length) {
    btn.disabled = true;
    return;
  }
  const assigned = nonSkipped.filter(function (b, i) {
    // Find the original index in bills array
    const origIdx = bills.indexOf(b);
    return _mbRowTargets[origIdx] !== null && _mbRowTargets[origIdx] !== undefined;
  });
  btn.disabled = !(assigned.length === nonSkipped.length);
}
window._mbUpdateSaveAllBtn = _mbUpdateSaveAllBtn;

function _mbToggleRowOverride(rowIdx) {
  const ovDiv = document.getElementById('mbOverride_' + rowIdx);
  if (!ovDiv) return;
  const isHidden = ovDiv.style.display === 'none';
  ovDiv.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    // Initialise project select to currently matched project if any
    const match = _mbRowTargets[rowIdx];
    const projSel = document.getElementById('mbProjSel_' + rowIdx);
    if (projSel && match && match.projId) {
      projSel.value = match.projId;
      _mbUpdateBldgOpts(rowIdx);
      const bldgSel = document.getElementById('mbBldgSel_' + rowIdx);
      if (bldgSel && match.bldgId) {
        bldgSel.value = match.bldgId;
        _mbUpdateMeterOpts(rowIdx);
        const meterSel = document.getElementById('mbMeterSel_' + rowIdx);
        if (meterSel && match.meterId) meterSel.value = match.meterId;
      }
    }
  }
}
window._mbToggleRowOverride = _mbToggleRowOverride;

async function confirmAutoAssign() {
  if (_isMultiAcctFile()) {
    showToast('Use the Save All button in the building review table');
    return;
  }
  if (!_autoAssignTarget || !window._pdfMultiBills) return;
  // If the override panel is open and fully filled in, apply the manual selection.
  const overrideRow = document.getElementById('pdfBannerOverrideRow');
  if (overrideRow && overrideRow.style.display !== 'none') {
    const overrideProjId = parseInt(document.getElementById('pdfBannerProjSel')?.value) || null;
    const overrideBldgId = document.getElementById('pdfBannerBldgSel')?.value || null;
    const overrideMeterId = document.getElementById('pdfBannerMeterSel')?.value || null;
    if (overrideProjId && overrideBldgId && overrideMeterId) {
      const overrideBldg = getUDBldg(overrideProjId, overrideBldgId);
      const overrideMeter = overrideBldg ? (overrideBldg.meters || []).find((m) => m.id === overrideMeterId) : null;
      const overrideProj = (projects || []).find((p) => p.id === overrideProjId);
      if (overrideBldg && overrideMeter && overrideProj) {
        _autoAssignTarget = {
          proj: overrideProj,
          bldg: overrideBldg,
          meter: overrideMeter,
          projId: overrideProjId,
          bldgId: overrideBldgId,
          meterId: overrideMeterId,
        };
      }
    } else {
      showToast('Select a project, building, and meter to override the destination');
      return;
    }
  }
  const { proj, bldg, meter, projId } = _autoAssignTarget;
  const bills = window._pdfMultiBills;
  const dupMap = window._pdfDupMap || {};
  const hasDups = Object.keys(dupMap).length > 0;
  if (hasDups) {
    // If any bills have unresolved dup actions, warn the user
    const unresolved = Object.values(dupMap).filter((d) => d.action === null);
    if (unresolved.length > 0) {
      showToast(unresolved.length + ' duplicate bill(s) need review — click yellow-dot pills to resolve');
      return;
    }
  }
  let saved = 0;
  for (let _bi = 0; _bi < bills.length; _bi++) {
    const bill = bills[_bi];
    // Check dup action for this bill
    const billDup = dupMap[_bi];
    if (billDup && billDup.action === 'skip') {
      continue; // Skip this duplicate
    }
    const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
    function toISO(d) {
      if (!d) return '';
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      let p = d.split('/');
      if (p.length !== 3) p = d.split('-');
      if (p.length !== 3) return d;
      const yr = p[2].length === 2 ? '20' + p[2] : p[2];
      return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
    }
    // Save PDF file and create bill record
    const billId = 'pb' + Date.now() + '_' + saved;
    let hasPDF = false;
    // Store PDF once under a shared key (not per-bill) to avoid duplication
    const sharedId = bills[0]?._pdfSharedKey || Date.now();
    const pdfKey = 'en_pdf_shared_' + String(sharedId).replace(/^en_pdf_shared_/, '');
    if (pdfB64 && saved === 0) {
      hasPDF = await pdfStore(pdfKey, pdfB64);
      // Mark all bills with shared key (store just the ID, not the full key)
      bills.forEach((b) => (b._pdfSharedKey = String(sharedId).replace(/^en_pdf_shared_/, '')));
    } else if (pdfB64) {
      hasPDF = true; // Already stored on first bill
    }
    // Bills go directly to meter.bills — no need to also store in en_pdf_bills
    // (Saved Bills is for unassigned bills only)
    const kwhCost = (
      pf(bill.EnergyOnPeakCharge) +
      pf(bill.EnergyOffPeakCharge) +
      pf(bill.ECACharge) +
      pf(bill.EERCharge) +
      pf(bill.PTSCharge)
    ).toFixed(2);
    const kwCost = (pf(bill.BilledKWCharge) + pf(bill.TDCCharge)).toFixed(2);
    // otherCost folds in the RkVA reactive-power charge because it has no dedicated
    // column in the bills table — without it here the value would be silently dropped.
    const otherCost = (
      pf(bill.CustomerCharge) +
      pf(bill.TaxExemptDelivery) +
      pf(bill.BillOffset) +
      pf(bill.RkVACharge)
    ).toFixed(2);
    const taxCost = pf(bill.FranchiseFee).toFixed(2);
    const billRow = {
      id: 'r' + Date.now() + '_' + saved,
      start: toISO(bill.BillingPeriodStart || bill.DeliveryDate),
      end: toISO(bill.BillingPeriodEnd || bill.DeliveryDate),
      kwh: bill.kWhConsumed || bill.NaturalGasCCF || bill.GallonsDelivered || '',
      demandKW: bill.ActualKW || '',
      billedKW: bill.BilledKW || '',
      facKW: bill.FacilitiesKW || '',
      facKWCost: bill.FacilitiesCharge || '',
      kwCost,
      kwhCost,
      otherCost,
      taxCost,
      totalCost: bill.TotalCurrentCharges || bill.TotalAmountDue || '',
      fromPDF: true,
      pdfBillId: billId,
      hasPDF,
      pdfKey: pdfKey || null,
      pdfPageStart: bill._pageStart || null,
      pdfPageEnd: bill._pageEnd || null,
      // Individual charge components — the Edit Billing Period modal reads these
      // directly, so dropping them here leaves the rider/energy/demand/franchise
      // inputs blank even though the PDF extractor captured real values. Must stay
      // in sync with the single-bill path in _saveSinglePDFBill.
      rateSchedule: bill.RateSchedule || '',
      onPeakKwh: bill.OnPeakKWh || bill.EnergyOnPeakKWh || '',
      offPeakKwh: bill.OffPeakKWh || bill.EnergyOffPeakKWh || '',
      onPeakCost: bill.EnergyOnPeakCharge || '',
      offPeakCost: bill.EnergyOffPeakCharge || '',
      customerCharge: bill.CustomerCharge || '',
      demandCharge: bill.BilledKWCharge || '',
      facilitiesCharge: bill.FacilitiesCharge || '',
      ecaCharge: bill.ECACharge || '',
      eerCharge: bill.EERCharge || '',
      ptsCharge: bill.PTSCharge || '',
      tdcCharge: bill.TDCCharge || '',
      rkvaCharge: bill.RkVACharge || '',
      renewableCharge: bill.RenewableCharge || '',
      franchiseFee: bill.FranchiseFee || '',
      // KGS has two separate Franchise Fee lines; store individually so _LAYOUT_KGS
      // can display FranchiseFee1 and FranchiseFee2 on saved (re-rendered) bills.
      // (single-bill save path _saveSinglePDFBill already persists these — keep in sync)
      franchiseFee1: bill.FranchiseFee1 || '',
      franchiseFee2: bill.FranchiseFee2 || '',
      solarCredit: bill.SolarCredit || '',
      generationKwh: bill.GenerationKwh || '',
      Meter1_ReadStart: bill.Meter1_ReadStart || '',
      Meter1_ReadEnd: bill.Meter1_ReadEnd || '',
      Meter1_StartRead: bill.Meter1_StartRead || '',
      Meter1_EndRead: bill.Meter1_EndRead || '',
      Meter1_ReadDiff: bill.Meter1_ReadDiff || '',
      Meter1_Multiplier: bill.Meter1_Multiplier || '',
      Meter1_kWh: bill.Meter1_kWh || '',
      Meter1_KW: bill.Meter1_KW || '',
      Meter1_RKVA: bill.Meter1_RKVA || '',
      Meter2_ReadStart: bill.Meter2_ReadStart || '',
      Meter2_ReadEnd: bill.Meter2_ReadEnd || '',
      Meter2_StartRead: bill.Meter2_StartRead || '',
      Meter2_EndRead: bill.Meter2_EndRead || '',
      Meter2_ReadDiff: bill.Meter2_ReadDiff || '',
      Meter2_Multiplier: bill.Meter2_Multiplier || '',
      Meter2_kWh: bill.Meter2_kWh || '',
      Meter2_KW: bill.Meter2_KW || '',
      Meter2_RKVA: bill.Meter2_RKVA || '',
      utilityCompany: bill.UtilityCompany || '',
      customerName: bill.CustomerName || '',
      serviceAddress: bill.ServiceAddress || '',
      accountNumber: bill.AccountNumber || '',
      meterNumber: bill.MeterNumber || '',
      numberOfDays: bill.NumberOfDays || '',
      meterReadStart: bill.MeterReadStart || '',
      meterReadEnd: bill.MeterReadEnd || '',
      billDate: bill.BillDate || '',
      commodity: bill.Commodity || '',
      startRead: bill.StartRead || '',
      endRead: bill.EndRead || '',
      readDifference: bill.ReadDifference || '',
      meterMultiplier: bill.MeterMultiplier || '',
      actualRKVA: bill.ActualRKVA || '',
      tdcKW: bill.TDCkW || '',
      taxExemptDelivery: bill.TaxExemptDelivery || '',
      billOffset: bill.BillOffset || '',
      naturalGasCCF: bill.NaturalGasCCF || '',
      naturalGasTherms: bill.NaturalGasTherms || '',
      naturalGasMMbtu: bill.NaturalGasMMbtu || bill.naturalGasMMbtu || '',
      // WRE per-site charge components and printed rates (Fix a84458f0 + printed-rates fix)
      _wreTriggerCharge: bill._wreTriggerCharge || '',
      _wreIndexCharge: bill._wreIndexCharge || '',
      _wreSWECharge: bill._wreSWECharge || '',
      _wreTriggerMMbtu: bill._wreTriggerMMbtu || '',
      _wreIndexMMbtu: bill._wreIndexMMbtu || '',
      _wreTriggerRate: bill._wreTriggerRate || '',
      _wreIndexRate: bill._wreIndexRate || '',
      // Fix [therms-unit-2026-06-22]: canonicalize therms to Therms at save time.
      therms: (() => {
        const t = pf(bill.NaturalGasTherms);
        if (t) return t; // already Therms — Constellation/KGS
        const ccf = pf(bill.NaturalGasCCF);
        if (ccf) return Math.round(ccf * 1.037 * 100) / 100; // CCF → Therms
        const mm = pf(bill.NaturalGasMMbtu || bill.naturalGasMMbtu);
        if (mm) return Math.round(mm * 10 * 100) / 100; // MMBtu → Therms (×10)
        return '';
      })(),
      // Bug d4c78f06: thermCost must be the gas commodity cost (GasCharge),
      // not TotalCurrentCharges (which includes base/customer/tax charges).
      // The $/therm rate in Meter Data + Baseline Data tables divides by this field.
      // Fall back to TotalCurrentCharges only when GasCharge is unavailable.
      thermCost:
        bill.NaturalGasTherms || bill.NaturalGasCCF || bill.NaturalGasMMbtu || bill.naturalGasMMbtu
          ? bill.GasCharge || bill.TotalCurrentCharges || bill.TotalAmountDue || ''
          : '',
      gasCharge: bill.GasCharge || '',
      fuelAdjustment: bill.FuelAdjustment || '',
      waterUsage: bill.WaterUsage || '',
      waterCharge: bill.WaterCharge || '',
      waterProtectionFee: bill.WaterProtectionFee || '',
      sewerUsage: bill.SewerUsage || '',
      sewerCharge: bill.SewerCharge || '',
      stormWaterCharge: bill.StormWaterCharge || '',
      invoiceNumber: bill.InvoiceNumber || '',
      saleNumber: bill.SaleNumber || '',
      deliveryDate: bill.DeliveryDate || '',
      fuelType: bill.FuelType || '',
      gallonsDelivered: bill.GallonsDelivered || '',
      unitPrice: bill.UnitPrice || '',
      subtotal: bill.Subtotal || '',
      tax: bill.Tax || '',
      totalKwhRate: (() => {
        const _kwh = pf(bill.kWhConsumed);
        const _chg = pf(kwhCost);
        return _kwh > 0 && _chg > 0 ? (_chg / _kwh).toFixed(5) : bill.TotalKWhRate || '';
      })(),
      totalKwRate: (() => {
        const _kw = pf(bill.BilledKW) || pf(bill.ActualKW) || pf(bill.FacilitiesKW);
        const _chg = pf(kwCost) + pf(bill.FacilitiesCharge);
        return _kw > 0 && _chg > 0 ? (_chg / _kw).toFixed(5) : bill.TotalKWRate || '';
      })(),
      facilitiesRate: bill.FacilitiesRate || '',
      demandRate: bill.DemandRate || '',
      tdcRate: bill.TDCRate || '',
      onPeakRate: bill.OnPeakRate || '',
      offPeakRate: bill.OffPeakRate || '',
      ecaRate: bill.ECARate || '',
      eerRate: bill.EERRate || '',
      ptsRate: bill.PTSRate || '',
      rkvaRate: bill.RkVARate || '',
      // Non-electric commodity rates — computed from canonical usage + charge at save time.
      // When the bill stores MMBtu natively (WRE) and has no Therms/CCF data, store
      // totalGasRate as $/MMBtu so the column header and value are semantically consistent.
      totalGasRate: (() => {
        const c = pf(bill.GasCharge) || pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        const therms =
          pf(bill.NaturalGasTherms) ||
          (pf(bill.NaturalGasCCF) ? Math.round(pf(bill.NaturalGasCCF) * 1.037 * 100) / 100 : 0);
        if (therms > 0 && c > 0) return (c / therms).toFixed(5); // $/Therm
        // MMBtu-only path (WRE): store as $/MMBtu — matches the column label when billUnit='MMBtu'
        const mmbtu = pf(bill.NaturalGasMMbtu || bill.naturalGasMMbtu);
        return mmbtu > 0 && c > 0 ? (c / mmbtu).toFixed(5) : '';
      })(),
      totalWaterRate: (() => {
        const u = pf(bill.WaterUsage);
        const c = pf(bill.WaterCharge) || pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
      })(),
      totalPropaneRate: (() => {
        const g = pf(bill.GallonsDelivered);
        const up = pf(bill.UnitPrice);
        if (up > 0) return up.toFixed(5);
        const c = pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        return g > 0 && c > 0 ? (c / g).toFixed(5) : '';
      })(),
      totalSewerRate: (() => {
        const u = pf(bill.SewerUsage);
        const c = pf(bill.SewerCharge);
        return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
      })(),
      totalStormwaterRate: (() => {
        const c = pf(bill.StormWaterCharge);
        return c > 0 ? c.toFixed(2) : '';
      })(),
    };
    if (bill._rates) {
      const cp = {};
      for (const [k, v] of Object.entries(bill._rates)) {
        if (v.parts && v.parts.length > 1) {
          cp[k] = v.parts.map((p) => ({
            qty: p.qty || null,
            rate: p.rate || null,
            unit: p.unit || null,
            charge: p.ocrCharge != null ? p.ocrCharge : p.computed,
          }));
        }
      }
      if (Object.keys(cp).length) billRow._chargeParts = cp;
    }
    let billMatch = findMeterMatch(bill);
    if (!billMatch) billMatch = _autoAssignTarget;
    const _bComm = (bill.Commodity || '').toLowerCase();
    let _mComm = (billMatch.meter.commodity || '').toLowerCase();
    if (_bComm && !_mComm) {
      billMatch.meter.commodity = bill.Commodity;
      _mComm = _bComm;
    }
    if (_bComm && _mComm && _bComm !== _mComm) {
      const _existM = (billMatch.bldg.meters || []).find((m) => (m.commodity || '').toLowerCase() === _bComm);
      if (_existM) {
        billMatch = { ...billMatch, meter: _existM, meterId: _existM.id };
      } else {
        const _newM = {
          id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          commodity:
            bill.Commodity ||
            (bill.NaturalGasTherms || bill.NaturalGasCCF || bill.GasCharge
              ? 'Gas'
              : bill.GallonsDelivered || bill.FuelType
                ? 'Propane'
                : 'Electric'),
          provider: bill.UtilityCompany || billMatch.meter.provider || '',
          account: bill.AccountNumber || billMatch.meter.account || '',
          meter: '',
          maddr: billMatch.meter.maddr || '',
          inclusive: true,
          bills: [],
          billUnit: '',
          displayUnit: '',
        };
        billMatch.bldg.meters = billMatch.bldg.meters || [];
        billMatch.bldg.meters.push(_newM);
        billMatch = { ...billMatch, meter: _newM, meterId: _newM.id };
      }
    }
    const targetMeter = billMatch.meter;
    // Bug 86d02961: update stored account number when a fuzzy match found a
    // format change (new bill format has longer/different account number).
    if (bill.AccountNumber && targetMeter.account) {
      const _extN = bill.AccountNumber.replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      const _stoN = targetMeter.account
        .replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      if (_extN !== _stoN && (_extN.includes(_stoN) || _stoN.includes(_extN))) {
        if (bill.AccountNumber.length > targetMeter.account.length) {
          console.log('[_saveBillToMatchedMeter] updating meter account', targetMeter.account, '→', bill.AccountNumber);
          targetMeter.account = bill.AccountNumber;
        }
      }
    }
    // Auto-set billUnit='MMBtu' for WRE meters so the bills table shows the MMBtu
    // column and $/MMBtu rate rather than defaulting to Therms (issue #16/#19).
    if ((bill._utilityName || '').toLowerCase().includes('wood river') && !targetMeter.billUnit) {
      targetMeter.billUnit = 'MMBtu';
    }
    targetMeter.bills = targetMeter.bills || [];
    const dup = targetMeter.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
    if (dup) {
      Object.assign(dup, billRow);
    } else {
      targetMeter.bills.push(billRow);
      targetMeter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
    }
    saved++;
  }
  saveUtilityData();
  window._pdfBillsSaved = true;
  const _blInherited = _inheritBaselinesForProject(udSelProjId);
  document.getElementById('pdfAutoAssignBanner').style.display = 'none';
  _autoAssignTarget = null;
  showToast(
    saved +
      ' bill' +
      (saved !== 1 ? 's' : '') +
      ' saved to matched meters' +
      (_blInherited ? ' · ' + _blInherited + ' baseline' + (_blInherited !== 1 ? 's' : '') + ' inherited' : '') +
      ' ✓',
  );
  if (udSelProjId && udSelBldgId) {
    renderUDDetail();
    renderUDProjList();
  }
}

async function confirmMultiBuildingSave() {
  const bills = window._pdfMultiBills;
  if (!bills || !bills.length) return;
  const dupMap = window._pdfDupMap || {};

  // Dup-unresolved gate
  const unresolved = Object.values(dupMap).filter(function (d) {
    return d.action === null;
  });
  if (unresolved.length > 0) {
    showToast(unresolved.length + ' duplicate bill(s) need review — click yellow-dot pills to resolve');
    return;
  }

  // Unmatched gate — every non-skipped bill must have a destination
  for (let _bi = 0; _bi < bills.length; _bi++) {
    const billDup = dupMap[_bi];
    if (billDup && billDup.action === 'skip') continue;
    if (!_mbRowTargets[_bi]) {
      showToast('All billing periods need a destination — assign remaining rows first');
      return;
    }
  }

  const pf = function (v) {
    return v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0;
  };
  function toISO(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  }

  // Store PDF once under a shared key to avoid duplication
  const sharedId = bills[0]?._pdfSharedKey || Date.now();
  const pdfKey = 'en_pdf_shared_' + String(sharedId).replace(/^en_pdf_shared_/, '');
  let pdfStored = false;

  let saved = 0;
  let flaggedForReview = 0;
  for (let _bi = 0; _bi < bills.length; _bi++) {
    const bill = bills[_bi];
    const billDup = dupMap[_bi];
    if (billDup && billDup.action === 'skip') continue;

    let billMatch = _mbRowTargets[_bi];
    if (!billMatch) {
      console.warn('[confirmMultiBuildingSave] no target for bill', _bi, '— skipping');
      continue;
    }

    // Store PDF file once on first saved bill
    let hasPDF = false;
    if (pdfB64 && !pdfStored) {
      hasPDF = await pdfStore(pdfKey, pdfB64);
      bills.forEach(function (b) {
        b._pdfSharedKey = String(sharedId).replace(/^en_pdf_shared_/, '');
      });
      pdfStored = true;
    } else if (pdfB64) {
      hasPDF = true;
    }

    const billId = 'pb' + Date.now() + '_' + saved;
    const kwhCost = (
      pf(bill.EnergyOnPeakCharge) +
      pf(bill.EnergyOffPeakCharge) +
      pf(bill.ECACharge) +
      pf(bill.EERCharge) +
      pf(bill.PTSCharge)
    ).toFixed(2);
    const kwCost = (pf(bill.BilledKWCharge) + pf(bill.TDCCharge)).toFixed(2);
    const otherCost = (
      pf(bill.CustomerCharge) +
      pf(bill.TaxExemptDelivery) +
      pf(bill.BillOffset) +
      pf(bill.RkVACharge)
    ).toFixed(2);
    const taxCost = pf(bill.FranchiseFee).toFixed(2);

    const billRow = {
      id: 'r' + Date.now() + '_' + saved,
      start: toISO(bill.BillingPeriodStart || bill.DeliveryDate),
      end: toISO(bill.BillingPeriodEnd || bill.DeliveryDate),
      kwh: bill.kWhConsumed || bill.NaturalGasCCF || bill.GallonsDelivered || '',
      demandKW: bill.ActualKW || '',
      billedKW: bill.BilledKW || '',
      facKW: bill.FacilitiesKW || '',
      facKWCost: bill.FacilitiesCharge || '',
      kwCost,
      kwhCost,
      otherCost,
      taxCost,
      totalCost: bill.TotalCurrentCharges || bill.TotalAmountDue || '',
      fromPDF: true,
      pdfBillId: billId,
      hasPDF,
      pdfKey: pdfKey || null,
      pdfPageStart: bill._pageStart || null,
      pdfPageEnd: bill._pageEnd || null,
      rateSchedule: bill.RateSchedule || '',
      onPeakKwh: bill.OnPeakKWh || bill.EnergyOnPeakKWh || '',
      offPeakKwh: bill.OffPeakKWh || bill.EnergyOffPeakKWh || '',
      onPeakCost: bill.EnergyOnPeakCharge || '',
      offPeakCost: bill.EnergyOffPeakCharge || '',
      customerCharge: bill.CustomerCharge || '',
      demandCharge: bill.BilledKWCharge || '',
      facilitiesCharge: bill.FacilitiesCharge || '',
      ecaCharge: bill.ECACharge || '',
      eerCharge: bill.EERCharge || '',
      ptsCharge: bill.PTSCharge || '',
      tdcCharge: bill.TDCCharge || '',
      rkvaCharge: bill.RkVACharge || '',
      renewableCharge: bill.RenewableCharge || '',
      franchiseFee: bill.FranchiseFee || '',
      franchiseFee1: bill.FranchiseFee1 || '',
      franchiseFee2: bill.FranchiseFee2 || '',
      solarCredit: bill.SolarCredit || '',
      generationKwh: bill.GenerationKwh || '',
      Meter1_ReadStart: bill.Meter1_ReadStart || '',
      Meter1_ReadEnd: bill.Meter1_ReadEnd || '',
      Meter1_StartRead: bill.Meter1_StartRead || '',
      Meter1_EndRead: bill.Meter1_EndRead || '',
      Meter1_ReadDiff: bill.Meter1_ReadDiff || '',
      Meter1_Multiplier: bill.Meter1_Multiplier || '',
      Meter1_kWh: bill.Meter1_kWh || '',
      Meter1_KW: bill.Meter1_KW || '',
      Meter1_RKVA: bill.Meter1_RKVA || '',
      Meter2_ReadStart: bill.Meter2_ReadStart || '',
      Meter2_ReadEnd: bill.Meter2_ReadEnd || '',
      Meter2_StartRead: bill.Meter2_StartRead || '',
      Meter2_EndRead: bill.Meter2_EndRead || '',
      Meter2_ReadDiff: bill.Meter2_ReadDiff || '',
      Meter2_Multiplier: bill.Meter2_Multiplier || '',
      Meter2_kWh: bill.Meter2_kWh || '',
      Meter2_KW: bill.Meter2_KW || '',
      Meter2_RKVA: bill.Meter2_RKVA || '',
      utilityCompany: bill.UtilityCompany || '',
      customerName: bill.CustomerName || '',
      serviceAddress: bill.ServiceAddress || '',
      accountNumber: bill.AccountNumber || '',
      meterNumber: bill.MeterNumber || '',
      numberOfDays: bill.NumberOfDays || '',
      meterReadStart: bill.MeterReadStart || '',
      meterReadEnd: bill.MeterReadEnd || '',
      billDate: bill.BillDate || '',
      commodity: bill.Commodity || '',
      startRead: bill.StartRead || '',
      endRead: bill.EndRead || '',
      readDifference: bill.ReadDifference || '',
      meterMultiplier: bill.MeterMultiplier || '',
      actualRKVA: bill.ActualRKVA || '',
      tdcKW: bill.TDCkW || '',
      taxExemptDelivery: bill.TaxExemptDelivery || '',
      billOffset: bill.BillOffset || '',
      naturalGasCCF: bill.NaturalGasCCF || '',
      naturalGasTherms: bill.NaturalGasTherms || '',
      naturalGasMMbtu: bill.NaturalGasMMbtu || bill.naturalGasMMbtu || '',
      _wreTriggerCharge: bill._wreTriggerCharge || '',
      _wreIndexCharge: bill._wreIndexCharge || '',
      _wreSWECharge: bill._wreSWECharge || '',
      _wreTriggerMMbtu: bill._wreTriggerMMbtu || '',
      _wreIndexMMbtu: bill._wreIndexMMbtu || '',
      _wreTriggerRate: bill._wreTriggerRate || '',
      _wreIndexRate: bill._wreIndexRate || '',
      therms: (function () {
        const t = pf(bill.NaturalGasTherms);
        if (t) return t;
        const ccf = pf(bill.NaturalGasCCF);
        if (ccf) return Math.round(ccf * 1.037 * 100) / 100;
        const mm = pf(bill.NaturalGasMMbtu || bill.naturalGasMMbtu);
        if (mm) return Math.round(mm * 10 * 100) / 100;
        return '';
      })(),
      thermCost:
        bill.NaturalGasTherms || bill.NaturalGasCCF || bill.NaturalGasMMbtu || bill.naturalGasMMbtu
          ? bill.GasCharge || bill.TotalCurrentCharges || bill.TotalAmountDue || ''
          : '',
      gasCharge: bill.GasCharge || '',
      fuelAdjustment: bill.FuelAdjustment || '',
      waterUsage: bill.WaterUsage || '',
      waterCharge: bill.WaterCharge || '',
      waterProtectionFee: bill.WaterProtectionFee || '',
      sewerUsage: bill.SewerUsage || '',
      sewerCharge: bill.SewerCharge || '',
      stormWaterCharge: bill.StormWaterCharge || '',
      invoiceNumber: bill.InvoiceNumber || '',
      saleNumber: bill.SaleNumber || '',
      deliveryDate: bill.DeliveryDate || '',
      fuelType: bill.FuelType || '',
      gallonsDelivered: bill.GallonsDelivered || '',
      unitPrice: bill.UnitPrice || '',
      subtotal: bill.Subtotal || '',
      tax: bill.Tax || '',
      totalKwhRate: (function () {
        const _kwh = pf(bill.kWhConsumed);
        const _chg = pf(kwhCost);
        return _kwh > 0 && _chg > 0 ? (_chg / _kwh).toFixed(5) : bill.TotalKWhRate || '';
      })(),
      totalKwRate: (function () {
        const _kw = pf(bill.BilledKW) || pf(bill.ActualKW) || pf(bill.FacilitiesKW);
        const _chg = pf(kwCost) + pf(bill.FacilitiesCharge);
        return _kw > 0 && _chg > 0 ? (_chg / _kw).toFixed(5) : bill.TotalKWRate || '';
      })(),
      facilitiesRate: bill.FacilitiesRate || '',
      demandRate: bill.DemandRate || '',
      tdcRate: bill.TDCRate || '',
      onPeakRate: bill.OnPeakRate || '',
      offPeakRate: bill.OffPeakRate || '',
      ecaRate: bill.ECARate || '',
      eerRate: bill.EERRate || '',
      ptsRate: bill.PTSRate || '',
      rkvaRate: bill.RkVARate || '',
      totalGasRate: (function () {
        const c = pf(bill.GasCharge) || pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        const therms =
          pf(bill.NaturalGasTherms) ||
          (pf(bill.NaturalGasCCF) ? Math.round(pf(bill.NaturalGasCCF) * 1.037 * 100) / 100 : 0);
        if (therms > 0 && c > 0) return (c / therms).toFixed(5);
        const mmbtu = pf(bill.NaturalGasMMbtu || bill.naturalGasMMbtu);
        return mmbtu > 0 && c > 0 ? (c / mmbtu).toFixed(5) : '';
      })(),
      totalWaterRate: (function () {
        const u = pf(bill.WaterUsage);
        const c = pf(bill.WaterCharge) || pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
      })(),
      totalPropaneRate: (function () {
        const g = pf(bill.GallonsDelivered);
        const up = pf(bill.UnitPrice);
        if (up > 0) return up.toFixed(5);
        const c = pf(bill.TotalCurrentCharges) || pf(bill.TotalAmountDue);
        return g > 0 && c > 0 ? (c / g).toFixed(5) : '';
      })(),
      totalSewerRate: (function () {
        const u = pf(bill.SewerUsage);
        const c = pf(bill.SewerCharge);
        return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
      })(),
      totalStormwaterRate: (function () {
        const c = pf(bill.StormWaterCharge);
        return c > 0 ? c.toFixed(2) : '';
      })(),
    };

    if (bill._rates) {
      const cp = {};
      for (const [k, v] of Object.entries(bill._rates)) {
        if (v.parts && v.parts.length > 1) {
          cp[k] = v.parts.map(function (p) {
            return {
              qty: p.qty || null,
              rate: p.rate || null,
              unit: p.unit || null,
              charge: p.ocrCharge != null ? p.ocrCharge : p.computed,
            };
          });
        }
      }
      if (Object.keys(cp).length) billRow._chargeParts = cp;
    }

    // Commodity-mismatch / meter-create block — identical to confirmAutoAssign
    const _bComm = (bill.Commodity || '').toLowerCase();
    let _mComm = (billMatch.meter.commodity || '').toLowerCase();
    if (_bComm && !_mComm) {
      billMatch.meter.commodity = bill.Commodity;
      _mComm = _bComm;
    }
    if (_bComm && _mComm && _bComm !== _mComm) {
      const _existM = (billMatch.bldg.meters || []).find(function (m) {
        return (m.commodity || '').toLowerCase() === _bComm;
      });
      if (_existM) {
        billMatch = Object.assign({}, billMatch, { meter: _existM, meterId: _existM.id });
      } else {
        const _newM = {
          id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          commodity:
            bill.Commodity ||
            (bill.NaturalGasTherms || bill.NaturalGasCCF || bill.GasCharge
              ? 'Gas'
              : bill.GallonsDelivered || bill.FuelType
                ? 'Propane'
                : 'Electric'),
          provider: bill.UtilityCompany || billMatch.meter.provider || '',
          account: bill.AccountNumber || billMatch.meter.account || '',
          meter: '',
          maddr: billMatch.meter.maddr || '',
          inclusive: true,
          bills: [],
          billUnit: '',
          displayUnit: '',
        };
        billMatch.bldg.meters = billMatch.bldg.meters || [];
        billMatch.bldg.meters.push(_newM);
        billMatch = Object.assign({}, billMatch, { meter: _newM, meterId: _newM.id });
      }
    }

    const targetMeter = billMatch.meter;
    if (bill.AccountNumber && targetMeter.account) {
      const _extN = bill.AccountNumber.replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      const _stoN = targetMeter.account
        .replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      if (_extN !== _stoN && (_extN.includes(_stoN) || _stoN.includes(_extN))) {
        if (bill.AccountNumber.length > targetMeter.account.length) {
          targetMeter.account = bill.AccountNumber;
        }
      }
    }
    if ((bill._utilityName || '').toLowerCase().includes('wood river') && !targetMeter.billUnit) {
      targetMeter.billUnit = 'MMBtu';
    }
    targetMeter.bills = targetMeter.bills || [];
    const dup = targetMeter.bills.find(function (r) {
      return r.start === billRow.start && r.end === billRow.end;
    });
    // Gate (fix 11e47d64/9de73981, mirrors the saveQueuedBills b-46a984a0
    // identity gate at ~line 7420): evaluated ONCE, before the dup/no-dup
    // branch, and applies to BOTH — a non-identity (address-similarity) guess
    // must not silently write to targetMeter.bills at all, whether that write
    // is an overwrite of an existing period (dup) OR a brand-new push (no
    // dup). The non-colliding push case is the MORE COMMON real-world trigger
    // (most re-uploaded bills land on a NEW period, not the exact one already
    // saved) and was originally left ungated here — confirmed empirically
    // against the real Louisburg incident accounts (8980291458 vs
    // 0669287870) during review. Only two things may pass this gate:
    //   (a) billMatch.matchType === 'identity' (account/meter-number hit from
    //       findMeterMatch) AND the incoming bill's own AccountNumber
    //       reasonably agrees with the target meter's stored account, or
    //   (b) billMatch.matchType === 'manual' — the user explicitly picked
    //       this Project -> Building -> Meter via the "Change" override in
    //       showMultiBuildingReviewPanel / _mbCommitRowTarget. An explicit
    //       user pick is authoritative and always wins, exactly like the
    //       _meterOverride exemption in saveQueuedBills — it must not be
    //       diverted to review just because it lacks an 'identity' tag.
    const _isManualPick = billMatch.matchType === 'manual';
    const _acctAgrees =
      !targetMeter.account || !bill.AccountNumber || _acctFuzzyMatch(bill.AccountNumber, targetMeter.account);
    const _gateOK = _isManualPick || (billMatch.matchType === 'identity' && _acctAgrees);
    if (_gateOK) {
      if (dup) {
        Object.assign(dup, billRow);
      } else {
        targetMeter.bills.push(billRow);
        targetMeter.bills.sort(function (a, b) {
          return _parseISO(a.start) - _parseISO(b.start);
        });
      }
      saved++;
    } else {
      console.warn(
        '[confirmMultiBuildingSave] identity gate failed — refusing to write to targetMeter.bills (',
        dup ? 'would have overwritten an existing period' : 'would have created a new bill on a guessed meter',
        '), routing to Saved Bills for review instead of auto-applying',
        {
          billIdx: _bi,
          matchType: billMatch.matchType,
          incomingAcct: bill.AccountNumber,
          targetMeterAcct: targetMeter.account,
        },
      );
      const _pdfBillsForReview = (await sget('en_pdf_bills', [])) || [];
      _pdfBillsForReview.push(
        Object.assign(
          {
            id: 'pb' + Date.now() + '_' + _bi + '_review',
            savedAt: new Date().toISOString(),
            projId: billMatch.projId || null,
            projName: (billMatch.proj && billMatch.proj.name) || 'General',
            hasPDF,
          },
          bill,
        ),
      );
      await sset('en_pdf_bills', _pdfBillsForReview);
      flaggedForReview++;
    }
  }

  // Save once after the loop — never per-bill
  saveUtilityData();
  window._pdfBillsSaved = true;
  _inheritBaselinesForProject(udSelProjId);
  document.getElementById('pdfMultiBldgPanel').style.display = 'none';
  _mbRowTargets = {};
  _autoAssignTarget = null;
  showToast(
    saved +
      ' bill' +
      (saved !== 1 ? 's' : '') +
      ' saved to matched meters' +
      (flaggedForReview ? ', ' + flaggedForReview + ' flagged for review (account mismatch) — check Saved Bills' : '') +
      ' ✓',
  );
  if (udSelProjId && udSelBldgId) {
    renderUDDetail();
    renderUDProjList();
  }
}
window.confirmMultiBuildingSave = confirmMultiBuildingSave;

// Store the current extraction's source PDF once per session and tag every bill
// in the batch with a shared key, so downstream save paths (_saveBillToMatchedMeter,
// _applyDupUpdate's _copyPageRange, _saveSinglePDFBill) all reference the SAME
// stored PDF via `_pdfSharedKey`. Without this, bulk saves silently drop the PDF
// (new bills end up with pdfKey=null, and dup overwrites write new page ranges
// against OLD stored PDFs producing blank slices).
//
// Idempotent — if the batch is already tagged with a shared key, returns the
// existing one without re-storing.
//
// Falls back to localStorage if IndexedDB (pdfStore) fails — a corporate
// machine may have IndexedDB disabled by group policy, and without a fallback
// every saved bill silently loses its PDF reference. The fallback writes the
// base64 string directly via localStorage.setItem(key, pdfB64) (raw, not JSON)
// so viewSavedPDF can retrieve it via localStorage.getItem(key). Subject to the
// ~5MB per-origin localStorage quota.
async function _ensureBatchPdfStored(bills) {
  if (!bills || !bills.length) return null;
  const existingKey = bills[0]._pdfSharedKey;
  if (existingKey) {
    console.log('[_ensureBatchPdfStored] reusing existing key:', existingKey);
    return existingKey;
  }
  if (!pdfB64) {
    console.log('[_ensureBatchPdfStored] no pdfB64 — nothing to store');
    return null;
  }
  const key = 'en_pdf_shared_' + Date.now();
  let stored = false;
  try {
    stored = await pdfStore(key, pdfB64);
  } catch (e) {
    console.warn('[_ensureBatchPdfStored] pdfStore threw:', e);
    stored = false;
  }
  if (!stored) {
    // IndexedDB failed — try localStorage as a fallback. Use localStorage.setItem
    // directly (not sset) to avoid JSON wrapping and avoid firing a dataUpdated
    // event for a potentially-multi-MB write.
    try {
      localStorage.setItem(key, pdfB64);
      stored = true;
      console.warn('[_ensureBatchPdfStored] IndexedDB pdfStore failed, used localStorage fallback for', key);
      showToast('PDF saved to local fallback (IndexedDB unavailable on this machine)');
    } catch (e) {
      console.error('[_ensureBatchPdfStored] both IndexedDB and localStorage failed — PDF not stored', e);
      showToast("Couldn't store PDF — IndexedDB blocked and localStorage full. Bills saved without PDF.");
      return null;
    }
  }
  bills.forEach((b) => {
    b._pdfSharedKey = key;
  });
  console.log('[_ensureBatchPdfStored] stored PDF under', key, '— tagged', bills.length, 'bills');
  return key;
}

// Save a single extracted bill directly to a matched meter (from findMeterMatch).
// Reuses the same billRow shape as _saveSinglePDFBill and confirmAutoAssign so the
// record lands in the same storage structure. Returns a destination description
// string on success, or null on failure.
//
// This is the fast-path for "we already know where this bill goes" — called
// whenever a bill has a global meter match by account/meter number, so the user
// never needs to pick a project just for the code to put the bill in the right
// place.
function _saveBillToMatchedMeter(extracted, match) {
  if (!extracted || !match || !match.proj || !match.bldg || !match.meter) return null;
  const billComm = (extracted.Commodity || '').toLowerCase();
  let meterComm = (match.meter.commodity || '').toLowerCase();
  if (billComm && !meterComm) {
    match.meter.commodity = extracted.Commodity;
    meterComm = billComm;
  }
  if (billComm && meterComm && billComm !== meterComm) {
    const existingMeter = (match.bldg.meters || []).find((m) => (m.commodity || '').toLowerCase() === billComm);
    if (existingMeter) {
      match = { ...match, meter: existingMeter, meterId: existingMeter.id };
    } else {
      const newMeter = {
        id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        commodity:
          extracted.Commodity ||
          (extracted.NaturalGasTherms || extracted.NaturalGasCCF || extracted.GasCharge
            ? 'Gas'
            : extracted.GallonsDelivered || extracted.FuelType
              ? 'Propane'
              : 'Electric'),
        provider: extracted.UtilityCompany || match.meter.provider || '',
        account: extracted.AccountNumber || match.meter.account || '',
        meter: '',
        maddr: match.meter.maddr || '',
        inclusive: true,
        bills: [],
        billUnit: '',
        displayUnit: '',
      };
      match.bldg.meters = match.bldg.meters || [];
      match.bldg.meters.push(newMeter);
      match = { ...match, meter: newMeter, meterId: newMeter.id };
    }
  }
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const toISO = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  };
  // Fix 2: parse service address from filename when OCR didn't capture it
  // KGS filenames: "604 Dearborn St Howard Hall - Gas Bills.pdf"
  const _srcFile = extracted._sourceFile || '';
  const _filenameAddr = _srcFile
    .replace(/\s*-\s*Gas Bills\.pdf$/i, '')
    .replace(/\.pdf$/i, '')
    .trim();
  if (_filenameAddr && !extracted.ServiceAddress) extracted.ServiceAddress = _filenameAddr;
  const kwhCost = (
    pf(extracted.EnergyOnPeakCharge) +
    pf(extracted.EnergyOffPeakCharge) +
    pf(extracted.ECACharge) +
    pf(extracted.EERCharge) +
    pf(extracted.PTSCharge)
  ).toFixed(2);
  const kwCost = (pf(extracted.BilledKWCharge) + pf(extracted.TDCCharge)).toFixed(2);
  const otherCost = (
    pf(extracted.CustomerCharge) +
    pf(extracted.TaxExemptDelivery) +
    pf(extracted.BillOffset) +
    pf(extracted.RkVACharge)
  ).toFixed(2);
  const taxCost = pf(extracted.FranchiseFee).toFixed(2);
  const usageQty =
    extracted.kWhConsumed ||
    extracted.NaturalGasTherms ||
    extracted.NaturalGasCCF ||
    extracted.NaturalGasMMbtu ||
    extracted.GallonsDelivered ||
    '';
  const billRow = {
    id: 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    start: toISO(extracted.BillingPeriodStart || extracted.DeliveryDate),
    end: toISO(extracted.BillingPeriodEnd || extracted.DeliveryDate),
    // Metadata (Update 84 — previously dropped on match-save path)
    utilityCompany: extracted.UtilityCompany || '',
    customerName: extracted.CustomerName || '',
    serviceAddress: extracted.ServiceAddress || '',
    accountNumber: extracted.AccountNumber || '',
    meterNumber: extracted.MeterNumber || '',
    numberOfDays: extracted.NumberOfDays || '',
    meterReadStart: extracted.MeterReadStart || '',
    meterReadEnd: extracted.MeterReadEnd || '',
    startRead: extracted.StartRead || '',
    endRead: extracted.EndRead || '',
    readDifference: extracted.ReadDifference || '',
    meterMultiplier: extracted.MeterMultiplier || '',
    billDate: extracted.BillDate || '',
    commodity: extracted.Commodity || '',
    kwh: usageQty,
    demandKW: extracted.ActualKW || '',
    actualRKVA: extracted.ActualRKVA || '',
    billedKW: extracted.BilledKW || '',
    facKW: extracted.FacilitiesKW || '',
    facKWCost: extracted.FacilitiesCharge || '',
    tdcKW: extracted.TDCkW || '',
    kwCost,
    kwhCost,
    otherCost,
    taxCost,
    totalCost: extracted.TotalCurrentCharges || extracted.TotalAmountDue || '',
    fromPDF: true,
    // pdfBillId is REQUIRED for the Bills table render to show the 📄 button
    // (renderBillRow gates on `row.pdfBillId && row.hasPDF`). Without it the
    // button is suppressed even though the PDF is stored and loadable, so every
    // non-duplicate match-saved bill silently loses its viewer button.
    pdfBillId: 'pb' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    hasPDF: !!extracted._pdfSharedKey,
    pdfPageStart: extracted._pageStart || null,
    pdfPageEnd: extracted._pageEnd || null,
    pdfKey: extracted._pdfSharedKey || null,
    rateSchedule: extracted.RateSchedule || '',
    onPeakKwh: extracted.OnPeakKWh || extracted.EnergyOnPeakKWh || '',
    offPeakKwh: extracted.OffPeakKWh || extracted.EnergyOffPeakKWh || '',
    onPeakCost: extracted.EnergyOnPeakCharge || '',
    offPeakCost: extracted.EnergyOffPeakCharge || '',
    customerCharge: extracted.CustomerCharge || '',
    demandCharge: extracted.BilledKWCharge || '',
    facilitiesCharge: extracted.FacilitiesCharge || '',
    ecaCharge: extracted.ECACharge || '',
    eerCharge: extracted.EERCharge || '',
    ptsCharge: extracted.PTSCharge || '',
    tdcCharge: extracted.TDCCharge || '',
    rkvaCharge: extracted.RkVACharge || '',
    taxExemptDelivery: extracted.TaxExemptDelivery || '',
    billOffset: extracted.BillOffset || '',
    renewableCharge: extracted.RenewableCharge || '',
    franchiseFee: extracted.FranchiseFee || '',
    franchiseFee1: extracted.FranchiseFee1 || '',
    franchiseFee2: extracted.FranchiseFee2 || '',
    solarCredit: extracted.SolarCredit || '',
    generationKwh: extracted.GenerationKwh || '',
    totalKwhRate: (() => {
      const _kwh = pf(extracted.kWhConsumed);
      const _chg = pf(kwhCost);
      return _kwh > 0 && _chg > 0 ? (_chg / _kwh).toFixed(5) : extracted.TotalKWhRate || '';
    })(),
    totalKwRate: (() => {
      const _kw = pf(extracted.BilledKW) || pf(extracted.ActualKW) || pf(extracted.FacilitiesKW);
      const _chg = pf(kwCost) + pf(extracted.FacilitiesCharge);
      return _kw > 0 && _chg > 0 ? (_chg / _kw).toFixed(5) : extracted.TotalKWRate || '';
    })(),
    facilitiesRate: extracted.FacilitiesRate || '',
    demandRate: extracted.DemandRate || '',
    tdcRate: extracted.TDCRate || '',
    onPeakRate: extracted.OnPeakRate || '',
    offPeakRate: extracted.OffPeakRate || '',
    ecaRate: extracted.ECARate || '',
    eerRate: extracted.EERRate || '',
    ptsRate: extracted.PTSRate || '',
    rkvaRate: extracted.RkVARate || '',
    // Non-electric commodity fields — written when the extractor emits them,
    // empty string otherwise so the Edit modal's per-commodity layout renders cleanly.
    naturalGasCCF: extracted.NaturalGasCCF || '',
    naturalGasTherms: extracted.NaturalGasTherms || '',
    naturalGasMMbtu: extracted.NaturalGasMMbtu || '',
    // WRE per-site charge components and printed rates (Fix a84458f0 + printed-rates fix)
    _wreTriggerCharge: extracted._wreTriggerCharge || '',
    _wreIndexCharge: extracted._wreIndexCharge || '',
    _wreSWECharge: extracted._wreSWECharge || '',
    _wreTriggerMMbtu: extracted._wreTriggerMMbtu || '',
    _wreIndexMMbtu: extracted._wreIndexMMbtu || '',
    _wreTriggerRate: extracted._wreTriggerRate || '',
    _wreIndexRate: extracted._wreIndexRate || '',
    // Fix [therms-unit-2026-06-22]: canonicalize therms to Therms at save time.
    // Wood River (and any future MMBtu extractor) sets NaturalGasMMbtu; Constellation/KGS
    // set NaturalGasTherms (already Therms). CCF × 1.037 = Therms. Priority: Therms > CCF > MMBtu.
    therms: (() => {
      const t = pf(extracted.NaturalGasTherms);
      if (t) return t; // already Therms — Constellation/KGS
      const ccf = pf(extracted.NaturalGasCCF);
      if (ccf) return Math.round(ccf * 1.037 * 100) / 100; // CCF → Therms
      const mm = pf(extracted.NaturalGasMMbtu);
      if (mm) return Math.round(mm * 10 * 100) / 100; // MMBtu → Therms (×10)
      return '';
    })(),
    // Bug d4c78f06: use GasCharge (commodity cost) for thermCost so $/therm rate
    // in tables uses energy-only cost, not total bill cost.
    thermCost:
      extracted.NaturalGasTherms || extracted.NaturalGasCCF || extracted.NaturalGasMMbtu
        ? extracted.GasCharge || extracted.TotalCurrentCharges || extracted.TotalAmountDue || ''
        : '',
    gasCharge: extracted.GasCharge || '',
    fuelAdjustment: extracted.FuelAdjustment || '',
    waterUsage: extracted.WaterUsage || '',
    waterCharge: extracted.WaterCharge || '',
    waterProtectionFee: extracted.WaterProtectionFee || '',
    sewerUsage: extracted.SewerUsage || '',
    sewerCharge: extracted.SewerCharge || '',
    stormWaterCharge: extracted.StormWaterCharge || '',
    invoiceNumber: extracted.InvoiceNumber || '',
    saleNumber: extracted.SaleNumber || '',
    deliveryDate: extracted.DeliveryDate || '',
    fuelType: extracted.FuelType || '',
    gallonsDelivered: extracted.GallonsDelivered || '',
    unitPrice: extracted.UnitPrice || '',
    subtotal: extracted.Subtotal || '',
    tax: extracted.Tax || '',
    // Non-electric commodity rates — computed from canonical usage + charge at save time.
    // When the bill stores MMBtu natively (WRE) and has no Therms/CCF, store as $/MMBtu
    // so the value is semantically consistent with the column label when billUnit='MMBtu'.
    totalGasRate: (() => {
      const c = pf(extracted.GasCharge) || pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      const therms =
        pf(extracted.NaturalGasTherms) ||
        (pf(extracted.NaturalGasCCF) ? Math.round(pf(extracted.NaturalGasCCF) * 1.037 * 100) / 100 : 0);
      if (therms > 0 && c > 0) return (c / therms).toFixed(5); // $/Therm
      // MMBtu-only path (WRE): store as $/MMBtu — matches column label when billUnit='MMBtu'
      const mmbtu = pf(extracted.NaturalGasMMbtu);
      return mmbtu > 0 && c > 0 ? (c / mmbtu).toFixed(5) : '';
    })(),
    totalWaterRate: (() => {
      const u = pf(extracted.WaterUsage);
      const c = pf(extracted.WaterCharge) || pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
    })(),
    totalPropaneRate: (() => {
      const g = pf(extracted.GallonsDelivered);
      const up = pf(extracted.UnitPrice);
      if (up > 0) return up.toFixed(5);
      const c = pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      return g > 0 && c > 0 ? (c / g).toFixed(5) : '';
    })(),
    totalSewerRate: (() => {
      const u = pf(extracted.SewerUsage);
      const c = pf(extracted.SewerCharge);
      return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
    })(),
    totalStormwaterRate: (() => {
      const c = pf(extracted.StormWaterCharge);
      return c > 0 ? c.toFixed(2) : '';
    })(),
    Meter1_ReadStart: extracted.Meter1_ReadStart || '',
    Meter1_ReadEnd: extracted.Meter1_ReadEnd || '',
    Meter1_StartRead: extracted.Meter1_StartRead || '',
    Meter1_EndRead: extracted.Meter1_EndRead || '',
    Meter1_ReadDiff: extracted.Meter1_ReadDiff || '',
    Meter1_Multiplier: extracted.Meter1_Multiplier || '',
    Meter1_kWh: extracted.Meter1_kWh || '',
    Meter1_KW: extracted.Meter1_KW || '',
    Meter1_RKVA: extracted.Meter1_RKVA || '',
    Meter2_ReadStart: extracted.Meter2_ReadStart || '',
    Meter2_ReadEnd: extracted.Meter2_ReadEnd || '',
    Meter2_StartRead: extracted.Meter2_StartRead || '',
    Meter2_EndRead: extracted.Meter2_EndRead || '',
    Meter2_ReadDiff: extracted.Meter2_ReadDiff || '',
    Meter2_Multiplier: extracted.Meter2_Multiplier || '',
    Meter2_kWh: extracted.Meter2_kWh || '',
    Meter2_KW: extracted.Meter2_KW || '',
    Meter2_RKVA: extracted.Meter2_RKVA || '',
    // Fix 3: KGS-specific fields
    mcfBilled: extracted.McfBilled || null,
    deliveryCharge: extracted.DeliveryCharge || null,
    gasSystemReliability: extracted.GasSystemReliability || null,
    winterEventCost: extracted.WinterEventCost || null,
    previousBalance: extracted.PreviousBalance || null,
    paymentsReceived: extracted.PaymentsReceived || null,
    statementDate: toISO(extracted.StatementDate) || null,
  };
  if (extracted._rates) {
    const cp = {};
    for (const [k, v] of Object.entries(extracted._rates)) {
      if (v.parts && v.parts.length > 1) {
        cp[k] = v.parts.map((p) => ({
          qty: p.qty || null,
          rate: p.rate || null,
          unit: p.unit || null,
          charge: p.ocrCharge != null ? p.ocrCharge : p.computed,
        }));
      }
    }
    if (Object.keys(cp).length) billRow._chargeParts = cp;
  }
  // Re-fetch the live meter reference from the store — the match object may hold
  // a stale snapshot if projects were mutated between findMeterMatch and now.
  const liveProj = projects.find((p) => p.id === match.projId);
  if (!liveProj) return null;
  const udProj = getUDProj(liveProj.id);
  const liveBldg = (udProj.buildings || []).find((b) => b.id === match.bldgId);
  if (!liveBldg) return null;
  const liveMeter = (liveBldg.meters || []).find((m) => m.id === match.meterId);
  if (!liveMeter) return null;
  // Auto-set billUnit='MMBtu' for WRE meters (issue #16/#19).
  if ((extracted._utilityName || '').toLowerCase().includes('wood river') && !liveMeter.billUnit) {
    liveMeter.billUnit = 'MMBtu';
  }
  liveMeter.bills = liveMeter.bills || [];
  const existing = liveMeter.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
  if (existing) {
    Object.assign(existing, billRow);
  } else {
    liveMeter.bills.push(billRow);
    liveMeter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  }
  // Run validation on the saved bill to persist _flags
  if (typeof runBillValidation === 'function') {
    const _savedBill = existing || billRow;
    runBillValidation(liveMeter, _savedBill);
  }
  // Run building-level cross-meter validation (water vs sewer parity, etc.)
  if (typeof runBuildingValidation === 'function') runBuildingValidation(liveBldg);
  // Fix 4: auto-populate meter account number on first save
  if (extracted.AccountNumber && !liveMeter.account) {
    liveMeter.account = extracted.AccountNumber;
  }
  saveUtilityData();
  return liveProj.name + ' → ' + liveBldg.name + ' → ' + (liveMeter.provider || liveMeter.meter || 'meter');
}

// Compute a destination description for a bill without actually saving it. Used to
// tell the user up front whether a bill already has a known home (and can skip
// the project selector) or if they need to pick one. Returns one of:
//   { method: 'dup', destination: string }  // bill is a duplicate
//   { method: 'match', destination: string }  // bill matches a meter globally
//   { method: 'project', destination: string }  // user picked a project
//   { method: 'unassigned' }  // no known home
function _resolveBillDestination(bill, dup, projId) {
  if (dup && dup.locationType === 'assigned') {
    return { method: 'dup', destination: dup.location || 'existing meter', dup };
  }
  if (dup && dup.locationType === 'saved') {
    return { method: 'dup', destination: 'Saved Bills', dup };
  }
  const match = findMeterMatch(bill);
  // Gate (fix 11e47d64/9de73981, mirrors the saveQueuedBills b-46a984a0 identity
  // gate): only an 'identity' match (account/meter-number hit) may resolve as
  // method:'match' here — the two callers of this function (_dupBulkAction,
  // savePDFAllBills) both auto-save straight to match.meter via
  // _saveBillToMatchedMeter with no further confirmation whenever method==='match'.
  // An 'address'-only match (fuzzy ServiceAddress similarity, no account/meter
  // number hit) is an unconfirmed guess and must NOT auto-route to a meter write —
  // fall through to the project-scoped / unassigned path below instead, which is
  // the same safe fallback (project-scoped account match, or Saved Bills for
  // manual review) that saveQueuedBills falls through to when its identity gate
  // fails.
  if (match && match.matchType === 'identity') {
    return {
      method: 'match',
      destination:
        match.proj.name + ' → ' + match.bldg.name + ' → ' + (match.meter.provider || match.meter.meter || 'meter'),
      match,
    };
  }
  if (projId) {
    const proj = projects.find((p) => p.id === projId);
    return { method: 'project', destination: (proj && proj.name) || 'selected project', projId };
  }
  return { method: 'unassigned', destination: 'Saved Bills (unassigned)' };
}

// Show a summary modal after a bulk save listing every bill and where it went.
// Gives the user a user-readable record they can review without digging through
// each meter's bill list.
function _showSaveSummary(entries) {
  if (!entries || !entries.length) return;
  const existing = document.getElementById('saveSummaryModal');
  if (existing) existing.remove();
  const rows = entries
    .map((e, i) => {
      const color =
        e.status === 'saved' || e.status === 'updated'
          ? '#22c55e'
          : e.status === 'skipped'
            ? 'var(--text3)'
            : '#ef4444';
      const icon =
        e.status === 'saved' || e.status === 'updated' ? '&#10003;' : e.status === 'skipped' ? '&#9888;' : '&#10005;';
      return (
        '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:6px 12px;color:var(--text3);font-variant-numeric:tabular-nums">' +
        (i + 1) +
        '</td>' +
        '<td style="padding:6px 12px;font-variant-numeric:tabular-nums">' +
        (e.period || '—') +
        '</td>' +
        '<td style="padding:6px 12px;text-transform:uppercase;font-size:10px;letter-spacing:.4px;color:' +
        color +
        ';font-weight:700">' +
        icon +
        '&nbsp;' +
        e.status +
        '</td>' +
        '<td style="padding:6px 12px;color:var(--text2)">' +
        (e.destination || '—') +
        '</td>' +
        '<td style="padding:6px 12px;color:var(--text3);font-size:10px">' +
        (e.method || '') +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  const counts = entries.reduce((a, e) => {
    a[e.status] = (a[e.status] || 0) + 1;
    return a;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => v + ' ' + k)
    .join(' · ');
  const modal = document.createElement('div');
  modal.id = 'saveSummaryModal';
  modal.className = 'modal-bg open';
  modal.style.cssText = 'display:flex;align-items:center;justify-content:center';
  modal.onclick = (ev) => {
    if (ev.target === modal) modal.remove();
  };
  modal.innerHTML =
    '<div class="modal" style="width:760px;max-width:96vw;max-height:84vh;display:flex;flex-direction:column">' +
    '<div class="modal-hdr">' +
    '<span class="modal-title">&#128196; Save Summary &mdash; ' +
    entries.length +
    ' bill' +
    (entries.length === 1 ? '' : 's') +
    '</span>' +
    '<button class="modal-x" onclick="document.getElementById(\'saveSummaryModal\').remove()">&#10005;</button>' +
    '</div>' +
    '<div style="padding:8px 16px;font-size:12px;color:var(--text2);border-bottom:1px solid var(--border)">' +
    summary +
    '</div>' +
    '<div class="modal-body" style="padding:0;overflow-y:auto;flex:1">' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead style="background:var(--s2);position:sticky;top:0">' +
    '<tr>' +
    '<th style="padding:8px 12px;text-align:left;color:var(--text2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px">#</th>' +
    '<th style="padding:8px 12px;text-align:left;color:var(--text2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px">Period</th>' +
    '<th style="padding:8px 12px;text-align:left;color:var(--text2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px">Status</th>' +
    '<th style="padding:8px 12px;text-align:left;color:var(--text2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px">Destination</th>' +
    '<th style="padding:8px 12px;text-align:left;color:var(--text2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px">Via</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div></div>';
  document.body.appendChild(modal);
}

function addExtractedField() {
  if (!window._pdfMultiBills || !window._pdfMultiBills.length) return;
  const bill = window._pdfMultiBills[window._pdfMultiIdx || 0];
  if (!bill) return;
  const FIELDS = [
    'CustomerCharge',
    'FacilitiesCharge',
    'BilledKWCharge',
    'EnergyOnPeakCharge',
    'EnergyOffPeakCharge',
    'ECACharge',
    'EERCharge',
    'PTSCharge',
    'TDCCharge',
    'RkVACharge',
    'TaxExemptDelivery',
    'BillOffset',
    'FranchiseFee',
    'TotalCurrentCharges',
    'kWhConsumed',
    'ActualKW',
    'OnPeakKWh',
    'OffPeakKWh',
    'GasCharge',
    'FuelAdjustment',
    'NaturalGasTherms',
  ];
  const existing = Object.keys(bill).filter((k) => bill[k] != null && bill[k] !== '');
  const available = FIELDS.filter((f) => !existing.includes(f));
  if (!available.length) {
    showToast('All standard fields are populated');
    return;
  }
  const sel = available[0];
  const name = prompt('Field name to add:', sel);
  if (!name) return;
  const val = prompt('Value for ' + name + ':', '');
  if (val == null) return;
  bill[name] = val;
  renderPDFFields(bill);
  showToast(name + ' added ✓');
}

function clearPDFOCR() {
  pdfB64 = null;
  window._pdfMultiBills = null;
  window._pdfMultiIdx = 0;
  window._pdfRawText = null;
  window._pdfBillWarnings = null;
  window._pdfDupMap = null;
  window._pdfQueue = null;
  window._pdfBillsSaved = false;
  window._pdfQueueRows = null;
  // F3 (clearPDFOCR path): release multi-pass OCR buffers when the user clicks Clear
  window._pdfOcrPasses = null;
  window._pdfPassScores = null;
  window._pdfOcrEmptyPages = null;
  window._pdfOcrBudgetExceeded = null;
  _clearExtractionState();
  document.getElementById('dz-title').textContent = 'Drop PDF here or click to browse';
  document.getElementById('pdfInput').value = '';
  document.getElementById('extractedFieldsHdr').innerHTML = '';
  document.getElementById('extractedFieldsGrid').innerHTML = '';
  document.getElementById('pdfPillsHdr').innerHTML = '';
  document.getElementById('pdfSaveRow').style.display = 'none';
  document.getElementById('pdfClearBtn').style.display = 'none';
  document.getElementById('dropZone').classList.remove('collapsed');
  document.getElementById('pdfTypeSection').style.display = '';
  const _badge = document.getElementById('extractMethodBadge');
  _badge.style.display = 'none';
  _badge.innerHTML = '';
  document.getElementById('pdfAutoAssignBanner').style.display = 'none';
  const dbg = document.getElementById('pdfDebugBtn');
  if (dbg) {
    dbg.style.display = 'none';
    dbg.textContent = '🔍 Raw Text';
  }
  const box = document.getElementById('pdfAIBox');
  box._showingRaw = false;
  box.textContent = 'Upload a PDF and select document type.';
  showToast('Cleared ✓');
}

// ── Multi-PDF Queue Extraction ──
window._pdfQueue = null;

function startQueueExtraction(files) {
  clearPDFOCR();
  window._pdfQueue = {
    files: files,
    results: [],
    currentIdx: 0,
    batchProjId: parseInt(document.getElementById('pdfProjSel').value) || null,
    status: 'idle',
    _processedCount: 0,
    _previewMode: false,
  };
  refreshProjDropdowns();
  document.getElementById('pdfSaveRow').style.display = 'none';
  document.getElementById('pdfClearBtn').style.display = 'none';
  document.getElementById('pdfTypeSection').style.display = 'none';
  document.getElementById('pdfRightCol').style.display = 'none';
  const dz = document.getElementById('dropZone');
  dz.classList.remove('collapsed');
  dz.setAttribute('data-queue', 'true');
  dz.style.cursor = 'default';
  renderQueueProgress();
  runExtractionQueue();
}

function appendToQueue(newFiles) {
  const q = window._pdfQueue;
  if (!q) {
    startQueueExtraction(newFiles);
    return;
  }
  const startIdx = q.files.length;
  q.files = q.files.concat(newFiles);
  showToast(newFiles.length + ' file' + (newFiles.length > 1 ? 's' : '') + ' added to queue');
  if (q.status === 'done' || q.status === 'cancelled') {
    q.status = 'running';
    window._pdfAbort = false;
    document.getElementById('pdfRightCol').style.display = 'none';
    const dz = document.getElementById('dropZone');
    dz.classList.remove('collapsed');
    dz.setAttribute('data-queue', 'true');
    dz.style.cursor = 'default';
    const tabsBar = document.getElementById('queueTabsBar');
    if (tabsBar) tabsBar.remove();
    renderQueueProgress();
    _runExtractionFrom(startIdx);
  } else {
    renderQueueProgress();
  }
}

function clearQueue() {
  _queueGroupState = null; // Plan 7e0b9d15 §4: reset group state on clear
  window._pdfQueue = null;
  window._pdfQueueRows = null;
  document.getElementById('pdfRightCol').style.display = '';
  const tabsBar = document.getElementById('queueTabsBar');
  if (tabsBar) tabsBar.remove();
  const dz = document.getElementById('dropZone');
  dz.removeAttribute('data-queue');
  dz.style.cursor = '';
  const dzIco = dz.querySelector('.dz-ico');
  const dzSub = dz.querySelector('.dz-sub');
  if (dzIco) dzIco.style.display = '';
  if (dzSub) dzSub.style.display = '';
  document.getElementById('dz-title').style.cssText = '';
  document.getElementById('extractedFieldsHdr').innerHTML = '';
  document.getElementById('extractedFieldsGrid').innerHTML = '';
  document.getElementById('pdfAIBox').textContent = 'Upload a PDF and select document type.';
  clearPDFOCR();
}

function cancelQueue() {
  window._pdfAbort = true;
  const q = window._pdfQueue;
  if (!q) return;
  q.status = 'cancelled';
  globalTaskDone();
  if (q.results.length > 0 && q.results.some((r) => r.bills.length > 0)) {
    renderQueueResults();
  } else {
    clearQueue();
  }
  showToast('Queue cancelled');
}

function _escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderQueueProgress() {
  const q = window._pdfQueue;
  if (!q) return;
  if (q._previewMode) return;
  const dz = document.getElementById('dropZone');
  const pct =
    q.files.length > 0
      ? Math.round(
          ((q.status === 'done' || q.status === 'cancelled' ? q.files.length : q.currentIdx) / q.files.length) * 100,
        )
      : 0;

  let html = '<div style="text-align:left;max-width:480px;margin:0 auto;width:100%">';

  // Running bill count
  let totalBillsFound = 0;
  q.results.forEach((r) => {
    if (r.status === 'ok') totalBillsFound += r.bills.length;
  });

  // Header
  html += '<div style="font-size:16px;font-weight:600;color:var(--em);margin-bottom:4px">';
  if (q.status === 'running') {
    html += 'Extracting ' + (q.currentIdx + 1) + ' of ' + q.files.length + ' files...';
  } else if (q.status === 'done' || q.status === 'cancelled') {
    html += 'Extraction complete — ' + q.results.length + ' files processed';
  } else {
    html += 'Preparing ' + q.files.length + ' files...';
  }
  html += '</div>';
  if (totalBillsFound > 0) {
    html +=
      '<div style="font-size:13px;color:var(--text);margin-bottom:14px">' +
      totalBillsFound +
      ' bill' +
      (totalBillsFound !== 1 ? 's' : '') +
      ' found so far — ' +
      '<button onclick="previewQueueResults()" style="background:none;border:none;' +
      'color:var(--em);cursor:pointer;font-size:13px;font-family:var(--font);' +
      'text-decoration:underline;padding:0">View</button>' +
      '</div>';
  } else {
    html += '<div style="margin-bottom:14px"></div>';
  }

  // Progress bar
  html += '<div style="background:var(--s1);border-radius:6px;height:8px;margin-bottom:20px;overflow:hidden">';
  html +=
    '<div style="background:var(--em);border-radius:6px;height:8px;width:' +
    pct +
    '%;transition:width 0.4s ease"></div>';
  html += '</div>';

  // File list — show ALL files (no truncation)
  q.files.forEach((f, i) => {
    const result = q.results.find((r) => r.fileIdx === i);
    if (result && result.status === 'ok') {
      const billCount = result.bills.length;
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#4aba4a">';
      html += '<span style="width:18px;text-align:center">✓</span>';
      html += '<span style="color:var(--text)">' + _escHtml(f.name) + '</span>';
      html +=
        '<span style="color:var(--text);font-size:11px"> — ' +
        billCount +
        ' bill' +
        (billCount !== 1 ? 's' : '') +
        '</span>';
      html += '</div>';
    } else if (result && result.status === 'failed') {
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#c44">';
      html += '<span style="width:18px;text-align:center">✕</span>';
      html += '<span>' + _escHtml(f.name) + '</span>';
      html +=
        '<span style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"> — ' +
        (result.error || 'failed') +
        '</span>';
      html += '</div>';
    } else if (i === q.currentIdx && q.status === 'running') {
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:var(--em)">';
      html +=
        '<span style="display:inline-block;width:14px;height:14px;border:2px solid var(--em);border-top-color:transparent;border-radius:50%;animation:qspin 1s linear infinite;flex-shrink:0"></span>';
      html += '<span>' + _escHtml(f.name) + '</span>';
      html += '<span style="font-size:11px;color:var(--text)"> — ' + (q._fileStatus || 'extracting...') + '</span>';
      html += '</div>';
    } else {
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:var(--text)">';
      html += '<span style="width:18px;text-align:center">○</span>';
      html += '<span>' + _escHtml(f.name) + '</span>';
      const pc = q._pageCounts && q._pageCounts[i];
      if (pc) html += '<span style="font-size:11px;color:var(--text)"> — ' + pc + ' pages</span>';
      html += '</div>';
    }
  });
  // (all files shown — no truncation)

  // Cancel button
  html += '<div style="margin-top:20px;text-align:center">';
  html +=
    '<button onclick="event.stopPropagation();if(confirm(\'Cancel the batch extraction?\')){cancelQueue()}" style="padding:10px 28px;font-size:14px;border-radius:8px;border:2px solid #c44;background:transparent;color:#c44;cursor:pointer;font-family:var(--font);font-weight:600">Cancel Extraction</button>';
  html += '</div>';

  html += '</div>';
  html += '<style>@keyframes qspin{to{transform:rotate(360deg)}}</style>';

  // Render into drop zone (hide default content)
  const dzIco = dz.querySelector('.dz-ico');
  const dzTitle = document.getElementById('dz-title');
  const dzSub = dz.querySelector('.dz-sub');
  if (dzIco) dzIco.style.display = 'none';
  if (dzSub) dzSub.style.display = 'none';
  dzTitle.innerHTML = html;
  dzTitle.style.cssText = 'margin:0;font-size:inherit;white-space:normal;overflow:visible;text-overflow:clip';
}

async function runExtractionQueue() {
  const q = window._pdfQueue;
  if (!q) return;
  q.status = 'running';
  window._pdfAbort = false;
  if (!q._pageCounts) q._pageCounts = {};
  globalTaskShow('📄 Batch extracting ' + q.files.length + ' files...', 'pdf');
  await _runExtractionFrom(0);
}

async function _runExtractionFrom(startIdx) {
  const q = window._pdfQueue;
  if (!q) return;

  // Pre-scan page counts for new files only
  for (let i = startIdx; i < q.files.length; i++) {
    if (q._pageCounts[i] != null) continue;
    try {
      const ab = await q.files[i].arrayBuffer();
      const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(ab),
        useWorkerFetch: false,
        isEvalSupported: false,
      }).promise;
      q._pageCounts[i] = pdf.numPages;
      pdf.destroy();
      renderQueueProgress();
    } catch (e) {
      q._pageCounts[i] = null;
    }
  }

  globalTaskUpdate('📄 Batch extracting ' + q.files.length + ' files...');

  for (let i = startIdx; i < q.files.length; i++) {
    if (window._pdfAbort) {
      q.status = 'cancelled';
      break;
    }
    q.currentIdx = i;
    q._fileStatus = null;
    // Pre-scan page count if not yet known (file was appended mid-run)
    if (q._pageCounts[i] == null) {
      try {
        const ab = await q.files[i].arrayBuffer();
        const pdf = await pdfjsLib.getDocument({
          data: new Uint8Array(ab),
          useWorkerFetch: false,
          isEvalSupported: false,
        }).promise;
        q._pageCounts[i] = pdf.numPages;
        pdf.destroy();
      } catch (e) {
        q._pageCounts[i] = null;
      }
    }
    renderQueueProgress();
    globalTaskUpdate('📄 Extracting ' + (i + 1) + '/' + q.files.length + ': ' + q.files[i].name);

    try {
      const result = await _extractSingleFileForQueue(q.files[i], i);
      q.results.push(result);
      try {
        window._pdfRawText = result.rawText;
        window._pdfSourceFileName = result.fileName;
        window._pdfMultiBills = result.bills;
        savePDFDebug();
      } catch (dbgErr) {
        console.warn('Debug file save failed for', result.fileName, dbgErr);
      }
    } catch (err) {
      q.results.push({
        fileIdx: i,
        fileName: q.files[i].name,
        bills: [],
        pdfB64: null,
        status: 'failed',
        error: err.message || 'Unknown error',
      });
    }
    renderQueueProgress();
    if (window._pdfQueue && window._pdfQueue._previewMode) renderQueueResults();
  }

  // If cancelQueue() already handled the UI, don't override it
  if (!window._pdfQueue || q.status === 'cancelled') {
    globalTaskDone();
    return;
  }
  q.status = 'done';
  q._previewMode = false;
  q.currentIdx = q.files.length;
  q._processedCount = q.files.length;
  const allBills = [];
  q.results.forEach((r) => {
    r.bills.forEach((b) => allBills.push(b));
  });
  if (allBills.length > 0) {
    await _checkDuplicates(allBills);
  }
  globalTaskDone();
  renderQueueProgress();
  setTimeout(() => {
    renderQueueResults();
    _saveExtractionState();
  }, 600);
}

async function _extractSingleFileForQueue(file, fileIdx) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = async (ev) => {
      try {
        const b64 = ev.target.result.split(',')[1];
        const freshBytes = () => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

        const statusCb = (msg) => {
          const q = window._pdfQueue;
          if (q) {
            q._fileStatus = msg;
            renderQueueProgress();
          }
        };
        let text = await extractPDFText(freshBytes(), statusCb);
        if (!text || text.trim().length <= 100) {
          // Retry once with fresh read
          text = await extractPDFText(freshBytes(), statusCb);
          if (!text || text.trim().length <= 100) {
            reject(new Error('No readable text found'));
            return;
          }
        }
        const _budgetHit = window._pdfOcrBudgetExceeded;
        window._pdfOcrBudgetExceeded = null; // consume once

        // Check specific local utilities first — their bills often appear in
        // multi-utility PDFs alongside Evergy, and Evergy's broader detection
        // would otherwise claim the entire file.
        let rule = UTILITY_RULES.find((r) => r.name && /Louisburg/i.test(r.name) && r.detect(text));
        if (!rule) rule = UTILITY_RULES.find((r) => r.detect(text));
        if (!rule) {
          reject(new Error('Unrecognized utility format'));
          return;
        }

        let bills = rule.extractAll ? rule.extractAll(text) : [rule.extract(text)];
        const _queueUnmatchedPages = bills._unmatchedPages || [];
        // Bug b5951068: Instead of silently dropping bills that fail the key-field
        // filter, flag them with parseError:true so the user sees every billing
        // period from the PDF — even ones the parser couldn't understand.
        const _hasKeyField = (b) =>
          b.BillingPeriodStart ||
          b.kWhConsumed ||
          b.NaturalGasTherms ||
          b.NaturalGasCCF ||
          b.WaterUsage ||
          b.GasCharge ||
          b.TotalCurrentCharges;
        let validBills = bills.filter((b) => _hasKeyField(b));
        const _droppedBills = bills.filter((b) => !_hasKeyField(b) && !b._manualReview);
        _droppedBills.forEach((b) => {
          b.parseError = true;
          b._manualReview = true;
          const _pg = b._pageStart != null ? b._pageStart : b._pageIndex != null ? b._pageIndex : null;
          const _pageLabel = _pg != null ? 'p.' + _pg : '?';
          b._manualReviewLabel = 'Parse error — billing period unreadable (' + _pageLabel + ')';
          b.UtilityCompany = b.UtilityCompany || (rule && rule.name) || 'Unknown';
        });

        let finalBills = validBills.length > 0 ? validBills.concat(_droppedBills) : bills;

        // ── Inject unmatched pages as "Manual Review" entries ──
        // If some pages couldn't be parsed, surface them so the user can see
        // them instead of silently dropping them. If ALL pages were unmatched
        // (no valid bills at all), the synthetics become the result so the
        // queue shows "Manual Review" rows instead of a generic FAILED row.
        const _queueSynthetics = _unmatchedToSyntheticBills(_queueUnmatchedPages);
        if (_queueSynthetics.length) {
          finalBills = finalBills.concat(_queueSynthetics);
        }

        if (
          finalBills.length === 0 ||
          (!finalBills[0].BillingPeriodStart && !finalBills[0].TotalCurrentCharges && !finalBills[0]._manualReview)
        ) {
          reject(new Error('No bills found'));
          return;
        }

        // Convert _pageIndex to _pageStart/_pageEnd for extractors that
        // set per-page indices (Louisburg) instead of page ranges (Evergy)
        finalBills.forEach((b) => {
          if (b._pageIndex && !b._pageStart) {
            b._pageStart = b._pageIndex;
            b._pageEnd = b._pageIndex;
          }
        });

        // ── POST-EXTRACTION VERIFICATION ──
        // Brings queue path to parity with single-file path (processPDF ~line 9226).
        // Runs Strategy B (rate×qty OCR correction) and Strategy C (subtraction
        // inference) before analysis so that _warnings reflect corrected values,
        // not raw OCR-inflated charges. Fix for batch "Sum Mismatch" false positives.
        try {
          const _qPevResult = await _postExtractionVerify(finalBills, rule.name, text);
          finalBills = _qPevResult.bills;
        } catch (pev_err) {
          console.warn('[queue] _postExtractionVerify failed, continuing without verification:', pev_err);
        }

        // ── OCR budget-exceeded: loud failure, not a silent spinner (subtask 4) ──
        // Only flag bills that STILL fail the key-field check after everything else
        // has run — a bill that already recovered before the budget tripped should
        // not be punished with a label it doesn't need.
        if (_budgetHit) {
          finalBills.forEach((b) => {
            if (!_hasKeyField(b) && !b._manualReview) {
              b._manualReview = true;
              b._manualReviewLabel =
                'Could not fully extract — OCR budget exceeded (' +
                _budgetHit.pagesRead +
                ' of ' +
                _budgetHit.pagesTotal +
                ' pages read); manual entry required';
            }
          });
        }

        // Run analysis for warnings (stored on each bill as _warnings)
        const analysisResults = await analyzeBillExtraction(finalBills, rule.name, undefined, statusCb);
        finalBills.forEach((b, bi) => {
          b._warnings = analysisResults[bi]?.warnings || [];
          b._sourceFile = file.name;
          b._queueFileIdx = fileIdx;
        });

        resolve({
          fileIdx: fileIdx,
          fileName: file.name,
          bills: finalBills,
          pdfB64: b64,
          rawText: text,
          status: 'ok',
          error: null,
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsDataURL(file);
  });
}

// ── Queue grouping state (Plan 7e0b9d15 §1) ──
// null = auto-detect on next render; true = grouped; false = flat
let _queueGroupState = null;

// _groupQueueRows(rows) — mirrors _groupSavedBills key-normalization (core.js:2910)
// but works on queue row objects {resultIdx, billIdx, bill, result, checked, _saved}
// Returns Map<groupKey, groupEntry>
function _groupQueueRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.bill) {
      // Failed rows go to a synthetic _failed bucket — not part of period matrix
      if (!groups.has('_failed')) {
        groups.set('_failed', {
          key: '_failed',
          displayLabel: 'Failed',
          commodity: '',
          provider: '',
          rows: [],
          hasMultiple: false,
          _isFailed: true,
        });
      }
      groups.get('_failed').rows.push(row);
      continue;
    }
    const b = row.bill;
    const acctRaw = b.AccountNumber || b.accountNumber || '';
    const meterRaw = b.MeterNumber || b.meterNumber || '';
    const acctClean = acctRaw.replace(/[\s\-]/g, '').toLowerCase();
    const meterClean = meterRaw.replace(/[\s\-]/g, '').toLowerCase();
    const key = acctClean ? acctClean : meterClean ? 'meter:' + meterClean : '_unknown';

    if (!groups.has(key)) {
      const displayLabel = acctRaw || meterRaw || 'Unknown Account';
      // Detect mixed commodity within the group later
      groups.set(key, {
        key,
        displayLabel,
        commodity: b.Commodity || b.commodity || '',
        provider: b.UtilityCompany || b.utilityCompany || '',
        rows: [],
        hasMultiple: false,
        _isFailed: false,
        // track distinct source files to determine hasMultiple
        _sourceFiles: new Set(),
      });
    }
    const grp = groups.get(key);
    grp.rows.push(row);
    if (row.result && row.result.fileName) grp._sourceFiles.add(row.result.fileName);
  }

  // Post-process each group
  for (const grp of groups.values()) {
    if (grp._isFailed) continue;
    // hasMultiple = more than one distinct source file contributed to this group
    grp.hasMultiple = grp._sourceFiles ? grp._sourceFiles.size > 1 : false;

    // Sort rows by BillingPeriodStart ascending (oldest → newest)
    grp.rows.sort((a, b) => {
      const av = (a.bill && (a.bill.BillingPeriodStart || a.bill.DeliveryDate)) || '';
      const bv = (b.bill && (b.bill.BillingPeriodStart || b.bill.DeliveryDate)) || '';
      return av < bv ? -1 : av > bv ? 1 : 0;
    });

    // Detect mixed commodity
    const commodities = new Set(
      grp.rows.map((r) => (r.bill && (r.bill.Commodity || r.bill.commodity)) || '').filter(Boolean),
    );
    if (commodities.size > 1) grp.commodity = '(Mixed)';
  }

  return groups;
}

function previewQueueResults() {
  const q = window._pdfQueue;
  if (!q) return;
  q._previewMode = true;
  renderQueueResults();
}

function exitPreviewMode() {
  const q = window._pdfQueue;
  if (!q) return;
  q._previewMode = false;
  const dz = document.getElementById('dropZone');
  if (dz) dz.classList.remove('collapsed');
  const rightCol = document.getElementById('pdfRightCol');
  if (rightCol) rightCol.style.display = 'none';
  renderQueueProgress();
}

function renderQueueResults() {
  const q = window._pdfQueue;
  if (!q) return;
  const dz = document.getElementById('dropZone');
  const dzTitle = document.getElementById('dz-title');
  const box = document.getElementById('pdfAIBox');

  // Show normal two-column layout
  dz.classList.add('collapsed');
  dz.querySelector('.dz-ico').style.display = 'none';
  dz.querySelector('.dz-sub').style.display = 'none';
  dzTitle.style.cssText = '';
  document.getElementById('pdfRightCol').style.display = '';
  document.getElementById('pdfTypeSection').style.display = 'none';
  document.getElementById('pdfSaveRow').style.display = 'none';
  // Show debug buttons
  const dbgBtn = document.getElementById('pdfDebugBtn');
  if (dbgBtn) dbgBtn.style.display = '';
  const saveDbgBtn = document.getElementById('pdfSaveDebugBtn');
  if (saveDbgBtn) saveDbgBtn.style.display = '';

  if (q._activeFileIdx == null) q._activeFileIdx = 0;

  // Build rows for save tracking
  const oldRows = window._pdfQueueRows || [];
  const rows = [];
  q.results.forEach((r, ri) => {
    if (r.status === 'ok' && r.bills.length > 0) {
      r.bills.forEach((b, bi) => {
        rows.push({ resultIdx: ri, billIdx: bi, bill: b, result: r, checked: true });
      });
    } else if (r.status === 'failed') {
      rows.push({ resultIdx: ri, billIdx: -1, bill: null, result: r, checked: false });
    }
  });
  rows.forEach((row) => {
    const old = oldRows.find((o) => o.resultIdx === row.resultIdx && o.billIdx === row.billIdx);
    if (old) {
      row.checked = old.checked;
      row._saved = old._saved || false;
    }
  });

  // Fix b-46a984a0 (batch-to-meter Destination review): precompute the meter match for
  // every row up front, mirroring _mbRowTargets in showMultiBuildingReviewPanel (the
  // multi-account-in-one-file case). Lets the Destination column show/require a
  // confirm-or-pick step BEFORE save instead of only reporting the result afterward.
  // Recomputed on every render (cheap) rather than cached on the bill so it always
  // reflects the live project/building/meter data.
  rows.forEach((row) => {
    row._autoMatch = row.bill ? findMeterMatch(row.bill) || null : null;
  });

  if (rows.length === 0) {
    dzTitle.innerHTML = '📄 Batch extraction — no bills found';
    document.getElementById('pdfRightCol').style.display = '';
    document.getElementById('extractedFieldsGrid').innerHTML =
      '<div style="text-align:center;padding:40px 20px;color:var(--text)">' +
      '<div style="font-size:16px;margin-bottom:8px">No bills extracted</div>' +
      '<div style="font-size:13px;margin-bottom:16px">None of the ' +
      q.files.length +
      ' files produced extractable bills.</div>' +
      '<button class="btn btn-ghost" onclick="clearQueue()">Clear & Try Again</button></div>';
    return;
  }
  window._pdfQueueRows = rows;

  // ── Grouping detection (Plan 7e0b9d15 §1) ──
  const groupMap = _groupQueueRows(rows);
  const hasSharedAccount = [...groupMap.values()].some((g) => !g._isFailed && g.hasMultiple);
  if (_queueGroupState === null) _queueGroupState = hasSharedAccount;
  const useGrouped = _queueGroupState;

  // Stats
  const okCount = rows.filter((r) => r.bill && !_getQueueDupInfo(r)).length;
  const dupCount = rows.filter((r) => r.bill && _getQueueDupInfo(r)).length;
  const failCount = rows.filter((r) => !r.bill).length;
  const totalBills = rows.filter((r) => r.bill).length;
  const savedCount = rows.filter((r) => r._saved).length;
  const saveable = rows.filter((r) => r.bill && !r._saved).length;

  // Banner
  dzTitle.innerHTML =
    '📄 Batch results — ' +
    q.files.length +
    ' files → ' +
    totalBills +
    ' bills' +
    ' <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:10px" onclick="event.stopPropagation();document.getElementById(\'pdfInput\').click()">+ Add Files</button>' +
    ' <button class="btn btn-ghost btn-sm" style="margin-left:4px;font-size:10px" onclick="event.stopPropagation();clearQueue()">✕ Clear All</button>';

  // Create or get tabs container (above extractedFieldsHdr)
  let tabsBar = document.getElementById('queueTabsBar');
  if (!tabsBar) {
    tabsBar = document.createElement('div');
    tabsBar.id = 'queueTabsBar';
    tabsBar.style.cssText = 'background:var(--bg);padding-bottom:4px';
    const hdr = document.getElementById('extractedFieldsHdr');
    hdr.parentNode.insertBefore(tabsBar, hdr);
  }

  // ── File tabs / group pills (Plan 7e0b9d15 §3) ──
  let html = '';
  if (q.status === 'running') {
    html +=
      '<div style="font-size:12px;color:var(--text2);padding:4px 0 8px;border-bottom:1px solid var(--border);margin-bottom:8px">' +
      'Extraction in progress (' +
      q.results.length +
      ' of ' +
      q.files.length +
      ' files done). ' +
      'Results update as files complete. ' +
      '<button onclick="exitPreviewMode()" style="background:none;border:none;color:var(--em);' +
      'cursor:pointer;font-family:var(--font);font-size:12px;text-decoration:underline;padding:0">' +
      '← Back to progress</button></div>';
  }
  html += '<div style="display:flex;gap:4px;margin:10px 0 8px;flex-wrap:wrap">';
  if (useGrouped) {
    // Per-group pills: "AccountNumber · N periods"
    for (const grp of groupMap.values()) {
      if (grp._isFailed) continue;
      const isActive = q._activeGroupKey === grp.key;
      const bg = isActive ? 'var(--em)' : 'var(--s2)';
      const color = isActive ? '#fff' : 'var(--text)';
      const border = isActive ? 'var(--em)' : 'var(--border2)';
      const periodCount = grp.rows.length;
      const lbl = _escHtml(grp.displayLabel) + ' \xb7 ' + periodCount + ' period' + (periodCount !== 1 ? 's' : '');
      html +=
        '<button onclick="selectQueueGroup(\'' +
        grp.key.replace(/'/g, "\\'") +
        '\')" style="padding:6px 14px;border-radius:6px;border:1px solid ' +
        border +
        ';background:' +
        bg +
        ';color:' +
        color +
        ';cursor:pointer;font-size:12px;font-family:var(--font)">' +
        lbl +
        '</button>';
    }
    // Failed-files pill if any
    const failedGrp = groupMap.get('_failed');
    if (failedGrp && failedGrp.rows.length > 0) {
      failedGrp.rows.forEach((row) => {
        const i = row.resultIdx;
        const r = q.results[i];
        const isActive = i === q._activeFileIdx && !q._activeGroupKey;
        const bg = isActive ? 'var(--em)' : 'var(--s2)';
        const color = isActive ? '#fff' : '#c44';
        const border = isActive ? 'var(--em)' : 'var(--border2)';
        html +=
          '<button onclick="selectQueueFile(' +
          i +
          ')" style="padding:6px 14px;border-radius:6px;border:1px solid ' +
          border +
          ';background:' +
          bg +
          ';color:' +
          color +
          ';cursor:pointer;font-size:12px;font-family:var(--font)">' +
          _escHtml(r ? r.fileName : 'Unknown') +
          ' ✕</button>';
      });
    }
  } else {
    // Flat per-file pills (unchanged behavior)
    q.results.forEach((r, i) => {
      const isActive = i === q._activeFileIdx;
      const bg = isActive ? 'var(--em)' : 'var(--s2)';
      const color = isActive ? '#fff' : 'var(--text)';
      const border = isActive ? 'var(--em)' : 'var(--border2)';
      const ct = r.status === 'ok' ? r.bills.length : 0;
      const lbl = _escHtml(r.fileName) + (r.status === 'failed' ? ' ✕' : ' (' + ct + ')');
      html +=
        '<button onclick="selectQueueFile(' +
        i +
        ')" style="padding:6px 14px;border-radius:6px;border:1px solid ' +
        border +
        ';background:' +
        bg +
        ';color:' +
        color +
        ';cursor:pointer;font-size:12px;font-family:var(--font)">' +
        lbl +
        '</button>';
    });
  }
  html += '</div>';

  // Action bar
  html +=
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0 4px;border-bottom:1px solid var(--border);margin-bottom:4px;flex-wrap:wrap;gap:6px">';
  html += '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text)">';
  if (okCount > 0) html += '<span style="color:#4a4">' + okCount + ' ready</span>';
  if (dupCount > 0) html += (okCount > 0 ? ' \xb7 ' : '') + '<span style="color:var(--em)">' + dupCount + ' dup</span>';
  if (failCount > 0)
    html += (okCount + dupCount > 0 ? ' \xb7 ' : '') + '<span style="color:#c44">' + failCount + ' failed</span>';
  if (savedCount > 0) html += ' \xb7 <span style="color:var(--text3)">' + savedCount + ' saved</span>';
  // Toggle button (Plan 7e0b9d15 §3) — shown only when shared accounts detected
  if (hasSharedAccount) {
    html +=
      '<button class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px" ' +
      'onclick="_queueGroupState=!' +
      useGrouped +
      ';if(!_queueGroupState&&window._pdfQueue)window._pdfQueue._activeGroupKey=null;renderQueueResults()" ' +
      'title="' +
      (useGrouped ? 'Switch to flat per-file view' : 'Switch to consolidated grouped view') +
      '">' +
      (useGrouped ? '▦ Flat' : '▦ Grouped') +
      '</button>';
  }
  html += '</div>';
  html += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
  if (dupCount > 0) {
    // #119: Two clearly-labelled save options for duplicates
    html +=
      '<button class="btn btn-ghost btn-sm" onclick="resolveAllQueueDups(\'overwrite\')" style="font-size:10px" title="Save All (Overwrite): Replaces everything on the existing record including blank fields">Save All (Overwrite)</button>';
    html +=
      '<button class="btn btn-ghost btn-sm" onclick="resolveAllQueueDups(\'merge\')" style="font-size:10px" title="Save Only Non-Empty Fields (Merge): Fills empty fields only — keeps existing non-empty values intact. $0.00 counts as a real value.">Save Non-Empty (Merge)</button>';
    html +=
      '<button class="btn btn-ghost btn-sm" onclick="resolveAllQueueDups(\'skip\')" style="font-size:10px">Skip All Dups</button>';
  }
  html +=
    '<button class="btn btn-em btn-sm" onclick="saveQueuedBills()" style="font-size:11px"' +
    (saveable === 0 ? ' disabled' : '') +
    '>Save All (' +
    saveable +
    ')</button>';
  html += '</div></div>';

  // ── Per-bill queue rows table (Update 122/#35 + #36) ──
  // Compact table below the action bar: one row per bill across all files.
  // Columns: checkbox, file name, period, status badge, project dropdown (per-bill override),
  // and a Resolve button for duplicate bills that opens the dup comparison modal.
  // Build project options for per-bill dropdowns. Each call to _queueProjOpts(override)
  // returns option tags with the correct value selected.
  const _queueProjOpts = (overrideId) => {
    const cur = overrideId ? String(overrideId) : '';
    return (
      '<option value=""' +
      (cur === '' ? ' selected' : '') +
      '>— Batch proj —</option>' +
      (projects || [])
        .map(
          (p) =>
            '<option value="' +
            p.id +
            '"' +
            (String(p.id) === cur ? ' selected' : '') +
            '>' +
            _escHtml(p.name) +
            '</option>',
        )
        .join('')
    );
  };

  // ── Shared status-badge builder (reused by both flat + grouped table) ──
  const _buildStatusBadge = (row) => {
    const dup = row.bill ? _getQueueDupInfo(row) : null;
    if (!row.bill) {
      return '<span style="color:#c44;font-weight:600;font-size:10px">FAILED</span>';
    } else if (row.bill.parseError) {
      return (
        '<span style="color:#e55;font-weight:600;font-size:10px" title="' +
        _escHtml(row.bill._manualReviewLabel || 'Billing period could not be parsed — assign manually') +
        '">PARSE ERR</span>'
      );
    } else if (row.bill._manualReview) {
      return '<span style="color:#c88;font-weight:600;font-size:10px" title="Could not parse billing period — assign manually">REVIEW</span>';
    } else if (row._saved) {
      return '<span style="color:var(--text3);font-size:10px">SAVED</span>';
    } else if (dup) {
      const dupAct = dup.action;
      const actLabel =
        dupAct === 'overwrite' ? ' \xb7 OW' : dupAct === 'merge' ? ' \xb7 MG' : dupAct === 'skip' ? ' \xb7 SK' : '';
      const dupLocLabel = dup.locationType === 'saved' ? ' (Saved)' : ' (Meter)';
      const dupTitle =
        dup.locationType === 'saved'
          ? 'Duplicate found in Saved Bills — not yet on any meter'
          : 'Duplicate found in meter bill data: ' + (dup.location || '');
      return (
        '<span style="color:var(--amber);font-weight:700;font-size:10px" title="' +
        _escHtml(dupTitle) +
        '">DUP' +
        _escHtml(dupLocLabel + actLabel) +
        '</span>'
      );
    }
    return '<span style="color:#4a4;font-size:10px">READY</span>';
  };

  // ── Destination cell builder (fix b-46a984a0 — batch-to-meter review) ──
  // GATE: zero silent auto-routes. An 'identity' match (account/meter-number hit) is
  // shown as confirmed text the user can still override via "Change". Anything else —
  // 'address'-only fuzzy match or no match at all — always renders the cascading
  // Project→Building→Meter picker and forces an explicit user pick (never pre-selects
  // a building/meter from a weak address guess). handlerArg must already be a valid
  // JS literal for the onclick/onchange call (numeric rowIdx unquoted, group key quoted).
  const _buildDestCell = (bill, autoMatch, handlerArg, setProjFn, setBldgFn, setMeterFn, setExpandFn) => {
    const ov = bill._meterOverride || null;
    const isIdentity = !!(autoMatch && autoMatch.matchType === 'identity');
    const expanded = !!bill._destExpanded || !isIdentity;
    if (isIdentity && !expanded) {
      const destText =
        autoMatch.proj.name +
        ' → ' +
        autoMatch.bldg.name +
        ' → ' +
        (autoMatch.meter.provider || autoMatch.meter.meter || 'meter');
      return (
        '<div style="font-size:10px;color:var(--text)" title="Identity match — account/meter number found">' +
        _escHtml(destText) +
        ' <a href="javascript:void(0)" onclick="' +
        setExpandFn +
        '(' +
        handlerArg +
        ',true)" style="font-size:9px;color:var(--em);text-decoration:underline">Change</a></div>'
      );
    }
    // Cascading picker. For an identity match under "Change", pre-fill with the
    // match's own proj/bldg/meter (an editable confirm, like the single-file banner's
    // override toggle). For an address-only or absent match, leave building/meter BLANK
    // even though we know a guess — the user must actively confirm it (this is the
    // trust-violation guard: a wrong silent attach is worse than no attach).
    const curProj =
      ov && ov.projId != null
        ? ov.projId
        : isIdentity && autoMatch
          ? autoMatch.projId
          : bill._projOverride || (window._pdfQueue && window._pdfQueue.batchProjId) || '';
    const curBldg = ov && ov.bldgId ? ov.bldgId : isIdentity && autoMatch && !ov ? autoMatch.bldgId : '';
    const curMeter = ov && ov.meterId ? ov.meterId : isIdentity && autoMatch && !ov ? autoMatch.meterId : '';
    const selStyle =
      'font-size:10px;padding:1px 2px;max-width:112px;background:var(--s2);border:1px solid var(--border2);' +
      'border-radius:3px;color:var(--text);margin-bottom:1px;display:block';
    const projOpts =
      '<option value="">Select project…</option>' +
      (projects || [])
        .map(
          (p) =>
            '<option value="' +
            p.id +
            '"' +
            (String(p.id) === String(curProj) ? ' selected' : '') +
            '>' +
            _escHtml(p.name) +
            '</option>',
        )
        .join('');
    const bldgOpts =
      '<option value="">Select building…</option>' +
      (curProj ? getUDBldgs(parseInt(curProj)) || [] : [])
        .map(
          (b2) =>
            '<option value="' +
            b2.id +
            '"' +
            (String(b2.id) === String(curBldg) ? ' selected' : '') +
            '>' +
            _escHtml(b2.name || b2.id) +
            '</option>',
        )
        .join('');
    const bldgObj = curProj && curBldg ? getUDBldg(parseInt(curProj), curBldg) : null;
    const meterOpts =
      '<option value="">Select meter…</option>' +
      ((bldgObj && bldgObj.meters) || [])
        .map((m) => {
          const lbl =
            (m.commodity || 'Meter') + (m.account ? ' (' + m.account + ')' : m.meter ? ' (' + m.meter + ')' : '');
          return (
            '<option value="' +
            m.id +
            '"' +
            (String(m.id) === String(curMeter) ? ' selected' : '') +
            '>' +
            _escHtml(lbl) +
            '</option>'
          );
        })
        .join('');
    const hint =
      autoMatch && autoMatch.matchType === 'address'
        ? '<div style="font-size:9px;color:var(--amber);margin-bottom:2px" title="Address similarity only — not confirmed by account/meter number">Address match (unconfirmed): ' +
          _escHtml(autoMatch.proj.name + ' → ' + autoMatch.bldg.name) +
          '</div>'
        : !autoMatch
          ? '<div style="font-size:9px;color:#c44;margin-bottom:2px">No match — pick destination</div>'
          : '';
    const changeLink = isIdentity
      ? '<a href="javascript:void(0)" onclick="' +
        setExpandFn +
        '(' +
        handlerArg +
        ',false)" style="font-size:9px;color:var(--text3);text-decoration:underline">Cancel</a>'
      : '';
    return (
      hint +
      '<select style="' +
      selStyle +
      '" onchange="' +
      setProjFn +
      '(' +
      handlerArg +
      ',this.value)">' +
      projOpts +
      '</select>' +
      '<select style="' +
      selStyle +
      '" onchange="' +
      setBldgFn +
      '(' +
      handlerArg +
      ',this.value)">' +
      bldgOpts +
      '</select>' +
      '<select style="' +
      selStyle +
      '" onchange="' +
      setMeterFn +
      '(' +
      handlerArg +
      ',this.value)">' +
      meterOpts +
      '</select>' +
      changeLink
    );
  };

  let billRowsHtml = '';

  if (useGrouped) {
    // ── Grouped period-matrix table (Plan 7e0b9d15 §2) ──
    // Build the union set of all period keys (sorted chronologically) as column headers
    const allPeriodKeys = []; // array of {sortKey, label} objects
    const periodKeySet = new Map(); // sortKey → label
    for (const grp of groupMap.values()) {
      if (grp._isFailed) continue;
      for (const row of grp.rows) {
        if (!row.bill) continue;
        const b = row.bill;
        const sortKey = b.BillingPeriodStart || b.DeliveryDate || '';
        if (sortKey && !periodKeySet.has(sortKey)) {
          const isDelivery = !b.BillingPeriodStart && b.DeliveryDate;
          const label = isDelivery
            ? 'Del: ' + _fmtShortDate(b.DeliveryDate)
            : _fmtShortDate(b.BillingPeriodStart) + '–' + _fmtShortDate(b.BillingPeriodEnd);
          periodKeySet.set(sortKey, label);
        }
      }
    }
    // Sort period columns chronologically (oldest L → newest R)
    const sortedPeriodKeys = Array.from(periodKeySet.keys()).sort();

    // Build header
    billRowsHtml += '<div style="overflow-x:auto;margin-top:4px">';
    billRowsHtml += '<table style="border-collapse:collapse;font-size:11px;font-family:var(--font);min-width:100%">';
    billRowsHtml +=
      '<thead><tr style="background:var(--s1)">' +
      '<th style="padding:4px 8px;text-align:left;border:1px solid var(--border);white-space:nowrap;color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Account / Meter</th>' +
      '<th style="padding:4px 8px;text-align:left;border:1px solid var(--border);white-space:nowrap;color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Destination</th>';
    sortedPeriodKeys.forEach((pk) => {
      billRowsHtml +=
        '<th style="padding:4px 8px;text-align:center;border:1px solid var(--border);white-space:nowrap;color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">' +
        _escHtml(periodKeySet.get(pk)) +
        '</th>';
    });
    billRowsHtml += '</tr></thead><tbody>';

    // One row per account/meter group
    for (const grp of groupMap.values()) {
      if (grp._isFailed) continue;

      // Map this group's rows by period sortKey → array (collision guard for duplicate uploads)
      const rowByPeriod = new Map();
      grp.rows.forEach((row) => {
        if (!row.bill) return;
        const b = row.bill;
        const sk = b.BillingPeriodStart || b.DeliveryDate || '';
        if (!sk) return;
        if (!rowByPeriod.has(sk)) rowByPeriod.set(sk, []);
        rowByPeriod.get(sk).push(row);
      });

      // Commodity badge color
      const commodityBadge = grp.commodity
        ? ' <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--s3);color:var(--text2)">' +
          _escHtml(grp.commodity) +
          '</span>'
        : '';

      // Destination control is shown ONCE per group (not once per bill row) — applies
      // the chosen meter to every row sharing this account/meter key. Pick the match/bill
      // representative from the first row that still has an unsaved bill (falls back to
      // the group's first row if all are saved) so already-saved bills don't hide the
      // control for the rest of the group.
      const grpRepRow = grp.rows.find((r) => r.bill && !r._saved) || grp.rows.find((r) => r.bill);
      const grpDestHtml = grpRepRow
        ? _buildDestCell(
            grpRepRow.bill,
            grpRepRow._autoMatch,
            "'" + grp.key.replace(/'/g, "\\'") + "'",
            'setQueueGroupDestProj',
            'setQueueGroupDestBldg',
            'setQueueGroupDestMeter',
            'setQueueGroupDestExpand',
          )
        : '<span style="color:var(--text3);font-size:10px">—</span>';

      billRowsHtml +=
        '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:4px 8px;border:1px solid var(--border);white-space:nowrap;color:var(--text);font-weight:600">' +
        _escHtml(grp.displayLabel) +
        commodityBadge +
        '</td>' +
        '<td style="padding:4px 8px;border:1px solid var(--border);min-width:120px;vertical-align:top">' +
        grpDestHtml +
        '</td>';

      sortedPeriodKeys.forEach((pk) => {
        const periodRows = rowByPeriod.get(pk);
        if (!periodRows || periodRows.length === 0) {
          billRowsHtml +=
            '<td style="padding:4px 8px;border:1px solid var(--border);text-align:center;color:var(--text3)">—</td>';
          return;
        }

        // Single-row case: render exactly as before (no visual change)
        // Multi-row case: stack one entry per row so every duplicate gets its own visible checkbox
        const cellParts = periodRows.map((row) => {
          const b = row.bill;
          const rowIdx = rows.indexOf(row);
          const isChecked = !row._saved ? (row.checked !== false ? ' checked' : '') : '';
          const canCheck = !row._saved;
          const fileName = row.result ? row.result.fileName : '';
          const charge =
            b.TotalCurrentCharges != null && b.TotalCurrentCharges !== ''
              ? '$' +
                Number(b.TotalCurrentCharges).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : '—';
          const statusBadge = _buildStatusBadge(row);
          const isDelivery = !b.BillingPeriodStart && b.DeliveryDate;
          const periodLabel = isDelivery
            ? 'Delivery: ' + _escHtml(b.DeliveryDate)
            : _escHtml((b.BillingPeriodStart || '?') + ' – ' + (b.BillingPeriodEnd || '?'));

          // For duplicate rows (periodRows.length > 1) show the source file so user can tell them apart
          const fileTag =
            periodRows.length > 1 && fileName
              ? '<div style="font-size:9px;color:var(--text3);margin-bottom:1px;word-break:break-all" title="' +
                _escHtml(fileName) +
                '">' +
                _escHtml(fileName.length > 24 ? fileName.slice(0, 22) + '…' : fileName) +
                '</div>'
              : '';

          return (
            '<div style="' +
            (periodRows.length > 1 ? 'border-top:1px dashed var(--border);padding-top:3px;margin-top:3px;' : '') +
            '">' +
            (periodRows.indexOf(row) === 0
              ? '<div style="font-size:10px;color:var(--text2);margin-bottom:2px">' + periodLabel + '</div>'
              : '') +
            fileTag +
            '<div style="font-size:11px;color:var(--text);font-weight:600;margin-bottom:2px">' +
            charge +
            '</div>' +
            '<div style="margin-bottom:2px">' +
            statusBadge +
            '</div>' +
            (canCheck && rowIdx >= 0
              ? '<input type="checkbox" onchange="toggleQueueRow(' +
                rowIdx +
                ',this.checked)"' +
                isChecked +
                ' title="Include in save batch">'
              : '') +
            '</div>'
          );
        });

        const firstRow = periodRows[0];
        const firstFileName = firstRow.result ? firstRow.result.fileName : '';
        billRowsHtml +=
          '<td style="padding:4px 8px;border:1px solid var(--border);text-align:center;vertical-align:top;min-width:110px" title="' +
          _escHtml(firstFileName) +
          '">' +
          cellParts.join('') +
          '</td>';
      });

      billRowsHtml += '</tr>';
    }

    billRowsHtml += '</tbody></table></div>';

    // Failed files notice (Plan 7e0b9d15 §2)
    const failedGrpData = groupMap.get('_failed');
    if (failedGrpData && failedGrpData.rows.length > 0) {
      billRowsHtml +=
        '<div style="font-size:11px;color:#c44;padding:6px 4px;margin-top:4px">' +
        failedGrpData.rows.length +
        ' file(s) failed — see failed file tab(s) above for retry.</div>';
    }
  } else {
    // ── Flat per-file table (unchanged behavior) ──
    billRowsHtml = '<div style="overflow-x:auto;margin-top:4px">';
    billRowsHtml += '<table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font)">';
    billRowsHtml +=
      '<thead><tr style="color:var(--text2);border-bottom:1px solid var(--border)">' +
      '<th style="padding:3px 5px;text-align:center;width:22px">' +
      '<input type="checkbox" onchange="toggleAllQueueRows(this.checked)" checked></th>' +
      '<th style="padding:3px 6px;text-align:left">File</th>' +
      '<th style="padding:3px 6px;text-align:left">Period</th>' +
      '<th style="padding:3px 6px;text-align:left">Status</th>' +
      '<th style="padding:3px 6px;text-align:left">Destination</th>' +
      '<th style="padding:3px 6px;text-align:left"></th>' +
      '</tr></thead><tbody>';

    rows.forEach((row, rowIdx) => {
      // Compute flat index into _pdfDupMap for this row
      let flatIdx = 0;
      for (let ri = 0; ri < q.results.length; ri++) {
        if (ri === row.resultIdx) {
          flatIdx += row.billIdx >= 0 ? row.billIdx : 0;
          break;
        }
        flatIdx += q.results[ri].bills.length;
      }

      const dup = row.bill ? _getQueueDupInfo(row) : null;
      const bgColor = row._saved ? 'rgba(100,180,100,.08)' : dup ? 'rgba(245,158,11,.07)' : 'transparent';

      // Status badge
      let statusHtml;
      if (!row.bill) {
        statusHtml = '<span style="color:#c44;font-weight:600;font-size:10px">FAILED</span>';
      } else if (row.bill.parseError) {
        statusHtml =
          '<span style="color:#e55;font-weight:600;font-size:10px" title="' +
          _escHtml(row.bill._manualReviewLabel || 'Billing period could not be parsed — assign manually') +
          '">PARSE ERR</span>';
      } else if (row.bill._manualReview) {
        statusHtml =
          '<span style="color:#c88;font-weight:600;font-size:10px" title="Could not parse billing period — assign manually">REVIEW</span>';
      } else if (row._saved) {
        statusHtml = '<span style="color:var(--text3);font-size:10px">SAVED</span>';
      } else if (dup) {
        const dupAct = dup.action;
        const actLabel =
          dupAct === 'overwrite' ? ' \xb7 OW' : dupAct === 'merge' ? ' \xb7 MG' : dupAct === 'skip' ? ' \xb7 SK' : '';
        // Bug 60431cd3: distinguish Saved Bills dup from meter bill dup so user
        // understands that an empty meter can still show DUP (matching Saved Bills).
        const dupLocLabel = dup.locationType === 'saved' ? ' (Saved)' : ' (Meter)';
        const dupTitle =
          dup.locationType === 'saved'
            ? 'Duplicate found in Saved Bills — not yet on any meter'
            : 'Duplicate found in meter bill data: ' + (dup.location || '');
        statusHtml =
          '<span style="color:var(--amber);font-weight:700;font-size:10px" title="' +
          _escHtml(dupTitle) +
          '">DUP' +
          _escHtml(dupLocLabel + actLabel) +
          '</span>';
      } else {
        statusHtml = '<span style="color:#4a4;font-size:10px">READY</span>';
      }

      // Period label
      let periodHtml = '—';
      if (row.bill) {
        const b = row.bill;
        if (b._manualReview) {
          periodHtml =
            '<span style="color:#c88;font-style:italic">' +
            _escHtml(b._manualReviewLabel || 'Manual Review') +
            '</span>';
        } else if (b.DeliveryDate) {
          periodHtml = _escHtml(b.DeliveryDate);
        } else if (b.BillingPeriodStart || b.BillingPeriodEnd) {
          periodHtml = _escHtml((b.BillingPeriodStart || '?') + ' – ' + (b.BillingPeriodEnd || '?'));
        }
      }

      // Destination cell (fix b-46a984a0) — identity match shows confirmed text +
      // "Change"; address-only/no-match always shows the Project→Building→Meter picker.
      const destHtml =
        row.bill && !row._saved
          ? _buildDestCell(
              row.bill,
              row._autoMatch,
              String(rowIdx),
              'setQueueRowDestProj',
              'setQueueRowDestBldg',
              'setQueueRowDestMeter',
              'setQueueRowDestExpand',
            )
          : '<span style="color:var(--text3);font-size:10px">—</span>';

      // Actions: Resolve button for dups (opens dup comparison modal)
      let actionsHtml = '';
      if (dup && !row._saved) {
        actionsHtml =
          '<button onclick="openQueueDupModal(' +
          rowIdx +
          ',' +
          flatIdx +
          ')" ' +
          'style="font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid rgba(245,158,11,.5);background:transparent;color:var(--amber);cursor:pointer;font-weight:600">Resolve</button>';
      }

      const fileName = row.result ? _escHtml(row.result.fileName) : '—';
      const isChecked = row.bill && !row._saved ? (row.checked !== false ? ' checked' : '') : '';
      const canCheck = row.bill && !row._saved;

      billRowsHtml +=
        '<tr style="background:' +
        bgColor +
        ';border-bottom:1px solid var(--border)">' +
        '<td style="padding:3px 5px;text-align:center">' +
        (canCheck
          ? '<input type="checkbox" onchange="toggleQueueRow(' + rowIdx + ',this.checked)"' + isChecked + '>'
          : '') +
        '</td>' +
        '<td style="padding:3px 6px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px" title="' +
        fileName +
        '">' +
        fileName +
        '</td>' +
        '<td style="padding:3px 6px;white-space:nowrap;color:var(--text)">' +
        periodHtml +
        '</td>' +
        '<td style="padding:3px 6px">' +
        statusHtml +
        '</td>' +
        '<td style="padding:3px 6px;min-width:120px;vertical-align:top">' +
        destHtml +
        '</td>' +
        '<td style="padding:3px 6px">' +
        actionsHtml +
        '</td>' +
        '</tr>';
    });

    billRowsHtml += '</tbody></table></div>';
  }

  html += billRowsHtml;
  tabsBar.innerHTML = html;

  // Active file — use existing multi-bill pipeline
  const activeResult = q.results[q._activeFileIdx];
  if (!activeResult || activeResult.status === 'failed') {
    document.getElementById('extractedFieldsHdr').innerHTML =
      '<div style="padding:20px;color:#c44;font-size:13px"><strong>' +
      _escHtml(activeResult ? activeResult.fileName : '') +
      '</strong> — ' +
      (activeResult ? activeResult.error || 'extraction failed' : 'no data') +
      '<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="retryQueueFile(' +
      q._activeFileIdx +
      ')">Retry</button></div></div>';
    document.getElementById('extractedFieldsGrid').innerHTML = '';
    box.textContent = '';
    return;
  }

  // Set globals so the existing renderMultiBillUI + renderPDFFields work normally
  window._pdfMultiBills = activeResult.bills;
  window._pdfMultiIdx = window._pdfMultiIdx || 0;
  if (window._pdfMultiIdx >= activeResult.bills.length) window._pdfMultiIdx = 0;
  window._pdfBillWarnings = activeResult.bills.map((b) => ({ warnings: b._warnings || [] }));
  window._pdfRawText = activeResult.rawText || null;

  // Use the existing multi-bill UI (vertical pills in right column)
  if (activeResult.bills.length > 1) {
    renderMultiBillUI(activeResult.bills, box);
  } else {
    box.innerHTML =
      '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text2)">' +
      JSON.stringify(activeResult.bills[0], null, 2) +
      '</pre>';
  }

  // Render extracted fields for the selected bill
  const activeBill = activeResult.bills[window._pdfMultiIdx];
  if (activeBill) {
    renderPDFFields(activeBill, activeBill._warnings || []);
  }
}

function selectQueueFile(idx) {
  const q = window._pdfQueue;
  if (!q) return;
  q._activeFileIdx = idx;
  q._activeGroupKey = null; // clear group selection when switching to file tab
  window._pdfMultiIdx = 0;
  renderQueueResults();
}

// selectQueueGroup(key) — Plan 7e0b9d15 §4
// Sets the active group pill and drives the right-column detail to the first file in that group.
function selectQueueGroup(key) {
  const q = window._pdfQueue;
  if (!q) return;
  q._activeGroupKey = key;
  // Find the first result file that belongs to this group and set _activeFileIdx
  const rows = window._pdfQueueRows;
  if (rows) {
    const groupMap = _groupQueueRows(rows);
    const grp = groupMap.get(key);
    if (grp && grp.rows.length > 0) {
      q._activeFileIdx = grp.rows[0].resultIdx;
    }
  }
  window._pdfMultiIdx = 0;
  renderQueueResults();
}

function _fmtShortDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.getMonth() + 1 + '/' + d.getDate();
}

function _getQueueDupInfo(row) {
  if (!window._pdfDupMap || !row.bill) return null;
  const q = window._pdfQueue;
  if (!q) return null;
  let flatIdx = 0;
  for (let ri = 0; ri < q.results.length; ri++) {
    if (ri === row.resultIdx) {
      flatIdx += row.billIdx;
      break;
    }
    flatIdx += q.results[ri].bills.length;
  }
  return window._pdfDupMap[flatIdx] || null;
}

function toggleQueueRow(rowIdx, checked) {
  if (window._pdfQueueRows && window._pdfQueueRows[rowIdx]) {
    window._pdfQueueRows[rowIdx].checked = checked;
    renderQueueResults();
  }
}

function toggleAllQueueRows(checked) {
  if (!window._pdfQueueRows) return;
  window._pdfQueueRows.forEach((r) => {
    if (r.bill && !r._saved) r.checked = checked;
  });
  renderQueueResults();
}

function resolveAllQueueDups(action) {
  if (!window._pdfDupMap || !window._pdfQueueRows) return;
  const rows = window._pdfQueueRows;
  let count = 0;
  rows.forEach((row) => {
    const dup = row.bill ? _getQueueDupInfo(row) : null;
    if (dup) {
      dup.action = action;
      count++;
    }
  });
  renderQueueResults();
  const labels = { overwrite: 'Overwrite', merge: 'Merge', skip: 'Skip' };
  showToast((labels[action] || action) + ' set for ' + count + ' duplicate' + (count !== 1 ? 's' : ''));
}

function updateQueueBatchProj(val) {
  if (window._pdfQueue) {
    window._pdfQueue.batchProjId = parseInt(val) || null;
    renderQueueResults();
  }
}

// (#35) Per-bill project override — set bill._projOverride from the row dropdown.
// Does not re-render the full UI (avoids dropdown flicker); just mutates the bill object.
function setQueueRowProject(rowIdx, val) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  const projId = parseInt(val) || null;
  rows[rowIdx].bill._projOverride = projId;
}

// ── Destination (Project→Building→Meter) setters — fix b-46a984a0 ──
// Sets bill._meterOverride, checked BEFORE findMeterMatch in saveQueuedBills so a
// manual pick always wins over the auto-match (per-bill + per-group variants below;
// grouped view applies the same choice to every bill sharing that account/meter key).
function setQueueRowDestExpand(rowIdx, expand) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  rows[rowIdx].bill._destExpanded = !!expand;
  if (!expand) delete rows[rowIdx].bill._meterOverride;
  renderQueueResults();
}
function setQueueRowDestProj(rowIdx, val) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  rows[rowIdx].bill._meterOverride = { projId: parseInt(val) || null, bldgId: null, meterId: null };
  renderQueueResults();
}
function setQueueRowDestBldg(rowIdx, val) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  const ov = rows[rowIdx].bill._meterOverride || { projId: null, bldgId: null, meterId: null };
  ov.bldgId = val || null;
  ov.meterId = null;
  rows[rowIdx].bill._meterOverride = ov;
  renderQueueResults();
}
function setQueueRowDestMeter(rowIdx, val) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  const ov = rows[rowIdx].bill._meterOverride || { projId: null, bldgId: null, meterId: null };
  ov.meterId = val || null;
  rows[rowIdx].bill._meterOverride = ov;
  renderQueueResults();
}
// Group-level variants (grouped/period-matrix view) — same override, applied to every
// row's bill sharing the group's account/meter key so the picker only appears once.
function setQueueGroupDestExpand(groupKey, expand) {
  const rows = window._pdfQueueRows;
  if (!rows) return;
  const grp = _groupQueueRows(rows).get(groupKey);
  if (!grp) return;
  grp.rows.forEach((row) => {
    if (!row.bill) return;
    row.bill._destExpanded = !!expand;
    if (!expand) delete row.bill._meterOverride;
  });
  renderQueueResults();
}
function setQueueGroupDestProj(groupKey, val) {
  const rows = window._pdfQueueRows;
  if (!rows) return;
  const grp = _groupQueueRows(rows).get(groupKey);
  if (!grp) return;
  const projId = parseInt(val) || null;
  grp.rows.forEach((row) => {
    if (row.bill) row.bill._meterOverride = { projId, bldgId: null, meterId: null };
  });
  renderQueueResults();
}
function setQueueGroupDestBldg(groupKey, val) {
  const rows = window._pdfQueueRows;
  if (!rows) return;
  const grp = _groupQueueRows(rows).get(groupKey);
  if (!grp) return;
  grp.rows.forEach((row) => {
    if (!row.bill) return;
    const ov = row.bill._meterOverride || { projId: null, bldgId: null, meterId: null };
    ov.bldgId = val || null;
    ov.meterId = null;
    row.bill._meterOverride = ov;
  });
  renderQueueResults();
}
function setQueueGroupDestMeter(groupKey, val) {
  const rows = window._pdfQueueRows;
  if (!rows) return;
  const grp = _groupQueueRows(rows).get(groupKey);
  if (!grp) return;
  grp.rows.forEach((row) => {
    if (!row.bill) return;
    const ov = row.bill._meterOverride || { projId: null, bldgId: null, meterId: null };
    ov.meterId = val || null;
    row.bill._meterOverride = ov;
  });
  renderQueueResults();
}

// (#36) Open the existing dup comparison modal for a specific queue bill row.
// Sets up window._pdfMultiBills so _renderDupModal can find the bill + dup info.
function openQueueDupModal(rowIdx, flatIdx) {
  const rows = window._pdfQueueRows;
  if (!rows || !rows[rowIdx] || !rows[rowIdx].bill) return;
  const row = rows[rowIdx];
  const q = window._pdfQueue;
  if (!q) return;

  // Point _pdfMultiBills at the result file's bill array so openDupModal/overwriteDupBill
  // etc. can find the bill at flatIdx within the file. Build a flat array of all bills
  // across results so flatIdx (into _pdfDupMap) maps correctly.
  const allBills = [];
  q.results.forEach((r) => r.bills.forEach((b) => allBills.push(b)));
  window._pdfMultiBills = allBills;
  window._pdfMultiIdx = flatIdx;
  window._pdfBillWarnings = allBills.map((b) => ({ warnings: b._warnings || [] }));

  openDupModal(flatIdx);
}

function queueDrillIn(rowIdx) {
  const row = window._pdfQueueRows && window._pdfQueueRows[rowIdx];
  if (!row || !row.bill) return;
  const grid = document.getElementById('extractedFieldsGrid');

  window._pdfQueueDrillIdx = rowIdx;

  // Show right column for drill-in detail view
  document.getElementById('pdfRightCol').style.display = '';
  const box = document.getElementById('pdfAIBox');

  const prevMultiBills = window._pdfMultiBills;
  const prevMultiIdx = window._pdfMultiIdx;
  const prevWarnings = window._pdfBillWarnings;
  window._pdfMultiBills = [row.bill];
  window._pdfMultiIdx = 0;
  window._pdfBillWarnings = [{ warnings: row.bill._warnings || [] }];

  // Back button in the left column
  grid.innerHTML =
    '<div style="padding:8px 0"><button class="btn btn-ghost btn-sm" ' +
    'onclick="exitQueueDrillIn()">← Back to results</button>' +
    ' <span style="font-size:12px;color:var(--text2)">' +
    _escHtml(row.result.fileName) +
    (row.bill.BillingPeriodStart ? ' · ' + row.bill.BillingPeriodStart : '') +
    '</span></div>';

  renderPDFFields(row.bill, row.bill._warnings || []);

  box.innerHTML =
    '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text2)">' +
    JSON.stringify(row.bill, null, 2) +
    '</pre>';

  window._pdfMultiBills = prevMultiBills;
  window._pdfMultiIdx = prevMultiIdx;
  window._pdfBillWarnings = prevWarnings;
}

function exitQueueDrillIn() {
  window._pdfQueueDrillIdx = null;
  document.getElementById('extractedFieldsHdr').innerHTML = '';
  document.getElementById('extractedFieldsGrid').innerHTML = '';
  document.getElementById('pdfAIBox').textContent = '';
  renderQueueResults();
}

async function retryQueueFile(resultIdx) {
  const q = window._pdfQueue;
  if (!q) return;
  const result = q.results[resultIdx];
  if (!result) return;
  const file = q.files[result.fileIdx];
  if (!file) {
    showToast('Original file no longer available');
    return;
  }

  result.status = 'retrying';
  renderQueueResults();
  showToast('Retrying ' + file.name + '...');

  try {
    const newResult = await _extractSingleFileForQueue(file, result.fileIdx);
    q.results[resultIdx] = newResult;
    const allBills = [];
    q.results.forEach((r) => r.bills.forEach((b) => allBills.push(b)));
    if (allBills.length > 0) await _checkDuplicates(allBills);
    showToast(file.name + ' — ' + newResult.bills.length + ' bill(s) found ✓');
  } catch (err) {
    q.results[resultIdx] = {
      fileIdx: result.fileIdx,
      fileName: file.name,
      bills: [],
      pdfB64: null,
      status: 'failed',
      error: err.message || 'Retry failed',
    };
    showToast(file.name + ' — retry failed: ' + (err.message || 'unknown error'));
  }
  renderQueueResults();
}

async function saveQueuedBills() {
  const q = window._pdfQueue;
  const rows = window._pdfQueueRows;
  if (!q || !rows) return;

  const toSave = rows.filter((r) => r.checked && r.bill && !r._saved);
  if (toSave.length === 0) {
    showToast('No bills selected');
    return;
  }

  let saved = 0,
    updated = 0,
    skipped = 0,
    failed = 0;
  const summaryEntries = [];

  // Fix (item 68e569a4 / plan §2.5): the meter-match fast path below writes hasPDF/
  // pdfKey from bill._pdfSharedKey (see _saveBillToMatchedMeter), but nothing in the
  // batch queue ever stored the source PDF or tagged bills with that key before this
  // point — every batch bill saved via the fast path landed with hasPDF:false,
  // pdfKey:null, making the bill image unretrievable (Matt's "can't see the bill
  // image" complaint). Store each result's PDF once, shared across all its bills,
  // mirroring _dupBulkAction / savePDFAllBills which already do this for the
  // single-file flow. Runs BEFORE the save loop so pdfB64 swaps below don't collide.
  const _storedResultIdx = new Set();
  for (const row of toSave) {
    if (_storedResultIdx.has(row.resultIdx)) continue;
    _storedResultIdx.add(row.resultIdx);
    const result = q.results[row.resultIdx];
    if (result && result.pdfB64 && result.bills && result.bills.length) {
      const prevB64ForStore = pdfB64;
      pdfB64 = result.pdfB64;
      try {
        await _ensureBatchPdfStored(result.bills);
      } catch (storeErr) {
        console.warn('[Queue Save] _ensureBatchPdfStored failed for', result.fileName, storeErr);
      } finally {
        pdfB64 = prevB64ForStore;
      }
    }
  }

  for (const row of toSave) {
    const period =
      (row.bill.BillingPeriodStart || row.bill.DeliveryDate || '?') +
      ' → ' +
      (row.bill.BillingPeriodEnd || row.bill.DeliveryDate || '?');
    try {
      const projId =
        row.bill._projOverride || (row.bill._meterOverride && row.bill._meterOverride.projId) || q.batchProjId;

      let flatIdx = 0;
      for (let ri = 0; ri < q.results.length; ri++) {
        if (ri === row.resultIdx) {
          flatIdx += row.billIdx;
          break;
        }
        flatIdx += q.results[ri].bills.length;
      }

      const dup = window._pdfDupMap && window._pdfDupMap[flatIdx];

      if (dup && dup.action === 'skip') {
        skipped++;
        row._saved = true;
        summaryEntries.push({
          period,
          status: 'skipped',
          destination: dup.location || 'duplicate',
          method: 'dup',
        });
        continue;
      }

      if (dup && (dup.action === 'overwrite' || dup.action === 'merge')) {
        await _applyDupUpdate(flatIdx, row.bill, dup);
        updated++;
        row._saved = true;
        summaryEntries.push({
          period,
          status: 'updated',
          destination: dup.location || 'duplicate',
          method: 'dup',
        });
        continue;
      }

      if (dup && !dup.action) {
        skipped++;
        summaryEntries.push({ period, status: 'skipped', destination: 'unresolved duplicate', method: 'dup' });
        continue;
      }

      // Manual Destination override (fix b-46a984a0) takes priority over the auto-match —
      // a user's explicit Project→Building→Meter pick in the batch review UI always wins.
      // Only counts when meterId is set (a fully-specified pick); a partial pick (e.g.
      // project only, no building/meter chosen) falls through to the auto-match/fallback
      // below untouched.
      if (row.bill._meterOverride && row.bill._meterOverride.meterId) {
        const ov = row.bill._meterOverride;
        const ovProj = projects.find((p) => p.id === ov.projId);
        const ovBldg = ovProj && getUDBldg(ov.projId, ov.bldgId);
        const ovMeter = ovBldg && (ovBldg.meters || []).find((m) => m.id === ov.meterId);
        if (ovProj && ovBldg && ovMeter) {
          try {
            const dest = _saveBillToMatchedMeter(row.bill, {
              proj: ovProj,
              bldg: ovBldg,
              meter: ovMeter,
              projId: ov.projId,
              bldgId: ov.bldgId,
              meterId: ov.meterId,
            });
            if (dest) {
              saved++;
              row._saved = true;
              summaryEntries.push({ period, status: 'saved', destination: dest, method: 'manual' });
              continue;
            }
          } catch (ovErr) {
            console.warn('[Queue Save] manual destination override save failed, trying auto-match:', ovErr);
          }
        }
      }

      // Try global meter match first (finds correct building by account number).
      // Reuse the match precomputed in renderQueueResults (row._autoMatch) so the
      // Destination column and the actual save always agree — recompute only if for
      // some reason the row was never rendered (defensive; should not normally happen).
      //
      // GATE (fix b-46a984a0): only an 'identity' match (account/meter-number hit) may
      // auto-save here. An 'address'-only match is NOT silently applied even though
      // findMeterMatch() found one — the batch UI showed it as an "unconfirmed"
      // suggestion the user had to actively accept via the Destination picker (handled
      // above as _meterOverride), and if they didn't, this is exactly the live-incident
      // bug (a bill mis-routed to the wrong building via address fallback — 219e6828,
      // and Ballfields landing under High School). Falling through to the project-scoped
      // _saveSinglePDFBill fallback below is safe: that path only matches by account/
      // meter number within the batch project, never by address, so an unconfirmed
      // address guess can never silently misattach a bill to the wrong building.
      const meterMatch = row._autoMatch !== undefined ? row._autoMatch : findMeterMatch(row.bill);
      if (meterMatch && meterMatch.matchType === 'identity') {
        try {
          const dest = _saveBillToMatchedMeter(row.bill, meterMatch);
          if (dest) {
            saved++;
            row._saved = true;
            summaryEntries.push({ period, status: 'saved', destination: dest, method: 'match' });
            continue;
          }
        } catch (matchErr) {
          console.warn('[Queue Save] meter match save failed, trying fallback:', matchErr);
        }
      }

      // Fallback to _saveSinglePDFBill (project-scoped match)
      const prevB64 = pdfB64;
      try {
        pdfB64 = row.result.pdfB64;
        const ok = await _saveSinglePDFBill(row.bill, projId);
        if (ok) {
          saved++;
          row._saved = true;
          summaryEntries.push({ period, status: 'saved', destination: 'project match', method: 'project' });
        } else {
          failed++;
          summaryEntries.push({ period, status: 'failed', destination: 'no match found', method: '' });
        }
      } finally {
        pdfB64 = prevB64;
      }
    } catch (err) {
      console.warn('[Queue Save] Error saving bill:', err);
      failed++;
      summaryEntries.push({ period, status: 'failed', destination: err.message || 'error', method: '' });
    }
  }

  // F4: release large per-result buffers now that all rows are saved.
  // This runs only after the entire save loop — after every prevB64 restore (line ~5096)
  // and every _saveSinglePDFBill / _applyDupUpdate call has completed.  Multiple rows can
  // share the same result object (one PDF → many bills), so we null on the result, not
  // per-row, to avoid use-after-free on the prevB64 swap at line ~5082.
  if (q && q.results) {
    q.results.forEach(function (r) {
      r.pdfB64 = null;
      r.rawText = null;
    });
  }

  renderQueueResults();

  const parts = [];
  if (saved > 0) parts.push(saved + ' saved');
  if (updated > 0) parts.push(updated + ' updated');
  if (skipped > 0) parts.push(skipped + ' skipped');
  if (failed > 0) parts.push(failed + ' failed');
  showToast('Batch save: ' + parts.join(', ') + ' ✓');
  if (summaryEntries.length > 0) _showSaveSummary(summaryEntries);

  if (
    document.getElementById('savedBillsModal') &&
    document.getElementById('savedBillsModal').classList.contains('open')
  ) {
    renderSavedBills();
  }
}

function _saveExtractionState() {
  // Save single-file extraction state
  if (window._pdfMultiBills && window._pdfMultiBills.length) {
    try {
      sessionStorage.setItem(
        'ch_extraction_state',
        JSON.stringify({
          bills: window._pdfMultiBills,
          idx: window._pdfMultiIdx || 0,
          dupMap: window._pdfDupMap || {},
          warnings: window._pdfBillWarnings || [],
          commTab: window._pdfCommTab || null,
          passScores: window._pdfPassScores || [],
          billsSaved: window._pdfBillsSaved || false,
          timestamp: Date.now(),
        }),
      );
    } catch (e) {
      console.warn('[Extraction] Could not save state to sessionStorage:', e.message);
    }
  }
  // Save queue extraction state (multi-file batch results)
  if (window._pdfQueue && window._pdfQueue.results && window._pdfQueue.results.length > 0) {
    try {
      // Strip pdfB64 and rawText from results to stay within sessionStorage limits
      const slimResults = window._pdfQueue.results.map(function (r) {
        return {
          fileIdx: r.fileIdx,
          fileName: r.fileName,
          bills: r.bills,
          status: r.status,
          error: r.error || null,
        };
      });
      sessionStorage.setItem(
        'ch_queue_state',
        JSON.stringify({
          results: slimResults,
          status: window._pdfQueue.status,
          batchProjId: window._pdfQueue.batchProjId,
          _activeFileIdx: window._pdfQueue._activeFileIdx,
          queueRows: window._pdfQueueRows || null,
          timestamp: Date.now(),
        }),
      );
    } catch (e) {
      console.warn('[Queue] Could not save queue state to sessionStorage:', e.message);
    }
  }
}

function _restoreExtractionState() {
  try {
    const raw = sessionStorage.getItem('ch_extraction_state');
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (Date.now() - state.timestamp > 3600000) {
      sessionStorage.removeItem('ch_extraction_state');
      return false;
    }
    window._pdfMultiBills = state.bills;
    window._pdfMultiIdx = state.idx;
    window._pdfDupMap = state.dupMap;
    window._pdfBillWarnings = state.warnings;
    window._pdfCommTab = state.commTab;
    window._pdfPassScores = state.passScores;
    window._pdfBillsSaved = state.billsSaved || false;
    sessionStorage.removeItem('ch_extraction_state');
    return true;
  } catch (e) {
    return false;
  }
}

function _restoreQueueState() {
  try {
    const raw = sessionStorage.getItem('ch_queue_state');
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (Date.now() - state.timestamp > 3600000) {
      sessionStorage.removeItem('ch_queue_state');
      return false;
    }
    // Rebuild a minimal _pdfQueue with the saved results
    window._pdfQueue = {
      files: state.results.map(function (r) {
        return { name: r.fileName };
      }),
      results: state.results,
      currentIdx: state.results.length,
      batchProjId: state.batchProjId || null,
      status: 'done',
      _processedCount: state.results.length,
      _activeFileIdx: state._activeFileIdx || 0,
    };
    window._pdfQueueRows = state.queueRows || null;
    sessionStorage.removeItem('ch_queue_state');
    return true;
  } catch (e) {
    return false;
  }
}

function _clearExtractionState() {
  sessionStorage.removeItem('ch_extraction_state');
}

function _buildDiffFields(extracted, existing) {
  // Compare extracted fields to existing bill record
  // extracted uses raw field names (AccountNumber, BillingPeriodStart, etc.)
  // existing assigned bills use billRow format (start, end, kwh, etc.)
  // We need to map between them
  const FIELD_MAP = {
    // extracted key → existing billRow key
    BillingPeriodStart: 'start',
    BillingPeriodEnd: 'end',
    // Metadata (Update 84 — now compared so diff-count is accurate)
    UtilityCompany: 'utilityCompany',
    CustomerName: 'customerName',
    ServiceAddress: 'serviceAddress',
    AccountNumber: 'accountNumber',
    MeterNumber: 'meterNumber',
    NumberOfDays: 'numberOfDays',
    MeterReadStart: 'meterReadStart',
    MeterReadEnd: 'meterReadEnd',
    StartRead: 'startRead',
    EndRead: 'endRead',
    kWhConsumed: 'kwh',
    ActualKW: 'demandKW',
    BilledKW: 'billedKW',
    FacilitiesKW: 'facKW',
    FacilitiesCharge: 'facKWCost',
    TotalCurrentCharges: 'totalCost',
    RateSchedule: 'rateSchedule',
    CustomerCharge: 'customerCharge',
    BilledKWCharge: 'demandCharge',
    EnergyOnPeakCharge: 'onPeakCost',
    EnergyOffPeakCharge: 'offPeakCost',
    ECACharge: 'ecaCharge',
    EERCharge: 'eerCharge',
    PTSCharge: 'ptsCharge',
    TDCCharge: 'tdcCharge',
    TDCkW: 'tdcKW',
    RkVACharge: 'rkvaCharge',
    FranchiseFee: 'franchiseFee',
    TaxExemptDelivery: 'taxExemptDelivery',
    BillOffset: 'billOffset',
    TotalKWhRate: 'totalKwhRate',
    TotalKWRate: 'totalKwRate',
    OnPeakRate: 'onPeakRate',
    OffPeakRate: 'offPeakRate',
    OnPeakKWh: 'onPeakKwh',
    OffPeakKWh: 'offPeakKwh',
    ReadDifference: 'readDifference',
    MeterMultiplier: 'meterMultiplier',
  };
  // For saved (unassigned) bills, fields map 1:1 (same raw keys)
  const isSaved = !existing.start && existing.BillingPeriodStart !== undefined;
  const toISO = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  };
  const normVal = (v) => {
    if (v === null || v === undefined || v === '') return '';
    return String(v)
      .replace(/[$,\s]/g, '')
      .toLowerCase();
  };

  const diffs = [];
  const COMPARE_KEYS = [
    'AccountNumber',
    'MeterNumber',
    'CustomerName',
    'ServiceAddress',
    'RateSchedule',
    'BillingPeriodStart',
    'BillingPeriodEnd',
    'MeterReadStart',
    'MeterReadEnd',
    'StartRead',
    'EndRead',
    'kWhConsumed',
    'ActualKW',
    'BilledKW',
    'FacilitiesKW',
    'CustomerCharge',
    'FacilitiesCharge',
    'BilledKWCharge',
    'EnergyOnPeakCharge',
    'EnergyOffPeakCharge',
    'ECACharge',
    'EERCharge',
    'PTSCharge',
    'TDCCharge',
    'TaxExemptDelivery',
    'BillOffset',
    'FranchiseFee',
    'TotalCurrentCharges',
    'NumberOfDays',
    'TotalKWhRate',
    'TotalKWRate',
    'OnPeakRate',
    'OffPeakRate',
    'OnPeakKWh',
    'OffPeakKWh',
    'ReadDifference',
    'MeterMultiplier',
    'TDCkW',
    'RkVACharge',
  ];

  for (const key of COMPARE_KEYS) {
    const newVal = extracted[key] ?? '';
    let existVal = '';
    if (isSaved) {
      existVal = existing[key] ?? '';
    } else {
      // Assigned bill — map to billRow format
      const mapped = FIELD_MAP[key];
      if (mapped === null) continue; // Aggregated field, skip
      if (mapped === undefined) continue; // Not stored in billRow
      existVal = existing[mapped] ?? '';
      // Convert dates: extracted is MM/DD/YYYY, billRow is YYYY-MM-DD
      if (key === 'BillingPeriodStart' || key === 'BillingPeriodEnd') {
        existVal = existVal; // already ISO
        const newISO = toISO(String(newVal));
        if (normVal(newISO) === normVal(existVal)) continue;
        diffs.push({ key, newVal, existVal, newNorm: newISO, existNorm: existVal });
        continue;
      }
    }
    // Numeric comparison: treat 445.0560 and 445.056 as equal
    const newNum = parseFloat(String(newVal).replace(/[$,\s]/g, ''));
    const exNum = parseFloat(String(existVal).replace(/[$,\s]/g, ''));
    if (!isNaN(newNum) && !isNaN(exNum) && newNum === exNum) continue;
    if (normVal(newVal) !== normVal(existVal)) {
      diffs.push({ key, newVal: String(newVal), existVal: String(existVal) });
    }
  }
  return diffs;
}

async function _checkDuplicates(bills, statusCb) {
  const dupMap = {};
  // Load all saved (unassigned) bills — filter to match what the Saved Bills modal shows.
  // Bills with projId are orphans from an older double-storage era; they're hidden in the modal
  // but were previously triggering false "already in Saved Bills" matches.
  const pdfBills = ((await sget('en_pdf_bills', [])) || []).filter((b) => !b.projId);
  // Build account-keyed index for O(K) lookup per extracted bill.
  // normAcct matches _acctFuzzyMatch's internal normalization (leading zeros stripped)
  // so index keys align with what _acctFuzzyMatch treats as identical.
  const normAcct = (v) =>
    (v || '')
      .replace(/[\s\-]/g, '')
      .replace(/^0+/, '')
      .toLowerCase();
  const assignedByAcct = Object.create(null); // { normalizedAccount -> entry[] }
  const assignedBills = []; // kept for fallback scan (see below)
  for (const p of projects) {
    const ud = utilityData[p.id];
    if (!ud) continue;
    for (const b of ud.buildings || []) {
      for (const m of b.meters || []) {
        const acctKey = normAcct(m.account || '');
        for (const bill of m.bills || []) {
          const entry = {
            bill,
            projId: p.id,
            projName: p.name,
            bldgName: b.name,
            meterLabel: m.commodity + ' · Acct ' + (m.account || '—') + ' · Meter ' + (m.meter || '—'),
            meter: m,
            hasPDF: !!bill.hasPDF,
            pdfKey: bill.pdfKey || null,
          };
          assignedBills.push(entry);
          if (acctKey) {
            if (!assignedByAcct[acctKey]) assignedByAcct[acctKey] = [];
            assignedByAcct[acctKey].push(entry);
          }
        }
      }
    }
  }
  // Normalize helper
  const norm = (v) => (v || '').replace(/[\s\-]/g, '').toLowerCase();
  // Fuzzy period match: treat two bills as the same billing cycle only when BOTH
  // the start and end dates are within 5 days of each other. Previously this used
  // "same Month YYYY of the end date" which false-matched any two bills ending in
  // the same calendar month (e.g. 02/01–03/03 vs 03/02–03/27 both ended in March).
  const FUZZY_DAY_TOLERANCE = 5;
  const dayDiff = (a, b) => {
    if (!a || !b) return Infinity;
    const da = new Date(a);
    const db = new Date(b);
    if (isNaN(da) || isNaN(db)) return Infinity;
    return Math.abs((da - db) / 86400000);
  };
  const periodClose = (s1, e1, s2, e2) =>
    !!s1 && !!e1 && !!s2 && !!e2 && dayDiff(s1, s2) <= FUZZY_DAY_TOLERANCE && dayDiff(e1, e2) <= FUZZY_DAY_TOLERANCE;
  // Convert extracted date (MM/DD/YYYY or MM-DD-YY) to ISO (YYYY-MM-DD) for comparison
  const toISO = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  };

  for (let i = 0; i < bills.length; i++) {
    if (i > 0 && i % 5 === 0) {
      if (typeof statusCb === 'function') statusCb('Checking for duplicates (' + i + '/' + bills.length + ')...');
      await new Promise((r) => setTimeout(r, 0));
    }
    const ext = bills[i];
    const extAcct = norm(ext.AccountNumber);
    const extStart = toISO(ext.BillingPeriodStart || ext.DeliveryDate);
    const extEnd = toISO(ext.BillingPeriodEnd || ext.DeliveryDate);
    const extMeter = norm(ext.MeterNumber);
    const extComm = (ext.Commodity || '').toLowerCase();
    if (!extAcct && !extStart) continue; // Can't match without identity

    // Fast path: look up only bills whose account key exactly matches (after leading-zero strip).
    // Fallback: if no exact match found and the extracted account is non-empty, scan all
    // assigned bills — this preserves _acctFuzzyMatch substring tolerance for OCR-garbled
    // accounts (e.g. "123" extracted against "1234567" stored).
    const extAcctKey = normAcct(ext.AccountNumber);
    const acctCandidates = extAcctKey && assignedByAcct[extAcctKey] ? assignedByAcct[extAcctKey] : assignedBills; // fallback: full scan (worst case = original O(N), only when no key match)
    for (const ab of acctCandidates) {
      const existAcct = norm(ab.meter.account);
      const existMeter = norm(ab.meter.meter);
      const acctMatch = _acctFuzzyMatch(extAcct, existAcct);
      const meterMatch = extMeter && existMeter && extMeter === existMeter;
      const extInv = norm(ext.InvoiceNumber || ext.SaleNumber);
      const existInv = norm(ab.bill.invoiceNumber || ab.bill.saleNumber);
      const invoiceMatch = extInv && existInv && extInv === existInv;
      const existComm = (ab.bill.commodity || ab.meter.commodity || '').toLowerCase();
      const commMatch = !extComm || !existComm || extComm === existComm;
      const periodMatch = extStart && ab.bill.start === extStart && extEnd && ab.bill.end === extEnd;
      const fuzzyPeriod = !periodMatch && periodClose(extStart, extEnd, ab.bill.start, ab.bill.end);
      if ((acctMatch || meterMatch || invoiceMatch) && (periodMatch || fuzzyPeriod) && commMatch) {
        // Build diff fields
        const diffFields = _buildDiffFields(ext, ab.bill);
        dupMap[i] = {
          existing: ab.bill,
          location: ab.projName + ' > ' + ab.bldgName + ' > ' + ab.meterLabel,
          locationType: 'assigned',
          projId: ab.projId,
          meter: ab.meter,
          hasPDF: ab.hasPDF,
          pdfKey: ab.pdfKey,
          matchFields: { account: acctMatch, period: periodMatch, meter: meterMatch },
          diffFields,
          action: null, // null = user hasn't decided yet
          fieldSelections: {}, // per-field: true = use new, false = keep existing
        };
        break; // First match wins
      }
    }
    if (dupMap[i]) continue; // Already matched to assigned

    // Search unassigned saved bills
    for (const sb of pdfBills) {
      const sbAcct = norm(sb.AccountNumber);
      const sbStart = toISO(sb.BillingPeriodStart);
      const sbEnd = toISO(sb.BillingPeriodEnd);
      const sbMeter = norm(sb.MeterNumber);
      const acctMatch = _acctFuzzyMatch(extAcct, sbAcct);
      const meterMatch = extMeter && sbMeter && extMeter === sbMeter;
      const sbComm = (sb.Commodity || sb.commodity || '').toLowerCase();
      const commMatch = !extComm || !sbComm || extComm === sbComm;
      const periodMatch = extStart && sbStart === extStart && extEnd && sbEnd === extEnd;
      const fuzzyPeriod = !periodMatch && periodClose(extStart, extEnd, sbStart, sbEnd);
      if ((acctMatch || meterMatch) && (periodMatch || fuzzyPeriod) && commMatch) {
        const diffFields = _buildDiffFields(ext, sb);
        dupMap[i] = {
          existing: sb,
          location: 'Saved Bills' + (sb.projName ? ' (' + sb.projName + ')' : ''),
          locationType: 'saved',
          savedBillId: sb.id,
          hasPDF: !!sb.hasPDF,
          pdfKey: sb.pdfKey || null,
          matchFields: { account: acctMatch, period: periodMatch, meter: meterMatch },
          diffFields,
          action: null,
          fieldSelections: {},
        };
        break;
      }
    }
  }
  window._pdfDupMap = dupMap;
  return dupMap;
}

// "All" buttons — process every duplicate sequentially (one at a time), executing
// the action immediately. For overwrite/merge this runs _applyDupUpdate on each
// dup in order, yielding to the UI between iterations so the user sees LHS pills
// recolor one by one as each bill is processed. For skip we just mark — nothing
// to execute, the Save All flow honors the skip flag. Each processed dup is
// tagged `action: 'processed'` so the Save All loop doesn't re-apply it and
// doesn't mistake it for an un-handled new bill either.
// "All" buttons — process EVERY extracted bill sequentially (one at a time),
// handling duplicates via their action and saving non-duplicates via the normal
// save path. User mental model: "I click 'Overwrite All' and I expect every bill
// in this extraction to be handled — dups get overwritten, new bills get saved."
//
// Flow:
//   action='skip'      → dups marked skip, non-dups saved via _saveSinglePDFBill
//   action='overwrite' → dups run _applyDupUpdate, non-dups saved via _saveSinglePDFBill
//   action='merge'     → dups run _applyDupUpdate, non-dups saved via _saveSinglePDFBill
//
// A 120 ms yield between iterations lets the browser paint each bill's re-render
// so LHS pills visibly update one at a time — "one billing period at a time" in
// the user's words. Processed dups get tagged `action: 'processed'` so a later
// Save All click won't re-apply them.
// Centered fixed-position progress dialog used by the "All" button handlers.
// Hard to miss — covers the middle of the screen with a high z-index so neither
// the dup banner nor the pills column can obscure it. Shows a title, a live
// progress line, a visual progress bar, and an errors list. Auto-hides on close.
function _bulkProgressShow(title) {
  let el = document.getElementById('bulkProgressDialog');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bulkProgressDialog';
    el.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'z-index:9999;background:var(--s3);border:2px solid var(--accent);' +
      'border-radius:12px;padding:22px 28px;min-width:360px;max-width:520px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.6);font-size:13px;color:var(--text)';
    document.body.appendChild(el);
  }
  el.innerHTML =
    '<div id="bpTitle" style="font-size:15px;font-weight:800;color:var(--accent);' +
    'text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">' +
    title +
    '</div>' +
    '<div id="bpStatus" style="margin-bottom:10px;color:var(--text)">Starting…</div>' +
    '<div style="width:100%;height:10px;background:var(--s2);border-radius:5px;overflow:hidden;margin-bottom:10px">' +
    '<div id="bpBar" style="width:0%;height:100%;background:var(--accent);transition:width .2s"></div>' +
    '</div>' +
    '<div id="bpErrors" style="font-size:11px;color:var(--red);max-height:80px;overflow-y:auto"></div>';
  el.style.display = 'block';
}
function _bulkProgressUpdate(i, total, msg, errMsg) {
  const st = document.getElementById('bpStatus');
  const bar = document.getElementById('bpBar');
  const errs = document.getElementById('bpErrors');
  if (st) st.textContent = msg || 'Processing bill ' + i + ' of ' + total + '…';
  if (bar) bar.style.width = Math.round((i / total) * 100) + '%';
  if (errMsg && errs) errs.innerHTML += '<div>' + errMsg + '</div>';
}
function _bulkProgressDone(summary) {
  const el = document.getElementById('bulkProgressDialog');
  if (!el) return;
  const st = document.getElementById('bpStatus');
  const bar = document.getElementById('bpBar');
  if (st) st.textContent = summary;
  if (bar) bar.style.width = '100%';
  setTimeout(() => {
    if (el) el.style.display = 'none';
  }, 1800);
}

async function _dupBulkAction(action) {
  console.log('[_dupBulkAction] called with action =', action);
  const dupMap = window._pdfDupMap || {};
  const bills = window._pdfMultiBills;
  if (!bills || !bills.length) {
    console.log('[_dupBulkAction] no bills in window._pdfMultiBills — aborting');
    showToast('No bills to process');
    return;
  }
  const commFilter = window._pdfCommTab && window._pdfCommTab !== 'All' ? window._pdfCommTab : null;
  console.log(
    '[_dupBulkAction] bills:',
    bills.length,
    'dupMap keys:',
    Object.keys(dupMap).length,
    'commFilter:',
    commFilter,
  );
  closeDupModal();
  // Store the source PDF once per session and tag every bill with a shared key.
  // Must run BEFORE the save loop so per-bill save paths can read
  // extracted._pdfSharedKey and land the right pdfKey on their stored records.
  // Without this the PDFs go blank — new bills get pdfKey=null and dup overwrites
  // get new page ranges written against old/missing PDFs.
  const sharedKey = await _ensureBatchPdfStored(bills);
  console.log('[_dupBulkAction] shared PDF key:', sharedKey);

  const reRender = () => {
    const box = document.getElementById('pdfAIBox');
    if (box) renderMultiBillUI(bills, box);
    const i = window._pdfMultiIdx || 0;
    const billWarnings = (window._pdfBillWarnings || [])[i]?.warnings || [];
    if (bills[i]) renderPDFFields(bills[i], billWarnings);
  };

  // Project selection is ONLY required when at least one bill has no known
  // destination at all — i.e. not a duplicate AND no meter match by account or
  // meter number. For duplicates and account-matched non-duplicates, we already
  // know exactly where the bill belongs and there is no reason to force the user
  // to pick a project first. This matches the user's stated expectation:
  //   "when there is a bill that the code recognizes belongs to an existing
  //    meter or project the user should not have to do anything other than
  //    click save."
  let selectedPid = parseInt(document.getElementById('pdfProjSel').value) || null;
  let inferredPid = selectedPid;
  const needsProjectIndices = [];
  for (let i = 0; i < bills.length; i++) {
    if (commFilter && (bills[i].Commodity || 'Other') !== commFilter) continue;
    const r = _resolveBillDestination(bills[i], dupMap[i], inferredPid);
    if (r.method === 'match' && !inferredPid) {
      inferredPid = r.match.projId;
    }
    if (r.method === 'unassigned') needsProjectIndices.push(i);
  }
  if (needsProjectIndices.length > 0 && !inferredPid) {
    showToast(
      needsProjectIndices.length +
        ' bill' +
        (needsProjectIndices.length === 1 ? '' : 's') +
        " don't match an existing meter — select a project to save them to",
    );
    console.log('[_dupBulkAction] unassigned bills without projId:', needsProjectIndices);
    return;
  }
  if (needsProjectIndices.length > 0 && inferredPid && !selectedPid) {
    selectedPid = inferredPid;
  }

  const verb = action === 'overwrite' ? 'overwritten' : action === 'merge' ? 'merged' : 'skipped';
  const titleVerb = action === 'overwrite' ? 'Overwriting' : action === 'merge' ? 'Merging' : 'Skipping';
  _bulkProgressShow(titleVerb + ' all bills');

  const summaryEntries = [];
  let dupHandled = 0;
  let saved = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < bills.length; i++) {
    if (commFilter && (bills[i].Commodity || 'Other') !== commFilter) continue;
    const dup = dupMap[i];
    const period =
      (bills[i].BillingPeriodStart || bills[i].DeliveryDate || '?') +
      ' → ' +
      (bills[i].BillingPeriodEnd || bills[i].DeliveryDate || '?');
    _bulkProgressUpdate(i + 1, bills.length, 'Bill ' + (i + 1) + ' of ' + bills.length + ' — ' + period);

    const resolved = _resolveBillDestination(bills[i], dup, selectedPid);
    let status = null;
    let destination = resolved.destination;
    let errText = '';

    if (dup) {
      if (dup.action === 'processed') {
        status = 'updated';
        dupHandled++;
      } else if (action === 'skip') {
        dup.action = 'skip';
        status = 'skipped';
        skipped++;
      } else {
        dup.action = action;
        let ok = false;
        try {
          ok = await _applyDupUpdate(i, bills[i], dup);
        } catch (e) {
          ok = false;
          errText = e && e.message ? e.message : String(e);
          console.error('[_dupBulkAction] _applyDupUpdate threw for bill', i, e);
        }
        if (ok) {
          dup.action = 'processed';
          status = 'updated';
          dupHandled++;
        } else {
          dup.action = action;
          status = 'failed';
          failed++;
          _bulkProgressUpdate(
            i + 1,
            bills.length,
            null,
            'Bill ' + (i + 1) + ' failed' + (errText ? ': ' + errText : ''),
          );
        }
      }
    } else if (resolved.method === 'match' && resolved.match) {
      // Non-duplicate with a global meter match — save directly to that meter,
      // no project selector needed. This is the fast path for "new bill for a
      // meter that already exists in another project/building."
      let dest = null;
      try {
        dest = _saveBillToMatchedMeter(bills[i], resolved.match);
      } catch (e) {
        errText = e && e.message ? e.message : String(e);
        console.error('[_dupBulkAction] _saveBillToMatchedMeter threw for bill', i, e);
      }
      if (dest) {
        destination = dest;
        status = 'saved';
        saved++;
      } else {
        status = 'failed';
        failed++;
        _bulkProgressUpdate(
          i + 1,
          bills.length,
          null,
          'Bill ' + (i + 1) + ' match save failed' + (errText ? ': ' + errText : ''),
        );
      }
    } else {
      // No dup, no meter match — fall back to the old _saveSinglePDFBill path
      // with whatever project the user may have selected. _resolveBillDestination
      // already blocked us from getting here without a projId when unassigned.
      let ok = false;
      try {
        ok = await _saveSinglePDFBill(bills[i], selectedPid);
      } catch (e) {
        ok = false;
        errText = e && e.message ? e.message : String(e);
        console.error('[_dupBulkAction] _saveSinglePDFBill threw for bill', i, e);
      }
      if (ok) {
        status = 'saved';
        saved++;
      } else {
        status = 'failed';
        failed++;
        _bulkProgressUpdate(
          i + 1,
          bills.length,
          null,
          'Bill ' + (i + 1) + ' save failed' + (errText ? ': ' + errText : ''),
        );
      }
    }

    summaryEntries.push({
      period,
      status,
      destination,
      method: resolved.method,
    });
    reRender();
    await new Promise((r) => setTimeout(r, 120));
  }

  const parts = [];
  if (dupHandled) parts.push(dupHandled + ' ' + verb);
  if (saved) parts.push(saved + ' saved');
  if (skipped) parts.push(skipped + ' skipped');
  if (failed) parts.push(failed + ' failed');
  if (!parts.length) parts.push('nothing to do');
  const _blInherited3 = _inheritBaselinesForProject(selectedPid);
  const blMsg3 = _blInherited3
    ? ' · ' + _blInherited3 + ' baseline' + (_blInherited3 !== 1 ? 's' : '') + ' inherited'
    : '';
  const summary = parts.join(', ') + ' (' + bills.length + ' total)' + blMsg3;
  console.log('[_dupBulkAction] done —', summary);
  _bulkProgressDone(summary);
  showToast(summary);
  // Pop the full destination summary so the user has a user-readable record of
  // where every bill in the batch ended up — no digging through meter bill lists
  // to reconstruct what happened.
  _showSaveSummary(summaryEntries);
  window._pdfBillsSaved = true;
  if (udSelProjId && udSelBldgId) {
    renderUDDetail();
    renderUDProjList();
  }
}

function openDupModal(billIdx) {
  window._dupModalIdx = billIdx;
  _renderDupModal(billIdx);
  document.getElementById('dupCompareModal').classList.add('open');
}
function closeDupModal() {
  document.getElementById('dupCompareModal').classList.remove('open');
}

function _renderDupModal(billIdx) {
  const dupMap = window._pdfDupMap || {};
  const dup = dupMap[billIdx];
  const bills = window._pdfMultiBills || [];
  const ext = bills[billIdx];
  if (!dup || !ext) return;

  // Title
  const period = (ext.BillingPeriodStart || '?') + ' to ' + (ext.BillingPeriodEnd || '?');
  document.getElementById('dupModalTitle').innerHTML = '&#9888; Duplicate Bill &mdash; ' + period;

  // Nav
  const dupIndices = Object.keys(dupMap)
    .map(Number)
    .sort((a, b) => a - b);
  const pos = dupIndices.indexOf(billIdx);
  const prevIdx = pos > 0 ? dupIndices[pos - 1] : null;
  const nextIdx = pos < dupIndices.length - 1 ? dupIndices[pos + 1] : null;
  document.getElementById('dupModalNav').innerHTML =
    (prevIdx !== null
      ? `<a href="#" onclick="event.preventDefault();openDupModal(${prevIdx})" style="color:var(--accent)">&larr; Prev</a>`
      : '<span style="opacity:.3">&larr; Prev</span>') +
    ` &nbsp;|&nbsp; Duplicate ${pos + 1} of ${dupIndices.length} &nbsp;|&nbsp; ` +
    (nextIdx !== null
      ? `<a href="#" onclick="event.preventDefault();openDupModal(${nextIdx})" style="color:var(--accent)">Next &rarr;</a>`
      : '<span style="opacity:.3">Next &rarr;</span>');

  // Info
  const matchParts = [];
  if (dup.matchFields.account) matchParts.push('Account');
  if (dup.matchFields.period) matchParts.push('Period');
  if (dup.matchFields.meter) matchParts.push('Meter');
  const pdfHtml = dup.hasPDF
    ? `<span style="cursor:pointer;text-decoration:underline;color:var(--accent)" onclick="_viewDupPDF(${billIdx})">&#128196; PDF stored</span>`
    : 'No PDF stored';
  document.getElementById('dupModalInfo').innerHTML =
    '<div>' +
    dup.location +
    '</div>' +
    '<div>Match basis: ' +
    matchParts.join(' + ') +
    ' &#10003; &middot; ' +
    pdfHtml +
    '</div>';

  // Comparison table
  const LABELS = {
    AccountNumber: 'Account Number',
    MeterNumber: 'Meter Number',
    CustomerName: 'Customer Name',
    ServiceAddress: 'Service Address',
    RateSchedule: 'Rate Schedule',
    BillingPeriodStart: 'Billing Period Start',
    BillingPeriodEnd: 'Billing Period End',
    NumberOfDays: 'Number of Days',
    MeterReadStart: 'Meter Read Start',
    MeterReadEnd: 'Meter Read End',
    StartRead: 'Start Read',
    EndRead: 'End Read',
    kWhConsumed: 'kWh Consumed',
    ActualKW: 'Actual kW',
    BilledKW: 'Billed kW',
    FacilitiesKW: 'Facilities kW',
    CustomerCharge: 'Customer Charge',
    FacilitiesCharge: 'Facilities Charge',
    BilledKWCharge: 'Billed kW Charge',
    EnergyOnPeakCharge: 'On-Peak Charge',
    EnergyOffPeakCharge: 'Off-Peak Charge',
    ECACharge: 'ECA Charge',
    EERCharge: 'EER Charge',
    PTSCharge: 'PTS Charge',
    TDCCharge: 'TDC Charge',
    TaxExemptDelivery: 'Tax Exempt Delivery',
    BillOffset: 'Bill Offset',
    FranchiseFee: 'Franchise Fee',
    TotalCurrentCharges: 'Total Current Charges',
  };

  // Build rows: differing fields first, then matching
  const diffs = dup.diffFields || [];
  const diffKeys = new Set(diffs.map((d) => d.key));
  const allKeys = Object.keys(LABELS);

  // Initialize field selections: new values selected by default for differing fields
  for (const d of diffs) {
    if (dup.fieldSelections[d.key] === undefined) {
      dup.fieldSelections[d.key] = true; // true = use new
    }
  }

  let tableHtml =
    '<thead><tr style="border-bottom:2px solid var(--border)"><th style="padding:6px 12px;text-align:left;color:var(--text2);font-weight:600">Field</th><th style="padding:6px 12px;text-align:left;color:var(--text2);font-weight:600">Existing</th><th style="padding:6px 12px;text-align:left;color:var(--text2);font-weight:600">New (extracted)</th></tr></thead><tbody>';

  // Differing fields first
  for (const d of diffs) {
    const useNew = dup.fieldSelections[d.key] !== false;
    const selExist = !useNew ? 'border-left:3px solid #22c55e;opacity:1' : 'opacity:.5';
    const selNew = useNew ? 'border-left:3px solid #22c55e;opacity:1' : 'opacity:.5';
    tableHtml += `<tr style="background:rgba(245,158,11,.06)">
        <td style="padding:6px 12px;font-weight:600;color:var(--amber)">${LABELS[d.key] || d.key}</td>
        <td style="padding:6px 12px;cursor:pointer;${selExist}" onclick="_toggleDupField(${billIdx},'${d.key}',false)">${d.existVal || '<em style="opacity:.4">(empty)</em>'}</td>
        <td style="padding:6px 12px;cursor:pointer;${selNew}" onclick="_toggleDupField(${billIdx},'${d.key}',true)">${d.newVal || '<em style="opacity:.4">(empty)</em>'}</td>
      </tr>`;
  }

  // Matching fields (muted)
  for (const key of allKeys) {
    if (diffKeys.has(key)) continue;
    const val = ext[key];
    if (val === null || val === undefined || val === '') continue;
    tableHtml += `<tr><td style="padding:6px 12px;color:var(--text3)">${LABELS[key] || key}</td><td style="padding:6px 12px;color:var(--text3)">${val}</td><td style="padding:6px 12px;color:var(--text3)">${val}</td></tr>`;
  }

  tableHtml += '</tbody>';
  document.getElementById('dupCompareTable').innerHTML = tableHtml;

  // Footer
  const totalFields = allKeys.filter((k) => ext[k] !== null && ext[k] !== undefined && ext[k] !== '').length;
  document.getElementById('dupModalFooter').innerHTML =
    diffs.length + ' of ' + totalFields + ' fields differ' + (diffs.length > 0 ? ' &mdash; possible rebill' : '');
}

function _toggleDupField(billIdx, fieldKey, useNew) {
  const dup = (window._pdfDupMap || {})[billIdx];
  if (!dup) return;
  dup.fieldSelections[fieldKey] = useNew;
  _renderDupModal(billIdx); // Re-render to update selection styling
}

function applyDupSelections() {
  const billIdx = window._dupModalIdx;
  const dup = (window._pdfDupMap || {})[billIdx];
  if (!dup) return;
  dup.action = 'field-select'; // Custom per-field action
  closeDupModal();
  // Re-render pills and fields to reflect the decision
  const bills = window._pdfMultiBills;
  const box = document.getElementById('pdfAIBox');
  if (bills && box) renderMultiBillUI(bills, box);
  showToast('Field selections saved for this bill');
}

function skipDupBill() {
  const billIdx = window._dupModalIdx;
  const dup = (window._pdfDupMap || {})[billIdx];
  if (!dup) return;
  dup.action = 'skip';
  closeDupModal();
  const bills = window._pdfMultiBills;
  const box = document.getElementById('pdfAIBox');
  if (bills && box) renderMultiBillUI(bills, box);
  showToast('Bill will be skipped on save');
}

// Per-bill Overwrite / Merge — execute immediately against the single bill the
// user is viewing, mirror of the "All" buttons but scoped to one dup. On success
// the dup is tagged `action: 'processed'` so Save All won't re-apply it.
async function overwriteDupBill() {
  const billIdx = window._dupModalIdx;
  const dup = (window._pdfDupMap || {})[billIdx];
  const bills = window._pdfMultiBills;
  if (!dup || !bills || !bills[billIdx]) return;
  dup.action = 'overwrite';
  closeDupModal();
  let ok = false;
  try {
    ok = await _applyDupUpdate(billIdx, bills[billIdx], dup);
  } catch (e) {
    ok = false;
  }
  if (ok) dup.action = 'processed';
  const box = document.getElementById('pdfAIBox');
  if (box) renderMultiBillUI(bills, box);
  const i = window._pdfMultiIdx || 0;
  const billWarnings = (window._pdfBillWarnings || [])[i]?.warnings || [];
  if (bills[i]) renderPDFFields(bills[i], billWarnings);
  showToast(ok ? 'Bill overwritten' : 'Overwrite failed — try again');
}

async function mergeDupBill() {
  const billIdx = window._dupModalIdx;
  const dup = (window._pdfDupMap || {})[billIdx];
  const bills = window._pdfMultiBills;
  if (!dup || !bills || !bills[billIdx]) return;
  dup.action = 'merge';
  closeDupModal();
  let ok = false;
  try {
    ok = await _applyDupUpdate(billIdx, bills[billIdx], dup);
  } catch (e) {
    ok = false;
  }
  if (ok) dup.action = 'processed';
  const box = document.getElementById('pdfAIBox');
  if (box) renderMultiBillUI(bills, box);
  const i = window._pdfMultiIdx || 0;
  const billWarnings = (window._pdfBillWarnings || [])[i]?.warnings || [];
  if (bills[i]) renderPDFFields(bills[i], billWarnings);
  showToast(ok ? 'Bill merged' : 'Merge failed — try again');
}

async function _viewDupPDF(billIdx) {
  const dup = (window._pdfDupMap || {})[billIdx];
  if (!dup || !dup.hasPDF) {
    showToast('No PDF stored for existing bill');
    return;
  }
  // Use existing viewSavedPDF infrastructure
  const pdfKey = dup.pdfKey;
  if (!pdfKey) {
    showToast('PDF key not found');
    return;
  }
  const data = await pdfRetrieve(pdfKey);
  if (!data) {
    showToast('PDF not found in storage');
    return;
  }
  // Open in new tab
  const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

function dumpCurrentBill() {
  const bill = window._pdfMultiBills && window._pdfMultiBills[window._pdfMultiIdx || 0];
  if (!bill) {
    showToast('No bill selected');
    return;
  }
  const json = JSON.stringify(bill, null, 2);
  localStorage.setItem('_claude_bill_dump', json);
  localStorage.setItem('_claude_bill_dump_ts', new Date().toISOString());
  showToast('Bill data dumped for Claude');
}
// Auto-dump: keep current bill in localStorage so Claude can read it
setInterval(() => {
  const bill = window._pdfMultiBills && window._pdfMultiBills[window._pdfMultiIdx || 0];
  if (bill) localStorage.setItem('_claude_bill_dump', JSON.stringify(bill));
}, 2000);

function savePDFDebug() {
  const raw = window._pdfRawText || '(no raw text)';
  const bills = window._pdfMultiBills || [];
  const srcFile = window._pdfSourceFileName || 'unknown';
  let output = '=== SOURCE FILE: ' + srcFile + ' ===\n';
  output += '=== EXTRACTION RESULTS (' + bills.length + ' bills) ===\n';
  for (let i = 0; i < bills.length; i++) {
    output +=
      '\n--- Bill ' +
      (i + 1) +
      ' of ' +
      bills.length +
      ' (' +
      ((bills[i] || {}).BillingPeriodStart || '?') +
      ' to ' +
      ((bills[i] || {}).BillingPeriodEnd || '?') +
      ') ---\n';
    output += JSON.stringify(bills[i] || {}, null, 2) + '\n';
  }
  // Include OCR pass scores if available
  const passScores = window._pdfPassScores || [];
  if (passScores.length) {
    output += '\n=== OCR PASS SCORES ===\n';
    output += 'Page | Pass       | Score | Time   | Chars | Error\n';
    output += '-----+------------+-------+--------+-------+------\n';
    for (const p of passScores) {
      output +=
        String(p.page).padStart(4) +
        ' | ' +
        (p.pass || '').padEnd(10) +
        ' | ' +
        String(p.score).padStart(5) +
        ' | ' +
        String(p.time).padStart(6) +
        ' | ' +
        String(p.chars).padStart(5) +
        (p.error ? ' | ' + p.error : '') +
        '\n';
    }
  }
  output += '\n=== RAW OCR TEXT ===\n' + raw;
  // Store in window for Playwright to retrieve
  const safeName = srcFile.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  const now = new Date();
  const ts =
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const debugFilename = 'ocr-debug_' + safeName + '_' + ts + '.txt';
  window._debugFileContent = output;
  window._debugFileName = debugFilename;
  // Save to Downloads as a file
  const blob = new Blob([output], { type: 'text/plain' });
  const a = document.createElement('a');
  const blobUrl = URL.createObjectURL(blob);
  a.href = blobUrl;
  a.download = debugFilename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
  showToast('Debug file saved to Downloads');
}
function togglePDFRawText() {
  const box = document.getElementById('pdfAIBox');
  const btn = document.getElementById('pdfDebugBtn');
  if (box._showingRaw) {
    box._showingRaw = false;
    btn.textContent = '🔍 Raw Text';
    if (window._pdfMultiBills) renderMultiBillUI(window._pdfMultiBills, box);
    else box.textContent = 'No extraction data.';
  } else {
    box._showingRaw = true;
    btn.textContent = '← Back';
    const text = window._pdfRawText || '(no raw text captured — try reloading the PDF)';
    const idx = window._pdfMultiIdx || 0;
    let validSections;
    // Non-Evergy PDFs use %%PAGE_N%% markers — split by those instead
    const hasPageMarkers = /%%PAGE_\d+%%/.test(text);
    if (hasPageMarkers) {
      const pageMarkers = [...text.matchAll(/%%PAGE_(\d+)%%/g)];
      const pages = [];
      for (let pi = 0; pi < pageMarkers.length; pi++) {
        const s = pageMarkers[pi].index;
        const e = pi + 1 < pageMarkers.length ? pageMarkers[pi + 1].index : text.length;
        pages.push(text.slice(s, e));
      }
      validSections = pages;
      // Multi-commodity pages produce multiple bills from one page.
      // Use _pageIndex from the extracted bills to find the right page.
      const bills = window._pdfMultiBills || [];
      const currentBill = bills[idx];
      var pageIdx = currentBill && currentBill._pageIndex ? currentBill._pageIndex - 1 : idx;
      if (pageIdx >= validSections.length) pageIdx = Math.min(idx, validSections.length - 1);
      var section = validSections[pageIdx] || validSections[0] || text;
      // #113: If bill has _pageStart/_pageEnd (multi-page range), show "Pages X-Y"
      // instead of "Page X of Y" for more accurate display (e.g. Louisburg multi-building PDFs)
      var label;
      if (currentBill && currentBill._pageStart != null && currentBill._pageEnd != null) {
        if (currentBill._pageStart === currentBill._pageEnd) {
          label = 'Page ' + currentBill._pageStart + ' of ' + validSections.length;
        } else {
          label =
            'Pages ' +
            currentBill._pageStart +
            '–' +
            currentBill._pageEnd +
            ' (PDF) · section ' +
            (pageIdx + 1) +
            ' of ' +
            validSections.length;
        }
      } else {
        label = 'Page ' + (pageIdx + 1) + ' of ' + validSections.length;
      }
    } else {
      const splitRe = new RegExp(
        '(?=(?:' +
          _EVG_BILLING_DETAILS.source +
          '|Billing[ \\t\\n\\r]+Details[ \\t\\n\\r]*[-\\u2013\\-][ \\t\\n\\r]*service[ \\t\\n\\r]+from))',
        'gi',
      );
      const raw = text.split(splitRe);
      const getDP = (s) => {
        const m =
          s.match(_EVG_SERVICE_FROM) ||
          s.match(/service\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/i);
        return m ? m[1] + '|' + m[2] : null;
      };
      const sections = [];
      for (const frag of raw) {
        const dates = getDP(frag);
        const isHdr = _EVG_BILLING_DETAILS.test(frag.trim()) || /^Billing\s+Details/i.test(frag.trim());
        if (!isHdr || !dates) {
          if (sections.length) sections[sections.length - 1] += frag;
          else sections.push(frag);
        } else if (sections.length && getDP(sections[sections.length - 1]) === dates) {
          sections[sections.length - 1] += frag;
        } else {
          sections.push(frag);
        }
      }
      validSections = sections.filter(
        (s) => _EVG_SERVICE_FROM.test(s) || /service\s+from[:\s]\s*\d{2}\/\d{2}\/\d{4}/i.test(s),
      );
      var section = validSections[idx] || validSections[0] || text;
      var label = 'Section ' + (idx + 1) + ' of ' + validSections.length;
    }
    box.innerHTML =
      '<div style="font-size:11px;color:var(--accent);margin-bottom:8px;font-weight:600">' +
      label +
      '</div><pre style="font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:var(--text2);margin:0">' +
      section.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '</pre>';
  }
}
// ── OCR image-preprocessing helpers ──────────────────────────────────────────
// rotateCanvas180: returns a new canvas that is the source rotated 180°.
// Used by the upside-down heuristic (CHANGE 4).
function rotateCanvas180(srcCanvas) {
  const dst = document.createElement('canvas');
  dst.width = srcCanvas.width;
  dst.height = srcCanvas.height;
  const ctx = dst.getContext('2d');
  ctx.translate(dst.width, dst.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(srcCanvas, 0, 0);
  return dst;
}
// binarizeCanvas: Otsu threshold → pure B/W.  Returns a new canvas.
// Used as a triggered extra pass for low-scoring pages (CHANGE 5).
function binarizeCanvas(srcCanvas) {
  const w = srcCanvas.width,
    h = srcCanvas.height;
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const srcCtx = srcCanvas.getContext('2d');
  const dstCtx = dst.getContext('2d');
  const imageData = srcCtx.getImageData(0, 0, w, h);
  const data = imageData.data;
  // Build grayscale histogram
  const hist = new Array(256).fill(0);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    gray[i] = v;
    hist[v]++;
  }
  // Otsu's method to find optimal threshold
  const total = w * h;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0,
    wB = 0,
    maxVar = 0,
    threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  // Apply threshold
  const out = dstCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i] > threshold ? 255 : 0;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  dstCtx.putImageData(out, 0, 0);
  return dst;
}
// _countOcrSignals: count digits + dollar signs in a string — used to score
// the upside-down orientation test (CHANGE 4).
function _countOcrSignals(txt) {
  return (txt.match(/[\d$]/g) || []).length;
}
// ── end OCR helpers ───────────────────────────────────────────────────────────
// Generous timeout wrapper for un-timed pdfjs awaits (getDocument/getPage/
// getTextContent/render are normally sub-second to low-single-digit seconds
// even at 4x scale) — a timeout here is treated as "this page/pass failed",
// not a fatal error, by the surrounding try/catch at each call site.
// Module-level (not nested in extractPDFText) so processPDF's separate
// OCR-retry block (a sibling function) can use it too.
const PDFJS_AWAIT_TIMEOUT_MS = 30000; // 30s
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error((label || 'operation') + ' timed out after ' + ms / 1000 + 's')), ms),
    ),
  ]);
}
// Module-level (not nested in extractPDFText) so processPDF's separate OCR-retry
// block (a sibling function, ~line 9509) can call recognizeWithTimeout too —
// same reasoning as _withTimeout/PDFJS_AWAIT_TIMEOUT_MS above. See a00af2f4:
// recognizeWithTimeout used to be a const local to extractPDFText, so processPDF's
// retry block threw "recognizeWithTimeout is not defined" every time it ran; the
// generic catch around the call swallowed the ReferenceError identically to a real
// OCR failure, so the 3x/3.5x/4x retry-scale enhancement silently did nothing.
// Timeout for individual recognize() calls (90 seconds) — prevents Tesseract hangs
const OCR_TIMEOUT_MS = 90000;
// Wall-clock cap across ALL pages/passes for one OCR phase — prevents an
// unbounded worst case (many pages x many passes) from hanging forever.
const OCR_TOTAL_BUDGET_MS = 4 * 60 * 1000; // 4 min
// Helper to create a fresh worker with correct params.
// Dictionary params are init-only — must go in createWorker's 4th arg, not setParameters.
const _createOCRWorker = async (loggerCb) => {
  const w = await Tesseract.createWorker(
    'eng',
    1,
    { logger: loggerCb || (() => {}) },
    { load_system_dawg: '0', load_freq_dawg: '0' },
  );
  await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
  return w;
};
// Budget-window start time for recognizeWithTimeout's OCR_TOTAL_BUDGET_MS check.
// Module-level `let` (not a const closed over by one function) so both
// extractPDFText's own OCR pass loop and processPDF's separate OCR-retry block
// can each stamp their own fresh budget window right before they start OCR'ing —
// the two phases run strictly sequentially per file (processPDF awaits
// extractPDFText to fully finish before its retry block begins, never
// concurrently), so a single shared mutable variable reassigned per-phase is
// equivalent to each phase having its own local budget clock, with no race risk.
let _ocrStartTime = 0;
// On timeout: terminate the hung worker and create a fresh one.
// Returns { result, newWorker } — newWorker is set only if the worker was replaced.
const recognizeWithTimeout = async (w, canvas, params) => {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, OCR_TIMEOUT_MS);
  let abortPoll = null;
  const abortPromise = new Promise((_, reject) => {
    abortPoll = setInterval(() => {
      if (window._pdfAbort) reject(Object.assign(new Error('Aborted by user'), { _aborted: true }));
      // Overshoot fix (70096fe4 review): OCR_TOTAL_BUDGET_MS checkpoints only run
      // BETWEEN awaits, so they can't stop a recognize() call already in flight —
      // a budget trip mid-call could previously overshoot the plan's "budget+30s"
      // gate-(a) tolerance by up to the full 90s OCR_TIMEOUT_MS. Reuse this same
      // 250ms poll (already proven safe for abort) so a budget trip interrupts an
      // in-flight recognize() just as promptly as a user Cancel does.
      else if (performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS)
        reject(Object.assign(new Error('OCR budget exceeded mid-recognize'), { _budgetExceeded: true }));
    }, 250); // poll every 250ms — cheap, imperceptible worst-case delay to Cancel/budget
  });
  try {
    const result = await Promise.race([
      w.recognize(canvas, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout after 90s')), OCR_TIMEOUT_MS)),
      abortPromise,
    ]);
    clearTimeout(timer);
    clearInterval(abortPoll);
    return { result, newWorker: null };
  } catch (err) {
    clearTimeout(timer);
    clearInterval(abortPoll);
    if (err._aborted) throw err; // let caller distinguish abort from a real timeout/failure
    if (timedOut) {
      // Kill the hung worker — its queued recognize() call will never finish
      try {
        await w.terminate();
      } catch (_) {}
      // Create a fresh worker so the next call starts clean
      const fresh = await _createOCRWorker();
      throw Object.assign(err, { _replacementWorker: fresh });
    }
    throw err;
  }
};
async function extractPDFText(ab, statusCb) {
  let pdf = null;
  try {
    if (typeof pdfjsLib === 'undefined') return null;
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    pdf = await _withTimeout(
      pdfjsLib.getDocument({
        data: ab,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise,
      PDFJS_AWAIT_TIMEOUT_MS,
      'getDocument',
    );
    const maxPages = Math.min(pdf.numPages, 200);

    // ── Step 1: extract native text per page, track which pages have no text ──
    const pageTexts = [];
    const ocrNeeded = [];
    for (let i = 1; i <= maxPages; i++) {
      if (statusCb) statusCb('Reading page ' + i + ' of ' + maxPages + '...');
      let pg, c;
      try {
        pg = await _withTimeout(pdf.getPage(i), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + i + ')');
        c = await _withTimeout(pg.getTextContent(), PDFJS_AWAIT_TIMEOUT_MS, 'getTextContent(' + i + ')');
      } catch (stepErr) {
        // A hung/failed native-text read is treated the same as "this page needs OCR",
        // not a fatal error — one bad page shouldn't abort the whole extraction.
        pageTexts.push('');
        ocrNeeded.push(i);
        continue;
      }
      const items = c.items.filter((s) => s.str && s.str.trim());
      if (!items.length) {
        pageTexts.push('');
        ocrNeeded.push(i);
        continue;
      }
      items.sort((a, b) => {
        const dy = b.transform[5] - a.transform[5];
        return Math.abs(dy) > 2 ? dy : a.transform[4] - b.transform[4];
      });
      let pageLines = [],
        curY = null,
        curLine = [];
      for (const item of items) {
        const y = Math.round(item.transform[5]);
        if (curY === null || Math.abs(y - curY) > 2) {
          if (curLine.length) pageLines.push(curLine.join(' '));
          curLine = [item.str];
          curY = y;
        } else {
          curLine.push(item.str);
        }
      }
      if (curLine.length) pageLines.push(curLine.join(' '));
      const pageTxt = pageLines.join('\n');
      pageTexts.push(pageTxt);
      // If page has very little text (<40 chars), it's likely a scanned image page
      if (pageTxt.trim().length < 40) ocrNeeded.push(i);
    }

    // ── Step 2: OCR any pages that had no/little native text ──
    if (ocrNeeded.length > 0 && typeof Tesseract !== 'undefined') {
      if (statusCb)
        statusCb(
          'Found ' +
            ocrNeeded.length +
            ' scanned page' +
            (ocrNeeded.length > 1 ? 's' : '') +
            ' — loading OCR engine...',
        );
      let worker = null;
      try {
        // Dictionary params (load_system_dawg/load_freq_dawg) are init-only and MUST be passed
        // in createWorker's 4th arg. Setting them via setParameters is silently ignored by Tesseract.
        worker = await Tesseract.createWorker(
          'eng',
          1,
          {
            logger: (m) => {
              if (statusCb) {
                if (m.status === 'loading tesseract core') statusCb('Loading OCR engine...');
                else if (m.status === 'loading language traineddata') statusCb('Loading English language data...');
              }
            },
          },
          {
            load_system_dawg: '0',
            load_freq_dawg: '0',
          },
        );
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
        });
      } catch (workerErr) {
        if (statusCb) statusCb('OCR engine failed to load: ' + workerErr.message);
        // Return whatever native text we got
        return pageTexts.join('\n').trim().length > 50 ? pageTexts.join('\n') : null;
      }
      // F5: ensure the worker WASM heap is freed even if the OCR loop throws
      try {
        // Provider-aware scoring: per-provider signal sets + generic bonuses.
        // Evergy signals are the original BILL_SIGNALS verbatim — behavior unchanged.
        // Unknown providers fall through to generic-only scoring (never worse than before).
        const PROVIDER_SIGNALS = {
          evergy: [
            { rx: /service\s+from[:\s]\s*\d{2}\/\d{2}/i, w: 1 },
            { rx: /Current\s+Charges/i, w: 1 },
            { rx: /kWh/i, w: 1 },
            { rx: /Demand\s+Ch/i, w: 1 },
            { rx: /Customer\s+Ch/i, w: 1 },
            { rx: /Account\s+Number/i, w: 1 },
            { rx: /Billing\s+Date/i, w: 1 },
          ],
          constellation: [
            { rx: /constellation/i, w: 1 },
            { rx: /account\s*id:\s*bg-\d+/i, w: 2 },
            { rx: /Invoice\s+Number:\s*\d+/i, w: 1 },
            { rx: /Service\s+for\s+[A-Za-z]+-\d{4}/i, w: 2 },
            { rx: /Total\s+Current\s+Site\s+Charges/i, w: 2 },
            { rx: /MMBtu/i, w: 1 },
            { rx: /Invoice\s+Date:/i, w: 1 },
          ],
          kgs: [
            { rx: /kansas\s+gas\s+service/i, w: 2 },
            { rx: /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i, w: 2 },
            { rx: /\d{2}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}/, w: 2 },
            { rx: /Account\s+Number/i, w: 1 },
            { rx: /\bMcf\b/i, w: 1 },
            { rx: /Total\s+Current\s+Charges/i, w: 1 },
            { rx: /Service\s+Charge/i, w: 1 },
          ],
          louisburg: [
            { rx: /louisburgkansas\.gov|City\s*of\s*Louisburg/i, w: 2 },
            { rx: /ACCOUNT\s*SUMMARY|Customer\s*Account\s*Information/i, w: 2 },
            { rx: /DETACH\s*AND\s*RETURN/i, w: 1 },
            { rx: /Amount\s*Due\s*After/i, w: 1 },
          ],
          baldwin: [
            { rx: /baldwin\s*city|baldwincitygov?/i, w: 2 },
            { rx: /FRANCHISE\s+FEE/i, w: 1 },
            { rx: /EL\s*-\s*ELECTRIC|WA\s*-?\s*WATER|SW\s*-?\s*SEWER/i, w: 2 },
            { rx: /ACCOUNT\s+NUMBER/i, w: 1 },
          ],
          propane: [
            { rx: /\bpropane\b|\blp\s*gas\b|\bfuel\s*oil\b|\bmfa\s*oil\b/i, w: 2 },
            { rx: /net\s*(?:due|delivery)|invoice/i, w: 1 },
            { rx: /Invoice\s*#/i, w: 1 },
          ],
        };
        // Auto-detect provider from OCR text (same regexes as UTILITY_RULES.detect() in energy-savings.js)
        const _detectProvider = (txt) => {
          if (/service\s+from[:\s]\s*\d{2}\/\d{2}/i.test(txt) || (/Customer\s+Ch/i.test(txt) && /ECA\s+Ch/i.test(txt)))
            return 'evergy';
          if (/constellation/i.test(txt) || /account\s*id:\s*bg-\d+/i.test(txt) || /MMBtu/i.test(txt))
            return 'constellation';
          if (/kansas\s+gas\s+service/i.test(txt) || /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(txt)) return 'kgs';
          if (/louisburgkansas\.gov|City\s*of\s*Louisburg/i.test(txt)) return 'louisburg';
          if (/baldwin\s*city|baldwincitygov/i.test(txt) || /FRANCHISE\s+FEE/i.test(txt)) return 'baldwin';
          if (/\bpropane\b|\blp\s*gas\b|\bmfa\s*oil\b/i.test(txt)) return 'propane';
          return 'generic';
        };
        // Generic signals — always score regardless of provider (floor for unknown formats)
        const GENERIC_SIGNALS = [
          { rx: /Account\s+Number/i, w: 1 },
          { rx: /Billing\s+Date/i, w: 1 },
        ];
        // Generic bonuses — dollar amounts, kWh values, date patterns (preserved from original scorePage)
        const _genericBonuses = (txt) => {
          let s = 0;
          const dollarAmts = (txt.match(/\$[\d,]+\.\d{2}/g) || []).length;
          s += Math.min(dollarAmts / 5, 2); // up to 2 bonus points (same as original)
          const kwhVals = (txt.match(/[\d,]+\.\d{4}\s*kWh/gi) || []).length;
          s += Math.min(kwhVals / 3, 1); // up to 1 bonus point (same as original)
          const datePatterns = (txt.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g) || []).length;
          s += Math.min(datePatterns / 4, 1); // up to 1 bonus for generic date signals
          return s;
        };
        // makeScorePage() — factory that returns a scorePage function.
        // Provider is auto-detected from the first non-trivial pass (>100 chars) and locked
        // for all subsequent passes of the same page, so pass-0 text drives scoring for passes 1–6.
        // Evergy: max keyword score = 7 + up to 3 bonuses = 10+, early-exit threshold >=10 unchanged.
        const makeScorePage = () => {
          let detectedProvider = null;
          return (txt) => {
            if (!detectedProvider && txt.length > 100) {
              detectedProvider = _detectProvider(txt);
            }
            const signals = PROVIDER_SIGNALS[detectedProvider] || [];
            let s = 0;
            for (const sig of signals) {
              if (sig.rx.test(txt)) s += sig.w;
            }
            for (const sig of GENERIC_SIGNALS) {
              if (sig.rx.test(txt)) s += sig.w;
            }
            s += _genericBonuses(txt);
            return s;
          };
        };
        const scorePage = makeScorePage();
        // Detect Evergy bill cover page by unique layout signals. Cover pages only
        // need the 2.5x pass — they contain no meter/charge data worth reprocessing.
        const isCoverPage = (txt) => {
          let hits = 0;
          if (/MESSAGE\s+BOARD/i.test(txt)) hits++;
          if (/Account\s+Summary/i.test(txt)) hits++;
          if (/Due\s+Upon\s+Receipt/i.test(txt)) hits++;
          if (/Page\s+1\s+of\s+\d/i.test(txt)) hits++;
          if (/\d{37}/.test(txt)) hits++;
          return hits >= 3;
        };
        // OCR settings: dictionary disabled at worker init (load_system_dawg/load_freq_dawg=0)
        // and preserve_interword_spaces set via setParameters above.
        // Primary passes — 2.5x and 3.5x run first (historically best scores); 2x and 3x
        // only run if the first two don't reach a good score.
        // PSM-4 (SINGLE_COLUMN) variants are appended after the default passes; scorePage
        // picks the winner, so this is self-selecting and cannot regress bills that already parse.
        const OCR_PASSES = [
          { scale: 2.5, psm: null, label: '2.5x' },
          { scale: 3.5, psm: null, label: '3.5x' },
          { scale: 2.0, psm: null, label: '2x' },
          { scale: 3.0, psm: null, label: '3x' },
          { scale: 2.5, psm: '4', label: '2.5x-psm4' },
          { scale: 3.5, psm: '4', label: '3.5x-psm4' },
        ];
        // Retry passes — only run if primary passes have issues (low score or missing values)
        const OCR_RETRY_PASSES = [
          { scale: 1.0, psm: null, label: '1x retry' },
          { scale: 1.5, psm: null, label: '1.5x retry' },
          { scale: 4.0, psm: null, label: '4x retry' },
        ];
        // OCR_TIMEOUT_MS, OCR_TOTAL_BUDGET_MS, _createOCRWorker, and recognizeWithTimeout
        // are module-level now (see above extractPDFText's function boundary) so
        // processPDF's OCR-retry block can call recognizeWithTimeout too — a00af2f4.
        // Track pass scores for debug output
        const passScoreLog = [];

        // Store all OCR pass texts for consensus re-extraction on mismatched values
        const allPassTexts = {};
        // Stamp the module-level budget-window start for this OCR phase (see the
        // `let _ocrStartTime` declaration above extractPDFText for why this is a
        // reassignment, not a fresh const).
        _ocrStartTime = performance.now();
        let _ocrBudgetExceeded = false;
        for (let idx = 0; idx < ocrNeeded.length; idx++) {
          if (window._pdfAbort) break; // Bug #134: honour cancel inside OCR page loop
          if (!_ocrBudgetExceeded && performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS) {
            _ocrBudgetExceeded = true;
          }
          if (_ocrBudgetExceeded) break;
          const pgNum = ocrNeeded[idx];
          let bestText = '',
            bestScore = 0;
          allPassTexts[pgNum] = [];

          for (let pass = 0; pass < OCR_PASSES.length; pass++) {
            if (window._pdfAbort) break; // Bug #134: honour cancel inside OCR pass loop
            if (!_ocrBudgetExceeded && performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS) {
              _ocrBudgetExceeded = true;
            }
            if (_ocrBudgetExceeded) break;
            const cfg = OCR_PASSES[pass];
            if (statusCb)
              statusCb(
                'OCR page ' +
                  pgNum +
                  '/' +
                  maxPages +
                  ' (' +
                  (idx + 1) +
                  '/' +
                  ocrNeeded.length +
                  ') — pass ' +
                  (pass + 1) +
                  '/' +
                  OCR_PASSES.length +
                  ' (' +
                  cfg.label +
                  ')...',
              );
            let pg, vp, canvas, ctx;
            try {
              pg = await _withTimeout(pdf.getPage(pgNum), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + pgNum + ')');
              vp = pg.getViewport({ scale: cfg.scale });
              canvas = document.createElement('canvas');
              canvas.width = vp.width;
              canvas.height = vp.height;
              ctx = canvas.getContext('2d');
              await _withTimeout(
                pg.render({ canvasContext: ctx, viewport: vp }).promise,
                PDFJS_AWAIT_TIMEOUT_MS,
                'render(' + pgNum + ')',
              );
              const params = cfg.psm ? { tessedit_pageseg_mode: cfg.psm, rotateAuto: true } : { rotateAuto: true };
              const t0 = performance.now();
              const { result: ocrResult } = await recognizeWithTimeout(worker, canvas, params);
              const text = ocrResult.data.text;
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              const score = scorePage(text);
              allPassTexts[pgNum].push({ scale: cfg.scale, label: cfg.label, text, score });
              passScoreLog.push({
                page: pgNum,
                pass: cfg.label,
                score: score.toFixed(1),
                time: elapsed + 's',
                chars: text.length,
              });
              if (score > bestScore || (score === bestScore && text.length > bestText.length)) {
                bestText = text;
                bestScore = score;
              }
            } catch (pageErr) {
              if (pageErr._aborted || pageErr._budgetExceeded) {
                // Overshoot fix: a budget trip mid-recognize is handled exactly like an
                // abort — stop this page's passes immediately rather than falling through
                // to "log as failed pass, try the next one" (which would keep burning time).
                if (pageErr._budgetExceeded) _ocrBudgetExceeded = true;
                if (canvas) {
                  canvas.width = 0;
                  canvas.height = 0;
                }
                if (pg && pg.cleanup) pg.cleanup();
                break;
              }
              // If timeout killed the worker, swap in the fresh replacement
              if (pageErr._replacementWorker) worker = pageErr._replacementWorker;
              passScoreLog.push({
                page: pgNum,
                pass: cfg.label,
                score: 'FAIL',
                time: '—',
                chars: 0,
                error: pageErr.message,
              });
              if (statusCb) statusCb('OCR failed on page ' + pgNum + ' pass ' + (pass + 1) + ': ' + pageErr.message);
            }
            // F2: release canvas backing store and PDF page operator list after each pass
            if (canvas) {
              canvas.width = 0;
              canvas.height = 0;
              canvas = null;
            }
            ctx = null;
            if (pg && pg.cleanup) pg.cleanup();
            // Early exit after pass 0 (2.5x) if this is a cover page — no meter data to gain from more passes
            if (pass === 0 && isCoverPage(bestText)) break;
            // Early exit after pass 1 (3.5x) if 2.5x + 3.5x already hit a strong score
            if (pass === 1 && bestScore >= 10) break;
            // Baldwin early exit at pass 1: scanned Baldwin pages have a lower max score ceiling than Evergy;
            // score >= 7 after 2 passes means account number + charge codes + dollar amounts are all present —
            // no benefit from running 4 more primary passes on a well-scanned page
            if (
              pass === 1 &&
              bestScore >= 7 &&
              (/baldwin\s*city|baldwincitygov/i.test(bestText) || /FRANCHISE\s+FEE/i.test(bestText))
            )
              break;
          }
          // Run retry passes if primary results have issues (low score or missing key patterns)
          // KGS bills never have a "service from" pattern — don't require it for retry decision
          const isKGSText =
            /kansas\s+gas\s+service/i.test(bestText) || /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(bestText);
          const kgsScore = isKGSText
            ? (/Account\s+Number/i.test(bestText) ? 2 : 0) +
              (/\$\d+\.\d{2}/.test(bestText) ? 2 : 0) +
              (/\d{2}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}/.test(bestText) ? 2 : 0)
            : 0;
          // Baldwin bills never have a "service from MM/DD" pattern — don't require it for retry decision
          // Use a content-quality score instead: account number + dollar amounts + charge-line codes
          const isBaldwinText = /baldwin\s*city|baldwincitygov/i.test(bestText) || /FRANCHISE\s+FEE/i.test(bestText);
          const baldwinScore = isBaldwinText
            ? (/ACCOUNT\s+NUMBER/i.test(bestText) ? 2 : 0) +
              ((bestText.match(/\$[\d,]+\.\d{2}/g) || []).length >= 3 ? 2 : 0) +
              (/EL\s*-\s*ELECTRIC|WA\s*-?\s*WATER|SW\s*-?\s*SEWER/i.test(bestText) ? 2 : 0)
            : 0;
          const needsRetry = isKGSText
            ? kgsScore < 4 // KGS: retry only if account+dollar+meter dates all missing
            : isBaldwinText
              ? baldwinScore < 4 // Baldwin: retry only if account+dollar amounts+charge codes all missing
              : bestScore < 5 || !/service\s+from[:\s]\s*\d/i.test(bestText) || !/\$[\d,]+\.\d{2}/g.test(bestText);
          if (needsRetry) {
            for (let pass = 0; pass < OCR_RETRY_PASSES.length; pass++) {
              if (window._pdfAbort) break; // Bug #134: honour cancel inside retry pass loop
              if (!_ocrBudgetExceeded && performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS) {
                _ocrBudgetExceeded = true;
              }
              if (_ocrBudgetExceeded) break;
              const cfg = OCR_RETRY_PASSES[pass];
              if (statusCb)
                statusCb(
                  'OCR page ' +
                    pgNum +
                    '/' +
                    maxPages +
                    ' retry ' +
                    (pass + 1) +
                    '/' +
                    OCR_RETRY_PASSES.length +
                    ' (' +
                    cfg.label +
                    ')...',
                );
              let pg, vp, canvas, ctx;
              try {
                pg = await _withTimeout(pdf.getPage(pgNum), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + pgNum + ')');
                vp = pg.getViewport({ scale: cfg.scale });
                canvas = document.createElement('canvas');
                canvas.width = vp.width;
                canvas.height = vp.height;
                ctx = canvas.getContext('2d');
                await _withTimeout(
                  pg.render({ canvasContext: ctx, viewport: vp }).promise,
                  PDFJS_AWAIT_TIMEOUT_MS,
                  'render(' + pgNum + ')',
                );
                const params = cfg.psm ? { tessedit_pageseg_mode: cfg.psm, rotateAuto: true } : { rotateAuto: true };
                const t0 = performance.now();
                const { result: ocrResult } = await recognizeWithTimeout(worker, canvas, params);
                const text = ocrResult.data.text;
                const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
                const score = scorePage(text);
                allPassTexts[pgNum].push({ scale: cfg.scale, label: cfg.label, text, score });
                passScoreLog.push({
                  page: pgNum,
                  pass: cfg.label,
                  score: score.toFixed(1),
                  time: elapsed + 's',
                  chars: text.length,
                });
                if (score > bestScore || (score === bestScore && text.length > bestText.length)) {
                  bestText = text;
                  bestScore = score;
                }
              } catch (pageErr) {
                if (pageErr._aborted || pageErr._budgetExceeded) {
                  // Overshoot fix: same immediate-stop treatment as the primary pass loop.
                  if (pageErr._budgetExceeded) _ocrBudgetExceeded = true;
                  if (canvas) {
                    canvas.width = 0;
                    canvas.height = 0;
                  }
                  if (pg && pg.cleanup) pg.cleanup();
                  break;
                }
                if (pageErr._replacementWorker) worker = pageErr._replacementWorker;
                passScoreLog.push({
                  page: pgNum,
                  pass: cfg.label,
                  score: 'FAIL',
                  time: '—',
                  chars: 0,
                  error: pageErr.message,
                });
                if (statusCb)
                  statusCb('OCR retry failed on page ' + pgNum + ' (' + cfg.label + '): ' + pageErr.message);
              }
              // F2: release canvas backing store and PDF page operator list after each retry pass
              if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
                canvas = null;
              }
              ctx = null;
              if (pg && pg.cleanup) pg.cleanup();
            }
          }
          // ── CHANGE 4: 180° upside-down heuristic ──────────────────────────────
          // Only fires when primary+retry passes all scored very low (<3).
          // Renders the page at 2.5x, crops a small strip from the top, and
          // runs a quick recognize at 0° vs 180°.  If the rotated crop yields
          // significantly more digits/dollar-signs, we rotate the full canvas
          // 180° and run a full OCR pass to replace the best result.
          const ORIENT_SCORE_THRESHOLD = 3;
          // Bug #134 / budget: neither was checked here before — a Cancel click or an
          // exceeded budget wouldn't stop this refinement pass until the outer page loop's
          // next iteration. Check immediately before spending more OCR time on this page.
          // Commit bestText-so-far before any early break here — otherwise a budget/abort
          // trip at this exact checkpoint would silently discard this page's already-
          // completed primary+retry OCR passes (the loop's normal end-of-iteration commit,
          // a few lines down, would never run). Partial-results policy: keep pages already
          // OCR'd, never throw away work that already succeeded.
          if (window._pdfAbort) {
            pageTexts[pgNum - 1] = bestText;
            break;
          }
          if (!_ocrBudgetExceeded && performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS) {
            _ocrBudgetExceeded = true;
          }
          if (_ocrBudgetExceeded) {
            pageTexts[pgNum - 1] = bestText;
            break;
          }
          if (bestScore < ORIENT_SCORE_THRESHOLD) {
            let pgO, canvasO, canvas180;
            try {
              if (statusCb) statusCb('OCR page ' + pgNum + '/' + maxPages + ' — orientation check...');
              pgO = await _withTimeout(pdf.getPage(pgNum), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + pgNum + ')');
              const vpO = pgO.getViewport({ scale: 2.5 });
              canvasO = document.createElement('canvas');
              canvasO.width = vpO.width;
              canvasO.height = vpO.height;
              const ctxO = canvasO.getContext('2d');
              await _withTimeout(
                pgO.render({ canvasContext: ctxO, viewport: vpO }).promise,
                PDFJS_AWAIT_TIMEOUT_MS,
                'render(' + pgNum + ')',
              );
              // Crop top 20% strip for a fast orientation probe
              const cropH = Math.max(1, Math.floor(canvasO.height * 0.2));
              const cropRect = { left: 0, top: 0, width: canvasO.width, height: cropH };
              canvas180 = rotateCanvas180(canvasO);
              // Quick probe: recognize top strip at both orientations
              const [probe0, probe180] = await Promise.all([
                recognizeWithTimeout(worker, canvasO, { rotateAuto: false, rectangle: cropRect }).catch(() => ({
                  result: { data: { text: '' } },
                })),
                recognizeWithTimeout(worker, canvas180, { rotateAuto: false, rectangle: cropRect }).catch(() => ({
                  result: { data: { text: '' } },
                })),
              ]);
              const sig0 = _countOcrSignals(probe0.result.data.text);
              const sig180 = _countOcrSignals(probe180.result.data.text);
              if (sig180 > sig0 * 1.5 + 3) {
                // 180° clearly wins — run full OCR on the rotated canvas
                if (statusCb) statusCb('OCR page ' + pgNum + '/' + maxPages + ' — rotating 180° and re-OCR...');
                const { result: rotResult } = await recognizeWithTimeout(worker, canvas180, { rotateAuto: true });
                const rotText = rotResult.data.text;
                const rotScore = scorePage(rotText);
                allPassTexts[pgNum].push({ scale: 2.5, label: '2.5x-rot180', text: rotText, score: rotScore });
                passScoreLog.push({
                  page: pgNum,
                  pass: '2.5x-rot180',
                  score: rotScore.toFixed(1),
                  time: '—',
                  chars: rotText.length,
                });
                if (rotScore > bestScore || (rotScore === bestScore && rotText.length > bestText.length)) {
                  bestText = rotText;
                  bestScore = rotScore;
                }
              }
            } catch (_orientErr) {
              /* orientation probe failed — continue with existing best */
            } finally {
              // F2: release orientation canvases and PDF page after all orient OCR is done
              if (canvasO) {
                canvasO.width = 0;
                canvasO.height = 0;
              }
              if (canvas180) {
                canvas180.width = 0;
                canvas180.height = 0;
              }
              if (pgO && pgO.cleanup) pgO.cleanup();
            }
          }
          // ── CHANGE 5: Otsu binarization triggered pass ────────────────────────
          // Only fires when bestScore is still low after all passes including the
          // orientation check.  Re-renders at 2.5x, binarizes via Otsu threshold,
          // and OCRs the B/W image.  Kept only if it scores higher than current best.
          const BINARIZE_SCORE_THRESHOLD = 5;
          // Bug #134 / budget: same missing-checkpoint fix as the orientation block above,
          // including committing bestText-so-far before breaking (same reasoning).
          if (window._pdfAbort) {
            pageTexts[pgNum - 1] = bestText;
            break;
          }
          if (!_ocrBudgetExceeded && performance.now() - _ocrStartTime > OCR_TOTAL_BUDGET_MS) {
            _ocrBudgetExceeded = true;
          }
          if (_ocrBudgetExceeded) {
            pageTexts[pgNum - 1] = bestText;
            break;
          }
          if (bestScore < BINARIZE_SCORE_THRESHOLD) {
            let pgB, canvasB, binCanvas;
            try {
              if (statusCb) statusCb('OCR page ' + pgNum + '/' + maxPages + ' — binarize pass...');
              pgB = await _withTimeout(pdf.getPage(pgNum), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + pgNum + ')');
              const vpB = pgB.getViewport({ scale: 2.5 });
              canvasB = document.createElement('canvas');
              canvasB.width = vpB.width;
              canvasB.height = vpB.height;
              const ctxB = canvasB.getContext('2d');
              await _withTimeout(
                pgB.render({ canvasContext: ctxB, viewport: vpB }).promise,
                PDFJS_AWAIT_TIMEOUT_MS,
                'render(' + pgNum + ')',
              );
              binCanvas = binarizeCanvas(canvasB);
              const { result: binResult } = await recognizeWithTimeout(worker, binCanvas, { rotateAuto: true });
              const binText = binResult.data.text;
              const binScore = scorePage(binText);
              allPassTexts[pgNum].push({ scale: 2.5, label: '2.5x-otsu', text: binText, score: binScore });
              passScoreLog.push({
                page: pgNum,
                pass: '2.5x-otsu',
                score: binScore.toFixed(1),
                time: '—',
                chars: binText.length,
              });
              if (binScore > bestScore || (binScore === bestScore && binText.length > bestText.length)) {
                bestText = binText;
                bestScore = binScore;
              }
            } catch (_binErr) {
              /* binarize pass failed — continue with existing best */
            } finally {
              // F2: release binarize canvases and PDF page after OCR is done
              if (canvasB) {
                canvasB.width = 0;
                canvasB.height = 0;
              }
              if (binCanvas) {
                binCanvas.width = 0;
                binCanvas.height = 0;
              }
              if (pgB && pgB.cleanup) pgB.cleanup();
            }
          }
          // ── end triggered passes ───────────────────────────────────────────────
          pageTexts[pgNum - 1] = bestText;
          // ── Empty-page detection: if ALL passes returned near-empty text, flag it ──
          // A silent empty page causes the billing period on that page to be silently
          // dropped (extractAll finds no dates → no bill record emitted). We track
          // empty pages so processPDF can surface an explicit warning to the user.
          const EMPTY_PAGE_MAX_CHARS = 30; // Tesseract returns at minimum whitespace/newlines
          if (bestText.trim().length <= EMPTY_PAGE_MAX_CHARS) {
            if (!window._pdfOcrEmptyPages) window._pdfOcrEmptyPages = [];
            window._pdfOcrEmptyPages.push(pgNum);
          }
        }
        // Loud-failure signal (subtask 4): consumed once by the caller (processPDF /
        // _extractSingleFileForQueue), same convention as window._pdfOcrEmptyPages.
        window._pdfOcrBudgetExceeded = _ocrBudgetExceeded
          ? { pagesRead: new Set(passScoreLog.map((p) => p.page)).size, pagesTotal: ocrNeeded.length }
          : null;
        // Save all pass texts for consensus re-extraction
        window._pdfOcrPasses = allPassTexts;
        // Save pass score log for debug output
        window._pdfPassScores = passScoreLog;
      } finally {
        // F5: terminate worker even if an error was thrown mid-loop
        if (worker) {
          try {
            await worker.terminate();
          } catch (_) {}
          worker = null;
        }
      }
    }

    // Insert page markers so extractAll can track page ranges per bill
    const fullText = pageTexts.map((t, i) => '%%PAGE_' + (i + 1) + '%%\n' + t).join('\n');
    return fullText.trim().length > 50 ? fullText : null;
  } catch (e) {
    if (statusCb) statusCb('PDF read error: ' + e.message);
    console.error('PDF extract error:', e);
    return null;
  } finally {
    // F1: always destroy the PDF document to release PDF.js page bitmaps and font data
    if (pdf && pdf.destroy) {
      try {
        await pdf.destroy();
      } catch (_) {}
    }
    pdf = null;
  }
}
function showExtractionBadge(method, detail) {
  const b = document.getElementById('extractMethodBadge');
  b.style.display = 'inline-flex';
  b.style.alignItems = 'center';
  b.style.gap = '6px';
  let lbl = b.querySelector('.eb-label');
  if (!lbl) {
    lbl = document.createElement('span');
    lbl.className = 'eb-label';
    b.prepend(lbl);
  }
  if (method === 'rules') {
    b.style.background = 'rgba(var(--em-rgb),.12)';
    b.style.color = 'var(--em)';
    b.style.border = '1px solid rgba(var(--em-rgb),.25)';
    lbl.textContent = '⚡ Rule-Based' + (detail ? ' · ' + detail : '');
  } else {
    b.style.background = 'rgba(139,92,246,.12)';
    b.style.color = '#a78bfa';
    b.style.border = '1px solid rgba(139,92,246,.25)';
    lbl.textContent = '📄 Text Extraction';
  }
}
let pdfType = 'utility',
  pdfB64 = null;
function setPDFType(t, el) {
  pdfType = t;
  document.querySelectorAll('.ptpill').forEach((b) => b.classList.remove('sel'));
  el.classList.add('sel');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag');
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf');
  if (files.length === 0) return;
  // Only append to a queue that is actively running; done/cancelled queues
  // start fresh so previous results are not mixed with the new batch.
  const _dq = window._pdfQueue;
  if (_dq && _dq.status === 'running') {
    appendToQueue(files);
  } else if (files.length === 1) {
    processPDF(files[0]);
  } else {
    startQueueExtraction(files);
  }
}
function handlePDFUpload(e) {
  const files = Array.from(e.target.files).filter((f) => f.type === 'application/pdf');
  if (files.length === 0) return;
  // Only append to a queue that is actively running; done/cancelled queues
  // start fresh so previous results are not mixed with the new batch.
  const _uq = window._pdfQueue;
  if (_uq && _uq.status === 'running') {
    appendToQueue(files);
  } else if (files.length === 1) {
    processPDF(files[0]);
  } else {
    startQueueExtraction(files);
  }
}
// ── Global background task indicator ──
let _globalTaskView = null; // which view to navigate to when clicked
function globalTaskShow(label, targetView) {
  _globalTaskView = targetView || null;
  const el = document.getElementById('globalTaskStatus');
  const lbl = document.getElementById('globalTaskLabel');
  if (el) {
    el.style.display = 'flex';
    if (lbl) lbl.textContent = label;
  }
}
function globalTaskUpdate(label) {
  const lbl = document.getElementById('globalTaskLabel');
  if (lbl) lbl.textContent = label;
}
function globalTaskDone() {
  const el = document.getElementById('globalTaskStatus');
  if (el) el.style.display = 'none';
  _globalTaskView = null;
}
function globalTaskGoTo() {
  if (_globalTaskView) sv(_globalTaskView);
}

// ── Unmatched-page surfacing (P1 bug fix) ──
// Convert the _unmatchedPages array produced by extractAll into synthetic
// bill objects so they appear in the results instead of being silently dropped.
// Each entry gets _manualReview:true so the UI can flag it distinctly.
function _unmatchedToSyntheticBills(unmatchedPages) {
  if (!unmatchedPages || !unmatchedPages.length) return [];
  return unmatchedPages.map((u) => {
    const pageNums = u.pageNums && u.pageNums.length ? u.pageNums : [];
    const pageLabel = pageNums.length ? 'p.' + pageNums.join(',') : '?';
    return {
      _manualReview: true,
      _pageStart: pageNums.length ? Math.min(...pageNums) : null,
      _pageEnd: pageNums.length ? Math.max(...pageNums) : null,
      _preview: u.preview || '',
      BillingPeriodStart: null,
      BillingPeriodEnd: null,
      TotalCurrentCharges: null,
      Commodity: 'Unknown',
      UtilityCompany: null,
      _manualReviewLabel: 'Manual Review — ' + pageLabel,
    };
  });
}

async function processPDF(file) {
  const box = document.getElementById('pdfAIBox'),
    dz = document.getElementById('dz-title');
  document.getElementById('extractMethodBadge').style.display = 'none';
  window._pdfSourceFileName = file.name;
  window._pdfAbort = false;
  dz.innerHTML =
    '📄 ' +
    file.name +
    ' — reading... <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:10px" onclick="event.stopPropagation();window._pdfAbort=true;clearPDFOCR();showToast(\'Extraction cancelled\')">✕ Cancel</button>';
  box.innerHTML =
    '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> Reading PDF...</div>';
  globalTaskShow('📄 Extracting ' + file.name + '...', 'pdf');
  const reader = new FileReader();
  reader.onload = async (ev) => {
    pdfB64 = ev.target.result.split(',')[1];
    // pdf.js transfers ownership of the ArrayBuffer to its worker and detaches it,
    // so a single buffer cannot be reused across calls. Decode fresh bytes for each
    // pdf.js invocation via this helper.
    const freshBytes = () => Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));

    // ── UTILITY BILLS: 100% local rule-based extraction ──
    if (pdfType === 'utility') {
      const statusMsg = (msg) => {
        box.innerHTML =
          '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> ' + msg + '</div>';
        globalTaskUpdate('📄 ' + msg);
      };
      let text = await extractPDFText(freshBytes(), statusMsg);
      if (window._pdfAbort) {
        globalTaskDone();
        return;
      } // Bug #134: honour cancel after extraction
      const _budgetHit = window._pdfOcrBudgetExceeded;
      window._pdfOcrBudgetExceeded = null; // consume once
      // ── Empty-page warning: surface any pages that returned no OCR text ──
      // An empty page means the billing period on that page was silently dropped.
      // We flag it here so the user knows to re-run extraction or check the PDF.
      const _emptyOcrPages = window._pdfOcrEmptyPages;
      window._pdfOcrEmptyPages = null; // consume once
      if (_emptyOcrPages && _emptyOcrPages.length > 0) {
        const pgList = _emptyOcrPages.join(', ');
        showToast(
          'Warning: page' +
            (_emptyOcrPages.length > 1 ? 's' : '') +
            ' ' +
            pgList +
            ' could not be read — a billing period may be missing. Re-run extraction if a period is absent.',
        );
      }
      if (text && text.trim().length > 100) {
        window._pdfRawText = text;
        document.getElementById('pdfDebugBtn').style.display = 'inline-block';
        document.getElementById('pdfSaveDebugBtn').style.display = 'inline-block';
        let rule = UTILITY_RULES.find((r) => r.name && /Louisburg/i.test(r.name) && r.detect(text));
        if (!rule) rule = UTILITY_RULES.find((r) => r.detect(text));
        if (rule) {
          // Use extractAll if available (multi-bill PDF support)
          let bills = rule.extractAll ? rule.extractAll(text) : [rule.extract(text)];
          const _extractUnmatchedPages = bills._unmatchedPages || [];
          // Bug b5951068: Flag bills that fail the key-field filter instead of
          // silently dropping them. Unparseable billing periods surface as
          // parseError:true rows so the user can see and manually assign them.
          const _singleHasKeyField = (b) =>
            b.BillingPeriodStart ||
            b.kWhConsumed ||
            b.NaturalGasTherms ||
            b.NaturalGasCCF ||
            b.WaterUsage ||
            b.GasCharge ||
            b.TotalCurrentCharges;
          let validBills = bills.filter((b) => _singleHasKeyField(b));
          const _singleDroppedBills = bills.filter((b) => !_singleHasKeyField(b) && !b._manualReview);
          _singleDroppedBills.forEach((b) => {
            b.parseError = true;
            b._manualReview = true;
            const _pg = b._pageStart != null ? b._pageStart : b._pageIndex != null ? b._pageIndex : null;
            const _pageLabel = _pg != null ? 'p.' + _pg : '?';
            b._manualReviewLabel = 'Parse error — billing period unreadable (' + _pageLabel + ')';
            b.UtilityCompany = b.UtilityCompany || (rule && rule.name) || 'Unknown';
          });

          // ── OCR RETRY: If critical fields are missing, retry with enhanced OCR ──
          // Trigger threshold: only retry when the total missing-field count
          // across all bills is meaningful relative to the batch size. For a
          // 33-bill batch, firing retry on a single missing field means
          // hi-res OCR'ing 3 pages × 3 scales (up to ~13 minutes on slow
          // browsers) to recover one value — not worth it. Retry only when
          // worstMissing >= 2 OR missing-per-bill ratio >= 0.1.
          const retryBills = validBills.length ? validBills : bills;
          const worstMissing = Math.max(...retryBills.map((b) => countCriticalMissing(b, rule.name)));
          const totalMissing = retryBills.reduce((s, b) => s + countCriticalMissing(b, rule.name), 0);
          const missingRatio = retryBills.length > 0 ? totalMissing / retryBills.length : 0;
          const retryWarranted = worstMissing >= 2 || missingRatio >= 0.1;
          if (worstMissing > 0 && retryWarranted && typeof Tesseract !== 'undefined') {
            statusMsg(
              'Validating extraction... ' +
                worstMissing +
                ' critical field' +
                (worstMissing > 1 ? 's' : '') +
                ' missing — retrying OCR...',
            );
            // Retry with aggressive OCR settings on all pages (not just blank ones)
            const RETRY_SCALES = [3.0, 3.5, 4.0];
            let bestText = text,
              bestMissing = worstMissing;
            let retryWorker;
            try {
              // Dictionary params must go in createWorker's 4th arg (init-only)
              retryWorker = await Tesseract.createWorker(
                'eng',
                1,
                {
                  logger: (m) => {
                    if (m.status === 'loading tesseract core') statusMsg('Loading OCR engine for retry...');
                  },
                },
                { load_system_dawg: '0', load_freq_dawg: '0' },
              );
              await retryWorker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
            } catch (e) {
              retryWorker = null;
            }
            if (retryWorker) {
              let pdf2 = null;
              try {
                pdf2 = await pdfjsLib.getDocument({
                  data: freshBytes(),
                  useWorkerFetch: false,
                  isEvalSupported: false,
                  useSystemFonts: true,
                }).promise;
                const maxPg = Math.min(pdf2.numPages, 200);
                // Rebuild pageTexts from the fullText returned by extractPDFText
                // so the retry loop can reuse non-retried pages without pulling
                // from extractPDFText's local scope (which would throw
                // "pageTexts is not defined"). fullText has %%PAGE_N%% markers;
                // split on them to recover per-page text.
                const pageTexts = new Array(maxPg).fill('');
                const _pgRe = /%%PAGE_(\d+)%%\n([\s\S]*?)(?=%%PAGE_\d+%%|$)/g;
                let _pgm;
                while ((_pgm = _pgRe.exec(text)) !== null) {
                  const pgNum = parseInt(_pgm[1]);
                  if (pgNum >= 1 && pgNum <= maxPg) pageTexts[pgNum - 1] = _pgm[2];
                }
                // Only retry pages belonging to bills with missing critical fields
                const retryPages = new Set();
                for (const b of retryBills) {
                  if (countCriticalMissing(b, rule.name) > 0) {
                    const ps = b._pageStart || 1;
                    const pe = b._pageEnd || maxPg;
                    for (let p = ps; p <= pe; p++) retryPages.add(p);
                  }
                }
                // Stamp a fresh budget-window start for this retry phase (a00af2f4) —
                // recognizeWithTimeout's OCR_TOTAL_BUDGET_MS check reads the shared
                // module-level _ocrStartTime; extractPDFText already returned by this
                // point (processPDF awaits it above), so this phase gets its own
                // 4-minute window rather than inheriting a stale/expired one.
                _ocrStartTime = performance.now();
                for (const scale of RETRY_SCALES) {
                  if (bestMissing === 0) break;
                  statusMsg(
                    'OCR retry at ' +
                      scale +
                      'x scale — ' +
                      retryPages.size +
                      ' page' +
                      (retryPages.size !== 1 ? 's' : '') +
                      ' (' +
                      bestMissing +
                      ' missing field' +
                      (bestMissing > 1 ? 's' : '') +
                      ')...',
                  );
                  const retryTexts = [];
                  for (let i = 1; i <= maxPg; i++) {
                    if (!retryPages.has(i)) {
                      // Reuse existing text for pages that don't need retry
                      retryTexts.push(pageTexts[i - 1] || '');
                      continue;
                    }
                    let pg, vp, canvas, ctx;
                    try {
                      pg = await _withTimeout(pdf2.getPage(i), PDFJS_AWAIT_TIMEOUT_MS, 'getPage(' + i + ')');
                      vp = pg.getViewport({ scale });
                      canvas = document.createElement('canvas');
                      canvas.width = vp.width;
                      canvas.height = vp.height;
                      ctx = canvas.getContext('2d');
                      await _withTimeout(
                        pg.render({ canvasContext: ctx, viewport: vp }).promise,
                        PDFJS_AWAIT_TIMEOUT_MS,
                        'render(' + i + ')',
                      );
                    } catch (renderErr) {
                      // Treat a getPage/render timeout the same as "this page needs OCR
                      // retry but failed" — don't let it abort the whole retry batch.
                      retryTexts.push('');
                      if (canvas) {
                        canvas.width = 0;
                        canvas.height = 0;
                        canvas = null;
                      }
                      ctx = null;
                      if (pg && pg.cleanup) pg.cleanup();
                      continue;
                    }
                    try {
                      const { result: retryResult } = await recognizeWithTimeout(retryWorker, canvas, {
                        rotateAuto: true,
                      });
                      retryTexts.push(retryResult.data.text);
                    } catch (e) {
                      if (e._replacementWorker) retryWorker = e._replacementWorker;
                      retryTexts.push('');
                    }
                    // F2: release canvas backing store and PDF page after each retry-path page
                    canvas.width = 0;
                    canvas.height = 0;
                    canvas = null;
                    ctx = null;
                    if (pg.cleanup) pg.cleanup();
                  }
                  const retryFull = retryTexts.map((rt, ri) => '%%PAGE_' + (ri + 1) + '%%\n' + rt).join('\n');
                  if (retryFull.trim().length > 100) {
                    const retryRule = UTILITY_RULES.find((r) => r.detect(retryFull));
                    if (retryRule) {
                      const retryBills2 = retryRule.extractAll
                        ? retryRule.extractAll(retryFull)
                        : [retryRule.extract(retryFull)];
                      const retryValid = retryBills2.filter((b) => b.BillingPeriodStart || b.kWhConsumed);
                      const retryCheck = retryValid.length ? retryValid : retryBills2;
                      const retryMissing = Math.max(...retryCheck.map((b) => countCriticalMissing(b, retryRule.name)));
                      if (retryMissing < bestMissing) {
                        bestText = retryFull;
                        bestMissing = retryMissing;
                        bills = retryBills2;
                        validBills = retryValid;
                        window._pdfRawText = retryFull;
                      }
                      // Also merge: fill in any null fields from retry into original
                      if (retryCheck.length === retryBills.length) {
                        for (let bi = 0; bi < retryBills.length; bi++) {
                          const orig = retryBills[bi],
                            retry = retryCheck[bi];
                          if (!orig || !retry) continue;
                          for (const [k, v] of Object.entries(retry)) {
                            if (
                              (orig[k] === null || orig[k] === undefined || orig[k] === '') &&
                              v !== null &&
                              v !== undefined &&
                              v !== ''
                            ) {
                              orig[k] = v; // fill gap from retry
                            }
                          }
                        }
                        // Recount after merge
                        const mergedMissing = Math.max(...retryBills.map((b) => countCriticalMissing(b, rule.name)));
                        if (mergedMissing < bestMissing) {
                          bestMissing = mergedMissing;
                          bills = retryBills.slice();
                          validBills = bills.filter((b) => b.BillingPeriodStart || b.kWhConsumed);
                        }
                      }
                      if (bestMissing === 0) break;
                    }
                  }
                }
              } finally {
                // F1b: destroy the second PDF doc so its bitmaps are freed
                if (pdf2 && pdf2.destroy) {
                  try {
                    await pdf2.destroy();
                  } catch (_) {}
                }
                pdf2 = null;
                // F5b: terminate retryWorker even if an error was thrown mid-loop
                if (retryWorker) {
                  try {
                    await retryWorker.terminate();
                  } catch (_) {}
                  retryWorker = null;
                }
              }
            }
          }

          // ── POST-EXTRACTION VERIFICATION: use historical data + logic to fix issues ──
          // Bug b5951068: append parse-error rows (flagged above) so they're never lost.
          let finalBills = validBills.length > 0 ? validBills.concat(_singleDroppedBills || []) : bills;
          statusMsg('Verifying extraction against historical data...');
          let _pevCache = {};
          try {
            const _pevResult = await _postExtractionVerify(finalBills, rule.name, text);
            finalBills = _pevResult.bills;
            _pevCache = _pevResult.historicalCache || {};
          } catch (pev_err) {
            console.warn('[processPDF] _postExtractionVerify failed, continuing without verification:', pev_err);
          }

          // ── MULTI-PASS OCR CONSENSUS: re-extract from alternate passes for mismatched values ──
          const passTexts = window._pdfOcrPasses || {};
          const hasAltPasses = Object.values(passTexts).some((p) => p.length > 1);
          if (hasAltPasses && rule.name === 'Evergy') {
            const billsWithMismatch = finalBills.filter((b) => b._sum_mismatch);
            if (billsWithMismatch.length > 0) {
              statusMsg('Trying alternate OCR passes for ' + billsWithMismatch.length + ' mismatched bill(s)...');
              // Build alternate full texts from non-best passes
              const altTexts = [];
              for (const passes of Object.values(passTexts)) {
                for (const p of passes) {
                  // Collect all unique pass texts (they may differ from the best)
                  if (!altTexts.includes(p.text) && p.text !== text) altTexts.push(p.text);
                }
              }
              for (const b of billsWithMismatch) {
                if (!b._sum_mismatch) continue; // may have been resolved by rate correction
                const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
                const CHARGE_CHECK = [
                  'CustomerCharge',
                  'FacilitiesCharge',
                  'BilledKWCharge',
                  'EnergyOnPeakCharge',
                  'EnergyOffPeakCharge',
                  'ECACharge',
                  'EERCharge',
                  'PTSCharge',
                  'TDCCharge',
                  'RkVACharge',
                  'TaxExemptDelivery',
                  'BillOffset',
                  'FranchiseFee',
                ];
                const total = pf(b.TotalCurrentCharges);
                const currentSum = CHARGE_CHECK.reduce((s, f) => s + pf(b[f]), 0);
                const currentDiff = currentSum - total;
                // Try re-extracting from each alternate OCR text
                for (const altText of altTexts) {
                  try {
                    const altBills = rule.extract(altText);
                    if (!altBills || !altBills.length) continue;
                    // Find the alt bill matching this bill's period
                    const altBill =
                      altBills.find(
                        (ab) =>
                          ab.BillingPeriodStart === b.BillingPeriodStart && ab.BillingPeriodEnd === b.BillingPeriodEnd,
                      ) || altBills[0];
                    // Check each charge field: if alt has a different value that reduces the mismatch
                    for (const field of CHARGE_CHECK) {
                      const altVal = pf(altBill[field]);
                      const curVal = pf(b[field]);
                      if (Math.abs(altVal - curVal) < 0.01) continue; // same value
                      // Would swapping this field reduce the total mismatch?
                      const newSum = currentSum - curVal + altVal;
                      const newDiff = Math.abs(newSum - total);
                      if (newDiff < Math.abs(currentDiff) && newDiff <= 1.0) {
                        b['_ocr_consensus_' + field] = {
                          original: b[field],
                          consensus: altVal.toFixed(2),
                          reason: 'Alternate OCR pass produced a value that resolves the sum mismatch',
                        };
                        b[field] = altVal.toFixed(2);
                        // Recompute and possibly clear mismatch
                        const reSum = CHARGE_CHECK.reduce((s, f) => s + pf(b[f]), 0);
                        const reDiff = Math.abs(reSum - total);
                        if (reDiff <= 1) {
                          delete b._sum_mismatch;
                        } else {
                          b._sum_mismatch = {
                            compSum: reSum,
                            total,
                            diff: reDiff,
                            reason:
                              'Charges sum to $' +
                              reSum.toFixed(2) +
                              ' after OCR consensus, but total is $' +
                              total.toFixed(2),
                          };
                        }
                        break; // resolved this field, check if mismatch is gone
                      }
                    }
                    if (!b._sum_mismatch) break; // mismatch resolved, stop trying alt texts
                  } catch (e) {
                    /* alt extraction failed, skip */
                  }
                }
              }
            }
          }
          // F3: pass texts only needed during consensus — free them now
          window._pdfOcrPasses = null;
          window._pdfPassScores = null;

          // Convert _pageIndex to _pageStart/_pageEnd for extractors that
          // set per-page indices instead of page ranges
          finalBills.forEach((b) => {
            if (b._pageIndex && !b._pageStart) {
              b._pageStart = b._pageIndex;
              b._pageEnd = b._pageIndex;
            }
          });

          // ── Inject unmatched pages as "Manual Review" entries so they are visible ──
          // Without this, pages that couldn't be parsed are silently dropped.
          const _syntheticReviewBills = _unmatchedToSyntheticBills(_extractUnmatchedPages);
          if (_syntheticReviewBills.length) {
            finalBills = finalBills.concat(_syntheticReviewBills);
          }

          // ── OCR budget-exceeded: loud failure, not a silent spinner (subtask 4) ──
          // Only flag bills that STILL fail the key-field check after everything else
          // has run — a bill that already recovered before the budget tripped should
          // not be punished with a label it doesn't need.
          if (_budgetHit) {
            finalBills.forEach((b) => {
              if (!_singleHasKeyField(b) && !b._manualReview) {
                b._manualReview = true;
                b._manualReviewLabel =
                  'Could not fully extract — OCR budget exceeded (' +
                  _budgetHit.pagesRead +
                  ' of ' +
                  _budgetHit.pagesTotal +
                  ' pages read); manual entry required';
              }
            });
          }

          const analysisResults = await analyzeBillExtraction(finalBills, rule.name, _pevCache, statusMsg);
          window._pdfBillWarnings = analysisResults;
          window._pdfUnmatchedPages = _extractUnmatchedPages;
          if (_extractUnmatchedPages.length > 0) {
            const pgNums = _extractUnmatchedPages.flatMap((u) => u.pageNums).filter(Boolean);
            showToast(
              _extractUnmatchedPages.length +
                ' page(s) could not be parsed — shown as "Manual Review" entries' +
                (pgNums.length ? ' (page ' + pgNums.join(', ') + ')' : ''),
            );
          }

          if (finalBills.length > 1) {
            // Multi-bill: store all, start on newest bill
            window._pdfMultiBills = finalBills;
            // Check for duplicates before rendering
            statusMsg('Checking for duplicates (' + finalBills.length + ' bills)...');
            await _checkDuplicates(finalBills, statusMsg);
            // Find the newest bill by BillingPeriodEnd date
            let newestIdx = 0;
            let newestDate = 0;
            finalBills.forEach((fb, fi) => {
              const d = new Date(fb.BillingPeriodEnd || fb.BillingPeriodStart || 0).getTime();
              if (d > newestDate) {
                newestDate = d;
                newestIdx = fi;
              }
            });
            window._pdfMultiIdx = newestIdx;
            renderMultiBillUI(finalBills, box);
            renderPDFFields(finalBills[newestIdx], analysisResults[newestIdx]?.warnings || []);
            document.getElementById('pdfSaveRow').style.display = 'block';
            document.getElementById('pdfClearBtn').style.display = 'block';
            document.getElementById('dropZone').classList.add('collapsed');
            document.getElementById('pdfTypeSection').style.display = 'none';
            refreshProjDropdowns();
            const warnCount = analysisResults.reduce(
              (s, r) => s + r.warnings.filter((w) => w.level === 'error' || w.level === 'warn').length,
              0,
            );
            showExtractionBadge(
              'rules',
              rule.name +
                ' · ' +
                finalBills.length +
                ' periods' +
                (warnCount ? ' · ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') : ''),
            );
            dz.textContent =
              file.name +
              ' ✓ (' +
              finalBills.length +
              ' periods' +
              (warnCount ? ', ' + warnCount + ' warnings' : '') +
              ')';
            showToast(
              finalBills.length +
                ' billing periods extracted' +
                (warnCount ? ' — ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') + ' found' : ''),
            );
            var _multiBillMatch = findMeterMatch(finalBills[0]);
            if (
              _multiBillMatch &&
              _multiBillMatch.fuzzyScore &&
              _multiBillMatch.fuzzyScore < 1.0 &&
              !_multiBillMatch.isAlias &&
              typeof saveAddressAlias === 'function' &&
              finalBills[0].ServiceAddress
            ) {
              saveAddressAlias(_multiBillMatch.projId, _multiBillMatch.bldgId, finalBills[0].ServiceAddress);
            }
            showAutoAssignBanner(_multiBillMatch, finalBills[0]);
          } else {
            const extracted = finalBills[0] || bills[0];
            window._pdfMultiBills = [extracted]; // always store as array for consistency
            window._pdfMultiIdx = 0;
            await _checkDuplicates([extracted], statusMsg);
            const billWarnings = analysisResults[0]?.warnings || [];
            renderPDFFields(extracted, billWarnings);
            box.textContent = JSON.stringify(extracted, null, 2);
            document.getElementById('pdfSaveRow').style.display = 'block';
            document.getElementById('pdfClearBtn').style.display = 'block';
            document.getElementById('dropZone').classList.add('collapsed');
            document.getElementById('pdfTypeSection').style.display = 'none';
            refreshProjDropdowns();
            const warnCount = billWarnings.filter((w) => w.level === 'error' || w.level === 'warn').length;
            showExtractionBadge(
              'rules',
              rule.name +
                ' · 1 period' +
                (warnCount ? ' · ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') : ''),
            );
            dz.textContent = file.name + ' ✓' + (warnCount ? ' (' + warnCount + ' warnings)' : '');
            showToast(
              'Extracted locally — ' +
                rule.name +
                (warnCount ? ' — ' + warnCount + ' warning' + (warnCount > 1 ? 's' : '') : ' ✓'),
            );
            var _singleBillMatch = findMeterMatch(extracted);
            if (
              _singleBillMatch &&
              _singleBillMatch.fuzzyScore &&
              _singleBillMatch.fuzzyScore < 1.0 &&
              !_singleBillMatch.isAlias &&
              typeof saveAddressAlias === 'function' &&
              extracted.ServiceAddress
            ) {
              saveAddressAlias(_singleBillMatch.projId, _singleBillMatch.bldgId, extracted.ServiceAddress);
            }
            showAutoAssignBanner(_singleBillMatch, extracted);
          }
          _saveExtractionState();
          // Auto-save debug file on every successful extraction
          try {
            savePDFDebug();
          } catch (e) {
            console.warn('Auto-save debug failed:', e);
          }
          globalTaskDone();
          return;
        }
        // Utility format not yet in rules library
        box.innerHTML =
          '<div style="padding:14px;font-size:13px;line-height:1.7;color:var(--text2)">&#9888; <strong style="color:var(--text)">Utility format not recognized.</strong><br>This bill layout does not match any rules in the library yet.<br><br>Share a sample bill to have a rule set added for this format.</div>';
        dz.textContent = file.name + ' — unrecognized format';
        globalTaskDone();
        return;
      }
      box.innerHTML =
        '<div style="padding:14px;font-size:13px;color:var(--text2)">&#9888; Could not extract text from this PDF even after OCR. The file may be corrupted or too low resolution.</div>';
      dz.textContent = file.name + ' — could not read';
      globalTaskDone();
      return;
    }

    // ── NON-UTILITY TYPES: local text extraction only ──
    const text = await extractPDFText(ab, (msg) => {
      box.innerHTML =
        '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> ' + msg + '</div>';
      globalTaskUpdate('📄 ' + msg);
    });
    if (text) {
      box.textContent = text;
      dz.textContent = file.name + ' ✓';
      showToast('Text extracted ✓');
    } else {
      box.innerHTML =
        '<div style="padding:14px;font-size:13px;color:var(--text2)">&#9888; Could not extract text from this PDF.</div>';
      dz.textContent = file.name + ' — could not read';
    }
    globalTaskDone();
  };
  reader.readAsDataURL(file);
}
function renderMultiBillUI(bills, box) {
  const idx = window._pdfMultiIdx || 0;
  const b = bills[idx];
  const warnings = window._pdfBillWarnings || [];
  // Short MM/DD/YY date format for the pill labels
  const _shortDt = (s) => {
    if (!s) return s;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return s;
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    const yy = m[3].length === 4 ? m[3].slice(2) : m[3];
    return mm + '/' + dd + '/' + yy;
  };
  // Majority-month label (e.g. "Mar 2024") for a bill's period. Uses majority-days
  // inline to avoid the MM/DD/YYYY ↔ YYYY-MM-DD format mismatch with normMonth.
  // Tie-break (Update 83): when two months have equal day counts, the
  // month with higher ratio-of-days-in-that-month wins (e.g. 18/28 Feb
  // beats 18/31 Jan) so sibling bills with near-identical periods land
  // in the same month.
  const _monthLabel = (bill) => {
    const parse = (str) => {
      if (!str) return null;
      const s = String(str).trim();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return new Date(yr, +m[1] - 1, +m[2]);
      }
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
      return null;
    };
    // Single-date delivery events (propane) use DeliveryDate directly.
    if (bill.DeliveryDate) {
      const d = parse(bill.DeliveryDate);
      return d ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';
    }
    const s = parse(bill.BillingPeriodStart);
    const e = parse(bill.BillingPeriodEnd);
    if (!s || !e || s > e) return '';
    const counts = {};
    let cur = new Date(s);
    while (cur <= e) {
      const key = cur.getFullYear() + '-' + (cur.getMonth() + 1);
      counts[key] = (counts[key] || 0) + 1;
      cur.setDate(cur.getDate() + 1);
    }
    const top = Object.entries(counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const [yA, mA] = a[0].split('-').map(Number);
      const [yB, mB] = b[0].split('-').map(Number);
      const dimA = new Date(yA, mA, 0).getDate();
      const dimB = new Date(yB, mB, 0).getDate();
      return b[1] / dimB - a[1] / dimA;
    })[0][0];
    const [y, mo] = top.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  };
  // Build consecutive-aware month labels per commodity group so bills
  // like 12/15-1/14 (majority Dec) and 1/14-2/20 (majority Feb) don't
  // skip January. Within each commodity, bills are sorted by start date
  // and each gets nextMonth(prev) when consecutive (gap ≤ 3 days).
  const _monthLabelMap = {};
  const _commGroups = {};
  bills.forEach((b, i) => {
    const c = (b.Commodity || 'Other') + '|' + (b.AccountNumber || '_') + '|' + (b.ServiceAddress || '_');
    if (!_commGroups[c]) _commGroups[c] = [];
    _commGroups[c].push(i);
  });
  const _parseDt = (str) => {
    if (!str) return null;
    const s = String(str).trim();
    // Accept both MM/DD/YYYY (Evergy) and YYYY-MM-DD (ISO from saved bills)
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return new Date(yr, +m[1] - 1, +m[2]);
    }
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    return null;
  };
  const _majMonth = (s, e) => {
    if (!s || !e || s > e) return s ? s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') : null;
    const counts = {};
    let cur = new Date(s);
    let iter = 0;
    while (cur <= e && iter++ < 120) {
      const key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      counts[key] = (counts[key] || 0) + 1;
      cur.setDate(cur.getDate() + 1);
    }
    const entries = Object.entries(counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const [yA, mA] = a[0].split('-').map(Number);
      const [yB, mB] = b[0].split('-').map(Number);
      return b[1] / new Date(yB, mB, 0).getDate() - a[1] / new Date(yA, mA, 0).getDate();
    });
    return entries.length ? entries[0][0] : null;
  };
  const _nextMo = (ym) => {
    let [y, mo] = ym.split('-').map(Number);
    if (++mo > 12) {
      mo = 1;
      y++;
    }
    return y + '-' + String(mo).padStart(2, '0');
  };
  for (const indices of Object.values(_commGroups)) {
    const sorted = indices
      .map((i) => ({
        i,
        s: _parseDt(bills[i].BillingPeriodStart),
        e: _parseDt(bills[i].BillingPeriodEnd),
        dd: _parseDt(bills[i].DeliveryDate),
      }))
      .sort((a, b) => (a.s || a.dd || 0) - (b.s || b.dd || 0));
    let prevYm = null;
    let prevEnd = null;
    for (const item of sorted) {
      let ym;
      if (item.dd && !item.s) {
        ym = item.dd.getFullYear() + '-' + String(item.dd.getMonth() + 1).padStart(2, '0');
      } else if (item.s && item.e) {
        if (prevYm && prevEnd) {
          const gap = (item.s - prevEnd) / 86400000;
          ym = gap <= 3 ? _nextMo(prevYm) : _majMonth(item.s, item.e);
        } else {
          ym = _majMonth(item.s, item.e);
        }
      } else {
        ym = null;
      }
      if (ym) {
        const [y, mo] = ym.split('-').map(Number);
        _monthLabelMap[item.i] = new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        });
      } else {
        _monthLabelMap[item.i] = '';
      }
      prevYm = ym;
      prevEnd = item.e || item.dd;
    }
  }
  // Build period labels with sort indices for descending order.
  // Pill label is MM/DD/YY-MM/DD/YY for billing periods, MM/DD/YY for
  // single-date delivery events (propane). Month column shows "Mon YYYY".
  const _uniqueAccts = new Set(bills.map((b) => b.AccountNumber).filter(Boolean));
  const _multiAcct = _uniqueAccts.size > 1;
  const periods = bills.map((bill, i) => {
    let lbl;
    let sortSource;
    if (bill._manualReview) {
      lbl = bill._manualReviewLabel || 'Manual Review';
      sortSource = 0; // sort to the end (oldest)
    } else if (bill.DeliveryDate) {
      lbl = _shortDt(bill.DeliveryDate);
      sortSource = bill.DeliveryDate;
    } else if (bill.BillingPeriodStart && bill.BillingPeriodEnd) {
      lbl = _shortDt(bill.BillingPeriodStart) + '-' + _shortDt(bill.BillingPeriodEnd);
      sortSource = bill.BillingPeriodEnd;
    } else {
      lbl = 'Period ' + (i + 1);
      sortSource = bill.BillingPeriodStart || bill.BillDate || 0;
    }
    // Append a commodity suffix when multiple splits share the same date
    // (Louisburg combined bills → "01/20/26 · Water", "01/20/26 · Gas", etc.)
    if (bill.Commodity && bill.Commodity !== 'Propane') {
      const _commAbbr = { Stormwater: 'Storm', Electric: 'Elec' };
      lbl = lbl + ' · ' + (_commAbbr[bill.Commodity] || bill.Commodity);
    }
    let acctLbl = '';
    if (_multiAcct && bill.AccountNumber) {
      const addr = bill.ServiceAddress || '';
      const shortAddr = addr.replace(/,?\s*(LOUISBURG|KS)\s*/gi, '').trim();
      acctLbl = '  Acct ' + bill.AccountNumber + (shortAddr ? ' — ' + shortAddr : '');
    }
    const monthLbl = _monthLabelMap[i] || _monthLabel(bill);
    const sortDate = new Date(sortSource);
    return { i, lbl, monthLbl, sortDate, acctLbl };
  });
  // Sort descending by date (newest first)
  periods.sort((a, b) => b.sortDate - a.sortDate);
  // Commodity tabs: group pills by commodity when multiple types exist
  const _commOrder = ['Gas', 'Water', 'Sewer', 'Stormwater', 'Electric', 'Propane', 'Other'];
  // FIX(2026-07-02, item 219e6828): indexOf() returns -1 for any commodity not
  // in this fixed list (e.g. the literal 'Unknown' commodity stamped on a
  // synthetic Manual Review bill by _unmatchedToSyntheticBills when a page
  // fails to parse) which used to sort BEFORE every real commodity (-1 < 0)
  // and silently win the default-active-tab position below. Rank anything
  // not in the list to the END instead so a real commodity is always default.
  const _commRank = (c) => {
    const i = _commOrder.indexOf(c);
    return i === -1 ? 999 : i;
  };
  const _uniqueComms = [...new Set(bills.map((b) => b.Commodity || 'Other'))].sort(
    (a, b) => _commRank(a) - _commRank(b),
  );
  const _hasMultiComm = _uniqueComms.length > 1;
  if (_hasMultiComm && !window._pdfCommTab) window._pdfCommTab = _uniqueComms[0];
  if (window._pdfCommTab === 'All') window._pdfCommTab = _uniqueComms[0];
  const activeCommTab = _hasMultiComm ? window._pdfCommTab || _uniqueComms[0] : 'All';
  const filteredPeriods =
    activeCommTab === 'All' ? periods : periods.filter((p) => (bills[p.i].Commodity || 'Other') === activeCommTab);
  // Duplicate map must be declared before the nav closure below reads it (TDZ)
  const dupMap = window._pdfDupMap || {};
  const _buildPill = (p) => {
    const active = p.i === idx;
    const bw = warnings[p.i]?.warnings || [];
    const hasIssues = bw.some((w) => w.level === 'error' || w.level === 'warn');
    const bill = bills[p.i];
    const _pf2 = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
    const _pillComm =
      bill.Commodity ||
      (bill.kWhConsumed
        ? 'Electric'
        : bill.NaturalGasTherms || bill.NaturalGasCCF || bill.GasCharge
          ? 'Gas'
          : 'Electric');
    const _pillChargeKeys = {
      Electric: [
        'CustomerCharge',
        'FacilitiesCharge',
        'BilledKWCharge',
        'EnergyOnPeakCharge',
        'EnergyOffPeakCharge',
        'ECACharge',
        'EERCharge',
        'PTSCharge',
        'TDCCharge',
        'RkVACharge',
        'TaxExemptDelivery',
        'BillOffset',
        'FranchiseFee',
      ],
      Gas: [
        'CustomerCharge',
        'GasCharge',
        'FuelAdjustment',
        'DeliveryCharge',
        'GasSystemReliability',
        'WeatherNormalization',
        'WinterEventCost',
        'FranchiseFee',
        'DelayedPaymentCharge',
      ],
      Water: ['WaterCharge', 'WaterProtectionFee', 'WaterDebtPayment', 'WaterFranchiseFee'],
      Sewer: ['SewerCharge', 'SewerFranchiseFee'],
      Stormwater: ['StormWaterCharge'],
      Propane: ['Subtotal', 'Tax'],
    };
    const _pillKeys = _pillChargeKeys[_pillComm] || _pillChargeKeys.Electric;
    // Round each component to 2 decimal places before summing to prevent
    // floating-point accumulation across many addends (e.g. 9 KGS line items).
    const _chargeSum = Math.round(_pillKeys.reduce((s, f) => s + Math.round(_pf2(bill[f]) * 100) / 100, 0) * 100) / 100;
    const _totalVal = _pf2(bill.TotalCurrentCharges);
    // Allow 1¢ per component of accumulated rounding before flagging a mismatch.
    // Flat 0.02 was too tight for multi-line KGS bills where rounding adds up across 9 fields.
    const _pillTol = Math.max(0.02, 0.01 * _pillKeys.length);
    const hasSumMismatch =
      bw.some((w) => w.field === 'TotalCurrentCharges' && w.level === 'warn' && /sum/i.test(w.message)) ||
      (_totalVal > 0 && _chargeSum > 0 && Math.abs(_chargeSum - _totalVal) >= _pillTol);
    const hasAnyIssue = hasIssues || hasSumMismatch;
    const issueColor = hasSumMismatch ? '--red' : '--amber';
    const pillColor = hasAnyIssue ? 'var(' + issueColor + ')' : active ? 'var(--accent)' : 'var(--text2)';
    const pillBorder = hasAnyIssue ? 'var(' + issueColor + ')' : active ? 'var(--accent)' : 'var(--border2)';
    const pillBg = active ? 'var(--accent-dim)' : hasAnyIssue ? 'var(' + issueColor + '-dim)' : 'transparent';
    const isDup = !!dupMap[p.i];
    const diffCount = isDup ? (dupMap[p.i].diffFields || []).length : 0;
    const dupDot = isDup
      ? `<span style="display:inline-block;margin-left:6px;vertical-align:middle;color:var(--amber);font-weight:700;font-size:11px;font-family:var(--mono)" title="Duplicate bill — ${diffCount} differing field${diffCount === 1 ? '' : 's'} — found in ${dupMap[p.i].locationType === 'saved' ? 'Saved Bills' : dupMap[p.i].location}">${diffCount}</span>`
      : '';
    const pillBtn = `<button class="ef-pill-btn" onclick="selectMultiBill(${p.i})" style="font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:11px;padding:5px 12px;border-radius:5px;border:1px solid ${pillBorder};background:${pillBg};color:${pillColor};cursor:pointer;font-weight:${active ? '700' : hasAnyIssue ? '700' : '400'};text-align:left;white-space:nowrap">${p.lbl}${dupDot}</button>`;
    const gapInfo = bill._billing_gap;
    const gapRow = gapInfo
      ? `<div style="padding:2px 8px;margin:2px 0;font-size:10px;color:var(--amber);text-align:center;font-weight:600">&#9888; ${gapInfo.days}-day gap (after ${gapInfo.afterPeriod || ''})</div>`
      : '';
    return `<div class="ef-pill-row"><div class="ef-pill-month">${p.monthLbl || ''}</div>${pillBtn}</div>` + gapRow;
  };
  let nav;
  if (_multiAcct) {
    const _acctKeys = [...new Set(bills.map((b) => b.AccountNumber || '_unknown'))];
    const _bldgName = (acct) => {
      // FIX(2026-07-09, item 219e6828 defect 2): '_unknown' is the internal grouping
      // key _acctKeys uses for bills with no AccountNumber — no bill's AccountNumber
      // is ever literally that string, so `bills.find(x => x.AccountNumber === acct)`
      // always missed for these bills and this function fell through every branch
      // below to `return acct`, leaking the raw sentinel as a chip label (e.g.
      // "_unknown · Electric (4)" in Matt's screenshot). Match bills the same
      // sentinel-normalized way _acctKeys/_bldgTabsHtml do, and use a readable
      // fallback label instead of the internal key wherever `acct` would otherwise
      // be shown verbatim.
      const isUnassigned = acct === '_unknown';
      const _fallbackLabel = isUnassigned ? 'Unassigned (needs review)' : acct;
      const b = bills.find((x) => (x.AccountNumber || '_unknown') === acct);
      if (!b) return _fallbackLabel;
      const match = typeof findMeterMatch === 'function' ? findMeterMatch(b) : null;
      if (match && match.bldg && match.bldg.name) return match.bldg.name;
      if (!b.ServiceAddress) return _fallbackLabel;
      // FIX(2026-07-02, item 219e6828): don't render raw OCR garbage as a
      // building-tab label. Extractors that key an identity fallback off a
      // printed "ADDRESS:" stub can capture pure noise ("= == =="), boilerplate
      // footer text, or address+junk that didn't get stripped (see
      // energy-savings.js _looksLikeAddress / _stripAddressTrailingJunk).
      // Bills saved BEFORE this fix shipped may still carry an unstripped
      // ServiceAddress (e.g. "614 DEARBORN ST   as/25/2 | o9s4.58") — re-run
      // the stripper here too so the label is clean regardless of when the
      // bill was extracted, not just for fresh extractions. _addressPlausible
      // is stamped by the (already-stripped) extractor output when present;
      // fall back to stripping + re-checking live for older saved bills that
      // predate the flag. Universal rule: never drop the underlying bill for
      // a bad label — fall back to the account number with a visible "needs
      // review" marker so the bill stays selectable/saveable.
      const _cleanAddr =
        typeof _stripAddressTrailingJunk === 'function'
          ? _stripAddressTrailingJunk(b.ServiceAddress) || b.ServiceAddress
          : b.ServiceAddress;
      const _plausible =
        b._addressPlausible !== undefined
          ? b._addressPlausible
          : typeof _looksLikeAddress === 'function'
            ? _looksLikeAddress(_cleanAddr)
            : true;
      if (!_plausible) return isUnassigned ? _fallbackLabel : acct + ' (needs review)';
      const addr = _cleanAddr;
      const afterComma = addr.includes(',') ? addr.split(',').slice(1).join(',').trim() : addr;
      return (
        afterComma.replace(/\b(LOUISBURG|KANSAS CITY|OLATHE|LENEXA|OVERLAND PARK|SHAWNEE|KS|MO)\b/gi, '').trim() ||
        _fallbackLabel
      );
    };
    const _hasMultiCommsAcross = new Set(bills.map((b) => b.Commodity || 'Electric')).size > 1;
    if (!window._pdfBuildingTab || !_acctKeys.includes(window._pdfBuildingTab)) {
      // FIX(2026-07-09, item 219e6828 defect 1): the building tab used to default to
      // bills[idx]'s account (the newest bill overall) regardless of which commodity
      // tab was active. window._pdfCommTab defaults independently (first commodity in
      // _commOrder) a few lines above — the two defaults could point at incompatible
      // bill sets (e.g. commTab=Water, buildingTab=a Sewer-only account), so the
      // account+commodity filters below never overlapped and "Monthly Billing
      // Periods" rendered empty on first load. Default the building tab from the
      // first bill under the already-active commodity tab so they always agree.
      const _defaultAcctForComm = filteredPeriods.length
        ? bills[filteredPeriods[0].i].AccountNumber || '_unknown'
        : null;
      window._pdfBuildingTab = _defaultAcctForComm || bills[idx]?.AccountNumber || _acctKeys[0];
    }
    let _bldgTabsHtml = '<div style="display:flex;gap:4px;margin:10px 0 8px;flex-wrap:wrap">';
    for (const acct of _acctKeys) {
      const isActive = acct === window._pdfBuildingTab;
      const bg = isActive ? 'var(--em)' : 'var(--s2)';
      const color = isActive ? '#fff' : 'var(--text)';
      const border = isActive ? 'var(--em)' : 'var(--border2)';
      let lbl = _bldgName(acct);
      if (_hasMultiCommsAcross) {
        const comm = bills.find((x) => x.AccountNumber === acct)?.Commodity || 'Electric';
        lbl += ' · ' + comm;
      }
      const acctPeriods = filteredPeriods.filter((p) => (bills[p.i].AccountNumber || '_unknown') === acct);
      // FIX(2026-07-02, item 219e6828): count ALL periods for this account
      // across every commodity, not just the currently active commodity tab.
      // A building-tab chip means "how many periods exist for this building,"
      // independent of which commodity sub-tab happens to be selected — the
      // old acctPeriods-based count read 0 on every chip whenever the default
      // active commodity tab (see _commRank above) held no bills for that
      // account (e.g. the synthetic 'Unknown' manual-review tab).
      const acctAllPeriods = periods.filter((p) => (bills[p.i].AccountNumber || '_unknown') === acct);
      const ct = acctAllPeriods.length;
      const firstIdx = acctPeriods.length ? acctPeriods[0].i : acctAllPeriods.length ? acctAllPeriods[0].i : 0;
      // FIX(2026-07-09, item 219e6828 defect 1): this onclick used to only set
      // window._pdfBuildingTab, never window._pdfCommTab. If the clicked account's
      // commodity didn't match whatever commodity tab happened to already be active,
      // the two selectors disagreed and the "Monthly Billing Periods" pill list (which
      // requires both to match, see bldgPeriods below) rendered empty — the click
      // looked dead. Sync the commodity tab to this account's real commodity too.
      const _acctComm = bills[firstIdx]?.Commodity || _uniqueComms[0] || 'Electric';
      _bldgTabsHtml +=
        '<button onclick="window._pdfCommTab=\'' +
        _acctComm +
        "';window._pdfBuildingTab='" +
        acct +
        "';selectMultiBill(" +
        firstIdx +
        ')" style="padding:6px 14px;border-radius:6px;border:1px solid ' +
        border +
        ';background:' +
        bg +
        ';color:' +
        color +
        ';cursor:pointer;font-size:12px;font-family:var(--font)">' +
        lbl +
        ' (' +
        ct +
        ')</button>';
    }
    _bldgTabsHtml += '</div>';
    let bldgBar = document.getElementById('pdfBldgTabsBar');
    if (!bldgBar) {
      bldgBar = document.createElement('div');
      bldgBar.id = 'pdfBldgTabsBar';
      bldgBar.style.cssText = 'position:sticky;top:0;z-index:12;background:var(--bg);padding-bottom:4px';
      const hdr = document.getElementById('extractedFieldsHdr');
      if (hdr) hdr.parentNode.insertBefore(bldgBar, hdr);
    }
    if (bldgBar) bldgBar.innerHTML = _bldgTabsHtml;
    const bldgPeriods = filteredPeriods.filter(
      (p) => (bills[p.i].AccountNumber || '_unknown') === window._pdfBuildingTab,
    );
    nav = bldgPeriods.map(_buildPill).join('');
  } else {
    const bldgBar = document.getElementById('pdfBldgTabsBar');
    if (bldgBar) bldgBar.innerHTML = '';
    nav = filteredPeriods.map(_buildPill).join('');
  }
  // Duplicate summary banner
  const dupIndices = Object.keys(dupMap).map(Number);
  let dupBannerHtml = '';
  if (dupIndices.length > 0) {
    // Count by location type
    const assignedCount = dupIndices.filter((i) => dupMap[i].locationType === 'assigned').length;
    const savedCount = dupIndices.filter((i) => dupMap[i].locationType === 'saved').length;
    const parts = [];
    if (assignedCount) {
      // Group by location
      const locs = {};
      dupIndices
        .filter((i) => dupMap[i].locationType === 'assigned')
        .forEach((i) => {
          const loc = dupMap[i].location;
          locs[loc] = (locs[loc] || 0) + 1;
        });
      Object.entries(locs).forEach(([loc, cnt]) => parts.push(cnt + ' assigned to ' + loc));
    }
    if (savedCount) parts.push(savedCount + ' in Saved Bills');
    // #117: Count by diff status for the legend
    const identicalCount = dupIndices.filter((i) => (dupMap[i].diffFields || []).length === 0).length;
    const diffCount117 = dupIndices.filter(
      (i) => (dupMap[i].diffFields || []).length > 0 && (dupMap[i].diffFields || []).length < 5,
    ).length;
    const conflictCount = dupIndices.filter((i) => (dupMap[i].diffFields || []).length >= 5).length;
    const legendParts = [];
    if (identicalCount)
      legendParts.push(
        `<span style="display:inline-flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:2px;background:#22c55e;display:inline-block"></span><span style="color:var(--text2)">Identical (safe to skip): ${identicalCount}</span></span>`,
      );
    if (diffCount117)
      legendParts.push(
        `<span style="display:inline-flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:2px;background:#f59e0b;display:inline-block"></span><span style="color:var(--text2)">Fields differ (review): ${diffCount117}</span></span>`,
      );
    if (conflictCount)
      legendParts.push(
        `<span style="display:inline-flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:2px;background:#f43f5e;display:inline-block"></span><span style="color:var(--text2)">Conflict (manual resolution): ${conflictCount}</span></span>`,
      );
    dupBannerHtml = `<div style="padding:8px 12px;margin:0 0 8px;border-radius:6px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);font-size:12px;color:var(--amber)">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:${legendParts.length ? '6px' : '0'}">
          <span style="flex:1;min-width:0"><strong>&#9888; Duplicate Bills Found &mdash; ${dupIndices.length} of ${bills.length} already exist</strong> &mdash; ${parts.join(', ')}</span>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button onclick="_dupBulkAction('skip')" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid rgba(245,158,11,.4);background:transparent;color:var(--amber);cursor:pointer">Skip All</button>
            <button onclick="_dupBulkAction('overwrite')" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid rgba(245,158,11,.4);background:transparent;color:var(--amber);cursor:pointer" title="Replace existing records with newly extracted values, including blanks">Overwrite All</button>
            <button onclick="_dupBulkAction('merge')" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid rgba(245,158,11,.4);background:transparent;color:var(--amber);cursor:pointer" title="Fill only empty fields — keeps existing non-empty values intact">Merge All</button>
          </div>
        </div>
        ${legendParts.length ? `<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:10px;padding-top:4px;border-top:1px solid rgba(245,158,11,.2)">${legendParts.join('')}</div>` : ''}
      </div>`;
  }
  // Move "Save All" button + per-commodity buttons into the extraction method badge area
  const badgeEl = document.getElementById('extractMethodBadge');
  if (badgeEl) {
    badgeEl.style.display = 'inline-block';
    const commodities = {};
    bills.forEach((b, i) => {
      const c = b.Commodity || 'Other';
      commodities[c] = (commodities[c] || 0) + 1;
    });
    const commKeys = Object.keys(commodities);
    let btns = `<button onclick="savePDFAllBills()" class="btn btn-em btn-sm" style="font-size:10px;padding:3px 12px">Save All ${bills.length} Periods</button>`;
    if (commKeys.length > 1) {
      btns += commKeys
        .map(
          (c) =>
            `<button onclick="savePDFAllBills('${c.replace(/'/g, "\\'")}')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:3px 10px">Save ${c} (${commodities[c]})</button>`,
        )
        .join('');
    }
    badgeEl.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${btns}</div>`;
  }
  // The Month / Billing Periods header + duplicate banner are written to the frozen
  // #pdfPillsHdr (outside the scroll area) so they stay pinned at the top. The pills
  // rows + JSON output go into pdfAIBox which lives in the scrollable body. Since the
  // frozen grid and the scroll grid both use .g-6040 with identical column widths,
  // the pills column aligns with the header column above it, and the JSON aligns with
  // the empty space to the right of the header.
  const pillsHdrEl = document.getElementById('pdfPillsHdr');
  if (pillsHdrEl) {
    pillsHdrEl.innerHTML = `${dupBannerHtml}<div style="display:flex;gap:10px">
        <div style="flex:0 0 auto;min-width:260px;display:flex;gap:8px;align-items:flex-end">
          <div class="ef-pill-sticky-month">Month</div>
          <div class="ef-pill-sticky-label">Billing Periods</div>
        </div>
      </div>`;
  }
  let commTabsHtml = '';
  if (_hasMultiComm) {
    const tabs = _uniqueComms;
    const _pf3 = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
    const _pillChgKeys2 = {
      Electric: [
        'CustomerCharge',
        'FacilitiesCharge',
        'BilledKWCharge',
        'EnergyOnPeakCharge',
        'EnergyOffPeakCharge',
        'ECACharge',
        'EERCharge',
        'PTSCharge',
        'TDCCharge',
        'RkVACharge',
        'TaxExemptDelivery',
        'BillOffset',
        'FranchiseFee',
      ],
      Gas: [
        'CustomerCharge',
        'GasCharge',
        'FuelAdjustment',
        'DeliveryCharge',
        'GasSystemReliability',
        'WeatherNormalization',
        'WinterEventCost',
        'FranchiseFee',
        'DelayedPaymentCharge',
      ],
      Water: ['WaterCharge', 'WaterProtectionFee', 'WaterDebtPayment', 'WaterFranchiseFee'],
      Sewer: ['SewerCharge', 'SewerFranchiseFee'],
      Stormwater: ['StormWaterCharge'],
      Propane: ['Subtotal', 'Tax'],
    };
    commTabsHtml =
      '<div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">' +
      tabs
        .map((t) => {
          const commBills = bills.filter((b) => (b.Commodity || 'Other') === t);
          const count = commBills.length;
          const chgKeys = _pillChgKeys2[t] || _pillChgKeys2.Electric;
          let issueCount = 0;
          commBills.forEach((b, ci) => {
            const bIdx = bills.indexOf(b);
            const bw = warnings[bIdx]?.warnings || [];
            const hasW = bw.some((w) => w.level === 'error' || w.level === 'warn');
            const cSum = chgKeys.reduce((s, f) => s + _pf3(b[f]), 0);
            const tVal = _pf3(b.TotalCurrentCharges);
            // Use the same scaled tolerance as the pill and detail banner: 1¢ per charge field,
            // minimum 2¢. Flat 0.02 caused false red issue-counts on multi-line KGS gas bills.
            const hasMM = tVal > 0 && cSum > 0 && Math.abs(cSum - tVal) >= Math.max(0.02, 0.01 * chgKeys.length);
            const hasGap = !!b._billing_gap;
            if (hasW || hasMM || hasGap) issueCount++;
          });
          const sel = t === activeCommTab;
          const issueTag =
            issueCount > 0 ? ` <span style="color:var(--red);font-weight:700">${issueCount}!</span>` : '';
          return `<button onclick="selectCommTab('${t}')" style="font-size:10px;padding:3px 10px;border-radius:4px;border:1px solid ${sel ? 'var(--accent)' : 'var(--border2)'};background:${sel ? 'var(--accent-dim)' : 'transparent'};color:${sel ? 'var(--accent)' : 'var(--text2)'};cursor:pointer;font-weight:${sel ? '700' : '400'}">${t === 'Stormwater' ? 'Storm' : t} (${count})${issueTag}</button>`;
        })
        .join('') +
      '</div>';
  }
  box.innerHTML = `<div style="display:flex;gap:10px;align-items:flex-start">
        <div class="ef-pill-col" style="flex:0 0 auto;min-width:260px">${commTabsHtml}${nav}</div>
        <pre style="flex:1;min-width:0;font-size:11px;color:var(--text);white-space:pre-wrap;word-break:break-word;margin:0">${JSON.stringify(b, null, 2)}</pre>
      </div>`;
}
function selectCommTab(tab) {
  window._pdfCommTab = tab;
  const bills = window._pdfMultiBills;
  if (!bills) return;
  // FIX(2026-07-09, item 219e6828 defect 1): clicking a commodity tab used to leave
  // window._pdfBuildingTab pointed at whatever account was selected before the click.
  // If that account has no bills under the newly-clicked commodity, the building tab
  // and commodity tab filters never overlap and "Monthly Billing Periods" renders
  // empty (see investigation-baldwin-2026-07-09.md) — the click looked dead. Re-point
  // the building tab (and the selected bill) at the first account that actually has
  // bills under the clicked commodity.
  const currentAcctHasTab = bills.some(
    (b) => (b.AccountNumber || '_unknown') === window._pdfBuildingTab && (b.Commodity || 'Other') === tab,
  );
  if (!currentAcctHasTab) {
    const firstBillIdx = bills.findIndex((b) => (b.Commodity || 'Other') === tab);
    if (firstBillIdx !== -1) {
      window._pdfBuildingTab = bills[firstBillIdx].AccountNumber || '_unknown';
      window._pdfMultiIdx = firstBillIdx;
    }
  }
  const box = document.getElementById('pdfAIBox');
  renderMultiBillUI(bills, box);
  const idx = window._pdfMultiIdx || 0;
  const billWarnings = (window._pdfBillWarnings || [])[idx]?.warnings || [];
  renderPDFFields(bills[idx], billWarnings);
}
function selectMultiBill(i) {
  const bills = window._pdfMultiBills;
  if (!bills) return;
  window._pdfMultiIdx = i;
  const box = document.getElementById('pdfAIBox');
  renderMultiBillUI(bills, box);
  const billWarnings = (window._pdfBillWarnings || [])[i]?.warnings || [];
  renderPDFFields(bills[i], billWarnings);
}
// Restore an auto-corrected field to its original OCR value and strip the correction marker,
// then re-render so the green border / checkmark / tooltip go away.
function revertAutoCorrect(field) {
  const bills = window._pdfMultiBills;
  const idx = window._pdfMultiIdx || 0;
  if (!bills || !bills[idx]) return;
  const b = bills[idx];
  const ac = b['_auto_corrected_' + field];
  if (!ac) return;
  b[field] = ac.original;
  delete b['_auto_corrected_' + field];
  const billWarnings = (window._pdfBillWarnings || [])[idx]?.warnings || [];
  renderPDFFields(b, billWarnings);
}
function revertOCRConsensus(field) {
  const bills = window._pdfMultiBills;
  const idx = window._pdfMultiIdx || 0;
  if (!bills || !bills[idx]) return;
  const b = bills[idx];
  const oc = b['_ocr_consensus_' + field];
  if (!oc) return;
  b[field] = oc.original;
  delete b['_ocr_consensus_' + field];
  const billWarnings = (window._pdfBillWarnings || [])[idx]?.warnings || [];
  renderPDFFields(b, billWarnings);
}
async function savePDFAllBills(commodityFilter) {
  const allBills = window._pdfMultiBills;
  if (!allBills || !allBills.length) return;
  const billIndices = [];
  for (let i = 0; i < allBills.length; i++) {
    if (commodityFilter && (allBills[i].Commodity || 'Other') !== commodityFilter) continue;
    billIndices.push(i);
  }
  if (!billIndices.length) return;
  const bills = allBills;
  let selectedPid = parseInt(document.getElementById('pdfProjSel').value) || null;
  const dupMap = window._pdfDupMap || {};
  await _ensureBatchPdfStored(bills);
  let inferredPid = selectedPid;
  const unassignedIdx = [];
  for (const i of billIndices) {
    if (dupMap[i] && dupMap[i].action === 'skip') continue;
    const r = _resolveBillDestination(bills[i], dupMap[i], inferredPid);
    if (r.method === 'match' && !inferredPid) {
      inferredPid = r.match.projId;
    }
    if (r.method === 'unassigned') unassignedIdx.push(i);
  }
  if (unassignedIdx.length > 0 && !inferredPid) {
    showToast(
      unassignedIdx.length +
        ' bill' +
        (unassignedIdx.length === 1 ? '' : 's') +
        " don't match an existing meter — select a project for those",
    );
    return;
  }
  if (unassignedIdx.length > 0 && inferredPid && !selectedPid) {
    selectedPid = inferredPid;
  }

  const summaryEntries = [];
  let saved = 0,
    skipped = 0,
    updated = 0,
    alreadyProcessed = 0,
    failed = 0;
  for (const i of billIndices) {
    const dup = dupMap[i];
    const period =
      (bills[i].BillingPeriodStart || bills[i].DeliveryDate || '?') +
      ' → ' +
      (bills[i].BillingPeriodEnd || bills[i].DeliveryDate || '?');
    const resolved = _resolveBillDestination(bills[i], dup, selectedPid);
    let status = null;
    let destination = resolved.destination;

    if (dup && dup.action === 'processed') {
      alreadyProcessed++;
      status = 'updated';
    } else if (dup && dup.action === 'skip') {
      skipped++;
      status = 'skipped';
    } else if (dup && (dup.action === 'overwrite' || dup.action === 'merge' || dup.action === 'field-select')) {
      const ok = await _applyDupUpdate(i, bills[i], dup);
      if (ok) {
        dup.action = 'processed';
        updated++;
        status = 'updated';
      } else {
        failed++;
        status = 'failed';
      }
    } else if (dup) {
      // Duplicate with no user-chosen action yet — default to merge (Bug #135:
      // overwrite was clobbering user-corrected data; merge only fills empty
      // fields so manual edits are preserved).
      dup.action = 'merge';
      const ok = await _applyDupUpdate(i, bills[i], dup);
      if (ok) {
        dup.action = 'processed';
        updated++;
        status = 'updated';
      } else {
        failed++;
        status = 'failed';
      }
    } else if (resolved.method === 'match' && resolved.match) {
      // Non-duplicate with a meter match — save straight to the matched meter,
      // no project selection needed.
      const dest = _saveBillToMatchedMeter(bills[i], resolved.match);
      if (dest) {
        destination = dest;
        saved++;
        status = 'saved';
      } else {
        failed++;
        status = 'failed';
      }
    } else {
      const ok = await _saveSinglePDFBill(bills[i], selectedPid);
      if (ok) {
        saved++;
        status = 'saved';
      } else {
        failed++;
        status = 'failed';
      }
    }
    summaryEntries.push({ period, status, destination, method: resolved.method });
  }
  const parts = [];
  if (saved) parts.push(saved + ' saved');
  if (updated) parts.push(updated + ' updated');
  if (alreadyProcessed) parts.push(alreadyProcessed + ' already processed');
  if (skipped) parts.push(skipped + ' skipped');
  if (failed) parts.push(failed + ' failed');
  const _blInherited2 = _inheritBaselinesForProject(selectedPid);
  const filterLabel = commodityFilter ? ' ' + commodityFilter : '';
  const blMsg = _blInherited2
    ? ' · ' + _blInherited2 + ' baseline' + (_blInherited2 !== 1 ? 's' : '') + ' inherited'
    : '';
  showToast(parts.join(', ') + ' (' + billIndices.length + filterLabel + ' total)' + blMsg);
  _showSaveSummary(summaryEntries);
  window._pdfBillsSaved = true;
}

async function _applyDupUpdate(billIdx, extracted, dup) {
  const toISO = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  };
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);

  if (dup.locationType === 'assigned') {
    // Update existing bill on meter
    const existing = dup.existing;
    // Keep this list complete — any extracted field that the Edit Billing Period
    // modal renders MUST have a row here, otherwise re-extracting a bill can't
    // backfill a missing value (merge/overwrite skip anything not in the map).
    const FIELD_MAP = {
      // Metadata (Update 84 — previously dropped on overwrite/merge)
      UtilityCompany: 'utilityCompany',
      CustomerName: 'customerName',
      ServiceAddress: 'serviceAddress',
      AccountNumber: 'accountNumber',
      MeterNumber: 'meterNumber',
      NumberOfDays: 'numberOfDays',
      MeterReadStart: 'meterReadStart',
      MeterReadEnd: 'meterReadEnd',
      StartRead: 'startRead',
      EndRead: 'endRead',
      ReadDifference: 'readDifference',
      MeterMultiplier: 'meterMultiplier',
      BillDate: 'billDate',
      Commodity: 'commodity',
      // Electric usage + charges
      kWhConsumed: 'kwh',
      ActualKW: 'demandKW',
      ActualRKVA: 'actualRKVA',
      BilledKW: 'billedKW',
      FacilitiesKW: 'facKW',
      FacilitiesCharge: 'facKWCost',
      TotalCurrentCharges: 'totalCost',
      RateSchedule: 'rateSchedule',
      OnPeakKWh: 'onPeakKwh',
      EnergyOnPeakKWh: 'onPeakKwh',
      OffPeakKWh: 'offPeakKwh',
      EnergyOffPeakKWh: 'offPeakKwh',
      CustomerCharge: 'customerCharge',
      BilledKWCharge: 'demandCharge',
      EnergyOnPeakCharge: 'onPeakCost',
      EnergyOffPeakCharge: 'offPeakCost',
      ECACharge: 'ecaCharge',
      EERCharge: 'eerCharge',
      PTSCharge: 'ptsCharge',
      TDCkW: 'tdcKW',
      TDCCharge: 'tdcCharge',
      RkVACharge: 'rkvaCharge',
      TaxExemptDelivery: 'taxExemptDelivery',
      BillOffset: 'billOffset',
      RenewableCharge: 'renewableCharge',
      SolarCredit: 'solarCredit',
      FranchiseFee: 'franchiseFee',
      // Per-unit rates from charge lines
      FacilitiesRate: 'facilitiesRate',
      DemandRate: 'demandRate',
      TDCRate: 'tdcRate',
      RkVARate: 'rkvaRate',
      OnPeakRate: 'onPeakRate',
      OffPeakRate: 'offPeakRate',
      ECARate: 'ecaRate',
      EERRate: 'eerRate',
      PTSRate: 'ptsRate',
      TotalKWRate: 'totalKwRate',
      TotalKWhRate: 'totalKwhRate',
      // Gas
      NaturalGasCCF: 'naturalGasCCF',
      NaturalGasTherms: 'naturalGasTherms',
      NaturalGasMMbtu: 'naturalGasMMbtu',
      GasCharge: 'gasCharge',
      FuelAdjustment: 'fuelAdjustment',
      // Water / Sewer / Stormwater
      WaterUsage: 'waterUsage',
      WaterCharge: 'waterCharge',
      WaterProtectionFee: 'waterProtectionFee',
      SewerUsage: 'sewerUsage',
      SewerCharge: 'sewerCharge',
      StormWaterCharge: 'stormWaterCharge',
      // Propane
      InvoiceNumber: 'invoiceNumber',
      SaleNumber: 'saleNumber',
      DeliveryDate: 'deliveryDate',
      FuelType: 'fuelType',
      GallonsDelivered: 'gallonsDelivered',
      UnitPrice: 'unitPrice',
      Subtotal: 'subtotal',
      Tax: 'tax',
      // KGS-specific fields (Fix 3)
      McfBilled: 'mcfBilled',
      DeliveryCharge: 'deliveryCharge',
      GasSystemReliability: 'gasSystemReliability',
      WinterEventCost: 'winterEventCost',
      PreviousBalance: 'previousBalance',
      PaymentsReceived: 'paymentsReceived',
      StatementDate: 'statementDate',
    };
    // Facilities is also stored in the newer `facilitiesCharge` key; keep both
    // synced when extraction provides a value, so the modal's Demand Charges
    // section and the legacy facKWCost field stay in agreement.
    if (extracted.FacilitiesCharge) existing.facilitiesCharge = extracted.FacilitiesCharge;

    // Page-range metadata lives on the extracted bill as _pageStart / _pageEnd
    // (from the %%PAGE_N%% markers inserted by extractPDFText). Any overwrite or
    // merge that lands a fresh extraction should pull those values through so the
    // Saved Bills PDF viewer slices to the correct pages. Without this copy the
    // old record keeps its stale (or null) page range and always opens the full PDF.
    const _copyPageRange = () => {
      console.log(
        '[_copyPageRange] billIdx',
        billIdx,
        'extracted pages',
        extracted._pageStart,
        '→',
        extracted._pageEnd,
        'shared key',
        extracted._pdfSharedKey,
      );
      if (extracted._pageStart) existing.pdfPageStart = extracted._pageStart;
      if (extracted._pageEnd) existing.pdfPageEnd = extracted._pageEnd;
      if (extracted._pdfSharedKey) {
        existing.pdfKey = 'en_pdf_shared_' + String(extracted._pdfSharedKey).replace(/^en_pdf_shared_/, '');
        existing.hasPDF = true;
        // renderBillRow gates the 📄 button on (row.pdfBillId && row.hasPDF).
        // Some older bills were saved without a pdfBillId (either via a legacy
        // code path or with the field cleared), so even after we set hasPDF=true
        // the gate still fails and the button stays hidden. Backfill it here.
        if (!existing.pdfBillId) {
          existing.pdfBillId = 'pb' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        }
      }
      console.log(
        '[_copyPageRange] after — existing pages',
        existing.pdfPageStart,
        '→',
        existing.pdfPageEnd,
        'pdfKey',
        existing.pdfKey,
      );
    };
    // Recalculate cost aggregates from whatever is currently on `existing` AFTER
    // the field-level updates have been applied. Reading back from existing (instead
    // of from the raw extracted payload) preserves values the user manually entered
    // in the Edit Billing Period modal. But we also have a SECOND safety rule:
    // never overwrite a valid aggregate with a NEW value that is materially lower
    // than the old one. A noisier re-extraction that misses some constituent charges
    // would otherwise overwrite a correct $4,821.93 kwhCost with $755.93 simply
    // because only the on-peak portion landed — that would silently corrupt the
    // Utility Data bills table. The only way an aggregate goes DOWN is if the user
    // explicitly overwrote (action === 'overwrite'), in which case we trust their
    // intent. For merge and field-select we keep the higher value.
    const preserveHigher = (label, newVal, oldRaw) => {
      const newNum = parseFloat(newVal);
      const oldNum = parseFloat(String(oldRaw || '').replace(/,/g, '')) || 0;
      if (dup.action === 'overwrite') return newVal; // trust explicit intent
      if (isNaN(newNum)) return oldRaw || '';
      // Allow small rounding drift but never a real decrease.
      if (oldNum > newNum + 0.5) return String(oldNum.toFixed(2));
      return newVal;
    };
    const _recalcAggregates = () => {
      const newKwhCost = (
        pf(existing.onPeakCost) +
        pf(existing.offPeakCost) +
        pf(existing.ecaCharge) +
        pf(existing.eerCharge) +
        pf(existing.ptsCharge)
      ).toFixed(2);
      const newKwCost = (pf(existing.demandCharge) + pf(existing.tdcCharge)).toFixed(2);
      // Tax exempt delivery and bill offset aren't stored in billRow, so they have
      // to come from the new extraction if the user asked to apply it; otherwise
      // customerCharge + rkvaCharge are the otherCost contributors we can still
      // reconstruct from the post-merge row.
      const newOtherCost = (
        pf(existing.customerCharge) +
        pf(existing.rkvaCharge) +
        pf(extracted.TaxExemptDelivery) +
        pf(extracted.BillOffset)
      ).toFixed(2);
      const newTaxCost = pf(existing.franchiseFee).toFixed(2);
      existing.kwhCost = preserveHigher('kwhCost', newKwhCost, existing.kwhCost);
      existing.kwCost = preserveHigher('kwCost', newKwCost, existing.kwCost);
      existing.otherCost = preserveHigher('otherCost', newOtherCost, existing.otherCost);
      existing.taxCost = preserveHigher('taxCost', newTaxCost, existing.taxCost);
    };
    if (dup.action === 'overwrite') {
      // Replace all mapped fields with extracted value when non-empty
      for (const [extKey, billKey] of Object.entries(FIELD_MAP)) {
        if (extracted[extKey] !== undefined && extracted[extKey] !== null && extracted[extKey] !== '') {
          existing[billKey] = extracted[extKey];
        }
      }
      // Apply ISO conversion to date fields written via FIELD_MAP
      if (existing.statementDate) existing.statementDate = toISO(existing.statementDate) || existing.statementDate;
      _copyPageRange();
      _recalcAggregates();
    } else if (dup.action === 'merge') {
      // Fill only empty fields
      for (const [extKey, billKey] of Object.entries(FIELD_MAP)) {
        if (
          (existing[billKey] == null || existing[billKey] === '') &&
          extracted[extKey] != null &&
          extracted[extKey] !== ''
        ) {
          existing[billKey] = extracted[extKey];
        }
      }
      // Apply ISO conversion to date fields written via FIELD_MAP
      if (existing.statementDate) existing.statementDate = toISO(existing.statementDate) || existing.statementDate;
      // Page range: only fill if missing, never overwrite a valid existing range
      if (!existing.pdfPageStart && extracted._pageStart) existing.pdfPageStart = extracted._pageStart;
      if (!existing.pdfPageEnd && extracted._pageEnd) existing.pdfPageEnd = extracted._pageEnd;
      if (!existing.pdfKey && extracted._pdfSharedKey) {
        existing.pdfKey = 'en_pdf_shared_' + String(extracted._pdfSharedKey).replace(/^en_pdf_shared_/, '');
        existing.hasPDF = true;
        if (!existing.pdfBillId) {
          existing.pdfBillId = 'pb' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        }
      }
      _recalcAggregates();
    } else if (dup.action === 'field-select') {
      // Apply per-field selections — #118: never write null/undefined over an existing value
      for (const d of dup.diffFields) {
        const useNew = dup.fieldSelections[d.key] !== false;
        if (useNew && FIELD_MAP[d.key]) {
          const newVal = extracted[d.key];
          if (newVal != null && newVal !== '') {
            existing[FIELD_MAP[d.key]] = newVal;
          }
          // If extracted is null/undefined, preserve the existing value unchanged
        }
      }
      _copyPageRange();
      _recalcAggregates();
    }
    saveUtilityData();
    return true;
  } else if (dup.locationType === 'saved') {
    // Update existing saved bill record
    const pdfBills = (await sget('en_pdf_bills', [])) || [];
    const sb = pdfBills.find((b) => b.id === dup.savedBillId);
    if (!sb) return false;
    if (dup.action === 'overwrite') {
      const COMPARE_KEYS = Object.keys(extracted).filter((k) => !k.startsWith('_'));
      for (const key of COMPARE_KEYS) {
        if (extracted[key] !== undefined && extracted[key] !== null && extracted[key] !== '') {
          sb[key] = extracted[key];
        }
      }
      // Copy fresh page range on overwrite so the PDF viewer slices correctly
      if (extracted._pageStart) sb.pdfPageStart = extracted._pageStart;
      if (extracted._pageEnd) sb.pdfPageEnd = extracted._pageEnd;
      if (extracted._pdfSharedKey) {
        sb.pdfKey = 'en_pdf_shared_' + String(extracted._pdfSharedKey).replace(/^en_pdf_shared_/, '');
        sb.hasPDF = true;
      }
    } else if (dup.action === 'merge') {
      const COMPARE_KEYS = Object.keys(extracted).filter((k) => !k.startsWith('_'));
      for (const key of COMPARE_KEYS) {
        if ((sb[key] == null || sb[key] === '') && extracted[key] != null && extracted[key] !== '') {
          sb[key] = extracted[key];
        }
      }
      // Fill missing page range without overwriting a valid existing one
      if (!sb.pdfPageStart && extracted._pageStart) sb.pdfPageStart = extracted._pageStart;
      if (!sb.pdfPageEnd && extracted._pageEnd) sb.pdfPageEnd = extracted._pageEnd;
      if (!sb.pdfKey && extracted._pdfSharedKey) {
        sb.pdfKey = 'en_pdf_shared_' + String(extracted._pdfSharedKey).replace(/^en_pdf_shared_/, '');
        sb.hasPDF = true;
      }
    } else if (dup.action === 'field-select') {
      // #118: never write null/undefined over an existing value
      for (const d of dup.diffFields) {
        const useNew = dup.fieldSelections[d.key] !== false;
        if (useNew && extracted[d.key] != null && extracted[d.key] !== '') {
          sb[d.key] = extracted[d.key];
        }
      }
      if (extracted._pageStart) sb.pdfPageStart = extracted._pageStart;
      if (extracted._pageEnd) sb.pdfPageEnd = extracted._pageEnd;
    }
    sb.savedAt = new Date().toISOString();
    // Promote from Saved Bills to meter if a match exists
    if (sb.pdfPageStart && !sb._pageStart) sb._pageStart = sb.pdfPageStart;
    if (sb.pdfPageEnd && !sb._pageEnd) sb._pageEnd = sb.pdfPageEnd;
    if (sb.pdfKey && !sb._pdfSharedKey) sb._pdfSharedKey = sb.pdfKey;
    const meterMatch = findMeterMatch(sb);
    // Gate (fix 11e47d64/9de73981, mirrors the saveQueuedBills b-46a984a0 identity
    // gate): only promote a Saved Bills record onto a meter when the match is
    // 'identity' grade (account/meter-number hit). An 'address'-only match is an
    // unconfirmed guess — promoting on that guess risks the same silent-overwrite
    // mechanism as the Louisburg Maintenance Building incident (11e47d64/9de73981)
    // if the promoted bill's period collides with an existing bill on the guessed
    // meter. On a non-identity match, leave the bill in Saved Bills — that is
    // already the safe review location, no extra action needed.
    if (meterMatch && meterMatch.matchType === 'identity') {
      const dest = _saveBillToMatchedMeter(sb, meterMatch);
      if (dest) {
        const removeIdx = pdfBills.indexOf(sb);
        if (removeIdx !== -1) pdfBills.splice(removeIdx, 1);
      }
    }
    await sset('en_pdf_bills', pdfBills);
    return true;
  }
  return false;
}
function renderPDFFields(parsed, warnings) {
  warnings = warnings || [];
  // Duplicate field comparison data
  const _dupIdx = window._pdfMultiIdx || 0;
  const _dupInfo = (window._pdfDupMap || {})[_dupIdx] || null;
  const _dupDiffSet = new Set((_dupInfo?.diffFields || []).map((d) => d.key));
  const _dupDiffMap = {};
  (_dupInfo?.diffFields || []).forEach((d) => {
    _dupDiffMap[d.key] = d;
  });
  const LABELS = {
    Commodity: 'Commodity',
    UtilityCompany: 'Utility Company',
    CustomerName: 'Customer Name',
    AccountNumber: 'Account Number',
    ServiceAddress: 'Service Address',
    RateSchedule: 'Rate Schedule',
    BillingPeriodStart: 'Billing Period Start',
    BillingPeriodEnd: 'Billing Period End',
    BillDate: 'Bill Date',
    DeliveryDate: 'Delivery Date',
    NumberOfDays: 'Number of Days',
    MeterReadStart: 'Meter Read Start',
    MeterReadEnd: 'Meter Read End',
    StartRead: 'Start Read',
    EndRead: 'End Read',
    ReadDifference: 'Read Difference',
    MeterMultiplier: 'Meter Multiplier',
    MeterNumber: 'Meter Number',
    kWhConsumed: 'kWh Consumed',
    ActualKW: 'Actual kW',
    ActualRKVA: 'Actual RKVA',
    CustomerCharge: 'Customer Charge',
    FacilitiesKW: 'Facilities kW',
    FacilitiesCharge: 'Facilities kW Charge',
    RkVACharge: 'RkVA Charge',
    BilledKW: 'Billed kW',
    BilledKWCharge: 'Billed kW Charge',
    OnPeakKWh: 'On-Peak kWh',
    OffPeakKWh: 'Off-Peak kWh',
    EnergyOnPeakCharge: 'Energy On-Peak Charge',
    EnergyOffPeakCharge: 'Energy Off-Peak Charge',
    ECACharge: 'ECA Charge',
    EERCharge: 'EER Charge',
    PTSCharge: 'PTS Charge',
    TDCkW: 'TDC kW',
    TDCCharge: 'TDC kW Charge',
    TaxExemptDelivery: 'Tax Exempt Delivery',
    BillOffset: 'Bill Offset',
    FranchiseFee: 'Franchise Fee',
    FranchiseFee1: 'Franchise Fee (1)',
    FranchiseFee2: 'Franchise Fee (2)',
    TotalCurrentCharges: 'Total Current Charges',
    TotalKWhRate: 'Total $/kWh Rate',
    TotalKWRate: 'Total $/kW Rate',
    OnPeakRate: 'On-Peak Rate',
    OffPeakRate: 'Off-Peak Rate',
    FacilitiesRate: 'Facilities Rate',
    DemandRate: 'Demand Rate',
    TDCRate: 'TDC Rate',
    RkVARate: 'RkVA Rate',
    ECARate: 'ECA Rate',
    EERRate: 'EER Rate',
    PTSRate: 'PTS Rate',
    NaturalGasTherms: 'Natural Gas Therms',
    NaturalGasCCF: 'Natural Gas (CCF)',
    NaturalGasMMbtu: 'Natural Gas (MMbtu)',
    ProductionMonth: 'Production Month',
    McfBilled: 'Usage (Mcf)',
    GasCharge: 'Gas Charge',
    FuelAdjustment: 'Fuel Adjustment',
    DeliveryCharge: 'Delivery Charge',
    GasSystemReliability: 'Gas System Reliability Surcharge',
    WeatherNormalization: 'Weather Normalization',
    WinterEventCost: 'Winter Event Securitized Cost',
    PreviousBalance: 'Previous Balance',
    PaymentsReceived: 'Payments Received',
    StatementDate: 'Statement Date',
    MeterReadPrevious: 'Meter Read (Previous)',
    MeterReadCurrent: 'Meter Read (Current)',
    WaterUsage: 'Water Usage (gal)',
    WaterCharge: 'Water Charge',
    WaterProtectionFee: 'Water Protection Fee',
    SewerUsage: 'Sewer Usage (gal)',
    SewerCharge: 'Sewer Charge',
    StormWaterCharge: 'Stormwater Charge',
    TotalAmountDue: 'Total Amount Due',
    PeakDemandKW: 'Peak Demand kW',
    InvoiceNumber: 'Invoice Number',
    SaleNumber: 'Sale Number',
    FuelType: 'Fuel Type',
    GallonsDelivered: 'Gallons Delivered',
    UnitPrice: 'Unit Price',
    Subtotal: 'Subtotal',
    Tax: 'Tax',
    Meter1_ReadStart: 'Read Start',
    Meter1_ReadEnd: 'Read End',
    Meter1_StartRead: 'Start Read',
    Meter1_EndRead: 'End Read',
    Meter1_ReadDiff: 'Read Difference',
    Meter1_Multiplier: 'Multiplier',
    Meter1_kWh: 'kWh Used',
    Meter1_KW: 'KW Used',
    Meter1_RKVA: 'RKVA Used',
    Meter2_ReadStart: 'Read Start',
    Meter2_ReadEnd: 'Read End',
    Meter2_StartRead: 'Start Read',
    Meter2_EndRead: 'End Read',
    Meter2_ReadDiff: 'Read Difference',
    Meter2_Multiplier: 'Multiplier',
    Meter2_kWh: 'kWh Used',
    Meter2_KW: 'KW Used',
    Meter2_RKVA: 'RKVA Used',
    // Wood River Energy per-site charge components (Fix 1 — a84458f0)
    _wreTriggerCharge: 'Trigger Charge',
    _wreIndexCharge: 'Index Charge',
    _wreSWECharge: 'SWE Charge',
    // WRE printed rates (source-faithful — from the Rate column of each charge line)
    _wreTriggerRate: 'Trigger Rate ($/MMBtu)',
    _wreIndexRate: 'Index Rate ($/MMBtu)',
  };
  // Fields that represent dollar charges — prefix with $ in display
  const CHARGE_FIELDS = new Set([
    'CustomerCharge',
    'FacilitiesCharge',
    'RkVACharge',
    'BilledKWCharge',
    'EnergyOnPeakCharge',
    'EnergyOffPeakCharge',
    'ECACharge',
    'EERCharge',
    'PTSCharge',
    'TDCCharge',
    'TaxExemptDelivery',
    'BillOffset',
    'FranchiseFee',
    'TotalCurrentCharges',
    'TotalAmountDue',
    'GasCharge',
    'WaterCharge',
    'SewerCharge',
    'StormWaterCharge',
    'WaterProtectionFee',
    'FuelAdjustment',
    'Subtotal',
    'Tax',
    'UnitPrice',
    // KGS-specific charge fields
    'DeliveryCharge',
    'GasSystemReliability',
    'WeatherNormalization',
    'WinterEventCost',
    'PreviousBalance',
    'PaymentsReceived',
    'FranchiseFee1',
    'FranchiseFee2',
    // WRE per-site charge components (Fix 1 — a84458f0)
    '_wreTriggerCharge',
    '_wreIndexCharge',
    '_wreSWECharge',
  ]);
  // Fields that MUST display with 4 decimal places (kW, kWh, meter reads per Evergy Billing Details rules)
  const FOURDP_FIELDS = new Set([
    'FacilitiesKW',
    'BilledKW',
    'ActualKW',
    'ActualRKVA',
    'TDCkW',
    'StartRead',
    'EndRead',
    'ReadDifference',
    'MeterMultiplier',
    'kWhConsumed',
    'Meter1_StartRead',
    'Meter1_EndRead',
    'Meter1_ReadDiff',
    'Meter1_Multiplier',
    'Meter1_kWh',
    'Meter1_KW',
    'Meter1_RKVA',
    'Meter2_StartRead',
    'Meter2_EndRead',
    'Meter2_ReadDiff',
    'Meter2_Multiplier',
    'Meter2_kWh',
    'Meter2_KW',
    'Meter2_RKVA',
  ]);
  // Fields that should NOT be number-formatted (show raw value from PDF)
  // Date fields are included so MM-DD-YY strings don't get parsed as numbers
  const ID_FIELDS = new Set([
    'AccountNumber',
    'MeterNumber',
    'InvoiceNumber',
    'SaleNumber',
    'Commodity',
    'FuelType',
    'BillingPeriodStart',
    'BillingPeriodEnd',
    'StatementDate',
    'BillDate',
    'DeliveryDate',
  ]);
  // ── Field layouts per commodity (Update 81) ──
  // Pick the layout based on the bill's Commodity / FuelType / UtilityCompany
  // so non-electric bills don't show empty Evergy charge rows.
  //   type: 'wide' = full width, 'pair' = two fields side-by-side,
  //         'charge-line' = qty | rate | charge | running total,
  //         'total' = total row with running check
  const _LAYOUT_ELECTRIC = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'MeterNumber'] },
    { section: 'Billing Period & Meter' },
    { type: 'pair', fields: ['RateSchedule', 'NumberOfDays'] },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['MeterReadStart', 'MeterReadEnd'] },
    { type: 'pair', fields: ['StartRead', 'EndRead'] },
    { type: 'pair', fields: ['ReadDifference', 'MeterMultiplier'] },
    { type: 'pair', fields: ['kWhConsumed', 'ActualRKVA'] },
    { section: 'Meter 1', condition: 'Meter1_ReadStart' },
    { type: 'pair', fields: ['Meter1_ReadStart', 'Meter1_ReadEnd'], condition: 'Meter1_ReadStart' },
    { type: 'pair', fields: ['Meter1_StartRead', 'Meter1_EndRead'], condition: 'Meter1_ReadStart' },
    { type: 'pair', fields: ['Meter1_ReadDiff', 'Meter1_Multiplier'], condition: 'Meter1_ReadStart' },
    { type: 'pair', fields: ['Meter1_kWh', 'Meter1_KW'], condition: 'Meter1_ReadStart' },
    { type: 'wide', fields: ['Meter1_RKVA'], condition: 'Meter1_ReadStart' },
    { section: 'Meter 2', condition: 'Meter2_ReadStart' },
    { type: 'pair', fields: ['Meter2_ReadStart', 'Meter2_ReadEnd'], condition: 'Meter2_ReadStart' },
    { type: 'pair', fields: ['Meter2_StartRead', 'Meter2_EndRead'], condition: 'Meter2_ReadStart' },
    { type: 'pair', fields: ['Meter2_ReadDiff', 'Meter2_Multiplier'], condition: 'Meter2_ReadStart' },
    { type: 'pair', fields: ['Meter2_kWh', 'Meter2_KW'], condition: 'Meter2_ReadStart' },
    { type: 'wide', fields: ['Meter2_RKVA'], condition: 'Meter2_ReadStart' },
    { section: 'Charges' },
    {
      type: 'charge-line-with-kw',
      label: 'Customer',
      chargeField: 'CustomerCharge',
      rateKey: 'CustomerCharge',
      kwField: 'ActualKW',
    },
    {
      type: 'charge-line',
      label: 'Facilities',
      chargeField: 'FacilitiesCharge',
      qtyField: 'FacilitiesKW',
      rateKey: 'FacilitiesCharge',
    },
    {
      type: 'charge-line',
      label: 'Billed',
      chargeField: 'BilledKWCharge',
      qtyField: 'BilledKW',
      rateKey: 'BilledKWCharge',
    },
    {
      type: 'charge-line',
      label: 'Energy On-Peak',
      chargeField: 'EnergyOnPeakCharge',
      qtyField: 'OnPeakKWh',
      rateKey: 'EnergyOnPeakCharge',
    },
    {
      type: 'charge-line',
      label: 'Energy Off-Peak',
      chargeField: 'EnergyOffPeakCharge',
      qtyField: 'OffPeakKWh',
      rateKey: 'EnergyOffPeakCharge',
    },
    { type: 'charge-line', label: 'RkVA', chargeField: 'RkVACharge', rateKey: 'RkVACharge' },
    { type: 'charge-line', label: 'Tax Exempt', chargeField: 'TaxExemptDelivery', rateKey: null },
    { type: 'charge-line', label: 'ECA', chargeField: 'ECACharge', rateKey: 'ECACharge' },
    { type: 'charge-line', label: 'EER', chargeField: 'EERCharge', rateKey: 'EERCharge' },
    { type: 'charge-line', label: 'PTS', chargeField: 'PTSCharge', rateKey: 'PTSCharge' },
    { type: 'charge-line', label: 'TDC', chargeField: 'TDCCharge', qtyField: 'TDCkW', rateKey: 'TDCCharge' },
    { type: 'charge-line', label: 'Bill Offset', chargeField: 'BillOffset', rateKey: null },
    { type: 'charge-line', label: 'Franchise Fee', chargeField: 'FranchiseFee', rateKey: null },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  const _LAYOUT_GAS = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate', 'NumberOfDays'] },
    { type: 'pair', fields: ['RateSchedule', 'BillFormat'] },
    { section: 'Meter Readings' },
    { type: 'pair', fields: ['MeterNumber', 'ReadDifference'] },
    { type: 'pair', fields: ['StartRead', 'EndRead'] },
    // Fix 3 (60de292d): show only the gas-unit field(s) that are present on this bill.
    // Each row has a condition so it is skipped when the field is null/empty.
    { type: 'pair', fields: ['NaturalGasTherms'], condition: 'NaturalGasTherms' },
    { type: 'pair', fields: ['NaturalGasCCF'], condition: 'NaturalGasCCF' },
    { type: 'pair', fields: ['NaturalGasMMbtu', 'ProductionMonth'], condition: 'NaturalGasMMbtu' },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Base', chargeField: 'CustomerCharge', rateKey: null },
    {
      type: 'charge-line',
      label: 'Gas',
      chargeField: 'GasCharge',
      qtyField: 'NaturalGasTherms',
      unit: 'Therms',
      rateKey: null,
    },
    // Fix 2 (a84458f0 defect 2): "Gas (MMbtu)" charge-line that used TotalCurrentCharges
    // caused a double-count (TCC appeared as both a charge component AND the total row).
    // Removed from _LAYOUT_GAS. WRE-specific charge rows live in _LAYOUT_WRE instead.
    { type: 'charge-line', label: 'Fuel Adjustment', chargeField: 'FuelAdjustment', rateKey: null },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  // Fix 1 + Fix 2 (a84458f0): Wood River Energy layout with per-site charge components.
  // Detected via _detectCommodity when b._utilityName === 'Wood River Energy'.
  // TotalCurrentCharges appears ONLY as the total row — NOT as a charge-line component.
  const _LAYOUT_WRE = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'MeterNumber'] },
    { type: 'pair', fields: ['CustomerNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate', 'ProductionMonth'] },
    { section: 'Meter Readings' },
    { type: 'pair', fields: ['NaturalGasMMbtu'] },
    { section: 'Charges' },
    // Per-site charge component lines (from Fix 1 extractor — a84458f0 defect 1)
    // _wreTriggerCharge/_wreIndexCharge/_wreSWECharge are underscore-prefixed, so they
    // are excluded from the extra-field tail by the startsWith('_') filter.
    // We reference them explicitly here via chargeField so they feed runningTotal correctly.
    // Note: underscore-prefixed fields work as chargeField since the renderer reads parsed[row.chargeField].
    {
      type: 'charge-line',
      label: 'Trigger - Fixed',
      chargeField: '_wreTriggerCharge',
      qtyField: '_wreTriggerMMbtu',
      unit: 'MMbtu',
      rateKey: null,
      printedRateField: '_wreTriggerRate',
    },
    {
      type: 'charge-line',
      label: 'Index (FOM)',
      chargeField: '_wreIndexCharge',
      qtyField: '_wreIndexMMbtu',
      unit: 'MMbtu',
      rateKey: null,
      printedRateField: '_wreIndexRate',
    },
    // Special Weather Event: only present on some invoices (hasSWE flag on the record)
    {
      type: 'charge-line',
      label: 'Special Weather Event',
      chargeField: '_wreSWECharge',
      rateKey: null,
      hideIfNull: true,
    },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  const _LAYOUT_WATER = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate', 'NumberOfDays'] },
    { section: 'Meter Readings' },
    { type: 'pair', fields: ['MeterNumber', 'RateSchedule'] },
    { type: 'pair', fields: ['StartRead', 'EndRead'] },
    { section: 'Charges' },
    { type: 'pair', fields: ['WaterUsage'] },
    {
      type: 'charge-line',
      label: 'Water',
      chargeField: 'WaterCharge',
      qtyField: 'WaterUsage',
      unit: 'Gal',
      rateKey: null,
    },
    { type: 'charge-line', label: 'Water Protection Fee', chargeField: 'WaterProtectionFee', rateKey: null },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  const _LAYOUT_SEWER = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate', 'NumberOfDays'] },
    { section: 'Charges' },
    { type: 'pair', fields: ['SewerUsage'] },
    {
      type: 'charge-line',
      label: 'Sewer',
      chargeField: 'SewerCharge',
      qtyField: 'SewerUsage',
      unit: 'Gal',
      rateKey: null,
    },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  const _LAYOUT_STORMWATER = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate', 'NumberOfDays'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Stormwater', chargeField: 'StormWaterCharge', rateKey: null },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  const _LAYOUT_PROPANE = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { type: 'pair', fields: ['InvoiceNumber', 'SaleNumber'] },
    { section: 'Delivery' },
    { type: 'pair', fields: ['DeliveryDate', 'FuelType'] },
    { type: 'pair', fields: ['GallonsDelivered', 'UnitPrice'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Subtotal', chargeField: 'Subtotal', rateKey: null },
    { type: 'charge-line', label: 'Tax', chargeField: 'Tax', rateKey: null },
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
  ];
  // KGS-specific layout (Fix 3 + Fix 4, Batch B):
  //   • Account Info → Billing Period & Meter → CHARGES section (runningTotal starts here)
  //     → {type:'total'} closes Charges → AMOUNT DUE section below (no runningTotal feed).
  //   • PreviousBalance/PaymentsReceived moved BELOW the total into Amount Due — they are
  //     balance-forward items, not current charges, and must NOT inflate the running sum.
  //   • Delivery/GSRS/WeatherNorm/CostOfGas get qtyField:'McfBilled',unit:'Mcf' so the
  //     renderer shows computed $/Mcf. Customer Charge stays fixed (no qtyField).
  //   • printedRateField on WeatherNorm and CostOfGas cross-references the printed per-Mcf
  //     rates captured by the extractor (WNAPerMcf / CostOfGasPerMcf) — renderer shows
  //     a mismatch indicator when computed vs printed rates differ by >5%.
  const _LAYOUT_KGS = [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'MeterNumber'] },
    { type: 'pair', fields: ['RateSchedule', 'StatementDate'] },
    { section: 'Billing Period & Meter' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['NumberOfDays', 'MeterMultiplier'] },
    { type: 'pair', fields: ['MeterReadPrevious', 'MeterReadCurrent'] },
    { type: 'pair', fields: ['McfBilled', 'NaturalGasTherms'] },
    { section: 'Charges' },
    // Service/Customer Charge: fixed fee, no per-unit qty
    { type: 'charge-line', label: 'Service Charge', chargeField: 'CustomerCharge', rateKey: null },
    // Delivery, GSRS, WeatherNorm, CostOfGas: per-Mcf charges — qtyField drives $/Mcf display
    {
      type: 'charge-line',
      label: 'Delivery Charge',
      chargeField: 'DeliveryCharge',
      qtyField: 'McfBilled',
      unit: 'Mcf',
      rateKey: null,
    },
    {
      type: 'charge-line',
      label: 'Gas System Reliability Surcharge',
      chargeField: 'GasSystemReliability',
      qtyField: 'McfBilled',
      unit: 'Mcf',
      rateKey: null,
    },
    {
      type: 'charge-line',
      label: 'Weather Normalization',
      chargeField: 'WeatherNormalization',
      qtyField: 'McfBilled',
      unit: 'Mcf',
      printedRateField: 'WNAPerMcf',
      rateKey: null,
    },
    {
      type: 'charge-line',
      label: 'Cost of Gas',
      chargeField: 'GasCharge',
      qtyField: 'McfBilled',
      unit: 'Mcf',
      printedRateField: 'CostOfGasPerMcf',
      rateKey: null,
    },
    // Winter Event: hideIfNull — invisible on bills without this charge
    {
      type: 'charge-line',
      label: 'Winter Event Securitized Cost',
      chargeField: 'WinterEventCost',
      rateKey: null,
      hideIfNull: true,
    },
    // KGS often has two Franchise Fee lines (state + local).
    // FranchiseFee1/2 hold individual values; FranchiseFee holds the sum used by
    // the gas sanity sum and taxCost — do NOT swap those downstream references.
    // Row (2) uses hideIfNull so it is invisible on single-FF bills.
    { type: 'charge-line', label: 'Franchise Fee (1)', chargeField: 'FranchiseFee1', rateKey: null },
    { type: 'charge-line', label: 'Franchise Fee (2)', chargeField: 'FranchiseFee2', rateKey: null, hideIfNull: true },
    // Total Current Charges closes the runningTotal accumulation
    { type: 'total', fields: ['TotalCurrentCharges'], chargeKey: 'TotalCurrentCharges' },
    // Amount Due section — balance-forward items below the total, NOT fed into runningTotal
    { section: 'Amount Due' },
    { type: 'pair', fields: ['PreviousBalance', 'PaymentsReceived'] },
    { type: 'pair', fields: ['TotalAmountDue'] },
  ];
  // Detect the commodity for this bill and pick a layout. Priority:
  // 1. KGS bills — detected by UtilityCompany name (gets dedicated layout with KGS field order)
  // 2. Wood River Energy — dedicated layout with per-site charge components (Fix 1+2, a84458f0)
  // 3. explicit Commodity field (Louisburg split + propane)
  // 4. FuelType field (propane fallback when Commodity missing)
  // 5. UtilityCompany name hints (generic gas / spire)
  // 6. Evergy / electric default
  const _detectCommodity = (b) => {
    const uc = (b.UtilityCompany || '').toLowerCase();
    if (/kansas\s*gas/.test(uc) || b._utilityName === 'Kansas Gas Service') return 'kgs';
    if (b._utilityName === 'Wood River Energy') return 'wre';
    const c = (b.Commodity || '').toLowerCase();
    if (c === 'gas') return 'gas';
    if (c === 'water') return 'water';
    if (c === 'sewer') return 'sewer';
    if (c === 'stormwater') return 'stormwater';
    if (c === 'propane' || b.FuelType) return 'propane';
    if (/spire|laclede|atmos|black\s*hills/.test(uc)) return 'gas';
    if (/propane|mfa\s*oil|fuel\s*oil/.test(uc)) return 'propane';
    return 'electric';
  };
  const _COMMODITY_LAYOUTS = {
    electric: _LAYOUT_ELECTRIC,
    gas: _LAYOUT_GAS,
    kgs: _LAYOUT_KGS,
    wre: _LAYOUT_WRE,
    water: _LAYOUT_WATER,
    sewer: _LAYOUT_SEWER,
    stormwater: _LAYOUT_STORMWATER,
    propane: _LAYOUT_PROPANE,
  };
  const FIELD_LAYOUT = _COMMODITY_LAYOUTS[_detectCommodity(parsed)] || _LAYOUT_ELECTRIC;
  const elHdr = document.getElementById('extractedFieldsHdr');
  const el = document.getElementById('extractedFieldsGrid');
  if (!elHdr || !el) return;
  // Collect all layout keys + any extra extracted fields not in layout
  const layoutKeys = new Set(
    FIELD_LAYOUT.flatMap((r) => [...(r.fields || []), r.chargeField, r.qtyField, r.kwField].filter(Boolean)),
  );
  // Fields that are displayed implicitly inside a charge-line row (e.g.
  // OnPeakKWh appears as the qty column on the Energy On-Peak charge-line
  // via `_rates.EnergyOnPeakCharge.parts[0].qty`, not as a dedicated
  // pair row) — exclude them from the "extras" tail so they don't render
  // as stray fields below the Total Current Charges row.
  const IMPLICITLY_RENDERED = new Set([
    'EnergyOnPeakKWh',
    'EnergyOffPeakKWh',
    'TotalAmountDue',
    'FacilitiesRate',
    'DemandRate',
    'TDCRate',
    'OnPeakRate',
    'OffPeakRate',
    'ECARate',
    'EERRate',
    'PTSRate',
    'TotalKWRate',
    'TotalKWhRate',
    'RkVARate',
    // KGS fields that appear inside layout rows or are diagnostic-only — must not
    // appear as stray extras below Total Current Charges:
    'FranchiseFee', // sum field; individual FF1/FF2 rows are in _LAYOUT_KGS
    'FranchiseFeeItems', // internal array used to build FF1/FF2
    'commodity', // lowercase alias sometimes stored alongside Commodity
    'StartRead', // in _LAYOUT_GAS pair; implicit for KGS (MeterReadPrevious used instead)
    'EndRead', // same
    'ReadDifference', // in _LAYOUT_GAS; not in KGS layout (computed from prev/curr reads)
    'WNAPerMcf', // printed rate — used by per-Mcf validation, shown via printedRateField
    'CostOfGasPerMcf', // same
  ]);
  // Also exclude null/undefined/'' values so empty diagnostic fields (NaturalGasCCF,
  // kWhConsumed on gas bills) don't render as blank cells below Total Current Charges.
  const extraKeys = Object.keys(parsed).filter(
    (k) =>
      !layoutKeys.has(k) && !IMPLICITLY_RENDERED.has(k) && !k.startsWith('_') && parsed[k] != null && parsed[k] !== '',
  );
  // Build warning lookup by field name
  const warnMap = {};
  for (const w of warnings) {
    if (!warnMap[w.field]) warnMap[w.field] = [];
    warnMap[w.field].push(w);
  }
  // Warning color map
  const wColor = { error: '#ef4444', warn: '#f59e0b', info: '#60a5fa' };
  const wBg = { error: 'rgba(239,68,68,.08)', warn: 'rgba(245,158,11,.08)', info: 'rgba(96,165,250,.06)' };
  const wBorder = { error: 'rgba(239,68,68,.3)', warn: 'rgba(245,158,11,.3)', info: 'rgba(96,165,250,.2)' };
  const wIcon = { error: '⛔', warn: '⚠️', info: 'ℹ️' };

  // Helper: build a single field cell HTML
  const _pf = (v) => (v ? parseFloat(String(v).replace(/[$,\s]/g, '')) || 0 : 0);
  // Escape double quotes and newlines so a message can live inside a title="..." attribute.
  const _titleEscape = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, ' ');
  function buildCell(k) {
    const v = parsed[k] ?? '';
    const fw = warnMap[k] || [];
    const magFlag = parsed['_magnitude_flag_' + k];
    const likelyMissing = parsed['_likely_missing_' + k];
    const autoCorrect = parsed['_auto_corrected_' + k];
    const ocrConsensus = parsed['_ocr_consensus_' + k];
    const isEmpty = v === null || v === undefined || v === '';
    const isDupDiff = _dupDiffSet.has(k);
    const dupDiff = _dupDiffMap[k];
    let borderStyle = '';
    if (isDupDiff)
      borderStyle = 'border-left:3px solid #f59e0b;padding-left:8px;background:rgba(245,158,11,.08);border-radius:4px';
    else if (autoCorrect || ocrConsensus) borderStyle = 'border-left:3px solid #22c55e;padding-left:8px';
    else if (fw.length) borderStyle = 'border-left:3px solid ' + wColor[fw[0].level] + ';padding-left:8px';
    else if (magFlag) borderStyle = 'border-left:3px solid #fb923c;padding-left:8px';
    else if (isEmpty) borderStyle = 'border-left:3px solid var(--border2);padding-left:8px;opacity:.7';
    // Build a compact icon strip — each icon carries the full explanation in its title
    // attribute (hover to see). This keeps cell heights uniform regardless of how much
    // warning/correction text there is.
    const _acIsCharge = CHARGE_FIELDS.has(k);
    const _acPfx = _acIsCharge ? '$' : '';
    const _acDp = _acIsCharge ? 2 : 4;
    // Unified inline-icon + hover-popup treatment for EVERY cell signal:
    //   auto-correct, OCR consensus, field warnings (error/warn/info), magnitude
    //   flag, and likely-missing. One icon shows inline next to the value; the
    //   popup aggregates every message and opens on hover of the whole cell.
    // Priority for inline icon color / popup level: ac > error > warn > info.
    const _pop = [];
    const _reverts = [];
    let _popLevel = null; // 'ac' | 'error' | 'warn' | 'info'
    const _bumpLevel = (lv) => {
      const order = { ac: 1, info: 2, warn: 3, error: 4 };
      if (!_popLevel || (order[lv] || 0) > (order[_popLevel] || 0)) _popLevel = lv;
    };
    if (autoCorrect) {
      const origFmt = _acPfx + parseFloat(autoCorrect.original).toFixed(_acDp);
      const corrFmt = _acPfx + parseFloat(autoCorrect.corrected).toFixed(_acDp);
      // Detect decimal-shift corrections: original and corrected share the
      // same digit sequence once $/commas/decimals are stripped (e.g.
      // "24708945" → "2470.8945", "5787840" → "578.7840"). Those don't
      // need a long descriptive reason — the value change speaks for itself.
      const _digits = (v) => String(v).replace(/[^\d]/g, '');
      const isDecimalShift = _digits(autoCorrect.original) === _digits(autoCorrect.corrected);
      const reasonSuffix = isDecimalShift ? '' : '. ' + _titleEscape(autoCorrect.reason || '');
      _pop.push(
        `<div style="margin-bottom:4px">&#10003; Corrected from <b>${origFmt}</b> &rarr; <b>${corrFmt}</b>${reasonSuffix}</div>`,
      );
      _reverts.push(`<button class="ef-ac-revert" onclick="revertAutoCorrect('${k}')">&#8634; Revert</button>`);
      _bumpLevel('ac');
    }
    if (ocrConsensus) {
      const origFmt = '$' + parseFloat(ocrConsensus.original).toFixed(2);
      const corrFmt = '$' + parseFloat(ocrConsensus.consensus).toFixed(2);
      _pop.push(
        `<div style="margin-bottom:4px">&#10003; Corrected from <b>${origFmt}</b> &rarr; <b>${corrFmt}</b>. Alternate OCR pass resolved sum mismatch</div>`,
      );
      _reverts.push(`<button class="ef-ac-revert" onclick="revertOCRConsensus('${k}')">&#8634; Revert</button>`);
      _bumpLevel('ac');
    }
    for (const w of fw) {
      _pop.push(`<div style="margin-bottom:4px">${wIcon[w.level]} ${_titleEscape(w.message)}</div>`);
      _bumpLevel(w.level);
    }
    if (magFlag) {
      const msg =
        'Possible OCR error: value is ' +
        magFlag.ratio.toFixed(1) +
        'x the historical average (' +
        magFlag.mean.toLocaleString(undefined, { maximumFractionDigits: 2 }) +
        '). Verify against source bill.';
      _pop.push(`<div style="margin-bottom:4px">&#9888; ${_titleEscape(msg)}</div>`);
      _bumpLevel('warn');
    }
    if (likelyMissing && isEmpty) {
      const msg = 'Historical data shows this field is present on 80%+ of prior bills — likely an OCR miss';
      _pop.push(`<div style="margin-bottom:4px">&#128269; ${_titleEscape(msg)}</div>`);
      _bumpLevel('info');
    }
    // Inline icon uses a single character + level color. Auto-correct keeps the
    // green checkmark even if other warnings are present (user wants the check next
    // to auto-corrected values).
    const _levelColor = { ac: '#22c55e', error: '#ef4444', warn: '#f59e0b', info: '#60a5fa' };
    const _levelIcon = { ac: '&#10003;', error: '⛔', warn: '⚠️', info: 'ℹ️' };
    const _inlineLevel = autoCorrect || ocrConsensus ? 'ac' : _popLevel;
    const acInlineIcon = _inlineLevel
      ? `<span class="ef-ico" style="color:${_levelColor[_inlineLevel]}">${_levelIcon[_inlineLevel]}</span>`
      : '';
    const _popClass = _popLevel && _popLevel !== 'ac' && !(autoCorrect || ocrConsensus) ? ` level-${_popLevel}` : '';
    const acTooltipHtml = _pop.length
      ? `<div class="ef-ac-tooltip${_popClass}">${_pop.join('')}${_reverts.join('')}</div>`
      : '';
    // Right-side icon strip is retired — all icons show inline next to the value.
    const iconsHtml = '';
    let displayVal = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (ID_FIELDS.has(k)) {
      displayVal = String(displayVal);
    } else if (typeof displayVal === 'string' && displayVal !== '') {
      const num = parseFloat(String(displayVal).replace(/,/g, ''));
      if (!isNaN(num) && String(displayVal).match(/^-?[\d,.\-]+$/)) {
        const isCharge = CHARGE_FIELDS.has(k);
        const isFourDp = FOURDP_FIELDS.has(k);
        // kW/kWh/meter reads: always 4dp. Charges: always 2dp. Other numbers: preserve original.
        const origDecimals = (String(displayVal).split('.')[1] || '').length;
        const minDp = isFourDp ? 4 : isCharge ? 2 : Math.min(origDecimals, 2);
        const maxDp = isFourDp ? 4 : isCharge ? 2 : Math.max(origDecimals, 2);
        const formatted = Math.abs(num).toLocaleString('en-US', {
          minimumFractionDigits: minDp,
          maximumFractionDigits: maxDp,
        });
        displayVal = (num < 0 ? '-' : '') + (isCharge ? '$' : '') + formatted;
      }
    }
    const keyStyle = isEmpty && !fw.length ? 'color:var(--text3)' : '';
    const inputStyle = isEmpty ? 'border-color:var(--border2);color:var(--text3)' : '';
    const dupKeyStyle = isDupDiff ? 'color:var(--amber)' : keyStyle;
    const acInputColor = autoCorrect || ocrConsensus ? ';color:#eab308' : '';
    const dupInputStyle = isDupDiff ? inputStyle + ';color:var(--amber)' : inputStyle + acInputColor;
    const dupIcon = isDupDiff
      ? `<span title="Existing value: ${(dupDiff.existVal || '(empty)').replace(/"/g, '&quot;')}" style="cursor:help;color:var(--amber);font-size:9px;font-weight:700;margin-left:4px;background:rgba(245,158,11,.18);padding:1px 4px;border-radius:3px;letter-spacing:.3px">&#9432; was: ${((dupDiff.existVal || '(empty)').length > 18 ? (dupDiff.existVal || '').slice(0, 15) + '...' : dupDiff.existVal || '(empty)').replace(/</g, '&lt;')}</span>`
      : '';
    // If there's any signal to show (correction, warning, mag flag, likely missing),
    // size the input to its value so the icon sits right next to the value instead
    // of at the far right of the cell.
    const _hasPopup = _pop.length > 0;
    const _fitSize = _hasPopup ? Math.max(String(displayVal).length + 1, 5) : null;
    const sizeAttr = _fitSize ? ` size="${_fitSize}"` : '';
    const inputHtml = `<input class="ef-input" value="${displayVal}" data-key="${k}" placeholder="${isEmpty ? '—' : ''}" style="${dupInputStyle}"${sizeAttr}>`;
    const keyHtml = `<div class="ef-key" style="${dupKeyStyle}">${LABELS[k] || k}${dupIcon}</div>`;
    // Every cell with a popup uses the fit-layout so the inline icon sits immediately
    // next to the value. Cells with no signals keep the full-width input.
    const bodyHtml = _hasPopup ? `<div class="ef-row-fit">${inputHtml}${acInlineIcon}</div>` : inputHtml;
    return `<div class="ef-item" style="${borderStyle}">${keyHtml}${bodyHtml}${acTooltipHtml}</div>`;
  }

  // Build layout HTML with running total on charge rows
  let runningTotal = 0;

  // Helper: build a read-only rate text box (not editable, just for display)
  function buildRateBox(label, value) {
    const empty = !value;
    const style = empty ? 'opacity:.5' : '';
    return `<div class="ef-item" style="${style}"><div class="ef-key">${label}</div><input class="ef-input" value="${value || '—'}" readonly style="color:var(--text2);font-size:11px" tabindex="-1"></div>`;
  }

  // Helper: build a charge cell with center-aligned value
  function buildChargeCell(k) {
    const html = buildCell(k);
    return html.replace('class="ef-item"', 'class="ef-item center"');
  }

  // Format numbers for display
  const fmtDollar = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  // kW/kWh quantities always render with 4 decimal places per Evergy Billing Details rules
  const fmtQty = (v, unit) =>
    v != null
      ? v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + ' ' + (unit || '')
      : '';
  const fmtRate = (r, unit) => {
    if (r == null) return '';
    const isKwh = (unit || '').toLowerCase().includes('h');
    return '$' + r.toFixed(isKwh ? 5 : 3) + '/' + (unit || '');
  };

  const totalVal = _pf(parsed.TotalCurrentCharges);
  // Fix 4 (d6f8f3a8): splice extra fields BEFORE the total row instead of appending after.
  // Build a mutable copy of the layout, find the last {type:'total'} entry, and insert
  // any extra-field pair rows immediately before it. This guarantees Total Current Charges
  // is always the last row regardless of provider.
  const _mutableLayout = [...FIELD_LAYOUT];
  if (extraKeys.length) {
    const _totalIdx = _mutableLayout.reduce((last, r, i) => (r.type === 'total' ? i : last), -1);
    const _extraPairRows = [];
    for (let _ei = 0; _ei < extraKeys.length; _ei += 2) {
      if (_ei + 1 < extraKeys.length)
        _extraPairRows.push({ type: 'pair', fields: [extraKeys[_ei], extraKeys[_ei + 1]] });
      else _extraPairRows.push({ type: 'pair', fields: [extraKeys[_ei]] });
    }
    if (_totalIdx >= 0) _mutableLayout.splice(_totalIdx, 0, ..._extraPairRows);
    else _mutableLayout.push(..._extraPairRows);
  }
  const rows = _mutableLayout.map((row) => {
    if (row.condition && !parsed[row.condition]) return '';
    if (row.section) return `<div class="ef-section">${row.section}</div>`;

    // ── charge-line-with-kw: charge row with a kW field in the first column ──
    if (row.type === 'charge-line-with-kw') {
      const chargeVal = _pf(parsed[row.chargeField]);
      runningTotal += chargeVal;
      const rtFmt = runningTotal.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const kwCell = row.kwField ? buildCell(row.kwField) : '<div></div>';
      const emptyCell = '<div></div>';
      return `<div class="ef-charge-row">${kwCell}${emptyCell}${buildChargeCell(row.chargeField)}<div class="ef-running">$${rtFmt}</div></div>`;
    }

    // ── charge-line: uniform qty | rate | charge | running total ──
    if (row.type === 'charge-line') {
      const ri = parsed._rates?.[row.rateKey];
      const parts = ri?.parts || [];
      const chargeVal = _pf(parsed[row.chargeField]);
      // For tiered energy, hide Off-Peak row and relabel On-Peak parts as Tier 1/2/3
      const isTiered = parsed._energyFormat === 'tiered';
      if (isTiered && row.chargeField === 'EnergyOffPeakCharge') return '';
      // hideIfNull: hide this row entirely when the field is absent/null on this bill
      // (used for Franchise Fee (2) on KGS bills that have only one FF line)
      if (row.hideIfNull && !parsed[row.chargeField]) return '';
      const base = isTiered && row.chargeField === 'EnergyOnPeakCharge' ? 'Energy' : row.label;

      // Determine the unit label for this charge (kW or kWh)
      // Energy charges are always kWh even if OCR drops the 'h'
      const ENERGY_CHARGES = new Set([
        'EnergyOnPeakCharge',
        'EnergyOffPeakCharge',
        'ECACharge',
        'EERCharge',
        'PTSCharge',
      ]);
      const unitLabel = ENERGY_CHARGES.has(row.chargeField) ? 'kWh' : parts[0]?.unit || ri?.unit || 'kW';

      // No rate data — still show editable qty & rate boxes so user can fill them in.
      // rateKey:null means this is a flat-dollar line (Tax Exempt / Bill Offset /
      // Franchise Fee / Gas / Water / etc.) — don't append a kW/kWh unit suffix
      // since there's no per-unit rate to speak of. Rate-bearing charges (RkVA,
      // EER, etc.) that happen to lack _rates data still keep their unit label.
      if (!row.rateKey || !ri) {
        runningTotal += chargeVal;
        const rtFmt = runningTotal.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const noRateLabel = row.rateKey ? base + ' ' + unitLabel : base;
        const qtyHtml = row.qtyField
          ? buildCell(row.qtyField)
          : `<div class="ef-item" style="opacity:.5"><div class="ef-key">${noRateLabel}</div><input class="ef-input" value="" data-key="_qty_${row.chargeField}" placeholder="—"></div>`;
        const qtyVal = row.qtyField ? parseFloat(parsed[row.qtyField]) || 0 : 0;
        const computedRate = qtyVal > 0 && chargeVal > 0 ? chargeVal / qtyVal : 0;
        const rateUnit = row.unit || '';
        let rateStr = computedRate > 0 ? '$' + computedRate.toFixed(5) + (rateUnit ? '/' + rateUnit : '') : '';
        // printedRateField cross-check: when the row declares a printed rate field
        // (e.g. WNAPerMcf / CostOfGasPerMcf on KGS rows) and the extractor captured
        // a valid value, show it alongside the computed rate and flag >5% mismatch.
        // Guard: skip entirely when printedRateField is absent, null, or NaN.
        if (row.printedRateField) {
          const _printedRaw = parsed[row.printedRateField];
          const _printedRate = _printedRaw != null ? parseFloat(String(_printedRaw).replace(/[$,\s]/g, '')) : NaN;
          if (_printedRate > 0 && computedRate > 0) {
            const _relDiff = Math.abs(computedRate - _printedRate) / _printedRate;
            const _mismatch = _relDiff > 0.05;
            const _printedFmt = '$' + _printedRate.toFixed(5) + (rateUnit ? '/' + rateUnit : '');
            const _warnGlyph = _mismatch
              ? ` <span title="Computed rate ($${computedRate.toFixed(5)}) differs from printed rate ($${_printedRate.toFixed(5)}) by ${(_relDiff * 100).toFixed(1)}%" style="color:#ef4444;font-weight:700;cursor:help">&#9888;</span>`
              : '';
            rateStr = (rateStr || _printedFmt) + ` (${_printedFmt} printed)${_warnGlyph}`;
          }
        }
        const rateHtml = buildRateBox(noRateLabel + ' Rate', rateStr);
        return `<div class="ef-charge-row">${qtyHtml}${rateHtml}${buildChargeCell(row.chargeField)}<div class="ef-running">$${rtFmt}</div></div>`;
      }

      // Full label with unit: "Energy On-Peak kWh", "Facilities kW"
      const qtyLabel = base + ' ' + unitLabel;

      // Single part — one row: qty | rate | charge | running total
      if (parts.length <= 1) {
        runningTotal += chargeVal;
        const rtFmt = runningTotal.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const p = parts[0] || ri;
        const qtyHtml = row.qtyField
          ? buildCell(row.qtyField)
          : `<div class="ef-item"><div class="ef-key">${qtyLabel}</div><input class="ef-input" value="${fmtQty(p.qty, unitLabel)}" data-key="_qty_${row.chargeField}"></div>`;
        return `<div class="ef-charge-row">${qtyHtml}${buildRateBox(qtyLabel + ' Rate', fmtRate(p.rate, unitLabel))}${buildChargeCell(row.chargeField)}<div class="ef-running">$${rtFmt}</div></div>`;
      }

      // Multiple parts — each part gets its own running total
      const partRows = parts
        .map((p, idx) => {
          const suffix =
            isTiered && row.chargeField === 'EnergyOnPeakCharge' ? ' Tier ' + (idx + 1) : ' (' + (idx + 1) + ')';
          // 2026-07-08 (louisburg-b14af0e3): Strategy B (_postExtractionVerify, ~line
          // 1810-1846) may already have corrected the FIELD-level charge
          // (parsed[row.chargeField]) from its rate-derived _rates[...].computed sum —
          // but it only ever rewrites the top-level field, never the stale per-part
          // p.ocrCharge this renderer has unconditionally preferred since before Strategy
          // B existed (commit 284e1c5). When a correction fired, trust the SAME computed
          // value Strategy B trusted for this part; otherwise keep the existing
          // OCR-dollar-first default (still correct for the common, uncorrected case).
          const _fieldWasCorrected = parsed['_auto_corrected_' + row.chargeField] != null;
          const partCharge =
            _fieldWasCorrected && p.computed != null ? p.computed : p.ocrCharge != null ? p.ocrCharge : p.computed;
          runningTotal += partCharge;
          const rtFmt = runningTotal.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const qtyHtml =
            idx === 0 && row.qtyField
              ? buildCell(row.qtyField)
              : `<div class="ef-item"><div class="ef-key">${qtyLabel}${suffix}</div><input class="ef-input" value="${fmtQty(p.qty, unitLabel)}" data-key="_qty_${row.chargeField}_${idx}"></div>`;
          const chargeHtml = `<div class="ef-item center"><div class="ef-key">${base} Charge${suffix}</div><input class="ef-input" value="${fmtDollar(partCharge)}" data-key="_chg_${row.chargeField}_${idx}" style="text-align:center"></div>`;
          return `<div class="ef-charge-row">${qtyHtml}${buildRateBox(qtyLabel + ' Rate' + suffix, fmtRate(p.rate, unitLabel))}${chargeHtml}<div class="ef-running">$${rtFmt}</div></div>`;
        })
        .join('');
      return partRows;
    }

    const fields = (row.fields || []).filter((k) => k in parsed || warnings.some((w) => w.field === k));
    if (!fields.length && row.type !== 'total') return '';
    if (row.type === 'wide') {
      // Issue b2f5ee0b: add 'wide' class so the cell spans both grid columns
      return buildCell(fields[0]).replace('class="ef-item"', 'class="ef-item wide"');
    }
    if (row.type === 'pair') {
      if (fields.length === 1) return `<div class="ef-pair">${buildCell(fields[0])}</div>`;
      return `<div class="ef-pair">${fields.map((k) => buildCell(k)).join('')}</div>`;
    }
    if (row.type === 'total') {
      const rtFmt = runningTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const match = totalVal > 0 && Math.abs(runningTotal - totalVal) < 0.02;
      const mismatch = totalVal > 0 && !match;
      const cls = match ? 'match' : mismatch ? 'mismatch' : '';
      const icon = match ? ' ✓' : mismatch ? ' ✗' : '';
      const itemStyle = match
        ? 'border:1px solid rgba(34,197,94,.3);background:rgba(34,197,94,.06)'
        : mismatch
          ? 'border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.06)'
          : '';
      const diff = totalVal > 0 ? totalVal - runningTotal : 0;
      const diffFmt = Math.abs(diff).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const diffLine = mismatch
        ? `<div style="font-size:10px;color:${diff >= 0 ? '#f59e0b' : '#ef4444'};margin-top:2px">Diff: ${diff >= 0 ? '+' : '-'}$${diffFmt}</div>`
        : '';
      // Compute total rates inline with Total Current Charges row
      let _kwhRateCell = '<div></div>',
        _kwRateCell = '<div></div>';
      if (parsed._rates || parsed.kWhConsumed) {
        const kwhRate = getExtractedRate(parsed, 'kwh');
        const kwRate = getExtractedRate(parsed, 'kw');
        if (kwhRate > 0)
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/kWh</div><input class="ef-input" value="$${kwhRate.toFixed(5)}/kWh" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        if (kwRate > 0)
          _kwRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/kW</div><input class="ef-input" value="$${kwRate.toFixed(3)}/kW" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
      }
      const _detectedComm = _detectCommodity(parsed);
      if (parsed.Commodity === 'Gas' || _detectedComm === 'gas' || _detectedComm === 'kgs') {
        const gasRate = getExtractedRate(parsed, 'gas');
        if (gasRate > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/Therm</div><input class="ef-input" value="$${gasRate.toFixed(5)}/Therm" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        }
      }
      if (parsed.Commodity === 'Water' || _detectCommodity(parsed) === 'water') {
        const waterRate = getExtractedRate(parsed, 'water');
        if (waterRate > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/Gal</div><input class="ef-input" value="$${waterRate.toFixed(5)}/Gal" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        }
      }
      if (parsed.Commodity === 'Propane' || _detectCommodity(parsed) === 'propane') {
        const propaneRate = getExtractedRate(parsed, 'propane');
        if (propaneRate > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/Gal</div><input class="ef-input" value="$${propaneRate.toFixed(5)}/Gal" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        }
      }
      if (parsed.Commodity === 'Sewer' || _detectCommodity(parsed) === 'sewer') {
        const sewerRate = getExtractedRate(parsed, 'sewer');
        const sewerCharge = parseFloat(parsed.SewerCharge) || 0;
        if (sewerRate > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Total $/Gal</div><input class="ef-input" value="$${sewerRate.toFixed(5)}/Gal" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        } else if (sewerCharge > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Sewer Charge</div><input class="ef-input" value="$${sewerCharge.toFixed(2)}" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        }
      }
      if (parsed.Commodity === 'Stormwater' || _detectCommodity(parsed) === 'stormwater') {
        const swCharge = parseFloat(parsed.StormWaterCharge) || parseFloat(parsed.TotalCurrentCharges) || 0;
        if (swCharge > 0) {
          _kwhRateCell = `<div class="ef-item"><div class="ef-key" style="color:var(--em);font-size:10px">Stormwater Charge</div><input class="ef-input" value="$${swCharge.toFixed(2)}" readonly style="color:var(--em);font-weight:600;text-align:center;background:transparent;border-color:transparent;font-size:11px"></div>`;
        }
      }
      return `<div style="border-top:2px solid var(--border);margin-top:4px;padding-top:4px"><div class="ef-charge-row">${_kwhRateCell}${_kwRateCell}<div class="ef-item center" style="${itemStyle}"><div class="ef-key" style="color:${match ? '#22c55e' : mismatch ? '#ef4444' : 'var(--text2)'}">Total Current Charges</div><input class="ef-input" value="${(parsed.TotalCurrentCharges ?? '') !== '' ? '$' + totalVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}" data-key="TotalCurrentCharges" style="font-weight:700;font-size:14px;text-align:center"></div><div class="ef-running ${cls}" style="font-weight:700;font-size:11px;flex-direction:column;align-items:flex-end"><span>$${rtFmt}${icon}</span>${diffLine}</div></div></div>`;
    }
    return '';
  });
  // Fix 4 (d6f8f3a8): extra fields are now spliced BEFORE the total row in _mutableLayout above.
  // Phase 2 tail-append removed — Total Current Charges is always the last layout row.
  // Add Field + Export buttons
  rows.push(
    `<div style="margin-top:8px;text-align:center;display:flex;gap:8px;justify-content:center"><button class="btn btn-ghost btn-sm" onclick="addExtractedField()" style="font-size:11px">+ Add Field</button><button class="btn btn-ghost btn-sm" onclick="exportCurrentBillJSON()" style="font-size:11px">Export JSON</button></div>`,
  );
  const fieldHtml = rows.filter(Boolean).join('');
  const missingHtml = '';

  // Compute sum mismatch from CURRENT data (not a stale stored flag). This is the
  // source of truth — the stored `_sum_mismatch` flag gets cleared by auto-correction
  // even when a small residual diff remains, but the pill and banner should reflect
  // what's actually in the data right now.
  const _CHARGE_SUM_KEYS_BY_COMMODITY = {
    Electric: [
      'CustomerCharge',
      'FacilitiesCharge',
      'BilledKWCharge',
      'EnergyOnPeakCharge',
      'EnergyOffPeakCharge',
      'ECACharge',
      'EERCharge',
      'PTSCharge',
      'TDCCharge',
      'RkVACharge',
      'TaxExemptDelivery',
      'BillOffset',
      'FranchiseFee',
      'SolarCredit',
      'RenewableCharge',
      // Baldwin City electric bills use ElectricCharge + FuelAdjustment instead of
      // Evergy-style per-charge fields. These are null on Evergy bills so they
      // contribute 0 and do not affect Evergy validation.
      'ElectricCharge',
      'FuelAdjustment',
    ],
    Gas: [
      'CustomerCharge',
      'GasCharge',
      'FuelAdjustment',
      'DeliveryCharge',
      'GasSystemReliability',
      'WeatherNormalization',
      'WinterEventCost',
      'FranchiseFee',
      'DelayedPaymentCharge',
    ],
    // 2026-07-08 (537c4e5e): _detectCommodity (~line 11053) returns 'kgs' for KGS bills
    // (keyed off UtilityCompany/_utilityName, checked BEFORE the Commodity field is even
    // consulted), and _DETECT_TO_SUM_KEY (~line 11578) maps that to 'Kgs' — but this map
    // had no 'Kgs' property, so the lookup fell through to
    // `|| _CHARGE_SUM_KEYS_BY_COMMODITY.Electric` and silently summed 2 of 17
    // Electric-only fields that happen to also exist on a KGS bill (CustomerCharge,
    // FranchiseFee), producing a false "SUM MISMATCH" banner next to the (correct)
    // green all-clear banner. Same 9-field list as Gas — KGS bills use identical charge
    // field names to standard Gas bills. validateBillData's gasCompSum (~165-199) and
    // analyzeBillExtraction's expectedTotal (~3609-3627) already use this exact 9-field
    // list correctly for KGS; only THIS map (renderPDFFields's own, independent copy)
    // lacked the entry.
    Kgs: [
      'CustomerCharge',
      'GasCharge',
      'FuelAdjustment',
      'DeliveryCharge',
      'GasSystemReliability',
      'WeatherNormalization',
      'WinterEventCost',
      'FranchiseFee',
      'DelayedPaymentCharge',
    ],
    Water: ['WaterCharge', 'WaterProtectionFee', 'WaterDebtPayment', 'WaterFranchiseFee'],
    Sewer: ['SewerCharge', 'SewerFranchiseFee'],
    Stormwater: ['StormWaterCharge'],
    Propane: ['Subtotal', 'Tax'],
    // WRE per-site charge components (Fix 1 — a84458f0).
    Wre: ['_wreTriggerCharge', '_wreIndexCharge', '_wreSWECharge'],
  };
  // Map _detectCommodity result (lowercase) to the PascalCase keys used above.
  // WRE must resolve to 'Wre' before falling through to 'Gas', since both have Commodity:'Gas'.
  const _DETECT_TO_SUM_KEY = {
    electric: 'Electric',
    gas: 'Gas',
    kgs: 'Kgs',
    wre: 'Wre',
    water: 'Water',
    sewer: 'Sewer',
    stormwater: 'Stormwater',
    propane: 'Propane',
  };
  const _detectedComm2 = _detectCommodity(parsed);
  const _billCommodity =
    _DETECT_TO_SUM_KEY[_detectedComm2] ||
    parsed.Commodity ||
    (parsed.kWhConsumed
      ? 'Electric'
      : parsed.NaturalGasTherms || parsed.NaturalGasCCF || parsed.GasCharge
        ? 'Gas'
        : 'Electric');
  const _CHARGE_SUM_KEYS_RPF = _CHARGE_SUM_KEYS_BY_COMMODITY[_billCommodity] || _CHARGE_SUM_KEYS_BY_COMMODITY.Electric;
  // Round each component to 2 decimal places before summing to prevent floating-point
  // accumulation across many addends (e.g. 9 KGS line items each rounded to the cent).
  const _currentChargeSum =
    Math.round(_CHARGE_SUM_KEYS_RPF.reduce((s, f) => s + Math.round(_pf(parsed[f]) * 100) / 100, 0) * 100) / 100;
  // Identify which charge fields are blank — the sum mismatch is usually caused by
  // one of these not being extracted, so we surface them in the banner.
  const _missingChargeFields = _CHARGE_SUM_KEYS_RPF.filter((f) => {
    const v = parsed[f];
    return v === null || v === undefined || v === '' || _pf(v) === 0;
  });
  // Bug 2f41298c: remove the _currentChargeSum > 0 guard so the banner fires when
  // charge fields are all blank but TotalCurrentCharges is populated — that IS a
  // mismatch (0 vs $50 for example) and the user must see an explanation for the
  // red pill. Previously, _currentChargeSum === 0 made _currentSumDiff = 0 so
  // hasCurrentSumMismatch was false even though the pill was already red.
  const _currentSumDiff = totalVal !== 0 ? _currentChargeSum - totalVal : 0;
  // Allow 1¢ per component of accumulated rounding before flagging a mismatch.
  // Flat 0.02 was too tight for multi-line KGS bills where rounding adds up across 9 fields.
  const _detailTol = Math.max(0.02, 0.01 * _CHARGE_SUM_KEYS_RPF.length);
  const hasCurrentSumMismatch = Math.abs(_currentSumDiff) >= _detailTol;
  const sumMismatch = parsed['_sum_mismatch'];
  // KGS-specific sum mismatch banner — mirrors the Evergy sumMismatchHtml handler below.
  // Fires when Pass B2 could not safely reconcile the KGS component sum against
  // TotalCurrentCharges (out-of-band residual, ambiguous candidates, or missed charge line).
  const _sumMismatchKgs = parsed['_sum_mismatch_kgs'];
  const sumMismatchKgsHtml = _sumMismatchKgs
    ? `<div style="padding:14px 18px;margin:10px 0;border-radius:10px;background:rgba(239,68,68,.22);border:2px solid #ef4444;color:#fecaca;font-size:14px;line-height:1.5;display:flex;align-items:flex-start;gap:12px;box-shadow:0 0 0 3px rgba(239,68,68,.08)">
        <span style="font-size:26px;line-height:1">&#9940;</span>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:800;color:var(--red);letter-spacing:.2px">KGS SUM MISMATCH &mdash; $${Math.abs(_sumMismatchKgs.residual).toFixed(2)} ${_sumMismatchKgs.residual > 0 ? 'UNDER' : 'OVER'} Total Current Charges</div>
          <div style="font-size:12px;font-weight:500;color:#fca5a5;margin-top:4px">KGS component sum is $${(_sumMismatchKgs.kgsSum || 0).toFixed(2)} but the bill total is $${(_sumMismatchKgs.totalCurrentCharges || 0).toFixed(2)}. Pass B2 could not safely auto-correct. Check the highlighted fields against the source PDF.</div>
          <div style="font-size:11px;font-family:var(--mono);margin-top:6px;line-height:1.6;color:#fca5a5">${_sumMismatchKgs.reason || ''}</div>
        </div>
      </div>`
    : '';
  // Big, loud banner for sum mismatch — this is a high-severity issue that must never be
  // lost in a sea of other notifications. Renders at the very top of the extracted fields.
  const _labelsMissing = _missingChargeFields
    .slice(0, 6)
    .map((f) => LABELS[f] || f)
    .join(', ');
  // Build per-field math breakdown for the sum mismatch banner so the user
  // can see exactly which values were added and where the gap comes from.
  const _sumMathParts = _CHARGE_SUM_KEYS_RPF
    .filter((f) => _pf(parsed[f]) !== 0 || !_missingChargeFields.includes(f))
    .map((f) => {
      const v = _pf(parsed[f]);
      const label = LABELS[f] || f;
      const style = v === 0 ? 'color:#f87171;font-style:italic' : 'color:#fecaca';
      return `<span style="${style}">${label}: $${v.toFixed(2)}</span>`;
    });
  const _sumMathLine = _sumMathParts.length
    ? `<div style="font-size:11px;font-family:var(--mono);margin-top:6px;line-height:1.8;color:#fca5a5">` +
      _sumMathParts.join(`<span style="color:#f87171;padding:0 4px">+</span>`) +
      `<span style="color:#f87171;padding:0 6px">=</span><strong style="color:#ef4444">$${_currentChargeSum.toFixed(2)}</strong>` +
      `<span style="color:#f87171;padding:0 6px">vs expected</span><strong style="color:#fecaca">$${totalVal.toFixed(2)}</strong>` +
      `<span style="color:#f87171;padding:0 6px">(off by $${Math.abs(_currentSumDiff).toFixed(2)})</span>` +
      `</div>`
    : '';
  const sumMismatchHtml = hasCurrentSumMismatch
    ? `<div style="padding:14px 18px;margin:10px 0;border-radius:10px;background:rgba(239,68,68,.22);border:2px solid #ef4444;color:#fecaca;font-size:14px;line-height:1.5;display:flex;align-items:flex-start;gap:12px;box-shadow:0 0 0 3px rgba(239,68,68,.08)">
        <span style="font-size:26px;line-height:1">&#9940;</span>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:800;color:var(--red);letter-spacing:.2px">SUM MISMATCH &mdash; $${Math.abs(_currentSumDiff).toFixed(2)} ${_currentSumDiff > 0 ? 'OVER' : 'UNDER'} Total Current Charges</div>
          <div style="font-size:12px;font-weight:500;color:#fca5a5;margin-top:4px">Charge sum is $${_currentChargeSum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} but the bill total is $${totalVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.${_labelsMissing ? ' Blank charges: <strong>' + _labelsMissing + '</strong>.' : ''} Check every field below against the source PDF.</div>
          ${_sumMathLine}
        </div>
      </div>`
    : '';

  // Banner for charge-exceeds-total validation
  const _cet = parsed['_charge_exceeds_total'];
  const chargeExceedsTotalHtml = _cet
    ? `<div style="padding:14px 18px;margin:10px 0;border-radius:10px;background:rgba(239,68,68,.22);border:2px solid #ef4444;color:#fecaca;font-size:14px;line-height:1.5;display:flex;align-items:flex-start;gap:12px;box-shadow:0 0 0 3px rgba(239,68,68,.08)">
        <span style="font-size:26px;line-height:1">&#9940;</span>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:800;color:var(--red);letter-spacing:.2px">LINE ITEM EXCEEDS TOTAL</div>
          <div style="font-size:12px;font-weight:500;color:#fca5a5;margin-top:4px">${_cet.reason}. This bill has impossible charges — verify against the source PDF.</div>
        </div>
      </div>`
    : '';

  // Show auto-correction banner if any fields were corrected (rate×qty or OCR consensus)
  const correctedFields = Object.keys(parsed)
    .filter((k) => k.startsWith('_auto_corrected_'))
    .map((k) => ({ field: k.replace('_auto_corrected_', ''), info: parsed[k], type: 'rate' }));
  const consensusFields = Object.keys(parsed)
    .filter((k) => k.startsWith('_ocr_consensus_'))
    .map((k) => ({ field: k.replace('_ocr_consensus_', ''), info: parsed[k], type: 'consensus' }));
  // KGS Pass B2 residual corrections — _auto_recovered_B2_<field> flags set when Pass B2
  // successfully recovered a period-as-digit OCR error via TotalCurrentCharges residual.
  // These use passB_value/corrected_to rather than original/corrected (different flag shape).
  const b2Fields = Object.keys(parsed)
    .filter((k) => k.startsWith('_auto_recovered_B2_'))
    .map((k) => ({ field: k.replace('_auto_recovered_B2_', ''), info: parsed[k], type: 'b2' }));
  const allCorrected = [...correctedFields, ...consensusFields, ...b2Fields];
  let correctionHtml = '';
  if (allCorrected.length) {
    const parts = allCorrected.map((c) => {
      const label = LABELS[c.field] || c.field;
      const _isChg = CHARGE_FIELDS.has(c.field);
      const _pfx = _isChg ? '$' : '';
      const _dp = _isChg ? 2 : 4;
      // b2 flags carry passB_value/corrected_to; rate flags carry original/corrected; consensus carries consensus
      const origVal = _pfx + parseFloat(c.type === 'b2' ? c.info.passB_value : c.info.original).toFixed(_dp);
      const newVal =
        _pfx +
        parseFloat(
          c.type === 'rate' ? c.info.corrected : c.type === 'b2' ? c.info.corrected_to : c.info.consensus,
        ).toFixed(_dp);
      const method =
        c.type === 'rate'
          ? c.info.reason
          : c.type === 'b2'
            ? 'KGS Pass B2 residual recovery' + (c.info.original_ocr ? ' (OCR read: ' + c.info.original_ocr + ')' : '')
            : 'alternate OCR pass';
      return (
        '<div style="margin:2px 0"><strong>' +
        label +
        '</strong> ' +
        origVal +
        ' → ' +
        newVal +
        ' <span style="color:var(--text3);font-weight:400">(' +
        method +
        ')</span></div>'
      );
    });
    // One-line summary that expands on click. No field names or reasons shown inline —
    // the user can click to drill in. Keeps this banner from dominating the panel.
    const _acLabels = allCorrected
      .slice(0, 3)
      .map((c) => LABELS[c.field] || c.field)
      .join(', ');
    const _acMoreCount = allCorrected.length > 3 ? ' +' + (allCorrected.length - 3) + ' more' : '';
    correctionHtml =
      '<details style="padding:6px 12px;margin:6px 0;border-radius:6px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.25);font-size:12px;color:var(--green);line-height:1.4">' +
      '<summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">' +
      '<span>✓ Auto-corrected <strong>' +
      allCorrected.length +
      ' field' +
      (allCorrected.length > 1 ? 's' : '') +
      '</strong> (' +
      _acLabels +
      _acMoreCount +
      ') — <span style="text-decoration:underline">click to see details</span>' +
      '</span></summary>' +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(34,197,94,.2);color:var(--text2);font-weight:500">' +
      parts.join('') +
      '</div>' +
      '</details>';
  }

  // Summary banner
  const errorCount = warnings.filter((w) => w.level === 'error').length;
  const warnCount = warnings.filter((w) => w.level === 'warn').length;
  const infoCount = warnings.filter((w) => w.level === 'info').length;
  // Sum mismatch is detected from current data (same source as the big banner above) so the
  // Data Analysis line and the big banner are always consistent.
  const hasSumIssue = hasCurrentSumMismatch;
  // FIX(2026-07-02, item 219e6828): `warnings` above is only ever the ONE
  // currently-displayed bill's own warning list — every call site passes a
  // single bill's warnings (e.g. renderPDFFields(finalBills[newestIdx],
  // analysisResults[newestIdx]?.warnings || [])). In a multi-bill batch, the
  // selected bill can be clean while its siblings aren't, which used to let
  // the green "All expected fields present" banner fire even when the batch
  // as a whole had warnings (the header badge, computed from the same
  // window._pdfBillWarnings source, would say "57 warnings" right above a
  // green all-clear). Compute the true batch-wide count here and never allow
  // an unqualified green banner while it's nonzero — show a batch-scoped
  // amber notice instead so a clean-looking bill doesn't imply a clean batch.
  const _pdfBatchBills = window._pdfMultiBills;
  const _pdfIsBatch = Array.isArray(_pdfBatchBills) && _pdfBatchBills.length > 1;
  const _pdfBatchWarnCount = _pdfIsBatch
    ? (window._pdfBillWarnings || []).reduce(
        (s, r) => s + (r?.warnings || []).filter((w) => w.level === 'error' || w.level === 'warn').length,
        0,
      )
    : 0;
  let summaryHtml = '';
  if (errorCount || warnCount) {
    const parts = [];
    if (errorCount) parts.push('<span style="color:var(--red);font-weight:700">' + errorCount + ' missing</span>');
    if (warnCount)
      parts.push(
        '<span style="color:var(--amber);font-weight:700">' +
          warnCount +
          ' warning' +
          (warnCount > 1 ? 's' : '') +
          '</span>',
      );
    if (infoCount)
      parts.push('<span style="color:var(--accent)">' + infoCount + ' note' + (infoCount > 1 ? 's' : '') + '</span>');
    // Build clickable field links for each warning
    const flaggedFields = warnings
      .filter((w) => w.level === 'error' || w.level === 'warn')
      .map((w) => {
        const label = LABELS[w.field] || w.field;
        const color = w.level === 'error' ? '#ef4444' : '#f59e0b';
        return `<a href="#" onclick="event.preventDefault();document.querySelector('.ef-input[data-key=\\'${w.field}\\']')?.closest('.ef-item')?.scrollIntoView({behavior:'smooth',block:'center'});document.querySelector('.ef-input[data-key=\\'${w.field}\\']')?.focus()" style="color:${color};text-decoration:underline;cursor:pointer;font-size:11px">${label}</a>`;
      });
    const flagLinks = flaggedFields.length
      ? '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0">' +
        flaggedFields.join('') +
        '</div>'
      : '';
    // Use red background if sum mismatch or errors, amber if only warnings.
    // Intentionally stronger than the green auto-corrected notice so new users don't
    // misread the green as "all resolved".
    const bannerBg = hasSumIssue || errorCount ? 'rgba(239,68,68,.16)' : 'rgba(245,158,11,.18)';
    const bannerBorder = hasSumIssue || errorCount ? '#ef4444' : '#f59e0b';
    const bannerTitleColor = hasSumIssue || errorCount ? '#ef4444' : '#f59e0b';
    const bannerIcon = hasSumIssue || errorCount ? '⛔' : '⚠️';
    summaryHtml =
      '<div style="padding:10px 14px;margin:8px 0;border-radius:8px;background:' +
      bannerBg +
      ';border:2px solid ' +
      bannerBorder +
      ';font-size:13px;color:var(--text);display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:600" title="Click a field to jump to it">' +
      '<span style="font-size:16px;line-height:1">' +
      bannerIcon +
      '</span>' +
      '<span style="flex:1;min-width:0;color:' +
      bannerTitleColor +
      ';font-weight:800;text-transform:uppercase;letter-spacing:.4px;font-size:12px">Data Analysis — ' +
      parts.join(' · ') +
      '</span>' +
      flagLinks +
      '</div>';
  } else if (_pdfIsBatch && _pdfBatchWarnCount > 0) {
    // This bill is clean, but the batch isn't — never show the green
    // all-clear here (see FIX comment above).
    summaryHtml =
      '<div style="padding:8px 12px;margin:8px 0;border-radius:6px;background:rgba(245,158,11,.14);border:1px solid #f59e0b;font-size:12px;color:var(--amber);font-weight:600">⚠️ ' +
      _pdfBatchWarnCount +
      ' warning' +
      (_pdfBatchWarnCount > 1 ? 's' : '') +
      ' across the batch — review before saving (this bill has none)</div>';
  } else if (correctedFields.length && !errorCount && !warnCount) {
    summaryHtml =
      '<div style="padding:8px 12px;margin:8px 0;border-radius:6px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);font-size:12px;color:var(--green)">✓ All expected fields present — ' +
      correctedFields.length +
      ' value' +
      (correctedFields.length > 1 ? 's' : '') +
      ' auto-corrected via rate × quantity</div>';
  } else if (warnings.length === 0 && Object.keys(parsed).filter((k) => !k.startsWith('_')).length > 5) {
    summaryHtml =
      '<div style="padding:8px 12px;margin:8px 0;border-radius:6px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);font-size:12px;color:var(--green)">✓ All expected fields present — values within normal ranges</div>';
  }

  // Duplicate info banner at top of extracted fields.
  // Re-lookup the dup entry by index at render time (do NOT rely on the _dupInfo
  // constant built at the top of this function — it can go stale if the dup map
  // mutates between the function start and this point, or if _pdfMultiIdx was
  // changed by a bulk action mid-flight). Fall through to a diagnostic banner if
  // the bill IS a duplicate but something stripped diffFields off the entry.
  let dupFieldBannerHtml = '';
  const _liveDup = (window._pdfDupMap || {})[_dupIdx] || null;
  const _anyDups = Object.keys(window._pdfDupMap || {}).length;
  if (_liveDup) {
    const diffs = Array.isArray(_liveDup.diffFields) ? _liveDup.diffFields : [];
    const diffCount = diffs.length;
    const actLabel = _liveDup.action ? ` &middot; <strong style="color:var(--em)">${_liveDup.action}</strong>` : '';
    // Freeze the current index into the onclick strings so the handlers target
    // this specific bill even if _pdfMultiIdx changes before the click fires.
    const bi = _dupIdx;
    const _dupLocLabel =
      _liveDup.locationType === 'saved'
        ? 'Found in: <strong>Saved Bills</strong>'
        : 'Found in: <strong>' + (_liveDup.location || 'meter bill data') + '</strong>';
    dupFieldBannerHtml = `<div style="padding:5px 10px;margin:4px 0;border-radius:6px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);font-size:11px;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
        <span style="color:var(--amber);font-weight:700;white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.3px">DUPLICATE BILL &middot; ${diffCount} field${diffCount === 1 ? '' : 's'} differ${actLabel}</span>
        <span style="font-size:10px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px" title="${_liveDup.locationType === 'saved' ? 'Found in: Saved Bills' : 'Found in: ' + (_liveDup.location || 'meter bill data')}">${_dupLocLabel}</span>
        <div style="display:flex;gap:4px;flex-shrink:0;margin-left:auto">
          <button onclick="window._pdfMultiIdx=${bi};window._dupModalIdx=${bi};overwriteDupBill()" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid rgba(239,68,68,.5);background:rgba(239,68,68,.12);color:var(--red);cursor:pointer;font-weight:700">Overwrite</button>
          <button onclick="window._pdfMultiIdx=${bi};window._dupModalIdx=${bi};mergeDupBill()" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid rgba(34,197,94,.5);background:rgba(34,197,94,.12);color:var(--green);cursor:pointer;font-weight:700">Merge</button>
          <button onclick="window._pdfMultiIdx=${bi};window._dupModalIdx=${bi};skipDupBill()" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer;font-weight:600">Skip</button>
          <button onclick="openDupModal(${bi})" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid rgba(245,158,11,.5);background:transparent;color:var(--amber);cursor:pointer;font-weight:600" title="Compare fields side-by-side">Compare</button>
        </div>
      </div>`;
  } else if (_anyDups > 0) {
    // Current bill index isn't in dupMap but the extraction DID find duplicates
    // elsewhere. Show a diagnostic stub so the user at least knows why the buttons
    // aren't here — and can jump to a known-dup bill. Without this, a user whose
    // selected pill happens to be non-dup sees nothing and assumes the feature is
    // broken.
    const firstDupKey = Object.keys(window._pdfDupMap || {})[0];
    dupFieldBannerHtml = `<div style="padding:8px 12px;margin:8px 0;border-radius:6px;background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.3);font-size:11px;color:var(--text2);display:flex;align-items:center;gap:8px">
        <span style="color:var(--accent);font-weight:700">&#9432;</span>
        <span style="flex:1">This bill is not a duplicate. ${_anyDups} other bill${_anyDups === 1 ? '' : 's'} in this extraction are duplicates.</span>
        <button onclick="selectMultiBill(${firstDupKey})" style="font-size:10px;padding:3px 10px;border-radius:4px;border:1px solid rgba(96,165,250,.4);background:transparent;color:var(--accent);cursor:pointer;font-weight:600">Jump to first duplicate</button>
      </div>`;
  }
  // Split output between the frozen header (title + banners) and the scrollable grid
  // body (the actual field cells). The header lives in #pdfFrozenHdr which is
  // flex-shrink:0, and the grid is in #pdfScrollBody which is the flex:1 overflow-y
  // scroll container — so everything above Account Info stays frozen exactly like
  // the Utility Data page, no position:sticky tricks required.
  const gapInfo = parsed._billing_gap;
  const gapHtml = gapInfo
    ? `<div style="padding:10px 14px;margin:8px 0;border-radius:8px;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:var(--amber);font-size:13px;display:flex;align-items:center;gap:8px">
            <span style="font-size:18px">&#9888;</span>
            <span><strong>${gapInfo.days}-day gap</strong> in ${gapInfo.commodity} billing before this period (previous ended ${gapInfo.afterPeriod})</span>
          </div>`
    : '';
  // Manual Assign button — shown when the bill has errors, a sum mismatch,
  // or is a _manualReview synthetic (unmatched page from extraction).
  // Bug 58119612: give users a recovery path when auto-parsing fails.
  const _showManualAssign = parsed._manualReview || hasCurrentSumMismatch || errorCount > 0;
  const _maBtnIdx = _dupIdx; // freeze current index
  const manualAssignHtml = _showManualAssign
    ? `<div style="margin:6px 0 4px;text-align:right">
              <button onclick="openManualAssignModal(${_maBtnIdx})" style="font-size:11px;padding:4px 12px;border-radius:5px;border:1px solid rgba(99,102,241,.5);background:rgba(99,102,241,.12);color:var(--accent);cursor:pointer;font-weight:700">
                &#128196; Manual Assign
              </button>
            </div>`
    : '';
  elHdr.innerHTML = `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--em);margin:12px 0 8px">Extracted — click values to edit</div>${sumMismatchHtml}${sumMismatchKgsHtml}${chargeExceedsTotalHtml}${gapHtml}${dupFieldBannerHtml}${summaryHtml}${correctionHtml}${manualAssignHtml}`;
  el.innerHTML = `<div class="ef-grid">${fieldHtml}${missingHtml}</div>`;

  // ── Wire up change handlers: update data + recalculate total when user edits ──
  el.querySelectorAll('.ef-input[data-key]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.key;
      if (!key) return;
      let val = inp.value.replace(/^\$/, '').replace(/,/g, '').trim();
      if (val === '' || val === '—') val = null;
      // Update the underlying bill data
      const bills = window._pdfMultiBills;
      const idx = window._pdfMultiIdx || 0;
      if (!bills || !bills[idx]) return;
      const b = bills[idx];
      b[key] = val;
      // Recalculate TotalCurrentCharges from charge sum when a charge field changes
      const CHARGE_SUM_FIELDS = [
        'CustomerCharge',
        'FacilitiesCharge',
        'BilledKWCharge',
        'EnergyOnPeakCharge',
        'EnergyOffPeakCharge',
        'ECACharge',
        'EERCharge',
        'PTSCharge',
        'TDCCharge',
        'RkVACharge',
        'TaxExemptDelivery',
        'BillOffset',
        'FranchiseFee',
      ];
      if (CHARGE_SUM_FIELDS.includes(key)) {
        const pf2 = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
        const compSum = CHARGE_SUM_FIELDS.reduce((s, f) => s + pf2(b[f]), 0);
        if (compSum > 0) {
          b.TotalCurrentCharges = compSum.toFixed(2);
        }
        // Clear stale sum mismatch since user manually corrected a value
        delete b._sum_mismatch;
      }
      // Re-render to update running total and validation display
      const billWarnings = (window._pdfBillWarnings || [])[idx]?.warnings || [];
      renderPDFFields(b, billWarnings);
    });
  });
}
/* ── SAVED BILLS DATABASE ── */
function updateBillCountBadge() {
  const b = (sget('en_pdf_bills', []) || []).filter((x) => !x.projId);
  const badge = document.getElementById('pdfBillCount');
  if (!badge) return;
  if (b.length > 0) {
    badge.textContent = b.length;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}
function openSavedBillsModal() {
  renderSavedBills();
  document.getElementById('savedBillsModal').classList.add('open');
}
function closeSavedBillsModal() {
  document.getElementById('savedBillsModal').classList.remove('open');
}

function renderSavedBills() {
  let bills = sget('en_pdf_bills', []) || [];
  // Remove bills that have already been assigned to a meter
  const origLen = bills.length;
  bills = bills.filter((b) => !b.projId);
  if (bills.length !== origLen) sset('en_pdf_bills', bills);
  const count = bills.length;
  updateBillCountBadge();
  const el = document.getElementById('savedBillsList');
  if (!count) {
    el.innerHTML =
      '<div style="padding:16px;font-size:13px;color:var(--text2);text-align:center">No unassigned bills. Assigned bills appear in the Utility Data bills table for their meter.</div>';
    return;
  }

  // Group bills by account/meter — reuse the same helper from core.js
  const groups = _groupSavedBills(bills);
  const hasMultiPeriodGroup = groups.some((g) => g.bills.length > 1);

  if (!hasMultiPeriodGroup) {
    // All singletons — use original flat card list, newest first
    const sorted = [...bills].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    el.innerHTML = sorted
      .map((b) => {
        const date = b.savedAt
          ? new Date(b.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '';
        const period =
          b.BillingPeriodStart && b.BillingPeriodEnd ? b.BillingPeriodStart + ' – ' + b.BillingPeriodEnd : '';
        const total = b.TotalCurrentCharges
          ? '$' + parseFloat(b.TotalCurrentCharges).toLocaleString('en-US', { minimumFractionDigits: 2 })
          : '';
        return `<div data-bill-id="${b.id}" style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:13px 15px;margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;transition:opacity .25s,transform .25s,max-height .3s;max-height:200px;overflow:hidden">
            <div>
              <div style="font-size:13px;font-weight:600;margin-bottom:3px">${b.CustomerName || b.AccountNumber || 'Unknown'} <span style="font-family:var(--mono);font-size:11px;color:var(--text2)">#${b.AccountNumber || '—'}</span></div>
              <div style="font-size:11px;color:var(--text2);display:flex;gap:12px;flex-wrap:wrap">
                ${period ? `<span>${period}</span>` : ''}
                ${b.ServiceAddress ? `<span>${b.ServiceAddress}</span>` : ''}
                ${total ? `<span style="color:var(--text)">${total}</span>` : ''}
                <span>Saved ${date}</span>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="btn btn-ghost btn-sm" onclick="viewSavedBill('${b.id}')">Data</button>
              ${b.hasPDF ? `<button class="btn btn-ghost btn-sm" onclick="viewSavedPDF('${b.id}',${b.pdfPageStart || 'null'},${b.pdfPageEnd || 'null'},'${b.pdfKey || ''}')">PDF</button>` : ''}
              <button class="btn btn-em btn-sm" onclick="openAssignModal('${b.id}')">Assign</button>
              <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteSavedBill('${b.id}')">Delete</button>
            </div>
          </div>`;
      })
      .join('');
    return;
  }

  // Grouped view: one card per account/meter group, with expand/collapse of periods
  el.innerHTML = groups
    .map((grp) => {
      const acctDisplay = grp.accountNumber || grp.meterNumber || '';
      const commodity = grp.commodity || '';
      const provider = grp.provider || '';
      // periods sorted oldest→newest within group (from _groupSavedBills)
      const periodItems = grp.bills
        .map((b) => {
          const period =
            b.BillingPeriodStart && b.BillingPeriodEnd ? b.BillingPeriodStart + ' – ' + b.BillingPeriodEnd : '—';
          const total = b.TotalCurrentCharges
            ? '$' + parseFloat(b.TotalCurrentCharges).toLocaleString('en-US', { minimumFractionDigits: 2 })
            : '';
          const date = b.savedAt
            ? new Date(b.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
          const srcFile = b._sourceFile || '';
          const srcBadge = srcFile
            ? `<span title="${srcFile}" style="font-size:9px;background:var(--s3);color:var(--text2);border-radius:3px;padding:1px 4px;margin-left:4px;cursor:default">${srcFile
                .split(/[/\\]/)
                .pop()
                .replace(/\.pdf$/i, '')}</span>`
            : '';
          return `<div data-bill-id="${b.id}" style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-top:1px solid var(--border);gap:8px;flex-wrap:wrap;transition:opacity .25s,transform .25s,max-height .3s;max-height:80px;overflow:hidden">
              <div style="font-size:11px;color:var(--text2);display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <span style="font-family:var(--mono);color:var(--text)">${period}</span>${srcBadge}
                ${total ? `<span style="color:var(--text)">${total}</span>` : ''}
                <span>Saved ${date}</span>
              </div>
              <div style="display:flex;gap:5px;flex-shrink:0">
                <button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="viewSavedBill('${b.id}')">Data</button>
                ${b.hasPDF ? `<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="viewSavedPDF('${b.id}',${b.pdfPageStart || 'null'},${b.pdfPageEnd || 'null'},'${b.pdfKey || ''}')">PDF</button>` : ''}
                <button class="btn btn-em btn-sm" style="font-size:10px" onclick="openAssignModal('${b.id}')">Assign</button>
                <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--red);border-color:var(--red)" onclick="deleteSavedBill('${b.id}')">Delete</button>
              </div>
            </div>`;
        })
        .join('');

      return `<div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;margin-bottom:8px;overflow:hidden">
          <div style="padding:11px 15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600">${grp.displayLabel}</span>
            ${acctDisplay ? `<span style="font-family:var(--mono);font-size:11px;color:var(--text2)">#${acctDisplay}</span>` : ''}
            ${commodity ? `<span style="font-size:11px;color:var(--text2)">${commodity}${provider ? ' · ' + provider : ''}</span>` : ''}
            <span style="background:var(--accent);color:#fff;font-size:10px;border-radius:10px;padding:1px 7px;font-weight:600">${grp.bills.length} period${grp.bills.length !== 1 ? 's' : ''}</span>
          </div>
          ${periodItems}
        </div>`;
    })
    .join('');
}

function viewSavedBill(id) {
  const bills = sget('en_pdf_bills', []) || [];
  const b = bills.find((b) => b.id === id);
  if (!b) return;
  // Close modal first so user can see the PDF view
  closeSavedBillsModal();
  // Strip internal metadata fields before displaying
  const display = Object.fromEntries(
    Object.entries(b).filter(
      ([k]) => !['id', 'savedAt', 'projId', 'projName', 'fromPDF', 'pdfBillId', 'hasPDF'].includes(k),
    ),
  );
  document.getElementById('pdfAIBox').textContent = JSON.stringify(display, null, 2);
  document.getElementById('extractMethodBadge').style.display = 'inline-block';
  document.getElementById('extractMethodBadge').textContent = '📂 Loaded from saved records';
  document.getElementById('extractMethodBadge').style.background = 'rgba(14,165,233,.12)';
  document.getElementById('extractMethodBadge').style.color = 'var(--em2)';
  document.getElementById('extractMethodBadge').style.border = '1px solid rgba(14,165,233,.25)';
  renderPDFFields(display);
  document.getElementById('pdfSaveRow').style.display = 'block';
  refreshProjDropdowns();
  showToast('Bill loaded ✓');
}

async function deleteSavedBill(id) {
  if (!(await confirmAsync('Delete this saved bill record? This cannot be undone.'))) return;
  // Update storage immediately
  let bills = sget('en_pdf_bills', []) || [];
  bills = bills.filter((b) => b.id !== id);
  await sset('en_pdf_bills', bills);
  // Also remove stored PDF file from IndexedDB (and legacy localStorage) to free storage
  pdfDelete('en_pdf_file_' + id);
  try {
    localStorage.removeItem('en_pdf_file_' + id);
  } catch (e) {}
  // Animate the card out so user sees the deletion
  const card = document.querySelector('[data-bill-id="' + id + '"]');
  if (card) {
    // Disable all buttons in the card to prevent double-clicks
    card.querySelectorAll('button').forEach((btn) => (btn.disabled = true));
    card.style.opacity = '0';
    card.style.transform = 'translateX(30px)';
    card.style.maxHeight = '0';
    card.style.padding = '0 15px';
    card.style.marginBottom = '0';
    card.style.borderColor = 'transparent';
    setTimeout(() => {
      renderSavedBills();
      updateBillCountBadge();
    }, 300);
  } else {
    renderSavedBills();
    updateBillCountBadge();
  }
  showToast('Record deleted');
}

// NOTE: this file loads after core.js, so this is the version of the global
// deleteAllSavedBills name that actually runs for BOTH callers:
//   1. The standalone PDF/OCR page's own "Delete All" button — calls deleteAllSavedBills()
//      with no argument, target = #savedBillsList.
//   2. The embedded Projects-tab Utility Data -> Saved Bills panel's "Delete All" button
//      (core.js renderProjSavedBills) — calls deleteAllSavedBills(projId), target =
//      #ptab-savedbills-body-<projId> via renderProjSavedBills(projId).
// core.js used to define its own deleteAllSavedBills(projId) that called
// renderProjSavedBills(projId) correctly, but it was dead code — shadowed by this
// parameterless function overwriting the global name once this script loaded. That left
// the embedded panel calling THIS function (ignoring its projId argument) and re-rendering
// the wrong, hidden standalone target, so the embedded panel never visually refreshed.
// Fix: accept the optional projId and route the re-render to the correct target instead
// of un-shadowing the dead core.js copy (which lacked this function's PDF/IndexedDB cleanup).
async function deleteAllSavedBills(projId) {
  const bills = sget('en_pdf_bills', []) || [];
  const unassigned = bills.filter((b) => !b.projId);
  if (!unassigned.length) {
    showToast('No saved bills to delete');
    return;
  }
  if (!(await confirmAsync('Delete all ' + unassigned.length + ' saved bill record(s)? This cannot be undone.')))
    return;
  // Delete all associated PDF files from IndexedDB + localStorage
  for (const b of unassigned) {
    pdfDelete('en_pdf_file_' + b.id);
    try {
      localStorage.removeItem('en_pdf_file_' + b.id);
    } catch (e) {}
  }
  // Keep only assigned bills (those with a projId)
  const remaining = bills.filter((b) => !!b.projId);
  await sset('en_pdf_bills', remaining);
  if (projId != null && typeof renderProjSavedBills === 'function') {
    renderProjSavedBills(projId);
  } else {
    renderSavedBills();
  }
  updateBillCountBadge();
  showToast('All ' + unassigned.length + ' saved bill(s) deleted');
}

// Scan all meters across all projects for a bill row matching id/pdfBillId.
// Used as a last-resort to recover a row's stored page range when the onclick
// passes null (e.g. a row that was saved before pdfPageStart was tracked). The
// search is O(total bills) but only runs on-demand when the viewer needs it.
function _findMeterBillById(id) {
  if (!id) return null;
  for (const proj of projects || []) {
    const udProj = getUDProj(proj.id);
    for (const b of udProj.buildings || []) {
      for (const m of b.meters || []) {
        for (const r of m.bills || []) {
          if (r.id === id || r.pdfBillId === id) return r;
        }
      }
    }
  }
  return null;
}

async function viewSavedPDF(id, pageStart, pageEnd, pdfKey) {
  console.log('[viewSavedPDF] called with', { id, pageStart, pageEnd, pdfKey });
  // Resolution order for the PDF bytes:
  //   1. IndexedDB per-bill key (legacy _saveSinglePDFBill path)
  //   2. IndexedDB shared key (the _ensureBatchPdfStored path)
  //   3. localStorage fallback at the shared key (when IndexedDB is blocked)
  //   4. legacy localStorage per-bill key
  //   5. last-resort: find record in en_pdf_bills and retry with its pdfKey
  let b64 = await pdfLoad('en_pdf_file_' + id);
  if (!b64 && pdfKey) b64 = await pdfLoad(pdfKey);
  if (!b64 && pdfKey) {
    try {
      b64 = localStorage.getItem(pdfKey);
    } catch (e) {}
  }
  if (!b64) b64 = sget('en_pdf_file_' + id, null);
  if (!b64) {
    const bills = sget('en_pdf_bills', []) || [];
    const rec = bills.find((b) => b.id === id || b.pdfBillId === id);
    if (rec?.pdfKey) {
      b64 = await pdfLoad(rec.pdfKey);
      if (!b64) {
        try {
          b64 = localStorage.getItem(rec.pdfKey);
        } catch (e) {}
      }
    }
    if (rec && !pageStart) {
      pageStart = rec.pdfPageStart;
      pageEnd = rec.pdfPageEnd;
    }
  }
  if (!b64) {
    console.warn('[viewSavedPDF] no PDF found for', { id, pageStart, pageEnd, pdfKey });
    showToast('PDF file not found — tried IndexedDB + localStorage for key ' + (pdfKey || '?'));
    return;
  }

  // Page range fallback ladder — run whenever we don't already have both start
  // and end, so we don't show the full PDF for a row that has a real range
  // somewhere else.
  //   (a) Scan the currently-loaded Utility Data meter bills (the row's live
  //       home). Works for bills that were saved via _applyDupUpdate or
  //       _saveBillToMatchedMeter.
  //   (b) Scan window._pdfMultiBills (the current extraction session) by
  //       period. Works when the row's stored pdfPageStart is still null (old
  //       row) but the user just re-extracted and the extractor populated
  //       _pageStart/_pageEnd on the in-memory bill — viewer gets the range
  //       even before the user runs a new Overwrite All.
  if ((!pageStart || !pageEnd) && id) {
    const meterRow = _findMeterBillById(id);
    if (meterRow) {
      console.log('[viewSavedPDF] meter row found', {
        stored: { pageStart: meterRow.pdfPageStart, pageEnd: meterRow.pdfPageEnd },
      });
      if (!pageStart) pageStart = meterRow.pdfPageStart;
      if (!pageEnd) pageEnd = meterRow.pdfPageEnd;
      // Also try matching a currently-extracted bill by period, in case the
      // meter row's stored values were written when _pageStart wasn't tracked.
      if ((!pageStart || !pageEnd) && Array.isArray(window._pdfMultiBills)) {
        const extMatch = window._pdfMultiBills.find((eb) => {
          const toISO = (d) => {
            if (!d) return '';
            if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            let p = d.split('/');
            if (p.length !== 3) p = d.split('-');
            if (p.length !== 3) return d;
            const yr = p[2].length === 2 ? '20' + p[2] : p[2];
            return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
          };
          return toISO(eb.BillingPeriodStart) === meterRow.start && toISO(eb.BillingPeriodEnd) === meterRow.end;
        });
        if (extMatch) {
          console.log('[viewSavedPDF] recovered pages from current extraction', {
            pageStart: extMatch._pageStart,
            pageEnd: extMatch._pageEnd,
          });
          if (!pageStart && extMatch._pageStart) pageStart = extMatch._pageStart;
          if (!pageEnd && extMatch._pageEnd) pageEnd = extMatch._pageEnd;
          // Persist back to the meter row so next click doesn't re-scan.
          if (pageStart && pageEnd) {
            meterRow.pdfPageStart = pageStart;
            meterRow.pdfPageEnd = pageEnd;
            saveUtilityData();
          }
        }
      }
    } else {
      console.warn('[viewSavedPDF] could not find meter row for id', id);
    }
  }

  console.log('[viewSavedPDF] final page range', { pageStart, pageEnd });
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let outBytes = bytes;
    let sliceMsg = 'Opening full PDF (no stored page range)';
    if (pageStart && pageEnd && window.PDFLib) {
      // pdf-lib's copyPages can throw internal errors ("can't access property
      // 'node', h is undefined") on PDFs with cross-reference issues or damaged
      // page nodes. Isolate the slice in its own try/catch so a slice failure
      // falls back to showing the full PDF instead of dead-ending the viewer.
      try {
        const srcDoc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const total = srcDoc.getPageCount();
        let start = Math.max(1, parseInt(pageStart, 10) || 1);
        let end = Math.min(total, parseInt(pageEnd, 10) || total);
        if (start > end) {
          console.warn('[viewSavedPDF] page range inverted, swapping', { start, end });
          const t = start;
          start = end;
          end = t;
        }
        if (start > total) {
          console.warn('[viewSavedPDF] pageStart exceeds total pages, falling back to full PDF', {
            pageStart,
            total,
          });
          sliceMsg =
            'Stored range ' + pageStart + '–' + pageEnd + ' is outside the PDF (' + total + ' pages). Full PDF.';
        } else {
          const idxs = [];
          for (let p = start; p <= end; p++) {
            const idx = p - 1;
            if (idx >= 0 && idx < total) idxs.push(idx);
          }
          if (idxs.length === 0) {
            console.warn('[viewSavedPDF] slice produced 0 valid indices, falling back to full PDF', {
              start,
              end,
              total,
            });
            sliceMsg = 'Slice range was empty — showing full PDF (' + total + ' pages)';
          } else {
            const outDoc = await window.PDFLib.PDFDocument.create();
            const copied = await outDoc.copyPages(srcDoc, idxs);
            copied.forEach((pg) => outDoc.addPage(pg));
            outBytes = await outDoc.save();
            sliceMsg = 'Showing pages ' + start + '–' + end + ' of ' + total + ' (' + idxs.length + ' pages)';
          }
        }
      } catch (sliceErr) {
        console.error('[viewSavedPDF] pdf-lib slice failed, falling back to full PDF:', sliceErr);
        sliceMsg = 'Slice failed (' + (sliceErr.message || 'pdf-lib error') + ') — showing full PDF';
        // outBytes is already `bytes` (the full PDF) — nothing else to do.
      }
    }
    console.log('[viewSavedPDF]', sliceMsg);
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    // Open the PDF in an in-page modal with the slice message banner at the
    // top so the user sees exactly what range was rendered without losing the
    // message to a new-tab context switch. Clicking 'Open in new tab' still
    // gives the native viewer experience if the user wants it.
    _showPdfModal(url, sliceMsg);
  } catch (e) {
    console.error('[viewSavedPDF] failed entirely:', e);
    showToast('Could not open PDF: ' + e.message);
  }
}

// In-page PDF viewer modal. Keeps the slice-state message visible alongside
// the PDF so feedback about page range / fallbacks is obvious.
function _showPdfModal(blobUrl, statusMsg) {
  const existing = document.getElementById('pdfViewerModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'pdfViewerModal';
  modal.className = 'modal-bg open';
  modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:10000';
  modal.onclick = (ev) => {
    if (ev.target === modal) _closePdfModal(modal, blobUrl);
  };
  modal.innerHTML =
    '<div class="modal" style="width:90vw;max-width:1100px;height:90vh;display:flex;flex-direction:column">' +
    '<div class="modal-hdr" style="flex-shrink:0">' +
    '<span class="modal-title">&#128196; PDF Viewer</span>' +
    '<button class="modal-x" onclick="document.getElementById(\'pdfViewerModal\').remove()">&#10005;</button>' +
    '</div>' +
    '<div style="padding:10px 16px;font-size:12px;color:var(--text);background:rgba(245,158,11,.12);border-bottom:1px solid rgba(245,158,11,.35);display:flex;align-items:center;gap:12px;flex-shrink:0">' +
    '<span style="font-size:14px">&#9432;</span>' +
    '<span style="flex:1;font-weight:600">' +
    statusMsg +
    '</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="window.open(\'' +
    blobUrl +
    '\',\'_blank\')" style="font-size:11px;padding:3px 10px">Open in new tab</button>' +
    '</div>' +
    '<div class="modal-body" style="padding:0;flex:1;min-height:0">' +
    '<iframe src="' +
    blobUrl +
    '" style="width:100%;height:100%;border:0" title="PDF viewer"></iframe>' +
    '</div></div>';
  document.body.appendChild(modal);
  // Revoke the blob URL when the modal is removed so we don't leak memory.
  const obs = new MutationObserver(() => {
    if (!document.getElementById('pdfViewerModal')) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (e) {}
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
}
function _closePdfModal(modal, blobUrl) {
  try {
    URL.revokeObjectURL(blobUrl);
  } catch (e) {}
  modal.remove();
}

/* ── ASSIGN MODAL ── */
let _assignBillId = null;
let _assignBillCommodity = '';
function openAssignModal(billId) {
  _assignBillId = billId;
  document.getElementById('abm-bill-id').value = billId;
  document.getElementById('abm-validation').style.display = 'none';
  // Populate projects
  const projSel = document.getElementById('abm-proj');
  projSel.innerHTML =
    '<option value="">— Select Project —</option>' +
    projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  // Pre-select if already assigned
  const bills = sget('en_pdf_bills', []) || [];
  const bill = bills.find((b) => b.id === billId);
  _assignBillCommodity = bill?.Commodity || '';
  if (bill?.projId) projSel.value = bill.projId;
  populateAssignBuildings();
  document.getElementById('assignBillModal').classList.add('open');
}
function closeAssignModal() {
  document.getElementById('assignBillModal').classList.remove('open');
  _assignBillId = null;
  _assignBillCommodity = '';
}
function populateAssignBuildings() {
  const pid = parseInt(document.getElementById('abm-proj').value);
  const bldgSel = document.getElementById('abm-bldg');
  if (!pid) {
    bldgSel.innerHTML = '<option value="">— Select project first —</option>';
    populateAssignMeters();
    return;
  }
  const udProj = getUDProj(pid);
  const bldgs = udProj.buildings || [];
  bldgSel.innerHTML =
    '<option value="">— Select Building —</option>' +
    bldgs.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  populateAssignMeters();
}
function populateAssignMeters() {
  const pid = parseInt(document.getElementById('abm-proj').value);
  const bid = document.getElementById('abm-bldg').value;
  const meterSel = document.getElementById('abm-meter');
  if (!pid || !bid) {
    meterSel.innerHTML = '<option value="">— Select building first —</option>';
    return;
  }
  const udProj = getUDProj(pid);
  const bldg = (udProj.buildings || []).find((b) => b.id === bid);
  const meters = (bldg?.meters || []).filter((m) => !_assignBillCommodity || m.commodity === _assignBillCommodity);
  if (!meters.length) {
    const commLabel = _assignBillCommodity || '';
    meterSel.innerHTML = `<option value="">No${commLabel ? ' ' + commLabel : ''} meters in this building</option>`;
    return;
  }
  meterSel.innerHTML = meters
    .map(
      (m) =>
        `<option value="${m.id}">${[m.commodity, m.provider, m.account ? '#' + m.account : '', m.maddr].filter(Boolean).join(' ')}</option>`,
    )
    .join('');
}
function confirmAssignBill() {
  const pid = parseInt(document.getElementById('abm-proj').value);
  const bid = document.getElementById('abm-bldg').value;
  const mid = document.getElementById('abm-meter').value;
  if (!pid || !bid || !mid) {
    showToast('Select project, building, and meter');
    return;
  }
  const bills = sget('en_pdf_bills', []) || [];
  const bill = bills.find((b) => b.id === _assignBillId);
  if (!bill) return;
  const proj = projects.find((p) => p.id === pid);
  if (!proj) return;
  const udProj = getUDProj(pid);
  const bldg = (udProj.buildings || []).find((b) => b.id === bid);
  if (!bldg) return;
  const meter = (bldg.meters || []).find((m) => m.id === mid);
  if (!meter) return;
  // Build billing row from bill data (same mapping as savePDFData)
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  const kwhCost = (
    pf(bill.EnergyOnPeakCharge) +
    pf(bill.EnergyOffPeakCharge) +
    pf(bill.ECACharge) +
    pf(bill.EERCharge) +
    pf(bill.PTSCharge)
  ).toFixed(2);
  const kwCost = (pf(bill.BilledKWCharge) + pf(bill.TDCCharge)).toFixed(2);
  const otherCost = (
    pf(bill.CustomerCharge) +
    pf(bill.TaxExemptDelivery) +
    pf(bill.BillOffset) +
    pf(bill.RkVACharge)
  ).toFixed(2);
  const taxCost = pf(bill.FranchiseFee).toFixed(2);
  const totalCost = pf(bill.TotalCurrentCharges);
  function toISO(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  }
  const billRow = {
    id: 'r' + Date.now(),
    start: toISO(bill.BillingPeriodStart || bill.DeliveryDate),
    end: toISO(bill.BillingPeriodEnd || bill.DeliveryDate),
    kwh: bill.kWhConsumed || '',
    demandKW: bill.ActualKW || '',
    billedKW: bill.BilledKW || '',
    facKW: bill.FacilitiesKW || '',
    facKWCost: bill.FacilitiesCharge || '',
    kwCost,
    kwhCost,
    otherCost,
    taxCost,
    totalCost: bill.TotalCurrentCharges || '',
    fromPDF: true,
    pdfBillId: bill.id,
    hasPDF: !!bill.hasPDF,
    rateSchedule: bill.RateSchedule || '',
    onPeakKwh: bill.OnPeakKWh || bill.EnergyOnPeakKWh || '',
    offPeakKwh: bill.OffPeakKWh || bill.EnergyOffPeakKWh || '',
    onPeakCost: bill.EnergyOnPeakCharge || '',
    offPeakCost: bill.EnergyOffPeakCharge || '',
    customerCharge: bill.CustomerCharge || '',
    demandCharge: bill.BilledKWCharge || '',
    facilitiesCharge: bill.FacilitiesCharge || '',
    ecaCharge: bill.ECACharge || '',
    eerCharge: bill.EERCharge || '',
    ptsCharge: bill.PTSCharge || '',
    tdcCharge: bill.TDCCharge || '',
    renewableCharge: bill.RenewableCharge || '',
    franchiseFee: bill.FranchiseFee || '',
    solarCredit: bill.SolarCredit || '',
    generationKwh: bill.GenerationKwh || '',
    Meter1_ReadStart: bill.Meter1_ReadStart || '',
    Meter1_ReadEnd: bill.Meter1_ReadEnd || '',
    Meter1_StartRead: bill.Meter1_StartRead || '',
    Meter1_EndRead: bill.Meter1_EndRead || '',
    Meter1_ReadDiff: bill.Meter1_ReadDiff || '',
    Meter1_Multiplier: bill.Meter1_Multiplier || '',
    Meter1_kWh: bill.Meter1_kWh || '',
    Meter1_KW: bill.Meter1_KW || '',
    Meter1_RKVA: bill.Meter1_RKVA || '',
    Meter2_ReadStart: bill.Meter2_ReadStart || '',
    Meter2_ReadEnd: bill.Meter2_ReadEnd || '',
    Meter2_StartRead: bill.Meter2_StartRead || '',
    Meter2_EndRead: bill.Meter2_EndRead || '',
    Meter2_ReadDiff: bill.Meter2_ReadDiff || '',
    Meter2_Multiplier: bill.Meter2_Multiplier || '',
    Meter2_kWh: bill.Meter2_kWh || '',
    Meter2_KW: bill.Meter2_KW || '',
    Meter2_RKVA: bill.Meter2_RKVA || '',
    // Non-electric commodity fields (matches _saveBillToMatchedMeter mapping)
    commodity: bill.Commodity || '',
    naturalGasCCF: bill.NaturalGasCCF || '',
    naturalGasTherms: bill.NaturalGasTherms || '',
    naturalGasMMbtu: bill.NaturalGasMMbtu || bill.naturalGasMMbtu || '',
    // Fix [therms-unit-2026-06-22]: canonicalize therms to Therms at save time.
    therms: (() => {
      const t = pf(bill.NaturalGasTherms);
      if (t) return t; // already Therms — Constellation/KGS
      const ccf = pf(bill.NaturalGasCCF);
      if (ccf) return Math.round(ccf * 1.037 * 100) / 100; // CCF → Therms
      const mm = pf(bill.NaturalGasMMbtu || bill.naturalGasMMbtu);
      if (mm) return Math.round(mm * 10 * 100) / 100; // MMBtu → Therms (×10)
      return '';
    })(),
    thermCost:
      bill.NaturalGasTherms || bill.NaturalGasCCF || bill.NaturalGasMMbtu || bill.naturalGasMMbtu
        ? bill.GasCharge || bill.TotalCurrentCharges || ''
        : '',
    gasCharge: bill.GasCharge || '',
    fuelAdjustment: bill.FuelAdjustment || '',
    waterUsage: bill.WaterUsage || '',
    waterCharge: bill.WaterCharge || '',
    waterProtectionFee: bill.WaterProtectionFee || '',
    sewerUsage: bill.SewerUsage || '',
    sewerCharge: bill.SewerCharge || '',
    stormWaterCharge: bill.StormWaterCharge || '',
    invoiceNumber: bill.InvoiceNumber || '',
    saleNumber: bill.SaleNumber || '',
    deliveryDate: bill.DeliveryDate || '',
    fuelType: bill.FuelType || '',
    gallonsDelivered: bill.GallonsDelivered || '',
    unitPrice: bill.UnitPrice || '',
    subtotal: bill.Subtotal || '',
    tax: bill.Tax || '',
    mcfBilled: bill.McfBilled || null,
    deliveryCharge: bill.DeliveryCharge || null,
    gasSystemReliability: bill.GasSystemReliability || null,
    winterEventCost: bill.WinterEventCost || null,
  };
  if (bill._rates) {
    const cp = {};
    for (const [k, v] of Object.entries(bill._rates)) {
      if (v.parts && v.parts.length > 1) {
        cp[k] = v.parts.map((p) => ({
          qty: p.qty || null,
          rate: p.rate || null,
          unit: p.unit || null,
          charge: p.ocrCharge != null ? p.ocrCharge : p.computed,
        }));
      }
    }
    if (Object.keys(cp).length) billRow._chargeParts = cp;
  }
  // Validation
  const componentSum = pf(bill.FacilitiesCharge) + pf(kwCost) + pf(kwhCost) + pf(otherCost) + pf(taxCost);
  const diff = Math.abs(componentSum - totalCost);
  if (totalCost > 0 && diff >= 0.1) {
    const vEl = document.getElementById('abm-validation');
    vEl.style.display = 'block';
    vEl.textContent =
      '⚠️ Components sum to $' +
      componentSum.toFixed(2) +
      ' but Total is $' +
      totalCost.toFixed(2) +
      ' (diff $' +
      diff.toFixed(2) +
      '). You can still assign but review the values.';
  }
  // Check for duplicate — merge new data with existing if found
  meter.bills = meter.bills || [];
  const dup = meter.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
  if (dup) {
    // Merge: keep existing data, fill in any new non-empty fields
    for (const [key, val] of Object.entries(billRow)) {
      if (key === 'id') continue; // keep existing ID
      const existing = dup[key];
      const newVal = val;
      // Update if existing is empty/null but new has data
      if (
        (!existing || existing === '' || existing === '0' || existing === '0.00') &&
        newVal &&
        newVal !== '' &&
        newVal !== '0' &&
        newVal !== '0.00'
      ) {
        dup[key] = newVal;
      }
      // Also update if new value is different and likely more accurate (from OCR re-extraction)
      if (newVal && newVal !== '' && existing !== newVal && billRow.fromPDF) {
        dup[key] = newVal;
      }
    }
  } else {
    meter.bills.push(billRow);
    meter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  }
  // Remove from Saved Bills after assignment — it's now in Utility Data
  const updatedBills = bills.filter((b) => b.id !== _assignBillId);
  sset('en_pdf_bills', updatedBills);
  // Update bill record with project assignment (in case it wasn't removed)
  bill.projId = pid;
  bill.projName = proj.name;
  saveUtilityData();
  closeAssignModal();
  renderSavedBills();
  showToast(
    (dup ? 'Bill merged with existing → ' : 'Bill assigned to ') + proj.name + ' → ' + meterLabel(meter) + ' ✓',
  );
}

/* ─────────────────────────────────────────────────────────────────
         MANUAL ASSIGN MODAL  (bug 58119612)
         Lets user assign an extracted PDF page to a specific meter and
         billing period when auto-parsing failed or produced errors.
      ───────────────────────────────────────────────────────────────── */
let _mamBillIdx = null; // which bill index in _pdfMultiBills we're assigning

function openManualAssignModal(billIdx) {
  _mamBillIdx = billIdx != null ? billIdx : window._pdfMultiIdx || 0;
  const valEl = document.getElementById('mam-validation');
  if (valEl) valEl.style.display = 'none';

  // Populate project dropdown
  const projSel = document.getElementById('mam-proj');
  projSel.innerHTML =
    '<option value="">— Select Project —</option>' +
    projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  // Pre-select the currently chosen project in pdfProjSel if one is set
  const curPid = document.getElementById('pdfProjSel')?.value;
  if (curPid) projSel.value = curPid;

  // Reset mode to "existing"
  const existingRadio = document.getElementById('mam-mode-existing');
  if (existingRadio) existingRadio.checked = true;
  mam_toggleMode();
  mam_populateBuildings();
  document.getElementById('manualAssignModal').classList.add('open');
}

function closeManualAssignModal() {
  document.getElementById('manualAssignModal').classList.remove('open');
  _mamBillIdx = null;
}

function mam_toggleMode() {
  const isNew = document.getElementById('mam-mode-new')?.checked;
  document.getElementById('mam-existing-section').style.display = isNew ? 'none' : 'block';
  document.getElementById('mam-new-section').style.display = isNew ? 'block' : 'none';
}

function mam_populateBuildings() {
  const pid = document.getElementById('mam-proj').value;
  const bldgSel = document.getElementById('mam-bldg');
  if (!pid) {
    bldgSel.innerHTML = '<option value="">— Select project first —</option>';
    mam_populateMeters();
    return;
  }
  const bldgs = getUDProj(parseInt(pid)).buildings || [];
  bldgSel.innerHTML =
    '<option value="">— Select Building —</option>' +
    bldgs.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  if (bldgs.length === 1) bldgSel.value = bldgs[0].id;
  mam_populateMeters();
}

function mam_populateMeters() {
  const pid = document.getElementById('mam-proj').value;
  const bid = document.getElementById('mam-bldg').value;
  const meterSel = document.getElementById('mam-meter');
  if (!pid || !bid) {
    meterSel.innerHTML = '<option value="">— Select building first —</option>';
    mam_populatePeriods();
    return;
  }
  const bldg = getUDBldg(parseInt(pid), bid);
  const meters = bldg?.meters || [];
  if (!meters.length) {
    meterSel.innerHTML = '<option value="">No meters in this building</option>';
    mam_populatePeriods();
    return;
  }
  meterSel.innerHTML =
    '<option value="">— Select Meter —</option>' +
    meters
      .map((m) => {
        const lbl = [m.commodity, m.provider, m.account ? '#' + m.account : '', m.maddr].filter(Boolean).join(' ');
        return `<option value="${m.id}">${lbl}</option>`;
      })
      .join('');
  if (meters.length === 1) meterSel.value = meters[0].id;
  mam_populatePeriods();
}

function mam_populatePeriods() {
  const pid = document.getElementById('mam-proj').value;
  const bid = document.getElementById('mam-bldg').value;
  const mid = document.getElementById('mam-meter').value;
  const periodSel = document.getElementById('mam-period');
  if (!pid || !bid || !mid) {
    periodSel.innerHTML = '<option value="">— Select a billing period —</option>';
    return;
  }
  const meter = getUDMeter(parseInt(pid), bid, mid);
  const bills = (meter?.bills || []).slice().sort((a, b) => _parseISO(b.start) - _parseISO(a.start));
  if (!bills.length) {
    periodSel.innerHTML = '<option value="">No existing periods — use "Create new"</option>';
    // Auto-switch to "new" mode if no periods exist
    const newRadio = document.getElementById('mam-mode-new');
    if (newRadio) {
      newRadio.checked = true;
      mam_toggleMode();
    }
    return;
  }
  periodSel.innerHTML =
    '<option value="">— Select a billing period —</option>' +
    bills
      .map((b) => {
        const range = b.start && b.end ? b.start + ' → ' + b.end : b.start || '(no dates)';
        const total = b.totalCost
          ? ' — $' + parseFloat(b.totalCost).toLocaleString('en-US', { minimumFractionDigits: 2 })
          : '';
        return `<option value="${b.id}">${range}${total}</option>`;
      })
      .join('');
}

function confirmManualAssign() {
  const pid = parseInt(document.getElementById('mam-proj').value);
  const bid = document.getElementById('mam-bldg').value;
  const mid = document.getElementById('mam-meter').value;
  const isNew = document.getElementById('mam-mode-new')?.checked;
  const valEl = document.getElementById('mam-validation');
  valEl.style.display = 'none';

  if (!pid || !bid || !mid) {
    valEl.style.display = 'block';
    valEl.textContent = 'Please select a project, building, and meter.';
    return;
  }

  const proj = projects.find((p) => p.id === pid);
  const meter = getUDMeter(pid, bid, mid);
  if (!proj || !meter) {
    valEl.style.display = 'block';
    valEl.textContent = 'Could not find the selected meter. Please try again.';
    return;
  }

  // Get the extracted bill data from the current extraction results
  const bills = window._pdfMultiBills;
  const billIdx = _mamBillIdx != null ? _mamBillIdx : window._pdfMultiIdx || 0;
  const extracted = bills && bills[billIdx] ? bills[billIdx] : null;
  if (!extracted) {
    valEl.style.display = 'block';
    valEl.textContent = 'No extracted bill data found for this page.';
    return;
  }

  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  function toISO(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let parts = String(d).split('/');
    if (parts.length !== 3) parts = String(d).split('-');
    if (parts.length !== 3) return d;
    const yr = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return yr + '-' + parts[0].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
  }

  // Build billing row from extracted data (same field mapping as savePDFData)
  const kwhCost = (
    pf(extracted.EnergyOnPeakCharge) +
    pf(extracted.EnergyOffPeakCharge) +
    pf(extracted.ECACharge) +
    pf(extracted.EERCharge) +
    pf(extracted.PTSCharge)
  ).toFixed(2);
  const kwCost = (pf(extracted.BilledKWCharge) + pf(extracted.TDCCharge)).toFixed(2);
  const otherCost = (
    pf(extracted.CustomerCharge) +
    pf(extracted.TaxExemptDelivery) +
    pf(extracted.BillOffset) +
    pf(extracted.RkVACharge)
  ).toFixed(2);
  const taxCost = pf(extracted.FranchiseFee).toFixed(2);

  // Determine dates — prefer user-entered dates if "new" mode, else use extracted
  let startDate, endDate;
  if (isNew) {
    startDate = document.getElementById('mam-start').value; // already YYYY-MM-DD
    endDate = document.getElementById('mam-end').value;
    if (!startDate || !endDate) {
      valEl.style.display = 'block';
      valEl.textContent = 'Please enter both start and end dates for the new billing period.';
      return;
    }
  } else {
    startDate = toISO(extracted.BillingPeriodStart || extracted.DeliveryDate);
    endDate = toISO(extracted.BillingPeriodEnd || extracted.DeliveryDate);
  }

  const usageQty =
    extracted.kWhConsumed ||
    extracted.NaturalGasTherms ||
    extracted.NaturalGasCCF ||
    extracted.NaturalGasMMbtu ||
    extracted.GallonsDelivered ||
    '';

  const newBillRow = {
    id: 'r' + Date.now(),
    start: startDate,
    end: endDate,
    utilityCompany: extracted.UtilityCompany || '',
    customerName: extracted.CustomerName || '',
    serviceAddress: extracted.ServiceAddress || '',
    accountNumber: extracted.AccountNumber || '',
    meterNumber: extracted.MeterNumber || '',
    numberOfDays: extracted.NumberOfDays || '',
    meterReadStart: extracted.MeterReadStart || '',
    meterReadEnd: extracted.MeterReadEnd || '',
    startRead: extracted.StartRead || '',
    endRead: extracted.EndRead || '',
    readDifference: extracted.ReadDifference || '',
    meterMultiplier: extracted.MeterMultiplier || '',
    billDate: extracted.BillDate || '',
    commodity: extracted.Commodity || '',
    kwh: usageQty,
    demandKW: extracted.ActualKW || '',
    billedKW: extracted.BilledKW || '',
    facKW: extracted.FacilitiesKW || '',
    facKWCost: extracted.FacilitiesCharge || '',
    tdcKW: extracted.TDCkW || '',
    kwCost,
    kwhCost,
    otherCost,
    taxCost,
    totalCost: extracted.TotalCurrentCharges || extracted.TotalAmountDue || '',
    rateSchedule: extracted.RateSchedule || '',
    onPeakKwh: extracted.OnPeakKWh || '',
    offPeakKwh: extracted.OffPeakKWh || '',
    onPeakCost: extracted.EnergyOnPeakCharge || '',
    offPeakCost: extracted.EnergyOffPeakCharge || '',
    customerCharge: extracted.CustomerCharge || '',
    demandCharge: extracted.BilledKWCharge || '',
    ecaCharge: extracted.ECACharge || '',
    eerCharge: extracted.EERCharge || '',
    ptsCharge: extracted.PTSCharge || '',
    tdcCharge: extracted.TDCCharge || '',
    franchiseFee: extracted.FranchiseFee || '',
    franchiseFee1: extracted.FranchiseFee1 || '',
    franchiseFee2: extracted.FranchiseFee2 || '',
    fromPDF: true,
    _manuallyAssigned: true,
    // Gas fields
    therms: extracted.NaturalGasTherms || extracted.NaturalGasMMbtu || '',
    ccf: extracted.NaturalGasCCF || '',
    naturalGasMMbtu: extracted.NaturalGasMMbtu || '',
    gasCost: extracted.GasCharge || extracted.TotalCurrentCharges || '',
    fuelAdj: extracted.FuelAdjustment || '',
    // Water/sewer fields
    waterUsage: extracted.WaterUsage || '',
    waterCost: extracted.WaterCharge || '',
    sewerUsage: extracted.SewerUsage || '',
    sewerCost: extracted.SewerCharge || '',
    stormCost: extracted.StormWaterCharge || '',
    // Propane
    gallons: extracted.GallonsDelivered || '',
    propaneCost: extracted.Subtotal || '',
  };

  meter.bills = meter.bills || [];

  if (!isNew) {
    // Overwrite an existing billing period
    const periodId = document.getElementById('mam-period').value;
    if (!periodId) {
      valEl.style.display = 'block';
      valEl.textContent = 'Please select a billing period to overwrite, or switch to "Create new".';
      return;
    }
    const existingIdx = meter.bills.findIndex((b) => b.id === periodId);
    if (existingIdx >= 0) {
      // Preserve the existing row's ID and merge in new values
      newBillRow.id = periodId;
      meter.bills[existingIdx] = Object.assign({}, meter.bills[existingIdx], newBillRow);
    } else {
      meter.bills.push(newBillRow);
    }
  } else {
    // Check if a period with the same start/end already exists
    const dup = meter.bills.find((b) => b.start === startDate && b.end === endDate);
    if (dup) {
      // Merge instead of creating a duplicate
      Object.assign(dup, newBillRow);
      newBillRow.id = dup.id;
    } else {
      meter.bills.push(newBillRow);
    }
    meter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  }

  saveUtilityData();
  closeManualAssignModal();

  // Mark this bill index as saved so it's no longer highlighted as needing action
  if (bills && bills[billIdx]) {
    bills[billIdx]._manuallyAssigned = true;
    bills[billIdx]._manualReview = false;
  }

  // Re-render to reflect the change
  const box = document.getElementById('pdfAIBox');
  if (box) renderMultiBillUI(bills, box);
  const updatedBill = bills && bills[billIdx] ? bills[billIdx] : null;
  if (updatedBill) {
    const bw = (window._pdfBillWarnings || [])[billIdx]?.warnings || [];
    renderPDFFields(updatedBill, bw);
  }

  const mLbl = [meter.commodity, meter.provider, meter.account ? '#' + meter.account : '', meter.maddr]
    .filter(Boolean)
    .join(' ');
  showToast('Assigned to ' + proj.name + ' → ' + mLbl + ' ✓');
}

// Auto-create a new meter (and building if needed) from extracted bill data.
// Called when _saveSinglePDFBill cannot find a meter match but the bill has
// enough identity information (AccountNumber or MeterNumber) to create one.
// Returns { bldg, meter } on success, or null if creation was skipped.
function _autoCreateMeterAndSaveBill(extracted, projId, billRow) {
  if (!projId) return null;
  const acctNum = extracted.AccountNumber || '';
  const meterNum = extracted.MeterNumber || '';
  if (!acctNum && !meterNum) return null;

  const udProj = getUDProj(projId);
  udProj.buildings = udProj.buildings || [];

  // Step 1: Duplicate guard — check if a meter with this account already exists
  // on any building in the project (handles re-uploads where findMeterMatch missed
  // due to commodity mismatch or minor format variation).
  const billComm = (extracted.Commodity || '').toLowerCase();
  const acctClean = acctNum.replace(/[\s\-]/g, '').toLowerCase();
  const meterClean = meterNum.replace(/[\s\-]/g, '').toLowerCase();
  for (const b of udProj.buildings) {
    for (const m of b.meters || []) {
      const ma = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
      const mm = (m.meter || '').replace(/[\s\-]/g, '').toLowerCase();
      const mComm = (m.commodity || '').toLowerCase();
      if ((_acctFuzzyMatch(acctClean, ma) || (meterClean && mm && meterClean === mm)) && mComm === billComm) {
        // Already exists — save bill to the existing meter instead of creating a duplicate
        m.bills = m.bills || [];
        const dup = m.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
        if (dup) {
          Object.assign(dup, billRow);
        } else {
          m.bills.push(billRow);
          m.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
        }
        if (typeof runBillValidation === 'function') runBillValidation(m, dup || billRow);
        if (typeof runBuildingValidation === 'function') runBuildingValidation(b);
        saveUtilityData();
        const bldgLabel = b.name || b.addr || b.id;
        showToast('Bill saved to existing meter ' + (acctNum || meterNum) + ' on ' + bldgLabel);
        return { bldg: b, meter: m };
      }
    }
  }

  // Step 2: Find the best building match by service address similarity (threshold 0.60).
  // If no building matches, find or create a single "Unmatched Bills" sentinel building.
  let targetBldg = null;
  const svcAddr = extracted.ServiceAddress || '';
  if (svcAddr) {
    let bestScore = 0;
    let bestBldg = null;
    for (const b of udProj.buildings) {
      const score = _addressSimilarity(svcAddr, b.addr || '');
      if (score > bestScore) {
        bestScore = score;
        bestBldg = b;
      }
      // Also check addrAliases
      for (const alias of b.addrAliases || []) {
        const aScore = _addressSimilarity(svcAddr, alias);
        if (aScore > bestScore) {
          bestScore = aScore;
          bestBldg = b;
        }
      }
    }
    // Gate (fix 11e47d64/9de73981, mirrors the saveQueuedBills b-46a984a0 identity
    // gate): bestScore/bestBldg above is an ADDRESS-similarity guess, never an
    // identity match — Steps 1/3 already tried account/meter-number identity
    // lookups and found nothing, which is why execution reached here. Auto-
    // committing a brand-new meter under a best-guess building risks the same
    // misattachment class as the Louisburg Maintenance Building incident
    // (11e47d64/9de73981), just shaped as a spurious new meter instead of an
    // overwrite. Do NOT auto-apply the address guess — intentionally do not set
    // targetBldg here, so a bill with no identity match always falls through to
    // the "Unmatched Bills" sentinel building below (visible in the project's
    // building list) for a human to review and reassign, rather than being
    // silently placed under a guessed building.
  }

  if (!targetBldg) {
    // Find or create a single "Unmatched Bills" sentinel building for this project
    targetBldg = udProj.buildings.find((b) => b._unmatchedSentinel === true);
    if (!targetBldg) {
      targetBldg = {
        id: 'b' + Date.now(),
        name: 'Unmatched Bills',
        addr: '',
        sqft: 0,
        zip: '',
        addrAliases: [],
        meters: [],
        _unmatchedSentinel: true,
      };
      udProj.buildings.push(targetBldg);
    }
  }

  // Step 3: Check if a meter with this account/commodity already exists on the target building
  // (in case the duplicate guard above missed a same-building re-upload scenario).
  targetBldg.meters = targetBldg.meters || [];
  for (const m of targetBldg.meters) {
    const ma = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
    const mm = (m.meter || '').replace(/[\s\-]/g, '').toLowerCase();
    const mComm = (m.commodity || '').toLowerCase();
    if ((_acctFuzzyMatch(acctClean, ma) || (meterClean && mm && meterClean === mm)) && mComm === billComm) {
      m.bills = m.bills || [];
      const dup = m.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
      if (dup) {
        Object.assign(dup, billRow);
      } else {
        m.bills.push(billRow);
        m.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
      }
      if (typeof runBillValidation === 'function') runBillValidation(m, dup || billRow);
      if (typeof runBuildingValidation === 'function') runBuildingValidation(targetBldg);
      saveUtilityData();
      const bldgLabel = targetBldg.name || targetBldg.addr || targetBldg.id;
      showToast('Bill saved to existing meter ' + (acctNum || meterNum) + ' on ' + bldgLabel);
      return { bldg: targetBldg, meter: m };
    }
  }

  // Step 4: Create the new meter
  const newMeter = {
    id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    commodity:
      extracted.Commodity ||
      (extracted.NaturalGasTherms || extracted.NaturalGasCCF || extracted.GasCharge
        ? 'Gas'
        : extracted.GallonsDelivered || extracted.FuelType
          ? 'Propane'
          : 'Electric'),
    provider: extracted.UtilityCompany || '',
    account: acctNum,
    meter: meterNum,
    maddr: svcAddr,
    inclusive: false,
    baselineInclude: true,
    billUnit: '',
    displayUnit: '',
    bills: [],
  };
  targetBldg.meters.push(newMeter);

  // Step 5: Save the bill to the new meter
  newMeter.bills.push(billRow);
  newMeter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  if (typeof runBillValidation === 'function') runBillValidation(newMeter, billRow);
  if (typeof runBuildingValidation === 'function') runBuildingValidation(targetBldg);

  saveUtilityData();

  const bldgLabel = targetBldg.name || targetBldg.addr || targetBldg.id;
  const acctLabel = acctNum || meterNum;
  showToast('Created meter ' + acctLabel + ' on ' + bldgLabel + ' — verify account details in Meter Settings');
  console.log('[_autoCreateMeterAndSaveBill] created meter', acctLabel, 'on building', bldgLabel);

  return { bldg: targetBldg, meter: newMeter };
}

async function _saveSinglePDFBill(extracted, projId) {
  if (!extracted || !extracted.UtilityCompany) return false;
  const proj = projId ? projects.find((p) => p.id === projId) : null;
  const pdfBills = (await sget('en_pdf_bills', [])) || [];
  const billId = 'pb' + Date.now();
  let hasPDF = false;
  if (pdfB64) {
    hasPDF = await pdfStore('en_pdf_file_' + billId, pdfB64);
  }
  const billRecord = {
    id: billId,
    savedAt: new Date().toISOString(),
    projId: projId || null,
    projName: proj?.name || 'General',
    hasPDF,
    ...extracted,
  };
  pdfBills.push(billRecord);
  await sset('en_pdf_bills', pdfBills);
  const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
  function toISO(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    let p = d.split('/');
    if (p.length !== 3) p = d.split('-');
    if (p.length !== 3) return d;
    const yr = p[2].length === 2 ? '20' + p[2] : p[2];
    return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
  }
  // Detect bill commodity type for correct field mapping
  const isGas = !!(
    extracted.NaturalGasTherms ||
    extracted.NaturalGasCCF ||
    extracted.GasCharge ||
    extracted.NaturalGasMMbtu
  );
  const isPropane = !!(extracted.GallonsDelivered || extracted.FuelType);
  // Electric cost breakdown
  const kwhCost = (
    pf(extracted.EnergyOnPeakCharge) +
    pf(extracted.EnergyOffPeakCharge) +
    pf(extracted.ECACharge) +
    pf(extracted.EERCharge) +
    pf(extracted.PTSCharge)
  ).toFixed(2);
  const kwCost = (pf(extracted.BilledKWCharge) + pf(extracted.TDCCharge)).toFixed(2);
  // otherCost: customer charge + tax-exempt delivery + bill offset + RkVA reactive
  // power charge. RkVA isn't shown as its own column in the bills table, so folding
  // it into otherCost here keeps the extracted value on the row (where the edit
  // modal and total validation can still see it) instead of silently dropping it.
  const otherCost = (
    pf(extracted.CustomerCharge) +
    pf(extracted.TaxExemptDelivery) +
    pf(extracted.BillOffset) +
    pf(extracted.RkVACharge)
  ).toFixed(2);
  const taxCost = pf(extracted.FranchiseFee).toFixed(2);
  const totalCost = pf(extracted.TotalCurrentCharges || extracted.TotalAmountDue);
  const componentSum = pf(extracted.FacilitiesCharge) + pf(kwCost) + pf(kwhCost) + pf(otherCost) + pf(taxCost);
  const diff = Math.abs(componentSum - totalCost);
  // Usage quantity: kWh for electric, CCF/therms for gas, gallons for propane
  const usageQty =
    extracted.kWhConsumed ||
    extracted.NaturalGasTherms ||
    extracted.NaturalGasCCF ||
    extracted.NaturalGasMMbtu ||
    extracted.GallonsDelivered ||
    '';
  const billRow = {
    id: 'r' + Date.now(),
    start: toISO(extracted.BillingPeriodStart || extracted.DeliveryDate),
    end: toISO(extracted.BillingPeriodEnd || extracted.DeliveryDate),
    // Metadata (Update 84 — previously dropped on single-PDF save path)
    utilityCompany: extracted.UtilityCompany || '',
    customerName: extracted.CustomerName || '',
    serviceAddress: extracted.ServiceAddress || '',
    accountNumber: extracted.AccountNumber || '',
    meterNumber: extracted.MeterNumber || '',
    numberOfDays: extracted.NumberOfDays || '',
    meterReadStart: extracted.MeterReadStart || '',
    meterReadEnd: extracted.MeterReadEnd || '',
    startRead: extracted.StartRead || '',
    endRead: extracted.EndRead || '',
    readDifference: extracted.ReadDifference || '',
    meterMultiplier: extracted.MeterMultiplier || '',
    billDate: extracted.BillDate || '',
    commodity: extracted.Commodity || '',
    kwh: usageQty,
    demandKW: extracted.ActualKW || '',
    actualRKVA: extracted.ActualRKVA || '',
    billedKW: extracted.BilledKW || '',
    facKW: extracted.FacilitiesKW || '',
    facKWCost: extracted.FacilitiesCharge || '',
    tdcKW: extracted.TDCkW || '',
    kwCost,
    kwhCost,
    otherCost,
    taxCost,
    totalCost: extracted.TotalCurrentCharges || extracted.TotalAmountDue || '',
    fromPDF: true,
    pdfBillId: billRecord.id,
    hasPDF,
    rateSchedule: extracted.RateSchedule || '',
    onPeakKwh: extracted.OnPeakKWh || extracted.EnergyOnPeakKWh || '',
    offPeakKwh: extracted.OffPeakKWh || extracted.EnergyOffPeakKWh || '',
    onPeakCost: extracted.EnergyOnPeakCharge || '',
    offPeakCost: extracted.EnergyOffPeakCharge || '',
    customerCharge: extracted.CustomerCharge || '',
    demandCharge: extracted.BilledKWCharge || '',
    facilitiesCharge: extracted.FacilitiesCharge || '',
    ecaCharge: extracted.ECACharge || '',
    eerCharge: extracted.EERCharge || '',
    ptsCharge: extracted.PTSCharge || '',
    tdcCharge: extracted.TDCCharge || '',
    rkvaCharge: extracted.RkVACharge || '',
    taxExemptDelivery: extracted.TaxExemptDelivery || '',
    billOffset: extracted.BillOffset || '',
    renewableCharge: extracted.RenewableCharge || '',
    franchiseFee: extracted.FranchiseFee || '',
    franchiseFee1: extracted.FranchiseFee1 || '',
    franchiseFee2: extracted.FranchiseFee2 || '',
    solarCredit: extracted.SolarCredit || '',
    generationKwh: extracted.GenerationKwh || '',
    totalKwhRate: (() => {
      const _kwh = pf(extracted.kWhConsumed);
      const _chg = pf(kwhCost);
      return _kwh > 0 && _chg > 0 ? (_chg / _kwh).toFixed(5) : extracted.TotalKWhRate || '';
    })(),
    totalKwRate: (() => {
      const _kw = pf(extracted.BilledKW) || pf(extracted.ActualKW) || pf(extracted.FacilitiesKW);
      const _chg = pf(kwCost) + pf(extracted.FacilitiesCharge);
      return _kw > 0 && _chg > 0 ? (_chg / _kw).toFixed(5) : extracted.TotalKWRate || '';
    })(),
    facilitiesRate: extracted.FacilitiesRate || '',
    demandRate: extracted.DemandRate || '',
    tdcRate: extracted.TDCRate || '',
    onPeakRate: extracted.OnPeakRate || '',
    offPeakRate: extracted.OffPeakRate || '',
    ecaRate: extracted.ECARate || '',
    eerRate: extracted.EERRate || '',
    ptsRate: extracted.PTSRate || '',
    rkvaRate: extracted.RkVARate || '',
    naturalGasCCF: extracted.NaturalGasCCF || '',
    naturalGasTherms: extracted.NaturalGasTherms || '',
    naturalGasMMbtu: extracted.NaturalGasMMbtu || '',
    // Fix [therms-unit-2026-06-22]: canonicalize therms to Therms at save time.
    therms: isGas
      ? (() => {
          const t = pf(extracted.NaturalGasTherms);
          if (t) return t; // already Therms — Constellation/KGS
          const ccf = pf(extracted.NaturalGasCCF);
          if (ccf) return Math.round(ccf * 1.037 * 100) / 100; // CCF → Therms
          const mm = pf(extracted.NaturalGasMMbtu);
          if (mm) return Math.round(mm * 10 * 100) / 100; // MMBtu → Therms (×10)
          return '';
        })()
      : '',
    // Bug d4c78f06: use GasCharge (commodity cost) for thermCost so $/therm rate
    // in tables uses energy-only cost, not total bill cost.
    thermCost: isGas
      ? extracted.NaturalGasTherms || extracted.NaturalGasCCF || extracted.NaturalGasMMbtu
        ? extracted.GasCharge || extracted.TotalCurrentCharges || extracted.TotalAmountDue || ''
        : ''
      : '',
    gasCharge: extracted.GasCharge || '',
    fuelAdjustment: extracted.FuelAdjustment || '',
    waterUsage: extracted.WaterUsage || '',
    waterCharge: extracted.WaterCharge || '',
    waterProtectionFee: extracted.WaterProtectionFee || '',
    sewerUsage: extracted.SewerUsage || '',
    sewerCharge: extracted.SewerCharge || '',
    stormWaterCharge: extracted.StormWaterCharge || '',
    invoiceNumber: extracted.InvoiceNumber || '',
    saleNumber: extracted.SaleNumber || '',
    deliveryDate: extracted.DeliveryDate || '',
    fuelType: extracted.FuelType || '',
    gallonsDelivered: extracted.GallonsDelivered || '',
    unitPrice: extracted.UnitPrice || '',
    subtotal: extracted.Subtotal || '',
    tax: extracted.Tax || '',
    // Non-electric commodity rates — computed from canonical Therms + charge at save time.
    totalGasRate: (() => {
      const t =
        pf(extracted.NaturalGasTherms) ||
        (pf(extracted.NaturalGasCCF) ? Math.round(pf(extracted.NaturalGasCCF) * 1.037 * 100) / 100 : 0) ||
        (pf(extracted.NaturalGasMMbtu) ? Math.round(pf(extracted.NaturalGasMMbtu) * 10 * 100) / 100 : 0);
      const c = pf(extracted.GasCharge) || pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      return t > 0 && c > 0 ? (c / t).toFixed(5) : '';
    })(),
    totalWaterRate: (() => {
      const u = pf(extracted.WaterUsage);
      const c = pf(extracted.WaterCharge) || pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
    })(),
    totalPropaneRate: (() => {
      const g = pf(extracted.GallonsDelivered);
      const up = pf(extracted.UnitPrice);
      if (up > 0) return up.toFixed(5);
      const c = pf(extracted.TotalCurrentCharges) || pf(extracted.TotalAmountDue);
      return g > 0 && c > 0 ? (c / g).toFixed(5) : '';
    })(),
    totalSewerRate: (() => {
      const u = pf(extracted.SewerUsage);
      const c = pf(extracted.SewerCharge);
      return u > 0 && c > 0 ? (c / u).toFixed(5) : '';
    })(),
    totalStormwaterRate: (() => {
      const c = pf(extracted.StormWaterCharge);
      return c > 0 ? c.toFixed(2) : '';
    })(),
  };
  if (proj) {
    const udProj = getUDProj(proj.id);
    const billComm = (extracted.Commodity || '').toLowerCase();
    // First try: match by account or meter number (most precise)
    const acctClean = (extracted.AccountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    const meterClean = (extracted.MeterNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    let matched = false;
    let targetMeter = null;
    let targetBldg = null;
    if (acctClean || meterClean) {
      for (const b of udProj.buildings || []) {
        for (const m of b.meters || []) {
          const ma = (m.account || '').replace(/[\s\-]/g, '').toLowerCase();
          const mm = (m.meter || '').replace(/[\s\-]/g, '').toLowerCase();
          if (_acctFuzzyMatch(acctClean, ma) || (meterClean && mm && meterClean === mm)) {
            const mComm = (m.commodity || '').toLowerCase();
            if (billComm && mComm && billComm === mComm) {
              targetMeter = m;
              targetBldg = b;
              matched = true;
              break;
            }
            if (!targetMeter) {
              targetMeter = m;
              targetBldg = b;
            }
          }
        }
        if (matched) break;
      }
      if (targetMeter && !matched) {
        let mComm = (targetMeter.commodity || '').toLowerCase();
        if (billComm && !mComm) {
          targetMeter.commodity = extracted.Commodity;
          mComm = billComm;
        }
        if (billComm && mComm && billComm !== mComm) {
          const existM = (targetBldg.meters || []).find((m) => (m.commodity || '').toLowerCase() === billComm);
          if (existM) {
            targetMeter = existM;
          } else {
            const newM = {
              id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
              commodity:
                extracted.Commodity ||
                (extracted.NaturalGasTherms || extracted.NaturalGasCCF || extracted.GasCharge
                  ? 'Gas'
                  : extracted.GallonsDelivered || extracted.FuelType
                    ? 'Propane'
                    : 'Electric'),
              provider: extracted.UtilityCompany || targetMeter.provider || '',
              account: extracted.AccountNumber || targetMeter.account || '',
              meter: '',
              maddr: targetMeter.maddr || '',
              inclusive: true,
              bills: [],
              billUnit: '',
              displayUnit: '',
            };
            targetBldg.meters = targetBldg.meters || [];
            targetBldg.meters.push(newM);
            targetMeter = newM;
          }
        }
        matched = true;
      }
    }
    // Bug 86d02961: If a fuzzy account match was used and the extracted account
    // number is longer/different from the stored one (new bill format), update
    // the meter's stored account so future extractions match directly.
    if (matched && targetMeter && extracted.AccountNumber && targetMeter.account) {
      const _extAcctN = extracted.AccountNumber.replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      const _storedAcctN = targetMeter.account
        .replace(/[\s\-]/g, '')
        .replace(/^0+/, '')
        .toLowerCase();
      if (_extAcctN !== _storedAcctN && (_extAcctN.includes(_storedAcctN) || _storedAcctN.includes(_extAcctN))) {
        // Prefer the longer/more-specific format (new format typically has prefix+suffix)
        if (extracted.AccountNumber.length > targetMeter.account.length) {
          console.log('[_saveSinglePDFBill] updating meter account', targetMeter.account, '→', extracted.AccountNumber);
          targetMeter.account = extracted.AccountNumber;
        }
      }
    }
    if (matched && targetMeter) {
      targetMeter.bills = targetMeter.bills || [];
      const dup = targetMeter.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
      if (dup) {
        Object.assign(dup, billRow);
      } else {
        targetMeter.bills.push(billRow);
        targetMeter.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
      }
      // Run validation on the saved bill to persist _flags
      if (typeof runBillValidation === 'function') runBillValidation(targetMeter, dup || billRow);
    }
    // Second try: single matching commodity meter
    if (!matched) {
      const commodity = extracted.Commodity || (isGas ? 'Gas' : isPropane ? 'Propane' : 'Electric');
      const commLower = commodity.toLowerCase();
      const typeMeters = [];
      (udProj.buildings || []).forEach((b) =>
        (b.meters || []).forEach((m) => {
          const mc = (m.commodity || '').toLowerCase();
          if (mc === commLower || (isGas && (mc === 'gas' || mc === 'natural gas')) || (isPropane && mc === 'propane'))
            typeMeters.push({ b, m });
        }),
      );
      if (typeMeters.length === 1) {
        const { b, m } = typeMeters[0];
        m.bills = m.bills || [];
        const dup = m.bills.find((r) => r.start === billRow.start && r.end === billRow.end);
        if (dup) {
          Object.assign(dup, billRow);
        } else {
          m.bills.push(billRow);
          m.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
        }
        // Run validation on the saved bill to persist _flags
        if (typeof runBillValidation === 'function') runBillValidation(m, dup || billRow);
        matched = true;
      }
    }
    if (!matched) {
      // If the bill has an account or meter number, auto-create a meter so the
      // bill lands in the right project automatically. Fall through to unassigned
      // only if there is no identity information to create a meaningful meter.
      const hasIdentity = !!(extracted.AccountNumber || extracted.MeterNumber);
      if (hasIdentity) {
        const created = _autoCreateMeterAndSaveBill(extracted, projId, billRow);
        if (created) {
          matched = true;
        }
      }
      if (!matched) {
        console.log(
          '[_saveSinglePDFBill] no meter match for',
          extracted.AccountNumber,
          extracted.Commodity,
          '— saving to unassigned',
        );
        showToast('No meter match found — saved to Saved Bills. Assign from Saved Bills tab.');
      }
    }
    if (matched) saveUtilityData();
  }
  updateBillCountBadge();
  if (totalCost > 0 && diff > 0.1 && !isGas && !isPropane) {
    console.warn('Bill validation: components $' + componentSum.toFixed(2) + ' vs total $' + totalCost.toFixed(2));
  }
  return true;
}

function pdfUpdateBldgMeterOpts() {
  const projId = parseInt(document.getElementById('pdfProjSel').value) || null;
  const bldgSel = document.getElementById('pdfBldgSel');
  const meterSel = document.getElementById('pdfMeterSel');
  if (!bldgSel || !meterSel) return;
  bldgSel.innerHTML = '<option value="">Auto-detect building</option>';
  meterSel.innerHTML = '<option value="">Auto-detect meter</option>';
  if (!projId) return;
  const ud = getUDProj(projId);
  (ud.buildings || []).forEach((b) => {
    bldgSel.innerHTML += '<option value="' + b.id + '">' + (b.name || b.id) + '</option>';
  });
}
function pdfUpdateMeterOpts() {
  const projId = parseInt(document.getElementById('pdfProjSel').value) || null;
  const bldgId = document.getElementById('pdfBldgSel').value || null;
  const meterSel = document.getElementById('pdfMeterSel');
  if (!meterSel) return;
  meterSel.innerHTML = '<option value="">Auto-detect meter</option>';
  if (!projId || !bldgId) return;
  const bldg = getUDBldg(projId, bldgId);
  if (!bldg) return;
  (bldg.meters || []).forEach((m) => {
    const lbl = (m.commodity || 'Meter') + (m.account ? ' (' + m.account + ')' : '');
    meterSel.innerHTML += '<option value="' + m.id + '">' + lbl + '</option>';
  });
}

// Banner override helpers — populate project/building/meter selectors inside
// the auto-assign banner so the user can redirect the save to a different meter.
function pdfBannerToggleOverride() {
  const row = document.getElementById('pdfBannerOverrideRow');
  const btn = document.getElementById('pdfBannerOverrideBtn');
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'block';
  if (btn) btn.textContent = open ? 'Change Destination' : 'Cancel Override';
  if (!open) {
    // Populate project list and pre-select auto-matched values
    const projSel = document.getElementById('pdfBannerProjSel');
    if (projSel) {
      projSel.innerHTML = (projects || [])
        .map((p) => '<option value="' + p.id + '">' + (p.name || p.id) + '</option>')
        .join('');
      if (_autoAssignTarget && _autoAssignTarget.projId) {
        projSel.value = String(_autoAssignTarget.projId);
      }
      pdfBannerUpdateBldgOpts();
    }
  }
}

function pdfBannerUpdateBldgOpts() {
  const projId = parseInt(document.getElementById('pdfBannerProjSel')?.value) || null;
  const bldgSel = document.getElementById('pdfBannerBldgSel');
  const meterSel = document.getElementById('pdfBannerMeterSel');
  if (!bldgSel || !meterSel) return;
  bldgSel.innerHTML = '<option value="">— Building —</option>';
  meterSel.innerHTML = '<option value="">— Meter —</option>';
  if (!projId) return;
  const ud = getUDProj(projId);
  (ud.buildings || []).forEach((b) => {
    bldgSel.innerHTML += '<option value="' + b.id + '">' + (b.name || b.id) + '</option>';
  });
  if (_autoAssignTarget && _autoAssignTarget.projId === projId && _autoAssignTarget.bldgId) {
    bldgSel.value = String(_autoAssignTarget.bldgId);
    pdfBannerUpdateMeterOpts();
  }
}

function pdfBannerUpdateMeterOpts() {
  const projId = parseInt(document.getElementById('pdfBannerProjSel')?.value) || null;
  const bldgId = document.getElementById('pdfBannerBldgSel')?.value || null;
  const meterSel = document.getElementById('pdfBannerMeterSel');
  if (!meterSel) return;
  meterSel.innerHTML = '<option value="">— Meter —</option>';
  if (!projId || !bldgId) return;
  const bldg = getUDBldg(projId, bldgId);
  if (!bldg) return;
  (bldg.meters || []).forEach((m) => {
    const lbl = (m.commodity || 'Meter') + (m.account ? ' (' + m.account + ')' : '');
    meterSel.innerHTML += '<option value="' + m.id + '">' + lbl + '</option>';
  });
  if (
    _autoAssignTarget &&
    _autoAssignTarget.projId === projId &&
    _autoAssignTarget.bldgId === bldgId &&
    _autoAssignTarget.meterId
  ) {
    meterSel.value = String(_autoAssignTarget.meterId);
  }
}

function savePDFData() {
  const bills = window._pdfMultiBills;
  const idx = window._pdfMultiIdx || 0;
  const extracted = bills && bills[idx];
  if (!extracted || !extracted.UtilityCompany) {
    showToast('No extracted data to save');
    return;
  }
  const projId = parseInt(document.getElementById('pdfProjSel').value) || null;
  // Manual building/meter override
  const manualBldgId = document.getElementById('pdfBldgSel')?.value || null;
  const manualMeterId = document.getElementById('pdfMeterSel')?.value || null;
  if (projId && manualBldgId && manualMeterId) {
    const bldg = getUDBldg(projId, manualBldgId);
    const meter = bldg ? (bldg.meters || []).find((m) => m.id === manualMeterId) : null;
    if (bldg && meter) {
      _autoAssignTarget = {
        proj: projects.find((p) => p.id === projId),
        bldg,
        meter,
        projId,
        bldgId: manualBldgId,
        meterId: manualMeterId,
      };
    }
  }
  _saveSinglePDFBill(extracted, projId).then((ok) => {
    const proj = projId ? projects.find((p) => p.id === projId) : null;
    if (ok) {
      window._pdfBillsSaved = true;
      showToast(proj ? 'Saved to ' + proj.name + ' ✓' : 'Saved to general database ✓');
      if (document.getElementById('savedBillsModal').classList.contains('open')) renderSavedBills();
    }
  });
}
