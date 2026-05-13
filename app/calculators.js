/* ══════════════════════════════════════════════════════
         HVAC LOAD ESTIMATION — Per-Building with Reverse Utility Analysis
      ══════════════════════════════════════════════════════ */
let _hvlSelBldg = {}; // track selected building per project
let _hvlMethod = {}; // track selected method per project-building
let _hvlRevData = {}; // reverse utility analysis data per project-building

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
            <div style="margin-left:auto;display:flex;gap:8px">
              <button class="btn btn-ghost btn-sm" onclick="hvacLoadSave(${projId})">💾 Save</button>
              <button class="btn btn-em btn-sm" onclick="hvacLoadCalc(${projId})">⚡ Calculate</button>
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
  // Render method content
  _hvlRenderMethod(projId, selBid, method);
  // Re-render saved load estimate results if a prior calculation exists
  if (p.hvacLoadEst) {
    requestAnimationFrame(() => hvacLoadCalc(projId));
  }
}

function _hvlSelectBldg(projId, bldgId) {
  _hvlSelBldg[projId] = bldgId;
  initHvacLoadTab(projId);
}

function _buildBaselineDataHtml(b) {
  if (!b) return '';
  const sqft = parseInt(b.sqft) || 0;
  const meters = b.meters || [];
  const elecM = meters.find((m) => m.commodity === 'Electric');
  const gasM = meters.find((m) => m.commodity === 'Gas');
  const propaneM = meters.find((m) => m.commodity === 'Propane');
  function _blBillsByMo(meter) {
    if (!meter) return {};
    const blBills = _dashGetBaselineBills(meter);
    const allBills = (meter.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
    const bills = blBills.length ? blBills : allBills;
    const incl = meter.inclusive !== false;
    const byMo = {};
    bills.forEach((bill) => {
      const ym = normMonth(bill.start, bill.end, incl, allBills);
      if (!ym) return;
      const mo = parseInt(ym.split('-')[1]) - 1;
      byMo[mo] = bill;
    });
    return byMo;
  }
  const eByMo = _blBillsByMo(elecM);
  const gByMo = _blBillsByMo(gasM);
  const pByMo = _blBillsByMo(propaneM);
  let totKwh = 0,
    totKw = 0,
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
      totKwh += parseFloat(eb.kwh) || parseFloat(eb.usage) || 0;
      const kwVal = parseFloat(eb.demandKW) || parseFloat(eb.billedKW) || 0;
      if (kwVal > 0) {
        totKw += kwVal;
        kwMonths++;
      }
      totKwCost += parseFloat(eb.kwCost) || parseFloat(eb.demandCost) || 0;
      totKwhCost += parseFloat(eb.kwhCost) || parseFloat(eb.energyCost) || 0;
      totElecCost += parseFloat(eb.totalCost) || parseFloat(eb.cost) || 0;
    }
    const gb = gByMo[i];
    if (gb) {
      totTherms += parseFloat(gb.therms) || parseFloat(gb.usage) || 0;
      totGasCost += parseFloat(gb.totalCost) || parseFloat(gb.cost) || 0;
    }
    const pb = pByMo[i];
    if (pb) {
      totPropGal += parseFloat(pb.gallonsDelivered) || parseFloat(pb.kwh) || parseFloat(pb.usage) || 0;
      totPropCost += parseFloat(pb.totalCost) || parseFloat(pb.cost) || 0;
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
                  ${elecM ? '<th style="text-align:right">kWh</th><th style="text-align:right">Actual kW</th><th style="text-align:right">kW Cost</th><th style="text-align:right">kWh Cost</th><th style="text-align:right">Electric Cost</th><th style="text-align:right">Avg $/kWh</th><th style="text-align:right">Avg $/kW</th><th style="text-align:right">Load Factor</th>' : ''}
                  ${gasM ? '<th style="border-left:2px solid var(--border2);text-align:right">Therms</th><th style="text-align:right">Avg $/Therm</th><th style="text-align:right">Gas Cost</th>' : ''}
                  ${propaneM ? '<th style="border-left:2px solid var(--border2);text-align:right">Propane Gal</th><th style="text-align:right">Avg $/Gal</th><th style="text-align:right">Propane Cost</th>' : ''}
                  <th style="text-align:right;border-left:2px solid var(--border2)">Total Utility</th>
                </tr>
              </thead>
              <tbody>
                ${MO_SHORT.map((mo, i) => {
                  const eb = eByMo[i] || {};
                  const gb = gByMo[i] || {};
                  const pb = pByMo[i] || {};
                  const kwh = parseFloat(eb.kwh) || parseFloat(eb.usage) || 0;
                  const kw = parseFloat(eb.demandKW) || parseFloat(eb.billedKW) || 0;
                  const kwCost = parseFloat(eb.kwCost) || parseFloat(eb.demandCost) || 0;
                  const kwhCost = parseFloat(eb.kwhCost) || parseFloat(eb.energyCost) || 0;
                  const eCost = parseFloat(eb.totalCost) || parseFloat(eb.cost) || 0;
                  const avgKwh = getStoredRate(eb, 'kwh');
                  const avgKw = getStoredRate(eb, 'kw');
                  const days = eb.days || 30;
                  const lf = kw > 0 && kwh > 0 ? kwh / (kw * 24 * days) : 0;
                  const therms = parseFloat(gb.therms) || parseFloat(gb.usage) || 0;
                  const gCost = parseFloat(gb.totalCost) || parseFloat(gb.cost) || 0;
                  const avgTherm = therms > 0 && gCost > 0 ? gCost / therms : 0;
                  const propGal = parseFloat(pb.gallonsDelivered) || parseFloat(pb.kwh) || parseFloat(pb.usage) || 0;
                  const pCost = parseFloat(pb.totalCost) || parseFloat(pb.cost) || 0;
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
  wrap.innerHTML = _buildBaselineDataHtml(b);
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

  if (method === 'thumb') {
    wrap.innerHTML = `<div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">📐 Rules of Thumb — Industry Standard Estimates</span></div>
            <div style="padding:16px">
              <div class="g2" style="gap:12px">
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">⚡ Electric (kWh) Breakdown</div>
                  <div class="fg"><label class="fl">HVAC % of Total kWh</label><input class="fi hvl-in" id="hvl-t-kwhPct-${projId}" type="number" value="45" min="0" max="100" step="1"><div class="fhint">Typical: 30-60% depending on climate & building type</div></div>
                  <div class="fg"><label class="fl">Cooling % of HVAC kWh</label><input class="fi hvl-in" id="hvl-t-coolKwhPct-${projId}" type="number" value="65" min="0" max="100"><div class="fhint">Typical: 55-75%</div></div>
                  <div class="fg"><label class="fl">Heating % of HVAC kWh (electric heat only)</label><input class="fi hvl-in" id="hvl-t-heatKwhPct-${projId}" type="number" value="${p.heatType && (p.heatType.includes('Electric') || p.heatType.includes('Heat Pump') || p.heatType.includes('VRF')) ? '35' : '0'}" min="0" max="100"><div class="fhint">${p.heatType && p.heatType.includes('Gas') ? "0% — Gas heat doesn't use electric kWh for heating" : 'Typical: 25-45% if electric/heat pump'}</div></div>
                </div>
                <div class="card" style="background:var(--s1);padding:14px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">⚡ Electric Demand (kW) Breakdown</div>
                  <div class="fg"><label class="fl">HVAC % of Peak kW</label><input class="fi hvl-in" id="hvl-t-kwPct-${projId}" type="number" value="55" min="0" max="100"><div class="fhint">Typical: 40-65% — HVAC is usually the largest demand driver</div></div>
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin:14px 0 10px">🔥 Gas (Therms) Breakdown</div>
                  <div class="fg"><label class="fl">HVAC % of Total Gas</label><input class="fi hvl-in" id="hvl-t-gasPct-${projId}" type="number" value="${p.heatType && p.heatType.includes('Gas') ? '85' : '15'}" min="0" max="100"><div class="fhint">${p.heatType && p.heatType.includes('Gas') ? 'Typical: 70-95% for gas-heated buildings' : 'Typical: 0-20% for DHW/kitchen only'}</div></div>
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
                  <div class="fg"><label class="fl">Lighting Watt/sqft</label><input class="fi hvl-in" id="hvl-n-lightW-${projId}" type="number" step="0.01" value="1.0"><div class="fhint">LED: 0.4-0.8, T8 Fluor: 1.0-1.4</div></div>
                  <div class="fg"><label class="fl">Lighting Hours/Year</label><input class="fi hvl-in" id="hvl-n-lightHrs-${projId}" type="number" value="3000"></div>
                  <div class="fg"><label class="fl">Plug Load Watt/sqft</label><input class="fi hvl-in" id="hvl-n-plugW-${projId}" type="number" step="0.01" value="1.5"><div class="fhint">Office: 1-3, School: 0.5-1.5</div></div>
                  <div class="fg"><label class="fl">Plug Load Hours/Year</label><input class="fi hvl-in" id="hvl-n-plugHrs-${projId}" type="number" value="2500"></div>
                </div>
                <div class="fg"><label class="fl">Other Base Electric kWh/yr (DHW, kitchen, etc.)</label><input class="fi hvl-in" id="hvl-n-otherKwh-${projId}" type="number" value="0"></div>
                <div class="fg"><label class="fl">Non-HVAC Gas Therms/yr (DHW, kitchen)</label><input class="fi hvl-in" id="hvl-n-otherGas-${projId}" type="number" value="0"></div>
              </div>
            </div>
          </div>`;
  }
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
      const therms = parseFloat(bill.therms) || parseFloat(bill.usage) || 0;
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
                  <th style="width:40px">Qty</th>
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
                  <th style="width:40px">Qty</th>
                  <th style="width:60px">Size</th>
                  <th style="width:70px">Units</th>
                  <th style="width:65px;text-align:right">Therm/hr</th>
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
  // Clear results when switching methods
  const resWrap = document.getElementById('hvl-results-' + projId);
  if (resWrap) resWrap.innerHTML = '';
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
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:10px">EUI Reference</div>
              <div style="font-size:13px;color:var(--text2);line-height:1.7">
                CBECS National Median: <strong style="color:var(--em)">${CBECS_EUI[type] || 'N/A'} kBtu/ft²</strong><br>
                Climate zone ${clim} adjustments applied to HVAC split percentages.
              </div>
            </div>
          </div>`;
}

function hvacLoadCalc(projId) {
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

  // Get total utility data from baseline bills only (matches Baseline Data table)
  let totalKwh = 0,
    totalKw = 0,
    totalGas = 0;
  const _hvlElecByMo = {};
  const _hvlGasByMo = {};
  const _gatherBldg = (b) => {
    (b.meters || []).forEach((m) => {
      const blBills = _dashGetBaselineBills(m);
      const allBills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const bills = blBills.length ? blBills : allBills;
      const incl = m.inclusive !== false;
      bills.forEach((bill) => {
        const ym = normMonth(bill.start, bill.end, incl, allBills);
        const mo = ym ? parseInt(ym.split('-')[1]) - 1 : _parseISO(bill.start).getMonth();
        if (m.commodity === 'Electric') {
          const kwh = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          totalKwh += kwh;
          totalKw = Math.max(totalKw, parseFloat(bill.demandKW) || 0);
          _hvlElecByMo[mo] = (_hvlElecByMo[mo] || 0) + kwh;
        } else if (m.commodity === 'Gas') {
          const therms = parseFloat(bill.therms) || parseFloat(bill.usage) || 0;
          totalGas += therms;
          _hvlGasByMo[mo] = (_hvlGasByMo[mo] || 0) + therms;
        } else if (m.commodity === 'Propane') {
          // Convert gallons to therms (0.9153 therms/gal) so propane
          // rolls up into the same gas total used by HVAC Load Est.
          const gal = parseFloat(bill.gallonsDelivered) || parseFloat(bill.usage) || 0;
          const thermsEq = gal * 0.9153;
          totalGas += thermsEq;
          _hvlGasByMo[mo] = (_hvlGasByMo[mo] || 0) + thermsEq;
        }
      });
    });
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

  // Determine cooling vs heating kWh split
  let coolPctOfHvac = 0.65;
  if (method === 'thumb') {
    coolPctOfHvac = (parseFloat(document.getElementById(`hvl-t-coolKwhPct-${projId}`)?.value) || 65) / 100;
  }
  const coolKwhTotal = hvacKwh * coolPctOfHvac;
  const heatKwhTotal = hvacKwh * (1 - coolPctOfHvac);

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
  const monthlyHvacKw = coolDist.map((d) => hvacKw * (d / Math.max(...coolDist)));

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
    coolKwhTotal,
    heatKwhTotal,
    hvacKwh,
    nonHvacKwh,
    hvacGasT,
    nonHvacGas,
    hvacKw,
    nonHvacKw,
  };
  sset('en_projects', projects);

  // Get buildings for the "Create Savings Measure" building selector (pre-select current building)
  const udBldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : p.buildings || [];
  const _hvlSelBid = _hvlSelBldg[projId] || '';
  const bldgOpts = udBldgs
    .map((b) => `<option value="${b.id}"${b.id === _hvlSelBid ? ' selected' : ''}>${b.name || 'Building'}</option>`)
    .join('');

  const wrap = document.getElementById(`hvl-results-${projId}`);
  if (!wrap) return;
  wrap.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-hdr"><span class="card-title">📊 Load Breakdown Results</span></div>
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
                  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Peak kW (Demand)</div>
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
                    <tr style="background:rgba(59,130,246,0.05)"><td style="font-weight:600">HVAC Peak kW</td>${monthlyHvacKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(hvacKw)}</td></tr>
                    <tr><td style="font-weight:600;color:var(--teal)">Non-HVAC Peak kW</td>${monthlyHvacKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px">${fmt(estimatedTotalKw - v)}</td>`).join('')}<td style="text-align:right;font-weight:700;font-family:var(--mono)">${fmt(nonHvacKw)}</td></tr>
                    <tr style="border-top:2px solid var(--border2)"><td style="font-weight:800">Total Peak kW</td>${monthlyHvacKw.map((v) => `<td style="text-align:right;font-family:var(--mono);font-size:11px;font-weight:700">${fmt(estimatedTotalKw)}</td>`).join('')}<td style="text-align:right;font-weight:800;font-family:var(--mono);color:var(--em)">${fmt(estimatedTotalKw)}</td></tr>
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
          <div class="card">
            <div class="card-hdr"><span class="card-title">💡 Create Savings Measure from HVAC Load</span></div>
            <div style="padding:16px">
              <div style="font-size:12px;color:var(--text2);margin-bottom:14px">Use the HVAC load breakdown above to create a savings measure. Enter the expected % reduction for each component — the monthly kWh, kW, and gas savings will be auto-calculated and added to the Energy Savings matrix.</div>
              <div class="f2" style="gap:12px">
                <div class="fg"><label class="fl">Building</label>
                  <select class="fs" id="hvl-msr-bldg-${projId}">${bldgOpts || '<option value="">No buildings — add via Utility Data tab</option>'}</select>
                </div>
                <div class="fg"><label class="fl">Measure Description</label>
                  <input class="fi" id="hvl-msr-desc-${projId}" value="BAS Optimization" placeholder="e.g. BAS Optimization, Schedule Change, Setpoint Adjustment">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:12px">
                <div class="card" style="background:var(--s1);padding:12px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:8px">❄️ Cooling kWh Reduction</div>
                  <div class="fg" style="margin:0"><label class="fl">% Savings</label><input class="fi" id="hvl-msr-coolPct-${projId}" type="number" value="15" min="0" max="100" step="1"></div>
                  <div style="font-size:11px;color:var(--text2);margin-top:6px">= <strong style="color:var(--em)">${fmt(coolKwhTotal * 0.15)}</strong> kWh/yr saved</div>
                </div>
                <div class="card" style="background:var(--s1);padding:12px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:8px">🔥 Heating kWh Reduction</div>
                  <div class="fg" style="margin:0"><label class="fl">% Savings</label><input class="fi" id="hvl-msr-heatPct-${projId}" type="number" value="10" min="0" max="100" step="1"></div>
                  <div style="font-size:11px;color:var(--text2);margin-top:6px">= <strong style="color:var(--em)">${fmt(heatKwhTotal * 0.1)}</strong> kWh/yr saved</div>
                </div>
                <div class="card" style="background:var(--s1);padding:12px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:8px">⚡ Peak kW Reduction</div>
                  <div class="fg" style="margin:0"><label class="fl">% Savings</label><input class="fi" id="hvl-msr-kwPct-${projId}" type="number" value="10" min="0" max="100" step="1"></div>
                  <div style="font-size:11px;color:var(--text2);margin-top:6px">= <strong style="color:var(--em)">${fmt(hvacKw * 0.1)}</strong> kW saved</div>
                </div>
                <div class="card" style="background:var(--s1);padding:12px">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:8px">🔥 Gas Therms Reduction</div>
                  <div class="fg" style="margin:0"><label class="fl">% Savings</label><input class="fi" id="hvl-msr-gasPct-${projId}" type="number" value="${hvacGasT > 0 ? '10' : '0'}" min="0" max="100" step="1"></div>
                  <div style="font-size:11px;color:var(--text2);margin-top:6px">= <strong style="color:var(--em)">${fmt(hvacGasT * 0.1)}</strong> therms/yr saved</div>
                </div>
              </div>
              <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-em" onclick="hvacLoadCreateMeasure(${projId})">+ Create Savings Measure</button>
              </div>
            </div>
          </div>`;
}

function hvacLoadSave(projId) {
  hvacLoadCalc(projId);
  showToast('HVAC load estimate saved to project ✓');
}

function hvacLoadCreateMeasure(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p || !p.hvacLoadEst) {
    showToast('Run the HVAC load calculation first');
    return;
  }
  const est = p.hvacLoadEst;
  const bldgId = document.getElementById(`hvl-msr-bldg-${projId}`)?.value || '';
  const desc = document.getElementById(`hvl-msr-desc-${projId}`)?.value || 'HVAC Savings';
  const coolPct = (parseFloat(document.getElementById(`hvl-msr-coolPct-${projId}`)?.value) || 0) / 100;
  const heatPct = (parseFloat(document.getElementById(`hvl-msr-heatPct-${projId}`)?.value) || 0) / 100;
  const kwPct = (parseFloat(document.getElementById(`hvl-msr-kwPct-${projId}`)?.value) || 0) / 100;
  const gasPct = (parseFloat(document.getElementById(`hvl-msr-gasPct-${projId}`)?.value) || 0) / 100;

  if (coolPct === 0 && heatPct === 0 && kwPct === 0 && gasPct === 0) {
    showToast('Enter at least one savings percentage');
    return;
  }

  // Build monthly arrays from the HVAC load monthly breakdowns
  const kwhSavings = est.monthlyCoolKwh.map((cool, i) => {
    const coolSav = cool * coolPct;
    const heatSav = (est.monthlyHeatKwh[i] || 0) * heatPct;
    return Math.round(coolSav + heatSav);
  });
  const kwSavings = (est.monthlyHvacKw || []).map((kw) => Math.round(kw * kwPct * 10) / 10);
  const gasSavings = (est.monthlyHvacGas || []).map((g) => Math.round(g * gasPct));

  // Ensure arrays are 12 elements
  while (kwhSavings.length < 12) kwhSavings.push(0);
  while (kwSavings.length < 12) kwSavings.push(0);
  while (gasSavings.length < 12) gasSavings.push(0);

  // Add to the project's savings data using the existing structure
  const sd = getProjSavingsData(projId);
  const _bldgForSqft = bldgId ? getUDBldg(projId, bldgId) : null;
  sd.measures.push({
    id: 'm' + Date.now(),
    selected: true,
    msrNum: sd.measures.length + 1 + '',
    bldgId: bldgId,
    sqft: _bldgForSqft ? parseFloat(_bldgForSqft.sqft) || 0 : 0,
    rates: bldgId
      ? calcBldgDefaultRates(projId, bldgId)
      : { kwhSummer: 0, kwhWinter: 0, kwSummer: 0, kwWinter: 0, thermRate: 0 },
    desc: desc,
    kwh: kwhSavings,
    kw: kwSavings,
    gas: gasSavings,
    totalDollar: 0, // will be recalculated by calcProjSavingsMatrix
    source: 'hvacLoad', // track where this measure came from
  });
  sset('en_projects', projects);

  // Summary for toast
  const totalKwhSav = kwhSavings.reduce((a, b) => a + b, 0);
  const totalGasSav = gasSavings.reduce((a, b) => a + b, 0);
  const parts = [];
  if (totalKwhSav > 0) parts.push(Math.round(totalKwhSav).toLocaleString() + ' kWh');
  if (totalGasSav > 0) parts.push(Math.round(totalGasSav).toLocaleString() + ' therms');

  showToast(`Measure "${desc}" added: ${parts.join(' + ')} annual savings`);

  // Recalculate the $ savings so the measure shows a real total instead of $0
  _svRecalcFrom(projId);

  // Navigate to savings tab and refresh
  const btn = document.querySelector('.pdt[data-tab="savings"]');
  if (btn) sPTab('savings', btn);
}

/* ══════════════════════════════════════════════════════
         CALC TEMPLATES MODAL
      ══════════════════════════════════════════════════════ */
const CALC_TEMPLATES = [
  {
    id: 'solar',
    name: 'Solar',
    icon: '☀️',
    desc: 'PV array savings with configurable rate schedules, net metering, and Helioscope data',
    status: 'ready',
  },
  {
    id: 'bas',
    name: 'BAS',
    icon: '🏢',
    desc: 'Building Automation savings using weather bin data, setpoints, and schedules. Upload temp/humidity CSV for your city.',
    status: 'ready',
  },
  {
    id: 'oa',
    name: 'Outside Air',
    icon: '🌬️',
    desc: 'OA economizer and ventilation optimization savings',
    status: 'coming',
  },
  {
    id: 'lighting',
    name: 'Lighting',
    icon: '💡',
    desc: 'LED retrofit savings with wattage reduction and controls',
    status: 'coming',
  },
  {
    id: 'weatherization',
    name: 'Weatherization',
    icon: '🏠',
    desc: 'Envelope improvements — insulation, windows, air sealing',
    status: 'coming',
  },
  {
    id: 'thermal',
    name: 'Thermal Storage',
    icon: '❄️',
    desc: 'Ice/chilled water storage for demand shifting',
    status: 'coming',
  },
  {
    id: 'battery',
    name: 'Battery Storage',
    icon: '🔋',
    desc: 'Battery energy storage system sizing and demand reduction',
    status: 'coming',
  },
  {
    id: 'rtu',
    name: 'RTU Replacement',
    icon: '🔄',
    desc: 'Rooftop unit replacement — efficiency upgrade savings',
    status: 'coming',
  },
  {
    id: 'peakdemand',
    name: 'Peak Load Demand',
    icon: '⚡',
    desc: 'Demand response and peak load reduction strategies',
    status: 'coming',
  },
];

let _calcTemplateContext = null; // {projId, returnTo:'sv'|'ptab', targetMeasureId:null}

/* Open calc templates targeted at a specific measure row */
function openCalcForMeasure(projId, msrId, returnTo) {
  openCalcTemplates(projId, returnTo || 'sv', msrId);
}

function openCalcTemplates(projId, returnTo, targetMeasureId) {
  _calcTemplateContext = { projId, returnTo: returnTo || 'sv', targetMeasureId: targetMeasureId || null };
  const wrap =
    _calcTemplateContext.returnTo === 'ptab'
      ? document.getElementById('ptab-savings')
      : document.getElementById('svDetailWrap');
  if (!wrap) return;
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
              ${CALC_TEMPLATES.map(
                (t) => `
                <button class="card" style="background:var(--s1);padding:18px;border:1px solid var(--border);cursor:${t.status === 'ready' ? 'pointer' : 'default'};text-align:left;transition:all .15s;opacity:${t.status === 'ready' ? '1' : '0.5'}" ${t.status === 'ready' ? `onclick="launchCalcTemplate('${t.id}',${projId})"` : ''}
                  onmouseenter="if('${t.status}'==='ready')this.style.borderColor='var(--accent)'"
                  onmouseleave="this.style.borderColor='var(--border)'">
                  <div style="font-size:28px;margin-bottom:8px">${t.icon}</div>
                  <div style="font-size:14px;font-weight:700;margin-bottom:5px">${t.name}</div>
                  <div style="font-size:12px;color:var(--text2);line-height:1.6">${t.desc}</div>
                  ${t.status === 'coming' ? '<div style="font-size:10px;color:var(--amber);margin-top:8px;font-weight:600">Coming Soon</div>' : '<div style="font-size:10px;color:var(--em);margin-top:8px;font-weight:600">✓ Available</div>'}
                </button>`,
              ).join('')}
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
  } else {
    showToast(`${templateId.toUpperCase()} calculator coming soon`);
  }
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
  // Recalc dollar savings using baseline rates
  const rates = sd.blRates[m.bldgId] || {};
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
const BAS_VRF_COP = [
  [-2.5, 0.8],
  [2.5, 0.8],
  [7.5, 0.8],
  [12.5, 0.8],
  [17.5, 0.8],
  [22.5, 0.8],
  [27.5, 0.8],
  [32.5, 0.8],
  [37.5, 1.34],
  [42.5, 3.5],
  [47.5, 3.5],
];
const BAS_TEMP_BINS = [
  82.5, 77.5, 72.5, 67.5, 62.5, 57.5, 52.5, 47.5, 42.5, 37.5, 32.5, 27.5, 22.5, 17.5, 12.5, 7.5, 2.5, -2.5, -7.5,
];
const BAS_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BAS_MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

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

/* ── B. Weather Data — 17 cities, compact climate normals ── */
const BAS_CITIES = [
  {
    id: 1,
    name: 'Pittsburgh, PA',
    mean: [27, 30, 39, 50, 60, 69, 73, 71, 64, 52, 42, 32],
    diur: [16, 17, 19, 21, 21, 20, 19, 19, 19, 19, 16, 15],
    std: [10, 10, 11, 11, 10, 8, 7, 7, 9, 10, 10, 10],
  },
  {
    id: 2,
    name: 'Wichita, KS',
    mean: [31, 36, 46, 56, 66, 76, 81, 80, 71, 58, 45, 33],
    diur: [20, 21, 22, 23, 21, 22, 23, 23, 23, 23, 20, 19],
    std: [12, 12, 13, 12, 10, 9, 8, 8, 11, 12, 12, 12],
  },
  {
    id: 3,
    name: 'Philadelphia, PA',
    mean: [32, 34, 43, 53, 63, 73, 78, 76, 68, 57, 46, 36],
    diur: [16, 17, 18, 19, 19, 19, 18, 18, 18, 18, 16, 15],
    std: [10, 10, 11, 10, 9, 8, 7, 7, 8, 9, 10, 10],
  },
  {
    id: 4,
    name: 'Kansas City, MO',
    mean: [28, 33, 44, 55, 65, 75, 80, 78, 69, 57, 44, 32],
    diur: [18, 19, 21, 22, 21, 21, 21, 22, 22, 21, 18, 17],
    std: [12, 12, 13, 12, 10, 9, 8, 8, 11, 12, 12, 12],
  },
  {
    id: 5,
    name: 'Baltimore, MD',
    mean: [33, 36, 44, 54, 64, 73, 78, 76, 69, 57, 47, 37],
    diur: [16, 17, 18, 19, 19, 19, 18, 18, 18, 18, 16, 15],
    std: [10, 10, 10, 10, 9, 8, 7, 7, 8, 9, 10, 10],
  },
  {
    id: 6,
    name: 'Boulder, CO',
    mean: [34, 36, 42, 49, 58, 68, 74, 72, 63, 52, 41, 33],
    diur: [24, 24, 26, 27, 26, 27, 27, 27, 27, 26, 23, 23],
    std: [12, 12, 13, 12, 11, 10, 9, 9, 11, 12, 12, 12],
  },
  {
    id: 7,
    name: 'Cheyenne, WY',
    mean: [27, 29, 35, 42, 51, 61, 68, 66, 56, 45, 34, 27],
    diur: [22, 22, 22, 22, 22, 24, 25, 25, 24, 22, 20, 20],
    std: [12, 12, 13, 12, 11, 10, 9, 9, 11, 12, 12, 12],
  },
  {
    id: 8,
    name: 'Phoenix, AZ',
    mean: [55, 58, 63, 71, 80, 90, 95, 93, 87, 75, 63, 54],
    diur: [21, 23, 25, 27, 29, 31, 27, 26, 27, 26, 23, 21],
    std: [8, 8, 9, 9, 8, 7, 6, 6, 7, 8, 8, 8],
  },
  {
    id: 9,
    name: 'Brownsville, TX',
    mean: [61, 64, 70, 76, 81, 85, 86, 87, 84, 78, 70, 63],
    diur: [16, 16, 17, 16, 14, 14, 15, 15, 14, 16, 16, 15],
    std: [8, 8, 8, 7, 5, 4, 4, 4, 5, 7, 8, 8],
  },
  {
    id: 10,
    name: 'Belmar, NJ',
    mean: [32, 33, 40, 50, 59, 69, 75, 74, 67, 56, 46, 36],
    diur: [15, 16, 17, 17, 17, 17, 17, 17, 17, 17, 15, 14],
    std: [9, 9, 10, 9, 8, 7, 6, 6, 8, 9, 9, 9],
  },
  {
    id: 11,
    name: 'Chicago, IL',
    mean: [24, 28, 38, 49, 60, 70, 75, 73, 66, 53, 41, 28],
    diur: [15, 16, 18, 19, 20, 20, 19, 19, 19, 18, 15, 14],
    std: [12, 11, 12, 11, 10, 9, 8, 8, 10, 11, 11, 11],
  },
  {
    id: 12,
    name: 'New York, NY',
    mean: [33, 35, 43, 53, 63, 72, 77, 76, 68, 57, 47, 37],
    diur: [14, 15, 16, 17, 17, 17, 16, 16, 16, 16, 14, 13],
    std: [9, 9, 10, 9, 8, 7, 6, 6, 8, 9, 9, 9],
  },
  {
    id: 13,
    name: 'Columbia, MO',
    mean: [29, 34, 44, 55, 65, 74, 79, 77, 69, 57, 44, 33],
    diur: [18, 19, 21, 22, 21, 21, 21, 22, 22, 21, 18, 17],
    std: [11, 11, 12, 11, 10, 9, 8, 8, 10, 11, 11, 11],
  },
  {
    id: 14,
    name: 'Minneapolis, MN',
    mean: [14, 20, 33, 47, 59, 69, 74, 71, 62, 49, 33, 19],
    diur: [17, 18, 20, 22, 22, 22, 21, 21, 21, 20, 16, 15],
    std: [14, 13, 13, 12, 11, 10, 8, 8, 10, 11, 12, 13],
  },
  {
    id: 15,
    name: 'Dallas, TX',
    mean: [45, 49, 57, 65, 74, 82, 86, 86, 79, 67, 56, 46],
    diur: [19, 19, 20, 20, 18, 18, 19, 20, 19, 19, 18, 18],
    std: [11, 11, 11, 10, 8, 7, 6, 6, 8, 10, 11, 11],
  },
  {
    id: 16,
    name: 'St Louis, MO',
    mean: [30, 35, 45, 56, 66, 75, 80, 78, 70, 58, 45, 34],
    diur: [17, 18, 20, 21, 20, 20, 20, 21, 21, 20, 17, 16],
    std: [11, 11, 12, 11, 10, 9, 8, 8, 10, 11, 11, 11],
  },
  {
    id: 17,
    name: 'City, ST (template)',
    mean: [40, 42, 48, 55, 63, 72, 77, 75, 68, 57, 47, 41],
    diur: [18, 18, 20, 20, 20, 20, 20, 20, 20, 20, 18, 18],
    std: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  },
];

let _basWeatherCache = {};
function _basGenerateTMY(cityIdx) {
  if (_basWeatherCache[cityIdx]) return _basWeatherCache[cityIdx];
  const c = BAS_CITIES.find((x) => x.id === cityIdx);
  if (!c) return null;
  let seed = cityIdx * 7919;
  function rng() {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  }
  function gaussRng() {
    let u = 0,
      v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const hb = [];
  for (let m = 0; m < 12; m++) {
    hb[m] = [];
    for (let b = 0; b < BAS_TEMP_BINS.length; b++) hb[m][b] = new Array(24).fill(0);
    const days = BAS_MONTH_DAYS[m];
    const meanT = c.mean[m];
    const diur = c.diur[m];
    const sd = c.std[m];
    for (let d = 0; d < days; d++) {
      const dayOffset = gaussRng() * sd * 0.3;
      for (let h = 0; h < 24; h++) {
        const diurnalFrac = Math.sin(((h - 6) * Math.PI) / 12);
        const temp = meanT + dayOffset + (diur / 2) * diurnalFrac + gaussRng() * sd * 0.35;
        let bi = BAS_TEMP_BINS.length - 1;
        for (let b = 0; b < BAS_TEMP_BINS.length; b++) {
          if (temp >= BAS_TEMP_BINS[b] - 2.5) {
            bi = b;
            break;
          }
        }
        hb[m][bi][h]++;
      }
    }
  }
  _basWeatherCache[cityIdx] = { hourlyBins: hb, cityName: c.name };
  return _basWeatherCache[cityIdx];
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
  const sqft = bc.sqft || p?.sqft || 0;
  const cityOpts = BAS_CITIES.map(
    (c) => `<option value="${c.id}" ${(bc.city || 4) === c.id ? 'selected' : ''}>${c.name}</option>`,
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
            <h2 style="font-size:18px;font-weight:700;margin:0">🏢 BAS Savings Calc</h2>
            <div style="flex:1"></div>
            <button class="btn btn-ghost btn-sm" onclick="bcSaveInputs(${projId})">💾 Save</button>
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
            <div class="card" style="padding:14px;text-align:center;background:var(--s1)">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Evergy Rebate</div>
              <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--green);margin-top:4px" id="bc-kpi-rebate">—</div>
            </div>
          </div>

          <!-- A — BUILDING & EQUIPMENT -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">A — Building &amp; Equipment</span></div>
            <div style="padding:14px">
              <div class="f3">
                <div class="fg"><label class="fl">Building SqFt</label><input class="fi bc-inp" id="bc-sqft" type="number" value="${sqft}" placeholder="e.g. 50000"></div>
                <div class="fg"><label class="fl">Heating Source</label><select class="fs bc-inp" id="bc-heatSrc">
                  <option value="1" ${(bc.heatSrc || 2) == 1 ? 'selected' : ''}>1 — Gas (MCF)</option>
                  <option value="2" ${(bc.heatSrc || 2) == 2 ? 'selected' : ''}>2 — Electric (kWh)</option>
                  <option value="3" ${(bc.heatSrc || 2) == 3 ? 'selected' : ''}>3 — Gas (Therms)</option>
                  <option value="4" ${(bc.heatSrc || 2) == 4 ? 'selected' : ''}>4 — Both (Electric + Gas)</option>
                </select></div>
                <div class="fg"><label class="fl">% of VRF kWh</label><input class="fi bc-inp" id="bc-vrfPct" type="number" value="${bc.vrfPct || 0}" min="0" max="100" step="1"></div>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr) repeat(3,auto);gap:10px;margin-top:8px;align-items:end">
                <div class="fg"><label class="fl">Cooling Eff (kW/Ton)</label><input class="fi bc-inp" id="bc-coolEff" type="number" step="0.01" value="${bc.coolEff || 0.86}"></div>
                <div class="fg"><label class="fl">Gas AFUE</label><input class="fi bc-inp" id="bc-afue" type="number" step="0.01" value="${bc.afue || 0.8}"></div>
                <div class="fg"><label class="fl">Electric COP</label><input class="fi bc-inp" id="bc-elecCOP" type="number" step="0.1" value="${bc.elecCOP || 1.0}"></div>
                <div class="fg"><label class="fl">Humidity SP (lb/lb)</label><input class="fi bc-inp" id="bc-humRatioSP" type="number" step="0.0001" value="${bc.humRatioSP || 0.0082}"></div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Max Tons</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--em2)" id="bc-dispTons">—</div>
                </div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Max MBtu/h</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--amber)" id="bc-dispMbtu">—</div>
                </div>
                <div style="text-align:center;padding:6px 10px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">OA CFM</div>
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
            <div style="padding:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
              <div style="font-size:12px;color:var(--text2)" id="bc-weatherStatus">${bc.weatherOverride ? 'Using uploaded data (' + bc.weatherOverride.rowsParsed + ' rows)' : 'Using generated TMY data'}</div>
              <label class="btn btn-ghost btn-sm" style="cursor:pointer">
                🌡️ Temp CSV
                <input type="file" accept=".csv,.txt" id="bc-weatherUpload" style="display:none" onchange="_bcHandleCSV(this,${projId})">
              </label>
              <label class="btn btn-ghost btn-sm" style="cursor:pointer">
                💧 Humidity CSV
                <input type="file" accept=".csv,.txt" id="bc-humidityUpload" style="display:none" onchange="_bcHandleHumidityCSV(this,${projId})">
              </label>
              <div style="font-size:11px;color:var(--text3)" id="bc-humidityStatus">${bc.humidityOverride ? '✓ Humidity loaded (' + bc.humidityOverride.rowsParsed + ' rows)' : ''}</div>
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
                  <div class="fg"><label class="fl">Cool Occ SP (°F)</label><input class="fi bc-inp" id="bc-exCoolOcc" type="number" value="${bc.exCoolOcc ?? 55}"></div>
                  <div class="fg"><label class="fl">Cool Unocc SP (°F)</label><input class="fi bc-inp" id="bc-exCoolUnocc" type="number" value="${bc.exCoolUnocc ?? 70}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Heat Occ SP (°F)</label><input class="fi bc-inp" id="bc-exHeatOcc" type="number" value="${bc.exHeatOcc ?? 70}"></div>
                  <div class="fg"><label class="fl">Heat Unocc SP (°F)</label><input class="fi bc-inp" id="bc-exHeatUnocc" type="number" value="${bc.exHeatUnocc ?? 60}"></div>
                </div>
                <div class="fg"><label class="fl">OA Shut Off When Unoccupied?</label><select class="fs bc-inp" id="bc-exOAShutoff">
                  <option value="no" ${(bc.exOAShutoff || 'no') === 'no' ? 'selected' : ''}>No</option>
                  <option value="yes" ${bc.exOAShutoff === 'yes' ? 'selected' : ''}>Yes</option>
                </select></div>
                <div style="font-size:11px;font-weight:600;color:var(--text2);margin:10px 0 6px;text-transform:uppercase;letter-spacing:1px">Schedule (24hr)</div>
                <div class="f2">
                  <div class="fg"><label class="fl">M-F On</label><input class="fi bc-inp" id="bc-exMfOn" type="number" min="0" max="24" value="${bc.exMfOn ?? 0}"></div>
                  <div class="fg"><label class="fl">M-F Off</label><input class="fi bc-inp" id="bc-exMfOff" type="number" min="0" max="24" value="${bc.exMfOff ?? 24}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sat On</label><input class="fi bc-inp" id="bc-exSatOn" type="number" min="0" max="24" value="${bc.exSatOn ?? 0}"></div>
                  <div class="fg"><label class="fl">Sat Off</label><input class="fi bc-inp" id="bc-exSatOff" type="number" min="0" max="24" value="${bc.exSatOff ?? 24}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sun On</label><input class="fi bc-inp" id="bc-exSunOn" type="number" min="0" max="24" value="${bc.exSunOn ?? 0}"></div>
                  <div class="fg"><label class="fl">Sun Off</label><input class="fi bc-inp" id="bc-exSunOff" type="number" min="0" max="24" value="${bc.exSunOff ?? 24}"></div>
                </div>
              </div>
            </div>
            <!-- NEW -->
            <div class="card">
              <div class="card-hdr"><span class="card-title" style="color:var(--em)">New (Proposed) Conditions</span></div>
              <div style="padding:14px">
                <div class="f2">
                  <div class="fg"><label class="fl">Cool Occ SP (°F)</label><input class="fi bc-inp" id="bc-newCoolOcc" type="number" value="${bc.newCoolOcc ?? 50}"></div>
                  <div class="fg"><label class="fl">Cool Unocc SP (°F)</label><input class="fi bc-inp" id="bc-newCoolUnocc" type="number" value="${bc.newCoolUnocc ?? 85}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Heat Occ SP (°F)</label><input class="fi bc-inp" id="bc-newHeatOcc" type="number" value="${bc.newHeatOcc ?? 60}"></div>
                  <div class="fg"><label class="fl">Heat Unocc SP (°F)</label><input class="fi bc-inp" id="bc-newHeatUnocc" type="number" value="${bc.newHeatUnocc ?? 55}"></div>
                </div>
                <div class="fg"><label class="fl">OA Shut Off When Unoccupied?</label><select class="fs bc-inp" id="bc-newOAShutoff">
                  <option value="no" ${(bc.newOAShutoff || 'yes') === 'no' ? 'selected' : ''}>No</option>
                  <option value="yes" ${(bc.newOAShutoff || 'yes') === 'yes' ? 'selected' : ''}>Yes</option>
                </select></div>
                <div style="font-size:11px;font-weight:600;color:var(--text2);margin:10px 0 6px;text-transform:uppercase;letter-spacing:1px">Schedule (24hr)</div>
                <div class="f2">
                  <div class="fg"><label class="fl">M-F On</label><input class="fi bc-inp" id="bc-newMfOn" type="number" min="0" max="24" value="${bc.newMfOn ?? 5}"></div>
                  <div class="fg"><label class="fl">M-F Off</label><input class="fi bc-inp" id="bc-newMfOff" type="number" min="0" max="24" value="${bc.newMfOff ?? 21}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sat On</label><input class="fi bc-inp" id="bc-newSatOn" type="number" min="0" max="24" value="${bc.newSatOn ?? 6}"></div>
                  <div class="fg"><label class="fl">Sat Off</label><input class="fi bc-inp" id="bc-newSatOff" type="number" min="0" max="24" value="${bc.newSatOff ?? 19}"></div>
                </div>
                <div class="f2">
                  <div class="fg"><label class="fl">Sun On</label><input class="fi bc-inp" id="bc-newSunOn" type="number" min="0" max="24" value="${bc.newSunOn ?? 6}"></div>
                  <div class="fg"><label class="fl">Sun Off</label><input class="fi bc-inp" id="bc-newSunOff" type="number" min="0" max="24" value="${bc.newSunOff ?? 19}"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- D — CALIBRATION -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">D — Calibration (Match to Utility Analysis)</span></div>
            <div style="padding:14px">
              <div style="font-size:11px;color:var(--text2);margin-bottom:10px">Enter actual annual energy from utility analysis. Leave blank to skip calibration (factor = 1.0).</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;align-items:end">
                <div class="fg"><label class="fl">Existing Cooling kWh (from UA)</label><input class="fi bc-inp" id="bc-calCoolKwh" type="number" value="${bc.calCoolKwh || ''}"></div>
                <div class="fg"><label class="fl">Existing Heating kWh (from UA)</label><input class="fi bc-inp" id="bc-calHeatKwh" type="number" value="${bc.calHeatKwh || ''}"></div>
                <div style="text-align:center;padding:8px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Cool Adj Factor</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--em2)" id="bc-adjCool">1.000</div>
                </div>
                <div style="text-align:center;padding:8px;background:var(--s3);border-radius:7px;border:1px solid var(--border)">
                  <div style="font-size:9px;color:var(--text3);text-transform:uppercase">Heat Adj Factor</div>
                  <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--amber)" id="bc-adjHeat">1.000</div>
                </div>
              </div>
            </div>
          </div>

          <!-- E — PEAK DEMAND -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><span class="card-title">E — Peak Demand Hours</span></div>
            <div style="padding:14px">
              <div class="f2" style="max-width:400px">
                <div class="fg"><label class="fl">Peak Start (24hr)</label><input class="fi bc-inp" id="bc-peakStart" type="number" min="0" max="23" value="${bc.peakStart ?? 16}"></div>
                <div class="fg"><label class="fl">Peak End (24hr)</label><input class="fi bc-inp" id="bc-peakEnd" type="number" min="1" max="24" value="${bc.peakEnd ?? 18}"></div>
              </div>
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

  // Attach live-calc listeners
  wrap.querySelectorAll('.bc-inp').forEach((inp) => {
    inp.addEventListener('input', () => _bcLiveCalc(projId));
    inp.addEventListener('change', () => _bcLiveCalc(projId));
  });
  _bcLiveCalc(projId);
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
  const peakStart = _bcGv('bc-peakStart');
  const peakEnd = _bcGv('bc-peakEnd');
  const humRatioSP = _bcGv('bc-humRatioSP') || 0.0082;
  const humBins = p.basCalc?.humidityOverride?.hourlyBins || null;

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

  const weather = p.basCalc?.weatherOverride || _basGenerateTMY(cityIdx);
  if (!weather) {
    _bcRenderEmpty();
    return;
  }
  const hb = weather.hourlyBins;

  function isOcc(h, on, off) {
    if (on === off) return false;
    return on < off ? h >= on && h < off : h >= on || h < off;
  }

  const exCoolM = new Array(12).fill(0),
    exHeatKwhM = new Array(12).fill(0),
    exHeatGasM = new Array(12).fill(0);
  const newCoolM = new Array(12).fill(0),
    newHeatKwhM = new Array(12).fill(0),
    newHeatGasM = new Array(12).fill(0);
  const exPeakCoolM = new Array(12).fill(0),
    newPeakCoolM = new Array(12).fill(0);

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

        // Existing cooling: ton-hours → kWh
        const exCoolTH = hrs * (exOccCoolTons * exOccW + exUnoccCoolTons * exUnoccW);
        const exCoolKwh_h = exCoolTH * coolEff;
        const exOAShut = exOAShutoff && exUnoccW > 0;
        const exOACoolKwh_h = hrs * (exOACoolMbtu / 12) * coolEff * (exOAShut ? exOccW : 1);
        let exLatentKwh_h = 0;
        if (humBins && humBins[m] && humBins[m][bi]) {
          const humRatio = humBins[m][bi][h] || 0;
          if (humRatio > humRatioSP) {
            const latentMbtu = (0.68 * oaCfm * (humRatio - humRatioSP)) / 1000;
            exLatentKwh_h = hrs * (latentMbtu / 12) * coolEff * (exOAShut ? exOccW : 1);
          }
        }
        exCoolM[m] += exCoolKwh_h + exOACoolKwh_h + exLatentKwh_h;

        // Existing heating
        const exHeatMbtu_h = hrs * (exOccHeatMbtu * exOccW + exUnoccHeatMbtu * exUnoccW);
        const exOAHeatMbtu_h = hrs * exOAHeatMbtu * (exOAShut ? exOccW : 1);
        const exTotalHeatMbtu = exHeatMbtu_h + exOAHeatMbtu_h;
        if (heatSrc === 1) {
          exHeatGasM[m] += exTotalHeatMbtu * 0.001;
        } else if (heatSrc === 2) {
          exHeatKwhM[m] += exTotalHeatMbtu * 0.293;
        } else if (heatSrc === 3) {
          exHeatGasM[m] += exTotalHeatMbtu * 0.01;
        } else {
          exHeatKwhM[m] += exTotalHeatMbtu * 0.293;
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
          const humRatio = humBins[m][bi][h] || 0;
          if (humRatio > humRatioSP) {
            const latentMbtu = (0.68 * oaCfm * (humRatio - humRatioSP)) / 1000;
            newLatentKwh_h = hrs * (latentMbtu / 12) * coolEff * (newOAShut ? newOccW : 1);
          }
        }
        newCoolM[m] += newCoolKwh_h + newOACoolKwh_h + newLatentKwh_h;

        // New heating
        const newHeatMbtu_h = hrs * (newOccHeatMbtu * newOccW + newUnoccHeatMbtu * newUnoccW);
        const newOAHeatMbtu_h = hrs * newOAHeatMbtu * (newOAShut ? newOccW : 1);
        const newTotalHeatMbtu = newHeatMbtu_h + newOAHeatMbtu_h;
        if (heatSrc === 1) {
          newHeatGasM[m] += newTotalHeatMbtu * 0.001;
        } else if (heatSrc === 2) {
          newHeatKwhM[m] += newTotalHeatMbtu * 0.293;
        } else if (heatSrc === 3) {
          newHeatGasM[m] += newTotalHeatMbtu * 0.01;
        } else {
          newHeatKwhM[m] += newTotalHeatMbtu * 0.293;
        }

        // Peak tracking
        const isPeak = h >= peakStart && h < peakEnd;
        if (isPeak) {
          exPeakCoolM[m] += exCoolKwh_h + exOACoolKwh_h + exLatentKwh_h;
          newPeakCoolM[m] += newCoolKwh_h + newOACoolKwh_h + newLatentKwh_h;
        }
      }
    }
  }

  // Calibration factors
  const rawExCoolTotal = exCoolM.reduce((a, b) => a + b, 0);
  const rawExHeatTotal = exHeatKwhM.reduce((a, b) => a + b, 0);
  let coolAdj = 1,
    heatAdj = 1;
  if (calCoolKwh > 0 && rawExCoolTotal > 0) coolAdj = calCoolKwh / rawExCoolTotal;
  if (calHeatKwh > 0 && rawExHeatTotal > 0) heatAdj = calHeatKwh / rawExHeatTotal;
  if (el('bc-adjCool')) el('bc-adjCool').textContent = coolAdj.toFixed(3);
  if (el('bc-adjHeat')) el('bc-adjHeat').textContent = heatAdj.toFixed(3);

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
  const gasLabel = heatSrc === 1 ? 'MCF' : heatSrc === 3 ? 'Therms' : 'Therms';

  for (let m = 0; m < 12; m++) {
    const cs = (exCoolM[m] - newCoolM[m]) * coolAdj;
    const hs = (exHeatKwhM[m] - newHeatKwhM[m]) * heatAdj;
    const gs = (exHeatGasM[m] - newHeatGasM[m]) * heatAdj;
    coolSavM[m] = cs;
    heatKwhSavM[m] = hs;
    heatGasSavM[m] = gs;
    totalKwhSavM[m] = cs + hs;
    const pkSav = (exPeakCoolM[m] - newPeakCoolM[m]) * coolAdj;
    peakKwhSavM[m] = pkSav;
    nonPeakKwhSavM[m] = cs - pkSav + hs;
    annCoolSav += cs;
    annHeatKwhSav += hs;
    annHeatGasSav += gs;
    annTotalKwh += cs + hs;
    annPeak += pkSav;
    annNonPeak += cs - pkSav + hs;
  }

  // Evergy rebate
  const rebatePeak = Math.max(0, annPeak) * 0.1;
  const rebateNonPeak = Math.max(0, annNonPeak) * 0.04;
  const totalRebate = rebatePeak + rebateNonPeak;

  // Update KPIs
  const fmt = (n) => (n ? Math.round(n).toLocaleString() : '0');
  const fmtD = (n) => (n ? '$' + Math.round(n).toLocaleString() : '$0');
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
  let html = `<table class="dtbl" style="font-size:11px;border-collapse:collapse;width:100%">
          <thead><tr>
            <th style="text-align:left;padding:5px 8px;font-size:10px">Month</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Exist Cool kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">New Cool kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--em2)">Cool Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Heat kWh Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Heat ${gasLabel} Saved</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--em);font-weight:700">Total kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px;color:var(--amber)">Peak kWh</th>
            <th style="text-align:right;padding:5px 6px;font-size:10px">Non-Peak kWh</th>
          </tr></thead><tbody>`;
  for (let m = 0; m < 12; m++) {
    const bg = m % 2 ? 'background:rgba(255,255,255,0.015)' : '';
    html += `<tr style="${bg}">
            <td style="font-weight:600;padding:4px 8px">${BAS_MO[m]}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--text2)">${fmt(exCoolM[m] * coolAdj)}</td>
            <td style="text-align:right;padding:4px 6px;font-family:var(--mono);font-size:10px;color:var(--text2)">${fmt(newCoolM[m] * coolAdj)}</td>
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
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--text2)">${fmt(exCoolM.reduce((a, b) => a + b, 0) * coolAdj)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--text2)">${fmt(newCoolM.reduce((a, b) => a + b, 0) * coolAdj)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--em2)">${fmt(annCoolSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annHeatKwhSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annHeatGasSav)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--em)">${fmt(annTotalKwh)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px;color:var(--amber)">${fmt(annPeak)}</td>
          <td style="text-align:right;padding:6px;font-family:var(--mono);font-size:11px">${fmt(annNonPeak)}</td>
        </tr></tbody></table>`;

  // Evergy rebate summary
  html += `<div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <div style="background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--text2)">Peak kWh × $0.10 =</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--amber);margin-left:6px">${fmtD(rebatePeak)}</span>
          </div>
          <div style="background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--text2)">Non-Peak kWh × $0.04 =</span>
            <span style="font-family:var(--mono);font-weight:700;color:var(--text);margin-left:6px">${fmtD(rebateNonPeak)}</span>
          </div>
          <div style="background:var(--em-dim);border:1px solid var(--em);border-radius:8px;padding:10px 16px">
            <span style="font-size:11px;color:var(--em)">Total Evergy Rebate =</span>
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
    exOAShutoff: document.getElementById('bc-exOAShutoff')?.value || 'no',
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
    peakStart: _bcGv('bc-peakStart'),
    peakEnd: _bcGv('bc-peakEnd'),
    humRatioSP: _bcGv('bc-humRatioSP') || 0.0082,
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
    bldgId: bldgs[0]?.id || '',
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
  const rates = sd.blRates[m.bldgId] || {};
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

/* ── G. Weather CSV Upload ── */
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
  showToast('Weather data cleared — using generated TMY');
}
