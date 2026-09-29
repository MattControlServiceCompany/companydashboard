// tools/test-presented-savings-lock.js — acceptance test for the "presented to client" savings lock (WP-04a).
// Run: node tools/test-presented-savings-lock.js
// SYNTHETIC data only. Rule (Matt, 2026-09-29): savings figures already presented to the client can not
// change. The lock stores the figures PRINTED in the presented document (entered by the user), not the
// site's math. Asserts: after the user's confirm, changing a bill or the savings math does not change the
// presented period's building / portfolio totals (totalSavingsWithPresented, project rollup, annual sums,
// notice); monthly rows still recompute; unmarked periods recompute; removing the mark restores recompute.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('FAIL: ' + msg);
  }
}
function near(a, b) {
  return typeof a === 'number' && Math.abs(a - b) < 0.005;
}

const store = {};
const sb = { console, projects: [{ id: 9001, sa: 'SA-TEST', inclMonths: {}, status: 'active' }], utilityData: {} };
sb.window = sb;
sb.sget = (k, d) => (store[k] !== undefined ? JSON.parse(JSON.stringify(store[k])) : d);
sb.sset = (k, v) => {
  store[k] = JSON.parse(JSON.stringify(v));
  return Promise.resolve();
};
vm.createContext(sb);
const ymList = (y, a, b) => {
  const o = [];
  for (let i = a; i <= b; i++) o.push(y + '-' + String(i).padStart(2, '0'));
  return o;
};
function bill(ym, therms, rate) {
  const [y, mo] = ym.split('-');
  const last = new Date(+y, +mo, 0).getDate();
  return {
    start: ym + '-01',
    end: ym + '-' + String(last).padStart(2, '0'),
    therms,
    usage: therms,
    totalGasRate: rate,
    gasCharge: therms * rate,
  };
}
function mkMeter(id, blTherms, actTherms) {
  const b = ymList("2024", 1, 12)
    .map((ym) => bill(ym, blTherms, 1.0))
    .concat(ymList("2025", 1, 6).map((ym) => bill(ym, actTherms, 1.0)));
  return {
    id,
    commodity: "Gas",
    bills: b,
    baseline: { months: ymList("2024", 1, 12) },
  };
}
const meter1 = mkMeter("m-syn-1", 1000, 800); // saves 200 therms x $1.00 = $200 / month
const meter2 = mkMeter("m-syn-2", 500, 400); // saves $100 / month
const bldg1 = { id: "b-syn-1", name: "Synthetic Hall", meters: [meter1] };
const bldg2 = { id: "b-syn-2", name: 'Test "Annex", East', meters: [meter2] };
sb.utilityData[9001] = { buildings: [bldg1, bldg2] };

vm.runInContext(
  [
    "function getUDProj(pid){return utilityData[pid]||(utilityData[pid]={buildings:[]});}",
    "function getUDBldgs(pid){return getUDProj(pid).buildings;}",
    "function getUDBldg(pid,bid){return getUDBldgs(pid).find(function(b){return b.id===bid;});}",
    "var DB={get:function(k,d){return sget(k,d===undefined?null:d);}};",
    "function isBaselineExcluded(){return false;}",
    "function getWeatherForBuilding(){return {byYm:{}};}",
    "function isCalcCommodity(){return true;}",
    "function projHasContract(pid){return true;}",
    "var udSelProjId=9001, udSelBldgId=null;",
  ].join("\n"),
  sb,
);
function readSrc(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}
function loadFn(rel, name) {
  const src = readSrc(rel);
  const m = new RegExp("function " + name + "\\s*\\(").exec(src);
  if (!m) throw new Error("fn not found " + name);
  const i = src.indexOf("{", src.indexOf(")", m.index));
  let d = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}" && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
vm.runInContext(
  ["_fixISO", "_parseISO", "calcDays"]
    .map((n) => loadFn("app/utility-data.js", n))
    .join("\n"),
  sb,
);
const html = readSrc("energy-department.html");
const libs = [];
const re = /<script\s+src="((?:lib|computations)\/[^"?]+\.js)/g;
let mm;
while ((mm = re.exec(html))) if (libs.indexOf(mm[1]) < 0) libs.push(mm[1]);
libs.forEach((rel) => {
  try {
    vm.runInContext(readSrc(rel), sb, { filename: rel });
  } catch (e) {
    console.log("WARN load " + rel + ": " + e.message);
  }
});
const SUMMER = /const SUMMER_MOS = \[[^\]]*\];/.exec(
  readSrc("app/energy-savings.js"),
);
if (SUMMER) vm.runInContext(SUMMER[0].replace("const ", "var "), sb);

