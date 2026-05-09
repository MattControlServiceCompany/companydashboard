// test-backlog-runner.js
// Generic backlog verification runner for CompanyHub.
// Injected via Playwright MCP browser_evaluate — NOT loaded as a script tag.
// Uses var declarations throughout for safe re-evaluation.

// ---------------------------------------------------------------------------
// Expect operator helper
// Generates a JS expression string that checks `varName` against `expect`.
// expect: { op, value, path, tolerance }
// Returns: a JS expression (string) that evaluates to true/false.
// ---------------------------------------------------------------------------
var _buildExpectCheck = function (varName, expect) {
  var op = (expect && expect.op) || 'truthy';
  var path = expect && expect.path;
  var value = expect && expect.value;
  var tolerance = expect && expect.tolerance != null ? expect.tolerance : 0;

  // Access nested path (e.g. "found", "result.value")
  var accessor = varName;
  if (path) {
    var parts = String(path).split('.');
    for (var _pi = 0; _pi < parts.length; _pi++) {
      accessor += '[' + JSON.stringify(parts[_pi]) + ']';
    }
  }

  if (op === 'truthy') {
    return '!!' + accessor;
  }
  if (op === 'equals') {
    return '(' + accessor + ' === ' + JSON.stringify(value) + ')';
  }
  if (op === 'contains') {
    return '(String(' + accessor + ').indexOf(' + JSON.stringify(String(value)) + ') !== -1)';
  }
  if (op === 'gt') {
    return '(Number(' + accessor + ') > ' + Number(value) + ')';
  }
  if (op === 'gte') {
    return '(Number(' + accessor + ') >= ' + Number(value) + ')';
  }
  if (op === 'lt') {
    return '(Number(' + accessor + ') < ' + Number(value) + ')';
  }
  if (op === 'lte') {
    return '(Number(' + accessor + ') <= ' + Number(value) + ')';
  }
  if (op === 'within') {
    return '(Math.abs(Number(' + accessor + ') - ' + Number(value) + ') <= ' + Number(tolerance) + ')';
  }
  // Fallback: truthy
  return '!!' + accessor;
};

