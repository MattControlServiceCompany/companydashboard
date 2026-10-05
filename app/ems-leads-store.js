// app/ems-leads-store.js - the ONE persistence layer for the EMS Leads tab
// (energy-department.html) and the standalone ems-leads.html page.
//
// Every read and write goes through the db.js sync layer (DB.get / DB.set).
// The keys are classified 'synced' in app/sync-classification.js, so db.js
// replicates them to the shared backend. There is no raw localStorage path.
//
// migrateRawStorage() runs once per page load, after DB is ready. Old builds
// wrote these three keys straight to localStorage. This moves any such value
// into the sync layer and removes the raw copy. A lead is never dropped: when
// the sync layer already holds a different value, the newer one is kept and the
// other one is written to the conflict archive (en_conflict_archive, the same
// list db.js uses; shown in the Sync status panel).
//
// Concurrent edits: the leads list is ONE shared record (ems_leads_v1). db.js
// writes it with a version check. If two users save from the same base version,
// the second save gets a 409 and db.js shows its conflict modal. The losing
// version is archived first, so nothing is lost silently. db.js has no
// per-record merge entry (UNION_KEY_CONFIG) for ems_leads_v1 yet, so the modal
// has no "Keep both" button for two added leads. See the report for the one
// db.js entry that would add it.

const EmsLeadsStore = (() => {
  const KEYS = { leads: 'ems_leads_v1', fields: 'ems_field_defs', types: 'ems_client_types' };
  const ARCHIVE_KEY = 'en_conflict_archive';

  function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  }
  function same(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
      return false;
    }
  }
  // Newest edit time in a leads array (ms), or NaN when no lead has a date.
  function newestStamp(v) {
    if (!Array.isArray(v)) return NaN;
    let best = NaN;
    v.forEach((l) => {
      const t = Date.parse((l && (l.updatedAt || l.createdAt)) || '');
      if (!isNaN(t) && (isNaN(best) || t > best)) best = t;
    });
    return best;
  }

  function create(db, ls) {
    function loadLeads() {
      const v = db.get(KEYS.leads, []);
      return Array.isArray(v) ? clone(v) : [];
    }
    function saveLeads(leads) {
      return db.set(KEYS.leads, clone(leads));
    }
    function loadFieldDefs() {
      const v = db.get(KEYS.fields, null);
      return v && typeof v === 'object' ? clone(v) : {};
    }
    function saveFieldDefs(defs) {
      return db.set(KEYS.fields, clone(defs));
    }
    function loadClientTypes() {
      const v = db.get(KEYS.types, null);
      return Array.isArray(v) && v.length ? clone(v) : null;
    }
    function saveClientTypes(types) {
      return db.set(KEYS.types, clone(types));
    }

    function archive(key, losingSide, losingValue, reason) {
      const list = db.get(ARCHIVE_KEY, []);
      const next = (Array.isArray(list) ? list : []).concat([
        { archivedAt: new Date().toISOString(), key, reason, losingSide, losingValue: clone(losingValue) },
      ]);
      return db.set(ARCHIVE_KEY, next);
    }

    // Returns { [key]: 'none' | 'moved' | 'identical' | 'kept-raw' | 'kept-sync' | 'unreadable' }.
    async function migrateRawStorage() {
      const out = {};
      // IndexedDB unavailable: db.js stores everything in localStorage under the
      // same key. That copy IS the store. Do not touch it.
      if (db.isFallback && db.isFallback()) return out;
      for (const key of Object.values(KEYS)) {
        let rawText = null;
        try {
          rawText = ls.getItem(key);
        } catch (e) {
          rawText = null;
        }
        if (rawText === null) {
          out[key] = 'none';
          continue;
        }
        let raw;
        try {
          raw = JSON.parse(rawText);
        } catch (e) {
          out[key] = 'unreadable'; // leave the raw text in place; never delete what we cannot read
          continue;
        }
        const have = db.get(key, null);
        if (have === null) {
          await db.set(key, raw);
          out[key] = 'moved';
        } else if (same(have, raw)) {
          out[key] = 'identical';
        } else {
          // Newer wins. Only the leads carry dates. For the other two keys the
          // raw copy is the one the old code kept up to date, so raw wins.
          const tRaw = newestStamp(raw);
          const tSync = newestStamp(have);
          const syncNewer = key === KEYS.leads && !isNaN(tRaw) && !isNaN(tSync) && tSync > tRaw;
          if (syncNewer) {
            await archive(key, 'raw-localstorage', raw, 'raw-localstorage-migration');
            out[key] = 'kept-sync';
          } else {
            await archive(key, 'sync-layer', have, 'raw-localstorage-migration');
            await db.set(key, raw);
            out[key] = 'kept-raw';
          }
        }
        // Remove the raw copy only after the sync-layer write has committed.
        ls.removeItem(key);
      }
      return out;
    }

    return {
      KEYS,
      loadLeads,
      saveLeads,
      loadFieldDefs,
      saveFieldDefs,
      loadClientTypes,
      saveClientTypes,
      migrateRawStorage,
    };
  }

  return { KEYS, create };
})();

if (typeof window !== 'undefined') window.EmsLeadsStore = EmsLeadsStore;
if (typeof module !== 'undefined' && module.exports) module.exports = EmsLeadsStore;
