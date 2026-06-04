/* ── AI API (disabled — no backend) ── */
async function claude(prompt, sys) {
  return 'AI features are not available — this app has no backend API connection.';
}
async function claudePDF(prompt, b64, sys) {
  return 'AI features are not available — this app has no backend API connection.';
}

/* ── STORAGE — delegates to window.Store so dataUpdated events fire ── */
// Returns a Promise that resolves when the IDB write commits (or immediately for
// the localStorage fallback). Callers that need write durability can await this.
//
// Priority order:
//   1. window.DB (IndexedDB — no size limit, available on all pages via db.js)
//   2. window.Store (site-ui.js Store wrapper — only on pages that load site-ui.js)
//   3. localStorage fallback — throws on QuotaExceededError so callers see failures
//
// sget() already follows this same priority order (DB first). sset() must match.
function sset(k, v) {
  if (window.DB && window.DB.isReady()) {
    return window.DB.set(k, v); // IDB — unlimited storage, returns a Promise
  }
  if (window.Store) {
    return window.Store.set(k, v);
  }
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return Promise.resolve();
  } catch (e) {
    console.warn('sset failed:', e);
    return Promise.reject(e); // re-throw so awaiting callers see the failure
  }
}
function sget(k, fb) {
  // READ-PATH FIX: when IndexedDB cache is warm, read from it first.
  // DB.get() reads _cache (populated by warmCache from IDB's 45 records).
  // Fall back to localStorage so lsPreserveKeys (ch_theme, ch_activeView, etc.)
  // that are intentionally kept in localStorage still work when not in _cache.
  if (window.DB && window.DB.isReady()) {
    const dbVal = window.DB.get(k);
    if (dbVal !== null && dbVal !== undefined) return dbVal;
    // Key not in IDB cache — try localStorage (covers lsPreserveKeys and any
    // keys written before DB was ready).
    try {
      const r = localStorage.getItem(k);
      if (r !== null) return JSON.parse(r);
    } catch (e) {
      /* fall through */
    }
    return fb;
  }
  // DB not ready yet — legacy path (same as before)
  if (window.Store) {
    try {
      const r = localStorage.getItem(k);
      const d = r !== null ? JSON.parse(r) : null;
      return d !== null ? d : fb !== undefined ? fb : [];
    } catch (e) {
      return fb !== undefined ? fb : [];
    }
  }
  try {
    const r = localStorage.getItem(k);
    return r !== null ? JSON.parse(r) : fb;
  } catch (e) {
    return fb;
  }
}

