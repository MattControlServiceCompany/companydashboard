// tools/test-no-ui-abbreviations.js — UI label spell-out gate (2026-09-23, task 5ai).
// Run: node tools/test-no-ui-abbreviations.js
//
// Matt: "Why are we abbreviating words?" — the BAS Savings Calc screen (and other tables/
// headers site-wide) showed abbreviated labels like "COOL OCC SP", "UNOCC", "OA SHUT OFF",
// "SCHEDULE (24HR)", "M-F ON/OFF", "SAT/SUN ON/OFF", and utility-table headers like
// "NORM. MONTH" / "FOM". This gate scans the UI LABEL surfaces the app actually renders —
// not the whole file — for a banned whole-word abbreviation list, and fails with file:line
// on any hit so an abbreviated label can never ship again.
//
// Scope (deliberately narrow — this is what a person actually reads on screen):
//   1. Text inside label-bearing HTML tags found in *.html and app/*.js template literals:
//      <label> <th> <button> <option> <legend> <caption> <summary>
//   2. title=/placeholder=/aria-label= attribute text on any element.
//   3. Object-literal `label:`, `header:`, `h:`, `title:`, `text:` string properties (the
//      column/field-definition pattern used throughout app/csv-import.js, app/bill-analysis.js,
//      app/utility-data.js, etc. — e.g. `{ key:'x', label:'WRE Index (FOM) Charge' }`).
//   4. The first string argument to showToast(...) — user-visible toast messages.
// This intentionally excludes BAS point-name fuzzy-matching keyword dictionaries (e.g.
// app/bas-trends.js's internal alias lists like "oa temp", "sat setpoint") — those match
// against REAL building-automation point names that themselves use those abbreviations; they
// are matching data, never rendered as a label, and rewriting them would break point matching.
//
// Explicit allow list — units/file-types/acronyms Matt asked to KEEP exactly as-is (task 5ai):
// kWh, kW, °F, Therms, MMBtu, CSV, PDF, HVAC. None of these collide with the banned list below,
// but they are named here so the intent is explicit and future edits don't "fix" them by mistake.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

const ALLOWED_KEPT_UNITS = ['kWh', 'kW', '°F', 'Therms', 'MMBtu', 'CSV', 'PDF', 'HVAC'];

// Whole-word, case-insensitive.
const BANNED_WORDS = [
  'OCC',
  'UNOCC',
  'SP',
  'OA',
  'M-F',
  'SAT',
  'SUN',
  'HR',
  'TMY',
  'Est',
  'Temp',
  'Avg',
  'Qty',
  'Bldg',
  'Norm',
  'Mo',
  'Yr',
  'Info',
  'Config',
  'Approx',
  'Pct',
  'Amt',
  'Dept',
];

const BANNED_RES = BANNED_WORDS.map((w) => ({
  word: w,
  re: new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'),
}));

const JS_FILES = fs
  .readdirSync(path.join(REPO, 'app'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('app', f));

const HTML_FILES = fs.readdirSync(REPO).filter((f) => f.endsWith('.html'));

let hits = [];

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
  return line;
}

// Content groups exclude newlines. Real single-line HTML attributes/tag text never span
// physical lines in this codebase; requiring no-newline also protects against dynamically
// built strings like `title="Baseline ' + $n(mo.bl) + ' ' + unit + '"` (string-concatenated
// across several '+' lines) where a later same-quote-character from an unrelated adjacent JS
// string literal would otherwise be mistaken for this attribute's closing quote and swallow
// real code into the "label" text.
const LABEL_TAGS = 'label|th|button|option|legend|caption|summary';
const TAG_TEXT_RE = new RegExp(`<(${LABEL_TAGS})\\b[^>]*>([^<>\\n]*)</\\1>`, 'gi');
const ATTR_RE = /\b(title|placeholder|aria-label)\s*=\s*"([^"\n]*)"/gi;
const ATTR_RE_SQ = /\b(title|placeholder|aria-label)\s*=\s*'([^'\n]*)'/gi;
const PROP_RE = /\b(label|header|title|text)\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
const PROP_RE_DQ = /\b(label|header|title|text)\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
const H_PROP_RE = /\bh\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
const TOAST_RE = /showToast\(\s*'((?:[^'\\\n]|\\.)*)'/g;
const TOAST_RE_DQ = /showToast\(\s*"((?:[^"\\\n]|\\.)*)"/g;

