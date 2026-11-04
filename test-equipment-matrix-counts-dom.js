// test-equipment-matrix-counts-dom.js
// DOM acceptance test for Equipment Matrix > Counts (item 6715c224), in a real headless browser against the real app code.
// Fixture: 100% SYNTHETIC equipment (3 air handlers, 2 exhaust fans, 1,200 VAV boxes, 2 lights, 1 phantom drive row) seeded
// through the app's own DB.set(). No real client data.
// Proves: the Counts button sits beside Summary; both tables render with totals, a hover title on every header, thousands
// separators and dashes where a column does not apply; the type total equals the building total equals the non-phantom rows;
// a count opens an inline list with the right number of rows and the evidence point; a name opens the detail panel; a
// building name drills into that building; no horizontal page scroll at 960 or 1600 wide.
// Browser: bundled Chromium, headless, unique profile under CH_TMP_ROOT (tools/launch-browser.js).
// Run: node test-equipment-matrix-counts-dom.js   (from the repo root)
const { launchBrowser } = require('./tools/launch-browser.js');

const REPO = __dirname;
const SITE_PATH = 'file:///' + REPO.replace(/\\/g, '/') + '/energy-department.html';
const SYNTH_PID = 999000333;

let pass = 0;
let fail = 0;
const failures = [];
function assertTrue(actual, label) {
  if (actual) pass++;
  else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) pass++;
  else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function buildMatrix() {
  const rows = [];
  function baseRow(bldg, name, category, points) {
    return {
      id: bldg + '||' + name,
      building: bldg,
      location: '',
      floor: '',
      area: '',
      equipName: name,
      equipType: name,
      category: category,
      subtype: '',
      points: points || {},
      pointsRaw: points || {},
      checks: {},
      schema: 2,
    };
  }
  const A = 'Synthetic Hall A';
  const B = 'Synthetic Hall B';
  rows.push(baseRow(A, 'SYN-AHU-1', 'ahu', { 'Supply Fan VFD Speed': '50 %', 'Supply Fan CFM': '10000', 'Zone CO2': '640', 'Zone Relative Humidity': '45' }));
  rows.push(baseRow(A, 'SYN-AHU-2', 'ahu', { 'Supply Fan Status': 'On', 'Supply Fan Amperage': '24.0 A' }));
  rows.push(baseRow(A, 'SYN-AHU-3', 'ahu', { 'Zone Temp': '70 F' }));
  rows.push(baseRow(B, 'SYN-EF-1', 'ef', { 'Exhaust Fan Status': 'On', 'Exhaust Fan Amperage': '9.0 A' }));
  rows.push(baseRow(B, 'SYN-EF-2', 'ef', { 'Exhaust Fan VFD Status': 'On' }));
  for (let i = 1; i <= 1200; i++) {
    rows.push(baseRow(B, 'SYN-VAV-' + i, 'vav', i <= 1000 ? { 'Zone Temp': '70 F', 'Zone CO2': '600', 'Air Flow': '295' } : { 'Zone Temp': '70 F', 'Air Flow': '295' }));
  }
  rows.push(baseRow(A, 'SYN Lights 1', 'lighting', { 'Lighting Status': 'On' }));
  rows.push(baseRow(A, 'SYN Lights 2', 'lighting', { 'Lighting Status': 'On' }));
  rows.push(baseRow(A, 'SYN-AHU-1 VFD Integration', 'controls', { 'VFD Speed': '50 %' })); // phantom row: never counted
  return { rows: rows, importedAt: new Date().toISOString(), buildings: [A, B], totalBASPoints: 0 };
}

