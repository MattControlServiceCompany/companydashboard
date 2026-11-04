/**
 * meeting-export.js - Meeting agenda and minutes files (Download Word, Download PDF).
 * One generator for both types (m.type = 'agenda' | 'minutes').
 *  - PDF: buildMeetingPDF() in app/csv-import.js (also the live preview in the editor).
 *  - Word: this file. The meeting is written as simple HTML, then the shared docx path
 *    (_docxTranslatePages + _docxAssemble in app/docx-writer.js) turns it into a .docx on the
 *    CSC letterhead skeleton. The letterhead and footer come from the skeleton.
 * File names: meetingFileName() in lib/report-file-name.js (the ONE name for .docx and .pdf).
 * Date line parts: meetingDateParts() here, used by both the PDF and the Word file.
 */

/** meetingDateParts - pieces of the "Meeting Date:" line. The ordinal ("rd") is its own part (superscript). */
function meetingDateParts(m) {
  const md = new Date(m.date);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const n = md.getDate();
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  const ord = s[(v - 20) % 10] || s[v] || s[0];
  const timeStr = md
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '');
  return {
    base: `Meeting Date: ${dayNames[md.getDay()]} ${monthNames[md.getMonth()]} `,
    day: String(n),
    ord: ord,
    suffix: `, ${md.getFullYear()} ${timeStr}`,
  };
}

/** meetingTitleLines - the two centered title lines (project nickname, heading + type). */
function meetingTitleLines(m) {
  const typeLabel = m.type === 'agenda' ? 'Meeting Agenda' : 'Meeting Minutes';
  return [
    m.projectNickname || '',
    (m.sectionHeading || 'Energy Management Services').replace(' Program', '') + ' ' + typeLabel,
  ];
}

/** meetingSyncEditorFields - copies the editor's three header fields into the open meeting. */
function meetingSyncEditorFields(m) {
  const nick = document.getElementById('mtg-nickname');
  if (nick) m.projectNickname = nick.value;
  const dt = document.getElementById('mtg-date');
  if (dt) m.date = dt.value;
  const hd = document.getElementById('mtg-heading');
  if (hd) m.sectionHeading = hd.value;
}

