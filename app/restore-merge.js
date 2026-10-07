// restore-merge.js — the ONE merge used by Restore from backup, for sync on
// (current = server values) and sync off (current = this device).
//
// Pure functions, no DOM, no network. Browser global (window.RestoreMerge)
// and Node module (test-restore-merge.js).
//
// Every key belongs to a FAMILY with a POLICY (policyFor). There is no
// generic recursive merge: the data has five kinds of shape and one guess
// cannot be right for all of them (research 2026-10-01-research-data-shapes.md).
//
//   never    Not restored in any mode (identity, migration gates, debug keys,
//            derived caches, junk and inert legacy copies).
//   key      Whole-key value. Add and Merge write it only when the key is
//            absent. Replace writes the backup value.
//   records  A list of records with an id at one or more levels (path).
//            Add appends whole missing records by id; existing records are
//            never touched. Merge = Add + fills EMPTY fields of matched
//            records (never overwrites a non-empty current value). Replace =
//            backup value; removed = every item that disappears at a policy
//            level, with or without id.
//   map      Object keyed by id (pricing catalog). Same rules per entry.
//   frozen   Records that are add-only in EVERY mode (presented savings).
//
// Rules for every policy:
//   - A non-meaningful backup value (undefined/null/""/[]/{}) never replaces
//     a meaningful current value.
//   - Ids match by String(id); the current record keeps its own id type.
//   - Numeric-looking strings compare equal to numbers; the current type stays.
//   - Output keeps the representation of the current value (JSON text stays
//     text, object stays object); an absent (or null) key takes the parsed backup value.
//   - Derived meter caches are stripped from restored utility data.
//   - A tombstoned key (deleted on the server on purpose) is skipped unless
//     the caller lists it in opts.restoreDeleted.
const RestoreMerge = (() => {
  // Engine bookkeeping, identity, migration gates, debug and derived keys.
  const SKIP_KEYS = [
    'ch_replica_state',
    'ch_sync_queue',
    'ch_backend_mode',
    'ch_local_identity',
    'ch_last_user',
    'ch_sync_base',
    'ch_deleted_items',
    'en_deleted_records',
    '_companyHubBackup',
  ];
  // The ONE "engine bookkeeping key" rule for restore and backup: the exact keys
  // above plus the per-key sync records (db.js RV_PREFIX, ch_rv::<key>).
  const isEngineKey = (k) => SKIP_KEYS.indexOf(k) !== -1 || SC.isNeverBackupKey(k); // SC covers the SC.RV_PREFIX records
  const NEVER = [
    [/^ch_user$/, 'signed-in user identity'],
    [/^ch_(seen_version|last_seen_version|qs_seen|idb_migrated|verification_results|notifs)$/, 'device state'],
    [/^_/, 'debug data'],
    [/^en_sewer_backfill_report/, 'debug data'],
    [/^en_utility_.*_v\d+$/, 'migration flag'],
    [/^en_utility_null$/, 'junk key'],
  ];
  // Derived per-meter caches: saveUtilityData() deletes them before every write.
  // The one list lives in app/db.js (DB.DERIVED_METER_FIELDS); db.js loads before this file.
  const METER_CACHE_FIELDS = DB.DERIVED_METER_FIELDS;

  // [test, plain-English label]. First match wins.
  const LABELS = [
    [(k) => k === 'en_projects', 'Projects'],
    [(k) => k === 'en_tasks', 'Tasks'],
    [(k) => k === 'en_customers', 'Customers'],
    [(k) => k === 'ems_leads_v1', 'EMS leads'],
    [(k) => k === 'en_presented_savings', 'Presented savings'],
    [(k) => k === 'en_utility_audit_log', 'Utility bill edit log'],
    [(k) => k.indexOf('en_utility_') === 0, 'Utility bills'],
    [(k) => k.indexOf('en_pdf_bills') === 0, 'Bill PDF list'],
    [(k) => k.indexOf('en_eqmatrix_') === 0, 'Equipment matrix'],
    [(k) => k.indexOf('en_alarms_') === 0, 'BAS alarms'],
    [(k) => k.indexOf('en_bas_') === 0, 'BAS trends'],
    [(k) => k.indexOf('en_pricing_') === 0, 'Pricing'],
    [(k) => k.indexOf('en_report_') === 0, 'Reports'],
    [(k) => k.indexOf('en_agreement_') === 0, 'Service agreements'],
    [(k) => k.indexOf('en_budget_') === 0 || k.indexOf('en_hours_') === 0, 'Budget and hours'],
    [(k) => k === 'en_dc_events', 'District calendar'],
    [(k) => k.indexOf('bldgsavproj_cfg_') === 0 || k.indexOf('bldgperf_cfg_') === 0, 'Building chart settings'],
    [(k) => k.indexOf('sv_') === 0, 'Service department'],
    [
      (k) =>
        k.indexOf('ch_') === 0 ||
        k.indexOf('bills_view_state_') === 0 ||
        k.indexOf('en_bills_zoom_') === 0 ||
        k.indexOf('_zoom') > 0,
      'Display settings',
    ],
  ];
  function labelFor(key) {
    for (const [test, label] of LABELS) if (test(key)) return label;
    return 'Other data';
  }

  const isRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCont = (v) => isRec(v) || Array.isArray(v);
  function meaningful(v) {
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }
  // Backup text holds some numbers as strings: a numeric-looking string equals
  // the number (restore-only rule). The canonical form itself is the ONE
  // function SyncClassification.canonicalJSON, shared with db.js.
  const NUM = /^-?\d+(\.\d+)?$/;
  function numNorm(v) {
    if (Array.isArray(v)) return v.map(numNorm);
    if (isRec(v)) {
      const o = {};
      Object.keys(v).forEach((k) => {
        o[k] = numNorm(v[k]);
      });
      return o;
    }
    if (typeof v === 'string' && NUM.test(v)) return Number(v);
    return v === undefined ? null : v;
  }
  const canon = (v) => SC.canonicalJSON(numNorm(v));
  const same = (a, b) => canon(a) === canon(b);
  // Backup files hold some values as JSON text. Compare and merge real values.
  function parseMaybe(v) {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  }
  const isJsonText = (raw, parsed) => typeof raw === 'string' && typeof parsed !== 'string';

  const ID = (r) => r.id;
  // Calendar event: a string date (the {events:[...]} wrapper has none).
  const dcId = (r) =>
    typeof r.date !== 'string' || !r.date
      ? undefined
      : r.name && r.type
        ? r.date + '|' + r.name + '|' + r.type
        : canon(r);
  // Audit entry identity: the ONE rule lives in sync-classification.js (also used by db.js).
  const SC =
    typeof module !== 'undefined' && module.exports ? require('./sync-classification.js') : window.SyncClassification;
  const auditId = (r) => SC.auditEntryId(r);
  const presentedId = (r) =>
    r.projectId === undefined ? undefined : [r.projectId, r.periodStart, r.periodEnd].join('|');
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  // policyFor(key, backupKeys) -> { kind, path, idOf, name, ... }
  function policyFor(key, backupKeys) {
    if (isEngineKey(key)) return { kind: 'never', why: 'internal setting' };
    for (const [re, why] of NEVER) if (re.test(key)) return { kind: 'never', why };
    if (/^en_utility_\d+$/.test(key)) {
      // Legacy per-project copy. Inert when the backup also holds the live
      // en_utility_cust_<id> keys; the live data in older backups otherwise.
      const hasCust = (backupKeys || []).some((k) => /^en_utility_cust_/.test(k));
      if (hasCust) return { kind: 'never', why: 'legacy copy (the customer data holds the live bills)' };
    }
    if (key === 'en_projects')
      return { kind: 'records', path: [], idOf: ID, name: (r) => str(r.name), cross: 'projects' };
    if (key === 'en_customers')
      return { kind: 'records', path: [], idOf: ID, name: (r) => str(r.name), cross: 'customers' };
    if (key === 'en_tasks')
      return { kind: 'records', path: [], idOf: ID, name: (r) => str(r.text || r.title || r.name) };
    if (key === 'en_report_history')
      return { kind: 'records', path: [], idOf: ID, name: (r) => str(r.title || r.name || r.savedAt) };
    if (key === 'en_presented_savings')
      return {
        kind: 'frozen',
        path: [],
        idOf: presentedId,
        name: (r) => str(r.projectId) + ' ' + str(r.periodStart) + ' to ' + str(r.periodEnd),
      };
    if (key === 'en_utility_audit_log')
      return { kind: 'records', path: [], idOf: auditId, sortBy: 'ts', name: () => '' };
    if (key === 'ems_leads_v1')
      return {
        kind: 'records',
        path: [],
        idOf: ID,
        sortBy: '_origIdx',
        name: (r) => str(r.name || r.company || r.id),
      };
    if (key === 'en_dc_events')
      return { kind: 'records', path: ['events'], idOf: dcId, name: (r) => str(r.name) + ' ' + str(r.date) };
    if (/^en_utility_(cust_.+|\d+)$/.test(key)) {
      return {
        kind: 'records',
        path: ['buildings', 'meters', 'bills'],
        idOf: ID,
        strip: METER_CACHE_FIELDS,
        stripLevel: 2, // levels: 1 = buildings, 2 = meters, 3 = bills
        name: (r, level) => (level === 1 ? str(r.name) : level === 2 ? str(r.label || r.name || r.id) : ''),
        cross: 'utility',
      };
    }
    if (/^en_eqmatrix_cmaps_/.test(key))
      return { kind: 'records', path: [], idOf: (r) => r.rawName, name: (r) => str(r.rawName) };
    if (key === 'en_pricing_catalog') return { kind: 'map', path: [] };
    return { kind: 'key', path: [] };
  }

  function idKey(r, idOf) {
    if (!isRec(r)) return null;
    const id = idOf(r);
    return id === undefined || id === null || id === '' ? null : String(id);
  }
  function stripFields(rec, fields) {
    if (!fields || !isRec(rec)) return rec;
    const out = Object.assign({}, rec);
    fields.forEach((f) => delete out[f]);
    return out;
  }
  // Clean a backup record at `level` (and its policy children) for writing.
  function cleanRec(rec, pol, level) {
    if (!isRec(rec)) return rec;
    let out = pol.strip && pol.stripLevel === level ? stripFields(rec, pol.strip) : rec;
    const child = pol.path[level];
    if (child && Array.isArray(out[child])) {
      out = Object.assign({}, out, { [child]: out[child].map((r) => cleanRec(r, pol, level + 1)) });
    }
    return out;
  }
  // Count of items at policy levels inside one record (itself + descendants).
  function countIn(rec, pol, level) {
    const child = pol.path[level];
    const kids = child && isRec(rec) && Array.isArray(rec[child]) ? rec[child] : [];
    return 1 + kids.reduce((n, r) => n + countIn(r, pol, level + 1), 0);
  }
  function describe(rec, pol, level) {
    const nm = pol.name ? pol.name(rec, level) : '';
    const child = pol.path[level];
    const kids = child && isRec(rec) && Array.isArray(rec[child]) ? rec[child] : [];
    if (!child) return nm;
    const n = kids.reduce((t, r) => t + countIn(r, pol, level + 1), 0);
    const what = pol.path[level + 1] ? child + ' and ' + pol.path[level + 1] : child;
    return (nm || '(no name)') + (n ? ' (' + n + ' ' + what + ')' : '');
  }

  // Fill-only merge of one matched record: empty or missing fields take the
  // meaningful backup value; non-empty current values never change.
  function fill(cur, bak, st) {
    if (!isRec(cur) || !isRec(bak)) return cur;
    let out = cur;
    for (const k of Object.keys(bak)) {
      if (meaningful(cur[k]) || !meaningful(bak[k])) continue;
      if (out === cur) out = Object.assign({}, cur);
      out[k] = bak[k];
    }
    if (out !== cur) st.updated += 1;
    return out;
  }
  function sortList(list, by) {
    if (!by) return list;
    const val = (r) => (isRec(r) ? r[by] : undefined);
    return list.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === undefined || y === undefined) return 0;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  // Backup-wins on one matched record: every field the backup record holds
  // replaces the current value. Fields only the current record holds stay.
  function win(cur, bak, st) {
    if (!isRec(cur) || !isRec(bak)) return cur;
    let out = cur;
    for (const k of Object.keys(bak)) {
      if (bak[k] === undefined || same(cur[k], bak[k])) continue;
      if (out === cur) out = Object.assign({}, cur);
      out[k] = bak[k];
    }
    if (out !== cur) st.updated += 1;
    return out;
  }

  // Add/merge/backup-wins one list level. Current items are never removed or reordered
  // (sortBy only orders the result when the policy says the list is ordered).
  function mergeLevel(cur, bak, pol, level, mode, st) {
    const bakArr = Array.isArray(bak) ? bak : [];
    const out = cur.slice();
    const at = new Map();
    cur.forEach((r, i) => {
      const k = idKey(r, pol.idOf);
      if (k !== null && !at.has(k)) at.set(k, i);
    });
    const dup = new Set(); // ids current holds more than once: left untouched
    const seen = new Set();
    cur.forEach((r) => {
      const k = idKey(r, pol.idOf);
      if (k === null) return;
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    });
    const child = pol.path[level];
    let appended = false;
    for (const b of bakArr) {
      const k = idKey(b, pol.idOf);
      if (k === null) continue; // cannot identify: never added
      if (!at.has(k)) {
        const rec = cleanRec(b, pol, level);
        st.added += countIn(rec, pol, level);
        const nm = describe(rec, pol, level);
        if (nm) st.names.push(nm);
        at.set(k, out.length);
        out.push(rec);
        appended = true;
        continue;
      }
      if (dup.has(k)) {
        st.kept += 1;
        continue;
      }
      const i = at.get(k);
      const c = out[i];
      let next = c;
      if (mode === 'merge' || mode === 'backup-wins') {
        const own = pol.strip && pol.stripLevel === level ? stripFields(b, pol.strip) : Object.assign({}, b);
        if (child) delete own[child];
        next = mode === 'merge' ? fill(c, own, st) : win(c, own, st);
      }
      if (child && Array.isArray(b[child])) {
        const cc = Array.isArray(c[child]) ? c[child] : [];
        const sub = mergeLevel(cc, b[child], pol, level + 1, mode, st);
        if (sub !== cc) next = Object.assign({}, next, { [child]: sub });
      }
      if (next === c) st.kept += 1;
      else out[i] = next;
    }
    if (!appended && out.every((x, i) => x === cur[i])) return cur;
    return appended && pol.sortBy ? sortList(out, pol.sortBy) : out;
  }

  // Items at policy levels in `cur` that `bak` does not have (by id, or by
  // deep-equal for items without an id), including their descendants.
  function removedAtLevels(cur, bak, pol, level) {
    const curArr = Array.isArray(cur) ? cur : [];
    const bakArr = Array.isArray(bak) ? bak : [];
    const by = new Map();
    bakArr.forEach((b) => {
      const k = idKey(b, pol.idOf);
      if (k !== null && !by.has(k)) by.set(k, b);
    });
    const child = pol.path[level];
    let n = 0;
    for (const c of curArr) {
      const k = idKey(c, pol.idOf);
      if (k === null) {
        if (!bakArr.some((b) => same(b, c))) n += countIn(c, pol, level);
      } else if (!by.has(k)) n += countIn(c, pol, level);
      else if (child) n += removedAtLevels(c[child], by.get(k)[child], pol, level + 1);
    }
    return n;
  }
  // Nested data that vanishes inside records MATCHED at policy levels when
  // the backup record replaces the current one: setpoints, zones, snapshot
  // rows, measures, any list or object field the backup record lacks
  // (counted by removedLoose; the policy child list is counted by
  // removedAtLevels). Replace shows the sum so the second confirm is true.
  function removedInMatched(cur, bak, pol, level) {
    const curArr = Array.isArray(cur) ? cur : [];
    const bakArr = Array.isArray(bak) ? bak : [];
    const by = new Map();
    bakArr.forEach((b) => {
      const k = idKey(b, pol.idOf);
      if (k !== null && !by.has(k)) by.set(k, b);
    });
    const child = pol.path[level];
    const omit = (r) => {
      if (!child || !isRec(r)) return r;
      const o = Object.assign({}, r);
      delete o[child];
      return o;
    };
    let n = 0;
    for (const c of curArr) {
      const k = idKey(c, pol.idOf);
      if (k === null || !by.has(k)) continue;
      const b = by.get(k);
      n += removedLoose(omit(c), omit(b));
      if (child) n += removedInMatched(c[child], b[child], pol, level + 1);
    }
    return n;
  }
  // Loose count for whole-key policies: list items (any depth) and
  // object-valued fields in cur that the backup does not have.
  function removedLoose(cur, bak) {
    if (Array.isArray(cur)) {
      const bakArr = Array.isArray(bak) ? bak : [];
      const byId = new Map();
      bakArr.forEach((b) => {
        const k = idKey(b, ID);
        if (k !== null && !byId.has(k)) byId.set(k, b);
      });
      let n = 0;
      for (const c of cur) {
        const k = idKey(c, ID);
        if (k !== null) n += byId.has(k) ? removedLoose(c, byId.get(k)) : 1;
        else if (!bakArr.some((b) => same(b, c))) n += 1;
      }
      return n;
    }
    if (isRec(cur)) {
      let n = 0;
      for (const k of Object.keys(cur)) {
        const cv = cur[k];
        const bv = isRec(bak) ? bak[k] : undefined;
        if (!isCont(cv)) continue;
        if (bv === undefined) n += Array.isArray(cv) ? cv.length : 1;
        else n += removedLoose(cv, bv);
      }
      return n;
    }
    return 0;
  }

  // Result in the representation the current value already has.
  function represent(value, currentRaw, cur, backupRaw, bak) {
    if (currentRaw !== undefined && currentRaw !== null)
      return isJsonText(currentRaw, cur) ? JSON.stringify(value) : value;
    // absent key: objects and arrays are written parsed; scalars keep the backup's own form
    return isCont(value) ? value : backupRaw;
  }

  // mergeValue(key, current, backup, mode, backupKeys)
  //   -> { value, changed, added, updated, kept, removed, names, policy }
  // `current` undefined = key absent.
  function mergeValue(key, currentRaw, backupRaw, mode, backupKeys) {
    const pol = policyFor(key, backupKeys);
    const cur = parseMaybe(currentRaw);
    const bak = parseMaybe(backupRaw);
    const st = { added: 0, updated: 0, kept: 0, removed: 0, names: [] };
    const done = (value, changed) =>
      Object.assign(
        { value: changed ? represent(value, currentRaw, cur, backupRaw, bak) : currentRaw, changed, policy: pol.kind },
        st,
      );
    if (pol.kind === 'never') return Object.assign(done(cur, false), { why: pol.why });

    const list = (v) => (pol.path.length ? (isRec(v) ? v[pol.path[0]] : undefined) : v);
    const cleanAll = (v) => {
      if (pol.kind === 'key' || pol.kind === 'map') return v;
      const l = list(v);
      if (!Array.isArray(l)) return v;
      const cleaned = l.map((r) => cleanRec(r, pol, pol.path.length ? 1 : 0));
      return pol.path.length ? Object.assign({}, v, { [pol.path[0]]: cleaned }) : cleaned;
    };
    const countAll = (v) => {
      const l = list(v);
      if (pol.kind === 'map') return isRec(v) ? Object.keys(v).length : 0;
      return Array.isArray(l) ? l.reduce((n, r) => n + countIn(r, pol, pol.path.length ? 1 : 0), 0) : 0;
    };

    // Absent key: take the backup (cleaned), in every mode.
    if (cur === undefined || cur === null) {
      if (!meaningful(bak)) return done(cur, false);
      const v = cleanAll(bak);
      st.added = Math.max(1, countAll(v));
      if (pol.kind === 'records' || pol.kind === 'frozen') {
        const l = Array.isArray(list(v)) ? list(v) : [];
        l.forEach((r) => {
          const nm = describe(r, pol, pol.path.length ? 1 : 0);
          if (nm) st.names.push(nm);
        });
      }
      return done(v, true);
    }
    if (same(cur, bak)) {
      st.kept = Math.max(1, countAll(cur));
      return done(cur, false);
    }
    // A non-meaningful backup value never replaces a meaningful current one.
    if (!meaningful(bak)) {
      st.kept = Math.max(1, countAll(cur));
      return done(cur, false);
    }

    // 'backup-wins' = "make this backup the server copy": the backup value for
    // every differing plain key and map; every record collection is a union in
    // which the backup record wins on a matched id and server-only records stay.
    // en_presented_savings (frozen client figures) stays add-only.
    if (pol.kind === 'key') {
      if ((mode !== 'replace' && mode !== 'backup-wins') || !meaningful(cur)) {
        if (!meaningful(cur)) {
          st.added = 1;
          return done(bak, true);
        }
        st.kept = 1;
        return done(cur, false);
      }
      st.updated = 1;
      st.removed = removedLoose(cur, bak);
      return done(bak, true);
    }

    if (pol.kind === 'map') {
      if (!isRec(cur) || !isRec(bak)) {
        st.kept = 1;
        return done(cur, false);
      }
      if (mode === 'replace' || mode === 'backup-wins') {
        st.removed = Object.keys(cur).filter((k) => !(k in bak)).length;
        st.added = Object.keys(bak).filter((k) => !(k in cur)).length;
        st.updated = Object.keys(bak).filter((k) => k in cur && !same(cur[k], bak[k])).length;
        st.kept = Object.keys(bak).filter((k) => k in cur && same(cur[k], bak[k])).length;
        return done(bak, true);
      }
      const out = Object.assign({}, cur);
      let changed = false;
      for (const k of Object.keys(bak)) {
        if (!(k in cur)) {
          if (!meaningful(bak[k])) continue;
          out[k] = bak[k];
          st.added += 1;
          st.names.push(k);
          changed = true;
        } else if (mode === 'merge' && isRec(cur[k]) && isRec(bak[k])) {
          const f = fill(cur[k], bak[k], st);
          if (f !== cur[k]) {
            out[k] = f;
            changed = true;
          } else st.kept += 1;
        } else st.kept += 1;
      }
      return done(changed ? out : cur, changed);
    }

    // records / frozen
    const curList = list(cur);
    const bakList = list(bak);
    const eff = pol.kind === 'frozen' ? 'add' : mode;
    if (eff === 'replace') {
      if (!meaningful(curList) && !isRec(cur)) {
        const v = cleanAll(bak);
        st.added = Math.max(1, countAll(v));
        return done(v, true);
      }
      const v = cleanAll(bak);
      const lvl = pol.path.length ? 1 : 0;
      const gone = removedAtLevels(curList, list(v), pol, lvl);
      st.removed = gone + removedInMatched(curList, list(v), pol, lvl);
      st.added = Math.max(0, countAll(v) - (countAll(cur) - gone));
      st.updated = 1;
      if (pol.path.length && isRec(cur))
        st.removed += removedLoose(Object.assign({}, cur, { [pol.path[0]]: undefined }), v);
      return done(v, true);
    }
    if (!Array.isArray(curList)) {
      if (curList === undefined && Array.isArray(bakList) && isRec(cur)) {
        const v = cleanAll(bak);
        const l = list(v);
        st.added = countAll(v);
        l.forEach((r) => {
          const nm = describe(r, pol, 1);
          if (nm) st.names.push(nm);
        });
        return done(Object.assign({}, cur, { [pol.path[0]]: l }), st.added > 0);
      }
      st.kept = 1;
      return done(cur, false);
    }
    const merged = mergeLevel(curList, Array.isArray(bakList) ? bakList : [], pol, pol.path.length ? 1 : 0, eff, st);
    if (merged === curList) {
      if (!st.kept) st.kept = Math.max(1, countAll(cur));
      return done(cur, false);
    }
    const v = pol.path.length ? Object.assign({}, cur, { [pol.path[0]]: merged }) : merged;
    return done(v, true);
  }

  // plan(backup, getCurrent, mode, opts)
  //   opts.isDeleted(key)    -> true when the server holds a tombstone for the key
  //   opts.restoreDeleted    -> array of tombstoned keys the user ticked
  //   opts.allowRemoval      -> array of keys the user ticked in 'backup-wins' mode although
  //                             the backup lacks records the server holds (item.held = false)
  //   opts.isUnreadable(key) -> true when the current server value could not be
  //                             read; the key is never written in any mode
  // -> { items: [{key,label,value,changed,added,updated,kept,removed,names,policy,tombstoned,unreadable,why}],
  //      skipped: [{key, why}], notes: [strings], backupVersion }
  function plan(backup, getCurrent, mode, opts) {
    opts = opts || {};
    const items = [];
    const skipped = [];
    const keys = Object.keys(backup);
    const ticked = new Set(opts.restoreDeleted || []);
    const allowed = new Set(opts.allowRemoval || []);
    const inert = (key, pol, flag) =>
      Object.assign(
        {
          key,
          label: labelFor(key),
          value: undefined,
          changed: false,
          added: 0,
          updated: 0,
          kept: 0,
          removed: 0,
          names: [],
          policy: pol.kind,
          tombstoned: false,
          unreadable: false,
        },
        flag,
      );
    for (const key of keys) {
      const pol = policyFor(key, keys);
      if (pol.kind === 'never') {
        skipped.push({ key, why: pol.why });
        continue;
      }
      if (opts.isUnreadable && opts.isUnreadable(key)) {
        items.push(inert(key, pol, { unreadable: true }));
        continue;
      }
      const tomb = !!(opts.isDeleted && opts.isDeleted(key));
      if (tomb && !ticked.has(key)) {
        items.push(inert(key, pol, { tombstoned: true }));
        continue;
      }
      const r = mergeValue(key, tomb ? undefined : getCurrent(key), backup[key], mode, keys);
      // backup-wins never removes data by default: a key that would remove
      // records waits (held) until the user ticks it.
      const held = mode === 'backup-wins' && r.changed && r.removed > 0 && !allowed.has(key);
      if (held) Object.assign(r, { changed: false, value: undefined });
      items.push(Object.assign({ key, label: labelFor(key), tombstoned: tomb, unreadable: false, held }, r));
    }
    return { items, skipped, notes: crossNotes(items, backup, getCurrent), backupVersion: backupVersion(backup) };
  }
  function backupVersion(backup) {
    const v = parseMaybe(backup.ch_seen_version || backup.ch_last_seen_version);
    return typeof v === 'string' ? v : '';
  }
  // Plain-English notes about cross-key effects of this plan.
  function crossNotes(items, backup, getCurrent) {
    const notes = [];
    const byKey = new Map(items.map((i) => [i.key, i]));
    const projItem = byKey.get('en_projects');
    const projects = parseMaybe(projItem && projItem.changed ? projItem.value : getCurrent('en_projects'));
    const projList = Array.isArray(projects) ? projects : [];
    // Added buildings that no project scope shows. The key is
    // 'en_utility_' + customer id and the customer id is 'cust_<project id>'
    // (utility-data.js: customerId = P.customerId || 'cust_' + P.id), so the
    // key en_utility_cust_<N> belongs to the customer row with id cust_<N>.
    for (const it of items) {
      const m = /^en_utility_(cust_.+)$/.exec(it.key);
      if (!m || !it.changed) continue;
      const curV = parseMaybe(getCurrent(it.key));
      const curIds = new Set(((isRec(curV) && curV.buildings) || []).map((b) => String(b.id)));
      const newV = parseMaybe(it.value);
      const added = ((isRec(newV) && newV.buildings) || []).filter((b) => !curIds.has(String(b.id)));
      const owners = projList.filter((p) => String(p.customerId) === m[1]);
      const orphan = added.filter(
        (b) =>
          !owners.some(
            (p) =>
              p.scope &&
              Array.isArray(p.scope.buildingIds) &&
              p.scope.buildingIds.map(String).indexOf(String(b.id)) !== -1,
          ),
      );
      if (orphan.length)
        notes.push(
          orphan.length +
            ' added building(s) are not in any project scope: ' +
            orphan.map((b) => str(b.name) || str(b.id)).join(', ') +
            '. Add them under the project to see them.',
        );
    }
    // Deletions logged after the backup was made.
    const bakLog = parseMaybe(backup.en_utility_audit_log);
    const curLog = parseMaybe(getCurrent('en_utility_audit_log'));
    if (Array.isArray(bakLog) && Array.isArray(curLog) && bakLog.length) {
      const last = bakLog.reduce((m, e) => (isRec(e) && str(e.ts) > m ? str(e.ts) : m), '');
      const later = curLog.filter((e) => isRec(e) && /^delete/.test(str(e.action)) && str(e.ts) > last).length;
      if (later)
        notes.push(
          later +
            ' bill deletion(s) were logged after this backup. Add and Merge bring back bills that are in the backup.',
        );
    }
    return notes;
  }

  // Group plan items by label for the preview table.
  function summarize(items) {
    const by = new Map();
    for (const it of items) {
      const g = by.get(it.label) || {
        label: it.label,
        added: 0,
        updated: 0,
        kept: 0,
        removed: 0,
        names: [],
        tombstoned: 0,
        unreadable: 0,
      };
      g.added += it.added;
      g.updated += it.updated;
      g.kept += it.kept;
      g.removed += it.removed || 0;
      if (it.changed) g.names = g.names.concat(it.names || []);
      if (it.tombstoned) g.tombstoned += 1;
      if (it.unreadable) g.unreadable += 1;
      by.set(it.label, g);
    }
    return Array.from(by.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  // Keys whose push depends on another key's push (apply or fail together):
  // en_utility_cust_<N> needs its customer row (id cust_<N>, see crossNotes);
  // a key ending in a project id needs that project. Only when the owner
  // record is NEW to the current data.
  function dependsOn(key, backup, getCurrent) {
    const has = (listKey, id) => {
      const l = parseMaybe(getCurrent(listKey));
      return Array.isArray(l) && l.some((r) => isRec(r) && String(r.id) === id);
    };
    const inBackup = (listKey, id) => {
      const l = parseMaybe(backup[listKey]);
      return Array.isArray(l) && l.some((r) => isRec(r) && String(r.id) === id);
    };
    let m = /^en_utility_(cust_.+)$/.exec(key);
    if (m) return inBackup('en_customers', m[1]) && !has('en_customers', m[1]) ? 'en_customers' : null;
    m = /_(\d{6,})$/.exec(key);
    if (m) return inBackup('en_projects', m[1]) && !has('en_projects', m[1]) ? 'en_projects' : null;
    return null;
  }

  return {
    SKIP_KEYS,
    isEngineKey,
    METER_CACHE_FIELDS,
    labelFor,
    policyFor,
    meaningful,
    canon,
    parseMaybe,
    mergeValue,
    plan,
    summarize,
    dependsOn,
  };
})();

if (typeof window !== 'undefined') window.RestoreMerge = RestoreMerge;
if (typeof module !== 'undefined') module.exports = RestoreMerge;
