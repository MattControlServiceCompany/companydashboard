// verify-report-reconciliation.js
//
// The reconciliation gate for CompanyHub's client-facing reports (ASHRAE 36 Audit Report +
// Service Proposal). Built per the plan at
// AI/_context/plans/reports-completion-and-number-audit-2026-07-29.md, sections B-2/R-1.
//
// WHY THIS EXISTS (read before touching this file)
// --------------------------------------------------
// Three real defects shipped the same day (2026-07-29), all the same shape: a rendered number
// that does not reconcile with the row population behind it.
//   1. Priced scope never named   -- Recommended timeline truncated to 3 of 19 phases with
//      nothing telling the client the other phases existed (check (b) below).
//   2. Named scope never priced  -- the cover printed RAW per-equipment accumulators
//      (p.totalMissingHardwarePoints / p.totalNotReadySequences: 4,049 / 1,764) instead of the
//      PRICED, deduped catalog counts (1,291 / 1,285) that the tool actually quotes (check (c)).
//   3. A total summing a different population -- the cover's sequence sum used `phase===2`
//      instead of `phase===2 && seqKey`, silently folding 19 sensor-investigation LABOR rows in
//      as if they were G36 sequences (check (a)).
// All three were found by hand, one at a time. This script turns that hunt into a standing gate.
//
// THE INVARIANT
// --------------------------------------------------
// Every client-rendered count or dollar figure must be expressible as a sum, over an EXPLICITLY
// NAMED predicate, of ONE canonical row universe U = buildCatalogRows(projId) (tiers/timeline are
// declared filters or supersets of U). For each document:
//   (a) every rendered total equals the sum of its rendered parts EXACTLY -- the SAME rounding
//       applied to parts and to the total;
//   (b) U minus the union of all rendered predicates is either empty, or is itself rendered as a
//       named, zero-dollar section (e.g. "Future Work"/an exclusion note) -- no silent truncation;
//   (c) no rendered figure reads a raw accumulator (p.totalMissingHardwarePoints,
//       p.totalNotReadySequences, eq.compliance.missingPoints, ...) where a priced, deduped
//       counterpart (buildCatalogRows) exists.
//
// HOW TO ADD A NEW FIGURE TO THE REGISTRY
// --------------------------------------------------
// 1. Find the render site in app/report-engine.js and read its comment for which predicate over
//    U it claims to implement (report-engine.js is full of these comments as of the 2026-07-29
//    reconciliation fixes -- read the nearest one before writing a new predicate).
// 2. In `gatherPageData()` below (the single page.evaluate call), compute the SAME predicate over
//    `catRows` (or the appropriate tier-builder's rows) using the REAL production function/filter
//    literal -- copy the exact boolean expression from the render site, never a re-derivation of
//    "what it probably should be." Add the resulting number(s) to the object gatherPageData
//    returns.
// 3. Extract the RENDERED number for the same figure from the actual generated HTML (regex or
//    DOM query against the injected container -- see the cover/per-building examples below).
// 4. Add ONE row to REGISTRY (below) with { id, doc, checkType: 'a'|'b'|'c', run(bundle) } that
//    compares the two and returns { pass, expected, actual, detail }.
// Forgetting step 4 is itself a gap -- the registry is the whole point: a figure with no
// registry row is a figure this gate does not protect.
//
// HARNESS OF RECORD
// --------------------------------------------------
// Headless Chromium (bundled Playwright Chromium, NEVER port 9222 / the user's live Edge) loads
// the REAL energy-department.html, restores the REAL JOCO backup export through
// window.__siteUI.restoreData() (the actual UI restore path), then calls the REAL production
// functions in-page (buildCatalogRows, collectASHRAE36Data, generateASHRAE36AuditHTML,
// generateASHRAE36ProposalHTML, _pricingComputeSummaryData, _pricingProposalTermAndFuture,
// _rptA36PhaseSeqCategoryNames, ...) -- nothing in this file reimplements any report or pricing
// logic. The generated HTML is injected into a real (detached) DOM node on the live page so
// figures are extracted from an actual rendered DOM, not a string napkin-match.
//
// HARNESS TRAP (documented in the plan; handled below): restoreData() triggers a delayed
// location.reload(). page.waitForNavigation({waitUntil:'load'}) is armed BEFORE setFiles() and
// awaited immediately after -- only then do we poll for DB-ready.
//
// USAGE
// --------------------------------------------------
//   node scripts/verify-report-reconciliation.js --app-url <file:///...energy-department.html> \
//     [--data <path to backup json>] [--proj <projId>] [--oracle <path to oracle json>] \
//     [--label <string tag printed in the report header>]
// Defaults (all overridable): data file + proj id + known-good oracle values are read from
// AI/_context/reference/known-good-values/ at runtime -- NEVER hardcoded as literals in this
// file (that folder is outside the git repo and is never committed/pushed; see
// reference_known_good_values_no_git.md). This script itself is TRACKED by git and, by
// construction, contains zero client dollar figures -- every expected value is loaded from that
// external file at runtime, and the printed report only ever shows the app's OWN computed/
// rendered numbers, not anything pasted in from a spreadsheet.
//
// Exit code: 0 = clean pass, 1 = ANY (a)/(b)/(c) violation or harness error (gates a deploy).