/* ── IndexedDB helpers for large PDF file storage ── */
const _pdfDB = { db: null, NAME: 'en_pdf_store', STORE: 'files', VER: 1 };
function _openPdfDB() {
  if (_pdfDB.db) return Promise.resolve(_pdfDB.db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_pdfDB.NAME, _pdfDB.VER);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(_pdfDB.STORE);
    };
    req.onsuccess = () => {
      _pdfDB.db = req.result;
      resolve(_pdfDB.db);
    };
    req.onerror = () => reject(req.error);
  });
}
async function pdfStore(id, base64) {
  try {
    const db = await _openPdfDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(_pdfDB.STORE, 'readwrite');
      tx.objectStore(_pdfDB.STORE).put(base64, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('pdfStore failed:', e);
    return false;
  }
}
async function pdfLoad(id) {
  try {
    const db = await _openPdfDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(_pdfDB.STORE, 'readonly');
      const req = tx.objectStore(_pdfDB.STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('pdfLoad failed:', e);
    return null;
  }
}
async function pdfDelete(id) {
  try {
    const db = await _openPdfDB();
    return new Promise((resolve) => {
      const tx = db.transaction(_pdfDB.STORE, 'readwrite');
      tx.objectStore(_pdfDB.STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) {
    return false;
  }
}

window.addEventListener('pagehide', function () {
  _saveExtractionState();
});

/* ── STATE ── */
let projects = [],
  tasks = [],
  equipment = [];
let hCalY, hCalM;
let projSectionOpen = true;
const NOW = new Date();
hCalY = NOW.getFullYear();
hCalM = NOW.getMonth();
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ── INIT ── */
function init() {
  projects = sget('en_projects', []);
  tasks = sget('en_tasks', []);
  equipment = sget('en_equipment', []);
  const _dcSaved = sget('en_dc_events', null);
  if (_dcSaved && Array.isArray(_dcSaved.events) && _dcSaved.events.length) {
    dcEvents = _dcSaved.events;
    dcViewYear = _dcSaved.viewYear || new Date().getFullYear();
    dcViewMonth = _dcSaved.viewMonth || new Date().getMonth();
  }
  // Projects load from localStorage only — no hardcoded seed data
  if (false) {
    /* seed data removed — real PII was here */
  }
  // Tasks and equipment load from localStorage only — no hardcoded seed data
  // Migrate: add meetings + approvedChanges arrays to existing projects
  projects.forEach((p) => {
    if (!p.meetings) p.meetings = [];
    if (!p.recurringMeetings) p.recurringMeetings = [];
    if (!p.approvedChanges) p.approvedChanges = [];
    // Migrate activeCommodities → shownCommodities + calcCommodities
    if (Array.isArray(p.activeCommodities) && !p.calcCommodities) {
      p.shownCommodities = [...ALL_COMMODITIES];
      p.calcCommodities = [...p.activeCommodities];
      delete p.activeCommodities;
      sset('en_projects', projects);
    }
  });
  // Migrate: remove deprecated tabs from saved tab order
  try {
    const _savedTabOrder = JSON.parse(localStorage.getItem('ch_projTabOrder'));
    if (Array.isArray(_savedTabOrder)) {
      const _cleanedOrder = _savedTabOrder.filter((id) => id !== 'contracts' && id !== 'meetings');
      if (_cleanedOrder.length !== _savedTabOrder.length) {
        localStorage.setItem('ch_projTabOrder', JSON.stringify(_cleanedOrder));
      }
    }
  } catch (e) {}
  // Migrate v397: reorder saved tab order to match the new default workflow sequence
  if (!localStorage.getItem('ch_projTabOrder_v397')) {
    try {
      const _v397Saved = JSON.parse(localStorage.getItem('ch_projTabOrder'));
      if (Array.isArray(_v397Saved) && _v397Saved.length) {
        const _v397DefaultOrder = PROJ_TABS_DEFAULT.map((t) => t.id);
        const _v397Set = new Set(_v397Saved);
        // Reorder saved IDs to match new default order, preserving only IDs present in saved
        const _v397Reordered = _v397DefaultOrder.filter((id) => _v397Set.has(id));
        // Append any saved IDs not in default (unknown/future tabs) at the end
        const _v397DefaultSet = new Set(_v397DefaultOrder);
        const _v397Extra = _v397Saved.filter((id) => !_v397DefaultSet.has(id));
        localStorage.setItem('ch_projTabOrder', JSON.stringify(_v397Reordered.concat(_v397Extra)));
      }
    } catch (e) {}
    localStorage.setItem('ch_projTabOrder_v397', '1');
  }
  checkRecurringMeetings();
  buildWeekStrip();
  buildHomeCal();
  refreshProjDropdowns();
  renderProjTable();
  renderSidebarFolders();
  renderEquip();
  renderUpcomingTasks();
  const homeDateEl = document.getElementById('home-date');
  if (homeDateEl)
    homeDateEl.textContent = NOW.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  initUtilityTool();
  updateHomeStats(); // Must run after initUtilityTool() so utilityData is populated
  // Restore last active view from session
  const lastView = localStorage.getItem('ch_activeView') || sessionStorage.getItem('ch_activeView');
  // Read project session NOW before sv('projects') → showList() overwrites it
  const savedProjSession = sessionStorage.getItem('ch_proj');
  if (lastView && document.getElementById('view-' + lastView)) sv(lastView);
  // Restore projects drill-down if on projects page
  if (lastView === 'projects' && savedProjSession) {
    try {
      const s = JSON.parse(savedProjSession);
      if (s.view === 'detail' && s.projId != null) {
        const p = projects.find((p) => p.id == s.projId);
        if (p) {
          const _tabToRestore = s.tab || 'dashboard';
          openDetail(p.id);
          if (_tabToRestore !== 'dashboard') {
            const btn = document.querySelector('#pdTabBar button[data-tab="' + _tabToRestore + '"]');
            if (btn) sPTab(_tabToRestore, btn);
          }
        }
      }
    } catch (e) {}
  }
}

function updateHomeStats() {
  document.getElementById('h-proj').textContent = projects.filter((p) => p.status === 'active').length;
  document.getElementById('h-equip').textContent = equipment.length;
  const ws = new Date(NOW);
  ws.setDate(NOW.getDate() - NOW.getDay());
  const we = new Date(ws);
  we.setDate(ws.getDate() + 6);
  document.getElementById('h-tasks').textContent = tasks.filter((t) => {
    if (t.done) return false;
    const d = new Date(t.due + 'T12:00:00');
    return d >= ws && d <= we;
  }).length;
  // Count projects with at least one meter that has a baseline period set
  // Bug fix: old code checked m.baselineStart/m.baselineEnd which don't exist;
  // the data model stores m.baseline.months array (multi-baseline: m.baselines)
  const baselineCount = projects.filter((p) => {
    const projBldgs = (utilityData[p.id] || {}).buildings || [];
    return projBldgs.some((b) =>
      (b.meters || []).some((m) => m.baseline?.months?.length > 0 || (m.baselines && m.baselines.length > 0)),
    );
  }).length;
  document.getElementById('h-base').textContent = baselineCount;
  // Sum estimated savings/yr by computing from meter-level savings (byCalMo).
  // Bug fix: old code read p.savings from the project object which is always 0.
  // Actual savings are computed by getMeterSavings() and never written back to p.savings.
  let totalSav = 0;
  projects
    .filter((p) => p.status === 'active' || p.status === 'in_progress')
    .forEach((p) => {
      const projBldgs = (utilityData[p.id] || {}).buildings || [];
      projBldgs.forEach((b) => {
        (b.meters || []).forEach((m) => {
          if (m.baselineInclude === false) return;
          if (!(m.baseline?.months?.length >= 3) && !(m.baselines && m.baselines.length > 0)) return;
          const mbills = (m.bills || []).slice().sort((a, c) => {
            const da = a.start ? new Date(a.start + 'T12:00:00') : 0;
            const dc = c.start ? new Date(c.start + 'T12:00:00') : 0;
            return da - dc;
          });
          const mincl = m.inclusive !== false;
          try {
            const savResult = getMeterSavings(m, mbills, mincl, p.id, b.id);
            Object.values(savResult.byCalMo).forEach((v) => {
              totalSav += v || 0;
            });
          } catch (e) {
            /* skip meters that fail savings computation */
          }
        });
      });
    });
  document.getElementById('h-sav').textContent = '$' + Math.round(totalSav).toLocaleString();
}

/* ── VIEW SWITCH ── */
function sv(id, btn) {
  // Auto-save extraction state when navigating away from PDF view so the
  // user never loses in-progress work (bug fcb73e12). The old confirm()
  // dialog was removed — state is silently persisted and restored on return.
  var _curView = sessionStorage.getItem('ch_activeView');
  if (id !== 'pdf' && _curView === 'pdf') {
    var _singleUnsaved = window._pdfMultiBills && window._pdfMultiBills.length > 0 && !window._pdfBillsSaved;
    var _queueRunning = window._pdfQueue && window._pdfQueue.status === 'running';
    if (_singleUnsaved) {
      // Save state silently — user will get it back when they return to PDF
      _saveExtractionState();
      showToast('Extraction saved — return to PDF / OCR to resume');
    } else if (_queueRunning) {
      // Batch extraction still running: just navigate, it continues in background
      showToast('Batch extraction continuing in background');
    }
  }
  // When returning to the PDF view, restore in-memory OR sessionStorage state
  if (id === 'pdf' && _curView !== 'pdf') {
    setTimeout(function () {
      var inMemory = window._pdfMultiBills && window._pdfMultiBills.length > 0;
      var inStorage = !!sessionStorage.getItem('ch_extraction_state');
      var didRestore = false;
      if (inMemory) {
        // Bills still in memory (user just switched views) — re-render the UI
        didRestore = true;
      } else if (inStorage) {
        didRestore = _restoreExtractionState();
      }
      if (didRestore && window._pdfMultiBills && window._pdfMultiBills.length) {
        var box = document.getElementById('pdfAIBox');
        if (box) {
          var ridx = window._pdfMultiIdx || 0;
          renderMultiBillUI(window._pdfMultiBills, box);
          renderPDFFields(window._pdfMultiBills[ridx], (window._pdfBillWarnings || [])[ridx]?.warnings || []);
          document.getElementById('pdfSaveRow').style.display = 'block';
          document.getElementById('pdfClearBtn').style.display = 'block';
          document.getElementById('dropZone').classList.add('collapsed');
          document.getElementById('pdfTypeSection').style.display = 'none';
          if (!inMemory) showToast('Extraction results restored');
        }
      }
    }, 100);
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.sidebar .s-item').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.sidebar .spfi').forEach((t) => t.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  // btn may be a wrapper div (projects header) — activate the inner s-item if so
  const target = btn?.classList.contains('s-item') ? btn : btn?.querySelector('.s-item') || btn;
  (target || document.querySelector(`.sidebar .s-item[onclick*="'${id}'"]`))?.classList.add('active');
  sessionStorage.setItem('ch_activeView', id);
  localStorage.setItem('ch_activeView', id);
  if (id === 'pdf') {
    setTimeout(updateBillCountBadge, 50);
  }
  if (id === 'utility') {
    renderUDProjList();
    requestAnimationFrame(() => {
      _setUDLayoutHeight('utility');
      renderUDDetail();
    });
  }
  if (id === 'savings') {
    requestAnimationFrame(() => {
      _setUDLayoutHeight('savings');
      renderSvProjNav();
      renderSvDetail();
    });
  }
  if (id === 'projects') {
    const _savedProj = sessionStorage.getItem('ch_proj');
    let _restored = false;
    if (_savedProj) {
      try {
        const _s = JSON.parse(_savedProj);
        if (_s.view === 'detail' && _s.projId != null) {
          const _p = projects.find((p) => p.id == _s.projId);
          if (_p) {
            document.getElementById('projListView').style.display = 'none';
            document.getElementById('projDetailView').style.display = 'flex';
            window._activeProjId = _p.id;
            window._activeProjTab = _s.tab || 'dashboard';
            renderDetail(_p);
            document.querySelectorAll('.spfi').forEach((c) => c.classList.remove('active'));
            document.querySelectorAll(`.spfi[data-pid="${_p.id}"]`).forEach((c) => c.classList.add('active'));
            if (_s.tab) {
              const _btn = document.querySelector(`.pdt[data-tab="${_s.tab}"]`);
              if (_btn) sPTab(_s.tab, _btn);
            }
            _restored = true;
          }
        }
      } catch (e) {}
    }
    if (!_restored) {
      showList();
      renderProjTable();
    } else {
      renderProjTable();
    }
  }
  if (id === 'district' && dcEvents.length) {
    dcRenderAll();
  }
  if (id === 'calculators' && typeof initEcmCalculatorsView === 'function') {
    initEcmCalculatorsView();
  }
  if (id === 'ems' && typeof emsRenderAll === 'function') {
    emsRenderAll();
  }
  if (id === 'eq-matrix' && typeof initEquipMatrix === 'function') {
    initEquipMatrix(emGetActiveProjId());
  }
}

/* ── AUTH ── */
let currentUser = null;
function signOut() {
  sessionStorage.removeItem('ch_user');
  localStorage.removeItem('ch_user');
  window.location.href = 'index.html';
}
function enterApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('topName').textContent = currentUser.name;
  document.getElementById('topAv').textContent = currentUser.initials;
}
(function () {
  try {
    const s = sessionStorage.getItem('ch_user') || localStorage.getItem('ch_user');
    if (s) {
      currentUser = JSON.parse(s);
      enterApp();
    }
  } catch (e) {}
})();

/* ── HOME CALENDAR ── */
function buildHomeCal() {
  const lbl = document.getElementById('hCalLbl'),
    grid = document.getElementById('hCalDays');
  if (!lbl || !grid) return;
  lbl.textContent = MONTHS[hCalM] + ' ' + hCalY;
  const first = new Date(hCalY, hCalM, 1).getDay(),
    dim = new Date(hCalY, hCalM + 1, 0).getDate(),
    prev = new Date(hCalY, hCalM, 0).getDate();
  const isCur = NOW.getFullYear() === hCalY && NOW.getMonth() === hCalM;
  let h = '';
  for (let i = first - 1; i >= 0; i--) h += `<div class="cday cother"><div class="cday-n">${prev - i}</div></div>`;
  for (let d = 1; d <= dim; d++) {
    const ds = `${hCalY}-${String(hCalM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dt = tasks.filter((t) => t.due === ds && !t.done);
    const dots = dt
      .slice(0, 4)
      .map((t) => `<div class="cdot" style="background:${t.pri === 'high' ? 'var(--red)' : 'var(--teal)'}"></div>`)
      .join('');
    const isT = isCur && d === NOW.getDate();
    h += `<div class="cday${isT ? ' ctoday' : ''}" onclick="calClick('${ds}')"><div class="cday-n">${d}</div>${dots ? `<div class="cday-dots">${dots}</div>` : ''}</div>`;
  }
  const tot = Math.ceil((first + dim) / 7) * 7;
  for (let n = 1, i = first + dim; i < tot; i++, n++)
    h += `<div class="cday cother"><div class="cday-n">${n}</div></div>`;
  grid.innerHTML = h;
}
function changeHCal(d) {
  hCalM += d;
  if (hCalM < 0) {
    hCalM = 11;
    hCalY--;
  }
  if (hCalM > 11) {
    hCalM = 0;
    hCalY++;
  }
  buildHomeCal();
}
function calClick(ds) {
  const dt = tasks.filter((t) => t.due === ds && !t.done);
  if (dt.length) {
    renderUpcomingTasks(ds);
    const panel = document.getElementById('upcomingTasksList');
    if (panel) panel.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // No toast — user is directed to the task list silently
}
function buildWeekStrip() {
  const el = document.getElementById('weekStrip'),
    rl = document.getElementById('week-range-lbl');
  if (!el) return;
  const sow = new Date(NOW);
  sow.setDate(NOW.getDate() - NOW.getDay());
  const eow = new Date(sow);
  eow.setDate(sow.getDate() + 6);
  if (rl)
    rl.textContent =
      sow.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' – ' +
      eow.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  let h = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(sow);
    d.setDate(sow.getDate() + i);
    const isT = d.toDateString() === NOW.toDateString();
    const ds = d.toISOString().split('T')[0];
    const dt = tasks.filter((t) => t.due === ds && !t.done);
    const dots = dt
      .slice(0, 4)
      .map((t) => `<div class="wdot" style="background:${t.pri === 'high' ? 'var(--red)' : 'var(--teal)'}"></div>`)
      .join('');
    h += `<div class="wday${isT ? ' is-today' : ''}" onclick="calClick('${ds}')"><div class="wday-name">${DAYS[d.getDay()]}</div><div class="wday-num">${d.getDate()}</div><div class="wday-count">${dt.length ? dt.length + ' task' + (dt.length > 1 ? 's' : '') : '<span style="color:var(--text3);font-size:9px">no tasks</span>'}</div><div class="wday-dots">${dots}</div></div>`;
  }
  el.innerHTML = h;
}

/* ── TASKS ── */
function renderUpcomingTasks(highlightDate) {
  const el = document.getElementById('upcomingTasksList');
  if (!el) return;
  const sow = new Date(NOW);
  sow.setDate(NOW.getDate() - NOW.getDay());
  sow.setHours(0, 0, 0, 0);
  const eow = new Date(sow);
  eow.setDate(sow.getDate() + 6);
  eow.setHours(23, 59, 59, 999);
  const pending = [...tasks].filter((t) => !t.done).sort((a, b) => new Date(a.due) - new Date(b.due));
  const recentDone = [...tasks]
    .filter((t) => {
      if (!t.done || !t.doneAt) return false;
      const da = new Date(t.doneAt);
      return da >= sow && da <= eow;
    })
    .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));

  if (!pending.length && !recentDone.length) {
    el.innerHTML =
      '<div style="font-size:13px;color:var(--text2);padding:8px 0;text-align:center">No upcoming tasks</div>';
    return;
  }

  function taskRow(t, isDone) {
    const proj = projects.find((p) => p.id === t.projId);
    const due = new Date(t.due + 'T12:00:00');
    const diff = Math.ceil((due - NOW) / (1000 * 60 * 60 * 24));
    const dc = isDone ? 'var(--text3)' : diff <= 0 ? 'var(--danger)' : diff <= 2 ? 'var(--warn)' : 'var(--text2)';
    const dl = isDone
      ? 'Done'
      : diff <= 0
        ? 'Today'
        : diff === 1
          ? 'Tomorrow'
          : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isHl = highlightDate && t.due === highlightDate;
    return `<div class="task-item${isHl ? ' task-hl' : ''}${isDone ? ' task-done-row' : ''}" id="ti-${t.id}" style="flex-direction:column;padding:0;overflow:hidden;">
            <div style="display:flex;align-items:flex-start;gap:9px;padding:9px 11px;cursor:pointer" onclick="toggleTaskExpand(${t.id})">
              <div class="tcb${isDone ? ' done' : ''}" onclick="event.stopPropagation();toggleTask(${t.id})" style="margin-top:2px;flex-shrink:0">${isDone ? '<span style="color:#05080f;font-size:9px">✓</span>' : ''}</div>
              <div class="t-body">
                <div class="t-text${isDone ? ' struck' : ''}">${t.text}${t.pri === 'high' && !isDone ? ' <span style="color:var(--danger);font-size:10px">● HIGH</span>' : ''}</div>
                ${proj ? `<div class="t-proj">${proj.name}</div>` : `<div class="t-proj" style="color:var(--text3)">General</div>`}
              </div>
              <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
                <div class="t-due" style="color:${dc}">${dl}</div>
                <span id="tchev-${t.id}" style="font-size:9px;color:var(--text3)">▶</span>
              </div>
            </div>
            <div id="tdet-${t.id}" style="display:none;background:var(--s2);border-top:1px solid var(--border);padding:9px 11px 11px 38px;animation:fadeUp .14s ease">
              <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
                <span style="color:var(--text3);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Due: </span><span>${due.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
                ${t.pri ? `&nbsp;·&nbsp;<span style="color:${t.pri === 'high' ? 'var(--danger)' : t.pri === 'low' ? 'var(--text3)' : 'var(--text2)'}">Priority: ${t.pri}</span>` : ''}
              </div>
              <div style="display:flex;gap:7px;flex-wrap:wrap">
                ${proj ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="openDetail(${proj.id})">📁 Go to Project</button>` : ''}
                <button class="btn btn-sm" style="background:var(--red-dim);color:var(--red);border:1px solid rgba(244,63,94,.2);font-size:11px" onclick="removeTask(${t.id})">🗑 Delete</button>
              </div>
            </div>
          </div>`;
  }

  let html = '';
  if (pending.length) html += pending.map((t) => taskRow(t, false)).join('');
  if (recentDone.length) {
    html += `<div class="tasks-done-hdr">✓ Completed this week</div>`;
    html += recentDone.map((t) => taskRow(t, true)).join('');
  }
  el.innerHTML = html;

  // Restore expanded states
  (window._expandedTasks || []).forEach((id) => {
    const d = document.getElementById('tdet-' + id);
    const c = document.getElementById('tchev-' + id);
    if (d) {
      d.style.display = 'block';
      if (c) c.textContent = '▼';
    }
  });

  if (highlightDate) {
    const hl = el.querySelector('.task-hl');
    if (hl) hl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function toggleTaskExpand(id) {
  if (!window._expandedTasks) window._expandedTasks = [];
  const d = document.getElementById('tdet-' + id);
  const c = document.getElementById('tchev-' + id);
  if (!d) return;
  const open = d.style.display === 'block';
  if (open) {
    d.style.display = 'none';
    if (c) c.textContent = '▶';
    window._expandedTasks = window._expandedTasks.filter((x) => x !== id);
  } else {
    d.style.display = 'block';
    if (c) c.textContent = '▼';
    if (!window._expandedTasks.includes(id)) window._expandedTasks.push(id);
  }
}

function toggleTask(id) {
  const t = tasks.find((t) => t.id === id);
  if (t) {
    t.done = !t.done;
    t.doneAt = t.done ? new Date().toISOString() : null;
    sset('en_tasks', tasks);
    renderUpcomingTasks();
    buildHomeCal();
    buildWeekStrip();
  }
}
function removeTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  sset('en_tasks', tasks);
  renderUpcomingTasks();
  buildHomeCal();
  buildWeekStrip();
}
function openTaskModal() {
  refreshProjDropdowns();
  document.getElementById('mt-edit-id').value = '';
  document.getElementById('mt-text').value = '';
  document.getElementById('mt-due').value = '';
  document.getElementById('mt-pri').value = 'normal';
  document.getElementById('taskModalTitle').textContent = '+ Add Task';
  document.getElementById('taskSaveBtn').textContent = 'Save Task';
  document.getElementById('taskModal').classList.add('open');
}
function openTaskEdit(taskId, projId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  refreshProjDropdowns();
  document.getElementById('mt-edit-id').value = taskId;
  document.getElementById('mt-text').value = t.text || '';
  document.getElementById('mt-due').value = t.due || '';
  document.getElementById('mt-proj').value = t.projId || '';
  document.getElementById('mt-pri').value = t.pri || 'normal';
  document.getElementById('taskModalTitle').textContent = '✏️ Edit Task';
  document.getElementById('taskSaveBtn').textContent = 'Save Changes';
  document.getElementById('taskModal').classList.add('open');
}
function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('open');
  document.getElementById('mt-edit-id').value = '';
  document.getElementById('taskModalTitle').textContent = '+ Add Task';
  document.getElementById('taskSaveBtn').textContent = 'Save Task';
}
function saveTask() {
  const text = document.getElementById('mt-text').value.trim();
  if (!text) {
    showToast('Enter task description');
    return;
  }
  const editId = parseInt(document.getElementById('mt-edit-id').value) || null;
  const due = document.getElementById('mt-due').value || NOW.toISOString().split('T')[0];
  const projId = parseInt(document.getElementById('mt-proj').value) || null;
  const pri = document.getElementById('mt-pri').value;
  if (editId) {
    const t = tasks.find((t) => t.id === editId);
    if (t) {
      t.text = text;
      t.due = due;
      t.projId = projId;
      t.pri = pri;
    }
    showToast('Task updated ✓');
  } else {
    tasks.push({ id: Date.now(), text, due, projId, pri, done: false });
    showToast('Task added ✓');
  }
  sset('en_tasks', tasks);
  closeTaskModal();
  renderUpcomingTasks();
  buildHomeCal();
  buildWeekStrip();
  updateHomeStats();
  // Refresh project detail if open
  const activeProj = projects.find((p) => p.id === (projId || parseInt(document.getElementById('mt-proj')?.value)));
  if (activeProj && document.getElementById('projDetailView')?.style.display !== 'none') renderDetail(activeProj);
}

/* ── PROJECTS: TABLE ── */
function showList() {
  document.getElementById('projListView').style.display = 'block';
  document.getElementById('projDetailView').style.display = 'none';
  document.querySelectorAll('.spfi').forEach((c) => c.classList.remove('active'));
  window._activeProjId = null;
  const _dl = sget('ch_defaultProjTab', 'dashboard');
  if (_dl !== 'last') window._activeProjTab = _dl;
  saveProjSession();
}
function backToList() {
  showList();
}

function renderProjTable() {
  const tbody = document.getElementById('projTableBody');
  if (!tbody) return;
  const q = (document.getElementById('projSearchQ')?.value || '').toLowerCase();
  const filtered = projects.filter(
    (p) => !q || (p.name + p.client + p.type + p.pm + p.status + (p.tags || '')).toLowerCase().includes(q),
  );
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text2);padding:28px">No projects yet — click <strong style="color:var(--em)">+ New Project</strong> to add one.</td></tr>`;
    return;
  }
  const SC = {
    active: 'ps-active',
    planning: 'ps-planning',
    complete: 'ps-complete',
    onhold: 'ps-onhold',
  };
  const SL = {
    active: 'Active',
    planning: 'Planning',
    complete: 'Complete',
    onhold: 'On Hold',
  };
  tbody.innerHTML = filtered
    .map((p) => {
      const pt = tasks.filter((t) => t.projId === p.id && !t.done).length;
      const cv = p.contract ? '$' + Number(p.contract).toLocaleString() : '—';
      const sd = p.start
        ? _parseISO(p.start).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: '2-digit',
          })
        : '—';
      return `<tr class="clickable" onclick="openDetail(${p.id})">
            <td><div style="font-weight:600;margin-bottom:2px">${p.name}</div>${p.phase ? `<div style="font-size:10px;color:var(--text2)">${p.phase}</div>` : ''}</td>
            <td style="font-size:12px">${p.client || '—'}</td>
            <td style="font-size:11px;color:var(--text2)">${p.type || '—'}</td>
            <td><span class="p-status ${SC[p.status] || 'ps-planning'}">● ${SL[p.status] || p.status}</span></td>
            <td style="font-size:12px">${p.pm || '—'}</td>
            <td style="font-family:var(--mono);font-size:12px;color:var(--em)">${cv}</td>
            <td style="font-size:12px;color:var(--text2)">${sd}</td>
            <td><div class="tpbar"><div class="tpbar-track"><div class="tpbar-fill" style="width:${p.progress || 0}%"></div></div><span class="tpbar-pct">${p.progress || 0}%</span></div></td>
            <td style="text-align:center;font-size:12px;color:${pt > 0 ? 'var(--warn)' : 'var(--text2)'}">${pt}</td>
            <td><div style="display:flex;gap:5px">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editProj(${p.id})">Edit</button>
              <button class="btn-del" onclick="event.stopPropagation();deleteProj(${p.id})">✕</button>
            </div></td>
          </tr>`;
    })
    .join('');
}

/* ── PROJECTS: DETAIL ── */
function openDetail(id) {
  const p = projects.find((p) => p.id === id);
  if (!p) return;
  if (!document.getElementById('view-projects').classList.contains('active')) {
    sv('projects', document.getElementById('sb-proj-btn'));
  }
  document.getElementById('projListView').style.display = 'none';
  document.getElementById('projDetailView').style.display = 'flex';
  renderDetail(p);
  document.querySelectorAll('.spfi').forEach((c) => c.classList.remove('active'));
  document.querySelectorAll(`.spfi[data-pid="${id}"]`).forEach((c) => c.classList.add('active'));
  document.querySelector('.ptab.active')?.scrollTo({ top: 0, behavior: 'smooth' });
  window._activeProjId = id;
  const _dfltTab = sget('ch_defaultProjTab', 'dashboard');
  if (_dfltTab === 'last') {
    window._activeProjTab = window._activeProjTab || 'dashboard'; // fall back if no prior tab
  } else {
    window._activeProjTab = _dfltTab;
  }
  saveProjSession();
}

function renderDetail(p) {
  const SC = {
    active: 'ps-active',
    planning: 'ps-planning',
    complete: 'ps-complete',
    onhold: 'ps-onhold',
  };
  const SL = {
    active: 'Active',
    planning: 'Planning',
    complete: 'Complete',
    onhold: 'On Hold',
  };
  const pt = tasks.filter((t) => t.projId === p.id);
  const openTasks = pt.filter((t) => !t.done).length;
  const tasksHTML = pt.length
    ? pt
        .map(
          (t) => `<div class="task-item">
            <div class="tcb${t.done ? ' done' : ''}" onclick="toggleTask(${t.id});renderDetail(projects.find(x=>x.id===${p.id}))">${t.done ? '<span style="color:#05080f;font-size:9px">✓</span>' : ''}</div>
            <div class="t-body"><div class="t-text${t.done ? ' struck' : ''}">${t.text}${t.pri === 'high' ? ' <span style="color:var(--danger);font-size:10px">● HIGH</span>' : ''}</div></div>
            <div class="t-due">${t.due}</div>
            <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0" onclick="openTaskEdit(${t.id},${p.id})" title="Edit task">✏️</button>
            <button class="btn-del" onclick="removeTask(${t.id});renderDetail(projects.find(x=>x.id===${p.id}))">✕</button>
          </div>`,
        )
        .join('')
    : '<div style="font-size:13px;color:var(--text2)">No tasks yet</div>';

  const tagsHTML = (p.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(
      (t) =>
        `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:var(--s4);border:1px solid var(--border2);color:var(--text2);margin:2px 2px 0 0;display:inline-block">${t}</span>`,
    )
    .join('');

  document.getElementById('projDetailContent').innerHTML = `
          <div class="pd-hero" style="display:none">
            <div class="pd-hero-top">
              <div style="flex:1;min-width:0">
                <div style="margin-bottom:8px">
                  <span class="p-status ${SC[p.status] || 'ps-planning'}">● ${SL[p.status] || p.status}</span>
                  ${p.priority === 'high' ? '<span style="font-size:10px;color:var(--danger);font-weight:700;margin-left:8px">● HIGH PRIORITY</span>' : ''}
                </div>
                <div class="pd-name">${p.name}</div>
                <div class="pd-client">${p.client || ''}${p.addr ? ' · ' + p.addr : ''}</div>
                ${tagsHTML ? `<div style="margin-top:8px">${tagsHTML}</div>` : ''}
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;align-items:flex-start;margin-top:4px">
                <button class="btn btn-ghost btn-sm" onclick="editProj(${p.id})">✏️ Edit</button>
                <button class="btn-del" onclick="deleteProj(${p.id})">🗑 Delete</button>
              </div>
            </div>
            <div class="pd-prog-row">
              <span style="font-size:12px;color:var(--text2);min-width:70px">Progress</span>
              <div class="pd-prog-bar"><div class="pd-prog-fill" id="hpf" style="width:${p.progress || 0}%"></div></div>
              <input class="pd-prog-input" type="number" min="0" max="100" value="${p.progress || 0}" oninput="updateProg(${p.id},this.value)">
              <span style="font-size:11px;color:var(--text2)">%</span>
              ${p.phase ? `<span style="font-size:11px;color:var(--text2);margin-left:6px">· ${p.phase}</span>` : ''}
            </div>
            <div class="pd-info-grid">
              <div class="pd-cell"><div class="pd-cell-lbl">Project Manager</div><div class="pd-cell-val">${p.pm || '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Field Tech</div><div class="pd-cell-val">${p.tech || '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Building Type</div><div class="pd-cell-val">${p.type || '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Square Feet</div><div class="pd-cell-val" id="pd-sqft-cell-${p.id}">${p.sqft ? Number(p.sqft).toLocaleString() + ' sf' : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Service Agreement #</div><div class="pd-cell-val mono">${p.sa || '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Contract Value</div><div class="pd-cell-val mono">${p.contract ? '$' + Number(p.contract).toLocaleString() : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Est. Savings/yr</div><div class="pd-cell-val mono">${p.savings ? '$' + Number(p.savings).toLocaleString() : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Start Date</div><div class="pd-cell-val">${p.start ? _parseISO(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Target End</div><div class="pd-cell-val">${p.end ? _parseISO(p.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Contacts</div><div class="pd-cell-val">${p.contacts && p.contacts.length ? p.contacts.length + ' contact' + (p.contacts.length !== 1 ? 's' : '') : '—'}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Open Tasks</div><div class="pd-cell-val" style="color:${openTasks > 0 ? 'var(--warn)' : 'inherit'}">${openTasks}</div></div>
              <div class="pd-cell"><div class="pd-cell-lbl">Baseline Comparison</div><div class="pd-cell-val">${p.baselineComparison === 'normalized' ? 'Normalized' : 'Actual'}</div></div>
            </div>
          </div>
          <div class="pd-hero-compact" id="pd-hero-compact" style="display:flex">
            <button class="pd-back" onclick="backToList()" style="margin-bottom:0;margin-right:8px;flex-shrink:0">← Back</button>
            <span class="phc-name">${p.name}</span>
            <span class="phc-sep">|</span>
            <span>SA# <span class="phc-val">${p.sa || '—'}</span></span>
            <span class="phc-sep">|</span>
            <span>Savings <span class="phc-val">${p.savings ? '$' + Number(p.savings).toLocaleString() + '/yr' : '—'}</span></span>
            <span class="phc-sep">|</span>
            <span><span class="phc-val">${p.start ? _parseISO(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span> → <span class="phc-val">${p.end ? _parseISO(p.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span></span>
            <span class="phc-sep">|</span>
            <span id="phc-baseline-${p.id}">Baseline <span class="phc-val">—</span></span>
            <span class="phc-sep">|</span>
            <span id="phc-eui-${p.id}">Site EUI <span class="phc-val">—</span></span>
            <span class="phc-sep">|</span>
            <span>Tasks <span class="phc-val" style="${openTasks > 0 ? 'color:var(--warn)' : ''}">${openTasks}</span></span>
            <span class="phc-sep">|</span>
            <span><span class="phc-val">${getUDBldgs(p.id).length}</span> building${getUDBldgs(p.id).length !== 1 ? 's' : ''} · <span class="phc-val">${getUDBldgs(p.id).reduce((s, b) => s + parseInt(b.sqft || 0), 0) ? Number(getUDBldgs(p.id).reduce((s, b) => s + parseInt(b.sqft || 0), 0)).toLocaleString() + ' total sf' : ''}</span></span>
            <span class="phc-sep">|</span>
            <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:10px;flex-shrink:0" id="pd-proj-baseline-btn-${p.id}" onclick="toggleProjDetailPanel(${p.id},'baseline')">📊 Project Baseline</button>
            <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:10px;flex-shrink:0" id="pd-proj-savproj-btn-${p.id}" onclick="toggleProjDetailPanel(${p.id},'savproj')">📈 Projected Savings</button>
            <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:10px;flex-shrink:0" id="pd-proj-perf-btn-${p.id}" onclick="toggleProjDetailPanel(${p.id},'perf')">💡 Project Performance</button>
            <span class="phc-sep">|</span>
            <span style="display:flex;gap:4px;flex-shrink:0">
              <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:10px" onclick="openProjModal();editProj(${p.id})">✏️ Edit Project</button>
            </span>
          </div>
          <!-- Project-level panel content (shown when project-level buttons clicked) -->
          <div id="pd-proj-panel-content-${p.id}" style="display:none;border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;overflow-y:auto"></div>
          <div class="card" id="pd-tabs-card-${p.id}" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden">
            <div class="pd-tabs" id="pdTabBar" style="overflow-x:auto;flex-wrap:nowrap;white-space:nowrap;flex-shrink:0">
              ${_getProjTabHTML()}
            </div>
            <div id="ptab-dashboard" class="ptab active" style="padding:0;overflow-y:auto;overflow-x:hidden">
              <div id="dash-hdr-${p.id}"></div>
              <div style="padding:16px">
                <div class="dash-grid">
                  <div id="dash-perf-${p.id}" style="min-width:0"><div style="text-align:center;color:var(--text3);padding:40px">Loading...</div></div>
                  <div id="dash-cal-${p.id}" style="display:flex;flex-direction:column;gap:16px">
                    <div id="dash-cal-inner-${p.id}"><div style="text-align:center;color:var(--text3);padding:40px">Loading...</div></div>
                    <!-- Fix 27cf12ac: Notes and Tasks moved below calendar in right column -->
                    <div class="card">
                      <div class="card-hdr"><span class="card-title">📝 Notes</span></div>
                      <div style="padding:12px">
                        <textarea class="fta" style="min-height:120px;width:100%" id="proj-notes-ta-dash-${p.id}" oninput="autoSaveNotes(${p.id},this.value)">${p.notes || ''}</textarea>
                      </div>
                    </div>
                    <div class="card">
                      <div class="card-hdr" style="justify-content:space-between">
                        <span class="card-title">✅ Tasks</span>
                        <button class="btn btn-em btn-sm" onclick="document.getElementById('mt-proj').value=${p.id};openTaskModal()">+ Add Task</button>
                      </div>
                      <div id="dash-tasks-list-${p.id}" style="padding:12px">${tasksHTML}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div id="ptab-notes" class="ptab" style="padding:16px">
              <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">Notes / Description</div>
              <textarea class="fta" style="min-height:150px;width:100%" id="proj-notes-ta" oninput="autoSaveNotes(${p.id})">${p.notes || ''}</textarea>
            </div>
            <div id="ptab-tasks" class="ptab" style="padding:16px">
              <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
                <button class="btn btn-em btn-sm" onclick="document.getElementById('mt-proj').value=${p.id};openTaskModal()">+ Add Task</button>
              </div>
              <div id="ptab-tasks-list">${tasksHTML}</div>
            </div>
            <div id="ptab-contacts" class="ptab" style="padding:16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                <div style="font-size:12px;color:var(--text2)">${p.contacts && p.contacts.length ? p.contacts.length + ' contact' + (p.contacts.length !== 1 ? 's' : '') : 'No contacts yet'}</div>
                <button class="btn btn-em btn-sm" onclick="editProj(${p.id})">✏️ Edit Contacts</button>
              </div>
              ${buildContactsDetailHTML(p.contacts || [], p.id)}
            </div>
            <div id="ptab-utility" class="ptab" style="padding:0">
              <!-- Full Utility Data layout embedded, scoped to this project -->
              <!-- .ptab.active is now a flex column, so .ud-layout's flex:1 works without
                   a viewport-based min-height fallback. -->
              <div class="ud-layout" id="projUdLayout-${p.id}" style="border-top:1px solid var(--border);flex:1;min-height:0">
                <!-- Left: buildings nav -->
                <div class="ud-nav" style="max-width:240px">
                  <div style="padding:8px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;position:relative">
                    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Buildings</span>
                    <div style="display:flex;gap:4px;align-items:center">
                      <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 7px" onclick="toggleSavedBillsPanel(${JSON.stringify(p.id)})" id="saved-bills-btn-${p.id}" title="View saved PDF bills">🗄️ Bills</button>
                      <button class="btn btn-em btn-sm" style="font-size:10px;padding:2px 7px" onclick="openBldgModalForProj(${p.id})">+ Add</button>
                    </div>
                    <!-- Saved Bills dropdown panel — hidden by default, anchored to this bar. min-width ensures the bills table fits; overflow-x allows horizontal scroll. -->
                    <div id="ptab-savedbills-panel-${p.id}" style="display:none;position:absolute;top:100%;left:0;z-index:50;min-width:760px;background:var(--s1);border:1px solid var(--border);border-top:none;box-shadow:0 4px 12px rgba(0,0,0,.25);max-height:420px;overflow-y:auto;overflow-x:auto">
                      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
                        <span style="font-size:12px;font-weight:700;color:var(--text)">Saved Bills</span>
                        <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:1px 6px" onclick="toggleSavedBillsPanel(${JSON.stringify(p.id)})" title="Close">✕</button>
                      </div>
                      <div id="ptab-savedbills-body-${p.id}" style="padding:12px 14px">
                        <div style="text-align:center;color:var(--text3);padding:20px">Loading saved bills…</div>
                      </div>
                    </div>
                  </div>
                  <div id="proj-ud-bldg-nav-${p.id}" style="flex:1;overflow-y:auto"></div>
                </div>
                <!-- Right: meter detail -->
                <div class="ud-detail-col">
                  <div class="ud-collapse-tab" onclick="toggleUdNav('projUdLayout-${p.id}')" title="Toggle buildings panel">◀</div>
                  <div id="proj-ud-detail-hdr-${p.id}" style="display:none;flex-shrink:0;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--s1);align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                    <div>
                      <div id="proj-ud-hdr-title-${p.id}" style="font-size:15px;font-weight:700"></div>
                      <div id="proj-ud-hdr-sub-${p.id}" style="font-size:11px;color:var(--text2);margin-top:2px"></div>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      <button class="btn btn-ghost btn-sm" onclick="toggleProjUDPanel('${p.id}','baseline')">📊 Baseline Data</button>
                      <button class="btn btn-ghost btn-sm" onclick="toggleProjUDPanel('${p.id}','savproj')">📈 Savings Projection</button>
                      <button class="btn btn-ghost btn-sm" onclick="toggleProjUDPanel('${p.id}','perf')">💡 Building Performance</button>
                      <button class="btn btn-ghost btn-sm" onclick="toggleProjUDPanel('${p.id}','scorecard')" title="Print-ready building summary for board presentations">📋 Scorecard</button>
                      <button class="btn btn-ghost btn-sm" onclick="(function(){var _b=getUDBldg('${p.id}',projUDSelBldg['${p.id}']);if(typeof openEcmCalculatorForBuilding==='function')openEcmCalculatorForBuilding('${p.id}',projUDSelBldg['${p.id}'],_b?_b.name:'Building');})()" title="Open ECM Calculator pre-filled with this building's bill data">⚡ ECM Calculator</button>
                      <button class="btn btn-ghost btn-sm" onclick="openBldgModalForProj(${p.id}, projUDSelBldg['${p.id}'])">✏️ Edit Building</button>
                      <button class="btn btn-ghost btn-sm" onclick="openExportModal('building','${p.id}')" title="Export utility bill data to JSON or CSV">📤 Export Data</button>
                      <button class="btn btn-em btn-sm" onclick="projUDOpenMeterModal('${p.id}')">+ Add Meter</button>
                    </div>
                  </div>
                  <!-- Must mirror the standalone Utility Data body layout: display:flex +
                       flex-direction:column + min-height:0 + min-width:0 so the inner
                       #maMeterWorkspace → .ma-pane → .bills-scroll-body flex chain has an
                       anchored ceiling. Without display:flex here, maMeterWorkspace's
                       flex:1 + min-height:0 collapsed the bills body to zero height,
                       leaving the user with headers + flag banner but no visible rows. -->
                  <div id="proj-ud-body-${p.id}" style="flex:1 1 0;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden">
                    <div class="ud-empty"><div class="ud-empty-ico">🏢</div><div>Select a building to view meters</div></div>
                  </div>
                </div>
              </div>
            </div>
            <div id="ptab-savedbills" class="ptab" style="padding:16px;overflow-y:auto">
              <!-- Merged into Utility Data tab (fix 35571527) — kept for backward compat -->
              <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Saved Bills have moved to the ⚡ Utility Data tab.</div>
            </div>
            <div id="ptab-budget" class="ptab" style="padding:0;overflow-y:auto">
              <div id="ptab-budget-body-${p.id}">
                <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Loading budget data...</div>
              </div>
            </div>
            <div id="ptab-hours" class="ptab" style="padding:0;overflow-y:auto">
              <div id="ptab-hours-body-${p.id}">
                <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Loading hours data...</div>
              </div>
            </div>
            <div id="ptab-eq-matrix" class="ptab" style="padding:0">
              <div id="em-proj-wrap"></div>
            </div>
            <div id="ptab-bas-trends" class="ptab" style="padding:0;overflow-y:auto">
              <div id="ptab-bas-trends-body-${p.id}"></div>
            </div>
            <div id="ptab-hvacload" class="ptab" style="padding:0;overflow-y:auto">
              <div id="hvl-container-${p.id}" style="display:flex;flex-direction:column;height:100%;min-height:0">
                <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Loading HVAC load data...</div>
              </div>
            </div>
            <div id="ptab-energygfx" class="ptab" style="padding:16px;overflow-y:auto">
              <div class="card" style="margin-bottom:16px">
                <div class="card-hdr" style="justify-content:space-between">
                  <span class="card-title">📈 Energy Graphics — Baseline vs Performance</span>
                  <div style="display:flex;gap:8px">
                    <button class="btn btn-ghost btn-sm" onclick="egfxExport(${p.id})">⬇ Export</button>
                    <button class="btn btn-ghost btn-sm" onclick="openReportModalV2(${p.id})">📄 Generate Report</button>
                    <button class="btn btn-em btn-sm" onclick="egfxRefresh(${p.id})">🔄 Refresh</button>
                  </div>
                </div>
                <div style="padding:16px">
                  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px">
                    <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Baseline Site EUI</div>
                      <div id="egfx-blEui-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--accent);margin:6px 0">—</div>
                      <div style="font-size:11px;color:var(--text2)">kBtu/ft²</div>
                    </div>
                    <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Rolling 12-Mo Site EUI</div>
                      <div id="egfx-curEui-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--em);margin:6px 0">—</div>
                      <div id="egfx-curEuiSub-${p.id}" style="font-size:11px;color:var(--text2)">kBtu/ft²</div>
                    </div>
                    <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Est. ENERGY STAR Score</div>
                      <div id="egfx-estarScore-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--text3);margin:6px 0">—</div>
                      <div id="egfx-estarScoreSub-${p.id}" style="font-size:11px;color:var(--text3)">source EUI est.</div>
                    </div>
                    <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Projected Savings</div>
                      <div id="egfx-projSav-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--accent);margin:6px 0">—</div>
                      <div id="egfx-projSavSub-${p.id}" style="font-size:11px;color:var(--text2)">annual target</div>
                    </div>
                    <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Current Savings</div>
                      <div id="egfx-curSav-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--green);margin:6px 0">—</div>
                      <div id="egfx-curSavSub-${p.id}" style="font-size:11px;color:var(--text2)">actual to date</div>
                    </div>
                  </div>
                  <div id="egfx-commodity-savings-${p.id}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px"></div>
                  <div id="egfx-pre-pollcalc-${p.id}" style="margin-bottom:0"></div>
                  <!-- Pollution Credit Calculator collapsible section -->
                  <div id="egfx-pollcalc-wrap-${p.id}" style="margin-bottom:16px">
                    <div onclick="egfxTogglePollCalc(${p.id})" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--s1);border-radius:8px;cursor:pointer;border:1px solid var(--border)">
                      <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2)">Pollution Credit Calculator</span>
                      <span id="egfx-pollcalc-chev-${p.id}" style="font-size:10px;color:var(--text3)">▶</span>
                    </div>
                    <div id="egfx-pollcalc-body-${p.id}" style="display:none;padding:20px 16px 16px 16px;background:var(--s1);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px">
                      <div id="egfx-pollcalc-content-${p.id}" style="font-size:13px;line-height:2;text-align:center;color:var(--text)">
                        <span style="color:var(--text3)">Refresh energy graphics to calculate pollution credits.</span>
                      </div>
                    </div>
                  </div>
                  <!-- Performance Verification collapsible section -->
                  <div id="egfx-perfverify-wrap-${p.id}" style="margin-bottom:16px">
                    <div onclick="egfxTogglePerfVerify(${p.id})" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--s1);border-radius:8px;cursor:pointer;border:1px solid var(--border)">
                      <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2)">Performance Verification</span>
                      <span id="egfx-perfverify-chev-${p.id}" style="font-size:10px;color:var(--text3)">&#9654;</span>
                    </div>
                    <div id="egfx-perfverify-body-${p.id}" style="display:none;padding:20px 16px 16px;background:var(--s1);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px">
                      <div id="egfx-perfverify-content-${p.id}" style="font-size:13px;color:var(--text)">
                        <span style="color:var(--text3)">Expand to load performance verification data.</span>
                      </div>
                    </div>
                  </div>
                  <div id="egfx-eui-detail-${p.id}" style="display:flex;gap:16px;margin-bottom:16px;font-size:11px;color:var(--text2)"></div>
                  <div id="egfx-charts-${p.id}">
                    <div style="font-size:13px;color:var(--text3);text-align:center;padding:40px">Add utility data to buildings to see energy graphics. Baseline and year-over-year kWh, kW, and gas consumption will appear here.</div>
                  </div>
                </div>
              </div>
            </div>
            <div id="ptab-district" class="ptab" style="padding:16px">
              <div id="ptab-district-inner-${p.id}" style="padding:16px">
                <div class="card" style="margin-bottom:16px">
                  <div class="card-hdr" style="justify-content:space-between">
                    <span class="card-title">🗓️ District Calendar</span>
                    <div style="display:flex;gap:8px">
                      <button class="btn btn-ghost btn-sm" onclick="distCalAddRow(${p.id})">+ Add Event</button>
                      <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(244,63,94,.35)" onclick="distCalDeleteAll(${p.id})">🗑 Delete All</button>
                      <button class="btn btn-em btn-sm" onclick="distCalShowImport(${p.id})">📥 Import Calendar</button>
                    </div>
                  </div>
                  <div style="padding:16px">
                    <div id="distcal-import-${p.id}" style="display:none;margin-bottom:16px">
                      <div style="display:flex;gap:4px;margin-bottom:10px">
                        <button class="ptpill sel" onclick="distCalImportTab(${p.id},'url',this)">🔗 URL</button>
                        <button class="ptpill" onclick="distCalImportTab(${p.id},'pdf',this)">📄 PDF Upload</button>
                        <button class="ptpill" onclick="distCalImportTab(${p.id},'text',this)">📋 Paste Text</button>
                      </div>
                      <div id="distcal-import-url-${p.id}">
                        <div style="display:flex;gap:8px;margin-bottom:8px">
                          <input class="fi" id="distcal-url-${p.id}" placeholder="https://...calendar.pdf" style="flex:1">
                          <button class="btn btn-em btn-sm" onclick="distCalLoadURL(${p.id})">Load</button>
                        </div>
                        <div style="font-size:11px;color:var(--text3)">Paste a direct link to the district's PDF calendar. If blocked by CORS, use PDF Upload instead.</div>
                      </div>
                      <div id="distcal-import-pdf-${p.id}" style="display:none">
                        <div style="border:2px dashed var(--border2);border-radius:8px;padding:20px;text-align:center;cursor:pointer;margin-bottom:8px"
                             onclick="document.getElementById('distcal-file-${p.id}').click()"
                             ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
                             ondragleave="this.style.borderColor='var(--border2)'"
                             ondrop="distCalDropFile(event,${p.id})">
                          <div style="font-size:24px;margin-bottom:4px">📅</div>
                          <div style="font-size:12px;font-weight:600">Drop PDF here or click to browse</div>
                          <input type="file" id="distcal-file-${p.id}" accept=".pdf" style="display:none" onchange="distCalFileChosen(event,${p.id})">
                        </div>
                      </div>
                      <div id="distcal-import-text-${p.id}" style="display:none">
                        <textarea class="fta" id="distcal-text-${p.id}" style="min-height:120px" placeholder="Paste calendar text here — holidays, breaks, early release days, first/last day of school..."></textarea>
                        <div style="display:flex;gap:8px;margin-top:8px">
                          <button class="btn btn-em btn-sm" onclick="distCalRunParse(${p.id})">Extract Events</button>
                        </div>
                      </div>
                      <div id="distcal-import-status-${p.id}" style="display:none;margin-top:8px;font-size:12px;color:var(--text2)"></div>
                      <div style="margin-top:8px;text-align:right"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('distcal-import-${p.id}').style.display='none'">Cancel</button></div>
                    </div>
                    <div id="distcal-table-${p.id}"></div>
                  </div>
                </div>
              </div>
            </div>
            <div id="ptab-savings" class="ptab" style="padding:16px;overflow-y:auto">
              <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Loading savings data...</div>
            </div>
            <div id="ptab-docs" class="ptab" style="padding:16px;overflow-y:auto">
              <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:10px" id="docsSubTabs">
                <button class="ptpill" data-dsub="contracts" onclick="renderDocsSubTab('contracts',${p.id})">📋 Contracts</button>
                <button class="ptpill sel" data-dsub="meetings" onclick="renderDocsSubTab('meetings',${p.id})">📋 Meetings</button>
                <button class="ptpill" data-dsub="approved" onclick="renderDocsSubTab('approved',${p.id})">✅ Approved Changes</button>
                <button class="ptpill" data-dsub="files" onclick="renderDocsSubTab('files',${p.id})">📁 Files</button>
              </div>
              <div id="ptab-docs-body-${p.id}"></div>
            </div>
            <div id="ptab-setpoints" class="ptab" style="padding:16px;overflow-y:auto">
              <div id="ptab-setpoints-body-${p.id}">
                <div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">Loading set points…</div>
              </div>
            </div>
            <div id="ptab-settings" class="ptab" style="padding:16px;overflow-y:auto">
              <div style="display:flex;flex-wrap:wrap;gap:16px">
              <div class="card" style="max-width:560px;flex:1;min-width:280px">
                <div class="card-hdr"><span class="card-title">⚡ Commodity Types</span></div>
                <div style="padding:14px">
                  <div style="font-size:12px;color:var(--text2);margin-bottom:14px">
                    <strong>Show</strong> — whether meters appear in Utility Data and Baseline tables.<br>
                    <strong>Include in Calculations</strong> — whether the commodity is used in baseline, savings, and performance math.
                  </div>
                  <div id="ptab-settings-commodities-${p.id}">
                    <div style="display:grid;grid-template-columns:1fr auto auto;gap:6px 16px;align-items:center;font-size:13px">
                      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase">Commodity</div>
                      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;text-align:center">Show</div>
                      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;text-align:center">Calculations</div>
                      ${ALL_COMMODITIES.map((c) => {
                        const shown = !Array.isArray(p.shownCommodities) || p.shownCommodities.includes(c);
                        const calc = !Array.isArray(p.calcCommodities) || p.calcCommodities.includes(c);
                        return `<div>${c}</div>
                          <div style="text-align:center"><input type="checkbox" ${shown ? 'checked' : ''} onchange="toggleProjCommodityShown(${p.id},'${c}',this.checked)" style="width:16px;height:16px;cursor:pointer"></div>
                          <div style="text-align:center"><input type="checkbox" ${calc ? 'checked' : ''} onchange="toggleProjCommodityCalc(${p.id},'${c}',this.checked)" style="width:16px;height:16px;cursor:pointer"></div>`;
                      }).join('')}
                    </div>
                  </div>
                </div>
              </div>
              <div class="card" style="max-width:480px;flex:1;min-width:280px">
                <div class="card-hdr"><span class="card-title">💡 Performance Settings</span></div>
                <div style="padding:14px">
                  <div style="font-size:12px;color:var(--text2);margin-bottom:14px">
                    Default values applied to all buildings in this project. Buildings can override individually.
                  </div>
                  <div style="display:flex;flex-direction:column;gap:12px">
                    <label style="display:flex;flex-direction:column;gap:4px">
                      <span style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">CSC Compensation %</span>
                      <input class="fi" type="number" min="0" max="100" step="0.1" value="${p.cscCompensation || 0}" onchange="updateProjPerfSetting(${p.id},'cscCompensation',parseFloat(this.value)||0)" style="width:120px;font-family:var(--mono)">
                    </label>
                    <label style="display:flex;flex-direction:column;gap:4px">
                      <span style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Contract Years</span>
                      <select class="fi" onchange="updateProjPerfSetting(${p.id},'contractYears',parseInt(this.value)||3)" style="width:120px;font-family:var(--mono)">
                        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((y) => `<option value="${y}"${(p.contractYears || 3) === y ? ' selected' : ''}>${y} Year${y > 1 ? 's' : ''}</option>`).join('')}
                      </select>
                    </label>
                    <label style="display:flex;flex-direction:column;gap:4px">
                      <span style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Utility Escalation %/Yr</span>
                      <input class="fi" type="number" min="0" max="20" step="0.1" value="${p.escalation || 0}" onchange="updateProjPerfSetting(${p.id},'escalation',parseFloat(this.value)||0)" style="width:120px;font-family:var(--mono)">
                    </label>
                  </div>
                </div>
              </div>
              <div class="card" style="max-width:480px;flex:1;min-width:280px">
                <div class="card-hdr"><span class="card-title">📈 Energy Graphics</span></div>
                <div style="padding:14px">
                  <div style="font-size:12px;color:var(--text2);margin-bottom:14px">
                    Controls what data appears on the Energy Graphics tab.
                  </div>
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" ${p.showPreBaselineYears ? 'checked' : ''} onchange="updateProjPerfSetting(${p.id},'showPreBaselineYears',this.checked)" style="width:16px;height:16px;cursor:pointer">
                    <span style="font-size:12px;color:var(--text)">Show pre-baseline years in charts and tables</span>
                  </label>
                </div>
              </div>
              <div class="card" style="max-width:480px;flex:1;min-width:280px">
                <div class="card-hdr"><span class="card-title">📐 Default Display Units</span></div>
                <div style="padding:14px">
                  <div style="font-size:12px;color:var(--text2);margin-bottom:14px">
                    Default output units for all meters in this project. Meters can still override individually.
                  </div>
                  <div style="display:flex;flex-direction:column;gap:12px">
                    ${['Electric', 'Gas', 'Water', 'Propane']
                      .map((comm) => {
                        const reg = {
                          Electric: {
                            usage: ['kWh', 'MWh'],
                            demand: ['kW', 'MW'],
                          },
                          Gas: { usage: ['Therms', 'CCF', 'MCF', 'DTh'] },
                          Water: { usage: ['Gallons', 'kGal', 'CCF'] },
                          Propane: { usage: ['Gallons', 'Therms'] },
                        }[comm];
                        if (!reg) return '';
                        const cur = (p.defaultDisplayUnits || {})[comm] || '';
                        return `<label style="display:flex;flex-direction:column;gap:4px">
                        <span style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">${comm} Usage Unit</span>
                        <select class="fi" style="width:140px;font-family:var(--mono)" onchange="updateProjPerfSetting(${p.id},'defaultDisplayUnits',Object.assign({},(projects.find(x=>x.id===${p.id})||{}).defaultDisplayUnits||{},{${comm}:this.value}))">
                          <option value=""${!cur ? ' selected' : ''}>Default</option>
                          ${reg.usage.map((u) => `<option value="${u}"${cur === u ? ' selected' : ''}>${u}</option>`).join('')}
                        </select>
                      </label>`;
                      })
                      .join('')}
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>`;
  // Populate tabs after DOM is ready
  requestAnimationFrame(() => {
    _initTabDrag();
    initProjUDTab(p.id);
    initDashboardTab(p.id);
    _updateCompactHdrBaseline(p.id);
  });
}

function _updateCompactHdrBaseline(projId) {
  const bldgs = getUDBldgs(projId);
  const sqft = bldgs.reduce((s, b) => s + parseInt(b.sqft || 0), 0);
  let blCost = 0,
    blKwh = 0,
    blTherms = 0,
    blPropane = 0,
    totalCost = 0,
    totalKwh = 0,
    totalTherms = 0,
    totalPropane = 0;
  const _blMonthSet = new Set();
  bldgs.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const blBills = _dashGetBaselineBills(m);
      const bl = m.baseline;
      if (bl && bl.months) bl.months.forEach((ym) => _blMonthSet.add(ym));
      blBills.forEach((bill) => {
        blCost += parseFloat(bill.totalCost) || parseFloat(bill.thermCost) || parseFloat(bill.cost) || 0;
        if (m.commodity === 'Gas') {
          blTherms += parseFloat(bill.therms) || 0;
        } else if (m.commodity === 'Propane') {
          blPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
        } else {
          blKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
        }
      });
      (m.bills || []).forEach((bill) => {
        totalCost += parseFloat(bill.totalCost) || parseFloat(bill.thermCost) || parseFloat(bill.cost) || 0;
        if (m.commodity === 'Gas') {
          totalTherms += parseFloat(bill.therms) || 0;
        } else if (m.commodity === 'Propane') {
          totalPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
        } else {
          totalKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
        }
      });
    }),
  );
  const useCost = blCost > 0 ? blCost : totalCost;
  const useKwh = blKwh > 0 ? blKwh : totalKwh;
  const useTherms = blTherms > 0 ? blTherms : totalTherms;
  const usePropane = blPropane > 0 ? blPropane : totalPropane;
  const label = blCost > 0 ? 'Baseline' : 'Total Cost';
  const kBtu = computeKBtu(useKwh, useTherms, usePropane);
  const _blMonthCount = _blMonthSet.size || 12;
  const eui = sqft > 0 && kBtu > 0 ? (((kBtu / _blMonthCount) * 12) / sqft).toFixed(1) : '—';
  const blEl = document.getElementById('phc-baseline-' + projId);
  const euiEl = document.getElementById('phc-eui-' + projId);
  if (blEl)
    blEl.innerHTML =
      label + ' <span class="phc-val">' + (useCost > 0 ? '$' + Math.round(useCost).toLocaleString() : '—') + '</span>';
  if (euiEl) euiEl.innerHTML = 'Site EUI <span class="phc-val">' + eui + '</span>';
  // Auto-update progress
  const _p = projects.find((x) => x.id === projId);
  if (_p) {
    const auto = calcAutoProgress(projId);
    if (auto !== (_p.progress || 0)) {
      _p.progress = auto;
      sset('en_projects', projects);
      const f = document.getElementById('hpf');
      if (f) f.style.width = auto + '%';
      const inp = document.querySelector('.pd-prog-input');
      if (inp) inp.value = auto;
    }
  }
}

