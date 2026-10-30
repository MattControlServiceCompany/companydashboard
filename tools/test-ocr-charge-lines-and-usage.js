// Two extraction fixes (synthetic bills only):
//  1. A charge printed on 2 lines keeps each line as its own row (the merged field keeps the sum).
//  2. Usage (Therms, water gallons, sewer gallons) is not under Charges; Charges holds money lines only.
const render = require('./ocr-render-stub.js');
const sbLoad = require('./ocr-sandbox.js');
let bad = 0;
const ok = (c, l) => {
  if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l);
};
// The part of the grid after the "Charges" section header.
const chargesPart = (html) => html.slice(html.indexOf('ef-section">Charges'));
const keysOf = (html) => (html.match(/data-key="[^"]*"/g) || []).map((x) => x.slice(10, -1));

// 1a. Merge keeps every line.
const sb = sbLoad();
const merge = sb.get('_lbg_mergeMetered');
const m = merge(merge({ usage: 0, charge: 10, prevRead: null, currRead: null }, { usage: 0, charge: 20 }), { usage: 0, charge: 5 });
ok(m.charge === 35 && m.lines.join() === '10,20,5', 'merge adds the lines and keeps each amount');
const prop = sb.get('_lbg_chargeLinesProp');
ok(JSON.stringify(prop({ WaterCharge: m, WaterProtectionFee: { charge: 3 } })) === '{"_chargeLines":{"WaterCharge":[{"charge":10},{"charge":20},{"charge":5}]}}', 'only a 2+ line charge gets _chargeLines');
ok(Object.keys(prop({ WaterCharge: { charge: 3 } })).length === 0, 'one line: nothing added');

// 1b. Water bill with 2 lines: 2 rows, no merged cell.
const water = { UtilityCompany: 'Synth Water Co', Commodity: 'Water', AccountNumber: 'TST-0001', WaterUsage: '100', WaterCharge: '30.00', WaterProtectionFee: '1.50', TotalCurrentCharges: '31.50', _chargeLines: { WaterCharge: [{ charge: 10 }, { charge: 20 }] } };
let r = render(water);
let keys = keysOf(chargesPart(r.grid));
ok(keys.includes('_chg_WaterCharge_0') && keys.includes('_chg_WaterCharge_1') && !keys.includes('WaterCharge'), 'two water lines are two rows');
ok(keys.includes('WaterProtectionFee'), 'a single-line charge keeps its normal cell');
ok(/\$31\.50/.test(r.grid), 'running total still reaches the bill total');
// lines that do not add up to the field fall back to the one row
const off = Object.assign({}, water, { WaterCharge: '33.00' });
r = render(off);
keys = keysOf(chargesPart(r.grid));
ok(keys.includes('WaterCharge') && !keys.includes('_chg_WaterCharge_0'), 'lines that do not add up: one row');

// 1c. Editing a line changes the sum.
{
  const b = JSON.parse(JSON.stringify(water));
  const rr = render(b);
  rr.sb.window._pdfMultiBills = [b];
  rr.sb.get('_pdfApplyFieldEdit')('_chg_WaterCharge_1', '$25.00');
  ok(b._chargeLines.WaterCharge[1].charge === 25 && b.WaterCharge === '35.00', 'editing line 2 re-sums the field');
}

// 2. Usage is not under Charges.
const gas = { UtilityCompany: 'Synth Gas Co', Commodity: 'Gas', AccountNumber: 'TST-0002', NaturalGasTherms: '234.927', GasCharge: '100.00', CustomerCharge: '10.00', TotalCurrentCharges: '110.00' };
r = render(gas);
keys = keysOf(chargesPart(r.grid));
ok(!keys.includes('NaturalGasTherms') && !/Natural Gas Therms/.test(chargesPart(r.grid)) && keysOf(r.grid).includes('NaturalGasTherms'), 'gas Therms is shown, but not under Charges');
ok(keys.includes('GasCharge') && keys.includes('CustomerCharge'), 'gas money lines stay under Charges');
r = render({ UtilityCompany: 'Synth Water Co', Commodity: 'Water', AccountNumber: 'TST-0001', WaterUsage: '100', WaterCharge: '30.00', TotalCurrentCharges: '30.00' });
ok(!keysOf(chargesPart(r.grid)).includes('WaterUsage') && keysOf(r.grid).includes('WaterUsage'), 'water usage is not under Charges');
r = render({ UtilityCompany: 'Synth Sewer Co', Commodity: 'Sewer', AccountNumber: 'TST-0003', SewerUsage: '100', SewerCharge: '20.00', TotalCurrentCharges: '20.00' });
ok(!keysOf(chargesPart(r.grid)).includes('SewerUsage') && keysOf(r.grid).includes('SewerUsage'), 'sewer usage is not under Charges');
process.exit(bad ? 1 : 0);
