// Real-browser test (headless bundled Chromium, file://, no real data): the first-visit Quick Start guide
// must NOT open over the sign-in screen, must open once after sign-in, and must not open on a second visit.
// Run: node test-quickstart-after-signin.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
let pass = 0;
let fail = 0;
function eq(a, b, l) {
  if (a === b) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + b + ', got ' + a);
  }
}
const state = () => ({
  open: document.getElementById('qsOverlay').classList.contains('open'),
  seen: localStorage.getItem('ch_qs_seen'),
  app: document.getElementById('app').classList.contains('visible'),
});
const USER = { name: 'Test User', email: 'test@example.com', initials: 'TU', isReal: false };
(async () => {
  let ctx;
  try {
    ctx = await launchBrowser('qs-signin', { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Fetch API cannot load file:/.test(m.text()) && errs.push(m.text()));
    // 1. signed out: no modal, flag untouched
    await page.goto(SITE);
    await page.waitForTimeout(2200);
    let s = await page.evaluate(state);
    eq(s.app, false, 'signed out: app hidden');
    eq(s.open, false, 'signed out: no Quick Start modal');
    eq(s.seen, null, 'signed out: ch_qs_seen not set');
    // 2. sign in: one modal, flag set
    await page.evaluate((u) => {
      sessionStorage.setItem('ch_user', JSON.stringify(u));
      currentUser = u;
      enterApp();
    }, USER);
    await page.waitForTimeout(1800);
    s = await page.evaluate(state);
    eq(s.app, true, 'after sign-in: app visible');
    eq(s.open, true, 'after sign-in: Quick Start modal open');
    eq(s.seen, '1', 'after sign-in: ch_qs_seen set');
    eq(await page.evaluate(() => document.querySelectorAll('#qsOverlay.open').length), 1, 'exactly one modal');
    // 3. second visit (already signed in, seen=1): none
    await page.reload();
    await page.waitForTimeout(2500);
    s = await page.evaluate(state);
    eq(s.app, true, 'second visit: signed in');
    eq(s.open, false, 'second visit: no Quick Start modal');
    // 4. first visit already signed in: opens once by the timer
    await page.evaluate(() => localStorage.removeItem('ch_qs_seen'));
    await page.reload();
    await page.waitForTimeout(2500);
    s = await page.evaluate(state);
    eq(s.open, true, 'signed-in first visit: modal opens');
    eq(s.seen, '1', 'signed-in first visit: flag set');
    eq(errs.length, 0, 'no console errors: ' + errs.join(' | '));
  } finally {
    if (ctx) await ctx.close();
  }
  console.log('quickstart-after-signin: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
