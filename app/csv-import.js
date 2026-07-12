/* ══════════════════════════════════════════
         CSV IMPORT FOR METER BILLS
      ══════════════════════════════════════════ */
let _csvImportMid = null;
let _csvImportRows = [];

// #86: Drop handler for the Utility Data empty-meter drop zone.
// Routes PDF files to the PDF/OCR extraction pipeline; CSV files to the CSV import modal.
function udMeterDropHandler(e, mid) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag');
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;
  const file = files[0];
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    // Navigate to PDF/OCR page and process the file there
    sv('view-pdf');
    // Small delay to let the view render before we trigger the extraction
    setTimeout(() => {
      if (window._pdfQueue) {
        appendToQueue([file]);
      } else {
        processPDF(file);
      }
    }, 150);
    showToast('Sending to PDF extractor…');
  } else {
    // CSV — open the normal import modal
    openCsvImportForMeter(mid);
    // Then process the file directly
    processBillCsvFile(file);
  }
}

// Resolves udSelProjId/udSelBldgId from the active embed wrapper when in project-embed mode.
// Call this at the top of any handler that reads those globals but may fire after
// renderProjUDBody restores them to pre-embed values. Safe to call in standalone mode (no-op).
function _syncEmbedUDContext() {
  if (window._udActiveWrap && window._udActiveWrap.id) {
    const m2 = window._udActiveWrap.id.match(/^proj-ud-body-(\d+)$/);
    if (m2) {
      const pid = Number(m2[1]);
      udSelProjId = pid;
      if (typeof projUDSelBldg !== 'undefined' && projUDSelBldg[pid]) {
        udSelBldgId = projUDSelBldg[pid];
      }
    }
  }
}

function openCsvImportForMeter(mid) {
  _syncEmbedUDContext();
  _csvImportMid = mid;
  _csvImportRows = [];
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    showToast('Building context lost — re-select the meter and try again', 'warn');
    return;
  }
  const m = b.meters.find((m) => m.id === mid);
  if (!m) {
    showToast('Meter not found — try re-selecting the meter', 'warn');
    return;
  }

  const isElec = m.commodity === 'Electric',
    isGas = m.commodity === 'Gas';
  let cols = '',
    note = '';
  if (isElec) {
    cols =
      'start_date, end_date, kwh, actual_kw, billed_kw, facilities_kw, actual_kw_cost, facilities_kw_cost, kwh_cost, total_cost';
    note =
      'start_date and end_date required. Numeric columns: kwh, actual_kw, billed_kw, facilities_kw, actual_kw_cost, facilities_kw_cost, kwh_cost, total_cost.';
  } else if (isGas) {
    cols = 'start_date, end_date, therms, therm_cost';
    note = 'start_date and end_date required. Optional: therms, therm_cost.';
  } else {
    cols = 'start_date, end_date, usage, cost';
    note = 'start_date and end_date required. Optional: usage, cost.';
  }

  document.getElementById('billCsvColGuide').textContent = cols;
  document.getElementById('billCsvColNote').textContent = note;
  document.getElementById('billCsvModalTitle').textContent =
    '📥 Import Bills — ' + m.commodity + ' · ' + (m.provider || 'Meter');
  document.getElementById('billCsvPreviewWrap').style.display = 'none';
  document.getElementById('billCsvImportBtn').style.display = 'none';
  document.getElementById('billCsvDropLabel').textContent = 'Drop CSV file or click to browse';
  document.getElementById('billCsvInput').value = '';
  document.getElementById('billCsvModal').classList.add('open');
}

function closeBillCsvModal() {
  document.getElementById('billCsvModal').classList.remove('open');
  _csvImportMid = null;
  _csvImportRows = [];
}
function handleBillCsvDrop(e) {
  e.preventDefault();
  document.getElementById('billCsvDrop').classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) processBillCsvFile(f);
}
function handleBillCsvFile(e) {
  const f = e.target.files[0];
  if (f) processBillCsvFile(f);
}

function processBillCsvFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => parseBillCsv(e.target.result, file.name);
  reader.readAsText(file);
}

function parseBillCsv(text, fname) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    showToast('Building context lost — close and re-open the import dialog', 'warn');
    return;
  }
  const m = b.meters.find((m) => m.id === _csvImportMid);
  if (!m) {
    showToast('Meter context lost — close and re-open the import dialog', 'warn');
    return;
  }
  const isElec = m.commodity === 'Electric',
    isGas = m.commodity === 'Gas';

  // Split lines, ignore blanks
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);
  if (lines.length < 2) {
    showToast('CSV appears empty');
    return;
  }

  // Detect header row
  const first = lines[0].toLowerCase();
  const hasHeader = /date|month|start|end|kwh|therm|usage/.test(first);
  const dataLines = hasHeader ? lines.slice(1) : lines;

  // Parse header to find column indices
  const hdr = hasHeader
    ? lines[0]
        .toLowerCase()
        .split(',')
        .map((h) => h.trim())
    : null;
  const ci = (names) => {
    if (!hdr) return -1;
    for (const n of names) {
      const i = hdr.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  // Column index lookups.
  // Each ci() list includes BOTH underscore/space display names AND camelCase internal names
  // so that a CSV exported from the Bills tab can be re-imported without losing cost columns.
  const iStart = hdr ? Math.max(ci(['start', 'begin', 'from']), 0) : 0;
  const iEnd = hdr ? (ci(['end', 'to', 'thru', 'through']) > -1 ? ci(['end', 'to', 'thru', 'through']) : 1) : 1;
  const iKwh = hdr ? ci(['kwh', 'consumption', 'usage', 'energy']) : 2;
  const iDemand = hdr ? ci(['actual_kw', 'actual kw', 'demand_kw', 'demand kw', 'peak kw', 'demand', 'demandkw']) : 3;
  // camelCase aliases: 'billedkw' matches export header 'billedKW' (lowercased by hdr processing)
  const iBilledKW = hdr ? ci(['billed_kw', 'billed kw', 'billkw', 'bill_kw', 'billedkw']) : 4;
  const iFacKW = hdr ? ci(['facilities_kw', 'facilities kw', 'fac_kw', 'facility kw', 'fac kw', 'fackw']) : 5;
  // camelCase alias: 'kwcost' matches export header 'kwCost'
  const iKwCost = hdr ? ci(['kw_cost', 'kw cost', 'demand cost', 'demand$', 'demand_cost', 'kwcost']) : 6;
  const iFacKWCst = hdr
    ? ci([
        'facilities_kw_cost',
        'facilities kw cost',
        'actual_kw_cost',
        'fac_kw_cost',
        'fac kw cost',
        'facility kw cost',
        'fackwcost', // camelCase alias: matches export header 'facKWCost'
      ])
    : 7;
  // camelCase alias: 'kwhcost' matches export header 'kwhCost'
  const iKwhCst = hdr ? ci(['kwh_cost', 'kwh cost', 'energy cost', 'energy$', 'energy_cost', 'kwhcost']) : 8;
  const iTotCst = hdr
    ? ci(['total_cost', 'total cost', 'total$', 'bill', 'amount', 'total', 'totalcost'])
    : isElec
      ? 9
      : 3;
  const iTherms = hdr ? ci(['therms', 'therm', 'gas', 'ccf', 'mcf']) : 2;
  // camelCase alias: 'thermcost' matches export header 'thermCost'
  const iThCost = hdr ? ci(['therm_cost', 'therm cost', 'gas cost', 'gas$', 'thermcost']) : 3;
  const iUsage = hdr ? ci(['usage', 'consumption', 'hcf', 'kgal', 'mlb']) : 2;
  const iCost = hdr ? ci(['cost', 'total', 'amount', 'bill$']) : 3;

  const parsed = [];
  const warnings = [];

  dataLines.forEach((line, idx) => {
    const cols = splitCsvLine(line);
    if (cols.length < 2) return;

    const rawStart = (cols[iStart] || '').trim().replace(/"/g, '');
    const rawEnd = (iEnd >= 0 ? cols[iEnd] || '' : '').trim().replace(/"/g, '');
    const startD = parseFlexDate(rawStart);
    const endD = parseFlexDate(rawEnd);

    if (!startD) {
      warnings.push(
        'Row ' + (idx + 1 + hasHeader ? idx + 2 : idx + 1) + ': could not parse start date "' + rawStart + '"',
      );
      return;
    }

    // Derive end date if missing — last day of start month
    const effectiveEnd = endD || lastDayOfMonth(startD);

    const row = { id: 'r' + Date.now() + Math.random(), start: startD, end: effectiveEnd };

    const g = (i) => {
      if (i < 0 || !cols[i] || cols[i].trim() === '') return null;
      const n = parseFloat(cols[i].replace(/[$,]/g, ''));
      return isNaN(n) ? null : n;
    };
    const gs = (i) => (i >= 0 && cols[i] ? cols[i].trim().replace(/"/g, '') : '');

    if (isElec) {
      row.kwh = g(iKwh);
      row.demandKW = g(iDemand);
      row.billedKW = g(iBilledKW);
      row.facKW = g(iFacKW);
      row.kwCost = g(iKwCost);
      row.facKWCost = g(iFacKWCst);
      row.kwhCost = g(iKwhCst);
      row.totalCost = g(iTotCst);
    } else if (isGas) {
      row.therms = g(iTherms);
      row.thermCost = g(iThCost);
    } else {
      row.usage = g(iUsage);
      row.cost = g(iCost);
    }

    parsed.push(row);
  });

  if (!parsed.length) {
    showToast('No valid rows found in CSV');
    return;
  }

  // Deduplicate: collapse exact duplicate start dates only (same bill entered twice).
  // DO NOT deduplicate by normMonth — split-month bills (e.g. 2/1–2/15 and 2/15–3/1) must
  // both survive so getNormRows can prorate them correctly across calendar months.
  const byStart = {};
  parsed.forEach((r) => {
    const key = r.start; // exact start date YYYY-MM-DD
    if (!byStart[key]) byStart[key] = r;
    else {
      // Keep row with more non-null data fields (0 is valid data, not missing)
      const exScore = Object.values(byStart[key]).filter((v) => v !== null && v !== undefined && v !== '').length;
      const newScore = Object.values(r).filter((v) => v !== null && v !== undefined && v !== '').length;
      if (newScore > exScore) byStart[key] = r;
    }
  });
  _csvImportRows = Object.values(byStart).sort((a, b) => _parseISO(a.start) - _parseISO(b.start));

  // Show preview
  showBillCsvPreview(_csvImportRows, m, fname, warnings);
}

function splitCsvLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur);
      cur = '';
    } else cur += c;
  }
  result.push(cur);
  return result;
}

function parseFlexDate(s) {
  if (!s) return null;
  s = s.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s))
    return s.length === 10 ? s : s.replace(/^(\d{4})-(\d)-/, '$1-0$2-').replace(/-(\d)$/, '-0$1');
  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return mdy[3] + '-' + mdy[1].padStart(2, '0') + '-' + mdy[2].padStart(2, '0');
  // MM-DD-YYYY
  const mdy2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mdy2) return mdy2[3] + '-' + mdy2[1].padStart(2, '0') + '-' + mdy2[2].padStart(2, '0');
  // Month YYYY or "Jan 2024"
  const mv = s.match(/^(\w+)[,\s]+(\d{4})$/);
  if (mv) {
    const mo =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        mv[1].toLowerCase().slice(0, 3),
      ) + 1;
    if (mo > 0) return mv[2] + '-' + String(mo).padStart(2, '0') + '-01';
  }
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';
  return null;
}

function showBillCsvPreview(rows, m, fname, warnings) {
  const isElec = m.commodity === 'Electric',
    isGas = m.commodity === 'Gas';
  document.getElementById('billCsvDropLabel').textContent = '✓ ' + fname + ' — click to change';
  document.getElementById('billCsvRowCount').textContent =
    rows.length + ' period' + (rows.length !== 1 ? 's' : '') + ' found';

  let thead = '<tr><th>Start</th><th>End</th><th>Days</th>';
  if (isElec)
    thead +=
      '<th>kWh</th><th>Actual kW</th><th>Facilities kW</th><th>Actual kW Cost</th><th>Facilities kW Cost</th><th>Total $</th>';
  else if (isGas) thead += '<th>Therms</th><th>Cost $</th>';
  else thead += '<th>Usage</th><th>Cost $</th>';
  thead += '</tr>';

  const tbody = rows
    .map((r) => {
      const days = Math.round((_parseISO(r.end) - _parseISO(r.start)) / 864e5) + 1;
      let cells = '';
      const _d = (v) => (v != null ? v : '—');
      const _dc = (v) => (v != null ? '$' + (+v).toLocaleString() : '—');
      const _dc2 = (v) =>
        v != null ? '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
      if (isElec)
        cells = `<td>${r.kwh != null ? (+r.kwh).toLocaleString() : '—'}</td><td>${_d(r.demandKW)}</td><td>${_d(r.facKW)}</td><td>${_dc(r.kwCost)}</td><td>${_dc(r.facKWCost)}</td><td>${_dc2(r.totalCost)}</td>`;
      else if (isGas)
        cells =
          '<td>' + (r.therms != null ? (+r.therms).toLocaleString() : '—') + '</td><td>' + _dc(r.thermCost) + '</td>';
      else
        cells =
          '<td>' + (r.usage != null ? r.usage : '—') + '</td><td>' + (r.cost != null ? '$' + r.cost : '—') + '</td>';
      return (
        '<tr><td>' + fmtDate(r.start) + '</td><td>' + fmtDate(r.end) + '</td><td>' + days + '</td>' + cells + '</tr>'
      );
    })
    .join('');

  document.getElementById('billCsvPreviewTable').innerHTML = '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody>';
  document.getElementById('billCsvPreviewLabel').textContent =
    'Preview — ' + rows.length + ' period' + (rows.length !== 1 ? 's' : '');
  document.getElementById('billCsvPreviewWrap').style.display = '';

  const warnEl = document.getElementById('billCsvWarnings');
  if (warnings.length) {
    warnEl.style.display = '';
    warnEl.innerHTML = '⚠️ ' + warnings.join('<br>');
  } else {
    warnEl.style.display = 'none';
  }

  document.getElementById('billCsvImportCount').textContent = rows.length;
  document.getElementById('billCsvImportBtn').style.display = '';
}

function importBillCsvRows() {
  if (!_csvImportRows.length || !_csvImportMid) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === _csvImportMid);
  if (!m) return;
  m.bills = m.bills || [];

  // Merge on exact start date — split-month bills (e.g. 2/1 and 2/15) are distinct rows
  const existing = new Set(m.bills.map((r) => r.start));
  let added = 0,
    updated = 0;
  _csvImportRows.forEach((r) => {
    const key = r.start;
    if (existing.has(key)) {
      const idx = m.bills.findIndex((b) => b.start === key);
      if (idx >= 0) {
        Object.assign(m.bills[idx], r);
        updated++;
      }
    } else {
      m.bills.push({ id: 'r' + Date.now() + Math.random(), ...r });
      existing.add(key);
      added++;
    }
  });

  m.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  // Run validation on all newly-imported/updated bills so _flags are persisted immediately
  if (typeof runBillValidation === 'function') {
    _csvImportRows.forEach((r) => {
      const addedBill = m.bills.find((b) => b.start === r.start);
      if (addedBill) runBillValidation(m, addedBill);
    });
  }
  // Run building-level cross-meter validation (water vs sewer parity, etc.)
  if (typeof runBuildingValidation === 'function' && typeof getUDBldg === 'function') {
    const _csvBldg = getUDBldg(udSelProjId, udSelBldgId);
    if (_csvBldg) runBuildingValidation(_csvBldg);
  }
  saveUtilityData();
  closeBillCsvModal();
  udActiveTab = 'bills';
  renderMeterWorkspace();
  showToast('Imported: ' + added + ' new, ' + updated + ' updated ✓');
  addNotif(
    'Bills Imported',
    'Added ' + added + ' new billing period' + (added !== 1 ? 's' : '') + ' to ' + m.commodity + ' meter',
    '📥',
  );
}

const _CHARGE_QTY_PAIRS = {
  onPeakCost: 'onPeakKwh',
  offPeakCost: 'offPeakKwh',
  demandCharge: 'billedKW',
  facilitiesCharge: 'facKW',
};

function _billFieldWarnings(row, commodity) {
  const warnings = {};
  if (commodity !== 'Electric') return warnings;
  const _pf = (v) => parseFloat(v) || 0;
  // Check charge-without-qty
  Object.entries(_CHARGE_QTY_PAIRS).forEach(([chargeKey, qtyKey]) => {
    if (_pf(row[chargeKey]) > 0 && _pf(row[qtyKey]) === 0) {
      warnings[qtyKey] = 'Charge of $' + _pf(row[chargeKey]).toFixed(2) + ' exists but qty is missing';
      warnings[chargeKey] = 'Has charge but no qty — verify extraction';
    }
  });
  // kWh identity check
  const onPk = _pf(row.onPeakKwh);
  const offPk = _pf(row.offPeakKwh);
  const total = _pf(row.kwh);
  if (onPk > 0 && offPk > 0 && total > 0) {
    const diff = Math.abs(onPk + offPk - total);
    if (diff > 1) {
      const _fmtKwh = (v) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(2));
      warnings['kwh'] =
        'On-Peak (' +
        _fmtKwh(onPk) +
        ') + Off-Peak (' +
        _fmtKwh(offPk) +
        ') = ' +
        _fmtKwh(onPk + offPk) +
        ' but Total kWh = ' +
        _fmtKwh(total);
    }
  }
  return warnings;
}

