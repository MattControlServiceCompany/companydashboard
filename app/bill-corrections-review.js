/* ══════════════════════════════════════════════════════════════════════════
   REVIEW BILL CORRECTIONS (2026-09-24, rebuilt 2026-09-25 — per-project,
   resumable, combined with the Utility Data page's own review flags)

   What this panel checks, for the CURRENTLY OPEN PROJECT ONLY:
     - Kansas Gas Service: a 100x OCR decimal-drop on the printed bill total.
     - City of Louisburg: the saved Bill Date is really the Penalty Date.
     - City of Louisburg: the saved account number has a single OCR-misread
       digit, found by comparing it against the same meter's other bills.
     - Evergy: a single-digit OCR misread on the printed RkVA rate.
     - Every bill the Utility Data page's own statistical check
       (_analyzeMeterBills, the same computation behind the "⚠ N review"
       building badge and the "N billing period(s) flagged" banner) currently
       flags as looking unusual next to that meter's own history.

   This file never rewrites a saved bill on its own. It shows a table of
   proposed changes / flagged bills and only writes a row Matt applies or
   dismisses — through the app's normal save path (saveUtilityData() for
   meter bills, sset('en_pdf_bills', ...) for unmatched bills,
   dismissBillFlag() for statistical flags) so audit history and sync fire
   exactly like any other manual correction.

   2026-09-25 REBUILD — what changed and why (Matt: "way more useful...
   actually show what needs corrections... not user friendly currently",
   "Why are there so many review items being shown in the Utility Data page
   but then that Review Bill Corrections page only shows 4 PDFs?", "is it not
   per project?", "For sure losing progress when closing the window is
   unacceptable."):
     1. PER PROJECT — every scan now reads only the open project's own
        buildings (getUDBldgs(udSelProjId)), never every customer's every
        building. The Kansas Gas Service "unmatched bills" bucket
        (en_pdf_bills) has no reliable project field on every row, so those
        rows are matched to the open project by their own projId when
        present, or by their account number tracing back to one of the open
        project's own meters — anything that can't be matched to the open
        project is dropped, never shown.
     2. ONE COMBINED LIST — the statistical "flagged for review" list is
        computed by calling the EXACT SAME _analyzeMeterBills +
        computeLiveBillFlags (extraction/bill-validation.js) that the "⚠ N
        review" building badge and the bills-table banner already use, so
        this panel's flagged count and the badge's count are the same
        number by construction.
     3. NEVER LOSE PROGRESS — every bill's check result
        (bcr_result_<billId>_<scanId>__<fieldKey>) and every PDF page's read
        text (bcr_pdftext_<pdfKey>) is persisted the moment it's known, via
        the existing sget/sset storage layer (already IndexedDB-backed).
        Closing this panel, reloading the page, or reopening later resumes
        from whatever is already saved — no PDF page is ever read twice, and
        a dismissed item never reappears.
     4. RUNS IN THE BACKGROUND — the scan loop (_bcrControllers, keyed by
        project id) is completely decoupled from whether this modal is open.
        Closing the modal only stops this panel's own on-screen updates; the
        scan itself keeps going and keeps saving progress. Reopening
        re-attaches to whatever is already there.
     5. PLAIN STATUS LINE — page-by-page progress ("Reading page 4 of 12 of
        the Bennett Art Building gas bill") plus a rough time estimate, and a
        60-second-per-bill cap so one slow scanned bill can never block the
        rest of the queue (it's marked "could not check yet" and the scan
        moves on — the pages it did finish reading are still saved).

   Kept unmodified from the pre-rebuild version (re-verified against
   tools/test-bill-corrections-review.js): meter grouping + per-row/per-
   group checkboxes + Apply Selected, _bcrFormatDisplayValue (printed-
   precision display), the Kansas Gas Service 0.15x-6x plausibility guard in
   _bcrScanKGSMeterBills, the apply-time live-value re-check in
   _bcrApplyRow, and logUtilityAudit history-on-apply.

   Depends on globals already loaded earlier on this page: sget/sset (core.js),
   pdfLoad/pdfStore (core.js), extractPDFText/_postExtractionVerify
   (bill-analysis.js), UTILITY_RULES (energy-savings.js), computeLiveBillFlags/
   dismissBillFlag (extraction/bill-validation.js), saveUtilityData/
   logUtilityAudit/_auditCtxFromIds/_auditPeriodLabel/getUDBldgs/getUDMeter/
   meterLabel/openBillModal/udSelProjId/udSelBldgId (utility-data.js/
   csv-import.js), _analyzeMeterBills (bill-analysis.js), showToast
   (site-ui.js).
   ═══════════════════════════════════════════════════════════════════════ */

const _BCR_PDF_TIMEOUT_MS = 60000; // one bill's PDF re-read/OCR gets at most this long per scan pass

let _bcrControllers = {}; // pid -> scan controller (module-level; NEVER wiped by opening the modal)
let _bcrOpenProjId = null; // which project's controller this modal is currently attached to
let _bcrRenderInterval = null; // polls the attached controller's state while the modal is open
let _bcrGroupCollapse = {}; // groupKey -> true when collapsed (UI-only, per browser session)
let _bcrSkippedCollapsed = true;
let _bcrUnchecked = new Set(); // row._rowId the user explicitly unchecked (survives re-renders while scanning)

