/* ── ATTACH BILL PDFs (WP-31, 2026-09-29) ──
   Attach a PDF file to bills that already exist, WITHOUT reading the PDF.
   The user picks the billing period and the meters for each file. Only the
   pdfKey / hasPDF / pdfPageStart / pdfPageEnd fields of the chosen bills change.
   Blobs use the same store as extraction: key en_pdf_shared_<sha256 first 16>
   (core.js pdfStore/pdfLoad). Blobs are never deleted: a replaced bill just
   points at another key, and other bills may still use the old one. */

// Core (no DOM): store the file once, then tag every chosen bill.
// Returns { key, stored, count } or null when the file could not be stored.
// Store one PDF blob once, under en_pdf_shared_<sha256 first 16>. Returns { key, stored } or null.
// Also used by the presented-report PDF (app/presented-savings.js): one store path for both.
async function bpaStoreBlob(b64, deps) {
  const hex = await deps.hash(b64);
  const key = 'en_pdf_shared_' + hex.slice(0, 16);
  let stored = false;
  if (!(await deps.load(key))) {
    if (!(await deps.store(key, b64))) return null;
    stored = true;
  }
  return { key, stored };
}

async function bpaAttachFile({ b64, bills, pageStart, pageEnd, deps }) {
  const blob = await bpaStoreBlob(b64, deps);
  if (!blob) return null;
  const { key, stored } = blob;
  bills.forEach((b) => {
    b.pdfKey = key;
    b.hasPDF = true;
    // A page range belongs to the file it was set for: always reset it.
    delete b.pdfPageStart;
    delete b.pdfPageEnd;
    if (pageStart) b.pdfPageStart = pageStart;
    if (pageEnd) b.pdfPageEnd = pageEnd;
  });
  return { key, stored, count: bills.length };
}

// Bills that already have a DIFFERENT PDF: the user must confirm before replacing.
function bpaFindConflicts(bills, key) {
  return bills.filter((b) => b.pdfKey && b.pdfKey !== key);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bpaAttachFile, bpaFindConflicts, bpaStoreBlob };
}

/* ── UI (browser only) ── */
var _bpa = null; // { projId, rows:[{name,b64,period,sel:{mid:true},from,to}], meters:[], periods:[], startMid }

