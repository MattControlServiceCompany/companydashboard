// tools/test-ocr-review-bar-room.js - the OCR review bar must take its own space (no overlap with the values).
// Static check, no browser. Run: node tools/test-ocr-review-bar-room.js
// SYNTHETIC: reads only the page source.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'energy-department.html'), 'utf8');
let pass = 0;
const fails = [];
const ok = (c, l) => (c ? pass++ : fails.push(l));

const rules = [...src.matchAll(/(^|\n)\s*([^{}\n]*\.pdf-review-bar[^{},]*)\{([^}]*)\}/g)];
ok(rules.length >= 1, 'a .pdf-review-bar CSS rule exists');
const css = rules.map((m) => m[3]).join('\n');
const sel = rules.map((m) => m[2]).join(' ');
ok(!/position\s*:\s*(sticky|fixed|absolute)/.test(css), 'review bar is not sticky, fixed or absolute (it would sit over the values)');
ok(!/::after|::before/.test(sel), 'review bar has no pseudo strip that reaches outside its own box');
ok(!/\bbottom\s*:/.test(css), 'review bar has no bottom offset');

// The bar element comes after the values grid, in the same column.
const gi = src.indexOf('id="extractedFieldsGrid"');
const bi = src.indexOf('id="pdfReviewBar"');
ok(gi > 0 && bi > gi, 'review bar is after the values grid in the page');

if (fails.length) {
  console.log(pass + ' passed, ' + fails.length + ' failed');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('test-ocr-review-bar-room: ' + pass + ' passed, 0 failed');
