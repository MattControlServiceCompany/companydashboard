/* ══════════════════════════════════════════════════════
         HVAC LOAD ESTIMATION — Per-Building with Reverse Utility Analysis
      ══════════════════════════════════════════════════════ */
let _hvlSelBldg = {}; // track selected building per project
let _hvlMethod = {}; // track selected method per project-building
let _hvlRevData = {}; // reverse utility analysis data per project-building
let _hvlDirty = {}; // unsaved-changes flag per project (autocalculate, 2026-09-22)

const EQUIP_TYPES = [
  'Interior Lighting',
  'Exterior Lighting',
  'Cooling',
  'Electric Heating',
  'Ventilation Fans',
  'Pumps',
  'Plug Loads',
  'Generic Elect. Equipment',
];
const GAS_EQUIP_TYPES = ['Gas Heating', 'Domestic Hot Water', 'Kitchen Equipment', 'Other Gas'];
const EQUIP_UNITS = ['Watts', 'kW', 'Hp'];
const GAS_EQUIP_UNITS = ['Btu/hr', 'BHp', 'lbs/hr', 'MMBtu/hr'];
const MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _hvlKey(projId, bldgId) {
  return projId + '_' + bldgId;
}

function _getRevData(projId, bldgId) {
  const k = _hvlKey(projId, bldgId);
  if (!_hvlRevData[k])
    _hvlRevData[k] = {
      equipment: [],
      gasEquipment: [],
      heatingMonths: [0, 1, 2, 3, 10, 11],
      coolingMonths: [4, 5, 6, 7, 8, 9],
    };
  // Also persist in project data
  const p = projects.find((x) => x.id === projId);
  if (p) {
    if (!p.hvacRevData) p.hvacRevData = {};
    if (p.hvacRevData[bldgId]) {
      _hvlRevData[k] = p.hvacRevData[bldgId];
    }
  }
  return _hvlRevData[k];
}

function _saveRevData(projId, bldgId) {
  const k = _hvlKey(projId, bldgId);
  const p = projects.find((x) => x.id === projId);
  if (p) {
    if (!p.hvacRevData) p.hvacRevData = {};
    p.hvacRevData[bldgId] = _hvlRevData[k];
    sset('en_projects', projects);
  }
}

