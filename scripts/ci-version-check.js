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
 *      carries the same integer patch as CH_VERSION.
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
const HTML_FILES = [
  path.join(REPO_ROOT, 'energy-department.html'),
  path.join(REPO_ROOT, 'index.html'),
  path.join(REPO_ROOT, 'ems-leads.html'),
];

// Matches both ?v=NNN and ?v=YYYY.MM.DD.NNN (the core.js anomaly) — same
// pattern as stamp-version.py's VQ_PATTERN.
const VQ_PATTERN = /(\?v=)(?:\d{4}\.\d{2}\.\d{2}\.)?(\d+)/g;

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

// --- Step 2: ?v= tags across the tracked HTML files ------------------------

if (chPatch !== null) {
  for (const htmlFile of HTML_FILES) {
    const text = readFile(htmlFile);
    if (text === null) continue;
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      let match;
      VQ_PATTERN.lastIndex = 0;
      while ((match = VQ_PATTERN.exec(line)) !== null) {
        const foundPatch = parseInt(match[2], 10);
        if (foundPatch !== chPatch) {
          errors.push(
            `${path.basename(htmlFile)}:${idx + 1}: stale ?v= tag ` +
              `(found ${foundPatch}, expected ${chPatch}): ${line.trim()}`,
          );
        }
      }
    });
  }
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
