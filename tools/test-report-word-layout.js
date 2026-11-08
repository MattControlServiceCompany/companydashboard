// tools/test-report-word-layout.js — Word layout rules for the quarterly report. SYNTHETIC data only.
// Run: node tools/test-report-word-layout.js
//   1. Column widths: a column is never narrower than its longest word; the table total stays the same.
//   2. A number with its unit stays on one line when the table has room (strictest rule that fits).
//   3. Report table cells use small side margins and no fixed tiny widths (no <w:tcW> below 300 twips from the fitter).
//   4. Report line spacing: exact lines, 6pt after body text, Heading 3 not indented.
//   5. Page number footer: Arial 10pt, right, no lift; it sits in the white area below the wave (footer distance 10pt).
//   6. "Year to Date" has one heading (the section's own page body has no second h2).
//   7. The Word export gives a report a compact letterhead spacer.
//   8. A minus sign is Word's own no-break hyphen (never the U+2011 character, which Word draws as a raised bar).
//   9. The footer's NUMPAGES field keeps the page count the export gives it.
//  10. A table or a picture never runs past the text width (10080 twips).
//  11. Every table row cannot split across a page; the first row of each table repeats as the header.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.env.APP_ROOT || path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok   ' + msg);
  } else {
    failed++;
    console.log('  FAIL ' + msg);
  }
}

const src = fs.readFileSync(path.join(REPO, 'app', 'docx-writer.js'), 'utf8');
const sb = { atob: (t) => Buffer.from(t, 'base64').toString('binary') };
vm.createContext(sb);
vm.runInContext(src, sb);

// fake table cells (no DOM): getAttribute, tagName, textContent
function cell(text, opts) {
  opts = opts || {};
  return {
    tagName: opts.th ? 'TH' : 'TD',
    textContent: text,
    getAttribute: (n) => (n === 'colspan' ? opts.span || null : n === 'data-dx-nw' ? (opts.nw ? '1' : null) : n === 'data-dx-fs' ? '12' : null),
  };
}
const SIDE = sb._DOCX_REPORT_CELL_SIDE_TWIPS;
const HP = sb._DOCX_REPORT_TABLE_HALFPT;

console.log('\n--- 1. no word breaks mid-word ---');
{
  const rows = [
    [cell('Baseline weekday occupied hours', { th: true }), cell('Heating degree days', { th: true }), cell('Electricity (kWh)', { th: true })],
    [cell('x'), cell('1,036'), cell('104,727')],
  ];
  const mins = sb._docxColumnMinWidths(rows, 3, SIDE, HP, 0);
  const wOcc = sb._docxTextWidthTwips('occupied', true, 18);
  assert(mins[0] >= wOcc + 2 * SIDE, 'column 1 min width holds the word "occupied": ' + mins[0] + ' >= ' + (wOcc + 2 * SIDE));
  assert(mins[2] >= sb._docxTextWidthTwips('Electricity', true, 18) + 2 * SIDE, 'column 3 min width holds "Electricity": ' + mins[2]);
  const fitted = sb._docxFitColumnWidths([600, 3000, 6480], mins);
  assert(fitted.reduce((a, b) => a + b, 0) === 10080, 'fitted widths keep the table total 10080: ' + fitted.join(','));
  assert(fitted.every((w, i) => w >= mins[i]), 'every fitted width is at least its minimum: ' + fitted.join(','));
  assert(fitted[0] > 600, 'a too-narrow column grows (600 -> ' + fitted[0] + ')');
}

console.log('\n--- 2. numbers and short names stay whole when there is room ---');
{
  const rows = [[cell('Use', { th: true }), cell('Building', { th: true })], [cell('123,456 kWh'), cell('Sample Elementary School East', { nw: true })]];
  const m0 = sb._docxColumnMinWidths(rows, 2, SIDE, HP, 0);
  const m1 = sb._docxColumnMinWidths(rows, 2, SIDE, HP, 1);
  const m2 = sb._docxColumnMinWidths(rows, 2, SIDE, HP, 2);
  assert(m1[0] > m0[0], 'level 1 holds "123,456 kWh" on one line (' + m1[0] + ' > ' + m0[0] + ')');
  assert(m1[1] > m0[1], 'a no-wrap cell holds its whole name at level 1 (' + m1[1] + ' > ' + m0[1] + ')');
  assert(m2[0] >= m1[0] && m2[1] >= m1[1], 'level 2 is at least as strict as level 1');
}

console.log('\n--- 3. no fixed tiny widths ---');
{
  assert(SIDE <= 70 && SIDE >= 40, 'report cell side margin is small (' + SIDE + ' twips)');
  const fitted = sb._docxFitColumnWidths([200, 200, 9680], [600, 600, 900]);
  assert(fitted.every((w) => w >= 600), 'a 200 twip column is raised to its minimum: ' + fitted.join(','));
  assert(!/w:w="(?:[1-9]\d{0,1}|[1-2]\d\d)" w:type="dxa"\/><w:gridSpan/.test(src), 'no tiny fixed cell width in the table builder');
}

