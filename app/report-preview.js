// ═══════════════════════════════════════════════════
// REPORT PREVIEW — preview/editor UI for the new report system
// Launched from Generate Report modal in Energy Graphics tab.
// Reuses collectReportData() and rptPage*() from report-engine.js.
// ═══════════════════════════════════════════════════

var _reportConfig = null;
var _reportData = null;
var _rptInspectActive = false;

function generateReportPreview() {
  // Clear any pages from a prior report before generating a new one.
  // This prevents DOM accumulation when the user generates multiple reports
  // in the same session (prior reports were stacking, producing inflated page counts).
  var _prevPages = document.getElementById('rptPreviewPages');
  if (_prevPages) _prevPages.innerHTML = '';

  var config = _rptV2ReadConfig();
  if (!config.buildingIds.length) {
    showToast('Select at least one building', 'warning');
    return;
  }
  if (!config.sections.length) {
    showToast('Select at least one section', 'warning');
    return;
  }

  // Map v2 config to collectReportData parameters
  var reportDateStr = null;
  var reportType = config.reportType;
  if (reportType === 'quarterly' || reportType === 'annual') {
    reportDateStr = new Date().toISOString().slice(0, 10);
  }

  // For quarterly reports, pass the user's explicit quarter/year selection so
  // collectReportData honours it instead of auto-picking the last completed quarter.
  var selectedPeriod = null;
  if (reportType === 'quarterly' && config.quarter && config.year) {
    selectedPeriod = { quarter: config.quarter, year: config.year };
  }

  // Collect report data using existing engine
  var data = collectReportData(config.projId, config.buildingIds, reportDateStr, reportType, selectedPeriod);
  if (!data) {
    showToast('Could not collect report data — check that buildings have utility data', 'error');
    return;
  }

  // Attach report options
  data.reportOptions = {
    annualizePollution: config.pollutionMode === 'annualized',
    blCommodities: {
      electric: typeof isCalcCommodity === 'function' ? isCalcCommodity(config.projId, 'Electric') : true,
      gas: typeof isCalcCommodity === 'function' ? isCalcCommodity(config.projId, 'Gas') : true,
      propane: typeof isCalcCommodity === 'function' ? isCalcCommodity(config.projId, 'Propane') : true,
      water: typeof isCalcCommodity === 'function' ? isCalcCommodity(config.projId, 'Water') : false,
    },
  };

  // Override period info for custom/cumulative types
  if (reportType === 'cumulative' || reportType === 'current' || reportType === 'custom') {
    data.period = data.period || {};
    data.period.label = config.periodLabel;
  }

  _reportConfig = config;
  _reportData = data;

  // Build selected sections map
  var selectedSections = {};
  REPORT_SECTIONS.forEach(function (sec) {
    selectedSections[sec.key] = config.sections.indexOf(sec.key) >= 0;
  });

  // Generate report HTML using existing engine
  var pagesHTML = generateReportHTML(data, selectedSections);

  // Close modal, show preview
  document.getElementById('reportGenModal').classList.remove('open');
  _showPreview(config, pagesHTML);
}

function _showPreview(config, pagesHTML) {
  var container = document.getElementById('reportPreviewContainer');
  var pagesEl = document.getElementById('rptPreviewPages');
  var sidebarEl = document.getElementById('rptPreviewSidebar');
  var titleEl = document.getElementById('rptPreviewTitle');

  // Set title
  var typeLabel = config.reportType.charAt(0).toUpperCase() + config.reportType.slice(1);
  titleEl.textContent =
    config.clientName + ' — ' + typeLabel + ' Report' + (config.periodLabel ? ' (' + config.periodLabel + ')' : '');

  // Parse the HTML into individual pages
  // The report engine wraps each page in a div with class "rpt-page"
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = pagesHTML;
  var pageNodes = tempDiv.querySelectorAll('.rpt-page');

  if (pageNodes.length === 0) {
    pagesEl.innerHTML =
      '<div class="rpt-preview-page" data-section="all" data-page="1">' +
      '<div style="width:100%;max-width:816px;min-height:1056px;background:#fff;' +
      'box-shadow:0 2px 12px rgba(0,0,0,0.3);padding:40px 48px;color:#000;font-family:Helvetica,Arial,sans-serif;font-size:10px;line-height:1.5">' +
      pagesHTML +
      '</div></div>';
  } else {
    var html = '';
    for (var i = 0; i < pageNodes.length; i++) {
      var node = pageNodes[i];
      var sectionKey = node.getAttribute('data-section') || 'page-' + (i + 1);
      html +=
        '<div class="rpt-preview-page" data-section="' +
        sectionKey +
        '" data-page="' +
        (i + 1) +
        '">' +
        node.outerHTML +
        '</div>';
    }
    pagesEl.innerHTML = html;
  }

  // Build sidebar
  _rebuildSidebar();

  // Show container
  container.style.display = '';
  document.body.style.overflow = 'hidden';

  // Initialize inspector listener (idempotent — only binds once)
  _rptInitInspector();

  // Populate page number footers now that pages are in the DOM
  _updatePageNumbers();
}

