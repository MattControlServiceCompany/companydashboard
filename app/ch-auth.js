// app/ch-auth.js
//
// Shared Entra ID (Azure AD) auth helper for the `kv.sync` backend API scope.
// Phase 1 — supabase-migration-plan-FINAL-2026-07-19.md §4.
//
// Loaded on ALL FOUR db.js-loading pages (index.html, service-department.html,
// energy-department.html, ems-leads.html — integration #5: energy-department
// generates the bulk of sync traffic and previously had NO token source at
// all). Exposes exactly one global, `window.CH_AUTH`, which `app/db.js`'s
// `_authHeaders()` already reads (that call site is unchanged by this file —
// see phase2a-build-plan.md §4, the auth-stub seam Pass A/B built).
//
// IMPORTANT — `_authHeaders()` calls `window.CH_AUTH.getToken()` SYNCHRONOUSLY
// (no `await`). Real MSAL token acquisition (`acquireTokenSilent`) is async,
// so `getToken()` here can't do the network round-trip itself — instead this
// module proactively (silently) refreshes an access token in the background
// on load and on a timer, and `getToken()` just returns the last token it
// already has cached in memory, or `null` if none is available yet/refresh
// failed. This is a deliberate design choice to keep db.js's call site
// untouched (Pass B/2b owns db.js in this phase) — noted for the next person
// who wonders why getToken() isn't `async`.
//
// This is a SEPARATE MSAL PublicClientApplication instance from the one
// index.html/service-department.html use for their Microsoft-Graph-scoped
// user login (M365 object, SCOPES = ['User.Read','Calendars.ReadWrite']).
// Both point at the SAME clientId/tenant/localStorage cache, so MSAL's
// browser-storage account cache is shared across instances — a user signed
// in via the Graph-login flow is visible to this module's
// `getAllAccounts()`/`acquireTokenSilent()` without a second interactive
// login. (Using one PCA instance app-wide is MSAL's official recommendation;
// this two-instance setup is a pragmatic fit for the existing per-page login
// code and works because the cache is shared — flagged here as a candidate
// for a future unification, not a Phase 1 blocker.)
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var CLIENT_ID = '1dcf6406-c4c4-4664-94d0-50bcc2838c9d';
  var TENANT_ID = '3a4273ad-6010-43d3-8bb9-45dfc3a5528d';
  var AUTHORITY = 'https://login.microsoftonline.com/' + TENANT_ID;
  var KV_SYNC_SCOPE = 'api://' + CLIENT_ID + '/kv.sync';
  var REFRESH_INTERVAL_MS = 5 * 60 * 1000; // well under a ~60-75min AT lifetime

  var _msalApp = null;
  var _cachedToken = null; // string | null — read synchronously by getToken()
  var _signedOut = false; // true once a silent refresh has failed mid-session
  var _refreshTimer = null;
  var _initPromise = null;

  // Mirrors app/db.js's _backendMode() EXACTLY (same localStorage key, same
  // off-semantics: unset/'off'/anything-not-'shadow'-or-'on' => 'off',
  // legacy 'ch_backend_enabled'==='true' => 'shadow'). Kept in sync manually
  // — see db.js lines ~49-67. When the flag is off, this module must not
  // make ANY network call on load (byte-for-byte inert requirement).
  function _backendMode() {
    if (typeof localStorage === 'undefined') return 'off';
    var v;
    try {
      v = localStorage.getItem('ch_backend_mode');
    } catch (e) {
      return 'off';
    }
    if (v === 'off' || v === 'shadow' || v === 'on') return v;
    var legacy;
    try {
      legacy = localStorage.getItem('ch_backend_enabled');
    } catch (e) {
      legacy = null;
    }
    if (legacy === 'true') return 'shadow';
    return 'off';
  }

  function _thisPageFile() {
    var path = window.location.pathname.split('/').pop();
    return path || 'index.html';
  }

  function _getMsalApp() {
    if (_msalApp) return _msalApp;
    if (typeof msal === 'undefined' || !msal.PublicClientApplication) return null;
    _msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: window.location.origin + '/' + _thisPageFile(),
      },
      // localStorage (not sessionStorage) so a token acquired in one tab is
      // usable when a new tab is opened directly to e.g.
      // energy-department.html — the normal daily workflow (integration #5).
      cache: { cacheLocation: 'localStorage' },
    });
    return _msalApp;
  }

  function _init() {
    var app = _getMsalApp();
    if (!app) return Promise.resolve(null);
    if (!_initPromise) _initPromise = app.initialize();
    return _initPromise;
  }

  // Finding 3 (adversarial review 2026-07-25/26): getAllAccounts()[0] is
  // "whichever account MSAL happened to cache first", not "whoever is at the
  // keyboard" — the MSAL cache is deliberately SHARED across both PCA
  // instances (see module header) and across every account that has ever
  // signed in on this browser. Once two real users have signed in here, [0]
  // is not reliable, and _wireKey() could stamp a write with the wrong
  // user's oid. setActiveAccount() (called by the sign-in flows in
  // index.html/service-department.html and by this module's own
  // getTokenInteractive()/single-account-fallback below) persists an explicit
  // "who is active" marker in the SAME shared browserStorage (confirmed by
  // reading msal-browser@2.38.3's BrowserCacheManager.setActiveAccount/
  // getActiveAccount — both go through the same configured cacheLocation),
  // so getActiveAccount() here sees it regardless of which PCA instance set
  // it.
  function _account() {
    var app = _getMsalApp();
    if (!app) return null;
    var active = null;
    try {
      active = app.getActiveAccount();
    } catch (e) {
      active = null;
    }
    if (active) return active;
    // No active account tracked yet (e.g. a session that predates this fix,
    // or a fresh cache that was never given an explicit active account).
    // Fall back to a single cached account ONLY when unambiguous — never
    // guess between two or more candidates; treat that as "unknown" instead
    // of silently picking one (that guess is exactly what this fix removes).
    var accts;
    try {
      accts = app.getAllAccounts();
    } catch (e) {
      accts = [];
    }
    if (accts && accts.length === 1) {
      try {
        app.setActiveAccount(accts[0]); // make the resolution sticky going forward
      } catch (e) {
        /* non-fatal — resolution still succeeds this call */
      }
      return accts[0];
    }
    return null; // 0 accounts, or 2+ with none marked active — unknown, not a guess
  }

  function _setSignedOut(signedOut) {
    var changed = _signedOut !== signedOut;
    _signedOut = signedOut;
    if (changed) {
      window.dispatchEvent(new CustomEvent('chAuthStateChanged', { detail: { signedOut: signedOut } }));
    }
  }

  // Silent-only refresh — deliberately never pops an interactive login on
  // its own. A failure here is a UX signal ("signed out — click to sign
  // in"), never a background popup interruption or a silent 401 loop.
  async function _refreshSilent() {
    var app = _getMsalApp();
    if (!app) return;
    try {
      await _init();
      var account = _account();
      if (!account) {
        _cachedToken = null;
        _setSignedOut(true);
        return;
      }
      var result = await app.acquireTokenSilent({ scopes: [KV_SYNC_SCOPE], account: account });
      _cachedToken = result && result.accessToken ? result.accessToken : null;
      _setSignedOut(!_cachedToken);
    } catch (e) {
      _cachedToken = null;
      _setSignedOut(true);
    }
  }

  function _startBackgroundRefresh() {
    if (_backendMode() === 'off') return; // kill switch — no MSAL/network on load
    if (_refreshTimer) return;
    _refreshSilent();
    _refreshTimer = setInterval(_refreshSilent, REFRESH_INTERVAL_MS);
  }

  // Explicit, user-initiated popup fallback — call this from a "click to
  // sign in" UI hook, never automatically from the background timer.
  async function getTokenInteractive() {
    var app = _getMsalApp();
    if (!app) return null;
    try {
      await _init();
      var result = await app.acquireTokenPopup({ scopes: [KV_SYNC_SCOPE] });
      _cachedToken = result && result.accessToken ? result.accessToken : null;
      if (result && result.account) {
        try {
          app.setActiveAccount(result.account); // Finding 3 — keep both PCA instances consistent
        } catch (e) {
          /* non-fatal */
        }
      }
      _setSignedOut(!_cachedToken);
      return _cachedToken;
    } catch (e) {
      _setSignedOut(true);
      return null;
    }
  }

  // SYNCHRONOUS by design — see module header comment. Returns the last
  // silently-refreshed token, or null (never blocks on a network call).
  function getToken() {
    return _cachedToken;
  }

  function isSignedOut() {
    return _signedOut;
  }

  // SYNCHRONOUS by design — mirrors getToken() above. Returns the stable
  // per-user Entra identifier (`localAccountId`, i.e. the token's `oid` claim)
  // for the currently signed-in MSAL account, or null if nobody is signed in.
  // Deliberately NOT email/preferred_username — those can change (e.g. a
  // mail rename) while localAccountId/oid is the durable per-user GUID.
  // Consumed by app/db.js's per-user-settings-sync key-prefixing (`_wireKey`)
  // — added 2026-07-20, per-user-settings-sync feature.
  function getUserId() {
    var acct = _account();
    return acct && acct.localAccountId ? acct.localAccountId : null;
  }

  window.CH_AUTH = {
    getToken: getToken,
    getTokenInteractive: getTokenInteractive,
    isSignedOut: isSignedOut,
    getUserId: getUserId,
  };

  _startBackgroundRefresh();
})();
