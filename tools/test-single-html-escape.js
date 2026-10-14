/**
 * test-single-html-escape.js  (single source of truth, 2026-10-07)
 *
 * Gate: HTML is escaped by ONE function, _escHtml (lib/formatting.js).
 * Fails when:
 *   1. _escHtml does not encode all five characters  & < > " '  (or does not turn null/undefined into '').
 *   2. A file in app/, computations/, extraction/, lib/ (other than lib/formatting.js) or a root/page .html
 *      or .js file holds its own copy of the escape (.replace(/&/g, '&amp;') or a '&': '&amp;' map).
 *      Allowed: the two XML escapers for Word files (_docxEscapeXml in docx-writer.js, _sooXmlEsc in
 *      soo-generator.js). They write XML, not HTML.
 *   3. Baseline pill template (utility-data.js _udBaselinePillsHtml) leaves a hostile unit or excluded-bill label
 *      escaped, and no pill template prints ${p.lbl} / ${p.v} raw.
 *   4. A page that loads app scripts does not load lib/formatting.js before app/sync-ui.js.
 *   5. app/ecm-calculators.js: user-data text in the two render functions goes through _escHtml, and a hostile
 *      building name, source label and typed value (<img onerror>, attribute break-out) are escaped by the real
 *      renderEcmCalculator and renderEcmResults.
 *
 * Usage: node tools/test-single-html-escape.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const KEEPER = path.join('lib', 'formatting.js');
const XML_ALLOWED = new Set([path.join('app', 'docx-writer.js'), path.join('app', 'soo-generator.js')]);
const COPY = /\/&\/g\s*,\s*'&amp;'|'&'\s*:\s*'&amp;'/;
const problems = [];

// 1. behavior
const fmt = fs.readFileSync(path.join(REPO, KEEPER), 'utf8');
const sb = {};
vm.createContext(sb);
vm.runInContext(fmt, sb);
if (typeof sb._escHtml !== 'function') {
  problems.push(KEEPER + ' does not define _escHtml');
} else {
  const got = sb._escHtml(`O'Brien & <b>x</b> "q"`);
  const want = 'O&#39;Brien &amp; &lt;b&gt;x&lt;/b&gt; &quot;q&quot;';
  if (got !== want) problems.push('_escHtml output wrong: ' + got);
  if (sb._escHtml(null) !== '' || sb._escHtml(undefined) !== '') problems.push('_escHtml(null/undefined) is not empty');
  if (sb._escHtml(0) !== '0') problems.push('_escHtml(0) is not "0"');
}

// 2. no private copies
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(full);
  }
  return out;
}
const files = ['app', 'computations', 'extraction', 'lib'].reduce((a, d) => walk(path.join(REPO, d), a), []);
for (const name of fs.readdirSync(REPO)) {
  if (/^(index|energy-department|ems-leads)\.html$|^(site-ui|feedback-widget)\.js$/.test(name)) files.push(path.join(REPO, name));
}
for (const file of files) {
  const rel = path.relative(REPO, file);
  if (rel === KEEPER || XML_ALLOWED.has(rel)) continue;
  const lines = fs.readFileSync(file, 'latin1').split('\n');
  lines.forEach((ln, i) => {
    if (COPY.test(ln)) problems.push(rel + ':' + (i + 1) + '  private HTML escape (use _escHtml from lib/formatting.js)');
  });
}

// 3. Baseline pills: bill/meter text (unit, excluded-bill start) never reaches the DOM as markup
{
  const noCr = (t) => t.split(String.fromCharCode(13)).join('');
  const ud = noCr(fs.readFileSync(path.join(REPO, 'app', 'utility-data.js'), 'utf8'));
  const rates = noCr(fs.readFileSync(path.join(REPO, 'computations', 'rates.js'), 'utf8'));
  const start = ud.indexOf('function _udBaselinePillsHtml');
  const end = ud.indexOf('\n}\n', start);
  if (start < 0) problems.push('app/utility-data.js: _udBaselinePillsHtml missing');
  else {
    const ctx = { _escHtml: sb._escHtml };
    vm.createContext(ctx);
    vm.runInContext(ud.slice(start, end + 3), ctx);
    const fs0 = rates.indexOf('function formatExcludedBillsLabel');
    vm.runInContext(rates.slice(fs0, rates.indexOf('\n}\n', fs0) + 3).replace(/_rateMonthLabel/g, 'String'), ctx);
    const evil = '<img src=x onerror=alert(1)>';
    const label = ctx.formatExcludedBillsLabel([{ ym: '', start: evil }]);
    const html = ctx._udBaselinePillsHtml([
      { lbl: evil, v: '$0.0912/' + evil },
      { lbl: 'Excluded', v: label, wrap: true },
    ]);
    if (/<img/i.test(html) || !html.includes('&lt;img src=x onerror=alert(1)&gt;')) problems.push('Baseline pill HTML prints bill or meter text unescaped: ' + html.slice(0, 160));
    if (!label.includes(evil)) problems.push('test setup: excluded label did not carry the hostile start');
  }
  ud.split('\n').forEach((ln, i) => {
    if (/\$\{p\.(?:lbl|v)\}/.test(ln)) problems.push('app/utility-data.js:' + (i + 1) + '  pill value printed without _escHtml');
  });
}

// 4. every page loads the shared module before sync-ui.js
for (const page of ['index.html', 'energy-department.html', 'ems-leads.html']) {
  const html = fs.readFileSync(path.join(REPO, page), 'utf8');
  const a = html.indexOf('lib/formatting.js');
  const b = html.indexOf('app/sync-ui.js');
  if (a < 0 || b < 0 || a > b) problems.push(page + ': lib/formatting.js must load before app/sync-ui.js');
}

// 5. ECM calculator pages (app/ecm-calculators.js): building, source and measure text never reaches the DOM as markup.
//    a) static: in the two render functions, every ${} that prints user-data text goes through _escHtml
//    b) hostile input through the REAL renderEcmCalculator and renderEcmResults
{
  const noCr = (t) => t.split(String.fromCharCode(13)).join('');
  const ecmSrc = noCr(fs.readFileSync(path.join(REPO, 'app', 'ecm-calculators.js'), 'utf8'));
  const autofill = noCr(fs.readFileSync(path.join(REPO, 'app', 'calc-autofill.js'), 'utf8'));
  const region = ecmSrc.slice(ecmSrc.indexOf('function renderEcmCalculator('), ecmSrc.indexOf('/* ─── Input Validation Helpers'));
  if (!region || region.length < 1000) problems.push('app/ecm-calculators.js: render functions not found');
  const USER_TEXT = /buildingName|backLabel|\bb\.name|\.reason|sourceLabel|\.label\b|\.help\b|\.unit\b|\.formula|\.assumption|\.description|\btmpl\.name|\btmpl\.category|\btmpl\.icon|\.desc\b/;
  let i = 0;
  while ((i = region.indexOf('${', i)) >= 0) {
    let depth = 1;
    let j = i + 2;
    while (j < region.length && depth > 0) {
      if (region[j] === '{') depth++;
      else if (region[j] === '}') depth--;
      j++;
    }
    const expr = region.slice(i + 2, j - 1);
    const line = ecmSrc.slice(0, ecmSrc.indexOf(region) + i).split('\n').length;
    if (USER_TEXT.test(expr) && !/_escHtml\(|chCalcFieldHintHTML\(/.test(expr))
      problems.push('app/ecm-calculators.js:' + line + '  ${' + expr.slice(0, 60) + '} prints user-data text without _escHtml');
    i = j;
  }

  const evil = '<img src=x onerror=alert(1)>';
  const attackAttr = '" onfocus="alert(1)';
  const stub = () => ({ addEventListener() {}, value: '' });
  const out = { html: '' };
  const container = {
    set innerHTML(v) { out.html += v; },
    get innerHTML() { return out.html; },
    querySelector: stub,
  };
  const ctxSb = {
    console,
    document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    requestAnimationFrame() {},
    projects: [{ id: 'p1' }],
    getUDBldgs: () => [{ id: evil, name: evil }, { id: 'b2', name: attackAttr }],
    getUDBldg: (pid, id) => ({ id, name: evil, sqft: 1000 }),
    ecmMeasureDollars: () => 0,
    calcMeasureDollars: () => ({ total: 0 }),
    measureRatesNow: () => ({}),
  };
  vm.createContext(ctxSb);
  vm.runInContext(noCr(fs.readFileSync(path.join(REPO, 'lib', 'formatting.js'), 'utf8')), ctxSb);
  vm.runInContext(noCr(fs.readFileSync(path.join(REPO, 'computations', 'physics.js'), 'utf8')), ctxSb);
  vm.runInContext(autofill, ctxSb);
  vm.runInContext(noCr(fs.readFileSync(path.join(REPO, 'computations', 'end-use.js'), 'utf8')), ctxSb);
  vm.runInContext(ecmSrc.replace(/\bconst\s+(ECM_TEMPLATES|ECM_MEASURE_FIELD_MAP)\b/g, 'var $1'), ctxSb);
  // the two readers of the load estimate answer with hostile labels (a building or source name is user data)
  ctxSb.getEndUse = () => ({ modeled: true, source: 'bills', annual: 1000, sourceLabel: evil, label: evil });
  ctxSb.getEndUseWeights = () => ({ ok: true, weights: Array(12).fill(1 / 12), endUse: 'cooling', eu: { label: evil, sourceLabel: evil } });
  const ctx = { projId: 'p1', buildingId: 'b2', buildingName: evil, backLabel: evil };
  ctxSb.renderEcmCalculator('rtu_replacement', container, { existing_cooling_kwh: attackAttr + evil }, null, null, ctx, ['existing_cooling_kwh']);
  const results = ctxSb.calculateEcm('rtu_replacement', Object.fromEntries(ctxSb.ECM_TEMPLATES.rtu_replacement.inputs.map((x) => [x.id, x.default])));
  ctxSb.renderEcmResults('rtu_replacement', results, container, ctx, {});
  const html = out.html;
  if (html.length < 500) problems.push('ECM render test: the real render functions printed almost nothing');
  if (/<img/i.test(html)) problems.push('ECM calculator HTML prints a hostile building or source label as markup');
  if (!html.includes('&lt;img src=x onerror=alert(1)&gt;')) problems.push('ECM render test: the hostile text did not reach the page as text');
  if (/onfocus="alert/.test(html)) problems.push('ECM calculator HTML lets a typed value or building name break out of an attribute');
}


// 6. BAS Calc (app/calculators.js openBASCalc): saved values and building data never reach the page as markup.
//    A hostile string saved in a BAS Calc field, plus a hostile end-use source label, goes through the REAL openBASCalc.
{
  const noCr = (t) => t.split(String.fromCharCode(13)).join('');
  const out = { html: '' };
  const wrap = { set innerHTML(v) { out.html += v; }, get innerHTML() { return out.html; }, querySelector() { return null; }, querySelectorAll() { return []; }, style: {} };
  const evil = '<img src=x onerror=alert(1)>';
  const attack = '" onfocus="alert(1)';
  const fields = ['sqft', 'vrfPct', 'coolEff', 'afue', 'elecCOP', 'humRatioSP', 'exCoolOcc', 'exMfOn', 'newCoolOcc', 'newSunOff', 'calCoolKwh', 'calHeatKwh', 'calHeatGas'];
  const bc = { heatSrc: 3, __userTouched: fields.slice() };
  fields.forEach((f, i) => (bc[f] = i % 2 ? evil : attack + evil));
  const bsb = {
    console,
    projects: [{ id: 1, name: 'P', basCalc: bc }],
    document: { getElementById: (id) => (id === 'svDetailWrap' ? wrap : null), createElement: () => ({ style: {} }), head: { appendChild() {} }, querySelectorAll: () => [] },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
    BAS_WEATHER_BINS: { bins: [], cities: { 1: { name: 'Test City, KS' } } },
    EM_SP_DEFAULTS: { unocc: { hydronic: { heat: 55, cool: 85 }, electricReheat: { heat: 60, cool: 85 } } },
  };
  vm.createContext(bsb);
  ['lib/formatting.js', 'computations/physics.js', 'app/calc-autofill.js', 'computations/end-use.js', 'app/calculators.js'].forEach((f) => {
    try {
      vm.runInContext(noCr(fs.readFileSync(path.join(REPO, f), 'utf8')).replace(/const\s+/g, 'var ').replace(/let\s+/g, 'var '), bsb, { filename: f });
    } catch (e) {
      problems.push('BAS Calc escape test: could not load ' + f + ': ' + e.message);
    }
  });
  bsb.getEndUse = () => ({ modeled: true, source: 'bills', annual: 1000, sourceLabel: evil });
  try {
    bsb.openBASCalc(1);
  } catch (e) {
    problems.push('BAS Calc escape test: openBASCalc threw ' + e.message);
  }
  const html = out.html;
  if (html.length < 2000) problems.push('BAS Calc escape test: the real openBASCalc printed almost nothing');
  if (/<img/i.test(html)) problems.push('BAS Calc HTML prints a saved value or source label as markup');
  if (!html.includes('&lt;img src=x onerror=alert(1)&gt;')) problems.push('BAS Calc escape test: the hostile text did not reach the page as text');
  if (/onfocus="alert/.test(html)) problems.push('BAS Calc HTML lets a saved value break out of an attribute');
}

if (problems.length) {
  console.log('FAIL: single HTML escape gate - ' + problems.length + ' problem(s)');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('PASS: single HTML escape gate - _escHtml (lib/formatting.js) is the only HTML escaper');
