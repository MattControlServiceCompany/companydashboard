/* ═══════════════════════════════════════════════════════════════
   app/scorecard.js — Building Scorecard One-Pager
   Renders a print-ready summary for a single building.
   Called via renderProjUDPanel 'scorecard' route in core.js.
═══════════════════════════════════════════════════════════════ */

/* ── Helpers ── */
function _scFmt$(v, decimals) {
  if (v == null || isNaN(v)) return '—';
  return (
    '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 })
  );
}
function _scFmtN(v, decimals) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 });
}

/* ── SVG ring gauge ──
   Draws a circular progress ring. value 0-100 as percent of max.
   Returns an HTML string.
*/
function _scRingGauge(opts) {
  // opts: { id, value, max, label, sublabel, color, size, strokeWidth }
  var size = opts.size || 80;
  var sw = opts.strokeWidth || 7;
  var r = (size - sw) / 2;
  var circ = 2 * Math.PI * r;
  var pct = opts.max > 0 ? Math.min(1, Math.max(0, opts.value / opts.max)) : 0;
  var dash = pct * circ;
  var gap = circ - dash;
  var cx = size / 2;
  var cy = size / 2;
  return (
    '<div class="sc-gauge-wrap">' +
    '<svg width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    size +
    '" style="display:block">' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="' +
    sw +
    '"/>' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none"' +
    ' stroke="' +
    (opts.color || 'var(--accent)') +
    '"' +
    ' stroke-width="' +
    sw +
    '"' +
    ' stroke-dasharray="' +
    dash.toFixed(2) +
    ' ' +
    gap.toFixed(2) +
    '"' +
    ' stroke-dashoffset="' +
    (circ / 4).toFixed(2) +
    '"' +
    ' stroke-linecap="round"' +
    ' transform="rotate(-90 ' +
    cx +
    ' ' +
    cy +
    ')"/>' +
    '<text x="' +
    cx +
    '" y="' +
    (cy + 1) +
    '" text-anchor="middle" dominant-baseline="middle"' +
    ' style="font-family:var(--font);font-size:' +
    Math.round(size * 0.19) +
    'px;font-weight:800;fill:var(--text)">' +
    opts.label +
    '</text>' +
    '</svg>' +
    '<div class="sc-gauge-sublabel">' +
    (opts.sublabel || '') +
    '</div>' +
    '</div>'
  );
}

/* ── ENERGY STAR badge ── */
function _scStarBadge(score) {
  var color, ring;
  if (score >= 75) {
    color = '#22c55e';
    ring = '#16a34a';
  } else if (score >= 50) {
    color = '#f59e0b';
    ring = '#b45309';
  } else if (score >= 25) {
    color = '#f97316';
    ring = '#c2410c';
  } else {
    color = '#f43f5e';
    ring = '#be123c';
  }

  var size = 100;
  var sw = 8;
  var r = (size - sw) / 2;
  var circ = 2 * Math.PI * r;
  var pct = Math.min(1, Math.max(0, score / 100));
  var dash = pct * circ;
  var gap = circ - dash;
  var cx = size / 2;
  var cy = size / 2;

  return (
    '<div class="sc-star-badge">' +
    '<svg width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    size +
    '">' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="' +
    sw +
    '"/>' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none"' +
    ' stroke="' +
    color +
    '"' +
    ' stroke-width="' +
    sw +
    '"' +
    ' stroke-dasharray="' +
    dash.toFixed(2) +
    ' ' +
    gap.toFixed(2) +
    '"' +
    ' stroke-linecap="round"' +
    ' transform="rotate(-90 ' +
    cx +
    ' ' +
    cy +
    ')"/>' +
    '<text x="' +
    cx +
    '" y="' +
    (cy - 6) +
    '" text-anchor="middle" dominant-baseline="middle"' +
    ' style="font-family:var(--font);font-size:26px;font-weight:900;fill:' +
    color +
    '">' +
    (score > 0 ? score : '—') +
    '</text>' +
    '<text x="' +
    cx +
    '" y="' +
    (cy + 18) +
    '" text-anchor="middle" dominant-baseline="middle"' +
    ' style="font-family:var(--font);font-size:7px;font-weight:700;fill:rgba(255,255,255,0.5);letter-spacing:.8px;text-transform:uppercase">ES Score</text>' +
    '</svg>' +
    '</div>'
  );
}

