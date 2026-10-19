// computations/bill-layout.js — position-based bill reading. Templates are data. No DOM.
//
// Layers (Matt, 2026-10-19): position finds the field (the label slot sets the label; the value comes from
// the column box) -> OCR gives the characters -> a format regex validates -> the page sum check in
// app/energy-savings.js (_lbg_pageTotalCheck) proves. "If WALER sits exactly where WATER is on every other
// bill, it is WATER." A page whose anchors are not found gets no position read: the text reader runs as
// before and the reason is recorded (bill._readMode = 'text', bill._readFallbackReason).
//
// Who calls this: app/bill-analysis.js after each OCR'd page (readBestPass over the page's OCR passes, then
// linesBlock / fallbackMarker appended to the page text), app/energy-savings.js (the City rule reads the
// block through the markers below), tools/test-bill-layout.js (synthetic word boxes).
// Word boxes come from the same tesseract.js recognize call as the text (wordsFromOcr). No extra OCR.
//
// Coordinates: every template box is in the pixels of its reference render (template.ref, a letter page
// at the 2.5x pass). At run time two or more anchors give one uniform scale and an offset
// (fitAnchors); every box is mapped through that fit, so scan size, margins and small skew do not matter.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BILL_LAYOUT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Markers of the block appended to a page's OCR text. The City rule (app/energy-savings.js, _extractNew)
  // reads the lines between POSITION_READ and POSITION_READ_END instead of the raw page lines; a page with
  // no template match carries one POSITION_READ_FALLBACK line with the reason.
  var MARK = {
    start: '%%POSITION_READ%%',
    end: '%%POSITION_READ_END%%',
    fallback: '%%POSITION_READ_FALLBACK%%',
    // one line per value cell the re-read could not prove: "%%POSITION_HELD%% GAS:: <reason>"
    held: '%%POSITION_HELD%%',
  };

  // ── Templates ──────────────────────────────────────────────────────────────────────────────────────
  // City utility bill, "Customer Account Information" layout (every page since Dec 2025). Reference render:
  // a letter page at the 2.5x OCR pass, 1520 x 1970 px (a scanned City bill page 1, 2026-10-19 proof).
  // anchors: words printed on every page, found by fuzzy match; 2 or more FIXED anchors fix scale and
  //   offset. A floating anchor (Current Bill, Total Amount Due) is printed right under the last charge
  //   row, so it moves up on a page with fewer rows: it is located by its text and its x position only,
  //   never used for the fit, and never guessed from the fit when its label is not found.
  // columns: x ranges of the meter-read columns, the label column and the amount column.
  // chargeRows: the y band that holds the commodity rows (below the Usage header, above Current Bill);
  //   the found anchors replace these edges when present.
  // slots: the label slots in print order. A row's slot comes from a fuzzy label match; a row whose label
  //   OCR'd to noise takes the one unassigned slot between its neighbours (FUEL ADJUSTMENT under GAS).
  //   WATER and WATER PROTECTION can repeat (one line per meter), so a slot is never "used up".
  // totals: the two page totals, each read from the amount column on its own anchor's row.
  // rowPitch: the printed distance between two charge rows (reference px); splits a label band that
  //   holds two rows and places a row whose label is lost by its distance from its neighbour.
  // sumRule: the charge rows add up to this total (the proof of the box re-read), to the exact cent;
  //   creditRows: the slots that may be negative (FUEL ADJUSTMENT). Every other row and the total must be
  //   zero or more: a reading set with a negative charge is no proof (a whole-page sign flip adds up too).
  // reread: which value cells may be re-read from a crop of the page image (rows; the totals named).
  //   Total Amount Due has no sum proof on the page, so it is never re-read: a failed read stays empty.
  // cropCells: page-fraction crops for the targeted-crop fallback in app/bill-analysis.js (the former
  //   _lbgCells).
  var CITY_NEW = {
    id: 'city-new',
    ref: { w: 1520, h: 1970 },
    anchors: [
      { id: 'cai', text: 'Customer Account Information', box: [496, 694, 788, 710] },
      { id: 'prevBal', text: 'Previous Balance', box: [1075, 891, 1236, 907] },
      { id: 'acctBal', text: 'Account Balance', box: [1075, 999, 1236, 1016] },
      { id: 'usage', text: 'Usage', box: [936, 1063, 998, 1086] },
      { id: 'currentBill', text: 'Current Bill', box: [1022, 1256, 1139, 1273], floating: true },
      { id: 'totalDue', text: 'Total Amount Due', box: [1022, 1292, 1201, 1309], floating: true },
    ],
    columns: {
      prevRead: [575, 700],
      currRead: [735, 860],
      usage: [900, 1008],
      label: [1012, 1250],
      amount: [1252, 1470],
    },
    chargeRows: { yTop: 1086, topAnchor: 'usage', yBottom: 1254, bottomAnchor: 'currentBill' },
    slots: ['WATER', 'GAS', 'FUEL ADJUSTMENT', 'WATER PROTECTION', 'SEWER', 'STORMWATER'],
    rowPitch: 27.5,
    totals: [
      { label: 'Current Bill', anchor: 'currentBill' },
      { label: 'Total Amount Due', anchor: 'totalDue' },
    ],
    sumRule: { total: 'Current Bill', creditRows: ['FUEL ADJUSTMENT'] },
    reread: { rows: true, totals: ['Current Bill'] },
    cropCells: [
      { label: 'WATER', x: 0.855, y: 0.28, w: 0.145, h: 0.019 },
      { label: 'Total Amount Due', x: 0.87, y: 0.41, w: 0.13, h: 0.021 },
      // GASUSAGE: the Gas row's printed decimal usage cell (not a printed label; see the GasUsage merge
      // branch in app/energy-savings.js).
      { label: 'GASUSAGE', x: 0.69, y: 0.296, w: 0.11, h: 0.028 },
    ],
  };
  var TEMPLATES = [CITY_NEW];

  // ── OCR words ──────────────────────────────────────────────────────────────────────────────────────
  // ONE reader of tesseract.js word boxes: v5 (browser CDN) puts them in data.words; v7 (node tests) in
  // data.blocks when recognize is asked for blocks. Returns [{t, c, x0, y0, x1, y1}].
  function wordsFromOcr(result) {
    var d = result && result.data;
    var out = [];
    if (!d) return out;
    var push = function (w) {
      if (!w || !w.bbox || w.text == null) return;
      var t = String(w.text).trim();
      if (!t) return;
      out.push({ t: t, c: Math.round(w.confidence || 0), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    };
    if (Array.isArray(d.words) && d.words.length) {
      d.words.forEach(push);
      return out;
    }
    (d.blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          (l.words || []).forEach(push);
        });
      });
    });
    return out;
  }

  // ── Fuzzy label match ──────────────────────────────────────────────────────────────────────────────
  // Labels hold letters only. OCR confusables are folded before the distance is taken.
  var CONFUSABLE = {
    0: 'O',
    1: 'I',
    2: 'Z',
    3: 'E',
    4: 'A',
    5: 'S',
    6: 'G',
    7: 'T',
    8: 'B',
    9: 'G',
    '|': 'I',
    '!': 'I',
    $: 'S',
  };
  function normLabel(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/AV(?=[A-Z])/g, 'W') // "AVATER": W read as AV
      .replace(/[^A-Z0-9|!$]/g, '')
      .replace(/[0-9|!$]/g, function (ch) {
        return CONFUSABLE[ch] || '';
      });
  }
  function editDistance(a, b) {
    var m = a.length,
      n = b.length,
      prev = [],
      cur = [],
      i,
      j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur.slice();
    }
    return prev[n];
  }
  // Edits allowed for a label of this length (after folding): none for 3 letters, 2 up to 6, else 30%.
  function allowedEdits(len) {
    return len <= 3 ? 0 : len <= 6 ? 2 : Math.floor(len * 0.3);
  }
  // Distance of a found label to a wanted label, or -1 when it is not that label.
  function labelDistance(found, want) {
    var a = normLabel(found),
      b = normLabel(want);
    if (!a || !b) return -1;
    var d = editDistance(a, b);
    return d <= allowedEdits(b.length) ? d : -1;
  }

  // ── Geometry helpers ───────────────────────────────────────────────────────────────────────────────
  function cx(w) {
    return (w.x0 + w.x1) / 2;
  }
  function cy(w) {
    return (w.y0 + w.y1) / 2;
  }
  function yOverlap(a, b) {
    var o = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    var h = Math.min(a.y1 - a.y0, b.y1 - b.y0);
    return h > 0 ? o / h : 0;
  }
  function unionBox(ws) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    ws.forEach(function (w) {
      b.x0 = Math.min(b.x0, w.x0);
      b.y0 = Math.min(b.y0, w.y0);
      b.x1 = Math.max(b.x1, w.x1);
      b.y1 = Math.max(b.y1, w.y1);
    });
    return b;
  }
  // Group words into print lines: a word joins the line whose first word it overlaps vertically by 50%
  // or more. The first word, not the growing union box, is the measure: a tall word must not bridge
  // two words that are printed one under the other.
  function groupLines(words) {
    var sorted = words.slice().sort(function (a, b) {
      return cy(a) - cy(b) || a.x0 - b.x0;
    });
    var lines = [];
    sorted.forEach(function (w) {
      var line = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
        if (yOverlap(lines[i].seed, w) >= 0.5) {
          line = lines[i];
          break;
        }
      }
      if (!line) {
        line = { words: [], seed: w, box: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 } };
        lines.push(line);
      }
      line.words.push(w);
      line.box = unionBox(line.words);
    });
    lines.forEach(function (l) {
      l.words.sort(function (a, b) {
        return a.x0 - b.x0;
      });
    });
    return lines;
  }

  // ── Anchors ────────────────────────────────────────────────────────────────────────────────────────
  // Every run of 1..k+1 neighbouring words on one print line whose folded text is the anchor text within
  // the allowed edits. Returns [{dist, box}].
  function findAnchorCandidates(lines, text) {
    var want = normLabel(text);
    var k = text.split(/\s+/).length + 1;
    var out = [];
    lines.forEach(function (line) {
      for (var i = 0; i < line.words.length; i++) {
        var joined = '';
        for (var n = 0; n < k && i + n < line.words.length; n++) {
          joined += line.words[i + n].t;
          var d = editDistance(normLabel(joined), want);
          if (d <= allowedEdits(want.length)) out.push({ dist: d, box: unionBox(line.words.slice(i, i + n + 1)) });
        }
      }
    });
    out.sort(function (a, b) {
      return a.dist - b.dist;
    });
    return out.slice(0, 4);
  }
  // One uniform scale and offset from 2 or more anchors: page = s * ref + o. The scale comes from the
  // distances between anchor centres (median over pairs); when the anchors sit too close together to
  // measure it (under 15% of the page height apart) the scale expected from the page size is used.
  // Rejected when the scale is far from the expected one or an anchor lands more than 3% of the page
  // height from where the fit puts it.
  function fitAnchors(found, tpl, pageW, pageH) {
    if (found.length < 2) return null;
    var s0 = (pageW / tpl.ref.w + pageH / tpl.ref.h) / 2;
    var ratios = [],
      baseline = 0;
    for (var i = 0; i < found.length; i++)
      for (var j = i + 1; j < found.length; j++) {
        var dr = Math.hypot(cx(found[i].ref) - cx(found[j].ref), cy(found[i].ref) - cy(found[j].ref));
        var df = Math.hypot(cx(found[i].box) - cx(found[j].box), cy(found[i].box) - cy(found[j].box));
        if (dr > 0) ratios.push(df / dr);
        baseline = Math.max(baseline, dr);
      }
    ratios.sort(function (a, b) {
      return a - b;
    });
    var s = baseline < 0.15 * tpl.ref.h ? s0 : ratios[Math.floor(ratios.length / 2)];
    if (s < 0.7 * s0 || s > 1.4 * s0) return null;
    var ox = 0,
      oy = 0;
    found.forEach(function (f) {
      ox += cx(f.box) - s * cx(f.ref);
      oy += cy(f.box) - s * cy(f.ref);
    });
    ox /= found.length;
    oy /= found.length;
    var residual = 0;
    found.forEach(function (f) {
      residual = Math.max(residual, Math.hypot(cx(f.box) - (s * cx(f.ref) + ox), cy(f.box) - (s * cy(f.ref) + oy)));
    });
    if (residual > 0.03 * pageH) return null;
    return { s: s, ox: ox, oy: oy, residual: Math.round(residual), baseline: Math.round(baseline) };
  }
  function refBox(arr) {
    return { x0: arr[0], y0: arr[1], x1: arr[2], y1: arr[3] };
  }
  // Finds the anchors of a template on a page. Tries every combination of candidates of the FIXED
  // anchors (at most one per anchor); keeps the one with the most anchors, then the smallest residual.
  // Needs 2 fixed anchors. A floating anchor is then taken where its text sits in its own column (x
  // within 3% of the page width of the fit) below the charge-row top.
  // Returns { ok, reason, fit, anchors: {id: box} , found: n }.
  function matchTemplate(words, pageSize, tpl) {
    var pageW = pageSize && pageSize.w,
      pageH = pageSize && pageSize.h;
    if (!(pageW > 0 && pageH > 0) || !words || !words.length)
      return { ok: false, reason: tpl.id + ': no word boxes', found: 0 };
    var lines = groupLines(words);
    var fixed = tpl.anchors.filter(function (a) {
      return !a.floating;
    });
    var cands = fixed.map(function (a) {
      return findAnchorCandidates(lines, a.text).map(function (c) {
        return { id: a.id, ref: refBox(a.box), box: c.box, dist: c.dist };
      });
    });
    var withCands = cands.filter(function (c) {
      return c.length;
    }).length;
    if (withCands < 2)
      return { ok: false, reason: tpl.id + ': anchors found ' + withCands + ' of ' + fixed.length, found: withCands };
    var best = null;
    var walk = function (i, chosen) {
      if (i === cands.length) {
        if (chosen.length < 2) return;
        var fit = fitAnchors(chosen, tpl, pageW, pageH);
        if (!fit) return;
        if (
          !best ||
          chosen.length > best.chosen.length ||
          (chosen.length === best.chosen.length && fit.residual < best.fit.residual)
        ) {
          best = { chosen: chosen.slice(), fit: fit };
        }
        return;
      }
      walk(i + 1, chosen);
      cands[i].forEach(function (c) {
        chosen.push(c);
        walk(i + 1, chosen);
        chosen.pop();
      });
    };
    walk(0, []);
    if (!best)
      return {
        ok: false,
        reason: tpl.id + ': anchors found ' + withCands + ' of ' + fixed.length + ' but no consistent fit',
        found: withCands,
      };
    var anchors = {};
    best.chosen.forEach(function (c) {
      anchors[c.id] = c.box;
    });
    var fit = best.fit;
    var top = fit.s * tpl.chargeRows.yTop + fit.oy;
    tpl.anchors
      .filter(function (a) {
        return a.floating;
      })
      .forEach(function (a) {
        var hits = findAnchorCandidates(lines, a.text).filter(function (c) {
          return Math.abs(c.box.x0 - (fit.s * a.box[0] + fit.ox)) <= 0.03 * pageW && cy(c.box) > top;
        });
        if (hits.length) anchors[a.id] = hits[0].box;
      });
    return { ok: true, fit: fit, anchors: anchors, found: Object.keys(anchors).length, lines: lines };
  }

  // ── Values ─────────────────────────────────────────────────────────────────────────────────────────
  // Money as printed: optional minus, optional $, digits with or without thousands commas, 2 decimals,
  // optional trailing minus. The sign and the OCR forms ("¢", parentheses, a lost point) are judged by the
  // reader in app/energy-savings.js; here only the format is validated.
  var MONEY_STRICT = /^-?\$?-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}-?$/;
  // A meter read: digits with optional thousands commas. A usage: a read or a decimal (gas prints decimals).
  var READ_STRICT = /^-?\d{1,3}(?:,\d{3})*$|^-?\d+$/;
  var USAGE_STRICT = /^-?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/;
  function cellText(ws) {
    return ws
      .slice()
      .sort(function (a, b) {
        return a.x0 - b.x0;
      })
      .map(function (w) {
        return w.t;
      })
      .join(' ')
      .trim();
  }
  // A value cell takes the words that carry a digit or a bare sign ("-", "¢", "$", parentheses). A ruled
  // line, a smudge read as letters ("Aw" for 4.00) or a pen mark is not a value: the cell stays empty
  // and the box is re-read (rereadBoxes) or held.
  function valueWords(ws) {
    return ws.filter(function (w) {
      return /\d/.test(w.t) || /^[-¢$()]+$/.test(w.t);
    });
  }
  // { raw, text, ok }: text is the tight money string when the format holds, else null (never a raw
  // value: a box that fails the format gets no value; raw is kept for the debug record and the re-read).
  function moneyCell(ws) {
    ws = valueWords(ws);
    var raw = cellText(ws);
    if (!raw) return { raw: '', text: null, ok: false };
    var tight = raw.replace(/\s+/g, '');
    // Two or more digit words in one cell whose rightmost word is money on its own ("3237 3.90",
    // "[4.0] 754.33"): the printed amount is right-aligned and the words left of it are pen marks or
    // noise, so the cell is ambiguous; the re-read and the page sum decide (never the joined digits).
    var digitWords = ws
      .filter(function (w) {
        return /\d/.test(w.t);
      })
      .sort(function (a, b) {
        return (a.x0 || 0) - (b.x0 || 0);
      });
    if (digitWords.length >= 2 && MONEY_STRICT.test(digitWords[digitWords.length - 1].t.replace(/\s+/g, ''))) return { raw: raw, text: null, ok: false };
    if (MONEY_STRICT.test(tight)) return { raw: raw, text: tight, ok: true };
    return { raw: raw, text: null, ok: false };
  }
  function numCell(ws, re) {
    var raw = cellText(ws);
    if (!raw) return { raw: '', text: null, ok: false };
    var tight = raw.replace(/\s+/g, '');
    return { raw: raw, text: tight, ok: re.test(tight) };
  }
  function moneyValue(text) {
    if (text == null) return null;
    var t = String(text).replace(/[\$,]/g, '');
    var neg = /^-|-$/.test(t);
    var v = parseFloat(t.replace(/-/g, ''));
    if (isNaN(v)) return null;
    return neg ? -v : v;
  }
  function moneyText(v) {
    var a = Math.abs(v).toFixed(2);
    var parts = a.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + parts.join('.');
  }

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────
  // Reads one page with one template. Returns
  //   { ok:false, reason } or
  //   { ok:true, template, fit, anchors, rows:[{slot, labelRaw, value:{raw,text,ok}, reads:{prev,curr,usage},
  //     y, box}], totals:[{label, value, found, box}], lines:[...], held:[] }
  // rows are the charge rows in print order; a row with no slot keeps its raw label (the reader's own
  // label regexes then get a chance). box is the value cell in page pixels (the re-read crop). lines are
  // the normalized text lines for the reader ("4,396,336 4,451,372 55,036 WATER 514.08",
  // "FUEL ADJUSTMENT 29.45", "Current Bill $1,851.57"); a row whose value failed the format has no value
  // on its line.
  function readPageByTemplate(words, pageSize, tpl) {
    var m = matchTemplate(words, pageSize, tpl);
    if (!m.ok) return m;
    var fit = m.fit;
    var mapX = function (x) {
      return fit.s * x + fit.ox;
    };
    var mapY = function (y) {
      return fit.s * y + fit.oy;
    };
    var pitch = fit.s * (tpl.rowPitch || 0);
    var col = {};
    Object.keys(tpl.columns).forEach(function (k) {
      col[k] = [mapX(tpl.columns[k][0]), mapX(tpl.columns[k][1])];
    });
    var inCol = function (w, k) {
      var c = cx(w);
      return c >= col[k][0] && c <= col[k][1];
    };
    var top = m.anchors[tpl.chargeRows.topAnchor] ? m.anchors[tpl.chargeRows.topAnchor].y1 : mapY(tpl.chargeRows.yTop);
    var bottom = m.anchors[tpl.chargeRows.bottomAnchor]
      ? m.anchors[tpl.chargeRows.bottomAnchor].y0
      : mapY(tpl.chargeRows.yBottom);
    var inRegion = function (w) {
      var c = cy(w);
      return c > top && c < bottom;
    };
    var used = {};
    var markUsed = function (ws) {
      ws.forEach(function (w) {
        used[words.indexOf(w)] = true;
      });
    };
    // A word is on a band when the overlap of the two y ranges is at least half of the SMALLER height.
    // A label box OCR drew tall does not swallow the next row's value (the value is the smaller one and
    // barely overlaps); a value box OCR drew tall still belongs to the row it covers fully.
    var overlaps = function (band, w) {
      var o = Math.min(band.y1, w.y1) - Math.max(band.y0, w.y0);
      return o >= 0.5 * Math.min(w.y1 - w.y0, band.y1 - band.y0);
    };
    var sameBand = function (band) {
      return function (w) {
        if (used[words.indexOf(w)]) return false;
        return overlaps(band, w);
      };
    };
    // The value cell of a row (the re-read crop): the amount column across one row pitch around the row.
    var cellBox = function (yc) {
      var half = pitch ? 0.55 * pitch : 0.011 * pageSize.h;
      return { x0: Math.round(col.amount[0]), y0: Math.round(yc - half), x1: Math.round(col.amount[1]), y1: Math.round(yc + half) };
    };
    // Totals first: the amount-column words on each found floating anchor's own row. A total whose
    // label was not found has no value (it floats, so its row is not known; never guessed).
    var totals = tpl.totals.map(function (t) {
      var box = m.anchors[t.anchor];
      if (!box) return { label: t.label, value: { raw: '', text: null, ok: false }, found: false, box: null };
      var ws = words.filter(sameBand(box)).filter(function (w) {
        return inCol(w, 'amount');
      });
      markUsed(ws);
      return { label: t.label, value: moneyCell(ws), found: true, box: cellBox(cy(box)) };
    });
    // Bands: label-column words grouped by print line. A band taller than 1.5 row pitches holds two
    // rows' labels (a pen line through GAS and FUEL ADJUSTMENT makes OCR draw one tall box across both):
    // it is split by the template's row pitch, each word going to the row its centre falls in.
    // A word box shorter than 0.3 row pitch (a ruled line or a pen stroke OCR read as "Co", "—") is
    // not a printed label: it would open a phantom row between its neighbours.
    var labelWords = words.filter(function (w) {
      return inRegion(w) && inCol(w, 'label') && !used[words.indexOf(w)] && (!pitch || w.y1 - w.y0 >= 0.3 * pitch);
    });
    var bands = [];
    groupLines(labelWords).forEach(function (l) {
      var h = l.box.y1 - l.box.y0;
      if (!pitch || h < 1.5 * pitch) {
        bands.push({ labelWords: l.words, box: l.box, amountWords: [] });
        return;
      }
      var groups = {};
      l.words.forEach(function (w) {
        var k = Math.max(0, Math.round((cy(w) - l.box.y0 - pitch / 2) / pitch));
        (groups[k] = groups[k] || []).push(w);
      });
      Object.keys(groups).forEach(function (k) {
        var y0 = l.box.y0 + k * pitch;
        bands.push({ labelWords: groups[k], box: { x0: l.box.x0, y0: y0, x1: l.box.x1, y1: y0 + pitch }, amountWords: [], split: true });
      });
    });
    bands.forEach(function (b) {
      markUsed(b.labelWords);
    });
    // Amount words: a word in the amount column (or one that starts in the right part of the label column
    // and reaches into the amount column) goes to the band whose centre is nearest among the bands it
    // overlaps; a word with a digit that overlaps no band starts a band of its own (a row whose label
    // OCR lost).
    var amountCands = words.filter(function (w) {
      if (!inRegion(w) || used[words.indexOf(w)]) return false;
      return (
        inCol(w, 'amount') ||
        (w.x1 >= col.amount[0] && w.x0 >= col.label[0] && cx(w) > col.label[1] - 0.3 * (col.label[1] - col.label[0]))
      );
    });
    amountCands
      .slice()
      .sort(function (a, b) {
        return cy(a) - cy(b);
      })
      .forEach(function (w) {
        var best = null,
          bestD = Infinity;
        bands.forEach(function (b) {
          if (!overlaps(b.box, w)) return;
          var d = Math.abs(cy(w) - cy(b.box));
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        });
        if (best) {
          best.amountWords.push(w);
        } else if (/\d/.test(w.t)) {
          bands.push({ labelWords: [], box: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, amountWords: [w] });
        }
      });
    bands.sort(function (a, b) {
      return cy(a.box) - cy(b.box);
    });
    var totalLabels = tpl.totals.map(function (t) {
      return t.label;
    });
    var anchorTexts = tpl.anchors.map(function (a) {
      return a.text;
    });
    var rows = [];
    bands.forEach(function (b) {
      var labelRaw = cellText(b.labelWords);
      // A label word that swallowed its amount ("STORMWATER 4.00" as one word): split it.
      var swallowed = labelRaw.match(/^(.*?)\s*((?:-|¢)?\$?-?\d[\d,]*\.\d{2}-?)$/);
      markUsed(b.amountWords);
      var value = moneyCell(b.amountWords);
      if (swallowed && !b.amountWords.length) {
        labelRaw = swallowed[1];
        value = moneyCell([{ t: swallowed[2] }]);
      }
      // A band that is a page total or an anchor is not a charge row.
      var isTotal = totalLabels.concat(anchorTexts).some(function (t) {
        return labelDistance(labelRaw, t) >= 0;
      });
      if (isTotal) return;
      var slot = null,
        bestD = Infinity;
      tpl.slots.forEach(function (s) {
        var d = labelDistance(labelRaw, s);
        if (d >= 0 && d < bestD) {
          bestD = d;
          slot = s;
        }
      });
      var reads = {
        prev: numCell(
          words.filter(sameBand(b.box)).filter(function (w) {
            return inCol(w, 'prevRead');
          }),
          READ_STRICT,
        ),
        curr: numCell(
          words.filter(sameBand(b.box)).filter(function (w) {
            return inCol(w, 'currRead');
          }),
          READ_STRICT,
        ),
        usage: numCell(
          words.filter(sameBand(b.box)).filter(function (w) {
            return inCol(w, 'usage');
          }),
          USAGE_STRICT,
        ),
      };
      rows.push({
        slot: slot,
        labelRaw: labelRaw,
        value: value,
        reads: reads,
        y: Math.round(cy(b.box)),
        box: cellBox(cy(b.box)),
        byOrder: false,
      });
    });
    // Order rule: a row with no slot takes the one slot that lies between its assigned neighbours. When
    // more than one slot lies between them, the row's distance from its neighbour in row pitches picks
    // the slot (a GAS row whose label a pen line erased sits one pitch under WATER, not two).
    rows.forEach(function (r, i) {
      if (r.slot || (!r.labelRaw && !r.value.raw)) return;
      var above = -1,
        below = tpl.slots.length,
        aRow = null,
        bRow = null;
      for (var a = i - 1; a >= 0; a--)
        if (rows[a].slot) {
          above = tpl.slots.indexOf(rows[a].slot);
          aRow = rows[a];
          break;
        }
      for (var b = i + 1; b < rows.length; b++)
        if (rows[b].slot) {
          below = tpl.slots.indexOf(rows[b].slot);
          bRow = rows[b];
          break;
        }
      var between = [];
      for (var k = above + 1; k < below; k++) between.push(tpl.slots[k]);
      if (between.length === 1) {
        r.slot = between[0];
        r.byOrder = true;
      } else if (between.length > 1 && pitch > 0) {
        var idx = aRow ? above + Math.round((r.y - aRow.y) / pitch) : bRow ? below - Math.round((bRow.y - r.y) / pitch) : -1;
        if (idx > above && idx < below) {
          r.slot = tpl.slots[idx];
          r.byOrder = true;
        }
      }
    });
    var read = {
      ok: true,
      template: tpl.id,
      fit: fit,
      anchors: m.anchors,
      anchorCount: m.found,
      rows: rows,
      totals: totals,
      held: [],
      rereads: [],
      lines: [],
    };
    read.lines = buildLines(read);
    return read;
  }
  // The normalized lines of a read (rows in print order, then the totals that have a value).
  function buildLines(read) {
    var lines = [];
    read.rows.forEach(function (r) {
      if (r.absent || (!r.value.text && !r.slot)) return;
      var parts = [];
      ['prev', 'curr', 'usage'].forEach(function (k) {
        if (r.reads[k].text) parts.push(r.reads[k].text);
      });
      parts.push(r.slot || r.labelRaw);
      if (r.value.text) parts.push(r.value.text);
      lines.push(parts.join(' ').trim());
    });
    read.totals.forEach(function (t) {
      if (t.value.text) lines.push(t.label + ' ' + t.value.text);
    });
    return lines;
  }

  // Count of values that passed their format check (rows and totals): the measure of a read.
  function okCount(read) {
    var n = 0;
    read.rows.forEach(function (r) {
      if (r.slot && r.value.ok) n++;
    });
    read.totals.forEach(function (t) {
      if (t.value.ok) n++;
    });
    return n;
  }

  // ── Page sum ───────────────────────────────────────────────────────────────────────────────────────
  // The template's sum rule: the charge rows add up to the named total (City: Current Bill). This is the
  // proof the box re-read needs (which candidate reading is the printed one); the bills built from the
  // lines are proved again by the reader's own page check (_lbg_pageTotalCheck, app/energy-savings.js).
  // Returns { known: bool, diffCents, negative } with known=false when a slotted row or the total has no
  // value; the sum is in integer cents (a one-cent digit error is a failed sum); negative names the first
  // row outside sumRule.creditRows, or the total, that is below zero (2026-10-19 review: a whole-page sign
  // flip with a Fuel Adjustment that lost its minus adds up too, and was written once in 20000 fuzz pages).
  // Candidate meaning "this row is not printed": a row the order rule placed from a noise label with no
  // value of its own may be no row at all (a pen stroke in the label column); it is dropped when the
  // page adds up without it.
  var ABSENT = { absent: true };
  var cents = function (v) {
    return Math.round(v * 100);
  };
  function pageSum(read, tpl, values) {
    var rule = tpl.sumRule;
    if (!rule) return { known: false, diffCents: null, negative: null };
    var total = null,
      sum = 0,
      known = true,
      negative = null;
    read.rows.forEach(function (r, i) {
      if (!r.slot || r.absent) return;
      var v = values && values.rows[i] != null ? values.rows[i] : moneyValue(r.value.text);
      if (v === ABSENT) return;
      if (v == null) known = false;
      else {
        sum += cents(v);
        if (v < 0 && (rule.creditRows || []).indexOf(r.slot) === -1 && !negative) negative = r.slot;
      }
    });
    read.totals.forEach(function (t, i) {
      if (t.label !== rule.total) return;
      total = values && values.totals[i] != null ? values.totals[i] : moneyValue(t.value.text);
    });
    if (total == null) known = false;
    else if (total < 0 && !negative) negative = rule.total;
    if (!known) return { known: false, diffCents: null, negative: negative };
    return { known: true, diffCents: sum - cents(total), negative: negative };
  }
  // The page adds up: every value known, the sum equal to the total to the cent, no negative charge.
  function sumHolds(s) {
    return s.known && s.diffCents === 0 && !s.negative;
  }

  // ── Box re-read ────────────────────────────────────────────────────────────────────────────────────
  // Measured on the 37 real City pages (2026-10-19, research note 2026-10-19-ocr-accuracy-methods.md):
  // a crop of the one value cell at about 10x, tesseract page mode 7 (one line) reads 250 of 275 boxes
  // and 39 of the 59 the full-page pass got wrong; mode 8 (one word) reads none; the whitelist cuts the
  // stray letters; Otsu and padding do not help. Three readings per box give the candidate set.
  var REREAD_WHITELIST = '0123456789.,-$()';
  var REREAD_CONFIGS = [
    { zoom: 4, psm: 7, whitelist: true },
    { zoom: 4, psm: 7, whitelist: false },
    { zoom: 2, psm: 7, whitelist: true },
  ];
  // Candidate amounts in one OCR reading of a value cell. Every candidate is made of the digits OCR
  // read; the money format places a lost point before the last two digits, and both signs are tried
  // because the minus is the glyph OCR loses most. The page sum then picks the one printed value; a
  // candidate that does not make the page add up is never used.
  function candidatesFromText(txt) {
    var out = [];
    var push = function (v) {
      if (v == null || isNaN(v)) return;
      [v, -v].forEach(function (x) {
        x = Math.round(x * 100) / 100;
        if (out.indexOf(x) === -1) out.push(x);
      });
    };
    String(txt || '')
      .split(/\s+/)
      .forEach(function (tok) {
        var t = tok.replace(/[\$()\s]/g, '');
        if (!t) return;
        var forms = [t];
        // a "$" read as a digit or letter glued to the front of the amount ("82756" for $27.56)
        if (/^[8S5][\d,]/.test(t)) forms.push(t.slice(1));
        forms.forEach(function (f) {
          if (MONEY_STRICT.test(f)) {
            push(moneyValue(f));
            return;
          }
          var digits = f.replace(/[^\d]/g, '');
          if (digits.length >= 3) {
            // the point was lost: cents are the last two digits
            push(parseInt(digits.slice(0, -2), 10) + parseInt(digits.slice(-2), 10) / 100);
            // one stray digit after the cents ("24337" for 24.33)
            if (digits.length >= 4) push(parseInt(digits.slice(0, -3), 10) + parseInt(digits.slice(-3, -1), 10) / 100);
          }
          // three decimals: one stray digit after the cents ("23.337")
          var m3 = f.match(/^(-?)(\d[\d,]*)\.(\d{2})\d$/);
          if (m3) push(moneyValue(m3[1] + m3[2] + '.' + m3[3]));
        });
      });
    return out;
  }
  // Boxes to re-read. Stage 1 (all=false): every slotted row and the sum total whose value failed the
  // format; when every value is format-valid but the page sum fails, every slotted row and the total
  // (one of them is a digit misread the format cannot see, "527.56" for 27.56). Stage 2 (all=true):
  // every slotted row and the total, so a format-valid misread beside a failing cell can be found
  // ("52,719.54" for $2,719.54 next to a Fuel Adjustment read "4335"). Template data says which boxes
  // may be re-read (tpl.reread); a total with no sum proof (Total Amount Due) is never re-read.
  function rereadPlan(read, tpl, all) {
    var allow = tpl.reread || { rows: false, totals: [] };
    var plan = [];
    var s = pageSum(read, tpl);
    var allValid = read.rows.every(function (r) {
      return !r.slot || r.value.ok;
    });
    var totalValid = read.totals.every(function (t) {
      return t.label !== (tpl.sumRule && tpl.sumRule.total) || t.value.ok;
    });
    var sumFails = allValid && totalValid && s.known && !sumHolds(s);
    read.rows.forEach(function (r, i) {
      if (!r.slot || !allow.rows || !r.box) return;
      if (!r.value.ok || sumFails || all) plan.push({ kind: 'row', index: i, label: r.slot, box: r.box, was: r.value.ok ? r.value.text : r.value.raw, ok: r.value.ok });
    });
    read.totals.forEach(function (t, i) {
      if (!t.box || (allow.totals || []).indexOf(t.label) === -1) return;
      if (!t.value.ok || sumFails || all) plan.push({ kind: 'total', index: i, label: t.label, box: t.box, was: t.value.ok ? t.value.text : t.value.raw, ok: t.value.ok });
    });
    return plan;
  }
  // Re-reads the planned boxes through ocrBox(box, cfg) -> Promise<string> (the caller crops the page
  // image and runs tesseract; app/bill-analysis.js in the browser, the gate in node from its cache).
  // The reading taken for a box is the one candidate that is valid money AND makes the page sum hold,
  // with the fewest changes to format-valid values; the failing cells are re-read first, and only when
  // no combination holds are the format-valid cells re-read too (stage 2). When no combination holds,
  // or more than one does, every failing box is held with the reason (which row, what was read).
  // Mutates and returns read (a Promise).
  function rereadBoxes(read, tpl, ocrBox) {
    var stage1 = rereadPlan(read, tpl, false);
    if (!stage1.length) return Promise.resolve(read);
    var readings = {}; // box key -> [{cfg, text}]
    var keyOf = function (p) {
      return p.kind + ':' + p.index;
    };
    var collect = function (plan) {
      var chain = Promise.resolve();
      plan.forEach(function (p) {
        if (readings[keyOf(p)]) return;
        var list = (readings[keyOf(p)] = []);
        REREAD_CONFIGS.forEach(function (cfg) {
          chain = chain.then(function () {
            return Promise.resolve(ocrBox(p.box, cfg)).then(
              function (txt) {
                list.push({ cfg: cfg, text: txt == null ? '' : String(txt) });
              },
              function () {
                list.push({ cfg: cfg, text: '' });
              },
            );
          });
        });
      });
      return chain;
    };
    var describe = function (p) {
      return (
        p.label +
        ' box read "' +
        (p.was || '') +
        '" on the page and ' +
        readings[keyOf(p)]
          .map(function (r) {
            return '"' + r.text + '"';
          })
          .join(', ') +
        ' in the re-read'
      );
    };
    // The candidates of a planned box: its page value when format-valid, the page's own reading of the
    // cell ("2333" is 23.33 by the format), every re-read, and ABSENT for a row the order rule placed
    // from a noise label with no value on the page.
    var candidatesOf = function (p) {
      var list = [];
      if (p.ok) list.push(moneyValue(p.was));
      candidatesFromText(p.ok ? '' : p.was).forEach(function (v) {
        if (list.indexOf(v) === -1) list.push(v);
      });
      readings[keyOf(p)].forEach(function (r) {
        candidatesFromText(r.text).forEach(function (v) {
          if (list.indexOf(v) === -1) list.push(v);
        });
      });
      if (p.kind === 'row' && !p.was && read.rows[p.index].byOrder) list.push(ABSENT);
      return list;
    };
    // The one holding combination over plan: the failing boxes take any candidate; the format-valid
    // boxes keep their value, then (fewest changes first) up to two of them may take a re-read
    // candidate. { ok:true, values } when exactly one assignment holds at the fewest changes, else
    // { ok:false, why }.
    var solve = function (plan) {
      var cands = plan.map(candidatesOf);
      if (
        cands.some(function (c) {
          return !c.length;
        })
      )
        return { ok: false, why: 'no reading of a box is valid money, so the page sum cannot be proved' };
      var failing = [],
        valid = [];
      plan.forEach(function (p, i) {
        (p.ok ? valid : failing).push(i);
      });
      var product = function (idxs) {
        var n = 1;
        idxs.forEach(function (i) {
          n *= cands[i].length;
        });
        return n;
      };
      if (product(failing) > 20000) return { ok: false, why: 'too many candidate readings to prove by the page sum' };
      // every assignment over the boxes in `free` (others fixed to their page value) that makes the
      // page add up
      var holding = function (free) {
        if (product(free) > 20000) return [];
        var sets = [];
        var idx = free.map(function () {
          return 0;
        });
        for (;;) {
          var values = { rows: {}, totals: {} };
          var assign = plan.map(function (p) {
            return p.ok ? moneyValue(p.was) : null;
          });
          free.forEach(function (bi, k) {
            assign[bi] = cands[bi][idx[k]];
          });
          plan.forEach(function (p, i) {
            if (p.kind === 'row') values.rows[p.index] = assign[i];
            else values.totals[p.index] = assign[i];
          });
          if (sumHolds(pageSum(read, tpl, values))) sets.push(assign);
          var c = free.length - 1;
          while (c >= 0) {
            idx[c]++;
            if (idx[c] < cands[free[c]].length) break;
            idx[c] = 0;
            c--;
          }
          if (c < 0) break;
        }
        return sets;
      };
      var subsets = function (arr, size) {
        var out = [];
        var walk = function (start, chosen) {
          if (chosen.length === size) {
            out.push(chosen.slice());
            return;
          }
          for (var i = start; i < arr.length; i++) {
            chosen.push(arr[i]);
            walk(i + 1, chosen);
            chosen.pop();
          }
        };
        walk(0, []);
        return out;
      };
      var sets = [];
      for (var size = 0; size <= Math.min(2, valid.length) && !sets.length; size++) {
        subsets(valid, size).forEach(function (sub) {
          sets = sets.concat(holding(failing.concat(sub)));
        });
      }
      if (!sets.length)
        return { ok: false, why: 'no reading makes the page lines add up to the printed ' + tpl.sumRule.total + ' to the cent with no negative charge' };
      for (var b = 0; b < plan.length; b++) {
        var first = sets[0][b];
        var agree = sets.every(function (set) {
          return set[b] === first;
        });
        if (!agree) return { ok: false, why: 'more than one reading makes the page lines add up (ambiguous)' };
      }
      return { ok: true, values: sets[0] };
    };
    var apply = function (plan, values) {
      plan.forEach(function (p, i) {
        var v = values[i];
        var target = p.kind === 'row' ? read.rows[p.index] : read.totals[p.index];
        if (target.value.ok && moneyValue(target.value.text) === v) return; // unchanged
        if (v === ABSENT) target.absent = true;
        else target.value = { raw: target.value.raw, text: moneyText(v), ok: true, reread: true };
        read.rereads.push({
          label: p.label,
          was: p.was,
          readings: readings[keyOf(p)].map(function (r) {
            return r.text;
          }),
          chosen: v === ABSENT ? 'no line printed (row dropped)' : moneyText(v),
        });
      });
      read.lines = buildLines(read);
    };
    var holdFailing = function (why) {
      stage1.forEach(function (p) {
        if (p.ok) return; // a format-valid value stays as read; the reader's page check holds the page
        setHeld(read, p, describe(p) + '; ' + why);
      });
      read.lines = buildLines(read);
    };
    return collect(stage1).then(function () {
      var r1 = solve(stage1);
      if (r1.ok) {
        apply(stage1, r1.values);
        return read;
      }
      var stage2 = rereadPlan(read, tpl, true);
      if (stage2.length <= stage1.length) {
        holdFailing(r1.why);
        return read;
      }
      return collect(stage2).then(function () {
        var r2 = solve(stage2);
        if (r2.ok) apply(stage2, r2.values);
        else holdFailing(r2.why);
        return read;
      });
    });
  }
  function setHeld(read, p, reason) {
    var target = p.kind === 'row' ? read.rows[p.index] : read.totals[p.index];
    target.value = { raw: target.value.raw, text: null, ok: false, held: reason };
    read.held.push({ label: p.label, reason: reason.replace(/\s+/g, ' ') });
  }

  // ── Entry for app/bill-analysis.js ─────────────────────────────────────────────────────────────────
  // passes: the page's OCR passes [{label, score, words, w, h}]. Every template is tried on every pass that
  // has word boxes; the read with the most format-valid values wins (ties: more anchors, then the pass
  // score). Returns { ok:true, read, pass, template } or { ok:false, reason }.
  function readBestPass(passes) {
    var best = null,
      reasons = [];
    (passes || []).forEach(function (p) {
      if (!p || !p.words || !p.words.length || !(p.w > 0 && p.h > 0)) return;
      TEMPLATES.forEach(function (tpl) {
        var r = readPageByTemplate(p.words, { w: p.w, h: p.h }, tpl);
        if (!r.ok) {
          reasons.push((p.label || '?') + ' ' + r.reason);
          return;
        }
        var n = okCount(r);
        if (
          !best ||
          n > best.n ||
          (n === best.n && r.anchorCount > best.read.anchorCount) ||
          (n === best.n && r.anchorCount === best.read.anchorCount && (p.score || 0) > (best.pass.score || 0))
        )
          best = { read: r, pass: p, n: n, tpl: tpl };
      });
    });
    if (best) return { ok: true, read: best.read, pass: best.pass, template: best.tpl };
    if (!reasons.length) return { ok: false, reason: 'no OCR pass with word boxes' };
    var seen = {};
    return {
      ok: false,
      reason: reasons
        .filter(function (r) {
          var key = r.replace(/^\S+\s/, '');
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        })
        .join('; '),
    };
  }
  // The crop of one value cell from the page render for the box re-read (app/bill-analysis.js). box is in
  // the winning pass's pixels (pass.w x pass.h); oriented is the page render turned as that pass was
  // ({width, height}: a 90/270 turn swaps them, a 180 turn does not). Returns the crop as fractions of
  // the oriented render and the scale that brings the crop to cfg zoom (the render is oriented.width /
  // pass.w times the pass). 2026-10-19 review: the 180 case used the render height, a wrong zoom.
  function rereadCrop(box, pass, oriented, zoom) {
    var have = oriented.width / pass.w;
    return {
      x: box.x0 / pass.w,
      y: box.y0 / pass.h,
      w: (box.x1 - box.x0) / pass.w,
      h: (box.y1 - box.y0) / pass.h,
      scale: zoom / have,
    };
  }
  // The ONE page read: best pass, then the box re-read of the failing value cells when the caller gives
  // ocrBox(box, cfg) -> Promise<string> for the winning pass (box in that pass's pixels). Without ocrBox
  // the failing cells stay empty (the reader's page check holds the page). Returns a Promise of the
  // readBestPass shape.
  function readPage(passes, ocrBox) {
    var res = readBestPass(passes);
    if (!res.ok || typeof ocrBox !== 'function') return Promise.resolve(res);
    return rereadBoxes(res.read, res.template, function (box, cfg) {
      return ocrBox(box, cfg, res.pass);
    }).then(function () {
      return res;
    });
  }
  // The text block appended to the page's OCR text. A held cell is announced on its own marker line
  // BEFORE the block (never inside the rows, whose lines the reader parses for labels and amounts).
  function linesBlock(read, passLabel) {
    var head =
      MARK.start +
      ' template=' +
      read.template +
      ' pass=' +
      (passLabel || '') +
      ' anchors=' +
      Object.keys(read.anchors).join(',');
    var held = (read.held || [])
      .map(function (h) {
        return MARK.held + ' ' + h.label + ':: ' + h.reason.replace(/\s+/g, ' ') + '\n';
      })
      .join('');
    return '\n' + held + head + '\n' + read.lines.join('\n') + '\n' + MARK.end + '\n';
  }
  function fallbackMarker(reason) {
    return (
      '\n' +
      MARK.fallback +
      ' ' +
      String(reason || '')
        .replace(/\s+/g, ' ')
        .trim() +
      '\n'
    );
  }
  // Compact record for the debug file: no word boxes.
  function debugRecord(res) {
    if (!res.ok) return { mode: 'text', reason: res.reason };
    return {
      mode: 'position',
      template: res.read.template,
      pass: res.pass.label,
      anchors: Object.keys(res.read.anchors),
      fit: res.read.fit,
      rows: res.read.rows.map(function (r) {
        return {
          slot: r.slot,
          byOrder: r.byOrder,
          label: r.labelRaw,
          value: r.value.text != null ? r.value.text : r.value.raw,
          ok: r.value.ok,
          reread: !!r.value.reread,
          absent: !!r.absent,
          held: r.value.held || null,
          reads: [r.reads.prev.raw, r.reads.curr.raw, r.reads.usage.raw],
        };
      }),
      totals: res.read.totals.map(function (t) {
        return { label: t.label, value: t.value.text != null ? t.value.text : t.value.raw, ok: t.value.ok, reread: !!t.value.reread, held: t.value.held || null };
      }),
      rereads: res.read.rereads,
      held: res.read.held,
      lines: res.read.lines,
    };
  }

  return {
    MARK: MARK,
    TEMPLATES: TEMPLATES,
    CITY_NEW: CITY_NEW,
    MONEY_STRICT: MONEY_STRICT,
    REREAD_CONFIGS: REREAD_CONFIGS,
    REREAD_WHITELIST: REREAD_WHITELIST,
    wordsFromOcr: wordsFromOcr,
    normLabel: normLabel,
    labelDistance: labelDistance,
    matchTemplate: matchTemplate,
    readPageByTemplate: readPageByTemplate,
    candidatesFromText: candidatesFromText,
    rereadPlan: rereadPlan,
    rereadBoxes: rereadBoxes,
    pageSum: pageSum,
    sumHolds: sumHolds,
    rereadCrop: rereadCrop,
    readBestPass: readBestPass,
    readPage: readPage,
    linesBlock: linesBlock,
    fallbackMarker: fallbackMarker,
    debugRecord: debugRecord,
  };
});
