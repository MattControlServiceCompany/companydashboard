/* ══ THEME (single source) ══
   One function decides the effective theme (chTheme.effective). Every caller uses it.
   Stored choice: 'dark' | 'light' | 'system' in ch_settings.theme (and ch_theme). 'system' follows the OS live.
   data-theme on <html> is always the effective value ('dark' or 'light'); the stored choice never lands there. */
(function () {
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function stored() {
    try {
      var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
      var t = s.theme || localStorage.getItem('ch_theme');
      return t === 'light' || t === 'system' ? t : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  // The ONE rule: which theme is on screen for a stored choice.
  function effective(pref) {
    if (pref === 'light') return 'light';
    if (pref === 'system') return mq && mq.matches ? 'light' : 'dark';
    return 'dark';
  }

  // Paint the stored choice. Writes nothing to storage.
  function render() {
    var pref = stored();
    var eff = effective(pref);
    var root = document.documentElement;
    var changed = root.getAttribute('data-theme') !== eff;
    root.setAttribute('data-theme', eff);
    syncOnColors();
    if (document.querySelectorAll) {
      document.querySelectorAll('.theme-pill').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-theme') === pref);
      });
    }
    if (changed) {
      try {
        window.dispatchEvent(new CustomEvent('ch-theme-change', { detail: { theme: eff, pref: pref } }));
      } catch (e) {}
    }
  }

  // The user picked a mode: save it, then paint it.
  function apply(pref) {
    pref = pref === 'light' || pref === 'system' ? pref : 'dark';
    try {
      localStorage.setItem('ch_theme', pref);
      var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
      s.theme = pref;
      localStorage.setItem('ch_settings', JSON.stringify(s));
    } catch (e) {}
    render();
  }

  // THE ONE text-color rule (Matt, 2026-10-22): #ffffff on a dark fill, #000000 on a light fill.
  // textOnFills takes every color a fill shows (one for a solid fill, each gradient stop for a gradient).
  // If every stop agrees, that is the answer. If stops disagree, the average luminance of the stops decides.
  // tools/test-no-grey-text.js calls this same function (window.chTheme.textOnFills); do not write a second threshold.
  var LUMA_DARK_BELOW = 128;
  function toRgb(c) {
    if (c && typeof c === 'object') return c;
    var h = /^\s*#([0-9a-f]{6})\s*$/i.exec(c || '');
    if (h) {
      var n = parseInt(h[1], 16);
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
    }
    var m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }
  function luma(c) {
    return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  }
  function textOnFills(fills) {
    var l = [];
    (fills || []).forEach(function (f) {
      var c = toRgb(f);
      if (c) l.push(luma(c));
    });
    if (!l.length) return '#ffffff';
    var dark = l.map(function (x) { return x < LUMA_DARK_BELOW; });
    var allDark = dark.every(function (d) { return d; });
    var allLight = dark.every(function (d) { return !d; });
    if (allDark) return '#ffffff';
    if (allLight) return '#000000';
    var avg = l.reduce(function (a, x) { return a + x; }, 0) / l.length;
    return avg < LUMA_DARK_BELOW ? '#ffffff' : '#000000';
  }
  function onAccent(hex) {
    return textOnFills([hex]);
  }

  // Resolved value of a CSS variable on <html> (after the active theme's overrides).
  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // Publish the text color for each fill the site paints: --on-accent (solid accent), --on-brand (accent to teal gradient),
  // --on-em (solid em), --on-em-grad (em to em2 gradient). Call after the theme or the accent changes.
  function syncOnColors() {
    var root = document.documentElement;
    root.style.setProperty('--on-accent', textOnFills([tok('--accent') || tok('--em')]));
    root.style.setProperty('--on-brand', textOnFills([tok('--accent'), tok('--teal')]));
    root.style.setProperty('--on-em', textOnFills([tok('--em')]));
    root.style.setProperty('--on-em-grad', textOnFills([tok('--em'), tok('--em2')]));
  }

  function setAccentVars(hex) {
    var root = document.documentElement;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--em', hex);
    syncOnColors();
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return;
    var n = parseInt(m[1], 16);
    var rgb = (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
    root.style.setProperty('--accent-dim', 'rgba(' + rgb + ',0.12)');
    root.style.setProperty('--accent-glow', 'rgba(' + rgb + ',0.25)');
    root.style.setProperty('--em-dim', 'rgba(' + rgb + ',0.1)');
    root.style.setProperty('--em-glow', 'rgba(' + rgb + ',0.22)');
  }

  function applyAccent(hex) {
    setAccentVars(hex);
    try {
      var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
      s.accentColor = hex;
      localStorage.setItem('ch_settings', JSON.stringify(s));
    } catch (e) {}
  }

  // Follow the OS live while the stored choice is 'system'.
  if (mq) {
    var onOs = function () {
      if (stored() === 'system') render();
    };
    if (mq.addEventListener) mq.addEventListener('change', onOs);
    else if (mq.addListener) mq.addListener(onOs);
  }

  // Boot: paint before first frame, apply saved accent.
  render();
  try {
    var saved = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    if (saved.accentColor) setAccentVars(saved.accentColor);
  } catch (e) {}
  document.addEventListener('DOMContentLoaded', render); // pills exist now

  window.chTheme = { effective: effective, stored: stored, render: render, apply: apply, applyAccent: applyAccent, onAccent: onAccent, textOnFills: textOnFills, syncOnColors: syncOnColors };
})();