console.log('\n--- 4. line spacing ---');
{
  const body = '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t>x</w:t></w:r></w:p>';
  const out = sb._docxTightenReportXml(body);
  assert(/w:lineRule="exact"/.test(out) && /w:after="80"/.test(out), 'body paragraph gets an exact line and less space after');
  assert(/w:val="20"/.test(out) && !/w:val="21"/.test(out), 'body text is 10pt in a report');
  const h3 = '<w:p><w:pPr><w:pStyle w:val="Heading3"/><w:spacing w:before="240" w:after="120"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>x</w:t></w:r></w:p>';
  assert(/<w:ind w:left="0" w:firstLine="0"\/>/.test(sb._docxTightenReportXml(h3)), 'Heading 3 starts at the margin');
  const pic = '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:drawing/><w:rPr><w:sz w:val="21"/></w:rPr></w:r></w:p>';
  assert(!/lineRule/.test(sb._docxTightenReportXml(pic)), 'a paragraph with a picture keeps automatic height');
}

console.log('\n--- 5. page number footer ---');
{
  const footer =
    '<w:ftr><w:sdt><w:sdtContent><w:p w14:paraId="1"><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="right"/></w:pPr><w:r><w:instrText> PAGE </w:instrText></w:r></w:p></w:sdtContent></w:sdt>' +
    '<w:p w14:paraId="2"><w:pPr><w:pStyle w:val="Footer"/></w:pPr></w:p></w:ftr>';
  let out = '';
  const zip = { files: { 'word/footer1.xml': 1 }, file: (n, v) => (v ? ((out = v), 0) : { async: async () => footer }) };
  sb._docxApplyPageNumberFooters(zip).then((n) => {
    assert(n === 1, 'footer patched');
    assert(/Page <|>Page </.test(out) && /NUMPAGES/.test(out), 'footer reads Page N of M with live fields');
    assert(/w:ascii="Arial"/.test(out) && !/Cambria/.test(out), 'footer text is Arial');
    assert(/<w:jc w:val="right"\/>/.test(out), 'footer text is on the right');
    const tailP = /w:line="(\d+)" w:lineRule="exact"\/><\/w:pPr><\/w:p><\/w:ftr>/.exec(out);
    assert(tailP && Number(tailP[1]) <= 40, 'the paragraph under the number is 1pt high, so no spacer lifts the number above the wave: ' + (tailP && tailP[1]));
    assert(!/_DOCX_FOOTER_LIFT_TWIPS/.test(src), 'no lift spacer constant remains in docx-writer.js');
    assert(/<w:ind w:right="-360"\/><w:jc w:val="right"\/>/.test(out), 'the number ends 0.25in past the right margin (w:ind right -360)');
    assert(sb._DOCX_FOOTER_DISTANCE_TWIPS === 200, 'footer distance is 200 twips (10pt) from the page bottom: ' + sb._DOCX_FOOTER_DISTANCE_TWIPS);
    assert(src.indexOf("'$1' + _DOCX_FOOTER_DISTANCE_TWIPS") !== -1, 'the section margin footer distance is set in _docxAssemble');
    const pgMar = '<w:pgMar w:top="639" w:right="1170" w:bottom="1872" w:left="990" w:header="720" w:footer="0" w:gutter="0"/>';
    assert(/w:footer="200"/.test(pgMar.replace(/(<w:pgMar[^>]*?w:footer=")\d+"/, '$1' + sb._DOCX_FOOTER_DISTANCE_TWIPS + '"')), 'skeleton pgMar footer="0" becomes footer="200"');
    // Position: number line is 10pt (200 twips) exact, tail paragraph 1pt (20 twips), distance 10pt: text bottom = 792 - 10 - 1 = 781pt, top = 771pt.
    const bottomPt = 792 - sb._DOCX_FOOTER_DISTANCE_TWIPS / 20 - Number(tailP[1]) / 20;
    assert(bottomPt === 781 && bottomPt <= 792, 'number line bottom is ' + bottomPt + 'pt from the page top (inside the page, below the wave)');
    const zip22 = { files: { 'word/footer1.xml': 1 }, file: (n, v) => (v ? ((out22 = v), 0) : { async: async () => footer }) };
    let out22 = '';
    sb._docxApplyPageNumberFooters(zip22, 22).then(() => {
      const cached = (xml) => /NUMPAGES[\s\S]*?separate"\/><\/w:r><w:r>[\s\S]*?<w:t>(\d+)<\/w:t>/.exec(xml);
      assert(cached(out22) && cached(out22)[1] === '22', 'NUMPAGES keeps the page count the export gives it (22): ' + (cached(out22) && cached(out22)[1]));
      assert(cached(out) && cached(out)[1] === '1', 'NUMPAGES cached result is 1 when the export gives no count');
      rest();
    });
  });
}

function rest() {
  console.log('\n--- 6. Year to Date prints once ---');
  const eng = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  assert(!/<h2>Year to Date<\/h2>/.test(eng), 'the Year to Date page body has no second heading');
  assert(/rptPage\(n, 'Year to Date'/.test(eng), 'the Year to Date page keeps its title');

  console.log('\n--- 7. report letterhead spacer ---');
  assert(sb._DOCX_LETTERHEAD_SPACER_COMPACT_TWIPS < sb._DOCX_LETTERHEAD_SPACER_TWIPS, 'compact spacer is shorter than the standard one');
  assert(sb._DOCX_LETTERHEAD_SPACER_COMPACT_TWIPS / 20 + 31.95 >= 150, 'compact spacer still clears the letterhead lockup (ink bottom 145pt)');
  assert(/compactLetterhead: translated\.isReport/.test(eng), 'the quarterly Word export passes the compact spacer flag');

  console.log('\n--- 8. minus sign in a Word run ---');
  {
    const run = sb._docxRun({ text: 'Savings were \u2212$6,496 and \u22125 units' });
    assert((run.match(/\u2212/g) || []).length === 2, 'the minus sign (U+2212) is kept in the Word run text');
    assert(!/noBreakHyphen/.test(run) && /Savings were \u2212\$6,496 and \u22125 units/.test(run), 'one run, no no-break-hyphen element');
    const plain = sb._docxRun({ text: 'a - b \u2212 c' });
    assert(!/noBreakHyphen/.test(plain) && /\u2212/.test(plain), 'a plain hyphen and a real minus (U+2212) are not changed');
  }

  console.log('\n--- 10. table and picture widths ---');
  {
    const W = sb._DOCX_CONTENT_WIDTH_TWIPS;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const wide = sb._docxHoldTableWidth([3024, 1310, 1310, 1109, 1210, 1210, 1109], 10282);
    assert(sum(wide) === W, 'a table 202 twips too wide is cut to the text width: ' + sum(wide));
    assert(wide.every((w) => w >= 400), 'no column is cut below 400 twips: ' + wide.join(','));
    assert(sum(sb._docxHoldTableWidth([3125, 1008, 1109, 1210, 1008, 2621], 10081)) === W, 'a rounding step over is cut to the text width');
    assert(sum(sb._docxHoldTableWidth([3427, 1663, 1663, 1663, 1663], 10079)) === W, 'a rounding step under is raised to the text width');
    assert(sum(sb._docxHoldTableWidth([2000, 3000], 5000)) === 5000, 'a table narrower than the text area keeps its width');
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const img = { getAttribute: (n) => (n === 'src' ? png : n === 'alt' ? 'Chart' : null), style: { width: '720px', height: '150px' } };
    const ctx = { images: [], imageCounter: 100 };
    let runXml = null;
    try {
      runXml = sb._docxRegisterImage(img, ctx);
    } catch (e) {
      console.log('    (error: ' + e.message + ')');
    }
    const cx = runXml && /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(runXml);
    assert(cx && Number(cx[1]) <= W * 635, 'a picture 720 px wide is no wider than the text area: ' + (cx && cx[1] + ' <= ' + W * 635));
    assert(cx && Math.abs(Number(cx[1]) / Number(cx[2]) - 720 / 150) < 0.01, 'the picture keeps its proportions');
  }

  console.log('\n--- 11. rows stay whole, header repeats ---');
  {
    const body = sb._docxTableRow(['<w:tc/>'], {});
    const head = sb._docxTableRow(['<w:tc/>'], { header: true });
    assert(/^<w:tr><w:trPr><w:cantSplit\/><\/w:trPr>/.test(body) && !/tblHeader/.test(body), 'a body row has cantSplit and no tblHeader');
    assert(/<w:trPr><w:cantSplit\/><w:tblHeader\/><\/w:trPr>/.test(head), 'a header row has cantSplit and tblHeader');
    const bare = src.split('\n').filter((l) => /['"]<w:tr>['"]/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert(bare.length === 1 && bare[0].indexOf('trPr') >= 0, 'only _docxTableRow writes a <w:tr> (' + bare.length + ' place)');
    const flex = src.slice(src.indexOf('function _docxTranslateFlexRowTable'), src.indexOf('function _docxTranslateBlock('));
    assert(/_docxTableRow\(cellsXml, \{ header: true \}\)/.test(flex), 'the one-row flex table writes its row with _docxTableRow, as a header row');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
