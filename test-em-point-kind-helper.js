// Test helper: the REAL emPointOrMeterKind + emAuditUnitCategory from app/equipment-matrix.js, for sandboxes that load audit-estimate.js.
// Exports emAuditUnitCategory; .kind is emPointOrMeterKind.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/app/equipment-matrix.js', 'utf8');
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', start), depth = 0, end = i;
  for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
  return src.slice(start, end + 1);
}
const ctx = {}; vm.createContext(ctx); vm.runInContext(fn('emPointOrMeterKind') + fn('emAuditUnitCategory'), ctx);
module.exports = ctx.emAuditUnitCategory;
module.exports.kind = ctx.emPointOrMeterKind;
