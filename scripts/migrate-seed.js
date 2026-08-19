#!/usr/bin/env node
// scripts/migrate-seed.js
//
// Phase 3 migration-seed script referenced by app/sync-classification.js's own
// header comment ("Phase 3 — migrate-seed.js's skip list when classifying keys
// out of a siteBackup()/DB.getAll() export"). Originally shipped dry-run-only
// (2e2d6da); this revision adds the actual --live write path (data -> the
// `kv` table, PDFs -> the `pdf_blobs` Storage bucket) that the migration was
// always meant to end with. --dry-run remains fully supported and is still
// the safe default to reach for.
//
// ── Input shape (verified against real exports 2026-07-27/2026-07-29) ──────
// DATA export: `CompanyHub-localdatafile-YYYYMMDD.json`, produced by
// app/site-functions.js siteBackup() (index.html has a matching sibling). A
// FLAT object: { [localStorageOrKvKey]: <value>, ... } plus one positive
// marker key `_companyHubBackup: true` (site-functions.js siteBackup(),
// ~line 901). There is no other wrapper (no {version, data} envelope). This
// export is DATA-ONLY BY DESIGN (site-functions.js:892-898) -- it never
// contains PDF bytes, so there is no "_pdfStoreMeta.ok" flag to check on it;
// PDFs are a completely separate export (below).
//
// Per-key value shape is NOT uniform, because siteBackup() merges two
// sources with `Object.assign({}, lsData, dbData)` (DB data wins):
//   - Keys hydrated through IndexedDB (app/db.js DB.getAll()) arrive as their
//     real parsed JS value (object/array/number/boolean) already.
//   - Keys that only ever lived in raw localStorage (e.g. ems_leads_v1, which
//     sync-classification.js documents as bypassing the sset()/DB.set()
//     choke point entirely) arrive as a STRING, because siteBackup() reads
//     them with `localStorage.getItem()` and something upstream already
//     called `JSON.stringify()` before `setItem()` (see app/core.js sset()).
//   - A few keys (ch_theme, etc.) are genuinely plain strings written with a
//     bare `localStorage.setItem(key, 'dark')` -- no JSON.stringify involved.
// normalizeValue() below disambiguates the last two cases the only safe way:
// try JSON.parse, and if it throws, keep the raw string.
//
// PDF export: `CompanyHub-PDFs-YYYYMMDD-partNNN.json`, produced by
// app/site-functions.js sitePdfExport() (~line 707), shape
// `{_companyHubPdfExport:true, part, count, items: {<pdfKey>: <base64>, ...}}`.
// Batched by app/site-functions.js's own PDF_EXPORT_BATCH_CHARS (~8MB base64
// per file, site-functions.js:631) specifically so nothing downstream (this
// script included) ever needs to hold more than one batch in memory at once
// -- confirmed real corpus 2026-07-27: 906 part files. `items` keys are the
// same opaque pdfKey strings bill-analysis.js/core.js's _pdfDB uses
// (en_pdf_file_*/en_pdf_shared_*), and netlify/functions/pdf-sync.js's
// objectPath(key) maps a pdfKey straight onto a Storage object path with no
// other transform -- this script does the identical mapping when uploading.
//
// ── Key-namespacing correctness fix (this revision) ─────────────────────────
// The original dry-run script classified every key with
// SyncClassification.shouldReplicate(), which is TRUE for both 'synced' AND
// 'per-user' keys (app/sync-classification.js classifyKey()) and reported
// them together as one "SYNCED" bucket. Measured against the real
// 2026-07-29 export: 151 keys were reported "synced", but 52 of those
// (~34%) are actually 'per-user' (ch_theme, en_bills_zoom_*, bldgperf_cfg_*,
// etc.) -- app/db.js's _wireKey() (db.js:219-224) namespaces a per-user key
// as `${userId}::${key}` on the wire, and _resolveManifestKey()
// (db.js:244-254) explicitly SKIPS any bare (unprefixed) per-user key it
// finds in the manifest ("bare per-user key, no owner prefix at all -- skip
// defensively"). Seeding those 52 keys under their bare names would write
// rows the app can never read back -- silently pointless, not corrupting,
// but wrong. This revision classifies into FOUR buckets (synced / per-user /
// local-only / unclassified) and seeds ONLY the true 'synced' bucket into
// `kv`. Per-user keys are reported (count + keys) but never written here --
// they are one user's own UI prefs, out of scope for a SHARED-data seed, and
// will get created lazily by the sync engine itself once each user signs in
// and touches a per-user key for real (db.js's normal per-user replication
// path, unrelated to this script).
//
// ── Live write path (this revision) ─────────────────────────────────────────
// Talks DIRECTLY to Supabase's REST API (PostgREST for `kv`, Storage API for
// `pdf_blobs`) with the service_role key -- NOT through netlify/functions/
// kv-sync.js or pdf-sync.js. This is deliberate and matches those two
// files' own documented design: pdf-sync.js's header states "[t]he one-time
// bulk PDF seed migration (Phase 3) bypasses this Function entirely
// (direct-to-Storage from home with the service key)" -- the Functions
// enforce Entra JWT auth (verifyAuth()) that a one-time Node migration
// script run from Matt's own machine has no reason to hold. Because this
// script bypasses the Function, Netlify's ~4-6MB synchronous-Function body
// cap and pdf-sync.js's chunk-upload protocol (SINGLE_SHOT_LIMIT_BYTES/
// CHUNK_SIZE) do NOT apply to it -- a single POST straight to Supabase
// Storage can carry a whole PDF (measured up to ~50.6MB raw / 64.33MB
// base64 for Baker's largest combined gas bill) in one request. What DOES
// still apply, and is respected here, is the KB rule that crashed the app
// once already (backlog ed645bbd): never assemble a monolithic multi-
// hundred-MB object in memory. PDFs are migrated ONE FILE, ONE ITEM AT A
// TIME -- a part file's `items` object is read, iterated, uploaded, and
// discarded before the next part file is opened; nothing accumulates
// across files. Data (kv) rows, by contrast, are small enough in aggregate
// (the whole structured export is ~16-23MB, see file-size samples above)
// that holding the parsed export in memory is the same tradeoff the app's
// own siteBackup()/processRestoreFile() already makes -- not a new risk.
//
// kv row write semantics mirror netlify/functions/kv-sync.js's own
// baseVersion===null insert path exactly (same canonical-JSON hash
// algorithm, same version=1 initial row) so a seeded row is
// indistinguishable from one a real client wrote as its first-ever PUT:
//   - key absent  -> INSERT at version 1 (kv-sync.js:279-303 mirrored).
//   - key present, SAME hash -> idempotent no-op (safe re-run of this
//     script, e.g. after a network blip mid-migration).
//   - key present, DIFFERENT hash -> CONFLICT, reported and skipped by
//     default (never silently overwritten -- the same invariant kv-sync.js
//     itself never breaks). Only proceeds to a CAS PATCH overwrite if the
//     operator passes --force, and even then it goes through the identical
//     version-checked UPDATE ... WHERE version=$1 kv-sync.js uses, never a
//     blind write.
// PDF blob writes mirror netlify/functions/pdf-sync.js's commitObject()/
// resolveAgainstExisting() write-once policy exactly: absent -> upload;
// present + identical content (same size AND sha256) -> idempotent no-op;
// present + different content -> conflict, reported, NEVER overwritten
// (there is no --force path for PDFs -- write-once means write-once).
//
// ── Usage ──
//   Dry run (default, safe, no network calls, no credentials needed):
//     node scripts/migrate-seed.js --file <data-export.json> --dry-run
//     node scripts/migrate-seed.js --file <data-export.json> --pdf-dir <dir> --dry-run
//     node scripts/migrate-seed.js --file <data-export.json> --dry-run --json
//
//   Live seed (writes to the REAL Supabase project -- Matt runs this, not an
//   agent). Requires SUPABASE_URL and SUPABASE_SECRET_KEY in the environment,
//   or the script prompts for whichever is missing (secret input is masked,
//   never echoed, never logged):
//     SUPABASE_URL="https://rrdugvwxtddjywqykphf.supabase.co" \
//     SUPABASE_SECRET_KEY="..." \
//     node scripts/migrate-seed.js --file <data-export.json> --pdf-dir <dir> --live
//
// See printUsage() below for the full flag list.
//
// ── PDF content-hash dedup + reference remap (this revision) ────────────────
// Real corpus 2026-08-17: 929 blob keys, ALL named `en_pdf_file_<pdfBillId>`
// (the _saveSinglePDFBill legacy per-bill save path, app/bill-analysis.js
// ~line 15741: `pdfStore('en_pdf_file_' + billId, pdfB64)`), but only 69
// UNIQUE by SHA-256 content (13.5x duplication -- the same source PDF was
// re-saved once per bill period it contained). Uploading all 929 as separate
// Storage objects would waste ~13.5x the space for zero benefit. Instead:
//   1. scanPdfPartFilesForDedup() streams every part file (one file's items
//      in memory at a time, matching this file's existing one-file-at-a-time
//      discipline) and groups blobs by SHA-256 of their raw bytes.
//   2. Each unique hash gets ONE canonical key: `en_pdf_shared_<hash16>`.
//      This is the SAME naming FORM the app already mints itself
//      (bill-analysis.js lines 5525/5860/6323: `'en_pdf_shared_' + <suffix>`)
//      -- the suffix is a fully opaque string to every layer that touches it
//      (core.js pdfStore/pdfLoad key IndexedDB by it verbatim; netlify/
//      functions/pdf-sync.js objectPath(), ~line 247-253, maps it straight
//      onto a Storage path with zero parsing), so a hash-derived suffix
//      resolves exactly as well as a Date.now()-derived one.
//   3. remapPdfReferences() rewrites every bill record's `pdfKey` field
//      (both `en_pdf_bills[]` unassigned-bill records, keyed by `.id`, and
//      `en_utility_<projId>.buildings[].meters[].bills[]` assigned-bill
//      rows, keyed by `.pdfBillId`) to the canonical key for its content
//      hash. It tries the SAME two steps, in the SAME order, that
//      viewSavedPDF() itself tries (app/bill-analysis.js ~line 14806-14837):
//        (a) legacy per-bill key `en_pdf_file_<pdfBillId||id>` (viewSavedPDF
//            step 1, ~line 14814) -- this is where the real 929 blobs
//            actually live in this export, confirmed against the real
//            2026-08-17 corpus (every item key matches `en_pdf_file_pb*`).
//        (b) the record's own pre-existing `pdfKey` (viewSavedPDF step 2,
//            ~line 14815) -- covers the batch shared-key save path. Also
//            confirmed present in the real export: some meter bill rows
//            carry a `pdfKey` like `en_pdf_shared_1777324325880` that does
//            NOT correspond to any blob in the PDF export (stale/unrelated
//            value from a different code path) -- which is exactly why (a)
//            is tried FIRST, matching viewSavedPDF's own priority order.
//      Whichever step resolves, the record's `pdfKey` is overwritten to the
//      canonical key -- from then on every real client's viewSavedPDF step 2
//      finds the shared, deduped object, regardless of which step used to
//      resolve it.
//   4. Live upload (liveSeedPdfFiles) uploads each unique hash's blob to its
//      canonical key exactly ONCE per script run (an in-run Map keyed by
//      hash short-circuits duplicate items without a second network call);
//      commitPdfObject()'s existing write-once/idempotent-retry semantics
//      (pdf-sync.js commitObject() mirror, see below) still apply across
//      separate runs.
// SAFETY (non-negotiable): remapPdfReferences() is run BEFORE buildDataReport()
// so the kv rows/report it produces already reflect the remapped pdfKey
// values. If ANY PDF-claiming bill record (hasPDF/pdfKey/pdfBillId truthy)
// fails BOTH resolution steps above, main() prints the full diagnostic report
// and then THROWS -- dry-run reports this as a failure (not a silent 100%),
// and --live never reaches a write. No bill is ever silently dropped.
// Orphan blobs (a unique hash with zero referencing bill record) are still
// uploaded -- this script never deletes or skips content, only dedupes
// identical bytes onto one shared object (orphan CLEANUP is a separate,
// later, out-of-scope task, item 00a07fef).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const REPO_ROOT = path.join(__dirname, '..');
const SyncClassification = require(path.join(REPO_ROOT, 'app', 'sync-classification.js'));

