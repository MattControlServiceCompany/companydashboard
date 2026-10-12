#!/usr/bin/env node
// scripts/migrate-seed.js -- CompanyHub backup importer (backup file -> Supabase `kv` table + `pdf_blobs` bucket).
//
// Matt runs this, not an agent. It talks straight to Supabase REST and Storage with the
// service-role key and bypasses Netlify (0 Netlify credits).
//
// ── Modes ───────────────────────────────────────────────────────────────────
//   DRY RUN (the default). Makes no write. With --server-file (offline) or --target
//   (read-only GETs) it diffs the backup against the server, per key and per record:
//   new / changed / server-only / identical. The console shows COUNTS only. The full diff
//   (record ids, which records the backup overwrites) goes to a local file under
//   --report-dir (default AI/_context/live-data/diffs/). Never into the repo.
//   APPLY (--apply). Needs --target prod|staging, the URL and the key. Order of work:
//     1. read the server rows of every key the import touches
//     2. save them to <snapshot-dir>/YYYY-MM-DD-HHMM-supabase-snapshot.json (stops if that fails)
//     3. per key: write one kv_history row (the old server row), then a version-checked write
//     4. PDFs: write-once upload
//
// ── Merge rule (single source of truth) ─────────────────────────────────────
// Each key is merged with app/restore-merge.js mergeValue(key, server, backup, 'newer-wins'),
// the SAME function the app's Restore "Merge, keep whichever copy is newer" uses. There is no
// second merge in this file. Result: a record only on the server stays; a record in both takes
// the backup field values; a record only in the backup is added. "Newer updated-at wins" is a
// rule INSIDE mergeValue (RestoreMerge.recordTime), applied at every nesting level (building,
// meter, bill, map entry, plain-key object): a server copy with a strictly newer
// updatedAt/updated_at/modifiedAt/lastModified keeps its own fields. No stamp on either side =
// the backup wins. The diff file names every overwritten or kept record (level + id path) and the
// fields that changed, were added or were lost (field names only, never values).
// A key is HELD (not written, listed in the diff file) when the merge would remove anything the
// server has: a list item, a nested object, or a plain field (any type) the backup lacks. Name it in
// --allow-removal to write it. There is no whole-key --force path.
//
// ── Input shape ─────────────────────────────────────────────────────────────
// DATA export: `CompanyHub-localdatafile-YYYYMMDD.json` from app/site-functions.js siteBackup():
// a flat { key: value } object plus `_companyHubBackup: true`. Some values are JSON text
// (normalizeValue() parses them). PDF export: `CompanyHub-PDFs-YYYYMMDD-partNNN.json`
// `{_companyHubPdfExport:true, part, count, items:{<pdfKey>: <base64>}}`, read ONE part file at a
// time (never one giant in-memory object, backlog ed645bbd).
//
// Only 'synced' keys are written, under their bare names. Per-user keys are never seeded (they
// need `${userId}::key` wire names, app/db.js _wireKey). Local-only keys are never written.
//
// ── PDFs ────────────────────────────────────────────────────────────────────
// Content-hash dedup to `en_pdf_shared_<hash16>`; bill pdfKey fields are remapped to it
// (remapPdfReferences, run BEFORE the diff so the diff sees the remapped values). Write-once as in
// netlify/functions/pdf-sync.js commitObject(): absent -> upload; same size and sha256 -> no-op;
// different content -> conflict, reported, never overwritten. A bill that claims a PDF with no
// blob in the PDF export stops the run before any write.
//
// ── Credentials ─────────────────────────────────────────────────────────────
// Target safety: the URL comes ONLY from env SUPABASE_URL_<TARGET> (SUPABASE_URL_PROD or
// SUPABASE_URL_STAGING). The key comes ONLY from env SUPABASE_SECRET_KEY_<TARGET> or the Windows
// Credential Manager generic credential `companyhub-supabase-<target>-key`. The generic
// SUPABASE_URL and SUPABASE_SECRET_KEY are NEVER read. A missing value stops the run. The run
// prints the host it reads from or writes to, never the key. No built-in default URL, no prompt.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   Offline diff (no network, no key):
//     node scripts/migrate-seed.js --file <backup.json> --server-file <server-image.json>
//   Read-only diff against a project (GET only):
//     node scripts/migrate-seed.js --file <backup.json> --pdf-dir <dir> --target staging
//   Real write:
//     node scripts/migrate-seed.js --file <backup.json> --pdf-dir <dir> --target prod --apply
// See printUsage() for the flag list.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SyncClassification = require(path.join(REPO_ROOT, 'app', 'sync-classification.js'));
// restore-merge.js reads the global DB (DB.DERIVED_METER_FIELDS) when it loads. The real app/db.js
// is loaded in a Node vm by the same helper the unit tests use.
if (typeof global.DB === 'undefined') global.DB = require(path.join(REPO_ROOT, 'tools', 'load-db-for-test.js'));
const RestoreMerge = require(path.join(REPO_ROOT, 'app', 'restore-merge.js'));

const SUPABASE_FREE_DB_BYTES = 500 * 1024 * 1024; // 500 MB free-tier Postgres database cap
const SUPABASE_FREE_STORAGE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB free-tier Storage cap
// pdf-sync.js's single-shot threshold, for informational reporting only (this script uploads direct to Storage).
const FUNCTION_SINGLE_SHOT_LIMIT_BYTES = 4 * 1024 * 1024;
const AI_ROOT = path.join(os.homedir(), 'AI');
const DEFAULT_SNAPSHOT_DIR = path.join(AI_ROOT, '_context', 'live-data', 'snapshots');
const DEFAULT_REPORT_DIR = path.join(AI_ROOT, '_context', 'live-data', 'diffs');
const TARGETS = ['prod', 'staging'];

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file: null,
    pdfFiles: [],
    pdfDir: null,
    apply: false,
    json: false,
    allowUnclassified: false,
    allowRemoval: [],
    target: null,
    serverFile: null,
    snapshotDir: DEFAULT_SNAPSHOT_DIR,
    reportDir: DEFAULT_REPORT_DIR,
    operator: 'migration-seed',
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--pdf-file') args.pdfFiles.push(argv[++i]);
    else if (a === '--pdf-dir') args.pdfDir = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--allow-unclassified') args.allowUnclassified = true;
    else if (a === '--allow-removal')
      args.allowRemoval = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--server-file') args.serverFile = argv[++i];
    else if (a === '--snapshot-dir') args.snapshotDir = argv[++i];
    else if (a === '--report-dir') args.reportDir = argv[++i];
    else if (a === '--operator') args.operator = argv[++i];
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unrecognized argument: ' + a);
  }
  if (args.target !== null && !TARGETS.includes(args.target)) throw new Error('--target must be prod or staging.');
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/migrate-seed.js --file <backup.json> [--pdf-dir <dir> | --pdf-file <p.json>]... [options]',
      '',
      'Default is a DRY RUN: no write, counts only on screen, full diff in a local file.',
      '',
      'Input:',
      '  --file <path>           CompanyHub-localdatafile-YYYYMMDD.json data export.',
      '  --pdf-dir <dir>         Folder with CompanyHub-PDFs-YYYYMMDD-partNNN.json files.',
      '  --pdf-file <path>       One PDF part file. Repeatable.',
      '',
      'Server side (pick one for a diff):',
      '  --server-file <path>    Offline server image: {rows:{key:{value,version,...}}, pdfKeys?:[...]} (a snapshot file works).',
      '  --target prod|staging   Read the server by GET. URL: env SUPABASE_URL_<TARGET> only. No built-in default.',
      '  Key: env SUPABASE_SECRET_KEY_<TARGET>, else Windows Credential Manager "companyhub-supabase-<target>-key". The generic SUPABASE_URL / SUPABASE_SECRET_KEY are never used.',
      '',
      'Write:',
      '  --apply                 Really write: snapshot, kv_history, merge, PDFs. Needs --target. Matt runs this.',
      '  --allow-removal k1,k2   Write these held keys although the backup replaces nested items the server has.',
      '  --operator <email>      kv.updated_by value. Default "migration-seed".',
      '  --snapshot-dir <dir>    Default AI/_context/live-data/snapshots. Must be outside the repo.',
      '  --report-dir <dir>      Where the diff file goes. Default AI/_context/live-data/diffs. Must be outside the repo.',
      '',
      'Other:',
      '  --json                  Machine-readable counts.',
      '  --allow-unclassified    Downgrade an unclassified-key failure to a warning (not recommended).',
      '  --concurrency <n>       Max requests in flight. Default 4.',
    ].join('\n'),
  );
}
// ── Loading + validating the DATA export ────────────────────────────────────

