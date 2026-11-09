// computations/regression.js — Regression functions (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

// ── The one CV(RMSE) ─────────────────────────────────────────────────────────
// CV(RMSE) = sqrt(sum of squared residuals / (n - nParams)) / mean(actual). actual[] and predicted[] are the
// monthly values the model is used for (one pair per baseline month); nParams = fitted coefficients
// (2 for a line, 3 for the HDD+CDD fit). modelCvRmse (degree-day models) and fitKwCdd (billed kW) call this; the report prints what they return.
// NMBE is not computed: the bias correction in computeMeterRegression sets sum(predicted) = sum(actual),
// so NMBE is 0 by construction, and the kW line fit has no correction but its residuals also sum to 0.
function cvRmse(actual, predicted, nParams) {
  var n = actual.length;
  if (n <= nParams) return null;
  var mean =
    actual.reduce(function (s, v) {
      return s + v;
    }, 0) / n;
  if (!(mean > 0)) return null;
  var ss = actual.reduce(function (s, v, i) {
    return s + (v - predicted[i]) * (v - predicted[i]);
  }, 0);
  return Math.sqrt(ss / (n - nParams)) / mean;
}

// modelCvRmse(rows, fit, kind) - CV(RMSE) of a fitted degree-day model over the baseline rows it was fitted on. rows are
// getNormRows rows (usage, normDays, hdd, cdd for the month); fit holds the coefficients the savings use (frozen or live):
// {intercept, slope} for kind 'hdd' or 'cdd', {intercept, slopeHDD, slopeCDD} for kind 'dual'. Month prediction =
// intercept x days + slope x degree days (the form computeMeterRegression fits). Rows are chosen as the fit chooses them.
function modelCvRmse(rows, fit, kind) {
  if (!fit || !rows) return null;
  var use = rows.filter(function (r) {
    return !r.partial && !r.zeroFill && r.normDays > 0 && (kind === 'dual' ? r.hdd != null && r.cdd != null : r[kind] != null);
  });
  var actual = use.map(function (r) {
    return r.usage;
  });
  var pred = use.map(function (r) {
    return kind === 'dual'
      ? fit.intercept * r.normDays + fit.slopeHDD * r.hdd + fit.slopeCDD * r.cdd
      : fit.intercept * r.normDays + fit.slope * r[kind];
  });
  return cvRmse(actual, pred, kind === 'dual' ? 3 : 2);
}

function olsRegressionDual(x1, x2, y) {
  var pts = x1
    .map(function (_, i) {
      return { x1: x1[i], x2: x2[i], y: y[i] };
    })
    .filter(function (p) {
      return p.y != null && isFinite(p.y) && isFinite(p.x1 || 0) && isFinite(p.x2 || 0);
    });
  var n = pts.length;
  if (n < 4) return null;
  var Sx1 = 0,
    Sx2 = 0,
    Sy = 0,
    Sx1x1 = 0,
    Sx2x2 = 0,
    Sx1x2 = 0,
    Sx1y = 0,
    Sx2y = 0;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var v1 = p.x1 || 0,
      v2 = p.x2 || 0;
    Sx1 += v1;
    Sx2 += v2;
    Sy += p.y;
    Sx1x1 += v1 * v1;
    Sx2x2 += v2 * v2;
    Sx1x2 += v1 * v2;
    Sx1y += v1 * p.y;
    Sx2y += v2 * p.y;
  }
  var det = n * (Sx1x1 * Sx2x2 - Sx1x2 * Sx1x2) - Sx1 * (Sx1 * Sx2x2 - Sx1x2 * Sx2) + Sx2 * (Sx1 * Sx1x2 - Sx1x1 * Sx2);
  if (Math.abs(det) < 1e-12) return null;
  var a =
    (Sy * (Sx1x1 * Sx2x2 - Sx1x2 * Sx1x2) - Sx1 * (Sx1y * Sx2x2 - Sx1x2 * Sx2y) + Sx2 * (Sx1y * Sx1x2 - Sx1x1 * Sx2y)) /
    det;
  var b =
    (n * (Sx1y * Sx2x2 - Sx1x2 * Sx2y) - Sy * (Sx1 * Sx2x2 - Sx1x2 * Sx2) + Sx2 * (Sx1 * Sx2y - Sx1y * Sx2)) / det;
  var c =
    (n * (Sx1x1 * Sx2y - Sx1y * Sx1x2) - Sx1 * (Sx1 * Sx2y - Sx1y * Sx2) + Sy * (Sx1 * Sx1x2 - Sx1x1 * Sx2)) / det;
  var my = Sy / n;
  var ssTot = pts.reduce(function (s, p) {
    return s + (p.y - my) * (p.y - my);
  }, 0);
  var ssRes = pts.reduce(function (s, p) {
    var pred = a + b * (p.x1 || 0) + c * (p.x2 || 0);
    return s + (p.y - pred) * (p.y - pred);
  }, 0);
  var r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { intercept: a, slopeHDD: b, slopeCDD: c, r2: r2, n: n };
}

