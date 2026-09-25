/* ══════════════════════════════════════════════════════════════════════════
   REVIEW BILL CORRECTIONS (2026-09-24, Matt-approved one-time review tool)

   Three parser fixes shipped earlier the same day:
     - app/bill-analysis.js  _postExtractionVerify: Kansas Gas Service Pass B2
       auto-corrects a 100x OCR decimal-drop on TotalCurrentCharges.
     - app/energy-savings.js City of Louisburg _extractNew: reads the printed
       Bill Date (dates[2]) instead of the Penalty Date (dates[3]).
     - app/energy-savings.js _extractEvergy: single-part RATE AUTO-CORRECTION
       now writes the derived rate into result.RkVARate (RATE_FIELD_MAP).

   Bills saved BEFORE these fixes shipped still hold the old wrong values.
   This file never rewrites a saved bill on its own. It scans saved bills,
   calls the REAL shipped functions (never hardcodes a target number) to see
   what each bill's value would be today, and shows Matt a table. Only a row
   Matt ticks and applies gets written — through the app's normal save path
   (saveUtilityData() for meter bills, sset('en_pdf_bills', ...) for unmatched
   bills) so audit history (logUtilityAudit) and sync fire exactly like any
   other manual correction.

   Depends on globals already loaded earlier on this page: sget/sset (core.js),
   pdfLoad/pdfStore (core.js), extractPDFText (bill-analysis.js),
   _postExtractionVerify (bill-analysis.js), UTILITY_RULES (energy-savings.js),
   saveUtilityData/logUtilityAudit/_auditCtxFromIds/_auditPeriodLabel/
   getUDMeter/forEachCustomerBuilding/getProjectsForBuilding/meterLabel
   (utility-data.js), projects/utilityData (core.js/utility-data.js),
   showToast (site-ui.js).
   ═══════════════════════════════════════════════════════════════════════ */

let _bcrRows = []; // pending correction rows currently shown in the table
let _bcrSkipped = []; // [{ label, reason }] — bills that could not be corrected
let _bcrScanned = false; // true once at least one scan has completed

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

/* ══════════════════════════════════════════════════════
   SCAN 1 — Kansas Gas Service 100x decimal-drop

   Two storage shapes hold Kansas Gas Service bills:
     (a) the flat en_pdf_bills queue (bills held for review that could not be
         matched to any meter) — these keep every original extractor field
         (PascalCase), so _postExtractionVerify can run on them unmodified.
     (b) a normal meter.bills[] row, including the "Unmatched Bills" sentinel
         building the app creates per customer when a batch bill has no
         account/meter match (app/bill-analysis.js _autoCreateMeterAndSaveBill).
         This is a SAVED row, so it only keeps the narrow whitelist of fields
         app/bill-analysis.js writes at save time (lowercase names) — the
         KGS-only component fields Pass B2 needs (DeliveryCharge,
         GasSystemReliability, WeatherNormalization, WinterEventCost,
         DelayedPaymentCharge) are not part of that whitelist and are gone
         from a saved row. Confirmed against Baker University's own saved
         bills: reconstructing a synthetic object from only the surviving
         fields under-counts the true component sum and suppresses the real
         correction. So (b) re-extracts the bill's own stored PDF (via
         pdfKey) with the real "Gas Utility" extractor, exactly like the
         Louisburg and Evergy scans below, instead of reconstructing from a
         known-incomplete field set.
   ══════════════════════════════════════════════════════ */