function loadExport(filePath) {
  if (!filePath) {
    throw new Error('--file is required (path to a CompanyHub-localdatafile-*.json export)');
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error('File not found: ' + abs);
  }
  const stat = fs.statSync(abs);
  const raw = fs.readFileSync(abs, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('File is not valid JSON: ' + abs + ' (' + e.message + ')');
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      'Unrecognized export shape: expected a flat top-level object ({key: value, ...}), got ' +
        (Array.isArray(data) ? 'an array' : typeof data) +
        '. This script only reads app/site-functions.js siteBackup()-format exports.',
    );
  }

  if (data._companyHubPdfExport === true) {
    throw new Error(
      'Refusing to process ' +
        abs +
        ' -- this is a bill-PDF export part file ' +
        '({_companyHubPdfExport:true, part, count, items}), not a structured-data export. ' +
        'Pass PDF part files via --pdf-file / --pdf-dir instead of --file.',
    );
  }

  if (data._companyHubBackup !== true) {
    throw new Error(
      'Refusing to process ' +
        abs +
        ' -- missing the `_companyHubBackup: true` positive marker (app/site-functions.js ' +
        'siteBackup(), ~line 901) that identifies a real CompanyHub structured-data export. ' +
        'Not treating an unmarked file as ground truth.',
    );
  }

  return { data, fileSizeBytes: stat.size, path: abs };
}

// ── Value normalization ──────────────────────────────────────────────────────

function normalizeValue(raw) {
  if (typeof raw !== 'string') return raw; // already a real object/array/number/boolean/null (came via IndexedDB)
  try {
    return JSON.parse(raw); // was JSON.stringify'd before localStorage.setItem (e.g. ems_leads_v1)
  } catch (e) {
    return raw; // genuinely a plain string (e.g. ch_theme = "dark")
  }
}

// Stable-key-sorted JSON serialization -- MUST stay byte-identical to
// netlify/functions/kv-sync.js's canonicalJSON()/sortKeysDeep() (kv-sync.js:194-207)
// or a seeded row's hash would never match a hash a real client PUT computes
// for the same value, breaking every future idempotent-noop comparison.
function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Keys stamped onto the export by the export mechanism ITSELF -- see
// site-functions.js siteBackup() ~line 901. Never present in
// sync-classification.js's tables at all; called out explicitly (category
// "meta") instead of silently swallowed.
const META_KEYS = ['_companyHubBackup'];

// ── Classification cross-check against app/sync-classification.js ──────────
//
// Data-driven: calls the real classifyKey()/shouldReplicate() rather than
// reimplementing the matching rules, and detects the "unclassified, fell
// through every table, defaulted to LOCAL-ONLY" path by intercepting
// console.warn -- the only externally-observable signal classifyKey() gives
// for that case (see sync-classification.js's own doc comment on its
// default branch).
function classifyKeysDetailed(data) {
  const keys = Object.keys(data);
  const synced = [];
  const perUser = [];
  const localOnly = [];
  const unclassified = [];
  const meta = [];

  const originalWarn = console.warn;
  for (const k of keys) {
    if (META_KEYS.includes(k)) {
      meta.push(k);
      continue;
    }
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    let result;
    try {
      result = SyncClassification.classifyKey(k);
    } finally {
      console.warn = originalWarn;
    }
    if (warned) unclassified.push(k);
    else if (result === 'synced') synced.push(k);
    else if (result === 'per-user') perUser.push(k);
    else localOnly.push(k);
  }

  return { synced, perUser, localOnly, unclassified, meta };
}

// Legacy 2-state view kept for any external caller -- collapses 'synced' and
// 'per-user' back into one "would replicate" bucket the way
// SyncClassification.shouldReplicate() itself does. buildReport() below does
// NOT use this -- it uses classifyKeysDetailed() directly so per-user keys
// are never mixed into the seeded rows. See file header for why that
// distinction matters.
function classifyKeys(data) {
  const detailed = classifyKeysDetailed(data);
  return {
    synced: detailed.synced.concat(detailed.perUser),
    localOnly: detailed.localOnly,
    unclassified: detailed.unclassified,
    meta: detailed.meta,
  };
}

// ── Prepared rows (shared by dry-run report AND live write) ─────────────────

function prepareSyncedRows(data, syncedKeys) {
  return syncedKeys.map((key) => {
    const value = normalizeValue(data[key]);
    const canonicalJson = canonicalStringify(value);
    return {
      key,
      value,
      bytes: Buffer.byteLength(canonicalJson, 'utf8'),
      hash: sha256(canonicalJson),
    };
  });
}

// ── Data report ──────────────────────────────────────────────────────────────

function buildDataReport(loaded, args) {
  const { data, fileSizeBytes, path: filePath } = loaded;
  const { synced, perUser, localOnly, unclassified, meta } = classifyKeysDetailed(data);

  if (unclassified.length && !args.allowUnclassified) {
    const err = new Error(
      'FATAL: ' +
        unclassified.length +
        ' key(s) are not classified by app/sync-classification.js and would ' +
        'default to LOCAL-ONLY with a silent console.warn -- exactly the failure this ' +
        'migration is meant to avoid. Classify them in sync-classification.js first, or ' +
        're-run with --allow-unclassified to proceed anyway (NOT recommended): ' +
        unclassified.join(', '),
    );
    err.unclassified = unclassified;
    throw err;
  }

  const rows = prepareSyncedRows(data, synced);
  const totalSyncedBytes = rows.reduce((sum, r) => sum + r.bytes, 0);

  return {
    file: filePath,
    fileSizeBytes,
    totalTopLevelKeys: Object.keys(data).length,
    synced: {
      count: synced.length,
      keys: synced,
      rows: rows.map((r) => ({ key: r.key, bytes: r.bytes, hash: r.hash })), // value omitted from the report on purpose -- never print full record contents
      totalBytes: totalSyncedBytes,
    },
    perUser: {
      count: perUser.length,
      keys: perUser,
      note: "Per-user UI prefs (app/sync-classification.js PER_USER). NEVER seeded here -- they would need `${userId}::key` wire-namespacing (app/db.js _wireKey, db.js:219-224) that this one-time shared-data seed has no signed-in identity to namespace against. Each user's own prefs replicate normally once they sign in and the app's live per-user sync path (not this script) touches them for real.",
    },
    localOnly: { count: localOnly.length, keys: localOnly },
    unclassified: { count: unclassified.length, keys: unclassified },
    meta: {
      count: meta.length,
      keys: meta,
      note: 'Export-mechanism marker keys (e.g. _companyHubBackup) -- not present in sync-classification.js at all, never seeded, reported separately so the gap stays visible.',
    },
    supabaseFreeTierDbCapBytes: SUPABASE_FREE_DB_BYTES,
    percentOfSupabaseFreeTierDbCap: (totalSyncedBytes / SUPABASE_FREE_DB_BYTES) * 100,
    _rows: rows, // internal use only (live write path) -- stripped before any --json print
  };
}

// ── PDF part-file discovery + dry-run report ────────────────────────────────

const PDF_PART_FILE_RE = /^CompanyHub-PDFs-\d{8}-part(\d+)\.json$/i;