// ── OLS simple linear regression helper ──────────────────────────────────────
// Returns {slope, intercept, r2} for arrays x[] and y[] of equal length.
// Requires at least 3 paired non-null points; returns null otherwise.
function olsRegression(x, y) {
  var pts = x
    .map(function (xi, i) {
      return { x: xi, y: y[i] };
    })
    .filter(function (p) {
      return p.x != null && p.y != null && isFinite(p.x) && isFinite(p.y);
    });
  var n = pts.length;
  if (n < 3) return null;
  var mx =
    pts.reduce(function (s, p) {
      return s + p.x;
    }, 0) / n;
  var my =
    pts.reduce(function (s, p) {
      return s + p.y;
    }, 0) / n;
  var ssxx = pts.reduce(function (s, p) {
    return s + (p.x - mx) * (p.x - mx);
  }, 0);
  var ssxy = pts.reduce(function (s, p) {
    return s + (p.x - mx) * (p.y - my);
  }, 0);
  if (ssxx === 0) return null;
  var slope = ssxy / ssxx;
  var intercept = my - slope * mx;
  var ssTot = pts.reduce(function (s, p) {
    return s + (p.y - my) * (p.y - my);
  }, 0);
  var ssRes = pts.reduce(function (s, p) {
    return s + (p.y - (intercept + slope * p.x)) * (p.y - (intercept + slope * p.x));
  }, 0);
  var r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope: slope, intercept: intercept, r2: r2, n: n };
}

