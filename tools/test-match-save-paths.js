/**
 * test-match-save-paths.js
 *
 * Node test for the bill-to-meter matching and save-path fixes (group
 * "matching/save path"). Loads the REAL functions from app/*.js through
 * Node's vm module and drives them with SYNTHETIC projects only (fake ids,
 * fake addresses, no real client data).
 *
 * Items covered:
 *  9cffee30  OCR-split / singular site tag still routes to the right meter, or is flagged ambiguous
 *  3287933a  duplicate check knows which of two same-account meters the bill belongs to
 *  06e549cf  history is never pooled across two meters that share an account
 *  9837d726  an address alias that is not the same place is refused
 *  409830ae  a bill with no commodity label is not written to a meter of another commodity
 *  63e43cab / a3271d04  the create/save path picks the sibling meter by address, never "first found"
 *  f8f58343  Auto-Assign All uses the shared auto-route rule and never adds a period twice
 *  c-b6665a0f  CSV import keeps a hand-corrected value
 *
 * Usage: node tools/test-match-save-paths.js [path-to-app-dir]
 *   (pass a pre-fix app dir, e.g. from origin/main, to confirm the test fails there)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = process.argv[2] || path.join(root, 'app');

function makeSandbox() {
  const el = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  const sandbox = {
    document: {
      getElementById: () => null,
      addEventListener() {},
      createElement: el,
      querySelectorAll: () => [],
      querySelector: () => null,
      body: el(),
    },
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn) => {
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {
        /* ignore */
      }
      return 0;
    },
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    addEventListener() {},
    fetch: () => Promise.reject(new Error('no network in test')),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const files = [
    path.join(root, 'lib', 'formatting.js'),
    path.join(root, 'computations', 'rates.js'),
    path.join(root, 'computations', 'savings.js'),
    path.join(appDir, 'energy-savings.js'),
    path.join(appDir, 'bill-analysis.js'),
    path.join(appDir, 'csv-import.js'),
    path.join(appDir, 'core.js'),
  ];
  for (const f of files) {
    try {
      vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: path.basename(f) });
    } catch (e) {
      throw new Error('load failed ' + path.basename(f) + ': ' + e.message);
    }
  }
  // Test doubles for storage / UI. Everything under test is the real code.
  vm.runInContext(
    `
    var __store = { en_pdf_bills: [] };
    sget = function (k, fb) { return __store[k] !== undefined ? __store[k] : fb; };
    sset = function (k, v) { __store[k] = v; return Promise.resolve(); };
    saveUtilityData = function () {};
    showToast = function () {};
    renderProjSavedBills = function () {};
    billHasPdf = function () { return false; };
    getCustomerBuildings = function (cid) { return __cust[cid] || []; };
    var __cust = {};
    forEachCustomerBuilding = function (list, fn) {
      (list || []).forEach(function (p) {
        (__cust[p.customerId] || []).forEach(function (b) { fn(b, p, p.customerId); });
      });
    };
    getUDBldgs = function (pid) {
      var p = projects.find(function (x) { return x.id === pid; });
      return p ? (__cust[p.customerId] || []) : [];
    };
    getUDBldgByCustomer = function (cid, bid) { return (__cust[cid] || []).find(function (b) { return b.id === bid; }); };
    `,
    sandbox,
  );
  return sandbox;
}

let failures = 0;
// A section that throws (for example a function that does not exist in an older
// app dir) counts as one FAIL and the run goes on, so the count on old code is honest.
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ' -- section crashed: ' + (e && e.message));
  }
}
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

