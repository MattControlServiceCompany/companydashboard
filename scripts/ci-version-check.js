#!/usr/bin/env node
/**
 * ci-version-check.js — No-network, repo-local release version consistency
 * check for CompanyHub CI.
 *
 * Mirrors the consistency rules already enforced at stamp time by
 * scripts/stamp-version.py (verify_tags() and get_release_notes_top_version()).
 * This does NOT replace that script and does NOT talk to the network — it is
 * a cheap post-checkout sanity re-check that nothing hand-edited a version
 * string out of sync after stamping (the bug class that causes the stale
 * "update available" banner: see stamp-version.py's Step 1.5 comment).
 *
 * Checks:
 *   1. CH_VERSION literal in site-ui.js (repo root) is well-formed.
 *   2. Every ?v= tag in energy-department.html, index.html, ems-leads.html
 *      is the content hash of the file it names (asks stamp-version.py).
 *   3. RELEASE_NOTES[0].v in app/site-functions.js equals CH_VERSION exactly.
 *
 * Exit 0 + "version OK vNNN" when all agree.
 * Exit 1 + the specific mismatch(es) when they don't.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const SITE_UI_JS = path.join(REPO_ROOT, 'site-ui.js');
const SITE_FUNCTIONS_JS = path.join(REPO_ROOT, 'app', 'site-functions.js');

const errors = [];

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    errors.push(`missing file: ${filePath}`);
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

// --- Step 1: CH_VERSION from site-ui.js -----------------------------------

const siteUiText = readFile(SITE_UI_JS);
let chVersion = null; // full string, e.g. 'v2026.09.17.850'
let chPatch = null; // integer patch, e.g. 850

if (siteUiText !== null) {
  const m = siteUiText.match(/var\s+CH_VERSION\s*=\s*['"](v[\d.]+)['"]/);
  if (!m) {
    errors.push(`could not find "var CH_VERSION = 'v...'" in ${SITE_UI_JS}`);
  } else {
    chVersion = m[1];
    const patchMatch = chVersion.match(/\.(\d+)$/);
    if (!patchMatch) {
      errors.push(`CH_VERSION "${chVersion}" does not end in ".<integer>"`);
    } else {
      chPatch = parseInt(patchMatch[1], 10);
    }
  }
}

// --- Step 2: every ?v= is the content hash of its file ---------------------
// The rule lives in scripts/stamp-version.py (ref_hash). This asks it; there is
// no second copy of the rule here.

{
  let ran = false;
  for (const py of ['python', 'python3', 'py']) {
    const r = require('child_process').spawnSync(
      py, [path.join(REPO_ROOT, 'scripts', 'stamp-version.py'), '--check-refs'], { encoding: 'utf8' });
    if (r.error) continue;
    ran = true;
    if (r.status !== 0) errors.push('wrong ?v= hash(es): ' + (r.stderr || r.stdout));
    break;
  }
  if (!ran) errors.push('python not found: cannot check the ?v= hashes');
}

// --- Step 3: RELEASE_NOTES[0].v in app/site-functions.js -------------------

const siteFunctionsText = readFile(SITE_FUNCTIONS_JS);
if (siteFunctionsText !== null && chVersion !== null) {
  const arrStart = siteFunctionsText.match(/var\s+RELEASE_NOTES\s*=\s*\[/);
  if (!arrStart) {
    errors.push(`could not find "var RELEASE_NOTES = [" in ${SITE_FUNCTIONS_JS}`);
  } else {
    const rest = siteFunctionsText.slice(arrStart.index + arrStart[0].length);
    const topVersionMatch = rest.match(/v:\s*['"](v[\d.]+)['"]/);
    if (!topVersionMatch) {
      errors.push(`could not find RELEASE_NOTES[0].v in ${SITE_FUNCTIONS_JS}`);
    } else {
      const topVersion = topVersionMatch[1];
      if (topVersion !== chVersion) {
        errors.push(`RELEASE_NOTES[0].v (${topVersion}) does not match CH_VERSION (${chVersion})`);
      }
    }
  }
}

// --- Report ------------------------------------------------------------

if (errors.length > 0) {
  console.error('VERSION MISMATCH:');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`version OK ${chVersion}`);
process.exit(0);
