// extraction/bill-validation.js - dismissing a bill flag.
// Bill flags are computed live by computeMeterFlagSummary (computations/bill-flags.js) and are never
// stored. The only thing stored on a bill is the user's dismissal, by rule id (flag.dismissId).
// Depends on: getUDProj (app/utility-data.js or core.js), saveUtilityData and renderMeterWorkspace
// (app/utility-data.js).

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
  if (!bill) return;
  // Flags are live, so the stored entry may not exist yet when the user first dismisses a flag. Create it if absent.
  if (!Array.isArray(bill._flags)) bill._flags = [];
  let flag = bill._flags.find((f) => f.id === flagId);
  if (!flag) {
    // First-time dismiss: create a minimal persistent record just to store the dismissal.
    flag = {
      id: flagId,
      label: '',
      severity: 'warning',
      firedAt: new Date().toISOString().slice(0, 10),
      dismissed: false,
      dismissNote: '',
    };
    bill._flags.push(flag);
  }
  flag.dismissed = true;
  flag.dismissNote = note || '';
  // Scope to the flag's own project — may not be the currently active Utility Data tab project.
  if (typeof saveUtilityData === 'function') saveUtilityData(projId);
  if (typeof renderMeterWorkspace === 'function') renderMeterWorkspace();
}