/* ── Savings sparkline via Canvas (tiny, printable) ── */
function _scSparkline(monthlySavings, containerId) {
  // Deferred — draws into a canvas after DOM insertion
  requestAnimationFrame(function () {
    var canvas = document.getElementById(containerId);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width,
      H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!monthlySavings || !monthlySavings.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(0, H / 2 - 1, W, 2);
      return;
    }
    var vals = monthlySavings;
    var minV = Math.min.apply(null, vals);
    var maxV = Math.max.apply(null, vals);
    var range = maxV - minV || 1;
    var pad = 4;
    var xs = function (i) {
      return pad + (i / (vals.length - 1)) * (W - pad * 2);
    };
    var ys = function (v) {
      return H - pad - ((v - minV) / range) * (H - pad * 2);
    };

    // Fill area
    ctx.beginPath();
    ctx.moveTo(xs(0), H);
    for (var i = 0; i < vals.length; i++) ctx.lineTo(xs(i), ys(vals[i]));
    ctx.lineTo(xs(vals.length - 1), H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,212,170,0.15)';
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(xs(0), ys(vals[0]));
    for (var j = 1; j < vals.length; j++) ctx.lineTo(xs(j), ys(vals[j]));
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Zero line if negative values present
    if (minV < 0) {
      var zeroY = ys(0);
      ctx.beginPath();
      ctx.moveTo(pad, zeroY);
      ctx.lineTo(W - pad, zeroY);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}

/* ── Grade calculation ── */
function _scGrade(annualSavings, targetSavings) {
  if (!targetSavings || targetSavings <= 0) {
    // No target — grade on whether there are positive savings
    if (annualSavings > 500) return 'A';
    if (annualSavings > 0) return 'B';
    if (annualSavings >= -200) return 'C';
    return 'D';
  }
  var pct = annualSavings / targetSavings;
  if (pct >= 0.9) return 'A';
  if (pct >= 0.7) return 'B';
  if (pct >= 0.5) return 'C';
  return 'D';
}

function _scGradeColor(grade) {
  return { A: '#22c55e', B: '#84cc16', C: '#f59e0b', D: '#f43f5e' }[grade] || 'var(--text3)';
}

/* ── Main render function ── */
function renderBuildingScorecardPane(pane, b, projId) {
  if (!b) {
    pane.innerHTML = '<div class="ud-empty">No building selected</div>';
    return;
  }

  var sqft = parseInt(b.sqft) || 0;
  var sparkId = 'sc-spark-' + b.id;

  // ── Gather savings data ──
  var savByYM = {};
  var kwhSaved = 0,
    thermsSaved = 0,
    propSaved = 0;
  var totalCost = 0,
    totalKwh = 0,
    peakKW = 0,
    peakHours = 0;

  (b.meters || []).forEach(function (m) {
    if (m.baselineInclude === false) return;
    var bills = (m.bills || []).slice().sort(function (a, c) {
      return (a.start || '').localeCompare(c.start || '');
    });
    var incl = m.inclusive !== false;

    // Savings by YM
    try {
      var mSav = getMeterSavings(m, bills, incl, projId, b.id);
      Object.entries(mSav.byYM || {}).forEach(function (kv) {
        savByYM[kv[0]] = (savByYM[kv[0]] || 0) + kv[1];
      });
      // Accumulate saved units for pollution calc
      if (m.commodity === 'Electric') {
        kwhSaved += mSav.totalKwhSaved || 0;
      } else if (m.commodity === 'Gas') {
        thermsSaved += mSav.totalThermsSaved || 0;
      } else if (m.commodity === 'Propane') {
        propSaved += mSav.totalGalSaved || 0;
      }
    } catch (e) {
      /* no baseline yet */
    }

    // Total cost & usage for cost/sqft and load factor
    bills.forEach(function (bill) {
      var billCost = (bill.kwhCost || 0) + (bill.kwCost || 0) + (bill.otherCost || 0) + (bill.taxCost || 0);
      if (!billCost) {
        billCost = bill.totalCost || bill.cost || 0;
      }
      totalCost += billCost;
      totalKwh += bill.kwh || bill.kWh || 0;
      if (m.commodity === 'Electric') {
        if ((bill.kw || 0) > peakKW) peakKW = bill.kw || 0;
        peakHours += (bill.days || 30) * 24;
      }
    });
  });

  // ── Last 12 months of savings (sparkline) ──
  var ymKeys = Object.keys(savByYM).sort();
  var last12YM = ymKeys.slice(-12);
  var sparkVals = last12YM.map(function (ym) {
    return savByYM[ym] || 0;
  });

  // ── Annual savings = sum of all post-baseline months ──
  var annualSavings = Object.values(savByYM).reduce(function (s, v) {
    return s + v;
  }, 0);
  // Use last 12 months if we have more than 12
  if (last12YM.length === 12) {
    annualSavings = sparkVals.reduce(function (s, v) {
      return s + v;
    }, 0);
  }

  // ── EUI (site kBtu/sqft/yr, rolling last 12) ──
  var euiVal = 0;
  if (sqft > 0) {
    // Sum all electric & gas usage from last 12 months bills
    var last12Start = last12YM.length ? last12YM[0].replace('-', '') : '';
    var kwhLast = 0,
      thermsLast = 0,
      propLast = 0;
    (b.meters || []).forEach(function (m) {
      (m.bills || []).forEach(function (bill) {
        var ym = (bill.start || '').substring(0, 7);
        if (!last12YM.length || last12YM.includes(ym) || ymKeys.length === 0) {
          if (m.commodity === 'Electric') kwhLast += bill.kwh || bill.kWh || 0;
          else if (m.commodity === 'Gas') thermsLast += bill.therms || 0;
          else if (m.commodity === 'Propane') propLast += bill.gallons || 0;
        }
      });
    });
    // Fallback: all bills if no savings data
    if (!kwhLast && !thermsLast && !propLast) {
      (b.meters || []).forEach(function (m) {
        (m.bills || []).slice(-12).forEach(function (bill) {
          if (m.commodity === 'Electric') kwhLast += bill.kwh || bill.kWh || 0;
          else if (m.commodity === 'Gas') thermsLast += bill.therms || 0;
          else if (m.commodity === 'Propane') propLast += bill.gallons || 0;
        });
      });
    }
    var kBtu = kwhLast * 3.412 + thermsLast * 100 + propLast * 91.5;
    var months = last12YM.length || 12;
    euiVal = months > 0 ? Math.round(((kBtu / months) * 12) / sqft) : 0;
  }

  // ── ENERGY STAR score ──
  var sourceEUI = 0;
  if (sqft > 0) {
    try {
      var kwhY = 0,
        thermsY = 0,
        propY = 0;
      (b.meters || []).forEach(function (m) {
        (m.bills || []).slice(-12).forEach(function (bill) {
          if (m.commodity === 'Electric') kwhY += bill.kwh || bill.kWh || 0;
          else if (m.commodity === 'Gas') thermsY += bill.therms || 0;
          else if (m.commodity === 'Propane') propY += bill.gallons || 0;
        });
      });
      sourceEUI = computeSourceEUI(kwhY, thermsY, propY, sqft);
    } catch (e) {}
  }
  var esScore = sourceEUI > 0 ? estimateEnergyStarScore(sourceEUI) : 0;

  // ── Load factor (electric) ──
  var loadFactor = 0;
  if (peakKW > 0 && peakHours > 0 && totalKwh > 0) {
    loadFactor = Math.min(1, totalKwh / (peakKW * peakHours));
  }

  // ── Cost per sqft ──
  var costPerSqft = sqft > 0 && totalCost > 0 ? totalCost / sqft : 0;

  // ── Pollution equivalents ──
  var pollution = null;
  try {
    var stateCode = (b.state || 'KS').toUpperCase();
    pollution = calculatePollutionCredits(
      Math.max(0, kwhSaved),
      Math.max(0, thermsSaved),
      Math.max(0, propSaved),
      stateCode,
      'lbs',
    );
  } catch (e) {}

  var cars = pollution ? pollution.equivalents.carsRemoved || 0 : 0;
  var trees = pollution ? pollution.equivalents.treeSeedlings || 0 : 0;

  // ── Grade ──
  var grade = _scGrade(annualSavings, 0);
  var gradeColor = _scGradeColor(grade);

  // ── KPI gauge config ──
  // EUI: school typical range 40-150, good = low. Invert: show % of 150 remaining.
  var euiMax = 150;
  var euiPct = euiVal > 0 ? Math.max(0, euiMax - Math.min(euiMax, euiVal)) : 0;
  var euiColor = euiVal < 70 ? '#22c55e' : euiVal < 110 ? '#f59e0b' : '#f43f5e';

  // Load factor: 0-100%
  var lfPct = loadFactor * 100;
  var lfColor = lfPct >= 60 ? '#22c55e' : lfPct >= 40 ? '#f59e0b' : '#f43f5e';

  // Cost/sqft: typical K-12 $2-5/yr; good = low. Show inverted pct of $6 ceiling.
  var cpsMax = 6;
  var cpsPct = costPerSqft > 0 ? Math.max(0, ((cpsMax - Math.min(cpsMax, costPerSqft)) / cpsMax) * 100) : 0;
  var cpsColor = costPerSqft < 2.5 ? '#22c55e' : costPerSqft < 4.5 ? '#f59e0b' : '#f43f5e';

  // Savings gauge: show % of a $50k "excellent" target (arbitrary for visual only)
  var savMax = 50000;
  var savPct = annualSavings > 0 ? Math.min(100, (annualSavings / savMax) * 100) : 0;
  var savColor = annualSavings > 10000 ? '#22c55e' : annualSavings > 2000 ? '#f59e0b' : '#f43f5e';

  // ── Month labels for sparkline ──
  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var sparkLabels = last12YM.map(function (ym) {
    var parts = ym.split('-');
    return MO_SHORT[parseInt(parts[1]) - 1] || ym;
  });

  // ── Format dates ──
  var today = new Date();
  var dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // ── Build gauges HTML ──
  var gauges = [
    {
      label: annualSavings > 0 ? '$' + Math.round(annualSavings / 1000) + 'k' : '—',
      sublabel: 'Annual Savings',
      pct: savPct,
      color: savColor,
    },
    {
      label: euiVal > 0 ? String(euiVal) : '—',
      sublabel: 'EUI kBtu/sf',
      pct: euiPct,
      color: euiColor,
    },
    {
      label: loadFactor > 0 ? Math.round(lfPct) + '%' : '—',
      sublabel: 'Load Factor',
      pct: lfPct,
      color: lfColor,
    },
    {
      label: costPerSqft > 0 ? '$' + costPerSqft.toFixed(2) : '—',
      sublabel: 'Cost / sqft',
      pct: cpsPct,
      color: cpsColor,
    },
  ];

  var gaugesHTML = gauges
    .map(function (g) {
      return _scRingGauge({
        value: g.pct,
        max: 100,
        label: g.label,
        sublabel: g.sublabel,
        color: g.color,
        size: 90,
        strokeWidth: 8,
      });
    })
    .join('');

  // ── Render ──
  pane.innerHTML =
    '<div class="sc-root" id="sc-root-' +
    b.id +
    '">' +
    // Print button (not printed itself)
    '<div class="sc-print-bar no-print">' +
    '<span style="font-size:12px;color:var(--text3)">Building Scorecard &mdash; share or print</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="window.print()" style="margin-left:8px">🖨 Print</button>' +
    '</div>' +
    // ── Header row ──
    '<div class="sc-header">' +
    '<div class="sc-header-left">' +
    '<div class="sc-photo-placeholder">' +
    '<span style="font-size:28px">🏫</span>' +
    '<div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:4px">Photo</div>' +
    '</div>' +
    '<div class="sc-header-info">' +
    '<div class="sc-building-name">' +
    (b.name || 'Building') +
    '</div>' +
    (b.addr ? '<div class="sc-building-addr">' + b.addr + '</div>' : '') +
    (sqft ? '<div class="sc-building-meta">' + sqft.toLocaleString() + ' sf</div>' : '') +
    '<div class="sc-generated">Generated ' +
    dateStr +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="sc-header-right">' +
    _scStarBadge(esScore) +
    '<div class="sc-grade-badge" style="color:' +
    gradeColor +
    ';border-color:' +
    gradeColor +
    '">' +
    '<div class="sc-grade-letter">' +
    grade +
    '</div>' +
    '<div class="sc-grade-label">Performance</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    // ── KPI gauges row ──
    '<div class="sc-section-label">Key Performance Indicators</div>' +
    '<div class="sc-gauges-row">' +
    gaugesHTML +
    '</div>' +
    // ── Bottom row: sparkline + environmental ──
    '<div class="sc-bottom-row">' +
    // Sparkline
    '<div class="sc-spark-card">' +
    '<div class="sc-card-title">Savings Trend — Last ' +
    (sparkLabels.length || 0) +
    ' Months</div>' +
    (sparkVals.length > 1
      ? '<canvas id="' +
        sparkId +
        '" width="280" height="80" style="width:100%;height:80px;display:block"></canvas>' +
        '<div class="sc-spark-labels">' +
        (sparkLabels.length >= 2
          ? '<span>' + sparkLabels[0] + '</span><span>' + sparkLabels[sparkLabels.length - 1] + '</span>'
          : '') +
        '</div>'
      : '<div style="color:var(--text3);font-size:12px;padding:20px 0;text-align:center">No post-baseline savings data yet</div>') +
    '<div style="margin-top:8px;font-size:11px;color:var(--text3)">Annual savings: <span style="color:' +
    (annualSavings >= 0 ? 'var(--em)' : 'var(--red)') +
    ';font-weight:700">' +
    _scFmt$(annualSavings) +
    '</span></div>' +
    '</div>' +
    // Environmental impact
    '<div class="sc-env-card">' +
    '<div class="sc-card-title">Environmental Impact</div>' +
    (function () {
      if (annualSavings > 0 && (cars > 0 || trees > 0)) {
        var carsHtml =
          cars > 0
            ? '<div class="sc-env-item"><span class="sc-env-icon">🚗</span><div class="sc-env-text"><strong>' +
              _scFmtN(cars) +
              '</strong><span>cars removed</span></div></div>'
            : '';
        var treesHtml =
          trees > 0
            ? '<div class="sc-env-item"><span class="sc-env-icon">🌳</span><div class="sc-env-text"><strong>' +
              _scFmtN(trees) +
              '</strong><span>trees planted</span></div></div>'
            : '';
        return '<div class="sc-env-items">' + carsHtml + treesHtml + '</div>';
      }
      return '<div style="color:var(--text3);font-size:12px;padding:20px 0;text-align:center">Savings data required for environmental equivalents</div>';
    })() +
    '<div style="margin-top:10px;font-size:10px;color:var(--text3);line-height:1.4">Based on EPA emissions equivalency factors. Savings are cumulative post-baseline.</div>' +
    '</div>' +
    '</div>' + // sc-bottom-row
    // Footer
    '<div class="sc-footer no-print">Control Service Company &mdash; CompanyHub Energy Report &mdash; ' +
    dateStr +
    '</div>' +
    '<div class="sc-footer print-only">Control Service Company &mdash; CompanyHub Energy Report &mdash; ' +
    dateStr +
    '</div>' +
    '</div>'; // sc-root

  // Draw sparkline after DOM is ready
  if (sparkVals.length > 1) {
    _scSparkline(sparkVals, sparkId);
  }
}