async function _bcrScanKGSUnmatched(progressCb) {
  const rows = [];
  const allBills = (await sget('en_pdf_bills', [])) || [];
  const kgsBills = allBills.filter(
    (b) => b && (b.UtilityCompany === 'Kansas Gas Service' || b._utilityName === 'Kansas Gas Service'),
  );
  for (let i = 0; i < kgsBills.length; i++) {
    const b = kgsBills[i];
    if (progressCb)
      progressCb('Checking Kansas Gas Service unmatched bill ' + (i + 1) + ' of ' + kgsBills.length + '...');
    let out;
    try {
      const clone = JSON.parse(JSON.stringify(b));
      const res = await _postExtractionVerify([clone], 'Kansas Gas Service', '');
      out = res && res.bills && res.bills[0];
    } catch (e) {
      console.warn('[bill-corrections-review] KGS re-check failed for', b.id, e);
      continue;
    }
    if (!out || !out._auto_corrected_TotalCurrentCharges) continue;
    const projName = b.projName || 'Unmatched Bills';
    const account = b.AccountNumber || '';
    const period = (b.BillingPeriodStart || '') + ' to ' + (b.BillingPeriodEnd || '');
    if (String(out.TotalCurrentCharges) !== String(b.TotalCurrentCharges)) {
      rows.push({
        _rowId: 'kgs:' + b.id + ':TotalCurrentCharges',
        store: 'en_pdf_bills',
        billId: b.id,
        fieldKey: 'TotalCurrentCharges',
        field: 'Total Current Charges',
        projName,
        bldgName: 'Unmatched Bills',
        meterLabel: account,
        period,
        currentValue: b.TotalCurrentCharges,
        correctedValue: out.TotalCurrentCharges,
        reason:
          "Kansas Gas Service: the printed total was 100 times the sum of this bill's own charge components (an OCR decimal drop). Corrected against the bill's own components.",
      });
    }
    if (b.TotalAmountDue != null && String(out.TotalAmountDue) !== String(b.TotalAmountDue)) {
      rows.push({
        _rowId: 'kgs:' + b.id + ':TotalAmountDue',
        store: 'en_pdf_bills',
        billId: b.id,
        fieldKey: 'TotalAmountDue',
        field: 'Total Amount Due',
        projName,
        bldgName: 'Unmatched Bills',
        meterLabel: account,
        period,
        currentValue: b.TotalAmountDue,
        correctedValue: out.TotalAmountDue,
        reason: 'Total Amount Due mirrors Total Current Charges on this bill and carried the same decimal-drop error.',
      });
    }
  }
  return { rows, skipped: [] };
}

// A saved meter.bills row only keeps the narrow field whitelist
// app/bill-analysis.js writes at save time (lowercase names) — the KGS-only
// component fields Pass B2 needs (DeliveryCharge, GasSystemReliability,
// WeatherNormalization, WinterEventCost, DelayedPaymentCharge) are not part
// of that whitelist and are simply gone from a saved row. Reconstructing a
// synthetic object from only the surviving fields under-counts the true
// component sum and can suppress a real correction (confirmed against Baker
// University's own saved bills: their full component sum only reconciles
// once DeliveryCharge-type fields are back in the picture). So, exactly like
// the Louisburg and Evergy scans below, this re-extracts the bill's own
// stored PDF (via pdfKey) and re-runs the REAL "Gas Utility" extractor to
// recover the complete, original component set, then verifies with the REAL
// (already-fixed) _postExtractionVerify — never a reconstruction with gaps.
async function _bcrScanKGSMeterBills(progressCb) {
  const rows = [];
  const skipped = [];
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find(
    (r) => r.name === 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)',
  );
  if (!rule) return { rows, skipped };
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
      skipped.push({
        label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
        reason: 'no source text/PDF available to re-derive',
      });
    }
  }
  const pdfKeys = Array.from(byPdfKey.keys());
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    if (progressCb)
      progressCb('Re-checking Kansas Gas Service bill — stored PDF ' + (k + 1) + ' of ' + pdfKeys.length + '...');
    let text = null;
    try {
      text = await _bcrLoadPdfText(pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] KGS PDF re-read failed for', pdfKey, e);
    }
    if (!text) {
      group.forEach((c) =>
        skipped.push({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          reason: 'no source text/PDF available to re-derive',
        }),
      );
      continue;
    }
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      group.forEach((c) =>
        skipped.push({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          reason: 're-extraction of the stored PDF failed',
        }),
      );
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg, proj } = c;
      const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
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
        skipped.push({
          label,
          reason:
            matches.length === 0
              ? 'could not re-match this bill in its stored PDF (account/period not found)'
              : 'stored PDF re-extraction produced ' + matches.length + ' ambiguous matches for this bill',
        });
        continue;
      }
      let out;
      try {
        const res = await _postExtractionVerify([matches[0]], 'Kansas Gas Service', text);
        out = res && res.bills && res.bills[0];
      } catch (e) {
        skipped.push({ label, reason: 're-verification of the re-extracted bill failed' });
        continue;
      }
      if (!out || !out._auto_corrected_TotalCurrentCharges) continue; // re-extraction confirms no change needed
      if (String(out.TotalCurrentCharges) === String(bill.totalCost)) continue;
      rows.push({
        _rowId: 'kgs:' + bill.id + ':totalCost',
        store: 'meter',
        projId: proj.id,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        fieldKey: 'totalCost',
        field: 'Total Current Charges',
        projName: proj.name || '',
        bldgName: bldg.name || bldg.addr || '',
        meterLabel: meterLabel(meter),
        period: (bill.start || '') + ' to ' + (bill.end || ''),
        currentValue: bill.totalCost,
        correctedValue: out.TotalCurrentCharges,
        reason:
          "Kansas Gas Service: the printed total was 100 times the sum of this bill's own charge components (an OCR decimal drop), re-derived from the bill's original stored PDF. Corrected against the bill's own components.",
      });
    }
  }
  return { rows, skipped };
}

