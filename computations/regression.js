// computations/regression.js — Regression functions (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

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
  var hddPts = rows.filter(function (r) {
    return !r.partial && r.hdd != null && r.normDays > 0;
  });
  var cddPts = rows.filter(function (r) {
    return !r.partial && r.cdd != null && r.normDays > 0;
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
    return !r.partial && r.hdd != null && r.cdd != null && r.normDays > 0;
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

  if (reg.dual) {
    var hdd = row.hdd != null && isFinite(row.hdd) ? row.hdd : 0;
    var cdd = row.cdd != null && isFinite(row.cdd) ? row.cdd : 0;
    var baseline = reg.dual.intercept * normDays + reg.dual.slopeHDD * hdd + reg.dual.slopeCDD * cdd;
    return Math.max(0, baseline);
  }

  var isElec = commodity === 'Electric';
  var primary = isElec ? reg.cdd : reg.hdd;
  var fallback = isElec ? reg.hdd : reg.cdd;
  var primaryDD = isElec ? row.cdd : row.hdd;
  var fallbackDD = isElec ? row.hdd : row.cdd;

  function applyReg(r, dd) {
    if (!r) return null;
    var ddVal = dd != null && isFinite(dd) ? dd : 0;
    return r.intercept * normDays + r.slope * ddVal;
  }

  var baseline = null;
  if (primary && primaryDD != null) {
    baseline = applyReg(primary, primaryDD);
  } else if (fallback && fallbackDD != null) {
    baseline = applyReg(fallback, fallbackDD);
  } else if (primary) {
    baseline = applyReg(primary, 0);
  }
  return baseline != null ? Math.max(0, baseline) : null;
}

// ── Consolidated kW CDD regression ────────────────────────────────────────────
// Was duplicated in getMeterPerfSavingsByCalMo and getMeterPerfSavingsByYM.
// Fits a simple linear regression of demand kW ~ CDD from baseline rows,
// then predicts kW for all months.
// blRows: baseline normalized rows (must have .ym and .cdd)
// allRows: all normalized rows (must have .ym and .cdd)
// bills: the meter's bills array
// incl: the inclusion setting for normMonth
// Returns: {ym: predictedKW} for all months in allRows, or empty object if insufficient data
function computeKwCddRegression(blRows, allRows, bills, incl) {
  var result = {};
  var pts = blRows
    .map(function (r) {
      var bfr = bills.filter(function (b) {
        return normMonth(b.start, b.end, incl, bills) === r.ym;
      });
      var kw = bfr.length
        ? bfr.reduce(function (s, b) {
            return s + (parseFloat(b.demandKW) || 0);
          }, 0) / bfr.length
        : 0;
      return { x: r.cdd != null ? r.cdd : 0, y: kw };
    })
    .filter(function (p) {
      return p.y > 0;
    });
  if (pts.length >= 3) {
    var n = pts.length;
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
    if (ssxx > 0) {
      var slope = ssxy / ssxx;
      var intercept = my - slope * mx;
      allRows.forEach(function (r) {
        var cdd = r.cdd != null ? r.cdd : 0;
        result[r.ym] = Math.max(0, intercept + slope * cdd);
      });
    }
  }
  return result;
}
