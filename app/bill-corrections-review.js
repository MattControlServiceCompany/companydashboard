/* ══════════════════════════════════════════════════════════════════════════
   REVIEW BILL CORRECTIONS (2026-09-24, redesigned 2026-09-25 — Matt-approved
   one-time review tool)

   Four kinds of corrections this panel finds by re-reading each bill's own
   stored PDF and calling the REAL shipped extraction/verification functions
   (never a hardcoded target number):
     - Kansas Gas Service: a 100x OCR decimal-drop on the printed bill total.
     - City of Louisburg: the saved Bill Date is really the Penalty Date.
     - City of Louisburg: the saved account number has a single OCR-misread
       digit, found by comparing it against the same meter's other bills.
     - Evergy: a single-digit OCR misread on the printed RkVA rate.

   This file never rewrites a saved bill on its own. It scans saved bills,
   shows Matt a table of proposed changes, and only writes a row he ticks and
   applies — through the app's normal save path (saveUtilityData() for meter
   bills, sset('en_pdf_bills', ...) for unmatched bills) so audit history
   (logUtilityAudit) and sync fire exactly like any other manual correction.

   2026-09-25 redesign — what changed and why (Matt: "way more useful...
   actually show what needs corrections... not user friendly currently"):
     - The scan used to run silently behind one repeating status line with
       nothing visible until it finished. It now streams results into the
       table AS they are found, with a real progress bar and a plain-words
       description of what step is running.
     - Rows are grouped by meter (collapsible), with a summary at the top
       (how many corrections, broken down by field and by building) and a
       plain statement of what Apply Selected will do.
     - Every row now names the utility and has a one-click "View PDF" button
       so Matt can check the source himself before applying.
     - "No change needed" (bill re-checked, value already correct) and
       "could not check" (no stored PDF, ambiguous match, etc.) are now two
       clearly-labeled buckets inside one collapsed section, instead of being
       silently dropped or merged under one vague label.
     - Kansas Gas Service false-positive fix: see _bcrScanKGSMeterBills below
       for the meter-history plausibility guard added after a live scan
       proposed changes to 286 Baker Kansas Gas Service bills when only 2 are
       real (backlog finding, 2026-09-25).
     - New scan: Louisburg account-number OCR misreads (single-digit misread
       against the meter's own dominant account number).

   Depends on globals already loaded earlier on this page: sget/sset (core.js),
   pdfLoad/pdfStore (core.js), extractPDFText (bill-analysis.js),
   _postExtractionVerify (bill-analysis.js), UTILITY_RULES (energy-savings.js),
   saveUtilityData/logUtilityAudit/_auditCtxFromIds/_auditPeriodLabel/
   getUDMeter/forEachCustomerBuilding/getProjectsForBuilding/meterLabel
   (utility-data.js), projects/utilityData (core.js/utility-data.js),
   showToast (site-ui.js).
   ═══════════════════════════════════════════════════════════════════════ */

let _bcrRows = []; // pending correction rows currently shown in the table
let _bcrSkipped = []; // [{ label, building, meter, utility, period, field, reason, kind }]
let _bcrScanning = false;
let _bcrScanned = false;
let _bcrGroupCollapse = {}; // groupKey -> true when collapsed
let _bcrSkippedCollapsed = true;
let _bcrProgress = { phaseLabel: 'Starting...', phaseIndex: 0, totalPhases: 5, doneInPhase: 0, totalInPhase: 0 };
let _bcrLastRenderAt = 0;

