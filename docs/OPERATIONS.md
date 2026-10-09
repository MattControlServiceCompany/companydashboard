# CompanyHub Operations Reference

Facts about hosts, background jobs, timers, sign-in, and Supabase.
Line numbers are from branch fix/2026-10-06-auth-identity at its head after the 2026-10-06 re-review fixes; sections 1, 2 and 5 from commit 6eb7a5f9 (main).
No secrets are in this file. Only env var NAMES are listed.

## 1. Hosts

| Host | Branch | Use |
|---|---|---|
| GitHub Pages (MattControlServiceCompany.github.io/companydashboard) | `main` | Production for routine deploys. Test host. No sync. (scripts/stamp-version.py:46-56) |
| Netlify (cscdashboard.netlify.app) | `stable` | Stable host. Only host that runs functions and sync. (app/ch-auth.js:70-73) |

- Promote to Netlify: `git push origin main:stable`.
- Cost: 15 credits for each Netlify deploy. Limit: 300 credits each month. The count resets on the 2nd.
  (Source: Netlify account rules told by Matt. Not in the code.)
- Netlify does not build on pushes to `main`. (scripts/stamp-version.py:46-52)
- Build config: no build command, publish root `.`. (netlify.toml:4-6)

## 2. Netlify functions (netlify/functions)

| Function | What it does | Trigger | Env var names |
|---|---|---|---|
| kv-sync | Shared data store. GET manifest/keys/key. PUT with version check. Keeps change history. (kv-sync.js:210-245) | HTTP `/.netlify/functions/kv-sync` (app/db.js:10). No schedule. | SUPABASE_URL, SUPABASE_SECRET_KEY, AUTHORIZED_USERS, CH_TEST_JWKS_URL (test only) (kv-sync.js:78-79,91,125) |
| pdf-sync | Stores and returns PDF files. Single or chunked PUT. (pdf-sync.js:323-342) | HTTP. No schedule. | SUPABASE_URL, SUPABASE_SECRET_KEY, AUTHORIZED_USERS, ALLOWED_ORIGIN (optional), CH_TEST_JWKS_URL (test only) (pdf-sync.js:120-121,135,155,226) |
| supabase-keepalive | One read of one row in table `kv`. Stops Supabase from pausing. Returns 200 on success, 502 on failure. (supabase-keepalive.js:1-37) | Schedule `@daily` (netlify.toml:26-27). `@daily` = 00:00 UTC = 19:00 Central (CDT, summer) or 18:00 Central (CST, winter). | SUPABASE_URL, SUPABASE_SECRET_KEY |

How to check that a function works:
- Netlify dashboard, site cscdashboard, Observability, then Functions. Open the function and read the invocation log.
- keepalive: look for the log line `[supabase-keepalive] OK: HTTP 200` once each day. A line with `FAIL` means a problem
  (supabase-keepalive.js:11,21,25,28).
- kv-sync and pdf-sync: a 401 means a bad token. A 403 means the email is not in AUTHORIZED_USERS. A 502 means a Supabase failure.
  (kv-sync.js:152,160; pdf-sync.js header)
- Netlify scheduled functions only run on the published (production) deploy.

## 3. Client timers and polls

| Timer | What it does | Interval | When it stops |
|---|---|---|---|
| Queue drain (app/db.js `_drainQueueOnce` :1779, back-off timer `_scheduleDrain` :1812, consts at :33-35) | Retries unsynced data writes through `_putWithAuth` (one refresh-and-retry on 401, see section 4). It runs on page load, on `online`, after sign-in (`chAuthStateChanged`) and after a write that failed (`_enqueueWrite`). While this user has a queued item that a retry can still send, ONE back-off timer retries: 15 s, then doubling to 5 min; a drain that sends something resets it to 15 s. | 15 s up to 5 min, only while items are queued | The timer does not exist when the queue is empty, when the only items belong to another user, or when every item failed for good (HTTP 400, 413, 422). Sends nothing while sync is off. Check: test-sync-golive-blockers.js CREDIT4-CREDIT6. |
| Remote-change check (NO timer; `_remoteCheckIfDue` app/db.js:2450 calls `_checkForRemoteChanges` :2455; listeners in `_startBackgroundSync` :2678) | Asks the server whether the other user changed data, through `CH_AUTH.withAuthRetry`. It runs on page load (`_hydrate`), when the tab becomes visible (`visibilitychange`) and when the window gains focus. It never runs while `document.hidden`, and at most once per 5 minutes (`REMOTE_CHECK_MIN_MS`) counted from the last manifest GET of any kind (`_lastManifestAt`, set in `_fetchManifestWithTimeout`). A key counts as changed by ONE rule, `_serverRowNeedsRoutinePull` (app/db.js, above `_hydrateInner`), shared with `_hydrate`: the server version is newer than the local stamp, OR the key is brand new to this browser (no stamp, nothing cached). So a key another user creates after this page loaded (for example the first task) is picked up by the next check without a reload. Changed keys are applied by `_hydrate` (merge, archive what loses), then `dbRemoteApplied` makes app/sync-ui.js reload the page when it is safe (`_safeToReload`: nobody typing, no open dialog, nothing unsent). If it is not safe, the banner shows and `_reloadWhenSafe` (app/sync-ui.js, local only, no server call) checks every 3 s and reloads once it is safe, so the change is never dropped; a user switch or sign-out (`chAuthStateChanged`) clears that timer; keys it could not apply show the "changed, refresh" banner. The check sends no PUT. Writes still find a conflict by the 409 answer. Check: test-sync-golive-blockers.js POLL1/POLL2 (the check itself) and CREDIT1-CREDIT3 (idle hidden tab = 0 calls; visible = exactly 1 manifest GET, none inside 5 min). | none (events only) | Quiet while sync is off. |
| PDF queue drain (app/core.js `_pdfDrainQueueOnce`, const at :110) | Retries unsynced PDF writes through `CH_AUTH.withAuthRetry` (`_pdfWithAuthRetry`); sends only the verified user's own entries (`DB.entryBelongsTo`). The drain stops at once when the signed-in user changes during it (`_pdfUserChanged`, checked before each entry and after each await, same rule as the db.js drain): nothing more is sent, removed or stamped for the other user. | 15 s | Never. Also runs on `online` and on sign-in (`chAuthStateChanged`). |
| Tombstone retry (app/db.js:1134) | Retries failed delete sync, one-shot, with back-off | Variable delay | Clears when it fires or is replaced (db.js:1133). Skips if sync is off. |
| Session refresh (app/ch-auth.js:366, const at :49) | Refreshes the sign-in token if near expiry | 5 min (talks to Supabase Auth only when the token is within 5 min of expiry, about once an hour) | Never. Does not start when sync is off (ch-auth.js:363). |
| Version check (NO timer; `_checkForVersionUpdate` app/report-engine.js, listeners in the page-load init just above it) | Sends a HEAD request for `site-ui.js` (`cache: 'no-store'`) and compares the ETag (or Last-Modified) with the value from this tab's first check. If it changed, it does ONE GET of `site-ui.js` to read the new version and shows an update bar with a Reload button. It never reloads the page by itself. | none (events only): on page load, and when the tab becomes visible or gets focus, at most once an hour (`_CH_VER_MIN_GAP_MS`) | Never runs while `document.hidden`. Check: test-sync-golive-blockers.js CREDIT7. |
| Clock (app/site-functions.js:34; site-ui.js:774) | Updates the clock text | 15 s | Never. |
| Bill dump (app/bill-analysis.js:12768) | Copies the open bill to localStorage for debug | 2 s | Never. |
| OCR abort poll (app/bill-analysis.js:13989) | Checks the abort flag and OCR time budget | 250 ms | `clearInterval` when OCR call ends (:14011,:14015). |
| Bill review render (app/bill-corrections-review.js:1830) | Redraws the review modal | 400 ms | Cleared on next open (:1829) and on close (:1838). |

