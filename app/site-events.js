// app/site-events.js
//
// Site event log (Matt 2026-11-16: "the site records what happens in each open tab, so Claude can read it from the shell").
// ONE global, window.chLog(event, detail): queues a small JSON event. A batch is appended to ONE key per month,
// en_site_events_YYYY-MM (a list, newest first, newest SyncClassification.EVENT_LOG_MAX = 2,000 kept), written with
// DB.set, the same path as every other synced key (app/db.js: kv-sync function, per-key version check, merge by id when
// two tabs or users write the same month). Read it with tools/read-site-events.js (docs/OPERATIONS.md).
//
// Rules:
//  - Never blocks the UI and never throws. A write that cannot be sent is dropped without a message (app/db.js
//    _enqueueWrite: no queue, no retry, no toast). The local list stays, so the next batch carries those events.
//  - ONE timer, only while events wait: a batch is written 30 s after the first queued event, never more than one write
//    per 30 s per tab. A tab that is hidden writes at the same pace; a closing tab (pagehide) writes once more.
//    Nothing is written when the queue is empty or the data store is not ready.
//  - Events that wait are also kept in this tab's sessionStorage (ch_event_pending), so a page that is replaced (a version
//    swap loads a new frame in the same tab) hands them on: the new page adopts them and writes them in its first batch.
//  - At most 200 events per tab per hour. More are dropped.
//  - Callers pass facts only: versions, page names, error text, status words. Never bill data, client figures, keys or tokens.
// Also records, from here: uncaught page errors (page-error), unhandled rejections (unhandled-rejection), and one
// page-load event (trigger first-load | manual-reload | after-version-swap).
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.chLog) return;

  var FLUSH_MS = 30 * 1000;
  var MAX_PER_HOUR = 200;
  var MAX_QUEUE = 200;
  var TEXT_MAX = 300;
  var _queue = [];
  var _lastWrite = 0; // epoch ms of the last write of this tab
  var PENDING_KEY = 'ch_event_pending';
  function _persist() {
    try {
      if (_queue.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(_queue));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }
  try {
    var _adopt = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
    if (Array.isArray(_adopt)) _queue = _adopt.filter(function (r) { return r && typeof r.id === 'string' && typeof r.ts === 'string'; }).slice(-200);
  } catch (e) {}
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
    return { id: 'ev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: new Date().toISOString(), email: email, host: location.host, version: _version(), page: _page(), event: String(event).slice(0, 80), detail: _clean(detail) };
  }

  function chLog(event, detail) {
    try {
      var now = Date.now();
      while (_accepted.length && now - _accepted[0] > 3600 * 1000) _accepted.shift();
      if (_accepted.length >= MAX_PER_HOUR || _queue.length >= MAX_QUEUE) return;
      _accepted.push(now);
      _queue.push(_row(event, detail));
      _persist();
      if (!_timer) _timer = setTimeout(_flush, FLUSH_MS);
    } catch (e) {}
  }

  // force = true (pagehide): write now, even inside the 30 s gap.
  function _flush(force) {
    if (_timer) clearTimeout(_timer);
    _timer = null;
    try {
      if (!_queue.length) return;
      var D = window.DB;
      var SC = window.SyncClassification;
      if (!D || !SC || !D.isReady || !D.isReady()) {
        _timer = setTimeout(_flush, FLUSH_MS); // data store not ready yet: wait
        return;
      }
      var gap = FLUSH_MS - (Date.now() - _lastWrite);
      if (force !== true && gap > 0) {
        _timer = setTimeout(_flush, gap);
        return;
      }
      var rows = _queue.splice(0);
      _persist();
      var byKey = {};
      rows.forEach(function (r) {
        // The first events are written before the release notes and the sign-in are ready: fill the blanks at write time.
        r.version = r.version || _version();
        r.email = r.email || (window.CH_AUTH && window.CH_AUTH.getEmail && window.CH_AUTH.getEmail()) || '';
        (byKey[SC.EVENT_LOG_PREFIX + r.ts.slice(0, 7)] = byKey[SC.EVENT_LOG_PREFIX + r.ts.slice(0, 7)] || []).push(r);
      });
      _lastWrite = Date.now();
      Object.keys(byKey).forEach(function (key) {
        var cur = D.get(key, []);
        cur = Array.isArray(cur) ? cur : [];
        var have = {};
        cur.forEach(function (e) { if (e && e.id) have[e.id] = true; });
        var add = byKey[key].filter(function (r) { return !have[r.id]; }); // an adopted event may already be in the list
        var p = D.set(key, SC.capEventList(cur.concat(add)), 'auto: site event log');
        if (p && p.then) p.then(function () {}, function () {});
      });
    } catch (e) {}
  }
  function _flushNow() {
    _flush(true);
  }
  window.addEventListener('pagehide', _flushNow);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) _flush(false);
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