const allMeters = [meter1, meter2];
function billOf(meter, start) {
  return meter.bills.find((x) => x.start === start);
}
function perBldg() {
  allMeters.forEach((m) => {
    m._savingsCache = null;
    m._savingsCacheKey = null;
  });
  return {
    "b-syn-1": sb.getBuildingSavingsByYM(bldg1, 9001),
    "b-syn-2": sb.getBuildingSavingsByYM(bldg2, 9001),
  };
}
const Q1 = ymList("2025", 1, 3);
const Q2 = ymList("2025", 4, 6);
const H1 = ymList("2025", 1, 6);

const cur0 = perBldg();
assert(
  Q1.every(
    (y) => near(cur0["b-syn-1"][y], 200) && near(cur0["b-syn-2"][y], 100),
  ),
  "setup: b1 saves $200 and b2 saves $100 every month",
);
assert(
  typeof sb.totalSavingsWithPresented === "function",
  "totalSavingsWithPresented exists",
);
assert(
  typeof sb.savePresentedRecord === "function",
  "savePresentedRecord exists",
);
assert(
  typeof sb.removePresentedMark === "function",
  "removePresentedMark exists",
);
assert(
  typeof sb.getPresentedNotice === "function",
  "getPresentedNotice exists",
);
assert(typeof sb.parsePresentedCsv === "function", "parsePresentedCsv exists");
if (typeof sb.savePresentedRecord !== "function") {
  console.log("RESULT " + passed + " passed, " + failed + " failed");
  process.exit(1);
}

// Nothing marked: sums are the current months.
let t = sb.totalSavingsWithPresented(9001, Q1, cur0);
assert(
  near(t.total, 900) && near(t.byBldg["b-syn-1"], 600),
  "unmarked: Q1 total is the current $900",
);
assert(sb.getPresentedNotice(9001, Q1) === "", "no notice before marking");

// The user confirms figures as PRINTED in the document (they differ from the site math on purpose).
const rec = {
  projectId: 9001,
  periodStart: "2025-01",
  periodEnd: "2025-03",
  presentedAt: "2026-05-11T12:00:00.000Z",
  documentName: "Synthetic Q1 report",
  totalDollars: 901,
  buildings: {
    "b-syn-1": { dollars: 601, kwhSaved: 1234 },
    "b-syn-2": { dollars: 299, thermsSaved: 555 },
  },
};
assert(
  sb.savePresentedRecord(Object.assign({}, rec, { buildings: {} })).ok ===
    false,
  "rejects a record with no building figures",
);
assert(
  sb.savePresentedRecord(Object.assign({}, rec, { periodStart: "2025-04" }))
    .ok === false,
  "rejects a period that ends before it starts",
);
const saved = sb.savePresentedRecord(rec);
assert(
  saved.ok === true && saved.record.projectId === "9001",
  "savePresentedRecord stores the record",
);
assert(
  sb.savePresentedRecord(
    Object.assign({}, rec, { periodStart: "2025-03", periodEnd: "2025-05" }),
  ).ok === false,
  "rejects an overlapping period",
);

t = sb.totalSavingsWithPresented(9001, Q1, cur0);
assert(
  near(t.byBldg["b-syn-1"], 601) && near(t.byBldg["b-syn-2"], 299),
  "Q1 building figures are the printed ones",
);
assert(near(t.total, 901), "Q1 portfolio total is the printed $901 (not 900)");
const st = sb.totalSavingsWithPresented(9001, Q1, {
  "b-syn-1": cur0["b-syn-1"],
});
assert(
  near(st.total, 601),
  "a report of one building uses that building figure, not the portfolio total",
);
t = sb.totalSavingsWithPresented(9001, ["2025-01", "2025-02"], cur0);
assert(
  near(t.total, 600),
  "a period that does not contain the whole presented period is current math ($600)",
);
t = sb.totalSavingsWithPresented(9001, H1, cur0);
assert(
  near(t.total, 901 + 900),
  "Jan-Jun: presented Q1 ($901) + current Q2 ($900)",
);
t = sb.getProjectSavingsTotal(9001);
assert(
  near(t.total, 901 + 900),
  "project total for every month uses the presented Q1 (portal, dashboards)",
);
assert(
  sb.getPresentedUnits(9001, Q1, "b-syn-1").kwhSaved === 1234,
  "printed unit figure returned for the exact period",
);
assert(
  sb.getPresentedUnits(9001, H1, "b-syn-1") === null,
  "no printed unit figure for a different period",
);
assert(
  sb.getPresentedNotice(9001, Q1) ===
    "Presented to client on May 11, 2026. Figures are locked; monthly detail is recalculated and may differ slightly.",
  "notice text for the exact period: " + sb.getPresentedNotice(9001, Q1),
);
assert(
  /^Includes figures presented to client on May 11, 2026 for January 2025 through March 2025\./.test(
    sb.getPresentedNotice(9001, H1),
  ),
  "notice text for a longer period: " + sb.getPresentedNotice(9001, H1),
);
assert(
  sb.getPresentedNotice(9001, Q2) === "",
  "no notice for an unmarked quarter",
);