Many short `setTimeout` calls (toasts, URL cleanup, UI yield) are one-shot. They are not listed.

### Netlify credit cost (Matt, 2026-10-07)

Netlify Free plan: Function compute is 10 credits per GB-hour, plus requests. The old 60 s manifest poll cost about 1.1
credits a day for ONE open tab, 24 hours a day, even when nobody looked at it (1440 Function calls a day; about 0.0008
credits a call, from that figure). It is removed.

- No idle calls. A tab that is hidden or left alone calls no Netlify Function: 0 calls a day. Calls come only from the user:
  page load (manifest + the changed keys), tab visible again or window focus (one manifest GET at most every 5 min), and
  each save (one PUT). A queued write that failed retries on the back-off timer only until it is sent.
- Estimate per user per day, working about 8 hours: load 1 to 10 calls, visible-tab checks 10 to 40 (maximum 96 at 5 min
  apart), saves 50 to 200 PUTs. The version check adds about 0 (HEAD requests, at most once an hour). About 100 to 300 calls, or roughly 0.1 to 0.25 credits a day. This is an estimate, not a
  measurement. Check the real number in the Netlify dashboard (Observability, Functions, kv-sync, invocations per day).
- Every remaining timer that can call a Netlify Function or Supabase:

| Timer | Calls | How often | Credits a day (estimate) |
|---|---|---|---|
| Data queue back-off (app/db.js:1812) | kv-sync PUT | Only while this user has a sendable queued item: 15 s, 30 s, 60 s ... 5 min. None when empty. Worst case (server answers 5xx all day) 288 calls | 0 normally; at most about 0.2 |
| PDF queue drain (app/core.js:423, every 15 s) | pdf-sync, only when the PDF queue holds this user's items; the function returns at once when empty (`_pdfDrainQueueOnce`) | 0 calls when empty | 0 normally |
| Session refresh (app/ch-auth.js:511, every 5 min) | Supabase Auth token endpoint (not a Netlify Function), only when the token is within 5 min of expiry | about 24 a day per open tab, hidden or not | 0 Netlify credits (Supabase) |
| Version check (no timer; app/report-engine.js `_checkForVersionUpdate`) | HEAD request for static file `site-ui.js` (headers only, a few hundred bytes, not a Function). Runs on load and on visible or focus, at most once an hour, never while hidden. One 1 MB GET only after a deploy changes the ETag | A tab left open all day: 1 to 24 HEAD requests a day, about 0.01 MB | About 0 credits a day. Before this change: up to 96 MB a day per visible tab, about 2 credits |
| supabase-keepalive (netlify.toml:27, `@daily`) | One Supabase read | 1 a day | about 0 |

## 4. Sign-in and allowlist

- Sign-in screen: index.html. It calls `CH_AUTH.signIn(email, password)` (app/ch-auth.js:198). Supabase Auth checks the password.
- Sync mode is `on` only on exactly cscdashboard.netlify.app and only when signed in. Every other host is `off`. (app/ch-auth.js:70-95; `_isNetlifyHost` :70, `backendMode` :82)
- Server check: every kv-sync and pdf-sync request must carry a valid Supabase token (checked against Supabase JWKS).
  The email in the token must be in env var AUTHORIZED_USERS (comma-separated list). (kv-sync.js:134-163, 125-129)
- To add or remove a user: change AUTHORIZED_USERS in Netlify site settings, then redeploy.
- Demo login is off on the sync host. The button is hidden and `loginDemo()` returns at once. (index.html:1188-1190, 1241-1243)
- Startup: app/db.js waits for the first token refresh, `CH_AUTH.ready()`, for at most 8 s (`_authReady`, db.js:2051-2059)
  before its first server request, so a stored token that already expired is never sent. A slower refresh does not block
  loading from the local copy.