function _dashGetBaselineBills(m) {
  // Return only bills selected as baseline for this meter
  const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const bl = m.baseline || {};
  const blMonths = bl.months || [];
  if (!blMonths.length) return [];
  const incl = m.inclusive !== false;
  return bills.filter((b) => {
    const ym = normMonth(b.start, b.end, incl, bills);
    return blMonths.includes(ym);
  });
}

function initDashboardTab(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const hdrWrap = document.getElementById('dash-hdr-' + projId);
  const perfWrap = document.getElementById('dash-perf-' + projId);
  if (!perfWrap) return;
  const bldgs = getUDBldgs(projId);
  const estSavings = parseFloat(p.savings) || 0;
  const useNormalized = p.baselineComparison === 'normalized';

  // Render header bar (like HVAC Load Est)
  if (hdrWrap) {
    const totalSqft = bldgs.reduce((s, b) => s + parseInt(b.sqft || 0), 0);
    const _totalMeterCount = bldgs.reduce((s, b) => s + (b.meters || []).length, 0);
    const _inclMeters = (b) => (b.meters || []).filter((m) => m.baselineInclude !== false);
    const _blInclCount = bldgs.reduce((s, b) => s + _inclMeters(b).length, 0);
    const billCount = bldgs.reduce((s, b) => s + (b.meters || []).reduce((s2, m) => s2 + (m.bills || []).length, 0), 0);
    const blMeterCount = bldgs.reduce(
      (s, b) => s + _inclMeters(b).filter((m) => m.baseline && Object.keys(m.baseline.months || {}).length > 0).length,
      0,
    );
    hdrWrap.innerHTML = `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0">
            <span style="font-size:13px;font-weight:700;color:var(--text)">📊 Project Dashboard</span>
            <span style="font-size:11px;color:var(--text3)">
              ${bldgs.length} building${bldgs.length !== 1 ? 's' : ''}${totalSqft ? ' · ' + Number(totalSqft).toLocaleString() + ' sf' : ''} · ${_totalMeterCount} meter${_totalMeterCount !== 1 ? 's' : ''} · ${billCount} bill${billCount !== 1 ? 's' : ''}
            </span>
            ${_blInclCount === 0 ? '' : blMeterCount < _blInclCount ? '<span style="font-size:11px;color:var(--amber);font-weight:600">⚠ ' + blMeterCount + '/' + _blInclCount + ' baseline meters have baselines set</span>' : '<span style="font-size:11px;color:var(--green)">✓ All baseline meters have baselines</span>'}
          </div>`;
  }

  if (!bldgs.length || !bldgs.some((b) => (b.meters || []).some((m) => (m.bills || []).length > 0))) {
    perfWrap.innerHTML =
      '<div class="card"><div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">Add buildings and utility data to see performance summary.<br><span style="font-size:11px">Use the <strong style="color:var(--accent)">Utility Data</strong> tab to get started.</span></div></div>';
    return;
  }

  let totalBl = 0,
    totalCur = 0,
    totalDirectSav = 0;
  const projectedByQtr = [0, 0, 0, 0];
  let projectedAnnual = 0;
  const actualByQtr = [0, 0, 0, 0];
  let latestBillEnd = null;
  let latestSavYM = null; // full 'YYYY-MM' string of last month with savings data
  const curQtr = Math.floor(new Date().getMonth() / 3);
  const bldgRows = bldgs.map((b) => {
    const meters = b.meters || [];
    const sqft = parseInt(b.sqft || 0);
    let blCost = 0,
      curCost = 0,
      blKwh = 0,
      curKwh = 0,
      blTherms = 0,
      curTherms = 0,
      blPropane = 0,
      curPropane = 0,
      blPeriod = '',
      allCost = 0,
      allKwh = 0,
      allTherms = 0,
      allPropane = 0;
    let hasBaseline = false;
    let bldgSav = 0;
    let meterIncl = 0,
      meterExcl = 0,
      meterTotal = meters.length;
    const meterDetails = meters.map((m) => {
      const incl = m.baselineInclude !== false;
      const hasBl = m.baseline && m.baseline.months && m.baseline.months.length >= 3;
      if (incl && hasBl) meterIncl++;
      else if (!incl) meterExcl++;
      return {
        name: m.name || m.commodity || '?',
        commodity: m.commodity,
        included: incl,
        hasBaseline: hasBl,
      };
    });

    if (useNormalized) {
      // Normalized path: use same calculation as Performance panel
      const bldgMoBase = {};
      for (let i = 0; i < 12; i++) bldgMoBase[i] = 0;
      meters.forEach((m) => {
        if (m.baselineInclude === false) return;
        if (!isCalcCommodity(projId, m.commodity)) return;
        const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
        const incl = m.inclusive !== false;
        if (bills.length) {
          const lastEnd = bills[bills.length - 1].end;
          if (lastEnd && (!latestBillEnd || lastEnd > latestBillEnd)) latestBillEnd = lastEnd;
        }
        const bl = m.baseline;
        if (!bl || !bl.months || bl.months.length < 3) return;
        hasBaseline = true;
        // Baseline period label — use baseline MONTHS, not raw bill dates,
        // because bill start dates can fall in the prior month (e.g., a bill
        // starting Dec 28 belongs to the Jan baseline month).
        if (!blPeriod && bl.months.length) {
          const sorted = bl.months.slice().sort();
          const first = sorted[0] + '-01',
            last = sorted[sorted.length - 1] + '-01';
          blPeriod =
            new Date(first + 'T12:00:00').toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            }) +
            ' – ' +
            new Date(last + 'T12:00:00').toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            });
        }
        // Normalized baseline cost per calendar month
        const blBills = _dashGetBaselineBills(m);
        const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
        const blRows = allRows.filter((r) => bl.months.includes(r.ym));
        const { elecByMo: eM, gasByMo: gM, propaneByMo: pM } = buildMoMap(m, blRows, bills, incl);
        for (let mo = 0; mo < 12; mo++)
          bldgMoBase[mo] += (eM[mo]?.commodityCost || 0) + (gM[mo]?.cost || 0) + (pM[mo]?.cost || 0);
        // Normalized actual savings per calendar month
        const savResult = getMeterSavings(m, bills, incl, projId, b.id);
        const savCalMo = savResult.byCalMo;
        Object.entries(savCalMo).forEach(([mo, v]) => {
          bldgSav += v;
        });
        Object.entries(savResult.byYM).forEach(([ym, v]) => {
          if (v !== 0 && (latestSavYM === null || ym > latestSavYM)) latestSavYM = ym;
        });
        const _savYMKeys = Object.keys(savResult.byYM).filter((ym) => savResult.byYM[ym] !== 0);
        const _reportYear = _savYMKeys.length ? _savYMKeys.slice().sort().pop().slice(0, 4) : null;
        if (_reportYear) {
          Object.entries(savResult.byYM).forEach(([ym, v]) => {
            if (ym.startsWith(_reportYear)) {
              const moIdx = parseInt(ym.split('-')[1]) - 1;
              const qi = Math.floor(moIdx / 3);
              actualByQtr[qi] += v;
            }
          });
        }
        // Usage for EUI
        const _blEndYM = bl.months.slice().sort().pop();
        const _curBills = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && ym > _blEndYM;
        });
        if (m.commodity === 'Gas') {
          blBills.forEach((bill) => {
            blTherms += parseFloat(bill.therms) || 0;
          });
          _curBills.forEach((bill) => {
            curTherms += parseFloat(bill.therms) || 0;
          });
        } else if (m.commodity === 'Propane') {
          blBills.forEach((bill) => {
            blPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          });
          _curBills.forEach((bill) => {
            curPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          });
        } else {
          blBills.forEach((bill) => {
            blKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          });
          _curBills.forEach((bill) => {
            curKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          });
        }
      });
      blCost = Object.values(bldgMoBase).reduce((s, v) => s + v, 0);
      curCost = blCost - bldgSav;
    } else {
      // Actual path: existing raw totalCost comparison
      meters.forEach((m) => {
        if (m.baselineInclude === false) return;
        if (!isCalcCommodity(projId, m.commodity)) return;
        const blBills = _dashGetBaselineBills(m);
        if (blBills.length) hasBaseline = true;
        blBills.forEach((bill) => {
          if (m.commodity === 'Electric') {
            blCost +=
              (parseFloat(bill.kwhCost) || 0) + (parseFloat(bill.kwCost) || 0) + (parseFloat(bill.facKWCost) || 0);
          } else {
            blCost += parseFloat(bill.totalCost) || parseFloat(bill.thermCost) || parseFloat(bill.cost) || 0;
          }
          if (m.commodity === 'Gas') {
            blTherms += parseFloat(bill.therms) || 0;
          } else if (m.commodity === 'Propane') {
            blPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          } else {
            blKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          }
        });
        const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
        if (bills.length) {
          const lastEnd = bills[bills.length - 1].end;
          if (lastEnd && (!latestBillEnd || lastEnd > latestBillEnd)) latestBillEnd = lastEnd;
        }
        bills.slice(-12).forEach((bill) => {
          if (m.commodity === 'Electric') {
            curCost +=
              (parseFloat(bill.kwhCost) || 0) + (parseFloat(bill.kwCost) || 0) + (parseFloat(bill.facKWCost) || 0);
          } else {
            curCost += parseFloat(bill.totalCost) || parseFloat(bill.thermCost) || parseFloat(bill.cost) || 0;
          }
          if (m.commodity === 'Gas') {
            curTherms += parseFloat(bill.therms) || 0;
          } else if (m.commodity === 'Propane') {
            curPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          } else {
            curKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          }
        });
        // Tally all bills as fallback when no baseline is set
        (m.bills || []).forEach((bill) => {
          if (m.commodity === 'Electric') {
            allCost +=
              (parseFloat(bill.kwhCost) || 0) + (parseFloat(bill.kwCost) || 0) + (parseFloat(bill.facKWCost) || 0);
          } else {
            allCost += parseFloat(bill.totalCost) || parseFloat(bill.thermCost) || parseFloat(bill.cost) || 0;
          }
          if (m.commodity === 'Gas') {
            allTherms += parseFloat(bill.therms) || 0;
          } else if (m.commodity === 'Propane') {
            allPropane += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          } else {
            allKwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          }
        });
        // Baseline period label — use baseline months, not raw bill dates
        const bl = m.baseline;
        if (bl && bl.months && bl.months.length && !blPeriod) {
          const sorted = bl.months.slice().sort();
          const first = sorted[0] + '-01',
            last = sorted[sorted.length - 1] + '-01';
          blPeriod =
            new Date(first + 'T12:00:00').toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            }) +
            ' – ' +
            new Date(last + 'T12:00:00').toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            });
        }
        const _actIncl = m.inclusive !== false;
        const _actSavResult = getMeterSavings(m, bills, _actIncl, projId, b.id);
        const _actSavYMKeys = Object.keys(_actSavResult.byYM).filter((ym) => _actSavResult.byYM[ym] !== 0);
        const _actReportYear = _actSavYMKeys.length ? _actSavYMKeys.slice().sort().pop().slice(0, 4) : null;
        if (_actReportYear) {
          Object.entries(_actSavResult.byYM).forEach(([ym, v]) => {
            if (ym.startsWith(_actReportYear)) {
              const moIdx = parseInt(ym.split('-')[1]) - 1;
              const qi = Math.floor(moIdx / 3);
              actualByQtr[qi] += v;
            }
          });
        }
        Object.entries(_actSavResult.byYM).forEach(([ym, v]) => {
          if (v !== 0 && (latestSavYM === null || ym > latestSavYM)) latestSavYM = ym;
        });
      });
    }
    // Fallback: if no baseline set and actual mode, annualize allCost
    const totalBillCount = meters.reduce((s, m) => s + (m.bills || []).length, 0);
    const annualizedAllCost = totalBillCount > 12 ? (allCost / totalBillCount) * 12 : allCost;
    const useCost = blCost > 0 ? blCost : useNormalized ? 0 : annualizedAllCost;
    const useKwh = blKwh > 0 ? blKwh : allKwh;
    const useTherms = blTherms > 0 ? blTherms : allTherms;
    const usePropane = blPropane > 0 ? blPropane : allPropane;
    const blLabel = hasBaseline ? 'Baseline' : 'Total Cost';
    totalBl += useCost;
    totalCur += curCost;
    // Always use bldgSav from getMeterSavings — single source of truth
    const sav = bldgSav;
    totalDirectSav += sav;
    const savPct = useCost > 0 ? (sav / useCost) * 100 : 0;
    // EUI: kBtu/sf/yr — annualized (see computations/eui.js for KBTU_FACTORS)
    const blKBtu = computeKBtu(useKwh, useTherms, usePropane);
    const curKBtu = computeKBtu(curKwh, curTherms, curPropane);
    const _bldgBlMonths = new Set();
    meters.forEach((m) => {
      if (m.baseline && m.baseline.months) m.baseline.months.forEach((ym) => _bldgBlMonths.add(ym));
    });
    const _bldgBlMoCt = _bldgBlMonths.size || 12;
    const blEUI = computeBaselineEUI(blKBtu, _bldgBlMoCt, sqft);
    const _curMoSet = new Set();
    meters.forEach((m) => {
      const incl2 = m.inclusive !== false;
      (m.bills || []).forEach((bill) => {
        const ym = normMonth(bill.start, bill.end, incl2, m.bills || []);
        if (ym && ym > (m.baseline && m.baseline.months ? m.baseline.months.slice().sort().pop() : ''))
          _curMoSet.add(ym);
      });
    });
    const _curMoCt = _curMoSet.size || 12;
    const curEUI = computePeriodEUI(curKBtu, _curMoCt, sqft);
    let status = 'No Data',
      statusColor = 'var(--text3)';
    if (useCost > 0 && curCost > 0) {
      if (sav < 0) {
        status = 'Over Budget';
        statusColor = 'var(--danger)';
      } else if (estSavings > 0 && sav >= estSavings * 0.8) {
        status = 'On Track';
        statusColor = 'var(--green)';
      } else if (sav > 0) {
        status = 'Below Target';
        statusColor = 'var(--amber)';
      } else {
        status = 'No Savings';
        statusColor = 'var(--text3)';
      }
    }
    const msrSav = getBldgMeasureSavingsByMo(projId, b.id);
    if (msrSav) {
      for (let mo = 0; mo < 12; mo++) {
        const qi = Math.floor(mo / 3);
        projectedByQtr[qi] += msrSav[mo] || 0;
        projectedAnnual += msrSav[mo] || 0;
      }
    }
    return {
      name: b.name,
      sqft,
      blCost: useCost,
      curCost,
      sav,
      savPct,
      blEUI,
      curEUI,
      blPeriod: blPeriod || (useNormalized ? '—' : 'All Bills'),
      blLabel,
      status,
      statusColor,
      meterIncl,
      meterExcl,
      meterTotal,
      meterDetails,
    };
  });

  // Use the directly-accumulated per-building savings (same source as Project Performance page).
  const totalSav = totalDirectSav;
  const totalPct = totalBl > 0 ? (totalSav / totalBl) * 100 : 0;
  const $c = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
  const $c2 = (n) =>
    '$' +
    Math.abs(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const curQtrLabel = 'Q' + (curQtr + 1);
  const curQtrActual = actualByQtr[curQtr];
  const curQtrProjected = projectedByQtr[curQtr];
  const curQtrPct = curQtrProjected > 0 ? ((curQtrActual / curQtrProjected) * 100).toFixed(1) : null;
  const throughDate =
    latestSavYM !== null
      ? new Date(latestSavYM + '-01T12:00:00').toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })
      : null;

  // ECM projected savings
  const _ecmResult =
    typeof getProjectEcmTotal === 'function' ? getProjectEcmTotal(projId) : { total: 0, count: 0, ecms: [] };
  const ecmTotal = _ecmResult.total || 0;
  const ecmCount = _ecmResult.count || 0;

  perfWrap.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div style="padding:20px;display:flex;gap:24px;align-items:stretch;flex-wrap:wrap">
              <div style="flex:1;min-width:320px;background:rgba(147,51,234,0.15);border:1px solid rgba(147,51,234,0.3);border-radius:8px;padding:16px">
                <div style="display:flex;align-items:flex-start;gap:16px">
                  <div style="flex:1">
                    <div style="font-size:10px;color:#a78bfa;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;font-weight:600">Projected Savings</div>
                    <div style="display:flex;gap:8px;margin-bottom:10px">
                      ${projectedByQtr
                        .map(
                          (
                            v,
                            i,
                          ) => `<div style="flex:1;text-align:center;background:rgba(147,51,234,0.12);border-radius:6px;padding:6px 4px">
                        <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Q${i + 1}</div>
                        <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:#c084fc">${$c2(v)}</div>
                      </div>`,
                        )
                        .join('')}
                    </div>
                    <div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;font-weight:600">Actual Savings</div>
                    <div style="display:flex;gap:8px">
                      ${actualByQtr
                        .map(
                          (
                            v,
                            i,
                          ) => `<div style="flex:1;text-align:center;background:rgba(34,197,94,0.10);border-radius:6px;padding:6px 4px">
                        <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Q${i + 1}</div>
                        <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:${v >= 0 ? 'var(--green)' : 'var(--danger)'}">${v !== 0 ? (v >= 0 ? '' : '-') + $c2(v) : '—'}</div>
                      </div>`,
                        )
                        .join('')}
                    </div>
                  </div>
                  <div style="border-left:1px solid rgba(147,51,234,0.25);padding-left:16px;display:flex;flex-direction:column;justify-content:center;min-width:120px">
                    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Annual Projected</div>
                    <div style="font-size:20px;font-weight:800;font-family:var(--mono);color:#c084fc">${$c2(projectedAnnual)}<span style="font-size:12px;color:#a78bfa">/yr</span></div>
                  </div>
                </div>
              </div>
              <div style="flex:1;min-width:200px;display:flex;flex-direction:column;justify-content:center;gap:16px">
                <div>
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">${curQtrLabel} Total Savings</div>
                  <div style="font-size:28px;font-weight:800;font-family:var(--mono);color:${curQtrActual >= 0 ? 'var(--green)' : 'var(--danger)'};margin:4px 0">${curQtrActual >= 0 ? '' : '-'}${$c(curQtrActual)}</div>
                  <div style="font-size:12px;color:var(--text2)">${curQtrPct !== null ? '<span style="color:' + (curQtrActual >= 0 ? 'var(--green)' : 'var(--danger)') + ';font-weight:600">' + curQtrPct + '%</span> of ' + curQtrLabel + ' projected (' + $c2(curQtrProjected) + ')' : bldgs.length + ' building' + (bldgs.length !== 1 ? 's' : '') + ' · <span style="color:var(--text3)">' + (useNormalized ? 'Normalized' : 'Actual') + '</span>'}</div>
                </div>
                <div style="border-top:1px solid var(--border);padding-top:12px">
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Total Cumulative Savings</div>
                  <div style="font-size:28px;font-weight:800;font-family:var(--mono);color:${totalSav >= 0 ? 'var(--green)' : 'var(--danger)'};margin:4px 0">${totalSav >= 0 ? '' : '-'}${$c(totalSav)}</div>
                  <div style="font-size:12px;color:var(--text2)">${throughDate ? 'through ' + throughDate : bldgs.length + ' building' + (bldgs.length !== 1 ? 's' : '')} · <span style="color:var(--text3)">${useNormalized ? 'Normalized' : 'Actual'}</span></div>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:12px;justify-content:center">
                <div style="text-align:center"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Baseline</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$c(totalBl)}</div></div>
                <div style="text-align:center"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Current</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$c(totalCur)}</div></div>
                ${estSavings > 0 ? '<div style="text-align:center"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Target</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">$' + Number(estSavings).toLocaleString() + '</div></div>' : ''}
                ${ecmTotal > 0 ? '<div style="text-align:center;border-top:1px solid rgba(167,139,250,0.25);padding-top:8px;margin-top:4px"><div style="font-size:10px;color:#a78bfa;text-transform:uppercase">ECM Projected</div><div style="font-size:16px;font-weight:700;font-family:var(--mono);color:#c084fc">$' + ecmTotal.toLocaleString() + '/yr</div><div style="font-size:10px;color:var(--text3)">' + ecmCount + ' ECM' + (ecmCount !== 1 ? 's' : '') + ' saved — <button onclick="sv(\'calculators\')" style="font-size:10px;color:#a78bfa;background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">view</button></div></div>' : ''}
              </div>
            </div>
          </div>
          ${(function () {
            const _budgetKPI = typeof renderBudgetKPICard === 'function' ? renderBudgetKPICard(projId) : '';
            return _budgetKPI
              ? `<div class="card" style="margin-bottom:16px"><div style="padding:20px;display:flex;gap:16px;align-items:stretch;flex-wrap:wrap">${_budgetKPI}</div></div>`
              : '';
          })()}
          <div class="card">
            <div class="card-hdr"><span class="card-title">Building Performance</span></div>
            <div style="overflow:auto;max-height:60vh">
              ${(function () {
                // Sort state: default sqft descending (bug 839bea5c)
                if (!window._bpSort) window._bpSort = {};
                if (!window._bpSort[projId]) window._bpSort[projId] = { col: 'sqft', asc: false };
                const _srt = window._bpSort[projId];
                const _sortVal = (r, col) => {
                  if (col === 'name') return (r.name || '').toLowerCase();
                  if (col === 'sqft') return r.sqft || 0;
                  if (col === 'blCost') return r.blCost || 0;
                  if (col === 'blEUI') return r.blEUI || 0;
                  if (col === 'curCost') return r.curCost || 0;
                  if (col === 'curEUI') return r.curEUI || 0;
                  if (col === 'sav') return r.sav || 0;
                  if (col === 'savPct') return r.savPct || 0;
                  return 0;
                };
                const sortedRows = bldgRows.slice().sort((a, b) => {
                  const va = _sortVal(a, _srt.col),
                    vb = _sortVal(b, _srt.col);
                  if (va < vb) return _srt.asc ? -1 : 1;
                  if (va > vb) return _srt.asc ? 1 : -1;
                  return 0;
                });
                const _thSort = (col, label, align) => {
                  const active = _srt.col === col;
                  const arrow = active ? (_srt.asc ? ' ↑' : ' ↓') : ' ↕';
                  const style = `text-align:${align || 'right'};cursor:pointer;user-select:none;white-space:nowrap${active ? ';color:var(--em)' : ''}`;
                  return `<th style="${style}" onclick="if(!window._bpSort)window._bpSort={};if(!window._bpSort['${projId}'])window._bpSort['${projId}']={col:'sqft',asc:false};var s=window._bpSort['${projId}'];if(s.col==='${col}'){s.asc=!s.asc;}else{s.col='${col}';s.asc=true;}initDashboardTab(${projId})" title="Sort by ${label}">${label}${arrow}</th>`;
                };
                const _blLabel = bldgRows.some((r) => r.blLabel === 'Baseline') ? 'Baseline' : 'Total Cost';
                return `<table class="dtbl" style="width:100%;font-size:12px">
                <thead><tr><th style="width:30px">#</th>${_thSort('name', 'Building', 'left')}<th style="text-align:right;cursor:pointer;user-select:none;white-space:nowrap${_srt.col === 'sqft' ? ';color:var(--em)' : ''}" onclick="if(!window._bpSort)window._bpSort={};if(!window._bpSort['${projId}'])window._bpSort['${projId}']={col:'sqft',asc:false};var s=window._bpSort['${projId}'];if(s.col==='sqft'){s.asc=!s.asc;}else{s.col='sqft';s.asc=true;}initDashboardTab(${projId})" title="Sort by Sq Ft">Sq Ft${_srt.col === 'sqft' ? (_srt.asc ? ' ↑' : ' ↓') : ' ↕'}</th><th style="text-align:center">Baseline</th><th style="text-align:right">Baseline Period</th>${_thSort('blCost', _blLabel + ' $/yr', 'right')}${_thSort('blEUI', 'Baseline Site EUI', 'right')}${_thSort('curCost', 'Current Cost', 'right')}${_thSort('curEUI', 'Current Site EUI', 'right')}${_thSort('sav', 'Savings $', 'right')}${_thSort('savPct', '%', 'right')}<th style="text-align:center">Status</th></tr></thead>
                <tbody>${sortedRows
                  .map((r, _ri) => {
                    const blIcon = r.meterIncl > 0 ? (r.meterExcl > 0 ? '◐' : '●') : '○';
                    const blColor =
                      r.meterIncl > 0 ? (r.meterExcl > 0 ? 'var(--amber)' : 'var(--green)') : 'var(--text3)';
                    const blTip = r.meterDetails
                      .map(
                        (d) =>
                          d.name +
                          ' (' +
                          d.commodity +
                          '): ' +
                          (d.included ? (d.hasBaseline ? '✓ included' : '… no baseline') : '✗ excluded'),
                      )
                      .join('&#10;');
                    return `<tr>
                  <td style="font-family:var(--mono);font-size:10px;color:var(--text3);text-align:center">${_ri + 1}</td>
                  <td style="font-weight:600">${r.name || '—'}</td>
                  <td style="text-align:right;font-size:11px;color:var(--text2)">${r.sqft ? Number(r.sqft).toLocaleString() : '—'}</td>
                  <td style="text-align:center;cursor:help" title="${blTip}"><span style="color:${blColor};font-size:13px">${blIcon}</span> <span style="font-size:10px;color:var(--text2)">${r.meterIncl}/${r.meterTotal}</span></td>
                  <td style="text-align:right;font-size:11px;color:var(--text2)">${r.blPeriod || '—'}</td>
                  <td style="text-align:right;font-family:var(--mono)">${r.blCost > 0 ? $c(r.blCost) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);font-size:11px;color:var(--text2)">${r.blEUI > 0 ? r.blEUI.toFixed(1) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono)">${r.curCost > 0 ? $c(r.curCost) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);font-size:11px;color:var(--text2)">${r.curEUI > 0 ? r.curEUI.toFixed(1) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);color:${r.sav >= 0 ? 'var(--green)' : 'var(--danger)'}">${r.blCost > 0 ? (r.sav >= 0 ? '' : '-') + $c(r.sav) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono)">${r.blCost > 0 ? r.savPct.toFixed(1) + '%' : '—'}</td>
                  <td style="text-align:center;font-weight:600;color:${r.statusColor}">${r.status}</td>
                </tr>`;
                  })
                  .join('')}</tbody>
              </table>`;
              })()}
            </div>
          </div>`;

  if (typeof renderDashCalendar === 'function') renderDashCalendar(projId);
  // Waterfall chart removed from dashboard tab (2026-05-17); function definition kept for potential future use
  // const _ecmWfData = typeof getProjectEcmTotal === 'function' ? getProjectEcmTotal(projId) : null;
  // renderSavingsWaterfall(projId, totalBl, totalCur, totalSav, useNormalized, _ecmWfData);
}

// ── Savings Waterfall Chart ──
// ecmData: optional { total, count, ecms } from getProjectEcmTotal()
function renderSavingsWaterfall(projId, baseline, actual, savings, isNormalized, ecmData) {
  const canvas = document.getElementById('dash-waterfall-canvas-' + projId);
  if (!canvas || !baseline || baseline <= 0) return;

  // Destroy previous chart instance if it exists
  if (canvas._wfChart) {
    canvas._wfChart.destroy();
    canvas._wfChart = null;
  }

  const fmt$ = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
  const fmtPct = (n, base) => (base > 0 ? ((n / base) * 100).toFixed(1) + '%' : '');

  // Clamp actual cost — can't go below 0 or above baseline for chart purposes
  const actualCost = Math.max(0, actual > 0 ? actual : baseline - savings);
  const savingsAmt = baseline - actualCost;
  const savingsIncrease = savingsAmt < 0; // cost went up

  // Determine whether to use ECM-level breakdown or the single savings bar.
  // Use ECM breakdown when: there are saved ECMs AND they have non-zero savings.
  const ecmList = ecmData && ecmData.ecms && ecmData.ecms.length > 0 ? ecmData.ecms : null;
  const useEcmBars = ecmList !== null && !savingsIncrease;

  let labels, data, bgColors, borderColors;

  if (useEcmBars) {
    // Waterfall with individual ECM bars between Baseline and Actual:
    //   Baseline → ECM1 drop → ECM2 drop → … → Actual
    // Each ECM bar is a floating [base,top] segment descending from baseline.
    labels = ['Baseline'];
    data = [[0, baseline]];
    bgColors = ['rgba(74,158,255,0.85)'];
    borderColors = ['#4a9eff'];

    // ECM color palette (purple tones for projected savings)
    const ecmColors = [
      'rgba(167,139,250,0.85)',
      'rgba(196,132,252,0.85)',
      'rgba(139,92,246,0.85)',
      'rgba(217,70,239,0.85)',
      'rgba(236,72,153,0.85)',
    ];
    const ecmBorders = ['#a78bfa', '#c084fc', '#8b5cf6', '#d946ef', '#ec4899'];

    let runningTop = baseline;
    ecmList.forEach((ecm, i) => {
      const out = ecm.outputs || {};
      const sav = Math.max(
        0,
        parseFloat(
          out.annual_savings_dollars ||
            out.total_savings_dollar ||
            out.annual_cost_saved ||
            out.annual_savings_dollar ||
            0,
        ),
      );
      if (sav <= 0) return;
      const tmplName =
        (typeof ECM_TEMPLATES !== 'undefined' && ECM_TEMPLATES[ecm.templateId]
          ? ECM_TEMPLATES[ecm.templateId].name
          : ecm.templateId) + (ecm.buildingName ? ' (' + ecm.buildingName + ')' : '');
      labels.push(tmplName);
      const segBase = runningTop - sav;
      data.push([segBase, runningTop]);
      const ci = i % ecmColors.length;
      bgColors.push(ecmColors[ci]);
      borderColors.push(ecmBorders[ci]);
      runningTop = segBase;
    });

    // Actual bar
    labels.push('Actual');
    data.push([0, actualCost]);
    bgColors.push('rgba(74,158,255,0.85)');
    borderColors.push('#4a9eff');
  } else {
    // Standard 3-bar waterfall: Baseline | Savings/Increase | Actual
    labels = ['Baseline', savingsIncrease ? 'Cost Increase' : 'Energy Savings', 'Actual'];
    data = [[0, baseline], savingsIncrease ? [baseline, actualCost] : [actualCost, baseline], [0, actualCost]];
    bgColors = [
      'rgba(74,158,255,0.85)',
      savingsIncrease ? 'rgba(239,68,68,0.80)' : 'rgba(34,197,94,0.85)',
      'rgba(74,158,255,0.85)',
    ];
    borderColors = ['#4a9eff', savingsIncrease ? '#ef4444' : '#22c55e', '#4a9eff'];
  }

  const ctx = canvas.getContext('2d');
  canvas._wfChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Value',
          data,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 3,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 24, right: 12, bottom: 4, left: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const [base, top] = ctx.raw;
              const val = Math.abs(top - base);
              const idx = ctx.dataIndex;
              const lastIdx = data.length - 1;
              if (idx === 0) return 'Baseline Annual Cost: ' + fmt$(val);
              if (idx === lastIdx) return 'Actual Annual Cost: ' + fmt$(val);
              if (!useEcmBars) {
                const pct = fmtPct(val, baseline);
                return (savingsIncrease ? 'Cost Increase: +' : 'Savings: ') + fmt$(val) + (pct ? ' (' + pct + ')' : '');
              }
              // ECM bar
              const pct = fmtPct(val, baseline);
              return 'ECM Savings: -' + fmt$(val) + (pct ? ' (' + pct + ' of baseline)' : '');
            },
            title(ctx) {
              return ctx[0].label;
            },
          },
          backgroundColor: 'rgba(15,15,20,0.92)',
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 6,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: 'var(--text2)',
            font: { size: 11 },
            maxRotation: useEcmBars ? 30 : 0,
          },
          border: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          min: 0,
          max: Math.ceil(baseline * 1.05),
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: 'var(--text3)',
            font: { size: 10 },
            callback: (v) => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v),
            maxTicksLimit: 6,
          },
          border: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
    plugins: [
      {
        // Draw value labels above/on bars and connector lines
        id: 'waterfallLabels',
        afterDraw(chart) {
          const {
            ctx: c,
            scales: { y },
          } = chart;
          const meta = chart.getDatasetMeta(0);
          c.save();
          c.font = '600 11px var(--sans, system-ui)';
          c.textAlign = 'center';
          const lastIdx = data.length - 1;
          meta.data.forEach((bar, i) => {
            const [base, top] = data[i];
            const val = Math.abs(top - base);
            let label = '';
            if (i === 0) {
              label = fmt$(val);
            } else if (i === lastIdx) {
              label = fmt$(val);
            } else if (useEcmBars) {
              label = '-' + fmt$(val);
            } else {
              label = (savingsIncrease ? '+' : '-') + fmt$(val) + ' (' + fmtPct(val, baseline) + ')';
            }
            // Color: green for ECM savings bars, same logic as before for standard bars
            if (i === 0 || i === lastIdx) {
              c.fillStyle = '#e2e8f0';
            } else if (useEcmBars) {
              c.fillStyle = '#c084fc';
            } else {
              c.fillStyle = savingsIncrease ? '#ef4444' : '#22c55e';
            }
            const barTop = y.getPixelForValue(Math.max(base, top));
            c.fillText(label, bar.x, barTop - 6);
          });
          // Connector lines between bars
          c.strokeStyle = 'rgba(148,163,184,0.35)';
          c.lineWidth = 1;
          c.setLineDash([4, 3]);
          for (let i = 0; i < meta.data.length - 1; i++) {
            const curr = meta.data[i];
            const next = meta.data[i + 1];
            // Connect right edge of current bar to starting height of next bar
            const [cBase, cTop] = data[i];
            const connectY = y.getPixelForValue(Math.min(cBase, cTop));
            const x1 = curr.x + curr.width / 2;
            const x2 = next.x - next.width / 2;
            c.beginPath();
            c.moveTo(x1, connectY);
            c.lineTo(x2, connectY);
            c.stroke();
          }
          c.setLineDash([]);
          c.restore();
        },
      },
    ],
  });
}

// ── Dashboard Calendar ──
let _dashCalMonth = null;

function renderDashCalendar(projId) {
  const wrap = document.getElementById('dash-cal-inner-' + projId);
  if (!wrap) return;
  const p = projects.find((x) => x.id === projId);
  if (!p) {
    wrap.innerHTML = '';
    return;
  }
  const now = new Date();
  if (!_dashCalMonth) _dashCalMonth = { year: now.getFullYear(), month: now.getMonth() };
  const { year, month } = _dashCalMonth;
  const monthName = new Date(year, month).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  // Collect events for this month
  const events = [];
  (p.meetings || []).forEach((m) => {
    const d = new Date(m.date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      events.push({
        day: d.getDate(),
        label: (m.type === 'agenda' ? 'Agenda' : 'Minutes') + ': ' + (m.projectNickname || 'Meeting'),
        color: 'var(--accent)',
        type: 'meeting',
      });
    }
  });
  (p.recurringMeetings || [])
    .filter((r) => r.active)
    .forEach((r) => {
      if (typeof getNthWeekdayOfMonth === 'function') {
        const meetDate = getNthWeekdayOfMonth(year, month, r.nthWeek, r.weekday);
        if (meetDate) {
          const d = meetDate.getDate();
          if (!events.some((e) => e.day === d && e.type === 'meeting')) {
            events.push({
              day: d,
              label: 'Recurring: ' + (r.time || ''),
              color: 'var(--accent)',
              type: 'meeting',
            });
          }
        }
      }
    });
  (typeof tasks !== 'undefined' ? tasks : [])
    .filter((t) => t.projId === projId && t.due)
    .forEach((t) => {
      const d = new Date(t.due + 'T12:00:00');
      if (d.getFullYear() === year && d.getMonth() === month) {
        events.push({
          day: d.getDate(),
          label: t.text || 'Task',
          color: 'var(--amber)',
          type: 'task',
        });
      }
    });
  (p.districtCalendar || []).forEach((ev) => {
    const d = new Date(ev.date + 'T12:00:00');
    if (d.getFullYear() === year && d.getMonth() === month) {
      events.push({
        day: d.getDate(),
        label: ev.name,
        color: 'var(--teal)',
        type: 'district',
      });
    }
  });

  // Build calendar grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let cells = dayNames
    .map(
      (d) =>
        `<div style="text-align:center;font-size:10px;font-weight:700;color:var(--text3);padding:4px 0">${d}</div>`,
    )
    .join('');
  for (let i = 0; i < firstDay; i++) cells += '<div></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dayEvents = events.filter((e) => e.day === d);
    const isToday = d === now.getDate() && month === now.getMonth() && year === now.getFullYear();
    const dots = dayEvents
      .slice(0, 3)
      .map(
        (e) =>
          `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${e.color}"></span>`,
      )
      .join('');
    cells += `<div style="text-align:center;padding:4px 2px;cursor:${dayEvents.length ? 'pointer' : 'default'};border-radius:6px;${isToday ? 'background:var(--accent-dim);font-weight:700;color:var(--accent)' : ''}" onclick="dashCalShowDay(${projId},${year},${month},${d})">
            <div style="font-size:12px">${d}</div>
            ${dots ? `<div style="display:flex;gap:2px;justify-content:center;margin-top:1px">${dots}</div>` : ''}
          </div>`;
  }

  wrap.innerHTML = `<div class="card">
          <div class="card-hdr" style="justify-content:space-between">
            <button class="btn btn-ghost btn-sm" onclick="dashCalNav(${projId},-1)">◀</button>
            <span class="card-title" style="font-size:13px">${monthName}</span>
            <button class="btn btn-ghost btn-sm" onclick="dashCalNav(${projId},1)">▶</button>
          </div>
          <div style="padding:8px 12px;display:grid;grid-template-columns:repeat(7,1fr);gap:2px">${cells}</div>
          <div id="dash-cal-detail-${projId}" style="padding:0 12px 12px;font-size:12px"></div>
        </div>`;
}

