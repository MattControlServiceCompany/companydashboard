/* ══════════════════════════════════════════════════════
   BUDGET VS ACTUAL MODULE
   Storage key: en_budget_<projId>
   Structure:
   {
     projId: string,
     fiscalYearStart: '07',  // default July for school districts
     budgets: [
       {
         id: string,          // 'b' + Date.now()
         year: number,        // fiscal year start year (2025 = FY 2025-26)
         label: string,       // e.g. 'FY 2025-26'
         scope: 'project'|'building',
         commodity: 'electric'|'gas'|'propane'|'water'|'sewer'|'all',
         buildingId: string|null,
         entryMode: 'annual'|'monthly',
         annualAmount: number|null,
         monthlyOverrides: object|null,  // {'YYYY-MM': number}
         notes: string,
         createdAt: string,
         updatedAt: string
       }
     ]
   }
   ══════════════════════════════════════════════════════ */

/* Inject base budget cell styles once — .bgt-cell-sm carries font-size:11px
   so the zoom rule (#budget-*-wrap td { … }) can override it (ID+element
   specificity beats a class). */
(function _injectBudgetCellCSS() {
  if (document.getElementById('bgt-cell-styles')) return;
  var s = document.createElement('style');
  s.id = 'bgt-cell-styles';
  s.textContent = '.bgt-cell-sm { font-size:11px; }';
  document.head.appendChild(s);
})();

/* ── Storage helpers ── */
function loadBudgetData(projId) {
  return sget('en_budget_' + projId, null);
}
function saveBudgetData(projId, data) {
  sset('en_budget_' + projId, data);
}
function _getOrInitBudgetData(projId) {
  let d = loadBudgetData(projId);
  if (!d) {
    d = { projId: String(projId), fiscalYearStart: '07', budgets: [] };
    saveBudgetData(projId, d);
  }
  return d;
}

/* ── Fiscal year helpers ── */
function _fyLabel(year) {
  return 'FY ' + year + '-' + String(year + 1).slice(2);
}

// Returns array of 'YYYY-MM' strings for a fiscal year starting in fyStart (e.g. '07'), year = start year
function _fyMonths(year, fyStart) {
  const fy = parseInt(fyStart) || 7;
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = fy + i;
    if (m <= 12) {
      months.push(year + '-' + String(m).padStart(2, '0'));
    } else {
      months.push(year + 1 + '-' + String(m - 12).padStart(2, '0'));
    }
  }
  return months;
}

// Get the budget dollar amount for a specific YYYY-MM
function getBudgetForMonth(budgetLine, yearMonth) {
  if (budgetLine.entryMode === 'monthly' && budgetLine.monthlyOverrides) {
    return budgetLine.monthlyOverrides[yearMonth] || 0;
  }
  // Annual: divide evenly
  return (budgetLine.annualAmount || 0) / 12;
}

/* ── Actual cost from bill tree ── */
// Returns actual $ for a commodity + optional buildingId for a given YYYY-MM
// Uses bill.end date to assign month (consistent with rest of app)
function getActualForMonth(projId, commodity, buildingId, yearMonth) {
  const ud = utilityData[projId];
  if (!ud) return null;
  const commodityMatch = commodity === 'all' ? null : commodity.charAt(0).toUpperCase() + commodity.slice(1);
  let total = 0;
  let hasBill = false;
  const bldgs = ud.buildings || [];
  for (const b of bldgs) {
    if (buildingId && b.id !== buildingId) continue;
    for (const m of b.meters || []) {
      if (commodityMatch && m.commodity !== commodityMatch) continue;
      for (const bill of m.bills || []) {
        // Assign bill to month of its end date
        const endDate = bill.end || bill.start || '';
        if (!endDate) continue;
        const billYM = endDate.substring(0, 7); // 'YYYY-MM'
        if (billYM === yearMonth) {
          const cost =
            parseFloat(bill.totalCost) ||
            parseFloat(bill.thermCost) ||
            parseFloat(bill.kwCost || 0) +
              parseFloat(bill.kwhCost || 0) +
              parseFloat(bill.otherCost || 0) +
              parseFloat(bill.taxCost || 0) ||
            parseFloat(bill.cost || 0) ||
            0;
          total += cost;
          hasBill = true;
        }
      }
    }
  }
  if (!hasBill) return null; // honest: no bill entered, not zero
  return total;
}