function findAll(re, src, groupIdx) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) {
    out.push({ text: m[groupIdx], index: m.index });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// RELEASE_NOTES (app/site-functions.js) is a historical changelog, not a live UI label
// surface — item 5ai only asks to ADD a new entry describing this fix, never to rewrite past
// entries. Find its array bounds (by bracket-depth from the declaration) so hits inside it are
// excluded regardless of how many entries get added later.
function findReleaseNotesRange(src) {
  const declIdx = src.indexOf('var RELEASE_NOTES = [');
  if (declIdx === -1) return null;
  const openIdx = src.indexOf('[', declIdx);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return [openIdx, i];
    }
  }
  return [openIdx, src.length];
}

// Strips ${...} template-literal interpolation expressions (e.g. "Year ${yr + 1}") before
// word-matching, so a JS variable name inside an interpolation (like the loop variable `yr`)
// is never mistaken for the banned word it happens to spell — only literal label text is
// checked. Non-nested (good enough for the simple expressions this codebase interpolates into
// label text, e.g. `${yr + 1}`, `${m.id}`).
function stripInterpolation(text) {
  return text.replace(/\$\{[^}]*\}/g, ' ');
}

// Explicit, narrow exceptions: real text that legitimately contains a banned "word" for a
// reason unrelated to abbreviation (a proper noun/code, not a shortened English word). Checked
// by exact extracted-text match so it can never silently swallow a real hit.
const EXACT_TEXT_EXCEPTIONS = new Set([
  // Missouri's two-letter state code, used correctly in address placeholder examples — not the
  // "Mo" = month abbreviation Matt flagged.
  'e.g. 2500 Van Horn Rd, Independence MO 64050',
  'e.g. MO',
  // report-engine.js:11417 — `'<option value="' + yr + '">' + yr + '</option>'` is JS string
  // concatenation (not a template literal), so the tag-text extractor sees the literal
  // characters between the `+` operators as if they were the tag's text content. The real
  // rendered text is just the numeric year value; "yr" here is the loop variable name, not an
  // abbreviated label.
  "' + yr + '",
]);

function scanSource(src, filePath) {
  const found = [];
  findAll(TAG_TEXT_RE, src, 2).forEach((x) => found.push(x));
  findAll(ATTR_RE, src, 2).forEach((x) => found.push(x));
  findAll(ATTR_RE_SQ, src, 2).forEach((x) => found.push(x));
  findAll(PROP_RE, src, 2).forEach((x) => found.push(x));
  findAll(PROP_RE_DQ, src, 2).forEach((x) => found.push(x));
  findAll(H_PROP_RE, src, 1).forEach((x) => found.push(x));
  findAll(TOAST_RE, src, 1).forEach((x) => found.push(x));
  findAll(TOAST_RE_DQ, src, 1).forEach((x) => found.push(x));

  const rnRange = findReleaseNotesRange(src);

  for (const { text: rawText, index } of found) {
    if (!rawText) continue;
    if (rnRange && index >= rnRange[0] && index <= rnRange[1]) continue;
    if (EXACT_TEXT_EXCEPTIONS.has(rawText)) continue;
    const text = stripInterpolation(rawText);
    for (const { word, re } of BANNED_RES) {
      re.lastIndex = 0;
      if (re.test(text)) {
        hits.push({ file: filePath, line: lineOf(src, index), word, text: text.slice(0, 140) });
      }
    }
  }
}

for (const rel of JS_FILES) {
  const full = path.join(REPO, rel);
  scanSource(fs.readFileSync(full, 'utf8'), rel);
}

for (const rel of HTML_FILES) {
  const full = path.join(REPO, rel);
  scanSource(fs.readFileSync(full, 'utf8'), rel);
}

// De-dupe identical file:line:word:text hits (same string can be matched by more than one
// extractor pattern, e.g. a `label:` prop that is also inside a template-literal tag).
const seen = new Set();
hits = hits.filter((h) => {
  const k = `${h.file}:${h.line}:${h.word}:${h.text}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (hits.length) {
  console.error(`FAIL: ${hits.length} abbreviated UI label hit(s):\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.word}]  "${h.text}"`);
  }
  console.error(
    `\nSpell out these labels (see task 5ai). Kept units/allow list (never flag): ${ALLOWED_KEPT_UNITS.join(', ')}.`,
  );
  process.exit(1);
} else {
  console.log('PASS: no abbreviated UI labels found in app/*.js or *.html.');
  process.exit(0);
}
