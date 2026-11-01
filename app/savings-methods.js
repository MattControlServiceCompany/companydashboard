// app/savings-methods.js - INTERNAL savings-methods panel (Matt, 2026-11-01).
// Utility Data > project panel bar > "Savings Methods (internal)". Never shown to a client: no report,
// export, portal or print code may call renderSavingsMethodsPanel / savingsMethodsHtml
// (test-savings-methods-internal.js proves the report engine and the exports do not).
// All numbers come from getProjectSavingsMethods and getProjectSavingsMethodsProjection (computations/savings.js). This file only draws them.

const SM_HDR =
  'padding:6px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text);background:var(--s1);border-right:1px solid var(--border);border-bottom:1px solid var(--border2);white-space:nowrap;position:sticky;top:0;z-index:2';
const SM_CELL =
  'padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--text);border-right:1px solid var(--border);border-bottom:1px solid var(--border);white-space:nowrap';
const SM_METHODS = [
  { k: 'm1', name: 'M1', note: 'Raw baseline vs raw actual' },
  { k: 'm2', name: 'M2', note: 'Fitted at baseline weather vs raw actual' },
  { k: 'm3', name: 'M3', note: 'Raw baseline vs actual at baseline weather' },
  { k: 'm4', name: 'M4', note: 'Contract method: fitted at actual weather vs raw actual' },
];

// Signed whole dollars: +$2,296 / -$3,596.
function smMoney(v) {
  const r = Math.round(v);
  return (r < 0 ? '-' : r > 0 ? '+' : '') + '$' + Math.abs(r).toLocaleString('en-US');
}

// One cell: the dollars, or the shared "Waiting for weather data" words when a month has no weather yet.
function smCell(waiting, dollars, extraStyle) {
  const txt = waiting.length ? savingsOrWaiting(waiting, 0) : smMoney(dollars);
  return '<td style="' + SM_CELL + (extraStyle || '') + '">' + _escHtml(txt) + '</td>';
}

function smRowCells(waiting, E, K) {
  // A quarter with a month still waiting for weather: one cell with the shared words, never 0.
  if (waiting.length) return '<td colspan="12" style="' + SM_CELL + ';text-align:left">' + _escHtml(savingsOrWaiting(waiting, 0)) + '</td>';
  return SM_METHODS.map((mt) => {
    const accent = mt.k === 'm4' ? ';border-left:2px solid var(--em)' : '';
    return (
      smCell(waiting, E[mt.k], accent) +
      smCell(waiting, K[mt.k]) +
      smCell(waiting, E[mt.k] + K[mt.k], ';font-weight:700')
    );
  }).join('');
}