// Fixture: one customer, one project, one building with a main electric meter
// and a site-tagged sibling electric meter on the SAME account.
function fixture(sb) {
  const acct = '1000001';
  const main = { id: 'mMain', commodity: 'Electric', account: acct, maddr: '100 Sample Dr', bills: [] };
  const sibling = {
    id: 'mSide',
    commodity: 'Electric',
    account: acct,
    maddr: '100 Sample Dr, Ballfields Exampleton, KS 00000',
    bills: [],
  };
  const gas = { id: 'mGas', commodity: 'Gas', account: '900123', maddr: '100 Sample Dr', bills: [] };
  const bldg = {
    id: 'bMain',
    name: 'Main Building',
    addr: '100 Sample Dr',
    addrAliases: [],
    meters: [main, sibling, gas],
  };
  const proj = { id: 1, name: 'Example Project', customerId: 'cust_1', scope: { buildingIds: ['bMain'] } };
  sb.__fx = { acct, main, sibling, gas, bldg, proj };
  vm.runInContext('__cust = { cust_1: [__fx.bldg] }; projects = [__fx.proj];', sb);
  return sb.__fx;
}

const bill = (over) =>
  Object.assign(
    {
      UtilityCompany: 'Example Utility',
      AccountNumber: '1000001',
      Commodity: 'Electric',
      BillingPeriodStart: '01/01/2026',
      BillingPeriodEnd: '01/31/2026',
      kWhConsumed: '1000',
      TotalCurrentCharges: '100.00',
    },
    over,
  );

