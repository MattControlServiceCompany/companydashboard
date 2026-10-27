// Copied once from the standalone calendar project (commit 8b8432d). This is the only maintained copy.
import ICAL from "ical.js";

const DEFAULT_TIMEZONE = "America/Chicago";

function text(value) {
  if (value == null) return "";
  return String(value).trim();
}

// Offset (ms) of a time zone from UTC at a given instant.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000 - (utcMs % 1000 + 1000) % 1000 * 0 - 0;
}

// Convert wall-clock fields in a time zone to a UTC instant (ms).
export function zonedToUtcMs(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - zoneOffsetMs(guess, timeZone);
  t = guess - zoneOffsetMs(t, timeZone);
  return t;
}

function toISO(value, timeZone) {
  if (!value) return null;
  try {
    if (value instanceof ICAL.Time) {
      // Date-only values and floating times are wall-clock values in the calendar time zone.
      if (value.isDate || value.zone?.tzid === "floating") {
        const ms = zonedToUtcMs(value.year, value.month, value.day, value.hour || 0, value.minute || 0, value.second || 0, timeZone);
        return new Date(ms).toISOString();
      }
      return value.toJSDate().toISOString();
    }
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function isDateOnly(value) {
  return value instanceof ICAL.Time && value.isDate;
}

function eventFromComponent(component, timeZone) {
  const uid = text(component.getFirstPropertyValue("uid"));
  if (!uid) return null;

  const dtstart = component.getFirstPropertyValue("dtstart");
  const dtend = component.getFirstPropertyValue("dtend");
  const duration = component.getFirstPropertyValue("duration");

  let end = dtend;
  if (!end && dtstart && duration) {
    try { end = dtstart.clone(); end.addDuration(duration); } catch { end = null; }
  }

  const sequence = Number(component.getFirstPropertyValue("sequence") ?? 0);
  const event = {
    id: uid,
    title: text(component.getFirstPropertyValue("summary")) || "(No title)",
    description: text(component.getFirstPropertyValue("description")),
    location: text(component.getFirstPropertyValue("location")),
    start: toISO(dtstart, timeZone),
    end: toISO(end, timeZone),
    allDay: isDateOnly(dtstart),
    status: text(component.getFirstPropertyValue("status")).toLowerCase() || "confirmed",
    sequence: Number.isFinite(sequence) ? sequence : 0,
    lastModified: toISO(component.getFirstPropertyValue("last-modified"), timeZone),
    created: toISO(component.getFirstPropertyValue("created"), timeZone)
  };

  const recurrenceId = component.getFirstPropertyValue("recurrence-id");
  if (recurrenceId) event.recurrenceId = toISO(recurrenceId, timeZone);

  event.sourceKey = event.recurrenceId ? `${uid}::${event.recurrenceId}` : uid;
  return event;
}

// Deterministic duplicate resolution: higher SEQUENCE, then later LAST-MODIFIED, then larger JSON text.
function preferred(a, b) {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? a : b;
  const la = a.lastModified || "", lb = b.lastModified || "";
  if (la !== lb) return la > lb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

const DAY_MS = 86400000;

export const DEFAULT_LIMITS = { maxIcsBytes: 10 * 1024 * 1024, maxVevents: 20000, maxTotalInstances: 20000, maxTotalScanned: 400000 };

// Thrown when an input is over a resource cap. The sync fails and the stored data is kept.
export class CapError extends Error {
  constructor(message) { super(message); this.name = "CapError"; }
}

// Thrown when ONE repeating series is over its own cap. That series is left out; the sync goes on.
class SeriesLimitError extends Error {
  constructor(message) { super(message); this.name = "SeriesLimitError"; }
}

// Window comes from config (calendars.json "recurrenceWindow"): { pastDays, futureDays, maxInstancesPerSeries, maxScannedPerSeries }.
// The window is anchored on the UTC day of `now`, so two syncs on the same day produce identical keys.
function resolveWindow(recurrenceWindow, now) {
  const w = recurrenceWindow;
  if (!w || ![w.pastDays, w.futureDays, w.maxInstancesPerSeries, w.maxScannedPerSeries].every(n => Number.isInteger(n) && n >= 0)) {
    throw new Error("parseICS: recurrenceWindow {pastDays, futureDays, maxInstancesPerSeries, maxScannedPerSeries} is required");
  }
  const day = Math.floor((now instanceof Date ? now.getTime() : Date.now()) / DAY_MS) * DAY_MS;
  return { startMs: day - w.pastDays * DAY_MS, endMs: day + w.futureDays * DAY_MS, max: w.maxInstancesPerSeries, maxScanned: w.maxScannedPerSeries };
}

// Expand one RRULE/RDATE master into instances inside the window. EXDATE is honored by the ical.js iterator.
// Instance key = uid::<instance start ISO>, the same format as an override key (uid::<RECURRENCE-ID ISO>).
function expandMaster(component, base, timeZone, win, skipKeys, stats, budget) {
  const instances = [];
  const ev = new ICAL.Event(component);
  const it = ev.iterator();
  let scanned = 0, occ;
  while ((occ = it.next())) {
    // The library has no safe way to jump to the window start (COUNT and RDATE depend on every earlier date),
    // so earlier dates are still walked. Every step counts against the ONE shared scan budget for the sync.
    if (++budget.scanned > budget.maxScanned) throw new CapError(`More than ${budget.maxScanned} recurring dates scanned in one sync (total scan limit)`);
    if (++scanned > win.maxScanned) throw new SeriesLimitError(`Recurring event ${base.id} scanned more than ${win.maxScanned} occurrences (per-series scan limit)`);
    const startISO = toISO(occ, timeZone);
    if (!startISO) continue;
    const ms = Date.parse(startISO);
    if (ms > win.endMs) break;
    if (ms < win.startMs) continue;
    const key = `${base.id}::${startISO}`;
    if (skipKeys.has(key)) continue;
    if (instances.length >= win.max) throw new SeriesLimitError(`Recurring event ${base.id} has more than ${win.max} instances in the window (per-series limit)`);
    if (++budget.used > budget.max) throw new CapError(`More than ${budget.max} expanded recurring instances in one sync (total limit)`);
    const details = ev.getOccurrenceDetails(occ);
    instances.push({ ...base, start: startISO, end: toISO(details.endDate, timeZone), recurrenceId: startISO, sourceKey: key });
  }
  return instances;
}

export function parseICS(icsText, { timezone = DEFAULT_TIMEZONE, recurrenceWindow, now = new Date(), limits = {} } = {}) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  if (typeof icsText !== "string" || !icsText) throw new Error("parseICS: empty or non-text ICS body");
  const win = resolveWindow(recurrenceWindow, now);
  if (Buffer.byteLength(icsText) > cap.maxIcsBytes) throw new CapError(`ICS is larger than ${cap.maxIcsBytes} bytes`);
  const jcal = ICAL.parse(icsText);
  const root = new ICAL.Component(jcal);
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch { /* optional */ }
  }

  const stats = { vevents: 0, skipped: 0, duplicates: 0, recurringMasters: 0, expandedInstances: 0, cancelledOverrides: 0, truncated: 0, truncatedTitles: [] };
  const byKey = new Map();
  const add = event => {
    const existing = byKey.get(event.sourceKey);
    if (existing) { stats.duplicates++; byKey.set(event.sourceKey, preferred(existing, event)); }
    else byKey.set(event.sourceKey, event);
  };
  const masters = [];
  const budget = { used: 0, max: cap.maxTotalInstances, scanned: 0, maxScanned: cap.maxTotalScanned };
  const skipKeys = new Set(); // instance keys replaced by an override or removed by a cancelled override
  const vevents = root.getAllSubcomponents("vevent");
  if (vevents.length > cap.maxVevents) throw new CapError(`ICS has ${vevents.length} VEVENT entries; the limit is ${cap.maxVevents}`);
  for (const component of vevents) {
    stats.vevents++;
    let event = null;
    try { event = eventFromComponent(component, timezone); } catch { event = null; }
    if (!event) { stats.skipped++; continue; }
    if (event.recurrenceId) {
      skipKeys.add(event.sourceKey);
      if (event.status === "cancelled") { stats.cancelledOverrides++; continue; }
      add(event);
    } else if (component.hasProperty("rrule") || component.hasProperty("rdate")) {
      masters.push({ component, event });
    } else add(event);
  }
  for (const { component, event } of masters) {
    stats.recurringMasters++;
    let instances = [];
    try { instances = expandMaster(component, event, timezone, win, skipKeys, stats, budget); } catch (error) {
      if (error instanceof CapError) throw error;
      if (error instanceof SeriesLimitError) { stats.truncated++; stats.truncatedTitles.push(event.title); continue; }
      stats.skipped++; continue;
    }
    stats.expandedInstances += instances.length;
    for (const instance of instances) add(instance);
  }

  const events = [...byKey.values()].sort((a, b) => (a.start || "").localeCompare(b.start || "") || a.sourceKey.localeCompare(b.sourceKey));
  return { events, stats };
}

// Snapshot row for one event: [title, start, end, allDay (0/1), location].
// Description, status, sequence and last-modified are left out on purpose: a change in only those is not shown.
export const SNAPSHOT_FIELDS = ["title", "start", "end", "allDay", "location"];

export function snapshotRows(events) {
  const rows = {};
  for (const e of events) {
    if (e.status === "cancelled") continue;
    rows[e.sourceKey] = [e.title, e.start, e.end, e.allDay ? 1 : 0, e.location];
  }
  return rows;
}

// Start and end of the recurring-event window for a given moment, as ISO text.
export function windowBounds(recurrenceWindow, now = new Date()) {
  const w = resolveWindow(recurrenceWindow, now);
  return { start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() };
}