/* ── small local helpers (kept private to this file) ── */
function _bcrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function _bcrToISO(d) {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  let p = String(d).split('/');
  if (p.length !== 3) p = String(d).split('-');
  if (p.length !== 3) return String(d);
  const yr = p[2].length === 2 ? '20' + p[2] : p[2];
  return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
}
// Plain-words bill period label. A bill saved with no dates at all shows
// "No bill dates" instead of a bare "to" (2026-09-25 fix).
function _bcrPeriodLabel(startStr, endStr) {
  const s = startStr || '';
  const e = endStr || '';
  if (!s && !e) return 'No bill dates';
  return (s || 'unknown start') + ' to ' + (e || 'unknown end');
}
function _bcrBillLabel(projName, bldgName, meterLbl, bill) {
  return (
    (projName || 'Unknown project') +
    ' / ' +
    (bldgName || 'Unknown building') +
    ' / ' +
    (meterLbl || 'Unknown meter') +
    ' / bill ' +
    (bill && bill.id ? bill.id : '?')
  );
}
// Plain-words label for the page-progress status line, e.g. "Bennett Art Building gas bill".
function _bcrPlainBillLabel(bldgName, commodity) {
  const c = (commodity || '').toLowerCase();
  return (bldgName || 'this building') + (c ? ' ' + c : '') + ' bill';
}
// _analyzeMeterBills' flags carry the raw internal field name (e.g.
// "totalCost", "thermCost") — humanize it for display in the statistical
// "Flagged for review" table's Field column (camelCase -> spaced Title Case).
// Plain-words rewrite only; the flag's own reason text is left exactly as
// _analyzeMeterBills wrote it (that's the "same computation" this scan
// reuses — see the SCAN 5 header comment).
function _bcrHumanizeField(key) {
  if (!key) return '';
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
// Rough remaining-time phrase from a millisecond estimate. Returns '' when there
// isn't enough information yet (first page of a PDF has no per-page rate to go on).
function _bcrEtaLabel(ms) {
  if (!ms || !isFinite(ms) || ms <= 0) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 10) return '';
  if (secs < 90) return 'less than a minute left';
  const mins = Math.round(secs / 60);
  return 'about ' + mins + ' minute' + (mins === 1 ? '' : 's') + ' left';
}
// Fix (2026-09-25, bill-panel-followup, case 1): a scan can propose a value
// derived from dividing two re-extracted numbers (e.g. RkVA Rate = charge /
// quantity), which produces floating-point noise the printed bill never had
// ("0.6629554655870445" instead of "0.663"). Show every value at the bill's
// own printed precision instead: money fields always to the cent; other
// numeric fields matched to however many decimals the CURRENT (already-
// printed) value has. Non-numeric values (dates, account numbers with no
// decimal point) pass through unchanged.
function _bcrFormatDisplayValue(field, value, currentValue) {
  if (value == null || value === '') return value;
  const str = String(value).trim();
  if (!/^-?[\d,]*\.?\d+$/.test(str)) return value; // not a plain number — leave dates etc. alone
  const num = parseFloat(str.replace(/,/g, ''));
  if (isNaN(num)) return value;
  if (/charge|amount|due|cost|total/i.test(field || '')) return num.toFixed(2);
  const curStr = currentValue != null ? String(currentValue).trim() : '';
  const curDecimals = /^-?[\d,]*\.?\d+$/.test(curStr) ? (curStr.split('.')[1] || '').length : null;
  const valDecimals = (str.split('.')[1] || '').length;
  if (curDecimals != null && valDecimals > curDecimals) return num.toFixed(curDecimals);
  if (curDecimals == null && valDecimals > 4) return num.toFixed(3); // no printed value to match — fall back to 3dp
  return value;
}
function _bcrMedian(nums) {
  const arr = nums.filter((n) => typeof n === 'number' && !isNaN(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
// One click to view the bill's own stored source PDF, no page-range slicing
// needed here (unlike the extraction screen) — this is the whole stored file.
async function _bcrOpenPdf(pdfKey) {
  if (!pdfKey) {
    showToast('No PDF stored for this bill');
    return;
  }
  try {
    let b64 = await pdfLoad(pdfKey);
    if (!b64) {
      showToast('No PDF stored for this bill');
      return;
    }
    if (b64.indexOf('base64,') !== -1) b64 = b64.slice(b64.indexOf('base64,') + 7);
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  } catch (e) {
    console.error('[bill-corrections-review] could not open PDF:', e);
    showToast('Could not open the PDF for this bill');
  }
}
window._bcrOpenPdf = _bcrOpenPdf;

// Row grouping — by meter, so the corrections table can be collapsed per meter.
function _bcrGroupKey(row) {
  if (row.store === 'en_pdf_bills') return 'unmatched:' + (row.meterLabel || row.projName || '');
  return 'meter:' + row.projId + '|' + row.bldgId + '|' + row.meterId;
}
function _bcrGroupLabel(row) {
  if (row.store === 'en_pdf_bills') return 'Unmatched Bills — Account ' + (row.meterLabel || 'unknown');
  return (row.bldgName || 'Unknown building') + ' — ' + (row.meterLabel || 'Unknown meter');
}

/* ══════════════════════════════════════════════════════
   PERSISTENCE — bcr_pdftext_<pdfKey> / bcr_result_<billId>_<scanId>__<field>
   ══════════════════════════════════════════════════════ */
function _bcrPdfTextKey(pdfKey) {
  return 'bcr_pdftext_' + pdfKey;
}
// One result record per (bill, scan, field) — a scanId almost always proposes
// exactly one field, except kgs_unmatched (can propose TotalCurrentCharges AND
// TotalAmountDue on the same bill), so the field is always part of the key.
function _bcrResultKey(billId, scanId, fieldKey) {
  return 'bcr_result_' + billId + '_' + scanId + '__' + fieldKey;
}
function _bcrLoadResult(billId, scanId, fieldKey) {
  return sget(_bcrResultKey(billId, scanId, fieldKey), null);
}
function _bcrSaveResult(billId, scanId, fieldKey, result) {
  return sset(_bcrResultKey(billId, scanId, fieldKey), result);
}
// Merge a fresh finding into whatever's already stored, WITHOUT clobbering an
// existing dismissal — a dismissed row must never silently un-dismiss itself
// just because the scan ran again and found the same thing.
async function _bcrUpsertResult(billId, scanId, fieldKey, patch) {
  const existing = _bcrLoadResult(billId, scanId, fieldKey) || {};
  const merged = Object.assign({ dismissed: false, dismissNote: '' }, existing, patch, {
    dismissed: existing.dismissed || false,
    dismissNote: existing.dismissNote || '',
  });
  await _bcrSaveResult(billId, scanId, fieldKey, merged);
  return merged;
}
function _bcrJoinPages(pages) {
  return pages.map((t, i) => '%%PAGE_' + (i + 1) + '%%\n' + (t || '')).join('\n');
}
// Reads a bill's stored PDF as text, using and extending the persisted per-page
// cache. A fully-cached PDF returns instantly with NO pdfLoad/decode at all
// (the "second scan is seconds, not minutes" case). A partially-cached PDF only
// re-reads/re-OCRs the pages that aren't cached yet, saving each new page the
// instant it's read (never only at the end) so a reload/close/timeout never
// loses progress. `ctl`/`billLabel` (both optional) drive the live plain-
// language page-progress status line.
async function _bcrLoadPdfText(pdfKey, ctl, billLabel) {
  if (!pdfKey) return null;
  const cacheRec = sget(_bcrPdfTextKey(pdfKey), null) || { pages: [], pageCount: 0, fullyRead: false };
  if (cacheRec.fullyRead && Array.isArray(cacheRec.pages) && cacheRec.pages.length) {
    return _bcrJoinPages(cacheRec.pages);
  }
  let b64 = await pdfLoad(pdfKey);
  if (!b64) return null;
  if (b64.indexOf('base64,') !== -1) b64 = b64.slice(b64.indexOf('base64,') + 7);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pagesArr = (cacheRec.pages || []).slice();
  const cachedPages = {};
  pagesArr.forEach((t, i) => {
    if (t) cachedPages[i] = t;
  });
  const startedAt = Date.now();
  let doneThisRun = 0;
  const text = await extractPDFText(bytes.buffer, null, {
    cachedPages,
    onPageText: (idx, pageText, pageCount) => {
      pagesArr[idx] = pageText || '';
      doneThisRun++;
      if (ctl) {
        const elapsedMs = Date.now() - startedAt;
        const perPageMs = doneThisRun > 0 ? elapsedMs / doneThisRun : 0;
        const remaining = Math.max(0, pageCount - (idx + 1));
        ctl.progress.pageLine =
          'Reading page ' + (idx + 1) + ' of ' + pageCount + (billLabel ? ' of the ' + billLabel : '');
        ctl.progress.etaLine = _bcrEtaLabel(perPageMs * remaining);
      }
      // Fire-and-forget persistence — never block the read on a write. A lost
      // write here just means that one page gets re-read on the next scan.
      sset(_bcrPdfTextKey(pdfKey), {
        pages: pagesArr.slice(),
        pageCount,
        extractedAt: new Date().toISOString(),
        fullyRead: pagesArr.filter((p) => p).length >= pageCount,
      });
    },
  });
  return text;
}
// Reads + re-extracts one PDF, capped at _BCR_PDF_TIMEOUT_MS. A timeout never
// throws — it resolves { timedOut: true } so the caller can mark that bill
// "could not check yet" and move on to the next candidate. Any pages the read
// finished before the timeout are still saved (the read keeps running in the
// background even after this race "loses").
async function _bcrReadAndExtract(pdfKey, ctl, billLabel, rule) {
  let timedOut = false;
  let text = null;
  await Promise.race([
    (async () => {
      text = await _bcrLoadPdfText(pdfKey, ctl, billLabel);
    })(),
    new Promise((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, _BCR_PDF_TIMEOUT_MS),
    ),
  ]);
  if (timedOut) return { timedOut: true, text: null, extracted: null };
  if (!text) return { timedOut: false, text: null, extracted: null };
  let extracted = null;
  try {
    extracted = rule.extractAll(text) || [];
  } catch (e) {
    extracted = null;
  }
  return { timedOut: false, text, extracted };
}

/* ══════════════════════════════════════════════════════
   PROJECT SCOPING
   ══════════════════════════════════════════════════════ */
function _bcrProjectRecord(pid) {
  return (sget('en_projects', []) || []).find((p) => String(p.id) === String(pid));
}
// en_pdf_bills (the Kansas Gas Service unmatched-bills bucket) doesn't reliably
// carry a project field on every row. A row belongs to the open project if its
// own projId says so, or — when projId is missing — if its account number
// traces back to one of the open project's own meters. Anything that can't be
// matched to the open project is dropped; it is never shown.
function _bcrPdfBillBelongsToProject(b, pid, bldgs) {
  if (b.projId != null) return String(b.projId) === String(pid);
  const acct = String(b.AccountNumber || '').replace(/\s+/g, '');
  if (!acct) return false;
  for (const bldg of bldgs) {
    for (const meter of bldg.meters || []) {
      if (String(meter.account || '').replace(/\s+/g, '') === acct) return true;
      for (const bill of meter.bills || []) {
        if (String(bill.accountNumber || '').replace(/\s+/g, '') === acct) return true;
      }
    }
  }
  return false;
}

/* ══════════════════════════════════════════════════════
   SCAN 1a — Kansas Gas Service 100x decimal-drop, unmatched-bills bucket
   (en_pdf_bills). Re-verifies the bill's OWN already-stored fields with the
   real _postExtractionVerify — no PDF re-read needed for this one.
   ══════════════════════════════════════════════════════ */
async function _bcrScanKGSUnmatched(pid, proj, bldgs, ctl) {
  const allBills = sget('en_pdf_bills', []) || [];
  const kgsBills = allBills.filter(
    (b) =>
      b &&
      (b.UtilityCompany === 'Kansas Gas Service' || b._utilityName === 'Kansas Gas Service') &&
      _bcrPdfBillBelongsToProject(b, pid, bldgs),
  );
  for (let i = 0; i < kgsBills.length; i++) {
    const b = kgsBills[i];
    ctl.progress.phaseLabel =
      'Kansas Gas Service — checking bill ' + (i + 1) + ' of ' + kgsBills.length + ' held for review';
    ctl.progress.pageLine = '';
    ctl.progress.etaLine = '';
    const account = b.AccountNumber || '';
    const period = _bcrPeriodLabel(b.BillingPeriodStart, b.BillingPeriodEnd);
    const label = _bcrBillLabel(proj.name, 'Unmatched Bills', account, b);
    const rowBase = {
      store: 'en_pdf_bills',
      scanId: 'kgs_unmatched',
      billId: b.id,
      utility: 'Kansas Gas Service',
      projName: proj.name || '',
      bldgName: 'Unmatched Bills',
      meterLabel: account,
      period,
      pdfKey: b.pdfKey || null,
    };
    const cachedTotal = _bcrLoadResult(b.id, 'kgs_unmatched', 'TotalCurrentCharges');
    const cachedDue = _bcrLoadResult(b.id, 'kgs_unmatched', 'TotalAmountDue');
    if (cachedTotal || cachedDue) {
      [
        { field: 'TotalCurrentCharges', label: 'Total Current Charges', cached: cachedTotal },
        { field: 'TotalAmountDue', label: 'Total Amount Due', cached: cachedDue },
      ].forEach(({ field, label: fLabel, cached }) => {
        if (!cached) return;
        if (cached.status === 'correction' && !cached.dismissed) {
          ctl.rows.push(
            Object.assign({}, rowBase, {
              _rowId: 'kgs:' + b.id + ':' + field,
              fieldKey: field,
              field: fLabel,
              currentValue: cached.currentValue,
              correctedValue: cached.proposedValue,
              reason: cached.reason,
            }),
          );
        } else if (cached.status === 'ok') {
          ctl.skipped.push({
            label,
            building: 'Unmatched Bills',
            meter: account,
            utility: 'Kansas Gas Service',
            period,
            field: fLabel,
            reason: cached.reason || 'no change needed — already correct',
            kind: 'no-change',
          });
        }
      });
      continue;
    }
    let out;
    try {
      const clone = JSON.parse(JSON.stringify(b));
      const res = await _postExtractionVerify([clone], 'Kansas Gas Service', '');
      out = res && res.bills && res.bills[0];
    } catch (e) {
      console.warn('[bill-corrections-review] KGS re-check failed for', b.id, e);
      ctl.skipped.push({
        label,
        building: 'Unmatched Bills',
        meter: account,
        utility: 'Kansas Gas Service',
        period,
        field: 'Total Current Charges',
        reason: "could not re-check this bill's stored data",
        kind: 'could-not-check',
      });
      continue;
    }
    if (!out || !out._auto_corrected_TotalCurrentCharges) {
      await _bcrUpsertResult(b.id, 'kgs_unmatched', 'TotalCurrentCharges', {
        status: 'ok',
        reason: "no change needed — the saved amount already matches this bill's own charges",
        checkedAt: new Date().toISOString(),
      });
      ctl.skipped.push({
        label,
        building: 'Unmatched Bills',
        meter: account,
        utility: 'Kansas Gas Service',
        period,
        field: 'Total Current Charges',
        reason: "no change needed — the saved amount already matches this bill's own charges",
        kind: 'no-change',
      });
      continue;
    }
    let anyChange = false;
    if (String(out.TotalCurrentCharges) !== String(b.TotalCurrentCharges)) {
      anyChange = true;
      const reason =
        "The printed total was 100 times the sum of this bill's own charges (the scanner likely dropped two decimal places). Corrected using the bill's own charges.";
      const saved = await _bcrUpsertResult(b.id, 'kgs_unmatched', 'TotalCurrentCharges', {
        status: 'correction',
        currentValue: b.TotalCurrentCharges,
        proposedValue: out.TotalCurrentCharges,
        reason,
        checkedAt: new Date().toISOString(),
      });
      if (!saved.dismissed) {
        ctl.rows.push(
          Object.assign({}, rowBase, {
            _rowId: 'kgs:' + b.id + ':TotalCurrentCharges',
            fieldKey: 'TotalCurrentCharges',
            field: 'Total Current Charges',
            currentValue: b.TotalCurrentCharges,
            correctedValue: out.TotalCurrentCharges,
            reason,
          }),
        );
      }
    }
    if (b.TotalAmountDue != null && String(out.TotalAmountDue) !== String(b.TotalAmountDue)) {
      anyChange = true;
      const reason =
        'Total Amount Due repeats Total Current Charges on this bill and carried the same decimal-drop error.';
      const saved = await _bcrUpsertResult(b.id, 'kgs_unmatched', 'TotalAmountDue', {
        status: 'correction',
        currentValue: b.TotalAmountDue,
        proposedValue: out.TotalAmountDue,
        reason,
        checkedAt: new Date().toISOString(),
      });
      if (!saved.dismissed) {
        ctl.rows.push(
          Object.assign({}, rowBase, {
            _rowId: 'kgs:' + b.id + ':TotalAmountDue',
            fieldKey: 'TotalAmountDue',
            field: 'Total Amount Due',
            currentValue: b.TotalAmountDue,
            correctedValue: out.TotalAmountDue,
            reason,
          }),
        );
      }
    }
    if (!anyChange) {
      await _bcrUpsertResult(b.id, 'kgs_unmatched', 'TotalCurrentCharges', {
        status: 'ok',
        reason: 'no change needed — already correct',
        checkedAt: new Date().toISOString(),
      });
      ctl.skipped.push({
        label,
        building: 'Unmatched Bills',
        meter: account,
        utility: 'Kansas Gas Service',
        period,
        field: 'Total Current Charges',
        reason: 'no change needed — already correct',
        kind: 'no-change',
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 1b — Kansas Gas Service 100x decimal-drop, saved meter bills.
   Re-reads the bill's own stored PDF (saved meter.bills rows don't keep the
   full KGS charge-line whitelist) and re-runs the real extractor + the
   unmodified _postExtractionVerify, guarded by a meter-history plausibility
   check (0.15x-6x of this meter's own median bill) so a bad re-extraction
   can never propose a false "100x" correction — see the 2026-09-25 finding
   this guard was added for (286-vs-2 false positives on a live scan).
   ══════════════════════════════════════════════════════ */
async function _bcrScanKGSMeterBills(pid, proj, bldgs, ctl) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find(
    (r) => r.name === 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)',
  );
  if (!rule) return;
  const scanId = 'kgs_meter';
  const fieldKey = 'totalCost';
  const candidates = [];
  bldgs.forEach((bldg) => {
    (bldg.meters || []).forEach((meter) => {
      (meter.bills || []).forEach((bill) => {
        if (!bill) return;
        const uc = (bill.utilityCompany || '').toLowerCase();
        const commodity = (bill.commodity || '').toLowerCase();
        if (!uc.includes('kansas gas service') || commodity !== 'gas') return;
        if (bill.totalCost == null || bill.totalCost === '') return;
        candidates.push({ bill, meter, bldg });
      });
    });
  });
  const toRead = [];
  for (const c of candidates) {
    const label = _bcrBillLabel(proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill);
    const building = c.bldg.name || c.bldg.addr || '';
    const meterLbl = meterLabel(c.meter);
    const period = _bcrPeriodLabel(c.bill.start, c.bill.end);
    const cached = _bcrLoadResult(c.bill.id, scanId, fieldKey);
    if (cached && cached.status === 'correction' && !cached.dismissed) {
      ctl.rows.push({
        _rowId: 'kgs:' + c.bill.id + ':totalCost',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: c.bldg.id,
        meterId: c.meter.id,
        billId: c.bill.id,
        field: 'Total Current Charges',
        utility: 'Kansas Gas Service',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: c.bill.pdfKey || null,
        currentValue: cached.currentValue,
        correctedValue: cached.proposedValue,
        reason: cached.reason,
      });
      continue;
    }
    if (cached && cached.status === 'correction' && cached.dismissed) continue;
    if (cached && cached.status === 'ok') {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Kansas Gas Service',
        period,
        field: 'Total Current Charges',
        reason: cached.reason || 'no change needed — already correct',
        kind: 'no-change',
      });
      continue;
    }
    if (!c.bill.pdfKey) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Kansas Gas Service',
        period,
        field: 'Total Current Charges',
        reason: 'no stored PDF for this bill, so it cannot be re-checked',
        kind: 'could-not-check',
      });
      continue;
    }
    toRead.push(c);
  }
  const byPdfKey = new Map();
  toRead.forEach((c) => {
    if (!byPdfKey.has(c.bill.pdfKey)) byPdfKey.set(c.bill.pdfKey, []);
    byPdfKey.get(c.bill.pdfKey).push(c);
  });
  const pdfKeys = Array.from(byPdfKey.keys());
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    ctl.progress.phaseLabel =
      'Kansas Gas Service — re-reading stored bill PDFs (' + (k + 1) + ' of ' + pdfKeys.length + ')';
    const billLabel = _bcrPlainBillLabel(group[0].bldg.name || group[0].bldg.addr, 'gas');
    const { timedOut, text, extracted } = await _bcrReadAndExtract(pdfKey, ctl, billLabel, rule);
    const skipAll = (reason) => {
      group.forEach((c) => {
        ctl.skipped.push({
          label: _bcrBillLabel(proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'Kansas Gas Service',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Total Current Charges',
          reason,
          kind: 'could-not-check',
        });
      });
    };
    if (timedOut) {
      skipAll(
        'this bill has a lot of scanned pages and the check timed out — the pages it did finish reading are saved and will be skipped next time',
      );
      continue;
    }
    if (!text) {
      skipAll('the stored PDF could not be read');
      continue;
    }
    if (extracted == null) {
      skipAll('re-reading the stored PDF did not produce usable text');
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg } = c;
      const label = _bcrBillLabel(proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
      const building = bldg.name || bldg.addr || '';
      const meterLbl = meterLabel(meter);
      const period = _bcrPeriodLabel(bill.start, bill.end);
      const acct = (bill.accountNumber || '').replace(/\s+/g, '');
      const matches = extracted.filter((x) => {
        if (!x || x.UtilityCompany !== 'Kansas Gas Service') return false;
        const xAcct = (x.AccountNumber || '').replace(/\s+/g, '');
        const sameAcct = acct && xAcct && xAcct === acct;
        const sameStart = _bcrToISO(x.BillingPeriodStart) === bill.start;
        const sameEnd = _bcrToISO(x.BillingPeriodEnd) === bill.end;
        return sameAcct && sameStart && sameEnd;
      });
      if (matches.length !== 1) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'Kansas Gas Service',
          period,
          field: 'Total Current Charges',
          reason:
            matches.length === 0
              ? 'could not find this exact bill again in its stored PDF (account or period did not match)'
              : 'found more than one possible match for this bill in its stored PDF',
          kind: 'could-not-check',
        });
        continue;
      }
      let out;
      try {
        const res = await _postExtractionVerify([matches[0]], 'Kansas Gas Service', text);
        out = res && res.bills && res.bills[0];
      } catch (e) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'Kansas Gas Service',
          period,
          field: 'Total Current Charges',
          reason: "could not re-check this bill's stored data",
          kind: 'could-not-check',
        });
        continue;
      }
      if (
        !out ||
        !out._auto_corrected_TotalCurrentCharges ||
        String(out.TotalCurrentCharges) === String(bill.totalCost)
      ) {
        await _bcrUpsertResult(bill.id, scanId, fieldKey, {
          status: 'ok',
          reason: 'no change needed — already correct',
          checkedAt: new Date().toISOString(),
        });
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'Kansas Gas Service',
          period,
          field: 'Total Current Charges',
          reason: 'no change needed — already correct',
          kind: 'no-change',
        });
        continue;
      }
      // ── Plausibility guard (2026-09-25 fix — see function header) ──
      const correctedNum = parseFloat(out.TotalCurrentCharges);
      const history = (meter.bills || [])
        .filter(
          (b2) =>
            b2 !== bill &&
            (b2.commodity || '').toLowerCase() === 'gas' &&
            /kansas gas service/i.test(b2.utilityCompany || '') &&
            b2.totalCost != null &&
            b2.totalCost !== '' &&
            !isNaN(parseFloat(b2.totalCost)),
        )
        .map((b2) => parseFloat(b2.totalCost));
      const med = history.length ? _bcrMedian(history) : null;
      if (med == null || med <= 0) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'Kansas Gas Service',
          period,
          field: 'Total Current Charges',
          reason:
            'the stored PDF suggested a possible change, but there is not enough other bill history on this meter to confirm it — needs manual review of the PDF',
          kind: 'could-not-check',
        });
        continue;
      }
      const ratio = correctedNum / med;
      if (ratio < 0.15 || ratio > 6) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'Kansas Gas Service',
          period,
          field: 'Total Current Charges',
          reason:
            'the stored PDF suggested a change to $' +
            correctedNum.toFixed(2) +
            ", but that does not match this meter's own typical bill amount (around $" +
            med.toFixed(2) +
            ') — not proposed, needs manual review of the PDF',
          kind: 'could-not-check',
        });
        continue;
      }
      const reason =
        "The printed total was 100 times the sum of this bill's own charges (the scanner likely dropped two decimal places), re-read from the bill's own stored PDF and checked against this meter's own bill history.";
      const saved = await _bcrUpsertResult(bill.id, scanId, fieldKey, {
        status: 'correction',
        currentValue: bill.totalCost,
        proposedValue: out.TotalCurrentCharges,
        reason,
        checkedAt: new Date().toISOString(),
      });
      if (saved.dismissed) continue;
      ctl.rows.push({
        _rowId: 'kgs:' + bill.id + ':totalCost',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        field: 'Total Current Charges',
        utility: 'Kansas Gas Service',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: bill.pdfKey || null,
        currentValue: bill.totalCost,
        correctedValue: out.TotalCurrentCharges,
        reason,
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 2 — City of Louisburg Bill Date reading the Penalty Date instead
   ══════════════════════════════════════════════════════ */
async function _bcrScanLouisburgDate(pid, proj, bldgs, ctl) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'City of Louisburg');
  if (!rule) return;
  const scanId = 'louisburg_date';
  const fieldKey = 'billDate';
  const candidates = [];
  bldgs.forEach((bldg) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      (meter.bills || []).forEach((bill) => {
        if (!bill || !bill.billDate) return;
        // _extractNew (the buggy path) always emits BillDate as M/D/YYYY
        // (4-digit year); _extractOld emits M/DD/YY. Only 4-digit-year bills
        // are candidates — confirmed against the real 5-date period row.
        if (!/^\d{1,2}\/\d{1,2}\/(\d{4})$/.test(String(bill.billDate))) return;
        if (!provider.includes('louisburg')) return;
        candidates.push({ bill, meter, bldg });
      });
    });
  });
  const toRead = [];
  for (const c of candidates) {
    const label = _bcrBillLabel(proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill);
    const building = c.bldg.name || c.bldg.addr || '';
    const meterLbl = meterLabel(c.meter);
    const period = _bcrPeriodLabel(c.bill.start, c.bill.end);
    const cached = _bcrLoadResult(c.bill.id, scanId, fieldKey);
    if (cached && cached.status === 'correction' && !cached.dismissed) {
      ctl.rows.push({
        _rowId: 'lou:' + c.bill.id + ':billDate',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: c.bldg.id,
        meterId: c.meter.id,
        billId: c.bill.id,
        field: 'Bill Date',
        utility: 'City of Louisburg',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: c.bill.pdfKey || null,
        currentValue: cached.currentValue,
        correctedValue: cached.proposedValue,
        reason: cached.reason,
      });
      continue;
    }
    if (cached && cached.status === 'correction' && cached.dismissed) continue;
    if (cached && cached.status === 'ok') {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'City of Louisburg',
        period,
        field: 'Bill Date',
        reason: cached.reason || 'no change needed — already correct',
        kind: 'no-change',
      });
      continue;
    }
    if (!c.bill.pdfKey) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'City of Louisburg',
        period,
        field: 'Bill Date',
        reason: 'no stored PDF for this bill, so it cannot be re-checked',
        kind: 'could-not-check',
      });
      continue;
    }
    toRead.push(c);
  }
  const byPdfKey = new Map();
  toRead.forEach((c) => {
    if (!byPdfKey.has(c.bill.pdfKey)) byPdfKey.set(c.bill.pdfKey, []);
    byPdfKey.get(c.bill.pdfKey).push(c);
  });
  const pdfKeys = Array.from(byPdfKey.keys());
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    ctl.progress.phaseLabel =
      'City of Louisburg — checking bill dates against stored PDFs (' + (k + 1) + ' of ' + pdfKeys.length + ')';
    const billLabel = _bcrPlainBillLabel(group[0].bldg.name || group[0].bldg.addr, group[0].bill.commodity);
    const { timedOut, text, extracted } = await _bcrReadAndExtract(pdfKey, ctl, billLabel, rule);
    const skipAll = (reason) => {
      group.forEach((c) => {
        ctl.skipped.push({
          label: _bcrBillLabel(proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'City of Louisburg',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Bill Date',
          reason,
          kind: 'could-not-check',
        });
      });
    };
    if (timedOut) {
      skipAll(
        'this bill has a lot of scanned pages and the check timed out — the pages it did finish reading are saved and will be skipped next time',
      );
      continue;
    }
    if (!text) {
      skipAll('the stored PDF could not be read');
      continue;
    }
    if (extracted == null) {
      skipAll('re-reading the stored PDF did not produce usable text');
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg } = c;
      const label = _bcrBillLabel(proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
      const building = bldg.name || bldg.addr || '';
      const meterLbl = meterLabel(meter);
      const period = _bcrPeriodLabel(bill.start, bill.end);
      const acct = (bill.accountNumber || '').replace(/\s+/g, '');
      const matches = extracted.filter((x) => {
        if (!x) return false;
        const xAcct = (x.AccountNumber || '').replace(/\s+/g, '');
        const sameAcct = acct && xAcct && xAcct === acct;
        const sameStart = _bcrToISO(x.BillingPeriodStart) === bill.start;
        const sameEnd = _bcrToISO(x.BillingPeriodEnd) === bill.end;
        const sameCommodity =
          !bill.commodity || !x.Commodity || String(x.Commodity).toLowerCase() === String(bill.commodity).toLowerCase();
        return sameAcct && sameStart && sameEnd && sameCommodity;
      });
      if (matches.length !== 1) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'City of Louisburg',
          period,
          field: 'Bill Date',
          reason:
            matches.length === 0
              ? 'could not find this exact bill again in its stored PDF (account, period, or utility type did not match)'
              : 'found more than one possible match for this bill in its stored PDF',
          kind: 'could-not-check',
        });
        continue;
      }
      const m = matches[0];
      const newBillDate = m.BillDate || '';
      if (!newBillDate || newBillDate === bill.billDate) {
        await _bcrUpsertResult(bill.id, scanId, fieldKey, {
          status: 'ok',
          reason: 'no change needed — already correct',
          checkedAt: new Date().toISOString(),
        });
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'City of Louisburg',
          period,
          field: 'Bill Date',
          reason: 'no change needed — already correct',
          kind: 'no-change',
        });
        continue;
      }
      // Guard: only billDate may change. Period is already required identical
      // by the match above; also require the total charge to be unchanged so
      // a wrong-bill match can never slip through as a same-day discrepancy.
      const newTotal = m.TotalAmountDue != null ? parseFloat(String(m.TotalAmountDue).replace(/,/g, '')) : null;
      const oldTotal = bill.totalCost != null && bill.totalCost !== '' ? parseFloat(bill.totalCost) : null;
      if (newTotal != null && oldTotal != null && Math.abs(newTotal - oldTotal) > 0.5) {
        ctl.skipped.push({
          label,
          building,
          meter: meterLbl,
          utility: 'City of Louisburg',
          period,
          field: 'Bill Date',
          reason:
            're-reading the PDF would also change the amount, not just the date — treated as a possible wrong-bill match, not proposed',
          kind: 'could-not-check',
        });
        continue;
      }
      const reason =
        'This bill prints five dates in a row (period start, period end, bill date, penalty date, due date); the saved Bill Date was read from the Penalty Date column instead of the Bill Date column.';
      const saved = await _bcrUpsertResult(bill.id, scanId, fieldKey, {
        status: 'correction',
        currentValue: bill.billDate,
        proposedValue: newBillDate,
        reason,
        checkedAt: new Date().toISOString(),
      });
      if (saved.dismissed) continue;
      ctl.rows.push({
        _rowId: 'lou:' + bill.id + ':billDate',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        field: 'Bill Date',
        utility: 'City of Louisburg',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: bill.pdfKey || null,
        currentValue: bill.billDate,
        correctedValue: newBillDate,
        reason,
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 3 — City of Louisburg account-number OCR misread. A same-meter
   consistency check — no PDF re-read is required to find the candidate.
   ══════════════════════════════════════════════════════ */
async function _bcrScanLouisburgAccountOCR(pid, proj, bldgs, ctl) {
  const scanId = 'louisburg_acct';
  const fieldKey = 'accountNumber';
  ctl.progress.phaseLabel = "City of Louisburg — checking account numbers against each meter's own history";
  ctl.progress.pageLine = '';
  ctl.progress.etaLine = '';
  const meterEntries = [];
  bldgs.forEach((bldg) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      const hasLouisburgBill = (meter.bills || []).some((b) => /louisburg/i.test(b.utilityCompany || ''));
      if (!provider.includes('louisburg') && !hasLouisburgBill) return;
      meterEntries.push({ meter, bldg });
    });
  });
  for (const { meter, bldg } of meterEntries) {
    const withAcct = (meter.bills || []).filter((b) => b && b.accountNumber);
    if (withAcct.length < 2) continue;
    const digitsOnly = (s) => String(s).replace(/\D/g, '');
    const rawCounts = new Map();
    withAcct.forEach((b) => {
      const raw = String(b.accountNumber).trim();
      rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
    });
    const modeEntry = Array.from(rawCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!modeEntry) continue;
    const [modeRaw, modeCount] = modeEntry;
    if (modeCount / withAcct.length < 0.5) continue; // no clear dominant account for this meter
    const modeDigits = digitsOnly(modeRaw);
    for (const bill of withAcct) {
      const raw = String(bill.accountNumber).trim();
      if (raw === modeRaw) continue;
      const digits = digitsOnly(raw);
      if (digits.length !== modeDigits.length || digits.length === 0) continue;
      let diffCount = 0;
      for (let i = 0; i < digits.length; i++) if (digits[i] !== modeDigits[i]) diffCount++;
      if (diffCount !== 1) continue; // only a single-digit misread is treated as OCR, not a real account change
      const cached = _bcrLoadResult(bill.id, scanId, fieldKey);
      if (cached && cached.dismissed) continue; // never reappears
      const reason =
        'Every other bill on this meter shows account number ' +
        modeRaw +
        ". This one bill's account number differs by a single digit — the scanner likely misread one digit on this bill's own PDF.";
      const saved = await _bcrUpsertResult(bill.id, scanId, fieldKey, {
        status: 'correction',
        currentValue: raw,
        proposedValue: modeRaw,
        reason,
        checkedAt: new Date().toISOString(),
      });
      if (saved.dismissed) continue;
      ctl.rows.push({
        _rowId: 'louacct:' + bill.id + ':accountNumber',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        field: 'Account Number',
        utility: 'City of Louisburg',
        projName: proj.name || '',
        bldgName: bldg.name || bldg.addr || '',
        meterLabel: meterLabel(meter),
        period: _bcrPeriodLabel(bill.start, bill.end),
        pdfKey: bill.pdfKey || null,
        currentValue: raw,
        correctedValue: modeRaw,
        reason,
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 4 — Evergy RkVA rate OCR digit-misread
   ══════════════════════════════════════════════════════ */
async function _bcrScanEvergyRkva(pid, proj, bldgs, ctl) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'Evergy');
  if (!rule) return;
  const scanId = 'evergy_rkva';
  const fieldKey = 'rkvaRate';
  // Cheap first pass (no PDF work): find bills whose stored rkvaRate differs
  // from their own meter's dominant (mode) rate by >5%, while that dominant
  // rate still covers at least half the meter's RkVA-billed history.
  const meterEntries = [];
  bldgs.forEach((bldg) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      if (!provider.includes('evergy') && !(meter.bills || []).some((b) => /evergy/i.test(b.utilityCompany || '')))
        return;
      meterEntries.push({ meter, bldg });
    });
  });
  const candidates = [];
  for (const { meter, bldg } of meterEntries) {
    const withRate = (meter.bills || []).filter(
      (b) => b && b.rkvaRate != null && b.rkvaRate !== '' && !isNaN(parseFloat(b.rkvaRate)),
    );
    if (withRate.length < 2) continue;
    const counts = {};
    withRate.forEach((b) => {
      const r = parseFloat(b.rkvaRate).toFixed(3);
      counts[r] = (counts[r] || 0) + 1;
    });
    const modeEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const modeRate = parseFloat(modeEntry[0]);
    const modeCoverage = modeEntry[1] / withRate.length;
    if (modeCoverage < 0.5) continue;
    withRate.forEach((b) => {
      const r = parseFloat(b.rkvaRate);
      if (Math.abs(r - modeRate) / modeRate > 0.05) {
        candidates.push({ bill: b, meter, bldg });
      }
    });
  }
  const toRead = [];
  for (const c of candidates) {
    const label = _bcrBillLabel(proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill);
    const building = c.bldg.name || c.bldg.addr || '';
    const meterLbl = meterLabel(c.meter);
    const period = _bcrPeriodLabel(c.bill.start, c.bill.end);
    const cached = _bcrLoadResult(c.bill.id, scanId, fieldKey);
    if (cached && cached.status === 'correction' && !cached.dismissed) {
      ctl.rows.push({
        _rowId: 'evg:' + c.bill.id + ':rkvaRate',
        store: 'meter',
        scanId,
        fieldKey,
        projId: pid,
        bldgId: c.bldg.id,
        meterId: c.meter.id,
        billId: c.bill.id,
        field: 'RkVA Rate',
        utility: 'Evergy',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: c.bill.pdfKey || null,
        currentValue: cached.currentValue,
        correctedValue: cached.proposedValue,
        reason: cached.reason,
      });
      continue;
    }
    if (cached && cached.status === 'correction' && cached.dismissed) continue;
    if (cached && cached.status === 'ok') {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: cached.reason || 'no change needed — already correct',
        kind: 'no-change',
      });
      continue;
    }
    if (!c.bill.pdfKey) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: 'no stored PDF for this bill, so it cannot be re-checked',
        kind: 'could-not-check',
      });
      continue;
    }
    toRead.push(c);
  }
  for (let i = 0; i < toRead.length; i++) {
    const c = toRead[i];
    const { bill, meter, bldg } = c;
    ctl.progress.phaseLabel =
      'Evergy — re-reading stored bill PDFs for the demand charge rate (' + (i + 1) + ' of ' + toRead.length + ')';
    const label = _bcrBillLabel(proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
    const building = bldg.name || bldg.addr || '';
    const meterLbl = meterLabel(meter);
    const period = _bcrPeriodLabel(bill.start, bill.end);
    const billLabel = _bcrPlainBillLabel(bldg.name || bldg.addr, 'electric');
    const { timedOut, text, extracted } = await _bcrReadAndExtract(bill.pdfKey, ctl, billLabel, rule);
    if (timedOut) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason:
          'this bill has a lot of scanned pages and the check timed out — the pages it did finish reading are saved and will be skipped next time',
        kind: 'could-not-check',
      });
      continue;
    }
    if (!text) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: 'the stored PDF could not be read',
        kind: 'could-not-check',
      });
      continue;
    }
    if (extracted == null) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: 're-reading the stored PDF did not produce usable text',
        kind: 'could-not-check',
      });
      continue;
    }
    const acct = (bill.accountNumber || '').replace(/\s+/g, '');
    const matches = extracted.filter((x) => {
      if (!x) return false;
      const xAcct = (x.AccountNumber || '').replace(/\s+/g, '');
      const sameAcct = acct && xAcct && xAcct === acct;
      const sameStart = _bcrToISO(x.BillingPeriodStart) === bill.start;
      const sameEnd = _bcrToISO(x.BillingPeriodEnd) === bill.end;
      return sameAcct && sameStart && sameEnd;
    });
    if (matches.length !== 1) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason:
          matches.length === 0
            ? 'could not find this exact bill again in its stored PDF (account or period did not match)'
            : 'found more than one possible match for this bill in its stored PDF',
        kind: 'could-not-check',
      });
      continue;
    }
    const m = matches[0];
    if (!m._auto_corrected_rate_RkVACharge) {
      await _bcrUpsertResult(bill.id, scanId, fieldKey, {
        status: 'ok',
        reason: 'no change needed — already correct',
        checkedAt: new Date().toISOString(),
      });
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: 'no change needed — already correct',
        kind: 'no-change',
      });
      continue;
    }
    const newRate = m.RkVARate;
    if (newRate == null || String(newRate) === String(bill.rkvaRate)) {
      await _bcrUpsertResult(bill.id, scanId, fieldKey, {
        status: 'ok',
        reason: 'no change needed — already correct',
        checkedAt: new Date().toISOString(),
      });
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason: 'no change needed — already correct',
        kind: 'no-change',
      });
      continue;
    }
    // Guard: the charge itself must stay the same — only the rate is corrected.
    if (bill.rkvaCharge && m.RkVACharge && Math.abs(parseFloat(m.RkVACharge) - parseFloat(bill.rkvaCharge)) > 0.5) {
      ctl.skipped.push({
        label,
        building,
        meter: meterLbl,
        utility: 'Evergy',
        period,
        field: 'RkVA Rate',
        reason:
          're-reading the PDF would also change the demand charge amount, not just the rate — treated as a possible wrong-bill match, not proposed',
        kind: 'could-not-check',
      });
      continue;
    }
    // Fix (2026-09-25, bill-panel-followup, case 1): store the ROUNDED value,
    // not the raw floating-point division result — see _bcrFormatDisplayValue's
    // header comment for why.
    const roundedRate = Math.round(parseFloat(newRate) * 1000) / 1000;
    const reason =
      "This bill's printed demand charge rate did not match its own printed charge and quantity (the scanner likely misread one digit). Corrected using the bill's own charge and quantity.";
    const saved = await _bcrUpsertResult(bill.id, scanId, fieldKey, {
      status: 'correction',
      currentValue: bill.rkvaRate,
      proposedValue: roundedRate,
      reason,
      checkedAt: new Date().toISOString(),
    });
    if (saved.dismissed) continue;
    ctl.rows.push({
      _rowId: 'evg:' + bill.id + ':rkvaRate',
      store: 'meter',
      scanId,
      fieldKey,
      projId: pid,
      bldgId: bldg.id,
      meterId: meter.id,
      billId: bill.id,
      field: 'RkVA Rate',
      utility: 'Evergy',
      projName: proj.name || '',
      bldgName: building,
      meterLabel: meterLbl,
      period,
      pdfKey: bill.pdfKey || null,
      currentValue: bill.rkvaRate,
      correctedValue: roundedRate,
      reason,
    });
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 5 — statistical "flagged for review" bills (2026-09-25, new). Reuses
   the EXACT SAME _analyzeMeterBills + computeLiveBillFlags computation the
   Utility Data building badge ("⚠ N review") and bills-table banner already
   use, so this list and that badge's count are the same number by
   construction, not two independent computations that happen to agree.
   ══════════════════════════════════════════════════════ */
