// Item #14: an extraction does not download a debug file or show the toast. Only the manual button does.
const vm = require('vm');
let toasts = 0, clicks = 0;
const sb = require('./ocr-sandbox.js')({ showToast: () => toasts++, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, Blob: function () {} });
sb.document.createElement = () => ({ click: () => clicks++ });
sb.window._pdfRawText = 'raw';
sb.window._pdfSourceFileName = 'synth.pdf';
sb.window._pdfMultiBills = [{ AccountNumber: 'TST-0001' }];
vm.runInContext('showToast = function(){ globalThis.__t = (globalThis.__t||0)+1; }', sb);
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const f = sb.get('savePDFDebug');
f();
ok(!sb.__t && clicks === 0, 'automatic call: no download, no toast');
ok(!!sb.window._debugFileContent, 'automatic call still keeps the capture');
f(true);
ok(sb.__t === 1 && clicks === 1, 'manual call: download and toast');
process.exit(bad ? 1 : 0);