/* ── Variance computation ── */
// Returns array of month objects for the full fiscal year
function computeVariance(projId, budgetLine, fiscalYearStart) {
  const months = _fyMonths(budgetLine.year, fiscalYearStart || '07');
  const now = new Date();
  const nowYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  let ytdBudget = 0,
    ytdActual = 0,
    monthsElapsed = 0;
  const rows = months.map((ym) => {
    const budgetAmt = getBudgetForMonth(budgetLine, ym);
    const actualAmt = getActualForMonth(projId, budgetLine.commodity, budgetLine.buildingId, ym);
    const isPast = ym <= nowYM;
    let variance = null,
      variancePct = null;
    if (isPast) {
      ytdBudget += budgetAmt;
      if (actualAmt !== null) {
        ytdActual += actualAmt;
        monthsElapsed++;
        variance = actualAmt - budgetAmt;
        variancePct = budgetAmt > 0 ? (variance / budgetAmt) * 100 : 0;
      }
    }
    return {
      ym,
      budget: budgetAmt,
      actual: actualAmt,
      variance,
      variancePct,
      isPast,
      ytdBudget: isPast ? ytdBudget : null,
      ytdActual: isPast && actualAmt !== null ? ytdActual : null,
      ytdVariance: isPast && actualAmt !== null ? ytdActual - ytdBudget : null,
    };
  });
  // Compute projection: (ytdVariance / monthsElapsed) * 12
  const ytdVariance = ytdActual - ytdBudget;
  const projection = monthsElapsed > 0 ? (ytdVariance / monthsElapsed) * 12 : null;
  const annualBudget =
    budgetLine.entryMode === 'monthly'
      ? Object.values(budgetLine.monthlyOverrides || {}).reduce((s, v) => s + v, 0)
      : budgetLine.annualAmount || 0;
  return { rows, ytdBudget, ytdActual, ytdVariance, monthsElapsed, projection, annualBudget };
}

/* ── Budget Tab Renderer ── */
let _budgetSelYear = {}; // projId -> year number

function initBudgetTab(projId) {
  const el = document.getElementById('ptab-budget-body-' + projId);
  if (!el) return;
  const bd = _getOrInitBudgetData(projId);
  if (!_budgetSelYear[projId]) {
    // Default to most recent fiscal year, or current
    const now = new Date();
    const fyStart = parseInt(bd.fiscalYearStart) || 7;
    const year = now.getMonth() + 1 >= fyStart ? now.getFullYear() : now.getFullYear() - 1;
    _budgetSelYear[projId] = year;
  }
  el.innerHTML = _renderBudgetTab(projId, bd);
  // Render charts and restore zoom after DOM insertion
  requestAnimationFrame(() => {
    _renderBudgetCharts(projId, bd);
    // Restore persisted zoom for budget tables
    if (typeof setTableZoom === 'function') {
      var bLines = document.getElementById('budget-lines-wrap-' + projId);
      if (bLines)
        setTableZoom(
          'budget-lines-wrap-' + projId,
          null,
          'en_budget_lines_zoom_' + projId,
          'budget-lines-zoom-lbl-' + projId,
        );
      var bd2 = _getOrInitBudgetData(projId);
      var year2 = _budgetSelYear[projId];
      (bd2.budgets || [])
        .filter(function (b) {
          return b.year === year2;
        })
        .forEach(function (line) {
          var vWrap = document.getElementById('budget-var-wrap-' + line.id);
          if (vWrap)
            setTableZoom(
              'budget-var-wrap-' + line.id,
              null,
              'en_budget_var_zoom_' + line.id,
              'budget-var-zoom-lbl-' + line.id,
            );
        });
    }
  });
}

function _renderBudgetTab(projId, bd) {
  const year = _budgetSelYear[projId];
  const fyStart = bd.fiscalYearStart || '07';
  const fyLabel = _fyLabel(year);
  const bldgs = getUDBldgs(projId);

  // Year options: current year ± 2
  const now = new Date();
  const fyMo = parseInt(fyStart);
  const curFyYear = now.getMonth() + 1 >= fyMo ? now.getFullYear() : now.getFullYear() - 1;
  const yearOptions = [curFyYear - 2, curFyYear - 1, curFyYear, curFyYear + 1]
    .map((y) => `<option value="${y}"${y === year ? ' selected' : ''}>${_fyLabel(y)}</option>`)
    .join('');

  // Get budget lines for this year
  const lines = (bd.budgets || []).filter((b) => b.year === year);

  // Fiscal year start selector
  const fyStartOptions = [
    ['01', 'January'],
    ['02', 'February'],
    ['03', 'March'],
    ['04', 'April'],
    ['05', 'May'],
    ['06', 'June'],
    ['07', 'July'],
    ['08', 'August'],
    ['09', 'September'],
    ['10', 'October'],
    ['11', 'November'],
    ['12', 'December'],
  ]
    .map(([v, l]) => `<option value="${v}"${v === fyStart ? ' selected' : ''}>${l}</option>`)
    .join('');

  // Variance tables for each line
  const varianceSections =
    lines.length === 0
      ? `<div style="text-align:center;padding:32px;color:var(--text3);font-size:13px">
        No budget lines set up for ${fyLabel}.<br>
        <span style="font-size:11px">Use <strong style="color:var(--em)">+ Add Budget Line</strong> above to get started.</span>
       </div>`
      : lines.map((line) => _renderVarianceSection(projId, line, bd, bldgs)).join('');

  return `
    <div style="padding:16px;max-width:900px;margin:0 auto">
      <!-- Header controls -->
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Fiscal Year</div>
          <select class="fi" style="width:160px" onchange="_budgetSelYear[${projId}]=+this.value;initBudgetTab(${projId})">
            ${yearOptions}
          </select>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">FY Start Month</div>
          <select class="fi" style="width:140px" onchange="_budgetUpdateFyStart(${projId},this.value)">
            ${fyStartOptions}
          </select>
        </div>
        <div style="padding-top:16px">
          <button class="btn btn-em btn-sm" onclick="_budgetOpenAddModal(${projId})">+ Add Budget Line</button>
        </div>
      </div>

      <!-- Budget lines table -->
      ${
        lines.length > 0
          ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-hdr" style="justify-content:space-between">
          <span class="card-title">Budget Lines — ${fyLabel}</span>
          ${typeof tableZoomControlHTML === 'function' ? tableZoomControlHTML('budget-lines-wrap-' + projId, 'en_budget_lines_zoom_' + projId, 'budget-lines-zoom-lbl-' + projId) : ''}
        </div>
        <div id="budget-lines-wrap-${projId}" style="overflow-x:auto">
          <table class="dtbl" style="width:100%;font-size:12px">
            <thead>
              <tr>
                <th style="text-align:left">Commodity</th>
                <th style="text-align:left">Scope</th>
                <th style="text-align:right">Annual Budget</th>
                <th style="text-align:left">Mode</th>
                <th style="text-align:left">Notes</th>
                <th style="text-align:center">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${lines
                .map((line) => {
                  const annAmt =
                    line.entryMode === 'monthly'
                      ? Object.values(line.monthlyOverrides || {}).reduce((s, v) => s + v, 0)
                      : line.annualAmount || 0;
                  const bldgName = line.buildingId
                    ? (bldgs.find((b) => b.id === line.buildingId) || {}).name || line.buildingId
                    : 'All Buildings';
                  const commLabel = line.commodity.charAt(0).toUpperCase() + line.commodity.slice(1);
                  return `<tr>
                  <td style="font-weight:600">${commLabel}</td>
                  <td style="color:var(--text2)">${bldgName}</td>
                  <td style="text-align:right;font-family:var(--mono)">$${Math.round(annAmt).toLocaleString()}</td>
                  <td class="bgt-cell-sm" style="color:var(--text3)">${line.entryMode === 'monthly' ? 'Monthly' : 'Annual ÷ 12'}</td>
                  <td class="bgt-cell-sm" style="color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${line.notes || ''}">${line.notes || '—'}</td>
                  <td style="text-align:center">
                    <button class="btn btn-ghost btn-sm" style="font-size:10px;margin-right:4px" onclick="_budgetOpenEditModal(${projId},'${line.id}')">Edit</button>
                    <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--danger);border-color:rgba(240,80,80,.3)" onclick="_budgetDeleteLine(${projId},'${line.id}')">Delete</button>
                  </td>
                </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`
          : ''
      }

      <!-- Variance sections per budget line -->
      ${varianceSections}
    </div>
  `;
}

