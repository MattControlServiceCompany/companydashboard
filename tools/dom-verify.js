// DOM Verification Checks for CompanyHub
// Agents paste these into browser_evaluate calls during verification

// Check 1: Find text overflow (elements where content is wider than container)
function checkOverflow() {
  const problems = [];
  document.querySelectorAll('td, th, div, span, p, h1, h2, h3, h4, h5, h6').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      const text = el.textContent.trim().substring(0, 50);
      if (text)
        problems.push({ tag: el.tagName, class: el.className, text, scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  });
  return problems;
}

// Check 2: Verify background depth hierarchy
function checkBackgroundHierarchy() {
  const tokens = {
    '--bg': '#060810',
    '--s1': '#0c0f1a',
    '--s2': '#181d2e',
    '--s3': '#1e2438',
    '--s4': '#252c42',
  };
  const results = {};
  for (const [name, expected] of Object.entries(tokens)) {
    const actual = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    results[name] = { expected, actual, match: actual.toLowerCase() === expected.toLowerCase() };
  }
  return results;
}

// Check 3: Verify table has totals row
function checkTableTotals(tableSelector) {
  const table = document.querySelector(tableSelector);
  if (!table) return { found: false, error: 'Table not found' };
  const rows = table.querySelectorAll('tr');
  const lastRow = rows[rows.length - 1];
  const text = lastRow ? lastRow.textContent.toLowerCase() : '';
  return { found: true, hasTotals: text.includes('total'), lastRowText: text.substring(0, 100) };
}

// Check 4: Get all visible chart canvases and their dimensions
function checkCharts() {
  const canvases = document.querySelectorAll('canvas');
  return Array.from(canvases).map((c) => ({
    id: c.id,
    width: c.width,
    height: c.height,
    visible: c.offsetParent !== null,
    parent: c.parentElement?.id || c.parentElement?.className,
  }));
}

// Check 5: Verify element is visible in viewport (not scrolled out of view)
function checkVisibility(selector) {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  const rect = el.getBoundingClientRect();
  return {
    found: true,
    inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
  };
}

// Check 6: Extract displayed values from elements matching a selector
function extractValues(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => ({
    text: el.textContent.trim(),
    tag: el.tagName,
    class: el.className,
  }));
}

// Check 7: Verify scroll behavior - container should not scroll, only inner content
function checkScrollContainers() {
  const problems = [];
  // Main view containers should have overflow: hidden
  document.querySelectorAll('.view.active, .view-flex').forEach((el) => {
    const style = getComputedStyle(el);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      problems.push({ el: el.id || el.className, overflow: style.overflowY, note: 'View container should not scroll' });
    }
  });
  return problems;
}

// Check 8: WCAG AA contrast check (simplified - checks computed color vs background)
function checkContrast() {
  const issues = [];
  document.querySelectorAll('.stat, .card, td, th').forEach((el) => {
    const style = getComputedStyle(el);
    const color = style.color;
    const bg = style.backgroundColor;
    if (color && bg && color === bg) {
      issues.push({ text: el.textContent.trim().substring(0, 30), color, bg });
    }
  });
  return issues;
}