- The ONE rule for a server answer of 401/403 is `CH_AUTH.withAuthRetry` (app/ch-auth.js:327; `_onServerRefusal` :297):
  401 = refresh the token once and send the same request again; a second 401, or any 403, ends the session (sync off,
  signed-out bar, every timer quiet). A refresh that comes back as a different user never retries the request. The
  remote-change check, the data queue drain, the live write and the PDF queue drain all go through it.
- A failed token refresh (app/ch-auth.js `_startRefresh`, rule `_refreshRefused`) ends the session only when Supabase
  REFUSED the refresh token: HTTP 400, 401 or 403. A network error or a 5xx (Supabase paused) keeps the session; the
  5-minute timer, or the next 401 on a request, tries again. How to check: with the network off, the signed-out bar
  must not appear; the offline banner does.
- Closing the browser signs the user out (2026-10-07; app/ch-auth.js `_store`, `_askPeers`, `_acceptPeerSession`,
  `_withRefreshLock`). The session `ch_sb_session` (access + refresh token) lives in per-tab sessionStorage, never
  localStorage. A reload keeps it. A new tab has none, so it asks the open tabs over BroadcastChannel `ch_auth` (message
  `need`; a signed-in tab answers `session`) and waits at most 400 ms (`CH_AUTH.settled()`; index.html and app/core.js wait
  for it before they choose between the app and the sign-in screen). No answer = signed out. Every sign-in, refresh and
  sign-out is broadcast (`session` / `signout`), so a sign-out in one tab signs out all tabs, and a different user
  signing in on one tab is followed by the others. Only one tab refreshes at a time (`navigator.locks`
  `ch_auth_refresh`); a tab that waited for the lock uses the session a peer already refreshed and makes no token call.
  A refused refresh first asks the peers once (400 ms) for a newer session before the tab signs out. Needs no env var.
  An old localStorage `ch_sb_session` is deleted at load and never used, so each user signs in once after this release.
  The offline queue (`ch_sync_queue`, IndexedDB), the per-user cache, `ch_last_user` and `ch_local_identity` are NOT
  touched on close: signed out = sync off, queued edits wait; the same user signing in again sends them once; a
  different user never sends them (`_entryBelongsTo`). Do not add any clear on pagehide/beforeunload. Limits: if the
  browser restores tabs on start (Chrome "Continue where you left off", Ctrl+Shift+T, Edge restore) it restores
  sessionStorage too and the user stays signed in; page code cannot stop that. The server-side refresh token stays valid
  until sign-out or revoke (Supabase Free has no inactivity limit; not checked in the dashboard); the client now keeps it
  only while a tab is open. How to check: node test-sync-golive-blockers.js ("8a:" to "8l:" tests); in DevTools
  Application, `ch_sb_session` is under Session Storage and absent from Local Storage; close all windows, open the site:
  the sign-in screen shows.
- A token refresh result belongs to the session it started from (app/ch-auth.js `_refresh`; the one check is
  `_sameStoredSession`: same user id and same refresh token in storage). The tab's session `ch_sb_session` is kept equal to
  the other tabs' by the broadcasts above. After the Supabase answer it is read again. If another tab changed it meanwhile (a different user signed
  in, or signed out) the result is dropped: nothing is saved, nothing is applied, and this tab follows the stored session
  (`chAuthStateChanged` fires, db.js bumps its identity epoch). A REFUSED refresh (400/401/403) also ends only the session
  it was for; a session another tab stored meanwhile is kept. How to check: node test-sync-golive-blockers.js, the four
  "7a:" tests (real ch-auth.js with a held token request).
- A 401 on a data write or on the queue drain: one token refresh, then the same request again (`CH_AUTH.withAuthRetry`,
  called from `_putWithAuth` in app/db.js, the one place a refused write is reported). The "server refused this sign-in"
  bar (`dbAuthRejected`) shows only when the final answer is still 401/403 and the session ended. If the refresh could not
  reach Supabase, the session is kept, the offline banner shows, and the write stays queued for the next drain.
  How to check: in DevTools Network, a PUT answered 401 is followed by a `/auth/v1/token` call and a second PUT (200);
  no red bar appears.

## 5. Supabase

- Free project. It pauses after about 7 days with no activity. (Pause window is a Supabase plan rule, not in the code.)
- A pause took the site down on 2026-10-06. (supabase-keepalive.js:3)
- Prevention: the `supabase-keepalive` function (section 2) runs each day and reads one row from table `kv`.
- If the project is paused: restore it in the Supabase dashboard, then check the keepalive log.

## 6. Sync write rules (app/db.js)

- A `DB.set` sends a PUT only when the canonical hash of the value differs from the hash stamped at the last sync
  (`_valueChanged`, one rule). Opening a pane or loading a page with no edit sends nothing.
- One PUT in flight per key (`_replicateWrite`). A write that arrives while one is in flight waits and is sent after
  the answer; the newest waiting value wins. Two PUTs for one key never overlap.
- How to check: open the browser DevTools Network tab on the sync host, filter `kv-sync`, reload the page and open the
  Building Performance and Savings Projection panes. Expected: zero PUT requests.
