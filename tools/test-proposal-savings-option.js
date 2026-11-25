// tools/test-proposal-savings-option.js - the Service Proposal option "Estimated Savings and Payback" (box costEstimateSavings, item 38a8f08f, Matt 2026-11-25).
// SYNTHETIC values only; headless bundled Chromium; no network. The price data of the proposal (_rptA36ProposalSummaryData, cached on d) is set by
// hand: option estimates, an optional room CO2 scope with an estimate, and a not-now list (items over the payback limit).
// Rules tested:
//   1. The box exists in the proposal sections, default on, indented under the Cost Estimate box.
//   2. ON (box true or missing): the proposal text has the estimated savings, the payback, the basis sentence and the "estimated payback over 10 years" reason.
//   3. OFF: the whole proposal (generateASHRAE36ProposalHTML) has no "savings", "payback", "per year" or range text, and no "return each improvement".
//   4. OFF: every price and total is identical to ON (the dollar figures of ON minus the savings figures = the dollar figures of OFF).
//   5. OFF: the not-now list stays ("Included in Full Scope only: ...") and the Recommended membership (the not-now list itself) is unchanged.
//   7. Itemized Measures tables (costEstimateItemized): ON adds the columns "Estimated Savings per Year" and "Payback (Years)" for Recommended and Full Scope (not
//      Compliance), each line from _pricingLineSavingsText (blank where the line has no estimate) and an option total row = the option estimate
//      (_pricingOptionTotalCells); OFF has none of it and the same prices.
//   6. The Cost Estimate tab text (_pricingRecommendedNoneText() with no argument, _pricingOptionEstimateText) is unchanged: it still shows the payback.
// Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-savings-option.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('proposal-savings-option');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptA36RecommendedScope === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const PID = 900971;
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      const mk = (id, b, cat, name, p) => ({ id, building: b, category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      const rows = [mk('a1', 'Alpha Library', 'ahu', 'AHU-A', { 'Supply Air Temp': '55.2 F' }), mk('b1', 'Beta Library', 'ahu', 'AHU-B', { 'Supply Air Temp': '55.2 F' })];
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const tot = (g, p1, p2) => ({ grand: g, phase1: p1, phase2: p2, method: 'rows' });
      const est = (likely, low, high, years) => ({ display: { likely: likely, low: low, high: high, years: years }, year: 2025, weatherCity: 'Sample City' });
      const notNow = [{ building: 'Alpha Library', key: 'lightingOccupancy', label: 'Interior lighting occupancy', years: 23 }];
      const sd = {
        buildings: [],
        optional: {},
        perTier: { recommended: [], compliance: [], 'full-scope': [] },
        roomCo2: null,
        opps: [],
        notNow: notNow,
        recommendedNone: false,
        tierTotals: { recommended: tot(12345, 7000, 5345), compliance: tot(23456, 14000, 9456), 'full-scope': tot(34567, 20000, 14567) },
        option: { recommended: est(4400, 2100, 7000, 6), compliance: est(0, 0, 0, 0), 'full-scope': est(8800, 4000, 12000, 9) },
        optionalCo2: {
          recommended: { qty: 5, seqQty: 5, price: 6789, libs: [{ name: 'Alpha Library', sensors: 5, seqs: 5, rooms: ['Meeting Room'] }], otherQty: 9, estimate: est(1500, 700, 2300, 7) },
        },
      };
      const mkD = (flag) => {
        const d = collectASHRAE36Data(PID, '2026-11-25', null);
        d._a36ProposalSummary = JSON.parse(JSON.stringify(sd));
        delete d._a36TierCostCache;
        delete d._a36Scope;
        return d;
      };
      const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
      const res = {};
      const sec = (ASHRAE36_SECTIONS.proposal || []).map((s) => s.key);
      const box = (ASHRAE36_SECTIONS.proposal || []).filter((s) => s.key === 'costEstimateSavings')[0];
      res.box = box ? { defaultOn: box.defaultOn, indent: box.indent, after: sec[sec.indexOf('costEstimateSavings') - 1] } : null;
      const render = (sections) => strip(generateASHRAE36ProposalHTML(mkD(), Object.assign({ costEstimate: true }, sections)));
      res.on = render({ costEstimateSavings: true });
      res.missing = render({});
      res.off = render({ costEstimateSavings: false });
      const o = sd.optionalCo2.recommended;
      res.co2On = _rptA36OptionalCo2Sentences(o, true);
      res.co2Off = _rptA36OptionalCo2Sentences(o, false);
      res.co2CompOff = _rptA36OptionalCo2Sentences({ qty: 3, seqQty: 0, estimate: est(0, 0, 0, 0), otherQty: 0 }, false);
      res.tabNone = _pricingRecommendedNoneText();
      res.tabNoneOff = _pricingRecommendedNoneText(false);
      res.tabEst = _pricingOptionEstimateText(sd.option.recommended, 'recommended');
      res.notNowOn = _rptA36NotNowSentence(Object.assign(mkD(), { _a36ShowSavings: true }));
      res.notNowOff = _rptA36NotNowSentence(Object.assign(mkD(), { _a36ShowSavings: false }));
      // Itemized Measures pages with the savings columns (rule 7): synthetic rows, opportunities and option items.
      const row = (id, key, qty, total) => ({ id: id, building: 'Alpha Library', phase: 2, seqKey: key, oppKey: key, item: key, qty: qty, lineTotal: total });
      const itemRows = [row('r1', 'k1', 2, 1000), row('r2', 'k2', 1, 500), row('r3', 'k3', 1, 250)];
      const opp = (key) => ({ key: key, bName: 'Alpha Library', lib: 'Alpha Library', label: 'Sequence ' + key, kind: 'seq' });
      const item = (id, price, likely, hasData) => ({ rowIds: [id], price: price, hasData: hasData, years: hasData ? price / likely : null, usd: { low: likely / 2, likely: likely, high: likely * 2 } });
      const optEst = {
        display: { likely: 4400, low: 2100, high: 7000, years: 6 },
        items: [item('r1', 1000, 300, true), item('r2', 500, 0, false)],
      };
      const sdI = JSON.parse(JSON.stringify(sd));
      sdI.opps = [opp('k1'), opp('k2'), opp('k3')];
      ['recommended', 'compliance', 'full-scope'].forEach((k) => { sdI.perTier[k] = JSON.parse(JSON.stringify(itemRows)); });
      sdI.option = { recommended: optEst, compliance: optEst, 'full-scope': optEst };
      const itemized = (on) => {
        const d = mkD();
        d._a36ProposalSummary = sdI;
        d._a36ShowSavings = on;
        return rptPageASHRAE36ProposalPricing(1, d, { itemized: true }).map(strip);
      };
      const itOn = itemized(true);
      const itOff = itemized(false);
      const pick = (pages, label) => pages.filter((p) => p.indexOf('Itemized Measures, ' + label) >= 0).join(' ');
      res.it = {
        recOn: pick(itOn, 'Recommended'), recOff: pick(itOff, 'Recommended'),
        compOn: pick(itOn, 'Compliance'), fullOn: pick(itOn, 'Full Scope'),
        line: _pricingLineSavingsText(optEst, itemRows),
        line2: _pricingLineSavingsText(optEst, [itemRows[1]]),
        line1: _pricingLineSavingsText(optEst, [itemRows[0]]),
        total: _pricingOptionTotalCells(optEst),
        totalNone: _pricingOptionTotalCells({ display: null }),
      };
      return res;
    });

    if (process.env.DUMP) require('fs').writeFileSync(process.env.DUMP, out.off + ' ===== ' + out.on);
    ok(out.box && out.box.defaultOn === true && out.box.indent === true && out.box.after === 'costEstimateItemized', 'box costEstimateSavings: default on, indented, after Itemized: ' + JSON.stringify(out.box));
    ok(out.on === out.missing, 'a missing box key renders the same as true (default on)');
    ok(/Estimated savings \$4,400 per year \(range \$2,100 to \$7,000\); estimated payback about 6 years\./.test(out.on), 'ON: option savings and payback sentence');
    ok(/Estimated savings \$1,500 per year \(range \$700 to \$2,300\); estimated payback about 7 years\./.test(out.on), 'ON: optional room CO2 savings sentence');
    ok(/No energy savings claimed/.test(out.on), 'ON: the Compliance sentence on the Cost Estimate page');
    ok(/Their estimated energy savings do not repay the cost\./.test(out.co2On.other) && out.co2On.basis.length > 0 && out.co2Off.basis === '', 'ON: the other-rooms sentence and the basis sentence: ' + out.co2On.other.slice(-60));
    ok(out.notNowOn.indexOf('Not recommended now (estimated payback over 10 years): ') === 0, 'ON: the not-now reason');
    ok(!/savings|payback|per year|range/i.test(out.off), 'OFF: no savings, payback, per year or range text in the proposal: ' + (out.off.match(/.{0,60}(savings|payback|per year|range).{0,60}/i) || [''])[0]);
    ok(!/savings|payback|per year/i.test(out.co2Off.savings + out.co2Off.basis + out.co2Off.other + out.notNowOff), 'OFF: no savings or payback words in the helper sentences');
    ok(out.co2Off.other.indexOf('Not recommended: CO2 sensors in the other 9 rooms') === 0, 'OFF: the other-rooms line stays without the reason: ' + out.co2Off.other.slice(-50));
    ok(out.co2CompOff.savings === 'The sensors prepare these rooms for occupancy-based ventilation.', 'OFF: the Compliance room sentence (no savings claim) stays');
    ok(out.notNowOff === 'Included in Full Scope only: ' + out.notNowOn.replace(/^Not recommended now \(estimated payback over 10 years\): /, '').replace(/\. Full Scope includes this work\.$/, '') + '.', 'OFF: not-now list = the ON list without the reason: ' + out.notNowOff);
    const money = (t) => (t.match(/\$[\d,]+/g) || []).slice().sort();
    const savingsFigs = ['$4,400', '$2,100', '$7,000', '$1,500', '$700', '$2,300', '$8,800', '$4,000', '$12,000'];
    const onMoney = money(out.on);
    const offMoney = money(out.off);
    const onPrices = onMoney.slice();
    savingsFigs.forEach((f) => {
      let i;
      while ((i = onPrices.indexOf(f)) >= 0) onPrices.splice(i, 1);
    });
    ok(JSON.stringify(onPrices) === JSON.stringify(offMoney) && offMoney.length > 0, 'prices identical: ON minus savings figures = OFF (' + offMoney.length + ' dollar figures)');
    ok(out.tabNone.indexOf('estimated payback of each item is over 10 years') >= 0 && out.tabNoneOff === 'No work is recommended now.' && /estimated payback about 6 years/.test(out.tabEst), 'Cost Estimate tab texts unchanged; the reason is dropped only on request');
    const money2 = (t) => (t.match(/\$[\d,]+/g) || []).slice().sort();
    ok(/Item Total Quantity Price Estimated Savings per Year Payback \(Years\)/.test(out.it.recOn), 'ITEMIZED ON: Recommended has the columns Estimated Savings per Year and Payback (Years)');
    ok(/Sequence K1 Programming: k1\. 2 \$1,000 \$300 3 /.test(out.it.recOn) && !/Sequence K2 Programming: k2\. 1 \$500 \$/.test(out.it.recOn), 'ITEMIZED ON: the line with an estimate shows $300 and 3 years; the line without one is blank: ' + out.it.recOn.slice(150, 330));
    ok(out.it.line1 && out.it.line1.savings === '$300' && out.it.line1.years === '3' && out.it.line2 === null, 'line estimate = its items (rounded to $100, payback = price / savings); a line without an estimate is null');
    ok(/Option total \(estimated; savings that overlap are counted once\) \$4,400 6/.test(out.it.recOn) && /\$4,400 6/.test(out.it.fullOn), 'ITEMIZED ON: the total row of Recommended and Full Scope = the option estimate $4,400 / 6 years (' + JSON.stringify(out.it.total) + ')');
    ok(!/Estimated Savings per Year|Payback \(Years\)|Option total/.test(out.it.compOn), 'ITEMIZED ON: Compliance has no savings columns and no total row');
    ok(!/Estimated Savings per Year|Payback \(Years\)|Option total|savings|payback/i.test(out.it.recOff), 'ITEMIZED OFF: no columns, no total row');
    ok(JSON.stringify(money2(out.it.recOn).filter((x) => ['$300', '$4,400'].indexOf(x) < 0)) === JSON.stringify(money2(out.it.recOff)), 'ITEMIZED: every price is identical ON and OFF');
    ok(out.it.totalNone === null, 'no option estimate: no total cells');
    ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