/** meetingBodyHtml - the meeting as plain HTML for the docx translator. */
function meetingBodyHtml(m) {
  const esc = (t) => _escHtml(t == null ? '' : String(t));
  const titles = meetingTitleLines(m)
    .map((t) => `<p style="text-align:center;font-size:16px">${esc(t)}</p>`)
    .join('');
  const dp = meetingDateParts(m);
  const dateLine = `<p style="text-align:center;font-size:15px">${esc(dp.base)}${esc(dp.day)}<sup>${esc(dp.ord)}</sup>${esc(dp.suffix)}</p>`;
  const tables = (m.contactTables || [])
    .map((ct) => {
      const rows = (ct.contacts || [])
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td><u style="color:rgb(0,0,200)">${esc(c.email)}</u></td></tr>`,
        )
        .join('');
      return (
        `<p style="font-size:14px"><i>${esc(ct.label)}</i></p>` +
        `<table style="width:100%"><thead><tr><th>Name</th><th>Mobile Phone</th><th>E-mail</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`
      );
    })
    .join('');
  const topics = (m.topics || [])
    .map((t) => {
      const subs = (t.subItems || []).length
        ? `<ol>${t.subItems.map((si) => `<li>${esc(si)}</li>`).join('')}</ol>`
        : '';
      return `<li>${esc(t.text)}${subs}</li>`;
    })
    .join('');
  return (
    titles +
    dateLine +
    tables +
    `<p style="font-size:15px">${esc(m.sectionHeading || 'Energy Management Services Program')}</p>` +
    `<ol>${topics}</ol>`
  );
}

/**
 * meetingStyleWordXml - lays the translated Word body out like the 10-12 minutes: title lines and
 * the contact tables sit close together, contact tables have NO grid lines, every cell is left aligned
 * and the header row has one rule under it, no underlined words, and is not bold. The shared table translator draws report-style grid
 * tables (bold, centered, TableGrid); a meeting has only these contact tables, so the change stays here.
 */
function meetingStyleWordXml(xml) {
  const noBorders =
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((e) => `<w:${e} w:val="nil"/>`)
      .join('') +
    '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="115" w:type="dxa"/></w:tblCellMar></w:tblPr>';
  return xml
    .replace(/<w:tblPr><w:tblStyle w:val="TableGrid"\/>.*?<\/w:tblPr>/g, noBorders)
    .replace(/<w:tbl>.*?<\/w:tbl>/gs, (tbl) => {
      const widths = [2060, 2260, 4500]; // Name and Phone columns at the 10-12 minutes positions; wide E-mail column so addresses do not wrap
      let col = 0;
      return tbl
        .replace(/<w:jc w:val="center"\/>/g, '<w:jc w:val="left"/>')
        .replace(/<w:b\/>/g, '')
        .replace(/<w:tblGrid>.*?<\/w:tblGrid>/s, '<w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>')
        .replace(/<w:tr>|<w:tr /g, (m) => {
          col = 0;
          return m;
        })
        .replace(/<w:tcW w:w="\d+"/g, () => `<w:tcW w:w="${widths[col++ % 3]}"`)
        // header row: one continuous rule under the row, E-mail sits 0.35 inch in (as in the 10-12 minutes)
        .replace(/<w:tr><w:trPr>(?:(?!<\/w:trPr>).)*<w:tblHeader\/>.*?<\/w:tr>/s, (hdr) => {
          let c = 0;
          return hdr.replace(/(<w:tcW [^>]*\/>)(.*?<w:pPr>(?:<w:keepNext\/>)?<w:spacing w:after="0"\/>)/gs, (_, tcw, rest) =>
            tcw + '<w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders>' +
            (c++ === 2 ? rest + '<w:ind w:left="504"/>' : rest));
        });
    })
    .replace(/<\/w:tbl><w:p><w:pPr><w:spacing w:after="240"\/>(?!<\/w:pPr><w:r><w:rPr><w:rFonts[^>]*\/><w:i\/>)/g, '</w:tbl><w:p><w:pPr><w:spacing w:before="240" w:after="240"/>')
    .replace(/<w:spacing w:after="240"\/>(?=<\/w:pPr><w:r><w:rPr><w:rFonts[^>]*\/><w:i\/>)/g, '<w:spacing w:before="160" w:after="0"/>')
    .replace(/<w:spacing w:after="240"\/><w:jc w:val="center"\/>/g, '<w:spacing w:after="0"/><w:jc w:val="center"/>');
}

/** downloadMeetingDocx - saves the meeting as a Word file on the CSC letterhead. */
async function downloadMeetingDocx(m) {
  if (typeof _docxTranslatePages !== 'function' || typeof _docxAssemble !== 'function') {
    showToast('Word export is unavailable: docx-writer.js did not load', 'error');
    return;
  }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;background:#fff;';
  holder.innerHTML = `<div class="rpt-page">${meetingBodyHtml(m)}</div>`;
  document.body.appendChild(holder);
  try {
    showToast('Generating Word document...');
    const translated = _docxTranslatePages([holder.firstChild]);
    await _docxAssemble(meetingStyleWordXml(translated.xml), {
      filename: meetingFileName(m, '.docx'),
      images: translated.images,
      numIds: translated.numIds,
    });
    showToast('Word document generated ✓');
  } catch (err) {
    console.error('Meeting Word export failed:', err);
    showToast('Word export failed: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    document.body.removeChild(holder);
  }
}

/**
 * generateMeetingFile - the one entry point for the meeting buttons.
 * @param {object} m - the meeting
 * @param {'word'|'pdf'} kind
 */
async function generateMeetingFile(m, kind) {
  if (!m) return;
  if (kind === 'word') await downloadMeetingDocx(m);
  else buildMeetingPDF(m);
}

/** meetingFileFromEditor - modal buttons: sync the header fields, then export the open meeting. */
function meetingFileFromEditor(kind) {
  if (!_editingMeeting) return;
  meetingSyncEditorFields(_editingMeeting);
  return generateMeetingFile(_editingMeeting, kind);
}

/** meetingFileById - list-row buttons. */
function meetingFileById(projId, meetingId, kind) {
  const p = projects.find((x) => x.id === projId);
  const m = p && (p.meetings || []).find((mx) => mx.id === meetingId);
  return generateMeetingFile(m, kind);
}
