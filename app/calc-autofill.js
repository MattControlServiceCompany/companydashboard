/* ══════════════════════════════════════════════════════
   CALC AUTOFILL — one shared lookup for calculator-template
   fields the site already knows from the building/project.
   Today only the BAS Savings Calc (openBASCalc in
   calculators.js) has these fields; any future calc template
   that adds Building SqFt / Heating Source / existing setpoints
   should call this helper instead of writing its own lookup —
   single source of truth, no duplicated per-template logic.
   ══════════════════════════════════════════════════════ */

/* chCalcAutofillFields(projId, bldgId) -> {
     sqft:        {value, source, isDefault},
     heatSrc:     {value, source, isDefault},
     exCoolOcc:   {value, source, isDefault},
     exCoolUnocc: {value, source, isDefault},
     exHeatOcc:   {value, source, isDefault},
     exHeatUnocc: {value, source, isDefault},
     exMfOn:      {value, source, isDefault},  // Existing occupied schedule (Mon-Fri), imported
     exMfOff:     {value, source, isDefault},  // Effective Schedule only — never invented.
     newHeatOcc:  {value, source, isDefault},  // Proposed Conditions — company standard, always
     newCoolOcc:  {value, source, isDefault},  // present (no "no data" state, unlike Existing).
     newHeatUnocc:{value, source, isDefault},
     newCoolUnocc:{value, source, isDefault},
     newMfOn:     {value, source, isDefault},  // Proposed occupied schedule: school hours +-1.5h
     newMfOff:    {value, source, isDefault},  // staff buffer, general fallback 6:00 AM-5:00 PM.
     newSatOn:    {value, source, isDefault},  // Weekends always unoccupied (company standard).
     newSatOff:   {value, source, isDefault},
     newSunOn:    {value, source, isDefault},
     newSunOff:   {value, source, isDefault},
   }
   Every key is always present. isDefault:true means nothing was found for that
   field — callers should show the shipped default and flag it, not treat it as
   real building data. The Proposed (new*) fields are the one exception: they
   always have a company-standard fallback, so isDefault is always false for them
   (source is 'company standard' or 'Equipment Matrix' — see chResolveCalcField's
   caller in calculators.js, which never shows the generic "no data" hint for a
   field that isn't actually missing). Pure lookup, never mutates anything — safe
   to call on every render. */
