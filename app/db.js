// app/db.js — IndexedDB wrapper with synchronous cache layer
const DB = (() => {
  const DB_NAME = 'companyhub_store';
  const STORE_NAME = 'kv';
  const DB_VERSION = 1;

  let _db = null;
  const _cache = {};
  let _ready = false;
  let _usingFallback = false;
  // Track the number of IDB writes that have not yet received tx.oncomplete.
  // Used by the beforeunload guard to warn users if they navigate away mid-write.
  let _pendingWriteCount = 0;

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
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[DB] IndexedDB unavailable, falling back to localStorage:', e);
      _usingFallback = true;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        try {
          _cache[k] = JSON.parse(localStorage.getItem(k));
        } catch {
          _cache[k] = localStorage.getItem(k);
        }
      }
      _ready = true;
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
  function hasPendingWrites() {
    return _pendingWriteCount > 0;
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

  return { warmCache, get, set, remove, clear, getAllKeys, getAll, isReady, isFallback, hasPendingWrites };
})();

window.DB = DB;
