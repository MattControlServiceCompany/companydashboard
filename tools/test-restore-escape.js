/**
 * test-restore-escape.js
 * The restore dialog result table and held-key checkbox build HTML from key names and result text.
 * A value with " ' < > & must render as TEXT and must never add an attribute or an element.
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), unique C:\Temp profile, no network.
 * Usage: node tools/test-restore-escape.js   (env APP_ROOT=<checkout>)
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

const SF = fs.readFileSync(path.join(ROOT, 'app', 'site-functions.js'), 'utf8');
function grab(name) {
  const i = SF.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  const j = i + SF.slice(i).search(/\r?\n\}\r?\n/) + 3;
  return SF.slice(i, j);
}
const src = grab('_restoreEsc') + grab('_restoreResultTable');
const EVIL = `x" onmouseover="window.__x=1" '\' <b id=inj>&amp;</b> <script>window.__x=2</script> ' onfocus='window.__x=3`;

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('restore-escape');
  try {
    const page = await ctx.newPage();
    await page.setContent('<body></body>');
    const r = await page.evaluate(
      ({ src, EVIL }) => {
        const f = new Function(src + '; return { esc: _restoreEsc, table: _restoreResultTable };')();
        const plan = { items: [{ key: EVIL, label: EVIL }], skipped: [{ key: EVIL, why: EVIL }] };
        const res = { results: [{ key: EVIL, ok: true, action: EVIL, httpStatus: 200 }] };
        const box = document.createElement('div');
        box.innerHTML = f.table(plan, res);
        // attribute contexts, both quote styles, as the dialog builds them
        const a = document.createElement('div');
        a.innerHTML =
          '<input class="d" data-key="' + f.esc(EVIL) + '"><input class="s" data-key=\'' + f.esc(EVIL) + "'>";
        const tds = Array.from(box.querySelectorAll('td'));
        return {
          injected: box.querySelectorAll('b,script,#inj').length + a.querySelectorAll('b,script,#inj').length,
          tdAttrs: tds.map((t) => t.getAttributeNames().join(',')),
          detailTitle: tds[2].getAttribute('title'),
          detailText: tds[2].textContent,
          keyText: tds[0].textContent,
          skippedText: tds[5].textContent,
          inputAttrs: Array.from(a.querySelectorAll('input')).map((i) => i.getAttributeNames().join(',')),
          dkeys: Array.from(a.querySelectorAll('input')).map((i) => i.getAttribute('data-key')),
          x: window.__x || 0,
        };
      },
      { src, EVIL },
    );
    ok(r.injected === 0, 'no element injected from the value (' + r.injected + ')');
    ok(r.x === 0, 'no handler ran');
    ok(r.detailTitle === EVIL && r.detailText === EVIL, 'detail cell: title and text equal the raw value');
    ok(r.keyText === EVIL && r.skippedText === EVIL, 'key cell and skipped cell show the value as text');
    ok(
      r.tdAttrs[2] === 'title' && r.tdAttrs.every((x) => !/onmouse|onfocus/.test(x)),
      'detail cell has only the title attribute: ' + r.tdAttrs.join('|'),
    );
    ok(
      r.inputAttrs.every((x) => x === 'class,data-key') && r.dkeys.every((k) => k === EVIL),
      'double- and single-quoted attributes hold the value, no extra attribute',
    );
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
