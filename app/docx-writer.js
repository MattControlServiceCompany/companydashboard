/* ── docx-writer.js -- Word export rebuild, Step 3: docx-writer core ─────────────
   Word Export Rebuild Plan: AI/_context/plans/word-export-rebuild-2026-07-30.md
   Style authority: AI/_context/specs/csc-document-style-spec-2026-07-29.md

   This file is PRIMITIVE BUILDERS + ASSEMBLY ONLY. It does not know about
   report content, pricing, or any client data. The DOM->OOXML translator that
   walks .rpt-page markup and calls these builders is Step 5, not this file.

   Units, enforced by convention (never accept px at this layer):
     - Measurements (widths, margins, indents, spacing): TWIPS (1/20 pt, i.e.
       1440 twips = 1 inch).
     - Font sizes: HALF-POINTS (w:sz/w:szCs), e.g. 10.5pt = 21, 18pt = 36.

   Spacing policy (plan Part E) is NOT auto-applied here -- callers pass
   spacingAfter/spacingBefore explicitly per paragraph type:
     - Body paragraphs:      w:after=240 (12pt)              -- _docxParagraph default
     - Headings/titles:      w:before=240, w:after=120 (12pt/6pt)
     - List items:           w:after=40 (~2pt)                -- _docxListItem default
     - Table cell paragraphs: w:after=0                       -- _docxTableCell default

   Every builder that accepts text XML-escapes it (_docxEscapeXml). Report
   content contains ampersands, angle brackets, and quotes -- an unescaped
   run produces a corrupt .docx Word refuses to open without a repair prompt.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── XML escaping ─────────────────────────────────────────────────────────── */

/** Escape a string for safe use as XML text content or attribute value.
 * Order matters: & must be escaped first, or the entities inserted for the
 * other characters would themselves get re-escaped. */
function _docxEscapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ── Run builder ──────────────────────────────────────────────────────────── */

/**
 * Build a <w:r> run.
 * opts:
 *   text        string  -- required; XML-escaped; '\n' becomes <w:br/>
 *   bold        bool
 *   italic      bool
 *   underline   bool
 *   font        string  -- default 'Arial'
 *   sizeHalfPt  number  -- default 21 (10.5pt), spec §4b dominant body size
 *   color       string  -- hex, no '#', e.g. '000000'; default: no override (inherits black)
 */
function _docxRun(opts) {
  opts = opts || {};
  var font = opts.font || 'Arial';
  var sizeHalfPt = opts.sizeHalfPt != null ? opts.sizeHalfPt : 21;

  var rPr = '<w:rPr>';
  rPr +=
    '<w:rFonts w:ascii="' +
    _docxEscapeXml(font) +
    '" w:hAnsi="' +
    _docxEscapeXml(font) +
    '" w:cs="' +
    _docxEscapeXml(font) +
    '"/>';
  if (opts.bold) rPr += '<w:b/>';
  if (opts.italic) rPr += '<w:i/>';
  if (opts.underline) rPr += '<w:u w:val="single"/>';
  if (opts.color) rPr += '<w:color w:val="' + _docxEscapeXml(opts.color) + '"/>';
  rPr += '<w:sz w:val="' + sizeHalfPt + '"/><w:szCs w:val="' + sizeHalfPt + '"/>';
  rPr += '</w:rPr>';

  var text = opts.text != null ? String(opts.text) : '';
  var lines = text.split('\n');
  var body = lines
    .map(function (line, i) {
      var t = '<w:t xml:space="preserve">' + _docxEscapeXml(line) + '</w:t>';
      return (i > 0 ? '<w:br/>' : '') + t;
    })
    .join('');

  return '<w:r>' + rPr + body + '</w:r>';
}

/* ── Paragraph builder ────────────────────────────────────────────────────── */

/**
 * Build a <w:p> paragraph.
 * opts:
 *   runs          array of pre-built run XML strings (from _docxRun), OR
 *   text/bold/italic/font/sizeHalfPt/color  -- shorthand for a single run
 *   align         'left'|'center'|'right'|'both'
 *   spacingBefore twips -- omitted unless given
 *   spacingAfter  twips -- default 240 (12pt, body-paragraph policy)
 *   pStyle        string -- e.g. 'ListParagraph'
 *   numId         number -- list numbering id (skeleton numbering.xml); pairs with ilvl
 *   ilvl          number -- default 0
 *   indLeft/indRight/indHanging/indFirstLine  twips
 *   keepNext      bool
 */
