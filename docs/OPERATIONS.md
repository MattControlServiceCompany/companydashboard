# CompanyHub Operations Reference

Facts about hosts, background jobs, timers, sign-in, and Supabase.
Line numbers are from branch fix/2026-10-06-auth-identity (2026-10-06); sections 1, 2 and 5 from commit 6eb7a5f9 (main).
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
| Queue drain (app/db.js:2454, const at :30) | Retries unsynced data writes through `_putWithAuth` (one refresh-and-retry on 401, see section 4) | 15 s | Never (page life). Also runs on `online` and after sign-in (`chAuthStateChanged`). Sends nothing while sync is off. |
| Manifest poll (app/db.js:2456, const at :29; `_pollManifestForChanges` :2261) | Checks for data changes from the other user through `CH_AUTH.withAuthRetry` (:2265). Changed keys are applied by `_hydrate` (merge, archive what loses), then `dbRemoteApplied` (:2299) makes app/sync-ui.js reload the page when it is safe (`_safeToReload` :335-347: nobody typing, no open dialog, nothing unsent); keys it could not apply show the "changed, refresh" banner. | 60 s | Never. Also runs on window `focus`. Quiet while sync is off. |
| PDF queue drain (app/core.js `_pdfDrainQueueOnce`, const at :110) | Retries unsynced PDF writes through `CH_AUTH.withAuthRetry` (`_pdfWithAuthRetry`); sends only the verified user's own entries (`DB.entryBelongsTo`). The drain stops at once when the signed-in user changes during it (`_pdfUserChanged`, checked before each entry and after each await, same rule as the db.js drain): nothing more is sent, removed or stamped for the other user. | 15 s | Never. Also runs on `online` and on sign-in (`chAuthStateChanged`). |
| Tombstone retry (app/db.js:966) | Retries failed delete sync, one-shot, with back-off | Variable delay | Clears when it fires or is replaced (db.js:965). Skips if sync is off. |
| Session refresh (app/ch-auth.js:334, const at :49) | Refreshes the sign-in token if near expiry | 5 min | Never. Does not start when sync is off (ch-auth.js:331). |
| Version check (app/report-engine.js:12518) | Reloads page state when a new version is live | 5 min | Never. Also runs when the tab becomes visible. |
| Clock (app/site-functions.js:34; site-ui.js:774) | Updates the clock text | 15 s | Never. |
| Bill dump (app/bill-analysis.js:12768) | Copies the open bill to localStorage for debug | 2 s | Never. |
| OCR abort poll (app/bill-analysis.js:13989) | Checks the abort flag and OCR time budget | 250 ms | `clearInterval` when OCR call ends (:14011,:14015). |
| Bill review render (app/bill-corrections-review.js:1830) | Redraws the review modal | 400 ms | Cleared on next open (:1829) and on close (:1838). |

Many short `setTimeout` calls (toasts, URL cleanup, UI yield) are one-shot. They are not listed.

## 4. Sign-in and allowlist

- Sign-in screen: index.html. It calls `CH_AUTH.signIn(email, password)` (app/ch-auth.js:190). Supabase Auth checks the password.
- Sync mode is `on` only on exactly cscdashboard.netlify.app and only when signed in. Every other host is `off`. (app/ch-auth.js:60-87)
- Server check: every kv-sync and pdf-sync request must carry a valid Supabase token (checked against Supabase JWKS).
  The email in the token must be in env var AUTHORIZED_USERS (comma-separated list). (kv-sync.js:134-163, 125-129)
- To add or remove a user: change AUTHORIZED_USERS in Netlify site settings, then redeploy.
- Demo login is off on the sync host. The button is hidden and `loginDemo()` returns at once. (index.html:1188-1190, 1241-1243)
- Startup: app/db.js waits for the first token refresh, `CH_AUTH.ready()`, for at most 8 s (`_authReady`, db.js:1978-1993)
  before its first server request, so a stored token that already expired is never sent. A slower refresh does not block
  loading from the local copy.
- The ONE rule for a server answer of 401/403 is `CH_AUTH.withAuthRetry` (app/ch-auth.js:295; `_onServerRefusal` :272):
  401 = refresh the token once and send the same request again; a second 401, or any 403, ends the session (sync off,
  signed-out bar, every timer quiet). A refresh that comes back as a different user never retries the request. The
  manifest poll, the data queue drain, the live write and the PDF queue drain all go through it.
- A failed token refresh (app/ch-auth.js `_startRefresh`, rule `_refreshRefused`) ends the session only when Supabase
  REFUSED the refresh token: HTTP 400, 401 or 403. A network error or a 5xx (Supabase paused) keeps the session; the
  5-minute timer, or the next 401 on a request, tries again. How to check: with the network off, the signed-out bar
  must not appear; the offline banner does.
- A token refresh result belongs to the session it started from (app/ch-auth.js `_refresh`; the one check is
  `_sameStoredSession`: same user id and same refresh token in storage). The stored session `ch_sb_session` is shared by
  every tab. After the Supabase answer it is read again. If another tab changed it meanwhile (a different user signed
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
- Version stamps are one local record per key, `ch_rv::<key>` = `{ stamp: {version, hash}, base? }` (app/db.js
  `_persistStamp`, the one writer; `_setSynced` the one stamper). A tab writes only the record of the key it synced, so a
  second tab can never overwrite the first tab's stamps (the old whole-map `ch_replica_state`/`ch_sync_base` are split once
  on the first load and removed). These records never sync and are never in a backup (`RestoreMerge.isEngineKey`).
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
  uploaded by the first-connect upload, and is never removed by the identity-change sweep. This matters in
  localStorage-fallback mode (IndexedDB unavailable), where db.js loads every localStorage key into its cache. How to
  check: node test-sync-golive-blockers.js, the "(a):" test; `SyncClassification.classifyKey('ch_sb_session')` is
  `local-only`.

## 7. How to keep this file current

Any commit that changes these facts must update this file in the same commit.
This includes a new or changed function, schedule, env var name, timer, host, or sign-in rule.
