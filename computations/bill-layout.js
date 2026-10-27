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
    // dollar: true = the cell always prints a leading "$" ("dollarCells" lists every such cell of the
    // layout; Payments prints "($x)"). A leading 8, S, 5 or section sign in front of a valid amount is the
    // "$" glyph and text after the cents is noise (dollarCellValue). One rule, read from the template.
    totals: [
      { label: 'Current Bill', anchor: 'currentBill', dollar: true },
      { label: 'Total Amount Due', anchor: 'totalDue', dollar: true },
    ],
    dollarCells: [
      'Previous Balance',
      'Payments',
      'Adjustments',
      'Penalty',
      'Past Due Amount',
      'Current Bill',
      'Total Amount Due',
      'Amount Due After',
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
  // Utility E "Billing Details" page (page 2 or 3 of a bill; every 2026 scan of the client). Reference
  // render 1530 x 1980 px (PyMuPDF 2.5x of a letter page; the browser 2.5x pass is 1520 x 1970 and fits).
  // The FIXED anchors are the page frame: the Customer Name / Account Number / Billing Date header at the
  // top and the Contact Information Change Form at the bottom (a scan that cuts the form fits on the header
  // alone; two anchors are enough). The Billing Details block FLOATS: a Payment Details table above it
  // pushes it down by 230 px, so its header, Subtotal, Current Charges and the meter table header under it
  // are located by their text in their own column after the fit (required: a page without a Billing
  // Details header is not this page). The charge-row band runs from the Billing Details header to the
  // Current Charges label; when that label was not read, to the meter table header (stopAnchors).
  // Rows are a LIST (rowMode 'list'), not fixed slots: a charge line is the label-column words of one
  // print line plus the continuation lines above it (a two-line label carries its amount on the second
  // line), and its KIND comes from a fuzzy match of the leading words against `kinds` (the label slot sets
  // the label: "CUSIOMET CRG" at the start of a row is Customer Chg; a run that is as close to two kinds
  // is no kind). A row whose kind is unknown keeps its raw label. Two printed identities prove the page
  // (sumRule, proved per group by the box re-read): the charge rows add up to the Subtotal; Subtotal plus
  // the rows below it (franchise fee, sales taxes) equals Current Charges. Bill offset and a solar credit
  // are the rows printed negative. Current Charges is read ONLY from its printed box: when the box is
  // missing or unreadable the total is held with the reason (never the Subtotal, never a sum). A Subtotal
  // or Current Charges whose LABEL OCR lost is still found when a label-less amount satisfies its identity
  // to the cent (findTotalsByStructure). The lines handed to the reader keep the "$" the page prints
  // (moneyPrefix): "Customer Chg $102.86", "Bill offset -$863.35".
  var UTILITY_E_BD = {
    id: 'utility-e-bd',
    ref: { w: 1530, h: 1980 },
    anchors: [
      { id: 'custName', text: 'Customer Name', box: [68, 162, 206, 178] },
      { id: 'acctNum', text: 'Account Number', box: [68, 189, 215, 205] },
      { id: 'billingDate', text: 'Billing Date', box: [1263, 235, 1352, 252] },
      { id: 'contact', text: 'Contact Information Change Form', box: [525, 1570, 980, 1593] },
      { id: 'mailing', text: 'Mailing Address changes only', box: [98, 1742, 360, 1765] },
      { id: 'email', text: 'E-mail Address (optional)', box: [98, 1901, 370, 1918] },
      { id: 'billingDetails', text: 'Billing Details', box: [794, 348, 974, 376], floating: true, required: true },
      { id: 'subtotal', text: 'Subtotal', box: [797, 962, 878, 980], floating: true },
      { id: 'currentCharges', text: 'Current Charges', box: [797, 998, 994, 1024], floating: true },
      { id: 'meterHeader', text: 'Multiplier', box: [889, 1162, 960, 1180], floating: true },
    ],
    columns: {
      label: [785, 1292],
      amount: [1296, 1460],
    },
    chargeRows: { yTop: 180, topAnchor: 'billingDetails', yBottom: 1540, bottomAnchor: 'currentCharges', stopAnchors: ['meterHeader'] },
    rowMode: 'list',
    // field: the extractor field (app/energy-savings.js _extractUtility E result) the line belongs to;
    // anywhere: the phrase may follow a jurisdiction prefix ("<City> Franchise Fee", "Kansas State Sales Tax")
    kinds: [
      { field: 'CustomerCharge', text: 'Customer Chg' },
      { field: 'FacilitiesCharge', text: 'Facilities Chg' },
      { field: 'BilledKWCharge', text: 'Demand Chg' },
      { field: 'EnergyOnPeakCharge', text: 'Energy Chg On Pk' },
      { field: 'EnergyOffPeakCharge', text: 'Energy Chg Off Pk' },
      { field: 'RkVACharge', text: 'RkVA Chg' },
      { field: 'TaxExemptDelivery', text: 'Tax exempt delivery cost from bill' },
      { field: 'ECACharge', text: 'ECA Chg' },
      { field: 'EERCharge', text: 'EER Chg' },
      { field: 'PTSCharge', text: 'PTS Chg' },
      { field: 'TDCCharge', text: 'TDC Chg' },
      { field: 'BillOffset', text: 'Bill offset' },
      { field: 'SolarCredit', text: 'Parallel Generation Credit' },
      { field: 'FranchiseFee', text: 'Franchise Fee', anywhere: true, below: true },
      { field: 'SalesTax', text: 'Sales Tax', anywhere: true, below: true },
    ],
    rowPitch: 33.5,
    totals: [
      { label: 'Subtotal', anchor: 'subtotal', field: '_subtotal' },
      { label: 'Current Charges', anchor: 'currentCharges', field: 'TotalCurrentCharges' },
    ],
    // creditRows name the row slots (the kind fields) that may print negative.
    sumRule: { subtotal: 'Subtotal', total: 'Current Charges', creditRows: ['BillOffset', 'SolarCredit'] },
    reread: { rows: true, totals: ['Subtotal', 'Current Charges'] },
    moneyPrefix: '$',
    // The page prints every amount as "$1,011.31" or "-$863.35": a cell without the "$", or with a sign
    // after the figure, is not a printed amount and is re-read and proved (never taken as valid).
    moneyFormat: /^-?\$(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/,
  };
  // ── Field format facts (data; one vocabulary for every layout) ──
  // Each fact below was checked on 3 or more real pages (2026-10-20 ground-truth check). A layout names
  // its facts per reader field in `fieldFormats`:
  //   decimals  digits after the point: n, or [lo, hi] (an exact count prints the same on every page)
  //   digits    count of integer digits [lo, hi]
  //   credit    how a negative amount prints: 'never' (the cell never prints negative), 'lead' (leading minus),
  //             'trail' (trailing minus, "2.04-"), 'CR' (suffix "CR", "0.48CR"); the reader stores the sign
  //   suffix    text that always follows the figure (a gas-utility payment prints "569.28CR"; the reader stores
  //             the figure positive)
  //   glyph     '$' every printed figure of the field has the "$" prefix, 'none' no figure has it, 'first' only
  //             the first line of its block has it
  // app/energy-savings.js _lbg_autofix drops every one-digit repair of a scanned figure that breaks the
  // field's format (a repair of "2.5" to 52.5 is not a 2-decimal amount). Layouts that have no position
  // template yet (gas utility, second city, gas supplier) carry only `fieldFormats`: no anchors until a real page proves them.
  var MONEY = { decimals: 2, credit: 'never' };
  var MONEY_CREDIT = { decimals: 2, credit: 'lead' };
  CITY_NEW.fieldFormats = {
    WaterCharge: MONEY,
    WaterProtectionFee: MONEY,
    SewerCharge: MONEY,
    StormWaterCharge: MONEY,
    FuelAdjustment: MONEY_CREDIT, // 25 of 25 pages print it negative
    CurrentBill: MONEY,
    TotalAmountDue: MONEY,
    NaturalGasTherms: { decimals: [0, 3], credit: 'never' }, // 29 pages: 0 to 3 decimals by account
  };
  UTILITY_E_BD.fieldFormats = {
    CustomerCharge: MONEY,
    FacilitiesCharge: MONEY,
    BilledKWCharge: MONEY,
    EnergyOnPeakCharge: MONEY,
    EnergyOffPeakCharge: MONEY,
    RkVACharge: MONEY,
    TaxExemptDelivery: MONEY,
    ECACharge: MONEY,
    EERCharge: MONEY,
    PTSCharge: MONEY,
    TDCCharge: MONEY,
    FranchiseFee: MONEY,
    SalesTax: MONEY,
    BillOffset: MONEY_CREDIT, // 35 of 35 pages print it negative
    SolarCredit: MONEY_CREDIT,
    TotalCurrentCharges: MONEY,
    kWhConsumed: { decimals: 4, credit: 'never' }, // 337 of 337 quantity labels print 4 decimals
    BilledKW: { decimals: 4, credit: 'never' },
    NumberOfDays: { decimals: 0, digits: [2, 2], credit: 'never' }, // 30 pages: 2 digits
  };
  // Money cells by the "$" they print (2026-10-21 check of the real pages: the "$" is not the same in every layout).
  var MONEY_NO_GLYPH = { decimals: 2, credit: 'never', glyph: 'none' };
  var MONEY_GLYPH = { decimals: 2, credit: 'never', glyph: '$' };
  var KGS_FACTS = {
    id: 'kgs',
    fieldFormats: {
      CustomerCharge: { decimals: 2, credit: 'never', glyph: 'first' }, // "$32.20" on the first charge line only
      DeliveryCharge: MONEY_NO_GLYPH,
      GasSystemReliability: { decimals: 2, credit: 'CR', glyph: 'none' }, // a credit month prints "0.48CR", never a minus
      WeatherNormalization: { decimals: 2, credit: 'CR', glyph: 'none' },
      GasCharge: MONEY_NO_GLYPH,
      WinterEventCost: MONEY_NO_GLYPH,
      FranchiseFee: MONEY_NO_GLYPH,
      DelayedPaymentCharge: MONEY_NO_GLYPH,
      PreviousBalance: MONEY_GLYPH,
      PaymentsReceived: { decimals: 2, credit: 'never', suffix: 'CR', glyph: 'none' }, // "569.28CR"
      TotalCurrentCharges: MONEY_GLYPH,
      // Prints "Total Amount Due" in the charges block only. The top block and the stub print "Amount Due"
      // (same figure). "Current Charges Due" is a date, "Amount Due After Due Date" is a larger figure.
      TotalAmountDue: MONEY_GLYPH,
      McfBilled: { decimals: 3, credit: 'never' },
      WNAPerMcf: { decimals: 4, credit: 'never', glyph: '$' },
      CostOfGasPerMcf: { decimals: 4, credit: 'never', glyph: 'none' },
      NumberOfDays: { decimals: 0, digits: [2, 2], credit: 'never' },
      // A 4-dial meter prints without leading zeros ("590" for 0590): 1 to 4 digits.
      MeterReadPrevious: { decimals: 0, digits: [1, 4], credit: 'never' },
      MeterReadCurrent: { decimals: 0, digits: [1, 4], credit: 'never' },
    },
  };
  var BALDWIN_FACTS = {
    id: 'baldwin',
    fieldFormats: {
      WaterCharge: MONEY_NO_GLYPH, // no "$" anywhere on the page
      SewerCharge: MONEY_NO_GLYPH,
      WaterDebtPayment: MONEY_NO_GLYPH,
      WaterFranchiseFee: MONEY_NO_GLYPH,
      SewerFranchiseFee: MONEY_NO_GLYPH,
      FuelAdjustment: { decimals: 2, credit: 'trail', glyph: 'none' }, // "2.04-" and ".57-"
      TotalAmountDue: MONEY_NO_GLYPH,
    },
  };
  var WRE_FACTS = {
    id: 'wre',
    fieldFormats: {
      _wreTriggerCharge: MONEY_GLYPH,
      _wreIndexCharge: MONEY_GLYPH,
      _wreSWECharge: { decimals: 2, glyph: '$' }, // credit sign not yet seen on a real page
      GasCharge: MONEY_GLYPH,
      _wreTriggerMMbtu: MONEY_NO_GLYPH,
      _wreIndexMMbtu: MONEY_NO_GLYPH,
      _wreTriggerFuelMMbtu: MONEY_NO_GLYPH,
      _wreIndexFuelMMbtu: MONEY_NO_GLYPH,
      _wreTriggerRate: { decimals: 4, credit: 'never', glyph: '$' }, // "$5.2650"
      _wreIndexRate: { decimals: 4, credit: 'never', glyph: '$' },
    },
  };
  var LAYOUT_FACTS = {
    'city-new': CITY_NEW,
    'utility-e-bd': UTILITY_E_BD,
    kgs: KGS_FACTS,
    baldwin: BALDWIN_FACTS,
    wre: WRE_FACTS,
  };
  // The format of one reader field in one layout, or null. The one reader of the facts above.
  function fieldFormat(layoutId, field) {
    var l = LAYOUT_FACTS[layoutId];
    return (l && l.fieldFormats && l.fieldFormats[field]) || null;
  }
  var TEMPLATES = [CITY_NEW, UTILITY_E_BD];

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
    var missing = null;
    tpl.anchors
      .filter(function (a) {
        return a.floating;
      })
      .forEach(function (a) {
        var hits = findAnchorCandidates(lines, a.text).filter(function (c) {
          return Math.abs(c.box.x0 - (fit.s * a.box[0] + fit.ox)) <= 0.03 * pageW && cy(c.box) > top;
        });
        if (hits.length) anchors[a.id] = hits[0].box;
        else if (a.required && !missing) missing = a;
      });
    // A required floating anchor names the page (the "Billing Details" header of the Utility E page):
    // without it the frame fit alone is not this page.
    if (missing) return { ok: false, reason: tpl.id + ': "' + missing.text + '" not found on the page', found: best.chosen.length };
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
  // fmt: the template's own money format (tpl.moneyFormat), else MONEY_STRICT.
  // A cell the layout says always prints a leading "$" (template field flag `dollar`). The first glyph is
  // the "$" when it is "$", "8", "S", "5", a section sign or "s" AND the rest is an amount (digits with
  // thousands commas, 2 cents); text after the cents is noise. A "(" or "|" in front is noise; "(...)" with
  // the bracket right after the cents (Payments) and a "¢" or "-" in front or behind are negative. Returns
  // the number or null. "(83,572.97 7)" -> 3572.97; "(82,541.03)" -> -2541.03; "8,572.97" -> 8572.97
  // (the rest ",572.97" is no amount, so no glyph is dropped).
  var DOLLAR_BODY = /^(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/;
  function dollarCellValue(text) {
    var s = String(text == null ? '' : text).replace(/^[\s(|]+/, '');
    var neg = false;
    var lead = s.match(/^[-¢]\s*/);
    if (lead) {
      neg = true;
      s = s.slice(lead[0].length);
    }
    var body = s;
    if (/^[$8S5§s]/.test(s) && DOLLAR_BODY.test(s.slice(1))) body = s.slice(1);
    var m = body.match(DOLLAR_BODY);
    if (!m) return null;
    var after = body.slice(m[0].length);
    if (/^\s*[)-]/.test(after)) neg = true;
    var v = parseFloat(m[0].replace(/,/g, ''));
    return neg ? -v : v;
  }
  function moneyCell(ws, fmt, dollar) {
    fmt = fmt || MONEY_STRICT;
    ws = valueWords(ws);
    var raw = cellText(ws);
    if (!raw) return { raw: '', text: null, ok: false };
    var tight = raw.replace(/\s+/g, '');
    // A dollar cell that fails the page format: the glyph and the noise are known (dollarCellValue).
    if (dollar && !fmt.test(tight)) {
      var dv = dollarCellValue(raw);
      if (dv != null) return { raw: raw, text: moneyText(dv), ok: true, dollarRepair: true };
    }
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
    if (digitWords.length >= 2 && fmt.test(digitWords[digitWords.length - 1].t.replace(/\s+/g, ''))) return { raw: raw, text: null, ok: false };
    if (fmt.test(tight)) return { raw: raw, text: tight, ok: true };
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
    // When the bottom anchor was not read, a found stop anchor (the meter table header under the Utility E
    // block) closes the band above it, so the table's numbers are never rows.
    if (!m.anchors[tpl.chargeRows.bottomAnchor])
      (tpl.chargeRows.stopAnchors || []).forEach(function (id) {
        if (m.anchors[id] && m.anchors[id].y0 > top) bottom = Math.min(bottom, m.anchors[id].y0);
      });
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
    // An amount-cell word: in the amount column, or one that starts in the right part of the label column
    // and reaches into the amount column (a dot leader OCR glued to the amount: ".....msssss $5,231.52").
    var reachesAmount = function (w) {
      return (
        inCol(w, 'amount') ||
        (w.x1 >= col.amount[0] && w.x0 >= col.label[0] && cx(w) > col.label[1] - 0.3 * (col.label[1] - col.label[0]))
      );
    };
    // Totals first: the amount-cell words on each found floating anchor's own row. A total whose
    // label was not found has no value (it floats, so its row is not known; never guessed).
    var totals = tpl.totals.map(function (t) {
      var box = m.anchors[t.anchor];
      if (!box) return { label: t.label, value: { raw: '', text: null, ok: false }, found: false, box: null };
      var ws = words.filter(sameBand(box)).filter(reachesAmount);
      markUsed(ws);
      return { label: t.label, value: moneyCell(ws, tpl.moneyFormat, t.dollar), found: true, box: cellBox(cy(box)), y: Math.round(cy(box)), dollar: !!t.dollar };
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
      return reachesAmount(w);
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
    // A band that is a page total or an anchor is not a charge row. In list mode only the floating
    // anchors count (a fixed header phrase is never in the band; "Customer Chg" must not be mistaken for
    // "Customer Name").
    var anchorTexts = tpl.anchors
      .filter(function (a) {
        return tpl.rowMode !== 'list' || a.floating;
      })
      .map(function (a) {
        return a.text;
      });
    var isTotalText = function (txt) {
      return totalLabels.concat(anchorTexts).some(function (t) {
        return labelDistance(txt, t) >= 0;
      });
    };
    if (tpl.rowMode === 'list')
      return readListRows(words, pageSize, tpl, m, {
        bands: bands,
        totals: totals,
        pitch: pitch,
        isTotalText: isTotalText,
        cellBox: cellBox,
        markUsed: markUsed,
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
      if (isTotalText(labelRaw)) return;
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
  // ── List rows (rowMode 'list': the Utility E Billing Details block) ──────────────────────────────
  // The kind printed at the start of a band: every run of 1..n+1 words from the first word that carries a
  // letter (a stray mark before the label is skipped; an `anywhere` kind may start at any word) whose
  // folded text is the kind text within the allowed edits. The unique smallest distance wins; a run as
  // close to two kinds ("ECR Chg" between ECA and EER) is no kind, never a guess. A kind of two or more
  // words whose FIRST word OCR lost ("Chg On Pk Sum" for "Energy Chg On Pk") is still that kind when the
  // rest of its words (five or more letters, so "Chg" alone names nothing) match at the band start; it
  // counts one edit more than a full match, so a full match always wins.
  function kindOfBand(ws, kinds) {
    var first = 0;
    while (first < ws.length && !/[A-Za-z]/.test(ws[first].t)) first++;
    var best = null,
      bestD = Infinity,
      tie = false;
    var consider = function (k, s, n, want, penalty) {
      var joined = '';
      for (var r = 0; r < n + 1 && s + r < ws.length; r++) {
        joined += ws[s + r].t;
        var d = editDistance(normLabel(joined), want);
        if (d > allowedEdits(want.length)) continue;
        d += penalty;
        if (d < bestD) {
          bestD = d;
          best = { kind: k, start: s, end: s + r + 1 };
          tie = false;
        } else if (d === bestD && best && best.kind !== k) tie = true;
      }
    };
    kinds.forEach(function (k) {
      var parts = k.text.split(/\s+/);
      var want = normLabel(k.text);
      var starts = [];
      if (k.anywhere) for (var i = 0; i < ws.length; i++) starts.push(i);
      else if (first < ws.length) starts.push(first);
      starts.forEach(function (s) {
        consider(k, s, parts.length, want, 0);
        if (!k.anywhere && parts.length >= 2) {
          var tail = normLabel(parts.slice(1).join(' '));
          if (tail.length >= 5) consider(k, s, parts.length - 1, tail, 1);
        }
      });
    });
    return tie ? null : best;
  }
  // Rows of a list page. A band that starts a kind opens a row; a band with no kind continues the open
  // row (the second line of a two-line label) unless that row already has a format-valid amount, in
  // which case it opens a row of its own (a label OCR lost, or noise). The amount of a row is the amount
  // cell of the band that carries digits; a later valid amount replaces a garbled one (a stray "2s" on
  // the first line of a two-line label is not the amount printed on its second line). A band on the row
  // of a found floating anchor (Subtotal, Current Charges) is that total by position, never a row; so is
  // a band whose text is a total label. Rows under the Subtotal are `below` (franchise fee, sales
  // taxes). Returns the read.
  function readListRows(words, pageSize, tpl, m, ctx) {
    var bands = ctx.bands,
      totals = ctx.totals;
    var anchorBoxes = tpl.anchors
      .filter(function (a) {
        return a.floating && m.anchors[a.id];
      })
      .map(function (a) {
        return m.anchors[a.id];
      });
    var onAnchorRow = function (b) {
      return anchorBoxes.some(function (box) {
        var o = Math.min(box.y1, b.box.y1) - Math.max(box.y0, b.box.y0);
        return o >= 0.5 * Math.min(box.y1 - box.y0, b.box.y1 - b.box.y0);
      });
    };
    var rowsRaw = [];
    var cur = null;
    bands.forEach(function (b) {
      if ((b.labelWords.length && ctx.isTotalText(cellText(b.labelWords))) || onAnchorRow(b)) {
        ctx.markUsed(b.amountWords);
        return;
      }
      var k = b.labelWords.length ? kindOfBand(b.labelWords, tpl.kinds) : null;
      var digitAmt = valueWords(b.amountWords).some(function (w) {
        return /\d/.test(w.t);
      });
      if (!cur || k || (cur.amtBand && cur.amtOk)) {
        cur = { bands: [], kind: null, kindBand: -1, amtBand: null, amtOk: false };
        rowsRaw.push(cur);
      }
      if (k && !cur.kind) {
        cur.kind = k;
        cur.kindBand = cur.bands.length;
      }
      cur.bands.push(b);
      if (digitAmt && (!cur.amtBand || !cur.amtOk)) {
        cur.amtBand = b;
        cur.amtOk = moneyCell(b.amountWords, tpl.moneyFormat).ok;
      }
    });
    var rows = [];
    rowsRaw.forEach(function (r) {
      var all = [];
      var parts = [];
      r.bands.forEach(function (b, bi) {
        b.labelWords.forEach(function (w, wi) {
          all.push(w);
          if (r.kind && bi === r.kindBand) {
            if (wi === r.kind.start) parts.push(r.kind.kind.text);
            if (wi >= r.kind.start && wi < r.kind.end) return;
          }
          // a dot leader or a stray mark carries no letter and no digit: not part of the label
          if (/[A-Za-z0-9]/.test(w.t)) parts.push(w.t);
        });
      });
      var amountWords = r.amtBand ? r.amtBand.amountWords : [];
      ctx.markUsed(amountWords);
      var value = moneyCell(amountWords, tpl.moneyFormat);
      if (!parts.length && !value.raw) return; // nothing printed here
      var yBand = r.amtBand || r.bands[r.bands.length - 1];
      var empty = { raw: '', text: null, ok: false };
      rows.push({
        slot: r.kind ? r.kind.kind.field : null,
        kind: r.kind ? r.kind.kind.text : null,
        labelRaw: cellText(all),
        labelText: parts.join(' '),
        value: value,
        reads: { prev: empty, curr: empty, usage: empty },
        y: Math.round(cy(yBand.box)),
        box: ctx.cellBox(cy(yBand.box)),
        byOrder: false,
        below: false,
      });
    });
    var read = {
      ok: true,
      template: tpl.id,
      listMode: true,
      fit: m.fit,
      anchors: m.anchors,
      anchorCount: m.found,
      rows: rows,
      totals: totals,
      held: [],
      rereads: [],
      lines: [],
    };
    findTotalsByStructure(read, tpl);
    kindsByOrder(read, tpl);
    read.lines = buildLines(read);
    return read;
  }
  // The order rule of the list page (the City rule for a slot whose label OCR lost): the kinds print in
  // the order of `kinds`. A charge row (above the Subtotal) with no kind, a value on the page, a row of a
  // known kind above it and one below it (or the Subtotal), takes the ONE kind that lies strictly between
  // those two in the print order ("Chg 36.1680 kW at $11.54 per kW" between Facilities Chg and Energy Chg
  // On Pk is Demand Chg). Two or more kinds between them, or none: the row keeps its raw label.
  function kindsByOrder(read, tpl) {
    var order = tpl.kinds.filter(function (k) {
      return !k.below;
    });
    var idx = function (slot) {
      for (var i = 0; i < order.length; i++) if (order[i].field === slot) return i;
      return -1;
    };
    var rows = read.rows;
    rows.forEach(function (r, i) {
      if (r.slot || r.below || !r.value.raw) return;
      var above = -1,
        below = order.length;
      for (var a = i - 1; a >= 0; a--)
        if (rows[a].slot && !rows[a].below) {
          above = idx(rows[a].slot);
          break;
        }
      for (var b = i + 1; b < rows.length; b++)
        if (rows[b].below) break;
        else if (rows[b].slot) {
          below = idx(rows[b].slot);
          break;
        }
      if (above < 0 || below < 0) return;
      var between = [];
      for (var k = above + 1; k < below; k++) between.push(order[k]);
      if (between.length !== 1) return;
      r.slot = between[0].field;
      r.kind = between[0].text;
      // the kind text replaces the words of its own tail that survived at the label start ("Chg 36.1680
      // kW ..." becomes "Demand Chg 36.1680 kW ...", never "Demand Chg Chg ...")
      var kw = between[0].text.split(/\s+/);
      var lw = r.labelText.split(/\s+/).filter(Boolean);
      var drop = 0;
      for (var n = Math.min(kw.length - 1, lw.length); n >= 1 && !drop; n--)
        if (labelDistance(lw.slice(0, n).join(' '), kw.slice(kw.length - n).join(' ')) >= 0) drop = n;
      r.labelText = (between[0].text + ' ' + lw.slice(drop).join(' ')).trim();
      r.byOrder = true;
    });
  }
  // A Subtotal or Current Charges whose label OCR lost prints as a label-less amount in the row list. It is
  // taken as that total only when the printed identity holds to the cent: the Subtotal is the first
  // label-less valid amount that equals the sum of the two or more rows above it; Current Charges is the
  // label-less valid amount under the Subtotal that equals Subtotal plus the rows between them. Then the
  // rows under the Subtotal are marked `below`, and a total still not found is held with the reason.
  function findTotalsByStructure(read, tpl) {
    var rule = tpl.sumRule || {};
    var sub = null,
      tot = null;
    read.totals.forEach(function (t) {
      if (t.label === rule.subtotal) sub = t;
      if (t.label === rule.total) tot = t;
    });
    var rows = read.rows;
    var sumCents = function (from, to) {
      var s = 0;
      for (var i = from; i < to; i++) {
        if (!rows[i].value.ok) return null;
        s += cents(moneyValue(rows[i].value.text));
      }
      return s;
    };
    var takeAsTotal = function (t, i) {
      t.value = rows[i].value;
      t.found = true;
      t.byStructure = true;
      t.box = rows[i].box;
      t.y = rows[i].y;
      rows.splice(i, 1);
    };
    if (sub && !sub.found) {
      for (var i = 2; i < rows.length; i++) {
        if (rows[i].slot || !rows[i].value.ok) continue;
        var s = sumCents(0, i);
        if (s != null && s === cents(moneyValue(rows[i].value.text))) {
          takeAsTotal(sub, i);
          break;
        }
      }
    }
    if (sub && sub.found) {
      rows.forEach(function (r) {
        r.below = r.y > sub.y;
      });
      if (tot && !tot.found && sub.value.ok) {
        var base = cents(moneyValue(sub.value.text));
        var start = -1;
        for (var j = 0; j < rows.length; j++) {
          if (!rows[j].below) continue;
          if (start < 0) start = j;
          if (rows[j].slot || !rows[j].value.ok) continue;
          var b = sumCents(start, j);
          if (b != null && base + b === cents(moneyValue(rows[j].value.text))) {
            takeAsTotal(tot, j);
            break;
          }
        }
      }
    }
    read.totals.forEach(function (t) {
      if (!t.found) read.held.push({ label: t.label, reason: 'no "' + t.label + '" box was found on the page (its label was not read)' });
    });
  }
  // Money as the reader expects it on a line: the page's own prefix ("$102.86", "-$863.35" for the
  // Utility E reader; the City reader takes the bare figure).
  function moneyLineText(text, prefix) {
    if (!prefix) return text;
    var v = moneyValue(text);
    if (v == null) return text;
    return (v < 0 ? '-' : '') + prefix + moneyText(Math.abs(v));
  }
  // The normalized lines of a read (rows in print order, then the totals that have a value).
  function buildLines(read) {
    var lines = [];
    var tpl = templateOf(read.template);
    var prefix = tpl && tpl.moneyPrefix;
    read.rows.forEach(function (r) {
      if (r.absent) return;
      if (read.listMode) {
        if (!r.labelText && !r.value.text) return;
        lines.push((r.labelText || r.labelRaw) + (r.value.text ? ' ' + moneyLineText(r.value.text, prefix) : ''));
        return;
      }
      if (!r.value.text && !r.slot) return;
      var parts = [];
      // A usage cell that fails the usage format (a mark glued to the digits) is no figure: it is dropped,
      // never promoted to a meter read by the reader that parses this line (R6). The reads stay.
      ['prev', 'curr', 'usage'].forEach(function (k) {
        if (r.reads[k].text && (k !== 'usage' || r.reads[k].ok)) parts.push(r.reads[k].text);
      });
      parts.push(r.slot || r.labelRaw);
      if (r.value.text) parts.push(r.value.text);
      lines.push(parts.join(' ').trim());
    });
    read.totals.forEach(function (t) {
      if (t.value.text) lines.push(t.label + ' ' + moneyLineText(t.value.text, prefix));
    });
    return lines;
  }
  function templateOf(id) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i];
    return null;
  }

  // Count of values that passed their format check (rows and totals): the measure of a read.
  function okCount(read) {
    var n = 0;
    read.rows.forEach(function (r) {
      if ((r.slot || read.listMode) && r.value.ok) n++;
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
  // Sum groups. A template with sumRule.subtotal (the Utility E list page) has TWO identities, proved one
  // group at a time: group 'rows' = the charge rows add up to the Subtotal; group 'below' = the Subtotal
  // plus the rows under it add up to the total (Current Charges). A template without one (City) has the
  // single group null: the slotted rows add up to the total. In list mode every row counts, kind known or
  // not (a row whose label OCR lost is still a printed line); a row with no kind may be negative (the
  // credit rows are the only printed negatives, so a negative row whose label OCR lost is a credit with
  // its label lost; a row of a known non-credit kind is still never negative).
  function sumGroups(tpl) {
    return tpl.sumRule && tpl.sumRule.subtotal ? ['rows', 'below'] : [null];
  }
  function rowInGroup(r, group) {
    return group == null ? true : group === 'below' ? !!r.below : !r.below;
  }
  function totalInGroup(tpl, label, group) {
    var rule = tpl.sumRule || {};
    return group == null ? true : group === 'rows' ? label === rule.subtotal : label === rule.total;
  }
  function pageSum(read, tpl, values, group) {
    var rule = tpl.sumRule;
    if (!rule) return { known: false, diffCents: null, negative: null };
    var list = !!rule.subtotal;
    var totalLabel = list && group === 'rows' ? rule.subtotal : rule.total;
    var total = null,
      sum = 0,
      known = true,
      negative = null;
    read.rows.forEach(function (r, i) {
      if (r.absent) return;
      if (list ? !rowInGroup(r, group) : !r.slot) return;
      var v = values && values.rows[i] != null ? values.rows[i] : moneyValue(r.value.text);
      if (v === ABSENT) return;
      if (v == null) known = false;
      else {
        sum += cents(v);
        if (v < 0 && !negative && (list ? r.slot && (rule.creditRows || []).indexOf(r.slot) === -1 : (rule.creditRows || []).indexOf(r.slot) === -1))
          negative = r.slot;
      }
    });
    read.totals.forEach(function (t, i) {
      var v = values && values.totals[i] != null ? values.totals[i] : moneyValue(t.value.text);
      if (t.label === totalLabel) total = v;
      else if (list && group === 'below' && t.label === rule.subtotal) {
        // the proved Subtotal is the base of the second identity
        if (v == null) known = false;
        else sum += cents(v);
      }
    });
    if (total == null) known = false;
    else if (total < 0 && !negative) negative = totalLabel;
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
  // opts.dollar: the cell always prints a leading "$" (template flag): the one candidate is
  // dollarCellValue. A cell with only one cents digit lost ("4.0") offers its ten completions (x.d0 .. x.d9);
  // the page sum keeps one or none.
  function candidatesFromText(txt, opts) {
    if (opts && opts.dollar) {
      var dv = dollarCellValue(txt);
      if (dv != null) return [Math.round(dv * 100) / 100];
    }
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
          var m1 = f.match(/^(-?)(\d[\d,]*)\.(\d)$/);
          if (m1)
            for (var d = 0; d < 10; d++) push(moneyValue(m1[1] + m1[2] + '.' + m1[3] + d));
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
  function rereadPlan(read, tpl, all, group) {
    var allow = tpl.reread || { rows: false, totals: [] };
    var list = !!read.listMode;
    var plan = [];
    var s = pageSum(read, tpl, null, group);
    var inRows = function (r) {
      return list ? rowInGroup(r, group) : !!r.slot;
    };
    var allValid = read.rows.every(function (r) {
      return !inRows(r) || r.absent || r.value.ok;
    });
    var totalValid = read.totals.every(function (t) {
      return !totalInGroup(tpl, t.label, group) || t.value.ok;
    });
    var sumFails = allValid && totalValid && s.known && !sumHolds(s);
    read.rows.forEach(function (r, i) {
      if (!inRows(r) || r.absent || !allow.rows || !r.box) return;
      if (!r.value.ok || sumFails || all)
        plan.push({
          kind: 'row',
          index: i,
          label: r.slot || r.labelText || r.labelRaw || 'row ' + (i + 1),
          box: r.box,
          was: r.value.ok ? r.value.text : r.value.raw,
          ok: r.value.ok,
        });
    });
    read.totals.forEach(function (t, i) {
      if (!t.box || (allow.totals || []).indexOf(t.label) === -1 || !totalInGroup(tpl, t.label, group)) return;
      // in the 'below' group the Subtotal is the proved base, not a box to re-read
      if (list && group === 'below' && t.label === tpl.sumRule.subtotal) return;
      if (!t.value.ok || sumFails || all)
        plan.push({ kind: 'total', index: i, label: t.label, box: t.box, was: t.value.ok ? t.value.text : t.value.raw, ok: t.value.ok, dollar: !!t.dollar });
    });
    return plan;
  }
  // Re-reads the planned boxes through ocrBox(box, cfg) -> Promise<string> (the caller crops the page
  // image and runs tesseract; app/bill-analysis.js in the browser, the gate in node from its cache).
  // The reading taken for a box is the one candidate that is valid money AND makes the page sum hold,
  // with the fewest changes to format-valid values; the failing cells are re-read first, and only when
  // no combination holds are the format-valid cells re-read too (stage 2). When no combination holds,
  // or more than one does, every failing box is held with the reason (which row, what was read).
  // Mutates and returns read (a Promise). A template with two identities (sumGroups) is proved one group
  // after the other: the charge rows against the Subtotal first, then the rows below it and the total
  // against the proved Subtotal.
  // R3: the amounts of the page-text line that carries a row's label. The label is matched on its leading
  // letters (a label cut short is still that label); a label that prints on more than one line (WATER, one
  // line per meter) or on none gives nothing. The amounts come from the same candidate maker as the box
  // re-read, so the page sum still decides.
  // Every OCR pass text of the page is a source (read.pageTexts); the winning pass text alone can lose the
  // printed line to noise. Per text, a label that prints on more than one line gives nothing; the union
  // of the candidates goes to the page sum, which still decides.
  function textLineCandidates(read, tpl, label) {
    var texts = (read.pageTexts && read.pageTexts.length ? read.pageTexts : [read.pageText]).filter(Boolean);
    if (!texts.length || !label) return [];
    var want = normLabel(label);
    if (!want) return [];
    var out = [],
      seen = {};
    texts.forEach(function (pageText) {
      var hits = [];
      String(pageText)
        .split(/\r?\n/)
        .forEach(function (line) {
          if (/^\s*%%/.test(line)) return;
          var toks = line.split(/\s+/).filter(Boolean);
          for (var i = 0; i < toks.length; i++) {
            for (var n = 1; n <= 3 && i + n <= toks.length; n++) {
              var part = toks.slice(i, i + n);
              if (
                part.some(function (t) {
                  return /\d/.test(t);
                })
              )
                break;
              var found = normLabel(part.join(' '));
              if (!found) continue;
              var ok = labelDistance(part.join(' '), label) >= 0;
              if (!ok && found.length >= 6 && found.length < want.length)
                ok = editDistance(found, want.slice(0, found.length)) <= allowedEdits(found.length);
              if (ok) {
                // The amounts of this label are the ones before the next label of the layout on the same line (a chart
                // header "Gas" shares its line with the SEWER row: "Gas a Oo SEWER 1,370.82"). A hit with no amount
                // left is a header or a label without a value, not a printed row of this label.
                var rest = toks.slice(i + n);
                var cutAt = rest.length;
                for (var r = 0; r < rest.length && cutAt === rest.length; r++) {
                  for (var rn = 1; rn <= 3 && r + rn <= rest.length; rn++) {
                    var rp = rest.slice(r, r + rn);
                    if (
                      rp.some(function (t) {
                        return /\d/.test(t);
                      })
                    )
                      break;
                    var other = (tpl.slots || []).some(function (sl) {
                      return normLabel(sl) !== want && labelDistance(rp.join(' '), sl) >= 0;
                    });
                    if (other) {
                      cutAt = r;
                      break;
                    }
                  }
                }
                var own = rest.slice(0, cutAt).join(' ');
                if (/\d/.test(own)) hits.push(own);
                return;
              }
            }
          }
        });
      if (hits.length !== 1) return;
      candidatesFromText(hits[0], { dollar: false }).forEach(function (c) {
        var k = JSON.stringify(c);
        if (seen[k]) return;
        seen[k] = true;
        out.push(c);
      });
    });
    return out;
  }
  function rereadBoxes(read, tpl, ocrBox) {
    var chain = Promise.resolve(read);
    sumGroups(tpl).forEach(function (group) {
      chain = chain.then(function () {
        return rereadGroup(read, tpl, ocrBox, group);
      });
    });
    return chain;
  }
  function rereadGroup(read, tpl, ocrBox, group) {
    var stage1 = rereadPlan(read, tpl, false, group);
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
    var opts = read.opts || {};
    var candidatesOf = function (p) {
      var list = [];
      var add = function (v) {
        if (list.indexOf(v) !== -1) return;
        // R7: a candidate the account's saved bills rule out is removed (never added by history)
        var why = opts.reject && opts.reject(p.label, v, read.pageText);
        if (why) {
          read.rejected = read.rejected || [];
          read.rejected.push({ label: p.label, value: v, reason: why });
          return;
        }
        list.push(v);
      };
      if (p.ok) list.push(moneyValue(p.was));
      candidatesFromText(p.ok ? '' : p.was, { dollar: p.dollar }).forEach(add);
      readings[keyOf(p)].forEach(function (r) {
        candidatesFromText(r.text, { dollar: p.dollar }).forEach(add);
      });
      // R3: a cell the pen covers (the box reads the handwriting): the page text carries the printed line
      // (the label cut short and a minus glyph, then the amount). Its amount is a second reading of the
      // cell, still proved by the page sum.
      if (!p.ok) textLineCandidates(read, tpl, p.label).forEach(add);
      // ABSENT: a City row the order rule placed from a noise label with no value, or a list row with no
      // kind (a stray mark in the column is no printed line; a real line whose label and amount both
      // OCR lost cannot be proved either way and is dropped only when the page adds up without it).
      if (p.kind === 'row' && ((!p.was && read.rows[p.index].byOrder) || (read.listMode && !read.rows[p.index].slot))) list.push(ABSENT);
      return list;
    };
    // The one holding combination over plan: the failing boxes take any candidate; the format-valid
    // boxes keep their value, then (fewest changes first) up to two of them may take a re-read
    // candidate. { ok:true, values } when exactly one assignment holds at the fewest changes, else
    // { ok:false, why }.
    var solve = function (plan) {
      var cands = plan.map(candidatesOf);
      // R4: a box with no reading at all is the residual of the page identity. Exactly ONE such box is
      // solved from the sum (every other box proved the usual way); two or more are one identity with
      // two unknowns.
      var empties = [];
      cands.forEach(function (c, i) {
        if (!c.length) empties.push(i);
      });
      if (empties.length > 1)
        return {
          ok: false,
          why:
            empties
              .map(function (i) {
                return plan[i].label;
              })
              .join(' and ') + ' have no reading: one identity, two unknowns',
        };
      var res = empties.length ? empties[0] : -1;
      var failing = [],
        valid = [];
      plan.forEach(function (p, i) {
        if (i === res) return;
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
          var fill = function () {
            plan.forEach(function (p, i) {
              if (p.kind === 'row') values.rows[p.index] = assign[i];
              else values.totals[p.index] = assign[i];
            });
          };
          var residualOk = true;
          if (res >= 0) {
            // the residual is what makes the sum close: row = total - others, total = sum of the rows
            assign[res] = 0;
            fill();
            var s0 = pageSum(read, tpl, values, group);
            if (!s0.known) residualOk = false;
            else assign[res] = (plan[res].kind === 'total' ? s0.diffCents : -s0.diffCents) / 100;
          }
          fill();
          if (residualOk && sumHolds(pageSum(read, tpl, values, group))) sets.push(assign);
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
        return {
          ok: false,
          why:
            'no reading makes the page lines add up to the printed ' +
            (group === 'rows' ? tpl.sumRule.subtotal : tpl.sumRule.total) +
            ' to the cent with no negative charge',
        };
      for (var b = 0; b < plan.length; b++) {
        if (b === res) continue;
        var first = sets[0][b];
        var agree = sets.every(function (set) {
          return set[b] === first;
        });
        if (!agree) return { ok: false, why: 'more than one reading makes the page lines add up (ambiguous)' };
      }
      if (res >= 0) {
        // the others agree in every set, so the residual is the same in all of them
        var rv = sets[0][res];
        var sameRes = sets.every(function (set) {
          return set[res] === rv;
        });
        if (!sameRes) return { ok: false, why: 'more than one reading makes the page lines add up (ambiguous)' };
        return { ok: true, values: sets[0], residual: res };
      }
      return { ok: true, values: sets[0] };
    };
    // The residual box (R4): its value is the page identity alone, one source. It is held with the exact
    // missing second source named; the other boxes of the group are filled.
    var holdResidual = function (plan, r) {
      var p = plan[r.residual];
      var v = r.values[r.residual];
      setHeld(
        read,
        p,
        describe(p) +
          '; ' +
          p.label +
          ' = ' +
          (p.kind === 'total' ? 'the lines added up' : 'the printed ' + (group === 'rows' ? tpl.sumRule.subtotal : tpl.sumRule.total) + ' minus the other lines') +
          ' = ' +
          moneyText(v) +
          ' (one source: the page identity); second source missing: the cell is covered or unreadable and the page text has no line for ' +
          p.label,
      );
    };
    var apply = function (plan, values, skip) {
      plan.forEach(function (p, i) {
        if (i === skip) return;
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
        apply(stage1, r1.values, r1.residual);
        if (r1.residual != null) holdResidual(stage1, r1);
        read.lines = buildLines(read);
        return read;
      }
      var stage2 = rereadPlan(read, tpl, true, group);
      if (stage2.length <= stage1.length) {
        holdFailing(r1.why);
        return read;
      }
      return collect(stage2).then(function () {
        var r2 = solve(stage2);
        if (r2.ok) {
          apply(stage2, r2.values, r2.residual);
          if (r2.residual != null) holdResidual(stage2, r2);
          read.lines = buildLines(read);
        } else holdFailing(r2.why);
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
    if (best) {
      best.read.pageText = best.pass.text || '';
      best.read.pageTexts = (passes || [])
        .map(function (p) {
          return p && p.text;
        })
        .filter(Boolean);
      return { ok: true, read: best.read, pass: best.pass, template: best.tpl };
    }
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
  // opts.reject(label, value, pageText) -> reason | null: the history check of the caller (R7). It only
  // removes a candidate; it never adds one.
  function readPage(passes, ocrBox, opts) {
    var res = readBestPass(passes);
    if (!res.ok || typeof ocrBox !== 'function') return Promise.resolve(res);
    res.read.opts = opts || {};
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
          below: !!r.below,
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
    UTILITY_E_BD: UTILITY_E_BD,
    LAYOUT_FACTS: LAYOUT_FACTS,
    fieldFormat: fieldFormat,
    MONEY_STRICT: MONEY_STRICT,
    REREAD_CONFIGS: REREAD_CONFIGS,
    REREAD_WHITELIST: REREAD_WHITELIST,
    wordsFromOcr: wordsFromOcr,
    normLabel: normLabel,
    labelDistance: labelDistance,
    matchTemplate: matchTemplate,
    readPageByTemplate: readPageByTemplate,
    candidatesFromText: candidatesFromText,
    dollarCellValue: dollarCellValue,
    rereadPlan: rereadPlan,
    rereadBoxes: rereadBoxes,
    pageSum: pageSum,
    sumGroups: sumGroups,
    sumHolds: sumHolds,
    kindOfBand: kindOfBand,
    rereadCrop: rereadCrop,
    readBestPass: readBestPass,
    readPage: readPage,
    linesBlock: linesBlock,
    fallbackMarker: fallbackMarker,
    debugRecord: debugRecord,
  };
});
