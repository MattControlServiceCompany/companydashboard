// Release step: tell every open CompanyHub tab of one site that a new version is live (Matt 2026-11-16).
// Usage: node tools/announce-version.js <origin-host> [version]
//   <origin-host> = location.host of the site (e.g. localhost:8888 or the Netlify host name).
//   version      = optional; default is CH_VERSION read from site-ui.js (the one source of truth).
// Sends ONE Supabase Realtime Broadcast (REST) to topic 'ch-version:<host>', event 'version', payload {version}.
// Needs only the public publishable key (read from app/ch-auth.js). Not a database write. Exit 1 on any failure.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function read(file, re, what) {
  const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re);
  if (!m) throw new Error('cannot read ' + what + ' from ' + file);
  return m[1];
}

async function announce(host, version) {
  const url = read('app/ch-auth.js', /var SUPABASE_URL = '([^']+)'/, 'SUPABASE_URL');
  const key = read('app/ch-auth.js', /var SUPABASE_ANON_KEY = '([^']+)'/, 'SUPABASE_ANON_KEY');
  const ver = version || read('site-ui.js', /CH_VERSION\s*=\s*'([^']+)'/, 'CH_VERSION');
  const res = await fetch(url + '/realtime/v1/api/broadcast', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: 'ch-version:' + host, event: 'version', payload: { version: ver }, private: false }] }),
  });
  if (res.status !== 202 && !res.ok) throw new Error('broadcast refused: HTTP ' + res.status + ' ' + (await res.text()));
  return { topic: 'ch-version:' + host, version: ver, status: res.status };
}

module.exports = { announce };
if (require.main === module) {
  const [host, version] = process.argv.slice(2);
  if (!host) {
    console.error('Usage: node tools/announce-version.js <origin-host> [version]');
    process.exit(1);
  }
  announce(host, version).then(
    (r) => console.log('announced ' + r.version + ' to ' + r.topic + ' (HTTP ' + r.status + ')'),
    (e) => {
      console.error('announce-version FAILED: ' + e.message);
      process.exit(1);
    },
  );
}
