// tools/test-a36-final-review-fixes.js - the review fixes of the Detailed ASHRAE 36 Audit Report (2026-11-16). SYNTHETIC data only, headless bundled Chromium.
//   1/8  the PDF text layer keeps the space between two words that sit close together ("Terminal Airflow", "VAV-20 (Telecom 123)")
//   2    a figure caption prints only the page type word, never a description of the picture
//   3    one term "variable frequency drive" in report text (findings and pump sentences)
//   4    the "(n of m)" part label: 70% size, normal weight, body colour; the Word export keeps the normal weight
//   7    a heating-only row prints "No cooling" (never "None cooling", never "N/A")
//   9    the printed deadband is the printed cooling average minus the printed heating average
//   10   a setpoint value prints only for the units that have the point
//   11   fans that share drives print the drive count ("six supply fans and one variable frequency drive")
//   13   an offline unit is no finding
//   15   the CO2 counts of the findings use the base of the Executive Summary (one rule: _a36DcvUnitKind)
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-final-review-fixes.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const RE = fs.readFileSync(path.join(ROOT, 'app/report-engine.js'), 'utf8');
const PDF = fs.readFileSync(path.join(ROOT, 'app/report-pdf.js'), 'utf8');
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

// function source by name (nested functions too)
function fnSrc(src, name) {
  const idx = src.search(new RegExp('function ' + name + '[ ]*[(]'));
  if (idx < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', idx)), d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(idx, j + 1);
}

// 1 / 8: source check of the text layer
ok(/if \(wd\.sp\) \{\s*doc\.setFontSize\(1\);\s*doc\.text\(' ', \(wd\.x \+ wd\.w\)/.test(PDF) && /sp: m\.index \+ m\[0\]\.length < text\.length/.test(PDF), '1/8. the PDF text layer writes a real space after a word that has a space after it on the page (1 pt font, inside the gap)');

// 7 / 9: source checks of Appendix A
ok(!/None cooling/.test(RE) && /' \/ No cooling'/.test(RE), '7. the heating-only cell reads "No cooling" ("None cooling" is gone)');
ok(/\(_detailedReview \? 'No cooling' : '—'\) : _fmtDeadband\(r\)/.test(RE), '7. the heating-only deadband reads "No cooling"');
ok(!/\bN\/A\b/.test(fnSrc(RE, '_pairText')), '7. no "N/A" in the setpoint cell');

// 13: source check that a finding is not made from an offline deficiency
ok(/if \(_a36DetIsOfflineDeficiency\(df\)\) return;/.test(RE), '13. the findings loop skips an offline deficiency');

// 15: one rule for the CO2 base, read by both consumers
ok(/var _dcvKind = _a36DcvUnitKind\(eq\);/.test(RE) && /_a36DetDcvBase\(g\)/.test(RE), '15. the Executive Summary count and the per-library findings both read _a36DcvUnitKind');

// 3: no report text with the old terms (string literals of the audit text)
const lits = RE.match(/'[^'\n]*(variable speed drive|variable-speed|variable frequency drive \(VFD\))[^'\n]*'/g) || [];
ok(lits.every((s) => /variable-speed savings/.test(s)), '3. no report string says "variable speed drive" or "variable-speed" (left: ' + lits.join(' | ') + ')');

// Second fix pass (2026-11-16), items 1 to 9. Pure functions are evaluated from the source; no client names.
{
  const sandbox = new Function(
    fnSrc(RE, '_a36DetFraction') + '\n' + fnSrc(RE, '_a36DetNormalizeText') + '\nreturn { f: _a36DetFraction, n: _a36DetNormalizeText };'
  )();
  // 2 / 9: the base and the noun of a count
  ok(!/that need a CO2 sensor/.test(RE) && /f\.dcvNote = dcvNarrow \? _a36DetDcvNote\(g, units, f\.affected\)/.test(RE), '2. a CO2 count is against the whole group with a note on the other units; no "that need a CO2 sensor" (Matt 2026-11-18: no unit needs a CO2 sensor)');
  ok(sandbox.f(3, 25) === '3 of 25 units' && sandbox.f(5, 5) === 'all 5 units' && sandbox.f(2, 2) === 'both units' && sandbox.f(1, 1) === 'the unit', '2. a count with no base text keeps the old words');
  ok(sandbox.f(1, 1, 'plant') === 'the plant' && sandbox.f(2, 2, 'plant') === 'both plants', '9. a plant is a plant, not a unit');
  ok(/f\.fracNoun = g && \(g\.category === 'hwp' \|\| g\.category === 'chwp'\) \? 'plant'/.test(RE), '9. a plant finding reads the noun plant (the Opportunities Summary prints no count since 2026-11-18)');
  // 3: the setpoint wording
  ok(/setpoints that differ from these\.'/.test(RE) && !/Each differing setpoint is also an opportunity/.test(RE) && / Appendix A lists each setpoint with the recommended value beside it\./.test(RE) && /Control Service Company recommends zone setpoints of /.test(RE) && !/ASHRAE 36 recommended values/.test(RE), '3. Executive Summary: setpoints "differ from the Control Service Company standard setpoints in Appendix A" (they are the company setpoints, not ASHRAE 36 values)');
  // 4: every Key Findings phrase says only that the full sequence is missing
  ok(/ahu_economizer: 'economizer',/.test(RE) && /In each case the setpoint does not follow the load/.test(RE) && !/do not use outdoor air for free cooling|hold fixed settings/.test(RE), '4. the summary names the missing sequences and makes no claim about what a unit does');
  ok(!/do not use outdoor air for free cooling|hold one supply air temperature at all times|do not control their minimum outdoor air/.test(RE), '4. the three overclaiming phrases are gone');
  // 7: the PDF text layer writes the non-breaking hyphen of a tag as a plain hyphen, so search and copy find "UH-1"
  ok(/'‑': '-'/.test(fs.readFileSync(path.join(ROOT, 'app', 'report-pdf.js'), 'utf8')), '7. PDF text layer: non-breaking hyphen reads as a plain hyphen');
  // 5: retired 2026-11-18: the per-building ASHRAE 36 pages that held the Devices to Install column are deleted (7d484c89)
  // 1: the findings state facts only (Matt 2026-11-17): no Solution line, so no install/program advice
  ok(!/part\('Solution'/.test(RE) && !/pointIsControllerOnly/.test(RE) && !/programming only, no device to install/.test(RE), '1. the findings print no Solution line');
  // 6: a sentence that holds for some terminals leads with the count
  ok(/function some\(keys, noun\)/.test(RE) && /On ' \+ n \+ ' of the ' \+ total/.test(RE) && !/function part\(keys, noun\)/.test(RE), '6. a sentence about some of the units starts "On 1 of the 35 terminals, ..."');
  ok(/'The damper modulates to hold ' \+ holdText/.test(RE), '6. the partial damper sentence reads "the damper modulates", never "the damper of each terminal"');
  // 7: no line break inside an equipment tag or a time
  const nt = sandbox.n('<p>UH-1 &amp; ERV-2 run 7:00 AM-7:00 PM</p>');
  ok(nt === '<p>UH\u20111 &amp; ERV\u20112 run 7:00\u00A0AM\u20117:00\u00A0PM</p>', '7. a tag has a non-breaking hyphen, a time a non-breaking space and hyphen: ' + JSON.stringify(nt));
  ok(!/<[^>]*\u2011/.test(sandbox.n('<td style="x" class="VAV-1">VAV-1</td>')), '7. only the text between tags changes, never an attribute');
  // 8: the verb and the noun follow the number of fans
  ok(!/BAS \+ 'enables the ' \+ _a36DetJoin\(fans\)/.test(RE), '8. no obvious "enables the supply fans" sentence (Matt 2026-11-17)');
}

(async () => {
  const ctx = await launchBrowser('a36-final-review-fixes');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36DetControlSentences === 'function' && typeof _a36DcvUnitKind === 'function' && typeof emAirConfig === 'function' && typeof _docxStyleFmtFromEl === 'function', null, { timeout: 30000 });

    const r = await page.evaluate((fmtDeadbandSrc) => {
      const out = {};
      // 2. captions
      out.cap = ['graphic (boilers/HW pumps)', 'Graphic', 'properties (air handler)', 'graphic - chiller plant', 'logic: reset', '', 'graphic_x (a program name only)'].map((t) => _a36DetCaptionPage(t));
      // 3. pump sentence
      out.pumps = _a36DetPumpPhrase({ pumps: { primary: 1, secondary: 2, plain: 0 }, pumpSpeed: { primary: 'drive', secondary: 'variable' } }, 'chilled water');
      out.pump1 = _a36DetPumpPhrase({ pumps: { primary: 0, secondary: 0, plain: 1 }, pumpSpeed: { plain: 'variable' } }, 'hot water');
      // 4. part label
      out.title = _a36DetSectionTitle(16, 'Opportunities Summary', ' (2 of 7)');
      const sp = document.createElement('span');
      sp.setAttribute('style', 'font-size:70%;font-weight:400;color:var(--rpt-page-text)');
      out.fmt = _docxStyleFmtFromEl(sp, { bold: true, sizeHalfPt: 42, color: '1A5276' }, {});
      const sb = document.createElement('span');
      sb.setAttribute('style', 'font-weight:700');
      out.fmtBold = _docxStyleFmtFromEl(sb, {}, {});
      // 9. deadband
      const dbf = new Function(fmtDeadbandSrc + '; return _fmtDeadband;')(); // source of this repo's own functions (trusted)
      out.db = [dbf({ avgCool: 73.46, avgHeat: 67.94, avgDb: 5.7 }), dbf({ avgCool: 72.66, avgHeat: 68.54, avgDb: 4.1 }), dbf({ avgCool: null, avgHeat: null, avgDb: 3 })];
      // 11. fans: six fans, one drive; two fans, two drives; three fans, one drive plus a return fan with its own
      const A = (list) => { const o = {}; list.forEach((n) => (o[n] = 'On')); return emAirConfig(o); };
      out.six = _a36DetFansPhrase(A(['Supply Fan 1A Status', 'Supply Fan 1B Status', 'Supply Fan 1C Status', 'Supply Fan 1D Status', 'Supply Fan 1E Status', 'Supply Fan 1F Status', 'Supply Fan VFD Speed', 'Supply Fan VFD Enable']));
      out.two = _a36DetFansPhrase(A(['Supply Fan 1 VFD Speed', 'Supply Fan 2 VFD Speed']));
      out.one = _a36DetFansPhrase(A(['Supply Fan VFD Speed', 'Return Fan VFD Speed']));
      out.mixed = _a36DetFansPhrase(A(['Supply Fan 1A Status', 'Supply Fan 1B Status', 'Supply Fan VFD Speed', 'Return Fan VFD Speed']));
      // 13. offline
      out.off = [_a36DetIsOfflineDeficiency({ issue: 'The unit did not report any readings during the review (offline).' }), _a36DetIsOfflineDeficiency({ issue: 'Damper is stuck open.' }), _a36DetIsOfflineDeficiency(null)];
      // 15. CO2 base
      const unit = (category, status) => ({ category, name: category, seqReadiness: status ? { vav_dcv: { status }, demandCtrl: { status } } : {} });
      out.kinds = [unit('vav', 'na'), unit('vav', 'blocked'), unit('fpb', ''), unit('ddvav', 'partial'), unit('ahu', 'blocked'), unit('ahu', 'na'), unit('rtu', ''), unit('exhaust fan', ''), unit('heater', '')].map((u) => _a36DcvUnitKind(u));
      out.base = _a36DetDcvBase({ units: [unit('vav', 'na'), unit('vav', 'na'), unit('vav', 'blocked'), unit('vav', 'blocked'), unit('vav', 'partial')] });
      out.baseNone = _a36DetDcvBase({ units: [unit('vav', 'na'), unit('vav', 'na')] });
      // 10. a setpoint value only for the units that have the point
      const run = (rd, n) => {
        const g = { category: 'ahu', label: 'Variable Air Volume Air Handling Unit', units: new Array(n).fill(0) };
        const by = {};
        ['sat', 'clgValve', 'sfSpeedCmd', 'dsp'].forEach((k) => { by[k] = { label: k, names: new Array(n).fill('u') }; });
        return _a36DetControlSentences(g, { covered: { by } }, rd, {}).map((s) => s.text);
      };
      out.spSome = run({ satCoolSp: '55°F', counts: { satCoolSp: 1 } }, 2);
      out.spAll = run({ satCoolSp: '55°F', counts: { satCoolSp: 2 } }, 2);
      out.spNoCounts = run({ satCoolSp: '55°F' }, 2);
      out.dspSome = run({ dspSp: '1.5 in. w.c.', counts: { dspSp: 2 } }, 3);
      return out;
    }, fnSrc(RE, '_fmtAvg') + '\n' + fnSrc(RE, '_fmtDeadband'));

    ok(r.cap[0] === 'Graphic' && r.cap[1] === 'Graphic' && r.cap[2] === 'Properties' && r.cap[3] === 'Graphic' && r.cap[4] === 'Logic' && r.cap[5] === '' && r.cap[6] === '', '2. the caption prints only the page type word: ' + JSON.stringify(r.cap));
    ok(r.pumps.join(' | ') === 'one primary chilled water pump with a variable frequency drive | two secondary chilled water pumps with variable frequency drives', '3. pumps with a speed point or a drive point have a variable frequency drive: ' + r.pumps.join(' | '));
    ok(r.pump1.join('') === 'one hot water pump with a variable frequency drive', '3. one pump: ' + r.pump1.join(''));
    ok(/font-size:70%/.test(r.title) && /font-weight:400/.test(r.title) && /color:var\(--rpt-page-text\)/.test(r.title) && !/<span[^>]*rpt-blue/.test(r.title), '4. the (n of m) label: 70% size, normal weight, body colour, not the heading blue: ' + r.title.slice(-150));
    ok(r.fmt.bold === false && r.fmt.sizeHalfPt === 29 && r.fmt.color && r.fmt.color !== '1A5276', '4. Word: the label inside a bold heading is not bold, 70% of the size, body colour: ' + JSON.stringify(r.fmt));
    ok(r.fmtBold.bold === true, '4. Word: a bold element stays bold');
    ok(r.db[0] === '5.6°F' && r.db[1] === '4.2°F' && r.db[2] === '3.0°F', '9. deadband = printed cooling average - printed heating average (5.6, 4.2; no averages = stored value): ' + r.db.join(', '));
    ok(r.six === 'has six supply fans and one variable frequency drive', '11. six fans, one drive: ' + r.six);
    ok(r.two === 'has two supply fans, each with a variable frequency drive', '11. two fans, two drives (each): ' + r.two);
    ok(r.one === 'has a supply fan and a return fan, each with a variable frequency drive', '11. one fan each: ' + r.one);
    ok(/^has two supply fans with one variable frequency drive and a return fan with a variable frequency drive$/.test(r.mixed), '11. shared drive plus own drive: ' + r.mixed);
    ok(r.off[0] === true && r.off[1] === false && r.off[2] === false, '13. only the offline deficiency is recognised: ' + r.off.join(','));
    ok(r.kinds.join(',') === ',zone,zone,zone,ahu,,ahu,,', '15. the unit kinds (na, monitoring rule, ahu, zone, none): ' + r.kinds.join(','));
    ok(r.base === 3 && r.baseNone === 2, '15. the base of a group is the units that need a CO2 sensor (3 of 5; a group with none keeps its count): ' + r.base + ', ' + r.baseNone);
    ok(![].concat(r.spSome, r.spAll, r.spNoCounts, r.dspSome).some((x) => /\d/.test(x)), '10. (2026-11-17) no setpoint value is printed in any description sentence: ' + JSON.stringify([r.spSome, r.spAll, r.dspSome]));



    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e);
  process.exit(2);
});
