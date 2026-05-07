# Feedback Widget — data-fb Attribute Index

Reference for all `data-fb` attributes used by the feedback widget. When a feedback item arrives with a `dataFb` value, use this index to find the exact element and its render code.

**Format:** `data-fb="page.section.element"`

**Last updated:** 2026-05-07

---

## index.html (21 attributes)

### Navigation & Layout
| data-fb | Element | Description |
|---------|---------|-------------|
| `index.dept-nav` | `<nav class="dept-nav">` | Top navigation bar (Dashboard, Service, Energy tabs) |
| `index.sidebar` | `<aside class="sidebar">` | Left sidebar with nav items, clock, settings |
| `index.notifications` | `<div id="notifPanel">` | Notification panel |
| `index.calendar` | `<div class="cal-widget">` | Calendar widget |

### Stat Cards
| data-fb | Element | Description |
|---------|---------|-------------|
| `index.stats` | `<div class="stats-row">` | Container for all stat cards |
| `index.stat-card.departments` | `<div class="stat-card">` | Departments count card |
| `index.stat-card.staff` | `<div class="stat-card">` | Service Staff count card |
| `index.stat-card.sa` | `<div class="stat-card">` | SA Records count card |
| `index.stat-card.projects` | `<div class="stat-card">` | Energy Projects count card |

### Department Cards
| data-fb | Element | Description |
|---------|---------|-------------|
| `index.dept-cards` | `<div class="dept-grid">` | Container for department cards |
| `index.dept-card.service` | `<a class="dept-card blue">` | Service Department card (links to service-department.html) |
| `index.dept-card.energy` | `<a class="dept-card teal">` | Energy Department card (links to energy-department.html) |

### Quick Access Cards
| data-fb | Element | Description |
|---------|---------|-------------|
| `index.quick-access` | `<div class="quick-grid">` | Container for quick-access cards |
| `index.quick-card.personnel` | `<a class="quick-card">` | Personnel shortcut |
| `index.quick-card.pm-schedule` | `<a class="quick-card">` | PM Schedule shortcut |
| `index.quick-card.dispatch` | `<a class="quick-card">` | Dispatch Board shortcut |
| `index.quick-card.pdf` | `<a class="quick-card">` | PDF / OCR shortcut |
| `index.quick-card.weather` | `<a class="quick-card">` | Weather Normalize shortcut |
| `index.quick-card.baseline` | `<a class="quick-card">` | Energy Baseline shortcut |
| `index.quick-card.spec-writer` | `<a class="quick-card">` | Spec Writer shortcut |
| `index.quick-card.webctrl` | `<a class="quick-card">` | WebCTRL shortcut |

---

## service-department.html (33 attributes)

### Layout & Navigation
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.sidebar` | `<aside class="sidebar">` | Left sidebar |
| `service.staff` | `<div id="view-schedule">` | Personnel view (tab panel) |
| `service.pm-schedule` | `<div id="view-pm">` | PM Schedule view (tab panel) |
| `service.dispatch` | `<div id="view-dispatch">` | Dispatch view (tab panel) |

### Personnel View — Stat Cards
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.stats` | `<div class="stats-row">` | Personnel stats container |
| `service.stat-card.on-duty` | `<div class="stat-card">` | On Duty Today count |
| `service.stat-card.leave` | `<div class="stat-card">` | On Leave count |
| `service.stat-card.off` | `<div class="stat-card">` | Off Today count |
| `service.stat-card.total` | `<div class="stat-card">` | Total Staff count |

### Personnel View — Controls & Table
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.add-employee-btn` | `<button onclick="openStaffModal()">` | + Add Employee button |
| `service.filter.all` | `<button id="fa">` | All filter button |
| `service.filter.on-duty` | `<button id="fon">` | On Duty filter button |
| `service.filter.leave` | `<button id="flv">` | Leave filter button |
| `service.personnel-table` | `<table class="sched-tbl">` | Personnel schedule table |
| `service.staff-calendar` | `<div id="staffCalCard">` | Staff calendar card |

### PM View — Stat Cards
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.pm-stats` | `<div class="stats-row">` | PM stats container |
| `service.stat-card.sa-records` | `<div class="stat-card">` | SA Records count |
| `service.stat-card.this-month` | `<div class="stat-card">` | This Month count |
| `service.stat-card.next-7` | `<div class="stat-card">` | Next 7 Days count |
| `service.stat-card.active-techs` | `<div class="stat-card">` | Active Techs count |

### PM View — Controls & Table
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.add-sa-btn` | `<button onclick="openPMModal()">` | + Add SA Record button |
| `service.pm-legend` | `<div class="pm-legend">` | PM calendar legend |
| `service.pm-calendar` | `<div id="pmCalCard">` | PM calendar card |

### Service Agreements
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.agreements` | `<div class="card">` | Service agreements section |
| `service.agreement-filter.tech` | `<select id="techFilter">` | Tech filter dropdown |
| `service.agreement-search` | `<input id="saSearch">` | Search input |
| `service.agreement-filter.type` | `<select id="pmTypeFilter">` | PM type filter dropdown |
| `service.agreement-table` | `<table class="sa-tbl">` | Service agreements table |

