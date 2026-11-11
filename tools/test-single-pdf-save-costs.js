// test-single-pdf-save-costs.js -- item 63e43cab: _saveSinglePDFBill read kwCost, kwhCost, otherCost and taxCost after
// 82745e3b removed them from its scope, so every single-bill save threw "kwCost is not defined" (night verify FAIL
// 2026-10-21). Static check of the real source: each of the 4 names the component sum reads is declared in the function.
// Synthetic bill only. Check: node tools/test-single-pdf-save-costs.js   Exit 1 on any FAIL.
'use strict';
const { fnSource } = require('./bill-flags-sandbox.js');
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? '  ok   ' : '  FAIL ') + m); };

const src = 'app/bill-analysis.js';
const body = fnSource(src, '_saveSinglePDFBill');
['kwCost', 'kwhCost', 'otherCost', 'taxCost'].forEach((n) => {
  const used = new RegExp('\\b' + n + '\\b').test(body.replace(/\/\/.*$/gm, ''));
  const declared = new RegExp('(const|let|var)\\s*\\{[^}]*\\b' + n + '\\b[^}]*\\}\\s*=|(const|let|var)\\s+' + n + '\\b').test(body);
  check(!used || declared, n + ' is declared in _saveSinglePDFBill before it is read');
});

console.log(fails ? 'FAIL: ' + fails : 'PASS');
process.exit(fails ? 1 : 0);
