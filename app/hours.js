/* ══════════════════════════════════════════════════════
   HOURS-PER-PROJECT TRACKING MODULE
   Storage key: en_hours_<projId>
   Structure:
   {
     projId: <number>,
     entries: [
       {
         id: <number>,          // Date.now()
         date: 'YYYY-MM-DD',   // for weekEntry: the Monday of the week
         hours: <number>,
         category: <string>,    // one of HOURS_CATEGORIES
         note: <string>,        // optional
         createdAt: <ISO>,
         updatedAt: <ISO>,
         // --- weekly-entry fields (optional, absent on per-day entries) ---
         weekEntry: true,       // present only on weekly aggregate entries
         weekEnd: 'YYYY-MM-DD' // the Sunday of the week (for display)
       }
     ]
   }
   Week attribution: weekly entries are bucketed by their Monday start date.
   Cross-month weeks count toward the month containing the Monday.
   ══════════════════════════════════════════════════════ */

const HOURS_CATEGORIES = [
  'Site Visit',
  'Data Entry',
  'Reporting',
  'Client Meeting',
  'Engineering',
  'Programming',
  'Other',
];

/* ── XSS escape helper ── */
function _esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Week-start helper (Mon–Sun weeks, Monday = week key) ── */
function _getWeekStart(dateStr) {
  // Returns YYYY-MM-DD for the Monday of the week containing dateStr.
  // Uses noon local time to avoid DST-shift edge cases.
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d.toISOString().substring(0, 10);
}