- Nothing is saved without a user edit: project progress is computed on read (app/core.js `projectProgress`, never
  stored on the Dashboard tab); recurring-meeting agendas and their tasks get ids from the project id and meeting date
  (app/csv-import.js `stableNumericId`), so two browsers generate one identical record; the Building Performance and
  Savings Projection panes save only from their inputs and buttons (`bpSave`, `bspSave`), never on open, and
  `getBspCfg` is the one reader of the Savings Projection settings with defaults. How to check: open a project
  Dashboard tab and both panes with the Network tab filtered on `kv-sync`: zero PUT.
  Same rule for zoom: opening the Equipment Matrix only reads `en_em_zoom` and paints it (`emApplyZoom`, app/equipment-matrix.js);
  only the zoom buttons save (`emSetZoom`). `setTableZoom` (app/site-functions.js) saves to local storage only on a click, not on a re-apply.
  Theme: `ch_theme` stays a raw local key, never sent to the server. On a user switch app/db.js `_clearPerUserLocalState(prevUid, nextUid)`
  parks it under the local key `ch_theme_user::<userId>` (never in a backup: `isNeverBackupKey` lists the prefix) and puts back the next user's own value, so A keeps Light after A->B->A and B
  does not get A's theme. How to check: node test-sync-golive-blockers.js (theme test), node test-em-zoom-no-write-on-open.js.
  Table prefs: the Cost Estimate table keeps column widths, hidden columns and a schema marker in `ch_tbl_*_pricing_tbl_<projectId>` (app/pricing-estimator.js).
  Render never writes them: `_pricingMigrateColSchema` returns when nothing is stored; `_pricingSetColWidths`/`_pricingSetHiddenCols` (user resize/hide/show only) also stamp the schema marker.
  How to check: node test-pricing-tblprefs-no-write-on-render.js (6 pass); Network tab, filter `kv-sync`, open JOCO Cost Estimate: zero PUT.
  Phase over allowance is a data notice: `console.warn` (not error) in `_pricingComputeRecommendedTimeline`.
- Version stamps are one local record per key, `ch_rv::<key>` = `{ stamp: {version, hash}, base? }` (app/db.js
  `_persistStamp`, the one writer; `_setSynced` the one stamper). A tab writes only the record of the key it synced, so a
  second tab can never overwrite the first tab's stamps (the old whole-map `ch_replica_state`/`ch_sync_base` are split once
  on the first load and removed). These records never sync and are never in a backup (the one prefix is `SyncClassification.RV_PREFIX`; `isNeverBackupKey` covers it for `siteBackup` and `RestoreMerge.isEngineKey`).
  How to check: DevTools, Application, IndexedDB, CompanyHub store: keys `ch_rv::en_projects` etc.; no `ch_replica_state`.
- Auth/session keys (`ch_sb_session`, the refresh token) are never in a backup file and a restore never writes them. The one
  list is the `neverBackup` entries of `PER_USER_CH_ENGINE_EXCLUSIONS` (app/sync-classification.js), read through
  `SyncClassification.isNeverBackupKey`. `siteBackup` (app/site-functions.js) drops them and `RestoreMerge.isEngineKey`
  (app/restore-merge.js) skips them. How to check: node test-sync-golive-blockers.js, the "(e):" test; open a new backup
  file and search for `ch_sb_session`: no match.
- Queue entries with no owner tag (saved by v2026.10.06.83 or older) are never sent (`_retireOwnerlessEntries`, runs when
  the queue loads). Each goes to Conflict history as `queue-entry-no-owner` with its value, leaves the queue, and its
  version stamp is dropped so the next load compares the local copy with the server. How to check: after one load the
  "N unsynced changes" bar is gone and Sync status, Conflict history lists the entries.
- Conflict history (`en_conflict_archive`, local only) is one list per browser. Every entry carries an owner tag
  (`_appendConflictArchive`, same shape as a queue entry). The one visibility rule is `_archiveEntryVisible`, applied by
  `DB.getConflictArchive` (the one reader: the viewer, the export button and Reset all call it): an entry for a shared
  key is shown to everyone on this browser; an entry for a per-user key (`ch_*` prefs, zoom levels) only to its owner.
  Another user's per-user entry, or one saved by a build before owner tags, stays in storage, is never shown and is never
  removed by this user (`clearConflictArchive` removes only entries the user can see). app/sync-ui.js redraws the link and
  closes the panel on `chAuthStateChanged`. How to check: node test-sync-golive-blockers.js, the "7c:" tests.
  Reset (`siteResetData`, site-functions.js) exports only the entries this user can see (`DB.getConflictArchive`), never
  another user's. The wipe KEEPS the entries this user cannot see (`DB.getConflictArchiveOthers`, written back after
  `DB.clear()`): they are neither exported nor deleted. The backup (`DB.getAllForExport`, then `siteBackup`) holds the same
  visible list only, and never `ch_sync_queue` (unsent edits may belong to another user). An old per-user queue entry with no
  owner tag is archived with NO owner (`_retireOwnerlessEntries`): shown to nobody, never sent, kept. How to check:
  node test-sync-golive-blockers.js, the "F2/F3:" and "F4:" tests.
- Identity guards on the write path (app/db.js). `_sendKvPut` is the ONE sender: if the edit's owner id is not the signed-in
  user at send time it returns `stale-identity` (no PUT, no stamp), so a value waiting behind another PUT or a hash check is
  never sent with the next user's token or key. A successful live write (`_writeOne`) removes older queued entries for the
  same key and owner, so the drain cannot replay an old value. A per-user edit whose author signs out while it is in flight (`stale-identity` in `_writeOne`, app/db.js) is queued under the AUTHOR's id (`payload.owner`), never sent as another user, and drains when that author signs in again. A live server row with no value (or null) is unreadable:
  `_reconcileIncoming` keeps the local copy and its stamp and raises `dbHydrateFailed`. `_reconcileIncoming` also returns without applying when the local value changed, or a write got queued, during its hash await: an edit made in that gap is never replaced (test REV3). A refusal (403 or second 401) in a
  tab whose cached user differs from the stored session takes over the stored session (`_onServerRefusal`), it never clears
  it. How to check: node test-sync-golive-blockers.js, the "F1:", "F5:", "F6:" and "later successful write" tests.
