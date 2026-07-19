// app/sync-ui.js — passive UI for the client sync engine (Phase 2a, folds in 2a.5's pill
// and 2a.6's "refresh" banner, per phase2a-build-plan.md §3) PLUS the Phase 2b
// conflict-resolution UX (blocking modal + conflict-archive viewer).
//
// Listens ONLY to events app/db.js already dispatches; has no dependency on DB internals
// beyond the small public accessors DB already exposes (getQueueDepth, getConflictArchive).
// Renders:
//   1. "N unsynced changes" pill (syncQueueChanged) — bottom-right badge.
//   2. Passive "X changed — refresh" banner (remoteChange) — does NOT auto-swap _cache
//      under a live page (supabase-migration-plan-FINAL-2026-07-19.md §2.4 — no silent
//      live-merge in v1).
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
      '.ch-archive-meta{color:var(--text2,#9aa3b8);font-size:11px;margin-bottom:6px;}';
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
      if (id === 'ch-sync-banner' || id === 'ch-sync-offline-banner') {
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

  window.addEventListener('dbOfflineBanner', function () {
    renderOfflineBanner(true);
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
  ];
  function friendlyKeyName(key) {
    if (FRIENDLY_KEY_NAMES[key]) return FRIENDLY_KEY_NAMES[key];
    for (var i = 0; i < FRIENDLY_KEY_PREFIXES.length; i++) {
      if (key.indexOf(FRIENDLY_KEY_PREFIXES[i][0]) === 0) return FRIENDLY_KEY_PREFIXES[i][1];
    }
    return 'this item';
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
    if (descriptor.conflictClass === 'union-candidate') {
      return [
        { action: 'keep-both', label: 'Keep both (recommended)', primary: true, gated: false },
        { action: 'load-theirs', label: 'Load theirs', primary: false, gated: false },
        {
          action: 'overwrite-mine',
          label: 'Overwrite with mine',
          primary: false,
          gated: descriptor.typedConfirmRequired,
        },
        { action: 'save-copy', label: 'Save mine as a copy / download', primary: false, gated: false },
      ];
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
      if (btnCfg.action === 'keep-both') resolution.unionValue = descriptor.unionPreview;
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
})();
