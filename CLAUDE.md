# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


## Repository

- **GitHub:** https://github.com/MattControlServiceCompany/companydashboard
- **Local repo:** `C:\Users\Matt Miller\AI\companydashboard` — run all git commands here
- **OneDrive backup:** `C:\Users\Matt Miller\OneDrive - Control Service Company\AI` — file backup only, NOT a git repo

## Deployment
After completing code changes, always push to GitHub. Never wait for the user to ask.

## Bug Fixing Guidelines
When fixing a bug related to a UI action (e.g., delete, update), check ALL places where that action occurs — modals, tables, lists — not just the first instance found. Ask the user to confirm scope if unclear.
When the user provides a screenshot showing a bug, treat it as the source of truth. Do not argue or re-interpret — fix exactly what the screenshot shows.

## Code Quality
Do not fake or hardcode values for status displays, metrics, or calculated fields. Always read from the real data source. If unsure how to access real data, ask.

## Project Overview

**CompanyHub** is an internal web dashboard for Control Service Company (CSC), a building automation / energy services company in the KC metro area. It is a static frontend app (vanilla HTML/CSS/JS, no build tools or framework) with all data stored in browser `localStorage`. There is no backend.
Always test changes locally before considering work complete.

## File Structure

- **`index.html`** — Main Dashboard with customizable metric cards, Microsoft 365 SSO login (MSAL), and department navigation
- **`energy-department.html`** (~13k lines) — Energy department tool: project management, utility bill data entry, PDF OCR extraction (Tesseract.js + PDF.js), weather normalization, equipment tracking, AI assistant (Claude API)
- **`service-department.html`** — Service department: PM scheduling calendar, service agreements, staff allocation
- **`ems-leads.html`** — EMS (Energy Management Sales) lead/pipeline tracker with Kanban board, CSV import, multi-building support
- **`site-ui.css`** — Shared CSS shell (topbar, sidebar, theming, settings modal styles)
- **`site-ui.js`** — Shared JS logic: clock, backup/restore, reset, settings, theme/accent color, `Store` data layer, `DashboardController`, mobile sidebar, accessibility

## Architecture

### Shared UI Shell (site-ui.css + site-ui.js)
The CSS and JS are shared across pages but are **also copy-pasted inline** into each HTML file's `<style id="site-ui-styles">` block. When updating shared styles/logic, changes must be applied both to the standalone files AND to the inline copies in each HTML file.

### Data Layer
- All data lives in `localStorage` via `sset()`/`sget()` helpers (energy page) and the `Store` object (site-ui.js)
- `Store.get(key)` / `Store.set(key, data)` dispatches `dataUpdated` CustomEvents so the dashboard auto-refreshes
- Key localStorage keys: `en_projects`, `en_pdf_bills`, `sv_saData`, `sv_staffData`, `ems_leads_v1`, `ch_settings`, `ch_theme`

### PDF Extraction Engine (energy-department.html)
- **Two-stage approach**: PDF.js text extraction first (fast, digital PDFs), falls back to Tesseract.js OCR if text < 100 chars (scanned PDFs)
- **Rule-based extraction**: `UTILITY_RULES` array with named rule sets (Evergy, Spire/Laclede Gas, Generic). AI has been removed from PDF/utility extraction — it is 100% local
- To add a new utility provider: add a new object to `UTILITY_RULES` before the Generic entry with `name`, `detect(text)`, and `extract(text)` functions. Generic must stay last as catch-all
- Do not raise confidence threshold above 5 — valid bills may only yield 5-7 fields
- Evergy charge line regex uses multiline end-of-line anchoring (`m` flag). Do not revert to `[^\n]` patterns
- Evergy detection matches on billing text patterns, not logo text (OCR misreads the logo)

### Authentication
- Microsoft 365 SSO via MSAL.js on `index.html` and `service-department.html`
- Demo mode available without credentials
- User stored in `sessionStorage` as `ch_user`
- Default login screen configurable in Settings

### Theming
- CSS custom properties for all colors: `--bg`, `--s1`-`--s4`, `--accent`, `--em`, `--text`, `--text2`, `--text3`
- Dark/light mode via `data-theme` attribute on `<html>`
- Accent color is user-customizable with presets + custom hex picker
- Always use CSS variables — never hardcode hex colors in new components
- Use `showToast()` for user feedback — never `alert()`

### EMS Leads Data Model
- Each lead can have multiple buildings: `lead.buildings = [{id, name, address, city, state, zip, sqft, buildingType, notes}]`
- CSV import supports three duplicate modes: Merge (default), Create separate, Skip duplicates
- Pipeline card shows building count + first building's city/state

## Development Workflow

There are no build steps, linters, or test runners. Open HTML files directly in a browser.

One exception: `test_evergy_regex.js` — run with `node test_evergy_regex.js` before changing any Evergy charge regex. All 24 fields must pass.

### Versioning
- **Live working files**: `OneDrive - Control Service Company/AI/production/` — this is what Matt actually runs
- **Decision log**: `OneDrive - Control Service Company/AI/Dashboard Logic Files/` — architecture notes and coding decisions (dashboardlogic##.md files)
- Numbered folders (`production47`, `production48`, ... `production61`) in OneDrive are older snapshots/backups — do not edit these
- The GitHub repo holds the current working version

## Key Constraints

- **No backend** — all data is localStorage. Do not add a backend unless explicitly requested.
- **PDF bill field mapping**: `kwCost` = BilledKWCharge + TDCCharge; `kwhCost` = On/Off-Peak + ECA + EER + PTS; `otherCost` = CustomerCharge + TaxExemptDelivery + BillOffset; `taxCost` = FranchiseFee. Validation tolerance is $0.10 — do not change.
- **Inline CSS duplication**: site-ui styles exist both in standalone `site-ui.css` and inline in each HTML file. Keep them in sync.
- The `ems-leads.html` page uses different fonts (Syne/DM Sans/DM Mono) and a slightly different token set than the other pages.

