// ═══════════════════════════════════════════════════
// REPORT PREVIEW — preview/editor UI for the new report system
// Launched from Generate Report modal in Energy Graphics tab.
// Reuses collectReportData() and rptPage*() from report-engine.js.
// ═══════════════════════════════════════════════════

var _reportConfig = null;
var _reportData = null;
var _rptInspectActive = false;

// generateReportPreview(opts) - the Generate Preview button. A quarterly or annual report needs weather for every
// month it reports: months missing from the stored weather are fetched first and the report waits for the fetch
// (wxEnsureMonths, computations/weather-refresh.js). If the fetch fails the report is still built and the preview
// states the reason. Nothing is cached besides the stored weather itself (the savings cache key holds the weather).
async function generateReportPreview(opts) {
  var wx = { added: [], errors: [] };
  try {
    var cfg = _rptV2ReadConfig();
    if ((cfg.reportType === 'quarterly' || cfg.reportType === 'annual') && typeof wxEnsureMonths === 'function') {
      var req = reportRequestRange(_rptSelectedPeriod(cfg)) || {};
      var yms = [];
      if (req.startYm && req.endYm) {
        var y = parseInt(req.startYm.slice(0, 4), 10),
          m = parseInt(req.startYm.slice(5, 7), 10);
        while (y + '-' + String(m).padStart(2, '0') <= req.endYm) {
          yms.push(y + '-' + String(m).padStart(2, '0'));
          if (++m > 12) {
            m = 1;
            y++;
          }
        }
      }
      var proj = projects.find(function (p) {
        return String(p.id) === String(cfg.projId);
      });
      wx = await wxEnsureMonths(wxProjectZips(proj, getUDBldgs(cfg.projId)), yms, {
        loadFn: wddLoadCache,
        saveFn: wddSaveCache,
        fetchFn: function (url) {
          return fetch(url, { signal: AbortSignal.timeout(20000) });
        },
        now: new Date(),
      });
    }
  } catch (e) {
    wx.errors.push({ zip: '', message: (e && e.message) || String(e) });
  }
  _rptGeneratePreviewNow(opts, wx);
}

// Notes shown in the preview toolbar only (never in the printed report).
function _rptPreviewNotes(data, wx) {
  var notes = [];
  if (!data) return notes;
  if (data.period && data.period.type === 'quarterly' && !data.basScheduleHistory)
    notes.push('Operating hours and set points page left out: no BAS audit log imported.');
  return notes;
}