// ---------------------------------------------------------------------------
// Pattern Executors
// Each function receives (params, ctx) and returns Promise<{pass, detail}>.
// ctx.evaluate(expr) — evaluates JS string in the browser page context.
// ctx.click(selector) — clicks a DOM element by selector.
// ---------------------------------------------------------------------------
var BACKLOG_PATTERNS = {
  // element-visible: checks selector exists and is visible
  'element-visible': function (params, ctx) {
    var sel = String(params.selector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expr =
      '(function() {' +
      "var el = document.querySelector('" +
      sel +
      "');" +
      'if (!el) return { pass: false, detail: "Element not found: ' +
      sel +
      '" };' +
      'var visible = (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);' +
      'return { pass: visible, detail: visible ? "Element is visible" : "Element exists but is hidden" };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // element-hidden: checks selector does NOT exist or is hidden
  'element-hidden': function (params, ctx) {
    var sel = String(params.selector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expr =
      '(function() {' +
      "var el = document.querySelector('" +
      sel +
      "');" +
      'if (!el) return { pass: true, detail: "Element does not exist (expected)" };' +
      'var hidden = (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0);' +
      'return { pass: hidden, detail: hidden ? "Element is hidden (expected)" : "Element exists and is visible (unexpected)" };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // text-match: checks element's textContent contains expected string
  'text-match': function (params, ctx) {
    var sel = String(params.selector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expected = String(params.expected || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expr =
      '(function() {' +
      "var el = document.querySelector('" +
      sel +
      "');" +
      'if (!el) return { pass: false, detail: "Element not found: ' +
      sel +
      '" };' +
      'var text = el.textContent || "";' +
      "var found = text.indexOf('" +
      expected +
      "') !== -1;" +
      'return { pass: found, detail: found ? "Text matched: ' +
      expected +
      '" : ("Expected \'' +
      expected +
      '\' in: " + text.substring(0, 100)) };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // value-check: checks element's numeric value matches expected within tolerance
  'value-check': function (params, ctx) {
    var sel = String(params.selector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expected = Number(params.expected || 0);
    var tolerance = params.tolerance != null ? Number(params.tolerance) : 0;
    var expr =
      '(function() {' +
      "var el = document.querySelector('" +
      sel +
      "');" +
      'if (!el) return { pass: false, detail: "Element not found: ' +
      sel +
      '" };' +
      'var raw = (el.textContent || el.value || "").replace(/[$,]/g, "").trim();' +
      'var num = parseFloat(raw);' +
      'if (isNaN(num)) return { pass: false, detail: "Could not parse numeric value from: " + raw };' +
      'var diff = Math.abs(num - ' +
      expected +
      ');' +
      'var pass = diff <= ' +
      tolerance +
      ';' +
      'return { pass: pass, detail: pass ? ("Value " + num + " within tolerance of ' +
      expected +
      '") : ("Value " + num + " differs from expected ' +
      expected +
      ' by " + diff.toFixed(4)) };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // value-nonzero: checks element's text is not empty, "—", "-", "0", "$0"
  'value-nonzero': function (params, ctx) {
    var sel = String(params.selector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var expr =
      '(function() {' +
      "var el = document.querySelector('" +
      sel +
      "');" +
      'if (!el) return { pass: false, detail: "Element not found: ' +
      sel +
      '" };' +
      'var text = (el.textContent || "").trim();' +
      'var empty = (text === "" || text === "—" || text === "-" || text === "0" || text === "$0");' +
      'return { pass: !empty, detail: !empty ? ("Non-zero value: " + text) : ("Value is empty/zero: " + (text || "(empty)")) };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // click-action: clicks a selector, then evaluates a check expression
  'click-action': function (params, ctx) {
    var clickSel = params.clickSelector || params.selector;
    var checkExpr = params.checkExpr || 'true';
    return ctx
      .click(clickSel)
      .then(function () {
        var expr =
          '(function() {' +
          'try {' +
          '  var result = (' +
          checkExpr +
          ');' +
          '  return { pass: !!result, detail: "Check result: " + JSON.stringify(result) };' +
          '} catch(e) {' +
          '  return { pass: false, detail: "Check expression error: " + e.message };' +
          '}' +
          '})()';
        return ctx.evaluate(expr);
      })
      .catch(function (err) {
        return { pass: false, detail: 'Click or check failed: ' + String(err) };
      });
  },

  // sort-toggle: clicks header, checks first 5 rows of column changed order
  'sort-toggle': function (params, ctx) {
    var headerSel = String(params.headerSelector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var tableSel = String(params.tableSelector || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var colIdx = Number(params.columnIndex || 0);

    // Capture before state
    var beforeExpr =
      '(function() {' +
      "var rows = document.querySelectorAll('" +
      tableSel +
      " tbody tr');" +
      'var vals = [];' +
      'for (var i = 0; i < Math.min(rows.length, 5); i++) {' +
      '  var cells = rows[i].querySelectorAll("td");' +
      '  if (cells[' +
      colIdx +
      ']) vals.push(cells[' +
      colIdx +
      '].textContent.trim());' +
      '}' +
      'return vals;' +
      '})()';

    return ctx
      .evaluate(beforeExpr)
      .then(function (before) {
        return ctx.click(headerSel).then(function () {
          var afterExpr =
            '(function() {' +
            "var rows = document.querySelectorAll('" +
            tableSel +
            " tbody tr');" +
            'var vals = [];' +
            'for (var i = 0; i < Math.min(rows.length, 5); i++) {' +
            '  var cells = rows[i].querySelectorAll("td");' +
            '  if (cells[' +
            colIdx +
            ']) vals.push(cells[' +
            colIdx +
            '].textContent.trim());' +
            '}' +
            'return vals;' +
            '})()';
          return ctx.evaluate(afterExpr).then(function (after) {
            var changed = JSON.stringify(before) !== JSON.stringify(after);
            return {
              pass: changed,
              detail: changed
                ? 'Sort order changed after click'
                : 'Sort order did not change (before: ' +
                  JSON.stringify(before) +
                  ', after: ' +
                  JSON.stringify(after) +
                  ')',
            };
          });
        });
      })
      .catch(function (err) {
        return { pass: false, detail: 'Sort toggle check failed: ' + String(err) };
      });
  },

  // formula-result: evaluates params.expr, checks result against params.expect
  'formula-result': function (params, ctx) {
    var expr = params.expr || 'null';
    var expect = params.expect || { op: 'truthy' };
    var fullExpr =
      '(function() {' +
      'var __result;' +
      'try {' +
      '  __result = (' +
      expr +
      ');' +
      '} catch(e) {' +
      '  return { pass: false, detail: "Expression error: " + e.message };' +
      '}' +
      'var __pass = ' +
      _buildExpectCheck('__result', expect) +
      ';' +
      'return { pass: __pass, detail: __pass ? ("Result: " + JSON.stringify(__result)) : ("Expected ' +
      (expect.op || 'truthy') +
      ' but got: " + JSON.stringify(__result)) };' +
      '})()';
    return ctx.evaluate(fullExpr);
  },

  // localStorage-check: checks localStorage key, optional path into parsed JSON, against expect
  'localStorage-check': function (params, ctx) {
    var key = String(params.key || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var path = params.path || null;
    var expect = params.expect || { op: 'truthy' };

    var pathCode = '';
    if (path) {
      var parts = String(path).split('.');
      for (var i = 0; i < parts.length; i++) {
        pathCode += '[' + JSON.stringify(parts[i]) + ']';
      }
    }

    var fullExpr =
      '(function() {' +
      "var raw = localStorage.getItem('" +
      key +
      "');" +
      'if (raw === null) return { pass: false, detail: "localStorage key not found: ' +
      key +
      '" };' +
      'var __val;' +
      'try { __val = JSON.parse(raw); } catch(e) { __val = raw; }' +
      (pathCode
        ? 'try { __val = __val' +
          pathCode +
          '; } catch(e) { return { pass: false, detail: "Path access failed: " + e.message }; }'
        : '') +
      'var __pass = ' +
      _buildExpectCheck('__val', expect) +
      ';' +
      'return { pass: __pass, detail: __pass ? ("localStorage[' +
      key +
      ']' +
      (path ? '.' + path : '') +
      ' = " + JSON.stringify(__val)) : ("Value at ' +
      key +
      (path ? '.' + path : '') +
      ' was: " + JSON.stringify(__val)) };' +
      '})()';
    return ctx.evaluate(fullExpr);
  },

  // consistency-check: checks two elements show same numeric value within tolerance
  'consistency-check': function (params, ctx) {
    var selA = String(params.selectorA || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var selB = String(params.selectorB || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    var tolerance = params.tolerance != null ? Number(params.tolerance) : 0.5;
    var expr =
      '(function() {' +
      "var elA = document.querySelector('" +
      selA +
      "');" +
      "var elB = document.querySelector('" +
      selB +
      "');" +
      'if (!elA) return { pass: false, detail: "Element A not found: ' +
      selA +
      '" };' +
      'if (!elB) return { pass: false, detail: "Element B not found: ' +
      selB +
      '" };' +
      'var rawA = (elA.textContent || "").replace(/[$,%,]/g, "").trim();' +
      'var rawB = (elB.textContent || "").replace(/[$,%,]/g, "").trim();' +
      'var numA = parseFloat(rawA);' +
      'var numB = parseFloat(rawB);' +
      'if (isNaN(numA)) return { pass: false, detail: "Cannot parse number from A: " + rawA };' +
      'if (isNaN(numB)) return { pass: false, detail: "Cannot parse number from B: " + rawB };' +
      'var diff = Math.abs(numA - numB);' +
      'var pass = diff <= ' +
      tolerance +
      ';' +
      'return { pass: pass, detail: pass ? ("Values match: " + numA + " vs " + numB) : ("Values differ by " + diff.toFixed(4) + " (" + numA + " vs " + numB + ")") };' +
      '})()';
    return ctx.evaluate(expr);
  },

  // manual: always returns pass: null (requires human verification)
  manual: function (params, ctx) {
    return Promise.resolve({
      pass: null,
      detail: 'Manual verification required: ' + (params.reason || params.description || 'No reason specified'),
    });
  },
};

// ---------------------------------------------------------------------------
// Prerequisite Checks
// Each returns { pass: bool, detail: string } based on localStorage data.
// ---------------------------------------------------------------------------
var BACKLOG_PREREQS = {
  'electric-meter-with-bills': function () {
    var expr =
      '(function() {' +
      'var projects = JSON.parse(localStorage.getItem("en_projects") || "[]");' +
      'var found = false;' +
      'for (var i = 0; i < projects.length; i++) {' +
      '  var ud = JSON.parse(localStorage.getItem("en_utility_" + projects[i].id) || "{}");' +
      '  var buildings = ud.buildings || [];' +
      '  for (var b = 0; b < buildings.length; b++) {' +
      '    var meters = buildings[b].meters || [];' +
      '    for (var m = 0; m < meters.length; m++) {' +
      '      if (meters[m].commodity === "Electric" && (meters[m].bills || []).length >= 3) found = true;' +
      '    }' +
      '  }' +
      '}' +
      'return found;' +
      '})()';
    return expr;
  },

  'gas-meter-with-bills': function () {
    var expr =
      '(function() {' +
      'var projects = JSON.parse(localStorage.getItem("en_projects") || "[]");' +
      'var found = false;' +
      'for (var i = 0; i < projects.length; i++) {' +
      '  var ud = JSON.parse(localStorage.getItem("en_utility_" + projects[i].id) || "{}");' +
      '  var buildings = ud.buildings || [];' +
      '  for (var b = 0; b < buildings.length; b++) {' +
      '    var meters = buildings[b].meters || [];' +
      '    for (var m = 0; m < meters.length; m++) {' +
      '      if (meters[m].commodity === "Gas" && (meters[m].bills || []).length >= 3) found = true;' +
      '    }' +
      '  }' +
      '}' +
      'return found;' +
      '})()';
    return expr;
  },

  'project-with-baseline': function () {
    var expr =
      '(function() {' +
      'var projects = JSON.parse(localStorage.getItem("en_projects") || "[]");' +
      'var found = false;' +
      'for (var i = 0; i < projects.length; i++) {' +
      '  var ud = JSON.parse(localStorage.getItem("en_utility_" + projects[i].id) || "{}");' +
      '  var buildings = ud.buildings || [];' +
      '  for (var b = 0; b < buildings.length; b++) {' +
      '    var meters = buildings[b].meters || [];' +
      '    for (var m = 0; m < meters.length; m++) {' +
      '      var bl = meters[m].baseline;' +
      '      if (bl && bl.months && bl.months.length >= 3) found = true;' +
      '    }' +
      '  }' +
      '}' +
      'return found;' +
      '})()';
    return expr;
  },

  'propane-meter': function () {
    var expr =
      '(function() {' +
      'var projects = JSON.parse(localStorage.getItem("en_projects") || "[]");' +
      'var found = false;' +
      'for (var i = 0; i < projects.length; i++) {' +
      '  var ud = JSON.parse(localStorage.getItem("en_utility_" + projects[i].id) || "{}");' +
      '  var buildings = ud.buildings || [];' +
      '  for (var b = 0; b < buildings.length; b++) {' +
      '    var meters = buildings[b].meters || [];' +
      '    for (var m = 0; m < meters.length; m++) {' +
      '      if (meters[m].commodity === "Propane" && (meters[m].bills || []).length >= 1) found = true;' +
      '    }' +
      '  }' +
      '}' +
      'return found;' +
      '})()';
    return expr;
  },

  'project-with-buildings': function () {
    var expr =
      '(function() {' +
      'var projects = JSON.parse(localStorage.getItem("en_projects") || "[]");' +
      'var found = false;' +
      'for (var i = 0; i < projects.length; i++) {' +
      '  var ud = JSON.parse(localStorage.getItem("en_utility_" + projects[i].id) || "{}");' +
      '  if ((ud.buildings || []).length >= 2) found = true;' +
      '}' +
      'return found;' +
      '})()';
    return expr;
  },
};

// checkPrereqs: runs all required prereq checks via ctx.evaluate, returns { pass, missing }
var checkPrereqs = function (requires, ctx) {
  if (!requires || requires.length === 0) {
    return Promise.resolve({ pass: true, missing: [] });
  }
  var promises = requires.map(function (req) {
    var checker = BACKLOG_PREREQS[req];
    if (!checker) {
      // Unknown prereq — skip (don't block)
      return Promise.resolve({ req: req, pass: true, unknown: true });
    }
    var expr = checker();
    return ctx
      .evaluate(expr)
      .then(function (result) {
        return { req: req, pass: !!result };
      })
      .catch(function () {
        return { req: req, pass: false };
      });
  });
  return Promise.all(promises).then(function (results) {
    var missing = results
      .filter(function (r) {
        return !r.pass && !r.unknown;
      })
      .map(function (r) {
        return r.req;
      });
    return { pass: missing.length === 0, missing: missing };
  });
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
var runBacklogVerification = function (backlogData, ctx) {
  var issues = (backlogData && backlogData.issues) || [];

  // Filter to needs-verification only
  var pending = issues.filter(function (issue) {
    return issue.status === 'needs-verification';
  });

  var testable = [];
  var manual = [];
  var noTest = [];

  pending.forEach(function (issue) {
    if (!issue.testPattern) {
      noTest.push(issue);
    } else if (issue.testPattern === 'manual') {
      manual.push(issue);
    } else {
      testable.push(issue);
    }
  });

  var results = {
    passed: [],
    failed: [],
    skippedManual: [],
    skippedPrereq: [],
    skippedNoTest: [],
    errors: [],
  };

  // Handle manual items immediately
  manual.forEach(function (issue) {
    results.skippedManual.push({
      uuid: issue.uuid,
      title: issue.title,
      detail:
        'Manual verification required' +
        (issue.testParams && issue.testParams.reason ? ': ' + issue.testParams.reason : ''),
    });
  });

  // Handle no-test items immediately
  noTest.forEach(function (issue) {
    results.skippedNoTest.push({
      uuid: issue.uuid,
      title: issue.title,
      detail: 'No testPattern defined',
    });
  });

  // Process testable items sequentially
  var runNext = function (idx) {
    if (idx >= testable.length) {
      return Promise.resolve(results);
    }
    var issue = testable[idx];
    var pattern = issue.testPattern;
    var params = issue.testParams || {};
    var requires = (params && params.requires) || [];

    var executor = BACKLOG_PATTERNS[pattern];
    if (!executor) {
      results.errors.push({
        uuid: issue.uuid,
        title: issue.title,
        detail: 'Unknown pattern: ' + pattern,
      });
      return runNext(idx + 1);
    }

    return checkPrereqs(requires, ctx).then(function (prereqResult) {
      if (!prereqResult.pass) {
        results.skippedPrereq.push({
          uuid: issue.uuid,
          title: issue.title,
          detail: 'Missing prereqs: ' + prereqResult.missing.join(', '),
        });
        return runNext(idx + 1);
      }

      return Promise.resolve()
        .then(function () {
          return executor(params, ctx);
        })
        .then(function (result) {
          var entry = {
            uuid: issue.uuid,
            title: issue.title,
            pattern: pattern,
            pass: result.pass,
            detail: result.detail || '',
          };
          if (result.pass === null) {
            // Returned as manual at runtime
            results.skippedManual.push(entry);
          } else if (result.pass) {
            results.passed.push(entry);
          } else {
            results.failed.push(entry);
          }
          return runNext(idx + 1);
        })
        .catch(function (err) {
          results.errors.push({
            uuid: issue.uuid,
            title: issue.title,
            pattern: pattern,
            detail: 'Runtime error: ' + String(err),
          });
          return runNext(idx + 1);
        });
    });
  };

  return runNext(0);
};

// ---------------------------------------------------------------------------
// Results Formatter
// ---------------------------------------------------------------------------
var formatResults = function (results) {
  var lines = [];
  var sep = '─────────────────────────────────────────';

  lines.push('BACKLOG VERIFICATION RESULTS');
  lines.push(sep);
  lines.push(
    'PASSED: ' +
      results.passed.length +
      ' | FAILED: ' +
      results.failed.length +
      ' | MANUAL: ' +
      results.skippedManual.length +
      ' | PREREQ SKIP: ' +
      results.skippedPrereq.length +
      ' | NO TEST: ' +
      results.skippedNoTest.length +
      ' | ERRORS: ' +
      results.errors.length,
  );
  lines.push('');

  if (results.passed.length > 0) {
    lines.push('PASSED (' + results.passed.length + ')');
    lines.push(sep);
    results.passed.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
      lines.push('    ' + (r.detail || ''));
    });
    lines.push('');
  }

  if (results.failed.length > 0) {
    lines.push('FAILED (' + results.failed.length + ')');
    lines.push(sep);
    results.failed.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
      lines.push('    ' + (r.detail || ''));
    });
    lines.push('');
  }

  if (results.skippedManual.length > 0) {
    lines.push('SKIPPED — Manual (' + results.skippedManual.length + ')');
    lines.push(sep);
    results.skippedManual.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
      lines.push('    ' + (r.detail || ''));
    });
    lines.push('');
  }

  if (results.skippedPrereq.length > 0) {
    lines.push('SKIPPED — Missing Prereqs (' + results.skippedPrereq.length + ')');
    lines.push(sep);
    results.skippedPrereq.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
      lines.push('    ' + (r.detail || ''));
    });
    lines.push('');
  }

  if (results.skippedNoTest.length > 0) {
    lines.push('NO TEST DEFINED (' + results.skippedNoTest.length + ')');
    lines.push(sep);
    results.skippedNoTest.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
    });
    lines.push('');
  }

  if (results.errors.length > 0) {
    lines.push('ERRORS (' + results.errors.length + ')');
    lines.push(sep);
    results.errors.forEach(function (r) {
      lines.push('  [' + r.uuid + '] ' + r.title);
      lines.push('    ' + (r.detail || ''));
    });
    lines.push('');
  }

  return lines.join('\n');
};

// Expose on window for Playwright MCP injection context
if (typeof window !== 'undefined') {
  window.BACKLOG_PATTERNS = BACKLOG_PATTERNS;
  window.BACKLOG_PREREQS = BACKLOG_PREREQS;
  window.checkPrereqs = checkPrereqs;
  window.runBacklogVerification = runBacklogVerification;
  window.formatResults = formatResults;
  window._buildExpectCheck = _buildExpectCheck;
}
