// tools/test-proposal-footing.js - WP-21 acceptance test (math-05 H1, M2, M5, M8; decision D-12).
// 1. Itemized proposal lines: "qty x unit = total" is true for every line at labor rates $170 and $173.
// 2. A section's printed lines + its visible Rounding line add up to the printed subtotal.
// 3. Tier total rounds UP to the next $100; Hardware + Programming parts foot to it (largest remainder);
//    the detail panel prints the same parts as the one function page 7 calls.
// 4. Monthly allowance: annual 75000 -> "$6,250" (one normalizer); lump -> nothing.
// 5. Contract Projection: every column adds up to its Total row.
// SYNTHETIC data only. Loads the REAL repo functions into a vm sandbox.
// Run: node tools/test-proposal-footing.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function loadFn(rel, fnName) {
  const src = rd(rel);
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}

const REP = 'app/report-engine.js';
const sb = { console };
sb.window = sb;
vm.createContext(sb);
const pre = [
  'function _esc(s){ return String(s == null ? "" : s); }',
  'function _rptV2Esc(s){ return String(s == null ? "" : s); }',
  'function rptPage(n, title, body){ return { html: body }; }',
  'function _rptPresentedLineHTML(){ return ""; }',
  'function _rptYtdKicker(){ return ""; }',
  'function _rptContentBudget(){ return 100000; }',
  'function _rptPaginateTokens(t){ return [t]; }',
  'function _rptTextLineH(){ return 16; }',
  'function getPresentedPrintedValue(){ return undefined; }',
  'var __budget = null;',
  'function _pricingGetBudget(){ return __budget; }',
].join('\n');
const reFns = [
  '_rptRoundUp100',
  '_rptFootTier',
  '_rptItemizedLine',
  '_rptItemizedLineText',
  '_rptRoundingDelta',
  '_rptMonthlyAllowance',
  '_rptMonthlyAllowanceFmt',
  '_rptA36TierDetailAggByPhase',
  '_rptA36HardwareCategoryAgg',
  '_rptA36TierDetailPanelHTML',
  'rptPageContractProjection',
];
vm.runInContext(
  [pre, rd('lib/formatting.js'), rd('computations/csc.js'), rd('app/report-printed.js')]
    .concat([loadFn('app/pricing-estimator.js', '_pricingMonthlyAllowanceAmount')])
    .concat(reFns.map((f) => loadFn(REP, f)))
    .join('\n\n'),
  sb,
);
const ev = (e) => vm.runInContext(e, sb);
const fmtUSD = ev('_fmtUSD');

// ---- 1 + 2. itemized lines at $170 and $173 ------------------------------------------------------------
// Programming sequences: hours per unit (synthetic, includes 0.25 steps) x rate x qty, like the pricing rows.
const HOURS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const usd = (s) => Number(String(s).replace(/[$,]/g, ''));
for (const RATE of [170, 173]) {
  let lines = 0,
    wrong = 0,
    sections = 0,
    unfooted = 0;
  for (const h of HOURS) {
    for (let qty = 2; qty <= 60; qty++) {
      const rows = [{ id: 'r1', item: 'Seq A', phase: 2, qty: qty, lineTotal: qty * h * RATE }];
      // a second item so the section has more than one line
      rows.push({ id: 'r2', item: 'Seq B', phase: 2, qty: 3, lineTotal: 3 * 0.75 * RATE });
      const grand = rows[0].lineTotal + rows[1].lineTotal;
      const tt = { recommended: null, compliance: { grand: grand, phase1: 0, phase2: grand } };
      sb.__tt = tt;
      sb.__sd = { perTier: { compliance: rows } };
      const html = ev("_rptA36TierDetailPanelHTML('compliance', __tt, __sd, {rowToggles:{}}, true, _fmtUSD)");
      const progSection = html.slice(html.indexOf('Programming'));
      const re = /<li>(.*?)<\/li>/g;
      let m,
        printedSum = 0,
        roundingDelta = 0;
      while ((m = re.exec(progSection))) {
        const t = m[1];
        const mul = /: (\d+) × (\$[\d,]+) = (\$[\d,]+)/.exec(t);
        const one = /: (-?\$[\d,]+)$/.exec(t);
        if (mul) {
          lines++;
          if (Number(mul[1]) * usd(mul[2]) !== usd(mul[3])) wrong++;
          printedSum += usd(mul[3]);
        } else if (/^Rounding: /.test(t)) {
          roundingDelta = usd(t.replace('Rounding: ', '').replace('-$', '-').replace('$', ''));
        } else if (one) {
          lines++;
          printedSum += usd(one[1]);
        }
      }
      const sub = /Programming<\/div>|Programming.*?<span style="font-weight:700">(\$[\d,]+)<\/span>/.exec(html);
      const subtotal = sub && sub[1] ? usd(sub[1]) : NaN;
      sections++;
      if (printedSum + roundingDelta !== subtotal) unfooted++;
    }
  }
  assert(
    lines > 0 && wrong === 0,
    'rate $' + RATE + ': ' + wrong + ' wrong qty x unit lines of ' + lines + ' (want 0)',
  );
  assert(
    unfooted === 0,
    'rate $' + RATE + ': ' + unfooted + ' of ' + sections + ' sections do not add up to their subtotal',
  );
}

