// test-save-all-selected.js — Save All depends only on SELECTED bills (synthetic data, headless Chromium).
// 4 bills, 2 held for review. All selected: Save All off, reason names the 2 bills. The 2 unchecked: on, saves exactly the other 2.
// The Save All state is the review bar's (_mbReviewSummary); the Create button is in the bill's box (_mbBillBoxHtml).
const { launchBrowser } = require('./launch-browser.js');
const REPO = require('path').resolve(__dirname, '..');
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));

(async () => {
  const context = await launchBrowser('save-all-selected');
  try {
    const page = await context.newPage();
    await context.addInitScript(() => {
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false }));
      localStorage.setItem(
        'ch_user',
        JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false }),
      );
    });
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(async () => {
      const out = {};
      const mk = (n, gate) => ({
        ServiceAddress: 'Synth Bldg ' + n,
        AccountNumber: 'A' + n,
        BillingPeriodStart: '2026-0' + n + '-01',
        BillingPeriodEnd: '2026-0' + n + '-28',
        _gateTripped: gate,
        _gateReasons: gate ? ['sum mismatch'] : [],
      });
      window._pdfMultiBills = [mk(1, false), mk(2, true), mk(3, false), mk(4, true), mk(5, false)];
      window._pdfDupMap = {};
      _mbRowTargets = {};
      _mbRowState = {};
      for (let i = 0; i < 4; i++) {
        _mbRowTargets[i] = { meter: { id: 'm' + i }, proj: { name: 'P' }, bldg: { name: 'B' }, matchType: 'identity' };
        _mbRowState[i] = { checked: true, skipped: false };
      }
      _mbRowTargets[4] = null; // no meter match: starts unchecked
      _mbRowState[4] = { checked: false, skipped: false };
      _mbInitFor = window._pdfMultiBills; // the review state above belongs to this file
      _mbRowOrder = {};
      let sum = _mbReviewSummary();
      out.allDisabled = sum.disabled;
      out.allTitle = sum.title;
      _mbToggleRowChecked(1, false);
      sum = _mbReviewSummary();
      out.oneLeftDisabled = sum.disabled;
      out.oneLeftTitle = sum.title;
      _mbToggleRowChecked(3, false);
      sum = _mbReviewSummary();
      out.enabled = !sum.disabled;
      out.noMatchDoesNotBlock = !sum.disabled;
      out.rowHtml = _mbBillBoxHtml(4).html;
      const calls = [];
      window._mbSaveOneBill = async (bi) => {
        calls.push(bi);
        return { status: 'saved' };
      };
      await confirmMultiBuildingSave('save');
      out.calls = calls;
      udSelProjId = 999;
      _mbCreateForRow(4);
      out.createType = _mbRowTargets[4] && _mbRowTargets[4].matchType;
      out.createChecked = _mbRowState[4].checked;
      return out;
    });
    ok(r.allDisabled === true, 'all selected: Save All disabled');
    ok(
      /Bill 2: sum mismatch/.test(r.allTitle) && /Bill 4: sum mismatch/.test(r.allTitle),
      'reason names both bills: ' + r.allTitle,
    );
    ok(!/Bill 1|Bill 3/.test(r.allTitle), 'reason does not name clean bills');
    ok(
      r.oneLeftDisabled === true && /Bill 4/.test(r.oneLeftTitle) && !/Bill 2/.test(r.oneLeftTitle),
      'one issue bill unchecked: still off, names only bill 4: ' + r.oneLeftTitle,
    );
    ok(r.enabled === true, 'both issue bills unchecked: Save All enabled');
    ok(r.noMatchDoesNotBlock === true, 'unchecked no-match bill does not block Save All');
    ok(/Create meter on Unmatched Bills/.test(r.rowHtml), 'no-match bill box offers Create meter on Unmatched Bills');
    ok(r.createType === 'create' && r.createChecked === true, 'Create makes the row a checked create target');
    ok(JSON.stringify(r.calls) === '[0,2]', 'saves exactly the 2 selected bills: ' + JSON.stringify(r.calls));
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
