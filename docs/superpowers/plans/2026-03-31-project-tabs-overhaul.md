# Project Tabs Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken data flow in Energy Graphics and HVAC Load Est tabs, compress the project header, add per-measure rates to Energy Savings, rework District Calendar and Meetings tabs, and add a new Project Dashboard tab with performance summary and calendar.

**Architecture:** All changes are in `energy-department.html` — a single-file vanilla HTML/CSS/JS app (~15k lines) with localStorage data layer. No build tools, no framework. Utility data lives in `utilityData[projId].buildings` accessed via `getUDBldgs(projId)`. Project metadata lives in `projects[]` array accessed via `sget('en_projects')`. The file contains inline CSS at top, HTML modals and layout in middle, and JS functions at bottom.

**Tech Stack:** Vanilla JS/CSS/HTML, localStorage, PDF.js (CDN), jsPDF (CDN), Tesseract.js (CDN)

**Spec:** `docs/superpowers/specs/2026-03-31-project-tabs-overhaul-design.md`

---

## File Map

All changes in one file:

| File | Role |
|------|------|
| `energy-department.html` | All HTML, CSS, and JS changes |
| `dashboardlogic37.md` | Decision log (OneDrive) |

---

## Task 1: Fix Energy Graphics Data Path

The Energy Graphics tab shows "Add utility data..." even when a building has utility data and baseline set. Root cause: it reads `p.buildings` instead of `getUDBldgs(projId)`, and uses wrong field names for commodity/bill fields.

**Files:**
- Modify: `energy-department.html:15671-15770` (`egfxRefresh` function)

- [ ] **Step 1: Fix the building data source**

Find line ~15674 in `egfxRefresh`:
```javascript
const bldgs = p.buildings||[];
```
Replace with:
```javascript
const bldgs = getUDBldgs(projId);
```

- [ ] **Step 2: Fix meter commodity field names**

In `egfxRefresh`, find all occurrences of `m.type==='electric'` and `m.type==='gas'` (around lines 15687-15688). Replace:
```javascript
const isElec = m.type==='electric';
const isGas = m.type==='gas';
```
with:
```javascript
const isElec = m.commodity==='Electric';
const isGas = m.commodity==='Gas';
```

- [ ] **Step 3: Add a 4th EUI card for Total Cost Savings**

Find the three EUI card divs in `renderDetail` (around lines 4078-4098 — the `egfx-blEui`, `egfx-curEui`, `egfx-cbecs` cards). After the CBECS Benchmark card, add:
```html
<div class="card" style="background:var(--s1);padding:14px;text-align:center">
  <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Cost Savings</div>
  <div id="egfx-costSav-${p.id}" style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--green);margin:6px 0">—</div>
  <div id="egfx-costSavSub-${p.id}" style="font-size:11px;color:var(--text2)">vs baseline</div>
</div>
```

Change the grid from 3 cards to 4: update the parent container to `grid-template-columns:repeat(auto-fit,minmax(180px,1fr))` if it uses a fixed 3-column layout.

- [ ] **Step 4: Populate the cost savings card in egfxRefresh**

After the existing EUI card updates (around line 15754), add:
```javascript
const costSavEl = document.getElementById(`egfx-costSav-${projId}`);
const costSavSubEl = document.getElementById(`egfx-costSavSub-${projId}`);
const totalBlCost = blCost.reduce((a,b)=>a+b,0);
let totalCurCost = 0;
if(latestYear && yearData[latestYear]){
  totalCurCost = yearData[latestYear].cost.reduce((a,b)=>a+b,0);
}
if(costSavEl){
  if(totalBlCost>0 && totalCurCost>0){
    const savings = totalBlCost - totalCurCost;
    const pct = (savings/totalBlCost*100);
    costSavEl.textContent = (savings>=0?'':'−') + '$' + Math.abs(Math.round(savings)).toLocaleString();
    costSavEl.style.color = savings>=0 ? 'var(--green)' : 'var(--danger)';
    if(costSavSubEl) costSavSubEl.textContent = pct.toFixed(1)+'% vs baseline';
  } else {
    costSavEl.textContent = 'No baseline data';
    costSavEl.style.fontSize = '14px';
  }
}
```

Also update the existing cards to show "No baseline data" instead of "—" when `blEui===0`:
```javascript
if(blEl) blEl.textContent = blEui>0 ? blEui.toFixed(1) : 'No baseline data';
if(blEl && blEui===0) blEl.style.fontSize = '14px';
```

- [ ] **Step 5: Test and commit**

Open the app in a browser, navigate to a project with utility data (e.g., Field Kindley High School), click the Energy Graphics tab. Verify:
- EUI cards show actual numbers (not dashes)
- Charts render with baseline and year-over-year data
- Cost savings card shows the delta

```bash
cd "C:\Users\Matt Miller\AI\companydashboard"
git add energy-department.html
git commit -m "Fix Energy Graphics data path to use getUDBldgs and correct commodity field names"
```

---

## Task 2: Fix HVAC Load Est Blank Tab

The tab renders blank because `initHvacLoadTab` is called from `sPTab` but the DOM container may not be found. Need to verify the container ID matches and ensure init runs after DOM is ready.

**Files:**
- Modify: `energy-department.html:4062-4065` (tab container HTML)
- Modify: `energy-department.html:4183-4187` (requestAnimationFrame init block)
- Modify: `energy-department.html:13010+` (`initHvacLoadTab` function)

- [ ] **Step 1: Verify container ID and fix the ptab style**

The tab container at line 4062 has `style="padding:0;overflow-y:auto;display:none"`. The `display:none` is redundant (the `.ptab` CSS already handles visibility) and may conflict with `.ptab.active{display:block}`. Remove the inline `display:none`:

Find:
```html
<div id="ptab-hvacload" class="ptab" style="padding:0;overflow-y:auto;display:none">
```
Replace with:
```html
<div id="ptab-hvacload" class="ptab" style="padding:0;overflow-y:auto">
```

- [ ] **Step 2: Add initHvacLoadTab to the requestAnimationFrame init block**

