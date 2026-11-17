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
      const lens = [];
      let lastParas = [];
      const mk = (cat, label, units, keys, missing, shared) => {
        const rowsById = shared ? shared.rowsById : {};
        const eqs = units.map((pts, i) => {
          const id = cat + '-u' + i;
          rowsById[id] = { id, pointsRaw: pts, points: pts };
          const nm = Object.keys(pts);
          return { id, name: 'Unit ' + (i + 1), compliance: { coveredPoints: keys.map(cp), missingPoints: (missing || []).map((k) => ({ categoryKey: k })), pumpDrive: emPumpDriveEvidence(nm) } };
        });
        const paras = _a36DetDescriptionParas({ category: cat, label, units: eqs, names: eqs.map((e) => e.name), shown: [] }, shared || { rowsById, setpointAppendix: false }, 0);
        // a group of one sentence (a heater with no proven fact besides its enable) stays one sentence
        if (paras.length > 1 || _a36DetSentenceCount(paras[0] || '') > 1) paras.forEach((p) => lens.push(_a36DetSentenceCount(p)));
        lastParas = paras;
        return paras.join(' ');
      };
      const HWKEYS = ['boilerEnable', 'hwPumpEnable', 'hwSetpoint', 'hwdp', 'hwPumpSpeed'];
      const CHWKEYS = ['chillerEnable', 'pchwpEnable', 'chwSetpoint', 'chwdp', 'schwpSpeed'];
      out.tHwSecondary = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 2 Enable', 'Secondary Pump 1 VFD Speed', 'Secondary Pump 2 VFD Speed', 'System Differential Pressure', 'Rotation Frequency: Secondary Pumps'], { 'Rotation Frequency: Secondary Pumps': 'Auto - Weekly' })], HWKEYS);
      out.tHwPlain = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 2 Enable', 'Hot Water Pump 1 Enable', 'Hot Water Pump 2 Enable'])], HWKEYS);
      out.tHwPrimary = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Primary Pump 1 Enable', 'Primary Pump 1 Speed', 'Secondary Pump 1 Speed'])], HWKEYS);
      out.tHwStatusRot = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Hot Water Pump 1 Enable', 'Hot Water Pump 1 Run Hours', 'Hot Water Pump 2 Run Hours', 'Hot Water Pump 2 Enable'])], HWKEYS);
      out.tHwEnableOnly = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 1 Status', 'Boiler 2 Enable', 'Boiler 2 Status', 'Hot Water Pump 1 Enable', 'Hot Water Pump 2 Enable', 'Hot Water Set Point'])], ['boilerEnable', 'boilerStatus', 'hwPumpEnable', 'hwSetpoint']);
      out.tHwIntegration = mk('hwp', 'Hot Water Plant', [names(['Boiler 1 Enable', 'Boiler 1 Fire Rate', 'Boiler 1 Setpoint %', 'Boiler 1 Flame Status', 'Boiler 1 Fault Code', 'Hot Water Pump 1 Enable'])], ['boilerEnable', 'hwPumpEnable']);
      out.tAirSensors = mk('ahu', 'Variable Air Volume Air Handling Unit', [names(['Supply Fan Enabled', 'Supply Fan Speed Command', 'Duct Static Pressure', 'Supply Air Temperature', 'Freezestat Alarm'])], ['sfEnable', 'sfSpeedCmd', 'dsp', 'sat', 'freezeStat'], ['oaFlow']);
      // ---- sequences (2026-11-17): the rows of en_auditseq_<pid> through _a36DetSequenceIds (the one input) ----
      let seqTab = {};
      window._a36DetSequenceIds = function (name) { return seqTab[name] || []; };
      const on = (id) => ({ id, status: 'enabled' });
      const off = (id) => ({ id, status: 'available_not_enabled' });
      const HWSEQ = [names(['Boiler 1 Enable', 'Boiler 1 Status', 'Hot Water Pump 1 Enable'])];
      seqTab = { 'Unit 1': [on('water_request_reset'), on('water_oa_limit'), on('plant_oa_lockout'), on('pump_freeze_run'), off('boiler_rotation')] };
      out.tSeq = mk('hwp', 'Hot Water Plant', HWSEQ, ['boilerEnable', 'boilerStatus', 'hwPumpEnable']);
      out.seqParas = lastParas.slice();
      seqTab = {};
      out.tSeqNone = mk('hwp', 'Hot Water Plant', HWSEQ, ['boilerEnable', 'boilerStatus', 'hwPumpEnable']);
      const AHSEQ = () => names(['Supply Fan Enabled', 'Supply Air Temperature']);
      seqTab = { 'Unit 1': [on('econ_disabled')], 'Unit 2': [on('econ_disabled')] };
      out.tSeqSome = mk('ahu', 'Variable Air Volume Air Handling Unit', [AHSEQ(), AHSEQ(), AHSEQ()], ['sfEnable', 'sat']);
      out.tSeqAll = mk('ahu', 'Variable Air Volume Air Handling Unit', [AHSEQ(), AHSEQ()], ['sfEnable', 'sat']);
      seqTab = { 'Unit 1': [on('econ_disabled'), on('co2_ventilation_reset')] };
      out.tSeqOne = mk('ahu', 'Variable Air Volume Air Handling Unit', [AHSEQ()], ['sfEnable', 'sat']);
      out.seqOneParas = lastParas.slice();
      const ECON = (ids) => { seqTab = { 'Unit 1': ids.map(on) }; return mk('ahu', 'Variable Air Volume Air Handling Unit', [AHSEQ()], ['sfEnable', 'sat']); };
      out.econAll3 = ECON(['econ_dry_bulb', 'econ_enthalpy', 'econ_diff_enthalpy']);
      out.econDry = ECON(['econ_dry_bulb']);
      out.econEnth = ECON(['econ_enthalpy']);
      out.econDryEnth = ECON(['econ_dry_bulb', 'econ_enthalpy']);
      out.econDiff = ECON(['econ_diff_enthalpy']);
      seqTab = { 'Unit 1': [on('econ_dry_bulb')], 'Unit 2': [on('econ_dry_bulb')] };
      out.econSome = mk('ahu', 'Variable Air Volume Air Handling Unit', [AHSEQ(), AHSEQ(), AHSEQ()], ['sfEnable', 'sat']);
      // a rooftop unit with its own factory controller (the building automation system schedules it and sends targets)
      const RTUPTS = names(['Supply Fan Enabled', 'Supply Air Temperature', 'Heating Valve Command', 'Outdoor Air Damper Command', 'Supply Fan VFD Speed']);
      seqTab = { 'Unit 1': [on('unit_own_controller'), on('sat_request_reset'), on('sat_oa_limit'), on('mode_fixed_setpoints'), on('econ_enthalpy')], 'Unit 2': [on('unit_own_controller'), on('sat_request_reset')] };
      out.tOwn = mk('rtu', 'Multi-Zone Rooftop Unit', [RTUPTS, RTUPTS], ['sfEnable', 'sat', 'htgValve', 'oaDampCmd', 'sfSpeedCmd']);
      out.ownParas = lastParas.slice();
      seqTab = { 'Unit 1': [on('unit_own_controller')] };
      out.tOwnOne = mk('rtu', 'Multi-Zone Rooftop Unit', [RTUPTS], ['sfEnable', 'sat', 'htgValve', 'oaDampCmd', 'sfSpeedCmd']);
      seqTab = {};
      out.tNotOwn = mk('rtu', 'Multi-Zone Rooftop Unit', [RTUPTS], ['sfEnable', 'sat', 'htgValve', 'oaDampCmd', 'sfSpeedCmd']);
      seqTab = { 'Unit 1': [on('exhaust_occupancy_run')] };
      out.tSeqEf = mk('ef', 'Exhaust Fan', [names(['Exhaust Fan Enable'])], ['schedule']);
      seqTab = { 'Unit 1': [on('unit_heater_enable'), on('heat_oa_lockout'), on('optimal_start')] };
      out.tSeqHeater = mk('heater', 'Heater', [names(['Heater Enable'])], ['enable']);
      seqTab = {};
      // the variable frequency drive is explained once in a chapter (one shared context), and again in another chapter
      const VFDHW = names(['Boiler 1 Enable', 'Secondary Pump 1 VFD Speed', 'Secondary Pump 2 VFD Speed', 'System Differential Pressure']);
      const VFDAIR = names(['Supply Fan Enabled', 'Supply Fan VFD Speed', 'Supply Air Temperature']);
      const chapter = { rowsById: {}, setpointAppendix: false, vfd: { done: false } };
      out.vfdPlant = mk('hwp', 'Hot Water Plant', [VFDHW], HWKEYS, [], chapter);
      out.vfdAir = mk('ahu', 'Variable Air Volume Air Handling Unit', [VFDAIR], ['sfEnable', 'sat'], [], chapter);
      out.vfdAirAlone = mk('ahu', 'Variable Air Volume Air Handling Unit', [VFDAIR], ['sfEnable', 'sat']);
      // terminal: the airflow measurement is stated once; a single unit never says "each"
      out.tTermMeasure = mk('vav', 'Variable Air Volume Terminal', [names(['Discharge Airflow', 'Zone Temp'])], ['discFlow']);
      out.tTermOne = mk('fpb', 'Fan-Powered Terminal', [names(['Primary Airflow', 'Damper Command', 'Terminal Fan Enable'])], ['primaryFlow', 'dampCmd', 'termFanEnable']);
      // perimeter baseboard heat: one unit, some units, every unit, absent; the one detector emTerminalConfig.perimeterHeat
      const PH = names(['Zone Temp', 'Baseboard Heat Enable', 'Damper Command']);
      const NOPH = names(['Zone Temp', 'Damper Command']);
      out.phOne = mk('fpb', 'Fan-Powered Terminal', [PH], ['dampCmd']);
      out.phSome = mk('vav', 'Variable Air Volume Terminal', [PH, NOPH, NOPH], ['dampCmd']);
      out.phAll = mk('vav', 'Variable Air Volume Terminal', [PH, PH], ['dampCmd']);
      out.phNone = mk('vav', 'Variable Air Volume Terminal', [NOPH, NOPH], ['dampCmd']);
      out.phDetect = ['Baseboard Heat Enable', 'Perimeter Heat Valve', 'Radiation Valve', 'Fin Tube Command', 'Baseboard Heater Status'].map((n) => emTerminalConfig(names(['Zone Temp', n])).perimeterHeat).concat([emTerminalConfig(NOPH).perimeterHeat]);
      out.tHeaterOne = mk('heater', 'Heater', [names(['Heater Enable'])], ['enable']);
      out.tChwStatus2 = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chiller 1 Status', 'Chilled Water Pump 1 Enable', 'Chilled Water Pump 1 Status', 'Chilled Water Pump 2 Enable', 'Chilled Water Pump 2 Status'])], ['chillerEnable', 'chillerStatus', 'pchwpEnable', 'pchwpStatus']);
      out.tChwStatus1 = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chiller 1 Status', 'Chilled Water Pump 1 Enable', 'Chilled Water Pump 1 Status'])], ['chillerEnable', 'chillerStatus', 'pchwpEnable', 'pchwpStatus']);
      out.tChwAir = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chilled Water Pump 1 Speed', 'Sys 1 Condenser Fan Stage', 'Sys 1 Compressor 1 Run', 'Sys 2 Compressor 1 Run', 'Chilled Water Setpoint', 'Chilled Water Differential Pressure', 'Chilled Water Differential Pressure Setpoint AV'], { 'Chilled Water Setpoint': '57.0', 'Chilled Water Differential Pressure Setpoint AV': '10.0 psi' })], CHWKEYS);
      out.tChwNoType = mk('chwp', 'Chilled Water Plant', [names(['Chiller 1 Enable', 'Chilled Water Pump 1 Speed', 'Chilled Water Set Point', 'Active Setpoint', 'Circuit 1 - Compressor Starts'], { 'Chilled Water Set Point': '48.9', 'Active Setpoint': '48.9' })], CHWKEYS);
      out.tAirGas = mk('rtu', 'Single Zone Rooftop Unit', [names(['Heating Gas Valve', 'Heating Stage 1', 'Cooling Stage 1', 'Cooling Stage 2', 'Supply Air Temperature', 'Supply Fan Enabled'])], ['sfEnable', 'htgValve', 'sat']);
      out.tAirCoil = mk('rtu', 'Single Zone Rooftop Unit', [names(['Heating Valve', 'Supply Air Temperature', 'Supply Fan Enabled'])], ['sfEnable', 'htgValve', 'sat']);
      out.tAirTwo = mk('ahu', 'Single Zone Air Handling Unit', [names(['Compressor A1 Relay', 'Compressor A2 Relay', 'Supply Fan Enabled', 'Supply Air Temperature']), names(['Cooling Stage 1', 'Supply Fan Enabled', 'Supply Air Temperature'])], ['sfEnable', 'sat']);
      out.paraLens = lens;
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
    ok(/consists of two boilers and two secondary hot water pumps with variable frequency drives\./.test(r.tHwSecondary) && /rotates the secondary pumps on a schedule/.test(r.tHwSecondary) && /A variable frequency drive changes the speed of an electric motor/.test(r.tHwSecondary) && /secondary pumps circulate hot water/.test(r.tHwSecondary) && !/primary|fixed speed|weekly|Tuesday/.test(r.tHwSecondary), 'hot water, variable speed secondary pumps: counts, the drive explained, rotation without frequency or day, the word secondary, no primary: ' + r.tHwSecondary);
    ok(/two hot water pumps/.test(r.tHwPlain) && !/primary|secondary/.test(r.tHwPlain) && /run at a single fixed speed/.test(r.tHwPlain) && !/varies the pump speed/.test(r.tHwPlain), 'plain pump names: no primary and no secondary; no drive point = fixed speed, no speed control claim: ' + r.tHwPlain);
    ok(/one boiler, one primary hot water pump with a variable frequency drive and one secondary hot water pump with a variable frequency drive/.test(r.tHwPrimary), 'primary appears only when the names say primary: ' + r.tHwPrimary);
    ok(!/rotate/.test(r.tHwStatusRot), 'run hours and enable points do not make a rotation sentence: ' + r.tHwStatusRot);
    ok(/one air-cooled chiller with two refrigerant circuits and two compressors/.test(r.tChwAir) && !/setpoint|10 psi|primary|secondary/.test(r.tChwAir), 'chilled water, condenser fans: air-cooled; no setpoint claim, no value, no primary or secondary: ' + r.tChwAir);
    ok(!/air-cooled|water-cooled/.test(r.tChwNoType) && !/setpoint|48\.9/.test(r.tChwNoType), 'chilled water with no condenser fan or tower point: no type; an enable-only plant makes no setpoint claim and prints no value: ' + r.tChwNoType);
    ok(/has its own controller, which sets the firing rate/.test(r.tHwEnableOnly) && !/setpoint|holds|hold/.test(r.tHwEnableOnly), 'an enable and status only plant says the boiler controller sets the firing rate and makes no setpoint claim: ' + r.tHwEnableOnly);
    ok(/integration/.test(r.tHwIntegration) && /own controllers?/.test(r.tHwIntegration) && !/does not control/.test(r.tHwIntegration), 'a plant with boiler internal points and a firing rate says integration: ' + r.tHwIntegration);
    ok(/changes the speed of an electric motor/.test(r.tHwSecondary) && /varies the pump speed to hold the differential pressure of the piping/.test(r.tHwSecondary), 'variable speed secondary pumps: the drive and the pressure control are described');
    ok(/The unit has a supply air temperature sensor/.test(r.tAirSensors) && /has no [^.]*outdoor airflow measurement/.test(r.tAirSensors), 'sensors present and sensors absent are both stated: ' + r.tAirSensors);
    ok(/protected by a freeze stat/.test(r.tAirSensors) && /request/.test(r.tAirSensors) === false, 'safeties are stated from points; no request claim without request points: ' + r.tAirSensors);
    // sequences (2026-11-17)
    ok(/The (building automation )?system resets the hot water supply temperature based on heating requests, with an outdoor air high limit\./.test(r.tSeq) && !/resets the hot water/.test(r.tSeqNone), 'the sequences input adds the merged sentence (and only with the input): ' + r.tSeq);
    ok(r.seqParas.some((p) => /resets the hot water supply temperature/.test(p) && !/locked out/.test(p)) && r.seqParas.some((p) => /locked out at high outdoor air temperatures/.test(p) && /Pump operation is continuous at low outdoor air temperatures, for freeze protection/.test(p) && /Lead boiler rotation is available but not enabled/.test(p) && !/resets the hot water/.test(p)), 'the water temperature sentence joins the temperature paragraph; lockout, freeze protection and an available rotation join the sequence paragraph: ' + JSON.stringify(r.seqParas));
    ok(/On 2 of the 3 units, the economizer is present but disabled\./.test(r.tSeqSome), 'a sequence on 2 of 3 units says "On 2 of the 3 units": ' + r.tSeqSome);
    ok(/The economizer of each unit is present but disabled\./.test(r.tSeqAll), 'a disabled economizer on every unit of a group: ' + r.tSeqAll);
    ok(/The economizer is present but disabled\./.test(r.tSeqOne) && !/On \d of the/.test(r.tSeqOne), 'a disabled economizer is stated plainly for one unit: ' + r.tSeqOne);
    const cnt = (t, re) => (t.match(re) || []).length;
    ok(cnt(r.econAll3, /The economizer (compares|uses)/g) === 1 && /The economizer compares outdoor air enthalpy with return air enthalpy and uses outdoor air for cooling when the outdoor air holds less heat \(enthalpy is the total heat content of the air including moisture\)\. It also stops using outdoor air above a high limit on outdoor air temperature or enthalpy\./.test(r.econAll3), 'three economizer ids read as one method sentence plus the high limits: ' + r.econAll3);
    ok(/The economizer uses outdoor air for cooling only below an outdoor air temperature limit\./.test(r.econDry) && cnt(r.econDry, /economizer (compares|uses)/g) === 1, 'fixed dry bulb only: one sentence: ' + r.econDry);
    ok(/The economizer uses outdoor air for cooling only below an outdoor air enthalpy limit \(enthalpy is the total heat content of the air including moisture\)\./.test(r.econEnth) && cnt(r.econEnth, /economizer (compares|uses)/g) === 1, 'fixed enthalpy only: one sentence: ' + r.econEnth);
    ok(cnt(r.econDryEnth, /economizer (compares|uses)/g) === 1 && /only below outdoor air temperature and enthalpy limits/.test(r.econDryEnth), 'dry bulb and enthalpy limits: one sentence: ' + r.econDryEnth);
    ok(cnt(r.econDiff, /economizer (compares|uses)/g) === 1 && !/high limit/.test(r.econDiff), 'comparison only: one sentence, no high limit sentence: ' + r.econDiff);
    ok(/On 2 of the 3 units, the economizer uses outdoor air for cooling only below an outdoor air temperature limit\./.test(r.econSome), 'an economizer method on some units says "On 2 of the 3 units": ' + r.econSome);
    ok(/Each unit has its own factory controller, which runs the fans\./.test(r.tOwn) && /The building automation system communicates with the controller of each unit over a network connection \(an integration\): it schedules each unit, sends it setpoints and monitors its operation\./.test(r.tOwn) && /The unit has its own factory controller/.test(r.tOwnOne), 'a unit with its own controller: the integration lead sentences: ' + r.tOwn);
    ok(!/modulate|valve|damper|enables the supply fan|varies the supply fan/.test(r.tOwn + ' ' + r.tOwnOne) && /modulates/.test(r.tNotOwn), 'a unit with its own controller prints no valve, damper or fan sentence from points (the same unit without it does): ' + r.tOwn);
    ok(/The building automation system resets the supply air setpoint that it sends to the unit on cooling requests\./.test(r.tOwn) && /low limit on the supply air setpoint that the building automation system sends to the unit/.test(r.tOwn) && /sends the unit fixed supply air setpoints/.test(r.tOwn), 'the supply air sequences of such a unit are setpoints that the building automation system sends: ' + r.tOwn);
    ok(/carbon dioxide \(CO2\) level/.test(r.tSeqOne) && r.seqOneParas.some((p) => /economizer is present but disabled/.test(p) && /carbon dioxide/.test(p)), 'the outdoor air sequences (economizer, ventilation) join one paragraph: ' + JSON.stringify(r.seqOneParas));
    ok(/The exhaust fan runs on the occupancy status of its area\./.test(r.tSeqEf) && !/starts and stops on the occupied schedule/.test(r.tSeqEf), 'an exhaust fan sequence from the occupancy status replaces the schedule sentence: ' + r.tSeqEf);
    ok(/The heater turns on when the zone heating demand exceeds a limit\./.test(r.tSeqHeater) && /Heating is locked out at high outdoor air temperatures/.test(r.tSeqHeater) && /learns the heating and cooling rate of the zone/.test(r.tSeqHeater), 'a heater with sequences: enable, lockout, learning start: ' + r.tSeqHeater);
    ok(!/which is called/.test([r.tHwSecondary, r.tHwIntegration, r.tHwPrimary].join(' ')) && /over a network connection \(an integration\)\./.test(r.tHwIntegration), 'an integration is one clause "(an integration)", never "which is called"');
    ok((r.vfdPlant + ' ' + r.vfdAir).split('A variable frequency drive changes the speed').length === 2 && /equipped with a variable frequency drive\./.test(r.vfdAir) && (r.vfdAirAlone.match(/A variable frequency drive changes the speed of an electric motor\./g) || []).length === 1, 'the variable frequency drive explanation prints once in a chapter, not once per group: ' + r.vfdPlant + ' || ' + r.vfdAir);
    ok(/measures its airflow/.test(r.tTermMeasure) && !/airflow measurement/.test(r.tTermMeasure), 'the airflow measurement is stated once (no "has an airflow measurement" after "measures its airflow"): ' + r.tTermMeasure);
    ok(!/\b[Ee]ach (terminal|unit|heater|exhaust fan)\b/.test(r.tTermOne + ' ' + r.tHeaterOne) && /The damper of the terminal modulates/.test(r.tTermOne), 'a single unit group has no "each" wording: ' + r.tTermOne + ' || ' + r.tHeaterOne);
    ok(/monitors the run status of the chiller and each pump\./.test(r.tChwStatus2) && /monitors the run status of the chiller and the pump\./.test(r.tChwStatus1), 'run status wording follows the counts: "the chiller and each pump", "the chiller and the pump": ' + r.tChwStatus2 + ' || ' + r.tChwStatus1);
    ok(![r.tHwSecondary, r.tHwPlain, r.tHwEnableOnly, r.tHwIntegration, r.tChwStatus2, r.tSeq, r.tSeqOne, r.tSeqHeater].some((x) => /(The building automation system [^.]*\. ){3}The building automation system /.test(x)), 'no four sentences in a row open with "The building automation system"');
    var every = [r.tHwSecondary, r.tHwPlain, r.tHwPrimary, r.tChwAir, r.tChwNoType, r.tHwEnableOnly, r.tHwIntegration, r.tAirGas, r.tAirCoil, r.tAirTwo, r.tAirSensors, r.tSeq, r.tSeqSome, r.tSeqAll, r.tSeqOne, r.econAll3, r.econDry, r.econEnth, r.econDryEnth, r.econDiff, r.econSome, r.tOwn, r.tOwnOne, r.tSeqEf, r.tSeqHeater, r.vfdPlant, r.vfdAir, r.tTermMeasure, r.tTermOne, r.tChwStatus2].join(' ');
    ok(!/\d\s?(°F|%|in\.|AM|PM)\b/.test(every.replace(/On \d of the \d /g, '')), 'no digits followed by °F, %, in., AM or PM in any description');
    ok(!/ASHRAE/.test(every), 'the word ASHRAE is not in a description');
    // Matt, 2026-11-17: plain statements; no contrast framing, no reason for a standard practice, no definition of a common term
    const BANNED = [/Rather than/, /instead of the automatic adjustment/, /is not fixed:/, /rather than keeping/, /share the operating hours/, /which is how/, /use less energy/, /so that the pumps/, /so that the boilers/, /locked out, which means/, /which is the boiler/, /relative humidity, which/, /freeze stat, which/, /which is the air pressure/, /which is the pressure difference/, /which is called/, /which allows?\b/];
    ok(!BANNED.some((re) => re.test(every)), 'no description uses a banned phrase (contrast framing, a reason for a standard practice, a definition of a common term): ' + BANNED.filter((re) => re.test(every)).map(String).join(' '));
    ok(r.paraLens.every(function (n) { return n >= 2; }), 'every paragraph has two or more sentences: ' + JSON.stringify(r.paraLens));
    ok(/gas heat with one heating stage/.test(r.tAirGas) && /The gas heat modulates to hold the supply air temperature/.test(r.tAirGas) && !/gas heating valve/.test(r.tAirGas) && !/heating coil valve|compressor|condensing/.test(r.tAirGas) && /two cooling stages/.test(r.tAirGas), 'gas valve: gas heat, the valve is not a coil valve, stages are counts only: ' + r.tAirGas);
    ok(/heating coil valve modulates/.test(r.tAirCoil) && !/gas/.test(r.tAirCoil), 'a heating valve with no gas point stays a heating coil valve: ' + r.tAirCoil);
    ok(/One of the two units has two compressors\./.test(r.tAirTwo) && /One of the two units has one cooling stage\./.test(r.tAirTwo), 'a fact of one unit of two prints as "One of the two units has ...": ' + r.tAirTwo);
    ok(/The terminal also controls perimeter baseboard heat\./.test(r.phOne) && !/Each terminal/.test(r.phOne), 'perimeter heat, one unit: ' + r.phOne);
    ok(/On one of the three terminals, the building automation system also controls perimeter baseboard heat\./.test(r.phSome), 'perimeter heat, some units: ' + r.phSome);
    ok(/Each terminal also controls perimeter baseboard heat\./.test(r.phAll), 'perimeter heat, every unit: ' + r.phAll);
    ok(!/perimeter/i.test(r.phNone), 'no perimeter heat sentence when no unit has the points: ' + r.phNone);
    ok(JSON.stringify(r.phDetect) === '[true,true,true,true,true,false]', 'perimeterHeat detects baseboard, perimeter, radiation and fin-tube points only: ' + JSON.stringify(r.phDetect));
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
