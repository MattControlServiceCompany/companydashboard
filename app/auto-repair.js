/* ══════════════════════════════════════════════════════════════════════════════════════════════
   AUTOMATIC REPAIR OF STORED BILLS FROM THEIR OWN PDF PAGE (2026-10-15, backlog d178c906)
   Browser side of computations/bill-repair.js. It starts from loadUtilityData (scheduleAutoRepair) after the page has
   painted and works ONE PDF AT A TIME in the background:
     1. the bills that may need a re-read (repairEligibleBills: a flagged or misread bill and its two neighbors, with a
        stored PDF, no marker for this EXTRACTOR_RULES_VERSION), listed ONCE per meter at the start of the run and
        listed again only for the meters a PDF touched (no sweep of every meter per PDF);
     2. the PDF text from the shared page cache (_bcrLoadPdfText, key bcr_pdftext_<pdfKey>, the IndexedDB-backed
        sget/sset store; a page is read, with OCR if needed, once). The pass runs only when that store is ready, so
        page text never lands in the small fallback store;
     3. the ONE extraction pipeline (extractBillsFromText, app/bill-analysis.js, the same one the upload queue uses);
     4. findRepairMatch -> repairFieldsFromExtracted -> planMeterRepair (does no harm) -> applyRepairChanges, on the
        meter objects looked up AGAIN after the await (a reload or restore during the read replaces utilityData; a write
        to the old objects would be lost);
     5. the existing read-chain pass (correctMeterReadChain) for the meter;
     6. saveUtilityData for the customer, so a closed tab loses at most the PDF in progress.
   Markers (row._pdfRepair): { v, at, status: 'repaired' | 'nochange' | 'declined', reason } ends the bill for this
   version. Two markers carry no version and are tried again on a later load: { status: 'waiting', reason } when the PDF
   is not in this browser yet, and { status: 'error', reason, tries } when the read threw; after AUTO_REPAIR_MAX_TRIES
   the bill is declined for this version. A PDF page with no row on the meter is written to the audit log
   (pdf_bill_missing); nothing is added (a deleted bill exists only in the audit log, so an add could bring it back).
   A fresh value the decision held back (the stored value passes the bill's checks, or the value is not printed on the
   bill's own page) is written to the audit log (pdf_reread_held) with its reason; the stored value stays.
   No decision is made here: matching, field values, the flag check and the history are in computations/bill-repair.js.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const _autoRepairRun = { scheduled: false, running: false };
const AUTO_REPAIR_MAX_TRIES = 3;

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

// Every customer's meters as { cid, bldg, meter }, through the one accessor (getCustomerBuildings, app/utility-data.js).
function _autoRepairMeters() {
  const out = [];
  Object.keys(utilityData).forEach((cid) => {
    getCustomerBuildings(cid).forEach((bldg) => {
      (bldg.meters || []).forEach((meter) => out.push({ cid, bldg, meter }));
    });
  });
  return out;
}
// The live objects of one meter, looked up by id NOW (never a reference kept across an await). null when it is gone.
function _autoRepairResolve(ref) {
  const bldg = getCustomerBuildings(ref.cid).find((b) => b.id === ref.bldgId);
  const meter = bldg && (bldg.meters || []).find((m) => m.id === ref.meterId);
  return meter ? { cid: ref.cid, bldg, meter } : null;
}

function _autoRepairProject(cid) {
  return (typeof projects !== 'undefined' ? projects : []).find((p) => _resolveCustomerId(p.id) === cid) || null;
}

function _autoRepairAudit(t, period, action, changes, note) {
  const p = _autoRepairProject(t.cid);
  logUtilityAudit({
    action,
    projId: p ? p.id : null,
    projName: p ? p.name : '',
    bldgId: t.bldg.id,
    bldgName: t.bldg.name || '',
    meterId: t.meter.id,
    meterLabel: (t.meter.commodity || '') + (t.meter.meter ? ' ' + t.meter.meter : ''),
    period,
    source: 'auto-repair',
    changes: changes || null,
    note: note || '',
  });
}

// The work list of one run: pdfKey -> [{ cid, bldgId, meterId }], from ONE eligibility pass per meter. `_autoRepairPlanMeter`
// puts one meter's current eligible PDFs into it (called again only for the meters a PDF touched).
function _autoRepairPlanMeter(plan, t, version, seen) {
  Object.keys(plan).forEach((k) => {
    plan[k] = plan[k].filter((r) => !(r.cid === t.cid && r.bldgId === t.bldg.id && r.meterId === t.meter.id));
    if (!plan[k].length) delete plan[k];
  });
  repairEligibleBills(t.meter, t.bldg, version).forEach((r) => {
    const k = r.row.pdfKey;
    if (seen.has(k)) return;
    if (!plan[k]) plan[k] = [];
    if (!plan[k].some((x) => x.cid === t.cid && x.bldgId === t.bldg.id && x.meterId === t.meter.id))
      plan[k].push({ cid: t.cid, bldgId: t.bldg.id, meterId: t.meter.id });
  });
}

// One PDF: read it once, repair every eligible bill that points at it, save. refs = the meters the plan lists for it.
async function _autoRepairOnePdf(pdfKey, refs, version, stats) {
  const at = new Date().toISOString();
  const live = () => refs.map(_autoRepairResolve).filter((t) => t);
  const eligibleOf = (t) => repairEligibleBills(t.meter, t.bldg, version).filter((r) => r.row.pdfKey === pdfKey);
  const touched = () => live().filter((t) => eligibleOf(t).length);
  if (!touched().length) return [];
  // A marker on every eligible row of the PDF, on the objects that are live NOW (after the await).
  const markAll = (fn) => {
    const ts = touched();
    ts.forEach((t) => eligibleOf(t).forEach((r) => fn(r.row)));
    new Set(ts.map((t) => t.cid)).forEach((cid) => saveUtilityData(cid));
    return ts;
  };
  let ex = null;
  let text = null;
  try {
    text = await _bcrLoadPdfText(pdfKey);
    if (!text) {
      // Not in this browser (yet): no version, so the bill is read on a later load once the PDF is restored.
      const reason = 'the PDF is not on this browser';
      stats.waiting++;
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      return markAll((row) => {
        row._pdfRepair = Object.assign({}, row._pdfRepair && row._pdfRepair.dup ? { dup: true } : {}, { status: 'waiting', reason });
      });
    }
    ex = await extractBillsFromText(text, { gates: false, analyze: false });
  } catch (e) {
    // A read that throws is tried again on later loads, AUTO_REPAIR_MAX_TRIES times, then declined for this version.
    const msg = 'the PDF could not be read (' + (e && e.message ? e.message : 'error') + ')';
    return markAll((row) => {
      const tries = (row._pdfRepair && row._pdfRepair.status === 'error' ? Number(row._pdfRepair.tries) || 0 : 0) + 1;
      const dup = row._pdfRepair && row._pdfRepair.dup ? { dup: true } : {};
      if (tries >= AUTO_REPAIR_MAX_TRIES) {
        const reason = msg + ', ' + tries + ' tries';
        row._pdfRepair = Object.assign(dup, { v: version, at, status: 'declined', reason });
        stats.read++;
        stats.declined++;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      } else {
        row._pdfRepair = Object.assign(dup, { status: 'error', reason: msg, tries });
        stats.errors++;
        stats.reasons[msg] = (stats.reasons[msg] || 0) + 1;
      }
    });
  }
  const meta = { at, version };
  const targets = touched(); // looked up again: utilityData may have been replaced during the read
  for (const t of targets) {
    const res = repairMeterFromPdf(t.meter, t.bldg, pdfKey, ex.bills, meta, text);
    const periodOf = (row) => (row.start || '') + ' to ' + (row.end || '');
    res.repaired.forEach((r) => _autoRepairAudit(t, periodOf(r.row), 'pdf_reread', r.changes, 'Re-read from the stored PDF page'));
    // A fresh value that differs from the stored one and was NOT written: the stored value stays, the reason is logged.
    res.held.forEach((h) => {
      const fields = Object.keys(h.fields);
      _autoRepairAudit(
        t,
        periodOf(h.row),
        'pdf_reread_held',
        fields.map((k) => ({ field: k, stored: h.fields[k].from, read: h.fields[k].to, reason: h.fields[k].reason })),
        'The PDF re-read gave another value; the stored value was kept. ' + fields.map((k) => k + ': ' + h.fields[k].reason).join('; '),
      );
      fields.forEach((k) => {
        const reason = 'held: ' + h.fields[k].reason;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      });
      stats.held += fields.length;
    });
    res.missing.forEach((c) =>
      _autoRepairAudit(
        t,
        c.start + ' to ' + c.end,
        'pdf_bill_missing',
        [{ page: c.page, start: c.start, end: c.end, totalCost: c.totalCost, meterNumber: c.meterNumber }],
        'Page ' + c.page + ' of the stored PDF holds a bill of this meter with no row. Nothing was added; add it from the PDF if it belongs here.',
      ),
    );
    res.duplicates.forEach((g) =>
      _autoRepairAudit(
        t,
        periodOf(g[0]),
        'pdf_duplicate_rows',
        g.map((r) => ({ id: r.id, start: r.start, end: r.end, totalCost: r.totalCost })),
        'The same PDF page is stored in ' + g.length + ' rows. Nothing was deleted.',
      ),
    );
    res.declined.forEach((d) => {
      stats.reasons[d.reason] = (stats.reasons[d.reason] || 0) + 1;
    });
    stats.read += res.read;
    stats.repaired += res.repaired.length;
    stats.missing += res.missing.length;
    stats.declined += res.declined.length;
    stats.nochange += res.nochange.length;
    // reads after the re-read, by the existing rule
    correctMeterReadChain(t.meter);
  }
  new Set(targets.map((t) => t.cid)).forEach((cid) => saveUtilityData(cid));
  return targets;
}

async function runAutoRepair() {
  if (_autoRepairRun.running) return;
  if (!(typeof DB !== 'undefined' && DB && typeof DB.isReady === 'function' && DB.isReady())) {
    console.log('[auto repair] the storage is not ready; the pass runs on the next load');
    return;
  }
  _autoRepairRun.running = true;
  const version = EXTRACTOR_RULES_VERSION;
  const stats = { read: 0, repaired: 0, nochange: 0, declined: 0, missing: 0, waiting: 0, errors: 0, held: 0, reasons: {} };
  const seen = new Set();
  try {
    // One eligibility pass per meter, then one PDF at a time; only the meters a PDF touched are listed again.
    const plan = {};
    _autoRepairMeters().forEach((t) => _autoRepairPlanMeter(plan, t, version, seen));
    for (;;) {
      const next = Object.keys(plan)[0];
      if (!next) break;
      seen.add(next);
      const refs = plan[next];
      delete plan[next];
      const touched = await _autoRepairOnePdf(next, refs, version, stats);
      touched.forEach((t) => _autoRepairPlanMeter(plan, t, version, seen));
      await new Promise((r) => setTimeout(r, 50)); // let the page work between PDFs
    }
  } finally {
    _autoRepairRun.running = false;
  }
  window._autoRepairStats = stats;
  if (stats.read > 0 || stats.waiting > 0 || stats.errors > 0) {
    const reasons = Object.keys(stats.reasons)
      .map((k) => stats.reasons[k] + ' ' + k)
      .join('; ');
    const msg =
      'Re-read ' +
      stats.read +
      ' bills from PDF: ' +
      stats.repaired +
      ' repaired, ' +
      stats.declined +
      ' cannot be repaired, ' +
      stats.held +
      ' values held' +
      (reasons ? ' (' + reasons + ')' : '');
    console.log('[auto repair] ' + msg);
    if (stats.repaired > 0 && typeof showToast === 'function') showToast(msg);
  }
}
