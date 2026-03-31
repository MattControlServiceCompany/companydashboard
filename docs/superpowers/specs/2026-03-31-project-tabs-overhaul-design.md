# Project Tabs Overhaul — Design Spec

**Date:** 2026-03-31
**Scope:** energy-department.html — Project detail view tabs
**Status:** Approved

---

## Overview

Six coordinated changes to the project detail view in energy-department.html. Fixes data-flow bugs, adds a project dashboard tab, reworks the header, and redesigns several tab experiences to match how CSC energy services projects actually work.

All changes are in the single `energy-department.html` file (vanilla JS/CSS/HTML, no build tools, localStorage data layer).

---

## 1. Project Dashboard Tab (New)

### Purpose

Default landing tab when opening a project. Provides immediate situational awareness: how are the buildings performing vs baseline, and what's coming up on the calendar.

### Layout

Two-column on viewports > 900px, stacks vertically on narrow screens.

### Left Column — Performance Summary

**Rolled-up savings card** at top:
- Total baseline annual cost (sum of all buildings' baseline utility costs)
- Total current annual cost (latest 12 months)
- Total savings: absolute $ and percentage
- Data source: `getUDBldgs(projId)` — iterate each building's electric and gas meters, sum baseline vs current year costs

**Per-building table** below the card:

| Column | Source |
|--------|--------|
| Building | `b.name` |
| Baseline $/yr | Sum of baseline bills' totalCost across electric + gas meters |
| Current $/yr | Sum of most recent 12 months' totalCost |
| Savings $ | Baseline - Current |
| Savings % | (Baseline - Current) / Baseline * 100 |
| Status | "On Track" if actual savings >= 80% of `p.savings` (est. savings/yr), "Below Target" if positive but under 80%, "Over Budget" if current > baseline, "No Data" if insufficient bills |

If no buildings have utility data, show a placeholder directing user to add buildings and utility data.

### Right Column — Project Calendar

**Month-view grid:**
- Current month displayed by default
- Prev/next month arrows
- Days with events show a colored dot
- Clicking a date shows event list below the calendar

**Event sources (project-scoped only):**
- `p.meetings` — agendas and minutes, plotted on their `date` field
- `p.recurringMeetings` — calculate next N upcoming dates using `getNthWeekdayOfMonth` logic already in codebase
- Tasks from `tasks` array filtered to `t.projId === projId` — plotted on `t.due` field
- `p.districtCalendar` events (from reworked District Calendar tab)

**Color coding:**
- Meetings: accent color
- Tasks: amber
- District calendar events: teal

### Tab Position

Dashboard becomes the first tab button, replacing Notes. Tab order:
1. Dashboard (new, default active)
2. Notes
3. Tasks
4. Contacts
5. Buildings
6. Utility Data
7. Equipment
8. HVAC Load Est
9. Energy Graphics
10. District Calendar
11. Energy Savings
12. Contracts
13. Meetings
14. Documents

### Data Access

Uses `getUDBldgs(projId)` for building/meter/bill data (same as Utility Data tab). Does NOT use `p.buildings` — that path is broken for utility data and this tab must not repeat that mistake.

Baseline detection: iterate meter bills, check `m.baseline.months` object. If baseline months are defined, use those bills. Otherwise fall back to all bills as baseline (same logic as `renderBuildingStatsPane`).

---

## 2. Header Compression

### Problem

Hiding the entire `pd-hero` section on data-intensive tabs is jarring. The user loses all project context.

### Solution

Replace full hide with a compressed single-line bar for data-intensive tabs.

### Compressed State

A ~36px bar displayed between the tab buttons and the tab content. Contains:

**Project Name** (bold, truncated) · SA# · Est. Savings/yr · Start · End · Open Tasks · N buildings (X sf total)

All inline, monospace for numbers, separated by subtle dividers. No progress bar, no edit/delete buttons, no info grid.

### Implementation

- New element `pd-hero-compact` rendered inside `renderDetail()`, initially hidden
- `FULLWIN_TABS = ['savings','hvacload','utility','energygfx']`
- In `sPTab()`:
  - Full-window tabs: `pd-hero.style.display='none'`, `pd-hero-compact.style.display='flex'`
  - Other tabs: `pd-hero.style.display=''`, `pd-hero-compact.style.display='none'`

### Content Mapping

| Field | Source |
|-------|--------|
| Project Name | `p.name` |
| SA# | `p.sa` or '—' |
| Est. Savings/yr | `p.savings` formatted as currency |
| Start | `p.start` formatted as 'MMM D, YYYY' |
| End | `p.end` formatted as 'MMM D, YYYY' |
| Open Tasks | Count of tasks where `t.projId===p.id && !t.done` |
| Buildings | `getUDBldgs(p.id).length` + sum of `b.sqft` |

---

## 3. Bug Fixes

### 3a. Energy Graphics — Data Path

**Root cause:** `egfxRefresh` on line 15674 uses `p.buildings||[]` but utility data lives in `utilityData[projId].buildings` accessed via `getUDBldgs(projId)`.

**Fix:**
- Change `const bldgs = p.buildings||[]` to `const bldgs = getUDBldgs(projId)`
- Update meter field references: `m.type==='electric'` becomes `m.commodity==='Electric'`, `m.type==='gas'` becomes `m.commodity==='Gas'`
- Update bill field references to match utility data structure: ensure `bill.kwh`, `bill.kw`/`bill.demKW`, `bill.therms` paths are checked with fallbacks

**EUI cards improvement:**
- Add a 4th card: "Total Cost Savings" showing baseline annual cost vs current annual cost with delta
- Cards that have no data show "No baseline data" instead of "—"

### 3b. HVAC Load Est — Blank Tab

**Root cause:** The container `hvl-container-${p.id}` is created via template literal in `renderDetail()`. The `initHvacLoadTab(projId)` function looks for this container by ID. Need to verify the DOM element exists when init fires.

**Fix:**
- Confirm container ID matches between render and init
- Add `requestAnimationFrame` wrapper if needed to ensure DOM is ready
- Test that building selector, baseline table, and method panels all render

---

## 4. Energy Savings — Per-Measure Rates with Expandable Detail Row

### Problem

The "Baseline Utility Rates by Building" table at the top takes too much space and doesn't map to how rates actually vary (per measure, not per building). The sqft field was added but never used in calculations.

### Changes

**Remove** the "Baseline Utility Rates by Building" card from `_renderSavingsContent` entirely.

**Add expandable detail row per measure:**

Each measure row gets a chevron toggle on the left. Clicking it reveals a detail panel below the row.

### Detail Panel Contents

```
[Rate fields]                              [Sqft + Intensity]
kWh $/Summer: [____]  kWh $/Winter: [____]   Sq Ft: [____]
kW $/Summer:  [____]  kW $/Winter:  [____]   kWh/sf saved: 2.3
Gas $/Therm:  [____]                          $/sf saved: $0.18

                              [Reset to Building Defaults]
```

### Data Model

Each measure gains a `rates` object:
```javascript
m.rates = {
  kwhSummer: 0.0681,
  kwhWinter: 0.0582,
  kwSummer: 16.997,
  kwWinter: 11.797,
  thermRate: 0.798
}
```

### Rate Initialization

When a measure is created (via `addSavingsMeasure`, `hvacLoadCreateMeasure`, or calc templates):
1. Look up the building: `getUDBldg(projId, m.bldgId)`
2. Calculate avg rates from the building's baseline bills (same logic as `renderBuildingStatsPane`'s seasonal rate calculation)
3. Set `m.rates` with those defaults

