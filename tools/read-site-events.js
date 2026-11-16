// Reads the site event log (public.ch_site_events, written by app/site-events.js) and prints one line per event.
// Usage: node tools/read-site-events.js [--since 2h] [--event page-error] [--host localhost:8888] [--limit 200] [--json]
//   --since  a number and a unit: 30m, 2h, 7d (default 2h)      --event  exact event name      --host  exact host (host:port)
// Signs in as the Claude test account, the same credential source as _context/tools/2026-11-10-pull-live-data.py:
// Windows Credential Manager target "cscdashboard-claude-a" (read by a small python call; the password stays in memory and is never printed).
// Read only: one GET. Needs the table (docs/OPERATIONS.md, "Site event log").
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const auth = fs.readFileSync(path.join(__dirname, '..', 'app', 'ch-auth.js'), 'utf8');
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
async function main() {
  const a = args();
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
  const q = new URLSearchParams({ select: '*', order: 'ts.desc', limit: String(a.limit) });
  q.append('ts', 'gte.' + new Date(Date.now() - sinceMs(a.since)).toISOString());
  if (a.event) q.append('event', 'eq.' + a.event);
  if (a.host) q.append('host', 'eq.' + a.host);
  const res = await fetch(SUPABASE_URL + '/rest/v1/ch_site_events?' + q, { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Read failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const rows = (await res.json()).reverse(); // oldest first, like a log file
  for (const e of rows) {
    if (a.json) console.log(JSON.stringify(e));
    else console.log([e.ts, e.host, e.version, e.email || '-', e.page || '-', e.event, JSON.stringify(e.detail || {})].join(' | '));
  }
  console.error(rows.length + ' events');
}
main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
