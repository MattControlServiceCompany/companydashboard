#!/usr/bin/env node
// scripts/calendar-daily-sync.js
//
// The daily calendar update. For every project with a calendar feed, it does what "Sync now" does (District Calendar tab):
// reads the feed, compares it with the saved copy, and saves the new copy, the history record and the schedule actions.
// It runs on GitHub Actions (.github/workflows/calendar-daily-sync.yml), with no page open.
//
// One implementation: nothing here decides what to save.
//   feed read           netlify/functions/lib/calendar/snapshot.mjs  buildSnapshot (the same code as calendar-fetch)
//   what to save        computations/calendar-sync.js                CalendarSync.plan (the same code as the page's Sync now)
//   comparison          app/calendar-diff.js                         CalendarDiff.diffSnapshots
//   actions             computations/sched-actions.js                SchedActions.buildInput, persistPlan
//   hash                netlify/lib/kv-hash.js                       the same hash kv-sync writes
//
// Env (names only): SUPABASE_URL, SUPABASE_SECRET_KEY. Never printed.
// Usage:
//   node scripts/calendar-daily-sync.js                 read the feed and save the changes
//   node scripts/calendar-daily-sync.js --dry-run       do everything except the writes; print the plan (still reads the database)
//   node scripts/calendar-daily-sync.js --data-file <backup.json> --pull-info <pull-info.json>
//                                                       read a LOCAL copy instead of the database (always a dry run)
// Exit code: 0 done (or no change), 1 a feed or database error, 2 a version conflict that stayed after one retry.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const CalendarDiff = require('../app/calendar-diff.js');
const BasAuditLog = require('../app/bas-audit-log.js');
const SchedActions = require('../computations/sched-actions.js');
const CalendarSync = require('../computations/calendar-sync.js');
const { canonicalJSON, sha256Hex } = require('../netlify/lib/kv-hash.js');

const WRITER = 'daily-calendar-sync';
// Keys read for one project (the feed address, the saved copy, and what the actions check reads).
const READ_KINDS = ['cfg', 'snap', 'hist'].map((k) => 'en_cal_' + k + '_').concat(
  ['en_sched_actions_', 'en_bas_acthist_', 'en_space_map_', 'en_bas_snap_', 'en_bas_groups_', 'en_bas_auditevents_', 'en_eqmatrix_'],
);

class ConflictError extends Error {}

const sha = (value) => sha256Hex(canonicalJSON(value));