'use strict';
const path = require('path');
const fs = require('fs');

// REPO_ROOT must resolve to the tree this script is actually running FROM (primary checkout
// or a git worktree), not a fixed path -- otherwise the gate silently grades a different tree
// than the one under test (backlog 53b15c49dc7ab28e). Derived from this script's own location:
// scripts/verify-report-reconciliation.js -> one level up is the repo root.
const REPO_ROOT = path.resolve(__dirname, '..');

// `git worktree add` checkouts do not get their own node_modules install (confirmed: none of
// the existing worktrees under C:/Temp have one). Try resolving playwright from the tree we're
// actually grading first (so a worktree WITH its own install is honored); fall back to the
// primary checkout's shared install as a tooling dependency only. This fallback does NOT change
// which tree's app files get loaded/graded -- that is governed solely by REPO_ROOT above.
function resolvePlaywright(repoRoot) {
  try {
    return require(path.join(repoRoot, 'node_modules', 'playwright'));
  } catch (e) {
    const FALLBACK_PLAYWRIGHT_HOST = 'C:/Users/Matt Miller/AI/companydashboard';
    if (path.resolve(repoRoot) !== path.resolve(FALLBACK_PLAYWRIGHT_HOST)) {
      return require(path.join(FALLBACK_PLAYWRIGHT_HOST, 'node_modules', 'playwright'));
    }
    throw e;
  }
}
const { chromium } = resolvePlaywright(REPO_ROOT);

// ── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const DEFAULT_ORACLE = 'C:/Users/Matt Miller/AI/_context/reference/known-good-values/joco-harness-config.json';
const ORACLE_PATH = args.oracle || DEFAULT_ORACLE;
if (!fs.existsSync(ORACLE_PATH)) {
  console.error('FATAL: oracle config not found at', ORACLE_PATH);
  console.error('This file lives outside the git repo (known-good-values/) and is never committed.');
  process.exit(1);
}
const ORACLE = JSON.parse(fs.readFileSync(ORACLE_PATH, 'utf8'));

const APP_URL = args['app-url'] || 'file:///' + REPO_ROOT.replace(/\\/g, '/') + '/energy-department.html';
const DATA_FILE = args.data || ORACLE.dataFile;
const PROJ_HINT = args.proj || ORACLE.projId;
const LABEL = args.label || APP_URL;

console.log('REPO_ROOT resolved to: ' + REPO_ROOT);
console.log('APP_URL: ' + APP_URL);

if (!DATA_FILE || !fs.existsSync(DATA_FILE)) {
  console.error('FATAL: data file not found:', DATA_FILE);
  process.exit(1);
}

