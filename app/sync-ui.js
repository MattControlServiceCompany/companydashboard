// app/sync-ui.js — passive UI for the client sync engine (Phase 2a, folds in 2a.5's pill
// and 2a.6's "refresh" banner, per phase2a-build-plan.md §3) PLUS the conflict-archive viewer.
// There is no conflict dialog: app/db.js resolves a same-field conflict itself (the later save wins).
//
// Listens ONLY to events app/db.js already dispatches; has no dependency on DB internals
// beyond the small public accessors DB already exposes (getQueueDepth, getConflictArchive).
// Renders:
//   1. "N unsynced changes" pill (syncQueueChanged) — bottom-right badge.
//   2. (M1) Server changes with no pending local edit are applied by db.js and the open view
//      draws again by itself (dbRemoteApplied -> chRefreshFromStore). No banner, no reload.
//   3. Persistent "offline — showing local copy" banner (dbOfflineBanner), cleared by the
//      next successful hydration/manifest round-trip (dbHydrated).
//   4. (Phase 2b) A small "Conflict history (N)" link + slide-in panel listing
//      en_conflict_archive entries with a per-entry JSON download button.
//
// This is a first, functional pass — the polished Settings-adjacent placement (2a.7 / Pass
// C2) is a follow-up; this file's job in 2a/2b is just to make the events/conflicts visible
// to a user.
(function () {
  if (typeof window === 'undefined') return;

  function ensureStyles() {
    if (document.getElementById('ch-sync-ui-styles')) return;
    var style = document.createElement('style');
    style.id = 'ch-sync-ui-styles';
    style.textContent =
      // Notices live in ONE stack in the normal page flow, above the header row (first child of the
      // page column). A notice takes its own row. It never covers the header, the tabs or the page.
      '#ch-sync-banner-stack{position:static;flex:0 0 auto;display:flex;flex-direction:column;}' +
      '#ch-sync-banner-stack>div{text-align:center;font-size:13px;padding:6px 12px;display:none;}' +
      '#ch-sync-offline-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-signedout-banner,#ch-sync-foreign-banner,#ch-sync-hydrate-failed-banner,#ch-sync-auth-rejected-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-signedout-banner button,#ch-sync-foreign-banner button,#ch-sync-hydrate-failed-banner button{margin-left:8px;border-radius:4px;padding:2px 10px;font-size:12px;' +
      'font-family:inherit;cursor:pointer;border:1px solid #fff;background:transparent;color:#fff;}' +
      '#ch-sync-archive-full-banner{background:var(--warn,#b45309);color:#fff;}' +
      '#ch-sync-archive-full-banner button{margin-left:8px;border-radius:4px;padding:2px 10px;font-size:12px;' +
      'font-family:inherit;cursor:pointer;border:1px solid #fff;background:transparent;color:#fff;}' +
      // --- Phase 2b: conflict history viewer -------------------------
      // Conflict history link: plain text in the sidebar footer, next to the Sync status link.
      '#ch-archive-link{background:none;border:0;padding:0;font-size:inherit;font-family:inherit;letter-spacing:inherit;' +
      'color:var(--text2,#9aa3b8);text-decoration:underline;cursor:pointer;}' +
      '#ch-archive-link:hover{color:var(--text,#fff);}' +
      '.ch-conflict-meta{color:var(--text2,#9aa3b8);font-size:12px;}' +
      '.ch-conflict-btn{border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;' +
      'cursor:pointer;border:1px solid var(--border,#333);background:var(--s3,#1e2438);' +
      'color:var(--text,#fff);font-family:inherit;}' +
      '.ch-conflict-btn:hover{background:var(--s4,#252c42);}' +
      '.ch-conflict-btn:disabled{cursor:not-allowed;}' +
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
      '#ch-sync-status-btn.ch-sync-status-inline{background:none;border:0;border-radius:0;' +
      'box-shadow:none;padding:0;font-size:inherit;font-family:inherit;letter-spacing:inherit;color:var(--text2,#9aa3b8);' +
      'text-decoration:underline;}' +
      '#ch-sync-status-btn.ch-sync-status-inline:hover{background:none;color:var(--text,#fff);}' +
      '#ch-sync-status-btn[data-sync-level=warn]{color:var(--warn,#b45309);font-weight:600;}' +
      '#ch-sync-status-btn[data-sync-level=bad]{color:var(--danger,#dc2626);font-weight:600;}' +
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
      '#ch-ver-update-link{background:none;border:0;padding:0;font-size:inherit;font-family:inherit;letter-spacing:inherit;' +
      'color:var(--text2,#9aa3b8);text-decoration:underline;cursor:pointer;}' +
      '#ch-ver-update-link:hover{color:var(--text,#fff);}' +
      '.sb-version .ch-sb-link-row{display:block;margin-top:4px;}' +
      '.sb-version .ch-sb-link-row button{display:block;margin:0 auto;}' +
      '.sb-version .ch-sb-sep{display:none;}' +
      '.sb-version #en-sb-version-text:not(:empty) ~ .ch-sb-sep{display:inline;}';
    document.head.appendChild(style);
  }

  function ensureStack() {
    var stack = document.getElementById('ch-sync-banner-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'ch-sync-banner-stack';
      var col = document.querySelector('.app-col');
      if (col) col.insertBefore(stack, col.firstChild);
      else document.body.insertBefore(stack, document.body.firstChild);
    }
    return stack;
  }
  window.chNoticeStack = ensureStack;
  window.chSidebarLink = function (id) {
    ensureStyles();
    return ensureSidebarLink(id);
  };

  // The Conflict history link sits in the sidebar footer under the version line, as plain
  // text links. No sidebar (login page): it stays hidden.
  function ensureSidebarLink(id) {
    var el = document.getElementById(id);
    if (el) return el;
    var host = document.querySelector('.sb-version');
    if (!host) return null;
    var row = document.getElementById('ch-sb-link-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'ch-sb-link-row';
      row.className = 'ch-sb-link-row';
      host.appendChild(row);
    }
    el = document.createElement('button');
    el.id = id;
    el.type = 'button';
    el.style.display = 'none';
    row.appendChild(el);
    return el;
  }

  function ensureEl(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      if (
        /^ch-sync-(banner|offline-banner|archive-full-banner|signedout-banner|foreign-banner|hydrate-failed-banner|auth-rejected-banner)$/.test(
          id,
        )
      ) {
        ensureStack().appendChild(el);
      } else {
        document.body.appendChild(el);
      }
    }
    return el;
  }

  // The ONE place that decides what the sync status says. Inputs: unsynced count, offline, sign-in refused.
  // The ONE element that shows it: the "Sync status" link in the sidebar (renderSyncStatusButton).
  var _syncState = { depth: 0, offline: false, refused: false };
  function syncStatusView() {
    var s = _syncState;
    if (s.refused) return { text: 'Sync status (sign-in refused)', level: 'bad', short: 'Refused', title: 'The server refused this sign-in. Changes stay in this browser.' };
    if (s.offline) return { text: 'Sync status (offline)', level: 'warn', short: 'Offline', title: 'Offline. Showing the local copy. Edits sync when reconnected.' };
    if (s.depth > 0) {
      var n = s.depth + ' unsynced';
      return { text: 'Sync status (' + n + ')', level: 'warn', short: 'Sync ' + s.depth, title: s.depth + ' change' + (s.depth === 1 ? '' : 's') + ' not yet sent to the server.' };
    }
    return { text: 'Sync status', level: 'ok', short: 'Sync', title: 'Open the sync status panel' };
  }
  function setSyncState(patch) {
    Object.keys(patch).forEach(function (k) {
      _syncState[k] = patch[k];
    });
    renderSyncStatusButton();
  }

  // The ONE text of the offline banner. `waiting` = the first read of the saved data keeps failing
  // (db.js _holdForFirstPull): say what failed, that nothing is saved until it loads, that it retries.
  // The technical detail is on hover (title).
  function offlineBannerText(waiting, what) {
    if (!waiting) return 'Offline — showing local copy. Edits will sync when reconnected.';
    return (
      'Could not load ' +
      (what || 'your saved data') +
      ' from the server. Nothing is saved until it loads. Retrying automatically.'
    );
  }
  function renderOfflineBanner(show, waiting, what, detail) {
    ensureStyles();
    var el = ensureEl('ch-sync-offline-banner');
    el.textContent = offlineBannerText(!!waiting, what);
    el.title = waiting && detail ? 'Detail: ' + detail : '';
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
        return (
          o.count +
          ' unsent change' +
          (o.count === 1 ? '' : 's') +
          ' from ' +
          o.email +
          ' - sign in as that user to send them.'
        );
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
    el.textContent =
      'Could not load ' + n + ' saved item' + (n === 1 ? '' : 's') + ' from the server. Some data may be missing. ';
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
    setSyncState({ depth: depth });
  });

  // The shared database holds newer records. db.js has already merged them into the store
  // (it keeps a record that has a pending local edit and retries it on the next check).
  // The page holds its own in-memory lists, so 'chRefreshFromStore' (handled by app/core.js and the
  // EMS Leads pages) reads the store into them at once (draw: false) and draws the open view when it
  // is safe. The user does nothing. Two rules keep the user's work safe:
  //  1. Dirty view: a trusted input or change event inside the open view (not inside a dialog) marks
  //     the view dirty. A dirty view is not drawn again; the redraw stays pending. The mark clears and
  //     the pending redraw runs when the page saves data ('dataUpdated' from app/db.js), or when the
  //     user leaves the view or changes a tab ('chViewChanged' from app/core.js). Values that script
  //     code fills in never mark the view dirty. No timer.
  //  2. Open dialog or modal: the redraw waits until it closes (local 1 s check, no server call).
  //  View state (page and panel scroll positions, expanded rows, selected rows by key) is kept.
  // Data safety is not decided here: a save from a dirty view goes through the version-checked write
  // and the conflict rule in app/db.js.
  var PENDING_REFRESH_RETRY_MS = 1000;
  var OPEN_DIALOG_SELECTOR =
    '.modal-bg.open, .ems-modal-bg.open, .modal-overlay.open, .modal.open, dialog[open]';
  var STATE_CLASSES = ['open', 'expanded', 'selected', 'sel'];
  var SCROLL_KEYS = { PageUp: 1, PageDown: 1, Home: 1, End: 1, ArrowUp: 1, ArrowDown: 1, ' ': 1 };
  var _dirty = false;
  var _userScrollTick = 0;
  var _pendingRefreshKeys = [];
  var _pendingRefreshTimer = null;
  var _conflictTimer = null;

  function _esc(v) {
    return window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&');
  }
  function _viewRoot() {
    return document.querySelector('.view.active') || document.body;
  }
  function _visible(el) {
    if (!el.getClientRects().length) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function _anyVisible(sel) {
    var l = document.querySelectorAll(sel);
    for (var i = 0; i < l.length; i++) if (_visible(l[i])) return true;
    return false;
  }
  // Real user edits only (trusted events): script-filled values never mark the view dirty.
  function _markDirty(e) {
    var t = e.target;
    if (!e.isTrusted || !t || !t.closest) return;
    if (t.closest(OPEN_DIALOG_SELECTOR)) return; // a dialog has its own rule: the redraw waits until it closes
    if (!_viewRoot().contains(t)) return;
    if (t.closest('[data-ch-filter]')) return; // a filter or search box holds no record data
    _dirty = true;
  }
  document.addEventListener('input', _markDirty, true);
  document.addEventListener('change', _markDirty, true);
  // The edit was saved, or the user left the view: the pending redraw runs after the caller has finished.
  function _clearDirty() {
    _dirty = false;
    if (_pendingRefreshKeys.length) setTimeout(_refreshWhenSafe, 0);
  }
  // Read-only answers for app/report-engine.js chSafeToReload (automatic reload to a new version).
  window.chViewIsDirty = function () { return _dirty; };
  window.chDialogIsOpen = function () { return _anyVisible(OPEN_DIALOG_SELECTOR); };
  window.addEventListener('dataUpdated', _clearDirty);
  window.addEventListener('chViewChanged', _clearDirty);
  ['wheel', 'touchstart', 'touchmove'].forEach(function (n) {
    window.addEventListener(n, function (e) { if (e.isTrusted) _userScrollTick++; }, { capture: true, passive: true });
  });
  window.addEventListener(
    'keydown',
    function (e) { if (e.isTrusted && SCROLL_KEYS[e.key]) _userScrollTick++; },
    true,
  );
  function _pathOf(el) {
    var idx = [];
    while (el && el !== document.body && !el.id) {
      var par = el.parentNode;
      if (!par) return null;
      idx.unshift(Array.prototype.indexOf.call(par.children, el));
      el = par;
    }
    if (!el) return null;
    return { anchor: el === document.body ? '' : el.id, idx: idx };
  }
  function _byPath(p) {
    var el = p.anchor ? document.getElementById(p.anchor) : document.body;
    for (var i = 0; el && i < p.idx.length; i++) el = el.children[p.idx[i]];
    return el || null;
  }
  function _captureViewState() {
    var st = { scrolls: [], page: [window.scrollX, window.scrollY], classes: [], opens: [], tick: _userScrollTick };
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.scrollTop > 0 || e.scrollLeft > 0) {
        var p = _pathOf(e);
        if (p) st.scrolls.push({ path: p, top: e.scrollTop, left: e.scrollLeft });
      }
    }
    var root = _viewRoot();
    Array.prototype.forEach.call(root.querySelectorAll('details[open]'), function (d) {
      var p = _pathOf(d);
      if (p) st.opens.push(p);
    });
    STATE_CLASSES.forEach(function (c) {
      Array.prototype.forEach.call(root.querySelectorAll('.' + c), function (e) {
        // A row is found again by its record key, never by its position. No key: its mark is not restored.
        var key = e.getAttribute('data-id') || e.id;
        if (key) st.classes.push({ key: key, byData: !!e.getAttribute('data-id'), cls: c, tag: e.tagName });
      });
    });
    return st;
  }
  function _restoreScrolls(st) {
    if (st.tick !== _userScrollTick) return; // the user scrolled since the redraw: leave the view where they put it
    st.scrolls.forEach(function (s) {
      var e = _byPath(s.path);
      if (e) {
        e.scrollTop = s.top;
        e.scrollLeft = s.left;
      }
    });
    window.scrollTo(st.page[0], st.page[1]);
  }
  function _restoreViewState(st) {
    st.opens.forEach(function (p) {
      var d = _byPath(p);
      if (d && d.tagName === 'DETAILS') d.open = true;
    });
    var root = _viewRoot();
    st.classes.forEach(function (c) {
      var e = c.byData ? root.querySelector('[data-id="' + _esc(c.key) + '"]') : document.getElementById(c.key);
      if (!e || e.tagName !== c.tag || !e.parentNode || e.classList.contains(c.cls)) return;
      var sibs = Array.prototype.filter.call(e.parentNode.children, function (x) {
        return x.classList.contains(c.cls);
      });
      if (!sibs.length) e.classList.add(c.cls);
    });
    _restoreScrolls(st);
    // Charts and tables that fill in a moment later can move the panel; put the positions back once more,
    // but only if the user has not scrolled since the redraw.
    setTimeout(function () {
      _restoreScrolls(st);
    }, 300);
  }
  function _scheduleRefreshRetry(ms) {
    if (_pendingRefreshTimer) clearTimeout(_pendingRefreshTimer);
    _pendingRefreshTimer = setTimeout(function () {
      _pendingRefreshTimer = null;
      _refreshWhenSafe();
    }, ms);
  }
  function _refreshWhenSafe() {
    if (_pendingRefreshTimer) {
      clearTimeout(_pendingRefreshTimer);
      _pendingRefreshTimer = null;
    }
    if (!_pendingRefreshKeys.length) return;
    if (_anyVisible(OPEN_DIALOG_SELECTOR)) {
      _scheduleRefreshRetry(PENDING_REFRESH_RETRY_MS);
      return;
    }
    if (_dirty) return; // the keys stay pending; a save or a view change runs the redraw (no timer)
    var keys = _pendingRefreshKeys;
    _pendingRefreshKeys = [];
    var st = _captureViewState();
    window.dispatchEvent(new CustomEvent('chRefreshFromStore', { detail: { keys: keys } }));
    _restoreViewState(st);
  }
  // A user switch or sign-out ends the pending refresh: the change was for the previous user.
  window.addEventListener('chAuthStateChanged', function () {
    if (_pendingRefreshTimer) {
      clearTimeout(_pendingRefreshTimer);
      _pendingRefreshTimer = null;
    }
    if (_conflictTimer) {
      clearTimeout(_conflictTimer);
      _conflictTimer = null;
    }
    _pendingRefreshKeys = [];
    _dirty = false;
  });
  window.addEventListener('dbRemoteApplied', function (e) {
    var keys = (e.detail && e.detail.keys) || [];
    keys.forEach(function (k) {
      if (_pendingRefreshKeys.indexOf(k) < 0) _pendingRefreshKeys.push(k);
    });
    // The page lists read the store now, even when the view must wait.
    window.dispatchEvent(new CustomEvent('chRefreshFromStore', { detail: { keys: keys, draw: false } }));
    // After a conflict choice (reason 'conflict-resolved') the "Your choices were saved" message shows first.
    if (e.detail && e.detail.reason === 'conflict-resolved') {
      if (_conflictTimer) clearTimeout(_conflictTimer);
      _conflictTimer = setTimeout(function () {
        _conflictTimer = null;
        _refreshWhenSafe();
      }, CONFLICT_RELOAD_DELAY_MS);
    } else _refreshWhenSafe();
  });
  var CONFLICT_RELOAD_DELAY_MS = 2500;

  window.addEventListener('dbOfflineBanner', function (e) {
    var d = (e && e.detail) || {};
    renderOfflineBanner(true, d.waiting === true, d.what, d.detail);
    setSyncState({ offline: true });
  });

  // M6: the server answered 401/403. This is not "offline": the sign-in was refused.
  window.addEventListener('dbAuthRejected', function (e) {
    ensureStyles();
    var el = ensureEl('ch-sync-auth-rejected-banner');
    var code = (e.detail && e.detail.status) || 403;
    el.textContent =
      'The server refused this sign-in (error ' +
      code +
      '). Your changes stay in this browser and are not syncing. Sign out and sign in again, or ask your administrator for access.';
    el.style.display = 'block';
    setSyncState({ refused: true });
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
    var rej = document.getElementById('ch-sync-auth-rejected-banner');
    if (rej) rej.style.display = 'none';
    setSyncState({ offline: false, refused: false });
  });

  // Initial paint once DB is ready, in case a queue already had entries left
  // over from a prior offline session.
  window.addEventListener('dbReady', function () {
    if (window.DB && typeof window.DB.getQueueDepth === 'function') {
      setSyncState({ depth: window.DB.getQueueDepth() });
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
    ['en_eqmatrix_', 'this equipment matrix'],
    ['en_pricing_', 'this pricing data'],
    ['en_report_history', 'the report history'],
    ['en_report_templates_', 'the report templates'],
    ['en_bas_snap_', 'this building automation schedule copy'],
    ['en_bas_hist_', 'this building automation schedule history'],
    ['en_bas_acthist_', 'this schedule action history'],
    ['en_bas_groups_', 'these scheduling groups'],
    ['en_bas_schedhistory_', 'this building automation schedule history record'],
    ['en_bas_auditevents_', 'these stored audit log events'],
    ['en_bas_', 'this building automation trend data'],
    ['en_alarms_', 'this alarm log'],
    ['en_audit_', 'this facility audit'],
    ['en_hours_', 'this hours log'],
    ['en_cal_', 'this calendar feed copy'],
    ['en_space_map_', 'this space map'],
    ['en_sched_actions_', 'these calendar schedule actions'],
    ['en_budget_', 'this budget data'],
    ['en_customers', 'the customer list'],
    ['en_deleted_records', 'the deletion records'],
    ['en_presented_savings', 'the presented-to-client savings marks'],
    ['en_agreement_', 'this service agreement setup'],
    ['en_value_corrections', 'the value corrections log'],
    ['en_wdd_', 'this weather data'],
    ['en_louisburg_facility_map', 'the Louisburg facility name list'],
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

  function fmtDate(iso) {
    if (!iso) return 'an unknown time';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return String(iso);
    }
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

  window.SyncConflictUI = window.SyncConflictUI || {};
  window.SyncConflictUI.describeConflictEntry = describeConflictEntry;

  // --- Conflict-archive viewer ----------------------------------------------
  // --- Conflict history wording ---------------------------------------------
  // The ONE place an archive entry becomes a sentence. Internal reason codes never show.
  // lookup = { projectName(key) -> string|'' }, built from the real project and customer lists.
  var KEY_PROJECT_PREFIXES = [
    'en_utility_', 'en_eqmatrix_', 'en_pricing_', 'en_bas_snap_', 'en_bas_hist_', 'en_bas_acthist_',
    'en_bas_groups_', 'en_bas_schedhistory_', 'en_bas_auditevents_', 'en_bas_', 'en_alarms_', 'en_audit_',
    'en_hours_', 'en_cal_', 'en_space_map_', 'en_sched_actions_', 'en_budget_', 'en_agreement_', 'en_wdd_',
  ];
  function conflictLabelLookup() {
    function list(k) {
      var v = window.DB && typeof window.DB.get === 'function' ? window.DB.get(k) : null;
      return Array.isArray(v) ? v : [];
    }
    return {
      projectName: function (key) {
        for (var i = 0; i < KEY_PROJECT_PREFIXES.length; i++) {
          var pre = KEY_PROJECT_PREFIXES[i];
          if (key.indexOf(pre) !== 0) continue;
          var id = key.slice(pre.length);
          var all = list('en_projects').concat(list('en_customers'));
          for (var j = 0; j < all.length; j++) {
            if (all[j] && String(all[j].id) === id) return all[j].name || all[j].title || '';
          }
          return '';
        }
        return '';
      },
    };
  }
  function _noun(key) {
    var f = friendlyKeyName(key).replace(/^(this|the|these|a|an)\s+/i, '');
    return f.charAt(0).toUpperCase() + f.slice(1);
  }
  function _plainDateTime(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return 'an unknown time';
    return (
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    );
  }
  function describeConflictEntry(entry, lookup) {
    var key = String(entry.key || '');
    var proj = lookup && lookup.projectName ? lookup.projectName(key) : '';
    var lv = entry.losingValue;
    var rec =
      entry.recordId !== undefined && lv && typeof lv === 'object' && !Array.isArray(lv)
        ? [lv.name, lv.title, lv.label, lv.text, lv.equipName, lv.equipType].find(function (x) {
            return typeof x === 'string' && x;
          }) || 'a record'
        : '';
    // Example: "Equipment matrix, AHU-1 (Project name)": the list, the record, then the project.
    var who = _noun(key) + (rec ? ', ' + rec : '') + (proj ? ' (' + proj + ')' : '');
    var when = _plainDateTime(entry.winningUpdatedAt || entry.archivedAt);
    var mine = 'Download your version to compare.';
    var theirs = 'Download their version to compare.';
    var r = entry.reason;
    var text;
    var button = 'Download your version';
    if (r === 'write-conflict-tombstone') {
      text = who + ': another user deleted this on ' + when + '. Their deletion was kept. ' + mine;
    } else if (r === 'deleted-elsewhere') {
      text = who + ': another user deleted some items that you had changed. The deletion was kept. Download the deleted items to compare.';
      button = 'Download the deleted items';
    } else if (r === 'queue-entry-no-owner') {
      text = who + ': an edit that was not sent yet could not be matched to a user, so it was not applied. Download it to see it.';
      button = 'Download the edit';
    } else if (entry.winningSide === 'local' && entry.losingSide === 'server' && entry.losingDeleted) {
      text = who + ': another user deleted this on ' + when + '. Your later save was kept.';
      button = 'Download your version';
    } else if (entry.winningSide === 'local') {
      text = who + ': another user saved a different version on ' + when + '. Your later save was kept. ' + theirs;
      button = 'Download their version';
    } else if (r === 'hydration-server-wins' || r === 'write-conflict-server-wins' || r === 'record-conflict') {
      text = who + ': another user saved a newer version on ' + when + '. Their version was kept. ' + mine;
    } else {
      text = who + ': a change was set aside on ' + when + '. ' + mine;
    }
    return { text: text, button: button };
  }

  function renderArchiveLink() {
    ensureStyles();
    var archive = window.DB && typeof window.DB.getConflictArchive === 'function' ? window.DB.getConflictArchive() : [];
    var el = ensureSidebarLink('ch-archive-link');
    if (!el) return;
    if (archive.length > 0) {
      el.textContent = 'Past conflicts (' + archive.length + ')';
      el.title = 'These are saved copies of conflicts that are already resolved.';
      el.setAttribute('data-sync-short', 'Past ' + archive.length);
      el.style.display = '';
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
    title.textContent = 'Past conflicts (' + sorted.length + ')';
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
    if (sorted.length) {
      var intro = document.createElement('div');
      intro.className = 'ch-conflict-meta';
      intro.style.marginBottom = '10px';
      intro.textContent =
        'These conflicts are already resolved. Each entry is a saved copy of a change that was set aside when ' +
        'two people saved the same item. You can download a copy.';
      body.appendChild(intro);
    }
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
      var desc = describeConflictEntry(entry, conflictLabelLookup());
      meta.textContent = desc.text;
      var dl = document.createElement('button');
      dl.className = 'ch-conflict-btn';
      dl.textContent = desc.button;
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
  // What Conflict history shows depends on who is signed in (DB.getConflictArchive):
  // on an identity change close the open panel and redraw the link for the new user.
  window.addEventListener('chAuthStateChanged', function () {
    var panel = document.getElementById('ch-archive-panel');
    if (panel) panel.classList.remove('ch-open');
    renderArchiveLink();
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

  // The Sync status button sits in the sidebar, on the version line ("v... · Sync status").
  // A page with no sidebar version line (the login page) shows no sync status.
  function renderSyncStatusButton() {
    ensureStyles();
    var el = document.getElementById('ch-sync-status-btn');
    if (!el) {
      el = document.createElement('button');
      el.id = 'ch-sync-status-btn';
      el.type = 'button';
      var host = document.querySelector('.sb-version');
      if (host) {
        el.className = 'ch-sync-status-inline';
        // Separator shows only when the version text before it is not empty (CSS rule in ensureStyles).
        var sep = document.createElement('span');
        sep.className = 'ch-sb-sep';
        sep.textContent = ' · ';
        host.appendChild(sep);
        host.appendChild(el);
      } else {
        return; // no sidebar (login page): no sync status shown
      }
    }
    var v = syncStatusView();
    el.textContent = v.text;
    el.title = v.text + '. ' + v.title;
    el.setAttribute('data-sync-short', v.short);
    el.setAttribute('data-sync-level', v.level);
    el.style.display = '';
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
    // Failed keys by name with the HTTP status (db.js getQueueFailures / describeFailure).
    var fails = window.DB && window.DB.getQueueFailures ? window.DB.getQueueFailures() : [];
    fails.forEach(function (f) {
      var line = document.createElement('div');
      line.className = 'ch-sync-status-failure';
      line.textContent =
        window.DB.describeFailure(f) + (f.permanent ? ' - the server will not accept this value' : ' - will retry');
      row.appendChild(line);
    });
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
        ' items could not upload yet: ' +
        (p.failures || [])
          .slice(0, 5)
          .map(function (f) {
            return window.DB.describeFailure(f);
          })
          .join(', ') +
        ((p.failures || []).length > 5 ? ' and ' + (p.failures.length - 5) + ' more' : '') +
        '. They wait in the sync queue and retry by themselves.'
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
