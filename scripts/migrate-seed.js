#!/usr/bin/env node
// scripts/migrate-seed.js
//
// Phase 3 migration-seed script referenced by app/sync-classification.js's own
// header comment ("Phase 3 — migrate-seed.js's skip list when classifying keys
// out of a siteBackup()/DB.getAll() export"). That comment predates this file;
// this is the first implementation.
//
// Reads a structured-data backup export produced by app/site-functions.js's
// siteBackup() (and index.html's matching sibling) — the file downloaded as
// `CompanyHub-localdatafile-YYYYMMDD.json` — and reports what a Supabase `kv`
// table seed (see netlify/db/schema.sql) WOULD write, without ever connecting
// to Supabase. This script is dry-run-only by design: it has no Supabase
// client, no credentials, and no network calls anywhere in it.
//
// ── Input shape (verified against the real 2026-07-27 export, not assumed) ──
// The export is a FLAT object: { [localStorageOrKvKey]: <value>, ... } plus
// one positive marker key `_companyHubBackup: true` (site-functions.js
// siteBackup(), ~line 901) that identifies the file as a real CompanyHub
// backup. There is no other wrapper (no {version, data} envelope).
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
//     bare `localStorage.setItem(key, 'dark')` — no JSON.stringify involved.
// normalizeValue() below disambiguates the last two cases the only safe way:
// try JSON.parse, and if it throws, keep the raw string. This is verified
// against real write sites (site-ui.js:73 for ch_theme; core.js sset() for
// the JSON.stringify path), not guessed.
//
// ── Format-stability finding (2026-07-27) ──
// The top-level key SET is byte-identical between
// CompanyHub-localdatafile-20260720.json and -20260727.json (159 keys, zero
// additions, zero removals). The export format has NOT changed since 07-20.
// This script does not hardcode that key list anywhere, precisely so a future
// export that DOES add/remove a top-level key is caught (see
// classifyKeys()/UNCLASSIFIED handling below) instead of silently mis-seeded.
//
// ── Out of scope, deliberately ──
// Bill PDFs (CompanyHub-PDFs-YYYYMMDD-partNNN.json, shape
// `{_companyHubPdfExport:true, part, count, items}`) are NEVER read by this
// script. See AI/_context/specs/pdf-storage-architecture-research-2026-07-27.md
// — PDF storage is unsettled pending a client account setup and is going to
// Cloudflare R2 / Supabase Storage, not the Postgres `kv` table this script
// targets. If this script is ever pointed at a PDF part-file by mistake, it
// refuses outright (see loadExport()) rather than attempting to read,
// chunk, or upload it. There is no PDF-upload code path in this file at all —
// nothing to "disable behind a flag" because nothing was ever added.
//
// ── Usage ──
//   node scripts/migrate-seed.js --file <path-to-export.json> --dry-run
//   node scripts/migrate-seed.js --file <path-to-export.json> --json   (machine-readable report)
//
// --dry-run is the ONLY supported mode right now. There is no --live flag,
// no Supabase client dependency, and no network code anywhere in this file.
// Wiring an actual write to Supabase is a separate, later task (out of scope
// here per explicit instruction: do not connect to Supabase, do not write to
// any remote, do not run an actual seed).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const SyncClassification = require(path.join(REPO_ROOT, 'app', 'sync-classification.js'));

const SUPABASE_FREE_DB_BYTES = 500 * 1024 * 1024; // 500 MB free-tier Postgres database cap

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { file: null, dryRun: false, live: false, json: false, allowUnclassified: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--live') args.live = true;
    else if (a === '--json') args.json = true;
    else if (a === '--allow-unclassified') args.allowUnclassified = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      throw new Error('Unrecognized argument: ' + a);
    }
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/migrate-seed.js --file <path-to-export.json> --dry-run [--json] [--allow-unclassified]',
      '',
      '  --file <path>          Path to a CompanyHub-localdatafile-YYYYMMDD.json structured export.',
      '  --dry-run              Required. This script never writes to Supabase; dry-run is the only mode.',
      '  --json                 Emit the report as machine-readable JSON instead of a human-readable summary.',
      '  --allow-unclassified   Downgrade an unclassified-key failure to a warning (NOT recommended --',
      '                         an unclassified key silently defaults LOCAL-ONLY and would never sync).',
    ].join('\n'),
  );
}

// ── Loading + validating the export ─────────────────────────────────────────

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
        'PDF storage is out of scope for this script -- see ' +
        'AI/_context/specs/pdf-storage-architecture-research-2026-07-27.md. ' +
        'Point --file at a CompanyHub-localdatafile-YYYYMMDD.json export instead.',
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

// Disambiguates the two possible shapes a top-level value can take (see file
// header). Returns the "real" JS value that should end up in the `kv.value`
// jsonb column -- never the raw once-JSON-encoded string.
function normalizeValue(raw) {
  if (typeof raw !== 'string') return raw; // already a real object/array/number/boolean/null (came via IndexedDB)
  try {
    return JSON.parse(raw); // was JSON.stringify'd before localStorage.setItem (e.g. ems_leads_v1)
  } catch (e) {
    return raw; // genuinely a plain string (e.g. ch_theme = "dark")
  }
}