function _docxParagraph(opts) {
  opts = opts || {};

  var pPr = '<w:pPr>';
  if (opts.pStyle) pPr += '<w:pStyle w:val="' + _docxEscapeXml(opts.pStyle) + '"/>';
  if (opts.numId != null) {
    pPr += '<w:numPr><w:ilvl w:val="' + (opts.ilvl || 0) + '"/><w:numId w:val="' + opts.numId + '"/></w:numPr>';
  }
  if (opts.keepNext) pPr += '<w:keepNext/>';

  var spacingAfter = opts.spacingAfter != null ? opts.spacingAfter : 240;
  var spacingAttrs = '';
  if (opts.spacingBefore != null) spacingAttrs += ' w:before="' + opts.spacingBefore + '"';
  spacingAttrs += ' w:after="' + spacingAfter + '"';
  pPr += '<w:spacing' + spacingAttrs + '/>';

  if (opts.indLeft != null || opts.indRight != null || opts.indHanging != null || opts.indFirstLine != null) {
    pPr += '<w:ind';
    if (opts.indLeft != null) pPr += ' w:left="' + opts.indLeft + '"';
    if (opts.indRight != null) pPr += ' w:right="' + opts.indRight + '"';
    if (opts.indHanging != null) pPr += ' w:hanging="' + opts.indHanging + '"';
    if (opts.indFirstLine != null) pPr += ' w:firstLine="' + opts.indFirstLine + '"';
    pPr += '/>';
  }

  if (opts.align) pPr += '<w:jc w:val="' + _docxEscapeXml(opts.align) + '"/>';
  pPr += '</w:pPr>';

  var runsXml;
  if (Array.isArray(opts.runs)) {
    runsXml = opts.runs.join('');
  } else if (opts.text != null) {
    runsXml = _docxRun({
      text: opts.text,
      bold: opts.bold,
      italic: opts.italic,
      underline: opts.underline,
      font: opts.font,
      sizeHalfPt: opts.sizeHalfPt,
      color: opts.color,
    });
  } else {
    runsXml = '';
  }

  return '<w:p>' + pPr + runsXml + '</w:p>';
}

/**
 * Heading/title paragraph shorthand -- spec §4d (Arial, NOT bold by default)
 * and Part E heading spacing (before=240, after=120).
 * opts: text, sizeHalfPt (default 36 = 18pt), align, bold (default false), font
 */
function _docxHeading(text, opts) {
  opts = opts || {};
  return _docxParagraph({
    text: text,
    sizeHalfPt: opts.sizeHalfPt != null ? opts.sizeHalfPt : 36,
    bold: !!opts.bold,
    align: opts.align,
    font: opts.font,
    spacingBefore: 240,
    spacingAfter: 120,
  });
}

/**
 * List item paragraph -- Part E list-item spacing (w:after=40), 'ListParagraph'
 * style, numPr referencing the skeleton's numbering.xml.
 * numId: 6 = bullet (abstractNum 2, Symbol glyph, ind left=720/hanging=360, spec §6)
 *        4 = decimal (abstractNum 5, ind left=720/hanging=360)
 * opts: ilvl, sizeHalfPt, spacingAfter (default 40)
 */
function _docxListItem(text, numId, opts) {
  opts = opts || {};
  return _docxParagraph({
    text: text,
    pStyle: 'ListParagraph',
    numId: numId,
    ilvl: opts.ilvl || 0,
    sizeHalfPt: opts.sizeHalfPt,
    spacingAfter: opts.spacingAfter != null ? opts.spacingAfter : 40,
  });
}

/* ── Table builders ───────────────────────────────────────────────────────── */

/**
 * Build a <w:tc> table cell. Part E policy: table cell paragraphs get
 * w:after=0 (spec §5e cell margins govern spacing, not paragraph spacing).
 * opts:
 *   widthTwips  number -- required (cell width, dxa)
 *   paragraphs  array of pre-built paragraph XML strings, OR
 *   text/bold/align/sizeHalfPt  -- shorthand for a single paragraph
 *   vAlign      'top'|'center'|'bottom' -- default 'center' (spec §5c)
 *   gridSpan    number -- merge N grid columns
 */
function _docxTableCell(opts) {
  opts = opts || {};
  var tcPr = '<w:tcPr>';
  tcPr += '<w:tcW w:w="' + opts.widthTwips + '" w:type="dxa"/>';
  if (opts.gridSpan) tcPr += '<w:gridSpan w:val="' + opts.gridSpan + '"/>';
  tcPr += '<w:vAlign w:val="' + (opts.vAlign || 'center') + '"/>';
  tcPr += '</w:tcPr>';

  var content;
  if (Array.isArray(opts.paragraphs)) {
    content = opts.paragraphs.join('');
  } else {
    content = _docxParagraph({
      text: opts.text,
      bold: opts.bold,
      align: opts.align || 'center',
      sizeHalfPt: opts.sizeHalfPt,
      spacingAfter: 0,
    });
  }
  return '<w:tc>' + tcPr + content + '</w:tc>';
}