function dashCalNav(projId, dir) {
  if (!_dashCalMonth)
    _dashCalMonth = {
      year: new Date().getFullYear(),
      month: new Date().getMonth(),
    };
  _dashCalMonth.month += dir;
  if (_dashCalMonth.month > 11) {
    _dashCalMonth.month = 0;
    _dashCalMonth.year++;
  }
  if (_dashCalMonth.month < 0) {
    _dashCalMonth.month = 11;
    _dashCalMonth.year--;
  }
  renderDashCalendar(projId);
}

function dashCalShowDay(projId, year, month, day) {
  const wrap = document.getElementById('dash-cal-detail-' + projId);
  if (!wrap) return;
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const events = [];
  (p.meetings || []).forEach((m) => {
    const d = new Date(m.date);
    if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day)
      events.push({
        label: (m.type === 'agenda' ? '📋 Agenda' : '📝 Minutes') + ': ' + (m.projectNickname || 'Meeting'),
        color: 'var(--accent)',
      });
  });
  (p.recurringMeetings || [])
    .filter((r) => r.active)
    .forEach((r) => {
      if (typeof getNthWeekdayOfMonth === 'function') {
        const meetDate = getNthWeekdayOfMonth(year, month, r.nthWeek, r.weekday);
        if (meetDate && meetDate.getDate() === day)
          events.push({
            label: '🔄 Recurring meeting ' + (r.time || ''),
            color: 'var(--accent)',
          });
      }
    });
  (typeof tasks !== 'undefined' ? tasks : [])
    .filter((t) => t.projId === projId && t.due)
    .forEach((t) => {
      const d = new Date(t.due + 'T12:00:00');
      if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day)
        events.push({ label: '✅ ' + t.text, color: 'var(--amber)' });
    });
  (p.districtCalendar || []).forEach((ev) => {
    const d = new Date(ev.date + 'T12:00:00');
    if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day)
      events.push({ label: '🗓️ ' + ev.name, color: 'var(--teal)' });
  });
  if (!events.length) {
    wrap.innerHTML = '';
    return;
  }
  const dateStr = new Date(year, month, day).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  wrap.innerHTML = `<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:4px">${dateStr}</div>
          ${events.map((e) => `<div style="padding:3px 0;color:var(--text2)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${e.color};margin-right:6px"></span>${e.label}</div>`).join('')}
        </div>`;
}

