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
// Loaded on ALL FOUR db.js-loading pages (index.html, service-department.html,
// energy-department.html, ems-leads.html). Exposes exactly one global,
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
  var SUPABASE_ANON_KEY = '<<FILL_ME: Supabase anon/publishable key>>';

  var TOKEN_ENDPOINT = SUPABASE_URL + '/auth/v1/token';
  var LOGOUT_ENDPOINT = SUPABASE_URL + '/auth/v1/logout';
  var SESSION_STORAGE_KEY = 'ch_sb_session'; // { access_token, refresh_token, expires_at (epoch seconds), user_id, email }
  var REFRESH_INTERVAL_MS = 5 * 60 * 1000; // background check cadence
  var REFRESH_MARGIN_SECONDS = 5 * 60; // refresh once within 5 min of expiry

  var _cachedToken = null; // string | null — read synchronously by getToken()
  var _cachedUserId = null; // string | null — Supabase auth user UUID (durable per-user id)
  var _signedOut = true; // true whenever nobody has a valid session
  var _refreshTimer = null;
  var _refreshInFlight = null; // Promise | null — de-dupes overlapping refresh calls

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
  }

  function _setSignedOut(signedOut) {
    var changed = _signedOut !== signedOut;
    _signedOut = signedOut;
    if (changed) {
      window.dispatchEvent(new CustomEvent('chAuthStateChanged', { detail: { signedOut: signedOut } }));
    }
  }

  function _applySession(session) {
    _cachedToken = session && session.access_token ? session.access_token : null;
    _cachedUserId = session && session.user_id ? session.user_id : null;
    _setSignedOut(!_cachedToken);
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

  function _startBackgroundRefresh() {
    if (_backendMode() === 'off') return; // kill switch — no network on load
    if (_refreshTimer) return;
    _refreshIfNeeded();
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

  window.CH_AUTH = {
    getToken: getToken,
    getTokenInteractive: getTokenInteractive,
    isSignedOut: isSignedOut,
    getUserId: getUserId,
    signIn: signIn,
    signOut: signOut,
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
