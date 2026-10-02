/* Estimate workbook pricing engine (pure UMD: browser + node; no DOM, no storage).
   Ports the Dash / Labor Rates / Mat & Equip sheet chain of the CSC change-order
   cost workbook. Every money line is ROUND(x,0): half away from zero, whole dollars.
   Result keys are workbook cell refs: 'Dash!G18', 'LaborRates!P10', 'MatEquip!G8'. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EstimateWorkbook = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Labor Rates sheet. d = base rate (col D). insA/insB: insurance = insA/100*D + insB/1000*D (col I).
  // k: typed training value (null = ((D*80)+0.1)/2080). m: {fixed, pct} retirement (null = D*0.03).
  // nPct = PTO fund share of D (col N). ot = rows with a real x1.5 rate (col Q); x2.0 (col R) is the
  // same set. Roles without OT use the x1.0 rate for every OT setting.
  var FRINGE_L = 10.84 + 0.84 + 0.1 + 0.06 + 0.37 + 0.1 + 1.92;
  var ROLES = [
    {
      code: 'PE',
      name: 'Project Engineer',
      dRow: 8,
      rRow: 10,
      base: 66 * 1.25,
      insA: 2.97,
      insB: 9.93,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: false,
    },
    {
      code: 'DE',
      name: 'Design Engineer',
      dRow: 9,
      rRow: 11,
      base: 68 * 1.15,
      insA: 0.15,
      insB: 9.93,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: false,
    },
    {
      code: 'SE',
      name: 'Software Engineer',
      dRow: 10,
      rRow: 12,
      base: 68 * 1.15,
      insA: 0.15,
      insB: 9.93,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: false,
    },
    {
      code: 'SC',
      name: 'Startup & Checkout Engineer',
      dRow: 11,
      rRow: 13,
      base: 57 * 1.15,
      insA: 2.97,
      insB: 3.951,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: true,
    },
    {
      code: 'CO',
      name: 'Commissioning Engineer',
      dRow: 12,
      rRow: 14,
      base: 66 * 1.25,
      insA: 2.97,
      insB: 3.951,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: true,
    },
    {
      code: 'TR',
      name: 'Training Engineer',
      dRow: 13,
      rRow: 15,
      base: 68 * 1.15,
      insA: 0.15,
      insB: 9.93,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: false,
    },
    {
      code: 'EI',
      name: 'Electrical Install',
      dRow: 14,
      rRow: 16,
      base: 55.51 * 1.2,
      insA: 2.97,
      insB: 3.951,
      j: 0.15 + 0.18,
      k: 0.65 + 0.1,
      l: 10.25,
      m: { fixed: 6 + 4.25, pct: 0.03 },
      nPct: 0.07,
      ot: true,
    },
    {
      code: 'PI',
      name: 'Pneumatic Install',
      dRow: 15,
      rRow: 17,
      base: 57.51 * 1.2,
      insA: 2.97,
      insB: 3.951,
      j: 0,
      k: 2.35 + 0.48 + 0.1 + 0.1,
      l: 10.55,
      m: { fixed: 6.35 + 5 + 2, pct: 0 },
      nPct: 0.11,
      ot: true,
    },
    {
      code: 'IT',
      name: 'Information Tech Engineer',
      dRow: 16,
      rRow: 18,
      base: 54 * 1.25,
      insA: 0.15,
      insB: 9.93,
      j: 0,
      k: null,
      l: FRINGE_L,
      m: null,
      nPct: 0.11,
      ot: false,
    },
  ];
  var CODES = ROLES.map(function (r) {
    return r.code;
  });

  // Task type -> labor role (editable per project). Audit work is PE, so a 52 h audit is all-PE.
  var TASK_TYPES = [
    { id: 'audit_equipment_review', label: 'Equipment review (audit)', role: 'PE' },
    { id: 'audit_matrix_review', label: 'Equipment matrix review', role: 'PE' },
    { id: 'audit_report', label: 'Audit report', role: 'PE' },
    { id: 'audit_site_visit_travel', label: 'Site visit and travel', role: 'PE' },
    { id: 'audit_mechanical_review', label: 'Mechanical review', role: 'PE' },
    { id: 'audit_lighting_review', label: 'Lighting review', role: 'PE' },
    { id: 'audit_envelope_review', label: 'Envelope review', role: 'PE' },
    { id: 'audit_utility_review', label: 'Utility review', role: 'PE' },
    { id: 'bas_programming', label: 'BAS programming', role: 'SE' },
    { id: 'bas_alarms_reports_trends', label: 'Alarms, reports and trends', role: 'SE' },
    { id: 'install_per_point', label: 'Install per point', role: 'EI' },
    { id: 'install_pneumatic_valve', label: 'Pneumatic and valve install', role: 'PI' },
    { id: 'startup_checkout', label: 'Startup and checkout', role: 'SC' },
    { id: 'commissioning', label: 'Commissioning', role: 'CO' },
    { id: 'training', label: 'Training', role: 'TR' },
    { id: 'network_ip', label: 'Network and IP', role: 'IT' },
    { id: 'engineering_design', label: 'Engineering and design', role: 'DE' },
    { id: 'monthly_service', label: 'Monthly service', role: 'PE' },
    { id: 'meetings', label: 'Meetings', role: 'PE' },
    { id: 'rebate_help', label: 'Rebate help', role: 'PE' },
    { id: 'bill_entry', label: 'Bill entry', role: 'PE' },
    { id: 'warranty', label: 'Warranty', role: 'PE' },
  ];
  var TASK_ROLE_MAP = {};
  TASK_TYPES.forEach(function (t) {
    TASK_ROLE_MAP[t.id] = t.role;
  });

  var DEFAULTS = {
    pct: {
      freight: 0.05, // Dash!F22
      smallTools: 0.015, // Dash!F32
      overhead: 0.1, // Dash!M27
      profit: 0.3, // Dash!M28
      subProfit: 0.05, // Dash!M31
      bond: 0.011, // Dash!M35
      safety: 0, // Dash!F37
      warrantyFactor: 0, // Dash!D17
    },
    vanRate: 100, // Dash!F38
    ot: 'Not Applicable', // Info!F16
    state: 'Kansas', // Info!F18
    taxRate: 0, // Info!F13
    bond: false, // Info!F15 = "Applicable"
    roles: ROLES,
    taskTypes: TASK_TYPES,
    taskRoleMap: TASK_ROLE_MAP,
    limits: { parts: 25, tools: 5, misc: 6, subs: 14 },
  };

  // Excel ROUND(x,0): half away from zero. Values are first cut to 15 significant digits
  // (Excel precision) so 2.4999999999999996 style float noise does not flip the result.
  function round0(x) {
    if (typeof x !== 'number' || !isFinite(x)) return 0;
    var a = Math.abs(Number(Math.abs(x).toPrecision(15)));
    var r = Math.floor(a + 0.5);
    return x < 0 ? (r === 0 ? 0 : -r) : r;
  }
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // One role's Labor Rates row (cols D..R). baseOverride replaces col D.
  function roleRates(role, baseOverride) {
    var D = baseOverride != null && isFinite(Number(baseOverride)) ? Number(baseOverride) : role.base;
    var E = D * 0.062,
      F = D * 0.0145,
      G = D * 0.006,
      H = D * 0.00352;
    var I = (role.insA / 100) * D + (role.insB / 1000) * D;
    var J = role.j;
    var K = role.k != null ? role.k : (D * 80 + 0.1) / 2080;
    var L = role.l;
    var M = role.m ? role.m.fixed + D * role.m.pct : D * 0.03;
    var N = D * role.nPct;
    var O = E + F + G + H + I + J + K + L + M + N;
    var P = O + D;
    var Q = role.ot ? D * 1.5 + O : P;
    var R = role.ot ? D * 2 + O : P;
    return { D: D, E: E, F: F, G: G, H: H, I: I, J: J, K: K, L: L, M: M, N: N, O: O, P: P, Q: Q, R: R };
  }

  // rateTable({PE: baseRate, ...}) -> [{code,name,row,D..R}]. Optional base-rate overrides.
  // Tied base rates (workbook Labor Rates formulas): D12 (SE) = D11 (DE), D14 (CO) = D10 (PE),
  // D15 (TR) = D11 (DE). Row 19 (Warranty Labor) D19 = D10 (PE) is carried by Dash!F17 = Dash!F8.
  // A tied role never takes its own override; it follows its source role.
  var TIED_BASE = { SE: 'DE', CO: 'PE', TR: 'DE' };
  function rateTable(baseOverrides) {
    var ov = baseOverrides || {};
    return ROLES.map(function (r) {
      var src = TIED_BASE[r.code];
      var o = roleRates(r, src ? ov[src] : ov[r.code]);
      o.code = r.code;
      o.name = r.name;
      o.row = r.rRow;
      o.dashRow = r.dRow;
      o.otCapable = r.ot;
      return o;
    });
  }

  function pickRate(rr, ot) {
    if (ot === 'x1.5') return rr.Q;
    if (ot === 'x2.0') return rr.R;
    return rr.P; // "Not Applicable" (and any unknown value)
  }

  /* input (all optional):
       hours: {PE:52,...}          Dash!E8:E16
       ot: 'Not Applicable'|'x1.5'|'x2.0'
       state: 'Kansas'|'Missouri'|'Other'
       taxRate: 0.0875             Info!F13
       bond: true|false            Info!F15
       baseRates: {PE: 82.5,...}   Labor Rates col D overrides
       pct: {freight,smallTools,overhead,profit,subProfit,bond,safety,warrantyFactor}
       parts: [{qty, unit}]  up to 25   Mat & Equip rows 8-32
       tools: [{qty, hrs, rate}] up to 5  Dash rows 27-31 (D qty, E hrs/days, F rate)
       vans: {qty, rate}            Dash row 38
       misc: [{qty, rate}] up to 6  Dash rows 39-44
       subs: [{amount, bondPct}] up to 14  Dash rows 8-21 (L, M)
     Returns {cells, labels, rates, summary}. cells['Dash!N36'] is the grand total. */
  function compute(input) {
    var inp = input || {};
    var pct = {};
    Object.keys(DEFAULTS.pct).forEach(function (k) {
      pct[k] = inp.pct && inp.pct[k] != null ? num(inp.pct[k]) : DEFAULTS.pct[k];
    });
    var ot = inp.ot || DEFAULTS.ot;
    var state = inp.state || DEFAULTS.state;
    var taxRate = inp.taxRate != null ? num(inp.taxRate) : DEFAULTS.taxRate;
    var bond = inp.bond != null ? !!inp.bond : DEFAULTS.bond;
    var hours = inp.hours || {};
    var cells = {},
      labels = {};
    function put(ref, label, v) {
      cells[ref] = v;
      labels[ref] = label;
      return v;
    }

    // Labor Rates + Dash labor block (rows 8-16)
    var table = rateTable(inp.baseRates);
    var rates = {};
    var hoursSum = 0,
      laborSum = 0;
    table.forEach(function (rr) {
      var pre = 'LaborRates!';
      ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'].forEach(function (c) {
        put(pre + c + rr.row, rr.code + ' labor rate col ' + c, rr[c]);
      });
      var rate = pickRate(rr, ot);
      var h = num(hours[rr.code]);
      rates[rr.code] = rate;
      put('Dash!E' + rr.dashRow, rr.name + ' hours', h);
      put('Dash!F' + rr.dashRow, rr.name + ' rate', rate);
      var g = put('Dash!G' + rr.dashRow, rr.name + ' total', round0(rate * h));
      hoursSum += h;
      laborSum += g;
    });
    var warrHours = hoursSum * pct.warrantyFactor;
    put('Dash!D17', 'Warranty factor', pct.warrantyFactor);
    put('Dash!E17', 'Warranty hours', warrHours);
    put('Dash!F17', 'Warranty rate', cells['Dash!F8']);
    var G17 = put('Dash!G17', 'Warranty labor total', round0(cells['Dash!F17'] * warrHours));
    put('Dash!E18', 'Labor hours total', hoursSum + warrHours);
    var G18 = put('Dash!G18', 'LABOR SUMMARY TOTAL', laborSum + G17);

    // Mat & Equip rows 8-32
    var parts = inp.parts || [];
    var matSum = 0;
    for (var i = 0; i < DEFAULTS.limits.parts; i++) {
      var p = parts[i] || {};
      var row = 8 + i;
      var unit = num(p.unit),
        qty = num(p.qty);
      put('MatEquip!E' + row, 'Part qty', qty);
      put('MatEquip!F' + row, 'Part unit price', unit);
      matSum += put('MatEquip!G' + row, 'Part extended price', round0(unit * qty));
    }
    put('MatEquip!G33', 'Mat & Equip total', matSum);
    var G21 = put('Dash!G21', 'Equipment & Materials', matSum);
    var G22 = put('Dash!G22', 'Freight Charges', round0(G21 * pct.freight));
    put('Dash!F22', 'Freight rate', pct.freight);
    var F23 = state === 'Kansas' ? 0 : taxRate;
    put('Dash!F23', 'Material sales tax rate', F23);
    var G23 = put('Dash!G23', 'Material Sales Tax', round0((G21 + G22) * F23));
    var G24 = put('Dash!G24', 'EQUIPMENT & MATERIAL SUMMARY TOTAL', G21 + G22 + G23);

    // Tools / rentals rows 27-31, 32, 33
    var tools = inp.tools || [];
    var toolSum = 0;
    for (var t = 0; t < DEFAULTS.limits.tools; t++) {
      var tl = tools[t] || {};
      var trow = 27 + t;
      put('Dash!D' + trow, 'Tool qty', num(tl.qty));
      put('Dash!E' + trow, 'Tool hrs/days', num(tl.hrs));
      put('Dash!F' + trow, 'Tool rate', num(tl.rate));
      toolSum += put('Dash!G' + trow, 'Tool total', round0(num(tl.rate) * num(tl.hrs) * num(tl.qty)));
    }
    put('Dash!F32', 'Small tools rate', pct.smallTools);
    var G32 = put('Dash!G32', 'CSC Small Tools|Consumables|Rentals', round0(G18 * pct.smallTools));
    put('Dash!F33', 'Rental sales tax rate', taxRate);
    var G33 = put('Dash!G33', 'Rental Sales Tax', round0((toolSum + G32) * taxRate));
    var G34 = put('Dash!G34', 'TOOLS|RENTALS SUMMARY TOTAL', toolSum + G32 + G33);

    // Misc indirect rows 37-44
    put('Dash!F37', 'Safety rate', pct.safety);
    var miscSum = put('Dash!G37', 'Safety', round0(G18 * pct.safety));
    var vans = inp.vans || {};
    var vanRate = vans.rate != null ? num(vans.rate) : DEFAULTS.vanRate;
    put('Dash!E38', 'Vans qty', num(vans.qty));
    put('Dash!F38', 'Vans rate', vanRate);
    miscSum += put('Dash!G38', 'Service Van(s) | Truck(s)', round0(vanRate * num(vans.qty)));
    var misc = inp.misc || [];
    for (var m = 0; m < DEFAULTS.limits.misc; m++) {
      var mi = misc[m] || {};
      var mrow = 39 + m;
      put('Dash!E' + mrow, 'Misc qty', num(mi.qty));
      put('Dash!F' + mrow, 'Misc rate', num(mi.rate));
      miscSum += put('Dash!G' + mrow, 'Misc total', round0(num(mi.rate) * num(mi.qty)));
    }
    var G45 = put('Dash!G45', 'MISC. INDIRECT COST SUMMARY TOTAL', miscSum);

    // Subcontractors rows 8-21
    var subs = inp.subs || [];
    var subSum = 0;
    for (var s = 0; s < DEFAULTS.limits.subs; s++) {
      var sb = subs[s] || {};
      var L = num(sb.amount),
        M = num(sb.bondPct);
      put('Dash!L' + (8 + s), 'Sub quote', L);
      put('Dash!M' + (8 + s), 'Sub bond %', M);
      subSum += put('Dash!N' + (8 + s), 'Sub total', round0(L + L * M));
    }
    var N22 = put('Dash!N22', 'SUBCONTRACTOR SUMMARY TOTAL', subSum);

    // Summary N26..N36
    var N26 = put('Dash!N26', 'Work Performed by CSC Resources', G18 + G24 + G34 + G45);
    put('Dash!M27', 'CSC Overhead rate', pct.overhead);
    var N27 = put('Dash!N27', 'CSC Overhead', round0(N26 * pct.overhead));
    put('Dash!M28', 'CSC Profit rate', pct.profit);
    var N28 = put('Dash!N28', 'CSC Profit', round0((N26 + N27) * pct.profit));
    var N29 = put('Dash!N29', 'Work Performed by CSC Resources Total', N26 + N27 + N28);
    var N30 = put('Dash!N30', 'Work Performed by Lower-Tier Subcontractor', N22);
    put('Dash!M31', 'Lower-Tier Subcontractor Profit rate', pct.subProfit);
    var N31 = put('Dash!N31', 'Lower-Tier Subcontractor Profit', round0(N30 * pct.subProfit));
    var N32 = put('Dash!N32', 'Work Performed by Lower-Tier Subcontractor Total', N30 + N31);
    var N33 = put('Dash!N33', 'Subtotal w/CSC|SUB OH&P', N32 + N29);
    var isKS = state === 'Kansas';
    put('Dash!L34', 'Tax state', isKS ? 'Kansas' : 'N/A');
    var M34 = put('Dash!M34', 'Kansas tax rate', isKS ? taxRate : 0);
    var N34 = put('Dash!N34', 'Total Project Sales & Use Tax (Kansas Only)', round0(isKS ? N33 * M34 : 0));
    var M35 = put('Dash!M35', 'CSC Bond rate', bond ? pct.bond : 0);
    var N35 = put('Dash!N35', 'CSC Bond', round0((N34 + N33) * M35));
    var N36 = put('Dash!N36', 'GRAND TOTAL CHANGE ORDER PROPOSAL', N33 + N34 + N35);

    // Breakout J40:M43 (division by zero shows as null, like #DIV/0!)
    var K40 = put('Dash!K40', 'Labor cost', G18);
    var K41 = put('Dash!K41', 'Material cost', G24);
    var K43 = put('Dash!K43', 'Breakout cost total', K40 + K41);
    var L40 = put('Dash!L40', 'Labor share', K43 ? K40 / K43 : null);
    var L41 = put('Dash!L41', 'Material share', K43 ? K41 / K43 : null);
    var J40 = put('Dash!J40', 'Labor price', L40 == null ? null : (N36 - N32) * L40);
    var J41 = put('Dash!J41', 'Material price', L41 == null ? null : (N36 - N32) * L41);
    var J42 = put('Dash!J42', 'Subs price', N32);
    var J43 = put('Dash!J43', 'Breakout price total', (J40 || 0) + (J41 || 0) + J42);
    var E18 = cells['Dash!E18'],
      E17 = warrHours;
    put('Dash!L43', 'Blended $/hr', E18 ? J43 / E18 : null);
    put('Dash!M43', 'Blended $/hr excl. warranty', E18 ? (J43 - E17) / E18 : null);

    return {
      cells: cells,
      labels: labels,
      rates: rates,
      summary: {
        labor: G18,
        materials: G24,
        tools: G34,
        misc: G45,
        direct: N26,
        overhead: N27,
        profit: N28,
        csc: N29,
        subs: N32,
        subtotal: N33,
        tax: N34,
        bond: N35,
        total: N36,
      },
    };
  }

  return {
    compute: compute,
    rateTable: rateTable,
    TIED_BASE: TIED_BASE,
    round0: round0,
    DEFAULTS: DEFAULTS,
  };
});
