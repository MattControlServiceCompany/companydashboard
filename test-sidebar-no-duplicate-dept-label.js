// Real-browser test (synthetic data, headless Chromium, file://): the sidebar must not repeat the department name
// (no "ENERGY" header text); the pin button stays; the top bar #hdrDeptTab shows "Energy Department".
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
      const hdr = document.getElementById('hdrDeptTab');
      const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
      return {
        sidebarHasEnergyHeader: [...sb.querySelectorAll('*')].some(
          (e) => e.children.length === 0 && e.textContent.trim().toLowerCase() === 'energy',
        ),
        pinVisible: vis(pin),
        hdr: hdr ? hdr.textContent.trim() : null,
      };
    });
    eq(r.sidebarHasEnergyHeader, false, 'sidebar has no ENERGY header text');
    eq(r.pinVisible, true, 'pin button visible');
    eq(r.hdr, 'Energy Department', '#hdrDeptTab text');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