async function _bcrScanKGS(progressCb) {
  const a = await _bcrScanKGSUnmatched(progressCb);
  const b = await _bcrScanKGSMeterBills(progressCb);
  return { rows: a.rows.concat(b.rows), skipped: a.skipped.concat(b.skipped) };
}

/* ══════════════════════════════════════════════════════
   SCAN 2 — City of Louisburg Bill Date (reads Penalty Date instead)
   ══════════════════════════════════════════════════════ */
async function _bcrScanLouisburg(progressCb) {
  const rows = [];
  const skipped = [];
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'City of Louisburg');
  if (!rule) return { rows, skipped };
  const allProjects = sget('en_projects', []) || [];
  const candidates = [];
  forEachCustomerBuilding(allProjects, (bldg, proj, custId) => {
    (bldg.meters || []).forEach((meter) => {
      const provider = ((meter.provider || '') + ' ' + (meter.utilityCompany || '')).toLowerCase();
      (meter.bills || []).forEach((bill) => {
        if (!bill || !bill.billDate) return;
        // Heuristic confirmed against the real 5-date period row: _extractNew
        // (the buggy path) always emits BillDate as M/D/YYYY (4-digit year);
        // _extractOld emits M/DD/YY. Only 4-digit-year bills are candidates.
        if (!/^\d{1,2}\/\d{1,2}\/(\d{4})$/.test(String(bill.billDate))) return;
        if (!provider.includes('louisburg')) return;
        candidates.push({ bill, meter, bldg, proj, custId });
      });
    });
  });
  // Group by pdfKey so a batch PDF covering several commodities/meters is
  // re-extracted (extractAll) only once, not once per candidate bill.
  const byPdfKey = new Map();
  for (const c of candidates) {
    if (!c.bill.pdfKey) continue;
    if (!byPdfKey.has(c.bill.pdfKey)) byPdfKey.set(c.bill.pdfKey, []);
    byPdfKey.get(c.bill.pdfKey).push(c);
  }
  for (const c of candidates) {
    if (!c.bill.pdfKey) {
      skipped.push({
        label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
        reason: 'no source text/PDF available to re-derive',
      });
    }
  }
  const pdfKeys = Array.from(byPdfKey.keys());
  for (let k = 0; k < pdfKeys.length; k++) {
    const pdfKey = pdfKeys[k];
    const group = byPdfKey.get(pdfKey);
    if (progressCb)
      progressCb('Re-checking Louisburg bill date — stored PDF ' + (k + 1) + ' of ' + pdfKeys.length + '...');
    let text = null;
    try {
      text = await _bcrLoadPdfText(pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] Louisburg PDF re-read failed for', pdfKey, e);
    }
    if (!text) {
      group.forEach((c) =>
        skipped.push({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          reason: 'no source text/PDF available to re-derive',
        }),
      );
      continue;
    }
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      group.forEach((c) =>
        skipped.push({
          label: _bcrBillLabel(c.proj && c.proj.name, c.bldg.name || c.bldg.addr, meterLabel(c.meter), c.bill),
          reason: 're-extraction of the stored PDF failed',
        }),
      );
      continue;
    }
    for (const c of group) {
      const { bill, meter, bldg, proj } = c;
      const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
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
        skipped.push({
          label,
          reason:
            matches.length === 0
              ? 'could not re-match this bill in its stored PDF (account/period/commodity not found)'
              : 'stored PDF re-extraction produced ' + matches.length + ' ambiguous matches for this bill',
        });
        continue;
      }
      const m = matches[0];
      const newBillDate = m.BillDate || '';
      if (!newBillDate || newBillDate === bill.billDate) continue; // no change — not a candidate
      // Guard: only billDate may change. Period is already required identical by
      // the match above; also require the total charge to be unchanged so a
      // wrong-bill match can never slip through as a "same-day discrepancy."
      const newTotal = m.TotalAmountDue != null ? parseFloat(String(m.TotalAmountDue).replace(/,/g, '')) : null;
      const oldTotal = bill.totalCost != null && bill.totalCost !== '' ? parseFloat(bill.totalCost) : null;
      if (newTotal != null && oldTotal != null && Math.abs(newTotal - oldTotal) > 0.5) {
        skipped.push({
          label,
          reason:
            're-extraction would also change the amount, not just Bill Date — skipped as a possible wrong-bill match, not a same-day discrepancy',
        });
        continue;
      }
      rows.push({
        _rowId: 'lou:' + bill.id + ':billDate',
        store: 'meter',
        projId: proj.id,
        bldgId: bldg.id,
        meterId: meter.id,
        billId: bill.id,
        fieldKey: 'billDate',
        field: 'Bill Date',
        projName: proj.name || '',
        bldgName: bldg.name || bldg.addr || '',
        meterLabel: meterLabel(meter),
        period: (bill.start || '') + ' to ' + (bill.end || ''),
        currentValue: bill.billDate,
        correctedValue: newBillDate,
        reason:
          'City of Louisburg new-format bill: the period row prints [Start, End, Bill Date, Penalty Date, Due Date] — this bill was saved reading the Penalty Date instead of the Bill Date.',
      });
    }
  }
  return { rows, skipped };
}

