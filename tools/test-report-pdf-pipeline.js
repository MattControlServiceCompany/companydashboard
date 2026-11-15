// Test: _rptPdfPipeline overlaps render(n+1) with encode(n) and consumes in page order.
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'report-pdf.js'), 'utf8');
const i0 = src.indexOf('async function _rptPdfPipeline');
const i1 = src.indexOf('function _rptPdfEncodeJpeg');
const m = i0 < 0 || i1 < 0 ? null : [src.slice(i0, i1).replace(/\/\*\*[^]*$/, '')];
if (!m) { console.log('FAIL: function not found'); process.exit(1); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(m[0] + ';this._rptPdfPipeline=_rptPdfPipeline;', ctx);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const log = [], consumed = [];
  await ctx._rptPdfPipeline(4,
    async i => { log.push('render' + i); await wait(20); const encoded = (async () => { await wait(i === 1 ? 80 : 5); log.push('enc' + i); return i; })(); return { encoded }; },
    job => consumed.push(job));
  let ok = true;
  const t = (c, msg) => { if (!c) { ok = false; console.log('FAIL: ' + msg); } };
  t(consumed.join() === '0,1,2,3', 'order ' + consumed);
  t(log.indexOf('render1') < log.indexOf('enc0') + 1 && log.indexOf('render2') < log.indexOf('enc1'), 'overlap ' + log);
  let n = 0; await ctx._rptPdfPipeline(0, async () => { n++; }, () => { n++; }); t(n === 0, 'empty');
  console.log(ok ? 'PASS test-report-pdf-pipeline' : 'FAILED'); process.exit(ok ? 0 : 1);
})();
