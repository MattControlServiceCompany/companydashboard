/**
 * test-pdf-view-after-reload.js
 * Gate: after a page reload, the extraction page must show the View PDF button and open the PDF dock,
 * for a single multi-bill file (tabs) and for a batch queue. If the stored PDF is gone, the page must
 * show the values and NO viewer button. SYNTHETIC PDF and bills only. Headless bundled Chromium.
 * Usage: node tools/test-pdf-view-after-reload.js   (env APP_ROOT=<checkout>)
 */
const path = require('path');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const APP_URL = 'file:///' + ROOT.split(path.sep).join('/') + '/energy-department.html';

function makePdf(pages) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = [];
  for (let i = 0; i < pages; i++) kids.push(3 + i * 2 + ' 0 R');
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  for (let i = 0; i < pages; i++) {
    const ops = `BT /F1 40 Tf 50 700 Td (SYNTHETIC PAGE ${i + 1}) Tj ET`;
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`;
    objs[4 + i * 2] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  objs[3 + pages * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offs = [];
  const n = 3 + pages * 2;
  for (let i = 1; i <= n; i++) {
    offs[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xr = pdf.length;
  pdf += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) pdf += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const mk = (n) => ({
  UtilityCompany: 'Synthetic Utility', BillFormat: 'new', CustomerName: 'SYNTH', AccountNumber: 'TEST-1',
  ServiceAddress: '1 TEST ST', BillingPeriodStart: n + '/1/2026', BillingPeriodEnd: n + '/28/2026',
  Commodity: 'Gas', _pageIndex: n, _warnings: [],
});

// Seed state the way extraction does: keep the PDF with the app's own store function, then save state.
async function seed(page, mode, b64) {
  await page.evaluate(
    async ({ mode, b64, bills }) => {
      sv('pdf', null);
      await new Promise((r) => setTimeout(r, 400));
      const key = typeof _storeExtractionPdf === 'function' ? await _storeExtractionPdf(b64) : null;
      if (mode === 'single') {
        pdfB64 = b64;
        window._pdfSrcKey = key;
        window._pdfMultiBills = bills;
        window._pdfMultiIdx = 0;
        window._pdfBillWarnings = bills.map(() => ({ warnings: [] }));
        renderMultiBillUI(bills, document.getElementById('pdfAIBox'));
        if (typeof _showExtractionToolbar === 'function') _showExtractionToolbar();
        else document.getElementById('pdfViewBtn').style.display = 'inline-block';
      } else {
        window._pdfQueue = {
          files: [{ name: 'synthetic.pdf' }],
          results: [{ fileIdx: 0, fileName: 'synthetic.pdf', bills, pdfB64: b64, pdfKey: key, status: 'ok', error: null }],
          currentIdx: 1, status: 'done', _processedCount: 1, _activeFileIdx: 0,
        };
        renderQueueResults();
      }
      _saveExtractionState();
    },
    { mode, b64, bills: [mk(1), mk(2), mk(3)] },
  );
}

const probe = (page) =>
  page.evaluate(async () => {
    const btn = document.getElementById('pdfViewBtn');
    const view = btn && getComputedStyle(btn).display !== 'none' && btn.getBoundingClientRect().width > 0;
    const tabs = document.querySelectorAll('.ef-pill-btn').length;
    let dock = false;
    if (view) {
      localStorage.setItem('ch_pdf_side_by_side', '1');
      if (_pdfDock.open) closePdfDock();
      await viewCurrentExtractionPDF();
      await new Promise((r) => setTimeout(r, 800));
      dock = _pdfDock.open === true && !!document.querySelector('#pdfDockBody iframe, #pdfDockBody embed, #pdfDockBody object');
    }
    return { view: !!view, dock, tabs, values: document.body.innerText.includes('TEST-1') };
  });

async function reloadAndWait(page) {
  await page.reload();
  await page.waitForTimeout(3500);
}

(async () => {
  const ctx = await launchBrowser('pdf-view-after-reload');
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR ' + e.message));
    await ctx.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    });
    const b64 = makePdf(4);
    for (const mode of ['single', 'queue']) {
      await page.goto(APP_URL);
      await page.waitForTimeout(3000);
      await seed(page, mode, b64);
      await reloadAndWait(page);
      const r = await probe(page);
      ok(r.values, mode + ': extracted values shown after reload');
      ok(r.view, mode + ': View PDF button visible after reload');
      ok(r.dock, mode + ': dock iframe shows the PDF after reload');
      if (mode === 'single') ok(r.tabs > 1, 'single (multi-bill): bill tabs present (' + r.tabs + ')');
    }
    // Stored PDF gone: values shown, no viewer button, no error.
    for (const mode of ['single', 'queue']) {
      await page.goto(APP_URL);
      await page.waitForTimeout(3000);
      await seed(page, mode, b64);
      await page.evaluate(async () => {
        const k = window._pdfSrcKey || (window._pdfQueue && window._pdfQueue.results[0].pdfKey);
        if (k && typeof pdfDelete === 'function') await pdfDelete(k);
      });
      await reloadAndWait(page);
      const r = await probe(page);
      ok(r.values, mode + ' (PDF missing): extracted values still shown');
      ok(!r.view, mode + ' (PDF missing): no View PDF button');
    }
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
