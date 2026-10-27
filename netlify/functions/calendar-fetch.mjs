// netlify/functions/calendar-fetch.mjs
//
// POST { icsUrl, timezone } -> { ok:true, snapshot } for one calendar feed.
// The browser cannot read the feed itself (the feed host sends no CORS header), so this function
// downloads and reads it. It is stateless: it never reads or writes the database.
// Called only when the user clicks the Sync button. Same sign-in check as kv-sync (netlify/lib/auth.js).
import auth from '../lib/auth.js';
import { buildSnapshot, FeedInputError } from './lib/calendar/snapshot.mjs';

const { verifyAuth, AuthError } = auth;

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function makeHandler(deps = {}) {
  return async function handler(event) {
    try {
      await verifyAuth(event);
      if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'Method not allowed' });
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return respond(400, { ok: false, error: 'Invalid JSON body' });
      }
      const snapshot = await buildSnapshot({ icsUrl: body.icsUrl, timezone: body.timezone }, deps);
      return respond(200, { ok: true, snapshot });
    } catch (err) {
      if (err instanceof AuthError) return respond(err.statusCode, { ok: false, error: err.message });
      if (err instanceof FeedInputError) return respond(400, { ok: false, error: err.message });
      // Fixed text only. Detail goes to the log with no web address in it.
      console.error('[calendar-fetch] failed:', err && err.name);
      return respond(502, { ok: false, error: 'The calendar feed could not be read. The last saved copy is kept.' });
    }
  };
}

export const handler = makeHandler();
