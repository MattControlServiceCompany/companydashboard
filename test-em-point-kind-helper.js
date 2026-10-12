// Test helper: the REAL emPointOrMeterKind from app/equipment-matrix.js, for sandboxes that load audit-estimate.js.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/app/equipment-matrix.js', 'utf8');
const start = src.indexOf('function emPointOrMeterKind(');
let i = src.indexOf('{', start), depth = 0, end = i;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(start, end + 1), ctx);
module.exports = ctx.emPointOrMeterKind;