// ── Registry: each entry names ONE rendered figure + which invariant check it proves ───────────
// bundle is the object returned by gatherPageData() (see below). Every predicate here is a
// literal copy of the boolean expression at the cited render site -- not a re-derivation.
const REGISTRY = [
  {
    id: 'cover-sensors-partition',
    doc: 'Audit cover',
    checkType: 'a',
    site: 'report-engine.js rptPageASHRAE36Cover ~13047-13070 (Sensors to Install stat card)',
    predicate: 'Sigma over U where phase===1 && !ioOnly, grouped by building, summed',
    run(b) {
      const expected = b.uSensorTotal;
      const sumParts = b.buildingTotals.reduce((s, r) => s + r.sensors, 0);
      const rendered = b.coverStats['Sensors to Install'];
      const pass = rendered === expected && sumParts === expected;
      return { pass, expected, actual: { rendered, sumOfPerBuildingParts: sumParts } };
    },
  },
  {
    id: 'cover-sequences-partition',
    doc: 'Audit cover',
    checkType: 'a',
    site: 'report-engine.js rptPageASHRAE36Cover ~13047-13070 (Sequences to Program stat card)',
    predicate: 'Sigma over U where phase===2 && seqKey, grouped by building, summed',
    run(b) {
      const expected = b.uSeqTotal;
      const sumParts = b.buildingTotals.reduce((s, r) => s + r.sequences, 0);
      const rendered = b.coverStats['Sequences to Program'];
      const pass = rendered === expected && sumParts === expected;
      return { pass, expected, actual: { rendered, sumOfPerBuildingParts: sumParts } };
    },
  },
  {
    id: 'cover-sensors-not-raw-accumulator',
    doc: 'Audit cover',
    checkType: 'c',
    site: 'report-engine.js rptPageASHRAE36Cover ~13047 (_a36ConsolidatedSensors)',
    predicate: 'rendered figure must equal the buildCatalogRows-derived count, not p.totalMissingHardwarePoints',
    run(b) {
      const rendered = b.coverStats['Sensors to Install'];
      const pass = rendered === b.uSensorTotal && rendered !== b.rawSensors;
      return {
        pass,
        expected: 'equals priced ' + b.uSensorTotal + ', differs from raw accumulator ' + b.rawSensors,
        actual: { rendered, uSensorTotal: b.uSensorTotal, rawAccumulator: b.rawSensors },
      };
    },
  },
  {
    id: 'cover-sequences-not-raw-accumulator',
    doc: 'Audit cover',
    checkType: 'c',
    site: 'report-engine.js rptPageASHRAE36Cover ~13048 (_a36ConsolidatedSequences)',
    predicate: 'rendered figure must equal the buildCatalogRows-derived count, not p.totalNotReadySequences',
    run(b) {
      const rendered = b.coverStats['Sequences to Program'];
      const pass = rendered === b.uSeqTotal && rendered !== b.rawSeq;
      return {
        pass,
        expected: 'equals priced ' + b.uSeqTotal + ', differs from raw accumulator ' + b.rawSeq,
        actual: { rendered, uSeqTotal: b.uSeqTotal, rawAccumulator: b.rawSeq },
      };
    },
  },
  {
    id: 'per-building-rows-not-raw-accumulator',
    doc: 'Audit per-building detail',
    checkType: 'c',
    site: 'report-engine.js _a36BuildingContent ~13969-13975 (totalSensorsNeeded/totalSeqsNotReady)',
    predicate:
      'each building total must equal Sigma over U filtered to that building, not a raw eq.compliance/eq.seqReadiness accumulator',
    run(b) {
      const bad = [];
      b.buildingTotals.forEach((row) => {
        const expSensors = b.sensorsByBuilding[row.building] || 0;
        const expSeq = b.seqByBuilding[row.building] || 0;
        if (row.sensors !== expSensors || row.sequences !== expSeq) {
          bad.push({ building: row.building, rendered: row, expected: { sensors: expSensors, sequences: expSeq } });
        }
      });
      return {
        pass: bad.length === 0,
        expected: 'every rendered per-building total === its buildCatalogRows-filtered predicate value',
        actual: bad.length === 0 ? 'all ' + b.buildingTotals.length + ' buildings match' : bad,
      };
    },
  },
  {
    id: 'timeline-future-work-category-coverage',
    doc: 'Service Proposal (Phase table term categories + opt-in Cost Estimate timeline Future Work row)',
    checkType: 'b',
    // 2026-08-03 (Matt): the client-facing Future Work section was deleted from the proposal --
    // future categories are now named ONLY on the opt-in (default-OFF) Cost Estimate page's
    // internal timeline table (_rptA36RecommendedTimelineHTML's Future Work row), which this
    // script renders (all sections ON). The term/future key union below is that timeline's own
    // population, so the check still holds: every Recommended-tier category is named either in
    // the term schedule or on the internal timeline -- the default proposal intentionally shows
    // the term only.
    site: 'report-engine.js _pricingProposalTermAndFuture + _rptA36RecommendedTimelineHTML',
    predicate:
      // The plan's own invariant text (B-2): "timeline rows subset-of Recommended subset-of
      // U-derived" -- the Recommended tier (buildRecommendedRows) is a DECLARED, ranked/budgeted
      // subset of the full catalog U (buildCatalogRows); categories priced only in Compliance-
      // never-recommended or Full-Scope-only rows are legitimately outside the timeline's universe
      // and must NOT be flagged here (verified 2026-07-30: ahu_freeze_prot/hwp_staging/chwp_staging
      // exist in U but are absent from buildRecommendedRows entirely -- not a truncation, they were
      // never part of the ranked program). The coverage universe for THIS check is therefore
      // buildRecommendedRows' own seqKey set, not the full catalog's.
      'every distinct seqKey category present in buildRecommendedRows (phase===2 && seqKey) must be named in term categories UNION future-work categories',
    run(b) {
      const missing = b.recommendedSeqKeys.filter((k) => !b.namedSeqKeysInRender.includes(k));
      return {
        pass: missing.length === 0,
        expected:
          'all ' +
          b.recommendedSeqKeys.length +
          ' Recommended-tier sequence categories named somewhere (term or Future Work)',
        actual: {
          namedCount: b.namedSeqKeysInRender.length,
          recommendedCount: b.recommendedSeqKeys.length,
          missingCategories: missing,
        },
      };
    },
  },
  {
    // INVERTED 2026-08-03 (was future-work-section-rendered-when-scope-exists): Matt does not
    // want Future Work shown in the JOCO Service Proposal, so the whole client-facing Future Work
    // render path (standalone section, inline table row, Vision-page fallback) was DELETED from
    // report-engine.js. This check now guards the opposite invariant: the deleted section must
    // never come back. The opt-in Cost Estimate page's internal timeline keeps its Future Work
    // row and is excluded from the heading scan (see gatherPageData).
    id: 'future-work-absent-from-proposal-pages',
    doc: 'Service Proposal (schedule + Implementation Plan/Long-Term Vision pages)',
    checkType: 'b',
    site: 'report-engine.js _rptA36PhaseTableDerive / _rptA36VisionInnerHTML (Future Work path deleted 2026-08-03)',
    predicate:
      'the proposalPhaseTable and proposalVision sections must contain neither a "Future Work" heading nor the "Sequence categories addressed in future work:" list',
    run(b) {
      const pass = !b.proposalHasFutureWorkHeading && !b.proposalHasFutureWorkCategoryLine;
      return {
        pass,
        expected: 'no "Future Work" heading and no category line anywhere in the schedule/vision sections',
        actual: {
          headingPresent: b.proposalHasFutureWorkHeading,
          categoryLinePresent: b.proposalHasFutureWorkCategoryLine,
        },
      };
    },
  },
  {
    id: 'tier-hardware-programming-partition',
    doc: 'Service Proposal (opt-in Cost Estimate / Priced Tiers page)',
    checkType: 'a',
    site: 'report-engine.js rptPageASHRAE36ProposalPricing phaseSplitRow (~17558-17610) vs amtRow (~17530-17556)',
    predicate:
      'rendered Hardware & Installation + rendered Programming === rendered Estimated Cost, for Compliance and Full Scope tiers (both read from the SAME tt[tier] object, same _fmtUSD rounding)',
    run(b) {
      const bad = [];
      ['compliance', 'full-scope'].forEach((tier) => {
        const t = b.tierRendered[tier];
        if (!t) {
          bad.push({ tier, reason: 'tier not found in rendered page' });
          return;
        }
        const sum = t.hardware + t.programming;
        if (sum !== t.total)
          bad.push({ tier, hardware: t.hardware, programming: t.programming, sum, renderedTotal: t.total });
      });
      return {
        pass: bad.length === 0,
        expected: 'Hardware + Programming === Estimated Cost for compliance and full-scope, exactly',
        actual: bad.length === 0 ? b.tierRendered : bad,
      };
    },
  },
];

