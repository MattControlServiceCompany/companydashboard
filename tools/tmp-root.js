// tmp-root.js — the ONE place that decides where tests and tools put scratch files and browser profiles.
// The root is the env var CH_TMP_ROOT. There is no default: no fixed system folder and no OS temp folder is used.
// Set CH_TMP_ROOT to a folder inside the project temp area before you run a test (see docs/OPERATIONS.md).
const fs = require('fs');
const path = require('path');

function tmpRoot() {
  const r = process.env.CH_TMP_ROOT;
  if (!r || !String(r).trim()) {
    throw new Error('CH_TMP_ROOT is not set. Set it to a scratch folder (for example under _context/temp) before you run this. See docs/OPERATIONS.md.');
  }
  fs.mkdirSync(r, { recursive: true });
  return r;
}

// Unique empty folder inside the root: <root>/<prefix>XXXXXX.
function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

// Path inside the root (not created).
function tmpPath(...parts) {
  return path.join(tmpRoot(), ...parts);
}

// Browser profile path. CH_GATE_TAG (set by scripts/regression-gate.js) goes first in the name.
function profilePath(task, kind) {
  return tmpPath((process.env.CH_GATE_TAG ? process.env.CH_GATE_TAG + '-' : '') + task + '-' + (kind || 'profile') + '-' + Date.now() + '-' + process.pid);
}

// Delete a folder. On Windows a browser can still hold a file for a short time (EPERM/EBUSY): retry with backoff.
// Under a busy job pool the browser holds the profile longer than 10 s, so wait up to about 60 s (120 x 500 ms),
// after a short first wait that lets the browser child processes exit.
function rmTmp(p) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 120, retryDelay: 500 });
}

module.exports = { tmpRoot, mkTmpDir, tmpPath, profilePath, rmTmp };
