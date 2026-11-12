// tools/test-picture-folder-once.js - the Detailed audit report asks for the pictures folder ONCE (app/picture-folder.js).
// SYNTHETIC project and fake directory handles, headless bundled Chromium. Run: CH_TMP_ROOT=<scratch> node tools/test-picture-folder-once.js
//   1. A stored handle with permission 'granted': no picker call, no prompt, the files (subfolders included) are returned and counted.
//   2. A stored handle with permission 'prompt': the panel shows "Allow access to <folder>"; requestPermission runs only on the click; no picker call.
//   3. Files on the #a36PictureDir input win over the stored handle.
//   4. "Choose picture folder" calls showDirectoryPicker straight from the click (user activation still active), stores the handle,
//      then the button says "Change folder". A cancelled picker (AbortError) is silent; another error shows a toast.
//   5. Without showDirectoryPicker the hidden input #a36PictureDir opens (fallback), and the button text stays "Choose picture folder".
//   6. The preview reads the pictures from the remembered folder (files of subfolders too); with nothing chosen it builds with no wait.
//   7. Saved pictures (Firefox has no showDirectoryPicker): pictureFolderSelectToSave keeps only the needed files and the library
//      front photos; after a folder pick the report saves them; later, with no folder chosen, the report uses the saved set (panel text
//      "The report uses the N saved pictures", button "Change folder", no prompt); files of a folder chosen again replace saved files of the same name, the others stay; a
//      folder with none of the needed pictures keeps it.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('picture-folder-once');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36Preview === 'function' && typeof pictureFolderRestore === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    await page.evaluate(() => {
      const l = document.getElementById('loginScreen');
      if (l) l.remove();
      const q = document.getElementById('qsOverlay');
      if (q) q.remove();
      document.getElementById('app').classList.add('visible');
    });

    // ---- synthetic project + fakes (a fake IndexedDB for the picture database only: a fake handle cannot be cloned) ----
    const PID = await page.evaluate(async () => {
      const PID = 900002;
      const rows = [{ id: 'r1', building: 'Alpha Library', category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55.2 °F' } }];
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library'] });
      await sset('en_audit_' + PID, {
        findings: [],
        edits: {},
        evidence: {},
        pictureMap: [
          { file: 'syn-1.png', building: 'Alpha Library', equipName: 'AHU-1', page: 'graphic', cited: true },
          { file: 'syn-2.png', building: 'Alpha Library', equipName: 'AHU-1', page: 'graphic', cited: false },
          { file: 'syn-3.png', building: 'Alpha Library', equipName: 'AHU-1', page: 'graphic', cited: false },
        ],
      });
      // fake IndexedDB for 'ch-picture-folder' only; every other database goes to the real one
      const realIndexedDB = window.indexedDB;
      window.__fakeStore = {};
      window.__fakeSaved = {}; // the store "pictures"
      window.__realIndexedDB = realIndexedDB;
      window.__fakeIndexedDB = {
        open: function (name, version) {
          if (name !== 'ch-picture-folder') return realIndexedDB.open(name, version);
          const request = {};
          setTimeout(() => {
            request.result = {
              close() {},
              transaction(storeName) {
                const tx = {};
                const bag = () => (storeName === 'pictures' ? window.__fakeSaved : window.__fakeStore);
                return Object.assign(tx, {
                  objectStore() {
                    return {
                      get(key) {
                        const req = { result: bag()[key] };
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
                        return req;
                      },
                      put(value, key) {
                        bag()[key] = value;
                        const req = { result: key };
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
                        return req;
                      },
                    };
                  },
                });
              },
            };
            request.onsuccess && request.onsuccess();
          }, 0);
          return request;
        },
      };
      Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => window.__fakeIndexedDB });
      // fakes
      window.__pickerCalls = 0;
      window.__activeAtPicker = null;
      window.__fakeFile = (name) => ({ kind: 'file', name, getFile: async () => new File(['x'], name, { type: 'image/png' }) });
      window.__fakeDir = (name, entries, permission) => {
        const handle = {
          kind: 'directory',
          name,
          perm: permission,
          requests: 0,
          queries: 0,
          queryPermission: async () => {
            handle.queries++;
            return handle.perm;
          },
          requestPermission: async () => {
            handle.requests++;
            handle.perm = 'granted';
            return 'granted';
          },
          values: async function* () {
            for (const entry of entries) yield entry;
          },
        };
        return handle;
      };
      window.__tree = (name, permission) => window.__fakeDir(name, [window.__fakeFile('syn-1.png'), window.__fakeDir('inner', [window.__fakeFile('syn-2.png')], 'granted'), window.__fakeFile('other.png')], permission);
      window.__resetModule = () => {
        _pictureFolderState = {};
      };
      window.__openDetailed = async () => {
        openASHRAE36ReportModal(PID, 'audit');
        const det = document.querySelector('input[name="a36Style"][value="detailed"]');
        det.checked = true;
        _a36StyleChanged();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return {
          status: document.getElementById('a36PictureStatus').textContent,
          allowShown: document.getElementById('a36PictureAllowBox').style.display !== 'none',
          allowText: document.getElementById('a36PictureAllowBtn').textContent,
          btn: document.getElementById('a36PictureBtn').textContent,
        };
      };
      return PID;
    });
    const stubPicker = (result) =>
      page.evaluate((r) => {
        window.__pickerCalls = 0;
        window.showDirectoryPicker = function (opts) {
          window.__pickerCalls++;
          window.__activeAtPicker = navigator.userActivation.isActive;
          window.__pickerOpts = opts;
          if (r === 'abort') return Promise.reject(new DOMException('cancelled', 'AbortError'));
          if (r === 'fail') return Promise.reject(new Error('Synthetic picker failure'));
          return Promise.resolve(r === 'tree-b' ? window.__tree('syn-folder-b', 'granted') : window.__tree('syn-folder-new', 'granted'));
        };
      }, result);

    // ---- 1. granted ----
    await stubPicker('tree-b');
    const granted = await page.evaluate(async (pid) => {
      const handle = window.__tree('syn-folder', 'granted');
      window.__granted = handle;
      await _pictureFolderStoredPut(pid, handle);
      window.__resetModule();
      const shown = await window.__openDetailed();
      const files = await pictureFolderFiles(pid, document.getElementById('a36PictureDir'));
      return { shown, names: files.map((f) => f.name).sort(), picker: window.__pickerCalls, requests: handle.requests, hasChoice: pictureFolderHasChoice(pid, document.getElementById('a36PictureDir')) };
    }, PID);
    ok(granted.picker === 0 && granted.requests === 0, 'granted: no picker call, no permission request (picker ' + granted.picker + ', requests ' + granted.requests + ')');
    ok(JSON.stringify(granted.names) === JSON.stringify(['other.png', 'syn-1.png', 'syn-2.png']), 'granted: files returned, subfolder included: ' + granted.names.join(','));
    ok(granted.shown.status === '2 of 3 pictures found in the folder (folder: syn-folder)', 'granted: status shows the remembered folder name: "' + granted.shown.status + '"');
    ok(!granted.shown.allowShown && granted.shown.btn === 'Change folder' && granted.hasChoice, 'granted: no Allow button, choose button reads "Change folder"');
    // screenshots only on request (CH_SHOT_DIR); the gate fails a test that leaves files in its temp folder
    if (process.env.CH_SHOT_DIR) await page.screenshot({ path: path.join(process.env.CH_SHOT_DIR, 'picture-remembered.png') }).catch(() => {});
    await page.evaluate(() => {
      const box = document.getElementById('a36PictureBox');
      box.scrollIntoView();
    });
    // screenshots only on request (CH_SHOT_DIR); the gate fails a test that leaves files in its temp folder
    if (process.env.CH_SHOT_DIR) await page.locator('#a36PictureBox').screenshot({ path: path.join(process.env.CH_SHOT_DIR, 'picture-box-remembered.png') }).catch(() => {});

    // ---- 1b. a project with no folder of its own uses the last folder chosen ----
    const lastChosen = await page.evaluate(async () => {
      const handle = window.__tree('syn-last-folder', 'granted');
      await _pictureFolderStoredPut(PICTURE_FOLDER_LAST_KEY, handle);
      window.__resetModule();
      const state = await pictureFolderRestore('syn-project-without-folder');
      return { name: state.name, permission: state.permission, fileCount: (state.files || []).length, requests: handle.requests, picker: window.__pickerCalls };
    });
    ok(
      lastChosen.name === 'syn-last-folder' && lastChosen.permission === 'granted' && lastChosen.fileCount > 0 && lastChosen.requests === 0 && lastChosen.picker === 0,
      'last chosen: a project with no folder uses the last folder chosen, no picker, no prompt (' + JSON.stringify(lastChosen) + ')',
    );

    // ---- 2. prompt ----
    await stubPicker('tree-b');
    const prompt = await page.evaluate(async (pid) => {
      const handle = window.__tree('syn-folder-p', 'prompt');
      window.__promptHandle = handle;
      await _pictureFolderStoredPut(pid, handle);
      window.__resetModule();
      const shown = await window.__openDetailed();
      return { shown, requests: handle.requests, picker: window.__pickerCalls, files: pictureFolderCurrent(pid).files.length, hasChoice: pictureFolderHasChoice(pid, document.getElementById('a36PictureDir')) };
    }, PID);
    ok(prompt.shown.allowShown && prompt.shown.allowText === 'Allow access to syn-folder-p', 'prompt: one button "' + prompt.shown.allowText + '" is shown');
    ok(prompt.requests === 0 && prompt.picker === 0 && prompt.files === 0 && !prompt.hasChoice, 'prompt: before the click no permission request, no picker call, no file read');
    // screenshots only on request (CH_SHOT_DIR); the gate fails a test that leaves files in its temp folder
    if (process.env.CH_SHOT_DIR) await page.locator('#a36PictureBox').screenshot({ path: path.join(process.env.CH_SHOT_DIR, 'picture-box-allow.png') }).catch(() => {});
    await page.click('#a36PictureAllowBtn');
    await page.waitForTimeout(500);
    const afterAllow = await page.evaluate(() => ({
      requests: window.__promptHandle.requests,
      picker: window.__pickerCalls,
      status: document.getElementById('a36PictureStatus').textContent,
      allowShown: document.getElementById('a36PictureAllowBox').style.display !== 'none',
    }));
    ok(afterAllow.requests === 1 && afterAllow.picker === 0, 'prompt: the click makes ONE requestPermission and no picker call');
    ok(afterAllow.status === '2 of 3 pictures found in the folder (folder: syn-folder-p)' && !afterAllow.allowShown, 'prompt: after the click the files are counted and the button is gone: "' + afterAllow.status + '"');

    // ---- 3. input files win over the stored handle ----
    const winner = await page.evaluate(async (pid) => {
      await window.__openDetailed();
      const dt = new DataTransfer();
      ['syn-3.png', 'syn-1.png'].forEach((n) => dt.items.add(new File(['x'], n, { type: 'image/png' })));
      const input = document.getElementById('a36PictureDir');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      const files = await pictureFolderFiles(pid, input);
      return { names: files.map((f) => f.name), status: document.getElementById('a36PictureStatus').textContent };
    }, PID);
    ok(JSON.stringify(winner.names) === JSON.stringify(['syn-3.png', 'syn-1.png']), 'input wins: the input files are returned, not the stored handle files (' + winner.names.join(',') + ')');
    ok(winner.status === '2 of 3 pictures found in the folder', 'input wins: status counts the input files: "' + winner.status + '"');

    // ---- 4. choose / change folder ----
    await stubPicker('tree-b');
    await page.evaluate(async () => {
      window.__fakeStore = {};
      window.__fakeSaved = {};
      window.__resetModule();
      await window.__openDetailed();
    });
    ok((await page.textContent('#a36PictureBtn')) === 'Choose picture folder', 'no remembered folder: the button reads "Choose picture folder"');
    await page.click('#a36PictureBtn');
    await page.waitForTimeout(600);
    const picked = await page.evaluate((pid) => ({
      picker: window.__pickerCalls,
      active: window.__activeAtPicker,
      opts: window.__pickerOpts,
      stored: !!window.__fakeStore[String(pid)] && window.__fakeStore[String(pid)].name,
      status: document.getElementById('a36PictureStatus').textContent,
      btn: document.getElementById('a36PictureBtn').textContent,
    }), PID);
    ok(picked.picker === 1 && picked.active === true && picked.opts.mode === 'read', 'choose: ONE picker call, made while the click activation was still active (no await before it)');
    ok(picked.stored === 'syn-folder-b', 'choose: the handle is stored in the picture database (' + picked.stored + ')');
    ok(picked.status === '2 of 3 pictures found in the folder (folder: syn-folder-b)' && picked.btn === 'Change folder', 'choose: status "' + picked.status + '", button "' + picked.btn + '"');
    await page.click('#a36PictureBtn');
    await page.waitForTimeout(400);
    ok((await page.evaluate(() => window.__pickerCalls)) === 2, 'Change folder opens the picker again (only on the click)');
    // cancelled picker is silent
    await stubPicker('abort');
    await page.evaluate(() => {
      document.getElementById('toastMsg').textContent = '';
      document.getElementById('toast').className = 'toast';
    });
    await page.click('#a36PictureBtn');
    await page.waitForTimeout(400);
    const aborted = await page.evaluate(() => ({ text: document.getElementById('toastMsg').textContent, shown: document.getElementById('toast').classList.contains('toast-show') }));
    ok(!aborted.shown && aborted.text === '', 'a cancelled picker (AbortError) shows no toast');
    await stubPicker('fail');
    await page.click('#a36PictureBtn');
    await page.waitForTimeout(400);
    const failed = await page.evaluate(() => document.getElementById('toastMsg').textContent);
    ok(/Could not use the picture folder: Synthetic picker failure/.test(failed), 'another picker error shows a toast: "' + failed + '"');

    // ---- 5. no showDirectoryPicker: the hidden input is the fallback ----
    const fallback = await page.evaluate(async () => {
      delete window.showDirectoryPicker;
      window.__fakeStore = {};
      window.__fakeSaved = {};
      window.__resetModule();
      await window.__openDetailed();
      let inputClicks = 0;
      const input = document.getElementById('a36PictureDir');
      input.addEventListener('click', (e) => {
        inputClicks++;
        e.preventDefault();
      });
      document.getElementById('a36PictureBtn').click();
      return { inputClicks, supported: pictureFolderPickerSupported(), btn: document.getElementById('a36PictureBtn').textContent, hidden: input.style.display === 'none', webkit: input.hasAttribute('webkitdirectory') };
    });
    ok(fallback.inputClicks === 1 && !fallback.supported && fallback.btn === 'Choose picture folder' && fallback.hidden && fallback.webkit, 'no showDirectoryPicker: the button opens the hidden webkitdirectory input; text unchanged');

    // ---- 6. the preview reads the remembered folder ----
    const preview = await page.evaluate(async (pid) => {
      window.showDirectoryPicker = () => Promise.reject(new Error('must not be called'));
      const handle = window.__tree('syn-folder-r', 'granted');
      await _pictureFolderStoredPut(pid, handle);
      window.__resetModule();
      await window.__openDetailed();
      const original = _a36DetLoadPictures;
      window.__loadedWith = null;
      _a36DetLoadPictures = function (files, needed) {
        window.__loadedWith = Array.prototype.map.call(files, (f) => f.name).sort();
        return original(files, needed);
      };
      generateASHRAE36Preview();
      for (let i = 0; i < 100 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
      const withFolder = { names: window.__loadedWith, pages: document.querySelectorAll('#reportPages .rpt-page').length };
      // nothing chosen: the preview is built at once (no wait for a folder read)
      document.getElementById('reportOverlay') && document.getElementById('reportOverlay').classList.remove('open');
      window.__fakeStore = {};
      window.__fakeSaved = {};
      window.__resetModule();
      window.__loadedWith = null;
      await window.__openDetailed();
      generateASHRAE36Preview();
      const builtAtOnce = !!document.querySelector('#reportPages .rpt-page');
      return { withFolder, none: { builtAtOnce, loadedWith: window.__loadedWith } };
    }, PID);
    ok(preview.withFolder.names && preview.withFolder.names.join(',') === 'other.png,syn-1.png,syn-2.png', 'preview: pictures are read from the remembered folder, subfolder files included (' + (preview.withFolder.names || []).join(',') + ')');
    ok(preview.withFolder.pages > 0, 'preview: the report has pages (' + preview.withFolder.pages + ')');
    ok(preview.none.builtAtOnce && preview.none.loadedWith === null, 'nothing chosen: the preview is built at once, no picture read');

    // ---- 7. saved pictures (no showDirectoryPicker: the Firefox path) ----
    const select = await page.evaluate(() => {
      const f = (n) => ({ name: n });
      const files = ['syn-1.png', 'syn-2.png', 'Alpha Library - Front.png', 'Beta Library - front.JPG', 'Gamma Library - Front.png', 'other.png'].map(f);
      const kept = pictureFolderSelectToSave(files, ['syn-1.png', 'missing.png'], ['Alpha Library', 'Beta Library', 'Delta Library'], _a36DetLibraryPhotoFile);
      const none = pictureFolderSelectToSave(files, [], [], _a36DetLibraryPhotoFile);
      return { kept: kept.map((x) => x.name), keptDistinct: new Set(kept).size === kept.length, none: none.length };
    });
    ok(
      JSON.stringify(select.kept) === JSON.stringify(['syn-1.png', 'Alpha Library - Front.png', 'Beta Library - front.JPG']) && select.keptDistinct && select.none === 0,
      'select: needed files + the front photo of each listed library only; not the other files, not a photo of an unlisted library (' + select.kept.join(',') + ')',
    );
    const saved = await page.evaluate(async (pid) => {
      delete window.showDirectoryPicker;
      window.__fakeStore = {};
      window.__fakeSaved = {};
      window.__resetModule();
      await window.__openDetailed();
      const mkInput = (names) => {
        const dt = new DataTransfer();
        names.forEach((n) => dt.items.add(new File(['x'], n, { type: 'image/png' })));
        const input = document.getElementById('a36PictureDir');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      };
      const run = async () => {
        const original = _a36DetLoadPictures;
        window.__loadedWith = null;
        _a36DetLoadPictures = function (files, needed) {
          window.__loadedWith = Array.prototype.map.call(files, (x) => x.name).sort();
          return original(files, needed);
        };
        generateASHRAE36Preview();
        for (let i = 0; i < 100 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        _a36DetLoadPictures = original;
        document.getElementById('reportOverlay') && document.getElementById('reportOverlay').classList.remove('open');
        document.querySelectorAll('#reportPages .rpt-page').forEach((p) => p.remove());
        return window.__loadedWith;
      };
      const out = {};
      // pick once: the input holds the folder files; the report saves the needed ones
      mkInput(['syn-1.png', 'syn-2.png', 'syn-3.png', 'other.png', 'Alpha Library - Front.png', 'junk.png']);
      out.firstLoaded = await run();
      out.storedNames = ((window.__fakeSaved[String(pid)] || {}).files || []).map((x) => x.name).sort();
      // a later export: new modal, no folder chosen, module state gone (a reload)
      window.__pickerCalls = 0;
      window.__resetModule();
      const shown = await window.__openDetailed();
      out.shown = shown;
      out.hasChoice = pictureFolderHasChoice(pid, document.getElementById('a36PictureDir'));
      out.secondLoaded = await run();
      out.pickerCalls = window.__pickerCalls;
      // a folder chosen again: its files replace the saved files of the same name; the other saved files stay
      await window.__openDetailed();
      mkInput(['syn-2.png', 'syn-3.png']);
      const newSyn2 = Array.prototype.find.call(document.getElementById('a36PictureDir').files, (x) => x.name === 'syn-2.png');
      await run();
      const savedNow = (window.__fakeSaved[String(pid)] || {}).files || [];
      out.replacedNames = savedNow.map((x) => x.name).sort();
      out.syn2Replaced = savedNow.find((x) => x.name === 'syn-2.png') === newSyn2;
      // a folder without any needed picture keeps the saved set
      await window.__openDetailed();
      mkInput(['unrelated.png']);
      await run();
      out.keptNames = ((window.__fakeSaved[String(pid)] || {}).files || []).map((x) => x.name).sort();
      return out;
    }, PID);
    ok(saved.storedNames.length > 0 && saved.storedNames.every((n) => /^(syn-\d\.png|Alpha Library - Front\.png)$/.test(n)) && saved.storedNames.indexOf('other.png') < 0 && saved.storedNames.indexOf('junk.png') < 0, 'saved: only needed pictures and the front photo are stored, not the whole folder (' + saved.storedNames.join(',') + ')');
    ok(saved.firstLoaded && saved.firstLoaded.length === 6, 'saved: the first report read the folder files (' + (saved.firstLoaded || []).length + ')');
    ok(
      /The report uses the \d+ saved pictures\. "Change folder" picks again\.$/.test(saved.shown.status) && saved.shown.btn === 'Change folder' && saved.hasChoice,
      'saved: with no folder chosen the panel says "' + saved.shown.status + '", button "' + saved.shown.btn + '"',
    );
    ok(saved.secondLoaded && saved.secondLoaded.join(',') === saved.storedNames.join(',') && saved.pickerCalls === 0, 'saved: the next report reads the saved files, no picker (' + (saved.secondLoaded || []).join(',') + ')');
    ok(saved.replacedNames.join(',') === saved.storedNames.join(',') && saved.syn2Replaced, 'saved: a folder chosen again replaces saved files of the same name and keeps the others (' + saved.replacedNames.join(',') + ')');
    ok(saved.keptNames.join(',') === saved.storedNames.join(','), 'saved: a folder with none of the needed pictures keeps the saved set (' + saved.keptNames.join(',') + ')');

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
