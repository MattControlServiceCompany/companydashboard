// Reads the site event log (the kv keys en_site_events_YYYY-MM, written by app/site-events.js) and prints one line per
// event, newest first.
// Usage: node tools/read-site-events.js [--since 2h] [--event page-error] [--host localhost:8888] [--limit 200] [--json]
//   --since  a number and a unit: 30m, 2h, 7d (default 2h)      --event  exact event name      --host  exact host (host:port)
// Signs in as the Claude test account, the same credential source as _context/tools/2026-11-10-pull-live-data.py:
// Windows Credential Manager target "cscdashboard-claude-a" (read by a small python call; the password stays in memory and is never printed).
// Read only: GET ?manifest=1 and GET ?key=<month key> on the kv-sync function (the same read path as pull-live-data.py;
// needs the local site, netlify dev on localhost:8888, or set CH_KV_SYNC_URL). Never writes. See docs/OPERATIONS.md, "Site event log".
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const auth = fs.readFileSync(path.join(__dirname, '..', 'app', 'ch-auth.js'), 'utf8');
const KV_SYNC_URL = process.env.CH_KV_SYNC_URL || 'http://localhost:8888/.netlify/functions/kv-sync';
const EVENT_LOG_PREFIX = require('../app/sync-classification.js').EVENT_LOG_PREFIX; // the one key spelling
const SUPABASE_URL = (auth.match(/var SUPABASE_URL = '([^']+)'/) || [])[1];
const ANON = (auth.match(/var SUPABASE_ANON_KEY = '([^']+)'/) || [])[1];

const PY = `
import ctypes, ctypes.wintypes as wt, json, sys
class C(ctypes.Structure):
    _fields_=[('Flags',wt.DWORD),('Type',wt.DWORD),('TargetName',wt.LPWSTR),('Comment',wt.LPWSTR),('LastWritten',wt.FILETIME),('CredentialBlobSize',wt.DWORD),('CredentialBlob',ctypes.POINTER(ctypes.c_char)),('Persist',wt.DWORD),('AttributeCount',wt.DWORD),('Attributes',ctypes.c_void_p),('TargetAlias',wt.LPWSTR),('UserName',wt.LPWSTR)]
p=ctypes.POINTER(C)()
if not ctypes.windll.advapi32.CredReadW('cscdashboard-claude-a',1,0,ctypes.byref(p)): sys.exit(3)
c=p.contents
b=ctypes.string_at(c.CredentialBlob,c.CredentialBlobSize)
try: pw=b.decode('utf-16-le')
except UnicodeDecodeError: pw=b.decode('utf-8')
print(json.dumps({'u':c.UserName,'p':pw}))
`;

function args() {
  const a = { since: '2h', limit: 200 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--json') a.json = true;
    else if (/^--(since|event|host|limit)$/.test(v[i])) a[v[i].slice(2)] = v[++i];
    else throw new Error('Unknown argument: ' + v[i]);
  }
  return a;
}
function sinceMs(s) {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) throw new Error('--since must look like 30m, 2h or 7d');
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}
// The ONE filter + order: events of the given month lists, newest first, kept by --since / --event / --host, at most --limit.
function selectEvents(lists, a, now) {
  const from = new Date((now === undefined ? Date.now() : now) - sinceMs(a.since)).toISOString();
  const rows = [].concat(...lists).filter((e) => e && e.ts >= from && (!a.event || e.event === a.event) && (!a.host || e.host === a.host));
  rows.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  return rows.slice(0, Number(a.limit));
}
function formatEvent(e, json) {
  return json ? JSON.stringify(e) : [e.ts, e.host, e.version, e.email || '-', e.page || '-', e.event, JSON.stringify(e.detail || {})].join(' | ');
}
async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Read failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}
async function main() {
  const a = args();
  sinceMs(a.since);
  const r = spawnSync('python', ['-I', '-c', PY], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Could not read the credential cscdashboard-claude-a');
  const cred = JSON.parse(r.stdout);
  const t = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cred.u, password: cred.p }),
  });
  if (!t.ok) throw new Error('Sign-in failed: HTTP ' + t.status);
  const token = (await t.json()).access_token;
  // Only the months the --since window touches.
  const first = new Date(Date.now() - sinceMs(a.since)).toISOString().slice(0, 7);
  const last = new Date().toISOString().slice(0, 7);
  const manifest = await getJson(KV_SYNC_URL + '?manifest=1', token);
  const keys = manifest.filter((m) => !m.deleted && m.key.indexOf(EVENT_LOG_PREFIX) === 0 && m.key.slice(EVENT_LOG_PREFIX.length) >= first && m.key.slice(EVENT_LOG_PREFIX.length) <= last).map((m) => m.key);
  const lists = [];
  for (const k of keys) {
    const row = await getJson(KV_SYNC_URL + '?key=' + encodeURIComponent(k), token);
    if (Array.isArray(row.value)) lists.push(row.value);
  }
  const rows = selectEvents(lists, a);
  for (const e of rows) console.log(formatEvent(e, a.json));
  console.error(rows.length + ' events');
}
if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
module.exports = { selectEvents, formatEvent, sinceMs };
