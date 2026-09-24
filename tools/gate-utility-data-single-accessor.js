#!/usr/bin/env node
// tools/gate-utility-data-single-accessor.js — structural gate.
//
// Customer/Multi-Project (2026-09-24 design, section 3 "Structural gate"): buildings/
// meters/bills moved from per-project storage to per-customer storage
// (en_utility_<customerId>), and getUDBldgs() now filters by a project's own
// project.scope.buildingIds. Any code that reaches the raw store WITHOUT going through
// the accessor module (app/utility-data.js) skips that filter and reintroduces the
// exact cross-project bypass bugs three straight cold reviews found by hand
// (BLOCKER A / BLOCKER C / the 3rd "sget bypass" spelling). This gate makes a missed
// site a failing build instead of a 4th cold review.
//
// Scans app/*.js, computations/*.js, lib/*.js, and root *.js for 4 root-access
// spellings that obtain a raw handle on the utility-data store:
//   1. utilityData[ ... ]            — direct bracket-index into the module-global
//   2. getUDProj( ... )              — the internal, unfiltered accessor
//   3. sget('en_utility_' ...)       — raw storage read bypassing the in-memory object
//   4. sset('en_utility_' ...) / localStorage on the same key — raw storage write
//
// A match is a violation UNLESS the file is app/utility-data.js itself (the accessor
// module — the whole file IS the trusted implementation surface; its own internal
// cross-project loops are required to use getCustomerBuildings/getProjectsForBuilding,
// but that is enforced by the acceptance test + code review, not this gate) or the file
// is in the explicit tooling allowlist below.
//
// Run:  node tools/gate-utility-data-single-accessor.js
// Exits nonzero (and prints every offending file:line + matched pattern) on any hit.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ACCESSOR_FILE = 'app/utility-data.js';
const SELF = path.relative(REPO, __filename).split(path.sep).join('/');

const SCAN_DIRS = ['app', 'computations', 'lib'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

// Explicit path allowlist (design section 3, "Structural gate"): tooling/test harnesses
// that legitimately reimplement or reference the raw storage shape for verification, not
// production reads.
function isAllowlisted(relPath) {
  if (relPath === ACCESSOR_FILE) return true;
  if (relPath === SELF) return true;
  if (relPath.startsWith('tools/')) return true;
  if (relPath.startsWith('scripts/')) return true;
  if (relPath === 'computations/rates.cascade.gate.js') return true;
  if (relPath === 'test-verification.js') return true;
  if (relPath === 'test-backlog-runner.js') return true;
  return false;
}

// Root-access patterns. Order matters only for reporting the matched pattern name.
const PATTERNS = [
  { name: 'utilityData[...]', re: /\butilityData\s*\[/g },
  { name: 'getUDProj(...)', re: /\bgetUDProj\s*\(/g },
  { name: "sget('en_utility_...)", re: /\bsget\s*\(\s*['"`]en_utility_/g },
  {
    name: "sset/localStorage('en_utility_...)",
    re: /\b(?:sset|localStorage\.(?:setItem|getItem))\s*\(\s*['"`]en_utility_/g,
  },
  { name: "raw 'en_utility_' + concat", re: /['"`]en_utility_['"`]\s*\+/g },
];

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
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile() && /\.js$/i.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(REPO, d), files);
  // root *.js (not recursive into subdirs already covered above)
  for (const ent of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (ent.isFile() && /\.js$/i.test(ent.name)) files.push(path.join(REPO, ent.name));
  }
  return files;
}

function scanFile(absPath) {
  const relPath = path.relative(REPO, absPath).split(path.sep).join('/');
  if (isAllowlisted(relPath)) return [];
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return [];
  }
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    for (const pat of PATTERNS) {
      pat.re.lastIndex = 0;
      if (pat.re.test(line)) {
        hits.push({ file: relPath, line: idx + 1, pattern: pat.name, text: line.trim().slice(0, 160) });
      }
    }
  });
  return hits;
}

function run() {
  const files = collectFiles();
  let allHits = [];
  for (const f of files) {
    allHits = allHits.concat(scanFile(f));
  }
  if (allHits.length) {
    console.error('gate-utility-data-single-accessor: FAILED — ' + allHits.length + ' violation(s) found.\n');
    for (const h of allHits) {
      console.error(h.file + ':' + h.line + '  [' + h.pattern + ']  ' + h.text);
    }
    console.error(
      '\nEvery read/write of utility-data buildings/meters/bills outside app/utility-data.js must go ' +
        'through the accessor functions (getUDBldgs/getUDBldg/getUDMeter/getCustomerBuildings/' +
        'getUDBldgByCustomer/getProjectsForBuilding/addUDBldg/unscopeBuilding/isBaselineExcluded/' +
        'setBaselineExcluded) — never index utilityData[...]/getUDProj(...)/raw en_utility_ storage ' +
        'directly. See AI/_context/plans/2026-09-23-customer-multi-project-design.md, section 3, ' +
        '"Structural gate."',
    );
    process.exitCode = 1;
    return;
  }
  console.log('gate-utility-data-single-accessor: PASSED — 0 violations outside the allowlist.');
}

run();
