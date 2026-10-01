// restore-merge.js — the ONE merge implementation used by Restore from backup,
// for sync on (current = server values) and sync off (current = local values).
//
// Pure functions, no DOM, no network. Works as a browser global
// (window.RestoreMerge) and as a Node require() module (tests).
//
// Modes:
//   'add'     Add missing only (default). Existing data is never changed.
//   'merge'   Backup updates records with the same id. Nothing is removed.
//   'replace' Backup value replaces the current value (explicit choice only);
//             records not in the backup are removed.
// Add and merge never remove anything. Replace removes records that are not in
// the backup (the preview shows the count) but never blanks a non-empty value.
//
// Record identity (found in the code, not guessed):
//   en_projects, en_tasks, en_customers, ems_leads_v1, en_report_history
//     (global), ch_notifs ............. top-level list, field `id`
//     (app/db.js UNION_KEY_CONFIG uses `.id` for en_projects/en_tasks/en_customers)
//   en_utility_<pid> / en_utility_cust_<id> ... {buildings:[{id, meters:[{id,
//     bills:[{id}]}]}]}  three nested lists, field `id` at each level
//   en_eqmatrix_<pid> ............ {rows:[{id}]}; other fields stay as they are
//   en_eqmatrix_cmaps_<pid> ...... top-level list, field `rawName`
//   en_dc_events ................. {events:[...]}; id = date|name|type
//     (same identity app/db.js UNION_KEY_CONFIG uses)
//   en_pricing_catalog ........... object map keyed by SKU
//   any other key whose value is a list of objects that ALL have `id` -> by `id`
//   everything else (BAS alarm rows, audit log, per-project report history,
//   settings, numbers, strings) has no stable id -> "kept (already exists)".
const RestoreMerge = (() => {
  // Engine bookkeeping and the backup marker are never restored.
  const SKIP_KEYS = ['ch_replica_state', 'ch_sync_queue', 'ch_backend_mode', 'ch_local_identity', '_companyHubBackup'];

  // [test, plain-English label]. First match wins.
  const LABELS = [
    [(k) => k === 'en_projects', 'Projects'],
    [(k) => k === 'en_tasks', 'Tasks'],
    [(k) => k === 'en_customers', 'Customers'],
    [(k) => k === 'ems_leads_v1', 'EMS leads'],
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
    [(k) => k.indexOf('ch_') === 0 || k.indexOf('en_bills_zoom_') === 0 || k.indexOf('_zoom') > 0, 'Display settings'],
  ];
  function labelFor(key) {
    for (const [test, label] of LABELS) if (test(key)) return label;
    return 'Other data';
  }

  // Shape of a key: { path: [listNames], idOf } for lists of records, or
  // { map: true } for an id-keyed object, or null (no stable id).
  const ID = (r) => r && r.id;
  // Same identity as app/db.js (date|name|type). When any of the three is
  // missing, use every field so different events do not collapse together.
  const dcId = (r) => {
    if (!r) return r;
    return r.date && r.name && r.type ? r.date + '|' + r.name + '|' + r.type : canon(r);
  };
  function specFor(key) {
    if (key === 'en_pricing_catalog') return { map: true };
    if (key === 'en_dc_events') return { path: ['events'], idOf: dcId };
    if (key.indexOf('en_eqmatrix_cmaps_') === 0) return { path: [], idOf: (r) => r && r.rawName };
    if (key === 'en_eqmatrix_' || /^en_eqmatrix_\d/.test(key)) return { path: ['rows'], idOf: ID };
    if (/^en_utility_(cust_)?[^_]*$/.test(key) && key !== 'en_utility_audit_log') {
      return { path: ['buildings', 'meters', 'bills'], idOf: ID };
    }
    return { path: [], idOf: ID }; // generic: top-level list where every item has `id`
  }

  function isEmpty(v) {
    if (v === undefined || v === null || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return (
        '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
          .join(',') +
        '}'
      );
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function same(a, b) {
    return canon(a) === canon(b);
  }
  // Backup files hold some values as JSON text. Compare and merge real values.
  function parseMaybe(v) {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  }

  const isRec = (r) => r && typeof r === 'object' && !Array.isArray(r);
  function hasId(r, idOf) {
    const id = idOf(r);
    return id !== undefined && id !== null && id !== '';
  }
  // A list is mergeable when every item is a record and at least one has an id.
  function listOk(list, idOf) {
    return Array.isArray(list) && list.every(isRec) && (list.length === 0 || list.some((r) => hasId(r, idOf)));
  }
  function countLeaves(list, path) {
    if (!Array.isArray(list)) return 0;
    if (path.length === 0) return list.length;
    return list.reduce((n, r) => n + countLeaves(r[path[0]], path.slice(1)), 0);
  }

  // Merge one list level. Returns merged list or null when not applicable.
  // `names` = remaining child-list names below this level.
  // Rules (add and merge): current records are never removed; a field that
  // exists only in the current record is kept; a duplicate id in the backup
  // resolves to the LAST one; records without an id are kept as they are and
  // backup records without an id are appended only when no deep-equal record
  // exists in the current list.
  function mergeList(cur, bak, names, idOf, mode, st) {
    if (!listOk(cur, idOf) || !listOk(bak, idOf)) return null;
    const out = cur.slice();
    const at = new Map();
    cur.forEach((r, i) => {
      if (hasId(r, idOf)) at.set(idOf(r), i);
    });
    const byId = new Map();
    const noId = [];
    for (const b of bak) {
      if (hasId(b, idOf)) byId.set(idOf(b), b); // last duplicate wins
      else noId.push(b);
    }
    for (const [id, b] of byId) {
      if (!at.has(id)) {
        st.added += names.length ? countLeaves([b], names) : 1;
        out.push(b);
        at.set(id, out.length - 1);
        continue;
      }
      const i = at.get(id);
      const c = out[i];
      if (names.length) {
        // Parent record: children merge; the record's own fields follow the mode.
        // Merge starts from the CURRENT record, so fields only in current stay.
        const child = names[0];
        const cc = Array.isArray(c[child]) ? c[child] : [];
        const bc = Array.isArray(b[child]) ? b[child] : [];
        const sub = mergeList(cc, bc, names.slice(1), idOf, mode, st);
        if (sub === null) return null;
        const next = Object.assign({}, c, mode === 'merge' ? b : {});
        if (Array.isArray(c[child]) || sub.length) next[child] = sub;
        else delete next[child];
        if (mode === 'merge') {
          const own = (r) => Object.assign({}, r, { [child]: null });
          if (!same(own(next), own(c))) st.updated += 1;
        }
        if (!same(next, c)) out[i] = next;
      } else if (same(c, b)) {
        st.kept += 1;
      } else if (mode === 'merge') {
        st.updated += 1;
        out[i] = Object.assign({}, c, b);
      } else {
        st.kept += 1;
      }
    }
    for (const b of noId) {
      if (out.some((o) => same(o, b))) {
        st.kept += 1;
      } else {
        st.added += names.length ? countLeaves([b], names) : 1;
        out.push(b);
      }
    }
    return out;
  }

  // Records in `cur` that a Replace would drop because `bak` has no match.
  function removedList(cur, bak, names, idOf) {
    if (!Array.isArray(cur)) return 0;
    const bakArr = Array.isArray(bak) ? bak : [];
    const bakBy = new Map();
    bakArr.forEach((b) => {
      if (isRec(b) && hasId(b, idOf)) bakBy.set(idOf(b), b);
    });
    let n = 0;
    for (const c of cur) {
      if (isRec(c) && hasId(c, idOf)) {
        const b = bakBy.get(idOf(c));
        if (!b) n += names.length ? countLeaves([c], names) : 1;
        else if (names.length) n += removedList(c[names[0]], b[names[0]], names.slice(1), idOf);
      } else if (!bakArr.some((b) => same(b, c))) {
        n += 1;
      }
    }
    return n;
  }
  // Fallback for values without an id spec: list items that are not
  // deep-equal to any backup item (top-level list, or lists inside an object).
  function removedLoose(cur, bak) {
    const cnt = (c, b) => (Array.isArray(c) ? c.filter((x) => !(Array.isArray(b) ? b : []).some((y) => same(x, y))).length : 0);
    if (Array.isArray(cur)) return cnt(cur, bak);
    if (isRec(cur)) {
      return Object.keys(cur).reduce((n, k) => n + cnt(cur[k], isRec(bak) ? bak[k] : undefined), 0);
    }
    return 0;
  }
  function removedCount(key, cur, bak) {
    const spec = specFor(key);
    if (spec.map) {
      return isRec(cur) ? Object.keys(cur).filter((k) => !(isRec(bak) && k in bak)).length : 0;
    }
    if (spec.path.length === 0) {
      return listOk(cur, spec.idOf) && listOk(bak, spec.idOf) ? removedList(cur, bak, [], spec.idOf) : removedLoose(cur, bak);
    }
    const f = spec.path[0];
    if (isRec(cur) && isRec(bak) && listOk(cur[f], spec.idOf) && listOk(bak[f], spec.idOf)) {
      return removedList(cur[f], bak[f], spec.path.slice(1), spec.idOf);
    }
    return removedLoose(cur, bak);
  }

  function mergeMap(cur, bak, mode, st) {
    const isMap = (m) => m && typeof m === 'object' && !Array.isArray(m);
    if (!isMap(cur) || !isMap(bak)) return null;
    const out = Object.assign({}, cur);
    for (const id of Object.keys(bak)) {
      if (!(id in cur)) {
        out[id] = bak[id];
        st.added += 1;
      } else if (same(cur[id], bak[id])) {
        st.kept += 1;
      } else if (mode === 'merge') {
        out[id] = bak[id];
        st.updated += 1;
      } else {
        st.kept += 1;
      }
    }
    return out;
  }

  function wholeCount(key, v) {
    const spec = specFor(key);
    if (spec.map) return v && typeof v === 'object' ? Object.keys(v).length : 1;
    const top = spec.path.length ? v && v[spec.path[0]] : v;
    if (Array.isArray(top)) return Math.max(1, countLeaves(top, spec.path.slice(1)));
    return 1;
  }

  // mergeValue(key, current, backup, mode)
  //   -> { value, changed, added, updated, kept, removed }
  // `current` undefined = key absent. Add and merge never remove anything.
  // Replace sets the key to the backup value and reports `removed` = records
  // in current that the backup does not have. Replace never blanks a
  // non-empty current value with an empty backup value.
  function mergeValue(key, currentRaw, backupRaw, mode) {
    const cur = parseMaybe(currentRaw);
    const bak = parseMaybe(backupRaw);
    const res = (value, changed, added, updated, kept, removed) => ({ value, changed, added, updated, kept, removed: removed || 0 });
    if (same(cur, bak) && !(cur === undefined)) return res(cur, false, 0, 0, wholeCount(key, cur));
    if (isEmpty(bak) && !isEmpty(cur)) return res(cur, false, 0, 0, 1); // never blank out existing data
    if (mode === 'replace' && !isEmpty(cur)) {
      const m = mergeValue(key, cur, bak, 'merge');
      const removed = removedCount(key, cur, bak);
      return m.changed ? res(bak, true, m.added, m.updated, m.kept, removed) : res(bak, true, 0, 1, m.kept, removed);
    }
    if (isEmpty(cur)) {
      if (isEmpty(bak) && cur !== undefined) return res(cur, false, 0, 0, 0);
      return res(bak, true, wholeCount(key, bak), 0, 0);
    }

    const spec = specFor(key);
    const st = { added: 0, updated: 0, kept: 0 };
    let merged = null;
    if (spec.map) {
      merged = mergeMap(cur, bak, mode, st);
    } else if (spec.path.length === 0) {
      merged = mergeList(cur, bak, [], spec.idOf, mode, st);
    } else if (cur && bak && typeof cur === 'object' && !Array.isArray(cur) && typeof bak === 'object') {
      const sub = mergeList(cur[spec.path[0]], bak[spec.path[0]], spec.path.slice(1), spec.idOf, mode, st);
      merged = sub === null ? null : Object.assign({}, cur, { [spec.path[0]]: sub });
    }
    if (merged === null) return res(cur, false, 0, 0, 1); // kept (already exists)
    const changed = st.added > 0 || st.updated > 0;
    return res(changed ? merged : cur, changed, st.added, st.updated, st.kept);
  }

  // plan(backup, getCurrent, mode) -> { items: [{key,label,value,changed,added,updated,kept}], skipped: [keys] }
  // getCurrent(key) returns the current value (server when sync is on, local when off) or undefined.
  function plan(backup, getCurrent, mode) {
    const items = [];
    const skipped = [];
    for (const key of Object.keys(backup)) {
      if (SKIP_KEYS.indexOf(key) !== -1) {
        skipped.push(key);
        continue;
      }
      const r = mergeValue(key, getCurrent(key), backup[key], mode);
      items.push(Object.assign({ key, label: labelFor(key) }, r));
    }
    return { items, skipped };
  }

  // Group plan items by label for the preview table.
  function summarize(items) {
    const by = new Map();
    for (const it of items) {
      const g = by.get(it.label) || { label: it.label, added: 0, updated: 0, kept: 0, removed: 0 };
      g.added += it.added;
      g.updated += it.updated;
      g.kept += it.kept;
      g.removed += it.removed || 0;
      by.set(it.label, g);
    }
    return Array.from(by.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  return { SKIP_KEYS, labelFor, specFor, mergeValue, plan, summarize, parseMaybe, canon };
})();

if (typeof window !== 'undefined') window.RestoreMerge = RestoreMerge;
if (typeof module !== 'undefined') module.exports = RestoreMerge;
