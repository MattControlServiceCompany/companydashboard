// Gate: ONE fan power rule and ONE run-hours rule (Phase 6, 2026-10-14).
// The owners:
//   computations/physics.js      fan and motor power (fanKwFromCfm, motorKwFromAmps, hpToKw, fanPowerFraction,
//                                fanMeanPowerFraction, ductStaticResetPowerSavings, FAN_W_PER_CFM)  (gate-single-physics.js)
//   computations/fan-savings.js  the unit model: fan kW choice, run hours, drive, speed profile, the three measures
//   computations/end-use.js      _fanEndUse: the building's fan end use (getEndUse 'fans')
// Fails when:
//   1. An owner is missing a function it must define.
//   2. Another file defines a function with an owner's name (a second copy of the rule).
//   3. Another file calls fanReadUnits, fanUnitModel or fanModelUnits (a template or report asks getEndUse(.., 'fans')).
//   4. Another file keeps its own fan run hours: a line with "fan" and 8760, or the fan constants (FAN_W_PER_CFM,
//      FAN_DEFAULT_ANNUAL_HOURS, FAN_CONTINUOUS_HOURS, FAN_DAYS_PER_YEAR, FAN_MONTH_DAYS) used outside the owners.
//   5. The Fan Savings template (ECM_TEMPLATES.fan_savings) does fan math itself (Math.pow, fanPowerFraction, hpToKw,
//      motorKwFromAmps, fanKwFromCfm, 8760) or does not call getEndUse(.., 'fans') and fanSavingsForUnits.
//   6. _fanEndUse does not call fanModelUnits, fanReadUnits and fanMonthWeights, or the end-use file reads a stored estimate.
//   7. Another file computes a fan kW from HP (hpToKw on a "fan" line), calls ductStaticResetPowerSavings, or sets its own fan run
//      hours (a fan*Hrs / fan*Hours variable set to a number). The BAS report (app/bas-trends.js) must call fanKwFromHp,
//      fanResetSavingsFraction and fanDefaultRunHours (one answer for a duct static pressure cut).
// Run: node tools/gate-single-fan-model.js [repo-root]   (exit 0 = pass)
'use strict';
const fs = require('fs');
const path = require('path');

const FAN = 'computations/fan-savings.js';
const END_USE = 'computations/end-use.js';
const PHYSICS = 'computations/physics.js';
const ECM = 'app/ecm-calculators.js';
const DIRS = ['app', 'computations', 'extraction', 'lib', 'netlify'];
const SKIP_DIR = new Set(['node_modules', '.git', '.claude', 'data']);

const FAN_OWNED_FUNCS = [
  'fanReadUnits',
  'fanUnitModel',
  'fanModelUnits',
  'fanSavingsForUnits',
  'fanTrendSummary',
  'fanMonthWeights',
  'fanSpeedProfile',
  'fanResetSavingsFraction',
  'fanKwFromHp',
  'fanDefaultRunHours',
  '_fanEndUse',
];
const PHYSICS_FAN_FUNCS = ['fanKwFromCfm', 'motorKwFromAmps', 'fanMeanPowerFraction'];
const FAN_CONSTANTS =
  /\b(FAN_W_PER_CFM|FAN_DEFAULT_ANNUAL_HOURS|FAN_CONTINUOUS_HOURS|FAN_DAYS_PER_YEAR|FAN_MONTH_DAYS|FAN_HP_LOAD_FACTOR|FAN_HP_MOTOR_EFF|FAN_VENTILATION_SHARE_CBECS)\b/;

