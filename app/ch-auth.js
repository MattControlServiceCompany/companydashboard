// app/ch-auth.js
//
// Shared Supabase Auth (email + password) helper for the `kv.sync`/`pdf.sync`
// backend API scope. Replaces the Entra ID (Azure AD) / MSAL layer entirely
// — Phase 1 shipped Entra, but the M365 app requires Azure tenant admin
// consent that isn't obtainable, so this module switches the SAME public
// interface over to Supabase Auth's REST API instead. No MSAL, no
// supabase-js dependency (this is a no-build, plain-script-tag app) — plain
// `fetch` calls against the Supabase Auth REST endpoints.
//
// Loaded on the three db.js-loading pages (index.html, energy-department.html,
// ems-leads.html). Exposes exactly one global,
// `window.CH_AUTH`, which `app/db.js`'s `_authHeaders()` already reads (that
// call site is unchanged by this file).
//
// IMPORTANT — `_authHeaders()` calls `window.CH_AUTH.getToken()`
// SYNCHRONOUSLY (no `await`). This module keeps a session (access_token +
// refresh_token + expires_at) in localStorage under `ch_sb_session` (shared
// across tabs/pages — a session started on one department page is usable
// when a new tab is opened directly to another), refreshes the access token
// in the background before it expires, and `getToken()` just returns the
// last token it already has cached in memory (or `null` if signed out /
// refresh failed).
//
// The actual sign-in UI (email + password form) lives in index.html's login
// screen and calls `window.CH_AUTH.signIn(email, password)` /
// `window.CH_AUTH.signOut()` — new methods added here alongside the existing
// getToken()/getUserId()/isSignedOut() interface that db.js already depends
// on, so db.js needed no changes.
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Supabase project — see docs/dashboardlogic.md / supabase-migration-plan.
  // This URL is not a secret (it's the public REST host for the project).
  var SUPABASE_URL = 'https://rrdugvwxtddjywqykphf.supabase.co';
  // PUBLIC anon/publishable key — safe to ship in client code by design (it
  // only grants what Supabase's Row Level Security policies allow an
  // anonymous/authenticated caller; it is NOT the service_role secret key,
  // which must NEVER appear here or anywhere in client code). Fill this in
  // from the Supabase dashboard: Project Settings -> API -> "anon" /
  // "publishable" key.
  var SUPABASE_ANON_KEY = 'sb_publishable_YZEN55mO8GQQacXSFOe8jg_xRVOLlta';

  var TOKEN_ENDPOINT = SUPABASE_URL + '/auth/v1/token';
  var LOGOUT_ENDPOINT = SUPABASE_URL + '/auth/v1/logout';
  var SESSION_STORAGE_KEY = 'ch_sb_session'; // { access_token, refresh_token, expires_at (epoch seconds), user_id, email }
  var REFRESH_INTERVAL_MS = 5 * 60 * 1000; // background check cadence
  var REFRESH_MARGIN_SECONDS = 5 * 60; // refresh once within 5 min of expiry

  var _cachedToken = null; // string | null — read synchronously by getToken()
  var _cachedEmail = null; // string | null — shown in the unsent-changes bar
  var _cachedUserId = null; // string | null — Supabase auth user UUID (durable per-user id)
  var _signedOut = true; // true whenever nobody has a valid session
  var _refreshTimer = null;
  var _refreshInFlight = null; // Promise | null — de-dupes overlapping refresh calls

  // THE single backend-mode reader (db.js, sync-ui.js, core.js, site-functions.js
  // all call CH_AUTH.backendMode()). Returns 'off' | 'on'.
  //  - Only the PRODUCTION Netlify host syncs: exactly cscdashboard.netlify.app.
  //    Every other host (deploy previews, other Netlify sites) is 'off'. Signed in = ALWAYS 'on',
  //    in every browser. There is no per-browser switch: a stored
  //    ch_backend_mode / ch_backend_enabled value from an older version is
  //    ignored and removed. Signed out = 'off' (nothing is pushed; the
  //    sign-in prompt shows).
  //  - EVERY other host (github.io testing host, localhost, file://, previews,
  //    custom domains): always 'off'. /.netlify/functions does not exist
  //    there, so there must be zero sync calls.
  function _isNetlifyHost() {
    var h = typeof location !== 'undefined' ? location.hostname || '' : '';
    return h.toLowerCase() === 'cscdashboard.netlify.app';
  }
  function _dropLegacyModeFlags() {
    try {
      localStorage.removeItem('ch_backend_mode');
      localStorage.removeItem('ch_backend_enabled');
    } catch (e) {
      /* storage unavailable: nothing to remove */
    }
  }
  function backendMode() {
    if (typeof localStorage === 'undefined') return 'off';
    if (!_isNetlifyHost()) return 'off';
    if (_signedOut) return 'off';
    _dropLegacyModeFlags();
    return 'on';
  }

  function _loadSession() {
    if (typeof localStorage === 'undefined') return null;
    var raw;
    try {
      raw = localStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string') return s;
    } catch (e) {
      /* fall through */
    }
    return null;
  }

  function _saveSession(session) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (e) {
      /* non-fatal — in-memory cache below still works for this tab/session */
    }
  }

  function _clearSession() {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
    }
    _cachedToken = null;
    _cachedUserId = null;
    _cachedEmail = null;
  }

  function _setSignedOut(signedOut) {
    var changed = _signedOut !== signedOut;
    _signedOut = signedOut;
    if (changed) {
      window.dispatchEvent(new CustomEvent('chAuthStateChanged', { detail: { signedOut: signedOut } }));
    }
  }

  // One identity-change path: a changed user id sends chAuthStateChanged just like
  // a sign-in or sign-out does (db.js bumps its identity epoch on it), even when
  // the signed-out flag did not change (another tab switched accounts).
  function _applySession(session) {
    var prevId = _cachedUserId;
    _cachedToken = session && session.access_token ? session.access_token : null;
    _cachedUserId = session && session.user_id ? session.user_id : null;
    _cachedEmail = session && session.email ? session.email : null;
    var wasSignedOut = _signedOut;
    _setSignedOut(!_cachedToken);
    if (_signedOut === wasSignedOut && prevId !== _cachedUserId) {
      window.dispatchEvent(new CustomEvent('chAuthStateChanged', { detail: { signedOut: _signedOut } }));
    }
  }

  // Normalizes a Supabase Auth token-endpoint response body into the shape
  // this module persists. Supabase returns `expires_at` (epoch seconds) on
  // most SDKs' underlying REST response; fall back to `expires_in` (seconds
  // from now) if `expires_at` is absent, which the raw REST endpoint used
  // here provides instead.
  function _sessionFromTokenResponse(body) {
    var nowSec = Math.floor(Date.now() / 1000);
    var expiresAt = typeof body.expires_at === 'number' ? body.expires_at : nowSec + (Number(body.expires_in) || 3600);
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: expiresAt,
      user_id: body.user && body.user.id ? body.user.id : null,
      email: body.user && body.user.email ? body.user.email : null,
    };
  }

  async function _tokenRequest(qs, payload) {
    var res = await fetch(TOKEN_ENDPOINT + '?' + qs, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    var body;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    if (!res.ok || !body || !body.access_token) {
      var msg = (body && (body.error_description || body.msg || body.error)) || 'Sign-in failed (' + res.status + ')';
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // Public, user-initiated: email + password sign-in. Resolves on success
  // (session is stored + cached + chAuthStateChanged dispatched), throws on
  // failure — caller (the login form) shows the error, never falls back to
  // any other auth mode.
  async function signIn(email, password) {
    var body = await _tokenRequest('grant_type=password', { email: email, password: password });
    var session = _sessionFromTokenResponse(body);
    _saveSession(session);
    _applySession(session);
    return { userId: session.user_id, email: session.email };
  }

  // Silent refresh using the stored refresh_token. Never prompts the user —
  // a failure here just means "signed out", surfaced via chAuthStateChanged
  // so the app can show the login screen again.
  async function _refresh(session) {
    var body = await _tokenRequest('grant_type=refresh_token', { refresh_token: session.refresh_token });
    var next = _sessionFromTokenResponse(body);
    // Supabase Auth rotates the refresh_token on every use; if the response
    // omits one for some reason, keep the previous refresh_token rather than
    // dropping the session.
    if (!next.refresh_token) next.refresh_token = session.refresh_token;
    _saveSession(next);
    _applySession(next);
    return next;
  }

  // De-duped: if a refresh is already in flight (e.g. two tabs' timers fire
  // close together), callers await the same promise instead of racing two
  // refresh_token grants (Supabase rotates refresh tokens, so the loser of a
  // race would get an already-invalidated token).
  function _refreshIfNeeded() {
    if (_refreshInFlight) return _refreshInFlight;
    var session = _loadSession();
    if (!session) {
      _applySession(null);
      return Promise.resolve(null);
    }
    var nowSec = Math.floor(Date.now() / 1000);
    if (session.expires_at - nowSec > REFRESH_MARGIN_SECONDS) {
      // Still fresh — just make sure the in-memory cache matches storage
      // (e.g. another tab refreshed since our last check).
      _applySession(session);
      return Promise.resolve(session);
    }
    return _startRefresh(session);
  }

  function _startRefresh(session) {
    _refreshInFlight = _refresh(session)
      .catch(function (e) {
        // Refresh token invalid/expired/revoked — sign the user out locally.
        _clearSession();
        _setSignedOut(true);
        return null;
      })
      .then(function (result) {
        _refreshInFlight = null;
        return result;
      });
    return _refreshInFlight;
  }

  // THE single rule for a server answer of 401/403 (kv-sync poll, kv-sync queue
  // drain, pdf-sync queue drain all use withAuthRetry). 401 = the token was
  // refused: refresh ONCE and let the caller send again. A second 401, or any 403
  // (account not allowed), ends the session locally. That sets "signed out",
  // so backendMode() is 'off' (every timer goes quiet), the signed-out bar
  // shows, and a new sign-in (chAuthStateChanged) restarts everything.
  function _onServerRefusal(status, alreadyRetried) {
    if (status === 401 && !alreadyRetried) {
      if (_refreshInFlight) return _refreshInFlight.then(function (s) { return !!s; });
      var session = _loadSession();
      if (!session) {
        _applySession(null);
        return Promise.resolve(false);
      }
      return _startRefresh(session).then(function (s) {
        return !!s;
      });
    }
    _clearSession();
    _setSignedOut(true);
    return Promise.resolve(false);
  }

  // run() does one request. It either throws an Error with .httpStatus or
  // returns an object with .httpStatus when the server refused. Returns/throws
  // exactly what run() did on the final attempt.
  async function withAuthRetry(run) {
    for (var tries = 0; ; tries++) {
      var idBefore = _cachedUserId;
      var out;
      var threw = false;
      try {
        out = await run();
      } catch (e) {
        out = e;
        threw = true;
      }
      var st = out && out.httpStatus;
      if (st !== 401 && st !== 403) {
        if (threw) throw out;
        return out;
      }
      var again = await _onServerRefusal(st, tries > 0);
      // The refresh picked up a different account (another tab switched users).
      // This request was built for the old user: never send it again as the new one.
      if (again && _cachedUserId !== idBefore) again = false;
      if (!again) {
        if (threw) throw out;
        return out;
      }
    }
  }

  // M7: the first refresh at page load. A stored token that already expired is
  // primed into the cache synchronously, so a request sent before this refresh
  // ends would carry a dead token. db.js awaits ready() before its first request.
  var _startupRefresh = Promise.resolve(null);
  function ready() {
    return _startupRefresh;
  }

  function _startBackgroundRefresh() {
    if (backendMode() === 'off') return; // kill switch — no network on load
    if (_refreshTimer) return;
    _startupRefresh = _refreshIfNeeded();
    _refreshTimer = setInterval(_refreshIfNeeded, REFRESH_INTERVAL_MS);
  }

  // Explicit, user-initiated sign-out. Best-effort revokes the refresh token
  // server-side; clears the local session regardless of whether that call
  // succeeds.
  async function signOut() {
    var session = _loadSession();
    _clearSession();
    _setSignedOut(true);
    if (session && session.access_token) {
      try {
        await fetch(LOGOUT_ENDPOINT + '?scope=global', {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + session.access_token,
          },
        });
      } catch (e) {
        /* non-fatal — local session is already cleared */
      }
    }
  }

  // SYNCHRONOUS by design — see module header comment. Returns the last
  // refreshed token, or null (never blocks on a network call).
  function getToken() {
    return _cachedToken;
  }

  // No interactive popup exists for a password-based flow (unlike the old
  // MSAL popup fallback) — this resolves to whatever a background refresh
  // can produce, for interface compatibility with any existing caller.
  async function getTokenInteractive() {
    await _refreshIfNeeded();
    return _cachedToken;
  }

  function getEmail() {
    return _cachedEmail;
  }

  // THE single place that forgets the saved display name (ch_user). Called by
  // core.js signOut, the signed-out bar Sign in button and index.html.
  function clearSavedUser() {
    try {
      sessionStorage.removeItem('ch_user');
      localStorage.removeItem('ch_user');
    } catch (e) {
      /* storage unavailable */
    }
  }

  function isSignedOut() {
    return _signedOut;
  }

  // SYNCHRONOUS by design — mirrors getToken() above. Returns the durable
  // per-user identifier (the Supabase auth user UUID, `sub` claim) for the
  // currently signed-in account, or null if nobody is signed in. Consumed by
  // app/db.js's per-user-settings-sync key-prefixing (`_wireKey`).
  function getUserId() {
    return _cachedUserId;
  }

  // True when this page is on the sync host but nobody holds a valid session.
  // THE single "must sign in" rule: index.html auto-login, core.js auto-enter
  // and the signed-out bar in sync-ui.js all call this.
  function needsSignIn() {
    return _isNetlifyHost() && _signedOut;
  }

  window.CH_AUTH = {
    needsSignIn: needsSignIn,
    getToken: getToken,
    getTokenInteractive: getTokenInteractive,
    ready: ready,
    isSignedOut: isSignedOut,
    backendMode: backendMode,
    getUserId: getUserId,
    getEmail: getEmail,
    clearSavedUser: clearSavedUser,
    isSyncHost: _isNetlifyHost,
    signIn: signIn,
    signOut: signOut,
    withAuthRetry: withAuthRetry,
  };

  // Prime the in-memory cache from any existing localStorage session
  // immediately (synchronously) so a same-tab getToken() call right after
  // load doesn't race the async refresh below.
  (function primeFromStorage() {
    var session = _loadSession();
    if (session) _applySession(session);
  })();

  _startBackgroundRefresh();
})();