At line 4183, the `requestAnimationFrame` block initializes buildings, equipment, and utility data. The HVAC tab also needs data from utility buildings. But we should NOT init it here (it's not the default tab). Instead, ensure `sPTab` calls it reliably.

Check `sPTab` (line 4198). It already has `if(tab==='hvacload') initHvacLoadTab(p.id);`. The issue is that `initHvacLoadTab` runs before the ptab becomes visible (`.active` is added on line 4200). The `getElementById` inside `initHvacLoadTab` should still find the element even when hidden. But to be safe, wrap the init call in a microtask:

Find in `sPTab`:
```javascript
if(tab==='hvacload')  initHvacLoadTab(p.id);
```
Replace with:
```javascript
if(tab==='hvacload')  requestAnimationFrame(()=>initHvacLoadTab(p.id));
```

- [ ] **Step 3: Add defensive check in initHvacLoadTab**

At the top of `initHvacLoadTab` (line ~13010), verify the function correctly finds the container. The container ID is `hvl-container-${p.id}` in the template (using `p.id` from the `renderDetail` closure), and the function receives `projId`. These should match since `sPTab` passes `p.id`. Add a console log for debugging:

Find:
```javascript
const wrap = document.getElementById('hvl-container-'+projId);
if(!wrap) return;
```
This is correct — if `projId` matches `p.id`, it will find the element. The `display:none` removal in Step 1 should fix the issue.

- [ ] **Step 4: Test and commit**

Open a project, click the HVAC Load Est tab. Verify:
- Building pills appear at top
- Baseline data table renders for the selected building
- Method buttons (Rules of Thumb, Benchmark, Nameplate, Reverse) work
- Calculate button produces results

```bash
git add energy-department.html
git commit -m "Fix HVAC Load Est blank tab by removing conflicting display:none"
```

---

## Task 3: Header Compression

Replace the jarring hide/show of `pd-hero` with a compressed info bar for data-intensive tabs.

**Files:**
- Modify: `energy-department.html:410` (CSS — add `.pd-hero-compact` styles)
- Modify: `energy-department.html:3944-3982` (renderDetail — add compact bar HTML)
- Modify: `energy-department.html:4197-4212` (sPTab — swap display logic)

- [ ] **Step 1: Add CSS for the compact header**

Find the `.pd-hero` CSS block (around line 410). After it, add:

```css
.pd-hero-compact{display:none;align-items:center;gap:12px;padding:8px 18px;background:var(--s2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;font-size:12px;color:var(--text2);overflow:hidden;white-space:nowrap;flex-wrap:nowrap;}
.pd-hero-compact .phc-name{font-weight:700;font-size:13px;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;}
.pd-hero-compact .phc-sep{color:var(--border2);margin:0 2px;}
.pd-hero-compact .phc-val{font-family:var(--mono);color:var(--text);}
```

- [ ] **Step 2: Add compact bar HTML in renderDetail**

In `renderDetail` (line 3926), find the closing `</div>` of the `pd-hero` section and the opening of the tab `<div class="card">` with `pd-tabs` (line 3982). Between them, insert:

```javascript
const _udBldgs = getUDBldgs(p.id);
const _totalSqft = _udBldgs.reduce((s,b)=>s+parseInt(b.sqft||0),0);
const _openTasks = (typeof tasks!=='undefined'?tasks:[]).filter(t=>t.projId===p.id&&!t.done).length;
const _fmtDate = d => d ? new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
```

Then after the `</div>` closing `pd-hero`, add:

```html
<div class="pd-hero-compact" id="pd-hero-compact">
  <span class="phc-name">${p.name}</span>
  <span class="phc-sep">|</span>
  <span>SA# <span class="phc-val">${p.sa||'—'}</span></span>
  <span class="phc-sep">|</span>
  <span>Savings <span class="phc-val">${p.savings?'$'+Number(p.savings).toLocaleString()+'/yr':'—'}</span></span>
  <span class="phc-sep">|</span>
  <span><span class="phc-val">${_fmtDate(p.start)}</span> → <span class="phc-val">${_fmtDate(p.end)}</span></span>
  <span class="phc-sep">|</span>
  <span>Tasks <span class="phc-val" style="${_openTasks>0?'color:var(--warn)':''}">${_openTasks}</span></span>
  <span class="phc-sep">|</span>
  <span><span class="phc-val">${_udBldgs.length}</span> bldg${_udBldgs.length!==1?'s':''} <span class="phc-val">${_totalSqft?Number(_totalSqft).toLocaleString()+' sf':''}</span></span>
</div>
```

- [ ] **Step 3: Update sPTab to swap between full and compact**

Find `sPTab` (line 4198). Replace the current hero hide logic:

```javascript
const hero = document.querySelector('.pd-hero');
if(hero) hero.style.display = FULLWIN_TABS.includes(tab) ? 'none' : '';
```

with:

```javascript
const hero = document.querySelector('.pd-hero');
const compact = document.getElementById('pd-hero-compact');
if(FULLWIN_TABS.includes(tab)){
  if(hero) hero.style.display = 'none';
  if(compact) compact.style.display = 'flex';
} else {
  if(hero) hero.style.display = '';
  if(compact) compact.style.display = 'none';
}
```

- [ ] **Step 4: Test and commit**

Switch between tabs. Verify:
- Notes, Tasks, Contacts, Buildings, Equipment show full hero
- Savings, HVAC Load, Utility Data, Energy Graphics show compact bar
- Compact bar shows correct project name, SA#, savings, dates, task count, building count
- No layout jump or jarring transition

```bash
git add energy-department.html
git commit -m "Replace jarring header hide with compressed info bar on data-intensive tabs"
```

---

## Task 4: Energy Savings — Rate Initialization Helper

Before changing the UI, build the helper function that calculates default rates from a building's baseline bills. This is used by measure creation, building changes, and the "Reset to Building Defaults" button.

**Files:**
- Modify: `energy-department.html` — add new function near the savings section (~line 4446)

- [ ] **Step 1: Add calcBldgDefaultRates helper function**

Insert before `addSavingsMeasure` (line 4446):

```javascript
function calcBldgDefaultRates(projId, bldgId){
  const b = getUDBldg(projId, bldgId);
  if(!b) return {kwhSummer:0,kwhWinter:0,kwSummer:0,kwWinter:0,thermRate:0};
  const meters = b.meters||[];
  const elecM = meters.find(m=>m.commodity==='Electric');
  const gasM = meters.find(m=>m.commodity==='Gas');
  const SUMMER=[5,6,7,8];
  let sumKwhCost=0,sumKwh=0,winKwhCost=0,winKwh=0;
  let sumKwCost=0,sumKwCount=0,winKwCost=0,winKwCount=0;
  let totalTherms=0,totalGasCost=0;
  if(elecM)(elecM.bills||[]).forEach(bill=>{
    const mo=new Date(bill.start).getMonth();
    const kwh=bill.kwh||bill.usage||0;
    const kw=bill.kw||bill.demKW||bill.billedKw||0;
    const kwhCost=bill.kwhCost||bill.energyCost||0;
    const kwCost=bill.kwCost||bill.demandCost||0;
    if(SUMMER.includes(mo)){sumKwhCost+=kwhCost;sumKwh+=kwh;if(kw>0){sumKwCost+=kwCost;sumKwCount++;}}
    else{winKwhCost+=kwhCost;winKwh+=kwh;if(kw>0){winKwCost+=kwCost;winKwCount++;}}
  });
  if(gasM)(gasM.bills||[]).forEach(bill=>{
    totalTherms+=(bill.therms||bill.usage||0);
    totalGasCost+=(bill.totalCost||bill.cost||0);
  });
  return {
    kwhSummer: sumKwh>0?Math.round(sumKwhCost/sumKwh*10000)/10000:0,
    kwhWinter: winKwh>0?Math.round(winKwhCost/winKwh*10000)/10000:0,
    kwSummer: sumKwCount>0?Math.round(sumKwCost/sumKwCount*100)/100:0,
    kwWinter: winKwCount>0?Math.round(winKwCost/winKwCount*100)/100:0,
    thermRate: totalTherms>0?Math.round(totalGasCost/totalTherms*1000)/1000:0
  };
}
```

- [ ] **Step 2: Update addSavingsMeasure to set m.rates**

In `addSavingsMeasure` (line 4446), after building the new measure object, add rates:

Find:
```javascript
sd.measures.push({
    id:'m'+Date.now(), selected:true,
    msrNum:(sd.measures.length+1)+'',
    bldgId:firstBldg?.id||'', desc:'',
    sqft: firstBldg ? (parseFloat(firstBldg.sqft)||0) : 0,
    kwh:Array(12).fill(0), kw:Array(12).fill(0), gas:Array(12).fill(0),
    totalDollar:0
  });
```
Replace with:
```javascript
const _defRates = firstBldg ? calcBldgDefaultRates(projId, firstBldg.id) : {kwhSummer:0,kwhWinter:0,kwSummer:0,kwWinter:0,thermRate:0};
  sd.measures.push({
    id:'m'+Date.now(), selected:true,
    msrNum:(sd.measures.length+1)+'',
    bldgId:firstBldg?.id||'', desc:'',
    sqft: firstBldg ? (parseFloat(firstBldg.sqft)||0) : 0,
    rates: _defRates,
    kwh:Array(12).fill(0), kw:Array(12).fill(0), gas:Array(12).fill(0),
    totalDollar:0
  });
```

- [ ] **Step 3: Update updateMsrField to recalc rates on building change**

In `updateMsrField`, find the section that handles `field==='bldgId'`. Update it to also recalculate rates:

Find:
```javascript
if(field==='bldgId' && val){
    const bldg = getUDBldg(projId, val);
    if(bldg && bldg.sqft){
      m.sqft = parseFloat(bldg.sqft)||0;
      const sqftInp = document.querySelector(`#sv-msr-row-${projId}-${msrId} .sv-sqft-inp, #sv-pg-msr-row-${msrId} .sv-sqft-inp`);
      if(sqftInp) sqftInp.value = m.sqft||'';
    }
  }
```
Replace with:
```javascript
if(field==='bldgId' && val){
    const bldg = getUDBldg(projId, val);
    if(bldg){
      m.sqft = parseFloat(bldg.sqft)||0;
      m.rates = calcBldgDefaultRates(projId, val);
      const sqftInp = document.querySelector(`#sv-msr-row-${projId}-${msrId} .sv-sqft-inp, #sv-pg-msr-row-${msrId} .sv-sqft-inp`);
      if(sqftInp) sqftInp.value = m.sqft||'';
    }
  }
