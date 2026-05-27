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
  var data = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    data[k] = localStorage.getItem(k);
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
  var fr = new FileReader();
  fr.onload = function (ev) {
    try {
      var data = JSON.parse(ev.target.result);
      Object.keys(data).forEach(function (k) {
        localStorage.setItem(k, data[k]);
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

/* Expose for backward compat */
window.__siteUI = {
  openSettings: siteOpenSettings,
  closeSettings: siteCloseSettings,
  backupData: siteBackup,
  restoreData: siteRestore,
  resetData: siteResetData,
  checkDefaultLogin: siteCheckDefaultLogin,
  applyAccentColor: siteApplyAccent,
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
