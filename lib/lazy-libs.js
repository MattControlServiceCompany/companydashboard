// lib/lazy-libs.js -- the ONE loader for the big third-party code libraries (Matt 2026-11-19 d184cc83).
// The page no longer waits for them at start. A feature calls `await chLoadLib('name')` in its entry
// function (button handler / export function) before it uses the library global.
//   chLoadLib(name)    -> Promise, resolves with the global when it is ready. A second call returns the same
//                         Promise. A failed load rejects and the next call tries again.
//   chLoadLibs([names]) -> Promise.all of chLoadLib.
// Chart.js and Quill stay as <script> tags in the page (charts draw at load; Quill opens synchronously).
// The SRI hashes below are the same hashes the page tags had.
(function () {
  var LIBS = {
    pdfjs: {
      url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
      global: 'pdfjsLib',
      // Worker setup: run pdf.js in the page (no worker file). One place, for every caller.
      after: function (g) {
        g.GlobalWorkerOptions.workerSrc = '';
      },
    },
    tesseract: {
      url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
      integrity: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F',
      global: 'Tesseract',
    },
    jspdf: {
      url: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
      integrity: 'sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/',
      global: 'jspdf',
    },
    pdflib: {
      url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
      integrity: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
      global: 'PDFLib',
    },
    html2canvas: {
      url: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
      integrity: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
      global: 'html2canvas',
    },
    xlsx: {
      url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
      integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw',
      global: 'XLSX',
    },
    exceljs: {
      url: 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
      integrity: 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',
      global: 'ExcelJS',
    },
    jszip: {
      url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
      integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
      global: 'JSZip',
    },
  };
  var pending = {};

  function chLoadLib(name) {
    var lib = LIBS[name];
    if (!lib) return Promise.reject(new Error('chLoadLib: unknown library "' + name + '"'));
    if (pending[name]) return pending[name];
    pending[name] = new Promise(function (resolve, reject) {
      if (window[lib.global]) {
        if (lib.after) lib.after(window[lib.global]);
        resolve(window[lib.global]);
        return;
      }
      var s = document.createElement('script');
      s.src = lib.url;
      s.integrity = lib.integrity;
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        if (!window[lib.global]) {
          s.remove();
          reject(new Error('chLoadLib: "' + name + '" loaded but global ' + lib.global + ' is missing'));
          return;
        }
        if (lib.after) lib.after(window[lib.global]);
        resolve(window[lib.global]);
      };
      s.onerror = function () {
        s.remove();
        reject(new Error('chLoadLib: could not load "' + name + '" (' + lib.url + ')'));
      };
      document.head.appendChild(s);
    }).catch(function (err) {
      delete pending[name]; // let the next call try again
      throw err;
    });
    return pending[name];
  }

  function chLoadLibs(names) {
    return Promise.all(names.map(chLoadLib));
  }

  window.chLoadLib = chLoadLib;
  window.chLoadLibs = chLoadLibs;
})();