/* ── RENDER BILL ROW (used in Bills pane table) ── */
function renderBillRow(row, m, incl, allBills, cols, rowNum) {
  if (incl === undefined) incl = m.inclusive !== false;
  let days = calcDays(row.start, row.end, incl);
  // Propane deliveries use DeliveryDate as both start and end, so
  // calcDays returns 0 when inclusive is false.  Show 1 instead.
  if (days === 0 && row.start && row.start === row.end && m.commodity === 'Propane') days = 1;
  // Show the 📄 button whenever the row has ANY usable PDF reference —
  // either an old per-bill pdfBillId OR a shared pdfKey. Bills saved via the
  // batch shared-key path (_ensureBatchPdfStored) may legitimately have no
  // pdfBillId but still have a valid pdfKey pointing at IndexedDB or the
  // localStorage fallback, and gating on pdfBillId alone hides the button for
  // those rows. viewSavedPDF already handles an empty first arg gracefully.
  const pdfLookupId = row.pdfBillId || row.id || '';
  const pdfBtn =
    (row.hasPDF || row.pdfKey) && (row.pdfBillId || row.pdfKey)
      ? `<button class="btn-edit" onclick="viewSavedPDF('${pdfLookupId}',${row.pdfPageStart || 'null'},${row.pdfPageEnd || 'null'},'${row.pdfKey || ''}')" title="View source PDF" style="color:var(--accent)">📄</button>`
      : '';
  // Actions column is always the last col and is right-sticky.
  const _actionColIdx = (cols || []).length - 1;
  const actionBtns = `<td class="td-actions sticky-col-right" data-sticky-right="${_actionColIdx}">
          ${pdfBtn}<button class="btn-edit" onclick="openBillModal('${m.id}','${row.id}')" title="Edit">✏️</button>
          <button class="btn-del"  onclick="deleteBillRow('${m.id}','${row.id}')" title="Delete">✕</button>
        </td>`;

  const fmtD = (v) => (v ? fmtDate(v) : '—');
  // Update 82: schema-driven cells. renderBillsPane passes the cols
  // array; each field column pulls its value via _billReadValue (honors
  // fallbackKey for legacy data) and formats it via _billFormatValue.
  // When called without `cols` (legacy callers), fall back to the
  // schema for the meter's commodity.
  if (!cols) {
    const schemaForTable = _billSchemaFor(m.commodity).filter(
      (e) =>
        !e.section &&
        !['start', 'end', 'numberOfDays', 'utilityCompany', 'customerName', 'serviceAddress'].includes(e.key),
    );
    cols = [
      {}, // # (row number)
      {}, // Norm Month
      {}, // Start
      {}, // End
      {}, // Days
      ...schemaForTable.map((e) => ({
        k: e.key,
        entry: e,
        a: e.type === 'text' || e.type === 'date' ? 'lbl' : '',
      })),
      {}, // Actions
    ];
  }
  // Base columns: col 0 = # (row number), col 1 = Norm Month (sticky),
  // col 2 = Start (sticky), col 3 = End (sticky), col 4 = Days (not sticky).
  // Field columns start at index 5. data-sticky values match col indices 1-3.
  // (Fix 3113c062: added # col at index 0, shifting former cols 0-3 to 1-4.)
  const _fieldWarningsEarly = _billFieldWarnings(row, m.commodity);
  const _hasRowWarning = Object.keys(_fieldWarningsEarly).length > 0;
  // Bug #17: rows with missing start/end dates get a special class so they're
  // visually distinct from normal rows and easy to identify for deletion/re-extraction.
  const _missingDates = !row.start || !row.end;
  const _warnTip = _missingDates
    ? 'Missing start/end dates — delete this row and re-extract'
    : 'This bill has missing or inconsistent data fields';
  let html =
    `<tr style="cursor:pointer" onclick="showBillSplitPanel('${m.id}','${row.id}',event)"${_missingDates ? ' class="ud-bill-missing-dates"' : ''}>` +
    `<td class="sticky-col" data-sticky="0" style="text-align:center;color:var(--text3);font-size:11px;padding:0 4px">${rowNum != null ? rowNum : ''}</td>` +
    `<td class="norm-mon-cell sticky-col" data-sticky="1">${normMonthLabel(row.start, row.end, incl, allBills || m.bills || [])}${_hasRowWarning || _missingDates ? ` <span title="${_warnTip}" style="color:var(--amber);cursor:help">⚠</span>` : ''}</td>` +
    `<td class="lbl sticky-col" data-sticky="2">${fmtD(row.start)}</td>` +
    `<td class="lbl sticky-col" data-sticky="3">${fmtD(row.end)}</td>` +
    `<td class="td-days">${days}</td>`;
  for (let i = 5; i < cols.length - 1; i++) {
    const c = cols[i];
    // Condensed-view column (Update 90): render via category.compute
    // or direct row key. No BILL_SCHEMA entry needed.
    if (c.category) {
      // Track whether the source value is genuinely missing (null/undefined/'')
      // vs a valid numeric 0. _pfBills collapses both to 0, so we must check
      // the raw source BEFORE calling it. For compute-based columns the
      // compute function already embeds _pfBills internally — we accept that
      // a computed 0 renders as a formatted zero rather than '—' (correct
      // behaviour: a sum of zero charges is a real value, not absent data).
      let val = 0;
      let isMissing = false;
      if (typeof c.category.compute === 'function') {
        val = c.category.compute(row);
        // compute always returns a number; treat only NaN/undefined as missing
        isMissing = val === undefined || val === null || isNaN(val);
      } else if (c.category.key) {
        const rawKey = row[c.category.key];
        isMissing = rawKey === null || rawKey === undefined || rawKey === '' || rawKey === 'null';
        val = isMissing ? 0 : _pfBills(rawKey);
      }
      // Apply unit conversion for usage-quantity condensed columns (Task 3).
      // Match labels like "Total kWh", "CCF", "Therms", "Water Usage" but
      // NOT rate columns ("$/kWh"), demand ("kW"), or currency columns.
      if (
        c.category.type === 'number' &&
        /kwh|ccf|therm|usage|gallon/i.test(c.category.label) &&
        !/kw\b|rate|\$/i.test(c.category.label) &&
        !isMissing
      ) {
        val = convertBillValue(val, m);
      }
      const cls = c.category.type === 'currency' ? 'td-total' : c.a || '';
      let formatted;
      if (c.category.type === 'currency') {
        // Show '—' only when value is genuinely absent; render 0 as "$0.00"
        // (consistent with _billFormatValue). Previously `val === 0 ? '—'`
        // incorrectly suppressed valid zero-dollar currency values.
        formatted = isMissing
          ? '—'
          : '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else if (c.category.type === 'rate') {
        // Blended per-unit rates use 5 decimals — typical utility rate
        // precision (e.g. $0.03854/kWh). A computed rate of 0 means the
        // denominator (kWh/kW) was 0 — no data available — so '—' is correct.
        formatted =
          val === 0 ? '—' : '$' + val.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
      } else if (c.category.type === 'number') {
        // Show '—' only when missing; render 0 as a formatted number ("0.00")
        const isQty = /kwh|kw\b|rkva|gallon|ccf|therm|usage/i.test(c.category.label);
        formatted = isMissing
          ? '—'
          : val.toLocaleString('en-US', {
              minimumFractionDigits: isQty ? 2 : 0,
              maximumFractionDigits: 4,
            });
      } else {
        formatted = val || '—';
      }
      const rightCls = c.rightSticky ? ' sticky-col-right' : '';
      const rightAttr = c.rightSticky ? ' data-sticky-right="' + i + '"' : '';
      const finalCls = (cls + rightCls).trim();
      html += `<td${finalCls ? ' class="' + finalCls + '"' : ''}${rightAttr}>${formatted}</td>`;
      continue;
    }
    if (!c.entry) {
      html += '<td>—</td>';
      continue;
    }
    let raw = _billReadValue(row, c.entry);
    // Apply unit conversion for usage quantity fields (Task 3)
    if (_BILL_USAGE_KEYS.has(c.entry.key) && raw !== undefined && raw !== null && raw !== '' && !isNaN(raw)) {
      raw = convertBillValue(parseFloat(raw), m);
    }
    const formatted = _billFormatValue(raw, c.entry);
    const cls = c.entry.key === 'totalCost' ? 'td-total' : c.a || '';
    const rightCls = c.rightSticky ? ' sticky-col-right' : '';
    const rightAttr = c.rightSticky ? ' data-sticky-right="' + i + '"' : '';
    const finalCls = (cls + rightCls).trim();
    const warn = _fieldWarningsEarly[c.entry.key];
    const warnAttr = warn
      ? ' title="' + warn.replace(/"/g, '&quot;') + '" style="background:rgba(245,158,11,.12)"'
      : '';
    // VCM: add data attributes on numeric/currency/rate cells so click handler can target them (Update a3a423eb)
    const _vcmEligible = c.entry.type === 'currency' || c.entry.type === 'number' || c.entry.type === 'rate';
    const _vcmAttrs = _vcmEligible
      ? ' data-vcm-field="' + c.entry.key + '" data-vcm-rowid="' + row.id + '" data-vcm-mid="' + m.id + '"'
      : '';
    // If this field has a user correction, wrap the value with a star indicator
    const _corr = row._userCorrected && row._userCorrected[c.entry.key];
    const _displayVal = _corr
      ? '<span class="vcm-corrected" title="Corrected from ' +
        _corr.original +
        ' on ' +
        (_corr.at ? _corr.at.slice(0, 10) : '?') +
        '">&#9733; ' +
        formatted +
        '</span>'
      : formatted;
    html += `<td${finalCls ? ' class="' + finalCls + '"' : ''}${rightAttr}${warnAttr}${_vcmAttrs}>${_displayVal}</td>`;
  }
  html += actionBtns + '</tr>';
  return html;
}

function updateBillField(mid, rowId, field, val) {
  if (!udSelProjId || !udSelBldgId) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const m = b?.meters?.find((m) => m.id === mid);
  const row = m?.bills?.find((r) => r.id === rowId);
  if (!row) return;
  row[field] = val;
  if (field === 'start' || field === 'end') {
    let days = calcDays(row.start, row.end, m.inclusive !== false);
    if (days === 0 && row.start && row.start === row.end && m.commodity === 'Propane') days = 1;
    const cells = document.querySelectorAll('.days-cell');
    const rows = m.bills;
    const idx = rows.findIndex((r) => r.id === rowId);
    if (cells[idx]) cells[idx].textContent = days;
  }
  saveUtilityData();
}

/* ── SUBMIT VALUE CORRECTION (Update a3a423eb) ──
   Called from the VCM popover Save button. Overwrites the field value on the
   bill row, stores the original + timestamp on row._userCorrected[field] for
   audit display, logs to the utility audit log, appends to the
   en_value_corrections localStorage key, then saves + re-renders. */
function submitValueCorrection(mid, rowId, field, correctedValue, note) {
  // Remove any lingering VCM keydown handler — Save button doesn't go through _vcmCancelPopover
  if (typeof window._vcmCancelPopover === 'function') window._vcmCancelPopover();
  if (!udSelProjId || !udSelBldgId) return;
  var meter = getUDMeter(udSelProjId, udSelBldgId, mid);
  if (!meter) return;
  var row = meter.bills.find(function (r) {
    return r.id === rowId;
  });
  if (!row) return;
  if (isNaN(correctedValue)) {
    showToast('Please enter a valid number', 'warn');
    return;
  }
  var originalValue = row[field];
  row[field] = correctedValue;
  if (!row._userCorrected) row._userCorrected = {};
  row._userCorrected[field] = { original: originalValue, at: new Date().toISOString() };
  // Audit log entry
  logUtilityAudit(
    Object.assign(
      {
        action: 'correction',
        period: _auditPeriodLabel(row),
        changes: [{ field: field, from: originalValue, to: correctedValue }],
        note: note || '',
        source: 'value_correction_mode',
      },
      _auditCtxFromIds(udSelProjId, udSelBldgId, mid),
    ),
  );
  // Corrections log (separate from main audit log, max 1000 entries)
  var corrections = DB.get('en_value_corrections', []);
  corrections.push({
    ts: new Date().toISOString(),
    projId: udSelProjId,
    bldgId: udSelBldgId,
    meterId: mid,
    billId: rowId,
    field: field,
    originalValue: originalValue,
    correctedValue: correctedValue,
    note: note || '',
  });
  if (corrections.length > 1000) corrections = corrections.slice(-1000);
  DB.set('en_value_corrections', corrections);
  // Close popover, save, re-render
  var pop = document.getElementById('vcm-popover');
  if (pop) pop.remove();
  saveUtilityData();
  renderMeterWorkspace();
}
window.submitValueCorrection = submitValueCorrection;

function setMeterIncl(mid, val) {
  if (!udSelProjId || !udSelBldgId) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const m = b?.meters?.find((m) => m.id === mid);
  if (!m) return;
  m.inclusive = val;
  saveUtilityData();
  renderMeterWorkspace();
}

async function deleteMeter(mid, pid, bid) {
  if (pid) udSelProjId = pid;
  if (bid) udSelBldgId = bid;
  if (!(await confirmAsync('Delete this meter and all its billing data?'))) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (b) b.meters = b.meters.filter((m) => m.id !== mid);
  if (udActiveMid === mid) udActiveMid = null;
  saveUtilityData();
  const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
  renderUDDetail(isEmbed ? window._udActiveWrap : undefined);
  renderUDProjList();
  renderMeterWorkspace();
  setTimeout(renderSidebarFolders, 100);
  showToast('Meter deleted');
}

async function deleteAllBills(mid, pid, bid) {
  if (pid) udSelProjId = pid;
  if (bid) udSelBldgId = bid;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    showToast('Could not find building — try reselecting it', 'error');
    console.error('deleteAllBills: building not found', { pid: udSelProjId, bid: udSelBldgId });
    return;
  }
  const m = b?.meters?.find((m) => m.id === mid);
  if (!m) {
    showToast('Could not find meter — try reselecting it', 'error');
    console.error('deleteAllBills: meter not found', { mid, building: b.name });
    return;
  }
  if (!m.bills || !m.bills.length) {
    showToast('No bills to clear');
    return;
  }
  const count = m.bills.length;
  if (
    !(await confirmAsync(
      'Delete all ' + count + ' billing period' + (count !== 1 ? 's' : '') + ' from this meter? This cannot be undone.',
    ))
  )
    return;
  const _actx = _auditCtxFromIds(udSelProjId, udSelBldgId, mid);
  logUtilityAudit({ action: 'delete_all', ..._actx, note: count + ' bills deleted', source: 'manual' });
  m.bills = [];
  if (m.baseline) m.baseline = {};
  saveUtilityData();
  renderUDProjList();
  const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
  renderUDDetail(isEmbed ? window._udActiveWrap : undefined);
  renderMeterWorkspace();
  showToast(count + ' billing period' + (count !== 1 ? 's' : '') + ' deleted');
}
function toggleMeterDetail(rowId) {
  const el = document.getElementById('meter-detail-' + rowId);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
function toggleChargeDetail(rowId) {
  const el = document.getElementById('charge-detail-' + rowId);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
async function deleteBillRow(mid, rowId) {
  _syncEmbedUDContext();
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const m = b?.meters?.find((m) => m.id === mid);
  if (!m) {
    showToast('Meter not found — re-select the meter and try again', 'warn');
    return;
  }
  const _delRow = m.bills.find((r) => r.id === rowId);
  if (_delRow) {
    const period =
      (_delRow.start || _delRow.BillingPeriodStart || '?') + ' to ' + (_delRow.end || _delRow.BillingPeriodEnd || '?');
    if (!(await confirmAsync('Delete billing period ' + period + '? This cannot be undone.'))) return;
  }
  if (_delRow) {
    const _actx = _auditCtxFromIds(udSelProjId, udSelBldgId, mid);
    logUtilityAudit({
      action: 'delete',
      ..._actx,
      period: _auditPeriodLabel(_delRow),
      source: 'manual',
      note: 'totalCost=' + (_delRow.totalCost || ''),
    });
  }
  m.bills = m.bills.filter((r) => r.id !== rowId);
  saveUtilityData();
  // If the deleted meter-bill was linked to a saved-bill source record, clear its projId
  // so it doesn't become an orphan (invisible to all UI filters and unreachable by any delete path).
  if (_delRow && _delRow.pdfBillId) {
    const _pdfBills = sget('en_pdf_bills', []) || [];
    const _srcRec = _pdfBills.find((b) => b.id === _delRow.pdfBillId);
    if (_srcRec && _srcRec.projId != null) {
      _srcRec.projId = null;
      sset('en_pdf_bills', _pdfBills);
    }
  }
  // Immediately remove the row from the visible table so the UI updates instantly
  const tbody = document.getElementById('billsBodyTbl');
  if (tbody) {
    const rows = tbody.querySelectorAll('tbody tr');
    rows.forEach((tr) => {
      const delBtn = tr.querySelector('.btn-del');
      if (delBtn && delBtn.getAttribute('onclick') && delBtn.getAttribute('onclick').indexOf(rowId) !== -1) {
        tr.style.transition = 'opacity .2s,transform .2s';
        tr.style.opacity = '0';
        tr.style.transform = 'translateX(20px)';
        setTimeout(() => tr.remove(), 200);
      }
    });
  }
  // Update the billing period count in the sticky header
  const stickyTitle = document.querySelector('.bills-sticky-title');
  if (stickyTitle && m.bills) {
    const n = m.bills.length;
    stickyTitle.textContent =
      n +
      ' Billing Period' +
      (n !== 1 ? 's' : '') +
      (n ? ' · ' + getDateRange(m.bills.slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start))) : '');
  }
  // Full re-render after animation. Must target the SAME wrap the row was deleted from —
  // renderUDDetail() with no argument defaults to the hidden standalone #udDetailWrap and
  // overwrites window._udActiveWrap, silently switching the embedded Projects-tab panel's
  // tracked context to the wrong (invisible) wrap. Every subsequent embedded action that
  // resolves context via window._udActiveWrap (_syncEmbedUDContext, isEmbed checks, etc.)
  // then breaks until a manual page refresh. Mirrors the isEmbed pattern already used by
  // the sibling "delete all bills for meter" flow above and by udSelectMeter().
  setTimeout(() => {
    renderUDProjList();
    const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
    renderUDDetail(isEmbed ? window._udActiveWrap : undefined);
  }, 250);
  showToast('Bill period deleted');
}

/* ── BILL SCHEMA (Update 82) ──
               Single source of truth for bill fields per commodity. Used by:
               - openBillModal     → builds the edit form
               - saveBillRow       → writes fields back to the saved row
               - renderBillsPane   → generates the data-table columns
               - renderBillRow     → generates row cells
               Mirrors the PDF/OCR card layout in renderPDFFields._COMMODITY_LAYOUTS
               so the two views show the same sections, same fields, same labels.

               Entry shape:
                 { section: 'Name' }                            // section header
                 { key, label, type, pdfKey, fallbackKey? }     // field
               - key:         camelCase saved-row field name (modal input id = 'bl-' + key)
               - label:       display text for modal label + table column header
               - type:        'text' | 'date' | 'number' | 'currency'
               - pdfKey:      PascalCase extractor field name (optional — used by
                              the PDF ingestion save path field map downstream)
               - fallbackKey: legacy camelCase key to read from when the modern
                              key is empty on an existing saved row (e.g. old
                              bills used `facKWCost` for what's now `facilitiesCharge`)
            */
