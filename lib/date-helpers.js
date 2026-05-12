// lib/date-helpers.js — Date utility functions (canonical source)
// Extracted from energy-department.html. No DOM dependencies.

function calDaysInMonth(ym) {
  const [yr, mo] = ym.split('-').map(Number);
  return new Date(yr, mo, 0).getDate(); // day 0 of next month = last day of this month
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