async function _bcrScanStatisticalFlags(pid, proj, bldgs, ctl) {
  ctl.progress.phaseLabel = "Checking for unusual-looking numbers next to each meter's own history";
  ctl.progress.pageLine = '';
  ctl.progress.etaLine = '';
  bldgs.forEach((bldg) => {
    (bldg.meters || []).forEach((meter) => {
      const bills = meter.bills || [];
      if (bills.length < 4 || typeof _analyzeMeterBills !== 'function') return;
      const sortFn =
        typeof _parseISO === 'function'
          ? (a, b) => _parseISO(a.start) - _parseISO(b.start)
          : (a, b) => new Date(a.start) - new Date(b.start);
      const sorted = bills.slice().sort(sortFn);
      let live = {};
      try {
        live = _analyzeMeterBills(sorted, meter) || {};
      } catch (e) {
        return;
      }
      bills.forEach((bill) => {
        const flags = typeof computeLiveBillFlags === 'function' ? computeLiveBillFlags(bill, live[bill.id] || []) : [];
        if (!flags.length) return;
        ctl.flagged.push({
          kind: 'flagged',
          _rowId: 'flag:' + bill.id,
          projId: pid,
          bldgId: bldg.id,
          meterId: meter.id,
          billId: bill.id,
          utility: bill.utilityCompany || meter.provider || '',
          bldgName: bldg.name || bldg.addr || '',
          meterLabel: meterLabel(meter),
          period: _bcrPeriodLabel(bill.start, bill.end),
          field: flags.map((f) => _bcrHumanizeField(f.field)).join(', '),
          reason: flags
            .map((f) => f.msg)
            .filter(Boolean)
            .join(' '),
          pdfKey: bill.pdfKey || null,
          // Individual flag count on THIS bill — a bill can carry more than one
          // simultaneous flag (e.g. a rate outlier AND a usage outlier), and
          // this is what the "⚠ N review" building badge / bills-table banner
          // actually count (flag INSTANCES, not distinct bills). One row is
          // still shown per bill here for a usable table, but this field lets
          // the panel's own displayed total match the badge's number exactly
          // (2026-09-25 fix — see requirement 2 in the rebuild plan).
          flagCount: flags.length,
          flagIds: flags.map((f) => f._persistFlag && f._persistFlag.id).filter(Boolean),
        });
      });
    });
  });
}