```

- [ ] **Step 4: Update calcProjSavingsMatrix to use m.rates**

In `calcProjSavingsMatrix` (line 4572), find:
```javascript
const rates=sd.blRates[m.bldgId]||{};
```
Replace with:
```javascript
const rates=m.rates||sd.blRates[m.bldgId]||{};
```

This uses per-measure rates when available, falls back to building rates for backward compatibility.

Do the same in `svRecalc` if it has its own rate lookup (check around line 4889).

- [ ] **Step 5: Update hvacLoadCreateMeasure to set m.rates**

In `hvacLoadCreateMeasure`, find the `sd.measures.push({...})` block. Add `rates`:

After `sqft: _bldgForSqft ? ...` line, add:
```javascript
    rates: bldgId ? calcBldgDefaultRates(projId, bldgId) : {kwhSummer:0,kwhWinter:0,kwSummer:0,kwWinter:0,thermRate:0},
```

- [ ] **Step 6: Add backward compatibility migration**

In `_renderSavingsContent` (line 4667), right after `const sd = getProjSavingsData(projId);`, add migration logic:

```javascript
// Migrate old per-building rates to per-measure rates
let _migrated = false;
sd.measures.forEach(m=>{
  if(!m.rates && sd.blRates && sd.blRates[m.bldgId]){
    m.rates = {...sd.blRates[m.bldgId]};
    _migrated = true;
  }
  if(!m.rates) m.rates = calcBldgDefaultRates(projId, m.bldgId);
});
if(_migrated) sset('en_projects', projects);
```

- [ ] **Step 7: Commit**

```bash
git add energy-department.html
git commit -m "Add per-measure rate initialization and calcBldgDefaultRates helper"
```

---

## Task 5: Energy Savings — Expandable Detail Row UI

Replace the building rates table with expandable detail rows on each measure showing per-measure rates, sqft, and intensity metrics.

**Files:**
- Modify: `energy-department.html:4667-4821` (`_renderSavingsContent` — remove rates table, add chevron + detail rows)
- Modify: `energy-department.html:4568-4597` (`renderSavingsMatrix` — same changes for project tab version)

- [ ] **Step 1: Add CSS for expandable detail row**

Find the savings-related CSS (search for `.sv-matrix-tbl` or `.sv-num-inp`). Add:

```css
.sv-detail-toggle{cursor:pointer;user-select:none;font-size:10px;color:var(--text3);transition:transform .15s;display:inline-block;width:16px;text-align:center;}
.sv-detail-toggle.open{transform:rotate(90deg);}
.sv-detail-row{background:var(--s1);border-top:1px dashed var(--border);}
.sv-detail-row td{padding:10px 14px !important;}
.sv-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px;}
.sv-rate-group{display:flex;flex-wrap:wrap;gap:8px;}
.sv-rate-field{display:flex;flex-direction:column;gap:2px;}
.sv-rate-field label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}
.sv-rate-field input{width:90px;font-family:var(--mono);font-size:12px;}
.sv-intensity{font-family:var(--mono);font-size:13px;font-weight:700;}
```

- [ ] **Step 2: Remove the Baseline Utility Rates by Building card from _renderSavingsContent**

In `_renderSavingsContent` (line 4667), find the entire rates card block — it starts with:
```html
<div class="card">
      <div class="card-hdr"><span class="card-title">📊 Baseline Utility Rates by Building</span></div>
```
and ends before the measures card. Remove the entire rates card `<div class="card">...</div>` block, including the `ratesRows` variable construction above it.

Also remove the `_svSaveRatesFrom` button from the measures card header — find `💾 Save Rates` button and remove it.

- [ ] **Step 3: Add chevron column to table header**

In the measures table `<thead>`, the first `<th>` is `✓` (checkbox). Before it, add:
```html
<th style="width:20px"></th>
```

In the second header row, add a matching empty `<th></th>` at the start.

Update the empty-state colspan and footer colspan to account for the new column (increment by 1).

- [ ] **Step 4: Add chevron and detail row to each measure row**

In the measure row template (inside `.map(m=>{...})`), before the checkbox `<td>`, add:
```javascript
<td style="text-align:center;vertical-align:top;padding-top:6px"><span class="sv-detail-toggle" id="sv-dtog-${mid}" onclick="svToggleDetail('${mid}')">▶</span></td>
```

After the closing `</tr>` of the measure row, add the detail row:
```javascript
<tr id="sv-detail-${mid}" class="sv-detail-row" style="display:none">
  <td colspan="44" style="padding:12px 16px">
    <div class="sv-detail-grid">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Utility Rates</div>
        <div class="sv-rate-group">
          <div class="sv-rate-field"><label>kWh $/Summer</label><input class="fi" type="number" step="0.0001" value="${(r.kwhSummer||0)||''}" onchange="svUpdateMsrRate('${mid}','kwhSummer',parseFloat(this.value)||0)"></div>
          <div class="sv-rate-field"><label>kWh $/Winter</label><input class="fi" type="number" step="0.0001" value="${(r.kwhWinter||0)||''}" onchange="svUpdateMsrRate('${mid}','kwhWinter',parseFloat(this.value)||0)"></div>
          <div class="sv-rate-field"><label>kW $/Summer</label><input class="fi" type="number" step="0.01" value="${(r.kwSummer||0)||''}" onchange="svUpdateMsrRate('${mid}','kwSummer',parseFloat(this.value)||0)"></div>
          <div class="sv-rate-field"><label>kW $/Winter</label><input class="fi" type="number" step="0.01" value="${(r.kwWinter||0)||''}" onchange="svUpdateMsrRate('${mid}','kwWinter',parseFloat(this.value)||0)"></div>
          <div class="sv-rate-field"><label>Gas $/Therm</label><input class="fi" type="number" step="0.001" value="${(r.thermRate||0)||''}" onchange="svUpdateMsrRate('${mid}','thermRate',parseFloat(this.value)||0)"></div>
        </div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px;font-size:11px" onclick="svResetMsrRates('${mid}')">Reset to Building Defaults</button>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Intensity Metrics</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div>Sq Ft: <span class="sv-intensity" style="color:var(--text)">${m.sqft?Number(m.sqft).toLocaleString():'—'}</span></div>
          <div>kWh/sf saved: <span class="sv-intensity" style="color:var(--accent)">${m.sqft>0&&annMsrKwh>0?(annMsrKwh/m.sqft).toFixed(1):'—'}</span></div>
          <div>$/sf saved: <span class="sv-intensity" style="color:var(--green)">${m.sqft>0&&m.totalDollar>0?'$'+(m.totalDollar/m.sqft).toFixed(2):'—'}</span></div>
        </div>
      </div>
    </div>
  </td>