### Dispatch View
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.dispatch-new-btn` | `<button onclick="openDispatchModal()">` | + New Work Order button |
| `service.dispatch-table` | `<table class="dispatch-tbl">` | Dispatch/work orders table |

### Modals
| data-fb | Element | Description |
|---------|---------|-------------|
| `service.modal.staff` | `<div id="staffModal">` | Add/Edit Employee modal |
| `service.modal.pm` | `<div id="pmModal">` | Add/Edit SA Record modal |
| `service.modal.dispatch` | `<div id="dispatchModal">` | Add/Edit Work Order modal |

---

## ems-leads.html (40 attributes)

### Header & Tabs
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.import-csv-btn` | `<button onclick="openImportModal()">` | Import CSV button (header) |
| `ems.new-lead-btn` | `<button onclick="openNewLeadModal()">` | + New Lead button (header) |
| `ems.tab.pipeline` | `<button class="ntab">` | Pipeline view tab |
| `ems.tab.table` | `<button class="ntab">` | All Leads table view tab |
| `ems.tab.followups` | `<button class="ntab">` | Follow-ups view tab |
| `ems.tab.analytics` | `<button class="ntab">` | Analytics view tab |

### Sidebar — Stage Filters
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.sidebar` | `<div class="sidebar">` | Left sidebar container |
| `ems.sidebar.all-leads` | `<div id="sb-all">` | All Leads filter |
| `ems.sidebar.prospect` | `<div id="sb-prospect">` | Prospect stage filter |
| `ems.sidebar.contacted` | `<div id="sb-contacted">` | Contacted stage filter |
| `ems.sidebar.qualifying` | `<div id="sb-qualifying">` | Qualifying stage filter |
| `ems.sidebar.proposal` | `<div id="sb-proposal">` | Proposal stage filter |
| `ems.sidebar.negotiating` | `<div id="sb-negotiating">` | Negotiating stage filter |
| `ems.sidebar.won` | `<div id="sb-won">` | Won stage filter |
| `ems.sidebar.lost` | `<div id="sb-lost">` | Lost stage filter |

### Sidebar — Priority & Tools
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.sidebar.priority-high` | `<div class="s-item">` | High priority filter |
| `ems.sidebar.priority-medium` | `<div class="s-item">` | Medium priority filter |
| `ems.sidebar.priority-low` | `<div class="s-item">` | Low priority filter |
| `ems.sidebar.import` | `<div class="s-item">` | Import sidebar shortcut |
| `ems.sidebar.export` | `<div class="s-item">` | Export sidebar shortcut |

### Pipeline View
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.pipeline` | `<div id="view-pipeline">` | Pipeline view container |
| `ems.stats` | `<div id="statsRow">` | Pipeline stats row |
| `ems.kanban` | `<div class="pipeline-wrap">` | Kanban board container |
| `ems.pipeline-search` | `<input id="pipeSearch">` | Pipeline search input |
| `ems.pipeline-filter.csc` | `<select id="pipeFilterCSC">` | CSC contact filter |

### Table View
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.table` | `<div id="view-table">` | Table view container |
| `ems.table-search` | `<input id="tableSearch">` | Table search input |
| `ems.table-filter.stage` | `<select id="tableStage">` | Stage filter dropdown |
| `ems.table-filter.priority` | `<select id="tablePri">` | Priority filter dropdown |
| `ems.table-filter.csc` | `<select id="tableCSC">` | CSC contact filter |
| `ems.table-body` | `<tbody id="tableBody">` | Table body (rows) |

### Follow-ups View
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.followups` | `<div id="view-followups">` | Follow-ups view container |
| `ems.followup-stats` | `<div id="followupStats">` | Follow-up stats row |
| `ems.followup-list` | `<div id="followupList">` | Follow-up items list |

### Analytics View
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.analytics` | `<div id="view-analytics">` | Analytics view container |
| `ems.analytics-content` | `<div id="analyticsContent">` | Analytics charts/content |

### Modals & Drawers
| data-fb | Element | Description |
|---------|---------|-------------|
| `ems.modal.new-lead` | `<div id="newLeadModal">` | New Lead modal |
| `ems.modal.import` | `<div id="importModal">` | CSV Import modal |
| `ems.drawer` | `<div id="leadDrawer">` | Lead detail drawer (slide-in panel) |

---

## energy-department.html (pending)

Not yet tagged — will be added when the file is available. Expected attributes will follow the `energy.section.element` pattern, mapping to the existing `data-ui-id` attributes already in the page.

---

## Naming Convention

```
data-fb="page.section.element"
```

- **page:** `index`, `service`, `energy`, `ems`
- **section:** logical group (sidebar, stats, modal, tab, filter, etc.)
- **element:** specific item (on-duty, tech, staff, etc.)

Dots separate hierarchy levels. Hyphens separate words within a level.

## How to Add New Attributes

1. Pick the appropriate `page.section.element` name following existing patterns
2. Add `data-fb="..."` to the element's opening tag
3. Add an entry to this index under the correct page and section
4. If the element is dynamically generated in JS, add the attribute in the template literal

## Fallback Behavior

If a user clicks an element without `data-fb`, the feedback widget walks up the DOM to find the nearest ancestor with `data-fb`, then appends a CSS selector path for the specific child element. The feedback JSON will show the ancestor's `data-fb` value plus the relative selector.
