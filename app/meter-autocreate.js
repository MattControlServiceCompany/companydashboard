// ===== Roster-driven auto-create missing meters (c8880ce7, 2026-09-13) =====
//
// Matt's intent: "I do not want to have to create the meters, I want the
// site to create them." This module reads the existing OneDrive meter/
// account roster (xlsx/csv, same file the customer already maintains),
// resolves each unassigned Saved Bill to the EXISTING building it belongs
// to, and proposes the missing meter for the user to review before anything
// is written. See docs/dashboardlogic.md for the full WHY entry and
// AI/_context/backlog/stages/c8880ce7/plan.md for the design this follows.
//
// Hard rules this file must never violate:
//   - Never creates a new BUILDING — only adds meters to buildings that
//     already exist (§3 of the plan: all needed Baker buildings already
//     exist; a wrong-building auto-create risks the same misattachment
//     class as the Louisburg Maintenance Building incident 11e47d64/9de73981).
//   - Never silently creates a meter or silently assigns a bill — every
//     write happens only after the user reviews the plan in the modal and
//     clicks the final confirm button.
//   - New meters always default baselineInclude:false (never auto-included
//     in baseline/savings calcs).
//   - Never guesses an ambiguous identity (the KGS meter-number-match/
//     different-account case) — that is surfaced as a duplicate needing an
//     explicit user choice, never auto-merged and never auto-created.
//   - Does not touch findMeterMatch(), _addressSimilarity(), or
//     autoAssignAllSavedBills() — those are reused unmodified.

let _macState = null;

// ---------------------------------------------------------------------
// Pure engine functions — no DOM, no localStorage. Exposed on window so a
// headless test harness can exercise them directly against a fixture.
// ---------------------------------------------------------------------

function _macNormAcct(s) {
  return String(s || '')
    .replace(/[\s\-]/g, '')
    .toLowerCase();
}

