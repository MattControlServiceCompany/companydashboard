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
 * other characters would themselves get re-escaped.
 *
 * ALSO strips (not merely fails to escape) XML-illegal C0 control chars --
 * XML 1.0 permits only \x09/\x0A/\x0D among them. Found 2026-07-31 via an
 * adversarial fixture render: \x00/\x08/\x0B/\x1F reaching <w:t> made
 * DOMParser reject the body XML ("Invalid character: Char 0x0 out of
 * allowed range") and Word refused to open the file at all ("Open with the
 * Text Recovery converter") -- worse than a repair prompt. This is not
 * contrived: Excel's Alt+Enter inside a cell is literally \x0B, and OCR
 * extraction can emit stray bytes; JOCO's data comes from spreadsheets and
 * OCR. Deliberately placed HERE (not in _docxWalkInline) because this is
 * the single choke point EVERY builder routes text and attribute values
 * through (including alt text and other DOM-derived attributes, not just
 * <w:t> body content) -- stripping upstream in only the DOM walker would
 * leave every other caller unprotected. \x0B specifically is intercepted
 * one level up in _docxRun (converted to a real <w:br/>, matching what an
 * Alt+Enter user meant) BEFORE it would otherwise be stripped here; \x0B
 * arriving here via any other path (e.g. inside an attribute) is still
 * stripped, not turned into a break -- a break has no meaning inside an
 * XML attribute value. */
function _docxEscapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
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
  // A literal \x0B (vertical tab) is what Excel writes for Alt+Enter inside
  // a cell -- if a user typed that, they meant a line break, not nothing.
  // Normalize it to '\n' BEFORE the split below so it becomes a real
  // <w:br/> here, same as an explicit '\n', instead of silently vanishing
  // when _docxEscapeXml strips remaining illegal control chars per line.
  text = text.replace(/\x0B/g, '\n');
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
 * note: must be added explicitly, it is never automatic).
 * w:cantSplit (2026-07-31, Step 8 fix): ALWAYS set, on every row (header or not) -- confirmed
 * 2026-07-31 via a real JOCO Service Proposal render: without it, Word freely splits a single
 * <w:tr> across a page boundary mid-cell (a multi-paragraph item-detail cell's SECOND paragraph
 * orphaned onto the next page while the row's vertically-centered Total Qty value stayed rendered
 * on the first page, leaving an empty-looking Total Qty cell under the orphaned text) -- a proper
 * table-quality defect, not the known in-flight "short row gets its last cell stretched" grid
 * issue. w:cantSplit tells Word to move the WHOLE row to the next page instead of breaking it. */
