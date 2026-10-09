'use strict';
/*
 * Real-id gate. Reads a private list of real account and meter ids (one per line) from the env var
 * CH_REAL_IDS_FILE. The list is never committed. Runs a word-exact fixed-string search over all tracked
 * files (git grep -IcwF -f). Any hit = FAIL. Prints file names and counts only, never the matched values.
 * Unset or missing list = SKIP (exit 0).
 * Use alone: node scripts/gate-real-ids.js        Used by scripts/regression-gate.js through checkRealIds().
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function checkRealIds() {
  const f = process.env.CH_REAL_IDS_FILE;
  if (!f || !fs.existsSync(f)) return { status: 'SKIP', detail: 'SKIP: CH_REAL_IDS_FILE unset or list not found', hits: [] };
  if (!fs.readFileSync(f, 'utf8').trim()) return { status: 'FAIL', detail: 'real-id list is empty', hits: [] };
  const g = spawnSync('git', ['grep', '-IcwF', '-f', f], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (g.status !== 0 && g.status !== 1) return { status: 'FAIL', detail: 'git grep error (exit ' + g.status + ')', hits: [] };
  const hits = (g.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => ({ file: l.slice(0, l.lastIndexOf(':')), count: parseInt(l.slice(l.lastIndexOf(':') + 1), 10) || 0 }))
    .filter((h) => h.count > 0);
  if (!hits.length) return { status: 'PASS', detail: '0 hits in tracked files', hits };
  const total = hits.reduce((s, h) => s + h.count, 0);
  return { status: 'FAIL', detail: total + ' lines in ' + hits.length + ' files: ' + hits.map((h) => h.file + ' x' + h.count).join(', '), hits };
}

module.exports = { checkRealIds };

if (require.main === module) {
  const r = checkRealIds();
  console.log('real-ids gate: ' + r.status + ' - ' + r.detail);
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
