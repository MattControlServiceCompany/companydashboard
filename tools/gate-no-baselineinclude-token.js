#!/usr/bin/env node
// tools/gate-no-baselineinclude-token.js — grep-based gate.
//
// Customer/Multi-Project (2026-09-24 design, "BLOCKER 1 fix"): meter.baselineInclude
// no longer exists as a persisted field — it is replaced by isBaselineExcluded(pid,
// meterId)/setBaselineExcluded(pid, meterId, excluded), which store the exclusion on
// project.scope.meterExcludeIds (per-project, not per-meter, since the same meter can
// now be shared and included in one project's baseline while excluded from another's).
//
// This gate greps every .js under app/ and computations/ for the literal token
// `baselineInclude`. The token is allowlisted ONLY in:
//   - app/utility-data.js (the accessor module — reads the legacy field exactly once,
//     inside the one-time self-heal migration, to seed scope.meterExcludeIds, then the
//     field is deleted; also defines isBaselineExcluded/setBaselineExcluded, whose names
//     legitimately contain the substring "baseline"+"Excluded", not the retired token)
//   - this gate script itself
// Any other match — a read, a write, or even a comment referencing the retired field
// name — fails the gate with file:line. This makes "no code may read/write the meter's
// baselineInclude field after the migration" a checked fact, not a claim.
//
// Run:  node tools/gate-no-baselineinclude-token.js
// Exits nonzero (and prints every offending file:line) on any hit.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ALLOWLISTED_FILE = 'app/utility-data.js';
const SELF = path.relative(REPO, __filename).split(path.sep).join('/');

const SCAN_DIRS = ['app', 'computations'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);
const TOKEN_RE = /baselineInclude/g;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && /\.js$/i.test(ent.name)) out.push(full);
  }
  return out;
}

function run() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(REPO, d), files);

  const hits = [];
  for (const abs of files) {
    const relPath = path.relative(REPO, abs).split(path.sep).join('/');
    if (relPath === ALLOWLISTED_FILE || relPath === SELF) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      continue;
    }
    text.split('\n').forEach((line, idx) => {
      TOKEN_RE.lastIndex = 0;
      if (TOKEN_RE.test(line)) {
        hits.push({ file: relPath, line: idx + 1, text: line.trim().slice(0, 160) });
      }
    });
  }

  if (hits.length) {
    console.error('gate-no-baselineinclude-token: FAILED — ' + hits.length + ' violation(s) found.\n');
    for (const h of hits) console.error(h.file + ':' + h.line + '  ' + h.text);
    console.error(
      '\nmeter.baselineInclude no longer exists (BLOCKER 1 fix) — use isBaselineExcluded(pid, meterId) / ' +
        'setBaselineExcluded(pid, meterId, excluded) instead. See ' +
        'AI/_context/plans/2026-09-23-customer-multi-project-design.md, section 3, "BLOCKER 1 fix."',
    );
    process.exitCode = 1;
    return;
  }
  console.log('gate-no-baselineinclude-token: PASSED — 0 baselineInclude tokens outside the allowlist.');
}

run();
