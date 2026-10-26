'use strict';
// Single rule for "Supabase Storage says this object is missing".
// Storage answers a missing object with HTTP 400 and a JSON body
// {"statusCode":"404","error":"not_found","message":"Object not found"}.
// Used by netlify/functions/pdf-sync.js and scripts/migrate-seed.js.

function isStorageNotFoundBody(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch (e) {
    return false;
  }
  return !!b && String(b.statusCode) === '404' && (b.error === 'not_found' || /NoSuchKey/.test(String(b.code || '') + String(b.message || '')));
}

// status: HTTP status. text: response body text.
function isStorageNotFound(status, text) {
  return status === 404 || (status === 400 && isStorageNotFoundBody(text));
}

module.exports = { isStorageNotFoundBody, isStorageNotFound };