function _rptGeneratePreviewNow(opts, wx) {
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

  // A quarterly or annual report is not built while a bill or a month of weather is missing. The reason is
  // shown inline in the Generate Report dialog (an internal message, never part of the report).
  if (config.reportType === 'quarterly' || config.reportType === 'annual') {
    var _rq = reportRequestRange(_rptSelectedPeriod(config)) || {};
    var _miss = reportMissingInputs(config.projId, config.meterIds, config.buildingIds, _rq.startYm, _rq.endYm);
    var _blk = document.getElementById('rptV2BlockedMsg');
    if (!_miss.ok) {
      var _why = wx && wx.errors && wx.errors.length ? ' Weather load error: ' + wx.errors.map(function (e) { return e.message; }).join('; ') + '.' : '';
      if (_blk) {
        _blk.style.display = '';
        _blk.textContent = 'Report not generated. ' + _miss.lines.join(' ') + _why;
      }
      return;
    }
    if (_blk) {
      _blk.style.display = 'none';
      _blk.textContent = '';
    }
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
  var selectedPeriod = _rptSelectedPeriod(config);

  // Collect report data using existing engine
  var data = collectReportData(
    config.projId,
    config.buildingIds,
    reportDateStr,
    reportType,
    selectedPeriod,
    config.meterIds,
  );
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

  // A period already presented to the client opens the presented report by default (Matt 2026-09-29);
  // "Generate updated report" comes back here with { updated: true }.
  if (!(opts && opts.updated) && data.project && data.period && typeof _rptPresentedChooser === 'function') {
    var _pyms = (data.period.yearMonths || []).slice().sort();
    if (
      _pyms.length &&
      _rptPresentedChooser(data.project.id, _pyms, data.period.label, function () {
        generateReportPreview({ updated: true });
      })
    )
      return;
  }

  _reportConfig = config;
  _reportData = data;
  window._rptPreviewNoteList = _rptPreviewNotes(data, wx);
  // downloadReportPdf() (app/report-engine.js) reads window._currentReportData for every report
  // type — set it here too so the shared print-to-PDF path (fix/quarterly-text-pdf, 2026-09-25)
  // has the same data the legacy generate*Preview() functions already expose.
  window._currentReportData = data;

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
  // Fix 3 (2026-09-10): _rptInjectUiPassOverrides() (report-engine.js) was previously only ever
  // called by showReportOverlay() (the legacy #reportPages overlay). The V2 preview populates a
  // different container (#rptPreviewPages) and never triggered it, so its injected <style> tag
  // (and therefore the Baseline Data gridline fix) never existed for the live report path unless
  // some other report type happened to open the legacy overlay first in the same session. Call is
  // idempotent (checks its own style-tag id) and cheap — safe to call on every preview render.
  if (typeof _rptInjectUiPassOverrides === 'function') _rptInjectUiPassOverrides();
  var container = document.getElementById('reportPreviewContainer');
  var pagesEl = document.getElementById('rptPreviewPages');
  var sidebarEl = document.getElementById('rptPreviewSidebar');
  var titleEl = document.getElementById('rptPreviewTitle');

  // Set title
  // The period the report states is the one collectReportData worked out (first to last month with bills).
  var _titleLabel =
    window._currentReportData && window._currentReportData.period && window._currentReportData.period.label
      ? window._currentReportData.period.label
      : config.periodLabel;
  var typeLabel = config.reportType.charAt(0).toUpperCase() + config.reportType.slice(1);
  titleEl.textContent =
    config.clientName + ' — ' + typeLabel + ' Report' + (_titleLabel ? ' (' + _titleLabel + ')' : '');

  var notesEl = document.getElementById('rptPreviewNotes');
  if (notesEl) notesEl.textContent = (window._rptPreviewNoteList || []).join(' ');

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
  _rptRefreshPresentedUI();
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
    // Sections that share a page (data-subsection) each get their own sidebar row and checkbox.
    pg.querySelectorAll('[data-subsection]').forEach(function (sub) {
      var subKey = sub.getAttribute('data-subsection');
      var subVis = isVis && sub.style.display !== 'none';
      if (baseKey === subKey) sectionPageMap[subKey].isVisible = subVis;
      else sectionPageMap[subKey] = { pageIdx: i, isVisible: subVis, pageNum: subVis ? globalVisibleIdx : null };
    });
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
      pages[pi].querySelectorAll('[data-subsection]').forEach(function (sub) {
        var subKey = sub.getAttribute('data-subsection');
        if (sectionPageMap[subKey]) sectionPageMap[subKey].pageNum = sub.style.display !== 'none' ? visNum : null;
      });
    }
  }

  // A section row with sameAs has no page of its own: it shows the page, the page number and the checkbox of that row.
  REPORT_SECTIONS.forEach(function (sec) {
    if (sec.sameAs && sectionPageMap[sec.sameAs]) sectionPageMap[sec.key] = sectionPageMap[sec.sameAs];
  });

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
        ' onclick="event.stopPropagation();_setSectionVisible(\'' +
        sec.key +
        '\',this.checked)" style="accent-color:var(--em);width:13px;height:13px;flex-shrink:0;cursor:pointer">';
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
        'border-bottom:1px solid var(--s2);font-size:11px;color:var(--text3)">';
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

// Show or hide one sidebar section. A section that shares a page with another is a data-subsection block
// inside that page: the block hides on its own, and the page hides only when every block on it is hidden.
// _rptPageKeyOf(key): the key of the page a section row shows (REPORT_SECTIONS sameAs), or the key itself.
function _rptPageKeyOf(key) {
  var sec = REPORT_SECTIONS.filter(function (x) {
    return x.key === key;
  })[0];
  return sec && sec.sameAs ? sec.sameAs : key;
}

function _setSectionVisible(key, visible) {
  key = _rptPageKeyOf(key);
  var sub = document.querySelector('#rptPreviewPages [data-subsection="' + key + '"]');
  if (sub) {
    sub.style.display = visible ? '' : 'none';
    var pageEl = sub.closest('.rpt-preview-page');
    var anyShown = Array.prototype.some.call(pageEl.querySelectorAll('[data-subsection]'), function (x) {
      return x.style.display !== 'none';
    });
    pageEl.style.display = anyShown ? '' : 'none';
    _rebuildSidebar();
    _updatePageNumbers();
    return;
  }
  var page = document.querySelector('#rptPreviewPages .rpt-preview-page[data-section="' + key + '"]');
  if (!page) return;
  var all = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  togglePreviewSection(Array.prototype.indexOf.call(all, page), visible);
}

function _toggleSectionByKey(key) {
  key = _rptPageKeyOf(key);
  var sub = document.querySelector('#rptPreviewPages [data-subsection="' + key + '"]');
  if (sub) {
    _setSectionVisible(key, sub.style.display === 'none' || sub.closest('.rpt-preview-page').style.display === 'none');
    return;
  }
  var page = document.querySelector('#rptPreviewPages .rpt-preview-page[data-section="' + key + '"]');
  if (!page) return;
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  var idx = Array.prototype.indexOf.call(pages, page);
  if (idx < 0) return;
  var nowVisible = page.style.display === 'none';
  togglePreviewSection(idx, nowVisible);
}

