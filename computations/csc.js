// computations/csc.js — CSC compensation (canonical source)
// Pure functions with no closure dependencies.

function computeCscSplit(savings, cscCompensation, mode, fixedAmount, nMonths) {
  mode = mode || 'pct';
  var cscPct = (parseFloat(cscCompensation) || 0) / 100;
  var csc, client;
  if (!savings || savings <= 0) {
    csc = 0;
    client = savings || 0;
  } else if (mode === 'pct') {
    csc = savings * cscPct;
    client = savings - csc;
  } else {
    csc = (fixedAmount || 0) * (nMonths || 1);
    client = savings - csc;
  }
  return { csc: csc, client: client, cscPct: cscPct, clientPct: 1 - cscPct };
}

// computeMultiYearCscTotals — escalation-aware multi-year total for the contract's
// annual savings target, split into CSC/client shares. Sums each contract year's
// annualTarget compounded at `escalationPct`/yr (yearN = annualTarget * (1+esc/100)^(yr-1)),
// then applies cscPct/clientPct to each year before summing. This is the SAME math
// rptPageContractProjection's "Multi-Year Projection" table has always used
// (~report-engine.js line 4432); rptPageFinancial's "CSC Compensation" 3-Year Total used
// to just do annSavings * contractYrs with no escalation, so the two tables in the same
// report disagreed. Both now call this one function so they can't drift apart again.
// Returns per-year rows too, in case a caller wants the breakdown (contract projection
// table does).
function computeMultiYearCscTotals(annualTarget, escalationPct, contractYears, cscPct, clientPct) {
  annualTarget = annualTarget || 0;
  escalationPct = escalationPct || 0;
  contractYears = contractYears || 0;
  cscPct = cscPct || 0;
  clientPct = clientPct || 0;
  var years = [];
  var totalSavings = 0,
    totalCsc = 0,
    totalClient = 0;
  for (var yr = 1; yr <= contractYears; yr++) {
    var yearSavings = annualTarget * Math.pow(1 + escalationPct / 100, yr - 1);
    var yearCsc = (yearSavings * cscPct) / 100;
    var yearClient = (yearSavings * clientPct) / 100;
    years.push({ year: yr, savings: yearSavings, csc: yearCsc, client: yearClient });
    totalSavings += yearSavings;
    totalCsc += yearCsc;
    totalClient += yearClient;
  }
  return { totalSavings: totalSavings, totalCsc: totalCsc, totalClient: totalClient, years: years };
}
