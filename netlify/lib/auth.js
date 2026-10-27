'use strict';
// Single copy of the Supabase Auth JWT check used by every Netlify Function
// (kv-sync, pdf-sync, calendar-fetch). Moved here unchanged from kv-sync.js.
// verifyAuth(event) is the ONE seam that owns the caller identity. It checks
// signature, issuer and audience against the Supabase Auth keys, then checks
// the token email against the AUTHORIZED_USERS allowlist (env var).
// Throws AuthError(401) for a missing or bad token, AuthError(403) when the
// email is not allowed.
const { jwtVerify, createRemoteJWKSet } = require('jose');

const SUPABASE_URL = process.env.SUPABASE_URL;

// Public Supabase project identifiers (safe to commit — the project ref/URL
// is not a secret; only the service_role/JWT-signing secret keys are).
// Project ref rrdugvwxtddjywqykphf — see docs/dashboardlogic.md.
const SUPABASE_AUTH_ISSUER = `${SUPABASE_URL}/auth/v1`;
// Supabase Auth access tokens always carry `aud: 'authenticated'` for a
// signed-in user.
const SUPABASE_EXPECTED_AUDIENCE = 'authenticated';
// Test-only seam: NEVER set in production. Lets unit tests point JWKS
// fetches at a local mock server instead of the real Supabase project.
// Undefined in every real deploy -> falls through to the real JWKS URL.
const JWKS_URL = process.env.CH_TEST_JWKS_URL || `${SUPABASE_AUTH_ISSUER}/.well-known/jwks.json`;

// createRemoteJWKSet's returned function caches fetched keys internally and
// is created once at module scope, so the cache persists across warm
// Netlify Function invocations (only re-fetches on a cache-miss/cooldown
// expiry or an unrecognized `kid`) — this satisfies the "cache JWKS across
// warm invocations" requirement without any extra bookkeeping here.
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

// AuthError carries the HTTP status the caller should respond with —
// 401 for a missing/unverifiable/expired token, 403 for a token that
// verifies fine (valid Supabase Auth signature/issuer/audience) but whose
// email isn't allow-listed.
class AuthError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

function _authorizedUsers() {
  return (process.env.AUTHORIZED_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// --- Auth (§4 of the migration plan; Supabase Auth replaces Entra) ---------
// Supabase Auth JWT verification. Every other line that needs the caller's
// identity calls this — never trusts `updatedBy` from the request body.
async function verifyAuth(event) {
  const authHeader = getHeader(event, 'authorization');
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
    throw new AuthError(401, 'Missing bearer token');
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new AuthError(401, 'Missing bearer token');

  let payload;
  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: SUPABASE_AUTH_ISSUER,
      audience: SUPABASE_EXPECTED_AUDIENCE,
    });
    payload = result.payload;
  } catch (err) {
    // Covers bad signature, expired (exp), not-yet-valid (nbf), wrong
    // issuer, and wrong audience — all "this is not a valid token for
    // this API", which is a 401, not a 403.
    throw new AuthError(401, 'Invalid or expired token');
  }

  const email = (payload.email || '').toLowerCase();
  if (!email) throw new AuthError(401, 'Token has no email claim');

  const allowlist = _authorizedUsers();
  if (!allowlist.includes(email)) {
    throw new AuthError(403, 'Not authorized');
  }

  return { email };
}

function getHeader(event, name) {
  if (!event || !event.headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(event.headers)) {
    if (k.toLowerCase() === lower) return event.headers[k];
  }
  return undefined;
}

module.exports = { verifyAuth, AuthError, getHeader };