const SUPABASE_FREE_DB_BYTES = 500 * 1024 * 1024; // 500 MB free-tier Postgres database cap
const SUPABASE_FREE_STORAGE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB free-tier Storage cap
const KNOWN_PROJECT_URL = 'https://rrdugvwxtddjywqykphf.supabase.co'; // project ref rrdugvwxtddjywqykphf -- used only as the DEFAULT if SUPABASE_URL is unset; env var always wins (also lets a local mock override it for testing).
// pdf-sync.js's own single-shot/chunk thresholds, mirrored here in NAME only
// for informational reporting (see file header -- this script's uploads are
// NOT chunked, it bypasses the Function that owns that limit).
const FUNCTION_SINGLE_SHOT_LIMIT_BYTES = 4 * 1024 * 1024;

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file: null,
    pdfFiles: [],
    pdfDir: null,
    dryRun: false,
    live: false,
    json: false,
    allowUnclassified: false,
    force: false,
    operator: 'migration-seed',
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--pdf-file') args.pdfFiles.push(argv[++i]);
    else if (a === '--pdf-dir') args.pdfDir = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--live') args.live = true;
    else if (a === '--json') args.json = true;
    else if (a === '--allow-unclassified') args.allowUnclassified = true;
    else if (a === '--force') args.force = true;
    else if (a === '--operator') args.operator = argv[++i];
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unrecognized argument: ' + a);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/migrate-seed.js --file <data-export.json> [--pdf-dir <dir> | --pdf-file <p.json>]... (--dry-run | --live) [options]',
      '',
      'Input:',
      '  --file <path>           CompanyHub-localdatafile-YYYYMMDD.json structured-data export.',
      '  --pdf-dir <dir>         Directory containing CompanyHub-PDFs-YYYYMMDD-partNNN.json files (all matching files in the dir are used, sorted by part number).',
      '  --pdf-file <path>       A single PDF part file. Repeatable. Combine with --pdf-dir if useful; duplicates are de-duped.',
      '  At least one of --file / --pdf-dir / --pdf-file is required.',
      '',
      'Mode (exactly one required):',
      '  --dry-run               Report what WOULD be written. No network calls, no credentials read. Always safe.',
      '  --live                  Actually write to Supabase. Requires SUPABASE_URL + SUPABASE_SECRET_KEY (env or prompt). NEVER run this as an agent -- Matt runs this.',
      '',
      'Options:',
      '  --json                  Emit the report/summary as machine-readable JSON instead of human-readable text.',
      '  --allow-unclassified    Downgrade an unclassified-key failure to a warning (NOT recommended).',
      '  --force                 On a kv-row hash conflict, overwrite via a version-checked CAS PATCH instead of skipping. Never applies to PDFs (write-once, no force path).',
      '  --operator <email>      Value stored in kv.updated_by for seeded rows. Default "migration-seed".',
      '  --concurrency <n>       Max in-flight requests during --live writes. Default 4.',
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
// and the --live upload path consume. One pass, not two -- hashing already
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
    _scan: scan, // internal use only (data-reference remap + --live upload) -- stripped before any --json print, same convention as dataReport._rows
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
    if (record.pdfKey) {
      const h = scan.blobKeyToHash.get(record.pdfKey);
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
  console.log('CompanyHub migration-seed dry run -- DATA (kv table)');
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
  console.log('Projected seed (SYNCED keys only):');
  console.log('  Rows that would be written to public.kv: ' + report.synced.count);
  console.log('  Total value bytes (canonical JSON):      ' + fmtBytes(report.synced.totalBytes));
  console.log(
    '  Against Supabase free-tier DB cap (500 MB): ' + report.percentOfSupabaseFreeTierDbCap.toFixed(3) + '%',
  );
}

