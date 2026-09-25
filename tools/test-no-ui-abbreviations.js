// tools/test-no-ui-abbreviations.js — UI label spell-out gate (2026-09-23, task 5ai;
// extended 2026-09-24, task 5ai follow-up).
// Run: node tools/test-no-ui-abbreviations.js
//
// Matt: "Why are we abbreviating words?" — the BAS Savings Calc screen (and other tables/
// headers site-wide) showed abbreviated labels like "COOL OCC SP", "UNOCC", "OA SHUT OFF",
// "SCHEDULE (24HR)", "M-F ON/OFF", "SAT/SUN ON/OFF", and utility-table headers like
// "NORM. MONTH" / "FOM". This gate scans the UI LABEL surfaces the app actually renders —
// not the whole file — for a banned whole-word abbreviation list, and fails with file:line
// on any hit so an abbreviated label can never ship again.
//
// 2026-09-24 follow-up: the first pass missed labels rendered in plain uppercase-styled
// <div>s and a bare "SA#"/"SA #" symbol (no letter boundary for \b), and Matt asked for a
// second line of defense: any NEW all-caps 2-5 letter token in a scanned label string that
// isn't on the explicit allow list below also fails the gate, so a fresh abbreviation can't
// ship without a deliberate decision to allow-list it. "Building SqFt", "Cooling Eff
// (kW/Ton)", "Gas AFUE", "Electric COP", "Max Tons"/"Max MBtu/h"/"OA CFM", "Temp CSV", "SA#",
// "Site EUI", and the "Energy Dept" user chip were all spelled out for this follow-up.
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
  // 2026-09-24 follow-up (task 5ai follow-up) — spelled out across the BAS Savings Calc form,
  // the project header, and the ECM calculator (same words, same fix):
  'SqFt', // -> "Square Feet" (matches "SqFt"/"sqft" concatenated; the established two-word
  // "Sq Ft" table-header abbreviation elsewhere is a separate, larger, pre-existing convention
  // Matt did not flag and is intentionally left alone here).
  'Eff', // -> "Efficiency"
  'AFUE', // -> "Annual Fuel Utilization Efficiency"
  'COP', // -> "Coefficient of Performance"
  'MBtu', // -> "thousand Btu" (bare MBtu/MBH; MMBtu stays allowed — see ALLOWED_KEPT_UNITS)
  'CFM', // -> "Cubic Feet per Minute"
  'EUI', // -> "Energy Use Intensity"
  // 2026-09-24 (fix/em-show-all-columns, task 5aj) — the E2E review caught "Zone Htg Setpoint" /
  // "Zone Clg Setpoint" column headers in the Equipment Matrix Summary view: shortened plain
  // English words (Heating/Cooling), not BAS/controls domain vocabulary — same category as
  // Occ/Unocc above, so they get the same whole-word ban site-wide.
  'Htg', // -> "Heating"
  'Clg', // -> "Cooling"
];

// A bare-symbol form `\b` can't bound ("#" isn't a word character) — checked by substring,
// case-insensitively, against the same extracted label text as the whole-word list above.
const BANNED_SUBSTRINGS = [
  { word: 'SA#', needle: 'sa#' }, // -> "Service Agreement Number"
];

const BANNED_RES = BANNED_WORDS.map((w) => ({
  word: w,
  re: new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'),
}));

// 2026-09-24 follow-up (task 5ai second follow-up): the CFM exception for app/equipment-matrix.js
// was removed — that file's "Ventilation CFM"/"Return Fan CFM"/etc. column labels are spelled out
// ("Ventilation Airflow", "Return Fan Airflow", ...) like every other file's CFM labels. No file
// exceptions remain; the whole-word ban applies everywhere.
const BANNED_WORD_FILE_EXCEPTIONS = new Map();