/* ── Week-end helper (Sunday of the week) ── */
function _getWeekEnd(weekStartStr) {
  const d = new Date(weekStartStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return d.toISOString().substring(0, 10);
}

/* ── Format a week range for display: "May 27 – Jun 2 2026" ── */
function _fmtWeekRange(weekStart, weekEnd) {
  const opts = { month: 'short', day: 'numeric' };
  const optsYear = { month: 'short', day: 'numeric', year: 'numeric' };
  // Use noon local time to avoid UTC/local date-shift
  const s = new Date(weekStart + 'T12:00:00');
  const e = new Date(weekEnd + 'T12:00:00');
  const startLabel = s.toLocaleDateString(undefined, opts);
  const endLabel = e.toLocaleDateString(undefined, optsYear);
  return startLabel + ' – ' + endLabel; // en-dash
}

/* ── Per-project view state: 'entries' | 'weekly' | 'monthly' ── */
// Memory-only (not persisted). Resets to 'entries' on tab re-init.
const _hoursView = {};

/* ── Storage helpers ── */
function loadHoursData(projId) {
  return sget('en_hours_' + projId, null);
}
function saveHoursData(projId, data) {
  sset('en_hours_' + projId, data);
}
function _getOrInitHoursData(projId) {
  let d = loadHoursData(projId);
  if (!d) {
    d = { projId: projId, entries: [] };
    saveHoursData(projId, d);
  }
  return d;
}

/* ── Rollup computation ── */
function _hoursRollup(entries) {
  const now = new Date();
  const thisMonthYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  let total = 0;
  let thisMonth = 0;
  const byCategory = {};
  HOURS_CATEGORIES.forEach((c) => (byCategory[c] = 0));
  // byWeek: weekStart (YYYY-MM-DD) → { hours, categories:{} }
  const byWeek = {};
  // byMonth: YYYY-MM → { hours, categories:{} }
  const byMonth = {};

  (entries || []).forEach((e) => {
    const h = parseFloat(e.hours) || 0;
    total += h;
    if (e.date && e.date.substring(0, 7) === thisMonthYM) thisMonth += h;
    if (byCategory[e.category] !== undefined) byCategory[e.category] += h;
    else byCategory['Other'] = (byCategory['Other'] || 0) + h;

    // --- Weekly bucket ---
    if (e.date) {
      const wk = _getWeekStart(e.date);
      if (!byWeek[wk]) {
        byWeek[wk] = {
          hours: 0,
          categories: {},
          // store weekEnd for display; for per-day entries derive it, for weekEntry use stored value
          weekEnd: e.weekEntry && e.weekEnd ? e.weekEnd : _getWeekEnd(wk),
        };
        HOURS_CATEGORIES.forEach((c) => (byWeek[wk].categories[c] = 0));
      }
      byWeek[wk].hours += h;
      if (byWeek[wk].categories[e.category] !== undefined) byWeek[wk].categories[e.category] += h;
      else byWeek[wk].categories['Other'] = (byWeek[wk].categories['Other'] || 0) + h;
    }

    // --- Monthly bucket ---
    // Attribution rule: use e.date's YYYY-MM (for weekEntry that is the Monday's month)
    if (e.date) {
      const mo = e.date.substring(0, 7);
      if (!byMonth[mo]) {
        byMonth[mo] = { hours: 0, categories: {} };
        HOURS_CATEGORIES.forEach((c) => (byMonth[mo].categories[c] = 0));
      }
      byMonth[mo].hours += h;
      if (byMonth[mo].categories[e.category] !== undefined) byMonth[mo].categories[e.category] += h;
      else byMonth[mo].categories['Other'] = (byMonth[mo].categories['Other'] || 0) + h;
    }
  });

  return { total, thisMonth, byCategory, byWeek, byMonth };
}

/* ── Tab init (entry point from sPTab) ── */
function initHoursTab(projId) {
  const el = document.getElementById('ptab-hours-body-' + projId);
  if (!el) return;
  const data = _getOrInitHoursData(projId);
  el.innerHTML = _renderHoursTab(projId, data);
}

/* ── View toggle handler ── */
function _hoursSetView(projId, view) {
  _hoursView[projId] = view;
  const data = _getOrInitHoursData(projId);
  const el = document.getElementById('ptab-hours-body-' + projId);
  if (el) el.innerHTML = _renderHoursTab(projId, data);
}

/* ── Tab renderer ── */
function _renderHoursTab(projId, data) {
  const entries = (data.entries || []).slice().sort((a, b) => {
    // Newest first: compare date strings, then createdAt
    if (b.date !== a.date) return b.date > a.date ? 1 : -1;
    return (b.createdAt || '') > (a.createdAt || '') ? 1 : -1;
  });
  const rollup = _hoursRollup(entries);
  const currentView = _hoursView[projId] || 'entries';

  // Top categories for display (non-zero, sorted desc)
  const catRows = HOURS_CATEGORIES.filter((c) => rollup.byCategory[c] > 0)
    .sort((a, b) => rollup.byCategory[b] - rollup.byCategory[a])
    .slice(0, 4);

  // Stat cards
  const statCard = (label, value) => `
    <div style="flex:1;min-width:130px;background:var(--s2);border-radius:8px;padding:14px 16px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:4px">${label}</div>
      <div style="font-size:28px;font-weight:700;font-family:var(--mono);color:var(--em)">${value}</div>
    </div>`;

  const catBadges = catRows.length
    ? catRows
        .map(
          (c) =>
            `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--s3);border-radius:4px;padding:3px 8px;font-size:11px;color:var(--text2);margin:2px">
          <span style="color:var(--text3)">${c}:</span>
          <span style="font-family:var(--mono);font-weight:600;color:var(--em)">${rollup.byCategory[c].toFixed(1)}</span>
        </span>`,
        )
        .join('')
    : '<span style="color:var(--text3);font-size:12px">No hours logged yet</span>';

  // Today's default for the date field
  const todayStr = new Date().toISOString().substring(0, 10);

  // Category options
  const catOptions = HOURS_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

  // ── View toggle buttons ──
  const toggleBtn = (view, label) => {
    const active = currentView === view;
    return `<button class="btn btn-sm${active ? ' btn-em' : ' btn-ghost'}" style="font-size:11px;padding:3px 10px" onclick="_hoursSetView(${projId},'${view}')">${label}</button>`;
  };
  const viewToggle = `
    <div style="display:flex;gap:4px;align-items:center">
      ${toggleBtn('entries', 'Entries')}
      ${toggleBtn('weekly', 'Weekly')}
      ${toggleBtn('monthly', 'Monthly')}
    </div>`;

  // ── Entries view (existing flat log) ──
  const entryTableRows =
    entries.length === 0
      ? `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px;font-style:italic">No hours logged yet. Use the form below to log your first entry.</td></tr>`
      : entries
          .map((e) => {
            // Date cell: range label + badge for weekly entries, plain date for per-day
            const weekBadge = e.weekEntry
              ? `<span style="display:inline-block;background:var(--accent);color:#fff;border-radius:3px;font-size:9px;padding:1px 5px;margin-left:5px;vertical-align:middle;letter-spacing:.3px;font-weight:600">WEEK</span>`
              : '';
            const dateLabel = e.weekEntry ? _fmtWeekRange(e.date, e.weekEnd || _getWeekEnd(e.date)) : e.date || '—';
            return `
          <tr>
            <td style="white-space:nowrap;color:var(--text2)">${dateLabel}${weekBadge}</td>
            <td style="text-align:right;font-family:var(--mono);font-weight:600;color:var(--em)">${(parseFloat(e.hours) || 0).toFixed(1)}</td>
            <td><span style="background:var(--s3);border-radius:4px;padding:2px 7px;font-size:11px">${_esc(e.category) || '—'}</span></td>
            <td style="color:var(--text2);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(e.note)}">${e.note ? _esc(e.note) : '<span style="color:var(--text3)">—</span>'}</td>
            <td style="text-align:center;white-space:nowrap">
              <button class="btn btn-ghost btn-sm" style="font-size:10px;margin-right:4px" onclick="_hoursEditEntry(${projId},${e.id})">Edit</button>
              <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--danger);border-color:rgba(240,80,80,.3)" onclick="_hoursDeleteEntry(${projId},${e.id})">Delete</button>
            </td>
          </tr>`;
          })
          .join('');

  // Totals row for entries view
  const entriesTotalsRow =
    entries.length > 0
      ? `<tr style="background:var(--s3);font-weight:700;border-top:1px solid var(--border)">
        <td style="color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Totals</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--em)">${rollup.total.toFixed(1)}</td>
        <td colspan="3"></td>
      </tr>`
      : '';

  const entriesView = `
    <div style="overflow-x:auto">
      <table class="dtbl" style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th style="text-align:left">Date</th>
            <th style="text-align:right">Hours</th>
            <th style="text-align:left">Category</th>
            <th style="text-align:left">Note</th>
            <th style="text-align:center">Actions</th>
          </tr>
        </thead>
        <tbody>${entryTableRows}${entriesTotalsRow}</tbody>
      </table>
    </div>`;

  // ── Weekly view ──
  const weekKeys = Object.keys(rollup.byWeek).sort().reverse(); // newest first
  const weeklyTableRows =
    weekKeys.length === 0
      ? `<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:24px;font-style:italic">No hours logged yet.</td></tr>`
      : weekKeys
          .map((wk) => {
            const w = rollup.byWeek[wk];
            const we = w.weekEnd || _getWeekEnd(wk);
            const catSummary = HOURS_CATEGORIES.filter((c) => w.categories[c] > 0)
              .map(
                (c) =>
                  `<span style="color:var(--text3)">${c}:</span> <span style="font-family:var(--mono);font-weight:600">${w.categories[c].toFixed(1)}</span>`,
              )
              .join(' &nbsp;');
            return `
        <tr>
          <td style="white-space:nowrap;color:var(--text2)">${_fmtWeekRange(wk, we)}</td>
          <td style="text-align:right;font-family:var(--mono);font-weight:600;color:var(--em)">${w.hours.toFixed(1)}</td>
          <td style="font-size:11px;color:var(--text2)">${catSummary || '<span style="color:var(--text3)">—</span>'}</td>
        </tr>`;
          })
          .join('');

  const weeklyTotalsRow =
    weekKeys.length > 0
      ? `<tr style="background:var(--s3);font-weight:700;border-top:1px solid var(--border)">
        <td style="color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Totals</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--em)">${rollup.total.toFixed(1)}</td>
        <td></td>
      </tr>`
      : '';

  const weeklyView = `
    <div style="overflow-x:auto">
      <table class="dtbl" style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th style="text-align:left">Week</th>
            <th style="text-align:right">Hours</th>
            <th style="text-align:left">Categories</th>
          </tr>
        </thead>
        <tbody>${weeklyTableRows}${weeklyTotalsRow}</tbody>
      </table>
    </div>`;

  // ── Monthly view ──
  const monthKeys = Object.keys(rollup.byMonth).sort().reverse(); // newest first
  const monthlyTableRows =
    monthKeys.length === 0
      ? `<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:24px;font-style:italic">No hours logged yet.</td></tr>`
      : monthKeys
          .map((mo) => {
            const m = rollup.byMonth[mo];
            // Format "Jun 2026" from "2026-06"
            const [yr, mn] = mo.split('-');
            const moLabel = new Date(parseInt(yr, 10), parseInt(mn, 10) - 1, 1).toLocaleDateString(undefined, {
              month: 'short',
              year: 'numeric',
            });
            const catSummary = HOURS_CATEGORIES.filter((c) => m.categories[c] > 0)
              .map(
                (c) =>
                  `<span style="color:var(--text3)">${c}:</span> <span style="font-family:var(--mono);font-weight:600">${m.categories[c].toFixed(1)}</span>`,
              )
              .join(' &nbsp;');
            return `
        <tr>
          <td style="white-space:nowrap;color:var(--text2)">${moLabel}</td>
          <td style="text-align:right;font-family:var(--mono);font-weight:600;color:var(--em)">${m.hours.toFixed(1)}</td>
          <td style="font-size:11px;color:var(--text2)">${catSummary || '<span style="color:var(--text3)">—</span>'}</td>
        </tr>`;
          })
          .join('');

  const monthlyTotalsRow =
    monthKeys.length > 0
      ? `<tr style="background:var(--s3);font-weight:700;border-top:1px solid var(--border)">
        <td style="color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Totals</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--em)">${rollup.total.toFixed(1)}</td>
        <td></td>
      </tr>`
      : '';

  const monthlyView = `
    <div style="overflow-x:auto">
      <table class="dtbl" style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th style="text-align:left">Month</th>
            <th style="text-align:right">Hours</th>
            <th style="text-align:left">Categories</th>
          </tr>
        </thead>
        <tbody>${monthlyTableRows}${monthlyTotalsRow}</tbody>
      </table>
    </div>`;

  // Pick the body to show
  const logBody = currentView === 'weekly' ? weeklyView : currentView === 'monthly' ? monthlyView : entriesView;

  return `
    <div style="padding:16px;max-width:900px;margin:0 auto">

      <!-- Rollup stat cards -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        ${statCard('Total Hours', rollup.total.toFixed(1))}
        ${statCard('This Month', rollup.thisMonth.toFixed(1))}
        <div style="flex:2;min-width:200px;background:var(--s2);border-radius:8px;padding:14px 16px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:6px">By Category</div>
          <div style="display:flex;flex-wrap:wrap;gap:2px">${catBadges}</div>
        </div>
      </div>

      <!-- Hours Log card with view toggle -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-hdr" style="flex-wrap:wrap;gap:8px">
          <span class="card-title">Hours Log</span>
          ${viewToggle}
          <span style="font-size:11px;color:var(--text3);margin-left:auto">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
        </div>
        ${logBody}
      </div>

      <!-- Quick-add form: Log by Day -->
      <div class="card" style="margin-bottom:12px">
        <div class="card-hdr">
          <span class="card-title">Log Hours — By Day</span>
        </div>
        <div style="padding:14px 16px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Date <span style="color:var(--danger)">*</span></label>
              <input class="fi" type="date" id="hours-qa-date-${projId}" value="${todayStr}" style="width:140px">
            </div>
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Hours <span style="color:var(--danger)">*</span></label>
              <input class="fi" type="number" id="hours-qa-hours-${projId}" placeholder="e.g. 1.5" step="0.25" min="0.25" max="24" style="width:90px">
            </div>
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Category <span style="color:var(--danger)">*</span></label>
              <select class="fi" id="hours-qa-cat-${projId}" style="width:150px">
                ${catOptions}
              </select>
            </div>
            <div style="flex:1;min-width:160px">
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Note <span style="color:var(--text3);font-weight:400">(optional)</span></label>
              <input class="fi" type="text" id="hours-qa-note-${projId}" placeholder="Brief description..." style="width:100%">
            </div>
            <div>
              <button class="btn btn-em btn-sm" onclick="_hoursSaveEntry(${projId})" style="white-space:nowrap">+ Log Hours</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Weekly entry form: Log by Week -->
      <div class="card">
        <div class="card-hdr">
          <span class="card-title">Log Hours — By Week</span>
          <span style="font-size:11px;color:var(--text3)" title="Log a lump-sum total for a full Mon–Sun week. Hours are attributed to the week's Monday.">Mon–Sun week total</span>
        </div>
        <div style="padding:14px 16px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Any date in the week <span style="color:var(--danger)">*</span></label>
              <input class="fi" type="date" id="hours-wk-date-${projId}" value="${todayStr}" style="width:140px">
            </div>
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Total Hours <span style="color:var(--danger)">*</span></label>
              <input class="fi" type="number" id="hours-wk-hours-${projId}" placeholder="e.g. 18.5" step="0.25" min="0.25" max="168" style="width:90px">
            </div>
            <div>
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Category <span style="color:var(--danger)">*</span></label>
              <select class="fi" id="hours-wk-cat-${projId}" style="width:150px">
                ${catOptions}
              </select>
            </div>
            <div style="flex:1;min-width:160px">
              <label class="fl" style="display:block;font-size:11px;color:var(--text2);margin-bottom:4px">Note <span style="color:var(--text3);font-weight:400">(optional)</span></label>
              <input class="fi" type="text" id="hours-wk-note-${projId}" placeholder="Brief description..." style="width:100%">
            </div>
            <div>
              <button class="btn btn-em btn-sm" onclick="_hoursLogWeek(${projId})" style="white-space:nowrap">+ Log Week</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;
}

/* ── Save new entry (quick-add form) ── */
function _hoursSaveEntry(projId) {
  const dateEl = document.getElementById('hours-qa-date-' + projId);
  const hoursEl = document.getElementById('hours-qa-hours-' + projId);
  const catEl = document.getElementById('hours-qa-cat-' + projId);
  const noteEl = document.getElementById('hours-qa-note-' + projId);

  if (!dateEl || !hoursEl || !catEl) {
    showToast('Form error — please try again');
    return;
  }

  const date = dateEl.value.trim();
  const hours = parseFloat(hoursEl.value);
  const category = catEl.value;
  const note = noteEl ? noteEl.value.trim() : '';

  if (!date) {
    showToast('Date is required');
    return;
  }
  if (!hours || hours < 0.25 || hours > 24) {
    showToast('Hours must be between 0.25 and 24');
    return;
  }
  if (!HOURS_CATEGORIES.includes(category)) {
    showToast('Please select a valid category');
    return;
  }

  const data = _getOrInitHoursData(projId);
  const now = new Date().toISOString();
  data.entries.push({
    id: Date.now(),
    date,
    hours,
    category,
    note,
    createdAt: now,
    updatedAt: now,
  });
  saveHoursData(projId, data);
  initHoursTab(projId);
  showToast('Hours logged');
}

/* ── Save weekly entry (Log by Week form) ── */
function _hoursLogWeek(projId) {
  const dateEl = document.getElementById('hours-wk-date-' + projId);
  const hoursEl = document.getElementById('hours-wk-hours-' + projId);
  const catEl = document.getElementById('hours-wk-cat-' + projId);
  const noteEl = document.getElementById('hours-wk-note-' + projId);

  if (!dateEl || !hoursEl || !catEl) {
    showToast('Form error — please try again');
    return;
  }

  const rawDate = dateEl.value.trim();
  const hours = parseFloat(hoursEl.value);
  const category = catEl.value;
  const note = noteEl ? noteEl.value.trim() : '';

  if (!rawDate) {
    showToast('Date is required');
    return;
  }
  if (!hours || hours < 0.25 || hours > 168) {
    showToast('Hours must be between 0.25 and 168');
    return;
  }
  if (!HOURS_CATEGORIES.includes(category)) {
    showToast('Please select a valid category');
    return;
  }
  if (hours > 80) {
    // Soft warning — user can proceed or cancel
    if (!confirm('That’s more than 80 hours for one week. Continue?')) return;
  }

  // Snap to Monday of the entered date's week
  const weekStart = _getWeekStart(rawDate);
  const weekEnd = _getWeekEnd(weekStart);

  const data = _getOrInitHoursData(projId);
  const now = new Date().toISOString();
  data.entries.push({
    id: Date.now(),
    date: weekStart, // Monday = canonical date for attribution/bucketing
    hours,
    category,
    note,
    createdAt: now,
    updatedAt: now,
    weekEntry: true,
    weekEnd: weekEnd,
  });
  saveHoursData(projId, data);
  initHoursTab(projId);
  showToast('Week logged');
}

/* ── Delete entry ── */
function _hoursDeleteEntry(projId, entryId) {
  if (!confirm('Delete this hours entry? This cannot be undone.')) return;
  const data = _getOrInitHoursData(projId);
  data.entries = (data.entries || []).filter((e) => e.id !== entryId);
  saveHoursData(projId, data);
  initHoursTab(projId);
  showToast('Entry deleted');
}

/* ── Edit entry — open modal ── */
function _hoursEditEntry(projId, entryId) {
  const data = loadHoursData(projId);
  const entry = ((data && data.entries) || []).find((e) => e.id === entryId);
  if (!entry) {
    showToast('Entry not found');
    return;
  }
  _hoursOpenEditModal(projId, entry);
}

function _hoursOpenEditModal(projId, entry) {
  const catOptions = HOURS_CATEGORIES.map(
    (c) => `<option value="${c}"${c === entry.category ? ' selected' : ''}>${c}</option>`,
  ).join('');

  const modalHtml = `
    <div id="hours-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)_hoursCloseModal()">
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:10px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div style="font-size:15px;font-weight:700;color:var(--text)">Edit Hours Entry</div>
          <button style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:18px;padding:0 4px" onclick="_hoursCloseModal()">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Date <span style="color:var(--danger)">*</span></label>
            <input class="fi" type="date" id="hm-date" value="${entry.date || ''}" style="width:100%">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Hours <span style="color:var(--danger)">*</span></label>
            <input class="fi" type="number" id="hm-hours" value="${entry.hours || ''}" step="0.25" min="0.25" max="24" style="width:100%">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Category <span style="color:var(--danger)">*</span></label>
            <select class="fi" id="hm-category" style="width:100%">${catOptions}</select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px">Note <span style="color:var(--text3);font-weight:400">(optional)</span></label>
            <input class="fi" type="text" id="hm-note" value="${(entry.note || '').replace(/"/g, '&quot;')}" placeholder="Brief description..." style="width:100%">
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
          <button class="btn btn-ghost" onclick="_hoursCloseModal()">Cancel</button>
          <button class="btn btn-em" onclick="_hoursUpdateEntry(${projId},${entry.id})">Save Changes</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function _hoursCloseModal() {
  const overlay = document.getElementById('hours-modal-overlay');
  if (overlay) overlay.remove();
}

