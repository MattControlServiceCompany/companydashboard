/* ══ SITE FUNCTIONS ══ */

/* Clock */
function siteTickClock() {
  var el = document.getElementById('sb-clock');
  var ed = document.getElementById('sb-date');
  if (!el || !ed) return;
  var now = new Date();
  var h = now.getHours(),
    m = now.getMinutes();
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  el.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
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
  ed.textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
}
document.addEventListener('DOMContentLoaded', function () {
  siteTickClock();
  setInterval(siteTickClock, 15000);
});

/* Settings */
function siteOpenSettings() {
  if (!document.getElementById('siteSettingsOverlay')) siteBuildSettingsModal();
  var o = document.getElementById('siteSettingsOverlay');
  if (o) o.classList.add('open');
}
function siteCloseSettings() {
  var o = document.getElementById('siteSettingsOverlay');
  if (o) o.classList.remove('open');
}

/* Theme */
function siteApplyTheme(mode) {
  var isLight = mode === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  try {
    localStorage.setItem('ch_theme', isLight ? 'light' : 'dark');
  } catch (e) {}
  document.querySelectorAll('.theme-pill').forEach(function (p) {
    p.classList.toggle('active', p.getAttribute('data-theme') === (isLight ? 'light' : 'dark'));
  });
  // save to settings
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.theme = isLight ? 'light' : 'dark';
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}

/* UI Customization persistence */
const UI_CUSTOM_SAFE_FONTS = ['Outfit', 'Inter', 'DM Sans', 'Roboto', 'IBM Plex Sans'];

function _uiCustomGet() {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    return s.uiCustom || { version: 1, pages: {}, fonts: {} };
  } catch (e) {
    return { version: 1, pages: {}, fonts: {} };
  }
}

function _uiCustomSave(uc) {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.uiCustom = uc;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {
    console.warn('uiCustom save failed', e);
  }
}

function _uiCustomLoadFont(fontName) {
  if (fontName === 'Outfit') return;
  var id = 'ui-font-' + fontName.replace(/\s/g, '-');
  if (document.getElementById(id)) return;
  var link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(fontName) +
    ':wght@300;400;500;600;700;800&display=swap';
  document.head.appendChild(link);
}

function uiCustomApply() {
  var uc = _uiCustomGet();
  var r = document.documentElement.style;
  if (uc.fonts) {
    if (uc.fonts.baseSize) r.setProperty('--base-sz', uc.fonts.baseSize + 'px');
    if (uc.fonts.sidebarSize) r.setProperty('--sidebar-font-sz', uc.fonts.sidebarSize + 'px');
    if (uc.fonts.bodyFont && UI_CUSTOM_SAFE_FONTS.includes(uc.fonts.bodyFont)) {
      r.setProperty('--font', "'" + uc.fonts.bodyFont + "', sans-serif");
      _uiCustomLoadFont(uc.fonts.bodyFont);
    }
    if (uc.fonts.headFont && UI_CUSTOM_SAFE_FONTS.includes(uc.fonts.headFont)) {
      r.setProperty('--head', "'" + uc.fonts.headFont + "', sans-serif");
      _uiCustomLoadFont(uc.fonts.headFont);
    }
  }
  if (uc.showCalcFormulas) {
    document.documentElement.classList.add('show-calc');
  } else {
    document.documentElement.classList.remove('show-calc');
  }
  var pageName = 'energy-department';
  var pg = uc.pages?.[pageName];
  if (pg) {
    if (pg.colors) {
      for (var uiId in pg.colors) {
        var el = document.querySelector('[data-ui-id="' + uiId + '"]');
        if (!el) {
          console.warn('uiCustom: missing element', uiId);
          continue;
        }
        var cols = pg.colors[uiId];
        if (cols.background) el.style.background = cols.background;
        if (cols.borderColor) el.style.borderColor = cols.borderColor;
        if (cols.color) el.style.color = cols.color;
      }
    }
    if (pg.layout) {
      for (var uiId in pg.layout) {
        var el = document.querySelector('[data-ui-id="' + uiId + '"]');
        if (!el) continue;
        var lay = pg.layout[uiId];
        if (lay.order != null) el.style.order = lay.order;
        if (lay.columns) el.style.gridTemplateColumns = lay.columns;
      }
    }
    if (pg.hiddenElements && pg.hiddenElements.length) {
      pg.hiddenElements.forEach(function (key) {
        var parts = key.split(':btn:');
        if (parts.length === 2) {
          var el = document.querySelector('[data-ui-id="' + parts[0] + '"]');
          if (el) {
            var btns = el.querySelectorAll('button, .btn, .s-item');
            var idx = parseInt(parts[1]);
            if (btns[idx]) btns[idx].style.display = 'none';
          }
        }
      });
    }
  }
}

function uiCustomSetFont(key, val) {
  if (!UI_CUSTOM_SAFE_FONTS.includes(val)) return;
  var uc = _uiCustomGet();
  if (!uc.fonts) uc.fonts = {};
  uc.fonts[key] = val;
  _uiCustomSave(uc);
  uiCustomApply();
}

function uiCustomSetFontSize(key, val, el) {
  if (val < 10 || val > 20) return;
  var uc = _uiCustomGet();
  if (!uc.fonts) uc.fonts = {};
  uc.fonts[key] = val;
  _uiCustomSave(uc);
  uiCustomApply();
  var sub = el?.closest('.settings-row')?.querySelector('.settings-row-sub');
  if (sub) sub.textContent = val + 'px';
}

function uiCustomToggleCalc(on) {
  var uc = _uiCustomGet();
  uc.showCalcFormulas = on;
  _uiCustomSave(uc);
  uiCustomApply();
}

function uiCustomExport() {
  var uc = _uiCustomGet();
  var json = JSON.stringify(uc, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  var d = new Date();
  a.download =
    'companyhub-layout-' +
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0') +
    '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showToast('Layout exported');
}

function uiCustomImport() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = function () {
    var file = inp.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);
        if (!data.version || !data.pages) {
          showToast('Invalid layout file');
          return;
        }
        _uiCustomSave(data);
        showToast('Layout imported — reloading...');
        setTimeout(function () {
          location.reload();
        }, 500);
      } catch (err) {
        showToast('Failed to parse file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  inp.click();
}

async function uiCustomResetAll() {
  if (!(await confirmAsync('Reset all UI customizations (fonts, layout, colors)? This cannot be undone.'))) return;
  _uiCustomSave({ version: 1, pages: {}, fonts: {} });
  showToast('Customizations reset — reloading...');
  setTimeout(function () {
    location.reload();
  }, 500);
}

/* ── UI Edit Mode ── */
// ── Sidebar drag-to-reorder ──
function _getSidebarOrder() {
  try {
    return JSON.parse(localStorage.getItem('ch_sidebarOrder'));
  } catch (e) {
    return null;
  }
}
function _saveSidebarOrder(order) {
  localStorage.setItem('ch_sidebarOrder', JSON.stringify(order));
}
function _applySidebarOrder() {
  const order = _getSidebarOrder();
  if (!order || !order.length) return;
  const container = document.getElementById('sidebarSortable');
  if (!container) return;
  const items = [...container.querySelectorAll('[data-sidebar-id]')];
  const map = {};
  items.forEach((el) => {
    map[el.getAttribute('data-sidebar-id')] = el;
  });
  order.forEach((id) => {
    if (map[id]) container.appendChild(map[id]);
  });
}
function _initSidebarDrag() {
  const container = document.getElementById('sidebarSortable');
  if (!container) return;
  const items = container.querySelectorAll('[data-sidebar-id]');
  let dragEl = null;
  items.forEach((el) => {
    el.setAttribute('draggable', 'true');
    el.style.cursor = 'grab';
    el.addEventListener('dragstart', function (e) {
      dragEl = this;
      this.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', function () {
      this.style.opacity = '1';
      container.querySelectorAll('[data-sidebar-id]').forEach((x) => x.classList.remove('sb-drag-over'));
      dragEl = null;
    });
    el.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('[data-sidebar-id]').forEach((x) => x.classList.remove('sb-drag-over'));
      if (this !== dragEl) this.classList.add('sb-drag-over');
    });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!dragEl || dragEl === this) return;
      const all = [...container.querySelectorAll('[data-sidebar-id]')];
      const fromIdx = all.indexOf(dragEl);
      const toIdx = all.indexOf(this);
      if (fromIdx < toIdx) this.after(dragEl);
      else this.before(dragEl);
      const newOrder = [...container.querySelectorAll('[data-sidebar-id]')].map((x) =>
        x.getAttribute('data-sidebar-id'),
      );
      _saveSidebarOrder(newOrder);
      showToast('Sidebar order saved ✓');
    });
  });
}
function _teardownSidebarDrag() {
  const container = document.getElementById('sidebarSortable');
  if (!container) return;
  container.querySelectorAll('[data-sidebar-id]').forEach((el) => {
    el.removeAttribute('draggable');
    el.style.cursor = '';
    el.classList.remove('sb-drag-over');
  });
}
// Apply saved order on load
requestAnimationFrame(() => _applySidebarOrder());

let _uiEditMode = false;
let _uiEditTab = 'colors';
let _uiSelectedEl = null;
const _uiPageName = 'energy-department';

function uiEditToggle() {
  _uiEditMode = !_uiEditMode;
  document.documentElement.classList.toggle('ui-edit-mode', _uiEditMode);
  const btn = document.getElementById('uiCustomizeBtn');
  if (btn) btn.textContent = _uiEditMode ? '✕ Exit Customize' : '✎ Customize';
  if (!_uiEditMode) {
    _uiEditCleanup();
    _teardownSidebarDrag();
    document.getElementById('uiInspector')?.classList.remove('open');
  } else {
    _uiEditAttachHovers();
    _initSidebarDrag();
  }
}

function _uiEditAttachHovers() {
  document.querySelectorAll('[data-ui-id]').forEach((el) => {
    el.addEventListener('mouseenter', _uiElMouseEnter);
    el.addEventListener('mouseleave', _uiElMouseLeave);
    el.addEventListener('click', _uiElClick);
  });
}

function _uiEditCleanup() {
  document.querySelectorAll('[data-ui-id]').forEach((el) => {
    el.classList.remove('ui-el-hover');
    el.removeEventListener('mouseenter', _uiElMouseEnter);
    el.removeEventListener('mouseleave', _uiElMouseLeave);
    el.removeEventListener('click', _uiElClick);
  });
  _uiSelectedEl = null;
}

