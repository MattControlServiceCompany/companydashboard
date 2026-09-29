// tools/test-presented-report-pdf.js - WP-04b acceptance test: the PDF given to the client is kept on the
// presented record, and a presented period opens that PDF by default. SYNTHETIC data only.
// Run: node tools/test-presented-report-pdf.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const rd = (r) => fs.readFileSync(path.join(REPO, r), 'utf8');

// Fake document: elements keep innerHTML and a class set.
const els = {};
const el = (id) =>
  els[id] ||
  (els[id] = {
    id,
    innerHTML: '',
    style: {},
    textContent: '',
    classList: {
      s: new Set(),
      add(c) {
        this.s.add(c);
      },
      remove(c) {
        this.s.delete(c);
      },
    },
  });
const store = {};
const sb = {
  console,
  document: { getElementById: el, createElement: () => ({}), body: { appendChild() {} }, querySelectorAll: () => [] },
  sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  sset: (k, v) => (store[k] = JSON.parse(JSON.stringify(v))),
  _rptV2Esc: (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;'),
  showToast() {},
  window: {},
};
sb.window = sb;
vm.createContext(sb);
['lib/formatting.js', 'computations/savings.js', 'app/presented-savings.js'].forEach((f) =>
  vm.runInContext(rd(f), sb, { filename: f }),
);
const ev = (e) => vm.runInContext(e, sb);

const Q1 = ['2026-01', '2026-02', '2026-03'];
const rec = ev(
  "savePresentedRecord({ projectId: 7, periodStart: '2026-01', periodEnd: '2026-03', presentedAt: '2026-04-05T12:00:00Z', documentName: 'Q1', totalDollars: 100, buildings: { b1: { dollars: 100 } } })",
);
assert(rec.ok && !rec.record.pdfKey, '1: a presented record starts with no PDF');

// no PDF attached: default screen says so plainly and offers the updated report
let updated = 0;
sb._cb = () => updated++;
assert(
  ev('_rptPresentedChooser(7, ' + JSON.stringify(Q1) + ", 'Q1 2026', _cb)") === true,
  '2: a presented period takes over the report screen',
);
let body = el('presentedChoiceBody').innerHTML;
assert(/No presented report PDF is attached/.test(body), '2: says plainly that no PDF is attached');
assert(/Generate updated report/.test(body) && !/pcOpenBtn/.test(body), '2: offers only the updated report');
assert(el('presentedChoiceModal').classList.s.has('open'), '2: the choice window is open');
ev('_rptPresentedChoiceUpdated()');
assert(
  updated === 1 && !el('presentedChoiceModal').classList.s.has('open'),
  '2: "Generate updated report" runs the updated report and closes the window',
);

// an unrelated period is not gated
assert(
  ev("_rptPresentedChooser(7, ['2026-04','2026-05','2026-06'], 'Q2', _cb)") === false,
  '3: an unpresented period is not gated',
);
assert(
  ev('_rptPresentedChooser(8, ' + JSON.stringify(Q1) + ", 'Q1', _cb)") === false,
  '3: another project is not gated',
);

// attach
assert(
  ev('setPresentedPdf(7, ' + JSON.stringify(Q1) + ", 'en_pdf_shared_aaaaaaaaaaaaaaaa', 'q1.pdf')") === true,
  '4: PDF attached to the record',
);
let r = ev('getPresentedRecordFor(7, ' + JSON.stringify(Q1) + ')');
assert(
  r.pdfKey === 'en_pdf_shared_aaaaaaaaaaaaaaaa' && r.pdfName === 'q1.pdf',
  '4: key and file name stored on the record',
);
assert(r.totalDollars === 100 && r.buildings.b1.dollars === 100, '4: locked figures untouched by the attach');
assert(
  ev("setPresentedPdf(7, ['2026-04','2026-06'], 'x', 'x')") === false,
  '4: no record for the period -> nothing attached',
);

// default with a PDF attached: the presented report is the first choice
ev('_rptPresentedChooser(7, ' + JSON.stringify(Q1) + ", 'Q1 2026', _cb)");
body = el('presentedChoiceBody').innerHTML;
assert(
  /pcOpenBtn/.test(body) && body.indexOf('pcOpenBtn') < body.indexOf('pcUpdatedBtn'),
  '5: presented report is offered first (default)',
);
assert(/q1\.pdf/.test(body), '5: shows the attached file name');
assert(!/No presented report PDF/.test(body), '5: no "not attached" text');
let opened = null;
sb.rptOpenPresentedPdf = (p, y) => (opened = [p, y.join(',')]);
ev('_rptPresentedChoiceOpen()');
assert(
  opened && opened[0] === 7 && opened[1] === Q1.join(','),
  '5: the presented report button opens the stored PDF for that period',
);

// replace (user action) keeps figures
ev('setPresentedPdf(7, ' + JSON.stringify(Q1) + ", 'en_pdf_shared_bbbbbbbbbbbbbbbb', 'q1-v2.pdf')");
r = ev('getPresentedRecordFor(7, ' + JSON.stringify(Q1) + ')');
assert(r.pdfKey === 'en_pdf_shared_bbbbbbbbbbbbbbbb' && r.totalDollars === 100, '6: replace changes only the PDF');
assert(
  ev('removePresentedMark(7, ' + JSON.stringify(Q1) + ')') === true &&
    ev('getPresentedRecordFor(7, ' + JSON.stringify(Q1) + ')') === null,
  '6: removing the mark removes the record',
);

// one store path: bpaStoreBlob is the code bpaAttachFile uses; same key, stored once
(async () => {
  const mod = require(path.join(REPO, 'app', 'bill-pdf-attach.js'));
  const blobs = {};
  const deps = {
    hash: async (b) => 'ab12cd34ef56ab78' + b.length,
    load: async (k) => blobs[k] || null,
    store: async (k, b) => ((blobs[k] = b), true),
  };
  const a = await mod.bpaStoreBlob('JVBERi0=', deps);
  const b = await mod.bpaStoreBlob('JVBERi0=', deps);
  assert(
    a.key === 'en_pdf_shared_ab12cd34ef56ab78' && a.stored === true && b.stored === false,
    '7: blob stored once under en_pdf_shared_<hash16>',
  );
  const bills = [{}];
  const c = await mod.bpaAttachFile({ b64: 'JVBERi0=', bills, deps });
  assert(c.key === a.key && bills[0].pdfKey === a.key, '7: attaching to a bill uses the same store code and key');

  // wiring guards
  const prev = rd('app/report-preview.js');
  assert(
    /_rptPresentedChooser\(/.test(prev) && /opts && opts\.updated/.test(prev),
    '8: Generate Preview asks the chooser first for a presented period',
  );
  const ps = rd('app/presented-savings.js');
  assert(
    /bpaStoreBlob\(/.test(ps) && !/crypto\.subtle/.test(ps),
    '8: presented-savings reuses the bill PDF store code (no second copy)',
  );
  assert(/setPresentedPdf\(/.test(ps), '8: only the attach action writes the PDF key');

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