// ---- 3. tier total rounds up to $100; parts foot; panel prints the same parts ---------------------------------
const full = ev('_rptFootTier(1422158.1999999993, 1084721.7, 337436.5)');
assert(full.totalR === 1422200, 'Full Scope total rounds UP to next $100 (got ' + full.totalR + ')');
assert(full.p1r + full.p2r === full.totalR, 'Hardware + Programming parts add up to the total');
assert(full.p1r % 100 === 0 && full.p2r % 100 === 0, 'parts are whole $100 amounts');
assert(ev('_rptRoundUp100(1000)') === 1000 && ev('_rptRoundUp100(1000.004)') === 1000, 'exact $100 multiple stays');
assert(ev('_rptRoundUp100(1000.5)') === 1100, '$1,000.50 rounds up to $1,100');
assert(ev('_rptRoundUp100(null)') === null, 'no total stays empty');
for (let g = 100.5; g < 250000; g += 7919.37) {
  const p1 = g * 0.6183,
    p2 = g - p1;
  const f = ev('_rptFootTier(' + g + ',' + p1 + ',' + p2 + ')');
  if (f.p1r + f.p2r !== f.totalR || f.totalR < g || f.totalR - g >= 100) {
    assert(false, 'foot failed at grand ' + g + ': ' + JSON.stringify(f));
    break;
  }
}
assert(true, 'sweep of totals foots');
sb.__tt = { 'full-scope': { grand: 1422158.1999999993, phase1: 1084721.7, phase2: 337436.5 } };
sb.__sd = { perTier: { 'full-scope': [] } };
const panel = ev("_rptA36TierDetailPanelHTML('full-scope', __tt, __sd, {rowToggles:{}}, false, _fmtUSD)");
assert(
  panel.includes(fmtUSD(full.p1r)) && panel.includes(fmtUSD(full.p2r)),
  'detail panel prints the same Hardware/Programming parts as _rptFootTier (page 7)',
);
// page 7 and the detail pages must call the one function
const src = rd(REP);
assert(/function _tierPartsRounded[\s\S]{0,400}_rptFootTier\(/.test(src), 'page 7 helper calls _rptFootTier');
assert((src.match(/_rptFootTier\(/g) || []).length >= 4, 'page 7, panel and detail pages all call _rptFootTier');

// ---- 4. monthly allowance -----------------------------------------------------------------------------------
const alw = (b) => {
  sb.__budget = b;
  return ev('_rptMonthlyAllowanceFmt(1)');
};
assert(alw({ amount: 75000, denomination: 'annual' }) === '$6,250', 'annual 75000 -> "$6,250" per Month');
assert(alw({ amount: 6250, denomination: 'monthly' }) === '$6,250', 'monthly 6250 -> "$6,250"');
assert(alw({ amount: 18750, denomination: 'quarterly' }) === '$6,250', 'quarterly 18750 -> "$6,250"');
assert(alw({ amount: 75000, denomination: 'lump' }) === null, 'lump has no per Month figure');
assert(alw(null) === null, 'no budget -> nothing');
assert(
  !/Math\.round\(Number\(_(b|pB|svcBudget)\.amount\)\)/.test(src),
  'no raw budget.amount "per Month" copy remains',
);
assert(!/_svcBudget/.test(src), 'no raw _svcBudget copy remains');

// ---- 5. contract projection foots ---------------------------------------------------------------------------
function projection(quarterly) {
  sb.__d = {
    project: { id: 1 },
    contract: {
      years: 3,
      currentYear: 1,
      annualTarget: 100000,
      cscPct: 60,
      clientPct: 40,
      hasCsc: true,
      escalation: 3,
      quarterlyTargets: [25000, 25000, 25000, 25000],
      quarterlyActuals: [15000, 15000, null, null],
    },
    period: quarterly ? { type: 'quarterly', quarter: 2, year: 2026 } : { type: 'annual', quarter: 1, year: 2026 },
    totals: { savings: 15000, cumulativeSavings: 30000 },
    buildings: [],
  };
  return ev('rptPageContractProjection(35, __d)').html;
}
for (const quarterly of [true, false]) {
  const label = quarterly ? 'quarterly' : 'annual';
  const html = projection(quarterly);
  const tbl = /<table class="rpt-table">[\s\S]*?<\/table>/.exec(html.slice(html.indexOf('-Year Projection</h2>')))[0];
  const trs = tbl.match(/<tr[\s\S]*?<\/tr>/g).filter((t) => /<td/.test(t));
  const numsOf = (t) =>
    (t.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])
      .map((c) =>
        c
          .replace(/<div[\s\S]*?<\/div>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim(),
      )
      .filter((c) => c.charAt(0) === '$')
      .map(usd);
  const totRaw = trs.find((t) => /rpt-tot/.test(t));
  const rowNums = trs.filter((t) => !/rpt-tot/.test(t)).map(numsOf);
  const totNums = totRaw ? numsOf(totRaw) : [];
  assert(rowNums.length === 3 && totNums.length === 3, label + ': 3 year rows and a Total row found');
  for (let c = 0; c < 3; c++) {
    const sum = rowNums.reduce((s, r) => s + r[c], 0);
    assert(sum === totNums[c], label + ' column ' + c + ': rows sum ' + sum + ' vs Total ' + totNums[c]);
  }
}

// Presented report (d.printed set, WP-04a lock) that printed no Total keeps the original projection total.
{
  projection(true); // builds sb.__d
  sb.__d.printed = {};
  const html = ev('rptPageContractProjection(35, __d)').html;
  const tbl = /<table class="rpt-table">[\s\S]*?<\/table>/.exec(html.slice(html.indexOf('-Year Projection</h2>')))[0];
  const tot = (tbl.match(/<tr class="rpt-tot">[\s\S]*?<\/tr>/) || [''])[0].match(/\$[\d,]+/g) || [];
  assert(
    tot.join(' ') === '$309,090 $185,454 $123,636',
    'presented: Total keeps the original projection total (got ' + tot.join(' ') + ')',
  );
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
