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
  // cropCells: page-fraction crops for the targeted-crop fallback in app/bill-analysis.js (the former
  //   _lbgCells). Phase 3 replaces them with the row value boxes of this template.
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
    totals: [
      { label: 'Current Bill', anchor: 'currentBill' },
      { label: 'Total Amount Due', anchor: 'totalDue' },
    ],
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
  var READ_STRICT = /^\d{1,3}(?:,\d{3})*$|^\d+$/;
  var USAGE_STRICT = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/;
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
  // and the page sum check holds the page.
  function valueWords(ws) {
    return ws.filter(function (w) {
      return /\d/.test(w.t) || /^[-¢$()]+$/.test(w.t);
    });
  }
  function moneyCell(ws) {
    ws = valueWords(ws);
    var raw = cellText(ws);
    if (!raw) return { raw: '', text: null, ok: false };
    var tight = raw.replace(/\s+/g, '');
    if (MONEY_STRICT.test(tight)) return { raw: raw, text: tight, ok: true };
    return { raw: raw, text: raw, ok: false };
  }
  function numCell(ws, re) {
    var raw = cellText(ws);
    if (!raw) return { raw: '', text: null, ok: false };
    var tight = raw.replace(/\s+/g, '');
    return { raw: raw, text: tight, ok: re.test(tight) };
  }

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────
  // Reads one page with one template. Returns
  //   { ok:false, reason } or
  //   { ok:true, template, fit, anchors, rows:[{slot, labelRaw, value:{raw,text,ok}, reads:{prev,curr,usage}, y}],
  //     totals:[{label, value, found}], lines:[...] }
  // rows are the charge rows in print order; a row with no slot keeps its raw label (the reader's own
  // label regexes then get a chance). lines are the normalized text lines for the reader
  // ("4,396,336 4,451,372 55,036 WATER 514.08", "FUEL ADJUSTMENT 29.45", "Current Bill $1,851.57").
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
    var sameBand = function (band) {
      return function (w) {
        if (used[words.indexOf(w)]) return false;
        var o = Math.min(band.y1, w.y1) - Math.max(band.y0, w.y0);
        return o >= 0.5 * Math.min(w.y1 - w.y0, band.y1 - band.y0);
      };
    };
    // Totals first: the amount-column words on each found floating anchor's own row. A total whose
    // label was not found has no value (it floats, so its row is not known; never guessed).
    var totals = tpl.totals.map(function (t) {
      var box = m.anchors[t.anchor];
      if (!box) return { label: t.label, value: { raw: '', text: null, ok: false }, found: false };
      var ws = words.filter(sameBand(box)).filter(function (w) {
        return inCol(w, 'amount');
      });
      markUsed(ws);
      return { label: t.label, value: moneyCell(ws), found: true };
    });
    // Bands: label-column words grouped by print line, then amount-column words with digits and no label.
    var labelWords = words.filter(function (w) {
      return inRegion(w) && inCol(w, 'label') && !used[words.indexOf(w)];
    });
    var bands = groupLines(labelWords).map(function (l) {
      return { labelWords: l.words, box: l.box };
    });
    bands.forEach(function (b) {
      markUsed(b.labelWords);
    });
    words
      .filter(function (w) {
        return inRegion(w) && inCol(w, 'amount') && !used[words.indexOf(w)] && /\d/.test(w.t);
      })
      .forEach(function (w) {
        var hit = bands.filter(function (b) {
          return sameBand(b.box)(w);
        });
        if (!hit.length) {
          bands.push({ labelWords: [], box: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 } });
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
      var amountWords = words.filter(sameBand(b.box)).filter(function (w) {
        return (
          inCol(w, 'amount') ||
          (w.x1 >= col.amount[0] && w.x0 >= col.label[0] && cx(w) > col.label[1] - 0.3 * (col.label[1] - col.label[0]))
        );
      });
      markUsed(amountWords);
      var value = moneyCell(amountWords);
      if (swallowed && !amountWords.length) {
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
        byOrder: false,
      });
    });
    // Order rule: a row with no slot takes the one slot that lies between its assigned neighbours.
    rows.forEach(function (r, i) {
      if (r.slot || (!r.labelRaw && !r.value.text)) return;
      var above = -1,
        below = tpl.slots.length;
      for (var a = i - 1; a >= 0; a--)
        if (rows[a].slot) {
          above = tpl.slots.indexOf(rows[a].slot);
          break;
        }
      for (var b = i + 1; b < rows.length; b++)
        if (rows[b].slot) {
          below = tpl.slots.indexOf(rows[b].slot);
          break;
        }
      var between = [];
      for (var k = above + 1; k < below; k++) between.push(tpl.slots[k]);
      if (between.length === 1) {
        r.slot = between[0];
        r.byOrder = true;
      }
    });
    var lines = [];
    rows.forEach(function (r) {
      if (!r.value.text && !r.slot) return;
      var parts = [];
      ['prev', 'curr', 'usage'].forEach(function (k) {
        if (r.reads[k].text) parts.push(r.reads[k].text);
      });
      parts.push(r.slot || r.labelRaw);
      if (r.value.text) parts.push(r.value.text);
      lines.push(parts.join(' ').trim());
    });
    totals.forEach(function (t) {
      if (t.value.text) lines.push(t.label + ' ' + t.value.text);
    });
    return {
      ok: true,
      template: tpl.id,
      fit: fit,
      anchors: m.anchors,
      anchorCount: m.found,
      rows: rows,
      totals: totals,
      lines: lines,
    };
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

  // ── Entry for app/bill-analysis.js ─────────────────────────────────────────────────────────────────
  // passes: the page's OCR passes [{label, score, words, w, h}]. Every template is tried on every pass that
  // has word boxes; the read with the most format-valid values wins (ties: more anchors, then the pass
  // score). Returns { ok:true, read, pass } or { ok:false, reason }.
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
          best = { read: r, pass: p, n: n };
      });
    });
    if (best) return { ok: true, read: best.read, pass: best.pass };
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
  // The text block appended to the page's OCR text.
  function linesBlock(read, passLabel) {
    var head =
      MARK.start +
      ' template=' +
      read.template +
      ' pass=' +
      (passLabel || '') +
      ' anchors=' +
      Object.keys(read.anchors).join(',');
    return '\n' + head + '\n' + read.lines.join('\n') + '\n' + MARK.end + '\n';
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
          value: r.value.raw,
          ok: r.value.ok,
          reads: [r.reads.prev.raw, r.reads.curr.raw, r.reads.usage.raw],
        };
      }),
      totals: res.read.totals.map(function (t) {
        return { label: t.label, value: t.value.raw, ok: t.value.ok };
      }),
      lines: res.read.lines,
    };
  }

  return {
    MARK: MARK,
    TEMPLATES: TEMPLATES,
    CITY_NEW: CITY_NEW,
    wordsFromOcr: wordsFromOcr,
    normLabel: normLabel,
    labelDistance: labelDistance,
    matchTemplate: matchTemplate,
    readPageByTemplate: readPageByTemplate,
    readBestPass: readBestPass,
    linesBlock: linesBlock,
    fallbackMarker: fallbackMarker,
    debugRecord: debugRecord,
  };
});
