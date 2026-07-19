// netlify/functions/pdf-sync.js
//
// Shared-backend replication endpoint for CompanyHub's PDF blob store.
// Mirrors netlify/functions/kv-sync.js's auth stub (verifyAuth), error-
// handling posture (502 = real backend failure, 409 = expected content
// conflict, 400 = caller/protocol error), and Supabase service-key access
// pattern -- see kv-sync.js's header for the full rationale; only
// PDF-specific differences are re-explained below.
//
// Per supabase-migration-plan-FINAL-2026-07-19.md §6 and phase2a-build-
// plan.md §6 (R5): PDFs are content-addressed-ish and IMMUTABLE -- a key is
// written once and never edited, unlike kv's per-key CAS/version machinery.
// Re-PUT of IDENTICAL content at an existing key is a silent no-op
// (idempotent retry, e.g. after a network hiccup). PUT of DIFFERENT content
// at an EXISTING key is refused (409) -- this should never legitimately
// happen since keys are derived from content, but the server never
// silently overwrites, matching kv-sync's "never silently merge or
// overwrite" invariant.
//
// R5 (measured 2026-07-19): gzip does NOT help here -- PDFs are already-
// compressed binary. The real fix is a CHUNK protocol, because Netlify's
// ~6MB synchronous-Function body cap is far below real combined-bill PDFs
// (measured up to 64.33MB base64 for Baker's largest combined gas bill).
// Both upload and download are chunked; small blobs (the common case --
// typical monthly bills are ~0.4MB base64) use a single PUT/GET with zero
// chunking overhead. The one-time bulk PDF seed migration (Phase 3) bypasses
// this Function entirely (direct-to-Storage from home with the service
// key), so chunking here is only for ONGOING per-PDF uploads/downloads.
//
// No schema/SQL change is used or needed by this file -- it talks only to
// the already-live private `pdf_blobs` Storage bucket (RLS-locked,
// service-role only, see netlify/db/schema.sql), never the `kv` table.
// Because there is no companion metadata table in scope for this task,
// existence/size/hash checks are all done directly against Storage (a
// cheap 1-byte Range GET for size/existence; a full download only when a
// hash comparison is actually required -- see storageStat()/commitObject()
// below). This means there is nowhere to persist "who uploaded this PDF"
// today; verifyAuth() is still called (keeping the same seam kv-sync.js
// uses) but its result is not persisted anywhere in this slice -- a known,
// accepted gap given the "no schema change" scope of this task.
//
// API shape (for the client pass to build against):
//
//   GET  ?key=<key>
//     -> small blob (raw size <= SINGLE_SHOT_LIMIT_BYTES):
//          {found:true, key, chunked:false, size, sha256, base64}
//     -> large blob (raw size >  SINGLE_SHOT_LIMIT_BYTES):
//          {found:true, key, chunked:true, size, totalChunks, chunkSize}
//          (no base64 -- caller must then GET each chunk)
//     -> missing: {found:false}  (HTTP 404)
//
//   GET  ?key=<key>&chunkIndex=<n>            (n is 0-based)
//     -> {found:true, key, chunked:true, chunkIndex, totalChunks, chunkSize,
//         size, base64Chunk}
//        base64Chunk is the raw byte range [n*chunkSize, min((n+1)*chunkSize,
//        size)) of the object, fetched via a Storage Range GET (the Function
//        never buffers more than one chunk of the object at a time for a
//        chunked download).
//
//   PUT  {key, base64, sha256}
//     -> single-shot upload for raw size <= SINGLE_SHOT_LIMIT_BYTES.
//        Verifies sha256(base64) === provided sha256 (400 if not), then:
//          - key absent            -> upload (upsert:false), 200 {ok:true, noop:false}
//          - key present, same hash -> 200 {ok:true, noop:true}   (idempotent retry)
//          - key present, diff hash -> 409 {conflict:true}        (never overwrites)
//        400 if the decoded payload exceeds SINGLE_SHOT_LIMIT_BYTES --
//        caller must use the chunked protocol below instead.
//
//   PUT  {key, uploadId, chunkIndex, totalChunks, chunkBase64, finalSha256,
//         totalSize}
//     -> chunked upload, one PUT per chunk (chunkIndex 0..totalChunks-1).
//        Each chunk is staged as its OWN Storage object at
//        `_staging/<uploadId>/<chunkIndex>` (upsert:true -- a single chunk
//        is always safe to retry). Non-final chunks respond
//        {ok:true, uploadId, chunkIndex, totalChunks, received:true,
//         finalized:false}.
//        On the FINAL chunk (chunkIndex === totalChunks-1) the server:
//          1. downloads every staged chunk 0..totalChunks-1 IN ORDER
//             (400, no commit, if any chunk is missing -- an incomplete
//             upload NEVER reaches the real key),
//          2. concatenates them and computes SHA-256 of the assembled
//             buffer,
//          3. compares that hash to `finalSha256` (and, if provided,
//             `totalSize` to the assembled length) -- 400, no commit, on
//             any mismatch ("corrupt/incomplete chunk sequence"),
//          4. only on a full match, commits the assembled buffer through
//             the IDENTICAL existence/hash-compare/upload path the
//             small-blob PUT uses (so chunked and single-shot uploads share
//             one commit implementation, one set of guarantees),
//          5. deletes the staging chunks unconditionally afterward (success,
//             no-op, 409, or 400) so nothing accumulates at `_staging/*`
//             on the happy path.
//        A crash mid-chunk-sequence (before the final chunk's finalize
//        step runs) leaves orphaned `_staging/<uploadId>/*` objects and
//        NEVER writes anything at the real key -- documented, accepted
//        limitation; no periodic sweep is built here (out of scope for
//        this task, flagged in the implementer report).
//
// Auth: identical stub to kv-sync.js's verifyAuth(event) -- Phase 1 swaps
// only that function's body later; every other line in this file is
// unaffected. All PDF traffic must relay through this Function (the office
// firewall blocks direct signed URLs to *.supabase.co) -- there is no
// direct-to-Storage path in the shipped app, only in the one-time bulk
// migration script run from home (§6.4 of the migration plan).
// Must NEVER be deployed to a public/production URL before Phase 1 auth
// ships (R3, hard constraint) -- branch-deploy with dummy data only, or
// local test.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const BUCKET = 'pdf_blobs';

