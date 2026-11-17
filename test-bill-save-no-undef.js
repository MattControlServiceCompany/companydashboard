// test-bill-save-no-undef.js
// Static check (2026-11-17): the bill save functions must not read a name that is declared nowhere.
// Cause: _saveSinglePDFBill read `kwCost` after a refactor removed its declaration. It threw a ReferenceError
// AFTER the bill record was written, so every Save added a duplicate record and nothing reached the meter.
// There is no eslint in this repo, so this is a focused no-undef check:
//   1. tokenize the function source (comments, strings, template literals and regex literals are skipped),
//   2. collect every name declared anywhere inside the function (const/let/var patterns, parameters, nested
//      functions, catch parameters), 3. every other name that is read must exist in the page global scope.
// Scope is one set per function (an over-approximation): it finds a name declared nowhere, which is the bug class.
// A built-in mutation proves the check: removing `kwCost` from the declaration must be reported.
// Run: CH_TMP_ROOT=<scratch dir> node test-bill-save-no-undef.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const FILE = path.join(REPO, 'app', 'bill-analysis.js');
const TARGETS = [
  '_saveSinglePDFBill',
  '_saveSinglePDFBillCore',
  'savePDFData',
  '_setPdfSaveButtonsBusy',
  '_exposeSavedBillRecord',
  '_findIdenticalUnassignedSavedBill',
  '_savedBillContentKey',
];
const KEYWORDS = new Set(
  (
    'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return super switch this throw try typeof var void while with yield ' +
    'true false null undefined NaN Infinity arguments'
  ).split(' '),
);
// Found by this check on 2026-11-17 and reported to the Manager, NOT fixed here (a fix changes which meter a bill
// can land on): _saveSinglePDFBillCore "Second try" reads `udProj`, which is declared nowhere (since 7e3d8e17).
// It throws inside the meter-assignment try/catch, so a bill with no account match is held in Saved Bills with a
// toast. Remove the entry when the code is fixed; the check fails if the entry is no longer needed.
const KNOWN_UNDECLARED = {}; // udProj fixed 2026-11-17 (getUDBldgs)
const PRE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do']);

// ---- tokenizer ----------------------------------------------------------
function tokenize(src, start, stopAtBrace) {
  const toks = [];
  let i = start;
  let depth = 0;
  const prev = () => toks[toks.length - 1];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      toks.push({ t: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      while (src[j] !== '`') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$' && src[j + 1] === '{') {
          const inner = tokenize(src, j + 2, true);
          toks.push(...inner.toks);
          j = inner.end + 1;
        } else j++;
      }
      toks.push({ t: 'str', v: '`' });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j) });
      i = j;
    } else if (c === '/') {
      const p = prev();
      const regexOk = !p || (p.t === 'punct' && !')]}'.includes(p.v)) || (p.t === 'id' && PRE_REGEX.has(p.v));
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (src[j] !== '/' || inClass) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          j++;
        }
        j++;
        while (/[a-z]/.test(src[j])) j++;
        toks.push({ t: 'str', v: 'regex' });
        i = j;
      } else {
        toks.push({ t: 'punct', v: '/' });
        i++;
      }
    } else {
      if (c === '{') depth++;
      if (c === '}') {
        if (stopAtBrace && depth === 0) return { toks, end: i };
        depth--;
      }
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      const op = three === '...' ? three : ['=>', '?.', '&&', '||', '??', '==', '!=', '<=', '>='].includes(two) ? two : c;
      toks.push({ t: 'punct', v: op });
      i += op.length;
    }
  }
  return { toks, end: i };
}

function functionSource(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', m.index)); // body brace (params hold no braces for these functions)
  const t = tokenize(src, i + 1, true);
  return src.slice(m.index, t.end + 1);
}

