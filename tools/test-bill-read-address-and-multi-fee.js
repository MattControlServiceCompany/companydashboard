/**
 * test-bill-read-address-and-multi-fee.js
 *
 * Regression test, SYNTHETIC text only (fake street, fake district, fake amounts).
 *  1. The Utility E service-address pattern (_EVG_ADDR) matches ONE printed line. A street number alone on a line, followed
 *     by a district name on the next line, must not join into an address.
 *  2. The old-format City reader sums EVERY Water Protection Fee line (one per meter), like the new-format reader, through
 *     the one shared merge (_lbg_mergeMetered).
 *  3. The stored-bill repair recognises a joined stored address and offers a clean one only when the page prints it.
 *
 * Usage: node tools/test-bill-read-address-and-multi-fee.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const sandbox = { window: {}, TextEncoder, console: { log: () => {}, warn: () => {}, error: () => {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', lib), 'utf8'), sandbox, { filename: lib });
}
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8'), sandbox, { filename: 'energy-savings.js' });
try {
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'utility-data.js'), 'utf8'), sandbox, { filename: 'utility-data.js' });
} catch (e) {
  /* declarations are already defined */
}
vm.runInContext('var billFieldUserOwned = (r, f) => !!(r._userCorrected && r._userCorrected[f]);', sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'bill-repair.js'), 'utf8'), sandbox, { filename: 'bill-repair.js' });

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}

// 1. address pattern
const addrRe = vm.runInContext('_EVG_ADDR', sandbox);
const joined = ['PAYMENT STUB', 'SAMPLE SCHOOL DISTRICT', '11', 'SAMPLE DIST 000', 'PO BOX 1 SAMPLETOWN KS', 'x'].join('\n');
check('a number alone on a line does not join the next line', !addrRe.test(joined), String(joined.match(addrRe)));
const joined2 = ['11', 'SAMPLE SCHOOL DISTRICT KS', 'other'].join('\n');
check('number line + district line ending in a state is not an address', !addrRe.test(joined2));
const good = ['Service Address', '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS', 'next'].join('\n');
const gm = good.match(addrRe);
check('a one-line address still matches', !!gm && gm[1] === '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS', String(gm && gm[1]));

// 2. old-format city reader, two water meters
const oldText = (wpfLines, waterLines) =>
  [
    '%%PAGE_1%%',
    'ACCOUNT SUMMARY',
    'Sampletown, ZZ 00000',
    'Service Address 100 S. SYNTH ST Account # 999000 Bill Date: 2/01/25',
    '12/15/24 1/15/25',
    'GAS 5100 4500 600 120.50',
    'FUEL ADJUSTMENT 10.25-',
    'STORM WATER 3.00',
    'SEWER 7000100 6990100 10000 80.00',
  ]
    .concat(wpfLines, waterLines, ['Past due balance: $.00', 'Amount due on or before 2/10/25: $300.00', 'Amount due after 2/10/25: $300.00'])
    .join('\n');
const rule = vm.runInContext('UTILITY_RULES', sandbox).filter((r) => /^City of/.test(r.name)).find((r) => {
  try {
    return (r.extractAll(oldText(['WATER PROTECTION FEE 7000100 6990100 10000 .45'], ['WATER 7000100 6990100 10000 90.25'])) || []).some((b) => b.Commodity === 'Water');
  } catch (e) {
    return false;
  }
});
check('city rule found', !!rule);
const one = rule.extractAll(oldText(['WATER PROTECTION FEE 7000100 6990100 10000 .45'], ['WATER 7000100 6990100 10000 90.25'])).find((b) => b.Commodity === 'Water');
const two = rule
  .extractAll(
    oldText(
      ['WATER PROTECTION FEE 7000100 6990100 10000 .45', 'WATER PROTECTION FEE 7100200 7090200 10000 1.40'],
      ['WATER 7000100 6990100 10000 90.25', 'WATER 7100200 7090200 10000 100.00'],
    ),
  )
  .find((b) => b.Commodity === 'Water');
check('one meter: fee 0.45', one && Math.abs(Number(one.WaterProtectionFee) - 0.45) < 0.001, one && one.WaterProtectionFee);
check('two meters: fee is the sum 1.85', two && Math.abs(Number(two.WaterProtectionFee) - 1.85) < 0.001, two && two.WaterProtectionFee);
check('two meters: water charge is the sum 190.25', two && Math.abs(Number(two.WaterCharge) - 190.25) < 0.001, two && two.WaterCharge);
check('two meters: total is water + fee 192.10', two && Math.abs(Number(two.TotalCurrentCharges) - 192.1) < 0.005, two && two.TotalCurrentCharges);

// 3. stored-address repair
const J = vm.runInContext('billServiceAddressJoined', sandbox);
check('joined stored address is recognised', J('11\nSAMPLE SCHOOL DISTRICT') === true);
check('a clean stored address is not', J('100 N SAMPLE RD SAMPLETOWN KS') === false && J('') === false && J(undefined) === false);
const cand = vm.runInContext('repairServiceAddressCandidate', sandbox);
const page = 'x\n100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS\ny';
const row = { serviceAddress: '11\nSAMPLE SCHOOL DISTRICT' };
const c1 = cand({ ServiceAddress: '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS' }, row, page);
check('clean address printed on the page is offered', c1 && c1.to === '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS' && !c1.held);
const c2 = cand({ ServiceAddress: '999 W OTHER ST SAMPLETOWN KS' }, row, page);
check('address not on the page is held', c2 && !!c2.held);
check('user-owned address is held', !!cand({ ServiceAddress: '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS' }, { serviceAddress: row.serviceAddress, _userCorrected: { serviceAddress: true } }, page).held);
check('a clean stored address gives no candidate', cand({ ServiceAddress: '100 N SAMPLE RD,ELE SCHOOL SAMPLETOWN KS' }, { serviceAddress: '5 X ST KS' }, page) === null);
check('a joined fresh address gives no candidate', cand({ ServiceAddress: '11\nZ' }, row, page) === null);

console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