// Raw-byte threshold: below this, GET/PUT are single-shot (no chunking
// overhead) -- covers the common case (typical monthly bills ~0.4MB
// base64/~0.3MB raw). Above this, both directions require the chunk
// protocol. 4MB raw -> ~5.33MB base64, safely under Netlify's ~6MB
// synchronous-Function body cap even with JSON-wrapper overhead.
const SINGLE_SHOT_LIMIT_BYTES = 4 * 1024 * 1024;

// Raw bytes per chunk (upload and download). 3MB raw -> ~4MB base64 per
// chunk, comfortably under the ~6MB cap with headroom for JSON overhead.
const CHUNK_SIZE = 3 * 1024 * 1024;

// --- Auth stub seam (mirrors kv-sync.js §4 of the migration plan) ----------
// Phase 1 swaps ONLY this function's body for real JWT verification
// (JWKS, iss/tid/aud/exp, allowlist) -- no other line in this file changes.
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

// --- CORS/abuse posture (migration plan §4 item 5) --------------------------
// Same posture kv-sync.js is expected to adopt in Phase 1: the Function
// answers only its own origin; auth (still a stub here) is the real gate.
// Soft check: if ALLOWED_ORIGIN is set AND the request carries an Origin
// header that doesn't match, reject. No Origin header (server-to-server,
// curl, Node test/migration scripts) or ALLOWED_ORIGIN unset (branch-
// deploy/dev default) -- allow through.
function originAllowed(event) {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return true;
  const origin = getHeader(event, 'origin');
  if (!origin) return true;
  return origin === allowed;
}