const BILL_SCHEMA = {
  Electric: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { key: 'meterNumber', label: 'Meter Number', type: 'text', pdfKey: 'MeterNumber' },
    { section: 'Billing Period & Meter' },
    { key: 'start', label: 'Start Date', type: 'date', pdfKey: 'BillingPeriodStart' },
    { key: 'end', label: 'End Date', type: 'date', pdfKey: 'BillingPeriodEnd' },
    { key: 'rateSchedule', label: 'Rate Schedule', type: 'text', pdfKey: 'RateSchedule' },
    { key: 'numberOfDays', label: 'Number of Days', type: 'number', pdfKey: 'NumberOfDays' },
    { key: 'meterReadStart', label: 'Meter Read Start', type: 'text', pdfKey: 'MeterReadStart' },
    { key: 'meterReadEnd', label: 'Meter Read End', type: 'text', pdfKey: 'MeterReadEnd' },
    { key: 'startRead', label: 'Start Read', type: 'number', pdfKey: 'StartRead' },
    { key: 'endRead', label: 'End Read', type: 'number', pdfKey: 'EndRead' },
    { key: 'readDifference', label: 'Read Difference', type: 'number', pdfKey: 'ReadDifference' },
    { key: 'meterMultiplier', label: 'Meter Multiplier', type: 'number', pdfKey: 'MeterMultiplier' },
    { key: 'kwh', label: 'kWh Consumed', type: 'number', pdfKey: 'kWhConsumed' },
    { key: 'onPeakKwh', label: 'On-Peak kWh', type: 'number', pdfKey: 'OnPeakKWh' },
    { key: 'offPeakKwh', label: 'Off-Peak kWh', type: 'number', pdfKey: 'OffPeakKWh' },
    { key: 'demandKW', label: 'Actual kW', type: 'number', pdfKey: 'ActualKW' },
    { key: 'actualRKVA', label: 'Actual RKVA', type: 'number', pdfKey: 'ActualRKVA' },
    { key: 'facKW', label: 'Facilities kW', type: 'number', pdfKey: 'FacilitiesKW' },
    { key: 'billedKW', label: 'Billed kW', type: 'number', pdfKey: 'BilledKW' },
    { key: 'tdcKW', label: 'TDC kW', type: 'number', pdfKey: 'TDCkW' },
    { section: 'Charges' },
    { key: 'customerCharge', label: 'Customer Charge', type: 'currency', pdfKey: 'CustomerCharge' },
    {
      key: 'facilitiesCharge',
      label: 'Facilities Charge',
      type: 'currency',
      pdfKey: 'FacilitiesCharge',
      fallbackKey: 'facKWCost',
    },
    { key: 'demandCharge', label: 'Billed kW Charge', type: 'currency', pdfKey: 'BilledKWCharge' },
    { key: 'onPeakCost', label: 'Energy On-Peak Charge', type: 'currency', pdfKey: 'EnergyOnPeakCharge' },
    { key: 'offPeakCost', label: 'Energy Off-Peak Charge', type: 'currency', pdfKey: 'EnergyOffPeakCharge' },
    { key: 'rkvaCharge', label: 'RkVA Charge', type: 'currency', pdfKey: 'RkVACharge' },
    { key: 'taxExemptDelivery', label: 'Tax Exempt Delivery', type: 'currency', pdfKey: 'TaxExemptDelivery' },
    { key: 'ecaCharge', label: 'ECA Charge', type: 'currency', pdfKey: 'ECACharge' },
    { key: 'eerCharge', label: 'EER Charge', type: 'currency', pdfKey: 'EERCharge' },
    { key: 'ptsCharge', label: 'PTS Charge', type: 'currency', pdfKey: 'PTSCharge' },
    { key: 'tdcCharge', label: 'TDC kW Charge', type: 'currency', pdfKey: 'TDCCharge' },
    { key: 'billOffset', label: 'Bill Offset', type: 'currency', pdfKey: 'BillOffset' },
    { key: 'franchiseFee', label: 'Franchise Fee', type: 'currency', pdfKey: 'FranchiseFee' },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'onPeakRate', label: 'On-Peak $/kWh', type: 'rate5', pdfKey: 'OnPeakRate' },
    { key: 'offPeakRate', label: 'Off-Peak $/kWh', type: 'rate5', pdfKey: 'OffPeakRate' },
    { key: 'totalKwhRate', label: 'Total $/kWh Rate', type: 'rate5', pdfKey: 'TotalKWhRate' },
    { key: 'totalKwRate', label: 'Total $/kW Rate', type: 'rate3', pdfKey: 'TotalKWRate' },
  ],
  Gas: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { section: 'Billing Period' },
    { key: 'start', label: 'Start Date', type: 'date', pdfKey: 'BillingPeriodStart' },
    { key: 'end', label: 'End Date', type: 'date', pdfKey: 'BillingPeriodEnd' },
    { key: 'billDate', label: 'Bill Date', type: 'text', pdfKey: 'BillDate' },
    { key: 'startRead', label: 'Previous Read', type: 'number', pdfKey: 'StartRead' },
    { key: 'endRead', label: 'Current Read', type: 'number', pdfKey: 'EndRead' },
    { key: 'readDifference', label: 'Read Difference', type: 'number', pdfKey: 'ReadDifference' },
    { section: 'Charges' },
    {
      key: 'naturalGasTherms',
      label: 'Gas Usage (Therms)',
      type: 'number',
      pdfKey: 'NaturalGasTherms',
      isUsage: true,
      gasUnit: 'Therms',
    },
    {
      key: 'naturalGasCCF',
      label: 'Gas Usage (CCF)',
      type: 'number',
      pdfKey: 'NaturalGasCCF',
      isUsage: true,
      gasUnit: 'CCF',
    },
    {
      key: 'naturalGasMMbtu',
      label: 'Gas Usage (MMBtu)',
      type: 'number',
      pdfKey: 'NaturalGasMMbtu',
      isUsage: true,
      gasUnit: 'MMBtu',
    },
    { key: 'customerCharge', label: 'Base Charge', type: 'currency', pdfKey: 'CustomerCharge' },
    { key: 'gasCharge', label: 'Gas Charge', type: 'currency', pdfKey: 'GasCharge' },
    { key: 'fuelAdjustment', label: 'Fuel Adjustment', type: 'currency', pdfKey: 'FuelAdjustment' },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'totalGasRate', label: 'Total $/Therm Rate', type: 'rate5' },
  ],
  Water: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { section: 'Billing Period' },
    { key: 'start', label: 'Start Date', type: 'date', pdfKey: 'BillingPeriodStart' },
    { key: 'end', label: 'End Date', type: 'date', pdfKey: 'BillingPeriodEnd' },
    { key: 'billDate', label: 'Bill Date', type: 'text', pdfKey: 'BillDate' },
    { key: 'prevRead', label: 'Previous Read', type: 'number', pdfKey: 'PrevRead' },
    { key: 'curRead', label: 'Current Read', type: 'number', pdfKey: 'CurRead' },
    { key: 'readDiff', label: 'Read Difference', type: 'number', pdfKey: 'ReadDiff' },
    { section: 'Charges' },
    { key: 'waterUsage', label: 'Water Usage (gal)', type: 'number', pdfKey: 'WaterUsage' },
    { key: 'waterCharge', label: 'Water Charge', type: 'currency', pdfKey: 'WaterCharge' },
    {
      key: 'waterProtectionFee',
      label: 'Water Protection Fee',
      type: 'currency',
      pdfKey: 'WaterProtectionFee',
    },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'totalWaterRate', label: 'Total $/Gal Rate', type: 'rate5' },
  ],
  Sewer: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { section: 'Billing Period' },
    { key: 'start', label: 'Start Date', type: 'date', pdfKey: 'BillingPeriodStart' },
    { key: 'end', label: 'End Date', type: 'date', pdfKey: 'BillingPeriodEnd' },
    { key: 'billDate', label: 'Bill Date', type: 'text', pdfKey: 'BillDate' },
    { key: 'prevRead', label: 'Previous Read', type: 'number', pdfKey: 'PrevRead' },
    { key: 'curRead', label: 'Current Read', type: 'number', pdfKey: 'CurRead' },
    { key: 'readDiff', label: 'Read Difference', type: 'number', pdfKey: 'ReadDiff' },
    { section: 'Charges' },
    { key: 'sewerUsage', label: 'Sewer Usage (gal)', type: 'number', pdfKey: 'SewerUsage' },
    { key: 'sewerCharge', label: 'Sewer Charge', type: 'currency', pdfKey: 'SewerCharge' },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'totalSewerRate', label: 'Total $/Gal Rate', type: 'rate5' },
  ],
  Stormwater: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { section: 'Billing Period' },
    { key: 'start', label: 'Start Date', type: 'date', pdfKey: 'BillingPeriodStart' },
    { key: 'end', label: 'End Date', type: 'date', pdfKey: 'BillingPeriodEnd' },
    { key: 'billDate', label: 'Bill Date', type: 'text', pdfKey: 'BillDate' },
    { section: 'Charges' },
    { key: 'stormWaterCharge', label: 'Stormwater Charge', type: 'currency', pdfKey: 'StormWaterCharge' },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'totalStormwaterRate', label: 'Stormwater Charge', type: 'currency' },
  ],
  Propane: [
    { section: 'Account Info' },
    { key: 'utilityCompany', label: 'Utility Company', type: 'text', pdfKey: 'UtilityCompany' },
    { key: 'customerName', label: 'Customer Name', type: 'text', pdfKey: 'CustomerName' },
    { key: 'serviceAddress', label: 'Service Address', type: 'text', pdfKey: 'ServiceAddress' },
    { key: 'accountNumber', label: 'Account Number', type: 'text', pdfKey: 'AccountNumber' },
    { key: 'invoiceNumber', label: 'Invoice Number', type: 'text', pdfKey: 'InvoiceNumber' },
    { key: 'saleNumber', label: 'Sale Number', type: 'text', pdfKey: 'SaleNumber' },
    { section: 'Delivery' },
    { key: 'deliveryDate', label: 'Delivery Date', type: 'date', pdfKey: 'DeliveryDate' },
    { key: 'fuelType', label: 'Fuel Type', type: 'text', pdfKey: 'FuelType' },
    { key: 'gallonsDelivered', label: 'Gallons Delivered', type: 'number', pdfKey: 'GallonsDelivered' },
    { key: 'unitPrice', label: 'Unit Price ($/gal)', type: 'rate5', pdfKey: 'UnitPrice' },
    { section: 'Charges' },
    { key: 'subtotal', label: 'Subtotal', type: 'currency', pdfKey: 'Subtotal' },
    { key: 'tax', label: 'Tax', type: 'currency', pdfKey: 'Tax' },
    { key: 'totalCost', label: 'Total Current Charges', type: 'currency', pdfKey: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { key: 'totalPropaneRate', label: 'Total $/Gal Rate', type: 'rate5' },
  ],
};
// Pick a schema for a meter's commodity. Falls back to a minimal
// generic schema when no specific one exists.
function _billSchemaFor(commodity) {
  return BILL_SCHEMA[commodity] || BILL_SCHEMA._generic || BILL_SCHEMA.Electric;
}
// Helper: read a field value from a row, honoring fallbackKey for
// legacy rows that were saved before the field was renamed.
function _billReadValue(row, entry) {
  if (!row) return '';
  if (entry.key === 'totalKwhRate') {
    const rate = getStoredRate(row, 'kwh');
    if (rate > 0) return rate.toFixed(5);
  }
  if (entry.key === 'totalKwRate') {
    const rate = getStoredRate(row, 'kw');
    if (rate > 0) return rate.toFixed(5);
  }
  if (entry.key === 'totalGasRate') {
    const rate = getStoredRate(row, 'gas');
    if (rate > 0) return rate.toFixed(5);
  }
  const direct = row[entry.key];
  if (direct !== undefined && direct !== null && direct !== '' && direct !== 'null') return direct;
  if (entry.fallbackKey) {
    const legacy = row[entry.fallbackKey];
    if (legacy !== undefined && legacy !== null && legacy !== '' && legacy !== 'null') return legacy;
  }
  return '';
}
// Helper: format a value for table display based on the schema entry.
// IMPORTANT: 0 is valid data. Only null/undefined/''/'null' mean "no data" (show —).
function _billFormatValue(val, entry) {
  const isMissing = val === undefined || val === null || val === '' || val === 'null';
  const hasVal = !isMissing && !isNaN(val);
  if (entry.type === 'currency') {
    if (!hasVal) return '—';
    return '$' + (+val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (entry.type === 'number') {
    if (!hasVal) return isMissing ? '—' : val;
    // Update 94: match renderPDFFields' FOURDP_FIELDS set exactly —
    // every kW/kWh quantity, meter read, read-difference, and meter
    // multiplier renders with 4 decimal places per Evergy Billing
    // Details rules. Without explicit min/maxFractionDigits, the
    // default `.toLocaleString()` caps at 3 digits AND strips trailing
    // zeros, so 54,656.8791 showed as "54,656.879" while 100 showed as
    // "100" — same place-value intent, inconsistent rendered width.
    const FOURDP_PDF_KEYS = new Set([
      'FacilitiesKW',
      'BilledKW',
      'ActualKW',
      'ActualRKVA',
      'TDCkW',
      'StartRead',
      'EndRead',
      'ReadDifference',
      'MeterMultiplier',
      'kWhConsumed',
      'OnPeakKWh',
      'OffPeakKWh',
    ]);
    if (
      FOURDP_PDF_KEYS.has(entry.pdfKey) ||
      /kwh/i.test(entry.key) ||
      /kw$/i.test(entry.key) ||
      /rkva/i.test(entry.key) ||
      /read$|multiplier|difference/i.test(entry.key)
    ) {
      // Bug #18: Read Difference must always display positive (current - previous read)
      const dispVal = /difference/i.test(entry.key) ? Math.abs(+val) : +val;
      return dispVal.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    }
    // Default numeric fields (e.g. numberOfDays) — integer display.
    return (+val).toLocaleString('en-US');
  }
  if (entry.type === 'rate5') {
    if (!hasVal) return '—';
    return '$' + (+val).toFixed(5);
  }
  if (entry.type === 'rate3') {
    if (!hasVal) return '—';
    return '$' + (+val).toFixed(3);
  }
  if (entry.type === 'date') return val ? fmtDate(val) : '—';
  return isMissing ? '—' : val;
}
// Helper: default column width for a schema entry based on type/key.
function _billColumnWidth(entry) {
  if (entry.type === 'currency') return 100;
  // Date columns must fit MM/DD/YYYY — 105px at 12px tabular font.
  if (entry.type === 'date') return 105;
  if (entry.type === 'text') {
    if (/address|name|company/i.test(entry.key)) return 160;
    if (entry.key === 'rateSchedule') return 100;
    return 120;
  }
  if (entry.type === 'number') {
    if (/kwh/i.test(entry.key)) return 110;
    if (/kw$/i.test(entry.key) || /rkva/i.test(entry.key)) return 95;
    return 95;
  }
  if (entry.type === 'rate5') return 100;
  if (entry.type === 'rate3') return 85;
  return 95;
}

/* ── BILL MODAL LAYOUTS (Update 83) ──
               Mirrors renderPDFFields._COMMODITY_LAYOUTS so the Edit Billing Period
               modal renders identically to the PDF/OCR Extracted Output card:
               section headers, wide/pair rows for metadata, and 3-column charge-line
               rows (qty | rate | charge) with running totals and a total check row.
               Duplicated (not imported) to avoid hoisting renderPDFFields internals
               to module scope — keep BILL_MODAL_LAYOUTS[x] and _LAYOUT_X in sync.
               `unit` drives the rate decimal-places (kWh=5dp, kW/RkVA=3dp).
            */
const BILL_MODAL_LAYOUTS = {
  electric: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'MeterNumber'] },
    { section: 'Billing Period & Meter' },
    { type: 'pair', fields: ['RateSchedule', 'NumberOfDays'] },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['MeterReadStart', 'MeterReadEnd'] },
    { type: 'pair', fields: ['StartRead', 'EndRead'] },
    { type: 'pair', fields: ['ReadDifference', 'MeterMultiplier'] },
    { type: 'pair', fields: ['kWhConsumed', 'ActualRKVA'] },
    { section: 'Charges' },
    { type: 'charge-line-with-kw', label: 'Customer', chargeField: 'CustomerCharge', kwField: 'ActualKW' },
    {
      type: 'charge-line',
      label: 'Facilities',
      chargeField: 'FacilitiesCharge',
      qtyField: 'FacilitiesKW',
      unit: 'kW',
    },
    { type: 'charge-line', label: 'Billed', chargeField: 'BilledKWCharge', qtyField: 'BilledKW', unit: 'kW' },
    {
      type: 'charge-line',
      label: 'Energy On-Peak',
      chargeField: 'EnergyOnPeakCharge',
      qtyField: 'OnPeakKWh',
      unit: 'kWh',
    },
    {
      type: 'charge-line',
      label: 'Energy Off-Peak',
      chargeField: 'EnergyOffPeakCharge',
      qtyField: 'OffPeakKWh',
      unit: 'kWh',
    },
    { type: 'charge-line', label: 'RkVA', chargeField: 'RkVACharge', qtyField: 'ActualRKVA', unit: 'RkVA' },
    { type: 'charge-line', label: 'Tax Exempt', chargeField: 'TaxExemptDelivery' },
    { type: 'charge-line', label: 'ECA', chargeField: 'ECACharge', qtyField: 'kWhConsumed', unit: 'kWh' },
    { type: 'charge-line', label: 'EER', chargeField: 'EERCharge', qtyField: 'kWhConsumed', unit: 'kWh' },
    { type: 'charge-line', label: 'PTS', chargeField: 'PTSCharge', qtyField: 'kWhConsumed', unit: 'kWh' },
    { type: 'charge-line', label: 'TDC', chargeField: 'TDCCharge', qtyField: 'TDCkW', unit: 'kW' },
    { type: 'charge-line', label: 'Bill Offset', chargeField: 'BillOffset' },
    { type: 'charge-line', label: 'Franchise Fee', chargeField: 'FranchiseFee' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
    { section: 'Rates' },
    { type: 'pair', fields: ['TotalKWhRate', 'TotalKWRate'] },
  ],
  gas: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate'] },
    { type: 'pair', fields: ['StartRead', 'EndRead'] },
    { type: 'pair', fields: ['ReadDifference'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Base', chargeField: 'CustomerCharge' },
    { type: 'charge-line', label: 'Gas', chargeField: 'GasCharge', qtyField: 'NaturalGasCCF', unit: 'CCF' },
    { type: 'charge-line', label: 'Fuel Adjustment', chargeField: 'FuelAdjustment' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
  ],
  water: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate'] },
    { type: 'pair', fields: ['PrevRead', 'CurRead'] },
    { type: 'pair', fields: ['ReadDiff'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Water', chargeField: 'WaterCharge', qtyField: 'WaterUsage', unit: 'gal' },
    { type: 'charge-line', label: 'Water Protection Fee', chargeField: 'WaterProtectionFee' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
  ],
  sewer: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate'] },
    { type: 'pair', fields: ['PrevRead', 'CurRead'] },
    { type: 'pair', fields: ['ReadDiff'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Sewer', chargeField: 'SewerCharge', qtyField: 'SewerUsage', unit: 'gal' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
  ],
  stormwater: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { section: 'Billing Period' },
    { type: 'pair', fields: ['BillingPeriodStart', 'BillingPeriodEnd'] },
    { type: 'pair', fields: ['BillDate'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Stormwater', chargeField: 'StormWaterCharge' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
  ],
  propane: [
    { section: 'Account Info' },
    { type: 'wide', fields: ['UtilityCompany'] },
    { type: 'wide', fields: ['CustomerName'] },
    { type: 'wide', fields: ['ServiceAddress'] },
    { type: 'pair', fields: ['AccountNumber', 'Commodity'] },
    { type: 'pair', fields: ['InvoiceNumber', 'SaleNumber'] },
    { section: 'Delivery' },
    { type: 'pair', fields: ['DeliveryDate', 'FuelType'] },
    { section: 'Charges' },
    { type: 'charge-line', label: 'Propane', chargeField: 'Subtotal', qtyField: 'GallonsDelivered', unit: 'gal' },
    { type: 'charge-line', label: 'Tax', chargeField: 'Tax' },
    { type: 'total', chargeField: 'TotalCurrentCharges' },
  ],
};
// Build PascalCase (extractor/pdfKey) → camelCase (saved-row key) resolver
// from BILL_SCHEMA. Used by openBillModal + saveBillRow to translate
// layout field references to the right input id and row property.
const _PDF_TO_KEY = (function () {
  const m = {};
  for (const commSchema of Object.values(BILL_SCHEMA)) {
    for (const e of commSchema) {
      if (e.pdfKey && e.key && !m[e.pdfKey]) m[e.pdfKey] = e.key;
    }
  }
  return m;
})();
function _billStripCurrency(v) {
  return (v == null ? '' : String(v)).replace(/[$,\s]/g, '');
}
function _billFmtCurrency(v) {
  const n = parseFloat(_billStripCurrency(v));
  if (isNaN(n)) return '';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _billFmtNumber(v) {
  const n = parseFloat(_billStripCurrency(v));
  if (isNaN(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function _billModalFocus(el) {
  el.value = _billStripCurrency(el.value);
  el.select();
}
function _billModalBlur(el, isCurrency) {
  el.value = isCurrency ? _billFmtCurrency(el.value) : _billFmtNumber(el.value);
}
// Recompute one charge-line's rate from qty + charge, then refresh all
// running totals + total-match indicator. Called on every input change.
function _billRecalcRow(chargeKey) {
  const rowEl = document.querySelector('.ef-charge-row[data-charge-key="' + chargeKey + '"]');
  if (rowEl) {
    const dp = +(rowEl.getAttribute('data-rate-dp') || 3);
    const unit = rowEl.getAttribute('data-unit') || '';
    const qtyInp = rowEl.querySelector('.bl-qty-input');
    const chargeInp = rowEl.querySelector('.bl-charge-input');
    const rateInp = rowEl.querySelector('.bl-rate-input');
    const qty = qtyInp ? parseFloat(_billStripCurrency(qtyInp.value)) || 0 : 0;
    const charge = chargeInp ? parseFloat(_billStripCurrency(chargeInp.value)) || 0 : 0;
    if (rateInp) {
      if (qty > 0 && charge !== 0) rateInp.value = '$' + (charge / qty).toFixed(dp) + (unit ? '/' + unit : '');
      else rateInp.value = '';
    }
  }
  _billRecalcRunningTotals();
}
function _billRecalcRunningTotals() {
  const rows = document.querySelectorAll('.ef-charge-row[data-charge-key]');
  let running = 0;
  let enteredTotal = 0;
  rows.forEach((r) => {
    const ck = r.getAttribute('data-charge-key');
    const chargeInp = r.querySelector('.bl-charge-input');
    const val = chargeInp ? parseFloat(_billStripCurrency(chargeInp.value)) || 0 : 0;
    if (ck === 'TotalCurrentCharges') {
      enteredTotal = val;
      return;
    }
    running += val;
    const rtEl = r.querySelector('.ef-running');
    if (rtEl)
      rtEl.textContent = '$' + running.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
  // Update the total row's running total + match/mismatch class
  const totalRowEl = document.querySelector('.ef-charge-row[data-charge-key="TotalCurrentCharges"]');
  if (totalRowEl) {
    const rtEl = totalRowEl.querySelector('.ef-running');
    if (rtEl) {
      const match = enteredTotal > 0 && Math.abs(enteredTotal - running) < 0.02;
      const mismatch = enteredTotal > 0 && !match;
      rtEl.textContent =
        '$' +
        running.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        (match ? ' ✓' : mismatch ? ' ✗' : '');
      rtEl.classList.toggle('match', match);
      rtEl.classList.toggle('mismatch', mismatch);
    }
  }
}

/* ── BILL MODAL (single period add/edit, Update 83) ──
               Walks BILL_MODAL_LAYOUTS[commodity] — same structure as the PDF/OCR
               extracted-output card — so the modal matches the card by construction:
               sections, wide/pair rows, 3-column charge-line rows (qty | rate | charge),
               running totals, total-match check. Rate auto-computes on qty/charge edit.
            */
function showBillSplitPanel(mid, billId, evt) {
  if (evt && (evt.target.closest('button') || evt.target.closest('select') || evt.target.closest('input'))) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters?.find((mt) => mt.id === mid);
  if (!m) return;
  const row = m.bills?.find((r) => r.id === billId);
  if (!row) return;
  const schema = _billSchemaFor(m.commodity).filter((e) => !e.section);
  const _wrap = window._udActiveWrap || document.getElementById('udDetailWrap');
  const pane = _wrap
    ? _wrap.querySelector('#udMeterWorkspace, #maMeterWorkspace, [id*="MeterWorkspace"]')
    : document.getElementById('udMeterWorkspace');
  if (!pane) return;

  const pdfAvail = (row.hasPDF || row.pdfKey) && (row.pdfBillId || row.pdfKey);
  const pdfLookupId = row.pdfBillId || row.id || '';
  const period = (row.start ? fmtDate(row.start) : '?') + ' → ' + (row.end ? fmtDate(row.end) : '?');

  let formHtml = '<div style="display:flex;flex-direction:column;gap:8px">';
  let curSection = '';
  for (const e of _billSchemaFor(m.commodity)) {
    if (e.section) {
      if (curSection) formHtml += '</div>';
      formHtml += `<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-top:8px;border-bottom:1px solid var(--border);padding-bottom:4px">${e.section}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px">`;
      curSection = e.section;
      continue;
    }
    const rawVal = _billReadValue(row, e);
    const dispVal = rawVal != null && rawVal !== '' ? String(rawVal) : '';
    const inputId = 'bsp-' + e.key;
    formHtml += `<label style="display:flex;flex-direction:column;gap:2px">
            <span style="font-size:10px;color:var(--text2)">${e.label}</span>
            <input class="fi" id="${inputId}" type="text" value="${dispVal.replace(/"/g, '&quot;')}" style="font-size:12px;padding:4px 6px;font-family:var(--mono)">
          </label>`;
  }
  if (curSection) formHtml += '</div>';
  formHtml += '</div>';

  const splitHtml = `
          <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);margin-bottom:10px">
            <button class="btn btn-ghost btn-sm" onclick="renderMeterWorkspace()">← Back to Bills</button>
            <span style="font-size:13px;font-weight:700">${m.commodity || 'Meter'} · ${period}</span>
          </div>
          <div style="display:flex;gap:16px;min-height:500px">
            <div style="flex:1;overflow-y:auto;padding-right:12px;border-right:1px solid var(--border)">
              <div style="font-size:12px;font-weight:700;color:var(--em);margin-bottom:8px">Bill Data</div>
              ${formHtml}
              <div style="display:flex;gap:8px;margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">
                <button class="btn btn-em btn-sm" onclick="saveBillSplitPanel('${mid}','${billId}')">Save Changes</button>
                <button class="btn btn-ghost btn-sm" onclick="renderMeterWorkspace()">Cancel</button>
                <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red);border-color:var(--red)" onclick="deleteBillRow('${mid}','${billId}')">Delete</button>
              </div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;min-width:0">
              <div style="font-size:12px;font-weight:700;color:var(--em);margin-bottom:8px">Source PDF</div>
              ${
                pdfAvail
                  ? `<div id="bsp-pdf-frame" style="flex:1;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:#111;min-height:400px"><div style="padding:20px;color:var(--text3);text-align:center">Loading PDF...</div></div>`
                  : `<div style="flex:1;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:6px;background:var(--s2);color:var(--text3);font-size:13px">No source PDF available for this bill</div>`
              }
            </div>
          </div>`;
  pane.innerHTML = splitHtml;

  if (pdfAvail) {
    setTimeout(() => {
      const frame = document.getElementById('bsp-pdf-frame');
      if (!frame) return;
      _loadPdfIntoFrame(frame, pdfLookupId, row.pdfPageStart, row.pdfPageEnd, row.pdfKey);
    }, 100);
  }
}

function saveBillSplitPanel(mid, billId) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters?.find((mt) => mt.id === mid);
  if (!m) return;
  const row = m.bills?.find((r) => r.id === billId);
  if (!row) return;
  const schema = _billSchemaFor(m.commodity).filter((e) => !e.section);
  for (const e of schema) {
    const el = document.getElementById('bsp-' + e.key);
    if (!el) continue;
    const val = el.value.trim();
    row[e.key] = val;
  }
  saveUtilityData();
  showToast('Bill saved ✓');
  renderMeterWorkspace();
}

function _loadPdfIntoFrame(frame, pdfId, pageStart, pageEnd, pdfKey) {
  const key = pdfKey || 'en_pdf_file_' + pdfId;
  pdfLoad(key)
    .then((data) => {
      if (!data) {
        frame.innerHTML =
          '<div style="padding:20px;color:var(--text3);text-align:center">PDF data not found in storage</div>';
        return;
      }
      const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const pageParam = pageStart ? '#page=' + pageStart : '';
      frame.innerHTML = `<iframe src="${url}${pageParam}" style="width:100%;height:100%;border:none"></iframe>`;
    })
    .catch(() => {
      frame.innerHTML = '<div style="padding:20px;color:var(--text3);text-align:center">Could not load PDF</div>';
    });
}

function openBillModal(mid, editRowId) {
  udSelMeterId = mid;
  udBillEditId = editRowId || null;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    showToast('Could not find building — try reselecting it', 'error');
    return;
  }
  const m = b?.meters?.find((m) => m.id === mid);
  if (!m) {
    showToast('Could not find meter — try reselecting it', 'error');
    return;
  }
  const row = editRowId ? m.bills.find((r) => r.id === editRowId) : null;
  // When adding a new bill (row is null), pre-populate Account Info fields
  // from the meter's existing bills using consensus (most common value).
  const _acctDefaults = {};
  if (!row && m.bills && m.bills.length > 0) {
    const ACCT_KEYS = ['utilityCompany', 'customerName', 'serviceAddress', 'accountNumber', 'commodity'];
    for (const key of ACCT_KEYS) {
      const counts = {};
      for (const bill of m.bills) {
        const val = bill[key] || '';
        if (val) {
          counts[val] = (counts[val] || 0) + 1;
        }
      }
      // Pick the value with the highest count
      let best = '',
        bestCount = 0;
      for (const [val, count] of Object.entries(counts)) {
        if (count > bestCount) {
          best = val;
          bestCount = count;
        }
      }
      if (best) _acctDefaults[key] = best;
    }
  }
  document.getElementById('billModalTitle').textContent = row
    ? '✏️ Edit Billing Period'
    : '+ Add Billing Period — ' + meterLabel(m);
  const commKey = (m.commodity || 'Electric').toLowerCase();
  let layout = BILL_MODAL_LAYOUTS[commKey] || BILL_MODAL_LAYOUTS.electric;
  if (commKey === 'gas') {
    // KGS bills use Mcf (not CCF) — detect by meter's utility company name.
    // Falls through to generic gas layout but swaps qty unit CCF→Mcf, consistent
    // with the useTherms swap below.
    const isKGS = /kansas\s*gas/i.test(m.utilityCompany || '');
    if (isKGS) {
      // KGS Edit modal: replace CCF qty with McfBilled at Mcf unit so rate shows $/Mcf
      layout = layout.map((r) => (r.qtyField === 'NaturalGasCCF' ? { ...r, qtyField: 'McfBilled', unit: 'Mcf' } : r));
    } else {
      const meterUnit = getMeterBillUnit(m);
      const useTherms =
        meterUnit === 'Therms' || (meterUnit !== 'CCF' && row && (row.naturalGasTherms || row.NaturalGasTherms));
      layout = layout.map((r) =>
        r.qtyField === 'NaturalGasCCF' && useTherms ? { ...r, qtyField: 'NaturalGasTherms', unit: 'Therms' } : r,
      );
    }
  }
  const schemaEntry = (pdfKey) => {
    const schema = _billSchemaFor(m.commodity);
    return (
      schema.find((e) => e.pdfKey === pdfKey) || {
        label: pdfKey,
        type: 'text',
        key: _PDF_TO_KEY[pdfKey] || pdfKey.charAt(0).toLowerCase() + pdfKey.slice(1),
      }
    );
  };
  const escapeAttr = (v) => (v === undefined || v === null ? '' : String(v).replace(/"/g, '&quot;'));
  const readVal = (pdfKey) => {
    const entry = schemaEntry(pdfKey);
    const val = _billReadValue(row, entry);
    // If no row (new bill) and field is empty, check account defaults
    if (!row && !val && _acctDefaults[entry.key]) return _acctDefaults[entry.key];
    return val;
  };
  // Build a single labeled input cell (used by wide + pair rows)
  const inputCell = (pdfKey) => {
    const e = schemaEntry(pdfKey);
    const rawVal = readVal(pdfKey);
    const id = 'bl-' + e.key;
    const required = '';
    let inputType = 'text';
    let step = '';
    let ph = '';
    let extraAttr = '';
    let displayVal = escapeAttr(rawVal);
    if (e.type === 'date') inputType = 'date';
    else if (e.type === 'number') {
      inputType = 'text';
      extraAttr = ' inputmode="decimal"';
      ph = '0';
      displayVal = escapeAttr(rawVal != null && rawVal !== '' ? _billFmtNumber(rawVal) : '');
      extraAttr += ` onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,false)"`;
    } else if (e.type === 'currency') {
      inputType = 'text';
      extraAttr = ' inputmode="decimal"';
      ph = '$0.00';
      displayVal = escapeAttr(rawVal != null && rawVal !== '' ? _billFmtCurrency(rawVal) : '');
      extraAttr += ` onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,true)"`;
    }
    return `<div class="ef-item"><div class="ef-key">${e.label}${required}</div><input class="ef-input" id="${id}" type="${inputType}"${step} placeholder="${ph}" value="${displayVal}"${extraAttr}></div>`;
  };
  // Build a 3-column charge-line row: qty | rate | charge | running
  const buildChargeLine = (r) => {
    const chargeEntry = schemaEntry(r.chargeField);
    const chargeId = 'bl-' + chargeEntry.key;
    const chargeRaw = readVal(r.chargeField);
    const chargeVal = escapeAttr(chargeRaw != null && chargeRaw !== '' ? _billFmtCurrency(chargeRaw) : '');
    const unit = r.unit || '';
    const dp = /kwh|therms|ccf/i.test(unit) ? 5 : 3;
    const recalc = `onchange="_billRecalcRow('${r.chargeField}')" oninput="_billRecalcRow('${r.chargeField}')"`;
    let qtyHtml;
    if (r.qtyField) {
      const qtyEntry = schemaEntry(r.qtyField);
      const qtyId = 'bl-' + qtyEntry.key;
      const qtyRaw = readVal(r.qtyField);
      const qtyVal = escapeAttr(qtyRaw != null && qtyRaw !== '' ? _billFmtNumber(qtyRaw) : '');
      const qtyLabel = r.label + (unit ? ' ' + unit : '');
      qtyHtml = `<div class="ef-item"><div class="ef-key">${qtyLabel}</div><input class="ef-input bl-qty-input" id="${qtyId}" type="text" inputmode="decimal" placeholder="0" value="${qtyVal}" ${recalc} onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,false)"></div>`;
    } else {
      qtyHtml =
        '<div class="ef-item" style="opacity:.5"><div class="ef-key">—</div><input class="ef-input" disabled placeholder="—"></div>';
    }
    const rateLabel = r.label + (unit ? ' ' + unit : '') + ' Rate';
    const rateHtml = `<div class="ef-item"><div class="ef-key">${rateLabel}</div><input class="ef-input bl-rate-input" readonly tabindex="-1" style="color:var(--text2);font-size:11px" value=""></div>`;
    const chargeLabel = r.label + ' Charge';
    const chargeHtml = `<div class="ef-item center"><div class="ef-key">${chargeLabel}</div><input class="ef-input bl-charge-input" id="${chargeId}" type="text" inputmode="decimal" placeholder="$0.00" value="${chargeVal}" ${recalc} onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,true)"></div>`;
    return `<div class="ef-charge-row" data-charge-key="${r.chargeField}" data-unit="${unit}" data-rate-dp="${dp}">${qtyHtml}${rateHtml}${chargeHtml}<div class="ef-running">$0.00</div></div>`;
  };
  // Build charge-line-with-kw: kW cell | blank | charge | running
  const buildChargeLineWithKW = (r) => {
    const chargeEntry = schemaEntry(r.chargeField);
    const chargeId = 'bl-' + chargeEntry.key;
    const chargeRaw = readVal(r.chargeField);
    const chargeVal = escapeAttr(chargeRaw != null && chargeRaw !== '' ? _billFmtCurrency(chargeRaw) : '');
    const recalc = `onchange="_billRecalcRow('${r.chargeField}')" oninput="_billRecalcRow('${r.chargeField}')"`;
    let kwHtml;
    if (r.kwField) {
      const kwEntry = schemaEntry(r.kwField);
      const kwId = 'bl-' + kwEntry.key;
      const kwRaw = readVal(r.kwField);
      const kwVal = escapeAttr(kwRaw != null && kwRaw !== '' ? _billFmtNumber(kwRaw) : '');
      kwHtml = `<div class="ef-item"><div class="ef-key">${kwEntry.label}</div><input class="ef-input" id="${kwId}" type="text" inputmode="decimal" placeholder="0" value="${kwVal}" onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,false)"></div>`;
    } else {
      kwHtml = '<div></div>';
    }
    const chargeLabel = r.label + ' Charge';
    const chargeHtml = `<div class="ef-item center"><div class="ef-key">${chargeLabel}</div><input class="ef-input bl-charge-input" id="${chargeId}" type="text" inputmode="decimal" placeholder="$0.00" value="${chargeVal}" ${recalc} onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,true)"></div>`;
    return `<div class="ef-charge-row" data-charge-key="${r.chargeField}"><div>${kwHtml}</div><div></div>${chargeHtml}<div class="ef-running">$0.00</div></div>`;
  };
  // Build total row
  const buildTotalRow = (r) => {
    const chargeEntry = schemaEntry(r.chargeField);
    const chargeId = 'bl-' + chargeEntry.key;
    const chargeRaw = readVal(r.chargeField);
    const chargeVal = escapeAttr(chargeRaw != null && chargeRaw !== '' ? _billFmtCurrency(chargeRaw) : '');
    // When the user types in the Total field directly, mark it as manually edited
    // so auto-calculation stops overriding their value.
    const recalc = `onchange="_billRecalcRow('${r.chargeField}')" oninput="_billTotalManualEdit(this);_billRecalcRow('${r.chargeField}')"`;
    // If there's already a value loaded (editing existing bill), mark as manual so we don't overwrite
    const manualAttr = chargeRaw != null && chargeRaw !== '' ? ' data-manual-total="1"' : '';
    return `<div style="border-top:2px solid var(--border);margin-top:4px;padding-top:4px"><div class="ef-charge-row" data-charge-key="${r.chargeField}"${manualAttr}><div></div><div></div><div class="ef-item center"><div class="ef-key" style="font-weight:700">Total Current Charges</div><input class="ef-input bl-charge-input" id="${chargeId}" type="text" inputmode="decimal" placeholder="$0.00" value="${chargeVal}" ${recalc} style="font-weight:700;font-size:14px;text-align:center" onfocus="_billModalFocus(this)" onblur="_billModalBlur(this,true)"></div><div class="ef-running" style="font-weight:700">$0.00</div></div></div>`;
  };
  // Assemble the body
  let body = '';
  if (row) {
    const bldgs = getUDBldgs(udSelProjId);
    let moveOpts = '';
    bldgs.forEach((bl) => {
      (bl.meters || []).forEach((mt) => {
        if (mt.id === mid) return;
        const label = (bl.name || 'Building') + ' — ' + (mt.name || mt.commodity || 'Meter');
        moveOpts += '<option value="' + bl.id + '|' + mt.id + '">' + label + '</option>';
      });
    });
    if (moveOpts) {
      body +=
        '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:16px;background:var(--s1)"><div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Move to Different Meter</div><select class="fs" id="bl-move-meter" style="width:100%"><option value="">— Keep on current meter —</option>' +
        moveOpts +
        '</select></div>';
    }
  }
  for (const r of layout) {
    if (r.section) {
      body += `<div class="ef-section">${r.section}</div>`;
    } else if (r.type === 'wide') {
      body += inputCell(r.fields[0]);
    } else if (r.type === 'pair') {
      body += `<div class="ef-pair">${r.fields.map(inputCell).join('')}</div>`;
    } else if (r.type === 'charge-line') {
      body += buildChargeLine(r);
    } else if (r.type === 'charge-line-with-kw') {
      body += buildChargeLineWithKW(r);
    } else if (r.type === 'total') {
      body += buildTotalRow(r);
    }
  }
  // Auto-sum button (Electric only) — reads same input ids, unchanged
  if (commKey === 'electric') {
    body += `<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-ghost btn-sm" type="button" onclick="billAutoSum()" title="Sum individual line items into Total">Σ Auto-Sum</button></div>`;
  }
  // Legacy hidden inputs — preserve old aggregate fields on existing rows
  const LEGACY_PASSTHROUGH = [
    'kwCost',
    'facKWCost',
    'kwhCost',
    'otherCost',
    'taxCost',
    'renewableCharge',
    'solarCredit',
    'therms',
    'thermCost',
    'usage',
    'cost',
  ];
  for (const k of LEGACY_PASSTHROUGH) {
    const v = row && row[k] != null ? String(row[k]).replace(/"/g, '&quot;') : '';
    body += `<input type="hidden" id="bl-${k}" value="${v}">`;
  }
  document.getElementById('billModalBody').innerHTML = body;
  // Auto-populate End Date when Start Date changes (only if End Date is empty)
  const _blStartInp = document.getElementById('bl-start');
  const _blEndInp = document.getElementById('bl-end');
  if (_blStartInp && _blEndInp) {
    _blStartInp.addEventListener('change', function () {
      // Don't overwrite a user-set value, but DO overwrite a bad auto-filled
      // value (e.g. year 0002 produced by partial keyboard entry on date inputs).
      if (_blEndInp.value) {
        const endParts = _blEndInp.value.split('-');
        const endYr = endParts.length === 3 ? +endParts[0] : 0;
        if (endYr >= 2000 && endYr <= 2100) return; // valid year — treat as user-set
        // Bad year (e.g. 0002) — fall through and overwrite with correct value
      }
      if (!_blStartInp.value) return;
      const parts = _blStartInp.value.split('-');
      if (parts.length !== 3) return;
      const yr = +parts[0],
        mo = +parts[1],
        da = +parts[2];
      // Sanity-check the year: browser date pickers can produce year values
      // like "0002" if the user types a small number, which causes new Date()
      // to create a year-2 or year-1902 date and the output to show 0002 or 1902.
      if (!yr || yr < 2000 || yr > 2100 || !mo || !da) return;
      const d = new Date(yr, mo - 1, da); // local date — no UTC shift
      if (isNaN(d.getTime())) return;
      d.setDate(d.getDate() + 30); // add 30 days via setDate (handles month rollover correctly)
      _blEndInp.value =
        d.getFullYear().toString().padStart(4, '0') +
        '-' +
        (d.getMonth() + 1).toString().padStart(2, '0') +
        '-' +
        d.getDate().toString().padStart(2, '0');
    });
  }
  // Gas-only: auto-subtract Customer Charge hint on Gas Charge input.
  // When the user enters a Gas Charge larger than the Base Charge, a
  // small button appears offering to subtract the Base Charge and save
  // the net gas-only amount -- avoiding manual arithmetic when the user
  // types the full bill total into the Gas Charge field.
  if (commKey === 'gas') {
    const _blGasInp = document.getElementById('bl-gasCharge');
    const _blCustInp = document.getElementById('bl-customerCharge');
    if (_blGasInp) {
      function _gasSubtractHint() {
        const existing = document.getElementById('bl-gasCharge-hint');
        if (existing) existing.remove();
        const gasVal = parseFloat(_billStripCurrency(_blGasInp.value)) || 0;
        const custVal = _blCustInp ? parseFloat(_billStripCurrency(_blCustInp.value)) || 0 : 0;
        // Bug 4f27fc5d: hide hint when Base Charge field already has a value.
        // The hint should only appear when Gas Charge exists AND Base Charge is
        // empty/zero — i.e. suggesting the base charge may be bundled into the gas
        // total. When Base Charge is already filled, the fields are correctly
        // separated and the hint is misleading.
        if (custVal > 0 || gasVal <= 0) return;
      }
      window._gasApplySubtract = function () {
        const gasVal = parseFloat(_billStripCurrency(_blGasInp.value)) || 0;
        const custVal = _blCustInp ? parseFloat(_billStripCurrency(_blCustInp.value)) || 0 : 0;
        if (custVal <= 0 || gasVal <= custVal) return;
        const net = gasVal - custVal;
        _blGasInp.value = _billFmtCurrency(net.toFixed(2));
        const hint = document.getElementById('bl-gasCharge-hint');
        if (hint) hint.remove();
        _billRecalcRow('GasCharge');
        showToast('Gas Charge adjusted to $' + net.toFixed(2) + ' (Base Charge subtracted)');
      };
      _blGasInp.addEventListener('change', _gasSubtractHint);
      _blGasInp.addEventListener('blur', _gasSubtractHint);
    }
  }
  // Read field auto-calc: when Previous Read and Current Read are both filled,
  // auto-compute Read Difference = Current Read - Previous Read (issue 77876060).
  // Works for Gas (startRead/endRead/readDifference) and Water/Sewer (prevRead/curRead/readDiff).
  (function _wireReadAutocalc() {
    // Gas uses startRead/endRead/readDifference; Water/Sewer use prevRead/curRead/readDiff
    const _prevInp = document.getElementById('bl-startRead') || document.getElementById('bl-prevRead');
    const _curInp = document.getElementById('bl-endRead') || document.getElementById('bl-curRead');
    const _diffInp = document.getElementById('bl-readDifference') || document.getElementById('bl-readDiff');
    if (!_prevInp || !_curInp || !_diffInp) return;
    function _autoCalcReadDiff() {
      const prev = parseFloat(_billStripCurrency(_prevInp.value));
      const cur = parseFloat(_billStripCurrency(_curInp.value));
      if (!isNaN(prev) && !isNaN(cur)) {
        let diff = cur - prev;
        // Meter rollover detection (Feature 0de6c188): when cur < prev and prev is
        // near an odometer boundary, compute the wrap-around usage instead of a
        // negative difference. Show a toast so the user knows what happened.
        if (diff < 0 && prev > 0 && cur >= 0) {
          const _rvBounds = [99999, 999999, 9999999];
          for (const _rvB of _rvBounds) {
            if (prev > _rvB * 0.9 && cur < _rvB * 0.1) {
              diff = _rvB + 1 - prev + cur;
              showToast(
                'Meter rollover detected — Read Difference = ' +
                  diff.toFixed(4) +
                  ' (wrap-around at ' +
                  _rvB.toLocaleString() +
                  ')',
              );
              break;
            }
          }
        }
        _diffInp.value = _billFmtNumber(diff.toString());
      }
    }
    _prevInp.addEventListener('change', _autoCalcReadDiff);
    _prevInp.addEventListener('blur', _autoCalcReadDiff);
    _curInp.addEventListener('change', _autoCalcReadDiff);
    _curInp.addEventListener('blur', _autoCalcReadDiff);
  })();
  // Initial pass: compute rates + running totals from loaded values
  for (const r of layout) {
    if (r.chargeField) _billRecalcRow(r.chargeField);
  }
  // Bug b777c198: Gas — compute Fuel Adjustment Rate = FuelAdjustment / Gas Usage (CCF or Therms).
  // The FuelAdjustment row has no qtyField so _billRecalcRow leaves its rate blank.
  // Derive the rate here using the gas usage qty from the GasCharge row.
  if (commKey === 'gas') {
    (function _calcFuelAdjRate() {
      const faRow = document.querySelector('.ef-charge-row[data-charge-key="FuelAdjustment"]');
      if (!faRow) return;
      const faChargeInp = faRow.querySelector('.bl-charge-input');
      const faRateInp = faRow.querySelector('.bl-rate-input');
      if (!faRateInp) return;
      const faCharge = faChargeInp ? Math.abs(parseFloat(_billStripCurrency(faChargeInp.value)) || 0) : 0;
      // Gas usage qty comes from GasCharge row (CCF or Therms)
      const gasRow = document.querySelector('.ef-charge-row[data-charge-key="GasCharge"]');
      const gasUnit = gasRow ? gasRow.getAttribute('data-unit') || 'CCF' : 'CCF';
      const gasQtyInp = gasRow ? gasRow.querySelector('.bl-qty-input') : null;
      const gasQty = gasQtyInp ? parseFloat(_billStripCurrency(gasQtyInp.value)) || 0 : 0;
      if (faCharge > 0 && gasQty > 0) {
        const rate = faCharge / gasQty;
        faRateInp.value = '$' + rate.toFixed(5) + '/' + gasUnit;
      }
      // Re-calc whenever gas qty or fuel adj charge changes
      function _updateFuelAdjRate() {
        const _faCharge = faChargeInp ? Math.abs(parseFloat(_billStripCurrency(faChargeInp.value)) || 0) : 0;
        const _gasQty = gasQtyInp ? parseFloat(_billStripCurrency(gasQtyInp.value)) || 0 : 0;
        if (_faCharge > 0 && _gasQty > 0) {
          faRateInp.value = '$' + (_faCharge / _gasQty).toFixed(5) + '/' + gasUnit;
        } else {
          faRateInp.value = '';
        }
      }
      if (faChargeInp) {
        faChargeInp.addEventListener('change', _updateFuelAdjRate);
        faChargeInp.addEventListener('input', _updateFuelAdjRate);
      }
      if (gasQtyInp) {
        gasQtyInp.addEventListener('change', _updateFuelAdjRate);
        gasQtyInp.addEventListener('input', _updateFuelAdjRate);
      }
    })();
  }
  document.getElementById('billModal').classList.add('open');
}
function closeBillModal() {
  document.getElementById('billModal').classList.remove('open');
  udSelMeterId = null;
  udBillEditId = null;
}
function billAutoSum() {
  // Walk the same `.ef-charge-row[data-charge-key]` elements that
  // `_billRecalcRunningTotals` uses so Auto-Sum and the running-total
  // column always agree. The old formula summed legacy aggregate
  // fields (kwCost / otherCost / taxCost / solarCredit) that the new
  // 3-column layout doesn't render — producing a different total than
  // what the user sees on the right side of the modal.
  let sum = 0;
  document.querySelectorAll('.ef-charge-row[data-charge-key]').forEach((r) => {
    const ck = r.getAttribute('data-charge-key');
    if (ck === 'TotalCurrentCharges') return;
    const chargeInp = r.querySelector('.bl-charge-input');
    if (chargeInp) sum += parseFloat(_billStripCurrency(chargeInp.value)) || 0;
  });
  if (sum > 0) {
    const totalInp = document.getElementById('bl-totalCost');
    if (totalInp) {
      totalInp.value = _billFmtCurrency(sum.toFixed(2));
      // Refresh the running-total match indicator so the ✓/✗ state updates
      _billRecalcRow('TotalCurrentCharges');
    }
    showToast('Total auto-summed: $' + sum.toFixed(2));
  } else {
    showToast('Fill in individual charges first');
  }
}
function saveBillRow() {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const m = b?.meters?.find((m) => m.id === udSelMeterId);
  if (!m) return;
  m.bills = m.bills || [];
  const row = udBillEditId ? m.bills.find((r) => r.id === udBillEditId) : null;
  const g = (id) => _billStripCurrency(document.getElementById(id)?.value || '');
  // Update 82: schema-driven writer. Iterates BILL_SCHEMA[commodity] and
  // reads each field from `bl-<key>` input. Legacy aggregate fields
  // (kwCost, facKWCost, kwhCost, otherCost, taxCost, renewableCharge,
  // solarCredit, therms, thermCost, usage, cost) are round-tripped via
  // hidden inputs populated by openBillModal so existing saved rows
  // don't lose data.
  const schema = _billSchemaFor(m.commodity);
  const data = {};
  for (const entry of schema) {
    if (entry.section) continue;
    const v = g('bl-' + entry.key);
    if (v !== '') data[entry.key] = v;
    else if (entry.key === 'start' || entry.key === 'end') data[entry.key] = '';
  }
  // Legacy passthroughs — preserve any values already on the row.
  const LEGACY_PASSTHROUGH = [
    'kwCost',
    'facKWCost',
    'kwhCost',
    'otherCost',
    'taxCost',
    'renewableCharge',
    'solarCredit',
    'therms',
    'thermCost',
    'usage',
    'cost',
  ];
  for (const k of LEGACY_PASSTHROUGH) {
    const v = g('bl-' + k);
    if (v !== '') data[k] = v;
  }
  // Bug #133 / Fix [therms-unit-2026-06-22]: sync gas usage to canonical therms (Therms).
  // Priority: Therms (×1) > CCF (×1.037) > MMBtu (×10). Constellation/KGS set naturalGasTherms;
  // Wood River sets naturalGasMMbtu. All paths must land in therms as Therms.
  if (data.naturalGasTherms != null && data.naturalGasTherms !== '') {
    data.therms = data.naturalGasTherms; // already Therms
  } else if (data.naturalGasCCF != null && data.naturalGasCCF !== '') {
    data.therms = String(Math.round(parseFloat(data.naturalGasCCF) * 1.037 * 100) / 100); // CCF → Therms
  } else if (data.naturalGasMMbtu != null && data.naturalGasMMbtu !== '') {
    data.therms = String(Math.round(parseFloat(data.naturalGasMMbtu) * 10 * 100) / 100); // MMBtu → Therms (×10)
  }
  const start = data.start;
  const end = data.end;
  if (!start || !end) {
    showToast('Start and end date required');
    return;
  }
  const _moveSel = document.getElementById('bl-move-meter')?.value || '';
  if (_moveSel && row) {
    const [_mvBldgId, _mvMeterId] = _moveSel.split('|');
    const _mvBldg = getUDBldg(udSelProjId, _mvBldgId);
    const _mvMeter = _mvBldg?.meters?.find((mt) => mt.id === _mvMeterId);
    if (_mvMeter) {
      Object.assign(row, data);
      m.bills = m.bills.filter((r) => r.id !== row.id);
      _mvMeter.bills = _mvMeter.bills || [];
      _mvMeter.bills.push(row);
      _mvMeter.bills.sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const _actx = _auditCtxFromIds(udSelProjId, udSelBldgId, udSelMeterId);
      logUtilityAudit({
        action: 'move',
        ..._actx,
        period: _auditPeriodLabel(row),
        note: 'Moved to ' + (_mvBldg.name || '') + ' — ' + meterLabel(_mvMeter),
        source: 'manual',
      });
      saveUtilityData();
      closeBillModal();
      renderMeterWorkspace();
      showToast('Bill moved to ' + meterLabel(_mvMeter) + ' ✓');
      return;
    }
  }
  const _actx = _auditCtxFromIds(udSelProjId, udSelBldgId, udSelMeterId);
  if (row) {
    const _before = { ...row };
    Object.assign(row, data);
    logUtilityAudit({
      action: 'edit',
      ..._actx,
      period: _auditPeriodLabel(row),
      changes: _auditDiffBillFields(_before, data),
      source: 'manual',
    });
    showToast('Record updated ✓');
  } else {
    const _newRow = { id: 'r' + Date.now(), ...data };
    m.bills.push(_newRow);
    logUtilityAudit({ action: 'add', ..._actx, period: _auditPeriodLabel(_newRow), source: 'manual' });
    showToast('Period added ✓');
  }
  m.bills.sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  // Run validation on the saved bill to keep _flags current
  if (typeof runBillValidation === 'function') {
    const _savedBill = row || m.bills.find((b) => b.start === data.start) || m.bills[m.bills.length - 1];
    if (_savedBill) runBillValidation(m, _savedBill);
  }
  // Run building-level cross-meter validation (water vs sewer parity, etc.)
  if (typeof runBuildingValidation === 'function' && typeof getUDBldg === 'function') {
    const _editBldg = getUDBldg(udSelProjId, udSelBldgId);
    if (_editBldg) runBuildingValidation(_editBldg);
  }
  saveUtilityData();
  closeBillModal();
  renderMeterWorkspace();
}

/* ── BUILDING MODAL ── */
function _bmRenderAliasTags(aliases) {
  const container = document.getElementById('bm-alias-tags');
  if (!container) return;
  container.innerHTML = (aliases || [])
    .map(
      (a, i) =>
        '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--s2);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:12px">' +
        '<span>' +
        a.replace(/</g, '&lt;') +
        '</span>' +
        '<button type="button" onclick="bmRemoveAlias(' +
        i +
        ')" style="background:none;border:none;cursor:pointer;color:var(--text3);padding:0;font-size:13px;line-height:1">&#x2715;</button>' +
        '</span>',
    )
    .join('');
}
function bmAddAlias() {
  const input = document.getElementById('bm-alias-input');
  const val = (input?.value || '').trim();
  if (!val) return;
  const tags = document.getElementById('bm-alias-tags');
  const existing = Array.from(tags.querySelectorAll('span > span')).map((s) => s.textContent.trim());
  if (existing.includes(val)) {
    showToast('Alias already added');
    return;
  }
  existing.push(val);
  _bmRenderAliasTags(existing);
  input.value = '';
  input.focus();
}
function bmRemoveAlias(index) {
  const tags = document.getElementById('bm-alias-tags');
  const existing = Array.from(tags.querySelectorAll('span > span')).map((s) => s.textContent.trim());
  existing.splice(index, 1);
  _bmRenderAliasTags(existing);
}
function openBldgModal(editId) {
  const modal = document.getElementById('bldgModal');
  document.getElementById('bm-edit-id').value = editId || '';
  const aliasSection = document.getElementById('bm-aliases-section');
  const aliasInput = document.getElementById('bm-alias-input');
  if (editId) {
    const b = getUDBldg(udSelProjId, editId);
    document.getElementById('bldgModalTitle').textContent = '✏️ Edit Building';
    document.getElementById('bm-name').value = b?.name || '';
    document.getElementById('bm-addr').value = b?.addr || '';
    document.getElementById('bm-sqft').value = b?.sqft || '';
    document.getElementById('bm-zip').value = b?.zip || '';
    _bmRenderAliasTags(b?.addrAliases || []);
    if (aliasSection) aliasSection.style.display = '';
    if (aliasInput) aliasInput.value = '';
  } else {
    document.getElementById('bldgModalTitle').textContent = '+ Add Building';
    document.getElementById('bm-name').value = '';
    document.getElementById('bm-addr').value = '';
    document.getElementById('bm-sqft').value = '';
    document.getElementById('bm-zip').value = '';
    _bmRenderAliasTags([]);
    if (aliasSection) aliasSection.style.display = 'none';
    if (aliasInput) aliasInput.value = '';
  }
  modal.classList.add('open');
}
function closeBldgModal() {
  document.getElementById('bldgModal').classList.remove('open');
}
function _bmReadAliasesFromDOM() {
  const tags = document.getElementById('bm-alias-tags');
  if (!tags) return [];
  return Array.from(tags.querySelectorAll('span > span'))
    .map((s) => s.textContent.trim())
    .filter(Boolean);
}
function saveBuilding() {
  const name = document.getElementById('bm-name').value.trim();
  if (!name) {
    showToast('Building name required');
    return;
  }
  const editId = document.getElementById('bm-edit-id').value;
  const aliases = _bmReadAliasesFromDOM();
  if (editId) {
    const b = getUDBldg(udSelProjId, editId);
    if (b) {
      b.name = name;
      b.addr = document.getElementById('bm-addr').value;
      b.sqft = parseInt(document.getElementById('bm-sqft').value) || 0;
      b.zip = (document.getElementById('bm-zip').value || '').trim();
      b.addrAliases = aliases;
    }
    showToast('Building updated ✓');
  } else {
    const proj = getUDProj(udSelProjId);
    proj.buildings.push({
      id: 'b' + Date.now(),
      name,
      addr: document.getElementById('bm-addr').value,
      sqft: parseInt(document.getElementById('bm-sqft').value) || 0,
      zip: (document.getElementById('bm-zip').value || '').trim(),
      addrAliases: aliases,
      meters: [],
    });
    showToast('Building added ✓');
  }
  saveUtilityData();
  closeBldgModal();
  renderUDProjList();
  renderUDDetail();
  renderProjTable();
  renderSidebarFolders();
  const ap = projects.find((p) => p.id == udSelProjId);
  if (ap && document.getElementById('projDetailView')?.style.display !== 'none') renderDetail(ap);
}
async function deleteBuilding(bid) {
  if (!(await confirmAsync('Delete this building and all its meters?'))) return;
  const proj = getUDProj(udSelProjId);
  proj.buildings = proj.buildings.filter((b) => b.id !== bid);
  if (udSelBldgId === bid) udSelBldgId = null;
  saveUtilityData();
  renderUDProjList();
  renderUDDetail();
  renderProjTable();
  renderSidebarFolders();
  const ap2 = projects.find((p) => p.id == udSelProjId);
  if (ap2 && document.getElementById('projDetailView')?.style.display !== 'none') renderDetail(ap2);
  showToast('Building deleted');
}

/* ── METER MODAL ── */
function setMeterInclusive(val) {
  _meterInclusive = val;
  document.getElementById('mm-incl-btn').classList.toggle('sel', val);
  document.getElementById('mm-excl-btn').classList.toggle('sel', !val);
  document.getElementById('mm-inclusive').value = String(val);
}
function _updateMeterUnitDropdowns() {
  const commodity = document.getElementById('mm-commodity').value;
  const reg = UNIT_REGISTRY[commodity];
  const billSel = document.getElementById('mm-billUnit');
  const dispSel = document.getElementById('mm-displayUnit');
  if (!reg || !billSel || !dispSel) return;
  const units = reg.usage;
  const prevBill = billSel.value;
  const prevDisp = dispSel.value;
  billSel.innerHTML = units.map((u) => '<option value="' + u + '">' + u + '</option>').join('');
  dispSel.innerHTML = units.map((u) => '<option value="' + u + '">' + u + '</option>').join('');
  billSel.value = units.includes(prevBill) ? prevBill : reg.defaultUsage;
  dispSel.value = units.includes(prevDisp) ? prevDisp : reg.defaultUsage;
  _updateUnitPreview();
  // FIX #11 — When adding a new meter, override registry default with units from
  // existing same-commodity meters on the same building so new meters match siblings.
  const editId = document.getElementById('mm-edit-id')?.value;
  if (!editId) {
    const _pid = document.getElementById('mm-target-proj')?.value || udSelProjId;
    const _bid = document.getElementById('mm-target-bldg')?.value || udSelBldgId;
    const _b11 = getUDBldg(_pid, _bid);
    const sameType = (_b11?.meters || []).filter((m) => m.commodity === commodity && m.billUnit);
    if (sameType.length) {
      const refMeter = sameType[sameType.length - 1]; // most recently added
      if (refMeter.billUnit && units.includes(refMeter.billUnit)) billSel.value = refMeter.billUnit;
      if (refMeter.displayUnit && units.includes(refMeter.displayUnit)) dispSel.value = refMeter.displayUnit;
      _updateUnitPreview();
    }
  }
}

function _updateUnitPreview() {
  const billU = document.getElementById('mm-billUnit').value;
  const dispU = document.getElementById('mm-displayUnit').value;
  const commodity = document.getElementById('mm-commodity').value;
  const preview = document.getElementById('mm-unit-preview');
  if (!preview) return;
  if (billU === dispU || !billU || !dispU) {
    preview.style.display = 'none';
    return;
  }
  const converted = convertUnit(1, billU, dispU, commodity);
  preview.textContent = '1 ' + billU + ' = ' + converted.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' ' + dispU;
  preview.style.display = '';
}

function openMeterModal(editId, projId, bldgId) {
  const _pid = projId || udSelProjId;
  const _bid = bldgId || udSelBldgId;
  document.getElementById('mm-edit-id').value = editId || '';
  document.getElementById('mm-target-bldg').value = _bid || '';
  document.getElementById('mm-target-proj').value = _pid || '';
  _meterInclusive = true;
  const moveWrap = document.getElementById('mm-move-bldg-wrap');
  if (moveWrap) moveWrap.style.display = 'none';
  if (editId) {
    const b = getUDBldg(_pid, _bid);
    const m = b?.meters?.find((m) => m.id === editId);
    if (m) {
      document.getElementById('meterModalTitle').textContent = '✏️ Edit Meter';
      document.getElementById('mm-commodity').value = m.commodity || 'Electric';
      document.getElementById('mm-provider').value = m.provider || '';
      document.getElementById('mm-account').value = m.account || '';
      document.getElementById('mm-meter').value = m.meter || '';
      document.getElementById('mm-maddr').value = m.maddr || '';
      _meterInclusive = m.inclusive !== false;
      document.getElementById('mm-blInclude').checked = m.baselineInclude !== false;
      _updateMeterUnitDropdowns();
      if (m.billUnit) document.getElementById('mm-billUnit').value = m.billUnit;
      if (m.displayUnit) document.getElementById('mm-displayUnit').value = m.displayUnit;
      _updateUnitPreview();
    }
    if (moveWrap) {
      const bldgs = getUDBldgs(_pid) || [];
      if (bldgs.length > 1) {
        const sel = document.getElementById('mm-move-bldg');
        sel.innerHTML =
          '<option value="">— Keep on current building —</option>' +
          bldgs
            .filter((bb) => bb.id !== _bid)
            .map((bb) => '<option value="' + bb.id + '">' + (bb.name || 'Unnamed') + '</option>')
            .join('');
        moveWrap.style.display = '';
      }
    }
  } else {
    document.getElementById('meterModalTitle').textContent = '+ Add Meter';
    ['mm-provider', 'mm-account', 'mm-meter', 'mm-maddr'].forEach((id) => (document.getElementById(id).value = ''));
    document.getElementById('mm-commodity').value = 'Electric';
    document.getElementById('mm-blInclude').checked = true;
    _updateMeterUnitDropdowns();
    // FIX #10 — Pre-fill meter address from parent building's address as an editable suggestion.
    const _b10 = getUDBldg(_pid, _bid);
    if (_b10?.addr) document.getElementById('mm-maddr').value = _b10.addr;
  }
  document.getElementById('mm-incl-btn').classList.toggle('sel', _meterInclusive);
  document.getElementById('mm-excl-btn').classList.toggle('sel', !_meterInclusive);
  document.getElementById('mm-inclusive').value = String(_meterInclusive);
  document.getElementById('meterModal').classList.add('open');
}
function closeMeterModal() {
  document.getElementById('meterModal').classList.remove('open');
}
function updateMeterModalFields() {
  /* commodity fields are shared across types — no field changes needed */
}
function _refreshBldgPerfIfVisible() {
  const pane = document.getElementById('bldgPerfPaneInner');
  if (pane && pane.offsetParent !== null) {
    const b = getUDBldg(udSelProjId, udSelBldgId);
    if (b) renderBldgPerfPane(pane, b);
  }
}

function saveMeter() {
  const editId = document.getElementById('mm-edit-id').value;
  const incl = document.getElementById('mm-inclusive').value === 'true';
  const data = {
    commodity: document.getElementById('mm-commodity').value,
    provider: document.getElementById('mm-provider').value,
    account: document.getElementById('mm-account').value,
    meter: document.getElementById('mm-meter').value,
    maddr: document.getElementById('mm-maddr').value,
    inclusive: incl,
    baselineInclude: document.getElementById('mm-blInclude').checked,
    billUnit: document.getElementById('mm-billUnit').value || '',
    displayUnit: document.getElementById('mm-displayUnit').value || '',
  };
  const _targetProjId = document.getElementById('mm-target-proj').value || udSelProjId;
  const _targetBldgId = document.getElementById('mm-target-bldg').value || udSelBldgId;
  const b = getUDBldg(_targetProjId, _targetBldgId);
  if (!b) return;
  b.meters = b.meters || [];
  if (editId) {
    const m = b.meters.find((m) => m.id === editId);
    if (m) {
      Object.assign(m, data);
      const moveToBldgId = document.getElementById('mm-move-bldg')?.value || '';
      if (moveToBldgId && moveToBldgId !== _targetBldgId) {
        const destBldg = getUDBldg(_targetProjId, moveToBldgId);
        if (destBldg) {
          b.meters = b.meters.filter((x) => x.id !== editId);
          destBldg.meters = destBldg.meters || [];
          destBldg.meters.push(m);
          udSelBldgId = moveToBldgId;
          udActiveMid = m.id;
          showToast('Meter moved to ' + (destBldg.name || 'building') + ' ✓');
        }
      } else {
        showToast('Meter updated ✓');
      }
    }
  } else {
    const nm = { id: 'm' + Date.now(), bills: [], ...data };
    b.meters.push(nm);
    udActiveMid = nm.id;
    const _blCount = _inheritBaselinesForProject(_targetProjId);
    showToast('Meter added to ' + (b.name || 'building') + (_blCount ? ' · baseline inherited ✓' : ' ✓'));
  }
  saveUtilityData();
  closeMeterModal();
  renderUDProjList();
  const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
  if (isEmbed) {
    // Sync globals to the project/building that was actually saved to.
    // renderProjUDBody restores udSelProjId/udSelBldgId to pre-embed values after each render,
    // so they are stale here. Without this sync renderUDDetail fetches the wrong building
    // and the new/edited meter never appears without a manual reload.
    udSelProjId = _targetProjId;
    udSelBldgId = _targetBldgId;
    if (typeof projUDSelBldg !== 'undefined') projUDSelBldg[_targetProjId] = _targetBldgId;
    // FIX #12 — _udActiveWrap points to a stale detached tempDiv created during
    // renderProjUDBody's cloning step. Rendering into it never updates the live DOM.
    // Re-render via renderProjUDBody so it targets the real proj-ud-body-<id> element.
    renderProjUDBody(_targetProjId, projUDSelBldg[_targetProjId] || _targetBldgId);
  } else {
    renderUDDetail(undefined);
  }
  _refreshBldgPerfIfVisible();
  setTimeout(renderSidebarFolders, 100);
  if (isEmbed) {
    renderProjTable();
    const ap3 = projects.find((p) => p.id == udSelProjId);
    if (ap3 && document.getElementById('projDetailView')?.style.display !== 'none') renderDetail(ap3);
  }
}

/* ── LINK FROM PROJECT DETAIL UTILITY TAB ── */
function goToProjectUtility(projId) {
  udSelProjId = projId;
  udSelBldgId = null;
  udActiveMid = null;
  sv('utility', document.querySelector('.s-item[onclick*="utility"]'));
  renderUDProjList();
  renderUDDetail();
}

/* ── INIT UTILITY TOOL ── */
/* ── MEETING AGENDA & MINUTES ── */

const CSC_HEADER_B64 =
  'data:image/jpeg;base64,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';
const CSC_FOOTER_B64 =
  'data:image/jpeg;base64,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qLcIP9M+H6Sf9cNUKf8AoUVdDp//AAVB8OTMq33gnVIAe9tdRTfz21zyy3FR+waxzDDy+0fb1JXyNZf8FK/hrcbftGleILLP/PW3hP8AKWui0/8A4KD/AAfvB++1a/sv+viwk/8AZd1YywOJjvBmqxtB7SPpfIoxmvDrD9tL4MX4Gzx3aRn/AKeLeeH/ANDjFdRp37RPwy1XZ9l8eaBLu6D+0Yh/M1i8PVW8H9xqsRSf2j0qkrn9P8eeHdVA+ya9p1znp5N3G/8AI1trcI6ghwQfTrWLhJbo0U4y2ZL+FGaj3D1/rTs4qG7F3TH0VHj6/nRu9qNtxklFNB+tKD9aAFopM8UnNOwrjqKZk0c+tFn0C4+iiikMKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigApKaPxpeuO1CuK46im5+tFPQeo6iiikAUUUUAFFFFABRRRQAUUUUAFFFFABRTMk+tOBzTs0JO4tFMxSMfr+FK66hr0JKTn0qMvx1wPWsrWfFWleHrYzapqlnpsYGTJdTrGo/76IpqMpO0UJyjHdmzRxXh3in9s34ReFXdJ/GVrfTIP9RpiPdsfoY1Yf+PV5D4m/wCCmng2x3pofhjV9YkXoZ3S2jP4/O3/AI7XbTwOJq/BBnLLF0Y7yPtCmlsDqK/NfxL/AMFMPHOobk0Tw7o+k+n2hpLmT8soK8m8Sftm/GHxLuE/jK6s4x/BYRR2w/76RAa9Cnk2JqPVWOGWa0I7H68y3kVvEZJJFjjHVpDtA+pNcR4g+O3w88LITqvjXRLLHUSX0ZI/AHNfjdrvjbxF4omMmsa5qOrSnqbu7kkH/jxNYhYlixJLHqT1/OvRhkP88jgnnLfwxP1h139vb4O6LlYvEM2qS/3LKylb9WVR+tec69/wU38JWgxpHhLV9SP964kS3T8/m/lX5xjgEDgGj+LP8Xr3ruhkmHXxXZxzzau9j7W1z/gp14nuNyaR4P02z9Gu7iSYj8tleda5/wAFA/jBqrOLbU9O0hT0W009CR+MnmV83UAADAAA9O1d1PLcND7Bxyx+Iluz1XWv2oviz4gLfafHWsbG6rayGIL9BGorhNX8a+IvELltV17U9TY9TeXkkpP4saxSoPYc/rRXZGhSj8MEc7xFWW8hzyvKxLuzk9STk00fez39e9FFaxio7GTk5bsXJ9TSentRRV6LYTbYpJIxkkUlFFL5i9QA2njg0evvRRRp0Q9OoUAAdABRRRoCfcXJHQ4+lJ3oooC4UUUUCCiiigAooooAKKKKACiiigAooooAKKKKACiiigAoHHTiiigBSSepJpKKKnUVkHfPeiiimvMr5B1oHy9OKKKLJ7oVl2CjtRRTu2G2yBfkxt4x6cUuaSik9RptAPl6cUd896KKTjfqClJdRyuyY2sVx0wcVoWHiTV9LINlql7ZkdPIuHTH5EVm0UnTpy3iVGc47SO70749/EfSWBtPHXiBB6NqTyD9WrrNL/bL+MmlMjReOL2bZ2uYYpg313JXjB5HPNDfMRnn9axlhqE/igjaOJrR2kfS2k/8FCvjBp7Ym1DS9U/6+rBR/wCi9ldjpf8AwUy8c24/07wxot4f+mJmh/8AQia+Ocknk5pMAdBiuZ5dhWrOmjWOOrr7R97aZ/wVFwmNR8AHd/z0tdTIH5NFmuy0n/gpn4CvAn27w/rtkT1aNYpkH4h/6V+a2ADnAzS9yepNc0smwstlY6oZriFufq1pf/BQH4P6iVE2tXunA9TdafLx/wB8q1dno37Wfwi1zi28faRGf+nqU23/AKNC1+OXY+lLuOc5Oa5JZDQls2bxzest0ft/pfxR8I62m7T/ABRpF4P+mN7Gx/Rq6WK4SZd6SB0IyCpBB/GvwcVihypIPtwa0dM8T6xo0gk0/Vr6wcdHtrl4yPoQQa5JZD/LM6YZ1/NE/dgEY+9+tO/Gvxa0j9pL4o6D/wAe3jzXVz2nvWf/ANGMa7fSP26fjPpXynxQt6g/hurKCQf99iPNc08jrx2aZ0wzijLdH63Zpa/MfR/+ClfxIsdv2/SNB1FO5WOSM/o9d1pH/BUWZBjVvAaOP+ellqYUfkyZrkllOLj9m51RzLDy6n39RXx3o/8AwUv8A3YQajoGv6aT1YRRzIPxV/6V3Ojft6/BvVVHm+I59Ob0u7GUE/8AfKtXJPA4mG8GdEcZQltI+ic5oAFeY6N+0p8MPECD7D490N2bgJNeJC3/AHy5U13GleJ9J1tT/Z+rWV+Rz/otwkn8ia5nSnH4o2OhVYS2Zr0YqETYHJHPqak3E1k3bc0TT2H0Ug470ZFCYxaKbn60tAC0mKTOKMj1NP0EOooopDCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAExS03OKM0PTcNx1FJmoWkI54Ix+X1oWoExx3oxXlPxE/aa+HHwuE0eueKbQX0f3rC1cTzr7FEyV/4Hivlz4jf8FNColtvA/hhnJ/1d7q79f92JOv4vXfRwOIrv3InHWxdGj8cj7yeTy03M20DqTXjnxM/a4+GXwuMsOo+Iob7UIxk2Om/6RKPrt+Vf+BstfmT8R/2k/iN8VPNi8QeKLuWyfj7DbMLaAD/cQ4f/AIFmvMySTknJr38NkTunWkeJXzi2lJH37f8A/BUWyjvJlsfh7eXNoGxFLNqSRuw9SoRgPpuNFfAP40V639kYXseZ/aeI7n73UUUV+dn3QUUUUAFFFNPXrQA6imAc9aU0X7gLS1C0uzOeg7//AK64zxr8ZvBHw6SR/EfirTdJZPvRTXAMv4RjLfpWihKWkVciU4x+JncCjmvkXxv/AMFIfh54dEkeg2Op+JZV6SBPssB/4E/zf+OV4B42/wCCkfxD1wvHoFhpnhuI9HC/apvzb5f/AByvQpZbiav2bHn1MwoU+tz9M2k8sZLdOoJ5rgfGPx++HvgBW/t/xhpNhKvWA3IeX/vhct/47X5I+Mfjx8QPiCCuveLtVv4D1tzcbID9Y0O39K4TuT3PX3r2aWQ2/iSPLnnF/gifpz4w/wCCkHw30PdHolpqviSYdGhiEMZ/Fvm/8drw/wAX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';

let _mtgFilter = 'all';
let _editingMeeting = null;
let _editingMeetingProjId = null;

function getDefaultTemplate() {
  let t = sget('en_meetingTemplates', null);
  // Upgrade legacy templates from the sparse v1 defaults to v2 rich defaults
  // so existing users see the richer agenda without losing their other settings.
  if (t && t.defaultTopics && !t.defaultTopicsVersion) {
    t.defaultTopics = null;
  }
  if (!t || !t.defaultTopics) {
    t = t || {};
    t.id = t.id || Date.now();
    t.name = t.name || 'Energy Management Services';
    t.cscContacts = t.cscContacts || []; // Contacts entered by user, never hardcoded
    t.sectionHeading = t.sectionHeading || 'Energy Management Services Program';
    t.defaultEndTopic = t.defaultEndTopic || 'Questions?';
    t.defaultTopics = [
      {
        text: 'Welcome & Review of Previous Meeting',
        subItems: [
          'Confirm attendance and introductions.',
          'Review action items and open issues from the prior meeting.',
          'Note any items completed, carried forward, or reassigned.',
        ],
      },
      {
        text: 'BAS (Building Automation) Updates',
        subItems: [
          'Current system status — controllers, sensors, network health.',
          'Setpoint or schedule changes made since last meeting.',
          'Pending programming changes or graphics requests.',
          'Open BAS work orders and targeted completion dates.',
        ],
      },
      {
        text: 'Energy Savings Performance Review',
        subItems: [
          'Utility bill trends vs baseline (kWh, kW, therms, $).',
          'Weather-normalized usage for the most recent month(s).',
          'Year-to-date savings vs projected target.',
          'Any anomalies, spikes, or regressions to investigate.',
        ],
      },
      {
        text: 'Building & Equipment Updates',
        subItems: [
          'Equipment status: chillers, boilers, AHUs, pumps, VFDs.',
          'Recent repairs, replacements, or commissioning work.',
          'Pending equipment orders, delivery and install dates.',
          'Any new or deferred capital needs identified.',
        ],
      },
      {
        text: 'Onsite Technical Labor Services',
        subItems: [
          'Hours used this period vs allocation.',
          'Scheduled onsite work for the next period.',
          'Deficiency items from last site visit.',
        ],
      },
      {
        text: 'Measurement & Verification / Monthly Review',
        subItems: [
          'Confirm next monthly data review date.',
          'Confirm next quarterly review date and scope.',
          'Review any reports that need to be generated or delivered.',
        ],
      },
      {
        text: 'Upcoming Milestones & Action Items',
        subItems: ['New action items with owners and due dates.', 'Upcoming project milestones and dependencies.'],
      },
      {
        text: 'Open Issues & Discussion',
        subItems: ['Items raised by owner, facilities staff, or CSC team.'],
      },
      { text: 'Questions?', subItems: [] },
    ];
    t.defaultTopicsVersion = 2;
    sset('en_meetingTemplates', t);
  }
  return t;
}

function mtgFilterSet(f, projId, el) {
  _mtgFilter = f;
  const pills = el?.parentElement?.querySelectorAll('.ptpill');
  pills?.forEach((p) => p.classList.remove('sel'));
  el?.classList.add('sel');
  renderMeetingsList(projId);
}

/* ── DOCUMENTS SUB-TAB SYSTEM ── */
function renderDocsSubTab(subTab, projId) {
  window._docsSubTab = subTab;
  const pills = document.querySelectorAll('#docsSubTabs .ptpill');
  pills.forEach((p) => p.classList.toggle('sel', p.dataset.dsub === subTab));
  const body = document.getElementById('ptab-docs-body-' + projId);
  if (!body) return;
  if (subTab === 'contracts') _renderDocsContracts(body, projId);
  else if (subTab === 'meetings') _renderDocsMeetings(body, projId);
  else if (subTab === 'approved') _renderDocsApproved(body, projId);
  else if (subTab === 'files') _renderDocsFiles(body, projId);
}

function _renderDocsContracts(body, projId) {
  body.innerHTML = `
          <div class="g2">
            <div>
              <div class="card" style="margin-bottom:14px">
                <div class="card-hdr"><span class="card-title">📋 Template</span></div>
                <div style="padding:14px" id="tmplStatus-${projId}">
                  <div style="font-size:13px;color:var(--text2);line-height:1.6">No template loaded.</div>
                  <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="loadDefaultTemplatForProj(${projId})">Use Generic Template</button>
                </div>
              </div>
              <div class="card" id="contractVarsCard-${projId}" style="display:none">
                <div class="card-hdr"><span class="card-title">✏️ Contract Variables</span></div>
                <div style="padding:14px" id="contractVars-${projId}"></div>
                <div style="padding:0 14px 14px"><button class="btn btn-em" style="width:100%" onclick="generateProjContract(${projId})">📋 Generate Contract</button></div>
              </div>
            </div>
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
                <div class="ai-label" style="margin:0">📋 Generated Contract</div>
                <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('contractOut-${projId}')?.textContent||'');showToast('Copied ✓')">📋 Copy</button>
              </div>
              <div class="ai-box" id="contractOut-${projId}" style="min-height:400px;max-height:560px;overflow-y:auto">Click "Use Generic Template" to get started.</div>
            </div>
          </div>`;
}

function _renderDocsMeetings(body, projId) {
  body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:14px;font-weight:600">Meetings</span>
              <div style="display:flex;gap:4px">
                <button class="ptpill sel" onclick="mtgFilterSet('all',${projId},this)">All</button>
                <button class="ptpill" onclick="mtgFilterSet('agenda',${projId},this)">Agendas</button>
                <button class="ptpill" onclick="mtgFilterSet('minutes',${projId},this)">Minutes</button>
                <button class="ptpill" onclick="mtgFilterSet('report',${projId},this)">Reports</button>
              </div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="openReportModalV2(${projId})">📊 Generate Report</button>
              <button class="btn btn-em btn-sm" onclick="openMeetingEditor(${projId})">+ New Agenda</button>
            </div>
          </div>
          <div id="mtg-recur-info-${projId}" style="margin-bottom:10px"></div>
          <div id="mtg-list-${projId}"></div>`;
  renderMeetingsList(projId);
}

function _renderDocsFiles(body, projId) {
  body.innerHTML = `
          <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
            <button class="btn btn-em btn-sm" onclick="sv('pdf',null);showToast('Upload a PDF and save it to this project')">📄 Upload Document</button>
          </div>
          <div style="font-size:13px;color:var(--text2)">No documents yet. Use the PDF/OCR tool to save documents to this project.</div>`;
}

function _renderDocsApproved(body, projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.approvedChanges = p.approvedChanges || [];
  const count = p.approvedChanges.length;
  const badge =
    count > 0
      ? `<span style="background:var(--s3);color:var(--text2);font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px">${count}</span>`
      : '';

  let tableHTML = '';
  if (count === 0) {
    tableHTML =
      '<div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">No approved changes yet. Import from a change order spreadsheet or add rows manually.</div>';
  } else {
    const rows = p.approvedChanges
      .map((c, i) => {
        const statusColor =
          (c.approvalStatus || '').toLowerCase() === 'ok'
            ? 'var(--lime)'
            : (c.approvalStatus || '').toLowerCase() === 'no'
              ? 'var(--warn)'
              : 'var(--amber)';
        const statusBg =
          (c.approvalStatus || '').toLowerCase() === 'ok'
            ? 'rgba(132,204,22,0.12)'
            : (c.approvalStatus || '').toLowerCase() === 'no'
              ? 'rgba(239,68,68,0.12)'
              : 'rgba(245,158,11,0.12)';
        return `<tr data-acid="${c.id}">
              <td><input class="ac-inp" data-field="building" value="${(c.building || '').replace(/"/g, '&quot;')}" onblur="_acSave(${projId},${c.id},this)"></td>
              <td><input class="ac-inp" data-field="equipment" value="${(c.equipment || '').replace(/"/g, '&quot;')}" onblur="_acSave(${projId},${c.id},this)"></td>
              <td><input class="ac-inp" data-field="proposedChange" value="${(c.proposedChange || '').replace(/"/g, '&quot;')}" onblur="_acSave(${projId},${c.id},this)"></td>
              <td><input class="ac-inp" data-field="existingState" value="${(c.existingState || '').replace(/"/g, '&quot;')}" onblur="_acSave(${projId},${c.id},this)"></td>
              <td><select class="ac-inp" data-field="approvalStatus" onchange="_acSave(${projId},${c.id},this)" style="background:${statusBg};color:${statusColor};font-weight:600;border-radius:4px;text-align:center">
                <option value="Pending"${c.approvalStatus === 'Pending' ? ' selected' : ''}>Pending</option>
                <option value="Ok"${c.approvalStatus === 'Ok' ? ' selected' : ''}>Ok</option>
                <option value="No"${c.approvalStatus === 'No' ? ' selected' : ''}>No</option>
              </select></td>
              <td><input class="ac-inp" type="date" data-field="completedDate" value="${(c.completedDate || '').slice(0, 10)}" onblur="_acSave(${projId},${c.id},this)"></td>
              <td style="text-align:center"><button class="btn btn-ghost btn-sm" onclick="_acDelete(${projId},${c.id})" title="Delete" style="color:var(--warn);padding:2px 6px">🗑️</button></td>
            </tr>`;
      })
      .join('');

    tableHTML = `<div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:var(--s2);font-size:11px;text-transform:uppercase;color:var(--text3);letter-spacing:0.03em">
                <th style="padding:6px 8px;text-align:left;font-weight:600">Building</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600">Equipment</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600">Proposed Change</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600">Existing State</th>
                <th style="padding:6px 8px;text-align:center;font-weight:600;width:90px">Status</th>
                <th style="padding:6px 8px;text-align:left;font-weight:600;width:120px">Completed</th>
                <th style="width:40px"></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
  }

  body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="display:flex;align-items:center">
              <span style="font-size:14px;font-weight:600">Approved Changes</span>${badge}
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="_acImportFile(${projId})">📤 Import from File</button>
              <button class="btn btn-ghost btn-sm" onclick="_acImportFromSaved(${projId})">📄 From Saved Docs</button>
              <button class="btn btn-em btn-sm" onclick="_acAddRow(${projId})">+ Add Row</button>
            </div>
          </div>
          ${tableHTML}`;
}

function _acSave(projId, acId, el) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const item = (p.approvedChanges || []).find((c) => c.id === acId);
  if (!item) return;
  const field = el.dataset.field;
  item[field] = el.value;
  sset('en_projects', projects);
}

function _acDelete(projId, acId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.approvedChanges = (p.approvedChanges || []).filter((c) => c.id !== acId);
  sset('en_projects', projects);
  _renderDocsApproved(document.getElementById('ptab-docs-body-' + projId), projId);
  showToast('Row deleted');
}

function _acAddRow(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.approvedChanges = p.approvedChanges || [];
  p.approvedChanges.push({
    id: Date.now(),
    building: '',
    equipment: '',
    proposedChange: '',
    existingState: '',
    approvalStatus: 'Pending',
    completedDate: '',
    approvedBy: '',
    source: 'Manual',
    importedAt: new Date().toISOString(),
  });
  sset('en_projects', projects);
  _renderDocsApproved(document.getElementById('ptab-docs-body-' + projId), projId);
  showToast('Row added');
}

function _acImportFile(projId) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.xls,.csv';
  inp.style.display = 'none';
  inp.onchange = function (e) {
    const file = e.target.files[0];
    document.body.removeChild(inp);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const data = new Uint8Array(ev.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        _acProcessImport(projId, rows, file.name);
      } catch (err) {
        showToast('Could not read file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };
  // Bug fdf197fe: must attach input to DOM before clicking or the file
  // picker silently fails in some browsers (Chrome/Edge security policy).
  document.body.appendChild(inp);
  inp.click();
}

function _acProcessImport(projId, rows, filename) {
  if (!rows || rows.length < 2) {
    showToast('No data found in file');
    return;
  }

  const matchers = [
    { field: 'building', re: /building/i },
    { field: 'equipment', re: /equipment/i },
    { field: 'proposedChange', re: /proposed\s*change|^change$/i },
    { field: 'existingState', re: /existing\s*(state)?/i },
    { field: 'approvalStatus', re: /approv|status/i },
    { field: 'completedDate', re: /completed|date/i },
  ];

  let headerIdx = -1;
  const colMap = {};
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let matches = 0;
    const tempMap = {};
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || '').trim();
      if (!val) continue;
      for (const m of matchers) {
        if (m.re.test(val) && !tempMap[m.field]) {
          tempMap[m.field] = c;
          matches++;
          break;
        }
      }
    }
    if (matches >= 2) {
      headerIdx = r;
      Object.assign(colMap, tempMap);
      break;
    }
  }
  if (headerIdx < 0) {
    showToast('Could not find column headers in the spreadsheet');
    return;
  }

  const approverMatch = filename.match(/approved\s+by\s+(\w+)/i);
  const approvedBy = approverMatch ? approverMatch[1] : '';

  const parsed = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const get = (field) => (colMap[field] != null ? String(row[colMap[field]] || '').trim() : '');
    const building = get('building');
    const equipment = get('equipment');
    const proposedChange = get('proposedChange');
    if (!building && !equipment && !proposedChange) continue;

    let completedDate = get('completedDate');
    if (completedDate) {
      const d = new Date(completedDate);
      if (!isNaN(d)) completedDate = d.toISOString().slice(0, 10);
    }

    parsed.push({
      building,
      equipment,
      proposedChange,
      existingState: get('existingState'),
      approvalStatus: get('approvalStatus') || 'Pending',
      completedDate,
    });
  }
  if (!parsed.length) {
    showToast('No data rows found below headers');
    return;
  }

  _acShowImportPreview(projId, parsed, approvedBy, filename);
}

function _acShowImportPreview(projId, parsed, approvedBy, filename) {
  let existing = document.getElementById('acImportModal');
  if (existing) existing.remove();

  const previewRows = parsed
    .map((r, i) => {
      const statusColor =
        (r.approvalStatus || '').toLowerCase() === 'ok'
          ? 'color:var(--lime)'
          : (r.approvalStatus || '').toLowerCase() === 'no'
            ? 'color:var(--warn)'
            : 'color:var(--amber)';
      return `<tr>
            <td style="padding:4px 6px"><input type="checkbox" class="ac-imp-cb" data-idx="${i}" checked></td>
            <td style="padding:4px 6px;font-size:11px">${r.building}</td>
            <td style="padding:4px 6px;font-size:11px">${r.equipment}</td>
            <td style="padding:4px 6px;font-size:11px">${r.proposedChange}</td>
            <td style="padding:4px 6px;font-size:11px">${r.existingState}</td>
            <td style="padding:4px 6px;font-size:11px;font-weight:600;${statusColor}">${r.approvalStatus}</td>
            <td style="padding:4px 6px;font-size:11px">${r.completedDate}</td>
          </tr>`;
    })
    .join('');

  const modal = document.createElement('div');
  modal.id = 'acImportModal';
  modal.className = 'modal-bg open';
  modal.innerHTML = `
          <div class="modal" style="max-width:900px;max-height:80vh;display:flex;flex-direction:column">
            <div class="modal-hdr">
              <span class="modal-title">Import Approved Changes</span>
              <button class="modal-x" onclick="document.getElementById('acImportModal').remove()">&times;</button>
            </div>
            <div style="padding:14px;overflow-y:auto;flex:1">
              <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
                <label style="font-size:12px;font-weight:600;color:var(--text2)">Approved By:</label>
                <input id="acImpApprovedBy" value="${approvedBy}" style="flex:1;padding:4px 8px;border:1px solid var(--s3);border-radius:4px;background:var(--s1);color:var(--text);font-size:13px">
              </div>
              <div style="font-size:11px;color:var(--text3);margin-bottom:8px">Source: ${filename} · ${parsed.length} rows found</div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse">
                  <thead><tr style="background:var(--s2);font-size:10px;text-transform:uppercase;color:var(--text3)">
                    <th style="padding:4px 6px;width:30px"></th>
                    <th style="padding:4px 6px;text-align:left">Building</th>
                    <th style="padding:4px 6px;text-align:left">Equipment</th>
                    <th style="padding:4px 6px;text-align:left">Proposed Change</th>
                    <th style="padding:4px 6px;text-align:left">Existing State</th>
                    <th style="padding:4px 6px;text-align:left">Status</th>
                    <th style="padding:4px 6px;text-align:left">Completed</th>
                  </tr></thead>
                  <tbody>${previewRows}</tbody>
                </table>
              </div>
            </div>
            <div style="padding:14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
              <button class="btn btn-ghost" onclick="document.getElementById('acImportModal').remove()">Cancel</button>
              <button class="btn btn-em" onclick="_acDoImport(${projId})">Import Selected</button>
            </div>
          </div>`;

  window._acImportParsed = parsed;
  window._acImportFilename = filename;
  document.body.appendChild(modal);
}

function _acDoImport(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.approvedChanges = p.approvedChanges || [];

  const approvedBy = (document.getElementById('acImpApprovedBy')?.value || '').trim();
  const checks = document.querySelectorAll('.ac-imp-cb:checked');
  const indices = Array.from(checks).map((cb) => parseInt(cb.dataset.idx));
  const parsed = window._acImportParsed || [];
  const filename = window._acImportFilename || '';

  let added = 0;
  indices.forEach((i) => {
    const r = parsed[i];
    if (!r) return;
    p.approvedChanges.push({
      id: Date.now() + added,
      building: r.building,
      equipment: r.equipment,
      proposedChange: r.proposedChange,
      existingState: r.existingState,
      approvalStatus: r.approvalStatus || 'Pending',
      completedDate: r.completedDate || '',
      approvedBy: approvedBy,
      source: filename,
      importedAt: new Date().toISOString(),
    });
    added++;
  });

  sset('en_projects', projects);
  document.getElementById('acImportModal').remove();
  delete window._acImportParsed;
  delete window._acImportFilename;
  _renderDocsApproved(document.getElementById('ptab-docs-body-' + projId), projId);
  showToast(added + ' change' + (added !== 1 ? 's' : '') + ' imported');
}

function _acImportFromSaved(projId) {
  const allBills = sget('en_pdf_bills', []) || [];
  const projBills = allBills.filter((b) => b.projId === projId || !b.projId);
  const spreadsheets = projBills.filter((b) => {
    const name = (b.fileName || b.name || '').toLowerCase();
    return name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');
  });
  if (!spreadsheets.length) {
    showToast('No spreadsheet files saved to this project. Use "Import from File" to upload directly.');
    return;
  }
  let existing = document.getElementById('acSavedDocsModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'acSavedDocsModal';
  modal.className = 'modal-bg open';
  const listHTML = spreadsheets
    .map((b) => {
      const name = b.fileName || b.name || 'Unknown';
      return `<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--s2);font-size:13px" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background=''" onclick="_acLoadSavedDoc(${projId},${b.id})">${name}</div>`;
    })
    .join('');
  modal.innerHTML = `
          <div class="modal" style="max-width:400px">
            <div class="modal-hdr">
              <span class="modal-title">Select Document</span>
              <button class="modal-x" onclick="document.getElementById('acSavedDocsModal').remove()">&times;</button>
            </div>
            <div style="padding:14px">
              <div style="font-size:12px;color:var(--text3);margin-bottom:8px">${spreadsheets.length} spreadsheet(s) found</div>
              ${listHTML}
            </div>
          </div>`;
  document.body.appendChild(modal);
}

function _acLoadSavedDoc(projId, billId) {
  document.getElementById('acSavedDocsModal')?.remove();
  const allBills = sget('en_pdf_bills', []) || [];
  const bill = allBills.find((b) => b.id === billId);
  if (!bill || !bill.pdfData) {
    showToast('Could not load document data');
    return;
  }
  try {
    const binary = atob(bill.pdfData.split(',').pop());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const wb = XLSX.read(bytes, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    _acProcessImport(projId, rows, bill.fileName || bill.name || 'Saved Document');
  } catch (err) {
    showToast('Could not parse document: ' + err.message);
  }
}

function renderMeetingsList(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.meetings = p.meetings || [];
  p.recurringMeetings = p.recurringMeetings || [];
  const el = document.getElementById('mtg-list-' + projId);
  if (!el) return;
  let mtgs = [...p.meetings].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (_mtgFilter !== 'all') mtgs = mtgs.filter((m) => m.type === _mtgFilter);
  // Show recurring info
  const recurEl = document.getElementById('mtg-recur-info-' + projId);
  if (recurEl) {
    const active = p.recurringMeetings.filter((r) => r.active);
    if (active.length) {
      const nths = ['', '1st', '2nd', '3rd', '4th'];
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      recurEl.innerHTML = active
        .map(
          (r) =>
            `<div style="font-size:12px;color:var(--text2);padding:6px 10px;background:var(--s2);border:1px solid var(--border);border-radius:6px;margin-bottom:4px">🔄 Every ${nths[r.nthWeek]} ${dayNames[r.weekday]} at ${r.time} · Auto-generates ${r.autoGenerateDaysBefore} days before</div>`,
        )
        .join('');
    } else recurEl.innerHTML = '';
  }
  // Saved reports from en_report_history
  let reportRows = '';
  if (_mtgFilter === 'all' || _mtgFilter === 'report') {
    const rptHistory = DB.get('en_report_history', []);
    const projReports = rptHistory.filter((h) => String(h.projectId) === String(projId));
    reportRows = projReports
      .map((r) => {
        const d = new Date(r.savedAt);
        const ds = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const ts = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `<div class="mtg-row" onclick="reopenReport('${r.id}')">
            <span class="mtg-date">${ds}</span>
            <span class="mtg-badge" style="background:rgba(59,130,246,0.15);color:#3b82f6">Report</span>
            <span class="mtg-title">${r.period || ''} ${r.type === 'quarterly' ? 'Quarterly' : 'Annual'} Report · ${ts}</span>
            <div class="mtg-actions" onclick="event.stopPropagation()">
              <button class="btn btn-ghost btn-sm" onclick="reopenReport('${r.id}')" title="Open">📊</button>
              <button class="btn btn-ghost btn-sm" onclick="reexportReport('${r.id}')" title="Export PDF">📄</button>
              <button class="btn btn-ghost btn-sm" onclick="deleteReport('${r.id}');renderMeetingsList(${projId})" title="Delete" style="color:var(--warn)">🗑️</button>
            </div>
          </div>`;
      })
      .join('');
  }

  if (!mtgs.length && !reportRows) {
    el.innerHTML =
      '<div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">No meetings yet. Click "+ New Agenda" to create one.</div>';
    return;
  }
  el.innerHTML =
    mtgs
      .map((m) => {
        const d = new Date(m.date);
        const ds = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const badge = m.type === 'agenda' ? 'mtg-badge-agenda' : 'mtg-badge-minutes';
        const label = m.type === 'agenda' ? 'Agenda' : 'Minutes';
        return `<div class="mtg-row" onclick="openMeetingEditor(${projId},${m.id})">
            <span class="mtg-date">${ds}</span>
            <span class="mtg-badge ${badge}">${label}</span>
            <span class="mtg-title">${m.projectNickname || ''} — ${m.sectionHeading || ''}</span>
            <div class="mtg-actions" onclick="event.stopPropagation()">
              <button class="btn btn-ghost btn-sm" onclick="generateMeetingPDFById(${projId},${m.id})" title="Download PDF">📄</button>
              ${m.type === 'agenda' ? `<button class="btn btn-ghost btn-sm" onclick="convertToMinutesById(${projId},${m.id})" title="Convert to Minutes">📝</button>` : ''}
              <button class="btn btn-ghost btn-sm" onclick="deleteMeeting(${projId},${m.id})" title="Delete" style="color:var(--warn)">🗑️</button>
            </div>
          </div>`;
      })
      .join('') + reportRows;
}

function openMeetingEditor(projId, meetingId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.meetings = p.meetings || [];
  const tmpl = getDefaultTemplate();
  _editingMeetingProjId = projId;
  if (meetingId) {
    _editingMeeting = JSON.parse(JSON.stringify(p.meetings.find((m) => m.id === meetingId)));
    if (!_editingMeeting) return;
  } else {
    let now = new Date();
    now.setMinutes(0);
    now.setSeconds(0);
    // Auto-populate date from recurring schedule
    const _recur = (p.recurringMeetings || []).find((r) => r.active);
    if (_recur && typeof getNthWeekdayOfMonth === 'function') {
      for (let offset = 0; offset < 3; offset++) {
        const checkDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const meetDate = getNthWeekdayOfMonth(
          checkDate.getFullYear(),
          checkDate.getMonth(),
          _recur.nthWeek,
          _recur.weekday,
        );
        if (meetDate && meetDate >= new Date()) {
          const dateStr = meetDate.toISOString().slice(0, 10);
          const exists = (p.meetings || []).some(
            (m) => m.type === 'agenda' && m.date && m.date.slice(0, 10) === dateStr,
          );
          if (!exists) {
            meetDate.setHours(parseInt(_recur.time?.split(':')[0]) || 9, parseInt(_recur.time?.split(':')[1]) || 0);
            now = meetDate;
            break;
          }
        }
      }
    }
    _editingMeeting = {
      id: Date.now(),
      type: 'agenda',
      linkedAgendaId: null,
      date: now.toISOString().slice(0, 16),
      projectNickname: p.client || p.name || '',
      contactTables: [
        { label: 'Control Service Company Key Contacts', contacts: JSON.parse(JSON.stringify(tmpl.cscContacts)) },
        {
          label: (p.client || p.name || 'Project') + ' Key Contacts',
          contacts: (p.contacts || []).map((c) => ({
            name: ((c.title ? c.title + ' ' : '') + c.first + ' ' + c.last).trim(),
            phone: c.phone || '',
            email: c.email || '',
          })),
        },
      ],
      sectionHeading: tmpl.sectionHeading,
      topics: JSON.parse(
        JSON.stringify(tmpl.defaultTopics || [{ text: tmpl.defaultEndTopic || 'Questions?', subItems: [] }]),
      ),
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Carry forward topics from previous meeting if enabled
    if (_recur && _recur.carryForward) {
      const lastAgenda = (p.meetings || [])
        .filter((m) => m.type === 'agenda')
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (lastAgenda && lastAgenda.topics) _editingMeeting.topics = JSON.parse(JSON.stringify(lastAgenda.topics));
    }
  }
  document.getElementById('meetingModalTitle').textContent = meetingId
    ? `Edit Meeting ${_editingMeeting.type === 'agenda' ? 'Agenda' : 'Minutes'}`
    : 'New Meeting Agenda';
  document.getElementById('mtgConvertBtn').style.display = _editingMeeting.type === 'agenda' && meetingId ? '' : 'none';
  renderMeetingEditorBody();
  document.getElementById('meetingModal').classList.add('open');
  // Trigger PDF preview after modal opens
  setTimeout(mtgSchedulePreview, 300);
}

function renderMeetingEditorBody() {
  const m = _editingMeeting;
  if (!m) return;
  const body = document.getElementById('meetingModalBody');
  let h = '';
  // Header section
  h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <div class="fg"><label class="fl">Project Nickname</label><input class="fi" id="mtg-nickname" value="${esc(m.projectNickname)}" oninput="mtgSchedulePreview()"></div>
          <div class="fg"><label class="fl">Document Type</label>
            <div style="display:flex;gap:4px;margin-top:4px">
              <button class="ptpill ${m.type === 'agenda' ? 'sel' : ''}" onclick="_editingMeeting.type='agenda';renderMeetingEditorBody()">Agenda</button>
              <button class="ptpill ${m.type === 'minutes' ? 'sel' : ''}" onclick="_editingMeeting.type='minutes';renderMeetingEditorBody()">Minutes</button>
            </div>
          </div>
          <div class="fg"><label class="fl">Meeting Date & Time</label><input class="fi" type="datetime-local" id="mtg-date" value="${m.date}" oninput="mtgSchedulePreview()"></div>
          <div class="fg"><label class="fl">Section Heading</label><input class="fi" id="mtg-heading" value="${esc(m.sectionHeading)}" oninput="mtgSchedulePreview()"></div>
        </div>`;
  // Recurring schedule section
  const _p = projects.find((x) => x.id === _editingMeetingProjId);
  const tmpl = getDefaultTemplate();
  const _recur = (_p?.recurringMeetings || []).find((r) => r.active) || null;
  const _nths = ['', '1st', '2nd', '3rd', '4th'];
  const _dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  h += `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:16px;background:var(--s1)">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600">
            <input type="checkbox" id="mtg-recur-toggle" ${_recur ? 'checked' : ''} onchange="mtgToggleRecurring(this.checked)"> Make this a recurring meeting
          </label>
          <div id="mtg-recur-fields" style="display:${_recur ? '' : 'none'};margin-top:10px">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px">
              <span>Every</span>
              <select class="fs" id="mtg-recur-nth" style="width:70px">${_nths
                .slice(1)
                .map(
                  (n, i) =>
                    `<option value="${i + 1}" ${_recur && _recur.nthWeek === i + 1 ? 'selected' : ''}>${n}</option>`,
                )
                .join('')}</select>
              <select class="fs" id="mtg-recur-day" style="width:110px">${_dayNames.map((d, i) => `<option value="${i}" ${_recur && _recur.weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
              <span>at</span>
              <input class="fi" type="time" id="mtg-recur-time" style="width:100px" value="${_recur?.time || '09:00'}">
              <span style="margin-left:12px">Auto-generate</span>
              <input class="fi" type="number" id="mtg-recur-days" style="width:50px" min="1" max="30" value="${_recur?.autoGenerateDaysBefore || 7}">
              <span>days before</span>
            </div>
          </div>
        </div>`;
  // Contact tables
  h += `<div style="font-size:13px;font-weight:700;margin-bottom:8px">Contact Tables</div>`;
  m.contactTables.forEach((ct, ti) => {
    h += `<div class="mtg-contact-tbl" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <input class="fi" style="flex:1;font-weight:700;font-style:italic" value="${esc(ct.label)}" onchange="mtgUpdateCtLabel(${ti},this.value)">
              ${ti >= 2 ? `<button class="btn btn-ghost btn-sm" onclick="mtgRemoveContactTable(${ti})" style="color:var(--warn)">✕</button>` : ''}
            </div>
            <div class="mtg-contact-hdr"><span>Name</span><span>Mobile Phone</span><span>E-mail</span><span style="width:28px"></span></div>`;
    // Build picker source
    const _projContacts = _p?.contacts || [];
    const _tmplContacts = tmpl.cscContacts || [];
    const _pickerSrc = ti === 0 ? _tmplContacts : _projContacts;

    ct.contacts.forEach((c, ci) => {
      const pickerHtml = _pickerSrc.length
        ? `<select class="fs" style="width:auto;min-width:44px;flex-shrink:0;padding:4px" onchange="mtgPickContact(${ti},${ci},this.value,${ti === 0})"><option value="">📋</option>${_pickerSrc
            .map((pc, pci) => {
              const pcName = pc.name || ((pc.first || '') + (pc.last ? ' ' + pc.last : '')).trim() || 'Contact';
              return '<option value="' + pci + '">' + esc(pcName) + '</option>';
            })
            .join('')}</select>`
        : '';
      h += `<div class="mtg-contact-row">
              <div style="display:flex;gap:4px;flex:1">${pickerHtml}<input class="fi" style="flex:1" value="${esc(c.name)}" onchange="mtgUpdateContact(${ti},${ci},'name',this.value)"></div>
              <input class="fi" value="${esc(c.phone)}" onchange="mtgUpdateContact(${ti},${ci},'phone',this.value)">
              <input class="fi" value="${esc(c.email)}" onchange="mtgUpdateContact(${ti},${ci},'email',this.value)">
              <button class="btn btn-ghost btn-sm" onclick="mtgRemoveContact(${ti},${ci})" style="color:var(--warn)">✕</button>
            </div>`;
    });
    h += `<button class="btn btn-ghost btn-sm" style="margin-top:4px" onclick="mtgAddContact(${ti})">+ Contact</button></div>`;
  });
  h += `<button class="btn btn-ghost btn-sm" style="margin-bottom:16px" onclick="mtgAddContactTable()">+ Add Contact Table</button>`;
  // Topics
  h += `<div style="font-size:13px;font-weight:700;margin-bottom:8px">Topics</div>`;
  m.topics.forEach((t, ti) => {
    const isLast = t.text.trim().toLowerCase() === 'questions?';
    h += `<div class="mtg-topic-item">
            <div class="mtg-topic-num">${ti + 1}.</div>
            <div class="mtg-topic-body">
              <div style="display:flex;gap:6px;align-items:center">
                <input class="fi" style="flex:1" value="${esc(t.text)}" onchange="mtgUpdateTopic(${ti},this.value)" ${isLast ? 'readonly' : ''}>
                <div style="display:flex;gap:2px">
                  ${ti > 0 && !isLast ? `<button class="btn btn-ghost btn-sm" onclick="mtgMoveTopic(${ti},-1)">▲</button>` : ''}
                  ${ti < m.topics.length - 2 ? `<button class="btn btn-ghost btn-sm" onclick="mtgMoveTopic(${ti},1)">▼</button>` : ''}
                  ${!isLast ? `<button class="btn btn-ghost btn-sm" style="color:var(--warn)" onclick="mtgRemoveTopic(${ti})">✕</button>` : ''}
                </div>
              </div>`;
    // Sub-items
    t.subItems.forEach((si, sii) => {
      h += `<div class="mtg-sub-item">
              <span class="mtg-sub-letter">${String.fromCharCode(97 + sii)}.</span>
              <input class="fi" style="flex:1" value="${esc(si)}" onchange="mtgUpdateSubItem(${ti},${sii},this.value)">
              <button class="btn btn-ghost btn-sm" style="color:var(--warn)" onclick="mtgRemoveSubItem(${ti},${sii})">✕</button>
            </div>`;
    });
    if (!isLast)
      h += `<button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:11px" onclick="mtgAddSubItem(${ti})">+ Sub-item</button>`;
    h += `</div></div>`;
  });
  h += `<button class="btn btn-ghost btn-sm" onclick="mtgAddTopic()">+ Add Topic</button>`;
  body.innerHTML = h;
  mtgSchedulePreview();
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Contact table helpers
function mtgUpdateCtLabel(ti, v) {
  _editingMeeting.contactTables[ti].label = v;
  mtgSchedulePreview();
}
function mtgUpdateContact(ti, ci, f, v) {
  _editingMeeting.contactTables[ti].contacts[ci][f] = v;
  mtgSchedulePreview();
}
function mtgAddContact(ti) {
  _editingMeeting.contactTables[ti].contacts.push({ name: '', phone: '', email: '' });
  renderMeetingEditorBody();
}
function mtgRemoveContact(ti, ci) {
  _editingMeeting.contactTables[ti].contacts.splice(ci, 1);
  renderMeetingEditorBody();
}
function mtgAddContactTable() {
  _editingMeeting.contactTables.push({
    label: 'Additional Contacts',
    contacts: [{ name: '', phone: '', email: '' }],
  });
  renderMeetingEditorBody();
}
function mtgRemoveContactTable(ti) {
  _editingMeeting.contactTables.splice(ti, 1);
  renderMeetingEditorBody();
}
function mtgPickContact(tableIdx, contactIdx, pickerValue, isCsc) {
  if (pickerValue === '' || pickerValue === undefined) return;
  const idx = parseInt(pickerValue);
  const p = projects.find((x) => x.id === _editingMeetingProjId);
  const tmpl = getDefaultTemplate();
  const src = isCsc ? (tmpl.cscContacts || [])[idx] : (p?.contacts || [])[idx];
  if (!src) return;
  const ct = _editingMeeting.contactTables[tableIdx];
  if (!ct || !ct.contacts[contactIdx]) return;
  const name =
    src.name || ((src.title ? src.title + ' ' : '') + (src.first || '') + (src.last ? ' ' + src.last : '')).trim();
  ct.contacts[contactIdx].name = name;
  ct.contacts[contactIdx].phone = src.phone || '';
  ct.contacts[contactIdx].email = src.email || '';
  renderMeetingEditorBody();
}

// Topic helpers
function mtgUpdateTopic(ti, v) {
  _editingMeeting.topics[ti].text = v;
  mtgSchedulePreview();
}
function mtgUpdateSubItem(ti, si, v) {
  _editingMeeting.topics[ti].subItems[si] = v;
  mtgSchedulePreview();
}
function mtgAddSubItem(ti) {
  _editingMeeting.topics[ti].subItems.push('');
  renderMeetingEditorBody();
}
function mtgRemoveSubItem(ti, si) {
  _editingMeeting.topics[ti].subItems.splice(si, 1);
  renderMeetingEditorBody();
}
function mtgAddTopic() {
  const q = _editingMeeting.topics.findIndex((t) => t.text.trim().toLowerCase() === 'questions?');
  const newT = { text: '', subItems: [''] };
  if (q >= 0) _editingMeeting.topics.splice(q, 0, newT);
  else _editingMeeting.topics.push(newT);
  renderMeetingEditorBody();
}
function mtgMoveTopic(ti, dir) {
  const arr = _editingMeeting.topics;
  const ni = ti + dir;
  if (ni < 0 || ni >= arr.length) return;
  [arr[ti], arr[ni]] = [arr[ni], arr[ti]];
  renderMeetingEditorBody();
}
function mtgRemoveTopic(ti) {
  _editingMeeting.topics.splice(ti, 1);
  renderMeetingEditorBody();
}

function mtgToggleRecurring(checked) {
  const el = document.getElementById('mtg-recur-fields');
  if (el) el.style.display = checked ? '' : 'none';
}

let _mtgPreviewTimer = null;
function mtgSchedulePreview() {
  clearTimeout(_mtgPreviewTimer);
  _mtgPreviewTimer = setTimeout(mtgRenderPreview, 500);
}

function mtgRenderPreview() {
  if (!_editingMeeting) return;
  const frame = document.getElementById('mtgPreviewFrame');
  if (!frame) return;
  try {
    const nick = document.getElementById('mtg-nickname');
    if (nick) _editingMeeting.projectNickname = nick.value;
    const dt = document.getElementById('mtg-date');
    if (dt) _editingMeeting.date = dt.value;
    const hd = document.getElementById('mtg-heading');
    if (hd) _editingMeeting.sectionHeading = hd.value;
    const doc = buildMeetingPDF(_editingMeeting, true);
    if (doc) {
      const uri = doc.output('datauristring');
      frame.src = uri;
    }
  } catch (e) {
    console.warn('Meeting preview error:', e);
  }
}

function closeMeetingModal() {
  document.getElementById('meetingModal').classList.remove('open');
  _editingMeeting = null;
  _editingMeetingProjId = null;
}

function saveMeeting() {
  if (!_editingMeeting || !_editingMeetingProjId) return;
  // Sync fields from inputs
  const nick = document.getElementById('mtg-nickname');
  if (nick) _editingMeeting.projectNickname = nick.value;
  const dt = document.getElementById('mtg-date');
  if (dt) _editingMeeting.date = dt.value;
  const hd = document.getElementById('mtg-heading');
  if (hd) _editingMeeting.sectionHeading = hd.value;
  _editingMeeting.updatedAt = new Date().toISOString();
  // History snapshot
  _editingMeeting.history = _editingMeeting.history || [];
  const isNew = !projects
    .find((x) => x.id === _editingMeetingProjId)
    ?.meetings?.find((m) => m.id === _editingMeeting.id);
  const snap = JSON.parse(JSON.stringify(_editingMeeting));
  delete snap.history;
  _editingMeeting.history.push({
    timestamp: new Date().toISOString(),
    action: isNew ? 'created' : 'edited',
    snapshot: snap,
  });
  if (_editingMeeting.history.length > 20) _editingMeeting.history = _editingMeeting.history.slice(-20);
  // Save to project
  const p = projects.find((x) => x.id === _editingMeetingProjId);
  if (!p) return;
  p.meetings = p.meetings || [];
  const idx = p.meetings.findIndex((m) => m.id === _editingMeeting.id);
  if (idx >= 0) p.meetings[idx] = _editingMeeting;
  else {
    _editingMeeting.createdAt = new Date().toISOString();
    p.meetings.push(_editingMeeting);
  }
  sset('en_projects', projects);
  // Save recurring schedule if configured in editor
  const _recurToggle = document.getElementById('mtg-recur-toggle');
  if (_recurToggle) {
    p.recurringMeetings = p.recurringMeetings || [];
    if (_recurToggle.checked) {
      const _r = {
        id: p.recurringMeetings[0]?.id || Date.now(),
        pattern: 'nthWeekday',
        nthWeek: parseInt(document.getElementById('mtg-recur-nth')?.value) || 2,
        weekday: parseInt(document.getElementById('mtg-recur-day')?.value) || 1,
        time: document.getElementById('mtg-recur-time')?.value || '09:00',
        timezone: 'America/Chicago',
        autoGenerateDaysBefore: parseInt(document.getElementById('mtg-recur-days')?.value) || 7,
        active: true,
        carryForward: p.recurringMeetings[0]?.carryForward || false,
      };
      if (p.recurringMeetings.length) p.recurringMeetings[0] = _r;
      else p.recurringMeetings.push(_r);
    } else {
      p.recurringMeetings.forEach((r) => (r.active = false));
    }
    sset('en_projects', projects);
  }
  // Create task for this meeting
  if (isNew) createMeetingTask(p, _editingMeeting);
  renderMeetingsList(_editingMeetingProjId);
  showToast('Meeting saved ✓');
  closeMeetingModal();
}

function createMeetingTask(p, m) {
  tasks = sget('en_tasks', []);
  const exists = tasks.some(
    (t) =>
      t.text &&
      t.text.includes('Meeting:') &&
      t.text.includes(m.projectNickname) &&
      t.due === (m.date || '').split('T')[0],
  );
  if (exists) return;
  tasks.push({
    id: Date.now() + 1,
    text: `Meeting: ${m.projectNickname} — ${m.type === 'agenda' ? 'Agenda' : 'Minutes'}`,
    due: (m.date || '').split('T')[0],
    projId: p.id,
    pri: 'normal',
    done: false,
  });
  sset('en_tasks', tasks);
}

async function deleteMeeting(projId, meetingId) {
  if (!(await confirmAsync('Delete this meeting?'))) return;
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.meetings = (p.meetings || []).filter((m) => m.id !== meetingId);
  sset('en_projects', projects);
  renderMeetingsList(projId);
  showToast('Meeting deleted');
}

function convertToMinutes() {
  if (!_editingMeeting || _editingMeeting.type !== 'agenda') return;
  // Sync fields first
  const nick = document.getElementById('mtg-nickname');
  if (nick) _editingMeeting.projectNickname = nick.value;
  const dt = document.getElementById('mtg-date');
  if (dt) _editingMeeting.date = dt.value;
  const hd = document.getElementById('mtg-heading');
  if (hd) _editingMeeting.sectionHeading = hd.value;
  // Save original agenda first
  saveMeeting();
  // Create minutes copy
  const p = projects.find((x) => x.id === _editingMeetingProjId);
  if (!p) return;
  const agenda = p.meetings.find((m) => m.id === _editingMeeting?.id || m.type === 'agenda');
  const lastAgenda = p.meetings
    .filter((m) => m.type === 'agenda')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  const src = agenda || lastAgenda;
  if (!src) return;
  const minutes = JSON.parse(JSON.stringify(src));
  minutes.id = Date.now();
  minutes.type = 'minutes';
  minutes.linkedAgendaId = src.id;
  minutes.history = [{ timestamp: new Date().toISOString(), action: 'converted_from_agenda', snapshot: null }];
  minutes.createdAt = new Date().toISOString();
  minutes.updatedAt = new Date().toISOString();
  p.meetings.push(minutes);
  sset('en_projects', projects);
  createMeetingTask(p, minutes);
  showToast('Minutes created from agenda ✓');
  openMeetingEditor(_editingMeetingProjId, minutes.id);
}

function convertToMinutesById(projId, meetingId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const agenda = (p.meetings || []).find((m) => m.id === meetingId);
  if (!agenda || agenda.type !== 'agenda') return;
  const minutes = JSON.parse(JSON.stringify(agenda));
  minutes.id = Date.now();
  minutes.type = 'minutes';
  minutes.linkedAgendaId = agenda.id;
  minutes.history = [{ timestamp: new Date().toISOString(), action: 'converted_from_agenda', snapshot: null }];
  minutes.createdAt = new Date().toISOString();
  minutes.updatedAt = new Date().toISOString();
  p.meetings.push(minutes);
  sset('en_projects', projects);
  createMeetingTask(p, minutes);
  renderMeetingsList(projId);
  showToast('Minutes created from agenda ✓');
  openMeetingEditor(projId, minutes.id);
}

function showMeetingHistory() {
  if (!_editingMeeting) return;
  const hist = _editingMeeting.history || [];
  const body = document.getElementById('mtgHistoryBody');
  if (!hist.length) {
    body.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px">No history yet.</div>';
  } else {
    body.innerHTML = hist
      .slice()
      .reverse()
      .map((h) => {
        const d = new Date(h.timestamp);
        return `<div class="mtg-hist-item">
              <div><span style="font-weight:600">${h.action}</span><span style="color:var(--text3);margin-left:8px">${d.toLocaleDateString()} ${d.toLocaleTimeString()}</span></div>
            </div>`;
      })
      .join('');
  }
  document.getElementById('mtgHistoryModal').classList.add('open');
}

// ── Recurring Meeting System ──
function openRecurringSetup(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.recurringMeetings = p.recurringMeetings || [];
  const r = p.recurringMeetings[0] || {
    id: Date.now(),
    pattern: 'nthWeekday',
    nthWeek: 2,
    weekday: 1,
    time: '09:00',
    timezone: 'America/Chicago',
    autoGenerateDaysBefore: 7,
    active: true,
    carryForward: true,
  };
  const nths = ['', '1st', '2nd', '3rd', '4th'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const body = document.getElementById('recurringModalBody');
  body.innerHTML = `
          <div class="mtg-recur-row">
            <span style="font-size:13px;font-weight:600">Every</span>
            <select class="fs" id="recur-nth" style="width:80px">${nths
              .slice(1)
              .map((n, i) => `<option value="${i + 1}" ${r.nthWeek === i + 1 ? 'selected' : ''}>${n}</option>`)
              .join('')}</select>
            <select class="fs" id="recur-day" style="width:120px">${days.map((d, i) => `<option value="${i}" ${r.weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
            <span style="font-size:13px">of the month</span>
          </div>
          <div class="mtg-recur-row">
            <span style="font-size:13px;font-weight:600">Time</span>
            <input type="time" class="fi" id="recur-time" value="${r.time}" style="width:120px">
            <span style="font-size:12px;color:var(--text2)">Central Time</span>
          </div>
          <div class="mtg-recur-row">
            <span style="font-size:13px;font-weight:600">Auto-generate agenda</span>
            <input type="number" class="fi" id="recur-days" value="${r.autoGenerateDaysBefore}" min="1" max="30" style="width:60px">
            <span style="font-size:13px">days before meeting</span>
          </div>
          <div class="mtg-recur-row">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
              <input type="checkbox" id="recur-carry" ${r.carryForward ? 'checked' : ''}>
              Carry forward topics from previous meeting
            </label>
          </div>
          <div class="mtg-recur-row">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
              <input type="checkbox" id="recur-active" ${r.active ? 'checked' : ''}>
              Active
            </label>
          </div>
          <input type="hidden" id="recur-projId" value="${projId}">
          <input type="hidden" id="recur-id" value="${r.id}">`;
  document.getElementById('recurringModal').classList.add('open');
}

function closeRecurringModal() {
  document.getElementById('recurringModal').classList.remove('open');
}

function saveRecurring() {
  const projId = parseInt(document.getElementById('recur-projId').value);
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.recurringMeetings = p.recurringMeetings || [];
  const r = {
    id: parseInt(document.getElementById('recur-id').value) || Date.now(),
    pattern: 'nthWeekday',
    nthWeek: parseInt(document.getElementById('recur-nth').value),
    weekday: parseInt(document.getElementById('recur-day').value),
    time: document.getElementById('recur-time').value,
    timezone: 'America/Chicago',
    autoGenerateDaysBefore: parseInt(document.getElementById('recur-days').value) || 7,
    active: document.getElementById('recur-active').checked,
    carryForward: document.getElementById('recur-carry').checked,
  };
  const idx = p.recurringMeetings.findIndex((x) => x.id === r.id);
  if (idx >= 0) p.recurringMeetings[idx] = r;
  else p.recurringMeetings.push(r);
  sset('en_projects', projects);
  closeRecurringModal();
  renderMeetingsList(projId);
  showToast('Recurring schedule saved ✓');
}

function getNthWeekdayOfMonth(year, month, nth, weekday) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(year, month, day);
    if (d.getMonth() !== month) break;
    if (d.getDay() === weekday) {
      count++;
      if (count === nth) return d;
    }
  }
  return null;
}

function checkRecurringMeetings() {
  const now = new Date();
  let generated = 0;
  projects.forEach((p) => {
    (p.recurringMeetings || []).forEach((rm) => {
      if (!rm.active) return;
      for (let mOff = 0; mOff <= 2; mOff++) {
        const y = now.getFullYear();
        const m = now.getMonth() + mOff;
        const meetDate = getNthWeekdayOfMonth(y, m, rm.nthWeek, rm.weekday);
        if (!meetDate) continue;
        const [hh, mm] = (rm.time || '09:00').split(':');
        meetDate.setHours(parseInt(hh) || 9, parseInt(mm) || 0, 0, 0);
        const generateBy = new Date(meetDate);
        generateBy.setDate(generateBy.getDate() - (rm.autoGenerateDaysBefore || 7));
        if (now >= generateBy && now <= meetDate) {
          const dateStr = meetDate.toISOString().split('T')[0];
          p.meetings = p.meetings || [];
          const exists = p.meetings.some((mx) => mx.date && mx.date.startsWith(dateStr) && mx.type === 'agenda');
          if (!exists) {
            const tmpl = getDefaultTemplate();
            // Carry forward topics from last agenda
            let topics = [{ text: tmpl.defaultEndTopic, subItems: [] }];
            if (rm.carryForward) {
              const lastAgenda = p.meetings
                .filter((mx) => mx.type === 'agenda')
                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
              if (lastAgenda) topics = JSON.parse(JSON.stringify(lastAgenda.topics));
            }
            const agenda = {
              id: Date.now() + generated,
              type: 'agenda',
              linkedAgendaId: null,
              date: meetDate.toISOString().slice(0, 16),
              projectNickname: p.client || p.name || '',
              contactTables: [
                {
                  label: 'Control Service Company Key Contacts',
                  contacts: JSON.parse(JSON.stringify(tmpl.cscContacts)),
                },
                {
                  label: (p.client || p.name || 'Project') + ' Key Contacts',
                  contacts: (p.contacts || []).map((c) => ({
                    name: ((c.title ? c.title + ' ' : '') + c.first + ' ' + c.last).trim(),
                    phone: c.phone || '',
                    email: c.email || '',
                  })),
                },
              ],
              sectionHeading: tmpl.sectionHeading,
              topics: topics,
              history: [{ timestamp: new Date().toISOString(), action: 'auto_generated', snapshot: null }],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            p.meetings.push(agenda);
            createMeetingTask(p, agenda);
            generated++;
          }
        }
      }
    });
  });
  if (generated > 0) {
    sset('en_projects', projects);
    showToast(`Auto-generated ${generated} meeting agenda${generated > 1 ? 's' : ''} ✓`);
  }
}

// ── Meeting Template Settings ──
function openMtgTemplateSettings() {
  const t = getDefaultTemplate();
  const body = document.getElementById('mtgTemplateBody');
  let h = `<div class="fg"><label class="fl">Template Name</label><input class="fi" id="tmpl-name" value="${esc(t.name)}"></div>
          <div class="fg"><label class="fl">Section Heading</label><input class="fi" id="tmpl-heading" value="${esc(t.sectionHeading)}"></div>
          <div class="fg"><label class="fl">Default End Topic</label><input class="fi" id="tmpl-endtopic" value="${esc(t.defaultEndTopic)}"></div>
          <div style="font-size:13px;font-weight:700;margin:12px 0 8px">Default CSC Contacts</div>
          <div id="tmpl-contacts">`;
  t.cscContacts.forEach((c, i) => {
    h += `<div class="mtg-contact-row" style="margin-bottom:6px">
            <input class="fi" id="tc-name-${i}" value="${esc(c.name)}" placeholder="Name">
            <input class="fi" id="tc-phone-${i}" value="${esc(c.phone)}" placeholder="Phone">
            <input class="fi" id="tc-email-${i}" value="${esc(c.email)}" placeholder="Email">
            <button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()" style="color:var(--warn)">✕</button>
          </div>`;
  });
  h += `</div><button class="btn btn-ghost btn-sm" onclick="addTmplContact()">+ Contact</button>`;
  body.innerHTML = h;
  document.getElementById('mtgTemplateModal').classList.add('open');
}

function addTmplContact() {
  const container = document.getElementById('tmpl-contacts');
  const i = container.children.length;
  const div = document.createElement('div');
  div.className = 'mtg-contact-row';
  div.style.marginBottom = '6px';
  div.innerHTML = `<input class="fi" id="tc-name-${i}" value="" placeholder="Name">
          <input class="fi" id="tc-phone-${i}" value="" placeholder="Phone">
          <input class="fi" id="tc-email-${i}" value="" placeholder="Email">
          <button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()" style="color:var(--warn)">✕</button>`;
  container.appendChild(div);
}

function saveMeetingTemplate() {
  const t = getDefaultTemplate();
  t.name = document.getElementById('tmpl-name').value;
  t.sectionHeading = document.getElementById('tmpl-heading').value;
  t.defaultEndTopic = document.getElementById('tmpl-endtopic').value;
  const rows = document.getElementById('tmpl-contacts').children;
  t.cscContacts = [];
  for (let i = 0; i < rows.length; i++) {
    const inputs = rows[i].querySelectorAll('input');
    if (inputs.length >= 3 && inputs[0].value.trim()) {
      t.cscContacts.push({ name: inputs[0].value, phone: inputs[1].value, email: inputs[2].value });
    }
  }
  sset('en_meetingTemplates', t);
  document.getElementById('mtgTemplateModal').classList.remove('open');
  showToast('Template saved ✓');
}

// ── PDF Generation Engine ──
function generateMeetingPDFById(projId, meetingId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const m = (p.meetings || []).find((mx) => mx.id === meetingId);
  if (!m) return;
  buildMeetingPDF(m);
}

function generateMeetingPDF() {
  if (!_editingMeeting) return;
  // Sync fields
  const nick = document.getElementById('mtg-nickname');
  if (nick) _editingMeeting.projectNickname = nick.value;
  const dt = document.getElementById('mtg-date');
  if (dt) _editingMeeting.date = dt.value;
  const hd = document.getElementById('mtg-heading');
  if (hd) _editingMeeting.sectionHeading = hd.value;
  buildMeetingPDF(_editingMeeting);
}

function buildMeetingPDF(m, returnDoc) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pw = 612,
    ph = 792;
  const ml = 54,
    mr = 40,
    mt = 36;
  const contentW = pw - ml - mr;
  const footerH = 55;
  const headerH = 145;
  let y = mt;
  let pageNum = 1;

  function addFooter() {
    try {
      doc.addImage(CSC_FOOTER_B64, 'JPEG', 0, ph - footerH, pw, footerH);
    } catch (e) {}
  }

  function checkPage(needed) {
    if (y + needed > ph - footerH - 20) {
      addFooter();
      doc.addPage();
      pageNum++;
      y = mt + 20;
    }
  }

  // Page 1 header
  try {
    doc.addImage(CSC_HEADER_B64, 'JPEG', 0, 0, pw, headerH);
  } catch (e) {}
  y = headerH + 10;

  // Title block - centered
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(0, 0, 0);
  const titleX = pw / 2;

  // Project nickname
  doc.text(m.projectNickname || '', titleX, y, { align: 'center' });
  y += 16;

  // Document type
  const typeLabel = m.type === 'agenda' ? 'Meeting Agenda' : 'Meeting Minutes';
  doc.text((m.sectionHeading || 'Energy Management Services').replace(' Program', '') + ' ' + typeLabel, titleX, y, {
    align: 'center',
  });
  y += 16;

  // Meeting date
  const md = new Date(m.date);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
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
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'],
      v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const dayName = dayNames[md.getDay()];
  const monthName = monthNames[md.getMonth()];
  const dateStr = ordinal(md.getDate());
  const timeStr = md
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '');
  const dateLineBase = `Meeting Date: ${dayName} ${monthName} `;
  const dateLineSuffix = `, ${md.getFullYear()} ${timeStr}`;

  // Render date with superscript ordinal
  doc.setFontSize(11);
  const baseW = doc.getTextWidth(dateLineBase);
  const numPart = String(md.getDate());
  const ordSuffix = ordinal(md.getDate()).replace(numPart, '');
  const numW = doc.getTextWidth(numPart);
  const fullDateLine = `Meeting Date: ${dayName} ${monthName} ${dateStr}, ${md.getFullYear()} ${timeStr}`;
  const fullW = doc.getTextWidth(fullDateLine);
  const startX = titleX - fullW / 2;
  doc.text(dateLineBase, startX, y);
  doc.text(numPart, startX + baseW, y);
  doc.setFontSize(7);
  doc.text(ordSuffix, startX + baseW + numW, y - 3);
  doc.setFontSize(11);
  doc.text(dateLineSuffix, startX + baseW + numW + doc.getTextWidth(ordSuffix) + 1, y);
  y += 22;

  // Contact tables
  const colW = [contentW * 0.33, contentW * 0.25, contentW * 0.42];
  m.contactTables.forEach((ct) => {
    checkPage(60);
    // Table label - bold italic
    doc.setFont('helvetica', 'bolditalic');
    doc.setFontSize(10);
    doc.text(ct.label, ml, y);
    y += 14;
    // Column headers - underlined
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const headers = ['Name', 'Mobile Phone', 'E-mail'];
    let cx = ml;
    headers.forEach((h, i) => {
      doc.text(h, cx, y);
      const hw = doc.getTextWidth(h);
      doc.line(cx, y + 1, cx + hw, y + 1);
      cx += colW[i];
    });
    y += 13;
    // Contact rows
    doc.setFontSize(10);
    ct.contacts.forEach((c) => {
      checkPage(14);
      let cx2 = ml;
      doc.setTextColor(0, 0, 0);
      doc.text(c.name || '', cx2, y);
      cx2 += colW[0];
      doc.text(c.phone || '', cx2, y);
      cx2 += colW[1];
      // Email in blue with underline
      doc.setTextColor(0, 0, 200);
      doc.text(c.email || '', cx2, y);
      const ew = doc.getTextWidth(c.email || '');
      doc.line(cx2, y + 1, cx2 + ew, y + 1);
      doc.setTextColor(0, 0, 0);
      y += 13;
    });
    y += 8;
  });

  // Section heading
  checkPage(25);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  y += 4;
  doc.text(m.sectionHeading || 'Energy Management Services Program', ml, y);
  y += 18;

  // Numbered topics
  const topicIndent = ml + 20;
  const subIndent = topicIndent + 28;
  m.topics.forEach((t, ti) => {
    checkPage(20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    // Number and topic text
    doc.text(`${ti + 1}.`, ml + 4, y);
    const topicLines = doc.splitTextToSize(t.text || '', contentW - 30);
    topicLines.forEach((line, li) => {
      checkPage(14);
      doc.text(line, topicIndent, y);
      if (li < topicLines.length - 1) y += 13;
    });
    y += 14;
    // Sub-items
    t.subItems.forEach((si, sii) => {
      checkPage(14);
      doc.setFontSize(10);
      const letter = String.fromCharCode(97 + sii) + '.';
      doc.text(letter, topicIndent + 4, y);
      const subLines = doc.splitTextToSize(si || '', contentW - 65);
      subLines.forEach((line, li) => {
        checkPage(13);
        doc.text(line, subIndent, y);
        if (li < subLines.length - 1) y += 12;
      });
      y += 13;
    });
    y += 4;
  });

  // Add footer to last page
  addFooter();

  // Save
  const dateFile = (m.date || '').split('T')[0].replace(/-/g, '.');
  const filename = `${m.projectNickname || 'Meeting'} - ${(m.sectionHeading || '').replace(' Program', '')} ${m.type === 'agenda' ? 'Meeting Agenda' : 'Meeting Minutes'} ${dateFile}.pdf`;
  if (returnDoc) return doc;
  doc.save(filename);
  showToast('PDF generated ✓');
}

/* ── REPORT DATA COLLECTOR ── */
// Extracts a 2-letter US state code from a free-text address string.
// Looks for a 2-letter uppercase code before a ZIP code or at end of string.
// Falls back to 'KS' (Kansas) if no match — most CSC projects are in the KC metro.
function extractStateFromAddress(addr) {
  if (!addr) return 'KS';
  const m = addr.match(/\b([A-Z]{2})\b(?=\s*\d{5}|\s*$|,|\s*$)/);
  return m ? m[1] : 'KS';
}

// Collects monthly HDD/CDD weather data from normalized rows, grouped by
// baseline vs reporting-period months. Returns {monthly, totals}.
function collectWeatherData(allBldgMeters, reportYMs) {
  const byYm = {};
  var blStart = null,
    blEnd = null;
  allBldgMeters.forEach(({ allRows, bl }) => {
    const blRows = allRows.filter((r) => bl.months.includes(r.ym));
    // Track baseline period boundaries
    if (bl && bl.months && bl.months.length) {
      var sorted = bl.months.slice().sort();
      if (!blStart || sorted[0] < blStart) blStart = sorted[0];
      if (!blEnd || sorted[sorted.length - 1] > blEnd) blEnd = sorted[sorted.length - 1];
    }
    // Accumulate baseline weather per calendar month (averaged later)
    blRows.forEach((r) => {
      const mo = parseInt(r.ym.split('-')[1]) - 1;
      if (!byYm['bl_' + mo]) byYm['bl_' + mo] = { hdd: 0, cdd: 0, count: 0 };
      byYm['bl_' + mo].hdd += r.hdd || 0;
      byYm['bl_' + mo].cdd += r.cdd || 0;
      byYm['bl_' + mo].count++;
    });
    // ALL post-baseline weather by YYYY-MM (not just reporting period)
    allRows.forEach((r) => {
      if (r.ym > (blEnd || '')) {
        if (!byYm[r.ym]) byYm[r.ym] = { hdd: 0, cdd: 0, count: 0 };
        byYm[r.ym].hdd += r.hdd || 0;
        byYm[r.ym].cdd += r.cdd || 0;
        byYm[r.ym].count++;
      }
    });
  });
  // Generate chronological months from baseline start through report end
  var rpSet = new Set(reportYMs);
  var startYm = blStart || (reportYMs.length ? reportYMs[0] : null) || String(new Date().getFullYear()) + '-01';
  var endYm = reportYMs.length ? reportYMs[reportYMs.length - 1] : String(new Date().getFullYear()) + '-12';
  var monthly = [];
  let totHddBl = 0,
    totCddBl = 0,
    totHddCur = 0,
    totCddCur = 0;
  var startParts = startYm.split('-');
  var endParts = endYm.split('-');
  var curYr = parseInt(startParts[0]);
  var curMo = parseInt(startParts[1]);
  var endYr = parseInt(endParts[0]);
  var endMo = parseInt(endParts[1]);
  while (curYr < endYr || (curYr === endYr && curMo <= endMo)) {
    var _ym = curYr + '-' + String(curMo).padStart(2, '0');
    var calMo = curMo - 1;
    var blData = byYm['bl_' + calMo];
    var curData = byYm[_ym];
    var hddBl = blData ? blData.hdd / blData.count : 0;
    var cddBl = blData ? blData.cdd / blData.count : 0;
    var hddCur = curData ? curData.hdd / curData.count : 0;
    var cddCur = curData ? curData.cdd / curData.count : 0;
    var inPeriod = rpSet.has(_ym);
    monthly.push({ month: _ym, hddBl: hddBl, hddCur: hddCur, cddBl: cddBl, cddCur: cddCur, inPeriod: inPeriod });
    if (inPeriod) {
      totHddBl += hddBl;
      totHddCur += hddCur;
      totCddBl += cddBl;
      totCddCur += cddCur;
    }
    curMo++;
    if (curMo > 12) {
      curMo = 1;
      curYr++;
    }
  }
  return {
    monthly: monthly,
    totals: { hddBl: totHddBl, hddCur: totHddCur, cddBl: totCddBl, cddCur: totCddCur },
  };
}

/* ══════════════════════════════════════════
       BUILDING LIST IMPORT (Excel / CSV)
   ══════════════════════════════════════════ */
let _bldgImportRows = []; // parsed preview rows [{name, sqft, addr, zip}]

function openBldgImportModal() {
  _bldgImportRows = [];
  document.getElementById('bldgImportDropLabel').textContent = 'Drop .xlsx or .csv file, or click to browse';
  document.getElementById('bldgImportInput').value = '';
  document.getElementById('bldgImportPreviewWrap').style.display = 'none';
  document.getElementById('bldgImportBtn').style.display = 'none';
  document.getElementById('bldgImportModal').classList.add('open');
}
window.openBldgImportModal = openBldgImportModal;

function closeBldgImportModal() {
  document.getElementById('bldgImportModal').classList.remove('open');
  _bldgImportRows = [];
}
window.closeBldgImportModal = closeBldgImportModal;

function handleBldgImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  document.getElementById('bldgImportDropLabel').textContent = '⏳ Reading ' + file.name + '…';
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      let rows = [];
      const name = file.name.toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        // CSV path — split on newlines, skip header
        const lines = e.target.result
          .split(/\r?\n/)
          .map(function (l) {
            return l.trim();
          })
          .filter(function (l) {
            return l.length > 0;
          });
        if (lines.length < 2) {
          showToast('File appears empty', 'warn');
          return;
        }
        // Skip the header row (index 0)
        for (var i = 1; i < lines.length; i++) {
          var cols = splitCsvLine(lines[i]);
          rows.push([
            cols[0] || '',
            cols[1] || '',
            cols[2] || '',
            cols[5] !== undefined ? cols[5] : '', // F: KGS Service Address
            cols[6] !== undefined ? cols[6] : '', // G: KGS Account #
            cols[7] !== undefined ? cols[7] : '', // H: KGS Meter #
          ]);
        }
      } else {
        // Excel path — use SheetJS
        if (typeof XLSX === 'undefined') {
          showToast('Excel library not loaded — try a CSV export instead', 'warn');
          return;
        }
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        // Convert to 2D array, raw so numbers stay as numbers
        var arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        if (!arr || arr.length < 2) {
          showToast('Sheet appears empty', 'warn');
          return;
        }
        // Skip header row
        for (var j = 1; j < arr.length; j++) {
          var r = arr[j];
          // Skip fully blank rows
          if (!r[0] && !r[1] && !r[2]) continue;
          rows.push([
            r[0] || '',
            r[1] || '',
            r[2] || '',
            r[5] !== undefined ? String(r[5]) : '', // F: KGS Service Address
            r[6] !== undefined ? String(r[6]) : '', // G: KGS Account #
            r[7] !== undefined ? String(r[7]) : '', // H: KGS Meter #
          ]);
        }
      }

      if (!rows.length) {
        showToast('No data rows found in file', 'warn');
        return;
      }

      // Parse into structured objects
      _bldgImportRows = rows
        .map(function (r) {
          var rawName = String(r[0]).trim();
          var rawSqft = String(r[1]).trim();
          var rawAddr = String(r[2]).trim();
          // Strip non-numeric chars from sqft (handles $, ¢, commas)
          var sqft = parseInt(rawSqft.replace(/[^0-9]/g, ''), 10) || 0;
          // Extract ZIP from end of address
          var zipMatch = rawAddr.match(/\d{5}(?:-\d{4})?$/);
          var zip = zipMatch ? zipMatch[0] : '';
          var kgsSvcAddr = String(r[3] || '').trim();
          var kgsAcct = String(r[4] || '').trim();
          var kgsMeter = String(r[5] || '').trim();
          var obj = { name: rawName, sqft: sqft, addr: rawAddr, zip: zip, _checked: true };
          if (kgsAcct) obj.kgsAcct = kgsAcct;
          if (kgsMeter) obj.kgsMeter = kgsMeter;
          if (kgsSvcAddr) obj.kgsSvcAddr = kgsSvcAddr;
          return obj;
        })
        .filter(function (r) {
          return r.name.length > 0;
        });

      if (!_bldgImportRows.length) {
        showToast('No buildings with names found', 'warn');
        return;
      }

      _renderBldgImportPreview(file.name);
    } catch (err) {
      showToast('Error reading file: ' + (err.message || err), 'warn');
      console.error('bldgImport error:', err);
    }
  };
  if (file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.txt')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}
window.handleBldgImportFile = handleBldgImportFile;

function _renderBldgImportPreview(fname) {
  document.getElementById('bldgImportDropLabel').textContent = '✓ ' + fname + ' — click to change';
  document.getElementById('bldgImportCount').textContent = _bldgImportRows.length;

  var thead =
    '<tr>' +
    '<th style="width:32px"><input type="checkbox" id="bldgImportSelectAll" checked onchange="bldgImportToggleAll(this.checked)"></th>' +
    '<th>Building Name</th>' +
    '<th>SQFT</th>' +
    '<th>Address</th>' +
    '<th>ZIP</th>' +
    '</tr>';

  var tbody = _bldgImportRows
    .map(function (r, i) {
      return (
        '<tr>' +
        '<td><input type="checkbox" data-bldg-idx="' +
        i +
        '" checked onchange="bldgImportRowCheck(' +
        i +
        ',this.checked)"></td>' +
        '<td>' +
        _escHtml(r.name) +
        '</td>' +
        '<td style="text-align:right">' +
        (r.sqft ? r.sqft.toLocaleString() : '—') +
        '</td>' +
        '<td>' +
        _escHtml(r.addr) +
        '</td>' +
        '<td>' +
        _escHtml(r.zip) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  document.getElementById('bldgImportPreviewTable').innerHTML =
    '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody>';
  document.getElementById('bldgImportPreviewWrap').style.display = '';
  document.getElementById('bldgImportBtn').style.display = '';
}

function bldgImportToggleAll(checked) {
  _bldgImportRows.forEach(function (r) {
    r._checked = checked;
  });
  document.querySelectorAll('[data-bldg-idx]').forEach(function (cb) {
    cb.checked = checked;
  });
}
window.bldgImportToggleAll = bldgImportToggleAll;

function bldgImportRowCheck(idx, checked) {
  if (_bldgImportRows[idx]) _bldgImportRows[idx]._checked = checked;
  // Sync select-all checkbox
  var allChecked = _bldgImportRows.every(function (r) {
    return r._checked;
  });
  var anyChecked = _bldgImportRows.some(function (r) {
    return r._checked;
  });
  var sa = document.getElementById('bldgImportSelectAll');
  if (sa) {
    sa.checked = allChecked;
    sa.indeterminate = !allChecked && anyChecked;
  }
}
window.bldgImportRowCheck = bldgImportRowCheck;

function importBuildingList() {
  var proj = getUDProj(udSelProjId);
  if (!proj) {
    showToast('No project selected', 'warn');
    return;
  }
  var selected = _bldgImportRows.filter(function (r) {
    return r._checked && r.name;
  });
  if (!selected.length) {
    showToast('No buildings selected', 'warn');
    return;
  }

  var now = Date.now();
  selected.forEach(function (r, i) {
    proj.buildings = proj.buildings || [];
    var bldg = {
      id: 'b' + (now + i),
      name: r.name,
      addr: r.addr,
      sqft: r.sqft || 0,
      zip: r.zip || '',
      addrAliases: [],
      meters: [],
    };

    // KGS meter creation: split slash-separated account/meter pairs into separate meters
    if (r.kgsAcct) {
      var accts = r.kgsAcct
        .split('/')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      var meterNums = r.kgsMeter
        ? r.kgsMeter.split('/').map(function (s) {
            return s.trim();
          })
        : [];
      accts.forEach(function (acct, mi) {
        bldg.meters.push({
          id: 'm' + (now + i) + '_' + mi,
          commodity: 'Gas',
          provider: 'Kansas Gas Service',
          account: acct,
          meter: meterNums[mi] ? meterNums[mi].trim() : '',
          bills: [],
        });
      });
      // Push KGS service address as alias so address-based bill routing works
      if (r.kgsSvcAddr && r.kgsSvcAddr !== r.addr) {
        bldg.addrAliases.push(r.kgsSvcAddr);
      }
    }

    proj.buildings.push(bldg);
  });

  saveUtilityData();
  renderUDProjList();
  if (typeof renderUDDetail === 'function') renderUDDetail();
  showToast('Imported ' + selected.length + ' building' + (selected.length !== 1 ? 's' : '') + ' ✓');
  closeBldgImportModal();
}
window.importBuildingList = importBuildingList;

function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// #113575be: Open PDF import flow from the Bills tab.
// Resolves embed context, navigates to the PDF/OCR view, pre-selects the project,
// and triggers the file picker. Reuses the existing extraction pipeline unchanged.
function openPDFImportFromBills(mid) {
  // Resolve embed context so udSelProjId is correct when in project-embed mode
  _syncEmbedUDContext();
  // Navigate to the PDF/OCR view
  if (typeof sv === 'function') sv('pdf');
  // Small delay to let the view render before pre-selecting project and triggering picker
  setTimeout(function () {
    // Refresh dropdown options so the current project appears as a choice
    if (typeof refreshProjDropdowns === 'function') refreshProjDropdowns();
    var sel = document.getElementById('pdfProjSel');
    if (sel && udSelProjId) {
      sel.value = String(udSelProjId);
      sel.dispatchEvent(new Event('change'));
      if (typeof pdfUpdateBldgMeterOpts === 'function') pdfUpdateBldgMeterOpts();
    }
    var pdfInput = document.getElementById('pdfInput');
    if (pdfInput) pdfInput.click();
  }, 150);
}
window.openPDFImportFromBills = openPDFImportFromBills;
