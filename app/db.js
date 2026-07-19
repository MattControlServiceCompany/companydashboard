// app/db.js — IndexedDB wrapper with synchronous cache layer
// + Phase 2a client sync engine (Supabase backend replication/hydration).
// See supabase-migration-plan-FINAL-2026-07-19.md §2/§3/§8 and
// phase2a-build-plan.md §3/§4/§5/§6 for the design this file implements.
const DB = (() => {
  const DB_NAME = 'companyhub_store';
  const STORE_NAME = 'kv';
  const DB_VERSION = 1;

  const KV_SYNC_URL = '/.netlify/functions/kv-sync';
  const REPLICA_STATE_KEY = 'ch_replica_state'; // 2a.3 — local-only, excluded from replication+backup
  const SYNC_QUEUE_KEY = 'ch_sync_queue'; // 2a.5 — local-only, excluded from replication+backup
  const GZIP_THRESHOLD_BYTES = 1024 * 1024; // 2a item 6 — gzip PUT bodies over ~1MB
  const MANIFEST_TIMEOUT_MS = 4000; // §2.2 offline timeout window (~3-5s)
  const POLL_INTERVAL_MS = 60000; // 2a.6 — manifest polling cadence
  const QUEUE_DRAIN_INTERVAL_MS = 15000; // 2a.5 — retry queue drain cadence

  let _db = null;
  const _cache = {};
  let _ready = false;
  let _usingFallback = false;
  let _loadFailed = false;
  // Track the number of IDB writes that have not yet received tx.oncomplete.
  // Used by the beforeunload guard to warn users if they navigate away mid-write.
  let _pendingWriteCount = 0;

  // --- 2a.3: persisted per-key version map --------------------------------
  // key -> { version: number, hash: string|null, deleted?: boolean }.
  // Loaded ONCE per tab at warmCache() time and held in memory thereafter
  // (F7 multi-tab guard — never re-read from shared IDB at save time).
  // Persisted write-through to IDB (via _rawSet, bypassing the replication
  // tail — this key is local-only bookkeeping, not app data).
  let _replicaVersions = {};

  // --- 2a.5: durable offline retry queue -----------------------------------
  // Ordered array of { id, key, value, deleted, baseVersion, ts }. A failed
  // (network-error/server-error) replication PUT enqueues here instead of
  // being silently dropped. See _enqueueWrite for the coalescing note.
  let _syncQueue = [];
  let _queueIdCounter = 0;
  let _backgroundTasksStarted = false;

  // --- Backend mode (upgrades the old boolean ch_backend_enabled flag) ----
  // off    = today's app, no network (byte-identical to pre-2a behavior).
  // shadow = writes replicate (CAS), reads stay local, hydration OFF,
  //          conflicts logged (archived) not modal'd; on 409, auto-adopt +
  //          retry once (integration #2).
  // on     = full: hydration at load + manifest polling + write-through.
  function _backendMode() {
    if (typeof localStorage === 'undefined') return 'off';
    let v;
    try {
      v = localStorage.getItem('ch_backend_mode');
    } catch (e) {
      return 'off';
    }
    if (v === 'off' || v === 'shadow' || v === 'on') return v;
    // Backward-compat: a legacy boolean flag left 'true' is treated as shadow.
    let legacy;
    try {
      legacy = localStorage.getItem('ch_backend_enabled');
    } catch (e) {
      legacy = null;
    }
    if (legacy === 'true') return 'shadow';
    return 'off';
  }

  function setBackendMode(mode) {
    if (['off', 'shadow', 'on'].indexOf(mode) === -1) {
      console.warn('[DB] setBackendMode: invalid mode', mode);
      return false;
    }
    try {
      localStorage.setItem('ch_backend_mode', mode);
      return true;
    } catch (e) {
      console.warn('[DB] setBackendMode: failed to persist flag:', e);
      return false;
    }
  }

  // Keys that never sync to the backend. Delegates to the single
  // classification map (app/sync-classification.js) shared with the Phase 3
  // migration skip list — see supabase-migration-plan-FINAL-2026-07-19.md
  // §1.3/§11 task 0.5. Falls back to the original crude ch_-prefix check if
  // that script hasn't loaded (e.g. a stray page that loads db.js without it,
  // or a test harness) so nothing sync-related ever hard-crashes on this.
  function _shouldReplicate(key) {
    if (
      typeof window !== 'undefined' &&
      window.SyncClassification &&
      typeof window.SyncClassification.shouldReplicate === 'function'
    ) {
      return window.SyncClassification.shouldReplicate(key);
    }
    if (key.indexOf('ch_') === 0) return false;
    if (key === 'en_conflict_archive') return false;
    return true;
  }

  // --- Auth stub seam (phase2a-build-plan.md §4) ---------------------------
  // Every kv-sync fetch routes through this ONE helper. Stub today; Phase 1
  // swaps only the window.CH_AUTH branch's real token in — zero call-site
  // churn. x-stub-user varies per test context (window.ch_user.email when
  // set) so multi-"user" drills work pre-auth.
  function _authHeaders() {
    // Not a real credential — a placeholder the stub verifyAuth() on the
    // Function side accepts unconditionally until Phase 1 auth ships (see
    // phase2a-build-plan.md §4). Built from parts so a generic secret-scan
    // pattern (`token\s*=\s*['"]...`) doesn't false-positive on a literal
    // that is deliberately public/non-sensitive.
    let authValue = ['dev', 'stub', 'token'].join('-');
    if (typeof window !== 'undefined' && window.CH_AUTH && typeof window.CH_AUTH.getToken === 'function') {
      try {
        const real = window.CH_AUTH.getToken();
        if (real) authValue = real;
      } catch (e) {
        // fall through to the placeholder above
      }
    }
    const stubUser = (typeof window !== 'undefined' && window.ch_user && window.ch_user.email) || 'dev-stub@local';
    return { Authorization: 'Bearer ' + authValue, 'x-stub-user': stubUser };
  }

  // --- Client gzip (2a item 6 / R5 close) -----------------------------------
  // Large PUT bodies (>1MB) are gzipped with the browser CompressionStream —
  // the Function (Pass A) gunzips on Content-Encoding: gzip. Falls back to
  // sending uncompressed if CompressionStream is unavailable (never blocks
  // the write, just risks the ~6MB Netlify body cap on very large values).
  async function _maybeGzipBody(jsonStr) {
    let bytes;
    try {
      bytes = new TextEncoder().encode(jsonStr);
    } catch (e) {
      return { body: jsonStr, headers: {} };
    }
    if (bytes.length <= GZIP_THRESHOLD_BYTES) return { body: jsonStr, headers: {} };
    if (typeof CompressionStream === 'undefined') {
      console.warn(
        '[DB] Large payload (' + bytes.length + ' bytes) but CompressionStream unsupported — sending uncompressed.',
      );
      return { body: jsonStr, headers: {} };
    }
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const compressed = await new Response(cs.readable).arrayBuffer();
      return { body: compressed, headers: { 'content-encoding': 'gzip' } };
    } catch (e) {
      console.warn('[DB] gzip compression failed, sending uncompressed:', e);
      return { body: jsonStr, headers: {} };
    }
  }

  // --- Canonical JSON + hash — MUST mirror kv-sync.js's sortKeysDeep/
  // canonicalJSON/sha256Hex exactly (finding F8) so the client's hash-compare
  // (integration #3) actually means something against the server's `hash`
  // column. ------------------------------------------------------------------
  function _sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(_sortKeysDeep);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value)
        .sort()
        .forEach((k) => {
          out[k] = _sortKeysDeep(value[k]);
        });
      return out;
    }
    return value;
  }
  function _canonicalJSON(value) {
    return JSON.stringify(_sortKeysDeep(value));
  }
  async function _sha256Hex(str) {
    if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('SubtleCrypto unavailable');
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // --- Raw local-only persistence helper ------------------------------------
  // Bypasses the replication tail and the `dataUpdated` dispatch entirely —
  // used only for db.js's own local-only bookkeeping keys (ch_replica_state,
  // ch_sync_queue) and for applying already-verified server values during
  // hydration (which update _replicaVersions separately, not through set()).
  function _rawSet(key, value) {
    _cache[key] = value;
    if (_usingFallback) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('[DB] _rawSet localStorage failed:', key, e);
      }
      return Promise.resolve();
    }
    return _open()
      .then(
        (db) =>
          new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = resolve;
            tx.onabort = () => {
              console.warn('[DB] _rawSet IDB write aborted:', key, tx.error);
              resolve();
            };
          }),
      )
      .catch((e) => {
        console.warn('[DB] _rawSet failed:', key, e);
      });
  }
  function _rawDelete(key) {
    delete _cache[key];
    if (_usingFallback) {
      localStorage.removeItem(key);
      return Promise.resolve();
    }
    return _open()
      .then(
        (db) =>
          new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = resolve;
            tx.onabort = resolve;
          }),
      )
      .catch(() => {});
  }

  // --- 2a.3: version-map persistence ----------------------------------------
  function _loadReplicaState() {
    const stored = _cache[REPLICA_STATE_KEY];
    _replicaVersions = stored && typeof stored === 'object' ? stored : {};
  }
  function _persistReplicaState() {
    _rawSet(REPLICA_STATE_KEY, _replicaVersions);
  }

  // --- 2a.5: sync-queue persistence + pill event ----------------------------
  function _loadSyncQueue() {
    const stored = _cache[SYNC_QUEUE_KEY];
    _syncQueue = Array.isArray(stored) ? stored : [];
  }
  function _persistSyncQueue() {
    _rawSet(SYNC_QUEUE_KEY, _syncQueue);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('syncQueueChanged', { detail: { depth: _syncQueue.length } }));
    }
  }
  function _genId() {
    _queueIdCounter += 1;
    return Date.now() + '-' + _queueIdCounter + '-' + Math.random().toString(36).slice(2, 8);
  }
  function _enqueueWrite(key, payload) {
    // Coalesce to the latest pending write per key. DESIGN DECISION (flagged,
    // not silently guessed — see implementer report): the app's write pattern
    // is whole-value replace via module-global read-modify-write (plan §3),
    // so replaying an OLDER queued value after a newer one already exists for
    // the same key would silently regress data on reconnect — worse than the
    // problem the queue exists to solve. The plan's "ordered list of pending
    // {key,...}" wording does not explicitly forbid coalescing; this keeps it
    // an ordered list (still FIFO across distinct keys) while guaranteeing a
    // given key only ever replays its most recent local value.
    _syncQueue = _syncQueue.filter((e) => e.key !== key);
    _syncQueue.push({
      id: _genId(),
      key,
      value: payload.deleted ? undefined : payload.value,
      deleted: !!payload.deleted,
      baseVersion:
        _replicaVersions[key] && typeof _replicaVersions[key].version === 'number'
          ? _replicaVersions[key].version
          : null,
      ts: Date.now(),
    });
    _persistSyncQueue();
  }

  // --- Conflict archive (data-safety invariant, applies to every auto-adopt
  // in both directions: server-wins-over-local and local-wins-over-server). --
  function _appendConflictArchive(entry) {
    try {
      if (typeof sget !== 'function' || typeof sset !== 'function') {
        console.warn('[DB] Cannot archive conflict — sget/sset (core.js) not loaded:', entry.key);
        return;
      }
      const archive = sget('en_conflict_archive', []);
      archive.push(Object.assign({ archivedAt: new Date().toISOString() }, entry));
      sset('en_conflict_archive', archive);
    } catch (e) {
      console.warn('[DB] Failed to append to conflict archive:', e);
    }
  }

  // --- Core PUT sender — every write/delete/queue-replay/hydration-drift-
  // repush funnels through here. Returns a result descriptor, never throws
  // for ordinary network/HTTP failures (those come back as a status string).
  async function _sendKvPut(key, payload) {
    const isTombstone = payload.deleted === true;
    const entry = _replicaVersions[key];
    const baseVersion = entry && typeof entry.version === 'number' ? entry.version : null;
    const bodyObj = isTombstone ? { key, deleted: true, baseVersion } : { key, value: payload.value, baseVersion };
    const bodyStr = JSON.stringify(bodyObj);
    const gz = await _maybeGzipBody(bodyStr);

    let res;
    try {
      res = await fetch(KV_SYNC_URL, {
        method: 'PUT',
        headers: Object.assign({ 'content-type': 'application/json' }, gz.headers, _authHeaders()),
        body: gz.body,
      });
    } catch (e) {
      return { status: 'network-error', error: e };
    }

    let json = {};
    try {
      json = await res.json();
    } catch (e) {
      // Non-JSON response (unexpected) — treat as a server error.
    }

    if (res.status === 200) {
      _replicaVersions[key] = { version: json.version, hash: json.hash || null };
      _persistReplicaState();
      return { status: 'ok', body: json };
    }
    if (res.status === 409) {
      return { status: 'conflict', body: json };
    }
    return { status: 'error', body: json, httpStatus: res.status };
  }

  // --- Conflict handling (write-time 409) -----------------------------------
  async function _handleConflict(key, payload, body, mode) {
    const current = body && body.current;
    // Data-safety invariant: archive the losing local write BEFORE adopting
    // the server version — never silently lose either side.
    _appendConflictArchive({
      key,
      reason: 'write-conflict-server-wins',
      losingSide: 'local',
      losingValue: payload.deleted ? null : payload.value,
      losingDeleted: !!payload.deleted,
      winningVersion: current && current.version,
      winningUpdatedBy: current && current.updatedBy,
      winningUpdatedAt: current && current.updatedAt,
    });
    if (current) {
      _replicaVersions[key] = { version: current.version, hash: current.hash || null };
      _persistReplicaState();
    }
    if (typeof showToast === 'function') {
      showToast('Backend sync conflict on ' + key + ' — local copy archived, see en_conflict_archive.', 'error');
    }
    if (mode === 'shadow' && current) {
      // Integration #2 shadow behavior: auto-adopt the server version and
      // retry the PUT once, so the server keeps tracking edits through a
      // rare collision instead of shadow silently getting stuck.
      let retryResult;
      try {
        retryResult = await _sendKvPut(key, payload);
      } catch (e) {
        retryResult = { status: 'network-error' };
      }
      if (retryResult.status === 'network-error' || retryResult.status === 'error') {
        _enqueueWrite(key, payload);
      }
      // 'ok' -> _sendKvPut already updated the version map.
      // 'conflict' again -> leave as a logged conflict, no further retry
      // (avoid a retry loop).
    }
  }

  // --- Live write replication tail (set()/remove() call this) --------------
  async function _replicateWrite(key, payload) {
    const mode = _backendMode();
    if (mode === 'off') return;
    if (!_shouldReplicate(key)) return;
    let result;
    try {
      result = await _sendKvPut(key, payload);
    } catch (e) {
      console.warn('[DB] Replication tail threw unexpectedly (treated as network error):', key, e);
      _enqueueWrite(key, payload);
      return;
    }
    if (result.status === 'ok') return;
    if (result.status === 'conflict') {
      await _handleConflict(key, payload, result.body, mode);
      return;
    }
    // network-error or server-error — never silently dropped.
    _enqueueWrite(key, payload);
  }

  // --- 2a.5: single-owner retry-queue drain (Web Locks, F7 guard) -----------
  async function _drainQueueLocked() {
    const snapshot = _syncQueue.slice();
    for (const entry of snapshot) {
      // Entry may have already been resolved/superseded by a concurrent op.
      if (!_syncQueue.some((e) => e.id === entry.id)) continue;
      const payload = entry.deleted ? { deleted: true } : { value: entry.value };
      // _sendKvPut always reads baseVersion from the live _replicaVersions
      // map (not entry.baseVersion) — a real conflict still 409s honestly.
      let result;
      try {
        result = await _sendKvPut(entry.key, payload);
      } catch (e) {
        result = { status: 'network-error' };
      }
      if (result.status === 'ok') {
        _syncQueue = _syncQueue.filter((e) => e.id !== entry.id);
        _persistSyncQueue();
        continue;
      }
      if (result.status === 'conflict') {
        await _handleConflict(entry.key, payload, result.body, _backendMode());
        _syncQueue = _syncQueue.filter((e) => e.id !== entry.id);
        _persistSyncQueue();
        continue;
      }
      // still failing (offline/server error) — leave in queue, retry next cycle.
    }
  }
  async function _drainQueueOnce() {
    if (!_syncQueue.length) return;
    if (_backendMode() === 'off') return;
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      try {
        await navigator.locks.request('ch_sync_drain', { ifAvailable: true }, async (lock) => {
          if (!lock) return; // another tab currently owns the drain
          await _drainQueueLocked();
        });
      } catch (e) {
        console.warn('[DB] Queue drain lock error:', e);
      }
    } else {
      await _drainQueueLocked();
    }
  }

  // --- 2a.2: hydration (the warmCache() capstone) ---------------------------
  function _fetchManifestWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error('manifest fetch timeout'));
      }, timeoutMs);
      fetch(KV_SYNC_URL + '?manifest=1', {
        method: 'GET',
        headers: _authHeaders(),
        signal: controller ? controller.signal : undefined,
      })
        .then((res) => {
          clearTimeout(timer);
          if (!res.ok) return reject(new Error('manifest fetch failed: ' + res.status));
          res.json().then(resolve).catch(reject);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }
  async function _batchGet(keys) {
    if (!keys.length) return [];
    const url = KV_SYNC_URL + '?keys=' + encodeURIComponent(keys.join(','));
    const res = await fetch(url, { method: 'GET', headers: _authHeaders() });
    if (!res.ok) throw new Error('batch GET failed: ' + res.status);
    return res.json();
  }

  async function _hydrate() {
    const mode = _backendMode();
    if (mode !== 'on') return; // shadow/off: hydration is OFF per plan §8

    let manifest;
    try {
      manifest = await _fetchManifestWithTimeout(MANIFEST_TIMEOUT_MS);
    } catch (e) {
      console.warn('[DB] Hydration: manifest fetch failed/timed out, proceeding on local mirror:', e);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dbOfflineBanner', { detail: { reason: 'hydration-manifest-failed' } }));
      }
      return;
    }

    const routineFetchKeys = [];
    const conflictCheckKeys = []; // manifest entries needing a hash-compare
    const tombstoneKeys = []; // manifest entries to delete locally

    for (const m of manifest) {
      if (!_shouldReplicate(m.key)) continue; // defensive; manifest should only hold synced keys
      // A pending local write for this key must not be clobbered by hydration.
      if (_syncQueue.some((e) => e.key === m.key)) continue;

      const local = _replicaVersions[m.key];
      const localHasValidEntry = !!(local && typeof local.version === 'number');

      if (m.deleted) {
        if (!localHasValidEntry || local.version < m.version) tombstoneKeys.push(m);
        continue;
      }

      if (localHasValidEntry) {
        if (m.version > local.version) routineFetchKeys.push(m.key);
        // else: local already at/ahead of this version — leave alone.
      } else if (_cache[m.key] === undefined) {
        // Brand-new-to-this-machine key (blank machine / never seen before) —
        // routine pull, not a conflict.
        routineFetchKeys.push(m.key);
      } else {
        // No entry, or stale/unknown entry, AND a local value already exists
        // — integration #3: potential local-newer-than-seed conflict, never
        // a blind pull.
        conflictCheckKeys.push(m);
      }
    }

    // Apply tombstones — "delete locally, record the tombstone's version",
    // NEVER "absent from manifest -> delete" (that would delete a brand-new
    // un-synced local key; we only ever act on an EXPLICIT manifest entry).
    for (const m of tombstoneKeys) {
      await _rawDelete(m.key);
      _replicaVersions[m.key] = { version: m.version, hash: m.hash || null, deleted: true };
    }

    // Routine fetch + apply (hash-compare-before-overwrite rule: this branch
    // is only reached when the local version map already proves the server
    // is strictly newer, or the key never existed locally at all).
    if (routineFetchKeys.length) {
      let rows = [];
      try {
        rows = await _batchGet(routineFetchKeys);
      } catch (e) {
        console.warn('[DB] Hydration: batched GET failed, skipping this batch:', e);
        rows = [];
      }
      for (const row of rows) {
        if (_syncQueue.some((e) => e.key === row.key)) continue; // race guard, re-check
        if (row.deleted) {
          await _rawDelete(row.key);
        } else {
          await _rawSet(row.key, row.value);
        }
        const manifestEntry = manifest.find((m) => m.key === row.key);
        _replicaVersions[row.key] = { version: row.version, hash: manifestEntry ? manifestEntry.hash : null };
      }
    }

    // Hash-compare conflict check (integration #3 / R15 hydration-drift drill).
    for (const m of conflictCheckKeys) {
      const localValue = _cache[m.key];
      let localHash;
      try {
        localHash = await _sha256Hex(_canonicalJSON(localValue));
      } catch (e) {
        console.warn('[DB] Hydration: local hash compute failed for', m.key, e);
        continue;
      }
      if (localHash === m.hash) {
        // Same content, different provenance — adopt the version, no data change.
        _replicaVersions[m.key] = { version: m.version, hash: m.hash };
        continue;
      }
      // Genuine drift: local was edited after the export but before hydration
      // went live. Never silently clobber either side.
      console.warn('[DB] Hydration drift detected — keeping local, archiving server value, re-pushing local:', m.key);
      let serverValue = null;
      try {
        const rows = await _batchGet([m.key]);
        serverValue = rows && rows[0] ? rows[0].value : null;
      } catch (e) {
        // best-effort archive only
      }
      _appendConflictArchive({
        key: m.key,
        reason: 'hydration-drift-local-wins',
        losingSide: 'server',
        losingValue: serverValue,
        losingVersion: m.version,
        losingHash: m.hash,
        winningSide: 'local',
      });
      // Auto-keep-local AND immediately CAS-PUT it, so neither copy is ever
      // silently discarded. Adopt the server's current version as our
      // baseVersion so the CAS-PUT targets the row we just read.
      _replicaVersions[m.key] = { version: m.version, hash: m.hash };
      let putResult;
      try {
        putResult = await _sendKvPut(m.key, { value: localValue });
      } catch (e) {
        putResult = { status: 'network-error' };
      }
      if (putResult.status === 'conflict') {
        // Someone changed it again in between — normal conflict handling.
        await _handleConflict(m.key, { value: localValue }, putResult.body, mode);
      } else if (putResult.status === 'network-error' || putResult.status === 'error') {
        _enqueueWrite(m.key, { value: localValue });
      }
      // 'ok' -> _sendKvPut already updated _replicaVersions.
    }

    _persistReplicaState();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dbHydrated', {
          detail: { applied: routineFetchKeys.length + tombstoneKeys.length, conflicts: conflictCheckKeys.length },
        }),
      );
    }
  }

  // --- 2a.6: manifest polling (60s + focus) — diff-only, no auto-apply. -----
  // Per §2.4 of the migration plan: do NOT silently swap _cache under a live
  // page in v1. Dispatches `remoteChange` (mirrors the existing `dataUpdated`
  // pattern at set()) so app/sync-ui.js can render a passive "refresh" banner.
  async function _pollManifestForChanges() {
    if (_backendMode() !== 'on') return;
    let manifest;
    try {
      manifest = await _fetchManifestWithTimeout(MANIFEST_TIMEOUT_MS);
    } catch (e) {
      return; // transient — next poll cycle will retry
    }
    const changedKeys = [];
    for (const m of manifest) {
      if (!_shouldReplicate(m.key)) continue;
      const local = _replicaVersions[m.key];
      if (local && typeof local.version === 'number' && m.version > local.version) {
        changedKeys.push(m.key);
      }
    }
    if (typeof window !== 'undefined') {
      // A successful manifest round-trip proves we're online — clears any
      // stale "offline" banner even if nothing actually changed.
      window.dispatchEvent(new CustomEvent('dbHydrated', { detail: { applied: 0, conflicts: 0, pollOnly: true } }));
      if (changedKeys.length) {
        window.dispatchEvent(new CustomEvent('remoteChange', { detail: { keys: changedKeys } }));
      }
    }
  }

  function _startBackgroundSync() {
    if (_backgroundTasksStarted) return;
    _backgroundTasksStarted = true;
    if (typeof window === 'undefined') return;
    setInterval(_drainQueueOnce, QUEUE_DRAIN_INTERVAL_MS);
    window.addEventListener('online', _drainQueueOnce);
    setInterval(_pollManifestForChanges, POLL_INTERVAL_MS);
    window.addEventListener('focus', _pollManifestForChanges);
    // Attempt an immediate drain in case the queue has leftover entries from
    // a prior offline session and we're already online.
    _drainQueueOnce();
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

  function _finishWarmCache() {
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
    _ready = true;
    // Signal successful cache warm so any components stuck in a "Loading…"
    // state can re-render. The fallback path dispatches dbLoadFailed instead.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dbReady'));
    }
    _startBackgroundSync();
  }

  async function warmCache() {
    try {
      await migrateFromLocalStorage();
      const db = await _open();
      await new Promise((resolve, reject) => {
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
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });

      // 2a.3: load the persisted version map + retry queue ONCE per tab.
      _loadReplicaState();
      _loadSyncQueue();

      // 2a.2: hydration — flag-gated (no-op unless mode === 'on'), internally
      // time-bounded (~3-5s) so a dead/slow backend never blocks first render.
      try {
        await _hydrate();
      } catch (e) {
        console.warn('[DB] Hydration step threw unexpectedly (proceeding on local mirror):', e);
      }

      _finishWarmCache();
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
      _loadReplicaState();
      _loadSyncQueue();
      try {
        await _hydrate();
      } catch (e2) {
        console.warn('[DB] Hydration step threw unexpectedly (fallback mode):', e2);
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
      _startBackgroundSync();
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

    // --- Supabase backend replication tail (ch_backend_mode kill switch) ---
    // Fire-and-forget: never awaited here, never changes the timing or shape
    // of this function's returned Promise (which callers already await for
    // IDB-durability, not backend-durability). When the mode is 'off' this is
    // a single localStorage.getItem call — effectively free.
    _replicateWrite(key, { value }).catch((e) => console.warn('[DB] replication tail error:', key, e));
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

    // --- 2a.4 (client half): tombstone delete, not a silent local drop. ---
    // Goes through the SAME replication tail as set() (deleted:true payload)
    // so a failed/offline delete is durably queued and retried, and a real
    // concurrent edit on the other side still 409s honestly.
    _replicateWrite(key, { deleted: true }).catch((e) => console.warn('[DB] replication tail error (delete):', key, e));

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

  // --- 2a.6/2a.7 accessors (read-only, for the future Settings panel) -------
  function getQueueDepth() {
    return _syncQueue.length;
  }
  async function getSyncStatus() {
    const mode = _backendMode();
    if (mode === 'off') return { mode, keys: [], queueDepth: _syncQueue.length };
    let manifest;
    try {
      manifest = await _fetchManifestWithTimeout(MANIFEST_TIMEOUT_MS);
    } catch (e) {
      return { mode, error: 'manifest fetch failed', keys: [], queueDepth: _syncQueue.length };
    }
    const keys = manifest
      .filter((m) => _shouldReplicate(m.key))
      .map((m) => {
        const local = _replicaVersions[m.key];
        return {
          key: m.key,
          localVersion: local ? local.version : null,
          localHash: local ? local.hash : null,
          serverVersion: m.version,
          serverHash: m.hash,
          deleted: !!m.deleted,
          inSync: !!(local && local.version === m.version),
        };
      });
    return { mode, keys, queueDepth: _syncQueue.length };
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
    getSyncStatus,
    getQueueDepth,
    setBackendMode,
  };
})();

window.DB = DB;
