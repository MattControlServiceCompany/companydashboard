// emTerminalConfig.dualDuct: the terminal's own deck points decide; "Air Source Hot/Cold Deck ..." copies of the air handler's values do not
// (classifier rule 6b, item 56d45c6a). Real Blue Valley point sets, 2026-11-17: VAV-1-16 (two deck flow controls) and VAV-1-18 (one).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'equipment-matrix.js'), 'utf8');
const grab = (name) => src.match(new RegExp('function ' + name + String.raw`\([\s\S]*?\n}\r?\n`))[0];
const emTerminalConfig = new Function(
  'function emTerminalHeating(){return null;} function emElectricReheat(){return false;}' +
    grab('_emCfgEntries') + grab('_emCfgDualDuct') + grab('emTerminalConfig') + '; return emTerminalConfig;'
)();
let fail = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; }
const pts = (list) => Object.fromEntries(list.map((n) => [n, '']));
const COPIES = ['Air Source Hot Deck Duct Static', 'Air Source Hot Deck Supply Temp', 'Air Source Cold Deck Duct Static', 'Air Source Cold Deck Supply Temp'];
const one = emTerminalConfig(pts(COPIES.concat(['Air Flow', 'Flow Control / Flow Input', 'Zone Temp'])));
const two = emTerminalConfig(pts(COPIES.concat(['Air Flow', 'Hot Deck Flow Control / Flow Input', 'Cold Deck Flow Control / Flow Input', 'Zone Temp'])));
ok(!one.dualDuct, 'one flow control + air source deck copies only: not dual duct');
ok(two.dualDuct && two.deckSensors === 2, 'hot and cold deck flow controls: dual duct, 2 deck sensors');
ok(emTerminalConfig(pts(['HD Damper', 'CD Damper', 'Zone Temp'])).dualDuct, 'own HD and CD points: dual duct');
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
