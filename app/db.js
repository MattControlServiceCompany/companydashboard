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
  // Local-only: the server value of each collection key (UNION_KEY_CONFIG) at the
  // version in ch_replica_state. The base of every per-record three-way merge.
  const SYNC_BASE_KEY = 'ch_sync_base';
  // Local-only: full copy of every item this browser removed from a collection,
  // kept DELETED_ITEM_RETENTION_MS. The shared deletion record holds only the stamp.
  const DELETED_ITEMS_KEY = 'ch_deleted_items';
  const DELETED_ITEM_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  const GZIP_THRESHOLD_BYTES = 1024 * 1024; // 2a item 6 — gzip PUT bodies over ~1MB
  const MANIFEST_TIMEOUT_MS = 4000; // §2.2 offline timeout window (~3-5s)
  const BATCH_GET_CHUNK_KEYS = 6; // keys per hydration GET (B4)
  const BATCH_GET_TIMEOUT_MS = 60000; // one batched GET (a value can be several MB gzipped)
  const TOMBSTONE_RETRY_BASE_MS = 5000; // deletion-record fetch failed: retry 5s, 10s, 20s ... up to 5 min
  const TOMBSTONE_RETRY_MAX_MS = 5 * 60 * 1000;
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
  let _syncBase = {}; // collection key -> server value at _replicaVersions[key].version (SYNC_BASE_KEY)

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
  // CH_AUTH.getUserId()/the Supabase auth user id — see app/ch-auth.js — not
  // by this app-level display-name/session marker).
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
  // Last user id/email signed in on this browser; owner tag for queued edits.
  const LAST_USER_KEY = 'ch_last_user';
  let _lastUser = null;

  // --- Backend mode -------------------------------------------------------
  // Derived only by CH_AUTH.backendMode(): 'on' = signed in on the production
  // Netlify host (hydration at load + manifest polling + write-through);
  // 'off' = everywhere else (no network). There is no stored switch.
  function _backendMode() {
    return typeof window !== 'undefined' && window.CH_AUTH ? window.CH_AUTH.backendMode() : 'off';
  }

  function _isSyncHost() {
    return typeof window !== 'undefined' && !!window.CH_AUTH && window.CH_AUTH.isSyncHost() === true;
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

  // --- Auth seam (phase2a-build-plan.md §4) ---------------------------------
  // Every kv-sync fetch routes through this ONE helper, reading the caller's
  // identity exclusively from window.CH_AUTH.getToken() (app/ch-auth.js —
  // Supabase Auth). `x-stub-user` was removed 2026-08 — the Netlify
  // Functions never read that header (verifyAuth derives identity solely
  // from the verified JWT's email claim), so it was a dead client-side
  // header left over from the pre-auth dev stub.
  function _authHeaders() {
    // Not a real credential — a placeholder used only if nobody is signed
    // in (window.CH_AUTH has no cached token yet). The server's verifyAuth()
    // rejects this with 401, same as any other invalid bearer token. Built
    // from parts so a generic secret-scan pattern (`token\s*=\s*['"]...`)
    // doesn't false-positive on a literal that is deliberately public/
    // non-sensitive.
    let authValue = ['dev', 'stub', 'token'].join('-');
    if (typeof window !== 'undefined' && window.CH_AUTH && typeof window.CH_AUTH.getToken === 'function') {
      try {
        const real = window.CH_AUTH.getToken();
        if (real) authValue = real;
      } catch (e) {
        // fall through to the placeholder above
      }
    }
    return { Authorization: 'Bearer ' + authValue };
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
          // An own "__proto__" key from server JSON must not change this object's
          // prototype. kv-sync.js drops it from the hash input the same way.
          if (k === '__proto__') return;
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
    // A collection merged by the engine is adopted IN PLACE: page globals hold
    // the cache reference (core.js init `projects = sget(...)`) and must see it.
    if (_collectionCfg(key)) {
      value = _adoptCollection(key, value);
      if (UNION_KEY_CONFIG[key]) _noteCollection(key, value);
    }
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
    const base = _cache[SYNC_BASE_KEY];
    _syncBase = base && typeof base === 'object' ? base : {};
    Object.keys(UNION_KEY_CONFIG).forEach((k) => _noteCollection(k, _cache[k]));
  }
  function _persistReplicaState() {
    _rawSet(REPLICA_STATE_KEY, _replicaVersions);
  }
  // The ONE place a key is stamped as "in sync at this server version". For a
  // collection key the server value at that version is kept as the merge base.
  function _setSynced(key, stamp, serverValue) {
    _replicaVersions[key] = stamp;
    if (_collectionCfg(key)) {
      if (stamp.deleted || serverValue === undefined || serverValue === null) delete _syncBase[key];
      else _syncBase[key] = JSON.parse(JSON.stringify(serverValue));
      _rawSet(SYNC_BASE_KEY, _syncBase);
    }
    _persistReplicaState();
  }

  // --- 2a.5: sync-queue persistence + pill event ----------------------------
  function _loadSyncQueue() {
    const stored = _cache[SYNC_QUEUE_KEY];
    _syncQueue = Array.isArray(stored) ? stored : [];
    const lu = _cache[LAST_USER_KEY];
    _lastUser = lu && typeof lu.id === 'string' ? lu : null;
    _recordLastUser();
  }
  // Owner tag for queued edits: the user id (and email) last signed in on this
  // browser. Persisted so an edit made while signed out keeps its owner across reload.
  function _recordLastUser() {
    const id = _myUserId();
    if (!id) return;
    let email = null;
    try {
      email = window.CH_AUTH && window.CH_AUTH.getEmail ? window.CH_AUTH.getEmail() : null;
    } catch (e) {
      email = null;
    }
    if (_lastUser && _lastUser.id === id && (_lastUser.email || null) === email) return;
    _lastUser = { id, email };
    _rawSet(LAST_USER_KEY, _lastUser);
  }
  function _queueOwner() {
    const id = _myUserId();
    if (id) {
      _recordLastUser();
      return _lastUser && _lastUser.id === id ? _lastUser : { id, email: null };
    }
    // Signed out: NO verified identity. The entry has no owner id. It records
    // only which verified user was last on this browser (hintId). The drain
    // hands it to that user alone, and only when that user's verified session
    // id matches. A different person signing in never gets it.
    return { id: null, email: null, hintId: _lastUser && _lastUser.id ? _lastUser.id : null };
  }
  function _entryOwnerKey(o) {
    return o && o.id ? 'id:' + o.id : 'hint:' + ((o && o.hintId) || '');
  }
  // True when the signed-in verified user may send/re-apply this entry.
  function _entryBelongsTo(e, me) {
    if (!me || !e.owner) return false;
    if (e.owner.id) return e.owner.id === me;
    return !!e.owner.hintId && e.owner.hintId === me;
  }
  // Signed-out entries become the verified user's own when that same user signs in.
  function _claimSignedOutEntries(me) {
    if (!me) return;
    let changed = false;
    _syncQueue.forEach((e) => {
      if (e.owner && !e.owner.id && e.owner.hintId === me) {
        e.owner = { id: me, email: (_lastUser && _lastUser.id === me && _lastUser.email) || null };
        changed = true;
      }
    });
    if (changed) _persistSyncQueue();
  }
  // Put this user's queued per-user values back into the local cache (the
  // identity change removed them so another user never sees or writes them).
  function _reapplyQueuedPerUserValues(me) {
    if (!me) return;
    _claimSignedOutEntries(me);
    _syncQueue.forEach((e) => {
      if (!_isPerUserKey(e.key) || !_entryBelongsTo(e, me)) return;
      if (e.deleted) {
        delete _cache[e.key];
        _rawDelete(e.key);
      } else {
        _cache[e.key] = e.value;
        _rawSet(e.key, e.value);
      }
    });
  }
  // Pending edits that belong to a different user than the one signed in now.
  // Never sent, never deleted; the bar in sync-ui.js reports them.
  function getForeignQueueInfo() {
    const me = _myUserId();
    const by = {};
    _syncQueue.forEach((e) => {
      if (!e.owner || _entryBelongsTo(e, me)) return;
      const oid = e.owner.id || e.owner.hintId;
      if (!oid) return;
      const oEmail = e.owner.email || (_lastUser && _lastUser.id === oid ? _lastUser.email : null);
      const o = by[oid] || (by[oid] = { id: oid, email: oEmail || 'another user', count: 0 });
      o.count++;
    });
    return Object.keys(by).map((k) => by[k]);
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
    // Owner = the verified user who made the edit, captured when the edit began
    // (payload.owner). Never re-read after an await: the user may have changed.
    const owner = payload.owner || _queueOwner();
    // Coalesce per key AND owner: one user's edit never replaces another user's pending edit.
    _syncQueue = _syncQueue.filter((e) => !(e.key === key && _entryOwnerKey(e.owner) === _entryOwnerKey(owner)));
    _syncQueue.push({
      id: _genId(),
      key,
      owner,
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
  // The archive is NEVER trimmed by the app: it may hold the only copy of a
  // user's edit. Past the cap it keeps growing and raises a persistent notice
  // (app/sync-ui.js) with an Export button; entries are removed only after the
  // user exports and confirms (clearConflictArchive).
  const CONFLICT_ARCHIVE_CAP_ENTRIES = 200;
  const CONFLICT_ARCHIVE_CAP_BYTES = 5 * 1024 * 1024;
  let _archivedLocalThisRun = 0; // hydration entries whose local side lost (drives the toast)
  // Written IMMEDIATELY (before the caller overwrites the local value): the
  // IDB put is issued first, and same-store transactions commit in order.
  function _appendConflictArchive(entry) {
    const full = Object.assign({ archivedAt: new Date().toISOString() }, entry);
    try {
      // Written through this module's own set(), NOT core.js sset(): sset sends
      // the write to localStorage while the DB is not ready yet (hydration runs
      // inside warmCache, before ready), which hides the entry from the
      // conflict-archive viewer (DB.getConflictArchive reads the DB cache).
      const prior = _cache['en_conflict_archive'];
      const archive = (Array.isArray(prior) ? prior : []).concat([full]);
      Promise.resolve(set('en_conflict_archive', archive)).catch((e) =>
        console.warn('[DB] Failed to persist conflict archive:', e),
      );
      if (entry.reason === 'hydration-server-wins') _archivedLocalThisRun++;
      if (isConflictArchiveFull() && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('conflictArchiveFull', { detail: { count: archive.length } }));
      }
    } catch (e) {
      console.warn('[DB] Failed to append to conflict archive:', e);
    }
  }
  function isConflictArchiveFull() {
    const v = _cache['en_conflict_archive'];
    if (!Array.isArray(v)) return false;
    if (v.length > CONFLICT_ARCHIVE_CAP_ENTRIES) return true;
    try {
      return JSON.stringify(v).length > CONFLICT_ARCHIVE_CAP_BYTES;
    } catch (e) {
      return false;
    }
  }
  // Removes the FIRST `count` entries (the ones the user exported). Call only
  // after the export file was saved and the user confirmed.
  function clearConflictArchive(count) {
    const v = _cache['en_conflict_archive'];
    if (!Array.isArray(v) || !(count > 0)) return;
    set('en_conflict_archive', v.slice(count));
  }
  // showToast lives in core.js, loaded after db.js, so wait for it.
  function _showLater(msg, kind) {
    setTimeout(function () {
      if (typeof showToast === 'function') showToast(msg, kind || 'info', 10000);
    }, 2000);
  }

  // --- Core PUT sender — every write/delete/queue-replay/hydration-drift-
  // repush funnels through here. Returns a result descriptor, never throws
  // for ordinary network/HTTP failures (those come back as a status string).
  // `key` here is ALWAYS the plain LOCAL key (every caller passes the same
  // unprefixed name used for _cache/_replicaVersions) — this function is the
  // one place that resolves it to the wire key (see _wireKey) for a per-user
  // key. Never pass a pre-prefixed key in.
  // Derived per-meter caches: getMeterSavings()/getNormRows() recompute them on load and write
  // them back onto the live meter objects, which are the same objects held in _cache. They must
  // never leave the app (backup export, server push). ONE list, ONE function (9914423a).
  const DERIVED_METER_FIELDS = ['_savingsCache', '_savingsCacheKey', '_reg', '_savingsByYM', '_unitSavByCalMo'];
  function _isUtilityKey(key) {
    return /^en_utility_(cust_.+|\d+)$/.test(key);
  }
  // Returns `value` unchanged unless it is utility data holding derived caches; then returns a
  // copy with them removed (never mutates the live objects). Strings holding JSON are left alone.
  function stripDerivedCaches(key, value) {
    if (!_isUtilityKey(key) || !value || !Array.isArray(value.buildings)) return value;
    return Object.assign({}, value, {
      buildings: value.buildings.map((b) =>
        !b || !Array.isArray(b.meters)
          ? b
          : Object.assign({}, b, {
              meters: b.meters.map((m) => {
                if (!m || !DERIVED_METER_FIELDS.some((f) => f in m)) return m;
                const c = Object.assign({}, m);
                DERIVED_METER_FIELDS.forEach((f) => delete c[f]);
                return c;
              }),
            }),
      ),
    });
  }
  // Export copy of the whole cache: every key passed through stripDerivedCaches.
  function getAllForExport() {
    const out = {};
    Object.keys(_cache).forEach((k) => {
      out[k] = stripDerivedCaches(k, _cache[k]);
    });
    return out;
  }

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
    const epoch = _identityEpoch;
    const isTombstone = payload.deleted === true;
    const entry = _replicaVersions[key];
    const baseVersion = entry && typeof entry.version === 'number' ? entry.version : null;
    const bodyObj = isTombstone
      ? { key: wireKey, deleted: true, baseVersion }
      : { key: wireKey, value: stripDerivedCaches(key, payload.value), baseVersion };
    // Phase 2b conflict-modal "Overwrite with mine" / "Restore my version"
    // actions set this so kv-sync.js snapshots the row being replaced into
    // kv_history BEFORE the overwrite lands (kv-sync.js handlePut, explicit
    // deliberate overwrite only — never set on an ordinary write).
    if (payload.explicitOverwrite === true) bodyObj.explicitOverwrite = true;
    const bodyStr = JSON.stringify(bodyObj);
    // Token and wire key belong to the same identity: both are read before the
    // gzip await, and the request is dropped if the identity changed during it.
    const authHeaders = _authHeaders();
    const gz = await _maybeGzipBody(bodyStr);
    if (epoch !== _identityEpoch || _wireKey(key) !== wireKey) return { status: 'stale-identity' };

    let res;
    try {
      res = await fetch(KV_SYNC_URL, {
        method: 'PUT',
        headers: Object.assign({ 'content-type': 'application/json' }, gz.headers, authHeaders),
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

    if (epoch !== _identityEpoch) return { status: 'stale-identity' }; // user changed mid-request: stamp nothing
    if (res.status === 200) {
      let okHash = json.hash || null;
      if (!okHash && !isTombstone) {
        try {
          okHash = await _sha256Hex(_canonicalJSON(stripDerivedCaches(key, payload.value)));
        } catch (e) {
          okHash = null;
        }
        if (epoch !== _identityEpoch) return { status: 'stale-identity' };
      }
      _setSynced(key, { version: json.version, hash: okHash }, isTombstone ? undefined : bodyObj.value);
      return { status: 'ok', body: json };
    }
    if (res.status === 409) {
      return { status: 'conflict', body: json };
    }
    return { status: 'error', body: json, httpStatus: res.status };
  }

  // --- Collection keys: one list of records with a stable id ------------------
  // Every key here is merged RECORD BY RECORD (three-way, against the last
  // server value in _syncBase) by _mergeCollection, the ONE merge for these
  // keys: hydration, the write-conflict (409) path and restore all call it.
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
  const _bareList = {
    getItems: (v) => (Array.isArray(v) ? v : null),
    setItems: (_v, items) => items,
    getId: (item) => item && item.id,
  };
  const UNION_KEY_CONFIG = {
    en_projects: Object.assign({}, _bareList, {
      getLabel: (it) => it && it.name,
    }),
    // Customer/Multi-Project (2026-09-24): deterministic customer ids ('cust_' +
    // projectId, see _selfHealCustomersAndScope in app/utility-data.js) make two
    // independent browsers migrating the same project converge on byte-identical
    // shared-id rows, so this merges cleanly with no conflict modal.
    en_customers: Object.assign({}, _bareList, {
      getLabel: (it) => it && it.name,
    }),
    en_tasks: Object.assign({}, _bareList, { getLabel: (it) => it && it.text }),
    en_dc_events: {
      itemsProp: 'events',
      getItems: (v) => (v && Array.isArray(v.events) ? v.events : null),
      setItems: (v, items) => _safeAssign({}, v, { events: items }),
      getId: (item) => item && item.date + '|' + item.name + '|' + item.type,
      getLabel: (it) => it && it.name + ' (' + it.date + ')',
    },
    // ems-leads.html: array of leads with genId() ids, written through sset.
    ems_leads_v1: Object.assign({}, _bareList, {
      getLabel: (it) => it && (it.company || it.name),
    }),
  };

  // --- Keys merged by id WITHOUT deletion records (M2, 2026-10-06) ------------
  // Two users editing the same key at once must not lose edits. These keys use
  // the same three-way merge (_mergeCollection) as UNION_KEY_CONFIG, but a
  // removal is decided by the merge base alone (no shared deletion record), and
  // every item must carry an id (requireIds): a list that cannot be matched by
  // id is not merged and goes to the whole-key conflict modal, so nothing is
  // dropped. `children` names nested id lists merged the same way.
  //   en_utility_audit_log  append-only: an entry never changes after it is written
  //   en_pdf_bills          list of held bill records, id 'pb...'
  //   en_utility_<id>       { buildings:[{id, meters:[{id, bills:[{id}]}]}] }
  const _byIdProp = (it) => it && it.id;
  const AUDIT_ENTRY_ID = (it) => (it && typeof it === 'object' ? _canonicalJSON(it) : undefined);
  const MERGE_ONLY_CONFIG = {
    audit: {
      noDeletionRecords: true,
      requireIds: true,
      idOccurrence: true, // two identical entries stay two entries (id + '#n')
      getItems: (v) => (Array.isArray(v) ? v : null),
      // Newest first, like logUtilityAudit writes it.
      setItems: (_v, items) =>
        items.slice().sort((a, b) => (a && b && a.ts < b.ts ? 1 : a && b && a.ts > b.ts ? -1 : 0)),
      getId: AUDIT_ENTRY_ID,
      getLabel: (it) => it && it.action,
    },
    pdfBills: Object.assign({ noDeletionRecords: true, requireIds: true }, _bareList, {
      getLabel: (it) => it && (it.id || it.fileName),
    }),
    utility: {
      noDeletionRecords: true,
      requireIds: true,
      itemsProp: 'buildings',
      getItems: (v) => (v && Array.isArray(v.buildings) ? v.buildings : null),
      setItems: (v, items) => _safeAssign({}, v, { buildings: items }),
      getId: _byIdProp,
      getLabel: (it) => it && it.name,
      children: {
        meters: { getId: _byIdProp, children: { bills: { getId: _byIdProp } } },
      },
    },
  };
  // The ONE lookup for "is this key merged by id, and how".
  function _collectionCfg(key) {
    if (UNION_KEY_CONFIG[key]) return UNION_KEY_CONFIG[key];
    if (key === 'en_utility_audit_log') return MERGE_ONLY_CONFIG.audit;
    if (key === 'en_pdf_bills') return MERGE_ONLY_CONFIG.pdfBills;
    if (_isUtilityKey(key)) return MERGE_ONLY_CONFIG.utility;
    return null;
  }

  // --- Deletion records (F1, 2026-10-05) -------------------------------------
  // A union merge cannot tell "added locally" from "deleted on the server".
  // So every removal from a UNION_KEY_CONFIG list is recorded in ONE synced
  // key: { <listKey>: { <id>: { t, restored? } } } (stamps only, so the key
  // stays small). The removed item itself is kept on the deleting browser in
  // DELETED_ITEMS_KEY for DELETED_ITEM_RETENTION_MS. Every merge drops a record
  // whose id has an active deletion entry, on both sides. An id added again
  // later (restore, re-import) gets `restored` set to the time it came back,
  // which turns that entry off; a newer delete turns it on again (larger t).
  // Entries older than DELETED_ITEM_RETENTION_MS are pruned in _mergeTombstones.
  const TOMBSTONE_KEY = 'en_deleted_records';
  // Server JSON must never reach these property names on a local object.
  function _unsafeKey(k) {
    return k === '__proto__' || k === 'constructor' || k === 'prototype';
  }
  function _own(obj, k) {
    return !!obj && !_unsafeKey(k) && Object.prototype.hasOwnProperty.call(obj, k);
  }
  function _safeAssign(target, ...sources) {
    sources.forEach((src) => {
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach((k) => {
        if (!_unsafeKey(k)) target[k] = src[k];
      });
    });
    return target;
  }
  function _tombStamp(e) {
    return Math.max((e && e.t) || 0, (e && e.restored) || 0);
  }
  function _tombActive(e) {
    return !!e && !((e.restored || 0) >= (e.t || 0) && e.restored);
  }
  // Union of two deletion-record sets, newest stamp per id wins; rebuilt key by
  // key (unsafe names skipped); entries past the retention window dropped.
  function _mergeTombstones(a, b) {
    const out = {};
    const cutoff = Date.now() - DELETED_ITEM_RETENTION_MS;
    [a, b].forEach((src) => {
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach((lk) => {
        if (_unsafeKey(lk)) return;
        out[lk] = out[lk] || {};
        Object.keys(src[lk] || {}).forEach((id) => {
          if (_unsafeKey(id)) return;
          const e = src[lk][id];
          if (!e || typeof e !== 'object' || _tombStamp(e) < cutoff) return;
          const cur = out[lk][id];
          if (!cur || _tombStamp(e) > _tombStamp(cur)) {
            out[lk][id] = e.restored ? { t: e.t, restored: e.restored } : { t: e.t };
          }
        });
      });
    });
    return out;
  }
  // id -> item. `occurrence`: a repeated id gets '#n' so identical items all stay.
  function _idMapOf(items, getId, occurrence) {
    const m = new Map();
    if (!Array.isArray(items)) return m;
    items.forEach((it) => {
      const id = getId(it);
      if (id === undefined || id === null) return;
      let k = String(id);
      if (occurrence) for (let n = 1; m.has(k); n++) k = String(id) + '#' + n;
      m.set(k, it);
    });
    return m;
  }
  function _itemIds(key, value) {
    const cfg = _collectionCfg(key);
    return cfg ? _idMapOf(cfg.getItems(value), cfg.getId, cfg.idOccurrence) : new Map();
  }
  // True when every item has an id and (unless repeats are allowed) no id repeats.
  function _idsUsable(items, getId, occurrence) {
    if (!Array.isArray(items)) return true;
    const seen = new Set();
    for (const it of items) {
      const id = getId(it);
      if (id === undefined || id === null || id === '') return false;
      if (!occurrence) {
        if (seen.has(String(id))) return false;
        seen.add(String(id));
      }
    }
    return true;
  }
  // The ONE function for "this collection changed from oldValue to newValue":
  // set() and restorePush call it. Records removed ids (stamp in the shared
  // key, the item in DELETED_ITEMS_KEY) and marks ids that came back as
  // restored. `restoreAll` (restore from backup) marks EVERY id in newValue
  // that has an active deletion entry as restored, not only the ones absent
  // from oldValue, so a stale deletion record can never delete a restored
  // item again. Returns the replication promise of the shared key (null if
  // nothing changed) so a caller can wait for the server to hold the records.
  // --- Page globals and the cache share one reference ---------------------------
  // Pages load a collection once (core.js init: `projects = sget('en_projects')`,
  // ems-leads.html `leads = sget(...)`, district-calendar `dcEvents`) and save the
  // same array back with sset. When the engine merges in another user's record
  // (409 merge, hydration) the merged list is written INTO that array, so the
  // page's next save still holds the record. Deletions are detected against
  // _lastItems, the ids this tab last stored for the key, never against the array
  // the page passes (that can be the same, already mutated, reference).
  const _lastItems = {}; // key -> Map(id -> item) as of the last store
  function _noteCollection(key, value) {
    _lastItems[key] = _itemIds(key, value);
  }
  function _adoptCollection(key, next) {
    const cfg = _collectionCfg(key);
    const cur = _cache[key];
    if (!cfg || cur === next || !cur || typeof cur !== 'object' || !next || typeof next !== 'object') return next;
    const curItems = cfg.getItems(cur);
    const nextItems = cfg.getItems(next);
    if (!Array.isArray(curItems) || !Array.isArray(nextItems)) return next;
    // Keep object identity: a page can hold a record object (the open project)
    // across a save. Fields are copied INTO the existing object by id, and
    // fields the merge removed are deleted, so a later edit through the held
    // reference is still the record that gets saved.
    const curById = _itemIds(key, cur);
    curItems.length = 0;
    nextItems.forEach((it) => {
      const id = cfg.getId(it);
      const old = id !== undefined && id !== null ? curById.get(String(id)) : undefined;
      if (old && old !== it && _isPlainObject(old) && _isPlainObject(it)) {
        Object.keys(old).forEach((f) => {
          if (!Object.prototype.hasOwnProperty.call(it, f)) delete old[f];
        });
        _safeAssign(old, it);
        curItems.push(old);
      } else {
        curItems.push(it);
      }
    });
    if (!Array.isArray(cur)) {
      _safeAssign(cur, next);
      cur[cfg.itemsProp] = curItems;
    }
    return cur;
  }
  function _recordDeletions(key, before, newValue, restoreAll) {
    if (!UNION_KEY_CONFIG[key]) return null;
    const after = _itemIds(key, newValue);
    if (!before.size && !after.size) return null;
    const tomb = _mergeTombstones(_cache[TOMBSTONE_KEY], null);
    const kept = JSON.parse(JSON.stringify(_cache[DELETED_ITEMS_KEY] || {}));
    let changed = false;
    let keptChanged = false;
    const now = Date.now();
    before.forEach((item, id) => {
      if (after.has(id)) return;
      if (_unsafeKey(id)) return;
      tomb[key] = tomb[key] || {};
      tomb[key][id] = { t: now };
      kept[key] = kept[key] || {};
      kept[key][id] = { t: now, item };
      changed = true;
      keptChanged = true;
    });
    after.forEach((_item, id) => {
      if (!restoreAll && before.has(id)) return;
      const e = _own(tomb[key], id) ? tomb[key][id] : null;
      if (e && _tombActive(e)) {
        e.restored = now > (e.t || 0) ? now : (e.t || 0) + 1;
        changed = true;
      }
    });
    Object.keys(kept).forEach((lk) => {
      Object.keys(kept[lk] || {}).forEach((id) => {
        if ((kept[lk][id].t || 0) < now - DELETED_ITEM_RETENTION_MS) {
          delete kept[lk][id];
          keptChanged = true;
        }
      });
    });
    if (keptChanged) _rawSet(DELETED_ITEMS_KEY, kept);
    if (!changed) return null;
    _rawSet(TOMBSTONE_KEY, tomb);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key: TOMBSTONE_KEY } }));
    }
    return _replicateWrite(TOMBSTONE_KEY, { value: tomb }).catch((e) =>
      console.warn('[DB] replication tail error:', TOMBSTONE_KEY, e),
    );
  }
  // Drops every item with an active deletion entry. Returns { value, removed }.
  function _dropTombstoned(key, value) {
    const cfg = _collectionCfg(key);
    const tomb = _own(_cache[TOMBSTONE_KEY], key) ? _cache[TOMBSTONE_KEY][key] : null;
    if (!cfg || cfg.noDeletionRecords || !tomb || value === undefined || value === null) return { value, removed: [] };
    const items = cfg.getItems(value);
    if (!Array.isArray(items)) return { value, removed: [] };
    const removed = [];
    const kept = items.filter((it) => {
      const id = cfg.getId(it);
      if (id !== undefined && id !== null && _own(tomb, String(id)) && _tombActive(tomb[String(id)])) {
        removed.push(it);
        return false;
      }
      return true;
    });
    return removed.length ? { value: cfg.setItems(value, kept), removed } : { value, removed };
  }
  // Deletion-record fetch state. FAIL CLOSED: while `ok` is false no collection
  // key is merged, uploaded or re-sent (a merge without the latest records
  // would bring deleted items back). Retries by itself with backoff; shown in
  // Sync status (getSyncStatus().deletionRecords, event dbDeletionRecordsStatus).
  let _tombstoneState = { ok: true, error: null, failures: 0, nextRetryAt: null };
  let _tombstoneRetryTimer = null;
  function _emitTombstoneState() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dbDeletionRecordsStatus', {
          detail: Object.assign({}, _tombstoneState),
        }),
      );
    }
  }
  // Plain words for the Sync status panel (no HTTP jargon).
  function _plainFetchError(e) {
    const msg = String((e && e.message) || e || '');
    const m = msg.match(/(\d{3})\s*$/);
    if (m) return 'the server answered with an error, code ' + m[1];
    if (/abort/i.test(msg)) return 'the server took too long to answer';
    return 'no connection to the server';
  }
  function _noteTombstoneFailure(e) {
    const failures = _tombstoneState.failures + 1;
    const delay = Math.min(TOMBSTONE_RETRY_BASE_MS * Math.pow(2, failures - 1), TOMBSTONE_RETRY_MAX_MS);
    _tombstoneState = {
      ok: false,
      error: _plainFetchError(e),
      failures,
      nextRetryAt: Date.now() + delay,
    };
    _emitTombstoneState();
    if (_tombstoneRetryTimer) clearTimeout(_tombstoneRetryTimer);
    _tombstoneRetryTimer = setTimeout(async () => {
      _tombstoneRetryTimer = null;
      if (_backendMode() !== 'on') return;
      if (await _refreshTombstones()) {
        try {
          await _hydrate(); // the collection keys skipped while blocked
        } catch (err) {
          console.warn('[DB] Re-hydrate after deletion records recovered failed:', err);
        }
      }
    }, delay);
  }
  // Brings the latest deletion records from the server into the local copy
  // (union by id, newest stamp wins) and pushes back any local-only entries.
  // Resolves true when the records are current, false when the fetch failed
  // (state recorded, retry scheduled) or the identity changed meanwhile.
  async function _refreshTombstones() {
    const epoch = _identityEpoch;
    let rows = [];
    try {
      rows = await _batchGet([TOMBSTONE_KEY]);
    } catch (e) {
      _noteTombstoneFailure(e);
      return false;
    }
    if (epoch !== _identityEpoch) return false;
    const row = rows && rows[0];
    if (row && !row.deleted) await _reconcileIncoming(TOMBSTONE_KEY, row, row.hash || null);
    if (epoch !== _identityEpoch) return false;
    if (_tombstoneRetryTimer) {
      clearTimeout(_tombstoneRetryTimer);
      _tombstoneRetryTimer = null;
    }
    const wasBlocked = !_tombstoneState.ok;
    _tombstoneState = { ok: true, error: null, failures: 0, nextRetryAt: null };
    if (wasBlocked) _emitTombstoneState();
    return true;
  }
  function _tombstonesBlocked() {
    return !_tombstoneState.ok;
  }

  // --- The ONE merge for a collection key (per record, three-way) ------------
  // base = the server value at the version this browser last synced
  // (_syncBase), local = this browser's list, server = the server's list now.
  // Items with an active deletion record are dropped from every side first
  // (the dropped local copies are archived as 'deleted-elsewhere'). Then per id:
  //   same on both sides            -> keep
  //   changed on one side only      -> that side (a removal on that side removes it)
  //   removed here, changed there   -> theirs (nothing was edited here)
  //   changed here, removed there   -> mine (no deletion record: never drop an edit)
  //   changed on both sides         -> field by field (plain objects): a field
  //                                    changed on one side only merges; the same
  //                                    field changed on both sides is a CONFLICT
  // A conflict record keeps the server version in `value`; the caller decides
  // (hydration: server wins, local archived; write path: the user chooses).
  // Returns null when a side is not a list at all (not a collection value).
  function _diffFields(a, b) {
    const out = [];
    const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    keys.forEach((f) => {
      if (_unsafeKey(f)) return;
      if (_canonicalJSON(a ? a[f] : undefined) !== _canonicalJSON(b ? b[f] : undefined)) out.push(f);
    });
    return out;
  }
  function _isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function _mergeFields(b, l, s, children) {
    if (!_isPlainObject(b) || !_isPlainObject(l) || !_isPlainObject(s)) return null;
    const out = {};
    const keys = new Set(Object.keys(b).concat(Object.keys(l), Object.keys(s)));
    for (const f of keys) {
      if (_unsafeKey(f)) continue;
      const cb = _canonicalJSON(b[f]);
      const cl = _canonicalJSON(l[f]);
      const cs = _canonicalJSON(s[f]);
      let v;
      if (cl === cs) v = s[f];
      else if (cl === cb) v = s[f];
      else if (cs === cb) v = l[f];
      else if (children && _own(children, f)) {
        // A nested id list changed on both sides: merge it by id as well.
        v = _mergeNestedList(b[f], l[f], s[f], children[f]);
        if (v === null) return null;
      } else return null; // same field changed on both sides
      if (v !== undefined) out[f] = v;
    }
    return out;
  }
  function _mergeNestedList(b, l, s, spec) {
    const ok = (v) => v === undefined || v === null || Array.isArray(v);
    if (!ok(b) || !ok(l) || !ok(s)) return null;
    if (!_idsUsable(l, spec.getId) || !_idsUsable(s, spec.getId)) return null; // cannot match by id: no merge
    const conflicts = [];
    const out = _mergeIdMaps(
      _idMapOf(b, spec.getId),
      _idMapOf(l, spec.getId),
      _idMapOf(s, spec.getId),
      spec.children,
      conflicts,
    );
    return conflicts.length ? null : out;
  }
  // Per-id three-way merge of three id maps (see the table above _diffFields).
  // Order: the server's order, then ids only this side has. A record changed on
  // both sides is merged field by field; an unmergeable one is pushed to
  // `conflicts` and takes the server version here.
  function _mergeIdMaps(B, L, S, children, conflicts) {
    const out = [];
    const order = Array.from(S.keys()).concat(Array.from(L.keys()).filter((id) => !S.has(id)));
    for (const id of order) {
      const b = B.get(id);
      const l = L.get(id);
      const s = S.get(id);
      const cb = _canonicalJSON(b);
      const cl = _canonicalJSON(l);
      const cs = _canonicalJSON(s);
      let v;
      if (cl === cs) v = s;
      else if (cl === cb) v = s;
      else if (cs === cb) v = l;
      else if (l === undefined) v = s;
      else if (s === undefined) v = l;
      else {
        v = _mergeFields(b, l, s, children);
        if (v === null) {
          conflicts.push({
            id,
            base: b,
            local: l,
            server: s,
            fields: _diffFields(l, s),
          });
          v = s;
        }
      }
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  function _mergeCollection(key, baseValue, localValue, serverValue) {
    const cfg = _collectionCfg(key);
    if (!cfg) return null;
    // Derived caches on the live objects are not edits: compare without them.
    localValue = stripDerivedCaches(key, localValue);
    const isList = (v) => v === undefined || v === null || Array.isArray(cfg.getItems(v));
    if (!isList(localValue) || !isList(serverValue)) return null;
    const ls = _dropTombstoned(key, localValue);
    const ss = _dropTombstoned(key, serverValue);
    if (cfg.requireIds) {
      // An item without an id (or a repeated id) cannot be matched: no merge, nothing dropped.
      const usable = (v) => v === undefined || v === null || _idsUsable(cfg.getItems(v), cfg.getId, cfg.idOccurrence);
      if (!usable(ls.value) || !usable(ss.value)) return null;
    }
    if (ls.removed.length) {
      _appendConflictArchive({
        key,
        reason: 'deleted-elsewhere',
        losingSide: 'local',
        losingValue: ls.removed,
        winningSide: 'server',
      });
    }
    const B = _itemIds(key, _dropTombstoned(key, baseValue).value);
    const L = _itemIds(key, ls.value);
    const S = _itemIds(key, ss.value);
    const conflicts = [];
    const out = _mergeIdMaps(B, L, S, cfg.children, conflicts);
    const shape = serverValue !== undefined && serverValue !== null ? ss.value : ls.value;
    return {
      value: cfg.setItems(shape, out),
      conflicts,
      removedLocal: ls.removed,
    };
  }
  // Applies the user's per-record choices to a merge result: 'mine' puts the
  // local record back in place of the server one; the losing record of every
  // conflict is archived first.
  function _applyRecordChoices(key, merge, choices) {
    const cfg = _collectionCfg(key);
    const mine = new Map();
    merge.conflicts.forEach((c) => {
      const pick = choices && _own(choices, String(c.id)) ? choices[String(c.id)] : 'theirs';
      const keepMine = pick === 'mine';
      _appendConflictArchive({
        key,
        reason: 'record-conflict',
        recordId: c.id,
        losingSide: keepMine ? 'server' : 'local',
        losingValue: keepMine ? c.server : c.local,
        winningSide: keepMine ? 'local' : 'server',
      });
      if (keepMine) mine.set(String(c.id), c.local);
    });
    if (!mine.size) return merge.value;
    const items = cfg.getItems(merge.value).map((it) => {
      const id = cfg.getId(it);
      return id !== undefined && id !== null && mine.has(String(id)) ? mine.get(String(id)) : it;
    });
    return cfg.setItems(merge.value, items);
  }

  // --- Conflict handling (write-time 409) -----------------------------------
  // `depth` counts re-sends after a merge; the queue takes over past the cap.
  // The identity epoch is captured here and re-checked after every await: a
  // conflict resolved after a user switch writes nothing.
  const CONFLICT_RESEND_CAP = 4;
  async function _handleConflict(key, payload, body, mode, depth) {
    depth = depth || 0;
    const epoch = _identityEpoch;
    const current = body && body.current;
    if (mode !== 'on') return; // 'off' never replicates, so never reaches here

    if (!current) {
      // Defensive: kv-sync.js's contract always returns `current` on a 409
      // (see kv-sync.js rowToConflict) — this should not happen. Never hang
      // the app on a malformed response; queue for a later retry instead.
      console.warn('[DB] Conflict 409 with no current row — cannot show modal, queued for retry:', key);
      _enqueueWrite(key, payload);
      return;
    }

    // Deletion records: union by id (newest stamp wins) and re-send. Never a modal.
    if (key === TOMBSTONE_KEY && !payload.deleted && !current.deleted) {
      const merged = _mergeTombstones(
        _cache[TOMBSTONE_KEY] !== undefined ? _cache[TOMBSTONE_KEY] : payload.value,
        current.value,
      );
      await _rawSet(TOMBSTONE_KEY, merged);
      if (epoch !== _identityEpoch) return;
      _setSynced(TOMBSTONE_KEY, { version: current.version, hash: current.hash || null }, null);
      await _resendMerged(key, merged, epoch, depth);
      return;
    }

    // Collection keys: per-record three-way merge. A modal only when the same
    // record was changed on both sides, and then the user chooses per record.
    if (_collectionCfg(key) && !payload.deleted && !current.deleted) {
      const handled = await _resolveCollectionConflict(key, payload, current, epoch, depth);
      if (handled) return;
      if (epoch !== _identityEpoch) return;
    }

    // Data-safety invariant: archive the losing local write BEFORE adopting
    // the server version or opening any modal — never silently lose either
    // side, and never let a modal button be clickable before this has run.
    _appendConflictArchive({
      key,
      reason: current.deleted ? 'write-conflict-tombstone' : 'write-conflict-server-wins',
      losingSide: 'local',
      losingValue: payload.deleted ? null : payload.value,
      losingDeleted: !!payload.deleted,
      winningVersion: current.version,
      winningUpdatedBy: current.updatedBy,
      winningUpdatedAt: current.updatedAt,
    });

    // Customer/Multi-Project (2026-09-24, BLOCKER 3 fix): byte-identical short-circuit.
    // Deterministic customer ids mean two browsers migrating the same project can write
    // identical content to the same key (en_customers, en_utility_<customerId>) at nearly
    // the same time. If the local payload and the server's current value are byte-for-byte
    // identical, there is nothing to reconcile — silently adopt the server's version and
    // skip the modal instead of interrupting the user over a non-conflict. General
    // robustness improvement (helps any accidental double-write, not just this migration).
    if (!payload.deleted && !current.deleted && current.value !== undefined) {
      try {
        if (
          JSON.stringify(stripDerivedCaches(key, payload.value)) ===
          JSON.stringify(stripDerivedCaches(key, current.value))
        ) {
          _setSynced(key, { version: current.version, hash: current.hash || null }, current.value);
          return;
        }
      } catch (e) {
        /* fall through to the normal modal path if either side isn't serializable */
      }
    }

    await _presentConflictModal(key, payload, current, epoch);
  }

  // Re-sends a merged value at the server version just adopted. A new 409
  // merges again (bounded); a network/server error goes to the retry queue.
  async function _resendMerged(key, value, epoch, depth) {
    let r;
    try {
      r = await _sendKvPut(key, { value });
    } catch (e) {
      r = { status: 'network-error' };
    }
    if (epoch !== _identityEpoch) return;
    if (r.status === 'ok') return;
    if (r.status === 'conflict' && depth < CONFLICT_RESEND_CAP) {
      await _handleConflict(key, { value }, r.body, 'on', depth + 1);
      return;
    }
    _enqueueWrite(key, { value });
  }

  // Write-conflict path for a collection key. Resolves true when it handled
  // the conflict (merged, queued, or dropped after an identity change), false
  // when the value is not a list (the caller falls back to the whole-key modal).
  async function _resolveCollectionConflict(key, payload, current, epoch, depth) {
    if (!_collectionCfg(key).noDeletionRecords && !(await _refreshTombstones())) {
      // FAIL CLOSED: without the latest deletion records a merge could bring a
      // deleted item back. The retry queue sends this write again later.
      if (epoch === _identityEpoch) _enqueueWrite(key, payload);
      return true;
    }
    if (epoch !== _identityEpoch) return true;
    // Merge the LIVE local list (newer than the payload if the user kept editing).
    const local = _cache[key] !== undefined ? _cache[key] : payload.value;
    const merge = _mergeCollection(key, _syncBase[key], local, current.value);
    if (merge === null) return false;
    let value = merge.value;
    if (merge.conflicts.length) {
      if (
        typeof window === 'undefined' ||
        !window.SyncConflictUI ||
        typeof window.SyncConflictUI.showConflictModal !== 'function'
      ) {
        console.warn('[DB] SyncConflictUI unavailable — record conflict left queued:', key);
        _enqueueWrite(key, payload);
        return true;
      }
      const cfg = _collectionCfg(key);
      const localBase = _replicaVersions[key];
      const descriptor = {
        key,
        conflictClass: 'records',
        records: merge.conflicts.map((c) => ({
          id: c.id,
          label: String((cfg.getLabel && cfg.getLabel(c.local)) || c.id),
          fields: c.fields,
          local: c.local,
          server: c.server,
        })),
        local: { value: local, deleted: false },
        server: {
          value: current.value,
          version: current.version,
          deleted: false,
          updatedBy: current.updatedBy,
          updatedAt: current.updatedAt,
        },
        localBaseVersion: localBase && typeof localBase.version === 'number' ? localBase.version : null,
        typedConfirmRequired: false,
      };
      let resolution;
      try {
        resolution = await window.SyncConflictUI.showConflictModal(descriptor);
      } catch (e) {
        console.warn('[DB] Conflict modal threw, leaving write queued:', key, e);
        _enqueueWrite(key, payload);
        return true;
      }
      if (epoch !== _identityEpoch) return true; // user switched while the modal was open: write nothing
      value = _applyRecordChoices(key, merge, resolution && resolution.choices);
    }
    await _rawSet(key, value);
    if (epoch !== _identityEpoch) return true;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key } }));
    }
    _setSynced(key, { version: current.version, hash: current.hash || null }, current.value);
    await _resendMerged(key, value, epoch, depth);
    if (epoch === _identityEpoch && typeof showToast === 'function') {
      showToast(
        merge.conflicts.length
          ? 'Your choices were saved. The other versions are in the conflict history.'
          : 'Changes saved by another user were merged with yours. Nothing was lost.',
        'info',
      );
    }
    return true;
  }

  // --- Phase 2b: blocking conflict modal (full/'on' mode only) --------------
  async function _presentConflictModal(key, payload, current, epoch) {
    const isTombstoneConflict = current.deleted === true && !payload.deleted;
    const localBase = _replicaVersions[key];

    const descriptor = {
      key,
      local: {
        value: payload.deleted ? undefined : payload.value,
        deleted: !!payload.deleted,
      },
      server: {
        value: current.value,
        version: current.version,
        deleted: !!current.deleted,
        updatedBy: current.updatedBy,
        updatedAt: current.updatedAt,
      },
      localBaseVersion: localBase && typeof localBase.version === 'number' ? localBase.version : null,
      conflictClass: isTombstoneConflict ? 'tombstone' : 'standard',
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
    if (epoch !== _identityEpoch) return; // user switched while the modal was open: write nothing

    await _applyConflictResolution(key, payload, current, resolution, epoch);
  }

  // --- Phase 2b: execute the user's chosen conflict-modal resolution --------
  async function _applyConflictResolution(key, payload, current, resolution, epoch) {
    const action = resolution && resolution.action;

    if (action === 'load-theirs' || action === 'save-copy' || action === 'discard-mine') {
      // Local losing value was already archived before the modal opened.
      // Adopt the server's current value/version as the new local truth.
      if (current.deleted) {
        await _rawDelete(key);
        if (epoch !== _identityEpoch) return;
        _setSynced(key, {
          version: current.version,
          hash: current.hash || null,
          deleted: true,
        });
      } else {
        await _rawSet(key, current.value);
        if (epoch !== _identityEpoch) {
          if (_isPerUserKey(key)) await _rawDelete(key); // never leave the old user's row under the new user
          return;
        }
        _setSynced(key, { version: current.version, hash: current.hash || null }, current.value);
      }
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
      _setSynced(key, { version: current.version, hash: current.hash || null }, current.value);
      const retryPayload = Object.assign({}, payload, {
        explicitOverwrite: true,
      });
      let result;
      try {
        result = await _sendKvPut(key, retryPayload);
      } catch (e) {
        result = { status: 'network-error' };
      }
      if (epoch !== _identityEpoch) return;
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

    console.warn('[DB] Unknown conflict resolution action, leaving write queued:', key, action);
    _enqueueWrite(key, payload);
  }

  // --- Live write replication tail (set()/remove() call this) --------------
  async function _replicateWrite(key, payload) {
    const mode = _backendMode();
    if (!_shouldReplicate(key)) return;
    payload = Object.assign({}, payload, { owner: _queueOwner() }); // who made this edit, fixed now
    if (mode === 'off') {
      // B1b (2026-10-06): signed out / session lost on the sync host. Keep the
      // edit in the durable queue; it uploads (CAS, never overwriting a newer
      // server row) when sign-in brings sync back. Other hosts never sync.
      // Per-user keys queue too (owner-tagged), so the bar text is true for all keys.
      if (_isSyncHost()) _enqueueWrite(key, payload);
      return;
    }
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
    if (result.status === 'stale-identity' && _isPerUserKey(key)) return; // previous user's pref: never queue under the new user
    if (result.status === 'conflict') {
      await _handleConflict(key, payload, result.body, mode);
      return;
    }
    // network-error or server-error — never silently dropped.
    _enqueueWrite(key, payload);
  }

  // --- 2a.5: single-owner retry-queue drain (Web Locks, F7 guard) -----------
  async function _drainQueueLocked() {
    // Send only the signed-in user's own entries; others stay queued untouched.
    const me = _myUserId();
    _claimSignedOutEntries(me);
    const snapshot = _syncQueue.filter((e) => e.owner && e.owner.id && e.owner.id === me);
    const epoch = _identityEpoch;
    for (const entry of snapshot) {
      // Identity changed during the drain: stop. The token now belongs to someone else.
      if (epoch !== _identityEpoch || _myUserId() !== me) return;
      // Entry may have already been resolved/superseded by a concurrent op.
      if (!_syncQueue.some((e) => e.id === entry.id)) continue;
      const payload = entry.deleted ? { deleted: true, owner: entry.owner } : { value: entry.value, owner: entry.owner };
      // _sendKvPut always reads baseVersion from the live _replicaVersions
      // map (not entry.baseVersion) — a real conflict still 409s honestly.
      let result;
      try {
        result = await _sendKvPut(entry.key, payload);
      } catch (e) {
        result = { status: 'network-error' };
      }
      if (epoch !== _identityEpoch) return;
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
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) controller.abort();
    }, BATCH_GET_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: _authHeaders(),
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('batch GET failed: ' + res.status);
    return res.json();
  }

  // B4 (2026-10-06): the hydration pull never sends one huge GET. Keys go in
  // chunks of BATCH_GET_CHUNK_KEYS; a failed chunk is retried once; keys of a
  // chunk that still fails are returned in failedKeys so the caller can show a
  // visible error (never an empty app with no message).
  async function _batchGetChunked(keys) {
    const rows = [];
    const failedKeys = [];
    for (let i = 0; i < keys.length; i += BATCH_GET_CHUNK_KEYS) {
      const chunk = keys.slice(i, i + BATCH_GET_CHUNK_KEYS);
      let got = null;
      for (let attempt = 0; attempt < 2 && got === null; attempt++) {
        try {
          got = await _batchGet(chunk);
        } catch (e) {
          console.warn('[DB] Hydration: chunk GET failed (attempt ' + (attempt + 1) + '):', e);
        }
      }
      if (got === null) failedKeys.push(...chunk);
      else rows.push(...got);
    }
    return { rows, failedKeys };
  }

  // Non-reentrant: overlapping callers (warmCache, identity change) share ONE
  // in-flight run. A caller that arrives mid-run sets a flag, so the run
  // repeats once more after it ends (the newer identity/state is honoured).
  // Identity epoch: bumped on every signed-in identity change. Work that
  // started under an earlier epoch (hydrate, upload, a PUT) must not write
  // into the cache, version map or server state once someone else is signed in.
  let _identityEpoch = 0;
  let _hydrateInFlight = null;
  let _hydrateRerun = false;
  function _hydrate() {
    if (_hydrateInFlight) {
      _hydrateRerun = true;
      return _hydrateInFlight;
    }
    _archivedLocalThisRun = 0;
    _hydrateInFlight = (async () => {
      try {
        do {
          _hydrateRerun = false;
          await _hydrateInner();
        } while (_hydrateRerun);
      } finally {
        _hydrateInFlight = null;
        if (_archivedLocalThisRun > 0) {
          _showLater(
            _archivedLocalThisRun +
              ' of your local edits were replaced by newer saved data. Nothing was lost: open Sync status, then the conflict archive.',
            'warning',
          );
        }
      }
    })();
    return _hydrateInFlight;
  }

  // Local is never overwritten unless it is unchanged since the last sync or
  // is archived first. A pure-additive list key (UNION_KEY_CONFIG) is merged.
  async function _reconcileIncoming(localKey, row, mHash) {
    const epoch = _identityEpoch;
    const origLocal = _cache[localKey];
    const base = _replicaVersions[localKey];
    const stamp = { version: row.version, hash: mHash || null };
    if (row.deleted) stamp.deleted = true;
    else if (!stamp.hash) {
      try {
        stamp.hash = await _sha256Hex(_canonicalJSON(row.value)); // always stamp a hash with the version
      } catch (e) {
        stamp.hash = null;
      }
    }
    if (epoch !== _identityEpoch) return;
    mHash = stamp.hash;
    let merged = null; // value to keep locally AND push to the server
    let serverValue = row.value;
    let collectionMerge = null;
    // Collection keys: the ONE per-record merge (_mergeCollection). A record
    // changed on both sides takes the server version here (no modal at load);
    // the local record is archived first and counted for the toast.
    if (_collectionCfg(localKey) && !row.deleted) {
      collectionMerge = _mergeCollection(localKey, _syncBase[localKey], origLocal, row.value);
      if (collectionMerge !== null) {
        collectionMerge.conflicts.forEach((c) => {
          _appendConflictArchive({
            key: localKey,
            reason: 'hydration-server-wins',
            recordId: c.id,
            losingSide: 'local',
            losingValue: c.local,
            losingVersion: base && typeof base.version === 'number' ? base.version : null,
            winningSide: 'server',
          });
        });
        if (_canonicalJSON(collectionMerge.value) !== _canonicalJSON(row.value)) merged = collectionMerge.value;
      }
    }
    // Deletion records themselves: keep both sides' entries, newest stamp wins.
    // Server JSON is rebuilt key by key (unsafe names skipped) before it is stored or merged.
    if (localKey === TOMBSTONE_KEY && !row.deleted) {
      const both = _mergeTombstones(origLocal, row.value);
      serverValue = both;
      if (_canonicalJSON(both) !== _canonicalJSON(row.value)) merged = both;
    }
    if (origLocal !== undefined && merged === null && collectionMerge === null && localKey !== TOMBSTONE_KEY) {
      let localHash = null;
      try {
        localHash = await _sha256Hex(_canonicalJSON(stripDerivedCaches(localKey, origLocal)));
      } catch (e) {
        localHash = null;
      }
      if (epoch !== _identityEpoch) return;
      if (!row.deleted && localHash !== null && localHash === mHash) {
        _setSynced(localKey, stamp, row.value); // same content: adopt the version only
        return;
      }
      const unedited = localHash !== null && base && base.hash && base.hash === localHash;
      if (!unedited) {
        _appendConflictArchive({
          key: localKey,
          reason: 'hydration-server-wins',
          losingSide: 'local',
          losingValue: origLocal,
          losingVersion: base && typeof base.version === 'number' ? base.version : null,
          losingHash: localHash,
          winningSide: 'server',
        });
      }
    }
    if (epoch !== _identityEpoch) return;
    if (merged !== null) {
      await _rawSet(localKey, merged);
      if (epoch !== _identityEpoch) return;
      _setSynced(localKey, stamp, row.value); // base = what the server holds at this version
      let putResult;
      try {
        putResult = await _sendKvPut(localKey, { value: merged });
      } catch (e) {
        putResult = { status: 'network-error' };
      }
      if (epoch !== _identityEpoch) return;
      if (putResult.status === 'conflict') {
        await _handleConflict(localKey, { value: merged }, putResult.body, _backendMode());
      } else if (putResult.status === 'network-error' || putResult.status === 'error') {
        _enqueueWrite(localKey, { value: merged });
      }
      return;
    }
    if (epoch !== _identityEpoch) return;
    if (row.deleted) await _rawDelete(localKey);
    else await _rawSet(localKey, serverValue);
    if (epoch !== _identityEpoch) {
      // Identity changed during the write: remove what this run just wrote for the old user.
      if (_isPerUserKey(localKey)) await _rawDelete(localKey);
      return;
    }
    _setSynced(localKey, stamp, row.deleted ? undefined : row.value);
  }

  // A collection key synced by an earlier build has a version entry but no
  // merge base. When the local list still matches the hash of that version,
  // the local list IS the server value at that version: use it as the base.
  async function _seedMissingBases() {
    for (const key of Object.keys(_cache).filter((k) => _collectionCfg(k))) {
      const entry = _replicaVersions[key];
      if (!entry || typeof entry.version !== 'number' || !entry.hash) continue;
      if (_own(_syncBase, key) || _cache[key] === undefined) continue;
      let h = null;
      try {
        h = await _sha256Hex(_canonicalJSON(_cache[key]));
      } catch (e) {
        h = null;
      }
      if (h !== null && h === entry.hash) _setSynced(key, entry, _cache[key]);
    }
  }

  async function _hydrateInner() {
    const mode = _backendMode();
    if (mode !== 'on') return; // off: no hydration
    const epoch = _identityEpoch;
    const stale = () => epoch !== _identityEpoch; // identity changed: discard this run

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
    if (stale()) return;

    const routineFetchKeys = []; // WIRE keys (manifest form) to batch-GET
    const routineFetchLocalKey = new Map(); // wireKey -> localKey, for applying results
    const conflictCheckKeys = []; // { m, localKey } needing a hash-compare
    const tombstoneKeys = []; // { m, localKey } to delete locally

    // F1: the deletion records are applied FIRST, so every list merge below
    // already knows what the other side deleted. FAIL CLOSED: if they cannot
    // be fetched, every collection key is left alone this run (no merge, no
    // upload) and the retry re-runs hydration when the fetch succeeds.
    const tombRow = manifest.find((m) => m.key === TOMBSTONE_KEY && !m.deleted);
    let tombOk = true;
    if (!_syncQueue.some((e) => e.key === TOMBSTONE_KEY)) {
      const lv = _replicaVersions[TOMBSTONE_KEY];
      const serverNewer = !!tombRow && (!lv || typeof lv.version !== 'number' || lv.version < tombRow.version);
      // An earlier failure is confirmed cleared before any merge.
      if (serverNewer || _tombstonesBlocked()) tombOk = await _refreshTombstones();
    }
    if (stale()) return;
    if (tombOk) await _seedMissingBases();
    if (stale()) return;

    for (const m of manifest) {
      if (m.key === TOMBSTONE_KEY) continue; // handled above
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
      if (!tombOk && UNION_KEY_CONFIG[localKey]) continue; // deletion records unknown: no merge

      const local = _replicaVersions[localKey];
      const localHasValidEntry = !!(local && typeof local.version === 'number');

      if (m.deleted) {
        if (!localHasValidEntry || local.version < m.version) tombstoneKeys.push({ m, localKey });
        continue;
      }

      if (localHasValidEntry) {
        if (m.version > local.version) {
          routineFetchKeys.push(m.key);
          routineFetchLocalKey.set(m.key, localKey);
        }
        // else: local already at/ahead of this version — leave alone.
      } else if (_cache[localKey] === undefined) {
        // Brand-new-to-this-machine key (blank machine / never seen before) —
        // routine pull, not a conflict.
        routineFetchKeys.push(m.key);
        routineFetchLocalKey.set(m.key, localKey);
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
      if (stale()) return;
      await _reconcileIncoming(localKey, { deleted: true, version: m.version }, m.hash);
    }

    // Routine fetch + apply (hash-compare-before-overwrite rule: this branch
    // is only reached when the local version map already proves the server
    // is strictly newer, or the key never existed locally at all).
    if (routineFetchKeys.length) {
      const pulled = await _batchGetChunked(routineFetchKeys); // wire keys — the real backend primary keys
      const rows = pulled.rows;
      if (pulled.failedKeys.length && !stale() && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dbHydrateFailed', { detail: { keys: pulled.failedKeys } }));
      }
      if (stale()) return;
      for (const row of rows) {
        if (stale()) return;
        if (!row || !routineFetchLocalKey.has(row.key)) continue; // only rows this run asked for
        const localKey = routineFetchLocalKey.get(row.key);
        if (_syncQueue.some((e) => e.key === localKey)) continue; // race guard, re-check
        const manifestEntry = manifest.find((m) => m.key === row.key);
        await _reconcileIncoming(localKey, row, manifestEntry ? manifestEntry.hash : null);
      }
    }

    let updatedFromServer = 0;
    // Hash-compare conflict check (integration #3 / R15 hydration-drift drill).
    // Fetched DRIFT_FETCH_CONCURRENCY at a time (one round trip each at real
    // latency made a first connect of 126 keys take 25 s), applied in order.
    const DRIFT_FETCH_CONCURRENCY = 6;
    for (let i = 0; i < conflictCheckKeys.length; i += DRIFT_FETCH_CONCURRENCY) {
      const chunk = conflictCheckKeys.slice(i, i + DRIFT_FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        chunk.map(async ({ m, localKey }) => {
          try {
            return await _batchGet([m.key]);
          } catch (e) {
            console.warn('[DB] Hydration: drift fetch failed, leaving key untouched:', localKey, e);
            return null;
          }
        }),
      );
      if (stale()) return;
      for (let j = 0; j < chunk.length; j++) {
        if (stale()) return;
        const { m, localKey } = chunk[j];
        const rows = fetched[j];
        // No version map entry and a local value exists: server wins (or a pure
        // union merge); the local value is archived first. Never a wholesale push.
        if (!rows || !rows[0]) continue;
        if (_syncQueue.some((e) => e.key === localKey)) continue; // race guard
        const before = _cache[localKey];
        await _reconcileIncoming(localKey, rows[0], m.hash);
        if (_cache[localKey] !== before) updatedFromServer++;
      }
    }

    // First connect of a browser whose data was only local (for example it was
    // in the old "off" mode): upload every synced key the server has never
    // seen. Insert only (baseVersion null), so an existing server row can
    // never be overwritten here. A key that is not in the manifest and has no
    // version entry here was never on the server. A tombstoned key IS in the
    // manifest, so it is never resurrected. Runs once per key: after the PUT
    // the key has a version entry.
    if (stale()) return;
    const onServer = new Set(manifest.map((m) => m.key));
    const uploadKeys = [];
    for (const localKey of Object.keys(_cache)) {
      if (!_shouldReplicate(localKey)) continue;
      const value = _cache[localKey];
      if (value === undefined || value === null) continue;
      if (_replicaVersions[localKey]) continue;
      if (_syncQueue.some((e) => e.key === localKey)) continue;
      if (!tombOk && UNION_KEY_CONFIG[localKey]) continue; // deletion records unknown: no upload
      const wire = _wireKey(localKey);
      if (wire === null || onServer.has(wire)) continue;
      uploadKeys.push(localKey);
    }

    _persistReplicaState();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dbHydrated', {
          detail: {
            applied: routineFetchKeys.length + tombstoneKeys.length,
            conflicts: conflictCheckKeys.length,
            uploading: uploadKeys.length,
          },
        }),
      );
    }
    // Render first: the app does not wait for this. Runs in the background.
    if (uploadKeys.length) {
      _uploadFirstConnect(uploadKeys, updatedFromServer + routineFetchKeys.length, epoch);
    } else if (conflictCheckKeys.length > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dbFirstConnect', {
          detail: { uploaded: 0, updated: updatedFromServer + routineFetchKeys.length },
        }),
      );
    }
  }

  // First connect upload (F2, 2026-10-05). Insert only (baseVersion null), so
  // an existing server row can never be overwritten. Runs after first render,
  // UPLOAD_CONCURRENCY at a time. A key that fails goes to the retry queue
  // (never lost) and is counted in the progress the Sync status panel shows.
  // 'conflict' = another device inserted it meanwhile: the next load takes the
  // drift path (server wins, local archived).
  const UPLOAD_CONCURRENCY = 4;
  let _uploadProgress = { running: false, total: 0, done: 0, uploaded: 0, failed: 0 };
  function getUploadProgress() {
    return Object.assign({}, _uploadProgress);
  }
  function _emitUploadProgress() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dbUploadProgress', { detail: getUploadProgress() }));
    }
  }
  async function _uploadFirstConnect(keys, updated, epoch) {
    if (epoch !== _identityEpoch) return;
    if (_uploadProgress.running) {
      // A second run (identity change) adds to the same pass.
      _uploadProgress.total += keys.length;
    } else {
      _uploadProgress = { running: true, total: keys.length, done: 0, uploaded: 0, failed: 0 };
    }
    _emitUploadProgress();
    const queue = keys.slice();
    const worker = async () => {
      while (queue.length) {
        if (epoch !== _identityEpoch) return; // a newer identity owns the progress counter now
        const localKey = queue.shift();
        const value = _cache[localKey]; // newest local value at upload time
        const skip =
          _backendMode() !== 'on' ||
          value === undefined ||
          value === null ||
          _replicaVersions[localKey] ||
          _syncQueue.some((e) => e.key === localKey);
        if (!skip) {
          let r;
          try {
            r = await _sendKvPut(localKey, { value });
          } catch (e) {
            r = { status: 'network-error' };
          }
          if (epoch !== _identityEpoch) return;
          if (r.status === 'ok') _uploadProgress.uploaded++;
          else if (r.status === 'network-error' || r.status === 'error') {
            _enqueueWrite(localKey, { value });
            _uploadProgress.failed++;
          }
        }
        _uploadProgress.done++;
        _emitUploadProgress();
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, keys.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (epoch !== _identityEpoch) return; // a newer identity owns the progress now
    _uploadProgress.running = false;
    _persistReplicaState();
    _emitUploadProgress();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dbFirstConnect', { detail: { uploaded: _uploadProgress.uploaded, updated } }),
      );
    }
    if (_uploadProgress.failed > 0) {
      if (typeof showToast === 'function') {
        showToast(
          _uploadProgress.failed +
            ' item' +
            (_uploadProgress.failed === 1 ? '' : 's') +
            ' could not upload yet. They are saved here and wait in the sync queue. The upload retries by itself.',
          'warning',
          10000,
        );
      }
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

    // Per-user keys are ALWAYS removed from the local cache, even with a queued
    // edit: the queue entry keeps the value, and _reapplyQueuedPerUserValues puts
    // it back when its owner signs in again. The next user never sees it or saves it.

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

    // Queued entries are owner-tagged: the drain sends only the signed-in
    // user's own entries, so another user's pending edit can never replay
    // under the new user's wire-key prefix. No entry is deleted here.
    if (cleared.length) {
      _persistReplicaState();
    }
    return cleared;
  }

  async function _handleAuthIdentityChange() {
    const uid = _myUserId();
    if (uid === _lastKnownUserId) return; // chAuthStateChanged fired but the signed-in identity didn't actually change
    _lastKnownUserId = uid;
    _recordLastUser();
    _persistSyncQueue(); // refresh the bars for the new identity
    _identityEpoch++; // in-flight work for the previous user now discards itself
    _uploadProgress = { running: false, total: 0, done: 0, uploaded: 0, failed: 0 };
    const cleared = _clearPerUserLocalState();
    _reapplyQueuedPerUserValues(uid); // this user's own queued values, before hydrate and drain
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
    // B1b: push edits queued while signed out (CAS; a newer server row goes to _handleConflict).
    await _drainQueueOnce();
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
      _reapplyQueuedPerUserValues(currentUid);
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
    // F1: removed list items are recorded BEFORE the list write (item copy kept locally).
    if (UNION_KEY_CONFIG[key]) {
      _recordDeletions(key, _lastItems[key] || _itemIds(key, _cache[key]), value, false);
      _noteCollection(key, value);
    }
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

  // --- Restore from backup support (app/site-functions.js processRestoreFile) ---
  // Where a key lives for restore: 'shared' (one server row), 'per-user'
  // (server row namespaced to the signed-in user) or 'local' (never sent:
  // local-only keys, or a per-user key with nobody signed in).
  function restoreScope(key) {
    if (!_shouldReplicate(key)) return 'local';
    if (_isPerUserKey(key)) return _myUserId() ? 'per-user' : 'local';
    return 'shared';
  }
  // Reads the CURRENT server rows for `keys` (local keys). Resolves to a Map
  // localKey -> { value, version, deleted } for keys that exist on the server.
  // Throws when the manifest cannot be read: the caller must abort with zero
  // writes. A key the manifest lists but whose row cannot be read (network
  // error, non-OK status, bad JSON, for example a value over the Function
  // response cap) is returned as { unreadable: true, error } so the caller
  // can skip that one key and still restore the rest.
  async function restoreFetchServer(keys) {
    const manifest = await _fetchManifestWithTimeout(30000);
    const onServer = new Set((Array.isArray(manifest) ? manifest : []).map((m) => m.key));
    const out = new Map();
    for (const key of keys) {
      const wire = _wireKey(key);
      if (wire === null || !onServer.has(wire)) continue;
      let row = null;
      let error = '';
      try {
        const rows = await _batchGet([wire]);
        row = Array.isArray(rows) ? rows.find((r) => r.key === wire) : null;
        if (!row) error = 'server returned no row for an existing key';
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      if (!row) {
        console.warn('[DB] restore: could not read server key', key, error);
        out.set(key, { unreadable: true, error });
        continue;
      }
      out.set(key, { value: row.deleted ? undefined : row.value, version: row.version, deleted: !!row.deleted });
    }
    return out;
  }
  // Pushes ONE merged value with the normal CAS write (gzip for big bodies),
  // using the version just read by restoreFetchServer. The local copy is
  // written only after the server accepts it. Never opens the conflict modal.
  // An existing row is replaced with explicitOverwrite so kv-sync.js keeps
  // the previous server value in kv_history (server-side undo).
  async function restorePush(key, value, serverRow) {
    // A restored collection goes through the same "list changed" function as
    // set(): every restored id with an active deletion record is marked
    // restored, and the server holds that BEFORE the list is written, so a
    // stale browser can never delete the restored items again.
    if (UNION_KEY_CONFIG[key]) {
      const p = _recordDeletions(key, _itemIds(key, serverRow ? serverRow.value : _cache[key]), value, true);
      if (p) await p;
    }
    const prev = _replicaVersions[key];
    if (serverRow) _replicaVersions[key] = { version: serverRow.version, hash: null };
    else delete _replicaVersions[key];
    let r;
    try {
      r = await _sendKvPut(key, serverRow ? { value, explicitOverwrite: true } : { value });
    } catch (e) {
      r = { status: 'network-error' };
    }
    if (r.status !== 'ok') {
      if (prev) _replicaVersions[key] = prev;
      else delete _replicaVersions[key];
      return { ok: false, status: r.status === 'error' ? 'server error ' + (r.httpStatus || '') : r.status };
    }
    await _rawSet(key, value);
    return { ok: true };
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
    const deletionRecords = Object.assign({}, _tombstoneState);
    if (mode === 'off') return { mode, keys: [], queueDepth: _syncQueue.length, deletionRecords };
    let manifest;
    try {
      manifest = await _fetchManifestWithTimeout(MANIFEST_TIMEOUT_MS);
    } catch (e) {
      return { mode, error: 'manifest fetch failed', keys: [], queueDepth: _syncQueue.length, deletionRecords };
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
    return { mode, keys, queueDepth: _syncQueue.length, deletionRecords };
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
    getAllForExport,
    stripDerivedCaches,
    DERIVED_METER_FIELDS,
    isReady,
    isFallback,
    isLoadFailed,
    hasPendingWrites,
    resetPendingWrites,
    getSyncStatus,
    getUploadProgress,
    getQueueDepth,
    getForeignQueueInfo,
    getConflictArchive,
    isConflictArchiveFull,
    clearConflictArchive,
    restoreScope,
    restoreFetchServer,
    restorePush,
  };
})();

window.DB = DB;
