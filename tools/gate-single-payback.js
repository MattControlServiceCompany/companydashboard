// Gate: ONE payback formula (Phase 7, 2026-10-14).
// The owner: computations/cost-lines.js, function simplePayback = (total cost - incentive) / annual savings $ of the Energy Savings matrix.
// Fails when:
//   1. The owner does not define simplePayback exactly once, or another file defines a function of that name.
//   2. A code identifier (not text inside a string) holds the word "payback" in app/, computations/, extraction/, lib/, netlify/ or a
//      root .js/.html file, other than simplePayback. A second formula needs a name; this catches the name (payback, paybackYrs, ...).
//   3. A retired cost field is read: implCost, installCost, or a measure's .incentive (the cost lines hold the incentive now).
//   4. energy-savings.js does not call simplePayback (msrCostSummary and projCostSummary), or a page shows a payback number
//      that does not come from msrCostSummary / projCostSummary (the pricing estimator and the matrix read .years).
// Test and gate files are exempt. Run: node tools/gate-single-payback.js [repo-root]   (exit 0 = pass)
'use strict';
const fs = require('fs');
const path = require('path');

const OWNER = 'computations/cost-lines.js';
const DIRS = ['app', 'computations', 'extraction', 'lib', 'netlify'];
const SKIP_DIR = new Set(['node_modules', '.git', '.claude', 'data']);

function isTestFile(rel) {
  const b = path.basename(rel);
  return /^test[-_]/i.test(b) || /\.gate\.js$/i.test(b) || /^gate-/i.test(b);
}

// Blank out comments and the text of string literals (the ${...} code of a template literal stays), so a label such as
// 'Simple payback' is not code and a comment is not code. Keeps line breaks.
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const stack = []; // template literal nesting: 'tpl' (in template text) or 'expr' (in ${ })
  let braceDepth = [];
  let mode = 'code';
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') {
          out += ' ';
          i++;
        }
      } else if (c === '/' && d === '*') {
        out += '  ';
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += blank(src[i]);
          i++;
        }
        out += '  ';
        i += 2;
      } else if (c === "'" || c === '"') {
        out += c;
        i++;
        while (i < n && src[i] !== c && src[i] !== '\n') {
          if (src[i] === '\\') {
            out += ' ';
            i++;
          }
          out += blank(src[i]);
          i++;
        }
        out += c;
        i++;
      } else if (c === '`') {
        out += c;
        i++;
        stack.push('tpl');
        mode = 'tpl';
      } else if (c === '{' && stack.length) {
        braceDepth[braceDepth.length - 1]++;
        out += c;
        i++;
      } else if (c === '}' && stack.length) {
        if (braceDepth[braceDepth.length - 1] === 0) {
          braceDepth.pop();
          out += c;
          i++;
          mode = 'tpl';
        } else {
          braceDepth[braceDepth.length - 1]--;
          out += c;
          i++;
        }
      } else {
        out += c;
        i++;
      }
    } else {
      // template text
      if (c === '\\') {
        out += '  ';
        i += 2;
      } else if (c === '`') {
        out += c;
        i++;
        stack.pop();
        mode = 'code';
      } else if (c === '$' && d === '{') {
        out += '${';
        i += 2;
        braceDepth.push(0);
        mode = 'code';
      } else {
        out += blank(c);
        i++;
      }
    }
  }
  return out;
}

function walk(dir, repo, files) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, repo, files);
    else if (/\.(js|html)$/.test(e.name)) files.push(path.relative(repo, full).split(path.sep).join('/'));
  }
}

function check(repo) {
  const problems = [];
  const files = [];
  DIRS.forEach((d) => fs.existsSync(path.join(repo, d)) && walk(path.join(repo, d), repo, files));
  fs.readdirSync(repo).forEach((f) => /\.(js|html)$/.test(f) && files.push(f));
  const texts = {};
  files.forEach((f) => {
    texts[f] = fs.readFileSync(path.join(repo, f), 'utf8');
  });

  const owner = texts[OWNER];
  if (!owner) return ['owner file missing: ' + OWNER];
  const defs = (owner.match(/function\s+simplePayback\s*\(/g) || []).length;
  if (defs !== 1) problems.push(OWNER + ': simplePayback must be defined exactly once (found ' + defs + ')');

  files.forEach((f) => {
    if (isTestFile(f)) return;
    const code = f.endsWith('.html')
      ? // only the inline <script> blocks are code
        (texts[f].match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []).map(codeOnly).join('\n')
      : codeOnly(texts[f]);
    const lines = code.split('\n');
    lines.forEach((ln, i) => {
      const where = f + ':' + (i + 1);
      if (f !== OWNER && /function\s+simplePayback\b|\bsimplePayback\s*=\s*(function|\()/.test(ln)) {
        problems.push(where + ': second definition of simplePayback');
      }
      (ln.match(/[A-Za-z_$][\w$]*/g) || []).forEach((id) => {
        if (/payback/i.test(id) && id !== 'simplePayback')
          problems.push(where + ': identifier "' + id + '" (a second payback; call simplePayback)');
        if (/^(implCost|installCost)$/.test(id))
          problems.push(where + ': retired cost field "' + id + '" (use m.costLines)');
      });
      if (
        /\.incentive\b/.test(ln) &&
        f !== OWNER &&
        !/\bt\.incentive\b|\bx\.incentive\b|\bs\.incentive\b|\bc\.incentive\b|\bcost\.incentive\b/.test(ln)
      ) {
        problems.push(where + ': reads .incentive of a measure (use the incentive cost line)');
      }
    });
  });

  const es = texts['app/energy-savings.js'] || '';
  if (!/simplePayback\(/.test(codeOnly(es))) problems.push('app/energy-savings.js: does not call simplePayback');
  return problems;
}

if (require.main === module) {
  const repo = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
  const problems = check(repo);
  if (problems.length) {
    console.log('FAIL gate-single-payback');
    problems.forEach((p) => console.log('  ' + p));
    process.exit(1);
  }
  console.log('PASS gate-single-payback');
}
module.exports = { check, codeOnly };