/* ══════════════════════════════════════════════════════
   CONTROLLER — one background scan per project id, decoupled from the modal
   ══════════════════════════════════════════════════════ */
function _bcrGetOrCreateCtl(pid) {
  let ctl = _bcrControllers[pid];
  if (ctl) return ctl;
  ctl = {
    projId: pid,
    status: 'idle', // 'idle' | 'scanning' | 'done'
    rows: [], // correction rows (kind implicit: 'correction')
    flagged: [], // statistical flagged rows (kind: 'flagged')
    skipped: [], // no-change / could-not-check
    progress: { phaseLabel: 'Starting...', pageLine: '', etaLine: '' },
    startedAt: null,
  };
  _bcrControllers[pid] = ctl;
  return ctl;
}
async function _bcrRunProjectScan(ctl) {
  const pid = ctl.projId;
  const proj = _bcrProjectRecord(pid);
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(pid) || [] : [];
  if (!proj) return;
  const phases = [
    _bcrScanKGSUnmatched,
    _bcrScanKGSMeterBills,
    _bcrScanLouisburgDate,
    _bcrScanLouisburgAccountOCR,
    _bcrScanEvergyRkva,
    _bcrScanStatisticalFlags,
  ];
  for (const phase of phases) {
    try {
      await phase(pid, proj, bldgs, ctl);
    } catch (e) {
      console.error('[bill-corrections-review] scan phase failed:', phase.name, e);
    }
  }
  ctl.progress.phaseLabel = 'Done';
  ctl.progress.pageLine = '';
  ctl.progress.etaLine = '';
}
function _bcrStartScanIfNeeded(ctl) {
  if (ctl.status === 'scanning' || ctl.status === 'done') return;
  ctl.status = 'scanning';
  ctl.startedAt = Date.now();
  ctl.promise = _bcrRunProjectScan(ctl)
    .catch((e) => console.error('[bill-corrections-review] scan failed:', e))
    .then(() => {
      ctl.status = 'done';
    });
}