function printHumanPdfReport(report) {
  console.log('');
  console.log('CompanyHub migration-seed dry run -- PDFs (pdf_blobs bucket)');
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

// ── Live: Supabase REST client (no @supabase/supabase-js dependency -- same ──
// bare-fetch pattern netlify/functions/kv-sync.js and pdf-sync.js already use) ─

function pgHeaders(creds, extra) {
  // Never log this object or spread it into console output.
  return Object.assign(
    { apikey: creds.secretKey, Authorization: 'Bearer ' + creds.secretKey, 'Content-Type': 'application/json' },
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
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Mirrors netlify/functions/kv-sync.js handlePut()'s baseVersion===null
// insert branch (kv-sync.js:279-303) exactly, plus a bounded conflict
// resolution (never in kv-sync.js, because kv-sync.js's caller always has a
// real baseVersion once a key exists -- this script's callers never do,
// since it is establishing the row for the first time).
async function commitKvRow(row, creds, opts) {
  const nowIso = new Date().toISOString();
  const insertRes = await fetch(creds.url + '/rest/v1/kv', {
    method: 'POST',
    headers: pgHeaders(creds, { Prefer: 'return=representation' }),
    body: JSON.stringify([
      {
        key: row.key,
        value: row.value,
        version: 1,
        hash: row.hash,
        deleted: false,
        updated_by: opts.operator,
        updated_at: nowIso,
      },
    ]),
  });
  if (insertRes.status === 201) return { key: row.key, status: 'inserted', version: 1 };

  if (insertRes.status === 409) {
    const current = await fetchKvRow(row.key, creds);
    if (current && current.hash === row.hash) {
      return { key: row.key, status: 'noop-identical', version: current.version };
    }
    if (!opts.force) {
      return {
        key: row.key,
        status: 'conflict-skipped',
        serverVersion: current ? current.version : null,
        serverUpdatedBy: current ? current.updated_by : null,
      };
    }
    if (!current) return { key: row.key, status: 'error', error: 'conflict reported but row unreadable on refetch' };
    const patchRes = await fetch(
      creds.url + '/rest/v1/kv?key=eq.' + encodeURIComponent(row.key) + '&version=eq.' + current.version,
      {
        method: 'PATCH',
        headers: pgHeaders(creds, { Prefer: 'return=representation' }),
        body: JSON.stringify({
          value: row.value,
          hash: row.hash,
          deleted: false,
          version: current.version + 1,
          updated_by: opts.operator,
          updated_at: nowIso,
        }),
      },
    );
    if (patchRes.ok) {
      const patched = await patchRes.json();
      if (Array.isArray(patched) && patched.length === 1) {
        return { key: row.key, status: 'force-overwritten', version: current.version + 1 };
      }
    }
    return { key: row.key, status: 'force-overwrite-failed', httpStatus: patchRes.status };
  }

  const errText = await safeText(insertRes);
  return { key: row.key, status: 'error', httpStatus: insertRes.status, error: errText.slice(0, 300) };
}

// ── Live: Storage (pdf_blobs bucket) client ─────────────────────────────────

const PDF_BUCKET = 'pdf_blobs';

function pdfObjectUrl(creds, key) {
  return creds.url + '/storage/v1/object/' + PDF_BUCKET + '/' + String(key).replace(/^\/+/, '');
}

async function pdfStorageStat(key, creds) {
  const res = await fetch(pdfObjectUrl(creds, key), { headers: storageHeaders(creds, { Range: 'bytes=0-0' }) });
  if (res.status === 404) return null;
  if (res.status !== 200 && res.status !== 206) {
    const text = await safeText(res);
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

// ── Credentials (env or masked prompt -- NEVER logged, NEVER hardcoded) ─────

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const onData = (char) => {
      char = char.toString('utf8');
      if (char === '\u0003') {
        // Ctrl+C -> abort, never resolve with a partial secret.
        process.stdout.write('\n');
        process.exit(130);
        return;
      }
      if (char === '\n' || char === '\r' || char === '\u0004') {
        // Enter, or Ctrl+D (EOF, e.g. piped input) -> done.
        stdin.removeListener('data', onData);
        stdin.setRawMode && stdin.setRawMode(false);
        process.stdout.write('\n');
        rl.close();
        resolve(value);
        return;
      }
      if (char === '\u007f' || char === '\b') {
        // Backspace/DEL.
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function getSupabaseCreds() {
  let url = process.env.SUPABASE_URL || KNOWN_PROJECT_URL;
  let secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!process.env.SUPABASE_URL) {
    console.log('SUPABASE_URL not set in env -- defaulting to the known project URL: ' + url);
  }
  if (!secretKey) {
    secretKey = await promptHidden('SUPABASE_SECRET_KEY not set in env. Paste it now (input hidden): ');
  }
  if (!secretKey) {
    throw new Error('No SUPABASE_SECRET_KEY provided (env var or prompt). Aborting -- cannot write live without it.');
  }
  return { url: url.replace(/\/+$/, ''), secretKey };
}

// ── Live orchestration ───────────────────────────────────────────────────────

async function liveSeedData(rows, creds, opts) {
  const results = await mapWithConcurrency(rows, opts.concurrency, (row) => commitKvRow(row, creds, opts));
  const summary = { inserted: 0, noop: 0, conflictSkipped: 0, forceOverwritten: 0, error: 0 };
  for (const r of results) {
    if (r.status === 'inserted') summary.inserted++;
    else if (r.status === 'noop-identical') summary.noop++;
    else if (r.status === 'conflict-skipped') summary.conflictSkipped++;
    else if (r.status === 'force-overwritten') summary.forceOverwritten++;
    else summary.error++;
  }
  return { results, summary };
}

// Uploads only the UNIQUE-by-content-hash blobs, to their canonical
// `en_pdf_shared_<hash16>` key -- NOT the original 929 per-bill
// `en_pdf_file_<id>` keys. An in-run Map (hash -> settled result) makes sure
// a given unique blob is uploaded to Supabase Storage at most ONCE per
// script invocation even though up to ~13.5x as many bill items reference
// it; commitPdfObject()'s own write-once/idempotent-retry semantics still
// apply across SEPARATE script runs (a re-run sees the object already
// exists and no-ops). See file header "PDF content-hash dedup" section.
async function liveSeedPdfFiles(pdfFilePaths, creds, opts) {
  const summary = {
    uploaded: 0,
    noop: 0,
    conflict: 0,
    error: 0,
    skippedDuplicateInRun: 0,
    totalFiles: pdfFilePaths.length,
    totalItems: 0,
    uniqueBlobs: 0,
  };
  const perFileResults = [];
  const hashResultCache = new Map(); // hash -> settled commitPdfObject()-shaped result for this run
  for (const filePath of pdfFilePaths) {
    // ONE part file's items live in memory at a time -- discarded (out of
    // scope, eligible for GC) before the next file is read. See file header.
    const parsed = readPdfPartFile(filePath, true);
    const ids = Object.keys(parsed.items);
    const fileResults = await mapWithConcurrency(ids, opts.concurrency, async (sourceKey) => {
      const base64 = parsed.items[sourceKey];
      let buffer;
      try {
        buffer = Buffer.from(base64, 'base64');
      } catch (e) {
        return { key: sourceKey, sourceKey, status: 'error', error: 'invalid base64' };
      }
      const hash = sha256Buf(buffer);
      const canonicalKey = canonicalPdfKeyForHash(hash);
      if (hashResultCache.has(hash)) {
        const cached = hashResultCache.get(hash);
        return {
          key: canonicalKey,
          sourceKey,
          status: 'skipped-duplicate-in-run',
          dedupedAgainst: cached.status,
        };
      }
      const result = await commitPdfObject(canonicalKey, buffer, hash, creds);
      hashResultCache.set(hash, result);
      return Object.assign({ sourceKey }, result);
    });
    for (const r of fileResults) {
      summary.totalItems++;
      if (r.status === 'uploaded') summary.uploaded++;
      else if (r.status === 'noop-identical') summary.noop++;
      else if (r.status === 'conflict-size-mismatch' || r.status === 'conflict-hash-mismatch') summary.conflict++;
      else if (r.status === 'skipped-duplicate-in-run') summary.skippedDuplicateInRun++;
      else summary.error++;
    }
    perFileResults.push({ file: filePath, part: parsed.part, count: parsed.count, results: fileResults });
    console.log(
      '  [pdf] ' +
        path.basename(filePath) +
        ' (part ' +
        parsed.part +
        ', ' +
        parsed.count +
        ' items) done -- running totals: uploaded=' +
        summary.uploaded +
        ' noop=' +
        summary.noop +
        ' conflict=' +
        summary.conflict +
        ' skipped-dup-in-run=' +
        summary.skippedDuplicateInRun +
        ' error=' +
        summary.error,
    );
    // parsed.items goes out of scope here; nothing from this file is retained.
  }
  summary.uniqueBlobs = hashResultCache.size;
  return { perFile: perFileResults, summary };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
    return;
  }

  const pdfFilePaths = resolvePdfFiles(args);
  if (!args.file && !pdfFilePaths.length) {
    printUsage();
    throw new Error('Nothing to do -- pass --file and/or --pdf-dir/--pdf-file.');
  }
  if (args.dryRun === args.live) {
    throw new Error('Pass exactly one of --dry-run or --live.');
  }

  const dataLoaded = args.file ? loadExport(args.file) : null;
  // PDF dedup scan runs BEFORE buildDataReport() -- and the reference remap
  // runs BEFORE buildDataReport() too -- so the kv rows/report it produces
  // already reflect the REMAPPED, deduped pdfKey values, not the original
  // per-bill en_pdf_file_<id> references. See file header "PDF content-hash
  // dedup + reference remap" section.
  const pdfReport = pdfFilePaths.length ? buildPdfDryRunReport(pdfFilePaths) : null;
  const pdfRemapStats = dataLoaded && pdfReport ? remapPdfReferences(dataLoaded.data, pdfReport._scan) : null;
  const dataReport = dataLoaded ? buildDataReport(dataLoaded, args) : null;

  function printFullReport() {
    if (args.json) {
      const out = {};
      if (dataReport) {
        const { _rows, ...publicReport } = dataReport;
        out.data = publicReport;
      }
      if (pdfReport) {
        const { _scan, ...publicPdfReport } = pdfReport;
        out.pdf = publicPdfReport;
      }
      if (pdfRemapStats) out.pdfRemap = pdfRemapStats;
      console.log(JSON.stringify(out, null, 2));
    } else {
      if (dataReport) printHumanDataReport(dataReport);
      if (pdfReport) printHumanPdfReport(pdfReport);
      if (pdfRemapStats) printHumanPdfRemapReport(pdfRemapStats);
    }
  }

  // SAFETY (non-negotiable, see file header): if ANY PDF-claiming bill
  // record fails to resolve to an uploaded canonical blob, print the full
  // diagnostic report (dry-run OR live) and hard-stop BEFORE any Supabase
  // connection is made. Never a silent partial-integrity seed.
  if (pdfRemapStats && pdfRemapStats.broken.length) {
    printFullReport();
    throw new Error(
      pdfRemapStats.broken.length +
        ' PDF-claiming bill record(s) do not resolve to any blob in the provided PDF export ' +
        '(see the pdfRemap.broken list printed above) -- refusing to proceed. Investigate before re-running.',
    );
  }

  if (args.dryRun) {
    printFullReport();
    if (!args.json) {
      console.log('');
      console.log('DRY RUN ONLY -- no data was written anywhere. No Supabase connection was made.');
    }
    return;
  }

  // --live from here down.
  console.log('LIVE MODE -- this will write to the real Supabase project. Ctrl+C now to abort.');
  const creds = await getSupabaseCreds();

  if (dataReport) {
    console.log('');
    console.log('Seeding ' + dataReport.synced.count + ' data row(s) to public.kv ...');
    const { summary } = await liveSeedData(dataReport._rows, creds, {
      operator: args.operator,
      force: args.force,
      concurrency: args.concurrency,
    });
    console.log(
      'Data seed done -- inserted=' +
        summary.inserted +
        ' noop(identical)=' +
        summary.noop +
        ' conflict-skipped=' +
        summary.conflictSkipped +
        ' force-overwritten=' +
        summary.forceOverwritten +
        ' error=' +
        summary.error,
    );
    if (summary.conflictSkipped) {
      console.log(
        '  ' +
          summary.conflictSkipped +
          ' key(s) already existed server-side with DIFFERENT content and were left untouched ' +
          '(re-run with --force to overwrite via a version-checked CAS PATCH, or investigate first).',
      );
    }
    if (summary.error) {
      console.log('  ' + summary.error + ' key(s) failed outright -- see full JSON output (--json) for details.');
    }
  }

  if (pdfFilePaths.length) {
    console.log('');
    console.log('Seeding PDFs from ' + pdfFilePaths.length + ' part file(s) to the "' + PDF_BUCKET + '" bucket ...');
    const { summary } = await liveSeedPdfFiles(pdfFilePaths, creds, { concurrency: args.concurrency });
    console.log(
      'PDF seed done -- uploaded=' +
        summary.uploaded +
        ' noop(identical)=' +
        summary.noop +
        ' conflict=' +
        summary.conflict +
        ' skipped-dup-in-run=' +
        summary.skippedDuplicateInRun +
        ' error=' +
        summary.error +
        ' / ' +
        summary.totalItems +
        ' total bill references, ' +
        summary.uniqueBlobs +
        ' unique blob(s) actually uploaded to "' +
        PDF_BUCKET +
        '"',
    );
    if (summary.conflict) {
      console.log(
        '  ' +
          summary.conflict +
          ' PDF key(s) already existed with DIFFERENT content -- left untouched (no --force path for PDFs, investigate manually).',
      );
    }
  }

  console.log('');
  console.log('LIVE SEED COMPLETE.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
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
  parseArgs,
  commitKvRow,
  commitPdfObject,
};