/* ── small local helpers (kept private to this file — no shared global renamed) ── */
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
async function _bcrLoadPdfText(pdfKey) {
  if (!pdfKey) return null;
  let b64 = await pdfLoad(pdfKey);
  if (!b64) return null;
  if (b64.indexOf('base64,') !== -1) b64 = b64.slice(b64.indexOf('base64,') + 7);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return extractPDFText(bytes.buffer, null);
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

// Row/skip grouping — by meter, so the table can be collapsed per meter.
function _bcrGroupKey(row) {
  if (row.store === 'en_pdf_bills') return 'unmatched:' + (row.meterLabel || row.projName || '');
  return 'meter:' + row.projId + '|' + row.bldgId + '|' + row.meterId;
}
function _bcrGroupLabel(row) {
  if (row.store === 'en_pdf_bills') return 'Unmatched Bills — Account ' + (row.meterLabel || 'unknown');
  return (row.bldgName || 'Unknown building') + ' — ' + (row.meterLabel || 'Unknown meter');
}

function _bcrProgressPct() {
  const perPhase = 100 / _bcrProgress.totalPhases;
  const localFrac = _bcrProgress.totalInPhase > 0 ? _bcrProgress.doneInPhase / _bcrProgress.totalInPhase : 0;
  return Math.min(100, _bcrProgress.phaseIndex * perPhase + localFrac * perPhase);
}

/* ══════════════════════════════════════════════════════
   SCAN 1a — Kansas Gas Service 100x decimal-drop, unmatched-bills bucket
   (en_pdf_bills — bills held for review with no meter match). Keeps every
   original extractor field, so _postExtractionVerify can run on it directly
   with no re-extraction needed. This path is unchanged from the original
   build — it was confirmed correct against the 2 real named candidates.
   ══════════════════════════════════════════════════════ */
async function _bcrScanKGSUnmatched(h) {
  const allBills = (await sget('en_pdf_bills', [])) || [];
  const kgsBills = allBills.filter(
    (b) => b && (b.UtilityCompany === 'Kansas Gas Service' || b._utilityName === 'Kansas Gas Service'),
  );
  h.onProgress('Kansas Gas Service — checking bills held for review', kgsBills.length);
  for (let i = 0; i < kgsBills.length; i++) {
    const b = kgsBills[i];
    h.onStep(
      i + 1,
      kgsBills.length,
      'Checking Kansas Gas Service unmatched bill ' + (i + 1) + ' of ' + kgsBills.length,
    );
    const account = b.AccountNumber || '';
    const period = _bcrPeriodLabel(b.BillingPeriodStart, b.BillingPeriodEnd);
    const label = _bcrBillLabel(b.projName, 'Unmatched Bills', account, b);
    let out;
    try {
      const clone = JSON.parse(JSON.stringify(b));
      const res = await _postExtractionVerify([clone], 'Kansas Gas Service', '');
      out = res && res.bills && res.bills[0];
    } catch (e) {
      console.warn('[bill-corrections-review] KGS re-check failed for', b.id, e);
      h.onSkip({
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
      h.onSkip({
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
      h.onRow({
        _rowId: 'kgs:' + b.id + ':TotalCurrentCharges',
        store: 'en_pdf_bills',
        billId: b.id,
        fieldKey: 'TotalCurrentCharges',
        field: 'Total Current Charges',
        utility: 'Kansas Gas Service',
        projName: b.projName || 'Unmatched Bills',
        bldgName: 'Unmatched Bills',
        meterLabel: account,
        period,
        pdfKey: b.pdfKey || null,
        currentValue: b.TotalCurrentCharges,
        correctedValue: out.TotalCurrentCharges,
        reason:
          "The printed total was 100 times the sum of this bill's own charges (the scanner likely dropped two decimal places). Corrected using the bill's own charges.",
      });
    }
    if (b.TotalAmountDue != null && String(out.TotalAmountDue) !== String(b.TotalAmountDue)) {
      anyChange = true;
      h.onRow({
        _rowId: 'kgs:' + b.id + ':TotalAmountDue',
        store: 'en_pdf_bills',
        billId: b.id,
        fieldKey: 'TotalAmountDue',
        field: 'Total Amount Due',
        utility: 'Kansas Gas Service',
        projName: b.projName || 'Unmatched Bills',
        bldgName: 'Unmatched Bills',
        meterLabel: account,
        period,
        pdfKey: b.pdfKey || null,
        currentValue: b.TotalAmountDue,
        correctedValue: out.TotalAmountDue,
        reason: 'Total Amount Due repeats Total Current Charges on this bill and carried the same decimal-drop error.',
      });
    }
    if (!anyChange) {
      h.onSkip({
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

   A saved meter.bills row only keeps the narrow field whitelist
   app/bill-analysis.js writes at save time — the Kansas Gas Service-only
   charge fields (Delivery Charge, Gas System Reliability Surcharge, etc.)
   are not part of that whitelist and are gone from a saved row. So, like the
   Louisburg and Evergy scans below, this re-reads the bill's own stored PDF
   and re-runs the real extractor to recover the complete charge set, then
   verifies with the real (unmodified) _postExtractionVerify.

   2026-09-25 fix (finding for case 6): a live scan proposed a "corrected"
   total on 286 Baker Kansas Gas Service bills when only 2 are real errors —
   essentially every candidate this function looked at. The two real errors
   are found correctly by the unmatched-bucket scan above (SCAN 1a), which
   was already verified against real data. This function's re-extraction
   path has no independent way to confirm a proposed 100x change is real —
   it only compares the bill's re-extracted total against its own
   re-extracted charge components, and a re-extraction mismatch (garbled OCR
   on a re-read, a wrong sub-block match inside a multi-account PDF, etc.)
   can produce a "components add up to 1/100th of the total" result that
   looks identical to a genuine decimal-drop even when the saved total is
   correct. Added a plausibility guard: a proposed change is only shown if
   the corrected value is consistent with this same meter's OWN other gas
   bills (within 0.15x-6x of their median), the same "corroborate against
   history" pattern already used by the Evergy scan below. When there is not
   enough bill history to check independently, the bill is listed as
   "could not check" instead of guessing.
   ══════════════════════════════════════════════════════ */
async function _bcrScanKGSMeterBills(h) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find(
    (r) => r.name === 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)',
  );
  if (!rule) return;
  const allProjects = sget('en_projects', []) || [];
  const candidates = [];
  forEachCustomerBuilding(allProjects, (bldg, proj) => {
    (bldg.meters || []).forEach((meter) => {
      (meter.bills || []).forEach((bill) => {
        if (!bill) return;
        const uc = (bill.utilityCompany || '').toLowerCase();
        const commodity = (bill.commodity || '').toLowerCase();
        if (!uc.includes('kansas gas service') || commodity !== 'gas') return;
        if (bill.totalCost == null || bill.totalCost === '') return;
        candidates.push({ bill, meter, bldg, proj });
      });
    });
  });
  const byPdfKey = new Map();
  for (const c of candidates) {
    if (!c.bill.pdfKey) continue;
    if (!byPdfKey.has(c.bill.pdfKey)) byPdfKey.set(c.bill.pdfKey, []);
    byPdfKey.get(c.bill.pdfKey).push(c);
  }
  for (const c of candidates) {
    if (!c.bill.pdfKey) {
      h.onSkip({
        label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
        building: c.bldg.name || c.bldg.addr || '',
        meter: meterLabel(c.meter),
        utility: 'Kansas Gas Service',
        period: _bcrPeriodLabel(c.bill.start, c.bill.end),
        field: 'Total Current Charges',
        reason: 'no stored PDF for this bill, so it cannot be re-checked',
        kind: 'could-not-check',
      });
    }
  }
  const pdfKeys = Array.from(byPdfKey.keys());
  h.onProgress('Kansas Gas Service — re-reading stored bill PDFs', pdfKeys.length);
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    h.onStep(k + 1, pdfKeys.length, 'Re-reading Kansas Gas Service PDF ' + (k + 1) + ' of ' + pdfKeys.length);
    let text = null;
    try {
      text = await _bcrLoadPdfText(pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] KGS PDF re-read failed for', pdfKey, e);
    }
    if (!text) {
      group.forEach((c) =>
        h.onSkip({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'Kansas Gas Service',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Total Current Charges',
          reason: 'the stored PDF could not be read',
          kind: 'could-not-check',
        }),
      );
      continue;
    }
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      group.forEach((c) =>
        h.onSkip({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'Kansas Gas Service',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Total Current Charges',
          reason: 're-reading the stored PDF did not produce usable text',
          kind: 'could-not-check',
        }),
      );
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg, proj } = c;
      const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
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
        h.onSkip({
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
        h.onSkip({
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
      if (!out || !out._auto_corrected_TotalCurrentCharges) {
        h.onSkip({
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
      if (String(out.TotalCurrentCharges) === String(bill.totalCost)) {
        h.onSkip({
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
        h.onSkip({
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
        h.onSkip({
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
      h.onRow({
        _rowId: 'kgs:' + bill.id + ':totalCost',
        store: 'meter',
        projId: proj.id,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        fieldKey: 'totalCost',
        field: 'Total Current Charges',
        utility: 'Kansas Gas Service',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: bill.pdfKey || null,
        currentValue: bill.totalCost,
        correctedValue: out.TotalCurrentCharges,
        reason:
          "The printed total was 100 times the sum of this bill's own charges (the scanner likely dropped two decimal places), re-read from the bill's own stored PDF and checked against this meter's own bill history.",
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 2 — City of Louisburg Bill Date reading the Penalty Date instead
   ══════════════════════════════════════════════════════ */
async function _bcrScanLouisburgDate(h) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'City of Louisburg');
  if (!rule) return;
  const allProjects = sget('en_projects', []) || [];
  const candidates = [];
  forEachCustomerBuilding(allProjects, (bldg, proj) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      (meter.bills || []).forEach((bill) => {
        if (!bill || !bill.billDate) return;
        // _extractNew (the buggy path) always emits BillDate as M/D/YYYY
        // (4-digit year); _extractOld emits M/DD/YY. Only 4-digit-year bills
        // are candidates — confirmed against the real 5-date period row.
        if (!/^\d{1,2}\/\d{1,2}\/(\d{4})$/.test(String(bill.billDate))) return;
        if (!provider.includes('louisburg')) return;
        candidates.push({ bill, meter, bldg, proj });
      });
    });
  });
  const byPdfKey = new Map();
  for (const c of candidates) {
    if (!c.bill.pdfKey) continue;
    if (!byPdfKey.has(c.bill.pdfKey)) byPdfKey.set(c.bill.pdfKey, []);
    byPdfKey.get(c.bill.pdfKey).push(c);
  }
  for (const c of candidates) {
    if (!c.bill.pdfKey) {
      h.onSkip({
        label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
        building: c.bldg.name || c.bldg.addr || '',
        meter: meterLabel(c.meter),
        utility: 'City of Louisburg',
        period: _bcrPeriodLabel(c.bill.start, c.bill.end),
        field: 'Bill Date',
        reason: 'no stored PDF for this bill, so it cannot be re-checked',
        kind: 'could-not-check',
      });
    }
  }
  const pdfKeys = Array.from(byPdfKey.keys());
  h.onProgress('City of Louisburg — checking bill dates against stored PDFs', pdfKeys.length);
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    h.onStep(k + 1, pdfKeys.length, 'Checking Louisburg bill date — stored PDF ' + (k + 1) + ' of ' + pdfKeys.length);
    let text = null;
    try {
      text = await _bcrLoadPdfText(pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] Louisburg PDF re-read failed for', pdfKey, e);
    }
    if (!text) {
      group.forEach((c) =>
        h.onSkip({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'City of Louisburg',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Bill Date',
          reason: 'the stored PDF could not be read',
          kind: 'could-not-check',
        }),
      );
      continue;
    }
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      group.forEach((c) =>
        h.onSkip({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          building: c.bldg.name || c.bldg.addr || '',
          meter: meterLabel(c.meter),
          utility: 'City of Louisburg',
          period: _bcrPeriodLabel(c.bill.start, c.bill.end),
          field: 'Bill Date',
          reason: 're-reading the stored PDF did not produce usable text',
          kind: 'could-not-check',
        }),
      );
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg, proj } = c;
      const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
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
        h.onSkip({
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
        h.onSkip({
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
        h.onSkip({
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
      h.onRow({
        _rowId: 'lou:' + bill.id + ':billDate',
        store: 'meter',
        projId: proj.id,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        fieldKey: 'billDate',
        field: 'Bill Date',
        utility: 'City of Louisburg',
        projName: proj.name || '',
        bldgName: building,
        meterLabel: meterLbl,
        period,
        pdfKey: bill.pdfKey || null,
        currentValue: bill.billDate,
        correctedValue: newBillDate,
        reason:
          'This bill prints five dates in a row (period start, period end, bill date, penalty date, due date); the saved Bill Date was read from the Penalty Date column instead of the Bill Date column.',
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 3 — City of Louisburg account-number OCR misread (2026-09-25, new)

   Every bill on one meter should carry the same account number. When one
   bill's saved account number differs from the meter's own dominant account
   number by exactly one digit (the same shape as the known misreads —
   "1600100" printed/read as "1800100", "236000" as "238000"), that single
   bill's account number is treated as an OCR misread and corrected to match
   the meter's own dominant value. Purely a same-meter consistency check — no
   PDF re-read is required to find the candidate (the mismatch is visible in
   already-saved data), but the source PDF is still offered for one-click
   viewing before Matt applies it.
   ══════════════════════════════════════════════════════ */
async function _bcrScanLouisburgAccountOCR(h) {
  const allProjects = sget('en_projects', []) || [];
  const meterEntries = [];
  forEachCustomerBuilding(allProjects, (bldg, proj) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      const hasLouisburgBill = (meter.bills || []).some((b) => /louisburg/i.test(b.utilityCompany || ''));
      if (!provider.includes('louisburg') && !hasLouisburgBill) return;
      meterEntries.push({ meter, bldg, proj });
    });
  });
  h.onProgress("City of Louisburg — checking account numbers against each meter's own history", meterEntries.length);
  let step = 0;
  for (const { meter, bldg, proj } of meterEntries) {
    step++;
    h.onStep(step, meterEntries.length, 'Checking account numbers on meter ' + step + ' of ' + meterEntries.length);
    const withAcct = (meter.bills || []).filter((b) => b && b.accountNumber);
    if (withAcct.length < 2) continue;
    const digitsOnly = (s) => String(s).replace(/\D/g, '');
    const rawCounts = new Map(); // raw string -> count
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
      h.onRow({
        _rowId: 'louacct:' + bill.id + ':accountNumber',
        store: 'meter',
        projId: proj.id,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        fieldKey: 'accountNumber',
        field: 'Account Number',
        utility: 'City of Louisburg',
        projName: proj.name || '',
        bldgName: bldg.name || bldg.addr || '',
        meterLabel: meterLabel(meter),
        period: _bcrPeriodLabel(bill.start, bill.end),
        pdfKey: bill.pdfKey || null,
        currentValue: raw,
        correctedValue: modeRaw,
        reason:
          'Every other bill on this meter shows account number ' +
          modeRaw +
          ". This one bill's account number differs by a single digit — the scanner likely misread one digit on this bill's own PDF.",
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   SCAN 4 — Evergy RkVA rate OCR digit-misread
   ══════════════════════════════════════════════════════ */
async function _bcrScanEvergyRkva(h) {
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'Evergy');
  if (!rule) return;
  const allProjects = sget('en_projects', []) || [];
  // Cheap first pass (no PDF work): find bills whose stored rkvaRate differs
  // from their own meter's dominant (mode) rate by >5%, while that dominant
  // rate still covers at least half the meter's RkVA-billed history.
  const meterEntries = [];
  forEachCustomerBuilding(allProjects, (bldg, proj) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      if (!provider.includes('evergy') && !(meter.bills || []).some((b) => /evergy/i.test(b.utilityCompany || '')))
        return;
      meterEntries.push({ meter, bldg, proj });
    });
  });
  const candidates = [];
  for (const { meter, bldg, proj } of meterEntries) {
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
        candidates.push({ bill: b, meter, bldg, proj });
      }
    });
  }
  h.onProgress('Evergy — re-reading stored bill PDFs for the demand charge rate', candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const { bill, meter, bldg, proj } = candidates[i];
    h.onStep(i + 1, candidates.length, 'Checking Evergy demand charge rate ' + (i + 1) + ' of ' + candidates.length);
    const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
    const building = bldg.name || bldg.addr || '';
    const meterLbl = meterLabel(meter);
    const period = _bcrPeriodLabel(bill.start, bill.end);
    if (!bill.pdfKey) {
      h.onSkip({
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
    let text = null;
    try {
      text = await _bcrLoadPdfText(bill.pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] Evergy PDF re-read failed for', bill.id, e);
    }
    if (!text) {
      h.onSkip({
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
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      h.onSkip({
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
      h.onSkip({
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
      h.onSkip({
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
      h.onSkip({
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
      h.onSkip({
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
    // Fix (2026-09-25, bill-panel-followup, case 1): newRate comes straight out
    // of a charge/quantity division on re-extracted OCR text, so it carries
    // floating-point noise the printed bill never had (e.g.
    // "0.6629554655870445"). Round the value we actually PROPOSE AND STORE
    // to the same 3-decimal precision this scan already uses everywhere else
    // to compare RkVA rates (see modeEntry above) — storing the raw float
    // would both show as an ugly number and make this bill look like a
    // fresh mismatch against its own meter history the next time this scan
    // runs.
    const roundedRate = Math.round(parseFloat(newRate) * 1000) / 1000;
    h.onRow({
      _rowId: 'evg:' + bill.id + ':rkvaRate',
      store: 'meter',
      projId: proj.id,
      bldgId: bldg.id,
      meterId: meter.id,
      billId: bill.id,
      fieldKey: 'rkvaRate',
      field: 'RkVA Rate',
      utility: 'Evergy',
      projName: proj.name || '',
      bldgName: building,
      meterLabel: meterLbl,
      period,
      pdfKey: bill.pdfKey || null,
      currentValue: bill.rkvaRate,
      correctedValue: roundedRate,
      reason:
        "This bill's printed demand charge rate did not match its own printed charge and quantity (the scanner likely misread one digit). Corrected using the bill's own charge and quantity.",
    });
  }
}

/* ══════════════════════════════════════════════════════
   SCAN — run all phases in sequence, streaming rows/skips/progress to the UI
   ══════════════════════════════════════════════════════ */
const _BCR_PHASES = [
  {
    label: 'Kansas Gas Service bills',
    run: async (h) => {
      await _bcrScanKGSUnmatched(h);
      await _bcrScanKGSMeterBills(h);
    },
  },
  { label: 'City of Louisburg bill dates', run: _bcrScanLouisburgDate },
  { label: 'City of Louisburg account numbers', run: _bcrScanLouisburgAccountOCR },
  { label: 'Evergy demand charge rates', run: _bcrScanEvergyRkva },
];

async function _bcrRunAllScans({ onRow, onSkip, onRender }) {
  _bcrProgress = {
    phaseLabel: 'Starting...',
    phaseIndex: 0,
    totalPhases: _BCR_PHASES.length,
    doneInPhase: 0,
    totalInPhase: 1,
  };
  for (let p = 0; p < _BCR_PHASES.length; p++) {
    const phase = _BCR_PHASES[p];
    _bcrProgress.phaseIndex = p;
    _bcrProgress.phaseLabel = phase.label;
    _bcrProgress.doneInPhase = 0;
    _bcrProgress.totalInPhase = 1;
    onRender();
    const handlers = {
      onRow: (row) => {
        _bcrRows.push(row);
        onRow(row);
      },
      onSkip: (entry) => {
        _bcrSkipped.push(entry);
        onSkip(entry);
      },
      onProgress: (label, total) => {
        _bcrProgress.phaseLabel = label;
        _bcrProgress.totalInPhase = Math.max(1, total);
        _bcrProgress.doneInPhase = 0;
        onRender();
      },
      onStep: (done, total, label) => {
        _bcrProgress.phaseLabel = label;
        _bcrProgress.doneInPhase = done;
        _bcrProgress.totalInPhase = Math.max(1, total);
        onRender();
      },
    };
    await phase.run(handlers);
  }
  _bcrProgress.phaseIndex = _BCR_PHASES.length;
  _bcrProgress.doneInPhase = 1;
  _bcrProgress.totalInPhase = 1;
}

/* ══════════════════════════════════════════════════════
   APPLY — re-checks the live value, then writes through the app's normal
   save path (never a direct/raw write bypassing it).
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
   UI — modal, summary, grouped table, progress bar, Apply
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
    '.bcr-group{border:1px solid var(--border);border-radius:8px;margin:0 20px 12px;overflow:hidden}' +
    '.bcr-group-hdr{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--s1);cursor:pointer;user-select:none}' +
    '.bcr-group-hdr .bcr-caret{width:10px;display:inline-block;color:var(--text2)}' +
    '.bcr-group-title{font-weight:600;color:var(--text);font-size:13px}' +
    '.bcr-group-count{color:var(--text2);font-size:11.5px}' +
    '.bcr-group-body.collapsed{display:none}' +
    '.bcr-pdf-btn{font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer}' +
    '.bcr-summary{margin:14px 20px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:var(--s1)}' +
    '.bcr-summary-count{font-size:22px;font-weight:700;color:var(--text)}' +
    '.bcr-summary-row{display:flex;gap:24px;flex-wrap:wrap;margin-top:8px}' +
    '.bcr-summary-col{font-size:12px;color:var(--text2)}' +
    '.bcr-summary-col b{color:var(--text)}' +
    '.bcr-progress-wrap{margin:0 20px 6px;padding:14px 0}' +
    '.bcr-progress-label{font-size:12.5px;color:var(--text2);margin-bottom:8px}' +
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
    '<span id="bcrApplyCount" style="color:var(--text2);font-size:12px;margin-right:auto">Nothing changes until you apply.</span>' +
    '<button class="btn btn-ghost" id="bcrCloseBtn">Close</button>' +
    '<button class="btn btn-em" id="bcrApplyBtn">Apply Selected</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(div);
  document.getElementById('bcrCloseX').addEventListener('click', closeBillCorrectionsReviewModal);
  document.getElementById('bcrCloseBtn').addEventListener('click', closeBillCorrectionsReviewModal);
  document.getElementById('bcrApplyBtn').addEventListener('click', _bcrApplyClicked);
}

async function openBillCorrectionsReviewModal() {
  _bcrEnsureModal();
  const modal = document.getElementById('bcrModal');
  modal.classList.add('open');
  document.getElementById('bcrFtr').style.display = 'none';
  _bcrRows = [];
  _bcrSkipped = [];
  _bcrGroupCollapse = {};
  _bcrSkippedCollapsed = true;
  _bcrScanning = true;
  _bcrScanned = false;
  _bcrRender();
  await _bcrRunAllScans({
    onRow: () => _bcrRenderThrottled(),
    onSkip: () => _bcrRenderThrottled(),
    onRender: () => _bcrRenderThrottled(),
  });
  _bcrScanning = false;
  _bcrScanned = true;
  _bcrRender();
}
window.openBillCorrectionsReviewModal = openBillCorrectionsReviewModal;

function _bcrRenderThrottled() {
  const now = Date.now();
  if (now - _bcrLastRenderAt > 250) {
    _bcrLastRenderAt = now;
    _bcrRender();
  }
}

function closeBillCorrectionsReviewModal() {
  const m = document.getElementById('bcrModal');
  if (m) m.classList.remove('open');
}
window.closeBillCorrectionsReviewModal = closeBillCorrectionsReviewModal;

function _bcrFieldCounts() {
  const byField = {};
  const byBuilding = {};
  _bcrRows.forEach((r) => {
    byField[r.field] = (byField[r.field] || 0) + 1;
    byBuilding[r.bldgName] = (byBuilding[r.bldgName] || 0) + 1;
  });
  return { byField, byBuilding };
}

function _bcrRenderProgress() {
  if (!_bcrScanning) return '';
  const pct = _bcrProgressPct();
  return (
    '<div class="bcr-progress-wrap">' +
    '<div class="bcr-progress-label">' +
    _bcrEsc(_bcrProgress.phaseLabel) +
    ' — step ' +
    _bcrProgress.phaseIndex +
    ' of ' +
    _bcrProgress.totalPhases +
    ' (' +
    Math.round(pct) +
    '%)</div>' +
    '<div class="bcr-progress-bar"><div class="bcr-progress-fill" style="width:' +
    pct.toFixed(1) +
    '%"></div></div>' +
    '<div style="font-size:11.5px;color:var(--text2);margin-top:6px">Re-reading each candidate bill\'s own stored PDF and checking it against the app\'s corrected extraction logic — this can take a little while on a large bill history. Found so far: ' +
    _bcrRows.length +
    ' correction' +
    (_bcrRows.length === 1 ? '' : 's') +
    ', ' +
    _bcrSkipped.length +
    ' checked with no change needed.</div>' +
    '</div>'
  );
}

function _bcrRenderSummary() {
  if (!_bcrRows.length) return '';
  const { byField, byBuilding } = _bcrFieldCounts();
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
    _bcrRows.length +
    ' correction' +
    (_bcrRows.length === 1 ? '' : 's') +
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

function _bcrRenderGroups() {
  if (!_bcrRows.length) return '';
  const groups = new Map(); // key -> { title, rows }
  _bcrRows.forEach((r) => {
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
      '<th></th><th>Bill Period</th><th>Field</th><th>Current Value</th><th>Proposed Value</th><th>Why</th><th>PDF</th>' +
      '</tr></thead><tbody>';
    g.rows.forEach((row) => {
      html +=
        '<tr>' +
        '<td><input type="checkbox" class="bcr-row-check" data-groupkey="' +
        _bcrEsc(key) +
        '" data-rowid="' +
        _bcrEsc(row._rowId) +
        '" checked></td>' +
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
        '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div></div>';
  }
  return html;
}

function _bcrRenderSkipped() {
  if (!_bcrSkipped.length) return '';
  const noChange = _bcrSkipped.filter((s) => s.kind === 'no-change');
  const couldNot = _bcrSkipped.filter((s) => s.kind !== 'no-change');
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
    _bcrSkipped.length +
    ' bill' +
    (_bcrSkipped.length === 1 ? '' : 's') +
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
  if (lbl) lbl.textContent = 'Nothing changes until you apply. ' + n + ' row' + (n === 1 ? '' : 's') + ' selected.';
}

function _bcrRender() {
  const body = document.getElementById('bcrBody');
  const ftr = document.getElementById('bcrFtr');
  if (!body) return;
  let html = _bcrRenderProgress();
  if (!_bcrScanning && !_bcrRows.length && !_bcrSkipped.length) {
    html += '<div style="padding:24px;text-align:center;color:var(--text2)">No pending bill corrections.</div>';
  } else {
    html += _bcrRenderSummary();
    html += _bcrRenderGroups();
    html += _bcrRenderSkipped();
    if (!_bcrRows.length && !_bcrScanning) {
      html =
        _bcrRenderProgress() +
        '<div style="padding:24px;text-align:center;color:var(--text2)">No pending bill corrections.</div>' +
        _bcrRenderSkipped();
    }
  }
  body.innerHTML = html;
  ftr.style.display = _bcrRows.length ? 'flex' : 'none';
  if (_bcrRows.length) _bcrUpdateApplyCount();

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
      document
        .querySelectorAll('.bcr-row-check[data-groupkey="' + cb.dataset.groupkey + '"]')
        .forEach((rcb) => (rcb.checked = cb.checked));
      _bcrUpdateApplyCount();
    });
  });
  document.querySelectorAll('.bcr-row-check').forEach((cb) => {
    cb.addEventListener('change', _bcrUpdateApplyCount);
  });
  document.querySelectorAll('.bcr-pdf-btn').forEach((btn) => {
    btn.addEventListener('click', () => _bcrOpenPdf(btn.dataset.pdfkey));
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
      const groups = new Set(_bcrRows.map(_bcrGroupKey));
      groups.forEach((k) => (_bcrGroupCollapse[k] = true));
      _bcrRender();
    });
}

async function _bcrApplyClicked() {
  const applyBtn = document.getElementById('bcrApplyBtn');
  const checked = new Set(
    Array.from(document.querySelectorAll('.bcr-row-check:checked')).map((cb) => cb.dataset.rowid),
  );
  const toApply = _bcrRows.filter((r) => checked.has(r._rowId));
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
  _bcrRows = _bcrRows.filter((r) => !checked.has(r._rowId));
  _bcrSkipped = _bcrSkipped.concat(newlySkipped);
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