function isTestFile(rel) {
  const b = path.basename(rel);
  return /^test[-_]/i.test(b) || /\.gate\.js$/i.test(b) || /^gate-/i.test(b);
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

function slice(text, startMark, endMark) {
  const a = text.indexOf(startMark);
  if (a < 0) return null;
  const b = text.indexOf(endMark, a);
  return b < 0 ? text.slice(a) : text.slice(a, b);
}

// files: { 'rel/path.js': text }. Returns an array of problem strings.
function check(files) {
  const bad = [];
  const fan = files[FAN];
  const eu = files[END_USE];
  const phys = files[PHYSICS];
  const ecm = files[ECM];

  // 1. owners define their functions
  if (fan == null) bad.push(FAN + ' is missing');
  else
    FAN_OWNED_FUNCS.filter((n) => n !== '_fanEndUse').forEach((n) => {
      if (!new RegExp('\\bfunction\\s+' + n + '\\s*\\(').test(fan)) bad.push(FAN + ' does not define ' + n);
    });
  if (eu == null || !/\bfunction\s+_fanEndUse\s*\(/.test(eu)) bad.push(END_USE + ' does not define _fanEndUse');
  if (phys == null) bad.push(PHYSICS + ' is missing');
  else
    PHYSICS_FAN_FUNCS.forEach((n) => {
      if (!new RegExp('\\bfunction\\s+' + n + '\\s*\\(').test(phys)) bad.push(PHYSICS + ' does not define ' + n);
    });

  // 2, 3, 4. other files
  Object.keys(files).forEach((rel) => {
    if (rel === FAN || rel === END_USE || rel === PHYSICS || isTestFile(rel)) return;
    if (!/^(app|computations|extraction|lib|netlify)\//.test(rel)) return;
    const lines = stripComments(files[rel]).split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = rel + ':' + (i + 1) + ' ';
      FAN_OWNED_FUNCS.concat(PHYSICS_FAN_FUNCS).forEach((n) => {
        if (new RegExp('\\bfunction\\s+' + n + '\\s*\\(|\\b' + n + '\\s*=\\s*function').test(line))
          bad.push(
            at + 'second definition of ' + n + ' (the one is in ' + FAN + ', ' + END_USE + ' or ' + PHYSICS + ')',
          );
      });
      if (/\b(fanReadUnits|fanUnitModel|fanModelUnits)\s*\(/.test(line))
        bad.push(at + 'reads the fan units directly (ask getEndUse(projId, bldgId, "fans"))');
      if (/fan/i.test(line) && /(?<![\w.])8760(?![\w.])/.test(line))
        bad.push(at + 'fan run hours of its own (8760): the rule is in ' + FAN);
      const c = line.match(FAN_CONSTANTS);
      if (c) bad.push(at + 'uses ' + c[0] + ' outside its owner (' + FAN + ' / ' + PHYSICS + ')');
      if (/fan/i.test(line) && /\bhpToKw\s*\(/.test(line))
        bad.push(at + 'fan kW from HP of its own (hpToKw): call fanKwFromHp in ' + FAN);
      if (/\bductStaticResetPowerSavings\s*\(/.test(line))
        bad.push(at + 'duct static reset savings of its own: call fanResetSavingsFraction in ' + FAN);
      if (/\bfan\w*(Hrs|Hours)\w*\s*=\s*\d/i.test(line))
        bad.push(at + 'fan run hours of its own (a number): call fanDefaultRunHours in ' + FAN);
    });
  });

  // 5. the template
  if (ecm != null) {
    const region = slice(ecm, 'fan_savings: {', '/* ── 16. SOLAR');
    if (!region) bad.push(ECM + ': the fan_savings template was not found');
    else {
      const code = stripComments(region);
      [
        [/Math\.pow|\*\*\s*\d/, 'does fan math (Math.pow)'],
        [/\bfanPowerFraction\(/, 'calls fanPowerFraction (the measures go through fanSavingsForUnits)'],
        [/\bhpToKw\(|\bmotorKwFromAmps\(|\bfanKwFromCfm\(/, 'computes fan kW itself'],
        [/(?<![\w.])8760(?![\w.])/, 'has its own run hours (8760)'],
      ].forEach(([re, why]) => {
        if (re.test(code)) bad.push(ECM + ' fan_savings template ' + why);
      });
      if (!/\bgetEndUse\([^)]*'fans'\)/.test(code))
        bad.push(ECM + " fan_savings template does not read the baseline with getEndUse(.., 'fans')");
      if (!/\bfanSavingsForUnits\(/.test(code))
        bad.push(ECM + ' fan_savings template does not call fanSavingsForUnits');
    }
  }

  // 7. the BAS report uses the fan owners
  const bas = files['app/bas-trends.js'];
  if (bas != null) {
    const body = slice(stripComments(bas), 'function btEstimateSavings(', 'function btRenderSavingsPanel(');
    if (!body) bad.push('app/bas-trends.js: btEstimateSavings was not found');
    else
      ['fanKwFromHp', 'fanResetSavingsFraction', 'fanDefaultRunHours'].forEach((n) => {
        if (!new RegExp('\\b' + n + '\\s*\\(').test(body)) bad.push('app/bas-trends.js btEstimateSavings does not call ' + n);
      });
  }

  // 6. the end use
  if (eu != null) {
    const body = slice(eu, 'function _fanEndUse', '/**\n * endUseFill');
    if (!body) bad.push(END_USE + ': _fanEndUse body not found');
    else
      ['fanModelUnits', 'fanReadUnits', 'fanMonthWeights'].forEach((n) => {
        if (!new RegExp('\\b' + n + '\\b').test(body)) bad.push(END_USE + ' _fanEndUse does not use ' + n);
      });
    if (/\.hvacLoad\.est\b/.test(stripComments(eu))) bad.push(END_USE + ': reads a stored estimate (b.hvacLoad.est)');
  }
  return bad;
}

function loadFiles(repo) {
  const root = repo || path.join(__dirname, '..');
  const files = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name));
      } else if (/\.js$/.test(e.name)) {
        const full = path.join(dir, e.name);
        files[path.relative(root, full).split(path.sep).join('/')] = fs
          .readFileSync(full, 'utf8')
          .split('\r\n')
          .join('\n');
      }
    });
  };
  DIRS.forEach((d) => walk(path.join(root, d)));
  return files;
}

module.exports = { check, loadFiles };

if (require.main === module) {
  const bad = check(loadFiles(process.argv[2] ? path.resolve(process.argv[2]) : null));
  if (bad.length) {
    console.log('gate-single-fan-model: FAIL (' + bad.length + ')');
    bad.forEach((b) => console.log('  ' + b));
    process.exit(1);
  }
  console.log('gate-single-fan-model: PASS');
}