When building dropdown changes on a measure:
1. Recalculate rates from new building's baseline bills
2. Update `m.rates`
3. Update `m.sqft` (existing behavior)

### Calculation Change

`calcProjSavingsMatrix` changes from:
```javascript
const rates = sd.blRates[m.bldgId]||{};
```
to:
```javascript
const rates = m.rates||{};
```

Same seasonal logic applies (SUMMER_MOS check for kWh/kW rates).

### Backward Compatibility

On first render, if a measure has no `m.rates` but `sd.blRates[m.bldgId]` exists, copy the building rates to the measure. This migrates existing data silently.

### Sqft Usage

The detail panel shows intensity metrics:
- `kWh/sf saved` = annual kWh savings / m.sqft
- `$/sf saved` = m.totalDollar / m.sqft

These are display-only — the core savings calculation remains absolute (monthly kWh * rate + monthly kW * rate + monthly gas * rate). Sqft provides context, not a multiplier.

---

## 5. District Calendar Rework

### Remove

- Occupied start/end time inputs
- Heat/cool setback temperature inputs
- WebCTRL exception schedule output format
- The `parseProjDistCal` function's setback-focused output

### New Flow

1. **Input:** Paste calendar text OR upload a PDF (using existing PDF.js text extraction)
2. **Parse:** Extract dates and event names. Look for patterns like:
   - "No School" / "No Students"
   - "Holiday" / named holidays (MLK, Presidents Day, etc.)
   - "Break" (Spring Break, Winter Break, Thanksgiving Break)
   - "Early Release" / "Early Dismissal"
   - "Teacher In-Service" / "Professional Development"
   - "First Day" / "Last Day" of school
   - Date formats: MM/DD, MM/DD/YYYY, Month DD, etc.
