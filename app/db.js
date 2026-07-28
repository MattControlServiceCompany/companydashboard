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

  // --- Per-user-settings-sync hardening (2026-07-26) — Finding 1 -----------
  // (adversarial review 2026-07-25/26). These keys are deliberately kept OUT
  // of DB.set()/_wireKey (see migrateFromLocalStorage()/_finishWarmCache()
  // below) — some are read synchronously pre-paint, before IndexedDB is even
  // open (ch_theme — index.html/service-department.html/energy-department.html's
  // inline pre-paint <script>), and app/report-engine.js has its own raw
  // read/write sites for ch_notifs (out of scope for this branch — the
  // report-engine.js/pricing-estimator.js files are off-limits here). Because
  // none of them ever round-trip through DB.set(), _wireKey() never
  // namespaces them and the ordinary per-user _cache/_replicaVersions sweep
  // in _clearPerUserLocalState() never touched them before this fix — so on
  // a shared browser they silently carried one signed-in user's values over
  // to the next. This is the single source of truth for that key list — it
  // previously existed as two independently-hand-maintained inline arrays
  // (lsPreserveKeys in migrateFromLocalStorage(), _lsRepairKeys in
  // _finishWarmCache()) that had drifted into exact duplicates of each
  // other; both now reference this constant instead.
  const RAW_PER_USER_LOCAL_KEYS = [
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
  // ch_user is INTENTIONALLY EXCLUDED from the clear-on-identity-switch sweep
  // in _clearPerUserLocalState() below, even though it is read/written raw
  // like the rest of RAW_PER_USER_LOCAL_KEYS. It is the app's own "who is
  // signed in right now" marker (index.html/service-department.html
  // saveSession()/loadSession()), always freshly overwritten by the sign-in
  // flow itself BEFORE any of this identity-change detection runs (a real
  // login sets it synchronously at the moment of sign-in, well before the
  // next chAuthStateChanged event or warmCache() cycle observes the switch)
  // — and the existing signOut()'s clearSession() already removes it on an
  // explicit sign-out. Force-deleting it here would instead risk logging the
  // CURRENT (correct) user out on their very next refresh, which is strictly
  // worse than the risk it would guard against: ch_user has zero effect on
  // which backend row a write lands in (that is controlled entirely by
  // CH_AUTH.getUserId()/the Entra oid — see app/ch-auth.js — not by this
  // app-level display-name/session marker).
  const RAW_PER_USER_CH_USER_KEY = 'ch_user';

  // Dynamic-suffix "per-user" families ALSO written via raw localStorage only
  // (site-functions.js setTableZoom(), ~line 7279-7291), never DB.set() —
  // the same Finding-1 gap as RAW_PER_USER_LOCAL_KEYS above, just keyed by a
  // fixed prefix plus a variable project/meter id suffix instead of one fixed
  // name, so they need a localStorage scan rather than a direct key lookup.
  const RAW_PER_USER_ZOOM_PREFIXES = ['en_bills_zoom_', 'en_sv_matrix_zoom_'];
  const RAW_PER_USER_ZOOM_EXACT = ['en_perf_zoom'];
  function _isRawZoomKey(key) {
    if (RAW_PER_USER_ZOOM_EXACT.indexOf(key) !== -1) return true;
    return RAW_PER_USER_ZOOM_PREFIXES.some((p) => key.indexOf(p) === 0);
  }

  // Local-only bookkeeping (write-through via _rawSet, same pattern as
  // ch_replica_state/ch_sync_queue — MUST be excluded from PER_USER
  // classification, see app/sync-classification.js
  // PER_USER_CH_ENGINE_EXCLUSIONS). Records which signed-in identity's
  // per-user local state is currently reflected in this browser's durable
  // IDB store, so a HARD REFRESH after an identity switch can be detected
  // too (Finding 2) — _handleAuthIdentityChange alone only catches a LIVE
  // sign-out/sign-in inside the same tab session (Matt always hard-refreshes,
  // per feedback_user_always_hard_refreshes.md).
  const LOCAL_IDENTITY_KEY = 'ch_local_identity';

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

  // --- Per-user-settings-sync (2026-07-20) — client-side key-prefixing -----
  // A "per-user" key (app/sync-classification.js classifyKey() === 'per-user')
  // replicates like any synced key, but the key SENT TO/READ FROM the backend
  // is namespaced `${userId}::${localKey}` so two users editing the same
  // browser (or the same account on two machines) never clobber each other's
  // UI prefs. The LOCAL _cache/_replicaVersions always stay keyed by the
  // plain `localKey` — every other reader in the app (sset/sget, DB.get) is
  // completely unaware this exists. Same window.SyncClassification-missing
  // fallback pattern as _shouldReplicate above: never treat a key as
  // per-user if the classification lib didn't load (safe default = old
  // synced/local-only behavior only).
  function _isPerUserKey(key) {
    if (
      typeof window !== 'undefined' &&
      window.SyncClassification &&
      typeof window.SyncClassification.isPerUser === 'function'
    ) {
      return window.SyncClassification.isPerUser(key);
    }
    return false;
  }
  function _myUserId() {
    if (typeof window !== 'undefined' && window.CH_AUTH && typeof window.CH_AUTH.getUserId === 'function') {
      try {
        return window.CH_AUTH.getUserId();
      } catch (e) {
        return null;
      }
    }
    return null;
  }
  // Tracks the identity as of the last processed chAuthStateChanged event (or
  // module-load time, since app/ch-auth.js loads before app/db.js on every
  // page — see the script-tag order in index/energy-department/service-
  // department/ems-leads.html). The listener below (_handleAuthIdentityChange)
  // only acts when this actually differs from the current _myUserId(), so a
  // same-user silent-token-refresh success/failure (which also fires
  // chAuthStateChanged) never triggers a needless clear.
  let _lastKnownUserId = _myUserId();
  // Resolves a LOCAL key to the key actually sent to/read from the backend.
  // Returns the key unchanged for non-per-user keys. For a per-user key,
  // returns `${userId}::${key}` when someone is signed in, or `null` when
  // nobody is signed in — callers MUST treat `null` as "cannot sync this key
  // right now" (behave local-only), and must NEVER fall back to sending the
  // bare unprefixed key (that would leak/merge this pref across every user).
  function _wireKey(key) {
    if (!_isPerUserKey(key)) return key;
    const uid = _myUserId();
    if (!uid) return null;
    return uid + '::' + key;
  }
  // Splits a manifest/wire key of the form `${uid}::${localKey}` back apart.
  // Returns null if the key contains no '::' (not a per-user wire key).
  function _splitWireKey(wireKey) {
    const idx = typeof wireKey === 'string' ? wireKey.indexOf('::') : -1;
    if (idx === -1) return null;
    const uid = wireKey.slice(0, idx);
    const localKey = wireKey.slice(idx + 2);
    if (!uid || !localKey) return null;
    return { uid, localKey };
  }
  // The SINGLE gate every manifest-walking loop (_hydrate/_pollManifestForChanges/
  // getSyncStatus) funnels through. Returns `{ localKey }` if this manifest
  // entry belongs to the current tab (either a normal synced key, or a
  // per-user key namespaced to MY signed-in userId), or `null` if it must be
  // skipped entirely — a per-user row belonging to a DIFFERENT user (never
  // touch another user's local storage/version map/status), or a bare
  // per-user-classified key with no owner prefix at all (defensive: never
  // treat an unprefixed per-user key as a normal synced key — that would
  // risk sharing one user's UI pref across everyone).
  function _resolveManifestKey(mKey) {
    const split = _splitWireKey(mKey);
    if (split && _isPerUserKey(split.localKey)) {
      const myUid = _myUserId();
      if (!myUid || split.uid !== myUid) return null; // not mine (or nobody signed in) — never touch
      return { localKey: split.localKey };
    }
    if (_isPerUserKey(mKey)) return null; // bare per-user key, no owner prefix — skip defensively
    if (!_shouldReplicate(mKey)) return null;
    return { localKey: mKey };
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
  // `key` here is ALWAYS the plain LOCAL key (every caller passes the same
  // unprefixed name used for _cache/_replicaVersions) — this function is the
  // one place that resolves it to the wire key (see _wireKey) for a per-user
  // key. Never pass a pre-prefixed key in.
  async function _sendKvPut(key, payload) {
    const wireKey = _wireKey(key);
    if (wireKey === null) {
      // Per-user key, nobody signed in — behave local-only: no fetch, no
      // queueing (queue drain/hydration-drift retry paths that reach this
      // fall through their existing "still failing, leave for next cycle"
      // branch on any non-'ok'/non-'conflict' status, which is exactly the
      // desired inert behavior here).
      return { status: 'skipped-no-user' };
    }
    const isTombstone = payload.deleted === true;
    const entry = _replicaVersions[key];
    const baseVersion = entry && typeof entry.version === 'number' ? entry.version : null;
    const bodyObj = isTombstone
      ? { key: wireKey, deleted: true, baseVersion }
      : { key: wireKey, value: payload.value, baseVersion };
    // Phase 2b conflict-modal "Overwrite with mine" / "Restore my version"
    // actions set this so kv-sync.js snapshots the row being replaced into
    // kv_history BEFORE the overwrite lands (kv-sync.js handlePut, explicit
    // deliberate overwrite only — never set on an ordinary write).
    if (payload.explicitOverwrite === true) bodyObj.explicitOverwrite = true;
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

  // --- Phase 2b: array-of-id keys eligible for the "Keep both" disjoint-
  // additive union offer (integration #6). Every entry not listed here falls
  // straight to the standard 3-button modal — no union is even attempted.
  //
  // NOTE (flagged, not guessed): en_projects and en_tasks are bare arrays of
  // objects with a stable `.id` (core.js:786 `tasks.push({id: Date.now(), ...})`,
  // similar for projects). en_dc_events is NOT a bare array — it is
  // `{events, viewYear, viewMonth}` (district-calendar.js:144) and its dc
  // events carry NO `id` field at all. Its getId below reuses the app's own
  // dedup identity for a calendar event — `date + '|' + name` — exactly as
  // district-calendar.js:234 (`addEvent`) already does when importing events,
  // plus `type` for extra safety. `viewYear`/`viewMonth` are "which month is
  // on screen" UI state, not data; the merge keeps the SERVER's values for
  // those two fields — an arbitrary but low-stakes tie-break, called out here
  // rather than silently decided.
  const UNION_KEY_CONFIG = {
    en_projects: {
      getItems: (v) => (Array.isArray(v) ? v : null),
      setItems: (_v, items) => items,
      getId: (item) => item && item.id,
    },
    en_tasks: {
      getItems: (v) => (Array.isArray(v) ? v : null),
      setItems: (_v, items) => items,
      getId: (item) => item && item.id,
    },
    en_dc_events: {
      getItems: (v) => (v && Array.isArray(v.events) ? v.events : null),
      setItems: (v, items) => Object.assign({}, v, { events: items }),
      getId: (item) => item && item.date + '|' + item.name + '|' + item.type,
    },
  };

  // Returns the merged value if `localValue`/`serverValue` are a pure
  // disjoint-additive union (each side only ADDED new ids; every id present
  // on both sides is byte-identical), else null (not eligible — fall back to
  // the standard modal). No true three-way base snapshot exists client-side
  // (only the two current states), so this is a conservative two-way
  // heuristic: it only ever offers a union when the shared items match
  // exactly, never when it would have to guess at an edit vs a removal.
  function _computeDisjointUnion(key, localValue, serverValue) {
    const cfg = UNION_KEY_CONFIG[key];
    if (!cfg) return null;
    const localItems = cfg.getItems(localValue);
    const serverItems = cfg.getItems(serverValue);
    if (!Array.isArray(localItems) || !Array.isArray(serverItems)) return null;

    const serverById = new Map();
    serverItems.forEach((it) => {
      const id = cfg.getId(it);
      if (id !== undefined && id !== null) serverById.set(id, it);
    });

    const localOnly = [];
    for (const it of localItems) {
      const id = cfg.getId(it);
      if (id === undefined || id === null) continue;
      if (!serverById.has(id)) {
        localOnly.push(it);
        continue;
      }
      // Shared id on both sides — must be byte-identical or this is a real
      // edit conflict, not a pure addition. Bail to the standard modal.
      const serverItem = serverById.get(id);
      if (_canonicalJSON(it) !== _canonicalJSON(serverItem)) return null;
    }
    if (!localOnly.length) return null; // nothing new locally — no union to offer

    const mergedItems = serverItems.concat(localOnly);
    return cfg.setItems(serverValue, mergedItems);
  }

  // --- Conflict handling (write-time 409) -----------------------------------
  async function _handleConflict(key, payload, body, mode) {
    const current = body && body.current;
    // Data-safety invariant: archive the losing local write BEFORE adopting
    // the server version or opening any modal — never silently lose either
    // side, and never let a modal button be clickable before this has run.
    _appendConflictArchive({
      key,
      reason: current && current.deleted ? 'write-conflict-tombstone' : 'write-conflict-server-wins',
      losingSide: 'local',
      losingValue: payload.deleted ? null : payload.value,
      losingDeleted: !!payload.deleted,
      winningVersion: current && current.version,
      winningUpdatedBy: current && current.updatedBy,
      winningUpdatedAt: current && current.updatedAt,
    });

    if (mode === 'shadow') {
      // Integration #2 shadow behavior: auto-adopt the server version and
      // retry the PUT once, so the server keeps tracking edits through a
      // rare collision instead of shadow silently getting stuck. Shadow mode
      // never shows a modal — reads stay local-only in shadow, so there is
      // no live page for a modal to interrupt.
      if (current) {
        _replicaVersions[key] = { version: current.version, hash: current.hash || null };
        _persistReplicaState();
      }
      if (typeof showToast === 'function') {
        showToast('Backend sync conflict on ' + key + ' — local copy archived, see en_conflict_archive.', 'error');
      }
      if (current) {
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
      return;
    }

    if (mode !== 'on') return; // 'off' never replicates, so never reaches here

    if (!current) {
      // Defensive: kv-sync.js's contract always returns `current` on a 409
      // (see kv-sync.js rowToConflict) — this should not happen. Never hang
      // the app on a malformed response; queue for a later retry instead.
      console.warn('[DB] Conflict 409 with no current row — cannot show modal, queued for retry:', key);
      _enqueueWrite(key, payload);
      return;
    }

    await _presentConflictModal(key, payload, current);
  }

  // --- Phase 2b: blocking conflict modal (full/'on' mode only) --------------
  async function _presentConflictModal(key, payload, current) {
    const isTombstoneConflict = current.deleted === true && !payload.deleted;
    let unionPreview = null;
    if (!isTombstoneConflict && !payload.deleted && !current.deleted) {
      unionPreview = _computeDisjointUnion(key, payload.value, current.value);
    }
    const localBase = _replicaVersions[key];

    const descriptor = {
      key,
      local: { value: payload.deleted ? undefined : payload.value, deleted: !!payload.deleted },
      server: {
        value: current.value,
        version: current.version,
        deleted: !!current.deleted,
        updatedBy: current.updatedBy,
        updatedAt: current.updatedAt,
      },
      localBaseVersion: localBase && typeof localBase.version === 'number' ? localBase.version : null,
      conflictClass: isTombstoneConflict ? 'tombstone' : unionPreview ? 'union-candidate' : 'standard',
      unionPreview,
      typedConfirmRequired: key.indexOf('en_utility_') === 0,
    };

    if (
      typeof window === 'undefined' ||
      !window.SyncConflictUI ||
      typeof window.SyncConflictUI.showConflictModal !== 'function'
    ) {
      console.warn('[DB] SyncConflictUI unavailable — cannot present conflict modal, write left queued:', key);
      _enqueueWrite(key, payload);
      return;
    }

    let resolution;
    try {
      resolution = await window.SyncConflictUI.showConflictModal(descriptor);
    } catch (e) {
      console.warn('[DB] Conflict modal threw, leaving write queued:', key, e);
      _enqueueWrite(key, payload);
      return;
    }

    await _applyConflictResolution(key, payload, current, resolution);
  }

  // --- Phase 2b: execute the user's chosen conflict-modal resolution --------
  async function _applyConflictResolution(key, payload, current, resolution) {
    const action = resolution && resolution.action;

    if (action === 'load-theirs' || action === 'save-copy' || action === 'discard-mine') {
      // Local losing value was already archived before the modal opened.
      // Adopt the server's current value/version as the new local truth.
      if (current.deleted) {
        await _rawDelete(key);
        _replicaVersions[key] = { version: current.version, hash: current.hash || null, deleted: true };
      } else {
        await _rawSet(key, current.value);
        _replicaVersions[key] = { version: current.version, hash: current.hash || null };
      }
      _persistReplicaState();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key } }));
      }
      if (typeof showToast === 'function') {
        showToast('Loaded the latest saved version of this item.', 'info');
      }
      return;
    }

    if (action === 'overwrite-mine' || action === 'restore-mine') {
      // Retry at the server's current version with explicitOverwrite so
      // kv-sync.js snapshots the row being replaced into kv_history first.
      _replicaVersions[key] = { version: current.version, hash: current.hash || null };
      const retryPayload = Object.assign({}, payload, { explicitOverwrite: true });
      let result;
      try {
        result = await _sendKvPut(key, retryPayload);
      } catch (e) {
        result = { status: 'network-error' };
      }
      if (result.status === 'ok') {
        if (typeof showToast === 'function') {
          showToast('Your version was saved, replacing the server copy.', 'info');
        }
        return;
      }
      if (result.status === 'conflict') {
        // Someone changed it again in the meantime — fresh conflict.
        await _handleConflict(key, payload, result.body, 'on');
        return;
      }
      _enqueueWrite(key, retryPayload);
      return;
    }

    if (action === 'keep-both') {
      const unionValue = resolution.unionValue;
      const cfg = UNION_KEY_CONFIG[key];
      if (!cfg || !Array.isArray(cfg.getItems(unionValue))) {
        console.warn('[DB] keep-both resolution missing a usable unionValue, falling back to load-theirs:', key);
        await _applyConflictResolution(key, payload, current, { action: 'load-theirs' });
        return;
      }
      await _rawSet(key, unionValue);
      _replicaVersions[key] = { version: current.version, hash: current.hash || null };
      const unionPayload = { value: unionValue };
      let result;
      try {
        result = await _sendKvPut(key, unionPayload);
      } catch (e) {
        result = { status: 'network-error' };
      }
      if (result.status === 'ok') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key } }));
        }
        if (typeof showToast === 'function') {
          showToast('Merged both versions — nothing was lost.', 'info');
        }
        return;
      }
      if (result.status === 'conflict') {
        await _handleConflict(key, unionPayload, result.body, 'on');
        return;
      }
      _enqueueWrite(key, unionPayload);
      return;
    }

    console.warn('[DB] Unknown conflict resolution action, leaving write queued:', key, action);
    _enqueueWrite(key, payload);
  }

  // --- Live write replication tail (set()/remove() call this) --------------
  async function _replicateWrite(key, payload) {
    const mode = _backendMode();
    if (mode === 'off') return;
    if (!_shouldReplicate(key)) return;
    // Per-user key + nobody signed in: behave local-only. No fetch, no
    // enqueue — this is the primary guard (INERTNESS: signed-out mirrors
    // classify()==='local-only' exactly). _sendKvPut also re-checks this
    // (via _wireKey returning null) as defense-in-depth for the queue-drain/
    // hydration-drift-repush/conflict-retry paths that call it directly.
    if (_isPerUserKey(key) && !_myUserId()) return;
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

    const routineFetchKeys = []; // WIRE keys (manifest form) to batch-GET
    const routineFetchLocalKey = {}; // wireKey -> localKey, for applying results
    const conflictCheckKeys = []; // { m, localKey } needing a hash-compare
    const tombstoneKeys = []; // { m, localKey } to delete locally

    for (const m of manifest) {
      // Single gate: normal synced key -> localKey === m.key. Per-user key
      // namespaced to ME -> localKey is the stripped name. Per-user key
      // namespaced to ANYONE ELSE (or unrecognized) -> null, skip entirely —
      // never touch _cache/_replicaVersions/_syncQueue for a row that isn't
      // mine (this is the two-user isolation guarantee).
      const resolved = _resolveManifestKey(m.key);
      if (!resolved) continue;
      const localKey = resolved.localKey;

      // A pending local write for this LOCAL key must not be clobbered by hydration.
      if (_syncQueue.some((e) => e.key === localKey)) continue;

      const local = _replicaVersions[localKey];
      const localHasValidEntry = !!(local && typeof local.version === 'number');

      if (m.deleted) {
        if (!localHasValidEntry || local.version < m.version) tombstoneKeys.push({ m, localKey });
        continue;
      }

      if (localHasValidEntry) {
        if (m.version > local.version) {
          routineFetchKeys.push(m.key);
          routineFetchLocalKey[m.key] = localKey;
        }
        // else: local already at/ahead of this version — leave alone.
      } else if (_cache[localKey] === undefined) {
        // Brand-new-to-this-machine key (blank machine / never seen before) —
        // routine pull, not a conflict.
        routineFetchKeys.push(m.key);
        routineFetchLocalKey[m.key] = localKey;
      } else {
        // No entry, or stale/unknown entry, AND a local value already exists
        // — integration #3: potential local-newer-than-seed conflict, never
        // a blind pull.
        conflictCheckKeys.push({ m, localKey });
      }
    }

    // Apply tombstones — "delete locally, record the tombstone's version",
    // NEVER "absent from manifest -> delete" (that would delete a brand-new
    // un-synced local key; we only ever act on an EXPLICIT manifest entry).
    for (const { m, localKey } of tombstoneKeys) {
      await _rawDelete(localKey);
      _replicaVersions[localKey] = { version: m.version, hash: m.hash || null, deleted: true };
    }

    // Routine fetch + apply (hash-compare-before-overwrite rule: this branch
    // is only reached when the local version map already proves the server
    // is strictly newer, or the key never existed locally at all).
    if (routineFetchKeys.length) {
      let rows = [];
      try {
        rows = await _batchGet(routineFetchKeys); // wire keys — the real backend primary keys
      } catch (e) {
        console.warn('[DB] Hydration: batched GET failed, skipping this batch:', e);
        rows = [];
      }
      for (const row of rows) {
        const localKey = routineFetchLocalKey[row.key] || row.key;
        if (_syncQueue.some((e) => e.key === localKey)) continue; // race guard, re-check
        if (row.deleted) {
          await _rawDelete(localKey);
        } else {
          await _rawSet(localKey, row.value);
        }
        const manifestEntry = manifest.find((m) => m.key === row.key);
        _replicaVersions[localKey] = { version: row.version, hash: manifestEntry ? manifestEntry.hash : null };
      }
    }

    // Hash-compare conflict check (integration #3 / R15 hydration-drift drill).
    for (const { m, localKey } of conflictCheckKeys) {
      const localValue = _cache[localKey];
      let localHash;
      try {
        localHash = await _sha256Hex(_canonicalJSON(localValue));
      } catch (e) {
        console.warn('[DB] Hydration: local hash compute failed for', localKey, e);
        continue;
      }
      if (localHash === m.hash) {
        // Same content, different provenance — adopt the version, no data change.
        _replicaVersions[localKey] = { version: m.version, hash: m.hash };
        continue;
      }
      // Genuine drift: local was edited after the export but before hydration
      // went live. Never silently clobber either side.
      console.warn(
        '[DB] Hydration drift detected — keeping local, archiving server value, re-pushing local:',
        localKey,
      );
      let serverValue = null;
      try {
        const rows = await _batchGet([m.key]); // m.key = wire key, the real GET key
        serverValue = rows && rows[0] ? rows[0].value : null;
      } catch (e) {
        // best-effort archive only
      }
      _appendConflictArchive({
        key: localKey,
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
      _replicaVersions[localKey] = { version: m.version, hash: m.hash };
      let putResult;
      try {
        putResult = await _sendKvPut(localKey, { value: localValue }); // local key — _sendKvPut re-resolves the wire key
      } catch (e) {
        putResult = { status: 'network-error' };
      }
      if (putResult.status === 'conflict') {
        // Someone changed it again in between — normal conflict handling.
        await _handleConflict(localKey, { value: localValue }, putResult.body, mode);
      } else if (putResult.status === 'network-error' || putResult.status === 'error') {
        _enqueueWrite(localKey, { value: localValue });
      }
      // 'ok' -> _sendKvPut already updated _replicaVersions.
      // 'skipped-no-user' -> per-user key, signed out mid-session; leave as-is
      // (matches _replicateWrite's inertness guarantee, never queued).
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
      const resolved = _resolveManifestKey(m.key); // skips foreign per-user rows entirely
      if (!resolved) continue;
      const localKey = resolved.localKey;
      const local = _replicaVersions[localKey];
      if (local && typeof local.version === 'number' && m.version > local.version) {
        changedKeys.push(localKey); // local (unprefixed) key — matches what sync-ui.js displays
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

  // --- Per-user-settings-sync (2026-07-20 fix) — shared-browser identity
  // switch. Before this fix, `_cache`/`_replicaVersions` stayed keyed by the
  // plain (unprefixed) key across a sign-out/sign-in on the SAME browser, so
  // a second Entra user inherited the FIRST user's leftover local per-user
  // values, and the hydration-drift branch in _hydrate() could even auto-
  // CAS-PUT that leftover value over the second user's real backend row
  // (see the code comment at ~line 105 that first stated the goal this
  // closes the gap on). ch-auth.js dispatches `chAuthStateChanged` on every
  // sign-in/out; the listener registered near the bottom of this file wires
  // it to _handleAuthIdentityChange below.
  function _clearPerUserLocalState() {
    const cleared = [];
    Object.keys(_cache).forEach((k) => {
      if (_isPerUserKey(k)) cleared.push(k);
    });
    // --- Finding 1 (adversarial review 2026-07-25/26) -----------------------
    // Force the raw-localStorage-only per-user keys onto this same clear list
    // explicitly, rather than relying on them coincidentally already being
    // present in _cache. (They usually ARE present too — a stale byproduct of
    // the one-time migrateFromLocalStorage() copy — but the fix must not
    // depend on that coincidence; see RAW_PER_USER_LOCAL_KEYS above.)
    RAW_PER_USER_LOCAL_KEYS.forEach((k) => {
      if (k === RAW_PER_USER_CH_USER_KEY) return; // never force-cleared — see comment above the constant
      if (cleared.indexOf(k) === -1) cleared.push(k);
    });
    // Dynamic-suffix zoom-level families (setTableZoom) — scan for whichever
    // suffixed keys actually exist in this browser (project/meter ids vary).
    if (typeof localStorage !== 'undefined') {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && _isRawZoomKey(k) && cleared.indexOf(k) === -1) cleared.push(k);
        }
      } catch (e) {
        console.warn('[DB] Finding-1 zoom-key scan failed:', e);
      }
    }

    cleared.forEach((k) => {
      delete _cache[k];
      delete _replicaVersions[k];
      // --- Finding 2 --- durable delete, not just the in-memory cache.
      // warmCache() does an unconditional store.getAll() on every load and
      // would otherwise silently repopulate _cache with the previous user's
      // value on the very next refresh.
      _rawDelete(k);
      // --- Finding 1 --- also remove the raw-localStorage copy directly (a
      // no-op for the ordinary DB-routed per-user keys, which were never in
      // localStorage to begin with).
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(k);
        } catch (e) {
          console.warn('[DB] Failed to clear raw localStorage key on identity switch:', k, e);
        }
      }
    });

    const queueHadPerUserEntries = _syncQueue.some((e) => _isPerUserKey(e.key));
    if (queueHadPerUserEntries) {
      // A pending write from the PREVIOUS user's session must never replay
      // under the new user's wire-key prefix. _enqueueWrite only ever stores
      // the LOCAL key (_sendKvPut re-resolves the wire key at send time), so
      // an undropped entry here would silently push the old user's value
      // into the new user's row on the next queue drain.
      _syncQueue = _syncQueue.filter((e) => !_isPerUserKey(e.key));
    }
    if (cleared.length || queueHadPerUserEntries) {
      _persistReplicaState();
      _persistSyncQueue();
    }
    return cleared;
  }

  async function _handleAuthIdentityChange() {
    const uid = _myUserId();
    if (uid === _lastKnownUserId) return; // chAuthStateChanged fired but the signed-in identity didn't actually change
    _lastKnownUserId = uid;
    const cleared = _clearPerUserLocalState();
    // Finding 2 — persist the new owner durably so a hard refresh right after
    // this switch (warmCache() -> _checkDurableIdentityMarker() below) sees
    // the state is already clean for `uid` and does not need to clear again.
    _rawSet(LOCAL_IDENTITY_KEY, uid || '');
    if (typeof window !== 'undefined' && cleared.length) {
      window.dispatchEvent(new CustomEvent('dbPerUserStateCleared', { detail: { keys: cleared, userId: uid } }));
    }
    // Flag-off/shadow, or a sign-out (uid === null): clear only, stay inert —
    // no network call. Only mode 'on' with someone actually signed in
    // re-hydrates, so the newly-signed-in user's own per-user rows load.
    if (_backendMode() !== 'on' || !uid) return;
    try {
      await _hydrate();
    } catch (e) {
      console.warn('[DB] Re-hydrate after identity change failed:', e);
    }
  }

  // --- Finding 2 (adversarial review 2026-07-25/26) -------------------------
  // Catches the hard-refresh case that _handleAuthIdentityChange (a LIVE
  // chAuthStateChanged listener) cannot: on a fresh page load, _lastKnownUserId
  // re-initializes to the ALREADY-current identity at module-parse time (see
  // the `let _lastKnownUserId = _myUserId();` line above), so no in-memory
  // "change" is ever observed there. This instead compares the newly-resolved
  // identity against a marker durably persisted in the same IDB store the
  // per-user state itself lives in (LOCAL_IDENTITY_KEY), so the comparison
  // survives the refresh. Called once per warmCache() (both the normal and
  // IDB-fallback paths) — gated on backend mode being engaged at all per the
  // hard constraint: byte-identical app behavior, zero new IDB writes, while
  // ch_backend_mode is 'off'.
  function _checkDurableIdentityMarker() {
    if (_backendMode() === 'off') return [];
    let currentUid;
    try {
      currentUid = _myUserId();
    } catch (e) {
      currentUid = null;
    }
    const lastUid = _cache[LOCAL_IDENTITY_KEY];
    const priorKnown = typeof lastUid === 'string' && lastUid ? lastUid : null;
    let cleared = [];
    // Only clear when the last-known owner and the newly-resolved identity
    // are BOTH concretely known and differ — never on a signed-out/unknown
    // transition in either direction (that would risk clearing a legitimate
    // no-identity/demo user's own data — see the "no-identity" test — or
    // punishing a temporary silent-refresh failure as if it were a real
    // switch).
    if (priorKnown && currentUid && priorKnown !== currentUid) {
      cleared = _clearPerUserLocalState();
      _lastKnownUserId = currentUid;
      if (typeof window !== 'undefined' && cleared.length) {
        window.dispatchEvent(
          new CustomEvent('dbPerUserStateCleared', {
            detail: { keys: cleared, userId: currentUid, reason: 'durable-marker-mismatch' },
          }),
        );
      }
    }
    if (currentUid !== priorKnown) {
      _rawSet(LOCAL_IDENTITY_KEY, currentUid || '');
    }
    return cleared;
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
    // (Single source of truth: RAW_PER_USER_LOCAL_KEYS, module-scope above —
    // this used to be its own independently-hand-maintained copy.)
    var lsPreserveKeys = RAW_PER_USER_LOCAL_KEYS;
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
    // (Single source of truth: RAW_PER_USER_LOCAL_KEYS, module-scope above.
    // Note this repair is a no-op for any key _clearPerUserLocalState() just
    // cleared THIS cycle — that also deletes _cache[k], so val below is
    // undefined and nothing gets restored, which is the point of Finding 1.)
    var _lsRepairKeys = RAW_PER_USER_LOCAL_KEYS;
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

      // Finding 2 (adversarial review 2026-07-25/26): detect an identity
      // switch that happened since this browser's last page load (the
      // hard-refresh case _handleAuthIdentityChange's live listener cannot
      // catch on its own) BEFORE _hydrate() runs, so a real switch clears
      // stale per-user state first and then hydration (mode 'on') pulls the
      // newly-signed-in user's own rows down immediately, same as the live
      // in-tab switch path.
      _checkDurableIdentityMarker();

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
      _checkDurableIdentityMarker(); // Finding 2 — same hard-refresh check as the primary IDB path above
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

  // --- Phase 2b: conflict-archive viewer accessor ----------------------------
  // Read-only convenience for app/sync-ui.js's archive panel — same data
  // `sget('en_conflict_archive', [])` would return, just without requiring
  // sync-ui.js to know about the sget/sset global naming convention.
  function getConflictArchive() {
    const v = _cache['en_conflict_archive'];
    return Array.isArray(v) ? v : [];
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
    const keys = [];
    for (const m of manifest) {
      // _resolveManifestKey skips any per-user row that isn't mine — the
      // status panel must never expose another user's per-user key/values.
      const resolved = _resolveManifestKey(m.key);
      if (!resolved) continue;
      const localKey = resolved.localKey;
      const local = _replicaVersions[localKey];
      keys.push({
        key: localKey, // local (unprefixed) name — what sync-ui.js displays
        localVersion: local ? local.version : null,
        localHash: local ? local.hash : null,
        serverVersion: m.version,
        serverHash: m.hash,
        deleted: !!m.deleted,
        inSync: !!(local && local.version === m.version),
      });
    }
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
    // Per-user-settings-sync (2026-07-20 fix) — see _handleAuthIdentityChange
    // above. Registered unconditionally (not gated on backend mode/warmCache
    // completion) because app/ch-auth.js starts its background silent-refresh
    // timer — and can fire chAuthStateChanged — immediately on its own load,
    // which happens before app/db.js's warmCache()/_hydrate() resolve.
    window.addEventListener('chAuthStateChanged', _handleAuthIdentityChange);
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
    getConflictArchive,
    setBackendMode,
  };
})();

window.DB = DB;
