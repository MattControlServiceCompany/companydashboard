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
   }
   Every key is always present. isDefault:true means nothing was found for that
   field — callers should show the shipped default and flag it, not treat it as
   real building data. Pure lookup, never mutates anything — safe to call on
   every render. */
function chCalcAutofillFields(projId, bldgId) {
  const mkDefault = () => ({ value: null, source: 'default', isDefault: true });
  const out = {
    sqft: mkDefault(),
    heatSrc: mkDefault(),
    exCoolOcc: mkDefault(),
    exCoolUnocc: mkDefault(),
    exHeatOcc: mkDefault(),
    exHeatUnocc: mkDefault(),
  };
  if (!bldgId || typeof projects === 'undefined') return out;
  const p = projects.find((x) => x.id === projId);
  if (!p) return out;

  const bldg = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (bldg) {
    if (bldg.sqft && parseFloat(bldg.sqft) > 0) {
      out.sqft = { value: parseFloat(bldg.sqft), source: 'building record', isDefault: false };
    }

    const meters = bldg.meters || [];
    const hasGas = meters.some((m) => m.commodity === 'Gas');
    const hasElec = meters.some((m) => m.commodity === 'Electric');
    if (hasGas && hasElec) {
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

  return out;
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
