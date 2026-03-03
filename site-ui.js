/* ═══════════════════════════════════════════════════
   SITE-UI.JS — Shared CompanyHub UI Logic
   Clock, Backup/Restore, Reset, Settings, Help, Theming
═══════════════════════════════════════════════════ */

(function(){
  'use strict';

  /* ── COLOR PRESETS ── */
  const COLOR_PRESETS = [
    { name:'Blue',    hex:'#3b82f6' },
    { name:'Teal',    hex:'#14b8a6' },
    { name:'Violet',  hex:'#8b5cf6' },
    { name:'Rose',    hex:'#f43f5e' },
    { name:'Amber',   hex:'#f59e0b' },
    { name:'Emerald', hex:'#10b981' },
    { name:'Sky',     hex:'#0ea5e9' },
    { name:'Orange',  hex:'#f97316' },
  ];

  const DEFAULT_SETTINGS = {
    accentColor: '#3b82f6',
    defaultLoginScreen: 'index',
  };

  /* ── LOAD / SAVE SETTINGS ── */
  function loadSettings() {
    try {
      const s = localStorage.getItem('ch_settings');
      return s ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(s)) : Object.assign({}, DEFAULT_SETTINGS);
    } catch(e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(settings) {
    localStorage.setItem('ch_settings', JSON.stringify(settings));
  }

  /* ── APPLY ACCENT COLOR ── */
  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return { r, g, b };
  }
  function applyAccentColor(hex) {
    const root = document.documentElement;
    const rgb = hexToRgb(hex);
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-dim', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.12)');
    root.style.setProperty('--accent-glow', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.25)');

    // Also update --blue and --blue-dim/--blue-glow for pages that still use --blue
    root.style.setProperty('--blue', hex);
    root.style.setProperty('--blue-dim', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.12)');
    root.style.setProperty('--blue-glow', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.25)');

    // Update --em and --em-dim for energy page compatibility
    root.style.setProperty('--em', hex);
    root.style.setProperty('--em-dim', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.1)');
    root.style.setProperty('--em-glow', 'rgba('+rgb.r+','+rgb.g+','+rgb.b+',0.22)');
  }

  /* ── CLOCK ── */
  function updateClock() {
    var el = document.getElementById('sb-clock');
    var elDate = document.getElementById('sb-date');
    if (!el || !elDate) return;
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    var timeStr = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    el.textContent = timeStr;

    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dateStr = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
    elDate.textContent = dateStr;
  }

  /* ── BACKUP / RESTORE ── */
  function backupData() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      data[key] = localStorage.getItem(key);
    }
    // Also grab sessionStorage (except user session)
    for (var j = 0; j < sessionStorage.length; j++) {
      var skey = sessionStorage.key(j);
      if (skey !== 'ch_user') {
        data['__session__' + skey] = sessionStorage.getItem(skey);
      }
    }
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'companyhub-backup-' + new Date().toISOString().split('T')[0] + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('Backup downloaded');
  }

  function restoreData() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = function(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(ev) {
        try {
          var data = JSON.parse(ev.target.result);
          Object.keys(data).forEach(function(key) {
            if (key.startsWith('__session__')) {
              sessionStorage.setItem(key.replace('__session__', ''), data[key]);
            } else {
              localStorage.setItem(key, data[key]);
            }
          });
          if (typeof showToast === 'function') showToast('Data restored — reloading...');
          setTimeout(function(){ location.reload(); }, 1200);
        } catch(err) {
          if (typeof showToast === 'function') showToast('Invalid backup file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  /* ── RESET DATA ── */
  function resetData() {
    if (!confirm('Are you sure you want to reset all data? This cannot be undone.')) return;
    localStorage.clear();
    sessionStorage.clear();
    if (typeof showToast === 'function') showToast('All data reset — reloading...');
    setTimeout(function(){ location.reload(); }, 1200);
  }

  /* ── BUILD SIDEBAR BOTTOM ── */
  function buildSidebarBottom() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // Wrap existing sidebar content in sidebar-top
    var existingContent = sidebar.innerHTML;
    sidebar.innerHTML = '<div class="sidebar-top">' + existingContent + '</div>';

    // Create bottom section
    var bottom = document.createElement('div');
    bottom.className = 'sidebar-bottom';
    bottom.innerHTML =
      '<button class="sb-settings-btn" onclick="window.__siteUI.openSettings()">&#9881; Settings</button>' +
      '<div class="sb-divider"></div>' +
      '<div class="sb-clock" id="sb-clock">--:-- --</div>' +
      '<div class="sb-date" id="sb-date">Loading...</div>' +
      '<div class="sb-btn-row">' +
        '<button class="sb-btn" onclick="window.__siteUI.backupData()" title="Backup all data">Backup</button>' +
        '<button class="sb-btn" onclick="window.__siteUI.restoreData()" title="Restore from backup">Restore</button>' +
      '</div>' +
      '<button class="sb-btn danger" style="width:100%" onclick="window.__siteUI.resetData()">Reset Data</button>';
    sidebar.appendChild(bottom);
  }

  /* ── BUILD HELP BUTTON ── */
  function buildHelpButton() {
    var tRight = document.querySelector('.t-right');
    if (!tRight) return;
    // Insert help button before the user-chip (first child)
    var helpBtn = document.createElement('button');
    helpBtn.className = 'help-btn';
    helpBtn.title = 'Help';
    helpBtn.textContent = '?';
    helpBtn.onclick = function(){ window.__siteUI.openHelp(); };
    tRight.insertBefore(helpBtn, tRight.firstChild);
  }

  /* ── SETTINGS MODAL ── */
  function buildSettingsModal() {
    var overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settingsOverlay';
    overlay.onclick = function(e){ if(e.target===overlay) closeSettings(); };

    var settings = loadSettings();

    var swatchesHTML = COLOR_PRESETS.map(function(c){
      var isActive = settings.accentColor === c.hex ? ' active' : '';
      return '<div class="color-swatch'+isActive+'" data-color="'+c.hex+'" style="background:'+c.hex+'" title="'+c.name+'"></div>';
    }).join('');

    var loginOptions = [
      { value:'index', label:'Dashboard (index.html)' },
      { value:'service-department', label:'Service Department' },
      { value:'energy-department', label:'Energy Department' },
    ];
    var loginSelectHTML = loginOptions.map(function(o){
      var sel = settings.defaultLoginScreen === o.value ? ' selected' : '';
      return '<option value="'+o.value+'"'+sel+'>'+o.label+'</option>';
    }).join('');

    overlay.innerHTML =
      '<div class="settings-modal">' +
        '<div class="settings-hdr">' +
          '<span class="settings-title">&#9881; Settings</span>' +
          '<button class="settings-x" onclick="window.__siteUI.closeSettings()">&#10005;</button>' +
        '</div>' +
        '<div class="settings-body">' +
          '<div class="settings-section">' +
            '<div class="settings-section-title">Accent Color</div>' +
            '<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">' +
              '<div class="color-swatches" id="colorSwatches">' + swatchesHTML + '</div>' +
              '<div class="custom-color-row">' +
                '<input type="color" class="custom-color-input" id="customColorInput" value="'+settings.accentColor+'">' +
                '<span class="custom-color-label">Custom color</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="settings-section">' +
            '<div class="settings-section-title">Default Login Screen</div>' +
            '<div class="settings-row">' +
              '<div>' +
                '<div class="settings-row-label">Landing page after sign-in</div>' +
                '<div class="settings-row-sub">Choose which page opens by default</div>' +
              '</div>' +
              '<select class="settings-select" id="defaultLoginSelect">' + loginSelectHTML + '</select>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Swatch click handlers
    var swatches = overlay.querySelectorAll('.color-swatch');
    swatches.forEach(function(sw){
      sw.onclick = function(){
        swatches.forEach(function(s){ s.classList.remove('active'); });
        sw.classList.add('active');
        var color = sw.getAttribute('data-color');
        applyAccentColor(color);
        document.getElementById('customColorInput').value = color;
        var s = loadSettings(); s.accentColor = color; saveSettings(s);
      };
    });

    // Custom color input
    var customInput = document.getElementById('customColorInput');
    customInput.oninput = function(){
      var color = customInput.value;
      swatches.forEach(function(s){ s.classList.remove('active'); });
      // Check if matches a preset
      swatches.forEach(function(s){
        if(s.getAttribute('data-color').toLowerCase() === color.toLowerCase()) s.classList.add('active');
      });
      applyAccentColor(color);
      var s = loadSettings(); s.accentColor = color; saveSettings(s);
    };

    // Default login select
    var loginSelect = document.getElementById('defaultLoginSelect');
    loginSelect.onchange = function(){
      var s = loadSettings(); s.defaultLoginScreen = loginSelect.value; saveSettings(s);
    };
  }

  function openSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (overlay) overlay.classList.add('open');
  }
  function closeSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (overlay) overlay.classList.remove('open');
  }

  /* ── HELP MODAL ── */
  function buildHelpModal() {
    var overlay = document.createElement('div');
    overlay.className = 'help-overlay';
    overlay.id = 'helpOverlay';
    overlay.onclick = function(e){ if(e.target===overlay) closeHelp(); };

    overlay.innerHTML =
      '<div class="help-modal">' +
        '<div class="help-hdr">' +
          '<span class="help-title">&#10068; Help</span>' +
          '<button class="help-x" onclick="window.__siteUI.closeHelp()">&#10005;</button>' +
        '</div>' +
        '<div class="help-body">' +
          '<div class="help-item">' +
            '<div class="help-item-title">Navigation</div>' +
            '<div class="help-item-desc">Use the top tab bar to switch between Dashboard, Service Department, and Energy Department. The sidebar provides section-specific navigation within each department.</div>' +
          '</div>' +
          '<div class="help-item">' +
            '<div class="help-item-title">Settings</div>' +
            '<div class="help-item-desc">Click Settings in the sidebar bottom to change accent colors and set your default login screen.</div>' +
          '</div>' +
          '<div class="help-item">' +
            '<div class="help-item-title">Backup &amp; Restore</div>' +
            '<div class="help-item-desc">Use the Backup button to download all your data as a JSON file. Use Restore to load a previously saved backup.</div>' +
          '</div>' +
          '<div class="help-item">' +
            '<div class="help-item-title">Reset Data</div>' +
            '<div class="help-item-desc">Clears all local data and settings. This action cannot be undone.</div>' +
          '</div>' +
          '<div class="help-item">' +
            '<div class="help-item-title">Microsoft 365 Sign-In</div>' +
            '<div class="help-item-desc">Sign in with your company M365 account for live Outlook calendar sync. Demo mode is available without credentials.</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
  }

  function openHelp() {
    var overlay = document.getElementById('helpOverlay');
    if (overlay) overlay.classList.add('open');
  }
  function closeHelp() {
    var overlay = document.getElementById('helpOverlay');
    if (overlay) overlay.classList.remove('open');
  }

  /* ── DEFAULT LOGIN REDIRECT ── */
  function checkDefaultLogin() {
    var settings = loadSettings();
    var defaultPage = settings.defaultLoginScreen || 'index';
    var currentPage = location.pathname.split('/').pop().replace('.html','') || 'index';
    // Only redirect from the login page (index) after successful login
    // This is called from enterApp — we expose it globally
    if (currentPage === 'index' && defaultPage !== 'index') {
      var user = sessionStorage.getItem('ch_user');
      if (user) {
        location.href = defaultPage + '.html';
        return true;
      }
    }
    return false;
  }

  /* ── INIT ── */
  function initSiteUI() {
    var settings = loadSettings();
    applyAccentColor(settings.accentColor);
    buildSidebarBottom();
    buildHelpButton();
    buildSettingsModal();
    buildHelpModal();
    updateClock();
    setInterval(updateClock, 15000);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSiteUI);
  } else {
    initSiteUI();
  }

  // Expose API
  window.__siteUI = {
    openSettings: openSettings,
    closeSettings: closeSettings,
    openHelp: openHelp,
    closeHelp: closeHelp,
    backupData: backupData,
    restoreData: restoreData,
    resetData: resetData,
    checkDefaultLogin: checkDefaultLogin,
    applyAccentColor: applyAccentColor,
    loadSettings: loadSettings,
  };

})();