function smQuarterHtml(q) {
  const head1 =
    '<th rowspan="2" style="' + SM_HDR + ';text-align:left">Building</th>' +
    SM_METHODS.map((mt) => {
      const accent = mt.k === 'm4' ? ';border-left:2px solid var(--em);border-bottom:2px solid var(--em)' : '';
      return (
        '<th colspan="3" style="' + SM_HDR + ';text-align:center' + accent + '" title="' + _escHtml(mt.note) + '">' +
        _escHtml(mt.name + (mt.k === 'm4' ? ' contract method' : '')) +
        '</th>'
      );
    }).join('');
  const head2 = SM_METHODS.map((mt) => {
    const accent = mt.k === 'm4' ? ';border-left:2px solid var(--em)' : '';
    return (
      '<th style="' + SM_HDR + ';top:29px' + accent + '">Energy</th>' +
      '<th style="' + SM_HDR + ';top:29px">kW</th>' +
      '<th style="' + SM_HDR + ';top:29px">Total</th>'
    );
  }).join('');
  const body = q.buildings
    .map(
      (b) =>
        '<tr><td style="' + SM_CELL + ';text-align:left">' + _escHtml(b.name) + '</td>' + smRowCells(b.waiting, b.E, b.K) + '</tr>',
    )
    .join('');
  const t = q.total;
  const foot =
    '<tr><td style="' + SM_CELL + ';text-align:left;font-weight:700;background:var(--s1);border-top:2px solid var(--border2)">Total</td>' +
    smRowCells(t.waiting, t.E, t.K).replace(/<td ([^>]*)style="/g, '<td $1style="background:var(--s1);border-top:2px solid var(--border2);font-weight:700;') +
    '</tr>';
  // Bridge: M4 = M1 (raw change) + fit gap (M2 - M1) + weather credit (M4 - M2).
  const sum = (k) => t.E[k] + t.K[k];
  const bridge = t.waiting.length
    ? _escHtml(savingsOrWaiting(t.waiting, 0))
    : 'Raw change ' + _escHtml(smMoney(sum('m1'))) +
      ' + fit gap ' + _escHtml(smMoney(sum('m2') - sum('m1'))) +
      ' + weather credit ' + _escHtml(smMoney(sum('m4') - sum('m2'))) +
      ' = M4 ' + _escHtml(smMoney(sum('m4')));
  const monthsNote = q.months.length < 3 ? ' (' + q.months.length + ' of 3 months billed)' : '';
  return (
    '<div style="margin-bottom:22px" data-sm-quarter="' + _escHtml(q.key) + '">' +
    '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px">' + _escHtml(q.label + monthsNote) + '</div>' +
    '<div class="ch-tbl-outer" style="border:1px solid var(--border);border-radius:6px;overflow:auto;max-height:70vh;background:var(--s2)">' +
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%"><thead><tr>' + head1 + '</tr><tr>' + head2 +
    '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
    '<div style="font-size:12px;color:var(--text);margin-top:6px;font-family:var(--mono)" data-sm-bridge="1">Bridge: ' + bridge + '</div>' +
    '</div>'
  );
}

// The 3-year projection block: one row per method, from getProjectSavingsMethodsProjection.
function smProjectionHtml(pr) {
  if (!pr) return '';
  const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const head = ['Method', 'Savings to date', 'Projected remaining', '3-year total', 'Contract target']
    .map((h, i) => '<th style="' + SM_HDR + (i === 0 ? ';text-align:left' : '') + '">' + _escHtml(h) + '</th>')
    .join('');
  const body = pr.rows
    .map((r) => {
      const mt = SM_METHODS.find((m) => m.k === r.k);
      const accent = r.k === 'm4' ? ';font-weight:700;border-left:2px solid var(--em)' : '';
      return (
        '<tr data-sm-proj="' + _escHtml(r.k) + '"><td style="' + SM_CELL + ';text-align:left' + accent + '" title="' + _escHtml(mt.note) + '">' +
        _escHtml(mt.name + (r.k === 'm4' ? ' contract method' : '')) + '</td>' +
        [r.toDate, r.remaining, r.total, r.target].map((v) => '<td style="' + SM_CELL + (r.k === 'm4' ? ';font-weight:700' : '') + '">' + _escHtml(usd(v)) + '</td>').join('') +
        '</tr>'
      );
    })
    .join('');
  const ex = pr.excluded.length ? ' Left out of savings to date: ' + pr.excluded.map((e) => e.label + ' (' + e.why + ')').join(', ') + '.' : '';
  const basis =
    'Projection basis: ' + pr.year + ' Q1 to Q' + pr.quarter + ' savings of each method (each quarter floored at $0; M4 uses the billed figure, the printed one for a presented quarter) plus the contract targets for the rest of that contract year; other contract years at their escalated target. The site uses the same projection.' + ex;
  return (
    '<div style="margin-bottom:22px" data-sm-projection="1">' +
    '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px">3-year projection</div>' +
    '<div class="ch-tbl-outer" style="border:1px solid var(--border);border-radius:6px;overflow:auto;background:var(--s2)">' +
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    '<div style="font-size:12px;color:var(--text);margin-top:6px" data-sm-basis="1">' + _escHtml(basis) + '</div>' +
    '</div>'
  );
}

function savingsMethodsHtml(projId) {
  const data = getProjectSavingsMethods(projId);
  if (!data) return '<div style="padding:20px;font-size:13px;color:var(--text)">This project has no service agreement.</div>';
  if (!data.quarters.length) return '<div style="padding:20px;font-size:13px;color:var(--text)">No months after the baseline yet.</div>';
  return (
    '<div style="padding:16px" id="savingsMethodsPanel">' +
    '<div style="font-size:14px;font-weight:700;color:var(--text)">Savings methods - recomputed, internal</div>' +
    '<div style="font-size:12px;color:var(--text);margin:4px 0 14px">Internal only. Never shown to a client. Each month is (baseline - actual) x that month\'s rate, then summed. ' +
    'Presented quarters keep their frozen figures everywhere else; these are new calculations.<br>' +
    'M1 raw baseline vs raw actual. M2 fitted baseline at baseline-year weather vs raw actual. ' +
    'M3 raw baseline vs actual moved to baseline-year weather. M4 fitted baseline at actual weather vs raw actual: the contract method.</div>' +
    smProjectionHtml(getProjectSavingsMethodsProjection(projId, data)) +
    data.quarters.map(smQuarterHtml).join('') +
    '</div>'
  );
}

function renderSavingsMethodsPanel(content, projId) {
  content.innerHTML = savingsMethodsHtml(projId);
}
