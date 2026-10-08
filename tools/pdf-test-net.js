// pdf-test-net.js — test-only helper for the PDF gate tests. No OCR and no repeat CDN downloads:
//  - the OCR engine (tesseract) is blocked, so a synthetic bill never starts a slow OCR retry;
//  - other CDN scripts (pdf.js, charts) are fetched once, then served from memory on every page load.
async function fastNet(ctx) {
  const cache = new Map();
  await ctx.route(/^https?:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//, async (route) => {
    const u = route.request().url();
    if (/tesseract/i.test(u)) return route.abort();
    try {
      if (!cache.has(u)) cache.set(u, await route.fetch());
      return route.fulfill({ response: cache.get(u) });
    } catch (e) {
      return route.abort();
    }
  });
}
module.exports = { fastNet };