function chCalcAutofillFields(projId, bldgId) {
  const mkDefault = () => ({ value: null, source: 'default', isDefault: true });
  const out = {
    sqft: mkDefault(),
    heatSrc: mkDefault(),
    exCoolOcc: mkDefault(),
    exCoolUnocc: mkDefault(),
    exHeatOcc: mkDefault(),
    exHeatUnocc: mkDefault(),
    exMfOn: mkDefault(),
    exMfOff: mkDefault(),
    newHeatOcc: { value: 70, source: 'company standard', isDefault: false },
    newCoolOcc: { value: 74, source: 'company standard', isDefault: false },
    newHeatUnocc: { value: null, source: 'company standard', isDefault: false },
    newCoolUnocc: { value: null, source: 'company standard', isDefault: false },
    newMfOn: { value: null, source: 'company standard', isDefault: false },
    newMfOff: { value: null, source: 'company standard', isDefault: false },
    newSatOn: { value: 0, source: 'company standard', isDefault: false },
    newSatOff: { value: 0, source: 'company standard', isDefault: false },
    newSunOn: { value: 0, source: 'company standard', isDefault: false },
    newSunOff: { value: 0, source: 'company standard', isDefault: false },
  };

  // Proposed occupied schedule (school hours +-1.5h staff buffer, general fallback 6:00 AM -
  // 5:00 PM) does not depend on which building/project is open — reuse equipment-matrix.js's own
  // _emComputeProposedSchedule (the SAME function the Setpoint & Schedule export uses), not a
  // second copy of the buffer math. Runs unconditionally so a building with zero Equipment
  // Matrix data still gets the company-standard schedule (item 2's "fallback to company
  // standards" case).
  if (typeof _emComputeProposedSchedule === 'function') {
    const sched = _emComputeProposedSchedule('');
    const startH = _chParseClockHM(sched.start);
    const stopH = _chParseClockHM(sched.stop);
    if (startH != null) out.newMfOn.value = startH;
    if (stopH != null) out.newMfOff.value = stopH;
  }

  if (!bldgId || typeof projects === 'undefined') return out;
  const p = projects.find((x) => x.id === projId);
  if (!p) return out;

  const bldg = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  let hasGas; // undefined = unknown (no meter records) — mirrors _emDeriveHeatingType's own
  // "not known" state, never a stand-in for false.
  if (bldg) {
    if (bldg.sqft && parseFloat(bldg.sqft) > 0) {
      out.sqft = { value: parseFloat(bldg.sqft), source: 'building record', isDefault: false };
    }

    const meters = bldg.meters || [];
    hasGas = meters.length ? meters.some((m) => m.commodity === 'Gas') : undefined;
    const hasElec = meters.some((m) => m.commodity === 'Electric');

    // Heating Source (2026-09-23): primarily sourced from the Equipment Matrix's own per-row
    // heating-type classifier (_emDeriveHeatingType, app/equipment-matrix.js — read-only, never
    // a second classifier), gas (hydronic) vs electric (electric reheat / heat pump / VRF) vs
    // both, for this building — matching the BAS Savings Calc's own heatSrc options (1 Gas-MCF /
    // 2 Electric / 3 Gas-Therms / 4 Both). Only rows with a real classification signal (known:
    // true) count; the unclassified fallback bucket is never treated as evidence. Falls back to
    // the building's own meter presence (pre-existing behavior) only when the Equipment Matrix
    // has no classifiable rows for this building at all.
    let emGas = false,
      emElec = false,
      emKnown = false;
    if (
      typeof emLoadMatrix === 'function' &&
      typeof emGetNormalizedPoints === 'function' &&
      typeof _emDeriveHeatingType === 'function' &&
      typeof _emNormBldgNameForJoin === 'function'
    ) {
      const data = emLoadMatrix(projId);
      const rows = (data && data.rows) || [];
      const wantName = _emNormBldgNameForJoin(bldg.name);
      rows.forEach((row) => {
        if (_emNormBldgNameForJoin(row.building || '') !== wantName) return;
        const pts = emGetNormalizedPoints(row) || {};
        const ht = _emDeriveHeatingType(row, pts, hasGas);
        if (!ht.known) return;
        emKnown = true;
        if (ht.key === 'hydronic') emGas = true;
        else if (ht.key === 'electricReheat' || ht.key === 'heatpump') emElec = true;
      });
    }

    if (emKnown) {
      if (emGas && emElec) {
        out.heatSrc = { value: 4, source: 'Equipment Matrix (gas + electric heating types)', isDefault: false };
      } else if (emGas) {
        out.heatSrc = { value: 3, source: 'Equipment Matrix (gas heating type)', isDefault: false };
      } else {
        out.heatSrc = { value: 2, source: 'Equipment Matrix (electric heating type)', isDefault: false };
      }
    } else if (hasGas && hasElec) {
      out.heatSrc = { value: 4, source: 'building meters (gas + electric)', isDefault: false };
    } else if (hasGas) {
      out.heatSrc = { value: 3, source: 'building meters (gas)', isDefault: false };
    } else if (hasElec) {
      out.heatSrc = { value: 2, source: 'building meters (electric)', isDefault: false };
    }
  }

  // Existing setpoints — the "Set Points" feature's per-building zone records
  // (p.setpoints, keyed by buildingId) win when present; this is the same store
  // graphics-setpoints.js reads/writes. See docs/dashboardlogic.md.
  const spRecord = (p.setpoints || []).find((r) => r.buildingId === bldgId);
  if (spRecord?.zones?.length) {
    const avgOf = (key) => {
      const vals = spRecord.zones.map((z) => parseFloat(z[key])).filter((v) => !isNaN(v));
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const occCool = avgOf('occCool'),
      unoccCool = avgOf('unoccCool'),
      occHeat = avgOf('occHeat'),
      unoccHeat = avgOf('unoccHeat');
    if (occCool != null) out.exCoolOcc = { value: occCool, source: 'Set Points', isDefault: false };
    if (unoccCool != null) out.exCoolUnocc = { value: unoccCool, source: 'Set Points', isDefault: false };
    if (occHeat != null) out.exHeatOcc = { value: occHeat, source: 'Set Points', isDefault: false };
    if (unoccHeat != null) out.exHeatUnocc = { value: unoccHeat, source: 'Set Points', isDefault: false };
  }

  // Equipment Matrix fallback (2026-09-23): most buildings (e.g. Spring Hill Schools /
  // Woodland Spring Middle) have no Set Points record at all — their real existing/proposed
  // setpoint data lives in the Equipment Matrix instead. Reuse emBuildSetpointExportRows (app/
  // equipment-matrix.js) — the SAME join/normalize/heating-type logic as the Setpoint Export
  // feature and the "Use Equipment Matrix Data" button — instead of a second per-zone averaging
  // implementation. Only fills fields Set Points left at isDefault, so an existing Set Points
  // record (if one exists for this building) is never overridden.
  if (typeof emBuildSetpointExportRows === 'function') {
    const rows = emBuildSetpointExportRows(projId, bldgId, null);
    if (rows && rows.length) {
      const avgCol = (idx) => {
        const vals = rows.map((r) => parseFloat(r[idx])).filter((v) => !isNaN(v));
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      };
      // Column indices match EM_SETPOINT_EXPORT_HEADERS / emBuildSetpointExportRows's push order.
      if (out.exHeatOcc.isDefault) {
        const v = avgCol(3);
        if (v != null) out.exHeatOcc = { value: v, source: 'Equipment Matrix', isDefault: false };
      }
      if (out.exCoolOcc.isDefault) {
        const v = avgCol(4);
        if (v != null) out.exCoolOcc = { value: v, source: 'Equipment Matrix', isDefault: false };
      }
      if (out.exHeatUnocc.isDefault) {
        const v = avgCol(5);
        if (v != null) out.exHeatUnocc = { value: v, source: 'Equipment Matrix', isDefault: false };
      }
      if (out.exCoolUnocc.isDefault) {
        const v = avgCol(6);
        if (v != null) out.exCoolUnocc = { value: v, source: 'Equipment Matrix', isDefault: false };
      }

      // Existing occupied schedule (Mon-Fri) — columns 9/10 only carry real values when an
      // Effective Schedules CSV has been imported and matched onto these rows (see
      // emAttachEffectiveSchedules); otherwise they are '?' and must stay '?' here too — no
      // schedule is ever invented.
      const startVals = rows.map((r) => _chParseClockHM(r[9])).filter((v) => v != null);
      const stopVals = rows.map((r) => _chParseClockHM(r[10])).filter((v) => v != null);
      if (startVals.length) {
        out.exMfOn = {
          value: Math.round(startVals.reduce((a, b) => a + b, 0) / startVals.length),
          source: 'Equipment Matrix (Effective Schedules import)',
          isDefault: false,
        };
      }
      if (stopVals.length) {
        out.exMfOff = {
          value: Math.round(stopVals.reduce((a, b) => a + b, 0) / stopVals.length),
          source: 'Equipment Matrix (Effective Schedules import)',
          isDefault: false,
        };
      }

      // Proposed Unoccupied setpoints — the Equipment Matrix's own per-zone heating-type
      // classification (_emDeriveHeatingType), already resolved to a company-standard bucket by
      // emBuildSetpointExportRows itself; this just averages that same output across the
      // building's rows, the same way the "Use Equipment Matrix Data" button does.
      const unoccHeatV = avgCol(14);
      const unoccCoolV = avgCol(15);
      if (unoccHeatV != null) out.newHeatUnocc = { value: unoccHeatV, source: 'Equipment Matrix', isDefault: false };
      if (unoccCoolV != null) out.newCoolUnocc = { value: unoccCoolV, source: 'Equipment Matrix', isDefault: false };
    }
  }

  // No Equipment Matrix rows for this building at all (item 2's "fallback to company
  // standards" case) — Proposed Unoccupied setpoints still resolve to the company-standard
  // bucket by heating source, using the SAME EM_SP_DEFAULTS buckets the Equipment Matrix export
  // itself falls back to for an unclassified zone, keyed the same way _emDeriveHeatingType keys
  // its own unknown-zone fallback (hasGas === false -> electricReheat, otherwise hydronic).
  if (out.newHeatUnocc.value == null || out.newCoolUnocc.value == null) {
    const bucket =
      typeof EM_SP_DEFAULTS !== 'undefined'
        ? EM_SP_DEFAULTS.unocc[hasGas === false ? 'electricReheat' : 'hydronic']
        : { heat: 55, cool: 85 };
    if (out.newHeatUnocc.value == null)
      out.newHeatUnocc = { value: bucket.heat, source: 'company standard', isDefault: false };
    if (out.newCoolUnocc.value == null)
      out.newCoolUnocc = { value: bucket.cool, source: 'company standard', isDefault: false };
  }

  return out;
}

// Parses a plain 24-hour "H:MM" clock string (the format _emFormatClockFromMinutes /
// emBuildSetpointExportRows produce, e.g. "6:00", "15:05") into a decimal hour number for the
// BAS Savings Calc's 0-24 schedule number inputs. Returns null for '?' or anything unparsable —
// never guesses.
function _chParseClockHM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10),
    mm = parseInt(m[2], 10);
  if (isNaN(hh) || isNaN(mm)) return null;
  return Math.round((hh + mm / 60) * 100) / 100;
}

