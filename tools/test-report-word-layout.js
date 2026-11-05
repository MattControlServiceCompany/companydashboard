// tools/test-report-word-layout.js — Word layout rules for the quarterly report. SYNTHETIC data only.
// Run: node tools/test-report-word-layout.js
//   1. Column widths: a column is never narrower than its longest word; the table total stays the same.
//   2. A number with its unit stays on one line when the table has room (strictest rule that fits).
//   3. Report table cells use small side margins and no fixed tiny widths (no <w:tcW> below 300 twips from the fitter).
//   4. Report line spacing: exact lines, 6pt after body text, Heading 3 not indented.
//   5. Page number footer: Arial 10pt, right, a spacer under it that lifts it above the wave.
//   6. "Year to Date" has one heading (the section's own page body has no second h2).
//   7. The Word export gives a report a compact letterhead spacer.
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
const sb = {};
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
    const lift = /w:line="(\d+)" w:lineRule="exact"\/><\/w:pPr><\/w:p><\/w:ftr>/.exec(out);
    assert(lift && Number(lift[1]) >= 1500, 'a spacer under the number lifts it above the wave: ' + (lift && lift[1]));
    rest();
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
