// test-audit-point-totals.js - the Audit View counter (points that count toward ASHRAE 36 scoring vs additional points) must
// not change when the Counts view / estimated HP points are added (item 6715c224). SYNTHETIC rows only.
// The counter rule (app/equipment-matrix.js, the ptsText loop): a normalized key that starts with auto_ is "additional", any other key is scored.
// The expected numbers were measured on the code of commit b5a155ba (before the Counts view). EM_SRC may point to another copy of equipment-matrix.js.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = process.env.EM_SRC || path.join(__dirname, 'app', 'equipment-matrix.js');
const sb = { console, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return { style: {}, classList: { add() {} } }; } }, localStorage: { getItem() { return null; }, setItem() {} }, navigator: {}, window: {} };
sb.window = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb, { filename: SRC });
const rows = [
  { category: 'doas', equipName: 'SYN-DOAS-1', pointsRaw: { 'Supply Fan 1 CFM': '3000', 'Supply Fan Status': 'On', 'VFD Power': '2.4 kW', 'Drive Power Factor': '0.9', 'Zone CO2': '700' } },
  { category: 'ahu', equipName: 'SYN-AHU-1', pointsRaw: { 'Supply Fan CFM': '7318', 'Supply Fan VFD Speed': '49 %', 'Drive Power': '3.1 kW', 'VFD Power': '1.0 kW', 'Supply Fan Amps': '30 A', 'Exhaust Fan 1 Amperage': '4 A', 'Exhaust Fan Amps': '5 A' } },
  { category: 'ef', equipName: 'SYN-EF-1', pointsRaw: { 'Exhaust Fan 1 Amperage': '9.5 A', 'Exhaust Fan Status': 'On', 'Exhaust Fan 2 Amps': '3 A', 'VFD Power': '0.6 kW' } },
  { category: 'rtu', equipName: 'SYN-RTU-1', pointsRaw: { 'Supply Fan Status': 'On', 'Drive Power': '1.2 kW', 'Supply Fan 2 CFM': '2000', 'Supply Fan Total CFM': '4000' } },
  { category: 'mau', equipName: 'SYN-MAU-1', pointsRaw: { 'VFD Power': '0.5 kW', 'Supply Fan 1 CFM': '900' } },
];
let scored = 0, other = 0;
rows.forEach((r) => Object.keys(sb.emGetNormalizedPoints(r)).forEach((k) => (k.indexOf('auto_') === 0 ? other++ : scored++)));
const EXPECT = { scored: 10, other: 4 };
if (scored !== EXPECT.scored || other !== EXPECT.other) {
  console.log('FAIL audit point totals changed: scored ' + scored + ' (expected ' + EXPECT.scored + '), additional ' + other + ' (expected ' + EXPECT.other + ')');
  process.exit(1);
}
console.log('1 passed, 0 failed: audit point totals unchanged (' + scored + ' scored, ' + other + ' additional)');
