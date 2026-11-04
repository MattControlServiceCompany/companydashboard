// Real-browser test (synthetic data, headless Chromium, file://): the sidebar shows the department label ("Energy");
// the header has no #hdrDeptTab; the department name shows once across sidebar + header; the pin button stays.
// Run: node test-sidebar-no-duplicate-dept-label.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
(async () => {
  const ctx = await launchBrowser('sbdup', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await ctx.newPage();
    await ctx.addInitScript(() => {
      var d = {
        en_projects: [],
        ch_settings: { showQuickStart: false },
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      };
      for (var k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
    });
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar');
      const pin = document.querySelector('.sidebar .sb-pin-btn, .sb-pin-btn');
      const hdr = document.querySelector('.topbar');
      const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
      const leaf = (root, re) => [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && re.test(e.textContent.trim()));
      return {
        sidebarLabels: leaf(sb, /^energy$/i).filter(vis).length,
        hdrDeptTab: !!document.getElementById('hdrDeptTab'),
        hdrNameCount: leaf(hdr, /^energy( department)?$/i).length,
        pinVisible: vis(pin),
      };
    });
    eq(r.sidebarLabels, 1, 'sidebar shows the department label once');
    eq(r.hdrDeptTab, false, '#hdrDeptTab does not exist');
    eq(r.hdrNameCount, 0, 'header has no department name');
    eq(r.pinVisible, true, 'pin button visible');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
