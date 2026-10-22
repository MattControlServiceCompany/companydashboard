/* ══════════════════════════════════════════════════════════════════════════════════════════════
   BILL REPAIR FROM THE STORED PDF (2026-10-15, backlog d178c906)
   The ONE place that decides how a stored bill is repaired from a fresh read of its own PDF page. No DOM, no storage:
   the browser pass (app/auto-repair.js) reads the PDF and saves; everything it decides is here, so the gate
   (tools/gate-auto-repair.js) runs the real functions.

   Rules for every write (each is tested by the gate):
     - A field the user owns (billFieldUserOwned, computations/bill-flags.js: _userCorrected[field],
       _userCorrected_<Field>, or a value retyped over an automatic correction) never changes.
     - A value is never blanked, and an extracted 0 never replaces a stored value that is not 0 (repairValueAllowed,
       applied where the value is built AND where it is written).
     - A bill is matched to a PDF page by page, commodity and account; when both sides carry a meter number they must
       agree, for any number of candidates (a shared account holds several meters).
     - ONE write decision (repairMayWrite; Matt 2026-10-15: never fill a value that is not printed; held is better than
       guessed): a stored value is replaced only when the bill itself contradicts it (a check of the bill's own values
       fails: end - start vs difference, difference x multiplier vs kWh, charge parts vs total, a missing or negative
       value, a date that is missing or makes a bad period) AND the fresh value passes that check AND the fresh value is
       printed on the bill's own page (no reader record that filled or changed it, and its digits in the page text). A
       blank is filled only with such a printed value. Anything else is held and the reason goes to the audit log.
     - Do no harm: the repair runs on a copy of the meter; it is kept only when no bill of the meter gains a flag
       (computeMeterFlagSummary before and after).
     - Nothing is added and nothing is deleted. A PDF page with no row on the meter is reported (repairMissingBillCandidates)
       for the audit log; a duplicate row is reported and marked dup.
     - Every changed field is written to the existing automatic-correction record row._auto_corrected_<field>
       ({ original, corrected, reason, source: PDF_REREAD_SOURCE, at, page, ruleVersion }); Edit Billing Period shows it
       through _billChangeHistory (app/utility-data.js), and every edit path drops it (clearReadCorrectionRecords).
   The extractor's own mapping is reused: _extractedToBillRowCosts and gasBillSaveTherms (no second field map).
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

// Read-family rules: they are not counted in the badges, but a bill with one of them has a read that may be wrong.
const REPAIR_READ_RULES = ['read_continuity', 'read_rollback', 'read_usage_mismatch'];

// "MM/DD/YYYY" or "MM-DD-YY" (the extractor's text) -> "YYYY-MM-DD". An ISO date passes through; anything else is returned
// unchanged. The ONE converter for extracted dates (the duplicate check and the repair both call it).
function _brIsIso(s) {
  return typeof s === 'string' && s.length === 10 && s[4] === '-' && s[7] === '-' && !isNaN(Date.parse(s));
}
function extractedDateToISO(d) {
  if (!d) return '';
  if (_brIsIso(d)) return d;
  let p = String(d).split('/');
  if (p.length !== 3) p = String(d).split('-');
  if (p.length !== 3) return d;
  const yr = p[2].length === 2 ? '20' + p[2] : p[2];
  return yr + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
}

// Two periods are the same cycle when BOTH ends are within `tol` days (5 by default).
function billPeriodClose(s1, e1, s2, e2, tol) {
  const lim = tol == null ? 5 : tol;
  const diff = (a, b) => {
    const n = a && b ? Math.abs(calcDays(a, b, false)) : NaN; // the one day-count function
    return isNaN(n) ? Infinity : n;
  };
  return !!s1 && !!e1 && !!s2 && !!e2 && diff(s1, s2) <= lim && diff(e1, e2) <= lim;
}

// The identity test of an extracted bill against a stored bill on a meter: account, meter number, commodity and period.
// _checkDuplicates (app/bill-analysis.js) and the repair both call it. Returns booleans; the caller decides what it needs.
function matchExtractedToBill(ext, bill, meter) {
  const norm = (v) => (v || '').replace(/[\s\-]/g, '').toLowerCase();
  const extAcct = norm(ext.AccountNumber);
  const extMeter = norm(ext.MeterNumber);
  const extComm = (ext.Commodity || '').toLowerCase();
  const existComm = ((bill && bill.commodity) || (meter && meter.commodity) || '').toLowerCase();
  const extStart = extractedDateToISO(ext.BillingPeriodStart || ext.DeliveryDate);
  const extEnd = extractedDateToISO(ext.BillingPeriodEnd || ext.DeliveryDate);
  const existAcct = norm(meter && meter.account);
  const existMeter = norm(meter && meter.meter);
  const periodMatch = !!extStart && bill.start === extStart && !!extEnd && bill.end === extEnd;
  return {
    extAcct,
    existAcct,
    extMeter,
    existMeter,
    acctMatch: _acctFuzzyMatch(extAcct, existAcct),
    meterMatch: !!extMeter && !!existMeter && extMeter === existMeter,
    meterConflict: !!extMeter && !!existMeter && extMeter !== existMeter, // both sides carry a number and they differ
    commMatch: !extComm || !existComm || extComm === existComm,
    periodMatch,
    fuzzyPeriod: !periodMatch && billPeriodClose(extStart, extEnd, bill.start, bill.end),
    extStart,
    extEnd,
  };
}

// The one extracted bill that is THIS stored bill's page. Page, commodity and account must agree, and a meter number on
// both sides must agree (for one candidate as for many); when a page still holds more than one such bill the meter
// number, then the start date, must pick one. Returns { ext } or { declined: reason }.
function findRepairMatch(exts, row, meter) {
  const page = row.pdfPageStart == null || row.pdfPageStart === '' ? null : Number(row.pdfPageStart);
  const pageOf = (e) => Number(e._pageStart != null ? e._pageStart : e._pageIndex);
  const pageEnd = (e) => Number(e._pageEnd != null ? e._pageEnd : pageOf(e));
  let otherMeter = false;
  let cands = (exts || []).filter((e) => {
    if (!e || e._manualReview || e.parseError) return false;
    const m = matchExtractedToBill(e, row, meter);
    if (!m.commMatch || !(e.Commodity || '')) return false;
    // the account on the bill row counts as well as the meter's (a bill can carry the number the utility printed on it)
    const rowAcct = (row.accountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    if (m.extAcct && m.existAcct && !m.acctMatch && !_acctFuzzyMatch(m.extAcct, rowAcct)) return false;
    const onPage = page === null ? m.extStart === row.start : page >= pageOf(e) && page <= pageEnd(e);
    if (!onPage) return false;
    if (m.meterConflict) {
      otherMeter = true; // the page holds another meter of the same account: never this bill's page
      return false;
    }
    if (page === null) return m.meterMatch; // no page stored: meter and period must agree
    return true;
  });
  if (cands.length > 1) {
    const byMeter = cands.filter((e) => matchExtractedToBill(e, row, meter).meterMatch);
    if (byMeter.length) cands = byMeter;
  }
  if (cands.length > 1) {
    const byStart = cands.filter((e) => matchExtractedToBill(e, row, meter).extStart === row.start);
    if (byStart.length) cands = byStart;
  }
  if (cands.length === 0) {
    if (otherMeter) return { declined: 'the PDF page holds another meter number' };
    const held = (exts || []).some((e) => e && e._manualReview && matchExtractedToBill(e, row, meter).commMatch && page !== null && page >= pageOf(e) && page <= pageEnd(e));
    return { declined: held ? 'the reader holds this page for review' : 'no bill on the PDF page matches this bill' };
  }
  if (cands.length > 1) return { declined: 'more than one bill on the PDF page matches this bill' };
  return { ext: cands[0] };
}

// ── field mapping and the one write decision ─────────────────────────────────────────────────

const _brHas = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// The ONE test of a value the repair may write over a stored one: never blank (no text, null, NaN, infinite), and
// never 0 over a stored value that is a number other than 0 (a failed read of a printed figure parses as 0).
// Used where the candidate value is built (repairFieldsFromExtracted), where the trial applies it (planMeterRepair)
// and where the live bill is written (applyRepairChanges).
function repairValueAllowed(from, to) {
  if (to === undefined || to === null || String(to).trim() === '') return false;
  if (typeof to === 'number' && !isFinite(to)) return false;
  const toN = typeof to === 'number' ? to : parseBillNumber(String(to));
  if (toN === 0) {
    const fromN = parseBillNumber(from);
    if (fromN !== null && fromN !== 0) return false;
  }
  return true;
}

// The text of pages pageStart..pageEnd of one PDF (the %%PAGE_N%% markers extractPDFText and _bcrJoinPages write).
// '' when the text has no markers for those pages: nothing can then be proven on the page.
function repairPageText(text, pageStart, pageEnd) {
  if (!text) return '';
  const parts = String(text).split(/%%PAGE_(\d+)%%/);
  const a = Number(pageStart);
  const z = pageEnd == null || pageEnd === '' ? a : Number(pageEnd);
  let out = '';
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const n = Number(parts[i]);
    if (n >= a && n <= z) out += parts[i + 1] + '\n';
  }
  return out;
}

// True when the page text prints the number `value`: a token of the page (commas and $ removed) parses to the same
// number, or, for a whole number, a token whose separators sit at thousands positions holds the same digits (OCR reads
// the thousands comma of "58,552" as "58.552"; "585.52" is not a thousands form and never proves 58552). 0 is never
// proven: a 0 token stands on too many lines ("$.00") to tie it to a field.
function repairValueOnPage(value, pageText) {
  const want = parseBillNumber(value);
  if (want === null || want === 0 || !pageText) return false;
  const wantDigits = Number.isInteger(want) ? String(Math.abs(want)) : null;
  const thousandsForm = (t) => {
    const groups = t.split(/[.,]/);
    return groups.length > 1 && groups[0].length >= 1 && groups[0].length <= 3 && groups.slice(1).every((g) => g.length === 3);
  };
  return String(pageText)
    .replace(/\$/g, '')
    .split(/[^0-9.,]+/)
    .some((t) => {
      if (!t) return false;
      const n = parseBillNumber(t.replace(/,/g, ''));
      if (n !== null && Math.abs(n - want) <= 1e-9) return true;
      return wantDigits !== null && thousandsForm(t) && t.replace(/[.,]/g, '') === wantDigits;
    });
}

// True when the page text prints the date: the reader's own text for it (raw), or the ISO date in M/D/YYYY, MM/DD/YYYY,
// M/D/YY or MM/DD/YY with / or - (the forms the bills in this site print), or one page token whose digits are the
// date's with the four-digit year (OCR drops a dash: "3-15-2025" reads "315-2025"). Whitespace in the page is collapsed.
function repairDateOnPage(raw, iso, pageText) {
  if (!pageText) return false;
  const page = String(pageText).replace(/\s+/g, ' ');
  const forms = [];
  const digitForms = [];
  if (raw) forms.push(String(raw).replace(/\s+/g, ' ').trim());
  if (_brIsIso(iso)) {
    const y = iso.slice(0, 4),
      m = iso.slice(5, 7),
      d = iso.slice(8, 10);
    const months = [m, String(Number(m))];
    const days = [d, String(Number(d))];
    const years = [y, y.slice(2)];
    months.forEach((mm) => days.forEach((dd) => years.forEach((yy) => ['/', '-'].forEach((sep) => forms.push(mm + sep + dd + sep + yy)))));
    months.forEach((mm) => days.forEach((dd) => digitForms.push(mm + dd + y)));
  }
  if (forms.some((f) => f && page.indexOf(f) !== -1)) return true;
  return page.split(' ').some((t) => /\d/.test(t) && digitForms.includes(t.replace(/\D/g, '')));
}

// Where a fresh value comes from. '' = printed on the bill's own page: no record that the reader filled or changed the
// source field (_auto_recovered_<F>: copied from a neighbor bill or computed from an identity; _auto_corrected_<F>: a
// rule changed what was read) and the value itself stands in the page text of the bill's pages. Otherwise the reason.
// For a date `value` is the ISO date and `raw` the reader's text; for a number `raw` is unused.
function repairValueProvenance(ext, srcFields, value, pageText, raw) {
  const marked = (srcFields || []).find((f) => ext && (ext['_auto_recovered_' + f] || ext['_auto_corrected_' + f]));
  if (marked) return 'the reader filled or changed ' + marked + ' (not printed on the page)';
  const onPage = _brIsIso(value) ? repairDateOnPage(raw, value, pageText) : repairValueOnPage(value, pageText);
  return onPage ? '' : 'the value is not printed on the bill page';
}

// The checks a bill proves on its own page and the stored fields each judges. Each is a rule computed from the bill's
// own values (the one flag engine, computeMeterFlagSummary) or, for electric reads, computePrintedReadMismatch. The
// statistical rules (a charge against the meter's usual rate, a neighbor's dates or reads) are NOT here: the repair
// never replaces a value because it is unusual, only because the bill itself contradicts it.
function repairUsageFields(c) {
  return c === 'Gas' ? ['therms', 'naturalGasTherms'] : [_BF_USAGE_COLUMN[c]].filter(Boolean);
}
const REPAIR_CHECK_RULES = {
  charge_sum_mismatch: (row, c) => ['totalCost'].concat((_bfComponents(row, c) || { fields: [] }).fields),
  cost_missing: () => ['totalCost'],
  dates_missing: () => ['start', 'end'],
  period_length: () => ['start', 'end'],
  usage_missing: (row, c) => repairUsageFields(c),
  usage_negative: (row, c) => repairUsageFields(c),
  read_rollback: () => ['startRead', 'endRead', 'readDifference'],
};
const REPAIR_READ_IDENTITY = {
  readDifference: { check: 'reads_identity', fields: ['startRead', 'endRead', 'readDifference'] },
  usage: { check: 'kwh_identity', fields: ['readDifference', 'meterMultiplier', 'kwh'] },
};
// Every check `row` fails now, as [{ check, fields }]. meter/building = the meter the row is in (a copy is fine).
function repairFailedChecks(row, meter, building) {
  const c = meter.commodity || row.commodity || '';
  const sum = computeMeterFlagSummary(meter, building);
  const out = ((sum.perBill && sum.perBill[row.id]) || [])
    .filter((f) => REPAIR_CHECK_RULES[f.rule])
    .map((f) => ({ check: f.rule, fields: REPAIR_CHECK_RULES[f.rule](row, c) }));
  if (c === 'Electric')
    computePrintedReadMismatch({
      start: row.startRead,
      end: row.endRead,
      diff: row.readDifference,
      mult: row.meterMultiplier,
      limit: row._printedReadCheck ? row._printedReadCheck.limit : null,
      usage: _brHas(row.kwh) ? row.kwh : null,
    }).forEach((m) => out.push(REPAIR_READ_IDENTITY[m.field]));
  return out;
}

// A stored service address that an older reader joined across a line break: a street number alone on a line, then the next
// line's text ("11 then a new line then SOME SCHOOL DISTRICT"). The ONE test; eligibility and the candidate both call it.
function billServiceAddressJoined(addr) {
  return typeof addr === 'string' && /^\s*\d+[^\S\n]*\n/.test(addr);
}
// The fresh service address as a candidate to replace a joined stored one: the reader's address must itself be clean and
// stand on the bill's own page (same letters and digits, case, spaces and punctuation ignored). Returns { to } or { held }.
function repairServiceAddressCandidate(ext, row, pageText) {
  if (!billServiceAddressJoined(row.serviceAddress)) return null;
  const to = ext && typeof ext.ServiceAddress === 'string' ? ext.ServiceAddress.trim() : '';
  if (!to || billServiceAddressJoined(to)) return null;
  if (billFieldUserOwned(row, 'serviceAddress')) return { held: 'the user owns this field', to };
  const key = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key(pageText).includes(key(to))) return { held: 'the value is not printed on the bill page', to };
  return { to };
}

// The ONE decision whether a fresh value may be written over field k of a stored bill (Matt 2026-10-15: never fill a
// value that is not printed; held is better than guessed). Returns { ok: true } or { ok: false, code, reason }:
//   - 'value'  never blank, never 0 over a value (repairValueAllowed); never a field the user owns (billFieldUserOwned)
//   - 'source' the value is not printed on the bill's own page (provenance, from repairValueProvenance)
//   - 'passes' the stored value passes every check of the bill: nothing on the bill contradicts it, so it stays
//   - 'after'  the fresh value does not pass every check that judges the field
// failedBefore / failedAfter = repairFailedChecks on the bill before and after the fresh value is applied.
function repairMayWrite(row, k, to, provenance, failedBefore, failedAfter) {
  const judges = (list) => (list || []).filter((f) => f.fields.includes(k));
  if (!repairValueAllowed(row[k], to)) return { ok: false, code: 'value', reason: 'a blank or a 0 never replaces a value' };
  if (billFieldUserOwned(row, k)) return { ok: false, code: 'value', reason: 'the user owns this field' };
  if (provenance) return { ok: false, code: 'source', reason: provenance };
  if (_brHas(row[k]) && !judges(failedBefore).length) return { ok: false, code: 'passes', reason: 'the stored value passes every check of the bill' };
  const left = judges(failedAfter);
  if (left.length) return { ok: false, code: 'after', reason: 'the fresh value does not pass ' + left.map((f) => f.check).join(', ') };
  return { ok: true };
}

// The candidate values of `row` from the fresh read `ext`: { field: { to, src: [reader fields], raw } }, through the
// shared mappers (_extractedToBillRowCosts, gasBillSaveTherms). Only values that differ from the stored ones.
function _repairCandidates(ext, row, commodity) {
  const cand = {};
  const sd = extractedDateToISO(ext.BillingPeriodStart);
  const ed = extractedDateToISO(ext.BillingPeriodEnd);
  if (_brIsIso(sd) && _brIsIso(ed) && !ext._manualReview) {
    cand.start = { to: sd, src: ['BillingPeriodStart'], raw: ext.BillingPeriodStart };
    cand.end = { to: ed, src: ['BillingPeriodEnd'], raw: ext.BillingPeriodEnd };
  }
  const costs = _extractedToBillRowCosts(ext);
  const money = (k, v, src) => {
    if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return;
    if (!_brHas(row[k]) || Math.abs(parseBillNumber(row[k]) - Number(v)) > 0.005) cand[k] = { to: Number(v), src };
  };
  const usage = (k, v, src) => {
    if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return;
    if (!_brHas(row[k]) || Math.abs(parseBillNumber(row[k]) - Number(v)) >= 1) cand[k] = { to: Number(v), src };
  };
  // a read is compared to the printed digit: one unit of the coarser last digit (the unit computeReadCorrection uses)
  const read = (k, v, src) => {
    if (!_brHas(v)) return;
    const unit = Math.pow(10, -Math.min(_rcDecimals(row[k]), _rcDecimals(v))) + 1e-6;
    const a = parseBillNumber(row[k]),
      b = parseBillNumber(v);
    if (b === null) return;
    if (a === null || Math.abs(a - b) > unit) cand[k] = { to: v, src };
  };
  if (commodity === 'Electric') {
    read('startRead', ext.StartRead, ['StartRead']);
    read('endRead', ext.EndRead, ['EndRead']);
    read('readDifference', ext.ReadDifference, ['ReadDifference']);
    read('kwh', costs.kwh, ['kWhConsumed', 'kWh']);
  } else {
    money('totalCost', costs.totalCost, ['TotalCurrentCharges', 'TotalAmountDue']);
    if (commodity === 'Gas') {
      usage('therms', gasBillSaveTherms(ext), ['NaturalGasTherms', 'NaturalGasCCF', 'NaturalGasMCF', 'NaturalGasMMbtu']);
      if (cand.therms && _brHas(row.naturalGasTherms)) cand.naturalGasTherms = Object.assign({}, cand.therms);
    } else if (commodity === 'Water') {
      usage('waterUsage', parseBillNumber(ext.WaterUsage), ['WaterUsage']);
      money('waterCharge', parseBillNumber(ext.WaterCharge), ['WaterCharge']);
    } else if (commodity === 'Sewer') {
      usage('sewerUsage', parseBillNumber(ext.SewerUsage), ['SewerUsage']);
      money('sewerCharge', parseBillNumber(ext.SewerCharge), ['SewerCharge']);
    } else if (commodity === 'Stormwater') {
      money('stormWaterCharge', parseBillNumber(ext.StormWaterCharge), ['StormWaterCharge']);
    }
  }
  Object.keys(cand).forEach((k) => {
    if (String(row[k]) === String(cand[k].to)) delete cand[k];
  });
  return cand;
}
// The order the candidates are judged in: dates, then reads, then usage and charges, then the total.
const REPAIR_FIELD_ORDER = [
  'start',
  'end',
  'startRead',
  'endRead',
  'readDifference',
  'kwh',
  'therms',
  'naturalGasTherms',
  'waterUsage',
  'sewerUsage',
  'waterCharge',
  'sewerCharge',
  'stormWaterCharge',
  'totalCost',
];

// Fields to change on `row` from the fresh read `ext`, each passed through repairMayWrite on a copy of the meter:
// { changes: { field: { from, to } }, held: { field: { from, to, reason } } }. commodity = the meter's. pageText = the
// text of the bill's own pages (repairPageText). Each candidate is judged alone, on top of the ones already accepted;
// the ones that fail only because another field is still wrong (code 'after') are then judged once all together (a
// charge and a total, or a read difference and a kWh, prove each other only as a pair).
function repairFieldsFromExtracted(ext, row, commodity, meter, building, pageText) {
  const cand = _repairCandidates(ext, row, commodity);
  const changes = {};
  const held = {};
  // The service address is not judged by a bill check (no check reads it); a joined stored one is replaced by a clean
  // address that stands on the bill's own page.
  const addr = repairServiceAddressCandidate(ext, row, pageText);
  if (addr && addr.held) held.serviceAddress = { from: row.serviceAddress, to: addr.to, reason: addr.held };
  else if (addr) changes.serviceAddress = { from: row.serviceAddress, to: addr.to };
  const keys = REPAIR_FIELD_ORDER.filter((k) => cand[k]);
  if (!keys.length) return { changes, held };
  const clone = (m) => JSON.parse(JSON.stringify(m));
  const bldgOf = (m) => Object.assign({}, building, { meters: (building.meters || []).map((x) => (x === meter ? m : x)) });
  let work = clone(meter);
  const rowIn = (m) => m.bills.find((b) => b.id === row.id);
  let failedNow = repairFailedChecks(rowIn(work), work, bldgOf(work));
  const provenance = {};
  keys.forEach((k) => {
    const c = cand[k];
    provenance[k] = repairValueProvenance(ext, c.src, c.to, pageText, c.raw);
  });
  const from = (k) => (row[k] === undefined ? '' : row[k]);
  const applied = (ks) => {
    const trial = clone(work);
    const trow = rowIn(trial);
    ks.forEach((k) => {
      if (repairValueAllowed(trow[k], cand[k].to)) trow[k] = cand[k].to;
    });
    return { trial, failed: repairFailedChecks(trow, trial, bldgOf(trial)) };
  };
  // Judge `ks` together on a trial copy. Every one must pass; then the trial becomes the working copy. beforeOf(k) = the
  // checks the bill fails before k is applied (the working copy, or for a pair the copy with the other value already in).
  const judge = (ks, beforeOf) => {
    const t = applied(ks);
    const verdicts = ks.map((k) => ({ k, v: repairMayWrite(rowIn(work), k, cand[k].to, provenance[k], beforeOf(k), t.failed) }));
    if (verdicts.every((x) => x.v.ok)) {
      work = t.trial;
      failedNow = t.failed;
      ks.forEach((k) => {
        changes[k] = { from: from(k), to: cand[k].to };
        delete held[k];
      });
      return true;
    }
    verdicts.forEach((x) => {
      if (!x.v.ok) held[x.k] = { from: from(x.k), to: cand[x.k].to, reason: x.v.reason, code: x.v.code };
      else held[x.k] = { from: from(x.k), to: cand[x.k].to, reason: 'another value of the bill still fails its check', code: 'after' };
    });
    return false;
  };
  keys.forEach((k) => judge([k], () => failedNow));
  // The pair: the values that failed only because another value is still wrong (code 'after'), with the values the bill
  // contradicts once those are in (a kWh that matched the misread difference; a total that matched the misread charge).
  const core = keys.filter((k) => held[k] && held[k].code === 'after');
  if (core.length) {
    const pre = applied(core).failed;
    const extra = keys.filter((k) => held[k] && held[k].code === 'passes' && pre.some((f) => f.fields.includes(k)));
    const group = core.concat(extra);
    if (group.length > 1) judge(group, (k) => (extra.includes(k) ? pre : failedNow));
  }
  Object.keys(held).forEach((k) => delete held[k].code);
  return { changes, held };
}

// ── eligibility ──────────────────────────────────────────────────────────────────────────────

// Bills of this meter that the repair pass may read again: a bill with a defect, and the bill before and after it (a gap or
// overlap flag comes from the neighbor). A bill needs a stored PDF (pdfKey) and no marker for this extractor version
// (a marker without a version, e.g. waiting for the PDF or a read error that may be tried again, keeps the bill eligible).
// Returns [{ row, why }] in date order.
function repairEligibleBills(meter, building, version) {
  if (!meter || !Array.isArray(meter.bills) || !meter.bills.length) return [];
  const sum = computeMeterFlagSummary(meter, building);
  const ordered = _bfSortByStart(meter.bills);
  const why = {};
  ordered.forEach((b, i) => {
    if (b.estimated) return;
    const flags = (sum.perBill && sum.perBill[b.id]) || [];
    const hit = flags.find((f) => BILL_COUNTED_FLAG_RULES.includes(f.rule) || REPAIR_READ_RULES.includes(f.rule));
    let reason = hit ? hit.rule : '';
    if (!reason && meter.commodity === 'Electric') {
      if (!_brHas(b.startRead) || !_brHas(b.endRead)) reason = 'reads blank';
      else if (
        computePrintedReadMismatch({ start: b.startRead, end: b.endRead, diff: b.readDifference, mult: b.meterMultiplier, usage: b.kwh })
          .length
      )
        reason = 'reads do not add up';
    }
    if (!reason && billServiceAddressJoined(b.serviceAddress)) {
      why[b.id] = why[b.id] || 'service address joined';
      return;
    }
    if (!reason) return;
    why[b.id] = why[b.id] || reason;
    [ordered[i - 1], ordered[i + 1]].forEach((n) => {
      if (n && !n.estimated) why[n.id] = why[n.id] || 'next to ' + reason;
    });
  });
  return ordered
    .filter((b) => why[b.id] && b.pdfKey && !(b._pdfRepair && b._pdfRepair.v === version))
    .map((b) => ({ row: b, why: why[b.id] }));
}

// ── do no harm ───────────────────────────────────────────────────────────────────────────────

// The rules the repair must not add: the counted rules (the ones in the badges, BILL_COUNTED_FLAG_RULES), and for an
// electric meter the read-chain rules too (the repair changes reads). The statistical notes stay out: they compare a bill
// with its neighbors and move with every correct repair.
function repairGuardRules(meter) {
  return meter && meter.commodity === 'Electric' ? BILL_COUNTED_FLAG_RULES.concat(REPAIR_READ_RULES) : BILL_COUNTED_FLAG_RULES;
}
// { billId: Set(rule) } for every guarded flag of every bill of one meter.
function _repairFlagRules(meter, building) {
  const sum = computeMeterFlagSummary(meter, building);
  const guard = repairGuardRules(meter);
  const out = {};
  Object.keys(sum.perBill || {}).forEach((id) => {
    out[id] = new Set((sum.perBill[id] || []).map((f) => f.rule).filter((r) => guard.includes(r)));
  });
  return out;
}
// The first (bill id, rule) in `after` that `before` does not have, or null.
function _repairFlagGain(before, after) {
  for (const id of Object.keys(after)) {
    for (const r of after[id]) if (!(before[id] && before[id].has(r))) return { id, rule: r };
  }
  return null;
}
// The trial applies exactly what applyRepairChanges will write (same value test), so the flag check judges the real write.
function _repairApplyItem(meter, item) {
  const row = meter.bills.find((b) => b.id === item.row.id);
  if (!row) return;
  Object.keys(item.changes).forEach((k) => {
    if (repairValueAllowed(row[k], item.changes[k].to)) row[k] = item.changes[k].to;
  });
}

// Choose which candidate repairs to keep. items = [{ row, changes }]. Each is tried on a copy of the meter; it is kept
// only when no bill of the meter gains a flag. Candidates that fail alone are tried together once (a date repair of a
// bill and its neighbor clear a gap only as a pair). Returns { accepted: [item], rejected: [{ item, reason }] }.
function planMeterRepair(meter, building, items) {
  const clone = (m) => JSON.parse(JSON.stringify(m));
  const bldgOf = (m) => Object.assign({}, building, { meters: (building.meters || []).map((x) => (x === meter ? m : x)) });
  let work = clone(meter);
  const accepted = [];
  const failed = [];
  const tryItems = (its) => {
    const base = _repairFlagRules(work, bldgOf(work));
    const trial = clone(work);
    its.forEach((it) => _repairApplyItem(trial, it));
    const gain = _repairFlagGain(base, _repairFlagRules(trial, bldgOf(trial)));
    return { trial, gain };
  };
  items.forEach((it) => {
    const r = tryItems([it]);
    if (!r.gain) {
      work = r.trial;
      accepted.push(it);
    } else failed.push({ item: it, reason: 'would add the flag ' + r.gain.rule });
  });
  // A candidate that failed may pass once another repair is in (a bill's dates and its neighbor's dates fit together):
  // try the failed ones again while the meter keeps improving, then once all together.
  let left = failed;
  for (let progress = true; progress && left.length; ) {
    progress = false;
    const again = [];
    left.forEach((f) => {
      const r = tryItems([f.item]);
      if (r.gain) {
        again.push(f);
        return;
      }
      work = r.trial;
      accepted.push(f.item);
      progress = true;
    });
    left = again;
  }
  if (left.length > 1) {
    const r = tryItems(left.map((f) => f.item));
    if (!r.gain) {
      left.forEach((f) => accepted.push(f.item));
      left = [];
    }
  }
  return { accepted, rejected: left };
}

// ── history and apply ────────────────────────────────────────────────────────────────────────

// Write the accepted changes onto the live bill and record each one in the existing automatic-correction record
// row._auto_corrected_<field> (the one change history; the read-chain rule writes the same record for its reads). A
// value that repairValueAllowed refuses (blank, or 0 over a value) is not written and not recorded, whatever the
// caller passed. An earlier record's original text is kept. meta = { at, version }. Returns the fields written.
function applyRepairChanges(row, changes, meta) {
  const written = [];
  Object.keys(changes || {}).forEach((k) => {
    const to = changes[k].to;
    if (!repairValueAllowed(row[k], to)) return;
    const prior = row['_auto_corrected_' + k];
    const page = row.pdfPageStart || null;
    row['_auto_corrected_' + k] = {
      original: prior && typeof prior === 'object' && prior.original !== undefined ? prior.original : row[k] === undefined ? '' : row[k],
      corrected: to,
      reason: 'Re-read from the PDF' + (page ? ', page ' + page : ''),
      source: PDF_REREAD_SOURCE,
      at: meta.at,
      page,
      ruleVersion: meta.version,
    };
    row[k] = to;
    written.push(k);
  });
  return written;
}

// Rows of one meter that hold the same PDF page with the same total: the same bill stored twice. The repair never
// deletes one; the caller writes them to the audit log. Returns [[row, row, ...]].
function findDuplicateRowGroups(meter) {
  const g = {};
  (meter.bills || []).forEach((b) => {
    if (!b.pdfKey || b.pdfPageStart == null || b.pdfPageStart === '') return;
    const k = b.pdfKey + '|' + b.pdfPageStart + '|' + String(parseBillNumber(b.totalCost));
    (g[k] = g[k] || []).push(b);
  });
  return Object.keys(g)
    .map((k) => g[k])
    .filter((rows) => rows.length > 1);
}

// Pages of `exts` (one PDF) that this meter has no row for: same commodity and account as the meter, the SAME meter
// number on both sides (a page without one, or a meter without one, is never claimed: the account alone can hold several
// meters), a valid period that no row holds or lies within 5 days of, a page no row holds, not a bill the reader holds
// for review. When a row of this meter points at the PDF without a page number, the stored pages are unknown and
// nothing is reported. Nothing is added to the meter (a deleted bill is recorded only in the audit log, so an added
// row could bring back a bill the user removed): the caller writes each candidate to the audit log.
// Returns [{ page, pageEnd, start, end, totalCost, meterNumber }].
function repairMissingBillCandidates(exts, meter, pdfKey) {
  const rows = meter.bills || [];
  const linked = rows.filter((b) => b.pdfKey === pdfKey);
  if (linked.some((b) => b.pdfPageStart == null || b.pdfPageStart === '' || isNaN(Number(b.pdfPageStart)))) return [];
  if (!(meter.meter || '').replace(/[\s\-]/g, '')) return [];
  const pages = new Set(linked.map((b) => Number(b.pdfPageStart)));
  const out = [];
  (exts || []).forEach((e) => {
    if (!e || e._manualReview || e.parseError) return;
    const m = matchExtractedToBill(e, { commodity: meter.commodity, start: '', end: '' }, meter);
    const rowAccts = rows.map((b) => (b.accountNumber || '').replace(/[\s\-]/g, '').toLowerCase());
    if (!m.commMatch || !(e.Commodity || '') || !(m.acctMatch || rowAccts.some((a) => a && _acctFuzzyMatch(m.extAcct, a)))) return;
    if (!m.meterMatch) return;
    const pg = Number(e._pageStart != null ? e._pageStart : e._pageIndex);
    if (isNaN(pg) || pages.has(pg)) return;
    const sd = extractedDateToISO(e.BillingPeriodStart);
    const ed = extractedDateToISO(e.BillingPeriodEnd);
    if (!_brIsIso(sd) || !_brIsIso(ed)) return;
    if (rows.some((b) => (b.start === sd && b.end === ed) || billPeriodClose(sd, ed, b.start, b.end))) return;
    pages.add(pg);
    out.push({
      page: pg,
      pageEnd: Number(e._pageEnd != null ? e._pageEnd : pg),
      start: sd,
      end: ed,
      totalCost: _extractedToBillRowCosts(e).totalCost,
      meterNumber: e.MeterNumber || '',
    });
  });
  return out;
}

// ── one meter, one PDF ───────────────────────────────────────────────────────────────────────

// Repair the eligible bills of `meter` that point at `pdfKey`, from `exts` (the extractor's bills for that PDF) and `text`
// (the PDF's page text with %%PAGE_N%% markers: a value is written only when it stands on the bill's own page). Writes
// the accepted changes, the history and the marker row._pdfRepair on the live bills. meta = { at, version }.
// Returns { read, repaired: [{ row, changes }], missing: [candidate], declined: [{ row, reason }], nochange: [row],
// duplicates: [[row]], held: [{ row, fields: { field: { from, to, reason } } }] } (held = fresh values that differ from
// the stored ones and were NOT written, with the reason, for the audit log). The caller logs, runs the read-chain pass
// and saves.
function repairMeterFromPdf(meter, building, pdfKey, exts, meta, text) {
  const eligible = repairEligibleBills(meter, building, meta.version).filter((r) => r.row.pdfKey === pdfKey);
  const res = { read: eligible.length, repaired: [], missing: [], declined: [], nochange: [], duplicates: [], held: [] };
  if (!eligible.length) return res;
  const mark = (row, status, reason) => {
    const dup = row._pdfRepair && row._pdfRepair.dup;
    row._pdfRepair = { v: meta.version, at: meta.at, status, reason: reason || '' };
    if (dup) row._pdfRepair.dup = true;
  };
  const sorted = _bfSortByStart(meter.bills);
  const items = [];
  eligible.forEach(({ row }) => {
    const i = sorted.indexOf(row);
    const m = findRepairMatch(exts, row, meter);
    if (m.declined) {
      mark(row, 'declined', m.declined);
      res.declined.push({ row, reason: m.declined });
      return;
    }
    // The bill's own pages: the stored page range (set from the reader at upload), else the reader's range for this
    // read, else (no page known on either side: a one-invoice PDF) the whole PDF.
    const extPage = m.ext._pageStart != null ? m.ext._pageStart : m.ext._pageIndex;
    const pageText =
      row.pdfPageStart != null && row.pdfPageStart !== ''
        ? repairPageText(text, row.pdfPageStart, row.pdfPageEnd)
        : extPage != null
          ? repairPageText(text, extPage, m.ext._pageEnd)
          : String(text || '');
    const r = repairFieldsFromExtracted(m.ext, row, meter.commodity, meter, building, pageText);
    if (Object.keys(r.held).length) res.held.push({ row, fields: r.held });
    if (Object.keys(r.changes).length) items.push({ row, changes: r.changes });
    else {
      const why = Object.keys(r.held)
        .map((k) => k + ': ' + r.held[k].reason)
        .join('; ');
      mark(row, 'nochange', why);
      res.nochange.push(row);
    }
  });
  const plan = planMeterRepair(meter, building, items);
  plan.accepted.forEach((it) => {
    const written = applyRepairChanges(it.row, it.changes, meta);
    if (written.length) {
      mark(it.row, 'repaired', '');
      res.repaired.push({ row: it.row, changes: it.changes });
    } else {
      mark(it.row, 'nochange', '');
      res.nochange.push(it.row);
    }
  });
  plan.rejected.forEach((r) => {
    mark(r.item.row, 'declined', r.reason);
    res.declined.push({ row: r.item.row, reason: r.reason });
  });
  res.missing = repairMissingBillCandidates(exts, meter, pdfKey);
  // The same bill stored twice: reported once, never deleted. Only the dup mark is set: a row that was not read in this
  // run gets no version, so it is still read when it needs a repair.
  findDuplicateRowGroups(meter).forEach((g) => {
    if (g.every((r) => r._pdfRepair && r._pdfRepair.dup)) return;
    g.forEach((r) => {
      r._pdfRepair = Object.assign({}, r._pdfRepair || {}, { dup: true });
    });
    res.duplicates.push(g);
  });
  return res;
}
