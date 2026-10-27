'use strict';
// Tests for the calendar feed: reading the feed, the one diff function, the window edge, the 304 path,
// and the Netlify function. Synthetic data only. No network except a local JWKS server on 127.0.0.1.
// Run: node tools/test-calendar-feed.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const { diffSnapshots, historyRecord } = require(path.join(ROOT, 'app', 'calendar-diff.js'));

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}

const NOW = new Date('2026-10-27T15:00:00Z');
const FAKE_URL = 'https://calendar.google.com/' + 'calendar/ical/example.test_fake/public/basic.ics';

// --- synthetic ICS builders ----------------------------------------------------
function utc(d) {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
function vevent(e) {
  const L = ['BEGIN:VEVENT', 'UID:' + e.uid];
  L.push('DTSTAMP:20260101T000000Z');
  if (e.allDay) L.push('DTSTART;VALUE=DATE:' + e.allDay);
  else {
    L.push('DTSTART:' + e.start);
    L.push('DTEND:' + e.end);
  }
  L.push('SUMMARY:' + e.title);
  if (e.location) L.push('LOCATION:' + e.location);
  if (e.desc) L.push('DESCRIPTION:' + e.desc);
  L.push('SEQUENCE:' + (e.seq || 0));
  if (e.lm) L.push('LAST-MODIFIED:' + e.lm);
  if (e.rrule) L.push('RRULE:' + e.rrule);
  if (e.recId) L.push('RECURRENCE-ID:' + e.recId);
  if (e.status) L.push('STATUS:' + e.status);
  L.push('END:VEVENT');
  return L.join('\r\n');
}
function ics(events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//Test//EN',
    ...events.map(vevent),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
// Fixture A: 10 events. One all-day, one weekly series, one cancelled override of that series.
function fixtureA() {
  const ev = [];
  for (let i = 1; i <= 7; i++) {
    const day = String(10 + i).padStart(2, '0');
    ev.push({
      uid: 'evt-00' + i + '@example.test',
      title: 'Example Event ' + i,
      start: '202611' + day + 'T150000Z',
      end: '202611' + day + 'T160000Z',
      location: 'Room ' + i,
      desc: 'Plain text ' + i,
    });
  }
  ev.push({ uid: 'evt-allday@example.test', title: 'Example Holiday', allDay: '20261125' });
  ev.push({
    uid: 'evt-weekly@example.test',
    title: 'Example Weekly Meeting',
    start: '20261103T180000Z',
    end: '20261103T190000Z',
    rrule: 'FREQ=WEEKLY;COUNT=6',
  });
  ev.push({
    uid: 'evt-weekly@example.test',
    title: 'Example Weekly Meeting',
    start: '20261110T180000Z',
    end: '20261110T190000Z',
    recId: '20261110T180000Z',
    status: 'CANCELLED',
  });
  return ev;
}
function withLogin(address) {
  const u = new URL(address);
  u.username = 'name';
  return u.toString();
}
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function okResponse(text, headers) {
  return {
    status: 200,
    ok: true,
    headers: { get: (n) => (headers && headers[n.toLowerCase()]) || null },
    body: null,
    text: async () => text,
  };
}
function feedOf(text) {
  return async () => okResponse(text);
}

(async () => {
  const snapMod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions/lib/calendar/snapshot.mjs')).href);
  const fetchMod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions/lib/calendar/fetch-ics.mjs')).href);
  const { buildSnapshot, checkFeedUrl } = snapMod;
  const input = { icsUrl: FAKE_URL, timezone: 'America/Chicago' };

  const A = fixtureA();
  const snapA = await buildSnapshot(input, { fetchImpl: feedOf(ics(A)), now: NOW });

  await t('fixture A: count and keys (weekly series expands, cancelled override removed, all-day kept)', () => {
    // 7 single + 1 all-day + 6 weekly instances - 1 cancelled = 13
    assert.strictEqual(snapA.count, 13);
    assert.ok(snapA.events['evt-001@example.test']);
    assert.ok(snapA.events['evt-allday@example.test']);
    const weekly = Object.keys(snapA.events).filter((x) => x.startsWith('evt-weekly@example.test::'));
    assert.strictEqual(weekly.length, 5);
    assert.ok(!weekly.some((x) => x.includes('20261110') || x.includes('2026-11-10')));
    assert.strictEqual(snapA.events['evt-allday@example.test'][3], 1);
    assert.strictEqual(snapA.events['evt-001@example.test'][0], 'Example Event 1');
    assert.strictEqual(snapA.events['evt-001@example.test'][4], 'Room 1');
  });

  await t('same feed read twice gives an identical snapshot and zero changes', async () => {
    const again = await buildSnapshot(input, { fetchImpl: feedOf(ics(A)), now: NOW });
    assert.deepStrictEqual(again.events, snapA.events);
    const d = diffSnapshots(snapA, again);
    assert.strictEqual(d.added.length + d.removed.length + d.changed.length, 0);
    assert.strictEqual(d.unchanged, 13);
  });

  // Fixture B = A with 1 added, 1 removed, time moved, title edit, location edit, and description-only edit.
  const B = clone(A);
  B.push({
    uid: 'evt-new@example.test',
    title: 'Example New Event',
    start: '20261120T150000Z',
    end: '20261120T160000Z',
  });
  B.splice(
    B.findIndex((e) => e.uid === 'evt-007@example.test'),
    1,
  ); // removed
  B.find((e) => e.uid === 'evt-001@example.test').start = '20261111T160000Z'; // time moved
  B.find((e) => e.uid === 'evt-001@example.test').end = '20261111T170000Z';
  B.find((e) => e.uid === 'evt-002@example.test').title = 'Example Event 2 Renamed'; // title edit
  B.find((e) => e.uid === 'evt-003@example.test').location = 'Room 33'; // location edit
  B.find((e) => e.uid === 'evt-004@example.test').desc = 'Changed text only'; // ignored
  B.find((e) => e.uid === 'evt-004@example.test').seq = 3;
  B.find((e) => e.uid === 'evt-004@example.test').lm = '20261026T120000Z';
  const snapB = await buildSnapshot(input, { fetchImpl: feedOf(ics(B)), now: NOW });

  await t('diff A to B: exact added, removed, changed lists; unchanged is the rest', () => {
    const d = diffSnapshots(snapA, snapB);
    assert.deepStrictEqual(
      d.added.map((x) => x.key),
      ['evt-new@example.test'],
    );
    assert.deepStrictEqual(
      d.removed.map((x) => x.key),
      ['evt-007@example.test'],
    );
    assert.deepStrictEqual(d.changed.map((x) => x.key).sort(), [
      'evt-001@example.test',
      'evt-002@example.test',
      'evt-003@example.test',
    ]);
    const c1 = d.changed.find((x) => x.key === 'evt-001@example.test');
    assert.deepStrictEqual(Object.keys(c1.fields).sort(), ['end', 'start']);
    assert.strictEqual(c1.fields.start[0], '2026-11-11T15:00:00.000Z');
    assert.strictEqual(c1.fields.start[1], '2026-11-11T16:00:00.000Z');
    assert.deepStrictEqual(d.changed.find((x) => x.key === 'evt-002@example.test').fields, {
      title: ['Example Event 2', 'Example Event 2 Renamed'],
    });
    assert.deepStrictEqual(d.changed.find((x) => x.key === 'evt-003@example.test').fields, {
      location: ['Room 3', 'Room 33'],
    });
    assert.strictEqual(d.unchanged, 13 - 1 - 3); // 13 old events - 1 removed - 3 changed
    assert.strictEqual(d.total, snapB.count);
  });

  await t('ignore rules: description, sequence and last-modified changes alone are not changes', () => {
    const d = diffSnapshots(snapA, snapB);
    assert.ok(!d.changed.some((x) => x.key === 'evt-004@example.test'));
  });

  await t('all-day flag change is a change', async () => {
    const C = clone(A);
    const h = C.find((e) => e.uid === 'evt-allday@example.test');
    delete h.allDay;
    h.start = '20261125T060000Z';
    h.end = '20261125T060000Z';
    const sc = await buildSnapshot(input, { fetchImpl: feedOf(ics(C)), now: NOW });
    const d = diffSnapshots(snapA, sc);
    const ch = d.changed.find((x) => x.key === 'evt-allday@example.test');
    assert.ok(ch && ch.fields.allDay && ch.fields.allDay[0] === 1 && ch.fields.allDay[1] === 0);
  });

  await t('history record keeps exact counts and the lists', () => {
    const rec = historyRecord(diffSnapshots(snapA, snapB), '2026-10-27T15:00:00.000Z', 'calh_test');
    assert.deepStrictEqual(rec.counts, { added: 1, removed: 1, changed: 3, unchanged: 9, total: snapB.count });
    assert.strictEqual(rec.added[0].title, 'Example New Event');
    assert.strictEqual(rec.changed.length, 3);
  });

  await t('window edge: a weekly series read ten days apart shows no false added or removed', async () => {
    const daily = [
      {
        uid: 'evt-series@example.test',
        title: 'Example Weekly Series',
        start: '20240104T150000Z',
        end: '20240104T153000Z',
        rrule: 'FREQ=WEEKLY',
      },
    ];
    const text = ics(daily);
    const s1 = await buildSnapshot(input, { fetchImpl: feedOf(text), now: NOW });
    const s2 = await buildSnapshot(input, { fetchImpl: feedOf(text), now: new Date(NOW.getTime() + 10 * 86400000) });
    assert.notDeepStrictEqual(Object.keys(s1.events), Object.keys(s2.events)); // windows really differ
    const d = diffSnapshots(s1, s2);
    assert.strictEqual(d.added.length, 0, 'added ' + d.added.length);
    assert.strictEqual(d.removed.length, 0, 'removed ' + d.removed.length);
    assert.strictEqual(d.changed.length, 0);
    // Control: without the windows the same data DOES show false changes, so the guard is doing real work.
    const naive = diffSnapshots({ events: s1.events }, { events: s2.events });
    assert.ok(naive.added.length > 0 && naive.removed.length > 0);
  });

  await t('window edge: a real event removed inside the overlap still shows as removed', async () => {
    const s2 = await buildSnapshot(input, {
      fetchImpl: feedOf(ics(A.slice(1))),
      now: new Date(NOW.getTime() + 86400000),
    });
    const d = diffSnapshots(snapA, s2);
    assert.deepStrictEqual(
      d.removed.map((x) => x.key),
      ['evt-001@example.test'],
    );
  });

  await t('304 path: an unconditional request that gets 304 is an error, never "no change"', async () => {
    const f304 = async () => ({
      status: 304,
      ok: false,
      headers: { get: () => null },
      body: null,
      text: async () => '',
    });
    await assert.rejects(() => fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: f304 }), /304/);
    await assert.rejects(() => buildSnapshot(input, { fetchImpl: f304, now: NOW }), /304/);
  });

  await t('no-ETag path: a 200 reply with no ETag or Last-Modified header reads fully', async () => {
    const got = await fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: feedOf(ics(A)) });
    assert.strictEqual(got.notModified, false);
    assert.strictEqual(got.etag, null);
    assert.strictEqual(got.lastModifiedHeader, null);
    assert.ok(got.bytes > 100);
  });

  await t('non-calendar reply and HTTP errors are refused', async () => {
    await assert.rejects(() => buildSnapshot(input, { fetchImpl: feedOf('<html>no</html>'), now: NOW }), /not an ICS/);
    const f500 = async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
      body: null,
      text: async () => '',
    });
    await assert.rejects(() => buildSnapshot(input, { fetchImpl: f500, now: NOW }), /HTTP 500/);
  });

  await t('feed address guard: only https, calendar host, .ics path', () => {
    assert.ok(checkFeedUrl(FAKE_URL));
    for (const bad of [
      'http://calendar.google.com/x/basic.ics',
      'https://example.com/basic.ics',
      'https://calendar.google.com/x/basic.txt',
      'https://calendar.google.com.example.com/x.ics',
      withLogin(FAKE_URL),
      'https://calendar.google.com:8443/x.ics',
      'not a url',
      '',
    ]) {
      assert.throws(() => checkFeedUrl(bad), /feed address/, bad);
    }
  });

  await t('size: 7,300 events, snapshot under 2 MB, compressed under 400 KB, diff under 1 s', async () => {
    const big = [];
    for (let i = 0; i < 7300; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 3600000 * 3);
      big.push({
        uid: 'evt-big-' + i + '@example.test',
        title: 'Example Activity ' + i + ' Practice',
        start: utc(d),
        end: utc(new Date(d.getTime() + 3600000)),
        location: 'Example Field ' + (i % 40),
      });
    }
    const s1 = await buildSnapshot(input, { fetchImpl: feedOf(ics(big)), now: NOW });
    assert.ok(s1.count >= 7000, 'count ' + s1.count);
    const json = JSON.stringify({ fetchedAt: s1.fetchedAt, count: s1.count, window: s1.window, events: s1.events });
    assert.ok(json.length < 2 * 1024 * 1024, 'raw ' + json.length);
    assert.ok(zlib.gzipSync(json).length < 400 * 1024, 'gz ' + zlib.gzipSync(json).length);
    const edited = clone(big);
    edited[10].title = 'Example Activity Moved';
    const s2 = await buildSnapshot(input, { fetchImpl: feedOf(ics(edited)), now: NOW });
    const t0 = Date.now();
    const d = diffSnapshots(s1, s2);
    assert.ok(Date.now() - t0 < 1000);
    assert.strictEqual(d.changed.length, 1);
    assert.strictEqual(d.added.length + d.removed.length, 0);
  });

  // --- redirects, one long series, total budget ---------------------------------------------------
  const redirectTo = (loc) => async () => ({
    status: 302,
    ok: false,
    headers: { get: (n) => (n.toLowerCase() === 'location' ? loc : null) },
    body: null,
    text: async () => '',
  });
  const normMod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions/lib/calendar/normalize.mjs')).href);
  const SERIES_WINDOW = snapMod.RECURRENCE_WINDOW;

  await t('redirect: a redirect to another host is rejected and never requested', async () => {
    const seen = [];
    const f = async (u) => {
      seen.push(u);
      return redirectTo('https://example.com/evil.ics')();
    };
    await assert.rejects(() => fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: f }), /feed address/);
    assert.strictEqual(seen.length, 1);
    for (const loc of ['http://calendar.google.com/x/b.ics', 'https://calendar.google.com/x/b.txt']) {
      await assert.rejects(() => fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: redirectTo(loc) }), /feed address/);
    }
  });
  await t('redirect: a redirect on the calendar host is followed (relative address too)', async () => {
    const seen = [];
    const f = async (u, opts) => {
      seen.push(u);
      assert.strictEqual(opts.redirect, 'manual');
      return seen.length === 1
        ? redirectTo('https://calendar.google.com/calendar/ical/example.test_fake/public/second.ics')()
        : seen.length === 2
          ? redirectTo('/calendar/ical/example.test_fake/public/third.ics')()
          : okResponse(ics(A));
    };
    const got = await fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: f });
    assert.strictEqual(seen.length, 3);
    assert.ok(seen[2].endsWith('/third.ics'));
    assert.strictEqual(got.notModified, false);
  });
  await t('redirect: more than 3 redirects is rejected', async () => {
    let n = 0;
    const f = async () => {
      n++;
      return redirectTo(FAKE_URL)();
    };
    await assert.rejects(() => fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: f }), /too many redirects/);
    assert.strictEqual(n, 4); // first request + 3 followed redirects
  });
  await t('redirect: a final response.url on another host is rejected', async () => {
    const f = async () => ({ ...okResponse(ics(A)), url: 'https://example.com/x.ics' });
    await assert.rejects(() => fetchMod.fetchICS(FAKE_URL, {}, { force: true, fetchImpl: f }), /feed address/);
  });

  await t('long series: a daily series (1,095 dates) is left out alone; other events still sync', async () => {
    const withDaily = clone(A);
    withDaily.push({
      uid: 'evt-daily@example.test',
      title: 'Example Daily Series',
      start: '20240104T150000Z',
      end: '20240104T153000Z',
      rrule: 'FREQ=DAILY',
    });
    const snap = await buildSnapshot(input, { fetchImpl: feedOf(ics(withDaily)), now: NOW });
    assert.strictEqual(snap.count, 13);
    assert.strictEqual(snap.stats.truncated, 1);
    assert.deepStrictEqual(snap.leftOut, ['Example Daily Series']);
    assert.ok(!Object.keys(snap.events).some((x) => x.startsWith('evt-daily@')));
    assert.ok(snap.events['evt-001@example.test']);
  });
  await t('total budget: too many scanned dates in one sync fails the whole sync with a cap error', async () => {
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push({
        uid: 'evt-w' + i + '@example.test',
        title: 'Example Weekly ' + i,
        start: '20260105T150000Z',
        end: '20260105T153000Z',
        rrule: 'FREQ=WEEKLY;COUNT=20',
      });
    }
    const text = ics(many);
    const ok = normMod.parseICS(text, { recurrenceWindow: SERIES_WINDOW, now: NOW, limits: { maxTotalScanned: 1000 } });
    assert.strictEqual(ok.events.length, 400);
    assert.throws(
      () => normMod.parseICS(text, { recurrenceWindow: SERIES_WINDOW, now: NOW, limits: { maxTotalScanned: 100 } }),
      (e) => e instanceof normMod.CapError && /total scan limit/.test(e.message),
    );
  });

  // --- the Netlify function, with a real signed token and a local key server ----------------
  const { generateKeyPair, exportJWK, SignJWT } = require('jose');
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const keyServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => keyServer.listen(0, '127.0.0.1', r));
  try {
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.AUTHORIZED_USERS = 'tester@example.invalid';
    process.env.CH_TEST_JWKS_URL = 'http://127.0.0.1:' + keyServer.address().port + '/jwks';
    const token = async (email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
        .setIssuer('https://example.invalid/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(privateKey);
    const fnMod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions/calendar-fetch.mjs')).href);
    const handler = fnMod.makeHandler({ fetchImpl: feedOf(ics(A)), now: NOW });
    const call = async (headers, body, method) =>
      handler({ httpMethod: method || 'POST', headers: headers || {}, body: JSON.stringify(body || {}) });
    const authed = async () => ({ authorization: 'Bearer ' + (await token('tester@example.invalid')) });

    await t('function: no token gives 401', async () => {
      assert.strictEqual((await call({}, input)).statusCode, 401);
    });
    await t('function: valid token but address not on the allow list gives 403', async () => {
      const h = { authorization: 'Bearer ' + (await token('other@example.invalid')) };
      assert.strictEqual((await call(h, input)).statusCode, 403);
    });
    await t('function: wrong method gives 405', async () => {
      assert.strictEqual((await call(await authed(), input, 'GET')).statusCode, 405);
    });
    await t('function: non-https, wrong host and non-.ics path give 400', async () => {
      for (const u of [
        'http://calendar.google.com/x/basic.ics',
        'https://example.com/x/basic.ics',
        'https://calendar.google.com/x/basic.html',
      ]) {
        const r = await call(await authed(), { icsUrl: u, timezone: 'America/Chicago' });
        assert.strictEqual(r.statusCode, 400, u);
        assert.ok(!r.body.includes('example.com'), 'error text must not echo the address');
      }
    });
    await t('function: bad time zone gives 400', async () => {
      assert.strictEqual((await call(await authed(), { icsUrl: FAKE_URL, timezone: 'Nowhere/None' })).statusCode, 400);
    });
    await t('function: non-calendar body gives 502 with fixed text only', async () => {
      const bad = fnMod.makeHandler({ fetchImpl: feedOf('hello'), now: NOW });
      const r = await bad({ httpMethod: 'POST', headers: await authed(), body: JSON.stringify(input) });
      assert.strictEqual(r.statusCode, 502);
      assert.ok(!r.body.includes('example.test'));
    });
    await t('function: success returns the snapshot', async () => {
      const r = await call(await authed(), input);
      assert.strictEqual(r.statusCode, 200);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.ok, true);
      assert.strictEqual(b.snapshot.count, 13);
      assert.ok(b.snapshot.window.start < b.snapshot.window.end);
    });
  } finally {
    keyServer.close();
  }

  // --- repo guards ---------------------------------------------------------------------------------
  function walk(dir, out) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === '.git') continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p, out);
      else if (/\.(js|mjs|html|json)$/.test(f.name)) out.push(p);
    }
    return out;
  }
  const files = [
    ...walk(path.join(ROOT, 'app'), []),
    ...walk(path.join(ROOT, 'netlify'), []),
    ...walk(path.join(ROOT, 'tools'), []),
  ];

  await t('single diff function: exactly one definition of diffSnapshots in the code', () => {
    const defs = files.filter((f) => /function\s+diffSnapshots\s*\(/.test(fs.readFileSync(f, 'utf8')));
    assert.strictEqual(defs.length, 1, defs.join(', '));
    assert.ok(defs[0].endsWith('calendar-diff.js'));
  });
  await t(
    'repo reveals nothing: no feed link with a real calendar id (fake ids start with example) in app, netlify or tools',
    () => {
      const bad = files.filter((f) => /calendar\/ical\/(?!example)[A-Za-z0-9%._-]+\//.test(fs.readFileSync(f, 'utf8')));
      assert.deepStrictEqual(bad, []);
    },
  );
  await t('page open makes no call: project-calendar.js fetches only inside the sync function, no timers', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'project-calendar.js'), 'utf8');
    assert.strictEqual((src.match(/\bfetch\(/g) || []).length, 1);
    assert.ok(!/setInterval|setTimeout/.test(src));
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