function initHvacLoadTab(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const wrap = document.getElementById('hvl-container-' + projId);
  if (!wrap) return;
  const bldgs = getUDBldgs(projId);
  if (!_hvlSelBldg[projId] && bldgs.length) _hvlSelBldg[projId] = bldgs[0].id;
  const selBid = _hvlSelBldg[projId];
  const selBldg = bldgs.find((b) => b.id === selBid);

  // Building selector bar
  const bldgPills = bldgs
    .map((b) => {
      const active = b.id === selBid;
      return `<button class="ptpill${active ? ' sel' : ''}" onclick="_hvlSelectBldg(${projId},'${b.id}')" style="${active ? 'background:var(--accent-dim);border-color:var(--accent);color:var(--accent)' : ''}">
            ${b.name || 'Building'} ${b.sqft ? '<span style=\"font-size:10px;opacity:.7\">(' + Number(b.sqft).toLocaleString() + ' sf)</span>' : ''}
          </button>`;
    })
    .join('');

  if (!bldgs.length) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">
            No buildings in Utility Data for this project yet.<br>Add buildings and meters in the <strong style="color:var(--accent)">Utility Data</strong> tab.
          </div>`;
    return;
  }

  const method = _hvlMethod[_hvlKey(projId, selBid)] || 'thumb';

  wrap.innerHTML = `
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0">
            <span style="font-size:13px;font-weight:700;color:var(--text)">🌡️ HVAC Load Estimation</span>
            <span style="font-size:11px;color:var(--text3)">Building:</span>
            <div style="display:flex;gap:4px;flex-wrap:wrap">${bldgPills}</div>
            <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
              <span id="hvl-savedts-${projId}" style="font-size:11px;color:var(--text3)">${p.hvacLoadSavedAt ? 'Last saved: ' + new Date(p.hvacLoadSavedAt).toLocaleString() : 'Not saved yet'}</span>
              <span id="hvl-unsaved-${projId}" style="font-size:11px;color:var(--warn);display:none">● Unsaved changes</span>
              <button class="btn btn-em btn-sm" onclick="hvacLoadSave(${projId})">💾 Save</button>
            </div>
          </div>
          <div style="padding:16px;overflow-y:auto;flex:1;min-height:0">
            <div id="hvl-baseline-summary-${projId}" style="margin-bottom:16px"></div>
            <div class="card" style="margin-bottom:16px">
              <div class="card-hdr"><span class="card-title">Method</span></div>
              <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-sm hvl-method-btn${method === 'thumb' ? ' active' : ''}" onclick="hvacLoadMethod(${projId},'thumb',this)">📐 Rules of Thumb</button>
                <button class="btn btn-sm hvl-method-btn${method === 'benchmark' ? ' active' : ''}" onclick="hvacLoadMethod(${projId},'benchmark',this)">📊 Building Benchmark</button>
                <button class="btn btn-sm hvl-method-btn${method === 'nameplate' ? ' active' : ''}" onclick="hvacLoadMethod(${projId},'nameplate',this)">🔧 Nameplate Data</button>
                <button class="btn btn-sm hvl-method-btn${method === 'reverse' ? ' active' : ''}" onclick="hvacLoadMethod(${projId},'reverse',this)">📊 Reverse Utility Analysis</button>
              </div>
            </div>
            <div id="hvl-method-content-${projId}"></div>
            <div id="hvl-results-${projId}"></div>
          </div>`;

  // Render baseline summary for selected building
  _hvlRenderBaselineSummary(projId, selBldg);
  // Render method content (restores any previously saved raw inputs for this building/method)
  _hvlRenderMethod(projId, selBid, method);

  // Autocalculate (2026-09-22): outputs recompute from the stored/restored inputs whenever the
  // tab opens, with no Calculate click required. Wire a delegated input/change listener ONCE per
  // container so every future edit also recomputes live; only user edits (not the initial render)
  // mark the unsaved-changes indicator.
  if (!wrap._hvlWired) {
    const _hvlOnEdit = (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('hvl-in')) _hvlMarkDirtyAndCalc(projId);
    };
    wrap.addEventListener('input', _hvlOnEdit);
    wrap.addEventListener('change', _hvlOnEdit);
    wrap._hvlWired = true;
  }
  if (method !== 'reverse') {
    requestAnimationFrame(() => hvacLoadCalc(projId, { persist: false }));
  }
}

// Live recompute on every input edit (autocalculate, 2026-09-22) — marks the unsaved-changes
// indicator; the Save button is the only thing that writes to storage.
function _hvlMarkDirtyAndCalc(projId) {
  _hvlDirty[projId] = true;
  const dot = document.getElementById('hvl-unsaved-' + projId);
  if (dot) dot.style.display = '';
  const method = _hvlSelBldg[projId] ? _hvlMethod[_hvlKey(projId, _hvlSelBldg[projId])] || 'thumb' : 'thumb';
  if (method !== 'reverse') hvacLoadCalc(projId, { persist: false });
}

function _hvlUpdateSaveUI(projId) {
  const p = projects.find((x) => x.id === projId);
  const ts = document.getElementById('hvl-savedts-' + projId);
  if (ts)
    ts.textContent =
      p && p.hvacLoadSavedAt ? 'Last saved: ' + new Date(p.hvacLoadSavedAt).toLocaleString() : 'Not saved yet';
  const dot = document.getElementById('hvl-unsaved-' + projId);
  if (dot) dot.style.display = 'none';
}

/* ── Persist / restore raw method inputs across Save + reload (2026-09-22) ── */
function _hvlPrefix(method) {
  return method === 'thumb' ? 'hvl-t-' : method === 'benchmark' ? 'hvl-b-' : method === 'nameplate' ? 'hvl-n-' : '';
}
function _hvlFieldsFor(method) {
  if (method === 'thumb') return ['kwhPct', 'coolKwhPct', 'heatKwhPct', 'kwPct', 'gasPct'];
  if (method === 'benchmark') return ['type', 'climate', 'kwhPct', 'kwPct', 'gasPct'];
  if (method === 'nameplate')
    return [
      'coolTons',
      'coolKwTon',
      'coolEFLH',
      'heatMBH',
      'heatEff',
      'heatEFLH',
      'heatFuel',
      'lightW',
      'lightHrs',
      'plugW',
      'plugHrs',
      'otherKwh',
      'otherGas',
    ];
  return [];
}
function _hvlCaptureInputs(projId, method) {
  const prefix = _hvlPrefix(method);
  const out = {};
  _hvlFieldsFor(method).forEach((f) => {
    const el = document.getElementById(`${prefix}${f}-${projId}`);
    if (el) out[f] = el.value;
  });
  return out;
}
function _hvlRestoreInputs(projId, bldgId, method) {
  const p = projects.find((x) => x.id === projId);
  const saved = p && p.hvacLoadInputs && p.hvacLoadInputs[bldgId] && p.hvacLoadInputs[bldgId][method];
  if (!saved) return;
  const prefix = _hvlPrefix(method);
  if (method === 'benchmark') {
    if (saved.type != null) {
      const el = document.getElementById(`hvl-b-type-${projId}`);
      if (el) el.value = saved.type;
    }
    if (saved.climate != null) {
      const el = document.getElementById(`hvl-b-climate-${projId}`);
      if (el) el.value = saved.climate;
    }
    if (saved.type) hvacLoadBenchFill(projId);
  }
  _hvlFieldsFor(method).forEach((f) => {
    if (f === 'type' || f === 'climate') return;
    if (saved[f] == null) return;
    const el = document.getElementById(`${prefix}${f}-${projId}`);
    if (el) el.value = saved[f];
  });
}

function _hvlSelectBldg(projId, bldgId) {
  _hvlSelBldg[projId] = bldgId;
  initHvacLoadTab(projId);
}

// _hvlMonthlyBaseline — single source of truth for a building's per-month baseline data
// (wraps getNormRows + buildMoMap, the same helpers getMeterBaselineTotals uses). Every HVAC
// Load Estimation reader (the Baseline Data table and the Load Breakdown Results kW/kWh/Therms
// rows) must call this instead of re-deriving monthly totals independently, so a "TOTAL" row is
// always the sum of these monthly values — never a separately-computed peak (2026-09-22 fix).
function _hvlMonthlyBaseline(projId, b) {
  const meters = (b && b.meters) || [];
  const elecM = meters.find((m) => m.commodity === 'Electric');
  const gasM = meters.find((m) => m.commodity === 'Gas');
  const propaneM = meters.find((m) => m.commodity === 'Propane');
  const _wxByYm = typeof getWeatherForBuilding === 'function' && projId ? getWeatherForBuilding(projId, b.id).byYm : {};
  function _getNormMoMap(meter) {
    if (!meter) return {};
    const bills = (meter.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const incl = meter.inclusive !== false;
    const allRows = typeof getNormRows === 'function' && bills.length ? getNormRows(meter, bills, incl, _wxByYm) : [];
    const bl = meter.baseline || {};
    const blMonths = bl.months || [];
    const blRows = blMonths.length >= 3 ? allRows.filter((r) => blMonths.includes(r.ym)) : allRows.slice(-12);
    if (!blRows.length) return {};
    return typeof buildMoMap === 'function' ? buildMoMap(meter, blRows, bills, incl) : {};
  }
  const eMoMap = _getNormMoMap(elecM);
  const gMoMap = _getNormMoMap(gasM);
  const pMoMap = _getNormMoMap(propaneM);
  return {
    elecM,
    gasM,
    propaneM,
    eByMo: eMoMap.elecByMo || {},
    gByMo: gMoMap.gasByMo || {},
    pByMo: pMoMap.propaneByMo || {},
  };
}

// Company-standard "Space Heating % of Total Gas" default for the Rules-of-Thumb method's
// gasPct input (hvl-t-gasPct) — ONE place, shared by _hvlRenderTraditional's shown default/hint
// text and hvacComputeGasThermsForBuilding's headless BAS Savings Calc autofill (2026-09-23), so
// both always agree — no second copy of "15 vs 80" anywhere else.
// 2026-09-23 (heating-type classifier fix): gasHeat added as a second signal. A building with
// BOTH known gas/hydronic heat (e.g. a central gas boiler + VAV hot-water reheat) AND a small
// amount of known electric heat (e.g. a few standalone electric vestibule unit heaters) is still
// gas-dominant for its overall gas bill allocation — a handful of electric unit heaters does not
// mean the building's gas usage is mostly domestic hot water/kitchen. The 15% "electric building"
// preset only applies when electric heat is present and NO gas/hydronic heat evidence exists at
// all (a genuinely all-electric building).
function _hvlDefaultGasPct(elecHeat, gasHeat) {
  return elecHeat && !gasHeat ? 15 : 80;
}

// Scans a building's Equipment Matrix rows ONCE through the Equipment Matrix's own per-row
// heating-type classifier (_emDeriveHeatingType, app/equipment-matrix.js — read-only, never a
// second classifier, never mutates the matrix) and returns which heating-fuel signals are
// present: { hasElectric, hasGas }. Only rows with a real classification signal (known: true)
// count as evidence; the unclassified fallback bucket never counts. Both
// _hvlBuildingHasElectricHeat and _hvlDefaultGasPct's gas-dominance check read from this ONE scan
// — never two separate re-implementations of the same row loop (2026-09-23).
function _hvlBuildingHeatingSignals(projId, bldgId) {
  const out = { hasElectric: false, hasGas: false };
  if (
    !bldgId ||
    typeof emLoadMatrix !== 'function' ||
    typeof emGetNormalizedPoints !== 'function' ||
    typeof _emDeriveHeatingType !== 'function' ||
    typeof _emNormBldgNameForJoin !== 'function'
  )
    return out;
  const b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return out;
  const data = emLoadMatrix(projId);
  const rows = (data && data.rows) || [];
  if (!rows.length) return out;
  const wantName = _emNormBldgNameForJoin(b.name);
  const hasGasMeter = b.meters && b.meters.length ? b.meters.some((m) => m.commodity === 'Gas') : undefined;
  rows.forEach((row) => {
    if (_emNormBldgNameForJoin(row.building || '') !== wantName) return;
    const pts = emGetNormalizedPoints(row) || {};
    const ht = _emDeriveHeatingType(row, pts, hasGasMeter);
    if (!ht.known) return;
    if (ht.key === 'electricReheat' || ht.key === 'heatpump' || ht.key === 'electric') out.hasElectric = true;
    if (ht.key === 'hydronic') out.hasGas = true;
  });
  return out;
}

// Whether this building has at least one Equipment Matrix row classified — with a real signal,
// not the unclassified fallback bucket — as electric heat (electric reheat, standalone electric
// unit heater, or heat pump/VRF). Replaces the old p.heatType signal (a free-text project-level
// field set only via a rarely-used modal, so it is essentially never populated) which is why a
// building with a real electric-heat unit, like Spring Hill Schools / Woodland Spring Middle, was
// showing "0% electric heating share" even though Equipment Matrix data for it exists (2026-09-23
// fix — see docs/dashboardlogic.md).
function _hvlBuildingHasElectricHeat(projId, bldgId) {
  return _hvlBuildingHeatingSignals(projId, bldgId).hasElectric;
}

// _hvlGasHeatShare — the ONE computation of a building's gas heating share, used by BOTH the
// HVAC Load Estimation "Rules of Thumb" tab's "Space Heating % of Total Gas" default
// (_hvlRenderTraditional) and the BAS Savings Calc's Existing Heating Gas Therms autofill
// (hvacComputeGasThermsForBuilding). Prefers the real, data-driven 3-lowest-month baseload
// subtraction method (computeHvacEnduse, computations/hvac-enduse.js — the SAME canonical
// function the Energy Graphics tab's HVAC End-Use Estimate card already uses) computed from this
// building's own monthly gas (+ propane, gallon-equivalent) bills via _hvlMonthlyBaseline (the
// same reader every other HVAC Load Est number uses). Falls back to the Rules-of-Thumb
// industry-standard percentage default (_hvlDefaultGasPct) only when there is not enough real
// bill history (fewer than 6 populated calendar months) to compute a baseload split — never a
// second, independent re-implementation of either method (2026-09-23 single-source fix; replaces
// the fixed 80%/15% default that previously applied unconditionally even with a full year of
// bills on file).
function _hvlGasHeatShare(projId, bldgId) {
  const sig = _hvlBuildingHeatingSignals(projId, bldgId);
  const fallbackPct = _hvlDefaultGasPct(sig.hasElectric, sig.hasGas);
  const b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return { pct: fallbackPct, source: 'default', totalGas: 0, heatingTherms: 0 };
  const { gByMo, pByMo } = _hvlMonthlyBaseline(projId, b);
  const gasArr = [];
  let totalGas = 0;
  for (let mo = 0; mo < 12; mo++) {
    const hasG = !!gByMo[mo];
    const hasP = !!pByMo[mo];
    let v = null;
    // gal -> therms, same 0.9153 factor hvacLoadCalc uses
    if (hasG || hasP) v = (hasG ? gByMo[mo].therms || 0 : 0) + (hasP ? (pByMo[mo].gallons || 0) * 0.9153 : 0);
    gasArr.push(v);
    if (v != null) totalGas += v;
  }
  const enduse = typeof computeHvacEnduse === 'function' ? computeHvacEnduse(null, null, gasArr) : null;
  if (enduse && enduse.gasValid && totalGas > 0) {
    return {
      pct: Math.round(enduse.heatingPct * 1000) / 10,
      source: 'baseload',
      totalGas,
      heatingTherms: enduse.heatingTherms,
    };
  }
  return { pct: fallbackPct, source: 'default', totalGas, heatingTherms: totalGas * (fallbackPct / 100) };
}

// Existing Heating Gas Therms for the BAS Savings Calc (calHeatGas), computed directly from this
// building's own gas (plus propane, gallon-equivalent) bills via the shared _hvlGasHeatShare
// (2026-09-23) — so this fills the BAS Savings Calc's calibration field without requiring a user
// to have opened the HVAC Load Estimation tab first. Returns null when the building has no
// gas/propane bills at all — never invents a number. A real SAVED HVAC Load Estimation for this
// project (p.hvacLoadEst + p.hvacLoadSavedAt) is preferred over this fresh estimate by the caller
// (openBASCalc) — this is only the fallback for a building nobody has reviewed in that tab yet.
function hvacComputeGasThermsForBuilding(projId, bldgId) {
  const b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return null;
  const share = _hvlGasHeatShare(projId, bldgId);
  if (share.totalGas <= 0) return null;
  return { totalGas: share.totalGas, hvacGasPct: share.pct, hvacGasT: share.heatingTherms, source: share.source };
}

// Existing Cooling kWh for the BAS Savings Calc (calCoolKwh), computed directly from this
// building's own electric bills via computeHvacEnduse (computations/hvac-enduse.js — the SAME
// 3-lowest-month baseload subtraction method _hvlGasHeatShare already uses for gas, and the SAME
// function the Energy Graphics HVAC End-Use Estimate card uses) — so this fills the BAS Savings
// Calc's calibration field without requiring a user to have opened the HVAC Load Estimation tab
// and clicked Save first (2026-09-24 fix; mirrors hvacComputeGasThermsForBuilding, which already
// got this same treatment on 2026-09-23 — this field had no fresh-compute fallback at all until
// now, so it always showed "Default value (not from building data)" for a building nobody had
// reviewed in that tab yet, even when the building has a full year of its own electric bills, as
// reported for Spring Hill Schools / Woodland Spring Middle). Returns null when the building has
// fewer than 6 populated calendar months of electric bill history — never invents a number. A
// real SAVED HVAC Load Estimation for this project (p.hvacLoadEst + p.hvacLoadSavedAt) is
// preferred over this fresh estimate by the caller (openBASCalc), same precedence as the gas
// fallback.
function hvacComputeElecCoolKwhForBuilding(projId, bldgId) {
  const b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return null;
  const { eByMo } = _hvlMonthlyBaseline(projId, b);
  const kwhArr = [];
  for (let mo = 0; mo < 12; mo++) kwhArr.push(eByMo[mo] ? eByMo[mo].kwh || 0 : null);
  const enduse = typeof computeHvacEnduse === 'function' ? computeHvacEnduse(kwhArr, null, null) : null;
  if (!enduse || !enduse.elecValid || !(enduse.coolingKwh > 0)) return null;
  return { coolingKwh: enduse.coolingKwh, source: 'baseload' };
}

function _buildBaselineDataHtml(b, projId) {
  if (!b) return '';
  const sqft = parseInt(b.sqft) || 0;
  const { elecM, gasM, propaneM, eByMo, gByMo, pByMo } = _hvlMonthlyBaseline(projId, b);

  // Detect whether Billed kW / Facilities kW data exists
  const hasBilledKW = Object.values(eByMo).some((v) => (v.billedKW || 0) > 0);
  const hasFacKW = Object.values(eByMo).some((v) => (v.facKW || 0) > 0);
  let totKwh = 0,
    totKw = 0,
    totBilledKW = 0,
    totFacKW = 0,
    totKwCost = 0,
    totKwhCost = 0,
    totElecCost = 0;
  let totTherms = 0,
    totGasCost = 0;
  let totPropGal = 0,
    totPropCost = 0;
  let kwMonths = 0;
  MO_SHORT.forEach((_, i) => {
    const eb = eByMo[i];
    if (eb) {
      totKwh += eb.kwhPredicted || 0;
      const kwVal = eb.demandKW || 0;
      if (kwVal > 0) {
        totKw += kwVal;
        kwMonths++;
      }
      totBilledKW += eb.billedKW || 0;
      totFacKW += eb.facKW || 0;
      totKwCost += eb.kwCost || 0;
      totKwhCost += eb.energyCost || 0;
      totElecCost += eb.totalCost || 0;
    }
    const gb = gByMo[i];
    if (gb) {
      totTherms += gb.thermsPredicted || 0;
      totGasCost += gb.cost || 0;
    }
    const pb = pByMo[i];
    if (pb) {
      totPropGal += pb.gallons || 0;
      totPropCost += pb.cost || 0;
    }
  });
  if (totKwh === 0 && totTherms === 0 && totPropGal === 0) return '';
  const $c = (n) =>
    n > 0 ? '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  return `<div class="card">
          <div class="card-hdr"><span class="card-title">📊 Baseline Data — ${b.name || 'Building'}</span>
            <span style="font-size:11px;color:var(--text3);margin-left:auto">${sqft ? Number(sqft).toLocaleString() + ' sq ft' : 'No sq ft set'}</span>
          </div>
          <div style="overflow-x:auto">
            <table class="dtbl" style="min-width:900px;font-size:12px">
              <thead>
                <tr>
                  <th style="width:80px">Month</th>
                  ${elecM ? '<th style="text-align:right">Normalized kWh</th><th style="text-align:right">Actual kW</th>' + (hasBilledKW ? '<th style="text-align:right">Billed kW</th>' : '') + (hasFacKW ? '<th style="text-align:right">Facilities kW</th>' : '') + '<th style="text-align:right">kW Cost</th><th style="text-align:right">kWh Cost</th><th style="text-align:right">Electric Cost</th><th style="text-align:right">Average $/kWh</th><th style="text-align:right">Average $/kW</th><th style="text-align:right">Load Factor</th>' : ''}
                  ${gasM ? '<th style="border-left:2px solid var(--border2);text-align:right">Therms</th><th style="text-align:right">Average $/Therm</th><th style="text-align:right">Gas Cost</th>' : ''}
                  ${propaneM ? '<th style="border-left:2px solid var(--border2);text-align:right">Propane Gal</th><th style="text-align:right">Average $/Gal</th><th style="text-align:right">Propane Cost</th>' : ''}
                  <th style="text-align:right;border-left:2px solid var(--border2)">Total Utility</th>
                </tr>
              </thead>
              <tbody>
                ${MO_SHORT.map((mo, i) => {
                  const eb = eByMo[i] || {};
                  const gb = gByMo[i] || {};
                  const pb = pByMo[i] || {};
                  const kwh = eb.kwhPredicted || 0; // Norm kWh column — weather-normalized, not billed
                  const kw = eb.demandKW || 0;
                  const bilKW = eb.billedKW || 0;
                  const facKW = eb.facKW || 0;
                  const kwCost = eb.kwCost || 0;
                  const kwhCost = eb.energyCost || 0;
                  const eCost = eb.totalCost || 0;
                  const avgKwh = kwh > 0 && kwhCost > 0 ? kwhCost / kwh : 0;
                  const avgKw = kw > 0 && kwCost > 0 ? kwCost / kw : 0;
                  const days = eb.normDays || 30;
                  const lf = kw > 0 && kwh > 0 ? kwh / (kw * 24 * days) : 0;
                  const therms = gb.thermsPredicted || 0;
                  const gCost = gb.cost || 0;
                  const avgTherm = therms > 0 && gCost > 0 ? gCost / therms : 0;
                  const propGal = pb.gallons || 0;
                  const pCost = pb.cost || 0;
                  const avgPropGal = propGal > 0 && pCost > 0 ? pCost / propGal : 0;
                  const moTotal = eCost + gCost + pCost;
                  return (
                    '<tr>' +
                    '<td style="font-weight:600">' +
                    mo +
                    '</td>' +
                    (elecM
                      ? '<td style="text-align:right;font-family:var(--mono)">' +
                        (kwh ? Math.round(kwh).toLocaleString() : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono)">' +
                        (kw ? kw.toFixed(1) : '—') +
                        '</td>' +
                        (hasBilledKW
                          ? '<td style="text-align:right;font-family:var(--mono)">' +
                            (bilKW ? bilKW.toFixed(1) : '—') +
                            '</td>'
                          : '') +
                        (hasFacKW
                          ? '<td style="text-align:right;font-family:var(--mono)">' +
                            (facKW ? facKW.toFixed(1) : '—') +
                            '</td>'
                          : '') +
                        '<td style="text-align:right;font-family:var(--mono)">' +
                        (kwCost ? $c(kwCost) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono)">' +
                        (kwhCost ? $c(kwhCost) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-weight:600">' +
                        (eCost ? $c(eCost) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-size:11px">' +
                        (avgKwh ? '$' + avgKwh.toFixed(4) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-size:11px">' +
                        (avgKw ? '$' + avgKw.toFixed(2) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-size:11px">' +
                        (lf ? (lf * 100).toFixed(1) + '%' : '—') +
                        '</td>'
                      : '') +
                    (gasM
                      ? '<td style="border-left:2px solid var(--border2);text-align:right;font-family:var(--mono)">' +
                        (therms ? Math.round(therms).toLocaleString() : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-size:11px">' +
                        (avgTherm ? '$' + avgTherm.toFixed(3) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-weight:600">' +
                        (gCost ? $c(gCost) : '—') +
                        '</td>'
                      : '') +
                    (propaneM
                      ? '<td style="border-left:2px solid var(--border2);text-align:right;font-family:var(--mono)">' +
                        (propGal ? Math.round(propGal).toLocaleString() : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-size:11px">' +
                        (avgPropGal ? '$' + avgPropGal.toFixed(3) : '—') +
                        '</td>' +
                        '<td style="text-align:right;font-family:var(--mono);font-weight:600">' +
                        (pCost ? $c(pCost) : '—') +
                        '</td>'
                      : '') +
                    '<td style="text-align:right;font-family:var(--mono);font-weight:700;border-left:2px solid var(--border2)">' +
                    (moTotal > 0 ? $c(moTotal) : '—') +
                    '</td>' +
                    '</tr>'
                  );
                }).join('')}
                <tr style="border-top:2px solid var(--border2);font-weight:800">
                  <td>TOTAL</td>
                  ${
                    elecM
                      ? `<td style="text-align:right;font-family:var(--mono)">${totKwh ? Math.round(totKwh).toLocaleString() : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono)">${totKw ? totKw.toFixed(1) : '—'}</td>
                  ${hasBilledKW ? `<td style="text-align:right;font-family:var(--mono)">${totBilledKW ? totBilledKW.toFixed(1) : '—'}</td>` : ''}
                  ${hasFacKW ? `<td style="text-align:right;font-family:var(--mono)">${totFacKW ? totFacKW.toFixed(1) : '—'}</td>` : ''}
                  <td style="text-align:right;font-family:var(--mono)">${totKwCost ? $c(totKwCost) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono)">${totKwhCost ? $c(totKwhCost) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--em)">${totElecCost ? $c(totElecCost) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);font-size:11px">${totKwh > 0 && totKwhCost > 0 ? '$' + (totKwhCost / totKwh).toFixed(4) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);font-size:11px">${totKw > 0 && totKwCost > 0 ? '$' + (totKwCost / totKw).toFixed(2) : '—'}</td>
                  <td></td>`
                      : ''
                  }
                  ${
                    gasM
                      ? `<td style="border-left:2px solid var(--border2);text-align:right;font-family:var(--mono)">${totTherms ? Math.round(totTherms).toLocaleString() : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);font-size:11px">${totTherms > 0 && totGasCost > 0 ? '$' + (totGasCost / totTherms).toFixed(3) : '—'}</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--em)">${totGasCost ? $c(totGasCost) : '—'}</td>`
                      : ''
                  }
                  ${propaneM ? '<td style="border-left:2px solid var(--border2);text-align:right;font-family:var(--mono)">' + (totPropGal ? Math.round(totPropGal).toLocaleString() : '—') + '</td><td style="text-align:right;font-family:var(--mono);font-size:11px">' + (totPropGal > 0 && totPropCost > 0 ? '$' + (totPropCost / totPropGal).toFixed(3) : '—') + '</td><td style="text-align:right;font-family:var(--mono);color:var(--em)">' + (totPropCost ? $c(totPropCost) : '—') + '</td>' : ''}
                  <td style="text-align:right;font-family:var(--mono);font-weight:700;color:var(--em);border-left:2px solid var(--border2)">${totElecCost + totGasCost + totPropCost > 0 ? $c(totElecCost + totGasCost + totPropCost) : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          ${
            sqft > 0 && (totKwh > 0 || totTherms > 0 || totPropGal > 0)
              ? '<div style="padding:8px 16px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text2)">' +
                (totKwh > 0
                  ? '<span>kWh/sf: <strong style="color:var(--accent)">' +
                    (totKwh / sqft).toFixed(1) +
                    '</strong></span>'
                  : '') +
                '<span>kBtu/sf: <strong style="color:var(--em)">' +
                (toKBtu(totKwh, totTherms, totPropGal) / sqft).toFixed(1) +
                '</strong></span>' +
                '<span>$/sf: <strong style="color:var(--green)">' +
                (totElecCost + totGasCost + totPropCost > 0
                  ? ((totElecCost + totGasCost + totPropCost) / sqft).toFixed(2)
                  : '—') +
                '</strong></span>' +
                (totTherms > 0
                  ? '<span>Therms/sf: <strong style="color:var(--teal)">' +
                    (totTherms / sqft).toFixed(2) +
                    '</strong></span>'
                  : '') +
                (totPropGal > 0
                  ? '<span>Gal/sf: <strong style="color:var(--teal)">' +
                    (totPropGal / sqft).toFixed(2) +
                    '</strong></span>'
                  : '') +
                '</div>'
              : ''
          }
        </div>`;
}

function _hvlRenderBaselineSummary(projId, b) {
  const wrap = document.getElementById('hvl-baseline-summary-' + projId);
  if (!wrap || !b) return;
  wrap.innerHTML = _buildBaselineDataHtml(b, projId);
}

function _hvlRenderMethod(projId, bldgId, method) {
  const wrap = document.getElementById('hvl-method-content-' + projId);
  if (!wrap) return;
  _hvlMethod[_hvlKey(projId, bldgId)] = method;
  if (method === 'reverse') {
    _hvlRenderReverse(projId, bldgId);
  } else {
    _hvlRenderTraditional(projId, bldgId, method);
  }
}

function _hvlRenderTraditional(projId, bldgId, method) {
  const wrap = document.getElementById('hvl-method-content-' + projId);
  if (!wrap) return;
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const b = getUDBldg(projId, bldgId);
  // Electric heat is the exception, not the rule — only treat the building as electric-heated
  // when the Equipment Matrix actually classifies a zone/equipment row that way; everything else
  // (including no Equipment Matrix data at all) defaults to gas heat, which is the typical case
  // for a school. This drives both the electric-heating-% default (0 unless electric heat) and
  // the gas-HVAC-% default/hint below. 2026-09-23: sourced from the Equipment Matrix's own
  // heating-type classification (_hvlBuildingHasElectricHeat) instead of p.heatType (a
  // project-level field that is essentially never set) — see docs/dashboardlogic.md.
  const _hvlHeatSig = _hvlBuildingHeatingSignals(projId, bldgId);
  const _hvlElecHeat = _hvlHeatSig.hasElectric;
  // 2026-09-23: the "Space Heating % of Total Gas" preset only drops to 15% (DHW/kitchen-only)
  // when the building has NO gas/hydronic heat evidence at all — a school with a central gas
  // boiler plus a few electric vestibule unit heaters is still gas-dominant for this field.
  const _hvlGasPctIsLow = _hvlElecHeat && !_hvlHeatSig.hasGas;
  // 2026-09-23: the Space Heating % of Total Gas default now comes from _hvlGasHeatShare — the
  // SAME single computation the BAS Savings Calc's calHeatGas autofill uses — which prefers the
  // real 3-lowest-month baseload subtraction method computed from this building's own bills, and
  // only falls back to the Rules-of-Thumb industry default when there isn't enough bill history.
  const _hvlGasShare = method === 'thumb' ? _hvlGasHeatShare(projId, bldgId) : null;

  if (method === 'thumb') {
    wrap.innerHTML = `<div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">📐 Rules of Thumb — Industry Standard Estimates</span></div>
            <div style="padding:16px">
              <div class="g2" style="gap:12px">
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">⚡ Electric (kWh) Breakdown</div>
                  <div class="fg"><label class="fl">HVAC % of Total kWh</label><input class="fi hvl-in" id="hvl-t-kwhPct-${projId}" type="number" value="45" min="0" max="100" step="1"><div class="fhint">Typical: 30-60% depending on climate & building type</div></div>
                  <div class="fg"><label class="fl">Cooling % of HVAC kWh</label><input class="fi hvl-in" id="hvl-t-coolKwhPct-${projId}" type="number" value="65" min="0" max="100"><div class="fhint">Typical: 55-75%</div></div>
                  <div class="fg"><label class="fl">Heating % of HVAC kWh (electric heat only)</label><input class="fi hvl-in" id="hvl-t-heatKwhPct-${projId}" type="number" value="${_hvlElecHeat ? '35' : '0'}" min="0" max="100"><div class="fhint">${_hvlElecHeat ? 'Typical: 25-45% if electric/heat pump' : "0% — this building's heat is not electric, so electric heating kWh saved is 0"}</div></div>
                </div>
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">⚡ Electric Demand (kW) Breakdown</div>
                  <div class="fg"><label class="fl">HVAC % of Peak kW</label><input class="fi hvl-in" id="hvl-t-kwPct-${projId}" type="number" value="55" min="0" max="100"><div class="fhint">Typical: 40-65% — HVAC is usually the largest demand driver</div></div>
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin:14px 0 10px">🔥 Gas (Therms) Breakdown</div>
                  <div class="fg"><label class="fl">Space Heating % of Total Gas</label><input class="fi hvl-in" id="hvl-t-gasPct-${projId}" type="number" value="${_hvlGasShare.pct}" min="0" max="100"><div class="fhint">${_hvlGasShare.source === 'baseload' ? `✓ computed from gas bills (3-lowest-month baseload method, ${Math.round(_hvlGasShare.totalGas).toLocaleString()} total Therms/yr) — same method as the Energy Graphics HVAC End-Use Estimate` : _hvlGasPctIsLow ? "Rules-of-Thumb default (not enough bill history to compute) — 0-20% typical for DHW/kitchen only, this building's heat is electric" : 'Rules-of-Thumb default (not enough bill history to compute) — 70-95% typical for gas-heated buildings'}</div></div>
                </div>
              </div>
            </div>
          </div>`;
  } else if (method === 'benchmark') {
    wrap.innerHTML = `<div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">📊 Building Type Benchmark — Based on CBECS & Industry Data</span></div>
            <div style="padding:16px">
              <div class="fg"><label class="fl">Building Type</label>
                <select class="fs hvl-in" id="hvl-b-type-${projId}" onchange="hvacLoadBenchFill(${projId})">
                  <option value="">— Select —</option>
                  <option ${p.type === 'K-12 School' ? 'selected' : ''}>K-12 School</option>
                  <option>College / University</option><option>Hospital / Healthcare</option>
                  <option>Office Building</option><option>Warehouse / Industrial</option>
                  <option>Retail</option><option>Municipal / Government</option><option>Data Center</option>
                </select>
              </div>
              <div class="fg"><label class="fl">Climate Zone</label>
                <select class="fs hvl-in" id="hvl-b-climate-${projId}" onchange="hvacLoadBenchFill(${projId})">
                  <option value="4A" selected>4A — Mixed Humid (Kansas City)</option>
                  <option value="1A">1A — Very Hot Humid</option><option value="2A">2A — Hot Humid</option>
                  <option value="3A">3A — Warm Humid</option><option value="3B">3B — Warm Dry</option>
                  <option value="5A">5A — Cool Humid</option><option value="5B">5B — Cool Dry</option>
                  <option value="6A">6A — Cold Humid</option><option value="7">7 — Very Cold</option>
                </select>
              </div>
              <div id="hvl-b-results-${projId}" style="margin-top:12px">
                <div style="font-size:12px;color:var(--text3)">Select building type and climate to load benchmarks</div>
              </div>
            </div>
          </div>`;
    if (p.type) hvacLoadBenchFill(projId);
  } else if (method === 'nameplate') {
    wrap.innerHTML = `<div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">🔧 Nameplate Data — Enter Real Equipment Data</span></div>
            <div style="padding:16px">
              <div class="g2" style="gap:12px">
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">Cooling Equipment</div>
                  <div class="fg"><label class="fl">Total Cooling Capacity (Tons)</label><input class="fi hvl-in" id="hvl-n-coolTons-${projId}" type="number" placeholder="e.g. 66"></div>
                  <div class="fg"><label class="fl">Efficiency (kW/Ton)</label><input class="fi hvl-in" id="hvl-n-coolKwTon-${projId}" type="number" step="0.01" value="${p.coolEff || '0.86'}"></div>
                  <div class="fg"><label class="fl">Estimated EFLH Cooling</label><input class="fi hvl-in" id="hvl-n-coolEFLH-${projId}" type="number" value="1200"><div class="fhint">KC typical: 1000-1400</div></div>
                </div>
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">Heating Equipment</div>
                  <div class="fg"><label class="fl">Total Heating Capacity (MBH)</label><input class="fi hvl-in" id="hvl-n-heatMBH-${projId}" type="number" placeholder="e.g. 595"></div>
                  <div class="fg"><label class="fl">Efficiency (${p.heatType && p.heatType.includes('Gas') ? 'AFUE' : 'COP'})</label><input class="fi hvl-in" id="hvl-n-heatEff-${projId}" type="number" step="0.01" value="${p.heatEff || '0.80'}"></div>
                  <div class="fg"><label class="fl">Estimated EFLH Heating</label><input class="fi hvl-in" id="hvl-n-heatEFLH-${projId}" type="number" value="1600"><div class="fhint">KC typical: 1400-1800</div></div>
                  <div class="fg"><label class="fl">Fuel Type</label>
                    <select class="fs hvl-in" id="hvl-n-heatFuel-${projId}">
                      <option value="gas" ${!p.heatType || p.heatType.includes('Gas') ? 'selected' : ''}>Natural Gas</option>
                      <option value="electric" ${p.heatType && (p.heatType.includes('Electric') || p.heatType.includes('Heat Pump') || p.heatType.includes('VRF')) ? 'selected' : ''}>Electric</option>
                    </select>
                  </div>
                </div>
              </div>
              <div class="card" style="background:var(--s1);padding:14px;margin-top:12px">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">Non-HVAC Loads</div>
                <div class="g2" style="gap:12px">
                  <div class="fg"><label class="fl">Lighting Watt per Square Foot</label><input class="fi hvl-in" id="hvl-n-lightW-${projId}" type="number" step="0.01" value="1.0"><div class="fhint">LED: 0.4-0.8, T8 Fluor: 1.0-1.4</div></div>
                  <div class="fg"><label class="fl">Lighting Hours/Year</label><input class="fi hvl-in" id="hvl-n-lightHrs-${projId}" type="number" value="3000"></div>
                  <div class="fg"><label class="fl">Plug Load Watt per Square Foot</label><input class="fi hvl-in" id="hvl-n-plugW-${projId}" type="number" step="0.01" value="1.5"><div class="fhint">Office: 1-3, School: 0.5-1.5</div></div>
                  <div class="fg"><label class="fl">Plug Load Hours/Year</label><input class="fi hvl-in" id="hvl-n-plugHrs-${projId}" type="number" value="2500"></div>
                </div>
                <div class="fg"><label class="fl">Other Base Electric kWh/Year (DHW, kitchen, etc.)</label><input class="fi hvl-in" id="hvl-n-otherKwh-${projId}" type="number" value="0"></div>
                <div class="fg"><label class="fl">Non-HVAC Gas Therms/Year (DHW, kitchen)</label><input class="fi hvl-in" id="hvl-n-otherGas-${projId}" type="number" value="0"></div>
              </div>
            </div>
          </div>`;
  }
  // Restore any previously saved raw inputs for this building/method (Save persists them)
  _hvlRestoreInputs(projId, bldgId, method);
}

/* ── Reverse Utility Analysis ── */
function _hvlRenderReverse(projId, bldgId) {
  const wrap = document.getElementById('hvl-method-content-' + projId);
  if (!wrap) return;
  const rd = _getRevData(projId, bldgId);
  const b = getUDBldg(projId, bldgId);
  const sqft = parseInt(b?.sqft) || 0;

  // Get actual baseline monthly kW, kWh, therms from bills
  const meters = b?.meters || [];
  const elecM = meters.find((m) => m.commodity === 'Electric');
  const gasM = meters.find((m) => m.commodity === 'Gas');
  const actualKw = Array(12).fill(0),
    actualKwh = Array(12).fill(0),
    actualTherms = Array(12).fill(0);
  const avgKwhRate = Array(12).fill(0),
    avgKwRate = Array(12).fill(0),
    avgThermRate = Array(12).fill(0);
  if (elecM) {
    const allElecBills = (elecM.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const blElecBills = _dashGetBaselineBills(elecM);
    const elecBills = blElecBills.length ? blElecBills : allElecBills;
    const inclElec = elecM.inclusive !== false;
    elecBills.forEach((bill) => {
      const ym = normMonth(bill.start, bill.end, inclElec, allElecBills);
      if (!ym) return;
      const mo = parseInt(ym.split('-')[1]) - 1;
      const kwh = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
      const kw = parseFloat(bill.demandKW) || parseFloat(bill.billedKW) || 0;
      actualKwh[mo] = kwh;
      actualKw[mo] = kw;
      avgKwhRate[mo] = getStoredRate(bill, 'kwh');
      avgKwRate[mo] = getStoredRate(bill, 'kw');
    });
  }
  if (gasM) {
    const allGasBills = (gasM.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const blGasBills = _dashGetBaselineBills(gasM);
    const gasBills = blGasBills.length ? blGasBills : allGasBills;
    const inclGas = gasM.inclusive !== false;
    gasBills.forEach((bill) => {
      const ym = normMonth(bill.start, bill.end, inclGas, allGasBills);
      if (!ym) return;
      const mo = parseInt(ym.split('-')[1]) - 1;
      const therms = resolveGasUsageTherms(bill);
      actualTherms[mo] = therms;
      avgThermRate[mo] = getStoredRate(bill, 'gas');
    });
  }

  // Sub-tab state
  const revTab = rd._activeTab || 'kw';

  wrap.innerHTML = `<div class="card" style="margin-bottom:16px">
          <div class="card-hdr" style="flex-wrap:wrap;gap:8px">
            <span class="card-title">📊 Reverse Utility Analysis — ${b?.name || 'Building'}</span>
            <div style="display:flex;gap:4px;margin-left:auto">
              <button class="ptpill${revTab === 'kw' ? ' sel' : ''}" onclick="_hvlRevTab(${projId},'${bldgId}','kw')">⚡ kW Demand</button>
              <button class="ptpill${revTab === 'kwh' ? ' sel' : ''}" onclick="_hvlRevTab(${projId},'${bldgId}','kwh')">⚡ kWh Energy</button>
              <button class="ptpill${revTab === 'gas' ? ' sel' : ''}" onclick="_hvlRevTab(${projId},'${bldgId}','gas')">🔥 Gas</button>
            </div>
          </div>
          <div style="padding:12px 16px">
            <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
              <span style="font-size:11px;color:var(--text3)">Heating months:</span>
              ${MO_SHORT.map(
                (mo, i) => `<label style="font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer">
                <input type="checkbox" ${rd.heatingMonths.includes(i) ? 'checked' : ''} onchange="_hvlRevToggleSeason(${projId},'${bldgId}','heating',${i},this.checked)">
                ${mo}
              </label>`,
              ).join('')}
            </div>
            <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
              <span style="font-size:11px;color:var(--text3)">Cooling months:</span>
              ${MO_SHORT.map(
                (mo, i) => `<label style="font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer">
                <input type="checkbox" ${rd.coolingMonths.includes(i) ? 'checked' : ''} onchange="_hvlRevToggleSeason(${projId},'${bldgId}','cooling',${i},this.checked)">
                ${mo}
              </label>`,
              ).join('')}
            </div>
            <div id="hvl-rev-content-${projId}"></div>
          </div>
        </div>`;

  _hvlRevRenderTab(projId, bldgId, revTab, actualKw, actualKwh, actualTherms, avgKwRate, avgKwhRate, avgThermRate);
}

function _hvlRevTab(projId, bldgId, tab) {
  const rd = _getRevData(projId, bldgId);
  rd._activeTab = tab;
  _hvlRenderReverse(projId, bldgId);
}

function _hvlRevToggleSeason(projId, bldgId, season, moIdx, checked) {
  const rd = _getRevData(projId, bldgId);
  const arr = season === 'heating' ? rd.heatingMonths : rd.coolingMonths;
  if (checked && !arr.includes(moIdx)) arr.push(moIdx);
  if (!checked) {
    const idx = arr.indexOf(moIdx);
    if (idx >= 0) arr.splice(idx, 1);
  }
  _saveRevData(projId, bldgId);
}

function _hvlRevRenderTab(projId, bldgId, tab, actualKw, actualKwh, actualTherms, avgKwRate, avgKwhRate, avgThermRate) {
  const wrap = document.getElementById('hvl-rev-content-' + projId);
  if (!wrap) return;
  const rd = _getRevData(projId, bldgId);

  if (tab === 'kw') {
    _hvlRevRenderKw(wrap, projId, bldgId, rd, actualKw, avgKwRate);
  } else if (tab === 'kwh') {
    _hvlRevRenderKwh(wrap, projId, bldgId, rd, actualKwh, avgKwhRate, avgKwRate);
  } else {
    _hvlRevRenderGas(wrap, projId, bldgId, rd, actualTherms, avgThermRate);
  }
}

/* ── kW Demand Reverse Tab ── */
function _hvlRevRenderKw(wrap, projId, bldgId, rd, actualKw, avgKwRate) {
  const equip = rd.equipment || [];
  const moHdr = MO_SHORT.map(
    (m, i) => `<th style="text-align:center;width:52px;font-size:10px;border-left:1px solid var(--border)">${m}</th>`,
  ).join('');

  // Calculate totals
  const modeledKw = Array(12).fill(0);
  equip.forEach((eq) => {
    const maxKw = _eqMaxKw(eq);
    const demFactors = eq.demandFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      let contrib = maxKw * (demFactors[i] / 100);
      // Apply seasonal exclusions
      if (eq.type === 'Cooling' && !rd.coolingMonths.includes(i)) contrib = 0;
      if (eq.type === 'Electric Heating' && !rd.heatingMonths.includes(i)) contrib = 0;
      if (eq.demandProfile !== false) modeledKw[i] += contrib;
    }
  });
  const totalActual = actualKw.reduce((s, v) => s + v, 0);
  const totalModeled = modeledKw.reduce((s, v) => s + v, 0);
  const annualMatch = totalActual > 0 ? ((totalModeled / totalActual) * 100).toFixed(1) + '%' : '—';

  // Match % row
  const matchRow = MO_SHORT.map((_, i) => {
    const pct = actualKw[i] > 0 ? (modeledKw[i] / actualKw[i]) * 100 : 0;
    const color = pct >= 90 && pct <= 110 ? 'var(--green)' : pct >= 75 && pct <= 125 ? 'var(--amber)' : 'var(--danger)';
    return `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:${actualKw[i] > 0 ? color : 'var(--text3)'}">${actualKw[i] > 0 ? pct.toFixed(0) + '%' : '—'}</td>`;
  }).join('');

  wrap.innerHTML = `
          <div style="margin-bottom:12px;display:flex;gap:16px;align-items:center">
            <span style="font-size:12px;color:var(--text2)">Annual Match: <strong style="color:var(--em)">${annualMatch}</strong></span>
            <button class="btn btn-ghost btn-sm" onclick="_hvlRevAddEquip(${projId},'${bldgId}')">+ Add Equipment</button>
          </div>
          <div style="overflow-x:auto;margin-bottom:16px">
            <table class="dtbl" style="min-width:1400px;font-size:11px">
              <thead>
                <tr>
                  <th style="width:30px">#</th>
                  <th style="min-width:140px">Equipment Name</th>
                  <th style="min-width:110px">Type</th>
                  <th style="width:40px">Quantity</th>
                  <th style="width:60px">Size</th>
                  <th style="width:60px">Units</th>
                  <th style="width:50px">In kW?</th>
                  <th style="width:60px;text-align:right">Max kW</th>
                  ${moHdr}
                  <th style="width:28px"></th>
                </tr>
              </thead>
              <tbody>
                ${equip
                  .map((eq, idx) => {
                    const maxKw = _eqMaxKw(eq);
                    const df = eq.demandFactors || Array(12).fill(0);
                    const typeOpts = EQUIP_TYPES.map(
                      (t) => `<option${t === eq.type ? ' selected' : ''}>${t}</option>`,
                    ).join('');
                    const unitOpts = EQUIP_UNITS.map(
                      (u) => `<option${u === eq.units ? ' selected' : ''}>${u}</option>`,
                    ).join('');
                    return `<tr>
                    <td style="text-align:center;color:var(--text3)">${idx + 1}</td>
                    <td><input class="sv-msr-txt" style="width:100%" value="${eq.name || ''}" onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'name',this.value)"></td>
                    <td><select class="sv-msr-sel" style="width:100%" onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'type',this.value)">${typeOpts}</select></td>
                    <td><input class="sv-num-inp" type="number" style="width:38px" value="${eq.qty || 1}" onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'qty',parseFloat(this.value)||1)"></td>
                    <td><input class="sv-num-inp" type="number" style="width:56px" step="any" value="${eq.size || ''}" placeholder="0" onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'size',parseFloat(this.value)||0)"></td>
                    <td><select class="sv-msr-sel" style="width:58px" onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'units',this.value)">${unitOpts}</select></td>
                    <td style="text-align:center"><input type="checkbox" ${eq.demandProfile !== false ? 'checked' : ''} onchange="_hvlRevUpdEquip(${projId},'${bldgId}',${idx},'demandProfile',this.checked)"></td>
                    <td style="text-align:right;font-family:var(--mono);font-weight:600">${maxKw.toFixed(1)}</td>
                    ${df.map((v, mi) => `<td style="border-left:1px solid var(--border);padding:1px"><input class="sv-num-inp" type="number" style="width:46px;text-align:center" min="0" max="100" value="${v || ''}" placeholder="0" onchange="_hvlRevUpdDf(${projId},'${bldgId}',${idx},${mi},parseFloat(this.value)||0)"></td>`).join('')}
                    <td><button class="btn-del" onclick="_hvlRevRemEquip(${projId},'${bldgId}',${idx})">✕</button></td>
                  </tr>`;
                  })
                  .join('')}
                ${!equip.length ? `<tr><td colspan="${20}" style="text-align:center;color:var(--text3);padding:16px">No equipment yet — click "+ Add Equipment"</td></tr>` : ''}
              </tbody>
              <tfoot>
                <tr style="font-weight:700;border-top:2px solid var(--border2)">
                  <td colspan="7">MODELED kW</td>
                  <td style="text-align:right;font-family:var(--mono)">${modeledKw.reduce((s, v) => s + v, 0) > 0 ? modeledKw.reduce((s, v) => Math.max(s, v), 0).toFixed(1) : '—'}</td>
                  ${modeledKw.map((v, i) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:var(--accent)">${v > 0 ? v.toFixed(1) : '—'}</td>`).join('')}
                  <td></td>
                </tr>
                <tr style="font-weight:700">
                  <td colspan="7">ACTUAL kW</td>
                  <td></td>
                  ${actualKw.map((v, i) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border)">${v > 0 ? v.toFixed(1) : '—'}</td>`).join('')}
                  <td></td>
                </tr>
                <tr style="font-weight:700">
                  <td colspan="7">MATCH %</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--em)">${annualMatch}</td>
                  ${matchRow}
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          ${_hvlRevKwCostBreakdown(equip, rd, modeledKw, avgKwRate, projId)}`;
}

function _hvlRevKwCostBreakdown(equip, rd, modeledKw, avgKwRate, projId) {
  if (!equip.length) return '';
  // Group by type and calculate kW cost allocation
  const typeKw = {};
  EQUIP_TYPES.forEach((t) => (typeKw[t] = Array(12).fill(0)));
  equip.forEach((eq) => {
    const maxKw = _eqMaxKw(eq);
    const df = eq.demandFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      let contrib = maxKw * (df[i] / 100);
      if (eq.type === 'Cooling' && !rd.coolingMonths.includes(i)) contrib = 0;
      if (eq.type === 'Electric Heating' && !rd.heatingMonths.includes(i)) contrib = 0;
      if (eq.demandProfile !== false) typeKw[eq.type || 'Generic Elect. Equipment'][i] += contrib;
    }
  });
  const usedTypes = EQUIP_TYPES.filter((t) => typeKw[t].some((v) => v > 0));
  if (!usedTypes.length) return '';
  const colors = {
    'Interior Lighting': '#60a5fa',
    'Exterior Lighting': '#a78bfa',
    Cooling: '#34d399',
    'Electric Heating': '#f87171',
    'Ventilation Fans': '#fbbf24',
    Pumps: '#2dd4bf',
    'Plug Loads': '#fb923c',
    'Generic Elect. Equipment': '#94a3b8',
  };
  return `<div class="card" style="margin-bottom:16px">
          <div class="card-hdr"><span class="card-title">💰 kW Cost Allocation by End Use</span></div>
          <div style="overflow-x:auto">
            <table class="dtbl" style="min-width:900px;font-size:11px">
              <thead><tr><th>End Use</th>${MO_SHORT.map((m) => `<th style="text-align:right;font-size:10px">${m}</th>`).join('')}<th style="text-align:right">Annual</th></tr></thead>
              <tbody>
                ${usedTypes
                  .map((t) => {
                    const annualCost = typeKw[t].reduce((s, v, i) => s + v * avgKwRate[i], 0);
                    return `<tr>
                    <td style="font-weight:600"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[t] || '#94a3b8'};margin-right:4px"></span>${t}</td>
                    ${typeKw[t].map((v, i) => `<td style="text-align:right;font-family:var(--mono)">${v * avgKwRate[i] > 0 ? '$' + (v * avgKwRate[i]).toFixed(0) : '—'}</td>`).join('')}
                    <td style="text-align:right;font-family:var(--mono);font-weight:700">${annualCost > 0 ? '$' + Math.round(annualCost).toLocaleString() : '—'}</td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`;
}

/* ── kWh Energy Reverse Tab ── */
function _hvlRevRenderKwh(wrap, projId, bldgId, rd, actualKwh, avgKwhRate, avgKwRate) {
  const equip = rd.equipment || [];
  const moHdr = MO_SHORT.map(
    (m) => `<th style="text-align:center;width:52px;font-size:10px;border-left:1px solid var(--border)">${m}</th>`,
  ).join('');

  const modeledKwh = Array(12).fill(0);
  equip.forEach((eq) => {
    const maxKw = _eqMaxKw(eq);
    const lf = eq.loadFactors || Array(12).fill(0);
    const df = eq.demandFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      // kWh = kW (from demand profile) * (8760/12) * load factor %
      const kw = maxKw * (df[i] / 100);
      const kwh = kw * (8760 / 12) * (lf[i] / 100);
      modeledKwh[i] += kwh;
    }
  });
  const totalActual = actualKwh.reduce((s, v) => s + v, 0);
  const totalModeled = modeledKwh.reduce((s, v) => s + v, 0);
  const annualMatch = totalActual > 0 ? ((totalModeled / totalActual) * 100).toFixed(1) + '%' : '—';

  const matchRow = MO_SHORT.map((_, i) => {
    const pct = actualKwh[i] > 0 ? (modeledKwh[i] / actualKwh[i]) * 100 : 0;
    const color = pct >= 90 && pct <= 110 ? 'var(--green)' : pct >= 75 && pct <= 125 ? 'var(--amber)' : 'var(--danger)';
    return `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:${actualKwh[i] > 0 ? color : 'var(--text3)'}">${actualKwh[i] > 0 ? pct.toFixed(0) + '%' : '—'}</td>`;
  }).join('');

  wrap.innerHTML = `
          <div style="margin-bottom:12px;display:flex;gap:16px;align-items:center">
            <span style="font-size:12px;color:var(--text2)">Annual Match: <strong style="color:var(--em)">${annualMatch}</strong></span>
            <span style="font-size:11px;color:var(--text3)">Enter monthly load factor % — the fraction of max capacity each piece runs</span>
          </div>
          <div style="overflow-x:auto;margin-bottom:16px">
            <table class="dtbl" style="min-width:1300px;font-size:11px">
              <thead>
                <tr>
                  <th style="width:30px">#</th>
                  <th style="min-width:140px">Equipment Name</th>
                  <th style="min-width:100px">Type</th>
                  <th style="width:60px;text-align:right">Max kW</th>
                  <th style="width:60px;text-align:right">Hours</th>
                  <th style="width:50px;text-align:right">% kWh</th>
                  ${moHdr}
                </tr>
                <tr><th colspan="6" style="font-size:10px;color:var(--text3)">Monthly Load Factor %</th>${MO_SHORT.map(() => '<th></th>').join('')}</tr>
              </thead>
              <tbody>
                ${equip
                  .map((eq, idx) => {
                    const maxKw = _eqMaxKw(eq);
                    const lf = eq.loadFactors || Array(12).fill(0);
                    const df = eq.demandFactors || Array(12).fill(0);
                    const annKwh = lf.reduce((s, v, i) => s + maxKw * (df[i] / 100) * (8760 / 12) * (v / 100), 0);
                    const hours = maxKw > 0 ? annKwh / maxKw : 0;
                    const pctOfTotal = totalModeled > 0 ? ((annKwh / totalModeled) * 100).toFixed(1) : '0';
                    return `<tr>
                    <td style="text-align:center;color:var(--text3)">${idx + 1}</td>
                    <td style="font-weight:500">${eq.name || '—'}</td>
                    <td style="font-size:10px;color:var(--text2)">${eq.type || '—'}</td>
                    <td style="text-align:right;font-family:var(--mono)">${maxKw.toFixed(1)}</td>
                    <td style="text-align:right;font-family:var(--mono)">${hours > 0 ? Math.round(hours).toLocaleString() : '—'}</td>
                    <td style="text-align:right;font-family:var(--mono);font-size:10px">${pctOfTotal}%</td>
                    ${lf.map((v, mi) => `<td style="border-left:1px solid var(--border);padding:1px"><input class="sv-num-inp" type="number" style="width:46px;text-align:center" min="0" max="100" value="${v || ''}" placeholder="0" onchange="_hvlRevUpdLf(${projId},'${bldgId}',${idx},${mi},parseFloat(this.value)||0)"></td>`).join('')}
                  </tr>`;
                  })
                  .join('')}
                ${!equip.length ? `<tr><td colspan="${18}" style="text-align:center;color:var(--text3);padding:16px">Add equipment in the kW Demand tab first</td></tr>` : ''}
              </tbody>
              <tfoot>
                <tr style="font-weight:700;border-top:2px solid var(--border2)">
                  <td colspan="6">MODELED kWh</td>
                  ${modeledKwh.map((v, i) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:var(--accent)">${v > 0 ? Math.round(v).toLocaleString() : '—'}</td>`).join('')}
                </tr>
                <tr style="font-weight:700">
                  <td colspan="6">ACTUAL kWh</td>
                  ${actualKwh.map((v) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border)">${v > 0 ? Math.round(v).toLocaleString() : '—'}</td>`).join('')}
                </tr>
                <tr style="font-weight:700">
                  <td colspan="6">MATCH %</td>
                  ${matchRow}
                </tr>
              </tfoot>
            </table>
          </div>
          ${_hvlRevKwhCostBreakdown(equip, rd, avgKwhRate, avgKwRate, projId)}`;
}

function _hvlRevKwhCostBreakdown(equip, rd, avgKwhRate, avgKwRate, projId) {
  if (!equip.length) return '';
  const typeKwh = {};
  EQUIP_TYPES.forEach((t) => (typeKwh[t] = Array(12).fill(0)));
  equip.forEach((eq) => {
    const maxKw = _eqMaxKw(eq);
    const lf = eq.loadFactors || Array(12).fill(0);
    const df = eq.demandFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      const kwh = maxKw * (df[i] / 100) * (8760 / 12) * (lf[i] / 100);
      typeKwh[eq.type || 'Generic Elect. Equipment'][i] += kwh;
    }
  });
  const usedTypes = EQUIP_TYPES.filter((t) => typeKwh[t].some((v) => v > 0));
  if (!usedTypes.length) return '';
  const colors = {
    'Interior Lighting': '#60a5fa',
    'Exterior Lighting': '#a78bfa',
    Cooling: '#34d399',
    'Electric Heating': '#f87171',
    'Ventilation Fans': '#fbbf24',
    Pumps: '#2dd4bf',
    'Plug Loads': '#fb923c',
    'Generic Elect. Equipment': '#94a3b8',
  };
  return `<div class="card" style="margin-bottom:16px">
          <div class="card-hdr"><span class="card-title">💰 Electric Cost Allocation (kWh + kW) by End Use</span></div>
          <div style="overflow-x:auto">
            <table class="dtbl" style="min-width:900px;font-size:11px">
              <thead><tr><th>End Use</th>${MO_SHORT.map((m) => `<th style="text-align:right;font-size:10px">${m}</th>`).join('')}<th style="text-align:right">Annual</th></tr></thead>
              <tbody>
                ${usedTypes
                  .map((t) => {
                    const annualCost = typeKwh[t].reduce((s, v, i) => s + v * avgKwhRate[i], 0);
                    return `<tr>
                    <td style="font-weight:600"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[t] || '#94a3b8'};margin-right:4px"></span>${t}</td>
                    ${typeKwh[t].map((v, i) => `<td style="text-align:right;font-family:var(--mono)">${v * avgKwhRate[i] > 0 ? '$' + (v * avgKwhRate[i]).toFixed(0) : '—'}</td>`).join('')}
                    <td style="text-align:right;font-family:var(--mono);font-weight:700">${annualCost > 0 ? '$' + Math.round(annualCost).toLocaleString() : '—'}</td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`;
}

/* ── Gas Reverse Tab ── */
function _hvlRevRenderGas(wrap, projId, bldgId, rd, actualTherms, avgThermRate) {
  const gasEq = rd.gasEquipment || [];
  const moHdr = MO_SHORT.map(
    (m) => `<th style="text-align:center;width:52px;font-size:10px;border-left:1px solid var(--border)">${m}</th>`,
  ).join('');

  const modeledTherms = Array(12).fill(0);
  gasEq.forEach((eq) => {
    const maxThermHr = _gasMaxThermHr(eq);
    const uf = eq.utilFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      modeledTherms[i] += maxThermHr * (8760 / 12) * (uf[i] / 100);
    }
  });
  const totalActual = actualTherms.reduce((s, v) => s + v, 0);
  const totalModeled = modeledTherms.reduce((s, v) => s + v, 0);
  const annualMatch = totalActual > 0 ? ((totalModeled / totalActual) * 100).toFixed(1) + '%' : '—';

  const matchRow = MO_SHORT.map((_, i) => {
    const pct = actualTherms[i] > 0 ? (modeledTherms[i] / actualTherms[i]) * 100 : 0;
    const color = pct >= 90 && pct <= 110 ? 'var(--green)' : pct >= 75 && pct <= 125 ? 'var(--amber)' : 'var(--danger)';
    return `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:${actualTherms[i] > 0 ? color : 'var(--text3)'}">${actualTherms[i] > 0 ? pct.toFixed(0) + '%' : '—'}</td>`;
  }).join('');

  wrap.innerHTML = `
          <div style="margin-bottom:12px;display:flex;gap:16px;align-items:center">
            <span style="font-size:12px;color:var(--text2)">Annual Match: <strong style="color:var(--em)">${annualMatch}</strong></span>
            <button class="btn btn-ghost btn-sm" onclick="_hvlRevAddGasEquip(${projId},'${bldgId}')">+ Add Gas Equipment</button>
          </div>
          <div style="overflow-x:auto;margin-bottom:16px">
            <table class="dtbl" style="min-width:1300px;font-size:11px">
              <thead>
                <tr>
                  <th style="width:30px">#</th>
                  <th style="min-width:140px">Equipment Name</th>
                  <th style="min-width:100px">Type</th>
                  <th style="width:40px">Quantity</th>
                  <th style="width:60px">Size</th>
                  <th style="width:70px">Units</th>
                  <th style="width:65px;text-align:right">Therms per Hour</th>
                  ${moHdr}
                  <th style="width:28px"></th>
                </tr>
                <tr><th colspan="7" style="font-size:10px;color:var(--text3)">Monthly Utilization %</th>${MO_SHORT.map(() => '<th></th>').join('')}<th></th></tr>
              </thead>
              <tbody>
                ${gasEq
                  .map((eq, idx) => {
                    const maxTh = _gasMaxThermHr(eq);
                    const uf = eq.utilFactors || Array(12).fill(0);
                    const typeOpts = GAS_EQUIP_TYPES.map(
                      (t) => `<option${t === eq.type ? ' selected' : ''}>${t}</option>`,
                    ).join('');
                    const unitOpts = GAS_EQUIP_UNITS.map(
                      (u) => `<option${u === eq.units ? ' selected' : ''}>${u}</option>`,
                    ).join('');
                    return `<tr>
                    <td style="text-align:center;color:var(--text3)">${idx + 1}</td>
                    <td><input class="sv-msr-txt" style="width:100%" value="${eq.name || ''}" onchange="_hvlRevUpdGasEquip(${projId},'${bldgId}',${idx},'name',this.value)"></td>
                    <td><select class="sv-msr-sel" style="width:100%" onchange="_hvlRevUpdGasEquip(${projId},'${bldgId}',${idx},'type',this.value)">${typeOpts}</select></td>
                    <td><input class="sv-num-inp" type="number" style="width:38px" value="${eq.qty || 1}" onchange="_hvlRevUpdGasEquip(${projId},'${bldgId}',${idx},'qty',parseFloat(this.value)||1)"></td>
                    <td><input class="sv-num-inp" type="number" style="width:56px" step="any" value="${eq.size || ''}" placeholder="0" onchange="_hvlRevUpdGasEquip(${projId},'${bldgId}',${idx},'size',parseFloat(this.value)||0)"></td>
                    <td><select class="sv-msr-sel" style="width:68px" onchange="_hvlRevUpdGasEquip(${projId},'${bldgId}',${idx},'units',this.value)">${unitOpts}</select></td>
                    <td style="text-align:right;font-family:var(--mono);font-weight:600">${maxTh.toFixed(2)}</td>
                    ${uf.map((v, mi) => `<td style="border-left:1px solid var(--border);padding:1px"><input class="sv-num-inp" type="number" style="width:46px;text-align:center" min="0" max="100" value="${v || ''}" placeholder="0" onchange="_hvlRevUpdGasUf(${projId},'${bldgId}',${idx},${mi},parseFloat(this.value)||0)"></td>`).join('')}
                    <td><button class="btn-del" onclick="_hvlRevRemGasEquip(${projId},'${bldgId}',${idx})">✕</button></td>
                  </tr>`;
                  })
                  .join('')}
                ${!gasEq.length ? `<tr><td colspan="${20}" style="text-align:center;color:var(--text3);padding:16px">No gas equipment yet — click "+ Add Gas Equipment"</td></tr>` : ''}
              </tbody>
              <tfoot>
                <tr style="font-weight:700;border-top:2px solid var(--border2)">
                  <td colspan="7">MODELED Therms</td>
                  ${modeledTherms.map((v) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border);color:var(--accent)">${v > 0 ? Math.round(v).toLocaleString() : '—'}</td>`).join('')}
                  <td></td>
                </tr>
                <tr style="font-weight:700">
                  <td colspan="7">ACTUAL Therms</td>
                  ${actualTherms.map((v) => `<td style="text-align:center;font-family:var(--mono);font-size:10px;border-left:1px solid var(--border)">${v > 0 ? Math.round(v).toLocaleString() : '—'}</td>`).join('')}
                  <td></td>
                </tr>
                <tr style="font-weight:700">
                  <td colspan="7">MATCH %</td>
                  ${matchRow}
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          ${_hvlRevGasCostBreakdown(gasEq, avgThermRate)}`;
}

function _hvlRevGasCostBreakdown(gasEq, avgThermRate) {
  if (!gasEq.length) return '';
  const typeTherms = {};
  GAS_EQUIP_TYPES.forEach((t) => (typeTherms[t] = Array(12).fill(0)));
  gasEq.forEach((eq) => {
    const maxTh = _gasMaxThermHr(eq);
    const uf = eq.utilFactors || Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      typeTherms[eq.type || 'Other Gas'][i] += maxTh * (8760 / 12) * (uf[i] / 100);
    }
  });
  const usedTypes = GAS_EQUIP_TYPES.filter((t) => typeTherms[t].some((v) => v > 0));
  if (!usedTypes.length) return '';
  const colors = {
    'Gas Heating': '#f87171',
    'Domestic Hot Water': '#60a5fa',
    'Kitchen Equipment': '#fbbf24',
    'Other Gas': '#94a3b8',
  };
  return `<div class="card" style="margin-bottom:16px">
          <div class="card-hdr"><span class="card-title">💰 Gas Cost Allocation by End Use</span></div>
          <div style="overflow-x:auto">
            <table class="dtbl" style="min-width:900px;font-size:11px">
              <thead><tr><th>End Use</th>${MO_SHORT.map((m) => `<th style="text-align:right;font-size:10px">${m}</th>`).join('')}<th style="text-align:right">Annual</th></tr></thead>
              <tbody>
                ${usedTypes
                  .map((t) => {
                    const annualCost = typeTherms[t].reduce((s, v, i) => s + v * avgThermRate[i], 0);
                    return `<tr>
                    <td style="font-weight:600"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[t] || '#94a3b8'};margin-right:4px"></span>${t}</td>
                    ${typeTherms[t].map((v, i) => `<td style="text-align:right;font-family:var(--mono)">${v * avgThermRate[i] > 0 ? '$' + (v * avgThermRate[i]).toFixed(0) : '—'}</td>`).join('')}
                    <td style="text-align:right;font-family:var(--mono);font-weight:700">${annualCost > 0 ? '$' + Math.round(annualCost).toLocaleString() : '—'}</td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`;
}

/* ── Unit conversion helpers ── */
function _eqMaxKw(eq) {
  const qty = eq.qty || 1;
  const size = eq.size || 0;
  if (eq.units === 'Hp') return qty * size * 0.746;
  if (eq.units === 'Watts') return (qty * size) / 1000;
  return qty * size; // kW
}

function _gasMaxThermHr(eq) {
  const qty = eq.qty || 1;
  const size = eq.size || 0;
  if (eq.units === 'BHp') return qty * size * 0.03346;
  if (eq.units === 'lbs/hr') return qty * size * 0.001;
  if (eq.units === 'MMBtu/hr') return qty * size * 10;
  return (qty * size) / 100000; // Btu/hr → Therm/hr
}

/* ── CRUD for reverse analysis equipment ── */
function _hvlRevAddEquip(projId, bldgId) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.equipment) rd.equipment = [];
  rd.equipment.push({
    name: '',
    type: 'Cooling',
    qty: 1,
    size: 0,
    units: 'kW',
    demandProfile: true,
    demandFactors: Array(12).fill(0),
    loadFactors: Array(12).fill(0),
  });
  _saveRevData(projId, bldgId);
  _hvlRenderReverse(projId, bldgId);
}
function _hvlRevRemEquip(projId, bldgId, idx) {
  const rd = _getRevData(projId, bldgId);
  rd.equipment.splice(idx, 1);
  _saveRevData(projId, bldgId);
  _hvlRenderReverse(projId, bldgId);
}
function _hvlRevUpdEquip(projId, bldgId, idx, field, val) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.equipment[idx]) return;
  rd.equipment[idx][field] = val;
  _saveRevData(projId, bldgId);
}
function _hvlRevUpdDf(projId, bldgId, idx, moIdx, val) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.equipment[idx]) return;
  if (!rd.equipment[idx].demandFactors) rd.equipment[idx].demandFactors = Array(12).fill(0);
  rd.equipment[idx].demandFactors[moIdx] = val;
  _saveRevData(projId, bldgId);
}
function _hvlRevUpdLf(projId, bldgId, idx, moIdx, val) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.equipment[idx]) return;
  if (!rd.equipment[idx].loadFactors) rd.equipment[idx].loadFactors = Array(12).fill(0);
  rd.equipment[idx].loadFactors[moIdx] = val;
  _saveRevData(projId, bldgId);
}
function _hvlRevAddGasEquip(projId, bldgId) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.gasEquipment) rd.gasEquipment = [];
  rd.gasEquipment.push({
    name: '',
    type: 'Gas Heating',
    qty: 1,
    size: 0,
    units: 'Btu/hr',
    utilFactors: Array(12).fill(0),
  });
  _saveRevData(projId, bldgId);
  _hvlRenderReverse(projId, bldgId);
}
function _hvlRevRemGasEquip(projId, bldgId, idx) {
  const rd = _getRevData(projId, bldgId);
  rd.gasEquipment.splice(idx, 1);
  _saveRevData(projId, bldgId);
  _hvlRenderReverse(projId, bldgId);
}
function _hvlRevUpdGasEquip(projId, bldgId, idx, field, val) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.gasEquipment[idx]) return;
  rd.gasEquipment[idx][field] = val;
  _saveRevData(projId, bldgId);
}
function _hvlRevUpdGasUf(projId, bldgId, idx, moIdx, val) {
  const rd = _getRevData(projId, bldgId);
  if (!rd.gasEquipment[idx]) return;
  if (!rd.gasEquipment[idx].utilFactors) rd.gasEquipment[idx].utilFactors = Array(12).fill(0);
  rd.gasEquipment[idx].utilFactors[moIdx] = val;
  _saveRevData(projId, bldgId);
}

