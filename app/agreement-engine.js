/**
 * agreement-engine.js — Energy Management Services Agreement generator.
 *
 * Built per AI/_context/specs/energy-services-agreement-generator-blueprint.md (Phase 1 + Phase 3
 * scope: shared boilerplate body + all four commercial-terms renderers). Phase 2 (persistence of
 * hand edits / conflict pills) is explicitly OUT of scope for this build — every contenteditable
 * block here behaves exactly like every other report in this app: editable in the live preview,
 * NOT saved when the overlay is closed. Only the project-level CONFIGURATION (which template type,
 * escalation rate, minimum spend, profit-share split) is persisted, at `en_agreement_config_<projId>`
 * — a plain settings object, the same tier of complexity as `_pricingGetBudget`/`_pricingGetConfig`,
 * not the sparse hand-edit-diff/override system the blueprint's Phase 2 describes.
 *
 * Ground truth for the shared boilerplate text is
 * AI/_context/specs/joco-energy-services-agreement-base-2026-07-23.md (verbatim JOCO extraction)
 * cross-checked against Louisburg School District's own Energy Management Services Agreement
 * (profit-sharing deal) to determine what's truly universal boilerplate vs. commercial-terms-
 * specific language. See the implementer's report for the full diff table and every divergence
 * from the JOCO source this file makes on purpose (none silent — all called out below and in that
 * report).
 *
 * Parallel to report-engine.js, not merged into it (blueprint: "this is a distinct document type
 * with its own page set, not a report variant"). Reuses report-engine.js's rptPage()/
 * showReportOverlay()/closeReportOverlay()/_injectPageNumbers()/CSC_HEADER_B64/CSC_FOOTER_B64/
 * _rptProposalDisplayClientName/_esc, and pricing-estimator.js's _pricingGetBudget/_pricingGetConfig/
 * _pricingComputeMonthlyService/_pricingComputeRecommendedTimeline/_pricingPhaseDateDefs/
 * _pricingComputeSummaryData/_pricingGetEstimate/_pricingFmt — no new pricing math is written here.
 */

// ─── Config storage (plain settings, NOT the hand-edit override/diff system) ─────────────────────
var AGREEMENT_TEMPLATE_TYPES = ['monthlyAllowance', 'profitSharing', 'epcFlatCost', 'oneTimeCost'];
var AGREEMENT_TEMPLATE_LABELS = {
  monthlyAllowance: 'Monthly Allowance',
  profitSharing: 'Profit Sharing',
  epcFlatCost: 'EPC Flat Cost',
  oneTimeCost: 'One-Time Cost',
};

function _agreementGetConfig(projId) {
  var stored = typeof sget === 'function' ? sget('en_agreement_config_' + projId, null) : null;
  var dflt = {
    templateType: 'monthlyAllowance',
    effectiveDate: null, // null = use today at generation time
    // Defaults per Matt's direction (2026-07-27): 4% escalation, $2,768/mo minimum spend
    // (16 hrs x $173/hr). Both are UNCONFIRMED until the client explicitly accepts them — the
    // *Confirmed flags gate whether the "(default — pending confirmation)" flag shows in the
    // generated text, so a placeholder can never quietly reach a county. See Word comments #1
    // ("Add minimum spend amount") and #2 ("Escalation in renewal terms.") in the base spec —
    // this resolves both.
    escalationRate: 4,
    escalationConfirmed: false,
    minimumSpend: 2768,
    minimumSpendConfirmed: false,
    // Profit-sharing split (Louisburg's real deal: Contractor 60% of verified savings).
    cscPct: 60,
    clientPct: 40,
  };
  if (!stored) return dflt;
  return Object.assign({}, dflt, stored);
}
function _agreementSetConfig(projId, updates) {
  var cfg = _agreementGetConfig(projId);
  Object.assign(cfg, updates);
  if (typeof sset === 'function') sset('en_agreement_config_' + projId, cfg);
  return cfg;
}

// ─── Small formatting helpers ─────────────────────────────────────────────────────────────────
var _AGREEMENT_ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
var _AGREEMENT_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Whole-number-to-words (supports 0 - 999,999,999) — used to spell out dollar amounts the same way
// the JOCO source does ("Six Thousand Two Hundred and Fifty Dollars ($6,250.00)"). Only whole
// dollars are spelled out; the numeral form always carries the exact cents.
function _agreementNumToWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'Zero';
  function three(num) {
    var s = '';
    if (num >= 100) {
      s += _AGREEMENT_ONES[Math.floor(num / 100)] + ' Hundred';
      num = num % 100;
      if (num) s += ' ';
    }
    if (num >= 20) {
      s += _AGREEMENT_TENS[Math.floor(num / 10)];
      if (num % 10) s += '-' + _AGREEMENT_ONES[num % 10].toLowerCase();
    } else if (num > 0) {
      s += _AGREEMENT_ONES[num];
    }
    return s;
  }
  var groups = [];
  var labels = ['', ' Thousand', ' Million', ' Billion'];
  var i = 0;
  while (n > 0 && i < labels.length) {
    var chunk = n % 1000;
    if (chunk) groups.unshift(three(chunk) + labels[i]);
    n = Math.floor(n / 1000);
    i++;
  }
  return groups.join(' ');
}

// "Six Thousand Two Hundred Fifty Dollars ($6,250.00)" — spelled words + exact numeral, matching
// the JOCO source's own convention verbatim.
function _agreementSpellDollars(amount) {
  amount = Number(amount) || 0;
  var whole = Math.floor(amount);
  var words = _agreementNumToWords(whole) + (whole === 1 ? ' Dollar' : ' Dollars');
  var numeral = '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return words + ' (' + numeral + ')';
}

