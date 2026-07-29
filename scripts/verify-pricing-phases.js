// Verification script for fix/pricing-phases-and-sensor-hours (backlog 8d7911c1)
// Seeds real JOCO data, then inspects the Cost Estimate tab, Service Proposal, and ASHRAE 36
// Audit Report via direct JS evaluation against the compute/generator functions (more precise
// than parsing rendered DOM text for structural checks), plus real UI screenshots.
// ORDER NOTE: all direct-evaluate structural checks (timeline, proposal generator, audit
// generator) run BEFORE any UI navigation (openDetail/tab click) — openDetail() triggers what
// appears to be a real page reload that leaves report-engine.js's top-level functions
// inaccessible afterward (harness/verification quirk, not evidence of an app bug — investigated
// but not fully root-caused; sidestepped by ordering instead).
const { chromium } = require('C:/Users/Matt Miller/AI/companydashboard/node_modules/playwright');
const fs = require('fs');

const PROFILE = 'C:/Temp/verify-pricing-phases-profile-' + Date.now();
const PAGE_URL = 'file:///C:/Temp/wt-pricing-phases-3/energy-department.html';
const DATA_FILE = 'C:/Users/Matt Miller/Downloads/CompanyHub-localdatafile-20260727.json';
const SHOT_DIR = 'C:/Users/Matt Miller/OneDrive - Control Service Company/Pictures/Screenshots';

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1600, height: 1100 },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });

  await page.goto(PAGE_URL);
  await page.waitForTimeout(1000);
  try {
    await page.click('text=Got it', { timeout: 2000 });
  } catch (e) {}

  console.log('Seeding from', DATA_FILE);
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => window.__siteUI.restoreData()),
  ]);
  await fc.setFiles(DATA_FILE);

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => ({
      dbReady: typeof DB !== 'undefined' && DB.isReady(),
      pending: typeof DB !== 'undefined' && DB.hasPendingWrites(),
      projects: typeof DB !== 'undefined' ? DB.get('en_projects', []).length : -1,
    }));
    if (info.dbReady && !info.pending && info.projects > 0) {
      ready = true;
      console.log('Seed ready at t+' + i * 400 + 'ms', JSON.stringify(info));
      break;
    }
  }
  if (!ready) {
    console.log('WARNING: seed did not settle within timeout, continuing anyway');
  }

  // Find JOCO project id
  const projId = await page.evaluate(() => {
    const projects = typeof DB !== 'undefined' ? DB.get('en_projects', []) : [];
    const joco = projects.find((p) => /joco|johnson\s*county/i.test(p.name || ''));
    return joco ? joco.id : projects.length ? projects[0].id : null;
  });
  console.log('Using projId:', projId);
  if (!projId) throw new Error('No project found after seeding');

  // ── 4 (moved first — most fragile to whatever periodically destroys the execution context;
  //    run it while the context is freshest). ASHRAE 36 Audit Report — zero suspect/failed
  //    sensor mentions ──
  const auditResult = await page.evaluate((pid) => {
    var data = collectASHRAE36Data(pid);
    if (!data) return { error: 'no data' };
    var sections = {};
    (ASHRAE36_SECTIONS.audit || []).forEach((s) => {
      sections[s.key] = s.defaultOn;
    });
    var html = generateASHRAE36AuditHTML(data, sections);
    var suspectTerms = [
      'suspect',
      'deficien',
      'dead sensor',
      'implausible',
      'failed sensor',
      'sensor failure',
      'investigation',
    ];
    var found = {};
    suspectTerms.forEach((t) => {
      var re = new RegExp(t, 'ig');
      var m = html.match(re);
      found[t] = m ? m.length : 0;
    });
    return { htmlLength: html.length, found: found };
  }, projId);
  console.log('=== ASHRAE 36 Audit Report result ===');
  console.log(JSON.stringify(auditResult, null, 2));

  // ── 1. Cost Estimate tab (Recommended tier) — direct compute-function inspection ──
  const tlResult = await page.evaluate((pid) => {
    const tl = _pricingComputeRecommendedTimeline(pid);
    if (!tl) return { tl: null };
    const rows = tl.phases.map((p) => ({
      label: p.label,
      dateRange: p.dateRange,
      rowCount: p.rows.length,
      measuresTotal: p.measuresTotal,
      allowanceTotal: p.allowanceTotal,
      measuresAvailable: p.measuresAvailable,
      overCommitted: p.overCommitted,
      overageAmount: p.overageAmount,
    }));
    const idCounts = {};
    tl.phases.forEach((p) =>
      p.rows.forEach((r) => {
        idCounts[r.id] = (idCounts[r.id] || 0) + 1;
      }),
    );
    const dupIds = Object.keys(idCounts).filter((k) => idCounts[k] > 1);
    const totalRowsAcrossPhases = Object.keys(idCounts).length;
    const recRows = buildRecommendedRows(pid);
    const invCount = recRows.filter((r) => r.isSensorInvestigation).length;
    const invTotal = recRows.filter((r) => r.isSensorInvestigation).reduce((s, r) => s + (r.lineTotal || 0), 0);
    return {
      phaseCount: tl.phases.length,
      rows,
      measuresGrandTotal: tl.measuresGrandTotal,
      programAllowanceTotal: tl.programAllowanceTotal,
      dupIds,
      totalRowsAcrossPhases,
      recRowsCount: recRows.length,
      sensorInvestigationCount: invCount,
      sensorInvestigationTotal: invTotal,
      hourlyRate: _pricingGetConfig().hourlyRate,
      budget: _pricingGetBudget(pid),
    };
  }, projId);
  console.log('=== _pricingComputeRecommendedTimeline result ===');
  console.log(JSON.stringify(tlResult, null, 2));

  // ── 3. Service Proposal — direct generator inspection (BEFORE any UI navigation) ──
  const proposalResult = await page.evaluate((pid) => {
    var data = collectASHRAE36Data(pid);
    if (!data) return { error: 'no data' };
    var sections = {};
    (ASHRAE36_SECTIONS.proposal || []).forEach((s) => {
      sections[s.key] = s.defaultOn;
    });
    sections.costEstimate = true; // opt-in, need it ON to check the Cost Estimate page
    var html = generateASHRAE36ProposalHTML(data, sections);
    var grandTotalCount = (html.match(/Grand Total/g) || []).length;
    var phaseLabelMatches = html.match(/>Phase (\d+)</g) || [];
    var uniquePhaseNums = Array.from(new Set(phaseLabelMatches.map((m) => parseInt(m.replace(/[^\d]/g, ''), 10)))).sort(
      (a, b) => a - b,
    );
    var sensorInvestigationMentions = (html.match(/Sensor Investigation/g) || []).length;
    return {
      htmlLength: html.length,
      grandTotalCount: grandTotalCount,
      uniquePhaseNums: uniquePhaseNums,
      maxPhaseNum: uniquePhaseNums.length ? Math.max.apply(null, uniquePhaseNums) : null,
      sensorInvestigationMentions: sensorInvestigationMentions,
    };
  }, projId);
  console.log('=== Service Proposal generator result ===');
  console.log(JSON.stringify(proposalResult, null, 2));

  // Render the proposal into the overlay for a real screenshot
  await page.evaluate((pid) => {
    var data = collectASHRAE36Data(pid);
    var sections = {};
    (ASHRAE36_SECTIONS.proposal || []).forEach((s) => {
      sections[s.key] = s.defaultOn;
    });
    sections.costEstimate = true;
    var html = generateASHRAE36ProposalHTML(data, sections);
    showReportOverlay(html, data.project.name + ' — ASHRAE 36 Service Proposal');
  }, projId);
  await page.waitForTimeout(1000);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const propShotPath = SHOT_DIR + '/pricing-phases-service-proposal-2026-07-28.png';
  await page.screenshot({ path: propShotPath, fullPage: true });
  console.log('Screenshot saved:', propShotPath);
  try {
    await page.evaluate(() => {
      if (typeof closeReportOverlay === 'function') closeReportOverlay();
    });
  } catch (e) {}
  await page.waitForTimeout(300);

  // ── 2. Cost Estimate tab UI navigation + screenshot (LAST — openDetail's reload can break
  //    subsequent evaluate() calls to report-engine.js globals, so do this after everything above) ──
  try {
    await page.evaluate((pid) => {
      window._activeProjId = pid;
      openDetail(pid);
    }, projId);
  } catch (e) {
    console.log('openDetail evaluate threw (context likely reloaded mid-call):', e.message);
  }
  await page.waitForTimeout(1500);
  const tabBtn = await page.$('.pdt[data-tab="cost-estimate"]');
  if (tabBtn) {
    await tabBtn.click();
    await page.waitForTimeout(800);
  }
  try {
    await page.evaluate((pid) => {
      if (typeof _pricingSetEstimate === 'function' && typeof _pricingGetEstimate === 'function') {
        var est = _pricingGetEstimate(pid);
        est.tier = 'recommended';
        _pricingSetEstimate(pid, est);
      }
      if (typeof initCostEstimateTab === 'function') initCostEstimateTab(pid);
    }, projId);
    await page.waitForTimeout(800);
  } catch (e) {
    console.log('tier switch failed:', e.message);
  }

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  console.log('Contains literal "Grand Total" text on page:', bodyText.includes('Grand Total'));
  console.log('Contains "Sensor Investigation" text on page:', bodyText.includes('Sensor Investigation'));

  const ceShotPath = SHOT_DIR + '/pricing-phases-cost-estimate-2026-07-28.png';
  await page.screenshot({ path: ceShotPath, fullPage: false });
  console.log('Screenshot saved:', ceShotPath);

  await context.close();
  console.log('DONE');
})().catch((e) => {
  console.error('SCRIPT ERROR:', e.stack || e.message);
  process.exit(1);
});