function hvacLoadMethod(projId, method, btn) {
  document.querySelectorAll('.hvl-method-btn').forEach((b) => {
    b.classList.remove('active');
    b.style.background = '';
    b.style.borderColor = '';
    b.style.color = '';
  });
  btn.classList.add('active');
  btn.style.background = 'var(--accent-dim)';
  btn.style.borderColor = 'var(--accent)';
  btn.style.color = 'var(--accent)';
  const bldgId = _hvlSelBldg[projId];
  if (bldgId) _hvlRenderMethod(projId, bldgId, method);
  // Autocalculate (2026-09-22): switching method recomputes immediately instead of clearing
  // results and waiting for a Calculate click. Reverse Utility Analysis renders its own results
  // inline as part of _hvlRenderMethod, so nothing further to compute here for it.
  const resWrap = document.getElementById('hvl-results-' + projId);
  if (method === 'reverse') {
    if (resWrap) resWrap.innerHTML = '';
  } else {
    requestAnimationFrame(() => hvacLoadCalc(projId, { persist: false }));
  }
}

// CBECS-derived benchmark data: {buildingType: {climateZone: {kwhHvacPct, kwHvacPct, gasHvacPct}}}
const HVAC_BENCHMARKS = {
  'K-12 School': {
    default: { kwhPct: 42, kwPct: 50, gasPct: 82 },
    '1A': { kwhPct: 55, kwPct: 60, gasPct: 30 },
    '2A': { kwhPct: 50, kwPct: 58, gasPct: 55 },
    '3A': { kwhPct: 47, kwPct: 55, gasPct: 70 },
    '4A': { kwhPct: 42, kwPct: 50, gasPct: 82 },
    '5A': { kwhPct: 38, kwPct: 48, gasPct: 88 },
    '6A': { kwhPct: 34, kwPct: 45, gasPct: 92 },
    7: { kwhPct: 30, kwPct: 42, gasPct: 95 },
  },
  'College / University': {
    default: { kwhPct: 45, kwPct: 52, gasPct: 78 },
    '4A': { kwhPct: 45, kwPct: 52, gasPct: 78 },
  },
  'Hospital / Healthcare': {
    default: { kwhPct: 40, kwPct: 48, gasPct: 60 },
    '4A': { kwhPct: 40, kwPct: 48, gasPct: 60 },
  },
  'Office Building': {
    default: { kwhPct: 38, kwPct: 50, gasPct: 75 },
    '4A': { kwhPct: 38, kwPct: 50, gasPct: 75 },
  },
  'Warehouse / Industrial': {
    default: { kwhPct: 25, kwPct: 30, gasPct: 85 },
    '4A': { kwhPct: 25, kwPct: 30, gasPct: 85 },
  },
  Retail: { default: { kwhPct: 40, kwPct: 52, gasPct: 70 }, '4A': { kwhPct: 40, kwPct: 52, gasPct: 70 } },
  'Municipal / Government': {
    default: { kwhPct: 42, kwPct: 50, gasPct: 78 },
    '4A': { kwhPct: 42, kwPct: 50, gasPct: 78 },
  },
  'Data Center': { default: { kwhPct: 38, kwPct: 40, gasPct: 15 }, '4A': { kwhPct: 38, kwPct: 40, gasPct: 15 } },
};

// CBECS National Median EUI by building type (kBtu/ft²/yr)
const CBECS_EUI = {
  'K-12 School': 48.5,
  'College / University': 84.3,
  'Hospital / Healthcare': 148.1,
  'Office Building': 52.9,
  'Warehouse / Industrial': 26.5,
  Retail: 44.3,
  'Municipal / Government': 56.1,
  'Data Center': 350,
  Other: 52.4,
  'Elementary School': 42,
  'Middle School': 52.6,
  'High School': 44,
};
// CBECS percentile ranges: [p25, median, p75] kBtu/ft²/yr
const CBECS_PERCENTILES = {
  'K-12 School': [28, 48.5, 72],
  'College / University': [52, 84.3, 125],
  'Hospital / Healthcare': [98, 148.1, 210],
  'Office Building': [30, 52.9, 82],
  'Warehouse / Industrial': [12, 26.5, 48],
  Retail: [24, 44.3, 68],
  'Municipal / Government': [32, 56.1, 85],
  'Data Center': [180, 350, 550],
  Other: [28, 52.4, 80],
  'Elementary School': [25, 42, 62],
  'Middle School': [32, 52.6, 76],
  'High School': [28, 44, 65],
};
// EnergyStar target EUI (score 75 threshold) by building type
const ESTAR_EUI = {
  'K-12 School': 38,
  'College / University': 65,
  'Hospital / Healthcare': 120,
  'Office Building': 46,
  'Warehouse / Industrial': 22,
  Retail: 36,
  'Municipal / Government': 44,
  Other: 40,
  'Elementary School': 34,
  'Middle School': 42,
  'High School': 36,
};

function hvacLoadBenchFill(projId) {
  const type = document.getElementById(`hvl-b-type-${projId}`)?.value;
  const clim = document.getElementById(`hvl-b-climate-${projId}`)?.value || '4A';
  const wrap = document.getElementById(`hvl-b-results-${projId}`);
  if (!type || !wrap) return;
  const data = HVAC_BENCHMARKS[type];
  if (!data) {
    wrap.innerHTML = '<div style="color:var(--text3)">No benchmark data for this type</div>';
    return;
  }
  const vals = data[clim] || data.default;
  wrap.innerHTML = `
          <div class="g2" style="gap:12px">
            <div class="card" style="background:var(--s1);padding:14px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">Benchmark Values (${type} / Zone ${clim})</div>
              <div class="fg"><label class="fl">HVAC % of Total kWh</label><input class="fi hvl-in" id="hvl-b-kwhPct-${projId}" type="number" value="${vals.kwhPct}"></div>
              <div class="fg"><label class="fl">HVAC % of Peak kW</label><input class="fi hvl-in" id="hvl-b-kwPct-${projId}" type="number" value="${vals.kwPct}"></div>
              <div class="fg"><label class="fl">HVAC % of Total Gas</label><input class="fi hvl-in" id="hvl-b-gasPct-${projId}" type="number" value="${vals.gasPct}"></div>
            </div>
            <div class="card" style="background:var(--s1);padding:14px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">Site EUI Reference</div>
              <div style="font-size:13px;color:var(--text2);line-height:1.7">
                CBECS National Median: <strong style="color:var(--em)">${CBECS_EUI[type] || 'N/A'} kBtu/ft²</strong><br>
                Climate zone ${clim} adjustments applied to HVAC split percentages.
              </div>
            </div>
          </div>`;
}

