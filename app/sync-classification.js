// app/sync-classification.js — the ONE classification map for every persisted key.
//
// Declares, for every key CompanyHub ever passes to DB.set()/DB.remove() (whether via
// the sset()/sget() wrappers in app/core.js or a direct DB.set() call), which of
// THREE buckets that key belongs to:
//   - 'synced'    — server-authoritative shared data (both users edit the same row).
//   - 'per-user'  — UI prefs/view/layout state that should follow the SIGNED-IN USER
//                   (namespaced client-side by their Entra oid — see classifyKey()).
//   - 'local-only' — never leaves this browser at all.
//
// Consumed by TWO call sites (do not fork this into two lists):
//   1. Phase 2a — the runtime `_shouldReplicate`/`isPerUser` guards inside app/db.js's
//      DB.set()/DB.remove() replication tail (app/db.js _shouldReplicate/_wireKey).
//   2. Phase 3  — migrate-seed.js's skip list when classifying keys out of a
//      siteBackup()/DB.getAll() export.
//
// Written per supabase-migration-plan-FINAL-2026-07-19.md §11 task 0.5, §1.3, §7,
// extended 2026-07-20 for the per-user-settings-sync feature (client-side key
// prefixing, no server/schema change — see app/db.js `_wireKey`).
//
// Works as a browser global (`window.SyncClassification`, matching the
// `const X = (() => {...})(); window.X = X;` pattern used by app/db.js) AND as a
// Node `require()`-able module for migrate-seed.js and test harnesses.

