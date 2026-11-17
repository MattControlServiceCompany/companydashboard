// emPumpDriveEvidence: a pump amps (current) point is drive evidence (Matt 2026-11-17: fixed-speed pumps typically have no amps reading).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'equipment-matrix.js'), 'utf8');
const fn = src.match(/function emPumpDriveEvidence[\s\S]*?\n}\r?\n/)[0];
const emPumpDriveEvidence = new Function(fn + '; return emPumpDriveEvidence;')();
let fail = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; }
ok(emPumpDriveEvidence(['HWP-1 Amps', 'HWP-1 Status']), 'pump amps point = drive evidence');
ok(emPumpDriveEvidence(['Hot Water Pump 2 Current']), 'pump current point = drive evidence');
ok(emPumpDriveEvidence(['HWP-1 VFD Speed']), 'speed point = drive evidence');
ok(!emPumpDriveEvidence(['HWP-1 Status', 'Boiler 1 Status']), 'status only = no evidence');
ok(!emPumpDriveEvidence(['Boiler 1 Current Fault']), 'a boiler current point is not pump evidence');
ok(!emPumpDriveEvidence(['Boiler 1 Fan Speed']), 'a boiler fan speed is not pump evidence');
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