/* ══════════════════════════════════════════════════════
   APPLY — re-checks the live value, then writes through the app's normal
   save path (never a direct/raw write bypassing it). Unchanged from the
   pre-rebuild version, plus clearing the persisted result cache on success
   so a stale cached "correction" never re-renders after it's been applied.
   ══════════════════════════════════════════════════════ */
async function _bcrApplyRow(row) {
  if (row.store === 'en_pdf_bills') {
    const bills = (await sget('en_pdf_bills', [])) || [];
    const rec = bills.find((b) => b && b.id === row.billId);
    if (!rec) return { ok: false, reason: 'bill no longer exists' };
    const liveVal = rec[row.fieldKey];
    if (String(liveVal) !== String(row.currentValue))
      return { ok: false, reason: 'value changed since review was opened' };
    rec[row.fieldKey] = row.correctedValue;
    if (!rec._userCorrected) rec._userCorrected = {};
    rec._userCorrected[row.fieldKey] = {
      original: liveVal,
      at: new Date().toISOString(),
      source: 'bill_corrections_review',
    };
    await sset('en_pdf_bills', bills);
    logUtilityAudit({
      action: 'correction',
      projId: rec.projId || null,
      projName: rec.projName || '',
      period: (rec.BillingPeriodStart || '') + ' to ' + (rec.BillingPeriodEnd || ''),
      changes: [{ field: row.fieldKey, from: liveVal, to: row.correctedValue }],
      note: 'Review Bill Corrections: ' + row.reason,
      source: 'bill_corrections_review',
    });
    return { ok: true };
  }
  // meter.bills path — the app's normal edit path (mirrors submitValueCorrection)
  const meter = getUDMeter(row.projId, row.bldgId, row.meterId);
  if (!meter) return { ok: false, reason: 'meter no longer exists' };
  const bill = (meter.bills || []).find((b) => b.id === row.billId);
  if (!bill) return { ok: false, reason: 'bill no longer exists' };
  const liveVal = bill[row.fieldKey];
  if (String(liveVal) !== String(row.currentValue))
    return { ok: false, reason: 'value changed since review was opened' };
  bill[row.fieldKey] = row.correctedValue;
  if (!bill._userCorrected) bill._userCorrected = {};
  bill._userCorrected[row.fieldKey] = {
    original: liveVal,
    at: new Date().toISOString(),
    source: 'bill_corrections_review',
  };
  saveUtilityData(row.projId);
  logUtilityAudit(
    Object.assign(
      {
        action: 'correction',
        period: _auditPeriodLabel(bill),
        changes: [{ field: row.fieldKey, from: liveVal, to: row.correctedValue }],
        note: 'Review Bill Corrections: ' + row.reason,
        source: 'bill_corrections_review',
      },
      _auditCtxFromIds(row.projId, row.bldgId, row.meterId),
    ),
  );
  return { ok: true };
}