function _hoursUpdateEntry(projId, entryId) {
  const dateEl = document.getElementById('hm-date');
  const hoursEl = document.getElementById('hm-hours');
  const catEl = document.getElementById('hm-category');
  const noteEl = document.getElementById('hm-note');

  const date = dateEl ? dateEl.value.trim() : '';
  const hours = parseFloat(hoursEl ? hoursEl.value : '');
  const category = catEl ? catEl.value : '';
  const note = noteEl ? noteEl.value.trim() : '';

  if (!date) {
    showToast('Date is required');
    return;
  }
  if (!hours || hours < 0.25 || hours > 24) {
    showToast('Hours must be between 0.25 and 24');
    return;
  }
  if (!HOURS_CATEGORIES.includes(category)) {
    showToast('Please select a valid category');
    return;
  }

  const data = _getOrInitHoursData(projId);
  const idx = (data.entries || []).findIndex((e) => e.id === entryId);
  if (idx < 0) {
    showToast('Entry not found');
    return;
  }
  data.entries[idx] = Object.assign(data.entries[idx], {
    date,
    hours,
    category,
    note,
    updatedAt: new Date().toISOString(),
  });
  saveHoursData(projId, data);
  _hoursCloseModal();
  initHoursTab(projId);
  showToast('Entry updated');
}