- Savings %: `getBspCfg` (app/utility-data.js) is the ONE reader of a building's `savingsPct` (default 11, a stored 0 stays 0).
  utility-data.js, report-engine.js and graphics-setpoints.js all call it.
- Local per-user stores on a shared browser (app/db.js). The one "a write for this key is still waiting" rule is
  `_hasQueuedWrite` (hydration skip, first-connect upload skip, `_valueChanged`): a queued entry counts for a shared key
  whoever owns it (same server row), and for a per-user key only when it is the signed-in user's own (`_entryBelongsTo`),
  so another user's queued pref never blocks this user's own row from loading. On an identity change
  (`_clearPerUserLocalState`, live or hard refresh) the per-user cache values, raw localStorage prefs, AND every per-user
  version stamp `ch_rv::<key>` (also one with no cached value) are removed; queue entries are never deleted. Merge bases
  and `ch_deleted_items` hold collection keys only (shared). `ch_last_user` holds the last user's id and email (the
  "N unsynced changes by <email>" bar reads it). How to check: node test-sync-golive-blockers.js, the "7d:" tests.
- The auth session `ch_sb_session` (access and refresh tokens, app/ch-auth.js) is classified local-only at the one place
  that decides what syncs (app/sync-classification.js `PER_USER_CH_ENGINE_EXCLUSIONS`). It never gets a wire key, is never
  uploaded by the first-connect upload, and is never removed by the identity-change sweep. It is now in sessionStorage; the rule stays so a
  localStorage copy can never sync. This matters in localStorage-fallback mode (IndexedDB unavailable), where db.js loads every localStorage key into its cache. How to
  check: node test-sync-golive-blockers.js, the "(a):" test; `SyncClassification.classifyKey('ch_sb_session')` is
  `local-only`.

- Restore mode "Make this backup the server copy" (`'backup-wins'`, app/restore-merge.js `mergeValue` and `plan`, dialog in
  app/site-functions.js `_restoreDialog`). It reuses `_restoreApply` and `DB.restorePush` (no second upload path): a key that
  is absent on the server is inserted at version 1 (`baseVersion` null); a key that differs is replaced at the server version
  just read, with `explicitOverwrite`, so kv-sync.js keeps the old copy in `kv_history` (20 per key, 30 days). A key whose
  content already equals the backup is not sent. Rules: a plain key or map takes the backup value; EVERY record collection
  key (`en_projects`, `en_customers`, `en_tasks`, `en_dc_events`, `ems_leads_v1`, the audit log, report history,
  `en_utility_cust_<id>` with its buildings, meters and bills, `en_eqmatrix_cmaps_*`) is a union by id in which the BACKUP
  record wins field by field on a matched id (Matt worked only on the GitHub site since 2026-08-19, so the backup is newer);
  records only the server holds are kept, never deleted. The one exception is `en_presented_savings` (frozen client figures):
  add-only. The old server copy of every changed key stays in `kv_history`. legacy `en_utility_<id>` keys are
  skipped; nothing is deleted; a tombstoned key stays deleted unless ticked; a per-user key goes only to the signed-in user
  (`DB.restoreScope`). A key that would still remove records (a plain key whose nested lists lose items) is HELD: listed with
  the count, unticked, not sent until the user ticks it (`opts.allowRemoval`, `item.held`). After the apply the dialog shows
  one row per key: OK with the action ("inserted as v1", "overwrote vN with vN+1, old copy kept in history"), Failed with the
  HTTP status (`DB.restorePush` returns `httpStatus`: 409 for a conflict, the server code otherwise), Skipped or Not sent with
  the reason. A second run with the same file finds server = backup and sends nothing. How to check:
  node test-restore-merge.js ("backup-wins" tests), node test-sync-golive-blockers.js ("migration R1-R3"),
  node tools/test-backend-mode-default.js (scenarios G1-G3: a synthetic backup with 5 missing keys incl. one 2.3 MB key,
  differing keys and collection keys with server-only records).
- Unstamped differing key (app/db.js `_hydrateInner` drift loop, `_driftNeedsAsk`). A key with no `ch_rv` stamp, a real local
  value and a live server row that differs used to take the server value silently (local archived). A plain key (not a
  collection key, not the deletion records) now opens the existing conflict modal through `_handleConflict`: "Overwrite with
  mine" sends the local value at the server version with `explicitOverwrite`; "Keep server" loads the server value. Nothing is
  written before the user answers; the local copy is archived first; a dismissed dialog leaves the key unstamped and it asks
  again on the next load. Same content is adopted silently. Collection keys still merge per record. A page with no conflict
  dialog keeps the old rule (server wins, local archived). How to check: node test-sync-golive-blockers.js, "migration H1-H6".
- Failures name the key. The first-connect upload keeps `{key, status, httpStatus}` for every failed key (a 409 counts as
  failed) in `DB.getUploadProgress().failures`; the toast and the Sync status panel list up to five keys as "key (HTTP 502)"
  (`DB.describeFailure`, the one text function). A queued write that keeps failing is listed by `DB.getQueueFailures()` with
  its HTTP status (400, 413 and 422 are marked permanent); the Sync status panel shows them under the queue count.
  How to check: node test-sync-golive-blockers.js, "migration U1/U2" and "migration D1".
- `en_utility_facKW_backfilled_v1` (obsolete one-shot flag) is local-only (app/sync-classification.js
  `LOCAL_ONLY_OVERRIDES`), so a first connect never uploads it.

## 6c. Go-live cutover (one time): make the Netlify site hold the GitHub-site data

Why: Matt worked only on the GitHub site since 2026-08-19. The server holds the August seed. The GitHub site never syncs.
Matt's steps, in this order:

1. On the GitHub site: Backup. Save the file. This is the fresh backup. Do not edit data on the GitHub site after this.
2. Open the Netlify site (cscdashboard.netlify.app). Sign in as yourself first. Do not sign in as another user first.
   Per-user settings go to the signed-in user.
