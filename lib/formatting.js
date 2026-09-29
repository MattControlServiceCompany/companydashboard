// lib/formatting.js - Shared formatting functions (canonical source)

// parseBillNumber(v) - the ONE parser for numbers printed on a bill or stored as bill text.
// Returns a finite number, or null when the value is missing or cannot be read.
// null means "missing". It is never 0. Callers must treat null as missing.
//   Accepts: 4271.5  "4,271.50"  "$ 1,000"  "(12.00)"  "12.00-"  "12.00CR"  "-12.00"  ".5"
//   Negative: parentheses, a leading "-", a trailing "-", or a trailing "CR".
//   Comma is a thousands mark only (groups of 3 digits). "1.234,5" and "12,5" return null.
function parseBillNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[$\s]/g, '');
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseBillNumber: parseBillNumber, parseBillNumberOrZero: parseBillNumberOrZero };
}