function _rebuildSidebar() {
  var sidebarEl = document.getElementById('rptPreviewSidebar');
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');

  // Build a map: sectionKey -> { pageIdx, isVisible }
  // Only the first page for multi-page sections is tracked (for scroll-to and page number)
  var sectionPageMap = {};
  var visibleCountByKey = {};
  var globalVisibleIdx = 0;
  for (var i = 0; i < pages.length; i++) {
    var pg = pages[i];
    var sk = pg.getAttribute('data-section') || '';
    // Strip -cont suffix to normalize continuation pages back to their parent key
    var baseKey = sk.replace(/-cont$/, '');
    var isVis = pg.style.display !== 'none';
    if (isVis) globalVisibleIdx++;
    // Only record the first (non-cont) page for each section key
    if (baseKey && !sk.endsWith('-cont') && !(baseKey in sectionPageMap)) {
      sectionPageMap[baseKey] = { pageIdx: i, isVisible: isVis, pageNum: isVis ? globalVisibleIdx : null };
    }
  }

  // Recalculate accurate page numbers for each section key (visible pages only, in DOM order)
  // Only record the FIRST visible page per section (not the last).
  var visNum = 0;
  var _seenSectionForPageNum = {};
  for (var pi = 0; pi < pages.length; pi++) {
    var pgSk = pages[pi].getAttribute('data-section') || '';
    var pgBase = pgSk.replace(/-cont$/, '');
    if (pages[pi].style.display !== 'none') {
      visNum++;
      if (pgBase && !pgSk.endsWith('-cont') && sectionPageMap[pgBase] && !_seenSectionForPageNum[pgBase]) {
        sectionPageMap[pgBase].pageNum = visNum;
        _seenSectionForPageNum[pgBase] = true;
      }
    }
  }

  // Build dynamic appendix letter map: assign sequential letters (A, B, C…) only to
  // appendix sections that were actually rendered (present in sectionPageMap), in
  // REPORT_SECTIONS order. This mirrors what _nextAppLtr() did during generation so
  // the sidebar label matches the letter shown inside the page body.
  var _appLetterMap = {};
  var _appCharCode = 65; // 'A'
  for (var ai = 0; ai < REPORT_SECTIONS.length; ai++) {
    var _aSec = REPORT_SECTIONS[ai];
    if (_aSec.key.indexOf('appendix') === 0 && sectionPageMap[_aSec.key]) {
      _appLetterMap[_aSec.key] = String.fromCharCode(_appCharCode++);
    }
  }

  var html =
    '<div style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text2);border-bottom:1px solid var(--s3);margin-bottom:4px">Sections</div>';

  var lastGroup = null;
  for (var si = 0; si < REPORT_SECTIONS.length; si++) {
    var sec = REPORT_SECTIONS[si];

    // Group header
    if (sec.group !== lastGroup) {
      lastGroup = sec.group;
      html +=
        '<div style="padding:6px 12px 2px;font-size:9px;font-weight:700;letter-spacing:0.06em;' +
        'color:var(--text3);text-transform:uppercase">' +
        sec.group +
        '</div>';
    }

    var info = sectionPageMap[sec.key];
    var isIncluded = !!info; // page was rendered for this section
    var isVisible = isIncluded && info.isVisible;

    // For appendix sections, derive the label from the actual rendered letter.
    var secLabel = sec.label;
    if (sec.key.indexOf('appendix') === 0 && _appLetterMap[sec.key]) {
      var _appLtr = _appLetterMap[sec.key];
      // Replace the letter portion of the label (e.g. "Appendix A:" → "Appendix X:")
      secLabel = sec.label.replace(/^Appendix\s+[A-Z]:/, 'Appendix ' + _appLtr + ':');
    }

    if (isIncluded) {
      // Rendered section — show checkbox, label, page number, drag handle
      var pgIdx = info.pageIdx;
      html +=
        '<div class="rpt-sidebar-row" draggable="true" data-idx="' +
        pgIdx +
        '" ' +
        'ondragstart="_rptDragStart(event,' +
        pgIdx +
        ')" ' +
        'ondragover="_rptDragOver(event)" ' +
        'ondrop="_rptDrop(event,' +
        pgIdx +
        ')" ' +
        'onclick="_toggleSectionByKey(\'' +
        sec.key +
        '\')" ' +
        'style="display:flex;align-items:center;gap:6px;padding:5px 12px;cursor:pointer;' +
        'border-bottom:1px solid var(--s2);font-size:11px;color:var(--text)">';
      html +=
        '<input type="checkbox" ' +
        (isVisible ? 'checked' : '') +
        ' onclick="event.stopPropagation();togglePreviewSection(' +
        pgIdx +
        ',this.checked)" style="accent-color:var(--em);width:13px;height:13px;flex-shrink:0;cursor:pointer">';
      html +=
        '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" ' +
        'onclick="event.stopPropagation();_scrollToSection(\'' +
        sec.key +
        '\')">' +
        secLabel +
        '</span>';
      if (isVisible && info.pageNum) {
        html += '<span style="font-size:9px;color:var(--text3);flex-shrink:0">p' + info.pageNum + '</span>';
      }
      html += '</div>';
    } else {
      // Not included — show grayed label, no checkbox, no page number
      html +=
        '<div style="display:flex;align-items:center;gap:6px;padding:5px 12px;' +
        'border-bottom:1px solid var(--s2);font-size:11px;color:var(--text3);opacity:0.55">';
      html += '<span style="width:13px;height:13px;flex-shrink:0"></span>';
      html +=
        '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-style:italic">' +
        secLabel +
        '</span>';
      html += '<span style="font-size:9px;color:var(--text3);flex-shrink:0">—</span>';
      html += '</div>';
    }
  }

  sidebarEl.innerHTML = html;
}

