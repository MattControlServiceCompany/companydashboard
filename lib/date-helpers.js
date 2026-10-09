// lib/date-helpers.js — Date utility functions (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

// a5cfe2a6: the ONE reader for an ISO "YYYY-MM-DD" bill or baseline date (a trailing "T..." is ignored).
// new Date("2025-01-01") reads UTC midnight, which is the day before in US time zones. This returns local
// midnight, or null when the text is not an ISO date (the caller then uses its own fallback).
function parseLocalISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(s == null ? '' : s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function calDaysInMonth(ym) {
  const [yr, mo] = ym.split('-').map(Number);
  return new Date(yr, mo, 0).getDate(); // day 0 of next month = last day of this month
}

// The ONE add-months helper for 'YYYY-MM' strings (n may be negative).
function addMonth(ym, n) {
  const [y, mo] = ym.split('-').map(Number);
  const t = y * 12 + (mo - 1) + (n === undefined ? 1 : n);
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}

function lastDayOfMonth(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().split('T')[0];
}

function normMonthLabel(startStr, endStr, incl, allBills) {
  const ym = normMonth(startStr, endStr, incl, allBills);
  if (!ym) return '—';
  const [y, mo] = ym.split('-');
  const dt = new Date(parseInt(y), parseInt(mo) - 1, 1);
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
