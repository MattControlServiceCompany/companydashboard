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