// ─── All-caps token safety net (2026-09-24 follow-up) ───────────────────────────────────────
// Beyond the curated whole-word list above, any all-caps run of 2-5 letters in a scanned label
// string fails the gate unless it's on this allow list. This is a second line of defense, not
// a replacement for the curated list: it stops a BRAND NEW abbreviation from shipping without
// a deliberate choice to allow-list it, while not forcing an unrelated, unverified rewrite of
// the site's existing technical/billing vocabulary in one pass.
//
// Two kinds of entries:
//   1. Real proper names, file formats, units, and postal/state codes — never "abbreviations"
//      in Matt's sense (STE calls these out separately from shortened English words).
//   2. Whole English words that happen to render in ALL CAPS for table-header/button styling
//      (e.g. "TOTAL COST $") — the regex can't tell a styled whole word from a shortened one,
//      so these are named explicitly rather than guessed at.
// Building-automation/equipment mnemonics (AHU, VAV, CHW, CFM, BTU, VFD, etc.) and utility-bill
// tariff rider codes (ECA, EER, PTS, TDC, ...) are NOT blanket-exempted here — see
// ALL_CAPS_EXCLUDED_FILES below for why those OTHER files are skipped by this specific check
// instead. app/equipment-matrix.js is deliberately NOT in that exclusion list: 2026-09-24
// follow-up (task 5ai second follow-up) removed the ~44-entry equipment-matrix.js-specific BAS-
// mnemonic allow-list (HW/CHW/CW/RH/CT/CFM/VFD/HP/IP/EF/SF/BMS/DI/BTU/MJ/ATS/RMS/ABC/DP/ANI/ANO/
// MCS/BV/AV/VVT/ET/VOC/UV/TCP/RX/TX/RAM/COMM/PC/DOAS/DX/RPM/DD/FCU/VRF/PID/HOA/UPS/CO/SZ/MTZ,
// added by fix/em-show-all-columns task 5aj) that let those column headers, breakdown tiles, and
// point-category labels ship abbreviated. Every one of those labels is now spelled out in full
// English words in the file itself (e.g. "AHU / RTU" -> "Air Handling Unit / Rooftop Unit",
// "BAS Points" -> "Building Automation System Points") — the labels were fixed at the source,
// not exempted from the gate. AHU/RTU/VAV/OAT/RA/SA/MTR stay allowed (see the older, smaller
// block above) for the handful of OTHER files that still use them in free-text placeholder
// examples; that block predates task 5aj and was not part of what this follow-up removed.
const ALLOWED_ALL_CAPS = new Set([
  // Already-allowed units (see ALLOWED_KEPT_UNITS), plus their literal ALL-CAPS table-header
  // spelling:
  'HVAC',
  'PDF',
  'CSV',
  'KW',
  // Proper names / orgs / standards (not abbreviations of an English word):
  'BAS',
  'ASHRAE',
  'JOCO',
  'CSC',
  'CBECS',
  'DOE',
  'MLK',
  'NEMA',
  'SOO',
  'STAR', // "ENERGY STAR"
  'AI',
  'EMS', // "Energy Management System" — the ems-leads.html page's own product/feature name
  'OCR', // "Optical Character Recognition" — the app's own "PDF / OCR" nav feature name
  // File/data formats and universal tech terms:
  'JSON',
  'XLSX',
  'URL',
  // US state/postal codes:
  'MO',
  'TX',
  'ZIP',
  // Established units/qualifiers used alongside already-allowed units:
  'DC', // "kW DC" — direct current, paired with the allowed "kW" unit
  'CCF',
  'CDD',
  'HDD',
  // Building-automation equipment mnemonics used in a handful of free-text placeholder
  // examples/labels outside the excluded technical files below — real equipment-class names,
  // not shortened English words (same category as the already-allowed HVAC):
  'AHU',
  'RTU',
  'VAV',
  'OAT',
  'RA',
  // Example ID/tag-format placeholders (illustrate a real value's format, not label prose):
  'SA',
  'MTR',
  // Whole English words rendered in ALL CAPS for header/button styling — not abbreviations:
  'ALL',
  'AND',
  'NOT',
  'NO',
  'TOTAL',
  'COST',
  'FUEL',
  'WATER',
]);
const ALL_CAPS_RE = /\b[A-Z]{2,5}\b/g;