3. If a "conflict" window opens on load for a setting, read it. "Keep server" keeps the server value. "Overwrite with mine"
   sends this browser's value. The old value is kept in the server history either way.
4. Open Restore. Choose the backup file from step 1.
5. Choose "Make this backup the server copy". Read the table. Read the list "would remove records that the backup does not
   have". Leave those items unticked. Tick one only after you compare it.
6. Click Restore. A safety copy of the current server values downloads first. Keep that file.
7. Read the result list. Every row must say OK or Skipped. A Failed row shows the key name and the HTTP status. Send that
   list to the developer.
8. Click "Close and reload". Open Restore again, choose the same file and the same mode. The button must say
   "Nothing to change". If it lists items, read them.

Nothing is deleted by this restore. On a record in both, the backup value wins; a record only on the server stays. A key the backup lacks is not touched. Old server values are in `kv_history`
(kv-sync.js `snapshotHistory`). To undo one key, read its row in `kv_history` in the Supabase dashboard.

## 6b. Bill fields (merged 2026-10-06, fix/2026-10-05-hidden-fields)

- Retired stored bill fields. Bill rows no longer store copies or roll-ups next to the real fields (thermCost, kwCost,
  kwhCost, otherCost, taxCost, total*Rate, facKWCost, kwh on gas bills, fromPDF). `getBillOwnUnitRate` is removed.
  `getStoredRate(bill, type)` (computations/rates.js:155) is the ONE rate function every page calls: it computes cost over
  usage and reads the old stored rate only when the bill has no cost or no usage. `getExtractedRate(parsed, type)`
  (computations/rates.js:300) is a different value: the preview rate of a freshly extracted PDF, before the bill is saved.
  `billHasPdf` (computations/rates.js) is the one "has a PDF" answer. The Edit Bill modal round-trips no hidden inputs.
- Bill-save-fields gate (computations/bill-save-fields.gate.js). Fails when a bill-row builder in app/bill-analysis.js
  writes a key that is not a BILL_SCHEMA key (app/csv-import.js) or on the short META list, when `openBillModal` renders a
  hidden `bl-` input, or when `billHasPdf` is not the one PDF answer. How to check: node computations/bill-save-fields.gate.js
  (exit 0); node tools/test-rate-single-source.js.
- Regression gate (scripts/regression-gate.js). Run: `node scripts/regression-gate.js` (about 230 s, exit 0 = pass). It
  checks pages and numbers against the oracle, runs scripts/verify-report-reconciliation.js, and runs EVERY `tools/test-*.js`
  and repo-root `test-*.js` / `test-*.mjs` as its own child process (3 at a time, 240 s limit each; a non-zero exit is a FAIL). New test files
  are found by glob. Tests that fail or hang on main, or need the internet, are listed in `TEST_EXCLUDE` in the gate with the
  reason and show as INFO; remove an entry when the test is fixed. Playwright comes from the env var
  `CH_PLAYWRIGHT_NODE_MODULES` (default `C:/Users/Matt Miller/AI/_context/tools/playwright-runtime/node_modules`, a permanent copy of the same Playwright version so the installed Chromium matches);
  the gate passes it to child tests as NODE_PATH. No junction or npm install is needed in the primary checkout or a worktree.
  Temp-leak guard: the gate makes a run tag `ch-gate-<pid>-<start ms>` and passes it to every child test in the env var
  `CH_GATE_TAG`. `tools/launch-browser.js` (`launchBrowser(task, opts)`) puts the tag at the start of the profile folder name
  (`C:/Temp/<tag>-<task>-profile-...`) and `ctx.close()` there also deletes the profile. The gate's own work folder is `<tag>-work`.
  After the tests the gate lists `C:/Temp`: a new entry whose name starts with the tag is a FAIL and the gate deletes it. Any other
  new entry (for example a profile of another agent that ran at the same time) is shown as INFO and is never deleted and never a FAIL.
  Browser tests must use `launchBrowser`. Tests that use `os.tmpdir()` (AppData, not `C:/Temp`) are outside the guard.
- Bill CSV header matching (app/csv-import.js `ci()` inside `parseBillCsv`). One rule for every column: exact header first,
  then whole-word match. A header with a cost, id or date word is claimed only by an alias of the same class, so
  "Energy Cost" is not kWh, "Bill ID" is not cost and "Total" is not an end date. How to check:
  node tools/test-csv-header-match.js (exit 0); node tools/test-csv-partial-reimport.js.

## 6d. HTML escape (2026-10-07, branch 2026-10-07-shared-escape)

- `_escHtml(s)` (lib/formatting.js) is the ONE HTML escape. It encodes & < > " ' and turns null/undefined into an empty string.
  Every page calls it. index.html, energy-department.html and ems-leads.html load lib/formatting.js before app/sync-ui.js.
  The 20 private escapers (_esc, esc, emsEsc, baEsc, _bcrEsc, ...) are removed. Do not add a new one.
  The two Word XML escapers (_docxEscapeXml in app/docx-writer.js, _sooXmlEsc in app/soo-generator.js) write XML, not HTML, and stay.
  How to check: node tools/test-single-html-escape.js (exit 0). It fails on a private copy or a page that does not load the module.

## 6e. PDF viewer after reload (2026-10-08, branch 2026-10-08-pdf-view-after-reload)

- At extraction, `_storeExtractionPdf(b64)` (app/bill-analysis.js) keeps the source PDF ONCE in the bill PDF store with `bpaStoreBlob` (key en_pdf_shared_<hash16>, same store as attached bill PDFs). Only the key goes into sessionStorage `ch_extraction_state` (pdfKey) and `ch_queue_state` (results[].pdfKey). The base64 never goes into sessionStorage.
  Compact PDF Storage keeps these blobs: the key is already the canonical hash key. Same file = same key, so no duplicate copy.