/** Build a <w:tr> table row from an array of pre-built cell XML strings.
 * opts.header -- sets w:tblHeader (repeat this row on every page, spec §5c
 * note: must be added explicitly, it is never automatic). */
function _docxTableRow(cellsXml, opts) {
  opts = opts || {};
  var trPr = '';
  if (opts.header) trPr = '<w:trPr><w:tblHeader/></w:trPr>';
  return '<w:tr>' + trPr + cellsXml.join('') + '</w:tr>';
}

/**
 * Build a full <w:tbl>, styled TableGrid (spec §5b -- uniform 0.5pt borders,
 * no per-cell tcBorders needed since TableGrid supplies them).
 * opts:
 *   colWidthsTwips  array<number>  -- required, one per column
 *   rows            array<array<string|cellOpts>>  -- each row is an array of
 *                   cells; a cell may be a plain string (shorthand text) or a
 *                   _docxTableCell-style opts object
 *   headerRow       bool -- if true, row 0 is bold+centered+w:tblHeader
 *   tblStyle        string -- default 'TableGrid'
 */
function _docxTable(opts) {
  opts = opts || {};
  var colWidths = opts.colWidthsTwips || [];
  var grid =
    '<w:tblGrid>' +
    colWidths
      .map(function (w) {
        return '<w:gridCol w:w="' + w + '"/>';
      })
      .join('') +
    '</w:tblGrid>';

  var tblPr =
    '<w:tblPr><w:tblStyle w:val="' +
    _docxEscapeXml(opts.tblStyle || 'TableGrid') +
    '"/>' +
    '<w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    '</w:tblPr>';

  var rowsXml = (opts.rows || [])
    .map(function (row, rIdx) {
      var isHeader = rIdx === 0 && opts.headerRow;
      var cellsXml = row.map(function (cell, cIdx) {
        var cellOpts = typeof cell === 'string' ? { text: cell } : Object.assign({}, cell);
        if (cellOpts.widthTwips == null) cellOpts.widthTwips = colWidths[cIdx];
        if (isHeader) {
          if (cellOpts.bold == null) cellOpts.bold = true;
          if (cellOpts.align == null) cellOpts.align = 'center';
        }
        return _docxTableCell(cellOpts);
      });
      return _docxTableRow(cellsXml, { header: isHeader });
    })
    .join('');

  return '<w:tbl>' + tblPr + grid + rowsXml + '</w:tbl>';
}

/* ── Image builder ────────────────────────────────────────────────────────── */

/**
 * Build an inline <w:drawing> wrapped in a <w:r>, referencing an already-
 * registered image relationship id (see _docxEmbedImage). widthTwips/
 * heightTwips are converted to EMU (1 twip = 635 EMU).
 * opts: docPrId (default 1), altText
 */
function _docxImageRun(rId, widthTwips, heightTwips, opts) {
  opts = opts || {};
  var cx = Math.round(widthTwips * 635);
  var cy = Math.round(heightTwips * 635);
  var docPrId = opts.docPrId != null ? opts.docPrId : 1;
  var name = _docxEscapeXml(opts.altText || 'Picture ' + docPrId);

  var drawing =
    '<w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' +
    cx +
    '" cy="' +
    cy +
    '"/>' +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' +
    docPrId +
    '" name="' +
    name +
    '"/>' +
    '<wp:cNvGraphicFramePr>' +
    '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
    '</wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr><pic:cNvPr id="' +
    docPrId +
    '" name="' +
    name +
    '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' +
    _docxEscapeXml(rId) +
    '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr>' +
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' +
    cx +
    '" cy="' +
    cy +
    '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing>';

  return '<w:r><w:rPr/>' + drawing + '</w:r>';
}

/**
 * Deterministic relationship id for a given mediaIndex, so callers can build
 * an _docxImageRun() reference BEFORE the image is actually embedded in the
 * zip (embedding happens inside _docxAssemble via opts.images).
 * mediaIndex should be unique per image and >= 100 to avoid colliding with
 * the skeleton's own image2.jpg/image3.jpg (letterhead) relationship ids.
 */
function _docxImageRelId(mediaIndex) {
  return 'rIdImg' + mediaIndex;
}

/**
 * Register an image binary as a new relationship + media part on an
 * already-loaded JSZip package. Returns the new relationship Id (string) to
 * pass into _docxImageRun. Must be called (and awaited) BEFORE
 * zip.generateAsync(). mediaIndex should be unique per image and >= 100 to
 * avoid colliding with the skeleton's own image2.jpg/image3.jpg (letterhead).
 * extension: 'jpg'|'png'|'gif' (no leading dot).
 */