/* chIsLegacyCalcPlaceholderSave(bc) -> true when every one of the 22 Existing/Proposed
   Conditions fields in bc exactly equals the old BAS Savings Calc Excel template's placeholder
   values (55/70/70/60 existing, 50/85/60/55 proposed, OA shutoff no/yes, schedule 0-24 all week
   existing, 5-21 weekdays / 6-19 Sat & Sun proposed — the exact set a project saved before the
   company-standard-defaults feature existed, and the exact set reported 2026-09-23 on Spring
   Hill Schools / Woodland Spring Middle). This is never a real user edit — nobody would type
   this exact 22-value combination by hand — so callers should treat it as "not user-entered" and
   let autofill/company-standard resolution run instead of treating it as a protected override.
   Requires ALL 22 fields present and exactly equal; a partial or empty bc never matches (that
   already resolves correctly via chResolveCalcField's normal hasSaved-false path). */
const CH_LEGACY_CALC_PLACEHOLDERS = {
  exCoolOcc: 55,
  exCoolUnocc: 70,
  exHeatOcc: 70,
  exHeatUnocc: 60,
  exOAShutoff: 'no',
  exMfOn: 0,
  exMfOff: 24,
  exSatOn: 0,
  exSatOff: 24,
  exSunOn: 0,
  exSunOff: 24,
  newCoolOcc: 50,
  newCoolUnocc: 85,
  newHeatOcc: 60,
  newHeatUnocc: 55,
  newOAShutoff: 'yes',
  newMfOn: 5,
  newMfOff: 21,
  newSatOn: 6,
  newSatOff: 19,
  newSunOn: 6,
  newSunOff: 19,
};
function chIsLegacyCalcPlaceholderSave(bc) {
  if (!bc) return false;
  return Object.keys(CH_LEGACY_CALC_PLACEHOLDERS).every(
    (k) => bc[k] !== undefined && bc[k] == CH_LEGACY_CALC_PLACEHOLDERS[k],
  );
}