function _renderVarianceSection(projId, line, bd, bldgs) {
  const { rows, ytdBudget, ytdActual, ytdVariance, monthsElapsed, projection, annualBudget } = computeVariance(
    projId,
    line,
    bd.fiscalYearStart,
  );
  const commLabel = line.commodity.charAt(0).toUpperCase() + line.commodity.slice(1);
  const bldgName = line.buildingId
    ? (bldgs.find((b) => b.id === line.buildingId) || {}).name || line.buildingId
    : 'All Buildings';
  const $f = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
  const $pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

  // Variance color
  const varColor = (v, pct) => {
    if (v === null) return 'var(--text3)';
    if (v <= 0) return 'var(--green)';
    if (pct <= 5) return 'var(--amber)';
    return 'var(--danger)';
  };
  const ytdVarColor =
    ytdVariance === null
      ? 'var(--text3)'
      : ytdVariance <= 0
        ? 'var(--green)'
        : ytdBudget > 0 && (ytdVariance / ytdBudget) * 100 <= 5
          ? 'var(--amber)'
          : 'var(--danger)';

  // Projection text
  let projText = '';
  if (projection !== null && monthsElapsed > 0) {
    const projOverUnder = projection >= 0 ? 'OVER budget by ' + $f(projection) : 'UNDER budget by ' + $f(projection);
    projText = `<div style="margin-top:12px;padding:10px 14px;background:var(--s2);border-radius:6px;font-size:12px;color:var(--text2)">
      <strong style="color:${projection >= 0 ? 'var(--danger)' : 'var(--green)'}">Projection:</strong>
      At the current YTD pace (${ytdVariance >= 0 ? '+' : ''}${$f(ytdVariance)} through ${monthsElapsed} month${monthsElapsed !== 1 ? 's' : ''}),
      you are on track to end ${_fyLabel(line.year)} approximately
      <strong style="color:${projection >= 0 ? 'var(--danger)' : 'var(--green)'}">${projOverUnder}</strong>.
      <span style="color:var(--text3);font-size:11px;margin-left:4px" title="Straight-line projection: (YTD variance ÷ months elapsed) × 12. Does not account for seasonality.">(?)</span>
    </div>`;
  }

  // Chart placeholder
  const chartId = 'budget-chart-' + line.id;

  const rowsHTML = rows
    .map((r) => {
      const mo = new Date(r.ym + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      const actCell =
        r.actual === null
          ? `<td style="text-align:right;color:var(--text3);font-style:italic">${r.isPast ? '(no bill)' : '—'}</td>`
          : `<td style="text-align:right;font-family:var(--mono)">${$f(r.actual)}</td>`;
      const varCell =
        r.variance === null
          ? `<td style="text-align:right;color:var(--text3)">—</td>`
          : `<td style="text-align:right;font-family:var(--mono);font-weight:600;color:${varColor(r.variance, r.variancePct)}">
          ${r.variance > 0 ? '+' : ''}${$f(r.variance)}
          <span style="font-size:10px">${$pct(r.variancePct || 0)}</span>
         </td>`;
      const ytdActCell =
        r.ytdActual === null
          ? `<td style="text-align:right;color:var(--text3)">—</td>`
          : `<td class="bgt-cell-sm" style="text-align:right;font-family:var(--mono)">${$f(r.ytdActual)}</td>`;
      const ytdVarCell =
        r.ytdVariance === null
          ? `<td style="text-align:right;color:var(--text3)">—</td>`
          : `<td class="bgt-cell-sm" style="text-align:right;font-family:var(--mono);color:${varColor(r.ytdVariance, r.ytdBudget > 0 ? (r.ytdVariance / r.ytdBudget) * 100 : 0)}">
          ${r.ytdVariance > 0 ? '+' : ''}${$f(r.ytdVariance)}
         </td>`;
      return `<tr style="${!r.isPast ? 'opacity:.45' : ''}">
      <td style="font-weight:600;white-space:nowrap">${mo}</td>
      <td style="text-align:right;font-family:var(--mono)">${$f(r.budget)}</td>
      ${actCell}
      ${varCell}
      <td class="bgt-cell-sm" style="text-align:right;font-family:var(--mono);color:var(--text2)">${$f(r.ytdBudget || 0)}</td>
      ${ytdActCell}
      ${ytdVarCell}
    </tr>`;
    })
    .join('');

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-hdr" style="justify-content:space-between">
        <span class="card-title">${commLabel} Budget — ${_fyLabel(line.year)} · ${bldgName}</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${typeof tableZoomControlHTML === 'function' ? tableZoomControlHTML('budget-var-wrap-' + line.id, 'en_budget_var_zoom_' + line.id, 'budget-var-zoom-lbl-' + line.id) : ''}
          <button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="_budgetExportCSV(${projId},'${line.id}')">Export CSV</button>
        </div>
      </div>
      <!-- Chart -->
      <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;font-weight:600;color:var(--text2)">Monthly Actual vs. Budget</span>
        </div>
        <div style="position:relative;height:160px">
          <canvas id="${chartId}" style="width:100%;height:160px"></canvas>
        </div>
      </div>
      <!-- YTD summary -->
      ${
        monthsElapsed > 0
          ? `
      <div style="display:flex;gap:16px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:2px">YTD Budget</div>
          <div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$f(ytdBudget)}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:2px">YTD Actual</div>
          <div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$f(ytdActual)}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:2px">YTD Variance</div>
          <div style="font-size:16px;font-weight:700;font-family:var(--mono);color:${ytdVarColor}">${ytdVariance >= 0 ? '+' : ''}${$f(ytdVariance)}</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:2px">Annual Budget</div>
          <div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$f(annualBudget)}</div>
        </div>
      </div>`
          : ''
      }
      <!-- Variance table -->
      <div id="budget-var-wrap-${line.id}" style="overflow-x:auto">
        <table class="dtbl" style="width:100%;font-size:12px">
          <thead>
            <tr>
              <th style="text-align:left">Month</th>
              <th style="text-align:right">Budget</th>
              <th style="text-align:right">Actual</th>
              <th style="text-align:right">Variance</th>
              <th style="text-align:right">YTD Budget</th>
              <th style="text-align:right">YTD Actual</th>
              <th style="text-align:right">YTD Variance</th>
            </tr>
          </thead>
          <tbody>${rowsHTML}</tbody>
          <tfoot>
            <tr style="font-weight:700;border-top:2px solid var(--border)">
              <td>Annual</td>
              <td style="text-align:right;font-family:var(--mono)">${$f(annualBudget)}</td>
              <td style="text-align:right;font-family:var(--mono)">${monthsElapsed > 0 ? $f(ytdActual) + '*' : '—'}</td>
              <td colspan="4" style="font-size:11px;color:var(--text3);text-align:right">* YTD through ${monthsElapsed} month${monthsElapsed !== 1 ? 's' : ''}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${projText}
    </div>
  `;
}

function _renderBudgetCharts(projId, bd) {
  if (typeof Chart === 'undefined') return;
  const year = _budgetSelYear[projId];
  const lines = (bd.budgets || []).filter((b) => b.year === year);
  lines.forEach((line) => {
    const canvasId = 'budget-chart-' + line.id;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    // Destroy existing chart if any
    if (canvas._budgetChart) {
      canvas._budgetChart.destroy();
      canvas._budgetChart = null;
    }
    const { rows } = computeVariance(projId, line, bd.fiscalYearStart);
    const labels = rows.map((r) =>
      new Date(r.ym + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    );
    const budgetData = rows.map((r) => Math.round(r.budget));
    const actualData = rows.map((r) => (r.actual !== null ? Math.round(r.actual) : null));

    // Bar colors: blue=under, amber=0-10% over, red=>10% over
    const barColors = rows.map((r) => {
      if (r.actual === null) return 'rgba(100,116,139,0.3)';
      const overpct = r.budget > 0 ? ((r.actual - r.budget) / r.budget) * 100 : 0;
      if (overpct <= 0) return 'rgba(34,197,94,0.7)';
      if (overpct <= 10) return 'rgba(245,158,11,0.7)';
      return 'rgba(239,68,68,0.7)';
    });

    const ctx = canvas.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Actual Cost',
            data: actualData,
            backgroundColor: barColors,
            borderColor: barColors.map((c) => c.replace('0.7', '1')),
            borderWidth: 1,
            borderRadius: 3,
          },
          {
            label: 'Budget',
            data: budgetData,
            type: 'line',
            borderColor: 'rgba(99,102,241,0.8)',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 2,
            pointBackgroundColor: 'rgba(99,102,241,0.8)',
            fill: false,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              color: 'var(--text2)',
              font: { size: 10 },
              boxWidth: 12,
              padding: 8,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw;
                if (v === null || v === undefined) return ctx.dataset.label + ': (no bill)';
                return ctx.dataset.label + ': $' + Math.round(v).toLocaleString();
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: 'var(--text3)', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            ticks: {
              color: 'var(--text3)',
              font: { size: 10 },
              callback: (v) => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v),
            },
            grid: { color: 'rgba(255,255,255,0.06)' },
            beginAtZero: true,
          },
        },
      },
    });
    canvas._budgetChart = chart;
  });
}

/* ── Budget KPI Card (injected into Dashboard tab) ── */
function renderBudgetKPICard(projId) {
  const bd = loadBudgetData(projId);
  if (!bd || !bd.budgets || !bd.budgets.length) return '';

  const fyStart = bd.fiscalYearStart || '07';
  const now = new Date();
  const fyMo = parseInt(fyStart);
  const curYear = now.getMonth() + 1 >= fyMo ? now.getFullYear() : now.getFullYear() - 1;

  // Use most recent year that has data
  const years = [...new Set(bd.budgets.map((b) => b.year))].sort((a, b) => b - a);
  const year = years[0];
  if (year === undefined) return '';

  const lines = bd.budgets.filter((b) => b.year === year);
  if (!lines.length) return '';

  // Aggregate across all project-scope commodity lines
  let totalAnnualBudget = 0,
    totalYTDBudget = 0,
    totalYTDActual = 0;
  let hasData = false;
  lines.forEach((line) => {
    const { ytdBudget, ytdActual, monthsElapsed, annualBudget } = computeVariance(projId, line, fyStart);
    if (monthsElapsed > 0) {
      totalAnnualBudget += annualBudget;
      totalYTDBudget += ytdBudget;
      totalYTDActual += ytdActual;
      hasData = true;
    }
  });
  if (!hasData) return '';

  const ytdVariance = totalYTDActual - totalYTDBudget;
  const ytdVarPct = totalYTDBudget > 0 ? (ytdVariance / totalYTDBudget) * 100 : 0;
  const progressPct = totalYTDBudget > 0 ? Math.min(100, (totalYTDActual / totalYTDBudget) * 100) : 0;

  let statusText, statusColor, cardBg, cardBorder;
  if (ytdVarPct <= 0) {
    statusText = 'On track';
    statusColor = 'var(--green)';
    cardBg = 'rgba(34,197,94,0.08)';
    cardBorder = 'rgba(34,197,94,0.25)';
  } else if (ytdVarPct <= 5) {
    statusText = 'Watch';
    statusColor = 'var(--amber)';
    cardBg = 'rgba(245,158,11,0.08)';
    cardBorder = 'rgba(245,158,11,0.25)';
  } else {
    statusText = 'Over budget';
    statusColor = 'var(--danger)';
    cardBg = 'rgba(239,68,68,0.08)';
    cardBorder = 'rgba(239,68,68,0.25)';
  }

  const $f = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
  const fyLabel = _fyLabel(year);
  const progressBar = Math.round(progressPct);
  const progressColor = ytdVarPct <= 0 ? 'var(--green)' : ytdVarPct <= 5 ? 'var(--amber)' : 'var(--danger)';
  const monthsLeft = 12 - lines[0] ? 0 : 0; // computed below
  const nowYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const fyMonths = _fyMonths(year, fyStart);
  const elapsed = fyMonths.filter((ym) => ym <= nowYM).length;
  const remaining = 12 - elapsed;

  return `
    <div style="flex:1;min-width:220px;background:${cardBg};border:1px solid ${cardBorder};border-radius:8px;padding:16px;cursor:pointer" onclick="_budgetNavToTab(${projId})">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:${statusColor};font-weight:600;margin-bottom:6px">Utility Budget — ${fyLabel}</div>
      <div style="font-size:13px;font-family:var(--mono);margin-bottom:8px">
        ${$f(totalYTDActual)} <span style="color:var(--text3);font-size:11px">/ ${$f(totalYTDBudget)} YTD</span>
      </div>
      <div style="background:var(--s3);border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">
        <div style="background:${progressColor};height:100%;width:${progressBar}%;border-radius:4px;transition:width .3s"></div>
      </div>
      <div style="font-size:11px;color:var(--text2)">${remaining} month${remaining !== 1 ? 's' : ''} remaining</div>
      <div style="font-size:12px;font-weight:600;color:${statusColor};margin-top:4px">${statusText} ${ytdVariance <= 0 ? '' : '(' + $f(ytdVariance) + ' over)'}</div>
    </div>
  `;
}

function _budgetNavToTab(projId) {
  const btn = document.querySelector('.pdt[data-tab="budget"]');
  sPTab('budget', btn || null);
}

/* ── Add / Edit Budget Modal ── */
let _budgetEditingId = null;

function _budgetOpenAddModal(projId) {
  _budgetEditingId = null;
  _budgetShowModal(projId, null);
}
function _budgetOpenEditModal(projId, lineId) {
  _budgetEditingId = lineId;
  const bd = loadBudgetData(projId);
  const line = (bd.budgets || []).find((b) => b.id === lineId);
  _budgetShowModal(projId, line);
}

function _budgetShowModal(projId, line) {
  const bd = _getOrInitBudgetData(projId);
  const bldgs = getUDBldgs(projId);
  const fyStart = bd.fiscalYearStart || '07';
  const now = new Date();
  const fyMo = parseInt(fyStart);
  const curFyYear = now.getMonth() + 1 >= fyMo ? now.getFullYear() : now.getFullYear() - 1;
  const yearOptions = [curFyYear - 2, curFyYear - 1, curFyYear, curFyYear + 1]
    .map(
      (y) =>
        `<option value="${y}"${line && line.year === y ? ' selected' : y === curFyYear && !line ? ' selected' : ''}>${_fyLabel(y)}</option>`,
    )
    .join('');
  const commodities = ['electric', 'gas', 'propane', 'water', 'sewer', 'all'];
  const commOptions = commodities
    .map(
      (c) =>
        `<option value="${c}"${line && line.commodity === c ? ' selected' : c === 'electric' && !line ? ' selected' : ''}>${c.charAt(0).toUpperCase() + c.slice(1)}</option>`,
    )
    .join('');
  const scopeOptions = `<option value="project"${!line || line.scope === 'project' ? ' selected' : ''}>All Buildings</option>
    ${bldgs.map((b) => `<option value="${b.id}"${line && line.buildingId === b.id ? ' selected' : ''}>${b.name}</option>`).join('')}`;
  const isMonthly = line && line.entryMode === 'monthly';
  const annualAmt = line ? (line.entryMode === 'annual' ? line.annualAmount || '' : '') : '';

  // Monthly fields
  let monthlyFields = '';
  if (line && line.entryMode === 'monthly') {
    const fyMonths = _fyMonths(line.year, fyStart);
    const overrides = line.monthlyOverrides || {};
    const pairs = [];
    for (let i = 0; i < fyMonths.length; i += 2) {
      const mo1 = fyMonths[i];
      const mo2 = fyMonths[i + 1];
      const label1 = new Date(mo1 + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const label2 = mo2
        ? new Date(mo2 + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        : null;
      pairs.push(`
        <div style="display:flex;gap:8px;align-items:center">
          <label style="width:90px;font-size:11px;color:var(--text2)">${label1}</label>
          <input class="fi" type="number" step="0.01" min="0" style="width:110px" data-budget-mo="${mo1}" value="${overrides[mo1] || ''}" oninput="_budgetUpdateMonthlyTotal()">
          ${
            mo2
              ? `<label style="width:90px;font-size:11px;color:var(--text2);margin-left:8px">${label2}</label>
          <input class="fi" type="number" step="0.01" min="0" style="width:110px" data-budget-mo="${mo2}" value="${overrides[mo2] || ''}" oninput="_budgetUpdateMonthlyTotal()">`
              : ''
          }
        </div>`);
    }
    monthlyFields = `<div id="bm-monthly-fields" style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
      ${pairs.join('')}
      <div style="text-align:right;font-size:12px;color:var(--text2);margin-top:4px">Annual Total: <strong id="bm-annual-total" style="font-family:var(--mono);color:var(--em)">$0</strong></div>
    </div>`;
  }

  // Prior year copy option
  const priorYears = [...new Set((bd.budgets || []).map((b) => b.year))]
    .filter((y) => y < curFyYear)
    .sort((a, b) => b - a);
  const copyOption = priorYears.length
    ? `<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="_budgetCopyFromPrior(${projId})">Copy from ${_fyLabel(priorYears[0])} with adjustment:</button>
        <select class="fi" id="bm-copy-adj" style="width:100px">
          <option value="0">Flat (0%)</option>
          <option value="1">+1%</option>
          <option value="2">+2%</option>
          <option value="3" selected>+3%</option>
          <option value="5">+5%</option>
          <option value="10">+10%</option>
        </select>
      </div>`
    : '';

  const modalHtml = `
    <div id="budget-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)_budgetCloseModal()">
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:10px;padding:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div style="font-size:15px;font-weight:700;color:var(--text)">${line ? 'Edit' : 'Add'} Budget Line</div>
          <button style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:18px;padding:0 4px" onclick="_budgetCloseModal()">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Fiscal Year</label>
            <select class="fi" id="bm-year" style="width:100%">${yearOptions}</select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Commodity</label>
            <select class="fi" id="bm-commodity" style="width:100%">${commOptions}</select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Scope</label>
            <select class="fi" id="bm-scope" style="width:100%">${scopeOptions}</select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:6px">Entry Mode</label>
            <div style="display:flex;gap:16px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                <input type="radio" name="bm-mode" value="annual" ${!isMonthly ? 'checked' : ''} onchange="_budgetToggleMode(${projId},this.value)"> Annual total — divide evenly
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                <input type="radio" name="bm-mode" value="monthly" ${isMonthly ? 'checked' : ''} onchange="_budgetToggleMode(${projId},this.value)"> Monthly breakdown
              </label>
            </div>
          </div>
          <div id="bm-annual-wrap" style="${isMonthly ? 'display:none' : ''}">
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Annual Budget Amount ($)</label>
            <input class="fi" type="number" id="bm-annual" style="width:100%" placeholder="e.g. 185000" value="${annualAmt}">
          </div>
          <div id="bm-monthly-wrap" style="${!isMonthly ? 'display:none' : ''}">
            ${monthlyFields}
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Notes (optional)</label>
            <input class="fi" type="text" id="bm-notes" style="width:100%" placeholder="Board approved 8/12/2025..." value="${line ? line.notes || '' : ''}">
          </div>
          ${copyOption}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
          <button class="btn btn-ghost" onclick="_budgetCloseModal()">Cancel</button>
          <button class="btn btn-em" onclick="_budgetSaveLine(${projId})">Save Budget Line</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  _budgetUpdateMonthlyTotal();
}

function _budgetCloseModal() {
  const overlay = document.getElementById('budget-modal-overlay');
  if (overlay) overlay.remove();
  _budgetEditingId = null;
}

function _budgetToggleMode(projId, mode) {
  const annWrap = document.getElementById('bm-annual-wrap');
  const moWrap = document.getElementById('bm-monthly-wrap');
  if (!annWrap || !moWrap) return;
  if (mode === 'annual') {
    annWrap.style.display = '';
    moWrap.style.display = 'none';
  } else {
    annWrap.style.display = 'none';
    moWrap.style.display = '';
    // Build monthly fields if not yet built
    const mf = document.getElementById('bm-monthly-fields');
    if (!mf) {
      const year = parseInt(document.getElementById('bm-year').value);
      const bd = loadBudgetData(projId) || { fiscalYearStart: '07' };
      const fyMonths = _fyMonths(year, bd.fiscalYearStart || '07');
      let html = `<div id="bm-monthly-fields" style="display:flex;flex-direction:column;gap:8px">`;
      for (let i = 0; i < fyMonths.length; i += 2) {
        const mo1 = fyMonths[i],
          mo2 = fyMonths[i + 1];
        const l1 = new Date(mo1 + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        const l2 = mo2
          ? new Date(mo2 + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
          : null;
        html += `<div style="display:flex;gap:8px;align-items:center">
          <label style="width:90px;font-size:11px;color:var(--text2)">${l1}</label>
          <input class="fi" type="number" step="0.01" min="0" style="width:110px" data-budget-mo="${mo1}" value="" oninput="_budgetUpdateMonthlyTotal()">
          ${
            l2
              ? `<label style="width:90px;font-size:11px;color:var(--text2);margin-left:8px">${l2}</label>
          <input class="fi" type="number" step="0.01" min="0" style="width:110px" data-budget-mo="${mo2}" value="" oninput="_budgetUpdateMonthlyTotal()">`
              : ''
          }
        </div>`;
      }
      html += `<div style="text-align:right;font-size:12px;color:var(--text2);margin-top:4px">Annual Total: <strong id="bm-annual-total" style="font-family:var(--mono);color:var(--em)">$0</strong></div></div>`;
      moWrap.innerHTML = html;
    }
    _budgetUpdateMonthlyTotal();
  }
}

function _budgetUpdateMonthlyTotal() {
  const inputs = document.querySelectorAll('[data-budget-mo]');
  let total = 0;
  inputs.forEach((inp) => {
    total += parseFloat(inp.value) || 0;
  });
  const el = document.getElementById('bm-annual-total');
  if (el) el.textContent = '$' + Math.round(total).toLocaleString();
}

function _budgetSaveLine(projId) {
  const yearEl = document.getElementById('bm-year');
  const commEl = document.getElementById('bm-commodity');
  const scopeEl = document.getElementById('bm-scope');
  const notesEl = document.getElementById('bm-notes');
  const modeEl = document.querySelector('input[name="bm-mode"]:checked');
  const annualEl = document.getElementById('bm-annual');
  if (!yearEl || !commEl || !scopeEl || !modeEl) {
    showToast('Form error — please try again');
    return;
  }
  const year = parseInt(yearEl.value);
  const commodity = commEl.value;
  const scopeVal = scopeEl.value;
  const mode = modeEl.value;
  const notes = notesEl ? notesEl.value.trim() : '';
  const scope = scopeVal === 'project' ? 'project' : 'building';
  const buildingId = scope === 'building' ? scopeVal : null;

  let annualAmount = null,
    monthlyOverrides = null;
  if (mode === 'annual') {
    annualAmount = parseFloat(annualEl ? annualEl.value : '') || 0;
    if (!annualAmount) {
      showToast('Please enter an annual budget amount');
      return;
    }
  } else {
    monthlyOverrides = {};
    document.querySelectorAll('[data-budget-mo]').forEach((inp) => {
      monthlyOverrides[inp.dataset.budgetMo] = parseFloat(inp.value) || 0;
    });
    const total = Object.values(monthlyOverrides).reduce((s, v) => s + v, 0);
    if (!total) {
      showToast('Please enter at least one monthly amount');
      return;
    }
  }

  const bd = _getOrInitBudgetData(projId);
  const now = new Date().toISOString();
  if (_budgetEditingId) {
    const idx = bd.budgets.findIndex((b) => b.id === _budgetEditingId);
    if (idx >= 0) {
      bd.budgets[idx] = Object.assign(bd.budgets[idx], {
        year,
        label: _fyLabel(year),
        scope,
        commodity,
        buildingId,
        entryMode: mode,
        annualAmount,
        monthlyOverrides,
        notes,
        updatedAt: now,
      });
    }
  } else {
    bd.budgets.push({
      id: 'b' + Date.now(),
      year,
      label: _fyLabel(year),
      scope,
      commodity,
      buildingId,
      entryMode: mode,
      annualAmount,
      monthlyOverrides,
      notes,
      createdAt: now,
      updatedAt: now,
    });
  }
  saveBudgetData(projId, bd);
  _budgetCloseModal();
  initBudgetTab(projId);
  // Also refresh dashboard KPI card if on dashboard tab
  if (window._activeProjTab === 'dashboard') initDashboardTab(projId);
  showToast('Budget line saved');
}

function _budgetDeleteLine(projId, lineId) {
  if (!confirm('Delete this budget line? This cannot be undone.')) return;
  const bd = _getOrInitBudgetData(projId);
  bd.budgets = (bd.budgets || []).filter((b) => b.id !== lineId);
  saveBudgetData(projId, bd);
  initBudgetTab(projId);
  if (window._activeProjTab === 'dashboard') initDashboardTab(projId);
  showToast('Budget line deleted');
}

function _budgetUpdateFyStart(projId, value) {
  const bd = _getOrInitBudgetData(projId);
  bd.fiscalYearStart = value;
  saveBudgetData(projId, bd);
  initBudgetTab(projId);
}

function _budgetCopyFromPrior(projId) {
  const adjEl = document.getElementById('bm-copy-adj');
  const adjPct = parseFloat(adjEl ? adjEl.value : '0') / 100;
  const bd = loadBudgetData(projId);
  if (!bd) return;
  const curYear = parseInt(document.getElementById('bm-year').value);
  const priorYear = curYear - 1;
  const priorLines = (bd.budgets || []).filter((b) => b.year === priorYear);
  if (!priorLines.length) {
    showToast('No prior year data found');
    return;
  }
  // Pre-fill fields from first matching commodity/scope
  const commEl = document.getElementById('bm-commodity');
  const scopeEl = document.getElementById('bm-scope');
  const matchLine =
    priorLines.find(
      (l) =>
        l.commodity === (commEl ? commEl.value : '') &&
        (scopeEl ? (l.scope === 'project' ? scopeEl.value === 'project' : l.buildingId === scopeEl.value) : true),
    ) || priorLines[0];
  if (matchLine.entryMode === 'annual' && matchLine.annualAmount) {
    const newAmt = matchLine.annualAmount * (1 + adjPct);
    const annEl = document.getElementById('bm-annual');
    if (annEl) annEl.value = Math.round(newAmt);
    // Set radio to annual
    const annRadio = document.querySelector('input[name="bm-mode"][value="annual"]');
    if (annRadio) {
      annRadio.checked = true;
      _budgetToggleMode(projId, 'annual');
    }
  } else if (matchLine.entryMode === 'monthly' && matchLine.monthlyOverrides) {
    const moRadio = document.querySelector('input[name="bm-mode"][value="monthly"]');
    if (moRadio) {
      moRadio.checked = true;
      _budgetToggleMode(projId, 'monthly');
    }
    // Wait for DOM then fill
    requestAnimationFrame(() => {
      const fyStart = bd.fiscalYearStart || '07';
      const newMonths = _fyMonths(curYear, fyStart);
      const priorMonths = _fyMonths(priorYear, fyStart);
      newMonths.forEach((ym, i) => {
        const priorYM = priorMonths[i];
        const priorAmt = matchLine.monthlyOverrides[priorYM] || 0;
        const newAmt = priorAmt * (1 + adjPct);
        const inp = document.querySelector('[data-budget-mo="' + ym + '"]');
        if (inp) inp.value = Math.round(newAmt);
      });
      _budgetUpdateMonthlyTotal();
    });
  }
  showToast('Prior year data loaded — review and save');
}

/* ── CSV Export ── */
function _budgetExportCSV(projId, lineId) {
  const bd = loadBudgetData(projId);
  if (!bd) return;
  const line = (bd.budgets || []).find((b) => b.id === lineId);
  if (!line) return;
  const { rows } = computeVariance(projId, line, bd.fiscalYearStart);
  const headers = ['Month', 'Budget', 'Actual', 'Variance', 'Variance%', 'YTD Budget', 'YTD Actual', 'YTD Variance'];
  const csvRows = [headers.join(',')];
  rows.forEach((r) => {
    const mo = new Date(r.ym + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    csvRows.push(
      [
        mo,
        r.budget.toFixed(2),
        r.actual !== null ? r.actual.toFixed(2) : '',
        r.variance !== null ? r.variance.toFixed(2) : '',
        r.variancePct !== null ? r.variancePct.toFixed(1) + '%' : '',
        r.ytdBudget !== null ? r.ytdBudget.toFixed(2) : '',
        r.ytdActual !== null ? r.ytdActual.toFixed(2) : '',
        r.ytdVariance !== null ? r.ytdVariance.toFixed(2) : '',
      ].join(','),
    );
  });
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'budget-' + line.commodity + '-' + _fyLabel(line.year).replace(' ', '') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
