/**
 * gate-single-physics.js  (phase 2 of the savings-chain audit, 2026-10-13)
 *
 * Gate: every energy rule has ONE home, computations/physics.js. Fails when:
 *   1. computations/physics.js is missing a required name: KW_PER_HP, BTU_PER_KWH, BTU_PER_THERM, KBTU_PER_KWH,
 *      KBTU_PER_THERM, KBTU_PER_GAL_PROPANE, THERMS_PER_GAL_PROPANE, THERMS_PER_KWH, hpToKw, fanPowerFraction,
 *      ductStaticResetPowerSavings.
 *   2. Any other function named fanPowerFraction, ductStaticResetPowerSavings or hpToKw is defined.
 *   3. A second fan affinity formula: Math.pow(x, 3), x ** 3, x * x * x, or Math.pow(x, FAN_AFFINITY_EXPONENT)
 *      in code outside physics.js. Power versus speed goes through fanPowerFraction.
 *   4. A second duct static pressure reset formula: Math.sqrt(1 - ...) (speed from pressure) outside physics.js.
 *      Reset savings go through ductStaticResetPowerSavings.
 *   5. A hardcoded copy of a physical constant outside physics.js: 0.746 / 0.7457 (kW per hp), 3412 / 3412.14 /
 *      3413 / 3.412 / 3.41214 / 3.413 (Btu or kBtu per kWh), 0.03412 / 0.0341214 / 0.03413 (therms per kWh),
 *      293.071 / 0.000293071 (kWh per MMBtu / per Btu), 0.9153 / 0.91452 (therms per propane gallon),
 *      91.5 / 91.452 / 91452 (propane kBtu or Btu per gallon), 33475 / 0.33475 / 0.03346 (boiler hp),
 *      or 100000 as a Btu-per-therm divisor.
 *   5b. physics.js derives every propane, electric and boiler hp figure from ONE base constant
 *      (BTU_PER_GAL_PROPANE 91452, BTU_PER_KWH 3412.14, BTU_PER_HR_PER_BHP 33475).
 *   5c. One site-energy sum: computeKBtu in computations/eui.js. A second definition or any use of toKBtu fails.
 *   6. The calc template file app/ecm-calculators.js or the BAS Trends estimate does not call the shared functions.
 *
 * Test files (test-*.js, *.gate.js) are exempt: they hold the expected numbers.
 *
 * Usage: node tools/gate-single-physics.js [repo-root]
 * Exits nonzero and prints every offending file:line.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PHYSICS = 'computations/physics.js';
const DIRS = ['app', 'computations', 'extraction', 'lib', 'netlify'];
const SKIP_DIR = new Set(['node_modules', '.git', '.claude', 'data']);
const REQUIRED = [
  'KW_PER_HP',
  'BTU_PER_KWH',
  'BTU_PER_THERM',
  'KBTU_PER_KWH',
  'KBTU_PER_THERM',
  'BTU_PER_GAL_PROPANE',
  'KBTU_PER_GAL_PROPANE',
  'THERMS_PER_GAL_PROPANE',
  'THERMS_PER_KWH',
  'KWH_PER_MMBTU',
  'BTU_PER_HR_PER_BHP',
  'THERMS_PER_HR_PER_BHP',
  'FAN_AFFINITY_EXPONENT',
];
const REQUIRED_FUNCS = ['hpToKw', 'fanPowerFraction', 'ductStaticResetPowerSavings'];

// Constants as numeric tokens. A digit or dot on either side means a longer number, not this one.
const NUM = (s) => new RegExp('(?<![\\w.])' + s.replace(/\./g, '\\.') + '(?![\\w]|\\.\\d)');
const CONSTANT_RULES = [
  [NUM('0.746'), 'kW per hp (KW_PER_HP)'],
  [NUM('0.7457'), 'kW per hp (KW_PER_HP)'],
  [NUM('3412'), 'Btu per kWh (BTU_PER_KWH)'],
  [NUM('3412.14'), 'Btu per kWh (BTU_PER_KWH)'],
  [NUM('3.41214'), 'kBtu per kWh (KBTU_PER_KWH)'],
  [NUM('0.0341214'), 'therms per kWh (THERMS_PER_KWH)'],
  [NUM('293.071'), 'kWh per MMBtu (KWH_PER_MMBTU)'],
  [NUM('0.000293071'), 'kWh per Btu (KWH_PER_BTU)'],
  [NUM('0.91452'), 'therms per propane gallon (THERMS_PER_GAL_PROPANE)'],
  [NUM('91.452'), 'kBtu per propane gallon (KBTU_PER_GAL_PROPANE)'],
  [NUM('91452'), 'Btu per propane gallon (BTU_PER_GAL_PROPANE)'],
  [NUM('33475'), 'Btu/h per boiler hp (BTU_PER_HR_PER_BHP)'],
  [NUM('33,475'), 'Btu/h per boiler hp (BTU_PER_HR_PER_BHP)'],
  [NUM('0.33475'), 'therm/h per boiler hp (THERMS_PER_HR_PER_BHP)'],
  [NUM('0.03346'), 'therm/h per boiler hp (old wrong factor; use THERMS_PER_HR_PER_BHP)'],
  [NUM('0.03347'), 'therm/h per boiler hp (use THERMS_PER_HR_PER_BHP)'],
  [NUM('3413'), 'Btu per kWh (BTU_PER_KWH)'],
  [NUM('3.412'), 'kBtu per kWh (KBTU_PER_KWH)'],
  [NUM('3.413'), 'kBtu per kWh (KBTU_PER_KWH)'],
  [NUM('0.9153'), 'therms per propane gallon (THERMS_PER_GAL_PROPANE)'],
  [NUM('0.03412'), 'therms per kWh (THERMS_PER_KWH)'],
  [NUM('0.03413'), 'therms per kWh (THERMS_PER_KWH)'],
  [NUM('91.5'), 'kBtu per propane gallon (KBTU_PER_GAL_PROPANE)'],
  [/\/\s*\(?\s*100000(?![\w.,])|\(\s*100000\s*\*/, 'Btu per therm (BTU_PER_THERM)'],
];
const AFFINITY_RULES = [
  [/Math\.pow\([^;]*,\s*3(\.0*)?\s*\)/, 'Math.pow(x, 3) fan affinity law'],
  [/Math\.pow\([^;]*,\s*FAN_AFFINITY_EXPONENT\s*\)/, 'Math.pow(x, FAN_AFFINITY_EXPONENT)'],
  [/\*\*\s*3(\.0*)?(?![\w.])/, 'x ** 3 fan affinity law'],
  [/(?<![\w.])([A-Za-z_$][\w.$]*)\s*\*\s*\1\s*\*\s*\1(?![\w.$])/, 'x * x * x fan affinity law'],
];
const STATIC_RULES = [[/Math\.sqrt\(\s*1\s*-/, 'Math.sqrt(1 - pressure reduction) static reset speed']];

function isTestFile(rel) {
  const b = path.basename(rel);
  return /^test[-_]/i.test(b) || /\.gate\.js$/i.test(b) || /^gate-/i.test(b);
}

// files: { 'rel/path.js': text }. Returns an array of problem strings.
function check(files) {
  const bad = [];
  const phys = files[PHYSICS];
  if (phys == null) {
    bad.push(PHYSICS + ' is missing');
  } else {
    REQUIRED.forEach((n) => {
      if (!new RegExp('\\bvar\\s+' + n + '\\s*=').test(phys)) bad.push(PHYSICS + ' does not define ' + n);
    });
    REQUIRED_FUNCS.forEach((n) => {
      if (!new RegExp('\\bfunction\\s+' + n + '\\s*\\(').test(phys)) bad.push(PHYSICS + ' does not define ' + n);
    });
    // each figure is derived from its ONE base constant, never a second literal
    [
      ['BTU_PER_KWH', /\bvar\s+BTU_PER_KWH\s*=\s*3412\.14\s*;/],
      ['BTU_PER_GAL_PROPANE', /\bvar\s+BTU_PER_GAL_PROPANE\s*=\s*91452\s*;/],
      ['BTU_PER_HR_PER_BHP', /\bvar\s+BTU_PER_HR_PER_BHP\s*=\s*33475\s*;/],
      ['THERMS_PER_GAL_PROPANE', /\bvar\s+THERMS_PER_GAL_PROPANE\s*=\s*BTU_PER_GAL_PROPANE\s*\//],
      ['KBTU_PER_GAL_PROPANE', /\bvar\s+KBTU_PER_GAL_PROPANE\s*=\s*BTU_PER_GAL_PROPANE\s*\//],
      ['KBTU_PER_KWH', /\bvar\s+KBTU_PER_KWH\s*=\s*BTU_PER_KWH\s*\//],
      ['THERMS_PER_KWH', /\bvar\s+THERMS_PER_KWH\s*=\s*BTU_PER_KWH\s*\//],
      ['KWH_PER_MMBTU', /\bvar\s+KWH_PER_MMBTU\s*=\s*[\w.]+\s*\/\s*BTU_PER_KWH\s*;/],
      ['THERMS_PER_HR_PER_BHP', /\bvar\s+THERMS_PER_HR_PER_BHP\s*=\s*BTU_PER_HR_PER_BHP\s*\//],
    ].forEach(([n, re]) => {
      if (!re.test(phys)) bad.push(PHYSICS + ': ' + n + ' is not derived from its one base constant');
    });
  }
  const eui = files['computations/eui.js'];
  if (eui == null || !/\bfunction\s+computeKBtu\s*\(/.test(eui))
    bad.push('computations/eui.js does not define computeKBtu');
  Object.keys(files).forEach((rel) => {
    if (rel === PHYSICS || isTestFile(rel)) return;
    const lines = files[rel].split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = rel + ':' + (i + 1) + ' ';
      if (/\btoKBtu\b/.test(line)) bad.push(at + 'toKBtu is deleted; use computeKBtu (computations/eui.js)');
      if (rel !== 'computations/eui.js' && /\bfunction\s+computeKBtu\s*\(|\bcomputeKBtu\s*=\s*function/.test(line))
        bad.push(at + 'second definition of computeKBtu (the one is in computations/eui.js)');
      REQUIRED_FUNCS.forEach((n) => {
        if (new RegExp('\\bfunction\\s+' + n + '\\s*\\(|\\b' + n + '\\s*=\\s*function').test(line))
          bad.push(at + 'second definition of ' + n + ' (the one is in ' + PHYSICS + ')');
      });
      AFFINITY_RULES.concat(STATIC_RULES).forEach(([re, what]) => {
        if (re.test(line)) bad.push(at + what + ' outside ' + PHYSICS + ': ' + line.trim().slice(0, 110));
      });
      CONSTANT_RULES.forEach(([re, what]) => {
        if (/\*\s*100000\)\s*\/\s*100000/.test(line)) return; // five-decimal rounding, not a unit factor
        if (re.test(line)) bad.push(at + 'hardcoded ' + what + ': ' + line.trim().slice(0, 110));
      });
    });
  });
  const ecm = files['app/ecm-calculators.js'];
  if (ecm != null && !/\bfanPowerFraction\(/.test(ecm))
    bad.push('app/ecm-calculators.js does not call fanPowerFraction');
  const bt = files['app/bas-trends.js'];
  if (bt != null && !/\bductStaticResetPowerSavings\(/.test(bt))
    bad.push('app/bas-trends.js does not call ductStaticResetPowerSavings');
  return bad;
}

function readRepo(repo) {
  const files = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name));
      } else if (/\.(js|mjs|html)$/.test(e.name)) {
        const full = path.join(dir, e.name);
        files[path.relative(repo, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    });
  };
  DIRS.forEach((d) => walk(path.join(repo, d)));
  fs.readdirSync(repo).forEach((n) => {
    if (/\.(js|mjs|html)$/.test(n) && fs.statSync(path.join(repo, n)).isFile())
      files[n] = fs.readFileSync(path.join(repo, n), 'utf8');
  });
  return files;
}

module.exports = { check, readRepo };

if (require.main === module) {
  const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
  const bad = check(readRepo(REPO));
  if (bad.length) {
    console.log('gate-single-physics: FAIL (' + bad.length + ')');
    bad.forEach((b) => console.log('  ' + b));
    console.log(
      'Use computations/physics.js: fanPowerFraction, ductStaticResetPowerSavings, hpToKw and the unit constants.',
    );
    process.exit(1);
  }
  console.log('gate-single-physics: PASS');
}