function _bpaEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function _bpaSha256Hex(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

function openAttachBillPdfs(mid) {
  if (typeof resolveUDMeter !== 'function') return;
  const ctx = resolveUDMeter(mid);
  if (!ctx) {
    showToast('Meter not found — try re-selecting the meter', 'warn');
    return;
  }
  const projId = udSelProjId;
  const meters = [];
  const periodMap = {};
  (getUDBldgs(projId) || []).forEach((b) => {
    (b.meters || []).forEach((m) => {
      meters.push({ mid: m.id, m, bldg: b.name || 'Building', commodity: m.commodity || '' });
      (m.bills || []).forEach((r) => {
        if (r.start && r.end) periodMap[r.start + '|' + r.end] = { start: r.start, end: r.end };
      });
    });
  });
  // Newest first.
  const periods = Object.values(periodMap).sort((a, c) => (c.end + c.start < a.end + a.start ? -1 : 1));
  _bpa = { projId, rows: [], meters, periods, startMid: mid };
  document.getElementById('bpaModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'bpaModal';
  modal.className = 'modal-bg open';
  modal.style.zIndex = '999'; // under the shared confirm dialog (z 1000) so the replace question shows on top
  modal.innerHTML =
    '<div class="modal" style="width:860px">' +
    '<div class="modal-hdr"><span class="modal-title">Attach bill PDFs to billing periods</span>' +
    '<button class="modal-x" onclick="closeAttachBillPdfs()">&times;</button></div>' +
    '<div style="padding:14px 20px;overflow-y:auto">' +
    '<div style="font-size:12px;color:var(--text2);margin-bottom:10px">Choose PDF files. For each file, pick the billing period and the meters it belongs to. ' +
    'The PDF is only attached. Nothing is read from it and no bill numbers change.</div>' +
    '<label id="bpaDrop" style="display:block;border:1px dashed var(--border2);border-radius:8px;padding:14px;text-align:center;cursor:pointer;font-size:12px;color:var(--text2)" ' +
    'ondragover="event.preventDefault()" ondrop="event.preventDefault();bpaAddFiles(event.dataTransfer.files)">' +
    'Drop PDF files here or click to choose' +
    '<input id="bpaInput" type="file" accept="application/pdf,.pdf" multiple style="display:none" onchange="bpaAddFiles(this.files);this.value=&quot;&quot;"></label>' +
    '<div id="bpaRows" style="margin-top:12px"></div></div>' +
    '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">' +
    '<button class="btn btn-ghost btn-sm" onclick="closeAttachBillPdfs()">Cancel</button>' +
    '<button class="btn btn-primary btn-sm" id="bpaSave" onclick="bpaSave()">Attach PDFs</button></div></div>';
  document.body.appendChild(modal);
  _bpaRender();
}

function closeAttachBillPdfs() {
  document.getElementById('bpaModal')?.remove();
  _bpa = null;
}

function bpaAddFiles(files) {
  if (!_bpa) return;
  Array.from(files || []).forEach((f) => {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return;
    const rd = new FileReader();
    rd.onload = () => {
      if (!_bpa) return;
      const b64 = String(rd.result).split(',')[1] || '';
      const sel = {};
      sel[_bpa.startMid] = true;
      _bpa.rows.push({ name: f.name, b64, period: '', sel, from: '', to: '' });
      _bpaRender();
    };
    rd.readAsDataURL(f);
  });
}

function _bpaBill(meter, periodKey) {
  if (!periodKey) return null;
  const [s, e] = periodKey.split('|');
  return (meter.m.bills || []).find((r) => r.start === s && r.end === e) || null;
}

function _bpaRender() {
  const host = document.getElementById('bpaRows');
  if (!host || !_bpa) return;
  if (!_bpa.rows.length) {
    host.innerHTML = '<div style="font-size:12px;color:var(--text3)">No files chosen yet.</div>';
    return;
  }
  const byBldg = {};
  _bpa.meters.forEach((mt) => (byBldg[mt.bldg] = byBldg[mt.bldg] || []).push(mt));
  host.innerHTML = _bpa.rows
    .map((row, i) => {
      const opts =
        '<option value="">Choose a billing period…</option>' +
        _bpa.periods
          .map((p) => {
            const k = p.start + '|' + p.end;
            return (
              '<option value="' +
              k +
              '"' +
              (k === row.period ? ' selected' : '') +
              '>' +
              fmtDate(p.start) +
              ' – ' +
              fmtDate(p.end) +
              '</option>'
            );
          })
          .join('');
      const meterHtml = Object.keys(byBldg)
        .map(
          (bn) =>
            '<div style="margin-top:4px"><span style="font-size:11px;color:var(--text3)">' +
            _bpaEsc(bn) +
            '</span> ' +
            byBldg[bn]
              .map((mt) => {
                const bill = _bpaBill(mt, row.period);
                const dis = row.period && !bill;
                const has = bill && bill.pdfKey;
                return (
                  '<label style="display:inline-block;margin:2px 10px 2px 0;font-size:12px;' +
                  (dis ? 'opacity:.5' : '') +
                  '">' +
                  '<input type="checkbox" ' +
                  (row.sel[mt.mid] && !dis ? 'checked ' : '') +
                  (dis ? 'disabled ' : '') +
                  'onchange="bpaToggleMeter(' +
                  i +
                  ',&quot;' +
                  mt.mid +
                  '&quot;,this.checked)"> ' +
                  _bpaEsc(mt.commodity + ' ' + (mt.m.account || mt.m.meter || '')) +
                  (dis ? ' (no bill this period)' : '') +
                  (has ? ' <span style="color:var(--text2)">(already has a PDF)</span>' : '') +
                  '</label>'
                );
              })
              .join('') +
            '</div>',
        )
        .join('');
      return (
        '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;background:var(--s1)">' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<a href="#" style="font-weight:600;color:var(--accent)" title="Click to preview" onclick="bpaPreview(' +
        i +
        ');return false">' +
        _bpaEsc(row.name) +
        '</a>' +
        '<select class="fs" style="width:auto" onchange="bpaSetPeriod(' +
        i +
        ',this.value)">' +
        opts +
        '</select>' +
        '<span style="font-size:12px">Pages (optional): <input class="fi" type="number" min="1" style="width:64px;padding:4px 6px" value="' +
        _bpaEsc(row.from) +
        '" onchange="_bpa.rows[' +
        i +
        '].from=this.value"> to <input class="fi" type="number" min="1" style="width:64px;padding:4px 6px" value="' +
        _bpaEsc(row.to) +
        '" onchange="_bpa.rows[' +
        i +
        '].to=this.value"></span>' +
        '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="bpaRemove(' +
        i +
        ')">Remove</button></div>' +
        '<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="bpaPick(' +
        i +
        ',&quot;Gas&quot;)">All gas meters</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="bpaPick(' +
        i +
        ',&quot;Electric&quot;)">All electric meters</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="bpaPick(' +
        i +
        ',&quot;&quot;)">Clear</button></div>' +
        meterHtml +
        '</div>'
      );
    })
    .join('');
}

function bpaSetPeriod(i, v) {
  _bpa.rows[i].period = v;
  _bpaRender();
}
function bpaToggleMeter(i, mid, on) {
  if (on) _bpa.rows[i].sel[mid] = true;
  else delete _bpa.rows[i].sel[mid];
}
function bpaPick(i, commodity) {
  const row = _bpa.rows[i];
  row.sel = {};
  if (commodity) {
    _bpa.meters.forEach((mt) => {
      if (mt.commodity === commodity && _bpaBill(mt, row.period)) row.sel[mt.mid] = true;
    });
  }
  _bpaRender();
}
function bpaRemove(i) {
  _bpa.rows.splice(i, 1);
  _bpaRender();
}
function bpaPreview(i) {
  const bin = atob(_bpa.rows[i].b64);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
}

async function bpaSave() {
  if (!_bpa) return;
  const jobs = [];
  for (const row of _bpa.rows) {
    if (!row.period) {
      showToast('Choose a billing period for "' + row.name + '".', 'warn');
      return;
    }
    const bills = _bpa.meters
      .filter((mt) => row.sel[mt.mid])
      .map((mt) => _bpaBill(mt, row.period))
      .filter(Boolean);
    if (!bills.length) {
      showToast('Choose at least one meter for "' + row.name + '".', 'warn');
      return;
    }
    const ps = parseInt(row.from, 10) || null;
    const pe = parseInt(row.to, 10) || ps;
    if (ps && pe && pe < ps) {
      showToast('The page range for "' + row.name + '" is backwards.', 'warn');
      return;
    }
    jobs.push({ row, bills, ps, pe });
  }
  if (!jobs.length) return;
  const deps = { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore };
  // Ask before replacing a PDF that is already on a bill.
  let replaced = 0;
  for (const j of jobs) {
    const key = 'en_pdf_shared_' + (await _bpaSha256Hex(j.row.b64)).slice(0, 16);
    replaced += bpaFindConflicts(j.bills, key).length;
  }
  if (replaced) {
    const msg =
      replaced +
      (replaced === 1 ? ' bill already has' : ' bills already have') +
      ' a different PDF attached. Replace ' +
      (replaced === 1 ? 'it' : 'them') +
      ' with the new file?';
    if (!(await confirmAsync(msg))) return;
  }
  let n = 0;
  for (const j of jobs) {
    const r = await bpaAttachFile({ b64: j.row.b64, bills: j.bills, pageStart: j.ps, pageEnd: j.pe, deps });
    if (!r) {
      showToast('Could not store "' + j.row.name + '". Its bills were not changed.', 'warn');
      continue;
    }
    n += r.count;
  }
  const pid = _bpa.projId;
  if (n) saveUtilityData(pid);
  closeAttachBillPdfs();
  const isEmbed = window._udActiveWrap && window._udActiveWrap !== document.getElementById('udDetailWrap');
  if (typeof renderUDDetail === 'function') renderUDDetail(isEmbed ? window._udActiveWrap : undefined);
  showToast('Attached PDFs to ' + n + ' bill' + (n === 1 ? '' : 's') + '.');
}