function resolvePdfFiles(args) {
  const files = [];
  if (args.pdfDir) {
    const dirAbs = path.resolve(args.pdfDir);
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
      throw new Error('--pdf-dir is not a directory: ' + dirAbs);
    }
    const entries = fs.readdirSync(dirAbs).filter((f) => PDF_PART_FILE_RE.test(f));
    entries.sort((a, b) => {
      const pa = Number(PDF_PART_FILE_RE.exec(a)[1]);
      const pb = Number(PDF_PART_FILE_RE.exec(b)[1]);
      return pa - pb;
    });
    for (const f of entries) files.push(path.join(dirAbs, f));
  }
  for (const f of args.pdfFiles || []) {
    files.push(path.resolve(f));
  }
  // de-dupe, preserve order
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  for (const f of out) {
    if (!fs.existsSync(f)) throw new Error('PDF part file not found: ' + f);
  }
  return out;
}

// Reads ONE part file, extracts stats, returns the file's raw items map to
// the caller if `keepItems` is true (live path only) -- otherwise the
// caller-visible result holds ONLY counters, and the parsed object is
// eligible for GC the moment this function returns (dry-run path). Never
// holds more than one part file's items in memory at a time regardless of
// caller -- see file header's "never build one giant in-memory object" note.
function readPdfPartFile(filePath, keepItems) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('PDF part file is not valid JSON: ' + filePath + ' (' + e.message + ')');
  }
  if (!data || data._companyHubPdfExport !== true || !data.items) {
    throw new Error('Not a recognized PDF part-export file (missing _companyHubPdfExport:true/items): ' + filePath);
  }
  const items = data.items;
  const ids = Object.keys(items);
  let totalRawBytes = 0;
  let largestRawBytes = 0;
  let overFunctionLimitCount = 0;
  for (const id of ids) {
    const b64 = items[id];
    const len = typeof b64 === 'string' ? b64.length : 0;
    const rawBytes = Math.floor((len * 3) / 4); // base64 -> raw byte estimate, exact enough for reporting
    totalRawBytes += rawBytes;
    if (rawBytes > largestRawBytes) largestRawBytes = rawBytes;
    if (rawBytes > FUNCTION_SINGLE_SHOT_LIMIT_BYTES) overFunctionLimitCount++;
  }
  const result = {
    file: filePath,
    part: data.part,
    count: ids.length,
    totalRawBytes,
    largestRawBytes,
    overFunctionLimitCount,
  };
  if (keepItems) result.items = items;
  return result;
}

// Canonical shared key for a content hash -- see file header "PDF
// content-hash dedup" section for why this exact form (`en_pdf_shared_` is
// the app's own prefix; the hash-prefix suffix is opaque to every layer that
// stores/retrieves it, same as a Date.now()-derived suffix).
function canonicalPdfKeyForHash(hash) {
  return 'en_pdf_shared_' + hash.slice(0, 16);
}

// Streams every PDF part file ONE FILE AT A TIME (matches this script's
// existing "never hold more than one part file's items in memory" rule --
// see file header) and returns BOTH the original raw per-file/aggregate
// stats (fileCount/totalItems/totalRawBytes/etc, unchanged shape from the
// pre-dedup report) AND the content-hash dedup index
// (blobKeyToHash/hashToInfo/hashToCanonicalKey) that remapPdfReferences()
// and the --apply upload path consume. One pass, not two -- hashing already
// requires decoding every item's base64 into a Buffer, so the exact
// buffer.length is used for byte accounting here (more precise than the old
// base64-length estimate, not just cheaper).
function scanPdfPartFilesForDedup(pdfFilePaths) {
  const perFile = [];
  let totalItems = 0;
  let totalRawBytes = 0;
  let largestRawBytes = 0;
  let overFunctionLimitCount = 0;
  const hashToInfo = new Map(); // hash -> { hash, canonicalKey, firstKey, bytes, refCount }
  const blobKeyToHash = new Map(); // every blob key seen (e.g. en_pdf_file_pb...) -> its content hash
  for (const filePath of pdfFilePaths) {
    const parsed = readPdfPartFile(filePath, true); // one file's items in memory at a time
    let fileBytes = 0;
    for (const key of Object.keys(parsed.items)) {
      const base64 = parsed.items[key];
      let buffer;
      try {
        buffer = Buffer.from(base64, 'base64');
      } catch (e) {
        throw new Error('Invalid base64 for PDF item ' + key + ' in ' + filePath + ': ' + e.message);
      }
      const bytes = buffer.length;
      fileBytes += bytes;
      totalItems++;
      if (bytes > largestRawBytes) largestRawBytes = bytes;
      if (bytes > FUNCTION_SINGLE_SHOT_LIMIT_BYTES) overFunctionLimitCount++;
      const hash = sha256Buf(buffer);
      blobKeyToHash.set(key, hash);
      let info = hashToInfo.get(hash);
      if (!info) {
        info = { hash, canonicalKey: canonicalPdfKeyForHash(hash), firstKey: key, bytes, refCount: 0 };
        hashToInfo.set(hash, info);
      }
      info.refCount++;
      // `buffer` goes out of scope here -- eligible for GC immediately, never
      // retained past this iteration (only the small `info`/hash bookkeeping
      // survives, never the PDF bytes themselves).
    }
    totalRawBytes += fileBytes;
    perFile.push({ file: parsed.file, part: parsed.part, count: parsed.count, totalRawBytes: fileBytes });
    // parsed.items goes out of scope here (per-file) -- nothing from this
    // file is retained once the next file starts.
  }
  const hashToCanonicalKey = new Map();
  for (const info of hashToInfo.values()) hashToCanonicalKey.set(info.hash, info.canonicalKey);
  return {
    perFile,
    totalItems,
    totalRawBytes,
    largestRawBytes,
    overFunctionLimitCount,
    hashToInfo,
    blobKeyToHash,
    hashToCanonicalKey,
  };
}

function buildPdfDryRunReport(pdfFilePaths) {
  const scan = scanPdfPartFilesForDedup(pdfFilePaths);
  const uniqueBlobs = scan.hashToInfo.size;
  let uniqueBytes = 0;
  for (const info of scan.hashToInfo.values()) uniqueBytes += info.bytes;
  return {
    fileCount: pdfFilePaths.length,
    totalItems: scan.totalItems,
    totalRawBytes: scan.totalRawBytes,
    largestRawBytes: scan.largestRawBytes,
    overFunctionLimitCount: scan.overFunctionLimitCount, // informational only -- this script uploads direct-to-Storage, not through pdf-sync.js's Function, so its chunk protocol never actually triggers here. See file header.
    perFile: scan.perFile,
    supabaseFreeTierStorageCapBytes: SUPABASE_FREE_STORAGE_BYTES,
    percentOfSupabaseFreeTierStorageCap: (scan.totalRawBytes / SUPABASE_FREE_STORAGE_BYTES) * 100,
    dedup: {
      uniqueBlobs,
      uniqueBytes,
      duplicationFactor: uniqueBlobs ? scan.totalItems / uniqueBlobs : 0,
      percentOfSupabaseFreeTierStorageCapUniqueOnly: (uniqueBytes / SUPABASE_FREE_STORAGE_BYTES) * 100,
    },
    _scan: scan, // internal use only (data-reference remap + --apply upload) -- stripped before any --json print, same convention as dataReport._rows
  };
}

