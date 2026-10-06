# CompanyHub Operations Reference

Facts about hosts, background jobs, timers, sign-in, and Supabase.
Line numbers are from commit 6eb7a5f9 (main, 2026-10-06).
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
| Queue drain (app/db.js:2188, const at :27) | Retries unsynced data writes | 15 s | Never (page life). Also runs on `online`. |
| Manifest poll (app/db.js:2190, const at :26) | Checks for data changes from the other user | 60 s | Never. Also runs on window `focus`. |
| PDF queue drain (app/core.js:391, const at :110) | Retries unsynced PDF writes | 15 s | Never. Also runs on `online`. |
| Tombstone retry (app/db.js:966) | Retries failed delete sync, one-shot, with back-off | Variable delay | Clears when it fires or is replaced (db.js:965). Skips if sync is off. |
| Session refresh (app/ch-auth.js:249, const at :49) | Refreshes the sign-in token if near expiry | 5 min | Never. Does not start when sync is off (ch-auth.js:246). |
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

## 7. How to keep this file current

Any commit that changes these facts must update this file in the same commit.
This includes a new or changed function, schedule, env var name, timer, host, or sign-in rule.
