// ═══════════════════════════════════════════════════
// SCOPE TREE — the ONE cascading checkbox tree used by every report/export picker
// (item 5e60fae2, 2026-09-22). Callers build a plain node list and hand it here:
//   - Generate Report modal      (report-engine.js openReportModalV2)  building → meter
//   - ASHRAE 36 report modal     (report-engine.js openASHRAE36ReportModal) building only
//   - Export Utility Data modal  (utility-data.js _renderExportScopeTree) project → building → meter
// Behavior: a parent toggles every enabled descendant; a child toggle re-derives every ancestor
// (checked = all enabled children checked, indeterminate = some). Disabled rows never change.
//
// Node shape: { id, kind, label, sub, checked, disabled, hint, attrs:{name:value}, children:[node] }
//   kind  — free string ('proj' | 'bldg' | 'meter'); readers select by it.
//   attrs — extra data-* attributes on the checkbox (e.g. bid/pid) so a reader can join without
//           walking the DOM.
// ═══════════════════════════════════════════════════

function _scopeTreeEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pure string builder (no DOM) — testable in Node. opts.onChange = name of a global function
// called with the root element after any toggle.
function scopeTreeHTML(nodes, opts) {
  opts = opts || {};
  function render(node, depth) {
    var kids = node.children || [];
    var disabled =
      !!node.disabled ||
      (kids.length > 0 &&
        kids.every(function (k) {
          return k.disabled;
        }));
    var attrs = '';
    Object.keys(node.attrs || {}).forEach(function (k) {
      attrs += ' data-' + k + '="' + _scopeTreeEsc(node.attrs[k]) + '"';
    });
    var h =
      '<div class="st-node">' +
      '<label class="st-row" style="display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;background:var(--s2);cursor:' +
      (disabled ? 'default;opacity:.55' : 'pointer') +
      '">' +
      '<input type="checkbox" class="st-cb" data-kind="' +
      _scopeTreeEsc(node.kind) +
      '" data-id="' +
      _scopeTreeEsc(node.id) +
      '"' +
      attrs +
      (node.checked && !disabled ? ' checked' : '') +
      (disabled ? ' disabled' : '') +
      ' onchange="_scopeTreeToggle(this)" style="accent-color:var(--em);width:14px;height:14px;flex-shrink:0">' +
      '<span style="font-size:12px;color:var(--text);' +
      (depth === 0 ? 'font-weight:600;' : '') +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      _scopeTreeEsc(node.label) +
      '</span>' +
      (node.hint ? '<span style="font-size:10px;color:var(--text3)">' + _scopeTreeEsc(node.hint) + '</span>' : '') +
      (node.sub
        ? '<span style="font-size:10px;color:var(--text3);margin-left:auto;white-space:nowrap">' +
          _scopeTreeEsc(node.sub) +
          '</span>'
        : '') +
      '</label>';
    if (kids.length) {
      h +=
        '<div class="st-children" style="padding-left:20px;display:flex;flex-direction:column;gap:2px;margin-top:2px">';
      kids.forEach(function (k) {
        h += render(k, depth + 1);
      });
      h += '</div>';
    }
    return h + '</div>';
  }
  var out =
    '<div class="scope-tree" data-onchange="' +
    _scopeTreeEsc(opts.onChange || '') +
    '" style="display:flex;flex-direction:column;gap:2px">';
  (nodes || []).forEach(function (n) {
    out += render(n, 0);
  });
  return out + '</div>';
}

function _scopeTreeOwnCb(node) {
  return node.querySelector(':scope > .st-row > .st-cb');
}
function _scopeTreeChildCbs(node) {
  return Array.from(node.querySelectorAll(':scope > .st-children > .st-node > .st-row > .st-cb'));
}
function _scopeTreeParentNode(node) {
  return node.parentElement ? node.parentElement.closest('.st-node') : null;
}

// Re-derive one node's checked/indeterminate state from its enabled children, then its ancestors.
function _scopeTreeSyncUp(node) {
  var parent = _scopeTreeParentNode(node);
  while (parent) {
    var kids = _scopeTreeChildCbs(parent).filter(function (k) {
      return !k.disabled;
    });
    var pcb = _scopeTreeOwnCb(parent);
    var n = kids.filter(function (k) {
      return k.checked;
    }).length;
    var partial = kids.some(function (k) {
      return k.indeterminate;
    });
    pcb.checked = kids.length > 0 && n === kids.length && !partial;
    pcb.indeterminate = partial || (n > 0 && n < kids.length);
    parent = _scopeTreeParentNode(parent);
  }
}

// onchange handler on every checkbox: cascade down, then sync ancestors, then notify the caller.
function _scopeTreeToggle(cb) {
  var node = cb.closest('.st-node');
  cb.indeterminate = false;
  node.querySelectorAll('.st-children .st-cb').forEach(function (c) {
    if (!c.disabled) c.checked = cb.checked;
    c.indeterminate = false;
  });
  _scopeTreeSyncUp(node);
  var root = cb.closest('.scope-tree');
  var fn = root && root.getAttribute('data-onchange');
  if (fn && typeof window[fn] === 'function') window[fn](root);
}

// Call once after the tree HTML is in the DOM (and after any programmatic check change) so
// every parent shows checked / partial / unchecked from its children.
function scopeTreeSync(root) {
  if (!root) return;
  root.querySelectorAll('.st-node').forEach(function (node) {
    if (!node.querySelector(':scope > .st-children')) _scopeTreeSyncUp(node);
  });
}

// Select all / none (enabled rows only).
function scopeTreeSetAll(root, checked) {
  if (!root) return;
  root.querySelectorAll('.st-cb').forEach(function (cb) {
    if (!cb.disabled) cb.checked = !!checked;
    cb.indeterminate = false;
  });
  scopeTreeSync(root);
}

// Ids (or another data-* attribute) of every checked checkbox of one kind, de-duplicated.
function scopeTreeChecked(root, kind, attr) {
  var out = [];
  if (!root) return out;
  root.querySelectorAll('.st-cb[data-kind="' + kind + '"]:checked').forEach(function (cb) {
    var v = cb.getAttribute('data-' + (attr || 'id'));
    if (v != null && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

// Programmatically check exactly the given ids of one kind (matched on data-<attr>, default id),
// leaving disabled rows alone, then re-derive every parent.
function scopeTreeSetChecked(root, kind, ids, attr) {
  if (!root) return;
  var want = (ids || []).map(String);
  root.querySelectorAll('.st-cb[data-kind="' + kind + '"]').forEach(function (cb) {
    if (cb.disabled) return;
    cb.checked = want.indexOf(cb.getAttribute('data-' + (attr || 'id'))) >= 0;
    cb.indeterminate = false;
  });
  scopeTreeSync(root);
}
