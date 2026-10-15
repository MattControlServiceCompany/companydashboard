/* ══════════════════════════════════════════════════════════════════════════════════════════════
   BILL REPAIR FROM THE STORED PDF (2026-10-15, backlog d178c906)
   The ONE place that decides how a stored bill is repaired from a fresh read of its own PDF page. No DOM, no storage:
   the browser pass (app/auto-repair.js) reads the PDF and saves; everything it decides is here, so the gate
   (tools/gate-auto-repair.js) runs the real functions.

   Rules for every write (each is tested by the gate):
     - A field the user corrected (row._userCorrected[field]) never changes.
     - A value is never blanked. The extracted value must have text.
     - A printed value is never replaced by a computed one: a read difference changes only when the stored reads
       do not confirm it; a kWh changes only when its read difference changed in the same repair.
     - Do no harm: the repair runs on a copy of the meter; it is kept only when no bill of the meter gains a flag
       (computeMeterFlagSummary before and after).
     - A duplicate row is recorded in the audit log by the caller and never deleted.
     - Every changed field is written to row._autoRepairHistory (shown in Edit Billing Period, _billChangeHistory).
   The extractor's own mapping is reused: _extractedToBillRowCosts and gasBillSaveTherms (no second field map).
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

// Read-family rules: they are not counted in the badges, but a bill with one of them has a read that may be wrong.
const REPAIR_READ_RULES = ['read_continuity', 'read_rollback', 'read_usage_mismatch'];

// Plain label and type of each stored field this repair can write (used by Edit Billing Period).
const REPAIR_FIELD_LABELS = {
  start: { label: 'Start Date', type: 'text' },
  end: { label: 'End Date', type: 'text' },
  totalCost: { label: 'Total Cost', type: 'currency' },
  kwh: { label: 'kWh Consumed', type: 'number' },
  startRead: { label: 'Start Read', type: 'number' },
  endRead: { label: 'End Read', type: 'number' },
  readDifference: { label: 'Read Difference', type: 'number' },
  therms: { label: 'Therms', type: 'number' },
  naturalGasTherms: { label: 'Therms (printed)', type: 'number' },
  waterUsage: { label: 'Water Usage', type: 'number' },
  waterCharge: { label: 'Water Charge', type: 'currency' },
  sewerUsage: { label: 'Sewer Usage', type: 'number' },
  sewerCharge: { label: 'Sewer Charge', type: 'currency' },
  stormWaterCharge: { label: 'Stormwater Charge', type: 'currency' },
};

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
    acctMatch: _acctFuzzyMatch(extAcct, existAcct),
    meterMatch: !!extMeter && !!existMeter && extMeter === existMeter,
    commMatch: !extComm || !existComm || extComm === existComm,
    periodMatch,
    fuzzyPeriod: !periodMatch && billPeriodClose(extStart, extEnd, bill.start, bill.end),
    extStart,
    extEnd,
  };
}

// The one extracted bill that is THIS stored bill's page. Page, commodity and account must agree; when a page holds more
// than one such bill the meter number, then the start date, must pick one. Returns { ext } or { declined: reason }.
function findRepairMatch(exts, row, meter) {
  const page = row.pdfPageStart == null || row.pdfPageStart === '' ? null : Number(row.pdfPageStart);
  const pageOf = (e) => Number(e._pageStart != null ? e._pageStart : e._pageIndex);
  const pageEnd = (e) => Number(e._pageEnd != null ? e._pageEnd : pageOf(e));
  let cands = (exts || []).filter((e) => {
    if (!e || e._manualReview || e.parseError) return false;
    const m = matchExtractedToBill(e, row, meter);
    if (!m.commMatch || !(e.Commodity || '')) return false;
    // the account on the bill row counts as well as the meter's (a bill can carry the number the utility printed on it)
    const rowAcct = (row.accountNumber || '').replace(/[\s\-]/g, '').toLowerCase();
    if (m.extAcct && m.existAcct && !m.acctMatch && !_acctFuzzyMatch(m.extAcct, rowAcct)) return false;
    if (page === null) return m.meterMatch && m.extStart === row.start; // no page stored: meter and period must agree
    return page >= pageOf(e) && page <= pageEnd(e);
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
    const held = (exts || []).some((e) => e && e._manualReview && matchExtractedToBill(e, row, meter).commMatch && page !== null && page >= pageOf(e) && page <= pageEnd(e));
    return { declined: held ? 'the reader holds this page for review' : 'no bill on the PDF page matches this bill' };
  }
  if (cands.length > 1) return { declined: 'more than one bill on the PDF page matches this bill' };
  return { ext: cands[0] };
}

// ── field mapping ────────────────────────────────────────────────────────────────────────────

const _brHas = (v) => v !== undefined && v !== null && String(v).trim() !== '';
// Print-rounding unit of two values: one unit of the coarser last digit (the unit computeReadCorrection uses).
function _brUnit(a, b) {
  return Math.pow(10, -Math.min(_rcDecimals(a), _rcDecimals(b))) + 1e-6;
}
const _brSameNumber = (a, b, tol) => {
  const x = parseBillNumber(a);
  const y = parseBillNumber(b);
  return x !== null && y !== null && Math.abs(x - y) <= tol;
};

// The read group of an electric bill. Returns { field: to } for the fields to change (start/end reads, difference, kWh).
// ext = the fresh read; prev/next = the neighbor bills on the meter (their reads can confirm an extracted read).
function _repairReads(ext, row, prev, next, userOwned) {
  const out = {};
  if (_rcUserEdited(row, READ_CHAIN_FIELDS.stored)) return out;
  const Sx = ext.StartRead,
    Ex = ext.EndRead,
    Dx = ext.ReadDifference;
  const consistent = (S, E, D) =>
    _brHas(S) &&
    _brHas(E) &&
    _brHas(D) &&
    !computePrintedReadMismatch({ start: S, end: E, diff: D }).some((m) => m.field === 'readDifference');
  const extOk = consistent(Sx, Ex, Dx);
  if (!extOk) return out; // the fresh read does not agree with itself: it proves nothing
  const storedOk = consistent(row.startRead, row.endRead, row.readDifference);
  const differs = (k, x) => _brHas(x) && (!_brHas(row[k]) || !_brSameNumber(row[k], x, _brUnit(row[k], x)));
  const readsDiffer = [
    ['startRead', Sx],
    ['endRead', Ex],
  ].filter((p) => differs(p[0], p[1]) && !userOwned(p[0]));
  const confirmed =
    (differs('endRead', Ex) && next && _brHas(next.startRead) && _brSameNumber(next.startRead, Ex, _brUnit(next.startRead, Ex))) ||
    (differs('startRead', Sx) && prev && _brHas(prev.endRead) && _brSameNumber(prev.endRead, Sx, _brUnit(prev.endRead, Sx)));
  if (readsDiffer.length && (!storedOk || confirmed)) readsDiffer.forEach((p) => (out[p[0]] = p[1]));
  // The printed read difference stays when the stored reads confirm it.
  if (!storedOk && differs('readDifference', Dx) && !userOwned('readDifference')) out.readDifference = Dx;
  // The kWh follows a read difference that changed, when the fresh kWh agrees with the fresh read difference.
  if (out.readDifference !== undefined && !userOwned('kwh')) {
    const kx = _extractedToBillRowCosts(ext).kwh;
    if (kx !== '' && kx !== null && kx !== undefined) {
      const usageBad = computePrintedReadMismatch({
        start: Sx,
        end: Ex,
        diff: Dx,
        mult: ext.MeterMultiplier,
        usage: kx,
      }).some((m) => m.field === 'usage');
      if (!usageBad && (!_brHas(row.kwh) || Math.abs(parseBillNumber(row.kwh) - kx) > 0.005)) out.kwh = kx;
    }
  }
  return out;
}

// Fields to change on `row` from the fresh read `ext`: { field: { from, to } }. Never blank, never a user-corrected field.
// commodity = the meter's. prev/next = neighbor rows (electric reads only).
function repairFieldsFromExtracted(ext, row, commodity, prev, next) {
  const userOwned = (k) => !!(row._userCorrected && row._userCorrected[k]);
  const cand = {};
  const sd = extractedDateToISO(ext.BillingPeriodStart);
  const ed = extractedDateToISO(ext.BillingPeriodEnd);
  if (_brIsIso(sd) && _brIsIso(ed) && !ext._manualReview) {
    cand.start = sd;
    cand.end = ed;
  }
  const costs = _extractedToBillRowCosts(ext);
  const money = (k, v) => {
    if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return;
    if (!_brHas(row[k]) || Math.abs(parseBillNumber(row[k]) - Number(v)) > 0.005) cand[k] = Number(v);
  };
  const usage = (k, v) => {
    if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return;
    if (!_brHas(row[k]) || Math.abs(parseBillNumber(row[k]) - Number(v)) >= 1) cand[k] = Number(v);
  };
  if (commodity === 'Electric') {
    Object.assign(cand, _repairReads(ext, row, prev, next, userOwned));
  } else {
    money('totalCost', costs.totalCost);
    if (commodity === 'Gas') {
      const t = gasBillSaveTherms(ext);
      usage('therms', t);
      if (cand.therms !== undefined && _brHas(row.naturalGasTherms)) cand.naturalGasTherms = cand.therms;
    } else if (commodity === 'Water') {
      usage('waterUsage', parseBillNumber(ext.WaterUsage));
      money('waterCharge', parseBillNumber(ext.WaterCharge));
    } else if (commodity === 'Sewer') {
      usage('sewerUsage', parseBillNumber(ext.SewerUsage));
      money('sewerCharge', parseBillNumber(ext.SewerCharge));
    } else if (commodity === 'Stormwater') {
      money('stormWaterCharge', parseBillNumber(ext.StormWaterCharge));
    }
  }
  const out = {};
  Object.keys(cand).forEach((k) => {
    if (userOwned(k)) return;
    if (!_brHas(cand[k]) || (typeof cand[k] === 'number' && !isFinite(cand[k]))) return; // never blank a value
    if (String(row[k]) === String(cand[k])) return;
    out[k] = { from: row[k] === undefined ? '' : row[k], to: cand[k] };
  });
  return out;
}

// ── eligibility ──────────────────────────────────────────────────────────────────────────────

// Bills of this meter that the repair pass may read again: a bill with a defect, and the bill before and after it (a gap or
// overlap flag comes from the neighbor). A bill needs a stored PDF (pdfKey) and no marker for this extractor version.
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
function _repairApplyItem(meter, item) {
  if (item.add) {
    meter.bills.push(JSON.parse(JSON.stringify(item.add)));
    return;
  }
  const row = meter.bills.find((b) => b.id === item.row.id);
  if (!row) return;
  Object.keys(item.changes).forEach((k) => (row[k] = item.changes[k].to));
}

// Choose which candidate repairs to keep. items = [{ row, changes }] or [{ add }]. Each is tried on a copy of the meter;
// it is kept only when no bill of the meter gains a flag. Candidates that fail alone are tried together once (a date
// repair of a bill and its neighbor clear a gap only as a pair). Returns { accepted: [item], rejected: [{ item, reason }] }.
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

// Write the accepted changes onto the live bill and record each one. meta = { at, version }.
function applyRepairChanges(row, changes, meta) {
  const hist = Array.isArray(row._autoRepairHistory) ? row._autoRepairHistory : [];
  Object.keys(changes).forEach((k) => {
    const L = REPAIR_FIELD_LABELS[k] || { label: k, type: 'text' };
    hist.push({
      field: k,
      label: L.label,
      type: L.type,
      original: changes[k].from,
      corrected: changes[k].to,
      at: meta.at,
      page: row.pdfPageStart || null,
      ruleVersion: meta.version,
    });
    row[k] = changes[k].to;
  });
  row._autoRepairHistory = hist;
}

// Editing a repaired field removes its history entry (the user's value replaces the repair). fields = edited field names;
// no list = every field.
function clearAutoRepairHistory(row, fields) {
  if (!row || !Array.isArray(row._autoRepairHistory)) return;
  row._autoRepairHistory = row._autoRepairHistory.filter((h) => fields && !fields.includes(h.field));
  if (!row._autoRepairHistory.length) delete row._autoRepairHistory;
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

// New bill rows for pages of `exts` that this meter has no row for: same commodity and account as the meter, a valid
// period that is not stored, not a bill the reader holds for review. Built with the shared mapper, marked fromPDF.
// Returns [{ add: row }].
function repairMissingBillRows(exts, meter, pdfKey, meta) {
  const have = new Set((meter.bills || []).map((b) => b.start + '|' + b.end));
  const pages = new Set((meter.bills || []).filter((b) => b.pdfKey === pdfKey).map((b) => Number(b.pdfPageStart)));
  const out = [];
  (exts || []).forEach((e, i) => {
    if (!e || e._manualReview || e.parseError) return;
    const m = matchExtractedToBill(e, { commodity: meter.commodity, start: '', end: '' }, meter);
    const rowAccts = (meter.bills || []).map((b) => (b.accountNumber || '').replace(/[\s\-]/g, '').toLowerCase());
    if (!m.commMatch || !(e.Commodity || '') || !(m.acctMatch || rowAccts.some((a) => a && _acctFuzzyMatch(m.extAcct, a)))) return;
    if (e.MeterNumber && meter.meter && !m.meterMatch) return; // a meter number on both sides must agree: the account alone can hold several meters
    const pg = Number(e._pageStart != null ? e._pageStart : e._pageIndex);
    if (pages.has(pg)) return;
    const sd = extractedDateToISO(e.BillingPeriodStart);
    const ed = extractedDateToISO(e.BillingPeriodEnd);
    if (!_brIsIso(sd) || !_brIsIso(ed) || have.has(sd + '|' + ed)) return;
    const blank = { id: '', start: '', end: '' };
    const c = _extractedToBillRowCosts(e);
    const row = {
      id: 'ar' + Date.parse(meta.at) + '_' + i,
      start: sd,
      end: ed,
      fromPDF: true,
      hasPDF: true,
      pdfKey,
      pdfPageStart: pg,
      pdfPageEnd: Number(e._pageEnd != null ? e._pageEnd : pg),
      accountNumber: e.AccountNumber || '',
      commodity: meter.commodity,
      kwh: meter.commodity === 'Electric' ? c.kwh : '',
      kwCost: c.kwCost,
      kwhCost: c.kwhCost,
      otherCost: c.otherCost,
      taxCost: c.taxCost,
      totalCost: c.totalCost,
    };
    const f = repairFieldsFromExtracted(e, Object.assign({}, blank, row), meter.commodity, null, null);
    Object.keys(f).forEach((k) => (row[k] = f[k].to));
    row._pdfRepair = { v: meta.version, at: meta.at, status: 'repaired', reason: 'added from the PDF page', added: true };
    row._autoRepairHistory = ['start', 'end', 'totalCost']
      .filter((k) => _brHas(row[k]))
      .map((k) => ({
        field: k,
        label: REPAIR_FIELD_LABELS[k].label,
        type: REPAIR_FIELD_LABELS[k].type,
        original: '',
        corrected: row[k],
        at: meta.at,
        page: pg,
        ruleVersion: meta.version,
      }));
    have.add(sd + '|' + ed);
    pages.add(pg);
    out.push({ add: row });
  });
  return out;
}

// ── one meter, one PDF ───────────────────────────────────────────────────────────────────────

// Repair the eligible bills of `meter` that point at `pdfKey`, from `exts` (the extractor's bills for that PDF). Writes the
// accepted changes, the history and the marker row._pdfRepair on the live bills. meta = { at, version }.
// Returns { read, repaired: [{ row, changes }], added: [row], declined: [{ row, reason }], nochange: [row], duplicates: [[row]] }.
// The caller logs, runs the read-chain pass and saves.
function repairMeterFromPdf(meter, building, pdfKey, exts, meta) {
  const eligible = repairEligibleBills(meter, building, meta.version).filter((r) => r.row.pdfKey === pdfKey);
  const res = { read: eligible.length, repaired: [], added: [], declined: [], nochange: [], duplicates: [] };
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
    const changes = repairFieldsFromExtracted(m.ext, row, meter.commodity, sorted[i - 1] || null, sorted[i + 1] || null);
    if (Object.keys(changes).length) items.push({ row, changes });
    else {
      mark(row, 'nochange', '');
      res.nochange.push(row);
    }
  });
  repairMissingBillRows(exts, meter, pdfKey, meta).forEach((a) => items.push(a));
  const plan = planMeterRepair(meter, building, items);
  plan.accepted.forEach((it) => {
    if (it.add) {
      meter.bills.push(it.add);
      res.added.push(it.add);
      return;
    }
    applyRepairChanges(it.row, it.changes, meta);
    mark(it.row, 'repaired', '');
    res.repaired.push({ row: it.row, changes: it.changes });
  });
  plan.rejected.forEach((r) => {
    if (r.item.add) return;
    mark(r.item.row, 'declined', r.reason);
    res.declined.push({ row: r.item.row, reason: r.reason });
  });
  // The same bill stored twice: reported once, never deleted.
  findDuplicateRowGroups(meter).forEach((g) => {
    if (g.every((r) => r._pdfRepair && r._pdfRepair.dup)) return;
    g.forEach((r) => {
      r._pdfRepair = Object.assign({}, r._pdfRepair || { v: meta.version, at: meta.at, status: 'nochange', reason: '' }, { dup: true });
    });
    res.duplicates.push(g);
  });
  return res;
}