async function main() {
  const sb = makeSandbox();
  const fx = fixture(sb);
  const run = (code) => vm.runInContext(code, sb);

  // ---- 9cffee30: OCR-garbled site tag --------------------------------------
  await section('9cffee30: OCR-garbled site tag', async () => {
    for (const tag of ['BALL FIELDS', 'BALLFIELD', 'Ballfields']) {
      const m = sb.findMeterMatch(bill({ ServiceAddress: '100 Sample Dr, ' + tag + ' Exampleton, KS 00000' }));
      const ok = m && ((m.matchType === 'identity' && m.meterId === 'mSide') || m.matchType === 'ambiguous');
      check(
        '9cffee30 tag "' + tag + '" routes to the site meter or is ambiguous',
        ok,
        JSON.stringify(m && m.matchType + ':' + m.meterId),
      );
    }
    {
      const garbled = '100 Sample Dr, BALL FIELDS Exampleton, KS 00000';
      const gap =
        sb._identityAddressScore(garbled, fx.sibling.maddr) - sb._identityAddressScore(garbled, fx.main.maddr);
      check('9cffee30 split tag scores clearly higher for the site meter (gap > 0.03)', gap > 0.03, 'gap=' + gap);
    }
    {
      const m = sb.findMeterMatch(bill({ ServiceAddress: '100 Sample Dr' }));
      check(
        '9cffee30 main-meter address still routes to the main meter',
        m && m.matchType === 'identity' && m.meterId === 'mMain',
        m && m.meterId,
      );
    }
    {
      // Two candidates equally far from the bill address: flagged, not guessed.
      const a = { meter: { id: 'a', maddr: '100 Sample Dr, Alpha Exampleton, KS 00000' } };
      const b = { meter: { id: 'b', maddr: '100 Sample Dr, Beta Exampleton, KS 00000' } };
      const r = sb._pickIdentityCandidate([a, b], '100 Sample Dr, Gamma Exampleton, KS 00000');
      check(
        '9cffee30 equal-score identity call is ambiguous',
        r && r.matchType === 'ambiguous' && r.candidates.length === 2,
        r && r.matchType,
      );
      const e = sb._pickIdentityCandidate([a, b], '100 Sample Dr, Alpha Exampleton, KS 00000');
      check('9cffee30 exact address still wins outright', e === a, e && e.matchType);
      const blank = sb._pickIdentityCandidate([{ meter: { id: 'x' } }, { meter: { id: 'y' } }], '100 Sample Dr');
      check('9cffee30 no recorded address keeps first-found', blank && blank.meter.id === 'x');
    }
  });

  // ---- multi-customer account: weak or conflicting address never assigns ----
  await section('multi-customer: assign only on a strong address fit', async () => {
    const cand = (cust, id, addr, by) => ({
      proj: { id: cust, customerId: 'cust_' + cust },
      bldg: { id: 'b' + cust },
      projId: cust,
      bldgId: 'b' + cust,
      meter: { id, maddr: addr },
      identityBy: by,
    });
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '', 'account'), cand(2, 'm2', '99 Other Rd', 'account')],
        '20 Example Ave',
      );
      check('B2 contradicting address does not beat a blank address', r && r.matchType === 'ambiguous', r && r.matchType);
    }
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '10 Sample Dr', 'account'), cand(2, 'm2', '99 Other Rd', 'account')],
        '500 Far Blvd',
      );
      check('B3 address that fits neither customer is ambiguous', r && r.matchType === 'ambiguous', r && r.matchType);
      check('B3 ambiguous result carries a plain reason', !!(r && r.reason), r && r.reason);
    }
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '10 Sample Dr', 'account'), cand(2, 'm2', '99 Other Rd', 'meter')],
        '99 Other Rd',
      );
      check('A account on customer 1, meter number on customer 2 is ambiguous', r && r.matchType === 'ambiguous', r && r.matchType);
    }
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '10 Sample Dr', 'account'), cand(2, 'm2', '99 Other Rd', 'both')],
        '99 Other Rd',
      );
      check('A account and meter agree on customer 2 with exact address assigns it', r && r.meter && r.meter.id === 'm2', r && r.matchType);
    }
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '', 'account'), cand(2, 'm2', '99 Other Rd', 'account')],
        '99 Other Rd',
      );
      check('exact address on one customer, blank on the other, assigns', r && r.meter && r.meter.id === 'm2', r && r.matchType);
    }
    {
      const r = sb._pickIdentityCandidate(
        [cand(1, 'm1', '10 Sample Dr', 'account'), cand(2, 'm2', '10 Sample Dr', 'account')],
        '10 Sample Dr',
      );
      check('equal exact address on two customers is ambiguous', r && r.matchType === 'ambiguous', r && r.matchType);
    }
    {
      const r = sb._pickIdentityCandidate([cand(1, 'm1', '', 'account'), cand(2, 'm2', '', 'account')], '');
      check('no address anywhere on two customers is ambiguous', r && r.matchType === 'ambiguous', r && r.matchType);
    }
  });

  // ---- f8f58343: an account-number hit carries customerId --------------------------
  await section('f8f58343: an account-number hit carries customerId', async () => {
    {
      const m1 = sb.findMeterMatch(
        bill({ AccountNumber: '900123', Commodity: 'Gas', ServiceAddress: '100 Sample Dr' }),
      );
      check(
        'f8f58343 single identity hit carries customerId',
        m1 && m1.matchType === 'identity' && m1.customerId === 'cust_1',
        m1 && String(m1.customerId),
      );
      const m2 = sb.findMeterMatch(bill({ ServiceAddress: '100 Sample Dr' }));
      check(
        'f8f58343 picked identity hit (2 meters on the account) carries customerId',
        m2 && m2.matchType === 'identity' && m2.customerId === 'cust_1',
        m2 && String(m2.customerId),
      );
    }
  });

  // ---- 3287933a: duplicate check knows the meter -----------------------------
  await section('3287933a: duplicate check knows the meter', async () => {
    {
      // Stored: a main-meter bill for January.
      fx.main.bills = [{ id: 'r1', start: '2026-01-01', end: '2026-01-31', kwh: '1000', totalCost: '100.00' }];
      fx.sibling.bills = [];
      const sideBill = bill({ ServiceAddress: '100 Sample Dr, Ballfields Exampleton, KS 00000' });
      const mainBill = bill({ ServiceAddress: '100 Sample Dr' });
      const map = await sb._checkDuplicates([sideBill, mainBill]);
      check('3287933a site-meter bill is not a duplicate of the main-meter bill', !map[0], map[0] && map[0].location);
      check('3287933a main-meter bill is still a duplicate of its own stored bill', !!map[1]);
      // The site meter has its own stored bill: now it IS a duplicate.
      fx.sibling.bills = [{ id: 'r2', start: '2026-01-01', end: '2026-01-31', kwh: '50', totalCost: '10.00' }];
      const map2 = await sb._checkDuplicates([sideBill]);
      check('3287933a site-meter bill is a duplicate of its own stored bill', !!map2[0]);
      fx.main.bills = [];
      fx.sibling.bills = [];
    }
  });

  // ---- 06e549cf: history is not pooled across meters --------------------------
  await section('06e549cf: history is not pooled across meters', async () => {
    {
      const hist = [];
      for (let i = 0; i < 6; i++) {
        hist.push({
          kwh: String(100000 + i * 10),
          totalCost: String(9000 + i),
          meterNumber: 'M-A',
          serviceAddress: '',
        });
      }
      const cache = { 1000001: hist };
      const small = bill({ MeterNumber: 'M-B', kWhConsumed: '500', TotalCurrentCharges: '60.00' });
      const w = sb.detectStatisticalOutliers(small, cache, {});
      check(
        '06e549cf other meter on the account gets no outlier warning',
        w.length === 0,
        JSON.stringify(w.map((x) => x.field)),
      );
      const same = bill({ MeterNumber: 'M-A', kWhConsumed: '500', TotalCurrentCharges: '60.00' });
      const w2 = sb.detectStatisticalOutliers(same, cache, {});
      check('06e549cf same meter is still checked against its history', w2.length > 0);
      check(
        '06e549cf _historyForBill drops the other meter',
        sb._historyForBill(small, cache).length === 0 && sb._historyForBill(same, cache).length === 6,
      );
      const noNum = bill({ kWhConsumed: '500' });
      check(
        '06e549cf no meter number on the bill keeps all history (absence never excludes)',
        sb._historyForBill(noNum, cache).length === 6,
      );
    }
  });

  // ---- 9837d726: alias plausibility -------------------------------------------
  await section('9837d726: alias plausibility', async () => {
    {
      check(
        '9837d726 same street accepted',
        sb._isPlausibleAddressAlias('100 Sample Dr', '100 Sample Dr Annex, Exampleton, KS 00000'),
      );
      check(
        '9837d726 other building refused',
        !sb._isPlausibleAddressAlias('100 Sample Dr', '7 Different Way, Elsewhere, KS 00001'),
      );
      check(
        '9837d726 import row with unrelated address adds no alias',
        sb._bldgImportAliasFor({ addr: '100 Sample Dr', kgsSvcAddr: '7 Different Way, Elsewhere, KS 00001' }) === '',
      );
      check(
        '9837d726 import row with the same place adds the alias',
        sb._bldgImportAliasFor({ addr: '100 Sample Dr', kgsSvcAddr: '100 Sample Dr Annex' }) === '100 Sample Dr Annex',
      );
      check(
        '9837d726 import row with the identical address adds none',
        sb._bldgImportAliasFor({ addr: '100 Sample Dr', kgsSvcAddr: '100 Sample Dr' }) === '',
      );
    }
  });

  // ---- 409830ae: no commodity label ---------------------------------------------
  await section('409830ae: no commodity label', async () => {
    {
      const gasBill = bill({ Commodity: '', NaturalGasTherms: '40', kWhConsumed: '', ServiceAddress: '100 Sample Dr' });
      const toElectric = {
        proj: fx.proj,
        bldg: fx.bldg,
        meter: fx.main,
        projId: 1,
        bldgId: 'bMain',
        meterId: 'mMain',
        matchType: 'identity',
      };
      const r = sb._saveBillToMatchedMeter(gasBill, toElectric);
      check(
        '409830ae gas-field bill with no label is not written to an electric meter',
        r === null && fx.main.bills.length === 0,
        String(r),
      );
      const toGas = {
        proj: fx.proj,
        bldg: fx.bldg,
        meter: fx.gas,
        projId: 1,
        bldgId: 'bMain',
        meterId: 'mGas',
        matchType: 'identity',
      };
      const gasOnly = bill({ AccountNumber: '900123', Commodity: '', NaturalGasTherms: '40', kWhConsumed: '' });
      const r2 = sb._saveBillToMatchedMeter(gasOnly, toGas);
      check(
        '409830ae gas-field bill with no label still saves to the gas meter',
        typeof r2 === 'string' && fx.gas.bills.length === 1,
        String(r2),
      );
      fx.gas.bills = [];
      const unknown = bill({ Commodity: '', kWhConsumed: '', TotalCurrentCharges: '5.00' });
      const r3 = sb._saveBillToMatchedMeter(unknown, toElectric);
      check('409830ae a bill whose fields say nothing is not blocked', typeof r3 === 'string', String(r3));
      fx.main.bills = [];
    }
  });

  // ---- 63e43cab / a3271d04: create/save path picks the sibling by address --------
  await section('63e43cab / a3271d04: create/save path picks the sibling by address', async () => {
    {
      const row = { id: 'rx', start: '2026-02-01', end: '2026-02-28', kwh: '70', totalCost: '9.00' };
      const sideBill = bill({ ServiceAddress: '100 Sample Dr, Ballfields Exampleton, KS 00000' });
      const out = sb._autoCreateMeterAndSaveBill(sideBill, 1, row);
      check(
        '63e43cab same-account bill lands on the site meter, not the first meter',
        out && out.meter.id === 'mSide' && fx.main.bills.length === 0,
        out && out.meter.id,
      );
      fx.sibling.bills = [];
      // Address cannot decide: nothing saved, no new meter created.
      const metersBefore = fx.bldg.meters.length;
      const vague = bill({ ServiceAddress: '100 Sample Dr, Gamma Exampleton, KS 00000' });
      fx.main.maddr = '100 Sample Dr, Alpha Exampleton, KS 00000';
      fx.sibling.maddr = '100 Sample Dr, Beta Exampleton, KS 00000';
      const out2 = sb._autoCreateMeterAndSaveBill(vague, 1, Object.assign({}, row, { id: 'ry' }));
      check(
        'a3271d04 undecidable same-account bill is held (null), nothing saved, no meter created',
        out2 === null &&
          fx.main.bills.length === 0 &&
          fx.sibling.bills.length === 0 &&
          fx.bldg.meters.length === metersBefore,
        String(out2),
      );
      fx.main.maddr = '100 Sample Dr';
      fx.sibling.maddr = '100 Sample Dr, Ballfields Exampleton, KS 00000';
    }
  });

  // ---- f8f58343: Auto-Assign All ---------------------------------------------------
  await section('f8f58343: Auto-Assign All', async () => {
    {
      fx.main.bills = [];
      fx.sibling.bills = [];
      const idHit = bill({
        id: 'sb1',
        ServiceAddress: '100 Sample Dr',
        BillingPeriodStart: '2026-03-01',
        BillingPeriodEnd: '2026-03-31',
      });
      // No account, address only: an unconfirmed guess.
      const addrOnly = bill({
        id: 'sb2',
        AccountNumber: '',
        ServiceAddress: '100 Sample Dr',
        BillingPeriodStart: '2026-04-01',
        BillingPeriodEnd: '2026-04-30',
      });
      const again = bill({
        id: 'sb3',
        ServiceAddress: '100 Sample Dr',
        BillingPeriodStart: '2026-03-01',
        BillingPeriodEnd: '2026-03-31',
      });
      sb.__saved = [idHit, addrOnly, again];
      run('__store.en_pdf_bills = __saved;');
      await sb.autoAssignAllSavedBills(1);
      const total = fx.main.bills.length + fx.sibling.bills.length;
      check(
        'f8f58343 account hit assigned once, address-only guess skipped, repeat period not added twice',
        total === 1 && !sb.__saved[1].projId && !sb.__saved[2].projId,
        'total=' + total,
      );
      check(
        'f8f58343 shared rule: identity yes, address-only no, ambiguous no',
        sb._isAutoRoutableMatch({ matchType: 'identity', meter: {} }) &&
          !sb._isAutoRoutableMatch({ matchType: 'address', meter: {} }) &&
          !sb._isAutoRoutableMatch({ matchType: 'ambiguous' }),
      );
      fx.main.bills = [];
      fx.sibling.bills = [];
    }
  });

  // ---- c-b6665a0f: CSV import keeps a hand-corrected value ----------------------------
  await section('c-b6665a0f: CSV import keeps a hand-corrected value', async () => {
    {
      const stored = {
        id: 'r9',
        start: '2026-05-01',
        totalCost: '999.99',
        kwh: '1000',
        _userCorrected: { totalCost: { original: '1', at: 'x' } },
      };
      const kept = sb._mergeCsvRowIntoBill(stored, { start: '2026-05-01', totalCost: '720', kwh: '1100' });
      check(
        'c-b6665a0f hand-corrected total kept, uncorrected usage updated',
        stored.totalCost === '999.99' && stored.kwh === '1100' && kept === 1,
        JSON.stringify(stored),
      );
      const erased = { id: 'r8', totalCost: '5', _userCorrected: { totalCost: { original: '1', at: 'x' } } };
      sb._mergeCsvRowIntoBill(erased, { totalCost: '', _erase: ['totalCost'] });
      check('c-b6665a0f typed ERASE still clears a corrected value', erased.totalCost === null);
    }
  });

  // ---- same account on 2 or more customers: Auto-Assign only when one customer fits
  await section('same account on more than one customer', async () => {
    const mk = (cid, pid, bid, maddr) => ({
      proj: { id: pid, name: 'Project ' + pid, customerId: cid, scope: { buildingIds: [bid] } },
      bldg: {
        id: bid,
        name: 'Building ' + bid,
        addr: maddr || '',
        addrAliases: [],
        meters: [{ id: 'm' + bid, commodity: 'Electric', account: '2000002', maddr: maddr || '', bills: [] }],
      },
    });
    const run2 = async (setups, billAddr) => {
      const s2 = makeSandbox();
      s2.__setups = setups;
      vm.runInContext(
        '__cust = {}; projects = __setups.map(function (x) { return x.proj; });' +
          '__setups.forEach(function (x) { __cust[x.proj.customerId] = [x.bldg]; });',
        s2,
      );
      s2.__saved = [bill({ id: 'sbA', AccountNumber: '2000002', ServiceAddress: billAddr })];
      vm.runInContext('__store.en_pdf_bills = __saved;', s2);
      await s2.autoAssignAllSavedBills(1);
      return s2.__saved[0];
    };
    const noAddr = await run2([mk('cust_1', 1, 'b1', ''), mk('cust_2', 2, 'b2', '')], '');
    check('2 customers, no address: bill skipped, left for the user', !noAddr.projId, String(noAddr.projId));
    const two = await run2(
      [mk('cust_1', 1, 'b1', '10 Sample Dr'), mk('cust_2', 2, 'b2', '20 Example Ave')],
      '20 Example Ave',
    );
    check(
      '2 customers, address separates: assigned to the right one',
      two.projId === 2 && two.meterId === 'mb2',
      String(two.projId),
    );
    const one = await run2([mk('cust_1', 1, 'b1', '')], '');
    check('1 customer: assigned', one.projId === 1 && one.meterId === 'mb1', String(one.projId));
  });

  if (failures) {
    console.log('\n' + failures + ' FAILED');
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
