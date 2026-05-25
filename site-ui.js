/* ═══════════════════════════════════════════════════
   SITE-UI.JS — Shared CompanyHub UI Logic
   Clock, Backup/Restore, Reset, Settings, Help, Theming
═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CH_VERSION = 'v2026.05.24.350';

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

  /* ── RELEASE NOTES ── */
  var RELEASE_NOTES = [
    {
      version: 'v2026.05.24.350',
      date: '2026-05-24',
      title: 'Add IndexedDB storage layer with auto-migration from localStorage',
      features: [
        {
          type: 'feature',
          text: 'Added IndexedDB storage layer (app/db.js) with synchronous cache, auto-migration from localStorage on first load, and localStorage fallback if IDB is unavailable.',
        },
        {
          type: 'fix',
          text: 'Added dedup guards in init() and saveProject() to prevent and clean up duplicate project entries caused by the prior recursion bug.',
        },
      ],
    },
    {
      version: 'v2026.05.24.349',
      date: '2026-05-24',
      title: 'Fix saveProject recursion bug and remaining corrupted characters',
      features: [
        {
          type: 'fix',
          text: 'Fixed infinite recursion in saveProject/closeProjModal — removed auto-save block from closeProjModal that caused mutual recursion and duplicate project entries on new project creation.',
        },
        {
          type: 'fix',
          text: 'Fixed 22 remaining corrupted ? characters in energy-department.html: modal close buttons (✕), sidebar collapse tab (◀), and export/apply button symbols.',
        },
      ],
    },
    {
      version: 'v2026.05.24.348',
      date: '2026-05-24',
      title: 'Fix corrupted Unicode characters',
      features: [
        {
          type: 'fix',
          text: 'Restored 122 corrupted Unicode characters (U+FFFD) in energy-department.html: em dashes, middle dots, angle quotes, multiplication sign, en dash, and checkmarks.',
        },
      ],
    },
    {
      version: 'v2026.05.24.347',
      date: '2026-05-24',
      title: 'Building list import from Excel/CSV',
      features: [
        {
          type: 'feature',
          text: 'Added Import List button next to Add Building in the project sidebar. Accepts .xlsx or .csv files with Building Name, SQFT, and Address columns. Shows a preview table with checkboxes before importing.',
        },
      ],
    },
    {
      version: 'v2026.05.24.346',
      date: '2026-05-24',
      title: 'Fix corrupted title tag and add inline SVG favicon',
      features: [
        {
          type: 'fix',
          text: 'Fixed corrupted title tag in energy-department.html (? → em dash) and added inline SVG favicon to all 4 HTML pages so the browser tab shows the CompanyHub icon',
        },
      ],
    },
    {
      version: 'v2026.05.22.345',
      date: '2026-05-23',
      title: 'Restore all emoji icons clobbered by batch 3 deployer',
      features: [
        {
          type: 'fix',
          text: 'Restored 134+ emoji characters in energy-department.html and app/report-engine.js that were replaced with literal ?? by a prior deployer agent — sidebar icons, nav tabs, buttons, and labels now display correctly',
        },
      ],
    },
    {
      version: 'v2026.05.22.343',
      date: '2026-05-22',
      title: 'CSP style-src fix across all HTML files for Quill stylesheet',
      features: [
        {
          type: 'fix',
          text: 'Added cdn.jsdelivr.net to CSP style-src, script-src, font-src, and connect-src in index.html, service-department.html, and ems-leads.html so Quill and other jsdelivr resources load without CSP errors',
        },
      ],
    },
    {
      version: 'v2026.05.22.342',
      date: '2026-05-22',
      title: 'BAS fault detection — simultaneous heating/cooling checks',
      features: [
        {
          type: 'new',
          text: 'BAS Equipment Snapshot now detects simultaneous heating and cooling (SHC) faults across all zones, showing a color-coded fault table with Severe/Moderate tiers',
        },
        {
          type: 'new',
          text: 'BAS Health Score badge added to the snapshot card title — 100 = no SHC faults, score drops proportionally with fault count',
        },
        {
          type: 'new',
          text: 'New Fault Detection tab in the BAS snapshot panel with red count badge when faults are present',
        },
      ],
    },
    {
      version: 'v2026.05.22.341',
      date: '2026-05-22',
      title: 'Client portal and Quill CSP fix',
      features: [
        {
          type: 'fix',
          text: 'CSP fix: added cdn.jsdelivr.net to style-src in energy-department.html so Quill editor stylesheet loads without console errors',
        },
        {
          type: 'new',
          text: 'Client portal Phase 1: one-click "Publish Portal" button on project detail exports sanitized savings data to a permanent URL clients can bookmark without login',
        },
      ],
    },
    {
      version: 'v2026.05.22.339',
      date: '2026-05-22',
      title: 'Quarterly projected savings breakdown and Node.js weather data script',
      features: [
        {
          type: 'new',
          text: 'Quarterly savings breakdown: Energy Savings tab now shows Q1–Q4 sub-rows under the annual Projected Savings total, calculated from the existing monthly data',
        },
        {
          type: 'new',
          text: 'Node.js weather fetch script: replaces Excel VBA macro; fetches HDD/CDD/avgTemp from weatherdatadepot.com and saves as JSON files in the repo; CompanyHub auto-loads weather data from GitHub Pages',
        },
      ],
    },
    {
      version: 'v2026.05.22.337',
      date: '2026-05-22',
      title: 'Data quality scores, address aliases, board summary report, rich text editors',
      features: [
        {
          type: 'new',
          text: 'Data quality score per meter: A–F letter grade and 5-component score (months, R², gaps, field completeness, flags) shown as badge on meter pills and summary card in Meter Data pane',
        },
        {
          type: 'fix',
          text: 'Address alias management: bldg.address bug fixed to bldg.addr in findMeterMatch; Levenshtein fuzzy matching; alias UI in Building Edit modal; saveAddressAlias wired to PDF extraction flow',
        },
        {
          type: 'new',
          text: 'Executive summary report: single-page board-ready report with savings vs target, contract progress, CO2 equivalents, and monthly bar chart; accessible from Board Summary button in project header',
        },
        {
          type: 'new',
          text: 'Browser editor Phase 1: Quill rich text wired for ed-notes, mp-notes, and eq-notes fields; new lib/rich-text.js helper',
        },
      ],
    },
    {
      version: 'v2026.05.22.333',
      date: '2026-05-22',
      title: 'Cache-busting, feedback inbox download, sidebar cleanup, value correction mode, bill validation flags',
      features: [
        {
          type: 'new',
          text: 'Cache-busting version params added to all script/stylesheet references so browsers always load the latest code after a deploy',
        },
        { type: 'new', text: 'Feedback inbox: download button exports all captured feedback as a CSV file' },
        { type: 'new', text: 'Sidebar button removal: cleaned up stale navigation buttons from the sidebar' },
        {
          type: 'new',
          text: 'Value Correction Mode (VCM): select a bill field and override its value with an audited correction, stored in localStorage',
        },
        {
          type: 'new',
          text: 'Bill validation flags: automatic per-bill health checks (year-over-year spikes, missing fields, cost outliers) displayed as colored dots in the bills pane with dismissible notes',
        },
        {
          type: 'fix',
          text: 'VCM keydown listener leak: Escape, Cancel, and Save all now clean up the listener; no more listener accumulation across multiple VCM sessions',
        },
        {
          type: 'fix',
          text: 'bill-validation.js script load order corrected: now loads after bill-analysis.js so _analyzeMeterBills is always defined at call time',
        },
        {
          type: 'fix',
          text: 'feedback-widget.js disable() now removes dlBtn from DOM, preventing stale-node reference after a disable/enable cycle',
        },
      ],
    },
    {
      version: 'v2026.05.22.328',
      date: '2026-05-22',
      title: 'Fix all remaining duplicate lines in report-engine.js (P0 complete)',
      features: [
        {
          type: 'fix',
          text: 'Removed 5 additional duplicate lines in report-engine.js: chart builder calls (buildElecBarChart, buildGasBarChart, buildPropBarChart), string concat _barChart calls, and a ternary string duplicate — all left behind by the encoding fix. File is now syntax-error free.',
        },
      ],
    },
    {
      version: 'v2026.05.22.327',
      date: '2026-05-22',
      title: 'Fix duplicate const declarations in report-engine.js causing SyntaxError on live site',
      features: [
        {
          type: 'fix',
          text: 'Removed 3 duplicate const declarations (cardStyle, valColor, blEUI, statusColor) left behind by the encoding fix, which caused a fatal SyntaxError preventing the energy department page from loading',
        },
      ],
    },
    {
      version: 'v2026.05.21.326',
      date: '2026-05-21',
      title: 'Report encoding fix, chart axis alignment, and release notes auto-show',
      features: [
        {
          type: 'fix',
          text: 'Fixed 233 corrupted Unicode characters (em-dashes, multiplication signs, degree signs) in report-engine.js',
        },
        {
          type: 'fix',
          text: 'Report chart Y-axis labels now correctly left-aligned from the SVG edge instead of indented',
        },
        { type: 'new', text: 'Release Notes modal now auto-shows on first visit after a version update' },
      ],
    },
    {
      version: 'v2026.05.21.304',
      date: '2026-05-21',
      title: 'Fix chart Y-axis label alignment in Contract Projection and Financial reports',
      features: [
        {
          type: 'fix',
          text: 'Report chart Y-axis labels now left-aligned (text-anchor="start", x=4) instead of right-indented in rptPageFinancial and rptPageContractProjection',
        },
      ],
    },
    {
      version: 'v2026.05.21.303',
      date: '2026-05-21',
      title: 'Release Notes, Savings Banner, Data Migrations',
      features: [
        { type: 'new', text: "Release Notes — What's New modal accessible from the sidebar on all pages" },
        {
          type: 'fix',
          text: 'Project banner Savings field now shows computed value from Energy Savings measures instead of always showing "—"',
        },
        {
          type: 'fix',
          text: 'Energy Savings measures with legacy rate field names (rates.gas, rates.propane) automatically migrated to current schema (rates.thermRate, rates.gallonRate)',
        },
        {
          type: 'fix',
          text: 'Broadmoor Elementary Energy Savings measure restored from May 2026 backup for Louisburg USD #416',
        },
        { type: 'fix', text: 'csv-import.js Unicode characters restored after encoding corruption in previous commit' },
      ],
    },
    {
      version: 'v2026.05.21.302',
      date: '2026-05-21',
      title: 'Equipment Matrix WebCTRL Format Support',
      features: [
        {
          type: 'new',
          text: 'Equipment Matrix now imports WebCTRL CSV point-list exports (Location / Control Program format)',
        },
        {
          type: 'new',
          text: 'No-project preview mode — import a CSV without selecting a project to preview results before saving',
        },
        { type: 'fix', text: 'Zero-row import now shows a clear warning toast instead of silently saving empty data' },
        {
          type: 'change',
          text: 'Equipment group key now includes location segment to prevent same-named equipment in different locations from merging',
        },
      ],
    },
    {
      version: 'v2026.05.21.300',
      date: '2026-05-21',
      title: 'Equipment Matrix Expansion + Scorecard Fix',
      features: [
        {
          type: 'new',
          text: 'JOCO equipment matrix expanded from 19 summary rows to 1,030 individual equipment rows using real program names from audit files',
        },
        {
          type: 'fix',
          text: 'Scorecard Load Factor calculation fixed — was reading wrong field name (kw instead of demandKW)',
        },
        { type: 'fix', text: 'Project tab pane now restores to the previously active tab when reopening a project' },
        {
          type: 'new',
          text: 'Equipment Matrix phases 4-5: full 45-column table with filtering, sorting, cell editing, CSV export, and add-row',
        },
      ],
    },
    {
      version: 'v2026.05.20.299',
      date: '2026-05-20',
      title: 'Energy Savings Matrix Improvements',
      features: [
        {
          type: 'new',
          text: 'Per-measure rate editing with expandable detail row — edit kWh/kW/gas rates per measure, reset to building defaults',
        },
        { type: 'new', text: 'Project Dashboard tab added as default landing tab with savings summary and calendar' },
        { type: 'new', text: 'District Calendar replaced with upload/parse/edit flow — paste text or upload PDF' },
        { type: 'fix', text: 'Bill line items validation tolerance held at $0.10 — fixes false sum-mismatch warnings' },
        { type: 'new', text: 'Duplicate bill detection modal now has per-bill overwrite + merge action buttons' },
      ],
    },
    {
      version: 'v2026.05.05.40',
      date: '2026-05-05',
      title: 'Solar Calc PDR Compliance + Electric Bill Line Items',
      features: [
        { type: 'new', text: 'Solar Calc rewritten to match Excel PDR cell-for-cell across 8 sections (A-H)' },
        { type: 'new', text: 'Net Metering and Behind the Meter profiles shown separately (Sections F and G)' },
        { type: 'new', text: 'Solar Calc now uses live auto-calc (Excel-style) — no Calculate button needed' },
        {
          type: 'new',
          text: 'Electric bill modal expanded with 15 new line-item fields (on-peak/off-peak, riders, franchise fee, solar credit)',
        },
        { type: 'new', text: 'HVAC Load Estimation rebuilt per-building with Reverse Utility Analysis method' },
        {
          type: 'new',
          text: 'Energy Savings unified — project tab and sidebar page share the same rendering function',
        },
      ],
    },
    {
      version: 'v2026.04.14',
      date: '2026-04-14',
      title: 'PDF Extraction Engine Overhaul',
      features: [
        { type: 'new', text: 'Multi-bill PDF support — import a single PDF with 12+ monthly bills at once' },
        { type: 'fix', text: 'Evergy charge extraction regex fixed for multiline end-of-line patterns' },
        {
          type: 'fix',
          text: 'PDF page range anchored to billing period cover page — no more 5-page ranges for 3-page bills',
        },
        { type: 'fix', text: 'Sub-dollar sum mismatch auto-correction added to reduce false validation warnings' },
        { type: 'new', text: 'Audit log added for bill changes — append-only, max 500 entries' },
      ],
    },
    {
      version: 'v2026.03.27',
      date: '2026-03-27',
      title: 'Solar Calc, Calc Templates, Energy Graphics',
      features: [
        { type: 'new', text: 'Solar Calculator added — array sizing, tiered Evergy rate math, payback years' },
        { type: 'new', text: 'Calc Templates launcher added to Energy Savings view' },
        {
          type: 'new',
          text: 'Energy Graphics tab added to project detail — monthly kWh/gas charts and EUI comparison',
        },
        { type: 'new', text: 'Number input spinners removed across all 90+ inputs — clean keyboard entry' },
        { type: 'new', text: 'HVAC Load Estimation tab added to project detail' },
      ],
    },
    {
      version: 'v2026.03.16',
      date: '2026-03-16',
      title: 'Hybrid PDF Extraction Engine',
      features: [
        {
          type: 'new',
          text: 'Rule-based PDF extraction added for Evergy and Spire/Laclede Gas — eliminates AI API cost for known formats',
        },
        { type: 'new', text: 'Tesseract.js OCR fallback for scanned/image PDFs' },
        { type: 'new', text: 'Confidence scoring — counts non-null extracted fields to measure extraction quality' },
        { type: 'change', text: 'AI removed from utility bill extraction — 100% local and offline-capable' },
      ],
    },
  ];

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
  function resetData() {
    if (!confirm('Are you sure you want to reset all data? This cannot be undone.')) return;
    localStorage.clear();
    sessionStorage.clear();
    if (typeof showToast === 'function') showToast('All data reset — reloading...');
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
      '<button class="rn-whats-new-btn" onclick="window.__siteUI.openReleaseNotes()">&#128196; What\'s New</button>' +
      '<button class="sb-settings-btn" onclick="window.__siteUI.openSettings()">&#9881; Settings</button>' +
      '<div class="sb-divider"></div>' +
      '<div class="sb-clock" id="sb-clock">--:-- --</div>' +
      '<div class="sb-date" id="sb-date">Loading...</div>' +
      '<div class="sb-btn-row">' +
      '<button class="sb-btn" onclick="window.__siteUI.backupData()" title="Backup all data">Backup</button>' +
      '<button class="sb-btn" onclick="window.__siteUI.restoreData()" title="Restore from backup">Restore</button>' +
      '</div>' +
      '<button class="sb-btn danger" style="width:100%" onclick="window.__siteUI.resetData()">Reset Data</button>' +
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

  /* ── RELEASE NOTES MODAL ── */
  function buildReleaseNotesModal() {
    var overlay = document.createElement('div');
    overlay.className = 'rn-overlay';
    overlay.id = 'rnOverlay';
    overlay.onclick = function (e) {
      if (e.target === overlay) closeReleaseNotes();
    };

    var entriesHTML = RELEASE_NOTES.map(function (entry, idx) {
      var isLatest = idx === 0;
      var featuresHTML = entry.features
        .map(function (f) {
          var cls = f.type === 'fix' ? ' rn-fix' : f.type === 'change' ? ' rn-change' : '';
          return '<li class="' + cls + '">' + f.text + '</li>';
        })
        .join('');

      return (
        '<div class="rn-entry">' +
        '<div class="rn-version-row">' +
        '<span class="rn-version-badge">' +
        entry.version +
        '</span>' +
        '<span class="rn-date">' +
        entry.date +
        '</span>' +
        (isLatest ? '<span class="rn-latest-badge">Latest</span>' : '') +
        '</div>' +
        '<div class="rn-entry-title">' +
        entry.title +
        '</div>' +
        '<ul class="rn-features">' +
        featuresHTML +
        '</ul>' +
        '</div>'
      );
    }).join('');

    overlay.innerHTML =
      '<div class="rn-modal">' +
      '<div class="rn-hdr">' +
      '<span class="rn-title">&#128196; What\'s New</span>' +
      '<button class="rn-x" onclick="window.__siteUI.closeReleaseNotes()">&#10005;</button>' +
      '</div>' +
      '<div class="rn-body">' +
      entriesHTML +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);
  }

  function openReleaseNotes() {
    var overlay = document.getElementById('rnOverlay');
    if (overlay) overlay.classList.add('open');
  }
  function closeReleaseNotes() {
    var overlay = document.getElementById('rnOverlay');
    if (overlay) overlay.classList.remove('open');
  }

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
      try {
        return JSON.parse(localStorage.getItem(key)) || [];
      } catch (e) {
        return [];
      }
    },
    set: function (key, data) {
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch (e) {
        console.warn('Store.set failed:', e);
        return;
      }
      window.dispatchEvent(new CustomEvent('dataUpdated', { detail: { key: key } }));
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
    buildReleaseNotesModal();
    // Auto-show release notes on first visit after a version bump.
    // ch_seen_version stores the last version the user saw notes for.
    // If the stored value doesn't match CH_VERSION, show the modal and update the key.
    var seenVersion = localStorage.getItem('ch_seen_version');
    if (seenVersion !== CH_VERSION) {
      setTimeout(function () {
        openReleaseNotes();
      }, 800);
      localStorage.setItem('ch_seen_version', CH_VERSION);
    }
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
    openSettings: openSettings,
    closeSettings: closeSettings,
    openHelp: openHelp,
    closeHelp: closeHelp,
    openReleaseNotes: openReleaseNotes,
    closeReleaseNotes: closeReleaseNotes,
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
