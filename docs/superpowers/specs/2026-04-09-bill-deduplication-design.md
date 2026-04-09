# Bill Deduplication — Design Spec

## Problem

When re-extracting the same PDF (or extracting a PDF with bills that already exist in the system), there's no check for duplicates. Bills can be saved twice to `en_pdf_bills` or double-assigned to meters. The user has no way to know which extracted bills already exist, compare old vs new values, or selectively update fields (e.g., after a rebill).

## When Detection Runs

At **extraction time**, immediately after `extractAll()` finishes and before anything is saved. Each extracted bill is compared against:
1. All `meter.bills` across all projects/buildings (assigned bills)
2. All records in `en_pdf_bills` (unassigned saved bills)

## Matching Logic

A bill is a duplicate when it matches on **primary identity fields**:

| Priority | Field | Notes |
|----------|-------|-------|
| Primary | AccountNumber | Normalized: strip spaces/dashes, lowercase |
| Primary | BillingPeriodStart + BillingPeriodEnd | Exact date match |
| Primary | Normalized billing period | e.g., "January 2025" — catches date format differences |
| Secondary | MeterNumber | If available on both sides |
| Verification | MeterReadStart, MeterReadEnd | Confirms the match but doesn't determine it |

**Match requires:** AccountNumber match AND (BillingPeriod match OR normalized period match). MeterNumber narrows the match when multiple meters share an account. MeterReadStart/End are shown in the comparison but don't affect matching.

## UI: Summary Banner

When any duplicates are found, a yellow banner appears above the extraction output (in the pdfAIBox area):

```
⚠ 4 of 32 bills already exist — 3 assigned to USD #416 Electric, 1 in Saved Bills
[Skip All Duplicates] [Overwrite All] [Merge All]
```

Bulk actions:
- **Skip All** — mark all duplicates as "skip" (won't save when Save All is clicked)
- **Overwrite All** — all new values replace existing for every duplicate
- **Merge All** — fill empty fields from new data, keep existing non-empty fields

## UI: Billing Period Pills

Duplicate bills get a **yellow dot** indicator on their pill (right side, no text change). This is separate from the existing red ⚠ for sum mismatches. A bill can have both indicators.

## UI: Inline Field Indicators

When viewing a duplicate bill's extracted fields (left column):

- Fields where the new value **differs from existing** get:
  - **Yellow text** (instead of the normal teal/green)
  - A small **ⓘ icon** next to the field label
  - **Hover tooltip** on the ⓘ showing: "Existing: $1,983.22" (the current stored value)
- Fields that match show normally (no indicator)
- A **PDF indicator** row in the extracted fields section shows whether the existing bill has a PDF stored. Clicking it opens the stored PDF (rendered via PDF.js for just that billing period's pages).

## UI: Comparison Modal

Clicking a yellow-dotted pill opens a modal for detailed comparison. The modal contains:

### Header
- Title: "⚠ Duplicate Bill — 11/01/2024 to 12/01/2024"
- Close button (✕)

### Action Bar (TOP of modal, not bottom)
- **Apply Selected** button (primary action) — saves the field selections
- **Skip** button — don't update this bill
- Navigation: "← Prev | Duplicate 2 of 4 | Next →"

### Match Info
- Location: "USD #416 → Main Building → Electric Meter"
- Match basis: "Account + Period + Meter Reads ✓"
- PDF status: "📄 PDF stored (pages 3-4)" or "No PDF stored" — clickable to view

### Comparison Table

Three columns: **Field | Existing | New (extracted)**

- **Matching fields** shown in muted gray
- **Differing fields** highlighted with amber background
- **Per-field selection:** Click on the Existing or New value to select it. Selected value gets a green left border. Unselected value fades to lower opacity. **New values are selected by default.**
- Differing fields sorted to the top of the table

### Footer
- Field diff count: "3 of 24 fields differ — possible rebill"

## Data Flow

### On Extraction Complete

```
extractAll() returns bills[]
    ↓
_checkDuplicates(bills) runs:
    - For each bill, search meter.bills + en_pdf_bills for matches
    - Build dupMap: { billIndex → { existing, location, hasPDF, pdfKey, matchFields, diffFields } }
    - Store on window._pdfDupMap
    ↓
renderMultiBillUI() checks dupMap:
    - Adds yellow dots to pills
    - Adds summary banner if dupMap has entries
    ↓
renderPDFFields() checks dupMap:
    - Adds yellow text + ⓘ icons on differing fields
    - Adds PDF indicator row
```

### On Save (Save All or individual)

```
For each bill being saved:
    ↓
Check dupMap[index]:
    - If no duplicate → save normally (existing flow)
    - If duplicate + action "skip" → don't save
    - If duplicate + action "overwrite" → replace all fields on existing record
    - If duplicate + action "merge" → fill empty fields only
    - If duplicate + per-field selections → apply only selected new values to existing record
    ↓
After applying:
    - Remove yellow dot from pill
    - Clear dupMap entry
    - Update badge count
```

### Per-Page PDF Storage

PDFs are stored once (full file) in IndexedDB. Each bill record stores `pdfPageStart` and `pdfPageEnd` so `viewSavedPDF()` renders only the relevant pages. This is already implemented — no changes needed for PDF storage. The new work is:
- Showing the PDF status indicator in extracted fields and in the modal
- Making it clickable to view the stored PDF for the existing bill

## Existing Code Touchpoints

| Area | File:Lines | Change |
|------|-----------|--------|
| Duplicate check function | New function `_checkDuplicates()` | Searches meter.bills + en_pdf_bills |
| renderMultiBillUI | ~16914-16996 | Add yellow dots, summary banner |
| renderPDFFields | ~17022-17548 | Add yellow text, ⓘ icons, PDF indicator |
| selectMultiBill | ~16998-17006 | Open modal if duplicate |
| savePDFAllBills | ~17007-17021 | Check dupMap, apply per-bill actions |
| _saveSinglePDFBill | ~17921-17939 | Respect skip/overwrite/merge per field |
| confirmAutoAssign | ~16070-16143 | Run dup check before auto-assign |
| New: modal HTML | Insert after savedBillsModal | Comparison modal markup |
| New: modal JS | After renderPDFFields | Modal rendering + per-field toggle logic |

## What's NOT in Scope

- Cross-account duplicate detection (different account numbers, same period)
- Fuzzy date matching (overlapping but non-identical periods)
- Automatic resolution without user review
- Changes to the Saved Bills modal (it already filters assigned bills)