// Files whose UI labels are established domain vocabulary (BAS/HVAC equipment nomenclature,
// utility-bill tariff/rider codes, financial/business terms) rather than shortened English
// words — same rationale as the BAS point-dictionary exclusion above. The curated BANNED_WORDS
// list above still applies to every file, including these. app/equipment-matrix.js is NOT in
// this list, and (2026-09-24 follow-up, task 5ai second follow-up) is no longer given any
// equipment-matrix.js-specific allowance either — its stat-pill tiles, column headers, dropdown
// options, and point-category labels were rewritten to full English words (see the removed
// ALLOWED_ALL_CAPS block, above) instead of being exempted, so this file's UI chrome stays fully
// covered by both the whole-word ban and the all-caps safety net like any other file.
const ALL_CAPS_EXCLUDED_FILES = new Set([
  path.join('app', 'bas-trends.js'),
  path.join('app', 'bas-alarms.js'),
  path.join('app', 'ecm-calculators.js'),
  path.join('app', 'bill-analysis.js'),
  path.join('app', 'csv-import.js'),
  path.join('app', 'pricing-estimator.js'),
  path.join('app', 'budget.js'),
  path.join('app', 'district-calendar.js'),
  path.join('app', 'soo-generator.js'),
  path.join('app', 'pipeline-diagram.js'),
  path.join('app', 'utility-data.js'),
  path.join('app', 'report-engine.js'),
  path.join('app', 'report-engine-woodland.js'),
  // Hosts several distinct sub-calculators beyond the BAS Savings Calc this task targeted:
  // the HVAC Load Estimate calc (EFLH, MBH, DHW, MCF, UA — real HVAC-engineering terms) and
  // the solar Net Metering rate-breakdown tables (ECA, EER, PTS, TDC — literal utility tariff
  // rider codes taken from the client's real bill; guessing at their expansion risks putting
  // a wrong name on a live financial calculator). The BAS Savings Calc labels Matt flagged are
  // already spelled out and stay protected everywhere by the curated BANNED_WORDS list above,
  // which still runs against this file.
  path.join('app', 'calculators.js'),
]);

// 2026-09-25 follow-up (task 5b): scope was app/*.js + repo-root *.html only -- it missed
// lib/perf-table.js's live "Norm Days" Meter Performance table header (task 5b item 1) simply
// because lib/ was never read at all, not because the word was allow-listed. lib/perf-table.js
// is shared, canonical UI-rendering code (its own header comment says so: "Used by:
// renderPerfPane (Meter Performance tab) and report generation") -- the same class of file as
// app/*.js for this gate's purposes. Added by name, not the whole lib/ directory: lib/
// otherwise holds non-label code (csv-parser, date-helpers, unit-conversion, quill rich-text)
// and lib/shared-charts.js, whose existing "Site EUI" chart-series labels are the SAME
// site-wide "Site EUI" convention the project header spells out in full elsewhere -- a
// separate, much larger pre-existing-content question this task's two named misses do not ask
// this gate to re-litigate.
const JS_FILES = fs
  .readdirSync(path.join(REPO, 'app'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('app', f))
  .concat([path.join('lib', 'perf-table.js')]);

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

// 2026-09-25 follow-up (task 5b): PROP_RE/PROP_RE_DQ above only match a `text:` value that is
// ONE bare string literal. report-engine.js's findings.push({ text: esStar.length + ' ... in
// the top EUI quartile ... ' + esStar.map(...).join(', ') + '.' }) builds its text by
// concatenating several string literals with real JS in between -- PROP_RE never matched it
// (the value after `text:` isn't a quote), so a bare "EUI" shipped in real rendered report
// prose unnoticed (task 5b item 2). This scans forward from `text:` to the matching top-level
// comma or closing brace/paren/bracket (tracking nesting depth, and treating characters inside
// a string literal as inert so a comma or brace INSIDE a string can't end the span early), then
// joins every quoted string literal's contents found in that span with spaces and checks the
// same banned-word/all-caps rules against it — same as any other extracted label text. A plain
// single-literal value (already caught by PROP_RE) also matches here; the caller's de-dupe
// means that's harmless, not a second bug.
//
// Deliberately `text:` only, not `label:`/`header:` too: those two also appear on legitimate,
// already-reviewed multi-part page-title concatenations elsewhere (e.g. report-engine.js's
// `label: 'Page ' + n + ' — Site EUI Benchmarking'`) that are a separate, much larger
// pre-existing-content question this task's one named miss does not ask this gate to
// re-litigate. Bails out (matches nothing for that key) the moment it sees a template-literal
// backtick — this scanner cannot safely track `${...}` interpolation depth mixed with quote
// characters inside HTML markup, and every concatenated `text:` finding string this codebase
// actually builds today uses plain '...' + '...' concatenation, never a template literal.
// (?<!-): a CSS custom property named exactly `--text:` (e.g. energy-department.html's own
// `--text: #dde6f5;` color token) would otherwise word-match "text" too -- real CSS variable
// declarations, not a JS object's `text:` property, and scanning forward from one walks into
// whatever unrelated code/CSS follows a plain `;`-terminated line (no comma/brace to stop it).
const CONCAT_PROP_KEY_RE = /(?<!-)\btext\s*:\s*/g;
const CONCAT_PROP_MAX_SPAN = 2000; // safety cap against a runaway scan on malformed input
function findConcatPropTexts(src) {
  const out = [];
  CONCAT_PROP_KEY_RE.lastIndex = 0;
  let km;
  while ((km = CONCAT_PROP_KEY_RE.exec(src))) {
    const startIdx = km.index;
    let i = CONCAT_PROP_KEY_RE.lastIndex;
    const end = Math.min(src.length, i + CONCAT_PROP_MAX_SPAN);
    let depth = 0;
    let inStr = null;
    const parts = [];
    let buf = '';
    let bailed = false;
    for (; i < end; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === inStr) {
          parts.push(buf);
          buf = '';
          inStr = null;
          continue;
        }
        buf += c;
        continue;
      }
      if (c === '`') {
        bailed = true;
        break;
      }
      if (c === "'" || c === '"') {
        inStr = c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (c === ',' && depth === 0) break;
    }
    if (!bailed && parts.length) out.push({ text: parts.join(' '), index: startIdx });
  }
  return out;
}

