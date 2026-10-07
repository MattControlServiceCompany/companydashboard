// Loads the real app/db.js into a Node vm sandbox (browser globals stubbed) and returns DB. Test helper.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'db.js'), 'utf8');
const win = { addEventListener() {}, dispatchEvent() {}, location: { hostname: 'x' } };
const sandbox = {
  window: win, document: { addEventListener() {}, visibilityState: 'visible' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, CustomEvent: function () {}, Event: function () {}, navigator: {},
  indexedDB: undefined, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
};
win.SyncClassification = require('../app/sync-classification.js'); // the page loads it before db.js
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
module.exports = sandbox.__DB;
