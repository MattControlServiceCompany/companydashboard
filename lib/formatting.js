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


// _escHtml(s) - the ONE HTML escape. Encodes & < > " ' (so the result is safe in element text and in
// double- or single-quoted attribute values). null/undefined become ''. Every page and report calls this.
// Do not write another escaper: tools/test-single-html-escape.js fails when a private copy appears.
function _escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// parseBillNumber(v) - the ONE parser for numbers printed on a bill or stored as bill text.
// Returns a finite number, or null when the value is missing or cannot be read.
// null means "missing". It is never 0. Callers must treat null as missing.
//   Accepts: 4271.5  "4,271.50"  "$ 1,000"  "(12.00)"  "12.00-"  "12.00CR"  "-12.00"  ".5"
//   Negative: parentheses, a leading "-", a trailing "-", or a trailing "CR".
//   Comma is a thousands mark only (groups of 3 digits); one trailing comma is dropped ("2.19," = 2.19). "1.234,5" and "12,5" return null.
function parseBillNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[$\s]/g, '');
  s = s.replace(/,$/, ''); // one trailing comma is a stray mark ("2.19,"), not part of the number
  if (s === '') return null;
  let signs = 0;
  if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') {
    signs++;
    s = s.slice(1, -1);
  }
  if (/cr$/i.test(s)) {
    signs++;
    s = s.slice(0, -2);
  }
  if (s.charAt(s.length - 1) === '-') {
    signs++;
    s = s.slice(0, -1);
  }
  if (s.charAt(0) === '-') {
    signs++;
    s = s.slice(1);
  } else if (s.charAt(0) === '+') {
    s = s.slice(1);
  }
  if (signs > 1) return null;
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?$/.test(s) || !/\d/.test(s)) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  if (!isFinite(n)) return null;
  return signs === 1 && n !== 0 ? -n : n;
}

// parseBillNumberOrZero(v) - same as parseBillNumber, but returns 0 for a missing or unreadable value.
// Use ONLY inside a check or a message where "missing" and 0 mean the same thing (a sum, a "> 0" test,
// text shown to the user). NEVER use it for a value that is saved or shown as a bill figure.
function parseBillNumberOrZero(v) {
  const n = parseBillNumber(v);
  return n === null ? 0 : n;
}

// billValueOrBlank(a, b, ...) - the ONE "value to store or show" rule (Matt 2026-10-05):
// a missing value is blank (''), a real 0 stays 0. Returns the first argument that parseBillNumber
// reads as a number, unchanged. Never use `x || ''` on a bill number: it turns a real 0 into blank.
function billValueOrBlank() {
  const v = billValueOrNull.apply(null, arguments);
  return v === null ? '' : v;
}
// billValueOrNull(a, b, ...) - same rule, but null (not '') when every argument is missing.
function billValueOrNull() {
  for (let i = 0; i < arguments.length; i++) {
    if (parseBillNumber(arguments[i]) !== null) return arguments[i];
  }
  return null;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _fmtUSD: _fmtUSD,
    parseBillNumber: parseBillNumber,
    parseBillNumberOrZero: parseBillNumberOrZero,
    billValueOrBlank: billValueOrBlank,
    billValueOrNull: billValueOrNull,
  };
}