function calcAutoProgress(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.start || !p.end) return 0;
  const start = new Date(p.start + 'T00:00:00');
  const end = new Date(p.end + 'T00:00:00');
  const now = new Date();
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  if (now >= end) return 100;
  if (now <= start) return 0;
  return Math.round(((now - start) / (end - start)) * 100);
}
function updateProg(id, val) {
  const p = projects.find((p) => p.id === id);
  if (!p) return;
  const auto = calcAutoProgress(id);
  const n = Math.max(auto, Math.max(0, Math.min(100, parseInt(val) || 0)));
  p.progress = n;
  const f = document.getElementById('hpf');
  if (f) f.style.width = n + '%';
  const inp = document.querySelector('.pd-prog-input');
  if (inp && parseInt(inp.value) !== n) inp.value = n;
  sset('en_projects', projects);
  renderProjTable();
}
/* ── COMMODITY TYPES ── */
const ALL_COMMODITIES = ['Electric', 'Gas', 'Water', 'Steam', 'Sewer', 'Stormwater', 'Propane'];

function isShownCommodity(projectId, commodity) {
  const p = projects.find((x) => x.id === projectId);
  if (!p || !Array.isArray(p.shownCommodities)) return true;
  return p.shownCommodities.includes(commodity);
}

function isCalcCommodity(projectId, commodity) {
  const p = projects.find((x) => x.id === projectId);
  if (!p || !Array.isArray(p.calcCommodities)) return true;
  return p.calcCommodities.includes(commodity);
}

