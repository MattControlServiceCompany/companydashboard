// Test: the room use class of the Equipment Matrix (Matt 2026-11-19): dense rooms (the room CO2 option), and the rooms that never need a room CO2
// sensor (exempt by name). SYNTHETIC names only. Run: node tools/test-dense-room-class.js   (exit 0 = all pass)
// Loads the real classifier text of app/equipment-matrix.js (from EM_SPACE_TYPE_ZONE_TERMINAL_CATS to _emSpaceTypeConfigFlagOverrides).
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const em = fs.readFileSync(path.join(__dirname, '..', 'app', 'equipment-matrix.js'), 'utf8');
const sb = {};
vm.createContext(sb);
vm.runInContext(em.slice(em.indexOf('var EM_SPACE_TYPE_ZONE_TERMINAL_CATS'), em.indexOf('/* _emSpaceTypeConfigFlagOverrides')), sb);
let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};
const spaceType = (name, cat) => {
  const c = sb.emClassifySpaceType({ category: cat || 'vav', equipName: name });
  return c ? c.spaceType : null;
};

// 1. dense rooms: positive names
['Meeting Room 105 | VAV-1', 'Conference 127 - VB-127', 'Large Conference 121 | X', 'Training Room 149 | X', 'Program Room 114 | X', 'Story Time Room | X',
  'Storytime 109 | X', 'Computer Lab 100D East | X', 'Classroom 3 | X', 'Community Room | X', 'Multipurpose Room | X', 'Multi-Purpose | X', 'Auditorium | X',
  '203 Cultural Commons | X', 'Stage 110 | X', 'Maker Space 101 | X', 'Makerspace | X', 'Round Meeting 130 | X'].forEach((nm) => {
  assert.strictEqual(sb.emIsDenseOccupancyRoom(nm), true, nm + ' is dense');
});
ok('dense class: meeting, conference, training, program, story time, computer lab, classroom, community room, multipurpose, auditorium, commons, stage, maker space');
// 2. not dense: study rooms, public floor, staff rooms, back of house, tag-only names
['Study Room 1 | X', 'Tech Study | X', 'Adult Area | X', 'Children Collection | X', 'Stacks | X', 'Office 3 | X', 'Break Room | X', 'Work Room | X', 'Lobby | X',
  'Pallets 112 | X', 'Mothers Room | X', 'Spine 100E North | X', 'Vending/Phones 100B | X', 'VAV-1-08', 'AHU-1 - Roof', 'Programmer Office | X', 'Restroom 1 | X'].forEach((nm) => {
  assert.strictEqual(sb.emIsDenseOccupancyRoom(nm), false, nm + ' is not dense');
});
ok('dense class: study rooms, public floor, offices, back-of-house rooms, tag-only names and restrooms are not dense');
// 3. use class order: exempt first, then dense, study, staff, public
assert.strictEqual(sb.emRoomUseClass('Women RR1Q01 | VBR-1'), 'exempt');
assert.strictEqual(sb.emRoomUseClass('Meeting Room 1 | X'), 'dense');
assert.strictEqual(sb.emRoomUseClass('Study Room 2 | X'), 'study');
assert.strictEqual(sb.emRoomUseClass('Office 3 | X'), 'staff');
assert.strictEqual(sb.emRoomUseClass('Adult Area | X'), 'public');
assert.strictEqual(sb.emRoomUseClass('VAV-1-08'), 'public');
ok('room use class: exempt, dense, study, staff, public');

// 4. new exempt-by-name rooms (Matt 2026-11-19)
const exemptNames = {
  restroom: ['Men RR1Q02 - VBR-RR1Q02', 'Women RR1Q01 - VBR-RR1Q01', 'Women RR | VAV-2', 'Women 120 / Men 119 | VBR-09', 'Women 159 - VAV-16', 'Men 119 | VAV-3', "Women's RR1Q03 - VAV-1", 'Restroom 011| VRF-03'],
  custodial: ['Custodial 113 - VBR-113', 'Cust/Laundry J1Q01 - VBR-J1Q01', 'Janitors 104 | FC-02', 'Laundry 137 | FCU-137', 'Janitor Closet | VAV-9'],
  networking: ['Telecom 123 | VAV-20', 'Telecom T1Q01 | AC-2A'],
  penthouse: ['Penthouse | VAV-22'],
  corridor: ['Vestibule 101 | VAV-11', 'Entry Vestibule - VAV-41', 'Corrdior 104A | FPB-05', 'Corridor 2 | VAV-1'],
  elevator_lobby: ['Elevator Vestibule | VAV-5'],
};
Object.keys(exemptNames).forEach((t) => {
  exemptNames[t].forEach((nm) => {
    assert.strictEqual(spaceType(nm), t, nm + ' -> ' + t);
    assert.strictEqual(sb.EM_SPACE_TYPE_EXEMPT_CATS[t].co2, true, t + ' is exempt from room CO2');
    assert.strictEqual(sb.emRoomUseClass(nm), 'exempt', nm + ' is class exempt');
  });
});
ok('exempt by name: RR, bare Men/Women with a number, custodial, janitor, laundry, Cust/Laundry, telecom, penthouse, vestibule, Corrdior');
// 5. rooms that must stay as they are (not exempt)
['Pallets 112 | X', 'Ship/Rec 115 | X', 'Courier 114 | X', 'Central Supply 118 | X', 'Mothers Room 111A | X', 'Spine 100E North | X', 'Vending/Phones 100B | X',
  'Meeting Room 1 | X', 'Adult Area | X', 'Study Room 2 | X', 'Mens Club Room | X', 'Women Health Section | X', 'Program Room 114 | X'].forEach((nm) => {
  assert.strictEqual(spaceType(nm), null, nm + ' stays unclassified');
});
ok('not exempt: Pallets, Ship/Rec, Courier, Central Supply, Mothers Room, Spine, Vending, and ordinary occupied rooms');
// 6. the guard: AHU names never classify (a room prefix names the machine location)
assert.strictEqual(spaceType('Penthouse | AHU-1', 'ahu'), null);
assert.strictEqual(spaceType('Telecom | RTU-1', 'rtu'), null);
ok('air handlers and rooftop units never classify');
console.log('\n' + n + ' checks passed');
