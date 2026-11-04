/**
 * report-file-name.js - the ONE place that builds the file name of an exported report.
 * Print ("Save as PDF" title), Download PDF, Word .doc and Word .docx all call rptReportFileName().
 * Pattern: "<Project name> - <Report name> <period or date><ext>".
 * Pure functions, no DOM. Browser globals; also exported for the Node tests.
 */

// Names the period the report covers: " Q3-2026" (quarterly), " 2026" (annual),
// " 2025-07 to 2026-09" (cumulative, custom, current: first and last month of the report),
// or '' if not known.
function _rptFilenamePeriodTag(data) {
  var per = data && data.period;
  if (!per) return '';
  if (per.type === 'quarterly' && per.quarter && per.year) return ' Q' + per.quarter + '-' + per.year;
  if (per.type === 'annual' && per.year) return ' ' + per.year;
  var ym = per.yearMonths;
  if (ym && ym.length) return ' ' + ym[0] + (ym.length > 1 ? ' to ' + ym[ym.length - 1] : '');
  if (per.type !== 'quarterly' && per.year) return ' ' + per.year;
  return '';
}

var _RPT_FILENAME_TYPE_LABELS = { quarterly: 'Quarterly', annual: 'Annual', cumulative: 'Cumulative', custom: 'Custom Period', current: 'Current Period' };

// The ONE sanitizer: removes \ / : * ? " < > | (not allowed in Windows file names) and puts `rep` in their place.
function _rptSafeFileText(text, rep) {
  return String(text).replace(/[\\/:*?"<>|]+/g, rep);
}

// LOCAL calendar date as YYYY.MM.DD (not UTC: after 6-7 PM in Kansas UTC is already tomorrow).
function _rptFilenameDate(now) {
  var d = now || new Date();
  return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
}

/**
 * rptReportFileName - file name for the report in `data` (window._currentReportData shape).
 * @param {object} data - report data (reads project, period, _agreement, _ashrae, _soo, _auditProposal, plus the building-report flag)
 * @param {string} ext - extension with the dot ('.pdf', '.doc', '.docx') or '' for none
 * @param {Date} [now] - clock override for tests
 */
function rptReportFileName(data, ext, now) {
  var project = (data && data.project) || {};
  var client = project.client || project.name || 'Report';
  var dateStr = _rptFilenameDate(now);
  var name;
  if (data._agreement) {
    name = client + ' - Energy Management Services Agreement ' + dateStr;
  } else if (data._ashrae) {
    name =
      data._ashrae.type === 'proposal'
        ? client + ' - Service Proposal ' + dateStr
        : client + ' - ASHRAE 36 Audit Report ' + dateStr;
  } else if (data._soo) {
    name = client + ' - Sequence of Operations ' + dateStr;
  } else if (data._auditProposal) {
    name =
      client +
      ' - ' +
      (data._auditProposal.type === 'full'
        ? 'Full Facility Audit Proposal '
        : 'Building Automation System Audit Proposal ') +
      dateStr;
  } else if (data._utilityAudit) {
    name = client + ' - Utility Audit ' + dateStr;
  } else if (data._scorecard) {
    name = client + ' - Building Scorecard ' + dateStr;
  } else if (data._woodland) {
    name = (data.building && data.building.name ? data.building.name : client) + ' - Baseline & BAS Savings Report ' + dateStr;
  } else {
    var typeLabel = (data.period && _RPT_FILENAME_TYPE_LABELS[data.period.type]) || 'Annual';
    name = client + ' - ' + typeLabel + _rptFilenamePeriodTag(data) + ' Savings Report ' + dateStr;
  }
  // Characters Windows does not allow in a file name become a dash.
  return _rptSafeFileText(name, '-').replace(/\s+/g, ' ').trim() + (ext || '');
}

/**
 * meetingFileName - file name of a meeting agenda or minutes: "<Nickname> - <Heading> Meeting Agenda 2026.11.03.docx".
 * The ONE name for the .docx and the .pdf of a meeting.
 * @param {object} m - meeting (reads projectNickname, sectionHeading, type, date)
 */
function meetingFileName(m, ext) {
  var dateFile = (m.date || '').split('T')[0].replace(/-/g, '.');
  var name =
    (m.projectNickname || 'Meeting') +
    ' - ' +
    (m.sectionHeading || '').replace(' Program', '') +
    ' ' +
    (m.type === 'agenda' ? 'Meeting Agenda' : 'Meeting Minutes') +
    ' ' +
    dateFile;
  return _rptSafeFileText(name, '-').replace(/\s+/g, ' ').trim() + (ext || '');
}

/** hvacFileName - file name of the HVAC load estimation export (.docx and .pdf). */
function hvacFileName(buildingName, ext) {
  return 'HVAC Load Estimation - ' + _rptSafeFileText(String(buildingName || ''), '') + (ext || '');
}

if (typeof window !== 'undefined') {
  window.rptReportFileName = rptReportFileName;
  window.meetingFileName = meetingFileName;
  window.hvacFileName = hvacFileName;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rptReportFileName: rptReportFileName, meetingFileName: meetingFileName, hvacFileName: hvacFileName };
}
