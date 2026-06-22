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
  var COL_TOOLTIPS = {
    'RkVA Charge':
      'RKVA — Reactive kilovolt-amperes. A power factor charge on large commercial bills. Leave unchecked if not on your bills.',
    'Actual RKVA':
      'RKVA — Reactive kilovolt-amperes. The measured reactive power quantity billed. Leave unchecked if not on your bills.',
    'ECA Charge':
      'ECA — Energy Cost Adjustment. A fuel cost pass-through charge. Enable only if present on your bills.',
    'EER Charge': 'EER — Energy Efficiency Rider. A rate adjustment charge. Enable only if present on your bills.',
    'PTS Charge': 'PTS — Prairie Transition Surcharge (Evergy). Enable only if present on your bills.',
    'TDC kW Charge':
      'TDC — Transmission & Distribution Charge. A demand-based charge. Enable if present on your bills.',
    'TDC kW': 'TDC — Transmission & Distribution Charge demand quantity (kW). Enable if present on your bills.',
  };
  var rows = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var esc = String(it.key).replace(/"/g, '&quot;');
    var tip = COL_TOOLTIPS[it.label] || COL_TOOLTIPS[it.key] || '';
    var tipAttr = tip ? ' title="' + tip.replace(/"/g, '&quot;') + '"' : '';
    var tipCursor = tip ? ';cursor:help' : '';
    rows +=
      '<label' +
      tipAttr +
      ' style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0' +
      tipCursor +
      '">' +
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
    v: 'v2026.06.19.570',
    date: '2026-06-22',
    title: 'Cost Estimate columns no longer clip; column resize works; Bills charge columns grouped',
    items: [
      { type: 'fix', text: 'Cost Estimate table now scrolls horizontally when the window is too narrow — columns were being clipped and the scrollbar was hidden.' },
      { type: 'fix', text: 'Dragging a column edge to resize it in the Cost Estimate table now works correctly — column widths now stick as you drag.' },
      { type: 'fix', text: 'In the Bills table, kW demand columns (Facilities kW, Billed kW, TDC kW) are now grouped with the usage data instead of being mixed into the Charges section.' },
    ],
  },
  {
    v: 'v2026.06.19.569',
    date: '2026-06-22',
    title: 'Cost Estimate: sticky tab fix, tab icon/label overlap fix, Recommended-tier notice, hourly-rate labor totals',
    items: [
      { type: 'fix', text: 'Cost Estimate tab no longer stays visible behind other tabs — it now hides correctly when you switch to a different section.' },
      { type: 'fix', text: 'Tab bar labels and icons no longer overlap when 16 tabs are visible — text is now clipped cleanly on narrower screens.' },
      { type: 'fix', text: 'Recommended tier in Cost Estimate now shows a notice when a measure has no available substitutions (instead of silently showing nothing).' },
      { type: 'fix', text: 'Labor totals in Cost Estimate now render correctly before the parts catalog loads, and update immediately when you change hourly rates.' },
    ],
  },
  {
    v: 'v2026.06.19.568',
    date: '2026-06-19',
    title: 'Cost Estimate: estimated annual dollar-savings ranges per measure',
    items: [
      {
        type: 'feature',
        text: "Cost Estimate Recommended tier now shows estimated annual dollar savings ranges per measure (and a portfolio total) once utility bills are imported, based on published energy-savings percentages and your building's energy use; column widths now persist correctly when columns are hidden.",
      },
    ],
  },
  {
    v: 'v2026.06.19.567',
    date: '2026-06-19',
    title: 'Cost Estimate table polish: sticky headers, visible scrollbar, List/Net/Contract columns, programming quantity clarity',
    items: [
      {
        type: 'fix',
        text: "Cost Estimate table column headers now stay visible while scrolling and the horizontal scrollbar is always reachable; List, Net, and Contract prices are shown side by side; and programming rows now show how many of each equipment type need a sequence (e.g. \"1 of 33\") with a blocked/partial breakdown.",
      },
    ],
  },
  {
    v: 'v2026.06.19.566',
    date: '2026-06-19',
    title: 'Cost Estimate: ROI-ranked Recommended tier with savings rationale',
    items: [
      {
        type: 'feature',
        text: "Cost Estimate Recommended tier now ranks control upgrades by energy-savings impact (highest value first), shows the savings rationale and ASHRAE 36 reference per measure, highlights the top return-on-investment measures, and includes a measurement-and-verification disclaimer; the Audit Report explains the savings basis for each sequence.",
      },
    ],
  },
  {
    v: 'v2026.06.19.565',
    date: '2026-06-19',
    title: 'Cost Estimate label accuracy: equipment count, sensor type, ASHRAE section',
    items: [
      {
        type: 'fix',
        text: 'Cost Estimate now shows how many units of each type actually need a given device (e.g. "1 of 33 fan coil units") instead of the building total, labels zone-temp-only sensors correctly, and cites the right ASHRAE 36 section per equipment type.',
      },
    ],
  },
  {
    v: 'v2026.06.19.564',
    date: '2026-06-19',
    title: 'Cost Estimate accuracy + audit explanations',
    items: [
      {
        type: 'fix',
        text: 'VAV damper commands are now treated as programming (no phantom new-actuator cost -- the actuator is built into the VAV box), removing about $16,600 in list-price items that were never real hardware.',
      },
      {
        type: 'feature',
        text: 'Each line in the Cost Estimate tab now shows why it is needed and its ASHRAE 36 section reference so anyone reviewing the estimate can see the code basis at a glance.',
      },
      {
        type: 'feature',
        text: 'The Audit Report rationale table ("What Each Gap Addresses") now flows across as many pages as needed instead of overflowing a single page.',
      },
    ],
  },
  {
    v: 'v2026.06.19.563',
    date: '2026-06-19',
    title: 'City of Baldwin bill extraction fix',
    items: [
      {
        type: 'fix',
        text: 'City of Baldwin bill extraction: electric, water, and sewer charges are no longer mis-read from the usage number when a scanned bill drops the cents column (the charge is left blank for review instead of showing a wrong amount).',
      },
    ],
  },
  {
    v: 'v2026.06.18.562',
    date: '2026-06-18',
    title: 'Cost Estimate table polish',
    items: [
      {
        type: 'feature',
        text: 'Cost Estimate table polish -- adjustable programming hours per sequence, resizable/sortable/hideable columns that remember your layout, frozen item columns, and a building filter.',
      },
    ],
  },
  {
    v: 'v2026.06.18.561',
    date: '2026-06-18',
    title: 'Cost Estimate shows priced subtotal with pending-item caveat',
    items: [
      {
        type: 'feature',
        text: 'Cost Estimate now shows a running subtotal of priced items with a clear note for any items still pending a price or engineering review, instead of hiding the total until every line is priced.',
      },
    ],
  },
  {
    v: 'v2026.06.18.560',
    date: '2026-06-18',
    title: 'Audit Report now includes a Cost Estimate section',
    items: [
      {
        type: 'feature',
        text: 'Audit Report now includes a Cost Estimate section summarizing estimated hardware, programming, and recommended-package costs from the Cost Estimate tab (shows an import prompt when no pricing has been loaded).',
      },
    ],
  },
  {
    v: 'v2026.06.18.559',
    date: '2026-06-18',
    title: 'Cost Estimate: Recommended tier with auto-selected lowest-cost parts',
    items: [
      {
        type: 'feature',
        text: 'Cost Estimate tab now has a Recommended tier -- it auto-selects the lowest-cost qualifying part for each requirement (leaving sizing-critical valves and controllers on engineering-review defaults), adds optional fault-detection reporting, and lets you compare Compliance vs Recommended side by side.',
      },
    ],
  },
  {
    v: 'v2026.06.18.558',
    date: '2026-06-18',
    title: 'New Cost Estimate tab in ASHRAE 36 Audit',
    items: [
      {
        type: 'feature',
        text: "New Cost Estimate tab — turns the ASHRAE 36 audit's required sensors and control sequences into a priced scope of work. Import a pricing CSV (List, Net, and Contract pricing) and toggle each item on or off to build a live hardware + programming total per building.",
      },
    ],
  },
  {
    v: 'v2026.06.18.557',
    date: '2026-06-18',
    title: 'Audit Report PDF export fixed — clean pages, correct pagination',
    items: [
      {
        type: 'fix',
        text: 'Audit Report PDF export (open any project → Audit Report tab → Export PDF): each report page now exports as its own PDF page — no clipped rows or blank continuation pages.',
      },
      {
        type: 'fix',
        text: 'Executive Summary and Setpoint Review sections now paginate correctly across multiple pages, with the right amount of rows per page and a proper continuation header.',
      },
      {
        type: 'fix',
        text: 'Status-threshold footnote in the Executive Summary now reads Ready / Partial / Critical (≥75%, 50–74%, <50%) — matching the labels used throughout the report.',
      },
    ],
  },
  {
    v: 'v2026.06.18.556',
    date: '2026-06-18',
    title: 'Bill extraction queue: grouped view by account/meter',
    items: [
      {
        type: 'feature',
        text: 'Bill extraction queue (Energy Department → open a project → Bills tab → Extract Bills): when multiple files belong to the same account or meter, results now group into one consolidated row showing each billing period as its own column. Use the flat/grouped toggle to switch between the consolidated view and the original per-file view.',
      },
      {
        type: 'fix',
        text: 'When the same billing period appears more than once in a grouped account (duplicate-period edge case), each row keeps its own independent checkbox so you can choose exactly which bills to save.',
      },
    ],
  },
  {
    v: 'v2026.06.18.555',
    date: '2026-06-18',
    title: 'Equipment Matrix: VRF outdoor units and A/C units now have their own equipment types',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab): VRF outdoor units now classify as “VRF Outdoor Unit” instead of Air Handler, and standalone air conditioners (units named AC-#, found in telecom rooms, elevator machine rooms, and data closets) now classify as “A/C” instead of Other. Both types are excluded from ASHRAE-36 compliance scoring where no sequence applies.',
      },
      {
        type: 'fix',
        text: 'Energy Recovery Units (ERU-# naming) now classify as “Energy Recovery Unit” alongside ERV-# units, instead of Air Handler. Destratification fans and stairwell pressurization fans now classify as Exhaust Fan.',
      },
    ],
  },
  {
    v: 'v2026.06.18.554',
    date: '2026-06-18',
    title: 'Project tabs remember last-used tab per project; fixed corrupted checkmark on bill Confirm & Save',
    items: [
      {
        type: 'fix',
        text: "Project tabs (Energy Department → open a project) now remember the last-used tab per project and no longer carry a tab selection across different projects. Switching from one project to another restores that project's own last-used tab.",
      },
      {
        type: 'fix',
        text: 'The Confirm & Save button on the bill auto-assign panel (Energy Department → Bills tab → assign a bill) now shows a correct checkmark instead of a corrupted character.',
      },
    ],
  },
  {
    v: 'v2026.06.18.553',
    date: '2026-06-18',
    title: 'Equipment Matrix Alarms column now populates for air handlers and rooftop units',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab): the Alarms column now populates for air handlers (AHU), rooftop units (RTU), makeup air units (MAU), energy recovery ventilators (ERV), and dedicated outdoor air systems (DOAS). Alarm-relay and alarm-active status points are now recognized and mapped correctly.',
      },
    ],
  },
  {
    v: 'v2026.06.18.552',
    date: '2026-06-18',
    title: 'Equipment Matrix: furnace units, DOAS air handlers, and weather stations now classify correctly',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab): furnace units named F-# (e.g. F-2, F-4) no longer appear as exhaust fans. They now correctly show as Furnace type. Affected rows at MedAct 51 are corrected.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: dedicated outdoor air systems (labeled "Multizone VAV AHU (DOAS)") now classify as DOAS instead of generic AHU. Three JOCO units (MedAct 1131, MedAct 1159, Courthouse DOAS-1) are corrected.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: weather station control programs (labeled "Weather Station (no HVAC)") now classify as Sensor instead of Other.',
      },
    ],
  },
  {
    v: 'v2026.06.18.551',
    date: '2026-06-18',
    title: 'Equipment Matrix: air temperature and OA damper columns now populate for Rooftop and Makeup Air Units',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix Audit View (Energy Department → open a project → Equipment Matrix tab → Audit View): Supply Air Temperature, Return Air Temperature, Mixed Air Temperature, and Outside Air Damper Position now correctly populate for Rooftop Units (RTU) and Makeup Air Units (MAU). These readings were present in the raw data but were not reaching the Audit View columns — RTU-1/RTU-2 Supply/Return/Mixed Air Temp and OA Damper Position, plus MAU-1 Supply Air Temp and OA Damper Position, now all display. MAU Return/Mixed Air Temp is correctly absent (MAU is a 100% outside-air unit with no return-air path).',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix Audit View: diagnostic fault points (e.g., "Diagnostic: Outdoor Air Damper Not Modulating") no longer leak into data columns. A global filter now prevents any point whose name starts with "diagnostic" from being mapped to a live-sensor column, eliminating false readings and column collisions caused by those fault points.',
      },
    ],
  },
  {
    v: 'v2026.06.18.550',
    date: '2026-06-18',
    title: 'Equipment Matrix Audit View: Zone Setpoint and Alarms columns for Rooftop and Makeup Air Units',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab → Audit View): Rooftop Units and Makeup Air Units now show Zone Cooling Setpoint, Zone Heating Setpoint, Cooling Setpoint Adjust, and Heating Setpoint Adjust columns. These columns were already working for VAVs and AHUs — they now correctly capture the same data from RTU and MAU control programs.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix Audit View: an Alarms category is now tracked for Rooftop Units. The Alarm Relay point (e.g., "Alarm Relay Active") maps to the new Alarms column when present. The column is informational — absence does not count as a compliance gap.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix Audit View: Outdoor Air Temperature now appears correctly for Rooftop Units and Makeup Air Units. The broadcast OAT point was always being captured during import; the Audit View column was simply not wired to display it for these unit types. Now it does.',
      },
    ],
  },
  {
    v: 'v2026.06.18.549',
    date: '2026-06-18',
    title: 'Equipment Matrix: single-zone RTUs now correctly identified as SZ-RTU',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab): Two single-zone rooftop units (HHW RTU-1 and RTU-2) were incorrectly showing as VAV-RTU. The fix filters out firmware-level diagnostic fault point names that were creating false VFD and airflow signals, and adds a positive single-zone check using the controls system zone-count point. SZ-RTU now displays correctly for these units.',
      },
    ],
  },
  {
    v: 'v2026.06.17.548',
    date: '2026-06-17',
    title: 'Equipment Matrix: rooftop units now appear as their own type',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix (Energy Department → open a project → Equipment Matrix tab): Rooftop units now appear as their own type — RTU, and where the data shows it, SZ-RTU / VAV-RTU / MTZ-RTU — instead of being lumped under ‘AHU / RTU’. Units the controls label as ‘Multizone VAV’ are now correctly identified as VAV-RTU.',
      },
    ],
  },
  {
    v: 'v2026.06.17.547',
    date: '2026-06-17',
    title: 'Scrolling and modal fixes: pinned headers, smoother panels',
    items: [
      {
        type: 'fix',
        text: 'The Settings and Help modal headers now stay pinned at the top as you scroll through long content lists — previously the header scrolled away and you had to scroll back up to close or switch sections.',
      },
      {
        type: 'fix',
        text: 'The "Extraction Output" sticky header in the PDF extraction panel now blends with the panel background instead of appearing darker than the surrounding surface.',
      },
      {
        type: 'fix',
        text: 'The main content area in the Energy page no longer shows a double scrollbar when the detail pane is open. The outer container was scrolling independently of the inner pane — this is resolved.',
      },
      {
        type: 'fix',
        text: 'The content scroll model is now consistent across all pages: each tab panel handles its own scrolling, and the outer content container no longer competes with it.',
      },
    ],
  },
  {
    v: 'v2026.06.17.546',
    date: '2026-06-17',
    title: 'Project tabs: Last Used Tab now works reliably',
    items: [
      {
        type: 'fix',
        text: 'When your default tab is set to "Last Used Tab," opening a project now returns you to the tab you were on last time — including after a full page reload. Previously it always fell back to the Dashboard tab. The correct tab is now remembered separately per project.',
      },
      {
        type: 'fix',
        text: "The tab underline and the tab content panel are now always in sync. Previously, reopening a project could show the wrong tab underlined while a different tab's content was displayed.",
      },
      {
        type: 'fix',
        text: 'Projects with a specific default tab configured (e.g. always open to Budget) continue to honor that setting and are not affected by the Last Used Tab change.',
      },
    ],
  },
  {
    v: 'v2026.06.17.545',
    date: '2026-06-17',
    title: 'Equipment Matrix: column resizing fixed',
    items: [
      {
        type: 'fix',
        text: 'Dragging the resize handle on any Equipment Matrix column now resizes the correct column, does not accidentally trigger a sort, persists your column widths when you return to the page, and shows a visible grab handle at the right edge of each column header — works in both Raw View and Audit View.',
      },
    ],
  },
  {
    v: 'v2026.06.17.544',
    date: '2026-06-17',
    title: 'Utility bills: orphaned-bill cleanup and live-recompute warnings',
    items: [
      {
        type: 'feature',
        text: 'A new "Clean up orphaned" button appears in the Saved Bills header bar. Clicking it finds any saved bills whose assigned project no longer exists and unassigns them — no data is deleted, bills are just returned to the unassigned pool so they can be re-imported or re-assigned.',
      },
      {
        type: 'fix',
        text: 'Bill warning flags (amber dots) in the Utility Data tab now reflect the current data every time the tab renders, not the state when the bill was last saved. Stale warnings that no longer apply disappear automatically; new warnings appear without requiring a re-save.',
      },
    ],
  },
  {
    v: 'v2026.06.17.543',
    date: '2026-06-17',
    title: 'Equipment Matrix: furnace, heater, and DOAS air-temperature points now appear in the matrix',
    items: [
      {
        type: 'fix',
        text: 'Supply air temperature, return air temperature, and mixed air temperature readings from furnace, heater, and DOAS units were silently dropped from the Equipment Matrix after those equipment types were reclassified in a recent update. They now map correctly -- open any project in the Equipment Matrix tab and look for the Supply Air Temp, Return Air Temp, and Mixed Air Temp columns on furnace and DOAS rows.',
      },
    ],
  },
  {
    v: 'v2026.06.17.542',
    date: '2026-06-17',
    title: 'Utility bills: water vs. sewer usage mismatches now flagged as warnings',
    items: [
      {
        type: 'feature',
        text: "CompanyHub now checks each building's water and sewer bills side-by-side each month. If the usage on one side is more than double the other — or if one side shows usage while the other shows zero — an amber warning flag appears on the bill row in the Utility Data tab. The flag is dismissible with a note, just like other bill warnings, and never changes any usage values.",
      },
    ],
  },
  {
    v: 'v2026.06.17.541',
    date: '2026-06-17',
    title: 'Propane: cost now distributes correctly across months when delivery total is blank',
    items: [
      {
        type: 'fix',
        text: 'Propane deliveries where the total cost field is blank no longer show $0 cost. The system now falls back to the subtotal, or calculates cost from unit price times gallons, so propane spending distributes correctly across all months in the baseline and savings calculations.',
      },
    ],
  },
  {
    v: 'v2026.06.17.540',
    date: '2026-06-17',
    title: 'Building List import: Kansas Gas Service buildings with two accounts now import correctly',
    items: [
      {
        type: 'fix',
        text: 'Buildings with two KGS gas accounts (such as Collins House at Baker University, which has accounts at two service addresses) now import as two separate meters instead of being skipped or merged — the slash-separated account and meter numbers in the Building List are split automatically.',
      },
      {
        type: 'feature',
        text: 'The Building List import now reads KGS Service Address, Account #, and Meter # columns from the spreadsheet and creates a gas meter for each account found, with the service address stored as an address alias so future bill imports route to the right meter.',
      },
    ],
  },
  {
    v: 'v2026.06.16.539',
    date: '2026-06-16',
    title: 'Saved Bills: grouped by account/meter with deduped, date-sorted timelines',
    items: [
      {
        type: 'feature',
        text: 'Saved Bills in the project panel and bill detail modal now group by account/meter — all periods for each account roll up into one consolidated, deduplicated, date-sorted timeline instead of a flat list of individual imports.',
      },
      {
        type: 'feature',
        text: 'A "Flat list" toggle lets you switch back to the old view showing every imported bill individually, including duplicates.',
      },
      {
        type: 'feature',
        text: "Each billing period now shows a source-file badge so you can see which import file(s) contributed that period's data.",
      },
    ],
  },
  {
    v: 'v2026.06.16.538',
    date: '2026-06-16',
    title: 'Equipment Matrix Audit view: zone CO2 now shows for fan-powered and dual-duct terminals',
    items: [
      {
        type: 'fix',
        text: 'Fan-Powered Boxes (FPB/FTU) and Dual-Duct Terminals (DDVAV) now show and count zone CO2 sensors in the Equipment Matrix Audit view — they were missing the CO2 category entry that VAV terminals already had.',
      },
    ],
  },
  {
    v: 'v2026.06.16.537',
    date: '2026-06-16',
    title: 'Evergy net-metering bills: generation kWh now captured separately',
    items: [
      {
        type: 'fix',
        text: 'Evergy parallel-generation (net-metering) bills are now extracted correctly. Consumption is read from the delivery meter only (e.g. 112,252 kWh), not summed with the generation meter — fixing an over-count of ~21,000 kWh per bill.',
      },
      {
        type: 'fix',
        text: 'The Parallel Generation Credit (the credit on your bill for power sent to the grid, e.g. −$10,848) is now captured in the Solar Credit field instead of being misidentified as a Bill Offset.',
      },
      {
        type: 'feature',
        text: 'A new Generation kWh field records how many kWh were generated and sent back to the grid each billing period — visible in the bill detail for facilities with on-site solar.',
      },
      {
        type: 'fix',
        text: 'Tax-Exempt Delivery is no longer falsely set on parallel-generation bills where no Tax-Exempt charge appears.',
      },
    ],
  },
  {
    v: 'v2026.06.16.536',
    date: '2026-06-16',
    title: 'Equipment Matrix Raw View: all columns load without freezing',
    items: [
      {
        type: 'feature',
        text: 'The Raw View tab now loads all dynamic-point columns without hitting any cap — previously, large datasets could silently truncate columns to stay under a cell budget. Every point in your import now appears.',
      },
      {
        type: 'fix',
        text: 'Opening the Raw View on a large dataset (hundreds of rows, many dynamic columns) no longer freezes the page. Rows are rendered in small batches so the browser stays responsive, with a loading indicator visible while the table fills in.',
      },
      {
        type: 'fix',
        text: 'Switching filters or tabs rapidly while the Raw View is still rendering no longer causes stale data to overwrite the current view — each render cancels any prior in-progress render automatically.',
      },
      {
        type: 'change',
        text: 'Dynamic-column frequency scan (which columns exist across all equipment) is now cached after the first render — repeated Raw View loads are noticeably faster.',
      },
    ],
  },
  {
    v: 'v2026.06.16.535',
    date: '2026-06-16',
    title: 'Baker/KGS gas bills: franchise fee fix and empty-page warning',
    items: [
      {
        type: 'fix',
        text: 'KGS gas bills with two Franchise Fee lines now capture both correctly — a Tesseract OCR artifact (leading underscore) on the second line was causing it to be silently skipped, leaving the bill total slightly off.',
      },
      {
        type: 'fix',
        text: 'If a PDF page cannot be read during OCR extraction, a warning toast now appears immediately — telling you which page failed and that a billing period may be missing. Previously, a blank page would cause one period to vanish with no indication.',
      },
    ],
  },
  {
    v: 'v2026.06.16.534',
    date: '2026-06-16',
    title: 'Equipment Matrix: single-zone RTUs now show zone temps and setpoints',
    items: [
      {
        type: 'feature',
        text: 'The Equipment Matrix Summary view now includes single-zone rooftop units and air handlers in the zone temperature, heating setpoint, and cooling setpoint columns — buildings with only RTUs (like an 8-RTU office) no longer show N/A for all comfort data.',
      },
      {
        type: 'fix',
        text: 'When a single-zone unit has no dedicated zone temperature sensor, its return-air temperature is used as a proxy (single-zone return air equals space air). CO2 and humidity fallbacks work the same way.',
      },
      {
        type: 'fix',
        text: 'True multizone air handlers (supply-air only, no zone setpoints) are correctly excluded so they do not skew building averages.',
      },
    ],
  },
  {
    v: 'v2026.06.16.533',
    date: '2026-06-16',
    title: 'Audit Report polish: gauges, status chips, and overflow fixes',
    items: [
      {
        type: 'fix',
        text: 'The Building Compliance Status and Setpoint Programming Review tables now paginate correctly across pages — long portfolio reports no longer overflow into the footer.',
      },
      {
        type: 'fix',
        text: "Gauge sweeps on the audit report now start at the bottom (6 o'clock) and sweep clockwise, matching the visual expectation for a progress-style gauge. Each gauge now shows a clear caption below it.",
      },
      {
        type: 'change',
        text: 'Building status is now labeled Ready, Partial, or Critical (was Good / Needs Attention / Significant Gaps), with sensor counts shown directly in the chip — for example "Partial · 349/546 sensors".',
      },
      {
        type: 'feature',
        text: 'Setpoint Programming Review now shows one averaged row per building (heating and cooling averages across all equipment), making it easier to spot buildings that are off from the ASHRAE 36 defaults.',
      },
      {
        type: 'feature',
        text: 'The needed-sensors and needed-sequences breakdown in the audit report now lists the top missing sensor types and sequences per equipment category — so you can see at a glance what to install first.',
      },
    ],
  },
  {
    v: 'v2026.06.16.532',
    date: '2026-06-16',
    title: 'Equipment Matrix: smarter classification for 1,300+ rows',
    items: [
      {
        type: 'fix',
        text: 'About 1,227 rows that showed as "Other" in the Equipment Matrix are now classified correctly — air handlers, fans, and similar equipment appear in their proper categories instead of a catch-all bucket.',
      },
      {
        type: 'fix',
        text: 'Roughly 97 rows that were filed under Hot-Water Plant are now correctly placed: furnaces go under Furnaces, unit heaters go under Heaters, and plumbing pumps (fire pumps, sump pumps, domestic water) go under Plumbing — only true hot-water circulation pumps stay in Hot-Water Plant.',
      },
    ],
  },
  {
    v: 'v2026.06.16.531',
    date: '2026-06-16',
    title: 'ASHRAE Audit Report: equipment model overhaul',
    items: [
      {
        type: 'fix',
        text: 'Equipment counts in the ASHRAE Audit Report are now accurate. Sub-parts of the same unit (supply duct, return duct, zone sensors) are consolidated into one row per physical piece of equipment, so a single air handler no longer inflates counts.',
      },
      {
        type: 'fix',
        text: 'Chiller and boiler plant programs are folded into a single plant controller row per system. Previously each pump and sequence program counted as a separate unit.',
      },
      {
        type: 'fix',
        text: 'Unit heaters that were misfiled under chilled-water plant are now correctly classified as heaters and appear under the Heaters category.',
      },
      {
        type: 'change',
        text: 'Non-HVAC equipment (lighting, electrical panels, utility meters, fire/security) is excluded from the audit equipment list and compliance scoring.',
      },
      {
        type: 'change',
        text: 'The Equipment Summary table is now a flat list by type (AHUs, VAVs, Heaters, etc.) with no tier headers, making it easier to scan totals at a glance.',
      },
    ],
  },
  {
    v: 'v2026.06.15.530',
    date: '2026-06-15',
    title: 'ASHRAE Audit: integration stubs excluded, damper write-back tracked separately',
    items: [
      {
        type: 'fix',
        text: 'ASHRAE Audit report no longer counts WebCTRL "Data Transfer - Requesting" programs as equipment. These are signal-fanout stubs (one per served floor) that were being classified as chiller/boiler plant controllers, inflating counts and producing meaningless compliance scores.',
      },
      {
        type: 'feature',
        text: 'Damper Position Write-back is now tracked as its own sequence in the audit (ASHRAE 36 §5.6.2). Units that do not expose a damper command point in the BAS export are automatically marked N/A so they do not drag down the compliance score.',
      },
      {
        type: 'change',
        text: 'Zone Temperature Control sequence no longer requires a damper command point — that requirement moved to the new Damper Write-back sequence.',
      },
    ],
  },
  {
    v: 'v2026.06.15.529',
    date: '2026-06-15',
    title: 'Audit and Quarterly reports: pages no longer overflow, PDF matches screen',
    items: [
      {
        type: 'fix',
        text: "ASHRAE Audit report pages no longer overflow on dense buildings (e.g. 40 VAV units each missing multiple sensors). A new shared page-height calculator measures each row's actual size before splitting pages, so every page fits within its boundary.",
      },
      {
        type: 'fix',
        text: 'Quarterly report Observations pages use the same height-aware paginator — buildings no longer bleed across page boundaries on dense projects.',
      },
      {
        type: 'fix',
        text: "Exported PDFs now match what you see on screen. Previously, tall report pages were clipped at a fixed 1056 px. The PDF export now captures each page's full height and slices it into correctly-sized strips.",
      },
    ],
  },
  {
    v: 'v2026.06.13.528',
    date: '2026-06-13',
    title: 'KGS bill review: auto-corrects OCR charge errors with mismatch warning',
    items: [
      {
        type: 'fix',
        text: 'Kansas Gas Service bills: when OCR mis-reads a decimal point as a digit (e.g. $2.52 scanned as $2152, then partially corrected to $2.15), the bill review panel now detects the residual and repairs the charge to the correct value. A green correction banner shows the field name, the OCR value, and what it was corrected to.',
      },
      {
        type: 'feature',
        text: 'Kansas Gas Service bills: if a charge error cannot be safely auto-corrected (ambiguous or affects a digit-loss field), a red mismatch banner now appears showing the computed sum vs. the bill total and the reason — so the discrepancy is never silently ignored.',
      },
    ],
  },
  {
    v: 'v2026.06.13.527',
    date: '2026-06-13',
    title: 'BAS Alarms: inline drill-down and Timeline time range filter',
    items: [
      {
        type: 'feature',
        text: 'BAS Alarms: clicking a bar in the By Type, By Building, or Timeline charts now shows the matching alarms in a panel directly below the chart — no tab switch needed. A filter label shows what you are viewing; click the X to clear it and return to the full chart.',
      },
      {
        type: 'feature',
        text: 'BAS Alarms: the Timeline view now has a time range selector (All / 24 hr / 5 d / 7 d / 30 d / 60 d / 90 d / 120 d / 365 d). A data-span label shows the earliest and latest dates in the imported set. Selecting a range narrows the chart without re-importing.',
      },
    ],
  },
  {
    v: 'v2026.06.13.526',
    date: '2026-06-13',
    title: 'Baseline pane now shows correct CDD or HDD by meter type',
    items: [
      {
        type: 'fix',
        text: 'The Baseline tab in Utility Bills now shows Avg CDD (Cooling Degree Days) for Electric meters and Avg HDD (Heating Degree Days) for gas and propane meters. Previously it always showed HDD regardless of meter type.',
      },
    ],
  },
  {
    v: 'v2026.06.12.525',
    date: '2026-06-12',
    title: 'Wood River gas bills + BAS Alarms interactive table',
    items: [
      {
        type: 'feature',
        text: 'Wood River Energy gas bills now import correctly — each consolidated invoice splits into 10 per-building records with correct MMbtu totals and dollar charges. Go to any Spring Hill project, open Utility Bills, and drag in a Wood River PDF.',
      },
      {
        type: 'fix',
        text: 'BAS Alarms: grid lines are now visible between rows in the Alarm Log so the table is easy to scan.',
      },
      {
        type: 'fix',
        text: 'BAS Alarms: hovering over a Description cell in the Alarm Log shows the full text in a popup tooltip. Long descriptions are no longer hidden.',
      },
      {
        type: 'feature',
        text: 'BAS Alarms: drag the edge of any column header to resize the column. Your widths are saved and restored when you come back.',
      },
      {
        type: 'feature',
        text: 'BAS Alarms: click any bar in the By Type, By Building, or Timeline charts to filter the Alarm Log to just those alarms. A label appears showing what is filtered with an X to clear it.',
      },
      {
        type: 'fix',
        text: 'BAS Alarms: the Alarm Log now opens with the newest alarm at the top instead of the oldest.',
      },
    ],
  },
  {
    v: 'v2026.06.12.524',
    date: '2026-06-12',
    title: 'BAS Alarms: cleaner table, consistent colors, better labels',
    items: [
      {
        type: 'fix',
        text: 'Alarm Log rows no longer have a red (or any colored) background. Each row now has a subtle grid line at the bottom so the table is easy to scan.',
      },
      {
        type: 'feature',
        text: 'A Description column now appears in the Alarm Log between Source and State. Long descriptions are truncated with "..." and you can hover any cell to read the full text in a popup.',
      },
      {
        type: 'fix',
        text: 'District-level alarms (BAS email failures, trend manager errors) that had no building now show as "System Wide" everywhere -- in the table, the By Building chart, and the filter dropdown -- instead of the cryptic "(System)" label.',
      },
      {
        type: 'fix',
        text: 'All three BAS Alarms charts (By Type, By Building, Timeline) now use the site teal color consistently instead of a mix of colors.',
      },
      {
        type: 'fix',
        text: 'Filter dropdowns now read "All Buildings", "All Categories", "All States", and "All" instead of showing the field name as the blank option. The Acknowledged dropdown no longer has a duplicate entry.',
      },
      {
        type: 'fix',
        text: 'The Return-to-Normal checkbox labels now read "Include Return-to-Normal events" in full instead of an abbreviated form.',
      },
    ],
  },
  {
    v: 'v2026.06.12.523',
    date: '2026-06-12',
    title: 'BAS import modals: project field no longer shown',
    items: [
      {
        type: 'fix',
        text: 'The Import BAS Alarm Data and Import BAS Trend Data modals no longer show a project field at all when opened from inside a project. The modal now goes straight to the CSV drop zone (Alarms) or Building/Equipment/CSV steps (Trends) with no redundant project context visible.',
      },
    ],
  },
  {
    v: 'v2026.06.12.522',
    date: '2026-06-12',
    title: 'BAS import modals: project auto-selected from active project',
    items: [
      {
        type: 'fix',
        text: 'Opening the Import BAS Alarm Data or Import BAS Trend Data modal from inside a project no longer asks you to pick the project again -- it was the only way to reach those modals anyway. The project is pre-selected automatically and the Building dropdown in the Trends modal is pre-populated.',
      },
    ],
  },
  {
    v: 'v2026.06.11.521',
    date: '2026-06-11',
    title: "Quill CSS self-hosted; What's New changelog catches up to v520",
    items: [
      {
        type: 'fix',
        text: 'Quill rich-text styles are now served from this site instead of a CDN -- eliminates the repeated Edge Tracking Prevention console warning on every page load.',
      },
      {
        type: 'fix',
        text: "The What's New popup now correctly shows changelog entries back to v518. A stale cache-bust tag had prevented browsers from loading the updated list.",
      },
    ],
  },
  {
    v: 'v2026.06.11.520',
    date: '2026-06-11',
    title: 'Fix: project tab content visible again',
    items: [
      {
        type: 'fix',
        text: 'Project tab content is visible again — a hidden panel was always consuming the full page height, leaving every other tab with no room to render. All 15 project tabs are verified working.',
      },
    ],
  },
  {
    v: 'v2026.06.11.519',
    date: '2026-06-11',
    title: 'Hotfix: project tabs render again, Import Alarm Data works, alarm view refreshes after import',
    items: [
      {
        type: 'fix',
        text: 'Project tabs no longer go blank after loading — a type error in the alarm module was silently crashing the tab renderer. All 8 project tabs now display correctly.',
      },
      {
        type: 'fix',
        text: 'Import Alarm Data button in BAS Alarms is active again — the same type error was preventing the Import modal from opening.',
      },
      {
        type: 'fix',
        text: 'After importing a BAS alarm CSV, the Alarm Log view now refreshes immediately to show the imported rows without requiring a manual tab switch.',
      },
    ],
  },
  {
    v: 'v2026.06.11.518',
    date: '2026-06-11',
    title: 'BAS Alarm Log tab, sewer usage backfill, and faster bill duplicate check',
    items: [
      {
        type: 'feature',
        text: 'New Alarm Log tab in every project — import a BAS alarm CSV to see a pivot table by alarm name, a trend chart over time, and a frequency histogram. Use it to identify the top recurring alarms across your buildings.',
      },
      {
        type: 'change',
        text: 'Utility Data: on first load after this update, sewer usage may automatically backfill from water usage for months where only water was recorded. A summary toast appears and a full audit report (en_sewer_backfill_report_v1) is saved to browser storage for review in DevTools.',
      },
      {
        type: 'fix',
        text: 'Bill extraction no longer freezes the browser tab when checking a large batch of bills for duplicates — the check now yields every 5 bills and shows a progress message. Cancel is also responsive during the check.',
      },
    ],
  },
  {
    v: 'v2026.06.11.517',
    date: '2026-06-11',
    title: 'BAS Trends import improvements + KGS gas sum fix',
    items: [
      {
        type: 'fix',
        text: 'BAS Trends tab no longer shows a blank panel when opening a project — the correct project data now loads immediately.',
      },
      {
        type: 'feature',
        text: 'BAS Trends import: column mapping now shows plain-English names (Outside Air Temp, Cooling Valve %, etc.) instead of internal codes.',
      },
      {
        type: 'feature',
        text: 'BAS Trends import: Equipment Tag field now auto-suggests existing tags for the selected project/building. A warning appears if you type a name similar to an existing tag.',
      },
      {
        type: 'change',
        text: 'BAS Trends import: the Occupied Schedule step has been removed — import always uses Mon–Fri 06:00–18:00 as the default schedule.',
      },
      {
        type: 'fix',
        text: 'KGS gas early-warning check now includes Delayed Payment Charge in its sum, matching the reconciliation and bill-detail calculations.',
      },
    ],
  },
  {
    v: 'v2026.06.11.516',
    date: '2026-06-11',
    title: 'KGS gas bill fixes and smarter outlier detection',
    items: [
      {
        type: 'fix',
        text: 'KGS gas bills now correctly extract Customer Name, Service Address, GSRS and Weather Normalization credits (signed negative), Delayed Payment Charge, GasCharge line items, and Normalized Month — previously these fields were blank or wrong.',
      },
      {
        type: 'fix',
        text: 'Utility bill outlier detection now flags only order-of-magnitude errors (using a ratio band and per-day normalization), so valid seasonal swings no longer trigger false warnings.',
      },
    ],
  },
  {
    v: 'v2026.06.11.515',
    date: '2026-06-11',
    title: 'Equipment Matrix: mapping fixes and new sensor columns',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix no longer false-matches Heat Source Supply and Low Outdoor Airflow points — those readings now appear only in the correct columns.',
      },
      {
        type: 'feature',
        text: "Equipment Matrix gains six new columns: Outside Air CFM, Return Air CFM, Coil Leaving Air Temp, Valve Signal (Heating and Cooling), Building Static Pressure, Heat Source Supply, and Cool Source Supply — giving a more complete picture of each unit's airflow and hydronic status.",
      },
    ],
  },
  {
    v: 'v2026.06.11.514',
    date: '2026-06-11',
    title: 'Report: Building Baseline Data table on its own page',
    items: [
      {
        type: 'fix',
        text: 'Building Baseline Data table now prints on its own page so it is no longer clipped by the page footer.',
      },
    ],
  },
  {
    v: 'v2026.06.11.513',
    date: '2026-06-11',
    title: 'Equipment Matrix: Setpoint Adjust columns repositioned',
    items: [
      {
        type: 'change',
        text: 'Equipment Matrix now shows the Cooling Setpoint Adjust column immediately right of Cooling Setpoint, and Heating Setpoint Adjust immediately right of Heating Setpoint — making it easier to compare setpoints and their adjustments side by side.',
      },
    ],
  },
  {
    v: 'v2026.06.11.512',
    date: '2026-06-11',
    title: 'Report layout fixes: duplicate heading, clipped column header, and first-page overflow',
    items: [
      { type: 'fix', text: 'Appendix B no longer shows a duplicate heading at the top of the section.' },
      {
        type: 'fix',
        text: 'The Financial Summary "Savings" column header no longer gets clipped — text now wraps correctly.',
      },
      {
        type: 'fix',
        text: 'Executive Summary first page now fits more comfortably — reduced rows per page prevents the table from overflowing or being cut off.',
      },
    ],
  },
  {
    v: 'v2026.06.11.511',
    date: '2026-06-11',
    title: 'Equipment Matrix point-mapping Phase 1: category fix + expanded patterns + false-positive guards',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix no longer misfiles points into the wrong category when a point name matches more than one pattern — the most specific category now wins.',
      },
      {
        type: 'feature',
        text: 'Outdoor air temperature, heating hot-water supply/return, and chilled-water differential pressure points are now recognized and mapped automatically across more naming conventions.',
      },
      {
        type: 'fix',
        text: 'Hot-water supply/return and chilled-water differential pressure points that are actually setpoints, valve positions, or alarms are no longer misclassified as sensor readings.',
      },
      {
        type: 'fix',
        text: 'Return air humidity points used for diagnostics (e.g., chart or trend names) are no longer pulled in as equipment sensors.',
      },
      {
        type: 'change',
        text: 'Mapping improvements apply automatically at read time — no need to re-import existing equipment data.',
      },
    ],
  },
  {
    v: 'v2026.06.11.510',
    date: '2026-06-11',
    title: 'City of Baldwin bill extraction: account identity, address, and billing-date fixes',
    items: [
      {
        type: 'fix',
        text: 'City of Baldwin utility bills now correctly identify separate accounts (water, sewer, electric) so bills from one account are never merged into another. Address and sewer-charge fallback detection now handles more bill formats, and billing dates are reconstructed when not printed explicitly.',
      },
    ],
  },
  {
    v: 'v2026.06.11.509',
    date: '2026-06-11',
    title: 'Audit Report PDF export no longer fails past page 70',
    items: [
      {
        type: 'fix',
        text: 'Exporting a long Audit Report (90+ pages, such as JOCO) no longer produces blank or failed-to-render pages in the second half of the PDF. Each page canvas is now disposed after it is written to the PDF, preventing GPU memory from accumulating across pages.',
      },
    ],
  },
  {
    v: 'v2026.06.11.508',
    date: '2026-06-11',
    title: 'Equipment Matrix Summary View no longer shows weather stations',
    items: [
      {
        type: 'fix',
        text: 'The Equipment Matrix Summary View building list no longer includes campus-wide weather stations (AccuWeather, NWS, and similar) as pseudo-buildings — only real buildings with actual equipment appear in the list.',
      },
    ],
  },
  {
    v: 'v2026.06.11.507',
    date: '2026-06-11',
    title: 'KGS gas bill extraction and display overhauled',
    items: [
      {
        type: 'feature',
        text: 'KGS gas bills now capture the per-Mcf rate breakdown — WNA/Mcf and Cost of Gas/Mcf are extracted and shown in the bill detail panel so you can see exactly how the commodity rate is built up.',
      },
      {
        type: 'feature',
        text: 'KGS Franchise Fee is now split into two separate line items (Franchise Fee 1 and Franchise Fee 2) matching the actual bill, and both are saved and displayed correctly.',
      },
      { type: 'fix', text: 'KGS bill totals no longer have floating-point rounding errors on the Gas Charge line.' },
      {
        type: 'fix',
        text: 'KGS extraction now runs a per-Mcf validation pass — if the main charge line is missing or misread, the extractor recovers the value from the per-Mcf rate fields instead of leaving it blank.',
      },
      {
        type: 'change',
        text: 'KGS bill detail panel is restructured: Charges group shows individual lines, then the total, then Amount Due below — matching the layout of the actual bill. Balance-forward items no longer feed into the running total.',
      },
      {
        type: 'change',
        text: 'Edit modal for KGS bills in the Import CSV screen now shows Mcf (not CCF) in the usage field label, matching the utility.',
      },
    ],
  },
  {
    v: 'v2026.06.11.505',
    date: '2026-06-11',
    title: 'ASHRAE 36 Audit PDF export no longer clips content past page 1',
    items: [
      {
        type: 'fix',
        text: 'ASHRAE 36 Audit report PDF export now spans as many pages as needed — buildings with many equipment points (such as a large courthouse) generate 20+ pages with clean row breaks instead of clipping everything past the first page.',
      },
    ],
  },
  {
    v: 'v2026.06.10.504',
    date: '2026-06-10',
    title: 'Appendix B regression formula text now wraps',
    items: [
      {
        type: 'fix',
        text: 'Appendix B regression-detail table: formula cells in the Calculation column now wrap instead of overflowing the page width.',
      },
    ],
  },
  {
    v: 'v2026.06.10.503',
    date: '2026-06-10',
    title: 'Contract Projection chart bars no longer too wide',
    items: [
      {
        type: 'fix',
        text: 'Contract Projection chart bars are now capped at 28px wide with a proportional gap, so bars no longer overflow into adjacent slots. Bar positions remain evenly distributed across the chart.',
      },
    ],
  },
  {
    v: 'v2026.06.10.502',
    date: '2026-06-10',
    title: 'Report appendix pages no longer print their title twice',
    items: [
      {
        type: 'fix',
        text: 'All four report appendix pages (A: Normalization, B: Regression, C: Weather, D: Bills) no longer show the appendix title twice. The duplicate heading that appeared below the page header is removed; sub-section headings and all other content are unchanged.',
      },
    ],
  },
  {
    v: 'v2026.06.10.501',
    date: '2026-06-10',
    title: 'Kansas Gas Service bills now split by page so billing periods read correctly',
    items: [
      {
        type: 'fix',
        text: 'Kansas Gas Service bills now split on PDF page boundaries instead of the mid-page Statement Date line. Previously, 10 of 11 bills in a multi-page KGS PDF showed a billing period unreadable error. Re-import any KGS bill PDFs to pick up corrected billing periods.',
      },
    ],
  },
  {
    v: 'v2026.06.10.500',
    date: '2026-06-10',
    title: 'PDF export reverted to stable version; audit cover gauge labels fixed',
    items: [
      {
        type: 'fix',
        text: 'PDF export reverted to the stable pre-v498 version — the experimental multi-page slicer dropped the footer, made page-1 margins inconsistent, and bloated the ASHRAE Audit from 31 to 124 pages (37 MB). The stable single-capture approach is restored; the old clipping-on-very-tall-pages limitation is back and will be redone properly later.',
      },
      {
        type: 'fix',
        text: 'ASHRAE-36 Audit cover gauges (Sensor Coverage, Sequence Coverage, Setpoint Coverage) no longer show a redundant double label. The inner SVG label is now suppressed on the cover page; per-building gauges are unchanged.',
      },
    ],
  },
  {
    v: 'v2026.06.10.499',
    date: '2026-06-10',
    title: 'EMS Leads: arrow and lightning glyphs now display correctly',
    items: [
      {
        type: 'fix',
        text: 'The EMS Leads page no longer shows garbled characters (mojibake) in place of the left-arrow, lightning bolt, and up/down-arrow icons. All four glyphs now render correctly.',
      },
    ],
  },
  {
    v: 'v2026.06.10.498',
    date: '2026-06-10',
    title: 'PDF export: full multi-page reports now captured completely',
    items: [
      {
        type: 'fix',
        text: 'Report PDFs no longer clip content past the first page. All 4 report types (Quarterly, Annual, ASHRAE Audit, Proposal) now capture the full page height, slice it into correct PDF pages, and show per-page progress while exporting. Very tall pages use a lower capture scale to avoid browser memory limits.',
      },
    ],
  },
  {
    v: 'v2026.06.10.497',
    date: '2026-06-10',
    title: 'Report tables: headers and cells now wrap instead of clipping',
    items: [
      {
        type: 'fix',
        text: 'Financial Summary, EUI Benchmarking, and Electric Detail report tables no longer clip long column headers or building names. Text now wraps within each column so all content is visible.',
      },
    ],
  },
  {
    v: 'v2026.06.10.496',
    date: '2026-06-10',
    title: 'Quarterly Report: building names no longer repeat in the savings table',
    items: [
      {
        type: 'fix',
        text: 'In the Quarterly Report Savings Performance / Annual Summary by Building table, each building name now appears once across both rows (baseline and current year) instead of repeating on each row.',
      },
    ],
  },
  {
    v: 'v2026.06.10.495',
    date: '2026-06-10',
    title: 'Equipment Matrix: zone setpoints now display for FCU equipment',
    items: [
      {
        type: 'fix',
        text: 'Heating and cooling setpoints now appear for FCU equipment (fan coil units, PTACs, unit ventilators) in the Equipment Matrix Summary and Detail views. Two view filters were excluding all FCU rows from zone setpoint display. JOCO buildings are predominantly FCUs, so setpoint columns showed blanks even though the values were present in the imported data. No re-import needed.',
      },
    ],
  },

  {
    v: 'v2026.06.10.494',
    date: '2026-06-10',
    title: 'Equipment Matrix: PTAC and Unit Ventilator units now classify correctly',
    items: [
      {
        type: 'fix',
        text: 'PTAC (packaged terminal air conditioner/heat pump) units now classify as FCU in the Equipment Matrix instead of landing in the catch-all Other bucket. Covers labels like PTAC-1, PTH-2, and "Packaged Terminal".',
      },
      {
        type: 'fix',
        text: 'Unit Ventilator units (UV-1, UV-12, "unit ventilator", "unit vent") now classify as FCU. The UV pattern requires a digit suffix so germicidal UV-C / UVGI labels are not accidentally caught.',
      },
      {
        type: 'change',
        text: 'Removed a duplicate internal dictionary entry for Weather Station — no visible change; the sensor classification is unchanged.',
      },
    ],
  },

  {
    v: 'v2026.06.10.493',
    date: '2026-06-10',
    title: 'Equipment Matrix: HVAC equipment now sorts first by default',
    items: [
      {
        type: 'fix',
        text: 'The Equipment Matrix Raw and Audit views now show HVAC equipment (AHUs, VAVs, FCUs, etc.) at the top of the list by default, even for data imported before this fix. Previously, equipment appeared in alphabetical order, burying HVAC rows behind lighting and other equipment. Click any column header to sort manually — the default HVAC-first order restores when you clear the sort.',
      },
    ],
  },

  {
    v: 'v2026.06.10.492',
    date: '2026-06-10',
    title: 'Audit Report cover page: clearer labels for non-technical readers',
    items: [
      {
        type: 'change',
        text: 'The gauge inside the cover page ring now reads Sensors instead of Points — consistent with per-building pages and easier to understand at a glance.',
      },
      {
        type: 'change',
        text: 'The gauge caption now reads Sequence Readiness instead of Sequence Coverage — matches the Executive Summary column header.',
      },
      {
        type: 'change',
        text: 'The stat card now reads HVAC Systems Audited instead of Equipment Units Audited — removes BAS jargon for county decision-makers.',
      },
    ],
  },

  {
    v: 'v2026.06.10.491',
    date: '2026-06-10',
    title: 'Equipment Matrix: Summary view now has CO2 and Humidity columns',
    items: [
      {
        type: 'feature',
        text: 'Summary view now shows CO2 (ppm) and Humidity (%) columns to the right of the zone temperature columns. These columns are always visible and use the same N/A / dash / value logic as zone temperature — N/A when a building has no zone equipment, a dash when equipment exists but no readings were imported, and the average value otherwise.',
      },
    ],
  },

  {
    v: 'v2026.06.10.490',
    date: '2026-06-10',
    title: 'Equipment Matrix: Summary view now shows all buildings',
    items: [
      {
        type: 'fix',
        text: 'Summary view now lists every building in the matrix, including AHU-only and plant-only buildings that were previously missing when a type filter was active.',
      },
      {
        type: 'fix',
        text: 'Zone temperature columns now correctly show 0 as a real reading, display N/A (gray italic) when a building has no zone equipment, and show a dash when a building has zone equipment but no readings in the import.',
      },
      {
        type: 'fix',
        text: 'Selecting a single building in the building filter no longer collapses the Summary to one row — the filter is suppressed in Summary view so all buildings remain visible for comparison.',
      },
      {
        type: 'feature',
        text: 'Zone Temp column now recognizes additional WebCTRL snapshot column-name variants (zone_air_temp, zone_temp, zone_temperature) so readings from recent imports map correctly without re-import.',
      },
    ],
  },

  {
    v: 'v2026.06.10.489',
    date: '2026-06-10',
    title: 'Audit Report: Affected Units count now correct for all gaps',
    items: [
      {
        type: 'fix',
        text: 'The Recommendations page in the ASHRAE-36 Audit Report now correctly counts affected buildings for every gap — gaps that ranked 6th or lower per building were previously missed in the Affected Units tally. The top-5 display cap is unchanged.',
      },
    ],
  },

  {
    v: 'v2026.06.10.488',
    date: '2026-06-10',
    title: 'Equipment Matrix: CSV upload panel now scrolls on large imports',
    items: [
      {
        type: 'fix',
        text: 'The Equipment Matrix CSV upload panel no longer runs off the bottom of the screen after a large import — it now scrolls so the category summary, warnings, and Done button are always reachable.',
      },
    ],
  },

  {
    v: 'v2026.06.10.487',
    date: '2026-06-10',
    title: 'Equipment Matrix: collision rule fix + collision warning in Raw View',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now correctly resolves collisions where two BAS points map to the same column — a numeric reading always wins over a text value, matching the import-time rule.',
      },
      {
        type: 'feature',
        text: 'Raw View "All BAS Points" drawer now shows an amber warning triangle on any point whose column is shared by more than one BAS point — collisions are no longer silent.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix no longer crashes when data is still loading — shows a Loading message instead.',
      },
    ],
  },

  {
    v: 'v2026.06.10.486',
    date: '2026-06-10',
    title: 'ASHRAE-36 report: fix gauge label overflow',
    items: [
      {
        type: 'fix',
        text: 'ASHRAE-36 Compliance Report gauge labels (Sequences, Overall, Sensors) no longer clip inside the ring — the gauge canvas is now 11% taller so labels appear clearly below the ring arc.',
      },
    ],
  },

  {
    v: 'v2026.06.10.485',
    date: '2026-06-10',
    title: 'Building Summary report: 6 chart and layout fixes',
    items: [
      {
        type: 'fix',
        text: 'Chart labels and axis titles now display correctly — the Y-axis title appears vertically beside the chart, and a Month caption appears below the legend.',
      },
      {
        type: 'fix',
        text: 'December bars no longer get cut off — EUI monthly bars now shrink to fit narrow columns instead of overflowing.',
      },
      {
        type: 'fix',
        text: 'Quarterly reports now show only the 3 months in the reporting period for both baseline and actual data. Annual reports are unaffected.',
      },
      {
        type: 'fix',
        text: 'EUI chart height and bar heights are now consistent — baseline and current bars align correctly on the same scale.',
      },
      {
        type: 'fix',
        text: 'Value labels now appear above both baseline and current bars. A dead hardcoded orange color was removed so the correct theme color is always used.',
      },
      {
        type: 'fix',
        text: 'The baseline data table at the bottom of building summary pages stays together and no longer splits across a page break when printing.',
      },
    ],
  },

  {
    v: 'v2026.06.10.484',
    date: '2026-06-10',
    title: 'Baldwin Electric OCR: three extraction fixes',
    items: [
      {
        type: 'fix',
        text: 'Baldwin Electric bills with a negative fuel adjustment (e.g., −$338.40) now calculate the correct total. Previously, the em-dash used as a minus sign was not recognized, silently inflating the bill total by the fuel-adjustment amount.',
      },
      {
        type: 'fix',
        text: 'Baldwin Electric pages that start with an em-dash prefix (—) are now included in extraction. Previously, page 23 and similar pages were invisible to the charge-line reader and returned no data.',
      },
      {
        type: 'fix',
        text: 'Baldwin Electric account numbers that were garbled by OCR (look-alike letters such as O→0, l→1, S→5) are now auto-corrected and accepted. Pages that previously required Manual Review solely due to a garbled account number will now extract successfully. The UI will flag any OCR-guessed account number for user verification.',
      },
    ],
  },

  {
    v: 'v2026.06.10.483',
    date: '2026-06-10',
    title: 'ASHRAE-36 audit report now groups equipment into 3 tiers',
    items: [
      {
        type: 'feature',
        text: 'ASHRAE-36 Audit Report: equipment tables now use a 3-tier HVAC hierarchy — Tier 1 Plant & Central (chillers, boilers, cooling towers), Tier 2 Primary Air Systems (AHUs, DOAS, furnaces), Tier 3 Zone Terminals (VAVs, fan-powered boxes, FCUs, heaters, exhaust fans). Each building page also shows whether dedicated BAS power-monitoring and outdoor-air sensor programs were found in the export.',
      },
    ],
  },

  {
    v: 'v2026.06.10.482',
    date: '2026-06-10',
    title: 'Constellation multi-building bills: correct dates and no duplicate buildings',
    items: [
      {
        type: 'fix',
        text: "Constellation gas bills for Baker University (and any account with 10+ buildings on one PDF) now show correct billing dates and each building appears only once. Previously, all buildings were inheriting the invoice header address instead of their own address, causing the system to collapse 190 bills into one group and generate bogus labels like Dec 2038 counting down. The extractor now anchors each building's address to its own section of the PDF.",
      },
    ],
  },

  {
    v: 'v2026.06.09.481',
    date: '2026-06-09',
    title: 'Bill extraction no longer leaks browser memory',
    items: [
      {
        type: 'fix',
        text: 'PDF bill imports now release all browser memory after each extraction — PDF documents, page canvases, OCR workers, and queued file bytes are all freed when done or when you clear the import. Previously, extracting many bills in a row could cause the page to slow down or run out of memory.',
      },
    ],
  },

  {
    v: 'v2026.06.09.480',
    date: '2026-06-09',
    title: 'Constellation gas import recovers more bills from difficult OCR scans',
    items: [
      {
        type: 'fix',
        text: 'Constellation gas bills: the import engine now handles wider spacing between the charge label and the usage number, and also catches the OCR artifact "MMBtY" that some scans produce instead of "MMBtu". This recovers bills that were previously skipped entirely — usage now imports correctly instead of showing blank.',
      },
    ],
  },

  {
    v: 'v2026.06.09.479',
    date: '2026-06-09',
    title: 'Project tabs fit equally across the bar; Annual Projected tile no longer clips',
    items: [
      {
        type: 'fix',
        text: 'Project tabs (Energy Department): all 14 tabs now share the full tab bar equally — no scrolling, no overflow. Icons are always visible at every screen width. Text is slightly smaller to fit comfortably.',
      },
      {
        type: 'fix',
        text: 'Dashboard Annual Projected tile: the tile no longer gets clipped or squeezed off-screen when the card is narrow. The dollar value now shows whole dollars (e.g. $39,000/yr) instead of cents, saving space.',
      },
    ],
  },

  {
    v: 'v2026.06.09.478',
    date: '2026-06-09',
    title: 'Constellation gas bill usage now imports correctly',
    items: [
      {
        type: 'fix',
        text: 'Constellation gas bills: usage was being counted three times over — once per MMBtu line in the bill — causing totals like 1,950 or 14,670 therms instead of the correct 650. Bills now import the actual metered quantity once.',
      },
    ],
  },

  {
    v: 'v2026.06.09.477',
    date: '2026-06-09',
    title: 'Quarterly Report shows correct quarter, Equipment Matrix distinguishes blank points',
    items: [
      {
        type: 'fix',
        text: 'Quarterly Report: when you select Q1, Q2, Q3, or Q4 in the report settings, the report now pulls data for that quarter only — previously it always showed Q4 regardless of your selection.',
      },
      {
        type: 'fix',
        text: 'Quarterly Report Executive Summary: buildings with no applicable ASHRAE sequences now show "N/A" instead of a percentage that made no sense, and the section title reads "Building Compliance Status."',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: points that exist in the BAS but have no value (blank/null readings) now show a distinct amber "--" state, separate from points that are truly absent. This makes gap analysis more accurate.',
      },
    ],
  },

  {
    v: 'v2026.06.09.476',
    date: '2026-06-09',
    title: 'City of Baldwin bill import accuracy and speed improved',
    items: [
      {
        type: 'fix',
        text: 'City of Baldwin electric bills: charges were being inflated 100x due to a decimal-comma misread in OCR text — e.g. "1,234" was parsed as 1234 instead of the correct 1.234. Dollar amounts now import correctly.',
      },
      {
        type: 'fix',
        text: 'City of Baldwin bills: franchise fee (EI-prefixed line items) was being skipped and not included in the imported total. It now counts toward the billed amount.',
      },
      {
        type: 'fix',
        text: 'City of Baldwin bills: the meter-read numbers (e.g. previous/current readings) were occasionally being mistaken for charge amounts. A guard now prevents meter-read values from being counted as charges.',
      },
      {
        type: 'fix',
        text: 'City of Baldwin bills: validation was flagging correct imports as mismatches due to the decimal-comma and dropped-fee issues above. Imports that pass the corrected extraction should no longer show false validation warnings.',
      },
      {
        type: 'change',
        text: 'City of Baldwin OCR extraction is now faster — PDF text is processed with an optimized pass that reduces redundant scanning.',
      },
    ],
  },

  {
    v: 'v2026.06.09.475',
    date: '2026-06-09',
    title: 'Contract Projection chart direction glyphs fixed; report sequence labels now fully spelled out',
    items: [
      {
        type: 'fix',
        text: 'Quarterly Report Contract Projection page: the direction indicator next to the target comparison now shows ▲ (ahead of target) or ▼ (behind target) instead of a stray "?" symbol.',
      },
      {
        type: 'fix',
        text: 'Quarterly Report Contract Projection, Observations, and Set Points pages: charts and content now use the full available width — a double-padding bug that squeezed content too narrow has been removed.',
      },
      {
        type: 'change',
        text: 'ASHRAE 36 Audit Report: sequence readiness labels in the "Sequences Not Ready" column are now fully spelled out — e.g. "Demand-Controlled Ventilation (AHU)" instead of "DCV (AHU)", "Supply Air Temperature Reset" instead of "SAT Reset".',
      },
    ],
  },

  {
    v: 'v2026.06.09.474',
    date: '2026-06-09',
    title: 'Report print layout fixed on both report types; Appendix A/B regression values restored',
    items: [
      {
        type: 'fix',
        text: 'Quarterly and ASHRAE reports: footers are now pinned to the bottom of each page instead of floating mid-page.',
      },
      {
        type: 'fix',
        text: 'Reports: page margins are now a consistent 0.5 inch (48px) on both sides — matching the intended layout.',
      },
      {
        type: 'fix',
        text: 'Reports: page content is no longer clipped — overflow is visible so nothing gets cut off.',
      },
      {
        type: 'fix',
        text: 'Quarterly Report Appendix A: R-squared values and regression type now appear for all meters instead of showing dashes.',
      },
      {
        type: 'fix',
        text: 'Quarterly Report Appendix B: regression equations now render for all meters with sufficient baseline data.',
      },
    ],
  },

  {
    v: 'v2026.06.09.473',
    date: '2026-06-09',
    title: 'Equipment Matrix fixes + Baker KGS multi-account parsing fix',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: clicking Manage Mappings no longer gets stuck on "Building point list..." when your data triggers an error — the error now surfaces as a visible message instead of silently failing.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: clicking Manage Mappings a second time while the modal is loading no longer stacks a duplicate overlay.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: sequence readiness cells in the audit view now show proper labels (e.g. "DCV (VAV)") in their hover tooltips instead of raw internal keys.',
      },
      {
        type: 'fix',
        text: "Baker KGS bills: OCR'd bills that include a payment stub repeating the same account number no longer produce phantom parse-error records.",
      },
    ],
  },

  {
    v: 'v2026.06.09.472',
    date: '2026-06-09',
    title: 'Light mode fix on energy pages + empty state positioning',
    items: [
      {
        type: 'fix',
        text: 'Light mode: stat cards, section headers, and data tables on the Baseline Data and Meter Data tabs now display correctly with proper background and text colors — they no longer stay dark when you switch to light mode.',
      },
      {
        type: 'fix',
        text: 'Energy Savings Measures: the "No measures yet" message now appears centered below the table header, where it is easy to read — it was previously mispositioned inside the table structure.',
      },
    ],
  },

  {
    v: 'v2026.06.08.471',
    date: '2026-06-09',
    title: 'Report EUI benchmark chart legend dedup',
    items: [
      {
        type: 'fix',
        text: 'Energy reports: the EUI benchmark chart legend no longer shows duplicate entries when viewing a report.',
      },
    ],
  },

  {
    v: 'v2026.06.08.470',
    date: '2026-06-09',
    title: 'Energy Savings Measures: permanent delete, savings display, propane rate persistence',
    items: [
      {
        type: 'fix',
        text: 'Energy Savings Measures: clicking the red X now permanently removes a measure — it no longer reappears after refreshing the page.',
      },
      {
        type: 'fix',
        text: 'Energy Savings Measures: savings values now display correctly for all buildings, including those that previously showed blank.',
      },
      {
        type: 'fix',
        text: 'Energy Savings Measures: propane $/gallon rate now saves correctly when you click Save Rates and persists on reload.',
      },
    ],
  },

  {
    v: 'v2026.06.08.469',
    date: '2026-06-08',
    title: 'Equipment Matrix FTU/VFD classification, Zone sensor mapping, project tab order fix',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: Fan Terminal Units are now correctly classified as fan-powered boxes — they no longer appear in the air-handler category.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: VFD Integration control programs are no longer grouped under air handlers — they are excluded from that category so AHU rows stay clean.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: Zone Humidity, Zone CO2, and Discharge Airflow points on terminal units now map to their correct columns instead of being dropped.',
      },
      {
        type: 'fix',
        text: 'Project tab order corrected: Equipment Matrix now appears after Utility Data and BAS Trends now appears before Project Settings. Tab order also persists correctly after navigating away and back.',
      },
    ],
  },

  {
    v: 'v2026.06.08.468',
    date: '2026-06-08',
    title:
      'Report style cleanup, zero-value baseline months, Equipment Matrix mapping fixes, Constellation per-building bills',
    items: [
      {
        type: 'fix',
        text: 'ASHRAE 36 Audit Report: colored background fills have been removed from status badges and category rows — the report now matches a clean print-ready style.',
      },
      {
        type: 'fix',
        text: 'Quarterly Report: the Baseline Data table now shows months with recorded zero values instead of silently dropping them — no baseline data is hidden.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: points with a blank value no longer block a real value from showing up in the same column for the same piece of equipment.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: dedicated outdoor-air temperature sensors now correctly map their live reading to the Outdoor Air Temp column.',
      },
      {
        type: 'fix',
        text: 'Constellation gas invoices: each building is now identified by its unique Customer ID, full account numbers are captured correctly, and duplicate amendment pages are de-duplicated so bills are not double-counted.',
      },
    ],
  },

  {
    v: 'v2026.06.08.467',
    date: '2026-06-08',
    title: 'ASHRAE 36 Setpoint Programming Review: smarter building roll-up',
    items: [
      {
        type: 'change',
        text: 'Setpoint Programming Review report: when every zone in a building has the same setpoint deviation (e.g., all cooling setpoints are 1 °F high), those individual zone rows are now collapsed into a single building-level finding — making the report shorter and easier to act on.',
      },
      {
        type: 'feature',
        text: 'Setpoint Programming Review report: zones whose setpoints could not be found in the BAS export are now surfaced as a separate finding, so nothing is silently skipped.',
      },
    ],
  },

  {
    v: 'v2026.06.08.466',
    date: '2026-06-08',
    title: 'Quarterly report fixes (6 bugs) and Equipment Matrix ASHRAE 36 setpoint value compliance',
    items: [
      {
        type: 'fix',
        text: 'Environmental Impact report page: duplicate pollutant entries and an unclosed div are fixed — the page now renders correctly.',
      },
      {
        type: 'fix',
        text: 'Observations page: building status arrows now show the correct up/right/down direction instead of a question mark.',
      },
      {
        type: 'fix',
        text: 'Propane report page: buildings are now filtered by whether they have propane monthly data, not by whether a baseline value is set. Buildings with propane deliveries but no set baseline will now appear correctly.',
      },
      {
        type: 'fix',
        text: 'Financial Summary page: the Quarterly Savings vs Baseline sub-table header columns no longer clip — the last column (Actual Savings) now wraps and displays fully.',
      },
      {
        type: 'fix',
        text: 'Observations & Recommendations page: content now paginates across multiple report pages when there are many buildings, instead of overflowing off the bottom.',
      },
      {
        type: 'fix',
        text: 'Savings Performance page: the savings percentage now uses the same usage-based formula as Financial Summary (baseline usage minus actual usage, divided by baseline usage). The pages now agree.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix Audit View: new Setpoint Values column checks actual zone setpoint values from your BAS export against ASHRAE Guideline 36 defaults (GL36 Section 3.1.1.1 / Table 3.1.1.3). Heating/cooling and CO2 setpoints flagged if they differ from GL36 defaults by more than 1 deg F or 50 ppm. Gray = no setpoint data; green = all match; orange/red = mismatches (hover for detail). Mark intentional overrides in the compliance detail panel.',
      },
    ],
  },

  {
    v: 'v2026.06.08.465',
    date: '2026-06-08',
    title: 'ASHRAE 36 PDF export and Save now work for both Audit Report and Service Proposal',
    items: [
      {
        type: 'fix',
        text: 'Export to PDF and Save Report in the ASHRAE 36 Audit Report and Service Proposal now work correctly — they were silently doing nothing before. Export filenames now also distinguish between the two report types (e.g. "Project - ASHRAE 36 Audit Report 2026.06.08.pdf" vs "...Service Proposal...").',
      },
    ],
  },
  {
    v: 'v2026.06.08.464',
    date: '2026-06-08',
    title: 'Cache-bust fix: v463 responsive tabs now load correctly in all browsers',
    items: [
      {
        type: 'fix',
        text: 'Browser cache-busting tags updated so the v463 responsive project sub-tabs (icons at wide width, compact when narrow) load correctly without requiring a hard refresh.',
      },
    ],
  },
  {
    v: 'v2026.06.08.463',
    date: '2026-06-08',
    title: 'Project tabs are now responsive — icons at full width, compact when narrow',
    items: [
      {
        type: 'feature',
        text: 'Project sub-tabs now show emoji icons and full spacing when the window is wide enough, and automatically switch to a compact (icon-free) layout with a thin scrollbar when the window is too narrow to fit them all.',
      },
    ],
  },
  {
    v: 'v2026.06.08.462',
    date: '2026-06-08',
    title: 'Project tabs: icons removed, spacing tightened, thin scrollbar added',
    items: [
      {
        type: 'fix',
        text: 'Project sub-tabs no longer get cut off at narrow window widths — icons are removed, spacing is tightened, and a thin scrollbar appears when tabs overflow so you can scroll to any tab.',
      },
    ],
  },
  {
    v: 'v2026.06.08.461',
    date: '2026-06-08',
    title: 'Report chart fix, letter-grade badge restored, propane/gas pages, anomaly kWh, z-score',
    items: [
      {
        type: 'fix',
        text: 'Savings Performance report: bar chart now shows one bar per metric instead of two stacked bars — the duplicate bars left over from the Jun-5 fix are removed.',
      },
      {
        type: 'fix',
        text: 'Data Quality badge on meter tiles: letter grade (A/B/C/D/F) is restored; Jun-5 inadvertently replaced it with a percentage score.',
      },
      {
        type: 'feature',
        text: 'Propane and natural gas utility data now have dedicated allocation pages in the Pipeline Diagram tab, consistent with electric meters.',
      },
      {
        type: 'change',
        text: 'Anomaly Detection panel: Actual column now shows the real billed kWh from your utility bill instead of the prorated estimate.',
      },
      {
        type: 'change',
        text: 'Anomaly z-score calculation uses leave-one-out averaging, which prevents the flagged month itself from pulling the mean and masking a real spike.',
      },
    ],
  },
  {
    v: 'v2026.06.05.460',
    date: '2026-06-05',
    title: 'Saved Bills panel: delete bills already assigned to a meter',
    items: [
      {
        type: 'fix',
        text: 'Saved Bills panel: bills already assigned to a meter now have a working Delete button, and deleting one removes it from both the saved list and the meter.',
      },
    ],
  },
  {
    v: 'v2026.06.05.459',
    date: '2026-06-05',
    title: 'Saved Bills panel: easier-to-find Delete button per bill',
    items: [
      {
        type: 'change',
        text: "Saved Bills panel: each bill now has a clearly labeled red 'Delete' button so individual bills are easy to remove. The panel also has a new 'Delete' column header and is a bit wider so nothing gets cut off.",
      },
    ],
  },
  {
    v: 'v2026.06.05.458',
    date: '2026-06-05',
    title: 'Project Saved Bills panel no longer clipped by the Buildings rail',
    items: [
      {
        type: 'fix',
        text: 'Saved Bills panel now opens full-width so bills and the delete buttons are no longer cut off in the project Bills view.',
      },
    ],
  },
  {
    v: 'v2026.06.05.457',
    date: '2026-06-05',
    title: 'Saved Bills records open full-window and deletions now stick',
    items: [
      {
        type: 'change',
        text: 'The Saved Bill Records window now opens nearly full-screen instead of a narrow box, so you can see far more bills at once without scrolling a cramped list.',
      },
      {
        type: 'fix',
        text: 'Deleting a saved bill — or clearing all unassigned saved bills — now saves correctly. Previously a deleted bill could reappear after refreshing; deletions are now stored reliably.',
      },
    ],
  },
  {
    v: 'v2026.06.05.456',
    date: '2026-06-05',
    title: 'Energy Savings tab moves left of Energy Graphics; tab scrollbar removed',
    items: [
      {
        type: 'fix',
        text: 'Energy Savings tab now appears immediately to the left of Energy Graphics in the project tab strip. If you had previously reordered your tabs, a one-time migration moves Savings into place while preserving all your other custom ordering.',
      },
      {
        type: 'fix',
        text: 'The project tab strip no longer shows a cosmetic horizontal scrollbar gutter when all tabs fit on screen (a Windows display setting was triggering it). Scrolling and drag-reorder continue to work normally.',
      },
    ],
  },
  {
    v: 'v2026.06.04.455',
    date: '2026-06-04',
    title: 'BAS Set Points version selector honest error message',
    items: [
      {
        type: 'fix',
        text: 'BAS Set Points: clicking Baseline or Current on a project with no setpoints saved was showing a false success message. It now shows a clear message explaining that no setpoints have been saved yet, so you know exactly what to do next.',
      },
    ],
  },
  {
    v: 'v2026.06.04.454',
    date: '2026-06-04',
    title: 'BAS Trends tab renders correctly',
    items: [
      {
        type: 'fix',
        text: 'BAS Trends tab was showing a blank screen when opened on any project. It now correctly shows the empty state ("No BAS trend data imported yet" with an Import button) or your imported trend data when available.',
      },
    ],
  },
  {
    v: 'v2026.06.04.453',
    date: '2026-06-04',
    title: 'Bill anomaly false-flag fix, trend arrows, tab underline, Meter Data Quality R² real-data fix',
    items: [
      {
        type: 'fix',
        text: 'Bill Anomaly Detection: Louisburg High School September was incorrectly flagged as anomalous. The detector now matches bills by calendar month across years and sorts correctly, eliminating false alarms on multi-year utility accounts.',
      },
      {
        type: 'fix',
        text: 'Reports: trend arrows (up/down indicators) were displaying incorrectly due to a broken comparison. Arrows now point the right direction.',
      },
      {
        type: 'fix',
        text: 'Reports: switching tabs no longer resets to the Dashboard tab when re-opening a project. Your last-used tab is remembered correctly.',
      },
      {
        type: 'fix',
        text: 'Tab underline highlight now stays in sync when opening project detail views — the active tab indicator no longer mismatches the visible panel.',
      },
      {
        type: 'fix',
        text: 'Meter Data Quality: R² (correlation) score now calculates correctly on real meter data — was still showing 0/25 meters after the previous fix.',
      },
    ],
  },
  {
    v: 'v2026.06.04.452',
    date: '2026-06-04',
    title: 'Meter Data Quality R² fixed, bill table row numbers, Hours weekly entry/views, Equipment tab removed',
    items: [
      {
        type: 'fix',
        text: 'Meter Data Quality: the R² (correlation) score now calculates correctly — it was showing 0 for all 25 meters. The months label in the chart also no longer shows "undefined".',
      },
      {
        type: 'fix',
        text: 'Bill table: the stray dollar-sign icon that appeared on the Normalized Month column is removed. A row-number column (#) now appears at the left of the table so you can count bills at a glance.',
      },
      {
        type: 'feature',
        text: 'Hours: you can now log hours by week using a weekly entry form, and switch between Weekly and Monthly views to see your time at different levels of detail.',
      },
      {
        type: 'change',
        text: 'The broken Equipment tab under Projects has been removed — it was not functional and caused confusion.',
      },
    ],
  },
  {
    v: 'v2026.06.04.451',
    date: '2026-06-04',
    title: 'Report fixes — no stacking, no duplicate blocks, consistent margins/footers/page numbers',
    items: [
      {
        type: 'fix',
        text: 'Reports no longer stack on top of each other when opened multiple times in a session — each preview is fully cleared before generating a new one.',
      },
      {
        type: 'fix',
        text: 'Report pages no longer show duplicate content blocks (affected 9 block types in the Objective Report). Each block now appears exactly once per page.',
      },
      {
        type: 'change',
        text: 'Every report page now has consistent 0.5-inch margins, a CSC footer, and Page X of Y numbering including the Board Summary page. The CSC letterhead appears on the cover page only — not on interior pages.',
      },
    ],
  },
  {
    v: 'v2026.06.04.450',
    date: '2026-06-04',
    title: 'Savings fix — Louisburg no longer shows phantom Therms and Gallons saved',
    items: [
      {
        type: 'fix',
        text: 'Energy Savings: the Therms Saved and Gallons Saved totals for Louisburg (and any project with missing gas/propane bill data) no longer show wildly inflated numbers. The fix gates unit savings on the same condition as dollar savings, so the two figures stay internally consistent.',
      },
    ],
  },
  {
    v: 'v2026.06.04.449',
    date: '2026-06-04',
    title:
      'Equipment Matrix offline-point display, Summary stale-data callout, audit column reorder; $0 bill fields no longer dropped; provider-aware OCR scoring',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: offline points (marked with ?) now show the word "offline" instead of a question mark, and still count toward the point totals.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix Summary table now flags buildings with stale data and shows setpoint tooltips on hover.',
      },
      {
        type: 'change',
        text: 'Equipment Matrix audit column order now leads with zone comfort data (temperature, setpoints) for faster gap analysis.',
      },
      {
        type: 'fix',
        text: 'Bill Analysis: $0 cost and usage fields are no longer blanked out or erased when you save — zero is a valid value and is now preserved correctly across all 11 affected sites.',
      },
      {
        type: 'fix',
        text: 'Bill Analysis OCR scoring now correctly handles all utility providers, not just Evergy — improving extraction accuracy for KGS, Spire, and generic providers.',
      },
    ],
  },
  {
    v: 'v2026.06.04.448',
    date: '2026-06-04',
    title: 'Budget tab security fix — user text is now safely escaped',
    items: [
      {
        type: 'fix',
        text: 'Notes, commodity names, building names, modal scope options, and modal note fields in the Budget tab are now HTML-escaped before display. This closes a security hole where specially crafted text could run as code in the browser.',
      },
    ],
  },
  {
    v: 'v2026.06.03.447',
    date: '2026-06-03',
    title: 'Hours per project tracking — new Hours subtab on every project',
    items: [
      {
        type: 'feature',
        text: 'Each project now has a Hours subtab. Log time entries (0.25–24 h) with a date and optional note. The subtab shows a running log and total hours. Add, edit, or delete entries anytime.',
      },
    ],
  },
  {
    v: 'v2026.06.03.446',
    date: '2026-06-03',
    title: 'CSV condensed-column renders genuine zero as $0.00 instead of dash',
    items: [
      {
        type: 'fix',
        text: 'In the Bill Analysis condensed row view, a 0 value in a currency or usage column now shows as $0.00 (or 0) instead of a dash. Rates that are truly absent still show a dash.',
      },
    ],
  },
  {
    v: 'v2026.06.03.445',
    date: '2026-06-03',
    title:
      'ASHRAE report cover singular phrasing and Service Proposal CO2/DCV scope row; CSV zero-value fix; Equipment Matrix collision priority and key rename',
    items: [
      {
        type: 'fix',
        text: "ASHRAE 36 Audit Report cover stat cards now use singular phrasing (e.g. '1 Sensor' instead of '1 Sensors').",
      },
      {
        type: 'feature',
        text: 'Service Proposal report now includes a CO2/DCV Demand-Controlled Ventilation row in the Scope of Work section.',
      },
      {
        type: 'fix',
        text: 'CSV import no longer treats 0 (zero) as a missing value -- 0 kWh or 0 therms is valid data and is now preserved.',
      },
      {
        type: 'fix',
        text: 'Bill analysis stats and missing-value checks updated to match: a zero reading is counted as data present, not absent.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: when a real sensor and a virtual/calculated point share the same key, the real sensor now wins (collision priority).',
      },
      {
        type: 'fix',
        text: "Equipment Matrix: points stored under a 'Live'-suffix key (e.g. 'Outdoor Air TempLive') are now automatically recognized under the standard key name, so no data re-import is needed.",
      },
    ],
  },
  {
    v: 'v2026.06.03.444',
    date: '2026-06-03',
    title: 'Audit Report overhaul: ASHRAE 36 Audit Report rename, scope-of-work cover, per-building equipment table',
    items: [
      { type: 'change', text: "Report is now called 'ASHRAE 36 Audit Report' (was 'ASHRAE 36 Assessment Report')." },
      {
        type: 'change',
        text: 'Cover page now shows a purpose statement explaining what ASHRAE 36 is, what the report shows, and how to use it.',
      },
      {
        type: 'change',
        text: 'Cover stat cards now show actionable scope-of-work counts: Sensors to Install, Sequences to Program, Equipment Units Audited, and Buildings Assessed -- replacing the internal compliance status counts that were shown before.',
      },
      {
        type: 'feature',
        text: 'Per-building pages are rebuilt as a structured equipment table (Equipment | Type | Sensors Present | Sensors Needed | Sequences Not Ready) so you can see exactly what each unit has and what it needs, grouped by equipment type.',
      },
      {
        type: 'fix',
        text: 'AI-style grey box fills and left-border accents have been removed from all report sections -- prose blocks are now clean and white.',
      },
      {
        type: 'fix',
        text: 'Report date no longer appears twice; the date picker in the Generate Report dialog now controls the date shown in the footer.',
      },
      { type: 'fix', text: 'Page numbers now appear on every page of the report.' },
      {
        type: 'fix',
        text: 'Executive Summary table columns renamed to Sensor Coverage and Sequence Readiness; a legend is added explaining the 40/60 score formula and status thresholds.',
      },
      {
        type: 'fix',
        text: "Raw internal code 'vav_dcv' no longer appears in reports -- it now shows as 'DCV (VAV)'. CO2/DCV items are de-duplicated so they appear as one row instead of three.",
      },
    ],
  },
  {
    v: 'v2026.06.03.443',
    date: '2026-06-03',
    title:
      'Equipment Matrix building-filter scoping and ASHRAE column ordering; Utility Data tab bar scrolls at narrow widths',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: when you filter by building, optional audit columns with no matching points in that building are now hidden, keeping the view focused on what that building actually has.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix: audit columns are now ordered by ASHRAE 36 logical groups (Air Temps, Outside Air, Zone/Space, Setpoints, Flow/Damper/Valve, Fan/Status/Commands, Plant/Central) instead of insertion order.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix: required columns are no longer accidentally hidden when a DOAS row appears before an AHU row for the same shared key (e.g. Outdoor Air Temp).',
      },
      {
        type: 'fix',
        text: 'Utility Data: the Saved Bills and meter tab bar now scrolls horizontally at narrow widths instead of clipping off the last tabs.',
      },
    ],
  },
  {
    v: 'v2026.06.03.442',
    date: '2026-06-03',
    title: 'Equipment Matrix: color-only status cells, accurate compliance counting, OA sensor mapping, Has Data label',
    items: [
      {
        type: 'change',
        text: 'Equipment Matrix status cells are now color-only (green/amber/red) -- the old Yes/Fuzzy/No text labels are gone. Hover any cell to see the point name and match confidence.',
      },
      {
        type: 'fix',
        text: 'Compliance counting is now accurate -- points with blank values and points from enriched CSV imports are both recognized, eliminating false red "Not found" cells for points that are actually present.',
      },
      {
        type: 'fix',
        text: 'OAT, zone temperature, and zone setpoint column keys are now credited toward compliance for all equipment types, including standalone sensor programs.',
      },
      {
        type: 'fix',
        text: 'Outside Air temperature points from standalone sensor programs (equipment type "sensor") are now mapped correctly in the Equipment Matrix.',
      },
      {
        type: 'change',
        text: 'The "Live Data" pill in the Equipment Matrix header has been relabeled "Has Data" to more accurately reflect that it counts imported snapshot values, not real-time readings.',
      },
    ],
  },
  {
    v: 'v2026.06.02.441',
    date: '2026-06-02',
    title: 'EM import fix, Summary view, bill parsing fix, and zoom controls on tables',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: importing a point with a value of 0 now preserves that value instead of treating it as missing.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix Summary view now shows ALL buildings -- equipment with no zone assignment appears under a "no zone equip" row instead of being silently dropped.',
      },
      {
        type: 'fix',
        text: 'Zones-vs-Setpoints chart now reads from normalized point columns so zone temperatures display correctly for all equipment types.',
      },
      {
        type: 'fix',
        text: 'Manage Mappings panel opens without freezing -- point list is now rendered in chunks to keep the browser responsive.',
      },
      {
        type: 'fix',
        text: 'Zone CO2 now recognizes "AV" in the point name as an alias so more CO2 points are classified correctly.',
      },
      {
        type: 'fix',
        text: 'Toast notifications (action confirmations) are now visible on the Energy Department page.',
      },
      {
        type: 'fix',
        text: 'Energy Department page now scrolls horizontally on mobile so tables are not clipped.',
      },
      {
        type: 'fix',
        text: 'ASHRAE report recommendations are now concise -- each recommendation is a single focused sentence instead of a multi-paragraph block.',
      },
      {
        type: 'fix',
        text: '618 8th St gas bill: billing period dates now parse correctly from this utility format.',
      },
      {
        type: 'feature',
        text: 'Zoom controls added to Meter Performance, Budget, and ECM Calculator tables -- use + / - to adjust text size for easier reading.',
      },
    ],
  },
  {
    v: 'v2026.06.02.440',
    date: '2026-06-02',
    title: 'Equipment Matrix: point-matching quality fix (M1-M8)',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now correctly classifies ~157 previously mis-mapped points -- outdoor airflow no longer lands in zone discharge-flow columns, water-system flow points no longer appear in airflow columns, building static pressure routes to the right column, and cross-system variants (CHW/DHW/alarm) are blocked from hot-water columns.',
      },
      {
        type: 'feature',
        text: 'ASHRAE 36 compliance scoring now covers DOAS, hot-water pump, chilled-water pump, and broadcast-point equipment types that were previously unscored.',
      },
      {
        type: 'fix',
        text: 'Several column-display and compliance-scoring engines now share the same improved matching logic -- a point that displays in the correct column also scores correctly for gap analysis.',
      },
    ],
  },
  {
    v: 'v2026.06.02.439',
    date: '2026-06-02',
    title:
      'Equipment Matrix Phase 3a: 28 new point categories, regrouped Manage Mappings, OA humidity/dewpoint/enthalpy, reheat valve fix',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now recognizes 28 additional point types across AHU, VAV, FCU, heater, exhaust fan, zone, and furnace equipment -- preheat temp, coil leaving temps, return CO2/RH, duct static pressure setpoints, ventilation CFM, damper positions, fan amps, and more are now classified instead of falling through to "Other".',
      },
      {
        type: 'feature',
        text: 'The Manage Mappings dropdown is now organized into 10 intuitive subject groups (Temperatures, Airflow, Humidity, CO2/IAQ, Pressures, Valves/Dampers, Fan/Pump Status, Demand/Mode, Setpoints, Other) instead of a flat alphabetical list -- easier to find the right mapping.',
      },
      {
        type: 'feature',
        text: 'Outside Air Relative Humidity, Dewpoint, and Enthalpy columns now appear for AHU and zone-level equipment (VAV, FCU, heater, furnace). Dewpoint is now its own separate category -- no longer aliased from wet bulb.',
      },
      {
        type: 'fix',
        text: 'Reheat valve points are no longer shadowed by the heating valve column -- reheat valve now maps correctly to its own dedicated column.',
      },
    ],
  },
  {
    v: 'v2026.06.02.438',
    date: '2026-06-02',
    title:
      'Equipment Matrix Phase 2: smarter point matching -- fewer junk readings, Virtual points normalized, collision warnings',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now filters out alarm, limit, setpoint, and capacity points from live-reading columns (SAT, RAT, MAT, supply fan speed, cooling/heating valves, CO2) -- junk readings like "Cooling Valve Capacity GPM" or "Low Mixed Air Temperature" no longer appear in those columns.',
      },
      {
        type: 'fix',
        text: 'WebCTRL "Virtual Zone Temperature" points now map correctly to the Zone Temperature column instead of falling through to unmatched.',
      },
      {
        type: 'fix',
        text: 'Outside Air Wet Bulb and Broadcast Wet Bulb points on AHU and DHU equipment are now recognized (previously only matched cooling towers).',
      },
      {
        type: 'change',
        text: 'When two distinct real-sensor points compete for the same matrix column, a console warning is emitted with both point names so the conflict can be traced and corrected. Virtual points lose silently to real readings -- this is expected behavior.',
      },
    ],
  },
  {
    v: 'v2026.06.02.437',
    date: '2026-06-02',
    title:
      'Equipment Matrix: footer columns now freeze correctly in Raw and Audit views, pagination resets scroll position',
    items: [
      {
        type: 'fix',
        text: 'Footer rows (Totals and Average) in the Equipment Matrix Raw and Audit views now freeze their left columns correctly -- they no longer scroll out of view horizontally when you have many columns.',
      },
      {
        type: 'fix',
        text: 'Navigating to the next or previous page in Equipment Matrix now scrolls the table back to the top-left, so you always start reading from the beginning of the new page.',
      },
    ],
  },
  {
    v: 'v2026.06.02.436',
    date: '2026-06-02',
    title:
      'Equipment Matrix Phase 1 fixes: safer temp ranges, better tooltips, improved point classification, sticky Summary header',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix no longer shows implausible temperature readings -- values outside the valid sensor range are now flagged and excluded.',
      },
      {
        type: 'fix',
        text: 'Snapshot tooltips in Equipment Matrix now show the actual point name instead of a generic label.',
      },
      {
        type: 'fix',
        text: 'Demand and schedule exclusion rules are narrowed so fewer valid points are accidentally filtered out.',
      },
      {
        type: 'fix',
        text: 'Air-source equipment points are no longer excluded; they now appear correctly in the matrix.',
      },
      {
        type: 'fix',
        text: 'Summary table header in Equipment Matrix stays visible while scrolling through long building lists.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix table zoom is now consistent -- all tables scale together when you adjust zoom.',
      },
    ],
  },
  {
    v: 'v2026.06.02.435',
    date: '2026-06-02',
    title: 'City of Baldwin data-quality improvements: bill dates, clean addresses, and invalid meter readings flagged',
    items: [
      {
        type: 'fix',
        text: 'City of Baldwin bills now capture the billing date and period, show a clean service address, and flag meter readings that scan noise inflated to impossible values.',
      },
    ],
  },
  {
    v: 'v2026.06.02.434',
    date: '2026-06-02',
    title: 'City of Baldwin municipal bills now extract correctly from scanned PDFs',
    items: [
      {
        type: 'fix',
        text: 'City of Baldwin municipal bills now extract correctly from the scanned PDFs — account numbers and electric/water/sewer charges and totals are read even on imperfect scans (a prior version dropped every page to manual review).',
      },
    ],
  },
  {
    v: 'v2026.06.01.433',
    date: '2026-06-01',
    title:
      'Equipment Matrix recognizes far more equipment types, CO2 gap lowers coverage score, City of Baldwin water/sewer fixes',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now recognizes far more equipment — elevators, security and access control, environmental monitoring, and more — so virtually nothing is left as generic "Other," and more BAS points map to named columns in the All Points drawer.',
      },
      {
        type: 'feature',
        text: 'Audit coverage now reflects missing CO2 sensors (demand control ventilation readiness) — units without CO2 sensors show a lower coverage score instead of silently skipping the check.',
      },
      {
        type: 'fix',
        text: 'City of Baldwin municipal bills: water and sewer usage now record correctly, and accounts with two water meters add both meters together.',
      },
    ],
  },
  {
    v: 'v2026.06.01.432',
    date: '2026-06-01',
    title: 'Equipment Matrix captures all BAS points with expandable All Points drawer and smart column filtering',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now captures every BAS point from the imported file — nothing is dropped. Each equipment row has an expand arrow that opens an "All Points" drawer listing every point and its value.',
      },
      {
        type: 'feature',
        text: "When you filter the matrix to a single building, only the columns that building's equipment actually uses are shown — no more empty columns cluttering the view.",
      },
    ],
  },
  {
    v: 'v2026.06.01.431',
    date: '2026-06-01',
    title: 'Equipment classifier overhaul, Equipment Type column, and Constellation gas bill support',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now identifies fan coils, heaters, exhaust fans, DOAS units, furnaces, and zone terminals by their actual BAS points — far fewer items appear as "Other." Re-import your CSVs to pick up the new classifications.',
      },
      {
        type: 'fix',
        text: 'Zone terminals (Zone-F3-7 style names) were incorrectly tagged as lighting — they are now classified as zone terminals. Some equipment wrongly tagged as cooling tower has also been corrected.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix now shows the full control-program name in the Equipment Name column and adds a new Equipment Type column. The Audit and Raw view buttons are always visible, and long building names like "MedAct 51/SS Olathe" no longer get cut off. A phantom equipment row that appeared for some buildings has been removed.',
      },
      {
        type: 'feature',
        text: 'ASHRAE reports now include all the newly recognized equipment types in their equipment counts and summaries.',
      },
      {
        type: 'feature',
        text: 'Gas bills: Constellation NewEnergy consolidated invoices are now supported. Fixed duplicate "parse error" entries that appeared when a bill failed to extract. Multi-account Kansas Gas Service PDFs now read each account’s own usage and cost data correctly.',
      },
    ],
  },
  {
    v: 'v2026.06.01.430',
    date: '2026-06-01',
    title: 'Equipment Matrix humidity sensor support, KGS multi-account extraction, and bill routing improvements',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now recognizes Zone Humidity sensors — improvements to point recognition apply to your existing data automatically, no re-import needed.',
      },
      {
        type: 'fix',
        text: 'Gas bill reading is more accurate on multi-account PDF statements — each account’s charges and meter data now stay matched to that account.',
      },
      {
        type: 'fix',
        text: 'Bills route more reliably to the correct building when multiple units share the same street address — different door numbers now become separate meters under one building.',
      },
    ],
  },
  {
    v: 'v2026.06.01.429',
    date: '2026-06-01',
    title: 'Equipment Matrix point-display fixes and DCV readiness in ASHRAE reports',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now shows Zone CO2, Discharge Airflow, and other points from WebCTRL exports that were previously missing or blank — re-import your CSVs to apply.',
      },
      {
        type: 'fix',
        text: 'Zone temperatures now populate in the Summary view.',
      },
      {
        type: 'fix',
        text: 'A value of 0 now displays as "0" instead of blank — on screen and in CSV exports.',
      },
      {
        type: 'fix',
        text: 'Fixed cooling and heating setpoints that were wrongly showing 0 because a "Setpoint Adjust" reading was overwriting the real setpoint.',
      },
      {
        type: 'fix',
        text: 'Fixed the Damper Position column always showing blank.',
      },
      {
        type: 'fix',
        text: 'Fixed the "Manage Mappings" button doing nothing when clicked.',
      },
      {
        type: 'feature',
        text: 'ASHRAE reports are simpler and more concise, and now include a Demand Control Ventilation readiness section showing how many units are missing CO2 sensors.',
      },
    ],
  },
  {
    v: 'v2026.05.30.428',
    date: '2026-05-30',
    title: 'Reset Data now wipes all stored data, with a clearer warning',
    items: [
      {
        type: 'fix',
        text: 'Reset Data now fully erases all stored data on this device — including the Equipment Matrix database — not just project and bill data. The confirmation message now clearly describes what will be deleted.',
      },
      {
        type: 'fix',
        text: 'Fixed the Microsoft sign-in library failing to load (404). Microsoft 365 sign-in and Outlook sync now work correctly.',
      },
    ],
  },
  {
    v: 'v2026.05.30.427',
    date: '2026-05-30',
    title: 'Zone temps, print margins, and gas bill warnings fixed',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now shows zone temperatures for far more buildings (an alarm status point was overwriting the real reading) — re-import your CSVs to apply.',
      },
      {
        type: 'fix',
        text: 'ASHRAE report print margins fixed to a proper 0.5-inch so content no longer falls in the non-printable zone.',
      },
      {
        type: 'fix',
        text: 'Kansas Gas Service bills no longer show a false “gas total differs” warning.',
      },
    ],
  },
  {
    v: 'v2026.05.30.426',
    date: '2026-05-30',
    title: 'Sidebar version badge now always shows the live release number',
    items: [
      {
        type: 'fix',
        text: 'The version number shown in the sidebar now always matches the live release (it was previously stuck on an old hardcoded value).',
      },
    ],
  },
  {
    v: 'v2026.05.30.425',
    date: '2026-05-30',
    title: 'Equipment Matrix: filter and count Lighting and Other equipment',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now lets you filter by Lighting and Other equipment types using the Type dropdown. The summary bar also shows Lighting and Other counts when those equipment types are present in your project.',
      },
    ],
  },
  {
    v: 'v2026.05.30.424',
    date: '2026-05-30',
    title: 'Equipment Matrix no longer shows empty after a page refresh',
    items: [
      {
        type: 'fix',
        text: 'Fixed the Equipment Matrix sometimes showing empty after a refresh while your data was still loading. It now shows "Loading…" and fills in automatically once the database finishes loading — your data was never lost.',
      },
    ],
  },
  {
    v: 'v2026.05.30.423',
    date: '2026-05-30',
    title: 'Service Department backup and restore now capture all saved data',
    items: [
      {
        type: 'fix',
        text: 'Service Department backup and restore now include all saved data (service agreements, staff, and dispatch records). Previously these backups were nearly empty and restoring could wipe data.',
      },
    ],
  },
  {
    v: 'v2026.05.30.422',
    date: '2026-05-30',
    title: 'Equipment Matrix data-loss fix — large imports now save reliably',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix imports no longer silently fail on the Energy page. Large projects (2,000+ rows) were hitting a browser storage size limit and losing all imported data on reload. Saves now go to IndexedDB (no size limit) instead of the limited localStorage.',
      },
      {
        type: 'fix',
        text: 'Toast notifications (the green/red status messages) now work correctly on the Energy page. They were silently throwing errors before, so some import feedback was invisible.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix footer now shows real counts per point type in the Page Total and Total rows, instead of dashes.',
      },
      {
        type: 'fix',
        text: 'Backup and Restore on the Energy page now saves/loads from IndexedDB, matching where data is actually stored.',
      },
    ],
  },
  {
    v: 'v2026.05.29.421',
    date: '2026-05-29',
    title: 'Better equipment-type classification; ASHRAE Service Proposal report fixes',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now correctly classifies more equipment types. HVAC subtypes and lighting controls are recognized by name. The Other catch-all dropped from ~51% to ~17% on a real project import.',
      },
      {
        type: 'fix',
        text: 'ASHRAE Service Proposal reports now populate the Sequences section with all 14 sequence-key descriptions instead of showing a blank table.',
      },
      {
        type: 'fix',
        text: 'ASHRAE report headers now show the real project name instead of object Object.',
      },
    ],
  },
  {
    v: 'v2026.05.29.420',
    date: '2026-05-29',
    title: 'Equipment Matrix preserves notes on re-import; Backup/Restore/Reset buttons fixed in Energy page',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix re-import (Replace mode) now preserves any hand-typed notes you added to rows. If the new CSVs remove a building, a yellow warning lists which buildings were dropped so nothing disappears silently.',
      },
      {
        type: 'fix',
        text: 'Backup Data, Restore Data, and Reset Data buttons in the Energy department sidebar now work correctly — they were throwing an error and doing nothing before this fix.',
      },
    ],
  },
  {
    v: 'v2026.05.29.419',
    date: '2026-05-29',
    title: 'Reset Data warning strengthened; ASHRAE report descriptions added',
    items: [
      {
        type: 'fix',
        text: 'Reset Data button now shows a warning tooltip on hover — hover over it to see the full warning before clicking. The confirmation dialog also uses clearer language reminding you to download a backup first.',
      },
      {
        type: 'fix',
        text: 'ASHRAE 36 gap reports now show plain-language descriptions for chilled water plant, hot water plant, and cooling tower points (e.g. "Primary chilled water pump status feedback") instead of raw key names like pchwpStatus.',
      },
    ],
  },
  {
    v: 'v2026.05.29.410',
    date: '2026-05-29',
    title: 'Equipment Matrix imports survive an immediate page refresh',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix: imported data is now fully written to storage before the success message appears — refreshing the page immediately after an import no longer wipes the data.',
      },
      {
        type: 'fix',
        text: 'A page-unload warning now appears if you try to close or navigate away while an Equipment Matrix save is still in progress.',
      },
    ],
  },
  {
    v: 'v2026.05.28.409',
    date: '2026-05-29',
    title: 'Equipment Matrix import window stays open until you click Done',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix import: the import window no longer closes itself after a few seconds — the import summary stays on screen until you click Done, so you can actually read it.',
      },
    ],
  },
  {
    v: 'v2026.05.28.408',
    date: '2026-05-29',
    title: 'Equipment Matrix: empty state, scrolling fix, Coverage % in totals',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now shows a clear empty state with an Import button when a project has no data yet — no more blank screen.',
      },
      {
        type: 'fix',
        text: 'Fixed the Equipment Matrix table not scrolling — the table now scrolls correctly within the panel.',
      },
      {
        type: 'feature',
        text: 'The Page Total and Total rows in the Equipment Matrix footer now show average Coverage % in addition to point counts.',
      },
    ],
  },
  {
    v: 'v2026.05.28.407',
    date: '2026-05-28',
    title: 'Equipment Matrix and BAS Trends tabs work again',
    items: [
      {
        type: 'fix',
        text: 'Fixed: the Equipment Matrix project tab opens correctly again — it was erroring and doing nothing. The BAS Trends tab also no longer errors.',
      },
    ],
  },
  {
    v: 'v2026.05.28.406',
    date: '2026-05-28',
    title: 'No more sideways scroll on phones and tablets',
    items: [
      {
        type: 'fix',
        text: 'Phones and tablets no longer scroll sideways — page content now reflows to fit the screen width below 900px.',
      },
    ],
  },
  {
    v: 'v2026.05.28.405',
    date: '2026-05-28',
    title: 'Mobile-responsive layout and live Dashboard Overview tiles',
    items: [
      {
        type: 'feature',
        text: 'CompanyHub now works on phones and tablets — the sidebar collapses into a tap-to-open menu (hamburger) on small screens, layouts reflow to fit, and wide tables scroll within their panels.',
      },
      {
        type: 'fix',
        text: 'The Dashboard Overview tiles (Energy Projects, Service Staff, SA Records) now show live counts from your actual data instead of fixed placeholder numbers.',
      },
    ],
  },
  {
    v: 'v2026.05.28.404',
    date: '2026-05-28',
    title: 'ECM Calculator tooltips + Meter Performance Minimum Hours chart',
    items: [
      {
        type: 'feature',
        text: 'ECM Calculators now show help tooltips — hover any input label for a plain-language explanation of what to enter.',
      },
      {
        type: 'feature',
        text: 'Meter Performance now includes a Minimum Hours chart and an auto-scaling Load Factor axis for clearer demand analysis.',
      },
    ],
  },
  {
    v: 'v2026.05.28.403',
    date: '2026-05-28',
    title: 'Sidebar bottom items always reachable at any window height',
    items: [
      {
        type: 'fix',
        text: 'Sidebar bottom items (Settings, version) no longer get cut off — the navigation now scrolls when the window is short, so everything stays reachable at any window height.',
      },
    ],
  },
  {
    v: 'v2026.05.28.402',
    date: '2026-05-28',
    title: 'Projects and bills now load correctly after a data reset',
    items: [
      {
        type: 'fix',
        text: 'After clearing localStorage (via Clear All Data or a browser reset), projects and utility bills now display immediately on reload — the app reads from its IndexedDB cache when available, so data is never lost between page loads.',
      },
    ],
  },
  {
    v: 'v2026.05.28.401',
    date: '2026-05-28',
    title: 'Window overflow fix — pages no longer stretch beyond screen width',
    items: [
      {
        type: 'fix',
        text: 'Pages and panels no longer expand beyond the window edge — the dashboard, energy department, and all tabs now stay within the visible screen area without horizontal scrolling.',
      },
    ],
  },
  {
    v: 'v2026.05.28.400',
    date: '2026-05-28',
    title: 'Equipment Matrix sort and audit footer improvements',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix now lists HVAC equipment first by default — AHUs, VAVs, and fan-powered boxes appear at the top, followed by pumps, cooling towers, and other equipment types.',
      },
      {
        type: 'feature',
        text: 'Equipment Matrix audit view now shows point totals in the Page Total and Total footer rows instead of dashes — making it easier to see how many BAS points are on the current page and across all equipment.',
      },
    ],
  },
  {
    v: 'v2026.05.28.399',
    date: '2026-05-28',
    title: 'Equipment Matrix project sync, VFD fix, tab handler guard',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now correctly tracks which project is active — switching projects in the sidebar updates the matrix without requiring a manual reload.',
      },
      {
        type: 'fix',
        text: 'VFD Integration is no longer incorrectly classified as a separate equipment category — it is now recognized as a flag on the equipment it belongs to.',
      },
      {
        type: 'fix',
        text: 'Opening the Equipment Matrix tab from a project no longer causes an error on pages where the matrix is not loaded.',
      },
    ],
  },
  {
    v: 'v2026.05.28.398',
    date: '2026-05-28',
    title: 'Empty-state fixes, error feedback, tab reorder',
    items: [
      {
        type: 'fix',
        text: 'Energy Savings tab no longer shows an empty table when no measures are saved — it now shows a clear "no data" message.',
      },
      {
        type: 'fix',
        text: 'Saving a meter or building now shows a success or error message so you know if it worked.',
      },
      {
        type: 'change',
        text: 'Project tabs reordered: Savings, Budget, and District Calendar tabs now appear after Equipment Matrix and BAS Trends.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix now correctly distinguishes "no data loaded" from "filters excluded all rows" — and includes a Clear All Data button in the toolbar.',
      },
    ],
  },
  {
    v: 'v2026.05.28.397',
    date: '2026-05-28',
    title: 'Equipment Matrix audit cells now scale with zoom',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix Audit View — audit compliance cells now scale correctly when you zoom in or out. Previously, inline font sizes were locking the text at 11px regardless of zoom level.',
      },
    ],
  },
  {
    v: 'v2026.05.28.396',
    date: '2026-05-28',
    title: 'Equipment Matrix tooltips, KGS bill extraction fixes',
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix Audit View — hover over any cell to see a tooltip explaining what the audit status means and where the data came from.',
      },
      {
        type: 'fix',
        text: 'Equipment Matrix — zoom no longer overrides the font size set for individual cells; text is now consistently sized when zooming in or out.',
      },
      {
        type: 'fix',
        text: 'KGS gas bills — multi-page PDF reports now correctly show the KGS brand header on every page instead of only the first.',
      },
      {
        type: 'fix',
        text: 'KGS gas bills — sanity check now accounts for Delivery Charge, Gas System Reliability, Weather Normalization, Winter Event Cost, and Franchise Fee so those charges no longer trigger a false-positive mismatch warning.',
      },
    ],
  },
  {
    v: 'v2026.05.27.395',
    date: '2026-05-27',
    title: 'Floor parser improvements',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix now recognizes text floor names — First Floor through Tenth Floor, Ground Floor, Ground Level, Penthouse, Rooftop, Basement, Mezzanine, and Lobby. Previously only numeric floors like 1st Floor were detected.',
      },
    ],
  },
  {
    v: 'v2026.05.27.394',
    date: '2026-05-27',
    title: 'Generate Report improvements',
    items: [
      {
        type: 'fix',
        text: "Generate Report popup — Edit buttons now open a separate window so you don't lose your selections. Previously clicking Edit navigated away from the modal.",
      },
      {
        type: 'feature',
        text: 'Generate Report popup — warnings now show for Contract Projection, Electric, Gas, and Propane sections when data is missing, with Edit buttons to fix them',
      },
    ],
  },
  {
    v: 'v2026.05.27.393',
    date: '2026-05-27',
    title: 'Equipment Matrix scroll fix and legend spacing',
    items: [
      {
        type: 'fix',
        text: 'Equipment Matrix table can now scroll vertically to show all rows — previously rows were silently cut off',
      },
      {
        type: 'fix',
        text: 'Audit View legend bar (Yes/Fuzzy/No/N/A/--) pills are now properly spaced apart instead of running together',
      },
    ],
  },
  {
    v: 'v2026.05.27.392',
    date: '2026-05-27',
    title: "Equipment Matrix redesign, What's New popup, and 5 fixes",
    items: [
      {
        type: 'feature',
        text: 'Equipment Matrix Summary View redesigned as a building table — shows Zone Air Temp, Heating Setpoint, Cooling Setpoint, and Zones vs Setpoints per building. Click any building to drill into its detailed equipment list.',
      },
      {
        type: 'feature',
        text: 'Average and Total Average rows now appear at the bottom of all Equipment Matrix views (Summary, Audit, and Raw)',
      },
      {
        type: 'feature',
        text: "What's New popup redesigned — current version takes up the full screen, scroll down for previous versions. New settings: choose to show every login, only on updates, or never.",
      },
      {
        type: 'feature',
        text: 'Meter Performance tab — Load Factor Trend chart and Minimum Hours chart added for electric meters. Demand chart moved above the data table.',
      },
      {
        type: 'fix',
        text: 'Manage Mappings — custom point mappings now actually affect the audit compliance results. Previously they were saved but had no effect.',
      },
      {
        type: 'fix',
        text: 'Bill extraction no longer freezes the browser during verification — large uploads process smoothly with a responsive cancel button',
      },
      {
        type: 'fix',
        text: 'Energy Graphics now shows Water, Sewer, and Stormwater data for projects that were missing them after the commodity migration',
      },
      { type: 'change', text: 'Sync to Outlook button removed from the top bar across all pages' },
    ],
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
  };
  Object.keys(closers).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.classList.contains('open') && closers[id]) closers[id]();
  });
});

