/* ═══════════════════════════════════════════════════
   SITE-UI.JS — Shared CompanyHub UI Logic
   Clock, Backup/Restore, Reset, Settings, Help, Theming
═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CH_VERSION = 'v2026.07.31.736'; // deployed 2026-07-19 (Phase 0 client-prep: Home dashboard Upcoming Events fix, EMS Leads save/reload reliability fix)

  /* ── COLOR PRESETS ── */
  const COLOR_PRESETS = [
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Teal', hex: '#14b8a6' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Rose', hex: '#f43f5e' },
    { name: 'Amber', hex: '#f59e0b' },
    { name: 'Emerald', hex: '#10b981' },
    { name: 'Sky', hex: '#0ea5e9' },
    { name: 'Orange', hex: '#f97316' },
  ];

  const DEFAULT_SETTINGS = {
    accentColor: '#3b82f6',
    defaultLoginScreen: 'index',
    theme: 'dark',
    feedbackMode: false,
  };

  /* ── LOAD / SAVE SETTINGS ── */
  function loadSettings() {
    try {
      const s = localStorage.getItem('ch_settings');
      return s ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(s)) : Object.assign({}, DEFAULT_SETTINGS);
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }
  function saveSettings(settings) {
    localStorage.setItem('ch_settings', JSON.stringify(settings));
  }

  /* ── APPLY ACCENT COLOR ── */
  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  }
  function applyAccentColor(hex) {
    const root = document.documentElement;
    const rgb = hexToRgb(hex);
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-dim', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.12)');
    root.style.setProperty('--accent-glow', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.25)');

    // Also update --blue and --blue-dim/--blue-glow for pages that still use --blue
    root.style.setProperty('--blue', hex);
    root.style.setProperty('--blue-dim', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.12)');
    root.style.setProperty('--blue-glow', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.25)');

    // Update --em and --em-dim for energy page compatibility
    root.style.setProperty('--em', hex);
    root.style.setProperty('--em-dim', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.1)');
    root.style.setProperty('--em-glow', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.22)');
  }

  /* ── APPLY THEME (dark / light) ── */
  function applyTheme(mode) {
    var isLight = mode === 'light';
    document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
    try {
      localStorage.setItem('ch_theme', isLight ? 'light' : 'dark');
    } catch (e) {}
    // Sync any inline toggle on the page (energy-department sidebar remnant guard)
    var tog = document.getElementById('themeToggle');
    var lbl = document.getElementById('theme-lbl');
    if (tog) tog.checked = isLight;
    if (lbl) lbl.textContent = isLight ? '☀️ Light Mode' : '🌙 Dark Mode';
    // Sync the settings modal radios if open
    var darkRad = document.getElementById('theme-radio-dark');
    var lightRad = document.getElementById('theme-radio-light');
    if (darkRad) darkRad.checked = !isLight;
    if (lightRad) lightRad.checked = isLight;
    // Update pill highlight
    var pills = document.querySelectorAll('.theme-pill');
    pills.forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-theme') === (isLight ? 'light' : 'dark'));
    });
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
    h = h % 12;
    if (h === 0) h = 12;
    var timeStr = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    el.textContent = timeStr;

    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
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
    for (var j = 0; j < sessionStorage.length; j++) {
      var skey = sessionStorage.key(j);
      if (skey !== 'ch_user') {
        data['__session__' + skey] = sessionStorage.getItem(skey);
      }
    }
    var d = new Date();
    var ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var filename = 'CompanyHub-localdatafile-' + ds + '.json';
    var content = JSON.stringify(data, null, 2);
    var blob = new Blob([content], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
    if (typeof showToast === 'function') showToast('Backup downloaded');
  }

  function processRestoreFile(file) {
    // DEAD CODE: this file is never <script src>'d by any page (only fetched as
    // text to regex CH_VERSION — see index.html/service-department.html version
    // label code). The live copies are app/site-functions.js, index.html, and
    // service-department.html (own inline copies). Do not treat this as reachable.
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      if (typeof showToast === 'function') showToast('Please drop a .json backup file');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var data = JSON.parse(ev.target.result);
        Object.keys(data).forEach(function (key) {
          if (key.startsWith('__session__')) {
            sessionStorage.setItem(key.replace('__session__', ''), data[key]);
          } else {
            localStorage.setItem(key, data[key]);
          }
        });
        if (typeof showToast === 'function') showToast('Data restored — reloading...');
        setTimeout(function () {
          location.reload();
        }, 1200);
      } catch (err) {
        if (typeof showToast === 'function') showToast('Invalid backup file');
      }
    };
    reader.readAsText(file);
  }

  function restoreData() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = function (e) {
      processRestoreFile(e.target.files[0]);
    };
    input.click();
  }

  /* ── RESET DATA ── */
  async function resetData() {
    if (
      !confirm(
        'This permanently erases ALL CompanyHub data on this device — projects, bills, utility data, and the Equipment Matrix database. This cannot be undone. Continue?',
      )
    )
      return;
    localStorage.clear();
    sessionStorage.clear();
    if (window.DB && window.DB.clear) {
      await window.DB.clear();
    }
    if (typeof showToast === 'function') showToast('Reset — reloading...');
    setTimeout(function () {
      location.reload();
    }, 1200);
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
      '<button class="sb-btn danger" style="width:100%" onclick="window.__siteUI.resetData()" title="WARNING: Permanently deletes ALL projects, buildings, meters, and bills. Cannot be undone.">Reset Data</button>' +
      '<div class="sb-version" style="text-align:center;font-size:10px;color:var(--text3);margin-top:8px;font-family:var(--mono);letter-spacing:0.5px">' +
      CH_VERSION +
      '</div>';
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
    helpBtn.onclick = function () {
      window.__siteUI.openHelp();
    };
    tRight.insertBefore(helpBtn, tRight.firstChild);
  }

  /* ── SETTINGS MODAL ── */
  function buildSettingsModal() {
    var overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settingsOverlay';
    overlay.onclick = function (e) {
      if (e.target === overlay) closeSettings();
    };

    var settings = loadSettings();

    var swatchesHTML = COLOR_PRESETS.map(function (c) {
      var isActive = settings.accentColor === c.hex ? ' active' : '';
      return (
        '<div class="color-swatch' +
        isActive +
        '" data-color="' +
        c.hex +
        '" style="background:' +
        c.hex +
        '" title="' +
        c.name +
        '"></div>'
      );
    }).join('');

    var loginOptions = [
      { value: 'index', label: 'Dashboard (index.html)' },
      { value: 'service-department', label: 'Service Department' },
      { value: 'energy-department', label: 'Energy Department' },
    ];
    var loginSelectHTML = loginOptions
      .map(function (o) {
        var sel = settings.defaultLoginScreen === o.value ? ' selected' : '';
        return '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
      })
      .join('');

    overlay.innerHTML =
      '<div class="settings-modal">' +
      '<div class="settings-hdr">' +
      '<span class="settings-title">&#9881; Settings</span>' +
      '<button class="settings-x" onclick="window.__siteUI.closeSettings()">&#10005;</button>' +
      '</div>' +
      '<div class="settings-body">' +
      '<div class="settings-section">' +
      '<div class="settings-section-title">Display Mode</div>' +
      '<div class="settings-row">' +
      '<div>' +
      '<div class="settings-row-label">Light / Dark Mode</div>' +
      '<div class="settings-row-sub">Choose your preferred color scheme</div>' +
      '</div>' +
      '<div class="theme-pills" id="themePills">' +
      '<button class="theme-pill" data-theme="dark" id="theme-radio-dark">🌙 Dark</button>' +
      '<button class="theme-pill" data-theme="light" id="theme-radio-light">☀️ Light</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="settings-section">' +
      '<div class="settings-section-title">Accent Color</div>' +
      '<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">' +
      '<div class="color-swatches" id="colorSwatches">' +
      swatchesHTML +
      '</div>' +
      '<div class="custom-color-row">' +
      '<input type="color" class="custom-color-input" id="customColorInput" value="' +
      settings.accentColor +
      '">' +
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
      '<select class="settings-select" id="defaultLoginSelect">' +
      loginSelectHTML +
      '</select>' +
      '</div>' +
      '</div>' +
      '<div class="settings-section">' +
      '<div class="settings-section-title">Developer Tools</div>' +
      '<div class="settings-row">' +
      '<div>' +
      '<div class="settings-row-label">Feedback Mode</div>' +
      '<div class="settings-row-sub">Show feedback button to report UI issues</div>' +
      '</div>' +
      '<label class="settings-toggle">' +
      '<input type="checkbox" id="feedbackModeToggle"' +
      (settings.feedbackMode ? ' checked' : '') +
      '>' +
      '<span class="toggle-track"></span>' +
      '<span class="toggle-knob"></span>' +
      '</label>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Swatch click handlers
    var swatches = overlay.querySelectorAll('.color-swatch');
    swatches.forEach(function (sw) {
      sw.onclick = function () {
        swatches.forEach(function (s) {
          s.classList.remove('active');
        });
        sw.classList.add('active');
        var color = sw.getAttribute('data-color');
        applyAccentColor(color);
        document.getElementById('customColorInput').value = color;
        var s = loadSettings();
        s.accentColor = color;
        saveSettings(s);
      };
    });

    // Theme pills
    var themePills = overlay.querySelectorAll('.theme-pill');
    themePills.forEach(function (pill) {
      pill.onclick = function () {
        var mode = pill.getAttribute('data-theme');
        applyTheme(mode);
        var s = loadSettings();
        s.theme = mode;
        saveSettings(s);
      };
    });
    // Set initial pill state
    var currentTheme = loadSettings().theme || 'dark';
    themePills.forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-theme') === currentTheme);
    });

    // Custom color input
    var customInput = document.getElementById('customColorInput');
    customInput.oninput = function () {
      var color = customInput.value;
      swatches.forEach(function (s) {
        s.classList.remove('active');
      });
      // Check if matches a preset
      swatches.forEach(function (s) {
        if (s.getAttribute('data-color').toLowerCase() === color.toLowerCase()) s.classList.add('active');
      });
      applyAccentColor(color);
      var s = loadSettings();
      s.accentColor = color;
      saveSettings(s);
    };

    // Default login select
    var loginSelect = document.getElementById('defaultLoginSelect');
    loginSelect.onchange = function () {
      var s = loadSettings();
      s.defaultLoginScreen = loginSelect.value;
      saveSettings(s);
    };

    // Feedback mode toggle
    var fbToggle = document.getElementById('feedbackModeToggle');
    if (fbToggle) {
      fbToggle.onchange = function () {
        var s = loadSettings();
        s.feedbackMode = fbToggle.checked;
        saveSettings(s);
        document.dispatchEvent(new CustomEvent('feedbackModeChanged', { detail: { enabled: fbToggle.checked } }));
      };
    }
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
    overlay.onclick = function (e) {
      if (e.target === overlay) closeHelp();
    };

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

  // NOTE: the What's New / release notes modal used to be built here from a
  // hand-synced RELEASE_NOTES stub. That stub duplicated app/site-functions.js's
  // RELEASE_NOTES array and was never actually loaded as an executable script by
  // any page (index.html and service-department.html only fetch() this file as
  // text to regex out CH_VERSION for the sidebar footer -- see the fetch() calls
  // in those files). It silently fell behind (stopped at v671, missed v672) with
  // zero runtime effect. Removed 2026-07-14 to kill the duplicate source of
  // truth -- RELEASE_NOTES now lives ONLY in app/site-functions.js, which is the
  // file energy-department.html actually executes and whose modal (openReleaseNotes
  // etc.) is the one users see.

  /* ── DEFAULT LOGIN REDIRECT ── */
  function checkDefaultLogin() {
    var settings = loadSettings();
    var defaultPage = settings.defaultLoginScreen || 'index';
    var currentPage = location.pathname.split('/').pop().replace('.html', '') || 'index';
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

  /* ══════════════════════════════════════════
     STORE — Centralized Data Layer
     Single source of truth for all app data.
     All reads/writes go through Store so the
     dashboard always stays in sync.
  ══════════════════════════════════════════ */
  var Store = {
    get: function (key) {
      // READ-PATH FIX: when IndexedDB cache is warm, read from it first.
      // Falls back to localStorage so lsPreserveKeys (ch_theme, ch_settings, etc.)
      // that are intentionally kept in localStorage are still found.
      if (window.DB && window.DB.isReady()) {
        var dbVal = window.DB.get(key);
        if (dbVal !== null && dbVal !== undefined) return dbVal;
        // Key not in IDB cache — try localStorage fallback
        try {
          var lsRaw = localStorage.getItem(key);
          if (lsRaw !== null) return JSON.parse(lsRaw);
        } catch (e) {
          /* fall through */
        }
        return [];
      }
      // DB not ready — legacy path
      try {
        return JSON.parse(localStorage.getItem(key)) || [];
      } catch (e) {
        return [];
      }
    },
    set: function (key, data) {
      // WRITE-PATH FIX: when IndexedDB is ready, persist to IDB (authoritative store).
      // DB.set() updates _cache synchronously (UI stays responsive), starts the IDB
      // write, and returns a Promise that resolves on tx.oncomplete (real commit).
      // Callers that need write durability should await the returned Promise.
      if (window.DB && window.DB.isReady()) {
        return window.DB.set(key, data);
      }
      // DB not ready — legacy localStorage path
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch (e) {
        console.warn('Store.set failed:', e);
        return Promise.resolve();
      }
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key: key } }));
      return Promise.resolve();
    },
    update: function (key, id, newData) {
      var items = this.get(key).map(function (item) {
        if (item.id === id) {
          return Object.assign({}, item, newData, { updatedAt: new Date().toISOString() });
        }
        return item;
      });
      this.set(key, items);
    },
    delete: function (key, id) {
      var items = this.get(key).filter(function (item) {
        return item.id !== id;
      });
      this.set(key, items);
    },
  };

  /* ══════════════════════════════════════════
     DASHBOARD CONTROLLER
     Reads live data from Store and updates
     index.html metric cards automatically.
     Triggered on load and on dataUpdated events.
  ══════════════════════════════════════════ */
  var DashboardController = {
    refresh: function () {
      // Only runs on index.html — guard by checking for stat elements
      var statStaff = document.getElementById('dash-stat-staff');
      var statSA = document.getElementById('dash-stat-sa');
      var statProjects = document.getElementById('dash-stat-projects');
      if (!statStaff && !statSA && !statProjects) return;

      // Service staff count
      var staffData = Store.get('sv_staffData');
      if (Array.isArray(staffData) && statStaff) {
        statStaff.textContent = staffData.length;
        // Also update dept card mini-stats
        var dc = document.getElementById('dash-dc-technicians');
        if (dc) dc.textContent = staffData.length;
        var qa = document.getElementById('qa-staff');
        if (qa) qa.textContent = staffData.length;
      }

      // Service Agreements count
      var saData = Store.get('sv_saData');
      if (Array.isArray(saData) && statSA) {
        statSA.textContent = saData.length;
        var dcSA = document.getElementById('dash-dc-sa');
        if (dcSA) dcSA.textContent = saData.length;
        var qaSA = document.getElementById('qa-pm');
        if (qaSA) qaSA.textContent = saData.length;
        // Update PM Schedule sidebar badge if present
        var pmBadges = document.querySelectorAll('.pm-badge-live');
        pmBadges.forEach(function (b) {
          b.textContent = saData.length;
        });
      }

      // Energy projects count
      var projData = Store.get('en_projects');
      if (Array.isArray(projData) && statProjects) {
        statProjects.textContent = projData.length;
      }
    },
  };

  /* ── MOBILE SIDEBAR DRAWER ── */
  function buildMobileSidebarToggle() {
    // Only add if not already present
    if (document.getElementById('sidebarToggleBtn')) return;
    var deptNav = document.querySelector('.dept-nav');
    if (!deptNav) return;

    var btn = document.createElement('button');
    btn.id = 'sidebarToggleBtn';
    btn.className = 'sidebar-toggle-btn';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'appSidebar');
    btn.innerHTML = '☰';
    btn.onclick = function () {
      var sidebar = document.getElementById('appSidebar') || document.querySelector('.sidebar');
      if (!sidebar) return;
      var open = sidebar.classList.toggle('drawer-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.innerHTML = open ? '✕' : '☰';
      // Backdrop
      var bd = document.getElementById('sidebarBackdrop');
      if (bd) bd.style.display = open ? 'block' : 'none';
    };

    // Backdrop
    var backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.style.display = 'none';
    backdrop.onclick = function () {
      var sidebar = document.getElementById('appSidebar') || document.querySelector('.sidebar');
      if (sidebar) sidebar.classList.remove('drawer-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '☰';
      backdrop.style.display = 'none';
    };
    document.body.appendChild(backdrop);
    deptNav.insertBefore(btn, deptNav.firstChild);

    // Give sidebar an id if it doesn't have one
    var sidebar = document.querySelector('.sidebar');
    if (sidebar && !sidebar.id) sidebar.id = 'appSidebar';
  }

  /* ── DEPT NAV ARIA ── */
  function applyDeptNavAria() {
    var nav = document.querySelector('.dept-nav');
    if (!nav) return;
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Department navigation');
    var tabs = nav.querySelectorAll('.dept-tab');
    tabs.forEach(function (tab) {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    });
  }

  /* ── MODAL ARIA + FOCUS TRAP + ESC ── */
  function applyModalAccessibility() {
    // Apply to any overlay that has .settings-overlay, .help-overlay class
    // and any future modals. Uses MutationObserver for dynamically added ones.
    function setupOverlay(overlay) {
      if (overlay._a11yReady) return;
      overlay._a11yReady = true;
      var modal = overlay.querySelector('[class$="-modal"], .modal, [role="dialog"]');
      if (modal) {
        if (!modal.getAttribute('role')) modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
      }
      overlay.addEventListener('keydown', function (e) {
        if (!overlay.classList.contains('open')) return;
        // ESC closes
        if (e.key === 'Escape') {
          overlay.classList.remove('open');
          return;
        }
        // Focus trap
        if (e.key === 'Tab') {
          var focusable = Array.from(
            overlay.querySelectorAll(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          );
          if (!focusable.length) return;
          var first = focusable[0];
          var last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });
    }

    // Setup existing overlays
    document.querySelectorAll('.settings-overlay, .help-overlay, .modal-overlay').forEach(setupOverlay);

    // Watch for new ones
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (
            node.classList &&
            (node.classList.contains('settings-overlay') ||
              node.classList.contains('help-overlay') ||
              node.classList.contains('modal-overlay'))
          ) {
            setupOverlay(node);
          }
          node.querySelectorAll &&
            node.querySelectorAll('.settings-overlay, .help-overlay, .modal-overlay').forEach(setupOverlay);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ── INIT ── */
  function applyCrossPageFonts() {
    try {
      var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
      var uc = s.uiCustom;
      if (!uc || !uc.fonts) return;
      var r = document.documentElement.style;
      if (uc.fonts.baseSize) r.setProperty('--base-sz', uc.fonts.baseSize + 'px');
      if (uc.fonts.sidebarSize) r.setProperty('--sidebar-font-sz', uc.fonts.sidebarSize + 'px');
      var safeFonts = ['Outfit', 'Inter', 'DM Sans', 'Roboto', 'IBM Plex Sans'];
      if (uc.fonts.bodyFont && safeFonts.indexOf(uc.fonts.bodyFont) !== -1) {
        r.setProperty('--font', "'" + uc.fonts.bodyFont + "', sans-serif");
        if (uc.fonts.bodyFont !== 'Outfit') {
          var id = 'ui-font-' + uc.fonts.bodyFont.replace(/\s/g, '-');
          if (!document.getElementById(id)) {
            var link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href =
              'https://fonts.googleapis.com/css2?family=' +
              encodeURIComponent(uc.fonts.bodyFont) +
              ':wght@300;400;500;600;700;800&display=swap';
            document.head.appendChild(link);
          }
        }
      }
      if (uc.fonts.headFont && safeFonts.indexOf(uc.fonts.headFont) !== -1) {
        r.setProperty('--head', "'" + uc.fonts.headFont + "', sans-serif");
        if (uc.fonts.headFont !== 'Outfit') {
          var id2 = 'ui-font-' + uc.fonts.headFont.replace(/\s/g, '-');
          if (!document.getElementById(id2)) {
            var link2 = document.createElement('link');
            link2.id = id2;
            link2.rel = 'stylesheet';
            link2.href =
              'https://fonts.googleapis.com/css2?family=' +
              encodeURIComponent(uc.fonts.headFont) +
              ':wght@300;400;500;600;700;800&display=swap';
            document.head.appendChild(link2);
          }
        }
      }
    } catch (e) {}
  }

  function initSiteUI() {
    var settings = loadSettings();
    applyAccentColor(settings.accentColor);
    applyTheme(settings.theme || 'dark');
    applyCrossPageFonts();
    buildSidebarBottom();
    buildHelpButton();
    buildSettingsModal();
    buildHelpModal();
    buildMobileSidebarToggle();
    applyDeptNavAria();
    applyModalAccessibility();
    updateClock();
    setInterval(updateClock, 15000);
    // Dashboard auto-refresh: run once on load, then on every Store write
    DashboardController.refresh();
    window.addEventListener('dataUpdated', function () {
      DashboardController.refresh();
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSiteUI);
  } else {
    initSiteUI();
  }

  // Expose API
  window.__siteUI = {
    version: CH_VERSION,
    openSettings: openSettings,
    closeSettings: closeSettings,
    openHelp: openHelp,
    closeHelp: closeHelp,
    backupData: backupData,
    restoreData: restoreData,
    resetData: resetData,
    checkDefaultLogin: checkDefaultLogin,
    applyAccentColor: applyAccentColor,
    applyTheme: applyTheme,
    loadSettings: loadSettings,
  };

  // Expose Store and DashboardController globally
  window.Store = Store;
  window.DashboardController = DashboardController;
})();

/* ── TOAST (global — available on all pages) ── */
function showToast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast toast-show' + (type ? ' toast-' + type : '');
  clearTimeout(window._toastTimer);
  var duration = parseInt(localStorage.getItem('ch_toast_duration') || '3500', 10);
  if (duration > 0) {
    window._toastTimer = setTimeout(hideToast, duration);
  }
}

function hideToast() {
  var el = document.getElementById('toast');
  if (el) el.className = 'toast';
}