var _AGREEMENT_MONTHS = [
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
function _agreementFmtDateLong(dateObj) {
  if (!dateObj || isNaN(dateObj)) return '';
  return _AGREEMENT_MONTHS[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();
}

function _agreementEsc(s) {
  return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
}

// Inline "unconfirmed default" flag — plain text, no boxes/pills per report standards (report text
// rule: "No outline boxes / pill treatments on report text"). Uses the existing --rpt-orange token
// (same one used elsewhere in report-engine.js for "(extended)" style inline annotations) rather
// than inventing a new color.
function _agreementUnconfirmedFlag(isConfirmed) {
  if (isConfirmed) return '';
  return ' <span style="color:var(--rpt-orange);font-style:italic">(default value — pending your confirmation)</span>';
}

// ─── collectAgreementData ─────────────────────────────────────────────────────────────────────
/**
 * collectAgreementData — single `d` object; no page function touches storage directly (blueprint
 * requirement). templateType is one of AGREEMENT_TEMPLATE_TYPES; opts overrides the persisted
 * config for this render only (does not write storage — the modal's Generate button writes
 * storage separately via _agreementSetConfig before calling this).
 */
function collectAgreementData(projId, templateType, opts) {
  opts = opts || {};
  var proj = (typeof projects !== 'undefined' ? projects : []).find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!proj) return null;

  // Client display/legal name — proj.client FIRST, falling back to proj.name, matching the exact
  // convention collectASHRAE36Data already uses (report-engine.js: "var projName = proj ?
  // proj.client || proj.name || 'Project' : 'Project'"). proj.name is frequently an internal short
  // label (e.g. "JOCO"), never the client-facing name (e.g. "Johnson County, Kansas") — confirmed
  // against the real seeded project record. Using raw proj.name here would put the internal label
  // in a legal document.
  var clientName = proj.client || proj.name || 'Project';

  var cfg = _agreementGetConfig(projId);
  Object.assign(cfg, opts);
  if (templateType) cfg.templateType = templateType;
  if (AGREEMENT_TEMPLATE_TYPES.indexOf(cfg.templateType) === -1) cfg.templateType = 'monthlyAllowance';

  // Buildings covered — Johnson County has no Utility Data and never will (standing client
  // instruction, not a bug), so getUDBldgs always returns empty for this client and the Agreement
  // could never list a single building. Source from the Equipment Matrix instead, via
  // collectASHRAE36Data — the SAME function and campus-wide/weather exclusion logic
  // pricing-estimator.js's _pricingGetBuildingCount already relies on (auditableRows.length guard
  // drops rows like the "Johnson County"/"New Century Complex" Weather-only stubs), so this can
  // never drift from the building count shown elsewhere in the app. See
  // _pricingGetBuildingCount (pricing-estimator.js) for the full rationale.
  var ashData = typeof collectASHRAE36Data === 'function' ? collectASHRAE36Data(projId) : null;
  var buildings = (ashData && ashData.buildings ? ashData.buildings : []).map(function (b) {
    return b.name;
  });

  // Equipment count — computed and exposed on `d` per the blueprint's live-data-binding table, but
  // NOT rendered anywhere in the Agreement body itself: neither source Agreement document mentions
  // an equipment count anywhere (that figure belongs to the Service Proposal, a different
  // document). Kept available here for the modal summary line / future use rather than invented
  // into the contract prose, which would not be a "true 1:1 replica."
  var matData = typeof emLoadMatrix === 'function' ? emLoadMatrix(projId) : null;
  var equipmentCount = matData && matData.rows ? matData.rows.length : 0;

  var budget = typeof _pricingGetBudget === 'function' ? _pricingGetBudget(projId) : null;
  var pcfg = typeof _pricingGetConfig === 'function' ? _pricingGetConfig() : null;
  var monthlyService =
    typeof _pricingComputeMonthlyService === 'function' ? _pricingComputeMonthlyService(projId) : null;
  var phaseDefs = typeof _pricingPhaseDateDefs === 'function' ? _pricingPhaseDateDefs() : [];

  // EPC / one-time lump total — the Recommended tier's priced grand total (same figure the
  // Service Proposal's "Recommended Optimization Program" pricing represents), reused rather than
  // computed fresh.
  var lumpTotal = null;
  try {
    if (typeof _pricingComputeSummaryData === 'function' && typeof _pricingGetEstimate === 'function') {
      var estimate = _pricingGetEstimate(projId);
      var summary = _pricingComputeSummaryData(projId, estimate);
      if (summary && summary.tierTotals && summary.tierTotals.recommended) {
        lumpTotal = summary.tierTotals.recommended.grand;
      }
    }
  } catch (e) {
    lumpTotal = null;
  }

  // Effective Date — the day this Agreement is generated/executed (standard recital convention:
  // "made and entered into as of this day of ___, 20__"), NOT a phase/schedule date. Defaults to
  // today, editable via the modal's date input (same UX as the ASHRAE 36 modal's Report Date).
  var effDate = cfg.effectiveDate ? new Date(cfg.effectiveDate + 'T00:00:00') : new Date();
  if (isNaN(effDate)) effDate = new Date();

  // 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's sharpened rule, verbatim: "there is no
  // guarantee we will have an agreement for 2027 and 2028 so I would probably not anchor on that
  // date ever... That is a terrible idea."): initialTermEndLabel/renewalDateLabel used to derive a
  // literal calendar date ("December 31st, 2026" / "January 1, 2027") from
  // _PRICING_PHASE_DATE_RANGES[0].end (pricing-estimator.js) — a hardcoded phase schedule this
  // Agreement has no business assuming will still exist by the time it renews. Both DELETED.
  // _PRICING_PHASE_DATE_RANGES itself is untouched (pricing-estimator.js is owned by branch
  // fix/pricing-phases-and-sensor-hours; do not edit there). The Term/Renewal clauses below are now
  // expressed RELATIVE TO THE EFFECTIVE DATE ONLY — a fixed month count, never a calendar date — so
  // the Agreement's own text never depends on a phase schedule outliving the contract year it was
  // computed against. See initialTermText / the Renewal Term clause (_agreementCommercialRenderers,
  // rptPageAgreementTermTermination) for the rewritten legal language.
  var initialTermMonths = 12; // fixed contract term length, independent of any phase schedule

  return {
    project: { id: proj.id, name: clientName, client: clientName },
    templateType: cfg.templateType,
    templateLabel: AGREEMENT_TEMPLATE_LABELS[cfg.templateType],
    displayClient:
      typeof _rptProposalDisplayClientName === 'function' ? _rptProposalDisplayClientName(clientName) : clientName,
    legalClientName: clientName, // proj.client-first (see note above), unmodified beyond that resolution
    buildings: buildings,
    equipmentCount: equipmentCount,
    hourlyRate: pcfg ? pcfg.hourlyRate : null,
    allowanceAmount: budget ? budget.amount : null,
    monthlyService: monthlyService,
    initialTermMonths: initialTermMonths, // fixed month count from Effective Date — never a calendar date
    effectiveDate: effDate,
    lumpTotal: lumpTotal,
    escalationRate: cfg.escalationRate,
    escalationConfirmed: cfg.escalationConfirmed,
    minimumSpend: cfg.minimumSpend,
    minimumSpendConfirmed: cfg.minimumSpendConfirmed,
    cscPct: cfg.cscPct,
    clientPct: cfg.clientPct,
    rawDate: new Date().toISOString().slice(0, 10),
  };
}

// ─── Shared style tokens (matches rptPageASHRAE36ProposalCover's convention) ──────────────────────
var _AGR_HEAD = 'font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:10px 0 3px';
var _AGR_BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.42';
var _AGR_UL = 'margin:2px 0 4px;padding-left:18px;font-size:14px;color:var(--rpt-page-text);line-height:1.42';
var _AGR_SUBHEAD = 'font-size:14px;font-weight:700;color:var(--rpt-page-text);margin:6px 0 2px';

// ─── Page 1: Title + Recital + Scope (building list) ──────────────────────────────────────────
// 2026-07-28 fidelity fix (feature/energy-services-agreement): the Word original's page 1 is ONE
// page carrying the title, recital, AND the building scope list — not two separate pages. This
// function used to be a standalone hero/full-width-letterhead splash page (title + recital only),
// with the building list on its own following page (rptPageAgreementRecitalsScope, now folded in
// below). Merging them recovers the extra page the fidelity assessment flagged (6 pages generated
// vs. the Word original's 5) — no clause text, numbers, or bindings changed, only which physical
// page wraps them. hero:true/full-width letterhead replaced with smallHeaderImg (the SAME
// CSC_HEADER_B64 asset, inset at normal content width instead of stretched page-edge-to-edge) to
// match his page 1's smaller top-left-logo/right-aligned-tagline header, per
// joco-energy-services-agreement-base-2026-07-23.md's page-setup section (titlePg first-page
// header, image only, no text bar) and the base PNG/PDF renders.
function rptPageAgreementCover(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var esc = _agreementEsc;

  var title =
    '<div style="text-align:center;margin-bottom:10px" contenteditable="true">' +
    '<div style="font-size:19px;font-weight:700;color:var(--rpt-blue)">Energy Management Services Agreement</div>' +
    '</div>';

  var recitalText =
    'This Energy Management Services Agreement (the &ldquo;Agreement&rdquo;) is made and entered into as of ' +
    'this ' +
    esc(_agreementFmtDateLong(d.effectiveDate)) +
    ' (&ldquo;Effective Date&rdquo;), between Control Service Company (&ldquo;Contractor&rdquo;), and ' +
    esc(d.legalClientName) +
    ' (&ldquo;Client&rdquo;), for the purpose of providing services designed to save energy, water or other ' +
    'operating costs for the Client&rsquo;s property and buildings.';

  var recital = '<div style="' + _AGR_BODY + ';margin-top:14px" contenteditable="true">' + recitalText + '</div>';

  var templateNote =
    '<div style="' +
    _AGR_BODY +
    ';margin-top:16px;font-style:italic;color:var(--rpt-page-text)">Commercial Terms: ' +
    esc(d.templateLabel) +
    '</div>';

  var scopeHeading =
    '<div style="' +
    _AGR_BODY +
    ';margin-top:14px" contenteditable="true">The following buildings are included in the scope of this agreement:</div>';

  var listItems = d.buildings
    .map(function (b) {
      return '<li style="' + _AGR_BODY + ';margin-bottom:2px">' + esc(b) + '</li>';
    })
    .join('');

  var scopeList = d.buildings.length
    ? '<ol style="' + _AGR_UL + '" contenteditable="true">' + listItems + '</ol>'
    : '<div style="' +
      _AGR_BODY +
      ';font-style:italic;color:var(--rpt-orange)">No buildings are currently entered for this project — add buildings under the Utility Data tab so this list can populate.</div>';

  return rptPage(n, 'Energy Management Services Agreement', title + recital + templateNote + scopeHeading + scopeList, {
    data: fakeData,
    hero: false,
    hideIntHdr: true,
    smallHeaderImg: true,
  });
}

// ─── Commercial-terms renderers ────────────────────────────────────────────────────────────────
/**
 * _agreementCommercialRenderers — map of four renderers (blueprint component list). Each returns
 * plain HTML fragments for insertion into rptPageAgreementCommercialTerms and
 * rptPageAgreementTermTermination. monthlyAllowance is sourced directly from the JOCO base spec
 * (verbatim boilerplate, live-bound amounts). profitSharing is sourced directly from Louisburg's
 * real agreement (the client's own profit-share deal). epcFlatCost and oneTimeCost have NO source
 * document in either target — neither JOCO nor Louisburg represents those two deal types — so
 * their commercial-terms language below is original boilerplate authored to match the shared
 * structure; flagged explicitly in the implementer's report, not presented as verified client
 * language.
 */
var _agreementCommercialRenderers = {
  monthlyAllowance: function (d) {
    var esc = _agreementEsc;
    var allowanceStr =
      d.allowanceAmount != null
        ? _agreementSpellDollars(d.allowanceAmount)
        : '[monthly allowance amount not yet configured]';
    var rateStr = d.hourlyRate != null ? _agreementSpellDollars(d.hourlyRate) : '[hourly rate not yet configured]';
    var minSpendStr =
      d.minimumSpend != null ? '$' + Number(d.minimumSpend).toLocaleString('en-US') : '[not configured]';

    var servicesBullets =
      '<li style="' +
      _AGR_BODY +
      '">Implement optimized Alarm sequences.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Implement optimized trend sourcing.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Provide a monthly allowance up to the amount of ' +
      allowanceStr +
      ' (the &ldquo;Allowance&rdquo;). The Allowance may be utilized for labor, including onsite technical ' +
      'labor services billed at a rate of ' +
      rateStr +
      ' per hour, and/or for parts and materials billed at established contract rates. All such charges ' +
      'shall be applied against the Allowance in any combination necessary to support the Scope of Work. ' +
      'A minimum monthly spend of ' +
      minSpendStr +
      ' applies to maintain this Agreement in active status.' +
      _agreementUnconfirmedFlag(d.minimumSpendConfirmed) +
      '</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Provide tracking of all charges against the Allowance and make such records available to Client upon request.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Provide that any work or costs exceeding the Allowance shall require prior written authorization from Client before proceeding.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Provide the option for Client to approve an increased monthly Allowance with prior written authorization.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Upon Client&rsquo;s written request, parts and materials may be billed directly to Owner outside of this Allowance to preserve the remaining Allowance for labor and onsite technical services.</li>';

    return {
      servicesBullets: servicesBullets,
      servicesExcluded: 'Third party software costs and services are not included under this Agreement.',
      compensation:
        'Client shall pay Contractor the fees set forth in this Agreement as described in Section 1.1 above.',
      paymentSchedule:
        'Payments shall begin thirty (30) days after contract date. Client is responsible for paying its own energy bills.',
      utilityRebate:
        'Contractor shall assist with the application of any applicable utility rebates as part of this Agreement. Time expended performing such services shall be billed at the applicable labor rate and applied against the available labor hours under the Allowance.',
      hasRenewalEscalation: true,
      // 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's sharpened rule, verbatim: "there is
      // no guarantee we will have an agreement for 2027 and 2028 so I would probably not anchor on
      // that date ever... That is a terrible idea."): this used to state a literal calendar date
      // ("until December 31st, 2026") derived from a hardcoded phase schedule. Rewritten to express
      // the Initial Term RELATIVE TO THE EFFECTIVE DATE ONLY (a fixed month count, never a calendar
      // date), renewing automatically but explicitly terminable by either party's notice — reads as
      // an ordinary annual service agreement, not an assumed multi-year commitment.
      initialTermText:
        'This Agreement shall remain in effect for an initial term of twelve (12) months from the ' +
        'Effective Date, renewing automatically for successive one-year terms unless either party ' +
        'provides written notice of non-renewal at least sixty (60) days prior to the end of the ' +
        'then-current term.',
      earlyTerminationNoticeDays: 60,
      earlyTerminationReimbursement: false,
    };
  },

  profitSharing: function (d) {
    var minSpendStr = ''; // not applicable to this model
    var servicesBullets =
      '<li style="' +
      _AGR_BODY +
      '">Provide up to forty-five (45) labor hours of Energy Management services per calendar quarter, contingent upon Client&rsquo;s demonstrated cooperation and reasonable progress toward achieving measurable improvements in energy performance. In the event the Client fails to exhibit such cooperation or progress, the Contractor reserves the right, at its sole discretion, to reduce, defer, or withhold the allocation of labor hours. Of the total quarterly labor hours, up to eight (8) labor hours may be used for providing onsite technical labor services.</li>';

    return {
      servicesBullets: servicesBullets,
      servicesExcluded:
        'Equipment replacement and calibration services are not included under this Agreement. Retro-Commissioning (RCx) services are not included under this Agreement. Major reprogramming of BAS system graphics and program logic that are not for the purposes of saving energy are not included under this Agreement. Utility data management platform costs and services are not included under this Agreement.',
      compensation:
        'Client shall pay Contractor ' +
        d.cscPct +
        '% of verified energy savings each quarter, not to exceed ' +
        d.cscPct +
        '% of cumulative savings and rebates to date.',
      paymentSchedule:
        'Client shall provide utility bills to Contractor within thirty (30) days of receipt. Payments shall begin thirty (30) days after Contractor receives the first three (3) utility bills. The invoice, plus Client payments and utility rebate compensation to date for Services pursuant to this Agreement, shall not exceed ' +
        d.cscPct +
        '% of the actual savings to date. Contractor shall have the exclusive right to receive and retain one hundred percent (100%) of any and all utility rebate, incentive, or compensation funds, provided that Client has not yet paid Contractor an amount equal to at least ' +
        d.cscPct +
        '% of the total verified energy savings to date. In the event that Client has paid Contractor an amount equal to or exceeding ' +
        d.cscPct +
        '% of the verified energy savings, any utility rebate funds received shall be credited to the Client or applied toward remaining payments due under this Agreement. Client is responsible for paying its own energy bills. All the invoices during the partnership will be tracked and totaled quarterly.',
      utilityRebate:
        'Contractor will apply for all applicable utility rebates, and such rebates shall be attributed to the Compensation as set forth in the payment schedule. Client agrees to cooperate fully in the application, processing, and transfer of such utility rebate funds to Contractor.',
      hasRenewalEscalation: false,
      initialTermText: 'This Agreement shall remain in effect for three (3) years from the Effective Date.',
      earlyTerminationNoticeDays: 120,
      earlyTerminationReimbursement: true, // Louisburg-specific: "if terminated within first 12 months" clause
    };
  },

  epcFlatCost: function (d) {
    var totalStr =
      d.lumpTotal != null
        ? _agreementSpellDollars(d.lumpTotal)
        : '[project total not yet priced — import a pricing catalog and complete the Cost Estimate tab]';

    var servicesBullets =
      '<li style="' +
      _AGR_BODY +
      '">Implement optimized Alarm sequences.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Implement optimized trend sourcing.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Design, furnish, and install the full Scope of Work described in this Agreement for a fixed contract price of ' +
      totalStr +
      ', inclusive of hardware, programming, and installation labor.</li>' +
      '<li style="' +
      _AGR_BODY +
      '">Provide a performance guarantee period following completion of installation, during which Contractor will verify that the implemented measures are operating as designed.</li>';

    return {
      servicesBullets: servicesBullets,
      servicesExcluded: 'Third party software costs and services are not included under this Agreement.',
      compensation:
        'Client shall pay Contractor a fixed contract price of ' +
        totalStr +
        ' for the design, procurement, and installation of the Scope of Work described in Section 1.1 above.',
      paymentSchedule:
        'Payments shall be invoiced in three installments: thirty percent (30%) upon contract execution, forty percent (40%) upon completion of installation, and thirty percent (30%) upon final commissioning and Client acceptance.',
      utilityRebate:
        'Contractor shall assist Client in identifying and applying for any applicable utility rebates related to the Scope of Work.',
      hasRenewalEscalation: false,
      initialTermText:
        'This Agreement shall remain in effect for ten (10) years from the Effective Date (the performance guarantee period).',
      earlyTerminationNoticeDays: 60,
      earlyTerminationReimbursement: false,
    };
  },

  oneTimeCost: function (d) {
    var totalStr =
      d.lumpTotal != null
        ? _agreementSpellDollars(d.lumpTotal)
        : '[project total not yet priced — import a pricing catalog and complete the Cost Estimate tab]';

    var servicesBullets =
      '<li style="' +
      _AGR_BODY +
      '">Implement the Scope of Work described in this Agreement as a one-time project for a fixed price of ' +
      totalStr +
      ', inclusive of hardware, programming, and installation labor.</li>';

    return {
      servicesBullets: servicesBullets,
      servicesExcluded: 'Third party software costs and services are not included under this Agreement.',
      compensation:
        'Client shall pay Contractor a one-time fixed amount of ' +
        totalStr +
        ' for the Scope of Work described in Section 1.1 above.',
      paymentSchedule:
        'Payment in full is due within thirty (30) days of completion and Client&rsquo;s acceptance of the Scope of Work.',
      utilityRebate:
        'Contractor shall assist Client in identifying and applying for any applicable utility rebates related to the Scope of Work.',
      hasRenewalEscalation: false,
      initialTermText:
        'This Agreement shall remain in effect until completion of the Scope of Work described in Section 1.1, and shall automatically terminate upon Client&rsquo;s final acceptance.',
      earlyTerminationNoticeDays: 60,
      earlyTerminationReimbursement: false,
    };
  },
};

// ─── Page 3: Services of Contractor + Compensation and Payment Schedule ───────────────────────
function rptPageAgreementCommercialTerms(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var r = _agreementCommercialRenderers[d.templateType](d);

  var services =
    '<div style="' +
    _AGR_HEAD +
    '">1. Services of Contractor</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">1.1 Services:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">Provide Energy Management services to optimize the BAS System including but not limited to the following:</div>' +
    '<ul style="' +
    _AGR_UL +
    '" contenteditable="true">' +
    '<li style="' +
    _AGR_BODY +
    '">Implement optimized schedules.</li>' +
    '<li style="' +
    _AGR_BODY +
    '">Implement optimized set points.</li>' +
    '<li style="' +
    _AGR_BODY +
    '">Implement optimized sequences (resets, economizer logic, DCV).</li>' +
    r.servicesBullets +
    '<li style="' +
    _AGR_BODY +
    '">Provide training to Client staff and provide updated documentation and quick-reference guides.</li>' +
    '<li style="' +
    _AGR_BODY +
    '">Monthly scheduled meetings to review utility usage, costs, and feedback from the data analytics. These meetings will include discussion of anomalies identified and recommendations to improve operation.</li>' +
    '<li style="' +
    _AGR_BODY +
    '">Provide energy efficiency program informational materials for use, such as a flier on how the thermostats operate.</li>' +
    '<li style="' +
    _AGR_BODY +
    '">Advising on other energy related services and projects.</li>' +
    '</ul>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">1.2 Facility and BAS Access:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">Client shall provide Contractor with remote and on-site access to the BAS and facilities during normal business hours as needed.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">1.3 Services Excluded:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">' +
    r.servicesExcluded +
    '</div>';

  var compensation =
    '<div style="' +
    _AGR_HEAD +
    '">2. Compensation and payment schedule</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">2.1 Compensation:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">' +
    r.compensation +
    '</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">2.2 Payment Schedule:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">' +
    r.paymentSchedule +
    '</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">2.3 Late Payments:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">Late payments shall be subject to interest of 0.8% per month from the due date until paid.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">2.4 Non-Payments:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">If payment is not received within sixty (60) days, Contractor may suspend services until payment is made.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">2.5 Utility Rebate Assistance:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">' +
    r.utilityRebate +
    '</div>';

  return rptPage(n, 'Energy Management Services Agreement', services + compensation, {
    data: fakeData,
    hideIntHdr: true,
  });
}

// ─── Page 4: Term and Termination ──────────────────────────────────────────────────────────────
function rptPageAgreementTermTermination(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var r = _agreementCommercialRenderers[d.templateType](d);

  // NOTE ON DEFECT #3 (duplicated "Term:" heading): confirmed present in BOTH the JOCO source AND
  // Louisburg's own agreement (an independently-drafted, separately-dated document) — see the
  // implementer's diff report. That means it is a structural artifact of CSC's own template, not a
  // one-off JOCO typo, so it is reproduced here as literal boilerplate per the "surface, don't
  // silently fix" instruction, exactly as both source documents actually read.
  var termHeading =
    '<div style="' +
    _AGR_HEAD +
    '">3. Term and Termination</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">3.1 Term:</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">i. Term:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">1. ' +
    r.initialTermText +
    '</div>';

  // Roman-numeral sub-item labels computed dynamically rather than hardcoded, so omitting Renewal
  // Term (profitSharing/epcFlatCost/oneTimeCost) doesn't leave a skipped "ii." gap (i, [missing
  // ii], iii, iv) — the JOCO source's own numbering is Word's native auto-renumbering outline list,
  // which would never produce a gap either.
  var _romanNumerals = ['i', 'ii', 'iii', 'iv', 'v'];
  var _termRomanIdx = 1; // "i. Term:" already used index 0 above

  // 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's sharpened rule, verbatim: "there is no
  // guarantee we will have an agreement for 2027 and 2028 so I would probably not anchor on that
  // date ever... That is a terrible idea."): this used to key escalation to a literal calendar date
  // ("January 1, 2027") derived from a hardcoded phase schedule. Rewritten to key escalation to the
  // FIRST ANNIVERSARY OF THE EFFECTIVE DATE, and each anniversary thereafter — legally coherent with
  // initialTermText above (Initial Term = twelve (12) months from the Effective Date, so the first
  // renewal IS the first anniversary of the Effective Date; no separate date needs to be computed or
  // stated). Applied to BOTH the Allowance and the hourly labor rate stated in Section 1.1 — not
  // CPI-indexed. Compounding is annual (each year's increase applies to the prior year's already-
  // escalated amount, not the original base), consistent with rptPageContractProjection's existing
  // `Math.pow(1 + escalation/100, yr - 1)` contract-year compounding convention (report-engine.js),
  // the only other escalation-math precedent in this codebase.
  var renewal = r.hasRenewalEscalation
    ? '<div style="' +
      _AGR_SUBHEAD +
      '">' +
      _romanNumerals[_termRomanIdx++] +
      '. Renewal Term:</div>' +
      '<div style="' +
      _AGR_BODY +
      '" contenteditable="true">1. Beginning on the first anniversary of the Effective Date, and on ' +
      'each anniversary thereafter, the Allowance and the hourly labor rate described in Section ' +
      '1.1 shall each increase by a fixed escalation rate of ' +
      d.escalationRate +
      '% over the amount then in effect immediately prior to that renewal, compounding annually.' +
      _agreementUnconfirmedFlag(d.escalationConfirmed) +
      '</div>'
    : '';

  var reimbursementClause = r.earlyTerminationReimbursement
    ? ' If this Agreement is terminated by the Client within the first twelve (12) months from the Effective Date, the Client agrees to reimburse the Contractor for all direct and indirect costs incurred up to the date of termination. These costs may include, but are not limited to, labor, materials, subcontractor expenses, mobilization, engineering, and administrative overhead directly associated with the scope of work performed under this Agreement. Payment shall be due within thirty (30) days of receipt of an itemized invoice from the Contractor.'
    : ' If this Agreement is terminated by the Client, the Client agrees to reimburse the Contractor for all direct and indirect costs incurred up to the date of termination. These costs may include, but are not limited to, labor, materials, subcontractor expenses, mobilization, engineering, and administrative overhead directly associated with the scope of work performed under this Agreement. Payment shall be due within thirty (30) days of receipt of an itemized invoice from the Contractor.';

  var earlyTermination =
    '<div style="' +
    _AGR_SUBHEAD +
    '">' +
    _romanNumerals[_termRomanIdx++] +
    '. Without Cause Early Termination:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">1. This Agreement may be terminated without cause or penalty upon ' +
    (r.earlyTerminationNoticeDays === 120 ? 'one hundred and twenty (120)' : 'sixty (60)') +
    " days' written notice to the other party. Prior to termination, Client shall pay Contractor in full for services rendered through the termination date.</div>" +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">2.' +
    reimbursementClause +
    '</div>';

  var termination =
    '<div style="' +
    _AGR_SUBHEAD +
    '">' +
    _romanNumerals[_termRomanIdx++] +
    '. Termination:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">1. Upon termination or expiration of this agreement, neither party shall have any further obligations, except for those accrued prior to termination. Contractor shall provide all final reports and documentation within ninety (90) days of termination.</div>';

  return rptPage(n, 'Energy Management Services Agreement', termHeading + renewal + earlyTermination + termination, {
    data: fakeData,
    hideIntHdr: true,
  });
}

// ─── Page 5: General Provisions ────────────────────────────────────────────────────────────────
// fix/report-typography-and-pagination-merge (2026-07-29): split into TWO pages (4.1-4.6 / 4.7-4.9)
// — see the header comment right before the return statement below for the measured before/after
// numbers and why this specific split point was chosen. Returns an Array, matching the
// rptPageASHRAE36Executive/rptPageObservations convention already used elsewhere in this file for
// multi-page sections — see generateAgreementHTML for the caller-side spread.
function rptPageAgreementGeneralProvisions(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var esc = _agreementEsc;

  var html =
    '<div style="' +
    _AGR_HEAD +
    '">4. General Provisions</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.1 Governing Law:</div>' +
    // DIVERGENCE FLAGGED, NOT FIXED: JOCO's source names Missouri here even though the Client is
    // in Kansas. Louisburg's own parallel clause (a separately-dated, Kansas-based deal) names the
    // CLIENT's own state instead — evidence this may be an oversight in the JOCO source, not an
    // intentional CSC-favors-its-home-state clause. Reproduced verbatim from the JOCO source per
    // "surface, do not silently fix"; see the implementer's report for the full writeup.
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">This Agreement shall be governed by and construed in accordance with the laws of the State of Missouri, without regard to its conflict of law principles of any jurisdiction.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.2 Attorney&rsquo;s Fees and Cost:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">If either party hereto shall properly institute formal legal action, including mediation as described in Section 5.8 below, the prevailing party shall be entitled to reasonable attorney fees and costs in addition to any other relief which may be granted.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.3 Waiver:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">The waiver by either party to this Agreement of any one or more defaults, if any, on the part of the other, shall not be construed to operate as a waiver of any other or future defaults, under the same or different terms, conditions or covenants contained in this Agreement.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.4 Integration:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">This Agreement constitutes the entire contractual relationship between the parties with respect to the subject matter of this Agreement and supersedes any oral or written proposals, statements, discussions, negotiations, or other Agreements made prior to the Agreement. This Agreement may be amended at any time by mutual Agreement of the parties, provided that before any amendment shall be operative or valid, it shall be reduced to writing and signed by an authorized representative of both parties.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.5 Assignment:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">The performance of this Agreement may not be assigned or transferred by either party without the prior written consent of the other.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.6 Notices:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">All notices required to be given hereunder shall be in writing and shall be deemed delivered if (i) personally delivered, (ii) dispatched by certified or registered mail, return receipt requested, postage prepaid, or (iii) sent via a nationally recognized overnight carrier, addressed to the parties as follows:</div>' +
    '<table style="width:100%;margin-top:4px" contenteditable="true"><tr>' +
    '<td style="' +
    _AGR_BODY +
    ';vertical-align:top;width:50%">Contractor: Control Service Company<br>3621 NE Akin Drive<br>Lee&rsquo;s Summit, MO 64064</td>' +
    // No live "client mailing address" field exists anywhere in the project schema (grep-confirmed
    // — only building-level bldg.addr exists, not a project-level client address). Left as an
    // editable placeholder rather than guessing/inventing an address.
    '<td style="' +
    _AGR_BODY +
    ';vertical-align:top;width:50%">Client: ' +
    esc(d.legalClientName) +
    '<br>[Client mailing address — enter here]</td>' +
    '</tr></table>';

  // Split point: after 4.6 Notices (incl. its address table). 4.7 Limitation of Liability and 4.8
  // Dispute Resolution are the two longest clauses on this page (multiple full paragraphs each) —
  // moving 4.7-4.9 to a second page removes enough height to close the 291px/237px (screen/print)
  // overflow measured at the corrected 14px/10.5pt body size (headless re-measurement against real
  // JOCO data, before this split: page 4 rendered 1263px vs the 1056px design height / 972px
  // .rpt-body budget; after: both pages fit — see dashboardlogic.md 2026-07-29 entry for the
  // before/after numbers). No clause text was edited, shortened, or reworded — same html this
  // page has always rendered, just carried across two pages instead of one.
  var html2 =
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.7 Limitation of Liability:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">To the extent not prohibited by applicable law, in no event shall Contractor be liable for personal injury or any incidental, special, indirect or consequential damages whatsoever including, without limitation, damages for loss of revenue or profits, corruption or loss of data, failure to transmit or receive any data, ministry or business interruption or any other damages or losses, arising out of or related to Contractor&rsquo;s services or this Agreement, however caused, regardless of the theory of liability (whether contract, tort, or otherwise) and even if Contractor or Client has been advised of the possibility of such damages.</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">Some jurisdictions do not allow the limitation of liability for personal injury, or of incidental or consequential damages, so this limitation will not apply in such jurisdictions. In no event shall Contractor&rsquo;s total liability to Client for all damages (other than as may be required by applicable law in cases involving personal injury) exceed the amount of Five Thousand Dollars (U.S. $5,000.00). The foregoing limitations will apply even if the above stated remedy fails of its essential purpose.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.8 Dispute Resolution; Exclusive Venue and Jurisdiction:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">In the event of any dispute arising out of or relating to this Agreement, the parties agree to exclusively use the following process in the following order for such dispute: (a) informally discuss and attempt to resolve the dispute before proceeding with any further action; (b) in the event this is not successful, the parties agree to cooperatively arrange and participate in non-binding mediation; (c) in the event the mediation is not successful, the parties agree to cooperatively arrange and participate in binding arbitration; (d) in the event informal resolution, mediation and binding arbitration are not successful to resolve the dispute to the satisfaction of both parties, either party will then have the right to pursue litigation.</div>' +
    // DIVERGENCE FLAGGED, NOT FIXED (defect #1, base spec): JOCO's source names "Johnson County,
    // Missouri" — a different state than the Client's actual Kansas notice address. Reproduced
    // verbatim per "do not silently correct... report every divergence so he can approve it."
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">The exclusive venue of any action, suit, or proceeding arising out of or relating to this Agreement or any rights or obligations under this Agreement shall lie solely in the courts of the State of Missouri or the United States of America located in Johnson County, Missouri. The expense of any mediation shall be borne equally by Client and Contractor and shall be held in Johnson County.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    '">4.9 Counterparts:</div>' +
    '<div style="' +
    _AGR_BODY +
    '" contenteditable="true">This Agreement may be executed in any number of counterparts, each of which shall be deemed to be an original and all of which taken together shall constitute one Agreement. To evidence the fact that it has executed this Agreement, a party may send a copy of its executed counterpart to the other party by electronic transmission (including, without limitation, via email or facsimile) and the signature transmitted by such transmission shall be deemed to be that party&rsquo;s original signature for all purposes.</div>';

  return [
    rptPage(n, 'Energy Management Services Agreement', html, { data: fakeData, hideIntHdr: true }),
    rptPage(n + 1, 'Energy Management Services Agreement', html2, { data: fakeData, hideIntHdr: true }),
  ];
}

// ─── Page 5: Signature Block ───────────────────────────────────────────────────────────────────
function rptPageAgreementSignatureBlock(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var esc = _agreementEsc;

  var html =
    '<div style="' +
    _AGR_BODY +
    ';margin-top:10px" contenteditable="true">IN WITNESS WHEREOF, and intending to be legally bound, the parties hereto subscribe their names to this Agreement by their duly authorized officers on the date first above written.</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    ';margin-top:24px">CONTRACTOR:</div>' +
    '<div style="' +
    _AGR_BODY +
    ';margin-top:24px" contenteditable="true">Control Service Company&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;By: _____________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date: _____________</div>' +
    '<div style="' +
    _AGR_SUBHEAD +
    ';margin-top:24px">CLIENT:</div>' +
    '<div style="' +
    _AGR_BODY +
    ';margin-top:24px" contenteditable="true">' +
    esc(d.legalClientName) +
    '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;By: _____________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date: _____________</div>';

  // Signature page matches the Word original's own last page: same small logo/tagline letterhead
  // as page 1 (titlePg's "first" header applies per-section, and this page is the sole page of the
  // document's second section per joco-energy-services-agreement-base-2026-07-23.md's page-setup
  // section), no report title bar, and — verified directly against the base PDF's text layer
  // (page 5 carries a "5" run in the same footer position as pages 1-4) — a page number IS shown,
  // so noPageNum is intentionally left at its default (false) here.
  return rptPage(n, 'Energy Management Services Agreement', html, {
    data: fakeData,
    hideIntHdr: true,
    smallHeaderImg: true,
  });
}

// ─── generateAgreementHTML ─────────────────────────────────────────────────────────────────────
function generateAgreementHTML(projId, templateType, opts) {
  var d = collectAgreementData(projId, templateType, opts);
  if (!d) return null;

  function _tagAgreementSection(html, key) {
    return html.replace(/<div class="rpt-page([^"]*)"/, '<div class="rpt-page$1" data-section="' + key + '"');
  }

  var pages = [];
  var pageNum = 1;
  // 2026-07-28 fidelity fix: the building scope list is now rendered ON rptPageAgreementCover
  // itself (title + recital + scope list all share the Word original's one physical page 1) —
  // see that function's header comment. No separate 'agreementScope' page/section exists anymore.
  pages.push(_tagAgreementSection(rptPageAgreementCover(pageNum++, d), 'agreementCover'));
  pages.push(_tagAgreementSection(rptPageAgreementCommercialTerms(pageNum++, d), 'agreementCommercialTerms'));
  pages.push(_tagAgreementSection(rptPageAgreementTermTermination(pageNum++, d), 'agreementTermTermination'));
  // rptPageAgreementGeneralProvisions returns an Array (2026-07-29, split across 2 pages to fix
  // overflow at the corrected 14px/10.5pt body size — see that function's header comment).
  var _gpPages = rptPageAgreementGeneralProvisions(pageNum, d);
  _gpPages.forEach(function (pg) {
    pages.push(_tagAgreementSection(pg, 'agreementGeneralProvisions'));
    pageNum++;
  });
  pages.push(_tagAgreementSection(rptPageAgreementSignatureBlock(pageNum++, d), 'agreementSignature'));

  return { html: _injectPageNumbers(pages.join('\n')), data: d };
}

