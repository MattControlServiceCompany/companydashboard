// pdf-test-net.js — test-only helper for the PDF gate tests. No OCR and no repeat CDN downloads:
//  - the OCR engine (tesseract) is blocked, so a synthetic bill never starts a slow OCR retry;
//  - other CDN scripts (pdf.js, charts) come from the shared cache in tools/gate-cdn-cache.js (once per context).
const { cdnRoute, CDN_RE } = require('./gate-cdn-cache.js');
async function fastNet(ctx) {
  await cdnRoute(ctx);
  // Registered last, so it runs first: tesseract is aborted, every other CDN file falls through to the cache route.
  await ctx.route(CDN_RE, (route) => (/tesseract/i.test(route.request().url()) ? route.abort() : route.fallback()));
}
module.exports = { fastNet };
