/**
 * picture-folder.js - the ONE owner of the site-pictures folder choice for the Detailed
 * ASHRAE 36 Audit Report (picture panel in the audit modal, openASHRAE36ReportModal in
 * report-engine.js).
 *
 * Why: a plain <input webkitdirectory> forgets its folder each time the modal is built, and on
 * every reload. With window.showDirectoryPicker the page can keep the folder handle and ask the
 * user only once.
 *
 * Where it is stored: the FileSystemDirectoryHandle goes in this browser's own IndexedDB
 * (database "ch-picture-folder", store "handles", key = project id, plus '__last-chosen' = the folder
 * chosen most recently, used by a project that has no folder of its own). NEVER in the kv database,
 * Supabase, localStorage sync keys or the repo. It stays on this PC, in this browser profile.
 *
 * Permission flow: after a reload the browser asks for permission again. A stored handle with
 * permission 'granted' is used with no prompt. With 'prompt' the panel shows ONE button
 * "Allow access to <folder>" that calls requestPermission in the click (user activation).
 * A new folder picker opens only when the user clicks "Choose picture folder" / "Change folder".
 *
 * Fallback: when window.showDirectoryPicker is missing (Firefox, Safari) the existing hidden
 * <input id="a36PictureDir" webkitdirectory> is used. Files set on that input WIN over the stored
 * handle (pictureFolderFiles).
 *
 * Callers (report-engine.js): _a36PictureOpen, _a36PictureAllow, _a36PictureRestore,
 * _a36PictureStatus, generateASHRAE36Preview. The result is File[] (all files below the folder,
 * subfolders included, as webkitdirectory gives) for _a36DetLoadPictures.
 */

var PICTURE_FOLDER_DB = 'ch-picture-folder';
var PICTURE_FOLDER_STORE = 'handles';
var PICTURE_FOLDER_PICKER_ID = 'ch-site-pictures';
var PICTURE_FOLDER_LAST_KEY = '__last-chosen'; // the folder chosen most recently, for a project that has none of its own

// In-memory state per project id: { handle, name, permission, files }.
var _pictureFolderState = {};

function pictureFolderPickerSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

function _pictureFolderOpenDb() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    var request = window.indexedDB.open(PICTURE_FOLDER_DB, 1);
    request.onupgradeneeded = function () {
      request.result.createObjectStore(PICTURE_FOLDER_STORE);
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

function _pictureFolderStoreRun(mode, action) {
  return _pictureFolderOpenDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(PICTURE_FOLDER_STORE, mode);
      var request = action(transaction.objectStore(PICTURE_FOLDER_STORE));
      transaction.oncomplete = function () {
        db.close();
        resolve(request.result);
      };
      transaction.onerror = function () {
        db.close();
        reject(transaction.error);
      };
    });
  });
}

function _pictureFolderStoredGet(projectKey) {
  return _pictureFolderStoreRun('readonly', function (store) {
    return store.get(String(projectKey));
  });
}

function _pictureFolderStoredPut(projectKey, handle) {
  return _pictureFolderStoreRun('readwrite', function (store) {
    return store.put(handle, String(projectKey));
  });
}

function _pictureFolderStateFor(projectKey) {
  var key = String(projectKey);
  if (!_pictureFolderState[key]) _pictureFolderState[key] = { handle: null, name: '', permission: 'none', files: null };
  return _pictureFolderState[key];
}

// All files below a directory handle, subfolders included (the same list webkitdirectory gives).
async function _pictureFolderCollectFiles(directoryHandle) {
  var files = [];
  for await (var entry of directoryHandle.values()) {
    if (entry.kind === 'file') {
      files.push(await entry.getFile());
    } else if (entry.kind === 'directory') {
      var inner = await _pictureFolderCollectFiles(entry);
      for (var i = 0; i < inner.length; i++) files.push(inner[i]);
    }
  }
  return files;
}

// Reads the files of a granted handle into the state (so the panel status can count them without waiting).
async function _pictureFolderLoadFiles(state) {
  state.files = await _pictureFolderCollectFiles(state.handle);
  return state.files;
}