/* ── PROJECT TAB ORDER (draggable) ── */
// Fix 35571527: notes, tasks merged into Dashboard; savedbills merged into Utility Data.
// These IDs are retained in PROJ_TABS_DEFAULT for backward compat (stored tab orders)
// but hidden from the visible bar — their content now appears in the merged tabs.
const PROJ_TABS_HIDDEN = new Set(['notes', 'tasks', 'savedbills']);
const PROJ_TABS_DEFAULT = [
  { id: 'dashboard', label: '📊 Dashboard' },
  { id: 'contacts', label: '👥 Contacts' },
  { id: 'utility', label: '⚡ Utility Data' },
  { id: 'savedbills', label: '🗄️ Saved Bills' },
  { id: 'eq-matrix', label: '⚙️ Equipment Matrix' },
  { id: 'bas-trends', label: '📉 BAS Trends' },
  { id: 'hvacload', label: '🌡️ HVAC Load Est' },
  { id: 'energygfx', label: '📈 Energy Graphics' },
  { id: 'savings', label: '💡 Energy Savings' },
  { id: 'budget', label: '💰 Budget' },
  { id: 'hours', label: '⏱️ Hours' },
  { id: 'district', label: '🗓️ District Calendar' },
  { id: 'docs', label: '📁 Documents' },
  { id: 'setpoints', label: '🌡️ Set Points' },
  { id: 'settings', label: '⚙️ Project Settings' },
  // Backward-compat: merged tabs — retained so stored orders stay valid
  { id: 'notes', label: '📝 Notes' },
  { id: 'tasks', label: '✅ Tasks' },
  { id: 'equipment', label: '⚙️ Equipment' },
];
function _getProjTabOrder() {
  try {
    const o = JSON.parse(localStorage.getItem('ch_projTabOrder'));
    if (Array.isArray(o)) {
      const valid = new Set(PROJ_TABS_DEFAULT.map((t) => t.id));
      const filtered = o.filter((id) => valid.has(id));
      if (filtered.length) {
        // Append any tabs from PROJ_TABS_DEFAULT that are missing from the stored order.
        // This ensures new tabs (e.g. "budget") automatically appear for projects
        // that were created before the tab was added.
        const storedSet = new Set(filtered);
        const missing = PROJ_TABS_DEFAULT.map((t) => t.id).filter((id) => !storedSet.has(id));
        return filtered.concat(missing);
      }
    }
  } catch (e) {}
  return PROJ_TABS_DEFAULT.map((t) => t.id);
}
function _saveProjTabOrder(order) {
  localStorage.setItem('ch_projTabOrder', JSON.stringify(order));
}
function _getProjTabHTML() {
  const order = _getProjTabOrder();
  const activeTab = window._activeProjTab || 'dashboard';
  return order
    .map((id) => {
      // Fix 35571527: hide merged tabs from the tab bar
      if (PROJ_TABS_HIDDEN.has(id)) return '';
      const t = PROJ_TABS_DEFAULT.find((x) => x.id === id);
      if (!t) return '';
      return `<button class="pdt${id === activeTab ? ' active' : ''}" draggable="true" data-tab="${id}" onclick="sPTab('${id}',this)">${t.label}</button>`;
    })
    .join('');
}
function _initTabDrag() {
  const bar = document.getElementById('pdTabBar');
  if (!bar) return;
  let dragId = null;
  bar.addEventListener('dragstart', (e) => {
    const btn = e.target.closest('.pdt');
    if (!btn) return;
    dragId = btn.dataset.tab;
    btn.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  bar.addEventListener('dragend', (e) => {
    const btn = e.target.closest('.pdt');
    if (btn) btn.classList.remove('dragging');
    bar.querySelectorAll('.pdt').forEach((b) => b.classList.remove('drag-over'));
    dragId = null;
  });
  bar.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const btn = e.target.closest('.pdt');
    bar.querySelectorAll('.pdt').forEach((b) => b.classList.remove('drag-over'));
    if (btn && btn.dataset.tab !== dragId) btn.classList.add('drag-over');
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const btn = e.target.closest('.pdt');
    if (!btn || !dragId) return;
    const dropId = btn.dataset.tab;
    if (dropId === dragId) return;
    const order = _getProjTabOrder();
    const fromIdx = order.indexOf(dragId),
      toIdx = order.indexOf(dropId);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, dragId);
    _saveProjTabOrder(order);
    bar.innerHTML = _getProjTabHTML();
  });
}