function hvacLoadCalc(projId, opts) {
  const persist = !!(opts && opts.persist);
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  // Use selected building's sqft and data
  const selBid = _hvlSelBldg[projId];
  const selBldg = selBid ? getUDBldg(projId, selBid) : null;
  const sqft = selBldg ? parseInt(selBldg.sqft) || 0 : p.sqft || 0;
  // Determine which method is active
  const method = selBid ? _hvlMethod[_hvlKey(projId, selBid)] || 'thumb' : 'thumb';

  // If reverse analysis method, the calc is already done inline
  if (method === 'reverse') {
    return;
  }

  // Get total utility data from baseline bills only (matches Baseline Data table). Single source
  // of truth (2026-09-22 fix): the kW total is the SUM of each month's billed kW from
  // _hvlMonthlyBaseline (getMeterBaselineTotals/buildMoMap), never a peak/max across bills — this
  // is exactly what the Baseline Data table's TOTAL kW column already shows.
  let totalKwh = 0,
    totalKw = 0,
    totalGas = 0;
  const _hvlElecByMo = {};
  const _hvlGasByMo = {};
  const _hvlKwByMo = {};
  const _gatherBldg = (b) => {
    const { eByMo, gByMo, pByMo } = _hvlMonthlyBaseline(projId, b);
    for (let mo = 0; mo < 12; mo++) {
      const eb = eByMo[mo];
      if (eb) {
        totalKwh += eb.kwh || 0;
        totalKw += eb.billedKW || 0;
        _hvlElecByMo[mo] = (_hvlElecByMo[mo] || 0) + (eb.kwh || 0);
        _hvlKwByMo[mo] = (_hvlKwByMo[mo] || 0) + (eb.billedKW || 0);
      }
      const gb = gByMo[mo];
      if (gb) {
        totalGas += gb.therms || 0;
        _hvlGasByMo[mo] = (_hvlGasByMo[mo] || 0) + (gb.therms || 0);
      }
      const pb = pByMo[mo];
      if (pb) {
        // Convert gallons to therms (0.9153 therms/gal) so propane rolls up into the same gas
        // total used by HVAC Load Est.
        const thermsEq = (pb.gallons || 0) * 0.9153;
        totalGas += thermsEq;
        _hvlGasByMo[mo] = (_hvlGasByMo[mo] || 0) + thermsEq;
      }
    }
  };
  if (selBldg) {
    _gatherBldg(selBldg);
  } else {
    getUDBldgs(projId).forEach(_gatherBldg);
  }

  let hvacKwhPct, hvacKwPct, hvacGasPct;
  let coolKwh = 0,
    heatKwhElec = 0,
    heatGas = 0,
    lightKwh = 0,
    plugKwh = 0,
    otherKwh = 0,
    otherGas = 0;
  let estimatedTotalKwh = totalKwh,
    estimatedTotalKw = totalKw,
    estimatedTotalGas = totalGas;

  if (method === 'thumb') {
    hvacKwhPct = parseFloat(document.getElementById(`hvl-t-kwhPct-${projId}`)?.value) || 0;
    hvacKwPct = parseFloat(document.getElementById(`hvl-t-kwPct-${projId}`)?.value) || 0;
    hvacGasPct = parseFloat(document.getElementById(`hvl-t-gasPct-${projId}`)?.value) || 0;
  } else if (method === 'benchmark') {
    hvacKwhPct = parseFloat(document.getElementById(`hvl-b-kwhPct-${projId}`)?.value) || 0;
    hvacKwPct = parseFloat(document.getElementById(`hvl-b-kwPct-${projId}`)?.value) || 0;
    hvacGasPct = parseFloat(document.getElementById(`hvl-b-gasPct-${projId}`)?.value) || 0;
  } else {
    // nameplate
    const coolTons = parseFloat(document.getElementById(`hvl-n-coolTons-${projId}`)?.value) || 0;
    const coolKwTon = parseFloat(document.getElementById(`hvl-n-coolKwTon-${projId}`)?.value) || 0.86;
    const coolEFLH = parseFloat(document.getElementById(`hvl-n-coolEFLH-${projId}`)?.value) || 1200;
    const heatMBH = parseFloat(document.getElementById(`hvl-n-heatMBH-${projId}`)?.value) || 0;
    const heatEff = parseFloat(document.getElementById(`hvl-n-heatEff-${projId}`)?.value) || 0.8;
    const heatEFLH = parseFloat(document.getElementById(`hvl-n-heatEFLH-${projId}`)?.value) || 1600;
    const heatFuel = document.getElementById(`hvl-n-heatFuel-${projId}`)?.value || 'gas';
    const lightW = parseFloat(document.getElementById(`hvl-n-lightW-${projId}`)?.value) || 0;
    const lightHrs = parseFloat(document.getElementById(`hvl-n-lightHrs-${projId}`)?.value) || 0;
    const plugW = parseFloat(document.getElementById(`hvl-n-plugW-${projId}`)?.value) || 0;
    const plugHrs = parseFloat(document.getElementById(`hvl-n-plugHrs-${projId}`)?.value) || 0;
    otherKwh = parseFloat(document.getElementById(`hvl-n-otherKwh-${projId}`)?.value) || 0;
    otherGas = parseFloat(document.getElementById(`hvl-n-otherGas-${projId}`)?.value) || 0;

    coolKwh = coolTons * coolKwTon * coolEFLH;
    if (heatFuel === 'electric') {
      heatKwhElec = ((heatMBH * 1000) / 3412 / (heatEff || 1)) * heatEFLH; // MBH→kW then * hours
    } else {
      heatGas = ((heatMBH * 1000) / 100000 / (heatEff || 1)) * heatEFLH; // MBH→therms then * hours
    }
    lightKwh = ((lightW * sqft) / 1000) * lightHrs;
    plugKwh = ((plugW * sqft) / 1000) * plugHrs;

    estimatedTotalKwh = coolKwh + heatKwhElec + lightKwh + plugKwh + otherKwh;
    estimatedTotalGas = heatGas + otherGas;
    if (estimatedTotalKwh > 0) {
      hvacKwhPct = ((coolKwh + heatKwhElec) / estimatedTotalKwh) * 100;
    } else hvacKwhPct = 0;
    hvacKwPct =
      coolTons > 0
        ? Math.min(70, ((coolTons * coolKwTon) / Math.max(estimatedTotalKw || 1, estimatedTotalKwh / 2000)) * 100)
        : 50;
    if (estimatedTotalGas > 0) {
      hvacGasPct = (heatGas / estimatedTotalGas) * 100;
    } else hvacGasPct = 0;
    // Use utility data if available
    if (totalKwh > 0) estimatedTotalKwh = totalKwh;
    if (totalKw > 0) estimatedTotalKw = totalKw;
    if (totalGas > 0) estimatedTotalGas = totalGas;
  }

  const hvacKwh = estimatedTotalKwh * (hvacKwhPct / 100);
  const nonHvacKwh = estimatedTotalKwh - hvacKwh;
  const hvacKw = estimatedTotalKw * (hvacKwPct / 100);
  const nonHvacKw = estimatedTotalKw - hvacKw;
  const hvacGasT = estimatedTotalGas * (hvacGasPct / 100);
  const nonHvacGas = estimatedTotalGas - hvacGasT;

  // Monthly distribution (simplified — cooling peaks summer, heating peaks winter)
  const coolDist = [0.02, 0.02, 0.04, 0.06, 0.12, 0.17, 0.2, 0.18, 0.12, 0.05, 0.01, 0.01]; // KC cooling shape
  const heatDist = [0.18, 0.15, 0.12, 0.06, 0.01, 0.0, 0.0, 0.0, 0.01, 0.06, 0.14, 0.27]; // KC heating shape
  const flatDist = [1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12, 1 / 12];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Determine cooling vs heating kWh split. Rules of Thumb (2026-09-22 fix): heating kWh is
  // driven directly by the "Heating % of HVAC kWh (electric heat only)" input, not by
  // (1 − cooling %) — that field was previously never read, so heating kWh never actually
  // reached 0 when the building has no electric heat. Cooling absorbs the remainder of the
  // electric HVAC total (fans/pumps included), so heatKwhPct = 0 forces heatKwhTotal = 0 exactly.
  let coolKwhTotal, heatKwhTotal;
  if (method === 'thumb') {
    const heatKwhPct = (parseFloat(document.getElementById(`hvl-t-heatKwhPct-${projId}`)?.value) || 0) / 100;
    heatKwhTotal = hvacKwh * heatKwhPct;
    coolKwhTotal = hvacKwh - heatKwhTotal;
  } else {
    const coolPctOfHvac = 0.65;
    coolKwhTotal = hvacKwh * coolPctOfHvac;
    heatKwhTotal = hvacKwh * (1 - coolPctOfHvac);
  }

  const fmt = (n) =>
    n >= 10000 ? Math.round(n).toLocaleString() : n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);
  const pct = (n) => n.toFixed(1) + '%';

  // Save to project — include monthly breakdowns so savings calcs can use them
  // Scale KC shapes so each month's component total = actual baseline kWh
  const _rawCool = coolDist.map((d) => coolKwhTotal * d);
  const _rawHeat = heatDist.map((d) => heatKwhTotal * d);
  const _rawNonH = flatDist.map((d) => nonHvacKwh * d);
  const monthlyCoolKwh = _rawCool.slice();
  const monthlyHeatKwh = _rawHeat.slice();
  const monthlyNonHvacKwh = _rawNonH.slice();
  const hasBaselineKwh = Object.keys(_hvlElecByMo).length >= 3;
  if (hasBaselineKwh) {
    for (let i = 0; i < 12; i++) {
      const actual = _hvlElecByMo[i] || 0;
      const shaped = _rawCool[i] + _rawHeat[i] + _rawNonH[i];
      if (shaped > 0 && actual > 0) {
        const scale = actual / shaped;
        monthlyCoolKwh[i] = _rawCool[i] * scale;
        monthlyHeatKwh[i] = _rawHeat[i] * scale;
        monthlyNonHvacKwh[i] = _rawNonH[i] * scale;
      } else if (actual > 0) {
        monthlyNonHvacKwh[i] = actual;
      }
    }
  }
  const monthlyHvacKwh = months.map((_, i) => monthlyCoolKwh[i] + monthlyHeatKwh[i]);
  const _rawGasHvac = heatDist.map((d) => hvacGasT * d);
  const _rawGasNon = flatDist.map((d) => nonHvacGas * d);
  const monthlyHvacGas = _rawGasHvac.slice();
  const monthlyNonHvacGas = _rawGasNon.slice();
  const hasBaselineGas = Object.keys(_hvlGasByMo).length >= 3;
  if (hasBaselineGas) {
    for (let i = 0; i < 12; i++) {
      const actual = _hvlGasByMo[i] || 0;
      const shaped = _rawGasHvac[i] + _rawGasNon[i];
      if (shaped > 0 && actual > 0) {
        const scale = actual / shaped;
        monthlyHvacGas[i] = _rawGasHvac[i] * scale;
        monthlyNonHvacGas[i] = _rawGasNon[i] * scale;
      } else if (actual > 0) {
        monthlyNonHvacGas[i] = actual;
      }
    }
  }
  // Monthly kW (2026-09-22 fix): when billed-kW baseline data exists, split each month's ACTUAL
  // billed kW (_hvlKwByMo, the same single-source monthly values the Baseline Data table sums)
  // by the HVAC %, so the Annual column is always the SUM of the 12 months — never a repeated
  // peak. Falls back to a cooling-season-weighted share of the estimate only when there is no
  // billed-kW baseline to split (e.g. nameplate-only, no utility bills yet); that fallback still
  // preserves the sum-equals-total invariant.
  const hasBaselineKw = Object.keys(_hvlKwByMo).length >= 3;
  let monthlyTotalKw, monthlyHvacKw, monthlyNonHvacKw;
  if (hasBaselineKw) {
    monthlyTotalKw = months.map((_, i) => _hvlKwByMo[i] || 0);
  } else {
    const shapeSum = coolDist.reduce((s, d) => s + d, 0) || 1;
    monthlyTotalKw = coolDist.map((d) => estimatedTotalKw * (d / shapeSum));
  }
  monthlyHvacKw = monthlyTotalKw.map((v) => v * (hvacKwPct / 100));
  monthlyNonHvacKw = monthlyTotalKw.map((v, i) => v - monthlyHvacKw[i]);

  p.hvacLoadEst = {
    method,
    hvacKwhPct,
    hvacKwPct,
    hvacGasPct,
    totalKwh: estimatedTotalKwh,
    totalKw: estimatedTotalKw,
    totalGas: estimatedTotalGas,
    monthlyCoolKwh,
    monthlyHeatKwh,
    monthlyNonHvacKwh,
    monthlyHvacKwh,
    monthlyHvacGas,
    monthlyNonHvacGas,
    monthlyHvacKw,
    monthlyNonHvacKw,
    monthlyTotalKw,
    coolKwhTotal,
    heatKwhTotal,
    hvacKwh,
    nonHvacKwh,
    hvacGasT,
    nonHvacGas,
    hvacKw,
    nonHvacKw,
  };
  // Autocalculate (2026-09-22): only the Save button writes to storage. Live edits recompute
  // p.hvacLoadEst in memory (for immediate display and for other tabs' autofill reads) without
  // persisting until the user clicks Save.
  if (persist) sset('en_projects', projects);

  const wrap = document.getElementById(`hvl-results-${projId}`);
  if (!wrap) return;
  wrap.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">📊 Load Breakdown Results</span>
              <div style="margin-left:auto;display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="hvacLoadExportXlsx(${projId})">⬇️ Excel</button>
                <button class="btn btn-ghost btn-sm" onclick="hvacLoadExportWord(${projId})">⬇️ Word</button>
                <button class="btn btn-ghost btn-sm" onclick="hvacLoadExportPdf(${projId})">⬇️ PDF</button>
              </div>
            </div>
            <div style="padding:16px">
              ${totalKwh === 0 && method !== 'nameplate' ? '<div style="background:var(--warn-dim);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:14px">⚠️ No utility data found for this project. Add utility bills to buildings for more accurate results. Showing percentage-based estimates only.</div>' : ''}
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px">
                <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Total kWh/yr</div>
                  <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--text);margin:4px 0">${fmt(estimatedTotalKwh)}</div>
                  <div style="display:flex;justify-content:center;gap:12px;margin-top:6px">
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--accent);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">HVAC ${pct(hvacKwhPct)} (${fmt(hvacKwh)} kWh)</span></div>
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--teal);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">Other ${pct(100 - hvacKwhPct)} (${fmt(nonHvacKwh)} kWh)</span></div>
                  </div>
                </div>
                <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Total kW (Billed, sum of months)</div>
                  <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--text);margin:4px 0">${fmt(estimatedTotalKw)}</div>
                  <div style="display:flex;justify-content:center;gap:12px;margin-top:6px">
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--accent);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">HVAC ${pct(hvacKwPct)} (${fmt(hvacKw)} kW)</span></div>
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--teal);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">Other ${pct(100 - hvacKwPct)} (${fmt(nonHvacKw)} kW)</span></div>
                  </div>
                </div>
                <div class="card" style="background:var(--s1);padding:14px;text-align:center">
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Gas Therms/yr</div>
                  <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--text);margin:4px 0">${fmt(estimatedTotalGas)}</div>
                  <div style="display:flex;justify-content:center;gap:12px;margin-top:6px">
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--accent);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">HVAC ${pct(hvacGasPct)}</span></div>
                    <div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--teal);margin-right:4px"></span><span style="font-size:11px;color:var(--text2)">Other ${pct(100 - hvacGasPct)}</span></div>
                  </div>
                </div>
              </div>
              <!-- Monthly breakdown table -->
              <div style="overflow-x:auto">
                <table class="dtbl" style="min-width:800px">
                  <thead>
                    <tr><th>Category</th>${months.map((m) => `<th style="text-align:center;width:58px">${m}</th>`).join('')}<th style="text-align:right">Annual</th></tr>
                  </thead>
                  <tbody>
                    <tr style="background:rgba(59,130,246,0.05)"><td style="font-weight:600">Cooling kWh</td>${monthlyCoolKwh.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyCoolKwh.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr style="background:rgba(244,63,94,0.05)"><td style="font-weight:600">Heating kWh</td>${monthlyHeatKwh.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyHeatKwh.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr><td style="font-weight:600;color:var(--teal)">Non-HVAC kWh</td>${monthlyNonHvacKwh.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyNonHvacKwh.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr style="border-top:2px solid var(--border2)"><td style="font-weight:800">Total kWh</td>${months.map((_, i) => `<td style="text-align:right;font-family:var(--mono);font-size:11px;font-weight:700">${fmt(monthlyCoolKwh[i] + monthlyHeatKwh[i] + monthlyNonHvacKwh[i])}</td>`).join('')}<td style="text-align:right;font-weight:800;font-family:var(--mono);color:var(--em)">${fmt(estimatedTotalKwh)}</td></tr>
                    <tr><td colspan="${months.length + 2}" style="height:8px;border:none"></td></tr>
                    <tr style="background:rgba(59,130,246,0.05)"><td style="font-weight:600">HVAC kW</td>${monthlyHvacKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyHvacKw.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr><td style="font-weight:600;color:var(--teal)">Non-HVAC kW</td>${monthlyNonHvacKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyNonHvacKw.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr style="border-top:2px solid var(--border2)"><td style="font-weight:800">Total kW</td>${monthlyTotalKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px;font-weight:700">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:800;font-family:var(--mono);color:var(--em)">${fmt(monthlyTotalKw.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr><td colspan="${months.length + 2}" style="height:8px;border:none"></td></tr>
                    <tr style="background:rgba(244,63,94,0.05)"><td style="font-weight:600">HVAC Gas Therms</td>${monthlyHvacGas.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyHvacGas.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr><td style="font-weight:600;color:var(--teal)">Non-HVAC Gas Therms</td>${monthlyNonHvacGas.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(monthlyNonHvacGas.reduce((s, v) => s + v, 0))}</td></tr>
                    <tr style="border-top:2px solid var(--border2)"><td style="font-weight:800">Total Gas Therms</td>${months.map((_, i) => `<td style="text-align:right;font-family:var(--mono);font-size:11px;font-weight:700">${fmt(monthlyHvacGas[i] + monthlyNonHvacGas[i])}</td>`).join('')}<td style="text-align:right;font-weight:800;font-family:var(--mono);color:var(--em)">${fmt(estimatedTotalGas)}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <!-- CREATE SAVINGS MEASURE FROM HVAC LOAD DATA -->
          <div id="hvl-msr-${projId}"></div>`;

  _hvlRenderMsr(projId);
}

// -----------------------------------------------------------------------
// Create Savings Measure from HVAC Load (2026-09-22 rewrite) — replaces the old typed
// %-reduction boxes. Savings are now COMPUTED from the occupied setpoint/schedule change saved
// in the Baseline + BAS Savings Report Inputs (project.savingsData.basSetpoint[bldgId], options
// A/B/C) by calling the SAME engine that report uses (app/report-engine-woodland.js —
// wdComputeSetpointOptions / wdApplySetpointOptions / wdOptionDollarByMonth). No second formula.
// If those inputs are missing, this shows exactly what's missing and a button to the Inputs
// dialog — it never invents a savings percentage.
// -----------------------------------------------------------------------
// The Baseline + BAS Savings Report's Inputs dialog (#wd-inputs-modal, app/report-engine-woodland.js)
// is a shared modal with no "closed" callback. Poll for its removal so the Create Savings
// Measure card picks up newly-saved setpoint/rate inputs as soon as the user closes it, instead
// of staying stuck on the stale "missing inputs" state until some unrelated re-render happens.
function _hvlOpenReportInputsAndRefresh(projId, bldgId) {
  if (typeof wdOpenReportInputs !== 'function') return;
  wdOpenReportInputs(projId, bldgId);
  const check = () => {
    if (!document.getElementById('wd-inputs-modal')) {
      _hvlRenderMsr(projId);
    } else {
      setTimeout(check, 400);
    }
  };
  setTimeout(check, 400);
}

function _hvlRenderMsr(projId) {
  const p = projects.find((x) => x.id === projId);
  const container = document.getElementById(`hvl-msr-${projId}`);
  if (!p || !container) return;
  const udBldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : p.buildings || [];
  const selBid =
    document.getElementById(`hvl-msr-bldg-${projId}`)?.value ||
    _hvlSelBldg[projId] ||
    (udBldgs[0] && udBldgs[0].id) ||
    '';
  const bldgOpts = udBldgs
    .map(
      (b) =>
        `<option value="${_esc(b.id)}"${b.id === selBid ? ' selected' : ''}>${_esc(b.name || 'Building')}</option>`,
    )
    .join('');
  const bldgSelectorHtml = `<div class="fg"><label class="fl">Building</label>
      <select class="fs" id="hvl-msr-bldg-${projId}" onchange="_hvlRenderMsr(${projId})">${bldgOpts || '<option value="">No buildings — add via Utility Data tab</option>'}</select>
    </div>`;

  if (!selBid) {
    container.innerHTML = `<div class="card"><div class="card-hdr"><span class="card-title">💡 Create Savings Measure from HVAC Load</span></div>
      <div style="padding:16px">${bldgSelectorHtml}<div style="font-size:12px;color:var(--text3);margin-top:10px">Add buildings via Utility Data.</div></div></div>`;
    return;
  }

  const b = getUDBldg(projId, selBid);
  const bName = _esc(b?.name || 'Building');
  const check =
    typeof wdCheckReportInputs === 'function' ? wdCheckReportInputs(projId, selBid) : { ok: false, missing: [] };

  if (!check.ok) {
    container.innerHTML = `<div class="card"><div class="card-hdr"><span class="card-title">💡 Create Savings Measure from HVAC Load</span></div>
      <div style="padding:16px">
        ${bldgSelectorHtml}
        <div style="background:var(--warn-dim);border:1px solid var(--warn);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn);margin-top:12px">
          Savings for ${bName} need setpoint and rate inputs before a measure can be created.
          <ul style="margin:8px 0 0 18px;padding:0">
            ${check.missing.map((m) => `<li>${_esc(m.label)}</li>`).join('')}
          </ul>
        </div>
        <div style="margin-top:12px"><button class="btn btn-em btn-sm" onclick="_hvlOpenReportInputsAndRefresh(${projId},'${_esc(selBid)}')">Open Report Inputs</button></div>
      </div>
    </div>`;
    return;
  }

  const cfg = _wdGetCfg(p, selBid);
  const bls = _wdBldgBaselines(b);
  const res = wdComputeSetpointOptions(cfg, bls.elecBL, bls.gasBL);
  // Normalized rates (_wdSeasonalRates shape) + wdOptionDollarByMonth — the report's OWN $
  // rounding convention (round every month to the cent, then sum) so this preview always equals
  // the printed Baseline + BAS Savings Report, not the separate sum-then-round total the Energy
  // Savings matrix's m.totalDollar uses.
  const ratesForOpt = typeof _wdSeasonalRates === 'function' ? _wdSeasonalRates(cfg.rates) : cfg.rates;
  const rows = res.options.map((o) => {
    const annualKwh = o.kwh.reduce((s, v) => s + v, 0);
    const annualKw = o.kw.reduce((s, v) => s + v, 0);
    const annualGas = o.gas.reduce((s, v) => s + v, 0);
    const d = typeof wdOptionDollarByMonth === 'function' ? wdOptionDollarByMonth(o, ratesForOpt) : null;
    return Object.assign({}, o, { annualKwh, annualKw, annualGas, dollar: d ? d.annualTotal$ : 0 });
  });

  container.innerHTML = `<div class="card"><div class="card-hdr"><span class="card-title">💡 Create Savings Measure from HVAC Load</span></div>
    <div style="padding:16px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:14px">Savings below are computed from the occupied setpoint change saved in the Baseline + BAS Savings Report Inputs for ${bName} — the same calculation that report uses.</div>
      ${bldgSelectorHtml}
      <div style="overflow-x:auto;margin-top:12px">
        <table class="dtbl">
          <thead><tr><th>Option</th><th>Occupied Heat / Cool</th><th style="text-align:right">kWh/Year</th><th style="text-align:right">kW</th><th style="text-align:right">Therms/Year</th><th style="text-align:right">$/Year</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
              <td style="font-weight:700">Option ${_esc(r.letter)}</td>
              <td>${_esc(r.heatSP)}°F / ${_esc(r.coolSP)}°F</td>
              <td style="text-align:right;font-family:var(--mono)">${Math.round(r.annualKwh).toLocaleString()}</td>
              <td style="text-align:right;font-family:var(--mono)">${r.annualKw.toFixed(1)}</td>
              <td style="text-align:right;font-family:var(--mono)">${Math.round(r.annualGas).toLocaleString()}</td>
              <td style="text-align:right;font-family:var(--mono);color:var(--em);font-weight:700">${_hvlCents(r.dollar)}</td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-em" onclick="_hvlCreateMsrFromOptions(${projId},'${_esc(selBid)}')">+ Create Savings Measures (A/B/C)</button>
      </div>
    </div>
  </div>`;
}
function _hvlCents(n) {
  const v = parseFloat(n) || 0;
  return (
    (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function _hvlCreateMsrFromOptions(projId, bldgId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const cfg = _wdGetCfg(p, bldgId);
  if (!cfg) {
    showToast('Open Report Inputs first');
    return;
  }
  // Single engine (2026-09-22): wdApplySetpointOptions is the SAME function the Baseline + BAS
  // Savings Report's own "Save & Compute" button calls — it upserts the A/B/C measures keyed by
  // option letter, so results here always match that report exactly.
  wdApplySetpointOptions(projId, bldgId, cfg);
  showToast('Savings measures (Options A/B/C) added from Report Inputs');
  _svRecalcFrom(projId);
  const btn = document.querySelector('.pdt[data-tab="savings"]');
  if (btn) sPTab('savings', btn);
}

function hvacLoadSave(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const bldgId = _hvlSelBldg[projId];
  const method = bldgId ? _hvlMethod[_hvlKey(projId, bldgId)] || 'thumb' : 'thumb';
  hvacLoadCalc(projId, { persist: true });
  if (bldgId && method === 'reverse') {
    _saveRevData(projId, bldgId);
  } else if (bldgId && method) {
    if (!p.hvacLoadInputs) p.hvacLoadInputs = {};
    if (!p.hvacLoadInputs[bldgId]) p.hvacLoadInputs[bldgId] = {};
    p.hvacLoadInputs[bldgId][method] = _hvlCaptureInputs(projId, method);
  }
  p.hvacLoadSavedAt = Date.now();
  _hvlDirty[projId] = false;
  sset('en_projects', projects);
  _hvlUpdateSaveUI(projId);
  showToast('HVAC load estimate saved ✓');
}

/* ══════════════════════════════════════════════════════
         HVAC LOAD ESTIMATION — EXPORT (Excel / Word / PDF)
         Content order: summary (building, method, option, annual kWh/kW/Therms/$ saved) →
         each input with its source → monthly per-component breakdown → reconciliation to the
         billed baseline. Client wording only — no abbreviations, no internal/uncertainty text.
      ══════════════════════════════════════════════════════ */
const _HVL_MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const _HVL_FIELD_LABELS = {
  kwhPct: 'Heating and Cooling Share of Total Electricity',
  coolKwhPct: 'Cooling Share of Heating and Cooling Electricity',
  heatKwhPct: 'Electric Heating Share of Heating and Cooling Electricity',
  kwPct: 'Heating and Cooling Share of Electric Demand',
  gasPct: 'Space Heating Share of Total Natural Gas',
  type: 'Building Type',
  climate: 'Climate Zone',
  coolTons: 'Total Cooling Capacity (Tons)',
  coolKwTon: 'Cooling Efficiency (kW per Ton)',
  coolEFLH: 'Estimated Full-Load Cooling Hours per Year',
  heatMBH: 'Total Heating Capacity (thousand Btu per hour)',
  heatEff: 'Heating Efficiency',
  heatEFLH: 'Estimated Full-Load Heating Hours per Year',
  heatFuel: 'Heating Fuel Type',
  lightW: 'Lighting Power (Watts per square foot)',
  lightHrs: 'Lighting Operating Hours per Year',
  plugW: 'Plug Load Power (Watts per square foot)',
  plugHrs: 'Plug Load Operating Hours per Year',
  otherKwh: 'Other Base Electricity (kWh per Year)',
  otherGas: 'Other Natural Gas Use (Therms per Year)',
};
const _HVL_METHOD_LABEL = {
  thumb: 'Rules of Thumb',
  benchmark: 'Building Benchmark',
  nameplate: 'Nameplate Data',
  reverse: 'Reverse Utility Analysis',
};

// _hvlBuildExportData — assembles everything an export needs from the CURRENT saved/live
// calculation and inputs. Every number here is read from p.hvacLoadEst, the input fields
// themselves, or _hvlMonthlyBaseline (the single-source billed baseline) — nothing invented.
function _hvlBuildExportData(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.hvacLoadEst) return null;
  const est = p.hvacLoadEst;
  const bldgId = _hvlSelBldg[projId];
  const b = bldgId ? getUDBldg(projId, bldgId) : null;
  const methodLabel = _HVL_METHOD_LABEL[est.method] || est.method;

  // Inputs with source
  const prefix = _hvlPrefix(est.method);
  const savedInputs =
    (bldgId && p.hvacLoadInputs && p.hvacLoadInputs[bldgId] && p.hvacLoadInputs[bldgId][est.method]) || {};
  const inputs = _hvlFieldsFor(est.method).map((f) => {
    const el = document.getElementById(`${prefix}${f}-${projId}`);
    const val = el ? el.value : (savedInputs[f] ?? '');
    return { label: _HVL_FIELD_LABELS[f] || f, value: val, source: 'HVAC Load Estimation — ' + methodLabel + ' tab' };
  });

  // Setpoint savings options (A/B/C), if Report Inputs are complete for this building
  let options = [],
    optionsMissing = [];
  if (bldgId && typeof wdCheckReportInputs === 'function') {
    const check = wdCheckReportInputs(projId, bldgId);
    if (check.ok) {
      const cfg = _wdGetCfg(p, bldgId);
      const bls = _wdBldgBaselines(b);
      const res = wdComputeSetpointOptions(cfg, bls.elecBL, bls.gasBL);
      const ratesForOpt = typeof _wdSeasonalRates === 'function' ? _wdSeasonalRates(cfg.rates) : cfg.rates;
      options = res.options.map((o) => {
        const d = typeof wdOptionDollarByMonth === 'function' ? wdOptionDollarByMonth(o, ratesForOpt) : null;
        return {
          letter: o.letter,
          heatSP: o.heatSP,
          coolSP: o.coolSP,
          annualKwh: o.kwh.reduce((s, v) => s + v, 0),
          annualKw: o.kw.reduce((s, v) => s + v, 0),
          annualGas: o.gas.reduce((s, v) => s + v, 0),
          dollar: d ? d.annualTotal$ : 0,
        };
      });
    } else {
      optionsMissing = check.missing || [];
    }
  }

  // Reconciliation to the billed baseline (single source: _hvlMonthlyBaseline)
  let billed = { kwh: 0, kw: 0, gas: 0 };
  if (b) {
    const { eByMo, gByMo, pByMo } = _hvlMonthlyBaseline(projId, b);
    for (let mo = 0; mo < 12; mo++) {
      if (eByMo[mo]) {
        billed.kwh += eByMo[mo].kwh || 0;
        billed.kw += eByMo[mo].billedKW || 0;
      }
      if (gByMo[mo]) billed.gas += gByMo[mo].therms || 0;
      if (pByMo[mo]) billed.gas += (pByMo[mo].gallons || 0) * 0.9153;
    }
  }

  return {
    projectName: p.name || 'Project',
    buildingName: (b && b.name) || 'All Buildings',
    method: methodLabel,
    generatedAt: new Date(),
    savedAt: p.hvacLoadSavedAt ? new Date(p.hvacLoadSavedAt) : null,
    est,
    inputs,
    options,
    optionsMissing,
    billed,
  };
}

function _hvlExportGuard(projId) {
  const data = _hvlBuildExportData(projId);
  if (!data) {
    showToast('Nothing to export yet — enter inputs so the outputs calculate, then try again');
    return null;
  }
  return data;
}

/* ── Excel export (SheetJS — the xlsx library already used for import elsewhere) ── */
function hvacLoadExportXlsx(projId) {
  const data = _hvlExportGuard(projId);
  if (!data || typeof XLSX === 'undefined') {
    if (typeof XLSX === 'undefined') showToast('Excel export is unavailable — the xlsx library did not load', 'error');
    return;
  }
  const est = data.est;
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    ['HVAC Load Estimation'],
    ['Building', data.buildingName],
    ['Method', data.method],
    ['Generated', data.generatedAt.toLocaleString()],
    ['Last Saved', data.savedAt ? data.savedAt.toLocaleString() : 'Not saved yet'],
    [],
    ['Annual Totals', 'Heating and Cooling', 'Other', 'Total'],
    ['Electricity (kWh)', Math.round(est.hvacKwh), Math.round(est.nonHvacKwh), Math.round(est.totalKwh)],
    [
      'Electric Demand (kW)',
      Math.round(est.hvacKw * 10) / 10,
      Math.round(est.nonHvacKw * 10) / 10,
      Math.round(est.totalKw * 10) / 10,
    ],
    ['Natural Gas (Therms)', Math.round(est.hvacGasT), Math.round(est.nonHvacGas), Math.round(est.totalGas)],
  ];
  if (data.options.length) {
    summaryRows.push(
      [],
      [
        'Setpoint Savings Option',
        'Occupied Heating (°F)',
        'Occupied Cooling (°F)',
        'Electricity Saved (kWh/yr)',
        'Electric Demand Saved (kW)',
        'Natural Gas Saved (Therms/yr)',
        'Cost Saved ($/yr)',
      ],
    );
    data.options.forEach((o) => {
      summaryRows.push([
        'Option ' + o.letter,
        o.heatSP,
        o.coolSP,
        Math.round(o.annualKwh),
        Math.round(o.annualKw * 10) / 10,
        Math.round(o.annualGas),
        Math.round(o.dollar * 100) / 100,
      ]);
    });
  } else if (data.optionsMissing.length) {
    summaryRows.push([], ['Setpoint savings inputs needed before options can be shown:']);
    data.optionsMissing.forEach((m) => summaryRows.push([m.label]));
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

  const inputRows = [['Input', 'Value', 'Source']];
  data.inputs.forEach((i) => inputRows.push([i.label, i.value, i.source]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inputRows), 'Inputs');

  const monthlyRows = [['Category', ..._HVL_MONTHS_FULL, 'Annual']];
  const addRow = (label, arr) =>
    monthlyRows.push([
      label,
      ...arr.map((v) => Math.round(v * 10) / 10),
      Math.round(arr.reduce((s, v) => s + v, 0) * 10) / 10,
    ]);
  addRow('Cooling Electricity (kWh)', est.monthlyCoolKwh);
  addRow('Heating Electricity (kWh)', est.monthlyHeatKwh);
  addRow('Other Electricity (kWh)', est.monthlyNonHvacKwh);
  addRow('Heating and Cooling Electric Demand (kW)', est.monthlyHvacKw);
  addRow('Other Electric Demand (kW)', est.monthlyNonHvacKw);
  addRow('Total Electric Demand (kW)', est.monthlyTotalKw);
  addRow('Heating and Cooling Natural Gas (Therms)', est.monthlyHvacGas);
  addRow('Other Natural Gas (Therms)', est.monthlyNonHvacGas);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthlyRows), 'Monthly Breakdown');

  const reconRows = [
    ['Reconciliation to Billed Baseline', 'Estimate', 'Billed Baseline', 'Difference'],
    [
      'Electricity (kWh)',
      Math.round(est.totalKwh),
      Math.round(data.billed.kwh),
      Math.round(est.totalKwh - data.billed.kwh),
    ],
    [
      'Electric Demand (kW)',
      Math.round(est.totalKw * 10) / 10,
      Math.round(data.billed.kw * 10) / 10,
      Math.round((est.totalKw - data.billed.kw) * 10) / 10,
    ],
    [
      'Natural Gas (Therms)',
      Math.round(est.totalGas),
      Math.round(data.billed.gas),
      Math.round(est.totalGas - data.billed.gas),
    ],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reconRows), 'Reconciliation');

  const fname = 'HVAC Load Estimation - ' + data.buildingName.replace(/[\\/:*?"<>|]/g, '') + '.xlsx';
  XLSX.writeFile(wb, fname);
  showToast('Exported to Excel ✓');
}

/* ── Shared HTML content used by both the Word and PDF exports ── */
function _hvlExportBodyHtml(data) {
  const est = data.est;
  const fmt = (n) => Math.round(n).toLocaleString();
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
  const money = (n) =>
    '$' + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let h = '';
  h += `<h1>HVAC Load Estimation</h1>`;
  h += `<table class="hvl-x-meta"><tr><td>Building</td><td>${_esc(data.buildingName)}</td></tr>`;
  h += `<tr><td>Method</td><td>${_esc(data.method)}</td></tr>`;
  h += `<tr><td>Generated</td><td>${_esc(data.generatedAt.toLocaleString())}</td></tr>`;
  h += `<tr><td>Last Saved</td><td>${_esc(data.savedAt ? data.savedAt.toLocaleString() : 'Not saved yet')}</td></tr></table>`;

  h += `<h2>Summary</h2>`;
  h += `<table class="hvl-x-tbl"><tr><th>Annual Total</th><th>Heating and Cooling</th><th>Other</th><th>Total</th></tr>`;
  h += `<tr><td>Electricity (kWh)</td><td>${fmt(est.hvacKwh)}</td><td>${fmt(est.nonHvacKwh)}</td><td>${fmt(est.totalKwh)}</td></tr>`;
  h += `<tr><td>Electric Demand (kW)</td><td>${fmt1(est.hvacKw)}</td><td>${fmt1(est.nonHvacKw)}</td><td>${fmt1(est.totalKw)}</td></tr>`;
  h += `<tr><td>Natural Gas (Therms)</td><td>${fmt(est.hvacGasT)}</td><td>${fmt(est.nonHvacGas)}</td><td>${fmt(est.totalGas)}</td></tr></table>`;

  if (data.options.length) {
    h += `<h2>Setpoint Savings Options</h2>`;
    h += `<table class="hvl-x-tbl"><tr><th>Option</th><th>Occupied Heating</th><th>Occupied Cooling</th><th>Electricity Saved</th><th>Electric Demand Saved</th><th>Natural Gas Saved</th><th>Cost Saved</th></tr>`;
    data.options.forEach((o) => {
      h += `<tr><td>Option ${_esc(o.letter)}</td><td>${_esc(o.heatSP)}°F</td><td>${_esc(o.coolSP)}°F</td><td>${fmt(o.annualKwh)} kWh/yr</td><td>${fmt1(o.annualKw)} kW</td><td>${fmt(o.annualGas)} Therms/yr</td><td>${money(o.dollar)}/yr</td></tr>`;
    });
    h += `</table>`;
  } else if (data.optionsMissing.length) {
    h += `<h2>Setpoint Savings Options</h2><p>The following inputs are needed before savings options can be shown:</p><ul>`;
    data.optionsMissing.forEach((m) => (h += `<li>${_esc(m.label)}</li>`));
    h += `</ul>`;
  }

  h += `<h2>Inputs</h2><table class="hvl-x-tbl"><tr><th>Input</th><th>Value</th><th>Source</th></tr>`;
  data.inputs.forEach(
    (i) => (h += `<tr><td>${_esc(i.label)}</td><td>${_esc(i.value)}</td><td>${_esc(i.source)}</td></tr>`),
  );
  h += `</table>`;

  h += `<h2>Monthly Breakdown</h2><table class="hvl-x-tbl hvl-x-monthly"><tr><th>Category</th>${_HVL_MONTHS_FULL.map((m) => `<th>${m.slice(0, 3)}</th>`).join('')}<th>Annual</th></tr>`;
  const addRow = (label, arr) =>
    (h += `<tr><td>${_esc(label)}</td>${arr.map((v) => `<td>${fmt1(v)}</td>`).join('')}<td><strong>${fmt1(arr.reduce((s, v) => s + v, 0))}</strong></td></tr>`);
  addRow('Cooling Electricity (kWh)', est.monthlyCoolKwh);
  addRow('Heating Electricity (kWh)', est.monthlyHeatKwh);
  addRow('Other Electricity (kWh)', est.monthlyNonHvacKwh);
  addRow('Heating and Cooling Electric Demand (kW)', est.monthlyHvacKw);
  addRow('Other Electric Demand (kW)', est.monthlyNonHvacKw);
  addRow('Total Electric Demand (kW)', est.monthlyTotalKw);
  addRow('Heating and Cooling Natural Gas (Therms)', est.monthlyHvacGas);
  addRow('Other Natural Gas (Therms)', est.monthlyNonHvacGas);
  h += `</table>`;

  h += `<h2>Reconciliation to Billed Baseline</h2><table class="hvl-x-tbl"><tr><th></th><th>Estimate</th><th>Billed Baseline</th><th>Difference</th></tr>`;
  h += `<tr><td>Electricity (kWh)</td><td>${fmt(est.totalKwh)}</td><td>${fmt(data.billed.kwh)}</td><td>${fmt(est.totalKwh - data.billed.kwh)}</td></tr>`;
  h += `<tr><td>Electric Demand (kW)</td><td>${fmt1(est.totalKw)}</td><td>${fmt1(data.billed.kw)}</td><td>${fmt1(est.totalKw - data.billed.kw)}</td></tr>`;
  h += `<tr><td>Natural Gas (Therms)</td><td>${fmt(est.totalGas)}</td><td>${fmt(data.billed.gas)}</td><td>${fmt(est.totalGas - data.billed.gas)}</td></tr>`;
  h += `</table>`;
  return h;
}
const _HVL_EXPORT_CSS = `
  body{font-family:Arial, sans-serif; color:#111; margin:0; padding:24px;}
  h1{font-size:20px;margin:0 0 12px 0;}
  h2{font-size:14px;margin:20px 0 8px 0;}
  table.hvl-x-meta td{padding:2px 8px 2px 0;font-size:12px;}
  table.hvl-x-meta td:first-child{font-weight:700;color:#444;}
  table.hvl-x-tbl{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:8px;}
  table.hvl-x-tbl th, table.hvl-x-tbl td{border:1px solid #999;padding:4px 6px;text-align:right;}
  table.hvl-x-tbl th:first-child, table.hvl-x-tbl td:first-child{text-align:left;}
  table.hvl-x-tbl th{background:#eee;}
  table.hvl-x-monthly th, table.hvl-x-monthly td{font-size:9px;padding:3px 4px;}
`;

/* ── Word export (.doc, mso-HTML wrapper — the site's existing Word export technique) ── */
function hvacLoadExportWord(projId) {
  const data = _hvlExportGuard(projId);
  if (!data) return;
  const bodyHtml = _hvlExportBodyHtml(data);
  const wordDocHtml =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
    'xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8">' +
    '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>' +
    '<w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
    '<style>' +
    _HVL_EXPORT_CSS +
    ' @page Section1 {size:8.5in 11in; margin:0.75in;} div.Section1 {page:Section1;}' +
    '</style>' +
    '<title>HVAC Load Estimation — ' +
    _esc(data.buildingName) +
    '</title></head>' +
    '<body><div class="Section1">' +
    bodyHtml +
    '</div></body></html>';
  const blob = new Blob(['﻿', wordDocHtml], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'HVAC Load Estimation - ' + data.buildingName.replace(/[\\/:*?"<>|]/g, '') + '.doc';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Exported to Word ✓');
}

/* ── PDF export (print-to-PDF, 8.5x11 — html2canvas + jsPDF, already loaded site-wide) ── */
function hvacLoadExportPdf(projId) {
  const data = _hvlExportGuard(projId);
  if (!data) return;
  if (typeof html2canvas === 'undefined' || !window.jspdf) {
    showToast('PDF export is unavailable — the PDF library did not load', 'error');
    return;
  }
  const bodyHtml = _hvlExportBodyHtml(data);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;background:#fff;';
  holder.innerHTML = `<style>${_HVL_EXPORT_CSS}</style><div style="width:816px">${bodyHtml}</div>`;
  document.body.appendChild(holder);
  showToast('Generating PDF...');
  html2canvas(holder, { scale: 2, backgroundColor: '#ffffff' })
    .then((canvas) => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });
      const pageW = 8.5,
        pageH = 11;
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      const imgData = canvas.toDataURL('image/png');
      doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = heightLeft - imgH;
        doc.addPage();
        doc.addImage(imgData, 'PNG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      doc.save('HVAC Load Estimation - ' + data.buildingName.replace(/[\\/:*?"<>|]/g, '') + '.pdf');
      showToast('Exported to PDF ✓');
    })
    .catch((err) => {
      console.error('HVAC Load Est PDF export failed:', err);
      showToast('PDF export failed: ' + (err.message || 'Unknown error'), 'error');
    })
    .finally(() => {
      document.body.removeChild(holder);
    });
}

/* ══════════════════════════════════════════════════════
         CALC TEMPLATES MODAL
         Unified catalog: ECM_TEMPLATES (ecm-calculators.js) is the single
         source of truth — 15 ECM calcs + solar + bas metadata entries.
      ══════════════════════════════════════════════════════ */

let _calcTemplateContext = null; // {projId, returnTo:'sv'|'ptab', targetMeasureId:null, bldgId:null}

/* Open calc templates targeted at a specific measure row */
function openCalcForMeasure(projId, msrId, returnTo) {
  openCalcTemplates(projId, returnTo || 'sv', msrId);
}

function openCalcTemplates(projId, returnTo, targetMeasureId) {
  // Resolve the target measure's building once, so both the ECM "Add as Measure"
  // flow and the BAS auto-populate can target the correct building instead of
  // silently defaulting to the first building in the project.
  let bldgId = null;
  if (targetMeasureId) {
    const sd = getProjSavingsData(projId);
    const m = sd.measures.find((x) => x.id === targetMeasureId);
    bldgId = m?.bldgId || null;
  }
  _calcTemplateContext = { projId, returnTo: returnTo || 'sv', targetMeasureId: targetMeasureId || null, bldgId };
  const wrap =
    _calcTemplateContext.returnTo === 'ptab'
      ? document.getElementById('ptab-savings')
      : document.getElementById('svDetailWrap');
  if (!wrap) return;
  const catalog = Object.values(ECM_TEMPLATES);
  wrap.innerHTML = `
          <div style="padding:20px;overflow-y:auto;flex:1">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
              <button class="btn btn-ghost btn-sm" onclick="closeCalcTemplate()">← Back to Savings</button>
              <h2 style="font-size:18px;font-weight:700;margin:0">📐 Energy Savings Calc Templates</h2>
            </div>
            <div style="font-size:13px;color:var(--text2);margin-bottom:20px">${
              _calcTemplateContext.targetMeasureId
                ? `<span style="display:inline-flex;align-items:center;gap:6px">Calc results will be applied to <strong style="color:var(--accent)">Measure #${(() => {
                    const sd = getProjSavingsData(projId);
                    const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
                    return m?.msrNum || '?';
                  })()}</strong> — <em>${(() => {
                    const sd = getProjSavingsData(projId);
                    const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
                    return m?.desc || '(no description)';
                  })()}</em></span>`
                : 'Select a calculator template to estimate energy savings. Results can be added as a new savings measure row.'
            }</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
              ${catalog
                .map(
                  (t) => `
                <button class="card" style="background:var(--s1);padding:18px;border:1px solid var(--border);cursor:pointer;text-align:left;transition:all .15s" onclick="launchCalcTemplate('${t.id}',${projId})"
                  onmouseenter="this.style.borderColor='var(--accent)'"
                  onmouseleave="this.style.borderColor='var(--border)'">
                  <div style="font-size:28px;margin-bottom:8px">${t.icon}</div>
                  <div style="font-size:14px;font-weight:700;margin-bottom:5px;color:var(--text)">${t.name}</div>
                  <div style="font-size:12px;color:var(--text2);line-height:1.6">${t.description}</div>
                  <div style="font-size:10px;color:var(--em);margin-top:8px;font-weight:600">✓ Available</div>
                </button>`,
                )
                .join('')}
            </div>
          </div>`;
}

function closeCalcTemplate() {
  if (!_calcTemplateContext) return;
  const { projId, returnTo } = _calcTemplateContext;
  // Restore parent savings header buttons
  const hdrBtns = document.getElementById('svDetailHdrBtns');
  if (hdrBtns) hdrBtns.style.display = '';
  if (returnTo === 'ptab') {
    initSavingsTab(projId);
  } else {
    renderSvDetail();
  }
  _calcTemplateContext = null;
}

function launchCalcTemplate(templateId, projId) {
  if (templateId === 'solar') {
    openSolarCalc(projId);
  } else if (templateId === 'bas') {
    openBASCalc(projId);
  } else if (ECM_TEMPLATES[templateId]) {
    openEcmCalcInline(templateId, projId);
  } else {
    showToast(`${templateId.toUpperCase()} calculator not found`);
  }
}

/* Launch one of the 15 ECM_TEMPLATES calcs inline, in the same container
   openBASCalc/openSolarCalc use, so the unified catalog is one door for
   every calculator (full-page, not a modal). */
function openEcmCalcInline(templateId, projId) {
  if (!_calcTemplateContext) _calcTemplateContext = { projId, returnTo: 'sv' };
  const wrap =
    _calcTemplateContext.returnTo === 'ptab'
      ? document.getElementById('ptab-savings')
      : document.getElementById('svDetailWrap');
  if (!wrap) return;
  const hdrBtns = document.getElementById('svDetailHdrBtns');
  if (hdrBtns) hdrBtns.style.display = 'none';
  const bldgId = _calcTemplateContext.bldgId || null;
  const bldg = bldgId && typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;

  wrap.innerHTML = `<div id="ecm-inline-wrap" style="display:flex;flex-direction:column;height:100%"></div>`;
  const container = document.getElementById('ecm-inline-wrap');

  renderEcmCalculator(
    templateId,
    container,
    null, // no saved values on first open
    function onBack() {
      openCalcTemplates(
        _calcTemplateContext.projId,
        _calcTemplateContext.returnTo,
        _calcTemplateContext.targetMeasureId,
      );
    },
    function onCalculate(tid, inputs, results) {
      // Results are rendered inline by renderEcmResults (Save to Project + Add as Measure buttons)
    },
    { projId, buildingId: bldgId, buildingName: bldg?.name || null },
  );
  // renderEcmCalculator's own "← Back" button just fires onBack; make the label
  // consistent with the rest of the calc-templates flow.
  const backBtn = container.querySelector('#ecm-back-btn');
  if (backBtn) backBtn.textContent = '← Templates';
}

/* ══════════════════════════════════════════════════════
         SOLAR CALC — Full-page inline view
         PDR-Compliant: 8 Sections (A-H), live auto-calc
      ══════════════════════════════════════════════════════ */
function openSolarCalc(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!_calcTemplateContext) _calcTemplateContext = { projId, returnTo: 'sv' };
  const wrap =
    _calcTemplateContext.returnTo === 'ptab'
      ? document.getElementById('ptab-savings')
      : document.getElementById('svDetailWrap');
  if (!wrap) return;
  // Hide parent savings buttons while solar calc is open
  const hdrBtns = document.getElementById('svDetailHdrBtns');
  if (hdrBtns) hdrBtns.style.display = 'none';
  const sv = p?.solarCalc || {};
  const arrays = p?.solarArrays || [];
  // Build building/meter options from project utility data
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : p.buildings || [];
  let bldgMeterOpts = '<option value="">All buildings / All electric meters</option>';
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (m.type !== 'electric' && m.commodity !== 'Electric') return;
      const label = (b.name || 'Building') + ' — ' + (m.name || m.commodity || 'Electric');
      const val = b.id + '|' + m.id;
      const sel = sv.selectedMeter === val ? 'selected' : '';
      bldgMeterOpts += `<option value="${val}" ${sel}>${label}</option>`;
    });
  });
  const blBills = _solarGetBaselineBills(p, sv.selectedMeter || '');
  const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DEFS = [8995, 9972, 12436, 13663, 17115, 17595, 17494, 16258, 14113, 12341, 9096, 7063];
  const DEFCF = [0.15, 0.17, 0.22, 0.27, 0.35, 0.4, 0.45, 0.42, 0.33, 0.25, 0.18, 0.2];
  const bl = sv.blOverrides || {};

  wrap.innerHTML = `
          <div style="padding:20px;overflow-y:auto;flex:1" id="sc-main-wrap">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
              <button class="btn btn-ghost btn-sm" onclick="openCalcTemplates(${projId},'${_calcTemplateContext.returnTo}')">← Templates</button>
              <h2 style="font-size:18px;font-weight:700;margin:0">☀️ Solar Calc</h2>
              <div style="flex:1"></div>
              <button class="btn btn-ghost btn-sm" onclick="solarSaveInputs(${projId})">💾 Save</button>
            </div>

            <!-- SUMMARY KPIs — always visible, live-updating -->
            <div id="sc-summary" style="margin-bottom:16px"></div>

            <!-- ═══ A — BASELINE UTILITY DEMAND & CONSUMPTION ═══ -->
            <div class="card" style="margin-bottom:16px">
              <div class="card-hdr"><span class="card-title">A — Baseline Utility Demand &amp; Consumption</span>
                <select class="fs" id="sc-meterSelect" style="width:320px;font-size:11px" onchange="_scMeterChanged(${projId})">${bldgMeterOpts}</select>
              </div>
              <div style="padding:12px;overflow-x:auto">
                <div style="font-size:11px;color:var(--text2);margin-bottom:8px">Row-per-month bill data. ECA/EER/PTS/TDC columns are per-bill <b>rates</b>, not dollar amounts.</div>
                <table class="dtbl" style="min-width:1500px;font-size:10px;border-collapse:collapse" id="sc-baseline-tbl">
                  <thead><tr>
                    ${['Month', 'Start Date', 'End Date', 'Days', 'Bill Amt $'].map((h) => `<th style="text-align:center;padding:3px 4px;font-size:9px">${h}</th>`).join('')}
                    ${['kWh', 'Peak kW', 'Fac kW', 'Off-Peak kWh'].map((h) => `<th style="text-align:center;padding:3px 4px;font-size:9px;${h === 'kWh' ? 'border-left:2px solid var(--border)' : ''}">${h}</th>`).join('')}
                    ${['Start ECA', 'End ECA', 'Start EER', 'End EER', 'Start PTS', 'End PTS', 'Start TDC', 'End TDC'].map((h) => `<th style="text-align:center;padding:3px 4px;font-size:9px;${h === 'Start ECA' ? 'border-left:2px solid var(--border)' : ''}">${h}</th>`).join('')}
                  </tr></thead>
                  <tbody>
                    ${MO.map((m, i) => {
                      const is = 'width:64px;text-align:right;padding:3px 4px;font-size:10px';
                      const isd = 'width:90px;padding:3px 4px;font-size:10px';
                      const bg = i % 2 ? 'background:rgba(255,255,255,0.015)' : '';
                      const v = (key, fb) => bl[key]?.[i] || fb?.[i] || '';
                      return `<tr style="${bg}">
                        <td style="font-weight:600;padding:3px 6px;font-size:11px">${m}</td>
                        <td><input class="fi sc-bl sc-bl-startDate" data-mi="${i}" type="date" style="${isd}" value="${v('startDate', blBills.startDate)}"></td>
                        <td><input class="fi sc-bl sc-bl-endDate" data-mi="${i}" type="date" style="${isd}" value="${v('endDate', blBills.endDate)}"></td>
                        <td class="sc-bl-days" data-mi="${i}" style="text-align:center;font-family:var(--mono);font-size:10px;color:var(--text2)">—</td>
                        <td><input class="fi sc-bl sc-bl-billAmt" data-mi="${i}" type="number" style="${is}" value="${v('billAmt', blBills.totalCost)}"></td>
                        <td style="border-left:2px solid var(--border)"><input class="fi sc-bl sc-bl-kwh" data-mi="${i}" type="number" style="${is}" value="${v('kwh', blBills.kwh)}"></td>
                        <td><input class="fi sc-bl sc-bl-kw" data-mi="${i}" type="number" style="${is}" value="${v('kw', blBills.billedKw)}"></td>
                        <td><input class="fi sc-bl sc-bl-fackw" data-mi="${i}" type="number" style="${is}" value="${v('fackw', blBills.facKw)}"></td>
                        <td><input class="fi sc-bl sc-bl-offpk" data-mi="${i}" type="number" style="${is}" value="${v('offpk', blBills.offPeakKwh)}"></td>
                        <td style="border-left:2px solid var(--border)"><input class="fi sc-bl sc-bl-ecaStart" data-mi="${i}" type="number" step="any" style="${is}" value="${v('ecaStart', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-ecaEnd" data-mi="${i}" type="number" step="any" style="${is}" value="${v('ecaEnd', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-eerStart" data-mi="${i}" type="number" step="any" style="${is}" value="${v('eerStart', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-eerEnd" data-mi="${i}" type="number" step="any" style="${is}" value="${v('eerEnd', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-ptsStart" data-mi="${i}" type="number" step="any" style="${is}" value="${v('ptsStart', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-ptsEnd" data-mi="${i}" type="number" step="any" style="${is}" value="${v('ptsEnd', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-tdcStart" data-mi="${i}" type="number" step="any" style="${is}" value="${v('tdcStart', [])}"></td>
                        <td><input class="fi sc-bl sc-bl-tdcEnd" data-mi="${i}" type="number" step="any" style="${is}" value="${v('tdcEnd', [])}"></td>
                      </tr>`;
                    }).join('')}
                    <tr style="background:rgba(59,130,246,0.06);font-weight:700;border-top:2px solid var(--border)">
                      <td style="font-weight:800;padding:4px 6px">TOTALS</td><td></td><td></td><td></td>
                      <td id="sc-bl-tot-billAmt" style="text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px">—</td>
                      <td id="sc-bl-tot-kwh" style="text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px;border-left:2px solid var(--border)">—</td>
                      <td id="sc-bl-tot-kw" style="text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px">—</td>
                      <td id="sc-bl-tot-fackw" style="text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px">—</td>
                      <td id="sc-bl-tot-offpk" style="text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px">—</td>
                      <td colspan="8"></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- ═══ B — RATE CARD ═══ -->
            <div class="card" style="margin-bottom:16px">
              <div class="card-hdr"><span class="card-title">B — Rate Card</span>
                <select class="fs" id="sc-rateSchedule" style="width:280px;font-size:11px">
                  <option value="custom">Custom / Manual Entry</option>
                  <option value="2LGSF" ${(sv.rateScheduleName || '2LGSF') === '2LGSF' ? 'selected' : ''}>Evergy 2LGSF — Large General Service</option>
                  <option value="2LGSEW" ${sv.rateScheduleName === '2LGSEW' ? 'selected' : ''}>Evergy 2LGSEW — Large General Service Wind</option>
                  <option value="2MGAEW" ${sv.rateScheduleName === '2MGAEW' ? 'selected' : ''}>Evergy 2MGAEW — Medium General All-Electric Wind</option>
                  <option value="2SGSE" ${sv.rateScheduleName === '2SGSE' ? 'selected' : ''}>Evergy 2SGSE — Small General Service</option>
                </select>
              </div>
              <div style="padding:20px 24px;font-family:var(--mono);font-size:13px;line-height:2.2;white-space:pre;overflow-x:auto;color:var(--text)" id="sc-ratecard-body"></div>
            </div>

            <!-- ═══ C — SOLAR PRODUCTION ═══ -->
            <div class="card" style="margin-bottom:16px">
              <div class="card-hdr"><span class="card-title">C — Solar Production per Helioscope Analysis</span>
                <button class="btn btn-ghost btn-sm" onclick="solarAddArray(${projId})">+ Add Array</button>
              </div>
              <div style="padding:12px;overflow-x:auto" id="sc-arrays-wrap">
                ${
                  arrays.length === 0
                    ? `
                  <div style="font-size:12px;color:var(--text2);margin-bottom:8px">No arrays defined yet. Add an array or enter production manually below.</div>
                  <table class="dtbl" style="min-width:700px;font-size:10px" id="sc-prod-tbl">
                    <thead><tr><th></th>${MO.map((m) => '<th style="text-align:center">' + m + '</th>').join('')}<th style="font-weight:800;text-align:right">Annual</th></tr></thead>
                    <tbody><tr><td style="font-weight:600">kWh</td>
                      ${MO.map((m, i) => '<td><input class="fi sc-inp sc-prod" id="sc-prod-' + i + '" type="number" style="width:62px;text-align:right;padding:3px 5px;font-size:11px" value="' + (sv.production ? sv.production[i] : DEFS[i]) + '"></td>').join('')}
                      <td style="font-weight:800;font-family:var(--mono);text-align:right" id="sc-prod-total">—</td>
                    </tr></tbody>
                  </table>
                `
                    : ''
                }
                ${arrays
                  .map(
                    (arr, ai) => `
                  <div class="card" style="background:var(--s1);padding:12px;margin-bottom:10px;border:1px solid var(--border)" data-array-id="${arr.id}">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                      <input class="fi sc-arr-name" data-ai="${ai}" value="${arr.name || 'Array ' + (ai + 1)}" style="flex:1;font-weight:700;font-size:13px">
                      <input class="fi sc-inp sc-arr-kw" data-ai="${ai}" type="number" value="${arr.kw || 0}" style="width:80px" placeholder="kW DC">
                      <span style="font-size:11px;color:var(--text2)">kW DC</span>
                      <select class="fs sc-arr-src" data-ai="${ai}" style="width:110px;font-size:11px">
                        <option value="helioscope" ${arr.source === 'helioscope' ? 'selected' : ''}>Helioscope</option>
                        <option value="pvwatts" ${arr.source === 'pvwatts' ? 'selected' : ''}>PVWatts</option>
                        <option value="manual" ${arr.source === 'manual' ? 'selected' : ''}>Manual</option>
                      </select>
                      <button class="btn btn-ghost btn-sm" onclick="solarRemoveArray(${projId},${ai})" style="color:var(--red)">✕</button>
                    </div>
                    <table class="dtbl" style="min-width:860px;font-size:10px">
                      <thead><tr><th style="width:70px"></th>${MO.map((m) => '<th style="text-align:center;width:54px">' + m + '</th>').join('')}<th style="text-align:right;font-weight:800">Annual</th></tr></thead>
                      <tbody>
                        <tr><td style="font-size:9px;color:var(--text2);font-weight:600">kW %</td>
                          ${MO.map((m, mi) => '<td><input class="fi sc-inp sc-arr-capfactor" data-ai="' + ai + '" data-mi="' + mi + '" type="number" step="0.01" style="width:48px;text-align:right;padding:2px 3px;font-size:9px" value="' + (arr.capFactor ? arr.capFactor[mi] : DEFCF[mi]) + '"></td>').join('')}<td></td></tr>
                        <tr><td style="font-size:9px;color:var(--text2);font-weight:600">Array kW</td>
                          ${MO.map((m, mi) => '<td class="sc-arr-arraykw" data-ai="' + ai + '" data-mi="' + mi + '" style="text-align:right;font-family:var(--mono);font-size:9px;padding:2px 3px;color:var(--text2)">—</td>').join('')}<td></td></tr>
                        <tr><td style="font-weight:600">kWh</td>
                          ${MO.map((m, mi) => '<td><input class="fi sc-inp sc-arr-prod" data-ai="' + ai + '" data-mi="' + mi + '" type="number" style="width:54px;text-align:right;padding:3px 4px;font-size:10px" value="' + (arr.production ? arr.production[mi] : DEFS[mi]) + '"></td>').join('')}
                          <td style="text-align:right;font-weight:700;font-family:var(--mono)" class="sc-arr-total" data-ai="${ai}">—</td></tr>
                        <tr><td style="font-size:9px;color:var(--accent);font-weight:600">Scaled kW</td>
                          ${MO.map((m, mi) => '<td class="sc-arr-scaledkw" data-ai="' + ai + '" data-mi="' + mi + '" style="text-align:right;font-family:var(--mono);font-size:9px;padding:2px 3px;color:var(--accent)">—</td>').join('')}<td></td></tr>
                        <tr><td style="font-size:9px;color:var(--accent);font-weight:600">Scaled kWh</td>
                          ${MO.map((m, mi) => '<td class="sc-arr-scaledkwh" data-ai="' + ai + '" data-mi="' + mi + '" style="text-align:right;font-family:var(--mono);font-size:9px;padding:2px 3px;color:var(--accent)">—</td>').join('')}
                          <td class="sc-arr-scaledtotal" data-ai="${ai}" style="text-align:right;font-weight:700;font-family:var(--mono);font-size:9px;color:var(--accent)">—</td></tr>
                      </tbody>
                    </table>
                  </div>
                `,
                  )
                  .join('')}
              </div>
            </div>

            <!-- ═══ SYSTEM CONFIG ═══ -->
            <div class="card" style="margin-bottom:16px">
              <div class="card-hdr"><span class="card-title">System Configuration</span></div>
              <div style="padding:16px">
                <div class="f2"><div class="fg"><label class="fl">Total Array Size (kW DC)</label><input class="fi sc-inp" id="sc-arrayKw" type="number" value="${sv.arrayKw || arrays.reduce((a, ar) => a + (ar.kw || 0), 0) || 115}"></div>
                  <div class="fg"><label class="fl">Array Cost ($/Watt)</label><input class="fi sc-inp" id="sc-costPerWatt" type="number" value="${sv.costPerWatt || 2.5}"></div></div>
                <div class="f3"><div class="fg"><label class="fl">Tax Credit %</label><input class="fi sc-inp" id="sc-taxCredit" type="number" value="${sv.taxCredit || 30}"></div>
                  <div class="fg"><label class="fl">Net Metering Max kW</label><input class="fi sc-inp" id="sc-netMeterMax" type="number" value="${sv.netMeterMax || 150}"></div>
                  <div class="fg"><label class="fl">Savings % (pre-solar)</label><input class="fi sc-inp" id="sc-savingsPct" type="number" value="${sv.savingsPct || 0}" placeholder="0"><div class="fhint">BAS/other savings applied before solar (Section E)</div></div></div>
                <div class="f2"><div class="fg"><label class="fl">Billing kW Override</label><input class="fi sc-inp" id="sc-billingKw" type="number" value="${sv.billingKw || ''}" placeholder="Auto from baseline"></div>
                  <div class="fg"><label class="fl">Summer / Winter Change</label><div style="display:flex;gap:6px;align-items:center"><input class="fi sc-inp" id="sc-summerChange" type="text" value="${sv.summerChange || '5/31'}" style="width:65px;text-align:center"><span style="color:var(--text3)">/</span><input class="fi sc-inp" id="sc-winterChange" type="text" value="${sv.winterChange || '9/30'}" style="width:65px;text-align:center"></div></div></div>
                <div class="fg" style="max-width:200px"><label class="fl">ECA Min kWh Threshold</label><input class="fi sc-inp" id="sc-ecaThreshold" type="number" value="${sv.ecaThreshold || 18813.204}"></div>
              </div>
            </div>

            <!-- ═══ RESULTS D-H — always visible, live-updating ═══ -->
            <div id="sc-results"></div>

            <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
              ${
                _calcTemplateContext?.targetMeasureId
                  ? `<button class="btn btn-em btn-sm" onclick="solarApplyToMeasure(${projId})">⚡ Apply to Measure #${(() => {
                      const sd = getProjSavingsData(projId);
                      const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
                      return m?.msrNum || '?';
                    })()}</button>`
                  : `<button class="btn btn-em btn-sm" onclick="solarAddAsMeasure(${projId})">+ Add as New Measure</button>`
              }
            </div>
          </div>`;

  // Build rate card
  _scBuildRateCard(sv);
  // Compute derived fields
  _scComputeDays();
  _scComputeTotals();
  _scUpdateProdTotal();
  _scUpdateArrayDerived();
  // Initial live calc
  _scLiveCalc(projId);
  // Attach live-calc listeners to ALL inputs
  document
    .querySelectorAll('#sc-main-wrap .sc-inp, #sc-main-wrap .sc-bl, #sc-main-wrap .sc-rate, #sc-main-wrap .sc-prod')
    .forEach((inp) => {
      inp.addEventListener('input', () => _scLiveCalc(projId));
      inp.addEventListener('change', () => _scLiveCalc(projId));
    });
  document.querySelectorAll('.sc-bl-startDate,.sc-bl-endDate').forEach((inp) =>
    inp.addEventListener('change', () => {
      _scComputeDays();
      _scLiveCalc(projId);
    }),
  );
  document.getElementById('sc-rateSchedule')?.addEventListener('change', () => {
    _scApplyPreset();
    _scBuildRateCard();
    _scLiveCalc(projId);
  });
}

/* ── Rate Card: exact Excel layout in monospaced pre-formatted text with inline inputs ── */
function _scBuildRateCard(sv) {
  const body = document.getElementById('sc-ratecard-body');
  if (!body) return;
  const pf = (id, def) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || def : def;
  };
  const sched = document.getElementById('sc-rateSchedule')?.value || '2LGSF';
  const isW = sched.endsWith('W');
  // Use a real table that mimics the exact Excel compact card layout
  const ri =
    'class="fi sc-rate sc-inp" style="width:82px;font-family:var(--mono);font-size:12px;padding:2px 6px;text-align:right;background:var(--s3);border:1px solid var(--border);border-radius:4px" type="number" step="any"';
  body.innerHTML = `<table style="border-collapse:collapse;font-family:var(--mono);font-size:12px;line-height:1;width:100%;max-width:680px">
      <tr><td colspan="4" style="padding:6px 0;font-weight:700;color:var(--text2);font-size:11px;letter-spacing:1px">CUSTOMER CHARGE:</td></tr>
      <tr><td colspan="2" style="padding:2px 0"><span style="color:var(--text3);margin-right:10px">$</span><input ${ri} id="sc-custCharge" value="${pf('sc-custCharge', 48.9)}"></td><td colspan="2" style="color:var(--text3);font-size:11px;padding:2px 8px">$/mo</td></tr>
      <tr><td colspan="4" style="padding:10px 0 2px 0"><span style="color:var(--text2);font-size:11px;margin-right:12px">Franchise Fee</span><input ${ri} id="sc-franchiseFeeDecimal" value="${pf('sc-franchiseFeeDecimal', 0)}" style="width:72px;font-family:var(--mono);font-size:11px;padding:2px 4px;text-align:right;background:var(--s3);border:1px solid var(--border);border-radius:4px"><span style="margin:0 8px;color:var(--text3)"></span><input ${ri} id="sc-franchisePct" value="${pf('sc-franchisePct', 5.263)}" style="width:72px;font-family:var(--mono);font-size:11px;padding:2px 4px;text-align:right;background:var(--s3);border:1px solid var(--border);border-radius:4px"><span style="color:var(--text3);font-size:10px;margin-left:8px">(0 = tax exempt)</span></td></tr>
      <tr><td colspan="4" style="padding:10px 0 0 0;font-weight:700;color:var(--text2);font-size:11px;letter-spacing:1px">FACILITIES CHARGE:</td></tr>
      <tr><td colspan="2" style="padding:2px 0"><span style="color:var(--text3);margin-right:10px">$</span><input ${ri} id="sc-facRate" value="${pf('sc-facRate', 2.854)}"></td><td colspan="2" style="color:var(--text3);font-size:11px;padding:2px 8px">$/kW</td></tr>
      <tr><td colspan="4" style="padding:14px 0 4px 0;border-top:1px solid var(--border)"></td></tr>
      <tr style="color:var(--text2);font-size:10px;font-weight:700;letter-spacing:1px"><td style="width:200px">DEMAND CHARGE:</td><td style="text-align:center;width:140px;color:var(--amber)">SUMMER</td><td style="text-align:center;width:140px;color:var(--accent)">WINTER</td><td></td></tr>
      <tr><td style="padding:6px 0">NET METERING:</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-nmDemandSum" value="${pf('sc-nmDemandSum', 9.831)}"> <span style="color:var(--text3);font-size:10px">$/kW</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-nmDemandWin" value="${pf('sc-nmDemandWin', 1.327)}"> <span style="color:var(--text3);font-size:10px">$/kW</span></td><td></td></tr>
      <tr><td style="padding:6px 0">(standard):</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-demandSum" value="${pf('sc-demandSum', 3.995)}"> <span style="color:var(--text3);font-size:10px">$/kW</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-demandWin" value="${pf('sc-demandWin', 2.776)}"> <span style="color:var(--text3);font-size:10px">$/kW</span></td><td></td></tr>
      <tr><td colspan="4" style="padding:14px 0 4px 0;border-top:1px solid var(--border)"></td></tr>
      <tr style="color:var(--text2);font-size:10px;font-weight:700;letter-spacing:1px"><td>ENERGY CHARGE:</td><td style="text-align:center;color:var(--amber)">SUMMER</td><td style="text-align:center;color:var(--accent)">WINTER</td><td></td></tr>
      <tr><td style="padding:6px 0">On-Peak kWh</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-onPeakSum" value="${pf('sc-onPeakSum', 0.10304)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-onPeakWin" value="${pf('sc-onPeakWin', 0.03723)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="font-size:10px;color:var(--text3);padding-left:10px">Summer Change: <span id="sc-sumChangeDisp">${document.getElementById('sc-summerChange')?.value || '5/31'}</span></td></tr>
      <tr><td style="padding:6px 0">Off-Peak kWh</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-offPeakSum" value="${pf('sc-offPeakSum', 0.05734)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-offPeakWin" value="${pf('sc-offPeakWin', 0.03266)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="font-size:10px;color:var(--text3);padding-left:10px">Winter Change: <span id="sc-winChangeDisp">${document.getElementById('sc-winterChange')?.value || '9/30'}</span></td></tr>
      <tr><td colspan="4" style="padding:14px 0 4px 0;border-top:1px solid var(--border)"></td></tr>
      <tr style="color:var(--text2);font-size:10px;font-weight:700;letter-spacing:1px"><td>SOLAR RATE CHARGE:</td><td style="text-align:center;color:var(--amber)">SUMMER</td><td style="text-align:center;color:var(--accent)">WINTER</td><td></td></tr>
      <tr><td style="padding:6px 0">First 180 Hours</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier1Sum" value="${pf('sc-tier1Sum', 0.08551)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier1Win" value="${pf('sc-tier1Win', 0.04515)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td></tr>
      <tr><td style="padding:6px 0">Next 180 Hours</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier2Sum" value="${pf('sc-tier2Sum', 0.05362)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier2Win" value="${pf('sc-tier2Win', 0.02734)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td></tr>
      <tr><td style="padding:6px 0">Over 360 Hours</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier3Sum" value="${pf('sc-tier3Sum', 0.05425)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-tier3Win" value="${pf('sc-tier3Win', 0.02377)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td></tr>
      <tr><td style="padding:6px 0">Solar Over Production</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-overProdSum" value="${pf('sc-overProdSum', 0.03)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-overProdWin" value="${pf('sc-overProdWin', 0.03)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td></tr>
      <tr><td colspan="4" style="padding:14px 0 4px 0;border-top:1px solid var(--border)"></td></tr>
      <tr style="color:var(--text2);font-size:10px;font-weight:700;letter-spacing:1px"><td>RIDERS:</td><td style="text-align:center">RATE</td><td></td><td></td></tr>
      <tr><td style="padding:6px 0">ECA Rate</td><td style="text-align:center;padding:4px"><input ${ri} id="sc-ecaRate" value="${pf('sc-ecaRate', 0.03066)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td><td></td></tr>
      <tr><td style="padding:6px 0">EER Rate</td><td style="text-align:center;padding:4px"><input ${ri} id="sc-eerRate" value="${pf('sc-eerRate', 0)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td><td></td></tr>
      <tr><td style="padding:6px 0">PTS Rate</td><td style="text-align:center;padding:4px"><input ${ri} id="sc-ptsRate" value="${pf('sc-ptsRate', 0)}"> <span style="color:var(--text3);font-size:10px">$/kWh</span></td><td></td><td></td></tr>
      <tr><td style="padding:6px 0">TDC Charge</td><td style="text-align:center;padding:4px"><input ${ri} id="sc-tdcRate" value="${pf('sc-tdcRate', 0)}"> <span style="color:var(--text3);font-size:10px">$/kW</span></td><td></td><td></td></tr>
      <tr id="sc-renewRow1" style="${isW ? '' : 'display:none'}"><td colspan="4" style="padding:12px 0 4px 0;border-top:1px solid var(--border)"></td></tr>
      <tr id="sc-renewRow2" style="${isW ? '' : 'display:none'}"><td style="padding:6px 0">Renewable Participation Charge:</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-renewPart" value="${pf('sc-renewPart', 377.4)}"> <span style="color:var(--text3);font-size:10px">$/mo</span></td><td></td><td></td></tr>
      <tr id="sc-renewRow3" style="${isW ? '' : 'display:none'}"><td style="padding:6px 0">New Renewable Participation Charge:</td><td style="text-align:center;padding:4px"><span style="color:var(--text3)">$</span><input ${ri} id="sc-newRenewPart" value="${pf('sc-newRenewPart', 377.4)}"> <span style="color:var(--text3);font-size:10px">$/mo</span></td><td></td><td></td></tr>
      </table>`;
  // Re-attach listeners for rate card inputs
  body.querySelectorAll('.sc-rate').forEach((inp) => {
    inp.addEventListener('input', () => {
      const pid = _calcTemplateContext?.projId;
      if (pid) _scLiveCalc(pid);
    });
  });
}

/* ── Preset applicator ── */
function _scApplyPreset() {
  const sched = document.getElementById('sc-rateSchedule')?.value;
  const P = {
    '2LGSF': {
      custCharge: 48.9,
      facRate: 2.854,
      demandSum: 3.995,
      demandWin: 2.776,
      nmDemandSum: 9.831,
      nmDemandWin: 1.327,
      onPeakSum: 0.10304,
      onPeakWin: 0.03723,
      offPeakSum: 0.05734,
      offPeakWin: 0.03266,
      tier1Sum: 0.08551,
      tier1Win: 0.04515,
      tier2Sum: 0.05362,
      tier2Win: 0.02734,
      tier3Sum: 0.05425,
      tier3Win: 0.02377,
      overProdSum: 0.03,
      overProdWin: 0.03,
      renewPart: 0,
      newRenewPart: 0,
      ecaRate: 0.03066,
      eerRate: 0,
      ptsRate: 0,
      tdcRate: 0,
      franchisePct: 5.263,
      franchiseFeeDecimal: 0.05263,
    },
    '2MGAEW': {
      custCharge: 48.9,
      facRate: 2.854,
      demandSum: 3.995,
      demandWin: 2.776,
      nmDemandSum: 9.831,
      nmDemandWin: 1.327,
      onPeakSum: 0.06596,
      onPeakWin: 0.06612,
      offPeakSum: 0.04714,
      offPeakWin: 0.04017,
      tier1Sum: 0.08339,
      tier1Win: 0.03723,
      tier2Sum: 0.05362,
      tier2Win: 0.02734,
      tier3Sum: 0.05425,
      tier3Win: 0.02377,
      overProdSum: 0.03,
      overProdWin: 0.03,
      renewPart: 377.4,
      newRenewPart: 377.4,
      ecaRate: 0,
      eerRate: 0,
      ptsRate: 0,
      tdcRate: 0,
      franchisePct: 5.263,
      franchiseFeeDecimal: 0.05263,
    },
    '2LGSEW': {
      custCharge: 105.97,
      facRate: 3.069,
      demandSum: 6.62,
      demandWin: 3.361,
      nmDemandSum: 9.831,
      nmDemandWin: 1.327,
      onPeakSum: 0.06596,
      onPeakWin: 0.06612,
      offPeakSum: 0.04714,
      offPeakWin: 0.04017,
      tier1Sum: 0.06596,
      tier1Win: 0.06612,
      tier2Sum: 0.04714,
      tier2Win: 0.04017,
      tier3Sum: 0.02696,
      tier3Win: 0.03001,
      overProdSum: 0.03,
      overProdWin: 0.03,
      renewPart: 1528.84,
      newRenewPart: 1528.84,
      ecaRate: 0,
      eerRate: 0,
      ptsRate: 0,
      tdcRate: 0,
      franchisePct: 5.263,
      franchiseFeeDecimal: 0.05263,
    },
    '2SGSE': {
      custCharge: 17.7,
      facRate: 2.726,
      demandSum: 0,
      demandWin: 0,
      nmDemandSum: 0,
      nmDemandWin: 0,
      onPeakSum: 0.13675,
      onPeakWin: 0.10884,
      offPeakSum: 0.06005,
      offPeakWin: 0.05131,
      tier1Sum: 0.13675,
      tier1Win: 0.10884,
      tier2Sum: 0.06005,
      tier2Win: 0.05131,
      tier3Sum: 0.05366,
      tier3Win: 0.04046,
      overProdSum: 0.03,
      overProdWin: 0.03,
      renewPart: 0,
      newRenewPart: 0,
      ecaRate: 0,
      eerRate: 0,
      ptsRate: 0,
      tdcRate: 0,
      franchisePct: 5.263,
      franchiseFeeDecimal: 0.05263,
    },
  };
  if (!P[sched]) return;
  Object.entries(P[sched]).forEach(([k, v]) => {
    const el = document.getElementById('sc-' + k);
    if (el) el.value = v;
  });
}

/* ── Helpers ── */
function _scComputeDays() {
  for (let i = 0; i < 12; i++) {
    const s = document.querySelector(`.sc-bl-startDate[data-mi="${i}"]`)?.value,
      e = document.querySelector(`.sc-bl-endDate[data-mi="${i}"]`)?.value,
      c = document.querySelector(`.sc-bl-days[data-mi="${i}"]`);
    if (s && e && c) {
      const d = Math.round((new Date(e) - new Date(s)) / 864e5);
      c.textContent = d > 0 ? d : '—';
    } else if (c) c.textContent = '—';
  }
}
function _scComputeTotals() {
  ['billAmt', 'kwh', 'kw', 'fackw', 'offpk'].forEach((f) => {
    let s = 0;
    document.querySelectorAll(`.sc-bl-${f}`).forEach((inp) => {
      s += parseFloat(inp.value) || 0;
    });
    const el = document.getElementById(`sc-bl-tot-${f}`);
    if (el) el.textContent = f === 'billAmt' ? '$' + s.toFixed(2) : Math.round(s).toLocaleString();
  });
}
function _scUpdateProdTotal() {
  let t = 0;
  for (let i = 0; i < 12; i++) t += parseFloat(document.getElementById(`sc-prod-${i}`)?.value) || 0;
  const el = document.getElementById('sc-prod-total');
  if (el) el.textContent = Math.round(t).toLocaleString();
}
function _scUpdateArrayDerived() {
  document.querySelectorAll('.sc-arr-kw').forEach((kwI) => {
    const ai = kwI.dataset.ai,
      kw = parseFloat(kwI.value) || 0;
    let sT = 0;
    for (let mi = 0; mi < 12; mi++) {
      const cf = parseFloat(document.querySelector(`.sc-arr-capfactor[data-ai="${ai}"][data-mi="${mi}"]`)?.value) || 0;
      const akC = document.querySelector(`.sc-arr-arraykw[data-ai="${ai}"][data-mi="${mi}"]`);
      if (akC) akC.textContent = (kw * cf).toFixed(1);
      const skC = document.querySelector(`.sc-arr-scaledkw[data-ai="${ai}"][data-mi="${mi}"]`);
      if (skC) skC.textContent = (kw * cf).toFixed(1);
      const prod = parseFloat(document.querySelector(`.sc-arr-prod[data-ai="${ai}"][data-mi="${mi}"]`)?.value) || 0;
      const scaled = Math.round(prod * (kw / 115));
      const skwhC = document.querySelector(`.sc-arr-scaledkwh[data-ai="${ai}"][data-mi="${mi}"]`);
      if (skwhC) skwhC.textContent = scaled.toLocaleString();
      sT += scaled;
    }
    const stC = document.querySelector(`.sc-arr-scaledtotal[data-ai="${ai}"]`);
    if (stC) stC.textContent = sT.toLocaleString();
    let pT = 0;
    document.querySelectorAll(`.sc-arr-prod[data-ai="${ai}"]`).forEach((inp) => {
      pT += parseFloat(inp.value) || 0;
    });
    const tC = document.querySelector(`.sc-arr-total[data-ai="${ai}"]`);
    if (tC) tC.textContent = Math.round(pT).toLocaleString();
  });
}

function solarAddArray(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.solarArrays = p.solarArrays || [];
  const D = [8995, 9972, 12436, 13663, 17115, 17595, 17494, 16258, 14113, 12341, 9096, 7063];
  const CF = [0.15, 0.17, 0.22, 0.27, 0.35, 0.4, 0.45, 0.42, 0.33, 0.25, 0.18, 0.2];
  p.solarArrays.push({
    id: 'sa' + Date.now(),
    name: 'Array ' + (p.solarArrays.length + 1),
    kw: 115,
    production: [...D],
    capFactor: [...CF],
    source: 'helioscope',
  });
  sset('en_projects', projects);
  openSolarCalc(projId);
  showToast('Array added ✓');
}
function solarRemoveArray(projId, ai) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.solarArrays) return;
  p.solarArrays.splice(ai, 1);
  sset('en_projects', projects);
  openSolarCalc(projId);
  showToast('Array removed');
}
function _solarReadArraysFromDOM(p) {
  const arrays = p?.solarArrays || [];
  arrays.forEach((arr, ai) => {
    const nE = document.querySelector(`.sc-arr-name[data-ai="${ai}"]`);
    if (nE) arr.name = nE.value;
    const kE = document.querySelector(`.sc-arr-kw[data-ai="${ai}"]`);
    if (kE) arr.kw = parseFloat(kE.value) || 0;
    const sE = document.querySelector(`.sc-arr-src[data-ai="${ai}"]`);
    if (sE) arr.source = sE.value;
    arr.production = arr.production || Array(12).fill(0);
    arr.capFactor = arr.capFactor || Array(12).fill(0);
    for (let mi = 0; mi < 12; mi++) {
      const pI = document.querySelector(`.sc-arr-prod[data-ai="${ai}"][data-mi="${mi}"]`);
      if (pI) arr.production[mi] = parseFloat(pI.value) || 0;
      const cI = document.querySelector(`.sc-arr-capfactor[data-ai="${ai}"][data-mi="${mi}"]`);
      if (cI) arr.capFactor[mi] = parseFloat(cI.value) || 0;
    }
  });
  return arrays;
}
function _solarGetBaselineBills(p, meterFilter) {
  const R = {
    kwh: Array(12).fill(0),
    billedKw: Array(12).fill(0),
    facKw: Array(12).fill(0),
    onPeakKwh: Array(12).fill(0),
    offPeakKwh: Array(12).fill(0),
    totalCost: Array(12).fill(0),
    startDate: Array(12).fill(''),
    endDate: Array(12).fill(''),
    customerCharge: Array(12).fill(0),
    demandCharge: Array(12).fill(0),
    facilitiesCharge: Array(12).fill(0),
    ecaCharge: Array(12).fill(0),
    eerCharge: Array(12).fill(0),
    ptsCharge: Array(12).fill(0),
    tdcCharge: Array(12).fill(0),
    renewableCharge: Array(12).fill(0),
    franchiseFee: Array(12).fill(0),
    onPeakCost: Array(12).fill(0),
    offPeakCost: Array(12).fill(0),
  };
  const [filterBid, filterMid] = meterFilter ? meterFilter.split('|') : ['', ''];
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(p.id) : p?.buildings || [];
  bldgs.forEach((b) => {
    if (filterBid && b.id !== filterBid) return;
    (b.meters || []).forEach((m) => {
      if (m.type !== 'electric' && m.commodity !== 'Electric') return;
      if (filterMid && m.id !== filterMid) return;
      const blMonths = m.baseline?.months || []; // array of 'YYYY-MM' strings
      const bills = m.bills || [];
      // Filter to baseline-selected months only; if no baseline set, use all bills
      const use = blMonths.length
        ? bills.filter((bill) => {
            // Get year-month from bill end date to match baseline month format
            if (!bill.end) return false;
            const d = new Date(bill.end);
            if (isNaN(d)) return false;
            const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
            return blMonths.includes(ym);
          })
        : bills;
      // Accumulate raw bill data by calendar month (from end date)
      const moCount = Array(12).fill(0); // track count for averaging if >12 baseline months
      use.forEach((bill) => {
        let mi = -1;
        if (bill.end) {
          const d = new Date(bill.end);
          if (!isNaN(d)) mi = d.getMonth();
        }
        if (mi < 0 && bill.start) {
          const d = new Date(bill.start);
          if (!isNaN(d)) mi = d.getMonth();
        }
        if (mi < 0) return;
        moCount[mi]++;
        const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
        R.kwh[mi] += pf(bill.kwh) || pf(bill.usage);
        R.billedKw[mi] = Math.max(R.billedKw[mi], pf(bill.billedKW) || pf(bill.demandKW) || pf(bill.kw));
        R.facKw[mi] = Math.max(R.facKw[mi], pf(bill.facKW) || pf(bill.facilitiesKW));
        R.onPeakKwh[mi] += pf(bill.onPeakKwh);
        R.offPeakKwh[mi] += pf(bill.offPeakKwh);
        R.totalCost[mi] += pf(bill.totalCost);
        if (bill.start) R.startDate[mi] = bill.start;
        if (bill.end) R.endDate[mi] = bill.end;
        R.ecaCharge[mi] += pf(bill.ecaCharge);
        R.eerCharge[mi] += pf(bill.eerCharge);
        R.ptsCharge[mi] += pf(bill.ptsCharge);
        R.tdcCharge[mi] += pf(bill.tdcCharge);
        R.franchiseFee[mi] += pf(bill.franchiseFee);
        R.onPeakCost[mi] += pf(bill.onPeakCost);
        R.offPeakCost[mi] += pf(bill.offPeakCost);
      });
      // Average if multiple baseline years have data for the same calendar month
      for (let i = 0; i < 12; i++) {
        if (moCount[i] > 1) {
          const n = moCount[i];
          R.kwh[i] /= n;
          R.onPeakKwh[i] /= n;
          R.offPeakKwh[i] /= n;
          R.totalCost[i] /= n;
          R.ecaCharge[i] /= n;
          R.eerCharge[i] /= n;
          R.ptsCharge[i] /= n;
          R.tdcCharge[i] /= n;
          R.franchiseFee[i] /= n;
          R.onPeakCost[i] /= n;
          R.offPeakCost[i] /= n;
        }
      }
    });
  });
  return R;
}

/* ── When user changes building/meter selector, re-populate baseline and re-render ── */
function _scMeterChanged(projId) {
  const sel = document.getElementById('sc-meterSelect')?.value || '';
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.solarCalc = p.solarCalc || {};
  p.solarCalc.selectedMeter = sel;
  // Clear baseline overrides so fresh data loads
  p.solarCalc.blOverrides = {};
  sset('en_projects', projects);
  openSolarCalc(projId);
  showToast('Baseline loaded from selected meter ✓');
}

function solarSaveInputs(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  _solarReadArraysFromDOM(p);
  const prod = [];
  for (let i = 0; i < 12; i++) prod.push(parseFloat(document.getElementById(`sc-prod-${i}`)?.value) || 0);
  const bl = {};
  [
    'kwh',
    'kw',
    'fackw',
    'offpk',
    'billAmt',
    'startDate',
    'endDate',
    'ecaStart',
    'ecaEnd',
    'eerStart',
    'eerEnd',
    'ptsStart',
    'ptsEnd',
    'tdcStart',
    'tdcEnd',
  ].forEach((key) => {
    bl[key] = [];
    document.querySelectorAll(`.sc-bl-${key}`).forEach((inp) => {
      const mi = parseInt(inp.dataset.mi);
      bl[key][mi] = key.includes('Date') ? inp.value : parseFloat(inp.value) || 0;
    });
  });
  const gv = (id) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || 0 : 0;
  };
  p.solarCalc = {
    ...(p.solarCalc || {}),
    arrayKw: gv('sc-arrayKw'),
    costPerWatt: gv('sc-costPerWatt'),
    taxCredit: gv('sc-taxCredit'),
    netMeterMax: gv('sc-netMeterMax'),
    billingKw: gv('sc-billingKw'),
    savingsPct: gv('sc-savingsPct'),
    summerChange: document.getElementById('sc-summerChange')?.value || '5/31',
    winterChange: document.getElementById('sc-winterChange')?.value || '9/30',
    ecaThreshold: gv('sc-ecaThreshold') || 18813.204,
    rateScheduleName: document.getElementById('sc-rateSchedule')?.value || '2LGSF',
    production: prod,
    blOverrides: bl,
    franchisePct: gv('sc-franchisePct'),
    franchiseFeeDecimal: gv('sc-franchiseFeeDecimal'),
    custCharge: gv('sc-custCharge'),
    facRate: gv('sc-facRate'),
    demandSum: gv('sc-demandSum'),
    demandWin: gv('sc-demandWin'),
    nmDemandSum: gv('sc-nmDemandSum'),
    nmDemandWin: gv('sc-nmDemandWin'),
    onPeakSum: gv('sc-onPeakSum'),
    onPeakWin: gv('sc-onPeakWin'),
    offPeakSum: gv('sc-offPeakSum'),
    offPeakWin: gv('sc-offPeakWin'),
    tier1Sum: gv('sc-tier1Sum'),
    tier1Win: gv('sc-tier1Win'),
    tier2Sum: gv('sc-tier2Sum'),
    tier2Win: gv('sc-tier2Win'),
    tier3Sum: gv('sc-tier3Sum'),
    tier3Win: gv('sc-tier3Win'),
    overProdSum: gv('sc-overProdSum'),
    overProdWin: gv('sc-overProdWin'),
    renewPart: gv('sc-renewPart'),
    newRenewPart: gv('sc-newRenewPart'),
    ecaRate: gv('sc-ecaRate'),
    eerRate: gv('sc-eerRate'),
    ptsRate: gv('sc-ptsRate'),
    tdcRate: gv('sc-tdcRate'),
  };
  sset('en_projects', projects);
  showToast('Solar calc saved ✓');
}

/* ══════════════════════════════════════════════════════
         LIVE CALC ENGINE — runs on every input change
         Computes D, E, F, G, H and renders all tables + summary
      ══════════════════════════════════════════════════════ */
let _scCalcTimer = null;
function _scLiveCalc(projId) {
  // Debounce: wait 120ms after last input
  clearTimeout(_scCalcTimer);
  _scCalcTimer = setTimeout(() => _scDoCalc(projId), 120);
}

function _scDoCalc(projId) {
  _scComputeTotals();
  _scUpdateProdTotal();
  _scUpdateArrayDerived();
  _scComputeDays();
  const p = projects.find((x) => x.id === projId);
  const gv = (id) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || 0 : 0;
  };
  const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const arrayKw = gv('sc-arrayKw'),
    costPerWatt = gv('sc-costPerWatt'),
    taxCredit = gv('sc-taxCredit');
  const ffDec = gv('sc-franchiseFeeDecimal') || gv('sc-franchisePct') / 100;
  const savPct = gv('sc-savingsPct') / 100;
  const ecaThresh = gv('sc-ecaThreshold') || 18813.204;
  const sumChg = document.getElementById('sc-summerChange')?.value || '5/31';
  const winChg = document.getElementById('sc-winterChange')?.value || '9/30';
  const parseDS = (s, yr) => {
    const p = s.split('/').map(Number);
    return new Date(yr, p[0] - 1, p[1]);
  };
  const sched = document.getElementById('sc-rateSchedule')?.value || '2LGSF';
  const isW = sched.endsWith('W');
  // Rates
  const R = {
    cust: gv('sc-custCharge'),
    fac: gv('sc-facRate'),
    dS: gv('sc-demandSum'),
    dW: gv('sc-demandWin'),
    nmS: gv('sc-nmDemandSum'),
    nmW: gv('sc-nmDemandWin'),
    opS: gv('sc-onPeakSum'),
    opW: gv('sc-onPeakWin'),
    ofS: gv('sc-offPeakSum'),
    ofW: gv('sc-offPeakWin'),
    t1S: gv('sc-tier1Sum'),
    t1W: gv('sc-tier1Win'),
    t2S: gv('sc-tier2Sum'),
    t2W: gv('sc-tier2Win'),
    t3S: gv('sc-tier3Sum'),
    t3W: gv('sc-tier3Win'),
    opS2: gv('sc-overProdSum'),
    opW2: gv('sc-overProdWin'),
    rp: isW ? gv('sc-renewPart') : 0,
    eca: gv('sc-ecaRate'),
    eer: gv('sc-eerRate'),
    pts: gv('sc-ptsRate'),
    tdc: gv('sc-tdcRate'),
  };
  // Production
  const arrays = _solarReadArraysFromDOM(p);
  let prod = Array(12).fill(0),
    solKw = Array(12).fill(0);
  if (arrays.length > 0) {
    arrays.forEach((a) => {
      (a.production || []).forEach((v, i) => {
        prod[i] += v;
      });
      const kw = a.kw || 0;
      (a.capFactor || []).forEach((cf, i) => {
        solKw[i] += kw * cf;
      });
    });
  } else {
    for (let i = 0; i < 12; i++) prod[i] = parseFloat(document.getElementById(`sc-prod-${i}`)?.value) || 0;
  }
  const totProd = prod.reduce((a, b) => a + b, 0);
  // Baseline
  const bKwh = [],
    bKw = [],
    bFKw = [],
    bOff = [],
    bSD = [],
    bED = [];
  const bEcaS = [],
    bEcaE = [],
    bEerS = [],
    bEerE = [],
    bPtsS = [],
    bPtsE = [],
    bTdcS = [],
    bTdcE = [];
  for (let i = 0; i < 12; i++) {
    const q = (c) => parseFloat(document.querySelector(`.sc-bl-${c}[data-mi="${i}"]`)?.value) || 0;
    const qd = (c) => document.querySelector(`.sc-bl-${c}[data-mi="${i}"]`)?.value || '';
    bKwh.push(q('kwh'));
    bKw.push(q('kw'));
    bFKw.push(q('fackw'));
    bOff.push(q('offpk'));
    bSD.push(qd('startDate'));
    bED.push(qd('endDate'));
    bEcaS.push(q('ecaStart'));
    bEcaE.push(q('ecaEnd'));
    bEerS.push(q('eerStart'));
    bEerE.push(q('eerEnd'));
    bPtsS.push(q('ptsStart'));
    bPtsE.push(q('ptsEnd'));
    bTdcS.push(q('tdcStart'));
    bTdcE.push(q('tdcEnd'));
  }
  const bOn = bKwh.map((k, i) => Math.max(0, k - bOff[i]));
  const manKw = gv('sc-billingKw');

  // Proration helper
  function prorate(i) {
    const days = bSD[i] && bED[i] ? Math.round((new Date(bED[i]) - new Date(bSD[i])) / 864e5) : 30;
    const d = days > 0 ? days : 30;
    const yr = bSD[i] ? new Date(bSD[i]).getFullYear() : new Date().getFullYear();
    const sD = parseDS(sumChg, yr),
      wD = parseDS(winChg, yr);
    const st = bSD[i] ? new Date(bSD[i]) : new Date(yr, i, 1),
      en = bED[i] ? new Date(bED[i]) : new Date(yr, i + 1, 0);
    let sumD = 0,
      winD = 0;
    if (st < sD && en >= sD) {
      winD = Math.round((sD - st) / 864e5);
      sumD = d - winD;
    } else if (st < wD && en >= wD) {
      sumD = Math.round((wD - st) / 864e5);
      winD = d - sumD;
    } else if (st >= sD && st < wD) {
      sumD = d;
    } else {
      winD = d;
    }
    const sR = d > 0 ? sumD / d : 0,
      wR = d > 0 ? winD / d : 0;
    const smD = bSD[i] ? Math.min(d, Math.round((new Date(yr, st.getMonth() + 1, 0) - st) / 864e5)) : d;
    const emD = d - smD;
    const sKwh = +(bKwh[i] * (smD / d)).toFixed(4),
      eKwh = +(bKwh[i] * (emD / d)).toFixed(4);
    const ecaEl = Math.max(bKwh[i] - ecaThresh, 0),
      sEca = d > 0 ? +(ecaEl * (smD / d)).toFixed(4) : 0,
      eEca = ecaEl - sEca;
    return { d, sumD, winD, sR, wR, smD, emD, sKwh, eKwh, ecaEl, sEca, eEca, fKw: bFKw[i] || bKw[i] };
  }

  // Bill calculators
  function calcStd(i, kwh, akw, offpk, bkw) {
    const pr = prorate(i),
      bilKw = bkw || akw || manKw || 0,
      fkw = pr.fKw || bilKw;
    const onpk = Math.max(0, kwh - offpk);
    const sR = pr.sR,
      wR = pr.wR;
    const eOnPk = +(onpk * sR * R.opS).toFixed(2) + +(onpk * wR * R.opW).toFixed(2);
    const eOffPk = +(offpk * sR * R.ofS).toFixed(2) + +(offpk * wR * R.ofW).toFixed(2);
    const sBKw = pr.sumD > 0 ? (akw > R.dS ? bilKw * sR : R.dS * sR) : 0;
    const wBKw = pr.winD > 0 ? (akw > R.dW ? bilKw * wR : R.dW * wR) : 0;
    const eDem = +(sBKw * R.dS).toFixed(2) + +(wBKw * R.dW).toFixed(2);
    const eFac = +(fkw * R.fac).toFixed(2);
    const ecS = bEcaS[i] || R.eca,
      ecE = bEcaE[i] || R.eca;
    const eEca = +(pr.sEca * ecS).toFixed(2) + +(pr.eEca * ecE).toFixed(2);
    const erS = bEerS[i] || R.eer,
      erE = bEerE[i] || R.eer;
    const eEer = +(pr.sKwh * erS).toFixed(2) + +(pr.eKwh * erE).toFixed(2);
    const ptS = bPtsS[i] || R.pts,
      ptE = bPtsE[i] || R.pts;
    const ePts = ptS === ptE ? +(kwh * ptS).toFixed(2) : +(pr.sKwh * ptS).toFixed(2) + +(pr.eKwh * ptE).toFixed(2);
    const tdS = bTdcS[i] || R.tdc,
      tdE = bTdcE[i] || R.tdc;
    const eTdc = +(bilKw * (pr.smD / pr.d) * tdS).toFixed(2) + +(bilKw * (pr.emD / pr.d) * tdE).toFixed(2);
    const sub = R.cust + eDem + eFac + eOnPk + eOffPk + R.rp + eEca + eEer + ePts + eTdc;
    const ff = +(sub * ffDec).toFixed(2);
    const isSummer = pr.sumD >= pr.winD;
    return {
      mo: MO[i],
      cust: R.cust,
      dem: eDem,
      fac: eFac,
      onKwh: onpk,
      onPk: eOnPk,
      offKwh: offpk,
      offPk: eOffPk,
      noneKwh: 0,
      cons: eOnPk + eOffPk,
      ren: R.rp,
      eca: eEca,
      eer: eEer,
      pts: ePts,
      tdc: eTdc,
      sc: 0,
      ff,
      tot: sub + ff,
      kwh,
      akw,
      bilKw,
      fkw,
      isS: isSummer,
      pr,
    };
  }

  function calcNM(i, ex, sKwh, sKw) {
    const nKwh = Math.max(0, ex.kwh - sKwh),
      nAkw = Math.max(0, ex.akw - sKw),
      nBkw = Math.max(0, ex.bilKw - sKw),
      nFkw = Math.max(0, ex.fkw - sKw);
    const pr = ex.pr,
      sR = pr.sR,
      wR = pr.wR;
    const pCust = R.cust;
    const sBKw = pr.sumD > 0 ? (nBkw > R.dS ? nBkw * sR : R.dS * sR) : 0;
    const wBKw = pr.winD > 0 ? (nBkw > R.dW ? nBkw * wR : R.dW * wR) : 0;
    const pDem = +(sBKw * R.dS).toFixed(2) + +(wBKw * R.dW).toFixed(2);
    const pFac = +(nFkw * R.fac).toFixed(2);
    const sKwhS = nKwh * sR,
      sKwhW = nKwh * wR,
      sKwS = nBkw * sR,
      sKwW = nBkw * wR;
    let st1 = 0,
      st2 = 0,
      st3 = 0;
    if (sKwS > 0) {
      const r = sKwhS / sKwS;
      st1 = r > 180 ? sKwS * 180 : sKwhS;
      st2 = r > 360 ? sKwS * 180 : Math.max(0, sKwhS - st1);
      st3 = Math.max(0, sKwhS - st1 - st2);
    } else st1 = sKwhS;
    let wt1 = 0,
      wt2 = 0,
      wt3 = 0;
    if (sKwW > 0) {
      const r = sKwhW / sKwW;
      wt1 = r > 180 ? sKwW * 180 : sKwhW;
      wt2 = r > 360 ? sKwW * 180 : Math.max(0, sKwhW - wt1);
      wt3 = Math.max(0, sKwhW - wt1 - wt2);
    } else wt1 = sKwhW;
    const pT1 = +(st1 * R.t1S).toFixed(2) + +(wt1 * R.t1W).toFixed(2);
    const pT2 = +(st2 * R.t2S).toFixed(2) + +(wt2 * R.t2W).toFixed(2);
    const pT3 = +(st3 * R.t3S).toFixed(2) + +(wt3 * R.t3W).toFixed(2);
    const pCon = pT1 + pT2 + pT3;
    const ecaEl = Math.max(nKwh - ecaThresh, 0);
    const ecS = bEcaS[i] || R.eca,
      ecE = bEcaE[i] || R.eca;
    const pEca = +(ecaEl * (pr.smD / pr.d) * ecS).toFixed(2) + +(ecaEl * (pr.emD / pr.d) * ecE).toFixed(2);
    const erS = bEerS[i] || R.eer,
      erE = bEerE[i] || R.eer;
    const pEer = +(nKwh * (pr.smD / pr.d) * erS).toFixed(2) + +(nKwh * (pr.emD / pr.d) * erE).toFixed(2);
    const ptS = bPtsS[i] || R.pts,
      ptE = bPtsE[i] || R.pts;
    const pPts =
      ptS === ptE
        ? +(nKwh * ptS).toFixed(2)
        : +(nKwh * (pr.smD / pr.d) * ptS).toFixed(2) + +(nKwh * (pr.emD / pr.d) * ptE).toFixed(2);
    const tdS = bTdcS[i] || R.tdc,
      tdE = bTdcE[i] || R.tdc;
    const pTdc = +(nBkw * (pr.smD / pr.d) * tdS).toFixed(2) + +(nBkw * (pr.emD / pr.d) * tdE).toFixed(2);
    let opKwh = 0,
      sc = 0;
    if (sKwh > ex.kwh) {
      opKwh = sKwh - ex.kwh;
      sc = +(opKwh * (ex.isS ? R.opS2 : R.opW2)).toFixed(2);
    }
    const sub = pCust + pDem + pFac + pCon + pEca + pEer + pPts + pTdc;
    const ff = +(sub * ffDec).toFixed(2);
    return {
      mo: MO[i],
      cust: pCust,
      dem: pDem,
      fac: pFac,
      onKwh: st1 + wt1,
      onPk: pT1,
      offKwh: st2 + wt2,
      offPk: pT2,
      noneKwh: st3 + wt3,
      noneCh: pT3,
      cons: pCon,
      ren: 0,
      eca: pEca,
      eer: pEer,
      pts: pPts,
      tdc: pTdc,
      sc,
      ff,
      tot: sub + ff - sc,
      kwh: nKwh,
      akw: nAkw,
      bilKw: nBkw,
      fkw: nFkw,
      isS: ex.isS,
      t1: st1 + wt1,
      t2: st2 + wt2,
      t3: st3 + wt3,
      opKwh,
    };
  }

  function calcBTM(i, ex, sKwh, sKw) {
    const nKwh = Math.max(0, ex.kwh - sKwh),
      nAkw = Math.max(0, ex.akw - sKw),
      nBkw = Math.max(0, ex.bilKw - sKw),
      nFkw = Math.max(0, ex.fkw - sKw);
    const pr = ex.pr,
      sR = pr.sR,
      wR = pr.wR;
    const offR = ex.kwh > 0 ? ex.offKwh / ex.kwh : 0.4;
    const nOff = nKwh * offR,
      nOn = nKwh - nOff;
    const pOnPk = +(nOn * sR * R.opS).toFixed(2) + +(nOn * wR * R.opW).toFixed(2);
    const pOffPk = +(nOff * sR * R.ofS).toFixed(2) + +(nOff * wR * R.ofW).toFixed(2);
    const sBKw = pr.sumD > 0 ? nBkw * sR : 0,
      wBKw = pr.winD > 0 ? nBkw * wR : 0;
    const pDem = +(sBKw * R.nmS).toFixed(2) + +(wBKw * R.nmW).toFixed(2);
    const pFac = +(nFkw * R.fac).toFixed(2);
    const ecaEl = Math.max(nKwh - ecaThresh, 0);
    const ecS = bEcaS[i] || R.eca,
      ecE = bEcaE[i] || R.eca;
    const pEca = +(ecaEl * (pr.smD / pr.d) * ecS).toFixed(2) + +(ecaEl * (pr.emD / pr.d) * ecE).toFixed(2);
    const erS = bEerS[i] || R.eer,
      erE = bEerE[i] || R.eer;
    const pEer = +(nKwh * (pr.smD / pr.d) * erS).toFixed(2) + +(nKwh * (pr.emD / pr.d) * erE).toFixed(2);
    const ptS = bPtsS[i] || R.pts,
      ptE = bPtsE[i] || R.pts;
    const pPts =
      ptS === ptE
        ? +(nKwh * ptS).toFixed(2)
        : +(nKwh * (pr.smD / pr.d) * ptS).toFixed(2) + +(nKwh * (pr.emD / pr.d) * ptE).toFixed(2);
    const tdS = bTdcS[i] || R.tdc,
      tdE = bTdcE[i] || R.tdc;
    const pTdc = +(nBkw * (pr.smD / pr.d) * tdS).toFixed(2) + +(nBkw * (pr.emD / pr.d) * tdE).toFixed(2);
    const sub = R.cust + pDem + pFac + pOnPk + pOffPk + R.rp + pEca + pEer + pPts + pTdc;
    const ff = +(sub * ffDec).toFixed(2);
    return {
      mo: MO[i],
      cust: R.cust,
      dem: pDem,
      fac: pFac,
      onKwh: nOn,
      onPk: pOnPk,
      offKwh: nOff,
      offPk: pOffPk,
      noneKwh: 0,
      cons: pOnPk + pOffPk,
      ren: R.rp,
      eca: pEca,
      eer: pEer,
      pts: pPts,
      tdc: pTdc,
      sc: 0,
      ff,
      tot: sub + ff,
      kwh: nKwh,
      akw: nAkw,
      bilKw: nBkw,
      fkw: nFkw,
      isS: ex.isS,
    };
  }

  // Run all profiles
  const dP = [],
    eP = [],
    fP = [],
    gP = [],
    nmSav = [],
    btmSav = [];
  let dA = 0,
    eA = 0,
    fA = 0,
    gA = 0;
  for (let i = 0; i < 12; i++) {
    const bilKw = bKw[i] || manKw || 0;
    const d = calcStd(i, bKwh[i], bKw[i], bOff[i], bilKw);
    dP.push(d);
    dA += d.tot;
    const bsK = bKwh[i] * (1 - savPct),
      bsW = bKw[i] * (1 - savPct),
      bsO = bOff[i] * (1 - savPct),
      bsB = bilKw * (1 - savPct);
    const e = calcStd(i, bsK, bsW, bsO, bsB);
    eP.push(e);
    eA += e.tot;
    const sk = prod[i],
      skw = solKw[i];
    const f = calcNM(i, e, sk, skw);
    fP.push(f);
    fA += f.tot;
    const g = calcBTM(i, e, sk, skw);
    gP.push(g);
    gA += g.tot;
    nmSav.push({
      dS: e.dem - f.dem + (e.fac - f.fac) + (e.tdc - f.tdc),
      cS: e.onPk + e.offPk - f.cons,
      oP: f.sc,
      oS: e.cust - f.cust + (e.ren - f.ren) + (e.eca - f.eca) + (e.eer - f.eer) + (e.pts - f.pts) + (e.ff - f.ff),
      tS: e.tot - f.tot,
    });
    btmSav.push({
      dS: e.dem - g.dem + (e.fac - g.fac) + (e.tdc - g.tdc),
      cS: e.onPk + e.offPk - (g.onPk + g.offPk),
      oP: 0,
      oS: e.cust - g.cust + (e.ren - g.ren) + (e.eca - g.eca) + (e.eer - g.eer) + (e.pts - g.pts) + (e.ff - g.ff),
      tS: e.tot - g.tot,
    });
  }
  const nmTot = eA - fA,
    btmTot = eA - gA,
    best = Math.max(nmTot, btmTot);
  const totCost = arrayKw * 1000 * costPerWatt,
    costAT = totCost * (1 - taxCredit / 100);
  const payback = best > 0 ? costAT / best : 0;

  // Formatters
  const fn = (n) => Math.round(n).toLocaleString();
  const fd = (n) => '$' + (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString();
  const f2 = (n) => (n < 0 ? '-$' + Math.abs(n).toFixed(2) : '$' + n.toFixed(2));
  const sa = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  const mc = 'text-align:right;font-family:var(--mono);font-size:10px;padding:3px 4px';
  const hc = 'text-align:center;font-size:9px;padding:3px 4px;white-space:nowrap';

  // Summary KPIs
  const sumEl = document.getElementById('sc-summary');
  if (sumEl) {
    const noData = bKwh.every((k) => k === 0) && !manKw;
    const kpi = (lbl, val, col) =>
      `<div class="card" style="background:var(--s1);padding:10px 12px;text-align:center"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">${lbl}</div><div style="font-size:17px;font-weight:800;font-family:var(--mono);color:var(--${col})">${val}</div></div>`;
    sumEl.innerHTML = `${noData ? '<div style="background:var(--warn-dim);border:1px solid var(--warn);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--warn);margin-bottom:12px">⚠️ No baseline data — populate Section A for accurate results.</div>' : ''}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:8px">${kpi('Array', arrayKw + ' kW', 'accent')}${kpi('Production', fn(totProd) + ' kWh', 'em')}${kpi('Baseline $/yr', fd(dA), 'text')}${kpi('NM $/yr', fd(fA), 'teal')}${kpi('BTM $/yr', fd(gA), 'violet')}${kpi('NM Savings', fd(nmTot), 'green')}${kpi('BTM Savings', fd(btmTot), 'green')}${kpi('System Cost', fd(totCost), 'text')}${kpi('After Credit', fd(costAT), 'teal')}${kpi('Payback', payback.toFixed(1) + ' yrs', 'amber')}</div>`;
  }

  // Table builders — exact Excel match
  // Determine if rate has 3 tiers (None column visible) or 2 tiers (None hidden)
  const is3Tier = sched.match(/1LGA/i) ? true : false; // 1LGAE etc have 3 tiers; 2LGSF, 2MGAEW etc have 2
  const noneCS = is3Tier ? 2 : 0; // colspan for None group (0=hidden)

  function stdTbl(lbl, sec, prof, ann, savArr) {
    const showSav = !!savArr;
    let rows = '';
    prof.forEach((e, i) => {
      const bg = i % 2 ? 'background:rgba(255,255,255,0.015)' : '';
      let r = `<tr style="${bg}"><td style="font-weight:600;font-size:11px;padding:3px 6px">${MO[i]}</td><td style="${mc}">${e.akw ? e.akw.toFixed(1) : ''}</td><td style="${mc}">${e.bilKw ? e.bilKw.toFixed(1) : ''}</td><td style="${mc};font-weight:600">${fn(e.kwh)}</td><td style="${mc}">${fn(Math.round(e.onKwh))}</td><td style="${mc}">${f2(e.onPk)}</td><td style="${mc}">${fn(Math.round(e.offKwh))}</td><td style="${mc}">${f2(e.offPk)}</td>`;
      if (is3Tier)
        r += `<td style="${mc}">${e.noneKwh ? fn(Math.round(e.noneKwh)) : '-'}</td><td style="${mc}">${e.noneCh ? f2(e.noneCh) : '$-'}</td>`;
      r += `<td style="${mc};border-left:2px solid var(--border)">${f2(e.cust)}</td><td style="${mc}">${f2(e.dem)}</td><td style="${mc}">${f2(e.fac)}</td><td style="${mc}">${f2(e.cons)}</td><td style="${mc}">${e.ren > 0 ? f2(e.ren) : ''}</td><td style="${mc}">${f2(e.eca)}</td><td style="${mc}">${f2(e.eer)}</td><td style="${mc}">${f2(e.pts)}</td><td style="${mc}">${f2(e.tdc)}</td><td style="${mc};color:var(--amber)">${e.sc > 0 ? '-' + f2(e.sc) : ''}</td><td style="${mc}">${f2(e.ff)}</td><td style="${mc};font-weight:700;border-left:2px solid var(--border)">${f2(e.tot)}</td>`;
      if (showSav) {
        const s = savArr[i];
        r += `<td style="${mc}">${f2(s.dS)}</td><td style="${mc}">${f2(s.cS)}</td><td style="${mc}">${f2(s.oS)}</td><td style="${mc};font-weight:700;color:var(--green)">${f2(s.tS)}</td>`;
      }
      r += `</tr>`;
      rows += r;
    });
    const t = prof;
    let tot = `<tr style="background:rgba(59,130,246,0.06);font-weight:700;border-top:2px solid var(--border)"><td style="font-weight:800;padding:4px 6px"></td><td style="${mc}">${sa(t, 'akw').toFixed(1)}</td><td style="${mc}">${sa(t, 'bilKw').toFixed(1)}</td><td style="${mc};font-weight:800">${fn(sa(t, 'kwh'))}</td><td style="${mc}">${fn(Math.round(sa(t, 'onKwh')))}</td><td style="${mc}">${f2(sa(t, 'onPk'))}</td><td style="${mc}">${fn(Math.round(sa(t, 'offKwh')))}</td><td style="${mc}">${f2(sa(t, 'offPk'))}</td>`;
    if (is3Tier)
      tot += `<td style="${mc}">${fn(Math.round(sa(t, 'noneKwh')))}</td><td style="${mc}">${f2(sa(t, 'noneCh'))}</td>`;
    tot += `<td style="${mc};border-left:2px solid var(--border)">${f2(sa(t, 'cust'))}</td><td style="${mc}">${f2(sa(t, 'dem'))}</td><td style="${mc}">${f2(sa(t, 'fac'))}</td><td style="${mc}">${f2(sa(t, 'cons'))}</td><td style="${mc}">${f2(sa(t, 'ren'))}</td><td style="${mc}">${f2(sa(t, 'eca'))}</td><td style="${mc}">${f2(sa(t, 'eer'))}</td><td style="${mc}">${f2(sa(t, 'pts'))}</td><td style="${mc}">${f2(sa(t, 'tdc'))}</td><td style="${mc};color:var(--amber)">${sa(t, 'sc') > 0 ? '-' + f2(sa(t, 'sc')) : ''}</td><td style="${mc}">${f2(sa(t, 'ff'))}</td><td style="${mc};font-weight:800;border-left:2px solid var(--border)">${f2(ann)}</td>`;
    if (showSav) {
      const tD = savArr.reduce((a, s) => a + s.dS, 0),
        tC = savArr.reduce((a, s) => a + s.cS, 0),
        tO = savArr.reduce((a, s) => a + s.oS, 0),
        tS = savArr.reduce((a, s) => a + s.tS, 0);
      tot += `<td style="${mc};font-weight:700">${f2(tD)}</td><td style="${mc};font-weight:700">${f2(tC)}</td><td style="${mc};font-weight:700">${f2(tO)}</td><td style="${mc};font-weight:800;color:var(--green)">${f2(tS)}</td>`;
    }
    tot += `</tr>`;

    // Header row 1: group headers
    let h1 = `<tr><th style="${hc}" rowspan="2">Month</th><th style="${hc}" rowspan="2">ACTUAL KW</th><th style="${hc}" rowspan="2">BILLING KW</th><th style="${hc}" rowspan="2">kWh</th><th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">On-Peak kWh</th><th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">Off-Peak kWh</th>`;
    if (is3Tier) h1 += `<th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">None</th>`;
    h1 += `<th colspan="11" style="${hc};border-left:2px solid var(--border);border-bottom:1px solid var(--text3)">TOTALS</th><th style="${hc}" rowspan="2" colspan="1"></th>`;
    if (showSav)
      h1 += `<th colspan="4" style="${hc};border-left:2px solid var(--border);border-bottom:1px solid var(--text3)">SAVINGS</th>`;
    h1 += `</tr>`;

    // Header row 2: column headers
    let h2 = `<tr><th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th><th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th>`;
    if (is3Tier) h2 += `<th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th>`;
    h2 += `<th style="${hc};border-left:2px solid var(--border)">Customer Charge $</th><th style="${hc}">Demand Charge $</th><th style="${hc}">Facilities Charge $</th><th style="${hc}">Consumption Charges $</th><th style="${hc}">Renewable Participation Charge $</th><th style="${hc}">ECA Charge $</th><th style="${hc}">EER Charge $</th><th style="${hc}">PTS Charge $</th><th style="${hc}">TDC Charge $</th><th style="${hc}">Solar Over Production Credit $</th><th style="${hc}">Franchise Fee $</th><th style="${hc};font-weight:800;border-left:2px solid var(--border)">TOTAL COST $</th>`;
    if (showSav)
      h2 += `<th style="${hc};border-left:2px solid var(--border)">Demand Charges $</th><th style="${hc}">Consumption Charges $</th><th style="${hc}">Other Charges $</th><th style="${hc};font-weight:800">TOTAL SAVINGS $</th>`;
    h2 += `</tr>`;

    return `<div class="card" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title">${sec} — ${lbl}</span></div><div style="padding:12px;overflow-x:auto"><table class="dtbl" style="min-width:1500px;font-size:10px;border-collapse:collapse"><thead>${h1}${h2}</thead><tbody>${rows}${tot}</tbody></table></div></div>`;
  }

  function nmTbl(prof, ann, savArr) {
    const showSav = !!savArr;
    let rows = '';
    prof.forEach((e, i) => {
      const bg = i % 2 ? 'background:rgba(255,255,255,0.015)' : '';
      let r = `<tr style="${bg}"><td style="font-weight:600;font-size:11px;padding:3px 6px">${MO[i]}</td><td style="${mc}">${e.akw ? e.akw.toFixed(1) : ''}</td><td style="${mc}">${e.bilKw ? e.bilKw.toFixed(1) : ''}</td><td style="${mc};font-weight:600">${fn(e.kwh)}</td><td style="${mc}">${fn(Math.round(e.t1))}</td><td style="${mc}">${f2(e.onPk)}</td><td style="${mc}">${fn(Math.round(e.t2))}</td><td style="${mc}">${f2(e.offPk)}</td><td style="${mc}">${fn(Math.round(e.t3))}</td><td style="${mc}">${f2(e.noneCh || 0)}</td><td style="${mc};border-left:2px solid var(--border)">${f2(e.cust)}</td><td style="${mc}">${f2(e.dem)}</td><td style="${mc}">${f2(e.fac)}</td><td style="${mc}">${f2(e.cons)}</td><td style="${mc}">${f2(e.eca)}</td><td style="${mc}">${f2(e.eer)}</td><td style="${mc}">${f2(e.pts)}</td><td style="${mc}">${f2(e.tdc)}</td><td style="${mc};color:var(--amber);font-weight:600">${e.sc > 0 ? '-' + f2(e.sc) : ''}</td><td style="${mc}">${f2(e.ff)}</td><td style="${mc};font-weight:700;border-left:2px solid var(--border)">${f2(e.tot)}</td>`;
      if (showSav) {
        const s = savArr[i];
        r += `<td style="${mc}">${f2(s.dS)}</td><td style="${mc}">${f2(s.cS)}</td><td style="${mc};color:var(--amber)">${s.oP > 0 ? f2(s.oP) : ''}</td><td style="${mc}">${f2(s.oS)}</td><td style="${mc};font-weight:700;color:var(--green)">${f2(s.tS)}</td>`;
      }
      r += `</tr>`;
      rows += r;
    });
    const t = prof;
    let tot = `<tr style="background:rgba(59,130,246,0.06);font-weight:700;border-top:2px solid var(--border)"><td style="font-weight:800;padding:4px 6px"></td><td></td><td></td><td style="${mc};font-weight:800">${fn(sa(t, 'kwh'))}</td><td style="${mc}">${fn(Math.round(sa(t, 't1')))}</td><td style="${mc}">${f2(sa(t, 'onPk'))}</td><td style="${mc}">${fn(Math.round(sa(t, 't2')))}</td><td style="${mc}">${f2(sa(t, 'offPk'))}</td><td style="${mc}">${fn(Math.round(sa(t, 't3')))}</td><td style="${mc}">${f2(sa(t, 'noneCh'))}</td><td style="${mc};border-left:2px solid var(--border)">${f2(sa(t, 'cust'))}</td><td style="${mc}">${f2(sa(t, 'dem'))}</td><td style="${mc}">${f2(sa(t, 'fac'))}</td><td style="${mc}">${f2(sa(t, 'cons'))}</td><td style="${mc}">${f2(sa(t, 'eca'))}</td><td style="${mc}">${f2(sa(t, 'eer'))}</td><td style="${mc}">${f2(sa(t, 'pts'))}</td><td style="${mc}">${f2(sa(t, 'tdc'))}</td><td style="${mc};color:var(--amber)">${sa(t, 'sc') > 0 ? '-' + f2(sa(t, 'sc')) : ''}</td><td style="${mc}">${f2(sa(t, 'ff'))}</td><td style="${mc};font-weight:800;border-left:2px solid var(--border)">${f2(ann)}</td>`;
    if (showSav) {
      const tD = savArr.reduce((a, s) => a + s.dS, 0),
        tC = savArr.reduce((a, s) => a + s.cS, 0),
        tOP = savArr.reduce((a, s) => a + (s.oP || 0), 0),
        tO = savArr.reduce((a, s) => a + s.oS, 0),
        tS = savArr.reduce((a, s) => a + s.tS, 0);
      tot += `<td style="${mc};font-weight:700">${f2(tD)}</td><td style="${mc};font-weight:700">${f2(tC)}</td><td style="${mc};font-weight:700;color:var(--amber)">${f2(tOP)}</td><td style="${mc};font-weight:700">${f2(tO)}</td><td style="${mc};font-weight:800;color:var(--green)">${f2(tS)}</td>`;
    }
    tot += `</tr>`;

    let h1 = `<tr><th style="${hc}" rowspan="2">Month</th><th style="${hc}" rowspan="2">ACTUAL KW</th><th style="${hc}" rowspan="2">BILLING KW</th><th style="${hc}" rowspan="2">kWh</th><th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">First 180 Hours</th><th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">Next 180 Hours</th><th colspan="2" style="${hc};border-bottom:1px solid var(--text3)">Over 360 Hours</th><th colspan="11" style="${hc};border-left:2px solid var(--border);border-bottom:1px solid var(--text3)">TOTALS</th>`;
    if (showSav)
      h1 += `<th colspan="5" style="${hc};border-left:2px solid var(--border);border-bottom:1px solid var(--text3)">SAVINGS</th>`;
    h1 += `</tr>`;
    let h2 = `<tr><th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th><th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th><th style="${hc}">kWh</th><th style="${hc}">kWh $ COST</th><th style="${hc};border-left:2px solid var(--border)">Customer Charge $</th><th style="${hc}">Demand Charge $</th><th style="${hc}">Facilities Charge $</th><th style="${hc}">Consumption Charges $</th><th style="${hc}">ECA Charge $</th><th style="${hc}">EER Charge $</th><th style="${hc}">PTS Charge $</th><th style="${hc}">TDC Charge $</th><th style="${hc}">Solar Over Production Credit $</th><th style="${hc}">Franchise Fee $</th><th style="${hc};font-weight:800;border-left:2px solid var(--border)">TOTAL COST $</th>`;
    if (showSav)
      h2 += `<th style="${hc};border-left:2px solid var(--border)">Demand Charges $</th><th style="${hc}">Consumption Charges $</th><th style="${hc}">Solar Overproduction</th><th style="${hc}">Other Charges $</th><th style="${hc};font-weight:800">TOTAL SAVINGS $</th>`;
    h2 += `</tr>`;

    return `<div class="card" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title">F — PROPOSED POST-SOLAR — Net Metering</span></div><div style="padding:12px;overflow-x:auto"><table class="dtbl" style="min-width:1500px;font-size:10px;border-collapse:collapse"><thead>${h1}${h2}</thead><tbody>${rows}${tot}</tbody></table></div></div>`;
  }

  // H — Effective Rates
  function effTbl() {
    const rows = [];
    for (let i = 0; i < 12; i++) {
      const ns = nmSav[i],
        sk = solKw[i] || 0,
        skwh = prod[i] || 0;
      rows.push({
        mo: MO[i],
        mDR: sk > 0 ? ns.dS / sk : 0,
        mUR: skwh > 0 ? ns.cS / skwh : 0,
        isS: dP[i].isS,
        sk,
        skwh,
        dS: ns.dS,
        cS: ns.cS,
      });
    }
    const sR = rows.filter((r) => r.isS),
      wR = rows.filter((r) => !r.isS);
    const sDR =
      sR.reduce((a, r) => a + r.sk, 0) > 0 ? sR.reduce((a, r) => a + r.dS, 0) / sR.reduce((a, r) => a + r.sk, 0) : 0;
    const wDR =
      wR.reduce((a, r) => a + r.sk, 0) > 0 ? wR.reduce((a, r) => a + r.dS, 0) / wR.reduce((a, r) => a + r.sk, 0) : 0;
    const sUR =
      sR.reduce((a, r) => a + r.skwh, 0) > 0
        ? sR.reduce((a, r) => a + r.cS, 0) / sR.reduce((a, r) => a + r.skwh, 0)
        : 0;
    const wUR =
      wR.reduce((a, r) => a + r.skwh, 0) > 0
        ? wR.reduce((a, r) => a + r.cS, 0) / wR.reduce((a, r) => a + r.skwh, 0)
        : 0;
    let h = '';
    rows.forEach((r, i) => {
      const bg = i % 2 ? 'background:rgba(255,255,255,0.015)' : '';
      h += `<tr style="${bg}"><td style="font-weight:600;font-size:11px;padding:3px 6px">${r.mo}</td><td style="${mc}">${r.mDR.toFixed(3)}</td><td style="${mc}">${(r.isS ? sDR : wDR).toFixed(3)}</td><td style="${mc};color:${r.isS ? 'var(--amber)' : 'var(--accent)'};font-weight:600">${r.isS ? 'SUMMER' : 'WINTER'}</td><td style="${mc}">${(r.isS ? sUR : wUR).toFixed(5)}</td><td style="${mc}">${r.mUR.toFixed(5)}</td></tr>`;
    });
    return `<div class="card" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title">H — EFFECTIVE RATES</span></div><div style="padding:12px;overflow-x:auto"><table class="dtbl" style="min-width:600px;font-size:11px"><thead><tr><th style="${hc}">Month</th><th style="${hc}">Monthly Demand/Facilities Rate</th><th style="${hc}">Seasonal Demand/Facilities Rate</th><th style="${hc}">BILLING SEASON</th><th style="${hc}">Seasonal Usage Rate</th><th style="${hc}">Monthly Usage Rate</th></tr></thead><tbody>${h}</tbody></table></div></div>`;
  }

  // Render all — SAVINGS embedded in Section E and F, not separate cards
  const rW = document.getElementById('sc-results');
  if (!rW) return;
  rW.innerHTML =
    stdTbl('EXISTING ELECTRIC COST PROFILE', 'D', dP, dA, null) +
    stdTbl('EXISTING ELECTRIC COST PROFILE (BEFORE SOLAR)', 'E', eP, eA, nmSav) +
    nmTbl(fP, fA, nmSav) +
    stdTbl('PROPOSED POST-SOLAR — Behind the Meter', 'G', gP, gA, btmSav) +
    effTbl();
}

function solarAddAsMeasure(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.solarCalc) return;
  const sc = p.solarCalc;
  const sd = getProjSavingsData(projId);
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : p.buildings || [];
  sd.measures.push({
    id: 'm' + Date.now(),
    selected: true,
    msrNum: sd.measures.length + 1 + '',
    bldgId: bldgs[0]?.id || '',
    desc: `Solar PV — ${sc.arrayKw} kW Array`,
    kwh: (sc.production || []).map((k) => Math.round(k)),
    kw: Array(12).fill(0),
    gas: Array(12).fill(0),
    totalDollar: 0,
    source: 'solar',
  });
  sset('en_projects', projects);
  closeCalcTemplate();
  showToast('Solar measure added to savings matrix ✓');
}

// _svRatesOrCanonical(sd, projId, bldgId) — the user-saved Baseline Rates table
// (Energy Savings tab, sd.blRates[bldgId]) if it has at least one nonzero rate, else the
// ONE canonical seasonal rate function (calcBldgDefaultRates -> computeSeasonalBldgRates).
// 2026-09-23-rate-source: calculators that write measures (solarApplyToMeasure,
// bcApplyToMeasure) must never fall back to an empty {} and silently zero the $ savings.
function _svRatesOrCanonical(sd, projId, bldgId) {
  const saved = sd.blRates && sd.blRates[bldgId];
  const savedHasRate =
    saved && (saved.kwhSummer || saved.kwhWinter || saved.kwSummer || saved.kwWinter || saved.thermRate);
  return savedHasRate ? saved : typeof calcBldgDefaultRates === 'function' ? calcBldgDefaultRates(projId, bldgId) : {};
}

function solarApplyToMeasure(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.solarCalc || !_calcTemplateContext?.targetMeasureId) return;
  const sc = p.solarCalc;
  const sd = getProjSavingsData(projId);
  const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
  if (!m) {
    showToast('Measure not found');
    return;
  }
  // Apply solar production as kWh savings
  m.kwh = (sc.production || []).map((k) => Math.round(k));
  m.source = 'solar';
  if (!m.desc || m.desc.trim() === '') m.desc = `Solar PV — ${sc.arrayKw} kW Array`;
  // Recalc dollar savings using baseline rates — the user-saved Baseline Rates table
  // (Energy Savings tab) if set, else the ONE canonical seasonal rate function
  // (computations/rates.js computeSeasonalBldgRates, via calcBldgDefaultRates) so this
  // never silently zeroes out when the Baseline Rates table hasn't been saved (2026-09-23,
  // item 2026-09-23-rate-source).
  const rates = _svRatesOrCanonical(sd, projId, m.bldgId);
  let total = 0;
  for (let mo = 0; mo < 12; mo++) {
    const isSummer = SUMMER_MOS.includes(mo);
    total += (m.kwh[mo] || 0) * (isSummer ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
    total += (m.kw[mo] || 0) * (isSummer ? rates.kwSummer || 0 : rates.kwWinter || 0);
    total += (m.gas[mo] || 0) * (rates.thermRate || 0);
  }
  m.totalDollar = total;
  sset('en_projects', projects);
  const msrNum = m.msrNum;
  closeCalcTemplate();
  showToast('Solar calc applied to Measure #' + msrNum + ' ✓');
}

/* ══════════════════════════════════════════════════════
         BAS SAVINGS CALCULATOR
      ══════════════════════════════════════════════════════ */

/* ── A. Load Profile Constants ── */
const BAS_COOL_CURVE = [
  [55, 0],
  [60, 0],
  [65, 0.05],
  [70, 0.186],
  [75, 0.321],
  [80, 0.457],
  [85, 0.593],
  [90, 0.729],
  [95, 0.864],
  [100, 1.0],
];
const BAS_HEAT_CURVE = [
  [-2.5, 1.0],
  [2.5, 0.93],
  [7.5, 0.86],
  [12.5, 0.79],
  [17.5, 0.72],
  [22.5, 0.65],
  [27.5, 0.58],
  [32.5, 0.51],
  [37.5, 0.44],
  [42.5, 0.37],
  [47.5, 0.3],
];
// Excel Savings Calculator!M3:M13 cached values (2026-09-22 parity audit finding #3 — the
// site's prior curve kept COP flat at 0.8 through 32.5F, ramping 15F later than the workbook).
const BAS_VRF_COP = [
  [-2.5, 0.8],
  [2.5, 0.8],
  [7.5, 0.8],
  [12.5, 0.8],
  [17.5, 0.8],
  [22.5, 1.34],
  [27.5, 1.88],
  [32.5, 2.42],
  [37.5, 2.96],
  [42.5, 3.5],
  [47.5, 3.5],
];
// Real bin set from the Excel template's weather data (23 bins, 107.5F down to -2.5F) —
// see app/data/bas-weather-bins.js. Wider than the old synthetic 19-bin set, which never
// reached above 82.5F and silently dropped hot-climate hours (Phoenix, Brownsville, Dallas).
const BAS_TEMP_BINS = BAS_WEATHER_BINS.bins;
const BAS_MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Company-standard unoccupied heating setpoint default, by BAS Savings Calc heating source —
// reads the ONE setpoint default table (EM_SP_DEFAULTS.unocc, app/equipment-matrix.js; see
// docs/dashboardlogic.md project_default_setpoint_standards) instead of keeping its own copy of
// the same 55/60/65 numbers (2026-09-23 single-source fix). Occupied setpoints (70 heat / 74
// cool) and unoccupied cooling (85) are constant across heat sources — only unoccupied heat
// varies, so this is the only value that needs the heat-source branch. Falls back to the same
// literal numbers only if EM_SP_DEFAULTS hasn't loaded (defensive — never happens in the shipped
// page, equipment-matrix.js always loads alongside calculators.js).
function _bcDefaultUnoccHeat(heatSrc) {
  const key = heatSrc === 4 ? 'heatpump' : heatSrc === 2 ? 'electricReheat' : 'hydronic'; // 1/3 = Gas
  if (typeof EM_SP_DEFAULTS !== 'undefined' && EM_SP_DEFAULTS.unocc[key]) return EM_SP_DEFAULTS.unocc[key].heat;
  return heatSrc === 4 ? 65 : heatSrc === 2 ? 60 : 55;
}

function _bcInterp(curve, temp) {
  if (temp <= curve[0][0]) return curve[0][1];
  if (temp >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    if (temp >= curve[i][0] && temp <= curve[i + 1][0]) {
      const f = (temp - curve[i][0]) / (curve[i + 1][0] - curve[i][0]);
      return curve[i][1] + f * (curve[i + 1][1] - curve[i][1]);
    }
  }
  return 0;
}

/* ── B. Weather Data — 16 cities, real typical-year bin data from the BAS Savings Calc
   Excel template (app/data/bas-weather-bins.js, generated by
   tools/generate-bas-weather-data.py from "Temperature Data" and "Humidity Data").
   Temperature and humidity are both real data — no synthetic generation, no empty
   humidity path. A manual CSV upload still overrides either one per project. */
const BAS_CITIES = Object.keys(BAS_WEATHER_BINS.cities)
  .map((k) => parseInt(k))
  .sort((a, b) => a - b)
  .map((id) => ({ id, name: BAS_WEATHER_BINS.cities[id].name }));

function _basCityWeather(cityIdx) {
  const c = BAS_WEATHER_BINS.cities[cityIdx];
  if (!c) return null;
  return { hourlyBins: c.temp, humidityBins: c.humidity, cityName: c.name };
}

/* ── C. Main UI Render ── */
function openBASCalc(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!_calcTemplateContext) _calcTemplateContext = { projId, returnTo: 'sv' };
  const wrap =
    _calcTemplateContext.returnTo === 'ptab'
      ? document.getElementById('ptab-savings')
      : document.getElementById('svDetailWrap');
  if (!wrap) return;
  const hdrBtns = document.getElementById('svDetailHdrBtns');
  if (hdrBtns) hdrBtns.style.display = 'none';
  const bc = p?.basCalc || {};
  const bldgId = _calcTemplateContext.bldgId || null;

  // Auto-populate from the target building — runs on every open, not gated on
  // whether a basCalc object already exists. A prior all-or-nothing gate
  // (`!p?.basCalc`) meant any project that already had a basCalc — even one still
  // holding nothing but shipped defaults (sqft 0, Electric heat, 55/70 setpoints),
  // which is what most real projects had before this fix — never got auto-filled
  // again. Per-field resolution below protects real user edits instead. See
  // docs/dashboardlogic.md 2026-09-22 entry ("BAS Savings Calc real autofill fix").
  const auto = bldgId && typeof chCalcAutofillFields === 'function' ? chCalcAutofillFields(projId, bldgId) : null;

  // City best-effort match from the building address — BAS_CITIES/TMY city list is
  // BAS-calc-specific presentation data, so this stays local rather than in the
  // shared helper (no other calc template has a location field today).
  let autoCity = null;
  if (bldgId) {
    const bldg = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
    if (bldg?.addr) {
      const addrLower = String(bldg.addr).toLowerCase();
      const match = BAS_CITIES.find((c) => {
        const cityName = c.name.split(',')[0].trim().toLowerCase();
        return cityName && addrLower.includes(cityName);
      });
      if (match) autoCity = { value: match.id, source: 'building address' };
    }
  }

  // Calibration (Section D) is project-scoped only (hvacLoadEst has no per-building
  // breakout today) — pre-fill when available, documented limitation otherwise.
  let autoCalCool = null,
    autoCalHeat = null,
    autoCalGas = null;
  if (p?.hvacLoadEst) {
    if (p.hvacLoadEst.coolKwhTotal)
      autoCalCool = { value: Math.round(p.hvacLoadEst.coolKwhTotal), source: 'HVAC Load Estimation' };
    if (p.hvacLoadEst.heatKwhTotal)
      autoCalHeat = { value: Math.round(p.hvacLoadEst.heatKwhTotal), source: 'HVAC Load Estimation' };
  }
  // Existing Cooling kWh (2026-09-24 fix): same precedence as the calHeatGas fix below — a real
  // SAVED HVAC Load Estimation for this project wins when one exists (checked above). Otherwise,
  // compute it fresh directly from THIS building's own electric bills via
  // hvacComputeElecCoolKwhForBuilding (computeHvacEnduse's 3-lowest-month baseload method — the
  // SAME function calHeatGas already uses for gas) so calCoolKwh fills without requiring a user to
  // open the HVAC Load Estimation tab and click Save first. Previously calCoolKwh had NO
  // fresh-compute fallback at all (unlike calHeatGas, which got one 2026-09-23), so it stayed
  // "Default value (not from building data)" for any building nobody had saved that tab for — the
  // Spring Hill Schools / Woodland Spring Middle failure mode reported 2026-09-24.
  if (!autoCalCool && bldgId && typeof hvacComputeElecCoolKwhForBuilding === 'function') {
    const computedCool = hvacComputeElecCoolKwhForBuilding(projId, bldgId);
    if (computedCool && computedCool.coolingKwh)
      autoCalCool = {
        value: Math.round(computedCool.coolingKwh),
        source: 'electric bills (3-lowest-month baseload method — same as the Energy Graphics HVAC End-Use Estimate)',
      };
  }
  // Existing Heating Gas Therms (2026-09-23 fix): a real SAVED HVAC Load Estimation for this
  // project (p.hvacLoadEst.hvacGasT + p.hvacLoadSavedAt — a user actually reviewed and clicked
  // Save on that tab) wins when one exists. Otherwise, compute it fresh directly from THIS
  // building's own gas/propane bills via hvacComputeGasThermsForBuilding — the SAME bill reader
  // and the SAME Rules-of-Thumb gas-heating-share default the HVAC Load Estimation tab itself
  // uses — so calHeatGas fills without requiring a user to open that tab first. Previously this
  // only ever read the saved snapshot, which stays empty (and calHeatGas empty) for any building
  // nobody has opened that tab for — the Spring Hill Schools / Woodland Spring Middle failure
  // mode reported 2026-09-23.
  if (p?.hvacLoadEst?.hvacGasT && p.hvacLoadSavedAt) {
    autoCalGas = {
      value: Math.round(p.hvacLoadEst.hvacGasT),
      source: 'HVAC Load Estimation (heating share of gas bills)',
    };
  } else if (bldgId && typeof hvacComputeGasThermsForBuilding === 'function') {
    const computedGas = hvacComputeGasThermsForBuilding(projId, bldgId);
    if (computedGas && computedGas.hvacGasT)
      autoCalGas = {
        value: Math.round(computedGas.hvacGasT),
        source:
          computedGas.source === 'baseload'
            ? 'gas bills (3-lowest-month baseload heating-share method — same as the Energy Graphics HVAC End-Use Estimate)'
            : 'gas bills (Rules of Thumb heating share estimate, not enough bill history to compute a baseload split — review in HVAC Load Estimation)',
      };
  }

  // A saved basCalc that exactly matches the old BAS Savings Calc Excel template's 22-value
  // placeholder set (see chIsLegacyCalcPlaceholderSave) is never a real user edit — treat those
  // 22 fields as never-saved so autofill/company-standard resolution runs instead of protecting
  // stale placeholder data as if it were a survey result.
  const _legacyPlaceholder = typeof chIsLegacyCalcPlaceholderSave === 'function' && chIsLegacyCalcPlaceholderSave(bc);

  // Resolve one field via the shared chResolveCalcField (app/calc-autofill.js): a
  // real prior user edit always wins (explicitly touched this session, or a saved
  // value that differs from the shipped default — evidence a human typed something).
  // Otherwise autofill wins when available; otherwise the shipped default is used
  // and flagged so the user knows it isn't building data.
  const touched = new Set(bc.__userTouched || []);
  const _bcResolve = (field, shippedDefault, autoResult) => {
    const savedValue =
      _legacyPlaceholder && typeof CH_LEGACY_CALC_PLACEHOLDERS === 'object' && field in CH_LEGACY_CALC_PLACEHOLDERS
        ? undefined
        : bc[field];
    return chResolveCalcField(savedValue, shippedDefault, autoResult, touched, field);
  };
  const _bcHintSpan = chCalcFieldHintHTML;

  const rSqft = _bcResolve('sqft', 0, auto?.sqft);
  const rHeatSrc = _bcResolve('heatSrc', 2, auto?.heatSrc);
  const rCity = _bcResolve('city', 4, autoCity);
  // Company-standard shipped defaults (occupied 70 heat / 74 cool, unoccupied cool 85, unoccupied
  // heat by heating source — see docs/dashboardlogic.md project_default_setpoint_standards): these
  // are placeholders shown only when no building/Set Points/Equipment Matrix data exists (flagged
  // by the "Default value (not from building data)" hint), never claimed as real survey data.
  const rExCoolOcc = _bcResolve('exCoolOcc', 74, auto?.exCoolOcc);
  const rExCoolUnocc = _bcResolve('exCoolUnocc', 85, auto?.exCoolUnocc);
  const rExHeatOcc = _bcResolve('exHeatOcc', 70, auto?.exHeatOcc);
  const rExHeatUnocc = _bcResolve('exHeatUnocc', _bcDefaultUnoccHeat(parseInt(rHeatSrc.value) || 2), auto?.exHeatUnocc);
  const rExMfOn = _bcResolve('exMfOn', 0, auto?.exMfOn);
  const rExMfOff = _bcResolve('exMfOff', 24, auto?.exMfOff);
  // Existing Saturday/Sunday occupied window (2026-09-24 fix): shipped default is now 0-0 (no
  // occupied hours — building closed) instead of the old 0-24 (occupied all day, no setback),
  // which is the exact "same as occupied, no setback, 24 hours" pattern that is not the company
  // standard and inflates the existing load. chCalcAutofillFields resolves a real value (also
  // 0-0, but sourced and not flagged as default) whenever an Effective Schedules import exists
  // for this building; a building with no import at all still shows the shipped default, now
  // correctly flagged "Default value (not from building data)" via the hint span below (it
  // previously had no hint at all).
  const rExSatOn = _bcResolve('exSatOn', 0, auto?.exSatOn);
  const rExSatOff = _bcResolve('exSatOff', 0, auto?.exSatOff);
  const rExSunOn = _bcResolve('exSunOn', 0, auto?.exSunOn);
  const rExSunOff = _bcResolve('exSunOff', 0, auto?.exSunOff);
  // Outside Air Shut Off When Unoccupied — no Equipment Matrix or import field measures this.
  // 2026-09-25 (Matt's decision): "just assume no outside air when unoccupied" — default is
  // 'yes', sourced as an assumption (Matt / company default), not measured building data.
  const rExOAShutoff = _bcResolve('exOAShutoff', 'yes', auto?.exOAShutoff);
  const rCalCoolKwh = _bcResolve('calCoolKwh', '', autoCalCool);
  const rCalHeatKwh = _bcResolve('calHeatKwh', '', autoCalHeat);
  const rCalHeatGas = _bcResolve('calHeatGas', '', autoCalGas);

  // Proposed Conditions (2026-09-23): chCalcAutofillFields always returns a company-standard
  // value for these (isDefault:false — see its header comment), so every field below resolves
  // to real data or a company standard, never the bare "no data" flag Existing Conditions can
  // show. Weekend schedule (Sat/Sun) is always company-standard unoccupied (0/0) — no per-
  // building weekend source exists.
  const rNewHeatOcc = _bcResolve('newHeatOcc', 70, auto?.newHeatOcc);
  const rNewCoolOcc = _bcResolve('newCoolOcc', 74, auto?.newCoolOcc);
  const rNewHeatUnocc = _bcResolve(
    'newHeatUnocc',
    _bcDefaultUnoccHeat(parseInt(rHeatSrc.value) || 2),
    auto?.newHeatUnocc,
  );
  const rNewCoolUnocc = _bcResolve('newCoolUnocc', 85, auto?.newCoolUnocc);
  const rNewMfOn = _bcResolve('newMfOn', 6, auto?.newMfOn);
  const rNewMfOff = _bcResolve('newMfOff', 17, auto?.newMfOff);
  const rNewSatOn = _bcResolve('newSatOn', 0, auto?.newSatOn);
  const rNewSatOff = _bcResolve('newSatOff', 0, auto?.newSatOff);
  const rNewSunOn = _bcResolve('newSunOn', 0, auto?.newSunOn);
  const rNewSunOff = _bcResolve('newSunOff', 0, auto?.newSunOff);
  const rNewOAShutoff = _bcResolve('newOAShutoff', 'yes', auto?.newOAShutoff);

  const sqft = rSqft.value || p?.sqft || 0;
  const cityOpts = BAS_CITIES.map(
    (c) => `<option value="${c.id}" ${rCity.value == c.id ? 'selected' : ''}>${c.name}</option>`,
  ).join('');
  const hasMsr = !!_calcTemplateContext?.targetMeasureId;
  const msrLabel = hasMsr
    ? (() => {
        const sd = getProjSavingsData(projId);
        const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
        return '#' + (m?.msrNum || '?');
      })()
    : '';

  wrap.innerHTML = `
        <div style="padding:20px;overflow-y:auto;flex:1" id="bc-main-wrap">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" onclick="openCalcTemplates(${projId},'${_calcTemplateContext.returnTo}')">← Templates</button>
            <h2 style="font-size:18px;font-weight:700;margin:0">🏢 Building Automation System Savings Calc</h2>
            <div style="flex:1"></div>
            <button class="btn btn-ghost btn-sm" onclick="bcSaveInputs(${projId})">💾 Save</button>
            <button class="btn btn-ghost btn-sm" id="bc-use-em-btn">📥 Use Equipment Matrix Data</button>
            <button class="btn btn-ghost btn-sm" id="bc-setpoint-export-btn">📤 Setpoint Export</button>
            ${
              hasMsr
                ? `<button class="btn btn-em btn-sm" onclick="bcApplyToMeasure(${projId})">⚡ Apply to Measure ${msrLabel}</button>`
                : `<button class="btn btn-em btn-sm" onclick="bcAddAsMeasure(${projId})">+ Add as Savings Measure</button>`
            }
          </div>

          <!-- SUMMARY KPIs -->
          <div id="bc-summary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px">
            <div class="card" style="padding:14px;text-align:center;background:var(--s1)">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Annual kWh Savings</div>
              <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--em);margin-top:4px" id="bc-kpi-kwh">—</div>
            </div>
            <div class="card" style="padding:14px;text-align:center;background:var(--s1)">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Heating Gas Savings</div>
              <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--amber);margin-top:4px" id="bc-kpi-gas">—</div>
            </div>
            <div class="card" style="padding:14px;text-align:center;background:var(--s1)">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Cooling kWh Saved</div>
              <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--em2);margin-top:4px" id="bc-kpi-cool">—</div>
            </div>
            <div class="card" id="bc-rebate-card" style="padding:14px;text-align:center;background:var(--s1);display:${bc.showRebate ? '' : 'none'}">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Evergy Rebate (estimate)</div>
              <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--green);margin-top:4px" id="bc-kpi-rebate">—</div>
            </div>
          </div>

          <!-- A — BUILDING & EQUIPMENT -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">A — Building &amp; Equipment</span></div>
            <div style="padding:14px">
              <div class="f3">
                <div class="fg"><label class="fl">Building Square Feet</label><input class="fi bc-inp" id="bc-sqft" type="number" value="${sqft}" placeholder="e.g. 50000">${_bcHintSpan(rSqft.hint)}</div>
                <div class="fg"><label class="fl">Heating Source</label><select class="fs bc-inp" id="bc-heatSrc">
                  <option value="1" ${rHeatSrc.value == 1 ? 'selected' : ''}>1 — Gas (Thousand Cubic Feet)</option>
                  <option value="2" ${rHeatSrc.value == 2 ? 'selected' : ''}>2 — Electric (kWh)</option>
                  <option value="3" ${rHeatSrc.value == 3 ? 'selected' : ''}>3 — Gas (Therms)</option>
                  <option value="4" ${rHeatSrc.value == 4 ? 'selected' : ''}>4 — Both (Electric + Gas)</option>
                </select>${_bcHintSpan(rHeatSrc.hint)}</div>
                <div class="fg"><label class="fl">Percent of Variable Refrigerant Flow kWh</label><input class="fi bc-inp" id="bc-vrfPct" type="number" value="${bc.vrfPct || 0}" min="0" max="100" step="1"></div>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr) repeat(3,auto);gap:10px;margin-top:8px;align-items:end">
                <div class="fg"><label class="fl">Cooling Efficiency (kW per Ton)</label><input class="fi bc-inp" id="bc-coolEff" type="number" step="0.01" value="${bc.coolEff || 0.86}"></div>
                <div class="fg"><label class="fl">Gas Furnace Efficiency (Annual Fuel Utilization Efficiency)</label><input class="fi bc-inp" id="bc-afue" type="number" step="0.01" value="${bc.afue || 0.8}"></div>
                <div class="fg"><label class="fl">Electric Heating Efficiency (Coefficient of Performance)</label><input class="fi bc-inp" id="bc-elecCOP" type="number" step="0.1" value="${bc.elecCOP || 1.0}"></div>
                <div class="fg"><label class="fl">Humidity Setpoint (pounds of water per pound of dry air)</label><input class="fi bc-inp" id="bc-humRatioSP" type="number" step="0.0001" value="${bc.humRatioSP || 0.0082}"></div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Maximum Tons</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--em2)" id="bc-dispTons">—</div>
                </div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Maximum Heating (thousand British Thermal Units per hour)</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--amber)" id="bc-dispMbtu">—</div>
                </div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Outside Air Cubic Feet per Minute</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text2)" id="bc-dispCfm">—</div>
                </div>
              </div>
            </div>
          </div>

          <!-- B — LOCATION & WEATHER -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">B — Location &amp; Weather Data</span>
              <div style="display:flex;align-items:center;gap:8px">
                <select class="fs bc-inp" id="bc-city" style="width:200px;font-size:11px">${cityOpts}</select>
              </div>
            </div>
            <div style="padding:0 14px 4px">${_bcHintSpan(rCity.hint)}</div>
            <div style="padding:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
              <div style="font-size:12px;color:var(--text2)" id="bc-weatherStatus">${bc.weatherOverride ? 'Weather: uploaded data (' + bc.weatherOverride.rowsParsed + ' rows)' : 'Weather: typical-year data from the Building Automation System Savings Calc template'}</div>
              <label class="btn btn-ghost btn-sm" style="cursor:pointer">
                🌡️ Temperature CSV
                <input type="file" accept=".csv,.txt" id="bc-weatherUpload" style="display:none" onchange="_bcHandleCSV(this,${projId})">
              </label>
              <label class="btn btn-ghost btn-sm" style="cursor:pointer">
                💧 Humidity CSV
                <input type="file" accept=".csv,.txt" id="bc-humidityUpload" style="display:none" onchange="_bcHandleHumidityCSV(this,${projId})">
              </label>
              <div style="font-size:11px;color:var(--text3)" id="bc-humidityStatus">${bc.humidityOverride ? 'Humidity data: uploaded (' + bc.humidityOverride.rowsParsed + ' rows)' : 'Humidity data: included'}</div>
              ${bc.weatherOverride ? `<button class="btn btn-ghost btn-sm" onclick="_bcClearWeather(${projId})">✕ Clear</button>` : ''}
            </div>
          </div>

          <!-- C — OPERATING CONDITIONS -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
            <!-- EXISTING -->
            <div class="card">
              <div class="card-hdr"><span class="card-title" style="color:var(--amber)">Existing Conditions</span></div>
              <div style="padding:14px">
                <div class="f2">
                  <div class="fg"><label class="fl">Occupied Cooling Setpoint (°F)</label><input class="fi bc-inp" id="bc-exCoolOcc" type="number" value="${rExCoolOcc.value}">${_bcHintSpan(rExCoolOcc.hint)}</div>
                  <div class="fg"><label class="fl">Unoccupied Cooling Setpoint (°F)</label><input class="fi bc-inp" id="bc-exCoolUnocc" type="number" value="${rExCoolUnocc.value}">${_bcHintSpan(rExCoolUnocc.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Occupied Heating Setpoint (°F)</label><input class="fi bc-inp" id="bc-exHeatOcc" type="number" value="${rExHeatOcc.value}">${_bcHintSpan(rExHeatOcc.hint)}</div>
                  <div class="fg"><label class="fl">Unoccupied Heating Setpoint (°F)</label><input class="fi bc-inp" id="bc-exHeatUnocc" type="number" value="${rExHeatUnocc.value}">${_bcHintSpan(rExHeatUnocc.hint)}</div>
                </div>
                <div class="fg"><label class="fl">Outside Air Shut Off When Unoccupied?</label><select class="fs bc-inp" id="bc-exOAShutoff">
                  <option value="no" ${(rExOAShutoff.value || 'no') === 'no' ? 'selected' : ''}>No</option>
                  <option value="yes" ${rExOAShutoff.value === 'yes' ? 'selected' : ''}>Yes</option>
                </select>${_bcHintSpan(rExOAShutoff.hint)}</div>
                <div style="font-size:11px;font-weight:600;color:var(--text2);margin:10px 0 6px;text-transform:uppercase;letter-spacing:1px">Schedule (24-Hour)</div>
                <div class="f2">
                  <div class="fg"><label class="fl">Monday–Friday Start</label><input class="fi bc-inp" id="bc-exMfOn" type="number" min="0" max="24" value="${rExMfOn.value}">${_bcHintSpan(rExMfOn.hint)}</div>
                  <div class="fg"><label class="fl">Monday–Friday Stop</label><input class="fi bc-inp" id="bc-exMfOff" type="number" min="0" max="24" value="${rExMfOff.value}">${_bcHintSpan(rExMfOff.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Saturday Start</label><input class="fi bc-inp" id="bc-exSatOn" type="number" min="0" max="24" value="${rExSatOn.value}">${_bcHintSpan(rExSatOn.hint)}</div>
                  <div class="fg"><label class="fl">Saturday Stop</label><input class="fi bc-inp" id="bc-exSatOff" type="number" min="0" max="24" value="${rExSatOff.value}">${_bcHintSpan(rExSatOff.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sunday Start</label><input class="fi bc-inp" id="bc-exSunOn" type="number" min="0" max="24" value="${rExSunOn.value}">${_bcHintSpan(rExSunOn.hint)}</div>
                  <div class="fg"><label class="fl">Sunday Stop</label><input class="fi bc-inp" id="bc-exSunOff" type="number" min="0" max="24" value="${rExSunOff.value}">${_bcHintSpan(rExSunOff.hint)}</div>
                </div>
              </div>
            </div>
            <!-- NEW -->
            <div class="card">
              <div class="card-hdr"><span class="card-title" style="color:var(--em)">New (Proposed) Conditions</span></div>
              <div style="padding:14px">
                <div class="f2">
                  <div class="fg"><label class="fl">Occupied Cooling Setpoint (°F)</label><input class="fi bc-inp" id="bc-newCoolOcc" type="number" value="${rNewCoolOcc.value}">${_bcHintSpan(rNewCoolOcc.hint)}</div>
                  <div class="fg"><label class="fl">Unoccupied Cooling Setpoint (°F)</label><input class="fi bc-inp" id="bc-newCoolUnocc" type="number" value="${rNewCoolUnocc.value}">${_bcHintSpan(rNewCoolUnocc.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Occupied Heating Setpoint (°F)</label><input class="fi bc-inp" id="bc-newHeatOcc" type="number" value="${rNewHeatOcc.value}">${_bcHintSpan(rNewHeatOcc.hint)}</div>
                  <div class="fg"><label class="fl">Unoccupied Heating Setpoint (°F)</label><input class="fi bc-inp" id="bc-newHeatUnocc" type="number" value="${rNewHeatUnocc.value}">${_bcHintSpan(rNewHeatUnocc.hint)}</div>
                </div>
                <div class="fg"><label class="fl">Outside Air Shut Off When Unoccupied?</label><select class="fs bc-inp" id="bc-newOAShutoff">
                  <option value="no" ${(rNewOAShutoff.value || 'yes') === 'no' ? 'selected' : ''}>No</option>
                  <option value="yes" ${(rNewOAShutoff.value || 'yes') === 'yes' ? 'selected' : ''}>Yes</option>
                </select>${_bcHintSpan(rNewOAShutoff.hint)}</div>
                <div style="font-size:11px;font-weight:600;color:var(--text2);margin:10px 0 6px;text-transform:uppercase;letter-spacing:1px">Schedule (24-Hour)</div>
                <div class="f2">
                  <div class="fg"><label class="fl">Monday–Friday Start</label><input class="fi bc-inp" id="bc-newMfOn" type="number" min="0" max="24" value="${rNewMfOn.value}">${_bcHintSpan(rNewMfOn.hint)}</div>
                  <div class="fg"><label class="fl">Monday–Friday Stop</label><input class="fi bc-inp" id="bc-newMfOff" type="number" min="0" max="24" value="${rNewMfOff.value}">${_bcHintSpan(rNewMfOff.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Saturday Start</label><input class="fi bc-inp" id="bc-newSatOn" type="number" min="0" max="24" value="${rNewSatOn.value}">${_bcHintSpan(rNewSatOn.hint)}</div>
                  <div class="fg"><label class="fl">Saturday Stop</label><input class="fi bc-inp" id="bc-newSatOff" type="number" min="0" max="24" value="${rNewSatOff.value}">${_bcHintSpan(rNewSatOff.hint)}</div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sunday Start</label><input class="fi bc-inp" id="bc-newSunOn" type="number" min="0" max="24" value="${rNewSunOn.value}">${_bcHintSpan(rNewSunOn.hint)}</div>
                  <div class="fg"><label class="fl">Sunday Stop</label><input class="fi bc-inp" id="bc-newSunOff" type="number" min="0" max="24" value="${rNewSunOff.value}">${_bcHintSpan(rNewSunOff.hint)}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- D — CALIBRATION -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">D — Calibration (Match to Utility Analysis)</span></div>
            <div style="padding:14px">
              <div style="font-size:11px;color:var(--text2);margin-bottom:10px">Enter actual annual energy from utility analysis. Leave blank to skip calibration (factor = 1.0).</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end">
                <div class="fg"><label class="fl">Existing Cooling kWh (from Utility Analysis)</label><input class="fi bc-inp" id="bc-calCoolKwh" type="number" value="${rCalCoolKwh.value}">${_bcHintSpan(rCalCoolKwh.hint)}</div>
                <div class="fg"><label class="fl">Existing Heating kWh (from Utility Analysis)</label><input class="fi bc-inp" id="bc-calHeatKwh" type="number" value="${rCalHeatKwh.value}">${_bcHintSpan(rCalHeatKwh.hint)}</div>
                ${
                  parseInt(rHeatSrc.value) === 1 || parseInt(rHeatSrc.value) === 3 || parseInt(rHeatSrc.value) === 4
                    ? `<div class="fg"><label class="fl">Existing Heating Gas — ${parseInt(rHeatSrc.value) === 1 ? 'Thousand Cubic Feet' : 'Therms'} (from Utility Analysis)</label><input class="fi bc-inp" id="bc-calHeatGas" type="number" value="${rCalHeatGas.value}">${_bcHintSpan(rCalHeatGas.hint)}<div style="font-size:9px;color:var(--text3);margin-top:2px">${parseInt(rHeatSrc.value) === 4 ? 'Splits combined "Both" heating between kWh and gas by share of load' : 'Calibrates the existing gas heating estimate to match utility analysis'}</div></div>`
                    : ''
                }
                <div style="text-align:center;padding:8px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Cooling Adjustment Factor</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--em2)" id="bc-adjCool">1.000</div>
                </div>
                <div style="text-align:center;padding:8px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Heating Adjustment Factor</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--amber)" id="bc-adjHeat">1.000</div>
                </div>
              </div>
              <div id="bc-coolAdjWarn" style="display:none;margin-top:10px;background:var(--warn-dim);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn)">
                The cooling kWh entered is lower than the outside air cooling alone. Check the cooling kWh.
              </div>
            </div>
          </div>

          <!-- E — PEAK DEMAND -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">E — Peak Demand Hours</span></div>
            <div style="padding:14px">
              <div class="f2" style="max-width:400px">
                <div class="fg"><label class="fl">Peak Start (24-hour)</label><input class="fi bc-inp" id="bc-peakStart" type="number" min="0" max="23" value="${bc.peakStart ?? 16}"></div>
                <div class="fg"><label class="fl">Peak End (24-hour)</label><input class="fi bc-inp" id="bc-peakEnd" type="number" min="1" max="24" value="${bc.peakEnd ?? 18}"></div>
              </div>
              <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:11px;color:var(--text2)">
                <input type="checkbox" id="bc-showRebate" ${bc.showRebate ? 'checked' : ''}>
                Show Evergy Rebate estimate (informational only — not included in savings totals)
              </label>
            </div>
          </div>

          <!-- F — RESULTS -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">F — Results</span></div>
            <div style="padding:14px;overflow-x:auto" id="bc-results">
              <div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">Enter building square footage above to calculate savings...</div>
            </div>
          </div>

        </div>`;

  // Attach live-calc listeners — also marks the field as user-touched so a future
  // open never lets autofill silently overwrite an edit the user just made, even
  // before they click Save.
  wrap.querySelectorAll('.bc-inp').forEach((inp) => {
    const field = inp.id.replace(/^bc-/, '');
    inp.addEventListener('input', () => {
      _bcMarkTouched(projId, field);
      _bcLiveCalc(projId);
    });
    inp.addEventListener('change', () => {
      _bcMarkTouched(projId, field);
      _bcLiveCalc(projId);
    });
  });
  // Setpoint export button — bound here (not an inline onclick) so the building id
  // stays a real JS value and never round-trips through an HTML attribute string.
  document.getElementById('bc-setpoint-export-btn')?.addEventListener('click', () => {
    emOpenSetpointExportDialog(projId, _calcTemplateContext.bldgId || null);
  });
  document.getElementById('bc-use-em-btn')?.addEventListener('click', () => {
    bcUseEquipmentMatrixData(projId);
  });
  document.getElementById('bc-showRebate')?.addEventListener('change', _bcToggleRebateVisibility);
  // Heating Source changes which fields Section D and the unoccupied-heat default need (the
  // gas-calibration input only applies to heatSrc 4 "Both") — those are baked into the HTML at
  // render time, not live-updated by _bcDoCalc (which only rewrites the results panel and KPI
  // text), so a plain recalc would leave a stale field set showing. Save first so no unsaved
  // edit in another field is lost, then fully re-render.
  document.getElementById('bc-heatSrc')?.addEventListener('change', () => {
    bcSaveInputs(projId);
    openBASCalc(projId);
  });
  _bcToggleRebateVisibility();
  _bcLiveCalc(projId);
}

// Shows/hides the Evergy rebate KPI card and detail breakdown based on the "Show Evergy
// Rebate" checkbox (Section E). Off by default (item 5ap) — the rebate estimate is informational
// only and must never be implied as part of the savings totals shown to a client, so it stays
// out of sight unless someone deliberately opts in.
function _bcToggleRebateVisibility() {
  const show = document.getElementById('bc-showRebate')?.checked;
  const card = document.getElementById('bc-rebate-card');
  if (card) card.style.display = show ? '' : 'none';
  const detail = document.getElementById('bc-rebate-detail');
  if (detail) detail.style.display = show ? '' : 'none';
}

function _bcMarkTouched(projId, field) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  if (!p.basCalc) p.basCalc = {};
  if (!Array.isArray(p.basCalc.__userTouched)) p.basCalc.__userTouched = [];
  if (!p.basCalc.__userTouched.includes(field)) p.basCalc.__userTouched.push(field);
}

/* ── D. Calculation Engine ── */
let _bcCalcTimer = null;
function _bcLiveCalc(projId) {
  clearTimeout(_bcCalcTimer);
  _bcCalcTimer = setTimeout(() => _bcDoCalc(projId), 150);
}

function _bcGv(id) {
  const e = document.getElementById(id);
  if (!e) return 0;
  if (e.tagName === 'SELECT') return e.value;
  return parseFloat(e.value) || 0;
}

function _bcDoCalc(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;

  const sqft = _bcGv('bc-sqft');
  const heatSrc = parseInt(_bcGv('bc-heatSrc')) || 2;
  const vrfPct = (_bcGv('bc-vrfPct') || 0) / 100;
  const coolEff = _bcGv('bc-coolEff') || 0.86;
  const afue = _bcGv('bc-afue') || 0.8;
  const elecCOP = _bcGv('bc-elecCOP') || 1.0;
  const cityIdx = parseInt(_bcGv('bc-city')) || 4;

  const exCoolOcc = _bcGv('bc-exCoolOcc');
  const exCoolUnocc = _bcGv('bc-exCoolUnocc');
  const exHeatOcc = _bcGv('bc-exHeatOcc');
  const exHeatUnocc = _bcGv('bc-exHeatUnocc');
  const exOAShutoff = document.getElementById('bc-exOAShutoff')?.value === 'yes';
  const exMfOn = _bcGv('bc-exMfOn'),
    exMfOff = _bcGv('bc-exMfOff');
  const exSatOn = _bcGv('bc-exSatOn'),
    exSatOff = _bcGv('bc-exSatOff');
  const exSunOn = _bcGv('bc-exSunOn'),
    exSunOff = _bcGv('bc-exSunOff');

  const newCoolOcc = _bcGv('bc-newCoolOcc');
  const newCoolUnocc = _bcGv('bc-newCoolUnocc');
  const newHeatOcc = _bcGv('bc-newHeatOcc');
  const newHeatUnocc = _bcGv('bc-newHeatUnocc');
  const newOAShutoff = document.getElementById('bc-newOAShutoff')?.value === 'yes';
  const newMfOn = _bcGv('bc-newMfOn'),
    newMfOff = _bcGv('bc-newMfOff');
  const newSatOn = _bcGv('bc-newSatOn'),
    newSatOff = _bcGv('bc-newSatOff');
  const newSunOn = _bcGv('bc-newSunOn'),
    newSunOff = _bcGv('bc-newSunOff');

  const calCoolKwh = _bcGv('bc-calCoolKwh');
  const calHeatKwh = _bcGv('bc-calHeatKwh');
  const calHeatGas = _bcGv('bc-calHeatGas');
  const peakStart = _bcGv('bc-peakStart');
  const peakEnd = _bcGv('bc-peakEnd');
  const humRatioSP = _bcGv('bc-humRatioSP') || 0.0082;

  // "Both (Electric + Gas)" (heatSrc 4) splits one combined heating load into a kWh share and
  // a gas share by %GasHeat, matching Excel Savings Calculator!O39 (=IFERROR(K43/K44,0), where
  // K42 is the existing electric-heating calibration kWh and K43 is the existing gas-heating
  // calibration input in Therms) — 2026-09-22 parity audit finding #1, previously the site routed
  // 100% of "Both" heating into kWh and never produced a gas savings number for that heat source.
  // 0.03413 converts the kWh calibration figure to the same MMBtu-scale basis as the Therms input
  // before taking the gas share of the combined total; falls back to 0 (all-kWh, today's
  // behavior) when no gas calibration figure has been entered.
  const pctGasHeat = heatSrc === 4 && calHeatGas > 0 ? calHeatGas / (calHeatKwh * 0.03413 + calHeatGas) : 0;

  const maxTons = sqft / 300;
  const maxMbtu = (sqft * 30) / 1000;
  const oaCfm = sqft * 0.1;
  const el = (id) => document.getElementById(id);
  if (el('bc-dispTons')) el('bc-dispTons').textContent = maxTons ? maxTons.toFixed(1) : '—';
  if (el('bc-dispMbtu')) el('bc-dispMbtu').textContent = maxMbtu ? maxMbtu.toFixed(1) : '—';
  if (el('bc-dispCfm')) el('bc-dispCfm').textContent = oaCfm ? Math.round(oaCfm).toLocaleString() : '—';

  if (!sqft) {
    _bcRenderEmpty();
    return;
  }

  const weather = p.basCalc?.weatherOverride || _basCityWeather(cityIdx);
  if (el('bc-weatherStatus')) {
    el('bc-weatherStatus').textContent = p.basCalc?.weatherOverride
      ? 'Weather: uploaded data (' + p.basCalc.weatherOverride.rowsParsed + ' rows)'
      : weather
        ? 'Weather: typical-year data from the Building Automation System Savings Calc template (' +
          weather.cityName +
          ')'
        : 'Weather: no data available for this location — select a different city or upload a temperature CSV';
  }
  if (!weather) {
    _bcRenderEmpty();
    return;
  }
  const humBins = p.basCalc?.humidityOverride?.hourlyBins || weather.humidityBins || null;
  if (el('bc-humidityStatus')) {
    el('bc-humidityStatus').textContent = p.basCalc?.humidityOverride
      ? 'Humidity data: uploaded (' + p.basCalc.humidityOverride.rowsParsed + ' rows)'
      : humBins
        ? 'Humidity data: included'
        : 'Humidity data: not available for this location — upload a humidity CSV to include latent load';
  }
  const hb = weather.hourlyBins;

  function isOcc(h, on, off) {
    if (on === off) return false;
    return on < off ? h >= on && h < off : h >= on || h < off;
  }

  // Setback (scalable) and OA (never scaled) are tracked separately because the Excel
  // template's calibration factor (Savings Calculator!K46/K50) scales only the Max
  // Heating/Cooling Load feeding the setback bin engine — Outside Air sensible + latent
  // loads use the raw OA CFM directly and are never touched by the calibration factor
  // (Existing!D507/D579 reference $E$18 CFM directly, not the calibrated $E$5/$E$15 max
  // load). A single factor scaling the combined setback+OA total (the old approach here)
  // does not reproduce the Excel outputs whenever OA is a non-trivial share of the total.
  const exCoolSetbackM = new Array(12).fill(0),
    exCoolOAM = new Array(12).fill(0);
  const exHeatKwhSetbackM = new Array(12).fill(0),
    exHeatKwhOAM = new Array(12).fill(0);
  const exHeatGasSetbackM = new Array(12).fill(0),
    exHeatGasOAM = new Array(12).fill(0);
  const newCoolSetbackM = new Array(12).fill(0),
    newCoolOAM = new Array(12).fill(0);
  const newHeatKwhSetbackM = new Array(12).fill(0),
    newHeatKwhOAM = new Array(12).fill(0);
  const newHeatGasSetbackM = new Array(12).fill(0),
    newHeatGasOAM = new Array(12).fill(0);
  const exPeakCoolSetbackM = new Array(12).fill(0),
    exPeakCoolOAM = new Array(12).fill(0);
  const newPeakCoolSetbackM = new Array(12).fill(0),
    newPeakCoolOAM = new Array(12).fill(0);

  for (let m = 0; m < 12; m++) {
    for (let bi = 0; bi < BAS_TEMP_BINS.length; bi++) {
      const binTemp = BAS_TEMP_BINS[bi];
      const coolPct = _bcInterp(BAS_COOL_CURVE, binTemp);
      const heatPct = _bcInterp(BAS_HEAT_CURVE, binTemp);
      const vrfCOP = _bcInterp(BAS_VRF_COP, binTemp);

      // Existing cooling load profile
      const exOccCoolTons = exCoolOcc - 10 >= binTemp ? 0 : maxTons * coolPct;
      const exUnoccCoolTons =
        exCoolUnocc >= binTemp
          ? 0
          : exOccCoolTons > 0 && binTemp - exCoolOcc + 10 > 0
            ? ((binTemp - exCoolUnocc) / (binTemp - exCoolOcc + 10)) * exOccCoolTons
            : 0;

      // Existing heating load (MBtu/h)
      let exOccHeatMbtu = 0;
      if (binTemp + 10 <= exHeatOcc) {
        if (heatSrc === 2 || heatSrc === 4) {
          const rawLoad = maxMbtu * heatPct;
          exOccHeatMbtu =
            (rawLoad * vrfPct) / Math.max(vrfCOP, 0.1) + (rawLoad * (1 - vrfPct)) / Math.max(elecCOP, 0.1);
        } else {
          exOccHeatMbtu = (maxMbtu * heatPct) / Math.max(afue, 0.1);
        }
      }
      const exUnoccHeatMbtu =
        binTemp >= exHeatUnocc
          ? 0
          : exOccHeatMbtu > 0 && exHeatOcc - binTemp > 0
            ? ((exHeatUnocc - binTemp) / (exHeatOcc - binTemp)) * exOccHeatMbtu
            : 0;

      // New cooling: scale by setpoint ratio
      let newOccCoolTons = 0;
      if (!(newCoolOcc - 10 >= binTemp)) {
        const exDenom = binTemp - exCoolOcc + 10;
        const newDenom = binTemp - newCoolOcc + 10;
        newOccCoolTons =
          exDenom > 0 && exOccCoolTons > 0 ? maxTons * coolPct * (newDenom / exDenom) : maxTons * coolPct;
        if (newOccCoolTons < 0) newOccCoolTons = 0;
      }
      const newUnoccCoolTons =
        newCoolUnocc >= binTemp
          ? 0
          : newOccCoolTons > 0 && binTemp - newCoolOcc + 10 > 0
            ? ((binTemp - newCoolUnocc) / (binTemp - newCoolOcc + 10)) * newOccCoolTons
            : 0;

      // New heating: scale by setpoint ratio
      let newOccHeatMbtu = 0;
      if (binTemp + 10 <= newHeatOcc) {
        const exHeatDenom = exHeatOcc - binTemp;
        const newHeatDenom = newHeatOcc - binTemp;
        const scale = exHeatDenom > 0 ? newHeatDenom / exHeatDenom : 1;
        if (heatSrc === 2 || heatSrc === 4) {
          const rawLoad = maxMbtu * heatPct * Math.max(scale, 0);
          newOccHeatMbtu =
            (rawLoad * vrfPct) / Math.max(vrfCOP, 0.1) + (rawLoad * (1 - vrfPct)) / Math.max(elecCOP, 0.1);
        } else {
          newOccHeatMbtu = (maxMbtu * heatPct * Math.max(scale, 0)) / Math.max(afue, 0.1);
        }
      }
      const newUnoccHeatMbtu =
        binTemp >= newHeatUnocc
          ? 0
          : newOccHeatMbtu > 0 && newHeatOcc - binTemp > 0
            ? ((newHeatUnocc - binTemp) / (newHeatOcc - binTemp)) * newOccHeatMbtu
            : 0;

      // OA loads (MBtu)
      const exOACoolMbtu = Math.max(0, binTemp > exCoolOcc ? (1.08 * oaCfm * (binTemp - exCoolOcc)) / 1000 : 0);
      const exOAHeatMbtu = Math.max(0, binTemp < exHeatOcc ? (1.08 * oaCfm * (exHeatOcc - binTemp)) / 1000 : 0);
      const newOACoolMbtu = Math.max(0, binTemp > newCoolOcc ? (1.08 * oaCfm * (binTemp - newCoolOcc)) / 1000 : 0);
      const newOAHeatMbtu = Math.max(0, binTemp < newHeatOcc ? (1.08 * oaCfm * (newHeatOcc - binTemp)) / 1000 : 0);

      for (let h = 0; h < 24; h++) {
        const hrs = hb[m][bi][h];
        if (!hrs) continue;

        // Existing schedule occupancy weights
        const exOccMF = isOcc(h, exMfOn, exMfOff) ? 1 : 0;
        const exOccSat = isOcc(h, exSatOn, exSatOff) ? 1 : 0;
        const exOccSun = isOcc(h, exSunOn, exSunOff) ? 1 : 0;
        const exOccW = exOccMF * (5 / 7) + exOccSat * (1 / 7) + exOccSun * (1 / 7);
        const exUnoccW = 1 - exOccW;

        // Existing cooling: ton-hours → kWh (setback, scalable by calibration factor)
        const exCoolTH = hrs * (exOccCoolTons * exOccW + exUnoccCoolTons * exUnoccW);
        const exCoolKwh_h = exCoolTH * coolEff;
        const exOAShut = exOAShutoff && exUnoccW > 0;
        // OA sensible + latent (never scaled by the calibration factor — see note above)
        const exOACoolKwh_h = hrs * (exOACoolMbtu / 12) * coolEff * (exOAShut ? exOccW : 1);
        let exLatentKwh_h = 0;
        if (humBins && humBins[m] && humBins[m][bi]) {
          // Humidity bin data is stored in grains of moisture per lb dry air (matches the
          // Excel source cell-for-cell); divide by 7000 for lb/lb before comparing to the
          // lb/lb setpoint and applying the 4840 Btu/hr-per-CFM-per-lb/lb latent constant —
          // same formula as Existing!D579 in the Excel template.
          const humRatioLbLb = (humBins[m][bi][h] || 0) / 7000;
          if (humRatioLbLb > humRatioSP) {
            const latentMbtu = (4840 * oaCfm * (humRatioLbLb - humRatioSP)) / 1000;
            exLatentKwh_h = hrs * (latentMbtu / 12) * coolEff * (exOAShut ? exOccW : 1);
          }
        }
        exCoolSetbackM[m] += exCoolKwh_h;
        exCoolOAM[m] += exOACoolKwh_h + exLatentKwh_h;

        // Existing heating — setback vs OA kept separate for the same calibration-scope reason
        const exHeatMbtu_h = hrs * (exOccHeatMbtu * exOccW + exUnoccHeatMbtu * exUnoccW);
        const exOAHeatMbtu_h = hrs * exOAHeatMbtu * (exOAShut ? exOccW : 1);
        if (heatSrc === 1) {
          exHeatGasSetbackM[m] += exHeatMbtu_h * 0.001;
          exHeatGasOAM[m] += exOAHeatMbtu_h * 0.001;
        } else if (heatSrc === 3) {
          exHeatGasSetbackM[m] += exHeatMbtu_h * 0.01;
          exHeatGasOAM[m] += exOAHeatMbtu_h * 0.01;
        } else if (heatSrc === 4) {
          exHeatKwhSetbackM[m] += exHeatMbtu_h * 0.293 * (1 - pctGasHeat);
          exHeatKwhOAM[m] += exOAHeatMbtu_h * 0.293 * (1 - pctGasHeat);
          exHeatGasSetbackM[m] += exHeatMbtu_h * 0.01 * pctGasHeat;
          exHeatGasOAM[m] += exOAHeatMbtu_h * 0.01 * pctGasHeat;
        } else {
          exHeatKwhSetbackM[m] += exHeatMbtu_h * 0.293;
          exHeatKwhOAM[m] += exOAHeatMbtu_h * 0.293;
        }

        // New schedule occupancy weights
        const newOccMF = isOcc(h, newMfOn, newMfOff) ? 1 : 0;
        const newOccSat = isOcc(h, newSatOn, newSatOff) ? 1 : 0;
        const newOccSun = isOcc(h, newSunOn, newSunOff) ? 1 : 0;
        const newOccW = newOccMF * (5 / 7) + newOccSat * (1 / 7) + newOccSun * (1 / 7);
        const newUnoccW = 1 - newOccW;

        // New cooling
        const newCoolTH = hrs * (newOccCoolTons * newOccW + newUnoccCoolTons * newUnoccW);
        const newCoolKwh_h = newCoolTH * coolEff;
        const newOAShut = newOAShutoff && newUnoccW > 0;
        const newOACoolKwh_h = hrs * (newOACoolMbtu / 12) * coolEff * (newOAShut ? newOccW : 1);
        let newLatentKwh_h = 0;
        if (humBins && humBins[m] && humBins[m][bi]) {
          const humRatioLbLb = (humBins[m][bi][h] || 0) / 7000;
          if (humRatioLbLb > humRatioSP) {
            const latentMbtu = (4840 * oaCfm * (humRatioLbLb - humRatioSP)) / 1000;
            newLatentKwh_h = hrs * (latentMbtu / 12) * coolEff * (newOAShut ? newOccW : 1);
          }
        }
        newCoolSetbackM[m] += newCoolKwh_h;
        newCoolOAM[m] += newOACoolKwh_h + newLatentKwh_h;

        // New heating
        const newHeatMbtu_h = hrs * (newOccHeatMbtu * newOccW + newUnoccHeatMbtu * newUnoccW);
        const newOAHeatMbtu_h = hrs * newOAHeatMbtu * (newOAShut ? newOccW : 1);
        if (heatSrc === 1) {
          newHeatGasSetbackM[m] += newHeatMbtu_h * 0.001;
          newHeatGasOAM[m] += newOAHeatMbtu_h * 0.001;
        } else if (heatSrc === 3) {
          newHeatGasSetbackM[m] += newHeatMbtu_h * 0.01;
          newHeatGasOAM[m] += newOAHeatMbtu_h * 0.01;
        } else if (heatSrc === 4) {
          newHeatKwhSetbackM[m] += newHeatMbtu_h * 0.293 * (1 - pctGasHeat);
          newHeatKwhOAM[m] += newOAHeatMbtu_h * 0.293 * (1 - pctGasHeat);
          newHeatGasSetbackM[m] += newHeatMbtu_h * 0.01 * pctGasHeat;
          newHeatGasOAM[m] += newOAHeatMbtu_h * 0.01 * pctGasHeat;
        } else {
          newHeatKwhSetbackM[m] += newHeatMbtu_h * 0.293;
          newHeatKwhOAM[m] += newOAHeatMbtu_h * 0.293;
        }

        // Peak tracking
        const isPeak = h >= peakStart && h < peakEnd;
        if (isPeak) {
          exPeakCoolSetbackM[m] += exCoolKwh_h;
          exPeakCoolOAM[m] += exOACoolKwh_h + exLatentKwh_h;
          newPeakCoolSetbackM[m] += newCoolKwh_h;
          newPeakCoolOAM[m] += newOACoolKwh_h + newLatentKwh_h;
        }
      }
    }
  }

  // Calibration factor solves: actual (UA) total = setback_raw * adj + OA_raw, i.e.
  // adj = (actual - OA_raw) / setback_raw. Excel's Savings Calculator!K50/K46 are the
  // converged solution of the same equation (the workbook expresses it as a circular
  // reference — Max Load depends on K50, and K50's own formula sums a calculated total
  // that depends on Max Load — Excel's iterative calculation converges it to this exact
  // closed form). Solving it directly here avoids needing iteration.
  const rawExCoolSetbackTotal = exCoolSetbackM.reduce((a, b) => a + b, 0);
  const rawExCoolOATotal = exCoolOAM.reduce((a, b) => a + b, 0);
  const rawExHeatSetbackTotal = exHeatKwhSetbackM.reduce((a, b) => a + b, 0);
  const rawExHeatOATotal = exHeatKwhOAM.reduce((a, b) => a + b, 0);
  const rawExHeatGasSetbackTotal = exHeatGasSetbackM.reduce((a, b) => a + b, 0);
  const rawExHeatGasOATotal = exHeatGasOAM.reduce((a, b) => a + b, 0);
  let coolAdj = 1,
    heatAdj = 1;
  if (calCoolKwh > 0 && rawExCoolSetbackTotal > 0) coolAdj = (calCoolKwh - rawExCoolOATotal) / rawExCoolSetbackTotal;
  // Heating calibration input ("Existing Heating kWh from UA") is kWh-denominated, so it only
  // calibrates the kWh heating bucket, which is exactly where heatSrc 2 (Electric) and heatSrc 4
  // (Both — see pctGasHeat above) route their existing heating load.
  // 2026-09-23 fix: heatSrc 1/3 (pure gas — MCF/Therms) route their ENTIRE existing heating load
  // into the gas bucket instead (exHeatGasSetbackM/OAM — see the heatSrc branch above); the kWh
  // bucket stays 0 for them, so rawExHeatSetbackTotal was always 0 and heatAdj stayed
  // permanently 1 (uncalibrated) no matter what a user entered — the raw, unscaled bin-model
  // estimate was reported as "Heat Therms Saved" with no ability to match it to a real utility
  // analysis figure (Existing Heating Gas — Therms/MCF from UA, now shown for heatSrc 1/3 too).
  // Calibrates directly against that same closed-form equation, against the gas raw totals.
  // 2026-09-23 (heating-type classifier fix): heatSrc 4 ("Both") can also route effectively ALL
  // of a building's existing heat into the gas bucket via pctGasHeat above (e.g. a gas-boiler
  // school with a few known electric unit heaters — mostly gas, heatSrc correctly resolves to 4,
  // but calHeatKwh is never entered/auto-filled because there is no meaningful kWh heating load
  // to calibrate). Without this branch, heatAdj fell through to the calHeatKwh check, which is
  // never satisfied (rawExHeatSetbackTotal stays 0 when pctGasHeat routed the raw load to gas
  // instead), so heatAdj stayed permanently 1 (uncalibrated) — the same "Heat Therms Saved"
  // symptom the heatSrc 1/3 fix above already solved, now also possible for heatSrc 4 once a
  // building has any real electric-heat evidence. Only activates when the kWh bucket is actually
  // empty (rawExHeatSetbackTotal <= 0) — a true mixed-load building (both buckets populated)
  // still falls through to the existing kWh-only calibration below, unchanged.
  // 2026-09-25 fix #2 (heating outside-air double count, corrected): the 2026-09-25 fix #1
  // (c4a4e49) netted OA against setback but then added OA back — MAX(setback*heatAdj - OA, 0) +
  // OA, algebraically MAX(setback*heatAdj, OA) — citing Existing!D168. D168 is NOT the heating
  // formula: Existing!D33's row label is "Potential Occupied Ton Hours Load (cooling setback)"
  // — D168 is a COOLING ton-hours cell (confirmed A168=102.5, a warm bin; D641, D168's own OA
  // subtrahend, uses the $E$10=55 cooling-side sensible+latent formula). The real heating
  // setback cell is Existing!AH34 (row label AH33 "Potential Occupied Mbtu load (heating
  // setback)"): =MAX(IF($A34>50,0,Temperature!E6*VLOOKUP($A34,$S$7:$X$17,4))-D507,0) — D507 is
  // the heating-only OA subtrahend (Existing!D506 label "Hourly Heating/Cooling Load",
  // IF($A<$E$12,...) sensible only). AH34 has NO add-back term of any kind, and none of its
  // downstream readers (BF34/BG34/BH34 weekday-weighted rollups, AE34 sum) add one back either
  // — traced the full chain, verified directly against BAS Savings Calc Template.xlsm via
  // openpyxl (my-knowledge-base/raw/Calcs/BAS Savings Calc Template.xlsm), 2026-09-25. So the
  // correct combine is a plain net-and-clamp with NO add-back: MAX(setback*heatAdj - OA, 0).
  // Calibration re-derived for that formula (assuming no month clamps to 0, the normal case):
  // entered = heatAdj*rawSetbackTotal - rawOATotal => heatAdj = (entered + rawOATotal) /
  // rawSetbackTotal. (The c4a4e49 form, heatAdj = entered/rawSetbackTotal with no +OA term, was
  // only valid for its own incorrect combine formula and is wrong for this corrected one.) If a
  // month's clamp does activate the linear closed form is an approximation, same caveat as the
  // existing coolAdjNegative warning pattern for cooling.
  if (heatSrc === 1 || heatSrc === 3) {
    if (calHeatGas > 0 && rawExHeatGasSetbackTotal > 0)
      heatAdj = (calHeatGas + rawExHeatGasOATotal) / rawExHeatGasSetbackTotal;
  } else if (heatSrc === 4 && rawExHeatSetbackTotal <= 0 && rawExHeatGasSetbackTotal > 0) {
    if (calHeatGas > 0) heatAdj = (calHeatGas + rawExHeatGasOATotal) / rawExHeatGasSetbackTotal;
  } else if (calHeatKwh > 0 && rawExHeatSetbackTotal > 0) {
    heatAdj = (calHeatKwh + rawExHeatOATotal) / rawExHeatSetbackTotal;
  }
  if (el('bc-adjCool')) el('bc-adjCool').textContent = coolAdj.toFixed(3);
  if (el('bc-adjHeat')) el('bc-adjHeat').textContent = heatAdj.toFixed(3);
  // 2026-09-23: coolAdj goes negative when the entered calibration kWh is below the outside-air-
  // only raw cooling total (rawExCoolOATotal) — the formula is correct (it is the only value that
  // makes setback*adj + OA equal the entered figure), but a negative factor silently flips
  // "Cool Saved" negative with no explanation. Plain-language warning only; math unchanged.
  const coolAdjNegative = calCoolKwh > 0 && coolAdj < 0;
  if (el('bc-coolAdjWarn')) el('bc-coolAdjWarn').style.display = coolAdjNegative ? '' : 'none';

  // Calibrated monthly totals — Cooling: setback scaled by the factor, OA added straight (see
  // note above; cooling has no Excel netting/clamp — confirmed Excel-equivalent by the
  // 2026-09-22 parity audit, "do not 'fix' the cooling calibration" — cooling is intentionally
  // unchanged by this fix).
  const exCoolM = exCoolSetbackM.map((v, m) => v * coolAdj + exCoolOAM[m]);
  const newCoolM = newCoolSetbackM.map((v, m) => v * coolAdj + newCoolOAM[m]);
  // Heating: net the outside-air load against the calibrated setback load and clamp at 0 — MAX
  // (setback*heatAdj - OA, 0), matching Excel!AH34's MAX(setback - OA, 0) netting exactly, no
  // add-back (2026-09-25 fix #2 — see calibration comment above for why D168/+OA was wrong).
  // Applied for both Existing and New, both the kWh-denominated and gas-denominated heating
  // buckets (every heatSrc routes into one or both of those two bucket pairs above).
  const exHeatKwhM = exHeatKwhSetbackM.map((v, m) => Math.max(v * heatAdj - exHeatKwhOAM[m], 0));
  const newHeatKwhM = newHeatKwhSetbackM.map((v, m) => Math.max(v * heatAdj - newHeatKwhOAM[m], 0));
  const exHeatGasM = exHeatGasSetbackM.map((v, m) => Math.max(v * heatAdj - exHeatGasOAM[m], 0));
  const newHeatGasM = newHeatGasSetbackM.map((v, m) => Math.max(v * heatAdj - newHeatGasOAM[m], 0));
  const exPeakCoolM = exPeakCoolSetbackM.map((v, m) => v * coolAdj + exPeakCoolOAM[m]);
  const newPeakCoolM = newPeakCoolSetbackM.map((v, m) => v * coolAdj + newPeakCoolOAM[m]);

  // Compute savings with calibration
  const coolSavM = [],
    heatKwhSavM = [],
    heatGasSavM = [],
    totalKwhSavM = [];
  const peakKwhSavM = [],
    nonPeakKwhSavM = [];
  let annCoolSav = 0,
    annHeatKwhSav = 0,
    annHeatGasSav = 0,
    annTotalKwh = 0,
    annPeak = 0,
    annNonPeak = 0;
  const gasLabel = heatSrc === 1 ? 'Thousand Cubic Feet' : heatSrc === 3 ? 'Therms' : 'Therms';

  for (let m = 0; m < 12; m++) {
    const cs = exCoolM[m] - newCoolM[m];
    const hs = exHeatKwhM[m] - newHeatKwhM[m];
    const gs = exHeatGasM[m] - newHeatGasM[m];
    coolSavM[m] = cs;
    heatKwhSavM[m] = hs;
    heatGasSavM[m] = gs;
    totalKwhSavM[m] = cs + hs;
    const pkSav = exPeakCoolM[m] - newPeakCoolM[m];
    peakKwhSavM[m] = pkSav;
    nonPeakKwhSavM[m] = cs - pkSav + hs;
    annCoolSav += cs;
    annHeatKwhSav += hs;
    annHeatGasSav += gs;
    annTotalKwh += cs + hs;
    annPeak += pkSav;
    annNonPeak += cs - pkSav + hs;
  }

  // Evergy rebate — matches Excel Savings Calculator!V88/V89 (no MAX/IF floor anywhere in that
  // chain; a negative peak or non-peak savings figure produces a negative rebate line that flows
  // straight into the total, same as the workbook). The site previously floored each term at 0,
  // which overstated the total whenever a component was negative (2026-09-22 parity audit finding
  // #2). Informational only — see _bcToggleRebateVisibility, never folds into m.totalDollar.
  const rebatePeak = annPeak * 0.1;
  const rebateNonPeak = annNonPeak * 0.04;
  const totalRebate = rebatePeak + rebateNonPeak;

  // Update KPIs
  const fmt = (n) => (n ? Math.round(n).toLocaleString() : '0');
  const fmtD = (n) =>
    n ? (n < 0 ? '-$' + Math.abs(Math.round(n)).toLocaleString() : '$' + Math.round(n).toLocaleString()) : '$0';
  if (el('bc-kpi-kwh')) el('bc-kpi-kwh').textContent = fmt(annTotalKwh) + ' kWh';
  if (el('bc-kpi-gas')) el('bc-kpi-gas').textContent = fmt(annHeatGasSav) + ' ' + gasLabel;
  if (el('bc-kpi-cool')) el('bc-kpi-cool').textContent = fmt(annCoolSav) + ' kWh';
  if (el('bc-kpi-rebate')) el('bc-kpi-rebate').textContent = fmtD(totalRebate);

  // Store for measure integration
  p._bcResults = {
    kwhSavings: totalKwhSavM,
    gasSavings: heatGasSavM,
    coolKwhSavings: coolSavM,
    heatKwhSavings: heatKwhSavM,
    peakKwhSavings: peakKwhSavM,
    nonPeakKwhSavings: nonPeakKwhSavM,
    annTotalKwh,
    annHeatGasSav,
    totalRebate,
  };

  // Render results table
  const res = el('bc-results');
  if (!res) return;
  let html = coolAdjNegative
    ? `<div style="margin-bottom:12px;background:var(--warn-dim);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn)">The cooling kWh entered is lower than the outside air cooling alone. Check the cooling kWh.</div>`
    : '';
  html += `<table class="dtbl" style="font-size:11px;border-collapse:collapse;width:100%">
          <thead><tr>
            <th style="text-align:left;padding:5px 8px;font-size:10px">Month</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Existing Cooling kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">New Cooling kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--em2)">Cooling Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Heating kWh Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Heating ${gasLabel} Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--em);font-weight:700">Total kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--amber)">Peak kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Non-Peak kWh</th>
          </tr></thead><tbody>`;
  for (let m = 0; m < 12; m++) {
    const bg = m % 2 ? 'background:rgba(255,255,255,0.015)' : '';
    html += `<tr style="${bg}">
            <td style="font-weight:600;padding:4px 8px">${BAS_MO[m]}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--text2)">${fmt(exCoolM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--text2)">${fmt(newCoolM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--em2)">${fmt(coolSavM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px">${fmt(heatKwhSavM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px">${fmt(heatGasSavM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--em);font-weight:600">${fmt(totalKwhSavM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--amber)">${fmt(peakKwhSavM[m])}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px">${fmt(nonPeakKwhSavM[m])}</td>
          </tr>`;
  }
  html += `<tr style="border-top:2px solid var(--border);font-weight:700">
          <td style="padding:6px 8px">TOTAL</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--text2)">${fmt(exCoolM.reduce((a, b) => a + b, 0))}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--text2)">${fmt(newCoolM.reduce((a, b) => a + b, 0))}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--em2)">${fmt(annCoolSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annHeatKwhSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annHeatGasSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--em)">${fmt(annTotalKwh)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--amber)">${fmt(annPeak)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annNonPeak)}</td>
        </tr></tbody></table>`;

  // Evergy rebate summary — hidden unless "Show Evergy Rebate estimate" is checked (item 5ap):
  // informational only, never part of a savings total shown to a client (m.totalDollar in
  // bcApplyToMeasure/bcAddAsMeasure never includes it).
  const showRebate = document.getElementById('bc-showRebate')?.checked;
  html += `<div id="bc-rebate-detail" style="margin-top:14px;display:${showRebate ? 'flex' : 'none'};gap:12px;flex-wrap:wrap;align-items:center">
          <div style="background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--text2)">Peak kWh × $0.10 =</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--amber);margin-left:6px">${fmtD(rebatePeak)}</span>
          </div>
          <div style="background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--text2)">Non-Peak kWh × $0.04 =</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--text);margin-left:6px">${fmtD(rebateNonPeak)}</span>
          </div>
          <div style="background:var(--em-dim);border:1px solid var(--em);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--em)">Total Evergy Rebate (estimate) =</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--em);font-size:16px;margin-left:6px">${fmtD(totalRebate)}</span>
          </div>
        </div>`;

  res.innerHTML = html;
}

function _bcRenderEmpty() {
  const el = document.getElementById('bc-results');
  if (el)
    el.innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">Enter building square footage above to calculate savings...</div>';
  ['bc-kpi-kwh', 'bc-kpi-gas', 'bc-kpi-cool', 'bc-kpi-rebate'].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.textContent = '—';
  });
  const warnEl = document.getElementById('bc-coolAdjWarn');
  if (warnEl) warnEl.style.display = 'none';
}

/* ── E. Save ── */
function bcSaveInputs(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  p.basCalc = {
    ...(p.basCalc || {}),
    sqft: _bcGv('bc-sqft'),
    heatSrc: parseInt(_bcGv('bc-heatSrc')) || 2,
    vrfPct: _bcGv('bc-vrfPct'),
    coolEff: _bcGv('bc-coolEff'),
    afue: _bcGv('bc-afue'),
    elecCOP: _bcGv('bc-elecCOP'),
    city: parseInt(_bcGv('bc-city')) || 4,
    exCoolOcc: _bcGv('bc-exCoolOcc'),
    exCoolUnocc: _bcGv('bc-exCoolUnocc'),
    exHeatOcc: _bcGv('bc-exHeatOcc'),
    exHeatUnocc: _bcGv('bc-exHeatUnocc'),
    exOAShutoff: document.getElementById('bc-exOAShutoff')?.value || 'yes',
    exMfOn: _bcGv('bc-exMfOn'),
    exMfOff: _bcGv('bc-exMfOff'),
    exSatOn: _bcGv('bc-exSatOn'),
    exSatOff: _bcGv('bc-exSatOff'),
    exSunOn: _bcGv('bc-exSunOn'),
    exSunOff: _bcGv('bc-exSunOff'),
    newCoolOcc: _bcGv('bc-newCoolOcc'),
    newCoolUnocc: _bcGv('bc-newCoolUnocc'),
    newHeatOcc: _bcGv('bc-newHeatOcc'),
    newHeatUnocc: _bcGv('bc-newHeatUnocc'),
    newOAShutoff: document.getElementById('bc-newOAShutoff')?.value || 'yes',
    newMfOn: _bcGv('bc-newMfOn'),
    newMfOff: _bcGv('bc-newMfOff'),
    newSatOn: _bcGv('bc-newSatOn'),
    newSatOff: _bcGv('bc-newSatOff'),
    newSunOn: _bcGv('bc-newSunOn'),
    newSunOff: _bcGv('bc-newSunOff'),
    calCoolKwh: _bcGv('bc-calCoolKwh'),
    calHeatKwh: _bcGv('bc-calHeatKwh'),
    calHeatGas: _bcGv('bc-calHeatGas'),
    peakStart: _bcGv('bc-peakStart'),
    peakEnd: _bcGv('bc-peakEnd'),
    humRatioSP: _bcGv('bc-humRatioSP') || 0.0082,
    showRebate: !!document.getElementById('bc-showRebate')?.checked,
    weatherOverride: p.basCalc?.weatherOverride || null,
    humidityOverride: p.basCalc?.humidityOverride || null,
  };
  sset('en_projects', projects);
  showToast('BAS calc saved ✓');
}

/* ── F. Measure Integration ── */
function bcAddAsMeasure(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p._bcResults) {
    showToast('Run calculation first');
    return;
  }
  const r = p._bcResults;
  const sd = getProjSavingsData(projId);
  const bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : p.buildings || [];
  const cityName = BAS_CITIES.find((c) => c.id === (p.basCalc?.city || 4))?.name || 'Unknown';
  sd.measures.push({
    id: 'm' + Date.now(),
    selected: true,
    msrNum: sd.measures.length + 1 + '',
    bldgId: _calcTemplateContext?.bldgId || bldgs[0]?.id || '',
    desc: 'BAS HVAC Optimization — ' + cityName + ' — ' + (p.basCalc?.sqft || 0) + ' sf',
    kwh: r.kwhSavings.map((k) => Math.round(k)),
    kw: r.peakKwhSavings
      ? r.peakKwhSavings.map((pk) => {
          const hrs = (p.basCalc?.peakEnd || 18) - (p.basCalc?.peakStart || 16);
          return hrs > 0 ? Math.round((pk / hrs) * 10) / 10 : 0;
        })
      : Array(12).fill(0),
    gas: r.gasSavings.map((g) => Math.round(g)),
    totalDollar: 0,
    source: 'bas',
  });
  sset('en_projects', projects);
  closeCalcTemplate();
  showToast('BAS measure added to savings matrix ✓');
}

function bcApplyToMeasure(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p._bcResults || !_calcTemplateContext?.targetMeasureId) {
    showToast('No target measure');
    return;
  }
  const r = p._bcResults;
  const sd = getProjSavingsData(projId);
  const m = sd.measures.find((x) => x.id === _calcTemplateContext.targetMeasureId);
  if (!m) {
    showToast('Measure not found');
    return;
  }
  m.kwh = r.kwhSavings.map((k) => Math.round(k));
  m.kw = r.peakKwhSavings
    ? r.peakKwhSavings.map((pk) => {
        const hrs = (p.basCalc?.peakEnd || 18) - (p.basCalc?.peakStart || 16);
        return hrs > 0 ? Math.round((pk / hrs) * 10) / 10 : 0;
      })
    : Array(12).fill(0);
  m.gas = r.gasSavings.map((g) => Math.round(g));
  m.source = 'bas';
  const cityName = BAS_CITIES.find((c) => c.id === (p.basCalc?.city || 4))?.name || 'Unknown';
  if (!m.desc || m.desc.trim() === '') m.desc = 'BAS HVAC Optimization — ' + cityName;
  // Same fallback as solarApplyToMeasure above — see comment there (2026-09-23-rate-source).
  const rates = _svRatesOrCanonical(sd, projId, m.bldgId);
  const SUMMER_MOS = [5, 6, 7, 8]; // Jun–Sep (0-indexed)
  let total = 0;
  for (let mo = 0; mo < 12; mo++) {
    const isSummer = SUMMER_MOS.includes(mo);
    total += (m.kwh[mo] || 0) * (isSummer ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
    total += (m.gas[mo] || 0) * (rates.thermRate || 0);
  }
  m.totalDollar = total;
  sset('en_projects', projects);
  const msrNum = m.msrNum;
  closeCalcTemplate();
  showToast('BAS calc applied to Measure #' + msrNum + ' ✓');
}

/* ── G. Use Equipment Matrix Data ── */
// Pulls averaged existing/proposed setpoints for the target building's Equipment Matrix rows
// into Section C (item 5ap) — a deliberate, one-click pull distinct from the automatic Set
// Points autofill in calc-autofill.js (chCalcAutofillFields): the Equipment Matrix's own
// zone-level setpoint columns (added in 5aa/5ao) are a separate source a user pulls on demand
// rather than have silently override a typed edit on every open. Reuses
// emBuildSetpointExportRows (app/equipment-matrix.js) — same join/normalize/heating-type logic
// as the Setpoint Export feature, not a second implementation of it.
function bcUseEquipmentMatrixData(projId) {
  const bldgId = _calcTemplateContext?.bldgId || null;
  if (!bldgId) {
    showToast('Open this calculator from a specific building to use its Equipment Matrix data', 'error');
    return;
  }
  if (typeof emBuildSetpointExportRows !== 'function') {
    showToast('Equipment Matrix data is not available', 'error');
    return;
  }
  const rows = emBuildSetpointExportRows(projId, bldgId, null);
  if (!rows.length) {
    showToast('No Equipment Matrix rows found for this building');
    return;
  }
  const avg = (idx) => {
    const vals = rows.map((r) => parseFloat(r[idx])).filter((v) => !isNaN(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  // Column indices match EM_SETPOINT_EXPORT_HEADERS / emBuildSetpointExportRows's push order.
  const fields = {
    'bc-exHeatOcc': avg(3),
    'bc-exCoolOcc': avg(4),
    'bc-exHeatUnocc': avg(5),
    'bc-exCoolUnocc': avg(6),
    'bc-newHeatOcc': avg(12),
    'bc-newCoolOcc': avg(13),
    'bc-newHeatUnocc': avg(14),
    'bc-newCoolUnocc': avg(15),
  };
  let filled = 0;
  Object.keys(fields).forEach((id) => {
    const v = fields[id];
    if (v === null) return;
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.value = v;
    filled++;
    _bcMarkTouched(projId, id.replace(/^bc-/, ''));
  });
  if (!filled) {
    showToast('No numeric setpoint data in the Equipment Matrix for this building');
    return;
  }
  _bcDoCalc(projId);
  showToast(
    'Filled ' +
      filled +
      ' setpoint field' +
      (filled === 1 ? '' : 's') +
      ' from ' +
      rows.length +
      ' Equipment Matrix row' +
      (rows.length === 1 ? '' : 's') +
      ' ✓',
  );
}

/* ── H. Weather CSV Upload ── */
function _bcHandleCSV(input, projId) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 10) {
        showToast('CSV too short — expected weather bin data');
        return;
      }
      const header = lines[0].toLowerCase();
      const delim = header.includes('\t') ? '\t' : ',';
      const rows = lines.slice(1).map((l) => l.split(delim));
      const hb = [];
      for (let m = 0; m < 12; m++) {
        hb[m] = [];
        for (let b = 0; b < BAS_TEMP_BINS.length; b++) hb[m][b] = new Array(24).fill(0);
      }
      const moMap = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
        january: 0,
        february: 1,
        march: 2,
        april: 3,
        june: 5,
        july: 6,
        august: 7,
        september: 8,
        october: 9,
        november: 10,
        december: 11,
      };
      let parsed = 0;
      rows.forEach((r) => {
        if (r.length < 28) return;
        const tempMid = parseFloat(r[1]);
        const moStr = (r[3] || '').trim().toLowerCase().replace(/\./g, '');
        const mi = moMap[moStr] ?? moMap[moStr.slice(0, 3)];
        if (isNaN(tempMid) || mi === undefined) return;
        let bi = -1;
        for (let b = 0; b < BAS_TEMP_BINS.length; b++) {
          if (Math.abs(BAS_TEMP_BINS[b] - tempMid) < 3) {
            bi = b;
            break;
          }
        }
        if (bi < 0) return;
        for (let h = 0; h < 24; h++) {
          hb[mi][bi][h] = parseFloat(r[h + 4]) || 0;
        }
        parsed++;
      });
      if (parsed < 20) {
        showToast('Could not parse enough rows (' + parsed + ' found). Check CSV format.');
        return;
      }
      const p = projects.find((x) => x.id === projId);
      if (!p) return;
      if (!p.basCalc) p.basCalc = {};
      p.basCalc.weatherOverride = { hourlyBins: hb, cityName: file.name, rowsParsed: parsed };
      sset('en_projects', projects);
      openBASCalc(projId);
      showToast('Weather data uploaded ✓ (' + parsed + ' rows)');
    } catch (err) {
      showToast('CSV parse error: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function _bcHandleHumidityCSV(input, projId) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 10) {
        showToast('CSV too short');
        return;
      }
      const delim = lines[0].includes('\t') ? '\t' : ',';
      const rows = lines.slice(1).map((l) => l.split(delim));
      const hb = [];
      for (let m = 0; m < 12; m++) {
        hb[m] = [];
        for (let b = 0; b < BAS_TEMP_BINS.length; b++) hb[m][b] = new Array(24).fill(0);
      }
      const moMap = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
        january: 0,
        february: 1,
        march: 2,
        april: 3,
        june: 5,
        july: 6,
        august: 7,
        september: 8,
        october: 9,
        november: 10,
        december: 11,
      };
      let parsed = 0;
      rows.forEach((r) => {
        if (r.length < 28) return;
        const humMid = parseFloat(r[1]);
        const moStr = (r[3] || '').trim().toLowerCase().replace(/\./g, '');
        const mi = moMap[moStr] ?? moMap[moStr.slice(0, 3)];
        if (isNaN(humMid) || mi === undefined) return;
        let bi = -1;
        for (let b = 0; b < BAS_TEMP_BINS.length; b++) {
          if (Math.abs(BAS_TEMP_BINS[b] - humMid) < 3) {
            bi = b;
            break;
          }
        }
        if (bi < 0) return;
        for (let h = 0; h < 24; h++) {
          hb[mi][bi][h] = parseFloat(r[h + 4]) || 0;
        }
        parsed++;
      });
      if (parsed < 20) {
        showToast('Could not parse enough humidity rows (' + parsed + ')');
        return;
      }
      const p = projects.find((x) => x.id === projId);
      if (!p || !p.basCalc) return;
      p.basCalc.humidityOverride = { hourlyBins: hb, cityName: file.name, rowsParsed: parsed };
      sset('en_projects', projects);
      const statusEl = document.getElementById('bc-humidityStatus');
      if (statusEl) statusEl.textContent = '✓ Humidity loaded (' + parsed + ' rows)';
      _bcLiveCalc(projId);
      showToast('Humidity data uploaded ✓ (' + parsed + ' rows)');
    } catch (err) {
      showToast('Humidity CSV parse error: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function _bcClearWeather(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.basCalc) return;
  p.basCalc.weatherOverride = null;
  p.basCalc.humidityOverride = null;
  sset('en_projects', projects);
  openBASCalc(projId);
  showToast('Weather data cleared — using typical-year weather data');
}
