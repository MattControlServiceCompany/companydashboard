// Draws the extracted-values grid of one synthetic bill in node (no browser) and returns the html of the grid.
module.exports = function render(bill) {
  const els = {};
  const mk = (id) =>
    (els[id] = els[id] || {
      id,
      innerHTML: '',
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild() {},
      setAttribute() {},
      addEventListener() {},
      dataset: {},
      children: [],
    });
  const doc = {
    getElementById: (id) => mk(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mk('x' + Math.random()),
    addEventListener() {},
    body: mk('body'),
    documentElement: mk('html'),
  };
  const sb = require('./ocr-sandbox.js')({ document: doc, window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1600, location: { hostname: 'localhost' } } });
  require('vm').runInContext('findMeterMatch = function () { return null; };', sb);
  sb.window._pdfMultiBills = [bill];
  sb.window._pdfMultiIdx = 0;
  sb.get('renderPDFFields')(bill, []);
  return { grid: els.extractedFieldsGrid ? els.extractedFieldsGrid.innerHTML : '', sb, els };
};