/* ══════════════════════════════════════════════════════
   DISMISS / EDIT — the new per-row actions (2026-09-25)
   ══════════════════════════════════════════════════════ */
async function _bcrDismissCorrectionRow(rowId) {
  const ctl = _bcrControllers[_bcrOpenProjId];
  if (!ctl) return;
  const row = ctl.rows.find((r) => r._rowId === rowId);
  if (!row) return;
  await _bcrSaveResult(row.billId, row.scanId, row.fieldKey, {
    status: 'correction',
    currentValue: row.currentValue,
    proposedValue: row.correctedValue,
    reason: row.reason,
    checkedAt: new Date().toISOString(),
    dismissed: true,
    dismissNote: 'Dismissed via Review Bill Corrections',
  });
  ctl.rows = ctl.rows.filter((r) => r._rowId !== rowId);
  showToast('Dismissed — this will not be shown again');
  _bcrRender();
}
window._bcrDismissCorrectionRow = _bcrDismissCorrectionRow;

function _bcrDismissFlaggedRow(rowId) {
  const ctl = _bcrControllers[_bcrOpenProjId];
  if (!ctl) return;
  const row = ctl.flagged.find((r) => r._rowId === rowId);
  if (!row) return;
  (row.flagIds || []).forEach((fid) => {
    if (typeof dismissBillFlag === 'function')
      dismissBillFlag(row.projId, row.bldgId, row.meterId, row.billId, fid, 'Dismissed via Review Bill Corrections');
  });
  ctl.flagged = ctl.flagged.filter((r) => r._rowId !== rowId);
  showToast('Dismissed — this will not be shown again');
  _bcrRender();
}
window._bcrDismissFlaggedRow = _bcrDismissFlaggedRow;

function _bcrEditFlaggedRow(rowId) {
  const ctl = _bcrControllers[_bcrOpenProjId];
  if (!ctl) return;
  const row = ctl.flagged.find((r) => r._rowId === rowId);
  if (!row) return;
  closeBillCorrectionsReviewModal();
  udSelBldgId = row.bldgId;
  if (typeof openBillModal === 'function') {
    try {
      openBillModal(row.meterId, row.billId);
    } catch (e) {
      console.error('[bill-corrections-review] could not open bill for editing:', e);
    }
  }
}
window._bcrEditFlaggedRow = _bcrEditFlaggedRow;

/* ══════════════════════════════════════════════════════
   UI — modal, opening sentence, status line, grouped table, flagged list,
   collapsed skip section
   ══════════════════════════════════════════════════════ */
function _bcrInjectStyles() {
  if (document.getElementById('bcrStyles')) return;
  const style = document.createElement('style');
  style.id = 'bcrStyles';
  style.textContent =
    '.bcr-tbl{width:100%;border-collapse:collapse}' +
    '.bcr-tbl th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);background:var(--s1);color:var(--text);white-space:nowrap}' +
    '.bcr-tbl td{padding:8px 10px;font-size:12.5px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text)}' +
    '.bcr-tbl tr:last-child td{border-bottom:none}' +
    '.bcr-reason{color:var(--text2);font-size:11.5px}' +
    '.bcr-intro{margin:14px 20px;font-size:12.5px;color:var(--text2);line-height:1.5}' +
    '.bcr-group{border:1px solid var(--border);border-radius:8px;margin:0 20px 12px;overflow:hidden}' +
    '.bcr-group-hdr{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--s1);cursor:pointer;user-select:none}' +
    '.bcr-group-hdr .bcr-caret{width:14px;display:inline-block;color:var(--text2)}' +
    '.bcr-group-title{font-weight:600;color:var(--text);font-size:13px}' +
    '.bcr-group-count{color:var(--text2);font-size:11.5px}' +
    '.bcr-group-body.collapsed{display:none}' +
    '.bcr-pdf-btn,.bcr-dismiss-btn,.bcr-edit-btn{font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer;margin-right:4px}' +
    '.bcr-summary{margin:14px 20px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:var(--s1)}' +
    '.bcr-summary-count{font-size:22px;font-weight:700;color:var(--text)}' +
    '.bcr-summary-row{display:flex;gap:24px;flex-wrap:wrap;margin-top:8px}' +
    '.bcr-summary-col{font-size:12px;color:var(--text2)}' +
    '.bcr-summary-col b{color:var(--text)}' +
    '.bcr-progress-wrap{margin:0 20px 6px;padding:14px 0}' +
    '.bcr-progress-label{font-size:12.5px;color:var(--text2);margin-bottom:4px}' +
    '.bcr-progress-page{font-size:12px;color:var(--text);margin-bottom:8px}' +
    '.bcr-progress-bar{height:8px;border-radius:4px;background:var(--s2);overflow:hidden}' +
    '.bcr-progress-fill{height:100%;background:var(--em);transition:width .2s ease}' +
    '.bcr-skip-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;color:var(--text2);font-size:12.5px;user-select:none}' +
    '.bcr-skip-body.collapsed{display:none}';
  document.head.appendChild(style);
}

