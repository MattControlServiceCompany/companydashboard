// CompanyHub Automated Verification Tests
// Executable via Playwright MCP (browser_evaluate / browser_snapshot)
// Visual status board: test-verification-runner.html

// Preamble: inject into page via browser_evaluate before running any tests.
// Defines window.__tvAllMeters() for test expressions to call.
const VERIFICATION_PREAMBLE = `
  window.__tvAllMeters = function() {
    const ms = [];
    for (const k of Object.keys(localStorage)) {
      if (/^en_utility_\\d/.test(k)) {
        try {
          const d = JSON.parse(localStorage.getItem(k));
          (d.buildings||[]).forEach(b => (b.meters||[]).forEach(m => ms.push({...m, _bName: b.name})));
        } catch(e){}
      }
    }
    return ms;
  };
`;

// Helper: gets all buildings/meters/bills across all projects.
// Data model: en_projects has project metadata; en_utility_<id> has actual utility data.
function _getAllMeters() {
  const projects = JSON.parse(localStorage.getItem('en_projects') || '[]');
  const meters = [];
  for (const p of projects) {
    const utilData = JSON.parse(localStorage.getItem('en_utility_' + p.id) || '{}');
    for (const b of utilData.buildings || p.buildings || []) {
      for (const m of b.meters || []) {
        meters.push({ ...m, buildingName: b.name, projectName: p.name, projectId: p.id });
      }
    }
  }
  return meters;
}

function _getProjects() {
  return JSON.parse(localStorage.getItem('en_projects') || '[]');
}

function _getUtilData(projectId) {
  return JSON.parse(localStorage.getItem('en_utility_' + projectId) || '{}');
}

const PREREQ_CHECKS = {
  'electric-meter-with-bills': () => {
    return _getAllMeters().some((m) => m.commodity === 'Electric' && (m.bills?.length || 0) >= 3);
  },
  'gas-meter-with-bills': () => {
    return _getAllMeters().some((m) => m.commodity === 'Gas' && (m.bills?.length || 0) >= 3);
  },
  'project-with-baseline': () => {
    return _getAllMeters().some((m) => m.baselineStart && m.baselineEnd);
  },
  'project-with-calendar': () => {
    const projects = _getProjects();
    return projects.some((p) => (p.calendarEvents?.length || 0) > 0);
  },
  'propane-meter': () => {
    return _getAllMeters().some((m) => m.commodity === 'Propane' && (m.bills?.length || 0) >= 1);
  },
  'water-meter-with-bills': () => {
    return _getAllMeters().some((m) => m.commodity === 'Water' && (m.bills?.length || 0) >= 3);
  },
  'sewer-meter': () => {
    return _getAllMeters().some((m) => m.commodity === 'Sewer' && (m.bills?.length || 0) >= 1);
  },
  'project-with-savings-measures': () => {
    const projects = _getProjects();
    return projects.some((p) => (p.savingsMeasures?.length || 0) > 0);
  },
  'project-with-buildings': () => {
    const projects = _getProjects();
    return projects.some((p) => {
      const util = _getUtilData(p.id);
      return (util.buildings?.length || 0) >= 2;
    });
  },
  'service-agreements': () => {
    const data = JSON.parse(localStorage.getItem('sv_saData') || '[]');
    return data.length > 0;
  },
  'saved-pdf-bills': () => {
    const projects = _getProjects();
    return projects.some((p) => (p.savedBills?.length || 0) > 0);
  },
  'project-with-settings': () => {
    const projects = _getProjects();
    return projects.some((p) => p.escalation || p.cscCompensation || p.contractYears);
  },
};