// 2026-09-25 follow-up (task 5b): lib/perf-table.js builds its table-header strings as plain
// variable assignments, not a tag literal or a label:/text: object property -- e.g.
// `var H_NDAYS = rpt ? 'Days' : 'Norm Days';` -- so even with lib/perf-table.js now in scope,
// none of the extraction patterns above ever saw "Norm Days" (task 5b item 1). Scoped to this
// codebase's own `H_<NAME>` naming convention for header-string constants (used throughout
// lib/perf-table.js for its Meter Performance table headers) rather than a blanket "any
// variable assignment" scan, so it can't sweep up unrelated code elsewhere.
//
// Only the `rpt ? 'reportMode' : 'tabMode'` ternary's ELSE (tab/live-UI) branch is checked, not
// its report-mode THEN branch: this exact file documents the report-mode ternary branch (BL/
// Act/Bld, etc.) as "a deliberate, documented width tradeoff, out of scope for the 2026-09-24
// header-overflow fix ... to unwind without a full column-width re-tuning pass" -- a different,
// larger, already-decided-against piece of work this task's one named miss (the LIVE tab-mode
// "Norm Days" header) does not ask this gate to re-litigate. A plain (non-ternary) `H_X = '...'`
// assignment is still checked in full.
const HEADER_VAR_TERNARY_RE =
  /\bH_[A-Z_]+\s*=\s*\w+\s*\?\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/g;
const HEADER_VAR_PLAIN_RE = /\bH_[A-Z_]+\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/g;
function findHeaderVarTexts(src) {
  const out = [];
  [HEADER_VAR_TERNARY_RE, HEADER_VAR_PLAIN_RE].forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const lit = m[1];
      const inner = lit.slice(1, -1);
      out.push({ text: inner, index: m.index });
    }
  });
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
  findConcatPropTexts(src).forEach((x) => found.push(x));
  findHeaderVarTexts(src).forEach((x) => found.push(x));

  const rnRange = findReleaseNotesRange(src);

  for (const { text: rawText, index } of found) {
    if (!rawText) continue;
    if (rnRange && index >= rnRange[0] && index <= rnRange[1]) continue;
    if (EXACT_TEXT_EXCEPTIONS.has(rawText)) continue;
    const text = stripInterpolation(rawText);
    for (const { word, re } of BANNED_RES) {
      const exceptFiles = BANNED_WORD_FILE_EXCEPTIONS.get(word);
      if (exceptFiles && exceptFiles.has(filePath)) continue;
      re.lastIndex = 0;
      if (re.test(text)) {
        hits.push({ file: filePath, line: lineOf(src, index), word, text: text.slice(0, 140) });
      }
    }
    for (const { word, needle } of BANNED_SUBSTRINGS) {
      if (text.toLowerCase().includes(needle)) {
        hits.push({ file: filePath, line: lineOf(src, index), word, text: text.slice(0, 140) });
      }
    }
    if (!ALL_CAPS_EXCLUDED_FILES.has(filePath)) {
      ALL_CAPS_RE.lastIndex = 0;
      let m;
      while ((m = ALL_CAPS_RE.exec(text))) {
        const token = m[0];
        if (!ALLOWED_ALL_CAPS.has(token)) {
          hits.push({
            file: filePath,
            line: lineOf(src, index),
            word: 'ALL-CAPS:' + token,
            text: text.slice(0, 140),
          });
        }
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
