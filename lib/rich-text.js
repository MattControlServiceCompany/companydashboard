/* rich-text.js — Quill rich text editor helpers for CompanyHub
   Phase 1: notes fields (ed-notes, mp-notes, eq-notes)
   sp-notes stays as plain textarea (feeds AI prompt builder) */

function initQuillEditor(containerId, savedHtml, options) {
  var container = document.getElementById(containerId);
  if (!container) return null;
  var toolbarOptions = (options && options.toolbar) || [
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['clean'],
  ];
  var quill = new Quill('#' + containerId, {
    theme: 'snow',
    modules: { toolbar: toolbarOptions },
    placeholder: (options && options.placeholder) || 'Enter notes...',
  });
  if (savedHtml) {
    quill.clipboard.dangerouslyPasteHTML(savedHtml);
  }
  return quill;
}

function getQuillHTML(quill) {
  if (!quill) return '';
  var html = quill.getSemanticHTML();
  if (html === '<p><br></p>' || html === '<p></p>') return '';
  return html;
}