const SyncClassification = (() => {
  // ── Open question Q5/Q7 (plan §"Open questions", item 5) ──────────────────
  // Weather cache (en_wdd_*) defaults to LOCAL-ONLY (derived/rebuildable cache,
  // keeping it out shrinks hydration). Flip this to `true` if Matt decides the
  // weather cache should sync instead. ONE line, nothing else to touch.
  const SYNC_WEATHER_CACHE = false; // Q5/Q7 default: false = en_wdd_* stays LOCAL-ONLY

  // ── SYNCED — server-authoritative, hydrated at load, CAS on write ─────────
  // Each entry is either an exact key or a prefix (dynamic-suffix key family).
  // `prefix: true` means "key.startsWith(pattern)".
  const SYNCED = [
    {
      pattern: 'en_projects',
      prefix: false,
      note: 'array-of-project-objects, 69 write sites (core.js/calculators.js/csv-import.js/etc.)',
    },
    {
      pattern: 'en_utility_',
      prefix: true,
      note: 'per-project utility data en_utility_<pid> (utility-data.js). NOTE: does NOT match "en_utilityData" (no trailing underscore in that legacy key) — see LOCAL_ONLY_OVERRIDES.',
    },
    { pattern: 'en_pdf_bills', prefix: false, note: 'bill metadata list (bill-analysis.js), 13 write sites' },
    {
      pattern: 'en_eqmatrix_',
      prefix: true,
      note: 'equipment-matrix.js: en_eqmatrix_<pid> (data), _cols_<pid>, _cmaps_<pid>, _edits_<pid> — all 4 families share this one prefix',
    },
    {
      pattern: 'en_pricing_',
      prefix: true,
      note: 'pricing-estimator.js: catalog, config, meta, budget_<pid>, estimate_<pid>',
    },
    {
      pattern: 'en_report_history',
      prefix: true,
      note: 'TWO distinct literal forms found in the wild, both covered by this one prefix: the bare global key "en_report_history" (report-engine.js:6813/6830/6897) and the per-project "en_report_history_<projId>" (report-preview.js:555/565) — these are NOT the same key, but both are report-history data and both should sync.',
    },
    { pattern: 'en_report_templates_', prefix: true, note: 'report-engine.js: en_report_templates_<projId>' },
    { pattern: 'en_tasks', prefix: false, note: 'core.js: 3 write sites, csv-import.js: 1' },
    {
      pattern: 'en_dc_events',
      prefix: false,
      note: 'district-calendar.js — write at :144, CAS-tombstone delete at :514 per plan integration #1',
    },
    {
      pattern: 'en_bas_',
      prefix: true,
      note: 'bas-trends.js: en_bas_<pid>, en_bas_raw_<bldgKey>_<equipTag>, en_bas_faultstatus_<pid> — all 3 sub-families share this one prefix',
    },
    { pattern: 'en_alarms_', prefix: true, note: 'bas-alarms.js: en_alarms_<pid>' },
    { pattern: 'en_hours_', prefix: true, note: 'hours.js: en_hours_<pid>' },
    { pattern: 'en_budget_', prefix: true, note: 'budget.js: en_budget_<pid>' },
    { pattern: 'en_meetingTemplates', prefix: false, note: 'csv-import.js: single global key' },
    { pattern: 'sv_saData', prefix: false, note: 'service-department.html service-agreement data' },
    { pattern: 'sv_staffData', prefix: false, note: 'service-department.html staff data' },
    { pattern: 'sv_dispatchData', prefix: false, note: 'service-department.html dispatch data' },
    {
      pattern: 'ems_leads_v1',
      prefix: false,
      note: 'ems-leads.html — currently BYPASSES the sset/DB.set choke point entirely (raw localStorage, no app/db.js script tag). Classified SYNCED for when Phase 0.2 routes it through sset/db.js; the predicate below cannot make this key start replicating on its own until that routing lands.',
    },
    {
      pattern: 'en_wdd_',
      prefix: true,
      note: 'weather cache — gated by SYNC_WEATHER_CACHE toggle above, NOT unconditionally synced. See shouldReplicate().',
    },
    {
      pattern: 'en_utility_audit_log',
      prefix: false,
      note: 'AUDIT_LOG_KEY in utility-data.js — incidentally also matches the en_utility_ prefix above; listed explicitly for clarity. Audit trail of bill edits, valuable to share between users.',
    },
    {
      pattern: 'en_value_corrections',
      prefix: false,
      note: 'csv-import.js:706 — manual value-correction audit log tied to utility data edits. Same class of data as en_utility_audit_log; both users should see it.',
    },
    // ── FLAGGED, not guessed — see report for reasoning. No existing en_/ch_ prefix
    // convention covers these; classified SYNCED because their content is real
    // per-building analytical configuration (savings-projection / performance-chart
    // settings), the same class of data as en_budget_/en_pricing_. Confirm with Matt.
    {
      pattern: 'bldgsavproj_cfg_',
      prefix: true,
      note: 'FLAGGED: utility-data.js/energy-savings.js building savings-projection config, keyed by building id/name (no en_/ch_ prefix — pre-existing naming inconsistency, not fixed here). Recommend SYNCED; confirm with Matt.',
    },
    {
      pattern: 'bldgperf_cfg_',
      prefix: true,
      note: 'FLAGGED: utility-data.js/energy-savings.js building performance-chart config, keyed by building id/name (no en_/ch_ prefix — pre-existing naming inconsistency, not fixed here). Recommend SYNCED; confirm with Matt.',
    },
  ];

  // ── LOCAL-ONLY — deliberately never synced (not even per-user) ─────────────
  const LOCAL_ONLY = [
    {
      pattern: 'en_conflict_archive',
      prefix: false,
      note: 'reserved — not yet built (Phase 2b). Losing-value archive on 409, local-only by design.',
    },
    {
      pattern: '_claude_bill_dump',
      prefix: false,
      note: 'debug/dev-tooling scratch key, not user data — made explicit so it no longer hits the default-unclassified warn path.',
    },
    {
      pattern: '_debug_propane_bills',
      prefix: false,
      note: 'debug/dev-tooling scratch key, not user data — made explicit so it no longer hits the default-unclassified warn path.',
    },
  ];

  // ── CRITICAL — sync-engine-internal ch_ keys that MUST win over the ──────
  // blanket per-user ch_ rule below. These are the ENGINE'S OWN bookkeeping
  // (replica version map, offline retry queue, the on/off/shadow kill switch
  // itself) — NOT a per-user UI preference. If any of these were classified
  // 'per-user' instead of 'local-only', the engine would try to sync its own
  // queue/replica-state/kill-switch per-user, which is nonsensical and would
  // corrupt sync bookkeeping across devices/users. Checked BEFORE PER_USER in
  // classifyKey() — order matters. Enumerated by reading every ch_ entry that
  // was previously in LOCAL_ONLY/LOCAL_ONLY_OVERRIDES (this file, pre-2026-07-20)
  // plus ch_backend_mode (db.js's own mode flag, read directly via
  // localStorage — never routed through sset/DB.set today, excluded here
  // defensively in case that ever changes).
  const PER_USER_CH_ENGINE_EXCLUSIONS = [
    {
      pattern: 'ch_replica_state',
      prefix: false,
      note: 'db.js REPLICA_STATE_KEY — per-key version-map bookkeeping (write-through via _rawSet, bypasses replication entirely). Engine-internal, must never sync at all, per-user or otherwise.',
    },
    {
      pattern: 'ch_sync_queue',
      prefix: false,
      note: 'db.js SYNC_QUEUE_KEY — durable offline-write retry queue (write-through via _rawSet, bypasses replication entirely). Engine-internal, must never sync at all.',
    },
    {
      pattern: 'ch_backend_mode',
      prefix: false,
      note: 'db.js _backendMode()/setBackendMode() — the off|shadow|on kill switch itself. Read/written directly via localStorage today (never through sset/DB.set), excluded here as defense-in-depth so it can never accidentally sync per-user if that ever changes.',
    },
  ];

  // ── Explicit overrides — checked BEFORE the SYNCED prefix table above. ─────
  // These keys would otherwise incidentally match a SYNCED prefix (most of them
  // start with "en_utility_") but must not sync. Found by grepping every DB.set()/
  // DB.remove() call site directly (bypassing sset()) in addition to every sset()/
  // sget() literal — see the audit table in the implementer report for file:line.
  const LOCAL_ONLY_OVERRIDES = [
    {
      pattern: 'en_utility_dates_migrated_v1',
      prefix: false,
      note: 'utility-data.js:67 — one-time per-machine migration-completion flag (value "1"). Incidentally matches en_utility_ prefix; must NOT sync — each machine tracks its own migration state independently.',
    },
    { pattern: 'en_utility_rates_backfilled_v2', prefix: false, note: 'utility-data.js:98 — same as above.' },
    { pattern: 'en_utility_sewer_usage_backfilled_v1', prefix: false, note: 'utility-data.js:126 — same as above.' },
    { pattern: 'en_utility_therms_mmbtu_fix_v1', prefix: false, note: 'utility-data.js:221/352 — same as above.' },
    {
      pattern: 'en_sewer_backfill_report_v1',
      prefix: false,
      note: 'utility-data.js:204 — one-time diagnostic report (console.table companion), not user-facing data.',
    },
    {
      pattern: 'en_utilityData',
      prefix: false,
      note: 'utility-data.js:49/55 — LEGACY combined key. Read once, split into en_utility_<pid> keys, then DB.remove()\'d in the same call (loadUtilityData()). Does NOT match the "en_utility_" prefix (no trailing underscore: "en_utilityData"[10] is "D", not "_"). Classified local-only defensively — this key should not persist past first load.',
    },
    {
      pattern: 'en_equipment',
      prefix: false,
      note: 'core.js:177 — sget-only, ZERO sset()/DB.set() write sites found anywhere in the codebase. Dead/never-written key; classified local-only defensively (safe default for a key that should never actually exist in storage).',
    },
    {
      pattern: 'en_em_rawStatsCollapsed',
      prefix: false,
      note: 'equipment-matrix.js:3890 — UI collapse-toggle state, not eqmatrix project data. Does not match en_eqmatrix_ prefix (different word: "en_em_").',
    },
    {
      pattern: 'en_pdf_file_',
      prefix: true,
      note: "PDF blob key — routed through the SEPARATE en_pdf_store IndexedDB via pdfStore()/pdfLoad()/pdfDelete() (core.js _pdfDB), not through DB.set()/kv-sync. Handled by the future pdf-sync.js blob mechanism (plan §6), never by this kv classification. One read-only sget() fallback exists at bill-analysis.js:14449 (plan's own §3 special case, flagged for Phase 2a.8 sweep) — excluded here so a stray multi-MB base64 PDF string can never be routed through the 6MB kv-sync Function body limit.",
    },
    {
      pattern: 'en_pdf_shared_',
      prefix: true,
      note: 'Same PDF-blob-store reasoning as en_pdf_file_ above (bill-analysis.js pdfKey construction).',
    },
  ];

  // ── PER-USER — UI prefs/view/layout state that should follow the SIGNED-IN ─
  // USER across devices/browsers, namespaced client-side to their Entra oid
  // (app/ch-auth.js getUserId()) so two users never clobber each other's prefs.
  // Client-side key-prefixing only — no server/schema change (app/db.js
  // `_wireKey()` prepends `${userId}::` to the key actually sent to the
  // backend; the LOCAL _cache/_replicaVersions stay keyed by the plain name
  // below, unchanged for every other reader in the app — see plan §"Approach").
  //
  // The `ch_` blanket below previously meant "local-only" (plan §1.3, pre-
  // 2026-07-20). It is now the PER-USER default for general UI prefs (theme,
  // activeView, sidebar/tab order, table col widths, etc.) — EXCEPT the
  // sync-engine's own bookkeeping keys, which PER_USER_CH_ENGINE_EXCLUSIONS
  // (checked first in classifyKey()) keeps local-only. Order matters — do not
  // reorder classifyKey()'s checks.
  const PER_USER = [
    {
      pattern: 'ch_',
      prefix: true,
      note: 'blanket rule — general ch_* UI prefs (theme, activeView, sidebar order, table col widths, etc.) follow the signed-in user. EXCLUDES ch_replica_state/ch_sync_queue/ch_backend_mode — see PER_USER_CH_ENGINE_EXCLUSIONS, checked before this rule in classifyKey().',
    },
    {
      pattern: 'en_bills_zoom_',
      prefix: true,
      note: 'bill-analysis.js UI zoom-level state, keyed per view. Pure UI state — follows the signed-in user (moved from LOCAL_ONLY 2026-07-20).',
    },
    {
      pattern: 'en_perf_zoom',
      prefix: false,
      note: 'performance-chart UI zoom-level state. Pure UI state — follows the signed-in user (moved from LOCAL_ONLY 2026-07-20).',
    },
    {
      pattern: 'en_sv_matrix_zoom_',
      prefix: true,
      note: 'savings-matrix UI zoom-level state, keyed per view. Pure UI state — follows the signed-in user (moved from LOCAL_ONLY 2026-07-20).',
    },
    {
      pattern: 'en_em_zoom',
      prefix: false,
      note: 'equipment-matrix.js:4217 — UI zoom-level state. Follows the signed-in user (moved from LOCAL_ONLY_OVERRIDES 2026-07-20).',
    },
    {
      pattern: 'bills_view_state_',
      prefix: true,
      note: 'FLAGGED (pre-existing, see note history): utility-data.js:2685 — bills table UI view-state, keyed by meter id, no ch_/en_ prefix. Follows the signed-in user (moved from LOCAL_ONLY_OVERRIDES 2026-07-20).',
    },
    {
      pattern: 'bills_col_widths_',
      prefix: true,
      note: 'FLAGGED: utility-data.js:2844 (remove), :3520/:3593 (storageKey) — column-width UI state. Follows the signed-in user (moved from LOCAL_ONLY_OVERRIDES 2026-07-20).',
    },
    {
      pattern: 'ba_alarm_log_col_widths',
      prefix: false,
      note: 'FLAGGED: bas-alarms.js:767 (BA_COL_KEY) — column-width UI state, no en_/ch_ prefix. Follows the signed-in user (moved from LOCAL_ONLY_OVERRIDES 2026-07-20).',
    },
  ];

  /**
   * classifyKey(key) → 'synced' | 'per-user' | 'local-only'
   * The single 3-state classifier. shouldReplicate()/isPerUser() below are
   * both thin wrappers over this. Order matters:
   *   1. LOCAL_ONLY_OVERRIDES — explicit en_/en_utility_ overrides that would
   *      otherwise incidentally match a SYNCED prefix.
   *   2. PER_USER_CH_ENGINE_EXCLUSIONS — sync-engine-internal ch_ bookkeeping
   *      keys (replica state, sync queue, backend-mode kill switch). MUST be
   *      checked before the PER_USER blanket ch_ rule (step 4) or the engine
   *      would try to sync its own queue/replica-state/kill-switch per-user.
   *   3. LOCAL_ONLY — remaining explicit local-only keys (conflict archive,
   *      debug scratch).
   *   4. PER_USER — the ch_ blanket + explicit UI-state keys (zoom levels,
   *      column widths, view state).
   *   5. Weather cache — gated by the SYNC_WEATHER_CACHE toggle, not the
   *      SYNCED table.
   *   6. SYNCED table.
   *   7. Default: 'local-only'. An unrecognized key is never assumed safe to
   *      sync (in any form) — new keys must be added to this file explicitly.
   *      Logs a console.warn in the browser so an unclassified key is loud,
   *      not silent.
   */
  function classifyKey(key) {
    if (typeof key !== 'string' || !key) return 'local-only';

    for (const entry of LOCAL_ONLY_OVERRIDES) {
      if (_matches(key, entry)) return 'local-only';
    }
    for (const entry of PER_USER_CH_ENGINE_EXCLUSIONS) {
      if (_matches(key, entry)) return 'local-only';
    }
    for (const entry of LOCAL_ONLY) {
      if (_matches(key, entry)) return 'local-only';
    }
    for (const entry of PER_USER) {
      if (_matches(key, entry)) return 'per-user';
    }
    if (key.indexOf('en_wdd_') === 0) return SYNC_WEATHER_CACHE ? 'synced' : 'local-only';
    for (const entry of SYNCED) {
      if (entry.pattern === 'en_wdd_') continue; // handled above, not via the table
      if (_matches(key, entry)) return 'synced';
    }

    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SyncClassification] Unclassified key treated as LOCAL-ONLY (safe default):', key);
    }
    return 'local-only';
  }

  /**
   * shouldReplicate(key) → boolean
   * = classifyKey(key) !== 'local-only'. Kept as the existing public entry
   * point db.js/migrate-seed already call — behavior unchanged for the
   * synced/local-only split; now also true for 'per-user' keys (which DO
   * replicate, just namespaced — see app/db.js `_wireKey()`).
   */
  function shouldReplicate(key) {
    return classifyKey(key) !== 'local-only';
  }

  /** isPerUser(key) → boolean = classifyKey(key) === 'per-user'. */
  function isPerUser(key) {
    return classifyKey(key) === 'per-user';
  }

  function _matches(key, entry) {
    return entry.prefix ? key.indexOf(entry.pattern) === 0 : key === entry.pattern;
  }

  /**
   * classify(key) → 'synced' | 'local-only' — LEGACY 2-state view, kept for any
   * existing caller. Collapses 'per-user' into 'synced' (both replicate) —
   * new code that cares about the per-user distinction should call
   * classifyKey() directly, not this.
   */
  function classify(key) {
    return shouldReplicate(key) ? 'synced' : 'local-only';
  }

  return {
    SYNCED,
    LOCAL_ONLY,
    LOCAL_ONLY_OVERRIDES,
    PER_USER,
    PER_USER_CH_ENGINE_EXCLUSIONS,
    SYNC_WEATHER_CACHE,
    classifyKey,
    shouldReplicate,
    isPerUser,
    classify,
  };
})();

if (typeof window !== 'undefined') {
  window.SyncClassification = SyncClassification;
}
if (typeof module !== 'undefined') {
  module.exports = SyncClassification;
}