- The extraction copy is local only: `pdfStore(id, b64, {localOnly:true})` (app/core.js) skips the server upload and records the key in localStorage `ch_pdf_local_only`. No upload at extraction, so no Netlify cost for unsaved PDFs. Any save that points a bill at that key calls `pdfEnsureUploaded(key)` (via `bpaStoreBlob` deps.ensureUploaded) and queues one upload. Normal save paths store under their own key with plain `pdfStore` (upload as before). Check: node tools/test-pdf-upload-gating.js.
- After a reload, `_reloadExtractionPdf()` loads the PDF from the key (called from initUtilityTool in app/report-engine.js). A missing PDF drops the key: values show, no View PDF button.
- `_showExtractionToolbar()` is the ONE function that shows View PDF, Raw Text, Save Debug and Side by side.
- A batch (2+ files) saves BOTH `ch_queue_state` and `ch_extraction_state`. Restore (initUtilityTool) takes the queue first; `_restoreQueueState` then drops the extraction copy. Each batch result has its own pdfKey. `ch_queue_state` queueRows keep only resultIdx, billIdx, checked, _saved, _held (renderQueueResults rebuilds bill/result), so the state is small.
  How to check: node tools/test-pdf-view-after-reload.js (exit 0). It uses the real file input, one file and a 2-file batch, and reloads twice.

## 7. How to keep this file current

Any commit that changes these facts must update this file in the same commit.
This includes a new or changed function, schedule, env var name, timer, host, or sign-in rule.

- Utility E bill reading (PDF/OCR import; no schedule, no env var). Account number: `_evgAccountsIn` / `_evgPickAccount` (app/energy-savings.js, near `_EVG_ADDR`) are the one reader used by `extractAll`, `extract`, `_acctForIdx` and `_pageOwnAccts`. They keep only the candidates of the longest digit length, so an OCR-damaged first digit (9 digits) loses to the clean 10-digit line. A candidate is one unbroken digit string (6 to 20 digits); a digit group after a space is not merged. On/Off-Peak kWh: `_decideOnOffPeakKWh` (app/bill-analysis.js, about line 1688) defers to the kWhConsumed-derived path when a leg has no readable rate line, kWhConsumed is not held, it agrees with the charge-basis total within 0.05 kWh, and exactly one leg self-verifies and also passes the strict half-cent check. How to check: `node test-kwh-corroboration.mjs` (expect all assertions pass).

## Compact PDF Storage keeps referenced PDFs (2026-10-08)
- What: `collectReferencedPdfKeys()` in app/site-functions.js scans all stored records (DB.getAll() and live utilityData) for PDF keys. `compactPdfStorage()` runs it after the remap commit. It deletes a non-canonical key only when no record uses it. If the scan throws, it deletes nothing (`scanFailed`).
- When: only when the user clicks the sidebar button "Compact PDF Storage". No timer. No env var.
- Check: run `node tools/test-compact-keeps-referenced-pdfs.js` (gate runs it). It must print 5 PASS.

## Gas supplier scanned invoices (2026-10-08, branch 2026-10-08-woodriver-sites)
- `_wreRebuildMissingCharges` (app/energy-savings.js:7652) runs inside `_parseWRESiteBlocks`, when a gas supplier invoice is read (browser, no schedule, no env var).
- A scan can cut off the right-hand $ columns. The site then has Mmbtu and Fuel but no charge. The charge is rebuilt as (Mmbtu + Fuel) x Rate. Rate = the most common Index rate on the invoice (at least 2 sites agree). The site is marked `_chargeRebuilt` on the block.
- Skipped (left to the manual-review checks): sites with Trigger or Special Weather rows, Fuel not 0.5% to 4% of Mmbtu, or Index and Sub-Total Mmbtu that disagree.
- A Sub-Total row with a lost label ("b-Total:", "E  -") is read when it is only two numbers (Mmbtu, Fuel) and the block has no Sub-Total yet.
- Check: `node tools/test-wre-scanned-sites.js` (synthetic). In the browser console the line "[WRE] Block parser" shows the site count.

## Constellation correction invoices and Baldwin metered lines (2026-10-08, branch 2026-10-08-constellation-baldwin)
- Constellation `extractAll` (app/energy-savings.js:7068): the site id window runs from the end of the last "Total Current Site Charges" line before the site to the start of the site (not the last 600 characters). A correction invoice (many "Service for" sections per site, one id header) now reads its ids and addresses. A site with no id of its own stays ID-UNREAD. Runs in the browser when a Constellation PDF is read; no schedule, no env var. Check: `node test-constellation-correction-invoice.mjs` and `node test-constellation-account-id.mjs`.
- Baldwin City `_parseMeteredLine` (app/energy-savings.js:11694): a charge comes only from the last token printed with cents (a trailing one-digit number is page noise). Usage is the token after the two reads. A row with usage but no readable charge is not dropped: it becomes a row with a null charge and `_manualReview` set. The split-column path calls the same function. Check: `node tools/test-baldwin-metered-line.js`.

## City utility page-total check (2026-10-09)