/* ══════════════════════════════════════════════════════
   SCAN 3 — Evergy RkVA rate OCR digit-misread
   ══════════════════════════════════════════════════════ */
async function _bcrScanEvergyRkva(progressCb) {
  const rows = [];
  const skipped = [];
  const rule = (typeof UTILITY_RULES !== 'undefined' ? UTILITY_RULES : []).find((r) => r.name === 'Evergy');
  if (!rule) return { rows, skipped };
  const allProjects = sget('en_projects', []) || [];
  // Cheap first pass (no PDF work): find bills whose stored rkvaRate differs
  // from their own meter's dominant (mode) rate by >5%, while that dominant
  // rate still covers at least half the meter's RkVA-billed history — the
  // same OCR-digit-misread signature used to scope the original candidate.
  const meterEntries = []; // { meter, bldg, proj }
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
  for (let i = 0; i < candidates.length; i++) {
    const { bill, meter, bldg, proj } = candidates[i];
    if (progressCb) progressCb('Re-checking Evergy RkVA rate ' + (i + 1) + ' of ' + candidates.length + '...');
    const label = _bcrBillLabel(proj && proj.name, bldg.name || bldg.addr, meterLabel(meter), bill);
    if (!bill.pdfKey) {
      skipped.push({ label, reason: 'no source text/PDF available to re-derive' });
      continue;
    }
    let text = null;
    try {
      text = await _bcrLoadPdfText(bill.pdfKey);
    } catch (e) {
      console.warn('[bill-corrections-review] Evergy PDF re-read failed for', bill.id, e);
    }
    if (!text) {
      skipped.push({ label, reason: 'no source text/PDF available to re-derive' });
      continue;
    }
    let extracted = [];
    try {
      extracted = rule.extractAll(text) || [];
    } catch (e) {
      skipped.push({ label, reason: 're-extraction of the stored PDF failed' });
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
      skipped.push({
        label,
        reason:
          matches.length === 0
            ? 'could not re-match this bill in its stored PDF (account/period not found)'
            : 'stored PDF re-extraction produced ' + matches.length + ' ambiguous matches for this bill',
      });
      continue;
    }
    const m = matches[0];
    if (!m._auto_corrected_rate_RkVACharge) {
      skipped.push({ label, reason: 're-extraction did not confirm an OCR rate misread for this bill' });
      continue;
    }
    const newRate = m.RkVARate;
    if (newRate == null || String(newRate) === String(bill.rkvaRate)) continue;
    // Guard: the charge itself must stay the same — only the rate is corrected.
    if (bill.rkvaCharge && m.RkVACharge && Math.abs(parseFloat(m.RkVACharge) - parseFloat(bill.rkvaCharge)) > 0.5) {
      skipped.push({
        label,
        reason:
          're-extraction would also change the RkVA charge, not just the rate — skipped as a possible wrong-bill match',
      });
      continue;
    }
    rows.push({
      _rowId: 'evg:' + bill.id + ':rkvaRate',
      store: 'meter',
      projId: proj.id,
      bldgId: bldg.id,
      meterId: meter.id,
      billId: bill.id,
      fieldKey: 'rkvaRate',
      field: 'RkVA Rate',
      projName: proj.name || '',
      bldgName: bldg.name || bldg.addr || '',
      meterLabel: meterLabel(meter),
      period: (bill.start || '') + ' to ' + (bill.end || ''),
      currentValue: bill.rkvaRate,
      correctedValue: newRate,
      reason:
        "Evergy single-part rate cross-check: the RkVA rate did not reconcile with this bill's own printed RkVA charge and quantity (an OCR digit misread). Corrected using the bill's own charge/quantity.",
    });
  }
  return { rows, skipped };
}

