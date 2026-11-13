// netlify/lib/kv-hash.js
// The ONE canonical JSON and SHA-256 hash of a kv value (the `hash` column of the kv table).
// Used by netlify/functions/kv-sync.js (every write) and scripts/calendar-daily-sync.js (the daily calendar update).
const crypto = require('crypto');

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

module.exports = { canonicalJSON, sha256Hex };