function sha256HexBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function objectPath(key) {
  // Keys are opaque app-supplied strings (see bill-analysis.js pdfKey /
  // en_pdf_shared_*, en_pdf_file_* naming); Storage object paths must not
  // start with a slash. No other normalization -- the caller gets back
  // exactly the key it PUT.
  return String(key).replace(/^\/+/, '');
}

function stagingKey(uploadId, chunkIndex) {
  return `_staging/${encodeURIComponent(String(uploadId))}/${chunkIndex}`;
}

function storageHeaders(extra) {
  // Never log this object or spread it into a response body/console.log.
  return Object.assign(
    {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
    extra || {},
  );
}

function storageObjectUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath(path)}`;
}

// Downloads an object (optionally a byte range). Returns
// {buffer, status, contentRange} or null on 404.
async function storageDownload(path, range) {
  const headers = storageHeaders(range ? { Range: `bytes=${range[0]}-${range[1]}` } : {});
  const res = await fetch(storageObjectUrl(path), { headers });
  if (res.status === 404) return null;
  if (res.status !== 200 && res.status !== 206) {
    const text = await safeText(res);
    throw new Error(`Storage download failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return {
    status: res.status,
    buffer: Buffer.from(arrayBuf),
    contentRange: res.headers.get('content-range'),
  };
}

// Cheap existence+size check via a 1-byte Range GET (this REST surface has
// no lightweight HEAD-with-size for private objects, so a 1-byte range read
// is the cheapest reliable way to learn total size + existence in one call).
// Returns {size} or null if the object doesn't exist.
async function storageStat(path) {
  const result = await storageDownload(path, [0, 0]);
  if (!result) return null;
  const m = /\/(\d+)\s*$/.exec(result.contentRange || '');
  if (m) return { size: Number(m[1]) };
  // A backend that ignores a 1-byte Range on a tiny/empty object and just
  // returns 200 with the full body -- fall back to actual buffer length.
  return { size: result.buffer.length };
}

async function storageUpload(path, buffer, upsert) {
  return fetch(storageObjectUrl(path), {
    method: 'POST',
    headers: storageHeaders({
      'Content-Type': 'application/pdf',
      'x-upsert': upsert ? 'true' : 'false',
    }),
    body: buffer,
  });
}

async function storageDeleteMany(paths) {
  if (!paths || !paths.length) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: storageHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths.map(objectPath) }),
    });
  } catch (err) {
    // Cleanup failure must never fail the parent request -- worst case is
    // an orphaned staging object, which is the same accepted limitation as
    // a mid-upload crash (see file header).
    console.error('[pdf-sync] staging cleanup error:', err && err.message);
  }
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    // Deliberately does not echo env var names/values.
    return respond(500, { error: 'Backend misconfigured — env vars not set.' });
  }
  if (!originAllowed(event)) {
    return respond(403, { error: 'Origin not allowed' });
  }

  try {
    // Establishes the auth seam for every request (Phase 1 will make this
    // actually reject); result is not persisted anywhere in this slice —
    // see file header ("no companion metadata table in scope").
    verifyAuth(event);

    if (event.httpMethod === 'GET') return await handleGet(event);
    if (event.httpMethod === 'PUT') return await handlePut(event);
    return respond(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[pdf-sync] error:', err && err.message);
    return respond(500, { error: 'Internal error' });
  }
};

