// test-a36-block-fit.js - the block-fit rule of the ASHRAE 36 Detailed report (System Descriptions):
// heading + text + figure + caption stay on one page; the figure is scaled to fit (not below 60 %), else the whole block moves;
// a block taller than a page flows its text and places the figure alone; the figure never comes before its text.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../app/report-engine.js'), 'utf8');
function slice(a, b) {
  const s = src.indexOf(a);
  const e = src.indexOf(b, s + a.length);
  if (s < 0 || e < 0) throw new Error('not found: ' + a);
  return src.slice(s, e);
}
const sb = {
  // stubs: a figure block is 30 px of caption plus its picture height; a text token carries its own height
  _a36DetFigureHtml: (f, sc) => 'FIG' + f.num + ':' + Math.round(f.h * sc),
  _a36DetTok: (html, keepNext) => ({ type: 'block', html: html, estH: html.indexOf('FIG') === 0 ? 30 + Number(html.split(':')[1]) : 40, keepNext: !!keepNext }),
};
vm.createContext(sb);
vm.runInContext(slice('var A36_DET_FIG_MIN_SCALE', '// Words of the listed page text'), sb);
vm.runInContext(slice('var A36_DET_TABLE_GAP_H', 'function _a36DetBody'), sb);
const pag = vm.runInContext('_a36DetPaginate', sb);

let failed = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) failed++;
};
const BUDGET = 700;
// one group: heading (30), n text paragraphs (100 each), then the figure (picture height figH + 30 caption)
function group(name, n, figH) {
  const toks = [{ type: 'block', html: 'H' + name, estH: 30, keepNext: true }];
  for (let i = 0; i < n; i++) toks.push({ type: 'block', html: 'T' + name + i, estH: 100, keepNext: true, blockPart: true });
  const f = { url: 'u', w: 624, h: figH, num: name, caption: 'c', minScale: 0.6, block: true };
  toks.push({ type: 'block', html: 'FIG' + name + ':' + figH, estH: 30 + figH, keepNext: false, fig: f });
  return toks;
}
const names = (chunks) => chunks.map((c) => c.map((t) => t.html).join(',')).join(' | ');
const figOf = (chunks, name) => {
  for (const c of chunks) for (const t of c) if (t.fig && t.fig.num === name) return t;
  return null;
};
// The figure is on a later page, or later on the same page, than every text token of its group.
function figureAfterText(chunks, name) {
  const flat = [];
  chunks.forEach((c) => c.forEach((t) => flat.push(t)));
  const fi = flat.findIndex((t) => t.fig && t.fig.num === name);
  let last = -1;
  flat.forEach((t, i) => {
    if (t.html === 'H' + name || t.html.indexOf('T' + name) === 0) last = i;
  });
  return fi > last;
}
const pageOf = (chunks, pred) => {
  const set = new Set();
  chunks.forEach((c, ci) =>
    c.forEach((t) => {
      if (pred(t)) set.add(ci);
    }),
  );
  return set;
};

// 1. Fits: 30 + 200 + 330 = 560 < 700: one page, figure unchanged.
let r = pag(group('A', 2, 300), BUDGET);
ok(r.length === 1 && figOf(r, 'A').fig.h === 300, 'block that fits stays whole and unscaled (' + names(r) + ')');

// 2. Moved: page holds A (560, 140 left). Block B needs 460 and its figure cannot reach 60 % in the space left.
r = pag(group('A', 2, 300).concat(group('B', 1, 300)), BUDGET);
ok(r.length === 2 && r[1][0].html === 'HB', 'block that cannot fit at 60 % moves whole to the next page (' + names(r) + ')');
ok(figOf(r, 'B').fig.h === 300, 'a moved block keeps its full figure size');

// 3. Below 60 %: A takes 460 (240 left). B fixed part is 160, so the figure would get 80 of 400 px = 20 %: the block moves.
r = pag(group('A', 1, 300).concat(group('B', 1, 400)), BUDGET);
ok(r.length === 2 && r[1][0].html === 'HB', 'a figure that would fall below 60 % moves the block (' + names(r) + ')');

