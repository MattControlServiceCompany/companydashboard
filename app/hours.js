/* ══════════════════════════════════════════════════════
   HOURS-PER-PROJECT TRACKING MODULE
   Storage key: en_hours_<projId>
   Structure:
   {
     projId: <number>,
     entries: [
       {
         id: <number>,          // Date.now()
         date: 'YYYY-MM-DD',
         hours: <number>,
         category: <string>,    // one of HOURS_CATEGORIES
         note: <string>,        // optional
         createdAt: <ISO>,
         updatedAt: <ISO>
       }
     ]
   }
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
  (entries || []).forEach((e) => {
    const h = parseFloat(e.hours) || 0;
    total += h;
    if (e.date && e.date.substring(0, 7) === thisMonthYM) thisMonth += h;
    if (byCategory[e.category] !== undefined) byCategory[e.category] += h;
    else byCategory['Other'] = (byCategory['Other'] || 0) + h;
  });
  return { total, thisMonth, byCategory };
}

/* ── Tab init (entry point from sPTab) ── */
function initHoursTab(projId) {
  const el = document.getElementById('ptab-hours-body-' + projId);
  if (!el) return;
  const data = _getOrInitHoursData(projId);
  el.innerHTML = _renderHoursTab(projId, data);
}

/* ── Tab renderer ── */
function _renderHoursTab(projId, data) {
  const entries = (data.entries || []).slice().sort((a, b) => {
    // Newest first: compare date strings, then createdAt
    if (b.date !== a.date) return b.date > a.date ? 1 : -1;
    return (b.createdAt || '') > (a.createdAt || '') ? 1 : -1;
  });
  const rollup = _hoursRollup(entries);

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

  // Entry table rows
  const tableRows =
    entries.length === 0
      ? `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px;font-style:italic">No hours logged yet. Use the form below to log your first entry.</td></tr>`
      : entries
          .map(
            (e) => `
          <tr>
            <td style="white-space:nowrap;color:var(--text2)">${e.date || '—'}</td>
            <td style="text-align:right;font-family:var(--mono);font-weight:600;color:var(--em)">${(parseFloat(e.hours) || 0).toFixed(1)}</td>
            <td><span style="background:var(--s3);border-radius:4px;padding:2px 7px;font-size:11px">${_esc(e.category) || '—'}</span></td>
            <td style="color:var(--text2);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(e.note)}">${e.note ? _esc(e.note) : '<span style="color:var(--text3)">—</span>'}</td>
            <td style="text-align:center;white-space:nowrap">
              <button class="btn btn-ghost btn-sm" style="font-size:10px;margin-right:4px" onclick="_hoursEditEntry(${projId},${e.id})">Edit</button>
              <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--danger);border-color:rgba(240,80,80,.3)" onclick="_hoursDeleteEntry(${projId},${e.id})">Delete</button>
            </td>
          </tr>`,
          )
          .join('');

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

      <!-- Entry table -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-hdr">
          <span class="card-title">Hours Log</span>
          <span style="font-size:11px;color:var(--text3)">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
        </div>
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
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Quick-add form -->
      <div class="card">
        <div class="card-hdr">
          <span class="card-title">Log Hours</span>
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
