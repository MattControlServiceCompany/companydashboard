/* Left sidebar mode: the ONE control for every page that has a left sidebar.
   Three modes, pinned by the user:
     expanded  full sidebar with names (stays open)
     collapsed sidebar hidden, the page uses the full width
     slim      a rail one icon wide, the name shows on hover
   The choice is stored in the per-user key ch_sidebar_mode (localStorage copy for the first paint, DB copy so
   it follows the user to any browser). With no saved choice the sidebar is expanded at 900 px and wider and
   collapsed below 900 px.
   This file loads in <head> (blocking) so the mode attribute is on <html> before the first paint.
   The CSS is in sidebar-rail.css. Pages mark each sidebar item with data-sb-icon="<name>" (icon names: ICONS). */
(function () {
  'use strict';
  var KEY = 'ch_sidebar_mode';
  var MODES = ['expanded', 'collapsed', 'slim'];
  var NARROW_PX = 900;
  var root = document.documentElement;
  var pendingPush = false;

  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
    chart: '<path d="M4 20h16"/><path d="M6 20v-7M12 20V5M18 20v-10"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    phone:
      '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    dot: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  };

  // The three-way selector: picture of the page with the sidebar drawn the way the mode shows it.
  var MODE_UI = [
    {
      mode: 'expanded',
      title: 'Full sidebar: icons and names, stays open',
      paths: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M11 4v16"/><path d="M3 4h8v16H3z" fill="currentColor" fill-opacity="0.35"/>',
    },
    {
      mode: 'slim',
      title: 'Narrow sidebar: icons only (point at an icon to see its name)',
      paths: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16"/><path d="M3 4h4v16H3z" fill="currentColor" fill-opacity="0.35"/>',
    },
    {
      mode: 'collapsed',
      title: 'Hide the sidebar: the page uses the full width',
      paths: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
    },
  ];

  function svg(inner, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      inner + '</svg>'
    );
  }

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      if (v && v.charAt(0) === '"') v = JSON.parse(v);
      return MODES.indexOf(v) >= 0 ? v : null;
    } catch (e) {
      return null;
    }
  }
  function get() {
    return stored() || (window.innerWidth < NARROW_PX ? 'collapsed' : 'expanded');
  }

  function syncTitles(mode) {
    document.querySelectorAll('.sidebar [data-sb-icon]').forEach(function (el) {
      var t = el.querySelector('.s-txt');
      var label = t ? t.textContent.trim() : '';
      if (mode === 'slim' && label && (!el.hasAttribute('title') || el.hasAttribute('data-sb-title'))) {
        el.setAttribute('title', label);
        el.setAttribute('data-sb-title', '1');
        el.setAttribute('aria-label', label);
      } else if (mode !== 'slim' && el.hasAttribute('data-sb-title')) {
        el.removeAttribute('title');
        el.removeAttribute('data-sb-title');
        el.removeAttribute('aria-label');
      }
    });
  }

  function syncControl(mode) {
    document.querySelectorAll('#sbModeCtl .sb-mode-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function apply() {
    var mode = get();
    root.setAttribute('data-sb-mode', mode);
    syncControl(mode);
    syncTitles(mode);
  }

  function pushToDb(mode) {
    if (window.DB && typeof window.DB.isReady === 'function' && window.DB.isReady()) {
      pendingPush = false;
      try {
        window.DB.set(KEY, mode);
      } catch (e) {
        pendingPush = true;
      }
    } else {
      pendingPush = true;
    }
  }

  function set(mode) {
    if (MODES.indexOf(mode) < 0) return;
    try {
      localStorage.setItem(KEY, mode);
    } catch (e) {}
    pushToDb(mode);
    apply();
  }

  // Put the icon and a label wrapper in every marked sidebar item.
  function decorate() {
    document.querySelectorAll('.sidebar [data-sb-icon]').forEach(function (el) {
      var ico = el.querySelector('.s-ico');
      if (!ico) {
        ico = document.createElement('span');
        ico.className = 's-ico';
        el.insertBefore(ico, el.firstChild);
      }
      var inner = ICONS[el.getAttribute('data-sb-icon')];
      if (inner) ico.innerHTML = svg(inner, 18);
      ico.setAttribute('aria-hidden', 'true');
      if (!el.querySelector('.s-txt')) {
        Array.prototype.slice.call(el.childNodes).forEach(function (n) {
          if (n.nodeType === 3 && n.nodeValue.trim()) {
            var s = document.createElement('span');
            s.className = 's-txt';
            n.parentNode.insertBefore(s, n);
            s.appendChild(n);
          }
        });
      }
    });
  }

  function buildControl() {
    if (document.getElementById('sbModeCtl')) return;
    var host = document.querySelector('.dept-nav') || document.querySelector('.nav-bar');
    if (!host) return;
    var ctl = document.createElement('div');
    ctl.id = 'sbModeCtl';
    ctl.className = 'sb-mode';
    ctl.setAttribute('role', 'group');
    ctl.setAttribute('aria-label', 'Sidebar view');
    MODE_UI.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sb-mode-btn';
      b.setAttribute('data-mode', m.mode);
      b.title = m.title;
      b.setAttribute('aria-label', m.title);
      b.innerHTML = svg(m.paths, 18);
      b.onclick = function () {
        set(m.mode);
      };
      ctl.appendChild(b);
    });
    host.insertBefore(ctl, host.firstChild);
  }

  // The saved copy in the DB (follows the user to other browsers) wins once the DB is ready.
  function reconcileWithDb() {
    if (!window.DB || typeof window.DB.get !== 'function') return;
    if (pendingPush) {
      pushToDb(get());
      return;
    }
    var v = window.DB.get(KEY);
    if (MODES.indexOf(v) >= 0 && v !== stored()) {
      try {
        localStorage.setItem(KEY, v);
      } catch (e) {}
      apply();
    }
  }

  function init() {
    if (!document.querySelector('.sidebar')) return;
    decorate();
    buildControl();
    apply();
    window.addEventListener('dbReady', reconcileWithDb);
    if (window.DB && typeof window.DB.isReady === 'function' && window.DB.isReady()) reconcileWithDb();
  }

  window.SidebarMode = { get: get, set: set, refresh: apply, modes: MODES };
  apply(); // before the first paint
  window.addEventListener('resize', apply);
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