function _toggleSectionByKey(key) {
  var page = document.querySelector('#rptPreviewPages .rpt-preview-page[data-section="' + key + '"]');
  if (!page) return;
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  var idx = Array.prototype.indexOf.call(pages, page);
  if (idx < 0) return;
  var nowVisible = page.style.display === 'none';
  togglePreviewSection(idx, nowVisible);
}

function _scrollToSection(key) {
  var page = document.querySelector('#rptPreviewPages .rpt-preview-page[data-section="' + key + '"]');
  if (page) page.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function togglePreviewSection(idx, visible) {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  if (pages[idx]) {
    pages[idx].style.display = visible ? '' : 'none';
  }
  _rebuildSidebar();
  _updatePageNumbers();
}

function _updatePageNumbers() {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  var visibleCount = 0;
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].style.display !== 'none') visibleCount++;
  }
  var curPage = 0;
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].style.display === 'none') continue;
    curPage++;
    var footer = pages[i].querySelector('.rpt-pg-footer-pagenum');
    if (footer) {
      footer.textContent = 'Page ' + curPage + ' of ' + visibleCount;
    }
  }
}

// Drag reorder
var _rptDragIdx = -1;

function _rptDragStart(e, idx) {
  _rptDragIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', idx);
}

function _rptDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function _rptDrop(e, targetIdx) {
  e.preventDefault();
  if (_rptDragIdx < 0 || _rptDragIdx === targetIdx) return;
  var pagesContainer = document.getElementById('rptPreviewPages');
  var pages = Array.from(pagesContainer.querySelectorAll('.rpt-preview-page'));
  if (!pages[_rptDragIdx] || !pages[targetIdx]) return;

  var draggedPage = pages[_rptDragIdx];
  var targetPage = pages[targetIdx];
  if (_rptDragIdx < targetIdx) {
    pagesContainer.insertBefore(draggedPage, targetPage.nextSibling);
  } else {
    pagesContainer.insertBefore(draggedPage, targetPage);
  }

  _rptDragIdx = -1;
  _rebuildSidebar();
  _updatePageNumbers();
}

function closeReportPreview() {
  document.getElementById('reportPreviewContainer').style.display = 'none';
  document.body.style.overflow = '';
  // Clear pages from DOM so stale content cannot accumulate if a new report
  // is generated after this preview is closed.
  var pagesEl = document.getElementById('rptPreviewPages');
  if (pagesEl) pagesEl.innerHTML = '';
  // Reset inspector state
  _rptInspectActive = false;
  var tip = document.getElementById('rptTextInspector');
  if (tip) tip.style.display = 'none';
  var btn = document.getElementById('rptInspectToggle');
  if (btn) {
    btn.style.background = '';
    btn.style.color = '';
  }
}