// ── Compute regression coefficients for a meter from its normalized rows ─────
// Uses usage/day ~ DD/day to keep units consistent regardless of month length.
// After OLS fit, applies bias correction: mean_residual is added to the intercept
// so the model's average prediction exactly matches the average actual over training data.
// Returns {hdd:{slope,intercept,interceptRaw,bias,r2,n}, cdd:{...}} or nulls.
function computeMeterRegression(rows) {
  // Include ALL months with weather data, including zero-DD months (they anchor the intercept).
  // Exclude partial months (first/last billing period that doesn't cover ≥90% of the calendar month).
  // Exclude zeroFill rows (2026-09-10 guard): propane's explicit hard-zero
  // fill-in rows have real weather data (hdd/cdd populated for future/
  // no-delivery-yet months) but no real usage observation. Fitting on them
  // would fabricate a "usage=0 at high HDD" data point and drag the slope/
  // intercept/R² toward zero for any meter whose live (non-frozen) regression
  // is in use. Baseline-only callers (saveBaseline, saveBaselineToAllMeters,
  // saveBaselineToAllProjectMeters) are unaffected — zero-fill rows are never
  // baseline months.
  var hddPts = rows.filter(function (r) {
    return !r.partial && !r.zeroFill && r.hdd != null && r.normDays > 0;
  });
  var cddPts = rows.filter(function (r) {
    return !r.partial && !r.zeroFill && r.cdd != null && r.normDays > 0;
  });

  function fitWithBias(pts, ddKey) {
    var reg = olsRegression(
      pts.map(function (r) {
        return r[ddKey] / r.normDays;
      }), // x: DD per calendar day
      pts.map(function (r) {
        return r.usage / r.normDays;
      }), // y: usage per calendar day
    );
    if (!reg) return null;
    // Bias correction per user's Excel method:
    //   sumFit    = Σ (intercept × normDays + slope × DD)   over training points
    //   sumActual = Σ actual kWh                             over training points
    //   sumDays   = Σ normDays                               over training points
    //   diff/day  = (sumFit - sumActual) / sumDays
    //   correctedIntercept = interceptRaw - diff/day
    // This forces Σ predicted = Σ actual across all training months.
    var sumFit = pts.reduce(function (s, r) {
      return s + reg.intercept * r.normDays + reg.slope * r[ddKey];
    }, 0);
    var sumActual = pts.reduce(function (s, r) {
      return s + r.usage;
    }, 0);
    var sumDays = pts.reduce(function (s, r) {
      return s + r.normDays;
    }, 0);
    var diffPerDay = (sumFit - sumActual) / sumDays;
    var correctedIntercept = reg.intercept - diffPerDay;
    return {
      slope: reg.slope,
      interceptRaw: reg.intercept,
      intercept: correctedIntercept,
      bias: -diffPerDay, // stored for display: negative means model was over-predicting
      r2: reg.r2,
      n: reg.n,
    };
  }

  var hddReg = fitWithBias(hddPts, 'hdd');
  var cddReg = fitWithBias(cddPts, 'cdd');

  var dualPts = rows.filter(function (r) {
    return !r.partial && !r.zeroFill && r.hdd != null && r.cdd != null && r.normDays > 0;
  });
  var dualReg = null;
  if (dualPts.length >= 4) {
    var raw = olsRegressionDual(
      dualPts.map(function (r) {
        return r.hdd / r.normDays;
      }),
      dualPts.map(function (r) {
        return r.cdd / r.normDays;
      }),
      dualPts.map(function (r) {
        return r.usage / r.normDays;
      }),
    );
    if (raw) {
      var sumFit = dualPts.reduce(function (s, r) {
        return s + raw.intercept * r.normDays + raw.slopeHDD * r.hdd + raw.slopeCDD * r.cdd;
      }, 0);
      var sumActual = dualPts.reduce(function (s, r) {
        return s + r.usage;
      }, 0);
      var sumDays = dualPts.reduce(function (s, r) {
        return s + r.normDays;
      }, 0);
      var bias = sumDays > 0 ? (sumFit - sumActual) / sumDays : 0;
      dualReg = {
        intercept: raw.intercept - bias,
        interceptRaw: raw.intercept,
        slopeHDD: raw.slopeHDD,
        slopeCDD: raw.slopeCDD,
        bias: bias,
        r2: raw.r2,
        n: raw.n,
      };
    }
  }

  return { hdd: hddReg, cdd: cddReg, dual: dualReg };
}

// ── Compute regression-based baseline for a single normalized month row ───────
// normBasis: 'calendar' → use calendar days in YYYY-MM
//            'actual'   → use actual prorated billing days (r.days)
// Returns the predicted baseline usage for that month, or null if no valid regression.
// Logic:
//   For electric: use CDD regression if CDD available, else HDD regression if available
//   For gas:      use HDD regression if HDD available, else CDD regression if available
//   Baseline = (intercept + slope × (DD/normDays)) × normDays
//            = intercept×normDays + slope×DD
// This correctly handles months with 0 DD (base load × days) and months with high DD.
function regressionBaseline(row, reg, commodity, normBasis) {
  if (!reg) return null;
  var normDays = normBasis === 'calendar' ? calDaysInMonth(row.ym) : row.days;
  if (!normDays) return null;

  // Missing weather is never degree days = 0. A month whose degree days are absent has NO baseline
  // (null); callers leave that month out until weather exists (Matt, 2026-10-31).
  function hasDD(v) {
    return v != null && isFinite(v);
  }
  if (reg.dual) {
    if (!hasDD(row.hdd) || !hasDD(row.cdd)) return null;
    return Math.max(0, reg.dual.intercept * normDays + reg.dual.slopeHDD * row.hdd + reg.dual.slopeCDD * row.cdd);
  }

  var isElec = commodity === 'Electric';
  var primary = isElec ? reg.cdd : reg.hdd;
  var fallback = isElec ? reg.hdd : reg.cdd;
  var primaryDD = isElec ? row.cdd : row.hdd;
  var fallbackDD = isElec ? row.hdd : row.cdd;

  var baseline = null;
  if (primary && hasDD(primaryDD)) {
    baseline = primary.intercept * normDays + primary.slope * primaryDD;
  } else if (fallback && hasDD(fallbackDD)) {
    baseline = fallback.intercept * normDays + fallback.slope * fallbackDD;
  }
  return baseline != null ? Math.max(0, baseline) : null;
}

