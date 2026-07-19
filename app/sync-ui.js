// app/sync-ui.js — passive UI for the client sync engine (Phase 2a, folds in 2a.5's pill
// and 2a.6's "refresh" banner, per phase2a-build-plan.md §3).
//
// Listens ONLY to events app/db.js already dispatches; has no dependency on DB internals.
// Renders three small, non-blocking UI elements:
//   1. "N unsynced changes" pill (syncQueueChanged) — bottom-right badge.
//   2. Passive "X changed — refresh" banner (remoteChange) — does NOT auto-swap _cache
//      under a live page (supabase-migration-plan-FINAL-2026-07-19.md §2.4 — no silent
//      live-merge in v1).
//   3. Persistent "offline — showing local copy" banner (dbOfflineBanner), cleared by the
//      next successful hydration/manifest round-trip (dbHydrated).
//
// This is a first, functional pass — the polished Settings-adjacent placement (2a.7 / Pass
// C2) is a follow-up; this file's job in 2a is just to make the events visible to a user.
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
      '#ch-sync-offline-banner{background:var(--warn,#b45309);color:#fff;}';
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
  });
})();