// --- the stores: the database (PostgREST), or a local copy (read only) ---------------------------
function remoteStore(url, secret, fetchImpl) {
  const base = String(url).replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1/';
  const hdr = (extra) => Object.assign({ apikey: secret, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, extra || {});
  async function call(method, rel, body, extra) {
    const res = await fetchImpl(base + rel, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    return res;
  }
  async function getRows(rel) {
    const res = await call('GET', rel);
    if (!res.ok) throw new Error('database read failed (' + res.status + ')');
    return res.json();
  }
  return {
    writable: true,
    async listFeedKeys() {
      const rows = await getRows('kv?key=like.en_cal_cfg_*&deleted=eq.false&select=key');
      return rows.map((r) => r.key).filter((k) => /^en_cal_cfg_.+/.test(k));
    },
    // keys -> { key: row } for the rows that exist
    async read(keys) {
      const rows = await getRows('kv?key=in.(' + keys.map(encodeURIComponent).join(',') + ')&select=key,value,version,hash,deleted,updated_by');
      return Object.fromEntries(rows.map((r) => [r.key, r]));
    },
    // Writes every key of `writes` ({key: value}) against the rows read (`rows`). Each key: history row, then a version-checked write.
    // Throws ConflictError when a version moved. Never overwrites a newer row.
    async apply(writes, rows) {
      const keys = Object.keys(writes);
      const now = await this.read(keys);
      for (const k of keys) {
        const have = rows[k] ? rows[k].version : null;
        const cur = now[k] ? now[k].version : null;
        if (have !== cur) throw new ConflictError('version of ' + k + ' moved');
      }
      const out = {};
      for (const k of keys) {
        const row = rows[k];
        const value = writes[k];
        const at = new Date().toISOString();
        if (!row) {
          const res = await call('POST', 'kv', [{ key: k, value, version: 1, hash: sha(value), deleted: false, updated_by: WRITER, updated_at: at }], { Prefer: 'return=minimal' });
          if (res.status === 409) throw new ConflictError('key ' + k + ' was created by someone else');
          if (!res.ok) throw new Error('database insert failed (' + res.status + ')');
          out[k] = 1;
          continue;
        }
        // The replaced copy first, as kv-sync does (one history row for each key and version).
        const have = await getRows('kv_history?key=eq.' + encodeURIComponent(k) + '&version=eq.' + row.version + '&select=id&limit=1');
        if (!have.length) {
          const h = await call('POST', 'kv_history', [{ key: k, value: row.value, version: row.version, updated_by: row.updated_by, replaced_at: at }], { Prefer: 'return=minimal' });
          if (!h.ok) throw new Error('history write failed (' + h.status + '): nothing was written for ' + k);
        }
        const res = await call(
          'PATCH',
          'kv?key=eq.' + encodeURIComponent(k) + '&version=eq.' + row.version,
          { value, hash: sha(value), deleted: false, version: row.version + 1, updated_by: WRITER, updated_at: at },
          { Prefer: 'return=representation' },
        );
        if (!res.ok) throw new Error('database update failed (' + res.status + ')');
        const patched = await res.json();
        if (!Array.isArray(patched) || patched.length !== 1) throw new ConflictError('version of ' + k + ' moved during the write');
        out[k] = row.version + 1;
      }
      return out;
    },
  };
}

// A local backup (flat { key: value } JSON) and its pull-info file (versions). Read only.
function fileStore(dataFile, infoFile) {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const ver = {};
  if (infoFile) JSON.parse(fs.readFileSync(infoFile, 'utf8')).rows.forEach((r) => (ver[r.key] = r.version));
  return {
    writable: false,
    async listFeedKeys() {
      return Object.keys(data).filter((k) => /^en_cal_cfg_.+/.test(k));
    },
    async read(keys) {
      const out = {};
      keys.forEach((k) => {
        if (data[k] !== undefined) out[k] = { key: k, value: data[k], version: ver[k] || 1, deleted: false };
      });
      return out;
    },
    async apply() {
      throw new Error('a local copy is read only');
    },
  };
}

// --- one project ---------------------------------------------------------------------------------
function makeIo(rows, projects, pid, nowIso) {
  const get = (key, fb) => (rows[key] && !rows[key].deleted && rows[key].value !== undefined ? rows[key].value : fb);
  const cfg = get('en_cal_cfg_' + pid, null);
  const tz = (cfg && cfg.timezone) || 'America/Chicago';
  return {
    get,
    matrixRows: (p) => (get('en_eqmatrix_' + p, null) || {}).rows || [],
    manualRows: (p) => {
      const proj = projects.find((x) => String(x && x.id) === String(p));
      return CalendarDiff.manualRows((proj && proj.districtCalendar) || [], tz);
    },
    auditList: (store) => BasAuditLog.changeList(store, {}),
    now: nowIso,
  };
}

const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadProject(store, pid) {
  const rows = await store.read(READ_KINDS.map((k) => k + pid).concat(['en_projects']));
  const proj = rows.en_projects && !rows.en_projects.deleted ? rows.en_projects.value : [];
  return { rows, projects: Array.isArray(proj) ? proj : [] };
}

async function syncProject(store, pid, ctx) {
  const { log, now, dryRun, buildSnapshot, fetchImpl } = ctx;
  const first = await loadProject(store, pid);
  const cfgRow = first.rows['en_cal_cfg_' + pid];
  const cfg = cfgRow && !cfgRow.deleted ? cfgRow.value : null;
  if (!cfg || !cfg.icsUrl) return { pid, status: 'skipped' };
  let snap;
  try {
    snap = CalendarSync.savedCopy(await buildSnapshot({ icsUrl: cfg.icsUrl, timezone: cfg.timezone }, { fetchImpl, now }));
  } catch (e) {
    // Fixed text only: the feed address is a secret link and must not reach the log.
    log('project ' + pid + ': the calendar feed could not be read (' + (e && e.name) + '). Nothing was written.');
    return { pid, status: 'feed-error' };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { rows, projects } = attempt === 1 ? first : await loadProject(store, pid);
    const io = makeIo(rows, projects, pid, now.toISOString());
    const old = io.get('en_cal_snap_' + pid, null);
    if (!CalendarSync.hasChange(old, snap)) {
      log('project ' + pid + ': no change (' + snap.count + ' events). Nothing was written.');
      return { pid, status: 'no-change', count: snap.count };
    }
    const plan = CalendarSync.plan({ pid, snap, io, ids: { hist: newId('calh_'), act: newId('bash_') } });
    const keys = Object.keys(plan.writes);
    const lines = keys.map((k) => '  ' + k + ': v' + (rows[k] ? rows[k].version + ' -> v' + (rows[k].version + 1) : 'none -> v1') + ', ' + Buffer.byteLength(JSON.stringify(plan.writes[k])) + ' bytes');
    const c = plan.counts;
    const what = plan.first ? 'first copy, ' + snap.count + ' events' : c.added + ' added, ' + c.removed + ' removed, ' + c.changed + ' changed, ' + snap.count + ' events';
    if (dryRun || !store.writable) {
      log('project ' + pid + ': DRY RUN, would write ' + keys.length + ' keys (' + what + ')\n' + lines.join('\n'));
      return { pid, status: 'dry-run', counts: c, keys, count: snap.count, writes: plan.writes };
    }
    try {
      const versions = await store.apply(plan.writes, rows);
      // Read back: the row must hold exactly what was planned, with the new version and hash.
      const back = await store.read(keys);
      for (const k of keys) {
        const r = back[k];
        if (!r || r.version !== versions[k] || r.hash !== sha(plan.writes[k]) || canonicalJSON(r.value) !== canonicalJSON(plan.writes[k])) {
          log('project ' + pid + ': READ-BACK FAILED for ' + k);
          return { pid, status: 'readback-failed' };
        }
      }
      log('project ' + pid + ': wrote ' + keys.length + ' keys (' + what + '), read back OK\n' + lines.join('\n'));
      return { pid, status: 'written', counts: c, keys, count: snap.count };
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      log('project ' + pid + ': ' + e.message + (attempt === 1 ? '. Read again and try once more.' : '. Stopped. Nothing newer was overwritten.'));
      if (attempt === 2) return { pid, status: 'conflict' };
    }
  }
  return { pid, status: 'conflict' };
}

async function run(opts) {
  const o = Object.assign({ log: console.log, now: new Date(), dryRun: false, fetchImpl: fetch }, opts);
  if (!o.buildSnapshot) o.buildSnapshot = (await import(pathToFileURL(path.join(__dirname, '../netlify/functions/lib/calendar/snapshot.mjs')).href)).buildSnapshot;
  const keys = await o.store.listFeedKeys();
  const results = [];
  for (const key of keys) results.push(await syncProject(o.store, key.slice('en_cal_cfg_'.length), o));
  if (!keys.length) o.log('No project has a calendar feed. Nothing to do.');
  const bad = results.some((r) => r.status === 'feed-error' || r.status === 'readback-failed');
  const conflict = results.some((r) => r.status === 'conflict');
  return { results, exitCode: conflict ? 2 : bad ? 1 : 0 };
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (n) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : null);
  const dataFile = arg('--data-file');
  let store;
  if (dataFile) store = fileStore(dataFile, arg('--pull-info'));
  else {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      console.log('SUPABASE_URL and SUPABASE_SECRET_KEY must be set.'); // names only
      process.exit(1);
    }
    store = remoteStore(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, fetch);
  }
  const r = await run({ store, dryRun: a.includes('--dry-run') || !!dataFile });
  process.exit(r.exitCode);
}

module.exports = { run, remoteStore, fileStore, ConflictError, WRITER };
if (require.main === module) {
  main().catch((e) => {
    console.log('FAILED: ' + (e && e.message)); // no secret and no feed address in this text
    process.exit(1);
  });
}
