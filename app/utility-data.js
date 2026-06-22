/* ══════════════════════════════════════════════════════
         UTILITY DATA TOOL
         Data model:
         utilityData = {
           [projId]: {
             buildings: [
               { id, name, addr, sqft, meters: [
                 { id, commodity, provider, account, meter, maddr, inclusive,
                   bills: [ { id, start, end, days, ...commodity fields } ]
                 }
               ]}
             ]
           }
         }
      ══════════════════════════════════════════════════════ */

let utilityData = {};
let udSelProjId = null;
let udSelBldgId = null;
let udSelMeterId = null; // for bill modal
let udBillEditId = null;
let _meterInclusive = true;
const _openMeterIds = new Set(); // tracks which meter cards are expanded
let _vcmActive = false; // Value Correction Mode toggle state (Update a3a423eb)
let _vcmKeyHandler = null; // module-level ref so Cancel/Save can remove it

function loadUtilityData() {
  utilityData = {};
  // One-time migration: if old combined key exists, split into per-project keys then remove it
  const combined = sget('en_utilityData', null);
  if (combined && typeof combined === 'object' && Object.keys(combined).length) {
    Object.keys(combined).forEach(function (pid) {
      sset('en_utility_' + pid, combined[pid]);
    });
    try {
      DB.remove('en_utilityData');
    } catch (e) {}
    console.log('Migrated en_utilityData to per-project keys');
  }
  // Load each project from its own key
  sget('en_projects', []).forEach(function (p) {
    const d = sget('en_utility_' + p.id, null);
    if (d) utilityData[p.id] = d;
  });
  // One-time migration: fix 2-digit year ISO dates (e.g. "24-03-15" → "2024-03-15")
  // produced by the old toISO function. Without this, date comparisons, sorting,
  // normMonth, and duplicate detection all break.
  const _migratedKey = 'en_utility_dates_migrated_v1';
  if (!DB.get(_migratedKey)) {
    let fixed = 0;
    const _fixDate = (d) => {
      if (!d || typeof d !== 'string') return d;
      const m = d.match(/^(\d{2})-(\d{2})-(\d{2})$/);
      if (m) {
        fixed++;
        return '20' + m[1] + '-' + m[2] + '-' + m[3];
      }
      return d;
    };
    for (const pid of Object.keys(utilityData)) {
      const ud = utilityData[pid];
      for (const b of ud.buildings || []) {
        for (const mt of b.meters || []) {
          for (const bill of mt.bills || []) {
            bill.start = _fixDate(bill.start);
            bill.end = _fixDate(bill.end);
          }
        }
      }
    }
    if (fixed > 0) {
      saveUtilityData();
      console.log('[date migration] Fixed ' + fixed + ' 2-digit year dates');
    }
    DB.set(_migratedKey, '1');
  }
  // One-time migration: backfill derived rate fields on bills that have
  // usage + cost data but missing rate fields (totalGasRate, totalPropaneRate, etc.)
  const _ratesMigratedKey = 'en_utility_rates_backfilled_v2';
  if (!DB.get(_ratesMigratedKey)) {
    let ratesFilled = 0;
    for (const pid of Object.keys(utilityData)) {
      const ud = utilityData[pid];
      for (const b of ud.buildings || []) {
        for (const mt of b.meters || []) {
          for (const bill of mt.bills || []) {
            // Clear old totalKwRate so it gets recalculated with facKWCost included
            if (bill.totalKwRate && (parseFloat(bill.facKWCost) || 0) > 0) {
              delete bill.totalKwRate;
            }
            if (ensureBillRates(bill)) ratesFilled++;
          }
        }
      }
    }
    if (ratesFilled > 0) {
      saveUtilityData();
      console.log(
        '[rate backfill v2] Recalculated rates on ' + ratesFilled + ' bills (totalKwRate now includes facKWCost)',
      );
    }
    DB.set(_ratesMigratedKey, '1');
  }
  // One-time migration: backfill sewerUsage from matching water bills
  // where sewerUsage was empty/missing because bills were saved before the
  // May 14-15 2026 extraction fix that added sewer cross-fill logic.
  const _sewerUsageMigratedKey = 'en_utility_sewer_usage_backfilled_v1';
  if (!DB.get(_sewerUsageMigratedKey)) {
    const _backfillReport = { filled: [], skipped: [] };
    for (const pid of Object.keys(utilityData)) {
      const ud = utilityData[pid];
      for (const bldg of ud.buildings || []) {
        const bname = bldg.name || bldg.id || pid;
        // Index all bills by account+end so we can look up water matches
        const byAcctEnd = {};
        for (const mt of bldg.meters || []) {
          for (const bill of mt.bills || []) {
            const acct = bill.account || bill.AccountNumber || '';
            const key = acct + '|' + (bill.end || '');
            if (!byAcctEnd[key]) byAcctEnd[key] = [];
            byAcctEnd[key].push({ bill, commodity: mt.commodity, meterName: mt.name || mt.id || mt.commodity });
          }
        }
        // For each sewer bill missing usage, find the matching water bill
        for (const mt of bldg.meters || []) {
          if (mt.commodity !== 'Sewer') continue;
          const mname = mt.name || mt.id || 'Sewer';
          for (const bill of mt.bills || []) {
            // Guard 1: skip if already has a non-zero sewerUsage
            const su = parseFloat(bill.sewerUsage);
            if (!isNaN(su) && su > 0) continue;
            const acct = bill.account || bill.AccountNumber || '';
            const key = acct + '|' + (bill.end || '');
            const candidates = (byAcctEnd[key] || []).filter(
              (e) => e.commodity === 'Water' && parseFloat(e.bill.waterUsage) > 0,
            );
            // Guard 2: require exactly one match
            if (candidates.length === 0) {
              _backfillReport.skipped.push({
                pid,
                building: bname,
                meter: mname,
                account: acct,
                billingEnd: bill.end,
                reason: 'no matching water bill',
              });
              continue;
            }
            if (candidates.length > 1) {
              _backfillReport.skipped.push({
                pid,
                building: bname,
                meter: mname,
                account: acct,
                billingEnd: bill.end,
                reason: 'ambiguous: ' + candidates.length + ' candidates',
              });
              continue;
            }
            // Guard 1 confirmed: exactly one match, safe to fill
            const src = candidates[0].bill;
            bill.sewerUsage = src.waterUsage;
            _backfillReport.filled.push({
              pid,
              building: bname,
              meter: mname,
              account: acct,
              billingEnd: bill.end,
              valueCopied: src.waterUsage,
              sourceBillId: src.id || acct + '|' + src.end,
            });
          }
        }
      }
    }
    // Guard 3: always emit audit trail
    console.log(
      '[sewer usage backfill v1] filled=' +
        _backfillReport.filled.length +
        ' skipped=' +
        _backfillReport.skipped.length,
    );
    if (_backfillReport.filled.length) console.table(_backfillReport.filled);
    if (_backfillReport.skipped.length) console.table(_backfillReport.skipped);
    DB.set('en_sewer_backfill_report_v1', JSON.stringify(_backfillReport));
    // Guard 5: write only if changes were made
    if (_backfillReport.filled.length > 0) {
      saveUtilityData();
      // Guard 3: one-time user-visible notice
      showToast(_backfillReport.filled.length + ' sewer bills backfilled from water usage — see console for details.');
    }
    // Guard 4: set key only after save completes
    DB.set(_sewerUsageMigratedKey, '1');
  }
  // One-time migration: fix Wood River (MMBtu) gas bills where therms was stored
  // as raw MMBtu instead of Therms (×10). CCF bills also converted (×1.037).
  // Fix [therms-unit-2026-06-22] — root cause: bill-analysis.js save path applied no
  // unit conversion when falling through to NaturalGasMMbtu. Constellation/KGS bills
  // (which set NaturalGasTherms) are excluded by the predicate and left untouched.
  // Safety: value-range predicate is the primary guard (refuses already-correct bills
  // even if marker is lost); per-bill _thermsUnitFixed and global key are belt-and-suspenders.
  const _thermsFixKey = 'en_utility_therms_mmbtu_fix_v1';
  if (!DB.get(_thermsFixKey)) {
    const _approxEq = (a, b, tol) => Math.abs(a - b) <= Math.abs(b) * tol;
    const _pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
    const _thermsReport = { wouldFix: [], skipped: [], ambiguous: [] };
    // DRY-RUN PASS: log what WOULD be fixed before mutating anything
    for (const pid of Object.keys(utilityData)) {
      const ud = utilityData[pid];
      for (const b of ud.buildings || []) {
        for (const mt of b.meters || []) {
          for (const bill of mt.bills || []) {
            if (bill._thermsUnitFixed) continue; // already corrected
            const mmbtu = _pf(bill.naturalGasMMbtu);
            const therms = _pf(bill.therms);
            const hasTherms = _pf(bill.naturalGasTherms) > 0 || (bill.naturalGasTherms && bill.naturalGasTherms !== '');
            const hasCCF = _pf(bill.naturalGasCCF) > 0 || (bill.naturalGasCCF && bill.naturalGasCCF !== '');
            const ccf = _pf(bill.naturalGasCCF);
            // MMBtu path: mmbtu set, therms/ccf empty, stored therms ≈ raw mmbtu (NOT ≈ mmbtu×10)
            const needsMMBtu =
              mmbtu > 0 &&
              !hasTherms &&
              !hasCCF &&
              therms > 0 &&
              _approxEq(therms, mmbtu, 0.005) &&
              !_approxEq(therms, mmbtu * 10, 0.005);
            // CCF path: ccf set, therms field empty, stored therms ≈ raw ccf (NOT ≈ ccf×1.037)
            const needsCCF =
              ccf > 0 &&
              !hasTherms &&
              therms > 0 &&
              _approxEq(therms, ccf, 0.005) &&
              !_approxEq(therms, ccf * 1.037, 0.005);
            if (needsMMBtu) {
              _thermsReport.wouldFix.push({
                pid,
                building: b.name || b.id,
                meter: mt.name || mt.id || mt.commodity,
                billEnd: bill.end,
                source: 'MMBtu',
                oldTherms: therms,
                newTherms: Math.round(mmbtu * 10 * 100) / 100,
                bill,
              });
            } else if (needsCCF) {
              _thermsReport.wouldFix.push({
                pid,
                building: b.name || b.id,
                meter: mt.name || mt.id || mt.commodity,
                billEnd: bill.end,
                source: 'CCF',
                oldTherms: therms,
                newTherms: Math.round(ccf * 1.037 * 100) / 100,
                bill,
              });
            } else if (mmbtu > 0 && !hasTherms && !hasCCF && therms > 0) {
              // Has MMBtu and a therms value but predicate didn't fire — log as ambiguous
              _thermsReport.ambiguous.push({
                pid,
                building: b.name || b.id,
                billEnd: bill.end,
                therms,
                mmbtu,
                reason: 'neither ≈mmbtu nor ≈mmbtu×10 — may be hand-corrected; left untouched',
              });
            }
          }
        }
      }
    }
    console.log(
      '[therms-unit migration v1] DRY-RUN: would fix=' +
        _thermsReport.wouldFix.length +
        ' ambiguous=' +
        _thermsReport.ambiguous.length,
    );
    if (_thermsReport.wouldFix.length) {
      console.table(
        _thermsReport.wouldFix.map((r) => ({
          pid: r.pid,
          building: r.building,
          meter: r.meter,
          billEnd: r.billEnd,
          source: r.source,
          old: r.oldTherms,
          new: r.newTherms,
        })),
      );
    }
    if (_thermsReport.ambiguous.length) {
      console.warn('[therms-unit migration v1] Ambiguous bills left untouched:');
      console.table(_thermsReport.ambiguous);
    }
    // MUTATION PASS: apply corrections
    let _thermsFixed = 0;
    for (const entry of _thermsReport.wouldFix) {
      const bill = entry.bill;
      const oldTherms = _pf(bill.therms);
      const oldThermCost = _pf(bill.thermCost);
      bill.therms = entry.newTherms;
      bill._thermsUnitFixed = true;
      bill._thermsUnitFixedFrom = entry.source;
      // Recompute totalGasRate so $/therm is correct (~$0.42 not ~$4.18)
      if (oldThermCost > 0 && entry.newTherms > 0) {
        bill.totalGasRate = (oldThermCost / entry.newTherms).toFixed(5);
      }
      _thermsFixed++;
      console.log(
        '[therms-unit migration v1] Fixed ' +
          entry.building +
          ' / ' +
          entry.meter +
          ' end=' +
          entry.billEnd +
          ' therms: ' +
          oldTherms +
          ' → ' +
          entry.newTherms,
      );
    }
    if (_thermsFixed > 0) {
      saveUtilityData();
      showToast(
        _thermsFixed +
          ' gas bill' +
          (_thermsFixed > 1 ? 's' : '') +
          ' corrected: MMBtu→Therms (×10). See console for details. Recommend downloading a backup.',
      );
      console.log('[therms-unit migration v1] Saved. Total fixed: ' + _thermsFixed);
    } else {
      console.log('[therms-unit migration v1] No bills needed correction.');
    }
    DB.set(_thermsFixKey, '1');
  }
  // Auto-inherit baselines: any meter with bills but no baseline gets
  // the majority baseline from same-commodity meters in the same project
  for (const pid of Object.keys(utilityData)) {
    _inheritBaselinesForProject(pid);
  }
}
function saveUtilityData() {
  // Write each project to its own localStorage key
  Object.keys(utilityData).forEach(function (pid) {
    sset('en_utility_' + pid, utilityData[pid]);
  });
  _refreshBldgPerfIfVisible();
}

function _inheritBaselinesForProject(projId) {
  const bldgs = getUDBldgs(projId);
  const allBaselines = [];
  bldgs.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.baseline && m.baseline.months && m.baseline.months.length > 0)
        allBaselines.push({ commodity: m.commodity, months: m.baseline.months });
    }),
  );
  if (!allBaselines.length) return 0;
  let count = 0;
  bldgs.forEach((b) =>
    (b.meters || []).forEach((m) => {
      if (m.baseline && m.baseline.months && m.baseline.months.length > 0) return;
      if (!m.bills || !m.bills.length) return;
      const sameCommodity = allBaselines.filter((c) => c.commodity === m.commodity);
      const pool = sameCommodity.length ? sameCommodity : allBaselines;
      const counts = {};
      pool.forEach((c) => {
        const key = c.months.slice().sort().join(',');
        counts[key] = counts[key] || { months: c.months, n: 0 };
        counts[key].n++;
      });
      const best = Object.values(counts).sort((a, b) => b.n - a.n)[0];
      if (best) {
        m.baseline = { months: [...best.months], reg: null };
        count++;
      }
    }),
  );
  if (count > 0) saveUtilityData();
  return count;
}

/* ══════════════════════════════════════════════════════
               UTILITY DATA AUDIT LOG
               Every change to saved bill data runs through logUtilityAudit so the
               History modal can surface WHO changed WHAT and WHEN. Stored in its
               own localStorage key so the entry list doesn't bloat the project
               records. Hard cap at 500 entries (oldest dropped first).
            ══════════════════════════════════════════════════════ */
const AUDIT_LOG_KEY = 'en_utility_audit_log';
const AUDIT_LOG_MAX = 500;

function logUtilityAudit(entry) {
  try {
    const log = sget(AUDIT_LOG_KEY, []) || [];
    const full = {
      ts: new Date().toISOString(),
      action: entry.action || 'unknown',
      projId: entry.projId || null,
      projName: entry.projName || '',
      bldgId: entry.bldgId || null,
      bldgName: entry.bldgName || '',
      meterId: entry.meterId || null,
      meterLabel: entry.meterLabel || '',
      period: entry.period || '',
      source: entry.source || 'manual',
      changes: entry.changes || null,
      note: entry.note || '',
    };
    log.unshift(full);
    if (log.length > AUDIT_LOG_MAX) log.length = AUDIT_LOG_MAX;
    sset(AUDIT_LOG_KEY, log);
  } catch (e) {
    console.warn('audit log write failed', e);
  }
}

function _auditCtxFromIds(projId, bldgId, meterId) {
  const p = projects.find((x) => x.id === projId);
  const b = getUDBldg(projId, bldgId);
  const m = b?.meters?.find((mm) => mm.id === meterId);
  return {
    projId,
    projName: p?.name || '',
    bldgId,
    bldgName: b?.name || '',
    meterId,
    meterLabel: m ? meterLabel(m) : '',
  };
}

function _auditPeriodLabel(row) {
  if (!row) return '';
  if (row.start && row.end) return row.start + ' to ' + row.end;
  if (row.BillingPeriodStart && row.BillingPeriodEnd) return row.BillingPeriodStart + ' to ' + row.BillingPeriodEnd;
  return '';
}

/* ── VALUE CORRECTION MODE (Update a3a423eb) ──
   Toggle a per-session flag that turns the bills table into an edit surface.
   When active, clicking any numeric cell opens a popover to enter a
   corrected value with an optional reason note. The original value is
   preserved on row._userCorrected[field] for audit trail. */
function toggleValueCorrectionMode() {
  _vcmActive = !_vcmActive;
  var btn = document.getElementById('vcm-toggle');
  if (btn) btn.classList.toggle('active', _vcmActive);
  var tbl = document.getElementById('billsBodyTbl');
  if (tbl) tbl.classList.toggle('vcm-active', _vcmActive);
}
window.toggleValueCorrectionMode = toggleValueCorrectionMode;

function showVCMPopover(td) {
  // Remove any stale keydown handler from a previous open popover
  if (_vcmKeyHandler) {
    document.removeEventListener('keydown', _vcmKeyHandler);
    _vcmKeyHandler = null;
  }
  var existing = document.getElementById('vcm-popover');
  if (existing) existing.remove();
  var field = td.dataset.vcmField;
  var rowId = td.dataset.vcmRowid;
  var mid = td.dataset.vcmMid;
  // Strip display formatting to get a raw number for the input default value
  var currentText = td.textContent.trim();
  var currentVal = currentText.replace(/[$,%\s★]/g, '').replace(/,/g, '') || '';
  var pop = document.createElement('div');
  pop.id = 'vcm-popover';
  pop.innerHTML =
    '<div class="vcm-pop-title">Correct Value</div>' +
    '<div class="vcm-pop-current">Current: ' +
    currentText +
    '</div>' +
    '<input id="vcm-input" type="number" step="any" placeholder="Corrected value" value="' +
    currentVal +
    '">' +
    '<input id="vcm-note" type="text" placeholder="Reason (optional)">' +
    '<div class="vcm-pop-btns">' +
    '<button onclick="_vcmCancelPopover()">Cancel</button>' +
    '<button onclick="submitValueCorrection(\'' +
    mid +
    "','" +
    rowId +
    "','" +
    field +
    "'," +
    "parseFloat(document.getElementById('vcm-input').value)," +
    "document.getElementById('vcm-note').value)\">Save</button>" +
    '</div>';
  var rect = td.getBoundingClientRect();
  pop.style.top = rect.bottom + window.scrollY + 4 + 'px';
  pop.style.left = rect.left + window.scrollX + 'px';
  document.body.appendChild(pop);
  var inp = document.getElementById('vcm-input');
  if (inp) inp.focus();
  // Close on Escape — store in module-level var so Cancel/Save can remove it
  _vcmKeyHandler = function (e) {
    if (e.key === 'Escape') {
      _vcmCancelPopover();
    }
  };
  document.addEventListener('keydown', _vcmKeyHandler);
}
window.showVCMPopover = showVCMPopover;

// Shared cancel helper — removes the keydown listener and the popover DOM node.
// Called by Cancel button (inline onclick) and Escape handler.
function _vcmCancelPopover() {
  if (_vcmKeyHandler) {
    document.removeEventListener('keydown', _vcmKeyHandler);
    _vcmKeyHandler = null;
  }
  var p = document.getElementById('vcm-popover');
  if (p) p.remove();
}
window._vcmCancelPopover = _vcmCancelPopover;

function _auditDiffBillFields(before, after) {
  if (!before || !after) return null;
  const diffs = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k.startsWith('_') || k === 'id') continue;
    const bv = before[k];
    const av = after[k];
    if (String(bv || '') !== String(av || '')) {
      diffs.push({ field: k, from: bv, to: av });
    }
  }
  return diffs.length ? diffs : null;
}

function openAuditLogModal() {
  const log = sget(AUDIT_LOG_KEY, []) || [];
  const body = document.getElementById('auditLogBody');
  if (!log.length) {
    body.innerHTML =
      '<div style="text-align:center;color:var(--text3);padding:40px">No history entries yet. Changes to billing data will appear here.</div>';
  } else {
    const actionLabels = {
      add: '➕ Added',
      edit: '✏️ Edited',
      delete: '🗑️ Deleted',
      delete_all: '🗑️ Cleared All',
      extract: '📄 Extracted',
      move: '↗️ Moved',
    };
    const rows = log
      .map((e) => {
        const dt = new Date(e.ts);
        const timeStr =
          dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
          ' ' +
          dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        let details = e.note || '';
        if (e.changes && e.changes.length) {
          details = e.changes.map((c) => c.field + ': ' + (c.from || '—') + ' → ' + (c.to || '—')).join('; ');
        }
        if (details.length > 120) details = details.slice(0, 117) + '…';
        return (
          '<tr>' +
          '<td style="padding:4px 8px;white-space:nowrap;color:var(--text3);font-size:11px">' +
          timeStr +
          '</td>' +
          '<td style="padding:4px 8px;white-space:nowrap">' +
          (actionLabels[e.action] || e.action) +
          '</td>' +
          '<td style="padding:4px 8px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">' +
          (e.projName || '') +
          '</td>' +
          '<td style="padding:4px 8px;white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis">' +
          (e.meterLabel || '') +
          '</td>' +
          '<td style="padding:4px 8px;font-family:var(--mono);font-size:11px;white-space:nowrap">' +
          (e.period || '') +
          '</td>' +
          '<td style="padding:4px 8px;font-size:11px;color:var(--text2);max-width:250px;overflow:hidden;text-overflow:ellipsis" title="' +
          (details || '').replace(/"/g, '&quot;') +
          '">' +
          details +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    body.innerHTML =
      '<table class="dtbl" style="width:100%;font-size:12px"><thead><tr><th>Time</th><th>Action</th><th>Project</th><th>Meter</th><th>Period</th><th>Details</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>';
  }
  document.getElementById('auditLogModal').classList.add('open');
}
function closeAuditLogModal() {
  document.getElementById('auditLogModal').classList.remove('open');
}
async function clearAuditLog() {
  if (!(await confirmAsync('Clear all history entries? This cannot be undone.'))) return;
  sset(AUDIT_LOG_KEY, []);
  openAuditLogModal();
  showToast('History cleared');
}

function getUDProj(pid) {
  return (utilityData[pid] || (utilityData[pid] = { buildings: [] }), utilityData[pid]);
}
function getUDBldgs(pid) {
  return getUDProj(pid).buildings;
}
function getUDBldg(pid, bid) {
  return getUDBldgs(pid).find((b) => b.id === bid);
}
function getUDMeter(pid, bid, mid) {
  const b = getUDBldg(pid, bid);
  return b ? b.meters.find((m) => m.id === mid) : null;
}

const UNIT_REGISTRY = {
  Electric: {
    usage: ['kWh', 'MWh', 'BTU', 'MMBtu'],
    demand: ['kW', 'MW'],
    defaultUsage: 'kWh',
    defaultDemand: 'kW',
  },
  Gas: {
    usage: ['Therms', 'CCF', 'MCF', 'DTh', 'BTU', 'MMBtu'],
    demand: [],
    defaultUsage: 'Therms',
    defaultDemand: null,
  },
  Water: {
    usage: ['Gallons', 'kGal', 'CCF'],
    demand: [],
    defaultUsage: 'Gallons',
    defaultDemand: null,
  },
  Propane: {
    usage: ['Gallons', 'Therms', 'BTU', 'MMBtu'],
    demand: [],
    defaultUsage: 'Gallons',
    defaultDemand: null,
  },
  Steam: {
    usage: ['Therms', 'MLbs', 'BTU', 'MMBtu'],
    demand: [],
    defaultUsage: 'Therms',
    defaultDemand: null,
  },
};

const UNIT_TO_BASE = {
  Therms: { base: 'Therms', factor: 1 },
  CCF: { base: 'Therms', factor: 1.037 },
  MCF: { base: 'Therms', factor: 10.37 },
  DTh: { base: 'Therms', factor: 10 },
  MLbs: { base: 'Therms', factor: 10 },
  kWh: { base: 'kWh', factor: 1 },
  MWh: { base: 'kWh', factor: 1000 },
  kW: { base: 'kW', factor: 1 },
  MW: { base: 'kW', factor: 1000 },
  Gallons: { base: 'Gallons', factor: 1 },
  kGal: { base: 'Gallons', factor: 1000 },
};

const UNIT_TO_BASE_BY_COMMODITY = {
  BTU: {
    Gas: { base: 'Therms', factor: 0.00001 },
    Electric: { base: 'kWh', factor: 0.000293071 },
    Propane: { base: 'Therms', factor: 0.00001 },
    Steam: { base: 'Therms', factor: 0.00001 },
  },
  MMBtu: {
    Gas: { base: 'Therms', factor: 10 },
    Electric: { base: 'kWh', factor: 293.071 },
    Propane: { base: 'Therms', factor: 10 },
    Steam: { base: 'Therms', factor: 10 },
  },
  CCF: { Water: { base: 'Gallons', factor: 748.05 } },
  Gallons: { Propane: { base: 'Therms', factor: 0.9153 } },
};

function _unitInfo(unit, commodity) {
  const byCom = UNIT_TO_BASE_BY_COMMODITY[unit];
  if (byCom && commodity && byCom[commodity]) return byCom[commodity];
  return UNIT_TO_BASE[unit] || null;
}

function convertUnit(value, fromUnit, toUnit, commodity) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return value;
  const v = parseFloat(value);
  if (isNaN(v)) return value;
  const from = _unitInfo(fromUnit, commodity);
  const to = _unitInfo(toUnit, commodity);
  if (!from || !to || from.base !== to.base) return value;
  return (v * from.factor) / to.factor;
}

function getMeterBillUnit(m) {
  if (m.billUnit) return m.billUnit;
  const reg = UNIT_REGISTRY[m.commodity];
  return reg ? reg.defaultUsage : 'kWh';
}

function getMeterDisplayUnit(m) {
  if (m.displayUnit) return m.displayUnit;
  // Check project-level default display unit
  if (m.commodity && udSelProjId) {
    const proj = projects.find((p) => p.id === udSelProjId);
    if (proj?.defaultDisplayUnits?.[m.commodity]) return proj.defaultDisplayUnits[m.commodity];
  }
  return getMeterBillUnit(m);
}

function getMeterDemandDisplayUnit(m) {
  if (!m.displayUnit && !m.billUnit) return UNIT_REGISTRY[m.commodity]?.defaultDemand || null;
  const reg = UNIT_REGISTRY[m.commodity];
  if (!reg || !reg.demand.length) return null;
  const dispU = getMeterDisplayUnit(m);
  if (dispU === 'MWh' || dispU === 'MW') return 'MW';
  return reg.defaultDemand;
}

function convertBillValue(value, m) {
  return convertUnit(value, getMeterBillUnit(m), getMeterDisplayUnit(m), m.commodity);
}

// Bill schema keys that represent energy/usage quantities eligible for
// unit conversion (e.g. kWh→MWh, CCF→Therms). Demand, meter reads,
// multipliers, and currency fields are NOT converted here.
const _BILL_USAGE_KEYS = new Set([
  'kwh',
  'onPeakKwh',
  'offPeakKwh', // Electric usage
  'naturalGasTherms',
  'naturalGasCCF', // Gas usage
  'waterUsage', // Water usage
  'sewerUsage', // Sewer usage
  'gallonsDelivered', // Propane usage
]);

// Returns true when conversion is active for this meter (display unit
// differs from the bill/storage unit).
function _isConversionActive(m) {
  return getMeterBillUnit(m) !== getMeterDisplayUnit(m);
}

/* ── COMMODITY HELPERS ── */
function commodityPill(c) {
  const map = {
    Electric: 'ud-meter-elec',
    Gas: 'ud-meter-gas',
    Water: 'ud-meter-water',
    Sewer: 'ud-meter-sewer',
    Stormwater: 'ud-meter-storm',
    Steam: 'ud-meter-steam',
    Propane: 'ud-meter-propane',
  };
  return `<span class="ud-meter-pill ${map[c] || 'ud-meter-elec'}">${c || '—'}</span>`;
}
function meterLabel(m) {
  const acct = m.account ? m.account : '—';
  const mtr = m.meter ? m.meter : '—';
  return `${m.commodity} · Acct ${acct} · Meter ${mtr}`;
}
// Normalize date strings to ISO YYYY-MM-DD.
// KGS bills give dates as MM-DD-YY (e.g. "01-19-26" = Jan 19 2026).
// The old code treated the first pair as YY (year), producing invalid dates like "2001-19-26".
// Fix: if already YYYY-MM-DD pass through; otherwise treat as MM-DD-YY → YYYY-MM-DD.
function _fixISO(d) {
  if (!d || typeof d !== 'string') return d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d; // already ISO
  const m = d.match(/^(\d{2})-(\d{2})-(\d{2})$/); // MM-DD-YY
  if (m) return '20' + m[3] + '-' + m[1] + '-' + m[2];
  return d;
}
function _parseISO(d) {
  return new Date(_fixISO(d) + 'T12:00:00');
}

function calcDays(start, end, inclusive) {
  if (!start || !end) return '';
  const s = _parseISO(start),
    e = _parseISO(end);
  const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
  return inclusive ? diff + 1 : diff;
}

/* ── RENDER LEFT NAV: Projects + Buildings drill-down ── */
function viewProjectFromUtility() {
  if (!udSelProjId) return;
  const p = projects.find((x) => x.id === udSelProjId);
  if (!p) return;
  sv('projects', document.querySelector('.s-item[onclick*="projects"]'));
  setTimeout(() => {
    openDetail(p.id);
  }, 100);
}

function renderUDProjList() {
  const el = document.getElementById('udNavList');
  if (!el) return;
  if (!projects.length) {
    el.innerHTML = '<div class="ud-empty"><div class="ud-empty-ico">📁</div>No projects yet</div>';
    return;
  }
  let html = '';
  projects.forEach((p) => {
    const bldgs = getUDBldgs(p.id);
    const projActive = p.id === udSelProjId ? ' active' : '';
    html += `<div class="ud-nav-proj-item${projActive}" onclick="udSelectProj(${p.id})">
            <span style="font-size:14px;flex-shrink:0">${getFacilityIcon(p.type)}</span>
            <span class="ud-nav-proj-name" title="${p.name}">${p.name}</span>
            ${bldgs.length ? `<span class="ud-nav-proj-count">${bldgs.length}</span>` : ''}
          </div>`;
    // If this project is selected, show its buildings inline underneath
    if (p.id === udSelProjId) {
      if (!bldgs.length) {
        html += `<div style="padding:6px 14px 6px 30px;font-size:11px;color:var(--text3)">No buildings —
                <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:1px 6px" onclick="openBldgModal(null)">+ Add</button></div>`;
      } else {
        bldgs.forEach((b) => {
          const _allMeters = b.meters || [];
          const _totalMCount = _allMeters.length;
          const _blMeters = _allMeters.filter((m) => m.baselineInclude !== false);
          const mCount = _blMeters.length;
          const mWithBl = _blMeters.filter(
            (m) => m.baseline && Array.isArray(m.baseline.months) && m.baseline.months.length,
          ).length;
          const blBadge =
            mCount > 0
              ? mWithBl === mCount
                ? `<span style="color:var(--green);font-size:10px" title="All baseline meters have baselines set">✓ ${mWithBl}/${mCount} BL</span>`
                : mWithBl > 0
                  ? `<span style="color:var(--amber);font-size:10px" title="${mWithBl} of ${mCount} baseline meters have baselines set">⚠ ${mWithBl}/${mCount} BL</span>`
                  : `<span style="color:var(--text3);font-size:10px" title="No baselines set">— 0/${mCount} BL</span>`
              : '';
          // Count active (non-dismissed) flags across all meters → bills in this building.
          // Update 94abf6d6: use live _analyzeMeterBills result; consult _flags only for
          // dismissed IDs and cross-meter flags so stale stored flags never inflate the count.
          const _bFlagCount = _allMeters.reduce((sum, meter) => {
            const _mBills = meter.bills || [];
            const _liveMeterFlags =
              typeof _analyzeMeterBills === 'function' && _mBills.length >= 4
                ? _analyzeMeterBills(
                    _mBills.slice().sort((a, b) => _parseISO(a.start) - _parseISO(b.start)),
                    meter,
                  )
                : {};
            return (
              sum +
              _mBills.reduce((s, bill) => {
                const _dismissed = new Set(
                  Array.isArray(bill._flags) ? bill._flags.filter((f) => f.dismissed).map((f) => f.id) : [],
                );
                const liveCount = (_liveMeterFlags[bill.id] || []).filter((f) => {
                  const fId = (f.field || 'unknown') + '_' + (f.level || 'warn');
                  return !_dismissed.has(fId);
                }).length;
                const crossMeterCount = Array.isArray(bill._flags)
                  ? bill._flags.filter((f) => f.id === 'waterSewerParity_warn' && !f.dismissed).length
                  : 0;
                return s + liveCount + crossMeterCount;
              }, 0)
            );
          }, 0);
          const flagBadge =
            _bFlagCount > 0
              ? `<span style="color:var(--amber);font-size:10px" title="${_bFlagCount} bill flag${_bFlagCount !== 1 ? 's' : ''} need review">⚠ ${_bFlagCount} review</span>`
              : '';
          const bldgActive = b.id === udSelBldgId ? ' active' : '';
          html += `<div class="ud-nav-bldg-item${bldgActive}" onclick="udSelectBldg('${b.id}')">
                  <div style="flex:1;min-width:0">
                    <div class="ud-nav-bldg-name" title="${b.name}">${b.name}</div>
                    <div class="ud-nav-bldg-meta">${b.sqft ? Number(b.sqft).toLocaleString() + ' sf · ' : ''}${_totalMCount} meter${_totalMCount !== 1 ? 's' : ''} ${blBadge}${flagBadge ? ' ' + flagBadge : ''}</div>
                  </div>
                  <div class="ud-nav-bldg-actions">
                    <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:11px" onclick="event.stopPropagation();openBldgModal('${b.id}')" title="Edit">✏️</button>
                    <button class="btn-del" onclick="event.stopPropagation();deleteBuilding('${b.id}')" title="Delete">✕</button>
                  </div>
                </div>`;
        });
        html += `<div style="padding:5px 14px 8px 30px;display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" style="font-size:11px;flex:1" onclick="openBldgModal(null)">+ Add Building</button>
                <button class="btn btn-ghost btn-sm" style="font-size:11px;flex:1" onclick="openBldgImportModal()">⬆ Import List</button>
              </div>`;
      }
    }
  });
  el.innerHTML = html;
}

/* Keep old name working — it's called in several places */
function renderUDBldgList() {
  renderUDProjList();
}

let _udProjPanel = null; // 'baseline'|'savproj'|'perf'|null

function udSelectProj(pid) {
  udSelProjId = pid;
  window._activeProjId = pid;
  udSelBldgId = null;
  udActiveMid = null;
  _udProjPanel = null;
  saveUDSession();
  renderUDProjList();
  renderUDDetail();
  // Show project panel bar
  const bar = document.getElementById('udProjPanelBar');
  const barTitle = document.getElementById('udProjPanelBarTitle');
  const p = projects.find((x) => x.id === pid);
  if (bar) {
    bar.style.display = 'flex';
  }
  if (barTitle && p) barTitle.textContent = p.name;
}

function udSelectBldg(bid) {
  if (udSelBldgId !== bid) _openMeterIds.clear();
  udSelBldgId = bid;
  udActiveMid = null;
  saveUDSession();
  // Fire-and-forget: populate weather cache from GitHub Pages if DB has no data for ZIP
  const _wddBldg = getUDBldg(udSelProjId, bid);
  if (_wddBldg && _wddBldg.zip) wddPrefetchFromServer(_wddBldg.zip);
  // Close any open project panel
  if (_udProjPanel) {
    _udProjPanel = null;
    const content = document.getElementById('udProjPanelContent');
    if (content) {
      content.style.display = 'none';
      content.innerHTML = '';
    }
    const wrap = document.getElementById('udDetailWrap');
    if (wrap) wrap.style.display = '';
    ['ud-proj-baseline-btn', 'ud-proj-savproj-btn', 'ud-proj-perf-btn', 'ud-proj-compare-btn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.style.borderColor = '';
        btn.style.color = '';
      }
    });
  }
  saveUDSession();
  renderUDProjList();
  renderUDDetail();
}

function toggleUDProjPanel(key) {
  _udProjPanel = _udProjPanel === key ? null : key;
  const map = {
    baseline: 'ud-proj-baseline-btn',
    savproj: 'ud-proj-savproj-btn',
    perf: 'ud-proj-perf-btn',
    compare: 'ud-proj-compare-btn',
  };
  Object.entries(map).forEach(([k, id]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.borderColor = _udProjPanel === k ? 'var(--em)' : '';
    btn.style.color = _udProjPanel === k ? 'var(--em)' : '';
  });
  const content = document.getElementById('udProjPanelContent');
  const wrap = document.getElementById('udDetailWrap');
  const bldgHdr = document.getElementById('udDetailHdr');
  if (!content) return;
  if (!_udProjPanel) {
    // Close: restore normal meter view
    content.style.display = 'none';
    content.innerHTML = '';
    if (wrap) wrap.style.display = '';
    if (bldgHdr && udSelBldgId) bldgHdr.style.display = 'flex';
    return;
  }
  // Open: hide meter wrap and building header, show panel full-height
  if (wrap) wrap.style.display = 'none';
  if (bldgHdr) bldgHdr.style.display = 'none';
  content.style.display = 'block';
  content.style.maxHeight = 'none';
  content.style.overflowY = 'auto';
  content.innerHTML = '<div style="padding:20px;font-size:12px;color:var(--text2)">Aggregating project data...</div>';
  requestAnimationFrame(() => renderUDProjAggPanel(content));
}

function aggBaseMoMapForBldgs(bldgs) {
  const moBase = {};
  for (let i = 0; i < 12; i++) moBase[i] = 0;
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const incl = m.inclusive !== false;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const savedReg = m._reg;
      const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
      m._reg = savedReg; // restore — aggBaseMoMapForBldgs must not clobber the report's regression
      const blRows = allRows.filter((r) => bl.months.includes(r.ym));
      if (!blRows.length) return;
      const { elecByMo: eM, gasByMo: gM, propaneByMo: pM, waterByMo: wM } = buildMoMap(m, blRows, bills, incl);
      for (let mo = 0; mo < 12; mo++)
        moBase[mo] += (eM[mo]?.totalCost || 0) + (gM[mo]?.cost || 0) + (pM[mo]?.cost || 0) + (wM[mo]?.cost || 0);
    });
  });
  return moBase;
}

function renderUDProjAggPanel(content) {
  const proj = utilityData[udSelProjId];
  const bldgs = proj?.buildings || [];
  const projMeta = projects.find((p) => p.id === udSelProjId);
  const projName = projMeta?.name || 'Project';
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $f = (v, d = 0) =>
    v != null ? '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const $n = (v, d = 0) =>
    v != null ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

  if (!bldgs.length) {
    content.innerHTML =
      '<div style="padding:20px;font-size:13px;color:var(--text2)">No buildings in this project yet.</div>';
    return;
  }

  const allMeters = [];
  let totalSqft = 0;
  bldgs.forEach((b) => {
    totalSqft += parseFloat(b.sqft || 0);
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      allMeters.push({
        m,
        bills,
        incl: m.inclusive !== false,
        bldg: b,
        isElec: m.commodity === 'Electric',
        isGas: m.commodity === 'Gas',
      });
    });
  });

  // Delegate to top-level helper
  function aggBaseMoMap() {
    return aggBaseMoMapForBldgs(bldgs);
  }

  function avgSavPctAcrossBldgs(moBase) {
    let wtSav = 0,
      wtBase = 0;
    bldgs.forEach((b) => {
      const msrSav = getBldgMeasureSavingsByMo(udSelProjId, b.id);
      let bldgBase = 0;
      (b.meters || []).forEach((m) => {
        const bills2 = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
        const incl2 = m.inclusive !== false;
        const bl = m.baseline;
        if (!bl || !bl.months || bl.months.length < 3) return;
        const allRows = bills2.length ? getNormRows(m, bills2, incl2, null) : [];
        const blRows = allRows.filter((r) => bl.months.includes(r.ym));
        const { elecByMo: eM, gasByMo: gM } = buildMoMap(m, blRows, bills2, incl2);
        for (let mo = 0; mo < 12; mo++) bldgBase += (eM[mo]?.totalCost || 0) + (gM[mo]?.cost || 0);
      });
      if (msrSav) {
        wtSav += msrSav.reduce((s, v) => s + v, 0);
      } else {
        const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
        const bspCfg = DB.get(bspKey, {});
        const savPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;
        wtSav += savPct * bldgBase;
      }
      wtBase += bldgBase;
    });
    return wtBase > 0 ? wtSav / wtBase : 0.11;
  }

  const thS =
    'padding:6px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);background:var(--s1);border:1px solid var(--border2);white-space:nowrap';

  if (_udProjPanel === 'baseline') {
    const elecByMo = {},
      gasByMo = {},
      propaneByMo = {};
    for (let i = 0; i < 12; i++) {
      elecByMo[i] = { kwh: 0, totalCost: 0 };
      gasByMo[i] = { therms: 0, cost: 0 };
      propaneByMo[i] = { gallons: 0, cost: 0 };
    }
    allMeters.forEach(({ m, bills, incl, isElec, isGas }) => {
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
      const blRows = allRows.filter((r) => bl.months.includes(r.ym));
      if (!blRows.length) return;
      const { elecByMo: eM, gasByMo: gM, propaneByMo: pM } = buildMoMap(m, blRows, bills, incl);
      for (let mo = 0; mo < 12; mo++) {
        if (isElec && eM[mo]) {
          elecByMo[mo].kwh += eM[mo].kwh || 0;
          elecByMo[mo].totalCost += eM[mo].totalCost || 0;
        }
        if (isGas && gM[mo]) {
          gasByMo[mo].therms += gM[mo].therms || 0;
          gasByMo[mo].cost += gM[mo].cost || 0;
        }
        if (m.commodity === 'Propane' && pM[mo]) {
          propaneByMo[mo].gallons += pM[mo].gallons || 0;
          propaneByMo[mo].cost += pM[mo].cost || 0;
        }
      }
    });
    const annKwh = Object.values(elecByMo).reduce((s, v) => s + v.kwh, 0);
    const annElecCost = Object.values(elecByMo).reduce((s, v) => s + v.totalCost, 0);
    const annTherms = Object.values(gasByMo).reduce((s, v) => s + v.therms, 0);
    const annGasCost = Object.values(gasByMo).reduce((s, v) => s + v.cost, 0);
    const annPropGal = Object.values(propaneByMo).reduce((s, v) => s + v.gallons, 0);
    const annPropCost = Object.values(propaneByMo).reduce((s, v) => s + v.cost, 0);
    const annTotal = annElecCost + annGasCost + annPropCost;
    const kwhRate = annKwh > 0 ? annElecCost / annKwh : 0;
    const thermRate = annTherms > 0 ? annGasCost / annTherms : 0;
    const annKbtu = toKBtu(annKwh, annTherms, annPropGal);
    const eui = totalSqft > 0 ? annKbtu / totalSqft : 0;
    const tdS = (color = 'var(--text)') =>
      `padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${color};border:1px solid var(--border);white-space:nowrap`;
    const rows = MN.map((mn, mo) => {
      const e = elecByMo[mo],
        g = gasByMo[mo];
      return `<tr><td style="padding:6px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--s2)">${mn}</td>
              <td style="${tdS('var(--em2)')}">${$n(e.kwh, 0)}</td><td style="${tdS()}">${$f(e.totalCost, 2)}</td>
              <td style="${tdS('var(--warn)')}">${$n(g.therms, 0)}</td><td style="${tdS()}">${$f(g.cost, 2)}</td>
              <td style="${tdS('var(--em)')}">${$f(e.totalCost + g.cost, 2)}</td></tr>`;
    }).join('');
    content.innerHTML = `
            <div style="padding:14px 18px;background:var(--s2);border-bottom:1px solid var(--border)">
              <div style="font-size:14px;font-weight:800;font-family:var(--head);color:var(--em);margin-bottom:10px">📊 ${projName} — Project Baseline</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
                ${totalSqft ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Total Sq Ft</div><div style="font-size:15px;font-weight:800">${$n(totalSqft)}</div></div>` : ''}
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Annual kWh</div><div style="font-size:15px;font-weight:800;color:var(--em2)">${$n(annKwh)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Annual Therms</div><div style="font-size:15px;font-weight:800;color:var(--warn)">${$n(annTherms)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Electric $/yr</div><div style="font-size:15px;font-weight:800;color:var(--em2)">${$f(annElecCost)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Gas $/yr</div><div style="font-size:15px;font-weight:800;color:var(--warn)">${$f(annGasCost)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Total Utility $/yr</div><div style="font-size:15px;font-weight:800;color:var(--em)">${$f(annTotal)}</div></div>
                ${kwhRate ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Avg $/kWh</div><div style="font-size:15px;font-weight:800">${$f(kwhRate, 4)}</div></div>` : ''}
                ${thermRate ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Avg $/Therm</div><div style="font-size:15px;font-weight:800">${$f(thermRate, 2)}</div></div>` : ''}
                ${eui ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Site EUI</div><div style="font-size:15px;font-weight:800;color:var(--violet)">${$n(eui, 1)} <span style="font-size:10px;font-weight:400">kBtu/sf/yr</span></div></div>` : ''}
              </div>
            </div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:12px">
              <thead><tr style="background:var(--s1)"><th style="${thS};text-align:left">Month</th>
                <th style="${thS}">kWh</th><th style="${thS}">Elec $</th><th style="${thS}">Therms</th><th style="${thS}">Gas $</th><th style="${thS}">Total $</th></tr></thead>
              <tbody>${rows}</tbody>
              <tfoot><tr style="background:var(--s1)">
                <td style="padding:6px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)">Annual</td>
                <td style="${tdS('var(--em2)')};font-weight:700">${$n(annKwh)}</td><td style="${tdS()};font-weight:700">${$f(annElecCost, 2)}</td>
                <td style="${tdS('var(--warn)')};font-weight:700">${$n(annTherms)}</td><td style="${tdS()};font-weight:700">${$f(annGasCost, 2)}</td>
                <td style="${tdS('var(--em)')};font-weight:700">${$f(annTotal, 2)}</td>
              </tr></tfoot>
            </table></div>
            <div style="padding:16px 18px 10px;font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Monthly Utility Cost</div>
            <div style="padding:0 18px 20px;height:280px;position:relative"><canvas id="projBaselineChart"></canvas></div>`;
    requestAnimationFrame(() => {
      const elecVals = MN.map((_, mo) => elecByMo[mo]?.totalCost || 0);
      const gasVals = MN.map((_, mo) => gasByMo[mo]?.cost || 0);
      const cv = document.getElementById('projBaselineChart');
      if (!cv) return;
      if (_maCharts['projBaselineChart']) _maCharts['projBaselineChart'].destroy();
      _maCharts['projBaselineChart'] = new Chart(cv, {
        type: 'bar',
        data: {
          labels: MN,
          datasets: [
            { label: 'Electric $', data: elecVals, backgroundColor: 'rgba(14,165,233,.7)', stack: 's' },
            { label: 'Gas $', data: gasVals, backgroundColor: 'rgba(245,158,11,.7)', stack: 's' },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: { color: 'rgba(200,220,240,.9)', font: { size: 11 }, boxWidth: 14, padding: 14 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ' ' +
                  ctx.dataset.label +
                  ': $' +
                  ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                footer: (items) =>
                  'Total: $' +
                  items
                    .reduce((s, i) => s + i.parsed.y, 0)
                    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
              },
            },
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: 'rgba(180,200,220,.8)', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,.08)' },
            },
            y: {
              stacked: true,
              ticks: {
                color: 'rgba(180,200,220,.8)',
                font: { size: 10 },
                callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
              },
              grid: { color: 'rgba(255,255,255,.10)' },
              title: { display: true, text: 'Cost ($)', color: 'rgba(160,185,210,.8)', font: { size: 11 } },
            },
          },
        },
      });
    });
  } else if (_udProjPanel === 'savproj') {
    const moBase = aggBaseMoMap();
    const annBase = Object.values(moBase).reduce((s, v) => s + v, 0);

    // Compute actual monthly projected savings from measures only (skip excluded buildings)
    const projSavByMo = Array(12).fill(0);
    let _msrBldgCount = 0;
    bldgs.forEach((b) => {
      const _bMeters = b.meters || [];
      if (_bMeters.length > 0 && _bMeters.every((m) => m.baselineInclude === false)) return;
      const msrSav = getBldgMeasureSavingsByMo(udSelProjId, b.id);
      if (msrSav) {
        _msrBldgCount++;
        msrSav.forEach((v, mo) => {
          projSavByMo[mo] += v;
        });
      }
    });
    const annProjSav = projSavByMo.reduce((s, v) => s + v, 0);
    const avgSavPct = annBase > 0 ? annProjSav / annBase : 0;
    const _srcLabel =
      _msrBldgCount > 0
        ? '<div style="font-size:10px;color:var(--accent);margin-top:2px">\u{1F4CA} Source: Energy Savings Measures (' +
          _msrBldgCount +
          ' building' +
          (_msrBldgCount !== 1 ? 's' : '') +
          ')</div>'
        : '<div style="font-size:10px;color:var(--text3);margin-top:2px">\u{1F4CA} No measures configured</div>';

    const tdN = (v, color = 'var(--text)') =>
      `<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${color};border:1px solid var(--border);white-space:nowrap">${$f(v, 2)}</td>`;
    const rows = MN.map((mn, mo) => {
      const base = moBase[mo] || 0;
      const sav = projSavByMo[mo];
      return `<tr><td style="padding:6px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--s2)">${mn}</td>${tdN(base)}${tdN(base - sav)}${tdN(sav, 'var(--em)')}</tr>`;
    }).join('');
    content.innerHTML = `
            <div style="padding:14px 18px;background:var(--s2);border-bottom:1px solid var(--border)">
              <div style="font-size:14px;font-weight:800;font-family:var(--head);color:var(--em);margin-bottom:4px">📈 ${projName} — Projected Savings</div>
              ${_srcLabel}
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:8px">
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Annual Baseline</div><div style="font-size:15px;font-weight:800">${$f(annBase)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Projected Savings</div><div style="font-size:15px;font-weight:800;color:var(--em)">${$f(annProjSav)}</div><div style="font-size:11px;color:var(--text2);margin-top:2px">${(avgSavPct * 100).toFixed(1)}% of baseline</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Projected Spend</div><div style="font-size:15px;font-weight:800;color:var(--em2)">${$f(annBase - annProjSav)}</div></div>
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Buildings</div><div style="font-size:15px;font-weight:800">${bldgs.length}</div></div>
              </div>
            </div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:12px">
              <thead><tr style="background:var(--s1)"><th style="${thS};text-align:left">Month</th>
                <th style="${thS}">Baseline $</th><th style="${thS}">Projected Spend $</th><th style="${thS}">Projected Savings $</th></tr></thead>
              <tbody>${rows}</tbody>
              <tfoot><tr style="background:var(--s1)">
                <td style="padding:6px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)">Annual</td>
                ${tdN(annBase)}${tdN(annBase - annProjSav)}${tdN(annProjSav, 'var(--em)')}
              </tr></tfoot>
            </table></div>
            <div style="padding:16px 18px 10px;font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Monthly Projected Savings</div>
            <div style="padding:0 18px 20px;height:280px;position:relative"><canvas id="projSavProjChart"></canvas></div>`;
    requestAnimationFrame(() => {
      const savVals = MN.map((_, mo) => projSavByMo[mo]);
      const spendVals = MN.map((_, mo) => (moBase[mo] || 0) - projSavByMo[mo]);
      const cv = document.getElementById('projSavProjChart');
      if (!cv) return;
      if (_maCharts['projSavProjChart']) _maCharts['projSavProjChart'].destroy();
      _maCharts['projSavProjChart'] = new Chart(cv, {
        type: 'bar',
        data: {
          labels: MN,
          datasets: [
            { label: 'Projected Spend $', data: spendVals, backgroundColor: 'rgba(14,165,233,.6)', stack: 's' },
            { label: 'Projected Savings $', data: savVals, backgroundColor: 'rgba(0,212,170,.75)', stack: 's' },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: { color: 'rgba(200,220,240,.9)', font: { size: 11 }, boxWidth: 14, padding: 14 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ' ' +
                  ctx.dataset.label +
                  ': $' +
                  ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
              },
            },
          },
          scales: {
            x: {
              stacked: true,
              ticks: { color: 'rgba(180,200,220,.8)', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,.08)' },
            },
            y: {
              stacked: true,
              ticks: {
                color: 'rgba(180,200,220,.8)',
                font: { size: 10 },
                callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
              },
              grid: { color: 'rgba(255,255,255,.10)' },
              title: { display: true, text: 'Cost ($)', color: 'rgba(160,185,210,.8)', font: { size: 11 } },
            },
          },
        },
      });
    });
  } else if (_udProjPanel === 'perf') {
    const moBase = aggBaseMoMap();
    const annBase = Object.values(moBase).reduce((s, v) => s + v, 0);

    // Compute actual monthly projected savings from measures (with % fallback)
    const _perfProjSavByMo = Array(12).fill(0);
    bldgs.forEach((b) => {
      const msrSav = getBldgMeasureSavingsByMo(udSelProjId, b.id);
      if (msrSav) {
        msrSav.forEach((v, mo) => {
          _perfProjSavByMo[mo] += v;
        });
      } else {
        const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
        const bspCfg = DB.get(bspKey, {});
        const savPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;
        const bMoBase = aggBaseMoMapForBldgs([b]);
        for (let mo = 0; mo < 12; mo++) _perfProjSavByMo[mo] += (bMoBase[mo] || 0) * savPct;
      }
    });
    const annProjSav = _perfProjSavByMo.reduce((s, v) => s + v, 0);
    const avgSavPct = annBase > 0 ? annProjSav / annBase : 0;
    const actSavByMo = {};
    allMeters.forEach(({ m, bills, incl, bldg }) => {
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const sav = getMeterSavings(m, bills, incl, udSelProjId, bldg.id).byCalMo;
      Object.entries(sav).forEach(([mo, v]) => {
        actSavByMo[mo] = (actSavByMo[mo] || 0) + v;
      });
    });
    const hasActual = Object.keys(actSavByMo).length > 0;
    const annActSav = hasActual ? Object.values(actSavByMo).reduce((s, v) => s + v, 0) : null;
    const actPct = annBase > 0 && annActSav != null ? (annActSav / annBase) * 100 : null;
    // Compare actual vs projected for only the months that have actual data (YTD)
    const actMonths = Object.keys(actSavByMo).map(Number);
    const ytdProjSav = actMonths.reduce((s, mo) => s + _perfProjSavByMo[mo], 0);
    const ytdDiff = annActSav != null ? annActSav - ytdProjSav : null;
    const tdV = (v, color) => {
      if (v == null)
        return `<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--text3);border:1px solid var(--border)">—</td>`;
      const c = color || (v >= 0 ? 'var(--em)' : 'var(--danger)');
      return `<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${c};border:1px solid var(--border);white-space:nowrap">${v < 0 ? '−' : ''}${$f(v, 2)}</td>`;
    };
    const rows = MN.map((mn, mo) => {
      const base = moBase[mo] || 0;
      const act = actSavByMo[mo] != null ? actSavByMo[mo] : null;
      const pct = act != null && base > 0 ? (act / base) * 100 : null;
      return `<tr><td style="padding:6px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--s2)">${mn}</td>
              ${tdV(act)}
              <td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${pct == null ? 'var(--text3)' : pct >= 0 ? 'var(--em)' : 'var(--danger)'};border:1px solid var(--border)">${pct != null ? (pct < 0 ? '−' : '') + Math.abs(pct).toFixed(1) + '%' : '—'}</td>
            </tr>`;
    }).join('');
    content.innerHTML = `
            <div style="padding:14px 18px;background:var(--s2);border-bottom:1px solid var(--border)">
              <div style="font-size:14px;font-weight:800;font-family:var(--head);color:var(--em);margin-bottom:10px">💡 ${projName} — Performance</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Annual Baseline</div><div style="font-size:15px;font-weight:800">${$f(annBase)}</div></div>
                ${hasActual ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Current Savings</div><div style="font-size:15px;font-weight:800;color:${annActSav >= 0 ? 'var(--em)' : 'var(--danger)'}">${annActSav < 0 ? '−' : ''}${$f(annActSav)}</div>${actPct != null ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${actPct < 0 ? '−' : ''}${Math.abs(actPct).toFixed(1)}%</div>` : ''}</div>` : ''}
                <div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Projected Savings</div><div style="font-size:13px;font-weight:600;color:var(--text2)">${$f(annProjSav)}</div><div style="font-size:10px;color:var(--text3);margin-top:2px">${(avgSavPct * 100).toFixed(1)}%</div></div>
                ${hasActual && ytdDiff != null ? `<div style="background:var(--s1);border:1px solid var(--border);border-radius:7px;padding:8px 11px"><div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">vs Projected (${actMonths.length}mo YTD)</div><div style="font-size:15px;font-weight:800;color:${ytdDiff >= 0 ? 'var(--em)' : 'var(--danger)'}">${ytdDiff >= 0 ? '+' : '−'}${$f(Math.abs(ytdDiff))}</div><div style="font-size:11px;color:var(--text2);margin-top:2px">${ytdDiff >= 0 ? '▲ Above' : '▼ Below'} target</div></div>` : ''}
              </div>
            </div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:12px">
              <thead><tr style="background:var(--s1)"><th style="${thS};text-align:left">Month</th>
                <th style="${thS}">Current Savings $</th><th style="${thS}">% of Baseline</th></tr></thead>
              <tbody>${rows}</tbody>
              <tfoot><tr style="background:var(--s1)">
                <td style="padding:6px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)">Annual</td>
                ${tdV(hasActual ? annActSav : null)}
                <td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${actPct != null && actPct >= 0 ? 'var(--em)' : 'var(--danger)'};font-weight:700;border:1px solid var(--border)">${actPct != null ? (actPct < 0 ? '−' : '') + Math.abs(actPct).toFixed(1) + '%' : '—'}</td>
              </tr></tfoot>
            </table></div>
            <div style="padding:16px 18px 10px;font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Monthly Savings: Projected vs Current</div>
            <div style="padding:0 18px 20px;height:280px;position:relative"><canvas id="projPerfChart"></canvas></div>`;
    requestAnimationFrame(() => {
      const projVals = MN.map((_, mo) => _perfProjSavByMo[mo]);
      const actVals = MN.map((_, mo) => (actSavByMo[mo] != null ? actSavByMo[mo] : null));
      const cv = document.getElementById('projPerfChart');
      if (!cv) return;
      if (_maCharts['projPerfChart']) _maCharts['projPerfChart'].destroy();
      _maCharts['projPerfChart'] = new Chart(cv, {
        type: 'bar',
        data: {
          labels: MN,
          datasets: [
            {
              label: 'Projected Savings $',
              data: projVals,
              backgroundColor: 'rgba(139,92,246,.35)',
              borderColor: 'rgba(139,92,246,.8)',
              borderWidth: 1,
            },
            {
              label: 'Current Savings $',
              data: actVals,
              backgroundColor: 'rgba(59,130,246,.75)',
              borderColor: 'rgba(59,130,246,1)',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: { color: 'rgba(200,220,240,.9)', font: { size: 11 }, boxWidth: 14, padding: 14 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ctx.parsed.y != null
                    ? ' ' +
                      ctx.dataset.label +
                      ': ' +
                      (ctx.parsed.y >= 0 ? '+' : '-') +
                      ' $' +
                      Math.abs(ctx.parsed.y).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    : null,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: 'rgba(180,200,220,.8)', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,.08)' },
            },
            y: {
              ticks: {
                color: 'rgba(180,200,220,.8)',
                font: { size: 10 },
                callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
              },
              grid: { color: 'rgba(255,255,255,.10)' },
              title: { display: true, text: 'Savings ($)', color: 'rgba(160,185,210,.8)', font: { size: 11 } },
            },
          },
        },
      });
    });
  } else if (_udProjPanel === 'compare') {
    renderBldgComparisonPanel(content, bldgs, projName, udSelProjId);
  }
}

// ── BUILDING COMPARISON RADAR CHART ──────────────────────────────────────────
// Renders a radar (spider) chart comparing all buildings in a project on 6
// normalised performance metrics:
//   EUI, Cost/sqft, Savings%, Load Factor, ENERGY STAR score, Demand Intensity
//
// Normalisation: each metric is scaled to 0–100 where 100 = best.
//   Lower-is-better metrics (EUI, cost/sqft, demand intensity) are inverted:
//   score = 100 × (1 − value / max_in_project)
//   Higher-is-better metrics (savings%, load factor, ENERGY STAR) are scaled
//   directly to 0–100.
//
// Tooltips show the raw (un-normalised) actual value for each building/axis.
// Building selector checkboxes let the user toggle buildings on/off.
function renderBldgComparisonPanel(content, bldgs, projName, projId) {
  // ── Colour palette — 8 distinct colours, cycling if >8 buildings ──
  const PALETTE = [
    'rgba(59,130,246,1)', // blue
    'rgba(249,115,22,1)', // orange
    'rgba(16,185,129,1)', // green
    'rgba(139,92,246,1)', // violet
    'rgba(244,63,94,1)', // rose
    'rgba(20,184,166,1)', // teal
    'rgba(234,179,8,1)', // yellow
    'rgba(168,85,247,1)', // purple
  ];
  const AXES = ['EUI', 'Cost/sqft', 'Savings %', 'Load Factor', 'ENERGY STAR', 'Demand/sqft'];

  if (!bldgs.length) {
    content.innerHTML =
      '<div style="padding:20px;font-size:13px;color:var(--text2)">No buildings in this project yet.</div>';
    return;
  }

  // ── Gather raw metrics per building ──────────────────────────────────────
  const rawMetrics = bldgs.map((b) => {
    const sqft = parseFloat(b.sqft || 0);
    const meters = (b.meters || []).filter((m) => m.baselineInclude !== false);

    // Collect trailing-12-month bills per commodity
    let totalCost = 0,
      kwh12 = 0,
      gas12 = 0,
      prop12 = 0;
    let peakKW = 0;
    let loadFactorSum = 0,
      loadFactorCount = 0;

    const now = new Date();
    const cutoffYm = (() => {
      const d = new Date(now.getFullYear(), now.getMonth() - 12, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    meters.forEach((m) => {
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const incl = m.inclusive !== false;
      const isElec = m.commodity === 'Electric';
      const isGas = m.commodity === 'Gas';
      const isProp = m.commodity === 'Propane';

      // Use getNormRows to get trailing-12-month normalised rows
      const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
      // trailing 12 months
      const t12 = allRows.slice(-12);
      t12.forEach((r) => {
        totalCost += r.cost || 0;
        if (isElec) {
          kwh12 += r.usage || 0;
          // load factor: kWh / (demandKW × 24 × days)
          const rowBills = bills.filter((b2) => normMonth(b2.start, b2.end, incl, bills) === r.ym);
          rowBills.forEach((bill) => {
            const kw = parseFloat(bill.demandKW || 0);
            const days = parseFloat(bill.days || 30);
            if (kw > 0 && days > 0 && r.usage > 0) {
              const lf = r.usage / (kw * 24 * days);
              if (lf > 0 && lf <= 1.5) {
                loadFactorSum += lf;
                loadFactorCount++;
              }
            }
            const demKW = parseFloat(bill.demandKW || 0);
            if (demKW > peakKW) peakKW = demKW;
          });
        }
        if (isGas) gas12 += r.usage || 0;
        if (isProp) prop12 += r.usage || 0;
      });
    });

    // EUI — site kBtu/sqft/yr (rolling 12 months annualised)
    const siteKBtu = computeKBtu(kwh12, gas12, prop12);
    const eui = sqft > 0 && siteKBtu > 0 ? ((siteKBtu / 12) * 12) / sqft : null;

    // Cost / sqft — annual
    const costPerSqft = sqft > 0 && totalCost > 0 ? totalCost / sqft : null;

    // Savings % — aggregate across all meters with baselines
    let totalBlCost = 0,
      totalActSav = 0;
    meters.forEach((m) => {
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const incl = m.inclusive !== false;
      const bl = m.baseline || (m.baselines && m.baselines[0]);
      if (!bl || !bl.months || bl.months.length < 3) return;
      const savResult = getMeterSavings(m, bills, incl, projId, b.id);
      const savVals = Object.values(savResult.byYM || {});
      totalActSav += savVals.reduce((s, v) => s + v, 0);
      // Baseline cost: average monthly × 12
      const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
      const blRows = allRows.filter((r) => bl.months.includes(r.ym));
      const { elecByMo: eM, gasByMo: gM, propaneByMo: pM, waterByMo: wM } = buildMoMap(m, blRows, bills, incl);
      for (let mo = 0; mo < 12; mo++)
        totalBlCost += (eM[mo]?.totalCost || 0) + (gM[mo]?.cost || 0) + (pM[mo]?.cost || 0) + (wM[mo]?.cost || 0);
    });
    const savingsPct = totalBlCost > 0 ? (totalActSav / totalBlCost) * 100 : null;

    // Load factor — average of trailing-12 monthly values
    const loadFactor = loadFactorCount > 0 ? loadFactorSum / loadFactorCount : null;

    // ENERGY STAR estimate (source EUI, K-12 table)
    const srcEui = typeof computeSourceEUI === 'function' ? computeSourceEUI(kwh12, gas12, prop12, sqft) : 0;
    const energyStar =
      srcEui > 0 && typeof estimateEnergyStarScore === 'function' ? estimateEnergyStarScore(srcEui) : null;

    // Demand intensity — peak kW / sqft
    const demandIntensity = sqft > 0 && peakKW > 0 ? peakKW / sqft : null;

    return {
      name: b.name || 'Building',
      sqft,
      eui,
      costPerSqft,
      savingsPct,
      loadFactor,
      energyStar,
      demandIntensity,
    };
  });

  // ── Normalise to 0–100 per axis ───────────────────────────────────────────
  function maxOf(key) {
    const vals = rawMetrics.map((r) => r[key]).filter((v) => v != null && isFinite(v));
    return vals.length ? Math.max(...vals) : 1;
  }
  function minOf(key) {
    const vals = rawMetrics.map((r) => r[key]).filter((v) => v != null && isFinite(v));
    return vals.length ? Math.min(...vals) : 0;
  }

  const maxEui = maxOf('eui') || 1;
  const maxCost = maxOf('costPerSqft') || 1;
  const maxDemI = maxOf('demandIntensity') || 1;
  const maxLF = maxOf('loadFactor') || 1;

  function norm(raw, key) {
    if (raw == null || !isFinite(raw)) return 0;
    switch (key) {
      case 'eui':
        return Math.max(0, Math.min(100, 100 * (1 - raw / maxEui)));
      case 'costPerSqft':
        return Math.max(0, Math.min(100, 100 * (1 - raw / maxCost)));
      case 'savingsPct':
        return Math.max(0, Math.min(100, raw)); // already 0–100
      case 'loadFactor':
        return Math.max(0, Math.min(100, raw * 100)); // 0–1 → 0–100
      case 'energyStar':
        return Math.max(0, Math.min(100, raw)); // already 1–99
      case 'demandIntensity':
        return Math.max(0, Math.min(100, 100 * (1 - raw / maxDemI)));
      default:
        return 0;
    }
  }

  const datasets = rawMetrics.map((r, i) => {
    const color = PALETTE[i % PALETTE.length];
    const fill = color.replace('1)', '0.18)');
    return {
      label: r.name,
      data: [
        norm(r.eui, 'eui'),
        norm(r.costPerSqft, 'costPerSqft'),
        norm(r.savingsPct, 'savingsPct'),
        norm(r.loadFactor, 'loadFactor'),
        norm(r.energyStar, 'energyStar'),
        norm(r.demandIntensity, 'demandIntensity'),
      ],
      borderColor: color,
      backgroundColor: fill,
      pointBackgroundColor: color,
      pointBorderColor: '#1a2130',
      pointRadius: 5,
      borderWidth: 2,
      _raw: r, // store raw for tooltips
    };
  });

  // ── Build selector HTML ───────────────────────────────────────────────────
  const selectorRows = rawMetrics
    .map((r, i) => {
      const color = PALETTE[i % PALETTE.length];
      const fmtEui = r.eui != null ? r.eui.toFixed(1) + ' kBtu/sf' : '—';
      const fmtCost = r.costPerSqft != null ? '$' + r.costPerSqft.toFixed(2) + '/sf' : '—';
      const fmtSav = r.savingsPct != null ? (r.savingsPct >= 0 ? '+' : '') + r.savingsPct.toFixed(1) + '%' : '—';
      const fmtLF = r.loadFactor != null ? (r.loadFactor * 100).toFixed(0) + '%' : '—';
      const fmtES = r.energyStar != null ? '~' + r.energyStar : '—';
      const fmtDem = r.demandIntensity != null ? r.demandIntensity.toFixed(4) + ' kW/sf' : '—';
      return `<tr>
      <td style="padding:5px 8px;white-space:nowrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" data-bldg-idx="${i}" checked
            style="accent-color:${color};width:14px;height:14px">
          <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${color};flex-shrink:0"></span>
          <span style="font-size:12px;font-weight:600;color:var(--text)">${r.name}</span>
        </label>
      </td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:var(--text2);text-align:right">${fmtEui}</td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:var(--text2);text-align:right">${fmtCost}</td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:${r.savingsPct != null && r.savingsPct >= 0 ? 'var(--em)' : 'var(--danger)'};text-align:right">${fmtSav}</td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:var(--text2);text-align:right">${fmtLF}</td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:var(--text2);text-align:right">${fmtES}</td>
      <td style="padding:5px 8px;font-size:11px;font-family:var(--mono);color:var(--text2);text-align:right">${fmtDem}</td>
    </tr>`;
    })
    .join('');

  const thS2 =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);background:var(--s1);border-bottom:1px solid var(--border);text-align:right;white-space:nowrap';

  content.innerHTML = `
    <div style="padding:14px 18px 10px;background:var(--s2);border-bottom:1px solid var(--border)">
      <div style="font-size:14px;font-weight:800;font-family:var(--head);color:var(--em);margin-bottom:4px">🕸 ${projName} — Building Comparison</div>
      <div style="font-size:11px;color:var(--text3)">Radar chart — all axes normalised 0–100 (100 = best). Hover for actual values.</div>
    </div>
    <div style="display:flex;gap:0;flex-wrap:wrap">
      <div style="flex:1;min-width:320px;padding:18px 22px 18px 18px">
        <div style="position:relative;height:380px"><canvas id="bldgCompareRadarChart"></canvas></div>
      </div>
      <div style="flex:0 0 auto;padding:14px 18px;border-left:1px solid var(--border);overflow-x:auto">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">Select / Deselect Buildings</div>
        <table style="border-collapse:collapse;min-width:480px">
          <thead><tr>
            <th style="${thS2.replace('text-align:right', 'text-align:left')}">Building</th>
            <th style="${thS2}">EUI</th>
            <th style="${thS2}">$/sqft</th>
            <th style="${thS2}">Savings</th>
            <th style="${thS2}">Load Factor</th>
            <th style="${thS2}">ENERGY STAR</th>
            <th style="${thS2}">Dem/sqft</th>
          </tr></thead>
          <tbody id="bldgCompareRows">${selectorRows}</tbody>
        </table>
        <div style="margin-top:10px;font-size:10px;color:var(--text3);line-height:1.5">
          EUI: lower is better &nbsp;|&nbsp; $/sqft: lower is better &nbsp;|&nbsp; Savings: higher is better<br>
          Load Factor: higher is better &nbsp;|&nbsp; ENERGY STAR: higher is better &nbsp;|&nbsp; Dem/sqft: lower is better
        </div>
      </div>
    </div>`;

  // ── Render radar chart ────────────────────────────────────────────────────
  requestAnimationFrame(() => {
    const cv = document.getElementById('bldgCompareRadarChart');
    if (!cv) return;
    if (_maCharts['bldgCompareRadar']) _maCharts['bldgCompareRadar'].destroy();
    _maCharts['bldgCompareRadar'] = new Chart(cv, {
      type: 'radar',
      data: { labels: AXES, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: {
              stepSize: 25,
              color: 'rgba(180,200,220,.6)',
              font: { size: 9 },
              backdropColor: 'transparent',
            },
            grid: { color: 'rgba(255,255,255,.1)' },
            angleLines: { color: 'rgba(255,255,255,.15)' },
            pointLabels: { color: 'rgba(200,220,240,.9)', font: { size: 12, weight: '600' } },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              color: 'rgba(200,220,240,.9)',
              font: { size: 11 },
              boxWidth: 14,
              padding: 14,
            },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const raw = ctx.dataset._raw;
                if (!raw) return ctx.dataset.label + ': ' + ctx.parsed.r.toFixed(0);
                const axis = AXES[ctx.dataIndex];
                let actual = '—';
                switch (axis) {
                  case 'EUI':
                    actual = raw.eui != null ? raw.eui.toFixed(1) + ' kBtu/sf/yr' : '—';
                    break;
                  case 'Cost/sqft':
                    actual = raw.costPerSqft != null ? '$' + raw.costPerSqft.toFixed(2) + '/sf' : '—';
                    break;
                  case 'Savings %':
                    actual = raw.savingsPct != null ? raw.savingsPct.toFixed(1) + '%' : '—';
                    break;
                  case 'Load Factor':
                    actual = raw.loadFactor != null ? (raw.loadFactor * 100).toFixed(0) + '%' : '—';
                    break;
                  case 'ENERGY STAR':
                    actual = raw.energyStar != null ? '~' + raw.energyStar : '—';
                    break;
                  case 'Demand/sqft':
                    actual = raw.demandIntensity != null ? raw.demandIntensity.toFixed(4) + ' kW/sf' : '—';
                    break;
                }
                return (
                  ' ' + ctx.dataset.label + ' — ' + axis + ': ' + actual + ' (score ' + ctx.parsed.r.toFixed(0) + ')'
                );
              },
            },
          },
        },
      },
    });

    // ── Checkbox toggling ─────────────────────────────────────────────────
    const tbody = document.getElementById('bldgCompareRows');
    if (tbody) {
      tbody.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb || cb.type !== 'checkbox') return;
        const idx = parseInt(cb.dataset.bldgIdx);
        const chart = _maCharts['bldgCompareRadar'];
        if (!chart) return;
        const meta = chart.getDatasetMeta(idx);
        meta.hidden = !cb.checked;
        chart.update();
      });
    }
  });
}

/* ── RENDER RIGHT DETAIL: Building header + Meters ── */
/* ── ACTIVE METER WORKSPACE STATE ── */
let udActiveMid = null;
const _udActiveMids = {}; // per-container active meter: keyed by wrap element id

function _getActiveMid(wrap) {
  if (!wrap || wrap === document.getElementById('udDetailWrap')) return udActiveMid;
  return _udActiveMids[wrap.id] !== undefined ? _udActiveMids[wrap.id] : udActiveMid;
}
function _setActiveMid(wrap, mid) {
  if (!wrap || wrap === document.getElementById('udDetailWrap')) {
    udActiveMid = mid;
    return;
  }
  _udActiveMids[wrap.id] = mid;
}
let udActiveTab = 'bills';
let udNormMode = 'date'; // 'date' | 'weather'
let udNormMetric = 'total'; // 'perday' | 'total' | 'weather'  (chart Y-axis in Norm tab) — default monthly
let udNormChartVis = true; // chart visible in Norm tab
let udBlChartVis = true; // chart visible in Baseline tab
let udBlMetric = 'total'; // 'perday' | 'total' — baseline chart metric, default monthly
let udBlOverlay = false; // overlay raw bill data on baseline chart
let _perfMetric = 'total'; // 'perday' | 'total' — perf chart metric, default monthly
let _perfOverlay = false; // overlay raw bill data on perf chart
let _perfChartVis = true; // perf chart visible
let _perfWeatherMode = 'actual'; // 'actual' | 'normal' — weather mode for expected usage (Update a1f2b3c4)
let _regressionPanelVis = false; // show/hide regression coefficients panel in Norm tab
let _maCharts = {};

function renderUDDetail(targetWrap) {
  const wrap = targetWrap || document.getElementById('udDetailWrap');
  window._udActiveWrap = wrap; // always track which wrap is being rendered into
  const hdr = targetWrap ? null : document.getElementById('udDetailHdr');
  const hdrTitle = targetWrap ? null : document.getElementById('udDetailHdrTitle');
  const hdrSub = targetWrap ? null : document.getElementById('udDetailHdrSub');
  if (!wrap) return;
  window._udSelBldgId = udSelBldgId;

  if (!udSelBldgId || !udSelProjId) {
    if (hdr) hdr.style.display = 'none';
    const bar = document.getElementById('udProjPanelBar');
    if (bar && !udSelProjId) bar.style.display = 'none';
    wrap.innerHTML = udSelProjId
      ? '<div class="ud-empty"><div class="ud-empty-ico">🏢</div><div>Select a building from the left to view meters</div></div>'
      : '<div class="ud-empty"><div class="ud-empty-ico">📁</div><div>Select a project and building<br>from the left to view meters</div></div>';
    return;
  }
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) {
    wrap.innerHTML = '<div class="ud-empty">Building not found</div>';
    return;
  }

  if (hdr) hdr.style.display = 'flex';
  if (hdrTitle) hdrTitle.textContent = b.name;
  _bldgStatsPanelVis = false;
  _bldgPerfPanelVis = false;
  _bldgSavProjPanelVis = false;
  const bsBtn = document.getElementById('ud-bldg-stats-btn');
  if (bsBtn) {
    bsBtn.style.borderColor = '';
    bsBtn.style.color = '';
  }
  const bpBtn = document.getElementById('ud-bldg-perf-btn');
  if (bpBtn) {
    bpBtn.style.borderColor = '';
    bpBtn.style.color = '';
  }
  const spBtn = document.getElementById('ud-bldg-savproj-btn');
  if (spBtn) {
    spBtn.style.borderColor = '';
    spBtn.style.color = '';
  }
  if (hdrSub) {
    const parts = [];
    if (b.addr) parts.push('<span>📍 ' + b.addr + '</span>');
    if (b.zip) parts.push('<span>📮 ' + b.zip + '</span>');
    if (b.sqft) parts.push('<span>📐 ' + Number(b.sqft).toLocaleString() + ' sq ft</span>');
    const meters = b.meters || [];
    parts.push('<span>⚡ ' + meters.length + ' meter' + (meters.length !== 1 ? 's' : '') + '</span>');
    hdrSub.innerHTML = parts.join('');
  }

  const meters = (b.meters || []).filter((m) => isShownCommodity(udSelProjId, m.commodity));
  if (!meters.length) {
    wrap.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">⚡</div><div>No meters yet.<br><button class="btn btn-em btn-sm" style="margin-top:12px" onclick="openMeterModal(null,\'' +
      udSelProjId +
      "','" +
      udSelBldgId +
      '\')">+ Add Meter</button></div></div>';
    return;
  }

  // Use per-container active mid so standalone and embed don't share state
  let _curMid = _getActiveMid(wrap);
  if (!_curMid || !meters.find((m) => m.id === _curMid)) {
    _curMid = meters[0].id;
    _setActiveMid(wrap, _curMid);
  }
  if (wrap === document.getElementById('udDetailWrap')) udActiveMid = _curMid;
  else udActiveMid = _curMid; // temporarily set global so renderMeterWorkspace works

  const pills =
    meters
      .map((m) => {
        const active = m.id === _curMid;
        const bcount = (m.bills || []).length;
        // Count active (non-dismissed) flags across all bills on this meter.
        // Update 94abf6d6: live _analyzeMeterBills result; _flags only for dismissed IDs
        // and cross-meter flags (waterSewerParity_warn).
        const _mBillsList = m.bills || [];
        const _mLiveFlags =
          typeof _analyzeMeterBills === 'function' && _mBillsList.length >= 4
            ? _analyzeMeterBills(
                _mBillsList.slice().sort((a, b) => _parseISO(a.start) - _parseISO(b.start)),
                m,
              )
            : {};
        const _mFlagCount = _mBillsList.reduce((sum, bill) => {
          const _dismissed = new Set(
            Array.isArray(bill._flags) ? bill._flags.filter((f) => f.dismissed).map((f) => f.id) : [],
          );
          const liveCount = (_mLiveFlags[bill.id] || []).filter((f) => {
            const fId = (f.field || 'unknown') + '_' + (f.level || 'warn');
            return !_dismissed.has(fId);
          }).length;
          const crossMeterCount = Array.isArray(bill._flags)
            ? bill._flags.filter((f) => f.id === 'waterSewerParity_warn' && !f.dismissed).length
            : 0;
          return sum + liveCount + crossMeterCount;
        }, 0);
        const _pClsMap = {
          Electric: ' elec-pill',
          Gas: ' gas-pill',
          Water: ' water-pill',
          Sewer: ' sewer-pill',
          Stormwater: ' storm-pill',
        };
        const _pCls = _pClsMap[m.commodity] || '';
        const _pTxtMap = {
          Electric: '#7dd8ff',
          Gas: '#ffb040',
          Water: '#38bdf8',
          Sewer: '#a78bfa',
          Stormwater: '#9ca3af',
        };
        const _pTxt = _pTxtMap[m.commodity] || 'var(--text2)';
        const _exclTag =
          m.baselineInclude === false
            ? '<span style="font-size:8px;font-weight:700;color:var(--danger,#ef4444);background:rgba(239,68,68,.15);padding:1px 4px;border-radius:3px;margin-left:2px" title="Excluded from baseline &amp; performance">excl</span>'
            : '';
        const _blTag =
          m.baseline && m.baseline.months && m.baseline.months.length > 0
            ? '<span style="font-size:8px;font-weight:700;color:#22c55e;background:rgba(34,197,94,.15);padding:1px 4px;border-radius:3px;margin-left:2px" title="Baseline set">BL</span>'
            : '';
        const _flagTag =
          _mFlagCount > 0
            ? '<span style="font-size:8px;font-weight:700;color:var(--amber);background:rgba(245,158,11,.12);padding:1px 4px;border-radius:3px;margin-left:2px" title="' +
              _mFlagCount +
              ' bill flag' +
              (_mFlagCount !== 1 ? 's' : '') +
              ' need review">⚠ ' +
              _mFlagCount +
              '</span>'
            : '';
        // Fix 67cb827d (secondary): ensure m._reg is populated for R² scoring
        // in the pill badge — same root cause as renderMeterDataPane fix.
        // getNormRows sets m._reg transiently; without it, computeMeterQualityScore
        // scores R² as 0/25 for meters with inherited baselines (m.baseline.reg = null).
        if (typeof getNormRows === 'function' && typeof getWeatherForBuilding === 'function') {
          const { byYm: _pillWeather } = getWeatherForBuilding();
          const _pillBills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
          if (_pillBills.length) getNormRows(m, _pillBills, m.inclusive !== false, _pillWeather);
        }
        var _dq = typeof computeMeterQualityScore === 'function' ? computeMeterQualityScore(m) : null;
        var _dqBadge = _dq ? getMeterQualityBadge(_dq.score) : null;
        var _dqTag = _dqBadge
          ? '<span style="background:' +
            _dqBadge.bgColor +
            ';color:' +
            _dqBadge.textColor +
            ';padding:1px 6px;border-radius:8px;font-size:11px;font-weight:700;margin-left:4px" title="Data Quality: ' +
            _dq.score +
            '/100 — ' +
            qualityBreakdownTooltip(_dq) +
            '">' +
            _dqBadge.label +
            '</span>'
          : '';
        return (
          '<button class="ma-meter-pill' +
          _pCls +
          (active ? ' active' : '') +
          '" onclick="udSelectMeter(\'' +
          m.id +
          '\',this)">' +
          commodityPill(m.commodity) +
          (m.provider
            ? '<span style="font-size:9px;color:var(--text3);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
              m.provider.replace(/City of /i, '').replace(/ Company$/i, '') +
              '</span>'
            : '') +
          '<span style="font-size:11px;color:var(--text3)">' +
          bcount +
          ' bill' +
          (bcount !== 1 ? 's' : '') +
          '</span>' +
          _exclTag +
          _blTag +
          _flagTag +
          _dqTag +
          '</button>'
        );
      })
      .join('') +
    // Add Meter pill sits directly after the existing meter pills so users don't
    // have to hunt for the add button in the header bar.
    '<button class="ma-meter-pill ma-add-meter-pill" onclick="openMeterModal(null,\'' +
    udSelProjId +
    "','" +
    udSelBldgId +
    '\')" title="Add a new meter to this building">' +
    '<span style="font-size:14px;font-weight:700;color:var(--em)">+</span>' +
    '<span style="font-size:12px;font-weight:600;color:var(--em)">Add Meter</span>' +
    '</button>';

  wrap.innerHTML =
    '<div class="ma-meter-bar">' +
    '<div class="ma-meter-pills">' +
    pills +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-shrink:0">' +
    '<button class="btn btn-ghost btn-sm" onclick="openAuditLogModal()" title="View change history">📋 History</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="openMeterModal(\'' +
    udActiveMid +
    "','" +
    udSelProjId +
    "','" +
    udSelBldgId +
    '\')">✏️ Edit</button>' +
    '<button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteAllBills(\'' +
    udActiveMid +
    "','" +
    udSelProjId +
    "','" +
    udSelBldgId +
    '\')" title="Delete all bills in this meter">🗑 Clear Bills</button>' +
    '<button class="btn-del" onclick="deleteMeter(\'' +
    udActiveMid +
    "','" +
    udSelProjId +
    "','" +
    udSelBldgId +
    '\')" title="Delete meter">✕</button>' +
    '</div>' +
    '</div>' +
    '<div id="maMeterWorkspace"></div>';

  renderMeterWorkspace();
}

function _resolveEmbedContext(el) {
  // When called from a Projects-embed meter/tab, set the correct proj/bldg context
  if (!el) return null;
  const ws = el.closest('[id^="proj-ud-body"]') || el.closest('#udDetailWrap');
  if (!ws) return null;
  window._udActiveWrap = ws;
  const m = ws.id && ws.id.match(/^proj-ud-body-(\d+)$/);
  if (m) {
    const pid = Number(m[1]);
    udSelProjId = pid;
    udSelBldgId = projUDSelBldg[pid] || udSelBldgId;
  }
  return ws;
}
function udSelectMeter(mid, el) {
  const ws = _resolveEmbedContext(el);
  if (ws) _setActiveMid(ws, mid);
  udActiveMid = mid;
  udActiveTab = 'bills';
  _bldgStatsPanelVis = false;
  _bldgPerfPanelVis = false;
  _bldgSavProjPanelVis = false;
  saveUDSession();
  const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
  renderUDDetail(isEmbed ? window._udActiveWrap : undefined);
}
function maSetTab(tab, el) {
  udActiveTab = tab;
  saveUDSession();
  _resolveEmbedContext(el);
  renderMeterWorkspace();
}

let _bldgStatsPanelVis = false;
let _bldgPerfPanelVis = false;
let _bldgSavProjPanelVis = false;

function toggleBldgStatsPanel() {
  _bldgStatsPanelVis = !_bldgStatsPanelVis;
  _bldgPerfPanelVis = false;
  const btn = document.getElementById('ud-bldg-stats-btn');
  if (btn) {
    btn.style.borderColor = _bldgStatsPanelVis ? 'var(--em)' : '';
    btn.style.color = _bldgStatsPanelVis ? 'var(--em)' : '';
  }
  const pbtn = document.getElementById('ud-bldg-perf-btn');
  if (pbtn) {
    pbtn.style.borderColor = '';
    pbtn.style.color = '';
  }
  if (_bldgStatsPanelVis) {
    const wrap = document.getElementById('udDetailWrap');
    if (!wrap) return;
    const b = getUDBldg(udSelProjId, udSelBldgId);
    if (!b) return;
    wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:12px 16px 0;flex-shrink:0">' +
      '<button class="btn btn-ghost btn-sm" onclick="toggleBldgStatsPanel()">← Back to Meters</button>' +
      '</div>' +
      '<div id="bldgStatsPaneInner" style="padding:0 16px 16px;overflow-y:auto;flex:1;min-height:0"></div>';
    renderBuildingStatsPane(document.getElementById('bldgStatsPaneInner'), b);
  } else {
    renderUDDetail();
  }
}

function toggleBldgPerfPanel() {
  _bldgPerfPanelVis = !_bldgPerfPanelVis;
  _bldgStatsPanelVis = false;
  _bldgSavProjPanelVis = false;
  const pbtn = document.getElementById('ud-bldg-perf-btn');
  if (pbtn) {
    pbtn.style.borderColor = _bldgPerfPanelVis ? 'var(--em)' : '';
    pbtn.style.color = _bldgPerfPanelVis ? 'var(--em)' : '';
  }
  const sbtn = document.getElementById('ud-bldg-stats-btn');
  if (sbtn) {
    sbtn.style.borderColor = '';
    sbtn.style.color = '';
  }
  const spbtn = document.getElementById('ud-bldg-savproj-btn');
  if (spbtn) {
    spbtn.style.borderColor = '';
    spbtn.style.color = '';
  }
  if (_bldgPerfPanelVis) {
    const wrap = document.getElementById('udDetailWrap');
    if (!wrap) return;
    const b = getUDBldg(udSelProjId, udSelBldgId);
    if (!b) return;
    wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:12px 16px 0;flex-shrink:0">' +
      '<button class="btn btn-ghost btn-sm" onclick="toggleBldgPerfPanel()">← Back to Meters</button>' +
      '</div>' +
      '<div id="bldgPerfPaneInner" style="padding:0 16px 16px;overflow-y:auto;flex:1;min-height:0"></div>';
    renderBldgPerfPane(document.getElementById('bldgPerfPaneInner'), b);
  } else {
    renderUDDetail();
  }
}

function toggleBldgSavProjPanel() {
  _bldgSavProjPanelVis = !_bldgSavProjPanelVis;
  _bldgStatsPanelVis = false;
  _bldgPerfPanelVis = false;
  const spbtn = document.getElementById('ud-bldg-savproj-btn');
  if (spbtn) {
    spbtn.style.borderColor = _bldgSavProjPanelVis ? 'var(--em)' : '';
    spbtn.style.color = _bldgSavProjPanelVis ? 'var(--em)' : '';
  }
  const sbtn = document.getElementById('ud-bldg-stats-btn');
  if (sbtn) {
    sbtn.style.borderColor = '';
    sbtn.style.color = '';
  }
  const pbtn = document.getElementById('ud-bldg-perf-btn');
  if (pbtn) {
    pbtn.style.borderColor = '';
    pbtn.style.color = '';
  }
  if (_bldgSavProjPanelVis) {
    const wrap = document.getElementById('udDetailWrap');
    if (!wrap) return;
    const b = getUDBldg(udSelProjId, udSelBldgId);
    if (!b) return;
    wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:12px 16px 0;flex-shrink:0">' +
      '<button class="btn btn-ghost btn-sm" onclick="toggleBldgSavProjPanel()">← Back to Meters</button>' +
      '</div>' +
      '<div id="bldgSavProjPaneInner" style="padding:0 16px 16px;overflow-y:auto;flex:1;min-height:0"></div>';
    const _b3 = getUDBldg(udSelProjId, udSelBldgId);
    if (_b3) {
      try {
        const _k = 'bldgsavproj_cfg_' + (_b3.id || _b3.name);
        const _c = DB.get(_k, {});
        delete _c.moBase;
        DB.set(_k, _c);
      } catch (e) {}
    }
    renderBldgSavProjPane(document.getElementById('bldgSavProjPaneInner'), b);
  } else {
    renderUDDetail();
  }
}

function renderMeterWorkspace() {
  const _wrap = window._udActiveWrap || document.getElementById('udDetailWrap');
  const ws = _wrap ? _wrap.querySelector('#maMeterWorkspace') : document.getElementById('maMeterWorkspace');
  if (!ws) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === udActiveMid);
  if (!m) return;
  const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const incl = m.inclusive !== false;

  const tabs = [
    { id: 'bills', label: '📋 Bills' },
    { id: 'norm', label: '🌡️ Normalized' },
    { id: 'baseline', label: '📊 Baseline' },
    { id: 'stats', label: '📈 Meter Data' },
    { id: 'perf', label: '💡 Meter Performance' },
    { id: 'pipeline', label: '🔀 Data Pipeline' },
  ];

  ws.innerHTML =
    '<div class="ma-tabs">' +
    tabs
      .map(
        (t) =>
          '<button class="ma-tab' +
          (t.id === udActiveTab ? ' active' : '') +
          '" onclick="maSetTab(\'' +
          t.id +
          '\',this)">' +
          t.label +
          '</button>',
      )
      .join('') +
    '</div>' +
    '<div id="maPane" style="padding:18px 20px;overflow-y:auto;"></div>';

  const pane = ws.querySelector('#maPane') || document.getElementById('maPane');
  // Reset pane styles — bills tab needs the pane to be a flex column so the inner
  // .bills-scroll-body gets flex:1 and its horizontal scrollbar lands at the bottom
  // of the visible area. min-width:0 on the pane is mandatory alongside min-height:0
  // so the bills-scroll-body can shrink below the table's intrinsic content width
  // and show its horizontal scrollbar instead of letting the table push the whole
  // column wider than .ud-layout can accommodate.
  if (udActiveTab === 'bills') {
    pane.style.cssText = 'display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;';
  } else {
    pane.style.cssText = 'display:block;padding:18px 20px;overflow-y:auto;';
  }
  if (udActiveTab === 'bills') renderBillsPane(pane, m, bills, incl);
  if (udActiveTab === 'norm') renderNormPane(pane, m, bills, incl);
  if (udActiveTab === 'baseline') renderBaselinePane(pane, m, bills, incl);
  if (udActiveTab === 'stats') renderMeterDataPane(pane, m, bills, incl);
  if (udActiveTab === 'perf') renderPerfPane(pane, m, bills, incl);
  if (udActiveTab === 'pipeline') renderPipelinePane(pane, m, bills, incl);
}

/* ══════════════════════════════════════════
         BILLS TAB
      ══════════════════════════════════════════ */
// normMonth, detectGap → moved to computations/normalization.js

// ── CONDENSED VIEW CATEGORIES (Update 90) ──
// In condensed view, the Bills data table collapses the per-line charge
// columns into aggregate "category" columns (kWh Cost, kW Cost, Other
// Charges, etc.) for an at-a-glance total breakdown. Detailed view keeps
// the full BILL_SCHEMA column set. Per-meter preference stored in
// DB['bills_view_state_' + meterId].
//
// Each entry: { label, type, w, compute?, key? }
//  - compute(row) returns the value to display
//  - key is an alternative — read row[key] directly (for totalCost)
const _pfBills = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
const CONDENSED_CATEGORIES = {
  Electric: [
    { label: 'Usage (kWh)', type: 'number', w: 110, compute: (r) => _pfBills(r.kwh) },
    {
      label: 'kWh Cost $',
      type: 'currency',
      w: 100,
      compute: (r) =>
        _pfBills(r.onPeakCost) +
        _pfBills(r.offPeakCost) +
        _pfBills(r.ecaCharge) +
        _pfBills(r.eerCharge) +
        _pfBills(r.ptsCharge),
    },
    {
      // Blended kWh rate — prefer stored rate from bill, fall back to computation
      label: 'kWh Rate $/kWh',
      type: 'rate',
      w: 110,
      compute: (r) => {
        const stored = getStoredRate(r, 'kwh');
        if (stored > 0) return stored;
        const cost =
          _pfBills(r.onPeakCost) +
          _pfBills(r.offPeakCost) +
          _pfBills(r.ecaCharge) +
          _pfBills(r.eerCharge) +
          _pfBills(r.ptsCharge);
        const kwh = _pfBills(r.kwh);
        return kwh > 0 ? cost / kwh : 0;
      },
    },
    { label: 'Actual kW', type: 'number', w: 90, compute: (r) => _pfBills(r.demandKW) },
    { label: 'Billed kW', type: 'number', w: 90, compute: (r) => _pfBills(r.billedKW) },
    { label: 'Facilities kW', type: 'number', w: 100, compute: (r) => _pfBills(r.facKW) },
    {
      label: 'kW Cost $',
      type: 'currency',
      w: 100,
      compute: (r) => _pfBills(r.demandCharge) + _pfBills(r.tdcCharge) + _pfBills(r.facilitiesCharge || r.facKWCost),
    },
    {
      // Blended kW rate = sum of kW charges / billed kW
      label: 'kW Rate $/kW',
      type: 'rate',
      w: 110,
      compute: (r) => {
        const cost = _pfBills(r.demandCharge) + _pfBills(r.tdcCharge) + _pfBills(r.facilitiesCharge || r.facKWCost);
        const kw = _pfBills(r.demandKW);
        return kw > 0 ? cost / kw : 0;
      },
    },
    {
      label: 'Other Charges $',
      type: 'currency',
      w: 120,
      compute: (r) =>
        _pfBills(r.customerCharge) +
        _pfBills(r.rkvaCharge) +
        _pfBills(r.taxExemptDelivery) +
        _pfBills(r.billOffset) +
        _pfBills(r.franchiseFee),
    },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
  Gas: [
    { label: 'Usage (CCF)', type: 'number', w: 100, compute: (r) => _pfBills(r.naturalGasCCF) },
    { label: 'Usage (Therms)', type: 'number', w: 110, compute: (r) => _pfBills(r.naturalGasTherms) },
    {
      label: 'Gas Cost $',
      type: 'currency',
      w: 100,
      compute: (r) => _pfBills(r.gasCharge) + _pfBills(r.fuelAdjustment),
    },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
  Water: [
    { label: 'Usage (gal)', type: 'number', w: 100, compute: (r) => _pfBills(r.waterUsage) },
    {
      label: 'Water Cost $',
      type: 'currency',
      w: 110,
      compute: (r) => _pfBills(r.waterCharge) + _pfBills(r.waterProtectionFee),
    },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
  Sewer: [
    { label: 'Usage (gal)', type: 'number', w: 100, compute: (r) => _pfBills(r.sewerUsage) },
    { label: 'Sewer Cost $', type: 'currency', w: 110, compute: (r) => _pfBills(r.sewerCharge) },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
  Stormwater: [
    { label: 'Stormwater Cost $', type: 'currency', w: 130, compute: (r) => _pfBills(r.stormWaterCharge) },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
  Propane: [
    { label: 'Usage (Gal)', type: 'number', w: 100, compute: (r) => _pfBills(r.gallonsDelivered) },
    { label: 'Unit Price $', type: 'currency', w: 100, compute: (r) => _pfBills(r.unitPrice) },
    {
      label: 'Subtotal $',
      type: 'currency',
      w: 100,
      compute: (r) => _pfBills(r.subtotal),
    },
    { label: 'Tax $', type: 'currency', w: 90, compute: (r) => _pfBills(r.tax) },
    { label: 'Total Cost $', type: 'currency', w: 110, key: 'totalCost' },
  ],
};
function _billsTableViewState(mid) {
  try {
    const s = DB.get('bills_view_state_' + mid);
    if (s && typeof s === 'object') {
      return {
        mode: s.mode === 'condensed' ? 'condensed' : 'detailed',
        hidden: Array.isArray(s.hidden) ? s.hidden : [],
        sortAsc: s.sortAsc !== false, // default ascending
      };
    }
  } catch (e) {}
  try {
    const s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    if (s.defaultTableSettings && typeof s.defaultTableSettings === 'object') {
      const d = s.defaultTableSettings;
      return {
        mode: d.mode === 'condensed' ? 'condensed' : 'detailed',
        hidden: Array.isArray(d.hidden) ? d.hidden : [],
        sortAsc: true,
      };
    }
  } catch (e) {}
  return { mode: 'detailed', hidden: [], sortAsc: true };
}
function toggleBillsTableSort(mid, evt) {
  const state = _billsTableViewState(mid);
  state.sortAsc = !state.sortAsc;
  _saveBillsTableViewState(mid, state);
  // Resolve the correct _udActiveWrap from the clicked element so embedded
  // project views find the right workspace (fixes stale tempDiv reference).
  if (evt && evt.target) _resolveEmbedContext(evt.target);
  udActiveMid = mid;
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}
function _saveBillsTableViewState(mid, state) {
  try {
    DB.set('bills_view_state_' + mid, state);
  } catch (e) {}
}

// Build the Bills-table Settings modal body for a given meter. Shows a
// Detailed/Condensed view toggle, then a checkbox list of every
// togglable column for that commodity + mode.
function openBillsTableSettings(mid) {
  // Resolve meter — search across all projects/buildings since the
  // sticky-header context may not be fully in scope (safer than relying
  // on udSelProjId/udSelBldgId for this popup).
  let meter = null;
  for (const p of projects || []) {
    const ud = utilityData && utilityData[p.id];
    if (!ud) continue;
    for (const bl of ud.buildings || []) {
      for (const mm of bl.meters || []) {
        if (mm.id === mid) {
          meter = mm;
          break;
        }
      }
      if (meter) break;
    }
    if (meter) break;
  }
  if (!meter) return;
  const state = _billsTableViewState(mid);
  // Togglable columns depend on mode.
  let items;
  if (state.mode === 'condensed' && CONDENSED_CATEGORIES[meter.commodity]) {
    // For Gas meters, only list the usage column that matches the meter's bill unit
    // so the settings modal doesn't offer a toggle for a column that won't appear.
    const _settingsBillUnit = meter.commodity === 'Gas' ? getMeterBillUnit(meter) : null;
    items = CONDENSED_CATEGORIES[meter.commodity]
      .filter((c) => {
        if (_settingsBillUnit === 'CCF' && c.label === 'Usage (Therms)') return false;
        if (_settingsBillUnit !== 'CCF' && _settingsBillUnit && c.label === 'Usage (CCF)') return false;
        return true;
      })
      .map((c) => ({
        key: c.label,
        label: c.label,
      }));
  } else {
    const SKIP = new Set([
      'start',
      'end',
      'numberOfDays',
      'utilityCompany',
      'customerName',
      'serviceAddress',
      'accountNumber',
      'meterNumber',
    ]);
    // For Gas meters in detailed mode, only list the usage column matching the
    // meter's bill unit so the settings modal doesn't show a toggle for a column
    // that won't appear in the table.
    const _detailSettingsBillUnit = meter.commodity === 'Gas' ? getMeterBillUnit(meter) : null;
    items = _billSchemaFor(meter.commodity)
      .filter((e) => {
        if (e.section || SKIP.has(e.key)) return false;
        if (_detailSettingsBillUnit && e.gasUnit === 'CCF' && _detailSettingsBillUnit !== 'CCF') return false;
        if (_detailSettingsBillUnit && e.gasUnit === 'Therms' && _detailSettingsBillUnit === 'CCF') return false;
        return true;
      })
      .map((e) => ({ key: e.key, label: e.label }));
  }
  const hiddenSet = new Set(state.hidden || []);
  const viewToggle = `
                <div class="bts-view-toggle">
                  <button class="bts-view-btn${state.mode === 'detailed' ? ' sel' : ''}" onclick="setBillsTableViewMode('${mid}','detailed')">Detailed</button>
                  <button class="bts-view-btn${state.mode === 'condensed' ? ' sel' : ''}" onclick="setBillsTableViewMode('${mid}','condensed')">Condensed</button>
                </div>
                <div class="bts-section-hdr">
                  Columns shown (${state.mode === 'condensed' ? 'condensed categories' : 'detailed fields'})
                </div>`;
  const rowsHtml = items
    .map(
      (it) =>
        `<label class="bts-row">
                      <input type="checkbox" data-key="${String(it.key).replace(/"/g, '&quot;')}" ${hiddenSet.has(it.key) ? '' : 'checked'}>
                      <span>${it.label}</span>
                    </label>`,
    )
    .join('');
  // Dynamic modal overlay — uses the site's existing .modal-bg/.modal
  // pattern so styling matches the rest of the app. Built on open,
  // destroyed on close to avoid stale state.
  const existing = document.getElementById('billsTableSettingsModal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'billsTableSettingsModal';
  overlay.className = 'modal-bg open';
  overlay.style.zIndex = '10000';
  overlay.setAttribute('onclick', 'if (event.target === this) closeBillsTableSettings();');
  overlay.innerHTML = `
                <div class="modal" style="width:480px;min-width:360px;max-height:80vh">
                  <div class="modal-hdr">
                    <span class="modal-title">⚙ Bills Table Settings</span>
                    <button class="modal-x" onclick="closeBillsTableSettings()">✕</button>
                  </div>
                  <div class="modal-body bts-modal-body" data-meter-id="${mid}">
                    ${viewToggle}
                    <div class="bts-rows-wrap">${rowsHtml}</div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
                      <button class="btn btn-ghost" onclick="resetBillsColumnWidths('${mid}')" title="Clear saved column widths so columns auto-fit to content">Reset Column Widths</button>
                      <div style="margin-left:auto;display:flex;gap:8px">
                        <button class="btn btn-ghost" onclick="closeBillsTableSettings()">Cancel</button>
                        <button class="btn btn-em" onclick="saveBillsTableSettings('${mid}')">Save</button>
                      </div>
                    </div>
                  </div>
                </div>`;
  document.body.appendChild(overlay);
}
function closeBillsTableSettings() {
  const el = document.getElementById('billsTableSettingsModal');
  if (el) el.remove();
}
// Called when the user clicks Detailed or Condensed inside the modal.
// We persist the mode change immediately and re-open the modal with the
// new mode's column list, so the user can fine-tune hidden columns
// against the view they're actually going to see.
function setBillsTableViewMode(mid, mode) {
  const state = _billsTableViewState(mid);
  state.mode = mode === 'condensed' ? 'condensed' : 'detailed';
  // Reset hidden list when switching modes — the key namespaces differ
  // (detailed uses schema keys, condensed uses category labels).
  state.hidden = [];
  _saveBillsTableViewState(mid, state);
  openBillsTableSettings(mid);
}
function saveBillsTableSettings(mid) {
  const body = document.querySelector('#billsTableSettingsModal .bts-modal-body');
  if (!body) return;
  const state = _billsTableViewState(mid);
  const hidden = [];
  body.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    if (!cb.checked) hidden.push(cb.getAttribute('data-key'));
  });
  state.hidden = hidden;
  _saveBillsTableViewState(mid, state);
  closeBillsTableSettings();
  // Re-render the meter's bills pane so the new column set shows.
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}

// Reset saved column widths for a meter's bills table so auto-fit recalculates
// on next render. Clears the bills_col_widths_<mid> DB key, closes
// the settings modal, and re-renders the workspace.
function resetBillsColumnWidths(mid) {
  DB.remove('bills_col_widths_' + mid);
  closeBillsTableSettings();
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}

function renderBillsPane(pane, m, bills, incl) {
  // Restore right column in case batch extraction left it hidden
  const _rc = document.getElementById('pdfRightCol');
  if (_rc && !window._pdfQueue) _rc.style.display = '';

  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';

  const normInfoTip = `<span style="position:relative;display:inline-block">
          <button class="norm-info-btn" onclick="toggleNormTip(this)" title="How is Norm. Month calculated?">ℹ️</button>
          <div class="norm-info-tooltip" id="normInfoTip-${m.id}">
            <strong>Normalized Month</strong><br>
            Each billing period is assigned to the calendar month that contains the majority of its billing days.
            For example, a bill from Jan 18 – Feb 17 spans more days in January, so it maps to <em>Jan</em>.
            This ensures each month in the Normalized and Baseline tabs represents a consistent calendar month
            without gaps or duplicates, regardless of when the utility reads the meter.
          </div>
        </span>`;

  // ── Sort direction (Update 122) ──
  // Read from viewState (bills_view_state_<mid>). Default ascending (oldest first).
  // toggleBillsTableSort() flips and re-renders.
  const viewState = _billsTableViewState(m.id);
  const sortAsc = viewState.sortAsc !== false;
  // bills arrives pre-sorted ascending from renderMeterWorkspace; reverse if descending.
  if (!sortAsc) bills = bills.slice().reverse();
  const sortArrow = sortAsc ? ' ↑' : ' ↓';
  const sortTitle = sortAsc
    ? 'Sorted oldest first — click to sort newest first'
    : 'Sorted newest first — click to sort oldest first';

  // ── Column definitions (Update 82, revised in Update 90) ──
  // Base columns (#, Norm. Month, Start, End, Days) come first. Norm. Month,
  // Start, and End are sticky-frozen to the left edge so they stay visible
  // during horizontal scroll. # is the leftmost non-sticky row-number column
  // (Fix 3113c062). Then commodity-dependent columns (detailed OR condensed —
  // see Update 90 view mode). Action column last, with a gear button
  // that opens the per-meter table settings modal.
  const COL_BASE = [
    // Fix 3113c062: row-number column — sticky so its 32px width is included
    // in the cumulative left offset before Norm Month. Narrow, non-resizable.
    { h: '#', a: '', w: 32, minW: 32, sticky: true },
    {
      h:
        `<span style="cursor:pointer;user-select:none" onclick="toggleBillsTableSort('${m.id}',event)" title="${sortTitle}">Norm. Month${sortArrow}</span> ` +
        normInfoTip,
      a: 'lbl',
      w: 110,
      minW: 100,
      sticky: true,
    },
    // Start/End widths must fit "12/31/2026" (10 chars) at the tabular
    // font — 105px minimum so saved resize widths can't clip dates.
    { h: 'Start', a: 'lbl', w: 105, minW: 105, sticky: true },
    { h: 'End', a: 'lbl', w: 105, minW: 105, sticky: true },
    { h: 'Days', a: '', w: 50 },
  ];
  // Fields whose value is already reflected in the base columns, or
  // whose text shape makes them unfit for a table cell. Kept in the
  // modal + schema so the user can still edit them; just hidden from
  // the table.
  const TABLE_SKIP_KEYS = new Set([
    'start',
    'end',
    'numberOfDays',
    'utilityCompany',
    'customerName',
    'serviceAddress',
    'accountNumber',
    'meterNumber',
    'deliveryDate',
  ]);
  const hiddenSet = new Set(viewState.hidden || []);
  // Condensed view: use CONDENSED_CATEGORIES[commodity] (falls back to
  // the detailed schema if no category map exists). Hidden toggles still
  // apply (user can hide individual category columns if desired).
  // Detailed view: use the full BILL_SCHEMA column set minus skips + hidden.
  // Total Cost gets rightSticky:true (Update 93) so it stays pinned to the
  // right edge alongside the Actions column.
  let COL_FIELDS;
  if (viewState.mode === 'condensed' && CONDENSED_CATEGORIES[m.commodity]) {
    // For Gas meters, only show the usage column that matches the meter's bill unit.
    // Bills store usage in either naturalGasCCF or naturalGasTherms depending on
    // what the utility actually bills in — show only the relevant column, not both.
    const billUnit = isGas ? getMeterBillUnit(m) : null;
    COL_FIELDS = CONDENSED_CATEGORIES[m.commodity]
      .filter((c) => {
        if (isGas && c.label === 'Usage (CCF)' && billUnit !== 'CCF') return false;
        if (isGas && c.label === 'Usage (Therms)' && billUnit === 'CCF') return false;
        return !hiddenSet.has(c.label);
      })
      .map((c) => ({
        h: c.label,
        a: c.type === 'text' || c.type === 'date' ? 'lbl' : '',
        w: c.w || 100,
        k: c.label,
        category: c,
        rightSticky: c.key === 'totalCost',
      }));
  } else {
    // For Gas meters in detailed view, only show the usage column that matches
    // the meter's bill unit (Therms or CCF) — both exist in BILL_SCHEMA.Gas so
    // we filter out the one that doesn't apply.
    const _detailBillUnit = isGas ? getMeterBillUnit(m) : null;
    const schemaForTable = _billSchemaFor(m.commodity).filter((e) => {
      if (e.section) return false;
      if (TABLE_SKIP_KEYS.has(e.key)) return false;
      if (hiddenSet.has(e.key)) return false;
      if (isGas && e.gasUnit === 'CCF' && _detailBillUnit !== 'CCF') return false;
      if (isGas && e.gasUnit === 'Therms' && _detailBillUnit === 'CCF') return false;
      return true;
    });
    COL_FIELDS = schemaForTable.map((e) => ({
      h: e.label + (e.type === 'currency' ? ' $' : ''),
      a: e.type === 'text' || e.type === 'date' ? 'lbl' : '',
      w: _billColumnWidth(e),
      k: e.key,
      entry: e,
      rightSticky: e.key === 'totalCost',
    }));
  }
  // When unit conversion is active, annotate usage column headers with
  // a tooltip showing the original bill unit (Task 3).
  if (_isConversionActive(m)) {
    const billUnit = getMeterBillUnit(m);
    const dispUnit = getMeterDisplayUnit(m);
    const convTip = `Converted from ${billUnit} to ${dispUnit}`;
    COL_FIELDS.forEach((c) => {
      const isUsageCol = c.entry
        ? _BILL_USAGE_KEYS.has(c.entry.key)
        : c.category &&
          c.category.type === 'number' &&
          /kwh|ccf|therm|usage|gallon/i.test(c.category.label) &&
          !/kw\b|rate|\$/i.test(c.category.label);
      if (isUsageCol) {
        c.h = `<span title="${convTip}">${c.h} ⇄</span>`;
      }
    });
  }
  // Action/settings column: gear icon + "Table Settings" label, full
  // cell is clickable (resize handle is a sibling div so clicks on the
  // 5px right edge still resize without triggering the modal).
  const COL_ACTION = [
    {
      h: `<div class="bts-header-btn" onclick="openBillsTableSettings('${m.id}')" title="Table Settings">
                        <span class="bts-icon">⚙</span>
                        <span class="bts-label">Table Settings</span>
                      </div>`,
      a: 'td-actions',
      w: 100,
      rightSticky: true,
    },
  ];
  const cols = [...COL_BASE, ...COL_FIELDS, ...COL_ACTION];

  const tblHead =
    `<thead><tr>` +
    cols
      .map((c, i) => {
        const classes = [c.a];
        if (c.sticky) classes.push('sticky-col');
        if (c.rightSticky) classes.push('sticky-col-right');
        return `<th class="${classes.filter(Boolean).join(' ')}" data-col="${i}">${c.h}<div class="col-resize-handle" data-col="${i}"></div></th>`;
      })
      .join('') +
    `</tr></thead>`;

  const colgroup = '';

  // ── Statistical analysis on saved bills ──
  // Always pass an ascending-sorted copy so the rate-anomaly trailing window
  // and YoY find() operate on chronological order regardless of the user's
  // display sort preference (newest-first reverses the array before this point).
  const billFlags = _analyzeMeterBills(
    bills.slice().sort((a, b) => _parseISO(a.start) - _parseISO(b.start)),
    m,
  );

  // Build rows with gap detection + outlier highlighting
  let tblBody = '';
  let flagCount = 0;
  // Build a dynamic field→column-index map from the cols array so flag
  // icons land on the right column even after Update 82 added new
  // commodity-aware columns. Column 0 = #, 1 = Norm Month, 2 = Start,
  // 3 = End, 4 = Days; field columns start at 5. `days` is always base column 4.
  // (Shifted by 1 from pre-Fix-3113c062 values due to new # column at index 0.)
  const fieldColMap = { days: 4 };
  cols.forEach((c, i) => {
    if (c.k) fieldColMap[c.k] = i;
  });
  const isPropaneMeter = (m.commodity || '').toLowerCase() === 'propane';
  bills.forEach((row, idx) => {
    if (idx > 0 && !isPropaneMeter) {
      // When sorted descending, the "previous" row in the display is chronologically later.
      // Swap prevEnd/curStart so gap detection always sees the earlier bill's end and
      // the later bill's start — same logic as ascending, just from the other direction.
      let prevEnd = sortAsc ? bills[idx - 1].end : row.end;
      let curStart = sortAsc ? row.start : bills[idx - 1].start;
      // Bug #17: Track whether we walked past empty-date rows to find a valid end date.
      // When true, the gap message will note that a row with missing dates was found.
      // Only walk backward in ascending mode — in descending mode prevEnd/curStart were
      // already swapped to chronological order, so the iteration direction differs.
      let _gapSkippedEmptyRows = false;
      if (sortAsc && (!prevEnd || !curStart)) {
        let pi = idx - 1;
        while (pi >= 0 && !bills[pi].end) {
          pi--;
          _gapSkippedEmptyRows = true;
        }
        prevEnd = pi >= 0 ? bills[pi].end : null;
      }
      // Bug #26: Detect overlap (prevEnd > curStart by more than 3 days) before gap check.
      // Overlap and gap are mutually exclusive — if periods overlap, the "days" column
      // may flag as out-of-norm but that doesn't tell the user WHY. Show a specific
      // overlap warning in amber (distinct from the red gap warning) so the issue is clear.
      if (prevEnd && curStart && (_parseISO(prevEnd) - _parseISO(curStart)) / (1000 * 60 * 60 * 24) > 3) {
        const overlapDays = Math.round((_parseISO(prevEnd) - _parseISO(curStart)) / (1000 * 60 * 60 * 24));
        tblBody += `<tr class="ud-bill-overlap-row"><td colspan="${cols.length}"><div class="ud-bill-overlap-msg">⚠ Overlapping billing periods — ${overlapDays} day${overlapDays !== 1 ? 's' : ''} of overlap between ${fmtDate(curStart)} and ${fmtDate(prevEnd)} (check for duplicate or incorrect dates)</div></td></tr>`;
      } else if (detectGap(prevEnd, curStart)) {
        // Bug #14: Always report the gap in chronological order (earlier date → later date)
        // regardless of whether the bills array is ascending or descending. The label
        // direction must match whichever date is actually earlier.
        const gapEarlier = _parseISO(prevEnd) <= _parseISO(curStart) ? prevEnd : curStart;
        const gapLater = _parseISO(prevEnd) <= _parseISO(curStart) ? curStart : prevEnd;
        const gapDays = Math.round(Math.abs(_parseISO(gapLater) - _parseISO(gapEarlier)) / (1000 * 60 * 60 * 24));
        const gapMonths = Math.round(gapDays / 30);
        // Bug #17: If we skipped over empty-date rows to find the valid end date, add a note
        // so the user knows there's a row with missing dates adjacent to this gap.
        const _emptyRowNote = _gapSkippedEmptyRows
          ? ' · ⚠ A row above has missing dates — delete it and re-extract the source PDF'
          : '';
        tblBody += `<tr class="ud-bill-gap-row"><td colspan="${cols.length}"><div class="ud-bill-gap-msg">⚠️ Gap in data — ${gapMonths > 1 ? '~' + gapMonths + ' months (' : ''}${gapDays} day${gapDays !== 1 ? 's' : ''}${gapMonths > 1 ? ')' : ''} missing between ${fmtDate(gapEarlier)} and ${fmtDate(gapLater)}${_emptyRowNote}</div></td></tr>`;
      }
    }
    // Live-compute wins (Update 94abf6d6): always use freshly-computed billFlags
    // from _analyzeMeterBills as the display source of truth.
    // bill._flags is consulted ONLY to read dismissed flag IDs so user dismissals
    // survive dataset changes without showing stale flags.
    // Cross-meter flags (waterSewerParity_warn) are written to bill._flags by
    // _analyzeWaterSewerParity / runBuildingValidation and are appended separately
    // since _analyzeMeterBills does not produce them.
    const liveFlagsRaw = billFlags[row.id] || [];
    const _dismissedIds = new Set(
      Array.isArray(row._flags) ? row._flags.filter((f) => f.dismissed).map((f) => f.id) : [],
    );
    const CROSS_METER_FLAG_IDS = ['waterSewerParity_warn'];
    const _crossMeterFlags = Array.isArray(row._flags)
      ? row._flags.filter((f) => CROSS_METER_FLAG_IDS.includes(f.id) && !f.dismissed)
      : [];
    const flags = [
      ...liveFlagsRaw
        .filter((f) => {
          const fId = (f.field || 'unknown') + '_' + (f.level || 'warn');
          return !_dismissedIds.has(fId);
        })
        .map((f) => ({
          field: f.field,
          msg: f.msg,
          level: f.level,
          _persistFlag: { id: (f.field || 'unknown') + '_' + (f.level || 'warn') },
        })),
      ..._crossMeterFlags.map((f) => ({
        field: (f.id || '').split('_').slice(0, -1).join('_') || f.id,
        msg: f.label,
        level: f.severity === 'error' ? 'error' : 'warn',
        _persistFlag: f,
      })),
    ];
    if (flags.length) flagCount++;
    let rowHtml = renderBillRow(row, m, incl, bills, cols, idx + 1);
    // Meter change and charge part indicators (icons only — onclick stays as showBillSplitPanel from renderBillRow)
    if (row.Meter1_ReadStart) {
      rowHtml = rowHtml.replace(
        /(<td class="norm-mon-cell[^"]*"[^>]*>)/,
        '$1<span title="Meter change" style="font-size:10px;margin-right:3px;opacity:0.7">⚡</span>',
      );
    }
    // Fix 8dade129: removed 💲 emoji injection from the Normalized Month cell —
    // the dollar-sign icon was misleading in a date column. Charge-parts detail
    // is still accessible via the row click → split panel.
    // Add amber background and colored flag badges for flagged rows
    if (flags.length) {
      const _flagTitle = flags
        .map((f) => f.msg)
        .join('; ')
        .replace(/"/g, '&quot;');
      // If the <tr> already has a class attribute, append to it; otherwise insert a new one
      if (/(<tr[^>]*)\sclass="/.test(rowHtml)) {
        rowHtml = rowHtml.replace(/(<tr[^>]*\sclass=")/, '$1bill-flagged ');
        rowHtml = rowHtml.replace(/(<tr)(\s)/, '$1 title="' + _flagTitle + '"$2');
      } else {
        rowHtml = rowHtml.replace(/(<tr)([ >])/, '$1 class="bill-flagged" title="' + _flagTitle + '"$2');
      }
      flags.forEach((f) => {
        if (f.field == null || fieldColMap[f.field] == null) return;
        const colIdx = fieldColMap[f.field];
        const _warnColLabel =
          {
            kwh: 'kWh',
            kwhCost: 'kWh Cost',
            demandKW: 'Demand kW',
            billedKW: 'Billed kW',
            kwCost: 'kW Cost',
            totalCost: 'Total Cost',
            days: 'Billing Days',
            therms: 'Therms',
            thermCost: 'Gas Charge',
            usage: 'Usage',
            cost: 'Cost',
            waterUsage: 'Water Usage',
            waterCharge: 'Water Charge',
            sewerCharge: 'Sewer Charge',
            stormWaterCharge: 'Stormwater Charge',
            gallonsDelivered: 'Gallons',
            readDifference: 'Read Difference',
            start: 'Start Date',
          }[f.field] ||
          f.field ||
          '';
        const _warnTip = (_warnColLabel ? _warnColLabel + ': ' : '') + f.msg;
        // Use red dot for errors, amber for warnings
        const _dotColor = f.level === 'error' ? 'var(--danger,#ef4444)' : 'var(--amber)';
        // Build dismiss onclick if the flag is persisted (has _persistFlag with an id)
        const _pf = f._persistFlag;
        const _dismissAttr = _pf
          ? ` onclick="event.stopPropagation();dismissBillFlag('${udSelProjId}','${udSelBldgId}','${m.id}','${row.id}','${_pf.id}','');return false;"`
          : '';
        const _dismissTip = _pf ? ' Click to dismiss.' : '';
        let tdCount = 0;
        rowHtml = rowHtml.replace(/<td([^>]*)>/g, (match, attrs) => {
          tdCount++;
          if (tdCount === colIdx + 1) {
            return `<td${attrs}><span title="${(_warnTip + _dismissTip).replace(/"/g, '&quot;')}" style="cursor:${_pf ? 'pointer' : 'help'};color:${_dotColor};font-size:10px;margin-right:3px;opacity:0.9;user-select:none"${_dismissAttr}>●</span>`;
          }
          return match;
        });
      });
    }
    // BAS Analysis button — shown when BAS trend data exists for this building
    // during the bill's date range.  Calls btOpenBillCorrelation in bas-trends.js.
    if (
      row.start &&
      row.end &&
      udSelBldgId &&
      typeof btHasBASDataForPeriod === 'function' &&
      btHasBASDataForPeriod(udSelProjId, udSelBldgId, row.start, row.end)
    ) {
      const _basOnClick = `event.stopPropagation();btOpenBillCorrelation('${udSelProjId}','${udSelBldgId}','${row.start}','${row.end}');return false;`;
      const _basBtn =
        `<button class="btn-edit" onclick="${_basOnClick}" title="View BAS trend analysis for this billing period" ` +
        `style="color:var(--green);font-size:11px;padding:2px 5px;">&#128200;</button>`;
      rowHtml = rowHtml.replace(/(<td class="td-actions[^"]*"[^>]*>)/, '$1' + _basBtn);
    }
    tblBody += rowHtml;
    if (row.Meter1_ReadStart) {
      const mtrId = 'meter-detail-' + row.id;
      const fmtMtr = (v) => {
        if (!v) return '—';
        const n = parseFloat(String(v).replace(/,/g, ''));
        return isNaN(n) ? v : n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
      };
      const mtrDetail =
        '<tr id="' +
        mtrId +
        '" style="display:none" class="meter-detail-row">' +
        '<td colspan="' +
        cols.length +
        '" style="padding:6px 12px;background:var(--s2)">' +
        '<table style="width:auto;border-collapse:collapse;font-size:12px;margin:2px 0">' +
        '<tr style="color:var(--text2);font-weight:600">' +
        '<td style="padding:2px 10px">Meter</td>' +
        '<td style="padding:2px 10px">Read Start</td>' +
        '<td style="padding:2px 10px">Read End</td>' +
        '<td style="padding:2px 10px">Start Read</td>' +
        '<td style="padding:2px 10px">End Read</td>' +
        '<td style="padding:2px 10px">Difference</td>' +
        '<td style="padding:2px 10px">Multiplier</td>' +
        '<td style="padding:2px 10px">kWh Used</td>' +
        '<td style="padding:2px 10px">KW Used</td>' +
        '<td style="padding:2px 10px">RKVA Used</td>' +
        '</tr>' +
        '<tr>' +
        '<td style="padding:2px 10px;font-weight:600">1</td>' +
        '<td style="padding:2px 10px">' +
        (row.Meter1_ReadStart || '—') +
        '</td>' +
        '<td style="padding:2px 10px">' +
        (row.Meter1_ReadEnd || '—') +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_StartRead) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_EndRead) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_ReadDiff) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_Multiplier) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_kWh) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_KW) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter1_RKVA) +
        '</td>' +
        '</tr>' +
        '<tr>' +
        '<td style="padding:2px 10px;font-weight:600">2</td>' +
        '<td style="padding:2px 10px">' +
        (row.Meter2_ReadStart || '—') +
        '</td>' +
        '<td style="padding:2px 10px">' +
        (row.Meter2_ReadEnd || '—') +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_StartRead) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_EndRead) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_ReadDiff) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_Multiplier) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_kWh) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_KW) +
        '</td>' +
        '<td style="padding:2px 10px">' +
        fmtMtr(row.Meter2_RKVA) +
        '</td>' +
        '</tr>' +
        '</table></td></tr>';
      tblBody += mtrDetail;
    }
    if (row._chargeParts && Object.keys(row._chargeParts).length) {
      const cpId = 'charge-detail-' + row.id;
      let cpRows = '';
      for (const [chargeField, parts] of Object.entries(row._chargeParts)) {
        const label = chargeField
          .replace(/([A-Z])/g, ' $1')
          .replace(/^ /, '')
          .replace(/Charge$/, '')
          .trim();
        cpRows +=
          '<tr style="color:var(--text2);font-weight:600"><td colspan="5" style="padding:4px 10px;border-top:1px solid var(--border)">' +
          label +
          '</td></tr>';
        parts.forEach((p, i) => {
          const fmtAmt =
            p.charge != null
              ? '$' +
                parseFloat(p.charge).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : '—';
          const fmtQty =
            p.qty != null
              ? parseFloat(p.qty).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
              : '—';
          const fmtRate =
            p.rate != null
              ? '$' + parseFloat(p.rate).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })
              : '—';
          cpRows +=
            '<tr><td style="padding:2px 10px;color:var(--text3)">(' +
            (i + 1) +
            ')</td><td style="padding:2px 10px;font-family:var(--mono)">' +
            fmtQty +
            '</td><td style="padding:2px 10px;font-family:var(--mono)">' +
            fmtRate +
            '</td><td style="padding:2px 10px;color:var(--text3)">' +
            (p.unit || '') +
            '</td><td style="padding:2px 10px;font-family:var(--mono);font-weight:600">' +
            fmtAmt +
            '</td></tr>';
        });
      }
      tblBody +=
        '<tr id="' +
        cpId +
        '" style="display:none" class="charge-detail-row"><td colspan="' +
        cols.length +
        '" style="padding:6px 12px;background:var(--s2)"><table style="width:auto;border-collapse:collapse;font-size:12px;margin:2px 0"><tr style="color:var(--text2);font-weight:600;font-size:10px"><td style="padding:2px 10px">#</td><td style="padding:2px 10px">Qty</td><td style="padding:2px 10px">Rate</td><td style="padding:2px 10px">Unit</td><td style="padding:2px 10px">Amount</td></tr>' +
        cpRows +
        '</table></td></tr>';
    }
  });
  // Empty terminator row with visible borders (Update 90) — gives the
  // table a clean bottom edge instead of blending into the scroll area.
  if (bills.length > 0) {
    tblBody +=
      '<tr class="ud-bill-empty-row">' +
      cols
        .map((c, i) => {
          const classes = [];
          if (c.sticky) classes.push('sticky-col');
          if (c.rightSticky) classes.push('sticky-col-right');
          const classAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
          const dataAttr =
            (c.sticky ? ' data-sticky="' + i + '"' : '') + (c.rightSticky ? ' data-sticky-right="' + i + '"' : '');
          return '<td' + classAttr + dataAttr + '>&nbsp;</td>';
        })
        .join('') +
      '</tr>';
  }

  if (bills.length === 0) {
    pane.innerHTML =
      '<div class="ma-csv-drop" onclick="openCsvImportForMeter(\'' +
      m.id +
      '\')" ondragover="event.preventDefault();this.classList.add(\'drag\')" ondragleave="this.classList.remove(\'drag\')" ondrop="udMeterDropHandler(event,\'' +
      m.id +
      '\')">' +
      '<div class="ma-csv-drop-title">📥 Drop CSV or PDF or click to import bill data</div>' +
      '<div class="ma-csv-drop-sub">CSV: one row per billing period · PDF: routes to PDF extraction</div>' +
      '</div>';
    return;
  }

  // Sticky header (frozen) — billing count + controls
  const stickyHdrInner =
    '<div class="bills-sticky-left">' +
    '<div class="bills-sticky-title">' +
    bills.length +
    ' Billing Period' +
    (bills.length !== 1 ? 's' : '') +
    (bills.length ? ' · ' + getDateRange(bills) : '') +
    ' </div>' +
    '<div class="bills-sticky-sub">Acct: ' +
    (m.account || '—') +
    ' · Meter: ' +
    (m.meter || '—') +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
    '<button class="btn btn-ghost btn-sm" onclick="openCsvImportForMeter(\'' +
    m.id +
    '\')">📥 Import more periods via CSV</button>' +
    '<div class="ud-incl-toggle">' +
    '<span style="font-size:11px;color:var(--text2)">Day calc:</span>' +
    '<button class="ud-incl-btn' +
    (incl ? ' sel' : '') +
    '" onclick="setMeterIncl(\'' +
    m.id +
    '\',true)">Inclusive</button>' +
    '<button class="ud-incl-btn' +
    (!incl ? ' sel' : '') +
    '" onclick="setMeterIncl(\'' +
    m.id +
    '\',false)">Exclusive</button>' +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="openExportModal(\'meter\',\'' +
    m.id +
    '\')" title="Export this meter\'s billing data">📤 Export</button>' +
    '<button class="btn btn-em btn-sm" onclick="openBillModal(\'' +
    m.id +
    '\')">+ Add Period</button>' +
    '<button id="vcm-toggle" class="btn btn-ghost btn-sm' +
    (_vcmActive ? ' active' : '') +
    '" onclick="toggleValueCorrectionMode()" title="Value Correction Mode — click numeric cells to correct values">✏️ Correct</button>' +
    '</div>';

  // Flag banner
  const flagBanner =
    flagCount > 0
      ? '<div style="padding:8px 14px;background:var(--amber-dim);border:1px solid rgba(245,158,11,.25);border-radius:6px;margin:8px 14px;font-size:12px;color:var(--amber);font-weight:500;display:flex;align-items:center;gap:8px">' +
        '<span>⚠</span><span>' +
        flagCount +
        ' billing period' +
        (flagCount !== 1 ? 's' : '') +
        ' flagged — values may be statistically out of range. Hover flagged rows for details.</span>' +
        '</div>'
      : '';

  // Layout: info bar (fixed) + header table (fixed) + scrolling body table
  // Single scrollable container — thead frozen via split-table, auto column sizing
  pane.innerHTML =
    '<div class="bills-sticky-hdr">' +
    stickyHdrInner +
    '</div>' +
    flagBanner +
    '<div class="bills-thead-wrap" id="billsTheadWrap" style="overflow-x:auto;flex-shrink:0;">' +
    '<table class="ud-bill-tbl" id="billsHdrTbl">' +
    tblHead +
    '</table>' +
    '</div>' +
    '<div class="bills-scroll-body" id="billsScrollBody">' +
    '<table class="ud-bill-tbl" id="billsBodyTbl">' +
    '<tbody>' +
    tblBody +
    '</tbody>' +
    '</table>' +
    '</div>';

  // VCM delegated click listener (Update a3a423eb) — single handler on the body table
  // so it survives re-renders and doesn't leak multiple listeners
  var vcmBodyTbl = pane.querySelector('#billsBodyTbl');
  if (vcmBodyTbl) {
    if (vcmBodyTbl._vcmHandler) vcmBodyTbl.removeEventListener('click', vcmBodyTbl._vcmHandler);
    vcmBodyTbl._vcmHandler = function (e) {
      if (!_vcmActive) return;
      var td = e.target.closest('td[data-vcm-field]');
      if (!td) return;
      e.stopPropagation(); // prevent row click (showBillSplitPanel)
      showVCMPopover(td);
    };
    vcmBodyTbl.addEventListener('click', vcmBodyTbl._vcmHandler);
    // Re-apply vcm-active class if mode was already on when table re-rendered
    if (_vcmActive) vcmBodyTbl.classList.add('vcm-active');
  }

  // After browser auto-sizes body table, copy column widths to header table so they align
  requestAnimationFrame(() => {
    const hdrTbl = pane.querySelector('#billsHdrTbl');
    const bodyTbl = pane.querySelector('#billsBodyTbl');
    const theadWrap = pane.querySelector('#billsTheadWrap');
    const scrollBody = pane.querySelector('#billsScrollBody');
    if (!hdrTbl || !bodyTbl || !scrollBody || !theadWrap) return;

    const storageKey = `bills_col_widths_${m.id}`;

    // Load saved widths, falling back to measured natural widths
    const firstRow = bodyTbl.querySelector('tbody tr:first-child');
    if (!firstRow) return;
    const rawWidths = Array.from(firstRow.querySelectorAll('td')).map((td) => td.getBoundingClientRect().width);
    if (!rawWidths.length) return;
    // Update b7e542eb: also measure header cell widths (in their own auto-layout
    // table) so that header text (e.g. "RATE SCHEDULE") sets the minimum — the
    // column can't be narrower than its header even if data values are short.
    const hdrRow = hdrTbl.querySelector('thead tr');
    const hdrWidths = hdrRow
      ? Array.from(hdrRow.querySelectorAll('th')).map((th) => th.getBoundingClientRect().width)
      : [];

    let savedWidths = null;
    try {
      const s = DB.get(storageKey);
      if (s) savedWidths = s;
    } catch (e) {}
    // Update 97: `minW` on a col is a hard floor that saved widths can't
    // undercut — ensures date columns (and any other structurally-wide
    // fields) can't be shrunk below readability by a stale resize save.
    // Update b7e542eb: removed `cols[i]?.w || 0` from the max calculation
    // so columns use their natural browser-measured content width instead
    // of being forced to the defined `w` default. This lets narrower
    // columns (Rate Schedule, Table Settings, etc.) shrink to fit their
    // actual content and frees up visible space for more data columns.
    // Column width = max(body cell, header cell, minW floor) — never the
    // arbitrary `w` hint that was padding columns wider than necessary.
    const widths = rawWidths.map((w, i) => {
      const floor = Math.max(40, cols[i]?.minW || 0);
      if (savedWidths && savedWidths[i]) return Math.max(floor, savedWidths[i]);
      const hdrW = hdrWidths[i] || 0;
      return Math.max(Math.ceil(w), Math.ceil(hdrW), floor);
    });

    function applyWidths(ws) {
      const cg = '<colgroup>' + ws.map((w) => `<col style="width:${w}px">`).join('') + '</colgroup>';
      // Remove existing colgroups first
      hdrTbl.querySelectorAll('colgroup').forEach((c) => c.remove());
      bodyTbl.querySelectorAll('colgroup').forEach((c) => c.remove());
      hdrTbl.insertAdjacentHTML('afterbegin', cg);
      bodyTbl.insertAdjacentHTML('afterbegin', cg);
      hdrTbl.style.tableLayout = 'fixed';
      bodyTbl.style.tableLayout = 'fixed';
      const totalW = ws.reduce((s, w) => s + w, 0);
      hdrTbl.style.width = totalW + 'px';
      bodyTbl.style.width = totalW + 'px';
      // Left-sticky columns (Update 90): compute cumulative left
      // offsets for cols flagged `sticky: true` (Norm Month / Start /
      // End) and apply them to every matching header + body cell.
      let cumLeft = 0;
      for (let i = 0; i < cols.length; i++) {
        if (!cols[i].sticky) continue;
        const w = ws[i];
        const hdrCell = hdrTbl.querySelector(`th[data-col="${i}"]`);
        if (hdrCell) hdrCell.style.left = cumLeft + 'px';
        bodyTbl.querySelectorAll(`td[data-sticky="${i}"]`).forEach((td) => {
          td.style.left = cumLeft + 'px';
        });
        cumLeft += w || 0;
      }
      // Right-sticky columns (Update 93): iterate BACKWARDS from the
      // last col, accumulating from the right edge. cols flagged
      // `rightSticky: true` (Total Cost + Actions) get their `right`
      // style set so they pin to the right edge during horizontal scroll.
      let cumRight = 0;
      for (let i = cols.length - 1; i >= 0; i--) {
        if (!cols[i].rightSticky) continue;
        const w = ws[i];
        const hdrCell = hdrTbl.querySelector(`th[data-col="${i}"]`);
        if (hdrCell) hdrCell.style.right = cumRight + 'px';
        bodyTbl.querySelectorAll(`td[data-sticky-right="${i}"]`).forEach((td) => {
          td.style.right = cumRight + 'px';
        });
        cumRight += w || 0;
      }
    }

    applyWidths(widths);

    // Sync horizontal scroll
    scrollBody.addEventListener(
      'scroll',
      () => {
        theadWrap.scrollLeft = scrollBody.scrollLeft;
      },
      { passive: true },
    );

    // ── Column resize drag — each column resizes independently, saves to DB ──
    let _resizing = null;
    pane.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.col-resize-handle');
      if (!handle) return;
      e.preventDefault();
      const colIdx = parseInt(handle.dataset.col);
      const hdrTh = hdrTbl.querySelector(`th[data-col="${colIdx}"]`);
      if (!hdrTh) return;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      _resizing = { colIdx, startX: e.clientX, startW: hdrTh.getBoundingClientRect().width, handle };
    });
    document.addEventListener(
      'mousemove',
      (e) => {
        if (!_resizing) return;
        const newW = Math.max(40, _resizing.startW + (e.clientX - _resizing.startX));
        [hdrTbl, bodyTbl].forEach((tbl) => {
          const col = tbl.querySelector(`colgroup col:nth-child(${_resizing.colIdx + 1})`);
          if (col) {
            col.style.width = newW + 'px';
          }
        });
        const allCols = Array.from(hdrTbl.querySelectorAll('colgroup col'));
        const totalW = allCols.reduce((s, c) => s + parseInt(c.style.width || 0), 0);
        hdrTbl.style.width = totalW + 'px';
        bodyTbl.style.width = totalW + 'px';
      },
      { passive: true },
    );
    document.addEventListener('mouseup', () => {
      if (!_resizing) return;
      _resizing.handle.classList.remove('dragging');
      document.body.style.cursor = '';
      // Save widths to DB
      const currentWidths = Array.from(hdrTbl.querySelectorAll('colgroup col')).map((c) =>
        parseInt(c.style.width || 0),
      );
      try {
        DB.set(storageKey, currentWidths);
      } catch (e) {}
      _resizing = null;
    });
  });
}

function toggleUdNav(layoutId) {
  const layout = document.getElementById(layoutId);
  if (!layout) return;
  const isCollapsed = layout.classList.toggle('nav-collapsed');
  // Flip the arrow on the collapse tab
  const tab = layout.querySelector('.ud-collapse-tab');
  if (tab) tab.textContent = isCollapsed ? '▶' : '◀';
}

function toggleNormTip(btn) {
  // Find the tooltip sibling
  const tip = btn.parentElement.querySelector('.norm-info-tooltip');
  if (!tip) return;
  const showing = tip.style.display === 'block';
  // Close all open tips first
  document.querySelectorAll('.norm-info-tooltip').forEach((t) => (t.style.display = 'none'));
  if (!showing) {
    tip.style.display = 'block';
  }
  // Close on outside click
  if (!showing) {
    setTimeout(() => {
      document.addEventListener('click', function h(e) {
        if (!btn.parentElement.contains(e.target)) {
          tip.style.display = 'none';
          document.removeEventListener('click', h);
        }
      });
    }, 10);
  }
}

function getDateRange(bills) {
  if (!bills.length) return '';
  const sorted = bills.slice().sort((a, b) => _parseISO(a.start) - _parseISO(b.start));
  return fmtMon(sorted[0].start) + ' – ' + fmtMon(sorted[sorted.length - 1].end || sorted[sorted.length - 1].start);
}
function fmtMon(d) {
  if (!d) return '?';
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
function fmtDate(d) {
  if (!d || d === 'null' || d === 'undefined') return '?';
  const dt = _parseISO(d);
  if (isNaN(dt)) return '?';
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + dt.getFullYear();
}

/* ══════════════════════════════════════════
         NORMALIZED TAB
      ══════════════════════════════════════════ */
// buildMoMap, normalizePropaneDeliveries, getNormRows
// → canonical source: computations/normalization.js (inline copies removed)

// Returns {byYm: {YYYY-MM: {hdd,cdd,avgTemp}}, cache: [...], zip: string}
function getWeatherForBuilding(projId, bldgId) {
  const pid = projId || udSelProjId;
  const bid = bldgId || udSelBldgId;
  const b = getUDBldg(pid, bid);
  const zip = b?.zip || '';
  if (!zip) return { byYm: null, cache: [], zip: '' };
  const cache = wddLoadCache(zip);
  if (!cache.length) return { byYm: null, cache: [], zip };
  const byYm = {};
  cache.forEach((r) => {
    byYm[r.ym] = r;
  });
  return { byYm, cache, zip };
}

// olsRegressionDual, olsRegression, computeMeterRegression, regressionBaseline
// → moved to computations/regression.js

function setNormMode(mode) {
  udNormMode = mode;
  renderMeterWorkspace();
}
function setNormMetric(metric) {
  udNormMetric = metric;
  saveUDSession();
  renderMeterWorkspace();
}
function toggleNormChart() {
  udNormChartVis = !udNormChartVis;
  saveUDSession();
  renderMeterWorkspace();
}
function toggleBlChart() {
  udBlChartVis = !udBlChartVis;
  saveUDSession();
  renderMeterWorkspace();
}
function toggleBlOverlay() {
  udBlOverlay = !udBlOverlay;
  saveUDSession();
  renderMeterWorkspace();
}
function setBlMetric(m) {
  udBlMetric = m;
  saveUDSession();
  renderMeterWorkspace();
}
function setPerfMetric(m) {
  _perfMetric = m;
  saveUDSession();
  renderMeterWorkspace();
}
function togglePerfOverlay() {
  _perfOverlay = !_perfOverlay;
  saveUDSession();
  renderMeterWorkspace();
}
function togglePerfChart() {
  _perfChartVis = !_perfChartVis;
  saveUDSession();
  renderMeterWorkspace();
}
function setPerfWeatherMode(mode) {
  _perfWeatherMode = mode;
  saveUDSession();
  renderMeterWorkspace();
}
function toggleRegressionPanel() {
  _regressionPanelVis = !_regressionPanelVis;
  saveUDSession();
  renderMeterWorkspace();
}

function exportRegrCSV(mid) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;
  const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const incl = m.inclusive !== false;
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const rows = getNormRows(m, bills, incl, weatherByYm);
  const isElec = m.commodity === 'Electric';
  const unit = getMeterDisplayUnit(m);
  const ddLabel = isElec ? 'CDD' : 'HDD';
  const reg = m._reg;
  const rawReg = isElec ? reg?.cdd : reg?.hdd;
  const proj = getUDProj(udSelProjId);
  const normBasis = proj?.normBasis || 'calendar';

  const pts = rows.filter((r) => !r.partial && (isElec ? r.cdd != null : r.hdd != null) && r.normDays > 0);
  const lines = [
    [
      'Month',
      'Norm Days',
      unit,
      ddLabel,
      unit + '/Day',
      ddLabel + '/Day',
      'Fit Raw (' + unit + ')',
      'Fit Adj (' + unit + ')',
      'Raw Intercept',
      'Bias',
      'Adj Intercept',
      'Slope',
    ].join(','),
    ...pts.map((r) => {
      const dd = isElec ? r.cdd : r.hdd;
      const nDays = normBasis === 'calendar' ? r.normDays : r.days;
      const kwhDay = r.usage / nDays;
      const ddDay = dd / nDays;
      const fitRaw = rawReg ? rawReg.interceptRaw * nDays + rawReg.slope * dd : '';
      const fitAdj = rawReg ? rawReg.intercept * nDays + rawReg.slope * dd : '';
      return [
        r.label,
        nDays,
        r.usage.toFixed(2),
        dd.toFixed(2),
        kwhDay.toFixed(6),
        ddDay.toFixed(6),
        fitRaw !== '' ? fitRaw.toFixed(2) : '',
        fitAdj !== '' ? fitAdj.toFixed(2) : '',
        rawReg ? rawReg.interceptRaw.toFixed(6) : '',
        rawReg ? rawReg.bias.toFixed(6) : '',
        rawReg ? rawReg.intercept.toFixed(6) : '',
        rawReg ? rawReg.slope.toFixed(6) : '',
      ].join(',');
    }),
    // Summary row
    [
      'TOTALS',
      pts.reduce((s, r) => s + (normBasis === 'calendar' ? r.normDays : r.days), 0),
      pts.reduce((s, r) => s + r.usage, 0).toFixed(2),
      pts.reduce((s, r) => s + (isElec ? r.cdd : r.hdd), 0).toFixed(2),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ].join(','),
  ];
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (m.name || 'meter') + '_regression_data.csv';
  a.click();
}

/* ============================================================
 * Export Utility Data modal — JSON / CSV with per-export
 * scope tree + field checklist. Opened from three places:
 *   1. Bills sticky header (meter hint → pre-check that meter)
 *   2. .ud-detail-hdr      (building hint → udSelProj/udSelBldg)
 *   3. proj-ud-detail-hdr  (building hint → projUDSelBldg[pid])
 * Settings modal exposes defaults only; per-export checkboxes
 * override. See dashboardlogic Update 78.
 * ============================================================ */
function openExportModal(hint, targetId) {
  if (!document.getElementById('exportDataModal')) _buildExportModalDOM();
  const modal = document.getElementById('exportDataModal');
  modal.classList.add('open');

  let preProjId = null,
    preBldgId = null,
    preMeterId = null;
  if (hint === 'meter' && targetId) {
    preMeterId = targetId;
    const projs = sget('en_projects', []) || [];
    for (let i = 0; i < projs.length && !preBldgId; i++) {
      const p = projs[i];
      const bldgs = (utilityData[p.id] && utilityData[p.id].buildings) || [];
      for (let j = 0; j < bldgs.length; j++) {
        if ((bldgs[j].meters || []).find((m) => m.id === targetId)) {
          preProjId = p.id;
          preBldgId = bldgs[j].id;
          break;
        }
      }
    }
  } else if (hint === 'building' && targetId) {
    preProjId = targetId;
    if (typeof projUDSelBldg !== 'undefined' && projUDSelBldg[targetId]) {
      preBldgId = projUDSelBldg[targetId];
    }
  } else if (hint === 'building' && !targetId) {
    if (typeof udSelProjId !== 'undefined') preProjId = udSelProjId;
    if (typeof udSelBldgId !== 'undefined') preBldgId = udSelBldgId;
  }

  _renderExportScopeTree(preProjId, preBldgId, preMeterId);

  // Format defaults from ch_settings
  let defFmt = { json: true, csv: false };
  try {
    const s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
    if (s && s.defaultExportFormat && typeof s.defaultExportFormat === 'object') {
      defFmt.json = s.defaultExportFormat.json !== false;
      defFmt.csv = !!s.defaultExportFormat.csv;
    }
  } catch (e) {}
  const cbJ = document.getElementById('exportFmtJson');
  const cbC = document.getElementById('exportFmtCsv');
  if (cbJ) cbJ.checked = defFmt.json;
  if (cbC) cbC.checked = defFmt.csv;
}

function closeExportModal() {
  const m = document.getElementById('exportDataModal');
  if (m) m.classList.remove('open');
}

function _buildExportModalDOM() {
  const el = document.createElement('div');
  el.id = 'exportDataModal';
  el.className = 'modal-bg';
  el.onclick = function (e) {
    if (e.target === el) closeExportModal();
  };
  el.innerHTML =
    '<div class="modal" style="width:820px;max-width:96vw">' +
    '<div class="modal-hdr">' +
    '<span class="modal-title">📤 Export Utility Data</span>' +
    '<button class="modal-x" onclick="closeExportModal()">&#10005;</button>' +
    '</div>' +
    '<div class="modal-body" style="display:flex;flex-direction:column;gap:16px">' +
    // Scope
    '<div>' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">What to export</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px">' +
    '<button class="btn btn-ghost btn-sm" onclick="_exportScopeSelectAll()">Select all</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="_exportScopeSelectNone()">Select none</button>' +
    '</div>' +
    '<div id="exportScopeTree" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--s1);font-size:12px"></div>' +
    '</div>' +
    // Fields
    '<div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Fields to include</div>' +
    '<div id="exportFieldsCount" style="font-size:11px;color:var(--text2)"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
    '<button class="btn btn-ghost btn-sm" onclick="_exportFieldsSelectAll()">All</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="_exportFieldsSelectNone()">None</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="_exportFieldsExcludeDebug()">Exclude debug flags</button>' +
    '</div>' +
    '<div id="exportFieldsList" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--s1);font-size:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 12px"></div>' +
    '</div>' +
    // Format
    '<div>' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">Format</div>' +
    '<div style="display:flex;gap:16px;align-items:center;font-size:13px;flex-wrap:wrap">' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
    '<input type="checkbox" id="exportFmtJson" checked> JSON' +
    '</label>' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
    '<input type="checkbox" id="exportFmtCsv"> CSV' +
    '</label>' +
    '<span style="font-size:11px;color:var(--text3);margin-left:auto">Default set in Settings → Default Export Format</span>' +
    '</div>' +
    '</div>' +
    // Footer
    '<div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:14px">' +
    '<button class="btn btn-ghost btn-sm" onclick="closeExportModal()">Cancel</button>' +
    '<button class="btn btn-em btn-sm" id="exportDoBtn" onclick="_doExport()">💾 Download</button>' +
    '</div>' +
    '</div>' + // modal-body
    '</div>'; // modal
  document.body.appendChild(el);
}

function _renderExportScopeTree(preProjId, preBldgId, preMeterId) {
  const tree = document.getElementById('exportScopeTree');
  if (!tree) return;
  const projs = sget('en_projects', []) || [];

  let html = '';
  projs.forEach(function (p) {
    const bldgs = (utilityData[p.id] && utilityData[p.id].buildings) || [];
    const projHasBills = bldgs.some(function (b) {
      return (b.meters || []).some(function (m) {
        return (m.bills || []).length;
      });
    });
    if (!projHasBills) return;
    const projChecked = preProjId && String(p.id) === String(preProjId) ? 'checked' : '';
    html +=
      '<div class="exp-proj" data-pid="' +
      p.id +
      '" style="margin-bottom:4px">' +
      '<label style="display:flex;align-items:center;gap:6px;font-weight:600;cursor:pointer">' +
      '<input type="checkbox" class="exp-cb exp-cb-proj" data-pid="' +
      p.id +
      '" ' +
      projChecked +
      ' onchange="_exportScopeToggleProj(\'' +
      p.id +
      '\')"> ' +
      '📁 ' +
      (p.name || 'Project ' + p.id) +
      '</label>' +
      '<div style="padding-left:20px">';
    bldgs.forEach(function (b) {
      const meters = (b.meters || []).filter(function (m) {
        return (m.bills || []).length;
      });
      if (!meters.length) return;
      const bldgChecked = preBldgId && b.id === preBldgId ? 'checked' : projChecked && !preBldgId ? 'checked' : '';
      html +=
        '<div class="exp-bldg" data-pid="' +
        p.id +
        '" data-bid="' +
        b.id +
        '" style="margin:3px 0">' +
        '<label style="display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer">' +
        '<input type="checkbox" class="exp-cb exp-cb-bldg" data-pid="' +
        p.id +
        '" data-bid="' +
        b.id +
        '" ' +
        bldgChecked +
        ' onchange="_exportScopeToggleBldg(\'' +
        p.id +
        "','" +
        b.id +
        '\')"> ' +
        '🏢 ' +
        (b.name || 'Building ' + b.id) +
        '</label>' +
        '<div style="padding-left:20px">';
      meters.forEach(function (m) {
        const billCount = (m.bills || []).length;
        const meterChecked = preMeterId
          ? String(m.id) === String(preMeterId)
            ? 'checked'
            : ''
          : preBldgId && String(b.id) === String(preBldgId)
            ? 'checked'
            : bldgChecked
              ? 'checked'
              : '';
        const commodityIcon =
          m.commodity === 'Gas'
            ? '🔥'
            : m.commodity === 'Water'
              ? '💧'
              : m.commodity === 'Steam'
                ? '♨️'
                : m.commodity === 'Propane'
                  ? '🛢️'
                  : '⚡';
        html +=
          '<label class="exp-meter" data-pid="' +
          p.id +
          '" data-bid="' +
          b.id +
          '" data-mid="' +
          m.id +
          '" style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" class="exp-cb exp-cb-meter" data-pid="' +
          p.id +
          '" data-bid="' +
          b.id +
          '" data-mid="' +
          m.id +
          '" ' +
          meterChecked +
          ' onchange="_exportScopeToggleMeter()"> ' +
          commodityIcon +
          ' ' +
          meterLabel(m) +
          ' <span style="color:var(--text3);font-size:11px">(' +
          billCount +
          ' bill' +
          (billCount !== 1 ? 's' : '') +
          ')</span>' +
          '</label>';
      });
      html += '</div></div>';
    });
    html += '</div></div>';
  });
  if (!html) html = '<div style="color:var(--text3);padding:8px">No bills found in any project.</div>';
  tree.innerHTML = html;
  _refreshExportFieldsList();
}

function _exportScopeToggleProj(pid) {
  const proj = document.querySelector('.exp-cb-proj[data-pid="' + pid + '"]');
  if (!proj) return;
  const checked = proj.checked;
  document
    .querySelectorAll('.exp-cb-bldg[data-pid="' + pid + '"], .exp-cb-meter[data-pid="' + pid + '"]')
    .forEach(function (cb) {
      cb.checked = checked;
    });
  _refreshExportFieldsList();
}
function _exportScopeToggleBldg(pid, bid) {
  const b = document.querySelector('.exp-cb-bldg[data-pid="' + pid + '"][data-bid="' + bid + '"]');
  if (!b) return;
  const checked = b.checked;
  document.querySelectorAll('.exp-cb-meter[data-pid="' + pid + '"][data-bid="' + bid + '"]').forEach(function (cb) {
    cb.checked = checked;
  });
  _refreshExportFieldsList();
}
function _exportScopeToggleMeter() {
  _refreshExportFieldsList();
}
function _exportScopeSelectAll() {
  document.querySelectorAll('#exportScopeTree .exp-cb').forEach(function (cb) {
    cb.checked = true;
  });
  _refreshExportFieldsList();
}
function _exportScopeSelectNone() {
  document.querySelectorAll('#exportScopeTree .exp-cb').forEach(function (cb) {
    cb.checked = false;
  });
  _refreshExportFieldsList();
}

function _getExportSelectedBills() {
  const projs = sget('en_projects', []) || [];
  const selected = [];
  document.querySelectorAll('#exportScopeTree .exp-cb-meter:checked').forEach(function (cb) {
    const pid = cb.getAttribute('data-pid');
    const bid = cb.getAttribute('data-bid');
    const mid = cb.getAttribute('data-mid');
    const p = projs.find(function (x) {
      return String(x.id) === String(pid);
    });
    if (!p) return;
    const bldgs = (utilityData[p.id] && utilityData[p.id].buildings) || [];
    const b = bldgs.find(function (x) {
      return String(x.id) === String(bid);
    });
    if (!b) return;
    const m = (b.meters || []).find(function (x) {
      return String(x.id) === String(mid);
    });
    if (!m) return;
    (m.bills || []).forEach(function (bill) {
      selected.push({
        projectName: p.name || '',
        projectId: p.id,
        buildingName: b.name || '',
        buildingId: b.id,
        meterName: meterLabel(m),
        meterId: m.id,
        meterAccount: m.account || '',
        meterNumber: m.meter || '',
        meterCommodity: m.commodity || '',
        bill: bill,
      });
    });
  });
  return selected;
}

function _refreshExportFieldsList() {
  const selectedBills = _getExportSelectedBills();
  const keys = {};
  selectedBills.forEach(function (entry) {
    Object.keys(entry.bill || {}).forEach(function (k) {
      keys[k] = true;
    });
  });
  const meta = [
    'projectName',
    'projectId',
    'buildingName',
    'buildingId',
    'meterName',
    'meterId',
    'meterAccount',
    'meterNumber',
    'meterCommodity',
  ];
  const billKeys = Object.keys(keys).sort();
  const list = document.getElementById('exportFieldsList');
  if (!list) return;

  const prior = {};
  list.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
    prior[cb.getAttribute('data-field')] = cb.checked;
  });

  let html = '';
  meta.forEach(function (k) {
    const checked = prior[k] === false ? '' : 'checked';
    html +=
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text2)">' +
      '<input type="checkbox" data-field="' +
      k +
      '" data-meta="1" ' +
      checked +
      '> ' +
      '<span>' +
      k +
      '</span>' +
      '</label>';
  });
  billKeys.forEach(function (k) {
    const isDebug = k.charAt(0) === '_';
    const checked = prior[k] === false ? '' : 'checked';
    html +=
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer' +
      (isDebug ? ';color:var(--text3)' : '') +
      '">' +
      '<input type="checkbox" data-field="' +
      k +
      '" ' +
      (isDebug ? 'data-debug="1" ' : '') +
      checked +
      '> ' +
      '<span>' +
      k +
      (isDebug ? ' <em style="font-size:10px;color:var(--text3)">(debug)</em>' : '') +
      '</span>' +
      '</label>';
  });
  if (!html) {
    html =
      '<div style="color:var(--text3);padding:8px;grid-column:1/-1">Select at least one meter above to see fields.</div>';
  }
  list.innerHTML = html;

  const count = document.getElementById('exportFieldsCount');
  if (count) {
    const total = meta.length + billKeys.length;
    count.textContent =
      selectedBills.length +
      ' bill' +
      (selectedBills.length !== 1 ? 's' : '') +
      ' · ' +
      total +
      ' field' +
      (total !== 1 ? 's' : '');
  }
}

function _exportFieldsSelectAll() {
  document.querySelectorAll('#exportFieldsList input[type=checkbox]').forEach(function (cb) {
    cb.checked = true;
  });
}
function _exportFieldsSelectNone() {
  document.querySelectorAll('#exportFieldsList input[type=checkbox]').forEach(function (cb) {
    cb.checked = false;
  });
}
function _exportFieldsExcludeDebug() {
  document.querySelectorAll('#exportFieldsList input[type=checkbox]').forEach(function (cb) {
    if (cb.getAttribute('data-debug') === '1') cb.checked = false;
    else cb.checked = true;
  });
}

function _doExport() {
  const selectedBills = _getExportSelectedBills();
  if (!selectedBills.length) {
    showToast('Select at least one meter to export.');
    return;
  }
  const wantJson = document.getElementById('exportFmtJson').checked;
  const wantCsv = document.getElementById('exportFmtCsv').checked;
  if (!wantJson && !wantCsv) {
    showToast('Pick at least one format: JSON or CSV.');
    return;
  }
  const fieldCbs = Array.from(document.querySelectorAll('#exportFieldsList input[type=checkbox]:checked'));
  if (!fieldCbs.length) {
    showToast('Select at least one field to export.');
    return;
  }
  const metaFields = [];
  const billFields = [];
  fieldCbs.forEach(function (cb) {
    const f = cb.getAttribute('data-field');
    if (cb.getAttribute('data-meta') === '1') metaFields.push(f);
    else billFields.push(f);
  });

  const rows = selectedBills.map(function (entry) {
    const row = {};
    metaFields.forEach(function (f) {
      row[f] = entry[f];
    });
    billFields.forEach(function (f) {
      row[f] = entry.bill && Object.prototype.hasOwnProperty.call(entry.bill, f) ? entry.bill[f] : null;
    });
    return row;
  });

  const baseName = _getExportFilename(selectedBills);

  if (wantJson) {
    const payload = {
      exportedAt: new Date().toISOString(),
      rowCount: rows.length,
      fields: metaFields.concat(billFields),
      rows: rows,
    };
    _exportTriggerDownload(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      baseName + '.json',
    );
  }
  if (wantCsv) {
    const headers = metaFields.concat(billFields);
    const esc = function (v) {
      if (v == null) return '';
      if (typeof v === 'object') v = JSON.stringify(v);
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const csvLines = [headers.join(',')].concat(
      rows.map(function (r) {
        return headers
          .map(function (h) {
            return esc(r[h]);
          })
          .join(',');
      }),
    );
    _exportTriggerDownload(new Blob([csvLines.join('\r\n')], { type: 'text/csv' }), baseName + '.csv');
  }
  showToast('Exported ' + rows.length + ' bill' + (rows.length !== 1 ? 's' : '') + '.');
  closeExportModal();
}

function _exportTriggerDownload(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 3000);
}

/* Derive a human-friendly base filename from the current selection.
 * Degrades by scope level: single meter → Project_Building_Commodity_<Mtr|Acct>id_date,
 * single building → Project_Building_date, single project → Project_date,
 * multi-project → utility-data-export_date. Prefers meter number over account. */
function _getExportFilename(selectedBills) {
  const projIds = new Set();
  const bldgIds = new Set();
  const meterIds = new Set();
  let first = null;
  selectedBills.forEach(function (e) {
    projIds.add(e.projectId);
    bldgIds.add(e.buildingId);
    meterIds.add(e.meterId);
    if (!first) first = e;
  });
  const sanitize = function (s) {
    return String(s || '')
      .replace(/[^\w\-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  };
  const today = new Date();
  const dateStr =
    today.getFullYear() +
    '-' +
    String(today.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(today.getDate()).padStart(2, '0');
  if (!first) return 'utility-data-export_' + dateStr;

  if (meterIds.size === 1) {
    const parts = [];
    if (first.projectName) parts.push(sanitize(first.projectName));
    if (first.buildingName) parts.push(sanitize(first.buildingName));
    if (first.meterCommodity) parts.push(sanitize(first.meterCommodity));
    // Prefer meter number over account number
    if (first.meterNumber) {
      parts.push('Mtr' + sanitize(first.meterNumber));
    } else if (first.meterAccount) {
      parts.push('Acct' + sanitize(first.meterAccount));
    }
    parts.push(dateStr);
    return parts.join('_');
  }
  if (bldgIds.size === 1) {
    const parts = [];
    if (first.projectName) parts.push(sanitize(first.projectName));
    if (first.buildingName) parts.push(sanitize(first.buildingName));
    parts.push(dateStr);
    return parts.join('_');
  }
  if (projIds.size === 1) {
    const parts = [];
    if (first.projectName) parts.push(sanitize(first.projectName));
    parts.push(dateStr);
    return parts.join('_');
  }
  return 'utility-data-export_' + dateStr;
}

function setProjectNormBasis(pid, basis) {
  const proj = getUDProj(pid);
  proj.normBasis = basis;
  saveUtilityData();
  renderMeterWorkspace();
}

function renderNormPane(pane, m, bills, incl) {
  try {
    if (!bills.length) {
      pane.innerHTML =
        '<div class="ud-empty"><div class="ud-empty-ico">🌡️</div><div>Add bill data in the Bills tab first</div></div>';
      return;
    }
    const unit = getMeterDisplayUnit(m);
    const isElec = m.commodity === 'Electric',
      isGas = m.commodity === 'Gas';
    const { byYm: weatherByYm } = getWeatherForBuilding();
    const rows = getNormRows(m, bills, incl, weatherByYm); // also sets m._reg
    const hasWeather = rows.some((r) => r.hdd != null || r.cdd != null);
    const hasRegr = rows.some((r) => r.regrBaseline != null);
    const weatherDDLabel = isElec ? 'CDD' : 'HDD';

    // Project-level normalization basis
    const proj = getUDProj(udSelProjId);
    const normBasis = proj?.normBasis || 'calendar';

    // Resolve effective metric
    const metric = udNormMetric === 'weather' && !hasWeather ? 'total' : udNormMetric;

    // ── EUI ──
    const b2 = getUDBldg(udSelProjId, udSelBldgId);
    const sqft = parseInt(b2?.sqft) || 0;
    const hasEUI = isElec && sqft > 0;

    // ── Stats ──
    const totalUsage = rows.reduce((s, r) => s + r.usage, 0);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const avgPerDay = rows.reduce((s, r) => s + r.usagePerDay, 0) / rows.length;
    const wRows = rows.filter((r) => r.weatherNorm != null);
    const avgWeather = wRows.length ? wRows.reduce((s, r) => s + r.weatherNorm, 0) / wRows.length : null;
    const avgMonthly = totalUsage / rows.length;
    const avgEuiPerMo = hasEUI ? avgMonthly / sqft : null;
    const last12 = rows.slice(-12);
    const rolling12kWh = last12.reduce((s, r) => s + r.usage, 0);
    const rolling12EUI = hasEUI && last12.length === 12 ? toKBtu(rolling12kWh, 0, 0) / sqft : null;
    // Avg regression baseline
    const rRows = rows.filter((r) => r.regrBaseline != null);
    const avgRegrBl = rRows.length ? rRows.reduce((s, r) => s + r.regrBaseline, 0) / rRows.length : null;

    const statVal =
      metric === 'weather' && avgWeather != null
        ? avgWeather.toFixed(3)
        : metric === 'total'
          ? avgMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })
          : avgPerDay.toFixed(1);
    const statUnit =
      metric === 'weather' && avgWeather != null
        ? unit + '/' + weatherDDLabel + ' avg'
        : metric === 'total'
          ? unit + '/mo avg'
          : unit + '/day avg';
    const statLbl =
      metric === 'weather'
        ? 'Weather-Norm Avg (' + weatherDDLabel + ')'
        : metric === 'total'
          ? 'Avg Monthly ' + unit
          : unit + '/Day Avg';

    // ── Compact stats strip ──
    const statsHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
      blPill(totalUsage.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit, 'Total') +
      blPill(statVal + ' ' + statUnit.split(' ')[0], statLbl) +
      (hasRegr && avgRegrBl != null
        ? blPill(
            avgRegrBl.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit + '/mo',
            'Normalized Baseline Avg',
            'var(--violet)',
          )
        : '') +
      blPill('$' + totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 }), 'Total Cost', 'var(--em2)') +
      blPill(rows.length + ' mo', 'Data Points') +
      (hasEUI && rolling12EUI != null
        ? blPill(rolling12EUI.toFixed(1) + ' kBtu/sf/yr', '12-Mo Site EUI', 'var(--warn)')
        : '') +
      '</div>';

    // ── Normalization basis toggle (project-level) ──
    const basisBar =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 12px;background:var(--s3);border:1px solid var(--border);border-radius:7px;flex-wrap:wrap">' +
      '<span style="font-size:11px;font-weight:600;color:var(--text2)">📐 Period Basis:</span>' +
      '<span style="font-size:11px;color:var(--text3)">Applied to all meters in this project —</span>' +
      '<button class="ud-incl-btn' +
      (normBasis === 'calendar' ? ' sel' : '') +
      '" onclick="setProjectNormBasis(\'' +
      udSelProjId +
      "','calendar')\">📅 Calendar Month Days</button>" +
      '<button class="ud-incl-btn' +
      (normBasis === 'actual' ? ' sel' : '') +
      '" onclick="setProjectNormBasis(\'' +
      udSelProjId +
      "','actual')\">📋 Actual Bill Days</button>" +
      '<span style="font-size:11px;color:var(--text3);flex:1">' +
      (normBasis === 'calendar'
        ? 'Normalizes to the actual calendar-month day count (e.g. Jan=31, Feb=28). Standard industry method.'
        : 'Uses the prorated billing days actually assigned to each calendar month.') +
      '</span>' +
      '</div>';

    // ── Regression panel ──
    const reg = m._reg || {};
    const _isFrozenReg = !!(m.baseline && m.baseline.reg);
    let regrPanel = '';
    if (_regressionPanelVis) {
      const fmtQual = (r) => {
        if (!r) return '<span style="color:var(--text3)">insufficient data</span>';
        if (r.r2 >= 0.85) return '<span style="color:var(--em)">Strong (R²≥0.85)</span>';
        if (r.r2 >= 0.65) return '<span style="color:var(--amber)">Moderate (R²≥0.65)</span>';
        return '<span style="color:var(--red)">Weak (R²&lt;0.65)</span>';
      };
      const fmtRow = (label, ddLabel, r) =>
        r
          ? '<tr>' +
            '<td class="mono">' +
            label +
            '</td>' +
            '<td class="mono">' +
            r.interceptRaw.toFixed(3) +
            '</td>' +
            '<td class="mono" style="color:' +
            (r.bias >= 0 ? 'var(--em)' : 'var(--danger)') +
            '">' +
            (r.bias >= 0 ? '+' : '') +
            r.bias.toFixed(3) +
            '</td>' +
            '<td class="mono" style="color:var(--violet);font-weight:600">' +
            r.intercept.toFixed(3) +
            '</td>' +
            '<td class="mono">' +
            r.slope.toFixed(4) +
            ' × ' +
            ddLabel +
            '/day</td>' +
            '<td class="mono">' +
            r.n +
            '</td>' +
            '<td class="mono">' +
            r.r2.toFixed(3) +
            '</td>' +
            '<td>' +
            fmtQual(r) +
            '</td>' +
            '</tr>'
          : '<tr><td class="mono">' +
            label +
            '</td><td colspan="3" style="color:var(--text3);font-size:11px">— insufficient data (need ≥3 months with non-zero ' +
            ddLabel +
            ')</td></tr>';
      const ddUsed = isElec ? 'CDD (primary) / HDD (fallback)' : 'HDD (primary) / CDD (fallback)';
      // Build regression input data table for Excel comparison
      const cddPtsDebug = rows.filter((r) => !r.partial && r.cdd != null && r.normDays > 0);
      const hddPtsDebug = rows.filter((r) => !r.partial && r.hdd != null && r.normDays > 0);
      const debugPts = isElec ? cddPtsDebug : hddPtsDebug;
      const ddLabel2 = isElec ? 'CDD' : 'HDD';
      const rawReg = isElec ? reg.cdd : reg.hdd;

      // Build full row list — included rows + excluded rows with reason
      const allDebugRows = rows.map((r) => {
        const dd = isElec ? r.cdd : r.hdd;
        const included = debugPts.includes(r);
        let excludeReason = '';
        if (!included) {
          if (r.partial) excludeReason = '⚠ partial (' + r.days + '/' + r.normDays + ' days)';
          else if (dd == null) excludeReason = 'no ' + ddLabel2 + ' data';
          else excludeReason = 'excluded';
        }
        const nDays = normBasis === 'calendar' ? r.normDays : r.days;
        const kwhPerDay = r.usage / nDays;
        const ddPerDay = dd != null ? dd / nDays : null;
        const fitLine = included && rawReg ? rawReg.interceptRaw * nDays + rawReg.slope * dd : null;
        const adjFit = included && rawReg ? rawReg.intercept * nDays + rawReg.slope * dd : null;
        return {
          label: r.label,
          normDays: nDays,
          calDays: r.normDays,
          usage: r.usage,
          days: r.days,
          dd,
          kwhPerDay,
          ddPerDay,
          fitLine,
          adjFit,
          included,
          excludeReason,
        };
      });

      const sumFitRaw = allDebugRows.filter((r) => r.included).reduce((s, r) => s + (r.fitLine || 0), 0);
      const sumFitAdj = allDebugRows.filter((r) => r.included).reduce((s, r) => s + (r.adjFit || 0), 0);
      const sumActual = allDebugRows.filter((r) => r.included).reduce((s, r) => s + r.usage, 0);
      const sumNormDays = allDebugRows.filter((r) => r.included).reduce((s, r) => s + r.normDays, 0);

      const debugCsvId = 'regrCsvData_' + m.id;
      const debugTableId = 'regrDebugTable_' + m.id;

      const debugTableRows = allDebugRows
        .map((r) => {
          const rowStyle = r.included ? '' : ' style="opacity:0.45"';
          return (
            '<tr' +
            rowStyle +
            '>' +
            '<td class="mono">' +
            r.label +
            '</td>' +
            '<td class="mono">' +
            r.normDays +
            ' <span style="color:var(--text3);font-size:10px">(' +
            (normBasis === 'calendar' ? 'bill:' + r.days : 'cal:' + r.calDays) +
            ')</span></td>' +
            '<td class="mono">' +
            r.usage.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 }) +
            '</td>' +
            '<td class="mono">' +
            (r.dd != null ? r.dd.toFixed(1) : '—') +
            '</td>' +
            (r.included
              ? '<td class="mono" style="color:var(--em2)">' +
                r.kwhPerDay.toFixed(4) +
                '</td>' +
                '<td class="mono" style="color:var(--em2)">' +
                r.ddPerDay.toFixed(4) +
                '</td>' +
                '<td class="mono">' +
                (r.fitLine != null ? r.fitLine.toFixed(1) : '—') +
                '</td>' +
                '<td class="mono" style="color:var(--violet)">' +
                (r.adjFit != null ? r.adjFit.toFixed(1) : '—') +
                '</td>' +
                '<td></td>'
              : '<td colspan="4" style="color:var(--text3);font-size:11px">excluded — ' +
                r.excludeReason +
                '</td>' +
                '<td></td>') +
            '</tr>'
          );
        })
        .join('');

      regrPanel =
        '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:12px">' +
        '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">📈 Regression Model — ' +
        unit +
        '/Day ~ DD/Day' +
        (_isFrozenReg
          ? ' &nbsp;<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--violet);color:#fff;letter-spacing:0">🔒 FROZEN</span>'
          : ' &nbsp;<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--em2);color:#fff;letter-spacing:0">⚡ LIVE</span>') +
        '</div>' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">' +
        'OLS fit: <strong>usage/day = intercept + slope × (DD/day)</strong> — using calendar days per month as denominator.<br>' +
        'Bias correction: <strong>(ΣfitLine − ΣactualKwh) / ΣcalendarDays</strong> subtracted from intercept, forcing total predicted kWh = total actual kWh over training months.<br>' +
        'To replicate in Excel: use calendar days per month (not billing period days) as your day denominator for both kWh/day and DD/day columns.<br>' +
        'Baseline/month = corrected intercept × normDays + slope × DD_month &nbsp;·&nbsp; ' +
        'DD used: <strong>' +
        ddUsed +
        '</strong> &nbsp;·&nbsp; Basis: <strong>' +
        (normBasis === 'calendar' ? 'Calendar days' : 'Actual bill days') +
        '</strong>' +
        '</div>' +
        '<div style="overflow-x:auto">' +
        '<table class="ma-tbl" style="margin-bottom:8px">' +
        '<thead><tr><th>Model</th><th>Raw Intercept</th><th>Bias Correction</th><th style="color:var(--violet)">Adj. Intercept</th><th>Slope</th><th>n</th><th>R²</th><th>Fit</th></tr></thead>' +
        '<tbody>' +
        fmtRow('HDD model', 'HDD', reg.hdd) +
        fmtRow('CDD model', 'CDD', reg.cdd) +
        '</tbody>' +
        '</table>' +
        '</div>' +
        (!reg.hdd && !reg.cdd
          ? '<div style="font-size:11px;color:var(--warn);padding:6px 0">⚠️ No regression computed — upload weather data with at least 3 months of non-zero degree days.</div>'
          : '') +
        // Regression input data table
        '<div style="margin-top:12px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Regression Input Data (' +
        ddLabel2 +
        ' model — ' +
        allDebugRows.length +
        ' rows)</div>' +
        '<button class="btn btn-ghost btn-sm" onclick="exportRegrCSV(\'' +
        m.id +
        '\')">⬇ Export CSV</button>' +
        '</div>' +
        '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px;max-height:280px;overflow-y:auto">' +
        '<table class="ma-tbl" id="' +
        debugTableId +
        '">' +
        '<thead><tr>' +
        '<th>Month</th>' +
        '<th>Cal Days</th>' +
        '<th>' +
        unit +
        '</th>' +
        '<th>' +
        ddLabel2 +
        '</th>' +
        '<th style="color:var(--em2)">' +
        unit +
        '/Day</th>' +
        '<th style="color:var(--em2)">' +
        ddLabel2 +
        '/Day</th>' +
        '<th>Fit (raw)</th>' +
        '<th style="color:var(--violet)">Fit (adj)</th>' +
        '</tr></thead>' +
        '<tbody>' +
        debugTableRows +
        '</tbody>' +
        '<tfoot style="background:var(--s1);font-weight:700">' +
        '<tr>' +
        '<td class="mono">Σ / Check</td>' +
        '<td class="mono">' +
        sumNormDays +
        '</td>' +
        '<td class="mono">' +
        sumActual.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 }) +
        '</td>' +
        '<td></td><td></td><td></td>' +
        '<td class="mono' +
        (Math.abs(sumFitRaw - sumActual) > 1 ? ' style="color:var(--warn)"' : '') +
        '">' +
        sumFitRaw.toFixed(1) +
        '</td>' +
        '<td class="mono" style="color:var(--violet)">' +
        sumFitAdj.toFixed(1) +
        '</td>' +
        '</tr>' +
        '</tfoot>' +
        '</table>' +
        '</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:5px">' +
        'Σ Fit (adj) should equal Σ ' +
        unit +
        ' after bias correction. ' +
        'Highlighted ' +
        unit +
        '/Day and ' +
        ddLabel2 +
        '/Day columns = exact x/y values fed to INTERCEPT() and SLOPE() in Excel.' +
        '</div>' +
        '<textarea id="' +
        debugCsvId +
        '" style="display:none"></textarea>' +
        '</div>' +
        '</div>';
    }

    // ── Control bar ──
    const chartBtnLabel = udNormChartVis ? '📉 Hide Chart' : '📊 Show Chart';
    const warnDisabled = !hasWeather ? ' style="opacity:.45;cursor:not-allowed" disabled' : '';
    const warnTip = !hasWeather
      ? '<span style="font-size:11px;color:var(--text3);margin-left:4px">Upload weather CSV to enable</span>'
      : '';
    const weatherBtnLabel = isElec ? '🌡️ CDD Norm' : '🌡️ HDD Norm';
    const controlBar =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:10px">' +
      '<button class="ud-incl-btn" onclick="toggleNormChart()" style="background:var(--s3);border-color:var(--border2);color:var(--text2)">' +
      chartBtnLabel +
      '</button>' +
      '<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>' +
      '<span style="font-size:11px;color:var(--text2)">Chart:</span>' +
      '<button class="ud-incl-btn' +
      (metric === 'total' ? ' sel' : '') +
      '" onclick="setNormMetric(\'total\')">' +
      unit +
      '/Month</button>' +
      '<button class="ud-incl-btn' +
      (metric === 'perday' ? ' sel' : '') +
      '" onclick="setNormMetric(\'perday\')">' +
      unit +
      '/Day</button>' +
      '<button class="ud-incl-btn' +
      (metric === 'weather' ? ' sel' : '') +
      '"' +
      warnDisabled +
      ' onclick="setNormMetric(\'weather\')">' +
      weatherBtnLabel +
      '</button>' +
      warnTip +
      '</div>';

    // Regression toggle — its own clearly visible row
    const regrToggleRow =
      '<div style="margin-bottom:12px">' +
      '<button onclick="toggleRegressionPanel()" style="' +
      'width:100%;display:flex;align-items:center;justify-content:space-between;' +
      'padding:9px 14px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;' +
      'background:' +
      (_regressionPanelVis ? 'var(--violet-dim)' : 'var(--s3)') +
      ';' +
      'border:1px solid ' +
      (_regressionPanelVis ? 'rgba(139,92,246,0.4)' : 'var(--border)') +
      ';' +
      'color:' +
      (_regressionPanelVis ? 'var(--violet)' : 'var(--text2)') +
      ';' +
      '">' +
      '<span>📈 Normalized Baseline Model — Regression Coefficients' +
      (hasRegr
        ? " · <span style='color:var(--em);font-size:11px'>✓ Active</span>" +
          (reg.dual
            ? " · <span style='color:var(--violet);font-size:11px'>Model: HDD + CDD</span>"
            : reg.hdd && reg.cdd
              ? " · <span style='color:var(--violet);font-size:11px'>Model: " +
                (isElec ? 'CDD primary / HDD fallback' : 'HDD primary / CDD fallback') +
                '</span>'
              : reg.hdd
                ? " · <span style='color:var(--violet);font-size:11px'>Model: HDD only</span>"
                : reg.cdd
                  ? " · <span style='color:var(--violet);font-size:11px'>Model: CDD only</span>"
                  : '')
        : " · <span style='color:var(--text3);font-size:11px'>Upload weather to enable</span>") +
      '</span>' +
      '<span style="font-size:11px;color:var(--text3)">' +
      (_regressionPanelVis ? '▲ Hide' : '▼ Show') +
      '</span>' +
      '</button>' +
      '</div>';

    // ── Weather upload row ──
    const bldgZip = b2?.zip || '';
    const wddCacheArr = bldgZip ? wddLoadCache(bldgZip) : [];
    const wddBtn =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="openWddModal(\'' +
      m.id +
      '\')">' +
      '🌡️ Upload Weather CSV' +
      (bldgZip ? ' — ZIP ' + bldgZip : '') +
      '</button>' +
      (!bldgZip
        ? '<span style="font-size:11px;color:var(--warn)">Add ZIP in Edit Building to enable weather data</span>'
        : '') +
      '<span style="font-size:11px;color:var(--em);flex:1;min-width:0">' +
      (wddCacheArr.length
        ? '✓ ' + wddCacheArr.length + ' months loaded from ZIP ' + bldgZip + ' — applied to all meters'
        : bldgZip
          ? '<span style="color:var(--text3)">No weather data yet — upload CSV to enable regression normalization</span>'
          : '') +
      '</span>' +
      '</div>';

    const wddNotice =
      udNormMetric === 'weather' && !hasWeather
        ? '<div style="background:var(--warn-dim);border:1px solid rgba(245,158,11,.25);border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:12px;color:var(--warn)">' +
          '⚠️ No ' +
          weatherDDLabel +
          ' data loaded — showing ' +
          unit +
          '/Month instead. Upload a weather CSV above.</div>'
        : '';

    // ── Helpers ──
    const fmtWeather = (v) => (v == null ? '—' : v);
    const fmtTemp = (v) => (v == null ? '—' : v > 0 ? v.toFixed(1) + '°' : '0°');

    // ── Chart label ──
    const chartLabel =
      metric === 'weather'
        ? unit + '/' + weatherDDLabel + ' — Weather Normalized'
        : metric === 'total'
          ? hasRegr
            ? `Normalized ${unit} vs Actual ${unit}`
            : unit + '/Month'
          : unit + '/Day';

    // ── Table col header ──
    const normColHdr =
      metric === 'weather' ? unit + '/' + weatherDDLabel : metric === 'total' ? unit + '/Mo' : unit + '/Day';

    // ── Table rows ──
    const tblRows = rows
      .map((r) => {
        const normVal =
          metric === 'weather'
            ? r.weatherNorm != null
              ? r.weatherNorm.toFixed(3)
              : '—'
            : metric === 'total'
              ? r.usage.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
              : r.usagePerDay.toFixed(2);
        const normColor = metric === 'weather' ? 'var(--em2)' : 'var(--em)';
        const euiCell = hasEUI ? `<td class="mono" style="color:var(--text3)">${(r.usage / sqft).toFixed(4)}</td>` : '';
        // Regression baseline cell — show normDays used
        const regrCell = hasRegr
          ? `<td class="mono" style="color:var(--violet)">${r.regrBaseline != null ? r.regrBaseline.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
               <td class="mono" style="color:var(--text3);font-size:10px">${r.normDays}</td>`
          : '';
        const hddCell = weatherByYm
          ? `<td class="mono" style="color:var(--text2)">${fmtWeather(r.hdd)}</td>`
          : `<td><input type="number" placeholder="—" value="${r.hdd != null ? r.hdd : ''}"
                  onchange="updateBillWeather('${m.id}','${r.id}','hdd',this.value)"
                  style="width:65px;font-family:var(--mono);font-size:12px;background:var(--s3);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);outline:none"></td>`;
        const cddCell = weatherByYm
          ? `<td class="mono" style="color:var(--text2)">${fmtWeather(r.cdd)}</td>`
          : `<td><input type="number" placeholder="—" value="${r.cdd != null ? r.cdd : ''}"
                  onchange="updateBillWeather('${m.id}','${r.id}','cdd',this.value)"
                  style="width:65px;font-family:var(--mono);font-size:12px;background:var(--s3);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);outline:none"></td>`;
        return `<tr class="${r.isBaseline ? 'baseline-row' : ''}">
            <td class="lbl">${r.label}</td>
            <td class="mono">${r.days}</td>
            ${hddCell}${cddCell}
            <td class="mono" style="color:var(--text2)">${fmtTemp(r.avgTemp)}</td>
            <td class="mono" style="color:var(--em2)">${r.weatherNorm != null ? r.weatherNorm.toFixed(3) : '—'}</td>
            ${regrCell}${euiCell}
            <td class="mono">${r.cost != null && r.cost !== '' ? '$' + r.cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
            ${r.isBaseline ? '<td><span style="font-size:10px;background:var(--em-dim);color:var(--em);border:1px solid rgba(0,212,170,.2);border-radius:4px;padding:1px 6px">BL</span></td>' : '<td></td>'}
          </tr>`;
      })
      .join('');

    // ── Chart section ──
    const chartSection = udNormChartVis
      ? '<div style="margin-bottom:16px">' +
        '<div class="chart-title" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">' +
        chartLabel +
        '</div>' +
        '<div class="ma-chart-wrap" style="padding:12px"><canvas id="normChart"></canvas></div>' +
        '</div>'
      : '';

    // ── Table section ──
    const euiHdr = hasEUI ? '<th>kWh/sqft</th>' : '';
    const regrHdrs = hasRegr
      ? '<th style="color:var(--violet)" title="Weather-normalized usage — primary output when regression is active">Normalized Baseline</th><th style="color:var(--text3);font-size:10px">Norm Days</th>'
      : '';
    const tableSection =
      '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">' +
      (hasRegr ? 'Monthly Normalized Baseline + Calculation Data' : 'Monthly Usage + Weather Data') +
      '</div>' +
      '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;max-height:340px;overflow-y:auto">' +
      '<table class="ma-tbl">' +
      '<thead><tr><th class="lbl">Month</th><th class="num">Days</th><th class="num">HDD</th><th class="num">CDD</th><th class="num">Avg °F</th><th class="num">' +
      unit +
      '/' +
      weatherDDLabel +
      '</th>' +
      regrHdrs +
      euiHdr +
      '<th class="num">Cost</th><th></th></tr></thead>' +
      '<tbody>' +
      tblRows +
      '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>';

    pane.innerHTML =
      statsHTML + basisBar + controlBar + regrToggleRow + wddBtn + wddNotice + regrPanel + chartSection + tableSection;

    if (udNormChartVis) {
      setTimeout(() => {
        drawNormChart('normChart', rows, unit, metric, weatherDDLabel, bills, incl);
      }, 120);
    }
  } catch (e) {
    pane.innerHTML =
      '<div style="padding:20px;color:var(--danger);font-family:var(--mono);font-size:12px;white-space:pre-wrap">⚠️ Render error in Normalized tab:\n' +
      e.stack +
      '</div>';
  }
}

function maStat(val, unit, lbl) {
  return (
    '<div class="ma-stat"><div class="ma-stat-lbl">' +
    lbl +
    '</div>' +
    '<div class="ma-stat-val">' +
    val +
    '<span class="ma-stat-unit"> ' +
    unit +
    '</span></div></div>'
  );
}
function blPill(val, lbl, color) {
  return (
    '<div style="display:flex;flex-direction:column;background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;min-width:0">' +
    '<span style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">' +
    lbl +
    '</span>' +
    '<span style="font-size:12px;font-weight:700;color:' +
    (color || 'var(--text)') +
    ';white-space:nowrap">' +
    val +
    '</span>' +
    '</div>'
  );
}

function drawNormChart(canvasId, rows, unit, metric, weatherDDLabel, bills, incl) {
  weatherDDLabel = weatherDDLabel || 'DD';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }
  const isElec = unit === 'kWh';
  const isGasU = unit === 'Therms';
  const isPropaneU = unit === 'Gallons';
  const labels = rows.map((r) => r.label);
  const blColor = rows.map((r) => (r.isBaseline ? 'rgba(0,212,170,0.85)' : 'rgba(100,160,255,0.75)'));
  const hasRegr = rows.some((r) => r.regrBaseline != null);

  let yLabel, tooltipFmt;
  if (metric === 'weather') {
    yLabel = unit + '/' + weatherDDLabel;
    tooltipFmt = (v) => (v != null ? v.toFixed(3) + ' ' + unit + '/' + weatherDDLabel : 'No data');
  } else if (metric === 'total') {
    yLabel = unit + '/Month';
    tooltipFmt = (v) => (v != null ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit : '—');
  } else {
    yLabel = unit + '/Day';
    tooltipFmt = (v) => (v != null ? v.toFixed(2) + ' ' + unit + '/day' : '—');
  }

  const datasets = [];

  if (metric === 'weather') {
    // Weather-normalized: single bar series, no raw bills
    const weatherData = rows.map((r) => (r.weatherNorm != null ? +r.weatherNorm.toFixed(3) : null));
    datasets.push({
      label: yLabel,
      data: weatherData,
      backgroundColor: blColor,
      borderColor: blColor.map((c) => c.replace('0.75', '1').replace('0.85', '1')),
      borderWidth: 1,
      borderRadius: 3,
      order: 2,
    });
  } else {
    // Non-weather metrics: bars = Normalized Baseline (when available), line = Raw Bills
    if (hasRegr) {
      const regrData = rows.map((r) => {
        if (r.regrBaseline == null) return null;
        if (metric === 'total') return +r.regrBaseline.toFixed(0);
        return r.normDays > 0 ? +(r.regrBaseline / r.normDays).toFixed(2) : null;
      });
      datasets.push({
        label: 'Normalized Baseline',
        data: regrData,
        backgroundColor: blColor,
        borderColor: blColor.map((c) => c.replace('0.75', '1').replace('0.85', '1')),
        borderWidth: 1,
        borderRadius: 3,
        order: 2,
      });
    } else {
      // No regression yet — fall back to prorated usage bars until weather model is built
      const fallbackData =
        metric === 'total' ? rows.map((r) => +r.usage.toFixed(0)) : rows.map((r) => +r.usagePerDay.toFixed(2));
      datasets.push({
        label: yLabel + ' (Prorated)',
        data: fallbackData,
        backgroundColor: blColor,
        borderColor: blColor.map((c) => c.replace('0.75', '1').replace('0.85', '1')),
        borderWidth: 1,
        borderRadius: 3,
        order: 2,
      });
    }
    // Raw Bills line (amber) — always shown when bills available
    if (bills && bills.length) {
      const billByYm = {};
      bills.forEach((b) => {
        if (!b.start || !b.end) return;
        const ym = normMonth(b.start, b.end, incl, bills);
        const usage = isElec
          ? parseFloat(b.kwh) || 0
          : isGasU
            ? parseFloat(b.therms) || 0
            : isPropaneU
              ? parseFloat(b.gallonsDelivered) || parseFloat(b.kwh) || 0
              : parseFloat(b.usage) || 0; // Bug #139: propane uses gallonsDelivered
        const days = Math.max(1, parseInt(calcDays(b.start, b.end, incl)) || 1);
        if (!billByYm[ym] || usage > 0) billByYm[ym] = { usage, days, perDay: +(usage / days).toFixed(2) };
      });
      datasets.push({
        label: unit + '/Month (Raw Bills)',
        data: rows.map((r) => {
          const bd = billByYm[r.ym];
          return bd ? (metric === 'total' ? +bd.usage.toFixed(0) : bd.perDay) : null;
        }),
        type: 'line',
        borderColor: 'rgba(245,158,11,0.85)',
        backgroundColor: 'rgba(245,158,11,0.12)',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: 'rgba(245,158,11,1)',
        tension: 0.3,
        fill: false,
        order: 1,
      });
    }
  }

  const showLegend = metric !== 'weather';
  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: showLegend,
          labels: { color: 'rgba(200,210,230,0.85)', font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (ctx.dataset.label === 'Normalized Baseline')
                return (
                  'Normalized Baseline: ' +
                  (metric === 'total' ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)) +
                  ' ' +
                  yLabel
                );
              return ctx.dataset.label + ': ' + tooltipFmt(v);
            },
          },
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.10)' } },
        y: {
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: yLabel, font: { size: 10 } },
        },
      },
    },
  });
}

function updateBillWeather(mid, rowId, field, val) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;
  const row = m.bills.find((r) => r.id === rowId);
  if (!row) return;
  row[field] = parseFloat(val) || 0;
  saveUtilityData();
  // Don't re-render — user is editing inline, just save
}

/* ══════════════════════════════════════════
         WEATHER DATA — CSV Upload
         User uploads CSV: month, year, hdd, cdd, avg_temp
         Cached by ZIP in DB (en_wdd_{ZIP}).
      ══════════════════════════════════════════ */

let _wddMid = null;
let _wddParsed = [];

function wddCacheKey(zip) {
  return 'en_wdd_' + zip.replace(/\s/g, '');
}
function wddLoadCache(zip) {
  try {
    return DB.get(wddCacheKey(zip)) || [];
  } catch (e) {
    return [];
  }
}
function wddSaveCache(zip, rows) {
  try {
    DB.set(wddCacheKey(zip), rows);
  } catch (e) {}
}
// Async fallback: if DB has no weather data for this ZIP, try to load
// the static JSON file that scripts/fetch-weather.js writes to weather-data/.
// DB acts as the manual override layer — if data is already there
// (from a CSV upload or a previous fetch), we leave it alone.
// Called fire-and-forget from udSelectBldg; never blocks the sync call path.
async function wddPrefetchFromServer(zip) {
  if (!zip) return;
  try {
    // Only fetch if DB has no weather data for this ZIP
    const existing = wddLoadCache(zip);
    if (existing.length) return;
    const res = await fetch('weather-data/' + encodeURIComponent(zip) + '.json');
    if (!res.ok) return; // file not published yet — silently skip
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return;
    wddSaveCache(zip, rows);
    // Re-render the current view so weather data appears without a manual refresh
    if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
  } catch (e) {
    // Network error or JSON parse failure — silently skip, user can still upload CSV
  }
}
function wddSetStatus(msg, color) {
  const el = document.getElementById('wddStatus');
  if (el) {
    el.textContent = msg;
    el.style.color = color || 'var(--text2)';
  }
}

function openWddModal(mid) {
  _wddMid = mid;
  _wddParsed = [];
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const zip = b?.zip || '';
  document.getElementById('wddPreview').style.display = 'none';
  document.getElementById('wddApplyBtn').style.display = 'none';
  document.getElementById('wddDropLabel').textContent = '📁 Drop CSV or click to upload';
  document.getElementById('wddDropZone').classList.remove('drag');
  if (!zip) {
    wddSetStatus('⚠️ No ZIP code set — edit this building to add one.', 'var(--warn)');
  } else {
    const cache = wddLoadCache(zip);
    const latest = cache.length ? cache.slice().sort((a, b) => b.ym.localeCompare(a.ym))[0].ym : null;
    if (latest) {
      wddSetStatus(
        '✓ ' +
          cache.length +
          ' months cached through ' +
          fmtMon(latest + '-01') +
          '. Upload a CSV to add or update months.',
        'var(--em)',
      );
      _wddParsed = cache;
      wddShowPreview(cache);
    } else {
      wddSetStatus('ZIP: ' + zip + ' — no weather data yet. Upload a CSV to get started.');
    }
  }
  document.getElementById('wddModal').classList.add('open');
}
function closeWddModal() {
  document.getElementById('wddModal').classList.remove('open');
  _wddMid = null;
  _wddParsed = [];
}

function wddHandleDrop(e) {
  e.preventDefault();
  document.getElementById('wddDropZone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  wddHandleFile(file);
}
function wddHandleFile(file) {
  if (!file) return;
  document.getElementById('wddDropLabel').textContent = '✓ ' + file.name;
  const reader = new FileReader();
  reader.onload = (ev) => wddParseCSV(ev.target.result);
  reader.readAsText(file);
}

function wddParseCSV(text) {
  const MONTHS = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);
  if (!lines.length) {
    wddSetStatus('⚠️ File is empty.', 'var(--warn)');
    return;
  }

  // Detect header row
  const firstCells = lines[0].split(/,|\t/).map((c) =>
    c
      .trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, ''),
  );
  const hasHeader = firstCells.some((c) => c.includes('month') || c.includes('hdd') || c.includes('year'));
  const dataLines = hasHeader ? lines.slice(1) : lines;

  // Map column positions
  let iMo = 0,
    iYr = 1,
    iHdd = 2,
    iCdd = 3,
    iTmp = 4;
  if (hasHeader) {
    firstCells.forEach((c, i) => {
      if (c.includes('month')) iMo = i;
      else if (c.includes('year')) iYr = i;
      else if (c.includes('hdd')) iHdd = i;
      else if (c.includes('cdd')) iCdd = i;
      else if (c.includes('avg') || c.includes('temp') || c.includes('mean')) iTmp = i;
    });
  }

  const results = [];
  let skipped = 0;
  dataLines.forEach((line) => {
    const cells = line.split(/,|\t/).map((c) => c.trim().replace(/"/g, ''));
    if (cells.length < 3) {
      skipped++;
      return;
    }
    const moRaw = (cells[iMo] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let mo = parseInt(moRaw);
    if (isNaN(mo)) mo = MONTHS[moRaw] || MONTHS[moRaw.slice(0, 3)] || 0;
    if (!mo || mo < 1 || mo > 12) {
      skipped++;
      return;
    }
    const yr = parseInt(cells[iYr] || 0);
    if (yr < 1990 || yr > 2100) {
      skipped++;
      return;
    }
    const ym = yr + '-' + String(mo).padStart(2, '0');
    const hdd = parseFloat(cells[iHdd]) || 0;
    const cdd = parseFloat(cells[iCdd]) || 0;
    const avgTemp = iTmp < cells.length ? parseFloat(cells[iTmp]) || 0 : 0;
    results.push({ ym, hdd, cdd, avgTemp });
  });

  if (!results.length) {
    wddSetStatus('⚠️ No valid rows found. Expected columns: month, year, hdd, cdd, avg_temp.', 'var(--warn)');
    return;
  }

  // Merge into ZIP cache
  const b = getUDBldg(udSelProjId, udSelBldgId);
  const zip = b?.zip || '';
  const cache = zip ? wddLoadCache(zip) : [];
  const cachedYms = new Set(cache.map((r) => r.ym));
  let added = 0,
    updated = 0;
  results.forEach((r) => {
    if (cachedYms.has(r.ym)) {
      const idx = cache.findIndex((c) => c.ym === r.ym);
      if (idx >= 0) {
        cache[idx] = r;
        updated++;
      }
    } else {
      cache.push(r);
      cachedYms.add(r.ym);
      added++;
    }
  });
  cache.sort((a, b) => a.ym.localeCompare(b.ym));
  if (zip) wddSaveCache(zip, cache);
  _wddParsed = cache;
  const skipNote = skipped ? ' (' + skipped + ' rows skipped)' : '';
  wddSetStatus(
    '✓ Parsed ' + results.length + ' months — ' + added + ' new, ' + updated + ' updated' + skipNote + '.',
    'var(--em)',
  );
  wddShowPreview(cache);
}

function wddShowPreview(rows) {
  const tbl = document.getElementById('wddPreviewTbl');
  const preview = document.getElementById('wddPreview');
  const applyBtn = document.getElementById('wddApplyBtn');
  if (!rows || !rows.length) {
    preview.style.display = 'none';
    applyBtn.style.display = 'none';
    return;
  }
  tbl.innerHTML =
    '<thead><tr><th>Month</th><th>HDD</th><th>CDD</th><th>Avg °F</th></tr></thead>' +
    '<tbody>' +
    rows
      .map(
        (r) => `
            <tr>
              <td class="mono">${fmtMon(r.ym + '-01')}</td>
              <td class="mono">${r.hdd != null ? r.hdd : '—'}</td>
              <td class="mono">${r.cdd != null ? r.cdd : '—'}</td>
              <td class="mono">${r.avgTemp ? r.avgTemp + '°' : '—'}</td>
            </tr>`,
      )
      .join('') +
    '</tbody>';
  preview.style.display = '';
  applyBtn.style.display = '';
  applyBtn.textContent = '✓ Save ' + rows.length + ' Months of Weather Data for ZIP';
}

function wddApplyParsed() {
  if (!_wddParsed.length) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const zip = b?.zip || '';
  // Save weather data to ZIP cache — getNormRows now reads from this cache directly
  if (zip) wddSaveCache(zip, _wddParsed);
  closeWddModal();
  showToast('Weather data saved — ' + _wddParsed.length + ' months loaded for ZIP ' + zip + ' ✓');
  if (udActiveTab === 'norm') renderMeterWorkspace();
}
/* ══════════════════════════════════════════
         BASELINE TAB
      ══════════════════════════════════════════ */
function renderBaselinePane(pane, m, bills, incl) {
  if (bills.length < 3) {
    pane.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">📊</div><div>Add at least 3 months of bill data to set a baseline</div></div>';
    return;
  }
  const isElec = m.commodity === 'Electric';
  const unit = getMeterDisplayUnit(m);
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const rows = getNormRows(m, bills, incl, weatherByYm);
  const bl = m.baseline || null;

  const blMonths = bl && bl.months ? bl.months : [];
  const blRows = rows.filter((r) => blMonths.includes(r.ym));
  const hasBl = blRows.length >= 3;

  // Summary stats
  const b3 = getUDBldg(udSelProjId, udSelBldgId);
  const sqftBl = parseInt(b3?.sqft) || 0;
  const hasEUI_bl = m.commodity === 'Electric' && sqftBl > 0;
  const proj_bl = getUDProj(udSelProjId);
  const normBasis_bl = proj_bl?.normBasis || 'calendar';
  let blStatsInner = '';
  if (hasBl) {
    const avg = blRows.reduce((s, r) => s + r.usagePerDay, 0) / blRows.length;
    const avgMo = blRows.reduce((s, r) => s + r.usage, 0) / blRows.length;
    const total = blRows.reduce((s, r) => s + r.usage, 0);
    const cost = blRows.reduce((s, r) => s + r.cost, 0);
    const hddBlRows = blRows.filter((r) => (isElec ? r.cdd : r.hdd) != null && (isElec ? r.cdd : r.hdd) > 0);
    const avgHDD = hddBlRows.length
      ? hddBlRows.reduce((s, r) => s + (isElec ? r.cdd : r.hdd), 0) / hddBlRows.length
      : null;
    const blEUI = hasEUI_bl ? (toKBtu(total / blRows.length, 0, 0) * 12) / sqftBl : null;
    const regrBlRows = blRows.filter((r) => r.regrBaseline != null);
    const avgRegrBl = regrBlRows.length ? regrBlRows.reduce((s, r) => s + r.regrBaseline, 0) / regrBlRows.length : null;

    // ── Rate calculations using energyCost (totalCost - kwCost) to match Meter Data $/kWh column ──
    // Build energyCost per norm-month from baseline bills
    const blBillsForRate = bills.filter((b) => {
      const ym = normMonth(b.start, b.end, incl, bills);
      return blMonths.includes(ym);
    });
    const energyCostByYm = {};
    blBillsForRate.forEach((b) => {
      const ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      const kwC = parseFloat(b.kwCost || 0) + parseFloat(b.facKWCost || 0);
      const ec = parseFloat(b.totalCost || 0) - kwC;
      energyCostByYm[ym] = (energyCostByYm[ym] || 0) + ec;
    });
    const costRows = blRows.filter((r) => r.usage > 0 && energyCostByYm[r.ym] > 0);
    const avgRatePerUnit = costRows.length
      ? costRows.reduce((s, r) => s + energyCostByYm[r.ym] / r.usage, 0) / costRows.length
      : null;

    // Summer/Winter $/kW demand — electric only, split by season
    let summerKwRate = null,
      winterKwRate = null;
    if (m.commodity === 'Electric') {
      const demandBills = blBillsForRate.filter((b) => (b.demandKW || 0) > 0 && (b.kwCost || 0) > 0);
      const sumDem = demandBills.filter((b) => {
        const mo = _parseISO(b.start).getMonth() + 1;
        return mo >= 6 && mo <= 9;
      });
      const winDem = demandBills.filter((b) => {
        const mo = _parseISO(b.start).getMonth() + 1;
        return mo === 12 || mo <= 3;
      });
      summerKwRate = sumDem.length ? sumDem.reduce((s, b) => s + b.kwCost / b.demandKW, 0) / sumDem.length : null;
      winterKwRate = winDem.length ? winDem.reduce((s, b) => s + b.kwCost / b.demandKW, 0) / winDem.length : null;
    }

    // Summer (Jun–Sep) vs Winter (Dec–Mar) $/unit rates using energyCost
    const summerRows = costRows.filter((r) => {
      const mo = parseInt(r.ym.split('-')[1]);
      return mo >= 6 && mo <= 9;
    });
    const winterRows = costRows.filter((r) => {
      const mo = parseInt(r.ym.split('-')[1]);
      return mo === 12 || mo <= 3;
    });
    const summerRate = summerRows.length
      ? summerRows.reduce((s, r) => s + energyCostByYm[r.ym] / r.usage, 0) / summerRows.length
      : null;
    const winterRate = winterRows.length
      ? winterRows.reduce((s, r) => s + energyCostByYm[r.ym] / r.usage, 0) / winterRows.length
      : null;

    const fmtRate = (v) =>
      v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 }) : null;
    const fmtKw = (v) => (v != null ? '$' + v.toFixed(3) : null);

    // Build compact pill strip
    const pills = [
      { v: blRows.length + ' mo', lbl: 'Period' },
      { v: avgMo.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit + '/mo', lbl: 'Avg Use' },
      { v: avg.toFixed(1) + ' ' + unit + '/day', lbl: 'Avg/Day' },
      avgRegrBl != null
        ? {
            v: avgRegrBl.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit + '/mo',
            lbl: 'Reg.BL',
            color: 'var(--violet)',
          }
        : null,
      cost > 0 ? { v: '$' + cost.toLocaleString(undefined, { maximumFractionDigits: 0 }), lbl: 'Total Cost' } : null,
      avgHDD != null
        ? { v: avgHDD.toFixed(0) + (isElec ? ' CDD' : ' HDD'), lbl: 'Avg ' + (isElec ? 'CDD' : 'HDD') }
        : null,
      blEUI != null ? { v: blEUI.toFixed(1) + ' kBtu/sf/yr', lbl: 'Site EUI' } : null,
      avgRatePerUnit != null
        ? { v: fmtRate(avgRatePerUnit) + '/' + unit, lbl: 'Blended Rate', color: 'var(--em2)' }
        : null,
      // #96: Propane has no seasonal pricing — skip summer/winter rate pills
      summerRate != null && m.commodity !== 'Propane'
        ? { v: fmtRate(summerRate) + '/' + unit, lbl: '☀️ Summer Rate', color: 'var(--warn)' }
        : null,
      winterRate != null && m.commodity !== 'Propane'
        ? { v: fmtRate(winterRate) + '/' + unit, lbl: '❄️ Winter Rate', color: 'var(--em)' }
        : null,
      summerKwRate != null ? { v: fmtKw(summerKwRate) + '/kW', lbl: '☀️ Summer $/kW', color: 'var(--warn)' } : null,
      winterKwRate != null ? { v: fmtKw(winterKwRate) + '/kW', lbl: '❄️ Winter $/kW', color: 'var(--em)' } : null,
      // #101: Regression model type indicator
      (() => {
        // Baseline exists but bl.reg is null — saved before weather data was uploaded
        if (bl && !bl.reg) {
          return { v: 'Not frozen', lbl: '⚠️ Not frozen — re-save baseline', color: 'var(--warn)' };
        }
        const _blReg = bl && bl.reg ? bl.reg : m._reg;
        if (!_blReg) return null;
        let _modelLabel, _modelColor;
        if (_blReg.dual) {
          _modelLabel = 'Dual (HDD+CDD)';
          _modelColor = 'var(--violet)';
        } else if (_blReg.cdd && _blReg.hdd) {
          _modelLabel = 'CDD + HDD';
          _modelColor = 'var(--violet)';
        } else if (_blReg.cdd) {
          _modelLabel = 'CDD only';
          _modelColor = 'var(--warn)';
        } else if (_blReg.hdd) {
          _modelLabel = 'HDD only';
          _modelColor = 'var(--em2)';
        } else {
          return null;
        }
        const _isFrozen = !!(bl && bl.reg);
        return { v: _modelLabel, lbl: _isFrozen ? '🔒 Frozen Model' : '⚡ Live Model', color: _modelColor };
      })(),
    ].filter(Boolean);

    blStatsInner =
      '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0">' +
      pills
        .map(
          (
            p,
          ) => `<div style="display:flex;flex-direction:column;background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 10px;min-width:0">
              <span style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap">${p.lbl}</span>
              <span style="font-size:12px;font-weight:700;color:${p.color || 'var(--text)'};white-space:nowrap">${p.v}</span>
            </div>`,
        )
        .join('') +
      '</div>';
  }

  // Month checkboxes
  const rowChecks = rows
    .map((r) => {
      const checked = blMonths.includes(r.ym);
      const hddNote =
        (isElec ? r.cdd : r.hdd) != null ? ' · ' + (isElec ? r.cdd : r.hdd) + (isElec ? ' CDD' : ' HDD') : '';
      const dispUsage = r.regrBaseline != null ? r.regrBaseline : r.usage;
      const dispPerDay = r.regrBaseline != null && r.normDays > 0 ? r.regrBaseline / r.normDays : r.usagePerDay;
      const normTag =
        r.regrBaseline != null ? ' <span style="font-size:9px;color:var(--violet);opacity:.8">(norm)</span>' : '';
      return (
        '<label class="bl-period-row" style="cursor:pointer">' +
        '<input type="checkbox" value="' +
        r.ym +
        '" ' +
        (checked ? 'checked' : '') +
        ' onchange="updateBaselineRange(\'' +
        m.id +
        '\')" style="accent-color:var(--em);width:14px;height:14px;flex-shrink:0">' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' +
        r.label +
        '</div>' +
        '<div style="font-size:11px;color:var(--text2)">' +
        dispUsage.toLocaleString(undefined, { maximumFractionDigits: 0 }) +
        ' ' +
        unit +
        normTag +
        ' · ' +
        dispPerDay.toFixed(1) +
        '/day' +
        hddNote +
        '</div>' +
        '</div>' +
        (checked
          ? '<span class="bl-badge" style="font-size:10px;background:var(--em-dim);color:var(--em);border:1px solid rgba(0,212,170,.2);border-radius:4px;padding:2px 7px">✓ BL</span>'
          : '') +
        '</label>'
      );
    })
    .join('');

  // Chart control bar
  const hasRegrBl = rows.some((r) => r.regrBaseline != null);
  const chartBtnLabel = udBlChartVis ? '📉 Hide Chart' : '📊 Show Chart';
  const blChartLabel =
    (udBlMetric === 'total' ? unit + '/Month — Baseline Highlighted' : unit + '/Day — Baseline Highlighted') +
    (udBlOverlay ? ' + Raw Bills' : '') +
    (hasRegrBl ? ' + Normalized Baseline' : '');
  const blControlBar =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:10px">' +
    '<button class="ud-incl-btn" onclick="toggleBlChart()" style="background:var(--s3);border-color:var(--border2);color:var(--text2)">' +
    chartBtnLabel +
    '</button>' +
    '<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>' +
    '<span style="font-size:11px;color:var(--text2)">Metric:</span>' +
    '<button class="ud-incl-btn' +
    (udBlMetric === 'total' ? ' sel' : '') +
    '" onclick="setBlMetric(\'total\')">' +
    unit +
    '/Month</button>' +
    '<button class="ud-incl-btn' +
    (udBlMetric === 'perday' ? ' sel' : '') +
    '" onclick="setBlMetric(\'perday\')">' +
    unit +
    '/Day</button>' +
    (udBlChartVis
      ? '<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>' +
        '<span style="font-size:11px;color:var(--text2)">Overlay:</span>' +
        '<button class="ud-incl-btn' +
        (udBlOverlay ? ' sel' : '') +
        '" onclick="toggleBlOverlay()">📋 Raw Bills</button>'
      : '') +
    '</div>';

  // Chart section
  const chartSection = udBlChartVis
    ? '<div style="margin-bottom:14px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">' +
      blChartLabel +
      '</div>' +
      '<div class="ma-chart-wrap"><canvas id="blChart"></canvas></div>' +
      '</div>'
    : '';

  // Normalization basis note
  const basisNote =
    '<div style="font-size:11px;color:var(--text3);margin-bottom:10px;padding:6px 10px;background:var(--s3);border-radius:5px;border:1px solid var(--border)">' +
    '📐 Period basis: <strong>' +
    (normBasis_bl === 'calendar' ? 'Calendar month days' : 'Actual bill days') +
    '</strong> — change in Normalized tab</div>';

  // ── kW demand chart (electric only, baseline months) ──
  const isElecBl = m.commodity === 'Electric';
  let kwChartSection = '';
  const kwByYm = {};
  let _blKwReg = null;
  const _blKwNormByYm = {};
  if (isElecBl && hasBl) {
    blRows.forEach((r) => {
      const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
      const demKW = bfr.reduce((s, b) => s + parseFloat(b.demandKW || 0), 0) / Math.max(1, bfr.length);
      const bilKW = bfr.reduce((s, b) => s + parseFloat(b.billedKW || b.demandKW || 0), 0) / Math.max(1, bfr.length);
      if (demKW > 0 || bilKW > 0) kwByYm[r.ym] = { label: r.label, demKW, bilKW };
    });

    // ── CDD regression for normalized kW baseline line ──
    _blKwReg = (() => {
      const pts = blRows
        .map((r) => {
          const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
          const kw = bfr.length ? bfr.reduce((s, b) => s + (parseFloat(b.demandKW) || 0), 0) / bfr.length : 0;
          return { x: r.cdd != null ? r.cdd : 0, y: kw };
        })
        .filter((p) => p.y > 0);
      if (pts.length < 3) return null;
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p.x, 0) / n;
      const my = pts.reduce((s, p) => s + p.y, 0) / n;
      const ssxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
      const ssxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
      if (ssxx === 0) return null;
      const slope = ssxy / ssxx;
      const intercept = my - slope * mx;
      return { slope, intercept };
    })();
    if (_blKwReg) {
      blRows.forEach((r) => {
        const cdd = r.cdd != null ? r.cdd : 0;
        _blKwNormByYm[r.ym] = Math.max(0, _blKwReg.intercept + _blKwReg.slope * cdd);
      });
    }

    if (Object.keys(kwByYm).length) {
      kwChartSection =
        '<div style="margin-bottom:14px">' +
        '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">kW Demand — Baseline Period</div>' +
        '<div class="ma-chart-wrap" style="height:220px"><canvas id="blKwChart" style="height:188px"></canvas></div>' +
        '</div>';
    }
  }

  // ── Baseline validation warnings ──
  let blWarnings = '';
  if (hasBl) {
    const warns = [];
    // 1. Check < 12 months
    if (blRows.length < 12) {
      warns.push(
        '⚠ Only ' +
          blRows.length +
          ' month' +
          (blRows.length !== 1 ? 's' : '') +
          ' selected. A minimum of 12 consecutive months is recommended for a reliable baseline.',
      );
    }
    // 2. Check for gaps (non-concurrent months)
    const sortedYms = blRows.map((r) => r.ym).sort();
    for (let gi = 1; gi < sortedYms.length; gi++) {
      const [py, pm] = sortedYms[gi - 1].split('-').map(Number);
      const [cy, cm] = sortedYms[gi].split('-').map(Number);
      const expected = pm === 12 ? py + 1 + '-01' : py + '-' + (pm + 1 < 10 ? '0' : '') + (pm + 1);
      if (sortedYms[gi] !== expected) {
        warns.push(
          '⚠ Gap detected between ' +
            sortedYms[gi - 1] +
            ' and ' +
            sortedYms[gi] +
            '. Baseline months should be consecutive for accurate regression analysis.',
        );
        break;
      }
    }
    if (warns.length) {
      blWarnings =
        '<div style="margin-bottom:10px">' +
        warns
          .map(
            (w) =>
              '<div style="font-size:12px;color:var(--amber);background:var(--amber-dim);border:1px solid rgba(245,158,11,.25);border-radius:6px;padding:8px 12px;margin-bottom:6px;font-weight:500">' +
              w +
              '</div>',
          )
          .join('') +
        '</div>';
    }
  }

  pane.innerHTML =
    // ── Control bar ──
    blControlBar +
    basisNote +
    // ── Baseline validation warnings ──
    blWarnings +
    // ── Compact stats strip ──
    '<div id="blStatsWrap" style="margin-bottom:10px">' +
    blStatsInner +
    '</div>' +
    // ── kWh Chart ──
    chartSection +
    // ── kW Demand Chart ──
    kwChartSection +
    // ── Period selector (collapsible) ──
    '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:6px">' +
    '<button onclick="toggleBlPeriodPanel()" id="blPeriodToggleBtn" style="' +
    'width:100%;display:flex;align-items:center;justify-content:space-between;' +
    'padding:9px 14px;background:var(--s3);border:none;cursor:pointer;' +
    'font-size:12px;font-weight:600;color:var(--text2);font-family:var(--font)">' +
    '<span>📅 Baseline Period — ' +
    (hasBl ? blRows.length + ' months selected' : 'No months selected') +
    '</span>' +
    '<span id="blPeriodArrow" style="font-size:11px;color:var(--text3)">▼ Expand</span>' +
    '</button>' +
    '<div id="blPeriodPanel" style="display:none;padding:12px 14px;border-top:1px solid var(--border)">' +
    '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">Check months to include in baseline. Typical baseline is 12–36 months.</div>' +
    '<div id="blPeriodList" style="max-height:320px;overflow-y:auto;margin-bottom:10px">' +
    rowChecks +
    '</div>' +
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
    '<button class="btn btn-ghost btn-sm" onclick="blSelectAll(\'' +
    m.id +
    '\',true)">Select All</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="blSelectAll(\'' +
    m.id +
    '\',false)">Clear</button>' +
    '<button id="blSaveBtn" class="btn btn-em btn-sm" style="margin-left:auto' +
    (hasBl ? '' : ';display:none') +
    '" onclick="saveBaseline(\'' +
    m.id +
    '\')">✅ Save' +
    (hasBl ? ' (' + blRows.length + ' mo)' : '') +
    '</button>' +
    '<button class="btn btn-ghost btn-sm" style="' +
    (hasBl ? '' : 'display:none;') +
    'font-size:11px" onclick="saveBaselineToAllMeters(\'' +
    m.id +
    '\')" title="Apply this baseline period to all other meters in this building">📋 Apply to All Meters</button>' +
    '<button class="btn btn-ghost btn-sm" style="' +
    (hasBl ? '' : 'display:none;') +
    'font-size:11px;color:var(--accent)" onclick="saveBaselineToAllProjectMeters(\'' +
    m.id +
    '\')" title="Apply this baseline period to every meter across ALL buildings in this project">📋 Apply to All in Project</button>' +
    '</div>' +
    '</div>' +
    '</div>';

  // Attach baseline save button tooltip (deferred so DOM is ready)
  requestAnimationFrame(attachBaselineSaveTip);

  if (udBlChartVis) {
    requestAnimationFrame(() => {
      drawBlChart('blChart', blRows, unit, bills, incl, udBlOverlay, udBlMetric);
    });
  }
  // Draw kW demand chart if applicable
  if (isElecBl && hasBl && kwChartSection) {
    requestAnimationFrame(() => {
      const kwCanvas = document.getElementById('blKwChart');
      if (!kwCanvas) return;
      if (_maCharts['blKwChart']) {
        _maCharts['blKwChart'].destroy();
      }
      const kwEntries = blRows.map((r) => kwByYm[r.ym]).filter(Boolean);
      const kwLabels = kwEntries.map((e) => e.label);
      const hasBilKW = kwEntries.some((e) => e.bilKW > 0 && Math.abs(e.bilKW - e.demKW) > 0.5);
      const datasets = [];
      datasets.push({
        label: 'Actual kW',
        data: kwEntries.map((e) => +e.demKW.toFixed(1)),
        backgroundColor: 'rgba(100,180,255,0.75)',
        borderColor: 'rgba(100,180,255,1)',
        borderWidth: 1,
        borderRadius: 3,
      });
      if (hasBilKW) {
        datasets.push({
          label: 'Billed kW',
          data: kwEntries.map((e) => +e.bilKW.toFixed(1)),
          backgroundColor: 'rgba(147,210,255,0.55)',
          borderColor: 'rgba(147,210,255,1)',
          borderWidth: 1,
          borderRadius: 3,
        });
      }
      const _hasBlNormKw = _blKwReg && Object.keys(_blKwNormByYm).length > 0;
      if (_hasBlNormKw) {
        const kwEntriesYm = blRows.filter((r) => kwByYm[r.ym]).map((r) => r.ym);
        datasets.push({
          label: 'Normalized kW Baseline',
          type: 'line',
          data: kwEntriesYm.map((ym) => {
            const v = _blKwNormByYm[ym];
            return v != null ? +v.toFixed(1) : null;
          }),
          borderColor: 'rgba(139,92,246,0.9)',
          backgroundColor: 'transparent',
          pointBackgroundColor: 'rgba(139,92,246,1)',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 3,
          tension: 0.3,
          order: 0,
        });
      }
      _maCharts['blKwChart'] = new Chart(kwCanvas, {
        type: 'bar',
        data: { labels: kwLabels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: hasBilKW || _hasBlNormKw,
              position: 'top',
              labels: { color: 'rgba(200,220,240,0.9)', font: { size: 11 }, boxWidth: 12, padding: 12 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ' ' +
                  ctx.dataset.label +
                  ': ' +
                  ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) +
                  ' kW',
              },
            },
          },
          scales: {
            x: {
              ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,0.10)' },
            },
            y: {
              beginAtZero: true,
              ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 } },
              grid: { color: 'rgba(255,255,255,0.12)' },
              title: { display: true, text: 'kW', color: 'rgba(160,185,210,0.8)', font: { size: 11 } },
            },
          },
        },
      });
    });
  }
}

function toggleBlPeriodPanel() {
  const panel = document.getElementById('blPeriodPanel');
  const arrow = document.getElementById('blPeriodArrow');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  if (arrow) arrow.textContent = open ? '▲ Collapse' : '▼ Expand';
}

function updateBaselineRange(mid) {
  const checked = [...document.querySelectorAll('#blPeriodList input[type=checkbox]:checked')]
    .map((c) => c.value)
    .sort();
  if (checked.length < 1) return;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;
  m.baseline = { ...(m.baseline || {}), start: checked[0], end: checked[checked.length - 1], months: checked };
  saveUtilityData();
  // Update stats + chart in-place without re-rendering the checkbox list (preserves scroll)
  refreshBaselineStats(mid);
}

function refreshBaselineStats(mid) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;
  const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const incl = m.inclusive !== false;
  const isElec = m.commodity === 'Electric';
  const unit = getMeterDisplayUnit(m);
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const rows = getNormRows(m, bills, incl, weatherByYm);
  const bl = m.baseline;
  const blRows = bl && bl.months ? rows.filter((r) => bl.months.includes(r.ym)) : [];
  const hasBl = blRows.length >= 3;

  // Update label badges on checkboxes
  document.querySelectorAll('#blPeriodList .bl-period-row').forEach((label) => {
    const cb = label.querySelector('input[type=checkbox]');
    let badge = label.querySelector('.bl-badge');
    if (cb.checked) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'bl-badge';
        badge.style.cssText =
          'font-size:10px;background:var(--em-dim);color:var(--em);border:1px solid rgba(0,212,170,.2);border-radius:4px;padding:2px 7px';
        label.appendChild(badge);
      }
      badge.textContent = '✓ BL';
    } else {
      if (badge) badge.remove();
    }
  });

  // Update stats
  const b4 = getUDBldg(udSelProjId, udSelBldgId);
  const sqftR = parseInt(b4?.sqft) || 0;
  const hasEUI_r = m.commodity === 'Electric' && sqftR > 0;
  const statsEl = document.getElementById('blStatsWrap');
  const blMonths2 = bl && bl.months ? bl.months : [];
  if (statsEl && hasBl) {
    const avg = blRows.reduce((s, r) => s + r.usagePerDay, 0) / blRows.length;
    const avgMo = blRows.reduce((s, r) => s + r.usage, 0) / blRows.length;
    const total = blRows.reduce((s, r) => s + r.usage, 0);
    const cost = blRows.reduce((s, r) => s + r.cost, 0);
    const hddBlR = blRows.filter((r) => (isElec ? r.cdd : r.hdd) != null && (isElec ? r.cdd : r.hdd) > 0);
    const avgHDD = hddBlR.length ? hddBlR.reduce((s, r) => s + (isElec ? r.cdd : r.hdd), 0) / hddBlR.length : null;
    const blEUI = hasEUI_r ? (toKBtu(total / blRows.length, 0, 0) * 12) / sqftR : null;
    const regrBlR = blRows.filter((r) => r.regrBaseline != null);
    const avgRegrBl = regrBlR.length ? regrBlR.reduce((s, r) => s + r.regrBaseline, 0) / regrBlR.length : null;

    // Rate calculations using energyCost (totalCost - kwCost) to match Meter Data $/kWh column
    const inclFlag = m.inclusive !== false;
    const blBillsR = bills.filter((b) => blMonths2.includes(normMonth(b.start, b.end, inclFlag, bills)));
    const eCostByYm2 = {};
    blBillsR.forEach((b) => {
      const ym = normMonth(b.start, b.end, inclFlag, bills);
      if (!ym) return;
      const kwC = parseFloat(b.kwCost || 0) + parseFloat(b.facKWCost || 0);
      eCostByYm2[ym] = (eCostByYm2[ym] || 0) + parseFloat(b.totalCost || 0) - kwC;
    });
    const costRows = blRows.filter((r) => r.usage > 0 && eCostByYm2[r.ym] > 0);
    const avgRatePerUnit = costRows.length
      ? costRows.reduce((s, r) => s + eCostByYm2[r.ym] / r.usage, 0) / costRows.length
      : null;
    let summerKwRate = null,
      winterKwRate = null;
    if (m.commodity === 'Electric') {
      const dBills = blBillsR.filter((b) => (b.demandKW || 0) > 0 && (b.kwCost || 0) > 0);
      const sumDem = dBills.filter((b) => {
        const mo = _parseISO(b.start).getMonth() + 1;
        return mo >= 6 && mo <= 9;
      });
      const winDem = dBills.filter((b) => {
        const mo = _parseISO(b.start).getMonth() + 1;
        return mo === 12 || mo <= 3;
      });
      summerKwRate = sumDem.length ? sumDem.reduce((s, b) => s + b.kwCost / b.demandKW, 0) / sumDem.length : null;
      winterKwRate = winDem.length ? winDem.reduce((s, b) => s + b.kwCost / b.demandKW, 0) / winDem.length : null;
    }
    const sumR = costRows.filter((r) => {
      const mo = parseInt(r.ym.split('-')[1]);
      return mo >= 6 && mo <= 9;
    });
    const winR = costRows.filter((r) => {
      const mo = parseInt(r.ym.split('-')[1]);
      return mo === 12 || mo <= 3;
    });
    const summerRate = sumR.length ? sumR.reduce((s, r) => s + eCostByYm2[r.ym] / r.usage, 0) / sumR.length : null;
    const winterRate = winR.length ? winR.reduce((s, r) => s + eCostByYm2[r.ym] / r.usage, 0) / winR.length : null;
    const fmtRate = (v) => (v != null ? '$' + v.toFixed(4) : null);
    const fmtKw = (v) => (v != null ? '$' + v.toFixed(2) : null);
    const unit2 = getMeterDisplayUnit(m);

    const pills = [
      { v: blRows.length + ' mo', lbl: 'Period' },
      { v: avgMo.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit2 + '/mo', lbl: 'Avg Use' },
      { v: avg.toFixed(1) + ' ' + unit2 + '/day', lbl: 'Avg/Day' },
      avgRegrBl != null
        ? {
            v: avgRegrBl.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit2 + '/mo',
            lbl: 'Reg.BL',
            color: 'var(--violet)',
          }
        : null,
      cost > 0 ? { v: '$' + cost.toLocaleString(undefined, { maximumFractionDigits: 0 }), lbl: 'Total Cost' } : null,
      avgHDD != null
        ? { v: avgHDD.toFixed(0) + (isElec ? ' CDD' : ' HDD'), lbl: 'Avg ' + (isElec ? 'CDD' : 'HDD') }
        : null,
      blEUI != null ? { v: blEUI.toFixed(1) + ' kBtu/sf/yr', lbl: 'Site EUI' } : null,
      avgRatePerUnit != null
        ? { v: fmtRate(avgRatePerUnit) + '/' + unit2, lbl: 'Blended Rate', color: 'var(--em2)' }
        : null,
      // #96: Propane has no seasonal pricing — skip summer/winter rate pills
      summerRate != null && m.commodity !== 'Propane'
        ? { v: fmtRate(summerRate) + '/' + unit2, lbl: '☀️ Summer Rate', color: 'var(--warn)' }
        : null,
      winterRate != null && m.commodity !== 'Propane'
        ? { v: fmtRate(winterRate) + '/' + unit2, lbl: '❄️ Winter Rate', color: 'var(--em)' }
        : null,
      summerKwRate != null ? { v: fmtKw(summerKwRate) + '/kW', lbl: '☀️ Summer $/kW', color: 'var(--warn)' } : null,
      winterKwRate != null ? { v: fmtKw(winterKwRate) + '/kW', lbl: '❄️ Winter $/kW', color: 'var(--em)' } : null,
    ].filter(Boolean);

    statsEl.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0">' +
      pills
        .map(
          (
            p,
          ) => `<div style="display:flex;flex-direction:column;background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 10px;min-width:0">
              <span style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap">${p.lbl}</span>
              <span style="font-size:12px;font-weight:700;color:${p.color || 'var(--text)'};white-space:nowrap">${p.v}</span>
            </div>`,
        )
        .join('') +
      '</div>';
  }

  // Redraw chart with current metric/overlay state
  if (udBlChartVis) {
    requestAnimationFrame(() => {
      drawBlChart('blChart', blRows, unit, bills, incl, udBlOverlay, udBlMetric);
    });
  }

  // Update save button and period toggle label
  const saveBtn = document.getElementById('blSaveBtn');
  if (saveBtn) {
    if (hasBl) {
      saveBtn.style.display = '';
      saveBtn.textContent = '✅ Save (' + (bl.months || []).length + ' mo)';
    } else saveBtn.style.display = 'none';
  }
  const toggleBtn = document.getElementById('blPeriodToggleBtn');
  if (toggleBtn) {
    const spanEl = toggleBtn.querySelector('span:first-child');
    if (spanEl)
      spanEl.textContent =
        '📅 Baseline Period — ' + (hasBl ? blRows.length + ' months selected' : 'No months selected');
  }
}

function blSelectAll(mid, sel) {
  document.querySelectorAll('#blPeriodList input[type=checkbox]').forEach((cb) => (cb.checked = sel));
  updateBaselineRange(mid);
}

function saveBaseline(mid) {
  const checked = [...document.querySelectorAll('#blPeriodList input[type=checkbox]:checked')]
    .map((c) => c.value)
    .sort();
  if (checked.length < 3) {
    showToast('Select at least 3 months');
    return;
  }
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;

  // Compute frozen regression from baseline-period rows ONLY and store it
  // This prevents post-baseline bills from ever changing the baseline model
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const allRows = getNormRows(
    m,
    (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start)),
    m.inclusive !== false,
    weatherByYm,
  );
  const blOnlyRows = allRows.filter((r) => checked.includes(r.ym));
  const frozenReg = computeMeterRegression(blOnlyRows);

  m.baseline = { start: checked[0], end: checked[checked.length - 1], months: checked, reg: frozenReg };
  saveUtilityData();
  const _blInherited = _inheritBaselinesForProject(udSelProjId);
  showToast(
    'Baseline saved — ' +
      checked.length +
      ' months' +
      (_blInherited ? ' · ' + _blInherited + ' other meter' + (_blInherited !== 1 ? 's' : '') + ' inherited' : '') +
      ' ✓',
  );
}

function saveBaselineToAllMeters(sourceMid) {
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const srcMeter = b.meters.find((m) => m.id === sourceMid);
  if (!srcMeter || !srcMeter.baseline || !srcMeter.baseline.months || srcMeter.baseline.months.length < 3) {
    showToast('Save a baseline on this meter first');
    return;
  }
  const blMonths = srcMeter.baseline.months;
  const otherMeters = b.meters.filter((m) => m.id !== sourceMid && (m.bills || []).length > 0);
  if (!otherMeters.length) {
    showToast('No other meters with bills in this building');
    return;
  }
  const { byYm: weatherByYm } = getWeatherForBuilding();
  let count = 0;
  otherMeters.forEach((m) => {
    const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const allRows = getNormRows(m, bills, m.inclusive !== false, weatherByYm);
    const validMonths = blMonths.filter((ym) => allRows.some((r) => r.ym === ym));
    if (validMonths.length < 3) return;
    const blOnlyRows = allRows.filter((r) => validMonths.includes(r.ym));
    const frozenReg = computeMeterRegression(blOnlyRows);
    m.baseline = {
      start: validMonths[0],
      end: validMonths[validMonths.length - 1],
      months: validMonths,
      reg: frozenReg,
    };
    count++;
  });
  if (count === 0) {
    showToast('No other meters had enough matching months (need 3+)');
    return;
  }
  saveUtilityData();
  showToast('Baseline applied to ' + count + ' other meter' + (count !== 1 ? 's' : '') + ' ✓');
}

function saveBaselineToAllProjectMeters(sourceMid) {
  const srcBldg = getUDBldg(udSelProjId, udSelBldgId);
  if (!srcBldg) return;
  const srcMeter = srcBldg.meters.find((m) => m.id === sourceMid);
  if (!srcMeter || !srcMeter.baseline || !srcMeter.baseline.months || srcMeter.baseline.months.length < 3) {
    showToast('Save a baseline on this meter first');
    return;
  }
  const blMonths = srcMeter.baseline.months;
  const allBldgs = getUDBldgs(udSelProjId);
  if (!allBldgs || !allBldgs.length) {
    showToast('No buildings in this project');
    return;
  }
  let count = 0;
  let skipped = 0;
  allBldgs.forEach((b) => {
    // Get weather data for this building's ZIP
    const zip = b.zip || '';
    let weatherByYm = null;
    if (zip) {
      const cache = wddLoadCache(zip);
      if (cache.length) {
        weatherByYm = {};
        cache.forEach((r) => {
          weatherByYm[r.ym] = r;
        });
      }
    }
    (b.meters || []).forEach((m) => {
      if (m.id === sourceMid) return; // skip source meter
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      if (!bills.length) {
        // No bills — still set baseline months so it's ready when data arrives
        m.baseline = {
          start: blMonths[0],
          end: blMonths[blMonths.length - 1],
          months: blMonths.slice(),
          reg: null,
        };
        count++;
        return;
      }
      const allRows = getNormRows(m, bills, m.inclusive !== false, weatherByYm);
      const validMonths = blMonths.filter((ym) => allRows.some((r) => r.ym === ym));
      if (validMonths.length < 3) {
        // Not enough matching bill data — still set the baseline months
        m.baseline = {
          start: blMonths[0],
          end: blMonths[blMonths.length - 1],
          months: blMonths.slice(),
          reg: null,
        };
        count++;
        skipped++;
        return;
      }
      const blOnlyRows = allRows.filter((r) => validMonths.includes(r.ym));
      const frozenReg = computeMeterRegression(blOnlyRows);
      m.baseline = {
        start: validMonths[0],
        end: validMonths[validMonths.length - 1],
        months: validMonths,
        reg: frozenReg,
      };
      count++;
    });
  });
  if (count === 0) {
    showToast('No other meters found in this project');
    return;
  }
  saveUtilityData();
  let msg = 'Baseline applied to ' + count + ' meter' + (count !== 1 ? 's' : '') + ' across all buildings ✓';
  if (skipped > 0) {
    msg += ' (' + skipped + ' without enough bill data)';
  }
  showToast(msg);
}

function drawBlChart(canvasId, rows, unit, bills, incl, showOverlay, metric) {
  metric = metric || 'total';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }
  const isElec = unit === 'kWh';
  const isGasU = unit === 'Therms';
  const isPropaneBl = unit === 'Gallons';
  const isTotal = metric === 'total';
  const yLabel = isTotal ? unit + '/Month' : unit + '/Day';
  const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Month-average if >12 baseline months selected ──
  // Group by calendar month (0-11), average regrBaseline/usage/normDays across years
  let chartRows;
  if (rows.length > 12) {
    const byMo = {}; // 0-11
    rows.forEach((r) => {
      const mo = parseInt(r.ym.split('-')[1]) - 1;
      if (!byMo[mo]) byMo[mo] = { regrVals: [], usageVals: [], normDaysVals: [], costs: [], label: MON_SHORT[mo], mo };
      if (r.regrBaseline != null) byMo[mo].regrVals.push(r.regrBaseline);
      byMo[mo].usageVals.push(r.usage);
      byMo[mo].normDaysVals.push(r.normDays || 30);
      byMo[mo].costs.push(r.cost || 0);
    });
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    chartRows = Object.values(byMo)
      .sort((a, b) => a.mo - b.mo)
      .map((g) => ({
        label: g.label,
        ym: null, // averaged — no single ym
        regrBaseline: g.regrVals.length ? avg(g.regrVals) : null,
        usage: avg(g.usageVals) || 0,
        normDays: avg(g.normDaysVals) || 30,
        cost: avg(g.costs) || 0,
        isBaseline: true,
      }));
  } else {
    chartRows = rows;
  }

  const labels = chartRows.map((r) => r.label);
  const barColor = 'rgba(0,212,170,0.85)';
  const barBorder = 'rgba(0,212,170,1)';
  const hasRegr = chartRows.some((r) => r.regrBaseline != null);

  // Bars = Normalized Baseline (regrBaseline); fallback to prorated usage if no model yet
  const barData = chartRows.map((r) => {
    if (hasRegr) {
      if (r.regrBaseline == null) return null;
      return isTotal ? +r.regrBaseline.toFixed(0) : +(r.regrBaseline / (r.normDays || 30)).toFixed(2);
    }
    return isTotal ? +r.usage.toFixed(0) : +(r.usage / (r.normDays || 30)).toFixed(2);
  });
  const barLabel = hasRegr ? 'Normalized Baseline' : yLabel + ' (Prorated)';

  const datasets = [
    {
      label: barLabel,
      data: barData,
      backgroundColor: barColor,
      borderColor: barBorder,
      borderWidth: 1,
      borderRadius: 3,
      order: 2,
    },
  ];

  // Raw bill overlay (amber) — always shown on Baseline chart
  if (bills && bills.length) {
    const billByYm = {};
    bills.forEach((b) => {
      if (!b.start || !b.end) return;
      const ym = normMonth(b.start, b.end, incl, bills);
      const usage = isElec
        ? parseFloat(b.kwh) || 0
        : isGasU
          ? parseFloat(b.therms) || 0
          : isPropaneBl
            ? parseFloat(b.gallonsDelivered) || parseFloat(b.kwh) || 0
            : parseFloat(b.usage) || 0;
      const days = Math.max(1, parseInt(calcDays(b.start, b.end, incl)) || 1);
      if (!billByYm[ym] || usage > 0) billByYm[ym] = { usage, days, perDay: +(usage / days).toFixed(2) };
    });

    let rawData;
    if (rows.length > 12) {
      // Average raw bills by calendar month to match averaged bars
      const rawByMo = {};
      Object.entries(billByYm).forEach(([ym, bd]) => {
        const mo = parseInt(ym.split('-')[1]) - 1;
        if (!rawByMo[mo]) rawByMo[mo] = [];
        rawByMo[mo].push(isTotal ? +bd.usage.toFixed(0) : bd.perDay);
      });
      const avgMo = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
      rawData = chartRows.map((r) => {
        const mo = MON_SHORT.indexOf(r.label);
        return rawByMo[mo] ? avgMo(rawByMo[mo]) : null;
      });
    } else {
      rawData = chartRows.map((r) => {
        const bd = billByYm[r.ym];
        return bd ? (isTotal ? +bd.usage.toFixed(0) : bd.perDay) : null;
      });
    }

    datasets.push({
      label: unit + '/Month (Raw Bills)',
      data: rawData,
      type: 'line',
      borderColor: 'rgba(245,158,11,0.85)',
      backgroundColor: 'rgba(245,158,11,0.12)',
      borderWidth: 2,
      pointRadius: 3,
      pointBackgroundColor: 'rgba(245,158,11,1)',
      tension: 0.3,
      fill: false,
      order: 1,
    });
  }

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(200,210,230,0.85)', font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              return v != null
                ? ctx.dataset.label +
                    ': ' +
                    (isTotal ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)) +
                    ' ' +
                    yLabel
                : '—';
            },
          },
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.10)' } },
        y: {
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: yLabel, font: { size: 10 } },
        },
      },
    },
  });
}

/* ══════════════════════════════════════════
         PERFORMANCE TAB
      ══════════════════════════════════════════ */
/* ══════════════════════════════════════════
         BUILDING BASELINE DATA — spreadsheet-style report matching Excel layout
      ══════════════════════════════════════════ */
function renderBuildingStatsPane(pane, b) {
  if (!b) {
    pane.innerHTML = '<div class="ud-empty">No building selected</div>';
    return;
  }

  const meters = (b.meters || []).filter((m) => isShownCommodity(udSelProjId, m.commodity));
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const sqft = parseInt(b.sqft) || 0;
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Helpers ──
  const $ = (v, d = 0) =>
    v != null ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const $c = (v, d = 2) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const $4 = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '—';
  const $5 = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 }) : '—';
  const $3kw = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—';

  // ── Pull baseline months for a meter ──
  function getBlRows(m) {
    const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const incl = m.inclusive !== false;
    const allRows = bills.length ? getNormRows(m, bills, incl, weatherByYm) : [];
    const bl = m.baseline || null;
    const blMonths = bl && bl.months ? bl.months : [];
    return { allRows, blRows: allRows.filter((r) => blMonths.includes(r.ym)), blMonths, bills, incl };
  }

  // ── Find primary electric, gas, water & propane meters ──
  const elecM = meters.find((m) => m.commodity === 'Electric');
  const gasM = meters.find((m) => m.commodity === 'Gas');
  const waterM = meters.find((m) => m.commodity === 'Water');
  const propaneM = meters.find((m) => m.commodity === 'Propane');

  const elec = elecM ? getBlRows(elecM) : null;
  const gas = gasM ? getBlRows(gasM) : null;
  const water = waterM ? getBlRows(waterM) : null;
  const propane = propaneM ? getBlRows(propaneM) : null;

  const eBlRows = elec ? (elec.blRows.length >= 3 ? elec.blRows : elec.allRows.slice(-12)) : [];
  const gBlRows = gas ? (gas.blRows.length >= 3 ? gas.blRows : gas.allRows.slice(-12)) : [];
  const wBlRows = water ? (water.blRows.length >= 3 ? water.blRows : water.allRows.slice(-12)) : [];
  const pBlRows = propane ? (propane.blRows.length >= 3 ? propane.blRows : propane.allRows.slice(-12)) : [];

  // Baseline span label
  function blSpan(rows) {
    return rows.length ? rows[0].label + ' to ' + rows[rows.length - 1].label : 'No baseline';
  }

  // ── Build month-keyed data maps (shared helper — same as Meter Data table) ──
  const { elecByMo } = elecM && eBlRows.length ? buildMoMap(elecM, eBlRows, elec.bills, elec.incl) : { elecByMo: {} };
  const { gasByMo } = gasM && gBlRows.length ? buildMoMap(gasM, gBlRows, gas.bills, gas.incl) : { gasByMo: {} };
  const { waterByMo } =
    waterM && wBlRows.length ? buildMoMap(waterM, wBlRows, water.bills, water.incl) : { waterByMo: {} };
  const { propaneByMo } =
    propaneM && pBlRows.length ? buildMoMap(propaneM, pBlRows, propane.bills, propane.incl) : { propaneByMo: {} };

  // ── All 12 months present in baseline (use sorted unique months across all commodities) ──
  const allMoKeys = Array.from(
    new Set([
      ...Object.keys(elecByMo),
      ...Object.keys(gasByMo),
      ...Object.keys(waterByMo),
      ...Object.keys(propaneByMo),
    ]),
  )
    .map(Number)
    .sort((a, c) => a - c);
  const moList = allMoKeys.length ? allMoKeys : Array.from({ length: 12 }, (_, i) => i);

  // ── Totals ──
  const totE = moList.reduce(
    (s, mo) => ({
      kwh: s.kwh + (elecByMo[mo]?.kwh || 0),
      demandKW: s.demandKW + (elecByMo[mo]?.demandKW || 0),
      billedKW: s.billedKW + (elecByMo[mo]?.billedKW || 0),
      facKW: s.facKW + (elecByMo[mo]?.facKW || 0),
      kwCost: s.kwCost + (elecByMo[mo]?.kwCost || 0),
      facKWCost: s.facKWCost + (elecByMo[mo]?.facKWCost || 0),
      energyCost: s.energyCost + (elecByMo[mo]?.energyCost || 0),
      totalCost: s.totalCost + (elecByMo[mo]?.totalCost || 0),
    }),
    { kwh: 0, demandKW: 0, billedKW: 0, facKW: 0, kwCost: 0, facKWCost: 0, energyCost: 0, totalCost: 0 },
  );
  totE.avgDemandKW = moList.length ? totE.demandKW / moList.length : 0;
  totE.avgBilledKW = moList.length ? totE.billedKW / moList.length : 0;
  totE.avgFacKW = moList.length ? totE.facKW / moList.length : 0;
  totE.totalKWCost = totE.kwCost + totE.facKWCost;
  totE.costPerKwh = totE.kwh > 0 ? totE.energyCost / totE.kwh : 0;
  // Cost/BilledKW and Cost/FacKW totals = avg of months with positive values
  const _bilKWMos = moList.filter(
    (mo) => elecByMo[mo] && (elecByMo[mo].billedKW || 0) > 0 && (elecByMo[mo].kwCost || 0) > 0,
  );
  const _facKWMos = moList.filter(
    (mo) => elecByMo[mo] && (elecByMo[mo].facKW || 0) > 0 && (elecByMo[mo].facKWCost || 0) > 0,
  );
  const _totKWMos = moList.filter(
    (mo) =>
      elecByMo[mo] &&
      (elecByMo[mo].billedKW || 0) > 0 &&
      (elecByMo[mo].kwCost || 0) + (elecByMo[mo].facKWCost || 0) > 0,
  );
  totE.costPerBilledKW = _bilKWMos.length
    ? _bilKWMos.reduce((s, mo) => s + elecByMo[mo].kwCost / elecByMo[mo].billedKW, 0) / _bilKWMos.length
    : null;
  totE.costPerFacKW = _facKWMos.length
    ? _facKWMos.reduce((s, mo) => s + elecByMo[mo].facKWCost / elecByMo[mo].facKW, 0) / _facKWMos.length
    : null;
  totE.costPerTotKW = _totKWMos.length
    ? _totKWMos.reduce((s, mo) => s + (elecByMo[mo].kwCost + elecByMo[mo].facKWCost) / elecByMo[mo].billedKW, 0) /
      _totKWMos.length
    : null;
  // Load factor and min hours totals
  const _lfMos = moList.filter(
    (mo) => elecByMo[mo] && elecByMo[mo].demandKW > 0 && elecByMo[mo].normDays > 0 && elecByMo[mo].kwh > 0,
  );
  totE.loadFactor = _lfMos.length
    ? _lfMos.reduce((s, mo) => s + elecByMo[mo].kwh / (elecByMo[mo].demandKW * 24 * elecByMo[mo].normDays), 0) /
      _lfMos.length
    : null;
  const _mhMos = moList.filter((mo) => elecByMo[mo] && elecByMo[mo].demandKW > 0 && elecByMo[mo].kwh > 0);
  totE.minHours = _mhMos.reduce((s, mo) => s + elecByMo[mo].kwh / elecByMo[mo].demandKW, 0);

  const totG = {
    therms: moList.reduce((s, mo) => s + (gasByMo[mo]?.therms || 0), 0),
    cost: moList.reduce((s, mo) => s + (gasByMo[mo]?.cost || 0), 0),
  };
  totG.costPerTherm = totG.therms > 0 ? totG.cost / totG.therms : 0;

  const totW = {
    kgal: moList.reduce((s, mo) => s + (waterByMo[mo]?.kgal || 0), 0),
    cost: moList.reduce((s, mo) => s + (waterByMo[mo]?.cost || 0), 0),
  };

  const totP = {
    gallons: moList.reduce((s, mo) => s + (propaneByMo[mo]?.gallons || 0), 0),
    cost: moList.reduce((s, mo) => s + (propaneByMo[mo]?.cost || 0), 0),
  };
  totP.costPerGal = totP.gallons > 0 ? totP.cost / totP.gallons : 0;

  const totUtility = totE.totalCost + totG.cost + totW.cost + totP.cost;

  // ── Summary bar computations ──
  const kwhPerSf = sqft > 0 ? totE.kwh / sqft : null;
  const utilityCostPerSf = sqft > 0 ? totUtility / sqft : null;
  const avgWattsPerSf = sqft > 0 && totE.avgDemandKW > 0 ? (totE.avgDemandKW * 1000) / sqft : null;
  const elecDolPerSf = sqft > 0 && totE.energyCost > 0 ? totE.energyCost / sqft : null;
  const thermPerSf = sqft > 0 && totG.therms > 0 ? totG.therms / sqft : null;
  const totalKbtuPerSf = sqft > 0 ? toKBtu(totE.kwh, totG.therms, totP.gallons) / sqft : null;
  const utilityCostPerYear = totUtility;

  // Seasonal rates
  const sumMos = [5, 6, 7, 8]; // Jun-Sep (0-indexed)
  const winMos = [11, 0, 1, 2]; // Dec-Mar
  function avgRateForMos(moArr, field) {
    const rows = moArr.filter((mo) => elecByMo[mo] && elecByMo[mo].kwh > 0);
    if (!rows.length) return null;
    return rows.reduce((s, mo) => s + (elecByMo[mo][field] || 0) / elecByMo[mo].kwh, 0) / rows.length;
  }
  function avgKwRateForMos(moArr) {
    const rows = moArr.filter(
      (mo) => elecByMo[mo] && (elecByMo[mo].billedKW || elecByMo[mo].demandKW) > 0 && elecByMo[mo].kwCost > 0,
    );
    if (!rows.length) return null;
    return (
      rows.reduce((s, mo) => s + elecByMo[mo].kwCost / (elecByMo[mo].billedKW || elecByMo[mo].demandKW), 0) /
      rows.length
    );
  }
  const sumKwhRate = avgRateForMos(sumMos, 'energyCost');
  const winKwhRate = avgRateForMos(winMos, 'energyCost');
  const sumKwRate = avgKwRateForMos(sumMos);
  const winKwRate = avgKwRateForMos(winMos);
  const gasPerTherm = totG.therms > 0 ? totG.cost / totG.therms : null;

  // Hours operated (from building field or blank)
  const hoursOperated = parseInt(b.hoursOperated) || null;

  // ── CSS for this panel ──
  const css = `
          .bbd-wrap{font-family:var(--font);font-size:11px;color:var(--text);padding:4px 0 20px}
          .bbd-title{text-align:center;font-size:15px;font-weight:800;color:#f0c040;letter-spacing:.06em;padding:8px 0 12px;text-transform:uppercase}
          .bbd-bl-tbl{border-collapse:collapse;font-size:10.5px}
          .bbd-bl-tbl td,.bbd-bl-tbl th{border:1px solid rgba(255,255,255,0.20);padding:3px 10px;white-space:nowrap;color:#e0eaff}
          .bbd-bl-tbl th{background:rgba(255,255,255,0.08);color:#c8d8f0;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
          .bbd-bl-tbl .bl-green{background:#0d3320;color:#4fffaa;font-weight:700;border-color:#1a5535}

          .bbd-summary{background:#0d1525;border:1px solid rgba(255,255,255,0.12);border-radius:9px;padding:12px 16px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:0;row-gap:10px}
          .bbd-sum-cell{display:flex;flex-direction:column;gap:3px;padding:8px 14px;border-right:1px solid rgba(255,255,255,0.07);flex:1;min-width:90px}
          .bbd-sum-cell:last-child{border-right:none}
          .bbd-sum-lbl{font-size:9.5px;color:#8ab0d0;text-transform:uppercase;letter-spacing:.5px;font-weight:700;white-space:nowrap}
          .bbd-sum-val{font-size:15px;font-weight:800;color:#e8eef8;font-family:var(--mono);line-height:1.1}
          .bbd-sum-val.c-blue{color:#60b8ff}
          .bbd-sum-val.c-orange{color:#ffb040}
          .bbd-sum-val.c-green{color:#40e8a0}
          .bbd-sum-val.c-teal{color:#40d8d0}
          .bbd-sum-val.c-violet{color:#b090ff}

          .bbd-rate-block{display:flex;flex-direction:column;gap:3px;margin-top:1px}
          .bbd-rate-row{display:flex;gap:5px;align-items:baseline}
          .bbd-rate-season{font-size:9px;color:#7090a8;font-weight:700;text-transform:uppercase;width:38px;flex-shrink:0;letter-spacing:.3px}
          .bbd-rate-val{font-size:12px;font-weight:700;font-family:var(--mono);color:#e8eef8}

          .bbd-tbl-wrap{overflow-x:auto;margin-bottom:16px;border:1px solid rgba(255,255,255,0.1);border-radius:9px;background:#080e1c}
          .bbd-tbl{border-collapse:collapse;width:100%;font-size:11px;table-layout:auto}
          .bbd-tbl th{font-weight:700;padding:6px 9px;text-align:center;border:1px solid rgba(255,255,255,0.12);white-space:nowrap;font-size:10px;letter-spacing:.2px}
          .bbd-tbl th.mo-hdr{background:#0d1830;color:#c8d8f0;text-align:left;padding-left:12px;font-size:11px}
          .bbd-tbl th.e-hdr{background:#0a1e38;color:#7dd8ff;border-color:rgba(100,180,255,0.15)}
          .bbd-tbl th.g-hdr{background:#221508;color:#ffb040;border-color:rgba(255,160,50,0.2)}
          .bbd-tbl th.w-hdr{background:#081e18;color:#40e8a0;border-color:rgba(50,220,140,0.2)}
          .bbd-tbl th.u-hdr{background:#150d2a;color:#c090ff;border-color:rgba(180,120,255,0.2);vertical-align:middle}
          .bbd-tbl td{padding:5px 9px;text-align:center;border:1px solid rgba(255,255,255,0.10);font-family:var(--mono);font-size:11px;white-space:nowrap;color:#e8f0ff}
          .bbd-tbl td.mo{text-align:left;font-family:var(--font);font-weight:700;color:#c8d8f0;background:#0d1830;padding-left:12px}
          .bbd-tbl tbody tr:hover td{background:rgba(100,160,255,0.07)}
          .bbd-tbl tbody tr:hover td.mo{background:#0d1830}
          .bbd-tbl tr.total-row td{border-top:2px solid rgba(255,255,255,0.18);font-weight:800;background:#0d1830;color:#ffffff;font-size:11.5px}
          .bbd-tbl tr.total-row td.mo{color:#ffffff;background:#0d1830}
          .bbd-tbl td.total-util{background:#150d2a;color:#c090ff;font-weight:700;border-left:2px solid rgba(180,120,255,0.3)}
          .bbd-tbl tr.total-row td.total-util{background:#1a0f35;color:#d8a8ff}

          [data-theme='light'] .bbd-summary{background:var(--s2);border-color:var(--border)}
          [data-theme='light'] .bbd-sum-cell{border-right-color:var(--border)}
          [data-theme='light'] .bbd-sum-lbl{color:var(--text2)}
          [data-theme='light'] .bbd-sum-val{color:var(--text)}
          [data-theme='light'] .bbd-sum-val.c-blue{color:#1d6eaf}
          [data-theme='light'] .bbd-sum-val.c-orange{color:#a05a00}
          [data-theme='light'] .bbd-sum-val.c-green{color:#1a7a4a}
          [data-theme='light'] .bbd-sum-val.c-teal{color:#0a6a6a}
          [data-theme='light'] .bbd-sum-val.c-violet{color:#5a2fa0}
          [data-theme='light'] .bbd-rate-season{color:var(--text3)}
          [data-theme='light'] .bbd-rate-val{color:var(--text)}
          [data-theme='light'] .bbd-title{color:var(--em)}
          [data-theme='light'] .bbd-tbl-wrap{background:var(--s2);border-color:var(--border)}
          [data-theme='light'] .bbd-tbl th{color:var(--text)}
          [data-theme='light'] .bbd-tbl th.mo-hdr{background:var(--s1);color:var(--text2)}
          [data-theme='light'] .bbd-tbl th.e-hdr{background:#c5d9f0;color:#1a4060;border-color:#a0c0e0}
          [data-theme='light'] .bbd-tbl th.g-hdr{background:#f0e4cc;color:#7a4a00;border-color:#d0b070}
          [data-theme='light'] .bbd-tbl th.w-hdr{background:#c5e8d5;color:#1a5c35;border-color:#80c5a0}
          [data-theme='light'] .bbd-tbl th.u-hdr{background:#ddd0f0;color:#4a1a80;border-color:#b090d8}
          [data-theme='light'] .bbd-tbl td{color:var(--text);border-color:var(--border)}
          [data-theme='light'] .bbd-tbl td.mo{background:var(--s3);color:var(--text2)}
          [data-theme='light'] .bbd-tbl tbody tr:hover td{background:rgba(0,0,0,0.03)}
          [data-theme='light'] .bbd-tbl tbody tr:hover td.mo{background:var(--s3)}
          [data-theme='light'] .bbd-tbl tr.total-row td{background:var(--s1);color:var(--text);border-top-color:var(--border2)}
          [data-theme='light'] .bbd-tbl tr.total-row td.mo{background:var(--s1)}
          [data-theme='light'] .bbd-tbl td.total-util{background:#e8dcf8;color:#4a1a80;border-left-color:#c090e0}
          [data-theme='light'] .bbd-tbl tr.total-row td.total-util{background:#ddd0f0;color:#3a1068}
          [data-theme='light'] .bbd-bl-tbl td,[data-theme='light'] .bbd-bl-tbl th{border-color:var(--border);color:var(--text)}
          [data-theme='light'] .bbd-bl-tbl th{background:var(--s1);color:var(--text2)}
          [data-theme='light'] .bbd-bl-tbl .bl-green{background:#c5ecd8;color:#1a5c35;border-color:#80c0a0}
        `;

  // ── Month row builder ──
  function moRow(mo, isTotal) {
    const e = elecByMo[mo] || {};
    const g = gasByMo[mo] || {};
    const w = waterByMo[mo] || {};
    const moLabel = isTotal ? 'TOTAL' : MONTHS_SHORT[mo];

    // Number formatters
    // #,##0.0 — one decimal, 0 shows as "0", null/undefined shows as "—"
    const n1 = (v) =>
      v == null || isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    // #,##0 — whole number
    const n0 = (v) =>
      v == null || isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    // $#,##0.00 — cost
    const nc = (v) =>
      v == null || isNaN(v)
        ? '—'
        : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // $#,##0.00000 — kWh rate (5 decimal)
    const r4 = (v) =>
      v == null || isNaN(v)
        ? '—'
        : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
    // $#,##0.000 — kW rate (3 decimal)
    const r2 = (v) =>
      v == null || isNaN(v)
        ? '—'
        : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    // % with 1 decimal
    const pct = (v) =>
      v == null || isNaN(v)
        ? '—'
        : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    const td = (v, cls = '') => `<td${cls ? ' class="' + cls + '"' : ''}>${v}</td>`;

    const kwh = isTotal ? totE.kwh : e.kwh != null ? e.kwh : null;
    const demKW = isTotal ? totE.demandKW : e.demandKW != null ? e.demandKW : null;
    const bilKW = isTotal ? totE.billedKW : e.billedKW != null ? e.billedKW : null;
    const facKW = isTotal ? totE.facKW : e.facKW != null ? e.facKW : null;
    const kwCost = isTotal ? totE.kwCost : e.kwCost != null ? e.kwCost : null;
    const facKWCost = isTotal ? totE.facKWCost : e.facKWCost != null ? e.facKWCost : null;
    const totKWCost = kwCost != null || facKWCost != null ? (kwCost || 0) + (facKWCost || 0) : null;
    const engCost = isTotal ? totE.energyCost : e.energyCost != null ? e.energyCost : null;
    const eCost = isTotal ? totE.totalCost : e.totalCost != null ? e.totalCost : null;
    const normDays = isTotal ? null : e.normDays || null;

    // Rates
    const costKwh = kwh != null && kwh > 0 && engCost != null ? engCost / kwh : null;
    const costBilKW = isTotal
      ? totE.costPerBilledKW
      : bilKW != null && bilKW > 0 && kwCost != null && kwCost > 0
        ? kwCost / bilKW
        : null;
    const costFacKW = isTotal
      ? totE.costPerFacKW
      : facKW != null && facKW > 0 && facKWCost != null && facKWCost > 0
        ? facKWCost / facKW
        : null;
    const costTotKW = isTotal
      ? totE.costPerTotKW
      : bilKW != null && bilKW > 0 && totKWCost != null && totKWCost > 0
        ? totKWCost / bilKW
        : null;

    // Load Factor = kWh / (demandKW × 24 × normDays)
    const loadFactor = isTotal
      ? totE.loadFactor
      : kwh != null && kwh > 0 && demKW != null && demKW > 0 && normDays > 0
        ? kwh / (demKW * 24 * normDays)
        : null;
    // Min Hours = kWh / demandKW — total = sum of column
    const minHours = isTotal
      ? totE.minHours
      : kwh != null && kwh > 0 && demKW != null && demKW > 0
        ? kwh / demKW
        : null;

    const therms = isTotal ? totG.therms : g.therms != null ? g.therms : null;
    const gCost = isTotal ? totG.cost : g.cost != null ? g.cost : null;
    const cPerTherm = therms != null && therms > 0 && gCost != null ? gCost / therms : null;

    const kgal = isTotal ? totW.kgal : w.kgal != null ? w.kgal : null;
    const wCost = isTotal ? totW.cost : w.cost != null ? w.cost : null;
    const cPerKgal = kgal != null && kgal > 0 && wCost != null ? wCost / kgal : null;

    const pp = propaneByMo[mo] || {};
    const pGal = isTotal ? totP.gallons : pp.gallons != null ? pp.gallons : null;
    const pCost = isTotal ? totP.cost : pp.cost != null ? pp.cost : null;
    const cPerGal = pGal != null && pGal > 0 && pCost != null ? pCost / pGal : null;

    const totalUtil = (eCost || 0) + (gCost || 0) + (wCost || 0) + (pCost || 0);

    return `<tr${isTotal ? ' class="total-row"' : ''}>
            ${td(moLabel, 'mo')}
            ${
              elecM
                ? `
              ${td(n1(kwh))} ${td(n1(demKW))} ${td(n1(bilKW))} ${td(n1(facKW))}
              ${td(nc(kwCost))} ${td(nc(facKWCost))} ${td(nc(totKWCost))} ${td(nc(engCost))} ${td(nc(eCost))}
              ${td(r4(costKwh))} ${td(r2(costBilKW))} ${td(r2(costFacKW))} ${td(r2(costTotKW))}
              ${td(pct(loadFactor))} ${td(n1(minHours))}
            `
                : ''
            }
            ${gasM ? `${td(n1(therms))} ${td(nc(gCost))} ${td(r4(cPerTherm))}` : ''}
            ${waterM ? `${td(n1(kgal))} ${td(nc(wCost))} ${td(r4(cPerKgal))}` : ''}
            ${propaneM ? `${td(n1(pGal))} ${td(nc(pCost))} ${td(r4(cPerGal))}` : ''}
            ${td(nc(totalUtil), 'total-util')}</tr>`;
  }
  const moRows = moList.map((mo) => moRow(mo, false)).join('');

  // ── No data state ──
  if (!elecM && !gasM && !waterM && !propaneM) {
    pane.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">📊</div><div>No meter data yet.<br>Add bills to meters to see baseline data.</div></div>';
    return;
  }

  pane.innerHTML = `
          <style>${css}</style>
          <div class="bbd-wrap">
            <div class="bbd-title">Baseline Data</div>

            <!-- Meta row: baseline years + providers + units -->
            <div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px 28px;margin-bottom:14px;align-items:start;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:14px 18px">
              <!-- Baseline Years -->
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Data Baseline Years</div>
                <table class="bbd-bl-tbl">
                  <tr>
                    ${elecM ? '<th>Electricity</th>' : ''}
                    ${gasM ? '<th>Heating Fuel</th>' : ''}
                    ${waterM ? '<th>Water</th>' : ''}
                  </tr>
                  <tr>
                    ${elecM ? `<td class="bl-green">${blSpan(eBlRows)}</td>` : ''}
                    ${gasM ? `<td class="bl-green">${blSpan(gBlRows)}</td>` : ''}
                    ${waterM ? `<td class="bl-green">${blSpan(wBlRows)}</td>` : ''}
                  </tr>
                </table>
              </div>
              <!-- Providers -->
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Utility Providers</div>
                ${elecM ? `<div style="font-size:11.5px;margin-bottom:3px;color:var(--text2)">Electric Company: <span style="color:var(--text);font-weight:700">${elecM.provider || elecM.name || '—'}</span></div>` : ''}
                ${gasM ? `<div style="font-size:11.5px;margin-bottom:3px;color:var(--text2)">Heating Fuel Company: <span style="color:var(--text);font-weight:700">${gasM.provider || gasM.name || '—'}</span></div>` : ''}
                ${waterM ? `<div style="font-size:11.5px;color:var(--text2)">Water Company: <span style="color:var(--text);font-weight:700">${waterM.provider || waterM.name || '—'}</span></div>` : ''}
              </div>
              <!-- Units -->
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Utility Units</div>
                ${elecM ? `<div style="font-size:11.5px;margin-bottom:3px;color:var(--text2)">Electricity <span style="color:#7dd8ff;font-weight:800;margin-left:8px;font-size:12px">kWh</span></div>` : ''}
                ${gasM ? `<div style="font-size:11.5px;margin-bottom:3px;color:var(--text2)">Heating Fuel <span style="color:#ffb040;font-weight:800;margin-left:8px;font-size:12px">Therm</span></div>` : ''}
                ${waterM ? `<div style="font-size:11.5px;color:var(--text2)">Water <span style="color:#40e8a0;font-weight:800;margin-left:8px;font-size:12px">kGal</span></div>` : ''}
              </div>
            </div>

            <!-- Summary bar -->
            <div class="bbd-summary">
              ${sqft > 0 ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Square Feet</div><div class="bbd-sum-val">${sqft.toLocaleString()}</div></div>` : ''}
              ${kwhPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">kWh / sf</div><div class="bbd-sum-val c-blue">${kwhPerSf.toFixed(2)}</div></div>` : ''}
              ${utilityCostPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Utility Cost / sf</div><div class="bbd-sum-val c-green">${$c(utilityCostPerSf)}</div></div>` : ''}
              ${hoursOperated != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Hours Operated</div><div class="bbd-sum-val">${hoursOperated.toLocaleString()}</div></div>` : ''}
              ${avgWattsPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Avg Watts / sf</div><div class="bbd-sum-val c-blue">${avgWattsPerSf.toFixed(2)}</div></div>` : ''}
              <div class="bbd-sum-cell" style="min-width:110px">
                <div class="bbd-sum-lbl">$ / kWh Rate</div>
                <div class="bbd-rate-block">
                  <div class="bbd-rate-row"><span class="bbd-rate-season">☀ Sum</span><span class="bbd-rate-val c-orange" style="font-size:13px;font-weight:800">${sumKwhRate ? $5(sumKwhRate) : '—'}</span></div>
                  <div class="bbd-rate-row"><span class="bbd-rate-season">❄ Win</span><span class="bbd-rate-val c-blue" style="font-size:13px;font-weight:800">${winKwhRate ? $5(winKwhRate) : '—'}</span></div>
                </div>
              </div>
              <div class="bbd-sum-cell" style="min-width:110px">
                <div class="bbd-sum-lbl">$ / kW Rate</div>
                <div class="bbd-rate-block">
                  <div class="bbd-rate-row"><span class="bbd-rate-season">☀ Sum</span><span class="bbd-rate-val c-orange" style="font-size:13px;font-weight:800">${sumKwRate ? '$' + sumKwRate.toFixed(3) : '—'}</span></div>
                  <div class="bbd-rate-row"><span class="bbd-rate-season">❄ Win</span><span class="bbd-rate-val c-blue" style="font-size:13px;font-weight:800">${winKwRate ? '$' + winKwRate.toFixed(3) : '—'}</span></div>
                </div>
              </div>
              ${thermPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Therm / sf</div><div class="bbd-sum-val c-orange">${thermPerSf.toFixed(3)}</div></div>` : ''}
              ${gasPerTherm != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Gas $ / Therm</div><div class="bbd-sum-val c-orange">${$c(gasPerTherm)}</div></div>` : ''}
              ${totalKbtuPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Total kBtu / sf</div><div class="bbd-sum-val c-violet">${totalKbtuPerSf.toFixed(2)}</div></div>` : ''}
              <div class="bbd-sum-cell"><div class="bbd-sum-lbl">Utility Costs / Year</div><div class="bbd-sum-val c-green">${$c(utilityCostPerYear, 0)}</div></div>
            </div>

            <!-- Main data table -->
            <div class="bbd-tbl-wrap">
              <table class="bbd-tbl">
                <thead>
                  <tr>
                    <th rowspan="2" class="mo-hdr" style="vertical-align:middle;min-width:52px">Month</th>
                    ${elecM ? `<th colspan="15" class="e-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">ELECTRICITY</th>` : ''}
                    ${gasM ? `<th colspan="3" class="g-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">HEATING FUEL</th>` : ''}
                    ${waterM ? `<th colspan="3" class="w-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">WATER</th>` : ''}
                    ${propaneM ? `<th colspan="3" class="g-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px;background:#2a1508">PROPANE</th>` : ''}
                    <th rowspan="2" class="u-hdr" style="vertical-align:middle;min-width:96px;font-size:10px;line-height:1.5;padding:6px 8px">Total<br>Utility<br>Costs</th>
                  </tr>
                  <tr>
                    ${
                      elecM
                        ? `
                      <th class="e-hdr" title="Normalized Baseline kWh — regression-predicted usage for this calendar month">Normalized kWh</th>
                      <th class="e-hdr">Actual kW</th>
                      <th class="e-hdr">Billed<br>kW</th>
                      <th class="e-hdr">Facilities kW</th>
                      <th class="e-hdr">Billed kW<br>Cost</th>
                      <th class="e-hdr">Facilities kW<br>Cost</th>
                      <th class="e-hdr">Total kW<br>Cost</th>
                      <th class="e-hdr">Energy<br>Cost</th>
                      <th class="e-hdr">Electric<br>Cost</th>
                      <th class="e-hdr">Cost/<br>kWh</th>
                      <th class="e-hdr">Cost/<br>Billed kW</th>
                      <th class="e-hdr">Cost/<br>Facilities kW</th>
                      <th class="e-hdr">Cost/<br>Total kW</th>
                      <th class="e-hdr">% Load<br>Factor</th>
                      <th class="e-hdr">Min<br>Hours</th>
                    `
                        : ''
                    }
                    ${
                      gasM
                        ? `
                      <th class="g-hdr" title="Normalized Baseline Therms — regression-predicted usage for this calendar month">Normalized Therms</th>
                      <th class="g-hdr">Gas Cost</th>
                      <th class="g-hdr">Cost/<br>Therm</th>
                    `
                        : ''
                    }
                    ${
                      waterM
                        ? `
                      <th class="w-hdr" title="Normalized Baseline kGal — regression-predicted usage for this calendar month">Normalized kGal</th>
                      <th class="w-hdr">Water<br>Cost</th>
                      <th class="w-hdr">Cost/<br>kGal</th>
                    `
                        : ''
                    }
                    ${
                      propaneM
                        ? `
                      <th class="g-hdr" style="background:#2a1508" title="Normalized Baseline Gallons">Gallons</th>
                      <th class="g-hdr" style="background:#2a1508">Propane<br>Cost</th>
                      <th class="g-hdr" style="background:#2a1508">Cost/<br>Gal</th>
                    `
                        : ''
                    }
                  </tr>
                </thead>
                <tbody>
                  ${moRows}
                </tbody>
                <tfoot>
                  ${moRow(null, true)}
                </tfoot>
              </table>
            </div>

            <!-- Monthly Cost Chart -->
            <div style="margin-top:18px;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:16px 18px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:12px;text-align:center">Dollars Spent Monthly By Utility Type</div>
              <div style="position:relative;height:320px"><canvas id="bbdCostChart"></canvas></div>
            </div>

          </div>`;

  // ── Draw monthly cost stacked bar chart ──
  requestAnimationFrame(() => {
    const canvas = document.getElementById('bbdCostChart');
    if (!canvas) return;
    if (_maCharts['bbdCostChart']) {
      _maCharts['bbdCostChart'].destroy();
    }
    const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const labels = moList.map((mo) => MONTHS_S[mo]);

    const datasets = [];

    // kWh Energy Cost (electric energy charge — no demand)
    if (elecM) {
      datasets.push({
        label: 'kWh Electric Cost',
        data: moList.map((mo) => +(elecByMo[mo]?.energyCost || 0).toFixed(2)),
        backgroundColor: 'rgba(100,180,255,0.85)',
        borderColor: 'rgba(100,180,255,1)',
        borderWidth: 0,
        stack: 'cost',
      });
      // kW Demand Cost (Billed kW Cost + Facilities kW Cost)
      datasets.push({
        label: 'kW Electric Demand Cost',
        data: moList.map((mo) => +((elecByMo[mo]?.kwCost || 0) + (elecByMo[mo]?.facKWCost || 0)).toFixed(2)),
        backgroundColor: 'rgba(147,210,255,0.85)',
        borderColor: 'rgba(147,210,255,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }
    if (gasM) {
      datasets.push({
        label: 'Gas Cost',
        data: moList.map((mo) => +(gasByMo[mo]?.cost || 0).toFixed(2)),
        backgroundColor: 'rgba(245,130,30,0.9)',
        borderColor: 'rgba(245,130,30,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }
    if (waterM) {
      datasets.push({
        label: 'Water Cost',
        data: moList.map((mo) => +(waterByMo[mo]?.cost || 0).toFixed(2)),
        backgroundColor: 'rgba(50,220,140,0.8)',
        borderColor: 'rgba(50,220,140,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }

    const fmtDollar = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    _maCharts['bbdCostChart'] = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: 'rgba(200,220,240,0.9)', font: { size: 11 }, boxWidth: 14, padding: 14 },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => (ctx.parsed.y > 0 ? ' ' + ctx.dataset.label + ': ' + fmtDollar(ctx.parsed.y) : null),
              footer: (items) => {
                const total = items.reduce((s, i) => s + i.parsed.y, 0);
                return total > 0 ? 'Total Utility Cost: ' + fmtDollar(total) : '';
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.10)' },
          },
          y: {
            stacked: true,
            ticks: {
              color: 'rgba(180,200,220,0.8)',
              font: { size: 10 },
              callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
            },
            grid: { color: 'rgba(255,255,255,0.12)' },
            title: { display: true, text: 'Dollars Spent', color: 'rgba(160,185,210,0.8)', font: { size: 11 } },
          },
        },
      },
    });
  });
}

let _perfYearFilter = 'all'; // 'all' | '1' | '2' | '3' ...

function renderMeterDataPane(pane, m, bills, incl) {
  const isElec = m.commodity === 'Electric';
  const isGas = m.commodity === 'Gas';
  const isPropane = m.commodity === 'Propane';
  const isWater = !isElec && !isGas && !isPropane;
  const { byYm: weatherByYm } = getWeatherForBuilding();
  const bldg = getUDBldg(udSelProjId, udSelBldgId);
  const sqft = parseInt(bldg?.sqft) || 0;
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Helpers (same as Baseline Data) ──
  const $ = (v, d = 0) =>
    v != null ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const $c = (v, d = 2) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const $4 = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '—';
  const $5 = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 }) : '—';
  const $3kw = (v) =>
    v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—';
  const n1 = (v) =>
    v == null || isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const nc = (v) =>
    v == null || isNaN(v)
      ? '—'
      : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const r4 = (v) =>
    v == null || isNaN(v)
      ? '—'
      : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  const r2 = (v) =>
    v == null || isNaN(v)
      ? '—'
      : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const pct = (v) =>
    v == null || isNaN(v)
      ? '—'
      : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const td = (v, cls = '') => `<td${cls ? ' class="' + cls + '"' : ''}>${v}</td>`;

  // ── Get baseline rows (same logic as renderBuildingStatsPane getBlRows) ──
  // NOTE: getNormRows must run BEFORE computeMeterQualityScore so that m._reg is
  // populated when the scorer checks it for the R² component (fix for backlog 67cb827d).
  const sortedBills = (bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const allRows = sortedBills.length ? getNormRows(m, sortedBills, incl, weatherByYm) : [];

  // ── Data quality score ── (after getNormRows so m._reg is available)
  const _dqScore = typeof computeMeterQualityScore === 'function' ? computeMeterQualityScore(m) : null;
  const _dqBadgeData = _dqScore ? getMeterQualityBadge(_dqScore.score) : null;
  const bl = m.baseline || null;
  const blMonths = bl && bl.months ? bl.months : [];
  const blRowsFull = allRows.filter((r) => blMonths.includes(r.ym));
  const blRows = blRowsFull.length >= 3 ? blRowsFull : allRows.slice(-12);

  if (!blRows.length) {
    pane.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">📈</div><div>No baseline data yet.<br>Go to the Baseline tab to select baseline months.</div></div>';
    return;
  }

  function blSpan(rows) {
    return rows.length ? rows[0].label + ' to ' + rows[rows.length - 1].label : 'No baseline';
  }

  // ── Build month-keyed maps (shared helper — same result as Meter Data table) ──
  const { elecByMo, gasByMo, waterByMo, propaneByMo } = buildMoMap(m, blRows, sortedBills, incl);

  const allMoKeys = Array.from(
    new Set([
      ...Object.keys(elecByMo),
      ...Object.keys(gasByMo),
      ...Object.keys(waterByMo),
      ...Object.keys(propaneByMo),
    ]),
  )
    .map(Number)
    .sort((a, c) => a - c);
  const moList = allMoKeys.length ? allMoKeys : Array.from({ length: 12 }, (_, i) => i);

  // ── Totals (same logic as Baseline Data) ──
  const totE = moList.reduce(
    (s, mo) => ({
      kwh: s.kwh + (elecByMo[mo]?.kwh || 0),
      demandKW: s.demandKW + (elecByMo[mo]?.demandKW || 0),
      billedKW: s.billedKW + (elecByMo[mo]?.billedKW || 0),
      facKW: s.facKW + (elecByMo[mo]?.facKW || 0),
      kwCost: s.kwCost + (elecByMo[mo]?.kwCost || 0),
      facKWCost: s.facKWCost + (elecByMo[mo]?.facKWCost || 0),
      energyCost: s.energyCost + (elecByMo[mo]?.energyCost || 0),
      totalCost: s.totalCost + (elecByMo[mo]?.totalCost || 0),
    }),
    { kwh: 0, demandKW: 0, billedKW: 0, facKW: 0, kwCost: 0, facKWCost: 0, energyCost: 0, totalCost: 0 },
  );
  totE.avgDemandKW = moList.length ? totE.demandKW / moList.length : 0;
  totE.avgBilledKW = moList.length ? totE.billedKW / moList.length : 0;
  totE.avgFacKW = moList.length ? totE.facKW / moList.length : 0;
  totE.totalKWCost = totE.kwCost + totE.facKWCost;
  totE.costPerKwh = totE.kwh > 0 ? totE.energyCost / totE.kwh : 0;
  const _bilKWMos = moList.filter(
    (mo) => elecByMo[mo] && (elecByMo[mo].billedKW || 0) > 0 && (elecByMo[mo].kwCost || 0) > 0,
  );
  const _facKWMos = moList.filter(
    (mo) => elecByMo[mo] && (elecByMo[mo].facKW || 0) > 0 && (elecByMo[mo].facKWCost || 0) > 0,
  );
  const _totKWMos = moList.filter(
    (mo) =>
      elecByMo[mo] &&
      (elecByMo[mo].billedKW || 0) > 0 &&
      (elecByMo[mo].kwCost || 0) + (elecByMo[mo].facKWCost || 0) > 0,
  );
  totE.costPerBilledKW = _bilKWMos.length
    ? _bilKWMos.reduce((s, mo) => s + elecByMo[mo].kwCost / elecByMo[mo].billedKW, 0) / _bilKWMos.length
    : null;
  totE.costPerFacKW = _facKWMos.length
    ? _facKWMos.reduce((s, mo) => s + elecByMo[mo].facKWCost / elecByMo[mo].facKW, 0) / _facKWMos.length
    : null;
  totE.costPerTotKW = _totKWMos.length
    ? _totKWMos.reduce((s, mo) => s + (elecByMo[mo].kwCost + elecByMo[mo].facKWCost) / elecByMo[mo].billedKW, 0) /
      _totKWMos.length
    : null;
  const _lfMos = moList.filter(
    (mo) => elecByMo[mo] && elecByMo[mo].demandKW > 0 && elecByMo[mo].normDays > 0 && elecByMo[mo].kwh > 0,
  );
  totE.loadFactor = _lfMos.length
    ? _lfMos.reduce((s, mo) => s + elecByMo[mo].kwh / (elecByMo[mo].demandKW * 24 * elecByMo[mo].normDays), 0) /
      _lfMos.length
    : null;
  const _mhMos = moList.filter((mo) => elecByMo[mo] && elecByMo[mo].demandKW > 0 && elecByMo[mo].kwh > 0);
  totE.minHours = _mhMos.reduce((s, mo) => s + elecByMo[mo].kwh / elecByMo[mo].demandKW, 0);

  const totG = {
    therms: moList.reduce((s, mo) => s + (gasByMo[mo]?.therms || 0), 0),
    cost: moList.reduce((s, mo) => s + (gasByMo[mo]?.cost || 0), 0),
  };
  totG.costPerTherm = totG.therms > 0 ? totG.cost / totG.therms : 0;

  const totW = {
    kgal: moList.reduce((s, mo) => s + (waterByMo[mo]?.kgal || 0), 0),
    cost: moList.reduce((s, mo) => s + (waterByMo[mo]?.cost || 0), 0),
  };
  const totW_costPerKgal = totW.kgal > 0 ? totW.cost / totW.kgal : null;

  const totP = {
    gallons: moList.reduce((s, mo) => s + (propaneByMo[mo]?.gallons || 0), 0),
    cost: moList.reduce((s, mo) => s + (propaneByMo[mo]?.cost || 0), 0),
  };
  const totP_costPerGal = totP.gallons > 0 ? totP.cost / totP.gallons : null;

  const totCost = totE.totalCost + totG.cost + totW.cost + totP.cost;

  // ── Summary bar computations ──
  const kwhPerSf = isElec && sqft > 0 ? totE.kwh / sqft : null;
  const totalUtilityCostPerSf = sqft > 0 ? totCost / sqft : null;
  const costPerSf = totalUtilityCostPerSf;
  const avgWattsPerSf = isElec && sqft > 0 && totE.avgDemandKW > 0 ? (totE.avgDemandKW * 1000) / sqft : null;
  const elecDolPerSf = isElec && sqft > 0 ? totE.energyCost / sqft : null;
  const thermPerSf = isGas && sqft > 0 && totG.therms > 0 ? totG.therms / sqft : null;
  const kbtuPerSf = sqft > 0 ? toKBtu(totE.kwh, totG.therms, totP.gallons) / sqft : null;
  const hoursOperated = parseInt(bldg?.hoursOperated) || null;

  // Seasonal rates — electric only
  const sumMos = [5, 6, 7, 8],
    winMos = [11, 0, 1, 2];
  function avgRateForMos(moArr, field) {
    const rows = moArr.filter((mo) => elecByMo[mo] && elecByMo[mo].kwh > 0);
    if (!rows.length) return null;
    return rows.reduce((s, mo) => s + (elecByMo[mo][field] || 0) / elecByMo[mo].kwh, 0) / rows.length;
  }
  function avgKwRateForMos(moArr) {
    const rows = moArr.filter(
      (mo) => elecByMo[mo] && (elecByMo[mo].billedKW || elecByMo[mo].demandKW) > 0 && elecByMo[mo].kwCost > 0,
    );
    if (!rows.length) return null;
    return (
      rows.reduce((s, mo) => s + elecByMo[mo].kwCost / (elecByMo[mo].billedKW || elecByMo[mo].demandKW), 0) /
      rows.length
    );
  }
  const sumKwhRate = isElec ? avgRateForMos(sumMos, 'energyCost') : null;
  const winKwhRate = isElec ? avgRateForMos(winMos, 'energyCost') : null;
  const sumKwRate = isElec ? avgKwRateForMos(sumMos) : null;
  const winKwRate = isElec ? avgKwRateForMos(winMos) : null;
  const gasPerTherm = isGas && totG.therms > 0 ? totG.cost / totG.therms : null;

  // ── Row builder (same logic as Baseline Data moRow) ──
  function moRow(mo, isTotal) {
    const e = elecByMo[mo] || {};
    const g = gasByMo[mo] || {};
    const w = waterByMo[mo] || {};
    const moLabel = isTotal ? 'TOTAL' : MONTHS_SHORT[mo];

    const kwh = isTotal ? totE.kwh : e.kwh != null ? e.kwh : null;
    const demKW = isTotal ? totE.demandKW : e.demandKW != null ? e.demandKW : null;
    const bilKW = isTotal ? totE.billedKW : e.billedKW != null ? e.billedKW : null;
    const facKW = isTotal ? totE.facKW : e.facKW != null ? e.facKW : null;
    const kwCost = isTotal ? totE.kwCost : e.kwCost != null ? e.kwCost : null;
    const facKWCost = isTotal ? totE.facKWCost : e.facKWCost != null ? e.facKWCost : null;
    const totKWCost = kwCost != null || facKWCost != null ? (kwCost || 0) + (facKWCost || 0) : null;
    const engCost = isTotal ? totE.energyCost : e.energyCost != null ? e.energyCost : null;
    const eCost = isTotal ? totE.totalCost : e.totalCost != null ? e.totalCost : null;
    const normDays = isTotal ? null : e.normDays || null;
    const costKwh = kwh != null && kwh > 0 && engCost != null ? engCost / kwh : null;
    const costBilKW = isTotal
      ? totE.costPerBilledKW
      : bilKW && bilKW > 0 && kwCost && kwCost > 0
        ? kwCost / bilKW
        : null;
    const costFacKW = isTotal
      ? totE.costPerFacKW
      : facKW && facKW > 0 && facKWCost && facKWCost > 0
        ? facKWCost / facKW
        : null;
    const costTotKW = isTotal
      ? totE.costPerTotKW
      : bilKW && bilKW > 0 && totKWCost && totKWCost > 0
        ? totKWCost / bilKW
        : null;
    const loadFactor = isTotal
      ? totE.loadFactor
      : kwh && kwh > 0 && demKW && demKW > 0 && normDays > 0
        ? kwh / (demKW * 24 * normDays)
        : null;
    const minHours = isTotal ? totE.minHours : kwh && kwh > 0 && demKW && demKW > 0 ? kwh / demKW : null;

    const therms = isTotal ? totG.therms : g.therms != null ? g.therms : null;
    const gCost = isTotal ? totG.cost : g.cost != null ? g.cost : null;
    const cPerTherm = therms != null && therms > 0 && gCost != null ? gCost / therms : null;

    const kgal = isTotal ? totW.kgal : w.kgal != null ? w.kgal : null;
    const wCost = isTotal ? totW.cost : w.cost != null ? w.cost : null;
    const cPerKgal = kgal != null && kgal > 0 && wCost != null ? wCost / kgal : null;

    const p = propaneByMo[mo] || {};
    const gallons = isTotal ? totP.gallons : p.gallons != null ? p.gallons : null;
    const pCost = isTotal ? totP.cost : p.cost != null ? p.cost : null;
    const cPerGal = gallons != null && gallons > 0 && pCost != null ? pCost / gallons : null;

    return `<tr${isTotal ? ' class="total-row"' : ''}>
            ${td(moLabel, 'mo')}
            ${
              isElec
                ? `
              ${td(n1(kwh))} ${td(n1(demKW))} ${td(n1(bilKW))} ${td(n1(facKW))}
              ${td(nc(kwCost))} ${td(nc(facKWCost))} ${td(nc(totKWCost))} ${td(nc(engCost))} ${td(nc(eCost))}
              ${td(r4(costKwh))} ${td(r2(costBilKW))} ${td(r2(costFacKW))} ${td(r2(costTotKW))}
              ${td(pct(loadFactor))} ${td(n1(minHours))}
            `
                : ''
            }
            ${isGas ? `${td(n1(therms))} ${td(nc(gCost))} ${td(r4(cPerTherm))}` : ''}
            ${isWater ? `${td(n1(kgal))} ${td(nc(wCost))} ${td(r4(cPerKgal))}` : ''}
            ${isPropane ? `${td(n1(gallons))} ${td(nc(pCost))} ${td(r4(cPerGal))}` : ''}
          </tr>`;
  }
  const moRows = moList.map((mo) => moRow(mo, false)).join('');

  // ── Build HTML ──
  pane.innerHTML = `
          <style>
            .bbd-wrap{font-family:var(--font);font-size:11px;color:var(--text);padding:4px 0 20px}
            .bbd-title{text-align:center;font-size:15px;font-weight:800;color:#f0c040;letter-spacing:.06em;padding:8px 0 12px;text-transform:uppercase}
            .bbd-bl-tbl{border-collapse:collapse;font-size:10.5px}
            .bbd-bl-tbl td,.bbd-bl-tbl th{border:1px solid rgba(255,255,255,0.20);padding:3px 10px;white-space:nowrap;color:#e0eaff}
            .bbd-bl-tbl th{background:rgba(255,255,255,0.08);color:#c8d8f0;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
            .bbd-bl-tbl .bl-green{background:#0d3320;color:#4fffaa;font-weight:700;border-color:#1a5535}
            .bbd-summary{background:#0d1525;border:1px solid rgba(255,255,255,0.12);border-radius:9px;padding:12px 16px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:0;row-gap:10px}
            .bbd-sum-cell{display:flex;flex-direction:column;gap:3px;padding:8px 14px;border-right:1px solid rgba(255,255,255,0.07);flex:1;min-width:90px}
            .bbd-sum-cell:last-child{border-right:none}
            .bbd-sum-lbl{font-size:9.5px;color:var(--mdd-lbl-color,#8ab0d0);text-transform:uppercase;letter-spacing:.5px;font-weight:700;white-space:nowrap}
            .bbd-sum-val{font-size:15px;font-weight:800;color:#e8eef8;font-family:var(--mono);line-height:1.1}
            .bbd-sum-val.c-blue{color:#60b8ff} .bbd-sum-val.c-orange{color:#ffb040}
            .bbd-sum-val.c-green{color:#40e8a0} .bbd-sum-val.c-violet{color:#b090ff}
            .bbd-rate-block{display:flex;flex-direction:column;gap:3px;margin-top:1px}
            .bbd-rate-row{display:flex;gap:5px;align-items:baseline}
            .bbd-rate-season{font-size:9px;color:#7090a8;font-weight:700;text-transform:uppercase;width:38px;flex-shrink:0;letter-spacing:.3px}
            .bbd-rate-val{font-size:12px;font-weight:700;font-family:var(--mono);color:#e8eef8}
            .bbd-tbl-wrap{overflow-x:auto;margin-bottom:16px;border:1px solid rgba(255,255,255,0.1);border-radius:9px;background:#080e1c}
            .bbd-tbl{border-collapse:collapse;width:100%;font-size:11px;table-layout:auto}
            .bbd-tbl th{font-weight:700;padding:6px 9px;text-align:center;border:1px solid rgba(255,255,255,0.12);white-space:nowrap;font-size:10px;letter-spacing:.2px}
            .bbd-tbl th.mo-hdr{background:#0d1830;color:#c8d8f0;text-align:left;padding-left:12px;font-size:11px}
            .bbd-tbl th.e-hdr{background:#0a1e38;color:#7dd8ff;border-color:rgba(100,180,255,0.15)}
            .bbd-tbl th.g-hdr{background:#221508;color:#ffb040;border-color:rgba(255,160,50,0.2)}
            .bbd-tbl th.w-hdr{background:#081e18;color:#40e8a0;border-color:rgba(50,220,140,0.2)}
            .bbd-tbl td{padding:5px 9px;text-align:center;border:1px solid rgba(255,255,255,0.10);font-family:var(--mono);font-size:11px;white-space:nowrap;color:#e8f0ff}
            .bbd-tbl td.mo{text-align:left;font-family:var(--font);font-weight:700;color:#c8d8f0;background:#0d1830;padding-left:12px}
            .bbd-tbl tbody tr:hover td{background:rgba(100,160,255,0.07)}
            .bbd-tbl tbody tr:hover td.mo{background:#0d1830}
            .bbd-tbl tr.total-row td{border-top:2px solid rgba(255,255,255,0.18);font-weight:800;background:#0d1830;color:#ffffff;font-size:11.5px}
            .bbd-tbl tr.total-row td.mo{color:#ffffff;background:#0d1830}

            [data-theme='light'] .bbd-summary{background:var(--s2);border-color:var(--border)}
            [data-theme='light'] .bbd-sum-cell{border-right-color:var(--border)}
            [data-theme='light'] .bbd-sum-lbl{color:var(--text2)}
            [data-theme='light'] .bbd-sum-val{color:var(--text)}
            [data-theme='light'] .bbd-sum-val.c-blue{color:#1d6eaf}
            [data-theme='light'] .bbd-sum-val.c-orange{color:#a05a00}
            [data-theme='light'] .bbd-sum-val.c-green{color:#1a7a4a}
            [data-theme='light'] .bbd-sum-val.c-violet{color:#5a2fa0}
            [data-theme='light'] .bbd-rate-season{color:var(--text3)}
            [data-theme='light'] .bbd-rate-val{color:var(--text)}
            [data-theme='light'] .bbd-title{color:var(--em)}
            [data-theme='light'] .bbd-tbl-wrap{background:var(--s2);border-color:var(--border)}
            [data-theme='light'] .bbd-tbl th{color:var(--text)}
            [data-theme='light'] .bbd-tbl th.mo-hdr{background:var(--s1);color:var(--text2)}
            [data-theme='light'] .bbd-tbl th.e-hdr{background:#c5d9f0;color:#1a4060;border-color:#a0c0e0}
            [data-theme='light'] .bbd-tbl th.g-hdr{background:#f0e4cc;color:#7a4a00;border-color:#d0b070}
            [data-theme='light'] .bbd-tbl th.w-hdr{background:#c5e8d5;color:#1a5c35;border-color:#80c5a0}
            [data-theme='light'] .bbd-tbl td{color:var(--text);border-color:var(--border)}
            [data-theme='light'] .bbd-tbl td.mo{background:var(--s3);color:var(--text2)}
            [data-theme='light'] .bbd-tbl tbody tr:hover td{background:rgba(0,0,0,0.03)}
            [data-theme='light'] .bbd-tbl tbody tr:hover td.mo{background:var(--s3)}
            [data-theme='light'] .bbd-tbl tr.total-row td{background:var(--s1);color:var(--text);border-top-color:var(--border2)}
            [data-theme='light'] .bbd-tbl tr.total-row td.mo{background:var(--s1)}
            [data-theme='light'] .bbd-bl-tbl td,[data-theme='light'] .bbd-bl-tbl th{border-color:var(--border);color:var(--text)}
            [data-theme='light'] .bbd-bl-tbl th{background:var(--s1);color:var(--text2)}
            [data-theme='light'] .bbd-bl-tbl .bl-green{background:#c5ecd8;color:#1a5c35;border-color:#80c0a0}
          </style>
          <div class="bbd-wrap" style="--mdd-lbl-color:${isElec ? '#6ab0e8' : isGas ? '#d08030' : isPropane ? '#d08030' : '#40c8a0'}">
            <div class="bbd-title">Meter Data</div>

            <!-- Data Quality Score Card -->
            ${
              _dqScore
                ? `<div style="background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
                <div>
                  <div style="font-size:18px;font-weight:800;color:${_dqBadgeData.textColor};background:${_dqBadgeData.bgColor};font-family:var(--mono);line-height:1.3;padding:2px 14px;border-radius:10px">${_dqBadgeData.label}</div>
                  <div style="font-size:9.5px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-top:2px">Data Quality</div>
                </div>
              </div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;flex:1">
                ${['dataMonths', 'baselineR2', 'gaps', 'fieldCompleteness', 'flags']
                  .map((key) => {
                    const comp = _dqScore.components[key];
                    const labels = {
                      dataMonths: 'History',
                      baselineR2: 'R²',
                      gaps: 'Gaps',
                      fieldCompleteness: 'Fields',
                      flags: 'Flags',
                    };
                    const full = comp.points >= comp.max;
                    // R² component: show the actual 0-1 statistic as the primary value,
                    // not a points score. The points still feed the composite total internally.
                    if (key === 'baselineR2') {
                      const r2v = comp.r2Val;
                      const r2Str = r2v != null ? r2v.toFixed(2) : '—';
                      const r2Color =
                        r2v == null
                          ? '#6a90b0'
                          : r2v >= 0.85
                            ? '#22c55e'
                            : r2v >= 0.65
                              ? 'var(--amber,#f59e0b)'
                              : 'var(--danger,#ef4444)';
                      const r2Tooltip = `R² measures how well the baseline regression fits the data (0–1). Higher is better; 0.85+ is strong.`;
                      return `<div style="display:flex;flex-direction:column;gap:2px;min-width:56px" title="${r2Tooltip}">
                  <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:700">${labels[key]}</div>
                  <div style="font-size:13px;font-weight:800;color:${r2Color};font-family:var(--mono)">${r2Str}</div>
                  <div style="font-size:9px;color:var(--text3)">${r2v != null ? (r2v >= 0.85 ? 'strong fit' : r2v >= 0.65 ? 'moderate fit' : 'weak fit') : 'no baseline'}</div>
                </div>`;
                    }
                    const rv = comp.rawValue;
                    const rm = comp.rawMax;
                    const displayValue = key === 'dataMonths' ? rv + ' months' : String(rv);
                    const hint =
                      key === 'dataMonths'
                        ? 'more = better'
                        : key === 'gaps'
                          ? '0 = no gaps'
                          : key === 'fieldCompleteness'
                            ? 'more = better'
                            : '0 = none';
                    const tileColor =
                      key === 'dataMonths'
                        ? rv >= 24
                          ? '#22c55e'
                          : rv >= 12
                            ? 'var(--amber,#f59e0b)'
                            : 'var(--danger,#ef4444)'
                        : key === 'gaps'
                          ? rv === 0
                            ? '#22c55e'
                            : rv <= 2
                              ? 'var(--amber,#f59e0b)'
                              : 'var(--danger,#ef4444)'
                          : key === 'fieldCompleteness'
                            ? rv >= rm
                              ? '#22c55e'
                              : rv >= rm - 2
                                ? 'var(--amber,#f59e0b)'
                                : 'var(--danger,#ef4444)'
                            : rv === 0
                              ? '#22c55e'
                              : rv <= 3
                                ? 'var(--amber,#f59e0b)'
                                : 'var(--danger,#ef4444)';
                    const tileTooltip =
                      key === 'dataMonths'
                        ? 'Months of billing history. More is better; 24+ months is ideal.'
                        : key === 'gaps'
                          ? 'Gaps larger than 45 days between consecutive bills. Zero is ideal.'
                          : key === 'fieldCompleteness'
                            ? 'Populated fields in the last 3 bills (start, end, cost, usage). Higher is better.'
                            : 'Active (non-dismissed) data flags on any bill. Zero is ideal.';
                    return `<div style="display:flex;flex-direction:column;gap:2px;min-width:56px" title="${tileTooltip}">
                  <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:700">${labels[key]}</div>
                  <div style="font-size:13px;font-weight:800;color:${tileColor};font-family:var(--mono)">${displayValue}</div>
                  <div style="font-size:9px;color:var(--text3)">${hint}</div>
                </div>`;
                  })
                  .join('')}
              </div>
            </div>`
                : ''
            }

            <!-- Meta row -->
            <div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px 28px;margin-bottom:14px;align-items:start;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:14px 18px">
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Data Baseline Years</div>
                <table class="bbd-bl-tbl">
                  <tr><th>${isElec ? 'Electricity' : isGas ? 'Heating Fuel' : isPropane ? 'Propane' : 'Water'}</th></tr>
                  <tr><td class="bl-green">${blSpan(blRows)}</td></tr>
                </table>
              </div>
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Utility Provider</div>
                <div style="font-size:11.5px;color:var(--text2)">${isElec ? 'Electric' : isGas ? 'Heating Fuel' : isPropane ? 'Propane' : 'Water'} Company <span style="color:var(--text);font-weight:700">${m.provider || m.name || '—'}</span></div>
              </div>
              <div>
                <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Utility Units</div>
                <div style="font-size:11.5px;color:var(--text2)">${isElec ? 'Electricity' : ''}${isGas ? 'Heating Fuel' : ''}${isPropane ? 'Propane' : ''}${isWater ? 'Water' : ''} <span style="color:${isElec ? '#7dd8ff' : isGas ? '#ffb040' : isPropane ? '#ffb040' : '#40e8a0'};font-weight:800;margin-left:8px;font-size:12px">${getMeterDisplayUnit(m)}</span></div>
              </div>
            </div>

            <!-- Summary bar -->
            <div class="bbd-summary">
              ${sqft > 0 ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Square Feet</div><div class="bbd-sum-val">${sqft.toLocaleString()}</div></div>` : ''}
              ${kwhPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">kWh / sf</div><div class="bbd-sum-val c-blue">${kwhPerSf.toFixed(2)}</div></div>` : ''}
              ${costPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">${isElec ? 'Electric Energy' : isGas ? 'Gas' : isPropane ? 'Propane' : 'Utility'} Cost / sf</div><div class="bbd-sum-val c-green">${$c(costPerSf)}</div></div>` : ''}
              ${hoursOperated != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Hours Operated</div><div class="bbd-sum-val">${hoursOperated.toLocaleString()}</div></div>` : ''}
              ${avgWattsPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Avg Watts / sf</div><div class="bbd-sum-val c-blue">${avgWattsPerSf.toFixed(2)}</div></div>` : ''}
              ${elecDolPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Electric $ / sf</div><div class="bbd-sum-val c-orange">${$c(elecDolPerSf)}</div></div>` : ''}
              ${
                isElec
                  ? `
              <div class="bbd-sum-cell" style="min-width:110px">
                <div class="bbd-sum-lbl">$ / kWh Rate</div>
                <div class="bbd-rate-block">
                  <div class="bbd-rate-row"><span class="bbd-rate-season">☀ Sum</span><span class="bbd-rate-val c-orange" style="font-size:13px;font-weight:800">${sumKwhRate ? $5(sumKwhRate) : '—'}</span></div>
                  <div class="bbd-rate-row"><span class="bbd-rate-season">❄ Win</span><span class="bbd-rate-val c-blue" style="font-size:13px;font-weight:800">${winKwhRate ? $5(winKwhRate) : '—'}</span></div>
                </div>
              </div>
              <div class="bbd-sum-cell" style="min-width:110px">
                <div class="bbd-sum-lbl">$ / kW Rate</div>
                <div class="bbd-rate-block">
                  <div class="bbd-rate-row"><span class="bbd-rate-season">☀ Sum</span><span class="bbd-rate-val c-orange" style="font-size:13px;font-weight:800">${sumKwRate ? '$' + sumKwRate.toFixed(3) : '—'}</span></div>
                  <div class="bbd-rate-row"><span class="bbd-rate-season">❄ Win</span><span class="bbd-rate-val c-blue" style="font-size:13px;font-weight:800">${winKwRate ? '$' + winKwRate.toFixed(3) : '—'}</span></div>
                </div>
              </div>`
                  : ''
              }
              ${thermPerSf != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Therm / sf</div><div class="bbd-sum-val c-orange">${thermPerSf.toFixed(3)}</div></div>` : ''}
              ${gasPerTherm != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Gas $ / Therm</div><div class="bbd-sum-val c-orange">${$c(gasPerTherm)}</div></div>` : ''}
              ${isPropane && totP_costPerGal != null ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">Propane $ / Gal</div><div class="bbd-sum-val c-orange">${$c(totP_costPerGal)}</div></div>` : ''}
              ${kbtuPerSf != null && (isElec || isGas) ? `<div class="bbd-sum-cell"><div class="bbd-sum-lbl">kBtu / sf</div><div class="bbd-sum-val c-violet">${kbtuPerSf.toFixed(2)}</div></div>` : ''}
              <div class="bbd-sum-cell"><div class="bbd-sum-lbl">${isElec ? 'Electric' : isGas ? 'Gas' : isPropane ? 'Propane' : 'Utility'} Costs / Year</div><div class="bbd-sum-val c-green">${$c(totCost, 0)}</div></div>
            </div>

            <!-- Main data table -->
            <div class="bbd-tbl-wrap">
              <table class="bbd-tbl">
                <thead>
                  <tr>
                    <th rowspan="2" class="mo-hdr" style="vertical-align:middle;min-width:52px">Month</th>
                    ${isElec ? `<th colspan="15" class="e-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">ELECTRICITY</th>` : ''}
                    ${isGas ? `<th colspan="3" class="g-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">HEATING FUEL</th>` : ''}
                    ${isWater ? `<th colspan="3" class="w-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">WATER</th>` : ''}
                    ${isPropane ? `<th colspan="3" class="g-hdr" style="font-size:12px;padding:7px 8px;letter-spacing:.8px">PROPANE</th>` : ''}
                  </tr>
                  <tr>
                    ${
                      isElec
                        ? `
                      <th class="e-hdr" title="Normalized Baseline kWh">Normalized kWh</th>
                      <th class="e-hdr">Actual kW</th><th class="e-hdr">Billed<br>kW</th><th class="e-hdr">Facilities kW</th>
                      <th class="e-hdr">Billed kW<br>Cost</th><th class="e-hdr">Facilities kW<br>Cost</th><th class="e-hdr">Total kW<br>Cost</th>
                      <th class="e-hdr">Energy<br>Cost</th><th class="e-hdr">Electric<br>Cost</th>
                      <th class="e-hdr">Cost/<br>kWh</th><th class="e-hdr">Cost/<br>Billed kW</th>
                      <th class="e-hdr">Cost/<br>Facilities kW</th><th class="e-hdr">Cost/<br>Total kW</th>
                      <th class="e-hdr">% Load<br>Factor</th><th class="e-hdr">Min<br>Hours</th>
                    `
                        : ''
                    }
                    ${
                      isGas
                        ? `
                      <th class="g-hdr" title="Normalized Baseline Therms">Normalized Therms</th>
                      <th class="g-hdr">Gas Cost</th><th class="g-hdr">Cost/<br>Therm</th>
                    `
                        : ''
                    }
                    ${
                      isWater
                        ? `
                      <th class="w-hdr" title="Normalized Baseline kGal">Normalized kGal</th>
                      <th class="w-hdr">Water<br>Cost</th><th class="w-hdr">Cost/<br>kGal</th>
                    `
                        : ''
                    }
                    ${
                      isPropane
                        ? `
                      <th class="g-hdr" title="Normalized Baseline Gallons">Normalized Gallons</th>
                      <th class="g-hdr">Propane<br>Cost</th><th class="g-hdr">Cost/<br>Gallon</th>
                    `
                        : ''
                    }
                  </tr>
                </thead>
                <tbody>${moRows}</tbody>
                <tfoot>${moRow(null, true)}</tfoot>
              </table>
            </div>

            <!-- Monthly Cost Chart -->
            <div style="margin-top:18px;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:16px 18px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:12px;text-align:center">Dollars Spent Monthly By Utility Type</div>
              <div style="position:relative;height:300px"><canvas id="mddCostChart"></canvas></div>
            </div>

            ${
              isElec
                ? `
            <!-- Load Factor Trend Chart -->
            <div style="margin-top:18px;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:16px 18px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:4px;text-align:center">Monthly Load Factor %</div>
              <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:12px">kWh ÷ (Actual kW × 24 × Norm Days)</div>
              <div style="position:relative;height:260px"><canvas id="mddLoadFactorChart"></canvas></div>
            </div>

            <!-- Minimum Hours Chart -->
            <div style="margin-top:18px;background:var(--s3);border:1px solid var(--border);border-radius:9px;padding:16px 18px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:4px;text-align:center">Monthly Minimum Hours</div>
              <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:12px">kWh ÷ Actual kW — hours demand would need to run at peak to deliver actual kWh</div>
              <div style="position:relative;height:260px"><canvas id="mddMinHoursChart"></canvas></div>
            </div>
            `
                : ''
            }

          </div>`;

  // ── Draw chart ──
  requestAnimationFrame(() => {
    const canvas = document.getElementById('mddCostChart');
    if (!canvas) return;
    if (_maCharts['mddCostChart']) {
      _maCharts['mddCostChart'].destroy();
    }
    const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const labels = moList.map((mo) => MONTHS_S[mo]);
    const datasets = [];
    const fmtDollar = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    if (isElec) {
      datasets.push({
        label: 'kWh Electric Cost',
        data: moList.map((mo) => +(elecByMo[mo]?.energyCost || 0).toFixed(2)),
        backgroundColor: 'rgba(100,180,255,0.85)',
        borderColor: 'rgba(100,180,255,1)',
        borderWidth: 0,
        stack: 'cost',
      });
      datasets.push({
        label: 'kW Electric Demand Cost',
        data: moList.map((mo) => +((elecByMo[mo]?.kwCost || 0) + (elecByMo[mo]?.facKWCost || 0)).toFixed(2)),
        backgroundColor: 'rgba(147,210,255,0.85)',
        borderColor: 'rgba(147,210,255,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }
    if (isGas) {
      datasets.push({
        label: 'Gas Cost',
        data: moList.map((mo) => +(gasByMo[mo]?.cost || 0).toFixed(2)),
        backgroundColor: 'rgba(245,130,30,0.9)',
        borderColor: 'rgba(245,130,30,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }
    if (isWater) {
      datasets.push({
        label: 'Water Cost',
        data: moList.map((mo) => +(waterByMo[mo]?.cost || 0).toFixed(2)),
        backgroundColor: 'rgba(50,220,140,0.8)',
        borderColor: 'rgba(50,220,140,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }
    if (isPropane) {
      datasets.push({
        label: 'Propane Cost',
        data: moList.map((mo) => +(propaneByMo[mo]?.cost || 0).toFixed(2)),
        backgroundColor: 'rgba(245,130,30,0.9)',
        borderColor: 'rgba(245,130,30,1)',
        borderWidth: 0,
        stack: 'cost',
      });
    }

    _maCharts['mddCostChart'] = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: 'rgba(200,220,240,0.9)', font: { size: 11 }, boxWidth: 14, padding: 14 },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => (ctx.parsed.y > 0 ? ' ' + ctx.dataset.label + ': ' + fmtDollar(ctx.parsed.y) : null),
              footer: (items) => {
                const t = items.reduce((s, i) => s + i.parsed.y, 0);
                return t > 0 ? 'Total: ' + fmtDollar(t) : '';
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.10)' },
          },
          y: {
            stacked: true,
            ticks: {
              color: 'rgba(180,200,220,0.8)',
              font: { size: 10 },
              callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
            },
            grid: { color: 'rgba(255,255,255,0.12)' },
            title: { display: true, text: 'Dollars Spent', color: 'rgba(160,185,210,0.8)', font: { size: 11 } },
          },
        },
      },
    });
  });

  // ── Draw Load Factor chart (electric only) ──
  if (isElec) {
    requestAnimationFrame(() => {
      const lfCanvas = document.getElementById('mddLoadFactorChart');
      if (!lfCanvas) return;
      if (_maCharts['mddLoadFactorChart']) {
        _maCharts['mddLoadFactorChart'].destroy();
      }
      const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const lfLabels = moList.map((mo) => MONTHS_S[mo]);
      const lfData = moList.map((mo) => {
        const e = elecByMo[mo];
        if (!e || !e.demandKW || e.demandKW <= 0 || !e.normDays || e.normDays <= 0 || !e.kwh || e.kwh <= 0) return null;
        return +((e.kwh / (e.demandKW * 24 * e.normDays)) * 100).toFixed(2);
      });

      _maCharts['mddLoadFactorChart'] = new Chart(lfCanvas, {
        type: 'bar',
        data: {
          labels: lfLabels,
          datasets: [
            {
              label: 'Load Factor %',
              data: lfData,
              backgroundColor: 'rgba(147,100,255,0.75)',
              borderColor: 'rgba(147,100,255,1)',
              borderWidth: 1,
              borderRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              callbacks: {
                label: (ctx) => (ctx.parsed.y != null ? ' Load Factor: ' + ctx.parsed.y.toFixed(2) + '%' : null),
              },
            },
          },
          scales: {
            x: {
              ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 } },
              grid: { color: 'rgba(255,255,255,0.10)' },
            },
            y: {
              beginAtZero: true,
              max: 100,
              ticks: {
                color: 'rgba(180,200,220,0.8)',
                font: { size: 10 },
                callback: (v) => v + '%',
              },
              grid: { color: 'rgba(255,255,255,0.12)' },
              title: {
                display: true,
                text: 'Load Factor %',
                color: 'rgba(160,185,210,0.8)',
                font: { size: 11 },
              },
            },
          },
        },
      });
    });
  }

  // ── Draw Minimum Hours chart (electric only) ──
  if (isElec) {
    requestAnimationFrame(() => {
      const mhCanvas = document.getElementById('mddMinHoursChart');
      if (!mhCanvas) return;
      if (_maCharts['mddMinHoursChart']) {
        _maCharts['mddMinHoursChart'].destroy();
      }
      const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mhLabels = moList.map((mo) => MONTHS_S[mo]);
      const mhData = moList.map((mo) => {
        const e = elecByMo[mo];
        if (!e || !e.demandKW || e.demandKW <= 0 || !e.kwh || e.kwh <= 0) return null;
        return +(e.kwh / e.demandKW).toFixed(2);
      });

      _maCharts['mddMinHoursChart'] = new Chart(mhCanvas, {
        type: 'bar',
        data: {
          labels: mhLabels,
          datasets: [
            {
              label: 'Min Hours',
              data: mhData,
              backgroundColor: 'rgba(100,220,160,0.75)',
              borderColor: 'rgba(100,220,160,1)',
              borderWidth: 1,
              borderRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              callbacks: {
                label: (ctx) => (ctx.parsed.y != null ? ' Min Hours: ' + ctx.parsed.y.toFixed(2) + ' hrs' : null),
              },
            },
          },
          scales: {
            x: {
              ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 } },
              grid: { color: 'rgba(255,255,255,0.10)' },
            },
            y: {
              beginAtZero: true,
              ticks: {
                color: 'rgba(180,200,220,0.8)',
                font: { size: 10 },
                callback: (v) => v + ' hrs',
              },
              grid: { color: 'rgba(255,255,255,0.12)' },
              title: {
                display: true,
                text: 'Hours',
                color: 'rgba(160,185,210,0.8)',
                font: { size: 11 },
              },
            },
          },
        },
      });
    });
  }
}

/* ══════════════════════════════════════════════
         BUILDING-LEVEL PERFORMANCE PANE
         Calls renderPerfPane for each meter — exact
         same data pipeline as the meter Performance tab
      ══════════════════════════════════════════════ */
let _bpBaselineByCalMo = null;
let _bpActualSavingsByCalMo = null;
let _bpActualSavingsByYM = null; // {YYYY-MM: savings} used for quarterly view to avoid cross-year key collisions
let _bpPostBaselineStartYM = null; // earliest post-baseline YYYY-MM across all meters
let _bpMsrSavByMo = null; // measure-based monthly savings for Building Performance (null = use savPct fallback)
let _bspBaselineByCalMo = null;
let _bspMsrSavByMo = null; // measure-based monthly savings for Building Savings Projection (null = use savPct fallback)

function renderBldgPerfPane(pane, b) {
  if (!b) {
    pane.innerHTML = '<div class="ud-empty">No building selected</div>';
    return;
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Baseline spend per calendar month ──
  const baselineByCalMo = {};
  (b.meters || []).forEach((m) => {
    const bl = m.baseline;
    if (!bl || !(bl.months || []).length) return;
    const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const incl = m.inclusive !== false;
    const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
    allRows
      .filter((r) => bl.months.includes(r.ym))
      .forEach((r) => {
        const mo = parseInt(r.ym.split('-')[1]) - 1;
        baselineByCalMo[mo] = (baselineByCalMo[mo] || 0) + r.cost;
      });
  });
  _bpBaselineByCalMo = Array.from({ length: 12 }, (_, i) => baselineByCalMo[i] || 0);
  _bpActualSavingsByCalMo = null; // reset, will be computed below

  // ── Projected spend per calendar month — from BSP saved config ──
  const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
  const bspCfg = DB.get(bspKey, {});
  const savPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;
  _bpMsrSavByMo = getBldgMeasureSavingsByMo(udSelProjId, b.id);

  // ── Actual savings per calendar month ──
  // Sum Total Cost Savings from each meter's Performance tab (same values shown there)
  const actualSavingsByCalMo = {};
  const actualSavingsByYM = {}; // keyed by YYYY-MM for quarterly view (avoids cross-year collisions)
  (b.meters || []).forEach((m) => {
    if (m.baselineInclude === false) return;
    if (!(m.baseline?.months?.length >= 3)) return;
    const mbills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const mincl = m.inclusive !== false;
    const _mSavResult = getMeterSavings(m, mbills, mincl, udSelProjId, b.id);
    Object.entries(_mSavResult.byCalMo).forEach(([mo, v]) => {
      actualSavingsByCalMo[mo] = (actualSavingsByCalMo[mo] || 0) + v;
    });
    Object.entries(_mSavResult.byYM).forEach(([ym, v]) => {
      actualSavingsByYM[ym] = (actualSavingsByYM[ym] || 0) + v;
    });
  });
  const hasActual = Object.keys(actualSavingsByCalMo).length > 0;
  _bpActualSavingsByCalMo = actualSavingsByCalMo;
  _bpActualSavingsByYM = actualSavingsByYM;
  // Determine the earliest post-baseline YYYY-MM for quarterly Year 1 anchoring
  const _ymKeys = Object.keys(actualSavingsByYM).sort();
  _bpPostBaselineStartYM = _ymKeys.length > 0 ? _ymKeys[0] : null;

  // ── Saved settings ──
  const storeKey = 'bldgperf_cfg_' + (b.id || b.name);
  const cfg = DB.get(storeKey, {});
  const defCscMode = cfg.cscMode ?? 'pct'; // 'pct' or 'fixed'
  // Fall back to project-level cscCompensation if building has no custom override
  const projMeta = projects.find((p) => p.id === udSelProjId);
  const defCscPct = cfg._customCsc ? cfg.cscPct : (projMeta?.cscCompensation ?? cfg.cscPct ?? 0);
  const defCscFixed = cfg.cscFixed ?? 500;
  const defYears = cfg.years ?? 3;
  // Fall back to project-level escalation if building has no custom override
  const defEscPct = cfg._customEsc ? cfg.escPct : (projMeta?.escalation ?? cfg.escPct ?? 3);
  const defView = cfg.view ?? 'monthly';

  // Sync global view/mode state from saved config so bpRecalc uses correct values
  _bpView = defView;
  _bpMode = defCscMode;

  const _bpMsrCount = _bpMsrSavByMo
    ? (projects.find((x) => x.id === udSelProjId)?.savingsData?.measures || []).filter(
        (m) => m.bldgId === b.id && m.selected !== false,
      ).length
    : 0;
  const _bpSourceLabel = _bpMsrSavByMo
    ? '<div style="font-size:10px;color:var(--accent);margin-top:2px">\u{1F4CA} Source: Energy Savings Measures (' +
      _bpMsrCount +
      ' measure' +
      (_bpMsrCount !== 1 ? 's' : '') +
      ')</div>'
    : '<div style="font-size:10px;color:var(--text3);margin-top:2px">\u{1F4CA} Source: Savings %</div>';

  pane.innerHTML = `
          <div style="margin-bottom:14px">
            <div style="font-size:16px;font-weight:800;font-family:var(--head);letter-spacing:-.01em">💡 ${b.name} — Building Performance</div>
            <div style="font-size:12px;color:var(--text2);margin-top:3px">Baseline from Meter Data · projected values from Building Savings Projection settings</div>
            ${_bpSourceLabel}
          </div>

          <!-- Controls -->
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:18px;background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:13px 16px">
            <!-- CSC mode toggle -->
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">CSC Compensation Mode</label>
              <div style="display:flex;gap:4px">
                <button id="bp-mode-pct" onclick="bpSetMode('pct')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defCscMode === 'pct' ? 'var(--em)' : 'transparent'};color:${defCscMode === 'pct' ? '#05080f' : 'var(--text2)'}">% of Current Savings</button>
                <button id="bp-mode-fixed" onclick="bpSetMode('fixed')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defCscMode === 'fixed' ? 'var(--em)' : 'transparent'};color:${defCscMode === 'fixed' ? '#05080f' : 'var(--text2)'}">Fixed Monthly Cost</button>
              </div>
            </div>
            <!-- CSC % input (shown in pct mode) -->
            <div id="bp-csc-pct-wrap" style="display:${defCscMode === 'pct' ? 'flex' : 'none'};flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">CSC Compensation %</label>
              <input id="bp-cscpct" type="number" value="${defCscPct}" min="0" max="100" step="0.1"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <!-- Fixed $ input (shown in fixed mode) -->
            <div id="bp-csc-fixed-wrap" style="display:${defCscMode === 'fixed' ? 'flex' : 'none'};flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Fixed Monthly Cost $</label>
              <input id="bp-cscfixed" type="number" value="${defCscFixed}" min="0" step="1"
                style="width:100px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <!-- Years -->
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Years</label>
              <select id="bp-years" style="font-family:var(--mono);font-size:13px;color:var(--text);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
                ${[1, 2, 3, 4, 5].map((y) => `<option value="${y}"${y === defYears ? ' selected' : ''}>${y} Year${y > 1 ? 's' : ''}</option>`).join('')}
              </select>
            </div>
            <!-- Escalation rate -->
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Utility Escalation %/yr</label>
              <input id="bp-escpct" type="number" value="${defEscPct}" min="0" max="20" step="0.1"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <!-- View -->
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">View</label>
              <div style="display:flex;gap:4px">
                <button id="bp-v-monthly" onclick="bpSetView('monthly')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defView === 'monthly' ? 'var(--em)' : 'transparent'};color:${defView === 'monthly' ? '#05080f' : 'var(--text2)'}">Monthly</button>
                <button id="bp-v-quarterly" onclick="bpSetView('quarterly')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defView === 'quarterly' ? 'var(--em)' : 'transparent'};color:${defView === 'quarterly' ? '#05080f' : 'var(--text2)'}">Quarterly</button>
              </div>
            </div>
            <button onclick="bpApplyToAllBuildings()" style="font-family:var(--font);font-size:11px;font-weight:600;padding:7px 12px;border-radius:7px;border:1px solid var(--border);cursor:pointer;background:var(--s3);color:var(--text2);align-self:flex-end" title="Apply these settings to all buildings in this project">📋 Apply to All Buildings</button>
          </div>

          <!-- Results -->
          <div id="bp-results"></div>`;

  // Caller (line 13819) handles bpRecalc() after DOM append
}

let _bpView = 'monthly';
let _bpMode = 'pct';

function bpSetView(v) {
  _bpView = v;
  ['monthly', 'quarterly'].forEach((vv) => {
    const btn = document.getElementById('bp-v-' + vv);
    if (!btn) return;
    btn.style.background = vv === v ? 'var(--em)' : 'transparent';
    btn.style.color = vv === v ? '#05080f' : 'var(--text2)';
  });
  bpRecalc();
}

function bpSetMode(m) {
  _bpMode = m;
  ['pct', 'fixed'].forEach((mm) => {
    const btn = document.getElementById('bp-mode-' + mm);
    if (!btn) return;
    btn.style.background = mm === m ? 'var(--em)' : 'transparent';
    btn.style.color = mm === m ? '#05080f' : 'var(--text2)';
  });
  const pw = document.getElementById('bp-csc-pct-wrap');
  const fw = document.getElementById('bp-csc-fixed-wrap');
  if (pw) pw.style.display = m === 'pct' ? 'flex' : 'none';
  if (fw) fw.style.display = m === 'fixed' ? 'flex' : 'none';
  bpRecalc();
}

function bpApplyToAllBuildings() {
  const cscMode = _bpMode;
  const cscPct = parseFloat(document.getElementById('bp-cscpct')?.value || 0);
  const cscFixed = parseFloat(document.getElementById('bp-cscfixed')?.value || 0);
  const years = parseInt(document.getElementById('bp-years')?.value || 3);
  const escPct = parseFloat(document.getElementById('bp-escpct')?.value || 0);
  const bldgs = getUDBldgs(udSelProjId);
  if (!bldgs.length) return;
  const settings = { cscMode, cscPct, cscFixed, years, escPct, _customEsc: true };
  let count = 0;
  bldgs.forEach((b) => {
    const key = 'bldgperf_cfg_' + (b.id || b.name);
    try {
      const existing = DB.get(key, {});
      DB.set(key, { ...existing, ...settings });
      count++;
    } catch (e) {}
  });
  showToast(
    'Applied settings to ' +
      count +
      ' building' +
      (count !== 1 ? 's' : '') +
      ' (CSC ' +
      (cscMode === 'pct' ? cscPct + '%' : '$' + cscFixed + '/mo') +
      ', ' +
      years +
      ' yr, ' +
      escPct +
      '% esc)',
    'success',
  );
}

function bpRecalc() {
  const cscMode = _bpMode;
  const cscPct = parseFloat(document.getElementById('bp-cscpct')?.value || 0) / 100;
  const cscFixed = parseFloat(document.getElementById('bp-cscfixed')?.value || 0);
  const years = parseInt(document.getElementById('bp-years')?.value || 3);
  const escPct = parseFloat(document.getElementById('bp-escpct')?.value || 0) / 100;
  const view = _bpView;
  const moBase = _bpBaselineByCalMo || Array(12).fill(0);
  const annBase = moBase.reduce((s, v) => s + v, 0);

  // Save config
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (b) {
    const storeKey = 'bldgperf_cfg_' + (b.id || b.name);
    try {
      const _prevCfg = DB.get(storeKey, {});
      const _projM = projects.find((p) => p.id === udSelProjId);
      const _projEsc = _projM?.escalation ?? 3;
      const _projCsc = _projM?.cscCompensation ?? 0;
      const _saveCfg = Object.assign({}, _prevCfg, {
        cscMode,
        cscPct: cscPct * 100,
        cscFixed,
        years,
        escPct: escPct * 100,
        view,
      });
      delete _saveCfg.moBase;
      _saveCfg._customEsc = escPct * 100 !== _projEsc ? true : undefined;
      _saveCfg._customCsc = cscPct * 100 !== _projCsc ? true : undefined;
      DB.set(storeKey, _saveCfg);
    } catch (e) {}
  }

  // Projected spend from BSP config
  const bspKey = b ? 'bldgsavproj_cfg_' + (b.id || b.name) : null;
  const bspCfg = bspKey ? DB.get(bspKey, {}) : {};
  const savPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;
  const _msrSavByMo = _bpMsrSavByMo;
  const _useMeasures = !!_msrSavByMo;

  // Actual savings per calendar month (re-computed from stored data if available, or from b)
  // We re-use _bpActualSavingsByCalMo if set, else re-derive
  const actByMo = _bpActualSavingsByCalMo || {};
  const hasActual = Object.keys(actByMo).length > 0;

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $f = (v) =>
    v != null ? '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const $fc = (v) => (v != null ? (v < 0 ? '-' : '') + $f(v) : '—');
  const $cs = (v, force) => {
    if (v == null && !force) return '<span style="color:var(--text3)">—</span>';
    if (v == null) v = 0;
    const c = v >= 0 ? 'var(--em)' : 'var(--danger)';
    return `<span style="color:${c}">${v < 0 ? '−' : ''}${$f(v)}</span>`;
  };

  // Build columns
  let cols = [];
  if (view === 'monthly') {
    for (let mo = 0; mo < 12; mo++) cols.push({ label: MONTH_NAMES[mo], mo });
    cols.push({ label: 'Total', isTotal: true });
  } else {
    // For quarterly view, anchor quarters to actual post-baseline billing months so
    // Year 2 Q1 refers to a different set of YYYY-MM strings than Year 1 Q1.
    // This prevents values from repeating across years and prevents future quarters
    // from showing data from earlier years that happen to share the same calendar month.
    const actByYM = _bpActualSavingsByYM || {};
    const postStartYM = _bpPostBaselineStartYM; // earliest post-baseline YYYY-MM
    // Helper: add N months to a YYYY-MM string, returns YYYY-MM
    const addMonths = (ym, n) => {
      if (!ym) return null;
      let yr2 = parseInt(ym.slice(0, 4));
      let mo2 = parseInt(ym.slice(5, 7)) - 1 + n;
      yr2 += Math.floor(mo2 / 12);
      mo2 = ((mo2 % 12) + 12) % 12;
      return yr2 + '-' + String(mo2 + 1).padStart(2, '0');
    };
    for (let yr = 0; yr < years; yr++) {
      for (let q = 0; q < 4; q++) {
        const calMos = [q * 3, q * 3 + 1, q * 3 + 2]; // calendar month indices (for baseline)
        const offset = yr * 12 + q * 3;
        // Compute the actual YYYY-MM strings this quarter represents
        const yms = postStartYM
          ? [addMonths(postStartYM, offset), addMonths(postStartYM, offset + 1), addMonths(postStartYM, offset + 2)]
          : null;
        cols.push({ label: `Y${yr + 1} Q${q + 1}`, mos: calMos, yms, yr });
      }
    }
    cols.push({ label: 'Total', isTotal: true });
  }

  function colBaseQ(col) {
    if (col.isTotal) {
      let tot = 0;
      for (let yr = 0; yr < years; yr++) tot += annBase * Math.pow(1 + escPct, yr);
      return tot;
    }
    if (col.mos) {
      const factor = Math.pow(1 + escPct, col.yr || 0);
      return col.mos.reduce((s, mo) => s + moBase[mo], 0) * factor;
    }
    return (moBase[col.mo] || 0) * Math.pow(1 + escPct, col.yr || 0);
  }
  function getBase(col) {
    if (view === 'monthly') return col.isTotal ? annBase : moBase[col.mo] || 0;
    return colBaseQ(col);
  }
  const getProjSav = (col) => {
    if (_useMeasures) {
      if (col.isTotal) return _msrSavByMo.reduce((s, v) => s + v, 0);
      if (col.mo !== undefined) return _msrSavByMo[col.mo] || 0;
      if (col.mos) return col.mos.reduce((s, mo) => s + (_msrSavByMo[mo] || 0), 0);
      return 0;
    }
    return getBase(col) * savPct;
  };
  function getActSav(col) {
    if (!hasActual) return null;
    if (col.isTotal) {
      // Sum all actual YM savings we have data for
      return view === 'quarterly'
        ? Object.values(_bpActualSavingsByYM || {}).reduce((s, v) => s + v, 0)
        : Object.values(actByMo).reduce((s, v) => s + v, 0);
    }
    if (col.yms) {
      // Quarterly view: use YYYY-MM keyed data so Year 2 Q1 != Year 1 Q1
      const actByYM2 = _bpActualSavingsByYM || {};
      const ymsWithData = col.yms.filter((ym) => ym && ym in actByYM2);
      if (ymsWithData.length === 0) return null;
      if (ymsWithData.length < col.yms.length) return null; // partial or future quarter
      return col.yms.reduce((s, ym) => s + actByYM2[ym], 0);
    }
    if (col.mos) {
      // Fallback for monthly-style quarters (no YM anchor available)
      const monthsWithData = col.mos.filter((mo) => mo in actByMo);
      if (monthsWithData.length === 0) return null;
      if (monthsWithData.length < col.mos.length) return null;
      return col.mos.reduce((s, mo) => s + actByMo[mo], 0);
    }
    return actByMo[col.mo] ?? null;
  }
  function getCscVal(col) {
    const act = getActSav(col);
    if (act == null) return null;
    if (act <= 0) return 0;
    if (cscMode === 'pct') return act * cscPct;
    // fixed mode: fixed per month × number of months in col
    const nMos = col.isTotal ? (view === 'monthly' ? 12 : 12 * years) : col.mos ? col.mos.length : 1;
    return cscFixed * nMos;
  }
  function getCliVal(col) {
    const act = getActSav(col);
    const csc = getCscVal(col);
    if (act == null || csc == null) return null;
    return act - csc;
  }

  // Row definitions
  const annActSav = hasActual ? Object.values(actByMo).reduce((s, v) => s + v, 0) : null;
  const annProjSav = _useMeasures ? _msrSavByMo.reduce((s, v) => s + v, 0) : annBase * savPct;
  const projPct = annBase > 0 ? ((annProjSav / annBase) * 100).toFixed(0) + '%' : null;
  const actPct = hasActual && annBase > 0 ? ((annActSav / annBase) * 100).toFixed(1) + '%' : null;

  const thS =
    'padding:7px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);background:var(--s1);border:1px solid var(--border2);white-space:nowrap';
  const colHdrs = cols.map((c) => `<th style="${thS}">${c.label}</th>`).join('');

  let yearHdr = '';
  if (view === 'quarterly') {
    yearHdr = '<tr style="background:var(--s1)"><th style="border:1px solid var(--border2)"></th>';
    for (let yr = 0; yr < years; yr++)
      yearHdr += `<th colspan="4" style="text-align:center;padding:5px;font-size:11px;font-weight:700;color:var(--text);border:1px solid var(--border2);border-bottom:2px solid var(--em)">Year ${yr + 1}</th>`;
    yearHdr +=
      '<th style="border:1px solid var(--border2)"></th><th style="border:1px solid var(--border2)"></th></tr>';
  }

  // Row builder — % col now AFTER Total col
  const tdS = (color, isLast) =>
    `padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${color};font-weight:${isLast ? '700' : '400'};border:1px solid var(--border);background:${isLast ? 'var(--s1)' : 'transparent'};white-space:nowrap`;

  function makeRow(label, color, colFn, pctFn) {
    const cells = cols
      .map((col, i) => {
        const isLast = i === cols.length - 1;
        const v = colFn(col);
        const disp = v == null ? '<span style="color:var(--text3)">—</span>' : $cs(v);
        return `<td style="${tdS(v == null ? 'var(--text3)' : v >= 0 ? 'var(--em)' : 'var(--danger)', isLast)}">${disp}</td>`;
      })
      .join('');
    const pctLabel = typeof pctFn === 'function' ? pctFn() : pctFn;
    const pctCell =
      pctLabel != null
        ? `<td style="padding:7px 10px;text-align:center;font-family:var(--mono);font-size:12px;color:${color};font-weight:700;border:1px solid var(--border)">${pctLabel}</td>`
        : `<td style="border:1px solid var(--border)"></td>`;
    return `<tr><td style="padding:7px 12px;font-size:12px;font-weight:600;color:${color};white-space:nowrap;border:1px solid var(--border);background:var(--s1)">${label}</td>${cells}${pctCell}</tr>`;
  }

  function makeRegRow(label, color, colFn, pctLabel) {
    const cells = cols
      .map((col, i) => {
        const isLast = i === cols.length - 1;
        const v = colFn(col);
        return `<td style="${tdS(isLast ? color : 'var(--text)', isLast)}">${$fc(v)}</td>`;
      })
      .join('');
    const pctCell =
      pctLabel != null
        ? `<td style="padding:7px 10px;text-align:center;font-family:var(--mono);font-size:12px;color:${color};font-weight:700;border:1px solid var(--border)">${pctLabel}</td>`
        : `<td style="border:1px solid var(--border)"></td>`;
    return `<tr><td style="padding:7px 12px;font-size:12px;font-weight:600;color:${color};white-space:nowrap;border:1px solid var(--border);background:var(--s1)">${label}</td>${cells}${pctCell}</tr>`;
  }

  // Actual Utility Savings % row: per-month actual savings / per-month baseline
  function makeActPctRow() {
    if (!hasActual) return '';
    const cells = cols
      .map((col, i) => {
        const isLast = i === cols.length - 1;
        const act = getActSav(col);
        const base = getBase(col);
        const pct = act != null && base > 0 ? (act / base) * 100 : null;
        const disp =
          pct == null
            ? '<span style="color:var(--text3)">—</span>'
            : `<span style="color:${pct >= 0 ? 'var(--em)' : 'var(--danger)'}">${pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%</span>`;
        return `<td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px;border:1px solid var(--border);background:${isLast ? 'var(--s1)' : 'transparent'};white-space:nowrap">${disp}</td>`;
      })
      .join('');
    return `<tr><td style="padding:7px 12px;font-size:12px;font-weight:600;color:var(--text2);white-space:nowrap;border:1px solid var(--border);background:var(--s1)">Actual Utility Savings $ %</td>${cells}<td style="border:1px solid var(--border)"></td></tr>`;
  }

  const tableRows =
    makeRegRow('Baseline Utility Spend $', 'var(--text)', (col) => getBase(col), null) +
    makeRegRow('Projected Utility Spend $', 'var(--sky)', (col) => getBase(col) - getProjSav(col), null) +
    makeRegRow('Projected Utility Savings $', 'var(--em)', (col) => getProjSav(col), projPct) +
    (hasActual
      ? makeRegRow(
          'Actual Utility Spend $',
          'var(--text)',
          (col) => {
            const sav = getActSav(col);
            return sav != null ? getBase(col) - sav : null;
          },
          null,
        )
      : '') +
    (hasActual
      ? makeRow(
          'Actual Utility Savings $',
          annActSav >= 0 ? 'var(--em)' : 'var(--danger)',
          (col) => getActSav(col),
          actPct,
        )
      : '') +
    makeActPctRow() +
    (hasActual
      ? makeRow(
          'Client Utility Savings $',
          '#22c55e',
          (col) => getCliVal(col),
          cscMode === 'pct' ? (100 - cscPct * 100).toFixed(0) + '%' : null,
        )
      : '') +
    (hasActual
      ? makeRow(
          'CSC Utility Compensation $',
          'var(--em2)',
          (col) => getCscVal(col),
          cscMode === 'pct' ? (cscPct * 100).toFixed(0) + '%' : null,
        )
      : '');

  // Chart data — use projected spend, client savings, csc compensation
  const chartCols = cols.filter((c) => !c.isTotal);
  const chartLabels = JSON.stringify(chartCols.map((c) => c.label));
  const projSpendVals = JSON.stringify(chartCols.map((col) => getBase(col) - getProjSav(col)));
  const cliVals = JSON.stringify(chartCols.map((col) => (hasActual ? Math.max(0, getCliVal(col) || 0) : 0)));
  const cscVals = JSON.stringify(chartCols.map((col) => (hasActual ? Math.max(0, getCscVal(col) || 0) : 0)));
  // CSC cumulative
  let cum = 0;
  const cumVals = JSON.stringify(
    chartCols.map((col) => {
      cum += hasActual ? Math.max(0, getCscVal(col) || 0) : 0;
      return cum;
    }),
  );
  const showLine = view === 'quarterly';

  const annCsc = hasActual ? getCscVal({ isTotal: true }) || 0 : 0;
  const annCli = hasActual ? getCliVal({ isTotal: true }) || 0 : 0;

  const res = document.getElementById('bp-results');
  if (!res) return;
  res.innerHTML = `
          <!-- Summary stats (click any card to see formula) -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px">
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px;cursor:pointer" onclick="showFormula(_fml('Annual Baseline','Sum of all meter baseline costs across 12 calendar months','${$f(annBase)}','<div style=\\'font-size:11px;color:var(--text2)\\'>Source: Meter Data → Normalized tab → regression-predicted costs for each baseline month</div>'),event)">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Annual Baseline <span style="font-size:9px;color:var(--em)">ℹ️</span></div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head)">${$f(annBase)}</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px;cursor:pointer" onclick="showFormula(_fml('Projected Savings','${_useMeasures ? 'Sum of Energy Savings Measures' : 'Annual Baseline × Savings %'}','${_useMeasures ? $f(annProjSav) : $f(annBase) + ' × ' + (savPct * 100).toFixed(1) + '% = ' + $f(annProjSav)}','<div style=\\'font-size:11px;color:var(--text2)\\'>${_useMeasures ? 'Source: Energy Savings Measures' : 'Savings %: from Building Savings Projection settings'}</div>'),event)">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Projected Savings <span style="font-size:9px;color:var(--em)">ℹ️</span></div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--em)">${$f(annProjSav)}</div>
              <div style="font-size:11px;color:var(--text2);margin-top:2px">${projPct || ''} of baseline</div>
            </div>
            ${
              hasActual
                ? `
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px;cursor:pointer" onclick="showFormula(_fml('Current Savings','Sum of (Baseline − Actual) × Rate for each meter per month','${$f(annActSav)}','<div style=\\'font-size:11px;color:var(--text2)\\'>Source: each meter\\'s Performance tab calculates monthly savings from regression baseline vs actual bills</div>'),event)">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Current Savings <span style="font-size:9px;color:var(--em)">ℹ️</span></div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:${annActSav >= 0 ? 'var(--em)' : 'var(--danger)'}">${annActSav < 0 ? '−' : ''}${$f(annActSav)}</div>
              <div style="font-size:11px;color:var(--text2);margin-top:2px">${actPct || ''} of baseline</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px;cursor:pointer" onclick="showFormula(_fml('CSC Compensation','${cscMode === 'pct' ? 'Current Savings × CSC %' : 'Fixed Monthly × 12'}','${cscMode === 'pct' ? $f(annActSav) + ' × ' + (cscPct * 100).toFixed(1) + '% = ' + $f(annCsc) : '$' + cscFixed.toFixed(2) + '/mo × 12 = ' + $f(annCsc)}','<div style=\\'font-size:11px;color:var(--text2)\\'>Mode: ${cscMode === 'pct' ? 'Percentage of Current Savings' : 'Fixed Monthly Cost'}</div>'),event)">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">CSC Compensation <span style="font-size:9px;color:var(--em)">ℹ️</span></div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--em2)">${$f(annCsc)}</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px;cursor:pointer" onclick="showFormula(_fml('Client Savings','Current Savings − CSC Compensation','${$f(annActSav)} − ${$f(annCsc)} = ${$f(annCli)}','<div style=\\'font-size:11px;color:var(--text2)\\'>This is what the client keeps after CSC compensation</div>'),event)">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Client Savings <span style="font-size:9px;color:var(--em)">ℹ️</span></div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--green)">${$f(annCli)}</div>
            </div>`
                : ''
            }
          </div>

          ${
            annBase === 0
              ? `
          <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:16px 20px;margin-bottom:18px">
            <div style="font-size:13px;font-weight:700;color:var(--em);margin-bottom:6px">No baseline data yet</div>
            <div style="font-size:12px;color:var(--text2);line-height:1.6">
              To see performance results, you need to:<br>
              1. Add utility bills to at least one meter (Utility Data tab)<br>
              2. Set baseline months on each meter (click a meter, then the Baseline tab)<br>
              3. Add post-baseline bills so actual savings can be calculated
            </div>
          </div>`
              : !hasActual
                ? `
          <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:16px 20px;margin-bottom:18px">
            <div style="font-size:13px;font-weight:700;color:var(--em);margin-bottom:6px">Baseline set — waiting for post-baseline bills</div>
            <div style="font-size:12px;color:var(--text2);line-height:1.6">
              The annual baseline is ${$f(annBase)}. Once you add utility bills for months after the baseline period,
              actual savings will appear here automatically.
            </div>
          </div>`
                : ''
          }

          <!-- Data table -->
          ${
            hasActual
              ? `<div style="overflow-x:auto;margin-bottom:20px;border:1px solid var(--border);border-radius:8px">
            <table style="border-collapse:collapse;width:100%;font-size:12px">
              <thead>
                ${yearHdr}
                <tr style="background:var(--s1)">
                  <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);border:1px solid var(--border2)"></th>
                  ${colHdrs}
                  <th style="padding:7px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);border:1px solid var(--border2)">%</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>`
              : ''
          }

          <!-- Chart -->
          ${
            hasActual
              ? `<div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:16px">
            <canvas id="bpChart" height="90"></canvas>
          </div>`
              : ''
          }`;

  requestAnimationFrame(() => {
    const ctx = document.getElementById('bpChart');
    if (!ctx) return;
    if (ctx._chart) ctx._chart.destroy();
    const datasets = [
      {
        label: 'Projected Utility Spend $',
        data: JSON.parse(projSpendVals),
        backgroundColor: 'rgba(34,197,94,0.75)',
        stack: 's',
      },
      {
        label: 'Client Utility Savings $',
        data: JSON.parse(cliVals),
        backgroundColor: 'rgba(20,184,166,0.85)',
        stack: 's',
      },
      {
        label: 'CSC Utility Compensation $',
        data: JSON.parse(cscVals),
        backgroundColor: 'rgba(59,130,246,0.85)',
        stack: 's',
      },
    ];
    if (showLine)
      datasets.push({
        label: 'CSC Cumulative $',
        data: JSON.parse(cumVals),
        type: 'line',
        borderColor: '#f97316',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: 3,
        pointBackgroundColor: '#f97316',
        tension: 0.35,
        stack: undefined,
        yAxisID: 'y',
      });
    ctx._chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: JSON.parse(chartLabels), datasets },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#6b7a9e', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#6b7a9e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
          y: {
            ticks: { color: '#6b7a9e', font: { size: 10 }, callback: (v) => '$' + v.toLocaleString() },
            grid: { color: 'rgba(255,255,255,.06)' },
            stacked: true,
          },
        },
      },
    });
  });
}

function renderBldgSavProjPane(pane, b) {
  if (!b) {
    pane.innerHTML = '<div class="ud-empty">No building selected</div>';
    return;
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $f = (v) => '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Pull baseline spend per calendar month from all meters ──
  // Same meterDataByMo logic as renderPerfPane, summed across all meters
  const baselineByCalMo = {}; // 0-11 => total energyCost across all meters
  (b.meters || []).forEach((m) => {
    const bl = m.baseline;
    if (!bl || !(bl.months || []).length) return;
    const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const incl = m.inclusive !== false;
    const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
    const blRows = allRows.filter((r) => bl.months.includes(r.ym));
    blRows.forEach((r) => {
      const mo = parseInt(r.ym.split('-')[1]) - 1;
      // Use r.cost = total bill cost, matching "Total Utility Costs" column in Baseline Data tab
      baselineByCalMo[mo] = (baselineByCalMo[mo] || 0) + r.cost;
    });
  });

  // ── Saved settings ──
  const storeKey = 'bldgsavproj_cfg_' + (b.id || b.name);
  const cfg = DB.get(storeKey, {});
  const defSavingsPct = cfg.savingsPct ?? 11;
  const defClientPct = cfg.clientPct ?? 5;
  // Fall back to project-level cscCompensation if building has no custom override
  const projMeta2 = projects.find((p) => p.id === udSelProjId);
  const defCscPct = cfg._customCsc ? cfg.cscPct : (projMeta2?.cscCompensation ?? cfg.cscPct ?? 0);
  const defYears = cfg.years ?? 3;
  // Fall back to project-level escalation if building has no custom override
  const defEscPct = cfg._customEsc ? cfg.escPct : (projMeta2?.escalation ?? cfg.escPct ?? 3);
  const defView = cfg.view ?? 'monthly';

  // Sync global view state from saved config so bspRecalc uses correct values
  _bspView = defView;

  // Store for use by bspRecalc (called outside this function)
  _bspBaselineByCalMo = Array.from({ length: 12 }, (_, i) => baselineByCalMo[i] || 0);
  _bspMsrSavByMo = getBldgMeasureSavingsByMo(udSelProjId, b.id);
  const moBase = _bspBaselineByCalMo;

  // ── Source indicator ──
  const _bspMsrCount = _bspMsrSavByMo
    ? (projects.find((x) => x.id === udSelProjId)?.savingsData?.measures || []).filter(
        (m) => m.bldgId === b.id && m.selected !== false,
      ).length
    : 0;
  const _bspSourceLabel = _bspMsrSavByMo
    ? '<div style="font-size:10px;color:var(--accent);margin-top:2px">\u{1F4CA} Source: Energy Savings Measures (' +
      _bspMsrCount +
      ' measure' +
      (_bspMsrCount !== 1 ? 's' : '') +
      ')</div>'
    : '<div style="font-size:10px;color:var(--text3);margin-top:2px">\u{1F4CA} Source: Savings %</div>';

  // ── Render UI ──
  pane.innerHTML = `
          <div style="margin-bottom:16px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
            <div>
              <div style="font-size:16px;font-weight:800;font-family:var(--head);letter-spacing:-.01em">📈 ${b.name} — Building Savings Projection</div>
              <div style="font-size:12px;color:var(--text2);margin-top:3px">Baseline from Meter Data · adjust percentages and years below</div>
              ${_bspSourceLabel}
            </div>
          </div>

          <!-- Controls -->
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:18px;background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:13px 16px">
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Projected Savings %</label>
              <input id="bsp-savpct" type="number" value="${defSavingsPct}" min="0" max="100" step="0.1" oninput="bspRecalc()"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Client Savings %</label>
              <input id="bsp-clipct" type="number" value="${defClientPct}" min="0" max="100" step="0.1" oninput="bspRecalc()"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">CSC Compensation %</label>
              <input id="bsp-cscpct" type="number" value="${defCscPct}" min="0" max="100" step="0.1" oninput="bspRecalc()"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Years</label>
              <select id="bsp-years" onchange="bspRecalc()" style="font-family:var(--mono);font-size:13px;color:var(--text);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
                ${[1, 2, 3, 4, 5].map((y) => `<option value="${y}"${y === defYears ? ' selected' : ''}>${y} Year${y > 1 ? 's' : ''}</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Utility Escalation %/yr</label>
              <input id="bsp-escpct" type="number" value="${defEscPct}" min="0" max="20" step="0.1" oninput="bspRecalc()"
                style="width:80px;font-family:var(--mono);font-size:13px;color:var(--em);background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;outline:none">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">View</label>
              <div style="display:flex;gap:4px">
                <button id="bsp-v-monthly" onclick="bspSetView('monthly')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defView === 'monthly' ? 'var(--em)' : 'transparent'};color:${defView === 'monthly' ? '#05080f' : 'var(--text2)'}">Monthly</button>
                <button id="bsp-v-quarterly" onclick="bspSetView('quarterly')"
                  style="font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:${defView === 'quarterly' ? 'var(--em)' : 'transparent'};color:${defView === 'quarterly' ? '#05080f' : 'var(--text2)'}">Quarterly</button>
              </div>
            </div>
            <button onclick="bspRecalc()" style="font-family:var(--font);font-size:12px;font-weight:700;padding:7px 16px;border-radius:7px;border:none;cursor:pointer;background:var(--em);color:#05080f;align-self:flex-end">⚡ Recalculate</button>
          </div>


          <!-- Results -->
          <div id="bsp-results"></div>`;

  // Defer recalc until after caller appends pane to DOM
  setTimeout(() => bspRecalc(), 0);
}

// Current view state
let _bspView = 'monthly';
function bspSetView(v) {
  _bspView = v;
  ['monthly', 'quarterly'].forEach((vv) => {
    const btn = document.getElementById('bsp-v-' + vv);
    if (!btn) return;
    btn.style.background = vv === v ? 'var(--em)' : 'transparent';
    btn.style.color = vv === v ? '#05080f' : 'var(--text2)';
  });
  bspRecalc();
}

function bspRecalc() {
  // Guard: skip if DOM inputs don't exist yet (prevents corrupting localStorage with zeros)
  if (!document.getElementById('bsp-savpct')) return;
  const savPct = parseFloat(document.getElementById('bsp-savpct').value ?? 0) / 100;
  const cliPct = parseFloat(document.getElementById('bsp-clipct').value ?? 0) / 100;
  const cscPct = parseFloat(document.getElementById('bsp-cscpct').value ?? 0) / 100;
  const years = parseInt(document.getElementById('bsp-years').value ?? 3);
  const escPct = parseFloat(document.getElementById('bsp-escpct').value ?? 0) / 100;
  const view = _bspView;
  const moBase = _bspBaselineByCalMo || Array(12).fill(0);
  const annBase = moBase.reduce((s, v) => s + v, 0);

  // Save config
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (b) {
    const storeKey = 'bldgsavproj_cfg_' + (b.id || b.name);
    try {
      const _prevBspCfg = DB.get(storeKey, {});
      const _saveBspCfg = {
        savingsPct: savPct * 100,
        clientPct: cliPct * 100,
        cscPct: cscPct * 100,
        years,
        escPct: escPct * 100,
        view,
      };
      // Mark custom escalation if value differs from the project default
      const _projM2 = projects.find((p) => p.id === udSelProjId);
      const _projEsc2 = _projM2?.escalation ?? 3;
      const _projCsc2 = _projM2?.cscCompensation ?? 0;
      if (escPct * 100 !== _projEsc2) {
        _saveBspCfg._customEsc = true;
      }
      // Mark custom CSC if value differs from the project default
      if (cscPct * 100 !== _projCsc2) {
        _saveBspCfg._customCsc = true;
      }
      DB.set(storeKey, _saveBspCfg);
    } catch (e) {}
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $f = (v) => '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const $fc = (v) => (v < 0 ? '-' : '') + $f(v);

  // Build column definitions
  let cols = [];
  if (view === 'monthly') {
    for (let mo = 0; mo < 12; mo++) cols.push({ label: MONTH_NAMES[mo], mo, yr: 0 });
    cols.push({ label: 'Total', isTotal: true, yr: 0 });
  } else {
    // Quarterly per year
    for (let yr = 0; yr < years; yr++) {
      for (let q = 0; q < 4; q++) {
        const mos = [q * 3, q * 3 + 1, q * 3 + 2];
        cols.push({ label: `Y${yr + 1} Q${q + 1}`, mos, yr });
      }
    }
    cols.push({ label: 'Total', isTotal: true });
  }

  // Compute per-column values
  function colBase(col) {
    if (col.isTotal) return cols.filter((c) => !c.isTotal).reduce((s, c) => s + colBase(c), 0);
    if (col.mos) return col.mos.reduce((s, mo) => s + moBase[mo], 0) * Math.pow(1 + escPct, col.yr || 0); // escalate per year
    if (col.mo !== undefined) return moBase[col.mo];
    return 0;
  }
  // For quarterly, each year repeats the monthly baseline escalated by escPct per year
  function colBaseQ(col) {
    if (col.isTotal) {
      let tot = 0;
      for (let yr = 0; yr < years; yr++) tot += annBase * Math.pow(1 + escPct, yr);
      return tot;
    }
    if (col.mos) {
      const factor = Math.pow(1 + escPct, col.yr || 0);
      return col.mos.reduce((s, mo) => s + moBase[mo], 0) * factor;
    }
    return (moBase[col.mo] || 0) * Math.pow(1 + escPct, col.yr || 0);
  }

  // Measure-based savings (if available)
  const _msrSav = _bspMsrSavByMo;
  const _useM = !!_msrSav;
  function bspGetProjSav(col) {
    if (_useM) {
      if (col.isTotal) return _msrSav.reduce((s, v) => s + v, 0);
      if (col.mo !== undefined) return _msrSav[col.mo] || 0;
      if (col.mos) return col.mos.reduce((s, mo) => s + (_msrSav[mo] || 0), 0);
      return 0;
    }
    const base = view === 'monthly' ? (col.isTotal ? annBase : moBase[col.mo]) : colBaseQ(col);
    return base * savPct;
  }

  const rows = ['baseline', 'projected', 'savings', 'client', 'csc'].map((key) => {
    const vals = cols.map((col) => {
      const base = view === 'monthly' ? (col.isTotal ? annBase : moBase[col.mo]) : colBaseQ(col);
      const projSav = bspGetProjSav(col);
      switch (key) {
        case 'baseline':
          return base;
        case 'projected':
          return Math.max(0, base - projSav);
        case 'savings':
          return projSav;
        case 'client':
          return base * cliPct;
        case 'csc':
          return base * cscPct;
      }
    });
    const labels = {
      baseline: 'Total Baseline Utility Spend $',
      projected: 'New Projected Utility Spend $',
      savings: 'Total Projected Utility Savings $',
      client: 'Client Projected Utility Savings $',
      csc: 'CSC Projected Utility Compensation $',
    };
    const pcts = {
      savings: (savPct * 100).toFixed(0) + '%',
      client: (cliPct * 100).toFixed(0) + '%',
      csc: (cscPct * 100).toFixed(0) + '%',
    };
    const colors = {
      baseline: 'var(--text)',
      projected: 'var(--text)',
      savings: 'var(--em)',
      client: '#22c55e',
      csc: 'var(--em2)',
    };
    return { key, label: labels[key], vals, pct: pcts[key], color: colors[key] };
  });

  // CSC cumulative (for quarterly view line chart)
  const cscRow = rows.find((r) => r.key === 'csc');
  let cumulative = 0;
  const cumulativeVals = cscRow.vals.slice(0, -1).map((v) => {
    cumulative += v;
    return cumulative;
  });

  // Total column savings %
  const totalBase = rows[0].vals[rows[0].vals.length - 1];
  const totalSav = rows[2].vals[rows[2].vals.length - 1];
  const totalPct = totalBase > 0 ? ((totalSav / totalBase) * 100).toFixed(0) + '%' : '—';

  // ── Table HTML ──
  const colHdrs = cols
    .map(
      (c) =>
        `<th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);background:var(--s1);border:1px solid var(--border2);white-space:nowrap">${c.label}</th>`,
    )
    .join('');

  // Year group headers for quarterly
  let yearHdr = '';
  if (view === 'quarterly') {
    yearHdr =
      '<tr style="background:var(--s1)"><th style="border:1px solid var(--border2)"></th><th style="border:1px solid var(--border2)"></th>';
    for (let yr = 0; yr < years; yr++) {
      yearHdr += `<th colspan="4" style="text-align:center;padding:5px;font-size:11px;font-weight:700;color:var(--text);border:1px solid var(--border2);border-bottom:2px solid var(--em)">Year ${yr + 1}</th>`;
    }
    yearHdr += '<th style="border:1px solid var(--border2)"></th></tr>';
  }

  const tableRows = rows
    .map((r) => {
      const cells = r.vals
        .map((v, i) => {
          const isLast = i === r.vals.length - 1;
          return `<td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${isLast ? r.color : 'var(--text)'};font-weight:${isLast ? '700' : '400'};border:1px solid var(--border);background:${isLast ? 'var(--s1)' : 'transparent'};white-space:nowrap">${$fc(v)}</td>`;
        })
        .join('');
      const pctCell = r.pct
        ? `<td style="padding:7px 10px;text-align:center;font-family:var(--mono);font-size:12px;color:${r.color};font-weight:700;border:1px solid var(--border)">${r.pct}</td>`
        : '<td style="border:1px solid var(--border)"></td>';
      return `<tr>
            <td style="padding:7px 12px;font-size:12px;font-weight:600;color:${r.color};white-space:nowrap;border:1px solid var(--border);background:var(--s1)">${r.label}</td>
            ${cells}${pctCell}
          </tr>`;
    })
    .join('');

  // ── Chart data ──
  const chartCols = cols.filter((c) => !c.isTotal);
  const chartLabels = JSON.stringify(chartCols.map((c) => c.label));
  const projVals = JSON.stringify(chartCols.map((_, i) => rows[1].vals[i]));
  const cliVals = JSON.stringify(chartCols.map((_, i) => rows[3].vals[i]));
  const cscVals = JSON.stringify(chartCols.map((_, i) => rows[4].vals[i]));
  const cumVals = JSON.stringify(cumulativeVals);
  const showLine = view === 'quarterly';

  const res = document.getElementById('bsp-results');
  if (!res) return;
  res.innerHTML = `
          <!-- Summary stats -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px">
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Annual Baseline</div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--text)">${$f(annBase)}</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Annual Projected Spend</div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--text)">${$f(annBase - (_useM ? _msrSav.reduce((s, v) => s + v, 0) : annBase * savPct))}</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">Total Projected Savings</div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--em)">${$f(totalSav)}</div>
              <div style="font-size:11px;color:var(--text2);margin-top:2px">${totalPct} of baseline · ${years} yr${years > 1 ? 's' : ''}</div>
            </div>
            <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:12px 14px">
              <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:4px">CSC Cumulative</div>
              <div style="font-size:18px;font-weight:800;font-family:var(--head);color:var(--em2)">${$f(annBase * cscPct * years)}</div>
              <div style="font-size:11px;color:var(--text2);margin-top:2px">over ${years} yr${years > 1 ? 's' : ''}</div>
            </div>
          </div>

          <!-- Data table -->
          <div style="overflow-x:auto;margin-bottom:20px;border:1px solid var(--border);border-radius:8px">
            <table style="border-collapse:collapse;width:100%;font-size:12px">
              <thead>
                ${yearHdr}
                <tr style="background:var(--s1)">
                  <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);border:1px solid var(--border2)"></th>
                  ${colHdrs}
                  <th style="padding:7px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);border:1px solid var(--border2)">Savings %</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>

          <!-- Chart -->
          <div style="background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:16px">
            <canvas id="bspChart" height="90"></canvas>
          </div>`;

  // Draw chart with Chart.js
  requestAnimationFrame(() => {
    const ctx = document.getElementById('bspChart');
    if (!ctx) return;
    if (ctx._chart) ctx._chart.destroy();
    const datasets = [
      {
        label: 'New Projected Utility Spend $',
        data: JSON.parse(projVals),
        backgroundColor: 'rgba(34,197,94,0.75)',
        stack: 's',
      },
      {
        label: 'Client Projected Utility Savings $',
        data: JSON.parse(cliVals),
        backgroundColor: 'rgba(20,184,166,0.85)',
        stack: 's',
      },
      {
        label: 'CSC Projected Utility Compensation $',
        data: JSON.parse(cscVals),
        backgroundColor: 'rgba(59,130,246,0.85)',
        stack: 's',
      },
    ];
    if (showLine) {
      datasets.push({
        label: 'CSC Projected Cumulative Total $',
        data: JSON.parse(cumVals),
        type: 'line',
        borderColor: '#f97316',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: 3,
        pointBackgroundColor: '#f97316',
        tension: 0.35,
        stack: undefined,
        yAxisID: 'y',
      });
    }
    ctx._chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: JSON.parse(chartLabels), datasets },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#6b7a9e', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#6b7a9e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
          y: {
            ticks: { color: '#6b7a9e', font: { size: 10 }, callback: (v) => '$' + v.toLocaleString() },
            grid: { color: 'rgba(255,255,255,.06)' },
            stacked: true,
          },
        },
      },
    });
  });
}

// getMeterSavings, getBuildingSavingsByYM, getProjectSavingsByYM → computations/savings.js

function renderPerfPane(pane, m, bills, incl) {
  const bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) {
    pane.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">💡</div><div>Set a baseline in the Baseline tab first.<br><button class="btn btn-em btn-sm" style="margin-top:12px" onclick="maSetTab(\'baseline\')">Go to Baseline →</button></div></div>';
    return;
  }
  const unit = getMeterDisplayUnit(m);
  const isElec = m.commodity === 'Electric';
  const { byYm: weatherByYm, cache: _wddCache } = getWeatherForBuilding();
  const allRows = getNormRows(m, bills, incl, weatherByYm); // sets m._reg, fills regrBaseline
  const blStart = bl.months.slice().sort()[0];
  const blEnd = bl.months.slice().sort()[bl.months.length - 1];

  // EUI
  const bldg5 = getUDBldg(udSelProjId, udSelBldgId);
  const sqft5 = parseInt(bldg5?.sqft) || 0;
  const hasEUI_p = isElec && sqft5 > 0;

  // Normalization basis
  const proj_p = getUDProj(udSelProjId);
  const normBasis_p = proj_p?.normBasis || 'calendar';

  // ── Long-term Normal Weather (Update a1f2b3c4) ──────────────────────────────
  // Compute multi-year average HDD/CDD per calendar month from the full weather cache.
  // Used when _perfWeatherMode === 'normal' to replace actual monthly HDD/CDD in
  // expected-usage calculations. The regression coefficients are NEVER changed here —
  // only the X values (HDD/CDD) fed into the regression prediction change.
  const _ltNormals =
    typeof computeLongTermNormals === 'function' && _wddCache && _wddCache.length
      ? computeLongTermNormals(_wddCache)
      : null;
  const _useNormalWeather = _perfWeatherMode === 'normal' && _ltNormals != null;

  // When normal weather mode is active, build a version of allRows where each row's
  // hdd/cdd is replaced by the long-term average for that calendar month, and
  // regrBaseline is recomputed with the same frozen regression coefficients.
  // This does NOT change the regression fit — only the prediction inputs change.
  const _effectiveRows = (() => {
    if (!_useNormalWeather) return allRows;
    return allRows.map((r) => {
      const mo = r.ym.split('-')[1]; // '01'–'12'
      const norm = _ltNormals[mo];
      if (!norm) return r;
      const patchedRow = Object.assign({}, r, {
        hdd: norm.hdd,
        cdd: norm.cdd,
      });
      const regToUse = m._reg || null;
      patchedRow.regrBaseline = regToUse
        ? regressionBaseline(patchedRow, regToUse, m.commodity, normBasis_p)
        : r.regrBaseline;
      return patchedRow;
    });
  })();

  // Use _effectiveRows for all calculations — actual usage (r.usage) is identical between
  // allRows and _effectiveRows; only hdd/cdd/regrBaseline differ in normal weather mode.
  const truePostRows = _effectiveRows.filter((r) => r.ym > blEnd);
  const blRows = _effectiveRows.filter((r) => bl.months.includes(r.ym));
  // Actual-weather baseline rows — always from allRows regardless of weather mode.
  // Used for regression fitting (regression is always fit on actual weather data).
  const _blRowsActual = allRows.filter((r) => bl.months.includes(r.ym));

  // Baseline averages (simple fallback when no regression)
  const blAvgDay = blRows.length ? blRows.reduce((s, r) => s + r.usagePerDay, 0) / blRows.length : 0;
  const blAvgMo = blRows.length ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length : 0;
  const hasRegr_p = _effectiveRows.some((r) => r.regrBaseline != null);

  // Use shared buildMoMap — same authoritative source as Meter Data table
  const isPropane_p = m.commodity === 'Propane';
  const { elecByMo: _eMo, gasByMo: _gMo, waterByMo: _wMo, propaneByMo: _pMo } = buildMoMap(m, blRows, bills, incl);
  const _moMap = isElec ? _eMo : m.commodity === 'Gas' ? _gMo : isPropane_p ? _pMo : _wMo;
  const meterDataByMo = {};
  Object.entries(_moMap).forEach(([mo, v]) => {
    meterDataByMo[mo] = {
      usage: isElec ? v.kwh : m.commodity === 'Gas' ? v.therms : isPropane_p ? v.gallons : v.kgal,
      energyCost: isElec ? v.energyCost : 0,
      thermCost: m.commodity === 'Gas' || isPropane_p ? v.cost : 0,
      totalCost: v.totalCost ?? v.cost,
    };
  });
  const hasBlCalMap = Object.keys(meterDataByMo).length > 0;
  const blByCalMo = Object.fromEntries(Object.entries(meterDataByMo).map(([mo, v]) => [mo, v.usage]));
  const blKwhCostByCalMo = Object.fromEntries(Object.entries(meterDataByMo).map(([mo, v]) => [mo, v.energyCost]));
  const blThermCostByCalMo = Object.fromEntries(Object.entries(meterDataByMo).map(([mo, v]) => [mo, v.thermCost]));
  const blTotalCostByCalMo = Object.fromEntries(Object.entries(meterDataByMo).map(([mo, v]) => [mo, v.totalCost]));
  // Per-calendar-month baseline kW from buildMoMap (seasonal, not flat average)
  const blDemKWByCalMo = {};
  if (isElec) {
    Object.entries(_eMo).forEach(([mo, v]) => {
      blDemKWByCalMo[mo] = v.billedKW || v.demandKW || 0;
    });
  }

  // kW regression: predict Expected kW from weather (CDD) instead of
  // using raw baseline kW per calendar month. This normalizes demand
  // for weather so the kW savings reflect efficiency, not temperature.
  // Always fit on actual-weather CDD (_blRowsActual) regardless of weather mode.
  const _kwReg = (() => {
    if (!isElec || !hasRegr_p) return null;
    const pts = _blRowsActual
      .map((r) => {
        const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
        const kw = bfr.length ? bfr.reduce((s, b) => s + (parseFloat(b.demandKW) || 0), 0) / bfr.length : 0;
        return { x: r.cdd != null ? r.cdd : 0, y: kw };
      })
      .filter((p) => p.y > 0);
    if (pts.length < 3) return null;
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    const ssxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const ssxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    if (ssxx === 0) return null;
    const slope = ssxy / ssxx;
    const intercept = my - slope * mx;
    const r2 = (() => {
      const ssTot = pts.reduce((s, p) => s + (p.y - my) ** 2, 0);
      const ssRes = pts.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
      return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    })();
    return { slope, intercept, r2, n };
  })();
  const _kwNormByYm = {};
  if (_kwReg) {
    // Use _effectiveRows so kW baseline line reflects normal-weather CDD when mode is active
    _effectiveRows.forEach((r) => {
      const cdd = r.cdd != null ? r.cdd : 0;
      _kwNormByYm[r.ym] = Math.max(0, _kwReg.intercept + _kwReg.slope * cdd);
    });
  }

  // Year filter
  const maxYears = Math.max(1, Math.ceil(truePostRows.length / 12));
  const yearOptions = ['all', ...Array.from({ length: maxYears }, (_, i) => String(i + 1))];
  // Filter out partial months (< 90% of calendar days) so they don't skew the display
  const fullPostRows = truePostRows.filter((r) => !r.partial);
  let filteredPostRows = fullPostRows;
  if (_perfYearFilter !== 'all') {
    const n = parseInt(_perfYearFilter);
    filteredPostRows = fullPostRows.slice(0, n * 12);
  }

  // ── Raw bill usage by norm-month for all commodities ──
  const rawUsageByYm = {};
  if (isPropane_p) {
    // For propane, "raw usage" per month is the HDD-normalized gallons
    // already computed by getNormRows → normalizePropaneDeliveries.
    allRows.forEach((r) => {
      rawUsageByYm[r.ym] = r.usage;
    });
  } else {
    bills.forEach((b) => {
      const ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      const val = isElec ? parseFloat(b.kwh || 0) : parseFloat(b.therms || b.usage || b.kwh || 0);
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + val;
    });
  }

  // Stats — use raw bill totals for actual, regression for expected
  const postRawMos = filteredPostRows.map((r) => (rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage));
  const postAvgMo = postRawMos.length ? postRawMos.reduce((s, v) => s + v, 0) / postRawMos.length : 0;
  const postAvgDay = filteredPostRows.length
    ? filteredPostRows.reduce((s, r) => {
        const raw = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
        return s + (r.normDays > 0 ? raw / r.normDays : r.usagePerDay);
      }, 0) / filteredPostRows.length
    : 0;

  // Expected usage: baseline normalized value for matching calendar month
  const totalExpected = filteredPostRows.reduce((s, r) => {
    const calMo = parseInt(r.ym.split('-')[1]) - 1;
    const exp =
      hasBlCalMap && blByCalMo[calMo] != null
        ? blByCalMo[calMo]
        : hasRegr_p && r.regrBaseline != null
          ? r.regrBaseline
          : blAvgMo;
    return s + exp;
  }, 0);
  const totalActual = postRawMos.reduce((s, v) => s + v, 0);
  const totalSavings = totalExpected - totalActual;
  const savPct = totalExpected > 0 ? (totalSavings / totalExpected) * 100 : 0;

  // savCost, statsHTML, and quarterly pills are built AFTER per-row savings
  // pre-computation (see below the column visibility flags) so the Cost Delta
  // pill is guaranteed to equal the sum of the Total Savings column.

  const last12post = truePostRows.slice(-12);
  const rolling12kWh = last12post.reduce((s, r) => s + (rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage), 0);
  const rolling12EUI = hasEUI_p && last12post.length === 12 ? toKBtu(rolling12kWh, 0, 0) / sqft5 : null;
  const blEUI = hasEUI_p && blRows.length ? (toKBtu(blAvgMo, 0, 0) * 12) / sqft5 : null;

  // Avg regression baseline for baseline period (for display)
  const blRegrRows = blRows.filter((r) => r.regrBaseline != null);
  const blRegrAvgMo = blRegrRows.length ? blRegrRows.reduce((s, r) => s + r.regrBaseline, 0) / blRegrRows.length : null;

  // Year filter pills
  const yearPills =
    '<div class="perf-year-pills">' +
    '<span style="font-size:11px;color:var(--text2);align-self:center;margin-right:4px">View Post-BL:</span>' +
    yearOptions
      .map(
        (y) =>
          '<button class="perf-year-pill' +
          (_perfYearFilter === y ? ' sel' : '') +
          '" onclick="setPerfYearFilter(\'' +
          m.id +
          "','" +
          y +
          '\')">' +
          (y === 'all' ? 'All' : y + ' Yr' + (parseInt(y) > 1 ? 's' : '')) +
          '</button>',
      )
      .join('') +
    '</div>';

  // Chart control bar
  const perfChartBtn = _perfChartVis ? '📉 Hide Chart' : '📊 Show Chart';
  const perfChartLabel =
    (_perfMetric === 'total'
      ? hasRegr_p
        ? `Normalized ${unit} vs Actual ${unit}`
        : unit + '/Month vs Baseline'
      : hasRegr_p
        ? `Normalized ${unit}/Day vs Actual`
        : unit + '/Day vs Baseline') + (_perfOverlay ? ' + Raw Bills' : '');
  const perfControlBar =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:10px">' +
    '<button class="ud-incl-btn" onclick="togglePerfChart()" style="background:var(--s3);border-color:var(--border2);color:var(--text2)">' +
    perfChartBtn +
    '</button>' +
    '<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>' +
    '<span style="font-size:11px;color:var(--text2)">Metric:</span>' +
    '<button class="ud-incl-btn' +
    (_perfMetric === 'total' ? ' sel' : '') +
    '" onclick="setPerfMetric(\'total\')">' +
    unit +
    '/Month</button>' +
    '<button class="ud-incl-btn' +
    (_perfMetric === 'perday' ? ' sel' : '') +
    '" onclick="setPerfMetric(\'perday\')">' +
    unit +
    '/Day</button>' +
    (_perfChartVis
      ? '<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>' +
        '<span style="font-size:11px;color:var(--text2)">Overlay:</span>' +
        '<button class="ud-incl-btn' +
        (_perfOverlay ? ' sel' : '') +
        '" onclick="togglePerfOverlay()">📋 Raw Bills</button>'
      : '') +
    '</div>';

  // Normalization basis note
  const basisNote_p =
    '<div style="font-size:11px;color:var(--text3);margin-bottom:10px;padding:6px 10px;background:var(--s3);border-radius:5px;border:1px solid var(--border)">' +
    '📐 Period basis: <strong>' +
    (normBasis_p === 'calendar' ? 'Calendar month days' : 'Actual bill days') +
    '</strong> · ' +
    (hasRegr_p
      ? '✅ Normalized Baseline active — expected usage calculated per-month using weather model'
      : '⚠️ No regression — using simple baseline average as expected. Upload weather data to enable.') +
    ' · Change in Normalized tab</div>';

  // ── Weather mode toggle (Update a1f2b3c4) ──────────────────────────────────
  // Shown only when regression is active and long-term normals are available (≥3 complete years).
  // Switching to Normal Weather replaces actual monthly HDD/CDD with long-term averages
  // in the expected-usage computation. Regression coefficients do not change.
  const weatherModeBar = (() => {
    if (!hasRegr_p) return '';
    const disabledNote = !_ltNormals
      ? '<span style="font-size:11px;color:var(--text3);margin-left:8px">' +
        'Normal Weather unavailable — need ≥3 complete years of weather data' +
        '</span>'
      : _useNormalWeather
        ? '<span style="font-size:11px;color:var(--violet);margin-left:8px">' +
          '☁ Using long-term average HDD/CDD · Savings are weather-independent' +
          '</span>'
        : '';
    return (
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
      '<span style="font-size:11px;color:var(--text2)">Weather Baseline:</span>' +
      '<button class="ud-incl-btn' +
      (_perfWeatherMode === 'actual' ? ' sel' : '') +
      '" onclick="setPerfWeatherMode(\'actual\')" title="Use actual monthly HDD/CDD for expected usage">Actual Weather</button>' +
      '<button class="ud-incl-btn' +
      (_perfWeatherMode === 'normal' ? ' sel' : '') +
      (!_ltNormals ? ' disabled' : '') +
      '" onclick="' +
      (_ltNormals ? "setPerfWeatherMode('normal')" : '') +
      '" title="Use long-term average HDD/CDD for expected usage (weather-normalized savings)"' +
      (!_ltNormals ? ' style="opacity:0.45;cursor:not-allowed"' : '') +
      '>Normal Weather</button>' +
      disabledNote +
      '</div>'
    );
  })();

  // Chart rows: era-tagged
  const postYmCutoff =
    _perfYearFilter === 'all'
      ? null
      : filteredPostRows.length
        ? filteredPostRows[filteredPostRows.length - 1].ym
        : null;
  // Chart rows: use _effectiveRows so the regression baseline line reflects normal-weather
  // expected values when Normal Weather mode is active. Actual usage bars come from row.usage
  // which is unchanged between allRows and _effectiveRows.
  const chartRows = _effectiveRows
    .filter(
      (r) =>
        r.ym < blStart ||
        bl.months.includes(r.ym) ||
        r.ym <= blEnd ||
        _perfYearFilter === 'all' ||
        r.ym <= postYmCutoff,
    )
    .map((r) => ({ ...r, era: bl.months.includes(r.ym) ? 'baseline' : r.ym < blStart ? 'pre' : 'post' }));
  const barColors = chartRows.map((r) =>
    r.era === 'baseline'
      ? 'rgba(0,212,170,0.8)'
      : r.era === 'pre'
        ? 'rgba(120,130,160,0.35)'
        : 'rgba(100,160,255,0.75)',
  );

  // ── Build demand data by norm-month for post-BL kW table ──
  const perfDemByYm = {};
  if (isElec) {
    filteredPostRows.forEach((r) => {
      const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
      if (!bfr.length) return;
      const n = bfr.length;
      const actualKwh = bfr.reduce((s, b) => s + parseFloat(b.kwh || 0), 0);
      const kwCostAmt = bfr.reduce((s, b) => s + parseFloat(b.kwCost || 0), 0);
      const facKWCostAmt = bfr.reduce((s, b) => s + parseFloat(b.facKWCost || 0), 0);
      const kwhCostAmt = bfr.reduce((s, b) => s + parseFloat(b.kwhCost || 0), 0);
      // energyCost mirrors Meter Data "Energy Cost" = totalCost - kwCost
      const totalBillCost = bfr.reduce((s, b) => s + parseFloat(b.totalCost || 0), 0);
      const energyCostAmt = totalBillCost - kwCostAmt - facKWCostAmt;
      const bilKW = bfr.length ? Math.max(...bfr.map((b) => parseFloat(b.billedKW || b.demandKW || 0))) : 0;
      const _storedKwhRate = bfr.reduce((s, b) => s + (parseFloat(b.totalKwhRate) || 0), 0) / n;
      const _storedKwRate = bfr.reduce((s, b) => s + (parseFloat(b.totalKwRate) || 0), 0) / n;
      perfDemByYm[r.ym] = {
        demKW: bfr.length ? Math.max(...bfr.map((b) => parseFloat(b.demandKW || 0))) : 0,
        bilKW,
        kwCost: kwCostAmt,
        facKWCost: facKWCostAmt,
        kwhCostAmt,
        energyCostAmt,
        totalBillCost,
        kwhRate: _storedKwhRate || (actualKwh > 0 && kwhCostAmt > 0 ? kwhCostAmt / actualKwh : 0),
        kwRate: _storedKwRate || (bilKW > 0 && kwCostAmt + facKWCostAmt > 0 ? (kwCostAmt + facKWCostAmt) / bilKW : 0),
      };
    });
  }

  // Gas/Propane: per-month actual cost from raw bills (or normalized rows for propane)
  const gasCostByYm = {};
  if (!isElec) {
    if (isPropane_p) {
      filteredPostRows.forEach((r) => {
        const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
        const actGallons = r.usage;
        const actCost = r.cost;
        const _storedRate = bfr.length ? parseFloat(bfr[0].totalPropaneRate) || 0 : 0;
        if (actGallons > 0)
          gasCostByYm[r.ym] = {
            thermCostAmt: actCost,
            totalBillCost: actCost,
            thermRate: _storedRate || (actCost > 0 ? actCost / actGallons : 0),
          };
      });
    } else {
      filteredPostRows.forEach((r) => {
        const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
        if (!bfr.length) return;
        const actualTherms = bfr.reduce((s, b) => s + parseFloat(b.therms || b.usage || 0), 0);
        const thermCostAmt = bfr.reduce(
          (s, b) => s + (parseFloat(b.gasCharge) || parseFloat(b.thermCost) || parseFloat(b.cost) || 0),
          0,
        );
        const totalGasCost = bfr.reduce(
          (s, b) => s + (parseFloat(b.gasCharge) || parseFloat(b.thermCost) || parseFloat(b.cost) || 0),
          0,
        );
        const _storedGasRate = bfr.reduce((s, b) => s + (parseFloat(b.totalGasRate) || 0), 0) / bfr.length;
        if (actualTherms > 0)
          gasCostByYm[r.ym] = {
            thermCostAmt,
            totalBillCost: totalGasCost,
            thermRate: _storedGasRate || (thermCostAmt > 0 ? thermCostAmt / actualTherms : 0),
          };
      });
    }
  }

  // ── Demand Analytics (electric only) — trailing 24 months from all bills ──
  // Build per-norm-month demand data from all bills (not just post-BL filtered rows)
  const _demAnalytics = (() => {
    if (!isElec) return null;
    // Collect all sorted norm-months from allRows
    const allYms = allRows.map((r) => r.ym).sort();
    // Sort bills and build per-ym map
    const sortedBills = (bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const byYm = {};
    sortedBills.forEach((b) => {
      const ym = normMonth(b.start, b.end, incl, sortedBills);
      if (!ym) return;
      const pf = (v) => parseFloat(String(v || 0).replace(/,/g, '')) || 0;
      if (!byYm[ym]) {
        byYm[ym] = {
          demandKW: 0,
          billedKW: 0,
          facKW: 0,
          demandCharge: 0,
          facilitiesCharge: 0,
          tdcCharge: 0,
          onPeakCost: 0,
          offPeakCost: 0,
          ecaCharge: 0,
          eerCharge: 0,
          ptsCharge: 0,
          kwCost: 0,
          facKWCost: 0,
          kwhCost: 0,
          customerCharge: 0,
          rkvaCharge: 0,
          taxExemptDelivery: 0,
          billOffset: 0,
          franchiseFee: 0,
          totalCost: 0,
          kwh: 0,
          normDays: 0,
          count: 0,
          hasGranular: false,
        };
      }
      const e = byYm[ym];
      // kW: take max across bills in same period
      e.demandKW = Math.max(e.demandKW, pf(b.demandKW));
      e.billedKW = Math.max(e.billedKW, pf(b.billedKW || b.demandKW));
      e.facKW = Math.max(e.facKW, pf(b.facKW));
      // Granular charge fields
      e.demandCharge += pf(b.demandCharge);
      e.facilitiesCharge += pf(b.facilitiesCharge || b.facKWCost);
      e.tdcCharge += pf(b.tdcCharge);
      e.onPeakCost += pf(b.onPeakCost);
      e.offPeakCost += pf(b.offPeakCost);
      e.ecaCharge += pf(b.ecaCharge);
      e.eerCharge += pf(b.eerCharge);
      e.ptsCharge += pf(b.ptsCharge);
      // Fallback aggregate fields
      e.kwCost += pf(b.kwCost);
      e.facKWCost += pf(b.facKWCost);
      e.kwhCost += pf(b.kwhCost);
      e.customerCharge += pf(b.customerCharge);
      e.rkvaCharge += pf(b.rkvaCharge);
      e.taxExemptDelivery += pf(b.taxExemptDelivery);
      e.billOffset += pf(b.billOffset);
      e.franchiseFee += pf(b.franchiseFee);
      e.totalCost += pf(b.totalCost);
      e.kwh += pf(b.kwh);
      // normDays: take from matching norm row
      const nr = allRows.find((r) => r.ym === ym);
      if (nr) e.normDays = nr.normDays || 30;
      e.count++;
      if (pf(b.demandCharge) > 0 || pf(b.onPeakCost) > 0 || pf(b.facilitiesCharge) > 0) e.hasGranular = true;
    });

    // Sorted ym list — trailing 24 months with data
    const yms = Object.keys(byYm).sort();
    const trailing24 = yms.slice(-24);
    const trailing12 = yms.slice(-12);

    if (!trailing12.length) return null;

    // Per-month computed values
    const months = trailing24.map((ym) => {
      const e = byYm[ym];
      const pf = (v) => parseFloat(String(v || 0).replace(/,/g, '')) || 0;

      // Cost breakdown — prefer granular, fall back to aggregates
      const demandCost = e.hasGranular ? e.demandCharge + e.tdcCharge : e.kwCost;
      const facilitiesCost = e.hasGranular ? e.facilitiesCharge : e.facKWCost;
      const energyCost = e.hasGranular
        ? e.onPeakCost + e.offPeakCost + e.ecaCharge + e.eerCharge + e.ptsCharge
        : e.kwhCost || e.totalCost - e.kwCost - e.facKWCost - e.customerCharge - e.rkvaCharge - e.franchiseFee;
      const fixedCost =
        e.customerCharge + e.rkvaCharge + e.taxExemptDelivery + e.franchiseFee + (e.billOffset < 0 ? e.billOffset : 0); // bill offset can be negative credit
      const totalKwCost = demandCost + facilitiesCost;
      const totalBill = e.totalCost > 0 ? e.totalCost : totalKwCost + energyCost + fixedCost;

      // Load factor
      const lf = e.demandKW > 0 && e.normDays > 0 && e.kwh > 0 ? e.kwh / (e.demandKW * 24 * e.normDays) : null;

      // Effective demand rate per kW (for ratchet cost calculation)
      const effDemRate =
        e.billedKW > 0 && e.kwCost > 0
          ? e.kwCost / e.billedKW
          : e.billedKW > 0 && demandCost > 0
            ? demandCost / e.billedKW
            : 0;

      // Ratchet cost: extra billed above actual demand
      const ratchetGap = e.billedKW > e.demandKW ? e.billedKW - e.demandKW : 0;
      const ratchetCost = ratchetGap > 0 && effDemRate > 0 ? ratchetGap * effDemRate : 0;

      // Month label
      const [yr, mo] = ym.split('-');
      const label =
        ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(mo) - 1] +
        ' ' +
        yr.slice(2);

      return {
        ym,
        label,
        hasGranular: e.hasGranular,
        demandKW: e.demandKW,
        billedKW: e.billedKW,
        facKW: e.facKW,
        demandCost,
        facilitiesCost,
        energyCost,
        fixedCost,
        totalKwCost,
        totalBill,
        loadFactor: lf,
        effDemRate,
        ratchetCost,
        ratchetGap,
        kwh: e.kwh,
        normDays: e.normDays,
      };
    });

    const t12months = months.filter((m) => trailing12.includes(m.ym));

    // KPI calculations — trailing 12 months
    const t12withBill = t12months.filter((m) => m.totalBill > 0);
    const demandPct = t12withBill.length
      ? t12withBill.reduce((s, m) => s + m.totalKwCost / m.totalBill, 0) / t12withBill.length
      : null;

    const peakKW = t12months.length ? Math.max(...t12months.map((m) => m.demandKW).filter((v) => v > 0)) : null;
    const peakMo = peakKW != null ? t12months.find((m) => m.demandKW === peakKW) : null;

    const lfMos = t12months.filter((m) => m.loadFactor != null && m.loadFactor > 0 && m.loadFactor <= 1.5);
    const avgLoadFactor = lfMos.length ? lfMos.reduce((s, m) => s + m.loadFactor, 0) / lfMos.length : null;

    const annualRatchet = t12months.reduce((s, m) => s + m.ratchetCost, 0);

    // Insight strings
    const insights = [];
    if (demandPct != null && demandPct > 0) {
      const pctStr = (demandPct * 100).toFixed(0) + '%';
      if (demandPct >= 0.4) {
        insights.push(
          'Demand charges represent <strong>' +
            pctStr +
            '</strong> of the electric bill. For most commercial buildings, reducing peak demand is more cost-effective than reducing total energy use alone.',
        );
      } else {
        insights.push('Demand charges represent <strong>' + pctStr + '</strong> of the electric bill.');
      }
    }
    if (annualRatchet > 100 && peakMo) {
      insights.push(
        'An estimated <strong>$' +
          annualRatchet.toLocaleString('en-US', { maximumFractionDigits: 0 }) +
          '/yr</strong> in ratchet charges — billing demand exceeds metered demand in months where the ratchet clause is active. The summer peak sets a demand floor for the following 11 months.',
      );
    }
    if (avgLoadFactor != null && avgLoadFactor < 0.3) {
      insights.push(
        'Average load factor of <strong>' +
          (avgLoadFactor * 100).toFixed(0) +
          '%</strong> indicates highly concentrated usage — typical of buildings where HVAC equipment starts simultaneously. Staggered equipment start sequences can reduce peak demand by 10–20% without reducing total energy use.',
      );
    } else if (avgLoadFactor != null && avgLoadFactor < 0.4) {
      insights.push(
        'Average load factor of <strong>' +
          (avgLoadFactor * 100).toFixed(0) +
          '%</strong>. A load factor below 33% is a signal of concentrated morning startup peaks. Well-managed commercial buildings typically reach 50%+.',
      );
    }
    const hasAnyRatchet = t12months.some((m) => m.ratchetGap > 5);
    if (hasAnyRatchet && !insights.some((s) => s.includes('ratchet'))) {
      const ratchetMos = t12months.filter((m) => m.ratchetGap > 5);
      insights.push(
        'Billed demand exceeds metered demand in <strong>' +
          ratchetMos.length +
          ' of the last 12 months</strong> — the utility ratchet clause is active. Reducing peak summer demand saves money immediately and reduces the ratchet floor for the following year.',
      );
    }

    return {
      months, // trailing 24 months
      t12months, // trailing 12 months
      demandPct,
      peakKW,
      peakMo,
      avgLoadFactor,
      annualRatchet,
      insights,
      hasGranular: months.some((m) => m.hasGranular),
    };
  })();

  // ── Column visibility flags — computed ONCE, used by both headers and rows ──
  const hasKwData = isElec && Object.keys(perfDemByYm).length > 0;
  const hasBilKW =
    hasKwData &&
    filteredPostRows.some((r) => {
      const d = perfDemByYm[r.ym];
      return d && d.bilKW > 0 && Math.abs(d.bilKW - d.demKW) > 0.5;
    });
  const hasKwCost =
    hasKwData &&
    filteredPostRows.some((r) => {
      const d = perfDemByYm[r.ym];
      return d && (d.kwCost || 0) + (d.facKWCost || 0) > 0;
    });
  const hasKwhCostSav =
    isElec &&
    filteredPostRows.some((r) => {
      const d = perfDemByYm[r.ym];
      return d && d.kwhRate > 0;
    });
  const hasExpKW = hasKwData && Object.values(blDemKWByCalMo).some((v) => v > 0);
  const hasKwCostSav = hasKwCost && hasExpKW;
  const hasTotalCostSav = hasKwhCostSav || hasKwCostSav;
  const hasGasCostSav = !isElec && Object.keys(gasCostByYm).length > 0;

  // Use shared renderer for table and per-row savings (single source of truth).
  // Pass effectiveRows so the table uses normal-weather baselines when _useNormalWeather is active.
  const _perfResult = buildMeterPerfTableHTML(m, bills, incl, {
    mode: 'tab',
    projId: udSelProjId,
    bldgId: udSelBldgId,
    filterYMs: filteredPostRows.length ? filteredPostRows.map((r) => r.ym) : truePostRows.map((r) => r.ym),
    effectiveRows: _useNormalWeather ? _effectiveRows : null,
  });
  const _perfRowSavings = (_perfResult.rows || []).map((r) => ({
    ym: r.ym,
    savings: r.savings,
    kwhSaved: r.sav,
    kwhCostSav: r.kwhCostSav || 0,
    kwCostSav: r.kwCostSav || 0,
    thermCostSav: r.thermCostSav || 0,
  }));

  // Cost Delta = exact sum of the Total Savings ($) column values
  const savCost = _perfRowSavings.length ? _perfRowSavings.reduce((s, d) => s + d.savings, 0) : null;

  // Quarterly savings: current quarter first, fall back to most recent quarter with data
  const _qtrSavings = (() => {
    if (!_perfRowSavings.length) return { total: null, projected: null, monthsWithData: 0, label: '' };
    const _qtrMonths = (y, q) => [0, 1, 2].map((i) => y + '-' + String(q * 3 + i + 1).padStart(2, '0'));
    const _qtrLabel = (q) => ['Q1', 'Q2', 'Q3', 'Q4'][q];
    const now = new Date();
    const curY = now.getFullYear();
    const curQ = Math.floor(now.getMonth() / 3);
    // Try current quarter first
    let qMonths = _qtrMonths(curY, curQ);
    let qtrRows = _perfRowSavings.filter((d) => qMonths.includes(d.ym));
    let label = _qtrLabel(curQ) + ' ' + curY;
    // If no data in current quarter, find most recent quarter with data
    if (!qtrRows.length) {
      const sortedYms = _perfRowSavings.map((d) => d.ym).sort();
      const lastYm = sortedYms[sortedYms.length - 1];
      const [ly, lm] = lastYm.split('-').map(Number);
      const lastQ = Math.floor((lm - 1) / 3);
      qMonths = _qtrMonths(ly, lastQ);
      qtrRows = _perfRowSavings.filter((d) => qMonths.includes(d.ym));
      label = _qtrLabel(lastQ) + ' ' + ly;
    }
    const qtrTotal = qtrRows.reduce((s, d) => s + d.savings, 0);
    const monthsWithData = qtrRows.length;
    const projected = monthsWithData > 0 && monthsWithData < 3 ? (qtrTotal / monthsWithData) * 3 : null;
    return { total: monthsWithData > 0 ? qtrTotal : null, projected, monthsWithData, label };
  })();

  // ── Stats pills (built AFTER savings pre-computation) ──
  const _savFmtPill = (v) =>
    (v < 0 ? '+' : '−') + ' $' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const statsHTML =
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
    blPill(blAvgMo.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + unit + '/mo', 'Baseline Avg') +
    (blRegrAvgMo != null
      ? blPill(
          blRegrAvgMo.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + unit + '/mo',
          'Normalized Baseline Avg',
          'var(--violet)',
        )
      : '') +
    blPill(postAvgMo.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + unit + '/mo', 'Post-BL Avg') +
    blPill(
      (savPct >= 0 ? '+' : '−') + Math.abs(savPct).toFixed(1) + '%',
      savPct >= 0 ? 'Reduction' : 'Increase',
      savPct >= 0 ? 'var(--em)' : 'var(--danger)',
    ) +
    (savCost !== null ? blPill(_savFmtPill(savCost), 'Cost Delta', savCost >= 0 ? 'var(--em)' : 'var(--danger)') : '') +
    (_qtrSavings.total !== null
      ? blPill(
          _savFmtPill(_qtrSavings.total),
          _qtrSavings.label + ' Savings (' + _qtrSavings.monthsWithData + '/3 mo)',
          _qtrSavings.total >= 0 ? 'var(--em)' : 'var(--danger)',
        )
      : '') +
    (_qtrSavings.projected !== null && _qtrSavings.monthsWithData < 3
      ? blPill(_savFmtPill(_qtrSavings.projected), 'Projected ' + _qtrSavings.label + ' Savings', 'var(--warn)')
      : '') +
    (blEUI != null ? blPill(blEUI.toFixed(1) + ' kBtu/sf/yr', 'Baseline Site EUI') : '') +
    (rolling12EUI != null ? blPill(rolling12EUI.toFixed(1) + ' kBtu/sf/yr', '12-Mo Site EUI', 'var(--warn)') : '') +
    '</div>';

  // -- Table HTML from shared renderer (rows, sum row, headers all handled by buildMeterPerfTableHTML) --

  // ── kW demand map for all chartRows (electric only) ──
  const perfKwByYm = {};
  if (isElec) {
    chartRows.forEach((r) => {
      const bfr = bills.filter((b) => normMonth(b.start, b.end, incl, bills) === r.ym);
      const demKW = bfr.reduce((s, b) => s + parseFloat(b.demandKW || 0), 0) / Math.max(1, bfr.length);
      const bilKW = bfr.reduce((s, b) => s + parseFloat(b.billedKW || b.demandKW || 0), 0) / Math.max(1, bfr.length);
      if (demKW > 0 || bilKW > 0) perfKwByYm[r.ym] = { demKW, bilKW, era: r.era };
    });
  }
  const hasPerfKwData = Object.keys(perfKwByYm).length > 0;

  // ── Anomaly detection ──
  // computeAnomalyScores / detectRateChanges / getBaseloadTrend are defined in
  // computations/anomaly-detection.js, loaded before this file.
  const _anomalyScoreMap =
    typeof computeAnomalyScores === 'function' ? computeAnomalyScores(m, allRows, blRows, bills, incl) : {};
  const _anomalyRateMap = typeof detectRateChanges === 'function' ? detectRateChanges(m, bills, incl) : {};
  const _anomalyBaseloadTrend = typeof getBaseloadTrend === 'function' ? getBaseloadTrend(m, allRows, blRows) : null;
  // Attach transient _anomaly flag to each bill object (not persisted)
  if (typeof attachAnomalyToBills === 'function') {
    attachAnomalyToBills(_anomalyScoreMap, bills, incl);
  }
  const anomalySection =
    typeof anomalyAlertHTML === 'function' && filteredPostRows.length
      ? '<div style="margin-bottom:14px">' +
        '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">Anomaly Detection</div>' +
        anomalyAlertHTML(_anomalyScoreMap, _anomalyRateMap, _anomalyBaseloadTrend, unit) +
        '</div>'
      : '';

  const chartSection = _perfChartVis
    ? '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:8px">' +
      perfChartLabel +
      '</div>' +
      '<div class="ma-chart-wrap"><canvas id="perfChart"></canvas></div>' +
      '<div style="display:flex;gap:10px;margin-top:8px;font-size:11px;color:var(--text2);flex-wrap:wrap">' +
      '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:rgba(120,130,160,0.45);border-radius:2px;display:inline-block"></span>Pre-Baseline (Actual)</span>' +
      '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:rgba(0,212,170,0.8);border-radius:2px;display:inline-block"></span>Baseline (Actual)</span>' +
      '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:rgba(100,160,255,0.75);border-radius:2px;display:inline-block"></span>Post-Baseline (Actual)</span>' +
      (hasRegr_p
        ? '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:3px;background:rgba(142,68,173,0.9);border-radius:1px;display:inline-block"></span>Baseline (Normalized)</span>'
        : '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:3px;background:var(--warn);border-radius:1px;display:inline-block"></span>Baseline Avg</span>') +
      '</div>' +
      (isElec && hasPerfKwData
        ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin:16px 0 8px">Actual kW Demand — All Periods</div>' +
          '<div class="ma-chart-wrap" style="height:280px"><canvas id="perfKwChart"></canvas></div>'
        : '') +
      '</div>'
    : '<div></div>';

  // ── Demand Analytics HTML section ──
  const demandSection = (() => {
    if (!_demAnalytics) return '';
    const da = _demAnalytics;
    const nc = (v) => (v != null ? '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—');
    const n1 = (v) => (v != null ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
    const pct = (v) => (v != null ? (v * 100).toFixed(0) + '%' : '—');

    // KPI card helper
    const kpiCard = (label, value, sub, accentColor) =>
      '<div style="background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;min-width:120px;flex:1">' +
      '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">' +
      label +
      '</div>' +
      '<div style="font-size:20px;font-weight:800;color:' +
      (accentColor || 'var(--text)') +
      ';font-family:var(--mono,monospace);line-height:1.1">' +
      value +
      '</div>' +
      (sub ? '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + sub + '</div>' : '') +
      '</div>';

    // KPI values
    const demPctColor =
      da.demandPct == null
        ? 'var(--text)'
        : da.demandPct >= 0.4
          ? 'var(--warn)'
          : da.demandPct < 0.3
            ? 'var(--em)'
            : 'var(--text)';
    const lfColor =
      da.avgLoadFactor == null
        ? 'var(--text)'
        : da.avgLoadFactor >= 0.4
          ? 'var(--em)'
          : da.avgLoadFactor >= 0.3
            ? 'var(--warn)'
            : 'var(--danger)';
    const ratchetColor = da.annualRatchet > 100 ? 'var(--warn)' : 'var(--text)';
    const peakSub = da.peakMo ? 'in ' + da.peakMo.label : 'trailing 12 mo';

    const kpiRow =
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">' +
      kpiCard('Demand % of Bill', da.demandPct != null ? pct(da.demandPct) : '—', 'trailing 12-mo avg', demPctColor) +
      kpiCard('Peak Demand', da.peakKW != null ? n1(da.peakKW) + ' kW' : '—', peakSub, 'var(--text)') +
      kpiCard(
        'Avg Load Factor',
        da.avgLoadFactor != null ? pct(da.avgLoadFactor) : '—',
        'trailing 12-mo avg',
        lfColor,
      ) +
      kpiCard(
        'Est. Ratchet Cost',
        da.annualRatchet > 0 ? nc(da.annualRatchet) + '/yr' : '$0',
        'billed − metered × rate',
        ratchetColor,
      ) +
      '</div>';

    // Granular data note
    const granularNote = !da.hasGranular
      ? '<div style="font-size:11px;color:var(--text3);background:var(--s3);border:1px solid var(--border);border-radius:5px;padding:6px 10px;margin-bottom:12px">' +
        'Note: Detailed demand breakdown not available — bills do not have granular charge fields (demandCharge, facilitiesCharge). Showing totals from kwCost/facKWCost.' +
        '</div>'
      : '';

    // Insight callouts
    const insightHTML = da.insights.length
      ? '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">' +
        da.insights
          .map(
            (txt) =>
              '<div style="font-size:12px;color:var(--text2);background:var(--s3);border-left:3px solid var(--em);border-radius:0 5px 5px 0;padding:7px 10px;line-height:1.5">' +
              txt +
              '</div>',
          )
          .join('') +
        '</div>'
      : '';

    // Chart canvases
    const chartCanvases =
      '<div style="display:grid;grid-template-columns:1fr;gap:16px">' +
      '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:6px">Cost Breakdown by Month</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">Demand (kW charges + TDC) · Facilities · Energy · Fixed</div>' +
      '<div class="ma-chart-wrap" style="height:220px"><canvas id="demCostChart"></canvas></div>' +
      '</div>' +
      '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:6px">Peak Demand Trend</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">Metered kW · Billed kW (ratchet floor) · Facilities kW (12-mo rolling peak)</div>' +
      '<div class="ma-chart-wrap" style="height:220px"><canvas id="demTrendChart"></canvas></div>' +
      '</div>' +
      '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:6px">Load Factor Trend</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">kWh ÷ (Actual metered kW × 24 × days) — not billed/ratchet kW · dashed lines: 33% typical school · 50% target</div>' +
      '<div class="ma-chart-wrap" style="height:180px"><canvas id="demLFChart"></canvas></div>' +
      '</div>' +
      '<div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2);margin-bottom:6px">Minimum Hours</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">kWh ÷ Actual kW — hours demand would need to run at peak to deliver actual energy</div>' +
      '<div class="ma-chart-wrap" style="height:180px"><canvas id="demMinHoursChart"></canvas></div>' +
      '</div>' +
      '</div>';

    return (
      '<div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px">' +
      '<div style="font-size:13px;font-weight:800;font-family:var(--head);letter-spacing:-.01em;margin-bottom:12px;color:var(--text)">Demand Charge Analysis</div>' +
      granularNote +
      kpiRow +
      insightHTML +
      chartCanvases +
      '</div>'
    );
  })();

  pane.innerHTML =
    '<div style="margin-bottom:14px"><div style="font-size:16px;font-weight:800;font-family:var(--head);letter-spacing:-.01em">⚡ ' +
    (m.name || 'Meter') +
    ' — Meter Performance</div></div>' +
    statsHTML +
    basisNote_p +
    weatherModeBar +
    yearPills +
    '<div style="margin-bottom:14px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;margin-bottom:4px">' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text2)">Post-Baseline Monthly vs Baseline</div>' +
    (filteredPostRows.length && _perfResult.html && typeof tableZoomControlHTML === 'function'
      ? tableZoomControlHTML('perf-table-wrap', 'en_perf_zoom', 'perf-zoom-lbl')
      : '') +
    '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' +
    (hasRegr_p
      ? 'Baseline = weather-normalized calendar month value · <span style="color:var(--violet)">🔬 R</span> = regression-derived'
      : 'Baseline = calendar month normalized value (simple avg)') +
    '</div>' +
    (filteredPostRows.length && _perfResult.html
      ? _perfResult.html
      : '<div style="font-size:12px;color:var(--text3);padding:20px;text-align:center">No post-baseline data yet — add billing periods after <strong>' +
        fmtMon(blEnd + '-01') +
        '</strong></div>') +
    '</div>' +
    anomalySection +
    perfControlBar +
    chartSection +
    demandSection;

  // Apply persisted zoom to perf table (restores stored zoom level on every tab open)
  if (filteredPostRows.length && _perfResult.html && typeof setTableZoom === 'function') {
    requestAnimationFrame(function () {
      setTableZoom('perf-table-wrap', null, 'en_perf_zoom', 'perf-zoom-lbl');
    });
  }

  if (_perfChartVis) {
    requestAnimationFrame(() => {
      drawPerfChart(
        'perfChart',
        chartRows,
        blAvgDay,
        blAvgMo,
        barColors,
        unit,
        bills,
        incl,
        _perfMetric,
        _perfOverlay,
        _anomalyScoreMap,
      );
    });
    if (isElec && hasPerfKwData) {
      requestAnimationFrame(() => {
        const kwCanvas = document.getElementById('perfKwChart');
        if (!kwCanvas) return;
        if (_maCharts['perfKwChart']) {
          _maCharts['perfKwChart'].destroy();
        }
        const kwLabels = chartRows.map((r) => r.label);
        const kwColors = chartRows.map((r) =>
          r.era === 'baseline'
            ? 'rgba(0,212,170,0.8)'
            : r.era === 'pre'
              ? 'rgba(120,130,160,0.35)'
              : 'rgba(100,160,255,0.75)',
        );
        const hasBilKW2 = chartRows.some((r) => {
          const d = perfKwByYm[r.ym];
          return d && d.bilKW > 0 && Math.abs(d.bilKW - d.demKW) > 0.5;
        });
        const kwDatasets = [
          {
            label: 'Actual kW',
            data: chartRows.map((r) => {
              const d = perfKwByYm[r.ym];
              return d ? +d.demKW.toFixed(1) : null;
            }),
            backgroundColor: kwColors,
            borderColor: kwColors.map((c) => c.replace(/[\d.]+\)$/, '1)')),
            borderWidth: 1,
            borderRadius: 3,
          },
        ];
        if (hasBilKW2) {
          kwDatasets.push({
            label: 'Billed kW',
            type: 'line',
            data: chartRows.map((r) => {
              const d = perfKwByYm[r.ym];
              return d && d.bilKW > 0 ? +d.bilKW.toFixed(1) : null;
            }),
            borderColor: 'rgba(255,200,80,0.85)',
            backgroundColor: 'transparent',
            pointBackgroundColor: 'rgba(255,200,80,0.9)',
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
          });
        }
        if (_kwReg && Object.keys(_kwNormByYm).length > 0) {
          kwDatasets.push({
            label: 'Baseline kW',
            type: 'line',
            data: chartRows.map((r) => {
              const v = _kwNormByYm[r.ym];
              return v != null ? +v.toFixed(1) : null;
            }),
            borderColor: 'rgba(139,92,246,0.9)',
            backgroundColor: 'transparent',
            pointBackgroundColor: 'rgba(139,92,246,1)',
            borderWidth: 2,
            borderDash: [5, 4],
            pointRadius: 3,
            tension: 0.3,
            order: 0,
          });
        }
        const _hasExpKw = _kwReg && Object.keys(_kwNormByYm).length > 0;
        _maCharts['perfKwChart'] = new Chart(kwCanvas, {
          type: 'bar',
          data: { labels: kwLabels, datasets: kwDatasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: {
                display: hasBilKW2 || _hasExpKw,
                position: 'top',
                labels: { color: 'rgba(200,220,240,0.9)', font: { size: 11 }, boxWidth: 12, padding: 12 },
              },
              tooltip: {
                callbacks: {
                  label: (ctx) =>
                    ctx.parsed.y != null
                      ? ' ' +
                        ctx.dataset.label +
                        ': ' +
                        ctx.parsed.y.toLocaleString('en-US', {
                          minimumFractionDigits: 4,
                          maximumFractionDigits: 4,
                        }) +
                        ' kW'
                      : null,
                },
              },
            },
            scales: {
              x: {
                ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 }, maxRotation: 45 },
                grid: { color: 'rgba(255,255,255,0.10)' },
              },
              y: {
                beginAtZero: true,
                ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 } },
                grid: { color: 'rgba(255,255,255,0.12)' },
                title: { display: true, text: 'kW', color: 'rgba(160,185,210,0.8)', font: { size: 11 } },
              },
            },
          },
        });
      });
    }
  }

  // ── Demand Analytics Charts ──
  if (_demAnalytics && _demAnalytics.months.length > 0) {
    requestAnimationFrame(() => {
      if (typeof drawDemandCostChart === 'function') drawDemandCostChart('demCostChart', _demAnalytics.months);
    });
    requestAnimationFrame(() => {
      if (typeof drawDemandTrendChart === 'function') drawDemandTrendChart('demTrendChart', _demAnalytics.months);
    });
    requestAnimationFrame(() => {
      if (typeof drawLoadFactorChart === 'function') drawLoadFactorChart('demLFChart', _demAnalytics.months);
    });
    requestAnimationFrame(() => {
      if (typeof drawMinimumHoursChart === 'function') drawMinimumHoursChart('demMinHoursChart', _demAnalytics.months);
    });
  }
}

function setPerfYearFilter(mid, val) {
  _perfYearFilter = val;
  const b = getUDBldg(udSelProjId, udSelBldgId);
  if (!b) return;
  const m = b.meters.find((m) => m.id === mid);
  if (!m) return;
  const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
  const incl = m.inclusive !== false;
  const _aw2 = window._udActiveWrap || document.getElementById('udDetailWrap');
  const pane = (_aw2 ? _aw2.querySelector('#maPane') : null) || document.getElementById('maPane');
  if (!pane) return;
  renderPerfPane(pane, m, bills, incl);
}

function drawPerfChart(canvasId, rows, blAvgDay, blAvgMo, colors, unit, bills, incl, metric, showOverlay, scoreMap) {
  metric = metric || 'total';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }
  const isElecB = unit === 'kWh';
  const isGasB = unit === 'Therms';
  const isPropaneB = unit === 'Gallons'; // Bug #139: propane detection
  const labels = rows.map((r) => r.label);
  const isTotal = metric === 'total';
  const mainData = isTotal ? rows.map((r) => +r.usage.toFixed(0)) : rows.map((r) => +r.usagePerDay.toFixed(2));
  const blRef = isTotal ? +blAvgMo.toFixed(0) : +blAvgDay.toFixed(2);
  const yLabel = isTotal ? unit + '/Month' : unit + '/Day';
  const hasRegr = rows.some((r) => r.regrBaseline != null);

  // Bars = Actual usage; Baseline shown as a line (purple when regression active)
  const blLineData = hasRegr
    ? rows.map((r) =>
        r.regrBaseline == null
          ? null
          : isTotal
            ? +r.regrBaseline.toFixed(0)
            : +(r.regrBaseline / r.normDays).toFixed(2),
      )
    : rows.map(() => blRef);

  // Build actual usage by norm-month from raw bills
  const billByYmMain = {};
  if (bills && bills.length) {
    bills.forEach((b) => {
      if (!b.start || !b.end) return;
      const ym = normMonth(b.start, b.end, incl, bills);
      const usage = isElecB
        ? parseFloat(b.kwh) || 0
        : isGasB
          ? parseFloat(b.therms) || 0
          : isPropaneB
            ? parseFloat(b.gallonsDelivered) || parseFloat(b.kwh) || 0 // Bug #139: propane uses gallonsDelivered
            : parseFloat(b.usage) || 0;
      const days = Math.max(1, parseInt(calcDays(b.start, b.end, incl)) || 1);
      if (!billByYmMain[ym] || usage > 0) billByYmMain[ym] = { usage, days };
    });
  }

  // Actual kWh bars (era-colored)
  const datasets = [
    {
      label: 'Actual ' + unit,
      data: rows.map((r) => {
        const bd = billByYmMain[r.ym];
        return bd ? (isTotal ? +bd.usage.toFixed(0) : +(bd.usage / bd.days).toFixed(2)) : null;
      }),
      backgroundColor: colors,
      borderColor: colors.map((c) => c.replace(/[\d.]+\)$/, '1)')),
      borderWidth: 1,
      borderRadius: 3,
      order: 3,
    },
  ];

  // Baseline line — purple when regression active, amber dashed when fallback avg
  datasets.push({
    label: hasRegr ? 'Baseline ' + unit : 'Baseline Avg',
    data: blLineData,
    type: 'line',
    borderColor: hasRegr ? 'rgba(142,68,173,0.9)' : 'rgba(245,158,11,0.9)',
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderDash: [5, 4],
    pointRadius: hasRegr ? 3 : 0,
    pointBackgroundColor: hasRegr ? 'rgba(142,68,173,1)' : undefined,
    tension: 0.3,
    fill: false,
    order: 1,
  });

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(200,210,230,0.85)', font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              if (ctx.dataset.label === 'Baseline Avg')
                return ' Baseline avg: ' + (isTotal ? v.toFixed(0) : v.toFixed(2)) + ' ' + yLabel;
              if (ctx.dataset.label.startsWith('Baseline ') || ctx.dataset.label.startsWith('Actual '))
                return (
                  ' ' +
                  ctx.dataset.label +
                  ': ' +
                  (isTotal ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)) +
                  ' ' +
                  yLabel
                );
              const era = rows[ctx.dataIndex]?.era;
              const tag = era === 'pre' ? 'Pre-Baseline' : era === 'baseline' ? 'Baseline' : 'Post-Baseline';
              return (
                ' ' +
                (era ? tag : ctx.dataset.label) +
                ': ' +
                (isTotal ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)) +
                ' ' +
                yLabel
              );
            },
          },
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.10)' } },
        y: {
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: yLabel, font: { size: 10 } },
        },
      },
    },
  });
}

/* ══════════════════════════════════════════
   DEMAND ANALYTICS CHARTS
   All three receive the `bills` array from
   _demAnalytics.months — each element has:
     label, demandKW, billedKW, facKW,
     demandCost, facilitiesCost, energyCost,
     fixedCost, loadFactor, normDays, kwh
   ══════════════════════════════════════════ */

function drawDemandCostChart(canvasId, bills) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }

  const labels = bills.map((b) => b.label);

  // Stacked cost breakdown datasets
  const datasets = [
    {
      label: 'Demand Charge',
      data: bills.map((b) => +(b.demandCost || 0).toFixed(2)),
      backgroundColor: 'rgba(100,160,255,0.80)',
      borderColor: 'rgba(100,160,255,1)',
      borderWidth: 1,
      stack: 'cost',
    },
    {
      label: 'Facilities Charge',
      data: bills.map((b) => +(b.facilitiesCost || 0).toFixed(2)),
      backgroundColor: 'rgba(139,92,246,0.75)',
      borderColor: 'rgba(139,92,246,1)',
      borderWidth: 1,
      stack: 'cost',
    },
    {
      label: 'Energy Charge',
      data: bills.map((b) => +(b.energyCost || 0).toFixed(2)),
      backgroundColor: 'rgba(0,212,170,0.72)',
      borderColor: 'rgba(0,212,170,1)',
      borderWidth: 1,
      stack: 'cost',
    },
    {
      label: 'Fixed Charges',
      data: bills.map((b) => +(b.fixedCost || 0).toFixed(2)),
      backgroundColor: 'rgba(245,158,11,0.72)',
      borderColor: 'rgba(245,158,11,1)',
      borderWidth: 1,
      stack: 'cost',
    },
  ];

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: 'rgba(200,210,230,0.85)', font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null || v === 0) return null;
              return (
                ' ' +
                ctx.dataset.label +
                ': $' +
                v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
              );
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.10)' },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            color: 'rgba(180,200,220,0.8)',
            font: { size: 10 },
            callback: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
          },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: 'Cost ($)', color: 'rgba(160,185,210,0.8)', font: { size: 10 } },
        },
      },
    },
  });
}

function drawDemandTrendChart(canvasId, bills) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }

  const labels = bills.map((b) => b.label);
  const hasActual = bills.some((b) => (b.demandKW || 0) > 0);
  const hasBilled = bills.some((b) => (b.billedKW || 0) > 0);
  const hasFac = bills.some((b) => (b.facKW || 0) > 0);

  const datasets = [];

  if (hasActual) {
    datasets.push({
      label: 'Actual kW',
      data: bills.map((b) => (b.demandKW > 0 ? +b.demandKW.toFixed(1) : null)),
      borderColor: 'rgba(100,160,255,0.9)',
      backgroundColor: 'rgba(100,160,255,0.15)',
      borderWidth: 2,
      pointRadius: 3,
      pointBackgroundColor: 'rgba(100,160,255,1)',
      tension: 0.3,
      fill: false,
    });
  }

  if (hasBilled) {
    datasets.push({
      label: 'Billed kW',
      data: bills.map((b) => (b.billedKW > 0 ? +b.billedKW.toFixed(1) : null)),
      borderColor: 'rgba(245,158,11,0.9)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [5, 4],
      pointRadius: 3,
      pointBackgroundColor: 'rgba(245,158,11,1)',
      tension: 0.3,
      fill: false,
    });
  }

  if (hasFac) {
    datasets.push({
      label: 'Facilities kW',
      data: bills.map((b) => (b.facKW > 0 ? +b.facKW.toFixed(1) : null)),
      borderColor: 'rgba(139,92,246,0.9)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [3, 3],
      pointRadius: 3,
      pointBackgroundColor: 'rgba(139,92,246,1)',
      tension: 0.3,
      fill: false,
    });
  }

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: 'top',
          labels: { color: 'rgba(200,210,230,0.85)', font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              return ' ' + ctx.dataset.label + ': ' + v.toFixed(1) + ' kW';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.10)' },
        },
        y: {
          beginAtZero: false,
          ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: 'kW', color: 'rgba(160,185,210,0.8)', font: { size: 10 } },
        },
      },
    },
  });
}

function drawLoadFactorChart(canvasId, bills) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }

  const labels = bills.map((b) => b.label);

  // Load factor = kWh / (demandKW x 24 x days); already computed as b.loadFactor
  // Color-code bars: green >0.5, yellow 0.3-0.5, red <0.3
  const data = bills.map((b) => (b.loadFactor != null ? +b.loadFactor.toFixed(3) : null));
  const colors = data.map((v) => {
    if (v == null) return 'rgba(120,130,150,0.4)';
    if (v >= 0.5) return 'rgba(0,212,170,0.80)';
    if (v >= 0.3) return 'rgba(245,158,11,0.80)';
    return 'rgba(239,68,68,0.80)';
  });
  const borderColors = colors.map((c) => c.replace('0.80)', '1)').replace('0.4)', '1)'));

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Load Factor',
          data,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              const pct = (v * 100).toFixed(1) + '%';
              const grade = v >= 0.5 ? 'Good' : v >= 0.3 ? 'Fair' : 'Poor';
              return ' Load Factor: ' + pct + ' (' + grade + ')';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.10)' },
        },
        y: {
          beginAtZero: true,
          min: 0,
          ticks: {
            color: 'rgba(180,200,220,0.8)',
            font: { size: 10 },
            callback: (v) => (v * 100).toFixed(0) + '%',
          },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: 'Load Factor %', color: 'rgba(160,185,210,0.8)', font: { size: 10 } },
        },
      },
    },
  });
}

function drawMinimumHoursChart(canvasId, bills) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_maCharts[canvasId]) {
    _maCharts[canvasId].destroy();
  }

  const labels = bills.map((b) => b.label);

  // Minimum Hours = kWh ÷ Actual kW — hours demand would need to run at peak to deliver actual energy
  const data = bills.map((b) => (b.demandKW > 0 && b.kwh > 0 ? +(b.kwh / b.demandKW).toFixed(2) : null));

  _maCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Minimum Hours',
          data,
          backgroundColor: 'rgba(100,220,160,0.75)',
          borderColor: 'rgba(100,220,160,1)',
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              return ' Min Hours: ' + v.toFixed(1) + ' hrs';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(180,200,220,0.8)', font: { size: 10 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.10)' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: 'rgba(180,200,220,0.8)',
            font: { size: 10 },
            callback: (v) => v + ' hrs',
          },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: 'Hours', color: 'rgba(160,185,210,0.8)', font: { size: 10 } },
        },
      },
    },
  });
}