// ---- declarations -------------------------------------------------------
function declaredNames(toks) {
  const declared = new Set();
  let k = 0;
  const isP = (x, v) => x && x.t === 'punct' && x.v === v;
  // Binding pattern at toks[k]; adds the declared names; leaves k after the pattern.
  function pattern() {
    const x = toks[k];
    if (!x) return;
    if (x.t === 'id') {
      declared.add(x.v);
      k++;
    } else if (isP(x, '{') || isP(x, '[')) {
      const close = x.v === '{' ? '}' : ']';
      k++;
      while (toks[k] && !isP(toks[k], close)) {
        if (isP(toks[k], ',')) k++;
        else if (isP(toks[k], '...')) k++;
        else if (x.v === '{' && toks[k].t === 'id' && isP(toks[k + 1], ':')) {
          k += 2; // key: target
          pattern();
          initializer();
        } else {
          pattern();
          initializer();
        }
      }
      k++;
    } else {
      k++;
    }
  }
  function initializer() {
    if (!isP(toks[k], '=')) return;
    k++;
    let d = 0;
    while (toks[k]) {
      const x = toks[k];
      if (x.t === 'punct' && '([{'.includes(x.v)) d++;
      else if (x.t === 'punct' && ')]}'.includes(x.v)) {
        if (d === 0) return;
        d--;
      } else if (d === 0 && (isP(x, ',') || isP(x, ';') || (x.t === 'id' && (x.v === 'of' || x.v === 'in')))) return;
      k++;
    }
  }
  function params(open) {
    // toks[open] is '('
    k = open + 1;
    while (toks[k] && !isP(toks[k], ')')) {
      if (isP(toks[k], ',') || isP(toks[k], '...')) k++;
      else {
        pattern();
        initializer();
      }
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    if (x.t === 'id' && (x.v === 'const' || x.v === 'let' || x.v === 'var')) {
      k = i + 1;
      for (;;) {
        pattern();
        initializer();
        if (isP(toks[k], ',')) k++;
        else break;
      }
    } else if (x.t === 'id' && x.v === 'function') {
      let j = i + 1;
      if (isP(toks[j], '*')) j++;
      if (toks[j] && toks[j].t === 'id') {
        declared.add(toks[j].v);
        j++;
      }
      if (isP(toks[j], '(')) params(j);
    } else if (x.t === 'id' && x.v === 'catch' && isP(toks[i + 1], '(')) {
      params(i + 1);
    } else if (isP(x, '=>')) {
      const p = toks[i - 1];
      if (p && p.t === 'id') declared.add(p.v);
      else if (isP(p, ')')) {
        let d = 0;
        let j = i - 1;
        for (; j >= 0; j--) {
          if (isP(toks[j], ')')) d++;
          else if (isP(toks[j], '(')) {
            d--;
            if (d === 0) break;
          }
        }
        params(j);
      }
    }
  }
  return declared;
}

function freeNames(fnSrc) {
  const { toks } = tokenize(fnSrc, 0, false);
  const declared = declaredNames(toks);
  const free = new Set();
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    if (x.t !== 'id' || KEYWORDS.has(x.v) || declared.has(x.v)) continue;
    const p = toks[i - 1];
    const n = toks[i + 1];
    if (p && p.t === 'punct' && (p.v === '.' || p.v === '?.')) continue; // property
    if (p && p.t === 'punct' && (p.v === '{' || p.v === ',') && n && n.t === 'punct' && n.v === ':') continue; // object key
    free.add(x.v);
  }
  return free;
}

(async () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const sources = {};
  TARGETS.forEach((n) => (sources[n] = functionSource(src, n)));
  const free = {};
  const all = new Set();
  TARGETS.forEach((n) => {
    free[n] = freeNames(sources[n]);
    free[n].forEach((v) => all.add(v));
  });
  // The mutation: the 2026-11-17 bug. `kwCost` removed from the declaration must show up as free.
  const mutated = sources._saveSinglePDFBillCore.replace('kwh: usageQty, kwCost,', 'kwh: usageQty,');
  const mutFree = freeNames(mutated);
  all.add('kwCost');

  const context = await launchBrowser('bill-save-no-undef');
  let pass = 0;
  const failures = [];
  try {
    const page = await context.newPage();
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    const missing = {};
    for (const name of all) {
      const t = await page.evaluate('typeof ' + name);
      if (t === 'undefined') missing[name] = true;
    }
    for (const n of TARGETS) {
      const known = KNOWN_UNDECLARED[n] || [];
      const bad = [...free[n]].filter((v) => missing[v] && !known.includes(v));
      const stale = known.filter((v) => !(free[n].has(v) && missing[v]));
      if (stale.length) failures.push(n + ': KNOWN_UNDECLARED entry no longer needed: ' + stale.join(', '));
      else if (bad.length) failures.push(n + ' reads a name that is declared nowhere: ' + bad.join(', '));
      else pass++;
    }
    if (mutFree.has('kwCost') && missing.kwCost) pass++;
    else failures.push('self-check: the check did not see the removed kwCost declaration');
    if (!free._saveSinglePDFBillCore.has('kwCost')) pass++;
    else failures.push('self-check: kwCost is wrongly free in the real function');
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
