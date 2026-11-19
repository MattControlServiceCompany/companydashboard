// tools/test-proposal-empty-recommended.js - Recommended with no work because every savings item is over the payback limit (Matt 2026-11-19).
// SYNTHETIC values only; headless bundled Chromium; no network. The price data of the proposal (_rptA36ProposalSummaryData, cached on d) is
// set by hand to two cases: (A) every Recommended item over the limit (Recommended has no rows, notNow lists the items); (B) no priced catalog.
// Rules tested:
//   1. The predicate _pricingRecommendedEmptyByPayback: true only when there are no base rows AND notNow is not empty.
//   2. Case A: page 1 row "Recommended | No work is recommended now: ... | None now" (no dollar figure); no "Recommended costs less" sentence.
//   3. Case A: the Cost Estimate page cell reads "None now" and the sentence; no "$null", "NaN" or "$0".
//   4. Case A: the Recommended scope reads "No work is recommended now." and the "Not recommended now" sentence; the Implementation Plan says
//      "There is no Recommended work to schedule now."; no Order of Work table.
//   5. Case B: predicate false; the old "will be listed here when the pricing for this project is complete" texts stay; no Recommended row.
// Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-empty-recommended.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('proposal-empty-rec');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptA36RecommendedScope === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const PID = 900970;
      projects.push({ id: PID, name: 'Synthetic Empty District', client: 'Synthetic Empty District', type: 'K-12', start: '2025-01-01' });
      const mk = (id, b, cat, name, p) => ({ id, building: b, category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      const rows = [mk('a1', 'Alpha Library', 'ahu', 'AHU-A', { 'Supply Air Temp': '55.2 F' }), mk('b1', 'Beta Library', 'ahu', 'AHU-B', { 'Supply Air Temp': '55.2 F' })];
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const tot = (g, p1, p2) => ({ grand: g, phase1: p1, phase2: p2, method: 'rows' });
      const none = { grand: null, phase1: null, phase2: null, method: 'rows' };
      const notNow = [
        { building: 'Alpha Library', key: 'lightingOccupancy', label: 'Interior lighting occupancy', years: 23 },
        { building: 'Beta Library', key: 'lightingPhotocell', label: 'Exterior photocell', years: 18 },
      ];
      const mkD = (sd) => {
        const d = collectASHRAE36Data(PID, '2026-11-19', null);
        d._a36ProposalSummary = sd;
        delete d._a36TierCostCache;
        delete d._a36Scope;
        return d;
      };
      const base = (rec, extra) =>
        Object.assign({ buildings: [], optional: {}, option: {}, perTier: { recommended: [], compliance: [], 'full-scope': [] }, roomCo2: null, optionalCo2: {}, opps: [] }, extra, {
          tierTotals: { recommended: rec, compliance: tot(10000, 6000, 4000), 'full-scope': tot(20000, 12000, 8000) },
        });
      const res = {};
      const dA = mkD(base(none, { notNow: notNow, recommendedNone: _pricingRecommendedEmptyByPayback([], notNow) }));
      const dB = mkD(base(none, { notNow: [], recommendedNone: _pricingRecommendedEmptyByPayback([], []) }));
      res.pred = [
        _pricingRecommendedEmptyByPayback([], notNow),
        _pricingRecommendedEmptyByPayback([{ id: 'x' }], notNow),
        _pricingRecommendedEmptyByPayback([], []),
        _pricingRecommendedEmptyByPayback(null, undefined),
      ];
      // The synthetic project has real rows in the pricing estimator; a Recommended with no rows has no timeline and no step plan (as the real case).
      window._pricingProposalTermAndFuture = () => ({ tl: null, termPhases: [], futurePhases: [] });
      window._rptA36RecommendedStepPlan = () => null;
      const HEAD = 'font-weight:700',
        BODY = '';
      const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      [['A', dA], ['B', dB]].forEach(function (p) {
        const d = p[1];
        const vis = _rptA36VisionInnerHTML(d, {});
        const pricing = rptPageASHRAE36ProposalPricing(1, d, {});
        res[p[0]] = {
          summary: strip(_rptA36CostSummaryHTML(d, HEAD, BODY)),
          head: strip(_rptA36RecommendedServicesInnerHTML(d)),
          tokens: _rptA36ScopeTokens(d).length,
          vision: strip(Array.isArray(vis) ? vis.join(' ') : vis),
          pricing: strip(Array.isArray(pricing) ? pricing.join(' ') : pricing),
          timeline: _rptA36RecommendedTimelineHTML(d),
        };
      });
      return res;
    });

    const NONE = 'No work is recommended now: the estimated payback of each item is over 10 years.';
    ok(JSON.stringify(out.pred) === '[true,false,false,false]', 'predicate: true only with no rows and a not-now list ' + JSON.stringify(out.pred));
    const A = out.A,
      B = out.B;
    ok(/Recommended\s+No work is recommended now: the estimated payback of each item is over 10 years\.\s+None now/.test(A.summary), 'A: page 1 Recommended row text and "None now": ' + A.summary.slice(0, 400));
    ok(!/Recommended costs less/.test(A.summary), 'A: no "Recommended costs less" sentence');
    ok(!/\$null|NaN|\$0\b/.test(A.summary + A.pricing), 'A: no $null, NaN or $0 on page 1 or the Cost Estimate page');
    ok(A.pricing.indexOf('None now') >= 0 && A.pricing.indexOf(NONE) >= 0, 'A: Cost Estimate cell "None now" and the sentence');
    ok(A.head.indexOf('No work is recommended now. Not recommended now (estimated payback over 10 years): ') >= 0 && /Interior lighting occupancy|lighting/i.test(A.head) && A.head.indexOf('Full Scope includes this work.') >= 0, 'A: scope head: ' + A.head.slice(0, 400));
    ok(A.head.indexOf('will be listed here') < 0 && A.tokens === 0, 'A: no "will be listed here" text in the scope, no library tokens');
    ok(A.vision.indexOf('There is no Recommended work to schedule now.') >= 0 && A.vision.indexOf('will be listed here') < 0, 'A: Implementation Plan sentence');
    ok(A.timeline === '' && A.vision.indexOf('Order of Work') < 0, 'A: no Order of Work table');
    ok(!/Recommended\s+None now|None now/.test(B.summary) && B.summary.indexOf('Compliance') >= 0 && !/>\s*Recommended\s*</.test(B.summary) && B.summary.indexOf('Recommended') < 0, 'B (no priced catalog): no Recommended row on page 1: ' + B.summary.slice(0, 200));
    ok(B.head.indexOf('The work will be listed here when the pricing for this project is complete.') >= 0 && B.head.indexOf('No work is recommended now') < 0, 'B: the old scope text stays');
    ok(B.vision.indexOf('The steps of the work will be listed here when the pricing for this project is complete.') >= 0 && B.vision.indexOf('There is no Recommended work') < 0, 'B: the old Implementation Plan text stays');
    ok(B.pricing.indexOf('None now') < 0, 'B: no "None now" on the Cost Estimate page');
    ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
