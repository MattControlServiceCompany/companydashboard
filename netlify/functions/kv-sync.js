// netlify/functions/kv-sync.js
//
// Shared-backend replication endpoint for CompanyHub's kv store.
// GET  ?key=<key>                          -> current row or 404
// PUT  {key, value, baseVersion, updatedBy} -> atomic conditional write
//
// Conflict model: per-key optimistic concurrency, one integer `version`.
// baseVersion === null means "I believe this key is new" -> plain insert.
// baseVersion === N means "I last saw version N" -> UPDATE ... WHERE
// key=$1 AND version=$2, a single atomic Postgres statement via PostgREST's
// PATCH+filter. 0 rows affected -> 409 with the current server row. The
// server NEVER silently merges or overwrites — see backend-migration-plan
// §2b. Last-write-wins is explicitly rejected.
//
// Auth: none in this slice (Entra JWT verification is Phase 1, later).
// This function is reachable by anyone who can reach the deployed site's
// URL — acceptable for this slice because the deployed site itself is a
// throwaway/branch spike, not production. Revisit before any real cutover.

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

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    // Deliberately does not echo env var names/values.
    return respond(500, { error: 'Backend misconfigured — env vars not set.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const key = event.queryStringParameters && event.queryStringParameters.key;
      if (!key) return respond(400, { error: 'Missing ?key=' });
      const row = await fetchRow(key);
      if (!row) return respond(404, { found: false });
      return respond(200, {
        found: true,
        key: row.key,
        value: row.value,
        version: row.version,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      });
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { key, value, baseVersion, updatedBy } = body;
      if (!key || value === undefined) return respond(400, { error: 'Missing key or value' });

      if (baseVersion === null || baseVersion === undefined) {
        // Believed-new key: plain insert at version 1.
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/kv`, {
          method: 'POST',
          headers: pgHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify([
            { key, value, version: 1, updated_by: updatedBy || null, updated_at: new Date().toISOString() },
          ]),
        });
        if (insertRes.status === 201) {
          return respond(200, { version: 1 });
        }
        // 409/23505 = unique_violation -> someone else inserted first.
        const current = await fetchRow(key);
        return respond(409, { conflict: true, current: rowToConflict(current) });
      }

      // Existing key: atomic conditional UPDATE via PostgREST filter.
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&version=eq.${baseVersion}`,
        {
          method: 'PATCH',
          headers: pgHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify({
            value,
            version: baseVersion + 1,
            updated_by: updatedBy || null,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      const patched = await patchRes.json();
      if (Array.isArray(patched) && patched.length === 1) {
        return respond(200, { version: baseVersion + 1 });
      }
      // 0 rows matched -> version mismatch (or key missing). Conflict.
      const current = await fetchRow(key);
      return respond(409, { conflict: true, current: rowToConflict(current) });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    // Log the error message only — never log headers/env.
    console.error('[kv-sync] error:', err && err.message);
    return respond(500, { error: 'Internal error' });
  }
};

async function fetchRow(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=*`, {
    headers: pgHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function rowToConflict(row) {
  if (!row) return null;
  return { value: row.value, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

function respond(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