function _scrollToSection(key) {
  key = _rptPageKeyOf(key);
  var subEl = document.querySelector('#rptPreviewPages [data-subsection="' + key + '"]');
  var page = subEl ? subEl.closest('.rpt-preview-page') : document.querySelector('#rptPreviewPages .rpt-preview-page[data-section="' + key + '"]');
  if (page) page.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// togglePreviewSection(idx, visible): shows or hides the page at idx and the pages that continue it (a page with no section
// key of its own, or a key ending in -cont, belongs to the section page before it).
function togglePreviewSection(idx, visible) {
  var pages = document.querySelectorAll('#rptPreviewPages .rpt-preview-page');
  if (pages[idx]) {
    pages[idx].style.display = visible ? '' : 'none';
    for (var ci = idx + 1; ci < pages.length; ci++) {
      var ck = pages[ci].getAttribute('data-section') || '';
      if (!(/^page-\d+$/.test(ck) || /-cont$/.test(ck))) break;
      pages[ci].style.display = visible ? '' : 'none';
    }
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
      '<span style="color:#ffffff">font</span> ' +
      fontFamily +
      '<br>' +
      '<span style="color:#ffffff">size</span> ' +
      fontSize +
      '<br>' +
      '<span style="color:#ffffff">color</span> <span style="display:inline-block;width:10px;height:10px;background:' +
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
    meterIds: _reportConfig.meterIds,
    pollutionMode: _reportConfig.pollutionMode,
    savedAt: new Date().toISOString(),
  };

  _saveReportTemplateData(_reportConfig.projId, template);
  showToast('Template saved: ' + name, 'success');
}

// fix/quarterly-text-pdf (2026-09-25): downloadReportPDF() (html2canvas + jsPDF raster export,
// plus its _saveReportToHistory() helper) removed — it produced an image-only PDF with no
// selectable/searchable text (PyMuPDF get_text() returned '' on every page, 2026-09-25 E2E).
// The "Download PDF" button now calls downloadReportPdf() (app/report-engine.js) directly, the
// same native window.print()-based text PDF path used by the ASHRAE 36 / Proposal / Client B /
// Agreement reports (fix/report-not-copyable, 2026-07-22) — that function already branches on
// which preview container is open (#reportPreviewContainer/#rptPreviewPages for this v2 preview
// vs the legacy #reportOverlay/#reportPages) and already builds the correct Quarterly/Annual
// filename from data.period.type, so no v2-specific wrapper is needed. _saveReportToHistory()
// wrote to a write-only localStorage key (en_report_history_<projId>) nothing ever read; dropped
// rather than carried forward as a compatibility shim.

// ── CROSS-WINDOW REFRESH (Issue 5) ──────────────────────────────────────────
// Re-generates the report preview using the same config but fresh localStorage data.
// Called manually via the "Refresh Report" toolbar button, or automatically when
// the storage event fires because the popup window saved changes to en_projects.
// The period arguments collectReportData takes, from a report config. Quarterly: the quarter picked.
// Custom: the first and last month the user chose (the engine clamps them to the months with bills).
function _rptSelectedPeriod(config) {
  if (config.reportType === 'quarterly' && config.quarter && config.year)
    return { quarter: config.quarter, year: config.year };
  if (config.reportType === 'custom')
    return {
      startYm: config.startDate ? String(config.startDate).slice(0, 7) : '',
      endYm: config.endDate ? String(config.endDate).slice(0, 7) : '',
    };
  return null;
}

function refreshReportPreview() {
  if (!_reportConfig) return;
  // Same period arguments generateReportPreview() used, so a refresh keeps the quarter / year on screen
  // (before this, a refresh fell back to the newest quarter and swapped the report to another period).
  var _rType = _reportConfig.reportType;
  var data = collectReportData(
    _reportConfig.projId,
    _reportConfig.buildingIds,
    _rType === 'quarterly' || _rType === 'annual' ? new Date().toISOString().slice(0, 10) : null,
    _rType,
    _rptSelectedPeriod(_reportConfig),
    _reportConfig.meterIds,
  );
  if (!data) {
    showToast('Could not refresh — check that buildings have data', 'error');
    return;
  }
  // Preserve report options (annualize pollution, commodity toggles)
  data.reportOptions = _reportData ? _reportData.reportOptions : {};
  _reportData = data;
  window._currentReportData = data;
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

// Remote change: the report data is built from the store. Drop it so the next preview reads the new records.
// (app/core.js sends chDropStoreCaches before it draws the open view again. This only clears memory.)
if (typeof window.addEventListener === 'function') window.addEventListener('chDropStoreCaches', function () {
  _reportData = null;
});