// 4. Scaled: A takes 460 (240 left). D fixed part is 160 and its figure is 130 px: room 80 px = 61.5 %: scaled, one page.
r = pag(group('A', 1, 300).concat(group('D', 1, 130)), BUDGET);
const d = figOf(r, 'D');
ok(r.length === 1 && d.fig.h === 80, 'a figure is scaled down to fit the space left (h 130 -> ' + d.fig.h + ')');
ok(d.fig.minScale === 0.6 && d.fig.block === true, 'a scaled figure keeps its block flags');
ok(Math.abs(d.fig.w - Math.round(624 * (80 / 130))) <= 1, 'scaled width follows the height, aspect kept (w ' + d.fig.w + ')');

// 5. A block taller than a page: heading + 6 paragraphs (630) + figure. The text flows, the figure never comes before it.
r = pag(group('T', 6, 300), BUDGET);
ok(r.length >= 2 && figureAfterText(r, 'T'), 'a block taller than a page: the figure is after its text (' + names(r) + ')');
ok(r[0][0].html === 'HT' && r[0].length > 1, 'the heading keeps its first paragraph');
ok(r.every((c) => c[c.length - 1].html.indexOf('H') !== 0), 'no page ends with a heading');

// 6. Mixed groups: every figure is after its own text, no page is over the budget, and a block that fits one page stays on one page.
let seq = [];
const spec = [
  [1, 200],
  [3, 350],
  [2, 100],
  [5, 420],
  [1, 432],
  [6, 432],
  [2, 250],
];
spec.forEach((g, i) => {
  seq = seq.concat(group('G' + i, g[0], g[1]));
});
r = pag(seq, BUDGET);
ok(spec.every((g, i) => figureAfterText(r, 'G' + i)), 'mixed groups: every figure is after its own text (' + names(r) + ')');
ok(r.every((c) => c.length === 1 || c.reduce((a, t) => a + t.estH, 0) <= BUDGET), 'mixed groups: no page is over the budget (' + r.map((c) => c.reduce((a, t) => a + t.estH, 0)).join(',') + ')');
let together = true;
spec.forEach((g, i) => {
  const blockH = 30 + g[0] * 100 + 30 + g[1];
  const pages = pageOf(r, (t) => t.html === 'HG' + i || t.html.indexOf('TG' + i) === 0 || (t.fig && t.fig.num === 'G' + i));
  if (blockH * 0.8 + 0 <= BUDGET && blockH - g[1] * 0.4 <= BUDGET && pages.size > 1) together = false;
});
ok(together, 'mixed groups: a block that fits one page (figure at 60 %) is never split over two pages');

// 7. Finding figures (no block flag) keep the old minimum of 85 %: the run moves.
r = pag(
  [
    { type: 'block', html: 'X1', estH: 560, keepNext: false },
    { type: 'block', html: 'FND', estH: 100, keepNext: true },
    { type: 'block', html: 'FIGF:100', estH: 130, keepNext: false, fig: { url: 'u', w: 624, h: 100, num: 'F', caption: 'c' } },
  ],
  BUDGET,
);
ok(r.length === 2 && r[1][0].html === 'FND', 'finding figure: the 60 % limit is not used, the run moves (' + names(r) + ')');

// 8. Tail pull-back: A takes 660 (40 left); two findings of 60 go to a page of their own. A's figure (400) made smaller to 320 (80 %)
// gives the room: the findings come back and the chapter ends on one page.
const fnd = (n) => ({ type: 'block', html: 'F' + n, estH: 60, keepNext: false });
r = pag(group('A', 2, 400).concat([fnd(1), fnd(2)]), BUDGET);
ok(r.length === 1 && figOf(r, 'A').fig.h === 320, 'a short tail is pulled back by a smaller figure on the page before (' + names(r) + ')');
// 9. No pull-back when the figure would fall below 60 %: six findings (360) need 320 px of a 400 px figure.
r = pag(group('A', 2, 400).concat([1, 2, 3, 4, 5, 6].map(fnd)), BUDGET);
ok(r.length === 2 && figOf(r, 'A').fig.h === 400, 'a tail that needs the figure below 60 % stays on its page (' + names(r) + ')');

if (failed) {
  console.log(failed + ' FAILED');
  process.exit(1);
}
console.log('ALL PASSED');
