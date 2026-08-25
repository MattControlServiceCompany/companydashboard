// ══════════════════════════════════════════════════════
//  ENERGY SAVINGS MATRIX — per-project measure table
// ══════════════════════════════════════════════════════
const SUMMER_MOS = [5, 6, 7, 8]; // Jun–Sep (0-indexed)

// FIX(2026-07-02, item 219e6828): Shared address plausibility check.
// Extractors that fall back to a printed "ADDRESS:" stub as a bill's identity
// label (e.g. City of Baldwin, energy-savings.js:7676) have no guarantee that
// OCR produced anything address-like — badly scanned pages can yield pure
// noise ("= == ==", "Ee Eee"), boilerplate footer text that bled onto the
// same OCR line ("FOR AFTER HOURS UTILITY ASSISTANCE CALL [phone number]"), or
// a real address with unstripped date/amount garbage glued on. This function
// is the single source of truth for "does this look like a real address" —
// used both when the value is captured (energy-savings.js) and again when it
// is rendered as a UI label (bill-analysis.js _bldgName) so any future
// extractor gets the same protection without re-deriving the heuristic.
// Deliberately conservative: requires a recognized street-type word (ST, AVE,
// RD, ...) OR (digits + enough distinct letters) to pass. Numbered-street
// addresses like "512 8TH ST" / "421 6TH ST" (very common — e.g. Baldwin's
// grid) must still pass, so a low-distinct-letter-count check is only applied
// when there's NO recognized street word, not universally (a strict "few
// distinct letters" rule would wrongly reject "8TH ST" for having only T/H/S).
function _looksLikeAddress(s) {
  if (!s || typeof s !== 'string') return false;
  const str = s.trim();
  if (str.length < 4) return false;
  // Boilerplate/footer text that OCR glued onto the ADDRESS: line (phone
  // numbers, "call after hours", etc.) — never a real service address.
  if (/\d{3}[-.]?\d{3}[-.]?\d{4}/.test(str)) return false;
  if (/\b(CALL|AFTER HOURS|ASSISTANCE|CUSTOMER SERVICE)\b/i.test(str)) return false;
  // Mostly symbols/whitespace noise ("= == ==", "re cnmEEm    or   |") rather
  // than real text.
  const alnumCount = (str.match(/[A-Za-z0-9]/g) || []).length;
  if (alnumCount / str.length < 0.5) return false;
  const hasDigit = /\d/.test(str);
  const hasStreetWord =
    /\b(ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|BLVD|BOULEVARD|CT|COURT|PL|PLACE|WAY|HWY|HIGHWAY|PKWY|PARKWAY|CIR|CIRCLE|TER|TERRACE|TRL|TRAIL)\b/i.test(
      str,
    );
  if (hasStreetWord) return true; // "512 8TH ST", "614 DEARBORN ST"
  // No recognized street-type word — only accept if it still strongly looks
  // like real alphanumeric text (house number + enough distinct letters),
  // not repeated-character garble like "Ee Eee" or "00 Fm em".
  const letters = str.replace(/[^A-Za-z]/g, '');
  const distinctLetters = new Set(letters.toUpperCase()).size;
  return hasDigit && distinctLetters >= 6 && str.length >= 8;
}

// FIX(2026-07-02, item 219e6828): Generalized trailing-junk stripper for
// ADDRESS: captures. The prior stripper (see energy-savings.js ServiceAddress
// extraction) only cut at a well-formed date (\d{1,2}/\d{1,2}/\d{2,4}), which
// real Baldwin OCR routinely defeats with garbled dates like "as/25/2" (month
// OCR'd as letters) or "4/25/2" (1-digit year). This walks whitespace-split
// tokens, always keeps the first token (house number, even if OCR-garbled —
// dropping it would break legitimate short addresses), and stops at the
// first later token that looks numeric/decimal-ish (a bled-in date or dollar
// amount) or is purely symbolic ("|", "=="), instead of requiring a
// perfectly formed date pattern.
function _stripAddressTrailingJunk(raw) {
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const kept = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    const isNumericish = /\d/.test(tok) && (/[\/.]/.test(tok) || /^\d+$/.test(tok) || tok.length <= 2);
    const isSymbolic = /^[^A-Za-z0-9]+$/.test(tok);
    if (isNumericish || isSymbolic) break;
    kept.push(tok);
  }
  const result = kept.join(' ').trim();
  return result || null;
}

// Set ud-layout height by measuring fixed chrome above it
function _setUDLayoutHeight(viewId) {
  const appWrap = document.querySelector('.app-wrap');
  const layout = document.querySelector('#view-' + viewId + ' .ud-layout');
  if (!appWrap || !layout) return;
  layout.style.height = appWrap.clientHeight + 'px';
}

function getProjSavingsData(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return { measures: [], blRates: {} };
  if (!p.savingsData) p.savingsData = { measures: [], blRates: {} };
  return p.savingsData;
}

function renderProjBaselineRates(projId) {
  const bldgs = getUDBldgs(projId);
  const sd = getProjSavingsData(projId);
  const tbody = document.getElementById('bl-rates-body-' + projId);
  if (!tbody) return;
  if (!bldgs.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text2);padding:18px;font-size:12px">
            No buildings found in Utility Data for this project.<br>
            <span style="font-size:11px;color:var(--text3)">Add buildings and meters in the <strong style="color:var(--accent)">Utility Data</strong> tab, then return here.</span>
          </td></tr>`;
    return;
  }
  tbody.innerHTML = bldgs
    .map((b) => {
      const r = sd.blRates[b.id] || {};
      return `<tr>
            <td style="font-weight:600;font-size:13px;white-space:nowrap">${b.name}</td>
            <td style="border-left:2px solid var(--border2)"><input class="bl-rate-inp" type="number" step="0.0001" placeholder="0.0681" value="${r.kwhSummer || ''}" id="blr-kwhs-${projId}-${b.id}"></td>
            <td><input class="bl-rate-inp" type="number" step="0.0001" placeholder="0.0582" value="${r.kwhWinter || ''}" id="blr-kwhw-${projId}-${b.id}"></td>
            <td style="border-left:2px solid var(--border2)"><input class="bl-rate-inp" type="number" step="0.01" placeholder="16.997" value="${r.kwSummer || ''}" id="blr-kws-${projId}-${b.id}"></td>
            <td><input class="bl-rate-inp" type="number" step="0.01" placeholder="11.797" value="${r.kwWinter || ''}" id="blr-kww-${projId}-${b.id}"></td>
            <td style="border-left:2px solid var(--border2)"><input class="bl-rate-inp" type="number" step="0.001" placeholder="0.798" value="${r.thermRate || ''}" id="blr-therm-${projId}-${b.id}"></td>
          </tr>`;
    })
    .join('');
}

function saveProjBaselineRates(projId) {
  const bldgs = getUDBldgs(projId);
  const sd = getProjSavingsData(projId);
  bldgs.forEach((b) => {
    sd.blRates[b.id] = {
      kwhSummer: parseFloat(document.getElementById('blr-kwhs-' + projId + '-' + b.id)?.value) || 0,
      kwhWinter: parseFloat(document.getElementById('blr-kwhw-' + projId + '-' + b.id)?.value) || 0,
      kwSummer: parseFloat(document.getElementById('blr-kws-' + projId + '-' + b.id)?.value) || 0,
      kwWinter: parseFloat(document.getElementById('blr-kww-' + projId + '-' + b.id)?.value) || 0,
      thermRate: parseFloat(document.getElementById('blr-therm-' + projId + '-' + b.id)?.value) || 0,
    };
  });
  sset('en_projects', projects);
  showToast('Baseline rates saved ✓');
  calcProjSavingsMatrix(projId);
}

function calcBldgDefaultRates(projId, bldgId) {
  const b = getUDBldg(projId, bldgId);
  if (!b) return { kwhSummer: 0, kwhWinter: 0, kwSummer: 0, kwWinter: 0, thermRate: 0 };
  const meters = b.meters || [];
  const elecM = meters.find((m) => m.commodity === 'Electric');
  const gasM = meters.find((m) => m.commodity === 'Gas');
  const SUMMER = [5, 6, 7, 8];
  let sumKwhCost = 0,
    sumKwh = 0,
    winKwhCost = 0,
    winKwh = 0;
  let sumKwCost = 0,
    sumKwCount = 0,
    sumKwDemand = 0,
    winKwCost = 0,
    winKwCount = 0,
    winKwDemand = 0;
  let totalTherms = 0,
    totalGasCost = 0;
  if (elecM)
    (elecM.bills || []).forEach((bill) => {
      const mo = new Date(bill.start).getMonth();
      const kwh = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
      const kw = parseFloat(bill.demandKW) || parseFloat(bill.billedKW) || 0;
      const kwhCost = parseFloat(bill.kwhCost) || 0;
      const kwCost = parseFloat(bill.kwCost) || 0;
      if (SUMMER.includes(mo)) {
        sumKwhCost += kwhCost;
        sumKwh += kwh;
        if (kw > 0) {
          sumKwCost += kwCost;
          sumKwCount++;
          sumKwDemand += kw;
        }
      } else {
        winKwhCost += kwhCost;
        winKwh += kwh;
        if (kw > 0) {
          winKwCost += kwCost;
          winKwCount++;
          winKwDemand += kw;
        }
      }
    });
  if (gasM)
    (gasM.bills || []).forEach((bill) => {
      totalTherms += parseFloat(bill.therms) || parseFloat(bill.usage) || 0;
      totalGasCost += parseFloat(bill.totalCost) || parseFloat(bill.cost) || 0;
    });
  const propaneM = meters.find((m) => m.commodity === 'Propane');
  let totalGallons = 0,
    totalPropaneCost = 0;
  if (propaneM)
    (propaneM.bills || []).forEach((bill) => {
      totalGallons += parseFloat(bill.gallonsDelivered) || parseFloat(bill.usage) || 0;
      totalPropaneCost += parseFloat(bill.totalCost) || parseFloat(bill.cost) || 0;
    });
  return {
    kwhSummer: sumKwh > 0 ? Math.round((sumKwhCost / sumKwh) * 10000) / 10000 : 0,
    kwhWinter: winKwh > 0 ? Math.round((winKwhCost / winKwh) * 10000) / 10000 : 0,
    kwSummer: sumKwDemand > 0 ? Math.round((sumKwCost / sumKwDemand) * 100) / 100 : 0,
    kwWinter: winKwDemand > 0 ? Math.round((winKwCost / winKwDemand) * 100) / 100 : 0,
    thermRate: totalTherms > 0 ? Math.round((totalGasCost / totalTherms) * 1000) / 1000 : 0,
    gallonRate: totalGallons > 0 ? Math.round((totalPropaneCost / totalGallons) * 1000) / 1000 : 0,
  };
}

// getBldgMeasureSavingsByMo → computations/savings.js

function addSavingsMeasure(projId) {
  const sd = getProjSavingsData(projId);
  const bldgs = getUDBldgs(projId);
  const firstBldg = bldgs[0];
  sd.measures.push({
    id: 'm' + Date.now(),
    selected: true,
    msrNum: sd.measures.length + 1 + '',
    bldgId: firstBldg?.id || '',
    desc: '',
    notes: '',
    sqft: firstBldg ? parseFloat(firstBldg.sqft) || 0 : 0,
    implCost: 0,
    incentive: 0,
    rates: firstBldg
      ? calcBldgDefaultRates(projId, firstBldg.id)
      : { kwhSummer: 0, kwhWinter: 0, kwSummer: 0, kwWinter: 0, thermRate: 0, gallonRate: 0 },
    kwh: Array(12).fill(0),
    kw: Array(12).fill(0),
    gas: Array(12).fill(0),
    propane: Array(12).fill(0),
    totalDollar: 0,
  });
  sset('en_projects', projects);
  renderSavingsMatrix(projId);
}

function removeSavingsMeasure(projId, msrId) {
  const sd = getProjSavingsData(projId);
  sd.measures = sd.measures.filter((m) => m.id !== msrId);
  // Track user-deleted measure IDs so idempotent restore blocks don't re-add them
  if (!Array.isArray(sd._userDeletedIds)) sd._userDeletedIds = [];
  if (!sd._userDeletedIds.includes(msrId)) sd._userDeletedIds.push(msrId);
  sset('en_projects', projects);
  renderSavingsMatrix(projId);
}

function renderSavingsMatrix(projId) {
  const sd = getProjSavingsData(projId);
  const bldgs = getUDBldgs(projId);
  const tbody = document.getElementById('sv-matrix-body-' + projId);
  if (!tbody) return;
  const bldgOpts = bldgs.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  if (!sd.measures.length) {
    tbody.innerHTML = `<tr><td colspan="200" style="text-align:center;color:var(--text2);padding:18px;font-size:13px">
            No measures yet — click "+ Add Measure" to start building your savings projection.
          </td></tr>`;
    renderSavingsFooter(projId, sd);
    return;
  }
  // Auto-sync SQFT from current building data if measure has a building assigned
  let _msrDataChanged = false;
  sd.measures.forEach((m) => {
    if (m.bldgId) {
      const bldg = getUDBldg(projId, m.bldgId);
      if (bldg) {
        const bldgSqft = parseFloat(bldg.sqft) || 0;
        if (bldgSqft > 0 && (m.sqft || 0) !== bldgSqft) {
          m.sqft = bldgSqft;
          _msrDataChanged = true;
        }
      }
    }
  });
  if (_msrDataChanged) sset('en_projects', projects);

  // ── Rate functions for cost calc ──
  const _kwhRateFn = (r) => (mo) => (SUMMER_MOS.includes(mo) ? r.kwhSummer || 0 : r.kwhWinter || 0);
  const _kwRateFn = (r) => (mo) => (SUMMER_MOS.includes(mo) ? r.kwSummer || 0 : r.kwWinter || 0);
  const _gasRateFn = (r) => () => r.thermRate || 0;
  const _propRateFn = (r) => () => r.gallonRate || 0;

  // ── Usage cells helper (12 monthly inputs + total) ──
  const _usageCells = (arr, cls, grp, bgColor, pId, mId) => {
    const isOpen = !!_svColGroupState[grp];
    const vals = arr || Array(12).fill(0);
    const total = vals.reduce((a, b) => a + (parseFloat(b) || 0), 0);
    const moCells = vals
      .map(
        (v, i) =>
          `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:2px 1px;background:${bgColor}"><input class="sv-num-inp ${cls}" type="number" step="any" value="${v || ''}" placeholder="0" style="width:54px" onchange="updateMsrVal('${pId}','${mId}','${cls.replace('-col', '')}',${i},this.value)" onfocusout="autoSaveMsr('${pId}')"></td>`,
      )
      .join('');
    return (
      moCells +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:4px 4px;white-space:nowrap">${total ? Math.round(total).toLocaleString() : ''}</td>`
    );
  };

  // ── Cost cells helper (12 monthly read-only + total) ──
  const _costCells = (arr, grp, bgColor, rateFn) => {
    const isOpen = !!_svColGroupState[grp];
    const vals = arr || Array(12).fill(0);
    let total = 0;
    const moCells = vals
      .map((v, i) => {
        const cost = (parseFloat(v) || 0) * rateFn(i);
        total += cost;
        return `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:2px 1px;background:${bgColor};font-family:var(--mono);font-size:10px;text-align:right;color:var(--text2)">${cost ? '$' + Math.round(cost).toLocaleString() : ''}</td>`;
      })
      .join('');
    return (
      moCells +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:4px 4px;white-space:nowrap">${total ? '$' + Math.round(total).toLocaleString() : ''}</td>`
    );
  };

  // ── Rate cell helper ──
  const _rateCell = (mId, field, step, r) =>
    `<td><input class="sv-num-inp sv-rate-inp" type="number" step="${step}" value="${r[field] || ''}" placeholder="0" style="width:52px;font-size:10px" onchange="svUpdateMsrRate('${mId}','${field}',parseFloat(this.value)||0)" onfocusout="autoSaveMsr('${projId}')"></td>`;

  tbody.innerHTML = sd.measures
    .map((m) => {
      const r = m.rates || {};
      if (!m.propane) m.propane = Array(12).fill(0);
      const annMsrKwh = m.kwh.reduce((a, b) => a + (parseFloat(b) || 0), 0);

      // Compute projected savings $ for this measure
      let projSavings = 0;
      for (let mo = 0; mo < 12; mo++) {
        projSavings += (parseFloat(m.kwh[mo]) || 0) * _kwhRateFn(r)(mo);
        projSavings += (parseFloat(m.kw[mo]) || 0) * _kwRateFn(r)(mo);
        projSavings += (parseFloat(m.gas[mo]) || 0) * _gasRateFn(r)();
        projSavings += (parseFloat(m.propane[mo]) || 0) * _propRateFn(r)();
      }

      const dollarStr = projSavings > 0 ? '$' + Math.round(projSavings).toLocaleString() : '—';
      return `<tr id="sv-msr-row-${projId}-${m.id}">
            <td style="text-align:center;vertical-align:top;padding-top:6px"><span class="sv-detail-toggle" id="sv-dtog-${m.id}" onclick="svToggleDetail('${m.id}')">▶</span></td>
            <td style="text-align:center"><input type="checkbox" class="sv-sel-cb" ${m.selected ? 'checked' : ''} onchange="updateMsrSel('${projId}','${m.id}',this.checked)"></td>
            <td><input class="sv-msr-txt" style="width:44px;text-align:center" placeholder="#" value="${m.msrNum || ''}" onchange="updateMsrField('${projId}','${m.id}','msrNum',this.value)"></td>
            <td><select class="sv-msr-sel" onchange="updateMsrField('${projId}','${m.id}','bldgId',this.value)">${bldgOpts.replace(`value="${m.bldgId}"`, `value="${m.bldgId}" selected`)}</select></td>
            <td><input class="sv-num-inp sv-sqft-inp" type="number" style="width:68px" placeholder="0" value="${m.sqft || ''}" onchange="updateMsrField('${projId}','${m.id}','sqft',parseFloat(this.value)||0)"></td>
            <td><input class="sv-msr-txt" style="width:100%;min-width:160px" placeholder="e.g. BAS Setpoint Optimization 74/70°F" value="${m.desc || ''}" onchange="updateMsrField('${projId}','${m.id}','desc',this.value)"></td>
            ${_rateCell(m.id, 'kwhSummer', '0.0001', r)}${_rateCell(m.id, 'kwhWinter', '0.0001', r)}
            ${_rateCell(m.id, 'kwSummer', '0.01', r)}${_rateCell(m.id, 'kwWinter', '0.01', r)}
            ${_rateCell(m.id, 'thermRate', '0.001', r)}${_rateCell(m.id, 'gallonRate', '0.001', r)}
            ${_usageCells(m.kwh, 'kwh-col', 'kwh', 'rgba(59,130,246,0.03)', projId, m.id)}
            ${_usageCells(m.kw, 'kw-col', 'kw', 'rgba(245,158,11,0.03)', projId, m.id)}
            ${_usageCells(m.gas, 'gas-col', 'gas', 'rgba(20,184,166,0.03)', projId, m.id)}
            ${_usageCells(m.propane, 'propane-col', 'propane', 'rgba(168,85,247,0.03)', projId, m.id)}
            ${_costCells(m.kwh, 'kwhCost', 'rgba(59,130,246,0.02)', _kwhRateFn(r))}
            ${_costCells(m.kw, 'kwCost', 'rgba(245,158,11,0.02)', _kwRateFn(r))}
            ${_costCells(m.gas, 'gasCost', 'rgba(20,184,166,0.02)', _gasRateFn(r))}
            ${_costCells(m.propane, 'propaneCost', 'rgba(168,85,247,0.02)', _propRateFn(r))}
            <td class="sv-total-cell" style="border-left:2px solid var(--border2)" id="sv-msr-total-${projId}-${m.id}">${dollarStr}</td>
            <td style="text-align:center"><button class="btn-del" onclick="removeSavingsMeasure(${projId},'${m.id}')">✕</button></td>
          </tr>
          <tr id="sv-detail-${m.id}" class="sv-detail-row" style="display:none">
            <td colspan="200" style="padding:12px 16px">
              <div class="sv-detail-grid">
                <div>
                  <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Utility Rates</div>
                  <div class="sv-rate-group">
                    <div class="sv-rate-field"><label>kWh $/Summer</label><input class="fi" type="number" step="0.0001" value="${r.kwhSummer || ''}" onchange="svUpdateMsrRate('${m.id}','kwhSummer',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>kWh $/Winter</label><input class="fi" type="number" step="0.0001" value="${r.kwhWinter || ''}" onchange="svUpdateMsrRate('${m.id}','kwhWinter',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>kW $/Summer</label><input class="fi" type="number" step="0.01" value="${r.kwSummer || ''}" onchange="svUpdateMsrRate('${m.id}','kwSummer',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>kW $/Winter</label><input class="fi" type="number" step="0.01" value="${r.kwWinter || ''}" onchange="svUpdateMsrRate('${m.id}','kwWinter',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>Gas $/Therm</label><input class="fi" type="number" step="0.001" value="${r.thermRate || ''}" onchange="svUpdateMsrRate('${m.id}','thermRate',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>Propane $/Gallon</label><input class="fi" type="number" step="0.001" value="${r.gallonRate || ''}" onchange="svUpdateMsrRate('${m.id}','gallonRate',parseFloat(this.value)||0)"></div>
                  </div>
                  <button class="btn btn-ghost btn-sm" style="margin-top:8px;font-size:11px" onclick="svResetMsrRates('${m.id}')">Reset to Building Defaults</button>
                </div>
                <div>
                  <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Financials</div>
                  <div class="sv-rate-group">
                    <div class="sv-rate-field"><label>Implementation Cost</label><input class="fi" type="number" step="1" value="${m.implCost || ''}" placeholder="$0" onchange="updateMsrField('${projId}','${m.id}','implCost',parseFloat(this.value)||0)"></div>
                    <div class="sv-rate-field"><label>Incentive / Rebate</label><input class="fi" type="number" step="1" value="${m.incentive || ''}" placeholder="$0" onchange="updateMsrField('${projId}','${m.id}','incentive',parseFloat(this.value)||0)"></div>
                  </div>
                  <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
                    <div>Net Cost: <span class="sv-intensity" style="color:var(--text);font-weight:700">${(m.implCost || 0) - (m.incentive || 0) > 0 ? '$' + Math.round((m.implCost || 0) - (m.incentive || 0)).toLocaleString() : '—'}</span></div>
                    <div>Simple Payback: <span class="sv-intensity" style="color:var(--accent);font-weight:700">${m.totalDollar > 0 && (m.implCost || 0) > 0 ? (((m.implCost || 0) - (m.incentive || 0)) / m.totalDollar).toFixed(1) + ' yrs' : '—'}</span></div>
                  </div>
                </div>
                <div>
                  <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Intensity Metrics</div>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <div>Sq Ft: <span class="sv-intensity" style="color:var(--text)">${m.sqft ? Number(m.sqft).toLocaleString() : '—'}</span></div>
                    <div>kWh/sf saved: <span class="sv-intensity" style="color:var(--accent)">${m.sqft > 0 && annMsrKwh > 0 ? (annMsrKwh / m.sqft).toFixed(1) : '—'}</span></div>
                    <div>$/sf saved: <span class="sv-intensity" style="color:var(--green)">${m.sqft > 0 && m.totalDollar > 0 ? '$' + (m.totalDollar / m.sqft).toFixed(2) : '—'}</span></div>
                  </div>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Notes</div>
                <textarea class="fi" style="width:100%;min-height:48px;resize:vertical;font-size:12px" placeholder="Measure notes..." onchange="updateMsrField('${projId}','${m.id}','notes',this.value)">${m.notes || ''}</textarea>
              </div>
            </td>
          </tr>`;
    })
    .join('');
  renderSavingsFooter(projId, sd);
}

function renderSavingsFooter(projId, sd) {
  const tfoot = document.getElementById('sv-matrix-foot-' + projId);
  if (!tfoot) return;
  const selMsrs = sd.measures.filter((m) => m.selected !== false);
  const totKwh = Array(12).fill(0),
    totKw = Array(12).fill(0),
    totGas = Array(12).fill(0),
    totPropane = Array(12).fill(0);
  let grandTotal = 0,
    totSqft = 0,
    totKwhCost = 0,
    totKwCost = 0,
    totGasCost = 0,
    totPropaneCost = 0;
  selMsrs.forEach((m) => {
    totSqft += parseFloat(m.sqft) || 0;
    m.kwh.forEach((v, i) => (totKwh[i] += parseFloat(v) || 0));
    m.kw.forEach((v, i) => (totKw[i] += parseFloat(v) || 0));
    m.gas.forEach((v, i) => (totGas[i] += parseFloat(v) || 0));
    (m.propane || []).forEach((v, i) => (totPropane[i] += parseFloat(v) || 0));
    const rates = m.rates || (sd.blRates || {})[m.bldgId] || {};
    for (let mo = 0; mo < 12; mo++) {
      const s = SUMMER_MOS.includes(mo);
      const kwhAmt = (parseFloat(m.kwh[mo]) || 0) * (s ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
      const kwAmt = (parseFloat(m.kw[mo]) || 0) * (s ? rates.kwSummer || 0 : rates.kwWinter || 0);
      const gasAmt = (parseFloat(m.gas[mo]) || 0) * (rates.thermRate || 0);
      const propaneAmt = (parseFloat((m.propane || [])[mo]) || 0) * (rates.gallonRate || 0);
      grandTotal += kwhAmt + kwAmt + gasAmt + propaneAmt;
      totKwhCost += kwhAmt;
      totKwCost += kwAmt;
      totGasCost += gasAmt;
      totPropaneCost += propaneAmt;
    }
  });
  const fmtN = (v) => (v ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '');
  const fmtD = (v) => (v > 0 ? '$' + Math.round(v).toLocaleString() : '');
  // Footer usage cells (collapsible months + total)
  const _footUsage = (totArr, grp, color) => {
    const isOpen = !!_svColGroupState[grp];
    const annTotal = totArr.reduce((a, b) => a + b, 0);
    return (
      totArr
        .map(
          (v, i) =>
            `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});font-family:var(--mono);font-size:11px;font-weight:700;color:${color};text-align:right;padding:5px 3px">${fmtN(v)}</td>`,
        )
        .join('') +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;color:${color};text-align:right;padding:5px 3px">${fmtN(annTotal)}</td>`
    );
  };
  const _footCost = (grp, totCost) => {
    const isOpen = !!_svColGroupState[grp];
    return (
      Array(12)
        .fill(0)
        .map(
          (_, i) =>
            `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:5px 3px"></td>`,
        )
        .join('') +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:5px 3px;color:var(--green)">${fmtD(totCost)}</td>`
    );
  };
  tfoot.innerHTML = `<tr class="sv-foot-row">
          <td></td><td></td><td></td>
          <td style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">SELECTED TOTALS</td>
          <td style="font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:5px 4px">${totSqft ? totSqft.toLocaleString(undefined, { maximumFractionDigits: 0 }) : ''}</td>
          <td colspan="7"></td>
          ${_footUsage(totKwh, 'kwh', 'var(--accent)')}
          ${_footUsage(totKw, 'kw', 'var(--amber)')}
          ${_footUsage(totGas, 'gas', 'var(--teal)')}
          ${_footUsage(totPropane, 'propane', 'var(--purple,#a855f7)')}
          ${_footCost('kwhCost', totKwhCost)}${_footCost('kwCost', totKwCost)}${_footCost('gasCost', totGasCost)}${_footCost('propaneCost', totPropaneCost)}
          <td class="sv-total-cell sv-foot-total" style="border-left:2px solid var(--border2)">${grandTotal > 0 ? '$' + Math.round(grandTotal).toLocaleString() : '—'}</td>
          <td></td>
        </tr>`;
  renderSavingsSummary(projId, sd, totKwh, totKw, totGas, totPropane, grandTotal);
  // Keep the compact header banner in sync with the computed grand total
  if (typeof _updateCompactHdrSavings === 'function') _updateCompactHdrSavings(projId);
}

function renderSavingsSummary(projId, sd, totKwh, totKw, totGas, totPropane, grandTotal) {
  const el = document.getElementById('sv-summary-' + projId);
  if (!el) return;
  const annKwh = totKwh.reduce((a, b) => a + b, 0);
  const annKwAvg = totKw.reduce((a, b) => a + b, 0) / 12;
  const annGas = totGas.reduce((a, b) => a + b, 0);
  const annPropane = (totPropane || []).reduce((a, b) => a + b, 0);
  const selCount = (sd.measures || []).filter((m) => m.selected !== false).length;
  if (!selCount) {
    el.innerHTML = '';
    return;
  }
  const selMsrs = (sd.measures || []).filter((m) => m.selected !== false);
  const totImpl = selMsrs.reduce((s, m) => s + (parseFloat(m.implCost) || 0), 0);
  const totIncent = selMsrs.reduce((s, m) => s + (parseFloat(m.incentive) || 0), 0);
  const netCost = totImpl - totIncent;
  const payback = grandTotal > 0 && netCost > 0 ? (netCost / grandTotal).toFixed(1) : null;
  // Compute quarterly savings totals (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec)
  const qtrs = [0, 0, 0, 0];
  selMsrs.forEach((m) => {
    const r = m.rates || {};
    for (let mo = 0; mo < 12; mo++) {
      const qi = Math.floor(mo / 3);
      const s = SUMMER_MOS.includes(mo);
      qtrs[qi] += (parseFloat(m.kwh[mo]) || 0) * (s ? r.kwhSummer || 0 : r.kwhWinter || 0);
      qtrs[qi] += (parseFloat(m.kw[mo]) || 0) * (s ? r.kwSummer || 0 : r.kwWinter || 0);
      qtrs[qi] += (parseFloat(m.gas[mo]) || 0) * (r.thermRate || 0);
      qtrs[qi] += (parseFloat((m.propane || [])[mo]) || 0) * (r.gallonRate || 0);
    }
  });
  const qtrLabels = ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)'];
  const qtrHtml =
    grandTotal > 0
      ? qtrLabels
          .map(
            (lbl, i) =>
              `<div class="bl-qtr-item"><span class="bl-qtr-lbl">${lbl}</span><span class="bl-qtr-val">${qtrs[i] > 0 ? '$' + Math.round(qtrs[i]).toLocaleString() : '—'}</span></div>`,
          )
          .join('')
      : '';
  el.innerHTML = `<div class="bl-result" style="margin-top:0">
          <div class="bl-title">💡 Selected Measures Summary (${selCount} measure${selCount !== 1 ? 's' : ''})</div>
          <div class="bl-grid">
            <div class="bl-item"><div class="bl-lbl">Annual kWh Savings</div><div class="bl-val" style="color:var(--accent)">${Math.round(annKwh).toLocaleString()}<span class="bl-unit"> kWh/yr</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Avg kW Reduction</div><div class="bl-val" style="color:var(--amber)">${annKwAvg.toFixed(1)}<span class="bl-unit"> kW avg</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Annual Gas Savings</div><div class="bl-val" style="color:var(--teal)">${Math.round(annGas).toLocaleString()}<span class="bl-unit"> Therms/yr</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Annual Propane Savings</div><div class="bl-val" style="color:var(--purple,#a855f7)">${Math.round(annPropane).toLocaleString()}<span class="bl-unit"> Gal/yr</span></div></div>
            <div class="bl-item" style="grid-column:1/-1">
              <div class="bl-lbl">Projected Savings $</div>
              <div class="bl-val" style="color:var(--green)">${grandTotal > 0 ? '$' + Math.round(grandTotal).toLocaleString() : '—'}</div>
              ${qtrHtml ? `<div class="bl-qtrs">${qtrHtml}</div>` : ''}
            </div>
            ${totImpl > 0 ? `<div class="bl-item"><div class="bl-lbl">Total Impl. Cost</div><div class="bl-val" style="color:var(--text)">$${Math.round(netCost).toLocaleString()}<span class="bl-unit">${totIncent > 0 ? ' (net of $' + Math.round(totIncent).toLocaleString() + ' incentive)' : ''}</span></div></div>` : ''}
            ${payback ? `<div class="bl-item"><div class="bl-lbl">Simple Payback</div><div class="bl-val" style="color:var(--accent)">${payback}<span class="bl-unit"> years</span></div></div>` : ''}
          </div>
        </div>`;
}

function updateMsrVal(projId, msrId, type, moIdx, val) {
  const sd = getProjSavingsData(projId);
  const m = sd.measures.find((x) => x.id === msrId);
  if (!m) return;
  if (!m[type]) m[type] = Array(12).fill(0);
  m[type][moIdx] = parseFloat(val) || 0;
}
function updateMsrField(projId, msrId, field, val) {
  const sd = getProjSavingsData(projId);
  const m = sd.measures.find((x) => x.id === msrId);
  if (!m) return;
  m[field] = val;
  // Auto-populate sqft and rates when building changes
  if (field === 'bldgId' && val) {
    const bldg = getUDBldg(projId, val);
    if (bldg) {
      m.sqft = parseFloat(bldg.sqft) || 0;
      m.rates = calcBldgDefaultRates(projId, val);
      const sqftInp = document.querySelector(
        `#sv-msr-row-${projId}-${msrId} .sv-sqft-inp, #sv-pg-msr-row-${msrId} .sv-sqft-inp`,
      );
      if (sqftInp) sqftInp.value = m.sqft || '';
    }
  }
  sset('en_projects', projects);
}
function updateMsrSel(projId, msrId, checked) {
  const sd = getProjSavingsData(projId);
  const m = sd.measures.find((x) => x.id === msrId);
  if (!m) return;
  m.selected = checked;
  sset('en_projects', projects);
  renderSavingsFooter(projId, sd);
}
function autoSaveMsr(projId) {
  sset('en_projects', projects);
}

function calcProjSavingsMatrix(projId) {
  const sd = getProjSavingsData(projId);
  // Read live DOM values back into data (check both project-tab and sidebar row IDs)
  sd.measures.forEach((m) => {
    const row =
      document.getElementById('sv-msr-row-' + projId + '-' + m.id) || document.getElementById('sv-pg-msr-row-' + m.id);
    if (!row) return;
    ['kwh-col', 'kw-col', 'gas-col', 'propane-col'].forEach((cls, ti) => {
      const type = ['kwh', 'kw', 'gas', 'propane'][ti];
      if (!m[type]) m[type] = Array(12).fill(0);
      row.querySelectorAll('input.' + cls).forEach((inp, i) => {
        m[type][i] = parseFloat(inp.value) || 0;
      });
    });
  });
  // Recalculate $ per measure using seasonal rates
  sd.measures.forEach((m) => {
    const rates = m.rates || sd.blRates[m.bldgId] || {};
    let total = 0;
    for (let mo = 0; mo < 12; mo++) {
      const isSummer = SUMMER_MOS.includes(mo);
      total += (m.kwh[mo] || 0) * (isSummer ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
      total += (m.kw[mo] || 0) * (isSummer ? rates.kwSummer || 0 : rates.kwWinter || 0);
      total += (m.gas[mo] || 0) * (rates.thermRate || 0);
      total += ((m.propane || [])[mo] || 0) * (rates.gallonRate || 0);
    }
    m.totalDollar = total;
    const cell =
      document.getElementById('sv-msr-total-' + projId + '-' + m.id) || document.getElementById('sv-pg-total-' + m.id);
    if (cell) cell.textContent = total > 0 ? '$' + Math.round(total).toLocaleString() : '—';
  });
  sset('en_projects', projects);
  renderSavingsFooter(projId, sd);
  showToast('Savings recalculated ✓');
}

function initSavingsTab(projId) {
  // Render the SAME savings view as the sidebar Energy Savings page
  const wrap = document.getElementById('ptab-savings');
  if (!wrap) return;
  _renderSavingsContent(wrap, projId);
}

async function calcProjSavings(projId) {
  initSavingsTab(projId);
}

// ══════════════════════════════════════════════════════
//  STANDALONE ENERGY SAVINGS PAGE  (mirrors project tab)
// ══════════════════════════════════════════════════════
let svSelProjId = null;

function renderSvProjNav() {
  const nav = document.getElementById('svNavList');
  if (!nav) return;
  if (!projects.length) {
    nav.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text2)">No projects yet.</div>';
    return;
  }
  nav.innerHTML = projects
    .map((p) => {
      const sd = getProjSavingsData(p.id);
      const mCount = sd.measures.length;
      const active = p.id === svSelProjId;
      const borderColor = active ? 'var(--accent)' : 'transparent';
      const bg = active ? 'var(--accent-dim)' : 'transparent';
      const fw = active ? '700' : '500';
      const col = active ? 'var(--text)' : 'var(--text2)';
      return `<div class="ud-nav-bldg-item${active ? ' active' : ''}" onclick="svSelectProj(${p.id})"
            style="padding:10px 14px;cursor:pointer;border-left:2px solid ${borderColor};background:${bg}">
            <div style="font-size:13px;font-weight:${fw};color:${col};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${mCount} measure${mCount !== 1 ? 's' : ''} · ${p.status || 'active'}</div>
          </div>`;
    })
    .join('');
}

function svSelectProj(projId) {
  svSelProjId = projId;
  renderSvProjNav();
  renderSvDetail();
}

function renderSvDetail() {
  const wrap = document.getElementById('svDetailWrap');
  const hdr = document.getElementById('svDetailHdr');
  const hdrTitle = document.getElementById('svDetailHdrTitle');
  const hdrSub = document.getElementById('svDetailHdrSub');
  if (!wrap) return;

  if (!svSelProjId) {
    if (hdr) hdr.style.display = 'none';
    wrap.innerHTML =
      '<div class="ud-empty"><div class="ud-empty-ico">💡</div><div>Select a project from the left<br>to view and edit energy savings</div></div>';
    return;
  }
  const p = projects.find((x) => x.id === svSelProjId);
  if (!p) {
    wrap.innerHTML = '<div class="ud-empty">Project not found</div>';
    return;
  }
  if (hdr) hdr.style.display = 'flex';
  if (hdrTitle) hdrTitle.textContent = p.name;
  if (hdrSub) {
    const hdrBldgs = getUDBldgs(svSelProjId);
    hdrSub.textContent = [
      p.client,
      p.status,
      hdrBldgs.length ? hdrBldgs.length + ' building' + (hdrBldgs.length !== 1 ? 's' : '') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  _renderSavingsContent(wrap, svSelProjId);
}

/* ── Collapsible column group state ── */
const _svColGroupState = {};
function svToggleColGroup(grp) {
  _svColGroupState[grp] = !_svColGroupState[grp];
  const isOpen = _svColGroupState[grp];
  document.querySelectorAll('.sv-cg-' + grp).forEach((el) => {
    el.style.display = isOpen ? '' : 'none';
  });
  const tog = document.getElementById('sv-cg-tog-' + grp);
  if (tog) tog.textContent = isOpen ? '▾' : '▸';
  const hdr = document.getElementById('sv-cg-hdr-' + grp);
  if (hdr) hdr.colSpan = isOpen ? 13 : 1;
}
function svToggleAllColGroups(expand) {
  ['kwh', 'kw', 'gas', 'propane', 'kwhCost', 'kwCost', 'gasCost', 'propaneCost'].forEach((grp) => {
    _svColGroupState[grp] = expand;
    document.querySelectorAll('.sv-cg-' + grp).forEach((el) => {
      el.style.display = expand ? '' : 'none';
    });
    const tog = document.getElementById('sv-cg-tog-' + grp);
    if (tog) tog.textContent = expand ? '▾' : '▸';
    const hdr = document.getElementById('sv-cg-hdr-' + grp);
    if (hdr) hdr.colSpan = expand ? 13 : 1;
  });
}

/* ── Shared savings renderer — used by BOTH sidebar Energy Savings page AND project tab ── */
function _renderSavingsContent(wrap, projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) {
    wrap.innerHTML = '<div class="ud-empty">Project not found</div>';
    return;
  }
  const sd = getProjSavingsData(projId);
  const bldgs = getUDBldgs(projId);
  // Migrate old per-building rates to per-measure rates
  let _migrated = false;
  sd.measures.forEach((m) => {
    if (!m.rates && sd.blRates && sd.blRates[m.bldgId]) {
      m.rates = { ...sd.blRates[m.bldgId] };
      _migrated = true;
    }
    if (!m.rates) m.rates = calcBldgDefaultRates(projId, m.bldgId);
    // Migrate wrong rate field names (rates.gas → rates.thermRate, rates.propane → rates.gallonRate)
    if (m.rates && 'gas' in m.rates && !('thermRate' in m.rates)) {
      m.rates.thermRate = m.rates.gas;
      delete m.rates.gas;
      _migrated = true;
    }
    if (m.rates && 'propane' in m.rates && !('gallonRate' in m.rates)) {
      m.rates.gallonRate = m.rates.propane;
      delete m.rates.propane;
      _migrated = true;
    }
    // Migrate missing selected field (undefined → true)
    if (m.selected === undefined) {
      m.selected = true;
      _migrated = true;
    }
  });
  if (_migrated) sset('en_projects', projects);
  // Idempotent restore: Broadmoor Elementary (bldgId b1776962504464) in Louisburg project.
  // Runs on every render — only mutates if measure is missing or has wrong data. Safe no-op otherwise.
  // Skips restore if user explicitly deleted this measure (tracked in sd._userDeletedIds).
  if (p.name && p.name.indexOf('Louisburg') !== -1) {
    const _bmId = 'm_csv_b1776962504464';
    const _bmUserDeleted = Array.isArray(sd._userDeletedIds) && sd._userDeletedIds.includes(_bmId);
    if (!_bmUserDeleted) {
      const _bmCorrect = {
        id: _bmId,
        bldgId: 'b1776962504464',
        desc: 'BAS Savings',
        selected: true,
        source: 'bas',
        sqft: 0,
        totalDollar: 8129.792025,
        rates: {
          kwhSummer: 0.0711,
          kwhWinter: 0.0553,
          kwSummer: 3190.1,
          kwWinter: 2332.98,
          thermRate: 0.798,
        },
        kwh: [
          5298.44, 4374.63, 3722.75, 1483.52, 8364.24, 18323.82, 29494.55, 20370.85, 10319.94, 5719.57, 3741.26,
          4842.72,
        ],
        gas: [133.41, 110.15, 93.73, 37.35, 0, 0, 0, 0, 0, 0, 94.2, 121.93],
        kw: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        propane: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      };
      const bmIdx = sd.measures.findIndex((m) => m.bldgId === 'b1776962504464');
      let _bmChanged = false;
      if (bmIdx === -1) {
        // Measure is missing — push it
        sd.measures.push(_bmCorrect);
        _bmChanged = true;
      } else {
        const bm = sd.measures[bmIdx];
        // Check if totalDollar or critical rates are wrong
        if (
          bm.totalDollar !== _bmCorrect.totalDollar ||
          !bm.rates ||
          bm.rates.kwhSummer !== _bmCorrect.rates.kwhSummer ||
          bm.rates.kwhWinter !== _bmCorrect.rates.kwhWinter ||
          bm.rates.thermRate !== _bmCorrect.rates.thermRate
        ) {
          sd.measures[bmIdx] = _bmCorrect;
          _bmChanged = true;
        }
        // If present and correct but unchecked, re-enable it
        if (!_bmChanged && sd.measures[bmIdx].selected === false) {
          sd.measures[bmIdx].selected = true;
          _bmChanged = true;
        }
      }
      if (_bmChanged) {
        // Restore associated per-building config keys if not already set
        const bspKey = 'bldgsavproj_cfg_b1776962504464';
        const bpKey = 'bldgperf_cfg_b1776962504464';
        if (!DB.get(bspKey, null)) {
          DB.set(bspKey, { cscPct: 60, escPct: 3.5, savingsPct: 6.7 });
        }
        if (!DB.get(bpKey, null)) {
          DB.set(bpKey, {
            cscMode: 'pct',
            cscPct: 60,
            cscFixed: 0,
            years: 3,
            escPct: 3.5,
            _customEsc: true,
            view: 'monthly',
            _customCsc: true,
          });
        }
        sset('en_projects', projects);
      }
    } // end if (!_bmUserDeleted)
  }
  // Idempotent restore: Circle Grove Elementary (bldgId b1776962484232) in Louisburg project.
  // Runs on every render — only mutates if measure is missing, has wrong data, or is unchecked.
  // Skips restore if user explicitly deleted this measure (tracked in sd._userDeletedIds).
  if (p.name && p.name.indexOf('Louisburg') !== -1) {
    const _cgId = 'm_csv_b1776962484232';
    const _cgUserDeleted = Array.isArray(sd._userDeletedIds) && sd._userDeletedIds.includes(_cgId);
    if (!_cgUserDeleted) {
      const _cgCorrect = {
        id: _cgId,
        bldgId: 'b1776962484232',
        desc: 'BAS Savings',
        msrNum: '',
        sqft: 0,
        selected: true,
        source: 'bas',
        totalDollar: 2167.0283010000003,
        rates: {
          kwhSummer: 0.1025,
          kwhWinter: 0.0837,
          kwSummer: 542.71,
          kwWinter: 226.34,
          thermRate: 0,
          gallonRate: 1.6,
        },
        kwh: [731.14, 450.78, 280.63, 70.84, 1235.96, 2652.89, 3889.82, 2880.23, 1541.63, 806.71, 217.57, 487.85],
        kw: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        gas: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        propane: [124, 100, 56, 13, 0, 0, 0, 0, 0, 0, 40, 95],
      };
      const cgIdx = sd.measures.findIndex((m) => m.bldgId === 'b1776962484232');
      let _cgChanged = false;
      if (cgIdx === -1) {
        // Measure is missing — push it (handles the case Circle Grove was deleted)
        sd.measures.push(_cgCorrect);
        _cgChanged = true;
      } else {
        const cg = sd.measures[cgIdx];
        // Check if fuel type is wrong (no gallonRate means propane field is corrupt) or rates are wrong
        if (
          cg.totalDollar !== _cgCorrect.totalDollar ||
          !cg.rates ||
          cg.rates.gallonRate !== _cgCorrect.rates.gallonRate ||
          cg.rates.kwhSummer !== _cgCorrect.rates.kwhSummer ||
          cg.rates.thermRate !== _cgCorrect.rates.thermRate
        ) {
          sd.measures[cgIdx] = _cgCorrect;
          _cgChanged = true;
        }
        // If present and correct but unchecked, re-enable it
        if (!_cgChanged && sd.measures[cgIdx].selected === false) {
          sd.measures[cgIdx].selected = true;
          _cgChanged = true;
        }
      }
      if (_cgChanged) {
        sset('en_projects', projects);
      }
    } // end if (!_cgUserDeleted)
  }
  // Auto-sync SQFT from current building data if measure has a building assigned
  let _sqftChanged = false;
  sd.measures.forEach((m) => {
    if (m.bldgId) {
      const bldg = getUDBldg(projId, m.bldgId);
      if (bldg) {
        const bldgSqft = parseFloat(bldg.sqft) || 0;
        if (bldgSqft > 0 && (m.sqft || 0) !== bldgSqft) {
          m.sqft = bldgSqft;
          _sqftChanged = true;
        }
      }
    }
  });
  if (_sqftChanged) sset('en_projects', projects);
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Collapsible month header helper ──
  const moHdrs = (grp) => {
    const isOpen = !!_svColGroupState[grp];
    return (
      MO.map(
        (m, i) =>
          `<th class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});font-size:10px;padding:4px 2px;width:58px;text-align:center">${m}</th>`,
      ).join('') +
      '<th style="border-left:1px solid var(--border);font-size:10px;padding:4px 2px;text-align:center;min-width:70px">Total</th>'
    );
  };

  // ── Group header builder ──
  const grpHdr = (grp, label, colspan, bg) => {
    const isOpen = !!_svColGroupState[grp];
    return `<th id="sv-cg-hdr-${grp}" colspan="${isOpen ? colspan : 1}" style="text-align:center;border-left:2px solid var(--border2);background:${bg};cursor:pointer;user-select:none" onclick="svToggleColGroup('${grp}')"><span id="sv-cg-tog-${grp}" style="font-size:10px;margin-right:3px">${isOpen ? '▾' : '▸'}</span>${label}</th>`;
  };

  // ── Rate functions for cost calc ──
  const kwhRateFn = (r) => (mo) => (SUMMER_MOS.includes(mo) ? r.kwhSummer || 0 : r.kwhWinter || 0);
  const kwRateFn = (r) => (mo) => (SUMMER_MOS.includes(mo) ? r.kwSummer || 0 : r.kwWinter || 0);
  const gasRateFn = (r) => () => r.thermRate || 0;
  const propRateFn = (r) => () => r.gallonRate || 0;

  // ── Usage cells helper (12 monthly inputs + total) ──
  const usageCells = (arr, cls, grp, bgColor, mid) => {
    const isOpen = !!_svColGroupState[grp];
    const vals = arr || Array(12).fill(0);
    const total = vals.reduce((a, b) => a + (parseFloat(b) || 0), 0);
    const moCells = vals
      .map(
        (v, i) =>
          `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:2px 1px;background:${bgColor}"><input class="sv-num-inp ${cls}" type="number" step="any" value="${v || ''}" placeholder="0" style="width:54px" onchange="svUpdateMsrVal('${mid}','${cls.replace('-col', '')}',${i},this.value)" onfocusout="svAutoSave()"></td>`,
      )
      .join('');
    return (
      moCells +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:4px 4px;white-space:nowrap">${total ? Math.round(total).toLocaleString() : ''}</td>`
    );
  };

  // ── Cost cells helper (12 monthly read-only + total) ──
  const costCells = (arr, grp, bgColor, rateFn) => {
    const isOpen = !!_svColGroupState[grp];
    const vals = arr || Array(12).fill(0);
    let total = 0;
    const moCells = vals
      .map((v, i) => {
        const cost = (parseFloat(v) || 0) * rateFn(i);
        total += cost;
        return `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:2px 1px;background:${bgColor};font-family:var(--mono);font-size:10px;text-align:right;color:var(--text2)">${cost ? '$' + Math.round(cost).toLocaleString() : ''}</td>`;
      })
      .join('');
    return (
      moCells +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:4px 4px;white-space:nowrap">${total ? '$' + Math.round(total).toLocaleString() : ''}</td>`
    );
  };

  // ── Rate cell helper ──
  const rateCell = (mid, field, step, r) =>
    `<td><input class="sv-num-inp sv-rate-inp" type="number" step="${step}" value="${r[field] || ''}" placeholder="0" style="width:52px;font-size:10px" onchange="svUpdateMsrRate('${mid}','${field}',parseFloat(this.value)||0)" onfocusout="svAutoSave()"></td>`;

  // ── Measure rows ──
  const bldgOpts = bldgs.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  const hasMeasures = sd.measures.length > 0;
  const emptyStateHtml = hasMeasures
    ? ''
    : `<div style="text-align:center;color:var(--text2);padding:24px 16px;font-size:13px">
          No measures yet — click "+ Add Measure" in the header to begin.
        </div>`;
  let msrRows;
  if (!hasMeasures) {
    msrRows = '';
  } else {
    msrRows = sd.measures
      .map((m) => {
        const pid = projId,
          mid = m.id;
        const r = m.rates || {};
        if (!m.propane) m.propane = Array(12).fill(0);
        const annMsrKwh = m.kwh.reduce((a, b) => a + (parseFloat(b) || 0), 0);

        // Compute projected savings $ for this measure
        let projSavings = 0;
        for (let mo = 0; mo < 12; mo++) {
          projSavings += (parseFloat(m.kwh[mo]) || 0) * kwhRateFn(r)(mo);
          projSavings += (parseFloat(m.kw[mo]) || 0) * kwRateFn(r)(mo);
          projSavings += (parseFloat(m.gas[mo]) || 0) * gasRateFn(r)();
          projSavings += (parseFloat(m.propane[mo]) || 0) * propRateFn(r)();
        }

        const dollar = projSavings > 0 ? '$' + Math.round(projSavings).toLocaleString() : '—';
        const selOpts = bldgOpts.replace(`value="${m.bldgId}"`, `value="${m.bldgId}" selected`);
        const srcBadge = m.source
          ? `<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:var(--accent-dim);color:var(--accent);font-weight:600;white-space:nowrap">${m.source === 'solar' ? '☀️ Solar' : m.source}</span>`
          : '';
        return `<tr id="sv-pg-msr-row-${mid}">
              <td style="text-align:center;vertical-align:top;padding-top:6px"><span class="sv-detail-toggle" id="sv-dtog-${mid}" onclick="svToggleDetail('${mid}')">▶</span></td>
              <td></td>
              <td style="text-align:center"><input type="checkbox" class="sv-sel-cb" ${m.selected ? 'checked' : ''} onchange="svUpdateMsrSel('${mid}',this.checked)"></td>
              <td><input class="sv-msr-txt" style="width:44px;text-align:center" placeholder="#" value="${m.msrNum || ''}" onchange="svUpdateMsrField('${mid}','msrNum',this.value)" onfocusout="svAutoSave()"></td>
              <td><select class="sv-msr-sel" onchange="svUpdateMsrField('${mid}','bldgId',this.value)">${selOpts}</select></td>
              <td><input class="sv-num-inp sv-sqft-inp" type="number" style="width:68px" placeholder="0" value="${m.sqft || ''}" onchange="svUpdateMsrField('${mid}','sqft',parseFloat(this.value)||0)" onfocusout="svAutoSave()"></td>
              <td><div style="display:flex;align-items:center;gap:4px"><input class="sv-msr-txt" style="flex:1;min-width:130px" placeholder="e.g. BAS Setpoint Optimization 74/70°F" value="${m.desc || ''}" onchange="svUpdateMsrField('${mid}','desc',this.value)" onfocusout="svAutoSave()"><button class="btn btn-ghost btn-sm" style="padding:3px 6px;font-size:11px;flex-shrink:0" onclick="openCalcForMeasure(${pid},'${mid}','${wrap.id === 'ptab-savings' ? 'ptab' : 'sv'}')" title="Open calc template for this measure">📐</button>${srcBadge}</div></td>
              ${rateCell(mid, 'kwhSummer', '0.0001', r)}${rateCell(mid, 'kwhWinter', '0.0001', r)}
              ${rateCell(mid, 'kwSummer', '0.01', r)}${rateCell(mid, 'kwWinter', '0.01', r)}
              ${rateCell(mid, 'thermRate', '0.001', r)}${rateCell(mid, 'gallonRate', '0.001', r)}
              ${usageCells(m.kwh, 'kwh-col', 'kwh', 'rgba(59,130,246,0.03)', mid)}
              ${usageCells(m.kw, 'kw-col', 'kw', 'rgba(245,158,11,0.03)', mid)}
              ${usageCells(m.gas, 'gas-col', 'gas', 'rgba(20,184,166,0.03)', mid)}
              ${usageCells(m.propane, 'propane-col', 'propane', 'rgba(168,85,247,0.03)', mid)}
              ${costCells(m.kwh, 'kwhCost', 'rgba(59,130,246,0.02)', kwhRateFn(r))}
              ${costCells(m.kw, 'kwCost', 'rgba(245,158,11,0.02)', kwRateFn(r))}
              ${costCells(m.gas, 'gasCost', 'rgba(20,184,166,0.02)', gasRateFn(r))}
              ${costCells(m.propane, 'propaneCost', 'rgba(168,85,247,0.02)', propRateFn(r))}
              <td class="sv-total-cell" style="border-left:2px solid var(--border2)" id="sv-pg-total-${mid}">${dollar}</td>
              <td style="text-align:center"><button class="btn-del" onclick="svRemoveMeasure(${pid},'${mid}')">✕</button></td>
            </tr>
            <tr id="sv-detail-${mid}" class="sv-detail-row" style="display:none">
              <td colspan="200" style="padding:12px 16px">
                <div class="sv-detail-grid">
                  <div>
                    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Utility Rates</div>
                    <div class="sv-rate-group">
                      <div class="sv-rate-field"><label>kWh $/Summer</label><input class="fi" type="number" step="0.0001" value="${r.kwhSummer || ''}" onchange="svUpdateMsrRate('${mid}','kwhSummer',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>kWh $/Winter</label><input class="fi" type="number" step="0.0001" value="${r.kwhWinter || ''}" onchange="svUpdateMsrRate('${mid}','kwhWinter',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>kW $/Summer</label><input class="fi" type="number" step="0.01" value="${r.kwSummer || ''}" onchange="svUpdateMsrRate('${mid}','kwSummer',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>kW $/Winter</label><input class="fi" type="number" step="0.01" value="${r.kwWinter || ''}" onchange="svUpdateMsrRate('${mid}','kwWinter',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>Gas $/Therm</label><input class="fi" type="number" step="0.001" value="${r.thermRate || ''}" onchange="svUpdateMsrRate('${mid}','thermRate',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>Propane $/Gallon</label><input class="fi" type="number" step="0.001" value="${r.gallonRate || ''}" onchange="svUpdateMsrRate('${mid}','gallonRate',parseFloat(this.value)||0)"></div>
                    </div>
                    <button class="btn btn-ghost btn-sm" style="margin-top:8px;font-size:11px" onclick="svResetMsrRates('${mid}')">Reset to Building Defaults</button>
                  </div>
                  <div>
                    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Financials</div>
                    <div class="sv-rate-group">
                      <div class="sv-rate-field"><label>Implementation Cost</label><input class="fi" type="number" step="1" value="${m.implCost || ''}" placeholder="$0" onchange="svUpdateMsrField('${mid}','implCost',parseFloat(this.value)||0)"></div>
                      <div class="sv-rate-field"><label>Incentive / Rebate</label><input class="fi" type="number" step="1" value="${m.incentive || ''}" placeholder="$0" onchange="svUpdateMsrField('${mid}','incentive',parseFloat(this.value)||0)"></div>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
                      <div>Net Cost: <span class="sv-intensity" style="color:var(--text);font-weight:700">${(m.implCost || 0) - (m.incentive || 0) > 0 ? '$' + Math.round((m.implCost || 0) - (m.incentive || 0)).toLocaleString() : '—'}</span></div>
                      <div>Simple Payback: <span class="sv-intensity" style="color:var(--accent);font-weight:700">${m.totalDollar > 0 && (m.implCost || 0) > 0 ? (((m.implCost || 0) - (m.incentive || 0)) / m.totalDollar).toFixed(1) + ' yrs' : '—'}</span></div>
                    </div>
                  </div>
                  <div>
                    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Intensity Metrics</div>
                    <div style="display:flex;flex-direction:column;gap:6px">
                      <div>Sq Ft: <span class="sv-intensity" style="color:var(--text)">${m.sqft ? Number(m.sqft).toLocaleString() : '—'}</span></div>
                      <div>kWh/sf saved: <span class="sv-intensity" style="color:var(--accent)">${m.sqft > 0 && annMsrKwh > 0 ? (annMsrKwh / m.sqft).toFixed(1) : '—'}</span></div>
                      <div>$/sf saved: <span class="sv-intensity" style="color:var(--green)">${m.sqft > 0 && m.totalDollar > 0 ? '$' + (m.totalDollar / m.sqft).toFixed(2) : '—'}</span></div>
                    </div>
                  </div>
                </div>
                <div style="margin-top:10px">
                  <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Notes</div>
                  <textarea class="fi" style="width:100%;min-height:48px;resize:vertical;font-size:12px" placeholder="Measure notes..." onchange="svUpdateMsrField('${mid}','notes',this.value)" onfocusout="svAutoSave()">${m.notes || ''}</textarea>
                </div>
              </td>
            </tr>`;
      })
      .join('');
  }

  // ── Footer totals ──
  const selMsrs = sd.measures.filter((m) => m.selected !== false);
  const totKwh = Array(12).fill(0),
    totKw = Array(12).fill(0),
    totGas = Array(12).fill(0),
    totPropane = Array(12).fill(0);
  let grandTotal = 0;
  let totSqft = 0,
    totKwhCost = 0,
    totKwCost = 0,
    totGasCost = 0,
    totPropaneCost = 0;
  const svQtrs = [0, 0, 0, 0];
  selMsrs.forEach((m) => {
    totSqft += parseFloat(m.sqft) || 0;
    m.kwh.forEach((v, i) => (totKwh[i] += parseFloat(v) || 0));
    m.kw.forEach((v, i) => (totKw[i] += parseFloat(v) || 0));
    m.gas.forEach((v, i) => (totGas[i] += parseFloat(v) || 0));
    (m.propane || []).forEach((v, i) => (totPropane[i] += parseFloat(v) || 0));
    const rates = m.rates || (sd.blRates || {})[m.bldgId] || {};
    for (let mo = 0; mo < 12; mo++) {
      const s = SUMMER_MOS.includes(mo);
      const kwhAmt = (parseFloat(m.kwh[mo]) || 0) * (s ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
      const kwAmt = (parseFloat(m.kw[mo]) || 0) * (s ? rates.kwSummer || 0 : rates.kwWinter || 0);
      const gasAmt = (parseFloat(m.gas[mo]) || 0) * (rates.thermRate || 0);
      const propaneAmt = (parseFloat((m.propane || [])[mo]) || 0) * (rates.gallonRate || 0);
      const moTotal = kwhAmt + kwAmt + gasAmt + propaneAmt;
      grandTotal += moTotal;
      svQtrs[Math.floor(mo / 3)] += moTotal;
      totKwhCost += kwhAmt;
      totKwCost += kwAmt;
      totGasCost += gasAmt;
      totPropaneCost += propaneAmt;
    }
  });
  const fmtN = (v) => (v ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '');
  const fmtD = (v) => (v > 0 ? '$' + Math.round(v).toLocaleString() : '');

  // Footer usage cells (collapsible months + total)
  const footUsage = (totArr, grp, color) => {
    const isOpen = !!_svColGroupState[grp];
    const annTotal = totArr.reduce((a, b) => a + b, 0);
    return (
      totArr
        .map(
          (v, i) =>
            `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});font-family:var(--mono);font-size:11px;font-weight:700;color:${color};text-align:right;padding:5px 3px">${fmtN(v)}</td>`,
        )
        .join('') +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;color:${color};text-align:right;padding:5px 3px">${fmtN(annTotal)}</td>`
    );
  };
  // Footer cost cells (collapsible months empty + annual total)
  const footCost = (grp, totCost) => {
    const isOpen = !!_svColGroupState[grp];
    return (
      Array(12)
        .fill(0)
        .map(
          (_, i) =>
            `<td class="sv-cg-${grp}" style="display:${isOpen ? '' : 'none'};border-left:${i === 0 ? '2px' : '1px'} solid var(--border${i === 0 ? '2' : ''});padding:5px 3px"></td>`,
        )
        .join('') +
      `<td style="border-left:1px solid var(--border);font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:5px 3px;color:var(--green)">${fmtD(totCost)}</td>`
    );
  };

  const footRow = `<tr class="sv-foot-row">
          <td></td><td></td><td></td><td></td>
          <td style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">SELECTED TOTALS</td>
          <td style="font-family:var(--mono);font-size:11px;font-weight:700;text-align:right;padding:5px 4px">${totSqft ? totSqft.toLocaleString(undefined, { maximumFractionDigits: 0 }) : ''}</td>
          <td colspan="7"></td>
          ${footUsage(totKwh, 'kwh', 'var(--accent)')}
          ${footUsage(totKw, 'kw', 'var(--amber)')}
          ${footUsage(totGas, 'gas', 'var(--teal)')}
          ${footUsage(totPropane, 'propane', 'var(--purple,#a855f7)')}
          ${footCost('kwhCost', totKwhCost)}${footCost('kwCost', totKwCost)}${footCost('gasCost', totGasCost)}${footCost('propaneCost', totPropaneCost)}
          <td class="sv-total-cell sv-foot-total" style="border-left:2px solid var(--border2)">${grandTotal > 0 ? '$' + Math.round(grandTotal).toLocaleString() : '—'}</td>
          <td></td>
        </tr>`;

  // ── Summary card ──
  const annKwh = totKwh.reduce((a, b) => a + b, 0);
  const annKwAvg = totKw.reduce((a, b) => a + b, 0) / 12;
  const annGas = totGas.reduce((a, b) => a + b, 0);
  const annPropane = totPropane.reduce((a, b) => a + b, 0);
  const sc = selMsrs.length;
  const svQtrLabels = ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)'];
  const svQtrHtml =
    grandTotal > 0
      ? svQtrLabels
          .map(
            (lbl, i) =>
              `<div class="bl-qtr-item"><span class="bl-qtr-lbl">${lbl}</span><span class="bl-qtr-val">${svQtrs[i] > 0 ? '$' + Math.round(svQtrs[i]).toLocaleString() : '—'}</span></div>`,
          )
          .join('')
      : '';
  const summaryHtml = sc
    ? `<div class="bl-result">
          <div class="bl-title">💡 Selected Measures — ${p.name} (${sc} measure${sc !== 1 ? 's' : ''})</div>
          <div class="bl-grid">
            <div class="bl-item"><div class="bl-lbl">Annual kWh Savings</div><div class="bl-val" style="color:var(--accent)">${Math.round(annKwh).toLocaleString()}<span class="bl-unit"> kWh/yr</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Avg kW Reduction</div><div class="bl-val" style="color:var(--amber)">${annKwAvg.toFixed(1)}<span class="bl-unit"> kW avg</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Annual Gas Savings</div><div class="bl-val" style="color:var(--teal)">${Math.round(annGas).toLocaleString()}<span class="bl-unit"> Therms/yr</span></div></div>
            <div class="bl-item"><div class="bl-lbl">Annual Propane Savings</div><div class="bl-val" style="color:var(--purple,#a855f7)">${Math.round(annPropane).toLocaleString()}<span class="bl-unit"> Gal/yr</span></div></div>
            <div class="bl-item" style="grid-column:1/-1">
              <div class="bl-lbl">Projected Savings $</div>
              <div class="bl-val" style="color:var(--green)">${grandTotal > 0 ? '$' + Math.round(grandTotal).toLocaleString() : '—'}</div>
              ${svQtrHtml ? `<div class="bl-qtrs">${svQtrHtml}</div>` : ''}
            </div>
          </div>
        </div>`
    : '';

  wrap.innerHTML = `<div style="padding:16px;overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:16px">

          <div class="card">
            <div class="card-hdr" style="flex-wrap:wrap;gap:8px">
              <span class="card-title">💡 Energy Savings Measures</span>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto">
                <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="svToggleAllColGroups(true)">Expand All</button>
                <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="svToggleAllColGroups(false)">Collapse All</button>
                <button class="btn btn-ghost btn-sm" onclick="openCalcTemplates(${projId},'${wrap.id === 'ptab-savings' ? 'ptab' : 'sv'}')">📐 Calc Templates</button>
                <button class="btn btn-ghost btn-sm" onclick="_svAddMeasureFrom(${projId})">+ Add Measure</button>
                <button class="btn btn-em btn-sm" onclick="_svRecalcFrom(${projId})">⚡ Recalc $ Savings</button>
                ${typeof tableZoomControlHTML === 'function' ? tableZoomControlHTML('sv-matrix-wrap-' + projId, 'en_sv_matrix_zoom_' + projId, 'sv-matrix-zoom-lbl-' + projId) : ''}
              </div>
            </div>
            <div id="sv-matrix-wrap-${projId}" style="overflow-x:auto">
              <table class="dtbl sv-matrix-tbl">
                <thead>
                  <tr>
                    <th style="width:20px"></th><th style="width:28px"></th><th style="width:28px">✓</th><th style="width:44px">Msr #</th>
                    <th style="min-width:130px">Building</th><th style="width:74px">Sq Ft</th><th style="min-width:190px">Measure Description</th>
                    <th style="width:54px;font-size:9px;text-align:center">kWh $/S</th><th style="width:54px;font-size:9px;text-align:center">kWh $/W</th>
                    <th style="width:54px;font-size:9px;text-align:center">kW $/S</th><th style="width:54px;font-size:9px;text-align:center">kW $/W</th>
                    <th style="width:54px;font-size:9px;text-align:center">$/Therm</th><th style="width:54px;font-size:9px;text-align:center">$/Gallon</th>
                    ${grpHdr('kwh', '⚡ kWh Savings', 13, 'rgba(59,130,246,0.07)')}
                    ${grpHdr('kw', '⚡ kW Savings', 13, 'rgba(245,158,11,0.07)')}
                    ${grpHdr('gas', '🔥 Gas Therms', 13, 'rgba(20,184,166,0.07)')}
                    ${grpHdr('propane', '🛢️ Propane Gal', 13, 'rgba(168,85,247,0.07)')}
                    ${grpHdr('kwhCost', '💲 kWh $', 13, 'rgba(59,130,246,0.04)')}
                    ${grpHdr('kwCost', '💲 kW $', 13, 'rgba(245,158,11,0.04)')}
                    ${grpHdr('gasCost', '💲 Gas $', 13, 'rgba(20,184,166,0.04)')}
                    ${grpHdr('propaneCost', '💲 Propane $', 13, 'rgba(168,85,247,0.04)')}
                    <th style="border-left:2px solid var(--border2);text-align:center;background:rgba(34,197,94,0.07);min-width:110px">💰 Projected $</th>
                    <th style="width:32px"></th>
                  </tr>
                  <tr>
                    <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
                    <th></th><th></th><th></th><th></th><th></th><th></th>
                    ${moHdrs('kwh')}${moHdrs('kw')}${moHdrs('gas')}${moHdrs('propane')}
                    ${moHdrs('kwhCost')}${moHdrs('kwCost')}${moHdrs('gasCost')}${moHdrs('propaneCost')}
                    <th style="border-left:2px solid var(--border2)"></th>
                    <th style="width:32px"></th>
                  </tr>
                </thead>
                <tbody>${msrRows}</tbody>
                ${hasMeasures ? `<tfoot>${footRow}</tfoot>` : ''}
              </table>
            </div>
            ${emptyStateHtml}
          </div>

          ${summaryHtml}
        </div>`;
  // Apply persisted zoom to savings matrix table
  if (typeof setTableZoom === 'function') {
    requestAnimationFrame(function () {
      setTableZoom('sv-matrix-wrap-' + projId, null, 'en_sv_matrix_zoom_' + projId, 'sv-matrix-zoom-lbl-' + projId);
    });
  }
}

// ── Savings page action handlers ──
function svSaveProjBaselineRates() {
  if (!svSelProjId) return;
  _svSaveRatesFrom(svSelProjId);
}

function _svSaveRatesFrom(pid) {
  const bldgs = getUDBldgs(pid);
  const sd = getProjSavingsData(pid);
  bldgs.forEach((b) => {
    const bid = b.id;
    sd.blRates[bid] = {
      kwhSummer: parseFloat(document.getElementById('sv-blr-kwhs-' + pid + '-' + bid)?.value) || 0,
      kwhWinter: parseFloat(document.getElementById('sv-blr-kwhw-' + pid + '-' + bid)?.value) || 0,
      kwSummer: parseFloat(document.getElementById('sv-blr-kws-' + pid + '-' + bid)?.value) || 0,
      kwWinter: parseFloat(document.getElementById('sv-blr-kww-' + pid + '-' + bid)?.value) || 0,
      thermRate: parseFloat(document.getElementById('sv-blr-therm-' + pid + '-' + bid)?.value) || 0,
      gallonRate: parseFloat(document.getElementById('sv-blr-gallon-' + pid + '-' + bid)?.value) || 0,
    };
  });
  sset('en_projects', projects);
  showToast('Baseline rates saved ✓');
  _svRecalcFrom(pid);
}

function _svAddMeasureFrom(pid) {
  addSavingsMeasure(pid);
  // Re-render whichever view is active
  if (document.getElementById('ptab-savings')?.offsetParent !== null) initSavingsTab(pid);
  else {
    renderSvProjNav();
    renderSvDetail();
  }
}

function _svRecalcFrom(pid) {
  calcProjSavingsMatrix(pid);
  if (document.getElementById('ptab-savings')?.offsetParent !== null) initSavingsTab(pid);
  else renderSvDetail();
}

function svAddMeasure() {
  if (!svSelProjId) return;
  addSavingsMeasure(svSelProjId);
  renderSvProjNav();
  renderSvDetail();
}

function svRemoveMeasure(projId, msrId) {
  const pid = projId || svSelProjId;
  if (!pid) return;
  removeSavingsMeasure(pid, msrId);
  if (document.getElementById('ptab-savings')?.offsetParent !== null) {
    initSavingsTab(pid);
  } else {
    renderSvProjNav();
    renderSvDetail();
  }
}

function svUpdateMsrVal(msrId, type, moIdx, val) {
  if (svSelProjId) updateMsrVal(svSelProjId, msrId, type, moIdx, val);
}
function svUpdateMsrField(msrId, field, val) {
  if (!svSelProjId) return;
  updateMsrField(svSelProjId, msrId, field, val);
  renderSvProjNav();
}
function svUpdateMsrSel(msrId, checked) {
  if (!svSelProjId) return;
  updateMsrSel(svSelProjId, msrId, checked);
  renderSvDetail();
}
function svAutoSave() {
  if (svSelProjId) sset('en_projects', projects);
}

function svToggleDetail(msrId) {
  const row = document.getElementById('sv-detail-' + msrId);
  const tog = document.getElementById('sv-dtog-' + msrId);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  if (tog) tog.classList.toggle('open', !open);
}

function svUpdateMsrRate(msrId, field, val) {
  const pid = svSelProjId || window._activeProjId;
  if (!pid) return;
  const sd = getProjSavingsData(pid);
  const m = sd.measures.find((x) => x.id === msrId);
  if (!m) return;
  if (!m.rates) m.rates = {};
  m.rates[field] = val;
  sset('en_projects', projects);
}

function svResetMsrRates(msrId) {
  const pid = svSelProjId || window._activeProjId;
  if (!pid) return;
  const sd = getProjSavingsData(pid);
  const m = sd.measures.find((x) => x.id === msrId);
  if (!m) return;
  m.rates = calcBldgDefaultRates(pid, m.bldgId);
  sset('en_projects', projects);
  if (document.getElementById('ptab-savings')?.offsetParent !== null) initSavingsTab(pid);
  else renderSvDetail();
  showToast('Rates reset to building defaults ✓');
}

function svRecalc() {
  if (!svSelProjId) return;
  const sd = getProjSavingsData(svSelProjId);
  // Flush DOM values into data model
  sd.measures.forEach((m) => {
    const row = document.getElementById('sv-pg-msr-row-' + m.id);
    if (!row) return;
    ['kwh-col', 'kw-col', 'gas-col', 'propane-col'].forEach((cls, ti) => {
      const type = ['kwh', 'kw', 'gas', 'propane'][ti];
      if (!m[type]) m[type] = Array(12).fill(0);
      row.querySelectorAll('input.' + cls).forEach((inp, i) => {
        m[type][i] = parseFloat(inp.value) || 0;
      });
    });
  });
  // Recalculate dollar totals using baseline rates
  sd.measures.forEach((m) => {
    const rates = m.rates || sd.blRates[m.bldgId] || {};
    let total = 0;
    for (let mo = 0; mo < 12; mo++) {
      const s = SUMMER_MOS.includes(mo);
      total += (m.kwh[mo] || 0) * (s ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
      total += (m.kw[mo] || 0) * (s ? rates.kwSummer || 0 : rates.kwWinter || 0);
      total += (m.gas[mo] || 0) * (rates.thermRate || 0);
      total += ((m.propane || [])[mo] || 0) * (rates.gallonRate || 0);
    }
    m.totalDollar = total;
  });
  sset('en_projects', projects);
  renderSvDetail();
  showToast('Savings recalculated ✓');
}

// ── Contracts per project ──
let _projContractTemplate = {};
function loadDefaultTemplatForProj(projId) {
  const p = projects.find((x) => x.id === projId);
  _projContractTemplate[projId] = DEFAULT_CONTRACT;
  const el = document.getElementById('tmplStatus-' + projId);
  if (el)
    el.innerHTML =
      '<div style="font-size:13px;color:var(--em)">✓ Using generic controls/energy services template</div>';
  renderContractVarsForProj(projId, CONTRACT_VARS, p);
}
function renderContractVarsForProj(projId, vars, p) {
  const card = document.getElementById('contractVarsCard-' + projId);
  const el = document.getElementById('contractVars-' + projId);
  if (!el || !card) return;
  card.style.display = 'block';
  // Pre-fill known values from project
  const prefill = {
    COMPANY_NAME: 'Control Service Company',
    CLIENT_NAME: p?.client || '',
    PROJECT_NAME: p?.name || '',
    PROJECT_ADDRESS: p?.addr || '',
    PM_NAME: p?.pm || '',
    CONTRACT_VALUE: p?.contract ? '$' + Number(p.contract).toLocaleString() : '',
  };
  el.innerHTML = vars
    .map(
      (v) => `
          <div class="cv-row">
            <div class="cv-key">[${v}]</div>
            <input class="cv-inp" id="cv-proj-${projId}-${v}" placeholder="Enter ${v.replace(/_/g, ' ').toLowerCase()}..." value="${prefill[v] || ''}">
          </div>`,
    )
    .join('');
}
async function generateProjContract(projId) {
  const out = document.getElementById('contractOut-' + projId);
  if (!out) return;
  out.innerHTML =
    '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> Generating contract...</div>';
  const tmpl = _projContractTemplate[projId] || DEFAULT_CONTRACT;
  const vars = {};
  document.querySelectorAll(`[id^="cv-proj-${projId}-"]`).forEach((inp) => {
    const k = inp.id.replace(`cv-proj-${projId}-`, '');
    vars[k] = inp.value || `[${k}]`;
  });
  const varList = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const result = await claude(
    `Generate a complete professional client contract using this template and variables.\nTEMPLATE:\n${tmpl}\nVARIABLES:\n${varList}\nReplace all placeholders with the provided values. Make it complete and client-ready.`,
    'You are a contracts specialist for building automation and energy services companies.',
  );
  out.textContent = result;
  showToast('Contract generated ✓');
}

function _projTabAfter(tab) {
  window._activeProjTab = tab;
  saveProjSession();
}
function autoSaveNotes(id, valOverride) {
  const p = projects.find((p) => p.id === id);
  if (p) {
    // valOverride is passed from the merged-dashboard textarea (fix 35571527).
    // Fall back to the standalone notes tab textarea if present.
    if (valOverride !== undefined) {
      p.notes = valOverride;
    } else {
      const el = document.getElementById('proj-notes-ta');
      if (el) p.notes = el.value;
    }
    // Sync both textareas so they stay in agreement
    const ta1 = document.getElementById('proj-notes-ta');
    const ta2 = document.getElementById('proj-notes-ta-dash-' + id);
    if (ta1) ta1.value = p.notes;
    if (ta2) ta2.value = p.notes;
    sset('en_projects', projects);
  }
}
async function deleteProj(id) {
  if (!(await confirmAsync('Delete this project?'))) return;
  // Before removing the project, unassign any saved bills that reference it.
  // This prevents orphaned source records (projId set to a non-existent project)
  // that become invisible to all UI filters and unreachable by any delete path.
  const _projBills = sget('en_pdf_bills', []) || [];
  let _billsChanged = false;
  _projBills.forEach((b) => {
    if (b.projId === id) {
      b.projId = null;
      _billsChanged = true;
    }
  });
  if (_billsChanged) sset('en_pdf_bills', _projBills);
  projects = projects.filter((p) => p.id !== id);
  sset('en_projects', projects);
  renderProjTable();
  renderSidebarFolders();
  showList();
  updateHomeStats();
  showToast('Project deleted');
}

/* ── PROJECTS: MODAL ── */
function openProjModal() {
  document.getElementById('projModalTitle').textContent = '+ New Energy Project';
  document.getElementById('mp-edit-id').value = '';
  [
    'mp-name',
    'mp-client',
    'mp-addr',
    'mp-zip',
    'mp-sqft',
    'mp-pm',
    'mp-tech',
    'mp-sa',
    'mp-contract',
    'mp-savings',
    'mp-start',
    'mp-end',
    'mp-tags',
    'mp-escalation',
    'mp-cscCompensation',
  ].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.value = '';
  });
  if (window._mpNotesQuill) window._mpNotesQuill.setContents([]);
  document.getElementById('mp-status').value = 'planning';
  document.getElementById('mp-phase').value = '';
  document.getElementById('mp-priority').value = 'normal';
  document.getElementById('mp-progress').value = '0';
  _modalContacts = [];
  renderModalContacts();
  document.getElementById('projModal').classList.add('open');
}
function editProj(id) {
  const p = projects.find((p) => p.id === id);
  if (!p) return;
  document.getElementById('projModalTitle').textContent = '✏️ Edit Project';
  document.getElementById('mp-edit-id').value = id;
  const fv = {
    name: p.name,
    client: p.client,
    addr: p.addr,
    zip: p.zip,
    sqft: p.sqft,
    pm: p.pm,
    tech: p.tech,
    sa: p.sa,
    contract: p.contract,
    savings: p.savings,
    start: p.start,
    end: p.end,
    progress: p.progress,
    notes: p.notes,
    tags: p.tags,
    escalation: p.escalation,
    cscCompensation: p.cscCompensation,
  };
  Object.entries(fv).forEach(([k, v]) => {
    if (k === 'notes') return; // handled separately via Quill
    const e = document.getElementById('mp-' + k);
    if (e) e.value = v || '';
  });
  if (typeof initQuillEditor === 'function') {
    if (!window._mpNotesQuill) {
      window._mpNotesQuill = initQuillEditor('mp-notes-editor', p.notes || '');
    } else {
      window._mpNotesQuill.setContents([]);
      if (p.notes) window._mpNotesQuill.clipboard.dangerouslyPasteHTML(p.notes);
    }
  } else {
    var mpEl = document.getElementById('mp-notes-editor');
    if (mpEl) mpEl.textContent = p.notes || '';
  }
  document.getElementById('mp-type').value = p.type || 'K-12 School';
  document.getElementById('mp-coolType').value = p.coolType || '';
  document.getElementById('mp-heatType').value = p.heatType || '';
  document.getElementById('mp-coolEff').value = p.coolEff || '';
  document.getElementById('mp-coolEffUnit').value = p.coolEffUnit || 'kW/Ton';
  document.getElementById('mp-heatEff').value = p.heatEff || '';
  document.getElementById('mp-heatEffUnit').value = p.heatEffUnit || 'AFUE';
  document.getElementById('mp-status').value = p.status || 'planning';
  document.getElementById('mp-baselineComparison').value = p.baselineComparison || 'normalized';
  updateBaselineDesc();
  // Legacy migration (2026-07-26): the "Commissioning" phase option was renamed to
  // "Start-Up & Testing" (wording cleanup, no service-scope change). Map any project saved
  // with the old value so the dropdown still shows the equivalent selection instead of going
  // blank -- a blank select would silently wipe the field back to '' on the next Save Project.
  document.getElementById('mp-phase').value = p.phase === 'Commissioning' ? 'Start-Up & Testing' : p.phase || '';
  document.getElementById('mp-priority').value = p.priority || 'normal';
  // Load contacts — support legacy single-contact projects too
  if (p.contacts && p.contacts.length) {
    _modalContacts = p.contacts.map((c) => ({ ...c }));
  } else if (p.contact) {
    _modalContacts = [
      { id: 'c' + Date.now(), title: '', first: p.contact, last: '', phone: p.phone || '', email: p.email || '' },
    ];
  } else {
    _modalContacts = [];
  }
  renderModalContacts();
  document.getElementById('projModal').classList.add('open');
}
const baselineDescs = {
  normalized:
    'Adjusts for weather using heating/cooling degree days (ASHRAE Guideline 14). Shows whether savings come from real efficiency improvements, not just milder weather.',
  actual: 'Compares current bills against the baseline using raw costs and usage as they appear on the bill.',
};
function updateBaselineDesc() {
  const val = document.getElementById('mp-baselineComparison').value;
  const el = document.getElementById('mp-baselineDesc');
  if (el) el.textContent = baselineDescs[val] || '';
}

function confirmAsync(msg) {
  if (window._confirmResolve) {
    window._confirmResolve(false);
  }
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmModalMsg').textContent = msg;
    modal.classList.add('open');
    window._confirmResolve = (val) => {
      modal.classList.remove('open');
      window._confirmResolve = null;
      resolve(val);
    };
  });
}

function closeProjModal() {
  document.getElementById('projModal').classList.remove('open');
}
function saveProject() {
  const name = document.getElementById('mp-name').value.trim();
  if (!name) {
    showToast('Enter a project name');
    return;
  }
  const editId = document.getElementById('mp-edit-id').value;
  // Set legacy fields from first contact for backwards compat
  const fc = _modalContacts[0];
  const fields = {
    name,
    client: document.getElementById('mp-client').value,
    addr: document.getElementById('mp-addr').value,
    zip: (document.getElementById('mp-zip')?.value || '').trim(),
    type: document.getElementById('mp-type').value,
    sqft: parseInt(document.getElementById('mp-sqft').value) || 0,
    coolType: document.getElementById('mp-coolType').value,
    heatType: document.getElementById('mp-heatType').value,
    coolEff: parseFloat(document.getElementById('mp-coolEff').value) || 0,
    coolEffUnit: document.getElementById('mp-coolEffUnit').value,
    heatEff: parseFloat(document.getElementById('mp-heatEff').value) || 0,
    heatEffUnit: document.getElementById('mp-heatEffUnit').value,
    status: document.getElementById('mp-status').value,
    phase: document.getElementById('mp-phase').value,
    pm: document.getElementById('mp-pm').value,
    tech: document.getElementById('mp-tech').value,
    sa: document.getElementById('mp-sa').value.trim(),
    contacts: [..._modalContacts],
    contact: fc ? (fc.first + ' ' + fc.last).trim() : '',
    phone: fc ? fc.phone : '',
    email: fc ? fc.email : '',
    contract: parseFloat(document.getElementById('mp-contract').value) || 0,
    savings: parseFloat(document.getElementById('mp-savings').value) || 0,
    baselineComparison: document.getElementById('mp-baselineComparison').value || 'normalized',
    escalation:
      document.getElementById('mp-escalation').value.trim() === ''
        ? null
        : parseFloat(document.getElementById('mp-escalation').value) || 0,
    cscCompensation: parseFloat(document.getElementById('mp-cscCompensation').value) || 0,
    start: document.getElementById('mp-start').value,
    end: document.getElementById('mp-end').value,
    progress: Math.max(0, Math.min(100, parseInt(document.getElementById('mp-progress').value) || 0)),
    priority: document.getElementById('mp-priority').value,
    notes:
      typeof getQuillHTML === 'function' && window._mpNotesQuill
        ? getQuillHTML(window._mpNotesQuill)
        : document.getElementById('mp-notes-editor')
          ? document.getElementById('mp-notes-editor').textContent
          : '',
    tags: document.getElementById('mp-tags').value,
  };
  if (editId) {
    const idx = projects.findIndex((p) => p.id == editId);
    if (idx > -1) projects[idx] = { ...projects[idx], ...fields };
    showToast(name + ' updated ✓');
    const p = projects.find((p) => p.id == editId);
    if (p && document.getElementById('projDetailView').style.display !== 'none') renderDetail(p);
  } else {
    if (projects.some((p) => p.name === name && p.id !== editId)) {
      showToast(name + ' already exists');
      return;
    }
    projects.push({ id: Date.now(), ...fields });
    showToast(name + ' created ✓');
  }
  sset('en_projects', projects);

  // Propagate project-level escalation to buildings without a custom override
  if (fields.escalation != null) {
    const projId = editId ? parseInt(editId) : projects[projects.length - 1].id;
    const bldgs = (utilityData[projId] || {}).buildings || [];
    bldgs.forEach((b) => {
      const bpKey = 'bldgperf_cfg_' + (b.id || b.name);
      const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
      try {
        const bpCfg = DB.get(bpKey, {});
        if (!bpCfg._customEsc) {
          bpCfg.escPct = fields.escalation;
          DB.set(bpKey, bpCfg);
        }
      } catch (e) {}
      try {
        const bspCfg = DB.get(bspKey, {});
        if (!bspCfg._customEsc) {
          bspCfg.escPct = fields.escalation;
          DB.set(bspKey, bspCfg);
        }
      } catch (e) {}
    });
  }

  // Propagate project-level CSC compensation to buildings without a custom override
  if (fields.cscCompensation != null) {
    const projId = editId ? parseInt(editId) : projects[projects.length - 1].id;
    const bldgs = (utilityData[projId] || {}).buildings || [];
    bldgs.forEach((b) => {
      const bpKey = 'bldgperf_cfg_' + (b.id || b.name);
      const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
      try {
        const bpCfg = DB.get(bpKey, {});
        if (!bpCfg._customCsc) {
          bpCfg.cscPct = fields.cscCompensation;
          DB.set(bpKey, bpCfg);
        }
      } catch (e) {}
      try {
        const bspCfg = DB.get(bspKey, {});
        if (!bspCfg._customCsc) {
          bspCfg.cscPct = fields.cscCompensation;
          DB.set(bspKey, bspCfg);
        }
      } catch (e) {}
    });
  }

  closeProjModal();
  renderProjTable();
  renderSidebarFolders();
  refreshProjDropdowns();
  updateHomeStats();
}

/* ── SIDEBAR FOLDERS ── */
function getFacilityIcon(type) {
  const t = (type || '').toLowerCase();
  if (
    t.includes('k-12') ||
    t.includes('school') ||
    t.includes('district') ||
    t.includes('education') ||
    t.includes('elementary') ||
    t.includes('middle') ||
    t.includes('high school')
  )
    return '🏫';
  if (t.includes('college') || t.includes('university')) return '🎓';
  if (t.includes('hospital') || t.includes('health')) return '🏥';
  if (t.includes('office')) return '🏢';
  if (t.includes('warehouse') || t.includes('industrial')) return '🏭';
  if (t.includes('retail')) return '🏪';
  if (t.includes('municipal') || t.includes('government')) return '🏛️';
  if (t.includes('data center')) return '🖥️';
  if (t.includes('apartment') || t.includes('residential')) return '🏘️';
  if (t.includes('hotel') || t.includes('hospitality')) return '🏨';
  if (t.includes('lab') || t.includes('laboratory')) return '🔬';
  if (t.includes('airport') || t.includes('transit')) return '✈️';
  return '🏢';
}
function toggleProjSection(e) {
  if (e) e.stopPropagation();
  projSectionOpen = !projSectionOpen;
  const sec = document.getElementById('sidebarProjFolders');
  const btn = document.getElementById('projCollapseBtn');
  if (sec) sec.classList.toggle('collapsed', !projSectionOpen);
  if (btn) btn.classList.toggle('collapsed', !projSectionOpen);
}
function renderSidebarFolders() {
  // Also refresh utility project list if it's loaded
  if (document.getElementById('udNavList')) renderUDProjList();
  const c = document.getElementById('sidebarProjFolders');
  if (!c) return;
  if (!projects.length) {
    c.innerHTML = '';
    return;
  }
  c.innerHTML = projects
    .map((p) => {
      const pt = tasks.filter((t) => t.projId === p.id && !t.done).length;
      const nm = p.name.length > 22 ? p.name.slice(0, 22) + '…' : p.name;
      const icon = getFacilityIcon(p.type);
      return `<button class="spfi" data-pid="${p.id}" onclick="openDetail(${p.id})">
            <span class="spfi-icon">${icon}</span>
            <span class="spfi-name" title="${p.name}">${nm}</span>
            ${pt > 0 ? `<span class="spfi-badge">${pt}</span>` : ''}
          </button>`;
    })
    .join('');
}

/* ── DROPDOWNS ── */
function refreshProjDropdowns() {
  ['mt-proj', 'pdfProjSel'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML =
      '<option value="">— General —</option>' +
      projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    el.value = cur;
  });
}

/* ── PDF OCR — LOCAL EXTRACTION ENGINE ──
         Utility bills: 100% local rule-based extraction.
         1) PDF.js extracts raw text in-browser
         2) Regex rules match known utility formats
         3) If matched → extract and display
         4) If unrecognized → prompt user to share sample
      ── */
// ── Evergy Billing Details — expected charge line ordering ──
// Reference: Evergy bills always list charges in this order after "Billing Details":
//  1. Customer Charge — always line 1
//  2. Facilities Charge — always line 2, per kW
//  3. Demand Charge — always line 3 (may split onto 2 lines during summer/winter changeover
//     if billing period includes changeover dates: Kansas uses 5/30 and 9/30, Missouri uses 5/15 and 9/15)
//  4. Energy charges — format depends on bill date:
//     BEFORE 12/21/2023 (Kansas): 3-tier Energy Charges
//       - First 180 hours of usage
//       - Next 180 hours of usage
//       - Anything over 360 hours of usage
//     AFTER 12/21/2023 (Kansas): On/Off Peak Energy Charges
//       - Energy Chg On Pk (summer: "Sum", winter: "Win")
//       - Energy Chg Off Pk (summer: "Sum", winter: "Win")
//  5. Energy Charge Off Peak — next after On Peak (shifted down if Demand split)
//  6. RkVA Charge — below Energy Charges
//  7. Tax Exempt Delivery — below Energy or RkVA
//  8. ECA Charge
//  9. EER Charge
// 10. PTS Charge
// 11. TDC Charge
// 12. Bill Offset
// 13. Subtotal
// 14. Tax / Fee (Franchise Fee)
// 15. Current Charges — always last line
const _EVG_CHARGE_ORDER = [
  'CustomerCharge',
  'FacilitiesCharge',
  'BilledKWCharge',
  'EnergyOnPeakCharge',
  'EnergyOffPeakCharge',
  'RkVACharge',
  'TaxExemptDelivery',
  'ECACharge',
  'EERCharge',
  'PTSCharge',
  'TDCCharge',
  'BillOffset',
  'FranchiseFee',
];
// Evergy per-section extractor
function _extractEvergy(t, acctOverride, addrOverride) {
  const _pf = (v) => (v ? parseFloat(String(v).replace(/[$,\s]/g, '')) || 0 : 0);
  // ── OCR digit cleanup: replace 'o'/'O' with '0' in numeric contexts ──
  t = t.replace(/(\d)o/gi, '$10').replace(/o(\d)/gi, '0$1');

  // ── Multi-bill scoping: if text has multiple Billing Details sections, scope to target account ──
  if (acctOverride) {
    const bdMarkers = [];
    const bdRe = /Billing\s+Details\s*[-\u2013]\s*service\s+from/gi;
    let m;
    while ((m = bdRe.exec(t)) !== null) bdMarkers.push(m.index);
    // Only scope if markers belong to DIFFERENT bills. Historically that
    // only meant "different dates" (rate-changeover same-bill sections
    // share dates and must NOT be scoped apart). cf3f0b8d Fix B
    // (defense-in-depth): also scope when dates MATCH but the ACCOUNT
    // NUMBER differs \u2014 two different buildings whose billing periods
    // happen to coincide can still end up concatenated into one section
    // by an upstream page-partition mistake that the primary boundary
    // guard (page-partition content check, ~line 4579) didn't catch (e.g.
    // a different OCR account-line garble than the one that guard knows
    // about). Without this, every xChg()/.match() call below would keep
    // summing/matching across both buildings' charge lines. Same-date,
    // same-or-unresolvable-account markers are still treated as one bill
    // (unchanged behavior for the legitimate rate-changeover case).
    const _sf = /[s5]erv[il1]ce\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/i;
    const bdDates = bdMarkers.map((idx) => {
      const dm = t.slice(idx, idx + 200).match(_sf);
      return dm ? dm[1] + '|' + dm[2] : null;
    });
    const uniqueDates = new Set(bdDates.filter(Boolean));
    const secStarts = bdMarkers.map((idx) => {
      const before = t.slice(Math.max(0, idx - 500), idx);
      // Find LAST "Customer Name" before this Billing Details (closest to it)
      let cnIdx = -1;
      const cnRe = /Customer\s*Name/gi;
      let cm;
      while ((cm = cnRe.exec(before)) !== null) cnIdx = cm.index;
      return cnIdx >= 0 ? Math.max(0, idx - 500) + cnIdx : Math.max(0, idx - 200);
    });
    const _acctHeaderRe = /[Aa]ccount\s+(?:N[ou]mber\s*)?[:\s\u00a9\u00ae=]\s*[(\[\u00a9]?(\d[\d ]{4,18}\d)/;
    const bdAccts = bdMarkers.map((idx, s) => {
      const header = t.slice(secStarts[s], idx);
      const am = header.match(_acctHeaderRe);
      return am ? am[1].replace(/\s/g, '') : null;
    });
    const uniqueAccts = new Set(bdAccts.filter(Boolean));
    if (bdMarkers.length > 1 && (uniqueDates.size > 1 || uniqueAccts.size > 1)) {
      for (let s = 0; s < bdMarkers.length; s++) {
        const header = t.slice(secStarts[s], bdMarkers[s]);
        if (header.includes(acctOverride)) {
          const start = secStarts[s];
          const end = s + 1 < secStarts.length ? secStarts[s + 1] : t.length;
          t = t.slice(start, end);
          break;
        }
      }
    }
  }

  const sum = (t, re) => {
    const ms = [...t.matchAll(re)];
    return ms.length ? ms.reduce((s, m) => s + parseFloat(m[1].replace(/,/g, '')), 0).toFixed(2) : null;
  };
  const chg = (re) => t.match(re)?.[1]?.replace(/,/g, '') || null;

  // ── Charge extractor ──────────────────────────────────────────────────────────
  // PDF.js merges left-column chart text with right-column charge lines at the same
  // y-coordinate, so end-of-line anchors break. This function handles all layouts:
  //   • "Customer Chg ..... $105.97"              (dollar on keyword line)
  //   • "210000 Demand Chg ... $3,105.46"          (chart number prefix)
  //   • "Energy Chg ... kWh at $0.06407\n140000 per kWh ... $5,512.40"  (2-line)
  //   • "ECA Chg ... for\nJul Aug ... kWh ... $158.97"  (chart label injected mid)
  //   • "$2,027.18 Period kWh Days..."            (chart cols appended after dollar)
  //   • "CUSIOMET CNG ..... $105.97"              (OCR garbled keyword)
  //   • "Facilities Ghg ... $1,394.55"            (OCR letter swap)
  // Strategy: for each keyword line, take the last $X.XX that is NOT a rate.
  // Uses very loose OCR-tolerant patterns that handle common letter swaps.
  const CHG_STOP = /(?:Cust|Fac\S|Demand|Energy\s+C|\bECA|\bEER|\bPTS|\bTD[CG]|\bRkVA|Subtotal|Current\s+Charges)/i;
  // Line-anchored variant of CHG_STOP — matches when a new charge starts the line
  // (after optional chart-column numbers / leading whitespace). Used to stop block
  // building without being fooled by continuation lines that merely contain "per kW".
  // The full CHG_STOP plus a "per kW" exemption previously let RkVA Chg lines be
  // absorbed into the preceding Energy Off Pk block, corrupting the rate match.
  // NEXT_CHG_LINE detects when a line belongs to a DIFFERENT charge, so we stop
  // building the block. OCR often prepends garbage (chart Y-axis numbers, stray
  // letters) before the actual charge keyword, so we check if the charge keyword
  // pattern appears ANYWHERE in the line, not just at the start.
  // Pattern: ChargeKeyword + separator + "Chg" variant
  const NEXT_CHG_LINE =
    /(?:Cust(?:omer)?|Fac(?:ilities)?|Demand|Energy|ECA|EER|PTS|TD[CG]|R[kK]VA|Subtotal|Current\s+Charges)[\s.]+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])/i;
  const getAmt = (line) => {
    const ms = [...line.matchAll(/\$([\d,]+\.\d{2})/g)];
    let best = null;
    for (const m of ms) {
      const before = line.slice(Math.max(0, m.index - 4), m.index);
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
      if (/at\s*$/.test(before)) continue; // skip rate: "kWh at $0.06407"
      if (/\s*[Pp][eo]r\s+k/i.test(after)) continue; // skip rate: "$2.577 per kW" / OCR "Por kW"
      // Skip small values that look like rates (under $1, with 4+ decimal digits in original)
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val < 1 && /\.\d{3,}/.test(m[1])) continue; // skip rates like $0.03288, $0.00085
      best = parseFloat(m[1].replace(/,/g, ''));
    }
    return best;
  };
  const _xChgParts = {};
  const xChg = (keyword, excludeRe, _partsKey) => {
    const lines = t.split('\n');
    let total = 0,
      found = false;
    const parts = [];
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(keyword, 'i').test(lines[i])) continue;
      if (excludeRe && excludeRe.test(lines[i])) continue;
      const a = getAmt(lines[i]);
      if (a !== null) {
        total += a;
        parts.push(a);
        found = true;
      } else {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const l = lines[j];
          if (NEXT_CHG_LINE.test(l)) break;
          const ja = getAmt(l);
          if (ja !== null) {
            total += ja;
            parts.push(ja);
            found = true;
            break;
          }
        }
      }
    }
    if (_partsKey && parts.length > 1) _xChgParts[_partsKey] = parts;
    return found ? total.toFixed(2) : null;
  };
  // ── Table-bleed strip, opt-in only (see `enableTableBleedFix` param below) ──
  // Evergy prints a "Comparative Usage Information" graphic (title / Period
  // header row / Current row / Previous row / Last Year row = 5 lines) as a
  // sidebar box. On some page layouts PDF text extraction merges this box's
  // text into the SAME visual rows as a charge's continuation lines,
  // injecting 60-150+ chars of column-padding text between the qty and the
  // "kWh/kW at $rate" text -- far beyond the 40-char GAP budget below --
  // even though both the qty and the rate are correctly OCR'd elsewhere in
  // the same 5-line window (confirmed on the EER line of the Evergy Maint
  // Bldg bill, account <REDACTED-ACCT>, April 2026 -- see dashboardlogic entry).
  //
  // "Comparative Usage Information" itself is a STABLE, verbatim marker
  // (unmangled by OCR across every sample bill), unlike the row labels
  // "Current"/"Previous"/"Last Year" which OCR mangles differently every
  // time (e.g. "Curent", "purrent", or the unrecognizable "tyes:" for "Last
  // Year"). So instead of pattern-matching the fragile row-label words, this
  // uses the stable title to POSITIONALLY identify exactly which 5 lines
  // belong to the table (title + 4 rows) and only touches text inside that
  // bounded window.
  //
  // Within the window, each line is reduced to whatever sits at/after its
  // own "resume trigger": a qty tightly bound to "kWh/kW at $" (the
  // strongest signal -- rejects an unrelated decimal, like a garbled
  // "kWh/day" column value, that isn't actually adjacent to "at $"), a bare
  // "kWh/kW at $" (for header rows where the qty lives on a different
  // line), or a new charge keyword. A window line with neither a resume
  // trigger nor a "$" amount is pure noise (a label+cell row with nothing
  // usable) and is dropped entirely. This never deletes a qty or rate that
  // was actually present -- it only removes text that was already
  // unusable/ignored -- so it cannot manufacture a wrong number, unlike a
  // blanket GAP increase or a blanket whitespace collapse (both tried and
  // rejected during investigation of item 5129e92f: a blanket collapse
  // shrank the gap around an UNRELATED decimal on the Last Year row of a
  // sibling bill enough to falsely match it as the qty, dropping that
  // bill's correct EER match entirely).
  //
  // NOT enabled for every caller: a field with an existing `_rates[field]`
  // entry is treated as fully verified downstream (bill-analysis.js
  // Strategy C, `_postExtractionVerify`), even if that entry only captured
  // ONE of several rate tiers. On this bill ECA's first tier is completely
  // invisible to OCR (a separate bar-chart-label bleed with zero "ECA" text
  // -- xChg can't even find it), so populating `_rates.ECACharge` from the
  // second tier alone would make ECACharge look "verified" and block
  // Strategy C's total-residual recovery of the missing first tier. Confirmed
  // empirically: enabling this for ECA drops Strategy C's `unverified` list
  // to length 0 (gate requires exactly 1) and the Sum Mismatch is never
  // corrected. Enabling it ONLY for EER (a single-tier charge on this rate
  // schedule) leaves `unverified === ['ECACharge']`, so Strategy C fires and
  // resolves the mismatch via the total-residual formula. See
  // dashboardlogic.md for the full writeup. Only opt in a charge type here
  // after confirming (via a Strategy C simulation, not just "does it parse")
  // that doing so won't suppress a residual-based correction elsewhere.
  const TABLE_MARKER = /Comparative\s+Usage\s+Information/i;
  const TABLE_RESUME_RE = new RegExp(
    '(?:[0-9,]+[.:][0-9]{2,}\\s*k[Ww]h?\\s+at\\s+\\$)' + // qty tightly bound to "kWh/kW at $"
      '|(?:k[Ww]h?\\s+at\\s+\\$)' + // bare "kWh/kW at $" (qty lives elsewhere in the block)
      '|(?:(?:ECA|EER|PTS|TD[CG]|R[kK]VA|Cust(?:omer)?|Fac(?:ilities)?|Demand|Energy)[\\s.]+' +
      '(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9]))', // a new charge keyword starting on this line
    'i',
  );
  const _cleanTableWindowLine = (line) => {
    const rm = line.match(TABLE_RESUME_RE);
    if (rm) return line.slice(rm.index);
    if (!/\$/.test(line)) return ''; // pure table-noise row -- nothing usable, drop it
    return line; // has a $ but no recognized resume trigger -- leave untouched (fail safe)
  };
  // ── Rate extraction: captures rate, quantity, AND OCR'd charge from each charge line ──
  // Evergy charge lines: "[keyword] [qty] kW/kWh at $[rate] per kW/kWh ... $[charge]"
  // Returns {qty, rate, unit, computed, parts[]} or null
  // Each part: {qty, rate, unit, computed, ocrCharge}
  const xRate = (keyword, excludeRe, enableTableBleedFix) => {
    let lines = t.split('\n');
    if (enableTableBleedFix) {
      lines = lines.slice();
      for (let li = 0; li < lines.length; li++) {
        if (TABLE_MARKER.test(lines[li])) {
          for (let w = li; w < Math.min(li + 5, lines.length); w++) {
            lines[w] = _cleanTableWindowLine(lines[w]);
          }
        }
      }
    }
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(keyword, 'i').test(lines[i])) continue;
      if (excludeRe && excludeRe.test(lines[i])) continue;
      // Look for "qty kW/kWh at $rate" pattern on this line and next few lines
      // Allow stray OCR characters (single digits, punctuation) between qty and unit
      // e.g. "578.7840 3\nKW at $2.68601" → block becomes "578.7840 3 KW at $2.68601"
      // Also handle chart Y-axis numbers between "at" and the actual rate:
      // e.g. "27,170.0880 kWh at 140000 — $0.07299 per kWh" → skip 140000, use $0.07299
      // IMPORTANT: Stop block when the NEXT line starts a new charge (RkVA/TDC/etc).
      // NEXT_CHG_LINE is line-anchored — a continuation line containing "$0.03288 per
      // kWh" won't match (it starts with chart numbers or garbage, not a charge name),
      // but a line that starts with "RkVA Chg ..." or "TDC Chg ..." will match and
      // stop the block so off-peak rate extraction can't bleed into it.
      const blockLines = [lines[i]];
      for (let bi = i + 1; bi < Math.min(i + 4, lines.length); bi++) {
        const chgMatch = lines[bi].match(NEXT_CHG_LINE);
        if (chgMatch) {
          // Line contains a new charge keyword. Include content BEFORE the keyword
          // (e.g., "$3,547.44 RkVA Chg..." → keep "$3,547.44 " for previous charge)
          const prefixEnd = lines[bi].indexOf(chgMatch[0]);
          if (prefixEnd > 0) {
            blockLines.push(lines[bi].substring(0, prefixEnd));
          }
          break;
        }
        blockLines.push(lines[bi]);
      }
      const block = blockLines.join(' ');
      // Qty pattern: accept either `.` or `:` as the decimal separator. Tesseract
      // occasionally misreads `113,763.4729` as `113,763:4729` when the dot pixel
      // is near a tall character above it, and before this fallback the regex
      // silently dropped the entire rate part (e.g. the second tier of a seasonal
      // ECA charge), leaving `_rates.ECACharge` missing half the total.
      const QTY_RE = '([0-9,]+[.:][0-9]{2,}|[0-9]{1,3}(?:,[0-9]{3})+,[0-9]{4,})';
      // Gap between qty and unit: allow up to ~40 chars of OCR garbage (stray letters,
      // chart Y-axis numbers, padded whitespace, line-break artifacts). Real data has
      // just whitespace, but degraded OCR injects characters like
      // "475.5360                        i\nKW at $2.68601" (24 spaces + stray 'i' +
      // newline-as-space = 26 chars). 40 leaves headroom for worse cases without
      // risking a cross-charge match, since xRate's block is already bounded to 4 lines
      // and stops on NEXT_CHG_LINE.
      const GAP = '[\\u0000-\\uFFFF]{0,40}?';
      // Pattern priority: try kWh patterns first to avoid cross-charge aliasing.
      // When Off-Peak kWh rate has junk between "at" and "$", the direct pattern
      // can match a kW rate from RkVA/TDC that got included in the block. By
      // trying kWh-specific patterns first, we correctly match the kWh charge.
      let rateM = null;
      // 1. kWh with junk + "per kWh" confirmation (most reliable for Energy charges)
      rateM = block.match(
        new RegExp(
          QTY_RE + GAP + 'k([Ww]h)[ \\t]+at[ \\t]+[\\u0000-\\uFFFF]*?[$]([0-9,.]+)[ \\t]*p[eo]r[ \\t]+k[Ww]h',
          'i',
        ),
      );
      // 2. kWh direct (no junk between at and $)
      if (!rateM) {
        rateM = block.match(new RegExp(QTY_RE + GAP + 'k([Ww]h)[ \\t]+at[ \\t]+[$]([0-9,.]+)', 'i'));
      }
      // 3. kW with junk + "per kW" confirmation (for demand charges)
      if (!rateM) {
        rateM = block.match(
          new RegExp(
            QTY_RE + GAP + 'k([Ww])[ \\t]+at[ \\t]+[\\u0000-\\uFFFF]*?[$]([0-9,.]+)[ \\t]*p[eo]r[ \\t]+k[Ww]',
            'i',
          ),
        );
      }
      // 4. kW direct (no junk)
      if (!rateM) {
        rateM = block.match(new RegExp(QTY_RE + GAP + 'k([Ww])[ \\t]+at[ \\t]+[$]([0-9,.]+)', 'i'));
      }
      // 5. Last resort: any unit with junk (no "per" required)
      if (!rateM) {
        rateM = block.match(new RegExp(QTY_RE + GAP + 'k([Ww]h?)[ \\t]+at[\\u0000-\\uFFFF]*?[$]([0-9,.]+)', 'i'));
      }
      if (rateM) {
        // Normalize `:` → `.` so `113,763:4729` parses as `113763.4729`.
        // Also fix OCR misread decimal-as-comma: `107,890,4880` → `107890.4880`
        // Only apply when there's NO real decimal point already in the string —
        // if a period exists, all commas are thousands separators.
        let qtyStr = rateM[1].replace(':', '.');
        const hasDot = qtyStr.includes('.');
        const lastSep = qtyStr.lastIndexOf(',');
        if (!hasDot && lastSep >= 0 && qtyStr.length - lastSep - 1 >= 4) {
          qtyStr = qtyStr.slice(0, lastSep).replace(/,/g, '') + '.' + qtyStr.slice(lastSep + 1);
        } else {
          qtyStr = qtyStr.replace(/,/g, '');
        }
        const qty = parseFloat(qtyStr);
        const rate = parseFloat(rateM[3].replace(/,/g, ''));
        const unit = 'k' + rateM[2];
        // Sanity: Evergy rates are < $100/kW and < $1/kWh. Values like 70000 or 140000
        // are chart Y-axis numbers merged into charge lines by PDF text extraction.
        const isKwh = unit.toLowerCase().includes('h');
        const maxRate = isKwh ? 1 : 100; // kWh < $1, kW < $100
        // Tight qty ceiling: kW almost never exceeds 9,999.9999; kWh almost never exceeds 999,999.9999
        // for a single charge line on a monthly bill. Anything larger is OCR garble or chart Y-axis.
        const maxQty = isKwh ? 1000000 : 10000;
        let adjRate = rate;
        // Fix OCR-dropped decimal: $2079 → $2.079, $3069 → $3.069
        if (adjRate >= maxRate && !isKwh) {
          // Try inserting decimal after first digit
          const rStr = rateM[3].replace(/,/g, '');
          const fixed = rStr[0] + '.' + rStr.slice(1);
          const fixedRate = parseFloat(fixed);
          if (fixedRate > 0 && fixedRate < maxRate) adjRate = fixedRate;
        }
        // Sanity: qty × rate should be in the ballpark of the OCR charge.
        // If computed is < 1% of the OCR charge, the qty was likely garbled
        // (e.g. 15.06 instead of 15,060 — parsed comma as decimal).
        const _ocrChargeM = block.match(/\$([\d,]+\.\d{2})\s*$/m);
        const _ocrChargeVal = _ocrChargeM ? parseFloat(_ocrChargeM[1].replace(/,/g, '')) : 0;
        const _computedCheck = qty * adjRate;
        const _qtyChargeRatioOk = !_ocrChargeVal || _ocrChargeVal < 1 || _computedCheck / _ocrChargeVal > 0.1;
        if (
          !isNaN(qty) &&
          !isNaN(adjRate) &&
          adjRate >= 0 &&
          adjRate < maxRate &&
          qty > 0 &&
          qty < maxQty &&
          _qtyChargeRatioOk
        ) {
          // Detect proration: "(for N of Y days)" applies a fraction to the computed charge.
          // Example: 304.2 kW × $11.683 × (29/31) = $3,324.68. Parens may be garbled by OCR.
          // STRICTLY kW-only — same rationale as the date-range proration gate below.
          // On Evergy LGS tiered-kWh bills (ECA, EER, PTS, EnergyOn/OffPeak), each part's
          // qty is ALREADY the segment's kWh used, NOT the whole-period kWh. Applying an
          // N/Y day ratio to a segment whose qty was already proportional to the segment's
          // days double-deflates computed (9530.679 × 0.01668 × (2/32) = 9.94 instead of
          // the correct 158.97 for Bill 1 ECA part 0). The Update 77 hotfix gated the
          // date-range branch but missed this "for N of Y days" branch — same fix applies.
          let prorationRatio = 1;
          let prorationNum = null;
          let prorationDen = null;
          const prM = block.match(/for\s+(\d{1,3})\s+of\s+(\d{1,3})\s+d/i);
          if (prM && !isKwh) {
            const n = parseInt(prM[1], 10);
            const y = parseInt(prM[2], 10);
            if (n > 0 && y > 0 && n <= y && y <= 366) {
              prorationRatio = n / y;
              prorationNum = n;
              prorationDen = y;
            }
          }
          // ── DATE-RANGE PRORATION (kW-charges only) ──
          // Evergy kW-based charge lines (TDC, Facilities, Demand, RkVA) can be split
          // across two date ranges when the rate changes mid-period. Both parts carry
          // the SAME qty (the period's peak kW) but different rates, and the billed
          // amount is the full rate × qty prorated by (range days / total bill days).
          // Example from Bill 23 (LHS.pdf pages 50-51):
          //   "TDC Chg 04-30-2025-04-30-2025 for 529.4400 kW at $2.46781 per kW" → 1/30
          //   "TDC Chg 05-01-2025-05-29-2025 for 529.4400 kW at $2.68729 per kW" → 29/30
          // kWh-based charges (ECA, EER, PTS, Energy On/Off Peak) also use date ranges,
          // but those describe WHICH kWh fall in each rate tier — each part already has
          // its own per-tier qty (NOT the whole-period qty), so prorating would double-
          // deflate the computed values. Strictly gate this to unit='kW' so kWh charges
          // pass through unprorated and their computed values equal qty × rate directly.
          const _isKwUnit = !unit.toLowerCase().includes('h');
          if (prorationNum === null && _isKwUnit) {
            const drM = block.match(/\b(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{4})\b/);
            if (drM) {
              try {
                const totalDays = parseInt(numDays, 10);
                if (totalDays > 0) {
                  const startD = new Date(parseInt(drM[3]), parseInt(drM[1]) - 1, parseInt(drM[2]));
                  const endD = new Date(parseInt(drM[6]), parseInt(drM[4]) - 1, parseInt(drM[5]));
                  const rangeDays = Math.round((endD - startD) / 86400000) + 1; // inclusive
                  if (rangeDays > 0 && rangeDays <= totalDays + 1) {
                    prorationRatio = rangeDays / totalDays;
                    prorationNum = rangeDays;
                    prorationDen = totalDays;
                  }
                }
              } catch (e) {}
            }
          }
          // Also capture the OCR'd dollar charge from this line
          let ocrCharge = getAmt(lines[i]);
          if (ocrCharge === null) {
            // Check next few lines for the charge amount
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
              ocrCharge = getAmt(lines[j]);
              if (ocrCharge !== null) break;
              if (CHG_STOP.test(lines[j])) break;
            }
          }
          const entry = {
            qty,
            rate: adjRate,
            unit,
            computed: Math.round(qty * adjRate * prorationRatio * 100) / 100,
            ocrCharge,
          };
          if (prorationNum !== null) {
            entry.prorationNum = prorationNum;
            entry.prorationDen = prorationDen;
          }
          results.push(entry);
        }
      }
    }
    if (!results.length) return null;
    // Aggregate the parts array into a single rate info object.
    // kWh charges: parts represent portions of the same total period (seasonal split,
    // prorated days) and SUM to the full-month kWh.
    // kW charges: parts can represent DIFFERENT per-period kW values on rate changeover or
    // meter change bills. They are NOT additive — each is charged separately at its own
    // rate. The representative "bill period peak" is MAX of parts.
    const aggIsKwh = (results[0].unit || '').toLowerCase().includes('h');
    const aggQty = aggIsKwh ? results.reduce((s, r) => s + r.qty, 0) : Math.max(...results.map((r) => r.qty));
    return {
      qty: aggQty,
      rate: results[0].rate,
      unit: results[0].unit,
      computed: results.reduce((s, r) => s + r.computed, 0),
      parts: results,
    };
  };
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Billing period (OCR-tolerant) ──
  const bpMatch =
    t.match(_EVG_SERVICE_FROM) ||
    t.match(/service\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/i);
  // Calculate days from billing dates (not from meter read table which may be a sub-period)
  let numDays = null;
  if (bpMatch) {
    try {
      const s = new Date(bpMatch[1]),
        e = new Date(bpMatch[2]);
      numDays = String(Math.round((e - s) / (1000 * 60 * 60 * 24)));
    } catch (ex) {}
  }

  // ── Meter read table (supports multi-row: meter changes and solar net metering) ──
  // Format: StartDate EndDate Days EndRead(-) StartRead(=) Diff (x)Mult (=)kWhUsed KWUsed RKVAUsed
  // Groups: [1]StartDate [2]EndDate [3]Days [4]EndRead [5]StartRead [6]Difference [7]Mult [8]kWhUsed [9]KWUsed [10]RKVAUsed
  // Pre-normalize OCR junk to spaces (1:1 char replacement, preserves length) and colons→commas.
  // The separator is [^\S\n]+ (whitespace EXCLUDING newline) so a single meter row must live on
  // one line — prevents the regex from chaining numeric tokens across lines and matching things
  // like the barcode digits at the bottom of each bill page. Unambiguous quantifiers also avoid
  // Firefox "too much recursion" from catastrophic backtracking.
  const _meterT = t.replace(/[^\d\s+\-./,:\n]/g, ' ').replace(/:/g, ',');
  // Date pattern supports MM/DD (with optional slash) and 3-5 digit OCR garble like "12001" → "12/01"
  // PER-COLUMN TOLERANCE (cef419c0): groups 4-10 (EndRead, StartRead, Difference, Mult, kWhUsed,
  // KWUsed, RKVAUsed) each use `(?:(CLEAN_NUMBER)|\S+)` instead of a bare mandatory numeric group.
  // Previously every data column was a single hard-required capture chained in one sequential
  // match, so ONE OCR-garbled token anywhere in the row (a stray char surviving the pre-normalize
  // pass, e.g. a stray '/' or extra '.') made the ENTIRE row fail to match — nulling every column
  // on that line, including on a second/third row of a multi-meter (meter change / solar) bill.
  // Now each column independently captures a clean number when the token parses, or silently
  // yields undefined (→ null downstream) for ONLY that column when it doesn't — the token is still
  // consumed positionally (via \S+) so later columns on the same row stay aligned.
  // Group 3 (Days) uses a BOUNDED per-column tolerance (fix, was a bare mandatory `(\d+)`): a bill
  // can OCR-garble Days into a non-numeric token (e.g. "ES") while every other column on the line is
  // perfectly legible. Days was previously part of the "row anchor" along with the two dates, so a
  // garbled Days token failed the anchor match and nulled the ENTIRE row — the exact per-column-
  // isolation failure the cef419c0 rewrite was meant to prevent, just one column earlier than
  // intended. Days is never read out of meterRow downstream for Evergy (NumberOfDays is computed
  // separately from the billing-period dates above), so tolerating a garbled token here is safe.
  // Unlike groups 4-10, Days' fallback is bounded to `\S{1,4}` (not unbounded `\S+`) and the whole
  // group is optional (trailing `?`): the pre-normalize pass (`_meterT` above) replaces every OCR
  // letter with a SPACE, so a fully-alphabetic garble like "ES" doesn't survive as a token at all —
  // it collapses into the surrounding whitespace, leaving NOTHING between the second date and
  // EndRead. An unbounded `\S+` fallback would then greedily consume the real EndRead token itself
  // (it's the next non-whitespace run) as if it were Days, shifting every remaining column left by
  // one — reproducing the exact "one garbled token nulls its neighbors" failure this whole per-
  // column design exists to prevent, just via a different mechanism. Bounding the fallback to 4
  // chars means it can never reach far enough to swallow a real value token (meter reads are always
  // 6+ chars with the decimal point), so when Days has genuinely vanished, both alternatives fail at
  // every length and the optional group correctly matches zero-width, leaving EndRead's own pattern
  // to match starting at the right position. The two dates (groups 1-2) remain the strict/required
  // anchor.
  const _meterRe =
    /(\d{1,2}\/?\d{1,3})[^\S\n]+(\d{1,2}\/?\d{1,3})[^\S\n]+(?:(\d+)|\S{1,4})?[^\S\n]+[-+]?[^\S\n]*(?:([\d,]+(?:\.\d+)?)|\S+)[^\S\n]+[-+]?[^\S\n]*(?:([\d,]+(?:\.\d+)?)|\S+)[^\S\n]+[-+]?[^\S\n]*(?:([\d,]+(?:\.\d+)?)|\S+)[^\S\n]+[-+]?[^\S\n]*(?:([\d,.]+)|\S+)[^\S\n]+[-+]?[^\S\n]*(?:([\d,]+(?:\.\d+)?)|\S+)[^\S\n]+(?:([\d,.]+)|\S+)(?:[^\S\n]+(?:([\d,.]+)|\S+))?/g;
  const _meterRowsRaw = [];
  let _mm;
  while ((_mm = _meterRe.exec(_meterT)) !== null) _meterRowsRaw.push(_mm);

  // Normalize meter row date fields (groups 1 & 2) to MM/DD format
  // OCR commonly reads "/" as "0", so 12/01 → 12001, 9/28 → 9028
  const _normMeterDate = (s) => {
    if (!s) return s;
    if (s.includes('/')) {
      // Already has slash — just pad: "1/28" → "01/28"
      const [m, d] = s.split('/');
      return m.padStart(2, '0') + '/' + d.padStart(2, '0');
    }
    // No slash — OCR read the "/" as "0" or dropped it entirely
    // Try all valid MM/DD splits and pick the one with valid month+day
    const len = s.length;
    const candidates = [];
    if (len === 5) {
      // Most common: "12001" = 12 + garbled_slash + 01
      candidates.push([s.slice(0, 2), s.slice(3)]); // MM + 0 + DD (slash→0)
      candidates.push([s.slice(0, 1), s.slice(2)]); // M + 0 + DD  (e.g. 9028 won't hit here, handled by len===4)
    }
    if (len === 4) {
      // "1028" = 10/28 (slash dropped) OR "9028" = 9 + 0(garbled/) + 28
      candidates.push([s.slice(0, 2), s.slice(2)]); // MM/DD slash dropped
      candidates.push([s.slice(0, 1), s.slice(2)]); // M + 0(garbled/) + DD
    }
    if (len === 3) {
      // "128" = 1/28 (slash dropped)
      candidates.push([s.slice(0, 1), s.slice(1)]);
    }
    for (const [mStr, dStr] of candidates) {
      const mo = parseInt(mStr, 10),
        dy = parseInt(dStr, 10);
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        return String(mo).padStart(2, '0') + '/' + String(dy).padStart(2, '0');
      }
    }
    return s; // can't parse, leave as-is
  };
  const _isValidMeterDate = (s) => /^\d{2}\/\d{2}$/.test(_normMeterDate(s));
  const _meterRows = [];
  for (const row of _meterRowsRaw) {
    if (_isValidMeterDate(row[1]) && _isValidMeterDate(row[2])) {
      row[1] = _normMeterDate(row[1]);
      row[2] = _normMeterDate(row[2]);
      _meterRows.push(row);
    } else {
      const retryStart = row.index + row[1].length;
      _meterRe.lastIndex = retryStart;
      let _retry;
      while ((_retry = _meterRe.exec(_meterT)) !== null) {
        if (_retry.index >= row.index + row[0].length) break;
        if (_isValidMeterDate(_retry[1]) && _isValidMeterDate(_retry[2])) {
          _retry[1] = _normMeterDate(_retry[1]);
          _retry[2] = _normMeterDate(_retry[2]);
          _meterRows.push(_retry);
          break;
        }
        _meterRe.lastIndex = _retry.index + _retry[1].length;
      }
    }
  }

  // ── ZERO-ROW FALLBACK: recover a meter row whose BOTH date columns are unrecoverable ──
  // The primary _meterRe above intentionally keeps the two leading date columns as a strict,
  // non-optional anchor (see the comment above _meterRe) — loosening them directly would risk
  // matching unrelated numeric content elsewhere in the bill (e.g. a charge-breakdown table),
  // since groups 4-10 already tolerate almost any token via their \S+ fallback; the dates are
  // what actually protects against a false-positive row match today. But a bill can garble
  // BOTH date tokens past any digit-substitution recovery (e.g. "40s"/"oss" for "04/09"/
  // "05/08" — Field House, April 2026 electric bill, acct 8980291458) while every remaining
  // column — Days, EndRead, StartRead, Difference, Multiplier, kWhUsed, KWUsed, RKVAUsed —
  // reads perfectly. The strict primary regex correctly refuses to match that line at all, so
  // those numeric reads are silently lost. Recover them here, but ONLY when the primary pass
  // found ZERO rows anywhere in the bill — this fallback can never fire on, and therefore can
  // never regress, any bill that already has at least one strictly-anchored row (every bill in
  // the existing 37-file reference corpus and every harness fixture). Because there is no date
  // anchor to rely on for false-positive protection here, a candidate line is additionally
  // REQUIRED to satisfy the row's own arithmetic identity — EndRead-StartRead≈Difference
  // (tolerating the same missing-decimal insertion the recovery pass below applies) or
  // Difference×Multiplier≈kWhUsed — before it is accepted. An unrelated line (a barcode digit
  // run, a charge-breakdown row) has no reason to satisfy that identity; that check is what
  // actually protects against false positives here, not the date shape.
  // Bounded to a single bill/page's worth of text (~8KB — real single-bill OCR pages in the
  // reference corpus run 2-4KB; this is called once per already-isolated bill section, never
  // on a whole multi-page combined document, but the length guard is kept as a hard backstop
  // regardless) and to at most 300 candidate-line attempts, so a worst-case document can never
  // turn this into a multi-second scan — measured against the 47-bill and 33-bill harness
  // fixtures after adding this guard (see dashboardlogic entry for this fix).
  if (_meterRows.length === 0 && _meterT.length < 8000) {
    const _meterReLoose =
      /^[^\S\n]*(?:\S{1,6}[^\S\n]+){0,2}(?:\d{1,3}[^\S\n]+)?([\d,]+(?:\.\d+)?)[^\S\n]+([\d,]+(?:\.\d+)?)[^\S\n]+([\d,]+(?:\.\d+)?)[^\S\n]+([\d,]+(?:\.\d+)?)[^\S\n]+([\d,]+(?:\.\d+)?)(?:[^\S\n]+([\d,.]+))?(?:[^\S\n]+([\d,.]+))?[^\S\n]*$/gm;
    let _lm;
    let _looseAttempts = 0;
    while ((_lm = _meterReLoose.exec(_meterT)) !== null && _looseAttempts < 300) {
      _looseAttempts++;
      const pnL = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
      const _insertDecimal4L = (s) => {
        if (!s || s.includes('.')) return s;
        const digits = s.replace(/,/g, '');
        if (!/^\d+$/.test(digits) || digits.length < 7 || digits.length > 9) return s;
        return digits.slice(0, -4) + '.' + digits.slice(-4);
      };
      const endL = pnL(_insertDecimal4L(_lm[1]));
      const startL = pnL(_insertDecimal4L(_lm[2]));
      const diffL = pnL(_lm[3]);
      const multL = pnL(_lm[4]);
      const kwhL = pnL(_lm[5]);
      if (endL <= 0 || startL <= 0 || diffL <= 0 || multL <= 0) continue;
      const readsChecksum = Math.abs(endL - startL - diffL) < 0.5;
      const kwhChecksum = kwhL > 0 && Math.abs(diffL * multL - kwhL) < 1;
      if (!readsChecksum && !kwhChecksum) continue; // no evidence this is a real meter row — skip
      const fakeRow = [
        _lm[0],
        null,
        null,
        null,
        _lm[1],
        _lm[2],
        _lm[3],
        _lm[4],
        _lm[5],
        _lm[6] || null,
        _lm[7] || null,
      ];
      fakeRow.index = _lm.index;
      _meterRows.push(fakeRow);
    }
  }

  // ── OCR DIGIT CORRECTION ENGINE ──
  // Tesseract frequently confuses 0↔6↔8↔3 (round digits) and occasionally 1↔7, 5↔6.
  // The meter table has built-in checksums: EndRead - StartRead = Difference, Diff × Mult = kWhUsed.
  // When these don't match, try single-digit substitutions on the reads to find a value that satisfies.
  // Full confusable digit map — OCR confuses round digits (0,3,6,8,9) and stroke digits (1,4,5,7)
  const _CONFUSABLE = {
    0: ['6', '8', '3', '9'],
    1: ['7', '4', '9'],
    2: ['7', '3'],
    3: ['8', '0', '6', '5'],
    4: ['1', '9'],
    5: ['6', '3', '8'],
    6: ['0', '8', '5', '9'],
    7: ['1', '2'],
    8: ['0', '6', '3', '9', '5'],
    9: ['8', '0', '4', '6'],
  };
  function _reconcileNumber(ocrStr, targetVal, maxPositions) {
    // Generalizes single-digit substitution to up to `maxPositions` simultaneous confusable-digit
    // substitutions. A single OCR-garbled column can have more than one misread digit (e.g. two
    // stray strokes in "0800" that should read "9590") — the original single-digit-only version of
    // this function couldn't recover those, silently leaving the field wrong. Still format-strict:
    // only accepts a fix when the corrected value has the EXACT same digit count/decimal-place
    // layout as the OCR'd string (no digit insertion/deletion — that's a different failure mode,
    // not a misread) AND every differing digit position is a plausible OCR confusion per
    // _CONFUSABLE (guards against blindly overwriting a correctly-read value with the arithmetic
    // target). Returns the corrected string (comma-stripped, matching the old _tryDigitFix
    // contract) or null if no plausible fix was found.
    if (ocrStr == null || !isFinite(targetVal)) return null;
    const digitsOnly = ocrStr.replace(/,/g, '');
    const dotIdx = digitsOnly.indexOf('.');
    const decimals = dotIdx === -1 ? 0 : digitsOnly.length - dotIdx - 1;
    let targetStr = decimals > 0 ? targetVal.toFixed(decimals) : String(Math.round(targetVal));
    // FIX (2026-08-24, Louisburg visual audit bug #5/#8): this used to left-pad a shorter
    // arithmetic target with a leading zero so a "stray leading digit" could be treated as a
    // plausible single-digit substitution. That is unsound: the digit-count MISMATCH this
    // branch exists to paper over is exactly as likely to mean "the arithmetic TARGET is wrong
    // because a SIBLING column (EndRead/StartRead/Difference/kWh) was itself OCR-garbled" as it
    // is to mean "this OCR string genuinely has a spurious extra leading digit." On the
    // Maintenance Bldg April 2026 bill (account 0669287870) it was the former: EndRead's raw
    // OCR ("B4,784.6376") lost its leading 8 to a letter-for-digit misread earlier in the
    // pipeline, which made the row's own checksum target one digit short — and this padding
    // branch then rewrote the ALREADY-CORRECT StartRead ("84,385.0790", matching the printed
    // bill exactly) down to "04385.0790" to chase that corrupted target. Enforcing the EXACT
    // digit-count match this function's own header comment already promises ("no digit
    // insertion/deletion — that's a different failure mode, not a misread") means a length
    // mismatch is now always rejected here, never silently patched over. A genuinely missing
    // leading digit is instead recovered structurally, with its own explicit evidence
    // (sibling-column digit-count comparison), by the MISSING-LEADING-DIGIT RECOVERY pass below.
    if (targetStr.length !== digitsOnly.length) return null; // digit count mismatch — not a simple misread
    const diffPositions = [];
    for (let i = 0; i < digitsOnly.length; i++) {
      if (digitsOnly[i] === targetStr[i]) continue;
      if (digitsOnly[i] === '.' || targetStr[i] === '.') return null; // decimal point moved — reject
      const orig = digitsOnly[i],
        want = targetStr[i];
      const plausible = (_CONFUSABLE[orig] || []).includes(want) || (_CONFUSABLE[want] || []).includes(orig);
      if (!plausible) return null;
      diffPositions.push(i);
    }
    if (diffPositions.length === 0 || diffPositions.length > maxPositions) return null;
    // Rebuild the corrected string against the ORIGINAL (comma-containing) string so the
    // substitution lands on the right character even though positions above were computed
    // against the comma-stripped digit string.
    let digitIdx = 0;
    let fixed = '';
    for (let j = 0; j < ocrStr.length; j++) {
      if (ocrStr[j] === ',') continue; // comma has no slot in digitsOnly — skip without advancing digitIdx
      fixed += diffPositions.includes(digitIdx) ? targetStr[digitIdx] : ocrStr[j];
      digitIdx++;
    }
    return fixed;
  }
  // Enumerates every SINGLE plausible confusable-digit substitution of `ocrStr` (added
  // 2026-08-24, Louisburg visual audit bug #8, for the joint EndRead/StartRead recovery tier
  // below). Unlike _reconcileNumber, this does not test against one arithmetic target — it
  // returns the whole candidate set (comma stripped from output, matching _reconcileNumber's
  // contract) so a caller can search for a pairing that satisfies an identity spanning two
  // independently-garbled columns. Bounded: at most (digit count) x (confusable alternatives
  // per digit, typically 2-5) candidates, so a 10-character read produces well under 50.
  function _singleDigitCandidates(ocrStr) {
    if (!ocrStr) return [];
    const digitsOnly = ocrStr.replace(/,/g, '');
    const out = [];
    for (let i = 0; i < digitsOnly.length; i++) {
      const ch = digitsOnly[i];
      if (ch === '.') continue;
      const opts = new Set(_CONFUSABLE[ch] || []);
      for (const k of Object.keys(_CONFUSABLE)) {
        if (_CONFUSABLE[k].includes(ch)) opts.add(k);
      }
      opts.delete(ch);
      for (const rep of opts) {
        let digitIdx = 0;
        let rebuilt = '';
        for (let j = 0; j < ocrStr.length; j++) {
          if (ocrStr[j] === ',') continue;
          rebuilt += digitIdx === i ? rep : ocrStr[j];
          digitIdx++;
        }
        const val = parseFloat(rebuilt);
        if (isFinite(val)) out.push({ str: rebuilt, val });
      }
    }
    return out;
  }
  // Normalize OCR artifacts in meter row numeric fields (colons → commas, strip non-numeric junk)
  for (const row of _meterRows) {
    for (let gi = 4; gi <= 10; gi++) {
      if (row[gi]) row[gi] = row[gi].replace(/:/g, ',');
    }
  }
  // ── MISSING-DECIMAL RECOVERY (groups 4/5: EndRead/StartRead) ──
  // Same repair pattern already used for kWhUsed's "Candidate 1b" fallback (~line 2731,
  // "1053648000" -> "105,364.8000"): occasionally the printed decimal point in a meter read
  // OCRs to nothing at all rather than to a misread digit — the token still parses as a
  // clean number (passes the CLEAN_NUMBER branch of _meterRe) but comes back as a bare
  // integer with the decimal simply absent, which is not one of the confusable-digit
  // misreads _reconcileNumber below can fix (that function requires identical digit counts).
  // Every real EndRead/StartRead in the reference corpus prints with exactly 4 decimal digits
  // (see the per-column comment above _meterRe), so a 7-9 digit integer-looking token is a
  // candidate for "insert a decimal 4 digits from the right". Only adopted when it is a
  // STRICT improvement to this row's own EndRead-StartRead=Difference checksum versus
  // leaving the token as a bare integer — protects any bill that legitimately reads as a
  // whole number (that checksum is already near 0 for a real integer read, so inserting a
  // decimal would only make the gap worse and the guard correctly rejects it). Sets the
  // same row._fixedEndRead/_fixedStartRead + *_Original fields Tier 1 below already sets on
  // a digit-substitution fix, so every downstream consumer (StartRead/EndRead result
  // fields, Meter1_/Meter2_, the kWh candidate list, _digitCorrections diagnostics) picks
  // this up with no additional wiring.
  for (const row of _meterRows) {
    const _insertDecimal4 = (s) => {
      if (!s || s.includes('.')) return null;
      const digits = s.replace(/,/g, '');
      if (!/^\d+$/.test(digits) || digits.length < 7 || digits.length > 9) return null;
      return digits.slice(0, -4) + '.' + digits.slice(-4);
    };
    const endCand = _insertDecimal4(row[4]);
    const startCand = _insertDecimal4(row[5]);
    if (!endCand && !startCand) continue;
    const pn0 = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
    const rawEnd = pn0(row[4]),
      rawStart = pn0(row[5]),
      rawDiffCol = pn0(row[6]);
    const candEnd = endCand ? parseFloat(endCand) : rawEnd;
    const candStart = startCand ? parseFloat(startCand) : rawStart;
    const rawGap = Math.abs(rawEnd - rawStart - rawDiffCol);
    const candGap = Math.abs(candEnd - candStart - rawDiffCol);
    if (candGap < rawGap) {
      if (endCand) {
        row._fixedEndRead = endCand;
        row._endReadOriginal = row[4].replace(/,/g, '');
      }
      if (startCand) {
        row._fixedStartRead = startCand;
        row._startReadOriginal = row[5].replace(/,/g, '');
      }
    }
  }
  // ── MISSING-LEADING-DIGIT RECOVERY (groups 4/5: EndRead/StartRead) ──
  // Added 2026-08-24 (Louisburg visual audit bug #5/#8) alongside removing the unsound
  // leading-digit-pad branch from _reconcileNumber above. A meter's EndRead and StartRead are
  // the same physical register, read on nearly the same date, so they always share the same
  // integer-digit count (or EndRead has exactly one MORE digit than StartRead, on a genuine
  // meter rollover — never fewer). When OCR drops a leading digit from one of them (e.g. an "8"
  // misread as a letter that a later normalize pass blanks to whitespace — confirmed root cause
  // on the Maint Bldg April 2026 bill, account 0669287870: "84,784.6376" OCR'd as "B4,784.6376"
  // then normalized to " 4,784.6376", losing the 8 entirely), that digit-count mismatch against
  // its sibling column IS the missing evidence — restoring the sibling's leading digit(s) is a
  // structural repair (same category as the missing-decimal recovery above), not a digit GUESS,
  // so it does not go through the confusable-digit plausibility gate at all. Like the
  // missing-decimal recovery above, only adopted when it is a STRICT improvement to this row's
  // own EndRead-StartRead≈Difference checksum, so it can never fire on (and never regress) a
  // row where both columns already agree.
  for (const row of _meterRows) {
    if (row._fixedEndRead || row._fixedStartRead) continue; // already structurally repaired above
    const endDigits = (row[4] || '').replace(/,/g, '').split('.')[0];
    const startDigits = (row[5] || '').replace(/,/g, '').split('.')[0];
    if (!endDigits || !startDigits || !/^\d+$/.test(endDigits) || !/^\d+$/.test(startDigits)) continue;
    const pn0b = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
    const rawEnd = pn0b(row[4]),
      rawStart = pn0b(row[5]),
      rawDiffCol = pn0b(row[6]);
    if (rawEnd <= 0 || rawStart <= 0) continue;
    const rawGap = Math.abs(rawEnd - rawStart - rawDiffCol);
    let candEndStr = null,
      candStartStr = null,
      candVal = null;
    if (startDigits.length - endDigits.length === 1) {
      // EndRead is short exactly one leading digit — borrow StartRead's leading digit.
      candEndStr = startDigits[0] + row[4];
      candVal = parseFloat(candEndStr.replace(/,/g, ''));
    } else if (endDigits.length - startDigits.length === 1) {
      // StartRead is short exactly one leading digit — borrow EndRead's leading digit.
      candStartStr = endDigits[0] + row[5];
      candVal = parseFloat(candStartStr.replace(/,/g, ''));
    } else {
      continue; // not a single-digit sibling mismatch — outside this recovery's evidence
    }
    const candEnd = candEndStr ? candVal : rawEnd;
    const candStart = candStartStr ? candVal : rawStart;
    const candGap = Math.abs(candEnd - candStart - rawDiffCol);
    if (candGap < rawGap) {
      if (candEndStr) {
        row._fixedEndRead = candEndStr;
        row._endReadOriginal = row[4].replace(/,/g, '');
      }
      if (candStartStr) {
        row._fixedStartRead = candStartStr;
        row._startReadOriginal = row[5].replace(/,/g, '');
      }
    }
  }
  // Apply checksum-driven reconciliation to meter rows. Two identities hold on a clean row:
  //   (1) EndRead - StartRead = Difference
  //   (2) Difference × Multiplier = kWh Used
  // Tier 1 (restores the pre-regression engine, generalized to multi-digit fixes): when (1)
  // fails but (2) corroborates the raw Difference column, trust Difference and try correcting
  // EndRead or StartRead toward it.
  // Tier 2 (NEW — the actual regression fix): Tier 1 alone assumed Difference itself was always
  // clean, which is not true on this branch's per-column-tolerant regex — Difference is now just
  // as capable of being individually OCR-garbled as any other column. When Tier 1 can't find a
  // plausible EndRead/StartRead fix, try correcting Difference toward kWh÷Multiplier instead, then
  // re-run Tier 1 once more with the corrected Difference as the trusted checksum.
  for (const row of _meterRows) {
    const pn = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
    const endR = pn(row._fixedEndRead || row[4]),
      startR = pn(row._fixedStartRead || row[5]);
    let diff = pn(row[6]);
    const mult = pn(row[7]),
      kwhUsed = pn(row[8]);
    if (endR <= 0 || startR <= 0 || diff <= 0 || mult <= 0) continue;
    // Skip OCR correction for rollover rows — when endR < startR and near a boundary,
    // the "wrong" diff sign is expected; do not attempt digit substitution on these.
    if (endR < startR) {
      const _rvBoundaries = [99999, 999999, 9999999];
      const _isRolloverRow = _rvBoundaries.some((b) => startR > b * 0.9 && endR < b * 0.1);
      if (_isRolloverRow) continue;
    }
    const calcDiff0 = parseFloat((endR - startR).toFixed(4));
    if (Math.abs(calcDiff0 - diff) < 0.001) continue; // already self-consistent, nothing to fix

    const _tryFixReads = (trustedDiff) => {
      const diffTimesM = parseFloat((trustedDiff * mult).toFixed(4));
      // TOLERANCE (fix, 2026-08-24, Louisburg visual audit bug #8): Difference x Multiplier =
      // kWh Used is an EXACT restatement on an Evergy meter-read row, not a rounded rate calc —
      // the bill prints the same number twice (once as "Read Difference", again as "kWh Used")
      // whenever Multiplier is 1.0000, which is the common case. The old `< 1` tolerance was
      // loose enough to accept an OCR-garbled Difference (Maint Bldg Meter 2, raw "558.8080"
      // vs true/kWh-corroborated "558.9090", off by 0.101) as "confirmed," which then let this
      // function corrupt an EndRead that was only one digit off from correct into one that was
      // three digits off. Tightened to match the columns' own 4-decimal precision so a
      // genuinely-wrong Difference is rejected here and left for the kWh-derived correction
      // (Tier 2 below) instead of being trusted to rewrite the reads.
      const kwhMatch = kwhUsed > 0 && Math.abs(diffTimesM - kwhUsed) < 0.01;
      if (!kwhMatch) return false; // can't trust this Difference value, don't touch the reads
      const expectedEnd = parseFloat((startR + trustedDiff).toFixed(4));
      const expectedStart = parseFloat((endR - trustedDiff).toFixed(4));
      let fixedSomething = false;
      if (!row._fixedEndRead && Math.abs(endR - expectedEnd) > 0.0005) {
        const fixedEnd = _reconcileNumber(row[4], expectedEnd, 3);
        if (fixedEnd) {
          row._fixedEndRead = fixedEnd;
          row._endReadOriginal = row[4].replace(/,/g, '');
          fixedSomething = true;
        }
      }
      if (!row._fixedStartRead && Math.abs(startR - expectedStart) > 0.0005) {
        const fixedStart = _reconcileNumber(row[5], expectedStart, 3);
        if (fixedStart) {
          row._fixedStartRead = fixedStart;
          row._startReadOriginal = row[5].replace(/,/g, '');
          fixedSomething = true;
        }
      }
      return fixedSomething;
    };

    const tier1Fixed = _tryFixReads(diff);

    if (!tier1Fixed && kwhUsed > 0) {
      const diffFromKwh = parseFloat((kwhUsed / mult).toFixed(4));
      if (Math.abs(diff - diffFromKwh) > 0.0005) {
        const fixedDiff = _reconcileNumber(row[6], diffFromKwh, 3);
        if (fixedDiff) {
          row._fixedDifference = fixedDiff;
          row._differenceOriginal = row[6].replace(/,/g, '');
          diff = parseFloat(fixedDiff);
          _tryFixReads(diff);
        }
      }
    }

    // Tier 3: neither the raw Difference nor the kWh-derived Difference reconciled the
    // reads (Tier 1/2 both gave up above). If EndRead/StartRead themselves needed no
    // digit-substitution fix here — either they were already self-consistent going in, or
    // the missing-decimal recovery above already corrected them via a structural (not
    // digit-guess) repair — trust them directly and correct the Difference column toward
    // their own subtraction instead. This only runs after Tier 1/2 have already failed to
    // find a plausible fix in the other two directions, so it never overrides a Difference
    // correction the kWh identity already corroborated (Tier 2), and never fires on a row
    // where the reads themselves are still in question (Tier 1 would have claimed it).
    if (!tier1Fixed && !row._fixedDifference) {
      const trustedDiff2 = parseFloat((endR - startR).toFixed(4));
      if (trustedDiff2 > 0 && Math.abs(diff - trustedDiff2) > 0.0005) {
        const fixedDiff2 = _reconcileNumber(row[6], trustedDiff2, 3);
        if (fixedDiff2) {
          row._fixedDifference = fixedDiff2;
          row._differenceOriginal = row[6].replace(/,/g, '');
        }
      }
    }

    // Tier 4 (added 2026-08-24, Louisburg visual audit bug #8): EndRead AND StartRead are
    // BOTH individually OCR-garbled by one digit each. Tiers 1-3 only ever hold ONE side fixed
    // (at its raw, possibly-wrong value) while solving for the other, so they never find a fix
    // when both sides need correcting at once — confirmed on Maint Bldg Meter 2 (account
    // 0669287870, April 2026): raw EndRead "58,674.0800" (true "58,674.0600") and raw StartRead
    // "58,116.1510" (true "58,115.1510") each need exactly one plausible digit swap, but neither
    // swap alone reconciles against the OTHER column's still-raw value. Only reached once the
    // Difference column is trusted (either it already agreed, or Tier 2/3 already corrected it)
    // and both reads are still untouched — i.e., there is no simpler single-column explanation
    // left. Searches EndRead's single-digit-substitution candidates (bounded, see
    // _singleDigitCandidates) and asks _reconcileNumber to find a single-digit StartRead that
    // pairs with each one to satisfy the trusted Difference exactly; a fix is only adopted when
    // that search returns EXACTLY ONE candidate pair, so an ambiguous row (multiple equally
    // plausible pairings) is left alone rather than guessed.
    if (!row._fixedEndRead && !row._fixedStartRead) {
      const trustedDiffFinal = row._fixedDifference ? parseFloat(row._fixedDifference) : diff;
      const stillOff = trustedDiffFinal > 0 && Math.abs(endR - startR - trustedDiffFinal) > 0.001;
      if (stillOff) {
        const endCands = _singleDigitCandidates(row[4]);
        const pairMatches = [];
        for (const ec of endCands) {
          const neededStart = parseFloat((ec.val - trustedDiffFinal).toFixed(4));
          const fixedStartTry = _reconcileNumber(row[5], neededStart, 1);
          if (fixedStartTry) pairMatches.push({ end: ec.str, start: fixedStartTry });
        }
        if (pairMatches.length === 1) {
          row._fixedEndRead = pairMatches[0].end;
          row._endReadOriginal = row[4].replace(/,/g, '');
          row._fixedStartRead = pairMatches[0].start;
          row._startReadOriginal = row[5].replace(/,/g, '');
        }
      }
    }
  }
  // Check for Delivered/Received labels near meter table (solar net metering indicator)
  // Also accept "Net Meter" label (used by Evergy parallel-generation 2LGAEP bills).
  // "Net Meter" appears on the page continuation note after the table — use a wider
  // forward window (1200 chars) than the Delivered/Received check (600 chars).
  const _hasSolarLabels = (() => {
    const tableIdx = _meterRows.length ? _meterRows[0].index : t.length;
    const region = t.slice(Math.max(0, tableIdx - 300), tableIdx + 600);
    const regionWide = t.slice(Math.max(0, tableIdx - 300), tableIdx + 1200);
    // Classic Delivered/Received format (labels appear in column headers near the table)
    if (/\bDeliver/i.test(t) && /\bRece[iv]/i.test(t) && /\bDeliver/i.test(region) && /\bRece[iv]/i.test(region))
      return true;
    // Evergy parallel-generation: "Net Meter" label on the page following the meter table.
    // Use (?!ing) to avoid false match on "Net Metering program" (marketing text in standard bills).
    if (/Net\s+Meter(?!ing)/i.test(regionWide)) return true;
    return false;
  })();
  // Combine meter rows into a single effective meter reading
  const meterRow = _meterRows.length ? _meterRows[0] : null;
  // ── Same-meter guard (item 0d47ad08 subtask 5) ──
  // The meter_change sum below used to combine 2+ meter rows purely on count, with
  // no identity check — two DIFFERENT meters that merely share an account/page range
  // (e.g. a multi-account PDF whose account digits collide, or a mis-scoped page
  // range) would get summed into one bogus bill. Derive each row's service address
  // (bounded by the nearest preceding %%PAGE_N%% marker — _meterT is 1:1 char-length-
  // identical to t, per the comment above the regex, so row.index is a valid offset
  // into t) and group rows with row[0] (the anchor) only when the address matches.
  // When address text is missing or didn't match on either side, fall back to
  // comparing MeterMultiplier — a real mid-cycle meter swap keeps the same address
  // AND multiplier; a foreign/contaminating row differs on both. Computed once here
  // and reused by both the meter_change sum and the Meter1_/Meter2_ result fields
  // below — never inline-copied.
  const _meterPageMarkerIdxs = [...t.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => m.index);
  const _meterRowAddr = (row) => {
    let markerIdx = 0;
    for (const idx of _meterPageMarkerIdxs) {
      if (idx <= row.index) markerIdx = idx;
      else break;
    }
    const m = t.slice(markerIdx, row.index).match(_EVG_ADDR);
    return m ? m[1].trim().replace(/\s+/g, ' ').toUpperCase() : null;
  };
  for (const row of _meterRows) row._addr = _meterRowAddr(row);
  const _meterGroup = _meterRows.length
    ? _meterRows.filter((row) => {
        if (row === _meterRows[0]) return true;
        if (row._addr && _meterRows[0]._addr) return row._addr === _meterRows[0]._addr;
        const rowMult = (row[7] || '').replace(/,/g, '').trim();
        const anchorMult = (_meterRows[0][7] || '').replace(/,/g, '').trim();
        return rowMult === anchorMult;
      })
    : [];
  const _meterGroupExcluded = _meterRows.filter((row) => !_meterGroup.includes(row));
  const _meterCombined = (() => {
    if (_meterRows.length <= 1) return null; // single row handled by meterRow directly
    const pn = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
    if (_hasSolarLabels) {
      // Solar net metering: identify consumption vs generation by KW Used.
      // The generation meter has KW Used = 0 (no demand charge); consumption meter has KW > 0.
      // Fall back to sorting by kWh descending if all rows have KW=0.
      const byKw = _meterRows.filter((r) => pn(r[9]) > 0);
      const byKwZero = _meterRows.filter((r) => pn(r[9]) === 0);
      let consumptionRow, generationRow;
      if (byKw.length >= 1 && byKwZero.length >= 1) {
        consumptionRow = byKw[0];
        generationRow = byKwZero[0];
      } else {
        // Fallback: larger kWh = consumption
        const sorted = [..._meterRows].sort((a, b) => pn(b[8]) - pn(a[8]));
        consumptionRow = sorted[0];
        generationRow = sorted[1];
      }
      return { type: 'solar', rows: _meterRows.length, delivered: consumptionRow, received: generationRow };
    }
    // Meter change / multi-meter bill: sum kWh, RKVA (max), ReadDifference (sum);
    // take max KW; use overall start/end dates.
    // NOTE: StartRead/EndRead are intentionally NOT combined here. When 2+ meter
    // rows are present (either a mid-cycle meter swap or two simultaneously-active
    // meters on one account), the rows belong to physically different meters —
    // "last row's EndRead minus first row's StartRead" is not a valid reading and
    // must never be presented as one (see Meter1_/Meter2_ fields below for the
    // real per-meter values). ReadDifference IS combined (sum of each row's own
    // difference) because that's what genuinely represents total consumption.
    // Same-meter guard: sum ONLY the primary group (_meterGroup, computed above) —
    // rows that share row[0]'s derived service address (or MeterMultiplier as
    // fallback). If nothing else survives, fall through to the already-verified
    // single-meter path (meterRow = the anchor row, _meterRows[0]).
    if (_meterGroup.length <= 1) return null;
    const first = _meterGroup[0],
      last = _meterGroup[_meterGroup.length - 1];
    let totalKwh = 0,
      totalDiff = 0,
      maxKw = 0,
      maxRkva = 0;
    for (const r of _meterGroup) {
      totalKwh += pn(r[8]);
      totalDiff += pn(r._fixedDifference || r[6]);
      maxKw = Math.max(maxKw, pn(r[9]));
      maxRkva = Math.max(maxRkva, pn(r[10]));
    }
    return {
      type: 'meter_change',
      rows: _meterGroup.length,
      startDate: first[1],
      endDate: last[2],
      startRead: null,
      endRead: null,
      readDifference: parseFloat(totalDiff.toFixed(4)),
      multiplier: first[7]?.replace(/,/g, ''),
      kwh: parseFloat(totalKwh.toFixed(4)),
      kw: maxKw.toFixed(4),
      rkva: maxRkva.toFixed(4),
    };
  })();

  // ── Multi-line labeled meter table (fallback for PDF.js text layout) ──
  // Some PDFs produce each meter field on its own labeled line:
  //   Start Read Date\n12/31\n...\nEnd Read (-)\n45,215.1026\n...
  const _mlMeter = (() => {
    if (meterRow) return null;
    const startDateM = t.match(/Start\s+Read\s+Date\s*\n\s*(\d{2}\/\d{2})/i);
    const endDateM = t.match(/End\s+Read\s+Date\s*\n\s*(\d{2}\/\d{2})/i);
    const endReadM = t.match(/End\s+Read\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const startReadM = t.match(/Start\s+Read\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const multM = t.match(/Meter\s+Multiplier\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const kwUsedM = t.match(/KW\s+Used\s+([\d,]+\.\d+)/i);
    const rkvaUsedM = t.match(/RKVA\s+Used\s+([\d,]+\.\d+)/i);
    if (startDateM || endDateM || endReadM || startReadM) {
      return {
        startDate: startDateM?.[1] || null,
        endDate: endDateM?.[1] || null,
        endRead: endReadM?.[1]?.replace(/,/g, '') || null,
        startRead: startReadM?.[1]?.replace(/,/g, '') || null,
        multiplier: multM?.[1]?.replace(/,/g, '') || null,
        kwUsed: kwUsedM?.[1]?.replace(/,/g, '') || null,
        rkvaUsed: rkvaUsedM?.[1]?.replace(/,/g, '') || null,
      };
    }
    return null;
  })();

  // ── kWh Consumed: multi-source with cross-validation ──
  // Source 1: Meter read table — (EndRead - StartRead) × Multiplier (most reliable)
  // Source 2: ECA/EER/PTS charge line kWh quantities (full billing period total)
  // Source 3: Sum of Energy Chg tier kWh quantities
  // Validation: Evergy values always have a decimal point; values without decimals are OCR errors
  const _validKwh = (v) => {
    // All Evergy numeric values have decimals — a whole number > 10000 without decimal is suspicious
    if (v > 10000 && v === Math.floor(v)) return false;
    // Sanity: kWh should be between 100 and 2,000,000 for commercial
    return v > 0 && v < 2000000;
  };

  // Source 1: meter read calculation (handles multi-row meter changes)
  const meterKwh = (() => {
    // Multi-meter: combined kWh already calculated (meter change = summed, solar = delivered only)
    if (_meterCombined) {
      if (_meterCombined.type === 'meter_change' && _validKwh(_meterCombined.kwh)) return _meterCombined.kwh;
      if (_meterCombined.type === 'solar') {
        const pn = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
        const deliveredKwh = pn(_meterCombined.delivered[8]);
        if (_validKwh(deliveredKwh)) return deliveredKwh;
      }
    }
    // Single meter row — gather all kWh candidates and pick the best
    if (!meterRow) return null;
    const candidates = [];
    // Candidate 1: Direct kWh Used column
    const directKwhRaw = (meterRow[8] || '').replace(/,/g, '');
    const directKwh = parseFloat(directKwhRaw);
    if (_validKwh(directKwh)) candidates.push({ val: directKwh, src: 'direct' });
    // Candidate 1b: Repair garbled kWh (e.g. "1053648000" = "105,364.8000" with stripped punctuation)
    if (!_validKwh(directKwh) && directKwhRaw.length >= 8 && !directKwhRaw.includes('.')) {
      const repaired = directKwhRaw.slice(0, -4) + '.' + directKwhRaw.slice(-4);
      const repairedVal = parseFloat(repaired);
      if (_validKwh(repairedVal)) candidates.push({ val: repairedVal, src: 'repaired' });
    }
    // Candidate 2: Difference × Multiplier (fewer digits = less OCR error risk)
    const diffVal = parseFloat((meterRow._fixedDifference || meterRow[6] || '').replace(/,/g, ''));
    const multVal = parseFloat((meterRow[7] || '').replace(/,/g, ''));
    if (diffVal > 0 && multVal > 0) {
      const diffTimesM = parseFloat((diffVal * multVal).toFixed(4));
      if (_validKwh(diffTimesM)) candidates.push({ val: diffTimesM, src: 'diff×mult' });
    }
    // Candidate 3: (EndRead - StartRead) × Multiplier
    const endR = parseFloat((meterRow._fixedEndRead || meterRow[4] || '').replace(/,/g, ''));
    const startR = parseFloat((meterRow._fixedStartRead || meterRow[5] || '').replace(/,/g, ''));
    const mult = parseFloat((meterRow[7] || '').replace(/,/g, ''));
    if (endR > 0 && startR > 0 && mult > 0) {
      const calc = parseFloat(((endR - startR) * mult).toFixed(4));
      if (_validKwh(calc)) candidates.push({ val: calc, src: 'read×mult' });
    }
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].val;
    // Multiple candidates: find consensus — if 2+ agree within 1%, use that value
    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const ratio = candidates[a].val / candidates[b].val;
        if (ratio > 0.99 && ratio < 1.01) return candidates[a].val;
      }
    }
    // No consensus — prefer diff×mult (fewest digits, least OCR error), then direct, then read calc
    const prefer = ['diff×mult', 'repaired', 'direct', 'read×mult'];
    for (const src of prefer) {
      const c = candidates.find((x) => x.src === src);
      if (c) return c.val;
    }
    return candidates[0].val;
  })();

  // Source 2: ECA/EER/PTS line kWh (only trust values with decimals)
  const fromAdj = [
    ...t.matchAll(/(?:ECA|EER|PTS)\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[\s\S]*?(?:for\s+)?([\d,]+\.\d+)\s*kWh/gi),
  ]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((v) => _validKwh(v));
  const adjKwhVal = fromAdj.length ? Math.max(...fromAdj) : null;

  // Source 3: Energy tier sum
  const fromEnergy = [
    ...t.matchAll(
      /Energy\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])\s+(?:On\s+Pk\s+\w+\s+|Off\s+Pk\s+\w+\s+)?([\d,]+\.\d+)\s*kWh/gi,
    ),
  ]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((v) => v > 0);
  const tierKwh = fromEnergy.length ? parseFloat(fromEnergy.reduce((a, b) => a + b, 0).toFixed(4)) : null;

  // Pick best source: prefer meter read calc, then adj lines, then tier sum
  const adjKwh = (() => {
    if (meterKwh && adjKwhVal) {
      const ratio = meterKwh / adjKwhVal;
      if (ratio > 0.99 && ratio < 1.01) return String(meterKwh);
      if (ratio > 0.5 && ratio < 2.0) return String(meterKwh);
      // Wildly different (>2x) — meter regex likely garbled, trust charge lines
      return String(adjKwhVal);
    }
    if (meterKwh && _validKwh(meterKwh)) return String(meterKwh);
    if (adjKwhVal) return String(adjKwhVal);
    if (tierKwh && _validKwh(tierKwh)) return String(tierKwh);
    // Last resort
    const fallback =
      t.match(/kWh\s+(?:Used|Consumed)[^\d]*([\d,]+\.\d+)/i) || t.match(/([\d,]+\.\d+)\s*kWh\s+(?:Used|Consumed)/i);
    if (fallback) {
      const v = parseFloat(fallback[1].replace(/,/g, ''));
      if (_validKwh(v)) return String(v);
    }
    return null;
  })();

  // ── Rate schedule ──
  // Rate schedule: code appears just before 'Billing Details' (possibly on previous line after y-split)
  // Fallback: rate schedule is always under the service address on page 2/3
  const rateMatch =
    t.match(/[-\u2013]\s*([\dA-Z]{3,10})[^\n]*?\n?[^\n]*?Billing\s+Details/i) ||
    t.match(/[-\u2013]\s*([\dA-Z]{3,10})\s+Billing\s+Details/i) ||
    t.match(/LGS[^\n]*[-\u2013]\s*([\dA-Z]{3,10})\s*$/im) ||
    t.match(/Rate\s*(?:Schedule|Code)?[\s:]*([A-Z0-9\-]{2,12})/i) ||
    (() => {
      // Structural fallback: find the rate code near the address on page 2/3
      // Pattern: address line (with state abbrev), then rate code on a nearby line before "Billing Details"
      const lines = t.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/Billing\s+Details/i.test(lines[i])) {
          // Look up to 8 lines before Billing Details for a standalone rate code
          for (let j = Math.max(0, i - 8); j < i; j++) {
            const line = lines[j].trim();
            // Rate codes are typically short alphanumeric like "LGS", "MGS-T", "SGS", "LPS" etc.
            const rm = line.match(/^([A-Z]{2,5}(?:-[A-Z0-9]{1,3})?)$/);
            if (rm) return rm;
            // Also match "LGS - 28M" style (code - modifier) on its own line or after address
            const rm2 = line.match(/\b([A-Z]{2,5})\s*[-\u2013]\s*([A-Z0-9]{1,5})\s*$/);
            if (rm2) return [null, rm2[1] + '-' + rm2[2]];
          }
          break;
        }
      }
      return null;
    })();

  // ── Charges ──
  // OCR-tolerant charge keywords: very loose matching for OCR garble
  // "Chg" can become: CNG, CHG, Ghg, Ch9, Cha, Chq, etc.
  const C = '(?:Ch[gaq9]|C[HhNnRr][Gg]|Gh[gq9])[.:]?';
  // Separator between the charge name and "Chg". OCR frequently inserts a stray
  // period instead of a space (e.g. "TDC.Chg", "ECA.Chg"), so we allow either
  // whitespace or a period here. Must match at least one character so keywords
  // like "Customer Chg" vs "CustomerChg" don't collide (none of these legitimately
  // run together, but we want to fail closed on the unseparated case).
  const SEP = '[ \\t\\n\\r.]+';
  // Customer: "Customer Chg" or OCR garble like "CUSIOMET CNG", "Customar Chg", "CUSIOMER CNG"
  const custChg = xChg('C[ua][s5][t1iI][o0][mM][eao][r1tT]' + SEP + C, null, 'CustomerCharge');
  const facKW =
    t
      .match(new RegExp('Fac[^ \\t\\n\\r]*' + SEP + C + '[ \\t\\n\\r]+([0-9,.]+)[ \\t\\n\\r]*[kK][Ww]', 'i'))?.[1]
      ?.replace(/,/g, '') || null;
  const facChg = xChg('Fac[^ \\t\\n\\r]*' + SEP + C, null, 'FacilitiesCharge');
  const demKW =
    t
      .match(new RegExp('Demand' + SEP + C + '[ \\t\\n\\r]+([0-9,.]+)[ \\t\\n\\r]*[kK][Ww]', 'i'))?.[1]
      ?.replace(/,/g, '') || null;
  const demChg = xChg('Demand' + SEP + C, null, 'BilledKWCharge');
  // ── Energy charges: date-aware On/Off Peak vs 3-tier ──
  // Kansas Evergy switched from 3-tier to On/Off Peak on 12/21/2023.
  // Before that date: 3 tiers (First 180h, Next 180h, Over 360h).
  // After: On Pk Sum/Win + Off Pk Sum/Win.
  // Always extract both formats — changeover bills (spanning 12/21/2023) have both.
  // tieredChg excludes On/Off Pk lines so there's no double-counting.
  const onPkChg = xChg('Energy' + SEP + C + '[ \\t\\n\\r]+On[ \\t\\n\\r]+P[kK]', null, 'EnergyOnPeakCharge');
  const offPkChg = xChg('Energy' + SEP + C + '[ \\t\\n\\r]+Off[ \\t\\n\\r]+P[kK]', null, 'EnergyOffPeakCharge');
  const tieredChg = xChg('Energy' + SEP + C, /On\s+P[kK]|Off\s+P[kK]/i);
  // E[CG]A tolerates Tesseract's C↔G confusion — e.g. the second ECA
  // part on Louis Elementary's Oct 2025 bill prints as "EGA Chg", which
  // a strict `ECA` match silently skipped so the $121.10 part was lost.
  const ecaChg = xChg('E[CG]A' + SEP + C, null, 'ECACharge');
  const eerChg = xChg('EER' + SEP + C, null, 'EERCharge');
  const ptsChg = xChg('PTS' + SEP + C, null, 'PTSCharge');
  // TDC kW qty lives on the charge line as "for <qty>" (OCR frequently splits
  // this across two lines with "KW at $rate" on the next line, and leaves stray
  // garbage characters like trailing 'i' or '(2' before the newline). Anchor the
  // qty capture off the "for" keyword instead of off "kW at" so we don't depend
  // on the garbage characters between qty and the kW token.
  const tdcKW =
    t
      .match(
        new RegExp('TD[CG]' + SEP + C + '[\\u0000-\\uFFFF]{0,150}?for[ \\t\\n\\r]+([0-9,]+\\.[0-9]{2,})', 'i'),
      )?.[1]
      ?.replace(/,/g, '') || null;
  const tdcChg = xChg('TD[CG]' + SEP + C, null, 'TDCCharge');
  // RkVA charge (reactive power)
  // The kVAR qty on the bill is the OVERAGE above 50% of billing kW demand, not total reactive.
  // E.g. 500 kW demand → 250 kVAR free; if reactive = 300, bill shows 50 kVAR × $0.663 = $33.15
  // The meter table RKVA Used is the full value; the charge line qty is only the excess.
  const rkvaChg = xChg('R[kK]VA' + SEP + C, null, 'RkVACharge');
  // Broadened: handle OCR variants "Tox exempt", "lax exempt", wrapped
  // lines, and stray punctuation like the smart quote in "Tax ‘exempt
  // delivery cost from bill" that Tesseract inserts on degraded scans.
  // `SEP_T` allows whitespace, straight/curly quotes/apostrophes, or
  // backticks between "Tax" and "exempt".
  const SEP_T = "[ \\t\\n\\r'`\\u2018\\u2019\\u201C\\u201D]+";
  const _taxExemptParts = [];
  const taxExempt = (() => {
    const lines = t.split('\n');
    const taxRe = new RegExp('[TIl][a@o0]x' + SEP_T + 'e?xempt', 'i');
    for (let i = 0; i < lines.length; i++) {
      if (!taxRe.test(lines[i])) continue;
      const sameLine = lines[i].match(/\$([\d,]+\.\d{2})/);
      if (sameLine) {
        _taxExemptParts.push(parseFloat(sameLine[1].replace(/,/g, '')));
        continue;
      }
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const nextLine = lines[j].match(/\$([\d,]+\.\d{2})/);
        if (nextLine) {
          _taxExemptParts.push(parseFloat(nextLine[1].replace(/,/g, '')));
          break;
        }
      }
    }
    if (!_taxExemptParts.length) return null;
    return _taxExemptParts.reduce((a, b) => a + b, 0).toFixed(2);
  })();
  // Parallel Generation Credit (Evergy 2LGAEP solar bills) — must extract BEFORE billOffset
  // so the fallback scan does not misidentify this credit as a Bill Offset.
  const parallelGenCredit = (() => {
    // Label and negative amount may be on the same line or split across two lines
    const m1 = t.match(/Parallel\s+Generation\s+Credit[^\n]*?-\$?([\d,]+\.\d{2})/i);
    if (m1) return '-' + m1[1].replace(/,/g, '');
    const m2 = t.match(/Parallel\s+Generation\s+Credit[^\n]*\n\s*-?\$?([\d,]+\.\d{2})/i);
    if (m2) return '-' + m2[1].replace(/,/g, '');
    return null;
  })();
  // Bill offset / credit: match "Bill offset" or any line with a negative dollar amount before Subtotal
  const billOffset = (() => {
    const m1 = t.match(/Bill\s+[0O]ff\w*[^\n]*?(-?\$[\d,]+\.\d{2}|-[\d,]+\.\d{2}|\$[\d,]+\.\d{2})/im);
    if (m1) return m1[1].replace(/\$/g, '');
    // OCR fallback: find negative dollar amount on a standalone line near Subtotal
    // Guard: skip lines that contain "Parallel" — those are captured as parallelGenCredit above
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/Subtotal/i.test(lines[i])) {
        // Check up to 3 lines before Subtotal for a negative amount
        for (let j = Math.max(0, i - 3); j < i; j++) {
          const neg = lines[j].match(/-\$?([\d,]+\.\d{2})/);
          if (neg && !/Payment|Previously|Late|Parallel/i.test(lines[j])) return '-' + neg[1].replace(/,/g, '');
        }
        break;
      }
    }
    return null;
  })();
  // Broadened: allow OCR garbles in "Franchise Fee" and accept franchise lines with
  // the amount on the next line too (PDF column wrap). Sums ALL matches for changeover
  // bills that have two prorated Franchise Fee lines.
  const _franchiseParts = [];
  const franchise = (() => {
    const lines = t.split('\n');
    const franRe = /Franch[il1]?[is5]?[e3]?\s+F[e3]{1,2}/i;
    let inAdjustments = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*Adjustments\s*$/i.test(lines[i])) inAdjustments = true;
      if (!franRe.test(lines[i])) continue;
      if (inAdjustments) continue;
      if (/[-–]\s*\$/.test(lines[i])) continue;
      const sameLine = lines[i].match(/\$([\d,]+\.\d{2})/);
      if (sameLine) {
        _franchiseParts.push(parseFloat(sameLine[1].replace(/,/g, '')));
        continue;
      }
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const nextLine = lines[j].match(/\$([\d,]+\.\d{2})/);
        if (nextLine) {
          _franchiseParts.push(parseFloat(nextLine[1].replace(/,/g, '')));
          break;
        }
      }
    }
    if (!_franchiseParts.length) return null;
    return _franchiseParts.reduce((a, b) => a + b, 0).toFixed(2);
  })();
  // Subtotal is the second independent total the bill prints (alongside
  // "Current Charges"). For Evergy tax-exempt accounts these two values
  // are always identical, so extracting both gives _postExtractionVerify
  // a ground-truth pair: when Subtotal and ocrTotal agree, compSum must
  // not be allowed to override them (a disagreement means a per-charge
  // extraction is wrong, not the total).
  const subtotalAmount = (() => {
    const _bdLast = (() => {
      const re = /Billing\s+Details/gi;
      let last = -1,
        _m;
      while ((_m = re.exec(t)) !== null) last = _m.index;
      return last;
    })();
    const _stRe = /Sub[tl]?ota[l1][\s\S]{0,30}?\$\s*([\d,]+\.\d{2})/gi;
    let _stLastM = null,
      _stM;
    while ((_stM = _stRe.exec(t)) !== null) {
      if (_bdLast >= 0 && _stM.index < _bdLast) continue;
      _stLastM = _stM;
    }
    return _stLastM ? _stLastM[1].replace(/,/g, '') : null;
  })();
  // Miscellaneous / Adjustments line (item f71c0013). The pre-mid-2025 4-page Evergy
  // template's front account-summary page prints three consecutive lines:
  //   Current Charges (details on back) ............................. $17,224.57
  //   Utility .............................................................. $16,912.24
  //   Miscellaneous.................................................. $312.33
  // "Utility" is the SAME dollar figure as the back Billing-Details page's own
  // Subtotal/"Current Charges" line (what the SECTION-BLEED GUARD in totalDue below
  // correctly selects). "Miscellaneous" (sign-preserved — a late-payment charge is
  // positive, a one-time merger credit is negative) is a real front-page-only amount
  // the back page never includes. Confirmed present (grep=0 on unaffected bills) only
  // when this line is actually printed — 2025-format bills without it are unaffected.
  const miscCharge = (() => {
    const m = t.match(/Miscellaneous\.{2,}\s*(-)?\$?\s*([\d,]+\.\d{2})/i);
    if (!m) return null;
    return (m[1] ? '-' : '') + m[2].replace(/,/g, '');
  })();
  // Front page's own "Current Charges (details on back)" total. Used ONLY below as a
  // self-check for the Miscellaneous reconciliation (Front - Misc == Back) — never
  // extracted as the total directly. Do not remove the SECTION-BLEED GUARD's rejection
  // of this same line in totalDue; that guard protects against real cross-bill
  // contamination and is orthogonal to this reconciliation.
  const frontCurrentCharges = (() => {
    const m = t.match(/Current\s+Charges\s*\(details\s+on\s+back\)[^\n]*?\$\s*([\d,]+\.\d{2})/i);
    return m ? m[1].replace(/,/g, '') : null;
  })();
  // Diagnostic: set when miscCharge is present but the Front - Misc == Back identity
  // does not hold (or Front total is missing so the identity can't be checked). In
  // that case totalDue below deliberately does NOT add miscCharge — flagged instead
  // of silently fabricating a total. Attached to result._miscUnreconciled after result
  // is built.
  let _miscUnreconciled = null;
  const totalDue = (() => {
    // Prefer "Current Charges" in the billing detail section (page 2/3, near Subtotal)
    // Page 1 "Current Charges" may be a summary total that differs from the utility detail total.
    // Strategy: find ALL "Current Charges" lines, prefer the one after "Billing Details" or "Subtotal".
    const lines = t.split('\n');
    let bestVal = null,
      bestDist = Infinity;
    let subtotalIdx = -1,
      bdIdx = -1,
      lastBdIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/Sub[tl]?ota[l1]/i.test(lines[i])) subtotalIdx = i;
      if (/Billing\s+Details/i.test(lines[i])) {
        if (bdIdx < 0) bdIdx = i;
        lastBdIdx = i;
      }
    }
    // SECTION-BLEED GUARD: a section may contain TRAILING text from the previous bill
    // (e.g. Bill 24 LHS page 52 inheriting Bill 23's "Current Charges $13,507.55" from
    // the end of page 51 via midpoint slicing). The ONLY Current Charges line that
    // belongs to THIS bill is one that appears at or after the LAST "Billing Details"
    // header in the section — anything before lastBdIdx is contamination.
    // Also check for "Utility" line under page 1 Current Charges (matches detail page total)
    for (let i = 0; i < lines.length; i++) {
      if (/Current\s+Charges/i.test(lines[i])) {
        // Reject Current Charges that appear BEFORE the last Billing Details header.
        if (lastBdIdx >= 0 && i < lastBdIdx) continue;
        const amt = getAmt(lines[i]);
        if (amt !== null) {
          // Distance from Subtotal line — closer = better (detail page)
          // When no Subtotal found, use line index as tiebreaker (prefer LAST match = detail page)
          const dist = subtotalIdx >= 0 ? Math.abs(i - subtotalIdx) : lines.length - i;
          if (dist < bestDist) {
            bestDist = dist;
            bestVal = amt;
          }
        }
        // Check next line for "Utility" sub-line (page 1 format: Current Charges / Utility: $X)
        if (i + 1 < lines.length && /Utilit/i.test(lines[i + 1])) {
          const uAmt = getAmt(lines[i + 1]);
          if (uAmt !== null) {
            const dist = subtotalIdx >= 0 ? Math.abs(i + 1 - subtotalIdx) : lines.length - i - 1;
            if (dist < bestDist) {
              bestDist = dist;
              bestVal = uAmt;
            }
          }
        }
      }
    }
    if (bestVal !== null) {
      // Cross-validate: if extracted total is much LARGER than calculated sum, it's likely
      // a page-1 account summary total, not the detail total. Trust the sum instead.
      const pf2 = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
      const calcSum =
        pf2(custChg) +
        pf2(facChg) +
        pf2(demChg) +
        pf2(onPkChg) +
        pf2(tieredChg) +
        pf2(offPkChg) +
        pf2(rkvaChg) +
        pf2(ecaChg) +
        pf2(eerChg) +
        pf2(ptsChg) +
        pf2(tdcChg) +
        pf2(taxExempt) +
        pf2(billOffset) +
        pf2(franchise);
      let chosenTotal = calcSum > 0 && bestVal > calcSum * 1.5 ? calcSum : bestVal;
      // MiscellaneousCharge reconciliation (item f71c0013): the SECTION-BLEED GUARD
      // above correctly rejects the front-summary page's own "Current Charges (details
      // on back)" line as a candidate for bestVal (protecting against real cross-bill
      // contamination) — but bestVal (the back-page total) never includes the front
      // page's Miscellaneous line item. Only add it when the reconciling identity
      // (Front Current Charges - Miscellaneous == back-page bestVal) holds to the cent
      // (tolerance $0.02 for OCR rounding); otherwise leave chosenTotal as-is and flag
      // rather than fabricate.
      if (miscCharge !== null) {
        const miscNum = parseFloat(miscCharge);
        if (frontCurrentCharges !== null) {
          const frontNum = parseFloat(frontCurrentCharges);
          if (Math.abs(frontNum - miscNum - bestVal) < 0.02) {
            chosenTotal = chosenTotal + miscNum;
          } else {
            _miscUnreconciled = { front: frontNum, misc: miscNum, back: bestVal, expected: frontNum - miscNum };
          }
        } else {
          // Miscellaneous line found but no front-page Current Charges total to check
          // the identity against — can't verify, so don't add it.
          _miscUnreconciled = { front: null, misc: miscNum, back: bestVal, expected: null };
        }
      }
      return chosenTotal.toFixed(2);
    }
    // Try Subtotal — but only the LAST one in the section, and only if it appears
    // after the last "Billing Details" header (same section-bleed guard as above).
    const _bdLastCharIdx = (() => {
      const re = /Billing\s+Details/gi;
      let last = -1,
        _m;
      while ((_m = re.exec(t)) !== null) last = _m.index;
      return last;
    })();
    const _stRe = /Sub[tl]?ota[l1][\s\S]*?\$\s*([\d,]+\.\d{2})/gi;
    let _stLastM = null;
    let _stM;
    while ((_stM = _stRe.exec(t)) !== null) {
      if (_bdLastCharIdx >= 0 && _stM.index < _bdLastCharIdx) continue;
      _stLastM = _stM;
    }
    if (_stLastM) return _stLastM[1].replace(/,/g, '');
    // Fallback: sum all extracted charges. This may be incomplete (e.g. CustomerCharge not yet
    // recovered by structural fallback), so _postExtractionVerify will recompute if needed.
    const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);
    const sum =
      pf(custChg) +
      pf(facChg) +
      pf(demChg) +
      pf(onPkChg) +
      pf(tieredChg) +
      pf(offPkChg) +
      pf(rkvaChg) +
      pf(ecaChg) +
      pf(eerChg) +
      pf(ptsChg) +
      pf(tdcChg) +
      pf(taxExempt) +
      pf(billOffset) +
      pf(franchise);
    return sum > 0 ? sum.toFixed(2) : null;
  })();

  // Post-clean helper for CustomerName: Evergy bills often print other
  // columns (Page X of Y, the `£` OCR artifact, stray column-separator
  // characters) on the same line as the customer name. The regexes match
  // greedily enough to occasionally pull those in. Strip:
  //   1. `£` and anything after (known OCR artifact).
  //   2. Anything after 3+ consecutive whitespace chars (OCR column gap —
  //      e.g. "USD #416                R           -" → "USD #416").
  //   3. Trailing single non-letter stray chars (dashes, bullets, pipes)
  //      with or without leading whitespace.
  //   4. Trailing single isolated letter (e.g. "USD 416 R" → "USD 416")
  //      — safer than stripping 2-char tails which could be legit
  //      abbreviations (HS / MS / ES / HQ).
  const _cleanCustomerName = (s) => {
    if (s == null) return null;
    return String(s)
      .replace(/\s*£.*$/, '')
      .replace(/\s{3,}.*$/, '')
      .replace(/[\s\-·•|]+$/, '')
      .replace(/\s+[A-Za-z]$/, '')
      .trim();
  };
  // Multi-meter bill: 2+ meter rows combined under type 'meter_change' (covers both a
  // mid-cycle physical meter swap and two simultaneously-active meters on one account).
  const _isMultiMeterChange = !!(_meterCombined && _meterCombined.type === 'meter_change');
  const result = {
    UtilityCompany: 'Evergy',
    CustomerName:
      // Relaxed: allow mixed-case letters so OCR producing "Circle Grove Elem" or
      // "CIRCLE GROVE" both match. The strict uppercase-only pattern missed bills
      // where Tesseract returned proper case.
      _cleanCustomerName(
        t.match(/Customer\s*Name[^A-Za-z\n]*([A-Za-z][A-Za-z0-9 .&'#\-]{2,}?)(?=\s+(?:Account|Page)|\n)/im)?.[1],
      ) ||
      _cleanCustomerName(
        t.match(
          /Customer\s*Name\s*:?\s*\n\s*(?:Account[^\n]*\n\s*)?([A-Za-z][A-Za-z0-9 .&'#\-]{2,}?)(?=\s+Page|\s*$)/im,
        )?.[1],
      ) ||
      _cleanCustomerName(
        t.match(/Customer\s*Name\s*:?\s*([A-Za-z][A-Za-z0-9 .&'#\-]{2,}?)(?=\s+(?:Page|Account)|\s*$)/im)?.[1],
      ) ||
      null,
    AccountNumber:
      acctOverride ||
      // FIX (2026-08-24, Louisburg visual audit bug #6): `\s+` -> `\s*`
      // between "Account" and "Number" (see `_EVG_ACCT`/`_acctForIdx`
      // comments for the confirmed real-bill glued-OCR example this covers).
      t.match(/Account\s*(?:Number\s*)?[:\s©®=]+\s*(\d[\d ]{4,18}\d)/im)?.[1]?.replace(/\s/g, '') ||
      null,
    ServiceAddress: addrOverride || t.match(_EVG_ADDR)?.[1]?.trim() || null,
    RateSchedule: rateMatch?.[1] || null,
    BillingPeriodStart: bpMatch?.[1] || null,
    BillingPeriodEnd: bpMatch?.[2] || null,
    NumberOfDays: numDays,
    MeterReadStart: _meterCombined?.startDate || meterRow?.[1] || _mlMeter?.startDate || null,
    MeterReadEnd: _meterCombined?.endDate || meterRow?.[2] || _mlMeter?.endDate || null,
    // Multi-meter (type: 'meter_change', 2+ rows): a single StartRead/EndRead spanning
    // different physical meters is not a real reading — leave null rather than mixing
    // rows into a false identity. Per-meter values live in Meter1_/Meter2_ fields below.
    StartRead: _isMultiMeterChange
      ? null
      : _meterCombined?.startRead ||
        meterRow?._fixedStartRead ||
        meterRow?.[5]?.replace(/,/g, '') ||
        _mlMeter?.startRead ||
        null,
    EndRead: _isMultiMeterChange
      ? null
      : _meterCombined?.endRead ||
        meterRow?._fixedEndRead ||
        meterRow?.[4]?.replace(/,/g, '') ||
        _mlMeter?.endRead ||
        null,
    // Multi-meter: ReadDifference is intentionally NOT combined here even though
    // _meterCombined sums it. It's the sum of two independently-OCR'd "difference"
    // columns, separate from kWhConsumed's sum of the "kWh used" column — the two sums
    // will never quite agree (e.g. 958.3596 vs 958.4766), which reads as an unexplained
    // mismatch to the user. Same treatment as StartRead/EndRead above: not a single valid
    // physical reading, so leave null. Per-meter values live in Meter1_/Meter2_ fields.
    ReadDifference: _isMultiMeterChange ? null : meterRow?._fixedDifference || meterRow?.[6]?.replace(/,/g, '') || null,
    MeterMultiplier: _meterCombined?.multiplier || meterRow?.[7]?.replace(/,/g, '') || _mlMeter?.multiplier || null,
    kWhConsumed: adjKwh,
    ActualKW: _meterCombined?.kw || meterRow?.[9] || _mlMeter?.kwUsed || null,
    ActualRKVA: _meterCombined?.rkva || meterRow?.[10] || _mlMeter?.rkvaUsed || null,
    CustomerCharge: custChg,
    FacilitiesKW: facKW,
    FacilitiesCharge: facChg,
    BilledKW: demKW,
    BilledKWCharge: demChg,
    EnergyOnPeakCharge: (() => {
      const p = (v) => (v ? parseFloat(v) : 0);
      const s = p(onPkChg) + p(tieredChg);
      return s > 0 ? s.toFixed(2) : null;
    })(),
    EnergyOffPeakCharge: offPkChg,
    ECACharge: ecaChg,
    EERCharge: eerChg,
    PTSCharge: ptsChg,
    TDCkW: tdcKW,
    TDCCharge: tdcChg,
    RkVACharge: rkvaChg,
    TaxExemptDelivery: taxExempt,
    BillOffset: billOffset,
    SolarCredit: parallelGenCredit,
    FranchiseFee: franchise,
    MiscellaneousCharge: miscCharge,
    TotalCurrentCharges: totalDue,
    MeterNumber: null,
    _subtotal: subtotalAmount,
  };
  // Diagnostic only (item f71c0013) — set when a Miscellaneous line was found but the
  // Front - Misc == Back identity didn't hold, so it was NOT added to TotalCurrentCharges.
  if (_miscUnreconciled) result._miscUnreconciled = _miscUnreconciled;

  // Flag multi-meter bills for transparency in debug output
  if (_meterCombined) {
    result._meterInfo = { type: _meterCombined.type, rows: _meterCombined.rows };
    if (_meterCombined.type === 'meter_change') {
      result._meterInfo.note = 'Meter change: ' + _meterCombined.rows + ' meter lines summed for kWh, max KW/RKVA used';
      const _mrClean = (s) => (s || '').replace(/,/g, '');
      if (_meterGroup.length >= 2) {
        const m1 = _meterGroup[0],
          m2 = _meterGroup[1];
        result.Meter1_ReadStart = m1[1] || null;
        result.Meter1_ReadEnd = m1[2] || null;
        result.Meter1_StartRead = m1._fixedStartRead || _mrClean(m1[5]) || null;
        result.Meter1_EndRead = m1._fixedEndRead || _mrClean(m1[4]) || null;
        result.Meter1_ReadDiff = m1._fixedDifference || _mrClean(m1[6]) || null;
        result.Meter1_Multiplier = _mrClean(m1[7]) || null;
        result.Meter1_kWh = _mrClean(m1[8]) || null;
        result.Meter1_KW = _mrClean(m1[9]) || null;
        result.Meter1_RKVA = _mrClean(m1[10]) || null;
        result.Meter2_ReadStart = m2[1] || null;
        result.Meter2_ReadEnd = m2[2] || null;
        result.Meter2_StartRead = m2._fixedStartRead || _mrClean(m2[5]) || null;
        result.Meter2_EndRead = m2._fixedEndRead || _mrClean(m2[4]) || null;
        result.Meter2_ReadDiff = m2._fixedDifference || _mrClean(m2[6]) || null;
        result.Meter2_Multiplier = _mrClean(m2[7]) || null;
        result.Meter2_kWh = _mrClean(m2[8]) || null;
        result.Meter2_KW = _mrClean(m2[9]) || null;
        result.Meter2_RKVA = _mrClean(m2[10]) || null;
      }
    } else if (_meterCombined.type === 'solar') {
      result._meterInfo.note = 'Solar net meter: using Delivered row only for consumption';
      // Capture generation kWh from the generation (KW=0) meter row
      const _genRow = _meterCombined.received;
      if (_genRow) {
        const _genKwh = parseFloat((_genRow[8] || '').replace(/,/g, ''));
        if (_genKwh > 0) result.GenerationKwh = _genKwh.toFixed(4);
      }
    }
  }

  // Diagnostic only (item 0d47ad08 subtask 5) — never silent: rows excluded from the
  // meter_change sum because their derived service address (or, as fallback,
  // MeterMultiplier) didn't match row[0]'s (_meterGroup above). Not gated on
  // _meterCombined being truthy, since a group that shrinks to 1 row makes
  // _meterCombined null (falls through to the single-meter path) — the exclusion
  // still needs to be surfaced. Skipped for solar bills: _meterGroup is not used by
  // the solar branch, so an address mismatch there (if any) excludes nothing real.
  if (!_hasSolarLabels && _meterGroupExcluded.length) {
    result._meterRowsExcluded = _meterGroupExcluded.map((row) => ({
      address: row._addr || null,
      multiplier: (row[7] || '').replace(/,/g, '') || null,
      kWh: (row[8] || '').replace(/,/g, '') || null,
    }));
  }

  // Flag OCR digit corrections applied to meter reads
  const _digitFixes = [];
  for (const row of _meterRows) {
    if (row._fixedEndRead)
      _digitFixes.push({ field: 'EndRead', original: row._endReadOriginal, corrected: row._fixedEndRead });
    if (row._fixedStartRead)
      _digitFixes.push({ field: 'StartRead', original: row._startReadOriginal, corrected: row._fixedStartRead });
    if (row._fixedDifference)
      _digitFixes.push({ field: 'Difference', original: row._differenceOriginal, corrected: row._fixedDifference });
  }
  if (_digitFixes.length) {
    result._digitCorrections = _digitFixes;
  }

  // ── Rate info for cross-validation (rate × qty vs OCR'd charge) ──
  const _rates = {};
  const _rFac = xRate('Fac[^ \\t\\n\\r]*' + SEP + C);
  const _rDem = xRate('Demand' + SEP + C);
  const _rOnPk = xRate('Energy' + SEP + C + '[ \\t\\n\\r]+On[ \\t\\n\\r]+P[kK]');
  const _rOffPk = xRate('Energy' + SEP + C + '[ \\t\\n\\r]+Off[ \\t\\n\\r]+P[kK]');
  const _rTiered = xRate('Energy' + SEP + C, /On\s+P[kK]|Off\s+P[kK]/i);
  const _rEca = xRate('E[CG]A' + SEP + C);
  // 3rd arg `true` opts EER into the Comparative-Usage-Information table-bleed
  // strip (see xRate's TABLE_MARKER/_cleanTableWindowLine comment above for
  // why ECA deliberately does NOT opt in). Item 5129e92f, 2026-06-30.
  const _rEer = xRate('EER' + SEP + C, null, true);
  const _rPts = xRate('PTS' + SEP + C);
  const _rTdc = xRate('TD[CG]' + SEP + C);
  const _rRkva = xRate('R[kK]VA' + SEP + C);
  // ── UNIT-TYPE VALIDATION ──
  // xRate's GAP tolerance (40 chars including newlines) can occasionally match qty/rate
  // from the NEXT charge line when the current line's qty/rate was OCR-garbled. On
  // Bill 30 LHS page 58, xRate for EnergyOffPeakCharge captured RkVA Chg's
  // {qty: 116.04, rate: 0.663, unit: 'kW'} because the Off-Peak line's own qty was
  // unreadable. Reject any kWh-based charge that came back with unit='kW' — it's
  // definitely cross-field aliasing.
  const _unitIsKwh = (r) => r && r.unit && r.unit.toLowerCase().includes('h');
  const _unitIsKw = (r) => r && r.unit && !r.unit.toLowerCase().includes('h');
  const _kwhCharges = [_rOnPk, _rTiered, _rOffPk, _rEca, _rEer, _rPts];
  for (let _i = 0; _i < _kwhCharges.length; _i++) {
    if (_kwhCharges[_i] && _unitIsKw(_kwhCharges[_i])) {
      _kwhCharges[_i] = null;
    }
  }
  const [_rOnPkOk, _rTieredOk, _rOffPkOk, _rEcaOk, _rEerOk, _rPtsOk] = _kwhCharges;
  // Facilities/Demand/TDC/RkVA are kW-based — same check in reverse.
  const _rFacOk = _unitIsKw(_rFac) ? _rFac : null;
  const _rDemOk = _unitIsKw(_rDem) ? _rDem : null;
  const _rTdcOk = _unitIsKw(_rTdc) ? _rTdc : null;
  const _rRkvaOk = _unitIsKw(_rRkva) ? _rRkva : null;

  if (_rFacOk) _rates.FacilitiesCharge = _rFacOk;
  if (_rDemOk) _rates.BilledKWCharge = _rDemOk;
  if (_rOnPkOk || _rTieredOk) {
    // Combine on-peak and tiered (changeover bills have both)
    // Flatten inner parts from both sources so each individual charge line is preserved
    const allParts = [_rOnPkOk, _rTieredOk].filter(Boolean).flatMap((r) => r.parts || [r]);
    _rates.EnergyOnPeakCharge = {
      qty: allParts.reduce((s, r) => s + r.qty, 0),
      rate: allParts[0].rate,
      unit: allParts[0].unit,
      computed: allParts.reduce((s, r) => s + r.computed, 0),
      parts: allParts,
    };
  }
  if (_rOffPkOk) _rates.EnergyOffPeakCharge = _rOffPkOk;
  // Flag energy format: 'on_off_peak' if On-Peak found, 'tiered' if only tiered, 'changeover' if both
  if (_rOnPkOk && _rTieredOk) result._energyFormat = 'changeover';
  else if (_rOnPkOk || _rOffPkOk) result._energyFormat = 'on_off_peak';
  else if (_rTieredOk) result._energyFormat = 'tiered';
  if (_rEcaOk) _rates.ECACharge = _rEcaOk;
  if (_rEerOk) _rates.EERCharge = _rEerOk;
  if (_rPtsOk) _rates.PTSCharge = _rPtsOk;
  if (_rTdcOk) _rates.TDCCharge = _rTdcOk;
  if (_rRkvaOk) _rates.RkVACharge = _rRkvaOk;
  if (_taxExemptParts.length > 1) {
    _rates.TaxExemptDelivery = {
      qty: null,
      rate: null,
      unit: null,
      computed: _taxExemptParts.reduce((a, b) => a + b, 0),
      parts: _taxExemptParts.map((v) => ({ qty: null, rate: null, unit: null, computed: v, ocrCharge: v })),
    };
  }
  if (_franchiseParts.length > 1) {
    _rates.FranchiseFee = {
      qty: null,
      rate: null,
      unit: null,
      computed: _franchiseParts.reduce((a, b) => a + b, 0),
      parts: _franchiseParts.map((v) => ({ qty: null, rate: null, unit: null, computed: v, ocrCharge: v })),
    };
  }
  for (const [chargeKey, partAmounts] of Object.entries(_xChgParts)) {
    if (!_rates[chargeKey]) {
      _rates[chargeKey] = {
        qty: null,
        rate: null,
        unit: null,
        computed: partAmounts.reduce((a, b) => a + b, 0),
        parts: partAmounts.map((v) => ({ qty: null, rate: null, unit: null, computed: v, ocrCharge: v })),
      };
    } else if (partAmounts.length > (_rates[chargeKey].parts || []).length) {
      const existingParts = _rates[chargeKey].parts || [];
      const existingAmounts = existingParts.map((p) => p.ocrCharge ?? p.computed);
      for (const amt of partAmounts) {
        const matchIdx = existingAmounts.indexOf(amt);
        if (matchIdx >= 0) {
          existingAmounts.splice(matchIdx, 1);
          continue;
        }
        existingParts.push({
          qty: null,
          rate: null,
          unit: existingParts[0]?.unit || null,
          computed: amt,
          ocrCharge: amt,
        });
      }
      _rates[chargeKey].parts = existingParts;
      // 2026-07-08 (louisburg-8f39b3ee): a part xRate fully parsed (has BOTH qty and
      // rate) already carries a trustworthy rate-derived `computed` — prefer it over
      // `ocrCharge`, which can be a garbled OCR digit misread (e.g. Circle Grove May
      // bill: printed "$82.08" vs. the true 5455.7967 kWh x $0.01521 = $82.98 — a
      // genuine $0.90 OCR error the per-part validator, energy-savings.js ~3450-3465,
      // already flags but this recompute was silently erasing at the field level).
      // Only fall back to ocrCharge/computed for parts xChg supplied that xRate could
      // not parse at all (qty AND rate both null) — those have no rate-derived value
      // to prefer in the first place.
      _rates[chargeKey].computed = existingParts.reduce(
        (s, p) => s + (p.qty != null && p.rate != null ? p.computed : (p.ocrCharge ?? p.computed)),
        0,
      );
    }
  }
  if (Object.keys(_rates).length) result._rates = _rates;
  if (Object.keys(_xChgParts).length) result._xChgParts = _xChgParts;

  // Extract individual per-unit rates and compute totals for bill storage
  const _gr = (k) => (_rates[k] && _rates[k].rate > 0 ? _rates[k].rate : 0);
  const _wavg = (k) => {
    const ri = _rates[k];
    if (!ri) return 0;
    if (ri.parts && ri.parts.length > 1) {
      const totalQty = ri.parts.reduce((s, p) => s + (p.qty || 0), 0);
      if (totalQty > 0) {
        return ri.parts.reduce((s, p) => s + (p.qty || 0) * (p.rate || 0), 0) / totalQty;
      }
    }
    return ri.rate || 0;
  };
  const _getQty = (k) => {
    const ri = _rates[k];
    if (!ri) return 0;
    if (ri.parts && ri.parts.length > 1) return ri.parts.reduce((s, p) => s + (p.qty || 0), 0);
    return ri.qty || 0;
  };
  result.FacilitiesRate = _gr('FacilitiesCharge') || null;
  result.DemandRate = _gr('BilledKWCharge') || null;
  result.TDCRate = _gr('TDCCharge') || null;
  result.RkVARate = _gr('RkVACharge') || null;
  result.OnPeakRate = _gr('EnergyOnPeakCharge') || null;
  result.OffPeakRate = _gr('EnergyOffPeakCharge') || null;
  result.ECARate = _wavg('ECACharge') || null;
  result.EERRate = _wavg('EERCharge') || null;
  result.PTSRate = _wavg('PTSCharge') || null;
  // Total rates: total charges / total quantity (effective rate)
  const _kwhChargeSum =
    _pf(result.EnergyOnPeakCharge) +
    _pf(result.EnergyOffPeakCharge) +
    _pf(result.ECACharge) +
    _pf(result.EERCharge) +
    _pf(result.PTSCharge);
  const _totalKwh = _pf(result.kWhConsumed);
  result.TotalKWhRate = _totalKwh > 0 && _kwhChargeSum > 0 ? _kwhChargeSum / _totalKwh : null;
  const _kwChargeSum = _pf(result.FacilitiesCharge) + _pf(result.BilledKWCharge) + _pf(result.TDCCharge);
  const _totalKw = _pf(result.BilledKW) || _pf(result.ActualKW) || _pf(result.FacilitiesKW);
  result.TotalKWRate = _totalKw > 0 && _kwChargeSum > 0 ? _kwChargeSum / _totalKw : null;

  // Reconcile xChg totals with xRate computed totals: when xRate found
  // multi-part charges that xChg missed (e.g. EER Part 2 has no OCR dollar
  // amount so xChg only captured Part 1's $0.00), use the xRate computed sum.
  for (const [chargeField, ri] of Object.entries(_rates)) {
    if (!ri || !ri.parts || ri.parts.length < 2) continue;
    const computedTotal = ri.parts.reduce((s, p) => s + (p.ocrCharge != null ? p.ocrCharge : p.computed), 0);
    const currentVal = result[chargeField] ? parseFloat(String(result[chargeField]).replace(/[$,\s]/g, '')) || 0 : 0;
    if (computedTotal > currentVal + 0.01) {
      result[chargeField] = computedTotal.toFixed(2);
    }
  }

  // Evergy business rule: Bill Offset and Tax Exempt Delivery are always
  // mirror opposites — same absolute amount, opposite signs. If either
  // is present but the other is missing, derive the missing one.
  // Previously only ran one direction (TaxExempt → BillOffset), so a
  // bill where the TaxExempt line was OCR-garbled (e.g. Louis Elementary
  // Oct 2025 where "Tax ‘exempt" broke the regex) lost the $790.51
  // value even though BillOffset captured "-$790.51".
  // Guard: do NOT apply mirror rule on parallel-generation bills (SolarCredit present).
  // On those bills the credit is a Parallel Generation Credit, NOT a TaxExemptDelivery mirror.
  const _pfTE = (v) => (v ? parseFloat(String(v).replace(/[$,\s]/g, '')) || 0 : 0);
  const _teVal = _pfTE(result.TaxExemptDelivery);
  const _boVal = _pfTE(result.BillOffset);
  if (result.SolarCredit) {
    // Parallel-gen bill: suppress mirror derivation entirely
  } else if (_teVal && !_boVal) {
    result.BillOffset = '-' + Math.abs(_teVal).toFixed(2);
  } else if (_boVal && !_teVal) {
    // BillOffset is negative; TaxExemptDelivery is the positive mirror.
    result.TaxExemptDelivery = Math.abs(_boVal).toFixed(2);
  } else if (_teVal && _boVal) {
    // Both extracted. The Evergy bill often prints the Bill Offset line
    // without an explicit minus sign (e.g. Bill 29 "Bill offset voices, $629.18"),
    // so OCR captures it as positive and the sign gets lost. Enforce the
    // mirror rule: TaxExempt positive, BillOffset negative, equal magnitude.
    const teAbs = Math.abs(_teVal);
    const boAbs = Math.abs(_boVal);
    // Always enforce mirror rule — TaxExemptDelivery and BillOffset must
    // cancel out. OCR often misreads one digit (e.g. 1556 vs 1566).
    // Use whichever value is closer to matching other bill arithmetic.
    const avg = (teAbs + boAbs) / 2;
    result.TaxExemptDelivery = teAbs.toFixed(2);
    result.BillOffset = '-' + teAbs.toFixed(2);
  }

  // ── STRUCTURAL POSITION FALLBACK: use _EVG_CHARGE_ORDER to recover missing values ──
  // See charge ordering constant defined above _extractEvergy.
  if (!result.CustomerCharge) {
    // Customer Charge is always the FIRST dollar amount after "Billing Details - service from"
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (
        /Billing\s+Details|B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]/i.test(lines[i]) &&
        /service\s+from|serv[il1]ce\s+from[:\s]/i.test(lines[i])
      ) {
        // First charge line is Customer Charge — scan next few lines for first dollar amount
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          // Skip lines that are clearly Facilities or Demand (they come later)
          if (/Fac\S|Demand|Energy/i.test(lines[j])) break;
          const amt = getAmt(lines[j]);
          if (amt !== null && amt > 10 && amt < 500) {
            result.CustomerCharge = amt.toFixed(2);
            break;
          }
        }
        break;
      }
    }
  }

  // ── METER NUMBER EXTRACTION ──
  if (!result.MeterNumber) {
    const meterNumMatch =
      t.match(/Meter\s*(?:Number|No|#|Num)[^A-Za-z0-9\n]*(\d[\d\-A-Z]{3,20})/im) ||
      t.match(/Meter\s*:\s*(\d[\d\-A-Z]{3,20})/im);
    if (meterNumMatch) result.MeterNumber = meterNumMatch[1].trim();
  }

  // ── SMART FALLBACKS: infer missing meter/usage fields from available data ──

  // 1. ActualKW fallback from BilledKW/TDCkW. Two trigger conditions:
  //    a) BilledKW is not a whole number → it's the real metered demand, not a floor
  //    b) BilledKW === TDCkW → the same demand drove both charge lines, so it's the
  //       real reading (the LGS Secondary 200 kW floor would diverge these values).
  if (!result.ActualKW && result.BilledKW) {
    const bkw = parseFloat(String(result.BilledKW).replace(/,/g, ''));
    const tkw = result.TDCkW ? parseFloat(String(result.TDCkW).replace(/,/g, '')) : NaN;
    if (!isNaN(bkw) && bkw > 0) {
      const nonWhole = bkw % 1 !== 0;
      const matchesTDC = !isNaN(tkw) && tkw > 0 && Math.abs(bkw - tkw) < 0.01;
      if (nonWhole || matchesTDC) result.ActualKW = result.BilledKW;
    }
  }

  // 2. kWhConsumed fallback from largest kWh value in billing details
  if (!result.kWhConsumed) {
    const allKwh = [...t.matchAll(/([\d,]+\.\d+)\s*kWh/gi)]
      .map((m) => parseFloat(m[1].replace(/,/g, '')))
      .filter((v) => v > 100 && v < 2000000);
    if (allKwh.length) result.kWhConsumed = String(Math.max(...allKwh));
  }

  // 3. MeterReadStart/End: validate as date (MM/DD) and close to BillingPeriod dates
  // Meter read dates should always be within ~5 days of the billing period start/end
  const _validateMeterDate = (meterDateStr, billingDateStr) => {
    if (!meterDateStr) return null;
    // Must look like a date: 1-2 digit month / 1-2 digit day
    const dm = String(meterDateStr).match(/^(\d{1,2})\/?(\d{1,2})$/);
    if (!dm) return null;
    const mo = parseInt(dm[1], 10),
      dy = parseInt(dm[2], 10);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    // If we have a billing period date, check proximity (within 5 days)
    if (billingDateStr) {
      try {
        const bp = new Date(billingDateStr);
        if (!isNaN(bp)) {
          // Build a full date using billing period's year
          const mrd = new Date(bp.getFullYear(), mo - 1, dy);
          // Handle year boundary (Dec billing → Jan meter read or vice versa)
          if (Math.abs(mrd - bp) > 180 * 86400000) {
            mrd.setFullYear(mrd.getFullYear() + (mrd < bp ? 1 : -1));
          }
          const daysDiff = Math.abs(mrd - bp) / 86400000;
          if (daysDiff > 5) return null; // too far from billing period — likely OCR garbage
        }
      } catch (e) {}
    }
    return String(mo).padStart(2, '0') + '/' + String(dy).padStart(2, '0');
  };
  // Validate existing MeterReadStart/End values
  result.MeterReadStart = _validateMeterDate(result.MeterReadStart, result.BillingPeriodStart);
  result.MeterReadEnd = _validateMeterDate(result.MeterReadEnd, result.BillingPeriodEnd);
  // Fallback from billing period dates (meter read = billing +1 day)
  if (!result.MeterReadStart && result.BillingPeriodStart) {
    try {
      const d = new Date(result.BillingPeriodStart);
      d.setDate(d.getDate() + 1);
      result.MeterReadStart = String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    } catch (e) {}
  }
  if (!result.MeterReadEnd && result.BillingPeriodEnd) {
    try {
      const d = new Date(result.BillingPeriodEnd);
      d.setDate(d.getDate() + 1);
      result.MeterReadEnd = String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    } catch (e) {}
  }

  // 4. ActualRKVA fallback from RkVA charge line kW value
  if (!result.ActualRKVA) {
    const rkvaKwM = t.match(/R[kK]VA\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[.:]?\s+([\d,.]+)\s*[kK][Ww]/i);
    if (rkvaKwM) result.ActualRKVA = rkvaKwM[1].replace(/,/g, '');
  }

  // 5. THREE-WAY VERIFICATION: qty × rate = charge
  // For each charge line, if we have any 2 of {qty, rate, charge}, compute and verify the 3rd.
  // Also recover missing kW/kWh values from charge/rate, and missing charges from qty×rate.
  if (result._rates) {
    // Map charge fields to their quantity fields
    const QTY_MAP = {
      FacilitiesCharge: 'FacilitiesKW',
      BilledKWCharge: 'BilledKW',
      TDCCharge: 'TDCkW',
      RkVACharge: null, // RkVA qty is in rate info but not a separate field
      EnergyOnPeakCharge: null,
      EnergyOffPeakCharge: null, // kWh qty from rate info
      ECACharge: null,
      EERCharge: null,
      PTSCharge: null,
    };
    for (const [chargeField, ri] of Object.entries(result._rates)) {
      if (!ri || ri.rate <= 0) continue;
      const qtyField = QTY_MAP[chargeField];
      const chargeVal = _pf(result[chargeField]);
      const parts = ri.parts || [ri];

      // ── PER-PART VALIDATION ──
      // Every charge line gets the same validation: qty × rate × (prorationRatio) ≈ ocrCharge.
      // For multi-line charges (split demand, split ECA, etc.), each line is checked independently.
      // If the line has "(for N of Y days)" proration, the expected charge is prorated too —
      // otherwise prorated charges falsely appear as big mismatches.
      const partDetails = [];
      for (const part of parts) {
        const ratio = part.prorationNum && part.prorationDen ? part.prorationNum / part.prorationDen : 1;
        const expected = Math.round(part.qty * part.rate * ratio * 100) / 100;
        const actual = part.ocrCharge ?? part.computed;
        const diff = Math.abs(expected - actual);
        partDetails.push({
          qty: part.qty,
          rate: part.rate,
          unit: part.unit,
          computed: expected,
          ocrCharge: actual,
          diff,
          valid: diff <= 0.05,
        });
      }

      // Verify the sum of per-line charges matches the extracted total charge
      const computedTotal = Math.round(parts.reduce((s, p) => s + p.computed, 0) * 100) / 100;
      const ocrTotal = parts.reduce((s, p) => s + (p.ocrCharge ?? p.computed), 0);
      const totalDiff = Math.abs(ocrTotal - chargeVal);

      if (totalDiff > 0.1 && chargeVal > 0) {
        result['_rate_mismatch_' + chargeField] = {
          splitCharge: parts.length > 1,
          parts: partDetails,
          computedTotal,
          ocrTotal: Math.round(ocrTotal * 100) / 100,
          actualCharge: chargeVal,
          diff: totalDiff,
        };
      }

      // Flag any individual parts where qty × rate ≠ ocrCharge
      const badParts = partDetails.filter((p) => !p.valid);
      if (badParts.length > 0) {
        result['_part_mismatches_' + chargeField] = badParts;
      }

      // ── SINGLE-PART RATE AUTO-CORRECTION (Bug aa94a957) ──
      // When OCR reads a rate that doesn't match charge ÷ qty (e.g. $0.08266 instead
      // of $0.03266), derive the correct rate as charge / qty and replace it in _rates.
      // Only applies when: exactly one part, charge is known (>0), qty is known (>0),
      // and the mismatch exceeds 5% of the charge. This avoids touching valid small
      // rounding errors while catching OCR digit-substitution errors like the above.
      if (parts.length === 1 && chargeVal > 0 && parts[0].qty > 0 && badParts.length > 0) {
        const _ocr_rate = parts[0].rate;
        const _derived_rate = chargeVal / parts[0].qty;
        const _pctDiff = Math.abs(_ocr_rate - _derived_rate) / chargeVal;
        if (_pctDiff > 0.05) {
          // Replace the stale rate in _rates so downstream consumers use the correct value
          result._rates[chargeField] = Object.assign({}, ri, {
            rate: _derived_rate,
            parts: [Object.assign({}, parts[0], { rate: _derived_rate, computed: chargeVal })],
          });
          result['_auto_corrected_rate_' + chargeField] = {
            ocrRate: _ocr_rate,
            derivedRate: _derived_rate,
            charge: chargeVal,
            qty: parts[0].qty,
            reason: 'charge_div_qty',
          };
          // Clear the mismatch flags — the correction resolves them
          delete result['_rate_mismatch_' + chargeField];
          delete result['_part_mismatches_' + chargeField];
        }
      }

      // For kW charges with a qty field: validate the extracted kW against the parts
      if (qtyField) {
        const qtyVal = _pf(result[qtyField]);
        if (qtyVal > 0) {
          // For split kW charges, all parts use the same kW — don't sum them
          const partKW = parts[0].qty;
          const allSameKW = parts.every((p) => Math.abs(p.qty - partKW) < 0.01);
          if (allSameKW && Math.abs(qtyVal - partKW) < 0.01) {
            // Extracted kW matches the charge lines — all good
          } else if (!allSameKW) {
            // Different kW values across parts (unusual) — leave as-is
          }
        } else if (parts.length > 0) {
          // Missing kW — recover from the first part
          result[qtyField] = parts[0].qty.toFixed(4);
          result['_rate_filled_' + qtyField] = true;
        }
      }

      // Missing charge — compute from parts sum
      if (chargeVal <= 0 && computedTotal > 0) {
        result[chargeField] = computedTotal.toFixed(2);
        result['_rate_filled_' + chargeField] = true;
      }
      // ── MULTI-PART CHARGE RECOVERY ──
      // When xChg captured only the FIRST part of a kW-charge that was split across a
      // rate change (e.g. Bill 23 TDC Chg on LHS pages 50-51), chargeVal is
      // significantly less than the parts sum. Replace with computedTotal which now
      // respects the date-range proration added above.
      //
      // GATED on "all parts share the same qty" — that's the structural signature of
      // rate-change proration (same peak kW, different rate tiers). kWh charges with
      // tiered rates have DIFFERENT qty per part (kWh consumed in each tier) and must
      // NOT be touched by recovery — their xChg sum is already correct.
      else if (parts.length > 1 && computedTotal > 0 && chargeVal > 0) {
        // ── OCR GROUND-TRUTH DEFENSE ──
        // If the sum of the per-part OCR'd charges reconciles with the top-level OCR
        // charge within $0.02, the bill's own arithmetic is self-consistent — trust it
        // and do NOT substitute computedTotal, which can be wrong (proration bugs, rate
        // misreads, tier-boundary misattribution). computed is math; ocrCharge is ink.
        // Bill 1 ECA on LHS.pdf: ocrCharges 158.97 + 2027.18 = 2186.15 exactly matches
        // result.ECACharge=2186.15; computedTotal came back as 1910.42 due to proration
        // bugs. Without this gate, recovery clobbered the correct OCR value with wrong math.
        const ocrReconciles = Math.abs(ocrTotal - chargeVal) <= 0.02;
        if (!ocrReconciles) {
          const firstQty = parts[0].qty;
          const allSameQty = parts.every((p) => Math.abs(p.qty - firstQty) < 0.01);
          if (allSameQty) {
            const diff = Math.abs(chargeVal - computedTotal);
            const rel = diff / computedTotal;
            if (diff > 0.5 && rel > 0.1) {
              result[chargeField] = computedTotal.toFixed(2);
              result['_multi_part_recovered_' + chargeField] = {
                original: chargeVal.toFixed(2),
                corrected: computedTotal.toFixed(2),
                partsCount: parts.length,
              };
            }
          }
        }
      }
      // ── SINGLE-PART CHARGE RECOVERY (Update 85) ──
      // When a charge line has exactly one part, that part's OCR charge column
      // came back null (meaning it was garbled/truncated on the line), and the
      // top-level chargeVal differs materially from qty × rate, trust the math.
      // Classic case: LHS.pdf page 58 Bill 30 — EER charge column was OCR'd as
      // just "06" (column cutoff) so parts[0].ocrCharge = null, and the top-level
      // EER regex reached forward and captured PTS's $86.61. qty × rate = 57.06
      // is ground truth here because the rate was successfully parsed from the
      // same line (via "$0.00056 per kWh") and qty matches kWhConsumed.
      else if (parts.length === 1 && parts[0].ocrCharge == null && computedTotal > 0 && chargeVal > 0) {
        const diff = Math.abs(chargeVal - computedTotal);
        if (diff > 0.5) {
          result[chargeField] = computedTotal.toFixed(2);
          result['_single_part_recovered_' + chargeField] = {
            original: chargeVal.toFixed(2),
            corrected: computedTotal.toFixed(2),
            reason: 'ocr_null_charge_bleed',
          };
          // The mismatch that triggered recovery is now resolved — clear the stale
          // flags so _postExtractionVerify's final decision doesn't treat them as
          // unresolved contamination and block trusting compSum.
          delete result['_rate_mismatch_' + chargeField];
          delete result['_part_mismatches_' + chargeField];
        }
      }

      // ── MULTI-PART NULL-OCR FLAG CLEANUP ──
      // For kWh charges (ECA, EER, PTS) where all parts have ocrCharge == null,
      // per-part validation flags are false alarms — the parts were garbled but
      // the total charge was correct or recovered. Clear the stale flag.
      if (parts.length > 1 && result['_part_mismatches_' + chargeField]) {
        const allPartsOcrNull = parts.every((p) => p.ocrCharge == null);
        if (allPartsOcrNull) {
          delete result['_part_mismatches_' + chargeField];
        }
      }

      // ── POPULATE TOP-LEVEL kWh QTY FIELDS FOR SAVE PATH ──
      // The save paths (_saveSinglePDFBill, _applyDupUpdate, _saveBillToMatchedMeter)
      // read result.OnPeakKWh / result.OffPeakKWh when building the Utility Data row.
      // Without this, onPeakKwh / offPeakKwh stay null in the saved row even though
      // onPeakCost / offPeakCost populate from the charge dollars. The kWh qty lives
      // in _rates.EnergyOn(Off)PeakCharge.qty — mirror it to the top-level result.
      const KWH_QTY_MAP = {
        EnergyOnPeakCharge: 'OnPeakKWh',
        EnergyOffPeakCharge: 'OffPeakKWh',
      };
      const kwhField = KWH_QTY_MAP[chargeField];
      if (kwhField && ri.qty > 0 && ri.unit && ri.unit.toLowerCase().includes('h')) {
        const existing = _pf(result[kwhField]);
        if (existing <= 0) {
          result[kwhField] = ri.qty.toFixed(4);
          result['_rate_filled_' + kwhField] = true;
        }
      }
    }
    // Also try to recover TDCkW from TDCCharge/rate when xRate didn't capture the TDC rate
    // but we can derive it from the charge and a known TDC rate from the raw text
    if (!result._rates.TDCCharge && result.TDCCharge) {
      // Look for TDC rate directly in the text
      const tdcRateM = t.match(/TD[CG]\s+(?:Ch[gaq9]|C[HhNnRr][Gg]|Gh[gq9])[\s\S]{0,100}?\$?([\d.]+)\s*per\s+k[Ww]/i);
      if (tdcRateM) {
        const tdcRate = parseFloat(tdcRateM[1]);
        const tdcCharge = _pf(result.TDCCharge);
        if (tdcRate > 0 && tdcCharge > 0) {
          const tdcQty = parseFloat((tdcCharge / tdcRate).toFixed(4));
          if (tdcQty > 0 && tdcQty < 5e6) {
            if (!result.TDCkW || result.TDCkW === null) {
              result.TDCkW = tdcQty.toFixed(4);
              result['_rate_filled_TDCkW'] = true;
            }
            // Store rate info for debug
            result._rates.TDCCharge = {
              qty: tdcQty,
              rate: tdcRate,
              unit: 'kW',
              computed: Math.round(tdcQty * tdcRate * 100) / 100,
            };
          }
        }
      }
    }
  }

  // ── On-Peak recovery from kWh identity: OnPeak + OffPeak ≈ kWhConsumed ──
  if (!result.EnergyOnPeakCharge && result.EnergyOffPeakCharge && result.kWhConsumed && _rates.EnergyOffPeakCharge) {
    const totalKwh = _pf(result.kWhConsumed);
    const offPkKwh = _rates.EnergyOffPeakCharge.qty || 0;
    const onPkKwh = totalKwh - offPkKwh;
    if (onPkKwh > 0) {
      const _coreSum =
        _pf(result.CustomerCharge) +
        _pf(result.FacilitiesCharge) +
        _pf(result.BilledKWCharge) +
        _pf(result.EnergyOffPeakCharge) +
        _pf(result.ECACharge) +
        _pf(result.EERCharge) +
        _pf(result.PTSCharge) +
        _pf(result.TDCCharge) +
        _pf(result.RkVACharge) +
        _pf(result.TaxExemptDelivery) +
        _pf(result.BillOffset) +
        _pf(result.FranchiseFee) +
        _pf(result.MiscellaneousCharge);
      const _coreTotal = _pf(result.TotalCurrentCharges);
      const _onPkCharge = Math.round((_coreTotal - _coreSum) * 100) / 100;
      if (_onPkCharge > 0) {
        result.EnergyOnPeakCharge = _onPkCharge.toFixed(2);
        result.OnPeakKWh = onPkKwh.toFixed(4);
        result['_auto_recovered_EnergyOnPeakCharge'] = {
          original: null,
          corrected: _onPkCharge.toFixed(2),
          reason:
            'Sum gap $' +
            _onPkCharge.toFixed(2) +
            '; kWh identity: ' +
            totalKwh.toFixed(2) +
            ' - ' +
            offPkKwh.toFixed(2) +
            ' off-peak = ' +
            onPkKwh.toFixed(2) +
            ' on-peak kWh',
        };
      }
    }
  }

  // Off-Peak kWh recovery from identity: OffPeakKWh = kWhConsumed - OnPeakKWh
  // Run this whenever OffPeakKWh is missing but we have the data to derive it
  if (!result.OffPeakKWh && result.kWhConsumed && _rates.EnergyOnPeakCharge && result.OnPeakKWh) {
    const totalKwh = _pf(result.kWhConsumed);
    const onPkKwh = _pf(result.OnPeakKWh);
    const offPkKwh = totalKwh - onPkKwh;
    if (offPkKwh > 0) {
      result.OffPeakKWh = offPkKwh.toFixed(4);
      result['_auto_recovered_OffPeakKWh'] = {
        original: null,
        corrected: offPkKwh.toFixed(4),
        reason:
          'kWh identity: ' +
          totalKwh.toFixed(2) +
          ' total - ' +
          onPkKwh.toFixed(2) +
          ' on-peak = ' +
          offPkKwh.toFixed(2) +
          ' off-peak',
      };
    }
  }

  // Off-Peak charge recovery from sum gap when charge is missing
  if (result.EnergyOnPeakCharge && !result.EnergyOffPeakCharge && result.kWhConsumed && _rates.EnergyOnPeakCharge) {
    const totalKwh = _pf(result.kWhConsumed);
    const onPkKwh = _rates.EnergyOnPeakCharge.qty || 0;
    const offPkKwh = totalKwh - onPkKwh;
    if (offPkKwh > 0) {
      const _coreSum =
        _pf(result.CustomerCharge) +
        _pf(result.FacilitiesCharge) +
        _pf(result.BilledKWCharge) +
        _pf(result.EnergyOnPeakCharge) +
        _pf(result.ECACharge) +
        _pf(result.EERCharge) +
        _pf(result.PTSCharge) +
        _pf(result.TDCCharge) +
        _pf(result.RkVACharge) +
        _pf(result.TaxExemptDelivery) +
        _pf(result.BillOffset) +
        _pf(result.FranchiseFee) +
        _pf(result.MiscellaneousCharge);
      const _coreTotal = _pf(result.TotalCurrentCharges);
      const _offPkCharge = Math.round((_coreTotal - _coreSum) * 100) / 100;
      if (_offPkCharge > 0) {
        result.EnergyOffPeakCharge = _offPkCharge.toFixed(2);
        if (!result.OffPeakKWh) result.OffPeakKWh = offPkKwh.toFixed(4);
        result['_auto_recovered_EnergyOffPeakCharge'] = {
          original: null,
          corrected: _offPkCharge.toFixed(2),
          reason:
            'Sum gap $' +
            _offPkCharge.toFixed(2) +
            '; kWh identity: ' +
            totalKwh.toFixed(2) +
            ' total - ' +
            onPkKwh.toFixed(2) +
            ' on-peak = ' +
            offPkKwh.toFixed(2) +
            ' off-peak',
        };
      }
    }
  }

  // Invariant check + auto-correct: OnPeakKWh + OffPeakKWh should equal kWhConsumed
  if (result.OnPeakKWh && result.OffPeakKWh && result.kWhConsumed) {
    const onPk = _pf(result.OnPeakKWh);
    const offPk = _pf(result.OffPeakKWh);
    const total = _pf(result.kWhConsumed);
    const diff = Math.abs(onPk + offPk - total);
    if (diff > 1) {
      let corrected = false;
      const onRi = _rates.EnergyOnPeakCharge;
      const offRi = _rates.EnergyOffPeakCharge;
      if (onRi && onRi.rate > 0 && _pf(result.EnergyOnPeakCharge) > 0) {
        const derivedOn = _pf(result.EnergyOnPeakCharge) / onRi.rate;
        if (derivedOn > 0 && Math.abs(derivedOn + offPk - total) < 1) {
          result['_auto_corrected_OnPeakKWh'] = {
            original: result.OnPeakKWh,
            corrected: derivedOn.toFixed(4),
            reason:
              'Derived from charge ($' +
              _pf(result.EnergyOnPeakCharge).toFixed(2) +
              ') / rate ($' +
              onRi.rate.toFixed(5) +
              ') = ' +
              derivedOn.toFixed(4) +
              ' kWh. Fixes identity: ' +
              derivedOn.toFixed(2) +
              ' + ' +
              offPk.toFixed(2) +
              ' = ' +
              total.toFixed(2),
          };
          result.OnPeakKWh = derivedOn.toFixed(4);
          if (onRi.qty) onRi.qty = derivedOn;
          corrected = true;
        }
      }
      if (!corrected && offRi && offRi.rate > 0 && _pf(result.EnergyOffPeakCharge) > 0) {
        const derivedOff = _pf(result.EnergyOffPeakCharge) / offRi.rate;
        if (derivedOff > 0 && Math.abs(onPk + derivedOff - total) < 1) {
          result['_auto_corrected_OffPeakKWh'] = {
            original: result.OffPeakKWh,
            corrected: derivedOff.toFixed(4),
            reason:
              'Derived from charge ($' +
              _pf(result.EnergyOffPeakCharge).toFixed(2) +
              ') / rate ($' +
              offRi.rate.toFixed(5) +
              ') = ' +
              derivedOff.toFixed(4) +
              ' kWh. Fixes identity: ' +
              onPk.toFixed(2) +
              ' + ' +
              derivedOff.toFixed(2) +
              ' = ' +
              total.toFixed(2),
          };
          result.OffPeakKWh = derivedOff.toFixed(4);
          if (offRi.qty) offRi.qty = derivedOff;
          corrected = true;
        }
      }
      if (!corrected) {
        const derivedOn = total - offPk;
        if (derivedOn > 0) {
          result['_auto_corrected_OnPeakKWh'] = {
            original: result.OnPeakKWh,
            corrected: derivedOn.toFixed(4),
            reason:
              'kWhConsumed (' +
              total.toFixed(2) +
              ') - OffPeakKWh (' +
              offPk.toFixed(2) +
              ') = ' +
              derivedOn.toFixed(4),
          };
          result.OnPeakKWh = derivedOn.toFixed(4);
          corrected = true;
        }
      }
      if (!corrected) {
        result['_kwh_identity_mismatch'] = {
          onPeakKwh: onPk,
          offPeakKwh: offPk,
          total: total,
          diff: diff,
        };
      }
    }
  }

  // Derive missing qty from charge/rate when possible
  const CHARGE_TO_QTY = {
    EnergyOnPeakCharge: { qtyField: 'OnPeakKWh', rateKey: 'EnergyOnPeakCharge' },
    EnergyOffPeakCharge: { qtyField: 'OffPeakKWh', rateKey: 'EnergyOffPeakCharge' },
  };
  Object.entries(CHARGE_TO_QTY).forEach(([chargeField, { qtyField, rateKey }]) => {
    if (_pf(result[chargeField]) > 0 && !result[qtyField]) {
      const ri = _rates[rateKey];
      if (ri && ri.rate > 0) {
        const derivedQty = _pf(result[chargeField]) / ri.rate;
        if (derivedQty > 0 && derivedQty < 1e7) {
          result[qtyField] = derivedQty.toFixed(4);
          result['_auto_derived_' + qtyField] = {
            from: chargeField + ' / rate',
            charge: result[chargeField],
            rate: ri.rate,
            qty: derivedQty.toFixed(4),
          };
        }
      }
    }
  });

  // ── CHARGE RECONCILIATION: if sum doesn't match total, try to recover missing charges ──
  const _compSum =
    Math.round(
      (_pf(result.CustomerCharge) +
        _pf(result.FacilitiesCharge) +
        _pf(result.BilledKWCharge) +
        _pf(result.EnergyOnPeakCharge) +
        _pf(result.EnergyOffPeakCharge) +
        _pf(result.ECACharge) +
        _pf(result.EERCharge) +
        _pf(result.PTSCharge) +
        _pf(result.TDCCharge) +
        _pf(result.RkVACharge) +
        _pf(result.TaxExemptDelivery) +
        _pf(result.BillOffset) +
        _pf(result.FranchiseFee) +
        _pf(result.SolarCredit) +
        _pf(result.RenewableCharge) +
        _pf(result.MiscellaneousCharge)) *
        100,
    ) / 100;
  const _total = _pf(result.TotalCurrentCharges);
  if (_total > 0 && Math.abs(_compSum - _total) > 1) {
    // Try to find missing charges by scanning ALL dollar amounts between "Billing Details" and "Subtotal"
    const bdIdx = t.search(/Billing\s+Details/i);
    const stIdx = t.search(/Subtotal/i);
    if (bdIdx >= 0 && stIdx > bdIdx) {
      const section = t.substring(bdIdx, stIdx);
      const allAmts = [];
      const lines2 = section.split('\n');
      for (const line of lines2) {
        const ms = [...line.matchAll(/\$([\d,]+\.\d{2})/g)];
        for (const m of ms) {
          const before = line.slice(Math.max(0, m.index - 4), m.index);
          const after = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
          if (/at\s*$/.test(before)) continue;
          if (/\s*[Pp][eo]r\s+k/i.test(after)) continue;
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val < 1 && /\.\d{3,}/.test(m[1])) continue;
          allAmts.push({ val, line: line.trim() });
        }
      }
      // Find amounts not already captured
      const capturedVals = Object.values(result)
        .filter((v) => v !== null && v !== '')
        .map((v) => _pf(v))
        .filter((v) => v > 0);
      const uncaptured = allAmts.filter(
        (a) => !capturedVals.some((c) => Math.abs(c - a.val) < 0.01) && Math.abs(a.val) > 0.5,
      );
      // Try to assign uncaptured amounts to missing fields
      for (const uc of uncaptured) {
        const lcLine = uc.line.toLowerCase();
        if (!result.CustomerCharge && /cust|custo/i.test(lcLine)) result.CustomerCharge = uc.val.toFixed(2);
        else if (!result.FacilitiesCharge && /fac/i.test(lcLine)) result.FacilitiesCharge = uc.val.toFixed(2);
        else if (!result.RkVACharge && /rkva|rkv/i.test(lcLine)) result.RkVACharge = uc.val.toFixed(2);
        else if (!result.EnergyOnPeakCharge && /energy.*on\s*p|on\s*peak/i.test(lcLine))
          result.EnergyOnPeakCharge = uc.val.toFixed(2);
        else if (!result.FranchiseFee && /franch/i.test(lcLine)) result.FranchiseFee = uc.val.toFixed(2);
        else if (!result.TaxExemptDelivery && /tax.*exempt/i.test(lcLine)) result.TaxExemptDelivery = uc.val.toFixed(2);
        else if (!result.BillOffset && /bill.*offset|offset/i.test(lcLine)) result.BillOffset = (-uc.val).toFixed(2);
        if (!result.FacilitiesKW && /fac/i.test(lcLine)) {
          const kwM = uc.line.match(/([\d,.]+)\s*[kK][Ww]/);
          if (kwM) result.FacilitiesKW = kwM[1].replace(/,/g, '');
        }
      }
    }
  }
  // Gap inference: core charges are fields that appear on virtually every
  // bill. Optional fields (RkVA, TaxExempt, BillOffset, FranchiseFee) are
  // legitimately null on most bills and should not block gap recovery.
  const _coreChargeFields = [
    'CustomerCharge',
    'FacilitiesCharge',
    'BilledKWCharge',
    'EnergyOnPeakCharge',
    'EnergyOffPeakCharge',
    'ECACharge',
    'EERCharge',
    'PTSCharge',
    'TDCCharge',
  ];
  const _allChargeFields = [
    ..._coreChargeFields,
    'RkVACharge',
    'TaxExemptDelivery',
    'BillOffset',
    'FranchiseFee',
    'MiscellaneousCharge',
  ];
  const _recompSum = _allChargeFields.reduce((s, f) => s + _pf(result[f]), 0);
  const _recompTotal = _pf(result.TotalCurrentCharges);
  const _recompGap = _recompTotal - _recompSum;
  if (_recompTotal > 0 && _recompGap > 0.5) {
    const nullCore = _coreChargeFields.filter((f) => result[f] === null || result[f] === undefined);
    const target = nullCore.length === 1 ? nullCore[0] : null;
    if (target) {
      result[target] = _recompGap.toFixed(2);
      result['_auto_recovered_' + target] = {
        original: null,
        corrected: _recompGap.toFixed(2),
        reason: 'Inferred from sum gap: total $' + _recompTotal.toFixed(2) + ' - charges $' + _recompSum.toFixed(2),
      };
    }
  }

  // ── RKVA DECIMAL FIX: ActualRKVA should have same decimal places as ActualKW ──
  // OCR often drops the decimal from RKVA (e.g. "538100" should be "53.8100")
  if (result.ActualRKVA && result.ActualKW) {
    const rkvaStr = String(result.ActualRKVA).replace(/,/g, '');
    const kwStr = String(result.ActualKW).replace(/,/g, '');
    const kwVal = parseFloat(kwStr);
    const rkvaVal = parseFloat(rkvaStr);
    // If RKVA has no decimal but KW does, or RKVA is way too large relative to KW
    if (kwVal > 0 && rkvaVal > 0 && !rkvaStr.includes('.') && kwStr.includes('.')) {
      // Insert decimal at same position as KW's decimal
      const kwDecPos = kwStr.indexOf('.');
      const kwIntDigits = kwStr.split('.')[0].length;
      const kwDecDigits = kwStr.split('.')[1]?.length || 0;
      // RKVA should have similar magnitude — try inserting decimal to give same decimal places
      if (rkvaStr.length > kwDecDigits) {
        const fixed =
          rkvaStr.slice(0, rkvaStr.length - kwDecDigits) + '.' + rkvaStr.slice(rkvaStr.length - kwDecDigits);
        const fixedVal = parseFloat(fixed);
        // Sanity: RKVA is typically 0-500, similar order of magnitude as KW
        if (fixedVal > 0 && fixedVal < kwVal * 5) {
          result.ActualRKVA = fixed;
        }
      }
    }
  }

  // ── DECIMAL FORMAT ENFORCEMENT (per Evergy Billing Details rules) ──
  // kW = #,###.#### (4 dp), kWh = #,###.#### (4 dp), charges = $#,###.## (2 dp)
  // StartRead/EndRead = ##,###.#### (4 dp), MeterMultiplier = ##.#### (4 dp)
  const _pad4 = (v) => {
    if (!v) return v;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? v : n.toFixed(4);
  };
  for (const k of ['FacilitiesKW', 'BilledKW', 'ActualKW', 'ActualRKVA', 'TDCkW']) {
    if (result[k]) result[k] = _pad4(result[k]);
  }
  // ── OCR DECIMAL RECOVERY: kW fields should be ###.#### (~3 digits + 4 decimals) ──
  // If OCR dropped the decimal, "475.5360" becomes "4755360.0000" (7-digit integer part).
  // Fix: if integer part has 5+ digits, reinsert decimal 4 places from the right of the
  // raw digit string to recover the original ###.#### format.
  for (const k of ['FacilitiesKW', 'BilledKW', 'ActualKW', 'ActualRKVA', 'TDCkW']) {
    if (!result[k]) continue;
    const n = parseFloat(String(result[k]).replace(/,/g, ''));
    if (isNaN(n) || n <= 10000) continue;
    const raw = String(result[k]).replace(/,/g, '').replace(/\..*/, '');
    if (raw.length >= 5) {
      const fixed = parseFloat(raw.slice(0, raw.length - 4) + '.' + raw.slice(raw.length - 4));
      if (fixed > 0 && fixed < 10000) {
        result['_ocr_decimal_fix_' + k] = { original: result[k], corrected: fixed.toFixed(4) };
        result[k] = fixed.toFixed(4);
      }
    }
  }
  // Same logic for kWh: should be ###,###.#### (~6 digits + 4 decimals).
  // If integer part has 8+ digits, OCR likely dropped the decimal.
  if (result.kWhConsumed) {
    const kwhN = parseFloat(String(result.kWhConsumed).replace(/,/g, ''));
    if (!isNaN(kwhN) && kwhN > 2000000) {
      const raw = String(result.kWhConsumed).replace(/,/g, '').replace(/\..*/, '');
      if (raw.length >= 8) {
        const fixed = parseFloat(raw.slice(0, raw.length - 4) + '.' + raw.slice(raw.length - 4));
        if (fixed > 0 && fixed < 2000000) {
          result['_ocr_decimal_fix_kWhConsumed'] = { original: result.kWhConsumed, corrected: fixed.toFixed(4) };
          result.kWhConsumed = fixed.toFixed(4);
        }
      }
    }
  }
  if (result.StartRead) result.StartRead = _pad4(result.StartRead);
  if (result.EndRead) result.EndRead = _pad4(result.EndRead);
  if (result.ReadDifference) result.ReadDifference = _pad4(result.ReadDifference);
  if (result.MeterMultiplier) result.MeterMultiplier = _pad4(result.MeterMultiplier);
  if (result.kWhConsumed) result.kWhConsumed = _pad4(result.kWhConsumed);

  // ── METER ROLLOVER DETECTION (Feature 0de6c188) ──
  // When EndRead < StartRead it may be a legitimate odometer rollover rather than
  // an OCR error. Check if StartRead was near a rollover boundary (5-, 6-, or 7-digit
  // maximum) AND EndRead is relatively small (< 10% of the boundary). If so, compute
  // the correct usage as: boundary + 1 - StartRead + EndRead and flag the result.
  const _detectRollover = (endR, startR) => {
    if (endR <= 0 || startR <= 0 || endR >= startR) return null; // only applies when endR < startR
    const boundaries = [99999, 999999, 9999999]; // 5-, 6-, 7-digit odometer limits
    for (const boundary of boundaries) {
      const threshold = boundary * 0.9; // "near boundary" = last 10% of range
      const maxSmall = boundary * 0.1; // "small" endR = first 10% of new cycle
      if (startR > threshold && endR < maxSmall) {
        const rolloverUsage = boundary + 1 - startR + endR;
        return { boundary, rolloverUsage };
      }
    }
    return null;
  };
  if (result.EndRead && result.StartRead) {
    const _erR = parseFloat(String(result.EndRead).replace(/,/g, ''));
    const _srR = parseFloat(String(result.StartRead).replace(/,/g, ''));
    if (_erR > 0 && _srR > 0 && _erR < _srR) {
      const rv = _detectRollover(_erR, _srR);
      if (rv) {
        result._meterRollover = {
          boundary: rv.boundary,
          startRead: _srR,
          endRead: _erR,
          rolloverUsage: rv.rolloverUsage,
          reason:
            'Meter rollover detected: StartRead ' +
            _srR +
            ' near boundary ' +
            rv.boundary +
            ', EndRead ' +
            _erR +
            ' is start of new cycle. Usage = ' +
            rv.boundary +
            '+1−' +
            _srR +
            '+' +
            _erR +
            ' = ' +
            rv.rolloverUsage,
        };
        // Rollover ReadDifference is the wrap-around usage, not a simple subtraction
        result.ReadDifference = rv.rolloverUsage.toFixed(4);
      }
    }
  }

  // ── SANITY CHECK: EndRead and StartRead should be similar magnitude ──
  // OCR garble like "512252699" (should be "51,225.2699") — missing decimal/comma.
  // Check 1: If one value has a decimal and the other doesn't, the one without is likely garbled.
  // Check 2: If values differ by more than 10x, the larger one is garbled.
  // Check 3: Meter reads typically range 1,000–999,999. Values over 10M are suspect.
  if (result.EndRead && result.StartRead) {
    const erStr = String(result.EndRead),
      srStr = String(result.StartRead);
    const er = parseFloat(erStr),
      sr = parseFloat(srStr);
    if (er > 0 && sr > 0) {
      // Skip sanity checks for confirmed rollovers — the small EndRead is legitimate
      const _isRollover = !!result._meterRollover;
      // Check for missing decimal (one has it, the other doesn't)
      const erDec = erStr.includes('.'),
        srDec = srStr.includes('.');
      if (!_isRollover && erDec !== srDec && Math.max(er, sr) / Math.min(er, sr) > 100) {
        if (!erDec) result.EndRead = null;
        else result.StartRead = null;
      }
      // Absolute magnitude check — reads over 10M are almost certainly garbled
      if (result.EndRead && er > 10000000) result.EndRead = null;
      if (result.StartRead && sr > 10000000) result.StartRead = null;
      // Ratio check — skip for confirmed rollovers (ratio will be very small but valid)
      if (!_isRollover && result.EndRead && result.StartRead) {
        const ratio = parseFloat(result.EndRead) / parseFloat(result.StartRead);
        if (ratio > 10) result.EndRead = null;
        else if (ratio < 0.1) result.StartRead = null;
      }
    }
  }

  // ── CROSS-VALIDATION: meter read calc vs kWhConsumed ──
  // For multi-meter (meter change): calculate per-row and sum. For single-meter: one calc.
  const _cvMeterCalc = (() => {
    const pn = (s) => parseFloat((s || '').replace(/,/g, '')) || 0;
    if (_meterCombined && _meterCombined.type === 'meter_change') {
      // Sum (EndRead - StartRead) × Multiplier for each row
      let total = 0;
      for (const r of _meterRows) {
        const er = pn(r._fixedEndRead || r[4]),
          sr = pn(r._fixedStartRead || r[5]),
          mm = pn(r[7]);
        if (er > 0 && sr > 0 && mm > 0) total += parseFloat(((er - sr) * mm).toFixed(4));
      }
      return total > 0 ? total : null;
    }
    // Single meter row
    if (result.EndRead && result.StartRead && result.MeterMultiplier) {
      const er = pn(result.EndRead),
        sr = pn(result.StartRead),
        mm = pn(result.MeterMultiplier);
      if (er > 0 && sr > 0 && mm > 0) {
        // For rollover bills, use the pre-computed rolloverUsage instead of er - sr
        if (result._meterRollover) {
          const rolloverDiff = result._meterRollover.rolloverUsage;
          return parseFloat((rolloverDiff * mm).toFixed(4));
        }
        return parseFloat(((er - sr) * mm).toFixed(4));
      }
    }
    return null;
  })();
  if (_cvMeterCalc !== null) {
    const extractedKwh = parseFloat(String(result.kWhConsumed || '0').replace(/,/g, ''));
    if (extractedKwh > 0 && _cvMeterCalc > 0) {
      const diff = Math.abs(_cvMeterCalc - extractedKwh);
      const tolerance = Math.max(1, extractedKwh * 0.01);
      if (diff > tolerance) {
        // Flag the discrepancy but do NOT override — the kWh Used column from the bill
        // is more reliable than (EndRead - StartRead) × Multiplier when reads have OCR errors.
        // The cross-validation serves as a warning, not an auto-correction for kWh.
        result._kwhCrossCheck = { extracted: extractedKwh, calculated: _cvMeterCalc, diff };
      }
    } else if (!extractedKwh && _validKwh(_cvMeterCalc)) {
      result.kWhConsumed = _cvMeterCalc.toFixed(4);
    }
  }

  return result;
}

// OCR-tolerant patterns for Evergy bills
// Common OCR misreads: g→q/9, l→1/I, D→O, a→o, s→5, i→l, e→c
const _EVG_BILLING_DETAILS = /B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]{1,2}[s5]?\s*[-\u2013\—]\s*[s5]erv[il1]ce\s+from/i;
const _EVG_SERVICE_FROM = /[s5]erv[il1]ce\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/i;
const _EVG_CHG = /Ch[gaq9][.:]?/i; // matches Chg, Cha, Chq, Ch9, Chg.
// FIX (2026-08-24, Louisburg visual audit bug #6): `\s+` -> `\s*` between
// "Account" and "Number" — real OCR glues them into one token on some pages
// ("AccountNumber", no space) even though the printed digits are legible.
// See the matching fix + comment on `_acctForIdx` further below for the
// confirmed real-bill example.
const _EVG_ACCT = /[Aa]ccount\s*(?:N[ou]mber\s*)?[^0-9A-Za-z\n]{0,6}(\d[\d ]{4,18}\d)/m;
const _EVG_ADDR =
  /^(\d+\s+\w[\w\s,]{3,50}(?:KS|MO|KY|OK|NE|IA|AR|TX|CO|IL|IN|OH|MI|PA|NY|NJ|CT|MA|VA|NC|SC|GA|FL|TN|MS|AL|LA|NM|AZ|UT|ID|OR|WA|MT|WY|ND|SD|MN|WI|NV|CA))\s*$/m;

// Shared helpers for the City of Louisburg + Propane rules below.
function _lbg_splitPages(t) {
  const markers = [...t.matchAll(/%%PAGE_(\d+)%%/g)];
  if (!markers.length) return [t];
  const pages = [];
  for (let i = 0; i < markers.length; i++) {
    const s = markers[i].index;
    const e = i + 1 < markers.length ? markers[i + 1].index : t.length;
    pages.push(t.slice(s, e));
  }
  return pages;
}
// OCR-noise-tolerant cents parser: "1460-87" → 1460.87, "2333" → 23.33.
function _lbg_cleanCents(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/,/g, '');
  s = s.replace(/^(-?\d+)-(\d{2})$/, '$1.$2');
  if (/^-?\d+$/.test(s) && s.replace('-', '').length >= 4) {
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    s = (neg ? '-' : '') + abs.slice(0, -2) + '.' + abs.slice(-2);
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
const _LBG_GAS_RATES = [{ effectiveDate: '2000-01-01', rate: 0.798062, baseCharge: 23.33 }];
function _lbg_gasRate(billDate) {
  let rate = _LBG_GAS_RATES[0];
  if (billDate) {
    const p = String(billDate).split('/');
    const iso =
      p.length === 3
        ? (p[2].length === 2 ? '20' + p[2] : p[2]) + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0')
        : '';
    for (const r of _LBG_GAS_RATES) {
      if (iso >= r.effectiveDate) rate = r;
    }
  }
  return rate;
}
function _lbg_correctGasCharge(gasCharge, gasUsage, totalCharge, billDate) {
  const r = _lbg_gasRate(billDate);
  const expectedCharge = Math.round(gasUsage * r.rate * 100) / 100;
  const chargeDiff = Math.abs(gasCharge - expectedCharge);
  if (chargeDiff < 1.0) return { charge: gasCharge, total: totalCharge, corrected: false };
  const fromTotal = Math.round((totalCharge - r.baseCharge) * 100) / 100;
  if (fromTotal > 0 && Math.abs(fromTotal - expectedCharge) < 1.0) {
    return {
      charge: fromTotal,
      total: totalCharge,
      corrected: true,
      reason: 'Derived from Total ($' + totalCharge.toFixed(2) + ') - Base ($' + r.baseCharge.toFixed(2) + ')',
    };
  }
  const reinterpretedCharge = parseFloat(
    String(gasCharge).replace(/\./g, '').slice(0, -2) + '.' + String(gasCharge).replace(/\./g, '').slice(-2),
  );
  if (!isNaN(reinterpretedCharge) && Math.abs(reinterpretedCharge - expectedCharge) < 1.0) {
    const corrTotal = reinterpretedCharge + r.baseCharge;
    return {
      charge: reinterpretedCharge,
      total: corrTotal,
      corrected: true,
      reason: 'OCR decimal fix: ' + gasCharge + ' → ' + reinterpretedCharge.toFixed(2) + ' (matches rate × usage)',
    };
  }
  if (expectedCharge > 0) {
    const ratio = gasCharge > 0 ? expectedCharge / gasCharge : Infinity;
    if (ratio > 4 || ratio < 0.25) {
      return { charge: gasCharge, total: totalCharge, corrected: false };
    }
    const corrTotal = expectedCharge + r.baseCharge;
    return {
      charge: expectedCharge,
      total: corrTotal,
      corrected: true,
      reason: 'Computed from ' + gasUsage + ' therms × $' + r.rate + '/therm = $' + expectedCharge.toFixed(2),
    };
  }
  return { charge: gasCharge, total: totalCharge, corrected: false };
}

// Reconciles a garbled or missing Louisburg Gas charge against the page's
// Current Bill total (this period's Water + Gas + Sewer + Stormwater sum)
// minus the OTHER three commodities, which _extractNew already parsed
// independently (backlog 5884be3d, 37f76621). Only ever called when the raw
// Gas charge already failed a plausibility check — never overrides a clean
// value. Returns { total, variable, corrected: true, reason } when the
// derived value independently rate-validates (within $1 of usage × rate —
// the same tolerance _lbg_correctGasCharge uses), or
// { corrected: false, reason } when it does not uniquely determine a value.
// Callers MUST NOT apply an unvalidated derived value — hold for manual
// confirmation instead. Never guesses.
function _lbg_reconcileGasFromCurrentBill(currentBillTotal, otherCommoditySum, gasUsage, fuelAdj, billDate) {
  if (currentBillTotal == null) {
    return { corrected: false, reason: 'No Current Bill total was printed/legible on this page to reconcile against.' };
  }
  if (!(gasUsage > 0)) {
    return { corrected: false, reason: 'Gas usage is unknown — cannot rate-validate a derived charge.' };
  }
  const r = _lbg_gasRate(billDate);
  const derivedTotalWithFA = Math.round((currentBillTotal - otherCommoditySum) * 100) / 100;
  const derivedTotal = Math.round((derivedTotalWithFA - (fuelAdj || 0)) * 100) / 100;
  const derivedVariable = Math.round((derivedTotal - r.baseCharge) * 100) / 100;
  const expected = Math.round(gasUsage * r.rate * 100) / 100;
  if (derivedTotal > 0 && Math.abs(derivedVariable - expected) < 1.0) {
    return {
      total: derivedTotal,
      variable: derivedVariable,
      corrected: true,
      reason:
        'Derived from Current Bill ($' +
        currentBillTotal.toFixed(2) +
        ') - other commodities ($' +
        otherCommoditySum.toFixed(2) +
        ') — matches ' +
        gasUsage +
        ' therms × $' +
        r.rate +
        '/therm.',
    };
  }
  return {
    corrected: false,
    reason:
      'Current Bill ($' +
      currentBillTotal.toFixed(2) +
      ') minus other commodities ($' +
      otherCommoditySum.toFixed(2) +
      ') = $' +
      derivedTotal.toFixed(2) +
      ', which does not match ' +
      gasUsage +
      ' therms × $' +
      r.rate +
      '/therm (expected $' +
      expected.toFixed(2) +
      ') — not uniquely determined.',
  };
}

// Builds the split "Gas" bill for a Louisburg new-format page, or null when
// there's genuinely no Gas commodity on the page. Centralizes the garbled-
// charge (rate exceeds $2.00/therm ceiling) and missing-charge (label
// matched, no charge token parsed) recovery paths so both go through the
// same reconcile-or-hold logic (backlog 5884be3d, 37f76621) — never a
// silent guess, never a silent drop.
function _lbg_buildGasBill(shared, gas, gasLineSeen, otherCommoditySum, currentBillTotal, signedFuelAdj, billDate) {
  const r = _lbg_gasRate(billDate);
  const base = {
    ...shared,
    Commodity: 'Gas',
    StartRead: gas.prevRead || null,
    EndRead: gas.currRead || null,
    NaturalGasTherms: gas.usage || null,
    CustomerCharge: r.baseCharge,
    FuelAdjustment: signedFuelAdj,
  };
  const heldBill = (reason, originalCharge) => ({
    ...base,
    GasCharge: null,
    TotalCurrentCharges: null,
    TotalAmountDue: null,
    _gateTripped: true,
    _gateReasons: [reason],
    _manualReview: true,
    _manualReviewLabel: 'Gas charge could not be verified — held for manual confirmation',
    _correction_pending_GasCharge: { original: originalCharge, reason },
  });

  if (gas.charge == null) {
    if (!gasLineSeen) return null; // no Gas section on this page — nothing to report
    // Gas label matched but OCR dropped/reordered the charge token so none
    // could be parsed after it. Never silently drop the commodity.
    const recon = _lbg_reconcileGasFromCurrentBill(
      currentBillTotal,
      otherCommoditySum,
      gas.usage,
      signedFuelAdj,
      billDate,
    );
    if (!recon.corrected) {
      return heldBill('Gas charge could not be parsed. ' + recon.reason, null);
    }
    const gasTotal = recon.total + (signedFuelAdj || 0);
    return {
      ...base,
      GasCharge: recon.variable,
      TotalCurrentCharges: gasTotal.toFixed(2),
      TotalAmountDue: gasTotal.toFixed(2),
      _auto_corrected_GasCharge: { original: null, corrected: recon.variable, reason: recon.reason },
    };
  }
  if (gas.charge === 0) return null; // no charge printed for this commodity

  let gasTotal = gas.charge;
  let gasVariable = Math.round(Math.max(0, gasTotal - r.baseCharge) * 100) / 100;
  if ((!gas.usage || gas.usage === 0) && gasVariable > 0 && r.rate > 0) {
    gas.usage = Math.round(gasVariable / r.rate);
  }
  let corrected = gas.usage > 0 ? _lbg_correctGasCharge(gasVariable, gas.usage, gasTotal, billDate) : null;
  if (corrected && corrected.corrected) {
    gasVariable = corrected.charge;
    gasTotal = corrected.total;
  }
  // Rate-ceiling sanity check (mirrors bill-analysis.js's GAS SANITY PASS,
  // $2.00/therm). _lbg_correctGasCharge's own heuristics (fromTotal /
  // reinterpreted-decimal / ratio) can still miss a badly garbled charge —
  // e.g. a dropped decimal point turning $0.95 into $324.00 (backlog
  // 5884be3d). When the effective rate is still above the ceiling after that
  // pass, reconcile against the page-level Current Bill total instead of
  // trusting the garbled OCR value. Only applied if it independently
  // rate-validates; otherwise held for manual confirmation.
  const impliedRate = gas.usage > 0 ? gasVariable / gas.usage : null;
  if (impliedRate != null && impliedRate > 2.0) {
    const recon = _lbg_reconcileGasFromCurrentBill(
      currentBillTotal,
      otherCommoditySum,
      gas.usage,
      signedFuelAdj,
      billDate,
    );
    if (!recon.corrected) {
      return heldBill(
        'Gas charge implies $' + impliedRate.toFixed(2) + '/therm (exceeds $2.00 ceiling). ' + recon.reason,
        gas.charge,
      );
    }
    gasVariable = recon.variable;
    gasTotal = recon.total;
    corrected = { corrected: true, reason: recon.reason };
  }
  if (gasTotal < r.baseCharge && gas.usage > 0) {
    gasVariable = Math.round(gas.usage * r.rate * 100) / 100;
    gasTotal = gasVariable + r.baseCharge;
  }
  if (gasTotal < r.baseCharge && (!gas.usage || gas.usage === 0)) {
    console.warn(
      '[Louisburg] Skipping suspicious gas bill: charge $' +
        gasTotal.toFixed(2) +
        ' < base $' +
        r.baseCharge +
        ' with 0 usage',
    );
    return null;
  }
  gasTotal = gasTotal + (signedFuelAdj || 0);
  const gasBill = {
    ...base,
    GasCharge: gasVariable,
    TotalCurrentCharges: gasTotal.toFixed(2),
    TotalAmountDue: gasTotal.toFixed(2),
  };
  if (corrected && corrected.corrected) {
    gasBill._auto_corrected_GasCharge = { original: gas.charge, corrected: gasVariable, reason: corrected.reason };
  }
  return gasBill;
}

function formatRateWarning(rr, label, unitLabel) {
  const rateStr = '$' + rr.implied.toFixed(4) + unitLabel;
  if (rr.severity === 'error') {
    return (
      label +
      ' ' +
      rateStr +
      ' — outside expected range ($' +
      rr.min.toFixed(2) +
      '–$' +
      rr.max.toFixed(2) +
      unitLabel +
      ')'
    );
  }
  const direction = rr.implied < rr.typical ? 'lower' : 'higher';
  return label + ' ' + rateStr + ' — ' + direction + ' than typical ($' + rr.typical.toFixed(4) + unitLabel + ')';
}

function _lbg_tokens(line) {
  if (!line) return [];
  return [...line.matchAll(/-?[\d,]+\.\d+|-?[\d,]+-\d{2}|-?[\d,]+/g)]
    .map((m) => m[0])
    .map((s) => (/^-?\d+-\d{2}$/.test(s) ? s.replace('-', '.') : s))
    .map((s) => parseFloat(s.replace(/,/g, '')))
    .filter((n) => !isNaN(n));
}
// Customer-specific account → facility name map is user-populated via
// DB key `en_louisburg_facility_map` (JSON object {acct:"NAME"}).
// Nothing ships in source — the file stays free of customer data.
function _lbg_facilityLookup(acct) {
  if (!acct) return null;
  try {
    const m = DB.get('en_louisburg_facility_map', {});
    return m[acct] || m[String(acct).replace(/-/g, '')] || null;
  } catch (e) {
    return null;
  }
}

const UTILITY_RULES = [
  {
    name: 'Evergy',
    detect: (t) =>
      _EVG_BILLING_DETAILS.test(t) ||
      /Billing\s+Details\s*[-\u2013]\s*service\s+from/i.test(t) ||
      (/Fac\S*\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])/i.test(t) &&
        /Demand\s+Ch[gaq9]/i.test(t) &&
        /TDC\s+Ch[gaq9]/i.test(t)) ||
      (/Customer\s+Ch[gaq9]/i.test(t) && /ECA\s+Ch[gaq9]/i.test(t)) ||
      (/Current\s+Charges/i.test(t) && /Evergy|evergy/i.test(t)),
    extractAll: (t) => {
      const acct = t.match(_EVG_ACCT)?.[1]?.replace(/\s/g, '') || null;
      const addrM = t.match(_EVG_ADDR);
      // ── Multi-bill split (rewritten) ──
      // The earlier split relied on matching "Billing Details - service from"
      // headers directly, and when Tesseract OCR garbled even ONE header past
      // what the fuzzy regex tolerated, the merge logic dropped that bill's
      // text into the PREVIOUS section — silently combining multiple bills
      // into one section. Result: extractAll returned N-1, N-2, or fewer
      // results than actual billing periods, and every downstream step
      // (page ranges, overwrite, dup detection) was off.
      //
      // New strategy: anchor on the "service from MM/DD/YYYY to MM/DD/YYYY"
      // date pair itself. Dates are the most OCR-stable part of the bill
      // (digits + slashes) so this catches every bill even on degraded scans.
      // Each bill mentions its date pair TWICE (cover + billing-details
      // header), so we dedupe by date pair and keep the LAST occurrence
      // (which is the billing-details section, where the charge lines live).
      const sfRe = /service\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/gi;
      const sfMatches = [];
      let sfM;
      while ((sfM = sfRe.exec(t)) !== null) {
        sfMatches.push({ idx: sfM.index, start: sfM[1], end: sfM[2], length: sfM[0].length });
      }
      // For each service-from match, find the account number on the SAME
      // PAGE only (bounded by %%PAGE_N%% markers). Crossing page boundaries
      // picks up the wrong account when a multi-account PDF has identical
      // service dates. The regex tolerates OCR artifacts like ( or [ before
      // digits (e.g. "(<REDACTED-ACCT>" seen in scanned bills).
      const _pageBreakIdxs = [...t.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => m.index);
      const _pageTextForIdx = (idx) => {
        let pageStart = 0;
        let pageEnd = t.length;
        for (let i = 0; i < _pageBreakIdxs.length; i++) {
          if (_pageBreakIdxs[i] <= idx) {
            pageStart = _pageBreakIdxs[i];
            pageEnd = i + 1 < _pageBreakIdxs.length ? _pageBreakIdxs[i + 1] : t.length;
          } else break;
        }
        return t.slice(pageStart, pageEnd);
      };
      const _acctForIdx = (idx) => {
        const pageText = _pageTextForIdx(idx);
        // FIX (2026-08-24, Louisburg visual audit bug #6): "Account" and
        // "Number" tolerated `\s+` (one-or-more) between them, requiring a
        // space. Real OCR on the New HS bill (202 Aquatic Dr, acct
        // 2885731561, Dec 2025) read the header as one glued token
        // "AccountNumber" with zero space — confirmed against the rendered
        // page, where the printed number itself is sharp/unambiguous.
        // `\s+` -> `\s*` tolerates the glued form while still matching every
        // spaced form exactly as before (strict superset).
        const acctMatches = [
          ...pageText.matchAll(/[Aa]ccount\s*(?:N[ou]mber\s*)?[^0-9A-Za-z\n]{0,6}\s*[(\[©]?(\d[\d ]{4,18}\d)/gm),
        ];
        if (acctMatches.length === 0) return null;
        return acctMatches[0][1].replace(/\s/g, '');
      };
      const _addrForIdx = (idx) => {
        const pageText = _pageTextForIdx(idx);
        const addrMatch = pageText.match(_EVG_ADDR);
        return addrMatch ? addrMatch[1].trim() : null;
      };
      // Facility disambiguator (backlog acc68bdb) — a single Evergy account
      // can legitimately cover TWO distinct facilities for the same billing
      // period (e.g. New HS "2LGSF" and Ballfields "2MGSE", both on account
      // 2885731561 at 202 Aquatic Dr). Read the rate/meter-class code that
      // prints immediately before that page's own "Billing Details" header
      // (the same signal already used for the RateSchedule field) so the
      // dedup key below can tell the two apart instead of collapsing them.
      // Deliberately narrow: only the tight "<code> ... Billing Details"
      // form (the code prints immediately before that page's OWN Billing
      // Details header) is trusted here. The generic "Rate: <code>" fallback
      // used elsewhere for the RateSchedule field is NOT reused — applied
      // to a whole page (rather than an already-isolated bill section) it
      // false-positives on ordinary prose (e.g. "...Evergy's rate review."
      // on an LHS cover page matched as rate code "review", which then
      // wrongly conflicted with the real "2LGSF" and split one bill in
      // two). Returning null on anything less certain is the safe default
      // — null is treated as "unknown" (compatible), never a false split.
      const _rateForIdx = (idx) => {
        const pageText = _pageTextForIdx(idx);
        return pageText.match(/[-–]\s*([\dA-Z]{3,10})\s+Billing\s+Details/i)?.[1] || null;
      };
      for (const m of sfMatches) {
        m._acct = _acctForIdx(m.idx);
        m._addr = _addrForIdx(m.idx);
        m._rate = _rateForIdx(m.idx);
      }
      // Two entries are the SAME bill (cover + billing-details repeat, or a
      // genuine reprint) only when neither the rate/meter-class signal nor
      // the service address CONTRADICTS the other — an unresolved (null)
      // signal on either side is treated as unknown/compatible, never as
      // grounds to force a split, mirroring the agree-or-unknown discipline
      // used by `_sameAcct`/`_provenSameAcct` below. A resolved signal that
      // genuinely disagrees (e.g. "2LGSF" vs "2MGSE", or two different
      // service addresses) means two DISTINCT facilities share this
      // account+period and must NOT collapse into one hybrid record.
      const _normAddr = (a) => (a || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const _facilityConflict = (a, b) => {
        if (a._rate && b._rate && a._rate !== b._rate) return true;
        const na = _normAddr(a._addr);
        const nb = _normAddr(b._addr);
        if (na && nb && na !== nb) return true;
        return false;
      };
      // Dedupe by account+date pair — keep the LAST occurrence so section
      // boundaries line up with the billing-details page, not the cover.
      // Account number prevents merging different accounts that share dates;
      // the facility conflict check above prevents merging different
      // facilities that share BOTH an account and a period.
      const byPair = new Map();
      for (const m of sfMatches) {
        const acctKey = m._acct || '_';
        const pairKey = acctKey + '|' + m.start + '|' + m.end;
        const bucket = byPair.get(pairKey);
        if (!bucket) {
          byPair.set(pairKey, [m]);
          continue;
        }
        let mergedInto = null;
        for (const cand of bucket) {
          if (!_facilityConflict(cand, m)) {
            mergedInto = cand;
            break;
          }
        }
        if (mergedInto) {
          const bi = bucket.indexOf(mergedInto);
          if (!m._rate) m._rate = mergedInto._rate;
          if (!m._addr) m._addr = mergedInto._addr;
          bucket[bi] = m;
        } else {
          bucket.push(m);
        }
      }
      let uniqueBills = Array.from(byPair.values())
        .flat()
        .sort((a, b) => a.idx - b.idx);

      // ── FUZZY DATE-PAIR MERGE ──
      // OCR can read the SAME bill's start date differently on two pages
      // (e.g. "01/28/2026" on the cover, "01/29/2026" on the billing-details
      // page). The exact-key dedup above leaves both as separate entries,
      // producing a phantom "extra bill" with overlapping page ranges. Walk
      // adjacent entries (sorted by idx) and merge when the end dates match
      // AND start dates are within ±2 days — Evergy bills are ~30 days so
      // legit adjacent bills never share an end date, so this is safe.
      // Prefer the entry that has a "Billing Details" header within 40 chars
      // before its idx (that's the charge-line page — richer section).
      const _parseMDY = (s) => {
        const mm = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!mm) return null;
        return new Date(parseInt(mm[3]), parseInt(mm[1]) - 1, parseInt(mm[2]));
      };
      const _dayDelta = (a, b) => {
        const da = _parseMDY(a);
        const db = _parseMDY(b);
        if (!da || !db) return Infinity;
        return Math.abs((da - db) / 86400000);
      };
      const _hasBdBefore = (m) => {
        const before = t.slice(Math.max(0, m.idx - 40), m.idx);
        return /Billing\s+Details/i.test(before);
      };
      // Each surviving entry tracks _groupIdxs = [...all idxs in its merge
      // group...] so that section-boundary computation below uses the
      // EARLIEST and LATEST idxs of the group, not just the winner's idx.
      // Without this, dropping a phantom entry widens the PREVIOUS bill's
      // section onto the phantom's territory, absorbing cover-page text
      // from the next bill (regression observed in ocr-debug(79).txt:
      // Bill 31 picked up meter-change data from the Feb bill's cover).
      const _merged = [];
      let _fuzzyMerges = 0;
      for (const m of uniqueBills) {
        const prev = _merged.length ? _merged[_merged.length - 1] : null;
        const _sameAcct = !prev || !prev._acct || !m._acct || prev._acct === m._acct;
        // A legitimate cover+detail merge always has exactly ONE side with its
        // own "Billing Details" header immediately before it. If BOTH sides
        // independently satisfy _hasBdBefore, they are two DIFFERENT bills
        // (different buildings) that happen to share an end date and a
        // near-start-date — not a cover/detail pair of the same bill. Block
        // the merge in that case unless we have positive proof (both accounts
        // resolved and equal) that they really are the same bill. See
        // backlog 866c3e3b — without this guard a same-period collision
        // between two buildings silently drops one of them.
        const prevIsBd = prev ? _hasBdBefore(prev) : false;
        const curIsBd = _hasBdBefore(m);
        const _provenSameAcct = !!(prev && prev._acct && m._acct && prev._acct === m._acct);
        // Even when the account IS proven equal, a resolved facility signal
        // that disagrees (backlog acc68bdb — New HS "2LGSF" vs Ballfields
        // "2MGSE", both account 2885731561) still means these are two
        // distinct bills sharing one account, not a cover/detail repeat.
        const _distinctBillsCollision =
          prevIsBd && curIsBd && (!_provenSameAcct || (prev && _facilityConflict(prev, m)));
        if (
          prev &&
          _sameAcct &&
          !_distinctBillsCollision &&
          prev.end === m.end &&
          _dayDelta(prev.start, m.start) <= 2
        ) {
          _fuzzyMerges++;
          let winner;
          if (curIsBd && !prevIsBd) winner = m;
          else if (prevIsBd && !curIsBd) winner = prev;
          else winner = m.idx > prev.idx ? m : prev;
          // Preserve merge-group idxs on the winner for boundary calc.
          const groupIdxs = (prev._groupIdxs || [prev.idx]).concat(m._groupIdxs || [m.idx]);
          winner._groupIdxs = groupIdxs;
          const loser = winner === m ? prev : m;
          if (!winner._acct) winner._acct = loser._acct;
          if (!winner._addr) winner._addr = loser._addr;
          _merged[_merged.length - 1] = winner;
          continue;
        }
        m._groupIdxs = [m.idx];
        _merged.push(m);
      }
      uniqueBills = _merged;

      // ── CHAIN CONTINUITY NORMALIZATION ──
      // Consecutive Evergy bills always share a meter-read date
      // (prev.end === cur.start). When OCR misreads a digit in one of the
      // two date instances, the merged winner may still have a slightly
      // wrong start date. Walk adjacent pairs and snap cur.start to
      // prev.end whenever the gap is ≤2 days. This authoritatively fixes
      // labels like "01/28 → 03/02" → "01/29 → 03/02" when Bill 31 ends
      // on 01/29/2026.
      for (let _i = 1; _i < uniqueBills.length; _i++) {
        const _p = uniqueBills[_i - 1];
        const _c = uniqueBills[_i];
        if (_p.end && _c.start && _p.end !== _c.start && _dayDelta(_p.end, _c.start) <= 2) {
          _c.start = _p.end;
        }
      }

      // ── PAGE-FIRST SECTION RESOLUTION (Update 80b) ──
      // Resolve each bill's page range BEFORE section building by anchoring
      // on the page containing each bill's "service from" winning idx —
      // which is the bill's Billing Details page by construction of the
      // dedup+fuzzy-merge logic above (Update 75 preferred bd-anchored
      // idxs when merging). Concatenate cover + billing-details pages
      // into the section text. No per-page header reading — the 80a
      // attempt used Billing Date + Account Number grouping which was
      // strictly more fragile than the OCR guarantees, and a single
      // garbled page tripped the gate for the whole batch. uniqueBills
      // already has N entries by construction, so idx→page gives N
      // page ranges with no 1:1-gate to fail.
      const _pfPageMarkers = [...t.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => ({
        page: parseInt(m[1]),
        idx: m.index,
      }));
      const _pfPageForIdx = (idx) => {
        let pg = 1;
        for (const pm of _pfPageMarkers) {
          if (pm.idx <= idx) pg = pm.page;
          else break;
        }
        return pg;
      };
      const _pfMaxPage = _pfPageMarkers.length ? _pfPageMarkers[_pfPageMarkers.length - 1].page : 1;
      const _pfPageTextMap = {};
      for (let _pi = 0; _pi < _pfPageMarkers.length; _pi++) {
        const _pg = _pfPageMarkers[_pi].page;
        const _pStart = _pfPageMarkers[_pi].idx;
        const _pEnd = _pi + 1 < _pfPageMarkers.length ? _pfPageMarkers[_pi + 1].idx : t.length;
        _pfPageTextMap[_pg] = t.slice(_pStart, _pEnd);
      }
      // For each bill, pick the best "billing-details anchor idx" from
      // the merged group: prefer an idx that has "Billing Details" within
      // 40 chars before it (that's definitively the billing-details page,
      // matching Update 75 Fix A's _hasBdBefore logic). Fall back to the
      // largest idx in the group (LAST occurrence of service-from is
      // typically on the billing-details page because extractAll dedup
      // keeps the last match). Compute bdPage from that idx.
      let _pageFirstOk = uniqueBills.length > 0 && _pfPageMarkers.length > 0;
      const _pfBdPages = [];
      for (const b of uniqueBills) {
        const idxs = b._groupIdxs || [b.idx];
        let bdIdx = null;
        for (const ix of idxs) {
          const before = t.slice(Math.max(0, ix - 40), ix);
          if (/Billing\s+Details/i.test(before)) {
            bdIdx = ix;
            break;
          }
        }
        if (bdIdx === null) bdIdx = Math.max(...idxs);
        _pfBdPages.push(_pfPageForIdx(bdIdx));
      }
      // Partition pages across bills so each bill ALWAYS owns its own
      // billing-details page, plus a cover page when there is room before
      // the previous bill's bd. The previous Update 80b formula used
      // `pageEnd = max(pageStart, nextBdPage - 2)` which excluded the
      // bill's OWN bdPage when adjacent bills had bdPages only 1 apart
      // (e.g. Bill 32 bd=61, Bill 33 bd=62: pageEnd = max(60, 60) = 60,
      // so Bill 32 lost page 61 and Bill 33 stole it). Corrected rule:
      //   pageStart[0]   = 1                            // first bill gets preamble
      //   pageStart[i]   = bdPage[i] - 1                // cover, if bdPage[i] - 1 > bdPage[i-1]
      //                  = bdPage[i]                    // else no cover room (adjacent bills)
      //   pageEnd[i]     = bdPage[i]                    // always own bdPage (non-last)
      //   pageEnd[last]  = maxPage                      // last bill extends to EOF
      // Net effect: each bill owns exactly its own bdPage plus (when
      // available) a cover page immediately before it. No bill ever
      // reaches into a neighbor's bdPage.
      //
      // CONTENT-AWARE COVER-PAGE GUARD (cf3f0b8d fix, Fix A) — the formula
      // above only checks whether there is numeric "room" before the
      // previous bill's own bdPage; it never inspects what the candidate
      // cover page (bdPage - 1) actually contains. When a bill's OWN
      // billing-details account line is OCR-garbled past what
      // `_acctForIdx` tolerates (e.g. "Account Number =: <REDACTED-ACCT>"),
      // `_sameAcct` (line ~4471) treats the null account as a wildcard and
      // fuzzy-merges that bill into an unrelated PREVIOUS building's entry
      // with a matching billing period. The merge loser's bdPage is then
      // never claimed by anyone (bdPage resolution picks the FIRST
      // Billing-Details idx in the merge group, not the winner's own), so
      // that page is "orphaned" — and this partition formula silently
      // annexes it as the NEXT real bill's cover page, gluing an entirely
      // different building's charge lines onto the next bill's section
      // (root cause of cf3f0b8d: Rockville's BilledKWCharge/FacilitiesKW
      // absorbing New HS's page 42). Guard: before granting `bdPage - 1` as
      // cover, confirm that page does not itself carry a "Billing Details -
      // service from" occurrence resolved to a DIFFERENT, non-null account
      // than the bill being built. If it does, that page belongs to
      // another bill and must not be silently absorbed — fall back to no
      // cover room (`pageStart = bdPage`) for this bill instead.
      // CONTINUATION-PAGE GUARD (backlog 0d47ad08, item A) — a "(Continued)"
      // page (e.g. the meter-read row printed on its own page after the
      // charge-detail page) repeats "Account Number <n> ... (Continued)"
      // but has NO "Billing Details - service from" header at all, so the
      // sfMatches-only check above never sees it and treats it as free
      // "cover room" for the NEXT bill — annexing that meter row (and its
      // kWh) onto the wrong building. Extend the foreign-page check to also
      // scan the candidate page's plain account-number text (same regex as
      // `_acctForIdx`) for an account that differs from the bill being
      // built; a "(Continued)" page always carries its OWNER's account
      // number in that form even without a Billing-Details header.
      const _pageOwnAccts = (page) => {
        const pageText = _pfPageTextMap[page];
        if (!pageText) return [];
        const acctMatches = [
          ...pageText.matchAll(/[Aa]ccount\s+(?:N[ou]mber\s*)?[^0-9A-Za-z\n]{0,6}\s*[(\[©]?(\d[\d ]{4,18}\d)/gm),
        ];
        return acctMatches.map((am) => am[1].replace(/\s/g, ''));
      };
      const _pageHasForeignBd = (page, ownAcct) => {
        if (!ownAcct) return false;
        for (const m of sfMatches) {
          if (_pfPageForIdx(m.idx) !== page) continue;
          if (!_hasBdBefore(m)) continue;
          if (m._acct && m._acct !== ownAcct) return true;
        }
        for (const foundAcct of _pageOwnAccts(page)) {
          if (foundAcct !== ownAcct) return true;
        }
        return false;
      };
      // CONTINUATION ABSORPTION — the flip side of the guard above. A page
      // has to belong to SOMEONE: once `_pageHasForeignBd` stops a
      // "(Continued)" page from being claimed as the next bill's cover, it
      // must instead extend the PREVIOUS bill's own page range so that
      // bill keeps its meter-read row. A page qualifies as bill i's
      // continuation only when it carries bill i's own account number and
      // does not itself open a new bill (no "Billing Details - service
      // from" header) — that keeps a real next-bill cover page, which may
      // legitimately mention a prior account in passing, from being
      // swallowed.
      const _pageIsContinuationOf = (page, ownAcct) => {
        if (!ownAcct) return false;
        const pageText = _pfPageTextMap[page];
        if (!pageText) return false;
        if (_EVG_BILLING_DETAILS.test(pageText)) return false;
        const foundAccts = _pageOwnAccts(page);
        if (foundAccts.length === 0) return false;
        return foundAccts.every((a) => a === ownAcct);
      };
      const _pfPageStarts = [];
      if (_pageFirstOk) {
        for (let i = 0; i < uniqueBills.length; i++) {
          const bdPage = _pfBdPages[i];
          const prevBd = i > 0 ? _pfBdPages[i - 1] : 0;
          let pageStart;
          if (i === 0) {
            pageStart = 1;
          } else {
            const _candidatePage = bdPage - 1;
            const _ownAcct = uniqueBills[i]._acct || acct;
            const _hasRoom = _candidatePage > prevBd;
            const _foreignBd = _hasRoom && _pageHasForeignBd(_candidatePage, _ownAcct);
            pageStart = _hasRoom && !_foreignBd ? _candidatePage : bdPage;
          }
          _pfPageStarts.push(pageStart);
        }
        for (let i = 0; i < uniqueBills.length; i++) {
          const bdPage = _pfBdPages[i];
          let pageEnd = i + 1 < uniqueBills.length ? bdPage : _pfMaxPage;
          if (i + 1 < uniqueBills.length) {
            const _ownAcct = uniqueBills[i]._acct || acct;
            const _limit = _pfPageStarts[i + 1] - 1;
            for (let p = pageEnd + 1; p <= _limit; p++) {
              if (!_pageIsContinuationOf(p, _ownAcct)) break;
              pageEnd = p;
            }
          }
          const pageStart = _pfPageStarts[i];
          // Guard against corrupt ranges.
          if (pageEnd < pageStart || pageStart < 1 || pageEnd > _pfMaxPage) {
            _pageFirstOk = false;
            break;
          }
          const pages = [];
          for (let p = pageStart; p <= pageEnd; p++) pages.push(p);
          uniqueBills[i]._pfPageGroup = pages;
          uniqueBills[i]._pfPageStart = pageStart;
          uniqueBills[i]._pfPageEnd = pageEnd;
        }
      }
      // Defense: bdPages must be strictly ascending (monotonic page order
      // across bills). If not, something is structurally wrong (e.g. fuzzy
      // merge produced an out-of-order idx) and we fall back.
      if (_pageFirstOk) {
        for (let i = 1; i < _pfBdPages.length; i++) {
          if (_pfBdPages[i] < _pfBdPages[i - 1]) {
            _pageFirstOk = false;
            break;
          }
        }
      }
      if (_pageFirstOk) {
        console.log(
          '[Evergy page-first] OK · bills:',
          uniqueBills.length,
          '· bdPages:',
          _pfBdPages.join(','),
          '· maxPage:',
          _pfMaxPage,
        );
      } else {
        console.warn(
          '[Evergy page-first] FALLBACK to midpoint slicing · bills:',
          uniqueBills.length,
          '· pageMarkers:',
          _pfPageMarkers.length,
          '· bdPages:',
          _pfBdPages.join(','),
          '· maxPage:',
          _pfMaxPage,
          '· reason: either no page markers, empty uniqueBills, non-ascending bdPages, or corrupt computed range',
        );
      }

      // Build sections. When page-first grouping succeeded, each section is
      // the concatenation of the bill's page texts in page order — no
      // midpoints, no bleed from adjacent bills. When it failed, fall back
      // to the original midpoint-of-_groupIdxs slicing.
      //
      // First section (fallback only) starts at 0 to capture any preamble/
      // account header. Last section extends to t.length.
      let validSections;
      if (uniqueBills.length > 0) {
        validSections = uniqueBills.map((b, i) => {
          if (_pageFirstOk && b._pfPageGroup) {
            return b._pfPageGroup.map((pg) => _pfPageTextMap[pg]).join('');
          }
          // Fallback: midpoint-of-_groupIdxs slicing (pre-Update 80 behavior).
          const groupIdxs = b._groupIdxs || [b.idx];
          const curEarliest = Math.min(...groupIdxs);
          const curLatest = Math.max(...groupIdxs);
          const prevLatest = i > 0 ? Math.max(...(uniqueBills[i - 1]._groupIdxs || [uniqueBills[i - 1].idx])) : null;
          const nextEarliest =
            i + 1 < uniqueBills.length
              ? Math.min(...(uniqueBills[i + 1]._groupIdxs || [uniqueBills[i + 1].idx]))
              : null;
          const start = prevLatest !== null ? Math.floor((prevLatest + curEarliest) / 2) : 0;
          const end = nextEarliest !== null ? Math.floor((curLatest + nextEarliest) / 2) : t.length;
          return t.slice(start, end);
        });
      } else {
        // Fall back to the old split approach when no service-from dates
        // were found at all (truly unrecognizable OCR).
        const splitRe = new RegExp(
          '(?=(?:' +
            _EVG_BILLING_DETAILS.source +
            '|Billing[ \\t\\n\\r]+Details[ \\t\\n\\r]*[-\\u2013\\-][ \\t\\n\\r]*service[ \\t\\n\\r]+from))',
          'gi',
        );
        const raw = t.split(splitRe);
        const getDatePair = (s) => {
          const m =
            s.match(_EVG_SERVICE_FROM) ||
            s.match(/service\s+from[:\s]\s*(\d{2}\/\d{2}\/\d{4})\s+to[:\s]\s*(\d{2}\/\d{2}\/\d{4})/i);
          return m ? m[1] + '|' + m[2] : null;
        };
        const sections = [];
        for (const frag of raw) {
          const dates = getDatePair(frag);
          const isBillingHeader = _EVG_BILLING_DETAILS.test(frag.trim()) || /^Billing\s+Details/i.test(frag.trim());
          if (!isBillingHeader || !dates) {
            if (sections.length) sections[sections.length - 1] += frag;
            else sections.push(frag);
          } else if (sections.length && getDatePair(sections[sections.length - 1]) === dates) {
            sections[sections.length - 1] += frag;
          } else {
            sections.push(frag);
          }
        }
        validSections = sections.filter(
          (s) => _EVG_SERVICE_FROM.test(s) || /service\s+from[:\s]\s*\d{2}\/\d{2}\/\d{4}/i.test(s),
        );
      }
      if (!validSections.length) return [_extractEvergy(t, acct, addrM?.[1]?.trim() || null)];
      // Extract CustomerName and RateSchedule from full text — per-section extraction
      // often misses these because the header block (Customer Name, Account, Address, Rate)
      // appears BEFORE "Billing Details" and gets split into the previous section.
      const fullCustName =
        t
          .match(/Customer\s*Name[^A-Za-z\n]*([A-Z][A-Z0-9 #]+?)(?=\s+(?:Account|Page)|\n)/im)?.[1]
          ?.replace(/\s*£.*$/, '')
          .trim() || null;
      const fullRate =
        t.match(/[-\u2013]\s*([\dA-Z]{3,10})\s+Billing\s+Details/i)?.[1] ||
        t.match(/Rate\s*(?:Schedule|Code)?[\s:]*([A-Z0-9\-]{2,12})/i)?.[1] ||
        null;
      // Only fall back to the whole-document `acct` (first account number
      // found anywhere in the PDF) when this is genuinely a single-building
      // document — every resolved uniqueBills entry shares one account. In a
      // multi-building batch, a bill whose own per-page account failed to
      // resolve must NOT inherit an unrelated building's account number —
      // that silently mislabels it. Fall back to null (surfaces as "needs
      // review") instead. See backlog 866c3e3b.
      // Counting distinct accounts via a naive string Set is fooled by a
      // single OCR digit-garble of an otherwise-correct, page-anchored
      // account number (e.g. "<REDACTED-ACCT-1>" vs the real "<REDACTED-ACCT-2>" on the
      // SAME building's own billing-details page — not a second building).
      // That wrongly flips _isMultiAcctBatch to true in an otherwise
      // single-building document, which then blocks the whole-doc `acct`
      // fallback below for OTHER bills whose own account line failed to
      // resolve at all — turning a correct label into a false "needs
      // review" null. Fix (866c3e3b regression): cluster resolved accounts
      // that are the same length and differ by exactly one digit (a single
      // OCR substitution) as the SAME account for this count. Verified
      // against every fixture in the regression corpus that genuinely
      // distinct accounts in real multi-building batches never happen to
      // differ by only one digit at the same length, so this does not mask
      // a true multi-building batch.
      const _acctsAreOcrVariant = (a, b) => {
        if (a === b) return true;
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let _ci = 0; _ci < a.length; _ci++) {
          if (a[_ci] !== b[_ci]) {
            diff++;
            if (diff > 1) return false;
          }
        }
        return diff === 1;
      };
      const _acctClusters = [];
      for (const _a of uniqueBills.map((b) => b._acct).filter(Boolean)) {
        const _existing = _acctClusters.find((cluster) => cluster.some((x) => _acctsAreOcrVariant(x, _a)));
        if (_existing) _existing.push(_a);
        else _acctClusters.push([_a]);
      }
      const _isMultiAcctBatch = _acctClusters.length > 1;
      const results = validSections.map((s, i) => {
        const billAcct = (uniqueBills[i] && uniqueBills[i]._acct) || (_isMultiAcctBatch ? null : acct);
        const billAddr = (uniqueBills[i] && uniqueBills[i]._addr) || addrM?.[1]?.trim() || null;
        const r = _extractEvergy(s, billAcct, billAddr);
        if (!r.CustomerName && fullCustName) r.CustomerName = fullCustName;
        if (!r.RateSchedule && fullRate) r.RateSchedule = fullRate;
        // Override BillingPeriodStart/End with the winning uniqueBills
        // entry's date pair. The section text may still contain BOTH the
        // dropped phantom match and the winning match (midpoint slicing
        // doesn't physically remove text), and _extractEvergy picks the
        // FIRST occurrence of service-from it finds — which may be the
        // phantom one. The uniqueBills entry has already been chain-
        // normalized (snapping to the prior bill's end date) so it's the
        // authoritative label for this bill.
        const winner = uniqueBills[i];
        if (winner && winner.start && winner.end) {
          r.BillingPeriodStart = winner.start;
          r.BillingPeriodEnd = winner.end;
          const ds = _parseMDY(winner.start);
          const de = _parseMDY(winner.end);
          if (ds && de) {
            r.NumberOfDays = String(Math.round((de - ds) / 86400000));
          }
        }
        return r;
      });

      // ── PAGE-FIRST STAMPING (Update 80) ──
      // When page-first grouping succeeded above, stamp each result with
      // the page range resolved from its (acct, billingDate) group. This
      // short-circuits the full fallback cascade below — the cascade
      // still runs as a safety net when _pageFirstOk is false.
      if (_pageFirstOk) {
        for (let i = 0; i < results.length; i++) {
          const ub = uniqueBills[i];
          if (ub && ub._pfPageGroup) {
            results[i]._pageStart = ub._pfPageStart;
            results[i]._pageEnd = ub._pfPageEnd;
            results[i]._pageRangeSource = 'page-first';
          }
        }
      }

      // ── PAGE RANGE POST-PROCESSING (fallback when page-first fails) ──
      // This cascade only runs when the Update 80 page-first stamping
      // above couldn't establish a 1:1 bill→page-group match (e.g. OCR
      // garbled every Billing Date header on one page). When page-first
      // succeeded, every result already has _pageStart/_pageEnd set, so
      // this cascade is a no-op defense; gating it saves work AND
      // prevents a fallback strategy from overwriting a correct page-
      // first range with a degraded one.
      if (!_pageFirstOk) {
        // The earlier cover-page anchoring approach relied on matching
        // "For service from MM/DD/YYYY to MM/DD/YYYY" on each bill's cover, which
        // is unreliable because Tesseract OCR frequently garbles the cover page
        // text. When the regex missed, the chain-fallback produced overlapping /
        // duplicate ranges across bills.
        //
        // New approach: anchor on the "Billing Details - service from" header
        // position, which is (a) always present (extractAll already splits on it),
        // (b) more OCR-tolerant (the _EVG_BILLING_DETAILS regex has character-class
        // fuzzing), and (c) aligns 1:1 with the results[] entries because they
        // were produced by splitting on exactly this regex. For each bill:
        //   _pageStart = (billing-details page) - 1   // cover page sits right before
        //   _pageEnd   = (next bill's billing-details page) - 2  // one before next cover
        // Last bill gets _pageEnd = _maxPage. Every result gets a range, no chain
        // fallback required, no duplicate-neighbor bug.
        const _pageMarkers = [...t.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => ({
          page: parseInt(m[1]),
          idx: m.index,
        }));
        const _pageForIdx = (idx) => {
          let pg = 1;
          for (const pm of _pageMarkers) {
            if (pm.idx <= idx) pg = pm.page;
            else break;
          }
          return pg;
        };
        const _maxPage = _pageMarkers.length ? _pageMarkers[_pageMarkers.length - 1].page : 1;

        // ── STRATEGY 1: Billing Date + Account Number per-page grouping ──
        // Each Evergy page has a "Billing Date: MM/DD/YYYY" and "Account Number :
        // XXX" printed in its header. Every page of the SAME bill shares the same
        // (account, billingDate) pair, so grouping pages by that pair gives the
        // exact page range for each bill — more reliable than any regex anchor
        // because the header text is in a consistent layout that OCR handles well
        // and the digits of the date are OCR-stable.
        const _pageTextMap = {};
        for (let _pi = 0; _pi < _pageMarkers.length; _pi++) {
          const _pg = _pageMarkers[_pi].page;
          const _pStart = _pageMarkers[_pi].idx;
          const _pEnd = _pi + 1 < _pageMarkers.length ? _pageMarkers[_pi + 1].idx : t.length;
          _pageTextMap[_pg] = t.slice(_pStart, _pEnd);
        }
        const _bdKeyRe = /Billing\s*Date\s*[:\s]+(\d{2}\/\d{2}\/\d{4})/i;
        const _acctKeyRe = /Account\s*(?:Number)?\s*[^0-9A-Za-z\n]{0,6}(\d[\d\s\-]{4,18}\d)/i;
        const _billsByKey = {}; // 'acct|date' → [page numbers]
        for (const [_pgStr, _pgText] of Object.entries(_pageTextMap)) {
          const _pg = parseInt(_pgStr);
          const _bdM = _pgText.match(_bdKeyRe);
          if (!_bdM) continue;
          const _acctM = _pgText.match(_acctKeyRe);
          const _acct = _acctM ? _acctM[1].replace(/[\s\-]/g, '') : '';
          const _key = _acct + '|' + _bdM[1];
          if (!_billsByKey[_key]) _billsByKey[_key] = [];
          _billsByKey[_key].push(_pg);
        }
        // Order unique keys by their FIRST page so they match results[] order.
        const _orderedKeys = [];
        const _seenKeys = new Set();
        for (let _pg = 1; _pg <= _maxPage; _pg++) {
          const _pgText = _pageTextMap[_pg];
          if (!_pgText) continue;
          const _bdM = _pgText.match(_bdKeyRe);
          if (!_bdM) continue;
          const _acctM = _pgText.match(_acctKeyRe);
          const _acct = _acctM ? _acctM[1].replace(/[\s\-]/g, '') : '';
          const _key = _acct + '|' + _bdM[1];
          if (_seenKeys.has(_key)) continue;
          _seenKeys.add(_key);
          _orderedKeys.push(_key);
        }
        console.log(
          '[Evergy page-anchor] results:',
          results.length,
          '· unique billing-date keys:',
          _orderedKeys.length,
        );
        let _billingDateAnchorOk = false;
        if (_orderedKeys.length === results.length && _orderedKeys.length > 0) {
          for (let i = 0; i < results.length; i++) {
            const _pages = _billsByKey[_orderedKeys[i]] || [];
            if (_pages.length > 0) {
              results[i]._pageStart = Math.min(..._pages);
              results[i]._pageEnd = Math.max(..._pages);
              results[i]._pageRangeSource = 'billing-date';
            }
          }
          _billingDateAnchorOk = results.every((r) => r._pageStart && r._pageEnd);
          console.log('[Evergy page-anchor] billing-date strategy OK:', _billingDateAnchorOk);
        }

        // Find every Billing Details header position in the full text. Used as
        // fallback when billing-date anchoring can't establish a 1:1 mapping.
        const _bdFindRe = new RegExp(
          '(?:' +
            _EVG_BILLING_DETAILS.source +
            '|Billing[ \\t\\n\\r]+Details[ \\t\\n\\r]*[-\\u2013\\-][ \\t\\n\\r]*service[ \\t\\n\\r]+from)',
          'gi',
        );
        const bdPositions = [];
        let _bdM;
        while ((_bdM = _bdFindRe.exec(t)) !== null) bdPositions.push(_bdM.index);

        if (_billingDateAnchorOk) {
          // Primary strategy already populated every result — skip fallbacks.
        } else if (bdPositions.length === results.length) {
          // Clean 1:1 mapping — most common case.
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const bdPage = _pageForIdx(bdPositions[i]);
            // Cover is the page right before Billing Details. Clamp to 1 minimum.
            r._pageStart = Math.max(1, bdPage - 1);
            if (i + 1 < results.length) {
              const nextBdPage = _pageForIdx(bdPositions[i + 1]);
              // Next cover is (nextBdPage - 1), so this bill ends one page before
              // the next cover: nextBdPage - 2. Guard against negative deltas on
              // same-page bills (nextBdPage === bdPage is a split issue, treat it
              // as a same-page range).
              r._pageEnd = Math.max(r._pageStart, nextBdPage - 2);
            } else {
              r._pageEnd = _maxPage;
            }
            r._pageRangeSource = 'bd-header';
          }
        } else {
          // Mismatch — fall back to the original cover-anchoring approach. This
          // should be rare but can happen if extractAll merged duplicate-date
          // sections or the regex over-matched on OCR noise.
          const coverStarts = [];
          for (const r of results) {
            if (!r.BillingPeriodStart || !r.BillingPeriodEnd) {
              coverStarts.push(null);
              continue;
            }
            const datePatt = new RegExp(
              'For[ \\t\\n\\r]+service[ \\t\\n\\r]+from[ \\t\\n\\r]+' +
                r.BillingPeriodStart.replace(/[./\\]/g, '[./]') +
                '[ \\t\\n\\r]+to[ \\t\\n\\r]+' +
                r.BillingPeriodEnd.replace(/[./\\]/g, '[./]'),
              'gi',
            );
            let coverIdx = -1;
            let mm;
            while ((mm = datePatt.exec(t)) !== null) {
              const before = t.slice(Math.max(0, mm.index - 40), mm.index);
              if (/Billing\s+Details/i.test(before)) continue;
              coverIdx = mm.index;
              break;
            }
            coverStarts.push(coverIdx >= 0 ? _pageForIdx(coverIdx) : null);
          }
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const start = coverStarts[i];
            if (start) {
              r._pageStart = start;
              let nextStart = null;
              for (let j = i + 1; j < coverStarts.length; j++) {
                if (coverStarts[j] && coverStarts[j] > start) {
                  nextStart = coverStarts[j];
                  break;
                }
              }
              r._pageEnd = nextStart ? nextStart - 1 : _maxPage;
              r._pageRangeSource = 'cover-anchor';
            } else {
              const s = validSections[i] || '';
              const pm = [...s.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
              if (pm.length) {
                r._pageStart = Math.min(...pm);
                r._pageEnd = Math.max(...pm);
                r._pageRangeSource = 'section-scan';
              }
            }
          }
        }
      } // end if (!_pageFirstOk) — fallback cascade
      // Final safety net: any result still missing a range gets the chain
      // fallback (previous bill's end + 1 → next bill's start - 1 or _maxPage).
      // Runs in both modes: no-op when every result already has a page
      // range (the common case under page-first), populates missing
      // ranges when the cascade above left some bills unresolved.
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r._pageStart && r._pageEnd) continue;
        let prevEnd = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (results[j]._pageEnd) {
            prevEnd = results[j]._pageEnd;
            break;
          }
        }
        let nextStart = null;
        for (let j = i + 1; j < results.length; j++) {
          if (results[j]._pageStart) {
            nextStart = results[j]._pageStart;
            break;
          }
        }
        const fallbackStart = prevEnd + 1;
        const fallbackEnd = nextStart ? nextStart - 1 : _maxPage;
        if (fallbackStart <= fallbackEnd && fallbackStart >= 1 && fallbackEnd <= _maxPage) {
          if (!r._pageStart) r._pageStart = fallbackStart;
          if (!r._pageEnd) r._pageEnd = fallbackEnd;
          r._pageRangeSource = (r._pageRangeSource || '') + ' chain-fallback';
        }
      }
      // ── OVERLAP CLAMP ──
      // After all fallback strategies run, different bills may have computed
      // their ranges using different strategies (billing-date / bd-header /
      // cover-anchor / section-scan / chain-fallback), producing overlapping
      // ranges where one bill greedily spans pages that rightfully belong to
      // later bills. This was the root cause of Bill 23 in ocr-debug(77).txt
      // covering pages 50-59 while Bills 24-31 collapsed to single pages
      // 52-59 *inside* Bill 23's range — Bill 23 then extracted fields from
      // 10 pages of mixed OCR text and dragged neighbor-bill data into its
      // own output. Walk results in order and clamp each bill's _pageEnd to
      // never exceed (next bill's _pageStart - 1).
      for (let i = 0; i < results.length - 1; i++) {
        const r = results[i];
        const nxt = results[i + 1];
        if (!r._pageEnd || !nxt._pageStart) continue;
        if (r._pageEnd >= nxt._pageStart) {
          const origEnd = r._pageEnd;
          r._pageEnd = Math.max(r._pageStart || 1, nxt._pageStart - 1);
          if (r._pageEnd < origEnd) {
            r._pageRangeSource = (r._pageRangeSource || '') + ' clamped';
          }
        }
      }
      // ── NEIGHBOR-BILL FALLBACK (extractAll) ──
      const _NBR_FIELDS = ['UtilityCompany', 'CustomerName', 'ServiceAddress', 'RateSchedule', 'CustomerCharge'];
      const _acctNorm = (s) => (s || '').replace(/[\s\-]/g, '').toLowerCase();
      for (let i = 0; i < results.length; i++) {
        const b = results[i];
        if (!b.AccountNumber) continue;
        const needsFill = _NBR_FIELDS.some((f) => b[f] === null || b[f] === undefined || b[f] === '');
        if (!needsFill) continue;
        const prev = i > 0 ? results[i - 1] : null;
        const next = i < results.length - 1 ? results[i + 1] : null;
        const isNbr = (n) => {
          if (!n || !n.AccountNumber) return false;
          if (_acctNorm(n.AccountNumber) !== _acctNorm(b.AccountNumber)) return false;
          if (b.MeterNumber && n.MeterNumber && b.MeterNumber !== n.MeterNumber) return false;
          return true;
        };
        const donors = [];
        if (isNbr(prev)) donors.push(prev);
        if (isNbr(next)) donors.push(next);
        for (const f of _NBR_FIELDS) {
          if (b[f] !== null && b[f] !== undefined && b[f] !== '') continue;
          for (const donor of donors) {
            if (donor[f] !== null && donor[f] !== undefined && donor[f] !== '') {
              b[f] = donor[f];
              b['_neighbor_filled_' + f] = true;
              break;
            }
          }
        }
      }
      return results;
    },
    extract: (t) => {
      const acct = t.match(_EVG_ACCT)?.[1]?.replace(/\s/g, '') || null;
      const addrM = t.match(_EVG_ADDR);
      return _extractEvergy(t, acct, addrM?.[1]?.trim() || null);
    },
  },
  // ── Constellation NewEnergy (Gas Supplier) ─────────────────────────────
  // Handles consolidated multi-account / multi-site Constellation invoices.
  // Must appear BEFORE the Gas Utility rule because Constellation invoices
  // contain "MMBtu", "Invoice", and natural gas keywords that would otherwise
  // trip the Gas Utility broadened detector.
  {
    name: 'Constellation NewEnergy (Gas Supplier)',
    detect: (t) => /constellation/i.test(t) || /account\s*id:\s*bg-\d+/i.test(t),
    extractAll: function (t) {
      // ── Level 1: identify unique invoice boundaries by Invoice Number ──
      // Root-cause fix (2026-06-02): the previous approach split on every
      // "Invoice Date:" occurrence, which fires on every page header (173 times
      // for a 166-page PDF) and breaks each site block mid-way across its two
      // physical pages. Result: TotalCurrentCharges from page N+1 landed in the
      // wrong (previous) site's chunk, causing 355 duplicate bills with wrong
      // totals and wrong account numbers.
      //
      // New strategy: find the FIRST occurrence of each unique Invoice Number.
      // Every Constellation monthly invoice has a distinct Invoice Number, so
      // this creates exactly one chunk per monthly invoice regardless of how
      // many times the page header repeats "Invoice Date:".
      const _invNumRe = /Invoice\s+Number:\s*(\d+)/gi;
      const _invBoundaries = []; // [{invoiceNum, startIdx}] sorted by startIdx
      const _seenInvoiceNums = new Set();
      let _im;
      while ((_im = _invNumRe.exec(t)) !== null) {
        const invNum = _im[1];
        if (!_seenInvoiceNums.has(invNum)) {
          _seenInvoiceNums.add(invNum);
          // Walk back to the "Invoice Date:" that precedes this Invoice Number
          // (within 500 chars). If not found, use the Invoice Number position itself.
          const searchBack = Math.max(0, _im.index - 500);
          const prefix = t.slice(searchBack, _im.index);
          const _allDates = [...prefix.matchAll(/Invoice\s+Date:\s*\d{2}\/\d{2}\/\d{2}/gi)];
          const _lastDate = _allDates.length ? _allDates[_allDates.length - 1] : null;
          const startIdx = _lastDate ? searchBack + _lastDate.index : _im.index;
          _invBoundaries.push({ invoiceNum: invNum, startIdx });
        }
      }
      // Fallback: if no Invoice Number markers found, treat entire text as one invoice
      if (_invBoundaries.length === 0) _invBoundaries.push({ invoiceNum: '', startIdx: 0 });
      _invBoundaries.sort((a, b) => a.startIdx - b.startIdx);

      // Slice the full text into per-invoice chunks using the identified boundaries
      const invoices = _invBoundaries.map((b, i) => {
        const end = i + 1 < _invBoundaries.length ? _invBoundaries[i + 1].startIdx : t.length;
        return t.slice(b.startIdx, end);
      });
      // Prepend any preamble text (before the first invoice boundary) to the first invoice
      if (_invBoundaries[0].startIdx > 0) {
        invoices[0] = t.slice(0, _invBoundaries[0].startIdx) + invoices[0];
      }

      const results = [];
      for (const invText of invoices) {
        if (!invText.trim()) continue;

        // ── Level 2: split each invoice into per-site blocks ──
        // Each site starts with "Service for Mon-YYYY" line.
        const siteChunks = invText.split(/(?=Service\s+for\s+[A-Z][a-z]{2,}-\d{4})/i);
        // Guard: if the invoice text has no "Service for" at all, try extracting
        // it as a single site block (may be an invoice header-only chunk).
        if (siteChunks.length <= 1) {
          const bill = this.extract(invText);
          if (bill && !bill._skipRecord) results.push(bill);
          continue;
        }

        // The first chunk may be invoice-level header text before any site block.
        // Carry the invoice header forward into each site chunk so extract() can
        // read InvoiceDate, AccountID, etc. from the per-site context.
        const invoiceHeader = siteChunks[0];
        // Architecture note: In Constellation PDFs each site block spans two physical
        // pages. The Customer ID and LDC Account for site N appear at the END of the
        // text before site N's "Service for" line — i.e., at the END of siteChunks[N-1].
        // Prepending invoiceHeader (which has site 1's Customer ID) to all chunks
        // causes extract() to always return site 1's Customer ID for sites 2-14.
        // Fix: for each chunk i, prepend the LAST 600 chars of chunk i-1 (which has
        // the correct Customer ID) PLUS the invoice header (for Invoice Date / BG Account).
        for (let i = 1; i < siteChunks.length; i++) {
          const prevTail = siteChunks[i - 1].slice(-600);
          const siteText = invoiceHeader + '\n' + prevTail + '\n' + siteChunks[i];
          const bill = this.extract(siteText);
          if (bill && !bill._skipRecord) results.push(bill);
        }
      }
      // C3 fix: deduplicate amendment/reversal pages.
      // A correction invoice (e.g. June 2025, 46 pages) repeats "Service for Mon-YYYY"
      // for prior months, producing duplicate (AccountNumber, BillingPeriodStart) pairs.
      // Keep the LAST occurrence — the correction supersedes the original.
      const dedupedResults = [];
      if (results.length > 0) {
        const seenKey = new Map(); // key → index in dedupedResults
        for (const bill of results) {
          const key = (bill.AccountNumber || '') + '|' + (bill.BillingPeriodStart || '');
          if (seenKey.has(key)) {
            // Replace the earlier duplicate with this later one
            dedupedResults[seenKey.get(key)] = bill;
          } else {
            seenKey.set(key, dedupedResults.length);
            dedupedResults.push(bill);
          }
        }
      }
      return dedupedResults.length > 0 ? dedupedResults : [this.extract(t)];
    },
    extract: function (t) {
      // ── Number cleaning helper ──
      // Remove commas, handle "$" prefix, handle bare ":" misread as "." in OCR.
      const fixNum = (s) => {
        if (!s) return null;
        return s.replace(/,/g, '').replace(/(\d):(\d)/, '$1.$2');
      };

      // ── AccountNumber ──
      // Priority: Customer ID (unique per building) > LDC Account (shared across
      // all Baker campus buildings) > BG Account ID (invoice-level only).
      //
      // C2 fix: Use Customer ID (RG-XXXXXX) as the per-building unique key.
      // All 14 Baker buildings share the same LDC Account (<REDACTED-ACCT-SEG1> <REDACTED-ACCT-SEG2> <REDACTED-ACCT-SEG3>),
      // so LDC Account alone cannot distinguish buildings. Customer ID is unique per
      // building and appears in every site block. Format varies: "RG-<REDACTED-ACCT>" (with
      // dash) or "RG<REDACTED-ACCT>" (no dash, OCR misread on some pages) — normalize by
      // keeping the raw match and stripping non-alphanumeric chars after "RG".
      //
      // IMPORTANT: the siteText passed to extract() is structured as:
      //   invoiceHeader (has site 1's Customer ID) + prevTail (has THIS site's Customer ID) + site charges
      // We must use the LAST Customer ID found in the text, not the first.
      const _custIdAll = [...t.matchAll(/Customer\s+ID:\s*(RG-?\d+)/gi)];
      const custIdM = _custIdAll.length > 0 ? _custIdAll[_custIdAll.length - 1] : null;
      // C1 fix: capture full multi-segment LDC Account (e.g. "<REDACTED-ACCT-SEG1> <REDACTED-ACCT-SEG2> <REDACTED-ACCT-SEG3>").
      // Old regex ([0-9]+) stopped at first space, capturing only "<REDACTED-ACCT-SEG1>".
      // New pattern allows digits + spaces up to 30 chars, then trim trailing spaces.
      // Similarly use the LAST match to get the per-site LDC Account (not the header's).
      const _ldcAll = [...t.matchAll(/LDC\s*Account:\s*([0-9][0-9 ]{5,30})/gi)];
      const ldcM = _ldcAll.length > 0 ? _ldcAll[_ldcAll.length - 1] : null;
      const bgM = t.match(/Account\s*ID:\s*(BG-\d+)/i);
      const AccountNumber =
        (custIdM ? custIdM[1].replace(/[^A-Z0-9]/gi, '') : null) ||
        (ldcM ? ldcM[1].trim() : null) ||
        (bgM ? bgM[1] : null);

      // Guard: no usable account number means we can't identify this block.
      if (!AccountNumber) {
        return {
          UtilityCompany: 'Constellation',
          Commodity: 'Gas',
          _skipRecord: true,
          _lowConfidence: true,
          _reason: 'No AccountNumber found (no LDC Account or Account ID)',
          commodity: 'gas',
          _utilityName: 'Constellation',
        };
      }

      // ── ServiceAddress ──
      // Constellation site blocks look like:
      //   "Example Customer - 00000X0000"
      //   "123 Main St, Baldwin City, KS 66006-0000"
      // Capture the street line that follows the "Name - SiteID" line.
      //
      // C4 fix: siteText = invoiceHeader + prevTail + siteChunks[i]. The invoiceHeader
      // contains the invoice-level billing address (e.g. "<REDACTED-ADDR>") which appears
      // before the current site's own address. Searching the full siteText with /im
      // always matched the header's address, giving all 14 sites the same address.
      // Fix: restrict the address search to the portion AFTER the LAST "Service for"
      // line — which is where the current site's content begins. This mirrors how
      // AccountNumber already uses the LAST Customer ID match (C2 fix above).
      // Using the LAST match (not first) prevents prevTail from anchoring to a
      // previous site's "Service for" line when siteChunks[i-1] is <= 600 chars.
      const _svcForAll = [...t.matchAll(/Service\s+for\s+[A-Z][a-z]{2,}-\d{4}/gi)];
      const _lastSvcFor = _svcForAll.length > 0 ? _svcForAll[_svcForAll.length - 1] : null;
      const _addrSearchText = _lastSvcFor ? t.slice(_lastSvcFor.index) : t;
      const addrM =
        _addrSearchText.match(/^(\d+\s+[A-Za-z0-9 #]+,\s*Baldwin\s*City[^\n]*)/im) ||
        _addrSearchText.match(
          /^(\d+\s+[A-Za-z0-9 .#]+,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/m,
        );
      const ServiceAddress = addrM ? addrM[1].trim() : null;

      // ── BillingPeriod ──
      // "Service for Dec-2024 - Actual" → month name + 4-digit year
      const svcM = t.match(/Service\s+for\s+([A-Z][a-z]{2,})-(\d{4})/i);
      let BillingPeriodStart = null;
      let BillingPeriodEnd = null;
      if (svcM) {
        const MONTH_MAP = {
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
        };
        const monthName = svcM[1].toLowerCase().slice(0, 3);
        const year = parseInt(svcM[2], 10);
        const mo = MONTH_MAP[monthName];
        if (mo !== undefined && !isNaN(year)) {
          // Start = first day of month
          const startD = new Date(year, mo, 1);
          // End = last day of month (day 0 of next month)
          const endD = new Date(year, mo + 1, 0);
          const pad = (n) => String(n).padStart(2, '0');
          BillingPeriodStart = pad(startD.getMonth() + 1) + '/' + pad(startD.getDate()) + '/' + startD.getFullYear();
          BillingPeriodEnd = pad(endD.getMonth() + 1) + '/' + pad(endD.getDate()) + '/' + endD.getFullYear();
        }
      }

      // ── NaturalGasTherms ──
      // Constellation invoices report usage in MMBtu. 1 MMBtu = 10 therms exactly.
      //
      // BUG FIX (2026-06-09): The previous code did matchAll(/([\d.]+)\s*MMBtu/gi)
      // and SUMMED every occurrence. On a Constellation bill, the same quantity
      // appears on 3 lines (e.g. 65 MMBtu each):
      //   - Incremental Costs     65.00 MMBtu  $4.08070  $265.25   ← actual usage
      //   - Subtotal Gas Supply   65.00 MMBtu             $265.25   ← restatement
      //   - CRM Charge            65.00 MMBtu  $0.00720    $0.47   ← restatement
      // Summing gave 195 MMBtu = 1,950 therms instead of 650.
      //
      // Fix: read usage from ONE authoritative line using a priority cascade:
      //   1. "Incremental Costs" line — carries a $/MMBtu rate; this is the actual
      //      supply charge and is always present on real Constellation invoices.
      //   2. "Subtotal Gas Supply Charges" line — fallback if OCR missed IC line.
      // Never fall back to summing all MMBtu occurrences (that is the root-cause bug).
      let NaturalGasTherms = null;
      const _icM = t.match(/Incremental\s+Costs[^\n]{0,90}?([\d,]+\.?\d*)\s*MMBt[uUyY]/i);
      const _subtotalM = t.match(/Subtotal\s+Gas\s+Supply\s+Charges[^\n]{0,90}?([\d,]+\.?\d*)\s*MMBt[uUyY]/i);
      const _mmBtuRaw = _icM ? _icM[1] : _subtotalM ? _subtotalM[1] : null;
      if (_mmBtuRaw) {
        const mmBtuVal = parseFloat(_mmBtuRaw.replace(/,/g, ''));
        if (!isNaN(mmBtuVal) && mmBtuVal > 0) {
          // Round to 2 decimal places to avoid floating-point noise.
          NaturalGasTherms = String(Math.round(mmBtuVal * 10 * 100) / 100);
        }
      }

      // ── TotalCurrentCharges ──
      // Prefer per-site "Total Current Site Charges $NNN.NN".
      // Fallback: invoice-level "Total New Charges $NNN.NN" or "Total Amount Due $NNN.NN".
      const siteChargeM = t.match(/Total\s+Current\s+Site\s+Charges\s*\$?([\d,]+\.\d{2})/i);
      const newChargeM = t.match(/Total\s+New\s+Charges\s*\$?([\d,]+\.\d{2})/i);
      const amtDueM = t.match(/Total\s+Amount\s+Due\s*\$?([\d,]+\.\d{2})/i);
      const rawTotal = siteChargeM ? siteChargeM[1] : newChargeM ? newChargeM[1] : amtDueM ? amtDueM[1] : null;
      const TotalCurrentCharges = fixNum(rawTotal);
      const TotalAmountDue = TotalCurrentCharges;

      // ── StatementDate ──
      // "Invoice Date: 01/16/25" — two-digit year
      const invDateM = t.match(/Invoice\s+Date:\s*(\d{2}\/\d{2}\/\d{2})/i);
      let StatementDate = null;
      if (invDateM) {
        // Normalize two-digit year to four-digit (20YY).
        const parts = invDateM[1].split('/');
        StatementDate = parts[0] + '/' + parts[1] + '/20' + parts[2];
      }

      // ── Validity guard ──
      // A bill is valid if it has AccountNumber + a billing period + a total.
      const hasMinFields = AccountNumber && (BillingPeriodStart || BillingPeriodEnd) && TotalCurrentCharges;
      if (!hasMinFields) {
        return {
          UtilityCompany: 'Constellation',
          Commodity: 'Gas',
          AccountNumber,
          BillingPeriodStart,
          BillingPeriodEnd,
          TotalCurrentCharges,
          TotalAmountDue,
          StatementDate,
          ServiceAddress,
          NaturalGasTherms,
          _skipRecord: true,
          _lowConfidence: true,
          _reason: 'Missing required fields (AccountNumber + period + total)',
          commodity: 'gas',
          _utilityName: 'Constellation',
        };
      }

      return {
        UtilityCompany: 'Constellation',
        Commodity: 'Gas',
        AccountNumber,
        ServiceAddress,
        BillingPeriodStart,
        BillingPeriodEnd,
        StatementDate,
        NaturalGasTherms,
        NaturalGasCCF: null,
        GasCharge: NaturalGasTherms && TotalCurrentCharges ? null : null, // not split out
        CustomerCharge: null,
        TotalCurrentCharges,
        TotalAmountDue,
        commodity: 'gas',
        _utilityName: 'Constellation',
      };
    },
    _hasKeyField: function (extracted) {
      return !!(
        extracted.AccountNumber &&
        (extracted.BillingPeriodStart || extracted.BillingPeriodEnd) &&
        extracted.TotalCurrentCharges
      );
    },
  },
  // ── End Constellation NewEnergy ─────────────────────────────────────────
  // ── Wood River Energy (Gas Supplier — multi-site district account) ───────
  // One consolidated invoice covers 10 service addresses.
  // extractAll() splits into per-building records; aggregate totals are
  // cross-checked but not saved as a separate record.
  // Usage unit: MMbtu (NOT Therms). Rate: $/MMbtu.
  // Billing period: derived from "Production Month" (calendar month).
  // Must appear BEFORE the Gas Utility (Spire/KGS/Atmos) rule because
  // that rule's broadened detector matches "Natural Gas Invoice" + "invoice".
  {
    name: 'Wood River Energy',
    detect: (t) =>
      /woodriverenergy\.com/i.test(t) ||
      /ar@woodriverenergy/i.test(t) ||
      (/WoodRiver\s*Energy/i.test(t) && /Natural\s+Gas\s+Invoice/i.test(t)) ||
      (/Production\s+Month/i.test(t) &&
        /Acct\/Meter/i.test(t) &&
        /Sub-?Total/i.test(t) &&
        /Total\s+Current\s+Charges/i.test(t)),
    extractAll: function (t) {
      // ── Invoice-level header fields ──
      const invNumM = t.match(/Invoice\s*#[\s:]*(\d{5,7})/i);
      const InvoiceNumber = invNumM ? invNumM[1] : null;
      const custNumM = t.match(/Customer\s*#[\s:]*(\d+)/i);
      const CustomerNumber = custNumM ? custNumM[1] : null;
      const billDateM = t.match(/Bill\s*Date[\s:]*(\d{2}\/\d{2}\/\d{4})/i);
      const BillDate = billDateM ? billDateM[1] : null;

      // ProductionMonth: the label and value appear on SEPARATE lines in pdftotext.
      // Label line: "Customer #: Invoice #: Production Month: Acct Rep: Bill Date: Pmt Due Date:"
      // Value line: "13027 478203 November 2025 Alan Pederson 12/10/2025 12/25/2025"
      // Strategy: look for the data line that contains a month name + 4-digit year,
      // which appears on the line immediately after the label line (or within 3 lines).
      let ProductionMonth = null;
      {
        const _lines = t.split(/\r?\n/);
        // First try: inline match (some OCR may join them)
        const pmInlineM = t.match(/Production\s+Month[\s:]*([A-Za-z]+\s+\d{4})/i);
        if (pmInlineM) {
          ProductionMonth = pmInlineM[1];
        } else {
          // Two-line match: find the label line, then scan the next few lines
          // for a month name followed by a 4-digit year
          const monthRe =
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i;
          for (let _i = 0; _i < _lines.length; _i++) {
            if (/Production\s+Month/i.test(_lines[_i])) {
              for (let _j = _i + 1; _j < Math.min(_i + 5, _lines.length); _j++) {
                const _mM = _lines[_j].match(monthRe);
                if (_mM) {
                  ProductionMonth = _mM[1] + ' ' + _mM[2];
                  break;
                }
              }
              if (ProductionMonth) break;
            }
          }
        }
      }

      // ── Billing period from Production Month ──
      // "November 2025" → BillingPeriodStart = 11/01/2025, BillingPeriodEnd = 11/30/2025
      let BillingPeriodStart = null;
      let BillingPeriodEnd = null;
      if (ProductionMonth) {
        const WRE_MONTH_MAP = {
          january: 0,
          february: 1,
          march: 2,
          april: 3,
          may: 4,
          june: 5,
          july: 6,
          august: 7,
          september: 8,
          october: 9,
          november: 10,
          december: 11,
          jan: 0,
          feb: 1,
          mar: 2,
          apr: 3,
          jun: 5,
          jul: 6,
          aug: 7,
          sep: 8,
          oct: 9,
          nov: 10,
          dec: 11,
        };
        const parts = ProductionMonth.trim().split(/\s+/);
        const monthKey = (parts[0] || '').toLowerCase();
        const year = parseInt(parts[1], 10);
        const mo = WRE_MONTH_MAP[monthKey];
        if (mo !== undefined && !isNaN(year)) {
          const pad = (n) => String(n).padStart(2, '0');
          const startD = new Date(year, mo, 1);
          const endD = new Date(year, mo + 1, 0); // day 0 = last day of month
          BillingPeriodStart = pad(startD.getMonth() + 1) + '/' + pad(startD.getDate()) + '/' + startD.getFullYear();
          BillingPeriodEnd = pad(endD.getMonth() + 1) + '/' + pad(endD.getDate()) + '/' + endD.getFullYear();
        }
      }

      // ── OCR dollar restoration helper ──
      // Tesseract reads "$6,474.51" as "$6.474.51" (comma→period corruption).
      // Detect the double-period thousands pattern (\d{1,3}.\d{3}.\d{2}) and
      // restore the first period to a comma.  Apply ONLY to dollar strings, never MMbtu.
      function _wreFixOcrDollar(raw) {
        if (!raw) return raw;
        return raw.replace(/^(\d{1,3})\.(\d{3})\.(\d{2})$/, '$1,$2.$3');
      }

      // ── Invoice-level summary totals (page 2) ──
      // In pdftotext output the label line and value lines are SEPARATE:
      //   Label: "Total Natural Gas: Total Fees: Total Tax: Total Current Charges:"
      //   MMbtu value line: "Mmbtu 1,308.52"
      //   Summary $ line: "$5,475.06 $0.00 $0.00"   followed by "$5,475.06"
      // Strategy: find the label line, then scan the next few lines for values.
      // Fallback: try inline match (works for OCR that may join label+value).
      // Fix 3: OCR invoices produce "$25.410.37" for "$25,410.37" — restore via
      // _wreFixOcrDollar before storing summaryTotalCC.
      let summaryMMbtu = null;
      let summaryTotalCC = null;
      {
        const _sumLines = t.split(/\r?\n/);
        // Inline fallback first — match the longest plausible dollar string
        // (allow up to 2 periods so we can capture the OCR-corrupted form too)
        const inlineMMbtu = t.match(/Total\s+Natural\s+Gas[\s:]*([\d,]+\.?\d*)/i);
        if (inlineMMbtu && /\d/.test(inlineMMbtu[1])) {
          summaryMMbtu = parseFloat(inlineMMbtu[1].replace(/,/g, ''));
        }
        // Capture up to "D.DDD.DD" (OCR-corrupted) or "D,DDD.DD" (clean)
        const inlineCC = t.match(/Total\s+Current\s+Charges[\s:$]*([\d,]+\.[\d.]{4,7})/i);
        if (inlineCC)
          summaryTotalCC = _wreFixOcrDollar(
            inlineCC[1].replace(/,/g, '').replace(/^(\d+)\.(\d{3})\.(\d{2})$/, '$1,$2.$3'),
          );

        // Two-line extraction: find the totals label line and look ahead
        for (let _i = 0; _i < _sumLines.length; _i++) {
          if (/Total\s+Natural\s+Gas/i.test(_sumLines[_i])) {
            for (let _j = _i + 1; _j < Math.min(_i + 8, _sumLines.length); _j++) {
              const _ln = _sumLines[_j].trim();
              // "Mmbtu 1,308.52" or "1,308.52" pattern
              if (!summaryMMbtu) {
                const _mM = _ln.match(/(?:Mmbtu\s+)?([\d,]+\.\d+)/i);
                if (_mM && !/^\s*Fuel/i.test(_ln) && !/^\s*\$/.test(_ln)) {
                  const _v = parseFloat(_mM[1].replace(/,/g, ''));
                  if (_v > 100) {
                    summaryMMbtu = _v;
                  } // sanity: total MMbtu > 100
                }
              }
              // "$5,475.06 $0.00 $0.00" — first dollar value is total CC
              if (!summaryTotalCC) {
                const _dM = _ln.match(/^\s*\$([\d,.]+\.\d{2})\s+\$0\.00/);
                if (_dM) {
                  summaryTotalCC = _wreFixOcrDollar(_dM[1].replace(/,/g, ''));
                }
              }
              // Standalone "$5,475.06" line (repeated total line)
              if (!summaryTotalCC) {
                const _sM = _ln.match(/^\s*\$([\d,.]+\.\d{2})\s*$/);
                if (_sM) {
                  summaryTotalCC = _wreFixOcrDollar(_sM[1].replace(/,/g, ''));
                }
              }
            }
            break;
          }
        }
      }

      // ── Block-based per-site extraction ──
      // Both embedded-text and OCR invoices place the Service Address label,
      // building name, and Acct/Meter value on the SAME line:
      //   "Service Address: BofE - <REDACTED-ADDR> Acct/Meter: <REDACTED-METER>"
      // Each site ends with a Sub-Total line:
      //   "Sub-Total:   13.49   0.13   $56.45"
      // The first number after "Sub-Total:" is the MMbtu; the last dollar value
      // is the site charge.  OCR invoices may corrupt thousands commas to periods
      // in dollar amounts (e.g. $1.058.61 → should be $1,058.61) — restored below.
      //
      // The Timber Sage site straddles a page break: its "Service Address:" line
      // is the last line of page 1, and the city line + item rows + Sub-Total all
      // appear on page 2.  Because we key off "Service Address:" to OPEN a block
      // and off "Sub-Total:" to CLOSE it, the page break is transparent.
      //
      // Stop at "Total Natural Gas:" to avoid collecting the summary sub-total.

      // ── 5. Special Weather Event detection ──
      const hasSWEGlobal = /Special\s+Weather\s+Event/i.test(t);

      // ── Block parser ──
      // Fix (2026-07-22, Wood River per-site OCR consensus): factored the parsing
      // loop into a function of `text` (was inline against `t` only) so it can be
      // re-run against ALTERNATE OCR passes below to recover sites the PRIMARY
      // (highest-scoring) pass garbled. See the consensus merge step after
      // `siteBlocks` is built. Behavior against `t` alone is unchanged.
      function _parseWRESiteBlocks(text) {
        const _lines = text.split(/\r?\n/);
        const blocks = []; // [{ServiceAddress, AccountNumber, MeterNumber, mmbtu, dollar}]
        let _cur = null; // the currently-open site block object
        let _inSites = false; // true once we pass the header section

        for (let i = 0; i < _lines.length; i++) {
          const ln = _lines[i];

          // Stop at invoice summary line
          if (/Total\s+Natural\s+Gas/i.test(ln)) break;

          // Detect "Service Address:" line — opens a new site block.
          // The building name and Acct/Meter appear on the SAME line in all formats.
          // Fix (2026-07-22, Wood River May/Sep/Oct 2025 legibility): same punctuation-
          // corruption tolerance as the Sub-Total fix above — OCR misread this line's
          // colon as a period on Inv 452084's High Schl site ("Service Address.  High
          // Schl..."), which with the old strict-colon regex meant that site's block
          // never opened at all (not even a stub), silently shrinking the whole
          // downstream site array by one and shifting every later site's position.
          if (/Service\s+Address\s*[:;,.]?/i.test(ln)) {
            _inSites = true;
            // Extract building name (text between "Service Address:" and "Acct/Meter:")
            // Fix (2026-07-28, gas-bill-ocr-extraction): the "Acct/Meter" LABEL's slash is
            // frequently misread by OCR — verified on Inv 447604 (Apr 2025): "AcctUMeter",
            // "AcctMeter" (slash dropped entirely). The old regex required a literal "/" in
            // the label, so every site on that invoice silently lost its AccountNumber AND
            // MeterNumber even though the VALUE side ("560189/T920419C") read back fine —
            // only the label's punctuation was corrupted. Tolerate 0-2 stray characters
            // (U/1/l/I/|/./space/etc, OCR's common misreads of "/") between "Acct" and
            // "Meter" in the LABEL only; the VALUE separator below is unchanged.
            const _saM = ln.match(
              /Service\s+Address\s*[:;,.]?\s*(.+?)\s+Acct[\s\/\\|Uu1IlL.,;:]{0,3}Meter\s*[:;,.]?\s*([\w\d][\w\d\-]{2,11})\/([\w\d\-]{3,15})/i,
            );
            let _addr, _acct, _meter;
            if (_saM) {
              _addr = _saM[1].trim();
              _acct = _saM[2].trim();
              _meter = _saM[3].trim();
            } else {
              // Fallback: no Acct/Meter on same line (shouldn't happen but be safe)
              const _saOnly = ln.match(/Service\s+Address\s*[:;,.]?\s*(.+)/i);
              _addr = _saOnly ? _saOnly[1].trim() : null;
              _acct = null;
              _meter = null;
            }
            // Fix (2026-07-22, per-site OCR consensus): push the block IMMEDIATELY on
            // open rather than only when a Sub-Total line later closes it. This keeps
            // every site's POSITION in `blocks` stable (the Nth "Service Address:" is
            // always blocks[N]) even when a site's Sub-Total/Index line is too OCR-
            // garbled to parse — previously such a site was silently omitted from
            // `blocks` entirely, which (a) shifted every later site's array index
            // (breaking any positional cross-pass comparison) and (b) meant the site's
            // charge was just gone with no trace, rather than present-but-null and
            // recoverable via the fallbacks below / the consensus merge that follows.
            _cur = {
              ServiceAddress: _addr,
              AccountNumber: _acct,
              MeterNumber: _meter,
              mmbtu: null,
              dollar: null,
              triggerCharge: null,
              indexCharge: null,
              sweCharge: null,
              triggerMMbtu: null,
              indexMMbtu: null,
              triggerRate: null,
              indexRate: null,
            };
            blocks.push(_cur);
            continue;
          }

          // Inline Acct/Meter on a line after Service Address (safety fallback)
          // Fix (2026-07-28, gas-bill-ocr-extraction): same label-slash OCR tolerance as
          // the primary Service Address match above.
          if (_inSites && _cur && !_cur.AccountNumber && /Acct[\s\/\\|Uu1IlL.,;:]{0,3}Meter\s*[:;,.]?/i.test(ln)) {
            const _amM = ln.match(
              /Acct[\s\/\\|Uu1IlL.,;:]{0,3}Meter\s*[:;,.]?\s*([\w\d][\w\d\-]{2,11})\/([\w\d\-]{3,15})/i,
            );
            if (_amM) {
              _cur.AccountNumber = _amM[1].trim();
              _cur.MeterNumber = _amM[2].trim();
            }
            continue;
          }

          // Trigger - Fixed charge component line.
          // Format: "Trigger - Fixed   6.24   0.07   $5.2650   $33.22"
          // First number after label = per-component MMBtu; last dollar amount = charge.
          // Rate column ($5.2650) appears between fuel column and the final $ charge.
          if (_inSites && _cur && /Trigger\s*-?\s*Fixed/i.test(ln)) {
            // Fix (2026-07-22): accept OCR comma→period corrupted form ($1.337.90) the
            // same way the Sub-Total line already does, and restore it via _wreFixOcrDollar.
            // Without this, any Trigger charge >= $1,000 silently parsed as null, causing
            // _wreTriggerCharge to stay null and the per-site Sum Mismatch banner to fire
            // even though GasCharge/TotalCurrentCharges themselves were correct.
            const _trigDollarM = ln.match(/\$(\d{1,3}\.\d{3}\.\d{2})\s*$/) || ln.match(/\$([\d,]+\.\d{2})\s*$/);
            if (_trigDollarM) _cur.triggerCharge = parseFloat(_wreFixOcrDollar(_trigDollarM[1]).replace(/,/g, ''));
            const _trigMmbtuM = ln.match(/Trigger\s*-?\s*Fixed\s+([\d,]+\.?\d*)/i);
            if (_trigMmbtuM) _cur.triggerMMbtu = parseFloat(_trigMmbtuM[1].replace(/,/g, ''));
            // Capture printed rate — second-to-last $ value on the line (Rate column)
            const _trigRateMs = ln.match(/\$([\d,]+\.\d{4})/g);
            if (_trigRateMs && _trigRateMs.length >= 1) {
              _cur.triggerRate = _trigRateMs[_trigRateMs.length - 1].replace(/^\$/, '');
            }
            continue;
          }

          // Index (FOM) charge component line.
          // Format: "Index (FOM)   3.34   0.04   $5.0550   $17.09"
          // OCR variants: "IndexbOM)  60.03  0.67  $5.0550  $306.84" — tolerate garbled parens/O vs 0
          // First number after label = per-component MMBtu; last dollar amount = charge.
          // Rate column ($5.0550) appears between fuel column and the final $ charge.
          if (_inSites && _cur && /Index[\s(b]*(?:FOM|0M|OM)/i.test(ln)) {
            // Fix (2026-07-22): same OCR comma→period corruption fix as the Trigger line
            // above — Index charges are frequently >= $1,000 (e.g. "$1,337.90" misread as
            // "$1.337.90"), which the old plain-comma regex silently failed to match.
            const _idxDollarM = ln.match(/\$(\d{1,3}\.\d{3}\.\d{2})\s*$/) || ln.match(/\$([\d,]+\.\d{2})\s*$/);
            if (_idxDollarM) _cur.indexCharge = parseFloat(_wreFixOcrDollar(_idxDollarM[1]).replace(/,/g, ''));
            const _idxMmbtuM = ln.match(/Index[\s\S]{0,10}?(?:FOM|0M|OM)[)\s]+([\d,]+\.?\d*)/i);
            if (_idxMmbtuM) _cur.indexMMbtu = parseFloat(_idxMmbtuM[1].replace(/,/g, ''));
            // Capture printed rate — last 4-decimal $ value before the 2-decimal charge
            const _idxRateMs = ln.match(/\$([\d,]+\.\d{4})/g);
            if (_idxRateMs && _idxRateMs.length >= 1) {
              _cur.indexRate = _idxRateMs[_idxRateMs.length - 1].replace(/^\$/, '');
            }
            continue;
          }

          // Special Weather Event charge component line (present only on some invoices).
          // Format: "Special Weather Event  -2.98  -0.03  $-20.8065  $62.63"
          // The dollar charge is POSITIVE (surcharge), despite negative MMbtu/rate columns.
          if (_inSites && _cur && /Special\s+Weather\s+Event/i.test(ln)) {
            // Fix (2026-07-22): same OCR comma→period corruption fix as Trigger/Index above,
            // applied here too since SWE surcharges can also exceed $1,000 (e.g. JAN 26 invoice).
            const _sweDollarM = ln.match(/\$(\d{1,3}\.\d{3}\.\d{2})\s*$/) || ln.match(/\$([\d,]+\.\d{2})\s*$/);
            if (_sweDollarM) _cur.sweCharge = parseFloat(_wreFixOcrDollar(_sweDollarM[1]).replace(/,/g, ''));
            continue;
          }

          // Sub-Total line — closes the current site block.
          // Format: "Sub-Total:   13.49   0.13   $56.45"  (embedded)
          //         "Sub-Total:                                   9.58   0.11   $50.31" (OCR with wide spaces)
          // Fix 3: dollar value may have OCR comma→period corruption.
          // Fix (2026-07-22, Wood River May/Sep/Oct 2025 legibility): the closing colon
          // after "Sub-Total" is frequently misread by OCR as a period, semicolon, or
          // comma ("Sub-Total.", "Sub-Total;", "Sub Total,"), and the dash between the
          // words is sometimes dropped entirely ("Sub Total:"). Requiring a literal
          // colon (and only a single optional dash) silently dropped ~70% of a real
          // invoice's per-site totals even after the render-quality fix above — verified
          // against Inv 452084 (May 2025): only 3/10 Sub-Total lines matched the old
          // strict pattern, 8/10 matched once punctuation was tolerated. Widened to accept
          // any of :;,. as the closing punctuation (or none) and 0-2 chars (space/dash/
          // period) between "Sub" and "Total".
          if (_cur && /^\s*Sub[\s.\-]{0,2}Total\s*[:;,.]?/i.test(ln)) {
            // First number after the colon = MMbtu
            const _mmbtuM = ln.match(/Sub[\s.\-]{0,2}Total\s*[:;,.]?\s*([\d,]+\.?\d*)/i);
            // Last dollar value on the line = site charge.
            // Accept both clean form ($1,425.42) and OCR-corrupted form ($1.425.42).
            const _dollarM = ln.match(/\$(\d{1,3}\.\d{3}\.\d{2})\s*$/) || ln.match(/\$([\d,]+\.\d{2})\s*$/);
            if (_mmbtuM) _cur.mmbtu = parseFloat(_mmbtuM[1].replace(/,/g, ''));
            if (_dollarM) _cur.dollar = _wreFixOcrDollar(_dollarM[1]);
            // Do NOT clear _cur here — a stray non-closing line before the next
            // "Service Address:" should not lose the block; the next open replaces it.
            continue;
          }
        }

        // Fix (2026-07-22): fallback when the Sub-Total line's OWN dollar figure never
        // parses (that specific line's OCR corruption goes beyond punctuation — e.g. the
        // "$" sign itself is dropped), but a component charge line for the SAME site
        // (Index/Trigger/SWE) DID capture a valid "$"-anchored dollar. Sub-Total is
        // defined as the sum of the component charge lines printed directly above it on
        // every invoice on file — this is not a guessed value, it's the same figure
        // already correctly read from a different row of the same site block.
        for (const b of blocks) {
          if (b.dollar == null) {
            const parts = [b.triggerCharge, b.indexCharge, b.sweCharge].filter((v) => v != null);
            if (parts.length > 0) {
              b.dollar = parts.reduce((s, v) => s + v, 0).toFixed(2);
              b._dollarFromComponents = true;
            }
          }
          if (b.mmbtu == null) {
            const mparts = [b.triggerMMbtu, b.indexMMbtu].filter((v) => v != null);
            if (mparts.length > 0) b.mmbtu = mparts.reduce((s, v) => s + v, 0);
          }
        }

        return blocks;
      }

      const siteBlocks = _parseWRESiteBlocks(t);
      console.log('[WRE] Block parser: siteBlocks=' + siteBlocks.length);

      // ── Per-site OCR consensus recovery (2026-07-22) ──
      // `t` is ONE whole-page OCR pass chosen by keyword score — but that single
      // pass can still garble an individual site's Sub-Total line badly enough that
      // NO site block gets produced for it at all (verified: WRE Inv 452084 May 2025
      // — the "High Schl" site's Index/Sub-Total row was dropped or lost its "$" in
      // every one of the 9 render scale/PSM combinations tried for the winning page).
      // window._pdfOcrPasses already holds every OCR pass's full text (computed during
      // extractPDFText — zero extra OCR cost to reuse here). Each pass reads the same
      // physical page top-to-bottom, so the Nth "Service Address:" block lines up
      // positionally across passes even when one pass drops a row. For any site whose
      // dollar total didn't come through in the primary parse, try every other pass's
      // parse of the SAME page at the SAME position and take the first one that has a
      // valid (still "$"-anchored, never guessed) dollar figure.
      if (typeof window !== 'undefined' && window._pdfOcrPasses && siteBlocks.some((b) => b.dollar == null)) {
        const _altTexts = [];
        for (const _passes of Object.values(window._pdfOcrPasses)) {
          for (const _p of _passes) {
            if (_p.text && _p.text !== t && !_altTexts.includes(_p.text)) _altTexts.push(_p.text);
          }
        }
        if (_altTexts.length > 0) {
          // Fix (2026-07-22): positional (index) matching across passes is only safe
          // once confirmed the two blocks are actually the SAME site — a different
          // pass can drop/add a block elsewhere on the page, shifting every later
          // index, and blindly trusting position silently copies the WRONG site's
          // dollar onto this one (confirmed by testing: an early version of this merge
          // with no address check pulled a later site's $390.99 onto an earlier site
          // that should have read $2.63). Requiring the alt pass to have the exact same
          // total block count turned out too strict — most alt passes differ by 1-2
          // blocks due to unrelated OCR noise elsewhere on the page, so almost nothing
          // ever qualified. The address check below is the real safety net and does not
          // depend on matching array lengths, so the count requirement is dropped.
          // Addresses must match: normalize each to an alphanumeric-only lowercase key
          // and require it to be non-empty and identical (or one a prefix of the other)
          // on BOTH sides — if EITHER side's address is too garbled to produce a usable
          // key, skip that pairing rather than guess.
          const _addrKey = (s) =>
            (s || '')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')
              .slice(0, 8);
          const _altBlocksList = [];
          for (const _altText of _altTexts) {
            try {
              _altBlocksList.push(_parseWRESiteBlocks(_altText));
            } catch (_e) {
              /* alt pass parse failed — skip it */
            }
          }
          for (let _idx = 0; _idx < siteBlocks.length; _idx++) {
            if (siteBlocks[_idx].dollar != null) continue; // already have a real value
            const _primaryKey = _addrKey(siteBlocks[_idx].ServiceAddress);
            if (_primaryKey.length < 4) continue; // primary address too garbled to verify against — skip
            for (const _altBlocks of _altBlocksList) {
              // Fix (2026-07-22): EXACT index only — no positional window search.
              // This invoice format can legitimately repeat the SAME building name at
              // multiple site blocks (e.g. "Elem - 300 S Webster St" appears twice, once
              // per meter) — the only thing that distinguishes those entries is the
              // meter number, which OCR corrupts too unreliably to use as a key. A
              // window search (tried and reverted) matched on address text alone and
              // pulled site N+1's value onto site N in exactly this repeated-name case.
              // Exact-index + address-still-must-match is the safe combination: it only
              // ever accepts a value from the position that ACTUALLY reads top-to-bottom
              // as "the same site" in an alt pass with compatible block ordering.
              const _cand = _altBlocks[_idx];
              if (_cand && _cand.dollar != null) {
                const _candKey = _addrKey(_cand.ServiceAddress);
                if (_candKey.length < 4 || _candKey !== _primaryKey) continue;
              } else {
                continue;
              }
              if (!_cand) continue;
              siteBlocks[_idx].dollar = _cand.dollar;
              siteBlocks[_idx]._consensusRecovered = true;
              if (siteBlocks[_idx].mmbtu == null) siteBlocks[_idx].mmbtu = _cand.mmbtu;
              if (siteBlocks[_idx].indexCharge == null) siteBlocks[_idx].indexCharge = _cand.indexCharge;
              if (siteBlocks[_idx].triggerCharge == null) siteBlocks[_idx].triggerCharge = _cand.triggerCharge;
              if (siteBlocks[_idx].sweCharge == null) siteBlocks[_idx].sweCharge = _cand.sweCharge;
              if (!siteBlocks[_idx].ServiceAddress) siteBlocks[_idx].ServiceAddress = _cand.ServiceAddress;
              break;
            }
          }
          console.log(
            '[WRE] Consensus recovery: ' +
              siteBlocks.filter((b) => b._consensusRecovered).length +
              ' site(s) recovered from alternate OCR passes',
          );
        }
      }

      const results = [];
      for (let i = 0; i < siteBlocks.length; i++) {
        const blk = siteBlocks[i];
        // Fix (2026-07-28, gas-bill-ocr-extraction): a site block that has NEITHER an
        // AccountNumber NOR a usable mmbtu was previously `continue`d — silently dropped
        // with zero trace. Verified on Inv 447604 (Apr 2025, low-DPI scan): 8 of this
        // invoice's 10 known sites (per spring-hill.md's 10-site Wood River format) vanished
        // this way with no warning, no manual-review row, nothing — the app showed 2 bills
        // and gave no indication 8 more existed on the page. Same class of defect as
        // b5951068 (per-page parse errors) but at the per-SITE level within one page. Surface
        // it the same way: a flagged manual-review record carrying whatever was legible
        // (ServiceAddress fragment, dollar-from-components fallback if any) so the user sees
        // every site the invoice lists, even ones OCR couldn't fully read.
        if (!blk.AccountNumber && blk.mmbtu == null) {
          if (!blk.ServiceAddress && blk.dollar == null) continue; // truly nothing legible — not even a stub worth showing
          results.push({
            UtilityCompany: 'Wood River Energy',
            Commodity: 'Gas',
            _utilityName: 'Wood River Energy',
            InvoiceNumber,
            CustomerNumber,
            AccountNumber: null,
            MeterNumber: null,
            ServiceAddress: blk.ServiceAddress || null,
            BillingPeriodStart,
            BillingPeriodEnd,
            BillDate,
            ProductionMonth,
            NaturalGasMMbtu: null,
            TotalCurrentCharges: blk.dollar || null,
            TotalAmountDue: blk.dollar || null,
            parseError: true,
            _manualReview: true,
            _manualReviewLabel:
              'Parse error — site block unreadable (site #' +
              (i + 1) +
              (blk.ServiceAddress ? ': ' + blk.ServiceAddress : '') +
              ' — OCR could not read account/meter or usage; re-run extraction or enter manually)',
          });
          continue;
        }

        // Fix (2026-07-28, gas-bill-ocr-extraction TASK 3): rate-based sanity cross-
        // check. Tesseract can misread a digit in MMbtu (real 4.74 read as 174) or in
        // an account number, but the DOLLAR charge on this invoice format extracts
        // correctly even on the worst real bill tested (verified exact on Inv 447604:
        // $22.92/$182.02/$417.16/$604.41). Each per-site block prints its own MMbtu,
        // rate, AND resulting charge for both the Trigger and Index components, so
        // MMbtu*rate can be checked against the printed charge without any external
        // data. Tolerance chosen from real observed data, not a guess: probed all 10
        // sites' Trigger AND Index components (20 checks) on Inv 478203 (Nov 2025) —
        // the one Spring Hill invoice with a real digital text layer (no OCR involved,
        // so every discrepancy here is legitimate bill-rounding, not misread digits).
        // Every single check came back within -0.89% to -0.97% of the printed charge
        // (the bill's printed MMbtu/rate are rounded to fewer decimals than its own
        // internal billing math) — a tight, consistent band under 1%. 5% is >5x that
        // natural rounding floor, so it will never false-flag a correctly-read site,
        // while a genuine digit misread (e.g. 174 vs 4.74 MMbtu is a ~3570% swing)
        // blows past it by orders of magnitude. The $1 floor (AND, not OR) additionally
        // guards the smallest real sites (e.g. a $0.47 total bill) from being flagged
        // purely on cents-level rounding noise inflating a % check at tiny scale.
        const _wreRateMismatch = (mmbtu, rate, charge) => {
          if (mmbtu == null || rate == null || charge == null || charge === 0) return false;
          const computed = mmbtu * rate;
          const deltaPct = (Math.abs(computed - charge) / Math.abs(charge)) * 100;
          const deltaDollar = Math.abs(computed - charge);
          return deltaPct > 5 && deltaDollar > 1;
        };
        const _trigMismatch = _wreRateMismatch(
          blk.triggerMMbtu,
          blk.triggerRate != null ? parseFloat(blk.triggerRate) : null,
          blk.triggerCharge,
        );
        const _idxMismatch = _wreRateMismatch(
          blk.indexMMbtu,
          blk.indexRate != null ? parseFloat(blk.indexRate) : null,
          blk.indexCharge,
        );
        // Second, rate-INDEPENDENT identity check: the Sub-Total line's own printed
        // MMbtu must equal Trigger MMbtu + Index MMbtu — they are literally the same
        // number, printed twice on the same invoice (once as two line items, once as
        // their sum). Needed because the rate-based check above goes blind whenever
        // the RATE column itself is OCR-unreadable (confirmed on Inv 447604 site #1:
        // Sub-Total read as 174 MMbtu, but Index alone read as 424 MMbtu with the rate
        // column unreadable — the rate check had nothing to compare, but 424 MMbtu
        // from ONE component can never fit inside a 174 MMbtu total, which this check
        // catches without needing any rate at all). Empirically verified on the same
        // 478203 clean-text sample used above: Sub-Total MMbtu equals
        // TriggerMMbtu+IndexMMbtu on 10/10 sites, within 0.01 MMbtu (2-decimal
        // print-rounding). Tolerance set to max(0.1 MMbtu, 3% of the sub-total) — 10x
        // that observed 0.01 rounding floor — so it won't false-flag a clean bill.
        const _wreComponentSumMismatch = (subTotal, trigMmbtu, idxMmbtu) => {
          if (subTotal == null || (trigMmbtu == null && idxMmbtu == null)) return false;
          const sum = (trigMmbtu != null ? trigMmbtu : 0) + (idxMmbtu != null ? idxMmbtu : 0);
          const tolerance = Math.max(0.1, subTotal * 0.03);
          if (trigMmbtu != null && idxMmbtu != null) {
            return Math.abs(sum - subTotal) > tolerance;
          }
          // Only one component legible: a non-negative component can never exceed the total.
          return sum > subTotal + tolerance;
        };
        const _sumMismatch = _wreComponentSumMismatch(blk.mmbtu, blk.triggerMMbtu, blk.indexMMbtu);
        const _mmbtuRateMismatch = _trigMismatch || _idxMismatch || _sumMismatch;
        if (_mmbtuRateMismatch) {
          console.log(
            '[WRE] Rate/sum cross-check FAILED for site #' +
              (i + 1) +
              (blk.ServiceAddress ? ' (' + blk.ServiceAddress + ')' : '') +
              ' — trigger mismatch=' +
              _trigMismatch +
              ', index mismatch=' +
              _idxMismatch +
              ', sub-total-vs-components mismatch=' +
              _sumMismatch +
              '. NaturalGasMMbtu suppressed, flagged for manual review.',
          );
        }

        results.push({
          UtilityCompany: 'Wood River Energy',
          Commodity: 'Gas',
          _utilityName: 'Wood River Energy',
          InvoiceNumber,
          CustomerNumber,
          AccountNumber: blk.AccountNumber,
          MeterNumber: blk.MeterNumber,
          ServiceAddress: blk.ServiceAddress,
          BillingPeriodStart,
          BillingPeriodEnd,
          BillDate,
          ProductionMonth,
          NaturalGasMMbtu: _mmbtuRateMismatch ? null : blk.mmbtu != null ? String(blk.mmbtu) : null,
          NaturalGasTherms: null,
          NaturalGasCCF: null,
          GasCharge: blk.dollar || null,
          CustomerCharge: null,
          TotalCurrentCharges: blk.dollar || null,
          TotalAmountDue: blk.dollar || null,
          // Per-site charge components (Fix 1 — a84458f0 defect 1)
          _wreTriggerCharge: blk.triggerCharge != null ? String(blk.triggerCharge) : null,
          _wreIndexCharge: blk.indexCharge != null ? String(blk.indexCharge) : null,
          _wreSWECharge: blk.sweCharge != null ? String(blk.sweCharge) : null,
          // Per-component MMBtu quantities (fix 8a271dae — for per-component rate display)
          _wreTriggerMMbtu: blk.triggerMMbtu != null ? String(blk.triggerMMbtu) : null,
          _wreIndexMMbtu: blk.indexMMbtu != null ? String(blk.indexMMbtu) : null,
          _wreTriggerRate: blk.triggerRate || null,
          _wreIndexRate: blk.indexRate || null,
          _wreHasSWE: hasSWEGlobal,
          _wreSummaryMMbtu: summaryMMbtu,
          _wreSummaryTotal: summaryTotalCC,
          _wreInvoiceMMbtu: summaryMMbtu,
          // TASK 3 rate cross-check markers — reuse the existing manual-review
          // mechanism rather than inventing a second one; never silently "correct"
          // the number toward what the math implies, only flag it.
          _mmbtuRateMismatch: _mmbtuRateMismatch || undefined,
          _manualReview: _mmbtuRateMismatch ? true : undefined,
          _manualReviewLabel: _mmbtuRateMismatch
            ? 'Usage flagged — MMbtu × printed rate does not match the printed charge (site #' +
              (i + 1) +
              (blk.ServiceAddress ? ': ' + blk.ServiceAddress : '') +
              ' — likely a misread digit; verify usage manually)'
            : undefined,
        });
      }

      // Aggregate fallback: if block extraction yielded nothing, fall back to
      // one aggregate record using invoice-level totals.
      if (results.length === 0 && summaryTotalCC) {
        console.log('[WRE] No per-site records — falling back to aggregate record');
        results.push({
          UtilityCompany: 'Wood River Energy',
          Commodity: 'Gas',
          _utilityName: 'Wood River Energy',
          InvoiceNumber,
          CustomerNumber,
          AccountNumber: CustomerNumber,
          ServiceAddress: 'Multi-Site District Account (aggregate)',
          BillingPeriodStart,
          BillingPeriodEnd,
          BillDate,
          ProductionMonth,
          NaturalGasMMbtu: summaryMMbtu ? String(summaryMMbtu) : null,
          NaturalGasTherms: null,
          NaturalGasCCF: null,
          GasCharge: summaryTotalCC || null,
          TotalCurrentCharges: summaryTotalCC,
          TotalAmountDue: summaryTotalCC,
          _wreAggregateFallback: true,
        });
      }

      // ── Cross-check: sum of per-site SubTotals vs invoice summary ──
      if (results.length > 0 && summaryTotalCC) {
        const siteSum = results.reduce(
          (acc, r) => acc + (parseFloat((r.TotalCurrentCharges || '').replace(/,/g, '')) || 0),
          0,
        );
        const invTotal = parseFloat((summaryTotalCC || '').replace(/,/g, ''));
        const diff = Math.abs(siteSum - invTotal);
        if (diff > 0.5) {
          console.warn(
            '[WRE] Per-site sum $' +
              siteSum.toFixed(2) +
              ' ≠ invoice total $' +
              invTotal.toFixed(2) +
              ' (diff $' +
              diff.toFixed(2) +
              ')',
          );
        }
      }

      return results;
    },
    extract: function (t) {
      // Single-bill fallback: extract invoice-level aggregate (used only if extractAll fails)
      const invNumM = t.match(/Invoice\s*#[\s:]*(\d{5,7})/i);
      const pmM = t.match(/Production\s+Month[\s:]*([A-Za-z]+\s+\d{4})/i);
      const ProductionMonth = pmM ? pmM[1] : null;
      let BillingPeriodStart = null,
        BillingPeriodEnd = null;
      if (ProductionMonth) {
        const WRE_MONTH_MAP = {
          january: 0,
          february: 1,
          march: 2,
          april: 3,
          may: 4,
          june: 5,
          july: 6,
          august: 7,
          september: 8,
          october: 9,
          november: 10,
          december: 11,
          jan: 0,
          feb: 1,
          mar: 2,
          apr: 3,
          jun: 5,
          jul: 6,
          aug: 7,
          sep: 8,
          oct: 9,
          nov: 10,
          dec: 11,
        };
        const parts = ProductionMonth.trim().split(/\s+/);
        const mo = WRE_MONTH_MAP[(parts[0] || '').toLowerCase()];
        const year = parseInt(parts[1], 10);
        if (mo !== undefined && !isNaN(year)) {
          const pad = (n) => String(n).padStart(2, '0');
          const endD = new Date(year, mo + 1, 0);
          BillingPeriodStart = pad(mo + 1) + '/01/' + year;
          BillingPeriodEnd = pad(endD.getMonth() + 1) + '/' + pad(endD.getDate()) + '/' + endD.getFullYear();
        }
      }
      const totalMMbtuM = t.match(/Total\s+Natural\s+Gas[\s:]*([\d,]+\.?\d*)/i);
      const totalCCM = t.match(/Total\s+Current\s+Charges[\s:$]*([\d,]+\.\d{2})/i);
      return {
        UtilityCompany: 'Wood River Energy',
        Commodity: 'Gas',
        _utilityName: 'Wood River Energy',
        InvoiceNumber: invNumM ? invNumM[1] : null,
        ProductionMonth,
        BillingPeriodStart,
        BillingPeriodEnd,
        NaturalGasMMbtu: totalMMbtuM ? String(parseFloat(totalMMbtuM[1].replace(/,/g, ''))) : null,
        NaturalGasTherms: null,
        NaturalGasCCF: null,
        TotalCurrentCharges: totalCCM ? totalCCM[1] : null,
        TotalAmountDue: totalCCM ? totalCCM[1] : null,
      };
    },
    _hasKeyField: function (extracted) {
      return !!(
        (extracted.AccountNumber || extracted.InvoiceNumber) &&
        (extracted.BillingPeriodStart || extracted.BillingPeriodEnd) &&
        extracted.TotalCurrentCharges
      );
    },
  },
  // ── End Wood River Energy ─────────────────────────────────────────────────
  {
    name: 'Gas Utility (Spire / Kansas Gas Service / Atmos / Laclede / Black Hills)',
    // Broadened detector — accepts any common gas-bill signature so multi-bill PDFs
    // from various gas providers route through this extractor instead of Generic.
    detect: (t) =>
      /spire|laclede/i.test(t) ||
      /kansas\s+gas\s+service/i.test(t) ||
      /atmos\s+energy/i.test(t) ||
      /black\s+hills\s+energy/i.test(t) ||
      (/\bnatural\s+gas\b|\btherms?\b|\bccf\b/i.test(t) && /(?:bill|invoice|statement)/i.test(t)) ||
      (/gas\s+(?:charge|service|meter)/i.test(t) && /(?:amount\s*due|total\s*charges?)/i.test(t)),
    _detectCompany: (t) => {
      if (/spire/i.test(t)) return 'Spire Energy';
      if (/laclede/i.test(t)) return 'Laclede Gas';
      if (/kansas\s+gas\s+service/i.test(t)) return 'Kansas Gas Service';
      if (/atmos\s+energy/i.test(t)) return 'Atmos Energy';
      if (/black\s+hills\s+energy/i.test(t)) return 'Black Hills Energy';
      return 'Natural Gas Utility';
    },
    extractAll: function (t) {
      // KGS bills: each page = one monthly bill, no "Service from" header.
      // Split on PDF page markers (%%PAGE_N%%) when present — these align with physical bill pages.
      // Statement Date appears mid-page in the address block, so splitting on it creates
      // phase-shifted sections where the Account Number anchor (top of page) and the meter row
      // holding BillingPeriodStart/End (bottom of same page) land in different sections.
      // Fall back to Statement Date split only for single-page or legacy PDFs without page markers.
      const isKGS = /kansas\s+gas\s+service/i.test(t);
      let splitRe;
      if (isKGS) {
        const _pageCount = t.split(/(?=%%PAGE_\d+%%)/).length - 1;
        if (_pageCount > 1) {
          // Always split KGS bills on PDF page markers. "Statement Date" sits mid-page
          // in the address block, so splitting on it phase-shifts sections — the meter row
          // (billing period From/To at the bottom of the page) lands in a different section
          // than its Account Number anchor (top of page), making the period unreadable.
          // Page markers align with physical bill boundaries.
          splitRe = /(?=%%PAGE_\d+%%)/;
        } else {
          // No page markers (legacy/single-chunk path) — fall back to Statement Date split.
          splitRe = /(?=Statement\s+Date\s+\d{2}-\d{2}-\d{2})/i;
        }
      } else {
        // Non-KGS gas bills: split on "Service from" headers
        splitRe = /(?=Service\s+(?:from|period)[\s:]+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i;
      }
      const raw = t.split(splitRe);
      const sections = [];
      const _unmatchedSections = [];
      for (const s of raw) {
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s) || /\d{2}-\d{2}-\d{2}/.test(s)) {
          sections.push(s);
        } else if (s.trim().length > 50) {
          const pageNums = [...s.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
          _unmatchedSections.push({ pageNums, preview: s.trim().slice(0, 200) });
        }
      }
      if (sections.length <= 1) return [this.extract(t)];
      const result = [];
      for (const s of sections) {
        const pageMarkers = [...s.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
        const pageStart = pageMarkers.length ? Math.min(...pageMarkers) : null;
        const pageEnd = pageMarkers.length ? Math.max(...pageMarkers) : null;

        // Multi-account KGS detection: if a section contains more than one "Account Number" header,
        // the OCR has linearized multiple account columns into a single text block. Split on each
        // "Account Number" boundary so each account is extracted independently.
        // Only applies to KGS sections (identified by the KGS brand text or Statement Date pattern).
        const isKGSSection = /kansas\s+gas\s+service/i.test(s) || /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(s);
        const accountMatches = isKGSSection ? [...s.matchAll(/Account\s+Number[\s:]*([0-9 ]{10,30})/gi)] : [];
        // Build a Set of distinct normalised account numbers. A KGS payment stub repeats the SAME
        // account number, so accountMatches.length can be 2 while there is only ONE real account.
        // Only invoke _splitAccountBlocks when there are genuinely different account numbers.
        const distinctAccounts = new Set(accountMatches.map((m) => m[1].replace(/\s+/g, '')));

        if (isKGSSection && accountMatches.length > 1 && distinctAccounts.size > 1) {
          // Split the section text at each "Account Number" boundary.
          // Each sub-block starts at an "Account Number" line and ends at the next one.
          // Use a helper that recursively splits until no sub-block contains more than one
          // Account Number occurrence. This handles OCR layouts where the initial split leaves
          // multiple account headers in one piece (e.g. 3+ accounts on a page).
          const _splitAccountBlocks = (text, depth = 0) => {
            if (depth > 50) return [text];
            const pieces = text.split(/(?=Account\s+Number[\s:]*[0-9 ]{10,30})/i).filter((b) => b.trim().length > 20);
            const result = [];
            for (const piece of pieces) {
              const count = (piece.match(/Account\s+Number[\s:]*[0-9 ]{10,30}/gi) || []).length;
              if (count > 1) {
                // Still has multiple accounts — recurse directly on piece (lookahead split already
                // anchors each piece to start at an "Account Number" header; re-slicing via indexOf
                // always returns 0 and causes infinite recursion when inter-account text is <21 chars)
                const sub = _splitAccountBlocks(piece, depth + 1);
                result.push(...sub);
              } else {
                result.push(piece);
              }
            }
            return result;
          };
          const subBlocks = _splitAccountBlocks(s);
          for (const block of subBlocks) {
            // Preserve the KGS brand text (needed for isKGS detection in extract()) and page markers
            // by prepending the section header up to the first "Account Number" if the block lacks it.
            const hasKGSBrand =
              /kansas\s+gas\s+service/i.test(block) || /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(block);
            const blockText = hasKGSBrand ? block : 'Kansas Gas Service\n' + block;
            const r = this.extract(blockText);
            // Skip records flagged by extract() as unidentifiable (no Account Number found).
            // These arise from pre-header text pieces that get passed through the split.
            if (r._skipRecord) continue;
            r._multiAccount = true;
            if (pageStart !== null) r._pageStart = pageStart;
            if (pageEnd !== null) r._pageEnd = pageEnd;
            result.push(r);
          }
        } else {
          let sText = s;
          if (isKGS && !/kansas\s+gas\s+service/i.test(s) && !/Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(s)) {
            sText = 'Kansas Gas Service\n' + s;
          }
          const r = this.extract(sText);
          // Skip records flagged as unidentifiable — do not emit wrong data.
          if (!r._skipRecord) {
            if (pageStart !== null) r._pageStart = pageStart;
            if (pageEnd !== null) r._pageEnd = pageEnd;
            result.push(r);
          }
        }
      }
      if (_unmatchedSections.length) result._unmatchedPages = _unmatchedSections;
      return result;
    },
    extract: function (t) {
      const company = this._detectCompany(t);

      // ── KGS dedicated extraction path ──────────────────────────────────────
      // KGS bills use a tabular columnar format — data is NOT on labeled lines
      // the way Spire/Atmos bills are. A dedicated path is required.
      const isKGS = /kansas\s+gas\s+service/i.test(t) || /Statement\s+Date\s+\d{2}-\d{2}-\d{2}/i.test(t);
      if (isKGS) {
        // Helper: normalize OCR number artifacts — colon misread as period (e.g. "17:55" → "17.55")
        const fixNum = (s) => (s ? s.replace(/(\d):(\d)/, '$1.$2') : null);

        // === ACCOUNT-ANCHORED REGION ===
        // When OCR linearizes two side-by-side account columns into one text block, all charge lines
        // from BOTH accounts appear after the two "Account Number" headers. Without anchoring, every
        // t.match() below uses first-match-wins and can pick up the wrong account's values.
        //
        // Strategy: find where THIS account's "Account Number" header starts and where the NEXT
        // "Account Number" header starts (if any). Slice out only this account's region and run all
        // field-extraction regexes against that slice (activeT) instead of the full block (t).
        // If the block has only one account this is a no-op (activeT === t).
        //
        // t is still used for brand/isKGS detection so that KGS-branded blocks are correctly routed
        // even when the block starts with page-header text before the first Account Number.
        const _acctRe = /Account\s+Number[\s:]*[0-9 ]{10,30}/gi;
        const _acctMatches = [...t.matchAll(_acctRe)];
        let activeT;
        if (_acctMatches.length === 0) {
          // No Account Number in this block at all — block is likely pre-account header text or
          // garbled OCR. Mark low-confidence and use the full text; fields will mostly be null.
          activeT = t;
        } else if (_acctMatches.length === 1) {
          // Single account — anchor from the start of the line containing "Account Number"
          // to end of block. Walking back to lineStart ensures that any text appearing to
          // the LEFT of "Account Number" on the same line (e.g. "BAKER UNIVERSITY") is
          // included in activeT so the CustomerName regex can capture it.
          const acctIdx = _acctMatches[0].index;
          const lineStart = t.lastIndexOf('\n', acctIdx - 1) + 1;
          activeT = t.slice(lineStart);
        } else {
          // Multiple Account Numbers survived into extract() — anchor to only the FIRST one.
          // (extractAll should have prevented this via _splitAccountBlocks, but defence in depth.)
          // Use the region from the first Account Number to just before the second.
          activeT = t.slice(_acctMatches[0].index, _acctMatches[1].index);
        }

        // === HEADER BLOCK ===
        // Account Number: "Account Number    <REDACTED-ACCT-SEG1> <REDACTED-ACCT-SEG2> <REDACTED-ACCT-SEG3>"
        const accountM = activeT.match(/Account\s+Number[\s:]*([0-9 ]{10,30})/i);
        const AccountNumber = accountM ? accountM[1].replace(/\s+/g, ' ').trim() : null;

        // Low-confidence guard: if no Account Number was found at all, this block cannot be
        // associated with any account. Return a flagged record rather than emitting wrong data.
        if (!AccountNumber) {
          return {
            UtilityCompany: 'Kansas Gas Service',
            Commodity: 'Gas',
            _skipRecord: true,
            _lowConfidence: true,
            _reason: 'No Account Number found in block — likely garbled OCR or pre-header text',
            commodity: 'gas',
            _utilityName: 'Kansas Gas Service',
          };
        }

        // Statement Date: "Statement Date  02-20-26"
        // OCR sometimes splits "Statement Date" across garbled tokens: "Stat     t Dat               12-19-25"
        // The word "Statement" becomes "Stat" + spaces + "t" and "Date" becomes "Dat".
        // Pattern 1: normal "Statement Date MM-DD-YY"
        // Pattern 2: garbled — allow any non-digit chars between "Stat" and the date, but keep it short
        // to avoid matching unrelated text. The date always appears within ~30 chars of "Stat".
        // Uses activeT so we only see dates belonging to this account's header block.
        const stmtM =
          activeT.match(/Statement\s+Dat\w*\s+(\d{2}-\d{2}-\d{2})/i) ||
          activeT.match(/Stat\b[^0-9\n]{0,30}(\d{2}-\d{2}-\d{2})/i);
        const StatementDate = stmtM ? stmtM[1] : null;

        // Rate Schedule: "Rate    Residential" or "Rate    General Service Lg"
        // OCR sometimes misreads "Rate" as "FE", "Fat", "Rat", etc. so we can't always rely on the
        // keyword. Primary: match the literal word "Rate" followed by the rate name on the same line.
        // Fallback: look for "Residential" or "General Service" near the header block.
        // Uses activeT to avoid picking up a different account's rate schedule.
        const rateM =
          activeT.match(/\bRate\s+(Residential|General\s+Service\s*(?:Sm|Lg|Med)?[A-Za-z]*|Commercial[A-Za-z ]*)/i) ||
          activeT.match(/(?:DIRECTOR OF FACILITIES|Active Deposit)[^\n]*(Residential|General\s+Service[^\n]{0,20})/i);
        const RateSchedule = rateM ? rateM[1].trim() : null;

        // Customer Name: all-caps line immediately before "DIRECTOR OF FACILITIES"
        // OCR renders "BAKER UNIVERSITY      Account Number ..." all on ONE line — the account number
        // text is on the same line, not a separate line. So \n won't separate them.
        // Pattern: capture the all-caps name appearing before the word DIRECTOR anywhere on the page,
        // allowing it to be on the same line (separated by many spaces) or a different line.
        // Uses activeT so each account yields its own customer name, not a neighbour's.
        const custM = activeT.match(/([A-Z][A-Z &]{2,50})\s{2,}(?:[A-Z0-9 ]*\n\s*)?DIRECTOR\s+OF\s+FACILITIES/i);
        const CustomerName = custM ? custM[1].trim() : null;

        // Service Address: KGS bills have the address on the line above "BALDWIN CITY, KS" but that
        // line also contains "Active Deposit   NONE | Statement Date  XX-XX-XX" (OCR merges columns).
        // Extract the street address from the beginning of that line, stopping before "Active".
        // Example: "305 6TH ST # 306          Active Deposit    NONE | Statement Date   11-18-25"
        // Uses activeT to avoid capturing another account's address.
        const addrM = activeT.match(/([A-Z0-9#][A-Z0-9# ]{4,49?})\s{2,}Active\s+D/i);
        // Fallback: if the primary pattern fails (OCR collision zone garbles "Active D"),
        // look for the street address in the mailing stub above "BALDWIN CITY, KS" in the
        // full text (t). The stub is outside activeT when "Account Number" is mid-page.
        // Pattern: a line of all-caps street text followed by 3+ spaces then BALDWIN CITY, KS.
        let ServiceAddress = addrM ? addrM[1].trim() : null;
        if (!ServiceAddress) {
          const _stub = t.match(/([A-Z0-9][A-Z0-9 #]{4,49}?)\s{3,}[^\n]{0,20}\n\s*BALDWIN\s+CITY,?\s+KS/i);
          if (_stub) ServiceAddress = _stub[1].trim();
        }

        // === METER READING TABLE ===
        // Pattern: MeterNum   MM-DD-YY   MM-DD-YY   Days   Prev   Curr   Const   Mcf   WNA/Mcf   CostGas/Mcf
        // OCR sometimes inserts "~~" between dates.
        // Groups 9 and 10 capture the printed per-Mcf rates: WNA/Mcf (strip leading $) and Cost of Gas/Mcf.
        // These are used by Pass A of the per-Mcf validation & recovery pass in _postExtractionVerify.
        // Uses activeT so only this account's meter row is matched.
        const meterRowM = activeT.match(
          /([A-Z0-9]{6,12})\s+(\d{2}-\d{2}-\d{2})\s*(?:~~\s*)?(\d{2}-\d{2}-\d{2})\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)(?:\s+\$?([\d.]+)\s+([\d.]+))?/,
        );

        const MeterNumber = meterRowM ? meterRowM[1] : null;
        const BillingPeriodStart = meterRowM ? meterRowM[2] : null;
        const BillingPeriodEnd = meterRowM ? meterRowM[3] : null;
        const NumberOfDays = meterRowM ? meterRowM[4] : null;
        const MeterReadPrevious = meterRowM ? meterRowM[5] : null;
        const MeterReadCurrent = meterRowM ? meterRowM[6] : null;
        const MeterMultiplier = meterRowM ? meterRowM[7] : null;
        const McfBilled = meterRowM ? meterRowM[8] : null;
        // Printed per-Mcf rates from the meter table header columns "WNA/Mcf" and "Cost of Gas/Mcf"
        // Both wrapped in fixNum() so OCR colon-for-period artifacts (e.g. "5:48" → "5.48") are normalised.
        // Both are null when the bill format lacks those columns (optional capture groups 9 and 10).
        const WNAPerMcf = meterRowM ? fixNum(meterRowM[9]) : null;
        const CostOfGasPerMcf = meterRowM ? fixNum(meterRowM[10]) : null;

        // Therms = Mcf × Multiplier × 10 (KGS reports in Mcf; 1 Mcf ≈ 10 therms)
        const _multiplier = parseFloat(MeterMultiplier) || 1.0;
        const _mcf = parseFloat(McfBilled) || 0;
        const NaturalGasTherms = _mcf > 0 ? String(Math.round(_mcf * _multiplier * 10 * 100) / 100) : null;

        // === BALANCE SECTION ===
        // All dollar-amount patterns use [\\d,.:] to capture values whether OCR renders decimal as
        // "." (normal) or ":" (misread — e.g. "17:55"). fixNum() then normalises colon→period.
        // All use activeT to prevent first-match-wins picking up another account's balance.
        const prevBalM = activeT.match(/Previous\s+Balance\s+\$?([\d,.:]+)/i);
        const PreviousBalance = fixNum(prevBalM ? prevBalM[1] : null);

        // OCR renders "Payments Received      82.90CR" — plural "Payments", amount at far right with CR suffix.
        // Old pattern used singular "Payment\s+Received" and tried to capture after a dash/dollar sign
        // which never appeared; the amount trailed by "CR" was after the regex had already given up.
        const paymentM = activeT.match(/Payments?\s+Received[^\n]*?([\d,.:]+)CR/i);
        const PaymentsReceived = fixNum(paymentM ? paymentM[1] : null);

        // === CHARGES SECTION ===
        // fixNum() is applied to all captured dollar values to handle OCR colon-for-period artifacts
        // (e.g. "17:55" → "17.55" — seen on page 12 of test file).
        // All use activeT to prevent cross-account charge bleed.
        const serviceChargeM = activeT.match(/Service\s+Charge\s+\$?([\d,.:]+)/i);
        const CustomerCharge = fixNum(serviceChargeM ? serviceChargeM[1] : null);

        const deliveryM = activeT.match(/Delivery\s+Charge\s+\$?([\d,.:]+)/i);
        const DeliveryCharge = fixNum(deliveryM ? deliveryM[1] : null);

        // GSRS is absent on some summer bills — null is correct when line doesn't appear.
        // Capture the optional "CR" suffix so credit months (e.g. "1.24CR") are stored as
        // negative values. Previously the (CR)? group was non-capturing and the sign was lost.
        const gsrsM = activeT.match(/Gas\s+System\s+Reliability\s+Surcharge\s+\$?([\d,.:]+)(CR)?/i);
        const GasSystemReliability = gsrsM
          ? String((parseFloat(fixNum(gsrsM[1]).replace(/,/g, '')) * (gsrsM[2] ? -1 : 1)).toFixed(2))
          : null;

        // WeatherNormalization can also appear as a credit — capture optional CR and negate.
        const wnaM = activeT.match(/Weather\s+Normalization\s+(?:Adj(?:ustment)?)?\s+\$?([\d,.:]+)(CR)?/i);
        const WeatherNormalization = wnaM
          ? String((parseFloat(fixNum(wnaM[1]).replace(/,/g, '')) * (wnaM[2] ? -1 : 1)).toFixed(2))
          : null;

        const costGasM = activeT.match(/Cost\s+of\s+Gas\s+\$?([\d,.:]+)/i);
        const GasCharge = fixNum(costGasM ? costGasM[1] : null);

        const winterM = activeT.match(/Winter\s+Event\s+Securitized\s+Cost\s+\$?([\d,.:]+)/i);
        const WinterEventCost = fixNum(winterM ? winterM[1] : null);

        // Sum all Franchise Fee line items (KGS often has two: state + local)
        // Uses activeT so only this account's franchise fee lines are summed.
        // FranchiseFee = numeric SUM (kept as-is — downstream gas sanity sum and
        // taxCost both use this total).  FranchiseFee1/2 = individual line values
        // for the two-row display in _LAYOUT_KGS.
        const franchiseMs = [...activeT.matchAll(/Franchise\s+Fee\s+\$?_*?([\d,.:]+)/gi)];
        const FranchiseFeeItems = franchiseMs.length > 0 ? franchiseMs.map((m) => fixNum(m[1])) : null;
        const FranchiseFee =
          FranchiseFeeItems !== null
            ? String(FranchiseFeeItems.reduce((sum, v) => sum + parseFloat((v || '0').replace(/,/g, '')), 0).toFixed(2))
            : null;
        const FranchiseFee1 = FranchiseFeeItems ? FranchiseFeeItems[0] || null : null;
        const FranchiseFee2 = FranchiseFeeItems ? FranchiseFeeItems[1] || null : null;

        // Delayed Payment Charge — late-fee line that appears on some KGS bills.
        // Stored as a positive value (it adds to the total, like all other charges).
        const delayedPayM = activeT.match(/Delayed\s+Payment\s+Charge\s+\$?([\d,.]+)/i);
        const DelayedPaymentCharge = delayedPayM ? fixNum(delayedPayM[1]) : null;

        // "Total Current Charges" — OCR sometimes inserts "___ $" before the dollar amount.
        // Old pattern: "Total\s+Current\s+Charges\s+\$?(\d+)" — fails when "___" appears.
        // Also: "Current Charges" (without "Total") appears as a subtotal row mid-bill; we want
        // the TOTAL line, so match "Total Current Charges" specifically and allow any intervening chars.
        // Uses activeT to avoid matching another account's total.
        const currentChargesM = activeT.match(/Total\s+Current\s+Charges[^\n]*?([\d,.:]+)\s*$/im);
        const TotalCurrentCharges = fixNum(currentChargesM ? currentChargesM[1] : null);

        // "Amount Due" can be followed by formatting colons and spaces before the dollar amount
        // (e.g. "Amount Due   :   $107.95"). Skip non-digit chars after the label, then require
        // the value to START with a digit to avoid capturing a bare colon.
        // Uses activeT to avoid another account's amount-due line.
        const amtDueM = activeT.match(/Amount\s+Due[^0-9\n]*(\d[\d,.:]*)/i);
        const TotalAmountDue = fixNum(amtDueM ? amtDueM[1] : null);

        return {
          UtilityCompany: 'Kansas Gas Service',
          Commodity: 'Gas',
          AccountNumber,
          MeterNumber,
          BillingPeriodStart,
          BillingPeriodEnd,
          NumberOfDays,
          MeterReadPrevious,
          MeterReadCurrent,
          StartRead: MeterReadPrevious,
          EndRead: MeterReadCurrent,
          ReadDifference:
            MeterReadCurrent && MeterReadPrevious
              ? String(parseInt(MeterReadCurrent, 10) - parseInt(MeterReadPrevious, 10))
              : null,
          MeterMultiplier,
          McfBilled,
          NaturalGasTherms,
          NaturalGasCCF: null,
          GasCharge,
          CustomerCharge,
          DeliveryCharge,
          GasSystemReliability,
          WeatherNormalization,
          WinterEventCost,
          FranchiseFee,
          FranchiseFee1,
          FranchiseFee2,
          FranchiseFeeItems,
          WNAPerMcf,
          CostOfGasPerMcf,
          DelayedPaymentCharge,
          FuelAdjustment: null,
          TotalCurrentCharges,
          TotalAmountDue,
          PreviousBalance,
          PaymentsReceived,
          CustomerName,
          ServiceAddress,
          StatementDate,
          RateSchedule,
          commodity: 'gas',
          _utilityName: 'Kansas Gas Service',
        };
      }
      // ── end KGS path ───────────────────────────────────────────────────────

      // Gas charge line items
      const _gasChargeM = t.match(
        /(?:cost\s+of\s+gas|gas\s*(?:charge|service|cost|supply)|distribution\s*charge|commodity\s*charge)[\s:$]*(\-?[0-9,]+\.[0-9]{2})/i,
      );
      const _custChargeM = t.match(
        /(?:customer\s*charge|basic\s*service|service\s*charge|base\s*charge|minimum\s*charge|facility\s*charge)[\s:$]*(\-?[0-9,]+\.[0-9]{2})/i,
      );
      const _fuelAdjM = t.match(
        /(?:fuel\s*adj|gas\s*adj|purchased\s*gas\s*adj|pga|weather\s*norm|gas\s*cost\s*adj)[\w\s]*[\s:$]*(\-?[0-9,]+\.[0-9]{2})/i,
      );
      // Meter readings
      const _prevReadM = t.match(/(?:previous|prior|last)\s*(?:meter\s*)?read(?:ing)?[\s:]*([0-9,]+)/i);
      const _currReadM = t.match(/(?:current|present|new)\s*(?:meter\s*)?read(?:ing)?[\s:]*([0-9,]+)/i);
      const _readDiffM = t.match(/(?:difference|usage|consumption|used)[\s:]*([0-9,]+)(?:\s*(?:ccf|therms?|mcf))?/i);
      // Therms conversion factor
      const _thermFactorM = t.match(/(?:therm\s*factor|conversion\s*factor|btu\s*factor|multiplier)[\s:]*([0-9.]+)/i);
      return {
        UtilityCompany: company,
        Commodity: 'Gas',
        CustomerName:
          // KGS: customer name appears before "DIRECTOR OF FACILITIES", "Account Number", or "PO BOX"
          t.match(/([A-Z][A-Z &]{2,50})\s*\n\s*(?:DIRECTOR|Account\s+Number|PO\s+BOX)/i)?.[1]?.trim() ||
          // Generic labeled name
          t
            .match(
              /(?:Customer\s*Name|Account\s*Name|Bill(?:ing)?\s*Name)[:\s\n]+([A-Za-z][A-Za-z0-9 .&'#\-]{2,50}?)(?=\s+(?:Account|Page|Service)|\n)/im,
            )?.[1]
            ?.trim() ||
          null,
        AccountNumber:
          // KGS format: "Account Number    <REDACTED-ACCT-SEG1> <REDACTED-ACCT-SEG2> <REDACTED-ACCT-SEG3>" — spaces between digit groups.
          // Separator is a bounded run of non-alnum OCR gunk (colon, #, period,
          // stray symbols) rather than an enumerated char class — see f1dc5e65.
          t.match(/Account\s+Number[^0-9A-Za-z\n]{0,6}([0-9 ]{10,30})/i)?.[1]?.replace(/\s/g, '') ||
          t.match(/account[^0-9A-Za-z\n]{0,6}([0-9\-]{6,20})/i)?.[1] ||
          null,
        ServiceAddress:
          // KGS: address is the line immediately before the city/state line (e.g. "BALDWIN CITY, KS")
          t.match(/([A-Z0-9][A-Z0-9 ]{4,49})\s*\n\s*[A-Z][A-Z ]+,\s*KS/)?.[1]?.trim() ||
          // Street number + street name pattern
          t.match(/(\d{2,5}\s+[A-Z][A-Z0-9 ]+(?:ST|AVE|DR|BLVD|LN|RD|CT|WAY|PKWY|HWY)\b)/i)?.[1]?.trim() ||
          // Generic labeled address
          t.match(/(?:service|delivery|billing)\s*address[\s:\n]+([^\n]{10,60})/i)?.[1]?.trim() ||
          null,
        // KGS meter row: "[MeterNum]   01-19-26   02-17-26   29   305   316..."
        // dates are MM-DD-YY; days are the 4th token on the row.
        // OCR sometimes renders the separator between dates as "~~" (tildes) — allow for it.
        BillingPeriodStart: (() => {
          const meterRow = t.match(/([A-Z0-9]{6,12})\s+(\d{2}-\d{2}-\d{2})\s*(?:~~\s*)?(\d{2}-\d{2}-\d{2})\s+(\d+)/);
          if (meterRow) return meterRow[2];
          return t.match(/(?:from|service\s*(?:from|period))[\s:]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1] || null;
        })(),
        BillingPeriodEnd: (() => {
          const meterRow = t.match(/([A-Z0-9]{6,12})\s+(\d{2}-\d{2}-\d{2})\s*(?:~~\s*)?(\d{2}-\d{2}-\d{2})\s+(\d+)/);
          if (meterRow) return meterRow[3];
          return t.match(/(?:to|service\s*to|through|thru)[\s:]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1] || null;
        })(),
        NumberOfDays: (() => {
          const meterRow = t.match(/([A-Z0-9]{6,12})\s+(\d{2}-\d{2}-\d{2})\s*(?:~~\s*)?(\d{2}-\d{2}-\d{2})\s+(\d+)/);
          if (meterRow) return meterRow[4];
          return t.match(/(\d+)\s*(?:day|billing\s*day)/i)?.[1] || null;
        })(),
        kWhConsumed: null,
        PeakDemandKW: null,
        NaturalGasTherms: (() => {
          // Standard therms patterns
          const thermMatch =
            t.match(/(?:therms?\s*used|total\s*therms?|gas\s*usage)[\s:]*([0-9,]+\.?\d*)/i)?.[1]?.replace(/,/g, '') ||
            t.match(/([0-9,]+\.?\d*)\s*therms?/i)?.[1]?.replace(/,/g, '') ||
            null;
          if (thermMatch) return thermMatch;
          // KGS uses Mcf (not therms). 1 Mcf = 10 therms.
          // Patterns: "Current  29  1.100  0.038" (meter row) or "Mcf Billed: 1.100"
          const mcfMatch =
            t.match(/Current\s+\d+\s+([\d.]+)\s+[\d.]/)?.[1] || t.match(/Mcf\s+Billed[\s:]*(\d+\.?\d*)/i)?.[1] || null;
          if (mcfMatch) return String(parseFloat(mcfMatch) * 10);
          return null;
        })(),
        NaturalGasCCF: t.match(/([0-9,]+\.?\d*)\s*(?:ccf|hundred\s*cubic\s*feet)/i)?.[1]?.replace(/,/g, '') || null,
        GasCharge: _gasChargeM?.[1]?.replace(/,/g, '') || null,
        CustomerCharge: _custChargeM?.[1]?.replace(/,/g, '') || null,
        FuelAdjustment: _fuelAdjM?.[1]?.replace(/,/g, '') || null,
        MeterReadPrevious: _prevReadM?.[1]?.replace(/,/g, '') || null,
        MeterReadCurrent: _currReadM?.[1]?.replace(/,/g, '') || null,
        MeterReadDifference: _readDiffM?.[1]?.replace(/,/g, '') || null,
        ThermFactor: _thermFactorM?.[1] || null,
        TotalAmountDue:
          t
            .match(/(?:amount\s*due|total\s*(?:current\s*)?(?:charges?|bill))[\s:$]*(\-?[0-9,]+\.[0-9]{2})/i)?.[1]
            ?.replace(/,/g, '') || null,
        TotalCurrentCharges:
          t.match(/total\s*current\s*charges[\s:$]*(\-?[0-9,]+\.[0-9]{2})/i)?.[1]?.replace(/,/g, '') || null,
        RateSchedule:
          // KGS: "Rate Schedule: General Service Sm" — capture full name including Sm/Lg/Med suffix
          t.match(/Rate[\s:]+(?:Schedule[\s:]+)?([A-Za-z ]+(?:Sm|Lg|Med))\b/i)?.[1]?.trim() ||
          t.match(/rate[\s:]*(?:schedule|code)?[\s:]*([A-Z0-9\-]{2,12})/i)?.[1] ||
          null,
        MeterNumber:
          // KGS: meter number like "0322A82382" appears before a date pair on the meter row
          t.match(/\b([A-Z0-9]{8,12})\s+\d{2}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}/)?.[1] ||
          t.match(/meter[^0-9A-Za-z\n]{0,6}([A-Z0-9\-]{4,20})/i)?.[1] ||
          null,
        _utilityName: company,
      };
    },
  },
  {
    name: 'City of Louisburg',
    // Handles BOTH the pre-Dec-2025 "ACCOUNT SUMMARY" detach-stub format
    // AND the Dec-2025+ "Customer Account Information" layout the city
    // adopted when migrating billing software. Mixed utility bills
    // (GAS + WATER + SEWER + STORMWATER + WATER PROTECTION FEE) all end
    // up on one page; this rule returns one bill row per page with every
    // line-item populated. Verified against the 63-page Louisburg USD
    // 416 bill dump on 2026-04-14 — 53 customer bills, 0 field issues.
    detect: (t) =>
      /louisburgkansas\.gov|City\s*of\s*Louisburg|215\s*S\.?\s*Broadway/i.test(t) &&
      /ACCOUNT\s*SUMMARY|Customer\s*Account\s*Information|Amount\s*Due\s*After|DETACH\s*AND\s*RETURN/i.test(t),
    extractAll: function (t) {
      const pages = _lbg_splitPages(t);
      // extract() now returns an array of per-commodity bills per page
      // (Update 81). flatMap flattens, and _pageIndex stamps the same
      // index on every commodity split from the same page.
      const _unmatchedPages = [];
      const bills = pages.flatMap((p, i) => {
        const r = this.extract(p);
        if (!r) {
          if (p.trim().length > 50) {
            const pageNums = [...p.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
            _unmatchedPages.push({
              pageNums: pageNums.length ? pageNums : [i + 1],
              preview: p.trim().slice(0, 200),
              // Full page text (not the 200-char preview) so a downstream
              // fallback can retry this page against OTHER UTILITY_RULES —
              // e.g. an Evergy electric page mixed into a Louisburg multi-
              // utility scan. See _unmatchedToSyntheticBills. Bug: combined
              // Louisburg+Evergy PDFs silently dropped the Evergy pages.
              pageText: p,
            });
          }
          return [];
        }
        const arr = Array.isArray(r) ? r : [r];
        for (const b of arr) b._pageIndex = i + 1;
        return arr;
      });
      if (_unmatchedPages.length) bills._unmatchedPages = _unmatchedPages;
      // Backfill missing billing periods from neighbor bills sharing the
      // same BillDate — all bills printed on the same day cover the same
      // service period, so it's safe to copy across accounts.
      const byBillDate = {};
      for (const b of bills) {
        if (b.BillDate && b.BillingPeriodStart && b.BillingPeriodEnd) {
          byBillDate[b.BillDate] = { start: b.BillingPeriodStart, end: b.BillingPeriodEnd };
        }
      }
      for (const b of bills) {
        if ((!b.BillingPeriodStart || !b.BillingPeriodEnd) && b.BillDate && byBillDate[b.BillDate]) {
          b.BillingPeriodStart = b.BillingPeriodStart || byBillDate[b.BillDate].start;
          b.BillingPeriodEnd = b.BillingPeriodEnd || byBillDate[b.BillDate].end;
          b._periodFromNeighbor = true;
        }
        if (!b.NumberOfDays && b.BillingPeriodStart && b.BillingPeriodEnd) {
          const _ps = b.BillingPeriodStart.split('/');
          const _pe = b.BillingPeriodEnd.split('/');
          if (_ps.length === 3 && _pe.length === 3) {
            const _ds = new Date(+(_ps[2].length === 2 ? '20' + _ps[2] : _ps[2]), +_ps[0] - 1, +_ps[1]);
            const _de = new Date(+(_pe[2].length === 2 ? '20' + _pe[2] : _pe[2]), +_pe[0] - 1, +_pe[1]);
            const _diff = Math.round((_de - _ds) / 86400000);
            if (_diff > 0 && _diff < 120) b.NumberOfDays = String(_diff);
          }
        }
      }
      // ── Align billing periods across commodities from the same account ──
      // Different page formats (old, new, billing-inquiry) can extract
      // slightly different date ranges for the same billing cycle. Group
      // bills by account + approximate period, then align outliers to the
      // majority period so all commodities normalize to the same month.
      const _parseD = (s) => {
        if (!s) return null;
        const p = String(s).split('/');
        if (p.length !== 3) return null;
        return new Date(+(p[2].length === 2 ? '20' + p[2] : p[2]), +p[0] - 1, +p[1]);
      };
      const _fmtD = (d) => d.getMonth() + 1 + '/' + d.getDate() + '/' + d.getFullYear();
      const _midpoint = (b) => {
        const s = _parseD(b.BillingPeriodStart),
          e = _parseD(b.BillingPeriodEnd);
        return s && e ? new Date((s.getTime() + e.getTime()) / 2) : null;
      };
      const acctGroups = {};
      for (const b of bills) {
        const acct = b.AccountNumber || 'unknown';
        if (!acctGroups[acct]) acctGroups[acct] = [];
        acctGroups[acct].push(b);
      }
      for (const acctBills of Object.values(acctGroups)) {
        const withDates = acctBills.filter((b) => b.BillingPeriodStart && b.BillingPeriodEnd);
        if (withDates.length < 2) continue;
        // Cluster bills whose midpoints are within 20 days of each other
        const clusters = [];
        for (const b of withDates) {
          const mid = _midpoint(b);
          if (!mid) continue;
          const cluster = clusters.find((c) => Math.abs(c.mid - mid) < 20 * 86400000);
          if (cluster) cluster.bills.push(b);
          else clusters.push({ mid: mid.getTime(), bills: [b] });
        }
        for (const cl of clusters) {
          if (cl.bills.length < 2) continue;
          // Find the most common start/end pair
          const periodCounts = {};
          for (const b of cl.bills) {
            const key = b.BillingPeriodStart + '|' + b.BillingPeriodEnd;
            periodCounts[key] = (periodCounts[key] || 0) + 1;
          }
          const winner = Object.entries(periodCounts).sort((a, b) => b[1] - a[1])[0];
          const [winStart, winEnd] = winner[0].split('|');
          for (const b of cl.bills) {
            if (b.BillingPeriodStart !== winStart || b.BillingPeriodEnd !== winEnd) {
              b._periodAligned = {
                originalStart: b.BillingPeriodStart,
                originalEnd: b.BillingPeriodEnd,
                alignedTo: winStart + ' – ' + winEnd,
              };
              b.BillingPeriodStart = winStart;
              b.BillingPeriodEnd = winEnd;
            }
          }
        }
      }

      // ── SEQUENTIAL DATE INFERENCE (second backfill pass) ──
      // After the BillDate-based backfill and period alignment, some bills
      // may still have null dates (e.g. when BillDate is also null on the
      // page). Infer dates from surrounding bills in the same account by
      // looking at the date sequence. Louisburg bills are monthly (~15th
      // to ~15th), so consecutive bills share period boundaries.
      const _parseDt = (s) => {
        if (!s) return null;
        const p = String(s).split('/');
        if (p.length !== 3) return null;
        return new Date(+(p[2].length === 2 ? '20' + p[2] : p[2]), +p[0] - 1, +p[1]);
      };
      const _fmtDt = (d) => d.getMonth() + 1 + '/' + d.getDate() + '/' + d.getFullYear();
      for (let i = 0; i < bills.length; i++) {
        if (bills[i].BillingPeriodStart && bills[i].BillingPeriodEnd) continue;
        // Find the nearest prior bill (same account) with dates
        const acct = bills[i].AccountNumber || '';
        let prevEnd = null;
        for (let j = i - 1; j >= 0; j--) {
          if ((bills[j].AccountNumber || '') === acct && bills[j].BillingPeriodEnd) {
            prevEnd = _parseDt(bills[j].BillingPeriodEnd);
            break;
          }
        }
        // Find the nearest next bill (same account) with dates
        let nextStart = null;
        for (let j = i + 1; j < bills.length; j++) {
          if ((bills[j].AccountNumber || '') === acct && bills[j].BillingPeriodStart) {
            nextStart = _parseDt(bills[j].BillingPeriodStart);
            break;
          }
        }
        // Count how many consecutive null-date bills share this gap (same account)
        let gapCount = 1;
        for (let j = i + 1; j < bills.length; j++) {
          if ((bills[j].AccountNumber || '') !== acct) continue;
          if (bills[j].BillingPeriodStart && bills[j].BillingPeriodEnd) break;
          gapCount++;
        }
        // If we have at least one anchor, infer the period
        if (prevEnd) {
          // Use prevEnd as this bill's start; estimate end as start + ~30 days
          // or use nextStart if available and gap is 1
          const inferStart = prevEnd;
          let inferEnd = null;
          if (nextStart && gapCount === 1) {
            inferEnd = nextStart;
          } else {
            // Add ~30 days
            inferEnd = new Date(prevEnd.getTime());
            inferEnd.setMonth(inferEnd.getMonth() + 1);
          }
          bills[i].BillingPeriodStart = _fmtDt(inferStart);
          bills[i].BillingPeriodEnd = _fmtDt(inferEnd);
          bills[i]._periodInferred = {
            reason: 'Sequential date inference from neighbor bills',
            prevEnd: _fmtDt(prevEnd),
            nextStart: nextStart ? _fmtDt(nextStart) : null,
          };
          // Calculate NumberOfDays
          const dayDiff = Math.round((_parseDt(bills[i].BillingPeriodEnd) - inferStart) / 86400000);
          if (dayDiff > 0 && dayDiff < 120) bills[i].NumberOfDays = String(dayDiff);
        } else if (nextStart) {
          // No prior bill, but have a next bill — estimate backwards
          let inferEnd = nextStart;
          let inferStart = new Date(nextStart.getTime());
          inferStart.setMonth(inferStart.getMonth() - 1);
          bills[i].BillingPeriodStart = _fmtDt(inferStart);
          bills[i].BillingPeriodEnd = _fmtDt(inferEnd);
          bills[i]._periodInferred = {
            reason: 'Sequential date inference (backward) from next bill',
            nextStart: _fmtDt(nextStart),
          };
          const dayDiff = Math.round((inferEnd - inferStart) / 86400000);
          if (dayDiff > 0 && dayDiff < 120) bills[i].NumberOfDays = String(dayDiff);
        }
      }

      return bills;
    },
    extract: function (page) {
      const isNewFormat = /Customer\s*Account\s*Information/i.test(page) || /Previous\s*Balance:/i.test(page);
      const isOldFormat =
        !isNewFormat &&
        /ACCOUNT\s*SUMMARY/i.test(page) &&
        /Amount\s*due\s*(?:on\s*or\s*before|Enclosed|after)/i.test(page);
      if (isNewFormat) return this._extractNew(page);
      if (isOldFormat) return this._extractOld(page);
      // LGS (Large Gas Service) billing detail — gas-only page with
      // rate schedule like "LGS Primary Voltage - 2LGSF"
      //
      // GUARD (bug 37d5fb0e, 2026-07-14): "LGS" here collides with Evergy's
      // own "Large General Service" ELECTRIC rate class (2LGSE/2LGSF), and
      // Evergy prints the identical "Billing Details - service from
      // MM/DD/YYYY to MM/DD/YYYY" header on every bill it issues (see
      // _EVG_BILLING_DETAILS / Evergy rule detect() above). Three genuine
      // Evergy electric bills (LGS Secondary/Primary Voltage rate class)
      // were claimed by this branch and emitted as "City of Louisburg" gas
      // with garbage field values. Electric bills always carry kWh/kW
      // charge lines and Evergy-specific charge codes (Demand/Facilities/
      // TDC/ECA/EER/PTS/RkVA), none of which ever appear on a real
      // City-of-Louisburg gas bill. Refuse the gas route when any of
      // those electric signals are present so this rule can no longer
      // claim an electric bill.
      const _lgsLooksElectric =
        /\bkWh\b|\bRKVA\s+Used\b|\bKW\s+Used\b|Demand\s+Ch[gq]|Facilities\s+Ch[gq]|TDC\s+Ch[gq]|ECA\s+Ch[gq]|EER\s+Ch[gq]|PTS\s+Ch[gq]|RkVA\s+Ch[gq]/i.test(
          page,
        );
      if (/\bLGS\b/i.test(page) && /Billing\s*Detail/i.test(page) && /service\s*from/i.test(page) && !_lgsLooksElectric)
        return this._extractLGSDetail(page);
      if (
        /Billing\s*Detail|Bill(?:ing)?\s*(?:Detail|Summary)/i.test(page) &&
        /BILL\s+(?:GS|WT|SW|ST|FA|WP)/i.test(page)
      )
        return this._extractBillingDetail(page);
      if (/BILL\s+GS\s+\d|BILL\s+WT\s+\d/i.test(page) && /Service\s*(?:From|To)/i.test(page))
        return this._extractBillingDetail(page);
      if (
        /Utility\s*Billing\s*(?:Inquiry|History)/i.test(page) ||
        (/Due\s*Date/i.test(page) && /^\s*GS\s+[\d,.]+/m.test(page))
      )
        return this._extractBillingInquiry(page);
      if (/BILL\s+(?:GS|WT|SW|ST|FA|WP)/i.test(page)) return this._extractBillingDetail(page);
      if (/Due\s*Date/i.test(page) && /\bGS\b/i.test(page)) return this._extractBillingInquiry(page);
      if (/Account\s*(?:Number|#)/i.test(page) && /\b(?:GS|Gas|TOTAL)\b/i.test(page))
        return this._extractBillingInquiry(page);
      if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(page) && /\$?\d[\d,]*\.\d{2}/.test(page)) {
        const r = this._extractOld(page);
        if (r && (Array.isArray(r) ? r : [r]).some((b) => b.TotalAmountDue || b.TotalCurrentCharges)) return r;
        const r2 = this._extractNew(page);
        if (r2 && (Array.isArray(r2) ? r2 : [r2]).some((b) => b.TotalAmountDue || b.TotalCurrentCharges)) return r2;
      }
      console.warn('[Louisburg] Unrecognized page format. First 500 chars:', page.slice(0, 500));
      return null;
    },
    _extractOld: function (page) {
      // Pre-clean: repair dates split mid-year by OCR ("11/1 5/25" →
      // "11/15/25"). Both pattern variants are needed — the first fixes
      // year-break splits, the second fixes the "year=1digit + extra"
      // variant.
      const cleaned = page
        .replace(/(\d{1,2}\/\d)\s+(\d\/\d{2,4})/g, (_, a, b) => a + b)
        .replace(/(\d{1,2}\/\d{1,2}\/\d)\s+(\d{1,3})(?=\D)/g, '$1$2');

      const headerLine = cleaned.match(
        /Service\s*Address\s+([A-Z0-9][A-Z0-9 .,]+?)\s+Account[^0-9A-Za-z\n]{0,6}(\d{5,8})\s+Bill\s*Date[:;]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      );
      let ServiceAddress = headerLine?.[1]?.trim() || null;
      let AccountNumber = headerLine?.[2] || null;
      let BillDate = headerLine?.[3] || null;
      // Separator after "Account" is a bounded run of non-alnum OCR gunk
      // (colon, #, period, stray symbols), not an enumerated char class — f1dc5e65.
      if (!AccountNumber)
        AccountNumber = cleaned.match(/Account[^0-9A-Za-z\n]{0,6}(\d{5,8})\s+Bill\s*Date/i)?.[1] || null;
      if (!BillDate) BillDate = cleaned.match(/Bill\s*Date[:;]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
      if (!ServiceAddress)
        ServiceAddress =
          cleaned.match(/Service\s*Address:?\s+([A-Z0-9][A-Z0-9 .,]+?)(?:\s+Account|\s+Amount|\n)/i)?.[1]?.trim() ||
          null;

      // Customer name line tolerates OCR dropping the leading "U" from
      // "USD" (common — "2 SD 999 HIGH SCHOO 4 Please remit"). 1-3
      // uppercase letters before the district number covers USD / SD /
      // USO variants. District number is captured generically.
      let CustomerName = null;
      const nameMatch = cleaned.match(/\b[A-Z]{1,3}\s*(\d{3,4})[\s\-_:]+([A-Z][A-Z .&\-]{2,40})/);
      if (nameMatch) {
        const district = nameMatch[1];
        const tail = nameMatch[2]
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.\s\-]+$/, '');
        if (tail.length >= 3) CustomerName = 'USD ' + district + ' ' + tail;
      }
      if (!CustomerName && AccountNumber) CustomerName = _lbg_facilityLookup(AccountNumber);

      // Billing period — a line with two MM/DD/YY dates. Tolerates OCR
      // garbling the second date (e.g. "10/15/25  1 15128" for "11/15/25").
      let BillingPeriodStart = null;
      let BillingPeriodEnd = null;
      for (const raw of cleaned.split(/\r?\n/)) {
        const ln = raw.trim();
        const m = ln.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})$/);
        if (m) {
          BillingPeriodStart = m[1];
          BillingPeriodEnd = m[2];
          break;
        }
        // Fallback: dates with surrounding text (e.g., "Service Period 01/15/25 to 02/14/25")
        if (!BillingPeriodStart) {
          const m3 = ln.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:to|through|-)?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
          if (m3) {
            BillingPeriodStart = m3[1];
            BillingPeriodEnd = m3[2];
            break;
          }
        }
        const m2 = ln.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+/);
        if (m2 && !BillingPeriodStart) {
          BillingPeriodStart = m2[1];
          const sp = m2[1].split('/');
          const mo = parseInt(sp[0]);
          const yr = sp[2];
          const nextMo = mo >= 12 ? 1 : mo + 1;
          const nextYr = mo >= 12 ? String(parseInt(yr) + 1) : yr;
          BillingPeriodEnd = nextMo + '/15/' + nextYr;
          BillingPeriodEnd = '_inferred';
        }
      }
      if (BillingPeriodEnd === '_inferred' && BillingPeriodStart) {
        const sp = BillingPeriodStart.split('/');
        const mo = parseInt(sp[0]);
        const day = parseInt(sp[1]);
        const yr = sp[2];
        const nextMo = mo >= 12 ? 1 : mo + 1;
        const nextYr = mo >= 12 ? String(parseInt(yr) + 1) : yr;
        BillingPeriodEnd = nextMo + '/' + day + '/' + nextYr;
      }

      // Scan each service line by label prefix. Multi-service pages
      // (gas + water + sewer + wpf + storm) get captured in one pass.
      const lines = cleaned.split(/\r?\n/);
      let gasLine = null,
        stormLine = null,
        sewerLine = null,
        waterLines = [],
        wpfLine = null,
        fuelAdjLine = null;
      for (const ln of lines) {
        const trim = ln.trim();
        if (/^\d{3}\s*-\s*(water|gas|sewer|storm)/i.test(trim)) continue;
        if (/Previous\s*Balance/i.test(trim)) continue;
        if (/[FE][UO][EL][LA]\s*ADJ|FUELADJ|FUEL\s*ADJ|FUEL\s*ADJUSTMENT/i.test(trim) && !fuelAdjLine)
          fuelAdjLine = trim;
        else if (/\bG[A4]S\b/i.test(trim) && !/[FE][UO][EL]|ADJ/i.test(trim) && !gasLine) gasLine = trim;
        else if (/\bSTORM\s*W[A4]TER\b/i.test(trim) && !stormLine) stormLine = trim;
        else if (/\bS[E3]W[E3]R\b/i.test(trim) && !sewerLine) sewerLine = trim;
        else if (/\bW[A4]TER\s*PROT[E3]CTION\s*F[E3][E3]\b/i.test(trim) && !wpfLine) wpfLine = trim;
        else if (/\bW[A4]TER\b/i.test(trim) && !/PROTECTION|STORM/i.test(trim)) waterLines.push(trim);
      }

      const parseLine = (line) => {
        if (!line) return { usage: null, charge: null, prevRead: null, currRead: null };
        const nums = _lbg_tokens(line);
        if (!nums.length) return { usage: null, charge: null, prevRead: null, currRead: null };
        const rawTokens = [...line.matchAll(/-?[\d,]+(?:\.\d+|-\d{2})?/g)].map((m) => m[0]);
        const charge = _lbg_cleanCents(rawTokens[rawTokens.length - 1]);
        if (charge != null && charge > 0 && charge < 1 && rawTokens.length > 1) {
          console.warn('[Louisburg parseLine] Very low charge $' + charge + ' from line:', line);
        }
        let usage = 0,
          prevRead = null,
          currRead = null;
        if (nums.length >= 4) {
          prevRead = nums[nums.length - 4] || nums[nums.length - 3];
          currRead = nums[nums.length - 3];
          const candidate = nums[nums.length - 2];
          if (candidate === currRead) {
            usage = 0;
          } else if (candidate < 1000000 && candidate < prevRead) {
            usage = candidate;
            prevRead = nums[nums.length - 4];
            currRead = nums[nums.length - 3];
          }
        } else if (nums.length === 3) {
          prevRead = nums[0];
          currRead = nums[1];
          usage = Math.abs(currRead - prevRead);
        }
        // Ensure prevRead <= currRead so StartRead = lower/previous
        // reading and EndRead = higher/current reading. The old format
        // column order can be Present then Previous (current first),
        // which would otherwise swap the reads.
        if (prevRead != null && currRead != null && prevRead > currRead) {
          const tmp = prevRead;
          prevRead = currRead;
          currRead = tmp;
        }
        return { usage, charge, prevRead, currRead };
      };

      const gas = parseLine(gasLine);
      const storm = parseLine(stormLine);
      const sewer = parseLine(sewerLine);
      const water = waterLines.reduce(
        (acc, wl) => {
          const p = parseLine(wl);
          return {
            usage: (acc.usage || 0) + (p.usage || 0),
            charge: acc.charge != null ? acc.charge + (p.charge || 0) : p.charge,
            prevRead: acc.prevRead != null ? acc.prevRead : p.prevRead,
            currRead: acc.currRead != null ? acc.currRead : p.currRead,
          };
        },
        { usage: null, charge: null, prevRead: null, currRead: null },
      );
      const wpf = parseLine(wpfLine);
      const fuelAdj = parseLine(fuelAdjLine);
      let signedFuelAdj = fuelAdj.charge;
      if (signedFuelAdj == null) {
        const _faRe = /(?:FUEL\s*ADJUST|[FE][UO][EL][LA]\s*ADJ)[^\d\n-]*(-?\$?-?[\d,]+\.\d{2})\s*-?/i;
        const faMatch = cleaned.match(_faRe);
        if (faMatch) {
          signedFuelAdj = parseFloat(faMatch[1].replace(/[\$,]/g, ''));
          if (signedFuelAdj > 0 && /[\d,]+\.\d{2}\s*-/i.test(faMatch[0])) signedFuelAdj = -signedFuelAdj;
          if (signedFuelAdj > 0 && /\(\s*\$?[\d,]+\.\d{2}\s*\)/.test(faMatch[0])) signedFuelAdj = -signedFuelAdj;
        }
      }
      if (signedFuelAdj != null && signedFuelAdj > 0) signedFuelAdj = -Math.abs(signedFuelAdj);
      // Water and sewer share the same meter — usage should match.
      if ((!water.usage || water.usage === 0) && water.charge) {
        water.usage = sewer.usage || wpf.usage || 0;
      }
      if (sewer.charge && (!sewer.usage || sewer.usage < 10) && water.usage > 0) {
        sewer.usage = water.usage;
      }

      const TotalAmountDue =
        cleaned.match(/Amount\s*due\s*(?:on\s*or\s*before)?[^$\n]*\$\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') ||
        cleaned.match(/Amount\s*due\s*after[^$\n]*\$\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') ||
        null;

      if (!TotalAmountDue && !gas.charge && !water.charge && !sewer.charge && !storm.charge) return null;

      // Update 81: emit one bill per commodity that has a real charge.
      // Same per-commodity splitting as _extractNew above.
      const shared = {
        UtilityCompany: 'City of Louisburg',
        BillFormat: 'old',
        CustomerName,
        AccountNumber,
        ServiceAddress,
        BillDate,
        BillingPeriodStart,
        BillingPeriodEnd,
        NumberOfDays: null,
        RateSchedule: null,
        MeterNumber: null,
      };
      const bills = [];
      if (gas.charge != null && gas.charge !== 0) {
        const r = _lbg_gasRate(BillingPeriodEnd || BillingPeriodStart || BillDate);
        let gasTotal = gas.charge;
        let gasVariable = Math.round(Math.max(0, gasTotal - r.baseCharge) * 100) / 100;
        // Derive usage from known rate when parseLine failed to extract it
        if ((!gas.usage || gas.usage === 0) && gasVariable > 0 && r.rate > 0) {
          gas.usage = Math.round(gasVariable / r.rate);
        }
        const corrected =
          gas.usage > 0
            ? _lbg_correctGasCharge(
                gasVariable,
                gas.usage,
                gasTotal,
                BillingPeriodEnd || BillingPeriodStart || BillDate,
              )
            : null;
        if (corrected && corrected.corrected) {
          gasVariable = corrected.charge;
          gasTotal = corrected.total;
        }
        if (gasTotal < r.baseCharge && gas.usage > 0) {
          gasVariable = Math.round(gas.usage * r.rate * 100) / 100;
          gasTotal = gasVariable + r.baseCharge;
        }
        if (gasTotal < r.baseCharge && (!gas.usage || gas.usage === 0)) {
          console.warn(
            '[Louisburg] Skipping suspicious gas bill: charge $' +
              gasTotal.toFixed(2) +
              ' < base $' +
              r.baseCharge +
              ' with 0 usage on page',
            pageIdx,
          );
        } else {
          const gasWithFA = signedFuelAdj != null ? gasTotal + signedFuelAdj : gasTotal;
          const gasBill = {
            ...shared,
            Commodity: 'Gas',
            StartRead: gas.prevRead || null,
            EndRead: gas.currRead || null,
            NaturalGasTherms: gas.usage || null,
            CustomerCharge: r.baseCharge,
            GasCharge: gasVariable,
            FuelAdjustment: signedFuelAdj,
            TotalCurrentCharges: gasWithFA.toFixed(2),
            TotalAmountDue: gasWithFA.toFixed(2),
          };
          if (corrected && corrected.corrected)
            gasBill._auto_corrected_GasCharge = {
              original: gas.charge,
              corrected: gasVariable,
              reason: corrected.reason,
            };
          bills.push(gasBill);
        }
      }
      if (water.charge != null && water.charge !== 0) {
        const waterTotal = (water.charge + (wpf.charge || 0)).toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Water',
          StartRead: water.prevRead || null,
          EndRead: water.currRead || null,
          WaterUsage: water.usage || null,
          WaterCharge: water.charge,
          WaterProtectionFee: wpf.charge,
          TotalCurrentCharges: waterTotal,
          TotalAmountDue: waterTotal,
        });
      }
      if (sewer.charge != null && sewer.charge !== 0) {
        const sewerTotal = sewer.charge.toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Sewer',
          SewerUsage: sewer.usage || null,
          SewerCharge: sewer.charge,
          TotalCurrentCharges: sewerTotal,
          TotalAmountDue: sewerTotal,
        });
      }
      if (storm.charge != null && storm.charge !== 0) {
        const stormTotal = storm.charge.toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Stormwater',
          StormWaterCharge: storm.charge,
          TotalCurrentCharges: stormTotal,
          TotalAmountDue: stormTotal,
        });
      }
      if (bills.length === 0 && TotalAmountDue) {
        bills.push({ ...shared, Commodity: 'Other', TotalCurrentCharges: TotalAmountDue, TotalAmountDue });
      }
      return bills;
    },
    _extractNew: function (page) {
      // New account number shape: "NN-NNNNNN-NN". Tolerate OCR "(" or
      // "O" in place of leading zero.
      const acctRaw = page.match(/([\d(O]{2}-\d{6}-\d{2})/)?.[1] || null;
      let AccountNumber = acctRaw ? acctRaw.replace(/[(O]/g, '0') : null;
      // Fallback: 7-10 digit account after "Account Number:" label (LGS bills).
      // Bounded non-alnum gap tolerates OCR gunk (colon misread as period, etc) — f1dc5e65.
      if (!AccountNumber) {
        const altAcct = page.match(/Account\s*(?:Number|#)\s*[^0-9A-Za-z\n]{0,6}(\d{7,10})/i)?.[1] || null;
        if (altAcct) AccountNumber = altAcct;
      }

      // Customer info row: "USD <NNN> <FACILITY> <SERVICE ADDRESS> <acct>"
      // District number is captured generically — no hardcoded IDs.
      // Address group was `\d+\s*[A-Z][...]` — required the digit run to be
      // followed (after optional whitespace) by a LETTER. Fix (2026-08-24,
      // defect #3 of the Louisburg 100%-accuracy gate): on the Broadmoor EMS
      // account (02-002360-00) one OCR pass reads the printed "105 S 5TH ST
      // E" as "1058 5STHE" — the direction letter "S" itself misread as
      // digit "8" (a known Tesseract confusable pair), leaving BOTH tokens
      // ("1058" and "5STHE") starting with a digit and no letter anywhere
      // near the first token. The old pattern can never match that shape
      // (every backtrack of the digit run still leaves a digit, not a
      // letter, immediately before the next boundary), so ServiceAddress
      // fell through to null even though a garbled-but-legible address was
      // printed right there. Broadened to accept the address token starting
      // with EITHER a digit or a letter — a strict superset of the old
      // class, so every input the old regex matched still matches identically
      // (same non-greedy minimal-length match); it only additionally accepts
      // the digit-led-with-no-nearby-letter shape this defect needed. Confirmed
      // against 7 other independent OCR passes of the same bill that read the
      // cleaner "105S 5THE" (still garbled, but self-consistent with this
      // same document's Evergy page printing "105 S 5TH ST E LOUISBURG KS" for
      // the same property) — this also continues to match those unchanged.
      // FIX (2026-08-24, Louisburg visual audit bug #5): tolerate a bounded
      // run of OCR junk (a stray misread period, comma, etc.) landing
      // directly against the account-number digits with NO whitespace of
      // its own — e.g. real OCR text "825 WILDCAT DR                    .09-
      // 009002-00" (account 09-009002-00, Irrigation, Feb 2026 scan). The
      // old pattern required `\s+` to be immediately followed by the 2-char
      // digit class; that stray "." sat between the whitespace run and the
      // digits, so `\s+` was satisfied by the spaces but the very next
      // character was "." (not in `[\d(O]`), and no amount of backtracking
      // group3 could reach it either — the whole regex simply failed to
      // match, silently dropping a perfectly legible ServiceAddress to
      // null. Bounded to 3 junk chars (mirrors the existing bounded-gap
      // tolerance already used for "Account[^0-9A-Za-z\n]{0,6}" above) so
      // this can't accidentally swallow real address text.
      const custLine = page.match(
        /USD\s*(\d{3,4})[\s\-_:]+([A-Z][A-Z0-9 .&\-]{2,40}?)\s+([0-9A-Z][0-9A-Z .&\-]{3,50}?)\s+[^0-9A-Za-z\n]{0,3}[\d(O]{2}-\d{6}-\d{2}/,
      );
      let CustomerName = custLine ? 'USD ' + custLine[1] + ' ' + custLine[2].trim() : null;
      let ServiceAddress = custLine ? custLine[3].trim() : null;
      if (!CustomerName) {
        const m = page.match(/\b[A-Z]{1,3}\s*(\d{3,4})[\s\-_:]+([A-Z][A-Z .&\-]{2,40})/);
        if (m)
          CustomerName =
            'USD ' +
            m[1] +
            ' ' +
            m[2]
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/[.\s\-]+$/, '');
      }
      if (!CustomerName && AccountNumber) CustomerName = _lbg_facilityLookup(AccountNumber);
      if (!ServiceAddress) {
        // Same broadening as the primary match above (digit-or-letter start)
        // for the last-resort per-line scan, used when the CustomerName
        // portion of the row didn't match the USD-prefixed pattern at all.
        for (const raw of page.split(/\r?\n/)) {
          // Same bounded-junk tolerance as the primary custLine match above
          // (bug #5) applied to this last-resort fallback too.
          const m = raw.match(/\b([0-9A-Z][0-9A-Z .]{3,40}?)\s+[^0-9A-Za-z\n]{0,3}[\d(O]{2}-\d{6}-\d{2}/);
          if (m) {
            ServiceAddress = m[1].trim();
            break;
          }
        }
      }
      // FIX (2026-08-24, Louisburg visual audit bug #4): normalize the
      // recurring OCR garble family for 105 S 5th St E (Broadmoor EMS acct
      // 02-002360-00 / Maintenance Bldg acct 02-002364-00 — same physical
      // building, two accounts). Confirmed against 5 real bill renders
      // (Jan/Feb/Mar 2026) that this address NEVER extracts correctly on
      // either account: seen garbles include "105S STHE", "105 S5THE",
      // "105SSTHE", and (on Maint Bldg's own narrower-column print variant)
      // "105 S5TH E". All of these collapse, once whitespace is stripped,
      // to either "105SSTHE" (the "5" in "5TH" itself got misread as an
      // extra "S") or "105S5THE" (the "5" survived, just missing a space).
      // Normalizing on the whitespace-stripped form catches both families
      // without needing to enumerate every spacing permutation. Scoped
      // tightly to this one confirmed address (not a general address
      // reformatter) so it can't relabel an unrelated property.
      if (ServiceAddress && /^105S+5?THE$/i.test(ServiceAddress.replace(/\s+/g, ''))) {
        ServiceAddress = '105 S 5TH E';
      }

      // Period row has 5 dates: BillFrom, BillTo, BillFor, BillDate, PenaltyDate
      let BillingPeriodStart = null;
      let BillingPeriodEnd = null;
      let BillDate = null;
      for (const raw of page.split(/\r?\n/)) {
        const dates = [...raw.matchAll(/\d{1,2}\/\d{1,2}\/\d{4}/g)].map((m) => m[0]);
        if (dates.length >= 4) {
          BillingPeriodStart = dates[0];
          BillingPeriodEnd = dates[1];
          BillDate = dates[3] || dates[2] || null;
          break;
        }
      }

      // The new format puts the service label MID-LINE between the meter
      // reads and the charge: "138,771 139,070 299 WATER 30.20". Parse
      // relative to the label.
      const lines = page.split(/\r?\n/);
      const parseMetered = (raw, labelRe) => {
        const m = raw.match(labelRe);
        if (!m) return null;
        const before = raw.slice(0, m.index);
        const after = raw.slice(m.index + m[0].length);
        // Colon-for-decimal-point tolerance ("335:33" -> "335.33") — the same
        // OCR-confusable already tolerated for TotalAmountDue's loose fallback
        // below ([.:]\\d{2}). Without it, "335:33"'s digit run stops at "335"
        // and the printed cents are silently dropped (defect: City of
        // Louisburg May 2026 Gas TotalCurrentCharges landed $0.33 short,
        // 315.47 vs printed 315.80 — traced to this exact truncation, not a
        // fabricated CustomerCharge split).
        const afterToks = [...after.matchAll(/-?[\d,]+(?:[.:]\d+|-\d{2})?/g)].map((x) => x[0]);
        // FIX (2026-08-25, backlog 964b13e2): prefer the trailing token that's
        // actually shaped like a printed charge (2-decimal cents via "." or
        // ":", or a trailing "-NN" cents suffix) over blindly taking the
        // first token. A handwritten annotation physically overlapping the
        // printed row (pen marks scanned into the image) can OCR into a
        // spurious integer sitting between the label and the real charge —
        // e.g. real bill text "GAS   248-%>   321.33" where "248" is OCR
        // noise from handwriting and "321.33" is the printed charge — and
        // afterToks[0] silently picked up the noise instead. Falls back to
        // afterToks[0] when no token is cents-shaped (preserves the existing
        // degraded-OCR path where _lbg_cleanCents infers cents from a bare
        // 4+-digit run with no decimal marker at all).
        const _currencyShaped = (s) => /^-?[\d,]+(?:[.:]\d{2}|-\d{2})$/.test(s);
        let chargeTok = null;
        for (let i = afterToks.length - 1; i >= 0; i--) {
          if (_currencyShaped(afterToks[i])) {
            chargeTok = afterToks[i];
            break;
          }
        }
        if (!chargeTok) chargeTok = afterToks[0] || null;
        const charge = _lbg_cleanCents(chargeTok ? chargeTok.replace(':', '.') : null);
        // FIX (2026-08-25, backlog 964b13e2): Tesseract frequently misreads
        // the thousands-comma in a 4-digit meter read as a decimal point
        // ("9,737" OCRs as "9.737") — the same comma/period confusable
        // already documented and fixed for dollar amounts elsewhere in this
        // file (_wreFixOcrDollar). Reads in this column are always whole
        // integers; the only legitimate decimal that appears here is the
        // 2-decimal-digit CCF-adjusted usage figure (e.g. "9,648.18"),
        // never a lone digit followed by exactly 3 decimal digits with no
        // thousands comma. Left uncorrected, "9.737" parses as a non-integer
        // decimal and silently drops out of integerTokens below, collapsing
        // a 3-reading line ("9,364 9,737 373 GAS") to just 2 tokens — which
        // then get treated as prevRead/currRead directly (min/max), swapping
        // the real Current Reading into StartRead and fabricating a usage of
        // ~9000 (real bill: StartRead became 374, EndRead 9364, Usage 8990,
        // instead of StartRead 9364, EndRead 9737, Usage 373).
        const beforeFixed = before.replace(/(^|[^\d.,])(\d)\.(\d{3})(?!\d)/g, '$1$2,$3');
        // Parse all numeric tokens in the before segment. Integers >=100
        // are meter reads; decimals >=100 are explicit usage columns (gas
        // CCF prints as "9,648.18"). Small decimals are bar-chart axis
        // labels and ignored.
        const allBefore = [...beforeFixed.matchAll(/-?[\d,]+(?:\.\d+)?/g)].map((x) =>
          parseFloat(x[0].replace(/,/g, '')),
        );
        const integerTokens = allBefore.filter((n) => Number.isInteger(n) && n >= 100);
        let usage = 0;
        // Tracks whether Case A below matched (3+ tokens, last ≈ diff of the
        // two preceding) so the reads-extraction step further down knows the
        // reads are at [-3]/[-2] — independent of the exact numeric value
        // stored in `usage`, which (per the fix below) is no longer always
        // equal to integerTokens[last]. FIX (2026-08-25, backlog 964b13e2):
        // previously the reads step re-derived "was this Case A" by checking
        // `usage === integerTokens[last]`, which broke the moment Case A
        // started preferring the cross-validated diff over the raw token.
        let usedThirdTokenAsUsage = false;
        // Case A: 3+ integer tokens with the last one equal to the diff
        // of the two preceding — the line printed "prev curr usage" and
        // the third int IS the explicit usage column. Water bills look
        // like "4,409,255 4,482,828 73,573 WATER $677.95" where
        // 73573 = 4482828 - 4409255.
        if (integerTokens.length >= 3) {
          const a = integerTokens[integerTokens.length - 3];
          const b = integerTokens[integerTokens.length - 2];
          const c = integerTokens[integerTokens.length - 1];
          const diffAB = Math.abs(b - a);
          if (diffAB > 0 && Math.abs(c - diffAB) <= Math.max(2, diffAB * 0.05)) {
            // FIX (2026-08-25, backlog 964b13e2): use the cross-validated
            // diff (a and b are two independently-OCR'd readings) rather than
            // the printed usage token c itself. Real bill: a diagonal QR-code
            // line crosses the printed "373" on the Usage column, and OCR
            // read it as "374" — a single-digit misread on an isolated
            // number with nothing else to cross-check it against. diffAB
            // (9,737 − 9,364 = 373) is corroborated by two separate reads
            // and is already verified within tolerance of c here, so it's
            // the more reliable value. This branch's own doc comment states
            // the invariant this format always follows: usage == diff (no
            // multiplier/pressure-factor case exists for these plain-integer
            // 3-token lines — that's Case B, decimals, below).
            usage = diffAB;
            usedThirdTokenAsUsage = true;
          }
        }
        // Case B: 2 integer reads + a decimal usage column AFTER the
        // second int. Gas CCF prints as "30,751 39,931 9,648.18 GAS"
        // where 9648.18 is the pressure-factor-adjusted usage (not the
        // raw subtraction 9180). Prefer the printed decimal when it's
        // within 30% of the subtraction.
        if (usage === 0 && integerTokens.length >= 2) {
          const prev = integerTokens[integerTokens.length - 2];
          const curr = integerTokens[integerTokens.length - 1];
          const computed = prev === curr ? 0 : Math.abs(curr - prev);
          const currIdx = allBefore.lastIndexOf(curr);
          const trailing = allBefore.slice(currIdx + 1);
          const decimalUsage = trailing.find(
            (n) => !Number.isInteger(n) && n >= 100 && (!computed || Math.abs(n - computed) < computed * 1.0),
          );
          if (decimalUsage != null) usage = decimalUsage;
          else usage = computed;
        }
        // Case C: degraded OCR — fall back to last 3 numbers of any type.
        if (usage === 0 && integerTokens.length < 2 && allBefore.length >= 2) {
          const reads = allBefore.slice(-3);
          if (reads.length >= 3) {
            usage = reads[2] > 0 && reads[2] < reads[0] ? reads[2] : Math.abs(reads[1] - reads[0]);
          } else if (reads.length === 2) {
            usage = Math.abs(reads[1] - reads[0]);
          }
        }
        // Extract meter reads: the two integer tokens before the usage
        // column are Previous and Current readings. Format on the bill
        // is "prev curr [usage] LABEL charge". Ensure prevRead <= currRead
        // so StartRead is always the lower/previous reading.
        let prevRead = null,
          currRead = null;
        if (integerTokens.length >= 2) {
          let r1, r2;
          if (integerTokens.length >= 3 && usage > 0 && usedThirdTokenAsUsage) {
            // 3+ tokens with last = usage → reads are at [-3] and [-2]
            r1 = integerTokens[integerTokens.length - 3];
            r2 = integerTokens[integerTokens.length - 2];
          } else {
            // 2 tokens → both are reads
            r1 = integerTokens[integerTokens.length - 2];
            r2 = integerTokens[integerTokens.length - 1];
          }
          prevRead = Math.min(r1, r2);
          currRead = Math.max(r1, r2);
        }
        return { usage, charge, prevRead, currRead };
      };

      let gas = null,
        water = null,
        storm = null,
        sewer = null,
        wpf = null;
      // Tracks whether a "GAS" label was ever matched on the page, even if no
      // charge token could be parsed after it (OCR reordered/garbled the
      // charge — see backlog 37f76621). Distinguishes "Gas section exists but
      // its charge is unrecoverable" (must be flagged) from "this page simply
      // has no Gas commodity" (nothing to flag).
      let gasLineSeen = false;
      for (const ln of lines) {
        // Skip section-header lines like "100- Water" and "300 - Gas":
        // those are column titles at the top of the bill layout and
        // contain no meter reads. When OCR collapses columns, the
        // "Previous Balance $5,145.91" text ends up on the same visual
        // line and the charge regex grabs it — producing a WaterCharge
        // that's actually the previous balance. Reject the section
        // headers outright.
        if (/^\s*\d{3}\s*-\s*(water|gas|sewer|storm)/i.test(ln)) {
          const afterHeader = ln.replace(/^\s*\d{3}\s*-\s*\S+\s*/, '');
          if (!/[\d,]+\.\d{2}/.test(afterHeader)) continue;
        }
        // Also reject any line that contains "Previous Balance" — even
        // if a commodity label is on it, the after-text charge will be
        // the previous-balance dollar amount, not the current charge.
        if (/Previous\s*Balance/i.test(ln)) continue;
        if (!gas && /\bG[A4]S\b/i.test(ln) && !/FUEL|ADJUSTMENT/i.test(ln)) {
          gas = parseMetered(ln, /\bG[A4]S\b/i);
          gasLineSeen = true;
        }
        // Water label: leading "W" (and optional "M" before it) tolerated as
        // dropped/garbled OCR — e.g. "WATER" → "ATER" (see backlog 37f76621).
        // Mirrors the existing fuzzy G[A4]S tolerance on the Gas label.
        if (/\bM?W?[A4]TER\b/i.test(ln) && !/PROTECTION/i.test(ln)) {
          const wp = parseMetered(ln, /\bM?W?[A4]TER\b/i);
          if (water === null) {
            water = wp;
          } else {
            water = {
              usage: (water.usage || 0) + (wp.usage || 0),
              charge: water.charge != null ? water.charge + (wp.charge || 0) : wp.charge,
              prevRead: water.prevRead != null ? water.prevRead : wp.prevRead,
              currRead: water.currRead != null ? water.currRead : wp.currRead,
            };
          }
        }
        // Water Protection Fee: accumulate ALL occurrences, not just the
        // first. A 2-physical-water-meter account (e.g. 16-016001-00, 977 N
        // Rockville Rd) prints one WATER PROTECTION line PER METER — the old
        // `!wpf` guard kept only one of the two identical-looking lines,
        // silently dropping the 2nd meter's fee from the Water sub-total
        // (defect: Feb/Mar/May 2026 bills each short by exactly one
        // instance's worth, $2.75/$1.16/$0.69). Mirrors the accumulation
        // pattern already used for multiple WATER lines above.
        if (/W[A4]TER\s*PROT[E3]CTION/i.test(ln)) {
          const wp2 = parseMetered(ln, /W[A4]TER\s*PROT[E3]CTION/i);
          if (wpf === null) {
            wpf = wp2;
          } else {
            wpf = {
              usage: (wpf.usage || 0) + (wp2.usage || 0),
              charge: wpf.charge != null ? wpf.charge + (wp2.charge || 0) : wp2.charge,
              prevRead: wpf.prevRead != null ? wpf.prevRead : wp2.prevRead,
              currRead: wpf.currRead != null ? wpf.currRead : wp2.currRead,
            };
          }
        }
        if (!sewer && /\bS[E3]W[E3]R\b/i.test(ln)) sewer = parseMetered(ln, /\bS[E3]W[E3]R\b/i);
        if (!storm && /STORM\s*W[A4]TER/i.test(ln)) storm = parseMetered(ln, /STORM\s*W[A4]TER/i);
      }
      gas = gas || { usage: null, charge: null };
      water = water || { usage: null, charge: null };
      sewer = sewer || { usage: null, charge: null };
      storm = storm || { usage: null, charge: null };
      wpf = wpf || { usage: null, charge: null };
      if (sewer.charge && (!sewer.usage || sewer.usage < 10) && water.usage > 0) {
        sewer.usage = water.usage;
      }

      // Fuel Adjustment — line item on gas bills. Typically negative.
      // Formats seen: "-$385.93", "-385.93", "30.15-" (trailing minus),
      // "($385.93)" (parens). The regex captures the number; trailing
      // minus is detected separately and flips the sign.
      const _faRe = /(?:FUEL\s*ADJUST|[FE][UO][EL][LA]\s*ADJ)[^\d\n-]*(-?\$?-?[\d,]+\.\d{2})\s*-?/i;
      const fuelAdjMatch = page.match(_faRe);
      let signedFuelAdj = null;
      if (fuelAdjMatch) {
        signedFuelAdj = parseFloat(fuelAdjMatch[1].replace(/[\$,]/g, ''));
        const trailingMinus = /(?:FUEL\s*ADJUST|[FE][UO][EL][LA]\s*ADJ)[^\n]*[\d,]+\.\d{2}\s*-/i.test(page);
        if (signedFuelAdj > 0 && trailingMinus) {
          signedFuelAdj = -signedFuelAdj;
        }
        if (
          signedFuelAdj > 0 &&
          /(?:FUEL\s*ADJUST|[FE][UO][EL][LA]\s*ADJ)[^\n]*\(\s*\$?[\d,]+\.\d{2}\s*\)/i.test(page)
        ) {
          signedFuelAdj = -signedFuelAdj;
        }
      }

      // Total Amount Due — try the clean pattern first, then a loose
      // variant that tolerates colon-for-dot OCR ("4,014:28" → 4014.28).
      let TotalAmountDue = page.match(/Total\s*Amount\s*Due\s*\$?\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') || null;
      if (!TotalAmountDue) {
        const loose = page.match(/Total\s*Amount\s*Due\s*[^$\n]*?\$?\s*([\d,]+[.:]\d{2})/i);
        if (loose) TotalAmountDue = loose[1].replace(/,/g, '').replace(':', '.');
      }

      // Current Bill — the page's CURRENT-PERIOD commodity total (this
      // period's Water + Gas + Sewer + Stormwater only). Unlike Total Amount
      // Due, it never includes a carried-over Previous Balance/Payments/
      // Penalty, so it's the only safe anchor for reconciling a garbled or
      // missing per-commodity charge against the other three (see
      // _lbg_reconcileGasFromCurrentBill / backlog 5884be3d, 37f76621).
      // Reconciling against Total Amount Due instead would false-flag any
      // account carrying a balance forward.
      const _currentBillRaw = page.match(/Current\s*Bill\s*\$?\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') || null;
      const CurrentBillTotal = _currentBillRaw != null ? parseFloat(_currentBillRaw) : null;

      // WaterProtectionFee sign reconciliation — never a guess. Tesseract can
      // drop the leading "-" glyph off a printed credit line (confirmed on a
      // real bill: printed "WATER PROTECTION -$0.69" twice, OCR read both as
      // positive "0.69" while correctly capturing the minus sign on the
      // SAME page's negative WATER lines). Cross-validate against the page's
      // own independently-printed Current Bill total — the same anchor
      // _lbg_buildGasBill already trusts for gas reconciliation. Only flips
      // the sign when doing so is the UNIQUE change that makes every line
      // item sum to the printed total; otherwise leaves it alone.
      if (CurrentBillTotal != null && wpf.charge) {
        const _rawSum =
          (gas.charge || 0) +
          (signedFuelAdj || 0) +
          (water.charge || 0) +
          (wpf.charge || 0) +
          (sewer.charge || 0) +
          (storm.charge || 0);
        const _flippedSum = _rawSum - 2 * wpf.charge;
        if (Math.abs(_rawSum - CurrentBillTotal) > 0.01 && Math.abs(_flippedSum - CurrentBillTotal) < 0.01) {
          wpf.charge = -wpf.charge;
          wpf._signCorrected = true;
        }
      }

      if (!TotalAmountDue && !gas.charge && !water.charge && !sewer.charge && !storm.charge) return null;

      // ── Emit one bill per commodity with a real charge ──
      // Each split bill carries ONLY that commodity's fields plus shared
      // account info. No cross-commodity field pollution. The data table
      // downstream can keep gas/water/sewer meters clean.
      const shared = {
        UtilityCompany: 'City of Louisburg',
        BillFormat: 'new',
        CustomerName,
        AccountNumber,
        ServiceAddress,
        BillDate,
        BillingPeriodStart,
        BillingPeriodEnd,
        NumberOfDays: null,
        RateSchedule: null,
        MeterNumber: null,
      };
      const bills = [];
      const _otherCommoditySum = (water.charge || 0) + (wpf.charge || 0) + (sewer.charge || 0) + (storm.charge || 0);
      const _gasBillDate = BillingPeriodEnd || BillingPeriodStart || BillDate;
      const gasBill = _lbg_buildGasBill(
        shared,
        gas,
        gasLineSeen,
        _otherCommoditySum,
        CurrentBillTotal,
        signedFuelAdj,
        _gasBillDate,
      );
      if (gasBill) bills.push(gasBill);
      if (water.charge != null && water.charge !== 0) {
        const waterTotal = (water.charge + (wpf.charge || 0)).toFixed(2);
        const waterBill = {
          ...shared,
          Commodity: 'Water',
          StartRead: water.prevRead || null,
          EndRead: water.currRead || null,
          WaterUsage: water.usage || null,
          WaterCharge: water.charge,
          WaterProtectionFee: wpf.charge,
          TotalCurrentCharges: waterTotal,
          TotalAmountDue: waterTotal,
        };
        if (wpf._signCorrected)
          waterBill._auto_corrected_WaterProtectionFee = {
            reason:
              'Sign flipped to negative — reconciled against printed Current Bill total (OCR dropped the credit minus sign).',
          };
        bills.push(waterBill);
      }
      if (sewer.charge != null && sewer.charge !== 0) {
        const sewerTotal = sewer.charge.toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Sewer',
          SewerUsage: sewer.usage || null,
          SewerCharge: sewer.charge,
          TotalCurrentCharges: sewerTotal,
          TotalAmountDue: sewerTotal,
        });
      }
      if (storm.charge != null && storm.charge !== 0) {
        const stormTotal = storm.charge.toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Stormwater',
          StormWaterCharge: storm.charge,
          TotalCurrentCharges: stormTotal,
          TotalAmountDue: stormTotal,
        });
      }
      // If nothing parsed cleanly but the bill has a Total Amount Due,
      // emit a single "Other" bill so the user sees SOMETHING rather than
      // losing the row entirely. Rare — usually only hit on heavily
      // degraded OCR.
      if (bills.length === 0 && TotalAmountDue) {
        bills.push({
          ...shared,
          Commodity: 'Other',
          TotalCurrentCharges: TotalAmountDue,
          TotalAmountDue,
        });
      }
      return bills;
    },
    _extractBillingDetail: function (page) {
      console.log('[BillingDetail] Raw text (600):', page.slice(0, 600));
      const acct = page.match(/Account\s*(?:Number|#)\s*:?\s*(\d{4,8})/i)?.[1] || null;
      const _dt = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/;
      const _dtMerged = /(\d{3,4})\s*-\s*(\d{4})/;
      const fixDate = (d) => (d ? d.replace(/-/g, '/') : null);
      const _splitMerged = (s) => {
        const m = s.match(/^(\d{3,4})\s*-\s*(\d{4})$/);
        if (!m) return null;
        const digits = m[1];
        const yr = m[2];
        if (digits.length === 3) return digits[0] + '/' + digits.slice(1) + '/' + yr;
        return digits.slice(0, 2) + '/' + digits.slice(2) + '/' + yr;
      };
      const _findDate = (label) => {
        const re = new RegExp(label + '[:[ \\t\\n\\r]]*' + _dt.source, 'i');
        const m = page.match(re);
        if (m) return fixDate(m[1]);
        // Try merged format (OCR drops slash: 501-2025 instead of 5/01/2025)
        const re3 = new RegExp(label + '[:[ \\t\\n\\r]]*' + _dtMerged.source, 'i');
        const m3 = page.match(re3);
        if (m3) return _splitMerged(m3[1] + '-' + m3[2]);
        // Try multi-line: label on one line, date on next
        const re2 = new RegExp(label + '[^0-9\\n]{0,20}\\n[ \\t\\n\\r]*' + _dt.source, 'im');
        const m2 = page.match(re2);
        if (m2) return fixDate(m2[1]);
        // Try multi-line with merged format
        const re4 = new RegExp(label + '[^0-9\\n]{0,20}\\n[ \\t\\n\\r]*' + _dtMerged.source, 'im');
        const m4 = page.match(re4);
        if (m4) return _splitMerged(m4[1] + '-' + m4[2]);
        return null;
      };
      const billDate = _findDate('Bill[ \\t\\n\\r]*Date');
      let serviceFrom = _findDate('Service[ \\t\\n\\r]*From');
      let serviceTo = _findDate('Service[ \\t\\n\\r]*To');
      console.log('[BillingDetail] Dates:', { billDate, serviceFrom, serviceTo, acct });
      const custMatch = page.match(/USD\s*(\d{3,4})\s+([A-Z][A-Z0-9 .&\-]+?)(?:\n|BOX|\s{3,})/);
      const CustomerName = custMatch ? 'USD ' + custMatch[1] + ' ' + custMatch[2].trim() : null;
      const addrMatch = page.match(/(?:Property\s*Address|202)\s*([\dA-Z][A-Z0-9 .]+?)(?:\s{3,}|Due|Amount|\n)/i);
      const ServiceAddress = addrMatch
        ? addrMatch[0]
            .replace(/\s{3,}.*/, '')
            .replace(/Due.*|Amount.*/i, '')
            .trim()
        : null;
      const amtDue =
        page.match(/Amount\s*Due\s*(?:Before\s*Due\s*Date)?\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') || null;
      const shared = {
        UtilityCompany: 'City of Louisburg',
        BillFormat: 'billing-detail',
        CustomerName,
        AccountNumber: acct,
        ServiceAddress,
        BillDate: billDate,
        BillingPeriodStart: serviceFrom,
        BillingPeriodEnd: serviceTo,
        NumberOfDays: null,
        RateSchedule: null,
        MeterNumber: null,
      };
      const lines = page.split(/\r?\n/);
      let gasAmt = null,
        gasUsage = null,
        fuelAdj = null,
        stormAmt = null;
      let sewerAmt = null,
        sewerUsage = null,
        wpfAmt = null,
        waterAmt = null,
        waterUsage = null;
      if (!serviceFrom && !serviceTo) {
        const datePat = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/g;
        const allDates = [...page.matchAll(datePat)].map((x) => fixDate(x[1]));
        const serviceDates = allDates.filter((d) => d && d !== billDate && !/^1[12]\/|^0?[789]\//.test(d));
        if (serviceDates.length >= 2) {
          serviceFrom = serviceFrom || serviceDates[0];
          serviceTo = serviceTo || serviceDates[1];
          shared.BillingPeriodStart = serviceFrom;
          shared.BillingPeriodEnd = serviceTo;
        }
      }
      for (const ln of lines) {
        const m = ln.match(/(?:BILL\s+)?(GS|LGS|FA|ST|SW|WP|WT)\b\s+([-\d$].*)/i);
        if (!m) continue;
        const code = m[1].toUpperCase();
        const nums = [...m[2].matchAll(/-?[\d,]+(?:\.\d+)?/g)].map((x) => parseFloat(x[0].replace(/,/g, '')));
        const amt = nums.length ? nums[nums.length - 1] : null;
        // Consumption is the second-to-last number (columns: Present,
        // Previous, Multiplier, Consumption, Amount). The heuristic
        // find() was picking up the Multiplier (e.g. 1.05100) as usage.
        const consumption = nums.length >= 4 ? nums[nums.length - 2] : null;
        if (code === 'GS' || code === 'LGS') {
          gasAmt = amt;
          if (consumption && consumption > 0 && consumption < 1000000) gasUsage = consumption;
        } else if (code === 'FA') {
          fuelAdj = amt;
          if (fuelAdj != null && fuelAdj > 0) {
            fuelAdj = -Math.abs(fuelAdj);
          }
        } else if (code === 'ST') {
          stormAmt = amt;
        } else if (code === 'SW') {
          sewerAmt = amt;
          if (consumption && consumption > 0 && consumption < 10000000) sewerUsage = consumption;
        } else if (code === 'WP') {
          wpfAmt = amt;
        } else if (code === 'WT') {
          if (amt != null) waterAmt = (waterAmt != null ? waterAmt : 0) + amt;
          if (consumption && consumption > 0 && consumption < 10000000)
            waterUsage = (parseFloat(waterUsage) || 0) + parseFloat(consumption);
        }
      }
      // Bug #137: Fallback FA detection when code-based loop didn't match
      // (e.g. negative amounts or OCR spacing variants that foil the regex).
      if (fuelAdj == null) {
        const _faRe = /(?:FUEL\s*ADJUST|[FE][UO][EL][LA]\s*ADJ)[^\d\n-]*(-?\$?-?[\d,]+\.\d{2})\s*-?/i;
        const faMatch = page.match(_faRe);
        if (faMatch) {
          fuelAdj = parseFloat(faMatch[1].replace(/[\$,]/g, ''));
          if (fuelAdj > 0) fuelAdj = -Math.abs(fuelAdj);
        }
      }
      // BillingDetail OCR sanity: positional extraction picks wrong
      // numbers when OCR garbles the line. Cross-validate and recover.
      // Gas: therms > 50k is impossible for a building. If usage looks
      // like a dollar amount (> 10k), swap usage and amt.
      if (gasUsage > 50000 && gasAmt != null && gasAmt < 100) {
        const swapped = gasUsage;
        gasUsage = null;
        gasAmt = swapped > 100 ? swapped / 100 : swapped;
      }
      // Water/Sewer: if charge < $1 for usage > 1000, OCR likely
      // mangled the charge. Null it so downstream doesn't save garbage.
      if (sewerAmt != null && sewerAmt < 1 && sewerUsage > 1000) sewerAmt = null;
      if (waterAmt != null && waterAmt < 1 && waterUsage > 1000) waterAmt = null;
      // Sewer charge sanity: typical sewer rate is $0.005-$0.05/gallon.
      // If charge/usage < $0.001 (e.g. $75 / 72687 = $0.001), the charge
      // is likely garbled. Derive from water rate if available.
      if (sewerAmt != null && sewerUsage > 0 && waterAmt > 0 && waterUsage > 0) {
        const sewerRate = sewerAmt / sewerUsage;
        const waterRate = waterAmt / waterUsage;
        if (sewerRate < waterRate * 0.1) {
          console.warn('[BillingDetail] Sewer charge $' + sewerAmt + ' implausibly low vs water rate — nulling');
          sewerAmt = null;
        }
      }
      if (sewerUsage && (!waterUsage || waterUsage < 10)) waterUsage = sewerUsage;
      if (waterUsage && (!sewerUsage || sewerUsage < 10)) sewerUsage = waterUsage;
      const bills = [];
      if (gasAmt) {
        const r = _lbg_gasRate(serviceTo || serviceFrom || billDate);
        let gasTotal = gasAmt;
        let gasVariable = Math.round(Math.max(0, gasTotal - r.baseCharge) * 100) / 100;
        const corrected =
          gasUsage > 0
            ? _lbg_correctGasCharge(gasVariable, gasUsage, gasTotal, serviceTo || serviceFrom || billDate)
            : null;
        if (corrected && corrected.corrected) {
          gasVariable = corrected.charge;
          gasTotal = corrected.total;
        }
        if (gasTotal < r.baseCharge && gasUsage > 0) {
          gasVariable = Math.round(gasUsage * r.rate * 100) / 100;
          gasTotal = gasVariable + r.baseCharge;
        }
        if (gasTotal < r.baseCharge && (!gasUsage || gasUsage === 0)) {
          console.warn(
            '[Louisburg BillingDetail] Skipping suspicious gas bill: charge $' +
              gasTotal.toFixed(2) +
              ' < base $' +
              r.baseCharge +
              ' with 0 usage',
          );
        } else {
          const gasWithFA = gasTotal + (fuelAdj || 0);
          const gasBill = {
            ...shared,
            Commodity: 'Gas',
            NaturalGasTherms: gasUsage,
            CustomerCharge: r.baseCharge,
            GasCharge: gasVariable,
            FuelAdjustment: fuelAdj,
            TotalCurrentCharges: gasWithFA.toFixed(2),
            TotalAmountDue: gasWithFA.toFixed(2),
          };
          if (corrected && corrected.corrected)
            gasBill._auto_corrected_GasCharge = {
              original: gasAmt,
              corrected: gasVariable,
              reason: corrected.reason,
            };
          bills.push(gasBill);
        }
      }
      if (waterAmt) {
        const t = (waterAmt + (wpfAmt || 0)).toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Water',
          WaterUsage: waterUsage,
          WaterCharge: waterAmt,
          WaterProtectionFee: wpfAmt,
          TotalCurrentCharges: t,
          TotalAmountDue: t,
        });
      }
      if (sewerAmt) {
        bills.push({
          ...shared,
          Commodity: 'Sewer',
          SewerUsage: sewerUsage,
          SewerCharge: sewerAmt,
          TotalCurrentCharges: sewerAmt.toFixed(2),
          TotalAmountDue: sewerAmt.toFixed(2),
        });
      }
      if (stormAmt != null) {
        bills.push({
          ...shared,
          Commodity: 'Stormwater',
          StormWaterCharge: stormAmt,
          TotalCurrentCharges: stormAmt.toFixed(2),
          TotalAmountDue: stormAmt.toFixed(2),
        });
      }
      return bills.length ? bills : null;
    },
    _extractLGSDetail: function (page) {
      // Account number: 7-10 digit number after "Account Number"
      const acct = page.match(/Account\s*(?:Number|#)\s*:?\s*(\d{7,10})/i)?.[1] || null;

      // Customer name
      const custMatch = page.match(/Customer\s*Name\s*:?\s*(.*?)(?:\n|Account)/i);
      const CustomerName = custMatch ? custMatch[1].trim() : null;

      // Service address: line with a street number before city/state
      const addrMatch = page.match(/(\d{2,6}\s+[A-Z][A-Z0-9 ]+?),?\s*(?:NEW\s+)?(?:HS|MS|ES|ELEM)?\s*LOUISBURG/i);
      const ServiceAddress = addrMatch ? addrMatch[0].trim() : null;

      // Billing date
      const billDateMatch = page.match(/Billing\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const BillDate = billDateMatch ? billDateMatch[1] : null;

      // Service period from the "service from MM/DD/YYYY to MM/DD/YYYY" phrase
      const periodMatch = page.match(/service\s*from\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*to\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const BillingPeriodStart = periodMatch ? periodMatch[1] : null;
      const BillingPeriodEnd = periodMatch ? periodMatch[2] : null;

      // Rate schedule
      const rateMatch = page.match(/(LGS\s+[A-Za-z ]+?)\s*-\s*(\w+)/i);
      const RateSchedule = rateMatch ? rateMatch[0].trim() : 'LGS';

      // Parse charge lines: look for dollar amounts after charge labels
      // OCR may garble labels, so also try loose dollar extraction
      const lines = page.split(/\r?\n/);
      let customerChg = null,
        commodityChg = null,
        fuelAdj = null,
        totalAmt = null;
      for (const ln of lines) {
        if (/Customer\s*Ch/i.test(ln)) {
          const m = ln.match(/\$\s*([\d,]+\.\d{2})/);
          if (m) customerChg = parseFloat(m[1].replace(/,/g, ''));
        }
        if (/Commodity\s*Ch|Energy\s*Ch/i.test(ln)) {
          const m = ln.match(/\$\s*([\d,]+\.\d{2})/);
          if (m) commodityChg = parseFloat(m[1].replace(/,/g, ''));
        }
        if (/Fuel\s*(?:Adj|Cost)/i.test(ln)) {
          const m = ln.match(/-?\$?\s*([\d,]+\.\d{2})/);
          if (m) {
            fuelAdj = parseFloat(m[1].replace(/,/g, ''));
            if (/[-()]/.test(ln) || /credit/i.test(ln)) fuelAdj = -Math.abs(fuelAdj);
          }
        }
        if (/Total\s*(?:Current|Amount|Due)/i.test(ln)) {
          const m = ln.match(/\$?\s*([\d,]+\.\d{2})/);
          if (m) totalAmt = parseFloat(m[1].replace(/,/g, ''));
        }
      }

      // If we couldn't find structured charges, try to find any dollar amounts
      if (!totalAmt) {
        const allDollars = [...page.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
        if (allDollars.length) totalAmt = Math.max(...allDollars);
      }

      if (!totalAmt && !commodityChg && !customerChg) return null;

      const gasTotal = totalAmt || (customerChg || 0) + (commodityChg || 0) + (fuelAdj || 0);
      const gasCharge = commodityChg || gasTotal - (customerChg || 0) - (fuelAdj || 0);

      // Compute therms from gas charge and known rate if possible
      const r = _lbg_gasRate(BillingPeriodEnd || BillingPeriodStart || BillDate);
      let therms = null;
      if (gasCharge > 0 && r.rate > 0) {
        therms = Math.round((gasCharge - (fuelAdj && fuelAdj > 0 ? fuelAdj : 0)) / r.rate);
      }

      // Meter reads — look for numeric patterns near "Read" or "Meter"
      let startRead = null,
        endRead = null;
      for (const ln of lines) {
        const reads = [...ln.matchAll(/\b(\d{4,8})\b/g)].map((m) => parseInt(m[1]));
        if (reads.length >= 2 && reads[1] > reads[0] && reads[1] - reads[0] < 100000) {
          startRead = reads[0];
          endRead = reads[1];
          break;
        }
      }

      return {
        UtilityCompany: 'City of Louisburg',
        BillFormat: 'lgs-detail',
        Commodity: 'Gas',
        CustomerName,
        AccountNumber: acct,
        ServiceAddress,
        BillDate,
        BillingPeriodStart,
        BillingPeriodEnd,
        NumberOfDays: null,
        RateSchedule,
        MeterNumber: null,
        StartRead: startRead,
        EndRead: endRead,
        NaturalGasTherms: therms,
        CustomerCharge: customerChg,
        GasCharge: gasCharge,
        FuelAdjustment: fuelAdj,
        TotalCurrentCharges: gasTotal.toFixed(2),
        TotalAmountDue: gasTotal.toFixed(2),
      };
    },
    _extractBillingInquiry: function (page) {
      console.log('[BillingInquiry] Raw text (500):', page.slice(0, 500));
      const acct = page.match(/Account\s*[#8]?\s*[\[(\s]*(\d{4,8})/i)?.[1] || null;
      const fixDate = (d) => (d ? d.replace(/-/g, '/') : null);
      const dueDate = fixDate(
        page.match(/Due\s*Da[lt]e\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1] ||
          page.match(/Due\s*Da[lt]e\s*:?\s*(\d{1,2}-\d{1,2}-\d{4})/i)?.[1],
      );
      const custMatch = page.match(/USD\s*(\d{3,4})\s+([A-Z][A-Z0-9 .&\-]+?)(?:\n|$)/m);
      const CustomerName = custMatch ? 'USD ' + custMatch[1] + ' ' + custMatch[2].trim() : null;
      const addrMatch = page.match(/\d+\s+[A-Z]+\s+(?:DRIVE|DR|STREET|ST|AVE|ROAD|RD|LN|CT|WAY)\b/i);
      const ServiceAddress = addrMatch ? addrMatch[0].trim() : null;
      let periodEnd = null,
        periodStart = null;
      if (dueDate) {
        const d = new Date(dueDate);
        if (!isNaN(d)) {
          d.setDate(d.getDate() - 25);
          periodEnd = d.getMonth() + 1 + '/' + d.getDate() + '/' + d.getFullYear();
          const s = new Date(d);
          s.setMonth(s.getMonth() - 1);
          periodStart = s.getMonth() + 1 + '/' + s.getDate() + '/' + s.getFullYear();
        }
      }
      const shared = {
        UtilityCompany: 'City of Louisburg',
        BillFormat: 'billing-inquiry',
        CustomerName,
        AccountNumber: acct,
        ServiceAddress,
        BillDate: dueDate,
        BillingPeriodStart: periodStart,
        BillingPeriodEnd: periodEnd,
        NumberOfDays: null,
        RateSchedule: null,
        MeterNumber: null,
      };
      const lines = page.split(/\r?\n/);
      const CODE_MAP = { GS: 'Gas', ST: 'Stormwater', SW: 'Sewer', WP: 'WaterProtection', WT: 'Water' };
      const amounts = {};
      for (const ln of lines) {
        const m = ln.match(/^\s*(GS|ST|SW|WP|WT)\s+([\d,.]+)/);
        if (m) amounts[m[1]] = parseFloat(m[2].replace(/,/g, ''));
      }
      const bills = [];
      if (amounts.GS) {
        const r = _lbg_gasRate(periodEnd || dueDate);
        const gasVariable = Math.round(Math.max(0, amounts.GS - r.baseCharge) * 100) / 100;
        bills.push({
          ...shared,
          Commodity: 'Gas',
          CustomerCharge: r.baseCharge,
          GasCharge: gasVariable,
          TotalCurrentCharges: amounts.GS.toFixed(2),
          TotalAmountDue: amounts.GS.toFixed(2),
        });
      }
      if (amounts.WT) {
        const t = (amounts.WT + (amounts.WP || 0)).toFixed(2);
        bills.push({
          ...shared,
          Commodity: 'Water',
          WaterCharge: amounts.WT,
          WaterProtectionFee: amounts.WP || null,
          TotalCurrentCharges: t,
          TotalAmountDue: t,
        });
      }
      if (amounts.SW) {
        bills.push({
          ...shared,
          Commodity: 'Sewer',
          SewerCharge: amounts.SW,
          TotalCurrentCharges: amounts.SW.toFixed(2),
          TotalAmountDue: amounts.SW.toFixed(2),
        });
      }
      if (amounts.ST != null && amounts.ST > 0) {
        bills.push({
          ...shared,
          Commodity: 'Stormwater',
          StormWaterCharge: amounts.ST,
          TotalCurrentCharges: amounts.ST.toFixed(2),
          TotalAmountDue: amounts.ST.toFixed(2),
        });
      }
      return bills.length ? bills : null;
    },
  },
  {
    name: 'City of Baldwin City',
    // Handles multi-account scanned PDF bills from City of Baldwin City, KS.
    // Each PDF covers all of this account holder's sub-accounts — one account per page.
    // Page 1 is typically an email notification — skip it.
    // Commodities: Electric (EL), Water (WA), Sewer (SW). No gas.
    // Verified against 2025-04, 2025-07, 2025-12, 2026-02, 2026-04 bill formats.
    detect: (t) =>
      /baldwin\s*city|baldwincitygov?\.(?:com|org)|803\s+8th\s+Street[^,]*Baldwin/i.test(t) &&
      /FRANCHISE\s+FEE|EL\s*-\s*ELECTRIC|ACCOUNT\s+NUMBER/i.test(t),
    extractAll: function (t) {
      const pages = _lbg_splitPages(t);
      const _unmatchedPages = [];
      const bills = pages.flatMap((p, i) => {
        // Skip page 1 (email notification) — detected by email headers or
        // absence of "ACCOUNT NUMBER" label. Also skip payment receipt pages.
        const isEmailPage = /^\s*%%PAGE_1%%/.test(p) && (/From:|Subject:|To:/i.test(p) || !/ACCOUNT\s+NUMBER/i.test(p));
        const isReceiptPage = /Payment\s+Receipt|Total\s+Paid/i.test(p) && !/ACCOUNT\s+NUMBER/i.test(p);
        if (isEmailPage || isReceiptPage) return [];

        const r = this._extractPage(p);
        if (!r || (Array.isArray(r) && r.length === 0)) {
          if (p.trim().length > 50) {
            const pageNums = [...p.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
            _unmatchedPages.push({
              pageNums: pageNums.length ? pageNums : [i + 1],
              preview: p.trim().slice(0, 200),
            });
          }
          return [];
        }
        const arr = Array.isArray(r) ? r : [r];
        for (const b of arr) b._pageIndex = i + 1;
        return arr;
      });
      if (_unmatchedPages.length) bills._unmatchedPages = _unmatchedPages;

      // Backfill missing billing periods from neighbor bills sharing the
      // same BillDate — same strategy as City of Louisburg.
      const byBillDate = {};
      for (const b of bills) {
        if (b.BillDate && b.BillingPeriodStart && b.BillingPeriodEnd) {
          byBillDate[b.BillDate] = { start: b.BillingPeriodStart, end: b.BillingPeriodEnd };
        }
      }
      for (const b of bills) {
        if ((!b.BillingPeriodStart || !b.BillingPeriodEnd) && b.BillDate && byBillDate[b.BillDate]) {
          b.BillingPeriodStart = b.BillingPeriodStart || byBillDate[b.BillDate].start;
          b.BillingPeriodEnd = b.BillingPeriodEnd || byBillDate[b.BillDate].end;
          b._periodFromNeighbor = true;
        }
      }

      // ── Cross-page year backstop for bills with null BillDate ──
      // FIX(2026-06-11): Pages 5, 6, 26 had BillDate=null because the top-right
      // date line ended with a trailing OCR artifact char ("i"/"t") that P2 could
      // not match.  P2b now catches those, but as a further safety net: if a bill
      // still has no BillDate but the rest of the PDF has a single consistent
      // BillDate (all Baldwin PDFs cover one billing cycle), infer the BillDate
      // and billing period from the PDF-wide consensus.
      // Only applies when byBillDate has exactly ONE key (one billing cycle in the
      // PDF), so we don't risk cross-period contamination.
      const _knownBillDates = Object.keys(byBillDate);
      if (_knownBillDates.length === 1) {
        const _canonicalBillDate = _knownBillDates[0];
        const _canonicalPeriod = byBillDate[_canonicalBillDate];
        for (const b of bills) {
          if (!b.BillDate && !b.BillingPeriodStart) {
            b.BillDate = _canonicalBillDate;
            b.BillingPeriodStart = _canonicalPeriod.start;
            b.BillingPeriodEnd = _canonicalPeriod.end;
            if (!b._date_reconstructed) b._date_reconstructed = [];
            b._date_reconstructed.push({
              field: 'BillDate',
              original: null,
              corrected: _canonicalBillDate,
              reason: 'BillDate null (OCR trailing-artifact); inferred from PDF-wide consensus (single billing cycle)',
            });
          }
        }
      }

      return bills;
    },
    _extractPage: function (page) {
      // ── Account number ──
      // Real scanned OCR mangles the top "ACCOUNT NUMBER" region heavily
      // (e.g. "ER ALDWIN", "FRALD" instead of "BALDWIN"; trailing period on
      // label; number on next line buried in noise).  Try multiple patterns
      // in reliability order and take the first valid 7-10 digit result.
      //
      // Pattern 1 (most reliable): bottom-stub "ACCOUNT #: <digits>"
      //   OCR reliably renders this compact line: "ACCOUNT #: <REDACTED-ACCT>"
      // Pattern 2: top-stub label + number on SAME line (clear scans):
      //   "ACCOUNT NUMBER <REDACTED-ACCT>"
      // Pattern 3: label + number on NEXT line (1-2 lines later, possibly
      //   with OCR noise like "RIA | DWIN <REDACTED-ACCT-3>" between them):
      //   "ACCOUNT NUMBER\n<REDACTED-ACCT-4>" or "ACCOUNT NUMBER\nRIA|DWIN <REDACTED-ACCT-3>"
      // Pattern 4: standalone 9-digit number that immediately follows OCR
      //   noise derived from garbled "BALDWIN" / "ALDWIN" text near the top
      //   of the right-hand column stub.
      let AccountNumber = null;
      let _p5RawAcct = null; // set by P5 when OCR-garbled digits are normalized; read at flag-detection below
      // P1 — bottom stub (most reliable across all pages)
      AccountNumber = page.match(/ACCOUNT\s*#[:\s]+(\d{7,10})/i)?.[1] || null;
      // P2 — top label + number on same line
      if (!AccountNumber) AccountNumber = page.match(/ACCOUNT\s+NUMBER\.?\s+(\d{7,10})/i)?.[1] || null;
      // P3 — top label + number within 3 lines (up to ~60 chars of OCR noise)
      if (!AccountNumber) {
        const p3 = page.match(/ACCOUNT\s+NUMBER\.?[\s\S]{0,60}?(?:^|\s|\|)(\d{7,10})(?:\s|$)/im);
        if (p3) AccountNumber = p3[1];
      }
      // P4 — 9-digit number after garbled "ALDWIN"/"DWIN"/"RALD" OCR fragment
      if (!AccountNumber) {
        const p4 = page.match(
          /(?:ALDWIN|DWIN|RALD|RWIN|FRALD|ERALD|ER\s*ALDWIN|FR\s*DWI)[\s\S]{0,40}?(?:^|\s)(\d{9})(?:\s|$)/im,
        );
        if (p4) AccountNumber = p4[1];
      }

      // P5 — OCR-garbled bottom stub: account number contains letters (OCR substitutes
      // look-alike chars for digits). Match ACCOUNT #/H#/# with period/colon/space
      // separator followed by 7-11 alphanumeric chars; normalize common OCR digit
      // confusions. Auto-accepts result if all chars normalize to digits (7-10 long).
      // Stamps _accountOCRNormalized:true on the bill so the user knows to verify.
      if (!AccountNumber) {
        const _p5m = page.match(/ACCOUNT\s*H?#[.:\s]+([A-Za-z0-9]{7,11})/i);
        if (_p5m) {
          const _rawAcct = _p5m[1];
          const _normAcct = _rawAcct
            .replace(/[aA]/g, '4')
            .replace(/[oO]/g, '0')
            .replace(/[iIlL]/g, '1')
            .replace(/[sS]/g, '5')
            .replace(/[zZ]/g, '2')
            .replace(/[eE]/g, '6')
            .replace(/[cC]/g, '0')
            .replace(/[vV]/g, '0');
          if (/^\d{7,10}$/.test(_normAcct)) {
            AccountNumber = _normAcct;
            _p5RawAcct = _rawAcct; // persist raw garbled string for flag-detection below (can't attach to primitive string)
          }
        }
      }

      // ── Service address (from bottom stub) — extracted here so it can serve
      // as an identity fallback when the account number is unresolvable.
      // "ADDRESS: <REDACTED-ADDR>" or "ADDRESS:  <REDACTED-ADDR>"
      // Page 5 OCR renders the colon as semicolon: "ADDRESS; 6TH ST"
      // FIX(2026-06-02): Truncate at the FIRST date-like token or run of
      // numeric/amount columns that bleeds from adjacent columns into the
      // address field.
      // FIX(2026-07-02, item 219e6828): Replaced the well-formed-date-only
      // split with _stripAddressTrailingJunk (shared, near top of file),
      // which also strips garbled dates like "as/25/2" / "4/25/2" that
      // defeated the old \d{1,2}/\d{1,2}/\d{2,4} split. ServiceAddress itself
      // is intentionally left NON-null even when garbage (a page with a
      // garbled account number relies on ServiceAddress for identity — see
      // "Skip pages" comment below; nulling it here could silently drop a
      // whole bill). Plausibility gating instead happens via the
      // _addressPlausible flag stamped onto `shared` below, which the UI
      // (bill-analysis.js _bldgName) uses to decide whether to show this
      // value as a label or fall back to the account number.
      const _addrRaw = page.match(/ADDRESS\s*[;:]\s*([^\n]+)/i)?.[1]?.trim() || null;
      const ServiceAddress = _addrRaw ? _stripAddressTrailingJunk(_addrRaw) : null;

      // Skip pages that have no account number AND no service address
      // (email/receipt pages that slipped through the page-1 guard).
      // FIX(2026-06-11): When OCR produces >10 garbled digits (e.g. "4o0e60s2400"
      // → "<REDACTED-ACCT>"), P5 fails the 7-10 digit check and AccountNumber stays null.
      // Such pages still have a readable service address; continue with AccountNumber=null
      // and key by address instead of returning null and losing the page's charges.
      if (!AccountNumber && !ServiceAddress) return null;
      // Flag when we're falling back to address-based identity (no valid account #)
      const _accountFromAddress = !AccountNumber && !!ServiceAddress;

      // ── Bill date (print date, top-right corner) ──
      // Standalone date like "4/10/26" or "12/10/25".
      // Page 7 OCR renders "4" as "A" giving "A/10/26" — tolerate that.
      // Also find date adjacent to "ACCOUNT NUMBER" label on same line or
      // on the immediately preceding line (separated by pipe/column noise).
      // FIX(2026-06-02): real OCR produces "4/10/26 |" (trailing pipe) or
      // "4/10/26\nACCOUNT NUMBER" — the old \s* pattern fails with trailing
      // pipe, and the same-line pattern fails when the date and label are on
      // separate lines.  New patterns tolerate [\s|]* at end of date line and
      // accept date on the line immediately before "ACCOUNT NUMBER".
      // FIX(2026-06-11): Pages 5, 6, 26 have a trailing OCR "i" or "t" artifact
      // from the right-side border column (e.g. "4/10/25                  i").
      // P2 required a clean line end; P2b tolerates 1-5 trailing noise chars.
      // Page 27 has "as10/25" where the month digit is OCR-garbled as letters;
      // P5 catches date-like patterns where leading letters replace the month.
      const BillDate = (() => {
        // P1 — date + ACCOUNT NUMBER on same line (clear scans, no pipe)
        const _p1 = page.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})[\s|]*ACCOUNT\s+NUMBER/i)?.[1];
        if (_p1) return _p1;
        // P2 — date on own line, optionally followed by pipe/spaces (trailing pipe noise)
        const _p2 = page.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})[\s|]*$/m)?.[1];
        if (_p2) return _p2;
        // P2b — date on own line with trailing OCR noise chars (e.g. trailing "i" or "t"
        //   from right-side border artifact: "4/10/25                                   i")
        //   Only accept if the trailing noise is 1-5 non-slash word chars separated by
        //   significant whitespace (≥3 spaces) so we don't misfire on address lines.
        const _p2b = page.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s{3,}[|\s]*[A-Za-z|]{1,5}\s*$/m);
        if (_p2b) return _p2b[1];
        // P3 — date on one line, ACCOUNT NUMBER on next line (1-2 lines gap with pipe noise)
        const _p3 = page.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})[\s|]*$[\s\S]{0,4}^ACCOUNT\s+NUMBER/m)?.[1];
        if (_p3) return _p3;
        // P4 — OCR "A" for "4": e.g. "A/10/26" (with optional trailing pipe)
        const _p4m = page.match(/^([A-Z]\/\d{1,2}\/\d{2,4})[\s|]*$/m);
        if (_p4m) return _p4m[1].replace(/^[A-Z]/, '4');
        // P5 — garbled leading chars before /DD/YY (e.g. "as10/25" where OCR turned
        //   "4/" into "as").  Match a line starting with 1-3 letter chars followed by
        //   \d{1,2}\/\d{2,4} — extract the numeric tail and reconstruct as M/DD/YY.
        //   Only accept when the line is otherwise clean (trailing spaces/pipe only).
        //   The reconstructed month is always the same as the bill-file's dominant month
        //   (validated later by context), so we emit the raw tail for now.
        const _p5m = page.match(/^[A-Za-z]{1,3}(\d{1,2}\/\d{2,4})[\s|]*$/m);
        if (_p5m) {
          // We cannot know the month from garbled chars alone, but we know the day+year.
          // Emit null here; the cross-page year backstop in extractAll will resolve this.
          // If the BillDate from another page on the same file is "4/10/25" we record
          // the bill-year. In _extractPage we cannot see other pages, so return null.
          // However: if there is a recognisable date anywhere in the first 300 chars of
          // the page that shares the year, try to infer the month from context.
          // Specifically, look for the due-date column on the same page: the due date
          // month always matches the bill date month for Baldwin.
          const _dueDateMatch = page.match(/\bDUE\s*DATE[\s\S]{0,60}?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
          if (_dueDateMatch) {
            const _dMo = parseInt(_dueDateMatch[1]);
            const _dYr = _dueDateMatch[3].length === 2 ? '20' + _dueDateMatch[3] : _dueDateMatch[3];
            const _dYrInt = parseInt(_dYr);
            // Bill date is typically ~10th of the SAME month as the due date.
            // Reconstruct: bill date month = due-date month, day ≈ 10, year = due-date year.
            // This is an inference — mark it for traceability.
            if (_dMo >= 1 && _dMo <= 12 && _dYrInt >= 2020 && _dYrInt <= 2030) {
              return _dMo + '/10/' + _dYr; // best-effort; actual day unknown but year is reliable
            }
          }
          return null;
        }
        return null;
      })();

      // ── Context-based date year reconstruction ──
      // The top-right BillDate (e.g. "4/10/25") is the most reliable date on each
      // page — it appears in the bill header before any of the detail columns.
      // When BillDate is valid, extract its year as a trusted anchor (_pageYear)
      // and use it to reconstruct any other date on this page whose year is:
      //   • truncated to <4 digits (e.g. "4/25/2" — year "2" is clearly cut off)
      //   • a 2-digit value that doesn't map to the bill year (e.g. "72" or "22"
      //     when BillDate year is 2025 — OCR garbled "25" → "72" or "22")
      // FIX(2026-06-11): Baldwin due dates show "4/25/2", "4/25/72", "4/25/22"
      // because the year is physically at the very edge of the page and is
      // partially cut off or OCR-garbled.  The BillDate anchor lets us recover it.
      // Conservative rules:
      //   1. Only reconstruct when BillDate is valid and year is in range 2020-2099.
      //   2. Only reconstruct the year component; month/day come from the raw OCR.
      //   3. Month of the candidate date must match BillDate month (due date month
      //      is always the same as the bill date month for Baldwin).
      //   4. Record original + corrected + reason in _date_reconstructed[].
      //   5. If ambiguous (month mismatch, no BillDate anchor), leave unchanged.
      const _dateReconstructed = []; // diagnostics: {field, original, corrected, reason}

      // Helper: parse a 2-5 digit year string into a full 4-digit year, or null if
      // the value is already 4 digits in range.  Returns {fullYear, wasGarbled}.
      const _resolveYear = (rawYearStr, anchorYear) => {
        if (!anchorYear || anchorYear < 2020 || anchorYear > 2099) return null;
        const anchorYr2 = anchorYear % 100; // e.g. 25 for 2025
        const rawY = parseInt(rawYearStr, 10);
        if (isNaN(rawY)) return null;
        const digits = rawYearStr.length;
        if (digits === 4 && rawY === anchorYear) return null; // already correct, no action
        if (digits === 4 && rawY !== anchorYear) return null; // 4-digit but different year — don't touch
        // digits < 4: truncated or garbled
        if (digits === 1) {
          // "2" — almost certainly the year was cut off; anchor year is authoritative
          return {
            fullYear: anchorYear,
            wasGarbled: true,
            reason: 'year truncated to 1 digit; reconstructed from BillDate anchor',
          };
        }
        if (digits === 2) {
          if (rawY === anchorYr2) return null; // "25" with anchor 2025 — already correct 2-digit, let caller expand
          // "72" or "22" when anchor is 2025 — garbled
          return {
            fullYear: anchorYear,
            wasGarbled: true,
            reason: 'year (' + rawYearStr + ') inconsistent with BillDate anchor (' + anchorYear + '); reconstructed',
          };
        }
        if (digits === 3) {
          // "202" — truncated
          return {
            fullYear: anchorYear,
            wasGarbled: true,
            reason: 'year truncated to 3 digits; reconstructed from BillDate anchor',
          };
        }
        return null;
      };

      // Parse _pageYear from BillDate for use as the anchor.
      let _pageYear = null;
      if (BillDate) {
        const _bdParts = BillDate.split('/');
        if (_bdParts.length === 3) {
          const _yr = _bdParts[2].length === 2 ? 2000 + parseInt(_bdParts[2]) : parseInt(_bdParts[2]);
          if (_yr >= 2020 && _yr <= 2099) _pageYear = _yr;
        }
      }

      // Reconstruct any date token in the raw page text whose year is truncated/garbled.
      // We operate on a working copy of the page text so downstream patterns see clean dates.
      // Key constraint: only reconstruct when the month of the candidate date matches
      // the BillDate month (both the due date and the bill date use the same calendar month
      // for Baldwin City).
      const _billDateMonth = _pageYear && BillDate ? parseInt(BillDate.split('/')[0]) : null;
      let _pageTextCleaned = page; // will be mutated with reconstructed years
      if (_pageYear && _billDateMonth) {
        // Match all date-like tokens: M/DD/Y{1,3} (truncated year) or M/DD/YY where
        // the 2-digit year is inconsistent with the anchor.
        // Exclude already-valid 4-digit years.
        const _datePatchRe = /(\b\d{1,2}\/\d{1,2}\/)(\d{1,3})\b/g;
        _pageTextCleaned = page.replace(_datePatchRe, (full, prefix, rawYr) => {
          const _mo = parseInt(prefix.split('/')[0]);
          if (_mo !== _billDateMonth) return full; // month mismatch — don't touch
          const _resolved = _resolveYear(rawYr, _pageYear);
          if (!_resolved) return full; // already correct or ambiguous
          const corrected = prefix + _resolved.fullYear;
          _dateReconstructed.push({
            field: 'date_in_page_text',
            original: full,
            corrected,
            reason: _resolved.reason,
          });
          return corrected;
        });
      }

      // ── Service FROM/TO (present in some pages, primarily older format) ──
      let BillingPeriodStart = null;
      let BillingPeriodEnd = null;
      const servicePeriodMatch = _pageTextCleaned.match(
        /SERVICE\s+FROM\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+TO\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      );
      if (servicePeriodMatch) {
        BillingPeriodStart = servicePeriodMatch[1];
        BillingPeriodEnd = servicePeriodMatch[2];
      }
      // If no explicit period, infer from bill date (monthly cycle).
      // Bill date is the print date (~10th of month); service period is
      // typically the prior calendar month.
      if (!BillingPeriodStart && BillDate) {
        const sp = BillDate.split('/');
        if (sp.length === 3) {
          const mo = parseInt(sp[0]);
          const yr = sp[2].length === 2 ? '20' + sp[2] : sp[2];
          const prevMo = mo <= 1 ? 12 : mo - 1;
          const prevYr = mo <= 1 ? String(parseInt(yr) - 1) : yr;
          const daysInPrevMo = new Date(parseInt(prevYr), prevMo, 0).getDate();
          BillingPeriodStart = prevMo + '/1/' + prevYr;
          BillingPeriodEnd = prevMo + '/' + daysInPrevMo + '/' + prevYr;
        }
      }

      // ── Amount due (total for all commodities on this account page) ──
      // The column header "AMOUNT DUE NOW" is always garbled by OCR on real
      // scanned bills (e.g. "BAROUxw mes once)", "FACGxs melo tensy") — the
      // label-based patterns never match.  Use structural alternatives instead:
      //
      // Strategy A: "AMOUNT DUE NOW" survives OCR (digital PDFs / clear scans)
      // Strategy B: Three-column row near a due-date:
      //   "4/25/26  55.22  50.19"  →  last value is Amount Due Now
      // Strategy C: Due-date + single amount on same line (common in larger bills):
      //   "4/25/26 1978.53"
      // Strategy D: "AMOUNT DUE" (partial label) fallback for partial OCR match
      let TotalAmountDue = null;
      // A — label survived
      const _amtLabelMatch =
        page.match(/AMOUNT\s+DUE\s+NOW\s+[\d.]+\s+([\d,]+\.\d{2})/i) ||
        page.match(/AMOUNT\s+DUE\s+NOW\D{0,30}?([\d,]+\.\d{2})/i);
      if (_amtLabelMatch) TotalAmountDue = _amtLabelMatch[1].replace(/,/g, '');
      // B — three-value line starting with a date (DUE DATE  AFTER-DUE  AMOUNT-DUE)
      // Use _pageTextCleaned so reconstructed years (e.g. "4/25/2025" from "4/25/2")
      // are visible to the date pattern. Without this, "4/25/2" (\d{1} year) would
      // fail \d{2,4} and the amount would be missed.
      if (!TotalAmountDue) {
        const _3col = _pageTextCleaned.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/m);
        if (_3col) TotalAmountDue = _3col[2].replace(/,/g, '');
      }
      // C — date + single amount on line (no after-due column; larger totals)
      if (!TotalAmountDue) {
        const _1col = _pageTextCleaned.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+([\d,]+\.\d{2})\s*$/m);
        if (_1col) TotalAmountDue = _1col[1].replace(/,/g, '');
      }
      // D — partial "AMOUNT DUE" label (some pages retain partial text)
      if (!TotalAmountDue) {
        const _partial = page.match(/AMOUNT\s+DUE\D{0,40}?([\d,]+\.\d{2})/i);
        if (_partial) TotalAmountDue = _partial[1].replace(/,/g, '');
      }

      // ── Customer / building name ──
      // "BAKER UNIVERSITY/COLLINS HOUSE" or "BAKER UNIVERSITY" alone.
      const custMatch =
        page.match(/BAKER\s+UNIVERSITY\s*\/\s*([A-Z][A-Z0-9 &'.'-]+)/i) || page.match(/BAKER\s+UNIVERSITY/i);
      const CustomerName = custMatch
        ? custMatch[1]
          ? 'Baker University / ' + custMatch[1].trim().replace(/\s+/g, ' ')
          : 'Baker University'
        : null;

      // ── Parse charge lines ──
      // Format: "[CODE] - [LABEL]  [PREV]  [CURR]  [USAGE]  [CHARGE]"
      // Some lines have no meter reads (franchise fee, fuel adj).
      // Baldwin City charge codes:
      //   EL - ELECTRIC        (one or more rows per account — sum kWh)
      //   EL/GH - FRANCHISE FEE  (electric franchise)
      //   FA/EL - FUEL ADJUSTMENT  (electric fuel adj, can be negative)
      //   SW - SEWER           (one row, shares meter reads with water)
      //   SW - FRANCHISE FEE   (sewer franchise)
      //   WA - WATER           (one row, gallons)
      //   WA - DEBT PMT / WA - METER DEBT PMT  (water debt fee)
      //   WA/HA - FRANCHISE FEE  (water franchise)

      const lines = page.split(/\r?\n/);

      // Helpers ---------------------------------------------------------

      // Parse a trailing dollar amount from a charge line.
      // Baldwin bills have no "$" sign on line items; amounts like "16.99"
      // or "2.04-" (trailing minus = negative) or "-2.04" (leading minus).
      const _parseCharge = (s) => {
        if (!s) return null;
        s = s.trim();
        // Trailing minus: "2.04-" → -2.04
        if (/^[\d,]+\.\d{2}-$/.test(s)) return -parseFloat(s.slice(0, -1).replace(/,/g, ''));
        // Parens: "(2.04)" → -2.04
        if (/^\([\d,]+\.\d{2}\)$/.test(s)) return -parseFloat(s.slice(1, -1).replace(/,/g, ''));
        // Leading minus: "-2.04"
        if (/^-[\d,]+\.\d{2}$/.test(s)) return parseFloat(s.replace(/,/g, ''));
        // Plain: "16.99" or ".97"
        if (/^[\d,]*\.\d{2}$/.test(s)) return parseFloat(s.replace(/,/g, ''));
        // ".00" style (zero charge shown as "\.00")
        if (/^\.\d{2}$/.test(s)) return parseFloat(s);
        // 3-4 decimal OCR noise: "30.271" or "50.6234" → round to 2 decimals.
        // OCR occasionally adds a trailing digit to the cents field.
        if (/^[\d,]+\.\d{3,4}$/.test(s)) return Math.round(parseFloat(s.replace(/,/g, '')) * 100) / 100;
        return null;
      };

      // Extract numeric tokens from a line (meter reads, usage, charge).
      // Returns array of floats; filters out page-number-sized ints < 10.
      const _tokens = (s) => {
        if (!s) return [];
        return [...s.matchAll(/-?[\d,]+(?:\.\d+)?(?:-\d{2})?/g)]
          .map((m) => {
            let v = m[0];
            // "1460-87" → 1460.87 (OCR cents encoding)
            if (/^\d+-\d{2}$/.test(v)) v = v.replace(/-(\d{2})$/, '.$1');
            // European decimal: "104,03" or "10,00" — comma IS the decimal separator.
            // Detect: 1-4 integer digits, comma, exactly 2 decimal digits, no period.
            // Exclude real thousands like "44,576.64" (has a period) or "1,234,567" (>4 pre-comma).
            if (/^\d{1,4},\d{2}$/.test(v)) return parseFloat(v.replace(',', '.'));
            return parseFloat(v.replace(/,/g, ''));
          })
          .filter((n) => !isNaN(n));
      };

      // Parse a metered charge line that has prev/curr/usage/charge cols.
      // Returns {prevRead, currRead, usage, charge} or nulls.
      const _parseMeteredLine = (line) => {
        if (!line) return { prevRead: null, currRead: null, usage: null, charge: null };
        const toks = _tokens(line);
        if (toks.length < 2) return { prevRead: null, currRead: null, usage: null, charge: null };
        // Last token should be the charge (decimal with .XX).
        // Preceding integers are meter reads and/or usage.
        let charge = toks[toks.length - 1];
        if (isNaN(charge)) return { prevRead: null, currRead: null, usage: null, charge: null };
        // Guard: if the candidate "charge" is an integer with no decimal part AND
        // equals one of the other tokens (i.e. a meter read), the line has no valid
        // charge (OCR garble like "271200 271200 -.Co" loses the real amount and
        // leaves only the meter reads). Real charges always have a decimal component.
        // Note: Number.isInteger() is true for e.g. 271200 but false for 44576.64.
        if (Number.isInteger(charge) && toks.slice(0, -1).includes(charge)) {
          return { prevRead: null, currRead: null, usage: null, charge: null };
        }
        // Filter to integer-valued tokens (meter reads and usage are whole numbers).
        const intToks = toks.slice(0, -1).filter((n) => Number.isInteger(n) && n >= 0);
        let prevRead = null,
          currRead = null,
          usage = null;
        if (intToks.length >= 3) {
          // prev, curr, usage layout
          prevRead = intToks[intToks.length - 3];
          currRead = intToks[intToks.length - 2];
          usage = intToks[intToks.length - 1];
        } else if (intToks.length === 2) {
          prevRead = intToks[0];
          currRead = intToks[1];
          usage = Math.abs(currRead - prevRead);
        }
        // Ensure prevRead <= currRead
        if (prevRead != null && currRead != null && prevRead > currRead) {
          const tmp = prevRead;
          prevRead = currRead;
          currRead = tmp;
        }
        // ── FIX(2026-06-19): Bug A — integer-charge-equals-usage guard ──
        // When OCR drops the decimal charge column on an EL-ELECTRIC (or any
        // metered) line, the last token on the line is the usage integer, not a
        // dollar amount.  The existing guard at the top of this function only
        // catches duplicates of the METER READ tokens; it misses the case where
        // the "charge" equals the COMPUTED usage.  Real utility charges always
        // have a cents component (e.g. $195.07), so a value that is:
        //   (a) a whole-number integer with no decimal part, AND
        //   (b) exactly equal to the computed usage
        // is a mis-parse — null it out.  A real charge like $140.00 parses to
        // 140 (integer) but will differ from the usage in gallons or kWh, so
        // legitimate integer-valued charges are NOT affected by this guard.
        if (Number.isInteger(charge) && usage != null && charge === usage) {
          return { prevRead, currRead, usage, charge: null };
        }
        return { prevRead, currRead, usage, charge };
      };

      // -----------------------------------------------------------------
      // Accumulate fields across all charge lines
      // -----------------------------------------------------------------

      // Electric
      const elMeters = []; // one entry per EL - ELECTRIC row
      let elFranchiseFee = null;
      let fuelAdjCharge = null; // signed (may be negative)

      // Sewer
      let swPrevRead = null,
        swCurrRead = null,
        swUsage = null,
        swCharge = null;
      let swFranchiseFee = null;

      // Water
      let waPrevRead = null,
        waCurrRead = null,
        waUsage = null,
        waCharge = null;
      let waDebtPmt = null;
      let waFranchiseFee = null;

      // OCR frequently garbles the separator between charge code and label.
      // Real format: "SW - SEWER" / "WA - WATER" / "EL - ELECTRIC"
      // OCR produces: "SW ~- SEWER", "sw \xa0 SEWER", "WA ~ WATER",
      //   "WA =~ DEBT PMT", "WwA \xa0 WATER", "EL - HELECTRIC", "S5W - FRANCHISE FRE"
      // All patterns below use inline regex literals with [\s\xa0\xE2—–~=|\-]{1,6} as
      // the tolerant separator (spaces, NBSP, tilde, equals, pipe, dash, 1-5 chars).

      for (const rawLine of lines) {
        const ln = rawLine.trim();
        if (!ln) continue;

        // ── Electric commodity lines ──
        // EL - ELECTRIC (may appear 2-3 times for multi-meter accounts)
        // OCR variant: "EL - HELECTRIC" (extra H inserted before ELECTRIC)
        if (/^EL[\s\xa0\xE2—–~=|\-]{1,6}H?ELECTRIC/i.test(ln) && !/FRANCHISE/i.test(ln)) {
          const m = _parseMeteredLine(ln.replace(/^EL[\s\xa0\xE2—–~=|\-]{1,6}H?ELECTRIC\s*/i, ''));
          if (m.charge != null) elMeters.push(m);
          continue;
        }

        // EL - FUEL ADJUSTMENT (older format uses EL prefix instead of FA)
        if (/^EL[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ/i.test(ln)) {
          // Capture the signed charge amount
          const raw = ln
            .replace(/^EL[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ(?:USTMENT)?\s*/i, '')
            .trim()
            .replace(/[–—−]/g, '-'); // normalize unicode dashes to ASCII minus
          // Find the last decimal-looking token (handles trailing minus)
          const m = raw.match(/(-?[\d,]+\.\d{2}-?|-\.[\d]+|\.\d{2})\s*$/);
          if (m) {
            let v = m[1];
            const trailingMinus = v.endsWith('-');
            if (trailingMinus) v = v.slice(0, -1);
            fuelAdjCharge = parseFloat(v.replace(/,/g, ''));
            if (trailingMinus && fuelAdjCharge > 0) fuelAdjCharge = -fuelAdjCharge;
          }
          continue;
        }

        // FA - FUEL ADJUSTMENT (standard prefix for fuel adj)
        if (/^FA[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ/i.test(ln)) {
          const raw = ln
            .replace(/^FA[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ(?:USTMENT)?\s*/i, '')
            .trim()
            .replace(/[–—−]/g, '-'); // normalize unicode dashes to ASCII minus
          const m = raw.match(/(-?[\d,]+\.\d{2}-?|-\.[\d]+|\.\d{2})\s*$/);
          if (m) {
            let v = m[1];
            const trailingMinus = v.endsWith('-');
            if (trailingMinus) v = v.slice(0, -1);
            fuelAdjCharge = parseFloat(v.replace(/,/g, ''));
            if (trailingMinus && fuelAdjCharge > 0) fuelAdjCharge = -fuelAdjCharge;
          }
          continue;
        }

        // EL/GH - FRANCHISE FEE (electric franchise — old format uses GH)
        // OCR variants of "EL": "EI", "E1", "EI." (letter I or digit 1 substituted
        // for L, with optional trailing period). Match E followed by L/I/1 plus
        // optional dot, to catch all common OCR garbles of the EL prefix.
        // Also catches "S5W - FRANCHISE FRE" (OCR of "SW - FRANCHISE FEE") here
        // only if code is EL/EI/E1/GH; S5W/SW franchise handled under sewer below.
        if (/^(?:E[LlIi1]\.?|GH)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(ln)) {
          const raw = ln.replace(/^(?:E[LlIi1]\.?|GH)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE\s+FEE?\s*/i, '').trim();
          // Drop trailing anchor so OCR noise chars after the amount still match.
          const m = raw.match(/([\d,]+\.\d{2})/);
          if (m) elFranchiseFee = (elFranchiseFee || 0) + parseFloat(m[1].replace(/,/g, ''));
          continue;
        }

        // ── Sewer commodity lines ──
        // SW - SEWER (metered) — sum all SW - SEWER rows (some accounts have
        // multiple sewer meters; exclude FRANCHISE lines, handled below).
        // OCR variants: "SW ~- SEWER", "sw \xa0 SEWER", "S5W - SEWER"
        // Code may OCR as "SW", "sw", or "S5W" (digit 5 for W).
        if (/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}SEWER/i.test(ln) && !/FRANCHISE/i.test(ln)) {
          const parsed = _parseMeteredLine(ln.replace(/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}SEWER\s*/i, ''));
          if (parsed.charge != null) {
            // Capture reads from the first row; subsequent rows only add to totals.
            if (swCharge === null) {
              swPrevRead = parsed.prevRead;
              swCurrRead = parsed.currRead;
            }
            swUsage = (swUsage || 0) + (parsed.usage || 0);
            swCharge = (swCharge || 0) + parsed.charge;
          }
          continue;
        }

        // SW - FRANCHISE FEE (sewer franchise)
        // OCR variants: "S5W - FRANCHISE FRE", "SW ~ FRANCHISE FEE"
        if (/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(ln)) {
          const raw = ln.replace(/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE\s+FEE?\s*/i, '').trim();
          // Drop trailing anchor so OCR noise chars after the amount still match.
          const m = raw.match(/([\d,]+\.\d{2})/);
          if (m && swFranchiseFee === null) swFranchiseFee = parseFloat(m[1].replace(/,/g, ''));
          continue;
        }

        // ── Water commodity lines ──
        // WA - WATER (metered — NOT water debt, meter debt, or franchise)
        // Sum all WA - WATER rows so multi-meter accounts (e.g. main + sub-meter)
        // are totalled correctly.  Debt and franchise lines are excluded by the
        // DEBT|METER|FRANCHISE guard and handled in their own branches below.
        // OCR variants: "WA \xa0 WATER", "WA ~ WATER", "WA \xa0- WATER", "WwA \xa0 WATER"
        // Code "WA" may OCR as "WwA" (doubled w) — match [Ww]{1,2}[Aa].
        if (/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER/i.test(ln) && !/DEBT|METER|FRANCHISE/i.test(ln)) {
          const parsed = _parseMeteredLine(
            ln.replace(/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER\s*/i, '').replace(/\s*\|\s*$/, ''),
          );
          if (parsed.charge != null) {
            // Capture reads from the first row; subsequent rows only add to totals.
            if (waCharge === null) {
              waPrevRead = parsed.prevRead;
              waCurrRead = parsed.currRead;
            }
            waUsage = (waUsage || 0) + (parsed.usage || 0);
            waCharge = (waCharge || 0) + parsed.charge;
          }
          continue;
        }

        // WA - DEBT PMT or WA - METER DEBT PMT (water debt payment fee)
        // OCR variants: "WA \xa0 DEBT PMT", "WA =~ DEBT PMT"
        if (/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}(?:METER\s+)?DEBT\s+PMT/i.test(ln)) {
          const raw = ln
            .replace(/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}(?:METER\s+)?DEBT\s+PMT\s*/i, '')
            .replace(/\s*[|i]\s*$/, '')
            .trim();
          // Drop trailing anchor so OCR noise chars (H, ;, etc.) after the amount still match.
          const m = raw.match(/([\d,]+\.\d{2})/);
          if (m && waDebtPmt === null) waDebtPmt = parseFloat(m[1].replace(/,/g, ''));
          continue;
        }

        // WA - WATER DEBT PMT (older format label variant)
        if (/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER\s+DEBT\s+PMT/i.test(ln)) {
          const raw = ln.replace(/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER\s+DEBT\s+PMT\s*/i, '').trim();
          // Drop trailing anchor so OCR noise chars after the amount still match.
          const m = raw.match(/([\d,]+\.\d{2})/);
          if (m && waDebtPmt === null) waDebtPmt = parseFloat(m[1].replace(/,/g, ''));
          continue;
        }

        // WA/HA - FRANCHISE FEE (water franchise — old format uses HA)
        // OCR variants: "WA -\xa0 FRANCHISE FEE", "WA \xa0 FRANCHISE FEE"
        if (/^(?:[Ww]{1,2}[Aa]|HA)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(ln)) {
          const raw = ln
            .replace(/^(?:[Ww]{1,2}[Aa]|HA)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE\s+FEE?\s*/i, '')
            .replace(/\s*\|\s*$/, '')
            .trim();
          // Drop trailing anchor so OCR noise chars (;, H, etc.) after the amount still match.
          const m = raw.match(/([\d,]+\.\d{2})/);
          if (m && waFranchiseFee === null) waFranchiseFee = parseFloat(m[1].replace(/,/g, ''));
          continue;
        }
      }

      // ── Prefix-stripped fallback ──
      // On some scanned pages Tesseract OCR drops the two-letter commodity
      // code (EL, SW, WA) from every charge line, producing lines like:
      //   "— ELECTRIC  415360  417400  2040"
      //   "~ FUEL ADJUSTMENT"
      //   "— FRANCHISE FEE"
      //   "— SEWER  1999992  2001712  1721"
      //   "— WATER  19992992  2001712  1721"
      //   "— METER DEBT PMT"
      // These fail ALL patterns in the main loop above because every pattern
      // requires the prefix. This fallback runs ONLY when the main loop found
      // nothing and maps charge lines by keyword order instead of prefix code.
      if (elMeters.length === 0 && swCharge === null && waCharge === null) {
        // Gather lines that look like prefix-stripped charge lines:
        // Start with "—", "–", "~" (OCR of "—") followed by a known keyword.
        const _pfxStrippedLines = lines
          .map((l) => l.trim())
          .filter((l) =>
            /^[-–~—]\s*(ELECTRIC|SEWER|WATER|FRANCHISE\s+FEE|FUEL\s+ADJ(?:USTMENT)?|(?:METER\s+)?DEBT\s+PMT)/i.test(l),
          );

        if (_pfxStrippedLines.length > 0) {
          for (const sl of _pfxStrippedLines) {
            // Strip the leading dash/tilde separator
            const rest = sl.replace(/^[-–~—]\s*/, '').trim();

            if (/^ELECTRIC/i.test(rest) && !/FRANCHISE/i.test(rest)) {
              const body = rest.replace(/^ELECTRIC\s*/i, '');
              const m = _parseMeteredLine(body);
              if (m.charge != null) elMeters.push(m);
            } else if (/^FUEL\s+ADJ/i.test(rest) && fuelAdjCharge === null) {
              const body = rest
                .replace(/^FUEL\s+ADJ(?:USTMENT)?\s*/i, '')
                .trim()
                .replace(/[–—−]/g, '-'); // normalize unicode dashes to ASCII minus
              const mv = body.match(/(-?[\d,]+\.\d{2}-?)/);
              if (mv) {
                let v = mv[1];
                const trailingMinus = v.endsWith('-');
                if (trailingMinus) v = v.slice(0, -1);
                fuelAdjCharge = parseFloat(v.replace(/,/g, ''));
                if (trailingMinus && fuelAdjCharge > 0) fuelAdjCharge = -fuelAdjCharge;
              }
            } else if (/^FRANCHISE\s+FEE/i.test(rest)) {
              // Attribute to the most recently seen metered commodity so far in this
              // pass. We scan lines in order, so accumulate under the last seen type.
              const body = rest.replace(/^FRANCHISE\s+FEE\s*/i, '').trim();
              const mv = body.match(/([\d,]+\.\d{2})/);
              if (mv) {
                const fv = parseFloat(mv[1].replace(/,/g, ''));
                // Determine which commodity the franchise fee belongs to by looking
                // at what was detected immediately before it in _pfxStrippedLines.
                const slIdx = _pfxStrippedLines.indexOf(sl);
                let lastCommodity = null;
                for (let pi = slIdx - 1; pi >= 0; pi--) {
                  const prev = _pfxStrippedLines[pi].replace(/^[-–~]\s*/, '');
                  if (/^ELECTRIC/i.test(prev)) {
                    lastCommodity = 'EL';
                    break;
                  }
                  if (/^SEWER/i.test(prev)) {
                    lastCommodity = 'SW';
                    break;
                  }
                  if (/^WATER/i.test(prev)) {
                    lastCommodity = 'WA';
                    break;
                  }
                }
                if (lastCommodity === 'EL') elFranchiseFee = (elFranchiseFee || 0) + fv;
                else if (lastCommodity === 'SW' && swFranchiseFee === null) swFranchiseFee = fv;
                else if (lastCommodity === 'WA' && waFranchiseFee === null) waFranchiseFee = fv;
                // If we can't determine commodity, default to most recently seen type
                else if (elMeters.length > 0) elFranchiseFee = (elFranchiseFee || 0) + fv;
              }
            } else if (/^(?:METER\s+)?DEBT\s+PMT/i.test(rest) && waDebtPmt === null) {
              const body = rest.replace(/^(?:METER\s+)?DEBT\s+PMT\s*/i, '').trim();
              const mv = body.match(/([\d,]+\.\d{2})/);
              if (mv) waDebtPmt = parseFloat(mv[1].replace(/,/g, ''));
            } else if (/^SEWER/i.test(rest) && !/FRANCHISE/i.test(rest)) {
              const body = rest.replace(/^SEWER\s*/i, '');
              const m = _parseMeteredLine(body);
              if (m.charge != null) {
                if (swCharge === null) {
                  swPrevRead = m.prevRead;
                  swCurrRead = m.currRead;
                }
                swUsage = (swUsage || 0) + (m.usage || 0);
                swCharge = (swCharge || 0) + m.charge;
              }
            } else if (/^WATER/i.test(rest) && !/DEBT|METER|FRANCHISE/i.test(rest)) {
              const body = rest.replace(/^WATER\s*/i, '');
              const m = _parseMeteredLine(body);
              if (m.charge != null) {
                if (waCharge === null) {
                  waPrevRead = m.prevRead;
                  waCurrRead = m.currRead;
                }
                waUsage = (waUsage || 0) + (m.usage || 0);
                waCharge = (waCharge || 0) + m.charge;
              }
            }
          }
        }
      }

      // ── Split-column fallback ──
      // Real scanned OCR often renders the bill as two separate columns:
      //   Left column:  charge labels on their own lines (no numbers)
      //   Right column: data rows on their own lines (no labels)
      //
      // In this layout, "TO CITY HALL" or "TO.CITY HALL" introduces the
      // right-column data block.  Each metered commodity (EL, SW, WA) gets
      // exactly one data row in the same order they appear in the label list.
      // Non-metered lines (FRANCHISE FEE, FUEL ADJ, DEBT PMT) do NOT get
      // data rows in this block — they may appear as standalone single-value
      // lines immediately after their metered peers.
      //
      // Data row format (last token is always the charge):
      //   "2280 349.59"       → usage=2280, charge=349.59
      //   "15036 201.09"      → usage=15036, charge=201.09
      //   "prev curr charge"  → prevRead, currRead, charge
      //
      // This fallback only runs when the first-pass label+data-on-same-line
      // loop found zero metered charges.
      if (elMeters.length === 0 && swCharge === null && waCharge === null) {
        // Detect which metered labels appear in the page, in order
        const _meteredLabels = []; // 'EL' | 'SW' | 'WA'
        for (const rawLine of lines) {
          const t = rawLine.trim();
          if (!t) continue;
          if (/^EL[\s\xa0\xE2—–~=|\-]{1,6}H?ELECTRIC/i.test(t) && !/FRANCHISE/i.test(t)) {
            _meteredLabels.push('EL');
          } else if (/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}SEWER/i.test(t) && !/FRANCHISE/i.test(t)) {
            _meteredLabels.push('SW');
          } else if (/^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER/i.test(t) && !/DEBT|METER|FRANCHISE/i.test(t)) {
            _meteredLabels.push('WA');
          }
          // Also catch garbled "FA ~ FUR, ADJUSTMENT" (OCR of "FA - FUEL ADJUSTMENT")
          // These do not add a metered label but set a flag for later extraction
          if (
            (/^FA[\s\xa0\xE2—–~=|\-]{1,6}FUR/i.test(t) ||
              /^FA[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ/i.test(t) ||
              /^EL[\s\xa0\xE2—–~=|\-]{1,6}FUR/i.test(t) ||
              /^EL[\s\xa0\xE2—–~=|\-]{1,6}FUEL\s+ADJ/i.test(t)) &&
            fuelAdjCharge === null
          ) {
            // Will be extracted from standalone line after metered block
          }
        }

        // Find the right-column data block.  It starts after "TO CITY HALL"
        // (or "TO-CITY HALL") and ends at "COPY ONLY", "PAID" (standalone),
        // or "FOR AFTER HOURS".  Do NOT use "ACCOUNT IS" as a terminator —
        // "ACCOUNT IS BANK PAY" can appear inside the data block on some pages.
        // Use a simple string search to avoid lazy-quantifier early-stop issues.
        let _dataBlock = null;
        const _toChIdx = page.search(/TO[.\-]?\s*CITY[\s\-]+HALL/i);
        if (_toChIdx >= 0) {
          const _afterToCh = page.substring(_toChIdx);
          const _endMatch = _afterToCh.search(/\n\s*(?:PAID\b|COPY\s+ONLY|FOR\s+AFTER)/i);
          _dataBlock = _endMatch >= 0 ? _afterToCh.substring(0, _endMatch) : _afterToCh.substring(0, 400);
        }

        if (_meteredLabels.length > 0 && _dataBlock) {
          // Split data lines into two lists:
          //   _meteredDataLines  — have at least one integer token (meter reads/usage)
          //   _singleChargeLines — only a decimal, no integers (franchise fee, fuel adj, debt)
          // This separation prevents standalone fee lines from being mis-mapped to
          // metered labels when they appear interleaved (e.g. EL-charge, EL-fee, SW-charge).
          const _allDataLines = _dataBlock
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(
              (l) =>
                /[\d,]+\.\d{2}/.test(l) &&
                !/account|address|service|city|due date|bank pay|assistance|payments|www\.|echecks/i.test(l),
            );
          const _meteredDataLines = _allDataLines.filter((l) => {
            const toks = _tokens(l);
            return toks.slice(0, -1).some((n) => Number.isInteger(n) && n >= 0);
          });
          const _singleChargeLines = _allDataLines.filter((l) => /^[\d,]+\.\d{2}$/.test(l));

          // Map metered data lines (those with integer meter reads) to metered labels
          for (let idx = 0; idx < _meteredLabels.length && idx < _meteredDataLines.length; idx++) {
            const label = _meteredLabels[idx];
            const dline = _meteredDataLines[idx];
            const toks = _tokens(dline);
            if (toks.length < 1) continue;
            const charge = toks[toks.length - 1];
            const intToks = toks.slice(0, -1).filter((n) => Number.isInteger(n) && n >= 0);
            let prevR = null,
              currR = null,
              usageV = null;
            if (intToks.length >= 3) {
              prevR = intToks[intToks.length - 3];
              currR = intToks[intToks.length - 2];
              usageV = intToks[intToks.length - 1];
            } else if (intToks.length === 2) {
              prevR = intToks[0];
              currR = intToks[1];
              usageV = Math.abs(currR - prevR);
            } else if (intToks.length === 1) {
              usageV = intToks[0];
            }

            if (label === 'EL') {
              elMeters.push({ prevRead: prevR, currRead: currR, usage: usageV, charge });
            } else if (label === 'SW') {
              swPrevRead = prevR;
              swCurrRead = currR;
              swUsage = usageV;
              swCharge = charge;
            } else if (label === 'WA') {
              waPrevRead = prevR;
              waCurrRead = currR;
              waUsage = usageV;
              waCharge = charge;
            }
          }

          // Map standalone single-charge lines to non-metered labels in order.
          // Non-metered labels: EL franchise, fuel adj, SW franchise, WA debt, WA franchise.
          const _nonMeteredLabels = [];
          for (const rawLine of lines) {
            const t = rawLine.trim();
            if (!t) continue;
            if (/^(?:EL|GH)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(t) || /^SE\s+(?:PEE|FEE)$/i.test(t)) {
              _nonMeteredLabels.push('EL_FRAN');
            } else if (/^(?:FA|EL)[\s\xa0\xE2—–~=|\-]{1,6}(?:FUEL\s+ADJ|FUR)/i.test(t)) {
              _nonMeteredLabels.push('FA');
            } else if (/^[Ss][W5w][\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(t)) {
              _nonMeteredLabels.push('SW_FRAN');
            } else if (
              /^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}(?:METER\s+)?DEBT\s+PMT/i.test(t) ||
              /^[Ww]{1,2}[Aa][\s\xa0\xE2—–~=|\-]{1,6}WATER\s+DEBT\s+PMT/i.test(t)
            ) {
              _nonMeteredLabels.push('WA_DEBT');
            } else if (/^(?:[Ww]{1,2}[Aa]|HA)[\s\xa0\xE2—–~=|\-]{1,6}FRANCHISE/i.test(t)) {
              _nonMeteredLabels.push('WA_FRAN');
            }
          }
          if (_nonMeteredLabels.length === _singleChargeLines.length) {
            for (let idx = 0; idx < _nonMeteredLabels.length; idx++) {
              const label = _nonMeteredLabels[idx];
              const v = parseFloat(_singleChargeLines[idx].replace(/,/g, ''));
              if (isNaN(v)) continue;
              if (label === 'EL_FRAN') elFranchiseFee = (elFranchiseFee || 0) + v;
              else if (label === 'FA' && fuelAdjCharge === null) fuelAdjCharge = v;
              else if (label === 'SW_FRAN' && swFranchiseFee === null) swFranchiseFee = v;
              else if (label === 'WA_DEBT' && waDebtPmt === null) waDebtPmt = v;
              else if (label === 'WA_FRAN' && waFranchiseFee === null) waFranchiseFee = v;
            }
          }
        }
      }

      // ── Sewer-only prefix-stripped fallback ──
      // FIX(2026-06-11): Pages like Collins Sport (p.8) have "WA — WATER" (matched
      // above) but the sewer line appears as "—~ SEWER" with no SW prefix.  The
      // main prefix-stripped fallback at line ~7390 is gated on ALL THREE being null,
      // so it never runs when waCharge was already found.  This extra scan runs
      // unconditionally when swCharge is still null, catching the prefix-stripped
      // sewer line even when water was already captured.
      if (swCharge === null) {
        for (const _sl of lines) {
          const _ln = _sl.trim();
          if (!_ln) continue;
          if (/^[-–~—]\s*SEWER\b/i.test(_ln) && !/FRANCHISE/i.test(_ln)) {
            const _body = _ln.replace(/^[-–~—]\s*SEWER\s*/i, '');
            const _m = _parseMeteredLine(_body);
            if (_m.charge != null) {
              swPrevRead = _m.prevRead;
              swCurrRead = _m.currRead;
              swUsage = _m.usage;
              swCharge = _m.charge;
            }
            break;
          }
        }
      }

      // ── Sum electric meters ──
      const totalKwh = elMeters.reduce((sum, m) => sum + (m.usage || 0), 0);
      const totalElCharge = elMeters.reduce((sum, m) => sum + (m.charge || 0), 0);
      // Use first meter's reads for StartRead/EndRead (primary meter).
      const elPrevRead = elMeters[0]?.prevRead || null;
      const elCurrRead = elMeters[0]?.currRead || null;

      // ── Guard: no charge data at all means we couldn't parse the page ──
      if (elMeters.length === 0 && swCharge === null && waCharge === null) return null;

      // ── Build shared account fields ──
      // If P5 normalized a garbled OCR account number, stamp the flag so the
      // UI can warn the user that the account number was guessed and may need
      // verification. _p5RawAcct holds the original garbled string from OCR.
      // FIX(2026-06-11): When AccountNumber is null (OCR too garbled for P5 to
      // resolve), _accountFromAddress=true means this page is keyed by ServiceAddress
      // instead of an account number. Never inherit another page's account number.
      const _acctOCRNormalized = _p5RawAcct != null;
      const shared = {
        UtilityCompany: 'City of Baldwin City',
        CustomerName,
        AccountNumber,
        ServiceAddress,
        BillDate,
        BillingPeriodStart,
        BillingPeriodEnd,
        NumberOfDays: null,
        RateSchedule: null,
        MeterNumber: null,
        ...(_acctOCRNormalized ? { _accountOCRNormalized: true, _accountOCRRaw: _p5RawAcct } : {}),
        ...(_accountFromAddress ? { _accountFromAddress: true } : {}),
        ...(_dateReconstructed.length > 0 ? { _date_reconstructed: _dateReconstructed } : {}),
        // FIX(2026-07-02, item 219e6828): plausibility flag consumed by
        // bill-analysis.js _bldgName to decide whether ServiceAddress is
        // safe to show as a chip label (see _looksLikeAddress above).
        _addressPlausible: _looksLikeAddress(ServiceAddress),
      };

      const bills = [];

      // ── Electric bill ──
      if (elMeters.length > 0 && totalElCharge > 0) {
        const elTotal = totalElCharge + (elFranchiseFee || 0) + (fuelAdjCharge || 0);
        bills.push({
          ...shared,
          Commodity: 'Electric',
          StartRead: elPrevRead,
          EndRead: elCurrRead,
          kWh: totalKwh || null,
          kW: null,
          ElectricCharge: Math.round(totalElCharge * 100) / 100,
          FranchiseFee: elFranchiseFee || null,
          FuelAdjustment: fuelAdjCharge || null,
          _electricMeterCount: elMeters.length,
          TotalCurrentCharges: Math.round(elTotal * 100) / 100,
          TotalAmountDue: TotalAmountDue || null,
        });
      }

      // ── FIX(2026-06-02): Usage sanity guard for OCR-inflated meter reads ──
      // Real OCR occasionally inserts a leading '1' before a meter read,
      // turning e.g. 176989 into 1769289 (7 digits vs 6 digits) and producing
      // computed usages of 1,500,000+ gallons.  Guard: if usage > 500,000 gal
      // for a monthly bill, null it out and flag _usageSuspect on the output.
      // A legitimate monthly max for any single account is well under 500,000.
      // Also null usage when prevRead and currRead have a 1-digit-count gap AND
      // removing the leading digit of currRead closely matches prevRead (OCR
      // leading-digit insertion pattern).
      const _checkWaterUsageSuspect = (prevRead, currRead, usage) => {
        if (usage == null) return false;
        if (usage > 500000) return true;
        // Digit-count mismatch check: only for large reads (>= 100,000) where an OCR
        // leading-'1' insertion would always produce an implausibly large reading.
        // Restricting to prevRead >= 100,000 avoids false positives on small meters
        // (e.g. prevRead=100 → currRead=1100 is a legitimate 1,000-gal usage).
        if (prevRead != null && currRead != null && prevRead >= 100000) {
          const prevDigits = String(Math.floor(Math.abs(prevRead))).length;
          const currDigits = String(Math.floor(Math.abs(currRead))).length;
          if (currDigits - prevDigits === 1) {
            const withoutLeading = parseInt(String(Math.floor(currRead)).slice(1));
            if (withoutLeading > 0 && Math.abs(withoutLeading - prevRead) / prevRead < 0.2) return true;
          }
        }
        return false;
      };

      const _waUsageSuspect = _checkWaterUsageSuspect(waPrevRead, waCurrRead, waUsage);
      const _swUsageSuspect = _checkWaterUsageSuspect(swPrevRead, swCurrRead, swUsage);
      if (_waUsageSuspect) waUsage = null;
      if (_swUsageSuspect) swUsage = null;
      // ── FIX(2026-06-19): Bug B — null integer charge when water/sewer usage is suspect ──
      // When OCR inflates a meter read (e.g. inserts a leading digit turning
      // 1999992 into 19992992), the computed usage explodes to millions and
      // _waUsageSuspect fires.  The same mis-parsed line also contributes a
      // "charge" that is an integer — the actual usage value from the bill
      // (e.g. 1721 gallons) with no cents component.  Real dollar charges
      // always have a fractional part; a whole-number integer charge on a
      // usage-suspect line is the same OCR-drop-decimal mis-parse as Bug A.
      if (_waUsageSuspect && waCharge != null && Number.isInteger(waCharge)) waCharge = null;
      if (_swUsageSuspect && swCharge != null && Number.isInteger(swCharge)) swCharge = null;

      // ── FIX(2026-06-02): Shared-meter water/sewer mismatch correction ──
      // Water and sewer share the same physical meter so their usage should
      // match.  When both are present and diverge by ~10x (ratio 8-15), a
      // column mis-parse has occurred.  Prefer the water usage for sewer in
      // that case and record _swUsageFromWater on the bill for traceability.
      // Only applies when water usage survived the sanity check above.
      let _swUsageFromWater = false;
      if (waUsage != null && swUsage != null && swUsage !== 0 && waUsage !== 0) {
        const _ratio = Math.max(waUsage, swUsage) / Math.min(waUsage, swUsage);
        if (_ratio >= 8 && _ratio <= 15) {
          swUsage = waUsage;
          _swUsageFromWater = true;
        }
      }

      // ── Water bill ──
      if (waCharge != null && waCharge !== 0) {
        const waTotal = waCharge + (waDebtPmt || 0) + (waFranchiseFee || 0);
        bills.push({
          ...shared,
          Commodity: 'Water',
          StartRead: waPrevRead,
          EndRead: waCurrRead,
          WaterUsage: waUsage || null,
          ...(_waUsageSuspect ? { _usageSuspect: true } : {}),
          WaterCharge: waCharge,
          WaterDebtPayment: waDebtPmt || null,
          WaterFranchiseFee: waFranchiseFee || null,
          TotalCurrentCharges: Math.round(waTotal * 100) / 100,
          TotalAmountDue: TotalAmountDue || null,
        });
      }

      // ── Sewer bill ──
      if (swCharge != null && swCharge !== 0) {
        // If sewer usage didn't parse but water did, share the water reads
        // (they share the same physical meter).
        if (!swUsage && waUsage) swUsage = waUsage;
        const swTotal = swCharge + (swFranchiseFee || 0);
        bills.push({
          ...shared,
          Commodity: 'Sewer',
          StartRead: swPrevRead || waPrevRead,
          EndRead: swCurrRead || waCurrRead,
          SewerUsage: swUsage || null,
          ...(_swUsageSuspect ? { _usageSuspect: true } : {}),
          ...(_swUsageFromWater ? { _sewerUsageFromWater: true } : {}),
          SewerCharge: swCharge,
          SewerFranchiseFee: swFranchiseFee || null,
          TotalCurrentCharges: Math.round(swTotal * 100) / 100,
          TotalAmountDue: TotalAmountDue || null,
        });
      }

      // Fallback: we detected an account but couldn't match any charges —
      // emit a minimal stub so the user can see the page was read.
      if (bills.length === 0 && TotalAmountDue) {
        bills.push({
          ...shared,
          Commodity: 'Other',
          TotalCurrentCharges: TotalAmountDue,
          TotalAmountDue,
        });
      }

      return bills.length ? bills : null;
    },
  },
  {
    name: 'Propane / Fuel Oil Delivery',
    // Tuned for MFA Oil delivery invoices while keeping the legacy rule
    // name so EXPECTED_FIELDS / validation still match. Multi-invoice
    // PDFs split on page markers or "SALE ... DATE" invoice headers.
    // Subtotal + tax = net due math validates to the cent.
    detect: (t) =>
      /\bpropane\b|\blp\s*gas\b|\bfuel\s*oil\b|\bmfa\s*oil\b/i.test(t) && /net\s*(?:due|delivery)|invoice/i.test(t),
    extractAll: function (t) {
      const hasPages = /%%PAGE_\d+%%/.test(t);
      const pages = hasPages ? _lbg_splitPages(t) : t.split(/(?=SALE\s+\d+\s+DATE)/i);
      const _unmatchedPages = [];
      const results = [];
      pages.forEach((p, i) => {
        const r = this.extract(p);
        if (r !== null) {
          results.push(r);
        } else if (p.trim().length > 50) {
          const pageNums = [...p.matchAll(/%%PAGE_(\d+)%%/g)].map((m) => parseInt(m[1]));
          _unmatchedPages.push({
            pageNums: pageNums.length ? pageNums : [i + 1],
            preview: p.trim().slice(0, 200),
          });
        }
      });
      if (_unmatchedPages.length) results._unmatchedPages = _unmatchedPages;
      return results;
    },
    extract: function (page) {
      // Be lenient — this rule also catches non-MFA propane bills routed
      // here by the detector. Don't gate on MFA-specific strings; let
      // missing fields fall through as null.
      if (!/propane|fuel\s*oil|lp\s*gas/i.test(page) && !/NET\s*DELIVERY/i.test(page)) return null;

      const InvoiceNumber = page.match(/Invoice\s*#?\s*:?\s*(\d{6,10})/i)?.[1] || null;
      // Bounded non-alnum gap (not an enumerated separator class) tolerates
      // OCR gunk between "Customer" and the digits — f1dc5e65.
      const AccountNumber = page.match(/Customer[^0-9A-Za-z\n]{0,6}(\d{4,10})/i)?.[1] || null;
      const BillDate =
        page.match(/Date:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] ||
        page.match(/DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] ||
        null;
      const SaleNumber = page.match(/SALE\s+(\d+)/i)?.[1] || null;

      // "Delivery Address:" label line may carry trailing OCR junk
      // ("ORIGINAL", "DUPLICATE", a stray "|") and/or a blank line before
      // the actual address. Skip past the rest of the label line, then
      // skip any blank lines (\s* eats newlines too), then take the next
      // whole line as the address.
      let ServiceAddress = page.match(/Delivery\s*Address:?[^\n]*\n\s*([^\n]+)/i)?.[1]?.trim() || null;
      if (ServiceAddress) {
        ServiceAddress = ServiceAddress.replace(/\s+(?:Driver:|Sale\s*#).*$/i, '').trim();
        // Guard: if the address line is missing, this regex would otherwise
        // grab the next line ("Driver: ..."). Require it to look like an
        // address — leading street number, or a ", ST" state code.
        if (!/^\d+\s+\S|,\s*[A-Z]{2}\b/i.test(ServiceAddress)) ServiceAddress = null;
      }

      const CustomerName =
        page
          .match(/(USD\s*\d+[^\n]{0,40}?)(?:\s*Date:|\s*Time|\n)/i)?.[1]
          ?.trim()
          ?.replace(/\s+/g, ' ') || null;

      const UtilityCompany =
        page.match(/^(MFA\s*OIL[^\n]*)/im)?.[1]?.trim() ||
        page.match(/^([A-Z][A-Za-z\s&]+(?:Oil|Propane|Fuel|Energy|Gas)[^\n]{0,30})/m)?.[1]?.trim() ||
        'Propane/Fuel Delivery';

      const GallonsDelivered =
        parseFloat(
          page.match(/NET\s*DELIVERY\s+([\d,]+\.?\d*)\s*GALLONS/i)?.[1]?.replace(/,/g, '') ||
            page.match(/([\d,]+\.\d)\s*G\s*PROPANE/i)?.[1]?.replace(/,/g, '') ||
            '0',
        ) || null;

      // The detail line is "<gal> G PROPANE COMMERCIAL $<unit> $<sub>"
      const detailLine = page.match(
        /([\d,]+\.\d)\s*G\s*PROPANE\s*(?:COMMERCIAL|RESIDENTIAL)?\s*\$?([\d,]+\.\d{2,4})\s*\$?([\d,]+\.\d{2})/i,
      );
      const UnitPrice =
        detailLine?.[2]?.replace(/,/g, '') ||
        page.match(/\$([\d]+\.[\d]{4})/)?.[1] ||
        page.match(/Unit\s*Price[:\s]*\$?([\d.]+)/i)?.[1] ||
        null;
      const Subtotal =
        detailLine?.[3]?.replace(/,/g, '') ||
        page.match(/Invoice\s*Sub\s*\$?([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') ||
        null;

      const TotalAmountDue = page.match(/Net\s*Due\s*\$?\s*([\d,]+\.\d{2})/i)?.[1]?.replace(/,/g, '') || null;

      // Tax: the explicit "Tax $X.XX" line on MFA invoices often OCRs
      // with a misread digit (we saw "$202.77" where the true value was
      // "$302.77"). Prefer (NetDue − Subtotal) when it disagrees with
      // the direct read.
      let Tax =
        page.match(/^\s*Tax\s*\$?\s*([\d,]+\.\d{2})/im)?.[1]?.replace(/,/g, '') ||
        page.match(/Tax\s+\$?\s*([\d,]+\.\d{2})(?!\w)/i)?.[1]?.replace(/,/g, '') ||
        '0.00';
      const _sub = parseFloat(Subtotal || 0);
      const _net = parseFloat(TotalAmountDue || 0);
      if (_sub && _net && Math.abs(parseFloat(Tax) + _sub - _net) > 0.02) {
        Tax = (_net - _sub).toFixed(2);
      }

      // Update 81: propane deliveries are single-date events, not
      // billing periods. Emit DeliveryDate instead of BillingPeriodStart/End.
      // Normalize to 4-digit year so "04/29/25" and "01/16/2025" match.
      const _normDate = (d) => {
        if (!d) return null;
        const mm = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (!mm) return d;
        let y = mm[3];
        if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
        return mm[1].padStart(2, '0') + '/' + mm[2].padStart(2, '0') + '/' + y;
      };
      const DeliveryDate = _normDate(BillDate);
      return {
        Commodity: 'Propane',
        UtilityCompany,
        CustomerName,
        AccountNumber,
        InvoiceNumber,
        SaleNumber,
        ServiceAddress,
        DeliveryDate,
        NumberOfDays: '1',
        RateSchedule: null,
        MeterNumber: null,
        FuelType: page.match(/(PROPANE|FUEL\s*OIL|HEATING\s*OIL|DIESEL|KEROSENE)/i)?.[1] || 'Propane',
        GallonsDelivered,
        UnitPrice,
        Subtotal,
        Tax,
        TotalCurrentCharges: TotalAmountDue,
        TotalAmountDue,
      };
    },
  },
  {
    name: 'Generic Utility',
    detect: () => true,
    extract: (t) => ({
      UtilityCompany: t.match(/^([A-Z][A-Za-z &]+(?:Electric|Gas|Energy|Utilities?|Power))/m)?.[1]?.trim() || null,
      AccountNumber: t.match(/account\s*(?:number|#|no\.?)[\s:]*([0-9\-]{6,20})/i)?.[1] || null,
      ServiceAddress: t.match(/(?:service|billing)\s*address[\s:\n]+([^\n]{10,60})/i)?.[1]?.trim() || null,
      BillingPeriodStart:
        t.match(/(?:from|period\s*(?:start|from)|billing\s*from)[\s:]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1] || null,
      BillingPeriodEnd:
        t.match(/(?:to|through|period\s*(?:end|to))[\s:]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1] || null,
      NumberOfDays: t.match(/(\d+)\s*days/i)?.[1] || null,
      kWhConsumed: t.match(/([0-9,]{3,})\s*kwh/i)?.[1]?.replace(/,/g, '') || null,
      PeakDemandKW: t.match(/([0-9.]+)\s*kw\b/i)?.[1] || null,
      NaturalGasTherms: t.match(/([0-9,]+\.?\d*)\s*therms?/i)?.[1]?.replace(/,/g, '') || null,
      TotalAmountDue: t.match(/\$\s*([0-9,]+\.[0-9]{2})\b(?!.*\$\s*[0-9,]+\.[0-9]{2})/s)?.[1] || null,
      RateSchedule: t.match(/rate\s*(?:schedule|code)?[\s:]*([A-Z][A-Z0-9\-]{1,10})/i)?.[1] || null,
      MeterNumber: t.match(/meter\s*(?:number|#|no)?[\s:]*([A-Z0-9\-]{4,20})/i)?.[1] || null,
    }),
  },
];
function scoreExtraction(d) {
  return Object.values(d).filter((v) => v !== null && v !== '').length;
}