// ─── Modal wiring (openAgreementReportModal / generateAgreementPreview) ────────────────────────
// Modal markup ('agreementReportModal') is copied structurally from ashrae36ReportModal
// (report-engine.js:14823-14844 at this commit) — see the host HTML page.
function openAgreementReportModal(projId) {
  var modal = document.getElementById('agreementReportModal');
  if (!modal) {
    showToast('Agreement modal not found', 'error');
    return;
  }

  var cfg = _agreementGetConfig(projId);
  var esc = _agreementEsc;

  function radioRow(type) {
    return (
      '<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--s2);cursor:pointer">' +
      '<input type="radio" name="agrTemplateType" value="' +
      type +
      '" class="agrTemplateRadio" ' +
      (cfg.templateType === type ? 'checked' : '') +
      ' style="accent-color:var(--em);width:14px;height:14px">' +
      '<span style="font-size:12px;color:var(--text)">' +
      AGREEMENT_TEMPLATE_LABELS[type] +
      '</span>' +
      '</label>'
    );
  }

  var bodyHTML =
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Effective Date</div>' +
    '<input type="date" id="agrEffectiveDate" value="' +
    new Date().toISOString().slice(0, 10) +
    '" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px;width:180px">' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">Commercial Terms Template</div>' +
    '<div style="display:flex;flex-direction:column;gap:3px">' +
    AGREEMENT_TEMPLATE_TYPES.map(radioRow).join('') +
    '</div></div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Annual Escalation Rate (%)</div>' +
    '<input type="number" id="agrEscalationRate" value="' +
    cfg.escalationRate +
    '" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px;width:100px">' +
    '<label style="display:flex;align-items:center;gap:6px;margin-top:6px">' +
    '<input type="checkbox" id="agrEscalationConfirmed" ' +
    (cfg.escalationConfirmed ? 'checked' : '') +
    ' style="accent-color:var(--em)"><span style="font-size:11px;color:var(--text2)">Client has confirmed this rate</span></label>' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Minimum Monthly Spend ($)</div>' +
    '<input type="number" id="agrMinimumSpend" value="' +
    cfg.minimumSpend +
    '" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px;width:120px">' +
    '<label style="display:flex;align-items:center;gap:6px;margin-top:6px">' +
    '<input type="checkbox" id="agrMinimumSpendConfirmed" ' +
    (cfg.minimumSpendConfirmed ? 'checked' : '') +
    ' style="accent-color:var(--em)"><span style="font-size:11px;color:var(--text2)">Client has confirmed this amount</span></label>' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Profit-Share Split (Contractor %) — only used by the Profit Sharing template</div>' +
    '<input type="number" id="agrCscPct" value="' +
    cfg.cscPct +
    '" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px;width:100px">' +
    '</div>';

  var bodyEl = modal.querySelector('#agreementReportModalBody');
  if (bodyEl) bodyEl.innerHTML = bodyHTML;

  modal._agrProjId = projId;
  modal.classList.add('open');
}
window.openAgreementReportModal = openAgreementReportModal;

