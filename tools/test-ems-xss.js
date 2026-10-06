/**
 * test-ems-xss.js
 *
 * Regression test: synced EMS Leads data (ems_leads_v1, ems_field_defs, ems_client_types) must never
 * execute script or create elements when rendered in ems-leads.html and energy-department.html.
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), unique C:\Temp profile, file:// pages.
 *
 * Usage: node tools/test-ems-xss.js   (env APP_ROOT=<checkout> to test another tree)
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
let launchBrowser;
try {
  ({ launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js')));
} catch (e) {
  console.log('FAIL cannot load launcher: ' + e.message);
  process.exit(1);
}

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

const P1 = '<img src=x onerror=alert(1)>';
const P2 = '"><script>window.__xss=(window.__xss||0)+1</script>';
const P3 = '" autofocus onfocus="window.__xss=(window.__xss||0)+1" x="';
const P4 = "');window.__xss=(window.__xss||0)+1;//";
const P5 = '<svg onload=window.__xss=1>';
const mix = (n) => [P1, P2, P3, P4, P5][n % 5];

const lead = {
  id: P4,
  company: P1,
  cscContact: P2,
  city: P1,
  state: P2,
  address: P3,
  buildingType: P1,
  type: P2,
  clientType: P1,
  stage: 'Lead',
  priority: P3,
  nextAction: P1,
  nextActionDate: '2020-01-01',
  tags: [P1, P2],
  annualValue: P1,
  saNum: P1,
  webctrlVersion: P2,
  renewalDate: P1,
  lastContact: P2,
  notes: P1,
  [P1]: P2,
  buildings: [{ id: P4, name: P1, address: P2, city: P3, state: P1, zip: P2, sqft: P3, buildingType: P1, notes: P2 }],
  activity: [{ text: P1, time: P2, user: P3, color: P4 }],
};
const SEED = {
  ems_leads_v1: [lead],
  ems_field_defs: {
    labels: { company: P1 },
    custom: [
      { key: '"></option></select><img src=x onerror=alert(1)>', label: P1 },
      { key: P3, label: P2 },
    ],
  },
  ems_client_types: [P1, P2, P3],
};

(async () => {
  for (const file of ['ems-leads.html', 'energy-department.html']) {
    const context = await launchBrowser('ems-xss');
    try {
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        d.dismiss().catch(() => {});
      });
      await page.addInitScript((seed) => {
        window.__xss = 0;
        try {
          Object.keys(seed).forEach((k) => localStorage.setItem(k, JSON.stringify(seed[k])));
        } catch (e) {}
      }, SEED);
      await page.goto(pathToFileURL(path.join(ROOT, file)).href);
      await page.waitForTimeout(2500);
      // Render every view that reads lead data.
      await page.evaluate((payloadId) => {
        const tryCall = (n, ...a) => {
          try {
            if (typeof window[n] === 'function') window[n](...a);
          } catch (e) {}
        };
        ['renderAll', 'renderTable', 'renderFollowups', 'renderAnalytics', 'renderPipeline'].forEach((n) => tryCall(n));
        tryCall('openDrawer', payloadId);
        tryCall('emsOpenDrawer', payloadId);
        // energy-department keeps its renderers private; click every tab-like button that mentions leads views.
        document.querySelectorAll('[onclick*="ems"],[data-ems-view]').forEach((el) => {
          try {
            const oc = el.getAttribute('onclick') || '';
            if (/emsSwitch|emsView|emsTab|showEms/i.test(oc)) el.click();
          } catch (e) {}
        });
      }, P4);
      await page.waitForTimeout(1500);
      // CSV mapper: paste a CSV so the field-def options (key + label) are rendered.
      await page.evaluate(() => {
        const ta = document.getElementById('emsCsvPaste') || document.getElementById('csvPaste');
        if (!ta) return;
        ta.value = 'Company,City,Notes\nAcme,Town,hi';
        const fn = window.emsParseCSVPreview || window.parseCSVPreview;
        try {
          if (fn) fn();
        } catch (e) {}
      });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const leadCards = document.querySelectorAll('.lead-card, #tableBody tr, #emsTableBody tr').length;
        return {
          xss: window.__xss,
          img: document.querySelectorAll('img[src="x"]').length,
          svgOnload: document.querySelectorAll('svg[onload]').length,
          onerror: document.querySelectorAll('[onerror]').length,
          onfocus: document.querySelectorAll('[onfocus]').length,
          autofocus: document.querySelectorAll('[autofocus]').length,
          injectedScripts: Array.from(document.scripts).filter((s) => /__xss/.test(s.textContent)).length,
          leadCards,
          mapSelects: document.querySelectorAll('#emsMapBody select, #mapBody select').length,
          rendered: document.body.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'),
        };
      });
      console.log(file, JSON.stringify(r), 'dialogs=' + dialogs.length);
      ok(r.xss === 0, file + ': no injected script ran');
      ok(dialogs.length === 0, file + ': no alert/dialog fired');
      ok(r.img === 0, file + ': no <img src=x> element created');
      ok(r.svgOnload === 0 && r.onerror === 0, file + ': no onerror/onload element created');
      ok(r.onfocus === 0 && r.autofocus === 0, file + ': no attribute breakout (onfocus/autofocus)');
      ok(r.injectedScripts === 0, file + ': no injected <script> element');
      ok(r.mapSelects > 0, file + ': CSV mapper rendered (selects=' + r.mapSelects + ')');
      ok(r.leadCards > 0 && r.rendered, file + ': payload lead rendered as escaped text (cards=' + r.leadCards + ')');
    } finally {
      await context.close();
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL crash: ' + e.stack);
  process.exit(1);
});
