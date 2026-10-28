// computations/audit-import.js - Facility Audit workbook import (canonical source).
// Pure: takes sheet rows (arrays of cells, as SheetJS sheet_to_json({header:1}) gives) and the Equipment
// Matrix rows. Returns findings, a matched count and the list of rows it could not match.
// It never drops a row: an unmatched row stays as a free-text finding (rowId null) AND is listed for review.
// Building names join through _emNormBldgNameForJoin (app/equipment-matrix.js), the one building-name rule.

var AUDIT_IMPORT_SHEETS = { audit: 'Facility Audit List', csc: 'CSC Deficiency List' };

function _auditNormName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function _auditHash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Key that says "this is the same finding": building + equipment + issue text.
function auditFindingKey(f) {
  return _auditNormName(f.building) + '|' + _auditNormName(f.equipment) + '|' + _auditNormName(f.issue);
}

function _auditSheetObjects(aoa) {
  if (!aoa || !aoa.length) return [];
  var head = aoa[0].map(_auditNormName);
  var out = [];
  for (var r = 1; r < aoa.length; r++) {
    var o = { _rowNum: r + 1 };
    var any = false;
    head.forEach(function (h, c) {
      var v = aoa[r][c] == null ? '' : String(aoa[r][c]).trim();
      o[h] = v;
      if (v) any = true;
    });
    if (any) out.push(o);
  }
  return out;
}

// Index matrix rows by building + equipment name. A row answers to its control program name, its
// location, and the part after the last "|" of either.
function _auditIndexRows(rows) {
  var idx = {};
  (rows || []).forEach(function (row) {
    if (!row) return;
    var b = _emNormBldgNameForJoin(row.building || '');
    var names = {};
    [row.equipName, row.location].forEach(function (n) {
      if (!n) return;
      names[_auditNormName(n)] = true;
      var tail = String(n).split('|').pop();
      names[_auditNormName(tail)] = true;
    });
    Object.keys(names).forEach(function (n) {
      var k = b + '\u0001' + n;
      (idx[k] = idx[k] || []).push(row);
    });
  });
  return idx;
}

function _auditMatch(idx, building, equipment) {
  var b = _emNormBldgNameForJoin(building);
  var hits = idx[b + '\u0001' + _auditNormName(equipment)] || idx[b + '\u0001' + _auditNormName(String(equipment).split('|').pop())];
  if (!hits || !hits.length) return { row: null, reason: 'No equipment with this name in the matrix' };
  var ids = {};
  hits.forEach(function (h) {
    ids[h.id] = h;
  });
  var keys = Object.keys(ids);
  if (keys.length > 1) return { row: null, reason: 'More than one equipment in the matrix has this name' };
  return { row: ids[keys[0]], reason: '' };
}

// sheets: { 'Facility Audit List': aoa, 'CSC Deficiency List': aoa }; existing: current findings (skip repeats).
function auditImportSheets(sheets, matrixRows, existing) {
  var idx = _auditIndexRows(matrixRows);
  var seen = {};
  (existing || []).forEach(function (f) {
    seen[auditFindingKey(f)] = f;
  });
  var findings = [];
  var unmatched = [];
  var matched = 0;
  var duplicates = 0;

  function place(sheetName, o, rec) {
    var m = _auditMatch(idx, rec.building, rec.equipment);
    rec.rowId = m.row ? m.row.id : null;
    if (m.row) matched++;
    else
      unmatched.push({
        sheet: sheetName,
        rowNum: o._rowNum,
        building: rec.building,
        equipment: rec.equipment,
        reason: m.reason,
      });
    var key = auditFindingKey(rec);
    if (seen[key]) {
      duplicates++;
      if (rec.cscList && !seen[key].cscList) seen[key].cscList = true;
      return;
    }
    rec.id = 'f' + _auditHash(key);
    seen[key] = rec;
    findings.push(rec);
  }

  _auditSheetObjects(sheets[AUDIT_IMPORT_SHEETS.audit]).forEach(function (o) {
    var issueType = o['issue type'] || '';
    var pics = o['picture'] || '';
    place(AUDIT_IMPORT_SHEETS.audit, o, {
      building: o['building name'] || '',
      equipment: o['building location or equipment affected'] || '',
      type: o['type of equipment'] || '',
      issueType: issueType,
      issue: o['issue'] || '',
      change: o['type of optimization or change'] || '',
      how: o['how do we accomplish?'] || '',
      picture: pics,
      pictureLink: '',
      notes: o['notes/comments'] || '',
      needsMod: o['does it take modifications to fix?'] || '',
      measureId: null,
      hours: parseBillNumber(o['how much time to modify?'] || ''),
      cost: parseBillNumber(o['how much would this cost?'] || ''),
      status: '',
      deficiency: issueType === 'Deficiency',
      cscList: false,
    });
  });
  _auditSheetObjects(sheets[AUDIT_IMPORT_SHEETS.csc]).forEach(function (o) {
    place(AUDIT_IMPORT_SHEETS.csc, o, {
      building: o['building name'] || '',
      equipment: o['building location or equipment affected'] || '',
      type: '',
      issueType: 'Deficiency',
      issue: o['issue'] || '',
      change: o['type of optimization or change'] || '',
      how: '',
      picture: '',
      pictureLink: '',
      notes: '',
      needsMod: '',
      measureId: null,
      hours: null,
      cost: null,
      status: o['status'] || '',
      deficiency: true,
      cscList: true,
    });
  });
  return { findings: findings, matched: matched, unmatched: unmatched, duplicates: duplicates };
}