function _uiElMouseEnter(e) {
  if (_uiEditMode) this.classList.add('ui-el-hover');
}
function _uiElMouseLeave(e) {
  if (_uiEditMode) this.classList.remove('ui-el-hover');
}
function _uiElClick(e) {
  if (!_uiEditMode) return;
  e.stopPropagation();
  e.preventDefault();
  _uiSelectedEl = this;
  const uiId = this.getAttribute('data-ui-id');
  document.getElementById('uiInspectorTitle').textContent = uiId;
  const inspector = document.getElementById('uiInspector');
  inspector.classList.add('open');
  _uiRenderInspector();
}

function uiEditSetTab(tab, btn) {
  _uiEditTab = tab;
  document.querySelectorAll('.uet-tab').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _uiRenderInspector();
}

function _uiRenderInspector() {
  const body = document.getElementById('uiInspectorBody');
  if (!body || !_uiSelectedEl) {
    if (body)
      body.innerHTML =
        '<div style="color:var(--text3);font-size:12px;padding:20px;text-align:center">Click an element on the page to inspect it</div>';
    return;
  }
  const uiId = _uiSelectedEl.getAttribute('data-ui-id');
  if (_uiEditTab === 'colors') {
    const cs = getComputedStyle(_uiSelectedEl);
    const uc = _uiCustomGet();
    const pageCols = uc.pages?.[_uiPageName]?.colors?.[uiId] || {};
    body.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Colors</div>' +
      _uiColorRow('Background', 'background', pageCols.background || _uiRgbToHex(cs.backgroundColor)) +
      _uiColorRow('Border', 'borderColor', pageCols.borderColor || _uiRgbToHex(cs.borderColor)) +
      _uiColorRow('Text', 'color', pageCols.color || _uiRgbToHex(cs.color)) +
      '<button class="btn btn-ghost btn-sm" style="margin-top:12px;font-size:11px;width:100%" onclick="_uiResetElementColors()">Reset to Default</button>';
  } else if (_uiEditTab === 'layout') {
    const cs = getComputedStyle(_uiSelectedEl);
    const order = _uiSelectedEl.style.order || 'auto';
    body.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Layout</div>' +
      '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Order: <input type="number" class="fi" style="width:60px;font-size:12px" value="' +
      (parseInt(order) || 0) +
      '" onchange="_uiSetOrder(parseInt(this.value))"></div>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:8px">Drag-to-reorder coming in a future update.</div>';
  } else if (_uiEditTab === 'buttons') {
    const btns = _uiSelectedEl.querySelectorAll('button, .btn, .s-item');
    let html =
      '<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Buttons</div>';
    if (!btns.length) {
      html += '<div style="font-size:12px;color:var(--text3)">No buttons in this element</div>';
    } else {
      btns.forEach((b, i) => {
        const label = b.textContent.trim().slice(0, 30) || 'Button ' + (i + 1);
        const hidden = b.style.display === 'none';
        html +=
          '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px;cursor:pointer"><input type="checkbox" ' +
          (hidden ? '' : 'checked') +
          ' onchange="_uiToggleBtn(this,' +
          i +
          ')"> ' +
          label +
          '</label>';
      });
    }
    body.innerHTML = html;
  }
}

function _uiColorRow(label, prop, currentVal) {
  return (
    '<div class="ui-color-row"><label>' +
    label +
    '</label><input type="color" value="' +
    (currentVal || '#000000') +
    '" onchange="_uiSetColor(\'' +
    prop +
    '\',this.value)"></div>'
  );
}

function _uiRgbToHex(rgb) {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '#000000';
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb.startsWith('#') ? rgb : '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
}

function _uiSetColor(prop, hex) {
  if (!_uiSelectedEl) return;
  _uiSelectedEl.style[prop] = hex;
  const uiId = _uiSelectedEl.getAttribute('data-ui-id');
  var uc = _uiCustomGet();
  if (!uc.pages) uc.pages = {};
  if (!uc.pages[_uiPageName]) uc.pages[_uiPageName] = {};
  if (!uc.pages[_uiPageName].colors) uc.pages[_uiPageName].colors = {};
  if (!uc.pages[_uiPageName].colors[uiId]) uc.pages[_uiPageName].colors[uiId] = {};
  uc.pages[_uiPageName].colors[uiId][prop] = hex;
  _uiCustomSave(uc);
}

function _uiResetElementColors() {
  if (!_uiSelectedEl) return;
  _uiSelectedEl.style.background = '';
  _uiSelectedEl.style.borderColor = '';
  _uiSelectedEl.style.color = '';
  const uiId = _uiSelectedEl.getAttribute('data-ui-id');
  var uc = _uiCustomGet();
  if (uc.pages?.[_uiPageName]?.colors?.[uiId]) {
    delete uc.pages[_uiPageName].colors[uiId];
    _uiCustomSave(uc);
  }
  _uiRenderInspector();
  showToast('Colors reset');
}

function _uiSetOrder(val) {
  if (!_uiSelectedEl) return;
  _uiSelectedEl.style.order = val;
  const uiId = _uiSelectedEl.getAttribute('data-ui-id');
  var uc = _uiCustomGet();
  if (!uc.pages) uc.pages = {};
  if (!uc.pages[_uiPageName]) uc.pages[_uiPageName] = {};
  if (!uc.pages[_uiPageName].layout) uc.pages[_uiPageName].layout = {};
  if (!uc.pages[_uiPageName].layout[uiId]) uc.pages[_uiPageName].layout[uiId] = {};
  uc.pages[_uiPageName].layout[uiId].order = val;
  _uiCustomSave(uc);
}

function _uiToggleBtn(cb, idx) {
  if (!_uiSelectedEl) return;
  const btns = _uiSelectedEl.querySelectorAll('button, .btn, .s-item');
  if (btns[idx]) btns[idx].style.display = cb.checked ? '' : 'none';
  const uiId = _uiSelectedEl.getAttribute('data-ui-id');
  var uc = _uiCustomGet();
  if (!uc.pages) uc.pages = {};
  if (!uc.pages[_uiPageName]) uc.pages[_uiPageName] = {};
  if (!uc.pages[_uiPageName].hiddenElements) uc.pages[_uiPageName].hiddenElements = [];
  const key = uiId + ':btn:' + idx;
  const arr = uc.pages[_uiPageName].hiddenElements;
  if (cb.checked) {
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1);
  } else {
    if (!arr.includes(key)) arr.push(key);
  }
  _uiCustomSave(uc);
}

async function uiEditResetPage() {
  if (!(await confirmAsync('Reset all customizations for this page?'))) return;
  var uc = _uiCustomGet();
  if (uc.pages) delete uc.pages[_uiPageName];
  _uiCustomSave(uc);
  showToast('Page customizations reset — reloading...');
  setTimeout(function () {
    location.reload();
  }, 500);
}

/* Accent color */
function siteApplyAccent(hex) {
  var r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  var root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-dim', 'rgba(' + r + ',' + g + ',' + b + ',0.12)');
  root.style.setProperty('--accent-glow', 'rgba(' + r + ',' + g + ',' + b + ',0.25)');
  root.style.setProperty('--em', hex);
  root.style.setProperty('--em-dim', 'rgba(' + r + ',' + g + ',' + b + ',0.1)');
  root.style.setProperty('--em-glow', 'rgba(' + r + ',' + g + ',' + b + ',0.22)');
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.accentColor = hex;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}

/* Backup / Restore / Reset */
function siteBackup() {
  // Get all DB data (IndexedDB-backed)
  var dbData = typeof DB !== 'undefined' && DB.isReady() ? DB.getAll() : {};
  // Also grab any remaining localStorage keys (preferences, settings)
  var lsData = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    lsData[k] = localStorage.getItem(k);
  }
  // Merge — DB data takes precedence
  var allData = Object.assign({}, lsData, dbData);
  var data = allData;
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
  var fr = new FileReader();
  fr.onload = function (ev) {
    try {
      var data = JSON.parse(ev.target.result);
      // Keys that must stay in localStorage (read synchronously before DB warms)
      var lsOnlyKeys = [
        'ch_settings',
        'ch_theme',
        'ch_user',
        'ch_activeView',
        'ch_projTabOrder',
        'ch_sidebarOrder',
        'ch_dismissed_tips',
        'ch_qs_seen',
        'ch_seen_version',
        'ch_toast_duration',
        'ch_last_seen_version',
        'ch_notifs',
      ];
      var useDB = typeof DB !== 'undefined' && DB.isReady();
      Object.keys(data).forEach(function (k) {
        var isLsKey = lsOnlyKeys.some(function (p) {
          return k === p || k.indexOf(p) === 0;
        });
        if (isLsKey || !useDB) {
          localStorage.setItem(k, data[k]);
        } else {
          // DB.set expects a parsed value, but backup stores raw JSON strings for complex types
          var val = data[k];
          try {
            val = JSON.parse(val);
          } catch (e) {
            /* leave as string */
          }
          DB.set(k, val);
        }
      });
      if (typeof showToast === 'function') showToast('Restored — reloading...');
      setTimeout(function () {
        location.reload();
      }, 1200);
    } catch (err) {
      if (typeof showToast === 'function') showToast('Invalid backup file');
    }
  };
  fr.readAsText(file);
}
function siteRestore() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = function (e) {
    processRestoreFile(e.target.files[0]);
  };
  inp.click();
}
// Drag-and-drop restore removed — restore is button-only now
async function siteResetData() {
  if (!(await confirmAsync('Reset ALL data? This cannot be undone.'))) return;
  localStorage.clear();
  sessionStorage.clear();
  if (typeof showToast === 'function') showToast('Reset — reloading...');
  setTimeout(function () {
    location.reload();
  }, 1200);
}

/* Default login redirect */
function siteCheckDefaultLogin() {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    var def = s.defaultLoginScreen || 'index';
    var cur = location.pathname.split('/').pop().replace('.html', '') || 'index';
    if (cur === 'index' && def !== 'index' && sessionStorage.getItem('ch_user')) {
      location.href = def + '.html';
      return true;
    }
  } catch (e) {}
  return false;
}