// ── In-page data gathering (ONE evaluate call -- report-engine.js globals can go away after any
// UI navigation per verify-pricing-phases.js's own documented quirk, so nothing here calls
// openDetail() or clicks any tab; everything is a direct function call). ──────────────────────
async function gatherPageData(page, projId) {
  return page.evaluate((projId) => {
    const out = { errors: [] };
    try {
      const data = collectASHRAE36Data(projId);
      if (!data) throw new Error('collectASHRAE36Data returned null');
      const catRows = typeof buildCatalogRows === 'function' ? buildCatalogRows(projId) || [] : [];

      // U-level predicate sums (copy of the render sites' own filter literals)
      let uSensorTotal = 0,
        uSeqTotal = 0;
      const sensorsByBuilding = {},
        seqByBuilding = {};
      const seqCatSet = {};
      // Keyed by the CLIENT-VISIBLE building name (rptBuildingDisplayName), not the raw
      // Equipment Matrix name catRows carry in r.building -- the per-building detail page
      // renders "Total for <displayName>" (report-engine.js _a36BuildingContent, via
      // _a36DisplayName/rptBuildingDisplayName; the row JOIN inside that same function
      // deliberately stays on raw r.building===b.name, only the printed label changed). The
      // scrape below (buildingTotals) reads that rendered display name out of the DOM, so this
      // map must be keyed the same way or every renamed building misses here with `|| 0` and
      // falsely fails the per-building-rows-not-raw-accumulator check.
      catRows.forEach((r) => {
        if (r.phase === 1 && !r.ioOnly) {
          uSensorTotal += r.qty || 0;
          const dn = rptBuildingDisplayName(r.building);
          sensorsByBuilding[dn] = (sensorsByBuilding[dn] || 0) + (r.qty || 0);
        } else if (r.phase === 2 && r.seqKey) {
          uSeqTotal += r.qty || 0;
          const dn = rptBuildingDisplayName(r.building);
          seqByBuilding[dn] = (seqByBuilding[dn] || 0) + (r.qty || 0);
          seqCatSet[r.seqKey] = true;
        }
      });

      // Recommended tier's own seqKey universe -- the declared, ranked/budgeted subset of U that
      // the timeline (_pricingComputeRecommendedTimeline) is actually built from. See the
      // registry's timeline-future-work-category-coverage comment for why this must be the
      // universe for that check, not the full catalog.
      const recRows = typeof buildRecommendedRows === 'function' ? buildRecommendedRows(projId) || [] : [];
      const recSeqCatSet = {};
      recRows.forEach((r) => {
        if (r.phase === 2 && r.seqKey) recSeqCatSet[r.seqKey] = true;
      });
      out.recommendedSeqKeys = Object.keys(recSeqCatSet);

      out.uSensorTotal = uSensorTotal;
      out.uSeqTotal = uSeqTotal;
      out.sensorsByBuilding = sensorsByBuilding;
      out.seqByBuilding = seqByBuilding;
      out.seqCategoriesInU = Object.keys(seqCatSet);
      out.rawSensors = data.portfolio.totalMissingHardwarePoints;
      out.rawSeq = data.portfolio.totalNotReadySequences;
      out.totalBuildings = data.portfolio.totalBuildings;
      out.totalEquip = data.portfolio.totalEquip;
      out.composite = data.portfolio.composite;
      out.pointPct = data.portfolio.pointPct;
      out.seqPct = data.portfolio.seqPct;

      // bucket-A (independent point-normalization tally, matches b1-oracle-measure.js method)
      let bucketA = 0;
      if (typeof emLoadMatrix === 'function' && typeof emNormalizePointInner === 'function') {
        const matData = emLoadMatrix(projId);
        (matData.rows || []).forEach((row) => {
          const pr = row.pointsRaw || {};
          Object.keys(pr).forEach((rn) => {
            let m = null;
            try {
              m = emNormalizePointInner(rn, row.category);
            } catch (e) {}
            if (
              m &&
              m.auditRelevant === true &&
              m.categoryKey &&
              (m.matchTier === 1 || m.matchTier === 2 || m.matchTier === 3)
            )
              bucketA++;
          });
        });
      }
      out.bucketA = bucketA;

      // Timeline term/future split -- the SAME single derivation A-1 introduced
      const termFuture =
        typeof _pricingProposalTermAndFuture === 'function' ? _pricingProposalTermAndFuture(projId) : null;
      const termPhases = (termFuture && termFuture.termPhases) || [];
      const futurePhases = (termFuture && termFuture.futurePhases) || [];
      out.termPhaseCount = termPhases.length;
      out.futurePhaseCount = futurePhases.length;
      out.tlPhaseCount = termFuture && termFuture.tl ? termFuture.tl.phases.length : null;

      let termCatNames = [];
      termPhases.forEach((p) => {
        termCatNames = termCatNames.concat(_rptA36PhaseSeqCategoryNames(p.rows || []));
      });
      const futureAllRows = futurePhases.reduce((acc, p) => acc.concat(p.rows || []), []);
      const futureCatNames = _rptA36PhaseSeqCategoryNames(futureAllRows);
      out.termCatNames = Array.from(new Set(termCatNames));
      out.futureCatNames = Array.from(new Set(futureCatNames));

      // key-level union (avoids any label-collision ambiguity in the (b) coverage check)
      const namedKeys = {};
      termPhases.forEach((p) =>
        (p.rows || []).forEach((r) => {
          if (r.phase === 2 && r.seqKey) namedKeys[r.seqKey] = true;
        }),
      );
      futureAllRows.forEach((r) => {
        if (r.phase === 2 && r.seqKey) namedKeys[r.seqKey] = true;
      });
      out.namedSeqKeysInRender = Object.keys(namedKeys);

      // ── Generate the REAL Audit report HTML (all sections ON) and inject into a real DOM node
      const auditSections = {};
      (ASHRAE36_SECTIONS.audit || []).forEach((s) => {
        auditSections[s.key] = true;
      });
      const auditHTML = generateASHRAE36AuditHTML(data, auditSections);
      const auditContainer = document.createElement('div');
      auditContainer.style.cssText = 'position:absolute;left:-99999px;top:0';
      auditContainer.innerHTML = auditHTML;
      document.body.appendChild(auditContainer);

      const coverEl = auditContainer.querySelector('[data-section="cover"]');
      const coverStats = {};
      if (coverEl) {
        coverEl.querySelectorAll('.rpt-a36-stat-card').forEach((card) => {
          const kids = card.children;
          if (kids.length >= 2) {
            const value = (kids[0].textContent || '').trim();
            const labelText = (kids[1].textContent || '').trim();
            const n = parseInt(value.replace(/,/g, ''), 10);
            coverStats[labelText] = isNaN(n) ? value : n;
          }
        });
      }
      out.coverStats = coverStats;

      const buildingTotals = [];
      auditContainer.querySelectorAll('[data-section="building"]').forEach((pg) => {
        const txt = pg.textContent || '';
        const re = /Total for ([^:]+):\s*install\s*([\d,]+)\s*sensors?,\s*program\s*([\d,]+)\s*sequences?/g;
        let m;
        while ((m = re.exec(txt))) {
          buildingTotals.push({
            building: m[1].trim(),
            sensors: parseInt(m[2].replace(/,/g, ''), 10),
            sequences: parseInt(m[3].replace(/,/g, ''), 10),
          });
        }
      });
      out.buildingTotals = buildingTotals;
      document.body.removeChild(auditContainer);

      // ── Generate the REAL Proposal HTML (all sections ON, incl. opt-in Cost Estimate) ──
      const proposalSections = {};
      (ASHRAE36_SECTIONS.proposal || []).forEach((s) => {
        proposalSections[s.key] = true;
      });
      const proposalHTML = generateASHRAE36ProposalHTML(data, proposalSections);
      const propContainer = document.createElement('div');
      propContainer.style.cssText = 'position:absolute;left:-99999px;top:0';
      propContainer.innerHTML = proposalHTML;
      document.body.appendChild(propContainer);
      const proposalText = propContainer.textContent || '';

      // Future Work ABSENCE scan (2026-08-03, path deleted at Matt's direction): scoped to the
      // schedule + vision sections only -- the opt-in Cost Estimate page's internal timeline
      // legitimately keeps a "Future Work" row and must not trip this scan.
      const fwScopeText = Array.from(
        propContainer.querySelectorAll('[data-section="proposalPhaseTable"],[data-section="proposalVision"]'),
      )
        .map((el) => el.textContent || '')
        .join(' ');
      out.proposalHasFutureWorkHeading = /Future Work/.test(fwScopeText);
      out.proposalHasFutureWorkCategoryLine = /Sequence categories addressed in future work:/.test(proposalText);

      // Priced-tier table (Compliance / Full Scope columns): Hardware & Installation /
      // Programming / Estimated Cost. Extract from the actual rendered <table>, column-matched by
      // header label (never by positional index) so a future column reorder can't silently
      // desync this extraction from the invariant it's checking.
      const tierRendered = {};
      const pricingTable = Array.from(propContainer.querySelectorAll('table')).find((t) => {
        const heads = Array.from(t.querySelectorAll('th')).map((th) => (th.textContent || '').trim());
        return heads.includes('Compliance') && heads.includes('Full Scope');
      });
      if (pricingTable) {
        const headCells = Array.from(pricingTable.querySelectorAll('tr')[0].querySelectorAll('th'));
        const colIndex = {};
        headCells.forEach((th, i) => {
          const t = (th.textContent || '').trim();
          if (t === 'Compliance') colIndex.compliance = i;
          if (t === 'Full Scope') colIndex['full-scope'] = i;
        });
        const rows = Array.from(pricingTable.querySelectorAll('tr'));
        function moneyFromText(txt) {
          const m = (txt || '').match(/\$([\d,]+)/);
          return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
        }
        Object.keys(colIndex).forEach((tierKey) => {
          const idx = colIndex[tierKey];
          let total = null,
            hardware = null,
            programming = null;
          rows.forEach((tr) => {
            const cells = tr.querySelectorAll('td');
            if (!cells.length || !cells[idx]) return;
            const cellText = cells[idx].textContent || '';
            if (/Hardware\s*&\s*Installation/.test(cellText)) {
              const m = cellText.match(/Hardware\s*&\s*Installation:\s*\$([\d,]+)/);
              if (m) hardware = parseInt(m[1].replace(/,/g, ''), 10);
              const m2 = cellText.match(/Programming:\s*\$([\d,]+)/);
              if (m2) programming = parseInt(m2[1].replace(/,/g, ''), 10);
            } else if (total === null) {
              const mv = moneyFromText(cellText);
              if (mv !== null) total = mv;
            }
          });
          if (total !== null || hardware !== null) tierRendered[tierKey] = { total, hardware, programming };
        });
      }
      out.tierRendered = tierRendered;

      document.body.removeChild(propContainer);
    } catch (e) {
      out.errors.push(String((e && e.stack) || e));
    }
    return out;
  }, projId);
}

