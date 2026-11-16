// app/site-events.js
//
// Site event log (Matt 2026-11-16: "the site records what happens in each open tab, so Claude can read it from the shell").
// ONE global, window.chLog(event, detail): queues a small JSON event. A batch goes to the Supabase table
// public.ch_site_events (REST POST /rest/v1/ch_site_events) with the signed-in session token (CH_AUTH.getToken),
// the URL and the publishable key from app/ch-auth.js. Read it with tools/read-site-events.js (docs/OPERATIONS.md).
//
// Rules:
//  - Never blocks the UI and never throws. A failed POST is dropped without a message (no retry loop, no console output).
//  - ONE timer, only while events wait: a batch is sent 10 s after the first queued event, and on pagehide /
//    tab hidden (fetch keepalive). Nothing is sent when the queue is empty.
//  - At most 200 events per tab per hour. More are dropped.
//  - Callers pass facts only: versions, page names, error text, status words. Never bill data, client figures, keys or tokens.
//  - Events with no sign-in session stay in the queue (at most 200) until a token exists.
// Also records, from here: uncaught page errors (page-error), unhandled rejections (unhandled-rejection), and one
// page-load event (trigger first-load | manual-reload | after-version-swap).
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.chLog) return;

  var FLUSH_MS = 10 * 1000;
  var MAX_PER_HOUR = 200;
  var MAX_QUEUE = 200;
  var BATCH = 50;
  var TEXT_MAX = 300;
  var _queue = [];
  var _accepted = []; // epoch ms of events accepted in the last hour (rate limit)
  var _timer = null;
  var _errSeen = {}; // same error text and place: at most 3 events per page load

  function _clip(v) {
    if (typeof v === 'string') return v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v;
    return v;
  }
  function _clean(detail) {
    if (!detail || typeof detail !== 'object') return null;
    var out = {};
    Object.keys(detail).forEach(function (k) {
      var v = detail[k];
      if (v === undefined || typeof v === 'function') return;
      out[k] = _clip(v);
    });
    return out;
  }
  function _version() {
    try {
      return (typeof RELEASE_NOTES !== 'undefined' && RELEASE_NOTES[0] && RELEASE_NOTES[0].v) || localStorage.getItem('ch_last_seen_version') || '';
    } catch (e) {
      return '';
    }
  }
  function _page() {
    try {
      var v = document.querySelector('.view.active');
      var id = (v && v.id) || '';
      return window._activeProjTab ? id + '/' + window._activeProjTab : id;
    } catch (e) {
      return '';
    }
  }
  function _row(event, detail) {
    var email = '';
    try {
      email = (window.CH_AUTH && window.CH_AUTH.getEmail && window.CH_AUTH.getEmail()) || '';
    } catch (e) {}
    return { ts: new Date().toISOString(), email: email, host: location.host, version: _version(), page: _page(), event: String(event).slice(0, 80), detail: _clean(detail) };
  }

  function chLog(event, detail) {
    try {
      var now = Date.now();
      while (_accepted.length && now - _accepted[0] > 3600 * 1000) _accepted.shift();
      if (_accepted.length >= MAX_PER_HOUR || _queue.length >= MAX_QUEUE) return;
      _accepted.push(now);
      _queue.push(_row(event, detail));
      if (!_timer) _timer = setTimeout(_flush, FLUSH_MS);
    } catch (e) {}
  }

  function _flush(useKeepalive) {
    _timer = null;
    try {
      if (!_queue.length) return;
      var A = window.CH_AUTH;
      var token = A && A.getToken && A.getToken();
      if (!token || !A.SUPABASE_URL || !A.SUPABASE_ANON_KEY) return; // signed out: keep the events, try at the next flush
      while (_queue.length) {
        var rows = _queue.splice(0, BATCH);
        rows.forEach(function (r) {
          // The first events are written before the release notes and the sign-in are ready: fill the blanks at send time.
          r.version = r.version || _version();
          r.email = r.email || (A.getEmail && A.getEmail()) || '';
        });
        fetch(A.SUPABASE_URL + '/rest/v1/ch_site_events', {
          method: 'POST',
          headers: { apikey: A.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(rows),
          keepalive: useKeepalive === true,
        }).then(
          function () {},
          function () {},
        );
      }
    } catch (e) {}
  }
  function _flushNow() {
    while (_queue.length) {
      var before = _queue.length;
      _flush(true);
      if (_queue.length >= before) break; // nothing was sent (signed out)
    }
  }
  window.addEventListener('pagehide', _flushNow);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) _flushNow();
  });

  function _errKey(msg, file, line) {
    var k = msg + '|' + file + '|' + line;
    _errSeen[k] = (_errSeen[k] || 0) + 1;
    return _errSeen[k] <= 3;
  }
  function _base(u) {
    return String(u || '').replace(/[?#].*$/, '').split('/').slice(-2).join('/');
  }
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window) return; // a failed image or script tag is not a page error
    var msg = _clip(String((e && e.message) || (e && e.error && e.error.message) || 'error'));
    var file = _base(e && e.filename);
    if (_errKey(msg, file, e && e.lineno)) chLog('page-error', { message: msg, file: file, line: e && e.lineno, col: e && e.colno });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = _clip(String((r && r.message) || r || 'rejection'));
    if (_errKey(msg, 'rejection', 0)) chLog('unhandled-rejection', { message: msg });
  });

  var trigger = 'first-load';
  try {
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (sessionStorage.getItem('ch_update_reload')) trigger = 'after-version-swap';
    else if (nav && nav.type === 'reload') trigger = 'manual-reload';
  } catch (e) {}
  chLog('page-load', { trigger: trigger });

  // What a report is, for the report-generated event: the type and the style only (no client name, no figures).
  // Types: a data flag that starts with "_" (_ashrae, _soo, _utilityAudit...), else the period type (quarterly, annual).
  function chReportKind(data) {
    var d = data || {};
    var type = '';
    Object.keys(d).some(function (k) {
      if (k.charAt(0) === '_' && d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) && k !== '_ashrae') return !!(type = k.slice(1));
      return false;
    });
    if (d._ashrae) type = 'ashrae-' + (d._ashrae.type || '');
    else if (!type && d.period && d.period.type) type = String(d.period.type);
    var style = d._ashrae && d._ashrae.type !== 'proposal' ? (/Detailed style/.test(d._ashrae.title || '') ? 'detailed' : 'simple') : '';
    return { type: type, style: style };
  }

  window.chLog = chLog;
  window.chReportKind = chReportKind;
})();
