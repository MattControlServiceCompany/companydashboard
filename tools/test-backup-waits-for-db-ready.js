// tools/test-backup-waits-for-db-ready.js — Native Backup / IndexedDB-bills race regression gate.
// Run: node tools/test-backup-waits-for-db-ready.js
//
// Backlog: 595595f9 (P1, "Native Backup export may omit IndexedDB bills", 2026-09-21).
//
// The sidebar Backup button (energy-department.html) renders and is clickable before
// DB.warmCache() resolves — .content is hidden behind .app-ready, but the sidebar is not. On the
// OLD siteBackup() (app/site-functions.js), a click during that window hit the
// `DB.isReady() ? DB.getAll() : {}` branch and silently wrote a backup with an empty IndexedDB
// section: zero bills, empty utility data, no error, no warning shown to the user. Confirmed
// against real data with a headless-Chromium measurement (2026-09-24): 1137 real bills in
// storage, 0 in the export when Backup was invoked while DB.isReady() was observed false; 1137
// once DB was ready, both from a real profile and after restoring that export into a second
// fresh profile.
//
// This test loads the REAL siteBackup()/_waitForDBReadyForBackup() (app/site-functions.js)
// verbatim into a Node vm sandbox with a SYNTHETIC fake-DB that starts "not ready" and flips
// ready after a delay (same shape as the real DB.isReady()/DB.getAll()/'dbReady' event), and
// proves:
//   1. Calling siteBackup() before DB.isReady() no longer exports an empty/partial IndexedDB
//      section — it waits for the 'dbReady' event and exports the FULL data once ready.
//   2. Calling siteBackup() when DB.isReady() is already true still exports immediately
//      (no artificial delay when there's nothing to wait for).
//
// Fails on the pre-fix siteBackup() (no _waitForDBReadyForBackup wait) because case 1's export
// captures dbData === {} at call time, before the fake DB ever becomes ready.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

// Extract one top-level function verbatim from app/site-functions.js (same brace-matching
// technique as tools/test-single-source-baseline.js's loadFn), including a leading `async`
// keyword if present so `await` inside the extracted body stays valid.
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('function ' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + fnName + ' in ' + file);
  let start = m.index;
  const before = src.slice(0, start);
  const asyncMatch = /async\s+$/.exec(before);
  if (asyncMatch) start -= asyncMatch[0].length;
  let p = src.indexOf('(', m.index);
  let pDepth = 0,
    pEnd = p;
  for (; pEnd < src.length; pEnd++) {
    if (src[pEnd] === '(') pDepth++;
    else if (src[pEnd] === ')') {
      pDepth--;
      if (pDepth === 0) break;
    }
  }
  let i = src.indexOf('{', pEnd);
  let depth = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, j + 1);
}

const SRC_FILE = REPO + '/app/site-functions.js';
const fns = [loadFn(SRC_FILE, '_waitForDBReadyForBackup'), loadFn(SRC_FILE, 'siteBackup')].join('\n\n');

// ─── Build one fresh sandbox per case: a SYNTHETIC fake-DB/localStorage/document/Blob/URL,
// matching the real DB API shape (isReady/getAll) and the real 'dbReady' window event
// siteBackup() now waits on, without touching any real browser or real data. ───────────────────
function makeSandbox(opts) {
  const events = {};
  const window = {
    addEventListener(name, fn) {
      (events[name] = events[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      if (!events[name]) return;
      events[name] = events[name].filter((f) => f !== fn);
    },
    dispatch(name) {
      (events[name] || []).slice().forEach((fn) => fn());
    },
  };
  let ready = opts.startReady;
  const SYNTHETIC_BILLS = {
    en_utility_1: { buildings: [{ id: 'b1', meters: [{ id: 'm1', bills: [{ id: 1 }, { id: 2 }, { id: 3 }] }] }] },
  };
  const DB = {
    isReady: () => ready,
    getAll: () => (ready ? Object.assign({}, SYNTHETIC_BILLS) : {}),
  };
  let capturedBlobContent = null;
  function FakeBlob(parts) {
    capturedBlobContent = parts[0];
  }
  const localStorage = { length: 0, key: () => null, getItem: () => null };
  const document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  const sandbox = {
    console,
    window,
    DB,
    localStorage,
    document,
    Blob: FakeBlob,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    setTimeout,
    clearTimeout,
    showToast: null, // typeof-guarded in siteBackup; absent is a valid real-world state too
    getCaptured: () => capturedBlobContent,
    flipReadyAndFireEvent() {
      ready = true;
      window.dispatch('dbReady');
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fns, sandbox, { filename: 'site-functions-extract.js' });
  return sandbox;
}

(async () => {
  console.log('Case 1: siteBackup() called while DB is NOT ready, becomes ready 150ms later');
  {
    const sb = makeSandbox({ startReady: false });
    const backupPromise = sb.siteBackup();
    // DB "warms up" asynchronously, same as the real DB.warmCache() -> 'dbReady' dispatch.
    setTimeout(() => sb.flipReadyAndFireEvent(), 150);
    await backupPromise;
    const content = sb.getCaptured();
    assert(typeof content === 'string' && content.length > 0, 'backup produced file content');
    const data = JSON.parse(content);
    assert(
      data.en_utility_1 && data.en_utility_1.buildings && data.en_utility_1.buildings.length === 1,
      'backup waited for DB ready and included the utility/bills data (old code exports {} here)',
    );
    const bills = (((data.en_utility_1 || {}).buildings || [])[0] || {}).meters?.[0]?.bills || [];
    assert(bills.length === 3, 'all 3 synthetic bills present in the export, got ' + bills.length);
  }

  console.log('Case 2: siteBackup() called while DB is already ready — no wait needed');
  {
    const sb = makeSandbox({ startReady: true });
    await sb.siteBackup();
    const content = sb.getCaptured();
    const data = JSON.parse(content);
    const bills = (((data.en_utility_1 || {}).buildings || [])[0] || {}).meters?.[0]?.bills || [];
    assert(bills.length === 3, 'already-ready case still exports all bills immediately, got ' + bills.length);
  }

  console.log('Case 3: siteBackup() called while DB never becomes ready — safety timeout still resolves');
  {
    const sb = makeSandbox({ startReady: false });
    // Pass a short timeout via a direct call so the test doesn't wait the real 15s default.
    const p = sb._waitForDBReadyForBackup(50);
    const start = Date.now();
    await p;
    assert(Date.now() - start < 2000, 'safety timeout resolved promptly instead of hanging forever');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