// Stable-key-sorted JSON serialization, matching the hashing convention
// documented in netlify/functions/kv-sync.js and netlify/db/schema.sql
// ("SHA-256 of a canonical (stable-key-sorted) JSON serialization of value").
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

// Keys stamped onto the export by the export mechanism ITSELF (a positive
// marker, not user/app data -- see app/site-functions.js siteBackup()
// ~line 901). These are never eligible for seeding regardless of what
// app/sync-classification.js says about them, but they are NOT silently
// dropped from the report either: `_companyHubBackup` is not present in
// sync-classification.js's SYNCED/LOCAL_ONLY/LOCAL_ONLY_OVERRIDES tables at
// all, so left unhandled it would hit the same silent-default-LOCAL-ONLY
// path as any other unclassified key. It is called out explicitly here
// (category "meta") so that fact is visible in every report instead of
// being swallowed by a blanket filter.
const META_KEYS = ['_companyHubBackup'];

// ── Classification cross-check against app/sync-classification.js ──────────
//
// Data-driven, on purpose: this does NOT reimplement SyncClassification's
// matching rules. It calls the real shouldReplicate() and detects the
// "unclassified, defaulted to LOCAL-ONLY" path by temporarily intercepting
// console.warn, because that is the ONLY externally-observable signal
// shouldReplicate() gives for "this key fell through every table" (see
// sync-classification.js's own doc comment on the default branch). This way
// the check tracks sync-classification.js's real behavior even if its
// internal matching logic changes later -- reimplementing the prefix/exact
// matching here would silently drift out of sync with the source of truth.
//
// META_KEYS are run through the SAME classification call as everything else
// (nothing is filtered out before this point) so an unclassified meta key is
// counted and reported, then routed to `meta` afterward rather than into
// `unclassified` (which would otherwise fail the run -- see buildReport()).
function classifyKeys(data) {
  const keys = Object.keys(data);
  const synced = [];
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
      result = SyncClassification.shouldReplicate(k);
    } finally {
      console.warn = originalWarn;
    }
    if (warned) unclassified.push(k);
    else if (result) synced.push(k);
    else localOnly.push(k);
  }

  return { synced, localOnly, unclassified, meta };
}

// ── Report ───────────────────────────────────────────────────────────────────

function buildReport(loaded, args) {
  const { data, fileSizeBytes, path: filePath } = loaded;
  const { synced, localOnly, unclassified, meta } = classifyKeys(data);

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

  const rows = synced.map((key) => {
    const value = normalizeValue(data[key]);
    const canonicalJson = canonicalStringify(value);
    return {
      key,
      bytes: Buffer.byteLength(canonicalJson, 'utf8'),
      hash: sha256(canonicalJson),
    };
  });

  const totalSyncedBytes = rows.reduce((sum, r) => sum + r.bytes, 0);

  return {
    file: filePath,
    fileSizeBytes,
    totalTopLevelKeys: Object.keys(data).length,
    synced: {
      count: synced.length,
      keys: synced,
      rows,
      totalBytes: totalSyncedBytes,
    },
    localOnly: {
      count: localOnly.length,
      keys: localOnly,
    },
    unclassified: {
      count: unclassified.length,
      keys: unclassified,
    },
    meta: {
      count: meta.length,
      keys: meta,
      note: 'Export-mechanism marker keys (e.g. _companyHubBackup) -- not present in sync-classification.js at all, never seeded, reported separately so the gap stays visible.',
    },
    supabaseFreeTierDbCapBytes: SUPABASE_FREE_DB_BYTES,
    percentOfSupabaseFreeTierDbCap: (totalSyncedBytes / SUPABASE_FREE_DB_BYTES) * 100,
  };
}

function printHumanReport(report) {
  console.log('CompanyHub migration-seed dry run');
  console.log('==================================');
  console.log('File:                     ' + report.file);
  console.log('File size on disk:        ' + fmtBytes(report.fileSizeBytes));
  console.log('Top-level keys in export: ' + report.totalTopLevelKeys);
  console.log('');
  console.log('Classification (via app/sync-classification.js):');
  console.log('  SYNCED (would be seeded):     ' + report.synced.count);
  console.log('  LOCAL-ONLY (never seeded):    ' + report.localOnly.count);
  console.log('  UNCLASSIFIED (would default local-only + console.warn): ' + report.unclassified.count);
  if (report.unclassified.count) {
    console.log('    -> ' + report.unclassified.keys.join(', '));
  }
  console.log('  META (export-marker keys, not in sync-classification.js, never seeded): ' + report.meta.count);
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
  console.log('');
  console.log('DRY RUN ONLY -- no data was written anywhere. No Supabase connection was made.');
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// ── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    printUsage();
    process.exit(args.help ? 0 : 1);
    return;
  }
  if (args.live) {
    throw new Error(
      'Live seeding is not implemented in this script and is intentionally out of scope -- ' +
        'no Supabase client, credentials, or network code exists in migrate-seed.js. ' +
        'Re-run with --dry-run.',
    );
  }
  if (!args.dryRun) {
    throw new Error('Pass --dry-run explicitly. --dry-run is the only supported mode right now.');
  }

  const loaded = loadExport(args.file);
  const report = buildReport(loaded, args);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { loadExport, normalizeValue, canonicalStringify, classifyKeys, buildReport, parseArgs };