// Change a bill, the rate (math input) and add an override; edit Q2 as well.
billOf(meter1, "2025-02-01").therms = 1500;
billOf(meter1, "2025-02-01").usage = 1500;
billOf(meter1, "2025-03-01").totalGasRate = 2.5;
meter1.baseline.costSavOverrides = { "2025-01": 12345 };
billOf(meter2, "2025-04-01").therms = 100;
billOf(meter2, "2025-04-01").usage = 100;
const cur1 = perBldg();
assert(
  near(cur1["b-syn-1"]["2025-01"], 12345),
  "monthly rows still recompute after the edits (Jan override shows)",
);
t = sb.totalSavingsWithPresented(9001, Q1, cur1);
assert(
  near(t.byBldg["b-syn-1"], 601) &&
    near(t.byBldg["b-syn-2"], 299) &&
    near(t.total, 901),
  "Q1 printed figures unchanged after bill and math edits",
);
t = sb.totalSavingsWithPresented(9001, H1, cur1);
assert(
  near(t.byBldg["b-syn-2"], 299 + 400 + 100 + 100),
  "unmarked Q2 recomputes (b2 April now $400)",
);
t = sb.getProjectSavingsTotal(9001);
assert(
  Math.abs(t.total - 901) > 1000 && t.applied.length === 1,
  "project total: Q1 locked, other months follow the edits",
);

// CSV of printed figures.
const csv =
  "building,figure,value\n" +
  'Synthetic Hall,savings_dollars,"$4,338"\n' +
  '"Test ""Annex"", East",savings_dollars,725\n' +
  "Synthetic Hall,kwh_saved,-21794\n" +
  "Portfolio total,savings_dollars,9056\n" +
  "No Such Hall,savings_dollars,5\n" +
  "bad line\n";
const pc = sb.parsePresentedCsv(csv, [bldg1, bldg2]);
assert(
  pc.buildings["b-syn-1"].dollars === 4338 &&
    pc.buildings["b-syn-1"].kwhSaved === -21794,
  "csv: dollars with $ and comma, and kWh",
);
assert(
  pc.buildings["b-syn-2"] && pc.buildings["b-syn-2"].dollars === 725,
  "csv: quoted building name with quotes and a comma",
);
assert(
  pc.totalDollars === 9056 &&
    pc.unmatched.join("|") === "No Such Hall" &&
    pc.bad.length === 1,
  "csv: total, unmatched name and unreadable row reported",
);

// Header savings total (app/core.js updateHomeStats) goes through the keeper. The mark was removed above
// in the earlier section, so save it again for this check.
const shown = {};
sb.document = { getElementById: (id) => ({ set textContent(v) { shown[id] = v; } }) };
sb.equipment = [];
sb.tasks = [];
sb.NOW = new Date();
vm.runInContext(loadFn('app/core.js', 'updateHomeStats'), sb);
sb.updateHomeStats();
const rawAll = Object.values(cur1).reduce((a, m) => a + Object.values(m).reduce((x, v) => x + v, 0), 0);
assert(
  shown['h-sav'] === '$' + Math.round(sb.getProjectSavingsTotal(9001).total).toLocaleString(),
  'header total equals the keeper project total (Q1 presented)',
);
assert(shown['h-sav'] !== '$' + Math.round(rawAll).toLocaleString(), 'header total is not the raw month sum while Q1 is presented');