function _docxTableRow(cellsXml, opts) {
  opts = opts || {};
  var trPr = '<w:trPr><w:cantSplit/>' + (opts.header ? '<w:tblHeader/>' : '') + '</w:trPr>';
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

/**
 * Splice one or more fresh <w:num> instances into word/numbering.xml on an
 * already-loaded JSZip package, each referencing an EXISTING abstractNum
 * already defined in the skeleton (bullet=2, decimal=5 -- see
 * _DOCX_ABSTRACTNUM_BULLET/_DECIMAL). This is how the DOM->OOXML translator
 * (Step 5) gives every independent <ul>/<ol> its own numbering counter
 * instead of every list of the same type sharing one running count.
 *
 * Each entry ALSO carries an explicit <w:lvlOverride><w:startOverride
 * w:val="1"/></w:lvlOverride> at its own ilvl -- confirmed necessary by a
 * 2026-07-31 fixture render: a fresh w:numId with NO override, still
 * pointing at the shared w:abstractNum, was NOT enough on its own -- Word's
 * numbering engine continued the SAME running counter across w:num
 * instances that share an abstractNum unless each instance explicitly
 * overrides its start value. With the override, two independent <ol>
 * elements on the same page both correctly render "1." as their first item.
 *
 * Must be called (and awaited) BEFORE zip.generateAsync().
 * allocations: array<{numId: number, abstractNumId: number, ilvl: number}>.
 */
async function _docxSpliceNumbering(zip, allocations) {
  if (!allocations || !allocations.length) return;
  var path = 'word/numbering.xml';
  var xml = await zip.file(path).async('string');

  // Idempotency guard: calling this twice with the SAME allocation (a
  // retry, or a preview-then-final double build) must not append a second
  // <w:num> for a numId already spliced in -- the XML stays well-formed
  // either way, but a duplicate w:numId is semantically invalid and Word's
  // behavior is undefined. Dedupe on numId rather than early-returning the
  // whole call so a MIX of already-spliced and genuinely-new allocations in
  // one call still splices only the new ones.
  var freshAllocations = allocations.filter(function (a) {
    return xml.indexOf('w:numId="' + a.numId + '"') === -1;
  });
  if (!freshAllocations.length) return;

  var entries = freshAllocations
    .map(function (a) {
      var ilvl = a.ilvl || 0;
      return (
        '<w:num w:numId="' +
        a.numId +
        '"><w:abstractNumId w:val="' +
        a.abstractNumId +
        '"/><w:lvlOverride w:ilvl="' +
        ilvl +
        '"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
      );
    })
    .join('');
  xml = xml.replace('</w:numbering>', entries + '</w:numbering>');
  zip.file(path, xml);
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
 *   numIds    array of {numId: number, abstractNumId: number} -- fresh list-
 *             numbering instances (see _docxTranslatePages()'s return value)
 *             that documentXml's <w:numPr> elements already reference;
 *             spliced into word/numbering.xml via _docxSpliceNumbering
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

  // Page-1 letterhead clearance (spec §1 / plan Part A): the skeleton (CSC
  // Letterhead.docx) carries 10 empty leading <w:p> paragraphs between <w:body>
  // and <w:sectPr>, all Arial 10.5pt (w:sz/w:szCs=21). They exist ONLY to push
  // body content below the full-page letterhead's logo lockup on page 1 (logo
  // bottom edge ~146pt; the page's own top margin, 31.95pt, ends above the logo
  // and provides essentially no clearance on its own). This function used to
  // start `head` at bodyOpenIdx and skip straight to sectPrIdx, silently
  // discarding those 10 paragraphs -- so generated content began at paragraph 0
  // and collided with the logo/tagline/address block.
  //
  // Fix: preserve the skeleton's own leading paragraphs verbatim (don't discard,
  // don't re-derive a synthetic block) and apply one targeted edit -- upsize the
  // LAST of the 10 from 10.5pt to 18pt. This reproduces the CSC Louisburg
  // baseline's proven recipe (9x10.5pt + 1x18pt) exactly. The uniform bare-
  // skeleton 10x10.5pt block alone only clears ~13.3pt below the logo, which is
  // not enough; Louisburg's own document.xml upsizes its final leading paragraph
  // for this reason, and its rendered title lands at y0=179.93pt (34.3pt clear).
  var leadingParasXml = skeletonDocXml.slice(bodyOpenIdx + bodyOpenTag.length, sectPrIdx);
  var leadingParaRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  var lastLeadingParaMatch = null;
  var leadingParaMatch;
  while ((leadingParaMatch = leadingParaRe.exec(leadingParasXml)) !== null) {
    lastLeadingParaMatch = leadingParaMatch;
  }
  if (lastLeadingParaMatch) {
    var origLastPara = lastLeadingParaMatch[0];
    var upsizedLastPara = origLastPara.replace(/w:val="21"/g, 'w:val="36"');
    leadingParasXml =
      leadingParasXml.slice(0, lastLeadingParaMatch.index) +
      upsizedLastPara +
      leadingParasXml.slice(lastLeadingParaMatch.index + origLastPara.length);
  }

  var fullDocXml = head + leadingParasXml + documentXml + tail;
  zip.file('word/document.xml', fullDocXml);

  if (Array.isArray(opts.images)) {
    for (var i = 0; i < opts.images.length; i++) {
      var img = opts.images[i];
      await _docxEmbedImage(zip, img.bytes, img.extension, img.mediaIndex);
    }
  }

  if (Array.isArray(opts.numIds) && opts.numIds.length) {
    await _docxSpliceNumbering(zip, opts.numIds);
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

/* ── DOM -> OOXML translator (Step 5) ─────────────────────────────────────
   Plan: AI/_context/plans/word-export-rebuild-2026-07-30.md Part D Step 5
   (lines 295-304) + Part E (lines 355-368).

   2026-07-31 spec deviation, Matt-authorized: H1 stays the spec §4d 18pt
   page-title size; H2-H6 get a NEW 13pt section-heading size the measured
   Louisburg baseline does not contain (spec §4b census found only 10.5pt
   body + 18pt titles). See _DOCX_HEADING_SIZE_SECTION below for the full
   rationale and the exact complaint this closes.

   Walks `.rpt-page` clones (or any DOM container) and produces the BODY XML
   _docxAssemble() expects, using ONLY the Step 3 primitive builders above --
   this file still knows nothing about report content, pricing, or client
   data; it only knows how to read a closed HTML vocabulary and turn it into
   OOXML.

   Closed element vocabulary (plan Part B, line 182-185):
     div / p / h1-h6 / span / strong / em / table / tr / td / th / ul / ol /
     li / img -- plus the data-word-indent hint attribute (spec §4e, Agreement
     clause sub-levels). Anything outside this vocabulary is walked
     defensively via _docxTranslateBlockChildren() (ALL childNodes visited,
     elements AND text -- not just el.children, which the DOM defines as
     elements only -- so loose text sitting directly at a block position is
     turned into its own paragraph instead of silently vanishing) but the
     unknown tag itself never emits XML. Corrected 2026-07-31: this comment
     used to claim "children still visited, so content is never silently
     dropped" while the code underneath walked el.children (elements only)
     in three places (this branch, a DIV-with-block-children container, and
     the page-root iteration) -- the claim was false and loose text between
     block siblings was in fact dropped; verified by adversarial fixture
     render (zero occurrences of the injected loose-text markers in the
     generated XML / rendered PDF).

   Indentation policy (Step 5, plan line 298-301): body paragraphs get NO
   w:ind -- the skeleton's real page margins (spec §1) do the work now, which
   is what retires the old `_insetChildren` px-simulation entirely. Only an
   element explicitly carrying `data-word-indent="1"|"2"|"3"` gets
   `w:ind left=1080/1440/1800 firstLine=360` (spec §4e values, Agreement
   clause sub-levels).

   Spacing policy (Part E, line 359-365) is enforced by which _docx* builder
   each shape below calls, not re-stated per call: body paragraphs
   w:after=240 (_docxParagraph default), headings w:before=240/w:after=120
   (set explicitly here), list items w:after=40 (_docxListItem-style
   default), table-cell paragraphs w:after=0 (_docxTableCell default).

   <ul> -> a freshly allocated w:numId per list instance, referencing the
   skeleton's abstractNumId 2 (bullet, Symbol glyph, ind left=720/
   hanging=360 -- spec §6, confirmed against the actual skeleton package).
   <ol> -> a freshly allocated w:numId per list instance, referencing
   abstractNumId 5 (decimal, ind left=720/hanging=360). "Freshly allocated
   per instance" (not the skeleton's own fixed numId 6/4) because Word's
   numbering engine shares a running counter across every w:num that points
   at the same w:abstractNum UNLESS each instance carries its own
   w:lvlOverride/w:startOverride -- see _docxSpliceNumbering.

   Known, documented gaps (not silently glossed over):
     - <img> is only embedded when its `src` is a `data:image/...;base64,...`
       URI (decoded synchronously, no network fetch). A non-data-URL <img> is
       skipped with a console.warn and omitted from output -- report content
       does not currently emit non-data-URL <img> src values in the .rpt-page
       markup this translator targets (letterhead art lives in the skeleton's
       own header parts, not in .rpt-page body markup).
     - Per-<td>/<th> `width:N%` (construct D's *table-cell* variant, e.g. the
       ASHRAE 36 Sequences table) is NOT derived here -- only <colgroup><col
       style="width:N%"> is. Per-cell width derivation, the flex/SVG shape
       mapping (constructs A/B/C/E from the Step 4 inventory), and
       w:tblHeader-on-long-tables are explicitly Step 6/7/8 concerns per the
       plan's own Part D breakdown, not this step's.
     - HTML whitespace collapsing is approximate: a text node that is entirely
       whitespace collapses to a single space (mirrors normal inline HTML
       rendering) rather than implementing the full CSS whitespace/formatting-
       context algorithm.
   ─────────────────────────────────────────────────────────────────────────── */

/* Skeleton numbering.xml abstractNum IDs (verified 2026-07-31 by unzipping
   the actual skeleton package, not assumed from the Step 3 comments alone):
     abstractNumId 2 -> bullet, Symbol glyph, ind left=720/hanging=360 (spec §6)
     abstractNumId 5 -> decimal,             ind left=720/hanging=360
   The skeleton's own fixed w:num instances (numId 6->abstractNum2,
   numId 4->abstractNum5) are NOT reused directly by the translator -- found
   2026-07-31 via a fixture render, in TWO stages:
     (1) two unrelated <ol> elements sharing the literal numId=4 constant
         made Word treat them as ONE continuous list instance (the second
         list's counter continued "2." instead of restarting "1.").
     (2) switching to a FRESH w:numId per list (still pointing at the same
         w:abstractNumId=5, no override) did NOT fix it -- Word's numbering
         engine shares a running counter across every w:num that references
         the SAME w:abstractNum unless each w:num explicitly overrides it.
         The actual, confirmed-by-render fix is (2) PLUS an explicit
         <w:lvlOverride><w:startOverride w:val="1"/></w:lvlOverride> on
         every newly allocated w:num, at the exact ilvl that list starts at
         -- see _docxSpliceNumbering. */
var _DOCX_ABSTRACTNUM_BULLET = 2;
var _DOCX_ABSTRACTNUM_DECIMAL = 5;
/* First dynamically-allocated numId -- past the skeleton's own fixed 1-6. */
var _DOCX_NUMID_ALLOC_START = 1000;

/** Allocate a fresh w:numId bound to abstractNumId at the given ilvl,
 * recorded on ctx for _docxSpliceNumbering to inject into
 * word/numbering.xml (with a startOverride at that ilvl, forcing a genuine
 * restart -- see the comment above) at assembly time. Every <ul>/<ol>
 * element (top-level OR nested) gets its own call. */
function _docxAllocNumId(ctx, abstractNumId, ilvl) {
  var numId = ctx.nextNumId++;
  ctx.numAllocations.push({ numId: numId, abstractNumId: abstractNumId, ilvl: ilvl || 0 });
  return numId;
}

/* Agreement clause sub-level indentation (spec §4e measured values). */
var _DOCX_INDENT_LEVELS = { 1: 1080, 2: 1440, 3: 1800 };
var _DOCX_INDENT_FIRSTLINE = 360;

/* Heading sizes (half-points). H1 = the spec §4b/§4d measured 18pt
   page/section title (w:sz=36), used AS-IS, unchanged from the baseline.
   H2-H6 = a size the Louisburg baseline does NOT contain -- spec §4b's own
   census found only two body sizes in the whole document (10.5pt dominant
   body, 18pt titles; §4b line 230: "No other paragraph/heading sizes exist
   in the body"). Matt reviewed the v731 documents 2026-07-31 and reported
   "headers are the same text size as the rest of the text" -- there is no
   intermediate size to inherit, which is the root cause. Matt authorized
   (2026-07-31) a THIRD level, 13pt (w:sz=26), Arial, NOT bold (larger font
   only -- no added weight was requested), for section headings below the
   page title.
   ** DELIBERATE DEVIATION FROM THE MEASURED LOUISBURG BASELINE, AUTHORIZED
   BY MATT 2026-07-31. This is an addition (H1's 18pt title size is kept
   as-is), not a replacement of any measured value. ** */
var _DOCX_HEADING_SIZE_H1 = 36; // 18pt -- spec §4d, unchanged baseline value
var _DOCX_HEADING_SIZE_SECTION = 26; // 13pt -- NEW, not in the baseline, Matt-authorized 2026-07-31

/* Word Export Rebuild plan Step 7 (Part D lines 313-319): gauge <svg> (ring/dial) has no
   OOXML equivalent -- decided, not re-opened (dispatch's "Gauges" section). Render the
   percentage baked into the svg's own <text> element as bold text at this size (14pt,
   between the 10.5pt body default and the 18pt page title -- prominent without competing
   with H1) plus the sibling label div, which the existing generic DIV-container/leaf-
   paragraph path already carries through unchanged. */
var _DOCX_GAUGE_PCT_SIZE = 28; // 14pt

var _DOCX_HEADING_TAGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
var _DOCX_BLOCK_TAGS = Object.assign({ DIV: 1, P: 1, TABLE: 1, UL: 1, OL: 1 }, _DOCX_HEADING_TAGS);
var _DOCX_INLINE_TAGS = { SPAN: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, BR: 1 };

/** px -> half-points: px * 0.75 = pt, pt * 2 = half-points, so px * 1.5. */
function _docxPxToHalfPt(pxValue) {
  var n = parseFloat(pxValue);
  if (!n || isNaN(n)) return null;
  return Math.round(n * 1.5);
}

/** px -> twips: 1px @96dpi = 1/96in = 1440/96 = 15 twips. */
function _docxPxToTwips(pxValue) {
  var n = parseFloat(pxValue);
  if (!n || isNaN(n)) return null;
  return Math.round(n * 15);
}

/** '#rrggbb' or 'rgb(r,g,b)'/'rgba(r,g,b,a)' -> 'RRGGBB' (no '#'), else null. */
function _docxCssColorToHex(cssColor) {
  if (!cssColor) return null;
  var m = /^#([0-9a-fA-F]{6})$/.exec(String(cssColor).trim());
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cssColor);
  if (m) {
    return [1, 2, 3]
      .map(function (i) {
        var v = Math.max(0, Math.min(255, parseInt(m[i], 10))).toString(16);
        return v.length < 2 ? '0' + v : v;
      })
      .join('')
      .toUpperCase();
  }
  return null;
}

/** data-word-indent="1"|"2"|"3" -> {indLeft, indFirstLine}, else {} (no w:ind -- body-paragraph default). */
function _docxResolveIndentHint(value) {
  if (value == null || value === '') return {};
  var left = _DOCX_INDENT_LEVELS[parseInt(value, 10)];
  if (left == null) return {};
  return { indLeft: left, indFirstLine: _DOCX_INDENT_FIRSTLINE };
}

/** True if el has at least one child ELEMENT that is itself block-level --
 * used to decide whether a <div> is a paragraph-like text leaf (no block
 * children -- collect its own runs) or a pure layout container (has block
 * children -- recurse, emit nothing of its own). */
function _docxHasBlockChild(el) {
  for (var i = 0; i < el.children.length; i++) {
    if (_DOCX_BLOCK_TAGS[el.children[i].tagName]) return true;
  }
  return false;
}

/** True if el's OWN inline `style` attribute declares `display:flex` (Word
 * Export Rebuild plan Step 4 inventory construct C candidate). Checks the
 * raw attribute string, not the live CSSOM, so this is independent of
 * whether stylesheet rules have been applied to the clone being translated.
 * Deliberately does NOT match class-driven flex (e.g. `.rpt-int-hdr`) --
 * per the Step 4 inventory only 1 of 18 declared flex classes is ever used
 * by these 3 documents' bodies, and it is a different (already
 * content-preserving) shape than the tile/gauge row this function targets;
 * scoping to inline style keeps this rule exact instead of overreaching. */
function _docxIsFlexRow(el) {
  var style = (el.getAttribute && el.getAttribute('style')) || '';
  return /display\s*:\s*flex/i.test(style);
}

/**
 * Register a <img src="data:..."> element's bytes as a to-be-embedded image
 * (ctx.images, consumed by the caller via _docxAssemble's opts.images) and
 * return the <w:r>...</w:r> image run XML referencing its relationship id.
 * Returns null (and console.warn's) for any non-data-URL src -- see the
 * "known gaps" note above this section.
 */
function _docxRegisterImage(el, ctx) {
  var src = el.getAttribute('src') || '';
  var m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(src);
  if (!m) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        '_docxTranslatePage: skipping <img> with non-data-URL src (Step 5 only embeds data: URLs synchronously): ' +
          src.slice(0, 80),
      );
    }
    return null;
  }
  var ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  var bytes = _docxBase64ToUint8Array(m[2]);
  var mediaIndex = ctx.imageCounter++;
  ctx.images.push({ bytes: bytes, extension: ext, mediaIndex: mediaIndex });
  var rId = _docxImageRelId(mediaIndex);

  var widthPx = parseFloat(el.style && el.style.width) || parseFloat(el.getAttribute('width')) || el.naturalWidth || 96;
  var heightPx =
    parseFloat(el.style && el.style.height) || parseFloat(el.getAttribute('height')) || el.naturalHeight || 96;
  var widthTwips = _docxPxToTwips(widthPx) || 1440;
  var heightTwips = _docxPxToTwips(heightPx) || 1440;

  return _docxImageRun(rId, widthTwips, heightTwips, { altText: el.getAttribute('alt') || undefined });
}