/* ══════════════════════════════════════════════════════
   SCAN — run all three and combine
   ══════════════════════════════════════════════════════ */
async function _bcrScanAll(progressCb) {
  const rows = [];
  const skipped = [];
  const a = await _bcrScanKGS(progressCb);
  rows.push(...a.rows);
  skipped.push(...a.skipped);
  const b = await _bcrScanLouisburg(progressCb);
  rows.push(...b.rows);
  skipped.push(...b.skipped);
  const c = await _bcrScanEvergyRkva(progressCb);
  rows.push(...c.rows);
  skipped.push(...c.skipped);
  return { rows, skipped };
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
   UI — modal, table, checkboxes, Apply
   ══════════════════════════════════════════════════════ */
function _bcrEnsureModal() {
  if (document.getElementById('bcrModal')) return;
  const div = document.createElement('div');
  div.className = 'modal-bg';
  div.id = 'bcrModal';
  div.innerHTML =
    '<div class="modal" style="width:1080px;max-width:96vw;max-height:90vh">' +
    '<div class="modal-hdr">' +
    '<span class="modal-title">Review Bill Corrections</span>' +
    '<button class="modal-x" id="bcrCloseX">✕</button>' +
    '</div>' +
    '<div class="modal-body" id="bcrBody" style="overflow-y:auto;max-height:70vh"></div>' +
    '<div class="modal-ftr" id="bcrFtr" style="display:none">' +
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
  const body = document.getElementById('bcrBody');
  body.innerHTML =
    '<div style="padding:24px;text-align:center;color:var(--text2)">Scanning saved bills for pending corrections...</div>';
  const { rows, skipped } = await _bcrScanAll((msg) => {
    const el = document.getElementById('bcrBody');
    if (el) el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text2)">' + _bcrEsc(msg) + '</div>';
  });
  _bcrRows = rows;
  _bcrSkipped = skipped;
  _bcrScanned = true;
  _bcrRenderTable();
}
window.openBillCorrectionsReviewModal = openBillCorrectionsReviewModal;

