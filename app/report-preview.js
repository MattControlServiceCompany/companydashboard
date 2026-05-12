// ═══════════════════════════════════════════════════
// REPORT PREVIEW — preview/editor UI for the new report system
// Launched from Generate Report modal in Energy Graphics tab.
// Reuses collectReportData() and rptPage*() from report-engine.js.
// ═══════════════════════════════════════════════════

var _reportConfig = null;
var _reportData = null;

function generateReportPreview() {
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

  // Collect report data using existing engine
  var data = collectReportData(config.projId, config.buildingIds, reportDateStr, reportType);
  if (!data) {
    showToast('Could not collect report data — check that buildings have utility data', 'error');
    return;
  }

  // Attach report options
  data.reportOptions = {
    annualizePollution: config.pollutionMode === 'annualized',
    blCommodities: { electric: true, gas: true, propane: true, water: false },
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
  // The report engine wraps each page in a div with class "rpt-pg"
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = pagesHTML;
  var pageNodes = tempDiv.querySelectorAll('.rpt-pg');

  // If no rpt-pg divs, wrap the whole thing as one page
  if (pageNodes.length === 0) {
    pagesEl.innerHTML =
      '<div class="rpt-page" data-section="all" data-page="1">' +
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
        '<div class="rpt-page" data-section="' +
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
}

function _rebuildSidebar() {
  var sidebarEl = document.getElementById('rptPreviewSidebar');
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-page');
  var html =
    '<div style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text2);border-bottom:1px solid var(--s3);margin-bottom:4px">Sections</div>';
  var visibleIdx = 0;

  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var sectionKey = page.getAttribute('data-section') || 'page-' + (i + 1);
    var isVisible = page.style.display !== 'none';
    if (isVisible) visibleIdx++;

    // Find section label
    var label = sectionKey;
    for (var j = 0; j < REPORT_SECTIONS.length; j++) {
      if (REPORT_SECTIONS[j].key === sectionKey) {
        label = REPORT_SECTIONS[j].label;
        break;
      }
    }
    if (label === sectionKey) {
      // Try to extract from page content
      var h2 = page.querySelector('h2, [style*="font-size:14px"], [style*="font-weight:700"]');
      if (h2) label = h2.textContent.substring(0, 30);
    }

    html +=
      '<div class="rpt-sidebar-row" draggable="true" data-idx="' +
      i +
      '" ' +
      'ondragstart="_rptDragStart(event,' +
      i +
      ')" ' +
      'ondragover="_rptDragOver(event)" ' +
      'ondrop="_rptDrop(event,' +
      i +
      ')" ' +
      'style="display:flex;align-items:center;gap:6px;padding:5px 12px;cursor:grab;' +
      'border-bottom:1px solid var(--s2);font-size:11px;color:var(--text)">';
    html +=
      '<input type="checkbox" ' +
      (isVisible ? 'checked' : '') +
      ' onchange="togglePreviewSection(' +
      i +
      ',this.checked)" style="accent-color:var(--em);width:13px;height:13px;flex-shrink:0">';
    html += '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + label + '</span>';
    if (isVisible) {
      html += '<span style="font-size:9px;color:var(--text3);flex-shrink:0">p' + visibleIdx + '</span>';
    }
    html += '</div>';
  }

  sidebarEl.innerHTML = html;
}

function togglePreviewSection(idx, visible) {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-page');
  if (pages[idx]) {
    pages[idx].style.display = visible ? '' : 'none';
  }
  _rebuildSidebar();
  _updatePageNumbers();
}

function _updatePageNumbers() {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-page');
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
  var pages = Array.from(pagesContainer.querySelectorAll('.rpt-page'));
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
  document.querySelectorAll('#rptPreviewPages .rpt-page').forEach(function (p) {
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
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-page');
  var visiblePages = [];
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].style.display !== 'none') visiblePages.push(pages[i]);
  }
  if (!visiblePages.length) {
    showToast('No pages to export', 'warning');
    return;
  }

  showToast('Generating PDF — this may take a moment...', 'info');

  try {
    var pdf = new jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    var pageW = 612,
      pageH = 792;

    for (var i = 0; i < visiblePages.length; i++) {
      var el = visiblePages[i].querySelector('.rpt-pg') || visiblePages[i];
      var canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: el.scrollWidth,
        height: el.scrollHeight,
      });
      var imgData = canvas.toDataURL('image/jpeg', 0.92);
      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, pageH);
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
  }
}

function _saveReportToHistory(config, filename) {
  if (!config || !config.projId) return;
  var key = 'en_report_history_' + config.projId;
  var history = Store.get(key) || [];
  history.unshift({
    filename: filename,
    reportType: config.reportType,
    period: config.periodLabel,
    generated: new Date().toISOString(),
    buildings: config.buildingIds,
  });
  if (history.length > 20) history = history.slice(0, 20);
  Store.set(key, history);
}