// ── PDF reference remap (dedup-with-integrity) ──────────────────────────────
// See file header "PDF content-hash dedup + reference remap" section for the
// full design rationale. MUTATES `data` in place (and reassigns
// data[key]/data.en_pdf_bills to the normalized+mutated object so downstream
// normalizeValue() calls on the same key are a passthrough).
function remapPdfReferences(data, scan) {
  const stats = { candidates: 0, remapped: 0, broken: [] };

  function resolveHash(record) {
    // Step 1 (matches viewSavedPDF's own first attempt, bill-analysis.js
    // ~line 14814): legacy per-bill key. This is where the real 2026-08-17
    // corpus's 929 blobs actually live.
    const idForFileKey = record.pdfBillId || record.id;
    if (idForFileKey) {
      const h = scan.blobKeyToHash.get('en_pdf_file_' + idForFileKey);
      if (h) return h;
    }
    // Step 2 (matches viewSavedPDF's second attempt, ~line 14815): the
    // record's own pre-existing pdfKey, IF a blob actually exists under that
    // literal key in this export (some records carry a stale/unrelated
    // pdfKey from a different code path -- confirmed in the real corpus --
    // so this must be a real lookup, not an assumption).
    // Some records store the bare id ("1788474945230") without the
    // en_pdf_shared_ prefix; the blob is always stored under the prefixed key.
    if (record.pdfKey) {
      const bare = String(record.pdfKey).replace(/^en_pdf_shared_/, '');
      const h = scan.blobKeyToHash.get('en_pdf_shared_' + bare) || scan.blobKeyToHash.get(record.pdfKey);
      if (h) return h;
    }
    return null;
  }

  function isPdfClaim(record) {
    return !!(record && (record.hasPDF || record.pdfKey));
  }

  function processRecord(record, where) {
    if (!isPdfClaim(record)) return;
    stats.candidates++;
    const hash = resolveHash(record);
    if (!hash) {
      stats.broken.push({
        where,
        id: record.id || null,
        pdfBillId: record.pdfBillId || null,
        pdfKey: record.pdfKey || null,
        hasPDF: !!record.hasPDF,
      });
      return;
    }
    record.pdfKey = scan.hashToCanonicalKey.get(hash);
    stats.remapped++;
  }

  // 1) Unassigned bills: en_pdf_bills (flat array; record.id IS the billId
  //    the blob was saved under, e.g. `en_pdf_file_<record.id>`).
  if (Object.prototype.hasOwnProperty.call(data, 'en_pdf_bills')) {
    const normalized = normalizeValue(data.en_pdf_bills);
    if (Array.isArray(normalized)) {
      for (const rec of normalized) processRecord(rec, 'en_pdf_bills');
      data.en_pdf_bills = normalized;
    }
  }

  // 2) Assigned bills: en_utility_<projId> -> {buildings:[{meters:[{bills:[]}]}]}.
  //    NOT every `en_utility_*` key is per-project data (e.g.
  //    en_utility_audit_log, en_utility_rates_backfilled_v2 are migration/
  //    audit-flag keys) -- the `.buildings` array shape check below is what
  //    actually distinguishes them, not the key-name prefix alone.
  for (const key of Object.keys(data)) {
    if (!/^en_utility_/.test(key)) continue;
    const normalized = normalizeValue(data[key]);
    if (!normalized || typeof normalized !== 'object' || !Array.isArray(normalized.buildings)) continue;
    for (const bldg of normalized.buildings) {
      for (const meter of bldg.meters || []) {
        for (const row of meter.bills || []) {
          processRecord(row, key);
        }
      }
    }
    data[key] = normalized;
  }

  return stats;
}

// ── Human-readable report printing ──────────────────────────────────────────

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function printHumanDataReport(report) {
  console.log('CompanyHub importer -- DATA (kv table)');
  console.log('=====================================================');
  console.log('File:                     ' + report.file);
  console.log('File size on disk:        ' + fmtBytes(report.fileSizeBytes));
  console.log('Top-level keys in export: ' + report.totalTopLevelKeys);
  console.log('');
  console.log('Classification (via app/sync-classification.js classifyKey()):');
  console.log('  SYNCED (would be seeded, bare key name):        ' + report.synced.count);
  console.log('  PER-USER (never seeded by this script):         ' + report.perUser.count);
  console.log('  LOCAL-ONLY (never seeded):                      ' + report.localOnly.count);
  console.log('  UNCLASSIFIED (would default local-only + console.warn): ' + report.unclassified.count);
  if (report.unclassified.count) {
    console.log('    -> ' + report.unclassified.keys.join(', '));
  }
  console.log('  META (export-marker keys, never seeded):        ' + report.meta.count);
  if (report.meta.count) {
    console.log('    -> ' + report.meta.keys.join(', '));
  }
  console.log('');
  console.log('Backup content (SYNCED keys only):');
  console.log('  Rows that would be written to public.kv: ' + report.synced.count);
  console.log('  Total value bytes (canonical JSON):      ' + fmtBytes(report.synced.totalBytes));
  console.log(
    '  Against Supabase free-tier DB cap (500 MB): ' + report.percentOfSupabaseFreeTierDbCap.toFixed(3) + '%',
  );
}

function printHumanPdfReport(report) {
  console.log('');
  console.log('CompanyHub importer -- PDFs (pdf_blobs bucket)');
  console.log('==============================================================');
  console.log('Part files:               ' + report.fileCount);
  console.log('Total PDFs (items):       ' + report.totalItems);
  console.log('Total bytes (raw, all copies, exact): ' + fmtBytes(report.totalRawBytes));
  console.log('Largest single PDF (raw): ' + fmtBytes(report.largestRawBytes));
  console.log(
    '  Against Supabase free-tier Storage cap (1 GB), ALL COPIES: ' +
      report.percentOfSupabaseFreeTierStorageCap.toFixed(2) +
      '%',
  );
  console.log(
    '  PDFs over the pdf-sync.js Function single-shot limit (4MB, informational only -- ' +
      'this script uploads direct-to-Storage and does not go through that Function, so no ' +
      'chunk protocol actually applies here): ' +
      report.overFunctionLimitCount,
  );
  console.log('');
  console.log('Content-hash dedup (SHA-256 of raw bytes):');
  console.log('  Unique blobs (would actually be uploaded to "pdf_blobs"): ' + report.dedup.uniqueBlobs);
  console.log('  Unique bytes (would actually be uploaded):                ' + fmtBytes(report.dedup.uniqueBytes));
  console.log(
    '  Duplication factor:                                       ' + report.dedup.duplicationFactor.toFixed(2) + 'x',
  );
  console.log(
    '  Against Supabase free-tier Storage cap (1 GB), UNIQUE ONLY:              ' +
      report.dedup.percentOfSupabaseFreeTierStorageCapUniqueOnly.toFixed(2) +
      '%',
  );
}

function printHumanPdfRemapReport(stats) {
  console.log('');
  console.log('PDF reference remap (bill records -> canonical shared key)');
  console.log('==============================================================');
  console.log('PDF-claiming bill records found (hasPDF/pdfKey/pdfBillId):    ' + stats.candidates);
  console.log('Remapped to an uploaded canonical blob (pdfKey rewritten):    ' + stats.remapped);
  console.log('BROKEN -- no matching blob in the provided PDF export:       ' + stats.broken.length);
  if (stats.broken.length) {
    console.log('  These bill(s) would lose their PDF. Details:');
    console.log('  ' + JSON.stringify(stats.broken, null, 2).split('\n').join('\n  '));
  }
}
// ── Live: Storage (pdf_blobs bucket) client ─────────────────────────────────

const PDF_BUCKET = 'pdf_blobs';

function pdfObjectUrl(creds, key) {
  return creds.url + '/storage/v1/object/' + PDF_BUCKET + '/' + String(key).replace(/^\/+/, '');
}

// Supabase Storage answers a missing object with HTTP 400 and a JSON body
// {"statusCode":"404","error":"not_found","message":"Object not found"}. Only that body means missing.
function isStorageNotFoundBody(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch (e) {
    return false;
  }
  return !!b && String(b.statusCode) === '404' && (b.error === 'not_found' || /NoSuchKey/.test(String(b.code || '') + String(b.message || '')));
}

async function pdfStorageStat(key, creds) {
  const res = await fetch(pdfObjectUrl(creds, key), { headers: storageHeaders(creds, { Range: 'bytes=0-0' }) });
  if (res.status === 404) return null;
  if (res.status !== 200 && res.status !== 206) {
    const text = await safeText(res);
    if (res.status === 400 && isStorageNotFoundBody(text)) return null;
    throw new Error('Storage stat failed (' + res.status + '): ' + text.slice(0, 300));
  }
  const cr = res.headers.get('content-range');
  const m = /\/(\d+)\s*$/.exec(cr || '');
  if (m) return { size: Number(m[1]) };
  const buf = Buffer.from(await res.arrayBuffer());
  return { size: buf.length };
}

async function pdfStorageUpload(key, buffer, upsert, creds) {
  return fetch(pdfObjectUrl(creds, key), {
    method: 'POST',
    headers: storageHeaders(creds, { 'Content-Type': 'application/pdf', 'x-upsert': upsert ? 'true' : 'false' }),
    body: buffer,
  });
}