function closeBillCorrectionsReviewModal() {
  const m = document.getElementById('bcrModal');
  if (m) m.classList.remove('open');
}
window.closeBillCorrectionsReviewModal = closeBillCorrectionsReviewModal;

function _bcrRenderTable() {
  const body = document.getElementById('bcrBody');
  const ftr = document.getElementById('bcrFtr');
  if (!body) return;
  if (!_bcrRows.length) {
    ftr.style.display = 'none';
    let html = '<div style="padding:24px;text-align:center;color:var(--text2)">No pending bill corrections.</div>';
    if (_bcrSkipped.length) {
      html +=
        '<div style="margin:0 20px 20px;padding:12px;border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text2)">' +
        '<strong>' +
        _bcrSkipped.length +
        ' bill(s) could not be re-checked:</strong><ul style="margin:8px 0 0 18px;padding:0">' +
        _bcrSkipped.map((s) => '<li>' + _bcrEsc(s.label) + ' — ' + _bcrEsc(s.reason) + '</li>').join('') +
        '</ul></div>';
    }
    body.innerHTML = html;
    return;
  }
  ftr.style.display = 'flex';
  let html =
    '<div style="padding:12px 20px;font-size:12px;color:var(--text2)">' +
    "Each row was recomputed from the bill's own stored data using the corrected extraction logic. " +
    'Un-tick any row you do not want to apply, then click Apply Selected. Applying goes through the normal bill save path, so change history is recorded.' +
    '</div>' +
    '<table class="dtbl" style="width:100%">' +
    '<thead><tr>' +
    '<th><input type="checkbox" id="bcrSelectAll" checked></th>' +
    '<th>Project</th><th>Building</th><th>Meter</th><th>Bill Period</th>' +
    '<th>Field</th><th>Current Value</th><th>Corrected Value</th><th>Reason</th>' +
    '</tr></thead><tbody>';
  _bcrRows.forEach((row) => {
    html +=
      '<tr>' +
      '<td><input type="checkbox" class="bcr-row-check" data-rowid="' +
      _bcrEsc(row._rowId) +
      '" checked></td>' +
      '<td>' +
      _bcrEsc(row.projName) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.bldgName) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.meterLabel) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.period) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.field) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.currentValue) +
      '</td>' +
      '<td>' +
      _bcrEsc(row.correctedValue) +
      '</td>' +
      '<td style="font-size:11px;color:var(--text2)">' +
      _bcrEsc(row.reason) +
      '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  if (_bcrSkipped.length) {
    html +=
      '<div style="margin:16px 20px;padding:12px;border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text2)">' +
      '<strong>' +
      _bcrSkipped.length +
      ' bill(s) were checked but not changed:</strong><ul style="margin:8px 0 0 18px;padding:0">' +
      _bcrSkipped.map((s) => '<li>' + _bcrEsc(s.label) + ' — ' + _bcrEsc(s.reason) + '</li>').join('') +
      '</ul></div>';
  }
  body.innerHTML = html;
  const selectAll = document.getElementById('bcrSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.bcr-row-check').forEach((cb) => (cb.checked = selectAll.checked));
    });
  }
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
        reason: result.reason,
      });
    }
  }
  // Remove every row that was ticked (applied, or no longer applicable) from
  // the pending table. Rows the user left unticked stay for another pass.
  _bcrRows = _bcrRows.filter((r) => !checked.has(r._rowId));
  _bcrSkipped = _bcrSkipped.concat(newlySkipped);
  if (applyBtn) {
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply Selected';
  }
  showToast(
    appliedCount +
      ' bill' +
      (appliedCount === 1 ? '' : 's') +
      ' corrected' +
      (newlySkipped.length ? ', ' + newlySkipped.length + ' skipped' : ''),
  );
  _bcrRenderTable();
  if (typeof renderMeterWorkspace === 'function' && typeof udActiveMid !== 'undefined' && udActiveMid) {
    try {
      renderMeterWorkspace();
    } catch (e) {}
  }
}
