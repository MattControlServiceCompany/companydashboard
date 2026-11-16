/* Version push (Matt 2026-11-16: an open tab learns of a new version when it is released, not by polling).
   ONE WebSocket to Supabase Realtime (Broadcast). The topic is per site origin ('ch-version:' + location.host), so
   localhost and the Netlify site never cross. The release step (tools/announce-version.js <host>) sends one broadcast
   {version}. This module only listens and calls onVersion(version); app/report-engine.js then re-reads site-ui.js
   (the one source of truth for the live version) and starts the swap when it is safe. No database table is read or written.
   The socket sends a Phoenix heartbeat every 25 s (keepalive only, no server data) and reconnects with backoff.
   A failed socket is silent: the checks on load, focus, visibility and page change still run. */
(function () {
  'use strict';
  var HEARTBEAT_MS = 25 * 1000;
  var BACKOFF_MIN_MS = 2000;
  var BACKOFF_MAX_MS = 60 * 1000;
  var started = false;

  function start(onVersion) {
    if (started || typeof WebSocket === 'undefined' || !window.CH_AUTH || !window.CH_AUTH.SUPABASE_URL) return;
    if (!/^https?:$/.test(location.protocol)) return; // file:// has no site to announce to
    started = true;
    var topic = 'realtime:ch-version:' + location.host;
    var url = window.CH_AUTH.SUPABASE_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(window.CH_AUTH.SUPABASE_ANON_KEY) + '&vsn=1.0.0';
    var ws = null;
    var hb = null;
    var retry = null;
    var backoff = BACKOFF_MIN_MS;
    var ref = 0;

    function send(t, event, payload) {
      try {
        ws.send(JSON.stringify({ topic: t, event: event, payload: payload, ref: String(++ref) }));
      } catch (e) {}
    }
    function connect() {
      retry = null;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return schedule();
      }
      ws.onopen = function () {
        backoff = BACKOFF_MIN_MS;
        send(topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } });
        hb = setInterval(function () {
          send('phoenix', 'heartbeat', {});
        }, HEARTBEAT_MS);
      };
      ws.onmessage = function (m) {
        var d;
        try {
          d = JSON.parse(m.data);
        } catch (e) {
          return;
        }
        if (d.topic === topic && d.event === 'broadcast' && d.payload && d.payload.event === 'version' && d.payload.payload) {
          try {
            onVersion(d.payload.payload.version);
          } catch (e) {}
        }
      };
      ws.onclose = function () {
        clearInterval(hb);
        hb = null;
        schedule();
      };
      ws.onerror = function () {}; // quiet: onclose follows and reconnects
    }
    function schedule() {
      if (retry) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    connect();
  }
  window.chVersionPush = { start: start };
})();
