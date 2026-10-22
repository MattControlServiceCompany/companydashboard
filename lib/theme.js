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

  // Text color that is readable on an accent fill: white on a dark fill, black on a light fill.
  function onAccent(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    var n = parseInt(m[1], 16);
    var luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return luma < 150 ? '#ffffff' : '#000000';
  }

  function setAccentVars(hex) {
    var root = document.documentElement;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--em', hex);
    root.style.setProperty('--on-accent', onAccent(hex));
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

  window.chTheme = { effective: effective, stored: stored, render: render, apply: apply, applyAccent: applyAccent, onAccent: onAccent };
})();
