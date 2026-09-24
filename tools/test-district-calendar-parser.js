/**
 * test-district-calendar-parser.js
 *
 * Regression test for the District Calendar PDF import (app/district-calendar.js
 * — dcExtractPDFText + dcExtractCalendarEvents / _dcParseSequentialList).
 *
 * Bug (2026-09-23): "Import Calendar" against a real district calendar PDF
 * (list-style: colored swatch + "Month D[-D2]" + description, repeated, with
 * decorative Su/M/T/W/Th/F/Sa mini month-grids down both sides) found only 6
 * events, assigned wrong dates (e.g. "7 New Teachers on Duty" -> 07/05/2026),
 * and glued grid day-numbers into event names (e.g. "27 No Classes -
 * Thanksgiving Break 28 29 30 31"). Root causes: the old same-Y-row text join
 * in dcExtractPDFText glued unrelated page columns (grid numbers + event
 * text) onto one line with no column awareness, and a wrapped 2-line
 * description whose date label sits vertically centered beside it landed out
 * of reading order.
 *
 * This is a SYNTHETIC fixture (invented district/dates), built entirely
 * in-process as fake pdf.js items with real-world-shaped column positions
 * (mini day-grids left/right, date+description list in the middle, a
 * cross-month range split across two lines, a wrapped 2-line description,
 * a non-dated "Various / PLC Days" entry, and a footer that restates one of
 * the real event's month+day). No real PDF or client data is used — per
 * standing rule, only synthetic fixtures may live in the repo/tests.
 *
 * Loads the REAL app/district-calendar.js via Node's vm module (same code
 * path as production, not a reimplementation) and drives it through
 * dcExtractPDFText with a stubbed pdfjsLib, exactly like the browser does.
 *
 * Usage: node tools/test-district-calendar-parser.js [path-to-district-calendar.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'district-calendar.js');

function loadModule(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({}),
      head: { appendChild() {} },
    },
    showToast: () => {},
    sset: () => {},
    esc: (s) => s,
    projects: [],
    DB: { remove() {} },
    console,
  };
  sandbox.window.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  return sandbox;
}

// ── Build a synthetic PDF item layout: mini grids (left/right) + a middle
// date+description list, matching the real-world column shape that broke
// the old parser. Coordinates are pdf.js-style (y increases upward).
function buildItems() {
  const items = [];
  const push = (str, x, y, w, fs) => items.push({ str, x, y, w, fs });

  // Decorative left/right day-of-week headers + a numeric grid row at a Y
  // that coincides with a real event row — this is exactly the shape that
  // used to glue "27 ... 28 29 30 31" onto an event description.
  push('Su', 39, 700, 10);
  push('M', 57, 700, 8);
  push('T', 75, 700, 6);
  push('W', 90, 700, 8);
  push('Th', 105, 700, 10);
  push('F', 125, 700, 6);
  push('Sa', 139, 700, 10);
  push('Su', 464, 700, 10);
  push('M', 482, 700, 8);
  push('T', 499, 700, 6);
  push('W', 514, 700, 8);
  push('Th', 530, 700, 10);
  push('F', 549, 700, 6);
  push('Sa', 563, 700, 10);

  push('September 2026 (20)', 46, 686, 140);
  push('February 2027 (19)', 475, 686, 140);

  // A grid day-number row at the SAME y as a real event row further down —
  // must not get glued onto that event's description.
  push('27', 56, 636.8, 10);
  push('28', 72, 636.8, 10);
  push('29', 89, 636.8, 10);
  push('30', 105, 636.8, 10);

  let y = 636.8;
  const row = (h, single = true) => {
    y -= h;
    return y;
  };

  // Single-day event
  push('September 5', 185, y, 55);
  push('New Teachers on Duty', 258, y, 90);

  // Wrapped 2-line description with a vertically-centered date label (the
  // exact centering artifact that scrambled reading order in the real bug)
  y -= 22;
  const dateY2 = y - 4;
  push('September 9', 185, dateY2, 55, true);
  push('No Classes -Special Education Teacher Professional', 258, y, 220);
  y -= 10;
  push('Development', 258, y, 60);

  // Multi-day range, date+desc on the same physical line (narrow gap)
  y -= 16;
  push('September 22-25', 185, y, 70);
  push('No Classes - Thanksgiving Break', 270, y, 130);

  // Cross-month range split across two lines ("December 21-" / "January 1")
  y -= 16;
  push('December 21-', 185, y, 70);
  y -= 10;
  push('No Classes - Winter Break', 258, y + 5, 130);
  y -= 6;
  push('January 1', 185, y, 55);

  // Non-dated entry — must be dropped, not turned into a bogus event
  y -= 16;
  push('Various', 185, y, 40);
  push('PLC Days', 258, y, 50);

  // Real single-day event that ends the list
  y -= 16;
  push('May 28', 185, y, 40);
  push('Last Day for Students', 258, y, 100);

  // Ligature-split case (2026-09-23 fix): real PDF.js extraction splits
  // ligature glyphs (fi, ffi, fl, ...) into separate text items flush
  // against each other (zero horizontal gap) at a realistic 12pt font
  // size. The old "always insert one space between same-column items"
  // join rule turned "Certified Off Duty" into "Certi fi ed O ff Duty".
  // 'Certi' + 'fi' + 'ed' (zero gap) must join with no space as
  // "Certified"; likewise 'O' + 'ff' as "Off". The ~3pt gaps between
  // the words "Certified", "Off", and "Duty" are well above the
  // 0.15 x fontSize (=1.8pt) threshold and must still each get exactly
  // one real space.
  y -= 16;
  push('June 4', 185, y, 40, 12);
  push('Certi', 258, y, 30, 12);
  push('fi', 288, y, 12, 12);
  push('ed', 300, y, 12, 12);
  push('O', 315, y, 6, 12);
  push('ff', 321, y, 12, 12);
  push('Duty', 336, y, 24, 12);

  // Footer that restates one real event's month+day — must not create a
  // second/bogus event or absorb the real one's description.
  y -= 40;
  push('Reporting Periods', 185, y, 100);
  y -= 14;
  push('Conference Dates', 400, y, 100);
  y -= 14;
  push('September 5 : Evening, All Grades', 185, y, 220);

  return items;
}

function run() {
  const sandbox = loadModule(jsPath);
  const items = buildItems();
  sandbox.window.pdfjsLib = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: items.map((it) => {
              const s = it.fs || 1;
              return { str: it.str, transform: [s, 0, 0, s, it.x, it.y], width: it.w };
            }),
          }),
        }),
      }),
    }),
  };

  return vm.runInContext(
    `(async () => {
      const text = await dcExtractPDFText(new ArrayBuffer(0));
      const events = dcExtractCalendarEvents(text);
      return { text, events };
    })()`,
    sandbox,
  );
}

const EXPECTED = [
  { date: '2026-09-05', name: 'New Teachers on Duty' },
  { date: '2026-09-09', name: 'No Classes -Special Education Teacher Professional Development' },
  { date: '2026-09-22', name: 'No Classes - Thanksgiving Break' },
  { date: '2026-09-23', name: 'No Classes - Thanksgiving Break' },
  { date: '2026-09-24', name: 'No Classes - Thanksgiving Break' },
  { date: '2026-09-25', name: 'No Classes - Thanksgiving Break' },
  { date: '2026-12-21', name: 'No Classes - Winter Break' },
  { date: '2026-12-22', name: 'No Classes - Winter Break' },
  { date: '2026-12-23', name: 'No Classes - Winter Break' },
  { date: '2026-12-24', name: 'No Classes - Winter Break' },
  { date: '2026-12-25', name: 'No Classes - Winter Break' },
  { date: '2026-12-26', name: 'No Classes - Winter Break' },
  { date: '2026-12-27', name: 'No Classes - Winter Break' },
  { date: '2026-12-28', name: 'No Classes - Winter Break' },
  { date: '2026-12-29', name: 'No Classes - Winter Break' },
  { date: '2026-12-30', name: 'No Classes - Winter Break' },
  { date: '2026-12-31', name: 'No Classes - Winter Break' },
  { date: '2027-01-01', name: 'No Classes - Winter Break' },
  { date: '2027-05-28', name: 'Last Day for Students' },
  { date: '2027-06-04', name: 'Certified Off Duty' },
];

run()
  .then(({ text, events }) => {
    const key = (e) => e.date + '|' + e.name;
    const parsedSet = new Set(events.map(key));
    const expectedSet = new Set(EXPECTED.map(key));
    const missing = EXPECTED.filter((e) => !parsedSet.has(key(e)));
    const extra = events.filter((e) => !expectedSet.has(key(e)));
    // The decorative grid injected bare day-numbers 27/28/29/30 at the same
    // Y as the first real event row. 27/29/30 never appear anywhere in real
    // content in this fixture, so any survival at all is the original bug
    // (grid numbers glued onto/around an event description).
    const noGlue = !/(^|\s)(27|29|30)(\s|$)/m.test(text);

    console.log('Parsed:', events.length, 'Expected:', EXPECTED.length);
    missing.forEach((e) => console.log('  MISSING', e.date, e.name));
    extra.forEach((e) => console.log('  EXTRA  ', e.date, e.name));
    console.log('No grid-number gluing in extracted text:', noGlue);

    const pass = missing.length === 0 && extra.length === 0 && noGlue;
    console.log(pass ? 'PASS' : 'FAIL');
    process.exit(pass ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
