// tools/test-a36-sysdesc-config.js - the configuration facts of the System Description (2026-11-15): emPlantConfig and emAirConfig
// (equipment-matrix.js, point names only) and the sentences _a36DetDescriptionParas writes from them. SYNTHETIC point lists, headless bundled Chromium.
// Each rule has a positive and a negative case:
//   boiler count; pump count by role and number; the word primary or secondary only when a pump name says it; pump speed (variable only with a speed
//   point, drive with a drive point only, constant only when no pump drive point exists); rotation only from a rotation SETTING point (never a status or
//   run hours); air-cooled only with condenser fans, water-cooled only with a cooling tower; gas heat from a gas valve point; a named setpoint SETTING
//   prints its value (a reset or active setpoint, a PID setpoint, a value with no unit for pressure does not); dual duct needs a hot and a cold deck marker;
//   a stage count is not DX; a fact prints for a group only when every unit shows it ("One of the two units ...").
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-sysdesc-config.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('a36-sysdesc-config');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof emPlantConfig === 'function' && typeof emAirConfig === 'function' && typeof _a36DetDescriptionParas === 'function', null, { timeout: 30000 });

    const r = await page.evaluate(() => {
      const names = (list, v) => {
        const o = {};
        list.forEach((n) => (o[n] = v && v[n] !== undefined ? v[n] : 'On'));
        return o;
      };
      const P = (list, v) => emPlantConfig(names(list, v));
      const A = (list, v) => emAirConfig(names(list, v));
      const out = {};
      // boilers
      out.boilers = P(['Boiler 1 Enable', 'Boiler 2 Enable', 'Boiler 2 Status', 'Heat Request 1', 'Heat Request 2', 'RunFor Maximum 3']).boilers;
      out.boilersTwin = P(['Boiler 1 Enable', 'Boiler 1 Enable ANI']).boilers;
      // pumps by role and number
      out.pumpsRoles = P(['Primary Pump 1 Status', 'Primary Pump 2 Status', 'Secondary Pump 1 VFD Speed', 'Secondary Pump 2 VFD Speed']).pumps;
      out.pumpsPlain = P(['Hot Water Pump 1 Enable', 'Hot Water Pump 2 Enable', 'HWP-1 Failure']).pumps;
      out.pumpsBareDropped = P(['Secondary CHW Pump 1 Speed', 'Secondary CHW Pump 2 Speed', 'Pump 1 Position AV', 'Pump 2 Position AV']).pumps;
      out.pumpsBareAlone = P(['Pump 1 Status', 'Pump 2 Status']).pumps;
      out.noPrimaryFromAirSource = P(['Primary Air Source Minimum', 'Secondary Outside Air Humidity Sensor', 'Boiler 1 Enable']).pumps;
      out.namedPlusPlain = P(['Chilled Water Pump 1 H-O-A', 'Secondary CHW Pump 1 Speed']).pumps;
      // speed
      out.speedVar = P(['Hot Water Pump 1 Speed', 'Hot Water Pump 2 Speed']).pumpSpeed;
      out.speedDrive = P(['HWP-1 VFD Status', 'HWP-2 VFD Status']);
      out.speedNone = P(['Hot Water Pump 1 Enable', 'Hot Water Pump 1 Amperage', 'Boiler 1 Fan Speed']);
      out.speedFault = P(['Hot Water Pump 1 VFD Fault']);
      // rotation
      const rot = { 'Rotation Frequency: Secondary Pumps': 'Auto - Weekly', 'Rotation Day: Secondary Pumps': 'Tuesdays' };
      out.rotation = P(['Secondary Pump 1 Speed'].concat(Object.keys(rot)), rot).rotation;
      out.rotStatus = P(['Pump 1 Status', 'Pump 1 Run Hours', 'Pump 2 Run Hours', 'Pump Rotation Status'], { 'Pump 1 Status': 'On', 'Pump 1 Run Hours': '43382', 'Pump 2 Run Hours': '43268', 'Pump Rotation Status': 'Running' }).rotation;
      out.rotOff = P(['Pump 1 Status', 'Rotation Frequency: Pumps'], { 'Rotation Frequency: Pumps': 'Off' }).rotation;
      out.rotNumber = P(['Pump 1 Status', 'Rotation Frequency: Pumps'], { 'Rotation Frequency: Pumps': '7' }).rotation;
      // chiller type
      out.air = P(['Chiller 1 Enable', 'Sys 1 Condenser Fan Stage', 'Sys 2 Condenser Fan Stage']).chillerType;
      out.water = P(['Chiller 1 Enable', 'Cooling Tower Fan Speed', 'Condenser Water Pump 1 Status']).chillerType;
      out.typeNone = P(['Chiller 1 Enable', 'Circuit 1 - Condenser Refrigerant Pressure', 'Circuit 2 - Condenser Refrigerant Pressure']).chillerType;
      out.typeBoth = P(['Chiller 1 Enable', 'Condenser Fan Stage', 'Condenser Water Pump 1 Status']).chillerType;
      out.circuits = P(['Chiller 1 Enable', 'Sys 1 Compressor 1 Run', 'Sys 1 Compressor 2 Run', 'Sys 2 Compressor 1 Run', 'Sys 1 Suction Pressure']);
      out.leadSystem = P(['Chiller 1 Enable', 'Lead System']).pumps;
      // valves
      out.valves = P(['Boiler 1 Enable', 'Boiler 2 Enable', 'Boiler 1 Isolation Valve Status', 'Boiler 2 Isolation Valve Status', 'Hot Water Bypass Valve Signal']);
      out.valvesNone = P(['Boiler 1 Enable', 'Boiler 2 Enable', 'Boiler 1 Isolation Valve Status', 'Bypass Valve Not At Commanded Position']);
      // setpoints
      out.sp = P(['Chilled Water Setpoint', 'Chilled Water Differential Pressure Setpoint AV', 'Hot Water Set Point'], { 'Chilled Water Setpoint': '57.0', 'Chilled Water Differential Pressure Setpoint AV': '10.0 psi', 'Hot Water Set Point': '160' });
      out.spReset = P(['Chilled Water Setpoint', 'Chilled Water Set Point Reset Signal'], { 'Chilled Water Setpoint': '57.0', 'Chilled Water Set Point Reset Signal': '60' });
      out.spActive = P(['Chilled Water Set Point', 'Active Setpoint'], { 'Chilled Water Set Point': '48.9', 'Active Setpoint': '48.9' });
      out.spPid = P(['Secondary Pump Speed PID / Setpoint', 'System Differential Pressure'], { 'Secondary Pump Speed PID / Setpoint': '5.7', 'System Differential Pressure': '6.4 psi' });
      out.spNoUnit = P(['Chilled Water Differential Pressure Setpoint'], { 'Chilled Water Differential Pressure Setpoint': '10' });
      // air
      out.ddOnly = A(['HD Heating Valve', 'HD Supply Air Temperature']).dualDuct;
      out.dd = A(['HD Heating Valve', 'CD Supply Air Temperature']).dualDuct;
      out.ddWords = A(['Hot Deck Supply Air Sensor Low Limit', 'Cold Deck Supply Air Temperature']).dualDuct;
      out.stageOnly = A(['Cooling Stage 1', 'Cooling Stage 2', 'Heating Stage 1']);
      out.gas = A(['Heating Gas Valve', 'Heating Stage 1']);
      out.fans = A(['Supply Fan 1A Status', 'Supply Fan 1B Status', 'Supply Fan 1C Status', 'Supply Fan VFD Speed', 'Return Fan VFD Speed', 'Relief Fan Low Static Safety']);
      out.fansEach = A(['Supply Fan 1 VFD Speed', 'Supply Fan 2 VFD Speed']).fans;
      out.fansNoDrive = A(['Supply Fan Speed', 'Supply Fan Status']).fans;
      out.ervFans = A(['ERV Supply Fan VFD Speed', 'ERV Exhaust Fan VFD Speed', 'Supply Fan VFD Speed']);
      out.cu = A(['Condensing Unit Alarm State', 'Compressor A1 Relay', 'Compressor A2 Relay', 'Compressor B1 Relay', 'Compressor B2 Relay', 'Circuit A Starts', 'Circuit B Starts']);
      out.comp = A(['Compressor-1 Overload Lockout', 'Overload Lockout Compressor-1', 'Compressor-2 Overload Lockout', 'Condenser Fan 1 Status', 'Condenser Fan 2 Status', 'Compressor OA Temp Lockout Set Point']);

      // ---- sentences: a hand built group of units through _a36DetDescriptionParas ----
      const cp = (key) => ({ categoryKey: key, ashrae36PointName: key, categoryLabel: key, pointName: key });
      const mk = (cat, label, units, keys) => {
        const rowsById = {};
        const eqs = units.map((pts, i) => {
          const id = 'u' + i;
          rowsById[id] = { id, pointsRaw: pts, points: pts };
          const nm = Object.keys(pts);
          return { id, name: 'Unit ' + (i + 1), compliance: { coveredPoints: keys.map(cp), pumpDrive: emPumpDriveEvidence(nm) } };
        });
        return _a36DetDescriptionParas({ category: cat, label, units: eqs, names: eqs.map((e) => e.name), shown: [] }, { rowsById, setpointAppendix: false }, 0).join(' ');
      };
      const HWKEYS = ['boilerEnable', 'hwPumpEnable', 'hwSetpoint', 'hwdp', 'hwPumpSpeed'];
      const CHWKEYS = ['chillerEnable', 'pchwpEnable', 'chwSetpoint', 'chwdp', 'schwpSpeed'];
      out.tHwSecondary = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 2 Enable', 'Secondary Pump 1 VFD Speed', 'Secondary Pump 2 VFD Speed', 'System Differential Pressure', 'Rotation Frequency: Secondary Pumps'], { 'Rotation Frequency: Secondary Pumps': 'Auto - Weekly' })], HWKEYS);
      out.tHwPlain = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 2 Enable', 'Hot Water Pump 1 Enable', 'Hot Water Pump 2 Enable'])], HWKEYS);
      out.tHwPrimary = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Primary Pump 1 Enable', 'Primary Pump 1 Speed', 'Secondary Pump 1 Speed'])], HWKEYS);
      out.tHwStatusRot = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Hot Water Pump 1 Enable', 'Hot Water Pump 1 Run Hours', 'Hot Water Pump 2 Run Hours', 'Hot Water Pump 2 Enable'])], HWKEYS);
      out.tChwAir = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chilled Water Pump 1 Speed', 'Sys 1 Condenser Fan Stage', 'Sys 1 Compressor 1 Run', 'Sys 2 Compressor 1 Run', 'Chilled Water Setpoint', 'Chilled Water Differential Pressure', 'Chilled Water Differential Pressure Setpoint AV'], { 'Chilled Water Setpoint': '57.0', 'Chilled Water Differential Pressure Setpoint AV': '10.0 psi' })], CHWKEYS);
      out.tChwNoType = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chilled Water Pump 1 Speed', 'Chilled Water Set Point', 'Active Setpoint', 'Circuit 1 - Compressor Starts'], { 'Chilled Water Set Point': '48.9', 'Active Setpoint': '48.9' })], CHWKEYS);
      out.tAirGas = mk('rtu', 'Single Zone Rooftop Unit', [names(['Heating Gas Valve', 'Heating Stage 1', 'Cooling Stage 1', 'Cooling Stage 2', 'Supply Air Temperature', 'Supply Fan Enabled'])], ['sfEnable', 'htgValve', 'sat']);
      out.tAirCoil = mk('rtu', 'Single Zone Rooftop Unit', [names(['Heating Valve', 'Supply Air Temperature', 'Supply Fan Enabled'])], ['sfEnable', 'htgValve', 'sat']);
      out.tAirTwo = mk('ahu', 'Single Zone Air Handling Unit', [names(['Compressor A1 Relay', 'Compressor A2 Relay', 'Supply Fan Enabled', 'Supply Air Temperature']), names(['Cooling Stage 1', 'Supply Fan Enabled', 'Supply Air Temperature'])], ['sfEnable', 'sat']);
      return out;
    });

    // boilers
    ok(r.boilers === 2 && r.boilersTwin === 1, 'boiler count: distinct "Boiler N" numbers (heat requests and RunFor points are not boilers) = ' + r.boilers);
    // pumps
    ok(r.pumpsRoles.primary === 2 && r.pumpsRoles.secondary === 2 && r.pumpsRoles.plain === 0, 'pump count by role AND number: primary 2 + secondary 2 (not 2 total): ' + JSON.stringify(r.pumpsRoles));
    ok(r.pumpsPlain.plain === 2 && r.pumpsPlain.primary === 0 && r.pumpsPlain.secondary === 0, 'plain pump names give plain pumps, never primary or secondary: ' + JSON.stringify(r.pumpsPlain));
    ok(r.pumpsBareDropped.secondary === 2 && r.pumpsBareDropped.plain === 0, 'a bare "Pump N Position" name is dropped when named pumps exist: ' + JSON.stringify(r.pumpsBareDropped));
    ok(r.pumpsBareAlone.plain === 2, 'a bare "Pump N" name counts when it is the only pump name: ' + JSON.stringify(r.pumpsBareAlone));
    ok(r.noPrimaryFromAirSource.primary === 0 && r.noPrimaryFromAirSource.secondary === 0, '"Primary Air Source" and "Secondary Outside Air Humidity" are not pumps: ' + JSON.stringify(r.noPrimaryFromAirSource));
    ok(r.namedPlusPlain.plain === 1 && r.namedPlusPlain.secondary === 1, 'a plain chilled water pump and a secondary pump both count: ' + JSON.stringify(r.namedPlusPlain));
    // speed
    ok(r.speedVar.plain === 'variable', 'a pump speed point = variable speed');
    ok(r.speedDrive.pumpSpeed.plain === 'drive' && r.speedDrive.noPumpDrive === false, 'a drive status point and no speed point = a drive, not variable speed, not constant: ' + JSON.stringify(r.speedDrive.pumpSpeed));
    ok(r.speedNone.noPumpDrive === true && r.speedNone.pumpSpeed.plain === 'none', 'enable and amperage only (a boiler fan speed is not a pump drive) = no drive point = constant speed: ' + JSON.stringify(r.speedNone.pumpSpeed));
    ok(r.speedFault.pumpSpeed.plain === 'drive', 'a VFD Fault point alone is a drive, not variable speed');
    // rotation
    ok(r.rotation && r.rotation.frequency === 'weekly' && r.rotation.day === 'Tuesdays' && r.rotation.role === 'secondary', 'rotation from the rotation setting points ("Auto - Weekly", "Tuesdays"): ' + JSON.stringify(r.rotation));
    ok(r.rotStatus === null, 'no rotation from a status, run hours or a rotation status point');
    ok(r.rotOff === null && r.rotNumber === null, 'a rotation setting of Off, or a bare number, is not a rotation');
    // chiller type
    ok(r.air === 'air', 'condenser fan points on the chiller = air-cooled');
    ok(r.water === 'water', 'cooling tower or condenser water pump points = water-cooled');
    ok(r.typeNone === '', 'condenser refrigerant pressure points alone do not state a type');
    ok(r.typeBoth === '', 'condenser fans and condenser water together do not state a type');
    ok(r.circuits.circuits === 2 && r.circuits.compressors === 3, 'refrigerant circuits (Sys N) and compressors counted by number: ' + r.circuits.circuits + ' circuits, ' + r.circuits.compressors + ' compressors');
    ok(r.leadSystem.primary === 0 && r.leadSystem.secondary === 0 && r.leadSystem.plain === 0, '"Lead System" is not a pump lead');
    // valves
    ok(r.valves.bypassValve === true && r.valves.boilerIsolation === true, 'bypass valve and isolation valve on every boiler');
    ok(r.valvesNone.bypassValve === false && r.valvesNone.boilerIsolation === false, '"Bypass Valve Not At Commanded Position" is an alarm, not a bypass valve; an isolation valve on one of two boilers is not stated');
    // setpoints
    ok(!r.sp.chwSetpoint && r.sp.dpSetpoint && r.sp.dpSetpoint.n === 10 && r.sp.dpSetpoint.unit === 'psi' && !r.sp.hwSetpoint, 'a named DP setpoint gives its value (10 psi); supply temperature setpoints give none (they can be reset outputs): ' + JSON.stringify([r.sp.chwSetpoint, r.sp.dpSetpoint, r.sp.hwSetpoint]));
    ok(r.spReset.chwSetpoint === null, 'a reset signal point on the plant: no setpoint value');
    ok(r.spActive.chwSetpoint === null, 'an active setpoint point on the plant: no setpoint value');
    ok(r.spPid.dpSetpoint === null && r.spPid.chwSetpoint === null && r.spPid.hwSetpoint === null, 'a PID loop setpoint is not a setpoint setting');
    ok(r.spNoUnit.dpSetpoint === null, 'a differential pressure setpoint with no unit is not printed');
    // air
    ok(r.ddOnly === false && r.dd === true && r.ddWords === true, 'dual duct needs a hot deck marker AND a cold deck marker (HD alone: no)');
    ok(r.stageOnly.compressors === 0 && r.stageOnly.condensingUnits === 0 && r.stageOnly.gasHeat === false && r.stageOnly.coolingStages === 2 && r.stageOnly.heatingStages === 1, 'cooling stage points alone: stage counts only, no DX, no gas or electric heat');
    ok(r.gas.gasHeat === true, 'a "Heating Gas Valve" point = gas heat');
    ok(r.fans.fans.length === 2 && r.fans.fans[0].type === 'supply' && r.fans.fans[0].n === 3 && r.fans.fans[0].each === false && r.fans.fans[1].type === 'return', 'fan array of three supply fans on one drive; a relief fan with no drive point is not listed: ' + JSON.stringify(r.fans.fans));
    ok(r.fansEach.length === 1 && r.fansEach[0].n === 2 && r.fansEach[0].each === true, 'numbered fans each with a drive: ' + JSON.stringify(r.fansEach));
    ok(r.fansNoDrive.length === 0, 'a fan speed point with no VFD or drive name states no drive');
    ok(r.ervFans.erv.present && r.ervFans.erv.driveFans.join(',') === 'supply,exhaust' && r.ervFans.fans.length === 1 && r.ervFans.fans[0].type === 'supply', 'the fans of an energy recovery ventilator are its own: ' + JSON.stringify(r.ervFans.erv));
    ok(r.cu.condensingUnits === 1 && r.cu.compressors === 4 && r.cu.circuits === 2, 'condensing unit with four compressors in two circuits');
    ok(r.comp.compressors === 2 && r.comp.condenserFans === 2 && r.comp.circuits === 0, 'compressor numbers counted once each (two name orders), two condenser fans: ' + JSON.stringify([r.comp.compressors, r.comp.condenserFans]));

    // sentences
    ok(/The plant has two boilers and two variable-speed secondary hot water pumps\./.test(r.tHwSecondary) && /rotates the secondary pumps weekly\./.test(r.tHwSecondary) && /The secondary pump speed modulates/.test(r.tHwSecondary) && !/primary|constant speed/.test(r.tHwSecondary), 'hot water, secondary pumps: counts, variable speed, rotation, the word secondary, no primary: ' + r.tHwSecondary);
    ok(/two hot water pumps/.test(r.tHwPlain) && !/primary|secondary/.test(r.tHwPlain) && !/constant speed/.test(r.tHwPlain) && /enables the boilers and hot water pumps/.test(r.tHwPlain), 'plain pump names: no primary and no secondary in the text; no drive point = nothing said about speed: ' + r.tHwPlain);
    ok(/one boiler, one variable-speed primary hot water pump and one variable-speed secondary hot water pump/.test(r.tHwPrimary), 'primary appears only when the names say primary: ' + r.tHwPrimary);
    ok(!/rotate/.test(r.tHwStatusRot), 'run hours and enable points do not make a rotation sentence: ' + r.tHwStatusRot);
    ok(/one air-cooled chiller with two refrigerant circuits and two compressors/.test(r.tChwAir) && /supply temperature at its setpoint/.test(r.tChwAir) && /differential pressure at 10 psi/.test(r.tChwAir) && !/primary|secondary/.test(r.tChwAir), 'chilled water, condenser fans: air-cooled; supply temperature at its setpoint, DP at 10 psi; no primary or secondary: ' + r.tChwAir);
    ok(!/air-cooled|water-cooled/.test(r.tChwNoType) && /at its setpoint/.test(r.tChwNoType) && !/48\.9/.test(r.tChwNoType), 'chilled water with no condenser fan or tower point: no type; an active setpoint is not printed as a value: ' + r.tChwNoType);
    ok(/gas heat with one heating stage/.test(r.tAirGas) && /gas heating valve modulates/.test(r.tAirGas) && !/heating coil valve|compressor|condensing/.test(r.tAirGas) && /two cooling stages/.test(r.tAirGas), 'gas valve: gas heat, the valve is not a coil valve, stages are counts only: ' + r.tAirGas);
    ok(/heating coil valve modulates/.test(r.tAirCoil) && !/gas/.test(r.tAirCoil), 'a heating valve with no gas point stays a heating coil valve: ' + r.tAirCoil);
    ok(/One of the two units has two compressors\./.test(r.tAirTwo) && /One of the two units has one cooling stage\./.test(r.tAirTwo), 'a fact of one unit of two prints as "One of the two units has ...": ' + r.tAirTwo);
    ok(errs.length === 0, 'no page error' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
