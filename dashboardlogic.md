# CompanyHub — Dashboard Logic & Key Decisions

## Last Updated
2026-03-04

---

## Sidebar Architecture

### Decision: Each page has its own contextual sidebar
- **index.html (Dashboard):** Shows all sections — DASHBOARD, SERVICE, ENERGY — as anchor links navigating to the respective department pages.
- **service-department.html:** Shows SERVICE items (Personnel, PM Schedule, Dispatch Board), REPORTS (Performance, Time Logs), TOOLS (O365 Sync). Items use `onclick="setView()"` to switch internal tab panels.
- **energy-department.html:** Shows a single ENERGY section with all energy tools. Items use `onclick="sv()"` to switch internal tab panels.

### Decision: Energy Department sidebar is the visual reference standard
- Single section label style (e.g., "ENERGY", "SERVICE")
- Items are `<button class="s-item">` elements (not `<div>` or `<a>` unless navigating cross-page)
- Active item highlighted with `border-left-color: var(--accent)`
- Badge counts shown inline via `<span class="s-badge">`

### Decision: Index sidebar links use `<a class="s-item" href="...">` for cross-page navigation
- Dashboard sidebar items that navigate to service-department.html or energy-department.html are anchor tags, not buttons.
- Items that stay on the same page (e.g., Overview) use `onclick="setView()"`.

### Decision: Index sidebar Energy section shows a curated subset of energy tools
- Shown: PDF/OCR, Weather Normalize, Baseline, Energy Savings, WebCTRL
- Not all energy tools listed (keeps dashboard sidebar concise)
- **Sidebar tools are page-specific — do NOT change sidebar items to match another page**

## Full-Height Layout Fix

### Decision: All pages must include `html,body{height:100%;overflow:hidden;}` in their page-specific styles
- Energy department already had this rule in its own `<style>` block
- index.html and service-department.html were missing it — only `body` had `height:100%` from the shared CSS, but `html` did not
- Without `html` also set to `height:100%`, the flex column chain (html → body → #app → .app-wrap) breaks and the sidebar/content area does not fill the full browser viewport below the tabs
- Fix: Added `html,body{height:100%;overflow:hidden;}` at the top of each page's own `<style>` block

### Decision: Service sidebar uses `<div class="s-item">` for internal views
- Kept as divs (matching original) — may be refactored to buttons for consistency with energy dept in a future pass.

---

## Sidebar Items Reference

### index.html sidebar
- DASHBOARD: Overview (active, setView)
- SERVICE: Personnel → service-department.html, PM Schedule (badge: 57) → service-department.html, Dispatch Board → service-department.html
- ENERGY: PDF/OCR → energy-department.html, Weather Normalize → energy-department.html, Baseline → energy-department.html, Energy Savings → energy-department.html, WebCTRL → energy-department.html

### service-department.html sidebar
- SERVICE: Personnel (badge), PM Schedule (badge), Dispatch Board
- REPORTS: Performance, Time Logs
- TOOLS: O365 Sync

### energy-department.html sidebar
- ENERGY: Home, Projects (with project folders), PDF/OCR, Utility Data, Weather & Normalize, Baseline, Energy Savings, District Calendar, Equipment, Drawings, Spec Writer, Contracts, WebCTRL

---

## Topbar
- Shows user chip with name + current department label
- Sync to Outlook button always visible
- Notification bell + Sign Out always visible
- Department tabs: Dashboard | Service Department | Energy Department

## Dept Tabs
- Active tab underlined with `var(--accent)` color
- All three pages always show all three tabs for cross-navigation

---

## Data & Storage
- Uses localStorage for persistence (backup/restore)
- `ch_settings` key stores accent color, theme, default login screen
- `ch_theme` key stores light/dark mode
- `ch_user` in sessionStorage tracks logged-in user

---

## Styling Conventions
- Dark theme default; light theme via `data-theme="light"` on `<html>`
- Accent color: `--accent: #3b82f6` (blue) by default, user-configurable
- Font: Outfit (UI) + JetBrains Mono (badges/code)
- Sidebar width: 220px fixed
- Topbar height: 54px sticky

---

## Commit Notes Log
| Date | File | Change |
|------|------|--------|
| 2026-03-04 | service-department.html | Updated sidebar to match Energy Dept visual style — consistent section labels, spacing, and item structure |
| 2026-03-04 | index.html | Updated sidebar Energy section to include all items matching energy-department.html sidebar |