/* Mobile sidebar hamburger toggle */
function buildMobileSidebarToggle() {
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
    var bd = document.getElementById('sidebarBackdrop');
    if (bd) bd.style.display = open ? 'block' : 'none';
  };

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

  var sidebar = document.querySelector('.sidebar');
  if (sidebar && !sidebar.id) sidebar.id = 'appSidebar';
}

/* Init saved settings on load */
document.addEventListener('DOMContentLoaded', function () {
  uiCustomApply();
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    if (s.accentColor) siteApplyAccent(s.accentColor);
    var theme = s.theme || localStorage.getItem('ch_theme') || 'dark';
    siteApplyTheme(theme);
  } catch (e) {}
  if (!document.getElementById('siteSettingsOverlay')) siteBuildSettingsModal();
  // Auto-show release notes based on user preference.
  // Delay 800ms so the page finishes rendering before the modal appears.
  setTimeout(function () {
    openReleaseNotesIfNeeded();
  }, 800);
  buildMobileSidebarToggle();
});

/* Build settings modal */
var COLOR_PRESETS = [
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Rose', hex: 'var(--red)' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Orange', hex: '#f97316' },
];
function siteBuildSettingsModal() {
  var s = {};
  try {
    s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
  } catch (e) {}
  var accent = s.accentColor || '#3b82f6';
  var theme = s.theme || localStorage.getItem('ch_theme') || 'dark';
  var defPage = s.defaultLoginScreen || 'index';
  var uc = s.uiCustom || { fonts: {} };
  var ucf = uc.fonts || {};
  var fontOpts = UI_CUSTOM_SAFE_FONTS.map(function (f) {
    return '<option value="' + f + '"' + ((ucf.bodyFont || 'Outfit') === f ? ' selected' : '') + '>' + f + '</option>';
  }).join('');
  var headFontOpts = UI_CUSTOM_SAFE_FONTS.map(function (f) {
    return '<option value="' + f + '"' + ((ucf.headFont || 'Outfit') === f ? ' selected' : '') + '>' + f + '</option>';
  }).join('');

  var swatches = COLOR_PRESETS.map(function (c) {
    return (
      '<div class="color-swatch' +
      (accent === c.hex ? ' active' : '') +
      '" data-color="' +
      c.hex +
      '" style="background:' +
      c.hex +
      '" title="' +
      c.name +
      '" onclick="siteSwatchClick(this)"></div>'
    );
  }).join('');

  var loginOpts = ['index', 'service-department', 'energy-department']
    .map(function (v) {
      var labels = {
        index: 'Dashboard (index.html)',
        'service-department': 'Service Department',
        'energy-department': 'Energy Department',
      };
      return '<option value="' + v + '"' + (defPage === v ? ' selected' : '') + '>' + labels[v] + '</option>';
    })
    .join('');

  var el = document.createElement('div');
  el.id = 'siteSettingsOverlay';
  el.className = 'settings-overlay';
  el.onclick = function (e) {
    if (e.target === el) siteCloseSettings();
  };
  el.innerHTML =
    '<div class="settings-modal">' +
    '<div class="settings-hdr">' +
    '<span class="settings-title">&#9881; Settings</span>' +
    '<button class="settings-x" onclick="siteCloseSettings()">&#10005;</button>' +
    '</div>' +
    '<div class="settings-body">' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Display Mode</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Light / Dark Mode</div><div class="settings-row-sub">Choose your preferred color scheme</div></div>' +
    '<div class="theme-pills">' +
    '<button class="theme-pill' +
    (theme === 'dark' ? ' active' : '') +
    '" data-theme="dark" onclick="siteApplyTheme(\'dark\')">&#127769; Dark</button>' +
    '<button class="theme-pill' +
    (theme === 'light' ? ' active' : '') +
    '" data-theme="light" onclick="siteApplyTheme(\'light\')">&#9728;&#65039; Light</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Accent Color</div>' +
    '<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">' +
    '<div class="color-swatches" id="siteColorSwatches">' +
    swatches +
    '</div>' +
    '<div class="custom-color-row">' +
    '<input type="color" class="custom-color-input" id="siteCustomColor" value="' +
    accent +
    '" oninput="siteCustomColorChange(this.value)">' +
    '<span class="custom-color-label">Custom color</span>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Default Login Screen</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Landing page after sign-in</div><div class="settings-row-sub">Choose which page opens by default</div></div>' +
    '<select class="settings-select" onchange="siteSetDefaultLogin(this.value)">' +
    loginOpts +
    '</select>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Project Default Tab</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Tab shown when opening a project</div><div class="settings-row-sub">Dashboard or last used tab</div></div>' +
    '<select class="settings-select" onchange="sset(\'ch_defaultProjTab\',this.value)">' +
    '<option value="dashboard"' +
    (sget('ch_defaultProjTab', 'dashboard') === 'dashboard' ? ' selected' : '') +
    '>Dashboard</option>' +
    '<option value="last"' +
    (sget('ch_defaultProjTab', 'dashboard') === 'last' ? ' selected' : '') +
    '>Last Used Tab</option>' +
    '</select>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Default Export Format</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Utility data export</div><div class="settings-row-sub">Formats pre-checked when the Export Data modal opens. You can still override per export.</div></div>' +
    '<div style="display:flex;gap:14px;align-items:center;font-size:13px">' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="siteDefExpJson" ' +
    (s.defaultExportFormat && s.defaultExportFormat.json === false ? '' : 'checked') +
    ' onchange="siteSetDefaultExportFormat(\'json\', this.checked)"> JSON</label>' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="siteDefExpCsv" ' +
    (s.defaultExportFormat && s.defaultExportFormat.csv === true ? 'checked' : '') +
    ' onchange="siteSetDefaultExportFormat(\'csv\', this.checked)"> CSV</label>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Default Table Settings</div>' +
    '<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">' +
    '<div><div class="settings-row-label">Bills data table defaults</div><div class="settings-row-sub">Applied to meters without individual table settings</div></div>' +
    _siteBuildDefaultTableSection(s) +
    '</div>' +
    '<div class="settings-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">' +
    '<div><div class="settings-row-label">Reset individual meters</div><div class="settings-row-sub">Clear all per-meter table customizations so every meter uses these defaults</div></div>' +
    '<button class="btn btn-ghost" style="color:var(--red);border-color:var(--red)" onclick="siteResetAllMeterTableSettings()">Reset All Meters</button>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Fonts &amp; Text Size</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Body Font</div><div class="settings-row-sub">Main text across the site</div></div>' +
    '<select class="settings-select" onchange="uiCustomSetFont(\'bodyFont\',this.value)">' +
    fontOpts +
    '</select>' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Heading Font</div><div class="settings-row-sub">Titles and section headers</div></div>' +
    '<select class="settings-select" onchange="uiCustomSetFont(\'headFont\',this.value)">' +
    headFontOpts +
    '</select>' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Base Text Size</div><div class="settings-row-sub">' +
    (ucf.baseSize || 14) +
    'px</div></div>' +
    '<input type="range" min="12" max="18" value="' +
    (ucf.baseSize || 14) +
    '" style="width:140px" oninput="uiCustomSetFontSize(\'baseSize\',parseInt(this.value),this)">' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Sidebar Text Size</div><div class="settings-row-sub">' +
    (ucf.sidebarSize || 14) +
    'px</div></div>' +
    '<input type="range" min="11" max="15" value="' +
    (ucf.sidebarSize || 14) +
    '" style="width:140px" oninput="uiCustomSetFontSize(\'sidebarSize\',parseInt(this.value),this)">' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Calculation Transparency</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Show Calculations</div><div class="settings-row-sub">Display a &#402; badge on computed values &mdash; click to see the formula</div></div>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" ' +
    (uc.showCalcFormulas ? 'checked' : '') +
    ' onchange="uiCustomToggleCalc(this.checked)"> On</label>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Tooltips &amp; Help</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Show Tooltips</div><div class="settings-row-sub">Show contextual help bubbles on key areas of the app</div></div>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="siteTooltipsChk" ' +
    (chGetSetting('showTooltips', true) ? 'checked' : '') +
    ' onchange="chSetSetting(\'showTooltips\',this.checked)"> On</label>' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Show Quick Start Guide</div><div class="settings-row-sub">Display the step-by-step guide automatically on first visit</div></div>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="siteQsChk" ' +
    (chGetSetting('showQuickStart', true) ? 'checked' : '') +
    ' onchange="chSetSetting(\'showQuickStart\',this.checked)"> On</label>' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Reset Dismissed Tips</div><div class="settings-row-sub">Show all tips again even if you clicked &ldquo;don&rsquo;t show again&rdquo;</div></div>' +
    '<button class="btn btn-ghost btn-sm" onclick="chResetDismissedTips()">Reset Tips</button>' +
    '</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Open Quick Start Guide</div><div class="settings-row-sub">Step-by-step walkthrough of the Energy Department workflow</div></div>' +
    '<button class="btn btn-em btn-sm" onclick="siteCloseSettings();openQuickStart()">Open Guide</button>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">Layout Management</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Export / Import</div><div class="settings-row-sub">Save your customizations to a file or load from a previous export</div></div>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn btn-ghost btn-sm" onclick="uiCustomExport()">Export</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="uiCustomImport()">Import</button>' +
    '</div>' +
    '</div>' +
    '<div class="settings-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">' +
    '<div><div class="settings-row-label">Reset All Customizations</div><div class="settings-row-sub">Clear all font, color, and layout preferences</div></div>' +
    '<button class="btn btn-ghost" style="color:var(--red);border-color:var(--red)" onclick="uiCustomResetAll()">Reset All</button>' +
    '</div>' +
    '</div>' +
    '<div class="settings-section">' +
    '<div class="settings-section-title">What\'s New Popup</div>' +
    '<div class="settings-row">' +
    '<div><div class="settings-row-label">Show What\'s New</div><div class="settings-row-sub">When to show the release notes popup on page load</div></div>' +
    '<select class="settings-select" id="siteRnShowMode" onchange="siteSetRnShowMode(this.value)">' +
    '<option value="on-update"' +
    ((s.rnShowMode || 'on-update') === 'on-update' ? ' selected' : '') +
    '>Show on version updates</option>' +
    '<option value="always"' +
    (s.rnShowMode === 'always' ? ' selected' : '') +
    '>Show every login</option>' +
    '<option value="never"' +
    (s.rnShowMode === 'never' ? ' selected' : '') +
    '>Never show</option>' +
    '</select>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>';
  document.body.appendChild(el);
}
function siteSwatchClick(el) {
  document.querySelectorAll('#siteColorSwatches .color-swatch').forEach(function (s) {
    s.classList.remove('active');
  });
  el.classList.add('active');
  var hex = el.getAttribute('data-color');
  siteApplyAccent(hex);
  var ci = document.getElementById('siteCustomColor');
  if (ci) ci.value = hex;
}
function siteCustomColorChange(hex) {
  document.querySelectorAll('#siteColorSwatches .color-swatch').forEach(function (s) {
    s.classList.toggle('active', s.getAttribute('data-color').toLowerCase() === hex.toLowerCase());
  });
  siteApplyAccent(hex);
}
function siteSetDefaultLogin(val) {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.defaultLoginScreen = val;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}
function siteSetDefaultExportFormat(fmt, checked) {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    if (!s.defaultExportFormat || typeof s.defaultExportFormat !== 'object') {
      s.defaultExportFormat = { json: true, csv: false };
    }
    s.defaultExportFormat[fmt] = !!checked;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}
