// tools/test-ocr-review-bar-room.js - the OCR review bar is always on screen AND no value scrolls behind it.
// Rule (a): the bar is a normal row at the bottom of the extraction area, outside the scroller (not sticky/fixed).
// Rule (b): the values sit in their own bounded scroll region (#pdfValuesScroll), so the bar never overlaps them.
// Static check, no browser. Run: node tools/test-ocr-review-bar-room.js
// SYNTHETIC: reads only the page source.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'energy-department.html'), 'utf8');
let pass = 0;
const fails = [];
const ok = (c, l) => (c ? pass++ : fails.push(l));
const rule = (selRe) => [...src.matchAll(/(^|\n)\s*([^{}\n]*)\{([^}]*)\}/g)].filter((m) => selRe.test(m[2])).map((m) => m[3]).join('\n');

// Bar CSS: a normal row.
const barCss = rule(/\.pdf-review-bar\s*$/);
ok(barCss.length > 0, 'a .pdf-review-bar CSS rule exists');
ok(!/position\s*:\s*(sticky|fixed|absolute)/.test(barCss), 'bar is not sticky, fixed or absolute (it would sit over the values)');
ok(!/\bbottom\s*:/.test(barCss), 'bar has no bottom offset');
ok(!/\.pdf-review-bar::(after|before)/.test(src), 'bar has no pseudo strip outside its own box');

// Scroller CSS: bounded, scrolls, and the column around it is a bounded flex column.
const scCss = rule(/^\s*#pdfValuesScroll\s*$/);
ok(/overflow-y\s*:\s*auto/.test(scCss), '#pdfValuesScroll scrolls (overflow-y:auto)');
ok(/min-height\s*:\s*0/.test(scCss) && /flex\s*:\s*1\b/.test(scCss), '#pdfValuesScroll is bounded by its flex parent (flex:1, min-height:0)');
ok(/flex-direction\s*:\s*column/.test(rule(/#pdfBody #pdfLeftCol\s*$/)), '#pdfLeftCol is a flex column (scroller, then bar)');
ok(/min-height\s*:\s*0/.test(rule(/#pdfBody\s*$/)) && /flex\s*:\s*1/.test(rule(/#pdfBody\s*$/)), '#pdfBody is bounded to the screen (flex:1, min-height:0)');
ok(/overflow\s*:\s*hidden/.test(rule(/#view-pdf\.view\.active\s*$/)), 'the PDF page itself does not scroll');

// HTML structure: values grid inside the scroller; bar after the scroller closes, same column, not inside it.
const lc = src.indexOf('id="pdfLeftCol"');
const sc = src.indexOf('id="pdfValuesScroll"');
const gi = src.indexOf('id="extractedFieldsGrid"');
const bi = src.indexOf('id="pdfReviewBar"');
ok(lc > 0 && sc > lc && gi > sc && bi > gi, 'order is column, scroller, values grid, review bar');
const between = src.slice(gi, bi);
const opens = (between.match(/<div\b/g) || []).length;
const closes = (between.match(/<\/div>/g) || []).length;
ok(closes - opens === 1, 'the scroller closes between the values grid and the bar (bar is outside it)');
ok(/id="extractedFieldsGrid"[^>]*><\/div>\s*<\/div>/.test(src), 'extractedFieldsGrid is the last child of the scroller');
ok(src.indexOf('id="pdfTopBar"') > sc && src.indexOf('id="pdfTopBar"') < gi, 'the file bar is inside the scroller (it sticks at the top of it)');
ok(/#pdfValuesScroll \.pdf-topbar\s*\{[^}]*top\s*:\s*0/.test(src), 'the file bar sticks flush with the top of the scroller');

if (fails.length) {
  console.log(pass + ' passed, ' + fails.length + ' failed');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('test-ocr-review-bar-room: ' + pass + ' passed, 0 failed');
