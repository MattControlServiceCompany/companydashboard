// Real-browser test (headless bundled Chromium, local static server, no real data): the load toast is one plain line,
// the fallback showToast keeps the X button, a stored duration of 0 never makes a toast stick, and reasonLabel()
// never lets a field name or rule id through.
// Run: node test-onload-toast.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const http = require('http');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const web = http.createServer((req, res) => {
  const f = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(__dirname)) return res.writeHead(403).end();
  fs.readFile(f, (e, d) => {
    if (e) return res.writeHead(404).end();
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
});
let pass = 0;
let fail = 0;
function ok(c, l) {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL ' + l);
  }
}
(async () => {
  let ctx;
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  try {
    ctx = await launchBrowser('onload-toast', { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:' + web.address().port + '/energy-department.html');
    await page.waitForTimeout(1500);
    const r = await page.evaluate(async () => {
      const out = {};
      const raws = [
        'the fresh value does not pass reads_identity',
        'the fresh value does not pass reads_identity, kwh_identity',
        'held: the reader filled or changed StartRead (not printed on the page)',
        'the reader filled or changed startRead (not printed on the page)',
        'would add the flag period_overlap',
        'next to period_overlap',
        'startRead: the stored value passes every check of the bill',
        'the value is not printed on the bill page',
      ];
      out.labels = raws.map((x) => reasonLabel(x));
      localStorage.setItem('ch_toast_duration', '0');
      showToast('303 bills re-read: 33 fixed, 65 need review');
      out.msg = document.getElementById('toastMsg').textContent;
      out.x = !!document.querySelector('#toast .toast-x');
      out.shown = document.getElementById('toast').classList.contains('toast-show');
      await new Promise((res) => setTimeout(res, 3900));
      out.hidden = !document.getElementById('toast').classList.contains('toast-show');
      showToast('sticky', undefined, 0);
      await new Promise((res) => setTimeout(res, 3900));
      out.stickyKept = document.getElementById('toast').classList.contains('toast-show');
      document.querySelector('#toast .toast-x').click();
      out.closedByX = !document.getElementById('toast').classList.contains('toast-show');
      return out;
    });
    r.labels.forEach((l) => ok(!/[a-z]+_[a-z]+|[a-z]+[A-Z]/.test(l.replace(/kWh/g, '')), 'plain words: ' + l));
    ok(r.msg === '303 bills re-read: 33 fixed, 65 need review', 'toast text set in #toastMsg');
    ok(r.x && r.shown, 'X button kept and toast shown');
    ok(r.hidden, 'stored duration 0 does not make a toast stick');
    ok(r.stickyKept, 'explicit ms 0 keeps the toast');
    ok(r.closedByX, 'X closes the toast');
  } finally {
    if (ctx) await ctx.close();
    web.close();
  }
  console.log('onload-toast: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