// ── Project-level panel toggle for Projects page header ──
let _pdProjPanel = {}; // projId -> 'baseline'|'savproj'|'perf'|null
function toggleProjDetailPanel(projId, panelKey) {
  const cur = _pdProjPanel[projId];
  _pdProjPanel[projId] = cur === panelKey ? null : panelKey;
  // Update button highlight states
  ['baseline', 'savproj', 'perf'].forEach((k) => {
    const btn = document.getElementById('pd-proj-' + k + '-btn-' + projId);
    if (btn) {
      btn.style.borderColor = _pdProjPanel[projId] === k ? 'var(--em)' : '';
      btn.style.color = _pdProjPanel[projId] === k ? 'var(--em)' : '';
    }
  });
  const content = document.getElementById('pd-proj-panel-content-' + projId);
  const tabsCard = document.getElementById('pd-tabs-card-' + projId);
  if (!content) return;
  if (!_pdProjPanel[projId]) {
    content.style.display = 'none';
    content.innerHTML = '';
    // Restore tab content visibility when panel closes
    if (tabsCard) tabsCard.style.display = '';
    return;
  }
  // Hide tab content when project panel is open
  if (tabsCard) tabsCard.style.display = 'none';
  content.style.display = 'block';
  content.style.maxHeight = 'none';
  content.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text2)">Aggregating project data...</div>';
  // Reuse the same rendering logic as Utility Data page project panels
  const savedProjId = udSelProjId;
  const savedPanel = _udProjPanel;
  udSelProjId = projId;
  _udProjPanel = _pdProjPanel[projId];
  renderUDProjAggPanel(content);
  udSelProjId = savedProjId;
  _udProjPanel = savedPanel;
}

const FULLWIN_TABS = ['savings', 'hvacload', 'utility', 'energygfx'];
function sPTab(tab, el) {
  document.querySelectorAll('.ptab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.pdt').forEach((b) => b.classList.remove('active'));
  document.getElementById('ptab-' + tab).classList.add('active');
  el?.classList.add('active');
  // Close any open project-level or building-level panels when switching tabs
  if (window._activeProjId) {
    if (_pdProjPanel[window._activeProjId])
      toggleProjDetailPanel(window._activeProjId, _pdProjPanel[window._activeProjId]);
    if (projUDSelPanel[window._activeProjId]) {
      projUDSelPanel[window._activeProjId] = null;
      const bldgId = projUDSelBldg[window._activeProjId];
      if (bldgId) renderProjUDBody(window._activeProjId, bldgId);
    }
  }
  // Always use compact header — full hero is hidden on all tabs
  const hero = document.querySelector('.pd-hero');
  const compact = document.getElementById('pd-hero-compact');
  if (hero) hero.style.display = 'none';
  if (compact) compact.style.display = 'flex';
  const p = projects.find((x) => x.id === window._activeProjId);
  if (!p) return;
  if (tab === 'dashboard') initDashboardTab(p.id);
  if (tab === 'utility') initProjUDTab(p.id);
  if (tab === 'savedbills') renderProjSavedBills(p.id);
  if (tab === 'budget') initBudgetTab(p.id);
  if (tab === 'hours') initHoursTab(p.id);
  if (tab === 'equipment') renderProjEquip(p.id);
  if (tab === 'savings') initSavingsTab(p.id);
  if (tab === 'hvacload') requestAnimationFrame(() => initHvacLoadTab(p.id));
  if (tab === 'energygfx') egfxRefresh(p.id);
  if (tab === 'docs') renderDocsSubTab(window._docsSubTab || 'meetings', p.id);
  if (tab === 'district') renderDistCalTable(p.id);
  if (tab === 'setpoints') renderSetpointsTab(p.id);
  if (tab === 'eq-matrix' && typeof initEquipMatrix === 'function') initEquipMatrix(p.id);
  window._activeProjTab = tab;
  saveProjSession();
}

function toggleProjCommodityShown(projId, commodity, checked) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  if (!Array.isArray(p.shownCommodities)) p.shownCommodities = [...ALL_COMMODITIES];
  if (checked) {
    if (!p.shownCommodities.includes(commodity)) p.shownCommodities.push(commodity);
  } else {
    p.shownCommodities = p.shownCommodities.filter((c) => c !== commodity);
  }
  sset('en_projects', projects);
  showToast(commodity + ' visibility ' + (checked ? 'on' : 'off') + ' ✓');
}

function toggleProjCommodityCalc(projId, commodity, checked) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  if (!Array.isArray(p.calcCommodities)) p.calcCommodities = [...ALL_COMMODITIES];
  if (checked) {
    if (!p.calcCommodities.includes(commodity)) p.calcCommodities.push(commodity);
  } else {
    p.calcCommodities = p.calcCommodities.filter((c) => c !== commodity);
  }
  sset('en_projects', projects);
  showToast(commodity + ' calculations ' + (checked ? 'included' : 'excluded') + ' ✓');
}

function updateProjPerfSetting(projId, field, value) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p[field] = value;
  sset('en_projects', projects);
  if (field === 'escalation' || field === 'cscCompensation') {
    const ud = utilityData[projId];
    if (ud) {
      for (const b of ud.buildings || []) {
        const bpKey = 'bldgperf_cfg_' + (b.id || b.name);
        const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
        try {
          const bpCfg = JSON.parse(localStorage.getItem(bpKey) || '{}');
          if (!bpCfg._customEsc && field === 'escalation') {
            bpCfg.escPct = value;
            localStorage.setItem(bpKey, JSON.stringify(bpCfg));
          }
          if (!bpCfg._customCsc && field === 'cscCompensation') {
            bpCfg.cscPct = value;
            localStorage.setItem(bpKey, JSON.stringify(bpCfg));
          }
        } catch (e) {}
        try {
          const bspCfg = JSON.parse(localStorage.getItem(bspKey) || '{}');
          if (!bspCfg._customEsc && field === 'escalation') {
            bspCfg.escPct = value;
            localStorage.setItem(bspKey, JSON.stringify(bspCfg));
          }
          if (!bspCfg._customCsc && field === 'cscCompensation') {
            bspCfg.cscPct = value;
            localStorage.setItem(bspKey, JSON.stringify(bspCfg));
          }
        } catch (e) {}
      }
    }
  }
  showToast(
    field === 'cscCompensation'
      ? 'CSC Compensation'
      : field === 'escalation'
        ? 'Utility Escalation'
        : 'Contract Years' + ' updated ✓',
  );
}

// ── Embedded Project Utility Data tab ──
// projUDSelBldg tracks which building is selected per project
const projUDSelBldg = {};
const projUDSelPanel = {}; // 'baseline'|'savproj'|'perf'|'scorecard'|null

function initProjUDTab(projId) {
  renderProjUDBldgNav(projId);
  // Auto-select first building
  const proj = utilityData[projId];
  const bldgs = proj?.buildings || [];
  if (bldgs.length && !projUDSelBldg[projId]) {
    projUDSelectBldg(projId, bldgs[0].id);
  } else if (projUDSelBldg[projId]) {
    projUDSelectBldg(projId, projUDSelBldg[projId]);
  } else {
    // No buildings yet
    const body = document.getElementById('proj-ud-body-' + projId);
    if (body)
      body.innerHTML =
        '<div class="ud-empty"><div class="ud-empty-ico">🏢</div><div>No buildings yet.<br><button class="btn btn-em btn-sm" style="margin-top:10px" onclick="openBldgModalForProj(' +
        projId +
        ')">+ Add Building</button></div></div>';
  }
}

function renderProjUDBldgNav(projId) {
  const nav = document.getElementById('proj-ud-bldg-nav-' + projId);
  if (!nav) return;
  const proj = utilityData[projId];
  const bldgs = proj?.buildings || [];
  if (!bldgs.length) {
    nav.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:var(--text3)">No buildings yet.</div>';
    return;
  }
  nav.innerHTML = bldgs
    .map((b) => {
      const allMeters = b.meters || [];
      const totalMCount = allMeters.length;
      const blMeters = allMeters.filter((m) => m.baselineInclude !== false);
      const blMCount = blMeters.length;
      const mWithBl = blMeters.filter(
        (m) => m.baseline && Array.isArray(m.baseline.months) && m.baseline.months.length,
      ).length;
      const blBadge =
        blMCount > 0
          ? mWithBl === blMCount
            ? `<span style="color:var(--green);font-size:10px" title="All baseline meters have baselines set">✓ ${mWithBl}/${blMCount} BL</span>`
            : mWithBl > 0
              ? `<span style="color:var(--amber);font-size:10px" title="${mWithBl} of ${blMCount} baseline meters have baselines set">⚠ ${mWithBl}/${blMCount} BL</span>`
              : `<span style="color:var(--text3);font-size:10px" title="No baselines set">— 0/${blMCount} BL</span>`
          : '';
      const bCount = (b.bills || []).length + allMeters.reduce((s, m) => s + (m.bills || []).length, 0);
      const isActive = projUDSelBldg[projId] === b.id;
      return `<div class="ud-nav-bldg-item${isActive ? ' active' : ''}" onclick="projUDSelectBldg('${projId}','${b.id}')">
            <span style="font-size:14px">${getFacilityIcon?.(b.type) || '🏢'}</span>
            <div style="flex:1;min-width:0">
              <div class="ud-nav-bldg-name">${b.name || 'Building'}</div>
              <div class="ud-nav-bldg-meta">${totalMCount} meter${totalMCount !== 1 ? 's' : ''} ${blBadge}</div>
            </div>
            <div class="ud-nav-bldg-actions">
              <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:11px" onclick="event.stopPropagation();openBldgModalForProj('${projId}','${b.id}')" title="Edit">✏️</button>
            </div>
          </div>`;
    })
    .join('');
}

function projUDSelectBldg(projId, bldgId) {
  projUDSelBldg[projId] = bldgId;
  renderProjUDBldgNav(projId);
  // Show header
  const hdr = document.getElementById('proj-ud-detail-hdr-' + projId);
  const proj = utilityData[projId];
  if (!proj) return;
  const b = (proj.buildings || []).find((x) => x.id === bldgId);
  if (!b) return;
  if (hdr) {
    hdr.style.display = 'flex';
    const title = document.getElementById('proj-ud-hdr-title-' + projId);
    const sub = document.getElementById('proj-ud-hdr-sub-' + projId);
    if (title) title.textContent = b.name || 'Building';
    if (sub) {
      const meters = b.meters || [];
      const sqft = b.sqft ? Number(b.sqft).toLocaleString() + ' sf · ' : '';
      sub.textContent =
        sqft +
        meters.length +
        ' meter' +
        (meters.length !== 1 ? 's' : '') +
        ' · ' +
        meters.reduce((s, m) => s + (m.bills || []).length, 0) +
        ' bills';
    }
  }
  // Render meter detail in body
  renderProjUDBody(projId, bldgId);
}