/** Block-level <img> -> its own paragraph (body spacing, w:after=240). */
function _docxTranslateImage(el, ctx) {
  var runXml = _docxRegisterImage(el, ctx);
  if (!runXml) return null;
  return { xml: _docxParagraph({ runs: [runXml], spacingAfter: 240 }) };
}

/**
 * Recursively walk a node's inline descendants (text, span/strong/em/b/i/u/
 * br, inline <img>) accumulating RAW run entries -- {text, fmt} for text,
 * {xml} for an already-built run (image), {text:'\n', fmt, isBreak:true}
 * for an explicit <br>. Entries are finalized into <w:r> XML by
 * _docxFinalizeRuns() AFTER the full walk, because edge (leading/trailing)
 * whitespace trimming needs to see the whole sequence, not one node at a
 * time. fmt carries inherited formatting (bold/italic/underline/color/
 * sizeHalfPt) down the tree -- children only ever ADD formatting, never
 * remove an ancestor's.
 */
function _docxWalkInline(node, fmt, entries, ctx) {
  if (node.nodeType === 3) {
    var text = node.nodeValue;
    if (!text) return;
    // Collapse EVERY run of whitespace (space/tab/CR/LF) to a single space,
    // mirroring normal HTML whitespace handling. Source markup (both this
    // fixture and every real .rpt-page template) is written as indented,
    // multi-line template literals, so a text node's raw value routinely
    // contains embedded newlines/indentation. Left un-collapsed, a literal
    // '\n' inside run text is turned into a spurious <w:br/> by _docxRun()
    // (which exists to honor a REAL <br> tag, not source formatting) --
    // found 2026-07-31 via a fixture render: an un-collapsed leading
    // "\n        " text-node value produced an empty <w:t/> + <w:br/> before
    // the real text, then rendered the following line's 8-space HTML indent
    // as literal preserved characters, visibly shifting "Clause sub-level 1"
    // ~18pt right of the paragraph's true left edge (measured x0 103.58pt
    // vs the expected/correct 49.56pt page-margin start).
    var collapsed = text.replace(/[ \t\r\n]+/g, ' ');
    if (collapsed === '') return;
    entries.push({ text: collapsed, fmt: fmt });
    return;
  }
  if (node.nodeType !== 1) return; // skip comments etc.

  var tag = node.tagName;
  if (tag === 'BR') {
    entries.push({ text: '\n', fmt: fmt, isBreak: true });
    return;
  }
  if (tag === 'IMG') {
    var imgRun = _docxRegisterImage(node, ctx);
    if (imgRun) entries.push({ xml: imgRun });
    return;
  }
  if (tag !== 'DIV' && !_DOCX_INLINE_TAGS[tag] && _DOCX_BLOCK_TAGS[tag]) {
    // A block element found where only inline content was expected (should
    // not happen -- _docxHasBlockChild() routes true block children to the
    // container path before we ever call this). Skip defensively rather
    // than emit malformed run text.
    return;
  }
  // DIV is the one exception, treated as a transparent inline pass-through
  // (Word Export Rebuild plan Step 4 inventory, construct A/B: the
  // <td>-vertical-centering wrapper `<div style="min-height:34px;display:
  // flex;align-items:center...">` and the inline bar+label widget `<div
  // style="display:flex;align-items:center;gap:4px">` are both bare <div>s
  // with no OOXML meaning of their own -- native w:vAlign already reproduces
  // the centering (_docxTableCell defaults every cell to vAlign=center), so
  // dropping the wrapper here (as the block-tag skip above used to do for
  // EVERY block tag, DIV included) silently discarded the wrapper's TEXT
  // content too. Found 2026-07-31 tracing the Audit Report's per-building
  // compliance table (app/report-engine.js _buildRowHTML, 13695-13760): all
  // 6 <td>s per row wrap their content in exactly this shape, so every one
  // of the 27 rows' 6 cells (162 cells total) rendered as a BLANK <w:tc> --
  // a content-completeness failure the plan's Part C check 4 (diff source
  // text vs rendered PDF text) is specifically designed to catch. TABLE/UL/
  // OL/heading tags reaching this point remain defensively skipped (a real
  // translator bug upstream, not a legitimate shape) -- DIV is the only
  // block tag known to appear here by design.
  //
  // A DIV is still block-level HTML even when flattened this way -- if it
  // follows content already collected in THIS cell/leaf (e.g. the ASHRAE 36
  // Sequences table's `_esc(seq.label) + '<div>Requires: ...</div>'`,
  // app/report-engine.js ~14020), a browser/html2canvas would start it on a
  // new line, but a bare inline flatten concatenates it onto the same line
  // with no separator at all -- found 2026-07-31 rendering the real
  // document: "Supply Air Temperature ResetRequires: Supply Air Temp..."
  // with the two run together. Insert a soft line break (w:br, same
  // paragraph -- not a new w:p, which would complicate the cell's vAlign)
  // whenever entries already hold real (non-whitespace) content; the FIRST
  // div in a cell (construct A/B's outer wrapper, entries still empty at
  // that point) correctly gets no leading break.
  if (tag === 'DIV') {
    var hasPriorContent = entries.some(function (e) {
      return e.xml || (e.text != null && e.text.trim() !== '');
    });
    if (hasPriorContent) entries.push({ text: '\n', fmt: fmt, isBreak: true });
  }

  var childFmt = Object.assign({}, fmt);
  if (tag === 'STRONG' || tag === 'B') childFmt.bold = true;
  if (tag === 'EM' || tag === 'I') childFmt.italic = true;
  if (tag === 'U') childFmt.underline = true;
  childFmt = _docxStyleFmtFromEl(node, childFmt);
  for (var i = 0; i < node.childNodes.length; i++) _docxWalkInline(node.childNodes[i], childFmt, entries, ctx);
}