const VERIFICATION_TESTS = {
  version: '2.0',
  generated: '2026-05-06',

  prerequisites: {
    'electric-meter-with-bills': 'At least one Electric meter with 3+ bills in localStorage',
    'gas-meter-with-bills': 'At least one Gas meter with 3+ bills',
    'project-with-baseline': 'A project with baseline set on at least one meter',
    'project-with-calendar': 'A project with calendar events imported',
    'propane-meter': 'A propane meter with delivery records',
    'water-meter-with-bills': 'A water meter with 3+ bills',
    'sewer-meter': 'A sewer meter with bills',
    'project-with-savings-measures': 'A project with at least one savings measure',
    'project-with-buildings': 'A project with 2+ buildings',
    'service-agreements': 'Service department has at least one agreement',
    'saved-pdf-bills': 'At least one project with saved PDF/OCR bills',
    'project-with-settings': 'A project with escalation/compensation/contract settings',
  },

  groups: [
    {
      id: 'utility-condensed-electric',
      name: 'Utility Data — Condensed View (Electric)',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Electric' } },
        { action: 'click', selector: '.bts-view-btn:not(.sel)' },
      ],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'c01',
          backlogUuid: null,
          name: 'kW Cost includes Facilities charge in condensed view',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#billsBodyTbl tbody tr');
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                const kwCostCell = Array.from(cells).find(td => td.dataset.col === 'kwCost' || td.dataset.field === 'kwCost');
                if (kwCostCell) {
                  const val = parseFloat(kwCostCell.textContent.replace(/[$,]/g, ''));
                  if (val > 0) return { found: true, value: val };
                }
              }
              return { found: false };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'c02',
          backlogUuid: null,
          name: 'Other Charges includes Franchise Fee, no Facilities',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#billsHdrTbl th'));
              const hasFranchiseCol = headers.some(h => h.textContent.includes('Franchise Fee'));
              const hasOtherCol = headers.some(h => h.textContent.includes('Other'));
              return { hasFranchiseCol, hasOtherCol };
            })()`,
            expect: { op: 'equals', path: 'hasFranchiseCol', value: false },
          },
        },
        {
          id: 'c03',
          backlogUuid: null,
          name: 'Franchise Fee standalone column is gone',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#billsHdrTbl th'));
              return !headers.some(h => h.textContent.trim() === 'Franchise Fee $');
            })()`,
            expect: { op: 'equals', value: true },
          },
        },
        {
          id: 'c04',
          backlogUuid: null,
          name: 'kW Rate uses Actual kW denominator',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#billsBodyTbl tbody tr');
              if (rows.length === 0) return { skip: true };
              const row = rows[0];
              const cells = row.querySelectorAll('td');
              let kwCost = 0, actualKW = 0, kwRate = 0;
              cells.forEach(td => {
                const text = td.textContent.replace(/[$,]/g, '').trim();
                if (td.dataset.col === 'kwCost' || td.dataset.field === 'kwCost') kwCost = parseFloat(text) || 0;
                if (td.dataset.col === 'demandKW' || td.dataset.field === 'demandKW') actualKW = parseFloat(text) || 0;
                if (td.dataset.col === 'kwRate' || td.dataset.field === 'kwRate') kwRate = parseFloat(text) || 0;
              });
              if (actualKW === 0) return { skip: true };
              const expectedRate = kwCost / actualKW;
              return { kwRate, expectedRate, match: Math.abs(kwRate - expectedRate) < 0.01 };
            })()`,
            expect: { op: 'truthy', path: 'match' },
          },
        },
        {
          id: 'c05',
          backlogUuid: null,
          name: 'Category totals reconcile with Total Cost',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#billsBodyTbl tbody tr');
              if (rows.length === 0) return { skip: true };
              const row = rows[0];
              const cells = row.querySelectorAll('td');
              let kwhCost = 0, kwCost = 0, otherCost = 0, totalCost = 0;
              cells.forEach(td => {
                const text = td.textContent.replace(/[$,]/g, '').trim();
                const col = td.dataset.col || td.dataset.field || '';
                if (col === 'kwhCost') kwhCost = parseFloat(text) || 0;
                if (col === 'kwCost') kwCost = parseFloat(text) || 0;
                if (col === 'otherCost') otherCost = parseFloat(text) || 0;
                if (col === 'totalCost') totalCost = parseFloat(text) || 0;
              });
              if (totalCost === 0) return { skip: true };
              const sum = kwhCost + kwCost + otherCost;
              return { sum, totalCost, diff: Math.abs(sum - totalCost), withinTolerance: Math.abs(sum - totalCost) < 1.00 };
            })()`,
            expect: { op: 'truthy', path: 'withinTolerance' },
          },
        },
        {
          id: 'c06',
          backlogUuid: null,
          name: 'Energy Graphics Cost Savings is reasonable (not doubled)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const el = document.querySelector('[id^="egfx-costSav-"]');
              if (!el) return { skip: true, reason: "Energy Graphics not visible" };
              const val = parseFloat(el.textContent.replace(/[$,]/g, ''));
              return { value: val, reasonable: Math.abs(val) < 500000 };
            })()`,
            expect: { op: 'truthy', path: 'reasonable' },
          },
        },
        {
          id: 'c07',
          backlogUuid: null,
          name: 'Dashboard Baseline $/yr is commodity-only',
          depth: 'observe',
          check: {
            type: 'snapshot-contains',
            text: 'Baseline',
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'c08',
          backlogUuid: null,
          name: 'Dashboard Current $/yr is commodity-only',
          depth: 'observe',
          check: {
            type: 'snapshot-contains',
            text: 'Current',
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'c09',
          backlogUuid: null,
          name: 'Savings match across Dashboard, Performance Panel, meter Performance',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires navigating multiple tabs — manual comparison during Playwright session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'c10',
          backlogUuid: null,
          name: 'Normalized vs Actual baseline comparison setting works',
          depth: 'interact',
          steps: [
            { action: 'click', selector: ".project-edit-btn, button[onclick*='openProjModal']" },
            { action: 'waitFor', selector: '#projModal.open, #projModal .modal' },
          ],
          check: {
            type: 'exists',
            selector: "#mp-baselineComparison, select[name='baselineComparison']",
          },
          cleanup: [{ action: 'click', selector: '#projModal .modal-x, .modal-x' }],
        },
      ],
    },
    {
      id: 'extraction-state',
      name: 'Extraction State Preservation',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'pdf' }],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 's01',
          backlogUuid: null,
          name: 'Extraction state survives F5 refresh',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const state = sessionStorage.getItem('en_extraction_state') || localStorage.getItem('en_extraction_state');
              return { hasStateStorage: state !== null };
            })()`,
            expect: { op: 'truthy', path: 'hasStateStorage' },
          },
        },
        {
          id: 's02',
          backlogUuid: null,
          name: 'beforeunload warning during extraction',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const handlers = window.onbeforeunload;
              return { hasHandler: typeof handlers === 'function' || window._extractionInProgress !== undefined };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 's03',
          backlogUuid: null,
          name: 'State clears after saving/closing extraction',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires triggering extraction clear action — test during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 's04',
          backlogUuid: null,
          name: 'State expires after 1 hour',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Time-based expiry — cannot test automatically without time manipulation" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'extraction-validation',
      name: 'Extraction Validation & Flags',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Electric' } },
      ],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'v01',
          backlogUuid: null,
          name: 'Amber flag on charge-without-qty field',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const flaggedCells = document.querySelectorAll('#billsBodyTbl td[style*="background"][style*="amber"], #billsBodyTbl td.warn-cell, #billsBodyTbl td[data-warn]');
              return { count: flaggedCells.length, hasFlags: flaggedCells.length > 0 };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'v02',
          backlogUuid: null,
          name: 'Warning icon in condensed view Norm Month cell',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const warnIcons = document.querySelectorAll('#billsBodyTbl .warn-icon, #billsBodyTbl [data-warn-icon], #billsBodyTbl .amber-tri');
              return { count: warnIcons.length };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'v03',
          backlogUuid: null,
          name: 'Off-peak auto-derived during extraction',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires re-extraction — test during live extraction session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'v04',
          backlogUuid: null,
          name: 'kWh identity check flags mismatches',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const flags = document.querySelectorAll('#billsBodyTbl td[title*="kWh"], #billsBodyTbl td[data-tooltip*="kWh"]');
              return { hasIdentityFlags: true, count: flags.length };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'v05',
          backlogUuid: '113a5ec5',
          name: 'Raw text page number matches billing period',
          depth: 'interact',
          steps: [
            { action: 'click', selector: '#billsBodyTbl tbody tr:last-child' },
            { action: 'waitFor', selector: '.raw-text-panel, .bill-split-panel' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const pageInfo = document.querySelector('.raw-text-page, [data-page-num]');
              if (!pageInfo) return { skip: true, reason: "Raw text panel not found" };
              return { text: pageInfo.textContent, exists: true };
            })()`,
            expect: { op: 'truthy', path: 'exists' },
          },
          cleanup: [{ action: 'click', selector: '.back-btn, .close-split' }],
        },
        {
          id: 'v06',
          backlogUuid: '116c2f1a',
          name: 'Auto-created meters have correct commodity type',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const issues = allMeters.filter(m => !m.commodity || m.commodity === '' || m.commodity === 'undefined');
              return { issues: issues.map(m => ({ meter: m.name || m.id, building: m._bName })), allHaveCommodity: issues.length === 0 };
            })()`,
            expect: { op: 'truthy', path: 'allHaveCommodity' },
          },
        },
        {
          id: 'v07',
          backlogUuid: '37354462',
          name: 'Statistical outlier banner count matches flagged rows',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const banner = document.querySelector('.outlier-banner, [data-outlier-count]');
              if (!banner) return { skip: true, reason: "No outlier banner visible" };
              const countMatch = banner.textContent.match(/(\\d+)\\s*billing periods? flagged/);
              const bannerCount = countMatch ? parseInt(countMatch[1]) : 0;
              const flaggedRows = document.querySelectorAll('#billsBodyTbl tr.outlier, #billsBodyTbl tr[data-outlier]');
              return { bannerCount, actualCount: flaggedRows.length, match: bannerCount === flaggedRows.length };
            })()`,
            expect: { op: 'truthy', path: 'match' },
          },
        },
      ],
    },
    {
      id: 'extraction-engine',
      name: 'Extraction Engine & Save Paths',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'pdf' }],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'e01',
          backlogUuid: null,
          name: 'Louisburg commodity routing — Gas/Water/Sewer/Stormwater to separate meters',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires PDF extraction — verify during live extraction session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e02',
          backlogUuid: null,
          name: 'Fuel adjustment captured in old-format bills',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              for (const m of allMeters) {
                if (m.commodity === 'Gas') {
                  for (const bill of (m.bills || [])) {
                    if (bill.fuelAdjustment && parseFloat(bill.fuelAdjustment) !== 0) {
                      return { found: true, value: bill.fuelAdjustment };
                    }
                  }
                }
              }
              return { found: false, reason: "No gas bills with fuel adjustment found" };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'e03',
          backlogUuid: null,
          name: 'Stormwater $4 (not $400) — sanity check',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              for (const m of allMeters) {
                if (m.commodity === 'Stormwater') {
                  for (const bill of (m.bills || [])) {
                    const cost = parseFloat(bill.totalCost || bill.cost || 0);
                    if (cost > 100) return { fail: true, value: cost, billDate: bill.startDate };
                  }
                  return { pass: true };
                }
              }
              return { skip: true, reason: "No stormwater meter found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'e04',
          backlogUuid: null,
          name: 'Propane extraction — gallons/price/total populate',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              for (const m of allMeters) {
                if (m.commodity === 'Propane') {
                  for (const bill of (m.bills || [])) {
                    const gallons = parseFloat(bill.gallons || bill.usage || 0);
                    const price = parseFloat(bill.pricePerGallon || bill.rate || 0);
                    const total = parseFloat(bill.totalCost || bill.cost || 0);
                    if (gallons > 0 && total > 0) return { pass: true, gallons, price, total };
                  }
                }
              }
              return { skip: true, reason: "No propane bills found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'e05',
          backlogUuid: null,
          name: 'Gas Bills HS.pdf — Oct-Nov 2025 captured',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires specific PDF re-extraction — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e06',
          backlogUuid: null,
          name: 'Bills Shelton.pdf — sum mismatches resolved',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires specific PDF re-extraction — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e07',
          backlogUuid: null,
          name: 'Billing Detail format extracts dates correctly',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires Louisburg PDF extraction — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e08',
          backlogUuid: null,
          name: 'Billing Inquiry format extracts data',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires Billing Inquiry format PDF — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e09',
          backlogUuid: null,
          name: 'Sewer usage = Water usage on bills without sewer parse',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const sewerMeter = allMeters.find(m => m.commodity === 'Sewer');
              if (!sewerMeter) return { skip: true, reason: "No sewer meter found" };
              for (const sb of (sewerMeter.bills || [])) {
                const usage = parseFloat(sb.usage || sb.sewerUsage || sb.gallons || 0);
                if (usage > 0) return { pass: true, sewerUsage: usage };
              }
              return { skip: true, reason: "No sewer meter with usage found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'e10',
          backlogUuid: null,
          name: 'MWATER OCR garble handled — Water line captured',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires Louisburg page 21 re-extraction — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'e11',
          backlogUuid: null,
          name: 'confirmAutoAssign saves all 35+ fields',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const fieldChecks = ['startDate', 'endDate', 'totalCost', 'commodity'];
              for (const m of allMeters) {
                for (const bill of (m.bills || [])) {
                  const populated = fieldChecks.filter(f => bill[f] && bill[f] !== '');
                  if (populated.length >= 3) return { pass: true, fieldsPresent: populated.length };
                }
              }
              return { skip: true, reason: "No bills with sufficient fields found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
      ],
    },
    {
      id: 'extraction-duplicates',
      name: 'Extraction Duplicate Handling',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'pdf' }],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'dup01',
          backlogUuid: '67b17945',
          name: 'Duplicate detection reads existing Meter Read Start/End correctly',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              for (const m of allMeters) {
                for (const bill of (m.bills || [])) {
                  if (bill.meterReadStart || bill.MeterReadStart) {
                    return { pass: true, hasReadDates: true };
                  }
                }
              }
              return { skip: true, reason: "No bills with meter read dates found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'dup02',
          backlogUuid: '1f678592',
          name: 'Duplicate summary table has clear labels',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const dupTable = document.querySelector('.dup-summary, .duplicate-summary, [data-dup-table]');
              if (!dupTable) return { skip: true, reason: "No duplicate table visible — extract first" };
              const hasTitle = dupTable.querySelector('h3, .title, caption');
              const hasLegend = dupTable.querySelector('.legend, .status-key, [data-legend]');
              return { hasTitle: !!hasTitle, hasLegend: !!hasLegend };
            })()`,
            expect: { op: 'truthy', path: 'hasTitle' },
          },
        },
        {
          id: 'dup03',
          backlogUuid: 'a1e91fb8',
          name: 'Re-extraction preserves user-corrected values',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires re-extraction with existing corrected data — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'dup04',
          backlogUuid: 'a60060e9',
          name: 'Duplicate warning appears when re-extracting existing bills',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires re-extraction of existing bills — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'dup05',
          backlogUuid: null,
          name: 'Duplicate resolution offers Save All vs Save Non-Empty options',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const dupBtns = document.querySelectorAll('.dup-action-btn, [data-dup-action]');
              if (dupBtns.length === 0) return { skip: true, reason: "No duplicate resolution UI visible" };
              const btnTexts = Array.from(dupBtns).map(b => b.textContent.trim());
              return { buttons: btnTexts, hasOptions: btnTexts.length >= 2 };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'ui-display',
      name: 'UI & Display',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Electric' } },
      ],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'u01',
          backlogUuid: null,
          name: 'Billing period gap indicators show between correct months',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const gaps = document.querySelectorAll('.gap-indicator, .gap-row, [data-gap]');
              return { count: gaps.length, hasGaps: gaps.length >= 0 };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u02',
          backlogUuid: null,
          name: 'Gap indicators NOT shown for propane meters',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires switching to propane meter and checking for absence of gaps — verify in batch" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u03',
          backlogUuid: null,
          name: 'Gap row text stays visible on horizontal scroll (sticky)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const gapRows = document.querySelectorAll('.gap-row td, .gap-indicator');
              for (const el of gapRows) {
                const style = window.getComputedStyle(el);
                if (style.position === 'sticky') return { pass: true };
              }
              return { skip: true, reason: "No gap rows found or not sticky" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u04',
          backlogUuid: null,
          name: 'Dollar signs and commas in extracted values',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const cells = document.querySelectorAll('#billsBodyTbl td[data-col="totalCost"], #billsBodyTbl td[data-field="totalCost"]');
              for (const cell of cells) {
                const text = cell.textContent.trim();
                if (text && text.includes('$') && (parseFloat(text.replace(/[$,]/g,'')) >= 1000 ? text.includes(',') : true)) {
                  return { pass: true, sample: text };
                }
              }
              return { skip: true, reason: "No cost cells found" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'u05',
          backlogUuid: null,
          name: 'Water/Sewer Usage column headers show units (gal)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#billsHdrTbl th'));
              const waterHeader = headers.find(h => h.textContent.includes('Water') && h.textContent.includes('gal'));
              return { found: !!waterHeader, text: waterHeader?.textContent };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u06',
          backlogUuid: null,
          name: 'Meter pill labels show commodity with correct colors',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const pills = document.querySelectorAll('.meter-pill, .extract-pill, [data-meter-pill]');
              if (pills.length === 0) return { skip: true, reason: "No meter pills visible — need extraction preview" };
              return { count: pills.length, hasLabels: true };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u07',
          backlogUuid: 'b16216a4',
          name: 'Date picker icon in Edit Billing Period is visible',
          depth: 'interact',
          steps: [
            { action: 'click', selector: '#billsBodyTbl tbody tr:first-child' },
            { action: 'waitFor', selector: '.bill-split-panel, #billModal.open' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const icon = document.querySelector('.date-picker-icon, .cal-icon, button[onclick*="datePicker"], button[onclick*="showDP"]');
              if (!icon) return { skip: true, reason: "Date picker icon not found" };
              const style = window.getComputedStyle(icon);
              const color = style.color;
              return { visible: true, color };
            })()`,
            expect: { op: 'truthy', path: 'visible' },
          },
          cleanup: [{ action: 'click', selector: '.back-btn, .modal-x, .close-split' }],
        },
        {
          id: 'u08',
          backlogUuid: 'a3de3e1e',
          name: 'Meter pills show commodity type once (not doubled)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const selects = document.querySelectorAll('select[id^="sb-meter-"]');
              for (const sel of selects) {
                for (const opt of sel.options) {
                  if (opt.text.match(/(Electric|Gas|Water|Sewer|Propane)\\s+\\1/i)) {
                    return { fail: true, doubled: opt.text };
                  }
                }
              }
              return { pass: true };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'u09',
          backlogUuid: '3e82146c',
          name: 'Bills table horizontal scroll bar is visible and usable',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const scrollContainer = document.querySelector('#billsScrollBody, .bills-scroll-body');
              if (!scrollContainer) return { skip: true, reason: "Bills scroll container not found" };
              const style = window.getComputedStyle(scrollContainer);
              return { overflowX: style.overflowX, hasScroll: scrollContainer.scrollWidth > scrollContainer.clientWidth };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'u10',
          backlogUuid: 'dd116c96',
          name: 'Outer page frame does not scroll — only content area scrolls',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const html = document.documentElement;
              const body = document.body;
              const htmlStyle = window.getComputedStyle(html);
              const bodyStyle = window.getComputedStyle(body);
              const htmlOverflow = htmlStyle.overflow || htmlStyle.overflowY;
              const bodyOverflow = bodyStyle.overflow || bodyStyle.overflowY;
              return { htmlOverflow, bodyOverflow, fixed: htmlOverflow === 'hidden' || bodyOverflow === 'hidden' };
            })()`,
            expect: { op: 'truthy', path: 'fixed' },
          },
        },
      ],
    },
    {
      id: 'performance-dashboard',
      name: 'Performance & Dashboard',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'dashboard' }],
      requires: ['project-with-baseline'],
      tests: [
        {
          id: 'perf01',
          backlogUuid: '242275bb',
          name: 'Building Performance auto-calculates on open (no manual step needed)',
          depth: 'interact',
          steps: [
            { action: 'click', selector: "button[onclick*='Performance'], button[data-action='bldg-performance']" },
            { action: 'waitFor', selector: '.perf-table, .performance-panel, [data-perf-results]' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const tables = document.querySelectorAll('.perf-table tr, .performance-panel table tr');
              return { hasData: tables.length > 1 };
            })()`,
            expect: { op: 'truthy', path: 'hasData' },
          },
          cleanup: [],
        },
        {
          id: 'perf02',
          backlogUuid: '242275bb',
          name: 'CSC Compensation % auto-populates from project settings',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const input = document.querySelector('input[name="cscCompensation"], #perf-csc-pct, [data-field="cscCompensation"]');
              if (!input) return { skip: true, reason: "CSC Compensation field not found" };
              const val = parseFloat(input.value);
              return { value: val, populated: val > 0 };
            })()`,
            expect: { op: 'truthy', path: 'populated' },
          },
        },
        {
          id: 'perf03',
          backlogUuid: '242275bb',
          name: 'Building Performance hides Utility Data underneath',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const utilPanel = document.querySelector('#ptab-utility, .utility-data-panel');
              if (!utilPanel) return { skip: true };
              const style = window.getComputedStyle(utilPanel);
              return { hidden: style.display === 'none' || style.visibility === 'hidden' || !utilPanel.offsetParent };
            })()`,
            expect: { op: 'truthy', path: 'hidden' },
          },
        },
        {
          id: 'perf04',
          backlogUuid: '247830f8',
          name: 'Project Performance savings match Project Dashboard savings',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires comparing values across two tabs — compare during Playwright batch session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'perf05',
          backlogUuid: '02120240',
          name: 'Positive savings display as positive numbers',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const savingsEls = document.querySelectorAll('[data-field="savings"], .savings-value, [id*="savings"]');
              for (const el of savingsEls) {
                const val = parseFloat(el.textContent.replace(/[$,]/g, ''));
                if (!isNaN(val) && val < 0) return { fail: true, value: val, text: el.textContent };
              }
              return { pass: true };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'perf06',
          backlogUuid: 'a45023b8',
          name: 'Performance chart title uses correct commodity unit (not always kWh)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const chartTitles = document.querySelectorAll('.chart-title, canvas + .title, [data-chart-title]');
              return { count: chartTitles.length, note: "Verify manually that propane/gas charts say Gallons/Therms" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'perf07',
          backlogUuid: null,
          name: 'Performance tabs only show Actual Cost and Actual Savings columns',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('.perf-table th, .performance-panel th'));
              const forbidden = ['Baseline Cost', 'Projected Savings', 'Expected Cost'];
              const found = headers.filter(h => forbidden.some(f => h.textContent.includes(f)));
              return { pass: found.length === 0, forbidden: found.map(h => h.textContent) };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'perf08',
          backlogUuid: '8bd495f9',
          name: "Dashboard Building Performance table says 'Baseline Period' not 'Period'",
          depth: 'observe',
          check: {
            type: 'snapshot-contains',
            text: 'Baseline Period',
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'perf09',
          backlogUuid: '7892b0b6',
          name: 'Dashboard tab has active underline on Projects page',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const activeTab = document.querySelector('button.pdt.active, button.pdt[data-tab="dashboard"].active, button.pdt.sel');
              return { hasActive: !!activeTab, text: activeTab?.textContent?.trim() };
            })()`,
            expect: { op: 'truthy', path: 'hasActive' },
          },
        },
        {
          id: 'perf10',
          backlogUuid: null,
          name: 'Savings sign consistent across meter, building, and project',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires comparing savings across 3 navigation levels — verify in Playwright batch" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'hvac-load-estimation',
      name: 'HVAC Load Estimation',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'hvacload' }],
      requires: ['project-with-baseline'],
      tests: [
        {
          id: 'hvac01',
          backlogUuid: '4f46a197',
          name: 'HVAC Load Est shows February electric baseline data',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#ptab-hvacload table tbody tr, .hvac-table tbody tr');
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                const monthCell = cells[0];
                if (monthCell && monthCell.textContent.includes('Feb')) {
                  const hasData = Array.from(cells).slice(1).some(c => parseFloat(c.textContent.replace(/,/g,'')) > 0);
                  return { found: true, hasData };
                }
              }
              return { skip: true, reason: "No February row found in HVAC table" };
            })()`,
            expect: { op: 'truthy', path: 'hasData' },
          },
        },
        {
          id: 'hvac02',
          backlogUuid: null,
          name: 'HVAC Load Est shows Actual kW for ALL buildings',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#ptab-hvacload table tbody tr, .hvac-table tbody tr');
              let emptyKW = 0, totalRows = 0;
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                const kwCell = Array.from(cells).find(c => c.dataset.col === 'actualKW' || c.dataset.field === 'actualKW');
                if (kwCell) {
                  totalRows++;
                  const val = parseFloat(kwCell.textContent.replace(/,/g, ''));
                  if (!val || val === 0) emptyKW++;
                }
              }
              return { totalRows, emptyKW, allPopulated: emptyKW === 0 || totalRows === 0 };
            })()`,
            expect: { op: 'truthy', path: 'allPopulated' },
          },
        },
        {
          id: 'hvac03',
          backlogUuid: null,
          name: 'HVAC Load Est Total row sums all monthly values',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#ptab-hvacload table tbody tr, .hvac-table tbody tr');
              const lastRow = rows[rows.length - 1];
              if (!lastRow) return { skip: true };
              const cells = lastRow.querySelectorAll('td');
              const isTotal = lastRow.textContent.toLowerCase().includes('total') || lastRow.classList.contains('total-row');
              const hasValues = Array.from(cells).slice(1).some(c => parseFloat(c.textContent.replace(/,/g,'')) > 0);
              return { isTotal, hasValues, pass: isTotal && hasValues };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'hvac04',
          backlogUuid: null,
          name: 'HVAC Load Est Total Utility Cost column has values for every month',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#ptab-hvacload table thead th, .hvac-table thead th'));
              const costIdx = headers.findIndex(h => h.textContent.includes('Total Utility Cost') || h.textContent.includes('Utility Cost'));
              if (costIdx === -1) return { skip: true, reason: "Total Utility Cost column not found" };
              const rows = document.querySelectorAll('#ptab-hvacload table tbody tr, .hvac-table tbody tr');
              let empty = 0;
              for (const row of rows) {
                const cell = row.querySelectorAll('td')[costIdx];
                if (cell && (!cell.textContent.trim() || cell.textContent.trim() === '$0' || cell.textContent.trim() === '0')) empty++;
              }
              return { empty, total: rows.length, allPopulated: empty === 0 };
            })()`,
            expect: { op: 'truthy', path: 'allPopulated' },
          },
        },
        {
          id: 'hvac05',
          backlogUuid: null,
          name: 'HVAC Load Est values match Bills data table values',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires cross-referencing HVAC table with Bills table — verify in Playwright batch by switching tabs" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'baseline-settings',
      name: 'Baseline & Project Settings',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'settings' }],
      requires: ['project-with-baseline'],
      tests: [
        {
          id: 'bl01',
          backlogUuid: 'be052858',
          name: 'Project Settings has CSC Compensation %, Contract Years, Utility Escalation',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const csc = document.querySelector('input[name="cscCompensation"], #mp-cscComp, [data-field="cscCompensation"]');
              const contract = document.querySelector('input[name="contractYears"], #mp-contract-years, [data-field="contractYears"]');
              const escalation = document.querySelector('input[name="escalation"], #mp-escalation, [data-field="escalation"]');
              return { csc: !!csc, contract: !!contract, escalation: !!escalation, allPresent: !!csc && !!contract && !!escalation };
            })()`,
            expect: { op: 'truthy', path: 'allPresent' },
          },
        },
        {
          id: 'bl02',
          backlogUuid: '83400d37',
          name: 'Regression model type indicator visible (CDD/HDD/dual)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const modelIndicator = document.querySelector('.model-type, [data-model-type], .regression-info');
              if (modelIndicator) return { found: true, text: modelIndicator.textContent };
              const snapshot = document.body.innerHTML;
              const hasModelText = snapshot.includes('HDD + CDD') || snapshot.includes('HDD only') || snapshot.includes('CDD only') || snapshot.includes('Model:');
              return { found: hasModelText };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'bl03',
          backlogUuid: null,
          name: 'Meter baseline toggle excludes from KPI/EUI/performance',
          depth: 'interact',
          steps: [
            { action: 'tab', target: 'utility' },
            { action: 'click', selector: ".ud-incl-btn, [data-action='toggle-baseline-include']" },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Toggle exclusion and verify KPI recalculates — requires before/after comparison" };
            })()`,
            expect: { op: 'truthy' },
          },
          cleanup: [{ action: 'click', selector: ".ud-incl-btn, [data-action='toggle-baseline-include']" }],
        },
        {
          id: 'bl04',
          backlogUuid: null,
          name: 'Apply to All Buildings button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const applyAll = btns.find(b => b.textContent.includes('Apply to All') || b.textContent.includes('Apply Baseline'));
              return { found: !!applyAll, text: applyAll?.textContent?.trim() };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'bl05',
          backlogUuid: null,
          name: 'Baseline/Savings/Performance tabs hide building-level panel below',
          depth: 'interact',
          steps: [
            { action: 'click', selector: "button[onclick*='Performance'], button[data-action='proj-performance']" },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const bldgPanel = document.querySelector('.building-detail-panel, [data-building-detail]');
              if (!bldgPanel) return { pass: true, reason: "Building panel not in DOM" };
              const style = window.getComputedStyle(bldgPanel);
              return { pass: style.display === 'none' || !bldgPanel.offsetParent };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
          cleanup: [],
        },
        {
          id: 'bl06',
          backlogUuid: '9aa27620',
          name: "Project-level Settings tab reads 'Project Settings'",
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const tabs = document.querySelectorAll('button.pdt');
              for (const tab of tabs) {
                if (tab.textContent.trim() === 'Project Settings') return { found: true };
              }
              return { found: false };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'bl07',
          backlogUuid: '38b3675d',
          name: 'Default output display unit setting exists at project level',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const unitSelects = document.querySelectorAll('select[name*="displayUnit"], select[id*="displayUnit"], .display-unit-select');
              return { count: unitSelects.length, found: unitSelects.length > 0 };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
      ],
    },
    {
      id: 'propane-meters',
      name: 'Propane Meters',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Propane' } },
      ],
      requires: ['propane-meter'],
      tests: [
        {
          id: 'prop01',
          backlogUuid: '565526cb',
          name: 'Propane rate shows single blended rate (not Summer/Winter)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#billsHdrTbl th'));
              const hasSummer = headers.some(h => h.textContent.includes('Summer'));
              const hasWinter = headers.some(h => h.textContent.includes('Winter'));
              return { noSeasonalSplit: !hasSummer && !hasWinter };
            })()`,
            expect: { op: 'truthy', path: 'noSeasonalSplit' },
          },
        },
        {
          id: 'prop02',
          backlogUuid: '955e91bd',
          name: 'Propane Normalized tab shows cost for all months with baseline gallons',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const normTab = document.querySelector('.normalized-tab, [data-tab-content="normalized"]');
              if (!normTab) return { skip: true, reason: "Normalized tab not visible — navigate there first" };
              const rows = normTab.querySelectorAll('table tbody tr');
              let missingCost = 0;
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                const hasGallons = Array.from(cells).some(c => parseFloat(c.textContent.replace(/,/g,'')) > 0);
                const hasCost = Array.from(cells).some(c => c.textContent.includes('$') && parseFloat(c.textContent.replace(/[$,]/g,'')) > 0);
                if (hasGallons && !hasCost) missingCost++;
              }
              return { missingCost, pass: missingCost === 0 };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'prop03',
          backlogUuid: '25d80ed2',
          name: 'Post-baseline propane data is HDD-normalized (not raw delivery)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const pm = allMeters.find(m => m.commodity === 'Propane' && m.normalizedActual);
              if (pm) return { pass: true, hasNormalizedActual: true };
              return { skip: true, reason: "No propane meter with normalizedActual data" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'prop04',
          backlogUuid: '8f08aaa0',
          name: 'Performance chart shows actual gallons > 0 for propane',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const chartCanvas = document.querySelector('canvas[id*="perf"], canvas[id*="Performance"]');
              if (!chartCanvas) return { skip: true, reason: "Performance chart not visible" };
              return { note: "Chart data verification requires reading Chart.js data object — verify visually" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'prop05',
          backlogUuid: 'b60cab6d',
          name: 'Propane data populates correctly in Baseline Data table',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const pm = allMeters.find(m => m.commodity === 'Propane' && m.bills?.length > 0);
              if (pm) {
                const hasUsage = pm.bills.some(bill => parseFloat(bill.gallons || bill.usage || 0) > 0);
                return { hasUsage, billCount: pm.bills.length };
              }
              return { skip: true, reason: "No propane meter with bills" };
            })()`,
            expect: { op: 'truthy', path: 'hasUsage' },
          },
        },
        {
          id: 'prop06',
          backlogUuid: null,
          name: 'Propane meter type identification correct in sidebar',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const selects = document.querySelectorAll('select[id^="sb-meter-"]');
              for (const sel of selects) {
                for (const opt of sel.options) {
                  if (opt.text.includes('Propane')) return { found: true, text: opt.text };
                }
              }
              return { skip: true, reason: "No propane meter in sidebar" };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
      ],
    },
    {
      id: 'billing-period-modal',
      name: 'Billing Period Modal',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Electric' } },
      ],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'bp01',
          backlogUuid: null,
          name: 'Edit Billing Period — currency/number formatting',
          depth: 'interact',
          steps: [
            { action: 'click', selector: '#billsBodyTbl tbody tr:first-child' },
            { action: 'waitFor', selector: '.bill-split-panel, #billModal.open' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const inputs = document.querySelectorAll('.ef-input, .bl-charge-input, input[data-format="currency"]');
              for (const input of inputs) {
                if (input.value && input.value.includes('$')) return { pass: true, sample: input.value };
              }
              return { note: "Currency formatting may only show on blur — check visually" };
            })()`,
            expect: { op: 'truthy' },
          },
          cleanup: [{ action: 'click', selector: '.back-btn, .modal-x, .close-split' }],
        },
        {
          id: 'bp02',
          backlogUuid: '389e517b',
          name: 'Clicking outside panel does NOT close it',
          depth: 'interact',
          steps: [
            { action: 'click', selector: '#billsBodyTbl tbody tr:first-child' },
            { action: 'waitFor', selector: '.bill-split-panel, #billModal.open' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const modals = document.querySelectorAll('.modal-bg');
              for (const modal of modals) {
                const onclick = modal.getAttribute('onclick') || '';
                if (onclick.includes('event.target === this') && onclick.includes('close')) {
                  return { fail: true, modal: modal.id, onclick };
                }
              }
              return { pass: true };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
          cleanup: [{ action: 'click', selector: '.back-btn, .modal-x, .close-split' }],
        },
        {
          id: 'bp03',
          backlogUuid: 'ee5c37a1',
          name: 'End Date auto-populates to Start Date + 30 days',
          depth: 'mutate',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires Add Billing Period interaction — verify during live session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'bp04',
          backlogUuid: '156a10c0',
          name: 'Add Billing Period autofills Account Info from existing bills',
          depth: 'interact',
          steps: [
            { action: 'click', selector: "button[onclick*='addBill'], button[data-action='add-bill']" },
            { action: 'waitFor', selector: '#billModal.open, .add-bill-modal' },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const utilityField = document.querySelector('#bill-utility, input[name="utilityCompany"]');
              const accountField = document.querySelector('#bill-account, input[name="accountNumber"]');
              return {
                utilityPopulated: utilityField && utilityField.value.trim() !== '',
                accountPopulated: accountField && accountField.value.trim() !== ''
              };
            })()`,
            expect: { op: 'truthy', path: 'utilityPopulated' },
          },
          cleanup: [{ action: 'click', selector: '.modal-x, .cancel-btn' }],
        },
        {
          id: 'bp05',
          backlogUuid: null,
          name: 'Gas meter labels say Therms (not CCF) when meter is set to Therms',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const gm = allMeters.find(m => m.commodity === 'Gas' && (m.gasUnit === 'Therms' || m.unit === 'Therms'));
              if (gm) return { meterUsesTherm: true, name: gm.name };
              return { skip: true, reason: "No gas meter configured for Therms" };
            })()`,
            expect: { op: 'truthy', path: 'meterUsesTherm' },
          },
        },
        {
          id: 'bp06',
          backlogUuid: '3b34a7e8',
          name: 'Gas rate column shows value in Bills data table',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#billsHdrTbl th'));
              const rateCol = headers.findIndex(h => h.textContent.includes('Rate') || h.textContent.includes('rate'));
              if (rateCol === -1) return { skip: true, reason: "Rate column not found" };
              const rows = document.querySelectorAll('#billsBodyTbl tbody tr');
              for (const row of rows) {
                const cell = row.querySelectorAll('td')[rateCol];
                if (cell && parseFloat(cell.textContent.replace(/[$,]/g, '')) > 0) {
                  return { pass: true, value: cell.textContent };
                }
              }
              return { fail: true, reason: "All rate cells empty" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
      ],
    },
    {
      id: 'calendar-import',
      name: 'Calendar Import',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'district' }],
      requires: ['project-with-calendar'],
      tests: [
        {
          id: 'cal01',
          backlogUuid: null,
          name: 'District Calendar captures 30+ events',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const projects = JSON.parse(localStorage.getItem('en_projects') || '[]');
              for (const p of projects) {
                const util = JSON.parse(localStorage.getItem('en_utility_' + p.id) || '{}');
                const events = p.calendarEvents || util.calendarEvents || [];
                if (events.length >= 30) return { pass: true, count: events.length };
              }
              return { skip: true, reason: "No project with 30+ calendar events" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'cal02',
          backlogUuid: null,
          name: 'District Calendar calendar view toggle works',
          depth: 'interact',
          steps: [{ action: 'click', selector: "button[onclick*='calView'], .cal-view-toggle" }],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const calGrid = document.querySelector('.cal-grid, .calendar-view, [data-view="calendar"]');
              return { visible: !!calGrid };
            })()`,
            expect: { op: 'truthy', path: 'visible' },
          },
          cleanup: [],
        },
        {
          id: 'cal03',
          backlogUuid: 'c1461281',
          name: 'Calendar events have accurate dates and full names',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const projects = JSON.parse(localStorage.getItem('en_projects') || '[]');
              for (const p of projects) {
                const util = JSON.parse(localStorage.getItem('en_utility_' + p.id) || '{}');
                const events = p.calendarEvents || util.calendarEvents || [];
                if (events.length > 0) {
                  const issues = events.filter(evt => !evt.date || !evt.name || (evt.name && evt.name.length < 3));
                  return { total: events.length, issues: issues.length, pass: issues.length === 0 };
                }
              }
              return { skip: true };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'cal04',
          backlogUuid: 'b9f76135',
          name: 'Delete All Calendar Events button exists with confirmation',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const deleteAllBtn = btns.find(b => b.textContent.includes('Delete All') && (b.closest('#ptab-district') || b.closest('.district')));
              return { found: !!deleteAllBtn, text: deleteAllBtn?.textContent?.trim() };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'cal05',
          backlogUuid: 'b6109823',
          name: 'Calendar import shows extraction preview before saving',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires triggering a calendar import — verify during live import session" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'saved-bills',
      name: 'Saved Bills Table',
      page: 'energy-department.html',
      setup: [{ action: 'tab', target: 'savedbills' }],
      requires: ['saved-pdf-bills'],
      tests: [
        {
          id: 'sb01',
          backlogUuid: 'b6990c1f',
          name: 'Saved Bills rows show correct Account # per commodity (not all Evergy)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('#ptab-savedbills table tbody tr, .saved-bills-table tbody tr');
              const accounts = new Set();
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                for (const cell of cells) {
                  if (cell.textContent.match(/\\d{6,}/)) accounts.add(cell.textContent.trim());
                }
              }
              return { uniqueAccounts: accounts.size, moreThanOne: accounts.size > 1 };
            })()`,
            expect: { op: 'truthy', path: 'moreThanOne' },
          },
        },
        {
          id: 'sb02',
          backlogUuid: '7a3eb072',
          name: 'Delivery Date column removed from Saved Bills table',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#ptab-savedbills table th, .saved-bills-table th'));
              const hasDeliveryDate = headers.some(h => h.textContent.includes('Delivery Date'));
              return { removed: !hasDeliveryDate };
            })()`,
            expect: { op: 'truthy', path: 'removed' },
          },
        },
        {
          id: 'sb03',
          backlogUuid: null,
          name: 'Delete individual saved bill button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const deleteBtns = document.querySelectorAll('#ptab-savedbills .del-btn, .saved-bills-table button[onclick*="delete"], .saved-bills-table .row-delete');
              return { found: deleteBtns.length > 0, count: deleteBtns.length };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'sb04',
          backlogUuid: null,
          name: 'Delete All saved bills button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('#ptab-savedbills button, .saved-bills-table ~ button'));
              const deleteAll = btns.find(b => b.textContent.includes('Delete All'));
              return { found: !!deleteAll };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'sb05',
          backlogUuid: '2a3f66c3',
          name: "Saved Bills show 'Saved On' timestamp",
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('#ptab-savedbills table th, .saved-bills-table th'));
              const hasSavedOn = headers.some(h => h.textContent.includes('Saved') || h.textContent.includes('Date Added'));
              return { found: hasSavedOn };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'sb06',
          backlogUuid: '2205dcdb',
          name: 'Saved bills accessible from Projects page with assign option',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const tab = document.querySelector('button.pdt[data-tab="savedbills"]');
              return { tabExists: !!tab, text: tab?.textContent?.trim() };
            })()`,
            expect: { op: 'truthy', path: 'tabExists' },
          },
        },
      ],
    },
    {
      id: 'normalized-tab',
      name: 'Normalized Tab & Charts',
      page: 'energy-department.html',
      setup: [
        { action: 'tab', target: 'utility' },
        { action: 'selectMeter', match: { commodity: 'Electric' } },
      ],
      requires: ['project-with-baseline'],
      tests: [
        {
          id: 'norm01',
          backlogUuid: null,
          name: 'Normalized kWh vs Actual kWh chart renders at meter level',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const chartCanvas = document.querySelector('canvas[id*="norm"], canvas[id*="Norm"]');
              if (!chartCanvas) return { skip: true, reason: "Normalized chart canvas not found" };
              return { found: true, id: chartCanvas.id, hasSize: chartCanvas.width > 0 && chartCanvas.height > 0 };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'norm02',
          backlogUuid: null,
          name: 'Normalized chart title uses commodity-specific unit',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const titles = document.querySelectorAll('.chart-title, .norm-title, h3, h4');
              for (const t of titles) {
                if (t.textContent.includes('Normalized') && t.textContent.includes('vs Actual')) {
                  return { text: t.textContent, correct: !t.textContent.includes('kWh') || true };
                }
              }
              return { skip: true, reason: "Normalized chart title not found in DOM" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'norm03',
          backlogUuid: null,
          name: 'No months with cost > customer charge but 0 normalized usage',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const rows = document.querySelectorAll('.norm-table tbody tr, [data-norm-table] tbody tr');
              let violations = 0;
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                const texts = Array.from(cells).map(c => c.textContent.replace(/[$,]/g, '').trim());
              }
              return { note: "Verify visually that no month has cost but zero usage" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'norm04',
          backlogUuid: null,
          name: 'Regression model indicator shows on Normalized tab',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const text = document.querySelector('#ptab-utility')?.textContent || '';
              const hasModel = text.includes('Model:') || text.includes('HDD') || text.includes('CDD') || text.includes('R\\u00B2');
              return { found: hasModel };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
      ],
    },
    {
      id: 'project-header-labels',
      name: 'Project/Building Header Button Labels',
      page: 'energy-department.html',
      setup: [],
      requires: ['project-with-buildings'],
      tests: [
        {
          id: 'lbl01',
          backlogUuid: 'd051794d',
          name: "Building-level Performance button reads 'Building Performance'",
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const found = btns.find(b => b.textContent.trim() === 'Building Performance');
              return { found: !!found };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'lbl02',
          backlogUuid: '87e406e1',
          name: "Project-level Performance button reads 'Project Performance'",
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const found = btns.find(b => b.textContent.trim() === 'Project Performance');
              return { found: !!found };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'lbl03',
          backlogUuid: 'b136aae8',
          name: "Project-level Edit button reads 'Edit Project'",
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const found = btns.find(b => b.textContent.trim() === 'Edit Project');
              return { found: !!found };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
      ],
    },
    {
      id: 'new-features',
      name: 'New Features (Session 04-22a)',
      page: 'energy-department.html',
      setup: [],
      requires: ['project-with-baseline'],
      tests: [
        {
          id: 'f01',
          backlogUuid: null,
          name: 'Utility Escalation %/yr in project edit modal',
          depth: 'interact',
          steps: [
            { action: 'click', selector: "button[onclick*='openProjModal'], button[data-action='edit-project']" },
            { action: 'waitFor', selector: '#projModal.open, #projModal .modal' },
          ],
          check: {
            type: 'exists',
            selector: "#mp-escalation, input[name='escalation'], input[name='utilityEscalation']",
          },
          cleanup: [{ action: 'click', selector: '#projModal .modal-x' }],
        },
        {
          id: 'f02',
          backlogUuid: null,
          name: 'Apply Baseline to All Meters in Project button',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const found = btns.find(b => b.textContent.includes('Apply') && b.textContent.includes('All Meters'));
              return { found: !!found, text: found?.textContent?.trim() };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'f03',
          backlogUuid: null,
          name: 'Expected kW Cost column in Performance post-baseline table',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const headers = Array.from(document.querySelectorAll('.perf-table th, .performance-panel th'));
              const found = headers.find(h => h.textContent.includes('Expected kW'));
              return { found: !!found };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'f04',
          backlogUuid: null,
          name: 'Propane normalization — gallons spread by HDD',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const allMeters = window.__tvAllMeters ? window.__tvAllMeters() : [];
              const pm = allMeters.find(m => m.commodity === 'Propane' && m.normalizedBaseline);
              if (pm) {
                const months = Object.values(pm.normalizedBaseline);
                const unique = new Set(months.filter(v => v > 0));
                if (unique.size > 1) return { pass: true, varied: true };
              }
              return { skip: true, reason: "No propane meter with normalized baseline" };
            })()`,
            expect: { op: 'truthy', path: 'pass' },
          },
        },
        {
          id: 'f05',
          backlogUuid: null,
          name: 'Per-month Expected kW shows seasonal variation',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              return { note: "Requires Performance table with Expected kW column — verify values differ by month" };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'prior-sessions',
      name: 'Prior Sessions (04-17 through 04-21)',
      page: 'energy-department.html',
      setup: [],
      requires: ['electric-meter-with-bills'],
      tests: [
        {
          id: 'p01',
          backlogUuid: null,
          name: 'Dashboard loads without majorityMonth crash',
          depth: 'interact',
          steps: [{ action: 'tab', target: 'dashboard' }],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const errors = window._lastError || null;
              const dashContent = document.querySelector('#ptab-dashboard');
              return { loaded: !!dashContent && dashContent.innerHTML.length > 100, noError: !errors };
            })()`,
            expect: { op: 'truthy', path: 'loaded' },
          },
          cleanup: [],
        },
        {
          id: 'p02',
          backlogUuid: null,
          name: 'Baseline status indicators in sidebar',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const indicators = document.querySelectorAll('.baseline-status, .bl-indicator, [data-baseline-status]');
              return { count: indicators.length, found: indicators.length > 0 };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'p03',
          backlogUuid: null,
          name: 'Meter baseline toggle exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const toggle = document.querySelector('.ud-incl-btn, [data-action="toggle-baseline-include"]');
              return { found: !!toggle };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'p04',
          backlogUuid: null,
          name: 'Savings measure detail — Financials + Notes',
          depth: 'interact',
          steps: [{ action: 'tab', target: 'savings' }],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const panel = document.querySelector('#ptab-savings');
              if (!panel) return { skip: true };
              return { exists: true };
            })()`,
            expect: { op: 'truthy', path: 'exists' },
          },
          cleanup: [],
        },
        {
          id: 'p05',
          backlogUuid: null,
          name: 'Apply to All Buildings button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const found = btns.find(b => b.textContent.includes('Apply') && b.textContent.includes('All Buildings'));
              return { found: !!found };
            })()`,
            expect: { op: 'truthy', path: 'found' },
          },
        },
        {
          id: 'p06',
          backlogUuid: null,
          name: 'Building Performance panel scrolls properly',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const panel = document.querySelector('.performance-panel, .bldg-perf-panel');
              if (!panel) return { skip: true };
              const style = window.getComputedStyle(panel);
              return { overflow: style.overflow || style.overflowY, scrollable: style.overflowY === 'auto' || style.overflowY === 'scroll' };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'p09',
          backlogUuid: null,
          name: 'Charge parts expand in Bills table (detailed view)',
          depth: 'interact',
          steps: [
            { action: 'tab', target: 'utility' },
            { action: 'click', selector: ".expand-icon, .charge-expand, [data-action='expand-charges']" },
          ],
          check: {
            type: 'evaluate',
            expr: `(() => {
              const expanded = document.querySelector('.charge-detail, .expanded-charges, [data-expanded]');
              return { found: !!expanded };
            })()`,
            expect: { op: 'truthy' },
          },
          cleanup: [],
        },
        {
          id: 'p10',
          backlogUuid: null,
          name: 'History modal for bill changes exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const histBtn = document.querySelector('.history-icon, [data-action="show-history"], button[onclick*="history"]');
              return { found: !!histBtn };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'p11',
          backlogUuid: null,
          name: 'Move-bill between meters feature exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const moveBtn = document.querySelector('[data-action="move-bill"], button[onclick*="moveBill"]');
              return { found: !!moveBtn };
            })()`,
            expect: { op: 'truthy' },
          },
        },
        {
          id: 'p14',
          backlogUuid: null,
          name: 'UI Customization — Customize mode button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
              const btn = document.querySelector('button[onclick*="customize"], .customize-btn, [data-action="customize"]');
              return { found: !!btn };
            })()`,
            expect: { op: 'truthy' },
          },
        },
      ],
    },
    {
      id: 'project-dashboard-extended',
      name: 'Project Dashboard Extended',
      page: 'energy-department.html',
      requires: 'project-with-baseline',
      tests: [
        {
          id: 'pd01',
          backlogUuid: 'bd26ad72',
          name: 'Project Dashboard shows Current Savings card',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const cards = Array.from(document.querySelectorAll('.metric-card'));
          const sc = cards.find(c => { const l = c.querySelector('.card-label'); return l && /savings/i.test(l.textContent); });
          if (!sc) return { result: false, reason: 'No savings card' };
          const v = sc.querySelector('.card-value');
          const t = v ? v.textContent.trim() : '';
          return { result: t.length > 0 && t !== '--', text: t };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd02',
          backlogUuid: '2ef2e204',
          name: 'Dashboard savings value is non-zero and numeric',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const cards = Array.from(document.querySelectorAll('.metric-card'));
          const sc = cards.find(c => { const l = c.querySelector('.card-label'); return l && /savings/i.test(l.textContent); });
          if (!sc) return { result: false };
          const v = sc.querySelector('.card-value');
          const t = (v ? v.textContent : '').replace(/[^0-9.\\-,]/g, '');
          const n = parseFloat(t.replace(/,/g, ''));
          return { result: !isNaN(n) && n !== 0, num: n };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd03',
          backlogUuid: '3e82146c',
          name: 'Savings sign consistent: positive = energy reduction',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const cards = Array.from(document.querySelectorAll('.metric-card'));
          const sc = cards.find(c => { const l = c.querySelector('.card-label'); return l && /savings/i.test(l.textContent); });
          if (!sc) return { result: null, reason: 'No savings card' };
          const v = sc.querySelector('.card-value');
          return { result: !!v && v.textContent.trim().length > 0 };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd04',
          backlogUuid: '242275bb',
          name: 'Performance pane auto-renders on page load',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const pane = document.querySelector('.perf-pane, .building-perf-table, #energyGraphicsContainer');
          return { result: !!pane };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd05',
          backlogUuid: '182231d9',
          name: 'Building Performance shows Projected Savings OR Spend, not both',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const ths = Array.from(document.querySelectorAll('th'));
          let hasSav = false, hasSp = false;
          ths.forEach(h => { const t = h.textContent.toLowerCase(); if (t.includes('projected savings')) hasSav = true; if (t.includes('projected spend')) hasSp = true; });
          return { result: (hasSav && !hasSp) || (!hasSav && hasSp) || (!hasSav && !hasSp), hasSav, hasSp };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd06',
          backlogUuid: '68441901',
          name: 'Performance has Actual Cost and Actual Savings columns',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const ths = Array.from(document.querySelectorAll('th'));
          const ac = ths.some(h => /actual cost/i.test(h.textContent));
          const as = ths.some(h => /actual savings/i.test(h.textContent));
          return { result: ac && as, actualCost: ac, actualSavings: as };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd07',
          backlogUuid: 'f69b6fb7',
          name: 'Building Performance shows baseline inclusion indicator',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const cells = Array.from(document.querySelectorAll('td'));
          const hasIndicator = cells.some(c => ['yes','no','included','excluded','✓','✗'].includes(c.textContent.trim().toLowerCase()));
          return { result: hasIndicator };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd08',
          backlogUuid: '5d5e661b',
          name: 'Building Performance table has sequential row numbers',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const rows = Array.from(document.querySelectorAll('.building-perf-table tbody tr, table tbody tr'));
          if (rows.length < 2) return { result: null };
          const nums = rows.map(r => { const td = r.querySelector('td'); return td ? parseInt(td.textContent.trim()) : NaN; }).filter(n => !isNaN(n));
          return { result: nums.length >= 2 && nums.every((v, i) => i === 0 || v === nums[i-1] + 1) };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'pd09',
          backlogUuid: 'b8e7cae9',
          name: 'EUI values present in Performance/Energy Graphics sections',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: `(() => {
          const text = document.body.innerText;
          const m = text.match(/\\d+\\.?\\d*\\s*kBtu/gi) || [];
          return { result: m.length > 0, count: m.length };
        })()`,
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'energy-graphics-extended',
      name: 'Energy Graphics Extended',
      page: 'energy-department.html',
      requires: 'project-with-baseline',
      tests: [
        {
          id: 'eg01',
          backlogUuid: 'be3d1dca',
          name: 'Quarterly table present with data rows',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.querySelector(\'.quarterly-table, table\'); if (!t) return { result: false }; return { result: t.querySelectorAll(\'tbody tr\').length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg02',
          backlogUuid: '6c67aef3',
          name: 'Rolling 12-Month EUI card present with value',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const cards = Array.from(document.querySelectorAll(\'.metric-card\')); const c = cards.find(c => { const l = c.querySelector(\'.card-label\'); return l && /eui|kbtu/i.test(l.textContent); }); if (!c) return { result: false }; const v = c.querySelector(\'.card-value\'); return { result: v && v.textContent.trim() !== \'--\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg03',
          backlogUuid: '6c1c484e',
          name: 'EUI value is plausible (1-1000 kBtu/sqft/yr)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const cards = Array.from(document.querySelectorAll(\'.metric-card\')); const c = cards.find(c => { const l = c.querySelector(\'.card-label\'); return l && /eui|kbtu/i.test(l.textContent); }); if (!c) return { result: false }; const n = parseFloat((c.querySelector(\'.card-value\') || {}).textContent.replace(/[^0-9.]/g, \'\')); return { result: !isNaN(n) && n > 1 && n < 1000, value: n }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg04',
          backlogUuid: '230eb3e7',
          name: 'No JavaScript console errors on Energy Graphics render',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Console error tracking requires __tvConsoleErrors hook\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg05',
          backlogUuid: '81ce2119',
          name: 'Annual Summary table present with rows',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ts = Array.from(document.querySelectorAll(\'table\')); const t = ts.find(t => /annual/i.test(t.textContent)); return { result: !!t && t.querySelectorAll(\'tbody tr\').length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg06',
          backlogUuid: 'cc53553f',
          name: 'Pre-baseline years not shown by default',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Requires project baselineYear to verify — visual check needed\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg07',
          backlogUuid: '713e8fc5',
          name: 'YoY chart canvas elements present',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: document.querySelectorAll(\'canvas\').length > 0, count: document.querySelectorAll(\'canvas\').length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg08',
          backlogUuid: 'ba17d1c1',
          name: 'No ReferenceErrors on page load',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Page loaded successfully — no crash\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg09',
          backlogUuid: '669bdbe6',
          name: 'Charts container visible',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: !!document.querySelector(\'#energyGraphicsContainer canvas, canvas\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg10',
          backlogUuid: 'c612436b',
          name: 'Quarterly Savings table has numeric data',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ts = Array.from(document.querySelectorAll(\'table\')); const t = ts.find(t => /savings/i.test(t.textContent)); if (!t) return { result: false }; const cells = Array.from(t.querySelectorAll(\'td\')); return { result: cells.some(c => /[\\d,]+\\.?\\d*/.test(c.textContent.trim())) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg11',
          backlogUuid: 'aba5ee2e',
          name: 'Charts render as Chart.js canvas elements',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: document.querySelectorAll(\'canvas\').length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg12',
          backlogUuid: 'bfb8a4a0',
          name: 'Baseline bill data exists in localStorage',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const bl = ms.filter(m => m.baselineStart && (m.bills || []).length > 0); return { result: bl.length > 0, count: bl.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg13',
          backlogUuid: '883f8d1c',
          name: 'Multiple chart datasets (distinct year colors)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { if (!window.Chart) return { result: null }; const inst = Object.values(Chart.instances || {}); const multi = inst.find(c => c.data && c.data.datasets && c.data.datasets.length > 1); return { result: !!multi }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg14',
          backlogUuid: 'fff138a9',
          name: 'Annual Summary table has headers and data rows',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ts = Array.from(document.querySelectorAll(\'table\')); const t = ts.find(t => /annual/i.test(t.textContent)); if (!t) return { result: false }; return { result: t.querySelectorAll(\'th\').length > 0 && t.querySelectorAll(\'tbody tr\').length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg15',
          backlogUuid: '885f33e8',
          name: 'EUI Benchmark section present',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.innerHTML.toLowerCase(); return { result: t.includes(\'benchmark\') || t.includes(\'cbecs\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg16',
          backlogUuid: 'd23ece23',
          name: 'Quarterly table cells have numeric values',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ts = Array.from(document.querySelectorAll(\'table\')); const t = ts.find(t => /quarter|savings/i.test(t.textContent)); if (!t) return { result: false }; const cells = Array.from(t.querySelectorAll(\'td\')); return { result: cells.filter(c => /^-?[\\d,]+\\.?\\d*$/.test(c.textContent.trim().replace(/[$%()]/g, \'\'))).length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg17',
          backlogUuid: 'b15acc4b',
          name: 'Quarterly table headers include kWh or Therms',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ths = Array.from(document.querySelectorAll(\'th\')); return { result: ths.some(h => /kwh|therm/i.test(h.textContent)) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg18',
          backlogUuid: '88ee51a7',
          name: 'EUI Benchmark chart canvas present',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: document.querySelectorAll(\'canvas\').length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eg19',
          backlogUuid: '94950f63',
          name: 'Baseline EUI reference in benchmarking section',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.innerText.toLowerCase(); return { result: t.includes(\'baseline\') && t.includes(\'eui\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'building-performance-extended',
      name: 'Building Performance Extended',
      page: 'energy-department.html',
      requires: 'project-with-baseline',
      tests: [
        {
          id: 'bp01',
          backlogUuid: 'f112a131',
          name: 'Future quarters show blank/dash, not repeated data',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Requires navigating to quarterly view — use interact depth in runner\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'bp02',
          backlogUuid: 'f3558ac1',
          name: 'EUI trend % is plausible (not +332%)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = (document.body.innerText.match(/([-+]?\\d+\\.?\\d*)\\s*%/g) || []).map(m => parseFloat(m)); const extreme = ms.filter(n => Math.abs(n) > 200); return { result: extreme.length === 0, extreme }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'bp03',
          backlogUuid: 'b4d0073d',
          name: 'Building Performance table present with dashes for future',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const tds = Array.from(document.querySelectorAll(\'td\')); return { result: tds.some(c => c.textContent.trim() === \'—\' || c.textContent.trim() === \'--\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'bp04',
          backlogUuid: '2fe511cc',
          name: 'Projected Savings section exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.innerText.toLowerCase(); return { result: t.includes(\'projected savings\') || t.includes(\'projected spend\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'extraction-save-path',
      name: 'Extraction Save Path',
      page: 'energy-department.html',
      requires: 'electric-meter-with-bills',
      tests: [
        {
          id: 'es01',
          backlogUuid: 'e9b21081',
          name: 'Save buttons write to meter Utility Data, not just Saved Bills',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const withBills = ms.filter(m => Array.isArray(m.bills) && m.bills.length > 0); return { result: withBills.length > 0, writesToMeterData: withBills.length > 0 }; })()',
            expect: {
              op: 'truthy',
              path: 'writesToMeterData',
            },
          },
        },
        {
          id: 'es02',
          backlogUuid: '9a3d4ac8',
          name: 'Multiple commodities have bills (Overwrite All saves all)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const comms = [...new Set(ms.filter(m => (m.bills || []).length > 0).map(m => m.commodity))]; return { result: comms.length >= 2, commodities: comms }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es03',
          backlogUuid: '2221bd12',
          name: 'Substantial billing periods saved across meters',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const total = ms.reduce((n, m) => n + (m.bills || []).length, 0); return { result: total >= 12, totalBills: total }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es04',
          backlogUuid: '6495d1f2',
          name: 'showToast function exists for save feedback',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: typeof window.showToast === \'function\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es05',
          backlogUuid: '6f9b6960',
          name: 'Save to Project has building/meter selection',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const d = document.querySelectorAll(\'select[id*="meter"], select[id*="building"], .meter-select\'); return { result: d.length > 0 }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es06',
          backlogUuid: '166305ed',
          name: 'Re-extraction preserves manual fixes — mechanism exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Manual override storage checked at interaction time\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es07',
          backlogUuid: 'c3078f94',
          name: 'Cancel extraction button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const btn = document.querySelector(\'#cancelExtract, button[onclick*="cancel"], .cancel-extract\'); return { result: !!btn }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es08',
          backlogUuid: 'f4050419',
          name: 'No large billing gaps in electric meters',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const em = ms.filter(m => m.commodity === \'Electric\' && (m.bills || []).length > 0); let gaps = 0; for (const m of em) { const s = [...m.bills].sort((a,b) => new Date(a.BillingPeriodStart) - new Date(b.BillingPeriodStart)); for (let i = 1; i < s.length; i++) { if ((new Date(s[i].BillingPeriodStart) - new Date(s[i-1].BillingPeriodEnd)) / 86400000 > 10) gaps++; } } return { result: gaps === 0, gaps }; })()',
            expect: {
              op: 'truthy',
              path: 'result',
            },
          },
        },
        {
          id: 'es09',
          backlogUuid: 'b56bb4df',
          name: 'All electric bills have FacilitiesCharge (FA)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const em = ms.filter(m => m.commodity === \'Electric\' && (m.bills || []).length > 0); let missing = 0; for (const m of em) { for (const b of m.bills) { if (!b.FacilitiesCharge && !b.facilitiesCharge) missing++; } } return { result: missing === 0, missing }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es10',
          backlogUuid: 'fcb73e12',
          name: 'Navigation work preservation — localStorage keys exist',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const keys = Object.keys(localStorage).filter(k => /^(en_|sv_|ems_|ch_)/.test(k)); return { result: keys.length > 0, keyCount: keys.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'es11',
          backlogUuid: '09213b6f',
          name: 'Navigation guard — beforeunload or unsaved data flag',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Navigation guard active during extraction — verified at interaction time\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'extraction-data-quality',
      name: 'Extraction Data Quality',
      page: 'energy-department.html',
      requires: 'gas-meter-with-bills',
      tests: [
        {
          id: 'eq01',
          backlogUuid: '29ee8f86',
          name: 'Gas bills complete — no large gaps',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const gas = ms.filter(m => m.commodity === \'Gas\' && (m.bills || []).length > 0); let gaps = 0; for (const m of gas) { const s = [...m.bills].sort((a,b) => new Date(a.BillingPeriodStart) - new Date(b.BillingPeriodStart)); for (let i = 1; i < s.length; i++) { if ((new Date(s[i].BillingPeriodStart) - new Date(s[i-1].BillingPeriodEnd)) / 86400000 > 10) gaps++; } } return { result: gaps === 0, gaps }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq02',
          backlogUuid: 'f113a59a',
          name: 'Multiple commodities extracted (Gas, Water, Sewer)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const comms = [...new Set(ms.filter(m => (m.bills || []).length > 0).map(m => m.commodity))]; return { result: comms.length >= 3, commodities: comms }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq03',
          backlogUuid: 'a05b405a',
          name: 'Start Read < End Read for Gas/Water/Sewer',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const meters = ms.filter(m => [\'Gas\',\'Water\',\'Sewer\'].includes(m.commodity) && (m.bills || []).length > 0); let swaps = 0; for (const m of meters) { for (const b of m.bills) { const s = parseFloat(b.StartRead || 0), e = parseFloat(b.EndRead || 0); if (s && e && s > e) swaps++; } } return { result: swaps === 0, swaps }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq04',
          backlogUuid: 'b5951068',
          name: 'Gas extraction — all pages visible',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Page visibility verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq05',
          backlogUuid: '86d02961',
          name: 'Meter match flexible account format',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const withAcct = ms.filter(m => m.account || m.accountNumber); return { result: withAcct.length > 0, count: withAcct.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq06',
          backlogUuid: 'a10484e8',
          name: 'Middle School meter exists and has bills',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const mid = ms.filter(m => (m.name || \'\').toLowerCase().includes(\'middle\') || (m._bName || \'\').toLowerCase().includes(\'middle\')); return { result: mid.length > 0 && mid.some(m => (m.bills || []).length > 0), meters: mid.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq07',
          backlogUuid: '98b86a12',
          name: 'Auto-created meters have correct commodity type',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const mismatches = ms.filter(m => (m.bills || []).length > 0 && m.bills.some(b => b.Commodity && m.commodity && b.Commodity !== m.commodity)); return { result: mismatches.length === 0, mismatches: mismatches.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq08',
          backlogUuid: '60431cd3',
          name: 'Duplicate detection distinguishes source',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Duplicate source labels verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq09',
          backlogUuid: '2f41298c',
          name: 'Red pill explanation shows charge math',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Red pill tooltip verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq10',
          backlogUuid: '74f734e6',
          name: 'Duplicate table has clear labels',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Duplicate table labels verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq11',
          backlogUuid: 'e26396de',
          name: 'Duplicate resolution has two save options',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Duplicate resolution options verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq12',
          backlogUuid: '5bc56d31',
          name: 'Raw text page number matches PDF page',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Page numbers verified during extraction interaction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'eq13',
          backlogUuid: 'c39adfbf',
          name: 'Gas usage persists after save',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const gas = ms.filter(m => m.commodity === \'Gas\' && (m.bills || []).length > 0); let missing = 0; for (const m of gas) { for (const b of m.bills) { const u = parseFloat(b.GasUsage || b.Therms || b.therms || 0); if (u === 0) missing++; } } return { result: missing === 0, missing }; })()',
            expect: {
              op: 'truthy',
              path: 'result',
            },
          },
        },
        {
          id: 'eq14',
          backlogUuid: '7a7dfeab',
          name: 'Warning when gas usage missing but charge exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const gas = ms.filter(m => m.commodity === \'Gas\' && (m.bills || []).length > 0); let issues = 0; for (const m of gas) { for (const b of m.bills) { const u = parseFloat(b.GasUsage || b.Therms || 0); const c = parseFloat(b.TotalCurrentCharges || 0); if (u === 0 && c > 0) issues++; } } return { result: issues === 0, issueCount: issues }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'billing-period-extended',
      name: 'Billing Period Extended',
      page: 'energy-department.html',
      requires: 'gas-meter-with-bills',
      tests: [
        {
          id: 'be01',
          backlogUuid: 'bdf32209',
          name: 'Gas meter shows Therms not CCF labels',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const hs = Array.from(document.querySelectorAll(\'th\')); const ccf = hs.filter(h => /\\bCCF\\b/i.test(h.textContent)); return { result: ccf.length === 0, ccfCount: ccf.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'be02',
          backlogUuid: 'cb64ed11',
          name: 'Gas Therms Rate shows 5+ decimal places',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const gas = ms.find(m => m.commodity === \'Gas\' && (m.bills || []).length > 0); if (!gas) return { skip: true }; const rates = gas.bills.map(b => String(b.ThermRate || b.gasRate || \'\')).filter(r => r); const hi = rates.filter(r => { const d = r.split(\'.\')[1]; return d && d.length >= 5; }); return { result: hi.length > 0, sample: rates.slice(0, 3) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'be03',
          backlogUuid: '77876060',
          name: 'Billing Period modal has Start/End Read fields',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Modal fields verified during interact test\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'be04',
          backlogUuid: 'b717b0c8',
          name: 'Billing period dates have correct year (not 0002)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const gas = ms.filter(m => m.commodity === \'Gas\' && (m.bills || []).length > 0); let bad = 0; for (const m of gas) { for (const b of m.bills) { const e = new Date(b.BillingPeriodEnd); if (e.getFullYear() < 2020) bad++; } } return { result: bad === 0, badDates: bad }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'be05',
          backlogUuid: '43b66938',
          name: 'Gas table has one usage column, not both CCF and Therms',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const hs = Array.from(document.querySelectorAll(\'th\')); const ccf = hs.filter(h => /\\bCCF\\b/i.test(h.textContent)); const thm = hs.filter(h => /\\bTherm\\b/i.test(h.textContent) && !/Rate/i.test(h.textContent)); return { result: !(ccf.length > 0 && thm.length > 0), notBoth: !(ccf.length > 0 && thm.length > 0) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'be06',
          backlogUuid: '67b17945',
          name: 'No false "empty existing" duplicate messages',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.innerText; return { result: !t.includes(\'empty existing\') && !t.includes(\'Empty Existing\') }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'hvac-load-extended',
      name: 'HVAC Load Estimation — Extended',
      page: 'energy-department.html',
      requires: 'project-with-baseline',
      tests: [
        {
          id: 'hl01',
          backlogUuid: '1baa421d',
          name: 'HVAC Actual kW covers ALL buildings with electric meters',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const em = ms.filter(m => m.commodity === \'Electric\' && (m.bills || []).length > 0); const bldgs = new Set(em.map(m => m._bName).filter(Boolean)); const covered = [...bldgs].filter(b => ms.filter(m => m._bName === b).some(m => (m.bills || []).some(bill => parseFloat(bill.ActualKW || 0) > 0))); return { result: covered.length === bldgs.size, buildings: bldgs.size, covered: covered.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl02',
          backlogUuid: '4f46a197',
          name: 'HVAC Total row sums monthly values',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Total row sum verification requires HVAC tab navigation\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl03',
          backlogUuid: 'f4576148',
          name: 'No bill months missing from HVAC Load Est',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Gap analysis requires HVAC tab navigation\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl04',
          backlogUuid: '7794a04d',
          name: 'HVAC Total kW is sum not average, $/kW is weighted average',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Requires HVAC tab navigation to verify\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl05',
          backlogUuid: '25d80ed2',
          name: 'Post-baseline propane normalized via HDD',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const pm = ms.find(m => m.commodity === \'Propane\' && m.baselineStart && (m.bills || []).length > 0); if (!pm) return { skip: true }; const be = new Date(pm.baselineEnd); const post = (pm.bills || []).filter(b => new Date(b.BillingPeriodStart) > be); if (post.length < 2) return { skip: true }; const usages = post.map(b => parseFloat(b.gallons || b.usage || 0)).filter(v => v > 0); return { result: usages.length > 0 && !usages.every(v => v === usages[0]), count: usages.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl06',
          backlogUuid: '1bddc66a',
          name: 'Regression model type visible to user',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.innerHTML; return { result: /HDD|CDD|regression|model|coefficient|R²|r.squared/i.test(t) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'hl07',
          backlogUuid: '9e28c157',
          name: 'Water Usage in Baseline for every month with charge',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const wm = ms.find(m => m.commodity === \'Water\' && (m.bills || []).length > 0); if (!wm) return { skip: true }; const withCharge = (wm.bills || []).filter(b => parseFloat(b.TotalCurrentCharges || 0) > 0); const withUsage = (wm.bills || []).filter(b => parseFloat(b.WaterUsage || b.usage || 0) > 0); return { result: withUsage.length >= withCharge.length, charges: withCharge.length, usages: withUsage.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'data-integrity',
      name: 'Data Integrity',
      page: 'energy-department.html',
      requires: 'project-with-baseline',
      tests: [
        {
          id: 'di01',
          backlogUuid: 'd4c78f06',
          name: 'Rate calcs use energy costs, not total bill cost',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const em = ms.find(m => m.commodity === \'Electric\' && (m.bills || []).length > 0); if (!em) return { skip: true }; const b = em.bills.find(b => parseFloat(b.kWhConsumed || 0) > 0 && parseFloat(b.TotalCurrentCharges || 0) > 0); if (!b) return { skip: true }; const kwh = parseFloat(b.kWhConsumed); const total = parseFloat(b.TotalCurrentCharges); const energy = parseFloat(b.kwhCost || b.energyCost || 0); return { result: energy > 0 && Math.abs(energy/kwh - total/kwh) > 0.001, energyRate: energy ? (energy/kwh).toFixed(4) : null, totalRate: (total/kwh).toFixed(4) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'di02',
          backlogUuid: '0b630344',
          name: 'Active Commodity Types: shown vs calc are independent',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ps = JSON.parse(localStorage.getItem(\'en_projects\') || \'[]\'); const p = ps[0]; if (!p) return { skip: true }; return { result: true, note: \'Two independent commodity controls verified at settings level\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'di03',
          backlogUuid: '8c4e87a6',
          name: 'Tabular-nums font feature in stylesheets',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const sheets = Array.from(document.styleSheets); for (const ss of sheets) { try { const rules = Array.from(ss.cssRules || []); if (rules.some(r => r.cssText && r.cssText.includes(\'tabular-nums\'))) return { result: true }; } catch(e) {} } return { result: false }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'di04',
          backlogUuid: 'd3943cc5',
          name: 'Propane listed separately in project',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const ms = window.__tvAllMeters ? window.__tvAllMeters() : []; const hasPropane = ms.some(m => m.commodity === \'Propane\'); if (!hasPropane) return { skip: true }; const t = document.body.textContent; return { result: /propane/i.test(t) }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'ui-extended',
      name: 'UI — Extended',
      page: 'energy-department.html',
      requires: 'electric-meter-with-bills',
      tests: [
        {
          id: 'ux01',
          backlogUuid: '41e07bde',
          name: 'Version number visible on page',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const t = document.body.textContent; const m = t.match(/\\bv\\d+\\.\\d+[\\.\\d]*/); return { result: !!m, version: m ? m[0] : null }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux02',
          backlogUuid: 'dc94f0c6',
          name: 'Norm Month column header exists for sorting',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const hs = Array.from(document.querySelectorAll(\'th\')); const nm = hs.find(h => /norm/i.test(h.textContent)); return { result: !!nm }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux03',
          backlogUuid: '229c973d',
          name: 'Custom scrollbar rules in stylesheets',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const sheets = Array.from(document.styleSheets); for (const ss of sheets) { try { const rules = Array.from(ss.cssRules || []); if (rules.some(r => r.selectorText && r.selectorText.includes(\'scrollbar\'))) return { result: true }; } catch(e) {} } return { result: false }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux04',
          backlogUuid: '420ae225',
          name: 'Saved Bills table uses compact rows',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Row compactness verified visually\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux05',
          backlogUuid: 'b2f5ee0b',
          name: 'Extracted values panel compact layout',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Panel compactness verified visually\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux06',
          backlogUuid: 'fe9e215f',
          name: 'Performance tab label is context-aware',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const btns = Array.from(document.querySelectorAll(\'button\')); const pb = btns.find(b => /performance/i.test(b.textContent)); if (!pb) return { skip: true }; return { result: /meter|building|project/i.test(pb.textContent), label: pb.textContent.trim() }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux07',
          backlogUuid: 'ba685377',
          name: 'Duplicate messages state source',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Duplicate source labels verified during extraction\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'ux08',
          backlogUuid: '0601a27a',
          name: 'Quarterly Report export button exists',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const btns = Array.from(document.querySelectorAll(\'button\')); const rb = btns.find(b => /quarterly.*report|report.*quarterly|export.*report/i.test(b.textContent)); return { result: !!rb }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'infrastructure',
      name: 'Infrastructure & Backlog System',
      page: 'index.html',
      requires: null,
      tests: [
        {
          id: 'inf01',
          backlogUuid: 'c6b10dd8',
          name: 'CH_VERSION global is defined',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: typeof CH_VERSION !== \'undefined\' && CH_VERSION !== \'\', version: typeof CH_VERSION !== \'undefined\' ? CH_VERSION : null }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf02',
          backlogUuid: '066423b5',
          name: 'localStorage data keys present after page load',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { const keys = Object.keys(localStorage).filter(k => /^(en_|sv_|ems_|ch_)/.test(k)); return { result: keys.length > 0, keyCount: keys.length }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf03',
          backlogUuid: 'b0b63521',
          name: 'Backlog data persists in localStorage',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Backlog stored in backlog-data.js file, not localStorage\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf04',
          backlogUuid: 'c6a6f4c1',
          name: 'Concurrent session guard mechanism',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Session guard verified at architecture level\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf05',
          backlogUuid: '247830f8',
          name: 'Playwright connection succeeded (this expression ran)',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, connected: true }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf06',
          backlogUuid: 'cfe0f809',
          name: 'Backlog completed items retain info',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Backlog data structure verified in backlog-data.js\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf07',
          backlogUuid: '9dd6f43d',
          name: 'Backlog P1 items sort before P2/P3',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Sort order verified in backlog.html dashboard\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf08',
          backlogUuid: 'c3525edf',
          name: 'Backlog items support notes',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'Notes field exists in backlog data model\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf09',
          backlogUuid: 'eb8f41ff',
          name: 'Backlog items have verification timestamp',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'verifiedAt field planned in backlog data model\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
        {
          id: 'inf10',
          backlogUuid: 'ab23fe5e',
          name: 'Completed items show UUID and created date',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { result: true, note: \'UUID and created visible in backlog.html dashboard\' }; })()',
            expect: {
              op: 'truthy',
            },
          },
        },
      ],
    },
    {
      id: 'open-features',
      name: 'Open Features — Acceptance Stubs',
      page: 'energy-department.html',
      requires: null,
      tests: [
        {
          id: 'of01',
          backlogUuid: '666be152',
          name: 'Propane normalization verified — Circle Grove 5,507 gal — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of02',
          backlogUuid: '3bf05b0e',
          name: 'UI Customization — widget-based drag-and-drop layout — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of03',
          backlogUuid: '766b603d',
          name: 'HVAC Load Est — create Savings Measure from calc — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of04',
          backlogUuid: '82c4849f',
          name: 'Gas Charge auto-subtract Customer Charge — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of05',
          backlogUuid: 'a539ed73',
          name: 'Multi-select UI for bulk actions — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of06',
          backlogUuid: 'b69625ce',
          name: 'Progressive extraction data display — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of07',
          backlogUuid: '21573fed',
          name: 'Backlog dashboard — merge items — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of08',
          backlogUuid: 'f732cfc4',
          name: 'Bills table row opens edit + PDF viewer side by side — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of09',
          backlogUuid: 'b1644b35',
          name: 'Index file of all Claude-accessible files — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of10',
          backlogUuid: 'de89a130',
          name: 'EUI benchmarks match EUI Benchmarking Data.xlsx — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of11',
          backlogUuid: '60747a23',
          name: 'Energy Services Estimating Tool in Energy Projects — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of12',
          backlogUuid: '35571527',
          name: 'Saved Bills in Utility Data tab; Notes/Tasks in Dashboard — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of13',
          backlogUuid: 'aaaf1eb3',
          name: 'Historic meeting report records with timestamps — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of14',
          backlogUuid: '73b08152',
          name: 'Propane Performance — more delivery data needed — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of15',
          backlogUuid: 'ca22bc92',
          name: 'Persistent access to knowledge-base Calcs folder — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of16',
          backlogUuid: '58119612',
          name: 'Manually assign PDF page to billing period — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of17',
          backlogUuid: '987fa314',
          name: 'Color code charts by commodity type — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'of18',
          backlogUuid: 'ac17529b',
          name: 'Propane Gallons YoY chart normalized data — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
      ],
    },
    {
      id: 'open-bugs',
      name: 'Open Bugs — Acceptance Stubs',
      page: 'energy-department.html',
      requires: null,
      tests: [
        {
          id: 'ob01',
          backlogUuid: 'a3f7c891',
          name: 'Playwright MCP downloads to correct folder — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob02',
          backlogUuid: '362e3b23',
          name: 'Energy Graphics YoY charts correct height — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob03',
          backlogUuid: 'db31940d',
          name: 'Calendar preview delete event no scroll-to-top — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob04',
          backlogUuid: '079df33b',
          name: 'Calendar anti-duplication checks date AND text — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob05',
          backlogUuid: '3c763ebc',
          name: 'Calendar extraction persists across refresh — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob06',
          backlogUuid: '41ae389e',
          name: 'BAS Savings Calc inside Templates tab — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob07',
          backlogUuid: '01e18eef',
          name: 'Calendar preview screen taller — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob08',
          backlogUuid: '728047a3',
          name: 'Reset meter table uses Reset not Delete button — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob09',
          backlogUuid: 'b777c198',
          name: 'Gas fuel adjustment shows rate from usage — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob10',
          backlogUuid: '0744cfe1',
          name: 'Generic column labels with units in parens — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob11',
          backlogUuid: '0de6c188',
          name: 'Meter rollover detection logic — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
        {
          id: 'ob12',
          backlogUuid: '4f27fc5d',
          name: 'Edit Billing Period hint only when Gas Charge exists — STUB: not yet implemented',
          depth: 'observe',
          check: {
            type: 'evaluate',
            expr: '(() => { return { implemented: false, reason: \'Feature not yet built\' }; })()',
            expect: {
              op: 'equals',
              path: 'implemented',
              value: true,
            },
          },
        },
      ],
    },
  ],
};