function _rptToggleInspect() {
  _rptInspectActive = !_rptInspectActive;
  var btn = document.getElementById('rptInspectToggle');
  var tip = document.getElementById('rptTextInspector');
  if (btn) {
    btn.style.background = _rptInspectActive ? 'var(--em)' : '';
    btn.style.color = _rptInspectActive ? '#fff' : '';
  }
  if (!_rptInspectActive && tip) tip.style.display = 'none';
}

function _rgbToHex(rgb) {
  var m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return rgb;
  return (
    '#' +
    [m[0], m[1], m[2]]
      .map(function (n) {
        return ('0' + parseInt(n).toString(16)).slice(-2);
      })
      .join('')
  );
}

function _rptInitInspector() {
  var pages = document.getElementById('rptPreviewPages');
  if (!pages || pages._inspectorBound) return;
  pages._inspectorBound = true;

  pages.addEventListener('mousemove', function (e) {
    if (!_rptInspectActive) return;
    var tip = document.getElementById('rptTextInspector');
    if (!tip) return;

    var target = e.target;
    // Skip if hovering the pages container itself
    if (target === pages) {
      tip.style.display = 'none';
      return;
    }

    var cs = getComputedStyle(target);
    var fontFamily = cs.fontFamily || '';
    var fontSize = cs.fontSize || '';
    var color = _rgbToHex(cs.color || '');

    tip.innerHTML =
      '<span style="color:#a0c4ff">font</span> ' +
      fontFamily +
      '<br>' +
      '<span style="color:#a0c4ff">size</span> ' +
      fontSize +
      '<br>' +
      '<span style="color:#a0c4ff">color</span> <span style="display:inline-block;width:10px;height:10px;background:' +
      color +
      ';border:1px solid #666;vertical-align:middle;margin-right:3px;border-radius:2px"></span>' +
      color;

    tip.style.display = 'block';
    tip.style.left = e.clientX + 16 + 'px';
    tip.style.top = e.clientY + 14 + 'px';

    // Keep tooltip within viewport edges
    var tw = tip.offsetWidth,
      th = tip.offsetHeight;
    if (e.clientX + 16 + tw > window.innerWidth - 8) {
      tip.style.left = e.clientX - tw - 8 + 'px';
    }
    if (e.clientY + 14 + th > window.innerHeight - 8) {
      tip.style.top = e.clientY - th - 8 + 'px';
    }
  });

  pages.addEventListener('mouseleave', function () {
    var tip = document.getElementById('rptTextInspector');
    if (tip) tip.style.display = 'none';
  });
}

// Template save from preview toolbar
function saveReportTemplate() {
  if (!_reportConfig) {
    showToast('No report loaded', 'warning');
    return;
  }
  var name = prompt('Template name:', _reportConfig._templateName || '');
  if (!name) return;
  _reportConfig._templateName = name;

  // Collect current section state from sidebar
  var sections = [];
  document.querySelectorAll('#rptPreviewPages .rpt-preview-page').forEach(function (p) {
    if (p.style.display !== 'none') {
      sections.push(p.getAttribute('data-section'));
    }
  });

  var template = {
    name: name,
    reportType: _reportConfig.reportType,
    sections: sections,
    buildingIds: _reportConfig.buildingIds,
    pollutionMode: _reportConfig.pollutionMode,
    savedAt: new Date().toISOString(),
  };

  _saveReportTemplateData(_reportConfig.projId, template);
  showToast('Template saved: ' + name, 'success');
}

