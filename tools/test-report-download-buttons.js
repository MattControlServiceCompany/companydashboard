/**
 * test-report-download-buttons.js
 *
 * Every report and document export has two one-click buttons, Download Word (.docx) and Download PDF, and never a print dialog.
 * Opens a SYNTHETIC quarterly report in the preview (toolbar #rptPreviewToolbar) and in the overlay
 * (#reportOverlay toolbar), clicks both buttons in each, and asserts: a .docx download (zip) and a .pdf
 * download (%PDF), the toolbars have no Print button, window.print is never called, no dialog opens.
 * Headless bundled Chromium (never Edge). Network to supabase/netlify is blocked.
 *
 * Usage: node tools/test-report-download-buttons.js   (env APP_ROOT=<checkout> to test another tree)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('report-download-buttons', { acceptDownloads: true });
  const tmp = require('./tmp-root').mkTmpDir('rpt-dl-buttons-');
  try {
    const page = await ctx.newPage();
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      d.dismiss();
    });
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.addInitScript(() => {
      window.__printCalls = 0;
      window.print = () => {
        window.__printCalls++;
      };
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const login = document.getElementById('loginScreen');
      if (login) login.remove();
      const mon = (ym, sav) => ({ month: ym, blCost: 1111, curCost: 1111 - sav, savings: sav, kwhBl: 111, kwhCur: 121 });
      const com = () => ({
        monthly: [mon('2026-07', 11), mon('2026-08', 101), mon('2026-09', 111)],
        kwhBl: 1111, kwhCur: 1211, kwBl: 111, kwCur: 121, thermsBl: 1011, thermsCur: 1101, galBl: 0, galCur: 0,
        costSaved: 1111, kwCostSaved: 111,
      });
      const bld = (name) => ({
        id: name, name, sqft: 110000, status: 'ok', savings: 1111, savingsPct: 11.1, blCost: 11111,
        electric: com(), gas: com(), propane: null, eui: { baseline: 41.1, current: 31.1, cbecs: 51.1 }, meterDetails: [],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
        project: { client: 'Test Client', name: 'Test Project', sqft: 220000, blStart: '2024-01', blEnd: '2024-12' },
        contract: { quarterlyTargets: [1111, 1111, 1111, 1111], quarterlyActuals: [1111, 1111, 1111], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3, actualsThroughQuarter: 3 },
        totals: { savings: 2222, blCost: 22222, kwhBl: 2222, kwhCur: 2422, thermsBl: 2022, thermsCur: 2202, peakKwBl: 222, peakKwCur: 242, euiBaseline: 41.1, euiCurrent: 31.1, euiPeriodLabel: 'Jan 2026 to Sep 2026 annualized, all fuels', weatherWaiting: [] },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [],
      };
      const html = _rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false, buildingSummaries: false, electricDetail: false, gasDetail: false, propaneDetail: false, yearToDate: false, appendixB: false, appendixC: false });
      window._currentReportData = d;
      window.__testHtml = html;
      window.__testD = d;
    });

    async function clickAndCheck(scope, selector, label, ext, magic) {
      const btn = page.locator(selector, { hasText: label });
      ok((await btn.count()) === 1, scope + ': exactly one "' + label + '" button');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), btn.click()]);
      const f = path.join(tmp, scope + '-' + dl.suggestedFilename());
      await dl.saveAs(f);
      const head = fs.readFileSync(f).subarray(0, 4).toString('latin1');
      ok(dl.suggestedFilename().endsWith(ext), scope + ': ' + label + ' saves a ' + ext + ' file (' + dl.suggestedFilename() + ')');
      ok(head.startsWith(magic), scope + ': ' + label + ' file starts with ' + magic);
      ok(fs.statSync(f).size > 2000, scope + ': ' + label + ' file is not empty');
    }

    // 1. Preview toolbar (Quarterly / Annual / Cumulative / Custom reports)
    await page.evaluate(() => {
      _showPreview({ reportType: 'quarterly', clientName: 'Test Client', periodLabel: 'Q3 2026' }, window.__testHtml);
    });
    await page.waitForTimeout(500);
    const tb = '#rptPreviewToolbar button';
    ok((await page.locator(tb, { hasText: /^\s*Print\s*$/ }).count()) === 0, 'preview: no Print button');
    await clickAndCheck('preview', tb, 'Download Word', '.docx', 'PK');
    await clickAndCheck('preview', tb, 'Download PDF', '.pdf', '%PDF');
    await page.evaluate(() => {
      document.getElementById('reportPreviewContainer').style.display = 'none';
    });

    // 2. Overlay toolbar (every other report; Report History re-opens saved reports here too)
    await page.evaluate(() => {
      window._currentReportData = window.__testD;
      showReportOverlay(window.__testHtml, 'Test report');
    });
    await page.waitForTimeout(500);
    const ob = '#reportOverlay .rpt-toolbar-btn';
    ok((await page.locator(ob, { hasText: /Print/ }).count()) === 0, 'overlay: no Print button');
    await clickAndCheck('overlay', ob, 'Download Word', '.docx', 'PK');
    await clickAndCheck('overlay', ob, 'Download PDF', '.pdf', '%PDF');

    // 3. Documents that are not reports: meeting agenda/minutes, scorecard, HVAC load. SYNTHETIC data.
    async function download(clickFn, scope) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), clickFn()]);
      const f = path.join(tmp, scope + '-' + dl.suggestedFilename());
      await dl.saveAs(f);
      await page.waitForFunction(() => !window._scorecardBusy && !window._rptPdfBusy); // the next click is ignored while an export runs
      return { name: dl.suggestedFilename(), file: f, head: fs.readFileSync(f).subarray(0, 4).toString('latin1') };
    }
    // Text inside the .docx (word/document.xml), read with the page's own JSZip.
    async function docxInfo(f) {
      const b64 = fs.readFileSync(f).toString('base64');
      return page.evaluate(async (data) => {
        const z = await JSZip.loadAsync(data, { base64: true });
        const xml = await z.file('word/document.xml').async('string');
        const names = Object.keys(z.files);
        return {
          text: xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''),
          hasLetterhead: names.some((n) => /^word\/header\d*\.xml$/.test(n)) && names.some((n) => /^word\/media\//.test(n)),
          gaugePictures: names.filter((n) => /^word\/media\/image1\d\d\.png$/.test(n)).length,
        };
      }, b64);
    }
    await page.evaluate(() => {
      document.getElementById('reportOverlay').style.display = 'none';
      const qs = document.getElementById('qsOverlay');
      if (qs) qs.remove();
      document.getElementById('app').classList.add('visible');
      projects.push({
        id: 9001,
        client: 'Test District',
        name: 'Test District',
        contacts: [],
        meetings: [
          {
            id: 77,
            type: 'agenda',
            date: '2026-03-03T10:00',
            projectNickname: 'Test District',
            sectionHeading: 'Energy Management Services Program',
            contactTables: [{ label: 'Test Key Contacts', contacts: [{ name: 'Pat Example', phone: '555-0101', email: 'pat@example.test' }] }],
            topics: [{ text: 'Review test bills', subItems: ['First sub item', 'Second sub item'] }, { text: 'Closing question', subItems: [] }],
            history: [],
          },
        ],
        recurringMeetings: [],
      });
      openMeetingEditor(9001, 77);
    });
    await page.waitForTimeout(500);
    const mb = '#meetingModal button';
    ok((await page.locator(mb, { hasText: /^\s*(📄 )?PDF\s*$/ }).count()) === 0, 'meeting modal: the old "PDF" button is gone');
    // Headless Chromium has no PDF viewer, so the editor's blob: preview iframe shows up as a download named
    // <uuid>.pdf. Let the debounced preview render finish (blob src set, timer past) BEFORE each click, so the only
    // download left is the one the click makes. That download must carry the meetingFileName name.
    const settlePreview = async () => {
      await page.waitForFunction(() => /^blob:/.test((document.getElementById('mtgPreviewFrame') || {}).src || ''));
      await page.waitForTimeout(1500);
    };
    await settlePreview();
    const mw = await download(() => page.locator(mb, { hasText: 'Download Word' }).click(), 'meeting');
    await settlePreview();
    const mp = await download(() => page.locator(mb, { hasText: 'Download PDF' }).click(), 'meeting');
    const mname = await page.evaluate(() => [meetingFileName(_editingMeeting, '.docx'), meetingFileName(_editingMeeting, '.pdf')]);
    ok(mw.head.startsWith('PK') && mw.name === mname[0], 'meeting: Download Word saves ' + mw.name);
    ok(mp.head.startsWith('%PDF') && mp.name === mname[1], 'meeting: Download PDF saves ' + mp.name + ' (same name, one helper)');
    const mt = await docxInfo(mw.file);
    ['Test District', 'Meeting Agenda', 'Meeting Date', 'Test Key Contacts', 'Pat Example', '555-0101', 'pat@example.test', 'Review test bills', 'First sub item', 'Second sub item', 'Closing question'].forEach((t) => {
      ok(mt.text.includes(t), 'meeting .docx contains "' + t + '"');
    });
    ok(mt.text.includes('Meeting Date: Tuesday March 3rd, 2026 10 AM'), 'meeting .docx date line reads "Tuesday March 3rd, 2026 10 AM" (' + (mt.text.match(/Meeting Date:.{0,45}/) || [''])[0] + ')');
    ok(mt.hasLetterhead, 'meeting .docx has the CSC letterhead (header part + picture)');
    await page.evaluate(() => closeMeetingModal());
    // Minutes: same two buttons, same helper names
    await page.evaluate(() => {
      projects.find((x) => x.id === 9001).meetings.push({ id: 78, type: 'minutes', date: '2026-03-03T10:00', projectNickname: 'Test District', sectionHeading: 'Energy Management Services Program', contactTables: [], topics: [{ text: 'Minutes topic', subItems: [] }], history: [] });
      openMeetingEditor(9001, 78);
    });
    await settlePreview();
    const nw = await download(() => page.locator(mb, { hasText: 'Download Word' }).click(), 'minutes');
    await settlePreview();
    const np = await download(() => page.locator(mb, { hasText: 'Download PDF' }).click(), 'minutes');
    const nname = await page.evaluate(() => [meetingFileName(_editingMeeting, '.docx'), meetingFileName(_editingMeeting, '.pdf')]);
    ok(/Minutes/.test(nname[1]) && nw.name === nname[0] && np.name === nname[1] && np.head.startsWith('%PDF') && nw.head.startsWith('PK'), 'minutes: Word and PDF save ' + nw.name + ' / ' + np.name);
    await page.evaluate(() => closeMeetingModal());
    // list-row icons: Word + PDF for meetings and for saved reports
    const rows = await page.evaluate(() => {
      DB.set('en_report_history', [{ id: 'r1', projectId: 9001, projectName: 'Test District', type: 'quarterly', period: 'Q1 2026', savedAt: '2026-01-02T10:00:00Z', html: '<div class="rpt-page">x</div>' }]);
      const host = document.createElement('div');
      document.body.appendChild(host);
      _renderDocsMeetings(host, 9001);
      renderMeetingsList(9001);
      return [...host.querySelectorAll('.mtg-actions')].map((a) => [...a.querySelectorAll('button')].map((b) => b.title));
    });
    ok(rows.some((r) => r.includes('Download Word') && r.includes('Download PDF') && r.includes('Convert to Minutes')), 'meeting row: Word and PDF icons');
    ok(rows.some((r) => r.includes('Open') && r.includes('Download Word') && r.includes('Download PDF')), 'saved-report row: Word and PDF icons');

    // Scorecard
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'testScHost';
      document.body.appendChild(host);
      renderBuildingScorecardPane(host, { id: 'bx', name: 'Test Building', sqft: 50000, meters: [] }, 9001);
    });
    const sb = '#testScHost button';
    ok((await page.locator(sb, { hasText: /Print/ }).count()) === 0, 'scorecard: no Print button');
    const sw = await download(() => page.locator(sb, { hasText: 'Download Word' }).click(), 'scorecard');
    const sp = await download(() => page.locator(sb, { hasText: 'Download PDF' }).click(), 'scorecard');
    ok(sw.head.startsWith('PK') && /^Test Building - Building Scorecard .*\.docx$/.test(sw.name), 'scorecard: Download Word saves ' + sw.name);
    ok(sp.head.startsWith('%PDF') && /^Test Building - Building Scorecard .*\.pdf$/.test(sp.name), 'scorecard: Download PDF saves ' + sp.name);
    const st = await docxInfo(sw.file);
    ok(st.text.includes('Test Building') && !st.text.includes('Download Word'), 'scorecard .docx has the building name and not the buttons');
    ok(st.gaugePictures >= 4, 'scorecard .docx carries the gauges as pictures (' + st.gaugePictures + ')');
    ok(await page.evaluate(() => !document.querySelector('#testScHost .sc-root').classList.contains('sc-export')), 'scorecard: export look removed after the download');

    // HVAC load: Word is .docx now (data stubbed; the file goes through the shared docx path)
    await page.evaluate(() => {
      window._hvlExportGuard = () => ({ buildingName: 'Test Building' });
      window._hvlExportBodyHtml = () =>
        '<h1>HVAC Load Estimation</h1><table class="hvl-x-meta"><tr><td>Building</td><td>Test Building</td></tr></table><h2>Summary</h2><table class="hvl-x-tbl"><tr><th>Annual Total</th><th>Total</th></tr><tr><td>Electricity (kWh)</td><td>1,111</td></tr></table>';
    });
    const hw = await download(() => page.evaluate(() => hvacLoadExportWord(1)), 'hvac');
    ok(hw.head.startsWith('PK') && hw.name === 'HVAC Load Estimation - Test Building.docx', 'hvac: Word saves ' + hw.name + ' (.docx, not .doc)');
    const ht = await docxInfo(hw.file);
    ['HVAC Load Estimation', 'Summary', 'Annual Total', 'Electricity (kWh)', '1,111'].forEach((t) => ok(ht.text.includes(t), 'hvac .docx contains "' + t + '"'));
    ok(ht.hasLetterhead, 'hvac .docx has the CSC letterhead');
    const hp = await download(() => page.evaluate(() => hvacLoadExportPdf(1)), 'hvac');
    ok(hp.head.startsWith('%PDF') && hp.name === 'HVAC Load Estimation - Test Building.pdf', 'hvac: PDF saves ' + hp.name);

    // The old .doc (mso HTML) report exporter is gone
    ok(await page.evaluate(() => typeof exportReportToWord === 'undefined'), 'exportReportToWord (.doc) is deleted');

    ok(dialogs === 0, 'no dialog opened (' + dialogs + ')');
    const prints = await page.evaluate(() => window.__printCalls);
    ok(prints === 0, 'window.print never called (' + prints + ')');
  } finally {
    await ctx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails ? '=== FAILED: ' + fails + ' ===' : '=== report download buttons: all passed ===');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