/* chResolveCalcField(savedValue, shippedDefault, autoResult, touchedFields, field) -> {value, hint}
   Shared per-field precedence rule used by any calc template that renders an
   autofill-eligible input: a real prior user edit always wins — either the field was
   explicitly touched this session (touchedFields is a Set/array of field names), or the
   saved value differs from the shipped default (evidence a human typed something,
   even from before this feature existed). Otherwise autofill wins when available;
   otherwise the shipped default is used and flagged so the user knows it isn't real
   building data. hint is null for a real user value, 'from <source>' for an
   autofilled value, or 'default — not from building data' otherwise. */
function chResolveCalcField(savedValue, shippedDefault, autoResult, touchedFields, field) {
  // Duck-typed, not `instanceof Set` — a Set built in a different vm/realm than this
  // function runs in (e.g. the Node test harness) fails instanceof but still has .has().
  const touched =
    touchedFields && typeof touchedFields.has === 'function'
      ? touchedFields.has(field)
      : Array.isArray(touchedFields) && touchedFields.includes(field);
  const hasSaved = savedValue !== undefined && savedValue !== null && savedValue !== '';
  const savedIsCustom = hasSaved && savedValue != shippedDefault;
  if (touched || savedIsCustom) {
    return { value: hasSaved ? savedValue : shippedDefault, hint: null };
  }
  if (autoResult && !autoResult.isDefault) {
    return { value: autoResult.value, hint: 'from ' + autoResult.source };
  }
  return { value: hasSaved ? savedValue : shippedDefault, hint: 'default — not from building data' };
}

/* chCalcFieldHintHTML(hint) -> small marker shown under a calc input: green "✓ from
   <source>" for autofilled fields, dim "default — not from building data" otherwise.
   Empty string (no marker) when hint is null (a real user value). */
function chCalcFieldHintHTML(hint) {
  if (!hint) return '';
  const isAuto = hint.indexOf('from ') === 0;
  return `<div style="font-size:9px;color:${isAuto ? 'var(--em)' : 'var(--text3)'};margin-top:2px">${isAuto ? '✓ ' : ''}${hint}</div>`;
}