// PDF export from preview
async function downloadReportPDF() {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  var visiblePages = [];
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].style.display !== 'none') visiblePages.push(pages[i]);
  }
  if (!visiblePages.length) {
    showToast('No pages to export', 'warning');
    return;
  }

  showToast('Generating PDF — this may take a moment...', 'info');

  // Hide all canvases outside the preview pages to prevent tainted-canvas errors.
  // Cross-origin Chart.js canvases (egfx-euiBench, egfx-savChart, egfx-yoy, etc.)
  // will taint the output if html2canvas clones them, causing toDataURL() to throw.
  // We hide them (not display:none — that changes layout) before the export loop and
  // restore in finally so they come back even if the export fails.
  var hiddenCanvases = [];
  var allCanvases = document.querySelectorAll('canvas');
  allCanvases.forEach(function (c) {
    if (!c.closest('#rptPreviewPages')) {
      hiddenCanvases.push({ el: c, prev: c.style.visibility });
      c.style.visibility = 'hidden';
    }
  });

  try {
    var pdf = new jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    var pageW = 612,
      pageH = 792;
    // Rule 1.2: 0.5in (36pt) margins on all four sides — matches exportReportToPDF() in report-engine.js
    var margin = { top: 36, bottom: 36, left: 36, right: 36 };
    var contentW = pageW - margin.left - margin.right;
    var contentH = pageH - margin.top - margin.bottom;

    for (var i = 0; i < visiblePages.length; i++) {
      var el = visiblePages[i].querySelector('.rpt-page') || visiblePages[i];
      var canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: el.scrollWidth,
        height: el.scrollHeight,
        ignoreElements: function (element) {
          return element.tagName === 'CANVAS' && (element.width === 0 || element.height === 0);
        },
      });
      var imgData = canvas.toDataURL('image/jpeg', 0.92);
      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', margin.left, margin.top, contentW, contentH);
    }

    var config = _reportConfig || {};
    var typeName = (config.reportType || 'report').charAt(0).toUpperCase() + (config.reportType || 'report').slice(1);
    var filename =
      (config.clientName || 'Report') +
      ' - ' +
      typeName +
      ' Energy Management Services Report ' +
      new Date().toISOString().slice(0, 10).replace(/-/g, '.') +
      '.pdf';
    pdf.save(filename);

    // Save to report history
    _saveReportToHistory(config, filename);
    showToast('PDF downloaded: ' + filename, 'success');
  } catch (err) {
    showToast('PDF export failed: ' + err.message, 'error');
  } finally {
    // Always restore hidden canvases, whether export succeeded or failed.
    hiddenCanvases.forEach(function (h) {
      h.el.style.visibility = h.prev;
    });
  }
}

function _saveReportToHistory(config, filename) {
  if (!config || !config.projId) return;
  var key = 'en_report_history_' + config.projId;
  var history = sget(key, []) || [];
  history.unshift({
    filename: filename,
    reportType: config.reportType,
    period: config.periodLabel,
    generated: new Date().toISOString(),
    buildings: config.buildingIds,
  });
  if (history.length > 20) history = history.slice(0, 20);
  sset(key, history);
}

// ── CROSS-WINDOW REFRESH (Issue 5) ──────────────────────────────────────────
// Re-generates the report preview using the same config but fresh localStorage data.
// Called manually via the "Refresh Report" toolbar button, or automatically when
// the storage event fires because the popup window saved changes to en_projects.
function refreshReportPreview() {
  if (!_reportConfig) return;
  var data = collectReportData(_reportConfig.projId, _reportConfig.buildingIds, null, _reportConfig.reportType);
  if (!data) {
    showToast('Could not refresh — check that buildings have data', 'error');
    return;
  }
  // Preserve report options (annualize pollution, commodity toggles)
  data.reportOptions = _reportData ? _reportData.reportOptions : {};
  // Preserve period label for cumulative/current/custom types
  if (
    _reportConfig.reportType === 'cumulative' ||
    _reportConfig.reportType === 'current' ||
    _reportConfig.reportType === 'custom'
  ) {
    data.period = data.period || {};
    data.period.label = _reportConfig.periodLabel;
  }
  _reportData = data;
  var selectedSections = {};
  REPORT_SECTIONS.forEach(function (sec) {
    selectedSections[sec.key] = _reportConfig.sections.indexOf(sec.key) >= 0;
  });
  var pagesHTML = generateReportHTML(data, selectedSections);
  _showPreview(_reportConfig, pagesHTML);
  // Hide stale banner if visible
  var banner = document.getElementById('rptStaleBanner');
  if (banner) banner.style.display = 'none';
  showToast('Report refreshed', 'success');
}

// Listen for localStorage changes made by the popup window.
// storage events fire in OTHER windows when localStorage changes — not in the
// same window that made the change — so this correctly detects popup saves.
window.addEventListener('storage', function (e) {
  if (e.key === 'en_projects' && _reportConfig && _reportConfig.projId) {
    clearTimeout(window._rptAutoRefreshTimer);
    window._rptAutoRefreshTimer = setTimeout(function () {
      // Show stale banner; user can also click Refresh manually
      var banner = document.getElementById('rptStaleBanner');
      if (banner) banner.style.display = 'flex';
    }, 500);
  }
});
