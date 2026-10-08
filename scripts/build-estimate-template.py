#!/usr/bin/env python3
"""One-off build of app/assets/estimate-template.xlsx from a source copy of the CSC
change-order cost workbook (.xlsm). Never point it at a document-site original.

Usage: python scripts/build-estimate-template.py <source-copy.xlsm> [out.xlsx]

What it does (XML level, so formulas, styles, widths, print setup and sheet order stay as is):
  - macro-free: drops vbaProject.bin, form-control buttons, macro button shapes
  - strips _xlfn.SINGLE( ) wrappers from formulas
  - drops every cached formula value (the export writes them from estimate-workbook.js)
  - blanks every input cell and every client-specific string
  - drops document-site/customXml/calcChain parts and personal document properties
  - strips print header/footer text that holds a name, email or phone (keeps page numbers)
  - sets fullCalcOnLoad on the workbook
  - scans the result for client strings and exits 1 if any are found
"""
import html
import os
import re
import sys
import zipfile

SRC_DEFAULT = None
OUT_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'assets', 'estimate-template.xlsx')

# sheet part -> (name, input ranges to blank). Ranges are inclusive A1 ranges.
SHEETS = {
    'xl/worksheets/sheet1.xml': ('Info', ['C7', 'C9', 'C10', 'F7']),
    'xl/worksheets/sheet4.xml': ('Dash', ['E8:E16', 'L8:M21', 'D27:F31', 'E38', 'E39:F44']),
    'xl/worksheets/sheet5.xml': ('Mat & Equip', ['B8:E32']),
    'xl/worksheets/sheet7.xml': ('CSC Parts Quote', ['F4', 'F5', 'E11:E35']),
}
# client text that must never appear in the template (case-insensitive)
FORBIDDEN = ['joco', 'johnson', 'county', 'librar', 'tracy', 'dorman', 'nkcop', 'sharepoint', 'csckc',
             'matt miller', 'mmiller']
# CSC policy / label cells that stay as typed constants (not client data)
REMOVE_PARTS = re.compile(r'^(xl/vbaProject\.bin|xl/ctrlProps/|customXml/|xl/calcChain\.xml|docProps/custom\.xml|'
                          r'xl/drawings/vmlDrawing2\.vml|xl/drawings/vmlDrawing5\.vml)')