</tr>
```

Where `r = m.rates||{}` and `annMsrKwh = m.kwh.reduce((a,b)=>a+(parseFloat(b)||0),0)` — compute these at the top of the `.map()` callback.

- [ ] **Step 5: Add toggle and rate update functions**

Add these functions near the savings action handlers:

```javascript
function svToggleDetail(msrId){
  const row = document.getElementById('sv-detail-'+msrId);
  const tog = document.getElementById('sv-dtog-'+msrId);
  if(!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  if(tog) tog.classList.toggle('open', !open);
}

function svUpdateMsrRate(msrId, field, val){
  const pid = svSelProjId || window._activeProjId;
  if(!pid) return;
  const sd = getProjSavingsData(pid);
  const m = sd.measures.find(x=>x.id===msrId);
  if(!m) return;
  if(!m.rates) m.rates = {};
  m.rates[field] = val;
  sset('en_projects', projects);
}

function svResetMsrRates(msrId){
  const pid = svSelProjId || window._activeProjId;
  if(!pid) return;
  const sd = getProjSavingsData(pid);
  const m = sd.measures.find(x=>x.id===msrId);
  if(!m) return;
  m.rates = calcBldgDefaultRates(pid, m.bldgId);
  sset('en_projects', projects);
  // Re-render to update inputs
  if(document.getElementById('ptab-savings')?.offsetParent!==null) initSavingsTab(pid);
  else renderSvDetail();
  showToast('Rates reset to building defaults ✓');
}
```

- [ ] **Step 6: Apply same changes to renderSavingsMatrix (project tab version)**

Apply the same chevron column and detail row changes to `renderSavingsMatrix` (line 4568). This function renders the project-tab version independently of `_renderSavingsContent`. Add the same chevron `<td>`, detail `<tr>`, and update colspans.

- [ ] **Step 7: Test and commit**

Verify:
- No more "Baseline Utility Rates by Building" table at the top
- Each measure row has a ▶ chevron on the left
- Clicking the chevron expands a detail panel with rate fields and intensity metrics
- Changing a rate and clicking Recalc updates the $/Yr
- "Reset to Building Defaults" repopulates rates from the building's bills
- Works in both sidebar Energy Savings page and project tab

```bash
git add energy-department.html
git commit -m "Replace building rates table with per-measure expandable detail rows"
```

---

## Task 6: District Calendar Rework

Replace the WebCTRL-focused calendar tool with a simple upload/parse/edit flow.

**Files:**
- Modify: `energy-department.html:4100-4126` (ptab-district HTML in renderDetail)
- Modify: `energy-department.html:6218+` (dcExtractEvents function)
- Modify: `energy-department.html:6488+` (parseProjDistCal function)

- [ ] **Step 1: Replace the district calendar tab HTML**

Find the `ptab-district` content (line 4100). Replace everything from `<div id="ptab-district-inner-${p.id}">` through its closing `</div></div>` with:

```html
<div id="ptab-district-inner-${p.id}" style="padding:16px">
  <div class="card" style="margin-bottom:16px">
    <div class="card-hdr" style="justify-content:space-between">
      <span class="card-title">🗓️ District Calendar</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="distCalAddRow(${p.id})">+ Add Event</button>
        <button class="btn btn-em btn-sm" onclick="distCalParse(${p.id})">📋 Parse from Text</button>
      </div>
    </div>
    <div style="padding:16px">
      <div id="distcal-parse-${p.id}" style="display:none;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px">Paste school calendar text or upload a PDF. Dates and events will be extracted automatically.</div>
        <textarea class="fta" id="distcal-text-${p.id}" style="min-height:120px" placeholder="Paste calendar text here — holidays, breaks, early release days, first/last day of school..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-em btn-sm" onclick="distCalRunParse(${p.id})">Extract Events</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('distcal-parse-${p.id}').style.display='none'">Cancel</button>
        </div>
      </div>
      <div id="distcal-table-${p.id}"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add initDistrictCalTab and rendering function**

Add to `sPTab`, after the meetings init:
```javascript
if(tab==='district') renderDistCalTable(p.id);
```

Add the render function near the district calendar section:

```javascript
const DIST_CAL_TYPES = ['Holiday','Break','Early Release','Teacher Day','First/Last Day','Other'];

function renderDistCalTable(projId){
  const p = projects.find(x=>x.id===projId); if(!p) return;
  p.districtCalendar = p.districtCalendar || [];
  const wrap = document.getElementById('distcal-table-'+projId);
  if(!wrap) return;
  if(!p.districtCalendar.length){
    wrap.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px;font-size:13px">No calendar events yet. Click "+ Add Event" or "Parse from Text" to add district calendar dates.</div>';
    return;
  }
  const rows = p.districtCalendar.sort((a,b)=>new Date(a.date)-new Date(b.date));
  const typeOpts = DIST_CAL_TYPES.map(t=>`<option>${t}</option>`).join('');
  wrap.innerHTML = `<table class="dtbl" style="width:100%">
    <thead><tr><th style="width:140px">Date</th><th>Event Name</th><th style="width:140px">Type</th><th style="width:36px"></th></tr></thead>
    <tbody>${rows.map((ev,i)=>`<tr>
      <td><input class="fi" type="date" value="${ev.date||''}" onchange="distCalUpdate(${projId},${i},'date',this.value)" style="font-family:var(--mono)"></td>
      <td><input class="fi" value="${esc(ev.name||'')}" onchange="distCalUpdate(${projId},${i},'name',this.value)" style="width:100%"></td>
      <td><select class="fs" onchange="distCalUpdate(${projId},${i},'type',this.value)">${typeOpts.replace('>${ev.type||'Other'}<',` selected>${ev.type||'Other'}<`)}</select></td>
      <td><button class="btn-del" onclick="distCalRemove(${projId},${i})">✕</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
```

- [ ] **Step 3: Add CRUD and parse functions**

```javascript
function distCalAddRow(projId){
  const p = projects.find(x=>x.id===projId); if(!p) return;
  p.districtCalendar = p.districtCalendar || [];
  p.districtCalendar.push({id:Date.now(), date:'', name:'', type:'Holiday'});
  sset('en_projects', projects);
  renderDistCalTable(projId);
}

function distCalUpdate(projId, idx, field, val){
  const p = projects.find(x=>x.id===projId); if(!p) return;
  if(!p.districtCalendar[idx]) return;
  p.districtCalendar[idx][field] = val;
  sset('en_projects', projects);
}

function distCalRemove(projId, idx){
  const p = projects.find(x=>x.id===projId); if(!p) return;
  p.districtCalendar.splice(idx, 1);
  sset('en_projects', projects);
  renderDistCalTable(projId);
}

function distCalParse(projId){
  document.getElementById('distcal-parse-'+projId).style.display = '';
}

function distCalRunParse(projId){
  const text = document.getElementById('distcal-text-'+projId)?.value||'';
  if(!text.trim()){ showToast('Paste calendar text first'); return; }
  const events = dcExtractCalendarEvents(text);
  if(!events.length){ showToast('No events found — try different text'); return; }
  const p = projects.find(x=>x.id===projId); if(!p) return;
  p.districtCalendar = p.districtCalendar || [];
  events.forEach(ev=>{
    // Avoid duplicates by date+name
    if(!p.districtCalendar.some(e=>e.date===ev.date && e.name===ev.name)){
      p.districtCalendar.push({id:Date.now()+Math.random(), ...ev});
    }
  });
  sset('en_projects', projects);
  document.getElementById('distcal-parse-'+projId).style.display = 'none';
  renderDistCalTable(projId);
  showToast(events.length+' events extracted ✓');
}
```

- [ ] **Step 4: Write the calendar text parser**

Replace or add `dcExtractCalendarEvents`:

```javascript
function dcExtractCalendarEvents(text){
  const events = [];
  const lines = text.split(/\n/);
  // Date patterns
  const datePatterns = [
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,  // MM/DD/YYYY
    /(\d{1,2})\/(\d{1,2})\/(\d{2})/,   // MM/DD/YY
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})?/i,
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s*(\d{4})?/i,
  ];
  const typeKeywords = {
    'Holiday': /holiday|mlk|martin luther|presidents|memorial|labor day|independence|thanksgiving|christmas|new year|veteran/i,
    'Break': /break|recess/i,
    'Early Release': /early release|early dismiss|early out|half day/i,
    'Teacher Day': /teacher|in-?service|professional dev|pd day|staff dev|workday|planning/i,
    'First/Last Day': /first day|last day|school (begins|starts|ends)|commencement|graduation/i,
  };
  function detectType(name){
    for(const [type, re] of Object.entries(typeKeywords)){
      if(re.test(name)) return type;
    }
    return 'Other';
  }
  const monthMap = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const currentYear = new Date().getFullYear();

  lines.forEach(line=>{
    line = line.trim();
    if(!line) return;
    let date = null, rest = line;
    // Try each date pattern
    for(const pat of datePatterns){
      const m = line.match(pat);
      if(m){
        if(/^\d/.test(m[1])){
          // Numeric date
          let yr = m[3]||''+currentYear;
          if(yr.length===2) yr = '20'+yr;
          date = `${yr}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
        } else {
          // Month name date
          const mo = monthMap[m[1].toLowerCase()];
          const day = m[2];
          const yr = m[3]||currentYear;
          date = `${yr}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }
        rest = line.replace(m[0],'').replace(/^[\s\-–—:,]+/,'').trim();
        break;
      }
    }
    if(date && rest){
      // Clean up the event name
      rest = rest.replace(/^[\s\-–—:,]+/,'').replace(/[\s\-–—:,]+$/,'');
      if(rest.length>1){
        events.push({date, name:rest, type:detectType(rest)});
      }
    }
  });
  return events;
}
```

- [ ] **Step 5: Test and commit**

Test by:
1. Opening a project's District Calendar tab
2. Clicking "Parse from Text" and pasting a school calendar
3. Verifying events appear in the table with correct types
4. Adding, editing, and deleting rows manually

```bash
git add energy-department.html
git commit -m "Rework District Calendar tab — upload/parse/edit flow, remove WebCTRL setback output"
```

---

## Task 7: Project Dashboard Tab — Performance Summary

Add the new Dashboard tab as the default landing tab with building performance data.

**Files:**
- Modify: `energy-department.html:3983-3997` (tab buttons in renderDetail)
- Modify: `energy-department.html:3998` (add ptab-dashboard div)
- Modify: `energy-department.html:4183-4187` (requestAnimationFrame — init dashboard)
- Add: `initDashboardTab` function

- [ ] **Step 1: Add Dashboard tab button as first tab**

Find the `pd-tabs` div (line 3983). Insert the Dashboard button before Notes:

```html
<button class="pdt active" onclick="sPTab('dashboard',this)">📊 Dashboard</button>
<button class="pdt" onclick="sPTab('notes',this)">📝 Notes</button>
```

Remove the `active` class from the Notes button (it was `class="pdt active"`).

- [ ] **Step 2: Add the dashboard tab container**

After the `</div>` closing `pd-tabs` and before `<div id="ptab-notes"`, add:

```html
<div id="ptab-dashboard" class="ptab active" style="padding:16px;overflow-y:auto">
  <div id="dash-content-${p.id}" style="display:grid;grid-template-columns:1fr 360px;gap:16px">
    <div id="dash-perf-${p.id}"><div style="text-align:center;color:var(--text3);padding:40px">Loading...</div></div>
    <div id="dash-cal-${p.id}"><div style="text-align:center;color:var(--text3);padding:40px">Loading...</div></div>
  </div>
</div>
```

Remove `active` from ptab-notes: change `<div id="ptab-notes" class="ptab active"` to `<div id="ptab-notes" class="ptab"`.

Add a responsive breakpoint in the CSS:
```css
@media(max-width:900px){#dash-content-${p.id}{grid-template-columns:1fr !important;}}
```

Actually, since this is inside a template literal, use a class instead. Add to the CSS section:
```css
.dash-grid{display:grid;grid-template-columns:1fr 360px;gap:16px;}
@media(max-width:900px){.dash-grid{grid-template-columns:1fr;}}
```

Then use `class="dash-grid"` instead of the inline grid style.

- [ ] **Step 3: Add sPTab handler for dashboard**

In `sPTab`, add:
```javascript
if(tab==='dashboard') initDashboardTab(p.id);
```

- [ ] **Step 4: Add initDashboardTab in requestAnimationFrame**

In the `requestAnimationFrame` block (line 4183), add `initDashboardTab(p.id)` since dashboard is now the default active tab:

```javascript
requestAnimationFrame(()=>{
    renderProjBuildingsTab(p.id);
    renderProjEquip(p.id);
    initProjUDTab(p.id);
    initDashboardTab(p.id);
  });
```

- [ ] **Step 5: Write initDashboardTab — performance summary**

Add the function:

```javascript
function initDashboardTab(projId){
  const p = projects.find(x=>x.id===projId); if(!p) return;
  const perfWrap = document.getElementById('dash-perf-'+projId);
  if(!perfWrap) return;
  const bldgs = getUDBldgs(projId);
  const estSavings = parseFloat(p.savings)||0;

  if(!bldgs.length || !bldgs.some(b=>(b.meters||[]).some(m=>(m.bills||[]).length>0))){
    perfWrap.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">
      Add buildings and utility data to see performance summary.<br>
      <span style="font-size:11px">Use the <strong style="color:var(--accent)">Utility Data</strong> tab to get started.</span>
    </div></div>`;
    renderDashCalendar(projId);
    return;
  }

  let totalBl=0, totalCur=0;
  const bldgRows = bldgs.map(b=>{
    const meters = b.meters||[];
    let blCost=0, curCost=0;
    meters.forEach(m=>{
      const bills = (m.bills||[]).slice().sort((a,c)=>new Date(a.start)-new Date(c.start));
      const bl = m.baseline||{};
      const blMonths = bl.months||{};
      bills.forEach((bill,i)=>{
        const cost = bill.totalCost||bill.cost||0;
        const isBl = blMonths[i]!==undefined ? blMonths[i] : (bl.startIdx===undefined);
        if(isBl) blCost += cost;
      });
      // Current = last 12 bills
      bills.slice(-12).forEach(bill=>{ curCost += (bill.totalCost||bill.cost||0); });
    });
    totalBl += blCost;
    totalCur += curCost;
    const sav = blCost - curCost;
    const savPct = blCost>0 ? (sav/blCost*100) : 0;
    let status = 'No Data', statusColor = 'var(--text3)';
    if(blCost>0 && curCost>0){
      if(sav<0){ status='Over Budget'; statusColor='var(--danger)'; }
      else if(estSavings>0 && sav >= estSavings*0.8){ status='On Track'; statusColor='var(--green)'; }
      else if(sav>0){ status='Below Target'; statusColor='var(--amber)'; }
    }
    return {name:b.name, blCost, curCost, sav, savPct, status, statusColor};
  });

  const totalSav = totalBl - totalCur;
  const totalPct = totalBl>0 ? (totalSav/totalBl*100) : 0;
  const $c = n => '$'+Math.round(n).toLocaleString();

  perfWrap.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="padding:20px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:160px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px">Total Savings vs Baseline</div>
          <div style="font-size:32px;font-weight:800;font-family:var(--mono);color:${totalSav>=0?'var(--green)':'var(--danger)'};margin:4px 0">${totalSav>=0?'':'−'}${$c(Math.abs(totalSav))}<span style="font-size:16px;font-weight:600;color:var(--text2)">/yr</span></div>
          <div style="font-size:12px;color:var(--text2)">${totalPct>=0?'+':''}${totalPct.toFixed(1)}% vs baseline · ${bldgs.length} building${bldgs.length!==1?'s':''}</div>
        </div>
        <div style="display:flex;gap:16px">
          <div style="text-align:center"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Baseline</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$c(totalBl)}</div></div>
          <div style="text-align:center"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Current</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">${$c(totalCur)}</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Building Performance</span></div>
      <div style="overflow-x:auto">
        <table class="dtbl" style="width:100%;font-size:12px">
          <thead><tr><th>Building</th><th style="text-align:right">Baseline $/yr</th><th style="text-align:right">Current $/yr</th><th style="text-align:right">Savings $</th><th style="text-align:right">%</th><th style="text-align:center">Status</th></tr></thead>
          <tbody>${bldgRows.map(r=>`<tr>
            <td style="font-weight:600">${r.name}</td>
            <td style="text-align:right;font-family:var(--mono)">${r.blCost>0?$c(r.blCost):'—'}</td>
            <td style="text-align:right;font-family:var(--mono)">${r.curCost>0?$c(r.curCost):'—'}</td>
            <td style="text-align:right;font-family:var(--mono);color:${r.sav>=0?'var(--green)':'var(--danger)'}">${r.blCost>0?(r.sav>=0?'':'−')+$c(Math.abs(r.sav)):'—'}</td>
            <td style="text-align:right;font-family:var(--mono)">${r.blCost>0?r.savPct.toFixed(1)+'%':'—'}</td>
            <td style="text-align:center;font-weight:600;color:${r.statusColor}">${r.status}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;

  renderDashCalendar(projId);
}
```

- [ ] **Step 6: Commit performance summary**

```bash
git add energy-department.html
git commit -m "Add Project Dashboard tab with building performance summary"
```

---

## Task 8: Project Dashboard Tab — Calendar

Add the month-view calendar to the dashboard right column.

**Files:**
- Modify: `energy-department.html` — add `renderDashCalendar` function

- [ ] **Step 1: Write renderDashCalendar**

```javascript
let _dashCalMonth = null; // {year, month} — null = current month
let _dashCalProjId = null;

function renderDashCalendar(projId){
  _dashCalProjId = projId;
  const wrap = document.getElementById('dash-cal-'+projId);
  if(!wrap) return;
  const p = projects.find(x=>x.id===projId);
  if(!p){ wrap.innerHTML=''; return; }
  const now = new Date();
  if(!_dashCalMonth) _dashCalMonth = {year:now.getFullYear(), month:now.getMonth()};
  const {year, month} = _dashCalMonth;
  const monthName = new Date(year, month).toLocaleDateString('en-US',{month:'long',year:'numeric'});

  // Collect events for this month
  const events = [];
  // Meetings
  (p.meetings||[]).forEach(m=>{
    const d = new Date(m.date);
    if(d.getFullYear()===year && d.getMonth()===month){
      events.push({day:d.getDate(), label:(m.type==='agenda'?'Agenda':'Minutes')+': '+(m.projectNickname||'Meeting'), color:'var(--accent)', type:'meeting'});
    }
  });
  // Recurring meetings (calculate for this month)
  (p.recurringMeetings||[]).filter(r=>r.active).forEach(r=>{
    const meetDate = getNthWeekdayOfMonth(year, month, r.nthWeek, r.weekday);
    if(meetDate){
      const d = meetDate.getDate();
      // Don't duplicate if an actual meeting already exists on this date
      if(!events.some(e=>e.day===d && e.type==='meeting')){
        events.push({day:d, label:'Recurring: '+(r.time||''), color:'var(--accent)', type:'meeting'});
      }
    }
  });
  // Tasks
  (typeof tasks!=='undefined'?tasks:[]).filter(t=>t.projId===projId&&t.due).forEach(t=>{
    const d = new Date(t.due+'T12:00:00');
    if(d.getFullYear()===year && d.getMonth()===month){
      events.push({day:d.getDate(), label:t.text, color:'var(--amber)', type:'task'});
    }
  });
  // District calendar
  (p.districtCalendar||[]).forEach(ev=>{
    const d = new Date(ev.date+'T12:00:00');
    if(d.getFullYear()===year && d.getMonth()===month){
      events.push({day:d.getDate(), label:ev.name, color:'var(--teal)', type:'district'});
    }
  });

  // Build calendar grid
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  let cells = dayNames.map(d=>`<div style="text-align:center;font-size:10px;font-weight:700;color:var(--text3);padding:4px 0">${d}</div>`).join('');
  for(let i=0;i<firstDay;i++) cells += '<div></div>';
  for(let d=1;d<=daysInMonth;d++){
    const dayEvents = events.filter(e=>e.day===d);
    const isToday = d===now.getDate() && month===now.getMonth() && year===now.getFullYear();
    const dots = dayEvents.slice(0,3).map(e=>`<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${e.color}"></span>`).join('');
    cells += `<div style="text-align:center;padding:4px 2px;cursor:${dayEvents.length?'pointer':'default'};border-radius:6px;${isToday?'background:var(--accent-dim);font-weight:700;color:var(--accent)':''}" onclick="dashCalShowDay(${projId},${year},${month},${d})">
      <div style="font-size:12px">${d}</div>
      ${dots?`<div style="display:flex;gap:2px;justify-content:center;margin-top:1px">${dots}</div>`:''}
    </div>`;
  }

  wrap.innerHTML = `<div class="card">
    <div class="card-hdr" style="justify-content:space-between">
      <button class="btn btn-ghost btn-sm" onclick="dashCalNav(${projId},-1)">◀</button>
      <span class="card-title" style="font-size:13px">${monthName}</span>
      <button class="btn btn-ghost btn-sm" onclick="dashCalNav(${projId},1)">▶</button>
    </div>
    <div style="padding:8px 12px;display:grid;grid-template-columns:repeat(7,1fr);gap:2px">${cells}</div>
    <div id="dash-cal-detail-${projId}" style="padding:0 12px 12px;font-size:12px"></div>
  </div>`;
}

function dashCalNav(projId, dir){
  if(!_dashCalMonth) _dashCalMonth = {year:new Date().getFullYear(), month:new Date().getMonth()};
  _dashCalMonth.month += dir;
  if(_dashCalMonth.month > 11){ _dashCalMonth.month=0; _dashCalMonth.year++; }
  if(_dashCalMonth.month < 0){ _dashCalMonth.month=11; _dashCalMonth.year--; }
  renderDashCalendar(projId);
}

function dashCalShowDay(projId, year, month, day){
  const wrap = document.getElementById('dash-cal-detail-'+projId);
  if(!wrap) return;
  const p = projects.find(x=>x.id===projId); if(!p) return;
  const events = [];
  // Same event collection as renderDashCalendar but for a specific day
  (p.meetings||[]).forEach(m=>{
    const d = new Date(m.date);
    if(d.getFullYear()===year && d.getMonth()===month && d.getDate()===day)
      events.push({label:(m.type==='agenda'?'📋 Agenda':'📝 Minutes')+': '+(m.projectNickname||'Meeting'), color:'var(--accent)'});
  });
  (p.recurringMeetings||[]).filter(r=>r.active).forEach(r=>{
    const meetDate = getNthWeekdayOfMonth(year, month, r.nthWeek, r.weekday);
    if(meetDate && meetDate.getDate()===day)
      events.push({label:'🔄 Recurring meeting '+(r.time||''), color:'var(--accent)'});
  });
  (typeof tasks!=='undefined'?tasks:[]).filter(t=>t.projId===projId&&t.due).forEach(t=>{
    const d = new Date(t.due+'T12:00:00');
    if(d.getFullYear()===year && d.getMonth()===month && d.getDate()===day)
      events.push({label:'✅ '+t.text, color:'var(--amber)'});
  });
  (p.districtCalendar||[]).forEach(ev=>{
    const d = new Date(ev.date+'T12:00:00');
    if(d.getFullYear()===year && d.getMonth()===month && d.getDate()===day)
      events.push({label:'🗓️ '+ev.name, color:'var(--teal)'});
  });
  if(!events.length){ wrap.innerHTML=''; return; }
  const dateStr = new Date(year,month,day).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  wrap.innerHTML = `<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
    <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:4px">${dateStr}</div>
    ${events.map(e=>`<div style="padding:3px 0;color:var(--text2)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${e.color};margin-right:6px"></span>${e.label}</div>`).join('')}
  </div>`;
}
```

- [ ] **Step 2: Test and commit**

Verify:
- Dashboard tab is the default when opening a project
- Calendar shows current month with correct day grid
- Prev/next arrows navigate months
- Meeting dots appear on correct dates
- Clicking a day shows event details
- Task due dates appear if tasks exist

```bash
git add energy-department.html
git commit -m "Add project calendar to Dashboard tab with meetings, tasks, and district events"
```

---

## Task 9: Meetings Tab — Header Cleanup and Default Topics

Simplify the meetings tab header, add default topics, and auto-populate dates from recurring schedule.

**Files:**
- Modify: `energy-department.html:4157-4171` (meetings tab header HTML)
- Modify: `energy-department.html:11847-11875` (openMeetingEditor — topics + date)
- Modify: `energy-department.html:11778-11794` (getDefaultTemplate)

- [ ] **Step 1: Simplify meetings tab header**

Find lines 4157-4171. Replace:
```html
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:14px;font-weight:600">Meetings</span>
            <div style="display:flex;gap:4px">
              <button class="ptpill sel" onclick="mtgFilterSet('all',${p.id},this)">All</button>
              <button class="ptpill" onclick="mtgFilterSet('agenda',${p.id},this)">Agendas</button>
              <button class="ptpill" onclick="mtgFilterSet('minutes',${p.id},this)">Minutes</button>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="openMtgTemplateSettings()">⚙️</button>
            <button class="btn btn-ghost btn-sm" onclick="openRecurringSetup(${p.id})">🔄 Recurring</button>
            <button class="btn btn-em btn-sm" onclick="openMeetingEditor(${p.id})">+ New Agenda</button>
          </div>
        </div>
```
with:
```html
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:14px;font-weight:600">Meetings</span>
            <div style="display:flex;gap:4px">
              <button class="ptpill sel" onclick="mtgFilterSet('all',${p.id},this)">All</button>
              <button class="ptpill" onclick="mtgFilterSet('agenda',${p.id},this)">Agendas</button>
              <button class="ptpill" onclick="mtgFilterSet('minutes',${p.id},this)">Minutes</button>
            </div>
          </div>
          <button class="btn btn-em btn-sm" onclick="openMeetingEditor(${p.id})">+ New Agenda</button>
        </div>
```

- [ ] **Step 2: Update getDefaultTemplate with default topics**

In `getDefaultTemplate` (line 11778), update the template creation:

```javascript
function getDefaultTemplate(){
  let t = sget('en_meetingTemplates',null);
  if(!t || !t.defaultTopics) {
    t = t || {};
    t.id = t.id || Date.now();
    t.name = t.name || 'Energy Management Services';
    t.cscContacts = t.cscContacts || [
      {name:'Matt Miller', phone:'[REDACTED-PHONE]', email:'[REDACTED-EMAIL]'},
      {name:'[REDACTED]', phone:'[REDACTED-PHONE]', email:'[REDACTED-EMAIL]'}
    ];
    t.sectionHeading = t.sectionHeading || 'Energy Management Services Program';
    t.defaultEndTopic = t.defaultEndTopic || 'Questions?';
    t.defaultTopics = [
      {text:'Project Status Update', subItems:[]},
      {text:'Energy Savings Review', subItems:[]},
      {text:'Upcoming Milestones / Action Items', subItems:[]},
      {text:'Open Issues', subItems:[]},
      {text:'Questions?', subItems:[]}
    ];
    sset('en_meetingTemplates', t);
  }
  return t;
}
```

- [ ] **Step 3: Update openMeetingEditor to use default topics and auto-populate recurring date**

In `openMeetingEditor` (line 11847), replace the new-meeting initialization block. Find:
```javascript
topics: [{ text: tmpl.defaultEndTopic, subItems: [] }],
```
Replace with:
```javascript
topics: JSON.parse(JSON.stringify(tmpl.defaultTopics || [{ text: tmpl.defaultEndTopic, subItems: [] }])),
```

For date auto-population from recurring, find:
```javascript
const now = new Date();
now.setMinutes(0); now.setSeconds(0);
```
Replace with:
```javascript
let now = new Date();
now.setMinutes(0); now.setSeconds(0);
// Auto-populate date from recurring schedule if one exists
const _recur = (p.recurringMeetings||[]).find(r=>r.active);
if(_recur){
  // Find next upcoming meeting date
  for(let offset=0;offset<3;offset++){
    const checkDate = new Date(now.getFullYear(), now.getMonth()+offset, 1);
    const meetDate = getNthWeekdayOfMonth(checkDate.getFullYear(), checkDate.getMonth(), _recur.nthWeek, _recur.weekday);
    if(meetDate && meetDate >= new Date()){
      // Check if an agenda already exists for this date
      const dateStr = meetDate.toISOString().slice(0,10);
      const exists = p.meetings.some(m=>m.type==='agenda'&&m.date.slice(0,10)===dateStr);
      if(!exists){
        meetDate.setHours(parseInt(_recur.time?.split(':')[0])||9, parseInt(_recur.time?.split(':')[1])||0);
        now = meetDate;
        break;
      }
    }
  }
}
```

Also add `carryForward` logic — if recurring has `carryForward` and previous meeting exists, use its topics:
```javascript
// Carry forward topics from previous meeting if enabled
if(_recur && _recur.carryForward){
  const lastAgenda = p.meetings.filter(m=>m.type==='agenda').sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
  if(lastAgenda){
    _editingMeeting.topics = JSON.parse(JSON.stringify(lastAgenda.topics));
  }
}
```
Insert this after `_editingMeeting` is fully initialized.

- [ ] **Step 4: Test and commit**

Verify:
- Settings and Recurring buttons are gone from header
- New agendas start with 5 default topics
- If a recurring schedule exists, the date auto-fills to the next meeting
- CarryForward from previous meeting works

```bash
git add energy-department.html
git commit -m "Simplify meetings header, add default agenda topics, auto-populate recurring date"
```

---

## Task 10: Meetings Tab — Recurring Schedule in Editor

Move recurring schedule configuration into the meeting editor modal.

**Files:**
- Modify: `energy-department.html:11882-11947` (renderMeetingEditorBody)

- [ ] **Step 1: Add recurring toggle to editor body**

In `renderMeetingEditorBody` (line 11882), after the Section Heading field and before the Contact Tables section, add:

```javascript
// Recurring schedule section
const p = projects.find(x=>x.id===_editingMeetingProjId);
const recur = (p?.recurringMeetings||[]).find(r=>r.active) || null;
const nths = ['','1st','2nd','3rd','4th'];
const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
h += `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:16px;background:var(--s1)">
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600">
    <input type="checkbox" id="mtg-recur-toggle" ${recur?'checked':''} onchange="mtgToggleRecurring(this.checked)"> Make this a recurring meeting
  </label>
  <div id="mtg-recur-fields" style="display:${recur?'':'none'};margin-top:10px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px">
      <span>Every</span>
      <select class="fs" id="mtg-recur-nth" style="width:70px">${nths.slice(1).map((n,i)=>`<option value="${i+1}" ${recur&&recur.nthWeek===i+1?'selected':''}>${n}</option>`).join('')}</select>
      <select class="fs" id="mtg-recur-day" style="width:110px">${dayNames.map((d,i)=>`<option value="${i}" ${recur&&recur.weekday===i?'selected':''}>${d}</option>`).join('')}</select>
      <span>at</span>
      <input class="fi" type="time" id="mtg-recur-time" style="width:100px" value="${recur?.time||'09:00'}">
      <span style="margin-left:12px">Auto-generate</span>
      <input class="fi" type="number" id="mtg-recur-days" style="width:50px" min="1" max="30" value="${recur?.autoGenerateDaysBefore||7}">
      <span>days before</span>
    </div>
  </div>
</div>`;
```

- [ ] **Step 2: Add mtgToggleRecurring function**

```javascript
function mtgToggleRecurring(checked){
  document.getElementById('mtg-recur-fields').style.display = checked ? '' : 'none';
}
```

- [ ] **Step 3: Save recurring schedule in saveMeeting**

In `saveMeeting` (around line 11986), after the existing save logic and before `renderMeetingsList`, add:

```javascript
// Save recurring schedule if configured
const recurToggle = document.getElementById('mtg-recur-toggle');
if(recurToggle){
  p.recurringMeetings = p.recurringMeetings || [];
  if(recurToggle.checked){
    const r = {
      id: p.recurringMeetings[0]?.id || Date.now(),
      pattern: 'nthWeekday',
      nthWeek: parseInt(document.getElementById('mtg-recur-nth')?.value)||2,
      weekday: parseInt(document.getElementById('mtg-recur-day')?.value)||1,
      time: document.getElementById('mtg-recur-time')?.value||'09:00',
      timezone: 'America/Chicago',
      autoGenerateDaysBefore: parseInt(document.getElementById('mtg-recur-days')?.value)||7,
      active: true,
      carryForward: p.recurringMeetings[0]?.carryForward||false
    };
    if(p.recurringMeetings.length) p.recurringMeetings[0] = r;
    else p.recurringMeetings.push(r);
  } else {
    // Deactivate recurring
    p.recurringMeetings.forEach(r=>r.active=false);
  }
}
```

- [ ] **Step 4: Test and commit**

Verify:
- Recurring toggle appears in the editor
- Toggling on shows pattern fields
- Saving persists the recurring schedule
- Recurring info still shows in the meetings list

```bash
git add energy-department.html
git commit -m "Move recurring schedule config into meeting editor modal"
```

---

## Task 11: Meetings Tab — Contact Picker

Add dropdown to select contacts from the project's contact list instead of blank inputs.

**Files:**
- Modify: `energy-department.html:11900-11917` (contact rows in renderMeetingEditorBody)

- [ ] **Step 1: Add contact picker dropdown to contact rows**

In `renderMeetingEditorBody`, find the contact row rendering (line ~11908). Replace the bare `<input>` for name with a picker:

Replace the contact row block:
```javascript
ct.contacts.forEach((c, ci) => {
      h += `<div class="mtg-contact-row">
        <input class="fi" value="${esc(c.name)}" onchange="mtgUpdateContact(${ti},${ci},'name',this.value)">
        <input class="fi" value="${esc(c.phone)}" onchange="mtgUpdateContact(${ti},${ci},'phone',this.value)">
        <input class="fi" value="${esc(c.email)}" onchange="mtgUpdateContact(${ti},${ci},'email',this.value)">
        <button class="btn btn-ghost btn-sm" onclick="mtgRemoveContact(${ti},${ci})" style="color:var(--warn)">✕</button>
      </div>`;
    });
    h += `<button class="btn btn-ghost btn-sm" style="margin-top:4px" onclick="mtgAddContact(${ti})">+ Contact</button></div>`;
```

With:
```javascript
// Build picker options from project contacts (for client table) or template (for CSC table)
    const projContacts = p?.contacts||[];
    const tmplContacts = tmpl.cscContacts||[];
    const pickerSrc = ti===0 ? tmplContacts : projContacts;
    const pickerOpts = pickerSrc.length ? `<option value="">— Pick from list —</option>${pickerSrc.map((pc,pci)=>{
      const pcName = pc.name || ((pc.first||'')+' '+(pc.last||'')).trim();
      return `<option value="${pci}">${esc(pcName)}</option>`;
    }).join('')}` : '';

    ct.contacts.forEach((c, ci) => {
      h += `<div class="mtg-contact-row">
        <div style="display:flex;gap:4px;flex:1">
          ${pickerOpts?`<select class="fs" style="width:auto;min-width:50px;flex-shrink:0" onchange="mtgPickContact(${ti},${ci},this.value,${ti===0?'true':'false'})"><option value="">📋</option>${pickerSrc.map((pc,pci)=>{const pcName=pc.name||((pc.first||'')+' '+(pc.last||'')).trim();return `<option value="${pci}">${esc(pcName)}</option>`;}).join('')}</select>`:''}
          <input class="fi" style="flex:1" value="${esc(c.name)}" onchange="mtgUpdateContact(${ti},${ci},'name',this.value)">
        </div>
        <input class="fi" value="${esc(c.phone)}" onchange="mtgUpdateContact(${ti},${ci},'phone',this.value)">
        <input class="fi" value="${esc(c.email)}" onchange="mtgUpdateContact(${ti},${ci},'email',this.value)">
        <button class="btn btn-ghost btn-sm" onclick="mtgRemoveContact(${ti},${ci})" style="color:var(--warn)">✕</button>
      </div>`;
    });
    h += `<button class="btn btn-ghost btn-sm" style="margin-top:4px" onclick="mtgAddContact(${ti})">+ Contact</button></div>`;
```

- [ ] **Step 2: Add mtgPickContact function**

```javascript
function mtgPickContact(tableIdx, contactIdx, pickerValue, isCsc){
  if(!pickerValue && pickerValue!==0) return;
  const idx = parseInt(pickerValue);
  const p = projects.find(x=>x.id===_editingMeetingProjId);
  const tmpl = getDefaultTemplate();
  let src;
  if(isCsc==='true' || isCsc===true){
    src = (tmpl.cscContacts||[])[idx];
  } else {
    src = (p?.contacts||[])[idx];
  }
  if(!src) return;
  const ct = _editingMeeting.contactTables[tableIdx];
  if(!ct || !ct.contacts[contactIdx]) return;
  const name = src.name || ((src.first||'')+' '+(src.last||'')).trim();
  const title = src.title ? src.title+' ' : '';
  ct.contacts[contactIdx].name = title + name;
  ct.contacts[contactIdx].phone = src.phone || '';
  ct.contacts[contactIdx].email = src.email || '';
  renderMeetingEditorBody();
}
```

- [ ] **Step 3: Test and commit**

Verify:
- Contact picker dropdown appears next to each contact name
- Selecting from picker fills name, phone, email
- Manual typing still works
- Both CSC and project contact lists populate correctly

```bash
git add energy-department.html
git commit -m "Add contact picker dropdown in meeting editor for project and CSC contacts"
```

---

## Task 12: Meetings Tab — PDF Preview

Split the meeting editor into two panes with a live PDF preview.

**Files:**
- Modify: `energy-department.html:3458-3473` (meetingModal HTML)
- Modify: `energy-department.html:11882` (renderMeetingEditorBody — add preview trigger)
- Modify: `energy-department.html:12328+` (buildMeetingPDF — add preview mode)

- [ ] **Step 1: Widen the modal and add two-pane layout**

Find the meeting modal (line 3458). Change the modal width and add a two-pane layout:

Replace:
```html
<div class="modal" style="width:920px;max-height:92vh">
    <div class="modal-hdr">
      <span class="modal-title" id="meetingModalTitle">New Meeting Agenda</span>
      <button class="modal-x" onclick="closeMeetingModal()">✕</button>
    </div>
    <div class="modal-body" id="meetingModalBody" style="overflow-y:auto;max-height:68vh"></div>
```
With:
```html
<div class="modal" style="width:min(1200px,92vw);max-height:92vh">
    <div class="modal-hdr">
      <span class="modal-title" id="meetingModalTitle">New Meeting Agenda</span>
      <button class="modal-x" onclick="closeMeetingModal()">✕</button>
    </div>
    <div style="display:flex;flex:1;min-height:0;overflow:hidden">
      <div class="modal-body" id="meetingModalBody" style="overflow-y:auto;flex:1;min-width:0;max-height:68vh;padding:16px"></div>
      <div id="mtgPreviewPane" style="width:420px;flex-shrink:0;border-left:1px solid var(--border);background:var(--s1);overflow:hidden;display:flex;flex-direction:column">
        <div style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">PDF Preview</div>
        <iframe id="mtgPreviewFrame" style="flex:1;border:none;background:#fff"></iframe>
      </div>
    </div>
```

- [ ] **Step 2: Add preview rendering with debounce**

Add after `renderMeetingEditorBody`:

```javascript
let _mtgPreviewTimer = null;
function mtgSchedulePreview(){
  clearTimeout(_mtgPreviewTimer);
  _mtgPreviewTimer = setTimeout(mtgRenderPreview, 500);
}

function mtgRenderPreview(){
  if(!_editingMeeting) return;
  const frame = document.getElementById('mtgPreviewFrame');
  if(!frame) return;
  try {
    // Sync fields from DOM before building preview
    const nick = document.getElementById('mtg-nickname');
    if(nick) _editingMeeting.projectNickname = nick.value;
    const dt = document.getElementById('mtg-date');
    if(dt) _editingMeeting.date = dt.value;
    const hd = document.getElementById('mtg-heading');
    if(hd) _editingMeeting.sectionHeading = hd.value;
    // Build PDF as data URI
    const doc = buildMeetingPDF(_editingMeeting, true); // true = return doc instead of saving
    if(doc){
      const uri = doc.output('datauristring');
      frame.src = uri;
    }
  } catch(e){
    console.warn('Preview error:', e);
  }
}
```

- [ ] **Step 3: Modify buildMeetingPDF to support preview mode**

Find `buildMeetingPDF` (line 12328). Change its signature:

From:
```javascript
function buildMeetingPDF(m){
```
To:
```javascript
function buildMeetingPDF(m, returnDoc){
```

At the end of the function, find where it calls `doc.save(...)`. Replace with:
```javascript
if(returnDoc) return doc;
doc.save(filename);
```

Where `filename` is whatever the current save filename is.

- [ ] **Step 4: Trigger preview on editor render and on input changes**

At the end of `renderMeetingEditorBody`, add:
```javascript
mtgSchedulePreview();
```

Add `oninput="mtgSchedulePreview()"` to the key editor fields (nickname, date, heading inputs) so the preview updates as the user types. Also call `mtgSchedulePreview()` at the end of topic/contact change functions (`mtgAddTopic`, `mtgRemoveTopic`, `mtgAddContact`, `mtgRemoveContact`, `mtgUpdateTopic`, `mtgUpdateContact`, `mtgAddSubItem`, `mtgRemoveSubItem`, `mtgUpdateSubItem`, `mtgPickContact`).

- [ ] **Step 5: Test and commit**

Verify:
- Meeting editor shows two panes — form on left, PDF preview on right
- Preview updates ~500ms after typing
- Adding/removing topics updates preview
- Changing contacts updates preview
- PDF button still downloads the file

```bash
git add energy-department.html
git commit -m "Add live PDF preview pane to meeting editor"
```

---

## Task 13: Final — Update Decisions File and Push

**Files:**
- Modify: `dashboardlogic37.md` (OneDrive)
- Copy: `energy-department.html` to production

- [ ] **Step 1: Update decisions file**

Append to `dashboardlogic37.md` documenting all changes from this implementation.

- [ ] **Step 2: Copy to production**

```bash
cp "C:\Users\Matt Miller\AI\companydashboard\energy-department.html" "C:\Users\Matt Miller\OneDrive - Control Service Company\AI\production\energy-department.html"
```

- [ ] **Step 3: Push to GitHub**

```bash
cd "C:\Users\Matt Miller\AI\companydashboard"
git push
```