3. **Display** in editable data table:

| Date | Event Name | Type |
|------|-----------|------|
| 01/20/2025 | Martin Luther King Jr Day | Holiday |
| 03/14/2025 | Spring Break | Break |
| ... | ... | ... |

4. **Manual editing:** Add row, edit any cell, delete row
5. **Type dropdown:** Holiday, Break, Early Release, Teacher Day, First/Last Day, Other

### Data Storage

```javascript
p.districtCalendar = [
  { id: timestamp, date: '2025-01-20', name: 'Martin Luther King Jr Day', type: 'Holiday' },
  ...
]
```

Saved to `en_projects` via `sset()` on any change.

### Data Consumption

- Project Dashboard calendar reads `p.districtCalendar` for event dots
- Future: HVAC Load Est could reference unoccupied days (not in this build)

---

## 6. Meetings Tab Rework

### Header Simplification

Remove from the meetings tab header:
- Settings button (gear icon)
- Recurring button

New header: `Filter pills (All | Agendas | Minutes)` on the left, `+ New Agenda` button on the right.

### Meeting Editor — Recurring Integration

**Remove** the separate `openRecurringSetup` modal.

**Add to the meeting editor** a toggle at the top:
> [ ] Make this a recurring meeting

When toggled on, show inline:
- Pattern: "Every [1st/2nd/3rd/4th] [Monday-Friday] at [time]"
- Auto-generate: [N] days before

This saves to `p.recurringMeetings` on meeting save (same data structure as today).

### Auto-Populate Date from Recurring

When user clicks "+ New Agenda" and a recurring schedule exists:
1. Calculate the next upcoming meeting date from the pattern
2. Pre-fill the date/time field with that date
3. If the next date already has an agenda, calculate the one after that

### Default Topics

New agendas are initialized with:
```javascript
topics: [
  { text: 'Project Status Update', subItems: [] },
  { text: 'Energy Savings Review', subItems: [] },
  { text: 'Upcoming Milestones / Action Items', subItems: [] },
  { text: 'Open Issues', subItems: [] },
  { text: 'Questions?', subItems: [] }  // locked at end
]
```

If `carryForward` is enabled on the recurring schedule, previous meeting's topics are used instead (existing behavior preserved).

### Contact Selection from Project Contacts

Replace blank text inputs for contacts with a hybrid approach:
- Each contact row has a dropdown/autocomplete that lists existing contacts from `p.contacts`
- Selecting from the dropdown fills Name, Phone, Email
- User can still type manually for contacts not in the project
- CSC contacts section: dropdown lists contacts from the meeting template

### PDF Preview

**Split the meeting editor modal into two panes:**
- Left pane: editor form (existing fields, same layout)
- Right pane: live PDF preview

**Preview implementation:**
- Use existing `buildMeetingPDF(m)` function
- Instead of triggering download, render to a data URL via `doc.output('datauristring')`
- Display in an `<iframe>` in the right pane
- Re-render on a debounced timer (500ms after last edit) to avoid lag
- Modal width expands to accommodate both panes (~90vw or max-width 1200px)

### Template Settings Removal

Remove `openMtgTemplateSettings` modal. Template defaults (CSC contacts, section heading, default topics) are established by the first meeting created and stored in `en_meetingTemplates` localStorage key. Editing the template happens through the meeting editor itself — changes to CSC contacts or section heading in any meeting update the template for future meetings.

---

## Implementation Order

1. **Bug fixes first** — Energy Graphics data path, HVAC Load Est blank tab, header compression
2. **Energy Savings** — Per-measure rates, expandable detail row, remove building rates table
3. **District Calendar** — Rework to upload/parse/table flow
4. **Project Dashboard** — New tab with performance summary and calendar
5. **Meetings** — Editor rework, recurring integration, default topics, contact picker, PDF preview

Each step should be independently testable. Steps 1-2 fix existing broken functionality. Steps 3-5 add new capability.

---

## Files Modified

- `energy-department.html` — all changes (HTML, CSS, JS inline)
- `dashboardlogic37.md` — decision log updates

## Files NOT Modified

- `site-ui.css` / `site-ui.js` — no shared shell changes needed
- No new files created (everything is inline in the single HTML file)