function _bcrEnsureModal() {
  _bcrInjectStyles();
  if (document.getElementById('bcrModal')) return;
  const div = document.createElement('div');
  div.className = 'modal-bg';
  div.id = 'bcrModal';
  div.innerHTML =
    '<div class="modal" style="width:1180px;max-width:97vw;max-height:92vh">' +
    '<div class="modal-hdr">' +
    '<span class="modal-title">Review Bill Corrections</span>' +
    '<button class="modal-x" id="bcrCloseX">✕</button>' +
    '</div>' +
    '<div class="modal-body" id="bcrBody" style="overflow-y:auto;max-height:76vh;padding-bottom:8px"></div>' +
    '<div class="modal-ftr" id="bcrFtr" style="display:none;align-items:center;gap:10px">' +
    '<span id="bcrApplyCount" style="color:var(--text2);font-size:12px;margin-right:auto">Nothing changes until you apply or dismiss.</span>' +
    '<button class="btn btn-ghost" id="bcrCloseBtn">Close</button>' +
    '<button class="btn btn-em" id="bcrApplyBtn">Apply Selected</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(div);
  document.getElementById('bcrCloseX').addEventListener('click', closeBillCorrectionsReviewModal);
  document.getElementById('bcrCloseBtn').addEventListener('click', closeBillCorrectionsReviewModal);
  document.getElementById('bcrApplyBtn').addEventListener('click', _bcrApplyClicked);
}

// Opens the panel for the CURRENTLY OPEN PROJECT ONLY. Starting (or resuming)
// the scan does not require the modal to stay open — closing it only stops
// this panel's own on-screen updates; the scan keeps running and keeps
// saving progress in the background (2026-09-25 rebuild).
async function openBillCorrectionsReviewModal() {
  if (!udSelProjId) {
    showToast('Open a project first', 'warn');
    return;
  }
  _bcrEnsureModal();
  _bcrOpenProjId = udSelProjId;
  const modal = document.getElementById('bcrModal');
  modal.classList.add('open');
  document.getElementById('bcrFtr').style.display = 'none';
  _bcrGroupCollapse = {};
  _bcrUnchecked = new Set();
  const ctl = _bcrGetOrCreateCtl(udSelProjId);
  _bcrStartScanIfNeeded(ctl);
  _bcrRender();
  if (_bcrRenderInterval) clearInterval(_bcrRenderInterval);
  _bcrRenderInterval = setInterval(_bcrRender, 400);
}
window.openBillCorrectionsReviewModal = openBillCorrectionsReviewModal;

function closeBillCorrectionsReviewModal() {
  const m = document.getElementById('bcrModal');
  if (m) m.classList.remove('open');
  if (_bcrRenderInterval) {
    clearInterval(_bcrRenderInterval);
    _bcrRenderInterval = null;
  }
  // The scan controller is NOT touched here — it keeps running and keeps
  // saving progress even while this panel is closed.
}
window.closeBillCorrectionsReviewModal = closeBillCorrectionsReviewModal;

function _bcrFieldCounts(rows) {
  const byField = {};
  const byBuilding = {};
  rows.forEach((r) => {
    byField[r.field] = (byField[r.field] || 0) + 1;
    byBuilding[r.bldgName] = (byBuilding[r.bldgName] || 0) + 1;
  });
  return { byField, byBuilding };
}

function _bcrRenderProgress(ctl) {
  if (ctl.status !== 'scanning') return '';
  const p = ctl.progress;
  return (
    '<div class="bcr-progress-wrap">' +
    '<div class="bcr-progress-label">' +
    _bcrEsc(p.phaseLabel) +
    '</div>' +
    (p.pageLine
      ? '<div class="bcr-progress-page">' +
        _bcrEsc(p.pageLine) +
        (p.etaLine ? ' — ' + _bcrEsc(p.etaLine) : '') +
        '</div>'
      : '') +
    '<div class="bcr-progress-bar"><div class="bcr-progress-fill" style="width:100%;opacity:.35"></div></div>' +
    '<div style="font-size:11.5px;color:var(--text2);margin-top:6px">This keeps checking in the background even if you close this window. Found so far: ' +
    ctl.rows.length +
    ' correction' +
    (ctl.rows.length === 1 ? '' : 's') +
    ', ' +
    _bcrFlagInstanceTotal(ctl.flagged) +
    ' flagged for review, ' +
    ctl.skipped.length +
    ' checked with no change needed.</div>' +
    '</div>'
  );
}
// The "⚠ N review" building badge / bills-table banner count individual FLAG
// instances, not distinct bills (one bill can carry more than one flag at
// once) — sum the same way here so the panel's own number matches theirs
// exactly (2026-09-25 fix, requirement 2).
function _bcrFlagInstanceTotal(flagged) {
  return flagged.reduce((sum, r) => sum + (r.flagCount || 1), 0);
}

function _bcrRenderSummary(ctl) {
  if (!ctl.rows.length) return '';
  const { byField, byBuilding } = _bcrFieldCounts(ctl.rows);
  const fieldList = Object.entries(byField)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => '<div class="bcr-summary-col">' + _bcrEsc(f) + ': <b>' + n + '</b></div>')
    .join('');
  const bldgList = Object.entries(byBuilding)
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => '<div class="bcr-summary-col">' + _bcrEsc(b) + ': <b>' + n + '</b></div>')
    .join('');
  const bldgCount = Object.keys(byBuilding).length;
  return (
    '<div class="bcr-summary">' +
    '<div class="bcr-summary-count">' +
    ctl.rows.length +
    ' correction' +
    (ctl.rows.length === 1 ? '' : 's') +
    ' found across ' +
    bldgCount +
    ' building' +
    (bldgCount === 1 ? '' : 's') +
    '</div>' +
    '<div style="margin-top:6px;font-size:12px;color:var(--text2)">Applying will change only the rows you tick below, one saved value at a time, using the same save path and history log as a manual edit. Nothing changes until you click Apply Selected.</div>' +
    '<div class="bcr-summary-row"><div><div style="font-size:11px;text-transform:uppercase;color:var(--text2);margin-bottom:4px">By field</div>' +
    fieldList +
    '</div><div><div style="font-size:11px;text-transform:uppercase;color:var(--text2);margin-bottom:4px">By building</div>' +
    bldgList +
    '</div></div>' +
    '<div style="margin-top:10px"><a href="#" id="bcrExpandAll" style="font-size:11.5px;color:var(--em);margin-right:14px">Expand all groups</a><a href="#" id="bcrCollapseAll" style="font-size:11.5px;color:var(--em)">Collapse all groups</a></div>' +
    '</div>'
  );
}

function _bcrPdfBtn(pdfKey) {
  if (!pdfKey) return '<span class="bcr-reason">No PDF stored</span>';
  return '<button class="bcr-pdf-btn" data-pdfkey="' + _bcrEsc(pdfKey) + '">View PDF</button>';
}