- Client A city utility bill reading (app/energy-savings.js, rule with `_extractNew`; browser, no schedule, no env var). The printed lines of one page must add up to the printed Current Bill. `_lbg_pageLineSum` is the one sum, `_lbg_pageTotalCheck` compares it (tolerance one cent, `_LBG_PAGE_TOTAL_TOLERANCE`), `_lbg_flagPageTotalMismatch` holds every bill of a page that does not add up (`_pageTotalMismatch`, `_manualReview`). A page with a held Gas line is not checked.
- `_lbg_labeledAmount` reads both page totals. The Current Bill label is fuzzy (`_LBG_CURRENT_BILL_LABEL`: "Bin", "Bil") and its loose pass stays on one line.
- Repairs, each only when the repaired value makes the page add up to the cent: a Stormwater amount that differs from the one most Stormwater lines in the same file agree on (`_lbg_peerStormCharge`, `extractAll` re-reads the page with `opts.peerStorm`); a Water Protection line whose decimal point was lost (343 for 3.43).
- A Fuel Adjustment worked out as a residual is held when the same account prints a commodity on another page of the file that this page lacks (`opts.missingSlots`, `_lbg_commoditiesByAccount`).
- A Gas charge of 0 beside real therms takes the same reconcile-or-hold path as a missing charge. A letter glued to the front of the therms figure (`usageLeadGarble`) adds a "first digit may be missing" note to the hold reason.
- Billing-detail pages: `_findDate` separator class fixed (colon then space now matches) and the July-to-December month filter removed; due and penalty dates are skipped by label instead.
- How to check: `node tools/test-lbg-page-reconcile.js` (expect ALL PASSED); `node tools/test-lbg-printed-gas-line.js`.

## Gas supplier usage checks, site alignment and per-customer site count (2026-10-09, branch 2026-10-09-wood-river)
- Where: app/energy-savings.js, gas supplier rule `extractAll`: `_parseWRESiteBlocks` (7723), `_wreRepairComponentDecimals` (8470), `_wreSubTotalConfirmed` (8490), `_wreComponentsUsage` (8510), `_wreInvoiceRates` (8526). app/bill-analysis.js: `_wreExpectedSiteCount` (counts the saved gas meters for the invoice customer; null means no hold), `_gateWRE_siteCountCheck` (935-950), `_billHasKeyField` (15645). They run in the browser when a gas supplier invoice is read. No schedule. No env var.
- Decimal repair: a component line read as a whole number of 100 or more ("6003") is divided by 100 when that makes the components fit the printed Sub-Total and the whole number does not.
- Usage recovery: when the cross-check fails, the Sub-Total usage is kept if its charge / (usage + fuel) falls inside the printed rate band (a site with no readable rate uses the rate that at least 2 other sites print). Else the usage is rebuilt from the component lines when each passes the rate check and their charges add up to the Sub-Total charge. Else it stays empty and held. Flags: `_wreComponentLineGarbled`, `_wreUsageFromComponents`, `_wreComponentDecimalRepaired`.
- A Sub-Total read as a whole number of 100 or more (no decimal point) is held unless the rate and charge confirm the repaired value (was: only above 999).
- Other OCR pass (consensus merge): rates, component lines and review flags travel with a value taken from another pass, so the same checks run on it.
- Missing "Service Address:" line: a component or Sub-Total line that arrives after the open block already has its Sub-Total opens an empty block (`_stubBlock`, no address, no account). Later sites keep their position.
- Site-count gate: expected count is read at run time from the user's saved gas meters whose account equals the invoice customer number (`_wreExpectedSiteCount`, app/bill-analysis.js). A customer with no saved meters is never held by the count.
- Check: `node tools/test-wre-engine-fixes.js` (synthetic, 35 checks). Also `node tools/test-wre-parser-regression.js`, `node tools/test-wre-scanned-sites.js`.

## Bill matching and save path (2026-10-09, branch 2026-10-09-match-save)
- Where: app/bill-analysis.js, app/core.js, app/csv-import.js. All run in the browser when a bill is read, saved, checked for duplicates or imported. No schedule. No env var.
- One match result: `findMeterMatch` (bill-analysis.js) now gives every account-number hit a `customerId` (`_stampCustomerId`). Before, an account hit had none, so `autoAssignAllSavedBills` (core.js:3863) found no building and skipped every identity-matched bill (0 of 65 assigned).
- One auto-route rule: `_isAutoRoutableMatch` (bill-analysis.js:9142) = account/meter-number hit or the unambiguous building+commodity fallback, with a real meter. `_resolveBillDestination` and `autoAssignAllSavedBills` both call it. An address-only guess stays in Saved Bills. A period already on the meter is not added twice (Auto-Assign All).
- One address score: `_scoreIdentityCandidates` (5693) scores each same-account meter against the bill service address; `_pickIdentityCandidate` (5721) uses it and returns `matchType: 'ambiguous'` when two scores are within `_IDENTITY_TIE_MARGIN` (0.03) and none is an exact match. `_identityAddressScore` reads a split ("BALL FIELDS") or singular ("BALLFIELD") site tag as the stored one (`_addrTailKeys`).
- Shared by the save path: `_chooseAmongIdentityHits` (5765) is used by `_autoCreateMeterAndSaveBill` (21176) so two meters on one account are told apart by address, not "first found". If address cannot decide it returns null and the bill stays in Saved Bills. `_meterLosesAddressContest` (5774) is used by `_checkDuplicates` (11831): a bill whose address fits a sibling meter better is not a duplicate of this meter's stored bill.
- History: `_historyBillIsSameSite` (491) and `_historyForBill` (504) keep out of a bill's history any saved bill whose meter number or service address differs. Used by `detectStatisticalOutliers` and by the verify loop.
- `_inferBillCommodity` (8841): `_saveBillToMatchedMeter` returns null (held) when a bill with no commodity label has gas, propane or kWh fields that name another commodity than the target meter.
- `_isPlausibleAddressAlias` (6479): Import Building List (`_bldgImportAliasFor`, csv-import.js:5026) adds a service address as an alias only when it is the same street or at least 0.60 alike.
- `_mergeCsvRowIntoBill` (csv-import.js:505): a CSV re-import keeps a value the user corrected by hand (`_userCorrected`); only the typed ERASE clears it.
- Check: `node tools/test-match-save-paths.js` (expect ALL PASS; synthetic).