/**
 * pictureFolderRestore - loads the stored handle of a project, asks the browser for its read
 * permission (no prompt is shown) and, when granted, reads the file list.
 * Resolves the state { handle, name, permission: 'none'|'granted'|'prompt'|'denied', files }.
 */
async function pictureFolderRestore(projectKey) {
  var state = _pictureFolderStateFor(projectKey);
  if (!pictureFolderPickerSupported()) return state;
  if (!state.handle) {
    // A project with no folder of its own uses the last folder chosen for any project (one pictures folder serves all
    // projects; Matt, 2026-11-11: "I shouldn't have to select the pictures folder more than 1 time").
    var stored = (await _pictureFolderStoredGet(projectKey)) || (await _pictureFolderStoredGet(PICTURE_FOLDER_LAST_KEY));
    if (!stored) return state;
    state.handle = stored;
    state.name = stored.name || '';
  }
  state.permission = await state.handle.queryPermission({ mode: 'read' });
  if (state.permission === 'granted' && !state.files) await _pictureFolderLoadFiles(state);
  return state;
}

/**
 * pictureFolderPick - opens the folder picker. Call it directly in the click handler: showDirectoryPicker
 * needs the user activation of that click, so nothing may be awaited before it.
 * Resolves the new state, or null when the user cancels the picker.
 */
function pictureFolderPick(projectKey) {
  var picked = window.showDirectoryPicker({ id: PICTURE_FOLDER_PICKER_ID, mode: 'read', startIn: 'pictures' });
  return picked.then(
    async function (handle) {
      var state = _pictureFolderStateFor(projectKey);
      state.handle = handle;
      state.name = handle.name || '';
      state.permission = 'granted';
      state.files = null;
      await _pictureFolderStoredPut(projectKey, handle);
      await _pictureFolderStoredPut(PICTURE_FOLDER_LAST_KEY, handle);
      await _pictureFolderLoadFiles(state);
      return state;
    },
    function (err) {
      if (err && err.name === 'AbortError') return null; // the user closed the picker: not an error
      throw err;
    }
  );
}

/**
 * pictureFolderRequestAccess - asks the browser for read permission on the stored handle. Call it
 * directly in a click handler (user activation). Resolves the state.
 */
function pictureFolderRequestAccess(projectKey) {
  var state = _pictureFolderStateFor(projectKey);
  return state.handle.requestPermission({ mode: 'read' }).then(async function (permission) {
    state.permission = permission;
    if (permission === 'granted') await _pictureFolderLoadFiles(state);
    return state;
  });
}

// The remembered folder of a project as the panel needs it, without any waiting: { name, permission, files }.
function pictureFolderCurrent(projectKey) {
  var state = _pictureFolderStateFor(projectKey);
  return { name: state.name, permission: state.permission, files: state.files || [] };
}

/**
 * pictureFolderHasChoice - true when the report can read pictures: the file input holds files
 * (they win), or a stored handle has permission granted.
 */
function pictureFolderHasChoice(projectKey, inputEl) {
  if (inputEl && inputEl.files && inputEl.files.length) return true;
  var state = _pictureFolderStateFor(projectKey);
  return !!state.handle && state.permission === 'granted';
}

/**
 * pictureFolderFiles - the File[] the report reads pictures from. Files set on the input WIN over
 * the stored handle. Resolves [] when nothing is chosen or the permission is not granted.
 */
async function pictureFolderFiles(projectKey, inputEl) {
  if (inputEl && inputEl.files && inputEl.files.length) return Array.prototype.slice.call(inputEl.files);
  var state = await pictureFolderRestore(projectKey);
  if (state.permission !== 'granted') return [];
  return _pictureFolderLoadFiles(state); // read again: the folder may hold new pictures since it was chosen
}

window.pictureFolderPickerSupported = pictureFolderPickerSupported;
window.pictureFolderRestore = pictureFolderRestore;
window.pictureFolderPick = pictureFolderPick;
window.pictureFolderRequestAccess = pictureFolderRequestAccess;
window.pictureFolderCurrent = pictureFolderCurrent;
window.pictureFolderHasChoice = pictureFolderHasChoice;
window.pictureFolderFiles = pictureFolderFiles;
