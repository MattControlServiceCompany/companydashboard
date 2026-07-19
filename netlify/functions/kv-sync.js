// netlify/functions/kv-sync.js
//
// Shared-backend replication endpoint for CompanyHub's kv store.
// GET  ?manifest=1                         -> [{key, version, hash, deleted}] for every row (tiny)
// GET  ?keys=a,b,c                         -> [{key, value, version, deleted}] for the given keys
// GET  ?key=<key>                          -> current row or 404
// PUT  {key, value, baseVersion}           -> atomic conditional write
// PUT  {key, deleted:true, baseVersion}    -> atomic conditional tombstone (no `value`)
//
// Conflict model: per-key optimistic concurrency, one integer `version`.
// baseVersion === null means "I believe this key is new" -> plain insert.
// baseVersion === N means "I last saw version N" -> UPDATE ... WHERE
// key=$1 AND version=$2, a single atomic Postgres statement via PostgREST's
// PATCH+filter. 0 rows affected -> 409 with the current server row. The
// server NEVER silently merges or overwrites — see backend-migration-plan
// §2b. Last-write-wins is explicitly rejected.
//
// Deletes are CAS-checked tombstones, never a physical row removal
// (supabase-migration-plan-FINAL-2026-07-19.md §3, integration #1):
// `PUT {key, deleted:true, baseVersion}` goes through the IDENTICAL CAS
// UPDATE path as a normal write — it sets `deleted = true` and bumps
// `version`, but the row is never deleted and `value`/`hash` are never
// touched (so a later un-delete can restore the last real value). Any
// normal (non-tombstone) PUT always sets `deleted = false`, so a fresh
// CAS-PUT against a tombstoned key un-deletes it (the "Restore my version"
// conflict-modal action, per §5 of the plan).
//
// hash: every write (insert or update) computes SHA-256 of a canonical
// (stable-key-sorted) JSON serialization of `value` and stores it in the
// `hash` column at write time. This is what the (forthcoming) manifest
// endpoint will return — the hash is NEVER recomputed from the raw jsonb
// column at read time, because jsonb key ordering is not guaranteed stable
// across reads/writes and would silently break manifest hash comparisons on
// the client (finding F8).
//
// kv_history: on an EXPLICIT overwrite only (client sets `explicitOverwrite:
// true` in the PUT body — i.e. the user chose "Overwrite with mine" in the
// conflict modal), the row about to be replaced is snapshotted into
// `kv_history` (key, value, version, updated_by, replaced_at) BEFORE the
// overwrite lands. This does not run on every write — only on a flagged
// conflict-resolution overwrite — and a retention cap (last N per key AND
// max age) keeps the free-tier DB bounded (finding F10).
//
// Auth: stub only in this slice (Entra JWT verification is Phase 1, later).
// `verifyAuth(event)` is the ONE seam Phase 1 will change the body of —
// every other line that needs the caller's identity calls it, never trusts
// `updatedBy` from the request body (server-assigned identity, closes the
// spoofing gap named in the migration plan §4/§11 task 1.2).
// This function is reachable by anyone who can reach the deployed site's
// URL — acceptable for this slice because the deployed site itself is a
// throwaway/branch spike, not production. Must not be deployed to a public
// production URL before Phase 1 auth ships (R3).

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function pgHeaders(extra) {
  // Never log this object or spread it into a response body/console.log.
  return Object.assign(
    {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    extra || {},
  );
}

// --- Auth stub seam (§4 of the migration plan) -----------------------------
// Phase 1 swaps ONLY this function's body for real JWT verification
// (JWKS, iss/tid/aud/exp, allowlist) — no other line in this file changes.
function verifyAuth(event) {
  return { email: getHeader(event, 'x-stub-user') || 'dev-stub@local' };
}

function getHeader(event, name) {
  if (!event || !event.headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(event.headers)) {
    if (k.toLowerCase() === lower) return event.headers[k];
  }
  return undefined;
}

// --- canonical JSON + hash (F8) ---------------------------------------------
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    // Deliberately does not echo env var names/values.
    return respond(500, { error: 'Backend misconfigured — env vars not set.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};
      if (qs.manifest !== undefined) return await handleManifest();
      if (qs.keys !== undefined) return await handleBatchGet(qs.keys);
      const key = qs.key;
      if (!key) return respond(400, { error: 'Missing ?key=, ?keys=, or ?manifest=1' });
      const row = await fetchRow(key);
      if (!row) return respond(404, { found: false });
      return respond(200, {
        found: true,
        key: row.key,
        value: row.value,
        version: row.version,
        hash: row.hash,
        deleted: !!row.deleted,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      });
    }

    if (event.httpMethod === 'PUT') {
      return await handlePut(event);
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    // Log the error message only — never log headers/env.
    console.error('[kv-sync] error:', err && err.message);
    return respond(500, { error: 'Internal error' });
  }
};

async function handlePut(event) {
  const body = JSON.parse(event.body || '{}');
  const { key, baseVersion } = body;
  const isTombstone = body.deleted === true;
  const value = body.value;

  if (!key) return respond(400, { error: 'Missing key' });
  if (!isTombstone && value === undefined) return respond(400, { error: 'Missing value' });

  // Server-assigned identity — never trust `updatedBy` from the request body.
  const updatedBy = verifyAuth(event).email;
  const nowIso = new Date().toISOString();

  if (baseVersion === null || baseVersion === undefined) {
    if (isTombstone) {
      return respond(400, { error: 'Cannot tombstone a key with no baseVersion — key must already exist' });
    }
    // Believed-new key: plain insert at version 1.
    const hash = sha256Hex(canonicalJSON(value));
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/kv`, {
      method: 'POST',
      headers: pgHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify([
        { key, value, version: 1, hash, deleted: false, updated_by: updatedBy, updated_at: nowIso },
      ]),
    });
    if (insertRes.status === 201) {
      return respond(200, { version: 1, hash, deleted: false });
    }
    // 409/23505 = unique_violation -> someone else inserted first.
    const current = await fetchRow(key);
    return respond(409, { conflict: true, current: rowToConflict(current) });
  }

  // Existing key: atomic conditional UPDATE via PostgREST filter.
  // Fetch the pre-image first — needed both for a 409's `current` payload
  // and (if this write is an explicit overwrite that succeeds) for the
  // kv_history snapshot of exactly the row being replaced.
  const beforeRow = await fetchRow(key);

  let patchBody;
  let newHash = beforeRow ? beforeRow.hash : null;
  if (isTombstone) {
    // Tombstone (integration #1): the SAME CAS UPDATE path as a normal
    // write, version-checked and never a physical row DELETE. `value`/
    // `hash` are deliberately untouched so a later "Restore my version"
    // can un-delete by simply writing a fresh non-tombstone value.
    patchBody = { deleted: true, version: baseVersion + 1, updated_by: updatedBy, updated_at: nowIso };
  } else {
    newHash = sha256Hex(canonicalJSON(value));
    // Any normal write un-deletes the key (deleted:false) — this is what
    // backs the conflict modal's "Restore my version" action.
    patchBody = {
      value,
      hash: newHash,
      deleted: false,
      version: baseVersion + 1,
      updated_by: updatedBy,
      updated_at: nowIso,
    };
  }

  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&version=eq.${baseVersion}`,
    {
      method: 'PATCH',
      headers: pgHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(patchBody),
    },
  );
  const patched = await patchRes.json();
  if (Array.isArray(patched) && patched.length === 1) {
    if (body.explicitOverwrite === true && beforeRow) {
      await snapshotHistory(beforeRow);
    }
    return respond(200, { version: baseVersion + 1, hash: newHash, deleted: !!isTombstone });
  }
  // 0 rows matched -> version mismatch (or key missing/already-tombstoned
  // at a different version). Conflict — a queued write replaying against a
  // tombstoned key lands here too, which is what powers the delete-specific
  // conflict-modal wording on the client (integration #1).
  const current = await fetchRow(key);
  return respond(409, { conflict: true, current: rowToConflict(current) });
}

// --- kv_history snapshot-on-explicit-overwrite (§5, F10) -----------------------

const HISTORY_MAX_PER_KEY = 20;
const HISTORY_MAX_AGE_DAYS = 30;

async function snapshotHistory(beforeRow) {
  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/kv_history`, {
      method: 'POST',
      headers: pgHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify([
        {
          key: beforeRow.key,
          value: beforeRow.value,
          version: beforeRow.version,
          updated_by: beforeRow.updated_by,
          replaced_at: new Date().toISOString(),
        },
      ]),
    });
    if (!insertRes.ok) {
      console.error('[kv-sync] history snapshot insert failed:', insertRes.status);
      return;
    }
    await enforceHistoryRetention(beforeRow.key);
  } catch (err) {
    // History bookkeeping must never fail the parent PUT.
    console.error('[kv-sync] history snapshot error:', err && err.message);
  }
}

async function enforceHistoryRetention(key) {
  // Cap 1: keep only the most recent HISTORY_MAX_PER_KEY rows for this key.
  const overflowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/kv_history?key=eq.${encodeURIComponent(key)}&select=id&order=replaced_at.desc&offset=${HISTORY_MAX_PER_KEY}`,
    { headers: pgHeaders() },
  );
  if (overflowRes.ok) {
    const overflow = await overflowRes.json();
    if (Array.isArray(overflow) && overflow.length) {
      const ids = overflow.map((r) => r.id).join(',');
      await fetch(`${SUPABASE_URL}/rest/v1/kv_history?id=in.(${ids})`, {
        method: 'DELETE',
        headers: pgHeaders(),
      });
    }
  }
  // Cap 2: age-based, across all keys — anything older than the retention window.
  const cutoff = new Date(Date.now() - HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/kv_history?replaced_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE',
    headers: pgHeaders(),
  });
}

