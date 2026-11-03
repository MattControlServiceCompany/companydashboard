// app/savings-methods.js - Savings Methods comparison section (Matt, 2026-11-03).
// Shown in Project > Performance, below the monthly chart (renderUDProjAggPanel 'perf' branch in app/utility-data.js).
// Never in a report, export, portal or print: no such code may call savingsMethodsHtml
// (test-savings-methods-internal.js proves it). The contract method governs all billed savings; the second
// column is a comparison and is never billed. All numbers come from getProjectSavingsComparison
// (computations/savings.js). This file only draws them.

const SM_HDR =
  'padding:6px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text);background:var(--s1);border-right:1px solid var(--border);border-bottom:1px solid var(--border2);white-space:normal';
const SM_CELL =
  'padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--text);border-right:1px solid var(--border);border-bottom:1px solid var(--border)';
const SM_NAME_CONTRACT = 'Contract method (billed)';
const SM_NAME_NORM = 'Bills normalized for weather and dates (comparison)';

// Whole dollars with the shared sign rule (savingsSign): +$2,296 / −$3,596 / $0.
function smMoney(v) {
  return savingsSign(v, 0) + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
}

function smMonthName(ym) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
}

// Hover text of a quarter figure: the months, then the energy and kW parts.
function smTip(q, which) {
  const key = which === 'contract' ? 'contract' : 'normalized';
  const months = q.months.map((ym) => smMonthName(ym) + ' ' + smMoney((q.monthly[ym] || {})[key] || 0)).join(' + ');
  const part = q[key];
  let t = months + ' = ' + smMoney(part.raw) + '. Energy (kWh, therms, gallons) ' + smMoney(part.E) + ' + demand kW ' + smMoney(part.K) + '.';
  t += ' Each month = (baseline - ' + (which === 'contract' ? 'actual bill' : 'normalized bill') + ') x that month\'s rate.';
  if (which === 'contract') t += ' Billed = the quarter, or its printed figure if presented, with a minimum of $0.';
  return t;
}

function smCellText(q, text, tip, extra) {
  return '<td style="' + SM_CELL + (extra || '') + '" title="' + _escHtml(tip) + '">' + _escHtml(text) + '</td>';
}

function smQuarterRow(q) {
  const label = '<td style="' + SM_CELL + ';text-align:left">' + _escHtml(q.label + (q.months.length < 3 ? ' (' + q.months.length + ' of 3 months billed)' : '')) + '</td>';
  if (q.waiting.length) {
    return '<tr data-sm-quarter="' + _escHtml(q.key) + '">' + label + '<td colspan="3" style="' + SM_CELL + ';text-align:left">' + _escHtml(savingsOrWaiting(q.waiting, 0)) + '</td></tr>';
  }
  return (
    '<tr data-sm-quarter="' + _escHtml(q.key) + '">' + label +
    smCellText(q, smMoney(q.contract.raw), smTip(q, 'contract'), ';font-weight:700;border-left:2px solid var(--em)') +
    smCellText(q, '$' + Math.round(q.contract.billed).toLocaleString('en-US'), smTip(q, 'contract')) +
    smCellText(q, smMoney(q.normalized.raw), smTip(q, 'normalized')) +
    '</tr>'
  );
}

function smYearHtml(y) {
  const head =
    '<th style="' + SM_HDR + ';text-align:left">' + _escHtml(y.year) + '</th>' +
    '<th style="' + SM_HDR + ';border-left:2px solid var(--em)" title="The billed method. Savings = (baseline - actual bill) x the month\'s rate, summed.">' + _escHtml(SM_NAME_CONTRACT) + '<br>quarter before the $0 floor</th>' +
    '<th style="' + SM_HDR + '" title="What is billed for the quarter: the contract method with a minimum of $0 (a presented quarter keeps its printed figure).">Billed</th>' +
    '<th style="' + SM_HDR + '" title="Same baseline. Only the bills change: each is prorated to calendar months, fitted to weather, and read at the baseline weather of its month. Not billed.">' + _escHtml(SM_NAME_NORM) + '<br>not billed</th>';
  const body = y.quarters.map(smQuarterRow).join('');
  const t = y.total;
  const wait = t.waiting.length ? ' (without ' + t.waiting.join(', ') + ')' : '';
  const foot =
    '<tr data-sm-year-total="' + _escHtml(y.year) + '"><td style="' + SM_CELL + ';text-align:left;font-weight:700;background:var(--s1);border-top:2px solid var(--border2)">' + _escHtml(y.year + ' total' + wait) + '</td>' +
    [smMoney(t.contractRaw), '$' + Math.round(t.contractBilled).toLocaleString('en-US'), smMoney(t.normalizedRaw)]
      .map((v, i) => '<td style="' + SM_CELL + ';font-weight:700;background:var(--s1);border-top:2px solid var(--border2)' + (i === 0 ? ';border-left:2px solid var(--em)' : '') + '">' + _escHtml(v) + '</td>')
      .join('') +
    '</tr>';
  return (
    '<div style="margin-bottom:18px"><div class="ch-tbl-outer" style="border:1px solid var(--border);border-radius:6px;overflow:auto;background:var(--s2)">' +
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div></div>'
  );
}

function savingsMethodsHtml(projId) {
  const data = getProjectSavingsComparison(projId);
  if (!data || !data.years.length) return '';
  return (
    '<div style="padding:16px 18px" id="savingsMethodsPanel">' +
    '<div style="padding:0 0 6px;font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Savings Methods Comparison</div>' +
    '<div style="font-size:12px;color:var(--text);margin:0 0 12px">The contract method decides what is billed. The second column uses the same baseline but compares it with bills moved to calendar months and to baseline weather. It is a comparison only and is not billed.</div>' +
    data.years.map(smYearHtml).join('') +
    '</div>'
  );
}
