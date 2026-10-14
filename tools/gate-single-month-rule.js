/**
 * gate-single-month-rule.js
 *
 * Gate: the month a WHOLE bill belongs to is decided by ONE function, billMonth(bill, meterBills)
 * (computations/normalization.js), which calls the normMonth chain over the bill's own meter. Fails when:
 *   1. computations/normalization.js does not define billMonth.
 *   2. A file in app/, computations/, extraction/ or lib/ derives a calendar month from a bill date
 *      (a month-cut such as .slice(0, 7), .substring(0, 7), .getMonth(), .split('-')[1]) on a line that is
 *      within 3 lines of a bill-date read (x.start, x.end, billEnd, endDate ...) and is not in ALLOWED.
 *   3. A stale ALLOWED entry (the site is gone) - delete it.
 *   4. The retired helper _wdAssignedYm comes back.
 * A new ALLOWED entry needs a reason that is NOT "it is a bill month": a bill month goes through billMonth.
 * This is a tripwire (text match). tools/test-month-rule-single.js is the behaviour proof and also runs this
 * gate on a temp tree that holds a violation.
 *
 * Usage: node tools/gate-single-month-rule.js [repo-root]
 */
const fs = require("fs");
const path = require("path");

const REPO = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "..");
const DIRS = ["app", "computations", "extraction", "lib"];
const CUT =
  /\.(slice|substring|substr)\(\s*0\s*,\s*7\s*\)|\.getMonth\(\)|\.getUTCMonth\(\)/;
const CUT_SAME_LINE =
  /\.(slice|substring)\(\s*5\s*,\s*7\s*\)|\.split\(\s*['"]-['"]\s*\)\s*\[\s*1\s*\]/;
const BILL_DATE =
  /\b\w+\.(start|end)\b(?!\s*[:=]{1,2}\s*[^=])|\b(billEnd|billStart|endDate|startDate|_dt)\b|\.(billDate|periodEnd|periodStart)\b/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

// [file, exact text that must appear on the line, reason]
const ALLOWED = [
  [
    "computations/normalization.js",
    "const ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1)",
    "billMonthDays (the named day split): month of each day of the period",
  ],
  [
    "computations/normalization.js",
    "const moEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);",
    "propane delivery span between two deliveries (half-open date span, not a bill month)",
  ],
  [
    "computations/normalization.js",
    "dt.setMonth(dt.getMonth() - mo);",
    "propane look-back by a count of months from a date",
  ],
  [
    "app/bas-trends.js",
    "var ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1)",
    "trend sample timestamps, not a bill",
  ],
  [
    "app/report-engine.js",
    "parseInt(d.period.end.split('-')[1], 10) - 1",
    "report period end, not a bill date",
  ],
];

const problems = [];
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

const nm = path.join(REPO, "computations/normalization.js");
const nmSrc = fs.existsSync(nm) ? fs.readFileSync(nm, "utf8") : "";
["billMonth"].forEach((fn) => {
  if (!new RegExp("function\\s+" + fn + "\\s*\\(").test(nmSrc))
    problems.push("computations/normalization.js does not define " + fn);
});

const used = new Set();
for (const d of DIRS) {
  for (const file of walk(path.join(REPO, d), [])) {
    const rel = path.relative(REPO, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (/function\s+_wdAssignedYm|[^a-zA-Z_]_wdAssignedYm\(/.test(text))
      problems.push(rel + " still has _wdAssignedYm (use billMonth)");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const sameLine =
        CUT_SAME_LINE.test(line) && /\b\w+\.(start|end)\b/.test(line);
      if (!CUT.test(line) && !sameLine) return;
      let near = false;
      for (
        let j = Math.max(0, i - 3);
        j <= Math.min(lines.length - 1, i + 3) && !near;
        j++
      ) {
        if (!COMMENT.test(lines[j]) && BILL_DATE.test(lines[j])) near = true;
      }
      if (!near) return;
      const hit = ALLOWED.findIndex((a) => a[0] === rel && line.includes(a[1]));
      if (hit >= 0) used.add(hit);
      else
        problems.push(
          rel +
            ":" +
            (i + 1) +
            " month cut near a bill date (use billMonth): " +
            line.trim().slice(0, 110),
        );
    });
  }
}
ALLOWED.forEach((a, i) => {
  if (!used.has(i))
    problems.push(
      "stale ALLOWED entry (site is gone, delete it): " + a[0] + " :: " + a[1],
    );
});

if (problems.length) {
  console.log("FAIL gate-single-month-rule");
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}
console.log(
  "PASS gate-single-month-rule (" +
    ALLOWED.length +
    " allowed non-bill-month sites)",
);