async function _docxEmbedImage(zip, imageBytes, extension, mediaIndex) {
  var rId = _docxImageRelId(mediaIndex);
  var partName = 'image' + mediaIndex + '.' + extension;
  zip.file('word/media/' + partName, imageBytes);

  var relsPath = 'word/_rels/document.xml.rels';
  var relsXml = await zip.file(relsPath).async('string');
  var relEntry =
    '<Relationship Id="' +
    rId +
    '" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
    'Target="media/' +
    partName +
    '"/>';
  relsXml = relsXml.replace('</Relationships>', relEntry + '</Relationships>');
  zip.file(relsPath, relsXml);

  var ctPath = '[Content_Types].xml';
  var ctXml = await zip.file(ctPath).async('string');
  if (ctXml.indexOf('Extension="' + extension + '"') === -1) {
    var mime = extension === 'jpg' ? 'image/jpeg' : 'image/' + extension;
    var defaultEntry = '<Default Extension="' + extension + '" ContentType="' + mime + '"/>';
    ctXml = ctXml.replace(/(<Types[^>]*>)/, '$1' + defaultEntry);
    zip.file(ctPath, ctXml);
  }

  return rId;
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

/** Decode a base64 string (e.g. CSC_DOCX_SKELETON_B64) into a Uint8Array. */
function _docxBase64ToUint8Array(b64) {
  var binaryStr = atob(b64);
  var len = binaryStr.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

/**
 * Splice generated body XML into the CSC skeleton (app/docx-skeleton.js) via
 * JSZip, and produce a downloadable .docx Blob.
 *
 * documentXml MUST be the BODY CONTENT ONLY -- a sequence of <w:p>/<w:tbl>
 * elements -- with NO <w:sectPr> and no <w:document>/<w:body> wrapper. This
 * function locates the skeleton's own <w:sectPr>...</w:sectPr> (the block
 * carrying the real page margins and header/footer references, spec §1) and
 * everything before/after it VERBATIM from the skeleton's actual
 * word/document.xml, splicing documentXml in between <w:body> and that
 * sectPr. This guarantees the chrome (margins, headerReference,
 * footerReference) can never be silently dropped by a caller replacing the
 * body wholesale -- there is no code path that constructs a document.xml
 * without going through the skeleton's own preserved tail.
 *
 * opts:
 *   filename  string -- default 'document.docx'
 *   download  bool   -- default true; trigger a browser download
 *   images    array of {bytes: Uint8Array, extension: string, mediaIndex: number}
 *             -- pre-registered via _docxEmbedImage before this call if the
 *             documentXml already references their rIds via _docxImageRun
 *
 * Returns the generated Blob.
 */
async function _docxAssemble(documentXml, opts) {
  opts = opts || {};
  if (typeof JSZip === 'undefined') throw new Error('_docxAssemble: JSZip is not loaded');
  if (typeof CSC_DOCX_SKELETON_B64 === 'undefined')
    throw new Error('_docxAssemble: CSC_DOCX_SKELETON_B64 is not loaded (app/docx-skeleton.js)');

  var skeletonBytes = _docxBase64ToUint8Array(CSC_DOCX_SKELETON_B64);
  var zip = await JSZip.loadAsync(skeletonBytes);

  var skeletonDocXml = await zip.file('word/document.xml').async('string');

  var bodyOpenTag = '<w:body>';
  var bodyOpenIdx = skeletonDocXml.indexOf(bodyOpenTag);
  var sectPrIdx = skeletonDocXml.indexOf('<w:sectPr');
  if (bodyOpenIdx === -1 || sectPrIdx === -1) {
    throw new Error('_docxAssemble: skeleton word/document.xml missing <w:body> or <w:sectPr> -- cannot safely splice');
  }

  var head = skeletonDocXml.slice(0, bodyOpenIdx + bodyOpenTag.length); // ...<w:document ...><w:body>
  var tail = skeletonDocXml.slice(sectPrIdx); // <w:sectPr ...>...</w:sectPr></w:body></w:document>  -- VERBATIM, unmodified

  var fullDocXml = head + documentXml + tail;
  zip.file('word/document.xml', fullDocXml);

  if (Array.isArray(opts.images)) {
    for (var i = 0; i < opts.images.length; i++) {
      var img = opts.images[i];
      await _docxEmbedImage(zip, img.bytes, img.extension, img.mediaIndex);
    }
  }

  var blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  if (opts.download !== false && typeof document !== 'undefined') {
    var filename = opts.filename || 'document.docx';
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  return blob;
}