// No page keeps its own month-summing for a savings total: each consumer routes through the keeper.
const CONSUMERS = {
  'app/core.js': [/getProjectSavingsTotal\(/, /Object\.values\(savResult\.byCalMo\)/],
  'app/scorecard.js': [/totalSavingsWithPresented\(/, /Object\.values\(savByYM\)\.reduce/],
  'app/utility-data.js': [/totalSavingsWithPresented\(/, /Object\.values\(actSavByMo\)\.reduce/, /savVals\.reduce/, /Object\.values\(actByMo\)\.reduce/],
  'app/graphics-setpoints.js': [/totalSavingsWithPresented\(/, /\.reduce\(\(s, \[, v\]\) => s \+ v, 0\)\s*:\s*0;/],
  'app/report-engine.js': [/totalSavingsWithPresented\(/, /periodSavings \+= totalCostSav/],
  'app/portal-export.js': [/getProjectSavingsTotal\(/],
};
Object.keys(CONSUMERS).forEach((f) => {
  const src = readSrc(f);
  const [must, ...mustNot] = CONSUMERS[f];
  assert(must.test(src), f + ' calls the keeper');
  mustNot.forEach((re) => assert(!re.test(src), f + ' no longer sums months itself: ' + re));
});
assert(/getProjectSavingsTotal\(/.test(readSrc('app/core.js')) && /addBldgQuarters/.test(readSrc('app/core.js')), 'core.js dashboard quarters use the keeper helper');
assert(/getPresentedNotice\(d\.project\.id, periodYMs\)/.test(readSrc('app/report-engine.js')), 'Board Summary shows the presented notice');

// Remove the mark: totals recompute.
assert(
  sb.removePresentedMark(9001, Q1) === true,
  "removePresentedMark returns true",
);
t = sb.totalSavingsWithPresented(9001, Q1, cur1);
assert(
  near(t.byBldg["b-syn-2"], 300),
  "after remove: b2 Q1 is current math again ($300)",
);
assert(
  near(
    t.total,
    cur1["b-syn-1"]["2025-01"] +
      cur1["b-syn-1"]["2025-02"] +
      cur1["b-syn-1"]["2025-03"] +
      300,
  ),
  "after remove: total is current math",
);
assert(sb.getPresentedNotice(9001, Q1) === "", "no notice after remove");
assert(
  sb.removePresentedMark(9001, Q1) === false,
  "second remove returns false",
);

// ---- WP-04a fix 2: commodity dollars, portal units, per-meter quarters ----
{
  const Q = ymList("2025", 1, 3);
  const csv =
    "building,figure,value\nSyn One,electric_savings_dollars,111.5\nSyn One,gas_savings_dollars,22.25\n" +
    "Syn One,propane_savings_dollars,3\nSyn One,savings_dollars,136.75\nSyn One,kwh_saved,5000\n";
  const pc = sb.parsePresentedCsv(csv, [{ id: "b-syn-1", name: "Syn One" }]);
  const f = pc.buildings["b-syn-1"] || {};
  assert(
    f.elecDollars === 111.5 && f.gasDollars === 22.25 && f.propaneDollars === 3 && pc.bad.length === 0,
    "CSV reads the printed electric / gas / propane dollars per building",
  );
  const units = {
    "b-syn-1": { "2025-01": { kwh: 10, therms: 4, gallons: 1 }, "2025-02": { kwh: 10, therms: 4, gallons: 1 }, "2025-04": { kwh: 7, therms: 2, gallons: 0 } },
    "b-syn-2": { "2025-01": { kwh: 3, therms: 1, gallons: 0 } },
  };
  const ymsU = ["2025-01", "2025-02", "2025-03", "2025-04"];
  let u = sb.totalUnitsWithPresented(9001, ymsU, units);
  assert(u.kwh === 30 && u.therms === 11 && u.gallons === 2, "unmarked: unit total is current math");
  const r = sb.savePresentedRecord({
    projectId: 9001, periodStart: "2025-01", periodEnd: "2025-03", presentedAt: "2025-04-05T12:00:00.000Z",
    documentName: "Synthetic Q1", totalDollars: 500,
    buildings: { "b-syn-1": { dollars: 400, kwhSaved: 5000, elecDollars: 300 } },
  });
  assert(r.ok, "commodity-dollar record saves");
  assert(sb.getPresentedUnits(9001, Q, "b-syn-1").elecDollars === 300, "keeper returns printed electric dollars for the exact period");
  u = sb.totalUnitsWithPresented(9001, ymsU, units);
  assert(
    u.kwh === 5000 + 3 + 7 && u.therms === 4 + 4 + 1 + 2 && u.gallons === 2,
    "marked: printed kWh replaces b1 presented months, other units and buildings stay current",
  );
  sb.removePresentedMark(9001, Q);
  assert(sb.getPresentedRecords(9001).length === 0, "test record removed");
  const rd = (f2) => fs.readFileSync(path.join(REPO, f2), "utf8");
  const rep = rd("app/report-engine.js");
  assert(/elec\.costSaved = _presUnits\.elecDollars/.test(rep) && /gas\.costSaved = _presUnits\.gasDollars/.test(rep) && /propane\.costSaved = _presUnits\.propaneDollars/.test(rep),
    "report engine takes per-commodity dollars from the keeper record");
  assert(/totalUnitsWithPresented\(/.test(rd("app/portal-export.js")), "portal CO2 units go through the keeper");
  const core = rd("app/core.js");
  assert(/meterSavByYMs\.push/.test(core) && /addBldgQuarters = \(projId, bldgId, meterByYMs\)/.test(core), "dashboard quarters pick the newest year per meter");
}

console.log("RESULT " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