async function handleManifest() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?select=key,version,hash,deleted&order=key.asc`, {
    headers: pgHeaders(),
  });
  if (!res.ok) {
    console.error('[kv-sync] manifest fetch failed:', res.status);
    return respond(502, { error: 'Manifest fetch failed' });
  }
  const rows = await res.json();
  return respond(
    200,
    rows.map((r) => ({ key: r.key, version: r.version, hash: r.hash, deleted: !!r.deleted })),
  );
}

async function handleBatchGet(keysParam) {
  const keys = String(keysParam || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) return respond(400, { error: 'Empty ?keys=' });
  const quoted = keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?key=in.(${quoted})&select=key,value,version,deleted`, {
    headers: pgHeaders(),
  });
  if (!res.ok) {
    console.error('[kv-sync] batch fetch failed:', res.status);
    return respond(502, { error: 'Batch fetch failed' });
  }
  const rows = await res.json();
  return respond(
    200,
    rows.map((r) => ({ key: r.key, value: r.value, version: r.version, deleted: !!r.deleted })),
  );
}

async function fetchRow(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=*`, {
    headers: pgHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function rowToConflict(row) {
  if (!row) return null;
  return {
    value: row.value,
    version: row.version,
    hash: row.hash,
    deleted: !!row.deleted,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