// ── The one kW CDD regression ────────────────────────────────────────────────
// Fits a simple linear regression of kW ~ CDD from the baseline rows, then predicts kW for every row.
// The kW is the basis of the month predicted (kwBasisForYm, computations/rates.js): Q3 2026 and later fit on
// Actual kW (demandKW, else billedKW), the same kW the savings compare it to (Matt, 2026-11-09). Months before
// that keep the Billed kW fit of the presented Q1 and Q2 2026 reports (billedKW, else demandKW; WP-04, math-02 H3).
// Savings, the Meter Performance table and Energy Graphics all call this function; there is no other copy.
// blRows: baseline rows used for the fit (must have .ym and .cdd)
// allRows: rows to predict for (must have .ym and .cdd)
// bills: the meter's bills array
// incl: the inclusion setting for billMonth
// Returns: {ym: predictedKW} for all months in allRows, or {} if there are fewer than 3 usable points.
// fitKwCdd(blRows, bills, basis): the OLS fit of the basis kW ('actual' | 'billed') on CDD over the baseline rows; null with fewer than 3 usable points.
function fitKwCdd(blRows, bills, basis) {
  var pts = blRows
    .map(function (r) {
      var bfr = bills.filter(function (b) {
        return billMonth(b, bills) === r.ym;
      });
      var kw = bfr.length
        ? bfr.reduce(function (s, b) {
            return s + getBillSavingsKw(b, basis);
          }, 0) / bfr.length
        : 0;
      return { x: r.cdd, y: kw };
    })
    .filter(function (p) {
      // a baseline month with no weather is left out of the fit, never read as CDD 0
      return p.y > 0 && p.x != null && isFinite(p.x);
    });
  // the one line fit (olsRegression) gives intercept, slope, r2 and n; null with fewer than 3 usable points
  var reg = olsRegression(
    pts.map(function (p) {
      return p.x;
    }),
    pts.map(function (p) {
      return p.y;
    }),
  );
  if (!reg) return null;
  return {
    intercept: reg.intercept,
    slope: reg.slope,
    n: reg.n,
    r2: reg.r2,
    cvrmse: cvRmse(
      pts.map(function (p) {
        return p.y;
      }),
      pts.map(function (p) {
        return reg.intercept + reg.slope * p.x;
      }),
      2,
    ),
  };
}

// fitKwCdd above is the fit alone ({intercept, slope, n, r2, cvrmse} or null); getMeterSavings returns it as blKwFit so the
// quarterly report prints the formula the kW dollars use (one fit, no second copy).
function computeKwCddRegression(blRows, allRows, bills, incl) {
  var result = {};
  var fits = {
    actual: fitKwCdd(blRows, bills, 'actual'),
    billed: fitKwCdd(blRows, bills, 'billed'),
  };
  // Baseline-year CDD of a calendar month (mean of the baseline rows of that month).
  var blCdd = function (ym) {
    var v = blRows.filter(function (b) {
      return b.ym.slice(5, 7) === ym.slice(5, 7) && b.cdd != null && isFinite(b.cdd);
    });
    return v.length
      ? v.reduce(function (s, b) {
          return s + b.cdd;
        }, 0) / v.length
      : null;
  };
  allRows.forEach(function (r) {
    var basis = kwBasisForYm(r.ym);
    var fit = fits[basis];
    // Q3 2026 on: the kW baseline is at baseline weather (the CDD of the same month of the baseline year), the same as
    // the kWh and therms baselines (Matt, 2026-11-03 and 2026-11-09). Earlier months keep the month's own CDD (presented Q1/Q2).
    var cdd = basis === 'actual' ? blCdd(r.ym) : r.cdd;
    // no weather for the month = no kW baseline for it (never CDD 0)
    if (!fit || cdd == null || !isFinite(cdd)) return;
    result[r.ym] = Math.max(0, fit.intercept + fit.slope * cdd);
  });
  return result;
}