/* ── TOAST FALLBACK (guarded) ──────────────────────────────────────────────
 * showToast / hideToast are defined in site-ui.js:987 for pages that load
 * site-ui.js (index.html, service-department.html, ems-leads.html).
 * energy-department.html does NOT load site-ui.js, so they are undefined
 * there — causing ReferenceError on every toast call in equipment-matrix.js.
 * site-functions.js IS loaded on the energy page, so we define them here
 * only when the site-ui.js versions are absent. The `if` guards prevent
 * double-definition on pages that load both files.
 * Signature and behavior are identical to site-ui.js:987–1002.
 * ─────────────────────────────────────────────────────────────────────── */
if (typeof window.showToast !== 'function') {
  window.showToast = function showToast(msg, type) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast toast-show' + (type ? ' toast-' + type : '');
    clearTimeout(window._toastTimer);
    var duration = parseInt(localStorage.getItem('ch_toast_duration') || '3500', 10);
    if (duration > 0) {
      window._toastTimer = setTimeout(window.hideToast, duration);
    }
  };
}
if (typeof window.hideToast !== 'function') {
  window.hideToast = function hideToast() {
    var el = document.getElementById('toast');
    if (el) el.className = 'toast';
  };
}

/* ══ SHARED TABLE ZOOM ══
 * setTableZoom(containerId, delta, storageKey, labelId)
 *   containerId — ID of the element wrapping the <table>
 *   delta       — number to add to zoom (e.g. +10, -10, or 0 to reset to 100)
 *   storageKey  — localStorage key used to persist the zoom level
 *   labelId     — ID of the <span> that shows "100%"
 *
 * Zoom is clamped 50–150%. Scales td/th font-size and padding proportionally.
 * Base sizes: td 12px / 4px 8px padding; th 11px / 5px 8px padding.
 * A <style> tag with id = containerId + '-zoom-style' is created/reused.
 *
 * tableZoomControlHTML(containerId, storageKey, labelId)
 *   Returns the button/label HTML for +/− zoom controls. Matches EM zoom style.
 */