function siteSetRnShowMode(val) {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.rnShowMode = val;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}

/* Default Table Settings helpers */
function _siteGetDefaultTableSettings() {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    var d = s.defaultTableSettings;
    if (d && typeof d === 'object') {
      return {
        mode: d.mode === 'condensed' ? 'condensed' : 'detailed',
        hidden: Array.isArray(d.hidden) ? d.hidden : [],
      };
    }
  } catch (e) {}
  return { mode: 'detailed', hidden: [] };
}
function _siteSaveDefaultTableSettings(state) {
  try {
    var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    s.defaultTableSettings = state;
    localStorage.setItem('ch_settings', JSON.stringify(s));
  } catch (e) {}
}
function _siteDefaultTableColItems(mode) {
  var SKIP = new Set([
    'start',
    'end',
    'numberOfDays',
    'utilityCompany',
    'customerName',
    'serviceAddress',
    'accountNumber',
    'meterNumber',
  ]);
  var seen = new Set();
  var items = [];
  if (mode === 'condensed') {
    var commodities = ['Electric', 'Gas', 'Water', 'Sewer', 'Stormwater', 'Propane'];
    for (var ci = 0; ci < commodities.length; ci++) {
      var cats = CONDENSED_CATEGORIES[commodities[ci]];
      if (!cats) continue;
      for (var j = 0; j < cats.length; j++) {
        if (!seen.has(cats[j].label)) {
          seen.add(cats[j].label);
          items.push({ key: cats[j].label, label: cats[j].label });
        }
      }
    }
  } else {
    var commodities = ['Electric', 'Gas', 'Water', 'Sewer', 'Stormwater', 'Propane'];
    for (var ci = 0; ci < commodities.length; ci++) {
      var schema = _billSchemaFor(commodities[ci]);
      for (var j = 0; j < schema.length; j++) {
        var e = schema[j];
        if (e.section || SKIP.has(e.key) || seen.has(e.key)) continue;
        seen.add(e.key);
        items.push({ key: e.key, label: e.label });
      }
    }
  }
  return items;
}
function _siteBuildDefaultTableSection(s) {
  var state = _siteGetDefaultTableSettings();
  var items = _siteDefaultTableColItems(state.mode);
  var hiddenSet = {};
  for (var i = 0; i < state.hidden.length; i++) hiddenSet[state.hidden[i]] = true;
  var toggle =
    '<div style="display:flex;gap:6px">' +
    '<button class="bts-view-btn' +
    (state.mode === 'detailed' ? ' sel' : '') +
    '" onclick="siteSetDefaultTableMode(\'detailed\')" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:' +
    (state.mode === 'detailed' ? 'var(--accent)' : 'transparent') +
    ';color:' +
    (state.mode === 'detailed' ? '#fff' : 'var(--text2)') +
    ';cursor:pointer;font-size:12px">Detailed</button>' +
    '<button class="bts-view-btn' +
    (state.mode === 'condensed' ? ' sel' : '') +
    '" onclick="siteSetDefaultTableMode(\'condensed\')" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:' +
    (state.mode === 'condensed' ? 'var(--accent)' : 'transparent') +
    ';color:' +
    (state.mode === 'condensed' ? '#fff' : 'var(--text2)') +
    ';cursor:pointer;font-size:12px">Condensed</button>' +
    '</div>';
  var colLabel =
    '<div style="font-size:12px;color:var(--text3);margin-top:8px">Columns shown (' +
    (state.mode === 'condensed' ? 'condensed categories' : 'detailed fields') +
    ')</div>';
  var rows = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var esc = String(it.key).replace(/"/g, '&quot;');
    rows +=
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">' +
      '<input type="checkbox" data-dts-key="' +
      esc +
      '"' +
      (hiddenSet[it.key] ? '' : ' checked') +
      ' onchange="siteDefaultTableToggleCol(\'' +
      esc +
      '\', this.checked)"> ' +
      it.label +
      '</label>';
  }
  return (
    toggle +
    colLabel +
    '<div id="siteDefaultTableCols" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:6px 0">' +
    rows +
    '</div>'
  );
}
function siteSetDefaultTableMode(mode) {
  var state = _siteGetDefaultTableSettings();
  state.mode = mode === 'condensed' ? 'condensed' : 'detailed';
  state.hidden = [];
  _siteSaveDefaultTableSettings(state);
  var overlay = document.getElementById('siteSettingsOverlay');
  if (overlay) overlay.remove();
  siteBuildSettingsModal();
  siteOpenSettings();
}
function siteDefaultTableToggleCol(key, checked) {
  var state = _siteGetDefaultTableSettings();
  var set = {};
  for (var i = 0; i < state.hidden.length; i++) set[state.hidden[i]] = true;
  if (checked) {
    delete set[key];
  } else {
    set[key] = true;
  }
  state.hidden = Object.keys(set);
  _siteSaveDefaultTableSettings(state);
}
async function siteResetAllMeterTableSettings() {
  if (!(await confirmAsync('Reset all individual meter table settings? Meters will use the site default.'))) return;
  var toRemove = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf('bills_view_state_') === 0) toRemove.push(k);
  }
  for (var i = 0; i < toRemove.length; i++) localStorage.removeItem(toRemove[i]);
  if (typeof showToast === 'function')
    showToast('All meter table settings reset to default (' + toRemove.length + ' cleared)');
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}