async function pdfStorageDownload(key, creds) {
  const res = await fetch(pdfObjectUrl(creds, key), { headers: storageHeaders(creds) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Storage download failed (' + res.status + ')');
  return Buffer.from(await res.arrayBuffer());
}

// Mirrors netlify/functions/pdf-sync.js commitObject()/resolveAgainstExisting()
// (pdf-sync.js:553-589) -- write-once, idempotent-retry-on-identical-content,
// NEVER a silent overwrite, no --force path (PDFs are write-once by design).
async function commitPdfObject(key, buffer, hash, creds) {
  const existing = await pdfStorageStat(key, creds);
  if (!existing) {
    const up = await pdfStorageUpload(key, buffer, false, creds);
    if (up.status === 200 || up.status === 201) return { key, status: 'uploaded', size: buffer.length };
    if (up.status === 400 || up.status === 409) {
      const raced = await pdfStorageStat(key, creds);
      if (raced) return resolvePdfAgainstExisting(key, buffer, hash, raced, creds);
    }
    const errText = await safeText(up);
    return { key, status: 'error', httpStatus: up.status, error: errText.slice(0, 300) };
  }
  return resolvePdfAgainstExisting(key, buffer, hash, existing, creds);
}

async function resolvePdfAgainstExisting(key, buffer, hash, existingStat, creds) {
  if (existingStat.size !== buffer.length) {
    return { key, status: 'conflict-size-mismatch', existingSize: existingStat.size, newSize: buffer.length };
  }
  const dl = await pdfStorageDownload(key, creds);
  const existingHash = dl ? sha256Buf(dl) : null;
  if (existingHash === hash) return { key, status: 'noop-identical', size: buffer.length };
  return { key, status: 'conflict-hash-mismatch' };
}

// ── Concurrency helper ───────────────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
// ── Supabase REST client (bare fetch, same pattern as netlify/functions/kv-sync.js) ──
// Every network function uses the global fetch, so a test can replace it with an in-memory fake.

function pgHeaders(creds, extra) {
  // Never log this object or spread it into console output.
  return Object.assign(
    {
      apikey: creds.secretKey,
      Authorization: 'Bearer ' + creds.secretKey,
      'Content-Type': 'application/json',
    },
    extra || {},
  );
}

function storageHeaders(creds, extra) {
  return Object.assign({ apikey: creds.secretKey, Authorization: 'Bearer ' + creds.secretKey }, extra || {});
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (e) {
    return '';
  }
}

async function fetchKvRow(key, creds) {
  const res = await fetch(creds.url + '/rest/v1/kv?key=eq.' + encodeURIComponent(key) + '&select=*', {
    headers: pgHeaders(creds),
  });
  if (!res.ok) throw new Error('Server read failed (HTTP ' + res.status + ')');
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Every key on the server (names and flags only, no values).
async function listServerKeys(creds) {
  const res = await fetch(creds.url + '/rest/v1/kv?select=key,deleted&limit=100000', { headers: pgHeaders(creds) });
  if (!res.ok) throw new Error('Server key list failed (HTTP ' + res.status + ')');
  return await res.json();
}

async function insertKvRow(row, creds, operator) {
  const res = await fetch(creds.url + '/rest/v1/kv', {
    method: 'POST',
    headers: pgHeaders(creds, { Prefer: 'return=minimal' }),
    body: JSON.stringify([
      {
        key: row.key,
        value: row.value,
        version: 1,
        hash: row.hash,
        deleted: false,
        updated_by: operator,
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  return res.status; // 201 inserted, 409 key exists
}

// Version-checked write: PATCH ... WHERE version = expected. true only if exactly one row matched.
async function patchKvRow(row, expectedVersion, creds, operator) {
  const res = await fetch(
    creds.url + '/rest/v1/kv?key=eq.' + encodeURIComponent(row.key) + '&version=eq.' + expectedVersion,
    {
      method: 'PATCH',
      headers: pgHeaders(creds, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        value: row.value,
        hash: row.hash,
        deleted: false,
        version: expectedVersion + 1,
        updated_by: operator,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length === 1;
}

// Same row shape as netlify/functions/kv-sync.js snapshotHistory().
async function insertHistoryRow(before, creds) {
  const res = await fetch(creds.url + '/rest/v1/kv_history', {
    method: 'POST',
    headers: pgHeaders(creds, { Prefer: 'return=minimal' }),
    body: JSON.stringify([
      {
        key: before.key,
        value: before.value,
        version: before.version,
        updated_by: before.updated_by,
        replaced_at: new Date().toISOString(),
      },
    ]),
  });
  return res.ok;
}

// ── Credentials: env or Windows Credential Manager ONLY. Never printed, never logged. ──

// Reads one generic credential's password from Windows Credential Manager (CredRead). The target name
// goes in through an env var, not into the script text. The secret travels only through the child's
// stdout pipe into the returned string.
function readCredentialManager(target) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public class ChCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttrCount;',
    '    public IntPtr Attrs; public string Alias; public string User; }',
    '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    '  static extern bool CredRead(string t, int type, int flags, out IntPtr p);',
    '  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);',
    '  public static string Get(string t) {',
    '    IntPtr p; if (!CredRead(t, 1, 0, out p)) return null;',
    '    try { CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));',
    '      return Marshal.PtrToStringUni(c.Blob, c.BlobSize / 2); } finally { CredFree(p); }',
    '  }',
    '}',
    "'@",
    '$v = [ChCred]::Get($env:CH_CRED_TARGET)',
    'if ($v) { [Console]::Out.Write($v) }',
  ].join('\n');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: Object.assign({}, process.env, { CH_CRED_TARGET: target }),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out && out.trim() ? out.trim() : null;
  } catch (e) {
    return null; // never include the child output in an error
  }
}

// Target-specific values ONLY. The generic SUPABASE_URL / SUPABASE_SECRET_KEY are never read, so a
// prod pair left in the environment cannot be used for a staging run (or the other way round).
// The target URL may end in /rest/v1/ ; every caller appends its own path, so keep the bare origin.
function normalizeSupabaseUrl(url) {
  return String(url).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, '');
}

function resolveCreds(args, env, readCred) {
  const target = args.target;
  if (!target) throw new Error('--target prod|staging is required to reach a server.');
  if (!TARGETS.includes(target)) throw new Error('--target must be prod or staging.');
  const T = target.toUpperCase();
  const url = env['SUPABASE_URL_' + T];
  if (!url) throw new Error('No project URL for ' + target + '. Set env SUPABASE_URL_' + T + '. Stopping.');
  const credName = 'companyhub-supabase-' + target + '-key';
  const secretKey = env['SUPABASE_SECRET_KEY_' + T] || (readCred || readCredentialManager)(credName);
  if (!secretKey) {
    throw new Error(
      'No service key for ' +
        target +
        '. Set env SUPABASE_SECRET_KEY_' +
        T +
        ' or store Windows Credential Manager entry "' +
        credName +
        '". Stopping.',
    );
  }
  const clean = normalizeSupabaseUrl(url);
  let host;
  try {
    host = new URL(clean).host;
  } catch (e) {
    throw new Error('SUPABASE_URL_' + T + ' is not a valid URL. Stopping.');
  }
  return { url: clean, host, target, secretKey };
}

// ── Server image (offline file or live read) ────────────────────────────────

// Offline server image: { rows: { key: {value, version, deleted?, updated_by?, updated_at?} }, pdfKeys?: [..] }.
// A snapshot file this script wrote has the same shape (rows may hold null for a key that was absent).
function loadServerFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error('Server file not found: ' + abs);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error('Server file is not valid JSON: ' + abs);
  }
  if (!parsed || typeof parsed.rows !== 'object' || parsed.rows === null) {
    throw new Error('Server file needs a top-level "rows" object: ' + abs);
  }
  const rows = new Map();
  for (const k of Object.keys(parsed.rows)) {
    const r = parsed.rows[k];
    if (r) rows.set(k, Object.assign({ key: k, version: 1, deleted: false }, r));
  }
  return {
    rows,
    allKeys: Array.from(rows.keys()),
    pdfKeys: Array.isArray(parsed.pdfKeys) ? parsed.pdfKeys : null,
  };
}

async function readServerImage(creds, keys, concurrency) {
  const list = await listServerKeys(creds);
  const rows = new Map();
  const wanted = new Set(keys);
  const toRead = list.filter((r) => wanted.has(r.key));
  const got = await mapWithConcurrency(toRead, concurrency, (r) => fetchKvRow(r.key, creds));
  got.forEach((row) => {
    if (row) rows.set(row.key, row);
  });
  return { rows, allKeys: list.map((r) => r.key), pdfKeys: null };
}

// ── Merge plan (pure: no network, no file writes) ───────────────────────────

// The record list a policy holds: the value itself, or value[path[0]], or a map's entries.
function topList(pol, v) {
  if (pol.kind === "map") return null;
  if (pol.path.length)
    return v && typeof v === "object" && !Array.isArray(v)
      ? v[pol.path[0]]
      : undefined;
  return v;
}

// Record id of each top-level record: Map(String(id) -> record). Map policy: entries by key.
function recordIndex(pol, v) {
  const out = new Map();
  if (pol.kind === "map") {
    if (v && typeof v === "object" && !Array.isArray(v))
      Object.keys(v).forEach((k) => out.set(k, v[k]));
    return { index: out, unidentified: 0 };
  }
  let unidentified = 0;
  const list = topList(pol, v);
  if (Array.isArray(list)) {
    for (const r of list) {
      const id =
        r && typeof r === "object" && !Array.isArray(r)
          ? pol.idOf(r)
          : undefined;
      if (id === undefined || id === null || id === "") unidentified++;
      else if (!out.has(String(id))) out.set(String(id), r);
    }
  }
  return { index: out, unidentified };
}

// Level name of a nested record from the length of its id path (building > meter > bill).
function levelName(pol, depth) {
  if (pol.kind === "map") return "entry";
  return pol.path[depth - 1] || "record";
}

// Per-record classification of one key: server value vs the merge RESULT vs the backup.
//   new: in the result, not on the server.   serverOnly: on the server, not in the backup (kept).
//   changed: top-level records whose result differs from the server copy.
//   nested: every record below the top level that the merge overwrote or kept because the server copy
//     is newer, named by level and id path, with the field NAMES that changed, were added or were lost
//     (never values). The events come from RestoreMerge.mergeValue (m.events): the diff does not
//     re-decide who wins.
//   fieldChanges: plain key holding an object: field names that change, are added or are lost.
//   identical: result equals the server copy.   serverNewerKept: records (any level) the server keeps.
function diffRecords(pol, serverVal, mergedVal, backupVal, m) {
  const canon = RestoreMerge.canon;
  const events = (m && m.events) || [];
  const out = {
    new: [],
    changed: [],
    serverOnly: [],
    identical: 0,
    serverNewerKept: events
      .filter((e) => e.kind === "keptNewer")
      .map((e) => e.trail.join(" > ") || "(whole key)"),
    nested: [],
    fieldChanges: m && m.fields ? m.fields : null,
    heldBecause: null,
    unidentifiedBackup: 0,
  };
  if (pol.kind === "key") {
    if (serverVal === undefined || serverVal === null)
      out.new.push("(whole key)");
    else if (canon(serverVal) === canon(mergedVal)) out.identical = 1;
    else
      out.changed.push({
        id: "(whole key)",
        why: out.fieldChanges
          ? "plain key: the backup object replaces the server object (field names in fieldChanges)"
          : "plain key: scalar value replaced by the backup value",
      });
    return out;
  }
  const srv = recordIndex(
    pol,
    serverVal === undefined ? null : serverVal,
  ).index;
  const mer = recordIndex(pol, mergedVal).index;
  const bak = recordIndex(pol, backupVal);
  out.unidentifiedBackup = bak.unidentified;
  const fieldsOf = (id) => {
    const e = events.find(
      (x) =>
        x.kind === "overwrote" && x.trail.length === 1 && x.trail[0] === id,
    );
    return e && e.fields ? e.fields : undefined;
  };
  for (const [id, rec] of mer) {
    if (!srv.has(id)) out.new.push(id);
    else if (canon(srv.get(id)) === canon(rec)) out.identical++;
    else {
      const both =
        RestoreMerge.recordTime(srv.get(id)) !== null &&
        RestoreMerge.recordTime(bak.index.get(id)) !== null;
      const entry = {
        id,
        why: both
          ? "backup newer or same updated-at"
          : "no updated-at on one side: backup wins",
      };
      const f = fieldsOf(id);
      if (f) entry.fields = f;
      out.changed.push(entry);
    }
  }
  for (const id of srv.keys()) if (!bak.index.has(id)) out.serverOnly.push(id);
  for (const e of events) {
    if (e.trail.length <= 1) continue;
    out.nested.push({
      level: levelName(pol, e.trail.length),
      path: e.trail,
      kind:
        e.kind === "keptNewer"
          ? "kept: server copy is newer"
          : "overwritten by the backup",
      fields: e.fields,
    });
  }
  return out;
}

// Plan one key. serverRow is null when the key is absent. Never writes.
function planKey(key, serverRow, backupValue, backupKeys, opts) {
  const pol = RestoreMerge.policyFor(key, backupKeys);
  if (pol.kind === "never")
    return { key, action: "skipped-never", why: pol.why };
  if (serverRow && serverRow.deleted)
    return { key, action: "tombstoned-skipped" };
  const serverVal = serverRow ? serverRow.value : undefined;
  const m = RestoreMerge.mergeValue(
    key,
    serverVal,
    backupValue,
    "newer-wins",
    backupKeys,
  );
  const detail = diffRecords(
    pol,
    serverVal,
    m.changed ? m.value : serverVal,
    backupValue,
    m,
  );
  const base = {
    key,
    policy: pol.kind,
    label: RestoreMerge.labelFor(key),
    detail,
    removed: m.removed,
    keptNewer: m.keptNewer,
  };
  if (!serverRow) {
    if (!m.changed) return Object.assign(base, { action: "empty-skipped" });
    return Object.assign(base, { action: "insert", value: m.value });
  }
  if (!m.changed)
    return Object.assign(base, {
      action: m.keptNewer > 0 ? "server-newer-kept" : "identical",
    });
  const allowed = new Set((opts && opts.allowRemoval) || []);
  if (m.removed > 0 && !allowed.has(key)) {
    // HOLD: the server has something the backup lacks. No write. The diff file says what.
    detail.heldBecause = {
      serverItemsOrFieldsTheBackupLacks: m.removed,
      lostFieldNames: m.fields ? m.fields.lost : undefined,
    };
    return Object.assign(base, { action: "held", value: m.value });
  }
  return Object.assign(base, { action: "update", value: m.value });
}
// Plan all synced keys. rows = prepareSyncedRows() output (backup side).
function buildMergePlan(rows, serverImage, opts) {
  const backupKeys = rows.map((r) => r.key);
  const keys = rows.map((r) => {
    const p = planKey(r.key, serverImage.rows.get(r.key) || null, r.value, backupKeys, opts);
    if (p.value !== undefined) {
      const json = canonicalStringify(p.value);
      p.hash = sha256(json);
      p.bytes = Buffer.byteLength(json, 'utf8');
    }
    return p;
  });
  const backupSet = new Set(backupKeys);
  const serverOnlyKeys = serverImage.allKeys.filter((k) => !backupSet.has(k));
  return { keys, serverOnlyKeys };
}

function countPlan(plan) {
  const c = {
    keys: {
      insert: 0,
      update: 0,
      identical: 0,
      held: 0,
      serverNewerKept: 0,
      skippedNever: 0,
      tombstonedSkipped: 0,
      emptySkipped: 0,
      serverOnly: plan.serverOnlyKeys.length,
    },
    records: {
      new: 0,
      changed: 0,
      serverOnly: 0,
      identical: 0,
      serverNewerKept: 0,
      nestedChanged: 0,
      heldFieldNames: 0,
    },
  };
  for (const p of plan.keys) {
    if (p.action === 'insert') c.keys.insert++;
    else if (p.action === 'update') c.keys.update++;
    else if (p.action === 'identical') c.keys.identical++;
    else if (p.action === 'held') c.keys.held++;
    else if (p.action === 'server-newer-kept') c.keys.serverNewerKept++;
    else if (p.action === 'skipped-never') c.keys.skippedNever++;
    else if (p.action === 'tombstoned-skipped') c.keys.tombstonedSkipped++;
    else if (p.action === 'empty-skipped') c.keys.emptySkipped++;
    if (p.detail) {
      c.records.new += p.detail.new.length;
      c.records.changed += p.detail.changed.length;
      c.records.serverOnly += p.detail.serverOnly.length;
      c.records.identical += p.detail.identical;
      c.records.serverNewerKept += p.detail.serverNewerKept.length;
      c.records.nestedChanged += p.detail.nested.filter((n) => n.kind === 'overwritten by the backup').length;
      if (p.detail.heldBecause && p.detail.heldBecause.lostFieldNames)
        c.records.heldFieldNames += p.detail.heldBecause.lostFieldNames.length;
    }
  }
  return c;
}

// The full diff, for the local file. Holds record ids (never record values).
function buildDiffFile(plan, counts, meta) {
  return {
    createdAt: new Date().toISOString(),
    mode: meta.mode,
    counts,
    serverOnlyKeys: plan.serverOnlyKeys,
    keys: plan.keys.map((p) => ({
      key: p.key,
      action: p.action,
      why: p.why,
      policy: p.policy,
      removedIfWritten: p.removed,
      new: p.detail ? p.detail.new : undefined,
      overwrittenByBackup: p.detail ? p.detail.changed : undefined,
      serverOnlyKept: p.detail ? p.detail.serverOnly : undefined,
      serverNewerKept: p.detail ? p.detail.serverNewerKept : undefined,
      nestedRecords: p.detail ? p.detail.nested : undefined,
      fieldChanges: p.detail ? p.detail.fieldChanges : undefined,
      heldBecause: p.detail ? p.detail.heldBecause : undefined,
      identical: p.detail ? p.detail.identical : undefined,
      unidentifiedBackupRecords: p.detail ? p.detail.unidentifiedBackup : undefined,
    })),
    pdf: meta.pdf || null,
  };
}

// ── Files: diff + snapshot. Both stay OUTSIDE the repo. ─────────────────────

function assertOutsideRepo(dir) {
  const abs = path.resolve(dir);
  const rel = path.relative(REPO_ROOT, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('Refusing to write inside the repo: ' + abs + ' (diff and snapshot files hold client data).');
  }
  return abs;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  const dd = d || new Date();
  return (
    dd.getFullYear() + '-' + p(dd.getMonth() + 1) + '-' + p(dd.getDate()) + '-' + p(dd.getHours()) + p(dd.getMinutes())
  );
}

function writeLocalJson(dir, name, obj) {
  const abs = assertOutsideRepo(dir);
  fs.mkdirSync(abs, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 100; n++) {
    const file = path.join(abs, n === 1 ? name : stem + '-' + n + ext);
    try {
      fs.writeFileSync(file, JSON.stringify(obj, null, 1), { flag: 'wx' }); // never overwrite an older file
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Too many files with the name ' + name);
}

// The server rows of every key the import will touch (null = key absent). Written BEFORE any write.
function writeSnapshot(plan, serverImage, dir, now) {
  const rows = {};
  for (const p of plan.keys) {
    if (p.action === 'insert') rows[p.key] = null;
    else if (p.action === 'update') rows[p.key] = serverImage.rows.get(p.key) || null;
  }
  return writeLocalJson(dir, stamp(now) + '-supabase-snapshot.json', {
    createdAt: new Date().toISOString(),
    note: 'Server rows before the import. null = key was absent. Same shape as --server-file.',
    rows,
  });
}

// ── Apply (the only place that writes kv) ───────────────────────────────────

async function applyPlan(plan, serverImage, creds, opts) {
  const todo = plan.keys.filter((p) => p.action === 'insert' || p.action === 'update');
  const results = await mapWithConcurrency(todo, opts.concurrency, async (p) => {
    const row = { key: p.key, value: p.value, hash: p.hash };
    if (p.action === 'insert') {
      const st = await insertKvRow(row, creds, opts.operator);
      return {
        key: p.key,
        status: st === 201 ? 'inserted' : st === 409 ? 'conflict-appeared' : 'error',
      };
    }
    const before = serverImage.rows.get(p.key);
    // History first: if it cannot be written, the key is not touched.
    if (!(await insertHistoryRow(before, creds))) return { key: p.key, status: 'history-failed' };
    const ok = await patchKvRow(row, before.version, creds, opts.operator);
    return {
      key: p.key,
      status: ok ? 'updated' : 'conflict-version-changed',
    };
  });
  const summary = {
    inserted: 0,
    updated: 0,
    historyWritten: 0,
    conflict: 0,
    historyFailed: 0,
    error: 0,
  };
  for (const r of results) {
    if (r.status === 'inserted') summary.inserted++;
    else if (r.status === 'updated') {
      summary.updated++;
      summary.historyWritten++;
    } else if (r.status === 'conflict-version-changed') {
      summary.conflict++;
      summary.historyWritten++;
    } else if (r.status === 'conflict-appeared') summary.conflict++;
    else if (r.status === 'history-failed') summary.historyFailed++;
    else summary.error++;
  }
  return { results, summary };
}

// ── PDFs: report + write-once upload ────────────────────────────────────────

// Which unique PDFs are on the server. Uses the offline pdfKeys list or a Storage stat per hash.
async function pdfPresence(scan, serverImage, creds, concurrency) {
  const infos = Array.from(scan.hashToInfo.values());
  const offline = serverImage && serverImage.pdfKeys ? new Set(serverImage.pdfKeys) : null;
  if (!offline && !creds)
    return {
      known: false,
      unique: infos.length,
      toUpload: null,
      present: null,
      sizeDiffers: null,
    };
  const states = await mapWithConcurrency(infos, concurrency, async (info) => {
    if (offline) return offline.has(info.canonicalKey) ? 'present' : 'upload';
    const st = await pdfStorageStat(info.canonicalKey, creds);
    if (!st) return 'upload';
    return st.size === info.bytes ? 'present' : 'size-differs';
  });
  const n = (s) => states.filter((x) => x === s).length;
  return {
    known: true,
    unique: infos.length,
    toUpload: n('upload'),
    present: n('present'),
    sizeDiffers: n('size-differs'),
  };
}

async function applyPdfFiles(pdfFilePaths, creds, opts) {
  const summary = {
    uploaded: 0,
    noop: 0,
    conflict: 0,
    error: 0,
    skippedDuplicateInRun: 0,
    totalItems: 0,
    uniqueBlobs: 0,
  };
  const hashResultCache = new Map();
  for (const filePath of pdfFilePaths) {
    const parsed = readPdfPartFile(filePath, true); // one part file in memory at a time
    const ids = Object.keys(parsed.items);
    const fileResults = await mapWithConcurrency(ids, opts.concurrency, async (sourceKey) => {
      const buffer = Buffer.from(parsed.items[sourceKey], 'base64');
      const hash = sha256Buf(buffer);
      const canonicalKey = canonicalPdfKeyForHash(hash);
      if (hashResultCache.has(hash)) return { status: 'skipped-duplicate-in-run' };
      hashResultCache.set(hash, true); // set BEFORE the await: a same-content item in flight is skipped
      return commitPdfObject(canonicalKey, buffer, hash, creds);
    });
    for (const r of fileResults) {
      summary.totalItems++;
      if (r.status === 'uploaded') summary.uploaded++;
      else if (r.status === 'noop-identical') summary.noop++;
      else if (r.status === 'conflict-size-mismatch' || r.status === 'conflict-hash-mismatch') summary.conflict++;
      else if (r.status === 'skipped-duplicate-in-run') summary.skippedDuplicateInRun++;
      else summary.error++;
    }
    if (opts.log)
      opts.log('  [pdf] ' + path.basename(filePath) + ' done: uploaded=' + summary.uploaded + ' noop=' + summary.noop);
  }
  summary.uniqueBlobs = hashResultCache.size;
  return summary;
}

// ── Orchestration ────────────────────────────────────────────────────────────

// deps (tests): { env, readCred, log, now }
async function runImport(args, deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const log = deps.log || ((s) => console.log(s));
  const result = { apply: !!args.apply };

  const pdfFilePaths = resolvePdfFiles(args);
  if (!args.file && !pdfFilePaths.length) throw new Error('Nothing to do -- pass --file and/or --pdf-dir/--pdf-file.');
  if (args.apply && !args.target) throw new Error('--apply needs --target prod|staging.');
  if (args.apply && args.serverFile)
    throw new Error('--apply reads the live server. Do not combine it with --server-file.');
  if (args.apply && !args.file && !pdfFilePaths.length) throw new Error('Nothing to apply.');

  const dataLoaded = args.file ? loadExport(args.file) : null;
  const pdfReport = pdfFilePaths.length ? buildPdfDryRunReport(pdfFilePaths) : null;
  const pdfRemapStats = dataLoaded && pdfReport ? remapPdfReferences(dataLoaded.data, pdfReport._scan) : null;
  if (pdfRemapStats && pdfRemapStats.broken.length) {
    throw new Error(
      pdfRemapStats.broken.length +
        ' PDF-claiming bill record(s) match no blob in the PDF export -- refusing to proceed. Investigate before re-running.',
    );
  }
  const dataReport = dataLoaded ? buildDataReport(dataLoaded, args) : null;
  result.dataReport = dataReport;
  result.pdfReport = pdfReport;
  result.pdfRemap = pdfRemapStats;

  // Server side: offline file, or live (read-only until the write step).
  let creds = null;
  let serverImage = null;
  if (args.serverFile) serverImage = loadServerFile(args.serverFile);
  else if (args.target) {
    creds = resolveCreds(args, env, deps.readCred);
    log(
      'Server: ' + (args.apply ? 'WRITING to' : 'reading (GET only) from') + ' target=' + creds.target + ' host=' + creds.host,
    );
  }
  if (creds && dataReport) {
    serverImage = await readServerImage(creds, dataReport.synced.keys, args.concurrency);
  }

  let plan = null;
  let counts = null;
  if (dataReport && serverImage) {
    plan = buildMergePlan(dataReport._rows, serverImage, {
      allowRemoval: args.allowRemoval,
    });
    counts = countPlan(plan);
    result.plan = plan;
    result.counts = counts;
  }

  let pdfPresenceReport = null;
  if (pdfReport) {
    pdfPresenceReport = await pdfPresence(pdfReport._scan, serverImage, creds, args.concurrency);
    result.pdfPresence = pdfPresenceReport;
  }

  // Diff file (local, outside the repo). Always written when there is a plan.
  if (plan) {
    const diff = buildDiffFile(plan, counts, {
      mode: args.apply ? 'apply' : 'dry-run',
      pdf: pdfPresenceReport,
    });
    result.diffFile = writeLocalJson(args.reportDir, stamp(deps.now) + '-supabase-import-diff.json', diff);
  }

  printRunReport(result, args, log);

  if (!args.apply) {
    log('');
    log('DRY RUN -- nothing was written. Add --apply (with --target) to write.');
    return result;
  }

  // ---- APPLY ----
  if (plan) {
    result.snapshotFile = writeSnapshot(plan, serverImage, args.snapshotDir, deps.now); // throws -> no write
    log('Snapshot saved (before any write): ' + result.snapshotFile);
    const applied = await applyPlan(plan, serverImage, creds, {
      concurrency: args.concurrency,
      operator: args.operator,
    });
    result.applied = applied;
    const s = applied.summary;
    log(
      'Data written: inserted=' +
        s.inserted +
        ' updated=' +
        s.updated +
        ' history-rows=' +
        s.historyWritten +
        ' conflict=' +
        s.conflict +
        ' history-failed=' +
        s.historyFailed +
        ' error=' +
        s.error,
    );
    if (counts.keys.held)
      log(
        '  ' +
          counts.keys.held +
          ' key(s) HELD (would remove items). See the diff file. Use --allow-removal to write one.',
      );
  }
  if (pdfFilePaths.length) {
    result.pdfApplied = await applyPdfFiles(pdfFilePaths, creds, {
      concurrency: args.concurrency,
      log,
    });
    const s = result.pdfApplied;
    log(
      'PDFs: uploaded=' +
        s.uploaded +
        ' already-present=' +
        s.noop +
        ' conflict=' +
        s.conflict +
        ' error=' +
        s.error +
        ' (unique blobs ' +
        s.uniqueBlobs +
        ')',
    );
  }
  log('');
  log('APPLY COMPLETE. Run the same command without --apply: it must show 0 new, 0 changed.');
  return result;
}

function printRunReport(result, args, log) {
  if (args.json) {
    const out = {};
    if (result.dataReport) {
      const { _rows, ...pub } = result.dataReport;
      out.data = pub;
    }
    if (result.pdfReport) {
      const { _scan, ...pub } = result.pdfReport;
      out.pdf = pub;
    }
    if (result.counts) out.diff = result.counts;
    if (result.pdfPresence) out.pdfPresence = result.pdfPresence;
    if (result.diffFile) out.diffFile = result.diffFile;
    log(JSON.stringify(out, null, 2));
    return;
  }
  if (result.dataReport) printHumanDataReport(result.dataReport);
  if (result.pdfReport) printHumanPdfReport(result.pdfReport);
  if (result.counts) {
    const c = result.counts;
    log('');
    log('DIFF against the server (counts only; ids are in the diff file)');
    log('====================================================================');
    log(
      'Keys:    new=' +
        c.keys.insert +
        ' changed=' +
        c.keys.update +
        ' identical=' +
        c.keys.identical +
        ' held=' +
        c.keys.held +
        ' never-written=' +
        c.keys.skippedNever +
        ' tombstoned=' +
        c.keys.tombstonedSkipped +
        ' server-only=' +
        c.keys.serverOnly,
    );
    log(
      'Records: new=' +
        c.records.new +
        ' changed=' +
        c.records.changed +
        ' server-only(kept)=' +
        c.records.serverOnly +
        ' identical=' +
        c.records.identical +
        ' server-newer(kept)=' +
        c.records.serverNewerKept +
        ' nested-overwritten=' +
        c.records.nestedChanged,
    );
    if (c.keys.held)
      log(
        'HELD keys: ' +
          c.keys.held +
          ' (' +
          c.records.heldFieldNames +
          ' server-only plain field name(s)). Not written. See the diff file.',
      );
    log('Diff file: ' + result.diffFile);
  } else if (result.dataReport) {
    log('');
    log('No server to compare with (pass --server-file or --target). Local report only.');
  }
  if (result.pdfPresence) {
    const p = result.pdfPresence;
    log('');
    log(
      p.known
        ? 'PDFs on server: ' +
            p.unique +
            ' unique; to upload=' +
            p.toUpload +
            ' already present=' +
            p.present +
            ' size-differs=' +
            p.sizeDiffers
        : 'PDFs: ' + p.unique + ' unique. Server presence unknown (no server given).',
    );
  }
  if (result.pdfRemap) printHumanPdfRemapReport(result.pdfRemap);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  await runImport(args);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  loadExport,
  normalizeValue,
  canonicalStringify,
  classifyKeys,
  classifyKeysDetailed,
  prepareSyncedRows,
  buildDataReport,
  buildPdfDryRunReport,
  scanPdfPartFilesForDedup,
  canonicalPdfKeyForHash,
  remapPdfReferences,
  readPdfPartFile,
  resolvePdfFiles,
  commitPdfObject,
  resolveCreds,
  normalizeSupabaseUrl,
  pdfStorageStat,
  readCredentialManager,
  loadServerFile,
  planKey,
  buildMergePlan,
  countPlan,
  runImport,
};
