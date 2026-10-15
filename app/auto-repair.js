/* ══════════════════════════════════════════════════════════════════════════════════════════════
   AUTOMATIC REPAIR OF STORED BILLS FROM THEIR OWN PDF PAGE (2026-10-15, backlog d178c906)
   Browser side of computations/bill-repair.js. It starts from loadUtilityData (scheduleAutoRepair) after the page has
   painted and works ONE PDF AT A TIME in the background:
     1. the bills that may need a re-read (repairEligibleBills: a flagged or misread bill and its two neighbors, with a
        stored PDF, no marker for this EXTRACTOR_RULES_VERSION);
     2. the PDF text from the shared page cache (_bcrLoadPdfText, key bcr_pdftext_<pdfKey>; a page is read, with OCR if
        needed, once);
     3. the ONE extraction pipeline (extractBillsFromText, app/bill-analysis.js, the same one the upload queue uses);
     4. findRepairMatch -> repairFieldsFromExtracted -> planMeterRepair (does no harm) -> applyRepairChanges;
     5. the existing read-chain pass (correctMeterReadChain) for the meter;
     6. saveUtilityData for the customer, so a closed tab loses at most the PDF in progress. Each bill read gets the
        marker row._pdfRepair = { v, at, status: 'repaired' | 'nochange' | 'declined', reason }.
   No decision is made here: matching, field values, the flag check and the history are in computations/bill-repair.js.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const _autoRepairRun = { scheduled: false, running: false };

function scheduleAutoRepair() {
  if (_autoRepairRun.scheduled || typeof window === 'undefined') return;
  _autoRepairRun.scheduled = true;
  const start = () => {
    runAutoRepair().catch((e) => {
      _autoRepairRun.running = false;
      console.warn('[auto repair] stopped:', e);
    });
  };
  // after first paint, then when the browser is idle
  setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 15000 });
    else setTimeout(start, 1000);
  }, 4000);
}

// Every customer's meters as { cid, bldg, meter }.
function _autoRepairMeters() {
  const out = [];
  Object.keys(utilityData).forEach((cid) => {
    (utilityData[cid].buildings || []).forEach((bldg) => {
      (bldg.meters || []).forEach((meter) => out.push({ cid, bldg, meter }));
    });
  });
  return out;
}

function _autoRepairProject(cid) {
  return (typeof projects !== 'undefined' ? projects : []).find((p) => _resolveCustomerId(p.id) === cid) || null;
}

function _autoRepairAudit(t, row, action, changes, note) {
  const p = _autoRepairProject(t.cid);
  logUtilityAudit({
    action,
    projId: p ? p.id : null,
    projName: p ? p.name : '',
    bldgId: t.bldg.id,
    bldgName: t.bldg.name || '',
    meterId: t.meter.id,
    meterLabel: (t.meter.commodity || '') + (t.meter.meter ? ' ' + t.meter.meter : ''),
    period: (row.start || '') + ' to ' + (row.end || ''),
    source: 'auto-repair',
    changes: changes || null,
    note: note || '',
  });
}

// One PDF: read it once, repair every eligible bill that points at it, save. Returns the counts for the summary.
async function _autoRepairOnePdf(pdfKey, version, stats) {
  const at = new Date().toISOString();
  const targets = _autoRepairMeters()
    .map((t) => Object.assign(t, { rows: repairEligibleBills(t.meter, t.bldg, version).filter((r) => r.row.pdfKey === pdfKey) }))
    .filter((t) => t.rows.length);
  if (!targets.length) return;
  const declineAll = (reason) => {
    targets.forEach((t) =>
      t.rows.forEach((r) => {
        r.row._pdfRepair = { v: version, at, status: 'declined', reason };
        stats.read++;
        stats.declined++;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      }),
    );
    new Set(targets.map((t) => t.cid)).forEach((cid) => saveUtilityData(cid));
  };
  let ex = null;
  try {
    const text = await _bcrLoadPdfText(pdfKey);
    if (!text) return declineAll('the PDF is not on this browser');
    ex = await extractBillsFromText(text, { gates: false, analyze: false });
  } catch (e) {
    return declineAll('the PDF could not be read (' + (e && e.message ? e.message : 'error') + ')');
  }
  const meta = { at, version };
  for (const t of targets) {
    const res = repairMeterFromPdf(t.meter, t.bldg, pdfKey, ex.bills, meta);
    res.repaired.forEach((r) => _autoRepairAudit(t, r.row, 'pdf_reread', r.changes, 'Re-read from the stored PDF page'));
    res.added.forEach((row) => _autoRepairAudit(t, row, 'pdf_bill_added', null, 'Bill added from its PDF page'));
    res.duplicates.forEach((g) =>
      _autoRepairAudit(
        t,
        g[0],
        'pdf_duplicate_rows',
        g.map((r) => ({ id: r.id, start: r.start, end: r.end, totalCost: r.totalCost })),
        'The same PDF page is stored in ' + g.length + ' rows. Nothing was deleted.',
      ),
    );
    res.declined.forEach((d) => {
      stats.reasons[d.reason] = (stats.reasons[d.reason] || 0) + 1;
    });
    stats.read += res.read;
    stats.repaired += res.repaired.length + res.added.length;
    stats.declined += res.declined.length;
    stats.nochange += res.nochange.length;
    // reads after the re-read, by the existing rule
    correctMeterReadChain(t.meter);
  }
  new Set(targets.map((t) => t.cid)).forEach((cid) => saveUtilityData(cid));
}

async function runAutoRepair() {
  if (_autoRepairRun.running) return;
  _autoRepairRun.running = true;
  const version = EXTRACTOR_RULES_VERSION;
  const stats = { read: 0, repaired: 0, nochange: 0, declined: 0, reasons: {} };
  const seen = new Set();
  try {
    // One PDF at a time. The list is taken again after every PDF: a repair can remove the need to read another one.
    for (;;) {
      let next = null;
      for (const t of _autoRepairMeters()) {
        const hit = repairEligibleBills(t.meter, t.bldg, version).find((r) => !seen.has(r.row.pdfKey));
        if (hit) {
          next = hit.row.pdfKey;
          break;
        }
      }
      if (!next) break;
      seen.add(next);
      await _autoRepairOnePdf(next, version, stats);
      await new Promise((r) => setTimeout(r, 50)); // let the page work between PDFs
    }
  } finally {
    _autoRepairRun.running = false;
  }
  window._autoRepairStats = stats;
  if (stats.read > 0) {
    const reasons = Object.keys(stats.reasons)
      .map((k) => stats.reasons[k] + ' ' + k)
      .join('; ');
    const msg =
      'Re-read ' + stats.read + ' bills from PDF: ' + stats.repaired + ' repaired, ' + stats.declined + ' cannot be repaired' + (reasons ? ' (' + reasons + ')' : '');
    console.log('[auto repair] ' + msg);
    if (stats.repaired > 0 && typeof showToast === 'function') showToast(msg);
  }
}
