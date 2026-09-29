// lib/formatting.js — Shared formatting functions (canonical source)

// _fmtUSD(v, missing) — the ONE US-dollar formatter (WP-20, 2026-09-28). Whole dollars, en-US
// thousands separators, keeps the minus sign: -1234.5 -> "-$1,235" (the absolute value is
// rounded first, so a negative half rounds away from zero exactly like a positive one).
// A value that rounds to zero prints "$0", never "-$0". Missing or non-numeric input
// (null, undefined, "", NaN) returns `missing` (default null) so a caller can choose a
// client-safe fallback: report tables pass '$0'; client price pages test for null and print
// their own text. Cents formats (agreement invoices, rate tables) are separate on purpose.
function _fmtUSD(v, missing) {
  if (missing === undefined) missing = null;
  if (v === null || v === undefined || v === '' || isNaN(v)) return missing;
  var n = Math.round(Math.abs(Number(v)));
  return (Number(v) < 0 && n > 0 ? '-$' : '$') + n.toLocaleString('en-US');
}
