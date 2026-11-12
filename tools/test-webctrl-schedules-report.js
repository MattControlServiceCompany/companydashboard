'use strict';
// Tests for the WebCTRL Schedules report in coverage and on the "What needs to change" card:
//   a group's date, date-range and yearly schedules cover events on their dates; unoccupied periods and schedules with no
//   day selected never cover; the card names the WebCTRL schedule an event is named after and the time difference;
//   an inactive schedule of the group is offered as "Activate ..." ; the audit log keeps schedule rows at non-root locations.
// SYNTHETIC data only (made-up school, gym and event names). Run: node tools/test-webctrl-schedules-report.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const BD = require(path.join(ROOT, 'app', 'bas-diff.js'));
const BC = require(path.join(ROOT, 'computations', 'bas-coverage.js'));
const SA = require(path.join(ROOT, 'computations', 'sched-actions.js'));
const BAL = require(path.join(ROOT, 'app', 'bas-audit-log.js'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}
const src = fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const from = src.indexOf('\nfunction emParseCSVText(');
const sb = {};
vm.createContext(sb);
vm.runInContext(src.slice(from + 1, src.indexOf('\nfunction ', from + 5)), sb);

const REPORT =
  '"Location","Priority","Description"\n' +
  '"Schedule Groups:"\n' +
  '"Test School / Test Gyms","Normal","Spring Practice\nMon,Tue,Wed,Thu,Fri\nOccupied from 3:00 PM to 7:30 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Awards Night\n11/12/2026\nOccupied from 3:00 PM to 9:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Winter Camp\nWed,Fri  11/1/2026 - 11/30/2026\nOccupied from 5:00 PM to 9:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Closed Gym\nMon,Tue,Wed,Thu,Fri\nUnoccupied from 3:00 PM to 11:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Late Club\nOccupied from 6:00 PM to 10:00 PM"\n' +
  '"Test School / Test Energy","Holiday","Temp Unoccupied\n2/16/2026 - 12/31/2026\nUnoccupied from 12:00 AM to 5:00 AM"\n';
const rep = BD.readGroupRows(sb.emParseCSVText(REPORT));
const applied = BD.applyGroupsImport({ hist: [], groups: null, scheduleItems: rep.items, locationItems: rep.locations, now: '2026-11-10T12:00:00Z', by: 't', id: 'x' });
const gname = 'Test School|Test Gyms';
const withMembers = JSON.parse(JSON.stringify(applied.groups.groups));
withMembers[gname].members = ['Gym / Test Gym RTU'];
const only = (names) => {
  const g = JSON.parse(JSON.stringify(withMembers));
  g[gname].schedules = g[gname].schedules.filter((s) => names.indexOf(s.name) !== -1);
  return g;
};

const TZ = 'America/Chicago';
const KEY = '/Test District/Test School/Gym|Test Gym RTU';
const blocks = [[0, 300, 'unocc'], [300, 900, 'occ'], [900, 0, 'unocc']];
const snaps = { '2026-11-10': { importedAt: '2026-11-10T19:00:00Z', rows: { [KEY]: blocks } }, '2026-11-13': { importedAt: '2026-11-10T19:00:00Z', rows: { [KEY]: blocks } } }; // 5 AM - 3 PM
const map = { spaces: { 'test gym': { space: 'Test Gym', programs: [KEY], confirmed: true } } };
const at = (ymd, h, m) => new Date(ymd + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-06:00').toISOString();
const ev = (title, ymd, h1, h2, m2) => ({ e1: [title, at(ymd, h1), at(ymd, h2, m2), 0, 'Test Gym'] });
const cover = (events, groups) => BC.eventCoverage(events.e1, { tz: TZ, map, snaps, groups });
const input = (events, groups, extra) => Object.assign({ events, map, snaps, groups, locations: [], tz: TZ, today: '2026-11-10', from: '2026-11-10', to: '2026-11-16' }, extra || {});

t('the report in this test keeps every schedule, active or not', () => {
  assert.strictEqual(applied.groups.groups[gname].schedules.length, 5);
  assert.strictEqual(applied.groups.groups['Test School|Test Energy'].schedules.length, 1);
  assert.strictEqual(applied.groups.groups['Test School|Test Energy'].schedules[0].priority, 'Holiday');
});

t('coverage: a group date schedule covers an event on that date, not on another date', () => {
  const g = only(['Awards Night']);
  assert.strictEqual(cover(ev('Awards', '2026-11-12', 18, 20), g).status, 'covered');
  assert.strictEqual(cover(ev('Awards', '2026-11-13', 18, 20), g).status, 'short');
});

t('coverage: a date-range schedule covers on its selected weekdays only; one with no weekday never covers', () => {
  assert.strictEqual(cover(ev('Camp', '2026-11-11', 17, 20), only(['Winter Camp'])).status, 'covered', 'range with weekdays');
  assert.strictEqual(cover(ev('Camp', '2026-11-12', 17, 20), only(['Winter Camp'])).status, 'short', 'Thursday is not selected');
  assert.strictEqual(cover(ev('Camp', '2026-11-11', 3, 4), only(['Temp Unoccupied'])).status, 'short', 'no weekday: never covers');
});

t('coverage: unoccupied periods and schedules with no day selected never cover', () => {
  assert.strictEqual(cover(ev('Club', '2026-11-11', 18, 20), only(['Closed Gym'])).status, 'short', 'unoccupied');
  assert.strictEqual(cover(ev('Club', '2026-11-11', 18, 20), only(['Late Club'])).status, 'short', 'weekly with no days line');
  assert.strictEqual(cover(ev('Club', '2026-11-11', 18, 19), only(['Spring Practice'])).status, 'covered', 'weekdays selected');
});

t('card: an event named like a WebCTRL schedule shows the schedule and the time it falls short', () => {
  const events = ev('Spring Practice', '2026-11-11', 15, 20, 30); // 3:00 PM - 8:30 PM, WebCTRL ends 7:30 PM
  const pn = SA.periodNeeds(input(events, only(['Spring Practice'])));
  assert.strictEqual(pn.length, 1);
  assert.strictEqual(pn[0].named.length, 1);
  assert.strictEqual(
    pn[0].named[0].text,
    'In WebCTRL: Spring Practice, Mon,Tue,Wed,Thu,Fri, 3:00 PM-7:30 PM (WebCTRL ends 7:30 PM, event ends 8:30 PM: 1 hour short)',
  );
});

t('card: a name match that does not run on the event date says so; an unnamed event has no WebCTRL line', () => {
  const pn = SA.periodNeeds(input(ev('Awards Night', '2026-11-13', 18, 20), only(['Awards Night'])));
  assert.strictEqual(pn[0].named.length, 1);
  assert(/not active on Fri Nov 13, 2026/.test(pn[0].named[0].text), pn[0].named[0].text);
  const none = SA.periodNeeds(input(ev('Other Event', '2026-11-13', 18, 20), only(['Awards Night'])));
  assert.strictEqual(none[0].named.length, 0);
});

t('card: name compare ignores case, spaces and punctuation', () => {
  const m = BC.webctrlMatch(withMembers, [], 'SPRING  practice!', '2026-11-11', 'Test School');
  assert(m && m.name === 'Spring Practice');
});

t('card: an uncovered event whose group has an inactive schedule that spans it is told to activate it', () => {
  const events = ev('Book Club', '2026-11-11', 18, 20);
  const pn = SA.periodNeeds(input(events, only(['Late Club'])));
  assert.strictEqual(pn.length, 1);
  assert.strictEqual(pn[0].change, 'Activate Late Club in Test Gyms (select Wed)');
  const add = SA.periodNeeds(input(events, only([])));
  assert(/^Add /.test(add[0].change), add[0].change);
});

t('card: location schedules are found by name too', () => {
  const locs = [{ location: '/Test District/Test School/Gym', building: 'Test School', area: 'Gym', schedule: BD.parseDescription('Spring Practice\nMon,Tue\nOccupied from 3:00 PM to 7:30 PM', 'Normal') }];
  const m = BC.webctrlMatch({}, locs, 'Spring Practice', '2026-11-10', 'Test School');
  assert(m && m.applies && m.where === '/Test District/Test School/Gym');
});

t('audit log: schedule add/update/delete rows at a non-root location are kept', () => {
  const blk = 'schedule "Test Evening"\nType "Weekly"\ndays: Thu\nAt "17:30" set "Occupied"\nAt "20:30" set "Unoccupied"';
  const rows = [['Date', 'Description', 'Details', 'Location', 'Operator'], ['11/2/2026 9:15:00 AM', 'Add schedule', blk, '/Test District/Test School/AREA F SUMMARY/Room F1', 'Test Operator']];
  const parsed = BAL.parseRows(rows);
  const store = BAL.mergeStore(null, parsed.events, parsed.lastDay);
  const list = BAL.changeList(store, {});
  assert.strictEqual(list.rows.length, 1);
  assert.strictEqual(list.rows[0].type, 'Schedule added');
  assert.strictEqual(list.rows[0].area, 'AREA F SUMMARY / Room F1');
});

// WebCTRL repeats every group schedule in part 1 under one location; that copy is not a location schedule (2026-11-12 real report).
t('report: the repeated group listing in part 1 is not stored as location schedules', () => {
  const dup =
    '"Location","Priority","Description"\n' +
    '"/Test District/Test School","Normal","Regular Day\nMon,Tue,Wed,Thu,Fri\nOccupied from 6:00 AM to 4:00 PM"\n' +
    '"/Test District/Test School/Front Lights","Normal","Spring Practice\nMon,Tue,Wed,Thu,Fri\nOccupied from 3:00 PM to 7:30 PM"\n' +
    '"/Test District/Test School/Front Lights","Normal","Awards Night\n11/12/2026\nOccupied from 3:00 PM to 9:00 PM"\n' +
    '"Schedule Groups:"\n' +
    '"Test School / Test Gyms","Normal","Spring Practice\nMon,Tue,Wed,Thu,Fri\nOccupied from 3:00 PM to 7:30 PM"\n' +
    '"" ,"" ,"" ,"" ,"" ,"Normal","Awards Night\n11/12/2026\nOccupied from 3:00 PM to 9:00 PM"\n';
  const r = BD.readGroupRows(sb.emParseCSVText(dup));
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.locations.length, 1);
  assert.strictEqual(r.locations[0].schedule.name, 'Regular Day');
});

// --- opportunities (Matt 2026-11-12): covered, but a separate schedule would fit better; optional ---------------------------
const mkSched = (name, days, from, to) => ({ name, priority: 'Normal', type: 'weekly', days, dates: [], from: '', to: '', recur: null, periods: [{ mode: 'occ', from, to }] });
const gymGroups = (schedules) => ({ [gname]: { building: 'Test School', group: 'Test Gyms', schedules, members: ['Gym / Test Gym RTU'] } });
const wk = (title, spec, pre) => {
  const out = {};
  spec.forEach(([ymd, h1, m1, h2, m2], i) => { out[(pre || 'e') + i] = [title, at(ymd, h1, m1), at(ymd, h2, m2), 0, 'Test Gym']; });
  return out;
};
const oppInput = (events, groups) => input(events, groups, { today: '2026-11-09', from: '2026-11-09', to: '2026-11-15' });
const gymClub = mkSched('Gym Club', ['Mon', 'Tue', 'Wed', 'Thu'], 1020, 1230); // 5:00 PM - 8:30 PM
const spec1 = [['2026-11-09', 17, 0, 20, 0], ['2026-11-10', 17, 0, 19, 30], ['2026-11-11', 17, 0, 19, 30], ['2026-11-12', 17, 0, 20, 30]];
const spec2 = [['2026-11-16', 17, 0, 20, 0], ['2026-11-17', 17, 0, 19, 30], ['2026-11-18', 17, 0, 19, 30], ['2026-11-19', 17, 0, 20, 30]]; // the next week: the series repeats
const oppEvents = Object.assign(wk('Gym Club', spec1), wk('Gym Club', spec2, 'n'));

t('opportunity: covered events stay covered (no to-do); one line names Mon (0.5 h) and Tue,Wed (1 h), 2.5 h a week; Thu has none', () => {
  const g = gymGroups([gymClub]);
  Object.keys(oppEvents).forEach((k) => assert.strictEqual(BC.eventCoverage(oppEvents[k], { tz: TZ, map, snaps, groups: g }).status, 'covered', k));
  const o = oppInput(oppEvents, g);
  assert.strictEqual(SA.periodNeeds(o).length, 0, 'no to-do line');
  const opps = SA.periodOpportunities(o);
  assert.strictEqual(opps.length, 1);
  assert.strictEqual(opps[0].hours, 2.5);
  assert.strictEqual(opps[0].weekly, true);
  assert(/0\.5 h longer than the event on Mon \(event 5:00 PM-8:00 PM, schedule 5:00 PM-8:30 PM\)/.test(opps[0].text), opps[0].text);
  assert(/1 h longer than the event on Tue,Wed \(event 5:00 PM-7:30 PM, schedule 5:00 PM-8:30 PM\)/.test(opps[0].text), opps[0].text);
  assert(/A separate Mon 5:00 PM-8:00 PM and Tue,Wed 5:00 PM-7:30 PM schedule would save about 2\.5 h a week\. Optional: the event is already covered\.$/.test(opps[0].text), opps[0].text);
  assert(!/Thu/.test(opps[0].text) && !/past/.test(opps[0].text), 'Thursday fits the schedule exactly; no word past');
  assert.strictEqual(SA.periodView(Object.assign(o, { rows: Object.keys(oppEvents).map((k) => oppEvents[k]) })).opportunities.length, 1);
});

t('opportunity: a one-off event gets no "a week"; under 30 minutes gives none; an uncovered event gives none', () => {
  const once = wk('Gym Club', [['2026-11-10', 17, 0, 19, 30]]);
  const opps = SA.periodOpportunities(oppInput(once, gymGroups([gymClub])));
  assert.strictEqual(opps.length, 1);
  assert.strictEqual(opps[0].weekly, false);
  assert(/would save about 1 h\. Optional/.test(opps[0].text) && !/a week/.test(opps[0].text), opps[0].text);
  assert.strictEqual(SA.periodOpportunities(oppInput(wk('Gym Club', [['2026-11-10', 17, 0, 20, 15]]), gymGroups([gymClub]))).length, 0);
  const late = wk('Gym Club', [['2026-11-10', 22, 0, 23, 0]]);
  assert.strictEqual(SA.periodOpportunities(oppInput(late, gymGroups([gymClub]))).length, 0, 'not covered: a real gap');
});

t('opportunity: a one-off event inside ANOTHER event\'s group schedule gives none (only the event\'s own schedule counts)', () => {
  const club = mkSched('Open Gym Club', ['Mon', 'Tue', 'Wed', 'Thu'], 960, 1320);
  const other = wk('Other Event', [['2026-11-10', 17, 0, 19, 0]]);
  assert.strictEqual(SA.periodNeeds(oppInput(other, gymGroups([club]))).length, 0, 'covered');
  assert.strictEqual(SA.periodOpportunities(oppInput(other, gymGroups([club]))).length, 0);
});

t('opportunity: the schedule name matches the title by prefix (3+ words) with the longer title; 1-2 word names never prefix-match', () => {
  const three = mkSched('Cheer Practice Team', ['Tue'], 960, 1260); // 4:00 PM - 9:00 PM
  const ev3 = wk('Cheer Practice Team-Test Gym', [['2026-11-10', 16, 0, 19, 30]]);
  const m = BC.webctrlMatch(gymGroups([three]), [], 'Cheer Practice Team-Test Gym', '2026-11-10', 'Test School');
  assert(m && m.name === 'Cheer Practice Team');
  assert.strictEqual(SA.periodOpportunities(oppInput(ev3, gymGroups([three]))).length, 1);
  assert.strictEqual(BC.webctrlMatch(gymGroups([mkSched('Cheer Practice', ['Tue'], 960, 1260)]), [], 'Cheer Practice-Test Gym', '2026-11-10', 'Test School'), null, 'two words');
  assert.strictEqual(BC.webctrlMatch(gymGroups([mkSched('Cheer', ['Tue'], 960, 1260)]), [], 'Cheer Practice Team', '2026-11-10', 'Test School'), null, 'one word');
  assert.strictEqual(BC.webctrlMatch(gymGroups([three]), [], 'Cheer Practice Teams', '2026-11-10', 'Test School'), null, 'no word break');
  const both = gymGroups([three, mkSched('Cheer Practice Team-Test Gym', ['Tue'], 960, 1000)]);
  assert.strictEqual(BC.webctrlMatch(both, [], 'Cheer Practice Team-Test Gym', '2026-11-10', 'Test School').name, 'Cheer Practice Team-Test Gym', 'equal name beats prefix');
});

t('opportunity: time that another event in the same space uses does not count', () => {
  const g = gymGroups([gymClub]);
  const mine = wk('Gym Club', [['2026-11-10', 17, 0, 19, 30]]); // schedule runs to 8:30 PM, 1 h extra after
  const neighbour = { x: ['Late Practice', at('2026-11-10', 19, 45), at('2026-11-10', 20, 30), 0, 'Test Gym'] };
  assert.strictEqual(SA.periodOpportunities(oppInput(Object.assign({}, mine, neighbour), g)).length, 0, 'the extra hour is used');
  const far = { x: ['Late Practice', at('2026-11-10', 21, 0), at('2026-11-10', 22, 0), 0, 'Test Gym'] };
  assert.strictEqual(SA.periodOpportunities(oppInput(Object.assign({}, mine, far), g)).length, 1, 'an event after the schedule ends does not use it');
});

// --- priority and date ranges with no weekday (WebCTRL 2026-11-12) -------------------------------------------------------
const holiday = (from, to) => ({ name: 'Temp Unoccupied', priority: 'Holiday', type: 'range', days: [], dates: [], from, to, recur: null, periods: [{ mode: 'unocc', from: 900, to: 1440 }] }); // 3 PM - 12 AM
const normalMT = mkSched('Open Club', ['Mon', 'Tue', 'Wed', 'Thu'], 1020, 1230); // 5:00 PM - 8:30 PM
const override = { name: 'Basketball Games', priority: 'Override', type: 'range', days: [], dates: [], from: '2026-11-01', to: '2026-11-30', recur: null, periods: [{ mode: 'occ', from: 1020, to: 1260 }] }; // 5 PM - 9 PM
const sixPm = (title) => wk(title, [['2026-11-10', 18, 0, 19, 0]]);
t('priority: a Holiday unoccupied range removes the Normal coverage; an Override occupied period beats it; a range outside the date does not apply', () => {
  const st = (groups) => BC.eventCoverage(sixPm('Other').e0, { tz: TZ, map, snaps, groups }).status;
  assert.strictEqual(st(gymGroups([normalMT])), 'covered', 'Normal alone');
  assert.strictEqual(st(gymGroups([normalMT, holiday('2026-02-16', '2026-12-31')])), 'short', 'Holiday unoccupied 3 PM-12 AM wins');
  assert.strictEqual(st(gymGroups([normalMT, holiday('2026-02-16', '2026-12-31'), override])), 'covered', 'Override occupied 5-9 PM wins over Holiday');
  assert.strictEqual(st(gymGroups([normalMT, holiday('2026-02-16', '2026-11-09')])), 'covered', 'range ended: Normal applies');
  const e = BD.effectiveBlocksOn([normalMT, holiday('2026-02-16', '2026-12-31')], '2026-11-10');
  assert.deepStrictEqual(e.occ, []);
  assert.deepStrictEqual(e.forcedUnocc, [[900, 1440]]);
  const e2 = BD.effectiveBlocksOn([normalMT, holiday('2026-02-16', '2026-12-31'), override], '2026-11-10');
  assert.deepStrictEqual(e2.occ, [[1020, 1260]]);
  assert.deepStrictEqual(e2.forcedUnocc, [[900, 1020], [1260, 1440]]);
});
t('priority: a Holiday unoccupied period also removes what the BAS copy shows as occupied', () => {
  // the BAS copy of Tue is occupied 5 AM - 3 PM; a Holiday range unoccupied 12 AM - 5 AM and 1 PM - 12 AM takes 1-3 PM away
  const h = Object.assign(holiday('2026-02-16', '2026-12-31'), { periods: [{ mode: 'unocc', from: 780, to: 1440 }] });
  const noon = wk('Other', [['2026-11-10', 12, 0, 14, 0]]);
  assert.strictEqual(BC.eventCoverage(noon.e0, { tz: TZ, map, snaps, groups: gymGroups([]) }).status, 'covered', 'BAS copy covers noon-2 PM');
  const r = BC.eventCoverage(noon.e0, { tz: TZ, map, snaps, groups: gymGroups([h]) });
  assert.strictEqual(r.status, 'short');
  assert.strictEqual(r.short, 60);
});

// --- the audit-log edit is matched by location (Matt 2026-11-12) ----------------------------------------------------------
const editAt = (loc, days, a, b) => {
  const blk = 'schedule "Test Evening"\nType "Weekly"\ndays: ' + days + '\nAt "' + a + '" set "Occupied"\nAt "' + b + '" set "Unoccupied"';
  const parsed = BAL.parseRows([['Date', 'Description', 'Details', 'Location', 'Operator'], ['11/11/2026 9:15:00 AM', 'Add schedule', blk, loc, 'Test Operator']]);
  return BAL.changeList(BAL.mergeStore(null, parsed.events, parsed.lastDay), {}).rows;
};
t('audit edit: only an edit at the program location or a parent area marks the line Added in WebCTRL, and its hours must overlap the gap', () => {
  const events = wk('Book Club', [['2026-11-12', 18, 0, 20, 0]]); // Thu 6-8 PM, BAS copy ends 3 PM
  const flag = (loc, a, b) => {
    const a1 = SA.computeActions(input(events, gymGroups([]), { scheduleEdits: editAt(loc, 'Thu', a || '17:30', b || '20:30') }));
    return a1.length === 1 ? a1[0].webctrl : 'no line';
  };
  assert(flag('/Test District/Test School'), 'building-level edit');
  assert(flag('/Test District/Test School/Gym'), 'edit at the program area');
  assert.strictEqual(flag('/Test District/Test School/Other Room'), null, 'another room');
  assert.strictEqual(flag('/Test District/Test School/Gym/Room 1'), null, 'a room below the program area');
  assert.strictEqual(flag('/Test District/Test School', '8:00', '10:00'), null, 'hours do not overlap the gap');
  assert.strictEqual(flag('/Test District/Test School', '6:00', '10:00'), null, 'hours overlap the gap only in the morning, the gap 6-8 PM is not spanned');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