function _bcrRenderGroups(rows) {
  if (!rows.length) return '';
  const groups = new Map();
  rows.forEach((r) => {
    const key = _bcrGroupKey(r);
    if (!groups.has(key)) groups.set(key, { title: _bcrGroupLabel(r), utility: r.utility, rows: [] });
    groups.get(key).rows.push(r);
  });
  let html = '';
  for (const [key, g] of groups) {
    const collapsed = !!_bcrGroupCollapse[key];
    html +=
      '<div class="bcr-group" data-groupkey="' +
      _bcrEsc(key) +
      '">' +
      '<div class="bcr-group-hdr" data-toggle="' +
      _bcrEsc(key) +
      '">' +
      '<span class="bcr-caret">' +
      (collapsed ? '▶' : '▼') +
      '</span>' +
      '<input type="checkbox" class="bcr-group-check" data-groupkey="' +
      _bcrEsc(key) +
      '" checked onclick="event.stopPropagation()">' +
      '<span class="bcr-group-title">' +
      _bcrEsc(g.title) +
      '</span>' +
      '<span class="bcr-group-count">' +
      g.rows.length +
      ' correction' +
      (g.rows.length === 1 ? '' : 's') +
      ' · ' +
      _bcrEsc(g.utility) +
      '</span>' +
      '</div>' +
      '<div class="bcr-group-body' +
      (collapsed ? ' collapsed' : '') +
      '">' +
      '<table class="bcr-tbl"><thead><tr>' +
      '<th></th><th>Bill Period</th><th>Field</th><th>Current Value</th><th>Proposed Value</th><th>Why</th><th>Actions</th>' +
      '</tr></thead><tbody>';
    g.rows.forEach((row) => {
      const checked = _bcrUnchecked.has(row._rowId) ? '' : ' checked';
      html +=
        '<tr>' +
        '<td><input type="checkbox" class="bcr-row-check" data-groupkey="' +
        _bcrEsc(key) +
        '" data-rowid="' +
        _bcrEsc(row._rowId) +
        '"' +
        checked +
        '></td>' +
        '<td>' +
        _bcrEsc(row.period) +
        '</td>' +
        '<td>' +
        _bcrEsc(row.field) +
        '</td>' +
        '<td>' +
        _bcrEsc(_bcrFormatDisplayValue(row.field, row.currentValue, row.currentValue)) +
        '</td>' +
        '<td><b>' +
        _bcrEsc(_bcrFormatDisplayValue(row.field, row.correctedValue, row.currentValue)) +
        '</b></td>' +
        '<td class="bcr-reason">' +
        _bcrEsc(row.reason) +
        '</td>' +
        '<td>' +
        _bcrPdfBtn(row.pdfKey) +
        '<button class="bcr-dismiss-btn" data-dismissrow="' +
        _bcrEsc(row._rowId) +
        '">Dismiss as correct</button>' +
        '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div></div>';
  }
  return html;
}

function _bcrRenderFlagged(flagged) {
  if (!flagged.length) return '';
  const collapsed = !!_bcrGroupCollapse['__flagged__'];
  let html =
    '<div class="bcr-group" data-groupkey="__flagged__">' +
    '<div class="bcr-group-hdr" data-toggle="__flagged__">' +
    '<span class="bcr-caret">' +
    (collapsed ? '▶' : '▼') +
    '</span>' +
    '<span class="bcr-group-title">Flagged for review</span>' +
    '<span class="bcr-group-count">' +
    _bcrFlagInstanceTotal(flagged) +
    ' flag' +
    (_bcrFlagInstanceTotal(flagged) === 1 ? '' : 's') +
    ' on ' +
    flagged.length +
    ' bill' +
    (flagged.length === 1 ? '' : 's') +
    " — numbers that look unusual next to that meter's own history</span>" +
    '</div>' +
    '<div class="bcr-group-body' +
    (collapsed ? ' collapsed' : '') +
    '"><table class="bcr-tbl"><thead><tr><th>Building</th><th>Meter</th><th>Utility</th><th>Bill Period</th><th>Field</th><th>Why</th><th>Actions</th></tr></thead><tbody>';
  flagged.forEach((row) => {
    html +=
      '<tr><td>' +
      _bcrEsc(row.bldgName) +
      '</td><td>' +
      _bcrEsc(row.meterLabel) +
      '</td><td>' +
      _bcrEsc(row.utility) +
      '</td><td>' +
      _bcrEsc(row.period) +
      '</td><td>' +
      _bcrEsc(row.field) +
      '</td><td class="bcr-reason">' +
      _bcrEsc(row.reason) +
      '</td><td>' +
      _bcrPdfBtn(row.pdfKey) +
      '<button class="bcr-edit-btn" data-editflag="' +
      _bcrEsc(row._rowId) +
      '">Edit</button>' +
      '<button class="bcr-dismiss-btn" data-dismissflag="' +
      _bcrEsc(row._rowId) +
      '">Dismiss as correct</button>' +
      '</td></tr>';
  });
  html += '</tbody></table></div></div>';
  return html;
}

function _bcrRenderSkipped(skipped) {
  if (!skipped.length) return '';
  const noChange = skipped.filter((s) => s.kind === 'no-change');
  const couldNot = skipped.filter((s) => s.kind !== 'no-change');
  const row = (s) =>
    '<tr><td>' +
    _bcrEsc(s.building || '') +
    '</td><td>' +
    _bcrEsc(s.meter || '') +
    '</td><td>' +
    _bcrEsc(s.utility || '') +
    '</td><td>' +
    _bcrEsc(s.period || '') +
    '</td><td>' +
    _bcrEsc(s.field || '') +
    '</td><td class="bcr-reason">' +
    _bcrEsc(s.reason) +
    '</td></tr>';
  return (
    '<div class="bcr-group" style="margin-top:4px">' +
    '<div class="bcr-skip-hdr" id="bcrSkipToggle">' +
    '<span class="bcr-caret">' +
    (_bcrSkippedCollapsed ? '▶' : '▼') +
    '</span>' +
    '<span>No change needed / could not check — ' +
    skipped.length +
    ' bill' +
    (skipped.length === 1 ? '' : 's') +
    ' (' +
    noChange.length +
    ' already correct, ' +
    couldNot.length +
    ' could not be checked)</span>' +
    '</div>' +
    '<div class="bcr-group-body' +
    (_bcrSkippedCollapsed ? ' collapsed' : '') +
    '" id="bcrSkipBody">' +
    (noChange.length
      ? '<div style="padding:8px 14px 0;font-size:11px;text-transform:uppercase;color:var(--text2)">Already correct — no change needed</div><table class="bcr-tbl"><thead><tr><th>Building</th><th>Meter</th><th>Utility</th><th>Bill Period</th><th>Field</th><th>Reason</th></tr></thead><tbody>' +
        noChange.map(row).join('') +
        '</tbody></table>'
      : '') +
    (couldNot.length
      ? '<div style="padding:8px 14px 0;font-size:11px;text-transform:uppercase;color:var(--text2)">Could not check</div><table class="bcr-tbl"><thead><tr><th>Building</th><th>Meter</th><th>Utility</th><th>Bill Period</th><th>Field</th><th>Reason</th></tr></thead><tbody>' +
        couldNot.map(row).join('') +
        '</tbody></table>'
      : '') +
    '</div></div>'
  );
}

function _bcrSelectedCount() {
  return document.querySelectorAll('.bcr-row-check:checked').length;
}

function _bcrUpdateApplyCount() {
  const n = _bcrSelectedCount();
  const btn = document.getElementById('bcrApplyBtn');
  const lbl = document.getElementById('bcrApplyCount');
  if (btn) btn.textContent = 'Apply Selected (' + n + ')';
  if (lbl)
    lbl.textContent = 'Nothing changes until you apply or dismiss. ' + n + ' row' + (n === 1 ? '' : 's') + ' selected.';
}

const _BCR_INTRO_TEXT =
  "This page lists every bill that may need a look — bills where an earlier version of the site misread a value on the PDF, and bills whose numbers look unusual next to the same meter's history. Nothing changes until you apply or dismiss an item.";

function _bcrRender() {
  const ctl = _bcrControllers[_bcrOpenProjId];
  const body = document.getElementById('bcrBody');
  const ftr = document.getElementById('bcrFtr');
  if (!body || !ctl) return;
  let html = '<div class="bcr-intro">' + _bcrEsc(_BCR_INTRO_TEXT) + '</div>';
  html += _bcrRenderProgress(ctl);
  const nothingYet = ctl.status !== 'scanning' && !ctl.rows.length && !ctl.flagged.length && !ctl.skipped.length;
  if (nothingYet) {
    html += '<div style="padding:24px;text-align:center;color:var(--text2)">No pending bill corrections.</div>';
  } else {
    html += _bcrRenderSummary(ctl);
    html += _bcrRenderGroups(ctl.rows);
    html += _bcrRenderFlagged(ctl.flagged);
    html += _bcrRenderSkipped(ctl.skipped);
    if (!ctl.rows.length && !ctl.flagged.length && ctl.status === 'done') {
      html =
        '<div class="bcr-intro">' +
        _bcrEsc(_BCR_INTRO_TEXT) +
        '</div>' +
        '<div style="padding:24px;text-align:center;color:var(--text2)">No pending bill corrections.</div>' +
        _bcrRenderSkipped(ctl.skipped);
    }
  }
  body.innerHTML = html;
  ftr.style.display = ctl.rows.length ? 'flex' : 'none';
  if (ctl.rows.length) _bcrUpdateApplyCount();

  // Wire up interactive bits (re-attached on every render since innerHTML replaces them).
  document.querySelectorAll('.bcr-group-hdr').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const key = hdr.dataset.toggle;
      _bcrGroupCollapse[key] = !_bcrGroupCollapse[key];
      _bcrRender();
    });
  });
  const skipToggle = document.getElementById('bcrSkipToggle');
  if (skipToggle) {
    skipToggle.addEventListener('click', () => {
      _bcrSkippedCollapsed = !_bcrSkippedCollapsed;
      _bcrRender();
    });
  }
  document.querySelectorAll('.bcr-group-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      document.querySelectorAll('.bcr-row-check[data-groupkey="' + cb.dataset.groupkey + '"]').forEach((rcb) => {
        rcb.checked = cb.checked;
        if (cb.checked) _bcrUnchecked.delete(rcb.dataset.rowid);
        else _bcrUnchecked.add(rcb.dataset.rowid);
      });
      _bcrUpdateApplyCount();
    });
  });
  document.querySelectorAll('.bcr-row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) _bcrUnchecked.delete(cb.dataset.rowid);
      else _bcrUnchecked.add(cb.dataset.rowid);
      _bcrUpdateApplyCount();
    });
  });
  document.querySelectorAll('.bcr-pdf-btn').forEach((btn) => {
    btn.addEventListener('click', () => _bcrOpenPdf(btn.dataset.pdfkey));
  });
  document.querySelectorAll('[data-dismissrow]').forEach((btn) => {
    btn.addEventListener('click', () => _bcrDismissCorrectionRow(btn.dataset.dismissrow));
  });
  document.querySelectorAll('[data-dismissflag]').forEach((btn) => {
    btn.addEventListener('click', () => _bcrDismissFlaggedRow(btn.dataset.dismissflag));
  });
  document.querySelectorAll('[data-editflag]').forEach((btn) => {
    btn.addEventListener('click', () => _bcrEditFlaggedRow(btn.dataset.editflag));
  });
  const expandAll = document.getElementById('bcrExpandAll');
  if (expandAll)
    expandAll.addEventListener('click', (e) => {
      e.preventDefault();
      _bcrGroupCollapse = {};
      _bcrRender();
    });
  const collapseAll = document.getElementById('bcrCollapseAll');
  if (collapseAll)
    collapseAll.addEventListener('click', (e) => {
      e.preventDefault();
      const groups = new Set(ctl.rows.map(_bcrGroupKey));
      groups.forEach((k) => (_bcrGroupCollapse[k] = true));
      _bcrRender();
    });
}

async function _bcrApplyClicked() {
  const ctl = _bcrControllers[_bcrOpenProjId];
  if (!ctl) return;
  const applyBtn = document.getElementById('bcrApplyBtn');
  const checked = new Set(
    Array.from(document.querySelectorAll('.bcr-row-check:checked')).map((cb) => cb.dataset.rowid),
  );
  const toApply = ctl.rows.filter((r) => checked.has(r._rowId));
  if (!toApply.length) {
    showToast('No rows selected', 'warn');
    return;
  }
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';
  }
  let appliedCount = 0;
  const newlySkipped = [];
  for (const row of toApply) {
    const result = await _bcrApplyRow(row);
    if (result.ok) {
      appliedCount++;
      // Clear the cached "correction" so a stale value never re-renders — the
      // bill is now correct, so the next scan should treat it as 'ok'.
      await _bcrSaveResult(row.billId, row.scanId, row.fieldKey, {
        status: 'ok',
        reason: 'corrected via Review Bill Corrections',
        checkedAt: new Date().toISOString(),
        dismissed: false,
        dismissNote: '',
      });
    } else {
      newlySkipped.push({
        label: _bcrBillLabel(row.projName, row.bldgName, row.meterLabel, { id: row.billId }),
        building: row.bldgName,
        meter: row.meterLabel,
        utility: row.utility,
        period: row.period,
        field: row.field,
        reason: result.reason,
        kind: 'could-not-check',
      });
    }
  }
  // Remove every row that was ticked (applied, or no longer applicable) from
  // the pending table. Rows the user left unticked stay for another pass.
  ctl.rows = ctl.rows.filter((r) => !checked.has(r._rowId));
  ctl.skipped = ctl.skipped.concat(newlySkipped);
  showToast(
    appliedCount +
      ' bill' +
      (appliedCount === 1 ? '' : 's') +
      ' corrected' +
      (newlySkipped.length ? ', ' + newlySkipped.length + ' skipped' : ''),
  );
  _bcrRender();
  if (typeof renderMeterWorkspace === 'function' && typeof udActiveMid !== 'undefined' && udActiveMid) {
    try {
      renderMeterWorkspace();
    } catch (e) {}
  }
}