function setTableZoom(containerId, delta, storageKey, labelId) {
  var stored = parseInt(localStorage.getItem(storageKey) || '100', 10);
  var level = isNaN(stored) || stored < 50 || stored > 150 ? 100 : stored;
  if (delta === 'reset') {
    level = 100; // 1:1 reset button
  } else if (delta === null || delta === undefined) {
    // re-apply stored level without changing it (used on tab open to restore persisted zoom)
  } else {
    level = Math.min(150, Math.max(50, level + delta));
  }
  try {
    localStorage.setItem(storageKey, String(level));
  } catch (e) {}

  var wrap = document.getElementById(containerId);
  if (wrap) {
    var ratio = level / 100;
    var tdFs = Math.round(12 * ratio);
    var thFs = Math.round(11 * ratio);
    var tdPV = Math.round(4 * ratio);
    var tdPH = Math.round(8 * ratio);
    var thPV = Math.round(5 * ratio);
    var thPH = Math.round(8 * ratio);
    var styleId = containerId + '-zoom-style';
    var styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      '#' +
      containerId +
      ' td { font-size:' +
      tdFs +
      'px; padding:' +
      tdPV +
      'px ' +
      tdPH +
      'px; } ' +
      '#' +
      containerId +
      ' th { font-size:' +
      thFs +
      'px; padding:' +
      thPV +
      'px ' +
      thPH +
      'px; }';
  }

  var lbl = labelId ? document.getElementById(labelId) : null;
  if (lbl) lbl.textContent = level + '%';
}

