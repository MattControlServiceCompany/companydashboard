// Copied once from the standalone calendar project (commit 8b8432d). This is the only maintained copy.
export class TooLargeError extends Error { constructor(maxBytes) { super(`ICS body is larger than the ${maxBytes} byte limit`); this.name = "TooLargeError"; } }
import { checkFeedUrl } from "./feed-url.mjs";
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_ICS_BYTES = 10 * 1024 * 1024;

// Read the body in chunks and stop as soon as the byte count passes the cap. The rest is never read.
async function readCapped(response, maxBytes) {
  const tooBig = () => new TooLargeError(maxBytes);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) { try { await response.body?.cancel(); } catch { /* ignore */ } throw tooBig(); }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooBig();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Fetch an ICS feed.
// - force: true  -> unconditional request. No If-None-Match / If-Modified-Since is sent,
//                   so the server must return a complete body (a 304 is then an error).
// - otherwise    -> conditional request when previous ETag / Last-Modified exist.
export async function fetchICS(url, previous = {}, { force = false, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_ICS_BYTES } = {}) {
  const headers = { "User-Agent": "GoogleCalendarPlatform/1.0" };
  if (!force) {
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModifiedHeader) headers["If-Modified-Since"] = previous.lastModifiedHeader;
  }
  const conditional = Boolean(headers["If-None-Match"] || headers["If-Modified-Since"]);

  // Redirects are followed here, one at a time. Every address (first, each Location, final response.url)
  // goes through the same feed address check, so a redirect can never leave the calendar host.
  let current = checkFeedUrl(url);
  let response;
  for (let hop = 0; ; hop++) {
    response = await fetchImpl(current, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const location = response.headers.get("location");
      if (!location) throw new Error("ICS request failed: redirect without a Location");
      if (hop >= MAX_REDIRECTS) throw new Error("ICS request failed: too many redirects");
      current = checkFeedUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }
  if (response.url) checkFeedUrl(response.url);
  const meta = {
    etag: response.headers.get("etag") || (force ? null : previous.etag) || null,
    lastModifiedHeader: response.headers.get("last-modified") || (force ? null : previous.lastModifiedHeader) || null
  };

  if (response.status === 304) {
    if (!conditional) throw new Error("ICS request failed: HTTP 304 received for an unconditional request");
    return { notModified: true, ...meta };
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    throw new Error(`ICS request failed: HTTP 429 (rate limited${retry ? `, retry after ${retry}` : ""})`);
  }
  if (!response.ok) throw new Error(`ICS request failed: HTTP ${response.status}`);

  const text = await readCapped(response, maxBytes);
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new Error("ICS request failed: response is not an ICS calendar (missing BEGIN:VCALENDAR)");
  return { notModified: false, text, bytes: Buffer.byteLength(text), ...meta };
}
