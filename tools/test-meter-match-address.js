// Unit test: findMeterMatch last-pass meter-address match, S5a unit pick, label addresses. SYNTHETIC data only.
const vm = require('vm'), fs = require('fs'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '../app/bill-analysis.js'), 'utf8');
const es = fs.readFileSync(path.join(__dirname, '../app/energy-savings.js'), 'utf8');
const a = code.indexOf('function _normalizeAddr(a) {'), b = code.indexOf('function saveAddressAlias(');
const lblA = es.indexOf('const _ADDR_LABEL_RE'), lblB = es.indexOf('function _stripAddressTrailingJunk');
const sb = { console };
const ctx = vm.createContext(sb);
new vm.Script(es.slice(lblA, lblB)).runInContext(ctx);
new vm.Script(code.slice(a, b)).runInContext(ctx);
sb.utilityData = {};
sb.getUDProj = (pid) => sb.utilityData[pid] || (sb.utilityData[pid] = { buildings: [] });
sb.getUDBldgs = (pid) => (sb.utilityData[pid] || {}).buildings || [];
sb.forEachCustomerBuilding = (pl, fn) => (pl || []).forEach((p) => ((sb.utilityData[p.id] || {}).buildings || []).forEach((bd) => fn(bd, p)));
sb.projects = [{ id: 1, name: 'Fake Univ' }];
const fmm = (x) => { sb.__x = x; return new vm.Script('findMeterMatch(__x)').runInContext(ctx); };
const isLabel = (s) => { sb.__s = s; return new vm.Script('_addrIsLabel(__s)').runInContext(ctx); };
const M = (id, account, maddr) => ({ id, account, meter: '', commodity: 'Gas', maddr, accountAliases: [] });
const B = (id, addr, meters) => ({ id, name: id, addr, addrAliases: [], meters });
const bill = (acct, addr) => ({ Commodity: 'Gas', AccountNumber: acct, ServiceAddress: addr });
const units = () => [M('u101', '1111111111', '123 Example St #101, Fake City, KS 66000'), M('u103', '2222222222', '123 Example St #103, Fake City, KS 66000'), M('u105', '3333333333', '123 Example St #105, Fake City, KS 66000')];
let fail = 0;
const ok = (n, c) => { if (!c) fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

sb.utilityData[1] = { buildings: [B('bA', undefined, units())] };
let r = fmm(bill('9999999999', '123 EXAMPLE ST # 103'));
ok('unit meters, wrong stored acct: right unit proposed, held', r && r.matchType === 'address' && r.meterId === 'u103' && r.accountMismatch === true);
r = fmm(bill('3333333333', '123 EXAMPLE ST # 105'));
ok('exact account still wins (identity)', r && r.matchType === 'identity' && r.meterId === 'u105');
r = fmm(bill('9999999999', 'Statement Date'));
ok('label address rejected', r === null);
r = fmm(bill('9999999999', '123 EXAMPLE ST # 999'));
ok('unit with no meter: no proposal', r === null);

sb.utilityData[1] = { buildings: [B('bA', undefined, [M('x1', '1', '123 Example St #103, Fake City'), M('x2', '2', '123 Example St Unit 103, Fake City')])] };
r = fmm(bill('9999999999', '123 EXAMPLE ST # 103'));
ok('2 matching meters -> ambiguous', r && r.matchType === 'ambiguous' && r.candidates.length === 2);

sb.utilityData[1] = { buildings: [B('bA', undefined, [M('l1', '1', 'Statement Date'), M('l2', '2', 'Statement Date')])] };
r = fmm(bill('9999999999', 'Statement Date'));
ok('two meters with label maddr never match a label bill', r === null);

sb.utilityData[1] = { buildings: [B('bA', '123 Example St', [M('u101', '', '123 Example St #101'), M('u103', '', '123 Example St #103'), M('u105', '', '123 Example St #105')])] };
r = fmm(bill('9999999999', '123 EXAMPLE ST'));
ok('S5a: building address only, 3 units -> ambiguous, not first meter', r && r.matchType === 'ambiguous');
r = fmm(bill('9999999999', '123 EXAMPLE ST #103'));
ok('S5a: unit named -> that unit', r && r.meterId === 'u103' && r.matchType === 'address');

sb.utilityData[1] = { buildings: [B('bC', '456 Sample Ave', [M('s1', '5555555555', '456 Sample Ave')])] };
r = fmm(bill('9999999999', '456 SAMPLE AVE'));
ok('one meter, wrong acct: commodity pass unchanged', r && r.matchType === 'commodity');

ok('_addrIsLabel: Statement Date', isLabel('Statement Date') === true);
ok('_addrIsLabel: Account Number:', isLabel('Account Number:') === true);
ok('_addrIsLabel: real address false', isLabel('789 SAMPLE BLVD # 306') === false);
ok('_addrIsLabel: null false', isLabel(null) === false);
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
