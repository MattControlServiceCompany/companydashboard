// app/sync-ui.js — passive UI for the client sync engine (Phase 2a, folds in 2a.5's pill
// and 2a.6's "refresh" banner, per phase2a-build-plan.md §3) PLUS the Phase 2b
// conflict-resolution UX (blocking modal + conflict-archive viewer).
//
// Listens ONLY to events app/db.js already dispatches; has no dependency on DB internals
// beyond the small public accessors DB already exposes (getQueueDepth, getConflictArchive).
// Renders:
//   1. "N unsynced changes" pill (syncQueueChanged) — bottom-right badge.
//   2. (M1) Server changes with no pending local edit are applied by db.js and the page
//      reloads when it is safe (dbRemoteApplied). The passive "X changed - refresh" banner
//      (remoteChange) shows only when they could not be applied or a reload is unsafe.
//   3. Persistent "offline — showing local copy" banner (dbOfflineBanner), cleared by the
//      next successful hydration/manifest round-trip (dbHydrated).
//   4. (Phase 2b) A BLOCKING conflict-resolution modal, opened by app/db.js calling
//      `window.SyncConflictUI.showConflictModal(descriptor)` on a write-time 409 in
//      'on' mode. db.js owns every data mutation (archive/adopt/CAS-retry/union-PUT);
//      this file owns ONLY the DOM/UX and resolves the returned Promise with the
//      user's chosen `{action, unionValue?}`.
//   5. (Phase 2b) A small "Conflict history (N)" link + slide-in panel listing
//      en_conflict_archive entries with a per-entry JSON download button.
//
// This is a first, functional pass — the polished Settings-adjacent placement (2a.7 / Pass
// C2) is a follow-up; this file's job in 2a/2b is just to make the events/conflicts visible
// to a user, following the modal pattern documented in ui-standards.md ("Modal pattern").
(function () {
  if (typeof window === 'undefined') return;

  function ensureStyles() {
    if (document.getElementById('ch-sync-ui-styles')) return;
    var style = document.createElement('style');
    style.id = 'ch-sync-ui-styles';
    style.textContent =
      '#ch-sync-pill{position:fixed;bottom:16px;right:16px;z-index:9999;' +
      'background:var(--s3,#333);color:var(--text,#fff);border:1px solid var(--border,#555);' +
      'border-radius:999px;padding:6px 14px;font-size:12px;font-family:inherit;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;}' +
      // Both top banners live inside ONE fixed flex-column stack so that a
      // remote-change banner and an offline banner can be visible at the
      // same time without occluding each other (both are position:fixed
      // top:0 individually would otherwise overlap — found + fixed during
      // 2a implementer verification).
      '#ch-sync-banner-stack{position:fixed;top:0;left:0;right:0;z-index:9997;' +
      'display:flex;flex-direction:column;}' +
      '#ch-sync-banner-stack>div{text-align:center;font-size:13px;padding:6px 12px;display:none;}' +
      '#ch-sync-banner{background:var(--accent,#2563eb);color:#fff;}' +
      '#ch-sync-offline-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-signedout-banner,#ch-sync-foreign-banner,#ch-sync-hydrate-failed-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-signedout-banner button,#ch-sync-foreign-banner button,#ch-sync-hydrate-failed-banner button{margin-left:8px;border-radius:4px;padding:2px 10px;font-size:12px;' +
      'font-family:inherit;cursor:pointer;border:1px solid #fff;background:transparent;color:#fff;}' +
      '#ch-sync-archive-full-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-archive-full-banner button{margin-left:8px;border-radius:4px;padding:2px 10px;font-size:12px;' +
      'font-family:inherit;cursor:pointer;border:1px solid #fff;background:transparent;color:#fff;}' +
      // --- Phase 2b: conflict modal + archive viewer -------------------------
      '#ch-archive-link{position:fixed;bottom:52px;right:16px;z-index:9998;' +
      'background:var(--s3,#333);color:var(--text,#fff);border:1px solid var(--border,#555);' +
      'border-radius:999px;padding:6px 14px;font-size:12px;font-family:inherit;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;}' +
      '#ch-archive-link:hover{background:var(--s4,#3a4258);}' +
      '#ch-conflict-overlay{position:fixed;inset:0;z-index:var(--z-modal,800);' +
      'background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;' +
      'font-family:inherit;}' +
      '.ch-conflict-modal{display:flex;flex-direction:column;max-width:520px;width:92%;' +
      'max-height:85vh;overflow:hidden;background:var(--s2,#181d2e);' +
      'border:1px solid var(--border,#333);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.45);}' +
      '.ch-conflict-hdr{flex-shrink:0;background:var(--s1,#0c0f1a);padding:14px 18px;' +
      'border-bottom:1px solid var(--border2,#444);font-size:15px;font-weight:700;color:var(--text,#fff);}' +
      '.ch-conflict-body{flex:1;min-height:0;overflow-y:auto;padding:16px 18px;' +
      'color:var(--text,#fff);font-size:13px;line-height:1.6;}' +
      '.ch-conflict-body p{margin:0 0 10px;}' +
      '.ch-conflict-meta{color:var(--text2,#9aa3b8);font-size:12px;}' +
      '.ch-conflict-ftr{flex-shrink:0;padding:12px 18px;border-top:1px solid var(--border,#333);' +
      'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}' +
      '.ch-conflict-btn{border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;' +
      'cursor:pointer;border:1px solid var(--border,#333);background:var(--s3,#1e2438);' +
      'color:var(--text,#fff);font-family:inherit;}' +
      '.ch-conflict-btn:hover{background:var(--s4,#252c42);}' +
      '.ch-conflict-btn.ch-conflict-primary{background:var(--accent,#2563eb);' +
      'border-color:var(--accent,#2563eb);color:#fff;}' +
      '.ch-conflict-btn.ch-conflict-primary:hover{filter:brightness(1.1);}' +
      '.ch-conflict-btn:disabled{opacity:.5;cursor:not-allowed;}' +
      '.ch-conflict-rec{background:var(--s3,#1e2438);border:1px solid var(--border,#333);' +
      'border-radius:6px;padding:8px 10px;margin:0 0 8px;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;}' +
      '.ch-conflict-rec-name{flex-basis:100%;font-weight:600;color:var(--text,#fff);}' +
      '.ch-conflict-rec label{color:var(--text,#fff);cursor:pointer;display:inline-flex;gap:6px;align-items:center;}' +
      '.ch-conflict-field{flex-basis:100%;padding:4px 8px;margin-bottom:4px;background:var(--s2,#181d2e);' +
      'border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);overflow-wrap:anywhere;}' +
      '.ch-conflict-typed{margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;' +
      'justify-content:flex-end;width:100%;}' +
      '.ch-conflict-typed input{flex:1;min-width:140px;padding:6px 8px;border-radius:4px;' +
      'border:1px solid var(--border,#333);background:var(--s1,#0c0f1a);color:var(--text,#fff);' +
      'font-size:12px;font-family:inherit;}' +
      '#ch-archive-panel{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:90vw;' +
      'z-index:var(--z-modal,800);background:var(--s2,#181d2e);border-left:1px solid var(--border,#333);' +
      'display:none;flex-direction:column;box-shadow:-4px 0 20px rgba(0,0,0,.4);}' +
      '#ch-archive-panel.ch-open{display:flex;}' +
      '.ch-archive-hdr{flex-shrink:0;background:var(--s1,#0c0f1a);padding:12px 16px;' +
      'border-bottom:1px solid var(--border2,#444);display:flex;justify-content:space-between;' +
      'align-items:center;color:var(--text,#fff);font-size:14px;font-weight:700;}' +
      '.ch-archive-close{cursor:pointer;color:var(--text2,#9aa3b8);font-size:16px;}' +
      '.ch-archive-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;}' +
      '.ch-archive-entry{background:var(--s3,#1e2438);border:1px solid var(--border,#333);' +
      'border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:var(--text,#fff);}' +
      '.ch-archive-meta{color:var(--text2,#9aa3b8);font-size:11px;margin-bottom:6px;}' +
      // --- Phase 2a.7: sync-status panel (mode switch, per-key status, queue depth) ---
      // Stacked in the SAME bottom-right corner as the pill (bottom:16) and the
      // archive link (bottom:52), one more slot up (bottom:88) — a bottom-left
      // resting position was tried first and rejected: it sat on top of the
      // existing sidebar's Settings/Backup/Restore/Reset Data controls (found
      // during this implementer's own visual verification screenshot).
      '#ch-sync-status-btn{position:fixed;bottom:88px;right:16px;z-index:9998;' +
      'background:var(--s3,#333);color:var(--text,#fff);border:1px solid var(--border,#555);' +
      'border-radius:999px;padding:6px 14px;font-size:12px;font-family:inherit;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;}' +
      '#ch-sync-status-btn:hover{background:var(--s4,#3a4258);}' +
      '#ch-sync-status-panel{position:fixed;top:0;left:0;bottom:0;width:360px;max-width:90vw;' +
      'z-index:var(--z-modal,800);background:var(--s2,#181d2e);border-right:1px solid var(--border,#333);' +
      'display:none;flex-direction:column;box-shadow:4px 0 20px rgba(0,0,0,.4);font-family:inherit;}' +
      '#ch-sync-status-panel.ch-open{display:flex;}' +
      '.ch-sync-status-body{display:flex;flex-direction:column;gap:12px;}' +
      '.ch-sync-status-mode-row{padding-bottom:10px;border-bottom:1px solid var(--border,#333);}' +
      '.ch-sync-status-label{color:var(--text,#fff);font-size:13px;font-weight:600;margin-bottom:8px;}' +
      '.ch-sync-status-queue{color:var(--text,#fff);font-size:13px;padding:8px 0;' +
      'border-bottom:1px solid var(--border,#333);}' +
      '.ch-sync-status-headline{font-size:14px;font-weight:700;margin-bottom:4px;}' +
      '.ch-sync-status-headline.ch-sync-ok{color:var(--accent,#2563eb);}' +
      '.ch-sync-status-headline.ch-sync-warn{color:var(--warn,#b45309);}' +
      '.ch-sync-status-key{background:var(--s3,#1e2438);border:1px solid var(--border,#333);' +
      'border-radius:6px;padding:8px 10px;margin-bottom:8px;}' +
      '.ch-sync-status-key-name{font-size:13px;font-weight:600;color:var(--text,#fff);margin-bottom:2px;}' +
      '.ch-sync-status-key-in-sync .ch-sync-status-key-name{color:var(--accent,#2563eb);}' +
      '.ch-sync-status-key-diverged .ch-sync-status-key-name{color:var(--warn,#b45309);}' +
      '.ch-sync-status-key-pending .ch-sync-status-key-name{color:var(--text2,#9aa3b8);}' +
      // All widths: the three corner controls sit in ONE row on the bottom edge (status
      // left, archive next, unsynced pill right) and .content reserves that row, so nothing
      // covers page content. At 900px and wider the row starts right of the 220px sidebar.
      '#ch-sync-status-btn,#ch-archive-link,#ch-sync-pill{bottom:6px;font-size:11px;padding:4px 10px;}' +
      '#ch-sync-status-btn{left:236px;right:auto;}' +
      '#ch-archive-link{left:336px;right:auto;}' +
      '.content{margin-bottom:38px;}' +
      '@media (max-width:899px){#ch-sync-status-btn{left:16px;}#ch-archive-link{left:116px;}}';
    document.head.appendChild(style);
  }

  function ensureStack() {
    var stack = document.getElementById('ch-sync-banner-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'ch-sync-banner-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function ensureEl(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      if (/^ch-sync-(banner|offline-banner|archive-full-banner|signedout-banner|foreign-banner|hydrate-failed-banner)$/.test(id)) {
        ensureStack().appendChild(el);
      } else {
        document.body.appendChild(el);
      }
    }
    return el;
  }

  function renderPill(depth) {
    ensureStyles();
    var el = ensureEl('ch-sync-pill');
    if (depth > 0) {
      el.textContent = depth + ' unsynced change' + (depth === 1 ? '' : 's');
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  function renderRemoteChangeBanner(keys) {
    ensureStyles();
    var el = ensureEl('ch-sync-banner');
    var n = keys && keys.length ? keys.length : 0;
    if (!n) return;
    el.textContent =
      n + (n === 1 ? ' item was' : ' items were') + ' changed on the server — refresh to get the latest.';
    el.style.display = 'block';
  }

  function renderOfflineBanner(show) {
    ensureStyles();
    var el = ensureEl('ch-sync-offline-banner');
    el.textContent = 'Offline — showing local copy. Edits will sync when reconnected.';
    el.style.display = show ? 'block' : 'none';
  }

  // B2: signed out on the sync host = nothing syncs. Say so and force sign-in.
  // Shown only when the page is past the login screen (index.html shows its own form).
  function renderSignedOutBar() {
    var needs = !!(window.CH_AUTH && window.CH_AUTH.needsSignIn && window.CH_AUTH.needsSignIn());
    var login = document.getElementById('loginScreen');
    var onLoginScreen = !!login && window.getComputedStyle(login).display !== 'none';
    var show = needs && !onLoginScreen;
    if (!show && !document.getElementById('ch-sync-signedout-banner')) return;
    ensureStyles();
    var el = ensureEl('ch-sync-signedout-banner');
    if (!el.firstChild) {
      el.appendChild(
        document.createTextNode('Signed out - not syncing. Changes stay in this browser until you sign in.'),
      );
      var btn = document.createElement('button');
      btn.textContent = 'Sign in';
      btn.onclick = function () {
        if (window.CH_AUTH && window.CH_AUTH.clearSavedUser) window.CH_AUTH.clearSavedUser();
        window.location.href = 'index.html';
      };
      el.appendChild(btn);
    }
    el.style.display = show ? 'block' : 'none';
  }
  window.addEventListener('chAuthStateChanged', renderSignedOutBar);
  window.addEventListener('dbReady', renderSignedOutBar);
  document.addEventListener('DOMContentLoaded', renderSignedOutBar);

  // Pending edits made by a different user than the one signed in now. Never sent, never deleted.
  function renderForeignQueueBar() {
    var info = window.DB && window.DB.getForeignQueueInfo ? window.DB.getForeignQueueInfo() : [];
    var el = document.getElementById('ch-sync-foreign-banner');
    if (!info.length && !el) return;
    ensureStyles();
    el = ensureEl('ch-sync-foreign-banner');
    el.textContent = info
      .map(function (o) {
        return o.count + ' unsent change' + (o.count === 1 ? '' : 's') + ' from ' + o.email + ' - sign in as that user to send them.';
      })
      .join(' ');
    el.style.display = info.length ? 'block' : 'none';
  }
  window.addEventListener('syncQueueChanged', renderForeignQueueBar);
  window.addEventListener('dbReady', renderForeignQueueBar);
  window.addEventListener('chAuthStateChanged', renderForeignQueueBar);

  // B4: some keys could not be loaded from the server after one retry.
  window.addEventListener('dbHydrateFailed', function (e) {
    ensureStyles();
    var el = ensureEl('ch-sync-hydrate-failed-banner');
    var n = e.detail && e.detail.keys ? e.detail.keys.length : 0;
    el.textContent = 'Could not load ' + n + ' saved item' + (n === 1 ? '' : 's') + ' from the server. Some data may be missing. ';
    var btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.onclick = function () {
      window.location.reload();
    };
    el.appendChild(btn);
    el.style.display = 'block';
  });

  // The conflict archive is never trimmed by the app. Past its size cap this
  // notice stays until the user exports the archive and confirms the clear.
  function renderArchiveFullBanner() {
    if (!window.DB || typeof window.DB.isConflictArchiveFull !== 'function' || !window.DB.isConflictArchiveFull())
      return;
    ensureStyles();
    var el = ensureEl('ch-sync-archive-full-banner');
    var n = window.DB.getConflictArchive().length;
    el.textContent =
      'The conflict history is large (' + n + ' entries) and holds copies of replaced edits. Save it to a file.';
    var btn = document.createElement('button');
    btn.textContent = 'Export conflict history';
    btn.onclick = function () {
      var entries = window.DB.getConflictArchive();
      var count = entries.length;
      var blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = new Date().toISOString().slice(0, 10) + '-conflict-history.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (window.confirm('Did the file save? Choose OK to remove these ' + count + ' entries from the browser.')) {
        window.DB.clearConflictArchive(count);
        el.style.display = 'none';
        renderArchiveLink();
      }
    };
    el.appendChild(btn);
    el.style.display = 'block';
  }
  window.addEventListener('conflictArchiveFull', renderArchiveFullBanner);

  window.addEventListener('syncQueueChanged', function (e) {
    var depth =
      e.detail && typeof e.detail.depth === 'number'
        ? e.detail.depth
        : window.DB && window.DB.getQueueDepth
          ? window.DB.getQueueDepth()
          : 0;
    renderPill(depth);
  });

  window.addEventListener('remoteChange', function (e) {
    renderRemoteChangeBanner(e.detail && e.detail.keys);
  });

  // M1: db.js already applied these server changes to the local copy. The page
  // holds its own in-memory lists, so the ONE way to show them is a page reload.
  // Reload only when nothing here can be lost by it (no field being edited, no
  // dialog open, nothing unsent); otherwise show the refresh bar instead.
  function _safeToReload() {
    var a = document.activeElement;
    var typing =
      a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    var dialog = document.querySelector('.modal-overlay.open, .modal.open, #ch-conflict-overlay, dialog[open]');
    var unsent = window.DB && typeof window.DB.getQueueDepth === 'function' && window.DB.getQueueDepth() > 0;
    return !typing && !dialog && !unsent;
  }
  window.addEventListener('dbRemoteApplied', function (e) {
    var keys = (e.detail && e.detail.keys) || [];
    if (_safeToReload()) window.location.reload();
    else renderRemoteChangeBanner(keys);
  });

  window.addEventListener('dbOfflineBanner', function () {
    renderOfflineBanner(true);
  });

  // First connect of a browser that had local-only data: one-line result.
  window.addEventListener('dbFirstConnect', function (e) {
    var d = (e && e.detail) || {};
    var msg = (d.uploaded || 0) + ' uploaded, ' + (d.updated || 0) + ' updated from server';
    if (typeof showToast === 'function') showToast(msg, 'info', 10000);
  });

  window.addEventListener('dbHydrated', function () {
    // A successful manifest round-trip (hydration OR a poll cycle) proves
    // we're online — clears any stale offline banner.
    renderOfflineBanner(false);
  });

  // Initial paint once DB is ready, in case a queue already had entries left
  // over from a prior offline session.
  window.addEventListener('dbReady', function () {
    if (window.DB && typeof window.DB.getQueueDepth === 'function') {
      renderPill(window.DB.getQueueDepth());
    }
    renderArchiveLink();
    renderArchiveFullBanner();
  });

  // =========================================================================
  // Phase 2b — conflict-resolution UX
  // =========================================================================

  // Plain-language names for the keys most likely to actually conflict (per
  // ui-standards.md's plain-language rule — never show a raw internal key
  // like "en_eqmatrix_182" to the user). Falls back to a prefix match, then
  // to the raw key as a last resort so nothing ever throws.
  var FRIENDLY_KEY_NAMES = {
    en_projects: 'the projects list',
    en_tasks: 'the tasks list',
    en_dc_events: 'the district calendar',
    en_pdf_bills: 'the saved bill list',
    en_presented_savings: 'the presented-to-client savings marks',
    en_meetingTemplates: 'the meeting templates',
  };
  var FRIENDLY_KEY_PREFIXES = [
    ['en_utility_', 'this utility data'],
    ['en_eqmatrix_', 'this equipment list'],
    ['en_pricing_', 'this pricing data'],
    ['en_report_history', 'the report history'],
    ['en_report_templates_', 'the report templates'],
    ['en_bas_', 'this building automation trend data'],
    ['en_alarms_', 'this alarm log'],
    ['en_hours_', 'this hours log'],
    ['en_budget_', 'this budget data'],
    ['en_customers', 'the customer list'],
    ['en_deleted_records', 'the deletion records'],
    ['en_presented_savings', 'the presented-to-client savings marks'],
    ['en_agreement_', 'this service agreement setup'],
    ['en_value_corrections', 'the value corrections log'],
    ['en_wdd_', 'this weather data'],
    ['bldgperf_cfg_', 'a building performance chart setting'],
    ['bldgsavproj_cfg_', 'a building savings projection setting'],
    ['en_bills_zoom_', 'a bill table zoom setting'],
    ['en_sv_matrix_zoom_', 'a matrix zoom setting'],
    ['en_em_zoom', 'the equipment matrix zoom setting'],
    ['en_perf_zoom', 'the performance table zoom setting'],
    ['audit_estimate_config', 'the audit estimate assumptions'],
    ['ems_leads_v1', 'the EMS leads list'],
    ['sv_', 'this service department data'],
    ['ch_', 'a personal display setting'],
  ];
  function friendlyKeyName(key) {
    if (FRIENDLY_KEY_NAMES[key]) return FRIENDLY_KEY_NAMES[key];
    for (var i = 0; i < FRIENDLY_KEY_PREFIXES.length; i++) {
      if (key.indexOf(FRIENDLY_KEY_PREFIXES[i][0]) === 0) return FRIENDLY_KEY_PREFIXES[i][1];
    }
    return 'this item';
  }

  // One short, readable line for a field value in the conflict modal.
  function _shortValue(v) {
    if (v === undefined || v === null || v === '') return '(empty)';
    var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 160 ? s.slice(0, 157) + '...' : s;
  }

  function fmtDate(iso) {
    if (!iso) return 'an unknown time';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return String(iso);
    }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s === null || s === undefined ? '' : String(s);
    return d.innerHTML;
  }

  function downloadJSON(key, value) {
    try {
      var blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'conflict-' + String(key).replace(/[^a-z0-9_-]/gi, '_') + '-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      console.warn('[SyncConflictUI] download failed:', e);
    }
  }

  // --- Modal queue (serialize — never stack two conflict modals) -----------
  var _modalQueue = [];
  var _modalShowing = false;

  function showConflictModal(descriptor) {
    return new Promise(function (resolve) {
      _modalQueue.push({ descriptor: descriptor, resolve: resolve });
      _drainModalQueue();
    });
  }

  function _drainModalQueue() {
    if (_modalShowing) return;
    var next = _modalQueue.shift();
    if (!next) return;
    _modalShowing = true;
    _renderConflictModal(next.descriptor, function (resolution) {
      _modalShowing = false;
      next.resolve(resolution);
      _drainModalQueue();
    });
  }

  function _buttonPlan(descriptor) {
    if (descriptor.conflictClass === 'tombstone') {
      return [
        { action: 'restore-mine', label: 'Restore my version', primary: true, gated: descriptor.typedConfirmRequired },
        { action: 'discard-mine', label: 'Discard my change', primary: false, gated: false },
      ];
    }
    if (descriptor.conflictClass === 'records') {
      // Per-record choice. The record not chosen goes to the conflict history.
      return [{ action: 'records', label: 'Save my choices', primary: true, gated: false }];
    }
    return [
      { action: 'load-theirs', label: 'Load theirs (recommended)', primary: true, gated: false },
      {
        action: 'overwrite-mine',
        label: 'Overwrite with mine',
        primary: false,
        gated: descriptor.typedConfirmRequired,
      },
      { action: 'save-copy', label: 'Save mine as a copy / download', primary: false, gated: false },
    ];
  }

  function _bodyHtml(descriptor) {
    var name = friendlyKeyName(descriptor.key);
    var who = descriptor.server.updatedBy || 'another user';
    var when = fmtDate(descriptor.server.updatedAt);
    var html = '';

    if (descriptor.conflictClass === 'tombstone') {
      html +=
        '<p><strong>' +
        esc(who) +
        '</strong> deleted ' +
        esc(name) +
        ' at ' +
        esc(when) +
        ' while you were editing it.</p>';
      html += '<p>Your changes were not lost — they are saved and available below.</p>';
    } else if (descriptor.conflictClass === 'records') {
      var recs = descriptor.records || [];
      html +=
        '<p><strong>' +
        esc(who) +
        '</strong> and you both changed the same ' +
        (recs.length === 1 ? 'item' : recs.length + ' items') +
        ' in ' +
        esc(name) +
        ' (theirs saved at ' +
        esc(when) +
        '). Everything else was merged already. Choose which version to keep for each item. ' +
        'The version you do not keep stays in the conflict history.</p>';
      recs.forEach(function (r, i) {
        var fields = r.fields || [];
        html += '<div class="ch-conflict-rec">' + '<div class="ch-conflict-rec-name">' + esc(r.label) + '</div>';
        // Both values of every field changed on both sides, so the choice is informed.
        fields.forEach(function (f) {
          html +=
            '<div class="ch-conflict-field"><div class="ch-conflict-meta">' +
            esc(f) +
            '</div>' +
            '<div><span class="ch-conflict-meta">Theirs: </span>' +
            esc(_shortValue(r.server && r.server[f])) +
            '</div>' +
            '<div><span class="ch-conflict-meta">Mine: </span>' +
            esc(_shortValue(r.local && r.local[f])) +
            '</div></div>';
        });
        html +=
          '<label><input type="radio" name="ch-conflict-rec-' +
          i +
          '" value="theirs" checked> Keep theirs</label>' +
          '<label><input type="radio" name="ch-conflict-rec-' +
          i +
          '" value="mine"> Keep mine</label>' +
          '</div>';
      });
    } else {
      html +=
        '<p><strong>' +
        esc(who) +
        '</strong> changed ' +
        esc(name) +
        ' at ' +
        esc(when) +
        ' while you were editing it. Saving your changes now would overwrite theirs.</p>';
      html +=
        '<p class="ch-conflict-meta">Their saved version: ' +
        esc(descriptor.server.version) +
        '. Yours was based on version: ' +
        esc(descriptor.localBaseVersion != null ? descriptor.localBaseVersion : 'unknown') +
        '.</p>';
      if (descriptor.conflictClass === 'union-candidate') {
        html +=
          '<p>It looks like you each only ADDED new items, with nothing else changed. ' +
          '"Keep both" combines both sets of changes so nothing is lost.</p>';
      }
    }
    return html;
  }

  function _confirmText(action) {
    if (action === 'overwrite-mine') return 'This will permanently replace the saved copy with yours. Continue?';
    if (action === 'restore-mine') return 'This will undo the deletion and bring back your version. Continue?';
    if (action === 'discard-mine')
      return 'This will accept the deletion. Your change stays only in the conflict history. Continue?';
    return 'Continue?';
  }

  function _renderConflictModal(descriptor, done) {
    ensureStyles();
    var finished = false;
    var overlay = document.createElement('div');
    overlay.id = 'ch-conflict-overlay';

    var modal = document.createElement('div');
    modal.className = 'ch-conflict-modal';

    var hdr = document.createElement('div');
    hdr.className = 'ch-conflict-hdr';
    hdr.textContent =
      descriptor.conflictClass === 'tombstone'
        ? 'This was deleted while you were editing it'
        : descriptor.conflictClass === 'records'
          ? 'You both changed the same item'
          : 'Someone else changed this while you were editing';

    var body = document.createElement('div');
    body.className = 'ch-conflict-body';
    body.innerHTML = _bodyHtml(descriptor);

    var ftr = document.createElement('div');
    ftr.className = 'ch-conflict-ftr';

    function teardown() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function finish(resolution) {
      if (finished) return; // never resolve twice
      finished = true;
      teardown();
      done(resolution);
    }

    function commit(btnCfg) {
      if (btnCfg.action === 'save-copy') {
        downloadJSON(descriptor.key, descriptor.local.deleted ? null : descriptor.local.value);
      }
      var resolution = { action: btnCfg.action };
      if (btnCfg.action === 'records') {
        resolution.choices = {};
        (descriptor.records || []).forEach(function (r, i) {
          var picked = body.querySelector('input[name="ch-conflict-rec-' + i + '"]:checked');
          resolution.choices[String(r.id)] = picked && picked.value === 'mine' ? 'mine' : 'theirs';
        });
      }
      finish(resolution);
    }

    var plan = _buttonPlan(descriptor);

    // Renders the normal button row into `ftr` — also the Cancel target for
    // the typed-confirm inline row below, so Cancel genuinely returns the
    // user to their original set of choices instead of a dead end.
    function renderButtonRow() {
      ftr.innerHTML = '';
      plan.forEach(function (btnCfg) {
        var btn = document.createElement('button');
        btn.className = 'ch-conflict-btn' + (btnCfg.primary ? ' ch-conflict-primary' : '');
        btn.textContent = btnCfg.label;
        btn.addEventListener('click', function () {
          if (btnCfg.gated) {
            _showTypedConfirmInline(ftr, btnCfg, renderButtonRow, function () {
              commit(btnCfg);
            });
            return;
          }
          if (
            btnCfg.action === 'overwrite-mine' ||
            btnCfg.action === 'restore-mine' ||
            btnCfg.action === 'discard-mine'
          ) {
            if (!window.confirm(_confirmText(btnCfg.action))) return;
          }
          commit(btnCfg);
        });
        ftr.appendChild(btn);
      });
    }
    renderButtonRow();

    modal.appendChild(hdr);
    modal.appendChild(body);
    modal.appendChild(ftr);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // Typed-confirm tiering (§5): en_utility_* overwrite/restore actions require
  // typing the word "overwrite" before the action runs. Replaces the footer's
  // buttons with an inline input + Confirm/Cancel so the user cannot miss it.
  // `onCancel` restores the normal button row (never a dead end).
  function _showTypedConfirmInline(ftr, btnCfg, onCancel, onConfirmed) {
    var row = document.createElement('div');
    row.className = 'ch-conflict-typed';

    var label = document.createElement('span');
    label.className = 'ch-conflict-meta';
    label.textContent = 'Type "overwrite" to confirm:';

    var input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'ch-conflict-btn ch-conflict-primary';
    confirmBtn.textContent = 'Confirm overwrite';
    confirmBtn.disabled = true;

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ch-conflict-btn';
    cancelBtn.textContent = 'Cancel';

    input.addEventListener('input', function () {
      confirmBtn.disabled = input.value.trim().toLowerCase() !== 'overwrite';
    });
    confirmBtn.addEventListener('click', function () {
      if (input.value.trim().toLowerCase() !== 'overwrite') return;
      onConfirmed();
    });
    cancelBtn.addEventListener('click', onCancel);

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(cancelBtn);
    row.appendChild(confirmBtn);
    ftr.innerHTML = '';
    ftr.appendChild(row);
    input.focus();
  }

  window.SyncConflictUI = window.SyncConflictUI || {};
  window.SyncConflictUI.showConflictModal = showConflictModal;

  // --- Conflict-archive viewer ----------------------------------------------
  function renderArchiveLink() {
    ensureStyles();
    var el = ensureEl('ch-archive-link');
    var archive = window.DB && typeof window.DB.getConflictArchive === 'function' ? window.DB.getConflictArchive() : [];
    if (archive.length > 0) {
      el.textContent = 'Conflict history (' + archive.length + ')';
      el.style.display = 'block';
      el.onclick = openArchivePanel;
    } else {
      el.style.display = 'none';
    }
  }

  function openArchivePanel() {
    ensureStyles();
    var panel = ensureEl('ch-archive-panel');
    var archive = window.DB && typeof window.DB.getConflictArchive === 'function' ? window.DB.getConflictArchive() : [];
    // Standing rule: date/time-sorted lists default to newest first.
    var sorted = archive.slice().sort(function (a, b) {
      return new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0);
    });

    panel.innerHTML = '';
    var hdr = document.createElement('div');
    hdr.className = 'ch-archive-hdr';
    var title = document.createElement('span');
    title.textContent = 'Conflict history (' + sorted.length + ')';
    var closeBtn = document.createElement('span');
    closeBtn.className = 'ch-archive-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () {
      panel.classList.remove('ch-open');
    });
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'ch-archive-body';
    if (!sorted.length) {
      var empty = document.createElement('div');
      empty.className = 'ch-conflict-meta';
      empty.textContent = 'No conflicts recorded.';
      body.appendChild(empty);
    }
    sorted.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'ch-archive-entry';
      var meta = document.createElement('div');
      meta.className = 'ch-archive-meta';
      meta.textContent =
        friendlyKeyName(entry.key) + ' — ' + (entry.reason || 'conflict') + ' — ' + fmtDate(entry.archivedAt);
      var dl = document.createElement('button');
      dl.className = 'ch-conflict-btn';
      dl.textContent = 'Download the version that was not kept';
      dl.addEventListener('click', function () {
        downloadJSON(entry.key, entry.losingValue !== undefined ? entry.losingValue : null);
      });
      row.appendChild(meta);
      row.appendChild(dl);
      body.appendChild(row);
    });

    panel.appendChild(hdr);
    panel.appendChild(body);
    panel.classList.add('ch-open');
  }

  window.addEventListener('dataUpdated', function (e) {
    if (e.detail && e.detail.key === 'en_conflict_archive') renderArchiveLink();
  });

  // =========================================================================
  // Phase 2a.7 — Sync-status panel (phase2a-build-plan.md task 2a.7 /
  // supabase-migration-plan-FINAL-2026-07-19.md §8's sync mode).
  // Self-contained in this file per the dispatch constraint — no HTML edits,
  // no db.js changes; reads only the read-only accessors Pass B exposed:
  // DB.getSyncStatus() (async — hits the manifest endpoint), DB.getQueueDepth(),
  // the derived mode. Opened from a small always-visible control placed
  // in this same pill/banner area, bottom-left (opposite the pill/archive-link
  // stack at bottom-right) so it never collides with them.
  // =========================================================================
  var _statusPanelOpen = false;

  function _currentBackendMode() {
    return window.CH_AUTH.backendMode();
  }

  function _modeLabel(mode) {
    if (mode === 'off') return 'Off (no syncing)';
    if (mode === 'on') return 'On (fully syncing)';
    return String(mode);
  }

  // Per-key state, per task 2a.7: reads the local-vs-server hash comparison
  // DB.getSyncStatus() already computed. A key with no local version-map
  // entry yet (never hydrated/pushed from this machine) is "pending", not
  // "diverged" — it has nothing to compare yet.
  function _keyState(k) {
    if (k.localHash == null && k.localVersion == null) return 'pending';
    if (k.localHash && k.serverHash) return k.localHash === k.serverHash ? 'in-sync' : 'diverged';
    return k.inSync ? 'in-sync' : 'diverged';
  }

  function _keyStateLabel(state) {
    if (state === 'in-sync') return 'in sync';
    if (state === 'diverged') return 'diverged (local≠server)';
    return 'pending';
  }

  function renderSyncStatusButton() {
    ensureStyles();
    var el = ensureEl('ch-sync-status-btn');
    el.textContent = 'Sync status';
    el.style.display = 'block';
    el.onclick = openSyncStatusPanel;
  }

  // Read-only line: the mode is derived (signed in on the production host =
  // On). There is no switch.
  function _renderModeControl(container, currentMode) {
    var row = document.createElement('div');
    row.className = 'ch-sync-status-mode-row';
    var label = document.createElement('div');
    label.className = 'ch-sync-status-label';
    label.textContent = 'Backend mode: ' + _modeLabel(currentMode);
    row.appendChild(label);
    container.appendChild(row);
  }

  function _renderQueueDepth(container, depth) {
    var row = document.createElement('div');
    row.id = 'ch-sync-status-queue';
    row.className = 'ch-sync-status-queue';
    row.textContent =
      depth > 0 ? depth + ' change' + (depth === 1 ? '' : 's') + ' waiting to sync' : 'No changes waiting to sync';
    container.appendChild(row);
  }

  // First-connect upload progress (runs after the page shows; see db.js _uploadFirstConnect).
  function _uploadProgressText(p) {
    if (!p || !p.total) return '';
    if (p.running) return 'Uploading your saved data for the first time: ' + p.done + ' of ' + p.total;
    if (p.failed > 0)
      return (
        p.failed +
        ' of ' +
        p.total +
        ' items could not upload yet. They wait in the sync queue and retry by themselves.'
      );
    return 'First upload finished: ' + p.uploaded + ' items uploaded.';
  }
  function _renderUploadProgress(container) {
    var row = document.createElement('div');
    row.id = 'ch-sync-status-upload';
    row.className = 'ch-sync-status-queue';
    var p = window.DB && window.DB.getUploadProgress ? window.DB.getUploadProgress() : null;
    row.textContent = _uploadProgressText(p);
    row.style.display = row.textContent ? '' : 'none';
    container.appendChild(row);
  }
  window.addEventListener('dbUploadProgress', function (e) {
    var el = document.getElementById('ch-sync-status-upload');
    if (!el || !_statusPanelOpen) return;
    el.textContent = _uploadProgressText(e.detail);
    el.style.display = el.textContent ? '' : 'none';
  });

  // Deletion records (db.js _refreshTombstones). While they cannot be loaded,
  // the project, customer, task, calendar and lead lists are not merged or
  // uploaded; the engine retries by itself.
  function _deletionRecordsText(d) {
    if (!d || d.ok !== false) return '';
    var next = d.nextRetryAt ? Math.max(0, Math.round((d.nextRetryAt - Date.now()) / 1000)) : null;
    return (
      'The deletion records could not be loaded from the server' +
      (d.error ? ' (' + d.error + ')' : '') +
      '. The project, customer, task, calendar and lead lists wait until this succeeds. ' +
      'Nothing is lost. The engine retries by itself' +
      (next !== null ? ' in ' + next + ' seconds' : '') +
      '.'
    );
  }
  function _renderDeletionRecords(container, d) {
    var row = document.createElement('div');
    row.id = 'ch-sync-status-deletions';
    row.className = 'ch-sync-status-queue ch-sync-warn';
    row.textContent = _deletionRecordsText(d);
    row.style.display = row.textContent ? '' : 'none';
    container.appendChild(row);
  }
  window.addEventListener('dbDeletionRecordsStatus', function (e) {
    var el = document.getElementById('ch-sync-status-deletions');
    if (!el || !_statusPanelOpen) return;
    el.textContent = _deletionRecordsText(e.detail);
    el.style.display = el.textContent ? '' : 'none';
  });

  function _renderKeyList(container, status) {
    var listWrap = document.createElement('div');
    listWrap.id = 'ch-sync-status-keys';

    if (status.mode === 'off') {
      var offNote = document.createElement('div');
      offNote.className = 'ch-conflict-meta';
      offNote.textContent = 'Sync is off — nothing to compare against the server.';
      listWrap.appendChild(offNote);
      container.appendChild(listWrap);
      return;
    }
    if (status.error) {
      var errNote = document.createElement('div');
      errNote.className = 'ch-conflict-meta';
      errNote.textContent = 'Could not reach the server: ' + status.error;
      listWrap.appendChild(errNote);
      container.appendChild(listWrap);
      return;
    }

    var keys = status.keys || [];
    var counts = { 'in-sync': 0, diverged: 0, pending: 0 };
    keys.forEach(function (k) {
      counts[_keyState(k)]++;
    });

    var headline = document.createElement('div');
    headline.id = 'ch-sync-status-headline';
    headline.className = 'ch-sync-status-headline';
    if (keys.length === 0) {
      headline.textContent = 'No synced items yet';
    } else if (counts.diverged === 0 && counts.pending === 0) {
      headline.textContent = 'In sync ✓';
      headline.classList.add('ch-sync-ok');
    } else {
      var parts = [];
      if (counts.pending) parts.push(counts.pending + ' key' + (counts.pending === 1 ? '' : 's') + ' pending');
      if (counts.diverged) parts.push(counts.diverged + ' diverged');
      headline.textContent = parts.join(' / ');
      headline.classList.add('ch-sync-warn');
    }
    listWrap.appendChild(headline);

    // One row per distinct item and state (many keys share one plain name, for
    // example one chart setting per building). When anything is pending or
    // diverged, only those rows are listed; in-sync rows are summed in the headline.
    var listAll = counts.diverged === 0 && counts.pending === 0;
    var groups = [];
    var byLabel = {};
    keys.forEach(function (k) {
      var state = _keyState(k);
      if (!listAll && state === 'in-sync') return;
      var label = friendlyKeyName(k.key);
      var gk = label + '|' + state;
      if (!byLabel[gk]) {
        byLabel[gk] = { label: label, state: state, keys: [], deleted: 0 };
        groups.push(byLabel[gk]);
      }
      byLabel[gk].keys.push(k.key);
      if (k.deleted) byLabel[gk].deleted++;
    });
    groups.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'ch-sync-status-key ch-sync-status-key-' + g.state;
      var name = document.createElement('div');
      name.className = 'ch-sync-status-key-name';
      name.textContent = g.label + (g.keys.length > 1 ? ' (' + g.keys.length + ' items)' : '');
      row.title = g.keys.slice(0, 8).join('\n') + (g.keys.length > 8 ? '\n...' : ''); // internal names on hover only
      var meta = document.createElement('div');
      meta.className = 'ch-conflict-meta';
      meta.textContent = _keyStateLabel(g.state) + (g.deleted ? ' (' + g.deleted + ' deleted)' : '');
      row.appendChild(name);
      row.appendChild(meta);
      listWrap.appendChild(row);
    });

    container.appendChild(listWrap);
  }

  function openSyncStatusPanel() {
    ensureStyles();
    var panel = ensureEl('ch-sync-status-panel');
    panel.innerHTML = '';
    _statusPanelOpen = true;

    var hdr = document.createElement('div');
    hdr.className = 'ch-archive-hdr';
    var title = document.createElement('span');
    title.textContent = 'Sync status';
    var closeBtn = document.createElement('span');
    closeBtn.className = 'ch-archive-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () {
      panel.classList.remove('ch-open');
      _statusPanelOpen = false;
    });
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'ch-archive-body ch-sync-status-body';

    var currentMode = _currentBackendMode();
    _renderModeControl(body, currentMode);
    _renderQueueDepth(body, window.DB && typeof window.DB.getQueueDepth === 'function' ? window.DB.getQueueDepth() : 0);
    _renderUploadProgress(body);

    var loading = document.createElement('div');
    loading.id = 'ch-sync-status-loading';
    loading.className = 'ch-conflict-meta';
    loading.textContent = 'Checking with the server…';
    body.appendChild(loading);

    panel.appendChild(hdr);
    panel.appendChild(body);
    panel.classList.add('ch-open');

    if (window.DB && typeof window.DB.getSyncStatus === 'function') {
      window.DB.getSyncStatus()
        .then(function (status) {
          if (!_statusPanelOpen) return; // panel was closed before the fetch resolved
          if (loading.parentNode) loading.parentNode.removeChild(loading);
          _renderDeletionRecords(body, status.deletionRecords);
          _renderKeyList(body, status);
        })
        .catch(function (e) {
          if (loading.parentNode)
            loading.textContent = 'Could not check sync status: ' + (e && e.message ? e.message : e);
        });
    } else if (loading.parentNode) {
      loading.textContent = 'Sync status is unavailable on this page.';
    }
  }

  // Live queue-depth updates (task 2a.7 point 3) — only touches the DOM when
  // the panel is actually open, so this listener is a no-op the rest of the time.
  window.addEventListener('syncQueueChanged', function (e) {
    if (!_statusPanelOpen) return;
    var depth =
      e.detail && typeof e.detail.depth === 'number'
        ? e.detail.depth
        : window.DB && window.DB.getQueueDepth
          ? window.DB.getQueueDepth()
          : 0;
    var el = document.getElementById('ch-sync-status-queue');
    if (el) {
      el.textContent =
        depth > 0 ? depth + ' change' + (depth === 1 ? '' : 's') + ' waiting to sync' : 'No changes waiting to sync';
    }
  });

  window.addEventListener('dbReady', function () {
    renderSyncStatusButton();
  });
})();
