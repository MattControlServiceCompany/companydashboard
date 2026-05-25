// app/db.js — IndexedDB wrapper with synchronous cache layer
const DB = (() => {
  const DB_NAME = 'companyhub_store';
  const STORE_NAME = 'kv';
  const DB_VERSION = 1;

  let _db = null;
  const _cache = {};
  let _ready = false;
  let _usingFallback = false;

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

    console.log('[DB] Migration complete: localStorage → IndexedDB (' + localStorage.length + ' keys)');
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
    _cache[key] = value;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key } }));
    }
    if (_usingFallback) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('[DB] localStorage write failed:', key, e);
      }
      return;
    }
    _open()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
      })
      .catch((e) => console.warn('[DB] Write failed:', key, e));
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

  return { warmCache, get, set, remove, clear, getAllKeys, getAll, isReady, isFallback };
})();

window.DB = DB;
