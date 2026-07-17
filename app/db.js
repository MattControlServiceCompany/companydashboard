// app/db.js — IndexedDB wrapper with synchronous cache layer
const DB = (() => {
  const DB_NAME = 'companyhub_store';
  const STORE_NAME = 'kv';
  const DB_VERSION = 1;

  let _db = null;
  const _cache = {};
  let _ready = false;
  let _usingFallback = false;
  let _loadFailed = false;
  // Track the number of IDB writes that have not yet received tx.oncomplete.
  // Used by the beforeunload guard to warn users if they navigate away mid-write.
  let _pendingWriteCount = 0;

  // Per-key last-known server version, for the replication tail below.
  // null/undefined = "never successfully PUT this key" -> treated as a
  // believed-new insert on the next attempt.
  const _replicaVersions = {};

  // Keys that never sync to the backend in this slice: UI-preference keys
  // (ch_*) that are deliberately local-only (see lsPreserveKeys in
  // warmCache above), and the conflict archive itself (a local safety net,
  // not something that needs its own server copy in this minimal slice).
  function _shouldReplicate(key) {
    if (key.indexOf('ch_') === 0) return false;
    if (key === 'en_conflict_archive') return false;
    return true;
  }

  function _replicateToBackend(key, value) {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('ch_backend_enabled') !== 'true') return;
    if (!_shouldReplicate(key)) return;

    const baseVersion = _replicaVersions[key] !== undefined ? _replicaVersions[key] : null;
    const updatedBy = (window.ch_user && window.ch_user.email) || 'unknown';

    fetch('/.netlify/functions/kv-sync', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value, baseVersion, updatedBy }),
    })
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200) {
          _replicaVersions[key] = body.version;
          return;
        }
        if (status === 409) {
          // Minimal slice: archive the losing local write, notify, and move
          // on. Does NOT block editing and does NOT auto-merge. The full
          // blocking conflict modal (backend-migration-plan-2026-07-16.md
          // §2b) — "Load theirs / Keep mine / Review side-by-side" — is
          // explicitly a follow-up, not built here.
          const archive = sget('en_conflict_archive', []);
          archive.push({
            key,
            attemptedValue: value,
            attemptedAt: new Date().toISOString(),
            serverVersion: body.current && body.current.version,
            serverUpdatedBy: body.current && body.current.updatedBy,
            serverUpdatedAt: body.current && body.current.updatedAt,
          });
          sset('en_conflict_archive', archive);
          // Advance local version tracking to the server's so the NEXT save
          // attempt has a correct baseVersion instead of 409ing forever —
          // this is the last-write-wins-on-retry gap named in the scope
          // note above; acceptable only because the blocking modal that
          // would prevent it is explicitly out of scope for this slice.
          if (body.current) _replicaVersions[key] = body.current.version;
          if (typeof showToast === 'function') {
            showToast('Backend sync conflict on ' + key + ' — local copy archived, see en_conflict_archive.', 'error');
          }
        }
      })
      .catch((e) => {
        // Backend unreachable (e.g. office firewall, throwaway site down,
        // flag on but no Function deployed) — this must NEVER break the
        // local save. Silent-ish by design; a console.warn is enough.
        console.warn('[DB] Backend replication failed (local save unaffected):', key, e);
      });
  }

  function _open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = (e) => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function migrateFromLocalStorage() {
    if (localStorage.length === 0) return;
    const db = await _open();
    const migrated = await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('ch_idb_migrated');
      req.onsuccess = () => resolve(req.result === true);
      req.onerror = () => resolve(false);
    });

    if (migrated) return;

    const projData = localStorage.getItem('en_projects');
    if (!projData) return;

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      try {
        const raw = localStorage.getItem(k);
        try {
          store.put(JSON.parse(raw), k);
        } catch {
          store.put(raw, k);
        }
      } catch (e) {
        console.warn('[DB] Migration: failed to copy key', k, e);
      }
    }

    store.put(true, 'ch_idb_migrated');

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const migratedKeyCount = localStorage.length;
    // Keys that must stay in localStorage for synchronous reads before IndexedDB warms up.
    // These are read by the pre-paint script and init() before DB.warmCache() resolves.
    // Keep in sync with the lsOnlyKeys list in app/site-functions.js.
    var lsPreserveKeys = [
      'ch_activeView',
      'ch_settings',
      'ch_theme',
      'ch_sidebar_collapsed',
      'ch_seen_version',
      'ch_user',
      'ch_projTabOrder',
      'ch_sidebarOrder',
      'ch_dismissed_tips',
      'ch_qs_seen',
      'ch_toast_duration',
      'ch_last_seen_version',
      'ch_notifs',
    ];
    var preserved = {};
    lsPreserveKeys.forEach(function (k) {
      var v = localStorage.getItem(k);
      if (v !== null) preserved[k] = v;
    });
    // Migration confirmed complete — clear localStorage to prevent double-read on future loads
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k) localStorage.removeItem(k);
    }
    // Restore keys that must remain in localStorage for synchronous access
    Object.keys(preserved).forEach(function (k) {
      localStorage.setItem(k, preserved[k]);
    });

    console.log(
      '[DB] Migration complete: localStorage → IndexedDB (' + migratedKeyCount + ' keys), localStorage cleared',
    );
  }

  async function warmCache() {
    try {
      await migrateFromLocalStorage();
      const db = await _open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        const kreq = store.getAllKeys();
        let values, keys;
        req.onsuccess = () => {
          values = req.result;
        };
        kreq.onsuccess = () => {
          keys = kreq.result;
        };
        tx.oncomplete = () => {
          if (keys && values) {
            keys.forEach((k, i) => {
              _cache[k] = values[i];
            });
          }
          _ready = true;
          // Hotfix: restore lsPreserveKeys that the IDB migration may have wiped.
          // Runs on every page load (not guarded by migration flag) but is cheap —
          // just a few localStorage.getItem checks against the already-warm cache.
          var _lsRepairKeys = [
            'ch_activeView',
            'ch_settings',
            'ch_theme',
            'ch_sidebar_collapsed',
            'ch_seen_version',
            'ch_user',
            'ch_projTabOrder',
            'ch_sidebarOrder',
            'ch_dismissed_tips',
            'ch_qs_seen',
            'ch_toast_duration',
            'ch_last_seen_version',
            'ch_notifs',
          ];
          _lsRepairKeys.forEach(function (k) {
            if (localStorage.getItem(k) === null) {
              var val = _cache[k];
              if (val !== undefined && val !== null) {
                try {
                  localStorage.setItem(k, typeof val === 'string' ? val : JSON.stringify(val));
                } catch (e) {
                  console.warn('[DB] Repair: failed to restore', k, 'to localStorage:', e);
                }
              }
            }
          });
          // Signal successful cache warm so any components stuck in a "Loading…"
          // state can re-render. The fallback path dispatches dbLoadFailed instead.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('dbReady'));
          }
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[DB] IndexedDB unavailable, falling back to localStorage:', e);
      _usingFallback = true;
      _loadFailed = true;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        try {
          _cache[k] = JSON.parse(localStorage.getItem(k));
        } catch {
          _cache[k] = localStorage.getItem(k);
        }
      }
      _ready = true;
      // Surface a VISIBLE warning — silent fallback looks identical to "no data" to the user.
      // Defer by one tick so showToast is defined (all scripts have loaded) before we call it.
      if (typeof window !== 'undefined') {
        window._dbLoadFailed = true;
        setTimeout(function () {
          if (typeof showToast === 'function') {
            showToast("Couldn't load saved data from storage — try refreshing. Your data is not lost.", 'error', 8000);
          }
          // Notify any listeners (e.g. equipment-matrix) that the load failed
          window.dispatchEvent(new CustomEvent('dbLoadFailed'));
        }, 0);
      }
    }
  }

  function get(key, fallback) {
    const v = _cache[key];
    if (v === undefined || v === null) return fallback !== undefined ? fallback : null;
    return v;
  }

  function set(key, value) {
    // Update in-memory cache immediately so the UI stays responsive.
    _cache[key] = value;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key } }));
    }

    // --- Supabase backend replication tail (ch_backend_enabled kill switch) ---
    // Fire-and-forget: never awaited here, never changes the timing or shape
    // of this function's returned Promise (which callers already await for
    // IDB-durability, not backend-durability). When the flag is off this is
    // a single localStorage.getItem call — effectively free.
    _replicateToBackend(key, value);
    // --- end replication tail ---

    if (_usingFallback) {
      return new Promise((resolve, reject) => {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          resolve();
        } catch (e) {
          console.warn('[DB] localStorage write failed:', key, e);
          reject(e);
        }
      });
    }
    // Return a Promise that resolves only on tx.oncomplete — the real IDB commit.
    // Callers that care about durability (e.g. bulk import) can await this.
    _pendingWriteCount++;
    let _txCreated = false;
    return _open()
      .then((db) => {
        _txCreated = true;
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = () => {
            _pendingWriteCount--;
            resolve();
          };
          // tx.onerror is intentionally omitted. Per the IndexedDB spec, an
          // unhandled request error causes the transaction to abort, so
          // tx.onabort always fires for every failure mode (request error,
          // I/O error, QuotaExceededError, explicit abort). Keeping both
          // handlers would decrement _pendingWriteCount TWICE on request
          // errors, driving the counter negative and silently disabling the
          // beforeunload guard for the rest of the session.
          tx.onabort = () => {
            _pendingWriteCount--;
            const err = tx.error;
            console.warn('[DB] Write failed — transaction aborted:', key, err);
            if (typeof showToast === 'function') {
              showToast('Save failed — data may not persist after reload', 'error');
            }
            reject(err || new Error('IDB transaction aborted'));
          };
        });
      })
      .catch((e) => {
        // If _open() itself failed (before tx was created), decrement now.
        // If tx was created, its oncomplete/onerror/onabort already decremented.
        if (!_txCreated) _pendingWriteCount--;
        console.warn('[DB] Write failed:', key, e);
        throw e;
      });
  }

  function remove(key) {
    delete _cache[key];
    if (_usingFallback) {
      localStorage.removeItem(key);
      return;
    }
    _open()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
      })
      .catch(() => {});
  }

  async function clear() {
    Object.keys(_cache).forEach((k) => delete _cache[k]);
    if (_usingFallback) {
      localStorage.clear();
      return;
    }
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  function getAllKeys() {
    return Object.keys(_cache);
  }
  function getAll() {
    return { ..._cache };
  }
  function isReady() {
    return _ready;
  }
  function isFallback() {
    return _usingFallback;
  }
  function isLoadFailed() {
    return _loadFailed;
  }
  function hasPendingWrites() {
    return _pendingWriteCount > 0;
  }
  function resetPendingWrites() {
    _pendingWriteCount = 0;
  }

  // Safety net: if the user navigates away while an IDB write is still in-flight,
  // show a browser confirmation dialog. Modern browsers may ignore returnValue for
  // navigation but it still fires and gives the IDB engine a chance to flush.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (e) => {
      if (_pendingWriteCount > 0) {
        e.preventDefault();
        // Chrome requires returnValue to be set to trigger the dialog.
        e.returnValue = 'Data is still being saved. Leaving now may lose your import. Are you sure?';
      }
    });
  }

  return {
    warmCache,
    get,
    set,
    remove,
    clear,
    getAllKeys,
    getAll,
    isReady,
    isFallback,
    isLoadFailed,
    hasPendingWrites,
    resetPendingWrites,
  };
})();

window.DB = DB;
