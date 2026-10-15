/* Sidebar icon rail: open/close behavior. CSS is in sidebar-rail.css.
   Shared by every page that has a .sidebar inside .app-wrap. */
(function () {
  'use strict';
  var mq = window.matchMedia('(min-width: 900px) and (max-width: 1599px)');
  var CLOSE_DELAY_MS = 250;
  var sb = null;
  var timer = null;

  // Split each nav item into an icon and a text part, so CSS can hide the text in the rail.
  function prepareItems() {
    var items = sb.querySelectorAll('.s-item, .sb-settings-btn, .rn-whats-new-btn');
    Array.prototype.forEach.call(items, function (el) {
      if (el.getAttribute('data-rail-ready')) return;
      el.setAttribute('data-rail-ready', '1');
      var ico = el.querySelector('.s-ico');
      var label = '';
      if (ico) {
        Array.prototype.slice.call(el.childNodes).forEach(function (n) {
          if (n.nodeType === 3 && n.nodeValue.trim()) {
            label += n.nodeValue.trim() + ' ';
            var s = document.createElement('span');
            s.className = 'rail-txt';
            s.textContent = n.nodeValue;
            el.replaceChild(s, n);
          }
        });
      } else {
        var first = el.firstChild;
        if (!first || first.nodeType !== 3) return;
        var m = first.nodeValue.match(/^\s*(\S+)\s+([\s\S]*)$/);
        if (!m) return;
        var i = document.createElement('span');
        i.className = 's-ico';
        i.textContent = m[1];
        var t = document.createElement('span');
        t.className = 'rail-txt';
        t.textContent = ' ' + m[2];
        label = m[2];
        el.replaceChild(t, first);
        el.insertBefore(i, t);
      }
      if (!el.title && label.trim()) el.title = label.trim();
    });
  }

  function holdOpen() {
    return !!document.getElementById('siteDataMenu');
  }
  function open() {
    if (!mq.matches) return;
    clearTimeout(timer);
    sb.classList.add('rail-open');
  }
  function close() {
    clearTimeout(timer);
    sb.classList.remove('rail-open');
  }
  function closeSoon() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (holdOpen()) return closeSoon();
      close();
    }, CLOSE_DELAY_MS);
  }

  function init() {
    sb = document.querySelector('.app-wrap > .sidebar');
    if (!sb) return;
    prepareItems();
    sb.addEventListener('mouseenter', open);
    sb.addEventListener('mouseleave', function () {
      if (mq.matches) closeSoon();
    });
    sb.addEventListener('focusin', open);
    sb.addEventListener('click', open);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sb.classList.contains('rail-open') && !holdOpen()) {
        close();
        if (sb.contains(document.activeElement)) document.activeElement.blur();
      }
    });
    document.addEventListener(
      'mousedown',
      function (e) {
        if (!sb.classList.contains('rail-open')) return;
        if (sb.contains(e.target) || (e.target.closest && e.target.closest('#siteDataMenu'))) return;
        close();
      },
      true,
    );
    document.addEventListener(
      'touchstart',
      function (e) {
        if (sb.classList.contains('rail-open') && !sb.contains(e.target)) close();
      },
      true,
    );
    var onMq = function () {
      if (!mq.matches) close();
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else mq.addListener(onMq);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