/**
 * Read an element's OWN inline style (font-weight/font-style/font-size/color) and merge it onto
 * baseFmt, returning a NEW fmt object (baseFmt is never mutated). Factored out of
 * _docxWalkInline's per-node style check (2026-07-31, Step 8 fix) so block-position DIV/P
 * elements can ALSO apply their own inline style before collecting their children's runs -- see
 * the call in _docxTranslateBlock's P/DIV branch for why this matters: report markup across the
 * Service Proposal (and, by extension, any other document) is almost entirely bare
 * `<div style="font-size:19px;font-weight:700;...">text</div>` with NO nested <span>/<strong>.
 * Before this fix, _docxCollectRuns(el, {}, ctx) was called with an EMPTY base fmt for that DIV,
 * so the div's own font-size/weight/color were silently dropped and its text fell back to the
 * default 10.5pt/normal-weight/black run -- every visually distinct title/eyebrow/dollar-amount
 * size in the Proposal (19px cover title, 16px subtitle, 11px section eyebrows, 18px dollar
 * amounts, etc.) rendered as plain 10.5pt body text, reproducing Matt's exact "headers are the
 * same text size as the rest of the text" complaint even though the SOURCE markup already
 * carries the right sizes -- confirmed 2026-07-31 via a real JOCO Service Proposal PDF render
 * (measured 10.56pt on every one of those elements; see this branch's dashboardlogic.md entry).
 *
 * Merge note (integration/docx-audit-proposal-merge, 2026-07-31): feature/docx-audit-step7
 * independently fixed the identical gap for the Audit Report (bare `<h1>`-less section titles and
 * `<td style="font-size:...">` table cells) with a no-baseFmt sibling, _docxStyleFmtFromElement(el).
 * This function is the more general of the two (it also threads an inherited ancestor fmt, which
 * _docxStyleFmtFromElement could not) and replaces it everywhere -- every _docxStyleFmtFromElement(el)
 * call site becomes _docxStyleFmtFromEl(el, {}) or, where an ancestor fmt is available, that fmt.
 */
function _docxStyleFmtFromEl(el, baseFmt) {
  var fmt = Object.assign({}, baseFmt);
  if (!el || !el.style) return fmt;
  var fw = el.style.fontWeight;
  if (fw === 'bold' || fw === '700' || fw === '800' || fw === '900' || parseInt(fw, 10) >= 600) fmt.bold = true;
  if (el.style.fontStyle === 'italic') fmt.italic = true;
  var fs = el.style.fontSize;
  if (fs) {
    var hp = _docxPxToHalfPt(fs);
    if (hp) fmt.sizeHalfPt = hp;
  }
  var col = el.style.color;
  if (col) {
    var hex = _docxCssColorToHex(col);
    if (hex) fmt.color = hex;
  }
  return fmt;
}

/**
 * Trim a single leading space off the first entry and a single trailing
 * space off the last entry of a raw run-entry sequence (mirrors normal HTML
 * block-edge whitespace trimming -- word-separating spaces BETWEEN inline
 * elements are real and preserved; a stray space inherited from the source
 * markup's own indentation at the very start/end of a paragraph is not),
 * dropping any entry that becomes empty as a result, then builds the final
 * <w:r> XML for every surviving entry.
 */
function _docxFinalizeRuns(entries) {
  entries = entries.filter(function (e) {
    return e.xml || e.isBreak || (e.text != null && e.text !== '');
  });
  if (!entries.length) return [];

  var first = entries[0];
  if (!first.isBreak && !first.xml) first.text = first.text.replace(/^ +/, '');
  var last = entries[entries.length - 1];
  if (!last.isBreak && !last.xml) last.text = last.text.replace(/ +$/, '');

  entries = entries.filter(function (e) {
    return e.xml || e.isBreak || (e.text != null && e.text !== '');
  });

  return entries.map(function (e) {
    if (e.xml) return e.xml;
    return _docxRun(Object.assign({ text: e.text }, e.fmt));
  });
}

/** Collect run XML for all of el's children (not el itself). inheritedFmt
 * seeds the base formatting (e.g. {sizeHalfPt:36} for headings). */
function _docxCollectRuns(el, inheritedFmt, ctx) {
  var entries = [];
  var fmt = inheritedFmt || {};
  for (var i = 0; i < el.childNodes.length; i++) _docxWalkInline(el.childNodes[i], fmt, entries, ctx);
  return _docxFinalizeRuns(entries);
}