(async () => {
  const matrix = buildMatrix();
  const EXPECT_TOTAL = matrix.rows.length - 1; // 1,207 (the phantom row is left out)
  const context = await launchBrowser('em-counts', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [{ id: SYNTH_PID, name: 'SYNTHETIC TEST PROJECT', client: 'Synthetic Test Client', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
      ch_settings: { showQuickStart: false },
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((data) => {
      for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
    }, seed);
    await page.goto(SITE_PATH);
    await page.waitForTimeout(2000);
    await page.evaluate(async ({ pid, m }) => { await window.DB.set('en_eqmatrix_' + pid, m); }, { pid: SYNTH_PID, m: matrix });
    await page.evaluate((pid) => {
      openDetail(pid);
      var btn = document.querySelector('.pdt[data-tab="eq-matrix"]');
      if (typeof sPTab === 'function') sPTab('eq-matrix', btn);
    }, SYNTH_PID);
    await page.waitForTimeout(2500);

    // the button sits beside Summary
    const order = await page.evaluate(() => {
      var s = document.getElementById('em-summary-btn');
      var c = document.getElementById('em-counts-btn');
      return { has: !!c, next: s && s.nextElementSibling ? s.nextElementSibling.id : '' };
    });
    assertTrue(order.has, 'Counts button exists');
    assertEqual(order.next, 'em-counts-btn', 'Counts button is right after Summary');

    await page.click('#em-counts-btn');
    await page.waitForSelector('#em-counts-type');
    const dump = () =>
      page.evaluate(() => {
        function table(id) {
          var t = document.getElementById(id);
          var rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()));
          var foot = Array.from(t.querySelectorAll('tfoot tr td')).map((td) => td.textContent.trim());
          var heads = Array.from(t.querySelectorAll('thead th')).map((th) => ({ text: th.textContent.trim(), title: th.getAttribute('title') }));
          return { rows: rows, foot: foot, heads: heads };
        }
        return { type: table('em-counts-type'), bldg: table('em-counts-bldg'), docW: document.documentElement.scrollWidth, winW: window.innerWidth };
      });
    let d = await dump();
    assertTrue(d.type.heads.length === 13 && d.type.heads.every((h) => h.title && h.title.length > 10), 'every header has hover text (type table)');
    assertTrue(d.bldg.heads.every((h) => h.title && h.title.length > 10), 'every header has hover text (building table)');
    assertTrue(/equipment, not .*motors|Not a count of motors/i.test(d.type.heads.map((h) => h.title).join(' ')), 'hover text says it counts equipment, not motors');
    assertEqual(d.type.foot[1], '1,207', 'type total = non-phantom rows, with thousands separator');
    assertEqual(d.bldg.foot[1], '1,207', 'building total = non-phantom rows');
    const ahu = d.type.rows.find((r) => /Air Handling/.test(r[0]));
    // Equipment, Variable, Single, Not known, CO2 yes, no, Humidity yes, no, HP
    assertEqual(ahu.slice(1, 9).join('|'), '3|1|1|1|1|2|1|2', 'air handling row: 3 units, 1/1/1 motor speed, CO2 1/2, humidity 1/2');
    assertTrue(/^~\d/.test(ahu[9]), 'air handling row has an estimated HP (~ prefix)');
    const vav = d.type.rows.find((r) => /Variable Air Volume/.test(r[0]));
    assertEqual(vav.slice(1, 9).join('|'), '1,200|—|—|—|1,000|200|0|1,200', 'VAV row: thousands separators, dashes for motor speed, CO2 1,000 / 200');
    assertEqual(vav[9], '—', 'VAV has a dash for HP');
    const lights = d.type.rows.find((r) => /Lighting/.test(r[0]));
    assertEqual(lights.slice(2).join('|'), ['—', '—', '—', '—', '—', '—', '—', '—'].join('|'), 'lighting: dashes everywhere but the count');
    assertTrue(d.bldg.rows.length === 2 && d.bldg.foot[0].indexOf('2 buildings') >= 0, 'building table: 2 rows and a totals row');
    assertTrue(d.docW <= d.winW, 'no horizontal page scroll at 1600 (' + d.docW + ' vs ' + d.winW + ')');

    // a count opens an inline list
    await page.click('#em-counts-type tbody tr:first-child td:nth-child(2) a');
    await page.waitForSelector('[data-em-counts-listbox]');
    let list = await page.evaluate(() => {
      var box = document.querySelector('[data-em-counts-listbox]');
      return { rows: box.querySelectorAll('tbody tr').length, head: box.firstChild.textContent, firstEvidence: box.querySelector('tbody tr td:last-child').textContent };
    });
    assertTrue(list.rows >= 1, 'inline list opened with rows');
    // the variable speed AHU count lists exactly 1 unit and names the drive point
    await page.click('[data-em-counts-close]');
    await page.evaluate(() => { var t = document.getElementById('em-counts-type'); var tr = Array.from(t.querySelectorAll('tbody tr')).find((r) => /Air Handling/.test(r.children[0].textContent)); tr.children[2].querySelector('a').click(); });
    await page.waitForSelector('[data-em-counts-listbox]');
    list = await page.evaluate(() => {
      var box = document.querySelector('[data-em-counts-listbox]');
      return { rows: box.querySelectorAll('tbody tr').length, ev: box.querySelector('tbody tr td:last-child').textContent, name: box.querySelector('tbody tr td:nth-child(2)').textContent };
    });
    assertEqual(list.rows, 1, 'variable speed list: 1 unit');
    assertEqual(list.ev, 'Supply Fan VFD Speed', 'variable speed list: shows the point that proves it');
    assertEqual(list.name, 'SYN-AHU-1', 'variable speed list: the unit');

    // a name opens the existing detail panel
    await page.click('[data-em-counts-listbox] [data-em-detail-row]');
    await page.waitForTimeout(800);
    const panel = await page.evaluate(() => {
      var p = document.getElementById('em-compliance-detail-panel');
      return !!p && p.offsetWidth > 0 && /SYN-AHU-1/.test(p.textContent);
    });
    assertTrue(panel, 'clicking a name opens the equipment detail panel');

    // clicking a building shows that building in the type table
    await page.evaluate(() => emCloseComplianceDetail());
    await page.evaluate(() => { var a = Array.from(document.querySelectorAll('#em-counts-bldg a[data-em-counts-bldg]')).find((x) => /Hall A/.test(x.textContent)); a.click(); });
    await page.waitForTimeout(500);
    d = await dump();
    assertEqual(d.type.foot[1], '5', 'drill into Hall A: type table total = 5 (3 air handlers + 2 lights)');
    assertEqual(d.bldg.foot[1], '1,207', 'drill into Hall A: building table still shows every building');
    assertEqual(await page.evaluate(() => document.getElementById('em-filter-bldg').value), 'Synthetic Hall A', 'drill sets the building filter');

    // narrow window: no horizontal page scroll
    await page.setViewportSize({ width: 960, height: 800 });
    await page.waitForTimeout(400);
    d = await dump();
    assertTrue(d.docW <= d.winW, 'no horizontal page scroll at 960 (' + d.docW + ' vs ' + d.winW + ')');

    // toggling the button again returns to the audit view
    await page.click('#em-counts-btn');
    await page.waitForTimeout(800);
    assertTrue(await page.evaluate(() => !document.getElementById('em-counts-type')), 'clicking Counts again leaves the view');
  } finally {
    await context.close();
  }
  console.log('test-equipment-matrix-counts-dom: ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