function renderProjUDBody(projId, bldgId) {
  const body = document.getElementById('proj-ud-body-' + projId);
  if (!body) return;
  const proj = utilityData[projId];
  if (!proj) return;
  const b = (proj.buildings || []).find((x) => x.id === bldgId);
  if (!b) {
    body.innerHTML = '<div class="ud-empty"><div class="ud-empty-ico">🏢</div><div>Building not found</div></div>';
    return;
  }

  // If a panel is toggled open, show it INSTEAD of the meters (hide utility data below)
  const panel = projUDSelPanel[projId];
  if (panel) {
    body.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 16px 0;flex-shrink:0"><button class="btn btn-ghost btn-sm" onclick="toggleProjUDPanel('${projId}','${panel}')">← Back to Meters</button></div><div id="proj-ud-panel-${projId}" style="flex:1;overflow-y:auto"></div>`;
    requestAnimationFrame(() => {
      const pEl = document.getElementById('proj-ud-panel-' + projId);
      if (!pEl) return;
      const pane = document.createElement('div');
      pane.style.padding = '16px';
      const prevProj = udSelProjId,
        prevBldg = udSelBldgId;
      udSelProjId = projId;
      udSelBldgId = bldgId;
      if (panel === 'baseline') renderBuildingStatsPane(pane, b);
      if (panel === 'savproj') renderBldgSavProjPane(pane, b);
      if (panel === 'perf') renderBldgPerfPane(pane, b);
      if (panel === 'scorecard') renderBuildingScorecardPane(pane, b, projId);
      // Append to DOM first so recalc can find elements via getElementById
      pEl.appendChild(pane);
      // Re-trigger calculation now that elements are in the document
      if (panel === 'perf') bpRecalc();
      if (panel === 'savproj') bspRecalc();
      udSelProjId = prevProj;
      udSelBldgId = prevBldg;
    });
    return;
  }

  // Render meters list (same style as udDetailWrap)
  const meters = b.meters || [];
  if (!meters.length) {
    body.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">⚡</div><div>No meters yet.<br><button class="btn btn-em btn-sm" style="margin-top:10px" onclick="projUDOpenMeterModal(\'' +
      projId +
      '\')">+ Add Meter</button></div></div>';
  } else {
    // Reuse renderUDDetail logic: temporarily set global selection
    const prevProj = udSelProjId,
      prevBldg = udSelBldgId;
    udSelProjId = projId;
    udSelBldgId = bldgId;
    const tempDiv = document.createElement('div');
    renderUDDetail(tempDiv);
    udSelProjId = prevProj;
    udSelBldgId = prevBldg;
    body.innerHTML = '';
    // Move rendered content into the proj-ud-body so meter clicks resolve to this container
    while (tempDiv.firstChild) body.appendChild(tempDiv.firstChild);
    // _udActiveWrap will be re-resolved by _resolveEmbedContext on each meter/tab click
  }
}

function toggleProjUDPanel(projId, panelKey) {
  projUDSelPanel[projId] = projUDSelPanel[projId] === panelKey ? null : panelKey;
  const bldgId = projUDSelBldg[projId];
  if (bldgId) renderProjUDBody(projId, bldgId);
}

function projUDOpenMeterModal(projId) {
  const bldgId = projUDSelBldg[projId];
  openMeterModal(null, projId, bldgId);
}

// ── Project Equipment Tab ──
function renderProjEquip(projId) {
  const el = document.getElementById('ptab-equipment-body-' + projId);
  if (!el) return;
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const q = (document.getElementById('equipQ-proj-' + projId)?.value || '').toLowerCase();
  const rows = equipment.filter((e) => {
    const matchProj =
      e.projId === projId || (e.loc || '').toLowerCase().includes((p.name || '').toLowerCase().slice(0, 15));
    const matchQ = !q || [e.tag, e.type, e.make, e.model, e.loc || ''].some((f) => f.toLowerCase().includes(q));
    return matchProj && matchQ;
  });
  if (!rows.length) {
    el.innerHTML =
      '<div style="font-size:13px;color:var(--text2);padding:12px 0">No equipment linked to this project yet. <button class="btn btn-ghost btn-sm" onclick="openEquipModal()">+ Add Equipment</button></div>';
    return;
  }
  el.innerHTML = `<div class="card"><div style="overflow-x:auto">
          <table class="dtbl" style="min-width:700px">
            <thead><tr><th>Tag</th><th>Type</th><th>Make / Model</th><th>Capacity</th><th>Efficiency</th><th>Location</th><th>Notes</th><th></th></tr></thead>
            <tbody>${rows
              .map(
                (e) => `<tr>
              <td><span class="eq-tag">${e.tag}</span></td>
              <td style="font-size:12px;color:var(--text2)">${e.type}</td>
              <td><strong>${e.make}</strong> <span style="color:var(--text2)">${e.model}</span></td>
              <td style="font-family:var(--mono);font-size:12px">${e.cap || '—'}</td>
              <td style="font-family:var(--mono);font-size:12px">${e.eff || '—'}</td>
              <td style="font-size:12px;color:var(--text2)">${e.loc || '—'}</td>
              <td style="font-size:12px;color:var(--text2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.notes || '—'}</td>
              <td><button class="btn-del" onclick="removeEquip(${e.id})">✕</button></td>
            </tr>`,
              )
              .join('')}</tbody>
          </table>
        </div></div>`;
}

// ── #131: Saved Bills tab per project ──
// Sort state for #142: {projId: {col, dir}} where dir is 'asc'|'desc'
const _sbSortState = {};

function _sbSortBills(bills, col, dir) {
  const cmp = (a, b) => {
    let av, bv;
    if (col === 'period') {
      av = a.BillingPeriodStart || a.start || '';
      bv = b.BillingPeriodStart || b.start || '';
    } else if (col === 'commodity') {
      av = (a.Commodity || a.commodity || '').toLowerCase();
      bv = (b.Commodity || b.commodity || '').toLowerCase();
    } else if (col === 'provider') {
      av = (a.UtilityCompany || a.utilityCompany || '').toLowerCase();
      bv = (b.UtilityCompany || b.utilityCompany || '').toLowerCase();
    } else if (col === 'account') {
      av = (a.AccountNumber || a.accountNumber || '').toLowerCase();
      bv = (b.AccountNumber || b.accountNumber || '').toLowerCase();
    } else if (col === 'meter') {
      av = a.projId ? '1' : '0';
      bv = b.projId ? '1' : '0';
    } else {
      return 0;
    }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  };
  return [...bills].sort(cmp);
}

function _sbSortClick(projId, col) {
  const cur = _sbSortState[projId] || { col: null, dir: 'asc' };
  if (cur.col === col) {
    _sbSortState[projId] = { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    _sbSortState[projId] = { col, dir: 'asc' };
  }
  renderProjSavedBills(projId);
}

function toggleSavedBillsPanel(projId) {
  const panel = document.getElementById('ptab-savedbills-panel-' + projId);
  const btn = document.getElementById('saved-bills-btn-' + projId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
  } else {
    panel.style.display = 'block';
    if (btn) btn.classList.add('active');
    renderProjSavedBills(projId);
    // Close panel when clicking outside
    setTimeout(() => {
      const handler = (e) => {
        if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          panel.style.display = 'none';
          if (btn) btn.classList.remove('active');
          document.removeEventListener('mousedown', handler, true);
        }
      };
      document.addEventListener('mousedown', handler, true);
    }, 0);
  }
}

function renderProjSavedBills(projId) {
  const el = document.getElementById('ptab-savedbills-body-' + projId);
  if (!el) return;
  const proj = projects.find((x) => x.id === projId);
  if (!proj) return;

  // Load all saved (unassigned) bills from en_pdf_bills
  const allBills = sget('en_pdf_bills', []) || [];
  // Show bills that are either unassigned OR already associated with this project
  let bills = allBills.filter((b) => !b.projId || b.projId === projId);

  if (!bills.length) {
    el.innerHTML =
      '<div style="font-size:13px;color:var(--text2);padding:20px 0">No saved PDF bills found. Extract bills using the PDF/OCR page and save them first.</div>';
    return;
  }

  // Apply sort (#142)
  const sortSt = _sbSortState[projId] || { col: 'period', dir: 'desc' };
  bills = _sbSortBills(bills, sortSt.col, sortSt.dir);

  // Build building + meter options for the assign dropdowns
  const projUD = utilityData[projId];
  const buildings = projUD?.buildings || [];
  const bldgOptions = buildings.map((b) => `<option value="${b.id}">${b.name || 'Building'}</option>`).join('');

  const getMeterOptions = (bldgId) => {
    const b = buildings.find((x) => x.id === bldgId);
    if (!b) return '';
    return (b.meters || [])
      .map(
        (m) =>
          `<option value="${m.id}">${m.provider || m.commodity || 'Meter'} ${m.account ? '· ' + m.account : ''}</option>`,
      )
      .join('');
  };

  const unassignedCount = bills.filter((b) => !b.projId).length;

  const rows = bills
    .map((b) => {
      const commodity = b.Commodity || b.commodity || '—';
      const provider = b.UtilityCompany || b.utilityCompany || '—';
      const acct = b.AccountNumber || b.accountNumber || '';
      const start = b.BillingPeriodStart || b.start || '';
      const end = b.BillingPeriodEnd || b.end || '';
      const total = b.TotalCurrentCharges || b.totalCost || '';
      const saved = b.savedAt
        ? new Date(b.savedAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          }) +
          ' ' +
          new Date(b.savedAt).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          })
        : '';
      const isAssigned = !!b.projId;

      // Smart-match: find the best building+meter for this bill by commodity+account
      const billComm = (commodity || '').toLowerCase();
      const billAcct = (acct || '').replace(/[\s\-]/g, '').toLowerCase();
      let bestBldgId = buildings[0]?.id || '';
      let bestMeterId = '';
      for (const bld of buildings) {
        for (const mt of bld.meters || []) {
          const mc = (mt.commodity || '').toLowerCase();
          const ma = (mt.account || '').replace(/[\s\-]/g, '').toLowerCase();
          if (billAcct && ma && billAcct === ma) {
            bestBldgId = bld.id;
            bestMeterId = mt.id;
            break;
          }
          if (billComm && mc && billComm === mc && !bestMeterId) {
            bestBldgId = bld.id;
            bestMeterId = mt.id;
          }
        }
        if (
          bestMeterId &&
          billAcct &&
          (buildings.find((x) => x.id === bestBldgId)?.meters || []).some(
            (m) => (m.account || '').replace(/[\s\-]/g, '').toLowerCase() === billAcct,
          )
        )
          break;
      }
      const bldgOpts = buildings
        .map(
          (bl) =>
            `<option value="${bl.id}"${bl.id === bestBldgId ? ' selected' : ''}>${bl.name || 'Building'}</option>`,
        )
        .join('');
      const meterOpts = (buildings.find((x) => x.id === bestBldgId)?.meters || [])
        .map(
          (m) =>
            `<option value="${m.id}"${m.id === bestMeterId ? ' selected' : ''}>${m.provider || m.commodity || 'Meter'} ${m.account ? '· ' + m.account : ''}</option>`,
        )
        .join('');

      return `<tr style="font-size:11px">
            <td style="padding:3px 6px">${commodity}</td>
            <td style="padding:3px 6px;color:var(--text2)">${provider}</td>
            <td style="padding:3px 6px;font-family:var(--mono);font-size:10px">${acct || '—'}</td>
            <td style="padding:3px 6px;font-family:var(--mono);font-size:10px">${start ? start + ' → ' + end : '—'}</td>
            <td style="padding:3px 6px;font-family:var(--mono)">${total ? '$' + parseFloat(String(total).replace(/,/g, '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
            <td style="padding:3px 6px;color:var(--text3)">${saved}</td>
            <td style="padding:3px 6px">
              ${
                isAssigned
                  ? `<span style="color:var(--green);font-size:10px">✓ Assigned</span>`
                  : buildings.length === 0
                    ? `<span style="color:var(--text3);font-size:10px">No buildings</span>`
                    : `<div style="display:flex;gap:3px;align-items:center;flex-wrap:nowrap">
                      <select class="fi" id="sb-bldg-${b.id}" style="padding:1px 3px;font-size:10px;height:22px"
                        onchange="(function(s){var mo=document.getElementById('sb-meter-${b.id}');if(mo){var pid=${JSON.stringify(projId)};var bid=s.value;var ud=utilityData[pid];var bld=(ud?.buildings||[]).find(function(x){return x.id===bid});mo.innerHTML=(bld?.meters||[]).map(function(m){return '<option value=\"'+m.id+'\">'+(m.provider||m.commodity||'Meter')+(m.account?' · '+m.account:'')+'</option>'}).join('')}})(this)">${bldgOpts}</select>
                      <select class="fi" id="sb-meter-${b.id}" style="padding:1px 3px;font-size:10px;height:22px">${meterOpts}</select>
                      <button class="btn btn-em btn-sm" style="font-size:10px;padding:1px 6px" onclick="assignSavedBillFromProj('${b.id}',${JSON.stringify(projId)})">Assign</button>
                    </div>`
              }
            </td>
            <td style="padding:3px 4px;text-align:center">${!isAssigned ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:1px 4px;color:var(--red);border-color:var(--red)" onclick="deleteSavedBillFromProj('${b.id}',${JSON.stringify(projId)})" title="Delete this bill">✕</button>` : ''}</td>
          </tr>`;
    })
    .join('');

  // Sort arrow helper
  const arrow = (col) => {
    if (sortSt.col !== col) return '<span style="opacity:.3;font-size:9px">⇅</span>';
    return sortSt.dir === 'asc' ? '<span style="font-size:9px">▲</span>' : '<span style="font-size:9px">▼</span>';
  };
  const thStyle = 'cursor:pointer;user-select:none;white-space:nowrap';

  el.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="font-size:13px;font-weight:600">${bills.length} saved bill${bills.length !== 1 ? 's' : ''}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${unassignedCount > 0 ? `<button class="btn btn-ghost btn-sm" onclick="autoAssignAllSavedBills(${JSON.stringify(projId)})">⚡ Auto-Assign All (${unassignedCount})</button>` : ''}
              <button class="btn btn-ghost btn-sm" onclick="sv('view-pdf');showToast('Go to PDF/OCR page to extract new bills')">+ Extract PDF Bill</button>
              ${unassignedCount > 0 ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteAllSavedBills(${JSON.stringify(projId)})">🗑️ Delete All (${unassignedCount})</button>` : ''}
            </div>
          </div>
          <div class="card" style="overflow-x:auto">
            <table class="dtbl" style="min-width:700px">
              <thead>
                <tr>
                  <th style="${thStyle}" onclick="_sbSortClick(${JSON.stringify(projId)},'commodity')">Commodity ${arrow('commodity')}</th>
                  <th style="${thStyle}" onclick="_sbSortClick(${JSON.stringify(projId)},'provider')">Provider ${arrow('provider')}</th>
                  <th style="${thStyle}" onclick="_sbSortClick(${JSON.stringify(projId)},'account')">Account ${arrow('account')}</th>
                  <th style="${thStyle}" onclick="_sbSortClick(${JSON.stringify(projId)},'period')">Period ${arrow('period')}</th>
                  <th>Total</th>
                  <th>Saved</th>
                  <th style="${thStyle}" onclick="_sbSortClick(${JSON.stringify(projId)},'meter')">Assign to Meter ${arrow('meter')}</th>
                  <th style="width:30px"></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
}

function deleteSavedBillFromProj(billId, projId) {
  if (!confirm('Delete this saved bill? This cannot be undone.')) return;
  let bills = sget('en_pdf_bills', []) || [];
  bills = bills.filter((b) => b.id !== billId);
  sset('en_pdf_bills', bills);
  showToast('Bill deleted ✓');
  renderProjSavedBills(projId);
}

function deleteAllSavedBills(projId) {
  let bills = sget('en_pdf_bills', []) || [];
  const unassigned = bills.filter((b) => !b.projId);
  if (!unassigned.length) {
    showToast('No unassigned bills to delete');
    return;
  }
  if (!confirm('Delete all ' + unassigned.length + ' unassigned saved bills? This cannot be undone.')) return;
  const unassignedIds = new Set(unassigned.map((b) => b.id));
  bills = bills.filter((b) => !unassignedIds.has(b.id));
  sset('en_pdf_bills', bills);
  showToast(unassigned.length + ' bills deleted ✓');
  renderProjSavedBills(projId);
}

// #141: Auto-assign all unassigned saved bills using findMeterMatch
async function autoAssignAllSavedBills(projId) {
  const allBills = sget('en_pdf_bills', []) || [];
  const unassigned = allBills.filter((b) => !b.projId);
  if (!unassigned.length) {
    showToast('No unassigned bills to auto-assign');
    return;
  }
  let assigned = 0,
    skipped = 0;
  for (const sb of unassigned) {
    const match = findMeterMatch(sb);
    if (!match) {
      skipped++;
      continue;
    }
    // Build bill record (same shape as assignSavedBillFromProj)
    const bill = {
      id: 'b' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      start: sb.BillingPeriodStart || sb.start || '',
      end: sb.BillingPeriodEnd || sb.end || '',
      utilityCompany: sb.UtilityCompany || sb.utilityCompany || '',
      customerName: sb.CustomerName || sb.customerName || '',
      accountNumber: sb.AccountNumber || sb.accountNumber || '',
      kwh: sb.kWhConsumed || sb.kwh || '',
      demandKW: sb.ActualKW || sb.demandKW || '',
      billedKW: sb.BilledKW || sb.billedKW || '',
      totalCost: sb.TotalCurrentCharges || sb.totalCost || '',
      kwhCost: sb.kwhCost || '',
      kwCost: sb.kwCost || '',
      otherCost: sb.otherCost || '',
      taxCost: sb.taxCost || '',
      naturalGasTherms: sb.NaturalGasTherms || sb.naturalGasTherms || '',
      gasCharge: sb.GasCharge || sb.gasCharge || '',
      gallonsDelivered: sb.GallonsDelivered || sb.gallonsDelivered || '',
      pdfBillId: sb.id,
      hasPDF: !!sb.hasPDF,
      pdfKey: sb.pdfKey || '',
      pdfPageStart: sb.pdfPageStart || '',
      pdfPageEnd: sb.pdfPageEnd || '',
    };
    const udProj = getUDProj(match.projId);
    const bldg = (udProj?.buildings || []).find((x) => x.id === match.bldgId);
    const meter = (bldg?.meters || []).find((x) => x.id === match.meterId);
    if (!meter) {
      skipped++;
      continue;
    }
    if (!meter.bills) meter.bills = [];
    meter.bills.push(bill);
    sb.projId = match.projId;
    sb.bldgId = match.bldgId;
    sb.meterId = match.meterId;
    assigned++;
  }
  if (assigned > 0) {
    saveUtilityData();
    await sset('en_pdf_bills', allBills);
  }
  showToast(assigned + ' bill(s) auto-assigned' + (skipped ? ', ' + skipped + ' skipped (no meter match)' : '') + ' ✓');
  renderProjSavedBills(projId);
}

// Assign a saved (unassigned) bill to a building+meter in a project
async function assignSavedBillFromProj(billId, projId) {
  const bldgSel = document.getElementById('sb-bldg-' + billId);
  const meterSel = document.getElementById('sb-meter-' + billId);
  if (!bldgSel || !meterSel) {
    showToast('Could not find selectors');
    return;
  }
  const bldgId = bldgSel.value;
  const meterId = meterSel.value;
  if (!bldgId || !meterId) {
    showToast('Select a building and meter first');
    return;
  }

  const proj = utilityData[projId];
  if (!proj) {
    showToast('Project not found');
    return;
  }
  const b = (proj.buildings || []).find((x) => x.id === bldgId);
  if (!b) {
    showToast('Building not found');
    return;
  }
  const m = (b.meters || []).find((x) => x.id === meterId);
  if (!m) {
    showToast('Meter not found');
    return;
  }

  const allBills = sget('en_pdf_bills', []) || [];
  const sb = allBills.find((x) => x.id === billId);
  if (!sb) {
    showToast('Bill not found in Saved Bills');
    return;
  }

  // Build bill record from saved bill fields
  const bill = {
    id: 'b' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    start: sb.BillingPeriodStart || sb.start || '',
    end: sb.BillingPeriodEnd || sb.end || '',
    utilityCompany: sb.UtilityCompany || sb.utilityCompany || '',
    customerName: sb.CustomerName || sb.customerName || '',
    accountNumber: sb.AccountNumber || sb.accountNumber || '',
    kwh: sb.kWhConsumed || sb.kwh || '',
    demandKW: sb.ActualKW || sb.demandKW || '',
    billedKW: sb.BilledKW || sb.billedKW || '',
    totalCost: sb.TotalCurrentCharges || sb.totalCost || '',
    kwhCost: sb.kwhCost || '',
    kwCost: sb.kwCost || '',
    otherCost: sb.otherCost || '',
    taxCost: sb.taxCost || '',
    naturalGasTherms: sb.NaturalGasTherms || sb.naturalGasTherms || '',
    gasCharge: sb.GasCharge || sb.gasCharge || '',
    gallonsDelivered: sb.GallonsDelivered || sb.gallonsDelivered || '',
    pdfBillId: sb.id,
    hasPDF: !!sb.hasPDF,
    pdfKey: sb.pdfKey || '',
    pdfPageStart: sb.pdfPageStart || '',
    pdfPageEnd: sb.pdfPageEnd || '',
  };

  if (!m.bills) m.bills = [];
  m.bills.push(bill);
  saveUtilityData();

  // Mark saved bill as assigned so it won't appear as unassigned elsewhere
  sb.projId = projId;
  sb.bldgId = bldgId;
  sb.meterId = meterId;
  await sset('en_pdf_bills', allBills);

  showToast('Bill assigned to ' + (m.provider || m.commodity || 'meter') + ' ✓');
  renderProjSavedBills(projId);
}

// ── District Calendar per project ──
// parseProjDistCal — handled by shim in DISTRICT CALENDAR block above