async function handleGet(event) {
  const qs = event.queryStringParameters || {};
  const key = qs.key;
  if (!key) return respond(400, { error: 'Missing ?key=' });

  if (qs.chunkIndex !== undefined) {
    const chunkIndex = Number(qs.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return respond(400, { error: 'chunkIndex must be a non-negative integer' });
    }
    const stat = await storageStat(key);
    if (!stat) return respond(404, { found: false });
    const totalChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE));
    if (chunkIndex >= totalChunks) {
      return respond(400, { error: `chunkIndex ${chunkIndex} out of range (totalChunks=${totalChunks})` });
    }
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, stat.size) - 1;
    const dl = await storageDownload(key, [start, end]);
    if (!dl) return respond(404, { found: false });
    return respond(200, {
      found: true,
      key,
      chunked: true,
      chunkIndex,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      size: stat.size,
      base64Chunk: dl.buffer.toString('base64'),
    });
  }

  const stat = await storageStat(key);
  if (!stat) return respond(404, { found: false });

  if (stat.size <= SINGLE_SHOT_LIMIT_BYTES) {
    const dl = await storageDownload(key, null);
    if (!dl) return respond(404, { found: false });
    return respond(200, {
      found: true,
      key,
      chunked: false,
      size: stat.size,
      sha256: sha256HexBuf(dl.buffer),
      base64: dl.buffer.toString('base64'),
    });
  }

  const totalChunks = Math.ceil(stat.size / CHUNK_SIZE);
  return respond(200, {
    found: true,
    key,
    chunked: true,
    size: stat.size,
    totalChunks,
    chunkSize: CHUNK_SIZE,
  });
}

async function handlePut(event) {
  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}';
    body = JSON.parse(raw);
  } catch (err) {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { key } = body;
  if (!key) return respond(400, { error: 'Missing key' });

  if (body.uploadId !== undefined) {
    return await handleChunkedPut(key, body);
  }
  return await handleSmallPut(key, body);
}

async function handleSmallPut(key, body) {
  const { base64, sha256 } = body;
  if (typeof base64 !== 'string' || !base64) return respond(400, { error: 'Missing base64' });
  if (typeof sha256 !== 'string' || !sha256) return respond(400, { error: 'Missing sha256' });

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    return respond(400, { error: 'Invalid base64' });
  }

  if (buffer.length > SINGLE_SHOT_LIMIT_BYTES) {
    return respond(400, {
      error: `Payload too large for single-shot PUT (${buffer.length} bytes > ${SINGLE_SHOT_LIMIT_BYTES}); use the chunked upload protocol instead.`,
    });
  }

  const actualHash = sha256HexBuf(buffer);
  if (actualHash !== sha256) {
    return respond(400, { error: 'sha256 mismatch — provided hash does not match uploaded content' });
  }

  return await commitObject(key, buffer, actualHash);
}

async function handleChunkedPut(key, body) {
  const { uploadId, chunkIndex, totalChunks, chunkBase64, finalSha256, totalSize } = body;
  if (!uploadId) return respond(400, { error: 'Missing uploadId' });
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return respond(400, { error: 'chunkIndex must be a non-negative integer' });
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1) {
    return respond(400, { error: 'totalChunks must be a positive integer' });
  }
  if (chunkIndex >= totalChunks) return respond(400, { error: 'chunkIndex out of range' });
  if (typeof chunkBase64 !== 'string' || !chunkBase64) return respond(400, { error: 'Missing chunkBase64' });
  if (typeof finalSha256 !== 'string' || !finalSha256) {
    return respond(400, {
      error: 'Missing finalSha256 (sha256 of the FULL assembled content — required on every chunk request)',
    });
  }

  let chunkBuf;
  try {
    chunkBuf = Buffer.from(chunkBase64, 'base64');
  } catch (err) {
    return respond(400, { error: 'Invalid chunkBase64' });
  }
  if (chunkBuf.length > CHUNK_SIZE) {
    return respond(400, { error: `Chunk too large (${chunkBuf.length} bytes > ${CHUNK_SIZE})` });
  }

  const stagePath = stagingKey(uploadId, chunkIndex);
  const stageRes = await storageUpload(stagePath, chunkBuf, true); // upsert:true — a single chunk is always safe to retry
  if (!(stageRes.status === 200 || stageRes.status === 201)) {
    const errText = await safeText(stageRes);
    console.error('[pdf-sync] chunk stage failed:', stageRes.status, errText.slice(0, 300));
    return respond(502, { error: 'Backend chunk stage failed' });
  }

  if (chunkIndex < totalChunks - 1) {
    return respond(200, { ok: true, uploadId, chunkIndex, totalChunks, received: true, finalized: false });
  }

  return await finalizeChunkedUpload(key, uploadId, totalChunks, finalSha256, totalSize);
}

