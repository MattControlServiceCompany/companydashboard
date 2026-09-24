#!/usr/bin/env node
// tools/gate-single-baseload-source.js — static-source gate.
//
// The "3-lowest-month" weather-independent baseload-subtraction computation
// (computations/hvac-enduse.js, computeHvacEnduse -> _hvacLowestNAvg(arr, 3))
// has been re-implemented locally, by mistake, TWICE before this gate was
// added — fixed once in v.19 and again in v.25 (each time a caller wanted
// the baseload number and hand-rolled its own sort+slice instead of calling
// the canonical function, so a later fix to the real formula silently missed
// the duplicate copy). Per the "twice = gate" rule, this script makes that
// mistake impossible to land silently again.
//
// It statically scans every .js/.mjs/.html file in the repo (excluding the
// canonical file itself, and excluding test/gate files, which are EXPECTED
// to hand-recompute the formula independently as a verification oracle) for
// the tell-tale re-implementation shapes:
//   1. A numeric ascending sort ((a,b)=>a-b / function(a,b){return a-b})
//      chained into .slice(0, 3) — "sort low-to-high, take the first 3".
//   2. A numeric descending sort chained into .slice(-3) — the same
//      computation, mirrored ("sort high-to-low, take the last 3").
//   3. A locally-defined helper function/variable whose own name claims to
//      compute "the lowest 3/Three/N" (e.g. a differently-shaped manual
//      min-3 loop hiding behind its own name).
//
// Run:  node tools/gate-single-baseload-source.js
// Exits nonzero (and prints every offending file:line) on any hit.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const CANONICAL_FILE = 'computations/hvac-enduse.js';
const SELF = path.relative(REPO, __filename).split(path.sep).join('/');

const SCAN_EXT = new Set(['.js', '.mjs', '.html']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

// Files that are EXPECTED to independently hand-recompute the formula as a
// test oracle (per repo convention: tools/test-*.js, root test-*.js/.mjs,
// computations/*.gate.js) — these are verification code, not a second
// production source of the calculation, so they are exempt.
function isExemptTestFile(relPath) {
  const base = path.basename(relPath);
  return /^test-/i.test(base) || /\.test\.(js|mjs)$/i.test(base) || /\.gate\.js$/i.test(base);
}

// Signature 1/2 comparator shapes (backreferences handle any param names).
const ARROW_ASC = /\(?\s*(\w+)\s*,\s*(\w+)\s*\)?\s*=>\s*\1\s*-\s*\2\b/;
const FUNC_ASC = /function\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{\s*return\s+\1\s*-\s*\2\s*;?\s*\}/;
const ARROW_DESC = /\(?\s*(\w+)\s*,\s*(\w+)\s*\)?\s*=>\s*\2\s*-\s*\1\b/;
const FUNC_DESC = /function\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{\s*return\s+\2\s*-\s*\1\s*;?\s*\}/;
const SLICE_FIRST3 = /\.slice\(\s*0\s*,\s*3\s*\)/;
const SLICE_LAST3 = /\.slice\(\s*-3\s*\)/;
const SORT_WINDOW = 260; // chars scanned after each ".sort(" for the comparator shape + trailing slice

// Signature 3: a locally-defined "lowest 3/Three/N" helper (global, so every
// occurrence in a file is reported, not just the first).
const LOWEST_HELPER_NAME =
  /\b(?:function\s+\w*[Ll]owest(?:3|Three|N)?\w*\s*\(|(?:const|let|var)\s+\w*[Ll]owest(?:3|Three|N)?\w*\s*=)/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function lineAt(lineStarts, idx) {
  let lo = 0,
    hi = lineStarts.length - 1,
    ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= idx) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

function buildLineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function scanFile(content) {
  const hits = [];
  const lineStarts = buildLineStarts(content);

  let idx = 0;
  while ((idx = content.indexOf('.sort(', idx)) !== -1) {
    const win = content.slice(idx, Math.min(content.length, idx + SORT_WINDOW));
    const asc = ARROW_ASC.test(win) || FUNC_ASC.test(win);
    const desc = ARROW_DESC.test(win) || FUNC_DESC.test(win);
    if (asc && SLICE_FIRST3.test(win)) {
      hits.push({ line: lineAt(lineStarts, idx), reason: 'ascending numeric sort chained into .slice(0, 3)' });
    } else if (desc && SLICE_LAST3.test(win)) {
      hits.push({ line: lineAt(lineStarts, idx), reason: 'descending numeric sort chained into .slice(-3)' });
    }
    idx += 6;
  }

  let m;
  LOWEST_HELPER_NAME.lastIndex = 0;
  while ((m = LOWEST_HELPER_NAME.exec(content))) {
    hits.push({ line: lineAt(lineStarts, m.index), reason: 'locally-defined "lowest N" helper: ' + m[0].trim() });
  }

  return hits;
}

function main() {
  const files = [];
  walk(REPO, files);

  const violations = [];
  for (const abs of files) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/');
    if (rel === CANONICAL_FILE || rel === SELF) continue;
    if (isExemptTestFile(rel)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    if (!content.includes('.sort(') && !/[Ll]owest/.test(content)) continue; // fast skip
    const hits = scanFile(content);
    for (const h of hits) violations.push({ file: rel, line: h.line, reason: h.reason });
  }

  if (violations.length) {
    console.error('FAIL — 3-lowest-month baseload re-implementation found outside ' + CANONICAL_FILE + ':');
    for (const v of violations) {
      console.error('  ' + v.file + ':' + v.line + ' — ' + v.reason);
    }
    console.error(
      '\nCall computations/hvac-enduse.js computeHvacEnduse() (or its _hvacLowestNAvg helper) instead of ' +
        're-implementing the sort+lowest-3 average locally — this exact mistake shipped twice before (v.19, v.25).',
    );
    process.exit(1);
  }

  console.log('PASS — no 3-lowest-month baseload re-implementation found outside ' + CANONICAL_FILE);
  process.exit(0);
}

main();