function generateAgreementPreview() {
  var modal = document.getElementById('agreementReportModal');
  if (!modal) return;
  var projId = modal._agrProjId;

  var templateRadio = modal.querySelector('.agrTemplateRadio:checked');
  var templateType = templateRadio ? templateRadio.value : 'monthlyAllowance';
  var effDateInput = document.getElementById('agrEffectiveDate');
  var escRateInput = document.getElementById('agrEscalationRate');
  var escConfirmedInput = document.getElementById('agrEscalationConfirmed');
  var minSpendInput = document.getElementById('agrMinimumSpend');
  var minSpendConfirmedInput = document.getElementById('agrMinimumSpendConfirmed');
  var cscPctInput = document.getElementById('agrCscPct');

  var cscPct = cscPctInput ? Number(cscPctInput.value) : 60;
  if (!isFinite(cscPct) || cscPct < 0 || cscPct > 100) cscPct = 60;

  var opts = {
    templateType: templateType,
    effectiveDate: effDateInput && effDateInput.value ? effDateInput.value : null,
    escalationRate: escRateInput ? Number(escRateInput.value) : 4,
    escalationConfirmed: !!(escConfirmedInput && escConfirmedInput.checked),
    minimumSpend: minSpendInput ? Number(minSpendInput.value) : 2768,
    minimumSpendConfirmed: !!(minSpendConfirmedInput && minSpendConfirmedInput.checked),
    cscPct: cscPct,
    clientPct: 100 - cscPct,
  };

  // Persist config (plain settings object — see file header re: what IS/ISN'T persisted here).
  _agreementSetConfig(projId, opts);

  var result = generateAgreementHTML(projId, templateType, opts);
  if (!result) {
    showToast('No project data found for this project.', 'error');
    return;
  }

  modal.classList.remove('open');
  var reportTitle = result.data.project.name + ' — Energy Management Services Agreement';

  result.data._agreement = { type: 'agreement', templateType: templateType, title: reportTitle };
  window._currentReportData = result.data;

  showReportOverlay(result.html, reportTitle);
  _updateOverlayPageNumbers();
}
window.generateAgreementPreview = generateAgreementPreview;