function tableZoomControlHTML(containerId, storageKey, labelId) {
  var stored = parseInt(localStorage.getItem(storageKey) || '100', 10);
  var level = isNaN(stored) || stored < 50 || stored > 150 ? 100 : stored;
  return (
    '<div style="display:inline-flex;align-items:center;gap:2px">' +
    '<button onclick="setTableZoom(\'' +
    containerId +
    "',-10,'" +
    storageKey +
    "','" +
    labelId +
    '\')" ' +
    'style="height:24px;width:22px;font-size:13px;line-height:1;background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer;padding:0" ' +
    'title="Zoom out">−</button>' +
    '<span id="' +
    labelId +
    '" style="font-size:11px;color:var(--text2);min-width:34px;text-align:center;user-select:none">' +
    level +
    '%</span>' +
    '<button onclick="setTableZoom(\'' +
    containerId +
    "',10,'" +
    storageKey +
    "','" +
    labelId +
    '\')" ' +
    'style="height:24px;width:22px;font-size:13px;line-height:1;background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer;padding:0" ' +
    'title="Zoom in">+</button>' +
    '<button onclick="setTableZoom(\'' +
    containerId +
    "','reset','" +
    storageKey +
    "','" +
    labelId +
    '\')" ' +
    'style="height:24px;width:28px;font-size:10px;line-height:1;background:var(--s2);border:1px solid var(--border);color:var(--text3);border-radius:4px;cursor:pointer;padding:0;margin-left:1px" ' +
    'title="Reset zoom">1:1</button>' +
    '</div>'
  );
}
