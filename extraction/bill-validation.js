// extraction/bill-validation.js — Bill validation coordination layer
// Loaded before app/bill-analysis.js per energy-department.html script order.
// Depends on: _analyzeMeterBills (app/bill-analysis.js), getUDProj (app/utility-data.js or core.js),
//             saveUtilityData (utility-data.js), renderMeterWorkspace (utility-data.js)

/**
 * Run bill validation for a single bill on a meter.
 * Calls _analyzeMeterBills on all bills in the meter, extracts flags for
 * this specific bill, converts to the persistent _flags array format, and
 * writes to bill._flags.
 *
 * @param {object} meter  - Meter object with .commodity, .bills[]
 * @param {object} bill   - Bill object on that meter (mutated in place)
 */
function runBillValidation(meter, bill) {
  if (!meter || !bill || typeof _analyzeMeterBills !== 'function') return;
  const bills = meter.bills || [];
  // _analyzeMeterBills needs at least 4 bills to compute stats
  const allFlags = _analyzeMeterBills(bills, meter);
  const transientFlags = allFlags[bill.id] || [];

  // Convert transient { field, msg, level } → persistent { id, label, severity, firedAt, dismissed, dismissNote }
  // Preserve any existing dismissed flags — merge by id so dismissals survive a re-validation.
  const existing = Array.isArray(bill._flags) ? bill._flags : [];
  const today = new Date().toISOString().slice(0, 10);
  const newFlags = transientFlags.map((f) => {
    const flagId = (f.field || 'unknown') + '_' + (f.level || 'warn');
    const prev = existing.find((e) => e.id === flagId);
    return {
      id: flagId,
      label: f.msg || '',
      severity: f.level === 'error' ? 'error' : 'warning',
      firedAt: prev ? prev.firedAt : today,
      dismissed: prev ? prev.dismissed : false,
      dismissNote: prev ? prev.dismissNote : '',
    };
  });
  bill._flags = newFlags;
}

/**
 * Return the count of active (non-dismissed) flags on a bill.
 * Returns 0 if no _flags array or all dismissed.
 *
 * @param {object} bill
 * @returns {number}
 */
function getBillFlagCount(bill) {
  if (!bill || !Array.isArray(bill._flags)) return 0;
  return bill._flags.filter((f) => !f.dismissed).length;
}

/**
 * Dismiss a specific flag on a bill and persist.
 *
 * @param {string|number} projId
 * @param {string} bldgId
 * @param {string} meterId
 * @param {string} billId
 * @param {string} flagId
 * @param {string} [note]
 */
function dismissBillFlag(projId, bldgId, meterId, billId, flagId, note) {
  if (typeof getUDProj !== 'function') return;
  const udProj = getUDProj(projId);
  if (!udProj) return;
  const bldg = (udProj.buildings || []).find((b) => b.id === bldgId);
  if (!bldg) return;
  const meter = (bldg.meters || []).find((m) => m.id === meterId);
  if (!meter) return;
  const bill = (meter.bills || []).find((b) => b.id === billId);
  if (!bill || !Array.isArray(bill._flags)) return;
  const flag = bill._flags.find((f) => f.id === flagId);
  if (!flag) return;
  flag.dismissed = true;
  flag.dismissNote = note || '';
  if (typeof saveUtilityData === 'function') saveUtilityData();
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}