/** True ancestor <table> of a <tr>/<td>, stopping correctly at the nearest
 * enclosing table (so a table nested inside a cell doesn't get its rows
 * double-counted into the outer table). */
function _docxClosestTable(el) {
  var p = el.parentElement;
  while (p) {
    if (p.tagName === 'TABLE') return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Column widths in twips for a table's grid. If a direct <colgroup><col
 * style="width:N%"> matching colCount is present, derive from that
 * (construct D, plan Step 4 inventory); otherwise split the spec's content
 * width (10080 twips, spec §1) evenly, correcting rounding on the last
 * column so the sum is exact.
 */
function _docxDeriveColWidths(tableEl, colCount, contentWidthTwips) {
  contentWidthTwips = contentWidthTwips || 10080;
  var colgroup = tableEl.querySelector(':scope > colgroup');
  if (colgroup) {
    var cols = Array.prototype.slice.call(colgroup.querySelectorAll('col'));
    if (cols.length === colCount) {
      var pcts = cols.map(function (c) {
        var w = (c.style && c.style.width) || c.getAttribute('width') || '';
        var m = /([\d.]+)\s*%/.exec(w);
        return m ? parseFloat(m[1]) : null;
      });
      if (
        pcts.every(function (p) {
          return p != null;
        })
      ) {
        return pcts.map(function (p) {
          return Math.round((contentWidthTwips * p) / 100);
        });
      }
    }
  }
  // Construct D's per-cell variant (Word Export Rebuild plan Step 4 inventory: "48 width:N%
  // ... 36 in per-<td>/<th> width:N% attributes (Sequences table)" -- app/report-engine.js
  // rptPageASHRAE36CostEstimate's `_ratThead`, no <colgroup>, each <th> carries its own
  // style="width:N%" instead). Not every column needs to declare one (this table's
  // Description column has none, deliberately taking the remainder); a header/first row
  // whose cells match colCount and where AT LEAST ONE declares a percentage is enough to
  // derive from -- any undeclared column splits the leftover percentage evenly, rounding-
  // corrected on the last column so the row still sums to exactly contentWidthTwips.
  var firstRow = tableEl.querySelector('tr');
  if (firstRow) {
    var firstCells = Array.prototype.slice.call(firstRow.children).filter(function (c) {
      return c.tagName === 'TD' || c.tagName === 'TH';
    });
    if (firstCells.length === colCount) {
      var declaredPct = firstCells.map(function (c) {
        var w = (c.style && c.style.width) || c.getAttribute('width') || '';
        var m = /([\d.]+)\s*%/.exec(w);
        return m ? parseFloat(m[1]) : null;
      });
      var anyDeclared = declaredPct.some(function (p) {
        return p != null;
      });
      if (anyDeclared) {
        var declaredSum = declaredPct.reduce(function (s, p) {
          return s + (p || 0);
        }, 0);
        var undeclaredCount = declaredPct.filter(function (p) {
          return p == null;
        }).length;
        var remainingPct = Math.max(0, 100 - declaredSum);
        var eachUndeclaredPct = undeclaredCount ? remainingPct / undeclaredCount : 0;
        var pctWidths = declaredPct.map(function (p) {
          return Math.round((contentWidthTwips * (p != null ? p : eachUndeclaredPct)) / 100);
        });
        var pctSum = pctWidths.reduce(function (s, w2) {
          return s + w2;
        }, 0);
        pctWidths[pctWidths.length - 1] += contentWidthTwips - pctSum;
        return pctWidths;
      }
    }
  }

  var each = Math.floor(contentWidthTwips / colCount);
  var widths = [];
  for (var i = 0; i < colCount; i++) widths.push(each);
  widths[colCount - 1] += contentWidthTwips - each * colCount;
  return widths;
}

/**
 * Determine a table's TRUE structural column count from each row's
 * colspan-sum, using the MODAL (most common) sum rather than the max.
 *
 * The original defect used max(spanSum) as colCount: one aberrant wide row
 * (e.g. a single colspan="5" cell in an otherwise 3-column table) inflated
 * colCount to 5 for the WHOLE table, so every normal 3-cell row only ever
 * covered 3 of the 5 declared w:gridCol columns and rendered visibly
 * narrower than the overflow row (rendered evidence: v2_page4.png, table
 * "F1"). Taking the value most ROWS agree on instead is immune to a single
 * outlier row in either direction (too wide OR too narrow) -- see
 * _docxTranslateTable's row-reconciliation step, which now CLAMPS an
 * over-wide row down to this count instead of stretching an under-wide one
 * up to it.
 *
 * Ties are broken toward the header row's (row 0) sum, since the header is
 * the most reliable structural signal for a table's real width; a further
 * tie (header absent from the tied candidates) falls back to the larger
 * candidate so genuine wide content is not clipped.
 */
function _docxModalColCount(rowSpanSums) {
  var freq = {};
  rowSpanSums.forEach(function (n) {
    if (n > 0) freq[n] = (freq[n] || 0) + 1;
  });
  var maxFreq = 0;
  Object.keys(freq).forEach(function (key) {
    if (freq[key] > maxFreq) maxFreq = freq[key];
  });
  var candidates = Object.keys(freq)
    .map(function (k) {
      return parseInt(k, 10);
    })
    .filter(function (n) {
      return freq[n] === maxFreq;
    });
  if (candidates.indexOf(rowSpanSums[0]) !== -1) return rowSpanSums[0];
  return Math.max.apply(null, candidates);
}

/**
 * Translate a <table> element into a full <w:tbl> string. Row 0 becomes the
 * repeating header row (w:tblHeader, spec §5c -- "must be added explicitly,
 * it is not automatic"), bold+centered per spec §5c/5d (all cells centered,
 * not just header). <th> cells force bold regardless of row index.
 */
function _docxTranslateTable(tableEl, ctx) {
  var trEls = Array.prototype.slice.call(tableEl.querySelectorAll('tr')).filter(function (tr) {
    return _docxClosestTable(tr) === tableEl;
  });
  if (!trEls.length) return '';

  var rowSpanSums = trEls.map(function (tr) {
    var cells = Array.prototype.slice.call(tr.children).filter(function (c) {
      return c.tagName === 'TD' || c.tagName === 'TH';
    });
    return cells.reduce(function (sum, c) {
      return sum + (parseInt(c.getAttribute('colspan'), 10) || 1);
    }, 0);
  });

  // A direct <colgroup> is the author's explicit structural declaration --
  // trust its <col> count as the true colCount when present. Otherwise fall
  // back to the modal colspan-sum across rows (see _docxModalColCount).
  var colgroupEl = tableEl.querySelector(':scope > colgroup');
  var colgroupCount = colgroupEl ? colgroupEl.querySelectorAll('col').length : 0;
  var colCount = colgroupCount || _docxModalColCount(rowSpanSums);
  if (!colCount) return '';

  var colWidths = _docxDeriveColWidths(tableEl, colCount);

  var rowsXml = trEls
    .map(function (tr, rIdx) {
      var cells = Array.prototype.slice.call(tr.children).filter(function (c) {
        return c.tagName === 'TD' || c.tagName === 'TH';
      });
      if (!cells.length) return '';

      var spans = cells.map(function (c) {
        return parseInt(c.getAttribute('colspan'), 10) || 1;
      });
      var rowSpanTotal = spans.reduce(function (sum, s) {
        return sum + s;
      }, 0);
      // colCount is now the table's TRUE structural width (colgroup, or the
      // MODAL colspan-sum across rows -- see _docxModalColCount), not the
      // max. That means a row can legitimately land on either side of it:
      //
      // - OVER colCount: an aberrant wide cell (e.g. colspan="5" in a
      //   3-column table). CLAMP the overflow off the row's trailing
      //   cell(s), working backward and never taking a cell below span=1,
      //   so the row's real content lines up with the true grid instead of
      //   overflowing it. This is the original defect (v2_page4.png, table
      //   "F1"), now fixed by correcting colCount at the source instead of
      //   stretching every OTHER row to match the outlier.
      //
      // - UNDER colCount: a legitimately ragged/short row (e.g. a 2-cell
      //   footer note in a 4-column table, no colspan involved at all).
      //   Leave it COMPLETELY alone. Auto-stretching the last cell to
      //   absorb the shortfall was a regression introduced 2026-07-31: it
      //   fired on this case too and stretched the footer's text across
      //   columns it was never meant to occupy, destroying the row's
      //   borders (docx-regression-check: body-xml-old.xml vs
      //   body-xml-new.xml). Plain-browser rendering of the same fixture
      //   (browser_render_check.png) confirms a short row should just stay
      //   short -- matching the pre-regression (7998637) output exactly.
      if (rowSpanTotal > colCount) {
        var overflow = rowSpanTotal - colCount;
        for (var si = spans.length - 1; si >= 0 && overflow > 0; si--) {
          var reducible = spans[si] - 1; // never clamp a cell below span=1
          var take = Math.min(reducible, overflow);
          spans[si] -= take;
          overflow -= take;
        }
      }

      var colIdx = 0;
      var cellsXml = cells.map(function (cell, cIdx) {
        var span = spans[cIdx];
        var widthTwips = 0;
        for (var k = 0; k < span; k++) widthTwips += colWidths[colIdx + k] || 0;
        colIdx += span;

        var isHeaderCell = cell.tagName === 'TH';
        // Seed with the <td>/<th>'s OWN inline style (font-size is common on report tables, e.g.
        // `<td style="...font-size:11px;...">`) merged under isHeaderCell's bold default -- see
        // _docxStyleFmtFromEl's header comment. Computed ONCE and threaded into BOTH branches
        // below: as cellFmt/inheritedFmt for the block-child delegation (so a <ul>/<li>
        // descendant relying on cascade from the <td> still inherits its size/weight/color) and
        // as the seed fmt for the plain-text branch's own runs (so a cell with no block children
        // but its own inline style, e.g. the Audit Report's 27-building compliance table, does
        // not fall back to plain 10.5pt body text either).
        var cellBaseFmt = _docxStyleFmtFromEl(cell, isHeaderCell ? { bold: true } : {});
        var align = (cell.style && cell.style.textAlign) || 'center';
        var cellParagraphs;
        if (_docxHasBlockChild(cell)) {
          // Cell contains block-level content (e.g. a <ul> improvement list -- the Service
          // Proposal months table's Included Improvements cells, plan Step 8). _docxCollectRuns
          // only walks INLINE content and _docxWalkInline defensively SKIPS any block tag it
          // encounters (by design, for the page-level walk) -- so before this fix, a <td><ul>...
          // </ul></td> cell silently produced an empty run (confirmed 2026-07-31 via a real JOCO
          // Service Proposal render: every month cell carrying a category list rendered as a
          // literal empty <w:t/>, dropping the actual improvement names -- exactly the
          // "column per month" content Matt asked for, present in the source markup and in the
          // live HTML preview, missing from the .docx). Fix: delegate each cell child element to
          // the SAME _docxTranslateBlock dispatch the page-level walk already uses (handles
          // UL/OL/P/DIV/heading/table uniformly), and collect every resulting paragraph/list-item
          // block into this cell -- multiple <w:p> inside one <w:tc> is valid OOXML.
          cellParagraphs = [];
          Array.prototype.forEach.call(cell.children, function (child) {
            cellParagraphs = cellParagraphs.concat(_docxTranslateBlock(child, ctx, cellBaseFmt));
          });
          if (!cellParagraphs.length) {
            cellParagraphs = [
              _docxParagraph({ runs: [_docxRun({ text: '', bold: isHeaderCell })], align: align, spacingAfter: 0 }),
            ];
          }
        } else {
          var runs = _docxCollectRuns(cell, cellBaseFmt, ctx);
          cellParagraphs = [
            _docxParagraph({
              runs: runs.length ? runs : [_docxRun({ text: '', bold: isHeaderCell })],
              align: align,
              spacingAfter: 0,
            }),
          ];
        }
        return _docxTableCell({
          widthTwips: widthTwips,
          paragraphs: cellParagraphs,
          gridSpan: span > 1 ? span : undefined,
          vAlign: 'center',
        });
      });
      return _docxTableRow(cellsXml, { header: rIdx === 0 });
    })
    .join('');

  var grid =
    '<w:tblGrid>' +
    colWidths
      .map(function (w) {
        return '<w:gridCol w:w="' + w + '"/>';
      })
      .join('') +
    '</w:tblGrid>';
  var tblPr =
    '<w:tblPr><w:tblStyle w:val="TableGrid"/>' +
    '<w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    '</w:tblPr>';

  return '<w:tbl>' + tblPr + grid + rowsXml + '</w:tbl>';
}

/** Paragraph XML for a run-array + numId, list-item spacing (w:after=40). */
function _docxListItemFromRuns(runs, numId, ilvl) {
  return _docxParagraph({
    runs: runs.length ? runs : [_docxRun({ text: '' })],
    pStyle: 'ListParagraph',
    numId: numId,
    ilvl: ilvl || 0,
    spacingAfter: 40,
  });
}

/**
 * Translate a <ul>/<ol>'s direct <li> children into list-item paragraphs.
 * numId is the ALREADY-ALLOCATED w:numId for THIS list instance (see
 * _docxAllocNumId -- callers allocate it, this function does not). A nested
 * <ul>/<ol> found inside an <li> gets its OWN freshly-allocated numId at
 * ilvl+1 -- never the parent's -- so an unrelated/nested list never
 * continues another list's counter (see the _DOCX_ABSTRACTNUM_* comment).
 */
function _docxTranslateList(listEl, ctx, numId, ilvl, inheritedFmt) {
  ilvl = ilvl || 0;
  var baseFmt = inheritedFmt || {};
  var out = [];
  var liEls = Array.prototype.filter.call(listEl.children, function (c) {
    return c.tagName === 'LI';
  });
  liEls.forEach(function (li) {
    var nestedLists = [];
    var entries = [];
    Array.prototype.slice.call(li.childNodes).forEach(function (node) {
      if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) {
        nestedLists.push(node);
      } else {
        _docxWalkInline(node, baseFmt, entries, ctx);
      }
    });
    var directRuns = _docxFinalizeRuns(entries);
    out.push(_docxListItemFromRuns(directRuns, numId, ilvl));
    nestedLists.forEach(function (nested) {
      var nestedAbstractId = nested.tagName === 'OL' ? _DOCX_ABSTRACTNUM_DECIMAL : _DOCX_ABSTRACTNUM_BULLET;
      var nestedNumId = _docxAllocNumId(ctx, nestedAbstractId, ilvl + 1);
      out = out.concat(_docxTranslateList(nested, ctx, nestedNumId, ilvl + 1, baseFmt));
    });
  });
  return out;
}

/** Whitespace-collapse a loose (block-position) text node's raw value the
 * same way _docxWalkInline does for inline text (every run of space/tab/
 * CR/LF -> one space), then trim leading/trailing space -- this text stands
 * alone as its own paragraph (no neighboring run to preserve a boundary
 * space against), so unlike _docxFinalizeRuns' single-space-off-each-end
 * trim it is fully trimmed both ends. Returns '' for pure formatting
 * whitespace (a source template literal's own indentation/newlines between
 * tags), which must still be dropped -- do NOT turn that into blank
 * paragraphs. */
function _docxCollapseLooseText(rawText) {
  if (!rawText) return '';
  return rawText.replace(/[ \t\r\n]+/g, ' ').trim();
}

/**
 * Walk `parentEl`'s DIRECT childNodes -- elements AND text nodes -- at a
 * block position: element children are dispatched through
 * _docxTranslateBlock(); any text node whose content survives
 * _docxCollapseLooseText() becomes its own body paragraph (spacingAfter=240,
 * the same body-paragraph policy _docxTranslateBlock uses for <p>/<div>).
 *
 * The THREE call sites that need this (page-root iteration, a <div>
 * container with block children, and the defensive out-of-vocabulary-tag
 * branch) used to iterate `el.children`, which the DOM defines as ELEMENTS
 * ONLY -- text nodes sitting directly at a block position (e.g.
 * `<p>Before</p>LOOSE TEXT<p>After</p>`) were silently dropped. Found
 * 2026-07-31 via adversarial fixture render: zero occurrences of the
 * injected loose-text markers in the generated XML, confirmed absent in the
 * rendered PDF, across all three paths.
 *
 * inheritedFmt (Step 8 merge, 2026-07-31): optional base run fmt threaded straight through to
 * each element child's _docxTranslateBlock call -- see that function's own inheritedFmt header
 * comment. Page-root callers omit it (undefined -> {} downstream, zero behavior change); the DIV-
 * container and out-of-vocabulary branches in _docxTranslateBlock pass their own baseFmt so a
 * container's own font-size/weight/color still reaches descendants even though this function
 * (not el.children) is what's walking them.
 */
function _docxTranslateBlockChildren(parentEl, ctx, inheritedFmt) {
  var out = [];
  var childNodes = parentEl.childNodes;
  for (var i = 0; i < childNodes.length; i++) {
    var node = childNodes[i];
    if (node.nodeType === 1) {
      out = out.concat(_docxTranslateBlock(node, ctx, inheritedFmt));
    } else if (node.nodeType === 3) {
      var text = _docxCollapseLooseText(node.nodeValue);
      if (text) out.push(_docxParagraph({ text: text, spacingAfter: 240 }));
    }
    // other nodeTypes (comments, etc.) -- skip, same as _docxWalkInline.
  }
  return out;
}

/**
 * Translate a flex-row wrapper (construct C, see _docxIsFlexRow) into a
 * single-row, N-column BORDERLESS table -- Word's closest layout-table
 * equivalent to CSS flexbox row placement. Each direct child of el becomes
 * one cell, translated via the normal _docxTranslateBlock dispatch (so a
 * child's own gauge <svg>/text-leaf divs are handled exactly as they would
 * be anywhere else -- this function only supplies the side-by-side
 * placement, not any content-shape logic of its own) with center alignment
 * forced on every paragraph produced inside the cell (ctx._flexCellAlign),
 * because the design's center intent lives on ancestor wrapper divs
 * (`text-align:center`) that are never themselves a leaf paragraph and so
 * would otherwise be lost -- see the plan Step 4 inventory's cover
 * gauge-row/stat-row markup, where only the OUTER per-item wrapper carries
 * `text-align:center`, not the inner bold-number/label leaf divs.
 * Equal-width columns across the spec's full content width (10080 twips,
 * spec §1) -- the source's own centered/gapped narrow cluster has no direct
 * OOXML equivalent, and the plan's acceptance criteria (side-by-side tiles,
 * columns within content width) do not require reproducing the exact
 * source gap/centering, only that the tiles share a row.
 */
function _docxTranslateFlexRowTable(el, ctx) {
  var children = Array.prototype.slice.call(el.children);
  var n = children.length;
  var contentWidthTwips = 10080;
  var each = Math.floor(contentWidthTwips / n);
  var colWidths = [];
  for (var w = 0; w < n; w++) colWidths.push(each);
  colWidths[n - 1] += contentWidthTwips - each * n;

  var priorAlign = ctx._flexCellAlign;
  ctx._flexCellAlign = 'center';
  var cellsXml = children.map(function (child, idx) {
    var blockParas = _docxTranslateBlock(child, ctx);
    var paragraphs = blockParas.length
      ? blockParas
      : [_docxParagraph({ runs: [_docxRun({ text: '' })], align: 'center', spacingAfter: 0 })];
    return _docxTableCell({ widthTwips: colWidths[idx], paragraphs: paragraphs, vAlign: 'center' });
  });
  ctx._flexCellAlign = priorAlign;

  var grid =
    '<w:tblGrid>' +
    colWidths
      .map(function (w2) {
        return '<w:gridCol w:w="' + w2 + '"/>';
      })
      .join('') +
    '</w:tblGrid>';
  var tblPr =
    '<w:tblPr>' +
    '<w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>' +
    '<w:insideH w:val="nil"/><w:insideV w:val="nil"/>' +
    '</w:tblBorders>' +
    '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
    '</w:tblPr>';

  return '<w:tbl>' + tblPr + grid + '<w:tr>' + cellsXml.join('') + '</w:tr>' + '</w:tbl>';
}

/**
 * Dispatch a single block-position element to its OOXML shape. Returns an
 * array of block XML strings (0, 1, or many -- a container <div> returns
 * the concatenation of all its block children's output).
 *
 * inheritedFmt (2026-07-31, Step 8 fix): optional base run fmt (sizeHalfPt/bold/italic/color)
 * inherited from an ANCESTOR this dispatch started under, for callers that begin a sub-tree
 * translation somewhere other than a bare .rpt-page (currently: table-cell content -- see
 * _docxTranslateTable's cell dispatch). Needed because CSS inheritance (a <td style="font-
 * size:9.5px"> whose <ul>/<li> children declare no font-size of their own, relying on normal
 * cascade) has no DOM equivalent once each element is inspected in isolation -- confirmed
 * 2026-07-31 via a real JOCO Service Proposal render: the months table's per-month <ul> content
 * rendered at the default 10.5pt body size (no ancestor font-size ever reached it) inside a
 * table cell (~1.17in wide including bullet/hanging indent), producing near letter-by-letter
 * word wrapping ("Demand- / Controlle / d / Ventilatio / n (AHU)") -- readable-width failure,
 * not a horizontal overflow (min_x0/max_x1 stayed in-page). Page-level top-of-tree calls omit
 * this argument (undefined), which every branch below treats as {} -- zero behavior change for
 * the non-cell path.
 */
function _docxTranslateBlock(el, ctx, inheritedFmt) {
  if (el.nodeType !== 1) return [];
  var tag = el.tagName;
  var baseFmt = inheritedFmt || {};

  if (tag === 'TABLE') {
    var tblXml = _docxTranslateTable(el, ctx);
    return tblXml ? [tblXml] : [];
  }

  if (tag === 'UL' || tag === 'OL') {
    var abstractId = tag === 'OL' ? _DOCX_ABSTRACTNUM_DECIMAL : _DOCX_ABSTRACTNUM_BULLET;
    var listNumId = _docxAllocNumId(ctx, abstractId, 0);
    return _docxTranslateList(el, ctx, listNumId, 0, baseFmt);
  }

  if (_DOCX_HEADING_TAGS[tag]) {
    // H1 = page/section title, spec §4d 18pt (unchanged baseline value).
    // H2-H6 = section heading, 13pt -- Matt-authorized addition, see the
    // _DOCX_HEADING_SIZE_SECTION comment above; the baseline has no such
    // size, this closes Matt's 2026-07-31 "headers are the same text size
    // as the rest of the text" report. Neither level is bold by default
    // (Matt asked for larger font only, not added weight). The heading's
    // OWN fixed size always wins over any inherited size (headings are
    // never smaller because of where they happen to sit).
    var headingSizeHalfPt = tag === 'H1' ? _DOCX_HEADING_SIZE_H1 : _DOCX_HEADING_SIZE_SECTION;
    var hRuns = _docxCollectRuns(el, Object.assign({}, baseFmt, { sizeHalfPt: headingSizeHalfPt }), ctx);
    if (!hRuns.length) return [];
    return [
      _docxParagraph({
        runs: hRuns,
        align: el.style && el.style.textAlign,
        spacingBefore: 240,
        spacingAfter: 120,
      }),
    ];
  }

  if (tag === 'IMG') {
    var imgBlock = _docxTranslateImage(el, ctx);
    return imgBlock ? [imgBlock.xml] : [];
  }

  if (tag.toLowerCase() === 'svg') {
    // Word Export Rebuild plan Step 7 (Part D lines 313-319), Step 4
    // inventory construct C' -- the ring/dial gauge <svg> has no OOXML
    // equivalent (decided with Matt, not re-opened): render the percentage
    // baked into the svg's own <text> element (app/report-engine.js
    // _a36GaugeSVG, ~13164-13237) as bold text; the dial itself is dropped.
    // Extracted from the rendered svg rather than re-derived from data so
    // the text always matches whatever percentage the svg actually shows.
    var gaugeTextEls = el.querySelectorAll ? el.querySelectorAll('text') : [];
    var gaugePct = gaugeTextEls.length ? (gaugeTextEls[0].textContent || '').trim() : '';
    if (!gaugePct) return [];
    return [
      _docxParagraph({
        runs: [_docxRun({ text: gaugePct, bold: true, sizeHalfPt: _DOCX_GAUGE_PCT_SIZE })],
        align: (ctx && ctx._flexCellAlign) || 'center',
        spacingAfter: 40,
      }),
    ];
  }

  if (tag === 'DIV' && _docxIsFlexRow(el) && _docxHasBlockChild(el) && el.children.length >= 2) {
    // Word Export Rebuild plan Step 7 (Part D lines 313-319), Step 4
    // inventory construct C -- a tile-row/gauge-row (`display:flex;gap:...`
    // wrapping N block-level children meant to sit side by side). Word has
    // no flexbox; this is the exact defect Matt screenshotted (stats
    // stacked instead of side-by-side). Emitted as an N-column BORDERLESS
    // layout table (spec §5 border style only where the design calls for a
    // visible grid -- this is layout, not data) instead of falling through
    // to the generic DIV-container path below, which would flatten every
    // child into one vertical stack of paragraphs.
    return [_docxTranslateFlexRowTable(el, ctx)];
  }

  if (tag === 'P' || (tag === 'DIV' && !_docxHasBlockChild(el))) {
    // Seed the base run fmt from the inherited context, THEN this element's own inline style
    // (font-size/weight/color) on top -- see _docxStyleFmtFromEl's header comment for the defect
    // this closes (report markup's title/eyebrow/amount divs carry their own font-size with no
    // nested <span>) and this function's own header comment for why inheritedFmt matters too.
    var pBaseFmt = _docxStyleFmtFromEl(el, baseFmt);
    var pRuns = _docxCollectRuns(el, pBaseFmt, ctx);
    if (!pRuns.length) return []; // empty layout-only leaf -- no stray blank paragraph
    var indOpts = _docxResolveIndentHint(el.getAttribute && el.getAttribute('data-word-indent'));
    return [
      _docxParagraph(
        Object.assign(
          {
            runs: pRuns,
            align: (ctx && ctx._flexCellAlign) || (el.style && el.style.textAlign),
            spacingAfter: 240, // body-paragraph policy (Part E); indentation-only override below
          },
          indOpts,
        ),
      ),
    ];
  }

  if (tag === 'DIV') {
    // baseFmt threaded through so a DIV container's own font-size/weight/color (e.g. a styled
    // wrapper with no inline style of its own but sitting under a cell/ancestor that does)
    // reaches its block children -- combined with _docxTranslateBlockChildren (NOT el.children)
    // so loose text nodes sitting directly inside the container are still walked, not silently
    // dropped (fix/docx-writer-step5-adversarial; see that function's header comment).
    return _docxTranslateBlockChildren(el, ctx, baseFmt);
  }

  // Outside the closed vocabulary at a block position -- walk childNodes (elements AND loose
  // text, via _docxTranslateBlockChildren) defensively so content is never silently dropped, but
  // the unknown tag itself emits no XML. baseFmt threaded through for the same reason as above.
  return _docxTranslateBlockChildren(el, ctx, baseFmt);
}

/**
 * Step 5 entry point. Translate one or more `.rpt-page` (or any container)
 * elements, in order, into a single documentXml BODY string ready for
 * _docxAssemble(), plus the images (opts.images) and the dynamically
 * allocated list-numbering instances (opts.numIds) that must both be passed
 * through to it. A page break (<w:br w:type="page"/>) is inserted between
 * page elements when more than one is given, so Word starts a new page
 * where the source had a page boundary; pagination WITHIN a page's own
 * content is still Word's own flow.
 *
 * 2026-07-31 blank-page fix: the break is folded into the LAST run of the
 * preceding page's own final paragraph (an extra invisible run on real
 * content), not emitted as a standalone `<w:p><w:r><w:br/></w:r></w:p>`
 * paragraph between pages. A standalone break-only paragraph still needs
 * its own line of vertical space; when a page's content already reaches
 * the bottom margin (e.g. the JOCO agreement cover page's 27-item building
 * list, which ends flush with the page bottom), Word has no room left for
 * that empty paragraph and pushes the WHOLE paragraph onto a fresh page --
 * whose own forced break then immediately turns that fresh page into a
 * genuinely blank physical page (reproduced 2026-07-31: JOCO EMS Agreement
 * page 2 of an 8-page render came back with 1 character, "2", i.e. only
 * the footer page-number field -- everything else was this orphaned
 * break-only paragraph). Attaching the break run to real content that was
 * always going to render removes the empty paragraph entirely, so Word
 * never needs to find room for a line that carries nothing.
 *
 * Returns { xml: string, images: array<{bytes, extension, mediaIndex}>,
 *           numIds: array<{numId, abstractNumId}> }.
 */
function _docxTranslatePages(pageEls) {
  var ctx = { images: [], imageCounter: 100, numAllocations: [], nextNumId: _DOCX_NUMID_ALLOC_START };
  var pageBreakRun = '<w:r><w:br w:type="page"/></w:r>';
  var allBlocks = [];
  for (var p = 0; p < pageEls.length; p++) {
    // Walk ALL childNodes (elements AND loose text) via
    // _docxTranslateBlockChildren -- NOT pageEls[p].children, which the DOM
    // defines as elements-only and would silently drop loose text nodes
    // sitting directly at page-root position (fix/docx-writer-step5-adversarial,
    // 2026-07-31). The per-page block array is still needed (not folded
    // straight into allBlocks) so the blank-page splice fix below
    // (fix/docx-agreement-blankpages) can attach the page-break run onto the
    // LAST paragraph of THIS page rather than emitting a standalone
    // break-only paragraph that can overflow onto its own blank page.
    var pageBlocks = _docxTranslateBlockChildren(pageEls[p], ctx);
    if (p < pageEls.length - 1) {
      var lastIdx = pageBlocks.length - 1;
      if (lastIdx >= 0 && typeof pageBlocks[lastIdx] === 'string' && /<\/w:p>\s*$/.test(pageBlocks[lastIdx])) {
        // Splice the break run in just before the paragraph's closing tag --
        // same paragraph, same numPr/pPr, one extra trailing run.
        pageBlocks[lastIdx] = pageBlocks[lastIdx].replace(/<\/w:p>\s*$/, pageBreakRun + '</w:p>');
      } else {
        // No paragraph to attach to (page ended in a table, or produced no
        // blocks at all) -- fall back to the old standalone-break paragraph
        // rather than silently dropping the page boundary.
        pageBlocks.push('<w:p>' + pageBreakRun + '</w:p>');
      }
    }
    allBlocks = allBlocks.concat(pageBlocks);
  }
  return { xml: allBlocks.join(''), images: ctx.images, numIds: ctx.numAllocations };
}

/** Single-page convenience wrapper around _docxTranslatePages(). */
function _docxTranslatePage(pageEl) {
  return _docxTranslatePages([pageEl]);
}
