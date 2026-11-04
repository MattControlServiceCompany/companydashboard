// Per-file ?v= test: a release rewrites only the refs of files that changed.
// Runs scripts/stamp-version.py --refs-only on a temp copy of the pages and their files.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkTmpDir, rmTmp } = require('./tools/tmp-root.js');

const REPO = __dirname;
const PAGES = ['energy-department.html', 'index.html', 'ems-leads.html'];
const REF = /([A-Za-z0-9_./-]+)\?v=([0-9A-Za-z.]+)/g;
let fails = 0;
function check(name, ok, extra) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); }

function stamp(root, flag) {
  for (const py of ['python', 'python3', 'py']) {
    const r = spawnSync(py, [path.join(REPO, 'scripts', 'stamp-version.py'), '--root', root, flag], { encoding: 'utf8' });
    if (!r.error) return r;
  }
  throw new Error('python not found');
}
function refs(root) {
  const out = {};
  for (const p of PAGES) {
    const t = fs.readFileSync(path.join(root, p), 'utf8');
    let m; REF.lastIndex = 0;
    while ((m = REF.exec(t))) out[p + '|' + m[1]] = m[2];
  }
  return out;
}

const tmp = mkTmpDir('per-file-version-');
try {
  // copy the pages and every file they name
  for (const p of PAGES) {
    fs.copyFileSync(path.join(REPO, p), path.join(tmp, p));
    const t = fs.readFileSync(path.join(REPO, p), 'utf8');
    let m; REF.lastIndex = 0;
    while ((m = REF.exec(t))) {
      const dest = path.join(tmp, m[1]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO, m[1]), dest);
    }
  }
  // 1. the committed pages already match their files
  check('committed refs match files', stamp(tmp, '--check-refs').status === 0);
  const before = refs(tmp);
  const n = Object.keys(before).length;
  check('refs found', n > 90, '(' + n + ')');
  check('every ref is 8 hex chars', Object.values(before).every((v) => /^[0-9a-f]{8}$/.test(v)));

  // 2. a second run with no change changes nothing
  const snap = PAGES.map((p) => fs.readFileSync(path.join(tmp, p), 'utf8'));
  check('run 1 ok', stamp(tmp, '--refs-only').status === 0);
  check('run 2 ok', stamp(tmp, '--refs-only').status === 0);
  check('no change: pages byte-identical', PAGES.every((p, i) => fs.readFileSync(path.join(tmp, p), 'utf8') === snap[i]));

  // 3. change one file: only its refs change
  const target = 'app/db.js';
  fs.appendFileSync(path.join(tmp, target), '\n// changed\n');
  const wrong = stamp(tmp, '--check-refs');
  check('stale hash is detected', wrong.status === 1);
  check('rewrite ok', stamp(tmp, '--refs-only').status === 0);
  const after = refs(tmp);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  check('only the changed file ref changes', changed.length > 0 && changed.every((k) => k.split('|')[1] === target), JSON.stringify(changed));
  check('check-refs passes after', stamp(tmp, '--check-refs').status === 0);

  // 4. every ref's hash matches its file (independent sha256 here)
  const crypto = require('crypto');
  let bad = 0;
  for (const k of Object.keys(after)) {
    const [page, file] = k.split('|');
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, file)).toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex').slice(0, 8);
    if (h !== after[k]) bad++;
  }
  check('every hash matches its file', bad === 0, '(bad ' + bad + ')');
} finally {
  rmTmp(tmp);
}
console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