// Parse a 2D array of roster data rows (header row already stripped) into
// structured entries. Columns (0-indexed), matching the real Baker roster
// layout (plan §2): A name, B sqft, C addr, D Baldwin service addr,
// E Baldwin account#, F KGS service addr, G KGS account#, H KGS meter#,
// I Constellation service addr, J Constellation account#.
function parseRosterRows(rows2D) {
  const out = [];
  const splitSlash = (s) =>
    String(s || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
  (rows2D || []).forEach((r) => {
    const name = String(r[0] || '').trim();
    if (!name) return;
    const kgsAcctRaw = String(r[6] || '').trim();
    const kgsMeterRaw = String(r[7] || '').trim();
    out.push({
      name,
      sqft: String(r[1] || '').trim(),
      addr: String(r[2] || '').trim(),
      baldwinSvcAddr: String(r[3] || '').trim(),
      baldwinAcct: String(r[4] || '').trim(),
      kgsSvcAddr: String(r[5] || '').trim(),
      kgsAccts: splitSlash(kgsAcctRaw),
      kgsMeters: splitSlash(kgsMeterRaw),
      constellationSvcAddr: String(r[8] || '').trim(),
      constellationAcct: String(r[9] || '').trim(),
    });
  });
  return out;
}

// Resolve one roster row to an EXISTING building. Never creates a building.
// Match order (plan §4.1(b)):
//   1. account already present on some meter in a live building — handles
//      the informal/hedge-named roster rows whose live building name
//      doesn't match the roster text.
//   2. roster name vs live building name (only unambiguous for clean rows).
//   3. unresolved -> null.
function resolveRosterRowToBuilding(row, buildings) {
  const candAccts = [];
  if (row.baldwinAcct) candAccts.push(_macNormAcct(row.baldwinAcct));
  (row.kgsAccts || []).forEach((a) => candAccts.push(_macNormAcct(a)));
  for (const b of buildings || []) {
    for (const m of b.meters || []) {
      const ma = _macNormAcct(m.account);
      if (ma && candAccts.some((ca) => ca && (ca === ma || ca.includes(ma) || ma.includes(ca)))) {
        return b;
      }
    }
  }
  const rn = (row.name || '').trim().toLowerCase();
  if (!rn) return null;
  return (buildings || []).find((b) => (b.name || '').trim().toLowerCase() === rn) || null;
}

// Building-scoped dedupe (plan §4.1(d)) — mirrors the matcher already used
// by _autoCreateMeterAndSaveBill's Step 1/3 (_acctFuzzyMatch + meter-number
// exact, gated by matching commodity).
//   exact: same building already has a meter that fully identity-matches
//     (account fuzzy OR meter# exact) AND commodity matches -> no create
//     needed, autoAssignAllSavedBills() will already route to it.
//   meterOnlyDup: a meter-NUMBER exact match but a DIFFERENT account number
//     (the §3.2 OCR-digit-misread case) -> must be surfaced as a possible
//     duplicate needing an explicit user decision, never silently merged
//     and never silently created as a second meter.
function _macFindExistingMeter(building, account, meterNumber, commodity) {
  const acctN = _macNormAcct(account);
  const meterN = _macNormAcct(meterNumber);
  const commN = String(commodity || '').toLowerCase();
  let exact = null;
  let meterOnlyDup = null;
  for (const m of (building && building.meters) || []) {
    const ma = _macNormAcct(m.account);
    const mm = _macNormAcct(m.meter);
    const mc = (m.commodity || '').toLowerCase();
    const acctHit = !!(acctN && ma && (acctN === ma || acctN.includes(ma) || ma.includes(acctN)));
    const meterHit = !!(meterN && mm && meterN === mm);
    // Deliberate split from _autoCreateMeterAndSaveBill's Step 1 dedupe
    // (which treats acctHit OR meterHit as "already exists, no action"):
    // plan §4.1(d) requires the meter-number-matches-but-account-differs
    // case to surface as a human decision, never a silent skip. So account
    // agreement (with or without a meter# match) is the ONLY "exact, no
    // create needed" case; a meter# match with a DIFFERENT account is
    // always the ambiguous "possible duplicate" case, never silently
    // treated as the same meter.
    if (acctHit && mc === commN) {
      exact = m;
      break;
    }
    if (meterHit && !acctHit && mc === commN) {
      meterOnlyDup = m;
    }
  }
  return { exact, meterOnlyDup };
}

// Main planning engine (plan §4.1). Pure function — takes plain data,
// mutates nothing, returns {willCreate:[], duplicates:[], unresolved:[]}.
//   rosterRows: output of parseRosterRows().
//   buildings: udProj.buildings for the target project.
//   bills: unassigned en_pdf_bills-shaped records, already scoped by the
//     caller to this roster's customer (e.g. filtered by CustomerName).
function buildMeterCreationPlan(rosterRows, buildings, bills) {
  const rowBuildings = (rosterRows || []).map((row) => ({
    row,
    building: resolveRosterRowToBuilding(row, buildings),
  }));

  // Baldwin account implies up to three commodity meters (Electric/Water/
  // Sewer all bill under the same account, plan §3.1/§4.1(a)) — keyed by
  // account only; the commodity comes from the bill itself, not the roster.
  const baldwinIndex = new Map();
  // KGS account implies exactly one Gas meter, split on '/' per row.
  const kgsIndex = new Map();
  rowBuildings.forEach(({ row, building }) => {
    if (row.baldwinAcct) {
      baldwinIndex.set(_macNormAcct(row.baldwinAcct), { row, building });
    }
    (row.kgsAccts || []).forEach((a, i) => {
      kgsIndex.set(_macNormAcct(a), { row, building, meterNumber: (row.kgsMeters || [])[i] || '' });
    });
  });

  const willCreateMap = new Map();
  const duplicates = [];
  const unresolvedMap = new Map();

  (bills || []).forEach((b) => {
    const acct = b.AccountNumber || b.accountNumber || '';
    const acctN = _macNormAcct(acct);
    const commodity = b.Commodity || b.commodity || '';
    const isGas = /gas/i.test(commodity) || /kansas gas|kgs/i.test(b.UtilityCompany || b.utilityCompany || '');

    let entry = null;
    let source = null;
    if (isGas && kgsIndex.has(acctN)) {
      entry = kgsIndex.get(acctN);
      source = 'kgs';
    } else if (baldwinIndex.has(acctN)) {
      entry = baldwinIndex.get(acctN);
      source = 'baldwin';
    }

    const flagUnresolved = (reason) => {
      const key = acctN + '|' + commodity;
      let u = unresolvedMap.get(key);
      if (!u) {
        u = { account: acct, commodity, billIds: [], reason };
        unresolvedMap.set(key, u);
      }
      u.billIds.push(b.id);
    };

    if (!entry) {
      flagUnresolved('account not in roster — cannot auto-create');
      return;
    }
    if (!entry.building) {
      flagUnresolved('roster row has no matching existing building');
      return;
    }

    const meterNumber = source === 'kgs' ? entry.meterNumber : '';
    const { exact, meterOnlyDup } = _macFindExistingMeter(entry.building, acct, meterNumber, commodity);
    if (exact) {
      // Already routable once autoAssignAllSavedBills runs — no create needed.
      return;
    }
    if (meterOnlyDup) {
      const dupKey = entry.building.id + '|' + commodity + '|' + _macNormAcct(meterOnlyDup.meter);
      let d = duplicates.find((x) => x._dupKey === dupKey);
      if (!d) {
        d = {
          _dupKey: dupKey,
          building: entry.building,
          commodity,
          account: acct,
          existingAccount: meterOnlyDup.account,
          meterNumber: meterOnlyDup.meter,
          billIds: [],
        };
        duplicates.push(d);
      }
      d.billIds.push(b.id);
      return;
    }

    const key = entry.building.id + '|' + commodity + '|' + acctN;
    let w = willCreateMap.get(key);
    if (!w) {
      w = {
        building: entry.building,
        commodity,
        account: acct,
        meterNumber,
        maddr: source === 'kgs' ? entry.row.kgsSvcAddr : entry.row.baldwinSvcAddr,
        provider: source === 'kgs' ? 'Kansas Gas Service' : 'City of Baldwin City',
        billIds: [],
      };
      willCreateMap.set(key, w);
    }
    w.billIds.push(b.id);
  });

  return {
    willCreate: Array.from(willCreateMap.values()),
    duplicates,
    unresolved: Array.from(unresolvedMap.values()),
  };
}

if (typeof window !== 'undefined') {
  window._macNormAcct = _macNormAcct;
  window.parseRosterRows = parseRosterRows;
  window.resolveRosterRowToBuilding = resolveRosterRowToBuilding;
  window._macFindExistingMeter = _macFindExistingMeter;
  window.buildMeterCreationPlan = buildMeterCreationPlan;
}

// ---------------------------------------------------------------------
// UI wiring — confirm-before-create modal (plan §4.2). Nothing above this
// line mutates anything; everything below only runs on explicit user action.
// ---------------------------------------------------------------------

function openMeterAutoCreateModal(projId) {
  _macState = { projId, rosterRows: null, plan: null, selectedCreate: {}, dupChoice: {} };
  const dropLabel = document.getElementById('macDropLabel');
  if (dropLabel) dropLabel.textContent = 'Drop the meter/account roster .xlsx or .csv file, or click to browse';
  const input = document.getElementById('macInput');
  if (input) input.value = '';
  const wrap = document.getElementById('macPreviewWrap');
  if (wrap) wrap.style.display = 'none';
  const btn = document.getElementById('macCreateBtn');
  if (btn) btn.style.display = 'none';
  const modal = document.getElementById('macModal');
  if (modal) modal.classList.add('open');
}
window.openMeterAutoCreateModal = openMeterAutoCreateModal;

function closeMeterAutoCreateModal() {
  const modal = document.getElementById('macModal');
  if (modal) modal.classList.remove('open');
  _macState = null;
}
window.closeMeterAutoCreateModal = closeMeterAutoCreateModal;

function handleMeterRosterFile(input) {
  const file = input.files && input.files[0];
  if (!file || !_macState) return;
  const dropLabel = document.getElementById('macDropLabel');
  if (dropLabel) dropLabel.textContent = '⏳ Reading ' + file.name + '…';
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      let rows2D = [];
      const name = file.name.toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const lines = e.target.result
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        for (let i = 1; i < lines.length; i++) rows2D.push(splitCsvLine(lines[i]));
      } else {
        if (typeof XLSX === 'undefined') {
          showToast('Excel library not loaded — try a CSV export instead', 'warn');
          return;
        }
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        rows2D = (arr || []).slice(1).map((r) => r.map((c) => (c === undefined ? '' : String(c))));
      }
      const rosterRows = parseRosterRows(rows2D);
      if (!rosterRows.length) {
        showToast('No roster rows found in file', 'warn');
        return;
      }
      _macState.rosterRows = rosterRows;
      if (dropLabel) dropLabel.textContent = '✓ ' + file.name + ' — click to change';
      _macRunResolve();
    } catch (err) {
      showToast('Error reading roster file: ' + (err.message || err), 'warn');
      console.error('meter roster read error:', err);
    }
  };
  if (file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.txt')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}
window.handleMeterRosterFile = handleMeterRosterFile;

// Runs the read-only resolver pass (§4.1 a-d) and stores the plan for review.
// Does NOT write anything yet.
function _macRunResolve() {
  const st = _macState;
  if (!st || !st.rosterRows) return;
  const projId = st.projId;
  const proj = (typeof projects !== 'undefined' ? projects : []).find((p) => p.id === projId);
  const udProj = getUDProj(projId);
  const buildings = udProj.buildings || [];
  const allBills = sget('en_pdf_bills', []) || [];
  // Scope to this project's customer (v1 gate, plan §4.2 point 1 — Baker-
  // specific trigger is acceptable for v1; here derived from the project
  // name's first word rather than a hardcoded string, so the same modal
  // works for any project whose roster the user uploads).
  const custFrag = (proj && proj.name ? proj.name : '').trim().toLowerCase().split(/\s+/)[0] || '';
  const unassigned = allBills.filter(
    (b) => !b.projId && (!custFrag || (b.CustomerName || b.customerName || '').toLowerCase().includes(custFrag)),
  );
  const plan = buildMeterCreationPlan(st.rosterRows, buildings, unassigned);
  plan.willCreate.forEach((w, i) => {
    w._key = 'c' + i;
    st.selectedCreate[w._key] = true;
  });
  plan.duplicates.forEach((d, i) => {
    d._key = 'd' + i;
    st.dupChoice[d._key] = 'merge';
  });
  st.plan = plan;
  _macRenderPlan();
}

function _macToggleCreate(key, checked) {
  if (_macState) _macState.selectedCreate[key] = checked;
}
window._macToggleCreate = _macToggleCreate;

function _macSetDupChoice(key, val) {
  if (_macState) _macState.dupChoice[key] = val;
}
window._macSetDupChoice = _macSetDupChoice;

function _macRenderPlan() {
  const st = _macState;
  const plan = st && st.plan;
  const wrap = document.getElementById('macPreviewWrap');
  const createBtn = document.getElementById('macCreateBtn');
  if (!plan || !wrap) return;
  wrap.style.display = '';

  const willCreateRows = plan.willCreate
    .map(
      (w) => `<tr>
        <td style="width:28px;text-align:center"><input type="checkbox" checked onchange="_macToggleCreate('${w._key}',this.checked)"></td>
        <td>${_escHtml(w.building.name || w.building.addr || w.building.id)}</td>
        <td>${_escHtml(w.commodity)}</td>
        <td style="font-family:var(--mono)">${_escHtml(w.account)}</td>
        <td style="text-align:right">${w.billIds.length}</td>
      </tr>`,
    )
    .join('');

  const dupRows = plan.duplicates
    .map(
      (d) => `<tr>
        <td>${_escHtml(d.building.name || d.building.addr || d.building.id)}</td>
        <td>${_escHtml(d.commodity)}</td>
        <td style="font-family:var(--mono);font-size:10px">${_escHtml(d.account)} <span style="color:var(--text3)">vs existing</span> ${_escHtml(d.existingAccount)}</td>
        <td style="font-family:var(--mono)">${_escHtml(d.meterNumber)}</td>
        <td style="text-align:right">${d.billIds.length}</td>
        <td style="white-space:nowrap">
          <label style="font-size:11px;display:block"><input type="radio" name="mac-dup-${d._key}" checked onchange="_macSetDupChoice('${d._key}','merge')"> Merge into existing meter</label>
          <label style="font-size:11px;display:block"><input type="radio" name="mac-dup-${d._key}" onchange="_macSetDupChoice('${d._key}','create')"> Create as new meter</label>
        </td>
      </tr>`,
    )
    .join('');

  const unresolvedRows = plan.unresolved
    .map(
      (u) => `<tr>
        <td style="font-family:var(--mono)">${_escHtml(u.account || '—')}</td>
        <td>${_escHtml(u.commodity || '—')}</td>
        <td style="text-align:right">${u.billIds.length}</td>
        <td style="color:var(--text2)">${_escHtml(u.reason)}</td>
      </tr>`,
    )
    .join('');

  wrap.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-weight:700;font-size:12px;margin-bottom:6px">Will create (${plan.willCreate.length} meter${plan.willCreate.length !== 1 ? 's' : ''})</div>
      ${
        plan.willCreate.length
          ? `<div class="card" style="overflow-x:auto"><table class="dtbl" style="width:100%;min-width:520px">
        <thead><tr><th></th><th>Building</th><th>Commodity</th><th>Account</th><th>Bills</th></tr></thead>
        <tbody>${willCreateRows}</tbody></table></div>`
          : '<div style="font-size:12px;color:var(--text2)">None</div>'
      }
    </div>
    <div style="margin-bottom:16px">
      <div style="font-weight:700;font-size:12px;margin-bottom:6px">Possible duplicate — needs your call (${plan.duplicates.length})</div>
      ${
        plan.duplicates.length
          ? `<div class="card" style="overflow-x:auto"><table class="dtbl" style="width:100%;min-width:620px">
        <thead><tr><th>Building</th><th>Commodity</th><th>Account (bill vs existing)</th><th>Meter #</th><th>Bills</th><th>Choice</th></tr></thead>
        <tbody>${dupRows}</tbody></table></div>`
          : '<div style="font-size:12px;color:var(--text2)">None</div>'
      }
    </div>
    <div>
      <div style="font-weight:700;font-size:12px;margin-bottom:6px">Could not resolve (${plan.unresolved.length})</div>
      ${
        plan.unresolved.length
          ? `<div class="card" style="overflow-x:auto"><table class="dtbl" style="width:100%;min-width:480px">
        <thead><tr><th>Account</th><th>Commodity</th><th>Bills</th><th>Reason</th></tr></thead>
        <tbody>${unresolvedRows}</tbody></table></div>`
          : '<div style="font-size:12px;color:var(--text2)">None</div>'
      }
    </div>`;

  if (createBtn) {
    const anyActionable = plan.willCreate.length > 0 || plan.duplicates.length > 0;
    createBtn.style.display = anyActionable ? '' : 'none';
    createBtn.textContent =
      'Create ' + plan.willCreate.length + ' Meter' + (plan.willCreate.length !== 1 ? 's' : '') + ' & Assign Bills';
  }
}

// The only function in this file that mutates utilityData. Runs strictly
// after the user has reviewed the plan and clicked the final confirm
// button in the modal.
async function confirmMeterAutoCreate() {
  const st = _macState;
  if (!st || !st.plan) return;
  // Re-entrancy guard: the confirm button is not disabled until this line
  // runs, so a double-click before the first await resolves would otherwise
  // re-enter this function with the same un-cleared st.plan.willCreate and
  // push a duplicate set of meters, bypassing the dedupe engine entirely.
  if (st._confirming) return;
  st._confirming = true;
  const btn = document.getElementById('macCreateBtn');
  if (btn) btn.disabled = true;

  const projId = st.projId;
  let createdCount = 0;

  try {
    st.plan.willCreate.forEach((w) => {
      if (!st.selectedCreate[w._key]) return;
      const meter = {
        id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        commodity: w.commodity,
        provider: w.provider,
        account: w.account,
        meter: w.meterNumber || '',
        maddr: w.maddr || '',
        inclusive: true,
        // Deliberate deviation from _autoCreateMeterAndSaveBill's live
        // baselineInclude:true default — plan §4.1(e)/§5: per the 2026-09-10
        // standing rule, a newly created meter must never be counted
        // automatically; the user opts it into the baseline afterward.
        baselineInclude: false,
        billUnit: '',
        displayUnit: '',
        bills: [],
      };
      w.building.meters = w.building.meters || [];
      w.building.meters.push(meter);
      createdCount++;
    });

    st.plan.duplicates.forEach((d) => {
      const choice = st.dupChoice[d._key] || 'merge';
      if (choice === 'create') {
        const meter = {
          id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          commodity: d.commodity,
          provider: /gas/i.test(d.commodity) ? 'Kansas Gas Service' : '',
          account: d.account,
          meter: d.meterNumber || '',
          maddr: '',
          inclusive: true,
          baselineInclude: false,
          billUnit: '',
          displayUnit: '',
          bills: [],
        };
        d.building.meters = d.building.meters || [];
        d.building.meters.push(meter);
        createdCount++;
      } else {
        // Merge: additive-only accountAliases entry on the existing meter, the
        // same field findMeterMatch already checks (bill-analysis.js ~5784,
        // fix 8c9c7ccc) — never overwrites the existing account field, never
        // deletes anything.
        const existing = (d.building.meters || []).find(
          (m) =>
            _macNormAcct(m.meter) === _macNormAcct(d.meterNumber) &&
            (m.commodity || '').toLowerCase() === (d.commodity || '').toLowerCase(),
        );
        if (existing) {
          existing.accountAliases = existing.accountAliases || [];
          if (!existing.accountAliases.some((a) => _macNormAcct(a) === _macNormAcct(d.account))) {
            existing.accountAliases.push(d.account);
          }
        }
      }
    });

    saveUtilityData(projId);
    showToast(createdCount + ' meter(s) created — assigning matching bills…');
    if (typeof autoAssignAllSavedBills === 'function') {
      await autoAssignAllSavedBills(projId);
    }
    closeMeterAutoCreateModal();
    if (typeof renderProjSavedBills === 'function') renderProjSavedBills(projId);
    if (typeof renderUDDetail === 'function') renderUDDetail();
  } finally {
    // On success closeMeterAutoCreateModal() already nulled _macState, so
    // this is a no-op; on a thrown error it re-enables the button so the
    // user isn't permanently locked out.
    st._confirming = false;
    if (btn) btn.disabled = false;
  }
}
window.confirmMeterAutoCreate = confirmMeterAutoCreate;
