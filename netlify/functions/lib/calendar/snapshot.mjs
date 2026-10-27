// Pure core of the calendar feed function: check the feed address, download, read, and build a snapshot.
// No auth and no storage here. The caller passes fetchImpl so tests never use the network.
import { fetchICS } from './fetch-ics.mjs';
import { checkFeedUrl, FeedInputError } from './feed-url.mjs';
export { checkFeedUrl, FeedInputError };
import { DEFAULT_LIMITS, parseICS, snapshotRows, windowBounds } from './normalize.mjs';

export const DEFAULT_TIMEZONE = 'America/Chicago';
// Same window the standalone calendar project used.
export const RECURRENCE_WINDOW = {
  pastDays: 365,
  futureDays: 730,
  maxInstancesPerSeries: 1000,
  maxScannedPerSeries: 20000,
};

export function checkTimezone(value) {
  const tz = String(value || DEFAULT_TIMEZONE);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new FeedInputError('The time zone is not valid.');
  }
  return tz;
}

export async function buildSnapshot({ icsUrl, timezone }, { fetchImpl = fetch, now = new Date() } = {}) {
  const url = checkFeedUrl(icsUrl);
  const tz = checkTimezone(timezone);
  const got = await fetchICS(url, {}, { force: true, fetchImpl });
  const { events, stats } = parseICS(got.text, {
    timezone: tz,
    recurrenceWindow: RECURRENCE_WINDOW,
    now,
    limits: DEFAULT_LIMITS,
  });
  const rows = snapshotRows(events);
  return {
    fetchedAt: now.toISOString(),
    bytes: got.bytes,
    window: windowBounds(RECURRENCE_WINDOW, now),
    count: Object.keys(rows).length,
    stats,
    leftOut: stats.truncatedTitles.slice(0, 20),
    events: rows,
  };
}