def col_to_n(c):
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def n_to_col(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def expand(rng):
    m = re.match(r'^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$', rng)
    c1, r1, c2, r2 = m.group(1), int(m.group(2)), m.group(3) or m.group(1), int(m.group(4) or m.group(2))
    out = set()
    for c in range(col_to_n(c1), col_to_n(c2) + 1):
        for r in range(r1, r2 + 1):
            out.add(n_to_col(c) + str(r))
    return out


def strip_single(f):
    """Remove _xlfn.SINGLE( ... ) wrappers, keep the inner expression."""
    key = '_xlfn.SINGLE('
    while key in f:
        i = f.index(key)
        j = i + len(key)
        depth = 1
        inq = False
        k = j
        while k < len(f) and depth:
            ch = f[k]
            if ch == '"':
                inq = not inq
            elif not inq:
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    depth -= 1
            k += 1
        f = f[:i] + f[j:k - 1] + f[k:]
    return f


def load_shared_strings(xml):
    items = re.findall(r'<si>.*?</si>', xml, re.S)
    return [html.unescape(''.join(re.findall(r'<t[^>]*>(.*?)</t>', x, re.S))) for x in items]


CONTACT = re.compile(r'@|\d{3}[-. )]+\d{3}[-.]\d{4}|' + '|'.join(re.escape(t) for t in FORBIDDEN), re.I)


def clean_header_footer(m):
    """Drop any header/footer that carries a name, email or phone. Keep a bare page-number footer."""
    kind, body = m.group(1) + m.group(2), html.unescape(m.group(3))
    if not CONTACT.search(body):
        return m.group(0)
    if re.search(r'&[PN]', body):
        return '<%s>&amp;R&amp;P of &amp;N</%s>' % (kind, kind)
    return ''


def process_sheet(xml, blank, sst, blanked_strings):
    def cell(m):
        ref, attrs, body = m.group(1), m.group(2), m.group(3)
        if body is None:
            return m.group(0)
        has_f = '<f' in body
        if has_f:
            fm = re.search(r'<f([^>]*)>(.*?)</f>', body, re.S)
            fs = re.search(r'<f([^>]*)/>', body)
            if fm:
                f_xml = '<f%s>%s</f>' % (fm.group(1), strip_single(fm.group(2)))
            else:
                f_xml = '<f%s/>' % fs.group(1)
            attrs2 = re.sub(r'\s+t="[^"]*"', '', attrs)
            return '<c r="%s"%s>%s</c>' % (ref, attrs2, f_xml)
        if ref in blank:
            attrs2 = re.sub(r'\s+t="[^"]*"', '', attrs)
            return '<c r="%s"%s/>' % (ref, attrs2)
        return m.group(0)

    xml = re.sub(r'<c r="([A-Z]+\d+)"([^>]*?)(?:/>|>(.*?)</c>)', cell, xml, flags=re.S)
    # form-control buttons (macro) at the end of the worksheet
    xml = re.sub(r'<mc:AlternateContent[^>]*><mc:Choice Requires="x14"><controls>.*</controls></mc:Choice></mc:AlternateContent>(?=</worksheet>)', '', xml, flags=re.S)
    xml = re.sub(r'\s+codeName="[^"]*"', '', xml)
    xml = re.sub(r'<(odd|even|first)(Header|Footer)>(.*?)</\1\2>', clean_header_footer, xml, flags=re.S)
    xml = re.sub(r'<headerFooter[^>]*>\s*</headerFooter>', '', xml)
    return xml


def build(src, out):
    zin = zipfile.ZipFile(src)
    parts = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    sst = load_shared_strings(parts['xl/sharedStrings.xml'].decode('utf8'))
    blanked = set()

    for name in list(parts):
        if REMOVE_PARTS.match(name):
            del parts[name]

    for part, (_, ranges) in SHEETS.items():
        blank = set()
        for r in ranges:
            blank |= expand(r)
        parts[part] = process_sheet(parts[part].decode('utf8'), blank, sst, blanked).encode('utf8')
    for part in [p for p in parts if p.startswith('xl/worksheets/sheet') and p.endswith('.xml') and p not in SHEETS]:
        parts[part] = process_sheet(parts[part].decode('utf8'), set(), sst, blanked).encode('utf8')

    # shared strings that no cell references any more (blanked inputs, sample parts, client text)
    used = set()
    for p in parts:
        if re.match(r'xl/worksheets/sheet\d+\.xml$', p):
            for m in re.finditer(r'<c [^>]*t="s"[^>]*><v>(\d+)</v>', parts[p].decode('utf8')):
                used.add(int(m.group(1)))
    sx = parts['xl/sharedStrings.xml'].decode('utf8')
    sis = re.findall(r'<si>.*?</si>', sx, re.S)
    for i, text in enumerate(sst):
        low = text.lower()
        if text.strip() and (i not in used or any(t in low for t in FORBIDDEN)):
            sx = sx.replace(sis[i], '<si><t></t></si>', 1)
            blanked.add(text)
    parts['xl/sharedStrings.xml'] = sx.encode('utf8')

    # sheet rels: drop control props, vml of removed buttons, document-site-bound items
    for p in [p for p in parts if p.startswith('xl/worksheets/_rels/')]:
        x = parts[p].decode('utf8')
        x = re.sub(r'<Relationship [^>]*Target="\.\./ctrlProps/[^>]*/>', '', x)
        x = re.sub(r'<Relationship [^>]*Target="\.\./drawings/vmlDrawing[25]\.vml"[^>]*/>', '', x)
        parts[p] = x.encode('utf8')
    for p, rid_pat in (('xl/worksheets/sheet3.xml', None), ('xl/worksheets/sheet8.xml', None)):
        x = parts[p].decode('utf8')
        x = re.sub(r'<legacyDrawing r:id="[^"]*"/>', '', x)
        parts[p] = x.encode('utf8')
    # macro button shapes inside drawings
    for p in [p for p in parts if re.match(r'xl/drawings/drawing\d+\.xml$', p)]:
        x = parts[p].decode('utf8')
        x = re.sub(r'<mc:AlternateContent[^>]*>.*?</mc:AlternateContent>', '', x, flags=re.S)
        x = re.sub(r'\smacro="[^"]*"', ' macro=""', x)
        parts[p] = x.encode('utf8')

    # workbook: macro-free, no document-site path, full recalc on load
    wb = parts['xl/workbook.xml'].decode('utf8')
    wb = re.sub(r'<mc:AlternateContent[^>]*><mc:Choice Requires="x15"><x15ac:absPath.*?</mc:AlternateContent>', '', wb, flags=re.S)
    wb = re.sub(r'\s+codeName="[^"]*"', '', wb)
    wb = re.sub(r'<calcPr[^>]*/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>', wb)
    parts['xl/workbook.xml'] = wb.encode('utf8')
    rels = parts['xl/_rels/workbook.xml.rels'].decode('utf8')
    rels = re.sub(r'<Relationship [^>]*(?:vbaProject|calcChain|customXml)[^>]*/>', '', rels)
    parts['xl/_rels/workbook.xml.rels'] = rels.encode('utf8')
    root = parts['_rels/.rels'].decode('utf8')
    root = re.sub(r'<Relationship [^>]*custom-properties[^>]*/>', '', root)
    parts['_rels/.rels'] = root.encode('utf8')
    ct = parts['[Content_Types].xml'].decode('utf8')
    ct = ct.replace('application/vnd.ms-excel.sheet.macroEnabled.main+xml',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
    ct = re.sub(r'<Override PartName="/(?:xl/ctrlProps/[^"]*|xl/calcChain\.xml|customXml/[^"]*|xl/vbaProject\.bin|docProps/custom\.xml)"[^>]*/>', '', ct)
    parts['[Content_Types].xml'] = ct.encode('utf8')

    # personal document properties
    core = parts['docProps/core.xml'].decode('utf8')
    core = re.sub(r'<dc:creator>.*?</dc:creator>', '<dc:creator>Control Service Company</dc:creator>', core)
    core = re.sub(r'<cp:lastModifiedBy>.*?</cp:lastModifiedBy>', '<cp:lastModifiedBy>Control Service Company</cp:lastModifiedBy>', core)
    parts['docProps/core.xml'] = core.encode('utf8')
    # cell-note author
    for p in [p for p in parts if re.match(r'xl/comments\d+\.xml$', p)]:
        parts[p] = parts[p].decode('utf8').replace('Tracy Dorman', 'Control Service Company').encode('utf8')

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    order = ['[Content_Types].xml'] + [p for p in parts if p != '[Content_Types].xml']
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zo:
        for p in order:
            zo.writestr(p, parts[p])
    return blanked


def scan(path, blanked_strings):
    """Fail on any client string in any XML/rels/vml part of the template."""
    needles = set(FORBIDDEN)
    for s in blanked_strings:
        s = s.strip().lower()
        if len(s) >= 4 and not re.match(r'^[a-z]-[a-z]{3}$', s):  # CSC code-list values (C-ABC) are legit
            needles.add(s)
    hits = []
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(('.jpeg', '.png', '.bin')):
                continue
            text = html.unescape(z.read(n).decode('utf8', 'replace')).lower()
            # any email address; any phone number inside a print header/footer (letterhead phone is company, not staff)
            hf = ''.join(re.findall(r'<headerFooter.*?</headerFooter>', text, re.S))
            if re.search(r'[\w.+-]+@[\w-]+\.[a-z]{2,}', text) or re.search(r'\d{3}[-. )]\d{3}[-.]\d{4}', hf):
                hits.append((n, 'email/phone pattern'))
            for t in needles:
                if t in text:
                    hits.append((n, t))
            if 'vbaproject' in n or n.startswith('xl/ctrlProps') or n.startswith('customXml'):
                hits.append((n, 'forbidden part'))
        names = z.namelist()
    return hits, names


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else OUT_DEFAULT
    blanked = build(src, out)
    hits, names = scan(out, blanked)
    print('template:', os.path.abspath(out), os.path.getsize(out), 'bytes,', len(names), 'parts')
    print('client strings blanked:', len(blanked))
    if hits:
        print('SCAN FAIL:')
        for h in hits:
            print('  ', h)
        sys.exit(1)
    print('SCAN CLEAN: no client strings or macro parts in', len(names), 'parts')