async function finalizeChunkedUpload(key, uploadId, totalChunks, finalSha256, totalSize) {
  const stagePaths = Array.from({ length: totalChunks }, (_, i) => stagingKey(uploadId, i));

  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const dl = await storageDownload(stagePaths[i], null);
    if (!dl) {
      // Missing chunk — never commit a partial/corrupt object at `key`.
      await storageDeleteMany(stagePaths.slice(0, i)); // best-effort cleanup of what did land
      return respond(400, {
        error: `Incomplete upload — missing chunk ${i} of ${totalChunks}. Nothing was committed at key "${key}". Re-send all chunks under a new uploadId.`,
      });
    }
    parts.push(dl.buffer);
  }

  const assembled = Buffer.concat(parts);
  if (typeof totalSize === 'number' && assembled.length !== totalSize) {
    await storageDeleteMany(stagePaths);
    return respond(400, {
      error: `Assembled size mismatch: expected ${totalSize}, got ${assembled.length}. Nothing committed at key "${key}". Re-upload under a new uploadId.`,
    });
  }

  const assembledHash = sha256HexBuf(assembled);
  if (assembledHash !== finalSha256) {
    await storageDeleteMany(stagePaths);
    return respond(400, {
      error: `Assembled content sha256 (${assembledHash}) does not match finalSha256 (${finalSha256}) — corrupt/incomplete chunk sequence. Nothing committed at key "${key}". Re-upload under a new uploadId.`,
    });
  }

  const commitResponse = await commitObject(key, assembled, assembledHash);
  await storageDeleteMany(stagePaths); // clean up staging regardless of the commit outcome (noop/success/409)
  return commitResponse;
}

// Shared commit path for BOTH single-shot and finalized-chunked uploads —
// one implementation, one set of write-once guarantees. `buffer`'s SHA-256
// has already been verified by the caller to equal `hash` before this runs.
async function commitObject(key, buffer, hash) {
  const existing = await storageStat(key);
  if (existing) {
    return await resolveAgainstExisting(key, buffer, hash, existing);
  }

  const uploadRes = await storageUpload(key, buffer, false); // upsert:false — write-once
  if (uploadRes.status === 200 || uploadRes.status === 201) {
    return respond(200, { ok: true, key, sha256: hash, size: buffer.length, noop: false });
  }
  if (uploadRes.status === 400 || uploadRes.status === 409) {
    // Race: another request created `key` between our existence check and
    // this upload (two concurrent uploads of "the same" new PDF, or
    // upsert:false rejecting because it now exists). Re-resolve exactly
    // like the pre-existing-object branch — never silently overwrite.
    const raced = await storageStat(key);
    if (raced) return await resolveAgainstExisting(key, buffer, hash, raced);
  }
  const errText = await safeText(uploadRes);
  console.error('[pdf-sync] upload failed:', uploadRes.status, errText.slice(0, 300));
  return respond(502, { error: 'Backend upload failed' });
}

async function resolveAgainstExisting(key, buffer, hash, existingStat) {
  if (existingStat.size !== buffer.length) {
    // Sizes differ -> guaranteed different content; skip the full download.
    return respond(409, { conflict: true, key, error: 'Different content already exists at this key (size mismatch)' });
  }
  // Sizes coincide -> only a full hash compare can tell retry-of-identical-
  // content apart from a genuine (should-never-happen) collision.
  const dl = await storageDownload(key, null);
  const existingHash = dl ? sha256HexBuf(dl.buffer) : null;
  if (existingHash === hash) {
    return respond(200, { ok: true, key, sha256: hash, size: buffer.length, noop: true });
  }
  return respond(409, { conflict: true, key, error: 'Different content already exists at this key' });
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (err) {
    return '';
  }
}

function respond(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
