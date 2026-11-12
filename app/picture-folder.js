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
 * Saved pictures (any browser; the only memory in Firefox and Safari): a file input forgets its folder, so the report keeps the
 * picture files it needs in this browser's IndexedDB: database "ch-picture-folder", store "pictures", key = project id,
 * value { files: File[], savedAt }. Only the needed files are kept (the files named in the project picture list that the report
 * places, and the "<Library> - Front" photos), never the whole folder. The report saves them after it read a folder
 * (pictureFolderRemember); files read again replace the saved files of the same name. With no folder chosen and no granted handle,
 * pictureFolderFiles returns the saved set, so the report builds with no prompt. NEVER in the kv database, Supabase,
 * localStorage sync keys or the repo.
 *
 * Callers (report-engine.js): _a36PictureOpen, _a36PictureAllow, _a36PictureRestore,
 * _a36PictureStatus, generateASHRAE36Preview. The result is File[] (all files below the folder,
 * subfolders included, as webkitdirectory gives; or the saved set) for _a36DetLoadPictures.
 */

var PICTURE_FOLDER_DB = 'ch-picture-folder';
var PICTURE_FOLDER_STORE = 'handles';
var PICTURE_FOLDER_SAVED_STORE = 'pictures'; // saved picture files of a project, key = project id
var PICTURE_FOLDER_PICKER_ID = 'ch-site-pictures';
var PICTURE_FOLDER_LAST_KEY = '__last-chosen'; // the folder chosen most recently, for a project that has none of its own

// In-memory state per project id: { handle, name, permission, files, saved } (saved: File[] of the saved set, null until read).
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
    var request = window.indexedDB.open(PICTURE_FOLDER_DB, 2);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(PICTURE_FOLDER_STORE)) db.createObjectStore(PICTURE_FOLDER_STORE);
      if (!db.objectStoreNames.contains(PICTURE_FOLDER_SAVED_STORE)) db.createObjectStore(PICTURE_FOLDER_SAVED_STORE);
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

function _pictureFolderStoreRun(mode, action, storeName) {
  var name = storeName || PICTURE_FOLDER_STORE;
  return _pictureFolderOpenDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(name, mode);
      var request = action(transaction.objectStore(name));
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

function _pictureFolderSavedGet(projectKey) {
  return _pictureFolderStoreRun(
    'readonly',
    function (store) {
      return store.get(String(projectKey));
    },
    PICTURE_FOLDER_SAVED_STORE,
  );
}

function _pictureFolderSavedPut(projectKey, record) {
  return _pictureFolderStoreRun(
    'readwrite',
    function (store) {
      return store.put(record, String(projectKey));
    },
    PICTURE_FOLDER_SAVED_STORE,
  );
}

function _pictureFolderStateFor(projectKey) {
  var key = String(projectKey);
  if (!_pictureFolderState[key]) _pictureFolderState[key] = { handle: null, name: '', permission: 'none', files: null, saved: null };
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
  if (state.saved === null) {
    var record = await _pictureFolderSavedGet(projectKey);
    state.saved = record && Array.isArray(record.files) ? record.files : [];
  }
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
  return { name: state.name, permission: state.permission, files: state.files || [], saved: state.saved || [] };
}

/**
 * pictureFolderHasChoice - true when the report can read pictures: the file input holds files
 * (they win), a stored handle has permission granted, or the project has a saved picture set.
 */
function pictureFolderHasChoice(projectKey, inputEl) {
  if (inputEl && inputEl.files && inputEl.files.length) return true;
  var state = _pictureFolderStateFor(projectKey);
  if (state.handle && state.permission === 'granted') return true;
  return !!(state.saved && state.saved.length);
}

/**
 * pictureFolderFiles - the File[] the report reads pictures from. Files set on the input WIN over
 * the stored handle; a granted handle wins over the saved set. Resolves the saved set (the same array as state.saved) when no
 * folder can be read, [] when nothing is chosen or saved.
 */
async function pictureFolderFiles(projectKey, inputEl) {
  if (inputEl && inputEl.files && inputEl.files.length) return Array.prototype.slice.call(inputEl.files);
  var state = await pictureFolderRestore(projectKey);
  if (state.permission !== 'granted') return state.saved || [];
  return _pictureFolderLoadFiles(state); // read again: the folder may hold new pictures since it was chosen
}

/**
 * pictureFolderSelectToSave - the files worth saving from a folder read: every file whose name is in neededNames, plus the
 * library front photo of each library name (photoFileFn(files, libraryName, libraryNames) returns the File or null; the report
 * passes _a36DetLibraryPhotoFile, the owner of the photo name rule). Each file once, in folder order.
 */
function pictureFolderSelectToSave(files, neededNames, libraryNames, photoFileFn) {
  var want = {};
  (neededNames || []).forEach(function (n) {
    want[n] = true;
  });
  var keep = [];
  function add(f) {
    if (f && keep.indexOf(f) < 0) keep.push(f);
  }
  Array.prototype.forEach.call(files || [], function (f) {
    if (want[f.name]) add(f);
  });
  if (photoFileFn) {
    (libraryNames || []).forEach(function (name) {
      add(photoFileFn(files, name, libraryNames));
    });
  }
  return keep;
}

/**
 * pictureFolderRemember - saves keepFiles as the project's saved set, when files came from a folder the user chose (the input or
 * a handle). When files ARE the saved set already, or keepFiles is empty (the folder holds none of the needed pictures), the
 * saved set stays as it is. The new files merge into the saved set by file name (a file read again replaces the old copy). Resolves the number of files saved.
 */
async function pictureFolderRemember(projectKey, files, keepFiles) {
  var state = _pictureFolderStateFor(projectKey);
  if (files === state.saved || !keepFiles || !keepFiles.length) return 0;
  // Merge by file name: a file read now replaces the saved file of the same name; saved files this report did not need stay
  // (a report on one library must not drop the pictures of the others).
  var byName = {};
  var merged = [];
  (state.saved || []).concat(keepFiles).forEach(function (f) {
    if (byName[f.name] === undefined) {
      byName[f.name] = merged.length;
      merged.push(f);
    } else {
      merged[byName[f.name]] = f;
    }
  });
  await _pictureFolderSavedPut(projectKey, { files: merged, savedAt: Date.now() });
  state.saved = merged;
  return keepFiles.length;
}

window.pictureFolderPickerSupported = pictureFolderPickerSupported;
window.pictureFolderRestore = pictureFolderRestore;
window.pictureFolderPick = pictureFolderPick;
window.pictureFolderRequestAccess = pictureFolderRequestAccess;
window.pictureFolderCurrent = pictureFolderCurrent;
window.pictureFolderHasChoice = pictureFolderHasChoice;
window.pictureFolderFiles = pictureFolderFiles;
window.pictureFolderSelectToSave = pictureFolderSelectToSave;
window.pictureFolderRemember = pictureFolderRemember;