// ── Run the checks + print a readable table ─────────────────────────────────────────────────
function runRegistry(bundle) {
  return REGISTRY.map((entry) => {
    let result;
    try {
      result = entry.run(bundle);
    } catch (e) {
      result = { pass: false, expected: 'no exception', actual: 'threw: ' + (e && e.message) };
    }
    return Object.assign({ id: entry.id, doc: entry.doc, checkType: entry.checkType, site: entry.site }, result);
  });
}

function printReport(label, results, bundle) {
  console.log('\n' + '='.repeat(100));
  console.log('RECONCILIATION GATE -- ' + label);
  console.log('='.repeat(100));
  console.log(
    'U (buildCatalogRows) sensors=' +
      bundle.uSensorTotal +
      ' sequences=' +
      bundle.uSeqTotal +
      ' | buildings=' +
      bundle.totalBuildings +
      ' equip=' +
      bundle.totalEquip +
      ' bucketA=' +
      bundle.bucketA +
      ' | timeline phases=' +
      bundle.tlPhaseCount +
      ' (term=' +
      bundle.termPhaseCount +
      ' future=' +
      bundle.futurePhaseCount +
      ')',
  );
  console.log('-'.repeat(100));
  let anyFail = false;
  results.forEach((r) => {
    const status = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) anyFail = true;
    console.log('[' + status + '] (' + r.checkType + ') ' + r.id + '  --  ' + r.doc);
    console.log('        site: ' + r.site);
    console.log('        expected: ' + JSON.stringify(r.expected));
    if (!r.pass) console.log('        actual:   ' + JSON.stringify(r.actual));
  });
  console.log('-'.repeat(100));

  // Oracle sanity comparison (informational for gauges -- not gated as (a)/(b)/(c), see header)
  const oracleRows = [
    ['sensors', bundle.uSensorTotal, ORACLE.oracles.sensors],
    ['sequences', bundle.uSeqTotal, ORACLE.oracles.sequences],
    ['buildings', bundle.totalBuildings, ORACLE.oracles.buildings],
    ['equipment', bundle.totalEquip, ORACLE.oracles.equipment],
    ['bucketA', bundle.bucketA, ORACLE.oracles.bucketA],
    ['timelinePhases', bundle.tlPhaseCount, ORACLE.oracles.timelinePhases],
    ['composite%', bundle.composite, ORACLE.oracles.compositePct],
    ['sensorCoverage%', bundle.pointPct, ORACLE.oracles.sensorCoveragePct],
    ['sequenceReadiness%', bundle.seqPct, ORACLE.oracles.sequenceReadinessPct],
  ];
  console.log('Oracle sanity check (known-good values, informational):');
  oracleRows.forEach(([name, measured, expected]) => {
    const match =
      expected === undefined
        ? 'no oracle'
        : measured === expected
          ? 'MATCH'
          : 'DIFFERS (measured=' + measured + ' oracle=' + expected + ')';
    console.log('  ' + name + ': ' + match);
  });
  console.log('='.repeat(100) + '\n');
  return !anyFail;
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const profileDir = 'C:/Temp/verify-report-reconciliation-profile-' + Date.now();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1600, height: 1100 },
  });
  let exitCode = 1;
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    await page.goto(APP_URL);
    await page.waitForTimeout(800);
    try {
      await page.click('text=Got it', { timeout: 1500 });
    } catch (e) {
      /* no intro modal, fine */
    }

    // Harness trap fix: arm the navigation wait BEFORE triggering the restore (restoreData()
    // schedules a delayed location.reload()). Await it immediately after setFiles, THEN poll
    // for DB-ready -- never the other order.
    const navWait = page.waitForNavigation({ waitUntil: 'load' });
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => window.__siteUI.restoreData()),
    ]);
    await fc.setFiles(DATA_FILE);
    await navWait;

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => ({
        dbReady: typeof DB !== 'undefined' && DB.isReady(),
        pending: typeof DB !== 'undefined' && DB.hasPendingWrites(),
        projects: typeof DB !== 'undefined' ? DB.get('en_projects', []).length : -1,
      }));
      if (info.dbReady && !info.pending && info.projects > 0) {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error('DB did not settle after restore within timeout');

    const projId = await page.evaluate((hint) => {
      const projects = typeof DB !== 'undefined' ? DB.get('en_projects', []) : [];
      if (hint) {
        const byId = projects.find((p) => String(p.id) === String(hint));
        if (byId) return byId.id;
      }
      const joco = projects.find((p) => /joco|johnson\s*county/i.test(p.name || p.client || ''));
      return joco ? joco.id : projects.length ? projects[0].id : null;
    }, PROJ_HINT);
    if (!projId) throw new Error('No project resolved after seeding');

    const bundle = await gatherPageData(page, projId);
    if (bundle.errors && bundle.errors.length) {
      console.error('HARNESS ERROR(S) inside page.evaluate:');
      bundle.errors.forEach((e) => console.error(e));
      exitCode = 1;
    } else {
      const results = runRegistry(bundle);
      const clean = printReport(LABEL, results, bundle);
      exitCode = clean ? 0 : 1;
    }
  } catch (e) {
    console.error('SCRIPT ERROR:', (e && e.stack) || e);
    exitCode = 1;
  } finally {
    await context.close();
  }
  process.exit(exitCode);
})();
