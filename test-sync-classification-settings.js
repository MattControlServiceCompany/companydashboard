// Settings and bill-review keys: per-user, shared, or local, by the one classifier.
const assert = require('assert');
const S = require('./app/sync-classification.js');
const want = {
  ch_settings: 'per-user',
  ch_projTabOrder_p1: 'per-user',
  ch_defaultProjTab: 'per-user',
  ch_tbl_hidden_t1: 'per-user',
  ch_tbl_col_widths_t1: 'per-user',
  ch_tbl_colschema_ver_t1: 'per-user',
  ch_theme: 'per-user',
  bcr_result_b1_s1__TotalAmountDue: 'synced',
  bcr_pdftext_k1: 'local-only',
  ch_sync_queue: 'local-only',
};
Object.keys(want).forEach((k) => assert.strictEqual(S.classifyKey(k), want[k], k));
console.log('PASS settings and bcr key classes (' + Object.keys(want).length + ')');
