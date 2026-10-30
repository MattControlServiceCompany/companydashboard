// tools/test-tab-overflow-arrows.js - project tab strip arrows (finding #9, 2026-10-30). SYNTHETIC fake DOM only.
// Checks: arrow show/hide logic (_tabArrowState / _tabArrowsUpdate), click scrolls ~one strip width, resize + scroll
// update, and that sPTab scrolls the active tab into view (inline:'nearest').
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'energy-department.html'), 'utf8');
const fn = (name) => {
  const m = src.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
  return m ? m[0] : '';
};
let fails = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + (d || ''))); if (!ok) fails++; };

const listeners = { nav: {}, win: {}, l: {}, r: {} };
const nav = { scrollLeft: 0, clientWidth: 1000, scrollWidth: 1000, scrolled: null,
  addEventListener: (e, f) => (listeners.nav[e] = f), scrollBy(o) { this.scrolled = o; } };
const L = { hidden: true, addEventListener: (e, f) => (listeners.l[e] = f) };
const R = { hidden: true, addEventListener: (e, f) => (listeners.r[e] = f) };
const sandbox = { window: { addEventListener: (e, f) => (listeners.win[e] = f) },
  document: { getElementById: (id) => ({ hdrTabs: nav, hdrTabsL: L, hdrTabsR: R })[id] || null } };
vm.createContext(sandbox);
vm.runInContext(fn('_tabArrowState') + fn('_tabArrowsUpdate') + fn('_tabArrowsInit'), sandbox);
const run = (c) => vm.runInContext(c, sandbox);
sandbox.nav = nav;

nav.scrollWidth = 1000; run('_tabArrowsUpdate()');
check('no overflow: both hidden', L.hidden && R.hidden);
nav.scrollWidth = 1500; nav.scrollLeft = 0; run('_tabArrowsUpdate()');
check('overflow at start: only right shown', L.hidden && !R.hidden);
nav.scrollLeft = 250; run('_tabArrowsUpdate()');
check('overflow mid: both shown', !L.hidden && !R.hidden);
nav.scrollLeft = 500; run('_tabArrowsUpdate()');
check('overflow at end: only left shown', !L.hidden && R.hidden);
nav.scrollWidth = 1000; nav.scrollLeft = 0; run('_tabArrowsUpdate()');
check('resize to fit: both hidden again', L.hidden && R.hidden);

run('_tabArrowsInit()');
check('scroll + resize listeners wired', typeof listeners.nav.scroll === 'function' && typeof listeners.win.resize === 'function');
nav.scrollWidth = 1500; listeners.win.resize();
check('resize event updates arrows', !R.hidden);
listeners.r.click();
check('right click scrolls about one strip width', nav.scrolled && nav.scrolled.left === 1000, JSON.stringify(nav.scrolled));
nav.scrollLeft = 500; listeners.nav.scroll();
listeners.l.click();
check('left click scrolls back one strip width', nav.scrolled && nav.scrolled.left === -1000, JSON.stringify(nav.scrolled));

const sp = fn('sPTab');
check("sPTab scrolls the active tab into view (inline:'nearest')", /el\.scrollIntoView\(\{ inline: 'nearest'/.test(sp));
check('markup has both arrow buttons, hidden by default', /id="hdrTabsL"[^>]*hidden/.test(html) && /id="hdrTabsR"[^>]*hidden/.test(html));
check('arrows use site tokens (no hex in arrow CSS)', !/\.hdr-tabs-arrow[^}]*#[0-9a-fA-F]{3,6}/.test(html));
console.log(fails ? 'FAIL: ' + fails : 'PASS');
process.exit(fails ? 1 : 0);