/* ── RELEASE NOTES ── */
/* Single source of truth for all release notes.
   - Field names: v (version string), date (ISO date), items (array of {type, text})
   - Item types: 'feature' (+), 'fix' (checkmark), 'change' (bullet)
   - Sorted descending — index 0 is always the current/latest release.
   - ch_seen_version localStorage key stores the last version the user saw.
   - The key format matches RELEASE_NOTES[0].v (e.g. 'v2026.05.27.391').
   site-ui.js delegates to this array and should NOT maintain its own copy.
*/
var RELEASE_NOTES = [
  {
    v: 'v2026.05.27.394', date: '2026-05-27', title: 'Generate Report improvements',
    items: [
      { type: 'fix', text: "Generate Report popup — Edit buttons now open a separate window so you don't lose your selections. Previously clicking Edit navigated away from the modal." },
      { type: 'feature', text: 'Generate Report popup — warnings now show for Contract Projection, Electric, Gas, and Propane sections when data is missing, with Edit buttons to fix them' }
    ]
  },
  {
    v: 'v2026.05.27.393',
    date: '2026-05-27',
    title: 'Equipment Matrix scroll fix and legend spacing',
    items: [
      { type: 'fix', text: 'Equipment Matrix table can now scroll vertically to show all rows — previously rows were silently cut off' },
      { type: 'fix', text: 'Audit View legend bar (Yes/Fuzzy/No/N/A/--) pills are now properly spaced apart instead of running together' }
    ]
  },
  {
    v: 'v2026.05.27.392',
    date: '2026-05-27',
    title: "Equipment Matrix redesign, What's New popup, and 5 fixes",
    items: [
      { type: 'feature', text: "Equipment Matrix Summary View redesigned as a building table — shows Zone Air Temp, Heating Setpoint, Cooling Setpoint, and Zones vs Setpoints per building. Click any building to drill into its detailed equipment list." },
      { type: 'feature', text: 'Average and Total Average rows now appear at the bottom of all Equipment Matrix views (Summary, Audit, and Raw)' },
      { type: 'feature', text: "What's New popup redesigned — current version takes up the full screen, scroll down for previous versions. New settings: choose to show every login, only on updates, or never." },
      { type: 'feature', text: 'Meter Performance tab — Load Factor Trend chart and Minimum Hours chart added for electric meters. Demand chart moved above the data table.' },
      { type: 'fix', text: 'Manage Mappings — custom point mappings now actually affect the audit compliance results. Previously they were saved but had no effect.' },
      { type: 'fix', text: 'Bill extraction no longer freezes the browser during verification — large uploads process smoothly with a responsive cancel button' },
      { type: 'fix', text: 'Energy Graphics now shows Water, Sewer, and Stormwater data for projects that were missing them after the commodity migration' },
      { type: 'change', text: 'Sync to Outlook button removed from the top bar across all pages' }
    ]
  },
  {
    v: 'v2026.05.27.391',
    date: '2026-05-27',
    title: "What's New redesign, legend, timestamps, settings toggle",
    items: [
      {
        type: 'feature',
        text: "What's New popup redesigned: current version fills the modal, previous versions scroll below — making it clear you are looking at the latest release.",
      },
      {
        type: 'feature',
        text: 'Symbol legend added: + means New Feature, checkmark means Bug Fix, and bullet means Change.',
      },
      {
        type: 'feature',
        text: 'Timestamps added to each version entry so you can see when each release shipped.',
      },
      {
        type: 'feature',
        text: 'Settings toggle added: choose whether the popup appears on every login, only when a new version ships, or never.',
      },
    ],
  },
  {
    v: 'v2026.05.27.390',
    date: '2026-05-27',
    title:
      'BAS Trends — Phase 4 bill correlation, Phase 5 EM integration, moved to project subtab; tab persistence fix',
    items: [
      {
        type: 'fix',
        text: 'Tab persistence now checks sessionStorage first, then URL params, then localStorage — fixes tabs not restoring correctly after navigation.',
      },
      {
        type: 'fix',
        text: 'sv() null guard added to prevent errors when storage keys return undefined.',
      },
      {
        type: 'feature',
        text: 'BAS Trends Phase 4: bill correlation view — overlays BAS fault periods against utility bill data to quantify energy cost impact.',
      },
      {
        type: 'feature',
        text: 'BAS Trends Phase 5: EM (Energy Manager) integration — BAS Analysis button on utility bill rows launches fault correlation for that billing period.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix Phase 5: behavior column added to show control strategy per equipment unit.',
      },
      {
        type: 'feature',
        text: 'BAS Trends moved from Energy sidebar to project subtab for better context alongside project data.',
      },
    ],
  },
  {
    v: 'v2026.05.27.388',
    date: '2026-05-27',
    title: 'BAS Trends — CSV import, health score dashboard, fault log, timeline heat map, OAT scatter chart',
    items: [
      {
        type: 'feature',
        text: 'New BAS Trends view in Energy Department: import CSV trend data exported from your BAS. Find the view in the Energy project tab under BAS Trends.',
      },
      {
        type: 'feature',
        text: 'Health Score dashboard grades each equipment unit (EXCELLENT/GOOD/FAIR/POOR) across six fault categories: after-hours runtime, simultaneous heating+cooling, economizer misses, setpoint adherence, sensor health, and override rate.',
      },
      {
        type: 'feature',
        text: 'Fault Log shows detected faults as a filterable, sortable table with energy cost estimates. Faults can be acknowledged or resolved and that status is remembered.',
      },
      {
        type: 'feature',
        text: 'Timeline heat map shows fault density by equipment and month so you can spot seasonal patterns at a glance.',
      },
      {
        type: 'feature',
        text: 'OAT scatter chart plots equipment runtime or setpoint deviation against outdoor air temperature to reveal weather-dependent control problems.',
      },
    ],
  },
  {
    v: 'v2026.05.27.387',
    date: '2026-05-27',
    title: 'BACnet parser left-to-right floor scan, remove per-cell audit tooltips',
    items: [
      {
        type: 'fix',
        text: 'BACnet path floor extraction now scans left-to-right from index 2 instead of always taking the last segment. This correctly identifies floors in 4-segment paths like /Org/Building/First Floor/AHU Zone.',
      },
      {
        type: 'fix',
        text: 'Added plant, station, domestic, exterior, and interior to the BACnet segment rejection list so these equipment category nodes are never stored as floor labels.',
      },
      {
        type: 'fix',
        text: 'Removed per-cell tooltips from the Equipment Matrix audit view data cells. Legend badges and column headers retain their tooltips.',
      },
    ],
  },
  {
    v: 'v2026.05.27.386',
    date: '2026-05-27',
    title: 'Import summary with category breakdown, scrollable file list, fix row count display',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix import modal now shows a category breakdown after import (AHU, VAV, FPB, etc.) with counts and percentages, building count, BAS point count, and floor field coverage.',
      },
      {
        type: 'fix',
        text: 'Import modal row count now correctly shows equipment rows (not raw BAS points). Previously a WebCTRL import of 2,700 units would show 37,800 rows.',
      },
      {
        type: 'feature',
        text: 'File list in the import modal is now scrollable (max 150px) and shows the queued file count.',
      },
      {
        type: 'feature',
        text: 'Import modal stays open 3 seconds (4 seconds if Other rate is high) so users can read the summary before it closes.',
      },
    ],
  },
  {
    v: 'v2026.05.27.385',
    date: '2026-05-27',
    title: 'Tab persistence hotfix, Baldwin City bill extractor, Equipment Matrix Summary View',
    items: [
      {
        type: 'fix',
        text: 'Tab persistence hotfix: users who ran the IDB migration before v383 had their active tab and settings wiped. This is now repaired automatically on every page load.',
      },
      {
        type: 'feature',
        text: 'Baldwin City utility bills (electric, water, sewer) can now be extracted automatically from PDFs.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix now has a Summary View — a card-based snapshot showing average, min, and max values for each equipment category and building at a glance.',
      },
    ],
  },
  {
    v: 'v2026.05.27.384',
    date: '2026-05-27',
    title: 'Audit View point values, Manage Mappings redesign, data-loss fix',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix Audit View now shows the actual BAS point values from your data instead of just Yes/No — so you can see exactly what is monitored and what is missing.',
      },
      {
        type: 'feature',
        text: 'Manage Point Mappings has been redesigned. It now shows both mapped and unmapped points in one place, grouped by function, making it much easier to see gaps and add missing mappings.',
      },
      {
        type: 'fix',
        text: 'Fixed a data-loss bug in Manage Mappings where saving changes could silently delete custom mappings you had already set up.',
      },
    ],
  },
  {
    v: 'v2026.05.27.383',
    date: '2026-05-27',
    title: "Zoom fix, What's New button, tab persistence, auto-meter creation from bills",
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix zoom in/out now works correctly.',
      },
      {
        type: 'fix',
        text: "What's New button now works on the Energy Department page (was broken).",
      },
      {
        type: 'fix',
        text: 'Your active tab and settings now survive a page refresh — no more reverting to the Utility Data tab every time you reload.',
      },
      {
        type: 'feature',
        text: 'Bills that include an account number now automatically create a meter and match it to the right building — no manual setup needed.',
      },
    ],
  },
  {
    v: 'v2026.05.27.382',
    date: '2026-05-27',
    title: 'CSV import modal, floor column fix, lighting classification, Audit View legend',
    items: [
      {
        type: 'feature',
        text: 'CSV import now opens as a modal overlay with progress feedback so you can see what is happening during import.',
      },
      {
        type: 'fix',
        text: 'Floor column no longer shows equipment category names (like "Lighting" or "Environmental Index") — it only shows actual floor values.',
      },
      {
        type: 'fix',
        text: 'Lighting is now recognized as an equipment type and classified correctly in the Equipment Matrix.',
      },
      {
        type: 'fix',
        text: 'JOCO-style equipment names (e.g. "Cooling Towers - ADC") now parse correctly for non-HVAC equipment types.',
      },
      {
        type: 'fix',
        text: 'Audit View legend now has proper spacing and includes tooltip explanations for each compliance indicator.',
      },
      {
        type: 'fix',
        text: 'Removed the "(slow)" label from the All Rows option in the rows-per-page selector.',
      },
    ],
  },
  {
    v: 'v2026.05.27.381',
    date: '2026-05-27',
    title: 'Cleaner Equipment Matrix — no icons, no building totals, BAS point count',
    items: [
      {
        type: 'fix',
        text: 'Removed all icons and emoji from the Equipment Matrix — everything now uses plain readable text.',
      },
      {
        type: 'fix',
        text: 'Removed building summary and total rows from the Equipment Matrix to reduce clutter.',
      },
      {
        type: 'feature',
        text: 'Header now shows total BAS point count instead of a redundant row count.',
      },
      {
        type: 'fix',
        text: 'Fixed a pagination regression introduced in v380 that caused incorrect page counts.',
      },
    ],
  },
  {
    v: 'v2026.05.27.380',
    date: '2026-05-27',
    title: 'Equipment matrix UX pass 2, ASHRAE report sequence score fix, toISO guard, multi-account KGS splitting',
    items: [
      {
        type: 'fix',
        text: 'Equipment matrix: performance caching for compliance and normalization, collapse-aware pagination, Collapse All / Expand All button, empty cell span removal, search debounce.',
      },
      {
        type: 'fix',
        text: 'ASHRAE 36 report: sequence score always-0% fixed by using emComputeSequenceReadiness; gap descriptions added for ~40 missing point categories; footer blank label fixed; no-auditable-equipment sentinel.',
      },
      {
        type: 'fix',
        text: 'bill-analysis.js: toISO() now guards against double-conversion of already-ISO dates, preventing date corruption on re-import.',
      },
      {
        type: 'fix',
        text: 'energy-savings.js: multi-account KGS consolidated statements now split per account before extraction, preventing wrong meter/charge data from being saved.',
      },
    ],
  },
  {
    v: 'v2026.05.26.379',
    date: '2026-05-26',
    title:
      'Complete IndexedDB migration Batches 3-4: report history, value corrections, weather cache, bill view state, facility map',
    items: [
      {
        type: 'fix',
        text: 'Migrated en_report_history (report-engine.js, 5 call sites) and en_value_corrections + en_report_history read (csv-import.js, 3 call sites) from localStorage to IndexedDB.',
      },
      {
        type: 'fix',
        text: 'Migrated bills_view_state, bills_col_widths, en_wdd weather cache, en_utilityData legacy cleanup (utility-data.js, 7 call sites) from localStorage to IndexedDB.',
      },
      {
        type: 'fix',
        text: 'Migrated en_louisburg_facility_map (energy-savings.js, 1 call site) and en_dc_events clear (district-calendar.js, 1 call site) from localStorage to IndexedDB.',
      },
    ],
  },
  {
    v: 'v2026.05.26.363',
    date: '2026-05-26',
    title:
      'Fix Equipment Matrix frozen columns, scroll sync, scrollbar visibility, equipment name parsing, and column sort order',
    items: [
      {
        type: 'fix',
        text: 'Raised z-index ladder so frozen column headers no longer overlap scrolling content (sticky body cells: 10, all thead: 11, corner intersection: 12).',
      },
      {
        type: 'fix',
        text: 'Removed inline z-index:2 from dynamically written <th> elements so CSS z-index rules are no longer overridden by inline styles.',
      },
      {
        type: 'fix',
        text: 'Changed table border-collapse from collapse to separate+spacing:0 to fix Chrome/Edge sticky-header bug that broke frozen columns.',
      },
      {
        type: 'fix',
        text: 'Removed max-height:70vh from the scroll container so the horizontal scrollbar stays on-screen and the flex layout controls height naturally.',
      },
      {
        type: 'fix',
        text: 'Equipment name parser now auto-detects JOCO-style naming (Equipment Type - Building Abbr) so names like "Cooling Towers - ADC" display correctly.',
      },
      {
        type: 'fix',
        text: 'Dynamic columns are now sorted by point count descending after all safety-cap slicing, so the most common point names always appear leftmost.',
      },
    ],
  },
  {
    v: 'v2026.05.26.362',
    date: '2026-05-26',
    title:
      'Fix KGS startRead/endRead alias, equipment matrix empty-state + cell-budget, bill-analysis commodity filter + gas field mapping',
    items: [
      {
        type: 'fix',
        text: 'KGS bills now correctly populate billing period start/end dates (startRead/endRead). Previously these were blank due to a missing alias in the KGS extraction block.',
      },
      {
        type: 'fix',
        text: 'Equipment matrix empty-state message now appears correctly when no equipment rows are present in the current project.',
      },
      {
        type: 'fix',
        text: 'Equipment matrix cell-budget cap calculation corrected to accurately prevent runaway cell counts on edge-case datasets.',
      },
      {
        type: 'fix',
        text: 'Bill analysis commodity dropdown filter now correctly filters the bill list to show only bills of the selected commodity.',
      },
      {
        type: 'fix',
        text: 'KGS gas field mapping corrected in bill analysis so all charge fields (DeliveryCharge, GasSystemReliability, etc.) display with correct labels.',
      },
    ],
  },
  {
    v: 'v2026.05.26.361',
    date: '2026-05-26',
    title: 'Equipment Matrix render fix: limit dynamic columns to top 20, add safety cell budget',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now limits dynamic point columns to the top 20 by frequency, preventing browser freeze on BAS imports with 2,700+ rows and hundreds of unique point names.',
      },
      {
        type: 'fix',
        text: 'Safety cell-budget cap further reduces columns if estimated cells per page exceeds 10,000, even after the top-20 limit.',
      },
      {
        type: 'feature',
        text: 'Added "Show All Point Columns" / "Limit to Top 20" toggle in the column-toggles bar so power users can see all columns when needed.',
      },
    ],
  },
  {
    v: 'v2026.05.25.360',
    date: '2026-05-25',
    title: 'Equipment Matrix pagination to handle 2700+ rows without crashing',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix no longer crashes with RangeError on large datasets (2,721+ rows). Pagination renders 100 rows at a time by default.',
      },
      {
        type: 'feature',
        text: 'Previous/Next page controls and rows-per-page selector (50/100/250/All) added below the matrix table.',
      },
      { type: 'fix', text: 'Filter and column-toggle changes reset to page 1 automatically.' },
    ],
  },
  {
    v: 'v2026.05.25.359',
    date: '2026-05-25',
    title: 'Fix KGS extraction display: field order, Mcf source unit, date rendering, sum validation',
    items: [
      {
        type: 'fix',
        text: 'KGS bill fields now appear in correct order: account info, billing period/meter, balance forward, charges, totals. Previously charges appeared after totals.',
      },
      {
        type: 'fix',
        text: 'Usage field labeled "Usage (Mcf)" instead of raw unlabeled number. Date fields (BillingPeriodStart, BillingPeriodEnd, StatementDate) now display correctly instead of showing truncated digits.',
      },
      {
        type: 'fix',
        text: 'Charge sum validation now includes all KGS charges (DeliveryCharge, GasSystemReliability, WeatherNormalization, WinterEventCost, FranchiseFee). Removed duplicate FuelAdjustment alias that was inflating sums.',
      },
    ],
  },
  {
    v: 'v2026.05.25.358',
    date: '2026-05-25',
    title: 'Equipment Matrix redesign: sticky headers, edit mode toggle, dynamic columns, floor parsing',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now shows all imported equipment — no type filtering. Rows for unrecognized control programs are kept instead of dropped.',
      },
      {
        type: 'feature',
        text: 'Matrix is read-only by default. An Edit Mode toggle button enables cell editing, preventing accidental edits during review.',
      },
      {
        type: 'feature',
        text: 'Frozen header row and first 3 columns (sticky CSS) so column/row labels stay visible while scrolling large matrices.',
      },
      { type: 'feature', text: 'Thicker 14px scrollbar with accent-colored thumb for visibility on wide tables.' },
      { type: 'feature', text: 'Floor parsed from BACnet path segment 3 instead of fragile program-name regex.' },
      {
        type: 'feature',
        text: 'Column headers generated dynamically from point names in the imported data. Unused columns are omitted.',
      },
      { type: 'feature', text: 'Category column shows original control program name from BACnet path.' },
    ],
  },
  {
    v: 'v2026.05.25.357',
    date: '2026-05-25',
    title: 'KGS extraction accuracy fixes — 9 regex issues fixed, 276/276 fields correct',
    items: [
      {
        type: 'fix',
        text: 'Fixed 9 KGS regex issues in energy-savings.js: added fixNum() OCR colon-to-period normalizer, expanded char class to [\\d,.:]+, StatementDate garble fallback, RateSchedule Residential match, CustomerName same-line OCR layout, PaymentsReceived plural + CR suffix, TotalCurrentCharges multiline anchor, TotalAmountDue digit-start guard, GasSystemReliability optional CR. All 276 fields across 12 bills now extract correctly.',
      },
    ],
  },
  {
    v: 'v2026.05.25.356',
    date: '2026-05-25',
    title: 'Complete KGS bill extraction rewrite + fix save path date handling and field mappings',
    items: [
      {
        type: 'fix',
        text: 'Complete KGS extraction rewrite in energy-savings.js: dedicated parser extracts all fields — meter reads, multiplier, all charges, statement date, previous balance, payments, franchise fees.',
      },
      {
        type: 'fix',
        text: 'Fixed 5 toISO copies in bill-analysis.js for dash-format dates (MM-DD-YY), added 7 KGS field mappings, service address from filename, account auto-population on first save.',
      },
    ],
  },
  {
    v: 'v2026.05.25.355',
    date: '2026-05-25',
    title: 'Fix toDate crash on undefined input that blocks PDF extraction',
    items: [
      {
        type: 'fix',
        text: 'Added null/undefined guard to inline toDate() arrow function in _postExtractionVerify (bill-analysis.js line ~2518): if (!d) return null. Previously crashed with "Cannot read properties of undefined (reading \'length\')" whenever BillingPeriodStart or BillingPeriodEnd was missing, freezing the UI on "Verifying extraction...".',
      },
      {
        type: 'fix',
        text: 'Wrapped entire _postExtractionVerify function body in try/catch. If any verification step throws, the function logs a console.warn and returns bills unchanged rather than propagating the error to the caller.',
      },
    ],
  },
  {
    v: 'v2026.05.25.354',
    date: '2026-05-25',
    title: 'Fix 23 corrupted emoji icons showing as ? throughout EMS Leads and report engine',
    items: [
      {
        type: 'fix',
        text: 'Replaced 18 corrupted ? icons in energy-department.html: PDF/OCR Clear button (✕), column sort indicators (⇅), Add Lead button (+), Remove field button (✕), overdue/scheduled action icons (⚠/📅), sort direction (▲/▼), clear sort (✕), move up/down client type (▲/▼), delete client type (✕), CSV parse OK (✓), no duplicates (✓), Report History modal close (✕), Back to Energy Graphics (←), Return to Sign In (←), Meter Match Found (✓), CSV mapping arrow (→).',
      },
      {
        type: 'fix',
        text: 'Replaced 8 corrupted ? icons in report-engine.js: kWh Saved icon (⚡), Gal Saved propane icon (🛢), Total Saved icon (💰), delete report history button (✕), contact move up/down buttons (▲/▼), formula popover close (✕), clear notification button (✕).',
      },
    ],
  },
  {
    v: 'v2026.05.25.352',
    date: '2026-05-25',
    title: 'Fix Kansas Gas Service bill extraction (11 regex issues) and reorder Equipment Matrix tab',
    items: [
      {
        type: 'fix',
        text: 'Fixed 9 KGS extraction issues: multi-bill splitter, account number, billing period, Mcf→therms conversion, gas charge, meter number, rate schedule, service address, and customer name.',
      },
      {
        type: 'fix',
        text: 'Fixed 4 toISO() date conversion instances to handle dash-separated dates (MM-DD-YY) used in KGS bills, plus KGS-aware retry bypass to skip unnecessary OCR passes.',
      },
      {
        type: 'fix',
        text: 'Moved Equipment Matrix tab to appear between Utility Data and HVAC Load Est in the project tab bar.',
      },
    ],
  },
  {
    v: 'v2026.05.25.351',
    date: '2026-05-25',
    title: 'Fix page load lag by clearing localStorage after IndexedDB migration',
    items: [
      {
        type: 'fix',
        text: 'Added fast early-exit in migrateFromLocalStorage() when localStorage is empty, eliminating redundant IDB reads on every load after initial migration.',
      },
      {
        type: 'fix',
        text: 'localStorage is now cleared after a successful IndexedDB migration, eliminating the double-read (localStorage + IDB) that caused ~6.4s load times.',
      },
    ],
  },
  {
    v: 'v2026.05.24.350',
    date: '2026-05-24',
    title: 'Add IndexedDB storage layer with auto-migration from localStorage',
    items: [
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
    v: 'v2026.05.24.349',
    date: '2026-05-24',
    title: 'Fix saveProject recursion bug and remaining corrupted characters',
    items: [
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
    v: 'v2026.05.24.348',
    date: '2026-05-24',
    title: 'Fix corrupted Unicode characters',
    items: [
      {
        type: 'fix',
        text: 'Restored 122 corrupted Unicode characters (U+FFFD) in energy-department.html: em dashes, middle dots, angle quotes, multiplication sign, en dash, and checkmarks.',
      },
    ],
  },
  {
    v: 'v2026.05.24.347',
    date: '2026-05-24',
    title: 'Building list import from Excel/CSV',
    items: [
      {
        type: 'feature',
        text: 'Added Import List button next to Add Building in the project sidebar. Accepts .xlsx or .csv files with Building Name, SQFT, and Address columns. Shows a preview table with checkboxes before importing.',
      },
    ],
  },
  {
    v: 'v2026.05.24.346',
    date: '2026-05-24',
    title: 'Fix corrupted title tag and add inline SVG favicon',
    items: [
      {
        type: 'fix',
        text: 'Fixed corrupted title tag in energy-department.html (? → em dash) and added inline SVG favicon to all 4 HTML pages so the browser tab shows the CompanyHub icon',
      },
    ],
  },
  {
    v: 'v2026.05.22.345',
    date: '2026-05-23',
    title: 'Restore all emoji icons clobbered by batch 3 deployer',
    items: [
      {
        type: 'fix',
        text: 'Restored 134+ emoji characters in energy-department.html and app/report-engine.js that were replaced with literal ?? by a prior deployer agent — sidebar icons, nav tabs, buttons, and labels now display correctly',
      },
    ],
  },
  {
    v: 'v2026.05.22.343',
    date: '2026-05-22',
    title: 'CSP style-src fix across all HTML files for Quill stylesheet',
    items: [
      {
        type: 'fix',
        text: 'Added cdn.jsdelivr.net to CSP style-src, script-src, font-src, and connect-src in index.html, service-department.html, and ems-leads.html so Quill and other jsdelivr resources load without CSP errors',
      },
    ],
  },
  {
    v: 'v2026.05.22.342',
    date: '2026-05-22',
    title: 'BAS fault detection — simultaneous heating/cooling checks',
    items: [
      {
        type: 'feature',
        text: 'BAS Equipment Snapshot now detects simultaneous heating and cooling (SHC) faults across all zones, showing a color-coded fault table with Severe/Moderate tiers',
      },
      {
        type: 'feature',
        text: 'BAS Health Score badge added to the snapshot card title — 100 = no SHC faults, score drops proportionally with fault count',
      },
      {
        type: 'feature',
        text: 'New Fault Detection tab in the BAS snapshot panel with red count badge when faults are present',
      },
    ],
  },
  {
    v: 'v2026.05.22.341',
    date: '2026-05-22',
    title: 'Client portal and Quill CSP fix',
    items: [
      {
        type: 'fix',
        text: 'CSP fix: added cdn.jsdelivr.net to style-src in energy-department.html so Quill editor stylesheet loads without console errors',
      },
      {
        type: 'feature',
        text: 'Client portal Phase 1: one-click "Publish Portal" button on project detail exports sanitized savings data to a permanent URL clients can bookmark without login',
      },
    ],
  },
  {
    v: 'v2026.05.22.339',
    date: '2026-05-22',
    title: 'Quarterly projected savings breakdown and Node.js weather data script',
    items: [
      {
        type: 'feature',
        text: 'Quarterly savings breakdown: Energy Savings tab now shows Q1–Q4 sub-rows under the annual Projected Savings total, calculated from the existing monthly data',
      },
      {
        type: 'feature',
        text: 'Node.js weather fetch script: replaces Excel VBA macro; fetches HDD/CDD/avgTemp from weatherdatadepot.com and saves as JSON files in the repo; CompanyHub auto-loads weather data from GitHub Pages',
      },
    ],
  },
  {
    v: 'v2026.05.22.337',
    date: '2026-05-22',
    title: 'Data quality scores, address aliases, board summary report, rich text editors',
    items: [
      {
        type: 'feature',
        text: 'Data quality score per meter: A–F letter grade and 5-component score (months, R², gaps, field completeness, flags) shown as badge on meter pills and summary card in Meter Data pane',
      },
      {
        type: 'fix',
        text: 'Address alias management: bldg.address bug fixed to bldg.addr in findMeterMatch; Levenshtein fuzzy matching; alias UI in Building Edit modal; saveAddressAlias wired to PDF extraction flow',
      },
      {
        type: 'feature',
        text: 'Executive summary report: single-page board-ready report with savings vs target, contract progress, CO2 equivalents, and monthly bar chart; accessible from Board Summary button in project header',
      },
      {
        type: 'feature',
        text: 'Browser editor Phase 1: Quill rich text wired for ed-notes, mp-notes, and eq-notes fields; new lib/rich-text.js helper',
      },
    ],
  },
  {
    v: 'v2026.05.22.333',
    date: '2026-05-22',
    title: 'Cache-busting, feedback inbox download, sidebar cleanup, value correction mode, bill validation flags',
    items: [
      {
        type: 'feature',
        text: 'Cache-busting version params added to all script/stylesheet references so browsers always load the latest code after a deploy',
      },
      { type: 'feature', text: 'Feedback inbox: download button exports all captured feedback as a CSV file' },
      { type: 'feature', text: 'Sidebar button removal: cleaned up stale navigation buttons from the sidebar' },
      {
        type: 'feature',
        text: 'Value Correction Mode (VCM): select a bill field and override its value with an audited correction, stored in localStorage',
      },
      {
        type: 'feature',
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
    v: 'v2026.05.22.328',
    date: '2026-05-22',
    title: 'Fix all remaining duplicate lines in report-engine.js (P0 complete)',
    items: [
      {
        type: 'fix',
        text: 'Removed 5 additional duplicate lines in report-engine.js: chart builder calls (buildElecBarChart, buildGasBarChart, buildPropBarChart), string concat _barChart calls, and a ternary string duplicate — all left behind by the encoding fix. File is now syntax-error free.',
      },
    ],
  },
  {
    v: 'v2026.05.22.327',
    date: '2026-05-22',
    title: 'Fix duplicate const declarations in report-engine.js causing SyntaxError on live site',
    items: [
      {
        type: 'fix',
        text: 'Removed 3 duplicate const declarations (cardStyle, valColor, blEUI, statusColor) left behind by the encoding fix, which caused a fatal SyntaxError preventing the energy department page from loading',
      },
    ],
  },
  {
    v: 'v2026.05.21.326',
    date: '2026-05-21',
    title: 'Report encoding fix, chart axis alignment, and release notes auto-show',
    items: [
      {
        type: 'fix',
        text: 'Fixed 233 corrupted Unicode characters (em-dashes, multiplication signs, degree signs) in report-engine.js',
      },
      {
        type: 'fix',
        text: 'Report chart Y-axis labels now correctly left-aligned from the SVG edge instead of indented',
      },
      { type: 'feature', text: 'Release Notes modal now auto-shows on first visit after a version update' },
    ],
  },
  {
    v: 'v2026.05.21.304',
    date: '2026-05-21',
    title: 'Fix chart Y-axis label alignment in Contract Projection and Financial reports',
    items: [
      {
        type: 'fix',
        text: 'Report chart Y-axis labels now left-aligned (text-anchor="start", x=4) instead of right-indented in rptPageFinancial and rptPageContractProjection',
      },
    ],
  },
  {
    v: 'v2026.05.21.303',
    date: '2026-05-21',
    title: 'Release Notes, Savings Banner, Data Migrations',
    items: [
      { type: 'feature', text: "Release Notes — What's New modal accessible from the sidebar on all pages" },
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
    v: 'v2026.05.21.302',
    date: '2026-05-21',
    title: 'Equipment Matrix WebCTRL Format Support',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now imports WebCTRL CSV point-list exports (Location / Control Program format)',
      },
      {
        type: 'feature',
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
    v: 'v2026.05.21.300',
    date: '2026-05-21',
    title: 'Equipment Matrix Expansion + Scorecard Fix',
    items: [
      {
        type: 'feature',
        text: 'JOCO equipment matrix expanded from 19 summary rows to 1,030 individual equipment rows using real program names from audit files',
      },
      {
        type: 'fix',
        text: 'Scorecard Load Factor calculation fixed — was reading wrong field name (kw instead of demandKW)',
      },
      { type: 'fix', text: 'Project tab pane now restores to the previously active tab when reopening a project' },
      {
        type: 'feature',
        text: 'Equipment Matrix phases 4-5: full 45-column table with filtering, sorting, cell editing, CSV export, and add-row',
      },
    ],
  },
  {
    v: 'v2026.05.20.299',
    date: '2026-05-20',
    title: 'Energy Savings Matrix Improvements',
    items: [
      {
        type: 'feature',
        text: 'Per-measure rate editing with expandable detail row — edit kWh/kW/gas rates per measure, reset to building defaults',
      },
      { type: 'feature', text: 'Project Dashboard tab added as default landing tab with savings summary and calendar' },
      { type: 'feature', text: 'District Calendar replaced with upload/parse/edit flow — paste text or upload PDF' },
      { type: 'fix', text: 'Bill line items validation tolerance held at $0.10 — fixes false sum-mismatch warnings' },
      { type: 'feature', text: 'Duplicate bill detection modal now has per-bill overwrite + merge action buttons' },
    ],
  },
  {
    v: 'v2026.05.05.40',
    date: '2026-05-05',
    title: 'Solar Calc PDR Compliance + Electric Bill Line Items',
    items: [
      { type: 'feature', text: 'Solar Calc rewritten to match Excel PDR cell-for-cell across 8 sections (A-H)' },
      { type: 'feature', text: 'Net Metering and Behind the Meter profiles shown separately (Sections F and G)' },
      { type: 'feature', text: 'Solar Calc now uses live auto-calc (Excel-style) — no Calculate button needed' },
      {
        type: 'feature',
        text: 'Electric bill modal expanded with 15 new line-item fields (on-peak/off-peak, riders, franchise fee, solar credit)',
      },
      { type: 'feature', text: 'HVAC Load Estimation rebuilt per-building with Reverse Utility Analysis method' },
      {
        type: 'feature',
        text: 'Energy Savings unified — project tab and sidebar page share the same rendering function',
      },
    ],
  },
  {
    v: 'v2026.04.14',
    date: '2026-04-14',
    title: 'PDF Extraction Engine Overhaul',
    items: [
      { type: 'feature', text: 'Multi-bill PDF support — import a single PDF with 12+ monthly bills at once' },
      { type: 'fix', text: 'Evergy charge extraction regex fixed for multiline end-of-line patterns' },
      {
        type: 'fix',
        text: 'PDF page range anchored to billing period cover page — no more 5-page ranges for 3-page bills',
      },
      { type: 'fix', text: 'Sub-dollar sum mismatch auto-correction added to reduce false validation warnings' },
      { type: 'feature', text: 'Audit log added for bill changes — append-only, max 500 entries' },
    ],
  },
  {
    v: 'v2026.03.27',
    date: '2026-03-27',
    title: 'Solar Calc, Calc Templates, Energy Graphics',
    items: [
      { type: 'feature', text: 'Solar Calculator added — array sizing, tiered Evergy rate math, payback years' },
      { type: 'feature', text: 'Calc Templates launcher added to Energy Savings view' },
      {
        type: 'feature',
        text: 'Energy Graphics tab added to project detail — monthly kWh/gas charts and EUI comparison',
      },
      { type: 'feature', text: 'Number input spinners removed across all 90+ inputs — clean keyboard entry' },
      { type: 'feature', text: 'HVAC Load Estimation tab added to project detail' },
    ],
  },
  {
    v: 'v2026.03.16',
    date: '2026-03-16',
    title: 'Hybrid PDF Extraction Engine',
    items: [
      {
        type: 'feature',
        text: 'Rule-based PDF extraction added for Evergy and Spire/Laclede Gas — eliminates AI API cost for known formats',
      },
      { type: 'feature', text: 'Tesseract.js OCR fallback for scanned/image PDFs' },
      { type: 'feature', text: 'Confidence scoring — counts non-null extracted fields to measure extraction quality' },
      { type: 'change', text: 'AI removed from utility bill extraction — 100% local and offline-capable' },
    ],
  },
];

/* ── buildVersionBlock: builds one version entry as a DOM node (no innerHTML with data) ── */
function buildVersionBlock(rn, isCurrent) {
  var typeMap = {
    feature: { symbol: '+', label: 'New Feature', cls: 'rn-feat' },
    fix: { symbol: '✓', label: 'Bug Fix', cls: 'rn-fix' },
    change: { symbol: '•', label: 'Change', cls: 'rn-chg' },
    // legacy aliases from older entries
    new: { symbol: '+', label: 'New Feature', cls: 'rn-feat' },
  };

  var block = document.createElement('div');
  block.className = 'rn-version-block ' + (isCurrent ? 'rn-version-current' : 'rn-version-past');

  var header = document.createElement('div');
  header.className = 'rn-version-header';

  var vNum = document.createElement('span');
  vNum.className = 'rn-version-num';
  vNum.textContent = rn.v || rn.version || '';

  var vDate = document.createElement('span');
  vDate.className = 'rn-version-date';
  vDate.textContent = rn.date || '';

  header.appendChild(vNum);
  header.appendChild(vDate);
  block.appendChild(header);

  var ul = document.createElement('ul');
  ul.className = 'rn-items';

  var itemList = rn.items || rn.features || [];
  itemList.forEach(function (item) {
    var t = typeMap[item.type] || typeMap.change;

    var li = document.createElement('li');
    li.className = 'rn-item ' + t.cls;

    var sym = document.createElement('span');
    sym.className = 'rn-item-symbol';
    sym.title = t.label;
    sym.textContent = t.symbol;

    var txt = document.createElement('span');
    txt.className = 'rn-item-text';
    txt.textContent = item.text || '';

    li.appendChild(sym);
    li.appendChild(txt);
    ul.appendChild(li);
  });

  block.appendChild(ul);
  return block;
}

function buildReleaseNotesModal() {
  if (document.getElementById('rnOverlay')) return; // already built

  // Step 1: Static structural skeleton only — no data values in this HTML string.
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="rn-overlay" id="rnOverlay">' +
      '<div class="rn-modal">' +
      '<div class="rn-header">' +
      '<div class="rn-title-row">' +
      '<span class="rn-title"></span>' +
      '<button class="rn-close" id="rnCloseBtn">&#10005;</button>' +
      '</div>' +
      '<div class="rn-legend">' +
      '<span class="rn-legend-item rn-feat"></span>' +
      '<span class="rn-legend-item rn-fix"></span>' +
      '<span class="rn-legend-item rn-chg"></span>' +
      '</div>' +
      '</div>' +
      '<div class="rn-current" id="rnCurrent"></div>' +
      '<div class="rn-history" id="rnHistory">' +
      '<div class="rn-history-label"></div>' +
      '</div>' +
      '<div class="rn-footer">' +
      '<button class="rn-dismiss-btn" id="rnDismissBtn"></button>' +
      '</div>' +
      '</div>' +
      '</div>',
  );

  // Step 2: Populate static text via textContent (never parsed as HTML).
  var overlay = document.getElementById('rnOverlay');
  overlay.querySelector('.rn-title').textContent = "📄 What's New";
  overlay.querySelector('.rn-legend .rn-feat').textContent = '+ New Feature';
  overlay.querySelector('.rn-legend .rn-fix').textContent = '✓ Bug Fix';
  overlay.querySelector('.rn-legend .rn-chg').textContent = '• Change';
  overlay.querySelector('.rn-history-label').textContent = 'Previous Versions';
  overlay.querySelector('#rnDismissBtn').textContent = 'Got it';

  // Step 3: Wire event handlers — no inline onclick attributes.
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeReleaseNotes(false);
  });
  document.getElementById('rnCloseBtn').addEventListener('click', function () {
    closeReleaseNotes(false);
  });
  document.getElementById('rnDismissBtn').addEventListener('click', function () {
    closeReleaseNotes(true);
  });

  // Step 4: Populate version data using DOM construction — no innerHTML with data.
  var currentEl = document.getElementById('rnCurrent');
  var historyEl = document.getElementById('rnHistory');
  var labelEl = historyEl.querySelector('.rn-history-label');

  if (RELEASE_NOTES[0]) {
    currentEl.appendChild(buildVersionBlock(RELEASE_NOTES[0], true));
  }
  for (var i = 1; i < RELEASE_NOTES.length; i++) {
    // Append in order — RELEASE_NOTES is already sorted descending (newest first)
    historyEl.appendChild(buildVersionBlock(RELEASE_NOTES[i], false));
  }
}

function openReleaseNotes() {
  if (!document.getElementById('rnOverlay')) buildReleaseNotesModal();
  var overlay = document.getElementById('rnOverlay');
  if (overlay) overlay.classList.add('open');
}

/* markSeen: true = "Got it" button clicked, update ch_seen_version.
   false = X or backdrop click, do not update (modal will re-show next time if on-update mode). */
function closeReleaseNotes(markSeen) {
  if (markSeen && RELEASE_NOTES[0]) {
    localStorage.setItem('ch_seen_version', RELEASE_NOTES[0].v || RELEASE_NOTES[0].version || '');
  }
  var overlay = document.getElementById('rnOverlay');
  if (overlay) overlay.classList.remove('open');
}

/* openReleaseNotesIfNeeded: respects rnShowMode preference.
   Called on DOMContentLoaded (and delegated from site-ui.js initSiteUI). */
function openReleaseNotesIfNeeded() {
  var settings = {};
  try {
    settings = JSON.parse(localStorage.getItem('ch_settings') || '{}');
  } catch (e) {}
  var mode = settings.rnShowMode || 'on-update';
  if (mode === 'never') return;
  if (mode === 'always') {
    if (!document.getElementById('rnOverlay')) buildReleaseNotesModal();
    openReleaseNotes();
    return;
  }
  // mode === 'on-update' (default)
  var seen = localStorage.getItem('ch_seen_version');
  var latest = RELEASE_NOTES[0] && (RELEASE_NOTES[0].v || RELEASE_NOTES[0].version);
  if (seen !== latest) {
    if (!document.getElementById('rnOverlay')) buildReleaseNotesModal();
    openReleaseNotes();
  }
}

/* Expose for backward compat and cross-file delegation */
window.__siteUI = {
  openSettings: siteOpenSettings,
  closeSettings: siteCloseSettings,
  backupData: siteBackup,
  restoreData: siteRestore,
  resetData: siteResetData,
  checkDefaultLogin: siteCheckDefaultLogin,
  applyAccentColor: siteApplyAccent,
  openReleaseNotes: openReleaseNotes,
  closeReleaseNotes: closeReleaseNotes,
  openReleaseNotesIfNeeded: openReleaseNotesIfNeeded,
  RELEASE_NOTES: RELEASE_NOTES,
};

/* ── ESC KEY — closes any open modal-bg ── */
function _downloadJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function exportCurrentBillJSON() {
  if (!window._pdfMultiBills || !window._pdfMultiBills.length) {
    showToast('No extraction data to export', 'error');
    return;
  }
  const idx = window._pdfMultiIdx || 0;
  const bill = window._pdfMultiBills[idx];
  if (!bill) {
    showToast('No bill selected', 'error');
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  _downloadJSON(bill, 'bill-extraction-' + ts + '.json');
  showToast('Exported current bill to Downloads');
}
function exportMeterBillsJSON() {
  if (!udActiveMid) {
    showToast('No meter selected', 'error');
    return;
  }
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    showToast('Building not found', 'error');
    return;
  }
  const m = b.meters?.find((mm) => mm.id === udActiveMid);
  if (!m || !m.bills || !m.bills.length) {
    showToast('No bills to export', 'error');
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = (m.provider || m.commodity || 'meter').replace(/[^a-zA-Z0-9]/g, '_');
  _downloadJSON(m.bills, name + '-bills-' + ts + '.json');
  showToast('Exported ' + m.bills.length + ' bills to Downloads');
}
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    exportCurrentBillJSON();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'E') {
    e.preventDefault();
    exportMeterBillsJSON();
    return;
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  // Confirm modal takes priority — resolve false and return
  var confirmModal = document.getElementById('confirmModal');
  if (confirmModal && confirmModal.classList.contains('open')) {
    window._confirmResolve && window._confirmResolve(false);
    return;
  }
  // Report overlay is fullscreen — close it first before anything else
  var overlay = document.getElementById('reportOverlay');
  if (overlay && overlay.style.display !== 'none') {
    closeReportOverlay();
    return;
  }
  // Report history modal (flex = visible)
  var histModal = document.getElementById('reportHistoryModal');
  if (histModal && histModal.style.display === 'flex') {
    histModal.style.display = 'none';
    return;
  }
  // Report content picker modal uses .open class (not display)
  var rptModal = document.getElementById('reportBldgModal');
  if (rptModal && rptModal.classList.contains('open')) {
    rptModal.classList.remove('open');
    return;
  }
  var closers = {
    projModal: typeof closeProjModal === 'function' ? closeProjModal : null,
    bldgModal: typeof closeBldgModal === 'function' ? closeBldgModal : null,
    meterModal: typeof closeMeterModal === 'function' ? closeMeterModal : null,
    billModal: typeof closeBillModal === 'function' ? closeBillModal : null,
    taskModal: typeof closeTaskModal === 'function' ? closeTaskModal : null,
    equipModal: typeof closeEquipModal === 'function' ? closeEquipModal : null,
  };
  Object.keys(closers).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.classList.contains('open') && closers[id]) closers[id]();
  });
});
