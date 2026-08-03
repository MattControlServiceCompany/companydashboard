// Local fallback — only defined if computations/rates.js hasn't already defined it
if (typeof toKBtu === 'undefined') {
  function toKBtu(kwh, therms, gallons) {
    return (parseFloat(kwh) || 0) * 3.412 + (parseFloat(therms) || 0) * 100 + (parseFloat(gallons) || 0) * 91.5;
  }
}

// -----------------------------------------------------------------------
// collectReportData(projId, buildingIds, reportDateStr, reportType)
//
// Gathers ALL data needed for report generation into a single structured
// object. Every report page template reads from this object — no page
// template should access localStorage or compute savings directly.
//
// Adapted from the data-gathering portion of generatePerformanceReport().
// -----------------------------------------------------------------------
function collectReportData(projId, buildingIds, reportDateStr, reportType, selectedPeriod) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return null;

  let bldgs = getUDBldgs(projId);
  if (buildingIds && buildingIds.length) bldgs = bldgs.filter((b) => buildingIds.includes(String(b.id)));
  const useNormalized = p.baselineComparison === 'normalized';
  if (!bldgs.length) return null;

  const now = new Date();
  const monthNames = [
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
  const periodMonths = reportType === 'quarterly' ? 3 : 12;

  // --- Gather all post-baseline year-months and meter data ---
  let allPostYMs = [];
  const allBldgMeters = [];
  bldgs.forEach((b) => {
    const bZip = b.zip || '';
    let bWeatherByYm = null;
    if (bZip) {
      const wCache = wddLoadCache(bZip);
      if (wCache.length) {
        bWeatherByYm = {};
        wCache.forEach((r) => {
          bWeatherByYm[r.ym] = r;
        });
      }
    }
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      const energyCommodities = ['Electric', 'Gas', 'Propane'];
      if (!energyCommodities.includes(m.commodity)) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const incl = m.inclusive !== false;
      const allRows = bills.length ? getNormRows(m, bills, incl, bWeatherByYm) : [];
      const blEnd = bl.months.slice().sort().pop();
      const postRows = allRows.filter((r) => r.ym > blEnd);
      postRows.forEach((r) => {
        if (!allPostYMs.includes(r.ym)) allPostYMs.push(r.ym);
      });
      allBldgMeters.push({ b, m, bills, incl, allRows, bl, blEnd, postRows });
    });
  });
  allPostYMs.sort();

  // --- Determine reporting period year-months ---
  let reportYMs = [];
  if (reportType === 'quarterly') {
    const curQ = Math.ceil((now.getMonth() + 1) / 3);
    const curYr = now.getFullYear();

    // If the caller explicitly selected a quarter (e.g. user picked Q2 2026 in the modal),
    // use it directly — do NOT apply the !isCurrent guard. The guard is only for auto-selection.
    const explicitQ = selectedPeriod && selectedPeriod.quarter ? parseInt(selectedPeriod.quarter) : null;
    const explicitYr = selectedPeriod && selectedPeriod.year ? parseInt(selectedPeriod.year) : null;

    if (explicitQ && explicitYr) {
      // User explicitly selected a quarter — honour it even if it is the current in-progress quarter
      const startMo = (explicitQ - 1) * 3 + 1;
      const qYMs = [
        explicitYr + '-' + String(startMo).padStart(2, '0'),
        explicitYr + '-' + String(startMo + 1).padStart(2, '0'),
        explicitYr + '-' + String(startMo + 2).padStart(2, '0'),
      ];
      // Include only months that have post-baseline data (bills may be partial for current quarter)
      reportYMs = qYMs.filter((ym) => allPostYMs.includes(ym));
      // If no data at all for the chosen quarter, fall back to full quarter YMs so period label is correct
      if (!reportYMs.length) reportYMs = qYMs.slice();
      reportYMs._qLabel = 'Q' + explicitQ + ' ' + explicitYr;
      reportYMs._qStartMo = startMo;
      reportYMs._qYear = explicitYr;
      reportYMs._qNum = explicitQ;
    } else {
      // Auto-select: find the most recent COMPLETED quarter with data
      for (let attempt = 0; attempt < 8; attempt++) {
        let qNum = curQ - attempt;
        let yr = curYr;
        while (qNum <= 0) {
          qNum += 4;
          yr--;
        }
        const startMo = (qNum - 1) * 3 + 1;
        const qYMs = [
          yr + '-' + String(startMo).padStart(2, '0'),
          yr + '-' + String(startMo + 1).padStart(2, '0'),
          yr + '-' + String(startMo + 2).padStart(2, '0'),
        ];
        const hasData = qYMs.some((ym) => allPostYMs.includes(ym));
        const isCurrent = yr === curYr && qNum === curQ;
        if (hasData && !isCurrent) {
          reportYMs = qYMs.filter((ym) => allPostYMs.includes(ym));
          if (reportYMs.length === 0) continue;
          reportYMs._qLabel = 'Q' + qNum + ' ' + yr;
          reportYMs._qStartMo = startMo;
          reportYMs._qYear = yr;
          reportYMs._qNum = qNum;
          break;
        }
      }
    }
    if (!reportYMs.length) reportYMs = allPostYMs.slice(-3);
  } else {
    // Annual report: filter to the target year from reportDateStr (YYYY-MM-DD).
    // Fall back to the most recent 12 months if no date or no data for that year.
    var _annualYear = reportDateStr ? parseInt(reportDateStr.split('-')[0]) : null;
    if (_annualYear) {
      var _yearFiltered = allPostYMs.filter(function (ym) {
        return parseInt(ym.split('-')[0]) === _annualYear;
      });
      reportYMs = _yearFiltered.length ? _yearFiltered : allPostYMs.slice(-12);
    } else {
      reportYMs = allPostYMs.slice(-12);
    }
  }
  const reportStart = reportYMs[0] || '';
  const reportEnd = reportYMs[reportYMs.length - 1] || '';

  // Build period label
  let periodLabel = '';
  let periodQuarter = null;
  let periodYear = null;
  if (reportType === 'quarterly' && reportYMs._qStartMo) {
    const qStart = monthNames[reportYMs._qStartMo - 1];
    const qEnd = monthNames[reportYMs._qStartMo + 1];
    periodLabel = qStart + ' ' + reportYMs._qYear + ' through ' + qEnd + ' ' + reportYMs._qYear;
    periodQuarter = reportYMs._qNum;
    periodYear = reportYMs._qYear;
  } else {
    const rpStartMonth = reportStart ? monthNames[parseInt(reportStart.split('-')[1]) - 1] : '';
    const rpStartYear = reportStart ? reportStart.split('-')[0] : '';
    const rpEndMonth = reportEnd ? monthNames[parseInt(reportEnd.split('-')[1]) - 1] : '';
    const rpEndYear = reportEnd ? reportEnd.split('-')[0] : '';
    periodLabel =
      rpStartYear === rpEndYear
        ? rpStartMonth + ' ' + rpStartYear + ' through ' + rpEndMonth + ' ' + rpEndYear
        : rpStartMonth + ' ' + rpStartYear + ' through ' + rpEndMonth + ' ' + rpEndYear;
    periodYear = parseInt(rpEndYear) || now.getFullYear();
  }

  // --- Contract info ---
  const contractYears = parseInt(p.contractYears) || 3;
  const escalation = parseFloat(p.escalation) || 0;
  const cscComp = parseFloat(p.cscCompensation) || 0;
  const clientPct = 100 - cscComp;
  const contractStart = p.start ? new Date(p.start + 'T00:00:00') : null;

  let contractYearNum = 1;
  if (contractStart) {
    const msElapsed = now - contractStart;
    contractYearNum = Math.max(1, Math.min(contractYears, Math.ceil(msElapsed / (365.25 * 86400000))));
  }

  // --- Baseline costs from single source of truth ---
  const baselineMoMap = aggBaseMoMapForBldgs(bldgs);

  // --- Per-building data ---
  const totalSqft = bldgs.reduce((s, b) => s + parseInt(b.sqft || 0), 0);
  // Accumulators for project-wide totals
  let totKwhSaved = 0,
    totKwhBl = 0,
    totKwhCur = 0;
  let totThermsSaved = 0,
    totThermsBl = 0,
    totThermsCur = 0;
  let totPropaneSaved = 0,
    totPropaneBl = 0,
    totPropaneCur = 0;
  let totPeakKwBl = 0,
    totPeakKwCur = 0;
  let totBlCost = 0,
    totCurCost = 0,
    totSavings = 0,
    totCumSavings = 0;
  let totAnnBlKBtu = 0,
    totAnnCurKBtu = 0;

  const buildingsData = bldgs.map((b) => {
    const sqft = parseInt(b.sqft || 0);
    const bType = b.type || p.type || 'Other';
    let cumSavings = 0,
      periodSavings = 0;
    let annBlKBtu = 0,
      annCurKBtu = 0;
    const commoditySet = new Set();

    // Per-commodity accumulators for this building
    const elec = {
      kwhBl: 0,
      kwhCur: 0,
      kwhSaved: 0,
      kwBl: 0,
      kwCur: 0,
      costBl: 0,
      costCur: 0,
      costSaved: 0,
      monthly: [],
    };
    const gas = { thermsBl: 0, thermsCur: 0, thermsSaved: 0, costBl: 0, costCur: 0, costSaved: 0, monthly: [] };
    const propane = { galBl: 0, galCur: 0, galSaved: 0, costBl: 0, costCur: 0, costSaved: 0, monthly: [] };

    // Monthly commodity data maps (keyed by YYYY-MM)
    const elecMonthly = {};
    const gasMonthly = {};
    const propaneMonthly = {};

    const bMeters = allBldgMeters.filter((x) => x.b === b);

    // Per-building savings % from Building Savings Projection config
    const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
    const bspCfg = DB.get(bspKey, {});
    const bldgSavPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;

    bMeters.forEach(({ m, bills, incl, allRows, bl, blEnd, postRows }) => {
      commoditySet.add(m.commodity);
      const blRows = allRows.filter((r) => bl.months.includes(r.ym));
      const { elecByMo: eM, gasByMo: gM, propaneByMo: pM, waterByMo: wM } = buildMoMap(m, blRows, bills, incl);

      const isElec = m.commodity === 'Electric';
      const isPropane = m.commodity === 'Propane';

      // Expected usage by calendar month — use buildMoMap (matches canonical savings function)
      const _moMapR = isElec ? eM : m.commodity === 'Gas' ? gM : isPropane ? pM : wM;
      const blByCalMo = {};
      Object.entries(_moMapR).forEach(([mo, v]) => {
        blByCalMo[mo] = isElec ? v.kwh : m.commodity === 'Gas' ? v.therms : isPropane ? v.gallons : v.kgal;
      });
      const hasBlCalMap = Object.keys(blByCalMo).length >= 3;
      const hasRegrP = allRows.some((r) => r.regrBaseline != null);
      const blAvg = blRows.length ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length : 0;

      // Baseline demand kW by calendar month (electric only)
      const blDemKWByCalMo = {};
      Object.entries(eM).forEach(([mo, v]) => {
        blDemKWByCalMo[mo] = v.billedKW || v.demandKW || 0;
      });

      // Raw usage by year-month
      const rawUsageByYm = {};
      if (isElec) {
        bills.forEach((b2) => {
          const ym = normMonth(b2.start, b2.end, incl, bills);
          if (ym) rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + (parseFloat(b2.kwh) || parseFloat(b2.usage) || 0);
        });
      } else if (!isPropane) {
        bills.forEach((b2) => {
          const ym = normMonth(b2.start, b2.end, incl, bills);
          if (!ym) return;
          const actUsage =
            m.commodity === 'Gas'
              ? parseFloat(b2.therms || b2.usage || 0)
              : parseFloat(b2.waterUsage || b2.sewerUsage || b2.usage || 0);
          rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + actUsage;
        });
      } else {
        allRows.forEach((r) => {
          rawUsageByYm[r.ym] = r.usage;
        });
      }

      // Baseline cost by calendar month (per-meter, from buildMoMap)
      const blCostByCalMo = {};
      if (isElec) {
        Object.entries(eM).forEach(([mo, v]) => {
          blCostByCalMo[mo] = v.commodityCost || v.totalCost || 0;
        });
      } else if (isPropane) {
        Object.entries(pM).forEach(([mo, v]) => {
          blCostByCalMo[mo] = v.cost || 0;
        });
      } else {
        const _costMap = m.commodity === 'Gas' ? gM : wM;
        Object.entries(_costMap).forEach(([mo, v]) => {
          blCostByCalMo[mo] = v.cost || 0;
        });
      }

      // Actual cost savings from single source of truth
      const meterSavByYM = getMeterSavings(m, bills, incl, projId, b.id).byYM;

      // Process post-baseline rows within the reporting period
      postRows.forEach((r) => {
        const calMo = parseInt(r.ym.split('-')[1]) - 1;
        const bfr = isPropane ? [] : bills.filter((b2) => normMonth(b2.start, b2.end, incl, bills) === r.ym);
        if (!isPropane && !bfr.length) return;

        const expUsage =
          hasBlCalMap && blByCalMo[calMo] != null ? blByCalMo[calMo] : r.regrBaseline != null ? r.regrBaseline : blAvg;
        const actUsage = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
        const inPeriod = reportYMs.includes(r.ym);

        const totalCostSav = meterSavByYM[r.ym] || 0;

        if (isElec) {
          const actKwh = actUsage;
          const blExpKW = blDemKWByCalMo[calMo] || 0;
          const actDemKW = bfr.length ? Math.max(...bfr.map((b2) => parseFloat(b2.demandKW || 0))) : 0;
          const kwhCostAmt = bfr.reduce((s, b2) => s + parseFloat(b2.kwhCost || 0), 0);
          const kwCostAmt = bfr.reduce((s, b2) => s + parseFloat(b2.kwCost || 0), 0);
          const facKWCostAmt = bfr.reduce((s, b2) => s + parseFloat(b2.facKWCost || 0), 0);

          // Always populate monthly map (full year for charts)
          if (!elecMonthly[r.ym])
            elecMonthly[r.ym] = { bl: 0, cur: 0, kwBl: 0, kwCur: 0, blCost: 0, curCost: 0, savings: 0 };
          elecMonthly[r.ym].bl += expUsage;
          elecMonthly[r.ym].cur += actKwh;
          elecMonthly[r.ym].kwBl += blExpKW;
          elecMonthly[r.ym].kwCur += actDemKW;
          elecMonthly[r.ym].blCost += blCostByCalMo[calMo] || 0;
          elecMonthly[r.ym].curCost += kwhCostAmt + kwCostAmt + facKWCostAmt;
          elecMonthly[r.ym].savings += totalCostSav;

          if (inPeriod) {
            elec.kwhBl += expUsage;
            elec.kwhCur += actKwh;
            elec.kwhSaved += expUsage - actKwh;
            elec.kwBl += blExpKW;
            elec.kwCur += actDemKW;
            elec.costBl += blCostByCalMo[calMo] || 0;
            elec.costCur += kwhCostAmt + kwCostAmt + facKWCostAmt;
            elec.costSaved += totalCostSav;
          }
        } else if (isPropane) {
          // Always populate monthly map (full year for charts)
          if (!propaneMonthly[r.ym]) propaneMonthly[r.ym] = { bl: 0, cur: 0, blCost: 0, curCost: 0, savings: 0 };
          propaneMonthly[r.ym].bl += expUsage;
          propaneMonthly[r.ym].cur += actUsage;
          propaneMonthly[r.ym].blCost += blCostByCalMo[calMo] || 0;
          propaneMonthly[r.ym].curCost += r.cost || 0;
          propaneMonthly[r.ym].savings += totalCostSav;

          if (inPeriod) {
            propane.galBl += expUsage;
            propane.galCur += actUsage;
            propane.galSaved += expUsage - actUsage;
            propane.costBl += blCostByCalMo[calMo] || 0;
            propane.costCur += r.cost || 0;
            propane.costSaved += totalCostSav;
          }
        } else {
          const actTherms = actUsage;
          const actThermCost = bfr.reduce(
            (s, b2) => s + (parseFloat(b2.gasCharge) || parseFloat(b2.thermCost) || parseFloat(b2.cost) || 0),
            0,
          );

          // Always populate monthly map (full year for charts)
          if (!gasMonthly[r.ym]) gasMonthly[r.ym] = { bl: 0, cur: 0, blCost: 0, curCost: 0, savings: 0 };
          gasMonthly[r.ym].bl += expUsage;
          gasMonthly[r.ym].cur += actTherms;
          gasMonthly[r.ym].blCost += blCostByCalMo[calMo] || 0;
          gasMonthly[r.ym].curCost += actThermCost;
          gasMonthly[r.ym].savings += totalCostSav;

          if (inPeriod) {
            gas.thermsBl += expUsage;
            gas.thermsCur += actTherms;
            gas.thermsSaved += expUsage - actTherms;
            gas.costBl += blCostByCalMo[calMo] || 0;
            gas.costCur += actThermCost;
            gas.costSaved += totalCostSav;
          }
        }

        cumSavings += totalCostSav;
        if (inPeriod) periodSavings += totalCostSav;
      });

      // Annual EUI — baseline and current (rolling 12 months)
      const blBills = _dashGetBaselineBills(m);
      if (m.commodity === 'Gas') {
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(0, parseFloat(bill.therms) || 0, 0);
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(0, parseFloat(bill.therms) || 0, 0);
        });
      } else if (m.commodity === 'Propane') {
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(
            0,
            0,
            parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0,
          );
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(
            0,
            0,
            parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0,
          );
        });
      } else {
        // Electric
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
        });
      }
    });

    // Build monthly arrays from ALL available months (full year for charts)
    const allElecYMs = Object.keys(elecMonthly).sort();
    const allGasYMs = Object.keys(gasMonthly).sort();
    const allPropYMs = Object.keys(propaneMonthly).sort();
    elec.monthly = allElecYMs.map((ym) => {
      const mo = elecMonthly[ym] || {};
      return {
        month: ym,
        bl: mo.bl || 0,
        cur: mo.cur || 0,
        kwBl: mo.kwBl || 0,
        kwCur: mo.kwCur || 0,
        blCost: mo.blCost || 0,
        curCost: mo.curCost || 0,
        savings: mo.savings || 0,
      };
    });
    gas.monthly = allGasYMs.map((ym) => ({
      month: ym,
      bl: (gasMonthly[ym] || {}).bl || 0,
      cur: (gasMonthly[ym] || {}).cur || 0,
      blCost: (gasMonthly[ym] || {}).blCost || 0,
      curCost: (gasMonthly[ym] || {}).curCost || 0,
      savings: (gasMonthly[ym] || {}).savings || 0,
    }));
    propane.monthly = allPropYMs.map((ym) => ({
      month: ym,
      bl: (propaneMonthly[ym] || {}).bl || 0,
      cur: (propaneMonthly[ym] || {}).cur || 0,
      blCost: (propaneMonthly[ym] || {}).blCost || 0,
      curCost: (propaneMonthly[ym] || {}).curCost || 0,
      savings: (propaneMonthly[ym] || {}).savings || 0,
    }));

    // EUI calculations — period-matched comparison (same months for baseline and current)
    const reportCalMonths = reportYMs.map((ym) => parseInt(ym.split('-')[1]));
    let periodBlKBtu = 0,
      periodCurKBtu = 0;
    let periodBlMoCt = 0,
      periodCurMoCt = 0;
    const blMoSet = new Set();
    const curMoSet = new Set();
    bMeters.forEach(({ m: mt, bills: mtBills, bl: mtBl, incl: mtIncl }) => {
      const mtBlBills = _dashGetBaselineBills(mt);
      mtBlBills.forEach((bill) => {
        const ym = normMonth(bill.start, bill.end, mtIncl, mtBills);
        if (!ym) return;
        blMoSet.add(ym);
        const calMo = parseInt(ym.split('-')[1]);
        if (reportCalMonths.includes(calMo)) {
          const kbtu =
            mt.commodity === 'Gas'
              ? toKBtu(0, parseFloat(bill.therms) || 0, 0)
              : mt.commodity === 'Propane'
                ? toKBtu(0, 0, parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0)
                : toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
          periodBlKBtu += kbtu;
          periodBlMoCt++;
        }
      });
      mtBills
        .filter((bill) => {
          const ym = normMonth(bill.start, bill.end, mtIncl, mtBills);
          return ym && reportYMs.includes(ym);
        })
        .forEach((bill) => {
          const ym = normMonth(bill.start, bill.end, mtIncl, mtBills);
          if (!ym) return;
          curMoSet.add(ym);
          const kbtu =
            mt.commodity === 'Gas'
              ? toKBtu(0, parseFloat(bill.therms) || 0, 0)
              : mt.commodity === 'Propane'
                ? toKBtu(0, 0, parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0)
                : toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
          periodCurKBtu += kbtu;
          periodCurMoCt++;
        });
    });
    const blEUI = sqft > 0 && periodBlMoCt > 0 ? ((periodBlKBtu / periodBlMoCt) * 12) / sqft : 0;
    const curEUI = sqft > 0 && periodCurMoCt > 0 ? ((periodCurKBtu / periodCurMoCt) * 12) / sqft : 0;
    const cbecsEUI = CBECS_EUI[bType] || CBECS_EUI['Other'] || 52.4;
    const pctiles = CBECS_PERCENTILES[bType] || CBECS_PERCENTILES['Other'] || [28, 52.4, 80];
    let pctileLabel = '';
    if (curEUI > 0) {
      if (curEUI <= pctiles[0]) pctileLabel = 'Top 25%';
      else if (curEUI <= pctiles[1]) pctileLabel = '25-50th';
      else if (curEUI <= pctiles[2]) pctileLabel = '50-75th';
      else pctileLabel = 'Bottom 25%';
    }
    const energyStarEligible = curEUI > 0 && curEUI < pctiles[0];

    // EUI trend (cost per sqft)
    const totalBldgBlCost = elec.costBl + gas.costBl + propane.costBl;
    const totalBldgCurCost = elec.costCur + gas.costCur + propane.costCur;
    const costPerSqft = sqft > 0 ? totalBldgCurCost / sqft : 0;

    // Building savings percentage and status
    const bldgSavings = periodSavings;
    const bldgBlCost = totalBldgBlCost;
    const bldgCurCost = totalBldgCurCost;
    const bldgSavingsPct = bldgBlCost > 0 ? (bldgSavings / bldgBlCost) * 100 : 0;
    const targetPct = bldgSavPct * 100;
    let bldgStatus = 'on_track';
    if (bldgSavingsPct < targetPct * 0.8) bldgStatus = 'below_target';
    else if (bldgSavingsPct < targetPct) bldgStatus = 'near_target';

    // Accumulate project totals
    totKwhBl += elec.kwhBl;
    totKwhCur += elec.kwhCur;
    totKwhSaved += elec.kwhSaved;
    totThermsBl += gas.thermsBl;
    totThermsCur += gas.thermsCur;
    totThermsSaved += gas.thermsSaved;
    totPropaneBl += propane.galBl;
    totPropaneCur += propane.galCur;
    totPropaneSaved += propane.galSaved;
    totPeakKwBl += elec.kwBl;
    totPeakKwCur += elec.kwCur;
    totBlCost += bldgBlCost;
    totCurCost += bldgCurCost;
    totSavings += bldgSavings;
    totCumSavings += cumSavings;
    totAnnBlKBtu += annBlKBtu;
    totAnnCurKBtu += annCurKBtu;

    return {
      id: b.id,
      name: b.name,
      sqft,
      type: bType,
      address: b.addr || '',
      commodities: Array.from(commoditySet),
      electric: elec,
      gas,
      propane,
      savings: bldgSavings,
      blCost: bldgBlCost,
      curCost: bldgCurCost,
      savingsPct: bldgSavingsPct,
      targetPct: targetPct,
      status: bldgStatus,
      eui: {
        baseline: blEUI,
        current: curEUI,
        cbecs: cbecsEUI,
        percentile: pctileLabel,
        energyStar: energyStarEligible,
        costPerSqft,
        trend: blEUI > 0 ? ((curEUI - blEUI) / blEUI) * 100 : 0,
      },
    };
  });

  // --- Project totals ---
  const totSavingsPct = totBlCost > 0 ? (totSavings / totBlCost) * 100 : 0;
  // Annualize project EUI: weighted average of per-building annualized EUIs
  let _euiBlWt = 0,
    _euiCurWt = 0,
    _euiSqftSum = 0;
  buildingsData.forEach(function (bd) {
    var s = bd.sqft || 0;
    if (s > 0) {
      _euiBlWt += (bd.eui.baseline || 0) * s;
      _euiCurWt += (bd.eui.current || 0) * s;
      _euiSqftSum += s;
    }
  });
  const euiBaseline = _euiSqftSum > 0 ? _euiBlWt / _euiSqftSum : 0;
  const euiCurrent = _euiSqftSum > 0 ? _euiCurWt / _euiSqftSum : 0;

  // Quarterly targets from measures only — no percentage fallback
  const annualBaseline = Object.values(baselineMoMap).reduce((s, v) => s + v, 0);
  const _rptProjSavByMo = Array(12).fill(0);
  bldgs.forEach((b) => {
    const msrSav = getBldgMeasureSavingsByMo(projId, b.id);
    if (msrSav) {
      msrSav.forEach((v, mo) => {
        _rptProjSavByMo[mo] += v;
      });
    }
  });
  const annualTarget = _rptProjSavByMo.reduce((s, v) => s + v, 0);
  const avgSavPct = annualBaseline > 0 ? annualTarget / annualBaseline : 0;
  const quarterlyTargets = [0, 1, 2, 3].map((qi) => {
    let qSav = 0;
    for (let mo = qi * 3; mo < qi * 3 + 3; mo++) qSav += _rptProjSavByMo[mo];
    return qSav;
  });

  // --- Chart images ---
  const chartImages = {};
  if (typeof _maCharts === 'object' && _maCharts) {
    Object.entries(_maCharts).forEach(([key, chart]) => {
      try {
        if (chart && typeof chart.toBase64Image === 'function') {
          chartImages[key] = chart.toBase64Image();
        }
      } catch (e) {
        /* chart may not be rendered */
      }
    });
  }

  // --- Pollution credits ---
  const stateCode = extractStateFromAddress(p.addr);
  let pollution = {
    pollutants: {},
    equivalents: {},
    stateCode,
    inputs: { kwhSaved: 0, thermsSaved: 0, propaneGalSaved: 0 },
  };
  try {
    // Clamp to zero: negative savings (usage increase) produce zero pollution credits,
    // not negative ones. Dashboard (graphics-setpoints.js) must match this behavior.
    pollution = calculatePollutionCredits(
      Math.max(0, totKwhSaved),
      Math.max(0, totThermsSaved),
      Math.max(0, totPropaneSaved),
      stateCode,
    );
  } catch (e) {
    /* pollution calc not critical */
  }

  // --- Weather data ---
  const weather = collectWeatherData(allBldgMeters, reportYMs);

  // --- Setpoints ---
  const setpoints = (p.setpoints || []).map((sp) => {
    const bldg = bldgs.find((b) => String(b.id) === String(sp.buildingId));
    return {
      buildingId: sp.buildingId,
      buildingName: bldg ? bldg.name : 'Unknown',
      zones: sp.zones || [],
      viewMode: sp.viewMode || 'individual',
    };
  });

  // --- Meetings (for observations/recommendations context) ---
  const meetings = (p.meetings || []).map((m) => ({
    id: m.id,
    date: m.date,
    type: m.type,
    sectionHeading: m.sectionHeading,
    items: m.items || [],
  }));

  // --- Baseline period dates ---
  let blPeriodStart = null,
    blPeriodEnd = null;
  allBldgMeters.forEach(({ bl }) => {
    if (bl && bl.months && bl.months.length) {
      const sorted = bl.months.slice().sort();
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (!blPeriodStart || first < blPeriodStart) blPeriodStart = first;
      if (!blPeriodEnd || last > blPeriodEnd) blPeriodEnd = last;
    }
  });
  const blStartLabel = blPeriodStart
    ? monthNames[parseInt(blPeriodStart.split('-')[1]) - 1] + ' ' + blPeriodStart.split('-')[0]
    : '—';
  const blEndLabel = blPeriodEnd
    ? monthNames[parseInt(blPeriodEnd.split('-')[1]) - 1] + ' ' + blPeriodEnd.split('-')[0]
    : '—';

  // --- Per-building meter regression data + baseline month maps for appendices ---
  buildingsData.forEach((bd) => {
    const bMeters = allBldgMeters.filter((x) => x.b.id === bd.id || x.b.name === bd.name);
    bd.meterDetails = [];
    // Store full baseline month maps for Building Baseline Data table
    bd.baselineMaps = { elecByMo: {}, gasByMo: {}, propaneByMo: {}, waterByMo: {} };
    bMeters.forEach(({ m, bl, allRows, bills, incl }) => {
      if (!bl || !bl.months || bl.months.length < 3) return;
      const blR = allRows.filter((r) => bl.months.includes(r.ym));
      const maps = buildMoMap(m, blR, bills, incl);
      if (m.commodity === 'Electric') Object.assign(bd.baselineMaps.elecByMo, maps.elecByMo);
      else if (m.commodity === 'Gas') Object.assign(bd.baselineMaps.gasByMo, maps.gasByMo);
      else if (m.commodity === 'Propane') Object.assign(bd.baselineMaps.propaneByMo, maps.propaneByMo);
      else if (m.commodity === 'Water') Object.assign(bd.baselineMaps.waterByMo, maps.waterByMo);
    });
    bMeters.forEach(({ m, bl, allRows }) => {
      const reg = m._reg || (bl && bl.reg) || null;
      const blMonths = bl ? bl.months.slice().sort() : [];
      const blStart = blMonths[0] || '';
      const blEnd = blMonths[blMonths.length - 1] || '';
      const blR = allRows.filter((r) => bl.months.includes(r.ym));
      const annUsage = blR.reduce((s, r) => s + (r.usage || 0), 0);
      const annCost = blR.reduce((s, r) => s + (r.cost || 0), 0);
      const blYears = blMonths.length / 12 || 1;
      var bestR2 = '—';
      var regrType = '—';
      if (reg) {
        if (reg.dual && reg.dual.r2 != null) {
          bestR2 = reg.dual.r2.toFixed(3);
          regrType = 'OLS / HDD+CDD';
        } else if (m.commodity === 'Electric' && reg.cdd && reg.cdd.r2 != null) {
          bestR2 = reg.cdd.r2.toFixed(3);
          regrType = 'OLS / CDD';
        } else if (reg.hdd && reg.hdd.r2 != null) {
          bestR2 = reg.hdd.r2.toFixed(3);
          regrType = 'OLS / HDD';
        }
      }
      var totalHDD = blR.reduce((s, r) => s + (r.hdd || 0), 0);
      var totalCDD = blR.reduce((s, r) => s + (r.cdd || 0), 0);
      var regrCoeffs = null;
      if (reg) {
        if (reg.dual && reg.dual.r2 != null) {
          regrCoeffs = {
            type: 'dual',
            intercept: reg.dual.intercept,
            slopeHDD: reg.dual.slopeHDD,
            slopeCDD: reg.dual.slopeCDD,
          };
        } else if (m.commodity === 'Electric' && reg.cdd && reg.cdd.r2 != null) {
          regrCoeffs = { type: 'cdd', intercept: reg.cdd.intercept, slope: reg.cdd.slope };
        } else if (reg.hdd && reg.hdd.r2 != null) {
          regrCoeffs = { type: 'hdd', intercept: reg.hdd.intercept, slope: reg.hdd.slope };
        }
      }
      bd.meterDetails.push({
        commodity: m.commodity,
        account: m.account || '',
        blStart,
        blEnd,
        blMonths: blMonths.slice(),
        regrType: regrType,
        r2: bestR2,
        hdd: Math.round(totalHDD / blYears),
        cdd: Math.round(totalCDD / blYears),
        usagePerYear: Math.round(annUsage / blYears),
        costPerYear: Math.round(annCost / blYears),
        regrCoeffs: regrCoeffs,
      });
    });
  });

  // --- Raw utility bills for Appendix D ---
  const rawBills = [];
  allBldgMeters.forEach(({ b, m, bills }) => {
    (bills || []).forEach((bill) => {
      var _billYm =
        normMonth(bill.start, bill.end, m.inclusive !== false, bills) || (bill.start ? bill.start.substring(0, 7) : '');
      if (!reportYMs.includes(_billYm)) return;
      rawBills.push({
        building: b.name || '—',
        commodity: m.commodity,
        provider: m.provider || bill.provider || '—',
        account: m.account || bill.account || '—',
        start: bill.start || '',
        end: bill.end || '',
        kwh: parseFloat(bill.kwh) || parseFloat(bill.usage) || 0,
        kw: parseFloat(bill.demandKW) || 0,
        therms: parseFloat(bill.therms) || 0,
        gallons: parseFloat(bill.gallonsDelivered) || 0,
        amount: parseFloat(bill.totalCost) || parseFloat(bill.cost) || 0,
        billDate: bill.billDate || bill.end || '',
        pdfKey: bill.pdfKey || null,
      });
    });
  });

  // --- Assemble final object ---
  return {
    project: {
      id: p.id,
      name: p.name,
      client: p.client || p.name || '',
      type: p.type || 'Other',
      addr: p.addr || '',
      sqft: totalSqft,
      blStart: blStartLabel,
      blEnd: blEndLabel,
    },
    contract: {
      start: p.start || null,
      end: p.end || null,
      years: contractYears,
      currentYear: contractYearNum,
      annualTarget: annualTarget,
      cscPct: cscComp,
      clientPct: clientPct,
      escalation: escalation,
      quarterlyTargets: quarterlyTargets,
    },
    period: {
      type: reportType,
      start: reportStart,
      end: reportEnd,
      months: periodMonths,
      quarter: periodQuarter,
      year: periodYear,
      label: periodLabel,
      reportDate: reportDateStr || '',
      yearMonths: reportYMs.slice(),
    },
    buildings: buildingsData,
    totals: {
      savings: totSavings,
      cumulativeSavings: totCumSavings,
      blCost: totBlCost,
      curCost: totCurCost,
      savingsPct: totSavingsPct,
      kwhSaved: totKwhSaved,
      kwhBl: totKwhBl,
      kwhCur: totKwhCur,
      thermsSaved: totThermsSaved,
      thermsBl: totThermsBl,
      thermsCur: totThermsCur,
      propaneSaved: totPropaneSaved,
      propaneBl: totPropaneBl,
      propaneCur: totPropaneCur,
      peakKwBl: totPeakKwBl,
      peakKwCur: totPeakKwCur,
      euiBaseline: euiBaseline,
      euiCurrent: euiCurrent,
    },
    chartImages,
    pollution,
    weather,
    setpoints,
    meetings,
    approvedChanges: (p.approvedChanges || []).filter(
      (c) => c.approvalStatus && c.approvalStatus.toLowerCase() === 'ok',
    ),
    rawBills,
  };
}

// -----------------------------------------------------------------------
// REPORT TEMPLATE INFRASTRUCTURE
// Page wrapper, master assembly, overlay display/close, and stub
// functions for all 17 page templates. Built by Task 5.
// -----------------------------------------------------------------------

/**
 * RPT_GEOMETRY_DEFAULTS / _rptGeometry / _rptContentBudget — single source of truth for report
 * page geometry (sheet size, margins, gutter, header/footer band heights). fix/report-content-
 * pagination (2026-07-28), Matt verbatim: "You literally have the dimensions and margins for a
 * 8.5x11 sheet of paper... don't hard code numbers, instead make it user selectable or a
 * variable in the code so it can be easily changed later." Every pagination row-budget in this
 * file (ROWS_BUDGET_FIRST/CONT, RATIONALE_BUDGET_*, BUILDING_PAGE_BUDGET, etc.) must be derived
 * from _rptContentBudget(), never a standalone invented literal.
 *
 * These values MIRROR the CSS custom properties on :root in energy-department.html's
 * #report-styles block (--rpt-page-w/h, --rpt-pad-x, --rpt-hdr-h, --rpt-hero-hdr-h,
 * --rpt-small-hdr-h, --rpt-ftr-h — see the "Page geometry / furniture-layer tokens" comment
 * there for what each one drives visually; .rpt-body's own top/bottom padding, 12px/8px, is
 * spelled out in the .rpt-body rule right below those tokens). _rptGeometry() reads the LIVE
 * CSS values via getComputedStyle whenever a document is available, so changing a CSS token
 * (e.g. a future user-facing margin control that writes to document.documentElement.style)
 * flows straight through to every pagination budget with zero code changes here. The literals
 * below are only a fallback for contexts with no document (e.g. a Node harness loading this
 * file without the stylesheet) and are kept numerically identical to the CSS defaults.
 */
var RPT_GEOMETRY_DEFAULTS = {
  pageW: 816, // 8.5in @ 96dpi — mirrors CSS --rpt-page-w
  pageH: 1056, // 11in @ 96dpi — mirrors CSS --rpt-page-h
  padX: 48, // 0.5in side margin/gutter — mirrors CSS --rpt-pad-x
  hdrH: 60, // .rpt-int-hdr chrome bar — mirrors CSS --rpt-hdr-h
  heroHdrH: 196, // full-bleed cover letterhead — mirrors CSS --rpt-hero-hdr-h
  smallHdrH: 195, // inset letterhead (Agreement first/signature pages) — mirrors CSS --rpt-small-hdr-h
  ftrH: 72, // footer graphic + label + page number — mirrors CSS --rpt-ftr-h
  bodyPadTop: 12, // .rpt-body's own top padding (not a CSS var — literal in the .rpt-body rule)
  bodyPadBottom: 8, // .rpt-body's own bottom padding (not a CSS var — literal in the .rpt-body rule)
  flushTop: 12, // .rpt-body-flush top offset (options.hideIntHdr, no header chrome)
};

/**
 * _rptGeometry — returns the live page-geometry values, read from CSS custom properties when a
 * document exists (single source of truth with the on-screen/print CSS), else the defaults
 * above. Never hardcode a geometry number anywhere else in this file — call this instead.
 */
function _rptGeometry() {
  if (typeof document === 'undefined' || !document.documentElement) return RPT_GEOMETRY_DEFAULTS;
  var cs = getComputedStyle(document.documentElement);
  function px(name, fallback) {
    var n = parseFloat(cs.getPropertyValue(name));
    return isFinite(n) ? n : fallback;
  }
  return {
    pageW: px('--rpt-page-w', RPT_GEOMETRY_DEFAULTS.pageW),
    pageH: px('--rpt-page-h', RPT_GEOMETRY_DEFAULTS.pageH),
    padX: px('--rpt-pad-x', RPT_GEOMETRY_DEFAULTS.padX),
    hdrH: px('--rpt-hdr-h', RPT_GEOMETRY_DEFAULTS.hdrH),
    heroHdrH: px('--rpt-hero-hdr-h', RPT_GEOMETRY_DEFAULTS.heroHdrH),
    smallHdrH: px('--rpt-small-hdr-h', RPT_GEOMETRY_DEFAULTS.smallHdrH),
    ftrH: px('--rpt-ftr-h', RPT_GEOMETRY_DEFAULTS.ftrH),
    bodyPadTop: RPT_GEOMETRY_DEFAULTS.bodyPadTop,
    bodyPadBottom: RPT_GEOMETRY_DEFAULTS.bodyPadBottom,
    flushTop: RPT_GEOMETRY_DEFAULTS.flushTop,
  };
}

/**
 * _rptContentBudget — full available content height (px) inside .rpt-body for a given header
 * variant, BEFORE any page-specific chrome (headings, table titles, callouts, table headers,
 * footnotes) is subtracted. Every ROWS_BUDGET, RATIONALE_BUDGET, and PAGE_BUDGET constant in
 * this file starts from this number minus a NAMED chrome constant — never a bare literal.
 * @param {string} [variant] - 'standard' (default, .rpt-int-hdr present), 'flush'
 *   (options.hideIntHdr with no smallHeaderImg), or 'smallHdr' (options.smallHeaderImg — always
 *   paired with hideIntHdr:true, see rptPage()'s bodyModifierClass comment).
 */
function _rptContentBudget(variant) {
  var g = _rptGeometry();
  var topOffset = variant === 'flush' ? g.flushTop : variant === 'smallHdr' ? g.smallHdrH : g.hdrH;
  return g.pageH - topOffset - g.bodyPadTop - g.ftrH - g.bodyPadBottom;
}

/**
 * RPT_PRINT_PT_PER_PX / RPT_MIN_TEXT_PT / RPT_MIN_TEXT_PX / _rptApplyMinFontFloor —
 * the report's minimum-legible-text floor (U2 / RC-A, 2026-08-02, DEFECTS-2026-08-02.md D-05).
 *
 * WHY THIS EXISTS. The standing rule is "no text below 10pt in any client document." The .docx
 * export already satisfied it (measured minimum w:sz = 20 = exactly 10pt in all three JOCO
 * documents), but the PRINT path did not, and it is the print path that produces the PDFs Matt
 * actually sends. Measured via PyMuPDF span census on the live v2026.08.02.742 exports: the Audit
 * carried 373 spans under 10pt (7.5pt x146, 8.25pt x195, 6.75pt x31, 9.0pt x1), the Service
 * Proposal 79 (minimum 6.38pt), the Agreement 4.
 *
 * WHERE THE SUB-10pt SIZES COME FROM. A .rpt-page is authored 816px wide and prints onto an 8.5in
 * (612pt) sheet, so the print path scales every CSS pixel by exactly 612/816 = 0.75. A font
 * authored at 11px therefore prints at 8.25pt, 10px prints at 7.5pt, 9px at 6.75px. Nothing is
 * "shrinking" — the report's own px type scale simply dips below the legal floor once converted.
 * The floor in px is therefore 10 / 0.75 = 13.333px, rounded UP to 13.34px so the printed size
 * lands at 10.005pt and can never round to 9.99.
 *
 * WHY A RUNTIME DOM PASS RATHER THAN EDITING THE FONT LITERALS. The small sizes are spread across
 * hundreds of INLINE style strings in this file and in app/agreement-engine.js (plus SVG
 * font-size presentation attributes on the cover gauges), and inline styles beat any stylesheet
 * rule, so no @media print rule can raise them. One DOM pass at the single point where report
 * HTML enters the document (showReportOverlay) enforces the floor for every report type, every
 * export path that reads #reportPages (print-to-PDF, .doc, .docx), and every future page template,
 * without a second copy of the rule anywhere. It is also the only approach that fixes the
 * Agreement's headings without editing agreement-engine.js.
 *
 * INHERITANCE CORRECTNESS. Sizes are read for every element FIRST, then written, so no element's
 * "original" size is ever read through a parent this pass already changed. An element that was
 * already legal but whose PARENT gets raised is re-pinned at its own original px value, otherwise
 * a child sized in em/% would be inflated by its parent's bump.
 *
 * @param {Element} root - container whose subtree gets the floor (normally #reportPages)
 */
var RPT_PRINT_PT_PER_PX = 0.75; // 816px-wide page printed onto a 612pt sheet
var RPT_MIN_TEXT_PT = 10; // standing rule: nothing below 10pt in a client document
var RPT_MIN_TEXT_PX = Math.ceil((RPT_MIN_TEXT_PT / RPT_PRINT_PT_PER_PX) * 100) / 100; // 13.34px

/**
 * RPT_DOC_TITLE_PX / RPT_SECTION_HEAD_PX / RPT_BODY_PX — the report type hierarchy
 * (D-12 / V-33 / V-18, DEFECTS-2026-08-02.md + VISUAL-REVIEW-2026-08-02.md, fixed 2026-08-03).
 *
 * WHY THIS EXISTS. Every section heading in the Audit and the Proposal was authored at 11px or
 * 12px, which prints at 8.25pt / 9.0pt on the 0.75 px-to-pt print path. Once the 10pt floor
 * (_rptApplyMinFontFloor, above) landed they all clamped to exactly 10.005pt — still BELOW the
 * 10.5pt body text they introduce, and below the 10.5pt column headers of the tables inside them.
 * Measured on the Proposal: "Executive Summary", "Assessment Findings", "Recommended Energy
 * Management Services", "Why This Approach", "Future Work", "Implementation Plan", "Long-Term
 * Vision" and "Disclaimer" all rendered at 10.0pt against 10.5pt body, and on Proposal page 3 the
 * largest text on the whole page was a table column header. The document outline was inverted on
 * every page: top-level sections looked subordinate to their own content.
 *
 * THE FLOOR ALONE CANNOT FIX THIS. A floor can only stop text going below a minimum; it cannot
 * make a heading outrank body text that is already above the minimum. The heading sizes
 * themselves have to go up, which is what these three constants do.
 *
 * THE TIERS (px authored / pt printed at 0.75):
 *   24px    = 18.0pt   document title (the cover title of each document)
 *   17.34px = 13.005pt section heading (every heading that introduces body text or a table)
 *   14px    = 10.5pt   body text, list text, table cells (already the file's convention)
 * 17.34, not 17.33: 17.33 * 0.75 = 12.9975pt, which can display as 12.99. 17.34 lands at 13.005
 * and can never round down, exactly as RPT_MIN_TEXT_PX does at the floor.
 *
 * NOT CHANGED HERE, deliberately: the interior running page-title bar (.rpt-pg-title, 19px =
 * 14.25pt) lives in energy-department.html, is shared by every report type, and is height-boxed
 * inside the 60px --rpt-hdr-h chrome bar next to .rpt-info. It already outranks the new 13pt
 * section tier, so the outline reads document title 18pt > running page title 14.25pt > section
 * heading 13pt > body 10.5pt with no inversion at any level.
 */
var RPT_DOC_TITLE_PX = 24; // 18.0pt printed
var RPT_SECTION_HEAD_PX = 17.34; // 13.005pt printed
var RPT_BODY_PX = 14; // 10.5pt printed

/**
 * _rptTextLineH — height of ONE rendered line of report body text, in px, for a given CSS
 * line-height multiplier. Pagination estimates that count text lines must call this instead of
 * hardcoding "15px per line" or "20px per line": those literals were all measured before the 10pt
 * floor existed and every one of them silently under-counted afterwards (U2, 2026-08-02). Because
 * this reads RPT_MIN_TEXT_PX, changing the floor re-derives every line-count estimate with it.
 * @param {number} [mult] - the element's CSS line-height multiplier (defaults to 1.5)
 */
function _rptTextLineH(mult) {
  return Math.round(RPT_MIN_TEXT_PX * (mult || 1.5));
}

function _rptApplyMinFontFloor(root) {
  if (!root || typeof getComputedStyle !== 'function') return 0;
  var MIN = RPT_MIN_TEXT_PX;
  var els = root.querySelectorAll('*');
  var orig = [];
  var i;
  var rootPx = parseFloat(getComputedStyle(root).fontSize) || 0;
  for (i = 0; i < els.length; i++) {
    orig[i] = parseFloat(getComputedStyle(els[i]).fontSize) || 0;
  }
  // Index lookup so an element can find its own parent's ORIGINAL (pre-write) size.
  var idx = new Map();
  for (i = 0; i < els.length; i++) idx.set(els[i], i);
  var raised = 0;
  for (i = 0; i < els.length; i++) {
    var el = els[i];
    var own = orig[i];
    if (!own) continue;
    var p = el.parentElement;
    var parentPx = p === root ? rootPx : idx.has(p) ? orig[idx.get(p)] : 0;
    if (own < MIN) {
      el.style.setProperty('font-size', MIN + 'px', 'important');
      raised++;
    } else if (parentPx && parentPx < MIN) {
      // Parent is about to grow; pin this element so it keeps the size it already had.
      el.style.setProperty('font-size', own + 'px', 'important');
    }
  }
  return raised;
}

/**
 * _rptPaginateTokens — shared pixel-height paginator used by ALL multi-page report sections.
 *
 * Splits an array of token objects into page-sized chunks using pixel-height estimates rather
 * than row counts.  Tokens must have:
 *   - token.html {string}  — the HTML fragment for this token
 *   - token.estH {number}  — estimated rendered height in pixels
 *   - token.type {string}  — 'row' | 'tier' | 'cat' | 'block' (for anti-orphan rule)
 *
 * Anti-orphan rule: if the last token(s) in a chunk are header-type ('tier' or 'cat') with no
 * following 'row' or 'block' in that chunk, those trailing headers are pushed to the next chunk.
 *
 * @param {Array}  tokens           — token objects (see above)
 * @param {number} firstPageBudget  — available pixel height on the first page (after fixed chrome)
 * @param {number} contPageBudget   — available pixel height on continuation pages
 * @returns {Array<Array>}          — array of chunks; each chunk is an array of tokens
 */
function _rptPaginateTokens(tokens, firstPageBudget, contPageBudget) {
  var chunks = [];
  var remaining = tokens.slice();

  while (remaining.length > 0) {
    var isFirst = chunks.length === 0;
    var budget = isFirst ? firstPageBudget : contPageBudget;
    var chunk = [];
    var usedPx = 0;

    while (remaining.length > 0) {
      var next = remaining[0];
      var h = next && next.estH ? next.estH : 20; // fallback 20px if no estimate
      // Always include at least one token per chunk to prevent infinite loop
      if (chunk.length > 0 && usedPx + h > budget) break;
      chunk.push(remaining.shift());
      usedPx += h;
    }

    // Anti-orphan: trim trailing header tokens (tier/cat) back to remaining
    while (chunk.length > 0 && chunk[chunk.length - 1].type !== 'row' && chunk[chunk.length - 1].type !== 'block') {
      remaining.unshift(chunk.pop());
    }

    // Safety: if anti-orphan left chunk empty (e.g. first token is a header with nothing after it
    // that fits), force-include at least one token to avoid infinite loop
    if (chunk.length === 0 && remaining.length > 0) {
      chunk.push(remaining.shift());
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * _rptPaginateTokensBalanced — bin-packs an ORDERED list of tokens into same-order,
 * contiguous, single-capacity chunks (item order is never changed), like _rptPaginateTokens,
 * but chooses breakpoints to minimize the SPARSEST page instead of just greedily filling the
 * current page and moving on (fix/65ce578b, 2026-07-27, item c6c94355 -- "MedAct 53 Gardner
 * alone on a ~20%-full page while an adjacent page packs two comparably-small buildings with
 * room to spare"). _rptPaginateTokens's plain greedy ("next fit": always add the next token if
 * it fits, otherwise close the page") already achieves the FEWEST POSSIBLE pages for an
 * order-preserving contiguous partition -- that is provably optimal and unchanged here — but
 * next-fit can still land on a needlessly lopsided split among ties for that same minimum page
 * count (e.g. one page at 89% full next to one at 38% full, when a different split of the exact
 * same buildings among the exact same number of pages would land at 89%/50%). This function
 * computes, via dynamic programming over the same token list, the SAME minimum page count K,
 * then picks the K-page split that minimizes the worst (sparsest) page's leftover space. Same
 * hard cap as before (a page's content never exceeds `cap`, so nothing can clip); only the
 * choice of WHERE to split changes. O(n^2 * K) -- trivial for a few dozen buildings, run once
 * per report render, not per frame.
 * @param {Array} tokens - token objects with {html, estH} (same shape as _rptPaginateTokens)
 * @param {number} cap - single page-capacity budget (buildings use the same budget for the
 *   first page and every continuation page, so there is no separate first/cont split here)
 * @returns {Array<Array>} array of chunks; each chunk is an array of tokens, same order
 */
function _rptPaginateTokensBalanced(tokens, cap) {
  var n = tokens.length;
  if (n === 0) return [];

  var h = tokens.map(function (t) {
    return t && t.estH ? t.estH : 20;
  });
  var pre = [0];
  var i;
  for (i = 0; i < n; i++) pre.push(pre[i] + h[i]);
  function segSum(j, k) {
    return pre[k] - pre[j];
  }
  // A lone token is always allowed even if it alone exceeds cap -- matches
  // _rptPaginateTokens's own "always include at least one token per chunk" safety net, so an
  // oversized single token (which should never reach this function -- callers only feed it
  // blocks already confirmed <= cap -- but defensively kept here too) can never make the whole
  // partition infeasible.
  function fits(j, k) {
    if (k - j <= 1) return true;
    return segSum(j, k) <= cap;
  }

  var INF = Infinity;
  var j, k;

  // Pass 1: minimum number of pages (same count _rptPaginateTokens's greedy already achieves --
  // provably optimal for this order-preserving contiguous-partition problem).
  var minPages = new Array(n + 1).fill(INF);
  minPages[0] = 0;
  for (i = 1; i <= n; i++) {
    for (j = i - 1; j >= 0; j--) {
      if (!fits(j, i)) break; // segment sums only grow as j decreases; once infeasible, stop
      if (minPages[j] + 1 < minPages[i]) minPages[i] = minPages[j] + 1;
    }
  }
  var K = minPages[n];
  if (K === INF) return [tokens]; // defensive fallback; should be unreachable (fits() above
  // always allows a lone token, so K is always finite)

  // Pass 2: among all partitions using exactly K pages, minimize the worst (largest) leftover
  // space on any single page.
  var dp = [];
  var choice = [];
  for (k = 0; k <= K; k++) {
    dp.push(new Array(n + 1).fill(INF));
    choice.push(new Array(n + 1).fill(-1));
  }
  dp[0][0] = 0;
  for (k = 1; k <= K; k++) {
    for (i = 1; i <= n; i++) {
      for (j = i - 1; j >= 0; j--) {
        if (!fits(j, i)) break;
        if (dp[k - 1][j] === INF) continue;
        var slack = Math.max(0, cap - segSum(j, i));
        var val = Math.max(dp[k - 1][j], slack);
        if (val < dp[k][i]) {
          dp[k][i] = val;
          choice[k][i] = j;
        }
      }
    }
  }

  var chunks = [];
  var idx = n;
  var kk = K;
  while (kk > 0) {
    var jj = choice[kk][idx];
    chunks.unshift(tokens.slice(jj, idx));
    idx = jj;
    kk--;
  }
  return chunks;
}

// Footer page-number chrome, shared by rptPage()'s hero and interior branches.
//
// THE FORMAT IS "Page N of M". Matt, 2026-08-03: "I wanted 'Page N of M'." That instruction is
// the authority for this footer and it OUTRANKS the Louisburg EMS Agreement baseline, whose
// footer prints a bare right-aligned number. An earlier pass that same day (defect register
// D-08, commit f891b0a) read Matt's report "the word documents don't have the right footer page
// numbering format" as a request to match Louisburg and stripped the words down to a bare
// number on all three export paths. That was a misread and it has been reverted. Do NOT
// "restore the baseline" here — the words are what he asked for, on all three artifacts
// (this print/PDF path, the .docx footer parts in docx-skeleton.js, and the legacy .doc
// mso-HTML export's pageNumP below).
//
// What f891b0a got RIGHT and is kept: the 12pt size and the right-aligned position. 16px = 12pt
// printed (the print path scales px by exactly 0.75); bottom:16px puts it ~14pt above the
// sheet's bottom edge. Matt did not object to either, only to the missing words.
//
// The text itself is written by _injectPageNumbers() at generation time and re-written by
// _updateOverlayPageNumbers() after the DOM exists — the second overwrites the first, so BOTH
// must emit the same "Page N of M" string.
var RPT_PAGENUM_DIV =
  '<div class="rpt-pg-footer-pagenum" style="position:absolute;bottom:16px;right:20px;font-size:16px;color:var(--rpt-page-text)"></div>';

/**
 * rptPage — wraps a single report page with header, body, and footer.
 * @param {number} pageNum - Page number for the data-page attribute
 * @param {string} title - Title shown in the interior page header
 * @param {string} bodyHTML - Inner HTML content for the page body
 * @param {object} options - { data, hero, label, noPageNum, hideIntHdr, smallHeaderImg }
 */
function rptPage(pageNum, title, bodyHTML, options = {}) {
  const data = options.data;
  const isHero = options.hero === true;
  const pageLabel = options.label || 'Page ' + pageNum;
  // noPageNum / hideIntHdr (2026-07-26, Service Proposal rebuild): additive opt-in flags, both
  // default false so every existing caller (Audit report, Financial report, etc.) renders exactly
  // as before. Matt's hand-built Word proposal target has NO page number in its footer (wave
  // graphic only) and continuation pages carry no title/client-name chrome bar at all — just body
  // content starting at the top margin. noPageNum omits the .rpt-pg-footer-pagenum div entirely
  // (so _injectPageNumbers' total-count regex simply never matches it); hideIntHdr omits the
  // .rpt-int-hdr title bar on non-hero pages.
  const noPageNum = options.noPageNum === true;
  const hideIntHdr = options.hideIntHdr === true;
  // smallHeaderImg (2026-07-28, Energy Management Services Agreement fidelity fix): additive
  // opt-in flag, default false, so every existing caller renders exactly as before. The JOCO
  // Agreement's Word original places the SAME CSC_HEADER_B64 letterhead graphic (also used
  // full-bleed on hero pages) at its normal content width — inset within the standard 48px/0.5in
  // side margin, not stretched edge-to-edge across the whole page box — on its first page and its
  // signature page only. Non-hero pages have no letterhead-image slot at all today (only
  // .rpt-int-hdr's text bar), so this flag adds one without touching hero's own full-width
  // treatment or any other caller's markup.
  const smallHeaderImg = options.smallHeaderImg === true;

  var _fmtRptDate = '';
  if (data && data.period && data.period.reportDate) {
    var _rd = new Date(data.period.reportDate + 'T00:00:00');
    if (!isNaN(_rd)) {
      var _rdMo = [
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
      _fmtRptDate = _rdMo[_rd.getMonth()] + ' ' + _rd.getDate() + ', ' + _rd.getFullYear();
    }
  }
  // Rule 2.2: rpt-pg-footer class on every page (including cover) for DOM check compliance.
  const footerImgHtml =
    '<div class="rpt-footer rpt-pg-footer"><img src="' + CSC_FOOTER_B64 + '" alt="CSC Footer"></div>';
  // 2026-07-12 fix (item 118682b2, footer redundant text cleanup): date text removed
  // from the footer entirely per Matt's request. "Page N of M" (footerImgHtml's sibling
  // pagenum div, emitted separately below) is the only footer text that remains.
  // _fmtRptDate (computed above) is now dead — nothing reads it anymore. Left the
  // date-parsing block in place rather than deleting it, to keep this diff scoped to the
  // footer only; safe to remove in a future cleanup pass if nothing else claims it.
  const footerTextHtml = '';
  // class="rpt-footer-label" added (2026-07-22, Word export fix) alongside the existing inline
  // position:absolute style — inert everywhere today (no stylesheet rule targets it yet), but
  // gives exportReportToWord()'s Word-only CSS override a selector to force this element back
  // into normal document flow with !important (inline style otherwise always wins over an
  // external rule of equal/lower specificity). See exportReportToWord() for why: Word's HTML
  // engine does not support position:absolute the way browsers do, so this footer label was
  // rendering at the wrong spot / overlapping body content in the Word export.
  const footerLabelHtml =
    data && data.period
      ? '<div class="rpt-footer-label" style="text-align:center;font-size:14px;color:var(--rpt-page-text);padding:4px 0 2px;position:absolute;bottom:' +
        '45px' +
        ';left:0;right:0">' +
        (data.period.type === 'quarterly'
          ? 'Q' + (data.period.quarter || 1) + ' ' + (data.period.year || '') + ' Quarterly Report'
          : data.period.year
            ? data.period.year + ' Annual Report'
            : '') +
        '</div>'
      : '';

  // Rule 2.3: interior header shows period range only, no date.
  // period.label is the range string (e.g. "Q2 2024" or "2024 Annual").
  // 2026-07-12: the footer no longer shows a date at all (footerTextHtml above is now
  // always ''), so no page in the report displays a date anywhere — this is intentional.
  const interiorRangeHtml = data && data.period && data.period.label ? data.period.label : '';

  if (isHero) {
    // Rule 2.1: rpt-cover class on hero pages; csc-header-img class on the letterhead image.
    return (
      '<div class="rpt-pl">' +
      pageLabel +
      '</div>' +
      '<div class="rpt-page rpt-cover" data-page="' +
      pageNum +
      '">' +
      '<img src="' +
      CSC_HEADER_B64 +
      '" alt="CSC Letterhead" class="csc-header-img" style="width:100%;display:block">' +
      bodyHTML +
      footerTextHtml +
      footerLabelHtml +
      footerImgHtml +
      (noPageNum ? '' : RPT_PAGENUM_DIV) +
      '</div>'
    );
  }

  // Layer isolation (feature/report-layer-isolation-and-theme, 2026-07-28): .rpt-body is the
  // fixed-height content layer (see .rpt-body / .rpt-body-flush / .rpt-body-small-hdr in
  // energy-department.html's #report-styles). Its top offset depends on which header variant
  // this page renders — these three cases are the only combinations any caller uses (grep-
  // verified: smallHeaderImg is always paired with hideIntHdr:true).
  const bodyModifierClass = smallHeaderImg ? ' rpt-body-small-hdr' : hideIntHdr ? ' rpt-body-flush' : '';

  return (
    '<div class="rpt-pl">' +
    pageLabel +
    '</div>' +
    '<div class="rpt-page" data-page="' +
    pageNum +
    '">' +
    // csc-header-img-inset (2026-07-30, letterhead overflow fix, item 5b789cc8): this <img>
    // previously carried no class and no width/height attributes, so it was invisible to the
    // Word image-sizing regex below and Word rendered it at its native intrinsic pixel size
    // (918x218), overflowing ~77pt/1.07in past the right page edge on the Agreement's cover and
    // signature pages (measured via PyMuPDF bbox extraction on a real Word COM PDF round-trip of
    // Matt's v729 .doc). Reusing the plain "csc-header-img" class (unqualified) would instead
    // route it through the FULL-BLEED hero regex (width:8.5in) — wrong here, since this image
    // sits inset within the page's 0.5in side margins (it is not full-bleed like the hero cover
    // letterhead), and .rpt-small-hdr's own "48px" padding already makes it a target of
    // _insetChildren's margin-left/right:0.5in fix in exportReportToWord(), so an 8.5in-wide
    // image would overflow by a full extra inch. "csc-header-img-inset" is a second, more
    // specific class so the two sites can be sized differently by the same shared regex-based
    // technique instead of a one-off parallel sizing path.
    (smallHeaderImg
      ? '<div class="rpt-small-hdr" style="padding:14px 48px 6px"><img src="' +
        CSC_HEADER_B64 +
        '" alt="CSC Letterhead" class="csc-header-img csc-header-img-inset" style="width:100%;display:block"></div>'
      : '') +
    (hideIntHdr
      ? ''
      : '<div class="rpt-int-hdr">' +
        '<div class="rpt-pg-title">' +
        title +
        '</div>' +
        '<div class="rpt-info">' +
        (data ? data.project.client : '') +
        (interiorRangeHtml ? '<br>' + interiorRangeHtml : '') +
        '</div>' +
        '</div>') +
    '<div class="rpt-body' +
    bodyModifierClass +
    '">' +
    bodyHTML +
    '</div>' +
    footerTextHtml +
    footerLabelHtml +
    footerImgHtml +
    (noPageNum ? '' : RPT_PAGENUM_DIV) +
    '</div>'
  );
}

/**
 * _injectPageNumbers — Rule 2.4 (Plan B): bakes "Page N of Total" into the HTML
 * string at generation time so page numbers appear even when the post-DOM JS
 * helpers (_updateOverlayPageNumbers, _updatePageNumbers) are not called.
 * Safe to call on any report HTML string; post-DOM helpers overwrite these when
 * they run (same values, so no visible difference).
 * @param {string} html - Combined page HTML from a generate*HTML() function
 * @returns {string} HTML with page number text injected into .rpt-pg-footer-pagenum divs
 */
function _injectPageNumbers(html) {
  var total = 0;
  html.replace(/<div class="rpt-pg-footer-pagenum"/g, function () {
    total++;
    return '';
  });
  if (total === 0) return html;
  var n = 0;
  return html.replace(/(<div class="rpt-pg-footer-pagenum"[^>]*>)<\/div>/g, function (match, open) {
    n++;
    return open + 'Page ' + n + ' of ' + total + '</div>';
  });
}

/**
 * _rptDocumentDateLong — the one date every generated client document prints on its cover.
 *
 * Reads the SAME instant and the SAME calendar day the export filename is built from
 * (printReportToPDF / exportReportToWord / the .docx path all use
 * `new Date().toISOString().slice(0, 10)`), so the date on the page and the date in the file
 * name can never disagree. Formatted for a client to read out loud ("August 3, 2026"), never as
 * a numeric code.
 * @returns {string} e.g. "August 3, 2026"
 */
var _RPT_DOC_MONTHS = [
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
function _rptDocumentDateLong() {
  var iso = new Date().toISOString().slice(0, 10).split('-');
  return _RPT_DOC_MONTHS[Number(iso[1]) - 1] + ' ' + Number(iso[2]) + ', ' + iso[0];
}

/**
 * generateReportHTML — assembles all selected report pages into HTML.
 * @param {object} data - Output from collectReportData()
 * @param {object} selectedSections - Which sections to include (all default true)
 * @returns {string} Combined HTML for all pages
 */
function generateReportHTML(data, selectedSections) {
  const pages = [];
  let pageNum = 1;
  const s = selectedSections || {};

  // Helper: inject data-section="key" into the first .rpt-page div in an HTML string.
  // Uses a regex so it correctly handles rpt-cover and other extra classes on the div.
  function _tagSection(html, key) {
    return html.replace(/<div class="rpt-page([^"]*)"/, '<div class="rpt-page$1" data-section="' + key + '"');
  }

  // Board executive summary (standalone — inserted before cover when selected)
  if (s.boardSummary) pages.push(_tagSection(rptPageBoardSummary(pageNum++, data), 'boardSummary'));

  // Main pages
  if (s.cover !== false) pages.push(_tagSection(rptPageCover(pageNum++, data), 'cover'));
  if (s.financial !== false) pages.push(_tagSection(rptPageFinancial(pageNum++, data), 'financial'));
  if (s.savingsPerformance !== false)
    pages.push(_tagSection(rptPageSavingsPerformance(pageNum++, data), 'savingsPerformance'));
  if (s.euiBenchmarking !== false) pages.push(_tagSection(rptPageEUI(pageNum++, data), 'euiBenchmarking'));
  if (s.environmentalImpact !== false)
    pages.push(_tagSection(rptPageEnvironmentalImpact(pageNum++, data), 'environmentalImpact'));
  if (s.observations !== false) {
    var _obsResult = rptPageObservations(pageNum, data);
    // Tag only the first page with the section key; continuations get -cont
    var _obsTagged = _obsResult.html.replace(
      '<div class="rpt-page"',
      '<div class="rpt-page" data-section="observations"',
    );
    pages.push(_obsTagged);
    pageNum += _obsResult.pageCount;
  }
  if (s.approvedChanges !== false) pages.push(_tagSection(rptPageApprovedChanges(pageNum++, data), 'approvedChanges'));
  if (s.contractProjection !== false)
    pages.push(_tagSection(rptPageContractProjection(pageNum++, data), 'contractProjection'));
  if (s.setpoints !== false) pages.push(_tagSection(rptPageSetPoints(pageNum++, data), 'setpoints'));

  // Per-building summaries
  if (s.buildingSummaries !== false) {
    var _bsFirst = true;
    data.buildings.forEach(function (b) {
      var bResult = rptPageBuildingSummary(pageNum, data, b);
      // Tag the first page of building summaries with the section key; continuations get -cont
      var taggedHtml = _bsFirst
        ? bResult.html.replace('<div class="rpt-page"', '<div class="rpt-page" data-section="buildingSummaries"')
        : bResult.html.replace('<div class="rpt-page"', '<div class="rpt-page" data-section="buildingSummaries-cont"');
      pages.push(taggedHtml);
      _bsFirst = false;
      pageNum += bResult.summaryPageCount;
    });
  }

  // Per-building meter performance (independent section — split across pages)
  if (s.meterPerformance !== false) {
    var _mpBlocks = [];
    data.buildings.forEach(function (b) {
      var bResult = rptPageBuildingSummary(0, data, b);
      if (bResult.meterPerfHTML) {
        _mpBlocks.push(
          '<div style="page-break-inside:avoid;break-inside:avoid;margin-bottom:10px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin-bottom:3px;border-bottom:1px solid var(--rpt-blue-light);padding-bottom:2px">' +
            (b.name || 'Building') +
            '</div>' +
            bResult.meterPerfHTML +
            '</div>',
        );
      }
    });
    // One building per page to prevent table overflow
    for (var _mpI = 0; _mpI < _mpBlocks.length; _mpI++) {
      var _mpTitle = _mpI === 0 ? 'Meter Performance ( All Buildings' : 'Meter Performance (continued)';
      var _mpKey = _mpI === 0 ? 'meterPerformance' : 'meterPerformance-cont';
      var _mpPageNum = pageNum++;
      pages.push(
        _tagSection(
          rptPage(_mpPageNum, _mpTitle, _mpBlocks[_mpI], {
            data: data,
            label: 'Page ' + _mpPageNum + ' — Meter Performance',
          }),
          _mpKey,
        ),
      );
    }
  }

  // Commodity detail pages
  if (s.electricDetail !== false) pages.push(_tagSection(rptPageElectric(pageNum++, data), 'electricDetail'));
  var _hasGasBldgs = data.buildings.some(function (b) {
    return b.commodities && b.commodities.includes('Gas') && b.gas && b.gas.monthly && b.gas.monthly.length > 0;
  });
  var _hasPropBldgs = data.buildings.some(function (b) {
    return (
      b.commodities &&
      b.commodities.includes('Propane') &&
      b.propane &&
      b.propane.monthly &&
      b.propane.monthly.length > 0
    );
  });
  if (_hasGasBldgs && _hasPropBldgs) {
    if (s.gasDetail !== false || s.propaneDetail !== false)
      pages.push(_tagSection(rptPageGasPropane(pageNum++, data), 'gasDetail'));
  } else {
    if (s.gasDetail !== false && _hasGasBldgs) pages.push(_tagSection(rptPageGas(pageNum++, data), 'gasDetail'));
    if (s.propaneDetail !== false && _hasPropBldgs)
      pages.push(_tagSection(rptPagePropane(pageNum++, data), 'propaneDetail'));
  }

  // Appendices
  var _appLtr = 'A';
  var _appMap = {};
  function _nextAppLtr(key) {
    var l = _appLtr;
    _appMap[key] = l;
    _appLtr = String.fromCharCode(l.charCodeAt(0) + 1);
    return l;
  }
  // fix/report-content-pagination (2026-07-28): appendixA/B/D now return {html, pageCount}
  // (same shape as rptPageObservations) instead of a single un-paginated HTML string, so
  // large portfolios (e.g. JOCO's 26 buildings) no longer overflow .rpt-body on these pages.
  if (s.appendixA !== false) {
    var _apA = rptPageAppendixNormalization(pageNum, data, _nextAppLtr('norm'));
    pages.push(_tagSection(_apA.html, 'appendixA'));
    pageNum += _apA.pageCount;
  }
  if (s.appendixB !== false) {
    var _apB = rptPageAppendixBaseline(pageNum, data, _nextAppLtr('regr'), _appMap);
    pages.push(_tagSection(_apB.html, 'appendixB'));
    pageNum += _apB.pageCount;
  }
  if (s.appendixC !== false)
    pages.push(_tagSection(rptPageAppendixWeather(pageNum++, data, _nextAppLtr('weather')), 'appendixC'));
  if (s.appendixD !== false) {
    var _apD = rptPageAppendixBills(pageNum, data, _nextAppLtr('bills'));
    pages.push(_tagSection(_apD.html, 'appendixD'));
    pageNum += _apD.pageCount;
  }

  // Rule 2.4 (Plan B): bake page numbers into the HTML at generation time so they
  // appear on ALL paths including Board Summary (which never calls _updateOverlayPageNumbers).
  return _injectPageNumbers(pages.join('\n'));
}

/**
 * showReportOverlay — displays the report preview overlay with generated HTML.
 */
function showReportOverlay(html, title) {
  var pagesEl = document.getElementById('reportPages');
  pagesEl.innerHTML = html;
  document.getElementById('reportOverlayTitle').textContent = title || 'Report Preview';
  document.getElementById('reportOverlay').style.display = 'flex';
  // U2 / RC-A (2026-08-02, D-05): enforce the 10pt printed-text floor on the live DOM before
  // anything reads it. This is the ONE place report HTML enters the document, so every report
  // type and every downstream export (print-to-PDF, .doc, .docx — all of which serialize
  // #reportPages) inherits the floor. The overlay must already be display:flex above, otherwise
  // getComputedStyle() reports 0px for every element in a display:none subtree and the pass is a
  // silent no-op.
  _rptApplyMinFontFloor(pagesEl);
  // Kept as the pre-floor source string deliberately: nothing in the codebase reads
  // document._currentReportHTML today (grep-verified), and re-serializing the live DOM here would
  // add a multi-megabyte innerHTML round-trip to every preview open on a 26-building Audit. Any
  // future consumer must read the LIVE #reportPages DOM (which carries the floor), not this.
  document._currentReportHTML = html;
  document.body.style.overflow = 'hidden';
}

/**
 * _updateOverlayPageNumbers — populates .rpt-pg-footer-pagenum divs inside
 * the legacy reportOverlay (#reportPages), mirroring what _updatePageNumbers()
 * does for the new rptPreviewContainer system.  Called after showReportOverlay
 * for any report that uses the overlay path (ASHRAE, board summary, etc.).
 */
function _updateOverlayPageNumbers() {
  var pages = document.querySelectorAll('#reportPages .rpt-page');
  var total = pages.length;
  for (var i = 0; i < total; i++) {
    var footer = pages[i].querySelector('.rpt-pg-footer-pagenum');
    if (footer) {
      // "Page N of M" — see the footer-format comment above RPT_PAGENUM_DIV. This runs AFTER
      // _injectPageNumbers() and overwrites it, so the two must stay in the same format.
      footer.textContent = 'Page ' + (i + 1) + ' of ' + total;
    }
  }
}

/**
 * closeReportOverlay — hides the report preview overlay and cleans up.
 */
function closeReportOverlay() {
  document.getElementById('reportOverlay').style.display = 'none';
  document.getElementById('reportPages').innerHTML = '';
  document.body.style.overflow = '';
}

/**
 * printBoardSummary — generates and displays a single-page board executive summary
 * for the given project in the report preview overlay.
 * @param {number} projId - Project ID
 */
function printBoardSummary(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) {
    showToast('Project not found', 'error');
    return;
  }
  const bldgs = getUDBldgs(projId);
  if (!bldgs.length) {
    showToast('No utility data — add buildings and bill data first', 'error');
    return;
  }
  try {
    const data = collectReportData(projId, null, null, 'annual');
    if (!data) {
      showToast('Could not build report data for this project', 'error');
      return;
    }
    const html = generateReportHTML(data, {
      boardSummary: true,
      cover: false,
      financial: false,
      savingsPerformance: false,
      euiBenchmarking: false,
      environmentalImpact: false,
      observations: false,
      approvedChanges: false,
      contractProjection: false,
      setpoints: false,
      buildingSummaries: false,
      meterPerformance: false,
      electricDetail: false,
      gasDetail: false,
      propaneDetail: false,
      appendixA: false,
      appendixB: false,
      appendixC: false,
      appendixD: false,
    });
    showReportOverlay(html, (p.client || p.name || 'Project') + ' — Board Executive Summary');
  } catch (e) {
    showToast('Error generating board summary: ' + e.message, 'error');
    console.error('printBoardSummary error:', e);
  }
}
window.printBoardSummary = printBoardSummary;

// -- Stub page template functions (replaced by Tasks 6–17) --
function rptPageCover(n, d) {
  const $c = function (v) {
    return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString();
  };
  const $p = function (v) {
    return v.toFixed(1) + '%';
  };
  const $n = function (v) {
    return Math.round(v).toLocaleString();
  };

  const q = d.period.quarter || 1;
  const target = d.contract.quarterlyTargets[q - 1] || d.contract.annualTarget;
  const pctOfTarget = target > 0 ? Math.round((d.totals.savings / target) * 100) : 0;
  const periodTitle =
    d.period.type === 'quarterly' ? 'Q' + q + ' ' + (d.period.year || '') : (d.period.year || '') + ' Annual';
  const ahead = d.totals.savings - target;
  const _periodWord = d.period.type === 'annual' ? 'annual' : 'quarterly';
  const aheadLabel =
    ahead >= 0
      ? $c(ahead) + ' ahead of ' + _periodWord + ' projection'
      : $c(Math.abs(ahead)) + ' behind ' + _periodWord + ' projection';

  // Building status counts
  const onTrack = d.buildings.filter(function (b) {
    return b.status === 'on_track';
  }).length;
  const exceedLabel =
    pctOfTarget > 105
      ? onTrack + ' of ' + d.buildings.length + ' buildings exceeding expectations'
      : pctOfTarget >= 90
        ? onTrack + ' of ' + d.buildings.length + ' buildings on track'
        : onTrack + ' of ' + d.buildings.length + ' buildings need attention';

  // Narrative paragraph
  const contractYrLabel = 'Year ' + d.contract.currentYear + ' of ' + d.contract.years;
  const perfWord = pctOfTarget >= 100 ? 'exceeding' : pctOfTarget >= 80 ? 'approaching' : 'below';
  const narrative =
    'This report covers energy performance for <strong>' +
    d.project.client +
    '</strong> covering ' +
    d.period.label +
    '. ' +
    'This is ' +
    contractYrLabel +
    ' of the projected savings contract. ' +
    'Across all ' +
    d.buildings.length +
    ' buildings, the portfolio is ' +
    perfWord +
    ' the ' +
    _periodWord +
    ' savings target of <strong>' +
    $c(target) +
    '</strong>, ' +
    'having achieved <strong>' +
    $c(d.totals.savings) +
    '</strong> in verified cost avoidance ' +
    '(' +
    $p(d.totals.savingsPct) +
    ' of baseline spend). ' +
    'Energy reductions have been driven by operational improvements, setpoint optimization, and scheduling adjustments.';

  // Key findings
  const findings = [];
  // Top performer
  const sorted = d.buildings.slice().sort(function (a, b) {
    return (b.savingsPct ?? 0) - (a.savingsPct ?? 0);
  });
  if (sorted.length) {
    const top = sorted[0];
    findings.push({
      icon: 'rpt-fi-up',
      text:
        '<strong>' +
        top.name +
        '</strong> is the top performer at ' +
        $p(top.savingsPct) +
        ' savings this period (' +
        $c(top.savings) +
        ').',
    });
  }
  // Notable total savings
  if (d.totals.kwhSaved > 0) {
    findings.push({
      icon: 'rpt-fi-up',
      text:
        '<strong>' +
        $n(d.totals.kwhSaved) +
        ' kWh</strong> of electricity avoided' +
        (d.totals.thermsSaved > 0
          ? ' plus <strong>' + $n(d.totals.thermsSaved) + ' therms</strong> of gas reduced'
          : '') +
        ' across the portfolio.',
    });
  }
  // Underperformers
  const below = d.buildings.filter(function (b) {
    return b.status === 'below_target';
  });
  if (below.length) {
    findings.push({
      icon: 'rpt-fi-warn',
      text:
        below.length +
        ' building' +
        (below.length > 1 ? 's are' : ' is') +
        ' currently below target: <strong>' +
        below
          .map(function (b) {
            return b.name;
          })
          .join(', ') +
        '</strong>. Review recommended.',
    });
  }
  // ENERGY STAR eligibility
  const esStar = d.buildings.filter(function (b) {
    return b.eui && b.eui.energyStar;
  });
  if (esStar.length) {
    findings.push({
      icon: 'rpt-fi-star',
      text:
        esStar.length +
        ' building' +
        (esStar.length > 1 ? 's are' : ' is') +
        ' in the top EUI quartile for their building type — <strong>ENERGY STAR eligible</strong>: ' +
        esStar
          .map(function (b) {
            return b.name;
          })
          .join(', ') +
        '.',
    });
  }
  if (findings.length < 3) {
    findings.push({
      icon: 'rpt-fi-up',
      text:
        'Contract is ' +
        contractYrLabel +
        ' with a cumulative annual target of <strong>' +
        $c(d.contract.annualTarget) +
        '</strong>.',
    });
  }

  // Progress bar width (cap at 110%)
  const barPct = Math.min(110, pctOfTarget);
  const barClass = pctOfTarget >= 100 ? 'rpt-ahead' : 'rpt-behind';

  // Gauge circle CSS conic-gradient helper
  function gaugeSVG(pct, color, label, valText) {
    var clamp = Math.min(100, Math.max(0, pct));
    var r = 22,
      cx = 26,
      cy = 26,
      sw = 5;
    var circ = 2 * Math.PI * r;
    var offset = circ - (clamp / 100) * circ;
    return (
      '<div style="text-align:center;padding:4px">' +
      '<svg width="52" height="52" viewBox="0 0 52 52">' +
      '<circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      r +
      '" fill="none" stroke="var(--rpt-progress-bg)" stroke-width="' +
      sw +
      '"/>' +
      '<circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      r +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="' +
      sw +
      '" ' +
      'stroke-dasharray="' +
      circ.toFixed(1) +
      '" stroke-dashoffset="' +
      offset.toFixed(1) +
      '" ' +
      'stroke-linecap="round" transform="rotate(-90 ' +
      cx +
      ' ' +
      cy +
      ')"/>' +
      '<text x="' +
      cx +
      '" y="' +
      (cy + 5) +
      '" text-anchor="middle" font-size="14" font-weight="700" fill="var(--rpt-blue)">' +
      valText +
      '</text>' +
      '</svg>' +
      '<div style="font-size:11px;color:var(--rpt-page-text);text-transform:uppercase">' +
      label +
      '</div>' +
      '</div>'
    );
  }

  // EUI improvement %
  const euiImpPct =
    d.totals.euiBaseline > 0
      ? Math.round(((d.totals.euiBaseline - d.totals.euiCurrent) / d.totals.euiBaseline) * 100)
      : 0;
  // Contract progress % — use actual dates like dashboard calcAutoProgress
  var contractDonePct = 0;
  if (d.contract.start && d.contract.end) {
    var _cStart = new Date(d.contract.start + 'T00:00:00');
    var _cEnd = new Date(d.contract.end + 'T00:00:00');
    var _cNow = new Date();
    if (!isNaN(_cStart) && !isNaN(_cEnd) && _cEnd > _cStart) {
      if (_cNow >= _cEnd) contractDonePct = 100;
      else if (_cNow <= _cStart) contractDonePct = 0;
      else contractDonePct = Math.round(((_cNow - _cStart) / (_cEnd - _cStart)) * 100);
    }
  } else if (d.contract.start) {
    var _cStart2 = new Date(d.contract.start + 'T00:00:00');
    var _cEnd2 = new Date(_cStart2);
    _cEnd2.setFullYear(_cEnd2.getFullYear() + (d.contract.years || 3));
    var _cNow2 = new Date();
    if (_cNow2 >= _cEnd2) contractDonePct = 100;
    else if (_cNow2 > _cStart2) contractDonePct = Math.round(((_cNow2 - _cStart2) / (_cEnd2 - _cStart2)) * 100);
  }
  // Energy reduction %
  const energyRedPct = d.totals.kwhBl > 0 ? Math.round(((d.totals.kwhBl - d.totals.kwhCur) / d.totals.kwhBl) * 100) : 0;

  // Building status grid cards (all buildings)
  const gridBldgs = d.buildings;
  const statusCards = gridBldgs
    .map(function (b) {
      const cardClass = b.status === 'on_track' ? 'rpt-ok' : b.status === 'near_target' ? 'rpt-warn' : '';
      const statusIcon =
        b.status === 'on_track'
          ? '&#9650; On Track'
          : b.status === 'near_target'
            ? '&#9658; Near Target'
            : '&#9658; Below Target';
      const cardStyle = b.status === 'below_target' ? 'border-color:var(--rpt-red-light);' : '';
      const valColor =
        b.status === 'on_track'
          ? 'var(--rpt-green-dark)'
          : b.status === 'near_target'
            ? 'var(--rpt-orange)'
            : 'var(--rpt-red)';
      const labelColor =
        b.status === 'on_track'
          ? 'var(--rpt-green)'
          : b.status === 'near_target'
            ? 'var(--rpt-orange)'
            : 'var(--rpt-red)';
      return (
        '<div class="rpt-status-card ' +
        cardClass +
        '" style="' +
        cardStyle +
        '">' +
        '<div class="rpt-sc-name" contenteditable="true">' +
        b.name +
        '</div>' +
        '<div class="rpt-sc-val" style="color:' +
        valColor +
        '" contenteditable="true">' +
        $p(b.savingsPct) +
        '</div>' +
        '<div class="rpt-sc-label" style="color:' +
        labelColor +
        '" contenteditable="true">' +
        statusIcon +
        '</div>' +
        '</div>'
      );
    })
    .join('');
  // Findings HTML
  const findingsHTML = findings
    .map(function (f) {
      return (
        '<div class="rpt-finding">' +
        '<div class="rpt-finding-icon ' +
        f.icon +
        '">&#9679;</div>' +
        '<div contenteditable="true">' +
        f.text +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  // Hero section (below letterhead — no gradient, no logo text)
  const heroHTML =
    '<div class="rpt-hero">' +
    '<div class="rpt-hero-top">' +
    '<div class="rpt-hero-type">' +
    (d.period.type === 'annual' ? 'Annual' : 'Quarterly') +
    ' Energy Management Services Report</div>' +
    '</div>' +
    '<div class="rpt-hero-main">' +
    '<div class="rpt-hero-client" contenteditable="true">' +
    d.project.client +
    '</div>' +
    '<h1 contenteditable="true">' +
    periodTitle +
    ' Results</h1>' +
    '<div class="rpt-hero-period" contenteditable="true">' +
    contractYrLabel +
    ' &nbsp;•&nbsp; ' +
    d.period.label +
    '</div>' +
    '</div>' +
    '<div class="rpt-big-number">' +
    '<div class="rpt-bn-amount" contenteditable="true">' +
    $c(d.totals.savings) +
    '</div>' +
    '<div class="rpt-bn-label" contenteditable="true">' +
    periodTitle +
    ' Actual Savings</div>' +
    '<div class="rpt-bn-badge" contenteditable="true">' +
    pctOfTarget +
    '% of target</div>' +
    '</div>' +
    '<div class="rpt-hero-sub" contenteditable="true">' +
    aheadLabel +
    ' &nbsp;•&nbsp; ' +
    exceedLabel +
    '</div>' +
    '</div>';

  // Body section (white background below hero)
  const bodyHTML =
    '<div style="padding:10px 50px 10px;">' +
    // Narrative
    '<div class="rpt-narrative" contenteditable="true">' +
    narrative +
    '</div>' +
    // Target vs Actual + progress bar
    '<div class="rpt-vs-box">' +
    '<div class="rpt-vs-side">' +
    '<div class="rpt-vs-val" style="color:' +
    (d.totals.savings >= target ? 'var(--rpt-green-dark)' : 'var(--rpt-orange)') +
    '" contenteditable="true">' +
    $c(d.totals.savings) +
    '</div>' +
    '<div class="rpt-vs-lbl">Actual Q' +
    q +
    ' Savings</div>' +
    '</div>' +
    '<div class="rpt-vs-mid">vs</div>' +
    '<div class="rpt-vs-side">' +
    '<div class="rpt-vs-val" style="color:var(--rpt-blue)" contenteditable="true">' +
    $c(target) +
    '</div>' +
    '<div class="rpt-vs-lbl">Q' +
    q +
    ' Target</div>' +
    '</div>' +
    '</div>' +
    '<div class="rpt-progress-bar">' +
    '<div class="rpt-progress-fill ' +
    barClass +
    '" style="width:' +
    Math.min(barPct, 100) +
    '%">' +
    '<span contenteditable="true">' +
    pctOfTarget +
    '%</span>' +
    '</div>' +
    '' +
    '</div>' +
    // Portfolio Metrics (full width, on top)
    '<div style="margin-top:6px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Portfolio Metrics</div>' +
    '<div class="rpt-gauge-row">' +
    gaugeSVG(pctOfTarget, 'var(--rpt-green)', 'vs Target', pctOfTarget + '%') +
    gaugeSVG(energyRedPct, 'var(--rpt-blue-btn)', 'Energy Reduced', energyRedPct + '%') +
    gaugeSVG(Math.max(0, euiImpPct), 'var(--rpt-green-dark)', 'Site EUI Improved', euiImpPct + '%') +
    gaugeSVG(contractDonePct, 'var(--rpt-eui-purple)', 'Contract Progress', contractDonePct + '%') +
    '</div>' +
    '</div>' +
    // Building Status (full width, below — cards side by side)
    '<div style="margin-top:6px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Building Status</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
    statusCards +
    '</div>' +
    '</div>' +
    // Key Findings
    '<div style="margin-top:6px;">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Key Findings</div>' +
    findingsHTML +
    '</div>' +
    '</div>';

  return rptPage(n, 'Cover', heroHTML + bodyHTML, { hero: true, data: d, label: 'Page ' + n + ' — Cover' });
}

function rptPageFinancial(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v).toLocaleString();
  };
  const $p = function (v) {
    return v.toFixed(1) + '%';
  };

  const q = d.period.quarter || 1;
  const qLabel = d.period.type === 'quarterly' ? 'Q' + q + ' ' + (d.period.year || '') : d.period.year || '';
  const annFactor = d.period.type === 'quarterly' ? 4 : 1;
  const annSavings = d.totals.savings * annFactor;
  const contractYrs = d.contract.years || 3;
  const yrTotalSavings = annSavings * contractYrs;
  var _split = computeCscSplit(d.totals.savings, d.contract.cscPct, 'pct');
  var cscAmt = _split.csc;
  var clientAmt = _split.client;

  // -- Building Performance table --
  const qTarget = d.contract.quarterlyTargets[q - 1] || 0;
  const totBlCostForPct = d.totals.blCost || 1;
  const bRows = d.buildings
    .map(function (b) {
      const saveClass = b.savings >= 0 ? 'rpt-g' : 'rpt-r';
      const statusIcon = b.status === 'on_track' ? '&#9650;' : b.status === 'near_target' ? '&#9658;' : '&#9660;';
      const statusClass = b.status === 'on_track' ? 'rpt-g' : b.status === 'near_target' ? 'rpt-o' : 'rpt-r';
      const bldgProjSav = qTarget > 0 ? qTarget * (b.blCost / totBlCostForPct) : 0;
      const bldgProjCost = b.blCost - bldgProjSav;
      return (
        '<tr>' +
        '<td contenteditable="true">' +
        b.name +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.sqft) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $c(b.blCost) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $c(bldgProjCost) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $c(b.curCost) +
        '</td>' +
        '<td class="rpt-n ' +
        saveClass +
        '" contenteditable="true">' +
        $c(b.savings) +
        '</td>' +
        '<td class="rpt-n ' +
        saveClass +
        '" contenteditable="true">' +
        $p(b.savingsPct) +
        '</td>' +
        '<td class="' +
        statusClass +
        '" contenteditable="true">' +
        statusIcon +
        ' ' +
        (b.status === 'on_track' ? 'On Track' : b.status === 'near_target' ? 'Near Target' : 'Below Target') +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  const totSaveClass = d.totals.savings >= 0 ? 'rpt-g' : 'rpt-r';
  const totProjCost = d.totals.blCost - qTarget;
  const bTotRow =
    '<tr class="rpt-tot">' +
    '<td contenteditable="true">Total Portfolio</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.project.sqft) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(d.totals.blCost) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(totProjCost) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(d.totals.curCost) +
    '</td>' +
    '<td class="rpt-n ' +
    totSaveClass +
    '" contenteditable="true">' +
    $c(d.totals.savings) +
    '</td>' +
    '<td class="rpt-n ' +
    totSaveClass +
    '" contenteditable="true">' +
    $p(d.totals.savingsPct) +
    '</td>' +
    '<td></td>' +
    '</tr>';

  const bldgTable =
    '<table class="rpt-table rpt-table-wrap" contenteditable="false" style="font-size:10px;width:100%;table-layout:fixed">' +
    '<thead><tr style="text-align:center;white-space:normal;word-wrap:break-word;line-height:1.2">' +
    '<th style="width:18%">Building</th>' +
    '<th class="rpt-n" style="width:10%">Sq Ft</th>' +
    '<th class="rpt-n" style="width:12%">Baseline<br>Cost</th>' +
    '<th class="rpt-n" style="width:12%">Projected<br>Cost</th>' +
    '<th class="rpt-n" style="width:12%">Actual<br>Cost</th>' +
    '<th class="rpt-n" style="width:13%">' +
    qLabel +
    '<br>Actual Savings</th>' +
    '<th class="rpt-n" style="width:8%">%</th>' +
    '<th style="width:15%">Status</th>' +
    '</tr></thead>' +
    '<tbody>' +
    bRows +
    bTotRow +
    '</tbody>' +
    '</table>';

  // -- CSC Compensation table --
  const cscTable =
    '<table class="rpt-table" contenteditable="false">' +
    '<thead><tr>' +
    '<th></th>' +
    '<th class="rpt-n">Quarter</th>' +
    '<th class="rpt-n">Annualized</th>' +
    '<th class="rpt-n">' +
    contractYrs +
    '-Year Total</th>' +
    '</tr></thead>' +
    '<tbody>' +
    '<tr>' +
    '<td contenteditable="true">' +
    qLabel +
    ' Actual Savings</td>' +
    '<td class="rpt-n rpt-g" contenteditable="true">' +
    $c(d.totals.savings) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(annSavings) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(yrTotalSavings) +
    '</td>' +
    '</tr>' +
    '<tr>' +
    '<td contenteditable="true">CSC (' +
    d.contract.cscPct +
    '%)</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(cscAmt) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(cscAmt * annFactor) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(cscAmt * annFactor * contractYrs) +
    '</td>' +
    '</tr>' +
    '<tr class="rpt-tot">' +
    '<td contenteditable="true">Client Net (' +
    d.contract.clientPct +
    '%)</td>' +
    '<td class="rpt-n rpt-g" contenteditable="true">' +
    $c(clientAmt) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(clientAmt * annFactor) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(clientAmt * annFactor * contractYrs) +
    '</td>' +
    '</tr>' +
    '</tbody>' +
    '</table>';

  // -- Quarterly Savings vs Baseline table --
  const qBlCost = d.totals.blCost;
  const qCurCost = d.totals.curCost;
  const qtrRow =
    '<tr>' +
    '<td contenteditable="true">' +
    qLabel +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.kwhBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.kwhCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.thermsBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.thermsCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.propaneBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.propaneCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(qBlCost) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(qCurCost) +
    '</td>' +
    '<td class="rpt-n rpt-g" contenteditable="true">' +
    $c(d.totals.savings) +
    '</td>' +
    '</tr>';
  const qtrTable =
    '<table class="rpt-table rpt-table-wrap" contenteditable="false" style="font-size:10px;width:100%;table-layout:fixed">' +
    '<colgroup>' +
    '<col style="width:8%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:12%">' +
    '</colgroup>' +
    '<thead><tr style="text-align:center;line-height:1.2">' +
    '<th style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Quarter</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Baseline<br>kWh</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Actual<br>kWh</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Baseline<br>Therms</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Actual<br>Therms</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Baseline<br>Gal</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Actual<br>Gal</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Baseline<br>Cost</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">Actual<br>Cost</th>' +
    '<th class="rpt-n" style="white-space:normal;word-wrap:break-word;overflow-wrap:break-word">' +
    qLabel +
    '<br>Actual Savings</th>' +
    '</tr></thead>' +
    '<tbody>' +
    qtrRow +
    '</tbody>' +
    '</table>';

  // -- Cumulative vs Projection SVG chart (quarterly) --
  // svgW updated from 700 to 716 to use available body width (816 - 48px×2 padding = 720; 716 matches prior rptPageContractProjection value for consistent chart sizing)
  const svgW = 716,
    svgH = 110;
  const yrs = d.contract.years || 5;
  const annTarget = d.contract.annualTarget || 1;
  const qTargets = d.contract.quarterlyTargets || [0, 0, 0, 0];
  const totalQtrs = yrs * 4;
  const _esc = d.contract.escalation || 0;
  const cumPoints = [];
  var _cumP = 0;
  for (var qi = 1; qi <= totalQtrs; qi++) {
    var _yrIdx = Math.ceil(qi / 4);
    var _escFactor = Math.pow(1 + _esc / 100, _yrIdx - 1);
    var _qIdx = (qi - 1) % 4;
    _cumP += (qTargets[_qIdx] || 0) * _escFactor;
    cumPoints.push({ q: qi, proj: _cumP });
  }
  const maxY = (_cumP || annTarget * yrs) * 1.1;
  const padL = 35,
    padR = 20,
    padT = 10,
    padB = 30;
  const cW = svgW - padL - padR;
  const cH = svgH - padT - padB;
  const xScale = function (q) {
    return padL + ((q - 1) / Math.max(1, totalQtrs - 1)) * cW;
  };
  const yScale = function (v) {
    return padT + cH - (v / maxY) * cH;
  };

  // Per-quarter projected savings using actual quarterly targets
  const qtrProjVals = [];
  for (var qi2 = 1; qi2 <= totalQtrs; qi2++) {
    var _yrIdx2 = Math.ceil(qi2 / 4);
    var _escF2 = Math.pow(1 + _esc / 100, _yrIdx2 - 1);
    var _qIdx2 = (qi2 - 1) % 4;
    qtrProjVals.push((qTargets[_qIdx2] || 0) * _escF2);
  }
  const maxBarVal = Math.max.apply(null, qtrProjVals) * 1.3 || 1;

  // Current actual point — use cumulative savings across all completed quarters, not just this period
  const curQtr = ((d.contract.currentYear || 1) - 1) * 4 + (d.period.quarter || 1);
  const actCumVal = d.totals.cumulativeSavings != null ? d.totals.cumulativeSavings : d.totals.savings || 0;

  // Y-axis labels
  const yAxisLabels = [0, 0.25, 0.5, 0.75, 1.0]
    .map(function (f) {
      const val = f * annTarget * yrs;
      const y = yScale(val);
      return (
        '<text x="' +
        4 +
        '" y="' +
        y.toFixed(1) +
        '" text-anchor="start" font-size="8" fill="var(--rpt-page-text)" dominant-baseline="middle">$' +
        Math.round(val / 1000) +
        'k</text>'
      );
    })
    .join('');

  // X-axis labels — Q1-Q4 for each year
  const xAxisLabels = cumPoints
    .map(function (pt) {
      var qNum = ((pt.q - 1) % 4) + 1;
      var yrNum = Math.ceil(pt.q / 4);
      var label = qNum === 1 ? 'Y' + yrNum + ' Q1' : 'Q' + qNum;
      return (
        '<text x="' +
        (padL + ((pt.q - 0.5) / totalQtrs) * cW).toFixed(1) +
        '" y="' +
        (svgH - 8) +
        '" text-anchor="middle" font-size="' +
        (totalQtrs > 12 ? '6' : '7') +
        '" fill="var(--rpt-page-text)">' +
        label +
        '</text>'
      );
    })
    .join('');

  // Bar width and spacing
  const barGap = 2;
  const barW = Math.max(4, cW / totalQtrs - barGap);
  const barYScale = function (v) {
    return padT + cH - (v / maxBarVal) * cH;
  };

  // Projected quarterly bars
  const projBars = qtrProjVals
    .map(function (val, i) {
      var x = padL + (i / totalQtrs) * cW + barGap / 2;
      var h = (val / maxBarVal) * cH;
      var y = padT + cH - h;
      var isFuture = i + 1 > curQtr;
      return (
        '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        barW.toFixed(1) +
        '" height="' +
        h.toFixed(1) +
        '" fill="' +
        (isFuture ? 'var(--rpt-blue-tint)' : 'var(--rpt-blue-btn)') +
        '" opacity="0.6" rx="1"/>'
      );
    })
    .join('');

  // Actual cumulative line + green fill
  var actLinePts = [];
  if (curQtr >= 1) {
    actLinePts.push({ q: 0, v: 0 });
    actLinePts.push({ q: curQtr, v: Math.abs(actCumVal) });
  }
  var actLinePath = actLinePts
    .map(function (pt, i) {
      var x = padL + (pt.q / totalQtrs) * cW;
      var y = barYScale(Math.min(pt.v, maxBarVal));
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    })
    .join(' ');
  var actFillPath =
    actLinePath +
    ' L' +
    (padL + (curQtr / totalQtrs) * cW).toFixed(1) +
    ',' +
    (padT + cH) +
    ' L' +
    padL +
    ',' +
    (padT + cH) +
    ' Z';

  // Y-axis for bar chart
  const barYLabels = [0, 0.25, 0.5, 0.75, 1.0]
    .map(function (f) {
      var val = f * maxBarVal;
      var y = barYScale(val);
      return (
        '<text x="' +
        4 +
        '" y="' +
        y.toFixed(1) +
        '" text-anchor="start" font-size="8" fill="var(--rpt-page-text)" dominant-baseline="middle">$' +
        Math.round(val / 1000) +
        'k</text>'
      );
    })
    .join('');

  const cumulativeSVG =
    '<svg width="' +
    svgW +
    '" height="' +
    svgH +
    '" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="' +
    padL +
    '" y1="' +
    padT +
    '" x2="' +
    padL +
    '" y2="' +
    (padT + cH) +
    '" stroke="var(--rpt-divider)" stroke-width="1"/>' +
    '<line x1="' +
    padL +
    '" y1="' +
    (padT + cH) +
    '" x2="' +
    (padL + cW) +
    '" y2="' +
    (padT + cH) +
    '" stroke="var(--rpt-divider)" stroke-width="1"/>' +
    [0.25, 0.5, 0.75]
      .map(function (f) {
        var y = barYScale(f * maxBarVal);
        return (
          '<line x1="' +
          padL +
          '" y1="' +
          y.toFixed(1) +
          '" x2="' +
          (padL + cW) +
          '" y2="' +
          y.toFixed(1) +
          '" stroke="#eee" stroke-width="1" opacity="0.12"/>'
        );
      })
      .join('') +
    projBars +
    (actLinePts.length > 1 ? '<path d="' + actFillPath + '" fill="rgba(39,174,96,0.2)"/>' : '') +
    (actLinePts.length > 1 ? '<path d="' + actFillPath + '" fill="var(--rpt-chart-green-fill)"/>' : '') +
    (actLinePts.length > 1
      ? '<path d="' + actLinePath + '" fill="none" stroke="var(--rpt-chart-green)" stroke-width="2.5"/>'
      : '') +
    (actLinePts.length > 1
      ? '<circle cx="' +
        (padL + (curQtr / totalQtrs) * cW).toFixed(1) +
        '" cy="' +
        barYScale(Math.min(Math.abs(actCumVal), maxBarVal)).toFixed(1) +
        '" r="4" fill="var(--rpt-chart-green)" stroke="var(--rpt-page-bg)" stroke-width="1.5"/>'
      : '') +
    (actLinePts.length > 1
      ? '<text x="' +
        (padL + (curQtr / totalQtrs) * cW + 8).toFixed(1) +
        '" y="' +
        (barYScale(Math.min(Math.abs(actCumVal), maxBarVal)) - 5).toFixed(1) +
        '" font-size="9" fill="var(--rpt-chart-green-dk)" font-weight="bold">' +
        $c(actCumVal) +
        '</text>'
      : '') +
    barYLabels +
    xAxisLabels +
    '<rect x="' +
    (padL + cW - 140) +
    '" y="6" width="10" height="8" fill="var(--rpt-blue-btn)" opacity="0.6" rx="1"/>' +
    '<text x="' +
    (padL + cW - 126) +
    '" y="14" font-size="8" fill="var(--rpt-page-text)">Projected/Qtr</text>' +
    '<line x1="' +
    (padL + cW - 60) +
    '" y1="10" x2="' +
    (padL + cW - 46) +
    '" y2="10" stroke="var(--rpt-chart-green)" stroke-width="2.5"/>' +
    '<text x="' +
    (padL + cW - 42) +
    '" y="14" font-size="8" fill="var(--rpt-page-text)">Actual</text>' +
    '</svg>';

  const bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page summarizes the financial performance of each building in the portfolio for the reporting period. Baseline costs represent the expected energy spend based on historical consumption adjusted for weather. Projected costs reflect the target spend based on the contracted savings percentage. Current costs are the actual utility charges during the period. The difference between baseline and current represents verified cost avoidance.</p>' +
    '<h2>Building Performance</h2>' +
    bldgTable +
    '<h2>Quarterly Savings vs Baseline</h2>' +
    qtrTable +
    '<h2>CSC Compensation</h2>' +
    cscTable +
    (function () {
      var _moNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var _moData = {};
      (d.buildings || []).forEach(function (b) {
        ['electric', 'gas', 'propane'].forEach(function (com) {
          var mo = (b[com] && b[com].monthly) || [];
          mo.forEach(function (m) {
            if (!_moData[m.month]) _moData[m.month] = { bl: 0, cur: 0, sav: 0 };
            _moData[m.month].bl += m.blCost || 0;
            _moData[m.month].cur += m.curCost || 0;
            // Use canonical savings (Baseline Usage - Actual Usage) × Current Rate; fall back to dollar delta
            _moData[m.month].sav += m.savings != null ? m.savings : (m.blCost || 0) - (m.curCost || 0);
          });
        });
      });
      var _sorted = Object.keys(_moData).sort();
      if (_sorted.length < 2) return '';
      var _rows = '',
        _tBl = 0,
        _tCur = 0,
        _tSav = 0;
      _sorted.forEach(function (ym) {
        var mi = parseInt(ym.split('-')[1]) - 1;
        var bl = _moData[ym].bl,
          cur = _moData[ym].cur,
          sav = _moData[ym].sav;
        var pct = bl > 0 ? ((sav / bl) * 100).toFixed(1) + '%' : '—';
        _tBl += bl;
        _tCur += cur;
        _tSav += sav;
        _rows +=
          '<tr><td>' +
          _moNames[mi] +
          ' ' +
          ym.split('-')[0] +
          '</td><td class="rpt-n">' +
          $c(bl) +
          '</td><td class="rpt-n">' +
          $c(cur) +
          '</td><td class="rpt-n">' +
          $c(sav) +
          '</td></tr>';
      });
      var _tPct = _tBl > 0 ? ((_tSav / _tBl) * 100).toFixed(1) + '%' : '—';
      _rows +=
        '<tr class="rpt-tot"><td>Total</td><td class="rpt-n">' +
        $c(_tBl) +
        '</td><td class="rpt-n">' +
        $c(_tCur) +
        '</td><td class="rpt-n">' +
        $c(_tSav) +
        '</td></tr>';
      return (
        '<h2>Monthly Cost Breakdown</h2><table class="rpt-table" style="font-size:10px"><thead><tr><th>Month</th><th class="rpt-n">Baseline Cost</th><th class="rpt-n">Actual Cost</th><th class="rpt-n">Savings $</th></tr></thead><tbody>' +
        _rows +
        '</tbody></table>'
      );
    })() +
    '';

  return rptPage(n, 'Financial Summary', bodyHTML, { data: d, label: 'Page ' + n + ' — Financial Summary' });
}
function rptPageSavingsPerformance(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  const $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };

  // -- Monthly Savings: Projected vs Actual chart --
  // Inline HTML bars: projected (baseline) vs actual per month in period
  let chartSection = '';
  {
    const periodYMs = d.period.yearMonths || [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // Gather per-month projected (baseline kWh cost) and actual cost from buildings
    const moProj = {};
    const moActual = {};
    periodYMs.forEach(function (ym) {
      moProj[ym] = 0;
      moActual[ym] = 0;
    });
    d.buildings.forEach(function (b) {
      (b.electric.monthly || []).forEach(function (mo) {
        if (moProj[mo.month] === undefined && moActual[mo.month] === undefined) return;
        moProj[mo.month] = (moProj[mo.month] || 0) + (mo.blCost || 0);
        moActual[mo.month] = (moActual[mo.month] || 0) + (mo.curCost || 0);
      });
      (b.gas.monthly || []).forEach(function (mo) {
        if (moProj[mo.month] === undefined && moActual[mo.month] === undefined) return;
        moProj[mo.month] = (moProj[mo.month] || 0) + (mo.blCost || 0);
        moActual[mo.month] = (moActual[mo.month] || 0) + (mo.curCost || 0);
      });
      (b.propane && b.propane.monthly ? b.propane.monthly : []).forEach(function (mo) {
        if (moProj[mo.month] === undefined && moActual[mo.month] === undefined) return;
        moProj[mo.month] = (moProj[mo.month] || 0) + (mo.blCost || 0);
        moActual[mo.month] = (moActual[mo.month] || 0) + (mo.curCost || 0);
      });
    });
    const maxVal = Math.max(
      1,
      Math.max.apply(
        null,
        periodYMs.map(function (ym) {
          return Math.max(moProj[ym] || 0, moActual[ym] || 0);
        }),
      ),
    );
    const bars = periodYMs
      .map(function (ym) {
        const moIdx = parseInt(ym.split('-')[1]) - 1;
        const moLabel = monthNames[moIdx] + ' ' + ym.split('-')[0].slice(2);
        const projPct = Math.min(100, ((moProj[ym] || 0) / maxVal) * 100).toFixed(1);
        const actPct = Math.min(100, ((moActual[ym] || 0) / maxVal) * 100).toFixed(1);
        return (
          '<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">' +
          '<div style="width:40px;text-align:right;font-size:9px;color:var(--rpt-page-text)">' +
          moLabel +
          '</div>' +
          '<div style="flex:1">' +
          '<div style="display:flex;gap:2px;align-items:center">' +
          '<div style="width:' +
          projPct +
          '%;height:7px;background:var(--rpt-chart-orange);border-radius:2px;min-width:1px"></div>' +
          '<span style="font-size:8px;color:var(--rpt-page-text)">' +
          $c(moProj[ym]) +
          '</span>' +
          '</div>' +
          '<div style="display:flex;gap:2px;align-items:center;margin-top:1px">' +
          '<div style="width:' +
          actPct +
          '%;height:7px;background:var(--rpt-chart-green);border-radius:2px;min-width:1px"></div>' +
          '<span style="font-size:8px;color:var(--rpt-page-text)">' +
          $c(moActual[ym]) +
          '</span>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    chartSection =
      '<div class="rpt-chart-box">' +
      '<div class="rpt-chart-title">Monthly Savings — Projected (orange) vs Actual (green) — Dollar Cost</div>' +
      '<div style="display:flex;gap:12px;margin-bottom:4px;font-size:9px">' +
      '<span><span style="display:inline-block;width:10px;height:7px;background:var(--rpt-chart-orange);border-radius:2px;vertical-align:middle"></span> Projected Baseline</span>' +
      '<span><span style="display:inline-block;width:10px;height:7px;background:var(--rpt-chart-green);border-radius:2px;vertical-align:middle"></span> Actual</span>' +
      '</div>' +
      bars +
      '</div>';
  }

  // -- Annual Summary by Year table --
  // We have baseline totals and current period; build rows accordingly
  const _blYearStr = d.project.blEnd ? d.project.blEnd.split(' ').pop() : '';
  const blYearLabel = _blYearStr ? _blYearStr + ' Baseline' : 'Baseline';
  const blRow =
    '<tr>' +
    '<td contenteditable="true">' +
    blYearLabel +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.kwhBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.peakKwBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.thermsBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.propaneBl) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(d.totals.blCost) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    (d.totals.euiBaseline > 0 ? d.totals.euiBaseline.toFixed(1) : '—') +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">—</td>' +
    '</tr>';

  const savPct = d.totals.savingsPct || 0;
  const curYrLabel = d.period.year ? String(d.period.year) + ' Q' + (d.period.quarter || 1) : 'Current';
  const curRow =
    '<tr>' +
    '<td contenteditable="true">' +
    curYrLabel +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.kwhCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.peakKwCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.thermsCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $n(d.totals.propaneCur) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    $c(d.totals.curCost) +
    '</td>' +
    '<td class="rpt-n" contenteditable="true">' +
    (d.totals.euiCurrent > 0 ? d.totals.euiCurrent.toFixed(1) : '—') +
    '</td>' +
    '<td class="rpt-n ' +
    (savPct >= 0 ? 'rpt-g' : 'rpt-r') +
    '" contenteditable="true">' +
    $p(savPct) +
    '</td>' +
    '</tr>';

  // Build year-over-year rows from monthly data across all buildings
  var _yoyByYear = {};
  (d.buildings || []).forEach(function (b) {
    ['electric', 'gas', 'propane'].forEach(function (com) {
      var monthly = (b[com] && b[com].monthly) || [];
      monthly.forEach(function (mo) {
        if (!mo.month) return;
        var yr = mo.month.split('-')[0];
        if (!_yoyByYear[yr]) _yoyByYear[yr] = { kwh: 0, kw: 0, therms: 0, gal: 0, cost: 0, sav: 0, kbtu: 0 };
        if (com === 'electric') {
          _yoyByYear[yr].kwh += mo.cur || 0;
          _yoyByYear[yr].kw += mo.kwCur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
          _yoyByYear[yr].sav += mo.savings || 0;
          _yoyByYear[yr].kbtu += toKBtu(mo.cur || 0, 0, 0);
        } else if (com === 'gas') {
          _yoyByYear[yr].therms += mo.cur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
          _yoyByYear[yr].sav += mo.savings || 0;
          _yoyByYear[yr].kbtu += toKBtu(0, mo.cur || 0, 0);
        } else {
          _yoyByYear[yr].gal += mo.cur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
          _yoyByYear[yr].sav += mo.savings || 0;
          _yoyByYear[yr].kbtu += toKBtu(0, 0, mo.cur || 0);
        }
      });
    });
  });
  var _yoyYears = Object.keys(_yoyByYear).sort();
  var _totalSqft =
    d.buildings.reduce(function (s, b) {
      return s + (b.sqft || 0);
    }, 0) || 1;
  var _yoyRows = '';
  _yoyYears.forEach(function (yr) {
    var y = _yoyByYear[yr];
    var eui = _totalSqft > 0 ? (y.kbtu / _totalSqft).toFixed(1) : '—';
    // NOTE: denominator is current-period baseline cost, not full-year baseline. YoY rows covering
    // calendar years outside the reporting period are directionally correct but not dimensionally
    // comparable — this is a pre-existing limitation, not introduced here.
    var vsBl = d.totals.blCost > 0 ? (y.sav / d.totals.blCost) * 100 : 0;
    _yoyRows +=
      '<tr><td contenteditable="true">' +
      yr +
      '</td><td class="rpt-n" contenteditable="true">' +
      $n(y.kwh) +
      '</td><td class="rpt-n" contenteditable="true">' +
      $n(y.kw) +
      '</td><td class="rpt-n" contenteditable="true">' +
      $n(y.therms) +
      '</td><td class="rpt-n" contenteditable="true">' +
      $n(y.gal) +
      '</td><td class="rpt-n" contenteditable="true">' +
      $c(y.cost) +
      '</td><td class="rpt-n" contenteditable="true">' +
      eui +
      '</td><td class="rpt-n ' +
      (vsBl >= 0 ? 'rpt-g' : 'rpt-r') +
      '" contenteditable="true">' +
      $p(vsBl) +
      '</td></tr>';
  });
  var annTableBody = blRow + (_yoyRows || curRow);

  const annTable =
    '<table class="rpt-table" contenteditable="true" style="width:100%;table-layout:fixed">' +
    '<thead><tr style="text-align:center;white-space:normal;word-wrap:break-word;line-height:1.2">' +
    '<th style="width:12%">Year</th>' +
    '<th class="rpt-n" style="width:14%">kWh</th>' +
    '<th class="rpt-n" style="width:10%">Peak kW</th>' +
    '<th class="rpt-n" style="width:12%">Therms</th>' +
    '<th class="rpt-n" style="width:12%">Propane<br>Gal</th>' +
    '<th class="rpt-n" style="width:14%">Cost</th>' +
    '<th class="rpt-n" style="width:8%">Site EUI</th>' +
    '<th class="rpt-n" style="width:12%">vs<br>Baseline</th>' +
    '</tr></thead>' +
    '<tbody>' +
    annTableBody +
    '</tbody>' +
    '</table>';

  // -- Annual Summary by Building table (2 rows per building: BL + current) --
  const bldgRows = d.buildings
    .map(function (b, bIdx) {
      const bSavPct = b.savingsPct || 0; // dead code: not rendered; fixed for correctness (was dollar-delta)
      const blEUI = b.eui.baseline > 0 ? b.eui.baseline.toFixed(1) : '—';
      const curEUI = b.eui.current > 0 ? b.eui.current.toFixed(1) : '—';
      const euiChange =
        b.eui.baseline > 0 && b.eui.current > 0 ? ((b.eui.baseline - b.eui.current) / b.eui.baseline) * 100 : 0;
      var rowBg = bIdx % 2 === 1 ? 'background:var(--rpt-table-stripe);' : '';
      /* rowspan="2" covers both rows per building (BL + current year);
         update to rowspan="3" if a 3rd row per building is ever added */
      return (
        '<tr style="' +
        rowBg +
        '">' +
        '<td rowspan="2" style="font-weight:600;vertical-align:middle;font-size:9px;' +
        rowBg +
        '" contenteditable="true">' +
        (b.name || '—') +
        '</td>' +
        '<td contenteditable="true" style="color:var(--rpt-page-text)">' +
        blYearLabel +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.electric.kwhBl) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.electric.kwBl) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.gas.thermsBl) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.propane.galBl) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $c(b.blCost) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        blEUI +
        '</td>' +
        '</tr>' +
        '<tr style="' +
        rowBg +
        '">' +
        /* name <td> omitted -- rowspan="2" on row 1 covers column 1 for this building */
        '<td contenteditable="true" style="color:var(--rpt-blue);font-weight:600">' +
        curYrLabel +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.electric.kwhCur) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.electric.kwCur) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.gas.thermsCur) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.propane.galCur) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $c(b.curCost) +
        '</td>' +
        '<td class="rpt-n ' +
        (euiChange >= 0 ? 'rpt-g' : 'rpt-r') +
        '" contenteditable="true">' +
        curEUI +
        ' (' +
        (euiChange >= 0 ? '+' : '') +
        $p(euiChange) +
        ')</td>' +
        '</tr>'
      );
    })
    .join('');

  const bldgTable =
    '<table class="rpt-table" contenteditable="true" style="font-size:10px">' +
    '<thead><tr>' +
    '<th>Building</th>' +
    '<th>Year</th>' +
    '<th class="rpt-n">kWh</th>' +
    '<th class="rpt-n">kW</th>' +
    '<th class="rpt-n">Therms</th>' +
    '<th class="rpt-n">Propane Gallons</th>' +
    '<th class="rpt-n">Cost</th>' +
    '<th class="rpt-n">Site EUI</th>' +
    '</tr></thead>' +
    '<tbody>' +
    bldgRows +
    '</tbody>' +
    '</table>';

  const bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page compares projected energy savings against actual performance. The monthly chart shows weather-normalized baseline consumption (projected) versus actual consumption by month. The annual summary tables aggregate consumption, demand, and cost data across all commodities to show the portfolio\'s year-over-year performance trend.</p>' +
    '<h2>Monthly Savings: Projected vs Actual</h2>' +
    chartSection +
    '<h2>Annual Summary by Year</h2>' +
    annTable +
    '<h2>Annual Summary by Building</h2>' +
    bldgTable;

  return rptPage(n, 'Savings Performance', bodyHTML, { data: d, label: 'Page ' + n + ' — Savings Performance' });
}
function rptPageEUI(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  const $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };

  // -- Building Performance Rankings table --
  const hasEnergyStar = d.buildings.some(function (b) {
    return b.eui && b.eui.energyStar;
  });
  // Sort buildings by current EUI ascending (best first)
  const sorted = d.buildings.slice().sort(function (a, b) {
    return (a.eui.current || 0) - (b.eui.current || 0);
  });

  const rankRows = sorted
    .map(function (b, i) {
      const cbecs = b.eui.cbecs || 0;
      const cur = b.eui.current || 0;
      const bl = b.eui.baseline || 0;
      const vsCbecs = cbecs > 0 ? ((cur - cbecs) / cbecs) * 100 : 0;
      const vsCbecsClass = vsCbecs <= 0 ? 'rpt-g' : 'rpt-r';
      const eStarCell = b.eui.energyStar ? '<span style="color:var(--rpt-green);font-weight:700">Yes</span>' : '—';
      const cpSqft = b.sqft > 0 ? b.curCost / b.sqft : 0;
      const trendCell =
        cur > 0 && bl > 0
          ? cur < bl
            ? '<span style="color:var(--rpt-green)">&#9660;</span>'
            : cur > bl
              ? '<span style="color:var(--rpt-red)">&#9650;</span>'
              : '<span style="color:var(--rpt-page-text)">&#9654;</span>'
          : '<span style="color:var(--rpt-page-text)">—</span>';
      return (
        '<tr>' +
        '<td contenteditable="true">' +
        (i + 1) +
        '</td>' +
        '<td contenteditable="true">' +
        (b.name || '—') +
        '</td>' +
        '<td contenteditable="true">' +
        (b.type || '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        $n(b.sqft) +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (bl > 0 ? bl.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (cur > 0 ? cur.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (cbecs > 0 ? cbecs.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n ' +
        vsCbecsClass +
        '" contenteditable="true">' +
        $p(vsCbecs) +
        '</td>' +
        '<td contenteditable="true">' +
        (b.eui.percentile || '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (cpSqft > 0 ? '$' + cpSqft.toFixed(2) : '—') +
        '</td>' +
        '<td contenteditable="true">' +
        eStarCell +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  const rankTable =
    '<table class="rpt-table rpt-table-wrap" contenteditable="true" style="font-size:10px;width:100%;table-layout:fixed">' +
    '<colgroup>' +
    '<col style="width:4%">' +
    '<col style="width:21%">' +
    '<col style="width:8%">' +
    '<col style="width:8%">' +
    '<col style="width:9%">' +
    '<col style="width:9%">' +
    '<col style="width:6%">' +
    '<col style="width:9%">' +
    '<col style="width:8%">' +
    '<col style="width:6%">' +
    '<col style="width:12%">' +
    '</colgroup>' +
    '<thead><tr style="white-space:normal;word-wrap:break-word;line-height:1.2">' +
    '<th>#</th>' +
    '<th>Building</th>' +
    '<th>Type</th>' +
    '<th class="rpt-n">Square Feet</th>' +
    '<th class="rpt-n">Baseline Site EUI</th>' +
    '<th class="rpt-n">Current Site EUI</th>' +
    '<th class="rpt-n">CBECS</th>' +
    '<th class="rpt-n">vs CBECS %</th>' +
    '<th>Percentile</th>' +
    '<th class="rpt-n">$/ft²</th>' +
    '<th>ENERGY STAR</th>' +
    '</tr></thead>' +
    '<tbody>' +
    rankRows +
    '</tbody>' +
    '</table>';

  // -- EUI vs CBECS horizontal bar chart --
  // Find max EUI across buildings and CBECS values for scaling
  const allEuis = d.buildings.map(function (b) {
    return Math.max(b.eui.current || 0, b.eui.cbecs || 0, b.eui.baseline || 0);
  });
  const maxEUI = Math.max(1, Math.max.apply(null, allEuis) * 1.1);

  const euiBars = sorted
    .map(function (b) {
      const cur = b.eui.current || 0;
      const cbecs = b.eui.cbecs || 0;
      const bl = b.eui.baseline || 0;
      const barPct = Math.min(100, (cur / maxEUI) * 100).toFixed(1);
      const cbecsLinePct = Math.min(100, (cbecs / maxEUI) * 100).toFixed(1);
      const blLinePct = bl > 0 ? Math.min(100, (bl / maxEUI) * 100).toFixed(1) : 0;
      const barColor = cur <= cbecs ? 'var(--rpt-chart-green)' : 'var(--rpt-chart-orange)';
      return (
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
        '<div style="width:140px;text-align:right;font-size:10px;color:var(--rpt-page-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">' +
        (b.name || '—') +
        '</div>' +
        '<div style="flex:1;height:18px;background:var(--rpt-progress-bg);border-radius:3px;position:relative">' +
        '<div style="width:' +
        barPct +
        '%;height:100%;background:' +
        barColor +
        ';border-radius:3px"></div>' +
        '<div style="position:absolute;left:' +
        cbecsLinePct +
        '%;top:0;bottom:0;width:2px;background:var(--rpt-red);z-index:1"></div>' +
        (bl > 0
          ? '<div style="position:absolute;left:' +
            blLinePct +
            '%;top:0;bottom:0;width:2px;background:var(--rpt-eui-purple);z-index:1"></div>'
          : '') +
        '</div>' +
        '<div style="width:35px;font-size:9px;font-weight:600;color:var(--rpt-page-text);flex-shrink:0">' +
        (cur > 0 ? cur.toFixed(1) : '—') +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  const euiChart =
    '<div class="rpt-chart-box">' +
    '<div class="rpt-chart-title">Current Site EUI by Building</div>' +
    '<div style="display:flex;gap:12px;margin-bottom:4px;font-size:9px">' +
    '<span><span style="display:inline-block;width:10px;height:7px;background:var(--rpt-chart-green);border-radius:2px;vertical-align:middle"></span> Below CBECS</span>' +
    '<span><span style="display:inline-block;width:10px;height:7px;background:var(--rpt-chart-orange);border-radius:2px;vertical-align:middle"></span> Above CBECS</span>' +
    '<span><span style="display:inline-block;width:2px;height:10px;background:var(--rpt-red);vertical-align:middle"></span> CBECS Median</span>' +
    '<span><span style="display:inline-block;width:2px;height:10px;background:var(--rpt-eui-purple);vertical-align:middle"></span> Baseline Site EUI</span>' +
    '</div>' +
    euiBars +
    '</div>';

  // -- EUI Trend table --
  const curYrLabel = d.period.year ? String(d.period.year) : 'Current';
  const trendRows = d.buildings
    .map(function (b) {
      const bl = b.eui.baseline || 0;
      const cur = b.eui.current || 0;
      const reduction = bl > 0 ? ((bl - cur) / bl) * 100 : 0;
      const redClass = reduction >= 0 ? 'rpt-g' : 'rpt-r';
      const trendIcon =
        cur > 0 && bl > 0
          ? cur < bl
            ? '<span style="color:var(--rpt-green)">&#9660;</span>'
            : cur > bl
              ? '<span style="color:var(--rpt-red)">&#9650;</span>'
              : '<span style="color:var(--rpt-page-text)">&#9654;</span>'
          : '<span style="color:var(--rpt-page-text)">—</span>';
      return (
        '<tr>' +
        '<td contenteditable="true">' +
        (b.name || '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (bl > 0 ? bl.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n" contenteditable="true">' +
        (cur > 0 ? cur.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n ' +
        redClass +
        '" contenteditable="true">' +
        $p(reduction) +
        '</td>' +
        '<td contenteditable="true">' +
        trendIcon +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  const trendTable =
    '<table class="rpt-table" contenteditable="true">' +
    '<thead><tr>' +
    '<th>Building</th>' +
    '<th class="rpt-n">Baseline Site EUI</th>' +
    '<th class="rpt-n">' +
    curYrLabel +
    ' Site EUI</th>' +
    '<th class="rpt-n">Reduction</th>' +
    '<th>Trend</th>' +
    '</tr></thead>' +
    '<tbody>' +
    trendRows +
    '</tbody>' +
    '</table>';

  const bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">Site Energy Use Intensity (Site EUI) measures total energy consumption at the utility meter per square foot per year in kBtu/ft². Lower EUI values indicate more efficient buildings. Buildings are benchmarked against national CBECS (Commercial Buildings Energy Consumption Survey) median values for their building type. Buildings performing below the CBECS median are more efficient than the national average. The rolling 12-month Site EUI accounts for seasonal variation and provides a stable year-round performance indicator.</p>' +
    '<h2>Building Performance Rankings</h2>' +
    rankTable +
    '<h2>Site EUI vs CBECS Benchmark</h2>' +
    euiChart +
    '<h2>Site EUI Trend</h2>' +
    trendTable;

  return rptPage(n, 'Site EUI Benchmarking', bodyHTML, { data: d, label: 'Page ' + n + ' — Site EUI Benchmarking' });
}
function rptPageEnvironmentalImpact(n, d) {
  var _annualize = d.reportOptions && d.reportOptions.annualizePollution && d.period && d.period.type === 'quarterly';
  var _annFactor = _annualize ? 4 : 1;
  var _polRaw = d.pollution && d.pollution.pollutants ? d.pollution.pollutants : {};
  var pol = {};
  Object.keys(_polRaw).forEach(function (k) {
    pol[k] = (_polRaw[k] || 0) * _annFactor;
  });
  var _eqRaw = d.pollution && d.pollution.equivalents ? d.pollution.equivalents : {};
  var eq = {};
  Object.keys(_eqRaw).forEach(function (k) {
    eq[k] = (_eqRaw[k] || 0) * _annFactor;
  });
  const inp = d.pollution && d.pollution.inputs ? d.pollution.inputs : {};
  const st = d.pollution && d.pollution.stateCode ? d.pollution.stateCode : '—';
  const $n = function (v) {
    return Math.round(Math.abs(v || 0)).toLocaleString();
  };

  function polLine(val, unit, label) {
    if (!val || Math.round(Math.abs(val)) === 0) return '';
    return (
      '<div style="font-size:13px;color:var(--rpt-page-text);padding:2px 0;line-height:1.5;text-align:center">' +
      '<strong style="color:var(--rpt-blue);font-size:16px">' +
      $n(val) +
      '</strong>' +
      ' total ' +
      unit +
      ' of ' +
      label +
      '</div>'
    );
  }

  function eqLine(prefix, val, suffix) {
    if (!val || Math.round(Math.abs(val)) === 0) return '';
    return (
      '<div style="font-size:13px;color:var(--rpt-page-text);padding:2px 0;line-height:1.5;text-align:center">' +
      (prefix ? prefix + ' ' : '') +
      '<strong style="color:var(--rpt-green-dark);font-size:16px">' +
      $n(val) +
      '</strong>' +
      ' ' +
      suffix +
      '</div>'
    );
  }

  // Build only the non-zero lines so blank space is eliminated
  var polLines =
    polLine(pol.co2, 'pounds', 'CO₂ (carbon dioxide)') +
    polLine(pol.ch4, 'pounds', 'CH₄ (methane)') +
    polLine(pol.n2o, 'pounds', 'N₂O (nitrous oxide)') +
    polLine(pol.so2, 'pounds', 'SO2 (sulfur dioxide)') +
    polLine(pol.nox, 'pounds', 'NOX (nitrogen oxide)') +
    polLine(pol.hg_oz, 'ounces', 'HG (mercury)') +
    polLine(pol.pm10_oz, 'ounces', 'PM10 (fine particles)') +
    polLine(pol.voc_oz, 'ounces', 'VOC (volatile organic compounds)') +
    polLine(pol.co_oz, 'ounces', 'CO (carbon monoxide)');

  var eqLines =
    eqLine('Removing', eq.carsRemoved, 'cars from the road per year') +
    eqLine('Conserving', eq.gallonsGasoline, 'gallons of gasoline per year') +
    eqLine('Conserving', eq.tankerTrucks, 'tanker trucks of gasoline per year') +
    eqLine('Conserving', eq.barrelsOil, 'barrels of oil per year') +
    eqLine('Powering', eq.households, 'households for one year') +
    eqLine('Growing', eq.treeSeedlings, 'tree seedlings for 10 years') +
    eqLine('Preserving', eq.acresForest, 'acres of forest from deforestation') +
    eqLine('Displacing', eq.railcarsCoal, 'railcars of coal per year') +
    eqLine('Recycling', eq.tonsRecycled, 'tons of waste instead of landfilling') +
    eqLine('Replacing', eq.propaneCylinders, 'propane cylinders per year') +
    eqLine('Offsetting', eq.coalPlants, 'coal-fired power plant emissions per year');

  if (!polLines)
    polLines =
      '<div style="font-size:10px;color:var(--rpt-page-text);font-style:italic;text-align:center">No pollutant data available.</div>';
  if (!eqLines)
    eqLines =
      '<div style="font-size:10px;color:var(--rpt-page-text);font-style:italic;text-align:center">No equivalents data available.</div>';

  const bodyHTML =
    '<div contenteditable="true">' +
    '<div style="font-size:16px;font-weight:700;color:var(--rpt-blue);margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px;text-align:center">Environmental Impact — Pollution Reduction Credits</div>' +
    '<div style="font-size:12px;color:var(--rpt-page-text);margin-bottom:10px;text-align:center">Emission reductions resulting from energy savings achieved during the reporting period' +
    (_annualize ? ' (values annualized ×4 from quarterly data)' : '') +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    '<div style="padding:4px 0;text-align:center">' +
    '<div style="font-size:13px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Pollutants Avoided</div>' +
    polLines +
    '</div>' +
    '<div style="padding:4px 0;text-align:center">' +
    '<div style="font-size:13px;font-weight:700;color:var(--rpt-bl-green);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Real-World Equivalents</div>' +
    eqLines +
    '</div>' +
    '</div>' +
    '<div style="margin-top:24px;font-size:10px;color:var(--rpt-page-text);padding-top:6px;text-align:center">' +
    'Source: EPA eGRID2023 Version 1.0 Rev 1 — https://www.epa.gov/egrid | State: ' +
    st +
    ' | Inputs: ' +
    $n(inp.kwhSaved) +
    ' kWh + ' +
    $n(inp.thermsSaved) +
    ' Therms + ' +
    $n(inp.propaneGalSaved) +
    ' Gal Propane' +
    '</div>' +
    '</div>';

  return rptPage(n, 'Environmental Impact', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Environmental Impact',
  });
}
function rptPageObservations(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };

  // -- Overall summary --
  const totalSav = d.totals ? d.totals.savings : 0;
  const target = d.contract
    ? d.period && d.period.quarter
      ? d.contract.quarterlyTargets[d.period.quarter - 1] || d.contract.annualTarget
      : d.contract.annualTarget
    : 0;
  const pctOfTarget = target > 0 ? Math.round((totalSav / target) * 100) : 0;
  const onTrackCount = d.buildings
    ? d.buildings.filter(function (b) {
        return b.status === 'on_track';
      }).length
    : 0;
  const totalBldgs = d.buildings ? d.buildings.length : 0;
  const periodLabel = d.period ? d.period.label : '';
  const clientName = d.project ? d.project.client : '';
  const perfWord = pctOfTarget >= 100 ? 'exceeding' : pctOfTarget >= 80 ? 'approaching' : 'below';

  const summaryPara =
    '<p contenteditable="true">' +
    'During ' +
    periodLabel +
    ', ' +
    clientName +
    ' achieved ' +
    $c(totalSav) +
    ' in verified energy cost savings, representing ' +
    pctOfTarget +
    '% of the period target — ' +
    perfWord +
    ' the contracted performance benchmark. ' +
    onTrackCount +
    ' of ' +
    totalBldgs +
    ' building' +
    (totalBldgs !== 1 ? 's are' : ' is') +
    ' on track or ahead of target for the period.' +
    '</p>';

  // -- Per-building narrative (array — used for pagination below) --
  const bldgSectionItems = (d.buildings || []).map(function (b) {
    const statusColor =
      b.status === 'on_track'
        ? 'var(--rpt-green)'
        : b.status === 'near_target'
          ? 'var(--rpt-orange)'
          : 'var(--rpt-red)';
    const arrow = b.status === 'on_track' ? '&#9650;' : b.status === 'near_target' ? '&#9658;' : '&#9660;';
    const statusLabel =
      b.status === 'on_track' ? 'On Track' : b.status === 'near_target' ? 'Approaching Target' : 'Below Target';

    // Determine the strongest commodity by savings
    const comSavings = [
      { name: 'Electric', sav: (b.electric && b.electric.costSaved) || 0 },
      { name: 'Gas', sav: (b.gas && b.gas.costSaved) || 0 },
      { name: 'Propane', sav: (b.propane && b.propane.costSaved) || 0 },
    ].filter(function (c) {
      return b.commodities && b.commodities.includes(c.name);
    });
    comSavings.sort(function (a, c) {
      return c.sav - a.sav;
    });
    const topCom = comSavings.length ? comSavings[0] : null;
    const weakCom = comSavings.length ? comSavings[comSavings.length - 1] : null;

    // Build subtitle and narrative based on status
    var subtitle, narrative, rec;
    var strongWeak = '';
    if (topCom && weakCom && topCom.name !== weakCom.name) {
      strongWeak = topCom.name + ' is the strongest performer. ' + weakCom.name + ' is the weakest performer.';
    } else if (topCom) {
      strongWeak = topCom.name + ' is the primary commodity.';
    }

    var rawSav =
      ((b.electric && b.electric.costSaved) || 0) +
      ((b.gas && b.gas.costSaved) || 0) +
      ((b.propane && b.propane.costSaved) || 0);
    var blAtCurRate = b.blCost || 0;
    var rawSavPct = blAtCurRate > 0 ? (rawSav / blAtCurRate) * 100 : 0;

    if (b.status === 'on_track') {
      subtitle = 'On Track';
      narrative =
        b.name +
        ' is performing at ' +
        $p(rawSavPct) +
        ' savings (' +
        $c(rawSav) +
        ' saved) against a baseline cost of ' +
        $c(b.blCost) +
        ', with current costs at ' +
        $c(b.curCost) +
        '. ' +
        strongWeak;
      rec = 'Continue current operating strategy. Monitor for seasonal load shifts entering the next quarter.';
    } else if (b.status === 'near_target') {
      subtitle = 'Approaching Target';
      narrative =
        b.name +
        ' is tracking at ' +
        $p(rawSavPct) +
        ' savings (' +
        $c(rawSav) +
        ' saved) against a baseline cost of ' +
        $c(b.blCost) +
        ', with current costs at ' +
        $c(b.curCost) +
        '. ' +
        strongWeak;
      rec =
        'Review scheduling and setpoints for optimization opportunities. Confirm occupancy schedules are aligned with current use patterns.';
    } else {
      subtitle = 'Below Target';
      narrative =
        b.name +
        ' is currently below the performance target at ' +
        $p(rawSavPct) +
        ' savings (' +
        $c(rawSav) +
        ' saved) against a baseline cost of ' +
        $c(b.blCost) +
        ', with current costs at ' +
        $c(b.curCost) +
        '. ' +
        strongWeak;
      rec =
        'Review ' +
        (weakCom ? weakCom.name.toLowerCase() : 'utility') +
        ' meter data and trend logs for anomalies. Confirm BAS setpoints are active and not in override.';
    }

    return (
      '<h3 contenteditable="true" style="font-size:14px;font-weight:700;color:' +
      statusColor +
      ';margin:10px 0 2px">' +
      arrow +
      ' ' +
      (b.name || 'Building') +
      ' — ' +
      subtitle +
      '</h3>' +
      '<p contenteditable="true">' +
      narrative +
      '</p>' +
      '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);margin-top:2px"><strong>Recommendation:</strong> ' +
      rec +
      '</p>'
    );
  });

  // -- Weather section --
  const wt = d.weather && d.weather.totals ? d.weather.totals : { hddBl: 0, hddCur: 0, cddBl: 0, cddCur: 0 };
  const hddDiff = wt.hddCur - wt.hddBl;
  const cddDiff = wt.cddCur - wt.cddBl;
  const hddPct = wt.hddBl > 0 ? Math.abs((hddDiff / wt.hddBl) * 100).toFixed(0) : 0;
  const cddPct = wt.cddBl > 0 ? Math.abs((cddDiff / wt.cddBl) * 100).toFixed(0) : 0;
  const hddNote =
    hddDiff > wt.hddBl * 0.1
      ? ' The period was notably colder than the baseline, which likely increased heating loads and reduced apparent savings on a raw-consumption basis.'
      : '';
  const weatherPara =
    '<p contenteditable="true">' +
    'Heating degree days (HDD) for the period were ' +
    Math.round(wt.hddCur) +
    ' vs. a baseline average of ' +
    Math.round(wt.hddBl) +
    ' (' +
    (hddDiff >= 0 ? '+' : '-') +
    hddPct +
    '%). ' +
    'Cooling degree days (CDD) were ' +
    Math.round(wt.cddCur) +
    ' vs. a baseline of ' +
    Math.round(wt.cddBl) +
    ' (' +
    (cddDiff >= 0 ? '+' : '-') +
    cddPct +
    '%). ' +
    hddNote +
    'Normalized savings figures account for weather variance using regression-based baseline adjustment.' +
    '</p>';

  // -- Next Quarter section --
  const qNum = d.period ? d.period.quarter : null;
  const inHeatingSeason = qNum === 1 || qNum === 4;
  const seasonNote = inHeatingSeason
    ? 'As we move toward the cooling season, expect electric demand to increase. Monitor peak demand events and ensure economizer and scheduling programs are ready for summer operation.'
    : 'As we transition toward the heating season, verify heating setpoints and boiler/furnace scheduling are properly programmed. Confirm warm-weather setbacks are not lingering into fall.';
  const nextQPara =
    '<p contenteditable="true">' +
    seasonNote +
    ' The next quarterly review meeting will cover period performance in detail, review any approved change orders, and confirm setpoint schedules for the upcoming season. ' +
    'Monthly monitoring calls will continue on schedule.' +
    '</p>';

  // -- Pagination: split building sections across pages using shared pixel-height paginator --
  // Wraps each building HTML block as a token (type:'block', estH:150px) and calls
  // _rptPaginateTokens so both the Quarterly Report and the ASHRAE Audit share the same
  // pagination mechanism (architectural mandate: one source of truth).
  //
  // fix/report-content-pagination (2026-07-28): budgets now derive from _rptContentBudget()
  // (the shared page-geometry source of truth, see its doc comment above _rptPaginateTokens)
  // instead of standalone literals. _obsBase is the full available .rpt-body height for this
  // page's standard header variant; OBS_FIRST_CHROME/OBS_CONT_CHROME are this page's own
  // per-page chrome (heading, summary paragraph, continuation heading) plus the safety margin
  // already baked into the prior hardcoded 805/865 budgets -- numerically unchanged from before.
  var _obsBase = _rptContentBudget('standard');
  var OBS_FIRST_CHROME = 99; // page-1 heading (~30px) + summary paragraph (~60px) + safety margin
  var OBS_CONT_CHROME = 39; // continuation-page heading (~30px) + safety margin
  var _obsTokens = bldgSectionItems.map(function (html) {
    return { type: 'block', html: html, estH: 150 };
  });
  var _obsChunks = _rptPaginateTokens(_obsTokens, _obsBase - OBS_FIRST_CHROME, _obsBase - OBS_CONT_CHROME);

  var resultPages = [];
  var currentPageNum = n;

  // Guard: if no buildings, still emit one page with heading + summary + Weather + Next Quarter
  // (mirrors old behavior where at least one page was always produced).
  if (_obsChunks.length === 0) {
    var emptyPageBody =
      '<h2 contenteditable="true">Building Performance</h2>' +
      '<div style="font-size:14px;line-height:1.6;margin-bottom:8px" contenteditable="true">' +
      summaryPara +
      '</div>' +
      '<h2 contenteditable="true">Weather</h2>' +
      weatherPara +
      '<h2 contenteditable="true">Next Quarter</h2>' +
      nextQPara;
    resultPages.push(
      rptPage(currentPageNum, 'Observations & Recommendations', emptyPageBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Observations',
      }),
    );
    return { html: resultPages.join(''), pageCount: resultPages.length };
  }

  _obsChunks.forEach(function (chunk, chunkIdx) {
    var isFirst = chunkIdx === 0;
    var isLast = chunkIdx === _obsChunks.length - 1;
    var chunkHTML = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');

    var pageBody;
    if (isFirst) {
      pageBody =
        '<h2 contenteditable="true">Building Performance</h2>' +
        '<div style="font-size:14px;line-height:1.6;margin-bottom:8px" contenteditable="true">' +
        summaryPara +
        '</div>' +
        chunkHTML;
    } else {
      pageBody = chunkHTML;
    }

    if (isLast) {
      // Append weather + next quarter to the final page
      pageBody +=
        '<h2 contenteditable="true">Weather</h2>' +
        weatherPara +
        '<h2 contenteditable="true">Next Quarter</h2>' +
        nextQPara;
    }

    resultPages.push(
      rptPage(
        currentPageNum,
        isFirst ? 'Observations & Recommendations' : 'Observations & Recommendations (cont.)',
        pageBody,
        {
          data: d,
          label: 'Page ' + currentPageNum + ' — Observations' + (isFirst ? '' : ' (cont.)'),
        },
      ),
    );
    currentPageNum++;
  });

  return { html: resultPages.join(''), pageCount: resultPages.length };
}
function rptPageApprovedChanges(n, d) {
  const changes = (d && d.approvedChanges) || [];

  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  let changesRows = '';
  if (changes.length > 0) {
    changes.forEach(function (c) {
      changesRows +=
        '<tr>' +
        '<td contenteditable="true">' +
        (c.completedDate || '').slice(0, 10) +
        '</td>' +
        '<td contenteditable="true">' +
        (c.building || '') +
        '</td>' +
        '<td contenteditable="true">' +
        (c.proposedChange || '') +
        '</td>' +
        '<td contenteditable="true">' +
        (c.approvedBy || '') +
        '</td>' +
        '<td contenteditable="true">' +
        (c.source || 'Change Order') +
        '</td>' +
        '</tr>';
    });
  } else {
    // 3 empty editable template rows
    for (var ri = 0; ri < 3; ri++) {
      changesRows +=
        '<tr>' +
        '<td contenteditable="true"></td>' +
        '<td contenteditable="true"></td>' +
        '<td contenteditable="true"></td>' +
        '<td contenteditable="true"></td>' +
        '<td contenteditable="true"></td>' +
        '</tr>';
    }
  }
  const changesTable =
    '<table class="rpt-table" contenteditable="true">' +
    '<thead><tr>' +
    '<th>Date</th><th>Building</th><th>Change Description</th><th>Approved By</th><th>Source</th>' +
    '</tr></thead>' +
    '<tbody>' +
    changesRows +
    '</tbody>' +
    '</table>';

  // -- Net Impact narrative box --
  const narrativeBox =
    '<div class="rpt-narrative" contenteditable="true">' +
    '<strong>Positive impacts:</strong> [describe schedule/setpoint optimizations and estimated savings]<br>' +
    '<strong>Negative impacts:</strong> [describe any changes that increased energy use]<br>' +
    '<strong>Net Q' +
    ((d && d.period && d.period.quarter) || '?') +
    ' effect:</strong> [net impact summary]' +
    '</div>';

  // -- Upcoming Scheduled Changes table (3 empty rows) --
  let upcomingRows = '';
  for (var ui = 0; ui < 3; ui++) {
    upcomingRows +=
      '<tr>' +
      '<td contenteditable="true"></td>' +
      '<td contenteditable="true"></td>' +
      '<td contenteditable="true"></td>' +
      '<td contenteditable="true"></td>' +
      '</tr>';
  }
  const upcomingTable =
    '<table class="rpt-table" contenteditable="true">' +
    '<thead><tr>' +
    '<th>Planned Date</th><th>Building</th><th>Planned Change</th><th>Status</th>' +
    '</tr></thead>' +
    '<tbody>' +
    upcomingRows +
    '</tbody>' +
    '</table>';

  const bodyHTML =
    '<div class="rpt-body">' +
    '<p style="font-size:12px;color:var(--rpt-page-text);margin:0 0 8px">Schedule and setpoint changes implemented this quarter — sourced from meeting minutes</p>' +
    '<h2 contenteditable="true">Changes Implemented</h2>' +
    changesTable +
    '<h2 contenteditable="true">Net Impact Analysis</h2>' +
    narrativeBox +
    '<h2 contenteditable="true">Upcoming Scheduled Changes</h2>' +
    upcomingTable +
    '<p style="font-size:11px;color:var(--rpt-page-text);margin-top:10px">Monthly reviews: 2nd Monday of each month. Onsite tech: up to 8 labor hours/quarter per contract.</p>' +
    '</div>';

  return rptPage(n, 'Approved Changes', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Approved Changes',
  });
}
function rptPageContractProjection(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };

  const contract = (d && d.contract) || {};
  const qTargets = contract.quarterlyTargets || [0, 0, 0, 0];
  const annualTarget =
    contract.annualTarget ||
    qTargets.reduce(function (s, v) {
      return s + (v || 0);
    }, 0);
  const cscPct = contract.cscPct || 0;
  const clientPct = contract.clientPct || 0;
  const escalation = contract.escalation || 0;
  const contractYears = contract.years || 5;
  const currentYear = contract.currentYear || 1;
  // Use cumulative savings across all completed quarters for the chart (not just current period)
  const actualSavings = (d && d.totals && d.totals.savings) || 0;
  const actCumSavings =
    d && d.totals && d.totals.cumulativeSavings != null ? d.totals.cumulativeSavings : actualSavings;
  const q = (d && d.period && d.period.quarter) || 1;

  // -- Quarterly Targets table --
  const qTarget = qTargets[q - 1] || 0;
  const annualSum = qTargets.reduce(function (s, v) {
    return s + (v || 0);
  }, 0);
  const qtRows =
    '<tr>' +
    '<td><strong>Projected Savings</strong></td>' +
    qTargets
      .map(function (v) {
        return '<td class="rpt-n">' + $c(v) + '</td>';
      })
      .join('') +
    '<td class="rpt-n"><strong>' +
    $c(annualSum) +
    '</strong></td>' +
    '</tr>' +
    '<tr>' +
    '<td>Client (' +
    clientPct +
    '%)</td>' +
    qTargets
      .map(function (v) {
        return '<td class="rpt-n">' + $c((v * clientPct) / 100) + '</td>';
      })
      .join('') +
    '<td class="rpt-n">' +
    $c((annualSum * clientPct) / 100) +
    '</td>' +
    '</tr>' +
    '<tr>' +
    '<td>CSC (' +
    cscPct +
    '%)</td>' +
    qTargets
      .map(function (v) {
        return '<td class="rpt-n">' + $c((v * cscPct) / 100) + '</td>';
      })
      .join('') +
    '<td class="rpt-n">' +
    $c((annualSum * cscPct) / 100) +
    '</td>' +
    '</tr>';
  const qtTable =
    '<table class="rpt-table">' +
    '<thead><tr>' +
    '<th></th><th class="rpt-n">Q1</th><th class="rpt-n">Q2</th><th class="rpt-n">Q3</th><th class="rpt-n">Q4</th><th class="rpt-n">Annual</th>' +
    '</tr></thead>' +
    '<tbody>' +
    qtRows +
    '</tbody>' +
    '</table>';

  // -- Target vs Actual comparison box --
  const ahead = actualSavings >= qTarget;
  const pctOfTarget = qTarget > 0 ? Math.round((actualSavings / qTarget) * 100) : 0;
  const vsBox =
    '<div class="rpt-vs-box">' +
    '<div class="rpt-vs-side">' +
    '<div class="rpt-vs-val" style="color:' +
    (ahead ? 'var(--rpt-green-dark)' : 'var(--rpt-red)') +
    '">' +
    $c(actualSavings) +
    '</div>' +
    '<div class="rpt-vs-lbl">Actual Q' +
    q +
    ' Savings</div>' +
    '</div>' +
    '<div class="rpt-vs-mid" style="font-size:34px">' +
    (ahead ? '&#9650;' : '&#9660;') +
    '</div>' +
    '<div class="rpt-vs-side">' +
    '<div class="rpt-vs-val" style="color:var(--rpt-page-text)">' +
    $c(qTarget) +
    '</div>' +
    '<div class="rpt-vs-lbl">Q' +
    q +
    ' Target (' +
    pctOfTarget +
    '%)</div>' +
    '</div>' +
    '</div>';

  // -- Multi-Year Projection table --
  let fiveYrRows = '';
  let totalProj = 0,
    totalCsc = 0,
    totalClient = 0,
    totalActual = 0;
  var isQuarterly = d.period && d.period.type === 'quarterly';
  for (var yr = 1; yr <= contractYears; yr++) {
    const yearProj = annualTarget * Math.pow(1 + escalation / 100, yr - 1);
    const yearCsc = (yearProj * cscPct) / 100;
    const yearClient = (yearProj * clientPct) / 100;
    const isCurrentYr = yr === currentYear;
    var displayProj = yearProj;
    var displayCsc = yearCsc;
    var displayClient = yearClient;
    var periodNote = '';
    if (isCurrentYr && isQuarterly) {
      // Blend actual savings for completed quarters with projected for remaining
      // q = reported (last completed) quarter (1-based)
      // Quarters 1..q are completed → use actualSavings for their total
      // Quarters 1..q are completed ? use actualSavings for their total
      // Quarters (q+1)..4 are future ? sum their projected targets
      var remainingProj = 0;
      for (var qi = q; qi < 4; qi++) {
        remainingProj += qTargets[qi] || 0;
      }
      displayProj = actualSavings + remainingProj;
      displayCsc = (displayProj * cscPct) / 100;
      displayClient = (displayProj * clientPct) / 100;
      periodNote = ' (thru Q' + q + ')';
    }
    // Pace: compare actual-to-date against projected-to-date (sum of targets for completed quarters)
    var projToDate =
      isCurrentYr && isQuarterly
        ? qTargets.slice(0, q).reduce(function (s, v) {
            return s + (v || 0);
          }, 0)
        : displayProj;
    const pace = isCurrentYr && projToDate > 0 ? Math.round((actualSavings / projToDate) * 100) : null;
    totalProj += yearProj;
    totalCsc += yearCsc;
    totalClient += yearClient;
    if (isCurrentYr) totalActual += actualSavings;
    fiveYrRows +=
      '<tr' +
      (isCurrentYr ? ' style="font-weight:600"' : '') +
      '>' +
      '<td>' +
      yr +
      '</td>' +
      '<td>Year ' +
      yr +
      (isCurrentYr ? periodNote + ' (current)' : '') +
      '</td>' +
      '<td class="rpt-n">' +
      (isCurrentYr && isQuarterly
        ? $c(displayProj) + '<div style="font-size:8px;color:var(--rpt-page-text)">Annual: ' + $c(yearProj) + '</div>'
        : $c(yearProj)) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(isCurrentYr && isQuarterly ? displayCsc : yearCsc) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(isCurrentYr && isQuarterly ? displayClient : yearClient) +
      '</td>' +
      '</tr>';
  }
  fiveYrRows +=
    '<tr class="rpt-tot">' +
    '<td colspan="2">Total</td>' +
    '<td class="rpt-n">' +
    $c(totalProj) +
    '</td>' +
    '<td class="rpt-n">' +
    $c(totalCsc) +
    '</td>' +
    '<td class="rpt-n">' +
    $c(totalClient) +
    '</td>' +
    '</tr>';
  const fiveYrTable =
    '<table class="rpt-table">' +
    '<thead><tr>' +
    '<th>Year</th><th>Period</th><th class="rpt-n">Projected</th>' +
    '<th class="rpt-n">CSC (' +
    cscPct +
    '%)</th>' +
    '<th class="rpt-n">Client (' +
    clientPct +
    '%)</th>' +
    '</tr></thead>' +
    '<tbody>' +
    fiveYrRows +
    '</tbody>' +
    '</table>';

  // -- Cumulative vs Projected SVG chart (bars + green fill line) --
  // svgW updated from 716 to 720 to match new .rpt-body padding: 48px each side (816 - 96 = 720)
  const svgW = 720,
    svgH = 120;
  const totalQtrs = contractYears * 4;
  var padL = 35,
    padR = 20,
    padT = 10,
    padB = 20;
  var cW = svgW - padL - padR,
    cH = svgH - padT - padB;

  // Per-quarter projected values using actual quarterly targets
  var _qtrVals = [];
  for (var qi = 1; qi <= totalQtrs; qi++) {
    var yrIdx = Math.ceil(qi / 4);
    var escFactor = Math.pow(1 + escalation / 100, yrIdx - 1);
    var _qIdx = (qi - 1) % 4;
    _qtrVals.push((qTargets[_qIdx] || 0) * escFactor);
  }
  var _maxBarVal = Math.max.apply(null, _qtrVals) * 1.3 || 1;
  var curQtr = (currentYear - 1) * 4 + q;
  var actCumVal = Math.abs(actCumSavings);
  function _barY(v) {
    return padT + cH - (Math.min(v, _maxBarVal) / _maxBarVal) * cH;
  }

  // Projected bars
  var _slotW = cW / totalQtrs;
  var _barGap = Math.max(2, Math.floor(_slotW * 0.15)); // gap = 15% of slot
  var _barW = Math.max(3, Math.min(28, _slotW - _barGap)); // cap bars at 28px wide
  var _barsHTML = _qtrVals
    .map(function (val, i) {
      var x = padL + (i / totalQtrs) * cW + _barGap / 2;
      var h = (val / _maxBarVal) * cH;
      var y = padT + cH - h;
      var isFuture = i + 1 > curQtr;
      return (
        '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        _barW.toFixed(1) +
        '" height="' +
        h.toFixed(1) +
        '" fill="' +
        (isFuture ? 'var(--rpt-blue-tint)' : 'var(--rpt-blue-btn)') +
        '" opacity="0.6" rx="1"/>'
      );
    })
    .join('');

  // Actual cumulative line + green fill
  var _actFill = '',
    _actPath = '',
    _actDot = '',
    _actLabel = '';
  if (curQtr >= 1) {
    var x0 = padL,
      y0 = padT + cH;
    var x1 = padL + (curQtr / totalQtrs) * cW;
    var y1 = _barY(actCumVal);
    _actFill =
      '<path d="M' +
      x0 +
      ',' +
      y0 +
      ' L' +
      x1.toFixed(1) +
      ',' +
      y1.toFixed(1) +
      ' L' +
      x1.toFixed(1) +
      ',' +
      (padT + cH) +
      ' Z" fill="rgba(39,174,96,0.2)"/>';
    _actPath =
      '<line x1="' +
      x0 +
      '" y1="' +
      y0 +
      '" x2="' +
      x1.toFixed(1) +
      '" y2="' +
      y1.toFixed(1) +
      '" stroke="var(--rpt-chart-green)" stroke-width="2.5"/>';
    _actDot =
      '<circle cx="' +
      x1.toFixed(1) +
      '" cy="' +
      y1.toFixed(1) +
      '" r="4" fill="var(--rpt-chart-green)" stroke="var(--rpt-page-bg)" stroke-width="1.5"/>';
    _actLabel =
      '<text x="' +
      (x1 + 5).toFixed(1) +
      '" y="' +
      (y1 - 4).toFixed(1) +
      '" font-size="7" fill="var(--rpt-chart-green-dk)" font-weight="bold">' +
      $c(actCumSavings) +
      '</text>';
  }

  // Y-axis labels
  var _yLabels = [0, 0.25, 0.5, 0.75, 1.0]
    .map(function (f) {
      var val = f * _maxBarVal;
      var y = _barY(val);
      return (
        '<text x="' +
        4 +
        '" y="' +
        y.toFixed(0) +
        '" text-anchor="start" font-size="7" fill="var(--rpt-page-text)">$' +
        Math.round(val / 1000) +
        'K</text>'
      );
    })
    .join('');

  // X-axis labels — Q1-Q4
  var xLabelsHTML = '';
  for (var qi3 = 1; qi3 <= totalQtrs; qi3++) {
    var _qn = ((qi3 - 1) % 4) + 1;
    var _yn = Math.ceil(qi3 / 4);
    var _lbl = _qn === 1 ? 'Y' + _yn + 'Q1' : 'Q' + _qn;
    var _xp = padL + ((qi3 - 0.5) / totalQtrs) * cW;
    xLabelsHTML +=
      '<text x="' +
      _xp.toFixed(1) +
      '" y="' +
      (svgH - 4) +
      '" text-anchor="middle" font-size="' +
      (totalQtrs > 12 ? '7' : '8') +
      '" fill="var(--rpt-page-text)">' +
      _lbl +
      '</text>';
  }

  var svgChart =
    '<div style="margin:8px 0">' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:3px">Projected Quarterly Savings (bars) vs Actual Cumulative (green line)</div>' +
    '<svg width="' +
    svgW +
    '" viewBox="0 0 ' +
    svgW +
    ' ' +
    svgH +
    '" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="' +
    padL +
    '" y1="' +
    padT +
    '" x2="' +
    padL +
    '" y2="' +
    (padT + cH) +
    '" stroke="var(--rpt-divider)" stroke-width="1"/>' +
    '<line x1="' +
    padL +
    '" y1="' +
    (padT + cH) +
    '" x2="' +
    (padL + cW) +
    '" y2="' +
    (padT + cH) +
    '" stroke="var(--rpt-divider)" stroke-width="1"/>' +
    _barsHTML +
    _actFill +
    _actPath +
    _actDot +
    _actLabel +
    _yLabels +
    xLabelsHTML +
    '<rect x="' +
    (padL + cW - 120) +
    '" y="4" width="8" height="6" fill="var(--rpt-blue-btn)" opacity="0.6" rx="1"/>' +
    '<text x="' +
    (padL + cW - 108) +
    '" y="10" font-size="8" fill="var(--rpt-page-text)">Projected/Qtr</text>' +
    '<line x1="' +
    (padL + cW - 50) +
    '" y1="7" x2="' +
    (padL + cW - 38) +
    '" y2="7" stroke="var(--rpt-chart-green)" stroke-width="2.5"/>' +
    '<text x="' +
    (padL + cW - 34) +
    '" y="10" font-size="8" fill="var(--rpt-page-text)">Actual</text>' +
    '</svg></div>';

  const bodyHTML =
    '<h2 contenteditable="true">Quarterly Targets</h2>' +
    qtTable +
    '<h2 contenteditable="true">' +
    (d.period.type === 'annual' ? 'Annual vs Target' : 'Q' + q + ' vs Target') +
    '</h2>' +
    vsBox +
    '<h2 contenteditable="true">' +
    contractYears +
    '-Year Projection</h2>' +
    fiveYrTable +
    '<h2 contenteditable="true">Cumulative vs Projected</h2>' +
    svgChart +
    '<p style="font-size:11px;color:var(--rpt-page-text);margin-top:8px">' +
    escalation +
    '% annual utility rate escalation applied per contract terms.</p>';

  return rptPage(n, 'Contract Projection', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Contract Projection',
  });
}
function rptPageSetPoints(n, d) {
  const $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };

  const setpoints = (d && d.setpoints) || [];
  const buildings = (d && d.buildings) || [];

  // Version metadata for header
  const vTypeRaw = setpoints.length > 0 ? setpoints[0].versionType || '' : '';
  const vDateRaw = setpoints.length > 0 ? setpoints[0].versionDate || '' : '';
  let vLabel = '';
  if (vTypeRaw) {
    vLabel = ' — ' + vTypeRaw.charAt(0).toUpperCase() + vTypeRaw.slice(1);
  }
  if (vDateRaw) {
    vLabel += ' (' + _basFormatDate(vDateRaw) + ')';
  }

  // Helper to look up building name
  function getBldgName(id) {
    var found = buildings.filter(function (b) {
      return b.id === id || b.buildingId === id;
    })[0];
    return (found && found.name) || id || 'Building';
  }

  // Helper: flag extended schedule (evening past 6pm or weekends)
  function scheduleLabel(sched) {
    if (!sched) return '—';
    var s = sched.toLowerCase();
    var extended =
      /\b(sat|sun|weekend)/i.test(s) || /\b(1[7-9]|2[0-3])[:h]/i.test(s) || /\b(7|8|9|10|11)\s*pm/i.test(s);
    if (extended) {
      return sched + ' <span style="color:var(--rpt-orange)">(extended)</span>';
    }
    return sched;
  }

  let bodyContent = '';

  if (!setpoints || setpoints.length === 0) {
    bodyContent =
      '<p style="padding:16px;color:var(--rpt-page-text);font-style:italic">No BAS data uploaded — add data in Set Points &amp; Schedules tab.</p>';
  } else {
    // Scan all zones to determine which optional columns have at least one real value
    var hasUnoccHeat = false;
    var hasUnoccCool = false;
    var hasSchedule = false;
    setpoints.forEach(function (sp) {
      const zones = sp.zones || [];
      const useAvg = sp.viewMode === 'average';
      if (useAvg && zones.length) {
        var bldgObj = buildings.filter(function (b) {
          return b.id === sp.buildingId || b.buildingId === sp.buildingId;
        })[0];
        var avg = _spComputeAvgRow(zones, bldgObj);
        if (avg) {
          if (avg.unoccHeat != null) hasUnoccHeat = true;
          if (avg.unoccCool != null) hasUnoccCool = true;
          if (avg.schedule) hasSchedule = true;
        }
      } else {
        zones.forEach(function (z) {
          if (z.unoccHeat != null) hasUnoccHeat = true;
          if (z.unoccCool != null) hasUnoccCool = true;
          if (z.schedule) hasSchedule = true;
        });
      }
    });

    // Check if ALL setpoints use average mode — if so, hide Zone/System column
    var allAvgMode = setpoints.every(function (sp) {
      return sp.viewMode === 'average';
    });

    let allRows = '';
    setpoints.forEach(function (sp) {
      const bldgName = getBldgName(sp.buildingId);
      const zones = sp.zones || [];
      const useAvg = sp.viewMode === 'average';
      if (useAvg && zones.length) {
        var bldgObj = buildings.filter(function (b) {
          return b.id === sp.buildingId || b.buildingId === sp.buildingId;
        })[0];
        var avg = _spComputeAvgRow(zones, bldgObj);
        if (avg) {
          allRows +=
            '<tr>' +
            '<td contenteditable="true">' +
            bldgName +
            '</td>' +
            (allAvgMode ? '' : '<td contenteditable="true">' + (avg.name || 'Average') + '</td>') +
            '<td class="rpt-n" contenteditable="true">' +
            (avg.occHeat != null ? avg.occHeat + '°F' : '—') +
            '</td>' +
            '<td class="rpt-n" contenteditable="true">' +
            (avg.occCool != null ? avg.occCool + '°F' : '—') +
            '</td>' +
            (hasUnoccHeat
              ? '<td class="rpt-n" contenteditable="true">' +
                (avg.unoccHeat != null ? avg.unoccHeat + '°F' : '—') +
                '</td>'
              : '') +
            (hasUnoccCool
              ? '<td class="rpt-n" contenteditable="true">' +
                (avg.unoccCool != null ? avg.unoccCool + '°F' : '—') +
                '</td>'
              : '') +
            (hasSchedule ? '<td contenteditable="true">' + scheduleLabel(avg.schedule) + '</td>' : '') +
            '</tr>';
        }
      } else {
        zones.forEach(function (z) {
          allRows +=
            '<tr>' +
            '<td contenteditable="true">' +
            bldgName +
            '</td>' +
            (allAvgMode ? '' : '<td contenteditable="true">' + (z.name || '—') + '</td>') +
            '<td class="rpt-n" contenteditable="true">' +
            (z.occHeat != null ? z.occHeat + '°F' : '—') +
            '</td>' +
            '<td class="rpt-n" contenteditable="true">' +
            (z.occCool != null ? z.occCool + '°F' : '—') +
            '</td>' +
            (hasUnoccHeat
              ? '<td class="rpt-n" contenteditable="true">' + (z.unoccHeat != null ? z.unoccHeat + '°F' : '—') + '</td>'
              : '') +
            (hasUnoccCool
              ? '<td class="rpt-n" contenteditable="true">' + (z.unoccCool != null ? z.unoccCool + '°F' : '—') + '</td>'
              : '') +
            (hasSchedule ? '<td contenteditable="true">' + scheduleLabel(z.schedule) + '</td>' : '') +
            '</tr>';
        });
      }
    });
    var colCount = (allAvgMode ? 3 : 4) + (hasUnoccHeat ? 1 : 0) + (hasUnoccCool ? 1 : 0) + (hasSchedule ? 1 : 0);
    if (!allRows) {
      allRows =
        '<tr><td colspan="' +
        colCount +
        '" style="color:var(--rpt-page-text);font-style:italic">No zones recorded</td></tr>';
    }
    bodyContent =
      '<table class="rpt-table" contenteditable="true">' +
      '<thead><tr>' +
      '<th>Building</th>' +
      (allAvgMode ? '' : '<th>Zone / System</th>') +
      '<th class="rpt-n">Occ Heat</th>' +
      '<th class="rpt-n">Occ Cool</th>' +
      (hasUnoccHeat ? '<th class="rpt-n">Unocc Heat</th>' : '') +
      (hasUnoccCool ? '<th class="rpt-n">Unocc Cool</th>' : '') +
      (hasSchedule ? '<th>Schedule</th>' : '') +
      '</tr></thead>' +
      '<tbody>' +
      allRows +
      '</tbody>' +
      '</table>';
  }

  const rptViewMode =
    setpoints.length && setpoints[0].viewMode === 'average' ? 'building averages' : 'individual zones';
  const bodyHTML =
    '<p style="font-size:12px;color:var(--rpt-page-text);margin:0 0 8px">Baseline setpoints and operating schedules per building — from uploaded BAS exports (' +
    rptViewMode +
    ')</p>' +
    bodyContent +
    '<p style="font-size:11px;color:var(--rpt-page-text);margin-top:12px">Source: BAS export uploaded to Set Points &amp; Schedules tab.</p>';

  return rptPage(n, 'BAS Set Points & Schedules' + vLabel, bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Set Points',
  });
}
function rptPageBuildingSummary(n, d, b) {
  const $c = function (v) {
    var val = Math.round(v || 0);
    return (val < 0 ? '-' : '') + '$' + Math.abs(val).toLocaleString();
  };
  const $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  const $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };

  // -- Helpers ----------------------------------------------------------
  const hasElec = b.commodities && b.commodities.includes('Electric') && b.electric && b.electric.kwhBl > 0;
  const hasGas = b.commodities && b.commodities.includes('Gas') && b.gas && b.gas.thermsBl > 0;
  const hasPropane = b.commodities && b.commodities.includes('Propane') && b.propane && b.propane.galBl > 0;

  // -- Target % from per-building savings projection config ----------
  const targetPct = b.targetPct || 10;
  const savingsPct = b.savingsPct || 0;

  // -- Month label helpers -------------------------
  const MO_ABBR = [
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
  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function moLabel(ym) {
    if (!ym) return '';
    var parts = ym.split('-');
    return MO_SHORT[parseInt(parts[1], 10) - 1] || ym;
  }
  function moFullLabel(ym) {
    if (!ym) return '—';
    var parts = ym.split('-');
    return MO_ABBR[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }
  var periodEndLabel = moFullLabel(d && d.period && d.period.end);

  // -- Full-year monthly builder: 12 calendar months with baseline + current --
  var _bm = b.baselineMaps || { elecByMo: {}, gasByMo: {}, propaneByMo: {}, waterByMo: {} };
  var _chartYear = d && d.period && d.period.end ? d.period.end.split('-')[0] : '2026';
  function buildFullYear(monthlyArr, blMap, blField) {
    var curByCalMo = {};
    (monthlyArr || []).forEach(function (mo) {
      var cm = parseInt(mo.month.split('-')[1]) - 1;
      curByCalMo[cm] = mo;
    });
    var result = [];
    for (var i = 0; i < 12; i++) {
      var ym = _chartYear + '-' + String(i + 1).padStart(2, '0');
      var blVal = 0;
      if (blMap && blMap[i]) blVal = blMap[i][blField] || 0;
      var curVal = 0;
      if (curByCalMo[i]) {
        curVal = curByCalMo[i].cur || 0;
        if (curByCalMo[i].bl) blVal = curByCalMo[i].bl;
      }
      result.push({ month: ym, bl: blVal, cur: curVal });
    }
    return result;
  }

  // -- Bar chart builder ---------------------------------------------
  // blColor / curColor: CSS color strings
  // unit: string appended to tooltip / footer labels
  function buildBarChart(monthly, blColor, curColor, unit, title) {
    if (!monthly || !monthly.length) return '';
    var titleHtml = title
      ? '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);margin-bottom:4px">' + title + '</div>'
      : '';
    var allVals = [];
    monthly.forEach(function (mo) {
      allVals.push(mo.bl || 0, mo.cur || 0);
    });
    var maxVal = Math.max.apply(null, allVals) || 1;
    var maxH = 80; // px — maximum bar height

    var blTot = 0,
      curTot = 0;
    var bars = '';
    monthly.forEach(function (mo) {
      var blH = Math.max(2, Math.round((mo.bl / maxVal) * maxH));
      var curH = Math.max(2, Math.round((mo.cur / maxVal) * maxH));
      blTot += mo.bl || 0;
      curTot += mo.cur || 0;
      bars +=
        '<div style="display:flex;flex-direction:column;align-items:center;gap:1px;min-width:18px">' +
        '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
        maxH +
        'px">' +
        '<div style="width:10px;height:' +
        blH +
        'px;background:' +
        blColor +
        ';border-radius:1px 1px 0 0" title="Baseline ' +
        $n(mo.bl) +
        ' ' +
        unit +
        '"></div>' +
        '<div style="width:10px;height:' +
        curH +
        'px;background:' +
        curColor +
        ';border-radius:1px 1px 0 0" title="Current ' +
        $n(mo.cur) +
        ' ' +
        unit +
        '"></div>' +
        '</div>' +
        '<div style="font-size:9px;color:var(--rpt-page-text);margin-top:1px">' +
        moLabel(mo.month) +
        '</div>' +
        '</div>';
    });

    var legend =
      '<div style="display:flex;gap:10px;margin-top:4px;font-size:10px;color:var(--rpt-page-text)">' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      blColor +
      ';border-radius:1px;margin-right:3px"></span>Baseline ' +
      $n(blTot) +
      ' ' +
      unit +
      '</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      curColor +
      ';border-radius:1px;margin-right:3px"></span>Current ' +
      $n(curTot) +
      ' ' +
      unit +
      '</span>' +
      '</div>';

    var yAxisLabel =
      '<div style="writing-mode:vertical-rl;transform:rotate(180deg);font-size:9px;color:var(--rpt-page-text);text-align:center;white-space:nowrap;padding-right:2px">' +
      unit +
      '</div>';
    var axisCaption =
      '<div style="font-size:9px;color:var(--rpt-page-text);text-align:center;margin-top:1px">← Month →</div>';
    return (
      titleHtml +
      '<div style="display:flex;align-items:center">' +
      yAxisLabel +
      '<div style="flex:1">' +
      '<div style="display:flex;flex-wrap:nowrap;gap:2px;align-items:flex-end;padding:4px 0;overflow:visible">' +
      bars +
      '</div>' +
      legend +
      axisCaption +
      '</div>' +
      '</div>'
    );
  }

  // -------------------------------------------------------------------
  // LEFT COLUMN
  // -------------------------------------------------------------------

  // Building name
  var leftHTML =
    '<div contenteditable="true" style="font-size:18px;font-weight:700;color:var(--rpt-blue);line-height:1.2;margin-bottom:4px">' +
    (b.name || 'Building') +
    '</div>';

  // Address + sqft
  var addr = b.address || (d && d.project && d.project.addr) || '';
  var sqftStr = b.sqft ? b.sqft.toLocaleString() + ' sq ft' : '';
  leftHTML +=
    '<div contenteditable="true" style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px;line-height:1.5">' +
    (sqftStr ? sqftStr + '<br>' : '') +
    (addr ? addr : '') +
    '</div>';

  // EUI comparison bars
  var euiBl = (b.eui && b.eui.baseline) || 0;
  var euiCur = (b.eui && b.eui.current) || 0;
  var euiMax = Math.max(euiBl, euiCur, 1);
  var euiBarMaxH = 60; // px
  var euiBlH = Math.max(4, Math.round((euiBl / euiMax) * euiBarMaxH));
  var euiCurH = Math.max(4, Math.round((euiCur / euiMax) * euiBarMaxH));

  leftHTML +=
    '<div style="font-size:12px;font-weight:600;color:var(--rpt-page-text);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.03em">Site EUI (kBtu/sq ft/yr)</div>' +
    '<div style="display:flex;gap:16px;align-items:flex-end;margin-bottom:12px">' +
    // Baseline bar
    '<div style="display:flex;flex-direction:column;align-items:center;gap:3px">' +
    '<div style="width:32px;height:' +
    euiBarMaxH +
    'px;display:flex;align-items:flex-end">' +
    '<div style="width:32px;height:' +
    euiBlH +
    'px;background:var(--rpt-orange);border-radius:2px 2px 0 0"></div>' +
    '</div>' +
    '<div style="font-size:13px;font-weight:700;color:var(--rpt-orange)">' +
    euiBl.toFixed(1) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Baseline</div>' +
    '</div>' +
    // Current bar
    '<div style="display:flex;flex-direction:column;align-items:center;gap:3px">' +
    '<div style="width:32px;height:' +
    euiBarMaxH +
    'px;display:flex;align-items:flex-end">' +
    '<div style="width:32px;height:' +
    euiCurH +
    'px;background:var(--rpt-green-dark);border-radius:2px 2px 0 0"></div>' +
    '</div>' +
    '<div style="font-size:13px;font-weight:700;color:var(--rpt-green-dark)">' +
    euiCur.toFixed(1) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Current</div>' +
    '</div>' +
    '</div>';

  // Monthly EUI mini-chart (kBtu/sqft per month) — full 12 months
  if (b.sqft > 0) {
    var euiMonthly = [];
    var _elFull = buildFullYear(b.electric && b.electric.monthly, _bm.elecByMo, 'kwh');
    var _gaFull = buildFullYear(b.gas && b.gas.monthly, _bm.gasByMo, 'therms');
    var _prFull = buildFullYear(b.propane && b.propane.monthly, _bm.propaneByMo, 'gallons');
    for (var _ei = 0; _ei < 12; _ei++) {
      var _blKBtu = toKBtu(_elFull[_ei].bl || 0, _gaFull[_ei].bl || 0, _prFull[_ei].bl || 0);
      var _curKBtu = toKBtu(_elFull[_ei].cur || 0, _gaFull[_ei].cur || 0, _prFull[_ei].cur || 0);
      euiMonthly.push({ month: _elFull[_ei].month, bl: _blKBtu / b.sqft, cur: _curKBtu / b.sqft });
    }
    euiMonthly = euiMonthly.filter(function (mo) {
      return mo.cur > 0;
    });
    if (euiMonthly.length > 1) {
      var euiMax =
        Math.max.apply(
          null,
          euiMonthly.map(function (m) {
            return Math.max(m.bl, m.cur);
          }),
        ) || 1;
      var euiChartH = 80;
      var euiMidLabel = (euiMax / 2).toFixed(1);
      var euiBars = euiMonthly
        .map(function (mo) {
          var blH = Math.max(1, Math.round((mo.bl / euiMax) * euiChartH));
          var curH = Math.max(1, Math.round((mo.cur / euiMax) * euiChartH));
          var moLbl = moLabel(mo.month);
          // Value labels: rendered above bars (both baseline and current)
          var blLabel = mo.bl > 0 ? '<span style="color:var(--rpt-orange)">' + mo.bl.toFixed(1) + '</span>' : '';
          var curLabel = mo.cur > 0 ? '<span style="color:var(--rpt-green-dark)">' + mo.cur.toFixed(1) + '</span>' : '';
          var valLine =
            blLabel || curLabel
              ? '<div style="font-size:8px;color:var(--rpt-page-text);line-height:1.2;text-align:center;white-space:nowrap">' +
                (blLabel ? blLabel : '') +
                (blLabel && curLabel ? '<br>' : '') +
                (curLabel ? curLabel : '') +
                '</div>'
              : '';
          return (
            '<div style="display:flex;flex-direction:column;align-items:center;flex:1">' +
            valLine +
            '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
            euiChartH +
            'px">' +
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:' +
            euiChartH +
            'px">' +
            '<div style="width:100%;max-width:15px;height:' +
            blH +
            'px;background:var(--rpt-orange);border-radius:1px 1px 0 0"></div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:' +
            euiChartH +
            'px">' +
            '<div style="width:100%;max-width:15px;height:' +
            curH +
            'px;background:var(--rpt-green-dark);border-radius:1px 1px 0 0"></div>' +
            '</div>' +
            '</div>' +
            '<div style="font-size:9px;color:var(--rpt-page-text);text-align:center">' +
            moLbl +
            '</div>' +
            '</div>'
          );
        })
        .join('');
      var euiYMax = euiMax.toFixed(1);
      leftHTML +=
        '<div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin:8px 0 3px">Monthly Site EUI (kBtu/ft²)</div>' +
        '<div style="position:relative;padding-left:36px">' +
        '<div style="position:absolute;left:0;top:0;height:' +
        euiChartH +
        'px;display:flex;flex-direction:column;justify-content:space-between;font-size:9px;color:var(--rpt-page-text);text-align:right;width:30px">' +
        '<span>' +
        euiYMax +
        '</span>' +
        '<span>' +
        euiMidLabel +
        '</span>' +
        '<span>0</span>' +
        '</div>' +
        '<div style="position:relative;height:' +
        euiChartH +
        'px">' +
        '<div style="position:absolute;left:0;right:0;bottom:50%;border-top:1px dashed var(--rpt-divider);pointer-events:none"></div>' +
        '<div style="display:flex;align-items:flex-end;gap:1px;overflow:hidden;height:' +
        euiChartH +
        'px">' +
        euiBars +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div style="font-size:9px;color:var(--rpt-page-text);margin-top:2px"><span style="display:inline-block;width:6px;height:6px;background:var(--rpt-orange);border-radius:1px;margin-right:2px"></span>Baseline <span style="display:inline-block;width:6px;height:6px;background:var(--rpt-green-dark);border-radius:1px;margin-left:4px;margin-right:2px"></span>Current</div>';
    }
  }

  // Notes — only show if building has notes stored
  var bldgNotes = b.notes || '';
  if (bldgNotes) {
    leftHTML +=
      '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:3px">Utility &amp; Building Notes</div>' +
      '<div contenteditable="true" style="min-height:40px;font-size:11px;color:var(--rpt-page-text);padding:6px;line-height:1.5">' +
      bldgNotes +
      '</div>';
  }

  // -------------------------------------------------------------------
  // RIGHT COLUMN
  // -------------------------------------------------------------------

  // Goals and Progression header
  var rightHTML =
    '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">' +
    '<div style="font-size:14px;font-weight:700;color:var(--rpt-blue)">Goals and Progression</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text)">Period: ' +
    ((d && d.period && d.period.label) || '') +
    '</div>' +
    '</div>';

  // Icon savings row — green for positive savings, red for negative
  var iconItems = '';
  function _savColor(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }
  if (hasElec) {
    var kwhSaved = b.electric.kwhSaved || 0;
    var kwReduced = (b.electric.kwBl || 0) - (b.electric.kwCur || 0);
    iconItems +=
      '<div style="flex:1;min-width:60px;text-align:center;background:transparent;border-radius:2px;padding:5px 4px">' +
      '<div style="font-size:16px;margin-bottom:1px">⚡</div>' +
      '<div style="font-size:14px;font-weight:700;color:' +
      _savColor(kwhSaved) +
      '">' +
      $n(kwhSaved) +
      '</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text)">kWh Saved</div>' +
      '</div>' +
      '<div style="flex:1;min-width:60px;text-align:center;background:transparent;border-radius:2px;padding:5px 4px">' +
      '<div style="font-size:16px;margin-bottom:1px">📉</div>' +
      '<div style="font-size:14px;font-weight:700;color:' +
      _savColor(kwReduced) +
      '">' +
      $n(kwReduced) +
      '</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text)">kW Reduced</div>' +
      '</div>';
  }
  if (hasGas) {
    var thermsSaved = b.gas.thermsSaved || 0;
    iconItems +=
      '<div style="flex:1;min-width:60px;text-align:center;background:transparent;border-radius:2px;padding:5px 4px">' +
      '<div style="font-size:16px;margin-bottom:1px">🔥</div>' +
      '<div style="font-size:14px;font-weight:700;color:' +
      _savColor(thermsSaved) +
      '">' +
      $n(thermsSaved) +
      '</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text)">Therms Saved</div>' +
      '</div>';
  }
  if (hasPropane) {
    var galSaved = b.propane.galSaved || 0;
    iconItems +=
      '<div style="flex:1;min-width:60px;text-align:center;background:transparent;border-radius:2px;padding:5px 4px">' +
      '<div style="font-size:16px;margin-bottom:1px">🛢</div>' +
      '<div style="font-size:14px;font-weight:700;color:' +
      _savColor(galSaved) +
      '">' +
      $n(galSaved) +
      '</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text)">Gal Saved</div>' +
      '</div>';
  }
  // Always show $ savings
  var totalSaved = b.savings || 0;
  iconItems +=
    '<div style="flex:1;min-width:60px;text-align:center;background:transparent;border-radius:2px;padding:5px 4px">' +
    '<div style="font-size:16px;margin-bottom:1px">💰</div>' +
    '<div style="font-size:14px;font-weight:700;color:' +
    _savColor(totalSaved) +
    '">' +
    (totalSaved >= 0 ? '' : '-') +
    '$' +
    Math.abs(Math.round(totalSaved)).toLocaleString() +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Total Saved</div>' +
    '</div>';

  rightHTML += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">' + iconItems + '</div>';

  // Summary table
  function _pctColor(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }
  var tableRows = '';
  if (hasElec) {
    var elSavPct = b.electric.kwhBl > 0 ? (b.electric.kwhSaved / b.electric.kwhBl) * 100 : 0;
    var elCostSaved = b.electric.costSaved || 0;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">Electric Energy</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      periodEndLabel +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $p(targetPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(elSavPct) +
      ';font-weight:600">' +
      $p(elSavPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(elCostSaved) +
      ';font-weight:600">' +
      $c(elCostSaved) +
      '</td>' +
      '</tr>';
    var elDemSavPct = b.electric.kwBl > 0 ? ((b.electric.kwBl - b.electric.kwCur) / b.electric.kwBl) * 100 : 0;
    // Derive demand cost saved from monthly data: sum (kwBl - kwCur) * avg kW rate per month
    var _elDemCostSaved = 0;
    (b.electric.monthly || []).forEach(function (mo) {
      var kwSav = (mo.kwBl || 0) - (mo.kwCur || 0);
      var blCostMo = mo.blCost || 0;
      var curCostMo = mo.curCost || 0;
      var blUsage = mo.bl || 0;
      var curUsage = mo.cur || 0;
      // kW rate = (blCost - kWhCost portion) / kwBl — approximate using cost ratio
      // Simpler: proportional split of cost delta attributable to kW
      var totalKwSav = kwSav;
      var kwRate = blCostMo > 0 && (mo.kwBl || 0) > 0 ? blCostMo / (mo.kwBl || 1) : 0;
      _elDemCostSaved += totalKwSav > 0 ? totalKwSav * kwRate : 0;
    });
    var elDemCostSaved = _elDemCostSaved;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">Electric Demand</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      periodEndLabel +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $p(targetPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(elDemSavPct) +
      ';font-weight:600">' +
      $p(elDemSavPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(elDemCostSaved) +
      ';font-weight:600">' +
      $c(elDemCostSaved) +
      '</td>' +
      '</tr>';
  }
  if (hasGas) {
    var gasSavPct = b.gas.thermsBl > 0 ? (b.gas.thermsSaved / b.gas.thermsBl) * 100 : 0;
    var gasCostSaved = b.gas.costSaved || 0;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">Gas</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      periodEndLabel +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $p(targetPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(gasSavPct) +
      ';font-weight:600">' +
      $p(gasSavPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(gasCostSaved) +
      ';font-weight:600">' +
      $c(gasCostSaved) +
      '</td>' +
      '</tr>';
  }
  if (hasPropane) {
    var propSavPct = b.propane.galBl > 0 ? (b.propane.galSaved / b.propane.galBl) * 100 : 0;
    var propCostSaved = b.propane.costSaved || 0;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">Propane</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      periodEndLabel +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $p(targetPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(propSavPct) +
      ';font-weight:600">' +
      $p(propSavPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _pctColor(propCostSaved) +
      ';font-weight:600">' +
      $c(propCostSaved) +
      '</td>' +
      '</tr>';
  }
  if (!tableRows) {
    tableRows =
      '<tr><td colspan="5" style="color:var(--rpt-page-text);font-style:italic">No commodity data for this building</td></tr>';
  }

  rightHTML +=
    '<table class="rpt-table" style="margin-bottom:10px">' +
    '<thead><tr>' +
    '<th>Commodity Type</th>' +
    '<th class="rpt-n">Through</th>' +
    '<th class="rpt-n">Goal %</th>' +
    '<th class="rpt-n">Achieved %</th>' +
    '<th class="rpt-n">Achieved $</th>' +
    '</tr></thead>' +
    '<tbody>' +
    tableRows +
    '</tbody>' +
    '</table>';

  // Filter to only months with data (baseline or current > 0)
  function filterToDataMonths(fullYear) {
    return fullYear.filter(function (mo) {
      return (mo.bl || 0) > 0 || (mo.cur || 0) > 0;
    });
  }

  // Period months array — used to align baseline and actual to the same reporting window
  var _periodYMs = (d.period && d.period.yearMonths) || [];

  // Electricity Consumption chart — period months only (both baseline and actual)
  if (hasElec) {
    var elFullYear = buildFullYear(b.electric.monthly, _bm.elecByMo, 'kwh');
    var elDataMonths =
      _periodYMs.length > 0
        ? elFullYear.filter(function (mo) {
            return _periodYMs.includes(mo.month);
          })
        : filterToDataMonths(elFullYear);
    var elChart = buildBarChart(elDataMonths, 'var(--rpt-elec-bl)', 'var(--rpt-elec-cur)', 'kWh');
    rightHTML +=
      '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--rpt-blue);margin:6px 0 2px">' +
      'Electricity Consumption' +
      '</div>' +
      '<div style="display:flex;justify-content:center">' +
      elChart +
      '</div>';
  }

  // Natural Gas Consumption chart — period months only (both baseline and actual)
  if (hasGas) {
    var gasFullYear = buildFullYear(b.gas.monthly, _bm.gasByMo, 'therms');
    var gasDataMonths =
      _periodYMs.length > 0
        ? gasFullYear.filter(function (mo) {
            return _periodYMs.includes(mo.month);
          })
        : filterToDataMonths(gasFullYear);
    var gasChart = buildBarChart(gasDataMonths, 'var(--rpt-gas-bl)', 'var(--rpt-gas-cur)', 'Therms');
    rightHTML +=
      '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--rpt-gas-head);margin:6px 0 2px">' +
      'Natural Gas Consumption' +
      '</div>' +
      '<div style="display:flex;justify-content:center">' +
      gasChart +
      '</div>';
  }

  // Propane Consumption chart — period months only (both baseline and actual)
  if (hasPropane) {
    var propFullYear = buildFullYear(b.propane.monthly, _bm.propaneByMo, 'gallons');
    var propDataMonths =
      _periodYMs.length > 0
        ? propFullYear.filter(function (mo) {
            return _periodYMs.includes(mo.month);
          })
        : filterToDataMonths(propFullYear);
    var propChart = buildBarChart(propDataMonths, 'var(--rpt-prop-bl)', 'var(--rpt-prop-cur)', 'Gal');
    rightHTML +=
      '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--rpt-prop-head);margin:6px 0 2px">' +
      'Propane Consumption' +
      '</div>' +
      '<div style="display:flex;justify-content:center">' +
      propChart +
      '</div>';
  }

  // -------------------------------------------------------------------
  // Building Baseline Data table (Energy Dept styling, merged kW Cost, no Load %)
  // -------------------------------------------------------------------
  var _blCalcDefaults = {
    electric: typeof isCalcCommodity === 'function' ? isCalcCommodity(d.project.id, 'Electric') : true,
    gas: typeof isCalcCommodity === 'function' ? isCalcCommodity(d.project.id, 'Gas') : true,
    propane: typeof isCalcCommodity === 'function' ? isCalcCommodity(d.project.id, 'Propane') : true,
    water: typeof isCalcCommodity === 'function' ? isCalcCommodity(d.project.id, 'Water') : false,
  };
  var _opts = (d.reportOptions && d.reportOptions.blCommodities) || _blCalcDefaults;
  var _showElec = hasElec && _opts.electric;
  var _showGas = hasGas && _opts.gas;
  var _showProp =
    (hasPropane ||
      (_bm &&
        _bm.propaneByMo &&
        Object.values(_bm.propaneByMo).some(function (v) {
          return v && (v.gallons > 0 || v.cost > 0);
        }))) &&
    _opts.propane;
  var _showWater = _opts.water && Object.keys(_bm.waterByMo).length > 0;
  var blDataRows = '';
  var _tKwh = 0,
    _tKw = 0,
    _tBkw = 0,
    _tKwCost = 0,
    _tEnCost = 0,
    _tElecCost = 0;
  var _tTherms = 0,
    _tGasCost = 0,
    _tGal = 0,
    _tPropCost = 0,
    _tWater = 0,
    _tWaterCost = 0,
    _tTotalCost = 0;
  for (var mi = 0; mi < 12; mi++) {
    var eM = _bm.elecByMo[mi] || {};
    var gM = _bm.gasByMo[mi] || {};
    var pM = _bm.propaneByMo[mi] || {};
    var wM = _bm.waterByMo[mi] || {};
    var kwh = eM.kwh || 0,
      demKw = eM.demandKW || 0,
      bKw = eM.billedKW || 0;
    var kwCostTotal = (eM.kwCost || 0) + (eM.facKWCost || 0),
      enCost = eM.energyCost || 0;
    var elecCost = eM.commodityCost || eM.totalCost || 0;
    var therms = gM.therms || 0,
      gasCost = gM.cost || 0;
    var gal = pM.gallons || 0,
      propCost = pM.cost || 0;
    var water = wM.kgal || 0,
      waterCost = wM.cost || 0;
    var totalCost = elecCost + gasCost + propCost + waterCost;
    _tKwh += kwh;
    _tKw += demKw;
    _tBkw += bKw;
    _tKwCost += kwCostTotal;
    _tEnCost += enCost;
    _tElecCost += elecCost;
    _tTherms += therms;
    _tGasCost += gasCost;
    _tGal += gal;
    _tPropCost += propCost;
    _tWater += water;
    _tWaterCost += waterCost;
    _tTotalCost += totalCost;
    var hasData =
      _bm.elecByMo[mi] != null || _bm.gasByMo[mi] != null || _bm.propaneByMo[mi] != null || _bm.waterByMo[mi] != null;
    if (!hasData) continue;
    var costPerKwh = kwh > 0 ? enCost / kwh : 0;
    blDataRows += '<tr><td>' + MO_SHORT[mi] + '</td>';
    if (_showElec) {
      blDataRows +=
        '<td class="rpt-n">' +
        (kwh ? $n(kwh) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (demKw ? demKw.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (bKw ? bKw.toFixed(1) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (kwCostTotal ? $c(kwCostTotal) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (enCost ? $c(enCost) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (elecCost ? $c(elecCost) : '—') +
        '</td>' +
        '<td class="rpt-n">' +
        (costPerKwh ? '$' + costPerKwh.toFixed(4) : '—') +
        '</td>';
    }
    if (_showGas)
      blDataRows +=
        '<td class="rpt-n">' +
        (therms ? $n(therms) : '—') +
        '</td><td class="rpt-n">' +
        (gasCost ? $c(gasCost) : '—') +
        '</td><td class="rpt-n">' +
        (gM.rate > 0 ? '$' + gM.rate.toFixed(4) : therms > 0 ? '$' + (gasCost / therms).toFixed(4) : '—') +
        '</td>';
    if (_showProp)
      blDataRows +=
        '<td class="rpt-n">' +
        (gal ? $n(gal) : '—') +
        '</td><td class="rpt-n">' +
        (propCost ? $c(propCost) : '—') +
        '</td><td class="rpt-n">' +
        (gal > 0 ? '$' + (propCost / gal).toFixed(4) : '—') +
        '</td>';
    if (_showWater)
      blDataRows +=
        '<td class="rpt-n">' +
        (water ? water.toFixed(1) : '—') +
        '</td><td class="rpt-n">' +
        (waterCost ? $c(waterCost) : '—') +
        '</td><td class="rpt-n">' +
        (water > 0 ? '$' + (waterCost / water).toFixed(2) : '—') +
        '</td>';
    blDataRows += '<td class="rpt-n">' + (totalCost ? $c(totalCost) : '—') + '</td></tr>';
  }
  if (blDataRows) {
    blDataRows += '<tr class="rpt-tot"><td>Annual</td>';
    if (_showElec) {
      var _avgCpk = _tKwh > 0 ? _tElecCost / _tKwh : 0;
      blDataRows +=
        '<td class="rpt-n">' +
        $n(_tKwh) +
        '</td><td class="rpt-n">' +
        (_tKw ? (_tKw / 12).toFixed(1) : '—') +
        '</td><td class="rpt-n">' +
        (_tBkw ? (_tBkw / 12).toFixed(1) : '—') +
        '</td><td class="rpt-n">' +
        $c(_tKwCost) +
        '</td><td class="rpt-n">' +
        $c(_tEnCost) +
        '</td><td class="rpt-n">' +
        $c(_tElecCost) +
        '</td><td class="rpt-n">' +
        (_avgCpk ? '$' + _avgCpk.toFixed(4) : '—') +
        '</td>';
    }
    if (_showGas)
      blDataRows +=
        '<td class="rpt-n">' +
        $n(_tTherms) +
        '</td><td class="rpt-n">' +
        $c(_tGasCost) +
        '</td><td class="rpt-n">' +
        (_tTherms > 0 ? '$' + (_tGasCost / _tTherms).toFixed(4) : '—') +
        '</td>';
    if (_showProp)
      blDataRows +=
        '<td class="rpt-n">' +
        $n(_tGal) +
        '</td><td class="rpt-n">' +
        $c(_tPropCost) +
        '</td><td class="rpt-n">' +
        (_tGal > 0 ? '$' + (_tPropCost / _tGal).toFixed(4) : '—') +
        '</td>';
    if (_showWater)
      blDataRows +=
        '<td class="rpt-n">' +
        _tWater.toFixed(1) +
        '</td><td class="rpt-n">' +
        $c(_tWaterCost) +
        '</td><td class="rpt-n">' +
        (_tWater > 0 ? '$' + (_tWaterCost / _tWater).toFixed(2) : '—') +
        '</td>';
    blDataRows += '<td class="rpt-n">' + $c(_tTotalCost) + '</td></tr>';
  }
  // Column group header row (commodity-colored)
  var blGrpHdr = '<th rowspan="2" style="white-space:nowrap">Month</th>';
  if (_showElec) blGrpHdr += '<th colspan="7" class="bl-grp bl-elec">Electric</th>';
  if (_showGas) blGrpHdr += '<th colspan="3" class="bl-grp bl-gas">Gas</th>';
  if (_showProp) blGrpHdr += '<th colspan="3" class="bl-grp bl-prop">Propane</th>';
  if (_showWater) blGrpHdr += '<th colspan="3" class="bl-grp bl-water">Water</th>';
  blGrpHdr +=
    '<th rowspan="2" class="rpt-n bl-grp bl-total" style="white-space:normal;line-height:1.2">Total<br>Cost</th>';
  // Detail column header row
  var blHdr = '';
  if (_showElec)
    blHdr +=
      '<th class="rpt-n bl-elec">kWh</th>' +
      '<th class="rpt-n bl-elec" style="white-space:normal;line-height:1.2">Actual<br>kW</th>' +
      '<th class="rpt-n bl-elec" style="white-space:normal;line-height:1.2">Billed<br>kW</th>' +
      '<th class="rpt-n bl-elec" style="white-space:normal;line-height:1.2">kW<br>Cost</th>' +
      '<th class="rpt-n bl-elec" style="white-space:normal;line-height:1.2">Energy<br>Cost</th>' +
      '<th class="rpt-n bl-elec" style="white-space:normal;line-height:1.2">Electric<br>Cost</th>' +
      '<th class="rpt-n bl-elec">$/kWh</th>';
  if (_showGas)
    blHdr +=
      '<th class="rpt-n bl-gas">Therms</th><th class="rpt-n bl-gas" style="white-space:normal;line-height:1.2">Gas<br>Cost</th><th class="rpt-n bl-gas">$/Therm</th>';
  if (_showProp)
    blHdr +=
      '<th class="rpt-n bl-prop">Gallons</th><th class="rpt-n bl-prop" style="white-space:normal;line-height:1.2">Prop<br>Cost</th><th class="rpt-n bl-prop">$/Gal</th>';
  if (_showWater)
    blHdr +=
      '<th class="rpt-n bl-water">kGal</th><th class="rpt-n bl-water" style="white-space:normal;line-height:1.2">Water<br>Cost</th><th class="rpt-n bl-water">$/kGal</th>';

  // Statistics summary — light bordered grid for print-ready report
  var blStats = '';
  if (blDataRows) {
    var _statItems = [];
    if (b.sqft > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">Square Feet</div><div class="bl-stat-val">' +
          b.sqft.toLocaleString() +
          '</div></div>',
      );
    if (b.sqft > 0 && _tKwh > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">kWh / sf</div><div class="bl-stat-val">' +
          (_tKwh / b.sqft).toFixed(2) +
          '</div></div>',
      );
    if (b.sqft > 0 && _tTotalCost > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">Utility Cost / sf</div><div class="bl-stat-val">' +
          $c(Math.round(_tTotalCost / b.sqft)) +
          '</div></div>',
      );
    if (_tKwh > 0 && _tElecCost > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">Avg $/kWh</div><div class="bl-stat-val">$' +
          (_tElecCost / _tKwh).toFixed(4) +
          '</div></div>',
      );
    if (_tTherms > 0 && _tGasCost > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">Avg $/Therm</div><div class="bl-stat-val">$' +
          (_tGasCost / _tTherms).toFixed(4) +
          '</div></div>',
      );
    var _totalKbtu = toKBtu(_tKwh, _tTherms, _tGal);
    if (b.sqft > 0 && _totalKbtu > 0)
      _statItems.push(
        '<div><div class="bl-stat-label">kBtu / sf</div><div class="bl-stat-val">' +
          (_totalKbtu / b.sqft).toFixed(2) +
          '</div></div>',
      );
    _statItems.push(
      '<div><div class="bl-stat-label">Utility Costs / Year</div><div class="bl-stat-val">' +
        $c(_tTotalCost) +
        '</div></div>',
    );
    blStats = '<div class="rpt-bl-stats">' + _statItems.join('') + '</div>';
  }

  var blDataTable = blDataRows
    ? '<div style="margin-top:14px;width:100%;overflow-x:auto;border:1px solid var(--rpt-page-text);page-break-inside:avoid;break-inside:avoid">' +
      blStats +
      '<div style="font-size:12px;font-weight:600;color:var(--rpt-page-bg);margin-bottom:0;padding:6px 10px;background:var(--rpt-bl-blue);text-transform:uppercase;letter-spacing:0.5px;text-align:center">Building Baseline Data</div>' +
      '<table class="rpt-table rpt-table-bl" style="font-size:10px;width:100%">' +
      '<thead><tr>' +
      blGrpHdr +
      '</tr><tr>' +
      blHdr +
      '</tr></thead><tbody>' +
      blDataRows +
      '</tbody></table></div>'
    : '';

  // -------------------------------------------------------------------
  // Meter Performance table — uses shared buildMeterPerfTableHTML
  // (same rendering as Meter Performance tab — single source of truth)
  // -------------------------------------------------------------------
  var meterPerfHTML = '';
  var _rptBldg = getUDBldg(d.project.id, b.id);
  var _rptFilterYMs = d.period.yearMonths || null;
  if (_rptBldg && _rptBldg.meters) {
    var _rptProj = getUDProj(d.project.id);
    var _rptIncl = (_rptProj && _rptProj.inclMonths) || {};
    _rptBldg.meters.forEach(function (meter) {
      if (!isCalcCommodity(d.project.id, meter.commodity)) return;
      if (!meter.baseline || !meter.baseline.months || meter.baseline.months.length < 3) return;
      var mBills = (meter.bills || []).slice().sort(function (a, c) {
        return (a.start || '').localeCompare(c.start || '');
      });
      var mIncl = meter.inclusive !== false;
      var result = buildMeterPerfTableHTML(meter, mBills, mIncl, {
        mode: 'report',
        filterYMs: _rptFilterYMs,
        projId: d.project.id,
        bldgId: b.id,
      });
      if (result.html) {
        var commLabel =
          meter.commodity === 'Electric'
            ? 'Electric'
            : meter.commodity === 'Gas'
              ? 'Gas'
              : meter.commodity === 'Propane'
                ? 'Propane'
                : meter.commodity;
        var commColor =
          meter.commodity === 'Electric'
            ? 'var(--rpt-elec-head)'
            : meter.commodity === 'Gas'
              ? 'var(--rpt-gas-head)'
              : 'var(--rpt-prop-head)';
        meterPerfHTML +=
          '<div style="font-size:10px;font-weight:600;color:' +
          commColor +
          ';margin:6px 0 2px">' +
          commLabel +
          ' Performance</div>' +
          result.html;
      }
    });
  }
  if (meterPerfHTML) {
    meterPerfHTML =
      '<div style="margin-top:8px"><div style="font-size:12px;font-weight:600;color:var(--rpt-blue);margin-bottom:3px">Meter Performance — ' +
      ((d && d.period && d.period.label) || '') +
      '</div>' +
      meterPerfHTML +
      '</div>';
  }

  // Notes
  leftHTML +=
    '<div style="margin-top:10px;font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
    '<div style="font-weight:600;color:var(--rpt-page-text);text-transform:uppercase;font-size:9px;letter-spacing:.03em;margin-bottom:3px">Utility &amp; Building Notes</div>' +
    '<div>1. Achieved (%) for each energy type represents the percent of energy units saved for the months included in this report.</div>' +
    '<div>2. Achieved ($) represents the utility cost savings for this time period calculated by subtracting the baseline energy usage from the current energy usage multiplied by the higher of current or baseline utility rates.</div>' +
    '<div>3. The Baseline Site EUIs are normalized for weather and square footage when applicable. Site EUI measures energy at the utility meter (kBtu/ft²/yr).</div>' +
    '</div>';

  // -------------------------------------------------------------------
  // Assemble two-column layout
  // -------------------------------------------------------------------
  var bodyHTML =
    '<div style="display:flex;gap:16px;align-items:flex-start">' +
    '<div style="flex:0 0 38%;max-width:38%;padding-right:12px;border-right:1px solid var(--rpt-blue-light)">' +
    leftHTML +
    '</div>' +
    '<div style="flex:1;min-width:0">' +
    rightHTML +
    '</div>' +
    '</div>';

  var result = rptPage(n, (b.name || 'Building') + ' — Building Summary', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — ' + (b.name || 'Building'),
  });

  // If there is baseline data, render it on its own separate page to prevent
  // overflow clipping in the html2canvas PDF export (bug 9ff83f06).
  if (blDataTable) {
    var blPageNum = n + 1;
    var blPageResult = rptPage(blPageNum, (b.name || 'Building') + ' — Baseline Data', blDataTable, {
      data: d,
      label: 'Page ' + blPageNum + ' — ' + (b.name || 'Building') + ' Baseline Data',
    });
    return { html: result + blPageResult, summaryPageCount: 2, meterPerfHTML: meterPerfHTML || '' };
  }

  return { html: result, summaryPageCount: 1, meterPerfHTML: meterPerfHTML || '' };
}
function rptPageElectric(n, d) {
  var $c = function (v) {
    var val = Math.round(v || 0);
    return (val < 0 ? '-' : '') + '$' + Math.abs(val).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  var $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };
  function _sc(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }

  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // -- Shared bar-chart builder ------------------------------------------
  function buildElecBarChart(monthly, blColor, curColor, unit, title) {
    if (!monthly || !monthly.length)
      return '<p style="font-size:10px;color:var(--rpt-page-text);padding:4px 0">No monthly data</p>';
    var allVals = [];
    monthly.forEach(function (mo) {
      allVals.push(mo.bl || 0, mo.cur || 0);
    });
    var maxVal = Math.max.apply(null, allVals) || 1;
    var maxH = 64;
    var blTot = 0,
      curTot = 0;
    var bars = '';
    monthly.forEach(function (mo) {
      var blH = Math.max(2, Math.round(((mo.bl || 0) / maxVal) * maxH));
      var curH = Math.max(2, Math.round(((mo.cur || 0) / maxVal) * maxH));
      blTot += mo.bl || 0;
      curTot += mo.cur || 0;
      var moIdx = mo.month ? parseInt((mo.month + '').split('-')[1], 10) - 1 : -1;
      var moLbl = moIdx >= 0 ? MO_SHORT[moIdx] : '?';
      bars +=
        '<div style="display:flex;flex-direction:column;align-items:center;flex:1">' +
        '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
        maxH +
        'px">' +
        '<div style="width:8px;height:' +
        blH +
        'px;background:' +
        blColor +
        ';border-radius:2px 2px 0 0" title="Baseline ' +
        $n(mo.bl) +
        ' ' +
        unit +
        '"></div>' +
        '<div style="width:8px;height:' +
        curH +
        'px;background:' +
        curColor +
        ';border-radius:2px 2px 0 0" title="Cur ' +
        $n(mo.cur) +
        ' ' +
        unit +
        '"></div>' +
        '</div>' +
        '<div style="font-size:10px;color:var(--rpt-page-text);margin-top:1px">' +
        moLbl +
        '</div>' +
        '</div>';
    });
    return (
      '<div class="rpt-chart-box">' +
      '<div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin-bottom:3px">' +
      title +
      '</div>' +
      '<div style="display:flex;align-items:flex-end;gap:2px;height:' +
      (maxH + 16) +
      'px">' +
      bars +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:3px;justify-content:center;font-size:11px;color:var(--rpt-page-text)">' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      blColor +
      ';border-radius:1px;margin-right:2px"></span>Baseline ' +
      $n(blTot) +
      ' ' +
      unit +
      '</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      curColor +
      ';border-radius:1px;margin-right:2px"></span>Current ' +
      $n(curTot) +
      ' ' +
      unit +
      '</span>' +
      '</div>' +
      '</div>'
    );
  }

  // -- Aggregate monthly data across all electric buildings ---------------
  var elecBldgs = (d.buildings || []).filter(function (b) {
    return b.commodities && b.commodities.includes('Electric') && b.electric && b.electric.kwhBl > 0;
  });

  // Combined monthly kWh (bl + cur) across all buildings — full 12-month year using baselineMaps
  var _rptYear = d.period && d.period.year ? d.period.year : new Date().getFullYear();
  var kwhByMonth = {};
  var kwByMonth = {};
  // Initialise all 12 slots
  for (var _ei = 0; _ei < 12; _ei++) {
    var _eym = _rptYear + '-' + String(_ei + 1).padStart(2, '0');
    kwhByMonth[_eym] = { month: _eym, bl: 0, cur: 0 };
    kwByMonth[_eym] = { month: _eym, bl: 0, cur: 0 };
  }
  // For each building build a full-year array (mirrors buildFullYear in rptPageBuildingSummary)
  elecBldgs.forEach(function (b) {
    var blMap = (b.baselineMaps && b.baselineMaps.elecByMo) || {};
    var curByMo = {};
    (b.electric.monthly || []).forEach(function (mo) {
      var idx = parseInt(mo.month.split('-')[1], 10) - 1;
      curByMo[idx] = mo;
    });
    for (var _mi = 0; _mi < 12; _mi++) {
      var _ym = _rptYear + '-' + String(_mi + 1).padStart(2, '0');
      var blKwh = (blMap[_mi] && blMap[_mi].kwh) || 0;
      var blKw =
        (blMap[_mi] && (blMap[_mi].billedKW || blMap[_mi].demandKW || blMap[_mi].kw || blMap[_mi].kwPeak)) || 0;
      var curMo = curByMo[_mi];
      if (curMo) {
        // Reporting-period month: prefer the stored bl from the monthly entry
        blKwh = curMo.bl || blKwh;
        blKw = curMo.kwBl || curMo.blKw || blKw;
      }
      var curKwh = curMo ? curMo.cur || 0 : 0;
      var curKw = curMo ? curMo.kwCur || curMo.curKw || 0 : 0;
      kwhByMonth[_ym].bl += blKwh;
      kwhByMonth[_ym].cur += curKwh;
      kwByMonth[_ym].bl += blKw;
      kwByMonth[_ym].cur += curKw;
    }
  });
  var kwhMonthly = Object.values(kwhByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });
  var kwMonthly = Object.values(kwByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });

  // -- Charts ------------------------------------------------------------
  var kwhChart = elecBldgs.length
    ? buildElecBarChart(
        kwhMonthly,
        'var(--rpt-elec-bl)',
        'var(--rpt-elec-cur)',
        'kWh',
        'Monthly Electric kWh — Year over Year',
      )
    : '<p style="font-size:10px;color:var(--rpt-page-text)">No electric data</p>';

  var hasKwData = kwMonthly.some(function (mo) {
    return (mo.bl || 0) > 0 || (mo.cur || 0) > 0;
  });
  var kwChart =
    elecBldgs.length && hasKwData
      ? buildElecBarChart(
          kwMonthly,
          'var(--rpt-elec-bl)',
          'var(--rpt-elec-cur)',
          'kW',
          'Monthly Peak kW — Year over Year',
        )
      : '';

  // -- By-building table -------------------------------------------------
  var totBlKwh = 0,
    totCurKwh = 0,
    totSavKwh = 0,
    totBlKw = 0,
    totCurKw = 0;
  var totBlCost = 0,
    totCurCost = 0,
    totSavCost = 0;
  var tableRows = '';

  elecBldgs.forEach(function (b) {
    var blKwh = b.electric.kwhBl || 0;
    var curKwh = b.electric.kwhCur || 0;
    var savKwh = b.electric.kwhSaved || blKwh - curKwh;
    var savPct = blKwh > 0 ? (savKwh / blKwh) * 100 : 0;
    var blKw = b.electric.kwBl || 0;
    var curKw = b.electric.kwCur || 0;
    var blCost = b.electric.costBl || 0;
    var curCost = b.electric.costCur || 0;
    var savCost = b.electric.costSaved || 0;
    totBlKwh += blKwh;
    totCurKwh += curKwh;
    totSavKwh += savKwh;
    totBlKw += blKw;
    totCurKw += curKw;
    totBlCost += blCost;
    totCurCost += curCost;
    totSavCost += savCost;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">' +
      (b.name || '—') +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(blKwh) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(curKwh) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savKwh) +
      ';font-weight:600">' +
      $n(savKwh) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savPct) +
      '">' +
      $p(savPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(blKw) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(curKw) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(blCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(curCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savCost) +
      ';font-weight:600">' +
      $c(savCost) +
      '</td>' +
      '</tr>';
  });

  if (!tableRows) {
    tableRows =
      '<tr><td colspan="10" style="color:var(--rpt-page-text);font-style:italic">No electric buildings in this project</td></tr>';
  } else {
    var totSavPct = totBlKwh > 0 ? (totSavKwh / totBlKwh) * 100 : 0;
    tableRows +=
      '<tr class="rpt-tot">' +
      '<td>TOTAL</td>' +
      '<td class="rpt-n">' +
      $n(totBlKwh) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCurKwh) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavKwh) +
      '">' +
      $n(totSavKwh) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavPct) +
      '">' +
      $p(totSavPct) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totBlKw) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCurKw) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totBlCost) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totCurCost) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavCost) +
      ';font-weight:700">' +
      $c(totSavCost) +
      '</td>' +
      '</tr>';
  }

  var bldgTable =
    '<table class="rpt-table rpt-table-wrap" contenteditable="true" style="font-size:10px;width:100%;table-layout:fixed">' +
    '<colgroup>' +
    '<col style="width:20%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:7%">' +
    '<col style="width:5%">' +
    '<col style="width:11%">' +
    '<col style="width:9%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:8%">' +
    '</colgroup>' +
    '<thead><tr style="white-space:normal;word-wrap:break-word;line-height:1.2">' +
    '<th>Building</th><th class="rpt-n">Baseline kWh</th><th class="rpt-n">Actual kWh</th>' +
    '<th class="rpt-n">Saved</th><th class="rpt-n">%</th>' +
    '<th class="rpt-n">Baseline Peak kW</th><th class="rpt-n">Actual kW</th>' +
    '<th class="rpt-n">Baseline Cost</th><th class="rpt-n">Actual Cost</th><th class="rpt-n">$ Saved</th>' +
    '</tr></thead>' +
    '<tbody>' +
    tableRows +
    '</tbody>' +
    '</table>';

  var periodLabel = (d.period && d.period.label) || '';
  var bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page details electricity consumption across all buildings for the reporting period. The charts compare weather-normalized baseline usage against actual consumption by month. The table below breaks down kilowatt-hour (kWh) usage, peak demand (kW), and costs by building to identify where the greatest savings and opportunities exist.</p>' +
    '<div style="margin-bottom:6px;font-size:11px;color:var(--rpt-page-text)">Period: ' +
    periodLabel +
    '</div>' +
    kwhChart +
    kwChart +
    '<h2 style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin:10px 0 4px">Electric by Building — ' +
    periodLabel +
    '</h2>' +
    bldgTable;

  return rptPage(n, 'Electric Consumption Detail', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Electric Detail',
  });
}
function rptPageGas(n, d) {
  var $c = function (v) {
    var val = Math.round(v || 0);
    return (val < 0 ? '-' : '') + '$' + Math.abs(val).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  var $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };
  function _sc(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }
  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function buildGasBarChart(monthly, blColor, curColor, unit, title) {
    if (!monthly || !monthly.length)
      return '<p style="font-size:10px;color:var(--rpt-page-text);padding:4px 0">No monthly data</p>';
    var allVals = [];
    monthly.forEach(function (mo) {
      allVals.push(mo.bl || 0, mo.cur || 0);
    });
    var maxVal = Math.max.apply(null, allVals) || 1;
    var maxH = 64;
    var blTot = 0,
      curTot = 0;
    var bars = '';
    monthly.forEach(function (mo) {
      var blH = Math.max(2, Math.round(((mo.bl || 0) / maxVal) * maxH));
      var curH = Math.max(2, Math.round(((mo.cur || 0) / maxVal) * maxH));
      blTot += mo.bl || 0;
      curTot += mo.cur || 0;
      var moIdx = mo.month ? parseInt((mo.month + '').split('-')[1], 10) - 1 : -1;
      var moLbl = moIdx >= 0 ? MO_SHORT[moIdx] : '?';
      bars +=
        '<div style="display:flex;flex-direction:column;align-items:center;flex:1">' +
        '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
        maxH +
        'px">' +
        '<div style="width:8px;height:' +
        blH +
        'px;background:' +
        blColor +
        ';border-radius:2px 2px 0 0" title="Baseline ' +
        $n(mo.bl) +
        ' ' +
        unit +
        '"></div>' +
        '<div style="width:8px;height:' +
        curH +
        'px;background:' +
        curColor +
        ';border-radius:2px 2px 0 0" title="Cur ' +
        $n(mo.cur) +
        ' ' +
        unit +
        '"></div>' +
        '</div><div style="font-size:10px;color:var(--rpt-page-text);margin-top:1px">' +
        moLbl +
        '</div></div>';
    });
    return (
      '<div class="rpt-chart-box">' +
      '<div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin-bottom:3px">' +
      title +
      '</div>' +
      '<div style="display:flex;align-items:flex-end;gap:2px;height:' +
      (maxH + 16) +
      'px">' +
      bars +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:3px;justify-content:center;font-size:11px;color:var(--rpt-page-text)">' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      blColor +
      ';border-radius:1px;margin-right:2px"></span>Baseline ' +
      $n(blTot) +
      ' ' +
      unit +
      '</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      curColor +
      ';border-radius:1px;margin-right:2px"></span>Current ' +
      $n(curTot) +
      ' ' +
      unit +
      '</span>' +
      '</div></div>'
    );
  }

  var gasBldgs = (d.buildings || []).filter(function (b) {
    return b.commodities && b.commodities.includes('Gas') && b.gas && b.gas.thermsBl > 0;
  });

  // Use full-year aggregation: fill baseline-only months using baselineMaps so chart shows all 12 months
  var _gasRptYear = d.period && d.period.year ? d.period.year : new Date().getFullYear();
  var thermsByMonth = {};
  for (var _gi = 0; _gi < 12; _gi++) {
    var _gym = _gasRptYear + '-' + String(_gi + 1).padStart(2, '0');
    thermsByMonth[_gym] = { month: _gym, bl: 0, cur: 0 };
  }
  gasBldgs.forEach(function (b) {
    var blMap = (b.baselineMaps && b.baselineMaps.gasByMo) || {};
    var curByMo = {};
    (b.gas.monthly || []).forEach(function (mo) {
      var idx = parseInt(mo.month.split('-')[1], 10) - 1;
      curByMo[idx] = mo;
    });
    for (var _mi = 0; _mi < 12; _mi++) {
      var _ym = _gasRptYear + '-' + String(_mi + 1).padStart(2, '0');
      var blTherms = blMap[_mi]?.therms ?? 0;
      var curMo = curByMo[_mi];
      if (curMo) blTherms = curMo.bl || blTherms;
      thermsByMonth[_ym].bl += blTherms;
      thermsByMonth[_ym].cur += curMo ? curMo.cur || 0 : 0;
    }
  });
  var thermsMonthly = Object.values(thermsByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });

  var thermsChart = gasBldgs.length
    ? buildGasBarChart(
        thermsMonthly,
        'var(--rpt-gas-bl)',
        'var(--rpt-gas-cur)',
        'Therms',
        'Monthly Natural Gas Therms — Year over Year',
      )
    : '<p style="font-size:10px;color:var(--rpt-page-text)">No gas data</p>';

  var totBlTherms = 0,
    totCurTherms = 0,
    totSavTherms = 0;
  var totBlCost = 0,
    totCurCost = 0,
    totSavCost = 0;
  var tableRows = '';
  gasBldgs.forEach(function (b) {
    var blT = b.gas.thermsBl || 0;
    var curT = b.gas.thermsCur || 0;
    var savT = b.gas.thermsSaved || blT - curT;
    var savPct = blT > 0 ? (savT / blT) * 100 : 0;
    var blCost = b.gas.costBl || 0;
    var curCost = b.gas.costCur || 0;
    var savCost = b.gas.costSaved || 0;
    totBlTherms += blT;
    totCurTherms += curT;
    totSavTherms += savT;
    totBlCost += blCost;
    totCurCost += curCost;
    totSavCost += savCost;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">' +
      (b.name || '—') +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(blT) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(curT) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savT) +
      ';font-weight:600">' +
      $n(savT) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savPct) +
      '">' +
      $p(savPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(blCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(curCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savCost) +
      ';font-weight:600">' +
      $c(savCost) +
      '</td>' +
      '</tr>';
  });
  if (!tableRows) {
    tableRows =
      '<tr><td colspan="8" style="color:var(--rpt-page-text);font-style:italic">No gas buildings in this project</td></tr>';
  } else {
    var tSavPct = totBlTherms > 0 ? (totSavTherms / totBlTherms) * 100 : 0;
    tableRows +=
      '<tr class="rpt-tot"><td>TOTAL</td>' +
      '<td class="rpt-n">' +
      $n(totBlTherms) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCurTherms) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavTherms) +
      '">' +
      $n(totSavTherms) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(tSavPct) +
      '">' +
      $p(tSavPct) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totBlCost) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totCurCost) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavCost) +
      ';font-weight:700">' +
      $c(totSavCost) +
      '</td>' +
      '</tr>';
  }

  var bldgTable =
    '<table class="rpt-table" contenteditable="true" style="font-size:10px">' +
    '<thead><tr><th>Building</th><th class="rpt-n">Baseline Therms</th><th class="rpt-n">Actual Therms</th>' +
    '<th class="rpt-n">Saved</th><th class="rpt-n">%</th>' +
    '<th class="rpt-n">Baseline Cost</th><th class="rpt-n">Actual Cost</th><th class="rpt-n">$ Saved</th>' +
    '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table>';

  var periodLabel = (d.period && d.period.label) || '';
  var bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page details natural gas consumption across all buildings for the reporting period. Gas usage is measured in therms and is primarily driven by heating loads. The chart compares baseline consumption against actual usage by month, while the per-building table identifies where gas savings or overages are occurring.</p>' +
    '<div style="margin-bottom:6px;font-size:11px;color:var(--rpt-page-text)">Period: ' +
    periodLabel +
    '</div>' +
    thermsChart +
    '<h2 style="font-size:12px;font-weight:700;color:var(--rpt-gas-head);margin:10px 0 4px">Natural Gas by Building — ' +
    periodLabel +
    '</h2>' +
    bldgTable;

  return rptPage(n, 'Natural Gas Consumption Detail', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Gas Detail',
  });
}

function rptPagePropane(n, d) {
  var $c = function (v) {
    var val = Math.round(v || 0);
    return (val < 0 ? '-' : '') + '$' + Math.abs(val).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  var $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };
  function _sc(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }
  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function buildPropBarChart(monthly, blColor, curColor, unit, title) {
    if (!monthly || !monthly.length)
      return '<p style="font-size:10px;color:var(--rpt-page-text);padding:4px 0">No monthly data</p>';
    var allVals = [];
    monthly.forEach(function (mo) {
      allVals.push(mo.bl || 0, mo.cur || 0);
    });
    var maxVal = Math.max.apply(null, allVals) || 1;
    var maxH = 64;
    var blTot = 0,
      curTot = 0;
    var bars = '';
    monthly.forEach(function (mo) {
      var blH = Math.max(2, Math.round(((mo.bl || 0) / maxVal) * maxH));
      var curH = Math.max(2, Math.round(((mo.cur || 0) / maxVal) * maxH));
      blTot += mo.bl || 0;
      curTot += mo.cur || 0;
      var moIdx = mo.month ? parseInt((mo.month + '').split('-')[1], 10) - 1 : -1;
      var moLbl = moIdx >= 0 ? MO_SHORT[moIdx] : '?';
      bars +=
        '<div style="display:flex;flex-direction:column;align-items:center;flex:1">' +
        '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
        maxH +
        'px">' +
        '<div style="width:8px;height:' +
        blH +
        'px;background:' +
        blColor +
        ';border-radius:2px 2px 0 0" title="Baseline ' +
        $n(mo.bl) +
        ' ' +
        unit +
        '"></div>' +
        '<div style="width:8px;height:' +
        curH +
        'px;background:' +
        curColor +
        ';border-radius:2px 2px 0 0" title="Cur ' +
        $n(mo.cur) +
        ' ' +
        unit +
        '"></div>' +
        '</div><div style="font-size:10px;color:var(--rpt-page-text);margin-top:1px">' +
        moLbl +
        '</div></div>';
    });
    return (
      '<div class="rpt-chart-box">' +
      '<div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin-bottom:3px">' +
      title +
      '</div>' +
      '<div style="display:flex;align-items:flex-end;gap:2px;height:' +
      (maxH + 16) +
      'px">' +
      bars +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:3px;justify-content:center;font-size:11px;color:var(--rpt-page-text)">' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      blColor +
      ';border-radius:1px;margin-right:2px"></span>Baseline ' +
      $n(blTot) +
      ' ' +
      unit +
      '</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;background:' +
      curColor +
      ';border-radius:1px;margin-right:2px"></span>Current ' +
      $n(curTot) +
      ' ' +
      unit +
      '</span>' +
      '</div></div>'
    );
  }

  var propBldgs = (d.buildings || []).filter(function (b) {
    return (
      b.commodities &&
      b.commodities.includes('Propane') &&
      b.propane &&
      b.propane.monthly &&
      b.propane.monthly.length > 0
    );
  });

  // Use full-year aggregation: fill baseline-only months using baselineMaps
  var _propRptYear = d.period && d.period.year ? d.period.year : new Date().getFullYear();
  var galByMonth = {};
  for (var _pi = 0; _pi < 12; _pi++) {
    var _pym = _propRptYear + '-' + String(_pi + 1).padStart(2, '0');
    galByMonth[_pym] = { month: _pym, bl: 0, cur: 0 };
  }
  propBldgs.forEach(function (b) {
    var blMap = (b.baselineMaps && b.baselineMaps.propaneByMo) || {};
    var curByMo = {};
    (b.propane.monthly || []).forEach(function (mo) {
      var idx = parseInt(mo.month.split('-')[1], 10) - 1;
      curByMo[idx] = mo;
    });
    for (var _pmi = 0; _pmi < 12; _pmi++) {
      var _pym2 = _propRptYear + '-' + String(_pmi + 1).padStart(2, '0');
      var blGal = blMap[_pmi]?.gallons ?? 0;
      var curMo = curByMo[_pmi];
      if (curMo) blGal = curMo.bl || blGal;
      galByMonth[_pym2].bl += blGal;
      galByMonth[_pym2].cur += curMo ? curMo.cur || 0 : 0;
    }
  });
  var galMonthly = Object.values(galByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });

  var galChart = propBldgs.length
    ? buildPropBarChart(
        galMonthly,
        'var(--rpt-prop-bl)',
        'var(--rpt-prop-cur)',
        'Gal',
        'Monthly Propane Gallons — Year over Year',
      )
    : '<p style="font-size:10px;color:var(--rpt-page-text)">No propane data</p>';

  var totBlGal = 0,
    totCurGal = 0,
    totSavGal = 0;
  var totBlCost = 0,
    totCurCost = 0,
    totSavCost = 0;
  var tableRows = '';
  propBldgs.forEach(function (b) {
    var blG = b.propane.galBl || 0;
    var curG = b.propane.galCur || 0;
    var savG = b.propane.galSaved || blG - curG;
    var savPct = blG > 0 ? (savG / blG) * 100 : 0;
    var blCost = b.propane.costBl || 0;
    var curCost = b.propane.costCur || 0;
    var savCost = b.propane.costSaved || 0;
    totBlGal += blG;
    totCurGal += curG;
    totSavGal += savG;
    totBlCost += blCost;
    totCurCost += curCost;
    totSavCost += savCost;
    tableRows +=
      '<tr>' +
      '<td contenteditable="true">' +
      (b.name || '—') +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(blG) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(curG) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savG) +
      ';font-weight:600">' +
      $n(savG) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savPct) +
      '">' +
      $p(savPct) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(blCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $c(curCost) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true" style="color:' +
      _sc(savCost) +
      ';font-weight:600">' +
      $c(savCost) +
      '</td>' +
      '</tr>';
  });
  if (!tableRows) {
    tableRows =
      '<tr><td colspan="8" style="color:var(--rpt-page-text);font-style:italic">No propane buildings in this project</td></tr>';
  } else {
    var tSavPct = totBlGal > 0 ? (totSavGal / totBlGal) * 100 : 0;
    tableRows +=
      '<tr class="rpt-tot"><td>TOTAL</td>' +
      '<td class="rpt-n">' +
      $n(totBlGal) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCurGal) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavGal) +
      '">' +
      $n(totSavGal) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(tSavPct) +
      '">' +
      $p(tSavPct) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totBlCost) +
      '</td>' +
      '<td class="rpt-n">' +
      $c(totCurCost) +
      '</td>' +
      '<td class="rpt-n" style="color:' +
      _sc(totSavCost) +
      ';font-weight:700">' +
      $c(totSavCost) +
      '</td>' +
      '</tr>';
  }

  var bldgTable =
    '<table class="rpt-table" contenteditable="true" style="font-size:10px">' +
    '<thead><tr><th>Building</th><th class="rpt-n">Baseline Gallons</th><th class="rpt-n">Actual Gallons</th>' +
    '<th class="rpt-n">Saved</th><th class="rpt-n">%</th>' +
    '<th class="rpt-n">Baseline Cost</th><th class="rpt-n">Actual Cost</th><th class="rpt-n">$ Saved</th>' +
    '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table>';

  var propaneNames = propBldgs
    .map(function (b) {
      return b.name || 'Unknown';
    })
    .join(', ');
  var noteText = propBldgs.length
    ? 'Note: Only ' + propaneNames + ' use propane. Other buildings are electric + natural gas only.'
    : 'Note: No buildings in this project use propane.';

  var periodLabel = (d.period && d.period.label) || '';
  var bodyHTML =
    '<div style="margin-bottom:6px;font-size:11px;color:var(--rpt-page-text)">Period: ' +
    periodLabel +
    '</div>' +
    galChart +
    '<h2 style="font-size:12px;font-weight:700;color:var(--rpt-prop-head);margin:10px 0 4px">Propane by Building — ' +
    periodLabel +
    '</h2>' +
    bldgTable +
    '<div style="margin-top:8px;font-size:10px;color:var(--rpt-page-text);font-style:italic;border-top:1px solid var(--rpt-divider);padding-top:6px" contenteditable="true">' +
    noteText +
    '</div>';

  return rptPage(n, 'Propane Consumption Detail', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Propane Detail',
  });
}

function rptPageGasPropane(n, d) {
  var $c = function (v) {
    var val = Math.round(v || 0);
    return (val < 0 ? '-' : '') + '$' + Math.abs(val).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  var $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };
  function _sc(v) {
    return v >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)';
  }
  var MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function _barChart(monthly, blColor, curColor, unit, title) {
    if (!monthly || !monthly.length)
      return '<p style="font-size:10px;color:var(--rpt-page-text);padding:4px 0">No monthly data</p>';
    var allVals = [];
    monthly.forEach(function (mo) {
      allVals.push(mo.bl || 0, mo.cur || 0);
    });
    var maxVal = Math.max.apply(null, allVals) || 1;
    var maxH = 50;
    var blTot = 0,
      curTot = 0;
    var bars = '';
    monthly.forEach(function (mo) {
      var blH = Math.max(2, Math.round(((mo.bl || 0) / maxVal) * maxH));
      var curH = Math.max(2, Math.round(((mo.cur || 0) / maxVal) * maxH));
      blTot += mo.bl || 0;
      curTot += mo.cur || 0;
      var moIdx = mo.month ? parseInt((mo.month + '').split('-')[1], 10) - 1 : -1;
      bars +=
        '<div style="display:flex;flex-direction:column;align-items:center;flex:1"><div style="display:flex;align-items:flex-end;gap:1px;height:' +
        maxH +
        'px"><div style="width:7px;height:' +
        blH +
        'px;background:' +
        blColor +
        ';border-radius:2px 2px 0 0"></div><div style="width:7px;height:' +
        curH +
        'px;background:' +
        curColor +
        ';border-radius:2px 2px 0 0"></div></div><div style="font-size:9px;color:var(--rpt-page-text);margin-top:1px">' +
        (moIdx >= 0 ? MO_SHORT[moIdx] : '?') +
        '</div></div>';
    });
    return (
      '<div class="rpt-chart-box" style="margin-bottom:6px"><div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin-bottom:3px">' +
      title +
      '</div><div style="display:flex;align-items:flex-end;gap:2px;height:' +
      (maxH + 14) +
      'px">' +
      bars +
      '</div><div style="display:flex;gap:8px;margin-top:2px;justify-content:center;font-size:10px;color:var(--rpt-page-text)"><span><span style="display:inline-block;width:7px;height:7px;background:' +
      blColor +
      ';border-radius:1px;margin-right:2px"></span>BL ' +
      $n(blTot) +
      ' ' +
      unit +
      '</span><span><span style="display:inline-block;width:7px;height:7px;background:' +
      curColor +
      ';border-radius:1px;margin-right:2px"></span>Cur ' +
      $n(curTot) +
      ' ' +
      unit +
      '</span></div></div>'
    );
  }
  function _table(bldgs, getCom, unitLabel) {
    var totBl = 0,
      totCur = 0,
      totSav = 0,
      totBlC = 0,
      totCurC = 0,
      totSavC = 0;
    var rows = '';
    bldgs.forEach(function (b) {
      var c = getCom(b);
      var bl = c.bl || 0;
      var cur = c.cur || 0;
      var sav = c.sav || bl - cur;
      var savPct = bl > 0 ? (sav / bl) * 100 : 0;
      var blC = c.costBl || 0;
      var curC = c.costCur || 0;
      var savC = c.costSaved || 0;
      totBl += bl;
      totCur += cur;
      totSav += sav;
      totBlC += blC;
      totCurC += curC;
      totSavC += savC;
      rows +=
        '<tr><td contenteditable="true">' +
        (b.name || '—') +
        '</td><td class="rpt-n" contenteditable="true">' +
        $n(bl) +
        '</td><td class="rpt-n" contenteditable="true">' +
        $n(cur) +
        '</td><td class="rpt-n" contenteditable="true" style="color:' +
        _sc(sav) +
        ';font-weight:600">' +
        $n(sav) +
        '</td><td class="rpt-n" contenteditable="true" style="color:' +
        _sc(savPct) +
        '">' +
        $p(savPct) +
        '</td><td class="rpt-n" contenteditable="true">' +
        $c(blC) +
        '</td><td class="rpt-n" contenteditable="true">' +
        $c(curC) +
        '</td><td class="rpt-n" contenteditable="true" style="color:' +
        _sc(savC) +
        ';font-weight:600">' +
        $c(savC) +
        '</td></tr>';
    });
    if (rows) {
      var tPct = totBl > 0 ? (totSav / totBl) * 100 : 0;
      rows +=
        '<tr class="rpt-tot"><td>TOTAL</td><td class="rpt-n">' +
        $n(totBl) +
        '</td><td class="rpt-n">' +
        $n(totCur) +
        '</td><td class="rpt-n" style="color:' +
        _sc(totSav) +
        '">' +
        $n(totSav) +
        '</td><td class="rpt-n" style="color:' +
        _sc(tPct) +
        '">' +
        $p(tPct) +
        '</td><td class="rpt-n">' +
        $c(totBlC) +
        '</td><td class="rpt-n">' +
        $c(totCurC) +
        '</td><td class="rpt-n" style="color:' +
        _sc(totSavC) +
        ';font-weight:700">' +
        $c(totSavC) +
        '</td></tr>';
    }
    return (
      '<table class="rpt-table" contenteditable="true" style="font-size:9px"><thead><tr><th>Building</th><th class="rpt-n">Baseline ' +
      unitLabel +
      '</th><th class="rpt-n">Actual</th><th class="rpt-n">Saved</th><th class="rpt-n">%</th><th class="rpt-n">Baseline Cost</th><th class="rpt-n">Actual Cost</th><th class="rpt-n">$ Saved</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>'
    );
  }
  var gasBldgs = (d.buildings || []).filter(function (b) {
    return b.commodities && b.commodities.includes('Gas') && b.gas && b.gas.thermsBl > 0;
  });
  var propBldgs = (d.buildings || []).filter(function (b) {
    return (
      b.commodities &&
      b.commodities.includes('Propane') &&
      b.propane &&
      b.propane.monthly &&
      b.propane.monthly.length > 0
    );
  });
  var thermsByMonth = {};
  gasBldgs.forEach(function (b) {
    (b.gas.monthly || []).forEach(function (mo) {
      if (!thermsByMonth[mo.month]) thermsByMonth[mo.month] = { month: mo.month, bl: 0, cur: 0 };
      thermsByMonth[mo.month].bl += mo.bl || 0;
      thermsByMonth[mo.month].cur += mo.cur || 0;
    });
  });
  var galByMonth = {};
  propBldgs.forEach(function (b) {
    (b.propane.monthly || []).forEach(function (mo) {
      if (!galByMonth[mo.month]) galByMonth[mo.month] = { month: mo.month, bl: 0, cur: 0 };
      galByMonth[mo.month].bl += mo.bl || 0;
      galByMonth[mo.month].cur += mo.cur || 0;
    });
  });
  var thermsMonthly = Object.values(thermsByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });
  var galMonthly = Object.values(galByMonth).sort(function (a, b) {
    return a.month < b.month ? -1 : 1;
  });
  var periodLabel = (d.period && d.period.label) || '';
  var bodyHTML =
    '<p contenteditable="true" style="font-size:14px;color:var(--rpt-page-text);line-height:1.5;margin:0 0 6px">This page details natural gas and propane consumption across all buildings for the reporting period.</p>' +
    _barChart(thermsMonthly, 'var(--rpt-gas-bl)', 'var(--rpt-gas-cur)', 'Therms', 'Natural Gas Therms') +
    '<h2 style="font-size:11px;font-weight:700;color:var(--rpt-gas-head);margin:8px 0 3px">Natural Gas by Building</h2>' +
    _table(
      gasBldgs,
      function (b) {
        return {
          bl: b.gas.thermsBl,
          cur: b.gas.thermsCur,
          sav: b.gas.thermsSaved,
          costBl: b.gas.costBl,
          costCur: b.gas.costCur,
          costSaved: b.gas.costSaved,
        };
      },
      'Therms',
    ) +
    _barChart(galMonthly, 'var(--rpt-prop-bl)', 'var(--rpt-prop-cur)', 'Gal', 'Propane Gallons') +
    '<h2 style="font-size:11px;font-weight:700;color:var(--rpt-prop-head);margin:8px 0 3px">Propane by Building</h2>' +
    _table(
      propBldgs,
      function (b) {
        return {
          bl: b.propane.galBl,
          cur: b.propane.galCur,
          sav: b.propane.galSaved,
          costBl: b.propane.costBl,
          costCur: b.propane.costCur,
          costSaved: b.propane.costSaved,
        };
      },
      'Gallons',
    );
  return rptPage(n, 'Gas & Propane Consumption Detail', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Gas & Propane Detail',
  });
}

function rptPageAppendixNormalization(n, d, appLetter) {
  appLetter = appLetter || 'A';
  var $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };

  var blStart = (d.project && d.project.blStart) || '—';
  var blStart = (d.project && d.project.blStart) || '—';
  var blEnd = (d.project && d.project.blEnd) || '—';

  var methodBox =
    '<div contenteditable="true" style="padding:10px 12px;font-size:11px;line-height:1.7;color:var(--rpt-page-text);margin-bottom:12px">' +
    '<strong>Normalization Method:</strong> Regression analysis using Heating Degree Days (HDD) and Cooling Degree Days (CDD) at balance point 60°F, per contract specification.<br>' +
    '<strong>Baseline Period:</strong> ' +
    blStart +
    ' through ' +
    blEnd +
    '<br>' +
    '<strong>Savings Calculation:</strong> Units saved (weather-normalized baseline minus actual) multiplied by current monthly utility rate.<br>' +
    '<strong>Regression Model:</strong> Ordinary Least Squares (OLS) with HDD and CDD as independent variables. R² values shown per meter below.' +
    '</div>';

  // Per-building meter tables using meterDetails from collectReportData
  var monthNames = [
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
  var sectionTitle =
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:0 0 6px;text-transform:uppercase;letter-spacing:0.04em">Per-Building Meter Detail</h3>';
  var contSectionTitle =
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:0 0 6px;text-transform:uppercase;letter-spacing:0.04em">Per-Building Meter Detail (cont.)</h3>';

  // fix/report-content-pagination (2026-07-28): this used to concatenate ALL buildings'
  // meter tables into a single string handed to ONE rptPage() call — with JOCO's 26
  // buildings that overflowed .rpt-body with zero pagination (footer no longer pinned to
  // the page bottom in print). Now each building's block is a token; _rptPaginateTokens
  // (the same shared paginator rptPageObservations/rptPageASHRAE36Executive use) splits
  // them across as many pages as needed, each carrying full rptPage() header/footer chrome.
  var bldgTokens = [];
  (d.buildings || []).forEach(function (b) {
    var details = b.meterDetails || [];
    if (!details.length) return;
    var meterRows = details
      .map(function (md) {
        var blPeriod = '—';
        if (md.blStart && md.blEnd) {
          var s = md.blStart.split('-');
          var e = md.blEnd.split('-');
          blPeriod = monthNames[parseInt(s[1]) - 1] + ' ' + s[0] + ' – ' + monthNames[parseInt(e[1]) - 1] + ' ' + e[0];
        }
        var unitLabel = md.commodity === 'Electric' ? ' kWh' : md.commodity === 'Gas' ? ' Therms' : ' Gallons';
        return (
          '<tr>' +
          '<td contenteditable="true">' +
          md.commodity +
          (md.account ? ' · ' + md.account : '') +
          '</td>' +
          '<td contenteditable="true">' +
          blPeriod +
          '</td>' +
          '<td contenteditable="true">' +
          md.regrType +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          md.r2 +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          $n(md.hdd) +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (md.commodity === 'Electric' ? $n(md.cdd) : '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          $n(md.usagePerYear) +
          unitLabel +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          $c(md.costPerYear) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    var blockHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin:10px 0 4px">' +
      (b.name || 'Building') +
      '</div>' +
      '<table class="rpt-table" style="font-size:10px;margin-bottom:6px">' +
      '<thead><tr>' +
      '<th>Meter</th><th>Baseline Period</th><th>Regression</th><th class="rpt-n">R²</th>' +
      '<th class="rpt-n">HDD</th><th class="rpt-n">CDD</th><th class="rpt-n">Usage/Year</th><th class="rpt-n">Cost/Year</th>' +
      '</tr></thead><tbody>' +
      meterRows +
      '</tbody></table>';
    // estH: building-name label (~20px) + table thead (~26px) + one row per meter (~22px,
    // conservative for 10px-font table rows) + table margin-bottom (~6px) + safety margin.
    var estH = 20 + 26 + details.length * 22 + 6 + 10;
    bldgTokens.push({ type: 'block', html: blockHTML, estH: estH });
  });

  // NORM_FIRST_CHROME: methodBox (~110px, 4 lines @ 11px/1.7 line-height + padding) + section
  // heading (~24px) + safety margin. NORM_CONT_CHROME: continuation heading only + safety margin.
  var NORM_FIRST_CHROME = 160;
  var NORM_CONT_CHROME = 50;
  var _normBudgetFirst = _rptContentBudget('standard') - NORM_FIRST_CHROME;
  var _normBudgetCont = _rptContentBudget('standard') - NORM_CONT_CHROME;
  var normChunks = _rptPaginateTokens(bldgTokens, _normBudgetFirst, _normBudgetCont);

  var resultPages = [];
  var currentPageNum = n;
  var pageTitle = 'Appendix ' + appLetter + ': Normalization & Meter Baseline';

  if (normChunks.length === 0) {
    var emptyBody =
      methodBox +
      sectionTitle +
      '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No building meter data available.</p>';
    resultPages.push(
      rptPage(currentPageNum, pageTitle, emptyBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Appendix ' + appLetter,
      }),
    );
    return { html: resultPages.join(''), pageCount: resultPages.length };
  }

  normChunks.forEach(function (chunk, idx) {
    var isFirst = idx === 0;
    var chunkHTML = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var pageBody = (isFirst ? methodBox + sectionTitle : contSectionTitle) + chunkHTML;
    resultPages.push(
      rptPage(currentPageNum, pageTitle + (isFirst ? '' : ' (cont.)'), pageBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Appendix ' + appLetter + (isFirst ? '' : ' (cont.)'),
      }),
    );
    currentPageNum++;
  });

  return { html: resultPages.join(''), pageCount: resultPages.length };
}

function rptPageAppendixBaseline(n, d, appLetter, appMap) {
  appLetter = appLetter || 'B';
  appMap = appMap || {};
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };
  var $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  var MO_FULL = [
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
  function _daysInMonth(ym) {
    var p = ym.split('-');
    return new Date(parseInt(p[0]), parseInt(p[1]), 0).getDate();
  }

  var regressionExplainer =
    '<div contenteditable="true" style="padding:10px 14px;font-size:11px;line-height:1.7;color:var(--rpt-page-text);margin-bottom:12px">' +
    'Weather-normalized savings use an OLS regression model: <span style="font-family:var(--rpt-mono);background:var(--rpt-page-bg);border:1px solid var(--rpt-divider);padding:1px 4px;border-radius:2px">Usage = c0 — Days + —1 — HDD + —2 — CDD</span><br>' +
    'Where β0 = base load per day, β1 = heating coefficient, β2 = cooling coefficient. ' +
    'The model is fit to baseline period data and applied to current weather to predict what consumption <em>would have been</em> without efficiency improvements. ' +
    'R² values above 0.75 indicate a strong fit.' +
    (appMap.norm ? ' Full regression details are in Appendix ' + appMap.norm + '.' : '') +
    '' +
    '</div>';

  // Build weather lookup by YYYY-MM
  var wxByYm = {};
  ((d.weather && d.weather.monthly) || []).forEach(function (w) {
    wxByYm[w.month] = w;
  });

  // Build full calculation tables per building per commodity.
  // fix/report-content-pagination (2026-07-28): this used to concatenate ALL buildings' and
  // meters' calculation tables into a single `calcHTML` string handed to ONE rptPage() call —
  // with JOCO's 26 buildings (each with up to several meters and a combined
  // baseline+reporting-period row set per meter) that overflowed .rpt-body with zero
  // pagination. Now each meter's table is its own token (the building-name header rides
  // along with that building's first meter token); _rptPaginateTokens (same shared
  // paginator as rptPageObservations/rptPageASHRAE36Executive) splits them across as many
  // pages as needed, each carrying full rptPage() header/footer chrome.
  var meterTokens = [];
  (d.buildings || []).forEach(function (b) {
    var meters = b.meterDetails || [];
    var metersWithCoeffs = meters.filter(function (md) {
      return md.regrCoeffs && md.r2 && md.r2 !== '—';
    });
    // Also include meters that have baseline months but no regression (show baseline data only)
    var metersWithBlOnly = meters.filter(function (md) {
      return (!md.regrCoeffs || !md.r2 || md.r2 === '—') && md.blMonths && md.blMonths.length;
    });
    // Skip buildings with no regression data AND no baseline months at all
    if (!metersWithCoeffs.length && !metersWithBlOnly.length) return;

    var bldgHeaderHTML =
      '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin:10px 0 4px">' +
      (b.name || 'Building') +
      '</div>';
    var isFirstBlockForBuilding = true;

    metersWithCoeffs.forEach(function (md) {
      var rc = md.regrCoeffs;
      var unit = md.commodity === 'Electric' ? 'kWh' : md.commodity === 'Gas' ? 'Therms' : 'Gal';

      // Regression equation display
      var eqn = 'Usage = ' + rc.intercept.toFixed(4) + ' × Days';
      if (rc.type === 'dual') {
        eqn += ' + ' + rc.slopeHDD.toFixed(4) + ' × HDD + ' + rc.slopeCDD.toFixed(4) + ' × CDD';
      } else if (rc.type === 'hdd') {
        eqn += ' + ' + rc.slope.toFixed(4) + ' × HDD';
      } else {
        eqn += ' + ' + rc.slope.toFixed(4) + ' × CDD';
      }

      var meterBlockHTML =
        '<div style="margin:6px 0 4px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text)">' +
        md.commodity +
        ' — ' +
        md.regrType +
        ' (R² = ' +
        md.r2 +
        ')</div>' +
        '<div style="font-family:var(--rpt-mono);font-size:10px;background:var(--rpt-code-bg);border:1px solid var(--rpt-code-border);border-radius:3px;padding:4px 8px;margin:2px 0 6px;color:var(--rpt-code-text)">' +
        eqn +
        '</div>' +
        '</div>';

      // Get monthly data for this commodity (reporting-period months)
      var monthly = [];
      if (md.commodity === 'Electric') monthly = (b.electric && b.electric.monthly) || [];
      else if (md.commodity === 'Gas') monthly = (b.gas && b.gas.monthly) || [];
      else if (md.commodity === 'Propane') monthly = (b.propane && b.propane.monthly) || [];

      // Build combined list: baseline months first, then reporting-period months
      var blMonthsForMeter = md.blMonths || [];
      var reportMonthYMs = monthly.map(function (mo) {
        return mo.month;
      });

      // Build combined entries: {ym, isBaseline, moData (may be null for BL rows)}
      var combined = [];
      blMonthsForMeter.forEach(function (ym) {
        combined.push({ ym: ym, isBaseline: true, moData: null });
      });
      monthly.forEach(function (mo) {
        combined.push({ ym: mo.month, isBaseline: false, moData: mo });
      });

      if (!combined.length) return;

      var rows = '';
      var totBl = 0,
        totCur = 0,
        totSav = 0;
      combined.forEach(function (entry) {
        var ym = entry.ym || '';
        var moIdx = ym ? parseInt(ym.split('-')[1], 10) - 1 : -1;
        var moName = moIdx >= 0 ? MO_FULL[moIdx] : ym;
        var days = ym ? _daysInMonth(ym) : 30;
        var wx = wxByYm[ym] || {};

        var hdd, cdd;
        if (entry.isBaseline) {
          // For baseline months, use the baseline weather values
          hdd = wx.hddBl || 0;
          cdd = wx.cddBl || 0;
        } else {
          hdd = wx.hddCur || 0;
          cdd = wx.cddCur || 0;
        }

        // Compute predicted baseline from regression
        var predicted = rc.intercept * days;
        if (rc.type === 'dual') {
          predicted += rc.slopeHDD * hdd + rc.slopeCDD * cdd;
        } else if (rc.type === 'hdd') {
          predicted += rc.slope * hdd;
        } else {
          predicted += rc.slope * cdd;
        }
        predicted = Math.max(0, predicted);

        // Show formula breakdown
        var formulaParts = rc.intercept.toFixed(2) + '×' + days;
        if (rc.type === 'dual') {
          formulaParts +=
            ' + ' +
            rc.slopeHDD.toFixed(2) +
            '×' +
            Math.round(hdd) +
            ' + ' +
            rc.slopeCDD.toFixed(2) +
            '×' +
            Math.round(cdd);
        } else if (rc.type === 'hdd') {
          formulaParts += ' + ' + rc.slope.toFixed(2) + '×' + Math.round(hdd);
        } else {
          formulaParts += ' + ' + rc.slope.toFixed(2) + '×' + Math.round(cdd);
        }

        if (entry.isBaseline) {
          // Baseline reference row — show predicted only, mark Actual/Saved as BL reference
          totBl += predicted;
          rows +=
            '<tr style="background:var(--rpt-chart-bg);color:var(--rpt-page-text)">' +
            '<td>' +
            moName +
            ' <span style="font-size:8px;font-weight:700;color:var(--rpt-page-text);background:var(--rpt-progress-bg);border-radius:2px;padding:0 3px">BL</span>' +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
            days +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
            Math.round(hdd).toLocaleString() +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
            Math.round(cdd).toLocaleString() +
            '</td>' +
            '<td style="font-family:monospace;font-size:9px;color:var(--rpt-page-text);overflow-wrap:break-word;word-break:break-all">' +
            formulaParts +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
            $n(predicted) +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
            '</tr>';
        } else {
          var actual = (entry.moData && entry.moData.cur) || 0;
          var saved = predicted - actual;
          totCur += actual;
          totSav += saved;

          rows +=
            '<tr>' +
            '<td>' +
            moName +
            '</td>' +
            '<td class="rpt-n">' +
            days +
            '</td>' +
            '<td class="rpt-n">' +
            Math.round(hdd).toLocaleString() +
            '</td>' +
            '<td class="rpt-n">' +
            Math.round(cdd).toLocaleString() +
            '</td>' +
            '<td style="font-family:monospace;font-size:9px;color:var(--rpt-page-text);overflow-wrap:break-word;word-break:break-all">' +
            formulaParts +
            '</td>' +
            '<td class="rpt-n" style="font-weight:600">' +
            $n(predicted) +
            '</td>' +
            '<td class="rpt-n">' +
            $n(actual) +
            '</td>' +
            '<td class="rpt-n" style="color:' +
            (saved >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)') +
            ';font-weight:600">' +
            $n(saved) +
            '</td>' +
            '</tr>';
        }
      });

      rows +=
        '<tr class="rpt-tot">' +
        '<td>Total</td><td></td><td></td><td></td><td></td>' +
        '<td class="rpt-n">' +
        $n(totBl) +
        '</td>' +
        '<td class="rpt-n">' +
        $n(totCur) +
        '</td>' +
        '<td class="rpt-n" style="color:' +
        (totSav >= 0 ? 'var(--rpt-green-dark)' : 'var(--rpt-red)') +
        '">' +
        $n(totSav) +
        '</td>' +
        '</tr>';

      meterBlockHTML +=
        '<table class="rpt-table rpt-table-wrap" style="font-size:9px;margin-bottom:10px;table-layout:fixed;width:100%">' +
        '<thead><tr>' +
        '<th>Month</th><th class="rpt-n">Days</th><th class="rpt-n">HDD</th><th class="rpt-n">CDD</th>' +
        '<th style="width:180px">Calculation</th>' +
        '<th class="rpt-n">Predicted<br>Baseline ' +
        unit +
        '</th><th class="rpt-n">Actual<br>' +
        unit +
        '</th>' +
        '<th class="rpt-n">' +
        unit +
        '<br>Saved</th>' +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table>';

      // estH: eqn block (~48px) + table thead (~36px, header text wraps to 2 lines on several
      // columns) + one row per combined month (~24px — DOM-measured: 9px font * 1.5 inherited
      // line-height + 8px vertical padding + ~2px border ≈ 23.5px, the original 16px estimate
      // undercounted every row and compounded into a real overflow on stress-tested pages) +
      // totals row (~24px) + table margin-bottom (~10px) + safety margin; building-name header
      // (~24px) added only for the first block per building.
      var meterEstH = 48 + 36 + (combined.length + 1) * 24 + 10 + 14;
      var tokenHTML = meterBlockHTML;
      if (isFirstBlockForBuilding) {
        tokenHTML = bldgHeaderHTML + tokenHTML;
        meterEstH += 24;
        isFirstBlockForBuilding = false;
      }
      meterTokens.push({ type: 'block', html: tokenHTML, estH: meterEstH });
    });

    // Render baseline-only meters (have blMonths but no regression coefficients)
    metersWithBlOnly.forEach(function (md) {
      var unit = md.commodity === 'Electric' ? 'kWh' : md.commodity === 'Gas' ? 'Therms' : 'Gal';
      var blMonthsForMeter = md.blMonths || [];
      if (!blMonthsForMeter.length) return;

      var blOnlyBlockHTML =
        '<div style="margin:6px 0 4px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text)">' +
        md.commodity +
        ' — Baseline Data (no regression model)</div>' +
        '</div>';

      var rows = '';
      blMonthsForMeter.forEach(function (ym) {
        var moIdx = ym ? parseInt(ym.split('-')[1], 10) - 1 : -1;
        var moName = moIdx >= 0 ? MO_FULL[moIdx] : ym;
        var days = ym ? _daysInMonth(ym) : 30;
        var wx = wxByYm[ym] || {};
        rows +=
          '<tr style="background:var(--rpt-chart-bg);color:var(--rpt-page-text)">' +
          '<td>' +
          moName +
          ' <span style="font-size:8px;font-weight:700;color:var(--rpt-page-text);background:var(--rpt-progress-bg);border-radius:2px;padding:0 3px">BL</span>' +
          '</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          days +
          '</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          Math.round(wx.hddBl || 0).toLocaleString() +
          '</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          Math.round(wx.cddBl || 0).toLocaleString() +
          '</td>' +
          '<td style="font-size:9px;color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '</tr>';
      });

      blOnlyBlockHTML +=
        '<table class="rpt-table" style="font-size:9px;margin-bottom:10px">' +
        '<thead><tr>' +
        '<th>Month</th><th class="rpt-n">Days</th><th class="rpt-n">HDD</th><th class="rpt-n">CDD</th>' +
        '<th>Calculation</th>' +
        '<th class="rpt-n">Predicted<br>Baseline ' +
        unit +
        '</th>' +
        '<th class="rpt-n">Actual<br>' +
        unit +
        '</th>' +
        '<th class="rpt-n">' +
        unit +
        '<br>Saved</th>' +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table>';

      // Same DOM-measured per-row correction as meterEstH above (24px/row, not 16px).
      var blOnlyEstH = 24 + 36 + blMonthsForMeter.length * 24 + 10 + 14;
      var blOnlyTokenHTML = blOnlyBlockHTML;
      if (isFirstBlockForBuilding) {
        blOnlyTokenHTML = bldgHeaderHTML + blOnlyTokenHTML;
        blOnlyEstH += 24;
        isFirstBlockForBuilding = false;
      }
      meterTokens.push({ type: 'block', html: blOnlyTokenHTML, estH: blOnlyEstH });
    });
  });

  var baselineHeadHTML =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Weather-normalized baseline calculations per building and commodity</div>' +
    regressionExplainer +
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.04em">Monthly Baseline Calculations</h3>';
  var baselineContHeadHTML =
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.04em">Monthly Baseline Calculations (cont.)</h3>';

  // BL_FIRST_CHROME: intro line (~20px) + regressionExplainer (~140px, 4 lines @ 11px/1.7
  // line-height + padding) + section heading (~28px) + safety margin. BL_CONT_CHROME:
  // continuation heading only + safety margin.
  var BL_FIRST_CHROME = 220;
  var BL_CONT_CHROME = 58;
  var _blBudgetFirst = _rptContentBudget('standard') - BL_FIRST_CHROME;
  var _blBudgetCont = _rptContentBudget('standard') - BL_CONT_CHROME;
  var blChunks = _rptPaginateTokens(meterTokens, _blBudgetFirst, _blBudgetCont);

  var resultPages = [];
  var currentPageNum = n;
  var pageTitle = 'Appendix ' + appLetter + ': Regression Model Methodology';

  if (blChunks.length === 0) {
    var emptyBody =
      baselineHeadHTML +
      '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No regression data available for calculation display.</p>';
    resultPages.push(
      rptPage(currentPageNum, pageTitle, emptyBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Appendix ' + appLetter,
      }),
    );
    return { html: resultPages.join(''), pageCount: resultPages.length };
  }

  blChunks.forEach(function (chunk, idx) {
    var isFirst = idx === 0;
    var chunkHTML = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var pageBody = (isFirst ? baselineHeadHTML : baselineContHeadHTML) + chunkHTML;
    resultPages.push(
      rptPage(currentPageNum, pageTitle + (isFirst ? '' : ' (cont.)'), pageBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Appendix ' + appLetter + (isFirst ? '' : ' (cont.)'),
      }),
    );
    currentPageNum++;
  });

  return { html: resultPages.join(''), pageCount: resultPages.length };
}

function rptPageAppendixWeather(n, d, appLetter) {
  appLetter = appLetter || 'C';
  var $p = function (v) {
    return (v || 0).toFixed(1) + '%';
  };
  var $n = function (v) {
    return Math.round(v || 0).toLocaleString();
  };

  var weatherMonthly = (d.weather && d.weather.monthly) || [];
  var tableRows = '';
  var totHddBl = 0,
    totHddCur = 0,
    totCddBl = 0,
    totCddCur = 0;
  var _wMoNames = [
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
  function _wFmtDate(ym) {
    if (!ym) return '—';
    var parts = ym.split('-');
    var mi = parseInt(parts[1], 10) - 1;
    return (_wMoNames[mi] || ym) + ' ' + parts[0];
  }

  weatherMonthly.forEach(function (mo) {
    var hddBl = mo.hddBl || 0;
    var hddCur = mo.hddCur || 0;
    var cddBl = mo.cddBl || 0;
    var cddCur = mo.cddCur || 0;
    var ip = mo.inPeriod;
    totHddBl += hddBl;
    if (ip) {
      totHddCur += hddCur;
      totCddBl += cddBl;
      totCddCur += cddCur;
    }
    var rowStyle = ip ? '' : 'color:var(--rpt-page-text);background:var(--rpt-chart-bg)';
    var hddVal = ip ? hddCur : hddBl;
    var cddVal = ip ? cddCur : cddBl;
    var badge = ip
      ? ''
      : ' <span style="font-size:8px;font-weight:700;color:var(--rpt-page-text);background:var(--rpt-progress-bg);border-radius:2px;padding:0 3px">BL</span>';
    tableRows +=
      '<tr style="' +
      rowStyle +
      '">' +
      '<td contenteditable="true">' +
      _wFmtDate(mo.month) +
      badge +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(hddVal) +
      '</td>' +
      '<td class="rpt-n" contenteditable="true">' +
      $n(cddVal) +
      '</td>' +
      '</tr>';
  });

  if (!tableRows) {
    tableRows =
      '<tr><td colspan="7" style="color:var(--rpt-page-text);font-style:italic">No weather data for this period. Enter HDD/CDD in project settings.</td></tr>';
  } else {
    var totHddVar = totHddBl > 0 ? ((totHddCur - totHddBl) / totHddBl) * 100 : 0;
    var totCddVar = totCddBl > 0 ? ((totCddCur - totCddBl) / totCddBl) * 100 : 0;
    tableRows +=
      '<tr class="rpt-tot">' +
      '<td>Baseline Period Avg</td>' +
      '<td class="rpt-n">' +
      $n(totHddBl) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCddBl) +
      '</td>' +
      '</tr>' +
      '<tr class="rpt-tot">' +
      '<td>Reporting Period Total</td>' +
      '<td class="rpt-n">' +
      $n(totHddCur) +
      '</td>' +
      '<td class="rpt-n">' +
      $n(totCddCur) +
      '</td>' +
      '</tr>' +
      '<tr class="rpt-tot">' +
      '<td>Variance</td>' +
      '<td class="rpt-n" style="' +
      (Math.abs(totHddVar) > 10 ? 'color:var(--rpt-variance);font-weight:600' : '') +
      '">' +
      $p(totHddVar) +
      '</td>' +
      '<td class="rpt-n" style="' +
      (Math.abs(totCddVar) > 10 ? 'color:var(--rpt-variance);font-weight:600' : '') +
      '">' +
      $p(totCddVar) +
      '</td>' +
      '</tr>';
  }

  var weatherTable =
    '<table class="rpt-table" contenteditable="true" style="font-size:12px">' +
    '<thead><tr>' +
    '<th>Month</th>' +
    '<th class="rpt-n">HDD</th>' +
    '<th class="rpt-n">CDD</th>' +
    '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table>';

  // Auto-generate narrative
  var hddNote = '',
    cddNote = '';
  var totHddVarFinal = totHddBl > 0 ? ((totHddCur - totHddBl) / totHddBl) * 100 : 0;
  var totCddVarFinal = totCddBl > 0 ? ((totCddCur - totCddBl) / totCddBl) * 100 : 0;
  if (Math.abs(totHddVarFinal) > 10) {
    var colder = totHddVarFinal > 0 ? 'colder' : 'warmer';
    hddNote =
      'The reporting period was ' +
      Math.abs(totHddVarFinal).toFixed(1) +
      '% ' +
      colder +
      ' than the baseline average, resulting in ' +
      (colder === 'colder' ? 'elevated heating demand.' : 'reduced heating demand.') +
      ' ';
  }
  if (Math.abs(totCddVarFinal) > 10) {
    var hotter = totCddVarFinal > 0 ? 'warmer' : 'cooler';
    cddNote =
      'Cooling degree days were ' +
      Math.abs(totCddVarFinal).toFixed(1) +
      '% ' +
      (totCddVarFinal > 0 ? 'above' : 'below') +
      ' baseline, indicating ' +
      (totCddVarFinal > 0 ? 'elevated cooling demand.' : 'reduced cooling demand.') +
      ' ';
  }
  var narrativeText =
    (hddNote ||
      cddNote ||
      'Weather conditions during the reporting period were within normal range of the baseline average. ') +
    'Weather-normalized savings figures reflect genuine performance improvements and are not attributable to weather effects. ' +
    'Balance point: 60°F per contract specification.';

  var narrativeBox =
    '<div contenteditable="true" style="padding:10px 12px;font-size:11px;line-height:1.7;color:var(--rpt-page-text);margin-top:10px">' +
    narrativeText +
    '</div>';

  var hddCddParagraph = '';
  if (d.weather) {
    var pHDD =
      d.weather.totals && d.weather.totals.hddCur ? Math.round(d.weather.totals.hddCur).toLocaleString() : '\u2014';
    var bHDD =
      d.weather.totals && d.weather.totals.hddBl ? Math.round(d.weather.totals.hddBl).toLocaleString() : '\u2014';
    var hddPctChg =
      d.weather.totals && d.weather.totals.hddBl > 0
        ? Math.round(((d.weather.totals.hddCur - d.weather.totals.hddBl) / d.weather.totals.hddBl) * 100)
        : 0;
    var pCDD =
      d.weather.totals && d.weather.totals.cddCur ? Math.round(d.weather.totals.cddCur).toLocaleString() : '\u2014';
    var bCDD =
      d.weather.totals && d.weather.totals.cddBl ? Math.round(d.weather.totals.cddBl).toLocaleString() : '\u2014';
    var cddPctChg =
      d.weather.totals && d.weather.totals.cddBl > 0
        ? Math.round(((d.weather.totals.cddCur - d.weather.totals.cddBl) / d.weather.totals.cddBl) * 100)
        : 0;
    hddCddParagraph =
      '<div contenteditable="true" style="margin-top:10px;font-size:11px;color:var(--rpt-page-text);line-height:1.7">' +
      'Heating degree days (HDD) for the period were ' +
      pHDD +
      ' vs. a baseline average of ' +
      bHDD +
      ' (' +
      (hddPctChg >= 0 ? '+' : '') +
      hddPctChg +
      '%). ' +
      'Cooling degree days (CDD) were ' +
      pCDD +
      ' vs. a baseline of ' +
      bCDD +
      ' (' +
      (cddPctChg >= 0 ? '+' : '') +
      cddPctChg +
      '%). ' +
      'Normalized savings figures account for weather variance using regression-based baseline adjustment.' +
      '</div>';
  }
  var bodyHTML =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px">Combined HDD and CDD — Base 60°F per contract</div>' +
    weatherTable +
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.04em">Weather Impact Summary</h3>' +
    narrativeBox +
    hddCddParagraph +
    '<div style="margin-top:16px;padding:10px 12px;font-size:11px;color:var(--rpt-page-text);line-height:1.5">' +
    '<div style="font-weight:700;font-size:11px;color:var(--rpt-page-text);margin-bottom:6px">What is a degree day?</div>' +
    '<div style="margin-bottom:6px">A degree day is a measure of relative heating and cooling energy required by buildings. It&#39;s calculated as the difference between the average daily temperature and the balance point temperature (60 degrees). When the average daily temperature is above the balance point, the result is cooling degree days; when below, the result is heating degree days.</div>' +
    '<div style="margin-bottom:6px"><strong>Example 1:</strong> Average daily temperature = 80. Balance point = 60. Cooling degree days = 20 CDD. (80-60=20)</div>' +
    '<div style="margin-bottom:6px"><strong>Example 2:</strong> Average daily temperature = 45. Balance point = 60. Heating degree days = 15 HDD. (60-45=15)</div>' +
    '<div style="margin-bottom:6px"><strong>Example 3:</strong> Average daily temperature = 60. Balance point = 60. No degree days.</div>' +
    '<div>You may ask, &quot;Why not use average temperature instead of degree days?&quot; The problem with average temperature is that highs and lows cancel each other out. A warm day (80 average temp) combined with a cold day (40 average temp) averages 60. So do two mild days of 59 and 61. But in the first case there are 20 CDD and 20 HDD while in the second there are 1 CDD and 1 HDD. The further the average temperature deviates from the balance point, the greater the energy needed to keep the building in a comfortable temperature range.</div>' +
    '</div>';

  return rptPage(n, 'Appendix ' + appLetter + ': Weather Data', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Appendix ' + appLetter,
  });
}

function rptPageAppendixBills(n, d, appLetter) {
  appLetter = appLetter || 'D';
  var $c = function (v) {
    return '$' + Math.abs(Math.round(v || 0)).toLocaleString();
  };

  var periodYMs = (d.period && d.period.yearMonths) || [];
  var monthNames = [
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

  function _fmtBillDate(dateStr) {
    if (!dateStr) return '—';
    var d2 = new Date(dateStr + 'T00:00:00');
    if (isNaN(d2)) return dateStr;
    return d2.getMonth() + 1 + '/' + d2.getDate() + '/' + d2.getFullYear();
  }

  // Build bill index per month from rawBills collected in collectReportData
  var billsByMonth = {};
  periodYMs.forEach(function (ym) {
    billsByMonth[ym] = [];
  });
  (d.rawBills || []).forEach(function (bill) {
    var ym = normMonth(bill.start, bill.end, true, d.rawBills || []) || (bill.start ? bill.start.substring(0, 7) : '');
    if (billsByMonth[ym]) {
      billsByMonth[ym].push(bill);
    }
  });

  // fix/report-content-pagination (2026-07-28): this used to concatenate every reporting-period
  // month's bill table (each potentially listing every building's bills for that month, up to
  // JOCO's 26 buildings) PLUS every scanned bill PDF thumbnail into a single string handed to
  // ONE rptPage() call — overflowing .rpt-body with zero pagination. Tokenizing per MONTH (one
  // token = one month's whole table) was tried first and measured (headless, stress-tested at
  // 4x building count) to still let a single heavy month's table blow through a page by itself,
  // since _rptPaginateTokens can't split a single token. Tokenizing per BILL ROW instead lets a
  // month's table split across as many pages as it needs — the month label + table thead simply
  // repeat (via _billsGroupRowsByMonth below) on whichever page(s) that month's rows land on,
  // the same "repeat the header on every page it appears on" convention every other multi-page
  // table in this file already uses (rptPageASHRAE36Building, rptPageASHRAE36SetpointReview,
  // etc.). Each bill-image thumbnail is its own token; the old flex-wrap container (which can't
  // be split across pages) is gone — thumbnails are individually inline-block, so they wrap the
  // same way across however many image tokens land on a page without needing a shared parent.
  var THEAD_HTML =
    '<thead><tr>' +
    '<th>Building</th><th>Commodity</th><th>Provider</th><th class="rpt-n">kWh</th><th class="rpt-n">kW</th><th class="rpt-n">Therms</th><th class="rpt-n">Gallons</th><th class="rpt-n">Cost</th><th>Bill Date</th>' +
    '</tr></thead>';
  var billRowTokens = [];
  if (!periodYMs.length) {
    billRowTokens.push({
      type: 'block',
      html: '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No reporting period months configured.</p>',
      estH: 20,
      moLabel: null,
    });
  } else {
    periodYMs.forEach(function (ym) {
      var parts = ym.split('-');
      var moLabel = monthNames[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
      var bills = billsByMonth[ym] || [];
      // _billsGroupRowsByMonth re-emits a month label (~20px) + fresh table thead (~26px) at
      // the START of every run of same-month rows within a page — including a page that starts
      // mid-month after a page break. _rptPaginateTokens can't know in advance where a break
      // will land, so this overhead is budgeted onto EVERY month's first row token (the one
      // case guaranteed to need it); a mid-month split pays this same real cost again on its
      // continuation page, which is why per-row estH also carries its own safety margin above
      // the bare measured row height.
      var GROUP_HEADER_OVERHEAD = 46; // month label (~20px) + table thead (~26px)
      if (!bills.length) {
        billRowTokens.push({
          type: 'row',
          moLabel: moLabel,
          estH: 22 + GROUP_HEADER_OVERHEAD,
          html: '<tr><td colspan="9" style="color:var(--rpt-page-text);font-style:italic">No bills recorded for this month</td></tr>',
        });
        return;
      }
      bills.forEach(function (bill, billIdx) {
        var _kwh = bill.kwh || bill.kwhUsage || 0;
        var _kw = bill.kw || bill.kwDemand || 0;
        var _therms = bill.therms || 0;
        var _gal = bill.gallons || bill.propaneGal || 0;
        var rowHTML =
          '<tr>' +
          '<td contenteditable="true">' +
          bill.building +
          '</td>' +
          '<td contenteditable="true">' +
          bill.commodity +
          '</td>' +
          '<td contenteditable="true">' +
          (bill.provider || '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (_kwh ? Math.round(_kwh).toLocaleString() : '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (_kw ? Math.round(_kw).toLocaleString() : '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (_therms ? Math.round(_therms).toLocaleString() : '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (_gal ? Math.round(_gal).toLocaleString() : '—') +
          '</td>' +
          '<td class="rpt-n" contenteditable="true">' +
          (bill.amount ? $c(bill.amount) : '—') +
          '</td>' +
          '<td contenteditable="true">' +
          _fmtBillDate(bill.billDate || bill.start) +
          '</td>' +
          '</tr>';
        // estH: one table row (~22px, conservative for 10px-font table rows with padding) + a
        // slice of safety margin so many small per-row estimates don't compound into a real
        // underestimate across a long month; the FIRST row of each month also carries that
        // month's group-header overhead (see GROUP_HEADER_OVERHEAD above).
        billRowTokens.push({
          type: 'row',
          moLabel: moLabel,
          estH: 24 + (billIdx === 0 ? GROUP_HEADER_OVERHEAD : 0),
          html: rowHTML,
        });
      });
    });
  }

  var allBillImages = [];
  (d.rawBills || []).forEach(function (bill) {
    if (!bill.pdfImage) return;
    var ym = normMonth(bill.start, bill.end, true, d.rawBills || []) || (bill.start ? bill.start.substring(0, 7) : '');
    var parts = ym ? ym.split('-') : null;
    var moLabel = parts && parts.length === 2 ? monthNames[parseInt(parts[1], 10) - 1] + ' ' + parts[0] : '';
    allBillImages.push(
      '<div style="display:inline-block;margin:4px 6px 4px 0;border:1px solid var(--rpt-divider);border-radius:3px;overflow:hidden"><img src="' +
        bill.pdfImage +
        '" style="height:120px;width:auto;display:block"><div style="font-size:9px;color:var(--rpt-page-text);padding:2px 4px;background:var(--rpt-chart-bg);text-align:center">' +
        bill.building +
        ' · ' +
        bill.commodity +
        ' · ' +
        moLabel +
        '</div></div>',
    );
  });

  // _billsGroupRowsByMonth — given ONE page's worth of row tokens (already-paginated, in order),
  // groups consecutive same-month rows and wraps each group in its own month label + <table>
  // (thead repeated per group so every page's table is independently valid/complete HTML — the
  // same "reopen the table on every page" convention as this file's other multi-page tables).
  // Non-'row' tokens (the no-months-configured placeholder <p>, or bill-image tokens which are
  // paginated separately and never passed here) pass through unchanged.
  function _billsGroupRowsByMonth(tokens) {
    var out = '';
    var i = 0;
    while (i < tokens.length) {
      var tok = tokens[i];
      if (tok.type !== 'row') {
        out += tok.html;
        i++;
        continue;
      }
      var moLabel = tok.moLabel;
      var groupRows = '';
      while (i < tokens.length && tokens[i].type === 'row' && tokens[i].moLabel === moLabel) {
        groupRows += tokens[i].html;
        i++;
      }
      out +=
        '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin:10px 0 4px">' +
        moLabel +
        '</div>' +
        '<table class="rpt-table" style="font-size:10px;margin-bottom:6px">' +
        THEAD_HTML +
        '<tbody>' +
        groupRows +
        '</tbody></table>';
    }
    return out;
  }

  var _hasBillImages = allBillImages.length > 0;
  var imageTokens = [];
  if (_hasBillImages) {
    imageTokens.push({
      type: 'cat',
      html: '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin:16px 0 6px;border-top:1px solid var(--rpt-divider);padding-top:10px">Scanned Bill Images</div>',
      estH: 30,
    });
    allBillImages.forEach(function (imgHTML) {
      // estH: thumbnail (120px) + caption line (~14px) + border/margin (~10px) + safety.
      imageTokens.push({ type: 'block', html: imgHTML, estH: 150 });
    });
  }
  var footerNote =
    '<div style="margin-top:12px;font-size:10px;color:var(--rpt-page-text);font-style:italic;border-top:1px solid var(--rpt-divider);padding-top:6px">' +
    (_hasBillImages
      ? 'Bill thumbnails shown above are rendered from stored PDF files.'
      : 'No scanned bill images available. Upload PDFs in the Energy Department to include bill images in future reports.') +
    '</div>';

  var billsIntroHTML =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px">Original utility bill PDFs for the reporting period</div>';

  // BILLS_FIRST_CHROME: intro line (~20px) + safety margin. BILLS_CONT_CHROME: safety margin
  // only (continuation pages carry no extra heading — month/image tokens speak for themselves).
  var BILLS_FIRST_CHROME = 40;
  var BILLS_CONT_CHROME = 20;
  var _billsBudgetFirst = _rptContentBudget('standard') - BILLS_FIRST_CHROME;
  var _billsBudgetCont = _rptContentBudget('standard') - BILLS_CONT_CHROME;
  var billsChunks = _rptPaginateTokens(billRowTokens.concat(imageTokens), _billsBudgetFirst, _billsBudgetCont);

  var resultPages = [];
  var currentPageNum = n;
  var pageTitle = 'Appendix ' + appLetter + ': Utility Bills';

  billsChunks.forEach(function (chunk, idx) {
    var isFirst = idx === 0;
    var isLast = idx === billsChunks.length - 1;
    var chunkHTML = _billsGroupRowsByMonth(chunk);
    var pageBody = (isFirst ? billsIntroHTML : '') + chunkHTML + (isLast ? footerNote : '');
    resultPages.push(
      rptPage(currentPageNum, pageTitle + (isFirst ? '' : ' (cont.)'), pageBody, {
        data: d,
        label: 'Page ' + currentPageNum + ' — Appendix ' + appLetter + (isFirst ? '' : ' (cont.)'),
      }),
    );
    currentPageNum++;
  });

  return { html: resultPages.join(''), pageCount: resultPages.length };
}

function saveReportToHistory() {
  const pagesHTML = document.getElementById('reportPages').innerHTML;
  const data = window._currentReportData;
  if (!data || !pagesHTML) {
    showToast('No report to save');
    return;
  }

  const history = DB.get('en_report_history', []);
  const cleanHTML = pagesHTML.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');
  // ASHRAE reports have no .period; use the report type label instead
  const periodLabel = data._ashrae ? data._ashrae.title : (data.period && data.period.label) || '';
  const periodType = data._ashrae ? data._ashrae.type : (data.period && data.period.type) || '';
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId: String(data.project.id),
    projectName: data.project.client || data.project.name,
    period: periodLabel,
    type: periodType,
    savedAt: new Date().toISOString(),
    html: cleanHTML,
  };
  history.unshift(entry);
  // Cap to 3 reports (IndexedDB has no size constraint like localStorage, but keep history manageable)
  while (history.length > 3) history.pop();
  DB.set('en_report_history', history);
  showToast('Report saved to history ?');
}

function openReportHistory(projId) {
  const history = DB.get('en_report_history', []);
  const filtered = projId ? history.filter((h) => String(h.projectId) === String(projId)) : history;
  const list = document.getElementById('reportHistoryList');

  if (!filtered.length) {
    list.innerHTML =
      '<div style="text-align:center;padding:24px;color:var(--text3)">No saved reports yet. Generate a report and click Save to store it here.</div>';
  } else {
    list.innerHTML = filtered
      .map((entry) => {
        const date = new Date(entry.savedAt);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;background:var(--s2);margin-bottom:6px">
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--text)">${entry.period} ${entry.type === 'quarterly' ? 'Quarterly' : 'Annual'}</div>
                <div style="font-size:11px;color:var(--text3)">${entry.projectName} • Saved ${dateStr} ${timeStr}</div>
              </div>
              <div style="display:flex;gap:6px">
                <button onclick="reopenReport('${entry.id}')" style="padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--s3);background:var(--s1);color:var(--text);cursor:pointer">Open</button>
                <button onclick="reexportReport('${entry.id}')" style="padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--s3);background:var(--s1);color:var(--text);cursor:pointer">Export PDF</button>
                <button onclick="deleteReport('${entry.id}')" style="padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--s3);background:var(--s1);color:var(--text3);cursor:pointer">✕</button>
              </div>
            </div>`;
      })
      .join('');
  }

  document.getElementById('reportHistoryModal').style.display = 'flex';
}

function reopenReport(entryId) {
  const history = DB.get('en_report_history', []);
  const entry = history.find((h) => h.id === entryId);
  if (!entry) {
    showToast('Report not found');
    return;
  }

  document.getElementById('reportHistoryModal').style.display = 'none';
  showReportOverlay(entry.html, `${entry.projectName} — ${entry.period} (saved)`);
}

async function reexportReport(entryId) {
  const history = DB.get('en_report_history', []);
  const entry = history.find((h) => h.id === entryId);
  if (!entry) {
    showToast('Report not found');
    return;
  }

  document.getElementById('reportHistoryModal').style.display = 'none';
  showReportOverlay(entry.html, 'Exporting...');

  await new Promise((r) => setTimeout(r, 500));
  await exportReportToPDF();
}

function deleteReport(entryId) {
  if (!confirm('Delete this saved report?')) return;
  let history = DB.get('en_report_history', []);
  history = history.filter((h) => h.id !== entryId);
  DB.set('en_report_history', history);
  openReportHistory();
  showToast('Report deleted');
}

/**
 * exportReportToPDF — 2026-07-22 rewrite (fix/report-not-copyable). Matt: "The PDF is still
 * not copyable like I would like."
 *
 * OLD BEHAVIOR: rasterized each `#reportPages .rpt-page` into a JPEG via html2canvas, then
 * placed those images into a jsPDF document. The resulting PDF contained zero real text —
 * every character was baked into a bitmap, so nothing was selectable, copyable, or
 * searchable, regardless of how good it looked.
 *
 * NEW BEHAVIOR: uses the browser's own native print-to-PDF path (window.print(), same
 * mechanism as the "🖨 Print" button on the BAS scorecard — see app/scorecard.js). The
 * `@media print` rules added alongside `#report-styles` in energy-department.html scope
 * printing to just the open report overlay, strip the dark preview chrome, and turn each
 * `.rpt-page` into its own physical page via `break-after: page`. Choosing "Save as PDF" as
 * the destination in the print dialog produces a genuinely text-based PDF straight from the
 * live DOM — every heading/paragraph/table cell is real selectable/searchable text, and the
 * inline-SVG bar charts render as real vector paths instead of a raster image. This covers
 * every report type `#reportPages` renders (Audit Report, Service Proposal, quarterly/annual
 * Savings Report) since they all share the same `.rpt-page` markup.
 *
 * TRADEOFF (accepted per task spec): the user now sees the browser's print dialog and must
 * choose "Save as PDF" instead of getting an instant silent download. This is a completely
 * standard, universally-understood flow, so the button keeps its existing "Export to PDF"
 * label — the outcome (a PDF of this report) is unchanged, only the interaction is.
 *
 * `document.title` is temporarily set to the same filename the old jsPDF path used (minus
 * extension) so Chrome's "Save as PDF" dialog suggests the same filename by default.
 */
async function exportReportToPDF() {
  const data = window._currentReportData;
  if (!data) {
    showToast('No report data available');
    return;
  }

  const pages = document.querySelectorAll('#reportPages .rpt-page');
  if (!pages.length) {
    showToast('No report pages to export');
    return;
  }

  // Force ALL proposal-tier "Install & Programming Detail" panels open before printing
  // (fix/proposal-tier-option-chooser, 2026-07-19). Nothing in the printed output is
  // interactive — so whichever tier(s) the user had collapsed in the live preview must still
  // render fully expanded. State is restored below so the interactive preview is unaffected.
  const tierDetailPanels = document.querySelectorAll('#reportPages [id^="rpt-tier-detail-"]');
  const tierDetailPriorDisplay = [];
  tierDetailPanels.forEach((panel) => {
    tierDetailPriorDisplay.push(panel.style.display);
    panel.style.display = 'block';
  });

  // Same filename convention the old jsPDF path used, minus the extension — used only to
  // seed the browser's "Save as PDF" filename suggestion via document.title.
  const client = data.project.client || data.project.name || 'Report';
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  let filename;
  if (data._agreement) {
    filename = client + ' - Energy Management Services Agreement ' + dateStr;
  } else if (data._ashrae) {
    filename =
      data._ashrae.type === 'proposal'
        ? client + ' - Service Proposal ' + dateStr
        : client + ' - ASHRAE 36 Audit Report ' + dateStr;
  } else {
    const typeLabel = data.period && data.period.type === 'quarterly' ? 'Quarterly' : 'Annual';
    filename = client + ' - ' + typeLabel + ' Savings Report ' + dateStr;
  }
  const originalTitle = document.title;
  document.title = filename;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    tierDetailPanels.forEach((panel, i) => {
      panel.style.display = tierDetailPriorDisplay[i];
    });
    document.title = originalTitle;
    window.removeEventListener('afterprint', restore);
  };

  // afterprint covers browsers/OSes where window.print() returns before the dialog closes;
  // the direct call below covers the common desktop case where it blocks until dismissed.
  // `restored` guards against double-restore when both fire.
  window.addEventListener('afterprint', restore);

  showToast('Opening print dialog — choose "Save as PDF" to export this report');

  try {
    window.print();
  } finally {
    restore();
  }
}

/**
 * _buildReportCssVarResolver — returns a `resolve(text)` function that replaces
 * `var(--rpt-*)` references with their literal values, for use before handing markup to
 * Microsoft Word's HTML renderer.
 *
 * WHY: Word's document-open HTML engine (used by the .doc/HTML export below) does not
 * reliably resolve CSS custom properties. The `#report-styles` block defines every report
 * color/font as a `:root { --rpt-*: ... }` token (by design — see the comment at the top of
 * that block: "Never hardcode hex values in report CSS or JS templates"), so without this
 * resolution step, headings/table borders/status colors would silently fall back to black
 * in the exported Word doc even though the same tokens render correctly in the live
 * browser preview and in the html2canvas PDF path (which rasterizes computed styles, so it
 * never had this problem).
 *
 * IMPORTANT: `var(--rpt-*)` references appear in two places — the `#report-styles`
 * stylesheet AND countless inline `style="..."` attributes generated directly in report
 * page markup (e.g. buildBarChart() above passes color strings like
 * `'var(--rpt-elec-bl)'` straight into an inline `background:` style). The returned
 * `resolve()` function must be applied to BOTH the extracted CSS text and the page body
 * HTML — resolving only the stylesheet leaves every inline-styled bar chart element
 * unresolved.
 *
 * Handles one level of var-of-var chaining (e.g. `--rpt-table-td-border: var(--rpt-border);`)
 * via a short fixed-point loop over the token map itself before returning the resolver.
 */
function _buildReportCssVarResolver(cssText) {
  var vars = {};
  var varDefRe = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  var m;
  while ((m = varDefRe.exec(cssText))) {
    vars[m[1]] = m[2].trim();
  }
  var varRefRe = /var\(\s*--([a-zA-Z0-9-]+)\s*(?:,\s*([^)]+))?\)/g;
  function resolveOnce(val) {
    return val.replace(varRefRe, function (whole, name, fallback) {
      if (vars[name] !== undefined) return vars[name];
      return fallback !== undefined ? fallback.trim() : whole;
    });
  }
  for (var pass = 0; pass < 3; pass++) {
    var changed = false;
    Object.keys(vars).forEach(function (k) {
      var resolved = resolveOnce(vars[k]);
      if (resolved !== vars[k]) {
        vars[k] = resolved;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return resolveOnce;
}

/**
 * exportReportToWord — additional export option alongside exportReportToPDF() (does not
 * replace it). Produces a genuinely editable Microsoft Word document from the exact same
 * `#reportPages .rpt-page` markup the PDF export captures, instead of a flattened
 * html2canvas raster image.
 *
 * TECHNIQUE (client-side only, no library, no server, no paid API — matches this site's
 * static/no-build-step architecture): Word recognizes an HTML document saved with a .doc
 * extension and an `application/msword` MIME type, and opens it as a native editable
 * document (real paragraphs/headings/tables), not an embedded image. This is the
 * well-known "HTML-to-.doc" wrapper technique — no OOXML/.docx generation library needed.
 * Reference: the `mso-application` / `xmlns:w="urn:schemas-microsoft-com:office:word"`
 * namespace + `<!--[if gte mso 9]>` WordDocument directive below is what tells Word's
 * document-open path to render the file as a Word document rather than a generic web page.
 *
 * Report pages here are pure HTML/CSS (div/table based bar charts — see buildBarChart()
 * above — no <canvas> elements), so there is nothing that would only exist as a rasterized
 * image; every heading/paragraph/table cell becomes a real editable Word element on open.
 * Any embedded bill-image thumbnails (data-URL <img> tags) remain images, same as they
 * would in any Word document containing a picture.
 *
 * Fidelity note: Word's HTML engine does not support flexbox, so div-based bar-chart
 * layouts inside report pages may not render with pixel-perfect alignment in Word (same
 * caveat applies to any flex-based layout). This is an accepted tradeoff per the task
 * spec — the goal is genuinely editable content matching the underlying HTML, not
 * PDF-identical visual fidelity.
 */
async function exportReportToWord() {
  const data = window._currentReportData;
  if (!data) {
    showToast('No report data available');
    return;
  }

  const pagesContainer = document.getElementById('reportPages');
  const pages = pagesContainer ? pagesContainer.querySelectorAll('.rpt-page') : [];
  if (!pages.length) {
    showToast('No report pages to export');
    return;
  }

  const toolbar = document.querySelector('.report-toolbar');
  const wordBtn = toolbar ? toolbar.querySelector('[onclick*="exportReportToWord"]') : null;
  const originalBtnText = wordBtn ? wordBtn.textContent : '';
  if (wordBtn) {
    wordBtn.disabled = true;
    wordBtn.textContent = '⏳ Generating...';
  }

  showToast('Generating Word document...');

  // Same tier-detail force-expand as exportReportToPDF() (see comment above that function):
  // whichever tier(s) the user had collapsed in the live preview must still render fully
  // expanded in the exported document. Restored in `finally`.
  const tierDetailPanels = document.querySelectorAll('#reportPages [id^="rpt-tier-detail-"]');
  const tierDetailPriorDisplay = [];
  tierDetailPanels.forEach((panel) => {
    tierDetailPriorDisplay.push(panel.style.display);
    panel.style.display = 'block';
  });

  try {
    const reportStylesEl = document.getElementById('report-styles');
    const rawCss = reportStylesEl ? reportStylesEl.textContent : '';
    // Word position:static fix (2026-07-30, fix/word-export-indentation — Matt: "I don't see
    // the indentations or spacing I asked for", backlog 4c946ba2). `.rpt-int-hdr`/
    // `.rpt-small-hdr`/`.rpt-body` are `position:absolute` (`.rpt-int-hdr` also `display:flex`)
    // in the live/screen-preview CSS (feature/report-layer-isolation-and-theme, 2026-07-28).
    // Measured via a real Word COM round-trip (SaveAs2 -> ExportAsFixedFormat -> PyMuPDF): the
    // `margin-left:0.5in` that `_insetChildren` below already writes onto every `.rpt-int-hdr`/
    // `.rpt-body` direct child renders at 0pt, not 36pt, in Word — Word's HTML importer does not
    // apply a child's margin inside a `position:absolute` parent. The ONLY place this already
    // gets converted back to `position:static` for correct flow behavior is the `@media print`
    // block (`#report-print-overrides` below, energy-department.html) — written for the
    // browser's native print-to-PDF path and never previously read by this function (it only
    // ever read `#report-styles`, a separate, earlier-closing `<style>` tag). Rather than
    // hand-retype a second copy of the same override — exactly the shape of divergent-copy bug
    // that produced this defect — pull the two rule blocks this needs directly out of that
    // canonical print stylesheet text and fold them into the CSS handed to Word, so any future
    // edit to the print override is automatically picked up here too. `!important` is stripped:
    // nothing else in the exported doc conflicts with these two selectors, so it isn't needed.
    const printOverridesEl = document.getElementById('report-print-overrides');
    const printCssText = printOverridesEl ? printOverridesEl.textContent : '';
    const _grabRuleBlock = (cssText, startMarker) => {
      const start = cssText.indexOf(startMarker);
      if (start === -1) return '';
      const braceOpen = cssText.indexOf('{', start);
      const braceClose = braceOpen === -1 ? -1 : cssText.indexOf('}', braceOpen);
      if (braceOpen === -1 || braceClose === -1) return '';
      return cssText.slice(start, braceClose + 1).replace(/!important/g, '');
    };
    // `.rpt-small-hdr` is deliberately EXCLUDED from this extraction even though the print
    // stylesheet groups it with `.rpt-int-hdr` in one comma-selector rule. Measured (Word COM
    // round-trip, Agreement page 1): including it shifted the whole page's content up by ~44pt —
    // `.rpt-small-hdr` holds only the inset letterhead `<img>` (no text needing an inset at all),
    // and switching it to `position:static; height:auto` let Word's flow-layout size it from the
    // image's own rendered height instead of the fixed `--rpt-small-hdr-h` (195px) reservation
    // `.rpt-body.rpt-body-small-hdr`'s `top` offset assumes, desyncing the two. The letterhead
    // image sizing was just fixed in d493b8d (this branch's parent commit) and is out of scope
    // here — stripping `.rpt-small-hdr` from the shared selector text (keeping the identical
    // `position:static/height:auto` declaration body for `.rpt-int-hdr` alone, which DOES have
    // text content needing the inset) avoids touching it.
    const printIndentCss =
      _grabRuleBlock(printCssText, '.rpt-int-hdr,').replace(/,\s*\.rpt-small-hdr/, '') +
      ' ' +
      _grabRuleBlock(printCssText, '.rpt-body {');
    const rawCssWithIndentFix = rawCss + ' ' + printIndentCss;
    const resolveVars = _buildReportCssVarResolver(rawCssWithIndentFix);
    // Word text-inset fix (2026-07-26, measured via rendered PDF: body text ran edge-to-edge
    // to both page edges in Word even though the live/PDF path's `padding: 12px 48px 30px`
    // (.rpt-body) / `padding:4px 48px 2px` (report-page-function inline wrappers) etc. all
    // already carry the intended 48px = 0.5in horizontal inset. Word's HTML-import CSS engine
    // does not reliably honor `px` as a padding unit (browsers treat px as an absolute length;
    // Word's importer maps padding to WordprocessingML twips and, measured, silently drops
    // unrecognized-unit padding rather than approximating it — the same reason @page Section1
    // above is expressed in `in` rather than `px`). Every "48px" token in this report's CSS/
    // inline styles means exactly this one convention (verified: .rpt-body/.rpt-int-hdr/
    // .rpt-footer-text page-chrome padding and every ASHRAE 36 Proposal page's inline content
    // wrapper — no unrelated 48px usage exists in #report-styles or in report-page markup), so
    // converting that one token to its exact equivalent `0.5in` is a safe, narrow fix — same
    // "generated markup, not user input" reasoning as the csc-header-img regex below. Graphics
    // stay full-bleed: @page margin remains 0in and this only touches padding on text
    // containers, never image sizing.
    const _fixPaddingUnits = (str) => str.replace(/(padding\s*:\s*[^;"']*?)48px/g, '$1' + '0.5in');
    // Word class-vs-inline margin-shorthand fix (2026-07-30, fix/word-export-indentation —
    // newly measured this session, via a real Word COM round-trip: converting `.rpt-int-hdr`/
    // `.rpt-body` back to `position:static` above was NOT enough on its own. Several report
    // sections (e.g. `.rpt-a36-callout`, the ASHRAE 36 Executive Summary's DCV/top-gap prose
    // blocks) nest their real text one level BELOW the `.rpt-body` direct child `_insetChildren`
    // touches, and rely on that direct child's own margin to carry the inset down through normal
    // block flow. `_insetChildren` correctly writes pure-longhand `margin-left:0.5in` INLINE on
    // that direct child (e.g. `<div class="rpt-a36-callout" style="margin-top:0;margin-bottom:
    // 14px;margin-left:0.5in;margin-right:0.5in;">`) — confirmed present, verbatim, in the
    // exported .doc. But `.rpt-a36-callout` ALSO has its own CLASS rule in `#report-styles`
    // (`margin: 6px 0;`, SHORTHAND) — and measured via PyMuPDF span position on the Word-COM
    // PDF, the class shorthand wins over the element's own correct inline longhand (x0 rendered
    // at 0pt, not 36pt). This generalizes the already-documented "Word drops longhand margin
    // entirely if a shorthand margin: appears in the SAME style attribute" fact — here the
    // conflicting shorthand lives in a separate CSS class rule, not the same attribute, and it
    // still wins. Fix: expand every remaining CLASS-level `margin: <shorthand>` declaration in
    // the exported stylesheet into four longhand `margin-top/right/bottom/left` declarations
    // (same 1/2/3/4-value parsing `_insetChildren` already uses below) — once no shorthand
    // margin declaration exists anywhere for an element, Word applies normal CSS specificity and
    // the correct per-element inline longhand wins, as documented for the plain "no shorthand
    // anywhere" case elsewhere in this function. Scoped to `margin:` only (the `-left`/`-right`/
    // `-top`/`-bottom` longhand properties are untouched, and `!important` is preserved).
    const _expandMarginShorthand = (str) =>
      str.replace(/margin\s*:\s*([^;{}]+);/g, function (whole, rawVal) {
        var hasImportant = /!important/.test(rawVal);
        var val = rawVal.replace(/!important/g, '').trim();
        var parts = val.split(/\s+/);
        var top, right, bottom, left;
        if (parts.length === 1) {
          top = right = bottom = left = parts[0];
        } else if (parts.length === 2) {
          top = bottom = parts[0];
          right = left = parts[1];
        } else if (parts.length === 3) {
          top = parts[0];
          right = left = parts[1];
          bottom = parts[2];
        } else {
          top = parts[0];
          right = parts[1];
          bottom = parts[2];
          left = parts[3];
        }
        var bang = hasImportant ? ' !important' : '';
        return (
          'margin-top:' +
          top +
          bang +
          ';margin-right:' +
          right +
          bang +
          ';margin-bottom:' +
          bottom +
          bang +
          ';margin-left:' +
          left +
          bang +
          ';'
        );
      });
    const css = _expandMarginShorthand(_fixPaddingUnits(resolveVars(rawCssWithIndentFix)));

    // Real Word headers/footers (2026-07-26 rewrite — see exportReportToWord()'s doc comment
    // below for the full root-cause history this replaces). The old approach baked
    // .rpt-footer/.rpt-footer-label/.rpt-pg-footer-pagenum and, on hero pages, the
    // .csc-header-img letterhead directly into each page's body flow. .rpt-footer/
    // .rpt-footer-label/.rpt-pg-footer-pagenum are still pulled OUT of every page's body and
    // relocated into a real `mso-element:footer` div (wordHeaderFooterHtml, built below) so Word
    // creates an actual word/footer*.xml part that repeats every page instead of static one-off
    // paragraphs.
    //
    // csc-header-img (the letterhead) is DELIBERATELY LEFT INLINE in the hero page's own body
    // flow instead — see the "trailing duplicate page" fix in the doc comment below for why: an
    // earlier version of this rewrite relocated ONLY page-1's letterhead into a Word
    // `mso-title-page:yes` / `mso-first-header` first-page header, which worked but made the
    // unavoidable single-file mso-element trailing-duplicate cost (documented below) three
    // full-size images tall (letterhead + two footer-wave copies) instead of one — reliably
    // overflowing onto a genuinely new trailing page on every real report. Every hero page
    // (whichever page number it lands on — the Audit/Proposal cover, or the Savings Report's
    // Board-Summary-then-Cover two-hero-page case) now gets the same treatment uniformly: keep
    // csc-header-img inline, sized via the width/height-attribute regex a few lines down.
    let rawBodyHtml = '';
    let hasPageNum = false;
    let footerLabelText = '';
    pages.forEach((pageEl, i) => {
      if (i > 0) {
        // Word page-break marker recognized by the mso HTML-to-doc conversion.
        rawBodyHtml += '<br clear="all" style="page-break-before:always" />';
        // Invisible spacer paragraph fix (2026-07-26, measured regression): even with pure
        // longhand margin (no shorthand at all — see _insetChildren's comment above), the very
        // first element rendered immediately after a forced page break still silently ignored
        // its own margin-left/margin-right (confirmed with a controlled Word COM round-trip,
        // varH_pagebreak.doc/.pdf and varI_flex.doc/.pdf: identical margin styling on the FIRST
        // element after a break failed while the SECOND element on the same page — same margin,
        // same nesting depth — worked correctly). This is a known, longstanding Word HTML-import
        // quirk independent of anything specific to this report (the first paragraph
        // immediately following a page break not fully honoring its own formatting). Standard
        // workaround: insert a zero-visual-impact placeholder paragraph right after the break so
        // the real page content (title bar, letterhead, body text — whatever it is) becomes the
        // SECOND element on the page instead of the first, which reliably respects its margin.
        rawBodyHtml += '<p style="margin:0;padding:0;font-size:1pt;line-height:1pt">&nbsp;</p>';
      }
      if (!hasPageNum && pageEl.querySelector('.rpt-pg-footer-pagenum')) hasPageNum = true;
      if (!footerLabelText) {
        const labelEl = pageEl.querySelector('.rpt-footer-label');
        if (labelEl && labelEl.textContent.trim()) footerLabelText = labelEl.textContent.trim();
      }
      const clone = pageEl.cloneNode(true);
      const stripSelectors = ['.rpt-footer', '.rpt-footer-label', '.rpt-pg-footer-pagenum'];
      stripSelectors.forEach((sel) => {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      });
      // Word cover-stats flex-row -> table fix (2026-07-31, fix/word-export-cover-stats-
      // sidebyside — Matt: the ASHRAE 36 Cover's gauge row and stat-tile row rendered STACKED
      // vertically instead of side by side in the live downloaded Audit Report). Word's HTML
      // importer has no flexbox support (settled/documented — any `display:flex` row collapses
      // to stacked block elements) but handles <table> correctly, so each row is rebuilt here as
      // a borderless one-row layout table, one <td> per statistic — no visible borders added
      // (Matt, 2026-07-29, same cover: "use no lines at all" between these stats). Scoped to the
      // .rpt-cover page and to the two EXACT style strings rptPageASHRAE36Cover emits (verified
      // against report-engine.js ~13352/~13388, and against the flex/svg inventory,
      // AI/_context/plans/word-export-flex-svg-inventory-2026-07-31.md, Shape C) — this is a
      // narrow, targeted fix for the two elements Matt actually saw stacked, not a general
      // flex-to-table translator for this report's other 189 flex occurrences (that inventory
      // ranks those as either invisible <td> vertical-centering wrappers or a separate,
      // lower-priority inline bar widget — out of scope here).
      if (clone.classList && clone.classList.contains('rpt-cover')) {
        const _wordRowToTable = (rowDiv, isGaugeRow) => {
          const kids = Array.from(rowDiv.children);
          if (!kids.length) return;
          const widthPct = (100 / kids.length).toFixed(3) + '%';
          const existingStyle = rowDiv.getAttribute('style') || '';
          const marginMatch = existingStyle.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/);
          const rowMargin = marginMatch ? marginMatch[1].trim() : '0';
          const table = document.createElement('table');
          table.setAttribute('style', 'width:100%;border-collapse:collapse;margin:' + rowMargin);
          table.setAttribute('cellpadding', '0');
          table.setAttribute('cellspacing', '0');
          const tr = document.createElement('tr');
          kids.forEach((kid) => {
            const td = document.createElement('td');
            td.setAttribute('style', 'width:' + widthPct + ';text-align:center;vertical-align:top;padding:0 6px');
            if (isGaugeRow) {
              // Word drops <svg> entirely — no OOXML equivalent for the ring graphic itself
              // (documented, no lightweight fix). Reproduce the one part of the gauge that DOES
              // have a plain-text equivalent: the pct% number the SVG already draws via its own
              // <text> element (_a36GaugeSVG, report-engine.js) — read that text/color straight
              // back out of the live-rendered SVG so the client-facing number still survives in
              // Word even though the ring visualization does not.
              const svg = kid.querySelector('svg');
              const labelDiv = kid.querySelector('div');
              let pctText = '';
              let color = 'var(--rpt-page-text)';
              if (svg) {
                const texts = svg.querySelectorAll('text');
                if (texts.length) {
                  pctText = texts[texts.length - 1].textContent || '';
                  color = texts[texts.length - 1].getAttribute('fill') || color;
                }
              }
              td.innerHTML =
                '<div style="font-size:26px;font-weight:700;color:' +
                color +
                '">' +
                pctText +
                '</div>' +
                (labelDiv
                  ? '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">' +
                    labelDiv.textContent +
                    '</div>'
                  : '');
            } else {
              if (kid.className) td.className = kid.className;
              td.innerHTML = kid.innerHTML;
            }
            tr.appendChild(td);
          });
          table.appendChild(tr);
          rowDiv.parentNode.replaceChild(table, rowDiv);
        };
        const gaugeRow = clone.querySelector(
          'div[style="display:flex;justify-content:center;gap:36px;margin:24px 0 20px"]',
        );
        if (gaugeRow) _wordRowToTable(gaugeRow, true);
        const statRow = clone.querySelector('div[style="display:flex;gap:16px;margin-top:12px"]');
        if (statRow) _wordRowToTable(statRow, false);
      }
      // Word section-heading size fix (2026-07-31, fix/word-export-cover-stats-sidebyside —
      // Matt, same complaint batch as the cover stats: "paragraph headings need to be bigger
      // font size"). This report has no intermediate heading size between 14px (10.5pt) body
      // text and the 18px (~13.5pt) page-title bar — these two Executive Summary callout
      // headers (rptPageASHRAE36Executive, report-engine.js ~13538/~13564, "Most Common Gap
      // Across Portfolio" / "Demand Control Ventilation Readiness") render at 11px (~8.25pt),
      // visually the SAME SIZE as the body sentence directly under them (measured on a real
      // Word COM PDF round-trip: both 8.5pt in the rendered PDF) — bold is their only signal.
      // Matt authorized one new size, applied here in the Word export only: 13pt, Arial, size
      // ONLY — "he asked for size, not weight" — so bold is REMOVED rather than compounded; the
      // size increase alone carries the heading now. Scoped to the exact style string both of
      // these two headers share (verified unique to just these two elements in the whole file);
      // not a general heading-style overhaul of the report.
      clone
        .querySelectorAll('div[style="font-size:11px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px"]')
        .forEach((h) => {
          h.setAttribute(
            'style',
            'font-size:13pt;font-weight:400;font-family:Arial, sans-serif;color:var(--rpt-page-text);margin-bottom:4px',
          );
        });
      // Word text-inset DOM fix (2026-07-26, second pass on top of _fixPaddingUnits below — see
      // that function's comment for the "48px must become 0.5in" half of this fix). Converting
      // the unit was necessary but NOT sufficient: measured via synthetic Word COM round-trips
      // (varE/varF test docs) that Word's HTML importer does not apply padding OR margin set on
      // a wrapping <div> to its children's rendered position AT ALL, regardless of unit — only a
      // margin set DIRECTLY on the block-level element that actually contains the text (the
      // <p>/<div>/<table>/<ul> itself) insets that element. Every one of this report's
      // horizontal-inset containers — the `.rpt-body` wrapper (interior pages) and each hero
      // page's own inline `padding:Npx 48px Mpx` content wrapper (every ASHRAE 36 Proposal page,
      // ASHRAE 36 Executive Summary, the Board Summary edit box) — puts its real content inside
      // exactly this kind of ancestor div, so container-level padding/margin is silently dropped
      // by Word no matter what. Fix: walk each container's DIRECT children here (while this is
      // still a live DOM clone, before serializing to an HTML string) and set inline
      // margin-left/margin-right on each of THEM instead — only the horizontal properties are
      // touched, so any existing top/bottom spacing on these children is untouched. Runs before
      // the "48px" -> "0.5in" string substitution below, so it matches on the original "48px"
      // token still present in each hero wrapper's inline style at this point.
      // WORD_CONTENT_WIDTH (2026-07-26, measured regression fix): tables throughout this file
      // are built with inline `style="width:100%"` (rptPageASHRAE36PointInventory's building
      // table and many others) — correct on the live/PDF path where percentage widths resolve
      // against their actual containing block. Word's HTML importer does not: it resolves a
      // table's `width:100%` against the PAGE's content width (8.5in, since @page margin is 0),
      // NOT against the now-margined parent above, so a 100%-wide table combined with the new
      // 0.5in margin-left overflowed 0.5in off the right edge of the page (measured: the
      // rightmost "ASHRAE COVERAGE" table column was clipped at the page boundary in the
      // rendered PDF). Fix: any width:100% element anywhere inside the inset container — direct
      // child or nested deeper (several of these tables sit inside an intermediate pagination
      // wrapper div, not directly under .rpt-body) — gets its width overridden to the exact
      // correct absolute value instead — this report's page is always 8.5in wide with a fixed
      // 0.5in inset each side, so 7.5in is always the right answer, never computed as a
      // percentage Word might re-resolve against the wrong box. Only DIRECT children get the
      // margin-left/right inset itself (nested width:100% descendants already sit inside an
      // already-inset ancestor and would be double-inset otherwise).
      // Indentation depth increase (2026-07-31, fix/word-export-indent-depth — Matt: "the
      // indents need to be more for normal text and especially bullet points"). Body text was
      // measured at a correct-but-shallow 36pt (0.5in) inset; target is 54pt (0.75in). Page is
      // 8.5in (612pt) wide with @page margin 0in, so content width shrinks in lockstep to
      // 8.5in - 2*0.75in = 7.0in (was 7.5in) to keep the same 0.75in gutter on both sides —
      // WORD_CONTENT_WIDTH must always equal page width minus 2x WORD_TEXT_INSET, never edited
      // independently, or width:100% tables will overflow/underflow the new margin.
      const WORD_TEXT_INSET = '0.75in';
      const WORD_CONTENT_WIDTH = '7.0in';
      // Scoped to `table` elements only (2026-07-26, regression fix). The unscoped
      // `[style*="width:100%"]` substring selector below also matched non-table elements that
      // legitimately use `width:100%` combined with their own `max-width` cap — e.g. the monthly
      // Site EUI bar-chart segments in rptPageBuildingSummary (`style="width:100%;max-width:15px;
      // height:...px"`), which rely on `max-width:15px` to stay narrow bars. Word's HTML importer
      // does not honor `max-width` reliably, so once this selector overwrote their `width` to
      // WORD_CONTENT_WIDTH (7.5in) the bars rendered as full-page-width blocks in the exported
      // Word doc. The documented root cause this fix addresses (see the WORD_CONTENT_WIDTH
      // comment above) is specific to `<table>` elements — Word resolves a TABLE's `width:100%`
      // against the page's content width instead of its actual containing block; there is no
      // equivalent documented failure mode for divs/other elements. Restricting the selector to
      // `table` targets exactly the elements the original fix was written for and leaves every
      // other `width:100%` usage (chart bars, images, wrapper divs) untouched.
      const _fixFullWidth = (root) => {
        if (root.tagName === 'TABLE' && root.style && root.style.width === '100%') {
          root.style.width = WORD_CONTENT_WIDTH;
        }
        root.querySelectorAll('table[style*="width:100%"], table[style*="width: 100%"]').forEach((el) => {
          el.style.width = WORD_CONTENT_WIDTH;
        });
      };
      // Nested-wrapper fix (2026-07-26, measured regression): several non-hero ASHRAE 36
      // Proposal pages (Phase Table, Long-Term Vision, Scope of Work) nest a second, bare
      // `<div style="padding:Npx 48px Mpx">` grouping wrapper directly inside `.rpt-body`
      // (hero:false pages still use their own hand-written inline-padding wrapper instead of
      // relying on .rpt-body's own padding) — measured: their heading text still rendered flush
      // against the page edge even after the fix above, because setting margin-left/right on
      // THAT bare wrapper div doesn't propagate down into IT'S OWN children either (same "Word
      // does not apply a div's padding/margin to its children" limitation described above, one
      // level deeper). `_insetChildren` now recurses into any bare 48px-styled div it finds
      // among a container's children and insets THAT wrapper's real content instead of the
      // wrapper itself.
      const _isBareInsetWrapper = (el) =>
        el.tagName === 'DIV' && !el.className && /48px/.test(el.getAttribute('style') || '');
      // Two-level wrapper fix, part 2 (2026-07-30, fix/word-export-indentation — Matt: "I don't
      // see the indentations or spacing I asked for", backlog 4c946ba2). Measured via a real
      // Word COM round-trip and confirmed directly in the unzipped `word/document.xml` (not just
      // the rendered PDF): several report sections — e.g. `rptPageASHRAE36Executive`'s DCV/
      // top-gap `.rpt-a36-callout` prose blocks — nest their real text TWO levels below
      // `.rpt-body` (`.rpt-body > .rpt-a36-callout > div[text]`), not one. `.rpt-a36-callout` is
      // NOT a "bare" wrapper (`_isBareInsetWrapper` requires `!el.className`, and this element
      // has a class), so the recursion above previously skipped it and instead inset the wrapper
      // ITSELF — giving `.rpt-a36-callout` a correct inline `margin-left:0.5in`. That value never
      // reaches its own children: unzipping `document.xml` for the resulting paragraph showed
      // `<w:pPr>` with NO `<w:ind>` element at all (not merely a wrong one) — Word's HTML importer
      // computes a paragraph's indent from the CSS of the element that directly generates that
      // paragraph, never from an ancestor wrapping `<div>`'s margin, confirming this is the SAME
      // underlying limitation `_isBareInsetWrapper` was already written for (2026-07-26, "Word
      // does not apply a div's padding/margin to its children"), just one level deeper and behind
      // a class name instead of a bare/48px-styled div. Fix: detect ANY div — classed or not —
      // that is a pure grouping wrapper (every direct child is itself a block element, and it has
      // no direct text of its own) and recurse into it exactly like a bare wrapper, instead of
      // insetting the wrapper itself. The wrapper's own vertical margin (top/bottom — real content
      // spacing, e.g. `.rpt-a36-callout`'s `margin-bottom:14px`) is left untouched; only the
      // decision of WHERE the 0.5in left/right inset actually lands changes.
      const _hasDirectText = (el) =>
        Array.from(el.childNodes).some(function (n) {
          return n.nodeType === 3 && n.textContent.trim().length > 0;
        });
      const _BLOCK_TAGS = ['DIV', 'TABLE', 'UL', 'OL', 'P'];
      const _isPureBlockWrapper = (el) =>
        el.tagName === 'DIV' &&
        el.children.length > 0 &&
        !_hasDirectText(el) &&
        Array.from(el.children).every(function (c) {
          return _BLOCK_TAGS.indexOf(c.tagName) !== -1;
        });
      const _insetChildren = (container) => {
        Array.from(container.children).forEach((child) => {
          if (_isBareInsetWrapper(child) || _isPureBlockWrapper(child)) {
            _insetChildren(child);
            return;
          }
          // Rebuilt as four separate longhand margin-* declarations, with any pre-existing
          // `margin:` SHORTHAND property removed entirely — measured twice (2026-07-26):
          // (1) child.style.marginLeft/marginRight via the live CSSOM risks the browser's own
          // serializer recombining everything into a single `margin: <top> 0.5in <bottom>`
          // shorthand when this clone's innerHTML is read; (2) even leaving the ORIGINAL
          // `margin:0 0 5px` shorthand text in place and appending separate
          // margin-left/margin-right declarations AFTER it in the same style string (i.e. normal
          // CSS cascade — later same-attribute declarations should override the shorthand's
          // corresponding sides) still failed: Word's HTML importer does not apply ANY
          // margin-left/margin-right that shares a style attribute with a `margin:` shorthand
          // property, regardless of order — it appears to treat the shorthand as the sole
          // authority for that element whenever one is present at all. Word DOES reliably apply
          // pure longhand when NO shorthand `margin:` property exists anywhere in the string
          // (confirmed: varH_pagebreak.doc's four-separate-longhand case worked both mid-page
          // and as the first element after a forced page break). Fix: parse out the existing
          // top/bottom from either explicit margin-top/margin-bottom or a `margin:` shorthand,
          // strip every margin-related declaration from the string, then re-emit all four sides
          // as separate longhand — never left as (or combined into) a shorthand.
          const _existingStyle = child.getAttribute('style') || '';
          let _marginTop = '0';
          let _marginBottom = '0';
          const _topM = _existingStyle.match(/(?:^|;)\s*margin-top\s*:\s*([^;]+)/);
          const _bottomM = _existingStyle.match(/(?:^|;)\s*margin-bottom\s*:\s*([^;]+)/);
          const _shortM = _existingStyle.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/);
          if (_shortM) {
            const _parts = _shortM[1].trim().split(/\s+/);
            if (_parts.length === 1) {
              _marginTop = _marginBottom = _parts[0];
            } else if (_parts.length === 2) {
              _marginTop = _marginBottom = _parts[0];
            } else {
              // 3-value (T LR B) or 4-value (T R B L): third value is always bottom.
              _marginTop = _parts[0];
              _marginBottom = _parts[2];
            }
          }
          if (_topM) _marginTop = _topM[1].trim();
          if (_bottomM) _marginBottom = _bottomM[1].trim();
          const _strippedStyle = _existingStyle
            .replace(/(?:^|;)\s*margin\s*:\s*[^;]+;?/g, ';')
            .replace(/(?:^|;)\s*margin-top\s*:\s*[^;]+;?/g, ';')
            .replace(/(?:^|;)\s*margin-bottom\s*:\s*[^;]+;?/g, ';')
            .replace(/(?:^|;)\s*margin-left\s*:\s*[^;]+;?/g, ';')
            .replace(/(?:^|;)\s*margin-right\s*:\s*[^;]+;?/g, ';');
          child.setAttribute(
            'style',
            _strippedStyle +
              (_strippedStyle && !/;\s*$/.test(_strippedStyle) ? ';' : '') +
              'margin-top:' +
              _marginTop +
              ';margin-bottom:' +
              _marginBottom +
              ';margin-left:' +
              WORD_TEXT_INSET +
              ';margin-right:' +
              WORD_TEXT_INSET +
              ';',
          );
          _fixFullWidth(child);
        });
      };
      // .rpt-int-hdr (the title/client-name chrome bar at the top of every interior page) uses
      // the same class-based 48px/0.5in side padding convention (`.rpt-int-hdr {padding:10px
      // 48px 8px}`) and is dropped by Word the same way — measured: its title text rendered
      // flush against the left page edge. Same fix, same reasoning as .rpt-body above.
      clone.querySelectorAll('.rpt-body, .rpt-int-hdr').forEach(_insetChildren);
      // Hero pages only: a `div[style*="48px"]` wrapper here is a DIRECT child of `.rpt-cover`
      // (hero pages have no `.rpt-body` at all), so it's not reached by the recursion above.
      // Excluded via closest('.rpt-body') rather than just classList — without it, this second
      // pass ALSO matched (and double-processed) the very same bare wrapper divs the recursion
      // above already unwraps inside non-hero ASHRAE 36 Proposal pages, producing duplicate
      // margin-left/margin-right declarations (measured: harmless since duplicates collapse to
      // the same effective value, but wasteful — excluded for a clean single pass instead).
      clone.querySelectorAll('div[style*="48px"]').forEach((container) => {
        if (container.closest('.rpt-body')) return; // already handled by recursion above
        _insetChildren(container);
      });
      // Word list-item font-size fix (2026-07-26, measured via PyMuPDF span extraction on a real
      // Word COM PDF round-trip: bullet list items rendered at a measured 12.00pt — visibly
      // larger than the surrounding body paragraphs/table cells this report's own markup declares
      // via each list's own `<ul>` wrapper). Root cause, confirmed by unzipping document.xml:
      // Word's HTML importer, when it converts a source `<ul>/<li>` into a native Word
      // numbered/bulleted list, drops any font-size found on the `<ul>` (or an inline style added
      // directly to the `<li>` that merely repeats a fixed literal like "10.0pt") without ever
      // writing an explicit `w:sz` on the resulting run — it silently falls back to the document's
      // base default instead, which is NOT the same value as this report's own body-paragraph
      // text: body/table-cell `<div>`s DO get an explicit per-run `w:sz` from their own inline
      // font-size (measured: Word applies px-based font-size to ordinary paragraphs/divs via its
      // usual px->half-point conversion, unlike the padding-px behavior fixed by
      // _fixPaddingUnits above — font-size in px is NOT the same limitation), but that same
      // literal value written directly onto a converted `<li>` is discarded during the
      // list-numbering conversion specifically. Fix, mirroring _insetChildren's existing "read the
      // wrapper's own intended value, write it onto the real child element" pattern rather than
      // inventing a single global constant (this report has multiple <ul> font-sizes by design —
      // e.g. body-matched (14px = 10.5pt, per CSC Letterhead.docx spec) lists here and on
      // rptPageASHRAE36ProposalVision, vs an intentionally smaller 8.5px in
      // _rptA36TierDetailPanelHTML's item lists — a single hardcoded size would wrongly flatten
      // those): read each `<ul>`/`<ol>`'s own inline `font-size` and copy that EXACT literal
      // value onto every one of its own `<li>` children. When a list has no explicit font-size,
      // 10.0pt (matching wordFontCss's own .MsoChpDefault/p.MsoNormal docDefaults value below) is
      // the safe fallback. (2026-07-28: also switched the per-`<li>` font-family override from
      // Calibri to Arial to match the CSC Letterhead.docx template — see wordFontCss below.)
      // NOTE (2026-07-31, fix/word-export-indent-depth): the "`<ul>` wrapper margin alone is
      // sufficient, `<ol>` needs the per-`<li>` fallback" conclusion in the paragraph immediately
      // below is SUPERSEDED — see the "List depth" comment further down for the fresh,
      // contradicting measurement this branch made. Left in place as the historical record of
      // why the per-`<li>` mechanism exists and how `<ol>`'s baseline-delta math works; the
      // `<ul>`-is-fine claim specifically should not be relied on.
      // List indentation fix (2026-07-30, fix/word-export-indentation), SCOPED TO `<ol>` ONLY —
      // measured via the same Word COM round-trip that `<ul>` (bulleted) lists do NOT have this
      // problem: e.g. the Proposal's "future opportunities" bullet list and the Agreement's own
      // Section 1.1 services bullets both already rendered at the correct 36pt via
      // `_insetChildren`'s existing wrapper-level `margin-left:0.5in` — confirmed unaffected in a
      // controlled A/B (measuring the exact same bullet list before vs after this change: 36pt
      // both times). The ONLY defect measured is on `<ol>` (numbered lists — the single `<ol>`
      // in this codebase, the EMS Agreement's building list): Word's HTML importer converts an
      // `<ol>` into a native NUMBERED list where each `<li>` becomes its own paragraph
      // (`<w:p>` + `<w:numPr>`) using ONE of Word's own built-in default numbering definitions,
      // apparently seeded from the source `padding-left` (interpreted unit-blind as pt, not px —
      // the same behavior `_fixPaddingUnits` above works around for padding generally) — but the
      // `<ol>` wrapper's own `margin-left` has no OOXML home to attach to and is dropped
      // (measured x0 18pt, the list's own `padding-left` value, not the intended 36pt). An
      // initial attempt applying this SAME per-`<li>` fix to `<ul>` too caused a real regression
      // (36pt -> 56pt on an already-correct bullet list) — do not widen this back to `ul`
      // without a fresh measurement proving it is still needed. Fix: when the `<ol>`'s own
      // margin-left equals the standard page inset (`WORD_TEXT_INSET`, i.e. this list WAS a
      // direct `.rpt-body`/`.rpt-int-hdr` child `_insetChildren` touched), copy the REMAINING
      // delta — target inset minus the `padding-left`-derived baseline Word already applies —
      // onto every `<li>` (a per-paragraph `margin-left` DOES have a real OOXML home, `<w:ind>`,
      // and survives), so the two combine to the intended 36pt total (measured after fix: 36pt,
      // matching the live browser/PDF reference render of 37.8pt within marker-glyph rounding).
      const _listFontSizeRe = /font-size\s*:\s*([^;]+)/;
      const _listMarginLeftRe = /margin-left\s*:\s*([^;]+)/;
      const WORD_TEXT_INSET_PT = 54; // matches WORD_TEXT_INSET ('0.75in') in points
      // List depth (2026-07-31, fix/word-export-indent-depth — Matt: "especially bullet
      // points"). Bullets/numbers must sit clearly deeper than body text, not level with it.
      // THREE controlled Word COM round-trips this branch (PyMuPDF span x0 on the ASHRAE 36
      // Proposal's "Why This Approach" bullet list) established the actual, DIFFERENT-from-
      // documented-history behavior of Word's HTML->native-list conversion, superseding both the
      // "<ul> wrapper margin is honored" AND "<ol> padding-left seeds the numbering-def"
      // conclusions in the 2026-07-30 comment block above:
      //   1. An explicit `margin-left:72pt`/`144pt` on the `<ul>` wrapper: ZERO effect (marker
      //      unmoved either time).
      //   2. An explicit `padding-left:18pt`/`72pt`/`144pt` on the `<ul>` wrapper: ALSO zero
      //      effect on the rendered marker once a clean (non-duplicate) single declaration is
      //      used — the 18pt "match" in an earlier draft of this fix was a coincidence: that
      //      draft's DOM edit left the list's pre-existing `padding-left:16px` in the style
      //      string ahead of the new one, and Word's rendered marker in that case simply equalled
      //      WORD's OWN un-overridable default (see point 3), which happened to be 18pt too.
      //   3. With no per-`<li>` override at all, EVERY bullet list in this report renders its
      //      marker at a fixed x0 of 18.00pt and its text at 22.56pt (a 4.56pt marker-to-text
      //      gap) — Word's own built-in "List Bullet" numbering-def default, entirely independent
      //      of any source CSS on the `<ul>`/`<li>`.
      //   4. A per-`<li>` `margin-left` (documented below as having a real OOXML `<w:ind>` home)
      //      is the ONE lever that reliably moves anything: it shifts marker AND text together,
      //      1:1, preserving Word's fixed 4.56pt gap exactly (measured: `margin-left:18pt` on
      //      every `<li>` -> marker 36.00pt, text 40.56pt — exactly the 18pt baseline plus an
      //      18pt shift, gap unchanged).
      // Net effect: Word's native bullet-list HTML import does not expose an independently
      // controllable marker-to-text HANGING gap via inline CSS at all in this environment — only
      // a uniform shift of the whole item (marker+text together) is achievable. Given that hard
      // constraint, this fix hits the MARKER target exactly (WORD_LIST_MARKER_INSET_PT, 72pt/
      // 1.0in) via `WORD_LIST_DEFAULT_MARKER_PT` (Word's fixed 18pt baseline) + a per-`<li>`
      // margin-left of exactly the remaining delta; the resulting TEXT position is
      // WORD_LIST_MARKER_INSET_PT + Word's own fixed ~4.56pt gap (~76.6pt) rather than the
      // requested 90pt (1.25in) hanging target — flagged explicitly in this branch's report
      // rather than silently claiming 90pt was achieved.
      const WORD_LIST_DEFAULT_MARKER_PT = 18; // Word's fixed, CSS-independent default marker x0
      const WORD_LIST_MARKER_INSET_PT = 72; // 1.0in — target marker position, achieved exactly
      clone.querySelectorAll('ul, ol').forEach((listEl) => {
        const _listStyle = listEl.getAttribute('style') || '';
        const _sizeMatch = _listStyle.match(_listFontSizeRe);
        const _liFontSize = _sizeMatch ? _sizeMatch[1].trim() : '10.0pt';
        const _marginMatch = _listStyle.match(_listMarginLeftRe);
        const _isBodyLevelList = !!(_marginMatch && _marginMatch[1].trim() === WORD_TEXT_INSET);
        const _liMarginLeft = _isBodyLevelList
          ? Math.max(0, WORD_LIST_MARKER_INSET_PT - WORD_LIST_DEFAULT_MARKER_PT) + 'pt'
          : null;
        Array.from(listEl.children).forEach((li) => {
          if (li.tagName !== 'LI') return;
          const _existingLiStyle = li.getAttribute('style') || '';
          li.setAttribute(
            'style',
            _existingLiStyle +
              (_existingLiStyle && !/;\s*$/.test(_existingLiStyle) ? ';' : '') +
              'font-family:Arial, sans-serif;mso-ascii-font-family:Arial;mso-hansi-font-family:Arial;' +
              'mso-bidi-font-family:Arial;font-size:' +
              _liFontSize +
              ';' +
              (_liMarginLeft ? 'margin-left:' + _liMarginLeft + ';' : ''),
          );
        });
      });
      rawBodyHtml += '<div class="rpt-page-word-wrap">' + clone.innerHTML + '</div>';
    });
    // Resolve var(--rpt-*) references embedded in inline style="" attributes throughout
    // the page markup (see _buildReportCssVarResolver doc comment above) — not just the
    // stylesheet text.
    // _fixPaddingUnits (defined above, see comment there): same 48px->0.5in padding-unit fix,
    // applied here to the inline "padding:Npx 48px Mpx" wrappers every ASHRAE 36 Proposal page
    // (and the Board Summary editable box) uses for their content's horizontal inset.
    let bodyHtml = _fixPaddingUnits(resolveVars(rawBodyHtml));

    // Word image-sizing fix (2026-07-22, measured via PyMuPDF image-bbox extraction on Word's
    // own SaveAs-PDF output; applies to every hero page's inline csc-header-img letterhead
    // — 2026-07-26: now ALL of them, not just the "beyond page 1" edge case, per the
    // trailing-duplicate-page fix described above. The footer wave graphic still lives in
    // wordHeaderFooterHtml below and is sized with the same inline-attribute technique there):
    // NEITHER the CSS `width:100%` the live/PDF path uses NOR an `!important` fixed-px override
    // in a stylesheet rule changed Word's rendered image size at all — Word's HTML-import path
    // sizes these report images from something other than CSS (most likely the embedded JPEG's
    // own DPI metadata), so they were rendered at native intrinsic pixel size (918x218 / 1699x224
    // px) regardless, overflowing the page. The one technique Word's HTML-import reliably honors
    // is classic HTML width/height ATTRIBUTES (not CSS) on <img> — this regex adds them. bodyHtml
    // here is markup generated entirely by this file's own rptPage() template strings (never user
    // input), so a narrow, literal substitution is safe. 816px = this report's exact page width.
    bodyHtml = bodyHtml.replace(
      /<img src="([^"]*)" alt="CSC Letterhead" class="csc-header-img"[^>]*>/g,
      '<img src="$1" alt="CSC Letterhead" class="csc-header-img" width="816" height="194" style="width:8.5in;height:auto;display:block">',
    );
    // csc-header-img-inset sizing fix (2026-07-30, item 5b789cc8): same technique as the
    // full-bleed regex immediately above (literal HTML width/height attributes — the only thing
    // Word's HTML importer reliably honors for <img> sizing, per ROOT CAUSE 3 below), applied to
    // the Agreement's inset small-header letterhead (rptPage()'s smallHeaderImg option) instead
    // of the full page width. This regex runs SECOND and only matches the more specific
    // class="csc-header-img csc-header-img-inset" string, so it never touches the hero images
    // the regex above already sized to 8.5in.
    //
    // Width source: NOT this file's own 0.5in-margin convention (which would give 7.5in, per
    // WORD_CONTENT_WIDTH above) — per the task's explicit instruction, this uses the measured CSC
    // document-style baseline instead: AI/_context/specs/csc-document-style-spec-2026-07-29.md
    // section 1, extracted from Louisburg School District's actual OOXML sectPr (12240 twips page
    // width minus 1170+990 twips left/right margins = 10080 twips = exactly 7.0000in / 672.00px
    // content width). Height derived by preserving this same image's existing aspect ratio already
    // established by the full-bleed regex above (816px:194px, i.e. 194/816): 672 * 194/816 =
    // 159.76, rounded to 160px / ~1.664in.
    //
    // Left-inset note (2026-07-30, tested and reverted, not a regression): this file's own
    // clone.querySelectorAll('div[style*="48px"]') pass (above) DOES try to inset this image by
    // setting margin-left/right:0.5in on it as a child of .rpt-small-hdr — but this regex's
    // literal replacement runs AFTER that DOM pass and, matching every other emission site in
    // this function, replaces the entire <img> tag wholesale, so any margin the DOM pass added is
    // discarded. Tried adding margin-left:0.5in directly into this replacement string instead;
    // measured via a real Word COM PDF round-trip that it has NO effect — this image still
    // renders flush against the page's left edge (bbox x0=0.00pt) either way. Confirmed this is
    // NOT a regression from this fix: the PRE-FIX bbox was also x0=0.00pt (it was simply masked by
    // the far larger right-edge overflow this fix addresses). Left-inset on this specific <img> is
    // out of scope here per the task's own instruction — it is the same class of issue as backlog
    // 4c946ba2 (paragraph indentation/spacing), which owns its own dispatch.
    bodyHtml = bodyHtml.replace(
      /<img src="([^"]*)" alt="CSC Letterhead" class="csc-header-img csc-header-img-inset"[^>]*>/g,
      '<img src="$1" alt="CSC Letterhead" class="csc-header-img csc-header-img-inset" width="672" height="160" style="width:7in;height:auto;display:block">',
    );

    const client = data.project.client || data.project.name || 'Report';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    let filename;
    if (data._agreement) {
      filename = client + ' - Energy Management Services Agreement ' + dateStr + '.doc';
    } else if (data._ashrae) {
      filename =
        data._ashrae.type === 'proposal'
          ? client + ' - Service Proposal ' + dateStr + '.doc'
          : client + ' - ASHRAE 36 Audit Report ' + dateStr + '.doc';
    } else {
      const typeLabel = data.period && data.period.type === 'quarterly' ? 'Quarterly' : 'Annual';
      filename = client + ' - ' + typeLabel + ' Savings Report ' + dateStr + '.doc';
    }

    // Word-only page setup + chrome overrides (2026-07-22 fix, Matt: "the word files footer
    // and headers and other formatting did not translate correctly... text is running off all
    // of the pages at the bottom").
    //
    // ROOT CAUSE 1 (header/footer + overall layout "completely different" from the PDF):
    // .rpt-page is designed at 816x1056px (8.5in x 11in at 96dpi — an exact match for a Letter
    // page with ZERO margins). Word's HTML-open path, left unconfigured, defaults to a normal
    // 1in-margin Letter page (only 624px/6.5in of usable width) — every 816px-wide element
    // (the CSC letterhead image, tables, etc.) therefore ran off the right edge of Word's
    // actual printable area, which is also why the Word doc reflowed so differently from the
    // 816px-wide PDF render. `@page Section1` below (the standard WordprocessingML HTML
    // page-setup directive — see the mso-application namespace comment on _buildReportCssVarResolver
    // above) sets Word's own page size/margins to match the report's design pixel-for-pixel, so
    // the 816px page content now fits Word's printable area exactly with no shrink/overflow.
    //
    // ROOT CAUSE 2 (footer/header not rendering correctly in Word) — REWRITTEN 2026-07-26,
    // trailing-duplicate-page fix REWRITTEN AGAIN same day (see below).
    // The 2026-07-22 fix moved .rpt-footer/.rpt-footer-label/.rpt-pg-footer-pagenum into normal
    // body flow with position:static !important on every page, because Word's HTML engine
    // doesn't support position:absolute. That got them visible again, but they were then just
    // ordinary paragraphs baked once per page — they could not repeat automatically, and
    // "Page N of Total" was static text written at generation time (_injectPageNumbers), so it
    // went stale the instant Word repaginated the reflowed content (measured: unzipping the
    // broken output showed ZERO word/header*.xml or word/footer*.xml parts and no
    // headerReference/footerReference in sectPr — none of this chrome was ever a real Word
    // header/footer, just body paragraphs).
    //
    // The fix: use the same `mso-element:header` / `mso-element:footer` HTML primitives Word's
    // own "Web Page" export emits for a real header/footer part (wordHeaderFooterHtml, built
    // below from the content stripped out of each page's body). `mso-header`/`mso-footer` on
    // @page Section1 bind those divs to the section. Word's HTML-to-OOXML importer turns this
    // into a real word/header1.xml + word/footer1.xml part pair and headerReference/
    // footerReference entries in sectPr.
    //
    // TRAILING-DUPLICATE-PAGE FIX (2026-07-26, same day, second pass): this single-file
    // "mso-element:header/footer divs living in the same HTML document as the content"
    // technique has a measured, structural limitation — confirmed by generating a real Word COM
    // reference export (wdFormatHTML, format 8 — "Web Page") of a plain multi-page doc with
    // headers/footers and inspecting the separate part Word itself writes: Word's own HTML
    // engine NEVER keeps header/footer source markup in the same file as the body at all, it
    // always splits it into a second linked file. When header/footer divs DO live in the same
    // file as the body (our situation — a single downloadable Blob has nowhere else to put a
    // second file), Word's importer still correctly copies their content into real header/
    // footer parts (headerReference/footerReference/images all measured correct), but it does
    // NOT prune the original source divs from the visible body flow — a literal copy of
    // whatever they contain always renders again, once, immediately after the real content.
    // Every CSS suppression technique tried (display:none, mso-hide:all, on the divs directly
    // and on a wrapping ancestor; moving the divs before instead of after the real content,
    // which broke extraction entirely — zero header/footer parts produced) either failed to
    // hide the duplicate or broke the real header/footer along with it, or broke extraction.
    // This is a genuine, unfixable-via-markup limitation of the technique, not a bug in this
    // code — confirmed against Matt's own report ("this would be sent to a client" — an entire
    // extra page of duplicated letterhead + wave graphics is not acceptable regardless of cause).
    //
    // Since the duplicate itself can't be eliminated, the fix is to make it small enough that it
    // reliably fits in whatever whitespace remains on the actual last content page instead of
    // overflowing onto a genuinely new page (measured: a small amount of duplicated content —
    // e.g. plain text — lands harmlessly at the bottom of the existing last page; only a large
    // one, like three full-width images, is tall enough to force a new page). The OLD version of
    // this fix used Word's `mso-title-page:yes`/`mso-first-header`/`mso-first-footer` mechanism
    // to give the hero/cover page (page 1) its own distinct letterhead header — correct on
    // screen, but it meant the duplicate content was THREE full-width images (letterhead + two
    // separate footer-wave copies, one for the default footer and one required for the first-page
    // footer since Word renders a title page's footer genuinely blank if no first-footer is
    // specified) — reliably overflowing onto a new trailing page on every real report. Dropping
    // that mechanism entirely and instead leaving every hero page's letterhead as an ordinary
    // inline `<img>` in its own body content (exactly like the pre-existing "second hero page"
    // edge case already did, and like the live/PDF path always has) removes the need for a
    // distinct first-page header/footer altogether: there is now only ONE header (h1, empty on
    // every page — each page's own visible chrome, if any, already lives in its own body
    // content) and ONE footer (f1, the wave graphic, byte-identical and correct on every page
    // including the hero page). The trailing duplicate is now just that ONE ~1.1in-tall footer
    // image instead of ~4.3in of stacked images — measured (see verification below) to land
    // within the existing last page's remaining whitespace with no new page produced, on both
    // the Service Proposal and the ASHRAE 36 Audit Report.
    //
    // ROOT CAUSE 3 (letterhead/footer graphic running off the right edge — measured via
    // PyMuPDF image bbox extraction on Word's own SaveAs-PDF output, 2026-07-22, still true
    // 2026-07-26): Word's HTML engine does not scale <img width:100%> to its containing block
    // the way browsers do — it renders the CSC_HEADER_B64 / CSC_FOOTER_B64 images at their
    // NATIVE INTRINSIC pixel size regardless of percentage width or an !important stylesheet
    // rule (confirmed both fail identically). Word DOES reliably honor size set directly on the
    // <img> element itself, so the footer image below (and the inline-body letterhead regex
    // above) carries both classic width/height HTML attributes AND an inline
    // `style="width:8.5in;height:auto"` — belt-and-suspenders since this is the one part of the
    // whole export Word has been least consistent about honoring.
    const footerImgHtmlWord =
      '<img src="' +
      CSC_FOOTER_B64 +
      '" alt="CSC Footer" width="816" height="108" style="width:8.5in;height:auto;display:block">';
    // footerLabelText / hasPageNum were computed above while stripping each page's body (from
    // whatever rptPage() actually emitted for THIS report), so this footer content only shows
    // what each report type's design calls for. 2026-07-29 (Matt: "all reports should always
    // have page numbers"): the Service Proposal's rptPage() calls no longer pass noPageNum:true
    // (that opt-in flag still exists on rptPage() itself for any future caller that needs it, it
    // is just unused today), so hasPageNum is now true for every Proposal page too and this
    // footer gets the same real Word field-code "Page <PAGE> of <NUMPAGES>" paragraph as every
    // other report type. footerLabelText (the period-range label) still doesn't apply to the
    // Proposal — no caller here sets data.period.label — so that piece remains ''.
    // color:var(--rpt-page-text) matches the token the live/PDF path uses for this chrome —
    // resolved to a real value below via resolveVars() (same helper used on bodyHtml above)
    // since this markup is assembled outside the resolveVars(rawBodyHtml) call.
    const footerLabelP = footerLabelText
      ? '<p class="MsoFooter" style="text-align:center;font-size:14px;color:var(--rpt-page-text);margin:2px 0 0">' +
        footerLabelText +
        '</p>'
      : '';
    // Real Word field codes (PAGE/NUMPAGES) instead of the old baked-in "Page N of Total"
    // string, so the number Word displays stays correct after Word repaginates the content at
    // its own metrics instead of always reading whatever page count this app estimated at
    // export time.
    // The format is "Page N of M" — Matt, 2026-08-03: "I wanted 'Page N of M'." An earlier pass
    // that day (f891b0a) stripped the words to a bare number to match the Louisburg baseline;
    // that was a misread of his report and is reverted. Both field codes are required: PAGE
    // alone cannot produce the "of M" half. See the footer-format comment above RPT_PAGENUM_DIV.
    const pageNumP = hasPageNum
      ? '<p class="MsoFooter" style="text-align:right;font-size:14px;color:var(--rpt-page-text);margin:2px 20px 0 0">' +
        "Page <span style='mso-field-code:PAGE'></span> of <span style='mso-field-code:NUMPAGES'></span></p>"
      : '';
    // footerBodyHtml is identical on the hero/title page and every interior page (rptPage()
    // renders the exact same footerImgHtml/footerLabelHtml/pagenum markup regardless of the
    // hero option) — one shared `f1` default footer definition is correct for every page now
    // that the distinct-first-page-footer mechanism (ff1) is gone (see above).
    const footerBodyHtml = footerImgHtmlWord + footerLabelP + pageNumP;
    const wordHeaderFooterHtml = resolveVars(
      // Header (every page): each page's own visible chrome — the hero page's inline letterhead
      // image, or an interior page's .rpt-int-hdr title bar — already lives in that page's body
      // content untouched, so the repeating Word header itself stays empty by design.
      '<div style="mso-element:header" id="h1"><p class="MsoHeader">&nbsp;</p></div>' +
        '<div style="mso-element:footer" id="f1">' +
        footerBodyHtml +
        '</div>',
    );
    // Word default-font fix (2026-07-26, measured: exported doc rendered in Times New Roman
    // even though the live/PDF path's `.rpt-page { font-family: var(--rpt-font) }` resolves to
    // a literal `'Segoe UI', Arial, sans-serif` list in the <style> block above).
    //
    // 2026-07-28 update: target font changed from Calibri to Arial 10.5pt to match the measured
    // CSC Letterhead.docx template (Arial 10.5pt body text — see docs/dashboardlogic.md
    // 2026-07-28 entry). The mechanism below (three belt-and-suspenders selectors) is unchanged;
    // only the font-family/font-size literals were swapped from Calibri/10.0pt to Arial/10.5pt.
    //
    // A `.rpt-page {font-family:Arial}` class rule ALONE was not enough (measured: unzipping
    // that attempt's document.xml showed w:docDefaults > w:rPrDefault > w:rFonts still
    // "Times New Roman" — Word's own hardcoded absolute fallback — and only a small minority of
    // runs had any override at all). Root cause: Word's HTML importer does not
    // fully compute CSS inheritance down through every level of this report's deeply nested
    // markup (.rpt-page > .rpt-body > section/table/paragraph elements, several levels deep) the
    // way a browser does — a class rule on an ancestor several levels above the actual text runs
    // frequently doesn't reach them. `.MsoChpDefault` is different: it is a special selector
    // Word's own "Save As Web Page" export always emits (see reference_filtered.htm, generated
    // via Word COM for comparison) to carry the document's absolute default character
    // properties — confirmed by test (varD_font.doc/.docx, 2026-07-26): declaring
    // `.MsoChpDefault {font-family:Arial; ...}` in the stylesheet changes
    // `w:docDefaults > w:rPrDefault > w:rFonts` to Arial even though no element in the body
    // ever carries that class. Since docDefaults is Word's fallback of last resort for any run
    // that doesn't inherit a font from somewhere else, this reliably makes Arial the base font
    // everywhere in the document — EXCEPT that a second, independent hardcoded override still
    // won out (measured on the real report even after adding .MsoChpDefault, unzipped again): the
    // auto-generated "Normal" PARAGRAPH STYLE itself (`w:styleId="Normal" w:default="1"`, what
    // every unstyled `<p>`/`<div>` implicitly uses) carried its OWN explicit
    // `w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"` baked directly into the
    // style — which wins over docDefaults for any run using that style, i.e. nearly every
    // paragraph in the document. `p.MsoNormal, li.MsoNormal, div.MsoNormal` is the second special
    // selector Word's own "Save As Web Page" export always emits (same reference_filtered.htm) to
    // define that exact "Normal" style's properties — confirmed by test (varD_font.doc/.docx):
    // adding it removes the Times New Roman override from the generated Normal style entirely,
    // leaving it to inherit Arial from docDefaults as intended. `.rpt-page`'s own rule is kept
    // too (belt-and-suspenders for the shallower cases where CSS inheritance IS picked up) —
    // headings, KPI numbers, tables, etc. all set their OWN font-size inline/via their own CSS
    // rules already and are unaffected by any of these three rules, so this does not flatten the
    // report's type hierarchy.
    const wordFontCss =
      '.MsoChpDefault {font-family:Arial, sans-serif; mso-ascii-font-family:Arial; ' +
      'mso-hansi-font-family:Arial; mso-bidi-font-family:Arial; font-size:10.5pt;} ' +
      'p.MsoNormal, li.MsoNormal, div.MsoNormal {font-family:Arial, sans-serif; mso-ascii-font-family:Arial; ' +
      'mso-hansi-font-family:Arial; mso-bidi-font-family:Arial; font-size:10.5pt;} ' +
      '.rpt-page {font-family:Arial, sans-serif; mso-ascii-font-family:Arial; ' +
      'mso-hansi-font-family:Arial; mso-bidi-font-family:Arial; font-size:10.5pt;} ' +
      // Belt #3 (2026-07-26, measured: even with .MsoChpDefault + p.MsoNormal fixing
      // w:docDefaults and the auto-generated "Normal" STYLE, unzipping still showed every
      // individual run's OWN w:rPr carrying an explicit, hardcoded
      // `w:rFonts w:ascii="Times New Roman"` — Word's legacy HTML engine applies its own
      // internal per-element-type default font (matching classic Trident/IE heading & paragraph
      // defaults) directly onto each run at conversion time, independent of both docDefaults and
      // the Normal style, and independent of the resolved `.rpt-page` ancestor's font-family
      // (CSS inheritance through several levels of nested divs/tables not fully honored — same
      // root cause noted above). An explicit rule naming every element type this report's markup
      // actually uses is what reaches those per-run overrides directly.
      'h1,h2,h3,h4,h5,h6,p,div,span,td,th,li,strong,b,em,i,a {font-family:Arial, sans-serif; ' +
      'mso-ascii-font-family:Arial; mso-hansi-font-family:Arial; mso-bidi-font-family:Arial;}';
    const wordOnlyCss =
      '@page Section1 {size:8.5in 11in; margin:0in 0in 0in 0in; mso-header-margin:0in; ' +
      'mso-footer-margin:0in; mso-paper-source:0; mso-header:h1; mso-footer:f1;} ' +
      'div.Section1 {page:Section1;} ' +
      wordFontCss;

    const wordDocHtml =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8">' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>' +
      '<w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
      '<style>' +
      css +
      ' body{background:#fff;margin:0;} .rpt-page-word-wrap{width:100%;} ' +
      wordOnlyCss +
      '</style>' +
      '<title>' +
      client +
      ' Report</title></head>' +
      '<body>' +
      '<div class="Section1">' +
      bodyHtml +
      '</div>' +
      // mso-element:header/footer source divs (h1/f1) placed AFTER (sibling of, not nested
      // inside) div.Section1 — this is the documented single-file technique for hand-authored
      // Word-openable HTML (distinct from what Word's OWN "Save As Web Page" produces, which
      // links to a separate external file instead — confirmed 2026-07-26 by generating a real
      // Word COM reference export (wdFormatHTML, format 8) and inspecting it; not usable here
      // since a single self-contained Blob download has no second file to link to). Not wrapped
      // in any extra grouping div — measured 2026-07-26 that Word's own "Web Page" export never
      // nests header/footer divs in a wrapper either (they're plain children of <body> in the
      // separate file it writes), so this mirrors that structure directly.
      //
      // TRAILING-DUPLICATE-PAGE FIX — see the long comment above wordHeaderFooterHtml's
      // construction for the full investigation. Summary: wrapping h1/f1(/fh1/ff1) in a div and
      // trying to hide that div (display:none / mso-hide:all, or moving it before div.Section1
      // instead of after) either left the duplicate visible, broke the real headers/footers, or
      // broke extraction entirely (zero header/footer parts). None of those are used now.
      // Nesting/position of h1/f1 themselves turned out NOT to control whether the duplicate
      // creates a new page — extraction always leaves a literal copy in body flow regardless;
      // what actually matters is the copy's rendered HEIGHT relative to the real last page's
      // remaining whitespace. Dropping the old fh1/ff1 first-page-header mechanism (see above)
      // cut that duplicate from three full-width images to one, which is what actually keeps the
      // page count correct — confirmed via rendered PDF on both the Proposal and Audit reports
      // (see verification notes for this change).
      wordHeaderFooterHtml +
      '</body></html>';

    const blob = new Blob(['﻿', wordDocHtml], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast('Report exported to Word ✓');
  } catch (err) {
    console.error('Word export failed:', err);
    showToast('Word export failed: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    tierDetailPanels.forEach((panel, i) => {
      panel.style.display = tierDetailPriorDisplay[i];
    });
    if (wordBtn) {
      wordBtn.disabled = false;
      wordBtn.textContent = originalBtnText || '📝 Export to Word';
    }
  }
}

/**
 * _rptResolveCssVarsAgainstRoot — replace every `var(--token)` in a string with the value that
 * token resolves to ON THE LIVE DOCUMENT, via getComputedStyle(document.documentElement).
 *
 * THIS IS THE TRAP THE GAUGE RASTERIZATION PROOF EXISTS TO WARN ABOUT (D-25, 2026-08-02).
 * The gauge ring's colors are written as `stroke="var(--rpt-orange)"` presentation attributes.
 * Chrome resolves those correctly while the SVG is in the live document, but the .docx export
 * works on DETACHED clones (pageEl.cloneNode(true)), and a detached element has no cascade: read
 * a var off the clone — getComputedStyle(clonedSvg), or clonedSvg.style.getPropertyValue — and
 * you get the empty string. Serialize that and the rasterizer draws a ring with NO stroke at all
 * (a transparent ring with black text), which is worse than the missing gauge it was meant to
 * fix, and it fails silently. Always resolve against document.documentElement, which is where
 * `:root { --rpt-*: ... }` in #report-styles actually lives.
 *
 * Distinct from _buildReportCssVarResolver above, which parses var DEFINITIONS out of a CSS text
 * blob for the mso-HTML path. This one asks the live CSSOM, so it also honors any runtime theme
 * override and needs no stylesheet text.
 */
function _rptResolveCssVarsAgainstRoot(text) {
  if (!text || text.indexOf('var(') === -1) return text;
  var rootStyle = getComputedStyle(document.documentElement);
  var cache = {};
  return text.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^()]*))?\)/g, function (whole, name, fallback) {
    if (!(name in cache)) cache[name] = (rootStyle.getPropertyValue(name) || '').trim();
    if (cache[name]) return cache[name];
    return fallback !== undefined ? fallback.trim() : whole;
  });
}

/** How many device pixels the gauge ring PNG carries per CSS pixel. 3x measured (D-25 proof,
 *  2026-08-02): a ring-only PNG comes out 330x383px for the cover's 110px gauge and the three
 *  cover rings together cost about 55.6KB — crisp in print, negligible in the package. */
var RPT_DOCX_GAUGE_RASTER_SCALE = 3;

/**
 * _rptSwapGaugeRingForPng — draw ONE gauge ring into a PNG and insert it immediately before the
 * <svg> it came from. Resolves with true on success, false on any failure (never rejects, never
 * hangs: a Word export must not be lost because a canvas misbehaved).
 *
 * RING ONLY. Every <text> is stripped from the rasterized copy and the original <svg> is LEFT IN
 * PLACE, because the docx translator's own <svg> branch (app/docx-writer.js) already emits that
 * svg's percentage as a real bold text run. So the number stays live, selectable, searchable and
 * restyleable text in Word — it is never baked into the picture — and the picture supplies only
 * the part Word genuinely cannot draw.
 */
function _rptSwapGaugeRingForPng(svgEl, scale) {
  var wCss = parseFloat(svgEl.getAttribute('width'));
  var hCss = parseFloat(svgEl.getAttribute('height'));
  if (!wCss || !hCss || !svgEl.parentNode) return Promise.resolve(false);

  var ring = svgEl.cloneNode(true);
  Array.prototype.slice.call(ring.querySelectorAll('text')).forEach(function (t) {
    if (t.parentNode) t.parentNode.removeChild(t);
  });
  ring.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!ring.getAttribute('viewBox')) ring.setAttribute('viewBox', '0 0 ' + wCss + ' ' + hCss);
  var pxW = Math.round(wCss * scale);
  var pxH = Math.round(hCss * scale);
  ring.setAttribute('width', String(pxW));
  ring.setAttribute('height', String(pxH));
  // Resolve --rpt-* AFTER serializing, against the live root — see the doc comment above.
  var markup = _rptResolveCssVarsAgainstRoot(new XMLSerializer().serializeToString(ring));

  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (ok) {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // A data-URL SVG cannot hit the network, but never let a stuck decode block the export.
    var timer = setTimeout(function () {
      finish(false);
    }, 5000);
    var img = new Image();
    img.onload = function () {
      clearTimeout(timer);
      try {
        var canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        var c2d = canvas.getContext('2d');
        c2d.drawImage(img, 0, 0, pxW, pxH);
        var out = document.createElement('img');
        out.setAttribute('src', canvas.toDataURL('image/png'));
        out.setAttribute('alt', 'Readiness ring');
        // Placed at the SVG's own CSS size, so 3x raster data lands in a 1x box and prints sharp.
        // _docxRegisterImage reads this inline width/height to size the OOXML drawing.
        out.setAttribute('style', 'display:block;margin:0 auto;width:' + wCss + 'px;height:' + hCss + 'px');
        svgEl.parentNode.insertBefore(out, svgEl);
        finish(true);
      } catch (e) {
        finish(false);
      }
    };
    img.onerror = function () {
      clearTimeout(timer);
      finish(false);
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  });
}

/**
 * _rptRasterizeGaugeRingsForDocx — DEFECTS-2026-08-02.md D-25: "Cover gauges are plain text in
 * the Word export" (Matt asked directly why the gauges are missing from the .docx).
 *
 * Word has no SVG: the OOXML translator drops the ring and keeps only the percentage, so the
 * Audit cover arrived in Word as three bare numbers in a borderless table. Nothing about the
 * embedding machinery needed to change — _docxRegisterImage / _docxEmbedImage / _docxImageRun /
 * _docxAssemble already embed any <img src="data:image/png;base64,..."> generically — so this is
 * only a rasterize-and-swap pass over the page clones, run before translation.
 *
 * Targets every <svg> that contains a <circle>, which is exactly the gauge rings (_a36GaugeSVG
 * and its "No Scope Required" N/A twin) and nothing else in these documents: the bar and line
 * charts are <rect>/<path>/<polyline>. A gauge that fails to rasterize simply keeps today's
 * behavior (percentage text, no ring) — degraded, never broken.
 *
 * @returns {Promise<{found:number, rasterized:number}>}
 */
async function _rptRasterizeGaugeRingsForDocx(pageEls, scale) {
  scale = scale || RPT_DOCX_GAUGE_RASTER_SCALE;
  var rings = [];
  pageEls.forEach(function (pageEl) {
    if (!pageEl.querySelectorAll) return;
    Array.prototype.forEach.call(pageEl.querySelectorAll('svg'), function (svg) {
      if (svg.querySelector('circle')) rings.push(svg);
    });
  });
  var rasterized = 0;
  for (var i = 0; i < rings.length; i++) {
    var ok = false;
    try {
      ok = await _rptSwapGaugeRingForPng(rings[i], scale);
    } catch (e) {
      ok = false;
    }
    if (ok) rasterized++;
  }
  if (rings.length && rasterized < rings.length && typeof console !== 'undefined' && console.warn) {
    console.warn(
      'Word export: ' +
        (rings.length - rasterized) +
        ' of ' +
        rings.length +
        ' gauge rings could not be rasterized; their percentages still export as text.',
    );
  }
  return { found: rings.length, rasterized: rasterized };
}

/**
 * exportReportToDocx — Word Export Rebuild plan Step 6 (first shipped document), wired for the
 * EMS Agreement (data._agreement). AI/_context/plans/word-export-rebuild-2026-07-30.md Part D
 * lines 306-311. Style authority: AI/_context/specs/csc-document-style-spec-2026-07-29.md.
 *
 * Produces a REAL OOXML .docx (app/docx-writer.js's _docxTranslatePages() DOM->OOXML translator
 * + _docxAssemble(), splicing generated word/document.xml body content into the CSC letterhead
 * skeleton, app/docx-skeleton.js, via JSZip) — NOT the mso-HTML ".doc wrapper" technique
 * exportReportToWord() above uses. That path is being retired per the plan (Part B: duplicate
 * footer, flex/SVG collapse, zero page margins, and un-measured px paragraph spacing are all
 * structural to mso-HTML import and cannot be patched further).
 *
 * Deliberately does NOT reuse any of exportReportToWord()'s workaround machinery
 * (_buildReportCssVarResolver, _fixPaddingUnits, _expandMarginShorthand, _insetChildren, the
 * wordHeaderFooterHtml mso-element construction, etc.) — every one of those exists solely to
 * compensate for gaps in Word's HTML *import* engine, which this path never touches. The
 * skeleton supplies real page margins (spec §1) and real header/footer parts (spec §2/§3) by
 * construction; _docxTranslatePages() reads the live DOM's actual element structure (tag names,
 * inline styles it explicitly recognizes, data-word-* hints) directly into OOXML primitives.
 *
 * Chrome the skeleton already supplies is stripped from each page clone before translation so it
 * is never ALSO emitted as body content (which would duplicate the letterhead and inflate file
 * size): .rpt-footer/.rpt-footer-label/.rpt-pg-footer-pagenum (skeleton's real footer1.xml/
 * footer2.xml + PAGE field already put a page number on every page, spec §3) and .rpt-small-hdr/
 * .csc-header-img (skeleton's real header2.xml/header3.xml already put the full letterhead on
 * page 1 and the wave band on pages 2+ by construction, spec §2c — nothing here needs to draw a
 * letterhead image itself). .rpt-pl (the "PAGE N" preview caption) is a sibling of .rpt-page, not
 * a descendant, so it is never selected in the first place.
 */
async function exportReportToDocx() {
  const data = window._currentReportData;
  if (!data) {
    showToast('No report data available');
    return;
  }

  const pagesContainer = document.getElementById('reportPages');
  const pages = pagesContainer ? pagesContainer.querySelectorAll('.rpt-page') : [];
  if (!pages.length) {
    showToast('No report pages to export');
    return;
  }

  // Same tier-detail force-expand as exportReportToPDF()/exportReportToWord() (see comment on
  // exportReportToPDF above): whichever tier(s) the user had collapsed in the live preview must
  // still render fully expanded in the exported document. Restored in `finally`. No-op for the
  // Agreement (has no tier-detail panels) — kept for the Proposal/Audit documents Steps 7-8 wire
  // through this same function next.
  const tierDetailPanels = document.querySelectorAll('#reportPages [id^="rpt-tier-detail-"]');
  const tierDetailPriorDisplay = [];
  tierDetailPanels.forEach((panel) => {
    tierDetailPriorDisplay.push(panel.style.display);
    panel.style.display = 'block';
  });

  showToast('Generating Word document...');

  try {
    if (typeof _docxTranslatePages !== 'function' || typeof _docxAssemble !== 'function') {
      throw new Error('docx-writer.js not loaded (_docxTranslatePages/_docxAssemble missing)');
    }

    const CHROME_SELECTORS = [
      '.rpt-footer',
      '.rpt-footer-label',
      '.rpt-pg-footer-pagenum',
      '.rpt-small-hdr',
      '.csc-header-img',
    ];
    const pageEls = [];
    pages.forEach((pageEl) => {
      const clone = pageEl.cloneNode(true);
      CHROME_SELECTORS.forEach((sel) => {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      });
      pageEls.push(clone);
    });

    // D-25 (R2, 2026-08-03): draw the gauge rings Word cannot draw. Must run BEFORE translation,
    // and must run on these clones while the live document (and therefore the --rpt-* cascade)
    // is still available to _rptResolveCssVarsAgainstRoot. Percentages stay live text.
    await _rptRasterizeGaugeRingsForDocx(pageEls);

    const translated = _docxTranslatePages(pageEls);

    const client = data.project.client || data.project.name || 'Report';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    let filename;
    if (data._agreement) {
      filename = client + ' - Energy Management Services Agreement ' + dateStr + '.docx';
    } else if (data._ashrae) {
      filename =
        data._ashrae.type === 'proposal'
          ? client + ' - Service Proposal ' + dateStr + '.docx'
          : client + ' - ASHRAE 36 Audit Report ' + dateStr + '.docx';
    } else {
      const typeLabel = data.period && data.period.type === 'quarterly' ? 'Quarterly' : 'Annual';
      filename = client + ' - ' + typeLabel + ' Savings Report ' + dateStr + '.docx';
    }

    await _docxAssemble(translated.xml, {
      filename: filename,
      images: translated.images,
      numIds: translated.numIds,
    });

    showToast('Word document generated ✓');
  } catch (err) {
    console.error('Word (.docx) export failed:', err);
    showToast('Word export failed: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    tierDetailPanels.forEach((panel, i) => {
      panel.style.display = tierDetailPriorDisplay[i];
    });
  }
}
window.exportReportToDocx = exportReportToDocx;

/* -- BOARD EXECUTIVE SUMMARY PAGE -- */

/**
 * boardSummaryBarChartSVG — builds an inline SVG bar chart showing monthly savings dollars.
 * @param {Array} monthData - Array of {label, value} (12 months)
 * @returns {string} SVG markup string
 */
function boardSummaryBarChartSVG(monthData) {
  var W = 560,
    H = 150,
    padL = 48,
    padR = 8,
    padT = 10,
    padB = 28;
  var chartW = W - padL - padR;
  var chartH = H - padT - padB;
  var n = monthData.length;
  if (n === 0) return '';

  var vals = monthData.map(function (d) {
    return d.value || 0;
  });
  var maxVal = Math.max.apply(null, vals.map(Math.abs));
  if (maxVal === 0) maxVal = 1;

  var barW = Math.floor(chartW / n) - 2;
  var zeroY = padT + chartH; // baseline at bottom (all-positive chart)

  // Y-axis grid lines (4 levels)
  var gridLines = '';
  var yLabels = '';
  for (var gi = 0; gi <= 4; gi++) {
    var gv = (maxVal / 4) * gi;
    var gy = padT + chartH - (gv / maxVal) * chartH;
    gridLines +=
      '<line x1="' +
      padL +
      '" y1="' +
      gy.toFixed(1) +
      '" x2="' +
      (W - padR) +
      '" y2="' +
      gy.toFixed(1) +
      '" stroke="var(--rpt-progress-bg)" stroke-width="0.5"/>';
    var labelText = gv >= 1000 ? '$' + (gv / 1000).toFixed(0) + 'k' : '$' + gv.toFixed(0);
    yLabels +=
      '<text x="' +
      (padL - 3) +
      '" y="' +
      (gy + 3).toFixed(1) +
      '" text-anchor="end" font-size="7" fill="var(--rpt-page-text)">' +
      labelText +
      '</text>';
  }

  var bars = '';
  var xLabels = '';
  for (var i = 0; i < n; i++) {
    var v = vals[i];
    var barColor = v >= 0 ? 'var(--rpt-green)' : 'var(--rpt-orange)';
    var barH = Math.max(1, (Math.abs(v) / maxVal) * chartH);
    var bx = padL + i * (chartW / n) + 1;
    var by = v >= 0 ? padT + chartH - barH : padT + chartH;
    bars +=
      '<rect x="' +
      bx.toFixed(1) +
      '" y="' +
      by.toFixed(1) +
      '" width="' +
      barW +
      '" height="' +
      barH.toFixed(1) +
      '" fill="' +
      barColor +
      '" rx="1"/>';
    var lx = bx + barW / 2;
    xLabels +=
      '<text x="' +
      lx.toFixed(1) +
      '" y="' +
      (H - 6) +
      '" text-anchor="middle" font-size="7" fill="var(--rpt-page-text)">' +
      (monthData[i].label || '') +
      '</text>';
  }

  return (
    '<svg width="' +
    W +
    '" height="' +
    H +
    '" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" xmlns="http://www.w3.org/2000/svg">' +
    gridLines +
    yLabels +
    bars +
    xLabels +
    '<line x1="' +
    padL +
    '" y1="' +
    padT +
    '" x2="' +
    padL +
    '" y2="' +
    (padT + chartH) +
    '" stroke="var(--rpt-page-text)" stroke-width="0.5"/>' +
    '<line x1="' +
    padL +
    '" y1="' +
    (padT + chartH) +
    '" x2="' +
    (W - padR) +
    '" y2="' +
    (padT + chartH) +
    '" stroke="var(--rpt-page-text)" stroke-width="0.5"/>' +
    '</svg>'
  );
}

/**
 * rptPageBoardSummary — single-page board-ready executive summary.
 * Dollar-forward, plain language, no internal metrics.
 * @param {number} n - Page number
 * @param {object} d - Report data from collectReportData()
 */
function rptPageBoardSummary(n, d) {
  var $c = function (v) {
    return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v || 0)).toLocaleString();
  };
  var $n = function (v) {
    return Math.round(Math.abs(v || 0)).toLocaleString();
  };

  // Contract progress
  var contractYears = (d.contract && d.contract.years) || 1;
  var currentYear = (d.contract && d.contract.currentYear) || 1;
  var pctDone = Math.min(100, Math.round((currentYear / contractYears) * 100));

  // Savings vs annual target
  var totalSavings = (d.totals && d.totals.savings) || 0;
  var annualTarget = (d.contract && d.contract.annualTarget) || 0;
  var savingsPct = annualTarget > 0 ? Math.min(100, Math.round((totalSavings / annualTarget) * 100)) : 0;
  var savingsColor =
    totalSavings >= annualTarget * 0.9
      ? 'var(--rpt-green-dark)'
      : totalSavings >= annualTarget * 0.6
        ? 'var(--rpt-orange)'
        : '#c0392b';

  // CO2 equivalents
  var pol = d.pollution && d.pollution.pollutants ? d.pollution.pollutants : {};
  var eq = d.pollution && d.pollution.equivalents ? d.pollution.equivalents : {};
  var co2Lbs = Math.round(pol.co2 || 0);
  var trees = Math.round(eq.treeSeedlings || 0);
  var cars = Math.round(eq.carsRemoved || 0);

  // Monthly savings bar chart — aggregate across all buildings
  // Uses mo.month (YYYY-MM) as the key — this is the field name used in the monthly arrays.
  var moNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var moMap = {};
  (d.buildings || []).forEach(function (b) {
    ((b.electric && b.electric.monthly) || []).forEach(function (mo) {
      var k = mo.month || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
    ((b.gas && b.gas.monthly) || []).forEach(function (mo) {
      var k = mo.month || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
    ((b.propane && b.propane.monthly) || []).forEach(function (mo) {
      var k = mo.month || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
  });
  // Filter to only the reporting-period months so the chart matches the selected quarter/period.
  // Fall back to the last 12 months if no period months are in the map.
  var periodYMs = (d.period && d.period.yearMonths) || [];
  var allSortedYMs = Object.keys(moMap).sort();
  var sortedYMs = periodYMs.length
    ? allSortedYMs.filter(function (ym) {
        return periodYMs.indexOf(ym) >= 0;
      })
    : allSortedYMs.slice(-12);
  if (!sortedYMs.length) sortedYMs = allSortedYMs.slice(-12);
  var chartData = sortedYMs.map(function (ym) {
    var mo = parseInt(ym.split('-')[1]) - 1;
    return { label: moNames[mo] || ym, value: moMap[ym] };
  });

  // Progress bar HTML helper
  function progressBar(pct, color, label) {
    return (
      '<div style="margin-bottom:6px">' +
      '<div style="font-size:10px;color:var(--rpt-page-text);margin-bottom:3px">' +
      label +
      '</div>' +
      '<div style="background:var(--rpt-progress-bg);border-radius:4px;height:12px;overflow:hidden">' +
      '<div style="width:' +
      Math.max(0, Math.min(100, pct)) +
      '%;height:100%;background:' +
      color +
      ';border-radius:4px;transition:width 0.3s"></div>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text);text-align:right;margin-top:2px">' +
      pct +
      '%</div>' +
      '</div>'
    );
  }

  // Mini-card HTML helper
  function miniCard(value, label, desc) {
    return (
      '<div style="flex:1;border:1px solid var(--rpt-progress-bg);border-radius:6px;padding:10px 8px;text-align:center">' +
      '<div style="font-size:22px;font-weight:800;color:var(--rpt-green-dark);font-family:monospace;line-height:1.1">' +
      value +
      '</div>' +
      '<div style="font-size:10px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em;margin:3px 0 2px">' +
      label +
      '</div>' +
      '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.4">' +
      desc +
      '</div>' +
      '</div>'
    );
  }

  var chartSVG =
    chartData.length > 0
      ? boardSummaryBarChartSVG(chartData)
      : '<div style="font-size:10px;color:var(--rpt-page-text);font-style:italic;text-align:center;padding:16px">No monthly savings data available.</div>';

  var bodyHTML =
    '<div contenteditable="true" style="padding:4px 48px">' +
    // Headline
    '<div style="text-align:center;margin-bottom:14px">' +
    '<div style="font-size:18px;font-weight:800;color:var(--rpt-blue);letter-spacing:0.01em">' +
    (d.project ? d.project.client : '') +
    '</div>' +
    '<div style="font-size:12px;color:var(--rpt-page-text);margin-top:2px">' +
    (d.period ? d.period.label : '') +
    '</div>' +
    '</div>' +
    // Two-column KPI row
    '<div style="display:flex;gap:16px;margin-bottom:14px">' +
    // Contract progress column
    '<div style="flex:1;border:1px solid var(--rpt-progress-bg);border-radius:6px;padding:12px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Contract Progress</div>' +
    progressBar(
      pctDone,
      'var(--rpt-blue-btn)',
      'Year ' + currentYear + ' of ' + contractYears + ' — Contract Completion',
    ) +
    progressBar(savingsPct, 'var(--rpt-green)', 'Annual Savings Target Progress') +
    '</div>' +
    // Total savings column
    '<div style="flex:1;border:1px solid var(--rpt-progress-bg);border-radius:6px;padding:12px;text-align:center">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Period Savings</div>' +
    '<div style="font-size:36px;font-weight:800;color:' +
    savingsColor +
    ';font-family:monospace;line-height:1.1">' +
    $c(totalSavings) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text);margin-top:4px">vs annual target of <strong>' +
    $c(annualTarget) +
    '</strong></div>' +
    '</div>' +
    '</div>' +
    // CO2 mini-cards
    '<div style="display:flex;gap:10px;margin-bottom:14px">' +
    miniCard(
      co2Lbs > 0 ? $n(co2Lbs) : '—',
      'Pounds of CO₂ Avoided',
      'Carbon dioxide emissions eliminated through energy savings',
    ) +
    miniCard(
      trees > 0 ? $n(trees) : '—',
      'Tree Equivalent',
      'Equivalent to growing this many tree seedlings for 10 years',
    ) +
    miniCard(
      cars > 0 ? $n(cars) : '—',
      'Cars Removed',
      'Equivalent to removing this many cars from the road for one year',
    ) +
    '</div>' +
    // Monthly savings chart
    '<div style="border:1px solid var(--rpt-progress-bg);border-radius:6px;padding:10px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Monthly Savings — Dollars Saved by Month</div>' +
    '<div style="text-align:center">' +
    chartSVG +
    '</div>' +
    '</div>' +
    '</div>';

  return rptPage(n, 'Board Executive Summary', bodyHTML, {
    data: d,
    hero: true,
    label: 'Page ' + n + ' — Board Executive Summary',
  });
}

/* -- QUARTERLY / ANNUAL PERFORMANCE REPORTS -- */

let _reportProjId = null,
  _reportType = null;

const REPORT_SECTIONS = [
  { key: 'boardSummary', label: 'Board Executive Summary', group: 'Executive' },
  { key: 'cover', label: 'Cover Page', group: 'Main' },
  { key: 'financial', label: 'Financial Summary', group: 'Main' },
  { key: 'savingsPerformance', label: 'Savings Performance', group: 'Main' },
  { key: 'euiBenchmarking', label: 'Site EUI Benchmarking', group: 'Main' },
  { key: 'environmentalImpact', label: 'Environmental Impact', group: 'Main' },
  { key: 'observations', label: 'Observations & Recommendations', group: 'Main' },
  { key: 'approvedChanges', label: 'Approved Changes', group: 'Main' },
  { key: 'contractProjection', label: 'Contract Projection', group: 'Main' },
  { key: 'setpoints', label: 'BAS Set Points & Schedules', group: 'Main' },
  { key: 'buildingSummaries', label: 'Per-Building Summaries (all)', group: 'Buildings' },
  { key: 'meterPerformance', label: 'Per-Building Meter Performance', group: 'Buildings' },
  { key: 'electricDetail', label: 'Electric Consumption Detail', group: 'Commodity' },
  { key: 'gasDetail', label: 'Gas Consumption Detail', group: 'Commodity' },
  { key: 'propaneDetail', label: 'Propane Consumption Detail', group: 'Commodity' },
  { key: 'appendixA', label: 'Appendix A: Normalization & Baseline', group: 'Appendices' },
  { key: 'appendixB', label: 'Appendix B: Regression Model Methodology', group: 'Appendices' },
  { key: 'appendixC', label: 'Appendix C: Weather Data', group: 'Appendices' },
  { key: 'appendixD', label: 'Appendix D: Utility Bills', group: 'Appendices', defaultOff: true },
];

// ---------------------------------------------------
// NEW REPORT GENERATION MODAL V2 — from Energy Graphics
// ---------------------------------------------------
// NEW REPORT GENERATION MODAL V2 — from Energy Graphics
// ═══════════════════════════════════════════════════

var _rptV2ProjId = null;

function openReportModalV2(projId) {
  _rptV2ProjId = projId;
  const p = projects.find((x) => x.id === projId);
  if (!p) {
    showToast('Project not found', 'error');
    return;
  }
  const bldgs = getUDBldgs(projId);
  if (!bldgs.length) {
    // Show the modal with an empty-state message instead of silently returning
    document.getElementById('reportGenModalBody').innerHTML =
      '<div style="text-align:center;padding:32px 16px">' +
      '<div style="font-size:36px;margin-bottom:12px">🏢</div>' +
      '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">No Buildings With Utility Data</div>' +
      '<div style="font-size:13px;color:var(--text2);line-height:1.5;max-width:360px;margin:0 auto">' +
      'To generate a report, first add buildings and enter utility bill data on the <strong>Utility Data</strong> tab, then set a baseline.' +
      '</div>' +
      '<button class="btn btn-em btn-sm" style="margin-top:18px" onclick="document.getElementById(\'reportGenModal\').classList.remove(\'open\');var b=document.querySelector(\'.pdt[data-tab=&quot;utility&quot;]\');if(b)b.click();">Go to Utility Data</button>' +
      '</div>';
    var previewBtn = document.querySelector('#reportGenModal .modal-ftr .btn-em');
    if (previewBtn) previewBtn.disabled = true;
    document.getElementById('reportGenModal').classList.add('open');
    return;
  }

  const templates = _getReportTemplates(projId);
  const now = new Date();
  const curYear = now.getFullYear();
  const curQ = Math.ceil((now.getMonth() + 1) / 3);

  let html = '';

  // Template selector
  html += '<div style="margin-bottom:14px">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">Template</div>';
  html +=
    '<select id="rptV2Template" onchange="_rptV2LoadTemplate(this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px">';
  html += '<option value="">— Custom —</option>';
  templates.forEach(function (t) {
    html += '<option value="' + t.name + '">' + t.name + '</option>';
  });
  html += '</select></div>';

  // Report type
  html += '<div style="margin-bottom:14px">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">Report Type</div>';
  html +=
    '<select id="rptV2Type" onchange="_rptV2TypeChanged()" style="width:100%;padding:7px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px">';
  html += '<option value="quarterly">Quarterly</option>';
  html += '<option value="annual">Annual</option>';
  html += '<option value="cumulative">Cumulative (Post-Baseline)</option>';
  html += '<option value="current">Current Period</option>';
  html += '<option value="custom">Custom Date Range</option>';
  html += '</select></div>';

  // Period controls (shown/hidden by type)
  html += '<div id="rptV2PeriodControls" style="margin-bottom:14px">';
  // Year picker
  html += '<div id="rptV2YearWrap" style="margin-bottom:8px">';
  html += '<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Year</div>';
  html +=
    '<select id="rptV2Year" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px">';
  for (var yr = curYear; yr >= curYear - 5; yr--) {
    html += '<option value="' + yr + '">' + yr + '</option>';
  }
  html += '</select></div>';
  // Quarter picker
  html += '<div id="rptV2QuarterWrap" style="margin-bottom:8px">';
  html += '<div style="font-size:12px;color:var(--text2);margin-bottom:4px">Quarter</div>';
  html +=
    '<select id="rptV2Quarter" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px">';
  for (var q = 1; q <= 4; q++) {
    html += '<option value="' + q + '"' + (q === curQ ? ' selected' : '') + '>Q' + q + '</option>';
  }
  html += '</select></div>';
  // Custom date range
  html += '<div id="rptV2CustomWrap" style="display:none;margin-bottom:8px">';
  html += '<div style="display:flex;gap:12px">';
  html += '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">Start Date</div>';
  html +=
    '<input type="date" id="rptV2StartDate" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px"></div>';
  html += '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">End Date</div>';
  html +=
    '<input type="date" id="rptV2EndDate" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px"></div>';
  html += '</div></div>';
  html += '</div>';

  // Buildings
  html += '<div style="margin-bottom:14px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
  html += '<span style="font-size:13px;font-weight:600;color:var(--text)">Buildings</span>';
  html += '<div style="display:flex;gap:6px">';
  html +=
    '<button onclick="_rptV2SelectAll(\'bldg\',true)" style="font-size:10px;padding:2px 6px;border:1px solid var(--s3);border-radius:4px;background:var(--s2);color:var(--text);cursor:pointer">All</button>';
  html +=
    '<button onclick="_rptV2SelectAll(\'bldg\',false)" style="font-size:10px;padding:2px 6px;border:1px solid var(--s3);border-radius:4px;background:var(--s2);color:var(--text);cursor:pointer">None</button>';
  html += '</div></div>';
  html += '<div style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto">';
  bldgs.forEach(function (b) {
    html +=
      '<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--s2);cursor:pointer">';
    html +=
      '<input type="checkbox" checked class="rptV2Bldg" data-bid="' +
      b.id +
      '" style="accent-color:var(--em);width:14px;height:14px">';
    html += '<span style="font-size:12px;color:var(--text)">' + (b.name || 'Unnamed') + '</span>';
    html +=
      '<span style="font-size:10px;color:var(--text3);margin-left:auto">' +
      (b.sqft ? parseInt(b.sqft).toLocaleString() + ' sf' : '') +
      '</span>';
    html += '</label>';
  });
  html += '</div></div>';

  // Report sections
  html += '<div style="margin-bottom:14px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
  html += '<span style="font-size:13px;font-weight:600;color:var(--text)">Report Sections</span>';
  html += '<div style="display:flex;gap:6px">';
  html +=
    '<button onclick="_rptV2SelectAll(\'sec\',true)" style="font-size:10px;padding:2px 6px;border:1px solid var(--s3);border-radius:4px;background:var(--s2);color:var(--text);cursor:pointer">All</button>';
  html +=
    '<button onclick="_rptV2SelectAll(\'sec\',false)" style="font-size:10px;padding:2px 6px;border:1px solid var(--s3);border-radius:4px;background:var(--s2);color:var(--text);cursor:pointer">None</button>';
  html += '</div></div>';
  html += '<div style="display:flex;flex-direction:column;gap:2px;max-height:250px;overflow-y:auto">';
  var lastGroup = null;
  REPORT_SECTIONS.forEach(function (sec) {
    if (sec.group !== lastGroup) {
      html +=
        '<div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;padding:6px 8px 2px">' +
        sec.group +
        '</div>';
      lastGroup = sec.group;
    }
    var checked = sec.defaultOff ? '' : 'checked';
    var emptyWarn = '';
    if (sec.key === 'approvedChanges') {
      if (!p || !(p.approvedChanges && p.approvedChanges.length > 0))
        emptyWarn = _rptV2WarnHtml(projId, 'docs', 'approved');
    }
    if (sec.key === 'setpoints') {
      if (!p || !(p.setpoints && p.setpoints.length > 0)) emptyWarn = _rptV2WarnHtml(projId, 'setpoints', null);
    }
    if (sec.key === 'contractProjection') {
      if (!p || !p.start) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'electricDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Electric')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'gasDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Gas')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'propaneDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Propane')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    html +=
      '<label style="display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:4px;background:var(--s2);cursor:pointer">';
    html +=
      '<input type="checkbox" ' +
      checked +
      ' class="rptV2Sec" data-section="' +
      sec.key +
      '" style="accent-color:var(--em);width:14px;height:14px">';
    html += '<span style="font-size:12px;color:var(--text)">' + sec.label + '</span>';
    html += emptyWarn;
    html += '</label>';
  });
  html += '</div></div>';

  // Pollution credits mode
  html += '<div style="margin-bottom:8px">';
  html += '<div style="font-size:12px;color:var(--text2);margin-bottom:4px;font-weight:600">Pollution Credits</div>';
  html += '<div style="display:flex;gap:12px">';
  html +=
    '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:var(--text)"><input type="radio" name="rptV2Pollution" value="period" checked style="accent-color:var(--em)"> Period-only</label>';
  html +=
    '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:var(--text)"><input type="radio" name="rptV2Pollution" value="annualized" style="accent-color:var(--em)"> Annualized</label>';
  html += '</div></div>';

  document.getElementById('reportGenModalBody').innerHTML = html;
  var previewBtn = document.querySelector('#reportGenModal .modal-ftr .btn-em');
  if (previewBtn) previewBtn.disabled = false;
  document.getElementById('reportGenModal').classList.add('open');
  _rptV2TypeChanged();
}

function _rptV2TypeChanged() {
  var type = document.getElementById('rptV2Type').value;
  var yearWrap = document.getElementById('rptV2YearWrap');
  var quarterWrap = document.getElementById('rptV2QuarterWrap');
  var customWrap = document.getElementById('rptV2CustomWrap');
  if (type === 'quarterly') {
    yearWrap.style.display = '';
    quarterWrap.style.display = '';
    customWrap.style.display = 'none';
  } else if (type === 'annual') {
    yearWrap.style.display = '';
    quarterWrap.style.display = 'none';
    customWrap.style.display = 'none';
  } else if (type === 'custom') {
    yearWrap.style.display = 'none';
    quarterWrap.style.display = 'none';
    customWrap.style.display = '';
  } else {
    yearWrap.style.display = 'none';
    quarterWrap.style.display = 'none';
    customWrap.style.display = 'none';
  }
}

function _rptV2SelectAll(group, checked) {
  var cls = group === 'bldg' ? '.rptV2Bldg' : '.rptV2Sec';
  document.querySelectorAll(cls).forEach(function (cb) {
    cb.checked = checked;
  });
}

function _rptV2WarnHtml(projId, tab, subTab) {
  var callArgs = subTab ? projId + ",'" + tab + "','" + subTab + "'" : projId + ",'" + tab + "'";
  return (
    '<span style="display:flex;align-items:center;gap:4px;margin-left:auto">' +
    '<span style="font-size:10px;color:var(--warn);font-weight:600">? Empty</span>' +
    '<button type="button" onclick="event.preventDefault();event.stopPropagation();_rptV2GoEdit(' +
    callArgs +
    ')" style="font-size:10px;padding:1px 6px;border:1px solid var(--s3);border-radius:4px;background:var(--s2);color:var(--em);cursor:pointer;font-weight:600;line-height:1.4">Edit ?</button>' +
    '</span>'
  );
}

function _rptHasMeterWithBaseline(projId, commodity) {
  var bldgs = getUDBldgs(projId);
  return bldgs.some(function (b) {
    return (b.meters || []).some(function (m) {
      return m.commodity === commodity && m.baseline && m.baseline.months && m.baseline.months.length >= 3;
    });
  });
}

function _rptV2GoEdit(projId, tab, subTab) {
  // Open a centered popup window so user can edit data while the report modal stays open
  var url = window.location.pathname + '?openProject=' + encodeURIComponent(projId) + '&tab=' + encodeURIComponent(tab);
  if (subTab) url += '&subTab=' + encodeURIComponent(subTab);
  var pw = 1200,
    ph = 800;
  var left = Math.max(0, window.screenX + Math.round((window.outerWidth - pw) / 2));
  var top = Math.max(0, window.screenY + Math.round((window.outerHeight - ph) / 2));
  window.open(
    url,
    'rptEditPopup',
    'width=' + pw + ',height=' + ph + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes',
  );
}

function _rptV2LoadTemplate(name) {
  if (!name || !_rptV2ProjId) return;
  var tpl = _loadReportTemplate(_rptV2ProjId, name);
  if (!tpl) return;
  // Apply report type
  var typeEl = document.getElementById('rptV2Type');
  if (tpl.reportType && typeEl) {
    typeEl.value = tpl.reportType;
    _rptV2TypeChanged();
  }
  // Apply sections
  if (tpl.sections) {
    document.querySelectorAll('.rptV2Sec').forEach(function (cb) {
      var key = cb.getAttribute('data-section');
      cb.checked = tpl.sections.indexOf(key) >= 0;
    });
  }
  // Apply buildings
  if (tpl.buildingIds) {
    document.querySelectorAll('.rptV2Bldg').forEach(function (cb) {
      var bid = cb.getAttribute('data-bid');
      cb.checked = tpl.buildingIds.indexOf(bid) >= 0;
    });
  }
}

function _rptV2ReadConfig() {
  var type = document.getElementById('rptV2Type').value;
  var year = parseInt(document.getElementById('rptV2Year').value);
  var quarter = parseInt(document.getElementById('rptV2Quarter').value);
  var startDate = document.getElementById('rptV2StartDate').value;
  var endDate = document.getElementById('rptV2EndDate').value;
  var buildingIds = [];
  document.querySelectorAll('.rptV2Bldg:checked').forEach(function (cb) {
    buildingIds.push(cb.getAttribute('data-bid'));
  });
  var sections = [];
  var sectionOrder = [];
  document.querySelectorAll('.rptV2Sec:checked').forEach(function (cb) {
    var key = cb.getAttribute('data-section');
    sections.push(key);
    sectionOrder.push(key);
  });
  var pollutionMode = 'period';
  var polRadio = document.querySelector('input[name="rptV2Pollution"]:checked');
  if (polRadio) pollutionMode = polRadio.value;

  var periodLabel = '';
  if (type === 'quarterly') periodLabel = 'Q' + quarter + ' ' + year;
  else if (type === 'annual') periodLabel = year + '';
  else if (type === 'cumulative') periodLabel = 'Cumulative';
  else if (type === 'current') periodLabel = 'Current Period';
  else if (type === 'custom') periodLabel = startDate + ' to ' + endDate;

  var p = projects.find(function (x) {
    return x.id === _rptV2ProjId;
  });
  return {
    projId: _rptV2ProjId,
    clientName: p ? p.client || p.name : 'Report',
    reportType: type,
    year: year,
    quarter: quarter,
    startDate: startDate,
    endDate: endDate,
    buildingIds: buildingIds,
    sections: sections,
    sectionOrder: sectionOrder,
    pollutionMode: pollutionMode,
    periodLabel: periodLabel,
    customText: {},
  };
}

// Template CRUD
function _getReportTemplates(projId) {
  return sget('en_report_templates_' + projId, []);
}

function _saveReportTemplateData(projId, template) {
  var templates = _getReportTemplates(projId);
  var idx = -1;
  for (var i = 0; i < templates.length; i++) {
    if (templates[i].name === template.name) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  sset('en_report_templates_' + projId, templates);
}

function _loadReportTemplate(projId, name) {
  var templates = _getReportTemplates(projId);
  for (var i = 0; i < templates.length; i++) {
    if (templates[i].name === name) return templates[i];
  }
  return null;
}

function _deleteReportTemplate(projId, name) {
  var templates = _getReportTemplates(projId).filter(function (t) {
    return t.name !== name;
  });
  sset('en_report_templates_' + projId, templates);
}

function openReportModal(projId, type) {
  _reportProjId = projId;
  _reportType = type;
  const bldgs = getUDBldgs(projId);
  const list = document.getElementById('reportBldgList');
  if (!bldgs.length) {
    showToast('No buildings with utility data');
    return;
  }

  // Populate building checkboxes
  list.innerHTML = bldgs
    .map(
      (
        b,
      ) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:var(--s2);cursor:pointer">
          <input type="checkbox" checked data-bid="${b.id}" style="accent-color:var(--em);width:16px;height:16px">
          <span style="font-size:13px;color:var(--text)">${b.name || 'Unnamed'}</span>
          <span style="font-size:11px;color:var(--text3);margin-left:auto">${b.sqft ? parseInt(b.sqft).toLocaleString() + ' sf' : ''}</span>
        </label>`,
    )
    .join('');

  // Populate section checkboxes with group headers
  const p = projects.find((x) => x.id === projId);
  const savedSections = p && p.reportDefaults && p.reportDefaults.sections ? p.reportDefaults.sections : {};
  const sectionList = document.getElementById('reportSectionList');
  let lastGroup = null;
  let sectionHTML = '';
  REPORT_SECTIONS.forEach((sec) => {
    if (sec.group !== lastGroup) {
      sectionHTML += `<div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;padding:6px 8px 2px">${sec.group}</div>`;
      lastGroup = sec.group;
    }
    const isChecked =
      sec.key in savedSections ? (savedSections[sec.key] === false ? '' : 'checked') : sec.defaultOff ? '' : 'checked';
    let emptyWarn = '';
    if (sec.key === 'approvedChanges') {
      const hasChanges = p && p.approvedChanges && p.approvedChanges.length > 0;
      if (!hasChanges) emptyWarn = _rptV2WarnHtml(projId, 'docs', 'approved');
    }
    if (sec.key === 'setpoints') {
      const hasSetpoints = p && p.setpoints && p.setpoints.length > 0;
      if (!hasSetpoints) emptyWarn = _rptV2WarnHtml(projId, 'setpoints', null);
    }
    if (sec.key === 'contractProjection') {
      if (!p || !p.start) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'electricDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Electric')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'gasDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Gas')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    if (sec.key === 'propaneDetail') {
      if (!_rptHasMeterWithBaseline(projId, 'Propane')) emptyWarn = _rptV2WarnHtml(projId, 'utility', null);
    }
    sectionHTML += `<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--s2);cursor:pointer">
            <input type="checkbox" ${isChecked} data-section="${sec.key}" style="accent-color:var(--em);width:14px;height:14px">
            <span style="font-size:12px;color:var(--text)">${sec.label}</span>
            ${emptyWarn}
          </label>`;
  });
  sectionList.innerHTML = sectionHTML;

  // Set modal title and defaults
  document.querySelector('#reportBldgModal .modal-title').textContent =
    type === 'quarterly' ? 'Generate Quarterly Report' : 'Generate Annual Report';

  // Set report type radio
  const radioVal = type === 'annual' ? 'annual' : 'quarterly';
  const radio = document.querySelector(`input[name="reportType"][value="${radioVal}"]`);
  if (radio) radio.checked = true;

  // Default report date to today
  const today = new Date();
  document.getElementById('reportDateInput').value = today.toISOString().slice(0, 10);

  document.getElementById('reportBldgModal').classList.add('open');
}

function _rptGoEdit(projId, tab) {
  document.getElementById('reportBldgModal').classList.remove('open');
  openDetail(projId);
  requestAnimationFrame(function () {
    const actualTab = tab === 'docs' ? 'docs' : tab;
    const btn = document.querySelector('#pdTabBar button[data-tab="' + actualTab + '"]');
    sPTab(actualTab, btn || null);
    if (tab === 'docs') {
      window._docsSubTab = 'approved';
      renderDocsSubTab('approved', projId);
    }
    const labels = { docs: 'Approved Changes (Documents tab)', setpoints: 'Set Points & Schedules tab' };
    showToast('Add data in the ' + (labels[tab] || tab) + ', then reopen Generate Report');
  });
}

function rptSelectAll(checked) {
  document.querySelectorAll('#reportSectionList input[type=checkbox]').forEach((cb) => (cb.checked = checked));
}

async function launchNewReport() {
  // Get report type
  const typeRadio = document.querySelector('input[name="reportType"]:checked');
  const type = typeRadio ? typeRadio.value : 'quarterly';

  // Get selected buildings
  const bldgChecks = document.querySelectorAll('#reportBldgList input[type=checkbox]:checked');
  const buildingIds = Array.from(bldgChecks).map((c) => c.dataset.bid);
  if (!buildingIds.length) {
    showToast('Select at least one building');
    return;
  }

  // Get selected sections
  const selectedSections = {};
  document.querySelectorAll('#reportSectionList input[type=checkbox]').forEach((cb) => {
    selectedSections[cb.dataset.section] = cb.checked;
  });

  // Save section preferences to project
  const p = projects.find((x) => x.id === _reportProjId);
  if (p) {
    p.reportDefaults = { sections: selectedSections };
    sset('en_projects', projects);
  }

  // Get report generation settings
  var rptOpts = {
    annualizePollution: !!(document.getElementById('rptOptAnnualizePollution') || {}).checked,
    blCommodities: {
      electric: !!(document.getElementById('rptOptBlElectric') || {}).checked,
      gas: !!(document.getElementById('rptOptBlGas') || {}).checked,
      propane: !!(document.getElementById('rptOptBlPropane') || {}).checked,
      water: !!(document.getElementById('rptOptBlWater') || {}).checked,
    },
  };

  // Get report date
  const reportDate = document.getElementById('reportDateInput').value || null;

  // Close modal
  document.getElementById('reportBldgModal').classList.remove('open');

  // Collect data and generate report
  const data = collectReportData(_reportProjId, buildingIds, reportDate, type);
  if (!data) {
    showToast('Could not collect report data');
    return;
  }

  // Attach report options for rendering
  data.reportOptions = rptOpts;

  // Load bill PDF thumbnails for Appendix D
  if (selectedSections.appendixD !== false && data.rawBills && data.rawBills.length) {
    showToast('Loading bill images...');
    var _billsWithPdf = data.rawBills.filter(function (b) {
      return b.pdfKey;
    });
    for (var _bi = 0; _bi < _billsWithPdf.length; _bi++) {
      try {
        var _pdfB64 = await pdfLoad(_billsWithPdf[_bi].pdfKey);
        if (!_pdfB64) continue;
        var _raw = atob(_pdfB64.split(',').pop());
        var _arr = new Uint8Array(_raw.length);
        for (var _ci = 0; _ci < _raw.length; _ci++) _arr[_ci] = _raw.charCodeAt(_ci);
        var _pdf = await pdfjsLib.getDocument({ data: _arr, useWorkerFetch: false, isEvalSupported: false }).promise;
        var _pg = await _pdf.getPage(1);
        var _vp = _pg.getViewport({ scale: 0.5 });
        var _canvas = document.createElement('canvas');
        _canvas.width = _vp.width;
        _canvas.height = _vp.height;
        await _pg.render({ canvasContext: _canvas.getContext('2d'), viewport: _vp }).promise;
        _billsWithPdf[_bi].pdfImage = _canvas.toDataURL('image/jpeg', 0.6);
      } catch (_e) {
        /* skip failed PDFs */
      }
    }
  }

  // Store for PDF export
  window._currentReportData = data;

  // Generate and show
  const html = generateReportHTML(data, selectedSections);
  const title = `${data.project.client} — ${data.period.label} ${type === 'quarterly' ? 'Quarterly' : 'Annual'} Report`;
  showReportOverlay(html, title);
}

function launchReport() {
  const checks = document.querySelectorAll('#reportBldgList input[type=checkbox]:checked');
  const ids = Array.from(checks).map((c) => c.dataset.bid);
  if (!ids.length) {
    showToast('Select at least one building');
    return;
  }
  const reportDate = document.getElementById('reportDateInput').value || null;
  document.getElementById('reportBldgModal').classList.remove('open');
  _legacyGeneratePerformanceReport(_reportProjId, _reportType, ids, reportDate);
}

// Legacy report generator — kept as fallback, replaced by new template-engine system (Tasks 1-21)
function _legacyGeneratePerformanceReport(projId, type, buildingIds, reportDateStr) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  let bldgs = getUDBldgs(projId);
  if (buildingIds && buildingIds.length) bldgs = bldgs.filter((b) => buildingIds.includes(String(b.id)));
  const useNormalized = p.baselineComparison === 'normalized';
  if (!bldgs.length) {
    showToast('No buildings with utility data');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pw = 612,
    ph = 792,
    ml = 54,
    mr = 40;
  const contentW = pw - ml - mr;
  const now = new Date();
  const monthNames = [
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
  const $c = (n) => '$' + Math.round(Math.abs(n)).toLocaleString();
  const periodMonths = type === 'quarterly' ? 3 : 12;
  let y = 36;
  let pageNum = 1;

  function addFooter() {
    try {
      // 2026-07-10: CSC_FOOTER_B64 was re-cropped to ~19.99:1 (was 7.585:1) as part of the
      // Audit Report footer-squish fix (app/csv-import.js). jsPDF addImage stretches to the
      // given w/h like html2canvas does, so the footer height here must track the asset's
      // real ratio (pw / 19.99 ≈ 30.6pt) instead of the old hardcoded 55pt, or this legacy
      // export path would now distort the image the other way (too tall).
      var _footerH = pw / 19.99;
      doc.addImage(CSC_FOOTER_B64, 'JPEG', 0, ph - _footerH, pw, _footerH);
    } catch (e) {}
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text('Page ' + pageNum, pw / 2, ph - 8, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }
  function newPage() {
    addFooter();
    doc.addPage();
    pageNum++;
    y = 40;
  }
  function checkPage(needed) {
    if (y + needed > ph - 70) newPage();
  }

  // -------------------------------------------
  // GATHER ALL DATA UP FRONT
  // -------------------------------------------

  let allPostYMs = [];
  const allBldgMeters = [];
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      // Only include energy commodities — exclude water, sewer, stormwater
      const energyCommodities = ['Electric', 'Gas', 'Propane'];
      if (!energyCommodities.includes(m.commodity)) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const bills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const incl = m.inclusive !== false;
      const allRows = bills.length ? getNormRows(m, bills, incl, null) : [];
      const blEnd = bl.months.slice().sort().pop();
      const postRows = allRows.filter((r) => r.ym > blEnd);
      postRows.forEach((r) => {
        if (!allPostYMs.includes(r.ym)) allPostYMs.push(r.ym);
      });
      allBldgMeters.push({ b, m, bills, incl, allRows, bl, blEnd, postRows });
    });
  });
  allPostYMs.sort();

  // Reporting period = most recent complete calendar quarter (or year for annual)
  let reportYMs = [];
  if (type === 'quarterly') {
    // Find most recent complete calendar quarter with data
    // Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
    const curQ = Math.ceil((now.getMonth() + 1) / 3);
    const curYr = now.getFullYear();
    // Start from current quarter and go backwards to find the most recent complete quarter with data
    for (let attempt = 0; attempt < 8; attempt++) {
      let qNum = curQ - attempt;
      let yr = curYr;
      while (qNum <= 0) {
        qNum += 4;
        yr--;
      }
      const startMo = (qNum - 1) * 3 + 1;
      const qYMs = [
        yr + '-' + String(startMo).padStart(2, '0'),
        yr + '-' + String(startMo + 1).padStart(2, '0'),
        yr + '-' + String(startMo + 2).padStart(2, '0'),
      ];
      // Check if we have data for at least 1 month in this quarter
      const hasData = qYMs.some((ym) => allPostYMs.includes(ym));
      // Don't use the current quarter if it's incomplete (we're still in it)
      const isCurrent = yr === curYr && qNum === curQ;
      if (hasData && !isCurrent) {
        reportYMs = qYMs.filter((ym) => allPostYMs.includes(ym));
        // Use full quarter even if not all months have data yet
        if (reportYMs.length === 0) continue;
        // Store the full quarter label info
        reportYMs._qLabel = 'Q' + qNum + ' ' + yr;
        reportYMs._qStartMo = startMo;
        reportYMs._qYear = yr;
        break;
      }
    }
    // Fallback: if no complete quarter found, use the most recent 3 months
    if (!reportYMs.length) reportYMs = allPostYMs.slice(-3);
  } else {
    reportYMs = allPostYMs.slice(-12);
  }
  const reportStart = reportYMs[0] || '';
  const reportEnd = reportYMs[reportYMs.length - 1] || '';
  let periodLabel = '';
  if (type === 'quarterly' && reportYMs._qStartMo) {
    const qStart = monthNames[reportYMs._qStartMo - 1];
    const qEnd = monthNames[reportYMs._qStartMo + 1];
    periodLabel = qStart + ' - ' + qEnd + ' ' + reportYMs._qYear;
  } else {
    const rpStartMonth = reportStart ? monthNames[parseInt(reportStart.split('-')[1]) - 1] : '';
    const rpStartYear = reportStart ? reportStart.split('-')[0] : '';
    const rpEndMonth = reportEnd ? monthNames[parseInt(reportEnd.split('-')[1]) - 1] : '';
    const rpEndYear = reportEnd ? reportEnd.split('-')[0] : '';
    periodLabel =
      rpStartYear === rpEndYear
        ? rpStartMonth + ' - ' + rpEndMonth + ' ' + rpEndYear
        : rpStartMonth + ' ' + rpStartYear + ' - ' + rpEndMonth + ' ' + rpEndYear;
  }

  // Compute per-building data
  const totalSqft = bldgs.reduce((s, b) => s + parseInt(b.sqft || 0), 0);

  const bldgData = bldgs.map((b) => {
    const sqft = parseInt(b.sqft || 0);
    const bType = b.type || p.type || 'Other';
    let cumSavings = 0,
      qtrSavings = 0;
    let annBlKBtu = 0,
      annCurKBtu = 0;
    const meterDetails = [];
    const savByYM = {};
    const yearUsage = {};
    const yearMonthCount = {};

    const bMeters = allBldgMeters.filter((x) => x.b === b);
    bMeters.forEach(({ m, bills, incl, allRows, bl, blEnd, postRows }) => {
      const blRows = allRows.filter((r) => bl.months.includes(r.ym));
      const { elecByMo: eM, gasByMo: gM, propaneByMo: pM } = buildMoMap(m, blRows, bills, incl);

      const mSavByYM = getMeterSavings(m, bills, incl, projId, b.id).byYM;
      Object.entries(mSavByYM).forEach(([ym, v]) => {
        if (!savByYM[ym]) savByYM[ym] = 0;
        savByYM[ym] += v;
        cumSavings += v;
        if (reportYMs.includes(ym)) qtrSavings += v;
      });

      // Annual EUI - rolling 12 months and per-year
      const blBills = _dashGetBaselineBills(m);
      if (m.commodity === 'Gas') {
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(0, parseFloat(bill.therms) || 0, 0);
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(0, parseFloat(bill.therms) || 0, 0);
        });
        bills.forEach((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          if (!ym) return;
          const yr = ym.split('-')[0];
          if (!yearUsage[yr]) yearUsage[yr] = { kwh: 0, therms: 0, propaneGal: 0 };
          yearUsage[yr].therms += parseFloat(bill.therms) || 0;
          if (!yearMonthCount[yr]) yearMonthCount[yr] = new Set();
          yearMonthCount[yr].add(ym);
        });
      } else if (m.commodity === 'Propane') {
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(
            0,
            0,
            parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0,
          );
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(
            0,
            0,
            parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0,
          );
        });
        bills.forEach((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          if (!ym) return;
          const yr = ym.split('-')[0];
          if (!yearUsage[yr]) yearUsage[yr] = { kwh: 0, therms: 0, propaneGal: 0 };
          yearUsage[yr].propaneGal +=
            parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          if (!yearMonthCount[yr]) yearMonthCount[yr] = new Set();
          yearMonthCount[yr].add(ym);
        });
      } else {
        blBills.forEach((bill) => {
          annBlKBtu += toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
        });
        const last12 = bills.filter((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          return ym && allPostYMs.includes(ym) && allPostYMs.indexOf(ym) >= allPostYMs.length - 12;
        });
        last12.forEach((bill) => {
          annCurKBtu += toKBtu(parseFloat(bill.kwh) || parseFloat(bill.usage) || 0, 0, 0);
        });
        bills.forEach((bill) => {
          const ym = normMonth(bill.start, bill.end, incl, bills);
          if (!ym) return;
          const yr = ym.split('-')[0];
          if (!yearUsage[yr]) yearUsage[yr] = { kwh: 0, therms: 0, propaneGal: 0 };
          yearUsage[yr].kwh += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
          if (!yearMonthCount[yr]) yearMonthCount[yr] = new Set();
          yearMonthCount[yr].add(ym);
        });
      }

      // Baseline methodology details for appendix
      // Check both frozen reg and runtime reg, prefer whichever has data
      const frozenReg = bl.reg && (bl.reg.hdd || bl.reg.cdd || bl.reg.dual) ? bl.reg : null;
      const runtimeReg = m._reg && (m._reg.hdd || m._reg.cdd || m._reg.dual) ? m._reg : null;
      const regObj = frozenReg || runtimeReg || {};
      const hasHDD = !!(regObj.hdd && regObj.hdd.r2 != null);
      const hasCDD = !!(regObj.cdd && regObj.cdd.r2 != null);
      const hasDual = !!(regObj.dual && regObj.dual.r2 != null);
      let regrType = 'Simple Average';
      let r2 = null;
      let slope = null,
        intercept = null;
      if (hasDual && regObj.dual.r2 > (hasHDD ? regObj.hdd.r2 : 0) && regObj.dual.r2 > (hasCDD ? regObj.cdd.r2 : 0)) {
        regrType = 'Dual (HDD + CDD)';
        r2 = regObj.dual.r2;
        slope = 'HDD: ' + (regObj.dual.slopeHDD || 0).toFixed(4) + ', CDD: ' + (regObj.dual.slopeCDD || 0).toFixed(4);
        intercept = (regObj.dual.intercept || 0).toFixed(2);
      } else if (m.commodity === 'Gas' && hasHDD) {
        regrType = 'HDD Regression';
        r2 = regObj.hdd.r2;
        slope = (regObj.hdd.slope || 0).toFixed(4);
        intercept = (regObj.hdd.intercept || 0).toFixed(2);
      } else if (m.commodity === 'Electric' && hasCDD) {
        regrType = 'CDD Regression';
        r2 = regObj.cdd.r2;
        slope = (regObj.cdd.slope || 0).toFixed(4);
        intercept = (regObj.cdd.intercept || 0).toFixed(2);
      } else if (hasHDD) {
        regrType = 'HDD Regression';
        r2 = regObj.hdd.r2;
        slope = (regObj.hdd.slope || 0).toFixed(4);
        intercept = (regObj.hdd.intercept || 0).toFixed(2);
      } else if (hasCDD) {
        regrType = 'CDD Regression';
        r2 = regObj.cdd.r2;
        slope = (regObj.cdd.slope || 0).toFixed(4);
        intercept = (regObj.cdd.intercept || 0).toFixed(2);
      }
      const blSorted = bl.months.slice().sort();
      // Format period as "January 2025 - December 2025"
      const fmtYM = (ym) => {
        const [yr, mo] = ym.split('-');
        return monthNames[parseInt(mo) - 1] + ' ' + yr;
      };
      const blPeriodFmt = blSorted.length ? fmtYM(blSorted[0]) + ' - ' + fmtYM(blSorted[blSorted.length - 1]) : '-';
      let blHDD = 0,
        blCDD = 0,
        blAnnCost = 0,
        blAnnUsage = 0;
      const blRowsForMeter = allRows.filter((r) => bl.months.includes(r.ym));
      blRowsForMeter.forEach((r) => {
        blHDD += r.hdd || 0;
        blCDD += r.cdd || 0;
        blAnnCost += r.cost || 0;
        blAnnUsage += r.usage || 0;
      });
      const usageUnit = m.commodity === 'Gas' ? 'therms' : m.commodity === 'Propane' ? 'gal' : 'kWh';
      meterDetails.push({
        meterName: [m.commodity, m.provider, m.account ? 'Account# ' + m.account : m.meter ? 'Meter# ' + m.meter : '']
          .filter(Boolean)
          .join(' - '),
        commodity: m.commodity,
        blPeriod: blPeriodFmt,
        method: useNormalized ? 'Weather-Normalized' : 'Actual Comparison',
        regrType,
        r2,
        slope,
        intercept,
        blHDD,
        blCDD,
        blAnnCost,
        blAnnUsage,
        usageUnit,
        blMonthCount: bl.months.length,
      });
    });

    const blEUI = sqft > 0 ? annBlKBtu / sqft : 0;
    const curEUI = sqft > 0 ? annCurKBtu / sqft : 0;
    const cbecsEUI = CBECS_EUI[bType] || CBECS_EUI['Other'] || 52.4;
    const pctiles = CBECS_PERCENTILES[bType] || CBECS_PERCENTILES['Other'] || [28, 52.4, 80];
    const estarEUI = typeof ESTAR_EUI !== 'undefined' ? ESTAR_EUI[bType] || ESTAR_EUI['Other'] || 40 : 40;
    let pctileLabel = '';
    if (curEUI > 0) {
      if (curEUI <= pctiles[0]) pctileLabel = 'Top 25%';
      else if (curEUI <= pctiles[1]) pctileLabel = '25th-50th';
      else if (curEUI <= pctiles[2]) pctileLabel = '50th-75th';
      else pctileLabel = 'Bottom 25%';
    }

    // Per-year EUI — only include years with >= 10 months of data
    const euiByYear = {};
    Object.entries(yearUsage).forEach(([yr, u]) => {
      const moCount = yearMonthCount[yr] ? yearMonthCount[yr].size : 0;
      if (moCount < 10) return;
      const kbtu = toKBtu(u.kwh || 0, u.therms || 0, u.propaneGal || 0);
      if (sqft > 0 && kbtu > 0) euiByYear[yr] = kbtu / sqft;
    });

    return {
      name: b.name,
      sqft,
      bType,
      qtrSavings,
      cumSavings,
      blEUI,
      curEUI,
      cbecsEUI,
      pctiles,
      estarEUI,
      pctileLabel,
      savByYM,
      meterDetails,
      euiByYear,
    };
  });

  // Aggregate totals
  let totalQtrSav = 0,
    totalCumSav = 0;
  let totalAnnBlKBtu = 0,
    totalAnnCurKBtu = 0;
  bldgData.forEach((d) => {
    totalQtrSav += d.qtrSavings;
    totalCumSav += d.cumSavings;
    totalAnnBlKBtu += d.blEUI * d.sqft;
    totalAnnCurKBtu += d.curEUI * d.sqft;
  });
  const annualizedSavings = totalQtrSav * (12 / periodMonths);
  const projectedSav = parseFloat(p.savings) || 0;
  // Compute projected savings from per-building savings % for use when projected savings not set
  const _rptMoBase = {};
  for (let i = 0; i < 12; i++) _rptMoBase[i] = 0;
  allBldgMeters.forEach(({ m, bills, incl, allRows, bl }) => {
    const blRows = allRows.filter((r) => bl.months.includes(r.ym));
    const { elecByMo: eM, gasByMo: gM, propaneByMo: pM } = buildMoMap(m, blRows, bills, incl);
    for (let mo = 0; mo < 12; mo++)
      _rptMoBase[mo] += (eM[mo]?.commodityCost || 0) + (gM[mo]?.cost || 0) + (pM[mo]?.cost || 0);
  });
  const _rptAnnBase = Object.values(_rptMoBase).reduce((s, v) => s + v, 0);
  const _rptAvgSavPct = typeof avgSavPctAcrossBldgs === 'function' ? avgSavPctAcrossBldgs(_rptMoBase) : 0.11;
  const calcProjSav = _rptAnnBase * _rptAvgSavPct;
  let measureBasedProjSav = 0;
  let _hasMeasures = false;
  if (p.savingsData && p.savingsData.measures) {
    const selMsrs = p.savingsData.measures.filter((m) => m.selected !== false);
    if (selMsrs.length) {
      _hasMeasures = true;
      selMsrs.forEach((m) => {
        const rates = m.rates || (p.savingsData.blRates || {})[m.bldgId] || {};
        for (let mo = 0; mo < 12; mo++) {
          const s = SUMMER_MOS.includes(mo);
          measureBasedProjSav += (parseFloat(m.kwh[mo]) || 0) * (s ? rates.kwhSummer || 0 : rates.kwhWinter || 0);
          measureBasedProjSav += (parseFloat(m.kw[mo]) || 0) * (s ? rates.kwSummer || 0 : rates.kwWinter || 0);
          measureBasedProjSav += (parseFloat(m.gas[mo]) || 0) * (rates.thermRate || 0);
          measureBasedProjSav += (parseFloat((m.propane || [])[mo]) || 0) * (rates.gallonRate || 0);
        }
      });
    }
  }
  const displayProjSav = _hasMeasures ? measureBasedProjSav : projectedSav > 0 ? projectedSav : calcProjSav;
  const contractYears = parseInt(p.contractYears) || 3;
  const escalation = parseFloat(p.escalation) || 0;
  const cscComp = parseFloat(p.cscCompensation) || 0;
  const contractStart = p.start ? new Date(p.start) : null;

  // Contract year calculation
  let contractYearNum = 1;
  if (contractStart) {
    const msElapsed = now - contractStart;
    contractYearNum = Math.max(1, Math.min(contractYears, Math.ceil(msElapsed / (365.25 * 86400000))));
  }

  // On-track status
  const annualizedActual = annualizedSavings;
  let statusLabel = 'On Track',
    statusColor = [34, 139, 34];
  if (projectedSav > 0) {
    const pctOfProjected = annualizedActual / projectedSav;
    if (pctOfProjected < 0) {
      statusLabel = 'Over Budget';
      statusColor = [200, 30, 30];
    } else if (pctOfProjected < 0.8) {
      statusLabel = 'Below Target';
      statusColor = [210, 140, 0];
    }
  } else if (annualizedActual < 0) {
    statusLabel = 'Over Budget';
    statusColor = [200, 30, 30];
  }

  // Aggregate quarterly savings for trend chart
  const aggQtrSav = {};
  bldgData.forEach((d) => {
    Object.entries(d.savByYM).forEach(([ym, v]) => {
      aggQtrSav[ym] = (aggQtrSav[ym] || 0) + v;
    });
  });
  const sortedQtrYMs = Object.keys(aggQtrSav).sort();
  const quarters = {};
  sortedQtrYMs.forEach((ym) => {
    const [yr, mo] = ym.split('-');
    const q = 'Q' + Math.ceil(parseInt(mo) / 3) + ' ' + yr;
    quarters[q] = (quarters[q] || 0) + aggQtrSav[ym];
  });

  // Weather data for observations
  let rpHDD = 0,
    rpCDD = 0,
    blAvgHDD = 0,
    blAvgCDD = 0,
    blMonthsCount = 0;
  allBldgMeters.forEach(({ allRows, bl }) => {
    const blRows = allRows.filter((r) => bl.months.includes(r.ym));
    blRows.forEach((r) => {
      blAvgHDD += r.hdd || 0;
      blAvgCDD += r.cdd || 0;
    });
    blMonthsCount += blRows.length;
    const rpRows = allRows.filter((r) => reportYMs.includes(r.ym));
    rpRows.forEach((r) => {
      rpHDD += r.hdd || 0;
      rpCDD += r.cdd || 0;
    });
  });
  const blAvgHDDperMo = blMonthsCount > 0 ? blAvgHDD / blMonthsCount : 0;
  const blAvgCDDperMo = blMonthsCount > 0 ? blAvgCDD / blMonthsCount : 0;
  const rpMeterMonths = allBldgMeters.reduce((s, x) => s + x.allRows.filter((r) => reportYMs.includes(r.ym)).length, 0);
  const expHDD = blAvgHDDperMo * rpMeterMonths;
  const expCDD = blAvgCDDperMo * rpMeterMonths;

  // -------------------------------------------
  // PAGE 1: COVER + EXECUTIVE SUMMARY
  // -------------------------------------------

  try {
    doc.addImage(CSC_HEADER_B64, 'JPEG', 0, 0, pw, 145);
  } catch (e) {}
  y = 155;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(0, 0, 0);
  const reportTitle =
    type === 'quarterly' ? 'Quarterly Energy Management Services Report' : 'Annual Energy Management Services Report';
  doc.text(reportTitle, pw / 2, y, { align: 'center' });
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text(p.client || p.name || '', pw / 2, y, { align: 'center' });
  y += 16;
  doc.setFontSize(11);
  doc.setTextColor(80, 80, 80);
  doc.text('Reporting Period: ' + periodLabel, pw / 2, y, { align: 'center' });
  y += 14;
  doc.setFontSize(9);
  // Format report date with ordinal suffix (e.g. "May 11th, 2026")
  const rptDate = reportDateStr ? new Date(reportDateStr + 'T12:00:00') : now;
  const rDay = rptDate.getDate();
  const ordSuffix =
    rDay === 1 || rDay === 21 || rDay === 31
      ? 'st'
      : rDay === 2 || rDay === 22
        ? 'nd'
        : rDay === 3 || rDay === 23
          ? 'rd'
          : 'th';
  doc.text(monthNames[rptDate.getMonth()] + ' ' + rDay + ordSuffix + ', ' + rptDate.getFullYear(), pw / 2, y, {
    align: 'center',
  });
  doc.setTextColor(0, 0, 0);
  y += 28;

  // Performance at a Glance
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Performance at a Glance', ml, y);
  y += 4;

  const boxW = (contentW - 12) / 3;
  const boxH = 58;
  const boxGap = 6;
  const boxes = [
    {
      label: type === 'quarterly' ? 'Quarterly Savings' : 'Annual Savings',
      value: (totalQtrSav >= 0 ? '' : '-') + $c(totalQtrSav),
      sub: 'Annualized: ' + (annualizedSavings >= 0 ? '' : '-') + $c(annualizedSavings) + '/yr',
    },
    {
      label: 'Cumulative Savings',
      value: (totalCumSav >= 0 ? '' : '-') + $c(totalCumSav),
      sub: 'Since contract start',
    },
    {
      label: 'Projected Savings',
      value: $c(displayProjSav) + '/yr',
      sub:
        displayProjSav > 0
          ? (annualizedActual >= 0 ? Math.round((annualizedActual / displayProjSav) * 100) : 0) +
            '% achieved (annualized)' +
            (projectedSav <= 0 ? ' [est]' : '')
          : '',
    },
    { label: 'Status', value: statusLabel, sub: '', color: statusColor },
    {
      label: 'Contract Progress',
      value: 'Year ' + contractYearNum + ' of ' + contractYears,
      sub: contractStart ? 'Started ' + monthNames[contractStart.getMonth()] + ' ' + contractStart.getFullYear() : '',
    },
    {
      label: 'Comparison Method',
      value: useNormalized ? 'Weather-Normalized' : 'Actual',
      sub: useNormalized ? 'Adjusted for degree days' : 'Direct bill comparison',
    },
  ];

  boxes.forEach((box, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const bx = ml + col * (boxW + boxGap);
    const by = y + row * (boxH + boxGap);
    doc.setFillColor(245, 245, 248);
    doc.roundedRect(bx, by, boxW, boxH, 4, 4, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(box.label.toUpperCase(), bx + 8, by + 14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    if (box.color) doc.setTextColor(box.color[0], box.color[1], box.color[2]);
    else doc.setTextColor(0, 0, 0);
    doc.text(String(box.value), bx + 8, by + 32);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text(box.sub || '', bx + 8, by + 46);
    doc.setTextColor(0, 0, 0);
  });
  y += 2 * (boxH + boxGap) + 16;

  // Executive summary text
  checkPage(60);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Executive Summary', ml, y);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const summaryLines = [
    (type === 'quarterly' ? 'Quarterly' : 'Annual') +
      ' Savings (' +
      periodLabel +
      '): ' +
      (totalQtrSav >= 0 ? '' : '-') +
      $c(totalQtrSav) +
      (useNormalized ? '  [Weather-Normalized]' : ''),
    'Cumulative Savings to Date: ' + (totalCumSav >= 0 ? '' : '-') + $c(totalCumSav),
    projectedSav > 0 ? 'Projected Savings Target: ' + $c(projectedSav) + '/yr' : '',
  ].filter(Boolean);
  summaryLines.forEach((line) => {
    doc.text(line, ml + 4, y);
    y += 13;
  });

  addFooter();

  // -------------------------------------------
  // PAGE 2: BUILDING PERFORMANCE TABLE + TREND
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Building Performance Summary', ml, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Reporting Period: ' + periodLabel, ml, y + 10);
  y += 18;
  doc.setTextColor(0, 0, 0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const tCols = ['Building', 'Sq Ft', 'Quarterly Savings', 'Status'];
  const tW = [contentW * 0.36, contentW * 0.14, contentW * 0.26, contentW * 0.24];
  let cx = ml;
  tCols.forEach((c, i) => {
    doc.text(c, cx, y);
    cx += tW[i];
  });
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y, ml + contentW, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  bldgData.forEach((r, idx) => {
    checkPage(16);
    if (idx % 2 === 0) {
      doc.setFillColor(248, 248, 250);
      doc.rect(ml - 2, y - 9, contentW + 4, 13, 'F');
    }
    cx = ml;
    doc.setTextColor(0, 0, 0);
    doc.text((r.name || '-').substring(0, 32), cx, y);
    cx += tW[0];
    doc.text(r.sqft ? r.sqft.toLocaleString() : '-', cx, y);
    cx += tW[1];
    if (r.qtrSavings >= 0) doc.setTextColor(34, 139, 34);
    else doc.setTextColor(200, 30, 30);
    doc.text((r.qtrSavings >= 0 ? '' : '-') + $c(r.qtrSavings), cx, y);
    cx += tW[2];
    doc.text(r.qtrSavings >= 0 ? 'On Track' : 'Below Target', cx, y);
    doc.setTextColor(0, 0, 0);
    y += 13;
  });
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y - 8, ml + contentW, y - 8);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  cx = ml;
  doc.text('TOTAL', cx, y);
  cx += tW[0];
  doc.text(totalSqft.toLocaleString(), cx, y);
  cx += tW[1];
  doc.text((totalQtrSav >= 0 ? '' : '-') + $c(totalQtrSav), cx, y);
  y += 20;

  // Savings trend chart
  const qKeys = Object.keys(quarters);
  if (qKeys.length >= 2) {
    checkPage(200);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Savings Trend Over Time', ml, y);
    y += 14;

    const chartW = contentW;
    const chartH = 150;
    const canvas = document.createElement('canvas');
    canvas.width = chartW * 2;
    canvas.height = chartH * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    const vals = qKeys.map((k) => quarters[k]);
    const maxVal = Math.max(...vals.map(Math.abs), projectedSav / 4 || 1);
    const barW = Math.min(40, (chartW - 60) / qKeys.length - 4);
    const padL = 50,
      padB = 30,
      padT = 10;
    const plotH = chartH - padB - padT;
    const zeroY = padT + plotH * (maxVal / (maxVal * 2));

    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(chartW, gy);
      ctx.stroke();
    }

    qKeys.forEach((q, i) => {
      const v = quarters[q];
      const x = padL + ((chartW - padL) / qKeys.length) * i + (chartW - padL) / qKeys.length / 2 - barW / 2;
      const barH = (Math.abs(v) / maxVal) * (plotH / 2);
      const topY = v >= 0 ? zeroY - barH : zeroY;
      ctx.fillStyle = v >= 0 ? '#22a355' : '#d63031';
      ctx.beginPath();
      ctx.roundRect(x, topY, barW, barH, 3);
      ctx.fill();
      ctx.fillStyle = '#333';
      ctx.font = '8px Helvetica';
      ctx.textAlign = 'center';
      ctx.fillText(q, x + barW / 2, chartH - 6);
      ctx.font = 'bold 8px Helvetica';
      ctx.fillText((v >= 0 ? '' : '-') + '$' + Math.round(Math.abs(v)).toLocaleString(), x + barW / 2, topY - 4);
    });

    if (projectedSav > 0) {
      const gLine = projectedSav / (12 / periodMonths);
      const gY = zeroY - (gLine / maxVal) * (plotH / 2);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#e67e22';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padL, gY);
      ctx.lineTo(chartW - 5, gY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#e67e22';
      ctx.font = '8px Helvetica';
      ctx.textAlign = 'left';
      ctx.fillText(
        'Target: $' + Math.round(gLine).toLocaleString() + '/' + (type === 'quarterly' ? 'qtr' : 'yr'),
        padL + 2,
        gY - 4,
      );
    }

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(chartW, zeroY);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '8px Helvetica';
    ctx.textAlign = 'right';
    ctx.fillText('$' + Math.round(maxVal).toLocaleString(), padL - 4, padT + 6);
    ctx.fillText('$0', padL - 4, zeroY + 4);
    ctx.fillText('-$' + Math.round(maxVal).toLocaleString(), padL - 4, padT + plotH + 4);

    const imgData = canvas.toDataURL('image/png');
    doc.addImage(imgData, 'PNG', ml, y, chartW, chartH);
    y += chartH + 10;
  }

  addFooter();

  // -------------------------------------------
  // PAGE 3: EUI BENCHMARKING
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Energy Use Intensity by Building Activity', ml, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 100, 100);
  doc.text('thousand British thermal units per square foot', ml, y + 8);
  y += 14;
  doc.setTextColor(0, 0, 0);

  // Full CBECS reference data sorted descending by 2018 value (matching EIA chart)
  const cbecsRef = [
    { label: 'food service', eui: 277 },
    { label: 'food sales', eui: 237 },
    { label: 'inpatient health care', eui: 210 },
    { label: 'other', eui: 120 },
    { label: 'enclosed and strip malls', eui: 105 },
    { label: 'public order and safety', eui: 80 },
    { label: 'lodging', eui: 75 },
    { label: 'outpatient health care', eui: 75 },
    { label: 'public assembly', eui: 72 },
    { label: 'average for all commercial bldgs', eui: 70 },
    { label: 'office', eui: 60 },
    { label: 'retail (other than mall)', eui: 55 },
    { label: 'education', eui: 50 },
    { label: 'service', eui: 45 },
    { label: 'religious worship', eui: 30 },
    { label: 'warehouse and storage', eui: 20 },
    { label: 'vacant', eui: 10 },
  ];
  // Map project buildings to chart - find which row they belong on
  const euiBldgs = bldgData.filter((d) => d.curEUI > 0 && d.sqft > 0);
  const bldgTypeMap = {
    'K-12 School': 'education',
    'Elementary School': 'education',
    'Middle School': 'education',
    'High School': 'education',
    'College / University': 'education',
    'Hospital / Healthcare': 'inpatient health care',
    'Office Building': 'office',
    'Warehouse / Industrial': 'warehouse and storage',
    Retail: 'retail (other than mall)',
    'Municipal / Government': 'public order and safety',
    'Data Center': 'other',
    Other: 'other',
  };

  const euiChartW = contentW;
  const rowH = 16;
  const euiChartH = cbecsRef.length * rowH + 55;
  const canvas2 = document.createElement('canvas');
  canvas2.width = euiChartW * 2;
  canvas2.height = euiChartH * 2;
  const ctx2 = canvas2.getContext('2d');
  ctx2.scale(2, 2);

  const leftPad = 155,
    rightPad = 15,
    topPad = 26;
  const barAreaW = euiChartW - leftPad - rightPad;
  const maxEUI = 300;
  const chartBottom = topPad + cbecsRef.length * rowH;

  // X-axis grid
  ctx2.font = '8px Helvetica';
  ctx2.textAlign = 'center';
  ctx2.fillStyle = '#666';
  [0, 50, 100, 150, 200, 250, 300].forEach((v) => {
    const x = leftPad + (v / maxEUI) * barAreaW;
    ctx2.fillText(String(v), x, topPad - 14);
    ctx2.strokeStyle = '#e8e8e8';
    ctx2.lineWidth = 0.5;
    ctx2.beginPath();
    ctx2.moveTo(x, topPad - 8);
    ctx2.lineTo(x, chartBottom);
    ctx2.stroke();
  });

  // Draw CBECS bars
  cbecsRef.forEach((ref, i) => {
    const ry = topPad + i * rowH;
    const barH = 11;
    ctx2.fillStyle = '#333';
    ctx2.font = '8px Helvetica';
    ctx2.textAlign = 'right';
    ctx2.fillText(ref.label, leftPad - 6, ry + barH - 1);
    const barLen = (ref.eui / maxEUI) * barAreaW;
    ctx2.fillStyle = '#5b9bd5';
    ctx2.fillRect(leftPad, ry + 2, barLen, barH - 2);
  });

  // Overlay vertical lines for each project building
  const lineColors = ['#c0392b', '#e67e22', '#27ae60', '#2980b9', '#8e44ad', '#d35400'];
  euiBldgs.forEach((d, i) => {
    const bx = leftPad + (d.curEUI / maxEUI) * barAreaW;
    const color = lineColors[i % lineColors.length];
    // Vertical line spanning the full chart height
    ctx2.strokeStyle = color;
    ctx2.lineWidth = 1.8;
    ctx2.setLineDash([5, 3]);
    ctx2.beginPath();
    ctx2.moveTo(bx, topPad - 6);
    ctx2.lineTo(bx, chartBottom);
    ctx2.stroke();
    ctx2.setLineDash([]);
    // EUI value label at top of line, staggered to avoid overlaps
    const labelY = topPad - 8 - (i % 2) * 10;
    ctx2.fillStyle = color;
    ctx2.font = 'bold 7.5px Helvetica';
    ctx2.textAlign = 'center';
    ctx2.fillText(d.curEUI.toFixed(1), bx, labelY - 6);
    // Small marker dot
    ctx2.beginPath();
    ctx2.arc(bx, labelY - 2, 2.5, 0, Math.PI * 2);
    ctx2.fill();
  });

  // Legend at bottom
  const legY = chartBottom + 4;
  ctx2.font = '8px Helvetica';
  ctx2.textAlign = 'left';
  ctx2.fillStyle = '#5b9bd5';
  ctx2.fillRect(leftPad, legY, 14, 8);
  ctx2.fillStyle = '#444';
  ctx2.fillText('CBECS 2018 National Median (kBtu/sf/yr)', leftPad + 18, legY + 7);
  // Building legend entries
  let legX = leftPad;
  let legRow = legY + 16;
  euiBldgs.forEach((d, i) => {
    const color = lineColors[i % lineColors.length];
    ctx2.strokeStyle = color;
    ctx2.lineWidth = 1.8;
    ctx2.setLineDash([4, 2]);
    ctx2.beginPath();
    ctx2.moveTo(legX, legRow);
    ctx2.lineTo(legX + 14, legRow);
    ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.fillStyle = '#333';
    ctx2.font = '7.5px Helvetica';
    const label = d.name.substring(0, 20) + ' (' + d.curEUI.toFixed(1) + ')';
    ctx2.fillText(label, legX + 17, legRow + 3);
    legX += ctx2.measureText(label).width + 28;
    if (legX > euiChartW - 60) {
      legX = leftPad;
      legRow += 12;
    }
  });
  // Data source
  ctx2.fillStyle = '#666666';
  ctx2.font = '7px Helvetica';
  ctx2.textAlign = 'left';
  ctx2.fillText(
    'Data source: U.S. Energy Information Administration, Commercial Buildings Energy Consumption Survey',
    leftPad,
    legRow + 14,
  );

  const imgData2 = canvas2.toDataURL('image/png');
  doc.addImage(imgData2, 'PNG', ml, y, euiChartW, euiChartH + (legRow - legY));
  y += euiChartH + (legRow - legY) + 10;

  // EUI Year-over-Year table
  checkPage(80);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('EUI Year-over-Year', ml, y);
  y += 14;

  const allYears = [];
  bldgData.forEach((d) =>
    Object.keys(d.euiByYear).forEach((yr) => {
      if (!allYears.includes(yr)) allYears.push(yr);
    }),
  );
  allYears.sort();

  if (allYears.length > 0) {
    const nameColW = contentW * 0.28;
    const yrColW = Math.min(60, (contentW - nameColW - 50) / allYears.length);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    cx = ml;
    doc.text('Building', cx, y);
    cx += nameColW;
    allYears.forEach((yr) => {
      doc.text(yr, cx, y);
      cx += yrColW;
    });
    doc.text('Trend', cx, y);
    y += 2;
    doc.line(ml, y, ml + contentW, y);
    y += 10;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    bldgData.forEach((d) => {
      checkPage(14);
      cx = ml;
      doc.text((d.name || '').substring(0, 24), cx, y);
      cx += nameColW;
      const dYears = allYears.map((yr) => d.euiByYear[yr] || null);
      dYears.forEach((v) => {
        doc.text(v != null ? v.toFixed(1) : '—', cx, y);
        cx += yrColW;
      });
      const validYears = dYears.filter((v) => v != null);
      let trend = '-';
      if (validYears.length >= 2) {
        const diff = validYears[validYears.length - 1] - validYears[validYears.length - 2];
        if (diff < -2) {
          trend = 'Improving';
          doc.setTextColor(34, 139, 34);
        } else if (diff > 2) {
          trend = 'Increasing';
          doc.setTextColor(200, 30, 30);
        } else {
          trend = 'Stable';
          doc.setTextColor(100, 100, 100);
        }
      }
      doc.text(trend, cx, y);
      doc.setTextColor(0, 0, 0);
      y += 12;
    });
  }

  addFooter();

  // -------------------------------------------
  // PAGE 4: PROJECTED SAVINGS
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Projected Savings Over Contract Term', ml, y);
  y += 16;

  const annualBaseline = annualizedSavings;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const pCols = ['Year', 'Projected Savings', 'CSC Share (' + cscComp + '%)', 'Client Net Savings'];
  const pW = [contentW * 0.12, contentW * 0.28, contentW * 0.3, contentW * 0.3];
  cx = ml;
  pCols.forEach((c, i) => {
    doc.text(c, cx, y);
    cx += pW[i];
  });
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y, ml + contentW, y);
  y += 10;

  let totalProjSav = 0,
    totalClientNet = 0;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  for (let yr = 1; yr <= contractYears; yr++) {
    checkPage(16);
    const escFactor = Math.pow(1 + escalation / 100, yr - 1);
    const escBaseline = annualBaseline * escFactor;
    const projSav = annualizedSavings * escFactor;
    const cscShare = projSav * (cscComp / 100);
    const clientNet = projSav - cscShare;
    totalProjSav += projSav;
    totalClientNet += clientNet;

    if (yr === contractYearNum) {
      doc.setFillColor(255, 248, 230);
      doc.rect(ml - 2, y - 9, contentW + 4, 13, 'F');
    }
    cx = ml;
    doc.setFont('helvetica', yr === contractYearNum ? 'bold' : 'normal');
    doc.text('Year ' + yr + (yr === contractYearNum ? ' <--' : ''), cx, y);
    cx += pW[0];
    doc.text((projSav >= 0 ? '' : '-') + $c(projSav), cx, y);
    cx += pW[1];
    doc.text(cscComp > 0 ? $c(cscShare) : '-', cx, y);
    cx += pW[2];
    doc.text((clientNet >= 0 ? '' : '-') + $c(clientNet), cx, y);
    y += 13;
  }
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y - 8, ml + contentW, y - 8);
  doc.setFont('helvetica', 'bold');
  cx = ml;
  doc.text('TOTAL', cx, y);
  cx += pW[0];
  doc.text((totalProjSav >= 0 ? '' : '-') + $c(totalProjSav), cx, y);
  cx += pW[1];
  doc.text('', cx, y);
  cx += pW[2];
  doc.text((totalClientNet >= 0 ? '' : '-') + $c(totalClientNet), cx, y);
  y += 20;

  y += 10;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text(
    'Projections based on current annualized savings of ' +
      (annualizedSavings >= 0 ? '' : '-') +
      $c(annualizedSavings) +
      '/yr with ' +
      escalation +
      '% annual utility escalation.',
    ml,
    y,
  );
  if (cscComp > 0) {
    y += 11;
    doc.text('CSC compensation: ' + cscComp + '% of savings.', ml, y);
  }
  doc.setTextColor(0, 0, 0);

  addFooter();

  // -------------------------------------------
  // PAGE 5: ENVIRONMENTAL IMPACT
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Environmental Impact — Pollution Equivalents Saved', ml, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Estimated avoided emissions from energy savings vs baseline, annualized.', ml, y + 10);
  y += 22;
  doc.setTextColor(0, 0, 0);

  // Compute energy savings by commodity (annualized from quarterly)
  let savKwh = 0,
    savTherms = 0,
    savPropaneGal = 0;
  allBldgMeters.forEach(({ m, bills, incl, allRows, bl, blEnd, postRows }) => {
    const blRows = allRows.filter((r) => bl.months.includes(r.ym));
    const isElec = m.commodity === 'Electric';
    const isPropane = m.commodity === 'Propane';
    const blByCalMo = {};
    blRows.forEach((r) => {
      const mo = parseInt(r.ym.split('-')[1]) - 1;
      blByCalMo[mo] = r.regrBaseline != null ? r.regrBaseline : r.usage;
    });
    const blAvg = blRows.length ? blRows.reduce((s, r) => s + r.usage, 0) / blRows.length : 0;
    const rawUsageByYm = {};
    if (isElec) {
      bills.forEach((b2) => {
        const ym = normMonth(b2.start, b2.end, incl, bills);
        if (ym) rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + (parseFloat(b2.kwh) || parseFloat(b2.usage) || 0);
      });
    } else if (isPropane) {
      allRows.forEach((r) => {
        rawUsageByYm[r.ym] = r.usage;
      });
    } else {
      bills.forEach((b2) => {
        const ym = normMonth(b2.start, b2.end, incl, bills);
        if (ym) rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + parseFloat(b2.therms || b2.usage || 0);
      });
    }
    postRows.forEach((r) => {
      if (!reportYMs.includes(r.ym)) return;
      const calMo = parseInt(r.ym.split('-')[1]) - 1;
      const expUsage = blByCalMo[calMo] != null ? blByCalMo[calMo] : r.regrBaseline != null ? r.regrBaseline : blAvg;
      const actUsage = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
      const usageSaved = expUsage - actUsage;
      if (isElec) savKwh += usageSaved;
      else if (isPropane) savPropaneGal += usageSaved;
      else savTherms += usageSaved;
    });
  });
  // Annualize from reporting period
  const annSavKwh = savKwh * (12 / periodMonths);
  const annSavTherms = savTherms * (12 / periodMonths);
  const annSavPropGal = savPropaneGal * (12 / periodMonths);

  // EPA GHG Equivalencies (metric tons CO2)
  const co2Kwh = 0.000404;
  const co2Therm = 0.005302;
  const co2PropGal = 0.00574;
  const totalCO2 = annSavKwh * co2Kwh + annSavTherms * co2Therm + annSavPropGal * co2PropGal;

  // Equivalency factors (per metric ton CO2)
  const treesPerTon = 16.5;
  const carsPerTon = 1 / 4.6;
  const homesPerTon = 1 / 8.9;
  const acresForestPerTon = 1 / 0.84;
  const lbsCO2 = totalCO2 * 2204.6;

  const co2Positive = totalCO2 > 0;
  const co2Label = co2Positive ? 'avoided' : 'increased';

  // Summary boxes
  const envBoxW = (contentW - 8) / 2;
  const envBoxH = 52;
  const envItems = [
    {
      label: 'CO2 Avoided',
      value: Math.abs(totalCO2).toFixed(1) + ' metric tons/yr',
      sub: Math.round(Math.abs(lbsCO2)).toLocaleString() + ' lbs/yr',
    },
    {
      label: 'Trees Equivalent',
      value: Math.round(Math.abs(totalCO2) * treesPerTon).toLocaleString() + ' tree seedlings',
      sub: 'grown for 10 years',
    },
    {
      label: 'Cars Off Road',
      value: Math.abs(totalCO2 * carsPerTon).toFixed(1) + ' passenger vehicles',
      sub: 'removed for one year',
    },
    {
      label: 'Homes Powered',
      value: Math.abs(totalCO2 * homesPerTon).toFixed(1) + ' homes',
      sub: 'annual energy use',
    },
  ];
  envItems.forEach((box, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bx = ml + col * (envBoxW + 8);
    const by = y + row * (envBoxH + 6);
    doc.setFillColor(co2Positive ? 235 : 255, co2Positive ? 248 : 240, co2Positive ? 235 : 240);
    doc.roundedRect(bx, by, envBoxW, envBoxH, 4, 4, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text(box.label.toUpperCase(), bx + 10, by + 14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(co2Positive ? 34 : 200, co2Positive ? 139 : 30, co2Positive ? 34 : 30);
    doc.text(String(box.value), bx + 10, by + 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text(box.sub, bx + 10, by + 42);
  });
  y += 2 * (envBoxH + 6) + 16;
  doc.setTextColor(0, 0, 0);

  // Breakdown table
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Emissions Breakdown by Energy Source', ml, y);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const eCols = ['Energy Source', 'Annual Savings', 'CO2 Factor', 'CO2 ' + co2Label];
  const eW = [contentW * 0.25, contentW * 0.25, contentW * 0.25, contentW * 0.25];
  cx = ml;
  eCols.forEach((c, i) => {
    doc.text(c, cx, y);
    cx += eW[i];
  });
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y, ml + contentW, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const eRows = [
    {
      src: 'Electricity',
      sav: Math.round(annSavKwh).toLocaleString() + ' kWh',
      factor: co2Kwh.toFixed(6) + ' MT/kWh',
      co2: (annSavKwh * co2Kwh).toFixed(2) + ' MT',
    },
    {
      src: 'Natural Gas',
      sav: Math.round(annSavTherms).toLocaleString() + ' therms',
      factor: co2Therm.toFixed(6) + ' MT/therm',
      co2: (annSavTherms * co2Therm).toFixed(2) + ' MT',
    },
  ];
  if (annSavPropGal !== 0) {
    eRows.push({
      src: 'Propane',
      sav: Math.round(annSavPropGal).toLocaleString() + ' gal',
      factor: co2PropGal.toFixed(6) + ' MT/gal',
      co2: (annSavPropGal * co2PropGal).toFixed(2) + ' MT',
    });
  }
  eRows.push({ src: 'TOTAL', sav: '', factor: '', co2: totalCO2.toFixed(2) + ' MT' });

  eRows.forEach((r, idx) => {
    cx = ml;
    if (idx === eRows.length - 1) {
      doc.setFont('helvetica', 'bold');
      doc.setDrawColor(180, 180, 180);
      doc.line(ml, y - 6, ml + contentW, y - 6);
    }
    doc.text(r.src, cx, y);
    cx += eW[0];
    doc.text(r.sav, cx, y);
    cx += eW[1];
    doc.text(r.factor, cx, y);
    cx += eW[2];
    doc.text(r.co2, cx, y);
    y += 13;
    doc.setFont('helvetica', 'normal');
  });

  y += 10;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(120, 120, 120);
  const epaNote = doc.splitTextToSize(
    'Conversion factors: EPA eGRID (electricity, Kansas/SPP region), EPA GHG Equivalencies Calculator. ' +
      '1 passenger car = 4.6 MT CO₂/yr. 1 tree seedling grown 10 years = 0.06 MT CO₂. 1 home = 8.9 MT CO₂/yr. ' +
      '1 passenger car = 4.6 MT CO2/yr. 1 tree seedling grown 10 years = 0.06 MT CO2. 1 home = 8.9 MT CO2/yr. ' +
      '1 acre US forest = 0.84 MT CO2/yr.',
    contentW,
  );
  epaNote.forEach((line) => {
    doc.text(line, ml, y);
    y += 9;
  });
  doc.setTextColor(0, 0, 0);

  addFooter();

  // -------------------------------------------
  // PAGE 6: OBSERVATIONS & RECOMMENDATIONS
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Observations & Recommendations', ml, y);
  y += 18;

  const obs = [];

  if (projectedSav > 0) {
    const pctAchieved = Math.round((annualizedActual / projectedSav) * 100);
    if (pctAchieved >= 100)
      obs.push(
        'Overall Performance: The project exceeded its projected savings target this period, achieving ' +
          pctAchieved +
          '% of the ' +
          $c(projectedSav) +
          '/yr projection.',
      );
    else if (pctAchieved >= 80)
      obs.push(
        'Overall Performance: The project achieved ' +
          pctAchieved +
          '% of the ' +
          $c(projectedSav) +
          '/yr projected savings target this period. Performance is within an acceptable range.',
      );
    else
      obs.push(
        'Overall Performance: The project achieved only ' +
          pctAchieved +
          '% of the ' +
          $c(projectedSav) +
          '/yr projected savings target. A review of BAS schedules and setpoints is recommended.',
      );
  } else {
    obs.push(
      'Overall Performance: The project ' +
        (totalQtrSav >= 0
          ? 'saved ' + $c(totalQtrSav) + ' this quarter'
          : 'exceeded baseline costs by ' + $c(Math.abs(totalQtrSav)) + ' this quarter') +
        '. Cumulative savings to date: ' +
        (totalCumSav >= 0 ? '' : '-') +
        $c(totalCumSav) +
        '.',
    );
  }

  const best = bldgData.reduce((a, b) => (b.qtrSavings > a.qtrSavings ? b : a), bldgData[0]);
  if (best && best.qtrSavings > 0 && bldgData.length > 1) {
    obs.push('Top Performer: ' + best.name + ' led the project with ' + $c(best.qtrSavings) + ' in quarterly savings.');
  }

  const worst = bldgData.reduce((a, b) => (b.qtrSavings < a.qtrSavings ? b : a), bldgData[0]);
  if (worst && worst.qtrSavings < 0 && bldgData.length > 1) {
    obs.push(
      'Needs Attention: ' +
        worst.name +
        ' exceeded baseline costs by ' +
        $c(Math.abs(worst.qtrSavings)) +
        ' this quarter. A focused review of equipment schedules and building operations is recommended.',
    );
  } else if (worst && worst.qtrSavings < totalQtrSav * 0.3 && bldgData.length > 1 && worst !== best) {
    obs.push(
      'Below Average: ' +
        worst.name +
        ' saved only ' +
        $c(worst.qtrSavings) +
        ' vs the project total of ' +
        $c(totalQtrSav) +
        '. Consider reviewing setpoints and occupancy schedules.',
    );
  }

  if (expHDD > 0 && rpHDD > 0) {
    const hddDiff = ((rpHDD - expHDD) / expHDD) * 100;
    if (Math.abs(hddDiff) > 10) {
      obs.push(
        'Weather Impact: This period had ' +
          Math.abs(hddDiff).toFixed(0) +
          '% ' +
          (hddDiff > 0 ? 'more' : 'fewer') +
          ' heating degree days than the baseline average. ' +
          (useNormalized
            ? 'The weather-normalized calculation accounts for this variation.'
            : 'Consider weather-normalizing for a more accurate comparison.'),
      );
    }
  }
  if (expCDD > 0 && rpCDD > 0) {
    const cddDiff = ((rpCDD - expCDD) / expCDD) * 100;
    if (Math.abs(cddDiff) > 10) {
      obs.push(
        'Cooling Season: This period had ' +
          Math.abs(cddDiff).toFixed(0) +
          '% ' +
          (cddDiff > 0 ? 'more' : 'fewer') +
          ' cooling degree days than the baseline average. ' +
          (useNormalized ? 'Weather normalization accounts for this.' : 'Actual comparison does not adjust for this.'),
      );
    }
  }

  const bottomQuartile = bldgData.filter((d) => d.curEUI > 0 && d.pctileLabel === 'Bottom 25%');
  if (bottomQuartile.length > 0) {
    const names = bottomQuartile.map((d) => d.name).join(', ');
    obs.push(
      'Site EUI Benchmark Alert: ' +
        names +
        (bottomQuartile.length > 1 ? ' have' : ' has') +
        ' Site EUI values in the bottom 25% nationally. A targeted operations review may identify optimization opportunities.',
    );
  }

  const qVals = Object.values(quarters);
  if (qVals.length >= 3) {
    const recent3 = qVals.slice(-3);
    if (recent3[2] < recent3[1] && recent3[1] < recent3[0] && recent3[0] > 0) {
      obs.push(
        'Declining Trend: Savings have decreased for three consecutive quarters. A mid-cycle BAS tune-up is recommended.',
      );
    }
  }

  if (obs.length < 3) {
    obs.push(
      'Recommendation: Continue monitoring monthly utility bills and review BAS schedules seasonally to maintain optimal performance.',
    );
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  obs.forEach((o, i) => {
    checkPage(50);
    const fullLines = doc.splitTextToSize(i + 1 + '. ' + o, contentW - 8);
    fullLines.forEach((line, li) => {
      doc.text(line, ml + 4, y);
      y += 13;
    });
    y += 6;
  });

  addFooter();

  // -------------------------------------------
  // PAGE 6: BASELINE METHODOLOGY APPENDIX
  // -------------------------------------------

  doc.addPage();
  pageNum++;
  y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Appendix: Baseline Methodology', ml, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Technical details of the baseline period and regression analysis for each meter.', ml, y + 10);
  y += 22;
  doc.setTextColor(0, 0, 0);

  // Appendix table header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  const aCols = ['Building / Meter', 'Baseline Period', 'Method', 'R2', 'HDD', 'CDD', 'Usage', 'Cost/yr'];
  const aW = [
    contentW * 0.22,
    contentW * 0.2,
    contentW * 0.12,
    contentW * 0.07,
    contentW * 0.09,
    contentW * 0.09,
    contentW * 0.11,
    contentW * 0.1,
  ];
  cx = ml;
  aCols.forEach((c, i) => {
    doc.text(c, cx, y);
    cx += aW[i];
  });
  y += 2;
  doc.setDrawColor(180, 180, 180);
  doc.line(ml, y, ml + contentW, y);
  y += 8;

  doc.setFontSize(7.5);
  bldgData.forEach((bd) => {
    if (!bd.meterDetails.length) return;
    checkPage(30);
    // Building header row
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setFillColor(242, 242, 246);
    doc.rect(ml - 2, y - 8, contentW + 4, 11, 'F');
    doc.text(bd.name + (bd.sqft ? ' (' + bd.sqft.toLocaleString() + ' sf)' : ''), ml, y);
    y += 10;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    bd.meterDetails.forEach((md) => {
      checkPage(14);
      cx = ml;
      doc.text('  ' + md.meterName, cx, y);
      cx += aW[0];
      doc.text(md.blPeriod, cx, y);
      cx += aW[1];
      doc.text(md.regrType, cx, y);
      cx += aW[2];
      doc.text(md.r2 != null ? md.r2.toFixed(3) : '-', cx, y);
      cx += aW[3];
      doc.text(md.blHDD > 0 ? Math.round(md.blHDD).toLocaleString() : '-', cx, y);
      cx += aW[4];
      doc.text(md.blCDD > 0 ? Math.round(md.blCDD).toLocaleString() : '-', cx, y);
      cx += aW[5];
      doc.text(Math.round(md.blAnnUsage).toLocaleString() + ' ' + md.usageUnit, cx, y);
      cx += aW[6];
      doc.text($c(md.blAnnCost), cx, y);
      y += 10;
      // Regression equation on second line if available
      if (md.slope && md.intercept) {
        doc.setFontSize(6.5);
        doc.setTextColor(100, 100, 100);
        doc.text(
          '  Equation: Usage = ' +
            md.intercept +
            ' x days + ' +
            md.slope +
            ' x ' +
            (md.regrType.includes('CDD') ? 'CDD' : 'HDD'),
          ml + 8,
          y,
        );
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(7.5);
        y += 9;
      }
    });
    y += 4;
  });

  addFooter();

  // -------------------------------------------
  // SAVE PDF
  // -------------------------------------------

  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '.');
  const filename =
    (p.client || p.name || 'Project') +
    ' - ' +
    (type === 'quarterly' ? 'Quarterly' : 'Annual') +
    ' Savings Report ' +
    dateStr +
    '.pdf';
  doc.save(filename);
  showToast(type === 'quarterly' ? 'Quarterly report generated ?' : 'Annual report generated ?');
}
/* -- SESSION PERSISTENCE -- */

// -- Projects page --
function saveProjSession() {
  const isDetail = document.getElementById('projDetailView')?.style.display !== 'none';
  sessionStorage.setItem(
    'ch_proj',
    JSON.stringify({
      view: isDetail ? 'detail' : 'list',
      projId: isDetail ? window._activeProjId || null : null,
      tab: window._activeProjTab || 'dashboard',
    }),
  );
}

function restoreProjSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem('ch_proj') || '{}');
    if (s.view === 'detail' && s.projId != null) {
      // projId may be string after JSON parse — coerce to match project id type
      const p = projects.find((p) => p.id == s.projId);
      if (p) {
        openDetail(p.id);
        if (s.tab && s.tab !== 'notes') {
          const btn = document.querySelector(`#pdTabBar button[data-tab="${s.tab}"]`);
          if (btn) btn.click();
        }
      }
    }
  } catch (e) {
    console.warn('restoreProjSession error', e);
  }
}

// -- Utility Data --
function saveUDSession() {
  sessionStorage.setItem(
    'ch_ud',
    JSON.stringify({
      proj: udSelProjId,
      bldg: udSelBldgId,
      meter: udActiveMid,
      tab: udActiveTab,
      normMetric: udNormMetric,
      normChart: udNormChartVis,
      blMetric: udBlMetric,
      blChart: udBlChartVis,
      blOverlay: udBlOverlay,
      perfMetric: _perfMetric,
      perfChart: _perfChartVis,
      perfOverlay: _perfOverlay,
      perfYear: _perfYearFilter,
      perfWeatherMode: _perfWeatherMode,
      regrPanel: _regressionPanelVis,
    }),
  );
}

// Date paste support: normalize pasted dates into YYYY-MM-DD for type="date" inputs
document.addEventListener('paste', function (e) {
  const el = e.target;
  if (!el || el.type !== 'date') return;
  const txt = (e.clipboardData || window.clipboardData).getData('text').trim();
  const m =
    txt.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/) || txt.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return;
  e.preventDefault();
  let y, mo, d;
  if (m[1].length === 4) {
    y = m[1];
    mo = m[2];
    d = m[3];
  } else {
    mo = m[1];
    d = m[2];
    y = m[3];
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
  }
  el.value = y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

function initUtilityTool() {
  loadUtilityData();
  try {
    const s = JSON.parse(sessionStorage.getItem('ch_ud') || '{}');
    if (s.proj != null) udSelProjId = s.proj;
    if (s.bldg != null) udSelBldgId = s.bldg;
    if (s.meter != null) udActiveMid = s.meter;
    if (s.tab != null) udActiveTab = s.tab;
    if (s.normMetric != null) udNormMetric = s.normMetric;
    if (s.normChart != null) udNormChartVis = s.normChart;
    if (s.blMetric != null) udBlMetric = s.blMetric;
    if (s.blChart != null) udBlChartVis = s.blChart;
    if (s.blOverlay != null) udBlOverlay = s.blOverlay;
    if (s.perfMetric != null) _perfMetric = s.perfMetric;
    if (s.perfChart != null) _perfChartVis = s.perfChart;
    if (s.perfOverlay != null) _perfOverlay = s.perfOverlay;
    if (s.perfYear != null) _perfYearFilter = s.perfYear;
    if (s.perfWeatherMode != null) _perfWeatherMode = s.perfWeatherMode;
    if (s.regrPanel != null) _regressionPanelVis = s.regrPanel;
  } catch (e) {}
  if (_restoreExtractionState()) {
    setTimeout(() => {
      const box = document.getElementById('pdfAIBox');
      if (box && window._pdfMultiBills && window._pdfMultiBills.length) {
        const idx = window._pdfMultiIdx || 0;
        renderMultiBillUI(window._pdfMultiBills, box);
        renderPDFFields(window._pdfMultiBills[idx], (window._pdfBillWarnings || [])[idx]?.warnings || []);
        document.getElementById('pdfSaveRow').style.display = 'block';
        document.getElementById('pdfClearBtn').style.display = 'block';
        document.getElementById('dropZone').classList.add('collapsed');
        document.getElementById('pdfTypeSection').style.display = 'none';
        sv('pdf');
        showToast('Restored extraction results from previous session');
      }
    }, 500);
  } else if (_restoreQueueState()) {
    setTimeout(() => {
      if (window._pdfQueue && window._pdfQueue.results.length > 0) {
        renderQueueResults();
        showToast('Restored batch extraction results from previous session');
      }
    }, 500);
  }
  renderUDProjList();
  renderUDDetail();
  _checkForVersionUpdate();
  // Issue e9f1157c round 2: the check above only fires once, right after page load,
  // when the loaded bundle and the live server were necessarily in sync (they were
  // just served together) — a mismatch can never be observed at that instant. The
  // real bug scenario is a tab left open for hours while a deploy lands in the
  // background. Re-run the same check whenever the tab regains focus (the moment
  // the user would actually notice/care), plus a slow interval backstop for tabs
  // that are never explicitly re-focused (e.g. a second monitor that's always visible).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _checkForVersionUpdate();
  });
  setInterval(_checkForVersionUpdate, 5 * 60 * 1000);
  // Restore any state saved before a version-triggered page reload (issue 066423b5)
  _restorePageStateAfterVersionUpdate();
}

// Tracks a version the user has explicitly dismissed in THIS tab so re-checks
// (visibilitychange/interval) don't keep re-nagging about the same release.
let _chVersionDismissed = null;

/* Fetch the live server's version and compare it to the version actually baked into
   this tab's already-loaded code. Shared by the initial page-load check, the
   visibilitychange re-check, and the interval backstop -- issue e9f1157c. */
function _checkForVersionUpdate() {
  fetch('site-ui.js?nocache=' + Date.now())
    .then((r) => r.text())
    .then((t) => {
      const m = t.match(/CH_VERSION\s*=\s*'([^']+)'/);
      if (!m) return;
      const fetchedVer = m[1];
      // Issue e9f1157c / Matt report 2026-07-29: the badge must show loadedVer (the
      // version actually baked into the code this tab already has in memory), never
      // fetchedVer (the LIVE server version). A tab left open across a deploy keeps
      // executing whatever it loaded originally -- painting fetchedVer made the badge
      // jump to the new number instantly on deploy, with no click and no reload,
      // before the tab was running any of that code. loadedVer comes from
      // RELEASE_NOTES[0].v, which ships inside app/site-functions.js and loaded with
      // this page's own cache-busted ?v= tag (see script tags near the bottom of
      // energy-department.html). Fall back to storedVer (localStorage, shared across
      // tabs) only if RELEASE_NOTES isn't available yet. fetchedVer is used SOLELY
      // for update detection (the comparison below) and the reload banner -- never
      // to paint "what am I running".
      const _CH_VER_KEY = 'ch_last_seen_version';
      const storedVer = localStorage.getItem(_CH_VER_KEY);
      const loadedVer = (typeof RELEASE_NOTES !== 'undefined' && RELEASE_NOTES[0] && RELEASE_NOTES[0].v) || storedVer;
      const el = document.getElementById('en-sb-version');
      if (el) {
        // Bug f5b133dc: detect CDP/Playwright-opened tab and show indicator
        const _isCDP = !!(
          navigator.webdriver ||
          window.__playwright ||
          window.__pwInitScripts ||
          window._playwrightChannel
        );
        el.textContent = (loadedVer || fetchedVer) + (_isCDP ? ' [CDP]' : '');
      }
      if (loadedVer && loadedVer !== fetchedVer && fetchedVer !== _chVersionDismissed) {
        // Do NOT auto-reload — a silent reload would destroy in-progress work
        // (e.g. a mid-batch extraction review). Show a persistent, actionable
        // control instead; the user decides when to reload.
        _showVersionUpdateBanner(fetchedVer);
      }
      localStorage.setItem(_CH_VER_KEY, fetchedVer);
    })
    .catch(() => {});
}

/* Persistent, actionable "Reload to update" control shown when this tab's already-
   loaded code (loadedVer) no longer matches the live server (fetchedVer). Replaces
   the old passive toast (issue e9f1157c) which told the user the site had updated
   but gave them no way to actually get the new code short of guessing to hit F5.
   Never auto-reloads — the user clicks to opt in, so in-progress work is never lost
   without warning. Reuses the existing _savePageStateForVersionUpdate() /
   _restorePageStateAfterVersionUpdate() plumbing (issue 066423b5) rather than
   reinventing state preservation. */
function _showVersionUpdateBanner(fetchedVer) {
  if (document.getElementById('ch-ver-update-banner')) return; // already showing
  const bar = document.createElement('div');
  bar.id = 'ch-ver-update-banner';
  bar.style.cssText =
    // z-index 100000: intentionally above .report-overlay (99999, the full-screen
    // report preview) so the banner is never hidden behind it -- higher than the
    // documented --z-toast (9999) tier for that reason. See ui-standards.md z-index
    // ladder; .report-overlay's 99999 already sits outside that ladder too.
    'position:fixed;top:22px;left:50%;transform:translateX(-50%);z-index:100000;' +
    'background:var(--s3);border:1px solid var(--accent);border-radius:10px;' +
    'padding:11px 15px;font-size:12px;color:var(--text);display:flex;' +
    'align-items:center;gap:10px;max-width:440px;box-shadow:0 4px 18px rgba(0,0,0,.35)';
  const msg = document.createElement('span');
  msg.textContent =
    'A new version (' + fetchedVer + ') is available. Reload to update — your in-progress work will be preserved.';
  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'btn btn-em btn-sm';
  reloadBtn.textContent = 'Reload now';
  reloadBtn.style.flexShrink = '0';
  reloadBtn.onclick = function () {
    _savePageStateForVersionUpdate();
    location.reload();
  };
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'toast-x';
  dismissBtn.textContent = '✕';
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.onclick = function () {
    _chVersionDismissed = fetchedVer; // don't re-nag about this same version in this tab
    bar.remove();
  };
  bar.appendChild(msg);
  bar.appendChild(reloadBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

/* Save current page state to sessionStorage before a version-triggered reload.
         Issue 066423b5: ensures in-progress form values survive a forced page refresh. */
function _savePageStateForVersionUpdate() {
  try {
    const state = {};
    const activeView = document.querySelector('.view.active');
    if (activeView) state.activeViewId = activeView.id;
    const billModal = document.getElementById('billModal');
    if (billModal && billModal.classList.contains('open')) {
      state.billModalOpen = true;
      state.billModalValues = {};
      billModal.querySelectorAll('input[id^="bl-"]').forEach(function (inp) {
        if (inp.id) state.billModalValues[inp.id] = inp.value;
      });
      state.savedMeterId = udSelMeterId;
      state.savedBillEditId = udBillEditId;
    }
    state.udSelProjId = udSelProjId;
    state.udSelBldgId = udSelBldgId;
    sessionStorage.setItem('ch_page_state_ver_update', JSON.stringify(state));
  } catch (e) {}
}

/* Restore page state saved by _savePageStateForVersionUpdate.
         Called at the end of initEnergy() after all views render. Issue 066423b5. */
function _restorePageStateAfterVersionUpdate() {
  try {
    const raw = sessionStorage.getItem('ch_page_state_ver_update');
    if (!raw) return;
    sessionStorage.removeItem('ch_page_state_ver_update');
    const state = JSON.parse(raw);
    if (state.udSelProjId) udSelProjId = state.udSelProjId;
    if (state.udSelBldgId) udSelBldgId = state.udSelBldgId;
    if (state.activeViewId) {
      const viewName = state.activeViewId.replace(/^view-/, '');
      if (typeof sv === 'function') sv(viewName);
    }
    if (state.billModalOpen && state.billModalValues && state.savedMeterId) {
      showToast('Your in-progress form has been restored after the site update');
      setTimeout(function () {
        openBillModal(state.savedMeterId, state.savedBillEditId || null);
        setTimeout(function () {
          Object.keys(state.billModalValues).forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = state.billModalValues[id];
          });
        }, 200);
      }, 600);
    }
  } catch (e) {}
}

/* Open building modal pre-selected to a specific project (from Projects tool) */
function openBldgModalForProj(projId, editId) {
  udSelProjId = projId; // sync selection so saveBuilding knows which project
  openBldgModal(editId || null);
}

/* -- CLIENT CONTACTS -- */
let _modalContacts = [];

function _ccField(id) {
  return document.getElementById(id);
}
function _ccVal(id) {
  const e = _ccField(id);
  return e ? e.value.trim() : '';
}
function _ccSet(id, v) {
  const e = _ccField(id);
  if (e) e.value = v || '';
}

function saveContactRow() {
  const first = _ccVal('cc-first');
  const last = _ccVal('cc-last');
  if (!first && !last) {
    showToast('Enter at least a first or last name');
    return;
  }
  const editIdx = _ccVal('cc-edit-idx');
  const entry = {
    id: editIdx !== '' ? _modalContacts[parseInt(editIdx)].id : 'c' + Date.now(),
    title: _ccVal('cc-title'),
    first,
    last,
    phone: _ccVal('cc-phone'),
    email: _ccVal('cc-email'),
  };
  if (editIdx !== '') {
    _modalContacts[parseInt(editIdx)] = entry;
    showToast('Contact updated ?');
  } else {
    _modalContacts.push(entry);
  }
  _ccClearForm();
  renderModalContacts();
}

/* kept for backward compat — old HTML called addContactRow */
function addContactRow() {
  saveContactRow();
}

function startEditContact(idx) {
  const ct = _modalContacts[idx];
  if (!ct) return;
  _ccSet('cc-title', ct.title);
  _ccSet('cc-first', ct.first);
  _ccSet('cc-last', ct.last);
  _ccSet('cc-phone', ct.phone);
  _ccSet('cc-email', ct.email);
  _ccSet('cc-edit-idx', String(idx));
  const lbl = document.getElementById('cc-add-label');
  if (lbl) lbl.textContent = 'Editing: ' + (ct.first || '') + ' ' + (ct.last || '');
  const saveBtn = document.getElementById('cc-save-btn');
  if (saveBtn) saveBtn.textContent = '💾 Save Changes';
  const cancelBtn = document.getElementById('cc-cancel-edit-btn');
  if (cancelBtn) cancelBtn.style.display = '';
  // Scroll add-row into view
  const row = document.getElementById('mp-cc-add-row');
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderModalContacts();
}

function cancelEditContact() {
  _ccClearForm();
  renderModalContacts();
}

function _ccClearForm() {
  ['cc-first', 'cc-last', 'cc-phone', 'cc-email', 'cc-edit-idx'].forEach((id) => _ccSet(id, ''));
  _ccSet('cc-title', '');
  const lbl = document.getElementById('cc-add-label');
  if (lbl) lbl.textContent = 'Add Contact';
  const saveBtn = document.getElementById('cc-save-btn');
  if (saveBtn) saveBtn.textContent = '+ Add Contact';
  const cancelBtn = document.getElementById('cc-cancel-edit-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function renderModalContacts() {
  const wrap = document.getElementById('mp-contacts-list');
  if (!wrap) return;
  const editIdx = _ccVal('cc-edit-idx');
  if (!_modalContacts.length) {
    wrap.innerHTML = '<div class="cc-empty">No contacts yet — fill in the fields below and click + Add Contact.</div>';
    return;
  }
  wrap.innerHTML = _modalContacts
    .map((ct, i) => {
      const isEditing = editIdx !== '' && parseInt(editIdx) === i;
      return `<div class="cc-row${isEditing ? ' cc-row-editing' : ''}" id="ccrow-${ct.id}">
            <div class="cc-order-btns">
              <button class="cc-order-btn" onclick="moveContact(${i},-1)" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
              <button class="cc-order-btn" onclick="moveContact(${i},-1)" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
              <button class="cc-order-btn" onclick="moveContact(${i},1)"  ${i === _modalContacts.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
            </div>
            <div class="cc-field">
              <div style="font-weight:600;font-size:12px;margin-bottom:2px">${ct.first || ''} ${ct.last || ''}</div>
              ${ct.title ? `<span class="cc-title-badge">${ct.title}</span>` : ''}
            </div>
            <div class="cc-field" style="font-size:11px">${ct.phone || '<span style="color:var(--text3)">—</span>'}</div>
            <div class="cc-field" style="font-size:11px;word-break:break-all">${ct.email || '<span style="color:var(--text3)">—</span>'}</div>
            <button class="btn btn-ghost btn-sm" onclick="startEditContact(${i})" title="Edit contact" style="padding:2px 8px;font-size:10px">✏️</button>
            <div class="cc-field" style="font-size:11px">${ct.phone || '<span style="color:var(--text3)">—</span>'}</div>
            <div class="cc-field" style="font-size:11px;word-break:break-all">${ct.email || '<span style="color:var(--text3)">—</span>'}</div>
            <button class="btn-del" onclick="removeContact(${i})" title="Remove">✕</button>
          </div>`;
    })
    .join('');
}

function moveContact(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= _modalContacts.length) return;
  [_modalContacts[idx], _modalContacts[to]] = [_modalContacts[to], _modalContacts[idx]];
  renderModalContacts();
}

function removeContact(idx) {
  // If currently editing this contact, clear form first
  const editIdx = _ccVal('cc-edit-idx');
  if (editIdx !== '' && parseInt(editIdx) === idx) _ccClearForm();
  _modalContacts.splice(idx, 1);
  renderModalContacts();
}

/* -- CONTACTS DISPLAY IN PROJECT DETAIL TAB -- */
function buildContactsDetailHTML(contacts, projId) {
  const icons = {
    Owner: '👤',
    'Facilities Director': '🏢',
    'Facilities Manager': '🔧',
    'Energy Manager': '⚡',
    'Project Manager': '📋',
    Engineer: '⚙️',
    'Maintenance Supervisor': '🛠️',
    'Operations Manager': '📊',
    'Procurement Officer': '💼',
    'Financial Officer': '💰',
    'IT Director': '🖥️',
    'Executive Director': '🏛️',
    Superintendent: '🎓',
    Other: '👤',
  };
  if (!contacts || !contacts.length) {
    return `<div class="cc-empty">No contacts yet —
            <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="editProj(${projId})">+ Add Contacts</button></div>`;
  }
  return (
    '<div class="cc-card-grid">' +
    contacts
      .map(
        (ct) => `
          <div class="cc-card">
            <div class="cc-card-av">${icons[ct.title] || '👤'}</div>
            <div class="cc-card-info" style="flex:1">
              <div class="cc-card-name">${(ct.first || '') + ' ' + (ct.last || '')}</div>
              ${ct.title ? `<div class="cc-card-title">${ct.title}</div>` : ''}
              <div class="cc-card-meta">
                ${ct.phone ? `<span>📞 ${ct.phone}</span>` : ''}

                ${ct.email ? `<span>📧 <a href="mailto:${ct.email}">${ct.email}</a></span>` : ''}
              </div>
            </div>
          </div>`,
      )
      .join('') +
    '</div>'
  );
}

/* -- TOAST -- handled by site-ui.js showToast() */

// -- Formula Audit Popover --
let _formulaPopover = null;
function showFormula(html, evt) {
  if (evt) evt.stopPropagation();
  closeFormula();
  const pop = document.createElement('div');
  pop.id = '_formulaPop';
  pop.style.cssText =
    'position:fixed;z-index:9999;background:#0d1525;border:2px solid var(--em);border-radius:10px;padding:14px 18px;max-width:420px;min-width:240px;font-size:12px;color:#e0e8ff;box-shadow:0 8px 32px rgba(0,0,0,.6);line-height:1.6;';
  pop.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--em)">Formula Breakdown</span><button onclick="closeFormula()" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:0 4px">✕</button></div>' +
    html;
  document.body.appendChild(pop);
  if (evt && evt.target) {
    const r = evt.target.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 10) + 'px';
    pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 10) + 'px';
  } else {
    pop.style.top = '50%';
    pop.style.left = '50%';
    pop.style.transform = 'translate(-50%,-50%)';
  }
  _formulaPopover = pop;
  setTimeout(() => document.addEventListener('click', closeFormula, { once: true }), 100);
}
function closeFormula() {
  if (_formulaPopover) {
    _formulaPopover.remove();
    _formulaPopover = null;
  }
}
function _fml(label, formula, result, sources) {
  let h = '<div style="font-weight:600;color:#c8d8f0;margin-bottom:4px">' + label + '</div>';
  h +=
    '<div style="font-family:var(--mono);color:var(--violet);font-size:13px;margin-bottom:4px">' + formula + '</div>';
  if (result != null)
    h +=
      '<div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--em);margin-bottom:6px">= ' +
      result +
      '</div>';
  if (sources) {
    h += '<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:6px;margin-top:4px">';
    h +=
      '<div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Data Sources</div>';
    h += sources;
    h += '</div>';
  }
  return h;
}

/* -- NOTIFICATIONS -- */
let notifications = [];
async function loadNotifs() {
  try {
    const r = localStorage.getItem('ch_notifs');
    notifications = r ? JSON.parse(r) : [];
  } catch (e) {
    notifications = [];
  }
}
function saveNotifs() {
  try {
    localStorage.setItem('ch_notifs', JSON.stringify(notifications));
  } catch (e) {}
}
function addNotif(title, detail, icon) {
  notifications.unshift({ id: Date.now(), title, detail, icon: icon || '🔔', time: new Date().toISOString() });
  saveNotifs();
  refreshNotifUI();
}
function clearNotif(id) {
  notifications = notifications.filter((n) => n.id !== id);
  saveNotifs();
  refreshNotifUI();
  renderNotifList();
}
function clearAllNotifs() {
  notifications = [];
  saveNotifs();
  refreshNotifUI();
  renderNotifList();
}
function refreshNotifUI() {
  const b = document.getElementById('notifBadge');
  const p = document.getElementById('notifPip');
  if (!b) return;
  if (notifications.length) {
    b.style.display = 'inline-block';
    b.textContent = notifications.length;
    if (p) p.style.display = 'block';
  } else {
    b.style.display = 'none';
    if (p) p.style.display = 'none';
  }
}
function renderNotifList() {
  const el = document.getElementById('notifList');
  if (!el) return;
  if (!notifications.length) {
    el.innerHTML =
      '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text2)">No notifications</div>';
    return;
  }
  el.innerHTML = notifications
    .map((n) => {
      const ago = getTimeAgo(new Date(n.time));
      return `<div style="display:flex;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border);align-items:flex-start">
            <span style="font-size:16px;flex-shrink:0;margin-top:1px">${n.icon || '🔔'}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;margin-bottom:2px">${n.title}</div>
              <div style="font-size:12px;color:var(--text2);line-height:1.5">${n.detail}</div>
              <div style="font-size:10px;color:var(--text3);margin-top:3px;font-family:var(--mono)">${ago}</div>
            </div>
            <button onclick="clearNotif(${n.id})" style="width:22px;height:22px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text3);cursor:pointer;font-size:11px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .13s" onmouseover="this.style.borderColor='var(--red)';this.style.color='var(--red)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">✕</button>
          </div>`;
    })
    .join('');
}
function getTimeAgo(d) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function toggleNotifPanel() {
  const p = document.getElementById('notifPanel');
  if (!p) return;
  const open = p.style.display === 'block';
  p.style.display = open ? 'none' : 'block';
  if (!open) renderNotifList();
}
document.addEventListener('click', (e) => {
  const p = document.getElementById('notifPanel');
  const b = document.getElementById('notifBtn');
  if (p && p.style.display === 'block' && b && !p.contains(e.target) && !b.contains(e.target)) p.style.display = 'none';
});

/* -- CSV / QUICK ENTRY IMPORT -- */

window.addEventListener('DOMContentLoaded', function () {
  DB.warmCache().then(() => {
    loadNotifs();
    if (!notifications.length) {
      notifications = [
        {
          id: 1,
          title: 'Baseline Report Due',
          detail: 'Sample Regional Health System baseline report is due in 2 days. Review M&V data before submitting.',
          icon: '📋',
          time: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: 2,
          title: 'High Priority Task',
          detail: 'Upload utility bills Q1 — ISD is marked high priority and due this week.',
          detail: 'Upload utility bills Q1 — ISD is marked high priority and due this week.',
          icon: '⚡',
          time: new Date(Date.now() - 7200000).toISOString(),
        },
      ];
      saveNotifs();
    }
    refreshNotifUI();
    init();
    // Reset pending-write counter so init-time IDB writes (baseline inheritance,
    // migrations) do not trip the beforeunload guard.  Any user-initiated DB.set()
    // (bill save, import, settings change) happens on a later event-loop tick, so
    // the counter will correctly go > 0 again for genuine unsaved edits.
    DB.resetPendingWrites();
    document.querySelector('.content')?.classList.add('app-ready');
  });
});
window.addEventListener('resize', () => {
  ['utility', 'savings'].forEach((id) => {
    const viewEl = document.getElementById('view-' + id);
    if (viewEl && viewEl.classList.contains('active')) _setUDLayoutHeight(id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASHRAE GUIDELINE 36 AUDIT REPORT & SERVICE PROPOSAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ASHRAE36_GAP_DESCRIPTIONS — plain-language descriptions for each check
 * column key from the equipment matrix.
 * Each entry: { short, impact, plain }
 */
// Plain-language rewrite (no-abbreviations pass, 2026-07-31): `short`/`impact`/`plain` are the
// three DISPLAY fields client documents actually render (Executive Summary top-gap callout,
// Audit Report Sequences table "Requires:" sub-line fallback, Recommendations page). Object KEYS
// (sat/rat/mat/.../ahu_sat_reset/vav_zone_temp/...) are matched elsewhere (e.g.
// _RPT_A36_DCV_SEQ/_RPT_A36_FAN_SEQ above, EM_SEQUENCE_DEFS/EM_POINT_CATEGORIES in
// equipment-matrix.js) and are UNCHANGED.
var ASHRAE36_GAP_DESCRIPTIONS = {
  sat: {
    short: 'Supply air temperature sensor',
    impact: 'Reduces heating and cooling energy waste',
    plain: 'Required for supply air temperature reset, reducing heating and cooling energy based on actual demand.',
  },
  rat: {
    short: 'Return air temperature sensor',
    impact: 'Confirms system conditioning effectiveness',
    plain: 'Measures return air temperature, providing feedback on how effectively the system conditions the building.',
  },
  mat: {
    short: 'Mixed air temperature sensor',
    impact: 'Enables free cooling from outdoor air',
    plain: 'Required for economizer control — enables the system to use outdoor air instead of mechanical cooling.',
  },
  oat: {
    short: 'Outdoor air temperature sensor',
    impact: 'Required for weather-adaptive control',
    plain: 'Required for nearly every energy-saving sequence; without it, the system cannot adapt to changing weather.',
  },
  dsp: {
    short: 'Duct static pressure sensor',
    impact: 'Cuts fan energy versus fixed speed',
    plain:
      'Enables fan speed control based on actual demand instead of running the fan at fixed full speed at all times.',
  },
  sfVfd: {
    short: 'Supply fan variable frequency drive',
    impact: 'Cuts fan energy versus fixed speed',
    plain:
      'Allows fan speed to match load; energy consumption drops sharply as speed is reduced, following fan-affinity physics.',
  },
  satReset: {
    short: 'Supply air temperature reset sequence',
    impact: 'Reduces conditioning energy in mild weather',
    plain: 'Adjusts supply air temperature to match zone demand, reducing conditioning energy during mild weather.',
  },
  dspReset: {
    short: 'Duct static pressure reset sequence',
    impact: 'Cuts fan energy when demand is low',
    plain:
      'Lowers duct pressure when zones have adequate airflow, so the fan stops working harder than the building needs.',
  },
  economizer: {
    short: 'Economizer control sequence',
    impact: 'Reduces mechanical cooling run time',
    plain: 'Uses outdoor air for free cooling whenever conditions allow, reducing mechanical cooling run time.',
  },
  demandCtrl: {
    short: 'Occupancy-based ventilation control (carbon dioxide sensor)',
    impact: 'Avoids conditioning air for empty rooms',
    plain:
      'Reduces outdoor air to match actual occupancy, avoiding the energy cost of conditioning ventilation air for empty rooms.',
  },
  optStart: {
    short: 'Optimal start/stop sequence',
    impact: 'Eliminates unnecessary early-morning warm-up',
    plain:
      'Minimizes pre-occupancy warm-up time, eliminating early starts that condition an empty building each morning.',
  },
  hwReset: {
    short: 'Hot water supply temperature reset',
    impact: 'Cuts boiler heat loss, improves efficiency',
    plain: 'Reduces boiler water temperature as outdoor air warms, cutting heat loss and improving boiler efficiency.',
  },
  chwReset: {
    short: 'Chilled water supply temperature reset',
    impact: 'Improves chiller efficiency in light loads',
    plain: 'Raises chilled water temperature during light loads, allowing the chiller to run more efficiently.',
  },
  leadLag: {
    short: 'Lead/lag equipment rotation',
    impact: 'Extends equipment life through even wear',
    plain: 'Alternates the primary pump or boiler to distribute wear evenly and maximize equipment reliability.',
  },
  zoneCoolSp: {
    short: 'Zone cooling setpoint',
    impact: 'Baseline requirement',
    plain:
      'Defines the zone cooling target; required for code compliance and to prevent simultaneous heating and cooling.',
  },
  zoneHtgSp: {
    short: 'Zone heating setpoint',
    impact: 'Baseline requirement',
    plain: 'Defines the zone heating minimum and enables temperature setbacks to avoid heating empty rooms.',
  },
  discFlow: {
    short: 'Discharge airflow measurement',
    impact: 'Required for variable air volume minimum ventilation',
    plain:
      'Confirms minimum ventilation to each space and enables duct pressure reset sequences; both require measured airflow.',
  },
  hwSupTemp: {
    short: 'Hot water supply temperature sensor',
    impact: 'Required for HW reset',
    plain: 'Verifies boiler output and is required for the outdoor temperature reset strategy.',
  },
  hwRetTemp: {
    short: 'Hot water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain: 'Measures temperature drop across the heating system, flagging pump, balancing, or coil problems.',
  },
  hwDiffPres: {
    short: 'Hot water differential pressure sensor',
    impact: 'Lets pump slow when heating demand drops',
    plain: 'Enables the pump to slow when fewer zones call for heat rather than running at full speed.',
  },
  chwSupTemp: {
    short: 'Chilled water supply temperature sensor',
    impact: 'Required for CHW reset',
    plain:
      'Verifies chiller output and enables the temperature reset strategy that improves chiller efficiency during mild weather.',
  },
  chwRetTemp: {
    short: 'Chilled water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Measures chilled water utilization; poor utilization causes the chiller to work harder and cycle more often.',
  },
  chwDiffPres: {
    short: 'Chilled water differential pressure sensor',
    impact: 'Lets pump slow during light cooling loads',
    plain: 'Allows chilled water pumps to slow during light loads; pump energy drops sharply with speed.',
  },
  cwst: {
    short: 'Condenser water supply temperature sensor',
    impact: 'Improves chiller efficiency',
    plain:
      'Required for cooling tower control and the condenser water reset strategy that improves chiller efficiency.',
  },
  ctFanSpeed: {
    short: 'Cooling tower fan speed control',
    impact: 'Cuts tower fan energy versus fixed speed',
    plain:
      'Cuts tower fan energy by varying fan speed to maintain the condenser water setpoint instead of running fixed-speed.',
  },
  // ── AHU point keys ──────────────────────────────────────────────────────
  sfStatus: {
    short: 'Supply fan status feedback',
    impact: 'Required for proof-of-operation',
    plain: 'Confirms the fan is running, not just commanded on, preventing sequences from operating without airflow.',
  },
  sfSpeed: {
    short: 'Supply fan speed feedback',
    impact: 'Required for VFD verification',
    plain:
      'Confirms the drive is responding to commands; without it, a fault causing full-speed operation cannot be detected.',
  },
  sfEnable: {
    short: 'Supply fan enable command',
    impact: 'Required for scheduled operation',
    plain: 'Allows the control system to start and stop the air handler on occupancy schedules.',
  },
  sfSpeedCmd: {
    short: 'Supply fan speed command',
    impact: 'Cuts fan energy versus fixed speed',
    plain:
      'Commands drive speed; without it, the drive defaults to fixed speed and all variable-speed savings are lost.',
  },
  oaDampCmd: {
    short: 'OA damper position command',
    impact: 'Required for economizer control',
    plain:
      'Controls outdoor air volume for ventilation and free cooling; without it, economizer operation is not possible.',
  },
  raDampCmd: {
    short: 'Return air damper position command',
    impact: 'Required for economizer control',
    plain:
      'Works with the outdoor air damper to maintain airflow balance and prevent over-pressurization during free cooling.',
  },
  clgValve: {
    short: 'Cooling coil valve command',
    impact: 'Required for mechanical cooling control',
    plain:
      'Controls chilled water flow through the cooling coil; required for temperature reset and economizer coordination.',
  },
  htgValve: {
    short: 'Heating coil valve command',
    impact: 'Required for preheat and morning warm-up',
    plain:
      'Controls hot water flow through the heating coil; required for morning warm-up, freeze protection, and supply air control.',
  },
  freezeStat: {
    short: 'Freeze protection status',
    impact: 'Required for freeze protection safety',
    plain:
      'Triggers air handler shutdown when coil temperatures approach freezing, preventing costly water coil damage.',
  },
  oaFlow: {
    short: 'Outdoor airflow measurement',
    impact: 'Required for ventilation compliance',
    plain:
      'Measures actual outdoor air volume; without it, code-required minimum ventilation rates cannot be confirmed.',
  },
  oaEnthalpy: {
    short: 'Outdoor air enthalpy sensor',
    impact: 'Required for differential enthalpy economizer',
    plain:
      'Measures outdoor air temperature and humidity together, enabling the most accurate economizer control method.',
  },
  rfEnable: {
    short: 'Return fan enable command',
    impact: 'Required for building pressure control',
    plain:
      'Coordinates return fan operation with the supply fan to maintain stable building pressure during economizer mode.',
  },
  rfSpeedCmd: {
    short: 'Return fan speed command',
    impact: 'Required for building pressure control',
    plain:
      'Matches return fan speed to supply fan airflow, preventing pressure swings as the supply fan varies with load.',
  },
  bldgPressure: {
    short: 'Building static pressure sensor',
    impact: 'Required for relief fan/exhaust control',
    plain: 'Enables exhaust fan modulation to prevent over-pressurization during economizer operation.',
  },
  co2: {
    short: 'Carbon dioxide sensor (return or zone)',
    impact: 'Avoids conditioning air for empty rooms',
    plain: 'Measures occupancy through air quality, allowing the system to reduce outdoor air when rooms are empty.',
  },
  // ── VAV / Terminal point keys ────────────────────────────────────────────
  zoneTemp: {
    short: 'Zone air temperature sensor',
    impact: 'Required for zone control',
    plain: 'The required feedback signal for zone control; without it, airflow cannot be modulated to meet setpoints.',
  },
  coolSP: {
    short: 'Zone cooling setpoint',
    impact: 'Baseline requirement',
    plain: 'Defines the zone cooling target; required to prevent simultaneous heating and cooling.',
  },
  htgSP: {
    short: 'Zone heating setpoint',
    impact: 'Baseline requirement',
    plain: 'Defines the zone heating target and enables unoccupied setbacks to avoid heating empty spaces.',
  },
  dat: {
    short: 'Discharge air temperature sensor',
    impact: 'Required for reheat control',
    plain:
      'Monitors delivered air temperature, enabling precise reheat control and preventing overcooling at minimum airflow.',
  },
  fanStatus: {
    short: 'Air handling unit supply fan status (at terminal)',
    impact: 'Required for terminal unit sequencing',
    plain: 'Prevents the terminal damper from opening when the air handler is off, avoiding energy waste.',
  },
  dampCmd: {
    short: 'Damper position command',
    impact: 'Required for zone airflow control',
    plain:
      'Modulates conditioned air delivery to meet zone temperature setpoints and maintain minimum ventilation requirements.',
  },
  reheatValve: {
    short: 'Reheat valve command',
    impact: 'Required for zone heating',
    plain:
      'Controls the terminal reheat coil; without it, zone heating must come from the primary air system at higher cost.',
  },
  primaryFlow: {
    short: 'Primary (cold deck) airflow',
    impact: 'Required for fan-powered box control',
    plain: 'Measures cold primary air delivered to the terminal, driving damper modulation and local fan operation.',
  },
  termFanStatus: {
    short: 'Terminal fan status',
    impact: 'Required for fan-powered box proof',
    plain: 'Confirms the terminal fan is running and enables alarms when the fan fails to start as commanded.',
  },
  termFanEnable: {
    short: 'Terminal fan enable command',
    impact: 'Required for fan-powered box control',
    plain: 'Starts and stops the local fan on demand; without it, the fan runs continuously or not at all.',
  },
  coldDampCmd: {
    short: 'Cold deck damper command (dual-duct)',
    impact: 'Required for dual-duct cooling control',
    plain:
      'Controls cool air delivery in a dual-duct system; without it, simultaneous heating and cooling cannot be prevented.',
  },
  hotDampCmd: {
    short: 'Hot deck damper command (dual-duct)',
    impact: 'Required for dual-duct heating control',
    plain:
      'Controls warm air in a dual-duct system; both deck dampers must coordinate to prevent simultaneous heating and cooling.',
  },
  // ── HW Plant point keys ──────────────────────────────────────────────────
  hwst: {
    short: 'Hot water supply temperature sensor',
    impact: 'Required for HW reset sequences',
    plain:
      'Required for boiler control and the outdoor reset strategy that lowers water temperature as outdoor air warms.',
  },
  hwrt: {
    short: 'Hot water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Measures temperature drop across the heating system; a low reading signals pump, balancing, or coil problems.',
  },
  hwdp: {
    short: 'Hot water differential pressure sensor',
    impact: 'Lets pump slow when heating demand drops',
    plain: 'Allows the pump to slow when fewer zones call for heat rather than running at full design speed.',
  },
  boilerStatus: {
    short: 'Boiler status feedback',
    impact: 'Required for boiler staging',
    plain:
      'Confirms each boiler is firing and fault-free, enabling staged operation and automatic alarms when a boiler trips offline.',
  },
  boilerEnable: {
    short: 'Boiler enable command',
    impact: 'Required for boiler sequencing',
    plain:
      'Allows individual boilers to be started and stopped for staged operation; without it, all boilers run continuously.',
  },
  hwSetpoint: {
    short: 'HW supply temperature setpoint',
    impact: 'Required for outdoor air reset',
    plain:
      'Sets the boiler target temperature; outdoor air reset of this value is a high-impact boiler energy strategy.',
  },
  hwPumpStatus: {
    short: 'Hot water pump status feedback',
    impact: 'Required for pump sequencing',
    plain: 'Confirms heating water is circulating; enables lead/lag rotation and alarms if a pump fails.',
  },
  hwPumpEnable: {
    short: 'Hot water pump enable command',
    impact: 'Required for pump staging',
    plain:
      'Starts individual pumps for lead/lag sequences; without it, the plant cannot rotate or shed pumps at low demand.',
  },
  hwPumpSpeed: {
    short: 'Hot water pump speed command',
    impact: 'Matches pump speed to heating demand',
    plain: 'Allows the pump to match speed to actual heating demand rather than running at full design speed.',
  },
  // ── CHW Plant point keys ─────────────────────────────────────────────────
  chwst: {
    short: 'Chilled water supply temperature sensor',
    impact: 'Required for CHW reset sequences',
    plain:
      'Verifies chiller output and enables the setpoint reset strategy that improves chiller efficiency during mild weather.',
  },
  chwrt: {
    short: 'Chilled water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Measures chilled water utilization; poor utilization causes the chiller to over-cycle and consume excess energy.',
  },
  chwdp: {
    short: 'Chilled water differential pressure sensor',
    impact: 'Lets pump slow during light cooling loads',
    plain: 'Allows chilled water pumps to slow during light loads; pump energy drops sharply with speed.',
  },
  // ── HWP additional point keys ───────────────────────────────────────────
  hwFlow: {
    short: 'Hot water flow meter',
    impact: 'Required for BTU metering and delta-T monitoring',
    plain:
      'Measures actual heat delivered and detects low temperature-drop conditions that signal pumping or coil problems.',
  },
  hwIsoValve: {
    short: 'Boiler isolation valve status',
    impact: 'Required for safe boiler staging',
    plain:
      'Confirms boiler isolation valves are open before staging; a closed system risks pressure damage and failed starts.',
  },
  secHWPumpStatus: {
    short: 'Secondary hot water pump status feedback',
    impact: 'Required for secondary loop verification',
    plain:
      'Confirms distribution pumps are running and heat is reaching terminal units; enables lead/lag and failure alarms.',
  },
  hwIsoValveCmd: {
    short: 'Boiler isolation valve command',
    impact: 'Required for boiler sequencing',
    plain:
      'Isolates individual boilers during staging; without it, boilers require manual valve operation to be added or removed.',
  },
  // ── CHWP additional point keys ─────────────────────────────────────────
  chillerEvapDP: {
    short: 'Chiller evaporator differential pressure sensor',
    impact: 'Required for minimum flow protection',
    plain:
      'Confirms adequate flow through the chiller barrel; without it, low-flow conditions that freeze the evaporator go undetected.',
  },
  chwFlow: {
    short: 'Chilled water flow meter',
    impact: 'Required for ton metering and delta-T monitoring',
    plain:
      'Measures cooling delivered in tons and detects poor chilled water utilization that causes chiller over-cycling.',
  },
  chillerStatus: {
    short: 'Chiller run status feedback',
    impact: 'Required for chiller staging and alarming',
    plain: 'Confirms each chiller is running and fault-free; enables staged operation and fault alarms.',
  },
  pchwpStatus: {
    short: 'Primary chilled water pump status feedback',
    impact: 'Required for pump sequencing and alarming',
    plain: 'Confirms pump flow before chiller start; prevents evaporator damage and enables lead/lag rotation.',
  },
  schwpStatus: {
    short: 'Secondary chilled water pump status feedback',
    impact: 'Required for distribution loop verification',
    plain: 'Confirms cooling is being distributed; pump failures and lead/lag rotation cannot be managed without it.',
  },
  schwpSpeed: {
    short: 'Secondary chilled water pump speed feedback',
    impact: 'Required for pump VFD verification',
    plain: 'Confirms the drive is following speed commands; a stuck-at-full-speed fault cannot be detected without it.',
  },
  chwIsoValveStatus: {
    short: 'Chiller CHW isolation valve status feedback',
    impact: 'Required for safe chiller staging',
    plain:
      'Confirms the evaporator valve is open before the chiller starts; unconfirmed flow risks freeze damage and failed starts.',
  },
  chillerEnable: {
    short: 'Chiller enable command',
    impact: 'Required for chiller staging sequences',
    plain: 'Starts and stops individual chillers for staging; without it, all chillers run continuously.',
  },
  chwSetpoint: {
    short: 'Chiller leaving water temperature setpoint command',
    impact: 'Required for CHW supply temperature reset',
    plain:
      'Sets the chiller target temperature; raising it during mild weather is a high-impact chiller energy strategy.',
  },
  pchwpEnable: {
    short: 'Primary chilled water pump enable command',
    impact: 'Required for pump staging sequences',
    plain: 'Enables primary pump staging and lead/lag rotation; without it, pumps cannot be safely sequenced.',
  },
  schwpEnable: {
    short: 'Secondary chilled water pump enable command',
    impact: 'Required for distribution pump staging',
    plain:
      'Starts and stops distribution pumps in response to cooling demand; without it, secondary pumps run continuously.',
  },
  chwIsoValveCmd: {
    short: 'CHW isolation valve command',
    impact: 'Required for chiller isolation during staging',
    plain:
      'Opens and closes chiller evaporator ports during staging; without it, chillers require manual valve operation.',
  },
  // ── CT (Cooling Tower) point keys ─────────────────────────────────────────
  cwrt: {
    short: 'Condenser water return temperature sensor',
    impact: 'Required for condenser delta-T monitoring',
    plain:
      'Measures heat rejected through the cooling tower; a low temperature drop signals tower, chiller, or pumping problems.',
  },
  oaWetBulb: {
    short: 'Outdoor air wet-bulb temperature sensor',
    impact: 'Required for cooling tower approach control',
    plain:
      'Sets the cooling tower performance target and enables the condenser water reset that improves chiller efficiency.',
  },
  oaRH: {
    short: 'Outdoor air relative humidity sensor',
    impact: 'Supports wet-bulb calculation',
    plain:
      'Combined with outdoor temperature, enables wet-bulb calculation without a dedicated sensor for condenser water reset.',
  },
  ctFanStatus: {
    short: 'Cooling tower fan run status feedback',
    impact: 'Required for fan proof-of-operation',
    plain:
      'Confirms the tower fan is running; without it, failures allowing condenser water temperatures to rise cannot be detected.',
  },
  cwPumpStatus: {
    short: 'Condenser water pump run status feedback',
    impact: 'Required for pump proof-of-operation',
    plain:
      'Confirms condenser water is circulating before the chiller starts and enables lead/lag rotation and failure alarms.',
  },
  sumpLevel: {
    short: 'Cooling tower sump/basin water level',
    impact: 'Required for freeze and overflow protection',
    plain: 'Monitors basin level to prevent pump cavitation and detect overflow from a stuck-open makeup valve.',
  },
  cwIsoValveStatus: {
    short: 'Condenser water isolation valve status feedback',
    impact: 'Required for safe chiller staging',
    plain:
      'Confirms the condenser valve is open before the chiller starts; unconfirmed flow risks refrigerant damage and failed starts.',
  },
  ctFanEnable: {
    short: 'Cooling tower fan enable command',
    impact: 'Required for tower fan sequencing',
    plain:
      'Starts and stops tower fans based on condenser water temperature; without it, fans run continuously and cycling savings are lost.',
  },
  cwPumpEnable: {
    short: 'Condenser water pump enable command',
    impact: 'Required for condenser pump staging',
    plain:
      'Starts condenser pumps for chiller staging and lead/lag rotation; without it, safe chiller staging is not possible.',
  },
  cwIsoValveCmd: {
    short: 'Condenser water isolation valve command',
    impact: 'Required for chiller staging sequences',
    plain: 'Opens and closes condenser ports during staging; without it, chillers require manual valve operation.',
  },
  makeupValveCmd: {
    short: 'Cooling tower makeup water valve command',
    impact: 'Required for basin level control',
    plain:
      'Automatically refills the basin when level drops, preventing pump cavitation and overflow from a fixed valve position.',
  },
  // ── EM_SEQUENCE_DEFS sequence keys ──────────────────────────────────────
  ahu_sat_reset: {
    short: 'Supply air temperature reset sequence (air handling units)',
    impact: 'Reduces conditioning energy in mild weather',
    plain:
      'Adjusts supply air temperature to match outdoor conditions and zone demand, cutting conditioning energy during partial loads.',
  },
  ahu_dsp_reset: {
    short: 'Duct static pressure reset sequence (air handling units)',
    impact: 'Cuts fan energy when demand is low',
    plain:
      'Lowers duct pressure when zones have adequate airflow, so the fan stops working harder than the building needs.',
  },
  ahu_economizer: {
    short: 'Economizer control sequence (air handling units)',
    impact: 'Reduces mechanical cooling run time',
    plain: 'Uses outdoor air for free cooling whenever conditions allow, reducing chiller run time.',
  },
  ahu_freeze_prot: {
    short: 'Freeze protection sequence (air handling units)',
    impact: 'Required for coil safety',
    plain: 'Shuts down the air handler when freezing is detected, preventing costly water coil damage.',
  },
  ahu_min_oa: {
    short: 'Minimum outdoor air control sequence (air handling units)',
    impact: 'Required for ventilation compliance',
    plain:
      'Coordinates the outdoor air damper with fan speed to maintain code-required minimum ventilation during part-load operation.',
  },
  ahu_rf_control: {
    short: 'Return fan control sequence (air handling units)',
    impact: 'Required for building pressure control',
    plain:
      'Matches return fan speed to supply fan output to maintain pressurization; without it, economizer causes pressure swings.',
  },
  vav_zone_temp: {
    short: 'Zone temperature control sequence (variable air volume terminals)',
    impact: 'Required for zone comfort and compliance',
    plain:
      'Modulates airflow to maintain zone temperature between setpoints; without it, temperatures drift and simultaneous heating and cooling is common.',
  },
  vav_damper_writeback: {
    short: 'Damper position write-back sequence (variable air volume terminals)',
    impact: 'Required for position verification and diagnostics',
    plain:
      'Surfaces the damper command as a BACnet read-back point for fault detection; applicable to units that expose this point in the building automation system export.',
  },
  vav_reheat: {
    short: 'Zone reheat sequence (variable air volume terminals)',
    impact: 'Required for zone heating at minimum airflow',
    plain:
      'Activates reheat at minimum airflow; without it, zone heating falls to the primary air system, increasing air handler energy.',
  },
  hwp_supply_reset: {
    short: 'Hot water supply temperature reset sequence',
    impact: 'Cuts boiler heat loss, improves efficiency',
    plain: 'Reduces boiler water temperature as outdoor air warms, cutting heat loss and improving boiler efficiency.',
  },
  hwp_pump_dp_reset: {
    short: 'Hot water pump differential pressure reset sequence',
    impact: 'Lets pump slow when heating demand drops',
    plain: 'Lowers pump pressure when zone valves are wide open, allowing the pump to slow and cut energy.',
  },
  hwp_staging: {
    short: 'Boiler and pump staging sequence',
    impact: 'Required for efficient multi-boiler operation',
    plain:
      'Stages boilers and pumps to match actual demand and rotates lead/lag assignments; without it, all equipment runs continuously.',
  },
  chwp_supply_reset: {
    short: 'Chilled water supply temperature reset sequence',
    impact: 'Improves chiller efficiency in light loads',
    plain: 'Raises chilled water temperature during light loads, allowing the chiller to run more efficiently.',
  },
  chwp_pump_dp_reset: {
    short: 'Chilled water pump differential pressure reset sequence',
    impact: 'Lets pump slow during light cooling loads',
    plain:
      'Lowers pump pressure when coil valves are wide open, reducing pump speed and energy during partial-load hours.',
  },
  chwp_staging: {
    short: 'Chiller and pump staging sequence',
    impact: 'Required for efficient multi-chiller operation',
    plain:
      'Stages chillers and pumps based on cooling demand and rotates lead/lag assignments; without it, excess capacity runs at low efficiency.',
  },
  // ── VAV/zone DCV sequence key ──────────────────────────────────────────────
  vav_dcv: {
    short: 'Occupancy-based ventilation control (variable air volume zones)',
    impact: 'Avoids conditioning air for empty rooms',
    plain:
      'Adjusts outdoor air per zone based on carbon dioxide readings, avoiding the energy cost of ventilating empty rooms.',
  },
  // ── Heater point key ────────────────────────────────────────────────────────
  enable: {
    short: 'Heater enable / status',
    impact: 'Required for heater scheduling',
    plain:
      'Starts and stops unit heaters on occupancy schedules; without it, heaters run continuously during unoccupied hours.',
  },
  // ── VVT Zone point key ──────────────────────────────────────────────────────
  zoneDamper: {
    short: 'Zone damper position command',
    impact: 'Required for zone airflow control',
    plain: 'Controls conditioned air volume to each zone; without it, airflow cannot be modulated to meet setpoints.',
  },
  // ── oaRh lowercase alias (equipment-matrix uses lowercase h) ────────────────
  oaRh: {
    short: 'Outdoor air relative humidity sensor',
    impact: 'Supports wet-bulb calculation',
    plain:
      'Combined with outdoor temperature, enables wet-bulb calculation without a dedicated sensor for condenser water reset.',
  },
  // ── Setpoint value compliance gap types (Phase 5) ────────────────────────────
  // These describe deviations from GL36 §3.1.1.1 defaults, not missing hardware.
  // Label: "Needs Review" per design decision (never "Fail" — overrides are legitimate).
  spTempDeviation: {
    short: 'Zone setpoint differs from ASHRAE 36 §3.1.1.1 default',
    impact: 'Zero-hardware quick win',
    plain:
      'One or more zone setpoints differ from ASHRAE 36 defaults. Overrides are permitted — confirm these are intentional; corrections are a no-cost software change.',
  },
  spDeadbandTooNarrow: {
    short: 'Heating/cooling deadband below ASHRAE 36 §3.1.1.1 minimum (1°F)',
    impact: 'Zero-hardware quick win',
    plain:
      'The occupied deadband is below the ASHRAE 36 minimum of 1°F, causing heating and cooling to compete. Widening to at least 2°F requires only a programming change.',
  },
  spCO2Deviation: {
    short: 'Carbon dioxide ventilation setpoint differs from ASHRAE 36 Table 3.1.1.3 default',
    impact: 'Zero-hardware quick win',
    plain:
      'Zone carbon dioxide setpoint differs from the ASHRAE 36 default; an incorrect value causes over-ventilation or under-ventilation. Correction is software-only.',
  },
  spNotScheduled: {
    short: 'Setpoint value not found in export — schedule status unknown',
    impact: 'Data completeness',
    plain:
      'The building automation system export did not include a numeric value for this setpoint; the programmed value requires a direct building automation system lookup to verify.',
  },
};

/**
 * ASHRAE36_SEQUENCE_PLAIN — plain-English, non-technical descriptions used ONLY by the
 * "ASHRAE Guideline 36 Sequences" summary table (rptPageASHRAE36CostEstimate). Keyed by
 * EM_SEQUENCE_DEFS.key (equipment-matrix.js). Deliberately a SEPARATE object from
 * ASHRAE36_GAP_DESCRIPTIONS above — that dictionary is shared by the Executive Summary
 * top-gaps callout, per-building missing-point rows, and the Proposal's Scope of Work page,
 * so editing its wording risks unintended changes across those sections. This table's
 * content is new (2026-07-09 content reframe, Matt's decision: "all sequences, plain-
 * language") and needs its own curated, deliberately jargon-free copy — avoid terms like
 * "economizer," "BACnet," "BAS export" that a non-technical reader will not recognize.
 * DRAFT COPY, not final — see stages/audit-reframe-2026-07-09/sequence-descriptions.txt for
 * the sign-off list generated from this object; Matt should review before this ships broadly.
 */
var ASHRAE36_SEQUENCE_PLAIN = {
  ahu_sat_reset:
    'Adjusts how warm or cool the air the air handler delivers is, based on what the building actually needs, instead of holding one fixed setting at all times. This reduces energy use in mild weather.',
  ahu_dsp_reset:
    'Allows the supply fan to slow down when the building does not need full airflow, instead of pushing air at full force at all times. This reduces fan energy use.',
  ahu_economizer:
    'Uses outdoor air to cool the building whenever outdoor conditions allow, so the cooling equipment runs less and uses less energy.',
  ahu_freeze_prot:
    'Shuts the air handler down automatically if coil temperatures fall low enough to risk a frozen, burst water coil.',
  ahu_min_oa:
    'Maintains a minimum amount of fresh outdoor air entering the building at all times to meet ventilation requirements, even as fan speed changes.',
  ahu_rf_control:
    'Matches the speed of the return fan to the supply fan so the building does not develop pressure problems such as doors that are hard to open, or drafts.',
  vav_zone_temp:
    'Holds each room or zone at its target temperature by adjusting how much heated or cooled air is delivered to that space.',
  vav_damper_writeback:
    'Positions the air damper serving each zone as the control system directs, and confirms the damper reached that position, so a stuck or failed damper is identified promptly rather than quietly wasting energy or causing comfort complaints.',
  vav_reheat:
    'Adds a small amount of heat to already-cooled supply air at the zone level so a room does not overcool when it needs less airflow.',
  hwp_supply_reset:
    'Lowers the temperature of the hot water sent out to the building as the weather warms, so the boiler does not heat water hotter than the building requires.',
  hwp_pump_dp_reset:
    'Allows the hot water pump to slow down when fewer rooms are calling for heat, instead of pumping at full speed at all times.',
  hwp_staging:
    'Brings a second boiler online automatically only when the building needs the additional heat, and shuts it back off when demand drops, instead of running every boiler at all times.',
  chwp_supply_reset:
    'Raises the temperature of the chilled water sent out to the building when cooling loads are light, so the chiller does not work as hard as it does on a full-load day.',
  chwp_pump_dp_reset:
    'Allows the chilled water pump to slow down when cooling demand is low, instead of pumping at full speed at all times.',
  chwp_staging:
    'Brings a second chiller online automatically only when the building needs the additional cooling, and shuts it back off when demand drops.',
  demandCtrl:
    'Uses a carbon dioxide sensor to bring in only as much outdoor air as the number of people in the building calls for, instead of a fixed amount around the clock.',
  vav_dcv:
    'Uses a carbon dioxide sensor at the zone level to adjust ventilation air to the number of people actually in that room.',
};

/**
 * _a36SeqDisplayLabel(sd) — client-facing display name for one EM_SEQUENCE_DEFS entry.
 *
 * V-11 (visual review 2026-08-02): EM_SEQUENCE_DEFS names vav_damper_writeback
 * "Damper Position Write-back". "Write-back" is controls-trade jargon a county facilities
 * manager cannot read, and the Audit's Executive Summary already names the same concept in
 * plain language on an earlier page — ASHRAE36_GAP_DESCRIPTIONS.dampCmd.short,
 * "Damper position command", the very point (requiredCats: ['dampCmd']) this sequence writes.
 * One concept must carry one name, so the client documents render the Executive Summary's
 * plain-language name in both places.
 *
 * Kept as an override map HERE rather than a rename in equipment-matrix.js on purpose: that
 * label is also an internal Equipment Matrix column heading and a pricing-row `item` string,
 * and this change is scoped to what the client reads. Any key absent from the map falls
 * through to the def's own label, so new sequence defs need no change here.
 *
 * @param {object} sd - one entry from EM_SEQUENCE_DEFS
 * @returns {string} display label
 */
var A36_SEQ_LABEL_OVERRIDE = {
  vav_damper_writeback: 'Damper Position Command',
};

/**
 * Column widths for the Audit's Control Sequences table (rptPageASHRAE36CostEstimate), as
 * percentages of the 718.9px printed table width. Named here because the header cells, the body
 * cells and the row-height estimate all have to agree on them.
 *
 * Set 2026-08-03 (V-10) when the quantity column was added. Sized from measured natural widths at
 * the 13.34px font floor, per the method in
 * my-knowledge-base/wiki/companyhub-report-print-geometry-and-font-floor.md §7: what has to fit in
 * a header cell is its longest UNBREAKABLE WORD, not the whole label. Quantity column header is
 * "Number to Program", whose longest word "NUMBER" is far narrower than "SEQUENCES" would be — the
 * reason that wording was chosen over "Sequences to Program", which needs 14% to avoid printing
 * across its own column rule. The room came from the description column, whose text wraps
 * gracefully, never from a column with an unbreakable header word.
 */
var A36_SEQ_COL_NAME_PCT = 24;
var A36_SEQ_COL_SPEC_PCT = 16;
var A36_SEQ_COL_QTY_PCT = 13;
var SEQ_ROW_TOTALS_H = 80; // measured height of the totals row at the floored type size
function _a36SeqDisplayLabel(sd) {
  if (!sd) return '';
  return A36_SEQ_LABEL_OVERRIDE[sd.key] || sd.label || '';
}

/**
 * ASHRAE36_SECTIONS — defines available report sections for the audit and proposal.
 * Mirrors the REPORT_SECTIONS pattern.
 */
var ASHRAE36_SECTIONS = {
  audit: [
    { key: 'cover', label: 'Cover Page', group: 'Report', defaultOn: true },
    { key: 'executive', label: 'Executive Summary', group: 'Report', defaultOn: true },
    { key: 'costEstimate', label: 'ASHRAE 36 Sequences', group: 'Report', defaultOn: true },
    // 2026-07-30 (Matt's decision): Per-Building Detail, Setpoint Programming Review, and Point
    // Inventory Completeness flipped to opt-in (default OFF) -- Matt unchecks these three for
    // every client copy of the Audit Report, so the tool now starts in the shape he actually
    // ships. Sections are unchanged and fully available when checked; only the modal's initial
    // checkbox state changed (openASHRAE36ReportModal renders `checked` from `defaultOn !== false`).
    { key: 'building', label: 'Per-Building Detail', group: 'Report', defaultOn: false },
    // a0c2152 (2026-07-06): power monitoring / OA-sensor metadata is not ASHRAE 36 scoring
    // content. Matt has twice asked why non-ASHRAE content is in the report, so this
    // callout is now an independent, unchecked-by-default sub-option (threaded into
    // rptPageASHRAE36Building via showBuildingInfra) rather than always baked into the
    // Per-Building Detail pages.
    {
      key: 'buildingInfra',
      label: 'Include building infrastructure notes (not part of ASHRAE 36 scoring)',
      group: 'Report',
      defaultOn: false,
    },
    // Batch 3 item 6 / plan 3e Option A: Recommendations page deleted (41pp -> 40pp). Gap
    // Details already covers the same findings with real ASHRAE 36 spec citations that
    // Recommendations lacked — removing the page eliminates the "what's the difference
    // between these two sections" complaint by removing one of the two sections.
    // rptPageASHRAE36Recommendations() itself is left defined (no other callers) — only its
    // inclusion in the Audit section list / generation pipeline is removed.
    { key: 'setpointReview', label: 'Setpoint Programming Review', group: 'Report', defaultOn: false },
    // Phase D-3: Point inventory completeness — informational only, never affects Coverage %
    { key: 'pointInventory', label: 'Point Inventory Completeness', group: 'Report', defaultOn: false },
  ],
  proposal: [
    // 2026-07-26 rebuild (spec: AI/_context/specs/joco-service-proposal-target-2026-07-23.md):
    // Matt's hand-built Word target is a 3-page Title/Exec Summary/Findings + Recommended Services
    // + Phase table + Long-Term Vision document — replacing the old 9-page cover+scope+pricing
    // shape. 'proposalCover' now renders page 1 of that structure (still the toggle key so
    // existing stored preferences don't dangle); 'proposalPhaseTable' and 'proposalVision' are
    // pages 2 and 3, new keys, default ON since they're integral to the new default shape.
    //
    // 2026-07-27: these two toggles still gate independent content (the Phase table vs. the
    // Implementation Plan/Long-Term Vision/Disclaimer), but as of this date, whenever BOTH are ON
    // (the default), generateASHRAE36ProposalHTML renders them onto ONE merged physical page
    // (rptPageASHRAE36ProposalPhaseAndVision) instead of two mostly-empty pages — see that
    // function's header comment. The checkboxes/labels below are unchanged; only the assembly
    // step changed.
    { key: 'proposalCover', label: 'Proposal Summary (Title, Findings, Services)', group: 'Proposal', defaultOn: true },
    { key: 'proposalPhaseTable', label: 'Recommended Services — Phase Table', group: 'Proposal', defaultOn: true },
    // futureWorkInline (2026-07-29, months + Future Work rebuild — Matt, verbatim: "Do it as
    // months and then give me the ability to see the future work in the table or as a standalone
    // section."): default OFF = Future Work renders as its own standalone section (on the
    // Implementation Plan & Long-Term Vision page). Checking this box instead folds Future Work
    // into the Recommended Services — Phase Table as an extra row, and the standalone section is
    // suppressed so it is never shown twice. See _pricingProposalTermAndFuture's header comment.
    {
      key: 'futureWorkInline',
      label: '  Show Future Work inside the Phase table (instead of its own section)',
      group: 'Proposal',
      defaultOn: false,
      indent: true,
    },
    // R7 (2026-08-03, V-23): "&" spelled out, matching every other label and the section's own
    // headings in the rendered document (which are now "Implementation Plan" and "Long-Term
    // Vision", two separate headings — see _rptA36VisionInnerHTML).
    { key: 'proposalVision', label: 'Implementation Plan and Long-Term Vision', group: 'Proposal', defaultOn: true },
    // 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's approved spec): two NEW independent
    // opt-in sections, BOTH default OFF. Each describes what that scope of work ENTAILS (categories
    // of work) and states it is funded through the monthly service allowance — never a whole-scope
    // dollar total. Replace the deleted Cover-page Stage 1/Stage 2 blocks that used to state
    // af.complianceFmt/af.remainderFmt totals. See rptPageASHRAE36ProposalComplianceScope /
    // rptPageASHRAE36ProposalFullScope (near rptPageASHRAE36ProposalScope below).
    { key: 'complianceScope', label: 'ASHRAE 36 Compliance', group: 'Proposal', defaultOn: false },
    { key: 'fullScope', label: 'Full Scope', group: 'Proposal', defaultOn: false },
    // Legacy detailed Scope of Work page (Phase 1 Hardware / Phase 2 Sequences tables) — kept and
    // NOT deleted (hard constraint: don't destroy existing capability) but flipped to opt-in
    // (default OFF) now that it's no longer part of the default proposal shape.
    { key: 'proposalScope', label: 'Detailed Scope of Work (legacy)', group: 'Proposal', defaultOn: false },
    // ebfca114 (Matt's decision): opt-in priced Cost Estimate page. Default OFF — the client PDF
    // shows no dollar figures unless the user explicitly checks this box. Renders via
    // rptPageASHRAE36ProposalPricing (a NEW function; NOT the Audit's zero-dollar glossary
    // rptPageASHRAE36CostEstimate). Numbers come from the SAME _pricingComputeSummaryData chain the
    // interactive Cost Estimate tab's Summary sub-tab uses, so the report matches the tool.
    { key: 'costEstimate', label: 'Cost Estimate (Priced Tiers)', group: 'Proposal', defaultOn: false },
    // Selectable pricing detail sub-options. Independent flags following the buildingInfra
    // precedent (an independent sub-flag that only takes effect when its parent section is on) —
    // each only renders when the parent costEstimate box is ALSO checked (gated in
    // generateASHRAE36ProposalHTML and again inside rptPageASHRAE36ProposalPricing). indent:true
    // draws them visually nested under "Cost Estimate (Priced Tiers)" in the modal. Client-safe:
    // final lineTotal / phase subtotals / measure names / clientSummary only — no cost build-up.
    {
      key: 'costEstimatePhaseSplit',
      label: '  Hardware vs Programming subtotals',
      group: 'Proposal',
      defaultOn: true,
      indent: true,
    },
    { key: 'costEstimateItemized', label: '  Itemized Measures', group: 'Proposal', defaultOn: false, indent: true },
    // 'Expected Outcomes' toggle removed 2026-07-22 along with rptPageASHRAE36ProposalOutcomes —
    // the page it controlled no longer exists, so the checkbox was deleted rather than left dead.
    // 'Per-Building Pricing' (costEstimatePerBuilding) toggle removed 2026-07-22 along with
    // _buildPerBuildingPages, per Matt's explicit request ("The Cost Estimate per building I do
    // not like and it honestly gives no information. Just remove completely.") — see the removal
    // note in rptPageASHRAE36ProposalPricing.
  ],
};

// ─── ASHRAE 36 readiness score thresholds ─────────────────────────────────
// fix/audit-report-scoring (2026-07-14, Matt's decision): single source of truth for the
// two band cutoffs used everywhere a building/portfolio score is turned into a
// green/amber/red status or a "High/Partial/Low Readiness" word. Every caller below reads
// these constants instead of repeating the literals 75/50, and the methodology footnote
// interpolates them directly so the printed thresholds can never drift from the code that
// actually applies them.
var ASHRAE36_READINESS_HIGH_THRESHOLD = 75; // score >= this => 'green' / "High Readiness"
var ASHRAE36_READINESS_PARTIAL_THRESHOLD = 50; // score >= this (and < HIGH) => 'amber' / "Partial Readiness"; below => 'red' / "Low Readiness"

/**
 * a36ReadinessBand / a36ReadinessColor / a36ReadinessWord — the ONE place a readiness
 * percentage becomes a band key, a color and a word (work unit R2, 2026-08-03).
 *
 * WHY THIS EXISTS (VISUAL-REVIEW-2026-08-02.md V-01, the review's #4 "matters most" finding).
 * The two thresholds above were already shared, but the three-way ternary that turns a score
 * into a COLOR was copy-pasted at four sites, and the Audit cover carried a fourth, entirely
 * separate rule of its own: a 2026-07-29 brand-color pass hardcoded the cover's Composite
 * Score ring to CSC blue and both other rings to CSC green. The result measured on the live
 * v2026.08.02.742 export: the cover printed Sensor Coverage 62% and Sequence Readiness 52% in
 * #27ae60 — the exact green pages 2-3 label "High Readiness" — while those same pages define
 * High as 75% and above and color every one of the 27 rows in the 50-74% band orange, and the
 * Composite Score 60% printed in a dark blue that appears in no legend anywhere in the
 * document. The first thing the county saw was three rings reading "we are doing fine" and
 * two pages later the same numbers reading "Partial Readiness".
 *
 * A percentage may now be turned into a color ONLY through a36ReadinessColor(). Do not write
 * another `pct >= HIGH ? green : ...` ternary, and never hand a gauge a literal brand color:
 * that is precisely how the cover drifted away from the table it summarizes. All three cover
 * gauges (composite, sensor coverage, sequence readiness) are the same kind of quantity on the
 * same 0-100 scale — the share of applicable ASHRAE 36 requirements that are met — so the same
 * band rule applies to all three, and the cover legend printed beneath them is interpolated
 * from these same two constants.
 *
 * @param {number|null} pct - readiness percentage, or null/undefined for "no applicable scope"
 * @returns {string|null} 'green' | 'amber' | 'red', or null when pct is not a number
 */
function a36ReadinessBand(pct) {
  var n = Number(pct);
  if (pct === null || pct === undefined || isNaN(n)) return null;
  if (n >= ASHRAE36_READINESS_HIGH_THRESHOLD) return 'green';
  if (n >= ASHRAE36_READINESS_PARTIAL_THRESHOLD) return 'amber';
  return 'red';
}

/** Band key -> report color token. The only mapping; every caller reads it. */
var ASHRAE36_READINESS_BAND_COLORS = {
  green: 'var(--rpt-green)',
  amber: 'var(--rpt-orange)',
  red: 'var(--rpt-red)',
};

/** Band key -> client-visible word (see _a36StatusChip for the wording history). */
var ASHRAE36_READINESS_BAND_WORDS = {
  green: 'High Readiness',
  amber: 'Partial Readiness',
  red: 'Low Readiness',
};

/** Readiness percentage -> the color token the readiness table uses for that same percentage. */
function a36ReadinessColor(pct) {
  var band = a36ReadinessBand(pct);
  return band ? ASHRAE36_READINESS_BAND_COLORS[band] : 'var(--rpt-page-text)';
}

/** Readiness percentage -> the readiness word the readiness table uses for that same percentage. */
function a36ReadinessWord(pct) {
  var band = a36ReadinessBand(pct);
  return band ? ASHRAE36_READINESS_BAND_WORDS[band] : '';
}

// ─── Client-visible name and number formatting (work unit R5, 2026-08-03) ──
// Defects fixed here: D-14/V-08 (internal identifier "P25309 - " leaking into the client
// building column, and the alphabetical sort corruption it caused), V-07 (raw source-system
// building names), D-21 ("Sheriffs" missing its apostrophe), V-40 (mixed straight/curly
// apostrophes), D-22 (counts printed with a thousands separator in the Proposal and without
// one in the Audit).
//
// THIS IS A DISPLAY LAYER ONLY. Nothing here writes back to the Equipment Matrix. Every
// building object keeps its raw `name` (which is the key every Equipment Matrix row is matched
// against, e.g. `if (r.building !== b.name) return;`) and gains a `displayName` used for every
// string a client ever reads. Do not "simplify" this by renaming `name` — that silently breaks
// per-building row matching in four places.

/**
 * RPT_BUILDING_NAME_RULES — ordered display-only rewrites, applied in sequence.
 *
 * EVIDENCE FOR EVERY RULE (nothing here is guessed; see the report for the ones deliberately
 * NOT expanded):
 *
 *  1. `^P\d+\s*-\s*` — the BAS/internal project identifier prefix. Only occurrence in real
 *     data is "P25309 - Jo Co Arts and Heritage". Matt's own Service Proposal target document
 *     (_context/specs/joco-service-proposal-target-2026-07-23.md, Facilities Included row)
 *     names this building "Jo Co Arts and Heritage" with no prefix. Stripping it also repairs
 *     the sort, which is why the sort below keys on the display name.
 *  2. `Jo Co ` -> `Johnson County ` — "Jo Co" is an abbreviation of the client's own name. The
 *     stored client name is "Johnson County, Kansas" and the WebCTRL BACnet tree root for these
 *     buildings is literally "/Johnson County/" (dashboardlogic.md: "/Johnson County/Courthouse
 *     -> Courthouse").
 *  3. `NC ` -> `New Century ` — every NC-prefixed building sits directly under the WebCTRL
 *     campus node "/New Century Complex/" in the raw exports: "/New Century Complex/NC Adult
 *     Detention Center", "/New Century Complex/NC Arc 1", "/New Century Complex/NC Arc 4",
 *     "/New Century Complex/NC Arc Programs Building", "/New Century Complex/NC Sheriff's
 *     Operations Building" (_context/backlog/investigations/c350cb0f-setpoint-verification.md,
 *     audit-plant-leveling-and-tiers.md, stages/3d6d7244/investigation.md). The naming
 *     convention is city/campus-prefixed throughout the same list ("Olathe Adult Detention
 *     Center" vs "NC Adult Detention Center"), and "New Century Complex" is itself a building
 *     row in the same Equipment Matrix. Source-system evidence, not an inference from initials.
 *  4. `Firestation-13` -> `Fire Station 13`. Plain English spelling of a run-together source
 *     token; no expansion of an unknown abbreviation is involved.
 *  5. `Sheriffs ` -> `Sheriff's ` (curly). D-21. The same documents already write
 *     "NC Sheriff's Operations Building", and the proposal target spec writes
 *     "Sheriff's Fleet Maintenance".
 *  6. Straight apostrophe -> curly (U+2019) everywhere. V-40. Source data carries straight
 *     apostrophes in "NC Sheriff's Operations Building" / "NC Sheriff's Warehouse" while the
 *     surrounding prose uses curly ones.
 *
 * DELIBERATELY NOT EXPANDED (no evidence found; a wrong expansion in a client document is far
 * worse than an unexpanded one): "Arc" (as in "New Century Arc 1/3/4" and "Arc Programs
 * Building"), "MedAct", and "51/SS" in "MedAct 51/SS Olathe". Nothing in this repository, the
 * Equipment Matrix, _context/specs/ or _context/reference/ states what they stand for, so they
 * are printed exactly as stored, pending Matt's confirmation.
 */
var RPT_BUILDING_NAME_RULES = [
  { re: /^\s*P\d+\s*[-–—]\s*/i, to: '' },
  { re: /\bJo\s+Co\b/g, to: 'Johnson County' },
  { re: /\bNC\b/g, to: 'New Century' },
  { re: /\bFire\s*station\s*[-\s]\s*(\d+)/gi, to: 'Fire Station $1' },
  { re: /\bSheriffs\b/g, to: 'Sheriff’s' },
  { re: /'/g, to: '’' },
];

var _RPT_BLDG_NAME_CACHE = {};

/**
 * rptBuildingDisplayName — THE single place a stored building name becomes a client-visible one.
 * Every client document (Audit cover, readiness table, per-building detail, recommendations,
 * setpoint review, point inventory, Proposal schedule, Agreement scope list) renders through
 * this. Pure and memoized; never mutates the Equipment Matrix.
 *
 * @param {string} raw stored Equipment Matrix building name
 * @returns {string} client-visible name
 */
function rptBuildingDisplayName(raw) {
  var s = raw == null ? '' : String(raw);
  if (!s) return s;
  if (Object.prototype.hasOwnProperty.call(_RPT_BLDG_NAME_CACHE, s)) return _RPT_BLDG_NAME_CACHE[s];
  var out = s;
  for (var i = 0; i < RPT_BUILDING_NAME_RULES.length; i++) {
    out = out.replace(RPT_BUILDING_NAME_RULES[i].re, RPT_BUILDING_NAME_RULES[i].to);
  }
  out = out.replace(/\s{2,}/g, ' ').trim();
  _RPT_BLDG_NAME_CACHE[s] = out;
  return out;
}

/**
 * rptBuildingNameSort — comparator that orders buildings by their CLIENT-VISIBLE name.
 * D-14/V-08: with the raw name, "P25309 - Jo Co Arts and Heritage" filed under P, between
 * "Olathe Sheriff Training Facility" and "Sheriffs Fleet Maintenance", so a reader looking
 * under J concluded the building had been left out of the audit.
 */
function rptBuildingNameSort(a, b) {
  return rptBuildingDisplayName(a).localeCompare(rptBuildingDisplayName(b), 'en');
}

/**
 * rptCount — THE formatter for every client-visible whole-number count (buildings, equipment
 * units, sequences, sensors, points). D-22: the Audit cover and narrative printed "1594",
 * "1285", "1291" while the Proposal printed "1,594" for the same figure. Both documents now
 * call this, so they cannot disagree. Not for currency (see the per-page fmtUSD helpers) and
 * not for percentages.
 *
 * @param {number|string} v
 * @returns {string} e.g. 1594 -> "1,594"
 */
function rptCount(v) {
  var n = Number(v);
  if (!isFinite(n)) return String(v == null ? '' : v);
  return Math.round(n).toLocaleString('en-US');
}

/**
 * _a36DisplayName — convenience accessor for the report page templates. Takes any object that
 * carries a building name (collectASHRAE36Data's buildings/point-inventory rows all carry both
 * `name` and `displayName`) and returns the client-visible string, computing it on the fly for
 * any object that predates the displayName field.
 */
function _a36DisplayName(b) {
  if (!b) return '';
  if (typeof b === 'string') return rptBuildingDisplayName(b);
  return b.displayName || rptBuildingDisplayName(b.name || b.building || '');
}

// ─── collectASHRAE36Data ───────────────────────────────────────────────────
/**
 * Reads equipment matrix data and computes compliance scores for all buildings.
 * Returns a structured data object consumed by the page template functions.
 *
 * @param {number|string} projId
 * @returns {object|null}
 */
function collectASHRAE36Data(projId, reportDate) {
  if (typeof emLoadMatrix !== 'function') return null;
  var matData = emLoadMatrix(projId);
  if (!matData || !matData.rows || !matData.rows.length) return null;

  var proj = (typeof projects !== 'undefined' ? projects : []).find(function (x) {
    // Coerce both sides to string to handle numeric id vs string projId mismatch
    return String(x.id) === String(projId);
  });
  var projName = proj ? proj.client || proj.name || 'Project' : 'Project';
  var dateObj = reportDate ? new Date(reportDate + 'T00:00:00') : new Date();
  if (isNaN(dateObj)) dateObj = new Date();
  var dateStr = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Group rows by building
  var bldgMap = {};
  matData.rows.forEach(function (row) {
    var bName = row.building || 'Unknown Building';
    if (!bldgMap[bName]) bldgMap[bName] = [];
    bldgMap[bName].push(row);
  });

  // Auditable equipment categories (excludes 'other')
  var AUDITABLE = [
    'ahu',
    'vav',
    'fpb',
    'ddvav',
    'hwp',
    'chwp',
    'ct',
    'doas',
    'fcu',
    'zone',
    'furnace',
    'heater',
    'ef',
    'rtu',
  ];
  var CAT_LABELS = {
    ahu: 'Air Handling Unit',
    rtu: 'Rooftop Unit',
    vav: 'Variable Air Volume Terminal',
    fpb: 'Fan-Powered Terminal',
    ddvav: 'Dual-Duct Terminal',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Tower',
    doas: 'Dedicated Outdoor Air System',
    fcu: 'Fan Coil Unit',
    zone: 'Zone Terminal',
    furnace: 'Furnace',
    heater: 'Heater',
    ef: 'Exhaust Fan',
  };

  // Compute per-building compliance
  var buildingsData = [];
  var portfolioGapCounts = {}; // key -> count across all buildings
  var totalMissingHardwarePoints = 0; // sum of missing required sensor/actuator points across all equipment
  var totalNotReadySequences = 0; // sum of blocked/partial sequences across all equipment

  Object.keys(bldgMap).forEach(function (bName) {
    var rows = bldgMap[bName];

    // Plan §5: Detect power metering and OA sensor programs BEFORE filtering to
    // auditableRows. These categories are intentionally excluded from AUDITABLE
    // but their presence is meaningful infrastructure metadata per building.
    var hasPowerMonitoring = rows.some(function (r) {
      return r.category === 'power';
    });
    var hasOAConditions = rows.some(function (r) {
      return r.category === 'sensor';
    });

    // 2224d15d: Integration-stub filter — exclude WebCTRL "Data Transfer - Requesting"
    // programs. These are signal fanout stubs (one per served floor) that broadcast plant
    // demand/request signals to floor AHU/VAV controllers. They are NOT the physical plant
    // controller and must not appear as separate plant audit rows (would inflate chwp/hwp
    // counts and produce meaningless compliance scores).
    //
    // Detection (two-layer for forward + backward compat):
    //   Primary: row.bacnetLocation contains "/Integration/Data Transfer" — set on rows
    //     imported AFTER this fix. Matches exactly the WebCTRL pattern for these stubs.
    //   Legacy fallback: row.equipName matches a floor-prefixed plant name — covers rows
    //     stored before bacnetLocation was persisted. Pattern is specific: "Basement -"
    //     or ordinal-floor prefix ("1st Floor -", "2nd Floor -", etc.) followed by
    //     "Chiller Plant", "Boiler Plant", or "Hot Water Plant".
    //
    // Does NOT exclude real plant controllers:
    //   "Chiller Plant Manager - Courthouse" — no floor prefix, no Integration path
    //   "Hot Water System - Courthouse" — neither pattern matches
    // Does NOT exclude VFD Integration rows (e.g. "Chilled Water Pump 1 VFD Integration") —
    //   those classify as category 'other' and are excluded from AUDITABLE before this
    //   filter runs, so the third layer below never sees them.
    var _EM_INTEGRATION_STUB_PATH_RE = /\/Integration\/Data\s+Transfer\b/i;
    var _EM_INTEGRATION_STUB_NAME_RE =
      /^(?:basement|\d+(?:st|nd|rd|th)\s+floor)\s*[-–]\s*(?:chiller|boiler|hot\s*water)\s*plant\b/i;
    // Third layer: JOCO-style stubs stored without bacnetLocation, named
    //   "Chiller 1 Integration".."Chiller 4 Integration" and
    //   "Boiler 1 Integration".."Boiler 4 Integration" (equipName === equipType).
    //   Also catches typo variants like "VFD Integration5" (stray digit suffix).
    // Matches any name ending with "Integration" followed by optional digits.
    var _EM_INTEGRATION_STUB_SUFFIX_RE = /\bIntegration\d*$/i;
    // Fourth layer: floor-based data-relay stubs for plant equipment.
    //   These are WebCTRL "Data Transfer - Requesting" programs installed on each floor
    //   to relay chilled-water or hot-water demand/request signals from floor-level VAV/AHU
    //   controllers back to the central plant manager. They share the plant equipName
    //   (e.g. "Chiller Plant", "Boiler Plant") but are scoped to a single floor via their
    //   location field (e.g. "1st Floor", "Basement").
    //   Catches: equipName exactly "Chiller Plant" OR "Boiler Plant" (extra spaces tolerated)
    //            AND location matches a floor designator pattern.
    var _EM_FLOOR_STUB_EQUIP_RE = /^(?:chiller|boiler)\s+plant\s*$/i;
    var _EM_FLOOR_STUB_LOC_RE = /^(?:basement|penthouse|\d+(?:st|nd|rd|th)\s+floor)$/i;
    function _emIsIntegrationStub(r) {
      if (r.bacnetLocation && _EM_INTEGRATION_STUB_PATH_RE.test(r.bacnetLocation)) return true;
      if (_EM_INTEGRATION_STUB_NAME_RE.test(r.equipName || '')) return true;
      if (_EM_INTEGRATION_STUB_SUFFIX_RE.test((r.equipName || '').trim())) return true;
      // Fourth layer: floor-scoped plant relay stubs
      if (
        _EM_FLOOR_STUB_EQUIP_RE.test((r.equipName || '').trim()) &&
        _EM_FLOOR_STUB_LOC_RE.test((r.location || '').trim())
      )
        return true;
      return false;
    }

    // Non-equipment exclusion filter (backlog b7625800).
    // These items appear in auditable equipment categories due to BAS naming conventions
    // but represent monitoring programs, utility systems, or sub-objects — NOT physical
    // HVAC equipment subject to ASHRAE 36 compliance.
    //
    // Patterns excluded:
    //   - "Weather" / "Environmental Index" (monitoring programs) — normally category 'other'
    //     but included here as belt-and-suspenders for future imports
    //   - "Generator Monitoring" (power systems)
    //   - "Fire Pump" items (fire suppression, not HVAC)
    //   - "Domestic Water Booster Pumps" (plumbing, not HVAC)
    //   - "Electric Meter*" (power monitoring programs)
    //   - Exterior lighting programs (soffit uplights etc.)
    //   - "Sewage Ejector Pump" (plumbing, not HVAC)
    //
    // NOTE: Return Duct / Supply Duct sub-patterns were removed from this regex.
    //   In JOCO data, duct rows share equipName with their parent AHU and differ only
    //   in location field — they are handled by Rule 1 same-name consolidation below.
    //   The old duct patterns matched against equipName and were inert (never fired).
    //
    // NOTE: UH-N / CUH-N names stored as 'hwp' are now RECLASSIFIED to 'heater' before
    //   this filter runs (see _emReclassifyRow below) rather than excluded, so that they
    //   appear under the Heater category in compliance output.
    var _NON_EQUIP_NAME_RE =
      /^Weather\s*$|Environmental Index|Generator Monitoring|^Fire Pump\b|Domestic Water Booster|\bElectric Meter\b|Exterior.*(?:Light|Uplight)|Soffit.*(?:Light|Uplight)|Sewage Ejector/i;
    function _emIsNonEquipment(r) {
      var name = (r.equipName || '').trim();
      if (_NON_EQUIP_NAME_RE.test(name)) return true;
      return false;
    }

    // CHANGE 1 — Unit-heater reclassification.
    // UH-N / CUH-N / GUH-N / TUH-N / IGH-N / TTH-N names are often stored under category
    // 'hwp' due to import misclassification (~82 rows project-wide in JOCO).
    // Reclassify them to 'heater' on a row copy BEFORE the auditable filter so they:
    //   a) pass through as auditable (heater is in AUDITABLE list),
    //   b) do NOT inflate hwp counts, and
    //   c) appear under "Heater" in the equipment summary and compliance table.
    // Uses \b word-boundary (not ^ start-anchor) to catch both "UH-1" and
    // "100 Vestibule | CUH-1" style names where the room name is the equipName prefix.
    var _UH_ABBREV_RE = /\b(?:uh|cuh|guh|tuh|igh|tth)[-\s]?[\da-z]/i;
    function _emReclassifyRow(r) {
      if (r.category === 'hwp' && _UH_ABBREV_RE.test((r.equipName || '').trim())) {
        return Object.assign({}, r, { category: 'heater' });
      }
      return r;
    }
    var reclassifiedRows = rows.map(_emReclassifyRow);

    var auditableRows = reclassifiedRows.filter(function (r) {
      return AUDITABLE.indexOf(r.category) !== -1 && !_emIsIntegrationStub(r) && !_emIsNonEquipment(r);
    });

    if (!auditableRows.length) return;

    // ── CHANGE 2: Rule 1 — Same-name consolidation ───────────────────────────
    // Group auditable rows by (equipName + category). When the same equipment
    // program has multiple rows (e.g. an AHU's "Supply Duct" and "Return Duct"
    // sub-programs share the AHU equipName with different location values), merge
    // them into one consolidated row so compliance is scored over the full point set.
    //
    // Canonical row selection: location==='' (main program) is preferred; if none,
    // the row with the most points is used. All other rows' points are unioned into
    // the canonical (canonical's values win on key collision). Returns copies — the
    // stored rows in localStorage are never mutated.
    (function () {
      var nameGroups = {};
      auditableRows.forEach(function (r) {
        var key = r.equipName + '\x00' + r.category;
        if (!nameGroups[key]) nameGroups[key] = [];
        nameGroups[key].push(r);
      });
      var consolidated = [];
      Object.keys(nameGroups).forEach(function (key) {
        var grp = nameGroups[key];
        if (grp.length === 1) {
          consolidated.push(grp[0]);
          return;
        }
        // Pick canonical: prefer location==='' (main), else highest point count
        var main = null;
        for (var gi = 0; gi < grp.length; gi++) {
          if ((grp[gi].location || '') === '') {
            main = grp[gi];
            break;
          }
        }
        if (!main) {
          main = grp.reduce(function (best, r) {
            return Object.keys(r.points || {}).length > Object.keys(best.points || {}).length ? r : best;
          }, grp[0]);
        }
        // Union points/pointsRaw; main row wins on collision
        var mergedPoints = {};
        var mergedPointsRaw = {};
        grp.forEach(function (r) {
          Object.assign(mergedPoints, r.points || {});
          Object.assign(mergedPointsRaw, r.pointsRaw || {});
        });
        Object.assign(mergedPoints, main.points || {});
        Object.assign(mergedPointsRaw, main.pointsRaw || {});
        consolidated.push(Object.assign({}, main, { points: mergedPoints, pointsRaw: mergedPointsRaw }));
      });
      auditableRows = consolidated;
    })();

    // ── CHANGE 3: Rule 2 — Plant folding (one plant per building per category) ──
    // For chwp and hwp categories: when a building has multiple rows that are all
    // components of the SAME physical plant (stacks, loop bypass valves, sequence
    // programs, pump VFDs), fold them into one canonical row so that:
    //   a) the plant appears as ONE auditable unit (not 5–10 inflated rows), and
    //   b) compliance is scored over the full combined point set.
    //
    // Canonical detection is tiered to avoid merging genuinely separate plants:
    //   Tier 1 (strongest): row whose equipName matches /Plant Manager|Plant Coordinator/i
    //     — the explicit primary controller program.
    //   Tier 2: row matching /\bWater System\b|\bBoiler System\b|\bSequence Logic\b/i
    //     — named system or sequence program, used when no T1 exists.
    //   If exactly one T1 row → it is canonical; all other same-category rows fold into it.
    //   If multiple T1 rows  → likely separate plants (e.g. Manager-North / Manager-South);
    //     leave separate.
    //   If zero T1, one T2  → T2 row is canonical; fold all others into it.
    //   If zero T1, zero/multiple T2 → ambiguous; leave all rows separate (conservative).
    //     This preserves "Hot Water Plant A" vs "Hot Water Plant B" at JDC as two distinct
    //     units even though neither has a named manager controller.
    (function () {
      var _T1_RE = /Plant Manager|Plant Coordinator/i;
      var _T2_RE = /\bWater System\b|\bBoiler System\b|\bSequence Logic\b/i;
      var plantCats = ['chwp', 'hwp'];
      var nonPlant = auditableRows.filter(function (r) {
        return plantCats.indexOf(r.category) === -1;
      });
      var result = nonPlant.slice();

      plantCats.forEach(function (cat) {
        // Group same-category rows by building (auditableRows are already within one bldg loop)
        var catRows = auditableRows.filter(function (r) {
          return r.category === cat;
        });
        if (catRows.length <= 1) {
          catRows.forEach(function (r) {
            result.push(r);
          });
          return;
        }

        var t1 = catRows.filter(function (r) {
          return _T1_RE.test(r.equipName || '');
        });
        var t2 = catRows.filter(function (r) {
          return _T2_RE.test(r.equipName || '');
        });
        var canonical = null;

        if (t1.length === 1) {
          canonical = t1[0];
        } else if (t1.length > 1) {
          // Multiple Tier-1 rows → separate plants; do not fold
          catRows.forEach(function (r) {
            result.push(r);
          });
          return;
        } else if (t2.length === 1) {
          canonical = t2[0];
        } else {
          // Zero or multiple Tier-2 → ambiguous; leave separate (conservative)
          catRows.forEach(function (r) {
            result.push(r);
          });
          return;
        }

        // Fold all rows into canonical (union points; canonical wins on collision)
        var mergedPoints = {};
        var mergedPointsRaw = {};
        catRows.forEach(function (r) {
          Object.assign(mergedPoints, r.points || {});
          Object.assign(mergedPointsRaw, r.pointsRaw || {});
        });
        Object.assign(mergedPoints, canonical.points || {});
        Object.assign(mergedPointsRaw, canonical.pointsRaw || {});
        result.push(Object.assign({}, canonical, { points: mergedPoints, pointsRaw: mergedPointsRaw }));
      });
      auditableRows = result;
    })();

    // Per-equipment compliance via emComputeCompliance
    var equipResults = [];
    var totalPointsRequired = 0;
    var totalPointsMatched = 0;
    var totalSeqRequired = 0;
    var totalSeqMatched = 0;
    var bldgGaps = {};

    // Phase 5 — setpoint value compliance counts (additive, do not affect existing scores)
    var spNeedsReviewCount = 0; // zone equipment with at least one DEVIATION not marked intentional
    var spNotScheduledCount = 0; // zone equipment with at least one NOT_SCHEDULED setpoint
    var spDeadbandIssueCount = 0; // zone equipment with a deadband DEVIATION

    var _reportMaps = typeof emLoadCustomMappings === 'function' ? emLoadCustomMappings(projId) : [];
    auditableRows.forEach(function (row) {
      if (typeof emComputeCompliance !== 'function') return;
      var flags = typeof emLoadEquipConfigFlags === 'function' ? emLoadEquipConfigFlags(projId, row.id) : {};
      var result = emComputeCompliance(row, flags, _reportMaps);

      // Accumulate physical point coverage totals. Exclude N/A points (space-type classifier,
      // v724) from the denominator -- an intentionally-absent point (no CO2 sensor in a closet,
      // no occupancy point in a detention cell) is not a coverage gap. Matches emComputeCompliance's
      // own coveragePct field (equipment-matrix.js ~19174: denominator = totalRequired - totalNA),
      // which this report-level aggregation had drifted from. 2026-07-30.
      totalPointsRequired += result.totalRequired - result.totalNA;
      totalPointsMatched += result.totalMatched;

      // Accumulate sequence readiness using emComputeSequenceReadiness (same approach
      // as emComputeAuditStats in equipment-matrix.js). Counts non-'na' sequences as
      // required and 'ready' sequences as matched. 'blocked'/'partial' count as gaps.
      var _equipSeqReadiness = {};
      if (typeof emComputeSequenceReadiness === 'function') {
        _equipSeqReadiness = emComputeSequenceReadiness(row, result);
        for (var seqKey in _equipSeqReadiness) {
          if (!_equipSeqReadiness.hasOwnProperty(seqKey)) continue;
          var seqEntry = _equipSeqReadiness[seqKey];
          if (seqEntry.status === 'na') continue;
          totalSeqRequired++;
          if (seqEntry.status === 'ready') {
            totalSeqMatched++;
          } else {
            // 'blocked' or 'partial' — accumulate as a gap for proposals/recommendations
            portfolioGapCounts[seqKey] = (portfolioGapCounts[seqKey] || 0) + 1;
            bldgGaps[seqKey] = (bldgGaps[seqKey] || 0) + 1;
            totalNotReadySequences++; // scope-of-work: sequences to program
          }
        }
      }

      // Accumulate hardware point gap counts for portfolio summary
      result.missingPoints.forEach(function (mp) {
        portfolioGapCounts[mp.categoryKey] = (portfolioGapCounts[mp.categoryKey] || 0) + 1;
        bldgGaps[mp.categoryKey] = (bldgGaps[mp.categoryKey] || 0) + 1;
      });
      totalMissingHardwarePoints += result.missingPoints.length; // scope-of-work: sensors to install

      // Phase 5 — setpoint value compliance (additive; does not affect existing scores).
      // Call emComputeSetpointCompliance with the same flags already loaded for this row,
      // plus spOverrides from emLoadSpOverrides (mirrors the Audit View call pattern).
      var _spResult = null;
      if (typeof emComputeSetpointCompliance === 'function') {
        var _spOvr = typeof emLoadSpOverrides === 'function' ? emLoadSpOverrides(projId, row.id) : {};
        _spResult = emComputeSetpointCompliance(row, flags, _spOvr);
        if (_spResult && _spResult.hasAnyData) {
          // Count equipment with at least one unacknowledged DEVIATION
          var _spHasUnackDeviation = _spResult.results.some(function (r) {
            return r.status === 'DEVIATION' && !r.intentionalFlag;
          });
          if (_spHasUnackDeviation) spNeedsReviewCount++;

          // Count equipment with a deadband DEVIATION
          var _spDbEntry = _spResult.results.find(function (r) {
            return r.checkKey === 'deadband' && r.status === 'DEVIATION';
          });
          if (_spDbEntry) spDeadbandIssueCount++;
        }
        if (_spResult && _spResult.hasAnyNotScheduled) spNotScheduledCount++;
      }

      equipResults.push({
        id: row.id,
        name: row.equipName || row.name || 'Unknown',
        category: row.category,
        categoryLabel: CAT_LABELS[row.category] || row.category,
        location: row.location || '',
        compliance: result,
        seqReadiness: _equipSeqReadiness,
        spCompliance: _spResult, // Phase 5 — setpoint value compliance result (null if N/A)
      });
    });

    // Calculate point and sequence coverage percentages (diagnostic sub-scores, still shown
    // as separate "Sensors"/"Sequences" gauges — these are unchanged by fix/audit-report-scoring).
    var pointPct = totalPointsRequired > 0 ? Math.round((totalPointsMatched / totalPointsRequired) * 100) : 0;
    // null means no applicable G36 sequences exist (e.g. FCU/heater-only building).
    // 0 means sequences exist but none are implemented — a real gap.
    var seqPct = totalSeqRequired > 0 ? Math.round((totalSeqMatched / totalSeqRequired) * 100) : null;

    // Requirement-weighted composite (fix/audit-report-scoring, 2026-07-14, Matt's decision).
    // Replaces the old flat building-level blend `pointPct*0.4 + seqPct*0.6`, which weighted
    // "sensor coverage" and "sequence readiness" by a fixed ratio regardless of how many actual
    // ASHRAE 36 requirements either dimension represented for this building.
    //
    // Prior art: AI/_context/research/ashrae36-audit-test.js, exportForCompanyHub() — its
    // overallScore is a weighted average across equipment types, weighted by applicableReqs
    // per type (weightedSum += pct * applicable; overallScore = weightedSum / weightedCount).
    // That script weights POINT requirements only (no sequence dimension existed there). This
    // codebase already tracks sequence readiness per equipment unit too (emComputeSequenceReadiness,
    // accumulated into totalSeqRequired/totalSeqMatched above), so "applicable requirements" here
    // is extended to mean point requirements + non-N/A sequence requirements — both are things
    // ASHRAE 36 actually asks of a piece of equipment. Matt's request ("weight by how much
    // ASHRAE 36 actually asks of each equipment type... an AHU with 20 applicable requirements
    // moves the score ~10x more than an exhaust fan with 2") is satisfied by either point-only or
    // point+sequence weighting; combining both dimensions here also removes the old fixed
    // 40/60 split, which was the second problem with the prior formula.
    //
    // Each equipment unit's applicable-requirement count is its natural weight. Because
    // totalPointsRequired/totalPointsMatched and totalSeqRequired/totalSeqMatched are already
    // summed across every equipment unit in this building (accumulated in the per-row loop
    // above), the requirement-weighted building score reduces to a single combined ratio:
    //   SUM over equipment of (unit met)        totalPointsMatched + totalSeqMatched
    //   ----------------------------------  =  ---------------------------------------
    //   SUM over equipment of (unit applicable)  totalPointsRequired + totalSeqRequired
    // Equipment with zero applicable requirements (e.g. a unit heater with no G36 checklist)
    // contributes 0/0 to these sums and so has NO effect on the ratio either way — it is never
    // divided on its own, so there is no div-by-zero and no silent drag on the score (the
    // universal-zero rule: 0 applicable requirements is valid data, not a missing-data case).
    var totalReqsApplicable = totalPointsRequired + totalSeqRequired;
    var totalReqsMet = totalPointsMatched + totalSeqMatched;
    var composite = totalReqsApplicable > 0 ? Math.round((totalReqsMet / totalReqsApplicable) * 100) : 0;

    // Status band — R2 (2026-08-03): all three now come from the one shared band rule
    // (a36ReadinessBand/Color/Word) instead of three copy-pasted ternaries. See V-01.
    var status = a36ReadinessBand(composite);
    var statusColor = a36ReadinessColor(composite);
    // Display-label rename (item ed465b3c, 2026-07-09; re-worded again fix/audit-report-scoring,
    // 2026-07-14, Matt's decision: ASHRAE 36 defines no composite score and no compliance
    // threshold, so "Compliant" wording next to genuine §5.x citations falsely implies the
    // standard blesses this bar. Matches _a36StatusChip's wording.
    // This field isn't rendered directly anywhere today (the chip helper independently
    // derives its word from `status`), kept in sync anyway so it can't drift if a future
    // caller starts reading it.
    var statusLabel = a36ReadinessWord(composite);
    // Sensor counts for status chip display
    var totalSensorsInPlace = totalPointsMatched;
    var totalSensorsRequired = totalPointsRequired;

    // Top gaps for this building.
    // co2, vav_dcv, and demandCtrl are excluded here because the dedicated DCV
    // readiness row (dcvRow) in recommendations and executive summary already
    // surfaces this as one actionable item — showing them separately causes
    // duplicate/confusing entries for the same physical intervention.
    var DCV_KEYS = ['co2', 'vav_dcv', 'demandCtrl'];
    var topGaps = Object.keys(bldgGaps)
      .filter(function (key) {
        return DCV_KEYS.indexOf(key) === -1;
      })
      .sort(function (a, b) {
        return bldgGaps[b] - bldgGaps[a];
      })
      .slice(0, 5)
      .map(function (key) {
        return {
          key: key,
          count: bldgGaps[key],
          desc: ASHRAE36_GAP_DESCRIPTIONS[key] || { short: key, impact: '', plain: '' },
        };
      });

    // Uncapped list of gap keys for this building -- used for portfolio membership queries.
    // topGaps is capped at 5 for per-building detail page display only.
    var allGapKeys = Object.keys(bldgGaps).filter(function (key) {
      return DCV_KEYS.indexOf(key) === -1;
    });

    // Equipment type inventory
    var equipCounts = {};
    auditableRows.forEach(function (r) {
      equipCounts[r.category] = (equipCounts[r.category] || 0) + 1;
    });

    buildingsData.push({
      // name  = RAW Equipment Matrix key. Every per-building row match in this file compares
      //         against it (`r.building !== b.name`). Never render this to a client.
      // displayName = the client-visible name (R5, 2026-08-03). See rptBuildingDisplayName.
      name: bName,
      displayName: rptBuildingDisplayName(bName),
      equipCount: auditableRows.length,
      equipCounts: equipCounts,
      equipResults: equipResults,
      pointPct: pointPct,
      seqPct: seqPct,
      composite: composite,
      status: status,
      statusColor: statusColor,
      statusLabel: statusLabel,
      totalSensorsInPlace: totalSensorsInPlace,
      totalSensorsRequired: totalSensorsRequired,
      // Sequence counts for status chip display (2026-08-02, matches sensor counts above —
      // totalSeqMatched/totalSeqRequired were already accumulated in the per-equipment loop
      // above for seqPct/composite; simply persisting them here so _a36StatusChip can show
      // "X/Y sequences" the same way it already shows "X/Y sensors". null when seqPct is null
      // (no applicable ASHRAE 36 sequences for this building) — see seqPct comment above.
      totalSeqMatched: totalSeqMatched,
      totalSeqRequired: totalSeqRequired,
      topGaps: topGaps,
      allGapKeys: allGapKeys,
      // Phase 5 — setpoint compliance counts (additive, do not affect score)
      spNeedsReviewCount: spNeedsReviewCount,
      spNotScheduledCount: spNotScheduledCount,
      spDeadbandIssueCount: spDeadbandIssueCount,
      // Plan §5: infrastructure metadata — presence of power-monitoring and OA-sensor
      // programs in the BAS export for this building (not a compliance score).
      hasPowerMonitoring: hasPowerMonitoring,
      hasOAConditions: hasOAConditions,
    });
  });

  if (!buildingsData.length) return { _noAuditableEquip: true };

  // D-14 / V-08 (R5, 2026-08-03): order the portfolio by the CLIENT-VISIBLE name, once, here —
  // so the readiness table, the per-building detail pages, the recommendations "affected
  // buildings" list and the Agreement's scope list can never disagree about where a building
  // belongs. Previously this array carried Object-key insertion order (i.e. Equipment Matrix row
  // order, which happens to be alphabetical by RAW name), which filed
  // "P25309 - Jo Co Arts and Heritage" under P between "Olathe Sheriff Training Facility" and
  // "Sheriffs Fleet Maintenance". Sorting is a presentation choice only; every downstream lookup
  // is by name, never by index.
  buildingsData.sort(function (a, b) {
    return rptBuildingNameSort(a.name, b.name);
  });

  // Portfolio-level top gaps (most common missing checks across all buildings).
  // co2, vav_dcv, and demandCtrl are excluded because the dedicated DCV readiness
  // callout and dcvRow already surface this as one actionable item.
  var PORTFOLIO_DCV_KEYS = ['co2', 'vav_dcv', 'demandCtrl'];
  var portfolioTopGaps = Object.keys(portfolioGapCounts)
    .filter(function (key) {
      return PORTFOLIO_DCV_KEYS.indexOf(key) === -1;
    })
    .sort(function (a, b) {
      return portfolioGapCounts[b] - portfolioGapCounts[a];
    })
    .slice(0, 8)
    .map(function (key) {
      return {
        key: key,
        count: portfolioGapCounts[key],
        buildingCount: buildingsData.filter(function (b) {
          return b.allGapKeys.indexOf(key) !== -1;
        }).length,
        desc: ASHRAE36_GAP_DESCRIPTIONS[key] || { short: key, impact: '', plain: '' },
      };
    });

  // Portfolio averages -- equipment-weighted (Matt's decision, backlog 9f21c94da4e717a5,
  // 2026-07-31). The service agreement is priced off equipment counts, not building counts, so
  // every portfolio gauge is weighted by each building's auditable equipCount instead of
  // averaging the 27 buildings flat (a 512-unit Courthouse and an 8-unit outbuilding no longer
  // count equally). Replaces the old `reduce(sum) / buildingsData.length` flat-average pattern
  // for all three gauges (composite, pointPct, seqPct) for consistency -- do not fix one and
  // leave the others flat.
  var _totalEquipForComposite = buildingsData.reduce(function (s, b) {
    return s + b.equipCount;
  }, 0);
  var portfolioComposite = _totalEquipForComposite
    ? Math.round(
        buildingsData.reduce(function (s, b) {
          return s + b.composite * b.equipCount;
        }, 0) / _totalEquipForComposite,
      )
    : 0;
  var portfolioPointPct = _totalEquipForComposite
    ? Math.round(
        buildingsData.reduce(function (s, b) {
          return s + b.pointPct * b.equipCount;
        }, 0) / _totalEquipForComposite,
      )
    : 0;
  // Exclude buildings with null seqPct (no applicable sequences) from the portfolio average --
  // weight by equipCount of only the qualifying (non-null) buildings.
  var _seqBuildings = buildingsData.filter(function (b) {
    return b.seqPct !== null;
  });
  var _totalEquipForSeq = _seqBuildings.reduce(function (s, b) {
    return s + b.equipCount;
  }, 0);
  var portfolioSeqPct = _totalEquipForSeq
    ? Math.round(
        _seqBuildings.reduce(function (s, b) {
          return s + b.seqPct * b.equipCount;
        }, 0) / _totalEquipForSeq,
      )
    : 0;
  var greenCount = buildingsData.filter(function (b) {
    return b.status === 'green';
  }).length;
  var amberCount = buildingsData.filter(function (b) {
    return b.status === 'amber';
  }).length;
  var redCount = buildingsData.filter(function (b) {
    return b.status === 'red';
  }).length;
  var portfolioStatus = a36ReadinessBand(portfolioComposite);

  // DCV readiness: count AHUs and VAV-type zones with/without a CO2 point.
  // Uses coveredPoints from real point data — no config flag dependency.
  var VAV_CATS = ['vav', 'fpb', 'ddvav'];
  var dcvTotalAHU = 0,
    dcvAHUWithCO2 = 0;
  var dcvTotalZones = 0,
    dcvZonesWithCO2 = 0;
  buildingsData.forEach(function (b) {
    b.equipResults.forEach(function (eq) {
      var hasCO2Point = eq.compliance.coveredPoints.some(function (cp) {
        return cp.categoryKey === 'co2';
      });
      if (eq.category === 'ahu') {
        dcvTotalAHU++;
        if (hasCO2Point) dcvAHUWithCO2++;
      } else if (VAV_CATS.indexOf(eq.category) !== -1) {
        dcvTotalZones++;
        if (hasCO2Point) dcvZonesWithCO2++;
      }
    });
  });

  // rawDate: ISO YYYY-MM-DD string for use in rptPage fakeData (period.reportDate).
  // rptPage() parses reportDate as ISO format; date is the human-readable display string.
  var rawDate =
    dateObj.getFullYear() +
    '-' +
    String(dateObj.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(dateObj.getDate()).padStart(2, '0');

  // ── Phase D-3: Point inventory totals ──────────────────────────────────────
  // Count ASHRAE-mapped and auto_ (other) BAS points across ALL rows — read-path
  // recompute via emGetNormalizedPoints (WeakMap-cached; free on second call).
  // These counts are INFORMATIONAL ONLY and do NOT affect compliance Coverage %.
  // The auto_ keys are structurally firewalled from emComputeCompliance by Guard A/B
  // (emNormalizePointInner early return + emComputeCompliance loop skip).
  var _invTotalASHRAE = 0;
  var _invTotalOther = 0;
  var _invByBuilding = {}; // buildingName → { ashrae: N, other: N }
  // 736eea4c: Point Inventory must reflect the SAME qualifying-building set the compliance
  // sections use — not an independent, unfiltered pass over matData.rows (which leaked weather
  // stubs like 'Johnson County' / 'New Century Complex' in as phantom buildings). buildingsData
  // is already fully built above (single source of truth: a building qualifies only if it had at
  // least one auditable row after self-heal + stub/non-equipment filtering).
  var _a36QualifyingBuildings = {};
  buildingsData.forEach(function (b) {
    _a36QualifyingBuildings[b.name] = true;
  });
  if (typeof emGetNormalizedPoints === 'function') {
    matData.rows.forEach(function (row) {
      var bName = row.building || 'Unknown Building';
      if (!_a36QualifyingBuildings[bName]) return; // same building set as compliance sections — no independent filter
      if (!_invByBuilding[bName]) _invByBuilding[bName] = { ashrae: 0, other: 0 };
      var normPts = emGetNormalizedPoints(row);
      var normKeys = Object.keys(normPts);
      for (var _ik = 0; _ik < normKeys.length; _ik++) {
        if (normKeys[_ik].indexOf('auto_') === 0) {
          _invTotalOther++;
          _invByBuilding[bName].other++;
        } else {
          _invTotalASHRAE++;
          _invByBuilding[bName].ashrae++;
        }
      }
    });
  }
  // R5 (2026-08-03): sort by the client-visible name, same rule as the readiness table above,
  // and carry displayName so the Point Inventory table can never print a raw source name.
  var _invBuildingRows = Object.keys(_invByBuilding)
    .sort(rptBuildingNameSort)
    .map(function (bName) {
      return {
        name: bName,
        displayName: rptBuildingDisplayName(bName),
        ashrae: _invByBuilding[bName].ashrae,
        other: _invByBuilding[bName].other,
      };
    });

  return {
    project: { name: projName, id: projId },
    date: dateStr,
    rawDate: rawDate,
    buildings: buildingsData,
    portfolio: {
      composite: portfolioComposite,
      pointPct: portfolioPointPct,
      seqPct: portfolioSeqPct,
      status: portfolioStatus,
      greenCount: greenCount,
      amberCount: amberCount,
      redCount: redCount,
      topGaps: portfolioTopGaps,
      totalBuildings: buildingsData.length,
      totalEquip: buildingsData.reduce(function (s, b) {
        return s + b.equipCount;
      }, 0),
      totalMissingHardwarePoints: totalMissingHardwarePoints,
      totalNotReadySequences: totalNotReadySequences,
      dcv: {
        totalAHU: dcvTotalAHU,
        ahuMissingCO2: dcvTotalAHU - dcvAHUWithCO2,
        totalZones: dcvTotalZones,
        zonesMissingCO2: dcvTotalZones - dcvZonesWithCO2,
      },
    },
    // Phase D-3: point inventory (informational; never affects compliance scoring)
    pointInventory: {
      totalASHRAE: _invTotalASHRAE,
      totalOther: _invTotalOther,
      totalAll: _invTotalASHRAE + _invTotalOther,
      byBuilding: _invBuildingRows,
    },
  };
}

// ─── Gauge ring SVG helper ─────────────────────────────────────────────────
/**
 * _a36GaugeSVG — one readiness ring.
 *
 * `color` MUST come from a36ReadinessColor(pct) (see that function). Never pass a brand color
 * here: a 2026-07-29 pass that did exactly that is what made the Audit cover contradict its own
 * readiness legend (V-01).
 *
 * ARC GEOMETRY (R2, 2026-08-03, VISUAL-REVIEW-2026-08-02.md V-12). Two corrections, both
 * measured on the 400 dpi cover crop of the live v2026.08.02.742 export:
 *
 *  1. stroke-linecap was `round`. A round cap projects half the stroke width past each end of
 *     the dash, so the printed fill ran fuller than the number it labels — measured Composite
 *     63.5% for a stated 60%, Sensor 65.7% for 62%, Sequence 55.8% for 52%, i.e. about 3.5
 *     points over in every case. The overhang is half the stroke width at the ring radius:
 *     at the cover's 110px size the stroke is 9.9px and the radius 41.8px, so each cap adds
 *     atan((9.9/2)/41.8) = 6.75 degrees, two caps = 13.5 degrees = 3.75 percentage points. The
 *     arcs themselves were always geometrically correct; only the caps lied. `butt` squares
 *     them off so the swept angle equals the stated percentage exactly.
 *  2. transform was `rotate(90 ...)`, which puts an SVG circle's dash origin (natively 3
 *     o'clock) at 6 o'clock, so every ring began at the bottom and swept left-and-up and read
 *     half-finished. `rotate(-90 ...)` puts the origin at 12 o'clock and the fill sweeps
 *     clockwise from the top, the convention every reader already knows.
 *
 * The percentage inside the ring prints in near-black, not in `color`: the standing rule is
 * black or near-black text, and this report already settled that convention for the same data
 * (see _a36StatusChip — "the word itself renders in var(--rpt-page-text), not `color`"). The
 * ring carries the band signal; the number is just a number.
 */
function _a36GaugeSVG(pct, color, label, size, suppressBottomLabel) {
  size = size || 90;
  var r = size * 0.38;
  var cx = size / 2;
  var cy = size / 2;
  var svgH = size * 1.16;
  var circumference = 2 * Math.PI * r;
  var filled = (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  var empty = circumference - filled;
  return (
    '<svg width="' +
    size +
    '" height="' +
    svgH.toFixed(1) +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    svgH.toFixed(1) +
    '" style="display:block">' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none" stroke="var(--rpt-rule)" stroke-width="' +
    size * 0.09 +
    '"/>' +
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none" stroke="' +
    color +
    '" stroke-width="' +
    size * 0.09 +
    '"' +
    ' stroke-dasharray="' +
    filled.toFixed(2) +
    ' ' +
    empty.toFixed(2) +
    '"' +
    ' stroke-linecap="butt" transform="rotate(-90 ' +
    cx +
    ' ' +
    cy +
    ')"/>' +
    '<text x="' +
    cx +
    '" y="' +
    (cy + size * 0.065) +
    '" text-anchor="middle" font-size="' +
    size * 0.22 +
    '" font-weight="700" fill="var(--rpt-page-text)" font-family="Arial,sans-serif">' +
    pct +
    '%</text>' +
    (suppressBottomLabel
      ? ''
      : '<text x="' +
        cx +
        '" y="' +
        (size * 1.08).toFixed(2) +
        '" text-anchor="middle" font-size="' +
        size * 0.115 +
        '" fill="var(--rpt-page-text)" font-family="Arial,sans-serif">' +
        label +
        '</text>') +
    '</svg>'
  );
}

// ─── Status chip helper ────────────────────────────────────────────────────
// status: 'green'|'amber'|'red'; inPlace/required: sensor counts (optional);
// seqMatched/seqRequired: sequence counts (optional, added 2026-08-02 per Matt's report
// "why does the Building Status column have the Sensors count but not the sequences?" —
// sensors that need installing and sequences that cannot run until they are both matter to
// a reader judging a building's readiness; showing only one was an incomplete picture).
// Renders "High Readiness · 3/3 sensors" style label when counts are provided.
function _a36StatusChip(status, inPlace, required, seqNA, seqMatched, seqRequired) {
  // `color` is computed for the caller's colored status bar (data-viz, kept — see the
  // `.rpt-a36-*` executive-summary/building rows that render `color` alongside this chip's
  // word). Batch 3 item 3c ("make chip WORD black") was already satisfied at this line —
  // the word itself renders in var(--rpt-page-text) (#000000), not `color`; confirmed via
  // before/after render, no visual change on this element. Left as-is, not re-touched.
  // R2 (2026-08-03): reads the shared band->color map rather than repeating the ternary.
  var color = ASHRAE36_READINESS_BAND_COLORS[status] || 'var(--rpt-page-text)';
  // Display-label rename (item ed465b3c, 2026-07-09, Matt's decision): Ready/Partial/Critical
  // -> Fully Covered/Partially Covered/Not Covered (2026-07-09 rename #2, Matt's decision,
  // supersedes v647): Covered -> Compliant. Re-worded again (fix/audit-report-scoring,
  // 2026-07-14, Matt's decision): "Compliant" implies ASHRAE 36 itself confers or defines a
  // pass/fail verdict, which it does not (no composite score, no compliance threshold is
  // published in the standard) -- this is CSC's own readiness assessment, so the word
  // "Compliant" must not appear next to genuine ASHRAE §5.x citations. New words chosen to
  // stay <= the old wording's length so the pixel-tuned column widths/row heights documented
  // below and around the Building ASHRAE 36 Readiness table do not regress:
  // "Fully Compliant" (15 chars) -> "High Readiness" (14), "Partially Compliant" (20) ->
  // "Partial Readiness" (17), "Not Compliant" (13) -> "Low Readiness" (13). DISPLAY TEXT
  // ONLY -- the 'green'/'amber'/'red' status keys and every caller's threshold logic
  // (now ASHRAE36_READINESS_HIGH_THRESHOLD/ASHRAE36_READINESS_PARTIAL_THRESHOLD) are untouched.
  var word = ASHRAE36_READINESS_BAND_WORDS[status] || ASHRAE36_READINESS_BAND_WORDS.red;
  // 2026-07-10 fix (audit-report-na-rationale, wording-decision.md item 1): when the caller
  // passes seqNA (true for a building whose seqPct is null -- zero equipment within Guideline
  // 36's sequence scope), `status`/`composite` are driven entirely by sensor coverage with no
  // sequence assessment behind them at all. "High Readiness" affirmatively (and falsely)
  // claims a verified sequence pass that never happened, so this word must not render for that
  // case. Neutral word only -- does not touch `status`, `color`, the composite score, or any
  // other caller's threshold logic for buildings that DO have applicable sequences.
  if (seqNA) word = 'No Scope Required';
  // Batch 3 item 2/3a: at 100% (inPlace === required, required > 0) the fraction is a
  // tautology ("High Readiness · 22/22 sensors" — 100% + a fraction that's obviously 1:1 tells
  // the reader nothing new, per Matt's flag) — drop it and show the word alone. Below 100%,
  // unchanged (e.g. "Partial Readiness · 178/261 sensors", "Low Readiness · 7/16 sensors").
  var isComplete = inPlace !== undefined && required !== undefined && required > 0 && inPlace === required;
  var sensorDetail =
    inPlace !== undefined && required !== undefined && !isComplete ? inPlace + '/' + required + ' sensors' : null;
  // Same tautology rule applied to sequences (2026-08-02): at seqMatched===seqRequired>0 the
  // fraction adds nothing, so drop it and let the word alone carry that case. When seqNA is
  // true this building has zero applicable ASHRAE 36 sequences (word is already
  // "No Scope Required" above) — never render a fabricated "0/0 sequences" for that case, per
  // Matt's rule against showing zero as if it were a measurement.
  var isSeqComplete =
    !seqNA && seqMatched !== undefined && seqRequired !== undefined && seqRequired > 0 && seqMatched === seqRequired;
  var seqDetail =
    !seqNA && seqMatched !== undefined && seqRequired !== undefined && seqRequired > 0 && !isSeqComplete
      ? seqMatched + '/' + seqRequired + ' sequences'
      : null;
  // Each present detail renders on its own line (rather than joined on one line with the
  // word) so neither the Status column width nor the "1 row = 1 line per fact" wrapping
  // invariant documented above is at risk of a longer combined string overflowing/wrapping
  // mid-word — see 2026-08-02 dashboardlogic entry for the DOM-measured column-width check.
  var detailLines = [sensorDetail, seqDetail].filter(function (x) {
    return x;
  });
  var label = detailLines.length > 0 ? word + '<br>' + detailLines.join('<br>') : word;
  return '<span style="font-size:10px;color:var(--rpt-page-text);line-height:1.35">' + label + '</span>';
}

/**
 * _a36SeqRequiredSensorLabels(seq) — client-facing "Requires: …" sub-line for the
 * ASHRAE Guideline 36 Sequences reference table (rptPageASHRAE36CostEstimate).
 *
 * Source of truth is seq.requiredCats (EM_SEQUENCE_DEFS, equipment-matrix.js) — the same
 * complete, authoritative point-category list this table's caller already uses to compute
 * per-equipment sequence readiness (emComputeSequenceReadiness). Deliberately NOT
 * app/pricing-estimator.js's SEQUENCE_BLOCKING_SENSORS, which is a narrower "does this block
 * the cost-tier discount" subset. If a sequence only defines requiredCatsByType (e.g.
 * vav_damper_writeback's ddvav-specific coldDampCmd/hotDampCmd), the union of those per-type
 * lists is used since this table is a general reference, not tied to one equipment instance.
 *
 * Category keys are resolved to plain-language labels via _pricingPointLabel
 * (pricing-estimator.js) first, falling back to the matching EM_POINT_CATEGORIES category's
 * `label` (equipment-matrix.js) for the few keys _pricingPointLabel doesn't cover (rfEnable,
 * rfSpeedCmd, co2) — never a raw unresolved point key rendered to a client report.
 *
 * Defensive by design: returns '' (never throws) if seq is falsy, has no required categories,
 * or EM_SEQUENCE_DEFS/EM_POINT_CATEGORIES/_pricingPointLabel aren't available. Call site
 * already guards on a falsy return (renders no "Requires:" sub-line).
 *
 * @param {object} seq - one entry from EM_SEQUENCE_DEFS
 * @returns {string} comma-separated plain-language sensor/point labels, or ''
 */
function _a36SeqRequiredSensorLabels(seq) {
  try {
    if (!seq) return '';
    var cats = Array.isArray(seq.requiredCats) ? seq.requiredCats.slice() : [];
    if (!cats.length && seq.requiredCatsByType && typeof seq.requiredCatsByType === 'object') {
      var seenCat = {};
      Object.keys(seq.requiredCatsByType).forEach(function (t) {
        (seq.requiredCatsByType[t] || []).forEach(function (c) {
          if (!seenCat[c]) {
            seenCat[c] = true;
            cats.push(c);
          }
        });
      });
    }
    if (!cats.length) return '';

    var labels = [];
    var seenLabel = {};
    cats.forEach(function (catKey) {
      var lbl = '';
      if (typeof _pricingPointLabel === 'function') {
        var pl = _pricingPointLabel(catKey);
        if (pl && pl !== catKey) lbl = pl;
      }
      if (!lbl && typeof EM_POINT_CATEGORIES !== 'undefined' && EM_POINT_CATEGORIES) {
        var equipKeys = Object.keys(EM_POINT_CATEGORIES);
        for (var i = 0; i < equipKeys.length && !lbl; i++) {
          var catArr = EM_POINT_CATEGORIES[equipKeys[i]] || [];
          for (var j = 0; j < catArr.length; j++) {
            if (catArr[j] && catArr[j].key === catKey && catArr[j].label) {
              lbl = catArr[j].label;
              break;
            }
          }
        }
      }
      if (!lbl) lbl = catKey; // last-resort fallback — should not normally happen
      if (!seenLabel[lbl]) {
        seenLabel[lbl] = true;
        labels.push(lbl);
      }
    });
    return labels.join(', ');
  } catch (e) {
    return '';
  }
}

// ─── rptPageASHRAE36Cover ─────────────────────────────────────────────────
/**
 * Cover page: three gauge rings (overall/sensor/sequence), one-paragraph finding.
 * Hero page — no interior header, uses CSC letterhead.
 */
function rptPageASHRAE36Cover(n, d, perBuildingIncluded) {
  var p = d.portfolio;
  // Consolidated sensor/sequence counts (2026-07-29 fix) — the cover previously printed
  // p.totalMissingHardwarePoints / p.totalNotReadySequences, RAW per-equipment-unit accumulators
  // from collectASHRAE36Data (see ~line 12157/12451/12461) that count every equipment row's gaps
  // independently. The priced scope (buildCatalogRows, app/pricing-estimator.js) applies three
  // exclusions the raw counters never see: (1) monitoring-only zone units — equipment rows missing
  // BOTH coolSP and htgSP are dropped entirely by _pricingIsMonitoringOnlyZoneUnit before any row
  // is generated, for every category, not just those two; (2) ioOnly points, which wire to
  // existing controller I/O — $0 parts, 0 install hours, not new hardware; (3) building-level
  // dedup (oat / oaWetBulb / damper-position / zoneTemp+co2 combos) that collapses many
  // per-equipment gaps into one physical device. Measured 2026-07-29 on real JOCO data: raw
  // sensors 4,049 vs. consolidated 1,311 (a 67.6% overcount); raw sequences 1,764 vs. consolidated
  // 1,313 (a 25.6% overcount). Matt: "we will look stupid if we tell them they need a bunch of
  // things and then we get started and realize they don't need any of it." The cover is the
  // client-facing, highest-stakes number in the deliverable — it must always match the priced
  // scope, so it is derived here from buildCatalogRows, never hardcoded, so it tracks the priced
  // scope automatically as pricing rules evolve. Sensors = sum of qty where phase===1 && !ioOnly
  // (phase 1 = hardware rows; ioOnly rows are $0/no-install and are not "sensors to install").
  // Sequences = sum of qty where phase===2 (phase 2 = sequence-programming rows). Defensive
  // fallback to the raw portfolio totals if buildCatalogRows is unavailable for any reason (should
  // never happen on energy-department.html, which always loads pricing-estimator.js alongside
  // report-engine.js, but avoids a hard crash if this function is ever reused in a context that
  // doesn't).
  var _a36ConsolidatedSensors = p.totalMissingHardwarePoints;
  var _a36ConsolidatedSequences = p.totalNotReadySequences;
  if (typeof buildCatalogRows === 'function') {
    var _a36CatalogRows = buildCatalogRows(d.project.id) || [];
    var _a36SensorSum = 0;
    var _a36SeqSum = 0;
    _a36CatalogRows.forEach(function (r) {
      if (r.phase === 1 && !r.ioOnly) _a36SensorSum += r.qty || 0;
      // fix/per-building-sensor-reconcile (2026-07-29): require r.seqKey — buildCatalogRows
      // concatenates buildSensorInvestigationRows()' phase-2 labor rows (suspect/failed sensor
      // readings, fix/pricing-phases-and-sensor-hours) onto the SAME array. Those rows carry no
      // seqKey (they are not a G36 sequence) and that function's own header comment is explicit:
      // "must not reach the audit report... sensor failures are a service-scope/pricing matter,
      // not an ASHRAE 36 compliance finding." A plain `r.phase === 2` sum missed that distinction
      // and let 19 investigation rows (qty 19) inflate this cover figure by counting them as
      // "sequences to program" — measured 2026-07-29 on real JOCO data: 1,304 vs. 1,285 once
      // excluded. r.seqKey is only ever set on the actual G36 sequence-programming rows.
      else if (r.phase === 2 && r.seqKey) _a36SeqSum += r.qty || 0;
    });
    if (_a36CatalogRows.length) {
      _a36ConsolidatedSensors = _a36SensorSum;
      _a36ConsolidatedSequences = _a36SeqSum;
    }
  }
  // Cover gauge color — R2 (2026-08-03), VISUAL-REVIEW-2026-08-02.md V-01. REPLACES the
  // 2026-07-29 brand-color pass ("make the Composite Score gauge be the CSC blue and then have
  // the Sensor Coverage and Sequence Readiness be the CSC green"), which is exactly what made
  // this cover contradict the readiness legend printed two pages later: it painted 62% and 52%
  // in #27ae60 — the green those pages define as "High Readiness, 75% and above" — and painted
  // the Composite Score in a blue that appears in no legend in the document. All three rings now
  // read their color from a36ReadinessColor(), the same single rule that colors all 27 Score
  // bars in the Building ASHRAE 36 Readiness table, so a number can never be one band on the
  // cover and a different band in the table. Nothing about the numbers themselves changed.
  //
  // The Composite Score deliberately uses that same rule rather than a distinct treatment: it is
  // the score the readiness bands are literally defined over (portfolioStatus is already derived
  // from it with these thresholds), so any other color would be a fourth unexplained one — the
  // review's specific complaint. A legend printed directly under the rings (bandLegend below)
  // spells the bands out so the cover decodes itself without turning the page.
  // One-paragraph finding — REORDERED 2026-07-29 (Matt's direct instruction: "always make reports
  // a story instead of just text... Buildings Assessed, HVAC Systems Audited, Sequences to
  // Program and then Sensors to Install in that order so it tells the story of what happened in
  // the Audit"). Same figures, same <strong> emphasis, only the narrative order changed to match
  // the stat strip below (buildings walked into -> equipment examined -> sequences found to
  // program -> sensors found to install).
  // D-22 (R5, 2026-08-03): every count in this sentence goes through rptCount, the one shared
  // thousands-separator formatter, so the Audit narrative and the Proposal's Executive Summary
  // print the same figure the same way ("1,594", never "1594").
  var finding =
    'To meet ASHRAE 36, across <strong>' +
    rptCount(p.totalBuildings) +
    ' building' +
    (p.totalBuildings !== 1 ? 's' : '') +
    '</strong> and <strong>' +
    rptCount(p.totalEquip) +
    ' piece' +
    (p.totalEquip !== 1 ? 's' : '') +
    ' of heating and cooling equipment</strong>, <strong>' +
    d.project.name +
    '</strong> needs <strong>' +
    rptCount(_a36ConsolidatedSequences) +
    ' control sequence' +
    (_a36ConsolidatedSequences !== 1 ? 's' : '') +
    ' programmed</strong> and <strong>' +
    rptCount(_a36ConsolidatedSensors) +
    (_a36ConsolidatedSensors === 1 ? ' sensor or actuator' : ' sensors and actuators') +
    ' installed</strong>. ' +
    // a562fd67: the cover's forward-looking promise must match whether the report actually
    // includes per-building detail pages. perBuildingIncluded is passed true only when the
    // Audit Report's "Per-Building Detail" section is on (s.building !== false at the call
    // site). Defensive: only the strict-true branch promises "building by building"; any caller
    // that omits the flag (e.g. the Proposal, which has no per-building breakdown at all) gets
    // the portfolio-level aggregate sentence and never a false building-by-building promise.
    (perBuildingIncluded === true
      ? 'The sections that follow break this work down building by building and provide a prioritized list of recommended upgrades, each with its typical energy savings.'
      : 'The sections that follow provide a prioritized list of recommended upgrades across the facilities in scope, each with its typical energy savings.');

  var gauges =
    '<div style="display:flex;justify-content:center;gap:36px;margin:24px 0 8px">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.composite, a36ReadinessColor(p.composite), 'Overall', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Composite Score</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.pointPct, a36ReadinessColor(p.pointPct), 'Sensors', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sensor Coverage</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.seqPct, a36ReadinessColor(p.seqPct), 'Sequences', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sequence Readiness</div></div>' +
    '</div>';

  // Cover readiness legend (R2, 2026-08-03, V-01). One centered line of ordinary text directly
  // under the rings so a reader can decode a ring color without turning to page 2 — deliberately
  // NOT a box, card, tile or bordered key (standing rule), and no separator rule above or below
  // it (standing rule); it is simply the next line of copy on the page. Each band's mark is a
  // colored square glyph in a text run rather than a styled <div>, so it survives every export
  // path identically: the print/PDF path, the Word .docx path (which turns a colored <span> into
  // a colored run but silently drops an empty background-colored <div>), and the mso-HTML path.
  // The band words stay near-black — the report's settled convention is that color lives in the
  // graphic and words are black (see _a36StatusChip). Thresholds are interpolated from
  // ASHRAE36_READINESS_HIGH/PARTIAL_THRESHOLD, the same constants the table footnote uses, so the
  // cover legend and the table legend can never drift apart; ranges are written in words rather
  // than mathematical symbols per the no-jargon rule.
  var _bandGap = '<span style="color:var(--rpt-page-text)">&nbsp; &nbsp; &nbsp;</span>';
  var bandLegend =
    '<div style="text-align:center;font-size:' +
    RPT_MIN_TEXT_PX +
    'px;line-height:1.5;color:var(--rpt-page-text);margin:0 0 16px">' +
    'Ring color shows readiness: ' +
    '<span style="color:' +
    ASHRAE36_READINESS_BAND_COLORS.green +
    '">■</span> High, ' +
    ASHRAE36_READINESS_HIGH_THRESHOLD +
    '% and above' +
    _bandGap +
    '<span style="color:' +
    ASHRAE36_READINESS_BAND_COLORS.amber +
    '">■</span> Partial, ' +
    ASHRAE36_READINESS_PARTIAL_THRESHOLD +
    ' to ' +
    (ASHRAE36_READINESS_HIGH_THRESHOLD - 1) +
    '%' +
    _bandGap +
    '<span style="color:' +
    ASHRAE36_READINESS_BAND_COLORS.red +
    '">■</span> Low, below ' +
    ASHRAE36_READINESS_PARTIAL_THRESHOLD +
    '%' +
    '</div>';

  var bodyHTML =
    '<div style="padding:20px 48px 16px">' +
    '<div style="text-align:center;margin-bottom:0">' +
    // D-12 (2026-08-03): 22px (16.5pt) -> the shared 18pt document-title tier, so the Audit cover
    // title and the Proposal cover title are the same size and both sit above the 14.25pt running
    // page-title bar that follows them on every interior page. margin-bottom stays 2px (not D-12's
    // original 12px) because R9a (2026-08-03) inserted a document-date div right after this one,
    // and that date div supplies its own margin-bottom:12px gap before the body text below it.
    '<div style="font-size:' +
    RPT_DOC_TITLE_PX +
    'px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">ASHRAE 36 Audit Report</div>' +
    '<div style="font-size:15px;color:var(--rpt-page-text);margin-bottom:2px">' +
    d.project.name +
    '</div>' +
    // 2026-08-03 (visual review V-02): the Audit carried NO date anywhere in its text layer —
    // the date existed only in the export filename, so a filed copy could not be dated, cited or
    // superseded. _rptDocumentDateLong() reads the same instant/calendar day that filename is
    // built from, so page and filename can never disagree.
    '<div style="font-size:14px;color:var(--rpt-page-text);margin-bottom:12px">' +
    _rptDocumentDateLong() +
    '</div>' +
    '</div>' +
    '<div style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:8px">' +
    'This report evaluates the facility’s building automation system against ASHRAE 36, the industry standard for high-performance heating and cooling control. ' +
    'It identifies the specific sensors to install and control sequences to program to bring the facility into full alignment with ASHRAE 36. ' +
    'Use it to scope and prioritize the recommended upgrades.' +
    '</div>' +
    gauges +
    bandLegend +
    '<div class="rpt-a36-callout" style="font-size:14px;line-height:1.6;color:var(--rpt-page-text)">' +
    finding +
    '</div>' +
    // 2026-07-29 (Matt's direct instruction): reordered to tell the story of the audit — Buildings
    // Assessed, HVAC Systems Audited, Sequences to Program, Sensors to Install (what we walked
    // into -> what we examined -> what we found to program -> what needs installing). Same figures
    // as before, order only. Separator lines between cards REMOVED — see the .rpt-a36-stat-card
    // CSS rule (energy-department.html) for the matching border-right removal; Matt: "The lines
    // separating the [stats]... should never be done like that in a report, it does not look very
    // human... use no lines at all." Values/labels unchanged, presentation/order only.
    '<div style="display:flex;gap:16px;margin-top:12px">' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    rptCount(p.totalBuildings) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Buildings Assessed</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    rptCount(p.totalEquip) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Heating and Cooling Systems Audited</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    rptCount(_a36ConsolidatedSequences) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Sequences to Program</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    rptCount(_a36ConsolidatedSensors) +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Sensors to Install</div>' +
    '</div>' +
    '</div>' +
    // 2026-08-03 (visual review V-03): the cover's only attribution was the letterhead graphic —
    // no author, no addressee. Plain text lines, no box/card/tile and no separator rule (standing
    // rule); the two labels are simply bolded. No phone/address is printed: no verified Control
    // Service Company contact block exists anywhere in this codebase and inventing one is worse
    // than omitting it.
    '<div style="font-size:14px;color:var(--rpt-page-text);line-height:1.5;margin-top:14px">' +
    '<div><strong>Prepared for:</strong> ' +
    d.project.name +
    '</div>' +
    '<div><strong>Prepared by:</strong> Control Service Company</div>' +
    '</div>' +
    '</div>';

  // Use rptPage with a data-like object for footer formatting
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  return rptPage(n, 'ASHRAE 36 Audit Report — Cover', bodyHTML, {
    hero: true,
    data: fakeData,
    label: 'Page ' + n + ' — ASHRAE 36 Cover',
  });
}

// ─── rptPageASHRAE36Executive ─────────────────────────────────────────────
/**
 * Executive summary: portfolio stats, building status table, key finding callout.
 */
function rptPageASHRAE36Executive(n, d) {
  // PIXEL-HEIGHT PAGINATION (2026-06-16 fix for item 346e8add):
  // Uses _rptPaginateTokens (same shared paginator as rptPageASHRAE36Building) to split
  // buildings across pages based on actual pixel-height estimates instead of flat counts.
  //
  // Fix B (2026-06-18, items 9f80ea0f/346e8add): dynamic first-page chrome budget.
  // Old hardcoded ROWS_BUDGET_FIRST = 681 underestimated callout heights; JOCO has both
  // callouts simultaneously, causing 24 rows to pack into a space only safe for 21.
  //
  // Actual measured chrome heights:
  //   dcvCallout  ~94px  (3 divs at 11px font, margin-bottom:14px)
  //   topGap callout ~65px (3 divs at 11px font, margin-bottom:14px)
  //   tableTitle  ~28px  (13px font + 6px margin-bottom)
  //   thead       ~32px  (10px font, padding 6+6)
  //   tableFootnote ~35px (10px, 2 lines)
  //   safety margin 30px (rounding, multi-line building names, etc.)
  //
  // ROWS_BUDGET_CONT corrected: contHdr ~35px + tableTitle ~28px + thead ~32px + footnote ~35px
  //   = 130px consumed → row budget = 894 - 130 - 20 = 744px (was 811, omitted tableTitle)
  //
  // Each building row estH raised to 34px to account for 2-line building names (e.g. JOCO).
  // ROWS_BUDGET_FIRST and ROWS_BUDGET_CONT are computed after callout strings are built (below).

  var p = d.portfolio;
  // Rule 2.3: reportDate drives footer date; label empty.
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // Top ASHRAE 36 Sequences by portfolio scope (first page only).
  // 2026-08-03 (Matt's complaint): this callout used to show only the single #1 GAP
  // (p.topGaps[0], a missing-sensor/point-category count) under the heading "Most Common Gap
  // Across Portfolio" -- one item, and a different axis than "sequences" (a gap is a missing
  // point/sensor; a sequence is the control routine it blocks). Matt: "there are still only 2
  // sequences mentioned before the building ASHRAE 36 Readiness table, I thought we were going
  // to expand that section?" (the "2" being this callout's one gap plus the DCV callout below).
  // Replaced with a real summary of the top SEQUENCE TYPES by portfolio quantity, computed the
  // SAME way (buildCatalogRows phase-2/seqKey rows, grouped by seqKey) as the "Control Sequences"
  // table later in this report (rptPageASHRAE36CostEstimate, ~line 15025) so the two numbers can
  // never disagree -- same cache key (d._a36CatalogRowsCache), same filter. Summarized by TYPE
  // across the whole portfolio -- never one line per building. No invented names or counts: any
  // sequence type with zero priced-programming quantity in the real data is simply not listed.
  var callout = '';
  try {
    if (!d._a36CatalogRowsCache) {
      d._a36CatalogRowsCache = typeof buildCatalogRows === 'function' ? buildCatalogRows(d.project.id) || [] : [];
    }
    var _execSeqCounts = {}; // seqKey -> equipment units still needing this sequence programmed
    (d._a36CatalogRowsCache || []).forEach(function (r) {
      if (!r || r.phase !== 2 || !r.seqKey) return;
      _execSeqCounts[r.seqKey] = (_execSeqCounts[r.seqKey] || 0) + (r.qty || 0);
    });
    var _execSeqDefs =
      typeof EM_SEQUENCE_DEFS !== 'undefined' && Array.isArray(EM_SEQUENCE_DEFS) ? EM_SEQUENCE_DEFS : [];
    var EXEC_TOP_SEQ_COUNT = 6; // top N sequence types by portfolio quantity
    var topSeqTypes = _execSeqDefs
      .map(function (seq) {
        // Client-facing label MUST match the later "Control Sequences" table exactly (both read
        // from the same EM_SEQUENCE_DEFS entry) -- _a36SeqDisplayLabel applies A36_SEQ_LABEL_OVERRIDE
        // (e.g. vav_damper_writeback -> "Damper Position Command", not the internal-jargon
        // "Damper Position Write-back") so one concept carries one name across the whole report.
        return { key: seq.key, label: _a36SeqDisplayLabel(seq), qty: _execSeqCounts[seq.key] || 0 };
      })
      .filter(function (s) {
        return s.qty > 0;
      })
      .sort(function (a, b) {
        return b.qty - a.qty;
      })
      .slice(0, EXEC_TOP_SEQ_COUNT);

    if (topSeqTypes.length) {
      var _seqRowsHTML = topSeqTypes
        .map(function (s) {
          return (
            '<tr>' +
            '<td style="padding:5px 8px;font-size:' +
            RPT_BODY_PX +
            'px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
            _esc(s.label) +
            '</td>' +
            '<td style="padding:5px 8px;font-size:' +
            RPT_BODY_PX +
            'px;font-weight:700;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:center">' +
            rptCount(s.qty) +
            '</td>' +
            '</tr>'
          );
        })
        .join('');
      callout =
        '<div class="rpt-a36-callout" style="margin-bottom:14px">' +
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px">Top ASHRAE 36 Sequences by Portfolio Scope</div>' +
        '<div style="font-size:' +
        RPT_BODY_PX +
        'px;color:var(--rpt-page-text);margin-bottom:6px">' +
        'The control sequences most needed across the portfolio, and how many pieces of equipment still need each one programmed.' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr>' +
        '<th style="padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)">Sequence</th>' +
        '<th style="padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--rpt-page-text);text-align:center;border:1px solid var(--rpt-border)">Number to Program</th>' +
        '</tr></thead><tbody>' +
        _seqRowsHTML +
        '</tbody></table>' +
        '</div>';
    }
  } catch (e) {
    console.error('rptPageASHRAE36Executive: top-sequences summary build failed', e);
    callout = '';
  }

  // DCV readiness callout (first page only)
  var dcvCallout = '';
  var dcv = p.dcv || {};
  var _dcvAhuMissing = dcv.ahuMissingCO2 || 0;
  var _dcvZonesMissing = dcv.zonesMissingCO2 || 0;
  if (_dcvAhuMissing > 0 || _dcvZonesMissing > 0) {
    var dcvParts = [];
    if (_dcvAhuMissing > 0) {
      dcvParts.push(_dcvAhuMissing + ' of ' + dcv.totalAHU + ' air handler' + (dcv.totalAHU > 1 ? 's' : ''));
    }
    if (_dcvZonesMissing > 0) {
      dcvParts.push(_dcvZonesMissing + ' of ' + dcv.totalZones + ' zone' + (dcv.totalZones > 1 ? 's' : ''));
    }
    var dcvSentence = dcvParts.join(' and ') + ' have no carbon dioxide sensor.';
    dcvCallout =
      '<div class="rpt-a36-callout" style="margin-bottom:14px">' +
      // D-12 (2026-08-03): heading -> 13pt section tier, its paragraph -> 10.5pt body tier.
      '<div style="font-size:' +
      RPT_SECTION_HEAD_PX +
      'px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px">Occupancy-Based Ventilation Readiness</div>' +
      '<div style="font-size:' +
      RPT_BODY_PX +
      'px;color:var(--rpt-page-text);line-height:1.6">' +
      dcvSentence +
      ' Without a way to sense carbon dioxide levels, these units ventilate at full design rates even when spaces are empty, wasting fan and cooling energy. ' +
      'Adding carbon dioxide sensors lets ventilation adjust to how many people are actually in the space, so equipment stops conditioning air for rooms that are empty.' +
      '</div>' +
      '</div>';
  }

  // Fix B: compute dynamic row budgets now that callout presence is known.
  // Heights below are DOM-measured (2026-06-18 headless run against JOCO):
  //   dcvCallout actual=86px, topGap callout actual=68px, thead actual=42px (spec had 32 — wrong),
  //   tableTitle actual=20px, footnote actual=15px (single line in headless).
  //   Row average actual=38px; estH set to 40px for safety margin on wrapping names.
  //
  // Batch 3 item 3b re-verification (2026-07, per plan invariant "any row-height change
  // re-verifies the budget"): the footnote grew from a single line (~15px) to 3 lines (~45px
  // DOM-measured) once the plain-language tier sentences were appended. The old 20px budget
  // under-counted this by ~25-30px, causing a checkOverflow() hit (scrollH 1086 vs clientH
  // 1056) on the first Executive Summary page. Re-measured and bumped below; re-verified via
  // headless render afterward that checkOverflow() returns 0 and the page count is unchanged.
  // U2 / RC-A (2026-08-02, D-04 + D-05): ALL of the constants below were re-measured in a headless
  // PRINT-media render of the real JOCO Audit (27 buildings) AFTER _rptApplyMinFontFloor raised
  // every sub-10pt string to the 13.34px floor. Every one of them had grown, because they are all
  // multi-line text blocks whose line count is set by the font size: the readiness footnote went
  // 45px -> 100px (the tier sentences now wrap far more), the occupancy-ventilation callout
  // 86px -> 121px, the top-gap callout 68px -> 78px, the table head 42px -> 46px. Budgeting the
  // old numbers against the new type scale is precisely what pushed the readiness footnote 24.8pt
  // into the footer wave band on Audit p2. Each constant below is now the MEASURED height, and the
  // whole page carries ONE named safety margin (EXEC_SAFETY_H) instead of a private overcount
  // baked into each line — per-item padding silently compounded to ~25px here, which was enough to
  // drop a whole building row onto a fourth page and leave a one-row orphan.
  // Re-measure protocol if any of this content changes: headless render, emulateMedia('print'),
  // read getBoundingClientRect().height of each .rpt-body child on the Executive Summary pages.
  var EXEC_THEAD_H = 46; // measured
  var EXEC_FOOTNOTE_H = 100; // measured (readiness-band methodology footnote, wraps to ~5 lines at 10pt)
  var EXEC_SAFETY_H = 40; // single page-level margin. 40, not 20: at 20 this page measured only 13px
  // of clearance below the reserved footer zone, and page count is explicitly not a constraint.
  // D-12 (2026-08-03): all three re-measured after the section headings moved to the 13pt tier,
  // per the re-measure protocol above (headless render, emulateMedia('print'),
  // getBoundingClientRect().height of each .rpt-body child). Each number is now the measured box
  // height PLUS that block's own declared margin-bottom, which the old figures omitted — the
  // paginator is budgeting the space a block actually occupies, not just the space it paints.
  //   occupancy-ventilation callout 121 -> 146 (132 measured + its 14px margin)
  //   most-common-gap callout        78 -> 121 (107 measured + its 14px margin; this block grew
  //                                             most because its two content lines also moved up
  //                                             to the 10.5pt body tier)
  //   tableTitle                     20 ->  32 (26 measured + its 6px margin)
  var _firstChromeH = 0;
  if (dcvCallout) _firstChromeH += 146; // measured (occupancy-based ventilation readiness callout)
  // 2026-08-03: `callout` was a 3-line "most-common-gap" paragraph (121px measured); it is now a
  // heading + intro sentence + a small Sequence/Number-to-Program table (up to 6 rows), which is
  // materially taller. Re-measured per the re-measure protocol above (headless render against
  // real JOCO data, emulateMedia('print'), getBoundingClientRect().height of the .rpt-a36-callout
  // box): 314.03px content + its 14px margin-bottom = 328.03px, rounded up to 329 for safety.
  if (callout) _firstChromeH += 329; // measured (top-sequences-by-portfolio-scope table, up to 6 rows)
  _firstChromeH += 32; // tableTitle — measured
  _firstChromeH += EXEC_THEAD_H;
  _firstChromeH += EXEC_FOOTNOTE_H;
  // d5929df4 (2026-07-13): FIRST base trimmed 894 -> 862. Restoring CSC_FOOTER_B64 to the
  // full 1699x224 crop (app/csv-import.js, this same commit — the 2026-07-10 regression had
  // cropped it to 1699x85, silently deleting the green band) made the rendered footer image
  // ~107.6px tall at 816px page width (DOM-measured: .rpt-footer top = 948.4px on a 1056px
  // page, vs ~1015px top when the image was the broken 85px-tall crop). DOM-measured
  // collision on live JOCO data (26 buildings) at the old base=894: page 2 of the Executive
  // Summary rendered 13 rows whose content bottom (958.3px) sat 9.9px INTO the new footer's
  // top edge (948.4px) — the last line of the table footnote was drawn on top of the wave
  // graphic. A first attempt cut both FIRST and CONT bases by the full ~68px footer-height
  // delta (894->826, 717->649), which over-corrected: it also shaved a row off the
  // continuation page (which had ~425px of unused clearance and needed none of this), pushing
  // Executive Summary from 2 pages to 3 and the whole Audit Report from 26 to 27 pages — the
  // exact regression this task was told to avoid. Reverted CONT to its original 717 (verified
  // via headless scan: continuation pages have 80-425px of spare clearance even before any
  // trim) and shaved FIRST by only ~32px — just enough to drop the one row that was
  // overflowing onto the already-existing continuation page. Re-verified via headless DOM
  // scan of all 26 audit pages + 3 proposal pages: zero pages with negative clearance, page
  // counts unchanged (26 audit / 3 proposal).
  // fix/report-content-pagination (2026-07-28): bases now derive from _rptContentBudget()
  // (shared page-geometry source of truth) instead of standalone literals 862/717. The named
  // adjustment constants below preserve the EXACT numeric budgets this DOM-measured history
  // arrived at (904 - 42 = 862, 904 - 187 = 717) -- no visual/page-count change, just naming the
  // gap between the shared geometry base and this page's own additional historical safety
  // margin instead of leaving it as an unexplained standalone number.
  // U2 (2026-08-02): EXEC_FIRST_BASE_ADJUSTMENT (42) and EXEC_CONT_BASE_ADJUSTMENT (187) are gone.
  // They existed only to reproduce two historical literals (862/717) that were themselves the
  // residue of the 2026-07-13 emergency trim described above — an unexplained fudge on top of an
  // unexplained fudge. Both pages now subtract their OWN measured chrome from the shared content
  // budget, so the arithmetic states the actual page and can be re-derived by anyone who measures
  // it again. The continuation page's chrome is its own small "(continued, N of M)" heading plus
  // the same table head and footnote the first page carries.
  // V-06 (2026-08-03) unified the continuation caption with the first-page caption -- same
  // _readinessCaption() style/markup for every chunk, no separate bordered bar (see rationale on
  // READINESS_CAPTION_STYLE below). D-12 (2026-08-03) then raised that one shared caption style
  // 11px -> the 13pt section tier (RPT_SECTION_HEAD_PX) and re-measured it at 32 (26px text + 6px
  // margin) where it is used on the first page (see "_firstChromeH += 32; // tableTitle --
  // measured" above). Because the continuation caption renders through that exact same
  // _readinessCaption() call/style, it uses that same 32 here -- the old "~9px shorter than the
  // bar" conservatism no longer applies now that the bar it was compared against (D-12's own
  // pre-unification bordered bar, replaced by V-06) is gone. Flag for a headless re-verify pass:
  // this number assumes "(continued, N of M)" stays on one line at the 13pt tier like "(N of M)"
  // does; re-measure if the JOCO portfolio (most chunks) ever shows it wrapping.
  var EXEC_CONT_HEADER_H = 32; // measured — Building ASHRAE 36 Readiness caption at 13pt tier
  var _contChromeH = EXEC_CONT_HEADER_H + EXEC_THEAD_H + EXEC_FOOTNOTE_H;
  var ROWS_BUDGET_FIRST = _rptContentBudget('standard') - _firstChromeH - EXEC_SAFETY_H;
  var ROWS_BUDGET_CONT = _rptContentBudget('standard') - _contChromeH - EXEC_SAFETY_H;

  // Shared table styles
  // fix/report-formatting-consistency (2026-07-27): font-size was 13px, a lone outlier against
  // every other instance of this same bold/uppercase/blue table-intro heading convention (Board
  // Summary's "Contract Progress"/"Period Savings"/"Monthly Savings" headings and this report's
  // own "ASHRAE Guideline 36 Sequences" heading are all 11px) — dropped to 11px to match the
  // dominant convention. Text/content unchanged.
  // V-06 (2026-08-03): ONE caption convention for every chunk of this table. The first page used
  // this blue small-caps caption while continuation pages used a black, weight-600, sentence-case
  // bar with a bottom rule — two adjacent pages of one table looked like two documents (and the
  // bar's border-bottom was a floating separator rule, which the standing rules forbid). Every
  // chunk now renders through _readinessCaption(): same style, same words, "(N of M)" on the first
  // and "(continued, N of M)" after it, for ANY M (the JOCO table now splits into 4, not 2).
  // D-12 (2026-08-03): that shared caption's font raised 11px -> the 13pt section tier
  // (RPT_SECTION_HEAD_PX) — this heading introduces a table whose own column headers print at
  // 10pt, so at the old 11px (8.25pt authored, 10.005pt after the floor) it was barely larger than
  // the table it names.
  var READINESS_CAPTION_STYLE =
    'font-size:' +
    RPT_SECTION_HEAD_PX +
    'px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em';
  function _readinessCaption(chunkIndex, numChunks) {
    var part = '';
    if (numChunks > 1) {
      part = ' (' + (chunkIndex > 0 ? 'continued, ' : '') + (chunkIndex + 1) + ' of ' + numChunks + ')';
    }
    return '<div style="' + READINESS_CAPTION_STYLE + '">Building ASHRAE 36 Readiness' + part + '</div>';
  }
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header (color:#fff on
  // background:var(--rpt-blue)) to match the Proposal's plain/thin-bordered convention
  // (rptPageASHRAE36ProposalCover's thPlain) -- no fill, near-black text, same border. Styling
  // only; no content/values changed.
  var thStyle =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0;color:var(--rpt-page-text);text-align:left;white-space:normal;line-height:1.25;border:1px solid var(--rpt-border)';
  // Column widths (2026-07-09, fix/report-wording-compliance-rows): explicit colgroup +
  // table-layout:fixed added so column widths are deterministic instead of browser
  // auto-layout. Auto-layout let long building names (e.g. "P25309 - Jo Co Arts and
  // Heritage", "NC Sheriff's Operations Building", "Olathe Adult Detention Center") and the
  // Status column's longer "Partially Compliant · 434/764 sensors" text both wrap to a 2nd
  // line, breaking the "1 row = 1 line" invariant. Redistributed the 100% width from the
  // narrow-content columns (Equipment/Sensor Coverage/Sequence Readiness are 2-3 char
  // percentages or counts) and the Score column (whose bar had spare max-width, tightened
  // below) toward Building and Status, the two columns that actually need the room.
  // Tuned via headless render against the real JOCO dataset (2026-07-09): the first pass
  // (28/8/9/9/16/30) fixed 20 of 21 wrapped rows but left the longest building name
  // ("MedAct 1159 Sunflower Firestation-13", 37 chars) still wrapping. Took 3% from
  // Equipment/Sensor/Sequence (narrow numeric/percent content, had slack) and 2% from Score
  // (bar already tightened to a 60px ceiling, had slack) and gave all 5% to Building.
  // Header-clip fix (2026-07-09, same branch, follow-up): the 7/8/8% widths above were sized
  // for the DATA rows (2-3 char percentages) but left the HEADER labels ("Equipment", "Sensor
  // Coverage", "Sequence Readiness") clipped — DOM-confirmed scrollWidth > clientWidth on all
  // 3 <th> cells, with the neighboring th's own background painting over the overflow (each
  // th has its own solid background, so there's no visible "leak", just cut-off letters).
  // "Equipment" is a single unbreakable word (no space to wrap on) so it needs its column wide
  // enough for the whole word on one line; "Sensor Coverage"/"Sequence Readiness" can wrap
  // between the two words once white-space:normal is explicit (added to thStyle above,
  // replacing an unset value that rendered the same as browser default but wasn't taking
  // effect in this table-layout:fixed context) and the row grows a 2nd header line via
  // `line-height` above; thead height already budgeted at 44px (see ROWS_BUDGET_FIRST comment
  // above) which two 10px lines fit inside.
  // First attempt took the full 5% from Status alone (30->25) — headless-verified via a
  // Range.getClientRects() line-count probe (the only reliable "did this text actually wrap"
  // check; scrollWidth==clientWidth is NOT reliable for a block/flex div that fills its
  // parent, since it just reports the container's own box when content doesn't overflow it)
  // that this REGRESSED one row: the portfolio's longest status string ("Partially Compliant
  // · 2658/4032 sensors", natural width 173px) wrapped to 2 lines at Status's new 25%
  // (164px avail). Re-measured Building's real slack the same way (force
  // display:inline-block + white-space:nowrap, read scrollWidth): the longest building name
  // ("MedAct 1159 Sunflower Firestation-13") only needs 186px natural width against 222px
  // avail at the original 33% — 36px of genuine slack, contrary to the 2026-07-09 comment
  // above claiming zero slack (that comment was about the auto-layout wrapping bug fixed by
  // adding table-layout:fixed, not about remaining headroom once fixed-layout was in place).
  // Final split: Building 33->30 (-3%, still 14px above its 186px need), Status 30->28 (-2%,
  // still ~13px above its 173px need), Score untouched (at the time had a small pre-existing
  // 3px overflow on the "100%" score-bar text, out of scope for this header-only fix — do not
  // shrink Score further or that pre-existing issue gets worse; fixed separately in item
  // 6279e171, 2026-07-18, by capping the bar's px ceiling instead of touching this column's
  // width — see _buildRowHTML). +5% total went to
  // Equipment/Sensor/Sequence. Re-verified after rebalancing: 0 header overflow, 0 data-row
  // line-wrap regressions (see dashboardlogic entry for the exact before/after numbers).
  // U2 re-balance (2026-08-02, fix/u2-print-page-budget). The 30/10/9/9/14/28 split above was
  // fitted against a 10px (7.5pt printed) header. The 10pt printed-text floor raises every th to
  // 13.34px, which is 33% wider type in columns that had 0-3px of slack, so the header words
  // overflowed their cells and PRINTED ON TOP OF the neighbouring header. Measured in a print
  // render of the real JOCO audit (PyMuPDF span-pair overlap census, audit pages 2-5): 20
  // overlapping span pairs, e.g. 'COVERAGE' over 'READINESS' by 8.7pt, 'READINESS' over 'SCORE'
  // by 9.8pt, 'EQUIPMENT' over 'SENSOR' by 5.6pt.
  //
  // Re-fitted from measured natural widths at 13.34px in the print render (table width 718.9px,
  // th horizontal padding 16px, so inner = pct * 718.9 - 16):
  //   header longest unbreakable word: Building 64.4  Equipment 79.7  Coverage 74.1
  //                                    Readiness 73.7  Score 45.0  Status 48.8
  //   widest Status body line ~119 ("839/1294 sequences")
  // New split and the slack each column keeps:
  //   Building  25%  inner 163.7  (names wrap, as they already did; rows are 3 lines tall
  //                                anyway because the Status cell carries three lines)
  //   Equipment 14%  inner  84.6  vs 79.7  -> +4.9
  //   Sensor    13.5% inner  81.0  vs 74.1  -> +6.9
  //   Sequence  13.5% inner  81.0  vs 73.7  -> +7.3
  //   Score     14%  unchanged (its bar has a 60px ceiling from item 6279e171 and a known
  //                            pre-existing 3px overflow on a "100%" label -- do not shrink)
  //   Status    20%  inner 127.8  vs ~119   -> +9
  // Do not narrow Equipment/Sensor/Sequence again without re-running the overlap census: their
  // header words are unbreakable and there is no smaller legal type to fall back to.
  var colWidths = {
    building: 25,
    equipment: 14,
    sensor: 13.5,
    sequence: 13.5,
    score: 14,
    status: 20,
  };
  var colgroup =
    '<colgroup>' +
    '<col style="width:' +
    colWidths.building +
    '%">' +
    '<col style="width:' +
    colWidths.equipment +
    '%">' +
    '<col style="width:' +
    colWidths.sensor +
    '%">' +
    '<col style="width:' +
    colWidths.sequence +
    '%">' +
    '<col style="width:' +
    colWidths.score +
    '%">' +
    '<col style="width:' +
    colWidths.status +
    '%">' +
    '</colgroup>';
  var tableOpenHead =
    '<table style="width:100%;border-collapse:collapse;margin-bottom:12px;table-layout:fixed">' +
    colgroup +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    '">Building</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Equipment</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sensor Coverage</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sequence Readiness</th>' +
    '<th style="' +
    thStyle +
    '">Score</th>' +
    '<th style="' +
    thStyle +
    '">Status</th>' +
    '</tr></thead>';
  // Batch 3 item 3/3b (copy-options.md Option A — RECOMMENDED): append one plain-language
  // sentence per tier so a facility owner reading the score learns what that means
  // operationally, not just the number. Numeric footnote kept intact, meaning appended inline.
  // Labels renamed (item ed465b3c, 2026-07-09): Ready/Partial/Critical -> Fully Covered/
  // Partially Covered/Not Covered, then (2026-07-09 rename #2, Matt's decision, supersedes
  // v647) Covered -> Compliant, then (fix/audit-report-scoring, 2026-07-14, Matt's decision)
  // Compliant -> Readiness -- see _a36StatusChip for the full rationale (ASHRAE 36 defines no
  // composite score or compliance threshold; this is CSC's own assessment built on its
  // requirements). This footnote is rewritten to (a) describe the ACTUAL requirement-weighted
  // computation instead of the retired 40/60 blend, (b) state plainly that the score is CSC's
  // own assessment and that ASHRAE 36 itself defines no compliance score, and (c) interpolate
  // the real threshold constants (ASHRAE36_READINESS_HIGH_THRESHOLD/_PARTIAL_THRESHOLD) instead
  // of typed literals, so the printed numbers can never again drift from the code that applies
  // them. The underlying 'green'/'amber'/'red' status keys are unchanged (see _a36StatusChip).
  var tableFootnote =
    '<div style="font-size:10px;color:var(--rpt-page-text);margin-top:-10px;margin-bottom:12px;line-height:1.5">' +
    '<strong>Score</strong> is Control Service Company’s own readiness assessment, built on ASHRAE 36 requirements ' +
    'and weighted by how many apply to each equipment type. ASHRAE 36 itself defines no composite score or compliance threshold. ' +
    '<strong>Readiness bands:</strong> High ≥' +
    ASHRAE36_READINESS_HIGH_THRESHOLD +
    '% (meets the ASHRAE 36 baseline), Partial ' +
    ASHRAE36_READINESS_PARTIAL_THRESHOLD +
    '–' +
    (ASHRAE36_READINESS_HIGH_THRESHOLD - 1) +
    '% (some sensors and sequences are in place, but work is needed before sequences can run reliably), ' +
    'Low <' +
    ASHRAE36_READINESS_PARTIAL_THRESHOLD +
    '% (the building lacks the sensors or programming needed to run ASHRAE 36 sequences at all).' +
    '</div>';

  // Build a token per building row — type:'row', estH:52px
  // Row-height uniformity fix (2026-07): every <td> wraps its content in a flex box with a
  // shared min-height (ROW_BOX_MIN_H) so 1-line and 2-line building names render at the same
  // row height instead of alternating ~30.5px/~50px. Building names are NEVER truncated or
  // forced to nowrap — a name that needs 2 lines simply grows the row (and every cell in it)
  // to match; ROW_BOX_MIN_H is tuned to the 2-line ceiling so the common case looks uniform.
  // Density pass (feat/audit-report-reframe-density, 2026-07-09): was 40px, sized to force
  // EVERY row (including the rare 2-line building name) to the same tall height. Most JOCO
  // building names are short and fit on one line. See density investigation Finding 3
  // (stages/joco-audit-density-2026-07-09/investigation.md): 26 rows @ 50px/row = 3 pages
  // with a near-empty 3rd page.
  // First pass reduced this to 22px, but that under-measured: the Status cell text got
  // LONGER in the same pass (item ed465b3c, 2026-07-09: "Partial" -> "Partially Covered",
  // "Ready"/"Critical" similarly lengthened), so most non-100% rows now wrap the status
  // fraction ("Partially Covered · 2658/4032 sensors") onto 2 lines inside the Status column
  // — headless DOM measurement (getBoundingClientRect on live rendered rows) showed actual
  // row heights of 41-44px, not the assumed 32px (22+10 padding), which silently overflowed
  // the first Executive Summary page in the real jsPDF export (page grew to 1148px, spilling
  // table rows into the footer/footnote area — caught by rendering an actual PDF and looking
  // at it, not by the DOM proxy count alone). Re-tuned to 34px (34+10=44px matches the
  // measured max) — still a real reduction from the original 50px/row, just accurate instead
  // of optimistic.
  // U2 (2026-08-02): ROW_BOX_MIN_H stays 34 — it is a MINIMUM, and at the 10pt font floor the
  // rows are now taller than it anyway, so raising it would change nothing except the rare
  // single-line row. What DID have to change is the estimate the paginator budgets with; see
  // EXEC_ROW_EST_H below.
  var ROW_BOX_MIN_H = 34;
  var _rowBoxStyle = 'min-height:' + ROW_BOX_MIN_H + 'px;display:flex;align-items:center';
  // 2026-07-12 fix (item fb693f5c): row borders switched from the pale var(--rpt-rule)
  // (#d9dde3) to the darker var(--rpt-border) (#333333) to match the Per-Building Detail
  // table (rowBorder/tdBase, ~line 12433/12556) — the gridline-darkening pass in v655 only
  // reached that later table, leaving this first table in the report visibly lighter.
  function _buildRowHTML(b) {
    // Bar width (2026-07-09, fix/report-wording-compliance-rows): was 1:1 px-per-composite-%
    // (max 100px, capped by an effectively-unreachable max-width:120px) — that's more bar
    // than the Score column needs, at the expense of Building/Status which actually wrap.
    // Scaled down to a 60px ceiling (still visually proportional) to free width for the
    // colgroup redistribution above.
    // 2026-07-18 fix (item 6279e171): the 60px ceiling above collided with the "100%" label
    // (4 chars, only string that long) — bar(60)+gap(4)+"100%"(~24px) = ~88px content inside
    // the Score column's ~85px available width, a 3px DOM overflow that ONLY fires at
    // composite===100 (the one point where both the bar's max width and the label's max
    // char-count are hit simultaneously). Capped the ceiling at 56px instead of 60px — frees
    // 4px, enough to close the gap — with no visible change below composite~93
    // (round(93*0.6)=56 already, so only 93-100% bars get an imperceptibly shorter bar).
    // V-05 (2026-08-03): the 56px cap did not close it — the label was still glued to the RIGHT
    // END OF A VARIABLE-LENGTH BAR, so (a) no two percentages shared an edge (measured spread of
    // the label right edges across one page: 31.5pt = 0.44in, x369.0 "24%" to x400.5 "95%" in the
    // shipped export) and (b) the two widest cases still overran: DOM 95% 87px and 100% 94px
    // against 84px of inner cell, and in the PDF the "100%" span crossed the Score/Status column
    // rule by 1.62pt. Both are the same root cause and both are fixed by giving the bar a FIXED
    // TRACK and right-aligning the label in a FIXED BOX, so every label shares one right edge at
    // the cell's padding edge and the worst case is arithmetically inside the column:
    //   inner width 84.7px (measured) >= track 44 + gap 4 + label 35 = 83px
    // Label box 35px is the measured width of the widest label, "100%", at the 10pt printed floor
    // (34.1px; every two-digit label is 26.8px). The bar keeps full proportionality by rescaling
    // to the new track (44/100 = 0.44 px per point) rather than clipping at a ceiling.
    // The Score COLUMN is not narrowed — narrowing it is what makes this worse (see colWidths).
    var SCORE_TRACK_W = 44;
    var SCORE_GAP_W = 4;
    var SCORE_LABEL_W = 35;
    var barPx = Math.min(SCORE_TRACK_W, Math.round(b.composite * (SCORE_TRACK_W / 100)));
    var bar =
      '<div style="display:flex;align-items:center;gap:' +
      SCORE_GAP_W +
      'px">' +
      '<div style="flex:0 0 ' +
      SCORE_TRACK_W +
      'px;height:8px">' +
      '<div style="width:' +
      barPx +
      'px;max-width:' +
      SCORE_TRACK_W +
      'px;height:8px;background:' +
      b.statusColor +
      ';border-radius:2px;min-width:2px"></div>' +
      '</div>' +
      '<span style="flex:0 0 ' +
      SCORE_LABEL_W +
      'px;text-align:right;font-size:10px;color:var(--rpt-page-text)">' +
      b.composite +
      '%</span>' +
      '</div>';
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      // R5 (2026-08-03) V-07/D-14: client-visible name only. b.name stays the raw Equipment
      // Matrix key used for row matching elsewhere in this file.
      (b.displayName || rptBuildingDisplayName(b.name)) +
      '</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      rptCount(b.equipCount) +
      '</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      b.pointPct +
      '%</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      (b.seqPct !== null ? b.seqPct + '%' : 'N/A') +
      '</div></td>' +
      '<td style="padding:5px 8px;border:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      bar +
      '</div></td>' +
      '<td style="padding:5px 8px;border:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      _a36StatusChip(
        b.status,
        b.totalSensorsInPlace,
        b.totalSensorsRequired,
        b.seqPct === null,
        b.totalSeqMatched,
        b.totalSeqRequired,
      ) +
      '</div></td>' +
      '</tr>'
    );
  }

  // Build flat token list — one token per building row
  // U2 (2026-08-02): estH was `ROW_BOX_MIN_H + 10` = 44px, which assumed the row's tallest cell
  // was the flex box's own 34px minimum plus 5px+5px of td padding. At the 10pt printed-text floor
  // that assumption is dead: the Status cell ("Partially Covered · 2658/4032 sensors") and the
  // building name both wrap to more lines at the larger size, and headless print-media measurement
  // of all 27 JOCO rows returned 65px for 25 of them (45-47px for the two shortest). Budgeting 44
  // against a real 65 under-counted the readiness table by ~21px PER ROW — 231px on an 11-row page
  // — which is the arithmetic behind D-04's Audit p2/p3 footer collisions. Now stated as its own
  // measured constant rather than derived from an unrelated CSS minimum that no longer binds.
  var EXEC_ROW_EST_H = 66; // DOM-measured max 65px at the 10pt floor; +1 for sub-pixel rounding
  var allBuildings = d.buildings;
  var tokens = allBuildings.map(function (b) {
    return { type: 'row', estH: EXEC_ROW_EST_H, html: _buildRowHTML(b) };
  });
  // Edge case: no buildings
  if (tokens.length === 0) {
    tokens.push({
      type: 'row',
      estH: EXEC_ROW_EST_H,
      html: '<tr><td colspan="6" style="padding:8px;font-size:11px;color:var(--rpt-page-text)">No buildings in portfolio.</td></tr>',
    });
  }

  // Legend renders ONCE, after the LAST chunk only (Matt's fix #2, 2026-08-03): repeating the
  // "Score and Readiness Bands" methodology block (tableFootnote) after every one of the (now up
  // to 4) chunks ate ~EXEC_FOOTNOTE_H (100px) per intermediate page for content already stated on
  // the first. ROWS_BUDGET_FIRST/CONT above still reserve that 100px on every page (needed for
  // whichever page turns out to be last), so paginate here with NOFOOT budgets that give the
  // reclaimed 100px back to rows on every page, then re-check only the actual last chunk: if
  // adding the footnote back to that page would overflow it, spill the trailing rows that don't
  // fit onto a new final chunk sized WITH the footnote reserved (that new chunk becomes the one
  // that prints the legend). Row height (66px) is always smaller than the reclaimed 100px, so at
  // most one row ever needs to move.
  var ROWS_BUDGET_FIRST_NOFOOT = ROWS_BUDGET_FIRST + EXEC_FOOTNOTE_H;
  var ROWS_BUDGET_CONT_NOFOOT = ROWS_BUDGET_CONT + EXEC_FOOTNOTE_H;

  // Paginate using shared pixel-height paginator
  var chunks = _rptPaginateTokens(tokens, ROWS_BUDGET_FIRST_NOFOOT, ROWS_BUDGET_CONT_NOFOOT);

  (function _refitLastChunkForFootnote() {
    var lastChunk = chunks[chunks.length - 1];
    var lastIsFirst = chunks.length === 1;
    var lastBudgetWithFootnote = lastIsFirst ? ROWS_BUDGET_FIRST : ROWS_BUDGET_CONT;
    var lastUsedPx = lastChunk.reduce(function (sum, tok) {
      return sum + (tok.estH || 20);
    }, 0);
    if (lastUsedPx <= lastBudgetWithFootnote) return;
    var overflowTokens = [];
    while (lastChunk.length > 1 && lastUsedPx > lastBudgetWithFootnote) {
      var popped = lastChunk.pop();
      lastUsedPx -= popped.estH || 20;
      overflowTokens.unshift(popped);
    }
    if (overflowTokens.length > 0) chunks.push(overflowTokens);
  })();

  var numChunks = chunks.length;
  var resultPages = [];

  chunks.forEach(function (chunk, chunkIndex) {
    var tableRows = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var table = tableOpenHead + '<tbody>' + tableRows + '</tbody></table>';

    var pageN = n + chunkIndex;
    var isLastChunk = chunkIndex === numChunks - 1;

    // Every chunk carries the SAME caption, in the same style, numbered "N of M" for any M
    // (V-06, 2026-08-03; caption's own font raised to the 13pt section tier by D-12, same date --
    // see READINESS_CAPTION_STYLE above). First page keeps its callouts ahead of the caption.
    // tableFootnote (the "Score and Readiness Bands" legend) now prints only once, after the
    // LAST chunk (Matt's fix #2, 2026-08-03) -- see _refitLastChunkForFootnote above for how the
    // per-chunk row budget accounts for that.
    var bodyHTML =
      (chunkIndex === 0 ? dcvCallout + callout : '') +
      _readinessCaption(chunkIndex, numChunks) +
      table +
      (isLastChunk ? tableFootnote : '');

    resultPages.push(
      rptPage(pageN, 'ASHRAE 36 Audit Report: Executive Summary', bodyHTML, {
        data: fakeData,
        label:
          'Page ' +
          pageN +
          ' — Executive Summary' +
          (numChunks > 1 ? ' (' + (chunkIndex + 1) + '/' + numChunks + ')' : ''),
      }),
    );
  });

  return resultPages; // always an Array, even for short portfolios (length === 1)
}

// ─── rptPageASHRAE36CostEstimate ──────────────────────────────────────────
/**
 * Estimated Cost page: surfaces priced totals from collectPricingEstimate.
 * Phase 5 — spec §10 (2026-06-18).
 * Pagination (2026-06-19): rationale table split across pages via _rptPaginateTokens
 * when row count exceeds the first-page body budget. Returns an ARRAY of rptPage()
 * strings (1 element when rationale fits; 2+ when it overflows). Caller must spread.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data
 * @returns {Array<string>} Array of rptPage() HTML strings
 */
function rptPageASHRAE36CostEstimate(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // feat/audit-report-reframe-density (2026-07-09): content reframe per Matt's confirmed
  // decision ("all sequences, plain-language"). This table used to list ONLY missing-sensor
  // rows and blocked/partial sequence rows (a punch list, via buildComplianceRows /
  // buildRecommendedRows in pricing-estimator.js). It now lists EVERY ASHRAE Guideline 36
  // sequence applicable to the equipment present in this portfolio, so the reader sees the
  // full compliance picture, not just gaps. Individual missing-sensor/hardware rows are NOT
  // removed from the report overall — they still drive the Proposal's Scope of Work page
  // (rptPageASHRAE36ProposalScope, which reads d.portfolio.topGaps) — only this Audit-report
  // table's row source changed.
  //
  // Correction (2026-07-09, Matt's decision): this table is INFORMATIONAL REFERENCE ONLY —
  // it explains what each G36 sequence is, in plain English. It originally shipped with a
  // per-sequence Ready/Partial/Critical STATUS column (same aggregation as the Building
  // Compliance Status table), but Matt flagged that a per-project rollup status doesn't
  // belong on a reference table describing what a sequence IS — that status lives on the
  // Building ASHRAE 36 Readiness table and Per-Building Detail instead. The status column and
  // its underlying ready/partial/blocked aggregation were removed; only the applicability
  // filter (does this sequence apply to any equipment in the portfolio?) remains.
  //
  // Source of truth for "every applicable sequence": EM_SEQUENCE_DEFS (equipment-matrix.js).
  // Per-equipment readiness: d.buildings[*].equipResults[*].seqReadiness, already computed in
  // collectASHRAE36Data() via emComputeSequenceReadiness() (status 'ready'|'partial'|
  // 'blocked'|'na' per sequence per equipment instance). Here we only check whether a
  // sequence applies to at least one piece of equipment anywhere (status !== 'na') to decide
  // whether to list it — no status is computed or rendered.
  var rationaleTokens = [];
  var _seqProgramTotal = 0; // sum of the printed quantity column — must equal the cover figure
  try {
    var seqApplicable = {}; // seqKey -> true if it applies to at least one piece of equipment
    (d.buildings || []).forEach(function (b) {
      (b.equipResults || []).forEach(function (eq) {
        var sr = eq.seqReadiness || {};
        Object.keys(sr).forEach(function (seqKey) {
          var entry = sr[seqKey];
          if (!entry || entry.status === 'na') return;
          seqApplicable[seqKey] = true;
        });
      });
    });

    // ── Quantity column (V-10, visual review 2026-08-02) ──────────────────────
    // The cover headlines "N control sequences programmed" and this is the section that exists
    // to explain that number, but it listed 16 sequence TYPES with no quantity of any kind, so a
    // reader could not see how N was built. Standing rule is to count actual items, not buildings.
    //
    // These counts are derived from THE SAME source and THE SAME filter that produces the cover
    // figure (rptPageASHRAE36Cover, this file): buildCatalogRows(project id) — the priced scope,
    // which applies the monitoring-only-zone-unit, ioOnly and building-level dedup exclusions the
    // raw per-equipment accumulators never see — summing `qty` over rows with phase === 2 (the
    // sequence-programming rows) AND a seqKey (which excludes buildSensorInvestigationRows' phase-2
    // labor rows, exactly as the cover does; without that clause the cover measured 1,304 instead
    // of 1,285). Grouping the very same rows by seqKey therefore reconciles to the cover by
    // construction — the total row below prints the sum of the printed column, never a separately
    // computed figure, so the two can never silently disagree.
    //
    // qty on a phase-2 row is a count of EQUIPMENT UNITS whose readiness for that sequence is
    // 'blocked' or 'partial' — i.e. units that still need it programmed. Units already ready, and
    // units the sequence does not apply to, are not counted (absence is not always a deficiency).
    // Cached on `d` the same way _a36BuildingContent caches it: buildCatalogRows walks the whole
    // project on every call.
    if (!d._a36CatalogRowsCache) {
      d._a36CatalogRowsCache = typeof buildCatalogRows === 'function' ? buildCatalogRows(d.project.id) || [] : [];
    }
    var _seqProgramCounts = {}; // seqKey -> equipment units still needing this sequence programmed
    var _seqCatalogTotal = 0; // every phase-2/seqKey row, whether or not its key has a def below
    (d._a36CatalogRowsCache || []).forEach(function (r) {
      if (!r || r.phase !== 2 || !r.seqKey) return;
      _seqProgramCounts[r.seqKey] = (_seqProgramCounts[r.seqKey] || 0) + (r.qty || 0);
      _seqCatalogTotal += r.qty || 0;
    });

    var seqDefsList =
      typeof EM_SEQUENCE_DEFS !== 'undefined' && Array.isArray(EM_SEQUENCE_DEFS) ? EM_SEQUENCE_DEFS : [];
    seqDefsList.forEach(function (seq) {
      // Listed when the sequence applies to any audited equipment OR carries priced programming
      // work. The second clause is what makes the column arithmetically incapable of losing a
      // count: no row with a quantity can be filtered out of the table.
      if (!seqApplicable[seq.key] && !_seqProgramCounts[seq.key]) return;
      var plainDesc = (typeof ASHRAE36_SEQUENCE_PLAIN !== 'undefined' && ASHRAE36_SEQUENCE_PLAIN[seq.key]) || '';
      // 2026-07-23 (Matt's request): show which BAS points/sensors this sequence needs, directly
      // under the sequence name. Required-point source is EM_SEQUENCE_DEFS[*].requiredCats (this
      // same file, equipment-matrix.js) — NOT app/pricing-estimator.js's SEQUENCE_BLOCKING_SENSORS,
      // which is a narrower "does this block the cost-tier discount" subset (6 of 17 sequences
      // have an empty array there even though they do require points — see rationale in the
      // dashboardlogic.md entry for this change). requiredCats is the complete, already-authoritative
      // list this same table already uses to compute per-equipment sequence readiness
      // (emComputeSequenceReadiness). Labels come from _pricingPointLabel (pricing-estimator.js)
      // first, falling back to the EM_POINT_CATEGORIES category definition (equipment-matrix.js)
      // for the handful of keys _pricingPointLabel doesn't have (rfEnable, rfSpeedCmd, co2) —
      // never a raw unresolved point key.
      var sensorLine = _a36SeqRequiredSensorLabels(seq);
      var seqName = _a36SeqDisplayLabel(seq);
      var seqQty = _seqProgramCounts[seq.key] || 0;
      _seqProgramTotal += seqQty;
      var rowHTML =
        '<tr>' +
        '<td style="padding:7px 10px;font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'border:1px solid var(--rpt-border);vertical-align:top;width:' +
        A36_SEQ_COL_NAME_PCT +
        '%">' +
        _esc(seqName) +
        (sensorLine
          ? '<div style="font-size:9px;font-weight:400;color:var(--rpt-page-text);margin-top:3px;line-height:1.4">' +
            'Requires: ' +
            _esc(sensorLine) +
            '</div>'
          : '') +
        '</td>' +
        '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
        'border:1px solid var(--rpt-border);vertical-align:top;width:' +
        A36_SEQ_COL_SPEC_PCT +
        '%;white-space:nowrap">' +
        'Section ' +
        _esc(String(seq.ashrae36 || '').replace(/^§/, '')) +
        '</td>' +
        '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
        'border:1px solid var(--rpt-border);vertical-align:top;text-align:center;width:' +
        A36_SEQ_COL_QTY_PCT +
        '%">' +
        rptCount(seqQty) +
        '</td>' +
        '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
        'border:1px solid var(--rpt-border);line-height:1.5;vertical-align:top">' +
        _esc(plainDesc) +
        '</td>' +
        '</tr>';
      // U2 / RC-A (2026-08-02, D-04): estH was a two-bucket guess (82px with a "Requires:"
      // sub-line, 60px without). At the 10pt printed-text floor the real rows measured 75-153px
      // in a headless print render of the JOCO Audit — every single one taller than 82 — so the
      // paginator packed 8 rows onto a page that could hold 6 and the last rows printed over the
      // footer wave. A flat constant cannot work here: row height is driven by how many lines the
      // sequence NAME (26% column), its "Requires:" list, and the plain-language DESCRIPTION each
      // wrap to, and those vary by a factor of two across the 16 sequences.
      //
      // Model below is the same characters-per-line shape the Per-Building Detail table already
      // uses, with the constants fitted against all 16 measured rows (grid search over chars-per-
      // line for each column): it never under-estimates a single row and over-estimates by only
      // 4px per row on average. Line height is _rptTextLineH() — the floored 13.34px font times
      // the 1.5 line-height these cells declare — so if the floor ever changes, this follows it.
      //
      // V-10 (2026-08-03): the quantity column narrowed the name column 26% -> 24% and the
      // description column 58% -> 47%, so all three chars-per-line constants were re-fitted
      // against a fresh headless print render of every row at the new widths (same method: the
      // largest constant that still never under-estimates a measured row).
      var SEQ_ROW_PAD_H = 14; // td padding 7px top + 7px bottom
      var SEQ_NAME_CPL = 18; // chars per line, bold sequence label in the 24% (~152px) name column
      var SEQ_REQ_CPL = 21; // chars per line, "Requires: ..." sub-line (regular weight, same column)
      var SEQ_DESC_CPL = 40; // chars per line, plain-language description in the 47% (~318px) column
      var SEQ_REQ_GAP = 3; // the sub-line's margin-top
      // One line height for all three columns: measured, the sub-line's declared line-height:1.4
      // still lays out on the same 20px rhythm as the 1.5 cells once the font floor applies, and
      // fitting it at 19px under-estimated two real rows by 1px.
      var _seqLineH = _rptTextLineH(1.5);
      var _reqText = sensorLine ? 'Requires: ' + sensorLine : '';
      var _nameH = Math.ceil((seqName || '').length / SEQ_NAME_CPL) * _seqLineH;
      var _reqH = _reqText ? SEQ_REQ_GAP + Math.ceil(_reqText.length / SEQ_REQ_CPL) * _seqLineH : 0;
      var _descH = Math.ceil(plainDesc.length / SEQ_DESC_CPL) * _seqLineH;
      rationaleTokens.push({
        type: 'row',
        html: rowHTML,
        estH: SEQ_ROW_PAD_H + Math.max(_nameH + _reqH, _descH),
      });
    });

    // Totals row (site table standard: totals where applicable). It prints the sum of the printed
    // column, so the column always adds up to what the row says. That sum is asserted against the
    // catalog total here: a difference could only come from a priced sequence key with no
    // EM_SEQUENCE_DEFS entry, which would mean a row of work exists that no reader can see. It is
    // logged rather than papered over — neither figure is ever adjusted to make the other agree.
    if (rationaleTokens.length) {
      if (_seqProgramTotal !== _seqCatalogTotal) {
        console.error(
          'rptPageASHRAE36CostEstimate: sequence quantity column (' +
            _seqProgramTotal +
            ') does not reconcile with the priced sequence total (' +
            _seqCatalogTotal +
            ') — a priced sequence key has no EM_SEQUENCE_DEFS entry.',
        );
      }
      rationaleTokens.push({
        type: 'row',
        html:
          '<tr>' +
          '<td colspan="2" style="padding:7px 10px;font-size:11px;font-weight:700;' +
          'color:var(--rpt-page-text);border:1px solid var(--rpt-border);vertical-align:top;text-align:right">' +
          'Total control sequences to program' +
          '</td>' +
          '<td style="padding:7px 10px;font-size:11px;font-weight:700;color:var(--rpt-page-text);' +
          'border:1px solid var(--rpt-border);vertical-align:top;text-align:center">' +
          rptCount(_seqProgramTotal) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
          'border:1px solid var(--rpt-border);line-height:1.5;vertical-align:top">' +
          'One for each piece of heating and cooling equipment that needs that sequence programmed.' +
          '</td>' +
          '</tr>',
        estH: SEQ_ROW_TOTALS_H,
      });
    }
  } catch (e) {
    console.error('rptPageASHRAE36CostEstimate: sequence-glossary table build failed', e);
    rationaleTokens = []; // non-fatal — omit block if anything throws
  }

  // ── Page assembly with sequence table pagination ───────────────────────────
  // Budget updated (2026-06-29): cost table removed; full body available for rows.
  //   Page 1 body ~808px; chrome = _ratTitle(~17px) + _ratThead(~27px) + div(~18px) = ~62px
  //   Row budget = 808 − 62 = ~746px; using 740 for safety margin.
  //   Cont pages: same calibrated value of 750px.
  // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
  // standalone literals — RATIONALE_BASE_ADJUSTMENT constants preserve these exact numeric
  // values (904 - 164 = 740, 904 - 154 = 750), no visual/page-count change.
  // U2 (2026-08-02): the two BASE_ADJUSTMENT literals (164/154) preserved budgets calibrated
  // against an 808px body and pre-floor type. Replaced with this page's own measured chrome, taken
  // from a headless print render at the 10pt floor: the section title block is 28px including its
  // margin, and the table head is 33px on the first page but 53px on a continuation page (the
  // slightly narrower "ASHRAE 36 Spec" column there wraps the header onto a second line) — 56px
  // covers both, so first and continuation pages can share one honest budget instead of two
  // differently-fudged ones.
  // D-12 (2026-08-03): 28 -> 34, re-measured after the "ASHRAE 36 Sequences" title moved to the
  // 13pt section tier (26px box + its 8px margin-bottom).
  var RATIONALE_TITLE_H = 34; // measured, section title + its margin-bottom
  var RATIONALE_THEAD_H = 56; // measured 33 first page / 53 continuation; 56 covers both
  var RATIONALE_SAFETY_H = 40; // single page-level margin, same convention as EXEC_SAFETY_H above
  // V-10: the first page also carries the sentence that tells the reader what the quantity column
  // counts and that it adds to the cover figure. Measured 3 lines plus its margin at the floor.
  var RATIONALE_INTRO_H = 72;
  var RATIONALE_BUDGET_CONT =
    _rptContentBudget('standard') - RATIONALE_TITLE_H - RATIONALE_THEAD_H - RATIONALE_SAFETY_H;
  var RATIONALE_BUDGET_FIRST = RATIONALE_BUDGET_CONT - RATIONALE_INTRO_H;

  // V-09 / running-head repetition (visual review 2026-08-02): the running head read
  // "ASHRAE 36 Audit Report: ASHRAE 36 Sequences" with the caption "ASHRAE 36 SEQUENCES" directly
  // under it, so the same phrase printed three times in three consecutive lines. The section is now
  // "Control Sequences" in both the running head and the caption (the standard itself is still
  // named by the running head's document title and by the table's own "ASHRAE 36 Section" column),
  // which drops the repetition from three lines to two without losing identification.
  var SEQ_SECTION_TITLE = 'Control Sequences';

  // Shared HTML fragments for the sequence table chrome
  // D-12 (2026-08-03): 11px -> the 13pt section tier, so this heading outranks both the 10pt
  // column headers and the 10.5pt cell text of the sequences table it introduces.
  // ── Continuation convention (V-09) ────────────────────────────────────────
  // Pages 4 and 5 previously carried the IDENTICAL caption with no marker at all, so a reader
  // turning the page reasonably concluded the section had printed twice; the only hint was a
  // running head reading "(cont.)", an abbreviation in a document whose standing rule is no
  // abbreviations. One convention now applies to both the caption and the running head, matching
  // the Building Readiness table two pages earlier: "(1 of 2)" on the first page of a split
  // section, "(continued, 2 of 2)" on each later page, spelled out, never abbreviated. A section
  // that fits on one page carries no marker.
  function _seqPartSuffix(idx, total) {
    if (total < 2) return '';
    return idx === 0 ? ' (1 of ' + total + ')' : ' (continued, ' + (idx + 1) + ' of ' + total + ')';
  }
  function _ratTitleFor(idx, total) {
    return (
      '<div style="font-size:' +
      RPT_SECTION_HEAD_PX +
      'px;font-weight:700;color:var(--rpt-blue);margin-bottom:8px;' +
      'text-transform:uppercase;letter-spacing:0.04em">' +
      _esc(SEQ_SECTION_TITLE + _seqPartSuffix(idx, total)) +
      '</div>'
    );
  }

  // V-10: first page only — what the quantity column counts, and the fact that it adds to the
  // figure the cover headlines. Without this the reader has a number and no way to place it.
  var _ratIntro =
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.5;margin-bottom:8px">' +
    'A sequence is listed below when it applies to at least one piece of equipment that was ' +
    'audited. The quantity column counts how many pieces of equipment still need that sequence ' +
    'programmed, and the quantities add to ' +
    rptCount(_seqProgramTotal) +
    ', the number of control sequences reported on the cover page.' +
    '</div>';
  // Status column removed (2026-07-09, Matt's decision): this table is informational
  // reference only (what each sequence IS, not a per-project readiness rollup) — see the
  // rationaleTokens comment above.
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header, matching the
  // Proposal's plain/thin-bordered convention. Styling only.
  // V-10 (2026-08-03): fourth column added. "ASHRAE 36 Spec" also became "ASHRAE 36 Section" and
  // its cells read "Section 5.16.2" rather than "ASHRAE 36 §5.16.2" — "spec" is an abbreviation,
  // and the header already names the standard, so the cell no longer repeats it on every row.
  var _ratThead =
    '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;width:' +
    A36_SEQ_COL_NAME_PCT +
    '%;border:1px solid var(--rpt-border)">Sequence</th>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;width:' +
    A36_SEQ_COL_SPEC_PCT +
    '%;border:1px solid var(--rpt-border)">ASHRAE 36 Section</th>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:center;width:' +
    A36_SEQ_COL_QTY_PCT +
    '%;border:1px solid var(--rpt-border)">Number to Program</th>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)">Description</th>' +
    '</tr></thead><tbody>';
  var _ratTclose = '</tbody></table>';

  var resultPages = [];
  var currentPageNum = n;

  if (rationaleTokens.length === 0) {
    // No sequence data (fallback path or no rows) — single page with simple note
    resultPages.push(
      rptPage(
        currentPageNum,
        'ASHRAE 36 Audit Report: ' + SEQ_SECTION_TITLE,
        '<div style="font-size:11px;color:var(--rpt-page-text)">No sequence data available.</div>',
        {
          data: fakeData,
          label: 'Page ' + currentPageNum + ' — ' + SEQ_SECTION_TITLE,
        },
      ),
    );
  } else {
    var ratChunks = _rptPaginateTokens(rationaleTokens, RATIONALE_BUDGET_FIRST, RATIONALE_BUDGET_CONT);

    ratChunks.forEach(function (chunk, chunkIdx) {
      var isFirst = chunkIdx === 0;
      var chunkRowsHTML = chunk
        .map(function (tok) {
          return tok.html;
        })
        .join('');
      var pageBody =
        '<div>' +
        _ratTitleFor(chunkIdx, ratChunks.length) +
        (isFirst ? _ratIntro : '') +
        _ratThead +
        chunkRowsHTML +
        _ratTclose +
        '</div>';

      resultPages.push(
        rptPage(
          currentPageNum,
          'ASHRAE 36 Audit Report: ' + SEQ_SECTION_TITLE + _seqPartSuffix(chunkIdx, ratChunks.length),
          pageBody,
          { data: fakeData, label: 'Page ' + currentPageNum + ' — ' + SEQ_SECTION_TITLE },
        ),
      );
      currentPageNum++;
    });
  }

  return resultPages;
}

// ─── rptPageASHRAE36Building ──────────────────────────────────────────────
/**
 * Per-building detail page: structured equipment-by-row table showing sensors
 * present, sensors needed (with human-readable names), and sequences not ready.
 * Replaces the prose "What Is Working" + gap-box list from the original design.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data
 * @param {object} building - Single building entry from d.buildings
 */
/**
 * _a36BuildingContent — shared per-building content builder, extracted from
 * rptPageASHRAE36Building (feat/audit-report-reframe-density, 2026-07-09) so the SAME
 * gauges/table/summary HTML can be consumed two ways:
 *   1. rptPageASHRAE36Building — a building whose content is too tall for one shared page
 *      gets its own dedicated page(s), exactly as before this refactor (byte-identical
 *      output for that path — only the setup code moved, none of the logic changed).
 *   2. _a36BuildingBlockToken — a building whose content fits comfortably on a page gets
 *      packed alongside other small buildings on a SHARED page (density Finding 4: 26 of 39
 *      pages were "Per-Building Detail," one building = one forced full 1056px page even for
 *      a building with 1 piece of equipment — see
 *      stages/joco-audit-density-2026-07-09/investigation.md).
 * Returns { b, fakeData, gauges, intro, tableHead, tokens, summaryRowHtml, infraCallout }.
 */
function _a36BuildingContent(d, building, showBuildingInfra) {
  var b = building;
  // Rule 2.3: reportDate drives footer date; label empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // Priced-scope reconciliation (fix/per-building-sensor-reconcile, 2026-07-29) — the raw
  // eq.compliance.missingPoints / eq.seqReadiness accumulators below used to be this table's
  // ONLY source, the same defect class commit 2cd25a7 fixed on the cover page: buildCatalogRows
  // applies monitoring-only-zone-unit exclusion (_pricingIsMonitoringOnlyZoneUnit — equipment
  // rows missing BOTH coolSP and htgSP are dropped entirely, before any row is generated),
  // ioOnly exclusion ($0/no-install existing-controller-I/O points), and oat/oaWetBulb/damper/
  // co2+zoneTemp combo dedup that the raw per-equipment accumulators never see. Measured
  // 2026-07-29 on real JOCO data: NC Adult Detention Center's VAV Terminals row alone was
  // printing 255 raw sensor gaps — 60 of its 62 VAV units are monitoring-only detention cells
  // wired for temperature monitoring only, by design (feedback_absence_is_not_always_a_
  // deficiency.md) — while only 4 were ever priced. Cached on `d` (memoized once per report
  // render) rather than recomputed here, since buildCatalogRows walks the WHOLE project on every
  // call and this function runs once PER BUILDING (up to 27 times per report).
  if (!d._a36CatalogRowsCache) {
    d._a36CatalogRowsCache = typeof buildCatalogRows === 'function' ? buildCatalogRows(d.project.id) || [] : [];
  }
  var _a36CatRows = d._a36CatalogRowsCache;

  // Helper: resolve human-readable name for a missing point category key
  function _missingPointName(mp) {
    var desc = ASHRAE36_GAP_DESCRIPTIONS[mp.categoryKey];
    if (desc && desc.short) return desc.short;
    if (mp.categoryLabel) return mp.categoryLabel;
    return mp.categoryKey;
  }

  // Helper: resolve human-readable label for a sequence key
  function _seqLabel(seqKey, seqEntry) {
    if (seqEntry && seqEntry.label) return seqEntry.label;
    var desc = ASHRAE36_GAP_DESCRIPTIONS[seqKey];
    if (desc && desc.short) return desc.short;
    return seqKey;
  }

  // Coverage gauges (first page only)
  // fix/dec468f4 (2026-07-27): 'rtu' was missing from this map -- AUDITABLE and CAT_LABELS
  // (both above, ~line 11678/11694) already include 'rtu' ('Rooftop Unit'), but this SEPARATE
  // plural-label map (used only by this function's equipment-breakdown chips and the
  // Per-Building Detail summary table's Equipment Type column) did not, so any building with
  // RTU equipment fell through the `CAT_LABELS_PLURAL[cat] || cat` fallback and printed the raw
  // lowercase category key "rtu" instead of a real equipment name -- the only raw type code
  // missing from this map (every other AUDITABLE key already had an entry).
  var CAT_LABELS_PLURAL = {
    ahu: 'Air Handlers',
    rtu: 'Rooftop Units',
    vav: 'Variable Air Volume Terminals',
    fpb: 'Fan-Powered Terminals',
    ddvav: 'Dual-Duct Terminals',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Towers',
    doas: 'Dedicated Outdoor Air System Units',
    fcu: 'Fan Coil Units',
    zone: 'Zone Terminals',
    furnace: 'Furnaces',
    heater: 'Heaters',
    ef: 'Exhaust Fans',
  };
  var equipBreakdown = Object.keys(b.equipCounts)
    .map(function (cat) {
      return (
        '<span style="font-size:10px;color:var(--rpt-page-text);margin-right:8px">' +
        b.equipCounts[cat] +
        ' ' +
        (CAT_LABELS_PLURAL[cat] || cat) +
        '</span>'
      );
    })
    .join('');

  // Per-building gauge colors — R2 (2026-08-03), V-01. These were part of the SAME 2026-07-29
  // brand-color pass that broke the cover (Overall -> CSC blue, Sensors/Sequences -> CSC green),
  // so they carried the identical contradiction: a ring painted "High Readiness" green sitting
  // inches above an _a36StatusChip reading "Partial Readiness" for the same building. Fixed the
  // same way and from the same single rule — a36ReadinessColor() — so cover, per-building page
  // and readiness table now all speak one color language.
  var gauges =
    '<div style="display:flex;gap:14px;margin-bottom:12px;align-items:center">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.composite, a36ReadinessColor(b.composite), 'Overall', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.pointPct, a36ReadinessColor(b.pointPct), 'Sensors', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    (b.seqPct !== null
      ? _a36GaugeSVG(b.seqPct, a36ReadinessColor(b.seqPct), 'Sequences', 70)
      : '<svg width="70" height="77.7" viewBox="0 0 70 77.7" style="display:block">' +
        '<circle cx="35" cy="35" r="26.6" fill="none" stroke="var(--rpt-rule)" stroke-width="6.3"/>' +
        // Grey text on a client deliverable is banned (same rule already applied to the
        // "Not found in this export" text below) — full black, matching --rpt-page-text.
        '<text x="35" y="39" text-anchor="middle" font-size="13" font-weight="700" fill="var(--rpt-page-text)" font-family="Arial,sans-serif">N/A</text>' +
        '<text x="35" y="68.95" text-anchor="middle" font-size="8.05" fill="var(--rpt-page-text)" font-family="Arial,sans-serif">Sequences</text>' +
        '</svg>') +
    '</div>' +
    '<div style="flex:1">' +
    // Building name is the top-level heading for the whole block (gauges + table +
    // total) — reuse the report's own .rpt-body h2 "Section Headings" treatment
    // (16px, var(--rpt-blue), trailing rule) instead of a smaller inline style so
    // each building's section reads as a real header at a glance (2026-07-10 fix,
    // was 12px/600 — smaller than the 13px body text).
    '<h2 style="margin:0 0 4px 0">' +
    // R5 (2026-08-03): client-visible name, never the raw Equipment Matrix key.
    _a36DisplayName(b) +
    '</h2>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:6px">' +
    rptCount(b.equipCount) +
    ' equipment units audited</div>' +
    '<div style="margin-bottom:4px">' +
    equipBreakdown +
    '</div>' +
    _a36StatusChip(
      b.status,
      b.totalSensorsInPlace,
      b.totalSensorsRequired,
      b.seqPct === null,
      b.totalSeqMatched,
      b.totalSeqRequired,
    ) +
    '</div>' +
    '</div>';

  // Tier/category grouping setup
  // Plan sec 6 / sec 10 item 2: Tier 1 = Plant & Central, Tier 2 = Primary Air, Tier 3 = Zone.
  // FCU = Tier 3 (locked decision). EF = Tier 3 auxiliary (locked decision).
  var TIER_GROUPS = [
    { label: 'Tier 1 — Plant & Central Equipment', cats: ['chwp', 'hwp', 'ct'] },
    { label: 'Tier 2 — Primary Air Systems', cats: ['ahu', 'doas', 'furnace'] },
    { label: 'Tier 3 — Zone Terminals', cats: ['vav', 'fpb', 'ddvav', 'zone', 'fcu', 'heater', 'ef'] },
  ];

  var _flatCatOrder = [];
  TIER_GROUPS.forEach(function (tg) {
    tg.cats.forEach(function (c) {
      _flatCatOrder.push(c);
    });
  });

  var sortedEquip = b.equipResults.slice().sort(function (a, b2) {
    var ai = _flatCatOrder.indexOf(a.category);
    var bi2 = _flatCatOrder.indexOf(b2.category);
    if (ai === -1) ai = 99;
    if (bi2 === -1) bi2 = 99;
    if (ai !== bi2) return ai - bi2;
    return (a.name || '').localeCompare(b2.name || '');
  });

  // Compute building-level totals for summary line (last chunk only) — priced-scope
  // (fix/per-building-sensor-reconcile, 2026-07-29), same _a36CatRows source as
  // _pushCatSummaryRow below. Summed across EVERY category for this building, INCLUDING the
  // building-wide oat/oaWetBulb dedup rows (category==='building'), so this total reconciles
  // exactly to (sum of every per-category row below) + (the Building-Wide row, when present) —
  // never an invisible number.
  var totalSensorsNeeded = 0;
  var totalSeqsNotReady = 0;
  _a36CatRows.forEach(function (r) {
    if (r.building !== b.name) return;
    if (r.phase === 1 && !r.ioOnly) totalSensorsNeeded += r.qty || 0;
    else if (r.phase === 2 && r.seqKey) totalSeqsNotReady += r.qty || 0;
  });

  // Table header HTML (reused on every chunk)
  // Change 2 (2026-06-16): 4-column summary table — one row per equipment type.
  // 2026-07-12 fix (item ac1d9bac): Sensors to Install / Sequences to Program cells were
  // wrapping 3-5 lines at the old 27%/27% widths. Equipment Type (short category labels,
  // longest is "Fan-Powered Terminals") and Units (a bare integer) both had large unused
  // width margins, so that slack was moved to the two content columns instead (36/10/27/27
  // -> 24/6/34/36). Text itself is NOT truncated/nowrap-ellipsis'd — _topBreakdown already
  // caps each cell at top-3 items + "+N more" (see _pushCatSummaryRow) so no data is hidden
  // by this change, it just gives the existing text more room per line. colgroup +
  // table-layout:fixed added so these percentages are deterministic instead of
  // browser auto-layout (which could otherwise let content push columns around).
  // U2 (2026-08-02, fix/u2-print-page-budget). Same defect as the Building ASHRAE 36 Readiness
  // table's header, same cause: the 2026-07-12 split above was fitted against a 10px (7.5pt
  // printed) header, and the 10pt printed-text floor raises every th to 13.34px. "UNITS" is a
  // single unbreakable word and its 6% column was sized for "a bare integer", so at the floor the
  // header word overflowed its cell — 31 checkOverflow hits in an all-sections-on Audit render.
  // (This section is opt-in and OFF in the client Audit, which is why it did not appear in the
  // shipped PDFs; it would have appeared the first time anyone enabled Per-Building Detail.)
  // Measured in a print-media DOM probe at 13.34px: table 720px, th horizontal padding 16px.
  //   Units       inner 27.1 vs "Units" 41.7      -> FAILED by 14.6px; 9% gives inner 48.8, +7.1
  //   Equipment   inner 156.5 vs "Equipment" 84.5 -> ample, untouched
  //   Sensors     inner 228.5 vs "Sensors" 64.5   -> untouched
  //   Sequences   inner 242.9 vs "Sequences" 85.2 -> gives up the 3%, still 221.6 inner. Its
  //               content is a wrapping list already capped at top-3 + "+N more", so it wraps
  //               slightly more rather than losing anything.
  var colWidths = { equip: 24, units: 9, sensors: 34, seqs: 33 };
  var colgroup =
    '<colgroup>' +
    '<col style="width:' +
    colWidths.equip +
    '%">' +
    '<col style="width:' +
    colWidths.units +
    '%">' +
    '<col style="width:' +
    colWidths.sensors +
    '%">' +
    '<col style="width:' +
    colWidths.seqs +
    '%">' +
    '</colgroup>';
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header, matching the
  // Proposal's plain/thin-bordered convention. Styling only.
  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;' +
    'border:1px solid var(--rpt-border)';
  var tableHead =
    colgroup +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    '">Equipment Type</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Units</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sensors to Install</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sequences to Program</th>' +
    '</tr></thead>';

  // Build flat token list.
  // Each token: { type: 'tier'|'cat'|'row', html: string }
  // Every token (header or data row) counts as 1 slot against the page budget.
  var _catsWithRows = {};
  sortedEquip.forEach(function (eq) {
    _catsWithRows[eq.category] = true;
  });

  var _coveredCats = {};
  TIER_GROUPS.forEach(function (tg) {
    tg.cats.forEach(function (c) {
      _coveredCats[c] = true;
    });
  });

  var tokens = [];

  function _pushEquipRow(eq) {
    var mp = eq.compliance.missingPoints || [];
    var sr = eq.seqReadiness || {};
    var presentCount = (eq.compliance.coveredPoints || []).length;
    var missingNames = mp.map(_missingPointName);
    var sensorsNeededCell =
      mp.length === 0
        ? '<span style="color:var(--rpt-green)">None</span>'
        : '<strong>' + mp.length + '</strong> &mdash; ' + missingNames.join(', ');
    var notReadySeqs = [];
    for (var sk in sr) {
      if (sr.hasOwnProperty(sk) && (sr[sk].status === 'blocked' || sr[sk].status === 'partial')) {
        notReadySeqs.push(_seqLabel(sk, sr[sk]));
      }
    }
    // Display-label rename (item ed465b3c, 2026-07-09): "Ready" -> "Fully Covered" -> (rename
    // #2, Matt's decision, supersedes v647) "Fully Compliant".
    var seqsCell =
      notReadySeqs.length === 0
        ? '<span style="color:var(--rpt-green)">Fully Compliant</span>'
        : notReadySeqs.join(', ');
    // 2026-07-10 fix: --rpt-rule (#d9dde3) is barely visible on a client deliverable —
    // use the near-black --rpt-border token for row separators instead. Scoped to this
    // Per-Building Detail table only (not a global --rpt-rule change, which also backs
    // several stat-card fills elsewhere in the report).
    var rowBorder = 'border:1px solid var(--rpt-border)';
    var tdBase = 'padding:4px 8px;font-size:10px;vertical-align:top;' + rowBorder;

    // Pixel-height estimate for this row (used by chunk pagination below).
    // "Sensors Needed" column is ~200px wide, "Sequences" ~180px wide.
    // U2 / RC-A (2026-08-02): the chars-per-line figures were 30 and 28, derived when this cell
    // text rendered at 10px. The 10pt printed-text floor puts it at 13.34px in the same-width
    // columns, so BOTH the characters that fit on a line and the height of each line change:
    // chars scale by 10/13.34 (30 -> 22, 28 -> 21) and the line box goes 15px -> _rptTextLineH().
    // Leaving the old numbers made every multi-line row under-count by roughly a third, which
    // pushed the Per-Building Detail pages past the footer band once the floor was applied.
    var PBD_SENSOR_CPL = 22; // was 30 at 10px; same 200px column at the 13.34px floor
    var PBD_SEQ_CPL = 21; // was 28 at 10px; same 180px column at the 13.34px floor
    var PBD_ROW_PAD_H = 12; // measured: a 1-line row is 31px = one 20px line box + 11px of padding/borders
    var sensorsText = mp.length === 0 ? '' : missingNames.join(', ');
    var seqsText = notReadySeqs.join(', ');
    var sensorLines = mp.length === 0 ? 1 : Math.max(1, Math.ceil(sensorsText.length / PBD_SENSOR_CPL));
    var seqLines = notReadySeqs.length === 0 ? 1 : Math.max(1, Math.ceil(seqsText.length / PBD_SEQ_CPL));
    var rowEstH = PBD_ROW_PAD_H + Math.max(sensorLines, seqLines) * _rptTextLineH(1.5);

    tokens.push({
      type: 'row',
      estH: rowEstH,
      html:
        '<tr>' +
        '<td style="' +
        tdBase +
        ';font-weight:600;color:var(--rpt-page-text)">' +
        (eq.name || '—') +
        '</td>' +
        '<td style="' +
        tdBase +
        ';color:var(--rpt-page-text)">' +
        (eq.categoryLabel || eq.category) +
        '</td>' +
        '<td style="' +
        tdBase +
        ';text-align:center;color:var(--rpt-page-text)">' +
        presentCount +
        '</td>' +
        '<td style="' +
        tdBase +
        ';color:var(--rpt-page-text);line-height:1.5">' +
        sensorsNeededCell +
        '</td>' +
        '<td style="' +
        tdBase +
        ';color:var(--rpt-page-text);line-height:1.5">' +
        seqsCell +
        '</td>' +
        '</tr>',
    });
  }

  // Change 2 (2026-06-16): helper — push ONE summary row per category (replaces per-unit rows).
  // fix/per-building-sensor-reconcile (2026-07-29): sensorsSum/seqsSum/mpFreq/sqFreq now come
  // from the PRICED catalog (_a36CatRows, see this function's header comment above) instead of
  // the raw eq.compliance.missingPoints/eq.seqReadiness accumulators — see that comment for the
  // full rationale and the 255-raw-vs-4-priced NC ADC VAV measurement. hasApplicableSeq and
  // rawSensorsSum stay RAW on purpose: hasApplicableSeq answers "was G36 ever checked against
  // this category" (an audit fact, not a cost), and rawSensorsSum exists only to distinguish
  // "0 priced because genuinely compliant" from "0 priced because every raw gap here is
  // monitoring-only-zone/ioOnly and never entered the priced scope" in the sensorsCell branch
  // below.
  function _pushCatSummaryRow(cat, catRows) {
    var unitCount = catRows.length;
    var hasApplicableSeq = false;
    var rawSensorsSum = 0;
    catRows.forEach(function (eq) {
      rawSensorsSum += (eq.compliance.missingPoints || []).length;
      var sr = eq.seqReadiness || {};
      for (var sk in sr) {
        if (sr.hasOwnProperty(sk) && sr[sk].status !== 'na') hasApplicableSeq = true;
      }
    });

    // Priced sums for THIS building + THIS category. Sensors = phase-1, non-ioOnly rows (same
    // buildCatalogRows-derived definition 2cd25a7 uses on the cover page). Sequences = phase-2
    // rows carrying a seqKey (excludes buildSensorInvestigationRows' phase-2 labor rows, which
    // are a service-scope finding, not a G36 sequence — see that function's own "must not reach
    // the audit report" guardrail comment, pricing-estimator.js), with qty attributed to this
    // category via categoryQty (a seqKey can span multiple zone categories at once, e.g. vav_dcv
    // applies to vav/fpb/ddvav — categoryQty is the per-category split of that row's qty, added
    // specifically for this reconciliation).
    var sensorsSum = 0;
    var seqsSum = 0;
    var mpFreq = {};
    var sqFreq = {};
    _a36CatRows.forEach(function (r) {
      if (r.building !== b.name) return;
      if (r.phase === 1 && !r.ioOnly && r.category === cat) {
        sensorsSum += r.qty || 0;
        mpFreq[r.item] = (mpFreq[r.item] || 0) + (r.qty || 0);
      } else if (r.phase === 2 && r.seqKey) {
        var _catQty = (r.categoryQty && r.categoryQty[cat]) || 0;
        if (_catQty > 0) {
          seqsSum += _catQty;
          sqFreq[r.item] = (sqFreq[r.item] || 0) + _catQty;
        }
      }
    });

    // Build top-3 breakdown string for a frequency map
    function _topBreakdown(freq, total) {
      if (total === 0) return '';
      var pairs = Object.keys(freq).map(function (k) {
        return { label: k, count: freq[k] };
      });
      pairs.sort(function (a, b2) {
        return b2.count - a.count;
      });
      var top = pairs.slice(0, 3);
      var rest = pairs.length - top.length;
      var parts = top.map(function (p) {
        return p.count + ' - ' + p.label;
      });
      if (rest > 0) parts.push('+' + rest + ' more');
      return parts.join(', ');
    }

    var sensorsBreakdown = _topBreakdown(mpFreq, sensorsSum);
    var seqsBreakdown = _topBreakdown(sqFreq, seqsSum);

    // 2026-07-29 fix (per-building-sensor-reconcile): a category can have raw gaps (points the
    // audit found missing) that are ALL monitoring-only-zone/ioOnly and so never enter the
    // priced scope — "0 — Complete" would falsely read as a compliance pass in that case. Only
    // use "Complete" when the raw scan found nothing to begin with.
    var sensorsCell =
      sensorsSum === 0
        ? rawSensorsSum === 0
          ? '0: Complete'
          : '0: No Priced Hardware'
        : sensorsBreakdown
          ? sensorsSum + ': ' + sensorsBreakdown
          : String(sensorsSum);
    // Display-label rename (item ed465b3c, 2026-07-09): "Ready" -> "Fully Covered" -> (rename
    // #2, Matt's decision, supersedes v647) "Fully Compliant".
    // 2026-07-10 fix (audit-report-na-rationale, wording-decision.md item 2): a category with
    // ZERO applicable sequences (hasApplicableSeq false -- e.g. furnaces, heaters, zone
    // terminals, which Guideline 36 has no published sequence for) was showing the identical
    // "0 — Fully Compliant" text as a category that was genuinely assessed and found ready.
    // That falsely implies a verified pass. Neutral wording per Matt's decision; does not
    // touch seqsSum or the assessed-category branches below (byte-identical for real gaps and
    // genuine passes).
    var seqsCell = !hasApplicableSeq
      ? 'No Applicable Sequences'
      : seqsSum === 0
        ? '0: Fully Compliant'
        : seqsBreakdown
          ? seqsSum + ': ' + seqsBreakdown
          : String(seqsSum);

    // 2026-07-10 fix: near-black --rpt-border, same reasoning as _pushEquipRow's rowBorder above.
    var tdBase = 'padding:5px 8px;font-size:10px;vertical-align:middle;border:1px solid var(--rpt-border)';
    tokens.push({
      type: 'row',
      // U2 (2026-08-02): 34/26 -> 48/36. These were single/double-line estimates for 10px cell
      // text; at the 10pt printed-text floor the same cells render at 13.34px and their
      // breakdown strings ("12 - Zone Temperature Sensor, 3 - ...") wrap further. Scaled by the
      // floor ratio and re-verified by headless print render of the Per-Building Detail section
      // with every optional Audit section switched on.
      estH: sensorsSum > 0 || seqsSum > 0 ? 48 : 36,
      html:
        '<tr>' +
        '<td style="' +
        tdBase +
        ';font-weight:600;color:var(--rpt-page-text)">' +
        (CAT_LABELS_PLURAL[cat] || cat) +
        '</td>' +
        '<td style="' +
        tdBase +
        ';text-align:center;color:var(--rpt-page-text)">' +
        unitCount +
        '</td>' +
        '<td style="' +
        tdBase +
        ';color:var(--rpt-page-text);font-weight:400">' +
        sensorsCell +
        '</td>' +
        '<td style="' +
        tdBase +
        ';color:var(--rpt-page-text);font-weight:400">' +
        seqsCell +
        '</td>' +
        '</tr>',
    });
  }

  // Flat table: iterate tier order for stable sort, push summary rows without tier headers.
  // Tier labels are intentionally omitted — the user wants a plain flat list sorted
  // plant-first then zone-terminals last, with no Tier 1/2/3 section banners.
  TIER_GROUPS.forEach(function (tg) {
    tg.cats.forEach(function (cat) {
      var catRows = sortedEquip.filter(function (eq) {
        return eq.category === cat;
      });
      if (!catRows.length) return;
      _pushCatSummaryRow(cat, catRows);
    });
  });

  // Catch-through: uncovered categories (no tier header — flat list continues)
  var uncoveredRows = sortedEquip.filter(function (eq) {
    return !_coveredCats[eq.category];
  });
  if (uncoveredRows.length) {
    var _lastUncovCat = null;
    uncoveredRows.forEach(function (eq) {
      if (eq.category !== _lastUncovCat) {
        _lastUncovCat = eq.category;
        // Push a summary row for this uncovered category
        var _uncovCatRows = uncoveredRows.filter(function (u) {
          return u.category === eq.category;
        });
        _pushCatSummaryRow(eq.category, _uncovCatRows);
      }
    });
  }

  // Building-Wide priced row (fix/per-building-sensor-reconcile, 2026-07-29): oat/oaWetBulb
  // dedup to ONE sensor per building regardless of how many pieces of equipment are missing it
  // (buildCatalogRows, pricing-estimator.js ~line 2683/2699) — these attribute to
  // category==='building', not any single equipment category, so they never match a per-category
  // row above and would otherwise be an invisible number (priced but never shown). Surfaced here
  // explicitly so (sum of every category row above) + (this row, when present) reconciles exactly
  // to the "Total for <building>" row below. Rare — 8 of these exist portfolio-wide across 27
  // buildings (2026-07-29 measurement), so this stays a single compact row, not its own table.
  var _bldgWideRows = _a36CatRows.filter(function (r) {
    return r.building === b.name && r.phase === 1 && !r.ioOnly && r.category === 'building';
  });
  if (_bldgWideRows.length) {
    var _bwSum = 0;
    var _bwFreq = {};
    _bldgWideRows.forEach(function (r) {
      _bwSum += r.qty || 0;
      _bwFreq[r.item] = (_bwFreq[r.item] || 0) + (r.qty || 0);
    });
    var _bwBreakdown = Object.keys(_bwFreq)
      .map(function (k) {
        return _bwFreq[k] + ' - ' + k;
      })
      .join(', ');
    var _bwTdBase = 'padding:5px 8px;font-size:10px;vertical-align:middle;border:1px solid var(--rpt-border)';
    tokens.push({
      type: 'row',
      // U2 (2026-08-02): 34 -> 48, same reasoning as the category summary row above.
      estH: 48,
      html:
        '<tr>' +
        '<td style="' +
        _bwTdBase +
        ';font-weight:600;color:var(--rpt-page-text)">Building-Wide (Outdoor Air)</td>' +
        '<td style="' +
        _bwTdBase +
        ';text-align:center;color:var(--rpt-page-text)">1</td>' +
        '<td style="' +
        _bwTdBase +
        ';color:var(--rpt-page-text);font-weight:400">' +
        _bwSum +
        ': ' +
        _bwBreakdown +
        '</td>' +
        '<td style="' +
        _bwTdBase +
        ';color:var(--rpt-page-text);font-weight:400">No Applicable Sequences</td>' +
        '</tr>',
    });
  }

  // Empty state
  if (!tokens.length) {
    tokens.push({
      type: 'row',
      html: '<tr><td colspan="4" style="padding:8px;font-size:10px;color:var(--rpt-page-text)">No auditable equipment found for this building.</td></tr>',
    });
  }

  // Total row (last chunk only) — a real <tfoot> row inside the equipment table
  // (2026-07-10 fix), not a free-standing div with its own border-top. Matt's rule:
  // rules only as part of a table's structure, never free-floating. Mirrors the
  // canonical totals-row treatment (.rpt-table tr.rpt-tot td: border-top 2px solid
  // --rpt-table-tot-bdr, background --rpt-table-tot-bg) inlined here since this
  // table doesn't carry the .rpt-table class.
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the shaded total-row fill
  // (background:var(--rpt-table-tot-bg)), matching the Proposal's convention of no shaded rows
  // -- the bold text + top rule alone already signal "this is the total." Styling only.
  var summaryRowHtml =
    '<tfoot><tr>' +
    '<td colspan="4" style="padding:6px 8px;font-size:11px;color:var(--rpt-page-text);' +
    'border-top:2px solid var(--rpt-table-tot-bdr)">' +
    '<strong>Total for ' +
    _a36DisplayName(b) +
    ':</strong> install ' +
    rptCount(totalSensorsNeeded) +
    ' sensor' +
    (totalSensorsNeeded !== 1 ? 's' : '') +
    ', program ' +
    rptCount(totalSeqsNotReady) +
    ' sequence' +
    (totalSeqsNotReady !== 1 ? 's' : '') +
    ' across ' +
    b.equipCount +
    ' equipment unit' +
    (b.equipCount !== 1 ? 's' : '') +
    '.' +
    '</td>' +
    '</tr></tfoot>';

  // Plan sec 6 item 4 / sec 10 item 3: Infrastructure callout
  // 2026-07 design-language pass (Batch 3 item 3c): removed the rgba(0,0,0,0.02) background
  // tint (transparent, border-only per the same rule already applied to .rpt-a36-callout
  // elsewhere) and the opacity:0.6 grey "Not found in this export" text (grey text on a
  // client deliverable is banned — full black, same weight as "Installed").
  // 2026-07-06 (a0c2152): the v617 pass above still left an inline border/border-radius
  // that contradicts .rpt-a36-callout's own CSS rule (energy-department.html ~2799: "NO
  // background. NO border-left. NO border. Just spacing."). Removed — plain spacing only.
  var infraCallout =
    '<div class="rpt-a36-callout" style="margin-bottom:0;padding:8px 10px">' +
    // D-12 (2026-08-03): 10px (7.5pt printed, 10.005pt after the floor) -> the 13pt section tier.
    '<div style="font-size:' +
    RPT_SECTION_HEAD_PX +
    'px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.05em;color:var(--rpt-blue);margin-bottom:6px">Building Infrastructure (Building Automation System Export)</div>' +
    '<div style="display:flex;gap:16px">' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">' +
    '<span style="font-weight:600">Dedicated building automation system power monitoring:</span> ' +
    (b.hasPowerMonitoring
      ? '<span style="color:var(--rpt-page-text)">Installed</span>'
      : '<span style="color:var(--rpt-page-text)">Not found in this export</span>') +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">' +
    '<span style="font-weight:600">Dedicated outdoor-air sensor program:</span> ' +
    (b.hasOAConditions
      ? '<span style="color:var(--rpt-page-text)">Installed</span>'
      : '<span style="color:var(--rpt-page-text)">Not found in this export</span>') +
    '</div>' +
    '</div>' +
    '</div>';

  var intro =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px;line-height:1.6">' +
    'The table below summarizes each equipment type: the number of units audited, sensors that must be added, ' +
    'and sequences that cannot run until those sensors are installed.' +
    '</div>';

  return {
    b: b,
    fakeData: fakeData,
    gauges: gauges,
    intro: intro,
    tableHead: tableHead,
    tokens: tokens,
    summaryRowHtml: summaryRowHtml,
    infraCallout: infraCallout,
  };
}

// ─── rptPageASHRAE36Building ──────────────────────────────────────────────
/**
 * Per-building detail page: structured equipment-by-row table showing sensors
 * present, sensors needed (with human-readable names), and sequences not ready.
 * Used for a SINGLE building whose own content is too tall to share a page with
 * others (see generateASHRAE36AuditHTML's packing loop, which calls this ONLY as a
 * fallback for oversized buildings — most buildings now go through
 * _a36BuildingBlockToken instead so they can pack multiple-per-page).
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data
 * @param {object} building - Single building entry from d.buildings
 * @param {boolean} [showBuildingInfra]
 * PRE-SPLIT PAGINATION (Stage 2 fix, 2026-06-11):
 * Returns an ARRAY of rptPage() HTML strings -- one element per printed page.
 * Pixel budgets for _rptPaginateTokens (shared paginator):
 *   Page body height available = 1056px page - 12px top pad - ~45px int-hdr - 12px body-top-pad
 *     - 80px body-bottom-pad - 12px page-bottom-pad = ~895px actual
 *   First page: subtract gauges (~100px) + intro (~35px) + table thead (~30px) = 730px for rows
 *   Cont pages: subtract cont-header (~35px) + table thead (~30px) = 830px for rows
 */
function rptPageASHRAE36Building(n, d, building, showBuildingInfra) {
  // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
  // standalone literals — BUILDING_*_BASE_ADJUSTMENT constants preserve these exact numeric
  // values (904 - 174 = 730, 904 - 74 = 830), no visual/page-count change.
  // U2 / RC-A (2026-08-02): re-measured in a headless PRINT render of the JOCO Audit with EVERY
  // optional section switched on, at the 10pt printed-text floor. The old adjustments (174/74)
  // budgeted a 100px gauge strip, a 35px intro and a 30px table head; measured, the gauge strip is
  // 184px, the intro runs to ~120px on buildings with many equipment categories, the head is 31px
  // and the table's Total row is 33px. Under-reserving ~200px of chrome is why five Per-Building
  // Detail pages ran past the footer band as soon as the font floor was applied.
  var BUILDING_GAUGES_H = 190; // measured 184 (three readiness gauges + labels)
  var BUILDING_INTRO_H = 120; // measured 43-107 depending on how many equipment categories the building has
  var BUILDING_THEAD_H = 34; // measured 31
  var BUILDING_TOTAL_ROW_H = 36; // measured 33 (the table's own Total row, last chunk only)
  var BUILDING_CONT_HDR_H = 40; // "<name> (continued, N of M)" bar
  var BUILDING_SAFETY_H = 40;
  // The building-infrastructure callout is appended below the table on the LAST chunk, but was
  // never subtracted from either budget here (only _a36BuildingBlockToken's estH knew about it).
  // With the 10pt floor it measures up to ~113px, which is exactly how much four Per-Building
  // Detail pages ran past the footer band after every other constant on this page was corrected.
  // Reserved on every chunk rather than only the last one: a chunk count is not known until after
  // pagination has already run, and this section is opt-in, so the conservative reservation costs
  // nothing in the shipped client Audit.
  var BUILDING_INFRA_CALLOUT_H = showBuildingInfra ? 130 : 0; // measured up to 113
  var ROWS_BUDGET_FIRST =
    _rptContentBudget('standard') -
    BUILDING_GAUGES_H -
    BUILDING_INTRO_H -
    BUILDING_THEAD_H -
    BUILDING_TOTAL_ROW_H -
    BUILDING_INFRA_CALLOUT_H -
    BUILDING_SAFETY_H; // px available for equipment rows on page 1
  var ROWS_BUDGET_CONT =
    _rptContentBudget('standard') -
    BUILDING_CONT_HDR_H -
    BUILDING_THEAD_H -
    BUILDING_TOTAL_ROW_H -
    BUILDING_INFRA_CALLOUT_H -
    BUILDING_SAFETY_H; // px available for equipment rows on continuation pages

  var c = _a36BuildingContent(d, building, showBuildingInfra);
  var b = c.b;
  var fakeData = c.fakeData;
  var gauges = c.gauges;
  var intro = c.intro;
  var tableHead = c.tableHead;
  var tokens = c.tokens;
  var summaryRowHtml = c.summaryRowHtml;
  var infraCallout = c.infraCallout;

  // Chunk tokens into pages using the shared pixel-height paginator.
  // Replaces the old row-count loop (ROWS_PER_PAGE_FIRST/CONT) which caused overflow
  // when rows contained multi-line sensor/sequence lists.
  var chunks = _rptPaginateTokens(tokens, ROWS_BUDGET_FIRST, ROWS_BUDGET_CONT);

  // Build one rptPage() string per chunk
  var numChunks = chunks.length;
  var resultPages = [];

  chunks.forEach(function (chunk, chunkIndex) {
    var tbodyRows = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var isLastChunk = chunkIndex === numChunks - 1;
    var pageN = n + chunkIndex;

    // 2026-07-10 fix: the Total row is a real <tfoot> row inside the table (only on the
    // last chunk) instead of a free-standing div appended after the table — no
    // free-floating rule sandwiching the total.
    var equipTable =
      '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;table-layout:fixed">' +
      tableHead +
      '<tbody>' +
      tbodyRows +
      '</tbody>' +
      (isLastChunk ? summaryRowHtml : '') +
      '</table>';

    var bodyHTML;
    if (chunkIndex === 0) {
      bodyHTML = gauges + intro + equipTable;
      if (isLastChunk) {
        bodyHTML += showBuildingInfra ? infraCallout : '';
      }
    } else {
      var contHdr =
        // D-12 (2026-08-03): continuation heading -> 13pt section tier, same as the "(1 of N)"
        // heading it continues. Three sections share this exact fragment (Building ASHRAE 36
        // Readiness, Per-Building Detail, Setpoint Programming Review).
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        _a36DisplayName(b) +
        ' (continued, ' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + equipTable;
      if (isLastChunk) {
        bodyHTML += showBuildingInfra ? infraCallout : '';
      }
    }

    // 2026-07-29 fix (Matt: "why does it not say 1 of 2..."): page 1 of a multi-page building has
    // no title-suffix of its own today (the continuation's contHdr div above already reads "b.name
    // — continued (2 of 2)"). Appending the same "(N of numChunks)" fraction to the .rpt-int-hdr
    // title bar (rptPage()'s own title param, present on every page including page 1) fixes the
    // asymmetry consistently instead of only patching the continuation's already-correct text.
    var pageTitleWithFraction =
      'ASHRAE 36 Audit Report: ' +
      _a36DisplayName(b) +
      (numChunks > 1 ? ' (' + (chunkIndex + 1) + ' of ' + numChunks + ')' : '');
    resultPages.push(
      rptPage(pageN, pageTitleWithFraction, bodyHTML, {
        data: fakeData,
        label:
          'Page ' +
          pageN +
          ' — ' +
          _a36DisplayName(b) +
          (numChunks > 1 ? ' (' + (chunkIndex + 1) + '/' + numChunks + ')' : ''),
      }),
    );
  });

  return resultPages; // always an Array, even for short buildings (length === 1)
}

// ─── _a36BuildingBlockToken ────────────────────────────────────────────────
/**
 * Density fix (feat/audit-report-reframe-density, 2026-07-09), Finding 4: builds ONE
 * building's gauges+intro+table+summary as a single atomic, non-splittable HTML block with
 * an estimated pixel height, for packing multiple small buildings onto a shared page via
 * _rptPaginateTokens (mirrors the pattern rptPageASHRAE36Executive already uses for building
 * rows). Used by generateASHRAE36AuditHTML for every building whose content fits within one
 * page; buildings too tall for a single page still fall back to rptPageASHRAE36Building's own
 * dedicated multi-page treatment (unchanged).
 * @returns {{estH:number, html:string, type:'block', name:string}}
 */
function _a36BuildingBlockToken(d, building, showBuildingInfra) {
  var c = _a36BuildingContent(d, building, showBuildingInfra);
  var tbodyRows = c.tokens
    .map(function (tok) {
      return tok.html;
    })
    .join('');
  // 2026-07-10 fix: the Total row is a real <tfoot> row inside the table instead of a
  // free-standing div appended after the table — no free-floating rule above the total.
  var equipTable =
    '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;table-layout:fixed">' +
    c.tableHead +
    '<tbody>' +
    tbodyRows +
    '</tbody>' +
    c.summaryRowHtml +
    '</table>';
  var innerHTML = c.gauges + c.intro + equipTable + (showBuildingInfra ? c.infraCallout : '');
  // Block chrome: pure spacing (no border-bottom) separates one building's block from the
  // next when several share a page — 2026-07-10 fix: a free-standing rule directly under the
  // Total row violated the "rules only as part of a table's structure" rule; margin-bottom
  // alone is enough separation between blocks.
  var blockHTML = '<div style="margin-bottom:12px">' + innerHTML + '</div>';

  // estH: the same chrome constants rptPageASHRAE36Building's ROWS_BUDGET_FIRST derivation uses,
  // so the two renderers of the same building content cannot disagree about how tall it is.
  // U2 / RC-A (2026-08-02): re-measured at the 10pt printed-text floor and cross-checked against
  // two real blocks packed onto one page (JOCO Audit, all sections on): this model predicted 550px
  // and 459px against measured 550px and 459px.
  var BLOCK_GAUGES_H = 190; // measured 184
  var BLOCK_INTRO_H = 120; // measured 43-107
  var BLOCK_THEAD_H = 34; // measured 31
  var BLOCK_TOTAL_ROW_H = 36; // measured 33
  var BLOCK_INFRA_CALLOUT_H = 130; // measured up to 113 at the 10pt floor
  var BLOCK_SEPARATOR_H = 14; // this block's own margin-bottom:12px
  var rowsH = c.tokens.reduce(function (s, t) {
    return s + (t.estH || 20);
  }, 0);
  var estH =
    BLOCK_GAUGES_H +
    BLOCK_INTRO_H +
    BLOCK_THEAD_H +
    rowsH +
    BLOCK_TOTAL_ROW_H +
    (showBuildingInfra ? BLOCK_INFRA_CALLOUT_H : 0) +
    BLOCK_SEPARATOR_H;

  return { type: 'block', estH: estH, html: blockHTML, name: _a36DisplayName(c.b) };
}

// ─── rptPageASHRAE36Recommendations ──────────────────────────────────────
/**
 * Recommendations page: ranked gaps by impact, plain descriptions, next step.
 */
function rptPageASHRAE36Recommendations(n, d) {
  var p = d.portfolio;
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  var recRows = p.topGaps
    .map(function (gap, idx) {
      var desc = gap.desc || {};
      var affectedList = d.buildings
        .filter(function (b) {
          return b.allGapKeys.indexOf(gap.key) !== -1;
        })
        .map(function (b) {
          return _a36DisplayName(b);
        });
      var affectedStr =
        affectedList.length > 3
          ? affectedList.slice(0, 3).join(', ') + ' + ' + (affectedList.length - 3) + ' more'
          : affectedList.join(', ');
      return (
        '<tr>' +
        '<td style="padding:6px 8px;font-size:11px;font-weight:700;color:var(--rpt-blue);border:1px solid var(--rpt-border);vertical-align:top">' +
        (idx + 1) +
        '</td>' +
        '<td style="padding:6px 8px;border:1px solid var(--rpt-border);vertical-align:top">' +
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">' +
        (desc.short || gap.key) +
        '</div>' +
        '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
        (desc.plain || '') +
        '</div>' +
        '</td>' +
        '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border:1px solid var(--rpt-border);vertical-align:top;white-space:nowrap">' +
        (desc.impact || '—') +
        '</td>' +
        '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);vertical-align:top">' +
        gap.count +
        ' units' +
        // Batch 3 item 4: opacity:0.7 grey text removed (grey text on a client deliverable is
        // banned) — full black, matching the design-language pass elsewhere on this branch.
        (affectedStr ? '<br><span style="color:var(--rpt-page-text)">' + affectedStr + '</span>' : '') +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  // DCV row: always include if any AHUs or zones are missing CO2 sensors
  var dcv = p.dcv || {};
  var dcvMissing = (dcv.ahuMissingCO2 || 0) + (dcv.zonesMissingCO2 || 0);
  var dcvRow = '';
  if (dcvMissing > 0) {
    var dcvUnitParts = [];
    if ((dcv.ahuMissingCO2 || 0) > 0)
      dcvUnitParts.push(dcv.ahuMissingCO2 + ' air handler' + (dcv.ahuMissingCO2 > 1 ? 's' : ''));
    if ((dcv.zonesMissingCO2 || 0) > 0)
      dcvUnitParts.push(dcv.zonesMissingCO2 + ' zone' + (dcv.zonesMissingCO2 > 1 ? 's' : ''));
    var dcvUnitStr = dcvUnitParts.join(', ');
    var dcvDesc = ASHRAE36_GAP_DESCRIPTIONS['co2'] || {};
    var recCount = p.topGaps.length; // DCV row gets the next sequential number
    dcvRow =
      '<tr>' +
      '<td style="padding:6px 8px;font-size:11px;font-weight:700;color:var(--rpt-blue);border:1px solid var(--rpt-border);vertical-align:top">' +
      (recCount + 1) +
      '</td>' +
      '<td style="padding:6px 8px;border:1px solid var(--rpt-border);vertical-align:top">' +
      '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">Add carbon dioxide sensors — enable ventilation that adjusts to occupancy</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
      (dcvDesc.plain ||
        'Carbon dioxide sensors measure occupancy indirectly and allow the building automation system to reduce outdoor air intake when spaces are unoccupied. Without them, these units ventilate at full design rates around the clock.') +
      '</div>' +
      '</td>' +
      '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border:1px solid var(--rpt-border);vertical-align:top;white-space:nowrap">' +
      (dcvDesc.impact || 'Avoids conditioning air for empty rooms') +
      '</td>' +
      '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);vertical-align:top">' +
      dcvUnitStr +
      '</td>' +
      '</tr>';
  }

  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header (color:#fff on
  // background:var(--rpt-blue)); added the same thin border every data cell in this table
  // already carries (var(--rpt-border)) since removing the fill left the header with no
  // border at all. Matches the Proposal's plain/thin-bordered convention. Styling only.
  var thStyle =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)';
  var table =
    '<table style="width:100%;border-collapse:collapse;margin-bottom:12px">' +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    ';width:24px">#</th>' +
    '<th style="' +
    thStyle +
    '">Recommendation</th>' +
    '<th style="' +
    thStyle +
    '">Typical Savings</th>' +
    '<th style="' +
    thStyle +
    '">Affected Units</th>' +
    '</tr></thead>' +
    '<tbody>' +
    recRows +
    dcvRow +
    '</tbody>' +
    '</table>';

  var bodyHTML = table;
  return rptPage(n, 'ASHRAE 36 Audit Report — Recommendations', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Recommendations',
  });
}

// ─── rptPageASHRAE36SetpointReview ───────────────────────────────────────────
/**
 * Setpoint Programming Review page: compares actual zone setpoints against GL36
 * §3.1.1.1 defaults. Framed as a zero-hardware "quick win" for decision-makers.
 * Uses table-layout:fixed + colgroup so the table never clips on 8.5×11 print.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data (equipResults must have spCompliance)
 */
function rptPageASHRAE36SetpointReview(n, d) {
  // ISSUE 7 (2026-06-16): Rebuilt to show ONE row per building with AVERAGE setpoints.
  // ISSUE 6 (2026-06-16): Added _rptPaginateTokens pagination; returns Array of page strings.
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // ── Collect all zone equipment setpoint entries grouped by building ────────
  var ZONE_CATS = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
  var anyCO2InExport = false;
  // Map: buildingName → { name, zones: [{occHeat, occCool, deadband, co2, displayStatus}] }
  var bldgMap = {};
  var bldgOrder = [];

  d.buildings.forEach(function (b) {
    (b.equipResults || []).forEach(function (eq) {
      if (!ZONE_CATS[eq.category]) return;
      var sp = eq.spCompliance;
      if (!sp || (!sp.hasAnyData && !sp.hasAnyNotScheduled)) return;

      var hasUnackDeviation = sp.results.some(function (r) {
        return r.status === 'DEVIATION' && !r.intentionalFlag;
      });
      var displayStatus = hasUnackDeviation ? 'NEEDS_REVIEW' : sp.hasAnyNotScheduled ? 'NOT_SCHEDULED' : 'MATCHES';

      var occHeatEntry = sp.results.find(function (r) {
        return r.checkKey === 'occHeat';
      });
      var occCoolEntry = sp.results.find(function (r) {
        return r.checkKey === 'occCool';
      });
      var dbEntry = sp.results.find(function (r) {
        return r.checkKey === 'deadband';
      });
      var co2Entry = sp.results.find(function (r) {
        return r.checkKey === 'co2';
      });

      if (co2Entry && co2Entry.status !== 'NA') anyCO2InExport = true;

      if (!bldgMap[b.name]) {
        bldgOrder.push(b.name);
        bldgMap[b.name] = { name: b.name, zones: [] };
      }
      bldgMap[b.name].zones.push({
        displayStatus: displayStatus,
        occHeat: occHeatEntry,
        occCool: occCoolEntry,
        deadband: dbEntry,
        co2: co2Entry,
      });
    });
  });

  // ── Empty-state guard ─────────────────────────────────────────────────────
  if (bldgOrder.length === 0) {
    var emptyBody =
      '<div class="rpt-a36-callout" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6">' +
      'No zone setpoint values were found in the equipment export for this project. ' +
      'Setpoint data is present when zones trend their occupied heating and cooling setpoints. ' +
      'Import an updated equipment matrix export to enable this analysis.' +
      '</div>';
    return [
      rptPage(n, 'ASHRAE 36 Audit Report: Setpoint Programming Review', emptyBody, {
        data: fakeData,
        label: 'Page ' + n + ' — Setpoint Programming Review',
      }),
    ];
  }

  // ── Compute per-building averages ─────────────────────────────────────────
  // For each building, average actualValue across zones that have the field.
  // GL36 defaults are the same for all zones of the same category so grab the
  // first non-null value. Deviator count = zones with NEEDS_REVIEW status.
  function _mean(values) {
    if (!values.length) return null;
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  var buildingRows = bldgOrder.map(function (bName) {
    var bldg = bldgMap[bName];
    var zones = bldg.zones;
    var heatVals = [],
      coolVals = [],
      dbVals = [];
    var heatDefault = null,
      coolDefault = null;
    var deviatorCount = 0;
    var hasAnyData = false;

    zones.forEach(function (z) {
      if (z.displayStatus === 'NEEDS_REVIEW') deviatorCount++;
      if (z.occHeat && z.occHeat.actualValue !== null && z.occHeat.actualValue !== undefined) {
        heatVals.push(parseFloat(z.occHeat.actualValue));
        hasAnyData = true;
        if (heatDefault === null && z.occHeat.gl36Default !== null && z.occHeat.gl36Default !== undefined)
          heatDefault = z.occHeat.gl36Default;
      }
      if (z.occCool && z.occCool.actualValue !== null && z.occCool.actualValue !== undefined) {
        coolVals.push(parseFloat(z.occCool.actualValue));
        hasAnyData = true;
        if (coolDefault === null && z.occCool.gl36Default !== null && z.occCool.gl36Default !== undefined)
          coolDefault = z.occCool.gl36Default;
      }
      if (z.deadband && z.deadband.actualValue !== null && z.deadband.actualValue !== undefined) {
        dbVals.push(parseFloat(z.deadband.actualValue));
      }
    });

    var avgHeat = _mean(heatVals);
    var avgCool = _mean(coolVals);
    var avgDb = _mean(dbVals);

    // Building status: NEEDS_REVIEW if any zones deviate; NOT_SCHEDULED if no
    // actual data at all; MATCHES otherwise.
    var bStatus;
    if (deviatorCount > 0) {
      bStatus = 'NEEDS_REVIEW';
    } else if (!hasAnyData) {
      bStatus = 'NOT_SCHEDULED';
    } else {
      bStatus = 'MATCHES';
    }

    var deviatorLabel;
    if (deviatorCount > 0) {
      deviatorLabel = deviatorCount + ' of ' + zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ' deviate';
    } else if (!hasAnyData) {
      deviatorLabel = zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ': no setpoint data';
    } else {
      deviatorLabel = zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ' match';
    }

    return {
      name: bName,
      displayName: rptBuildingDisplayName(bName),
      avgHeat: avgHeat,
      avgCool: avgCool,
      avgDb: avgDb,
      heatDefault: heatDefault,
      coolDefault: coolDefault,
      bStatus: bStatus,
      deviatorCount: deviatorCount,
      totalZones: zones.length,
      deviatorLabel: deviatorLabel,
    };
  });

  // Sort: Needs-Review first, then Not-Scheduled, then Matches; alpha within group.
  var STATUS_ORDER_B = { NEEDS_REVIEW: 0, NOT_SCHEDULED: 1, MATCHES: 2 };
  buildingRows.sort(function (a, b2) {
    var ao = STATUS_ORDER_B[a.bStatus] !== undefined ? STATUS_ORDER_B[a.bStatus] : 99;
    var bo = STATUS_ORDER_B[b2.bStatus] !== undefined ? STATUS_ORDER_B[b2.bStatus] : 99;
    if (ao !== bo) return ao - bo;
    // R5 (2026-08-03): alpha within group on the CLIENT-VISIBLE name, matching the readiness
    // table, so no building files under an internal identifier's first letter.
    return rptBuildingNameSort(a.name, b2.name);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _fmtAvg(v) {
    if (v === null || v === undefined) return '—';
    return parseFloat(v).toFixed(1) + '°F';
  }
  function _fmtDefaultVal(v) {
    if (v === null || v === undefined) return '—';
    return parseFloat(v).toFixed(0) + '°F';
  }

  // ── Status badge ─────────────────────────────────────────────────────────
  // Batch 3 item 4 (design-language pass extended to a flagged spot, per bolding-consistency-
  // audit.md Tier 7): this was the only spot in the ASHRAE-36 report pages using hardcoded hex
  // instead of the report's own CSS variable palette. NOT_SCHEDULED has no neutral/grey token
  // in the palette and grey text is banned site-wide, so it now uses plain-black/colored text.
  // 2026-07-12 fix (items a0c2152/c121b992): the pill border+background treatment below was
  // itself a defect — report-standard rule is plain colored text for inline status, NO border,
  // NO fill. Border/background/padding/radius removed; text-only status labels.
  function _statusCell(status) {
    if (status === 'NEEDS_REVIEW') {
      return '<span style="font-size:9px;font-weight:700;color:var(--rpt-orange)">Needs Review</span>';
    } else if (status === 'NOT_SCHEDULED') {
      return '<span style="font-size:9px;font-weight:700;color:var(--rpt-page-text)">Not Scheduled</span>';
    }
    return '<span style="font-size:9px;font-weight:700;color:var(--rpt-green)">Matches</span>';
  }

  // ── Table chrome ─────────────────────────────────────────────────────────
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header, matching the
  // Proposal's plain/thin-bordered convention. Styling only.
  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;' +
    'white-space:normal;word-wrap:break-word;line-height:1.3;border:1px solid var(--rpt-border)';
  var thStyleC = thStyle + ';text-align:center';

  var tableHead =
    '<colgroup>' +
    '<col style="width:32%">' +
    '<col style="width:11%">' +
    '<col style="width:11%">' +
    '<col style="width:16%">' +
    '<col style="width:11%">' +
    '<col style="width:19%">' +
    '</colgroup>' +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    '">Building</th>' +
    '<th style="' +
    thStyleC +
    '">Avg Occ Heat</th>' +
    '<th style="' +
    thStyleC +
    '">Avg Occ Cool</th>' +
    '<th style="' +
    thStyleC +
    '">ASHRAE 36 Default<br><span style="font-size:9px;font-weight:400;text-transform:none">Heat / Cool</span></th>' +
    '<th style="' +
    thStyleC +
    '">Avg Deadband</th>' +
    '<th style="' +
    thStyleC +
    '">Status</th>' +
    '</tr></thead>';

  var tdBase = 'padding:4px 8px;font-size:10px;vertical-align:middle;border:1px solid var(--rpt-border)';
  var tdCenter = tdBase + ';text-align:center';

  // ── Build one HTML row per building ──────────────────────────────────────
  function _buildBldgRowHTML(row) {
    var gl36Heat = _fmtDefaultVal(row.heatDefault);
    var gl36Cool = _fmtDefaultVal(row.coolDefault);
    return (
      '<tr>' +
      '<td style="' +
      tdBase +
      ';font-weight:600;color:var(--rpt-page-text)">' +
      _a36DisplayName(row) +
      '</td>' +
      '<td style="' +
      tdCenter +
      ';color:var(--rpt-page-text)">' +
      _fmtAvg(row.avgHeat) +
      '</td>' +
      '<td style="' +
      tdCenter +
      ';color:var(--rpt-page-text)">' +
      _fmtAvg(row.avgCool) +
      '</td>' +
      '<td style="' +
      tdCenter +
      ';color:var(--rpt-page-text)">' +
      gl36Heat +
      ' / ' +
      gl36Cool +
      '</td>' +
      '<td style="' +
      tdCenter +
      ';color:var(--rpt-page-text)">' +
      _fmtAvg(row.avgDb) +
      '</td>' +
      '<td style="' +
      tdCenter +
      '">' +
      _statusCell(row.bStatus) +
      ' <span style="font-size:9px;color:var(--rpt-page-text)">' +
      row.deviatorLabel +
      '</span>' +
      '</td>' +
      '</tr>'
    );
  }

  // ── Totals callout ────────────────────────────────────────────────────────
  var needsReviewTotal = buildingRows.filter(function (r) {
    return r.bStatus === 'NEEDS_REVIEW';
  }).length;
  var matchesTotal = buildingRows.filter(function (r) {
    return r.bStatus === 'MATCHES';
  }).length;
  var notScheduledTotal = buildingRows.filter(function (r) {
    return r.bStatus === 'NOT_SCHEDULED';
  }).length;
  var summaryParts = [buildingRows.length + ' building' + (buildingRows.length !== 1 ? 's' : '')];
  if (needsReviewTotal > 0) summaryParts.push(needsReviewTotal + ' Needs Review');
  if (notScheduledTotal > 0) summaryParts.push(notScheduledTotal + ' Not Scheduled');
  if (matchesTotal > 0) summaryParts.push(matchesTotal + ' match ASHRAE 36 defaults');

  var totalsCallout =
    '<div style="font-size:10px;color:var(--rpt-page-text);margin-bottom:8px">' +
    summaryParts.join(' &nbsp;|&nbsp; ') +
    '</div>';

  // ── CO2 note ──────────────────────────────────────────────────────────────
  var co2Note = '';
  if (!anyCO2InExport) {
    co2Note =
      // 2026-07-12 fix (items a0c2152/c121b992): border-top removed — .rpt-a36-callout is
      // documented as "NO background. NO border-left. NO border. Just spacing." (see its CSS
      // comment); this inline border-top violated that rule.
      '<div class="rpt-a36-callout" style="margin-top:10px">' +
      '<div style="font-size:10px;font-weight:700;color:var(--rpt-blue);margin-bottom:3px">Carbon Dioxide Setpoint Data Not Found in Export</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6">' +
      'Carbon dioxide setpoints for occupancy-based ventilation (ASHRAE 36 §3.1.1.3 / Table 3.1.1.3) were not present in the equipment matrix export for this project. ' +
      'Carbon dioxide setpoint values are programmed set-points in the building automation system controller, separate from the live carbon dioxide sensor readings shown in the equipment matrix. ' +
      'A direct building automation system lookup or updated export with carbon dioxide setpoint points is needed to complete this check.' +
      '</div>' +
      '</div>';
  }

  // ── Zone-equipment exclusion footnote (c041f1c7) ────────────────────────
  var _totalScoredBuildings = d.buildings.length;
  var _excludedCount = _totalScoredBuildings - bldgOrder.length;
  var exclusionNote = '';
  if (_excludedCount > 0) {
    exclusionNote =
      '<div class="rpt-a36-callout" style="margin-top:10px">' +
      '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6">' +
      'Only buildings with zone-level terminal equipment (variable air volume boxes, fan-powered boxes, fan coil units, and similar) are shown. These are the units ASHRAE 36’s zone setpoint standards apply to. ' +
      _excludedCount +
      ' of ' +
      _totalScoredBuildings +
      ' buildings are not included here because their heating and cooling equipment (rooftop units, heaters, exhaust fans, and similar) has no separate zone-level setpoints to review.' +
      '</div>' +
      '</div>';
  }

  // ── Preamble ──────────────────────────────────────────────────────────────
  var preamble =
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:10px">' +
    'ASHRAE 36 §3.1.1.1 and Table 3.1.1.1 define default occupied and unoccupied temperature setpoints for three zone types. ' +
    'These are starting points. Designer overrides are explicitly permitted and may be intentional for specific spaces. ' +
    'Items marked Needs Review should be confirmed with the design engineer or facility staff to determine whether the deviation is intentional. ' +
    'Values shown are building averages across all zone equipment in the building automation system export.' +
    '</div>';

  // ── Pagination (Issue 6 + Fix B correction 2026-06-18) ───────────────────
  // DOM-measured heights (JOCO headless run 2026-06-18):
  //   preamble actual=70px (budget had 60 — underestimate)
  //   totalsCallout: not present / negligible
  //   thead actual=36px (budget had 32)
  //   First page chrome total: 70 + 36 + 30(safety) = 136px consumed
  //   row budget = 894 - 136 = 758px
  // Continuation page:
  //   contHdr ~35px + thead 36px + 20(safety) = 91px → 894 - 91 = 803px
  // Each building row actual avg = 44px; estH raised to 46px for safety
  // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
  // standalone literals — SETPOINT_*_BASE_ADJUSTMENT constants preserve these exact numeric
  // values (904 - 146 = 758, 904 - 101 = 803), no visual/page-count change.
  // U2 / RC-A (2026-08-02): re-measured at the 10pt printed-text floor (headless print render,
  // JOCO Audit with every optional section on). Preamble 70px -> 107px, table head 36px -> 63px
  // (the six column headers now wrap), rows 44px -> 49px, or 69px where the Status cell needs a
  // third line. The row estimate below is the measured MAXIMUM rather than an average: this
  // table's rows are near-uniform, so a max-based estimate costs almost no density and cannot
  // overflow.
  var SETPOINT_PREAMBLE_H = 127; // measured 107 preamble + the 20px caption block below it
  var SETPOINT_THEAD_H = 63; // measured
  var SETPOINT_CONT_HDR_H = 40;
  var SETPOINT_SAFETY_H = 40;
  var SETPOINT_ROW_H = 70; // measured 49 typical, 69 max (3-line Status cell)
  var ROWS_BUDGET_FIRST = _rptContentBudget('standard') - SETPOINT_PREAMBLE_H - SETPOINT_THEAD_H - SETPOINT_SAFETY_H;
  var ROWS_BUDGET_CONT = _rptContentBudget('standard') - SETPOINT_CONT_HDR_H - SETPOINT_THEAD_H - SETPOINT_SAFETY_H;

  var tokens = buildingRows.map(function (row) {
    return { type: 'row', estH: SETPOINT_ROW_H, html: _buildBldgRowHTML(row) };
  });

  var chunks = _rptPaginateTokens(tokens, ROWS_BUDGET_FIRST, ROWS_BUDGET_CONT);
  var numChunks = chunks.length;
  var resultPages = [];

  chunks.forEach(function (chunk, chunkIndex) {
    var tbodyRows = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var table =
      '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;table-layout:fixed">' +
      tableHead +
      '<tbody>' +
      tbodyRows +
      '</tbody>' +
      '</table>';

    var pageN = n + chunkIndex;
    var bodyHTML;
    if (chunkIndex === 0) {
      bodyHTML = preamble + totalsCallout + table + (chunkIndex === numChunks - 1 ? co2Note + exclusionNote : '');
    } else {
      var contHdr =
        // D-12 (2026-08-03): continuation heading -> 13pt section tier, same as the "(1 of N)"
        // heading it continues. Three sections share this exact fragment (Building ASHRAE 36
        // Readiness, Per-Building Detail, Setpoint Programming Review).
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        'Setpoint Programming Review (continued, ' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + table + (chunkIndex === numChunks - 1 ? co2Note + exclusionNote : '');
    }

    // 2026-07-29 fix (same "(1 of N) missing on page 1" asymmetry as Building ASHRAE 36
    // Readiness/Per-Building Detail above): append the fraction to the .rpt-int-hdr title bar so
    // page 1 carries its own "(1 of N)" alongside the continuation's existing "(N of N)".
    var _setpointTitle =
      'ASHRAE 36 Audit Report: Setpoint Programming Review' +
      (numChunks > 1 ? ' (' + (chunkIndex + 1) + ' of ' + numChunks + ')' : '');
    resultPages.push(
      rptPage(pageN, _setpointTitle, bodyHTML, {
        data: fakeData,
        label:
          'Page ' +
          pageN +
          ' — Setpoint Programming Review' +
          (numChunks > 1 ? ' (' + (chunkIndex + 1) + '/' + numChunks + ')' : ''),
      }),
    );
  });

  return resultPages; // always an Array (length >= 1)
}

// ─── rptPageASHRAE36ProposalCover ─────────────────────────────────────────
/**
 * Proposal cover page with table of contents.
 */
// ─── _rptA36CoverPricingStrip ─────────────────────────────────────────────
/**
 * Compact 3-tier price-comparison summary for the ASHRAE-36 Proposal cover page
 * (Matt's decision: "summary comparison on the cover only; full detailed table stays
 * inside"). Reuses the SAME totals source as the full Cost Estimate table
 * (rptPageASHRAE36ProposalPricing, ~line 13990) via _pricingGetEstimate /
 * _pricingComputeSummaryData — never recomputes independently, so this strip can never
 * disagree with the inner table. Returns '' if pricing data is unavailable.
 *
 * Caller gates this on the costEstimate section flag (see generateASHRAE36ProposalHTML)
 * so client PDFs with dollars hidden (costEstimate defaults OFF) never show a summary here.
 */
function _rptA36CoverPricingStrip(d) {
  var tt = null;
  try {
    if (typeof _pricingGetEstimate === 'function' && typeof _pricingComputeSummaryData === 'function') {
      var estimateState = _pricingGetEstimate(d.project.id);
      var summaryData = _pricingComputeSummaryData(d.project.id, estimateState);
      tt = summaryData && summaryData.tierTotals ? summaryData.tierTotals : null;
    }
  } catch (e) {
    tt = null;
  }
  if (!tt) return '';

  function _fmtUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return null;
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  // 2026-07-22 redesign (no-boxes-in-reports standard): tiers stacked vertically as plain
  // heading + paragraph, not side-by-side cards. Same 3 tiers / keys / order as
  // rptPageASHRAE36ProposalPricing's tierCols — numbers still come ONLY from the shared
  // _pricingGetEstimate/_pricingComputeSummaryData chain above, no new pricing math.
  var tierDefs = [
    {
      key: 'recommended',
      label: 'Recommended',
      isRec: true,
      desc: function (amtStr, svcSentence) {
        return (
          'Installs the hardware points needed to close ASHRAE 36 gaps and programs the full set of ' +
          'cost-optimized energy sequences: supply air and duct pressure reset, economizer control, optimal ' +
          'start/stop, and equipment lead/lag rotation. ' +
          (amtStr ? 'The estimated cost for this scope is <strong>' + amtStr + '</strong>. ' : '') +
          svcSentence +
          'Because these sequences directly target the largest controllable heating and cooling energy uses ' +
          '(fan speed, mechanical cooling run time, and equipment cycling), this tier is expected to return the most energy ' +
          'savings per dollar spent of the three scopes.'
        );
      },
    },
    {
      key: 'compliance',
      label: 'Compliance',
      isRec: false,
      desc: function (amtStr, svcSentence) {
        return (
          'Installs only the hardware points required to close ASHRAE 36 gaps and programs the sequences ' +
          'classified as safety-critical (e.g. freeze protection, minimum ventilation). It does not add the ' +
          'optimization sequences (temperature/pressure reset, economizer, optimal start) that generate ongoing ' +
          'energy savings. ' +
          (amtStr ? 'The estimated cost for this scope is <strong>' + amtStr + '</strong>. ' : '') +
          svcSentence +
          'This tier establishes monitoring and code-required control only, making it the right starting point ' +
          'where budget is the primary constraint. The Recommended or Full Scope sequences can be added in a ' +
          'later phase under the same service agreement once budget allows.'
        );
      },
    },
    {
      key: 'full-scope',
      label: 'Full Scope',
      isRec: false,
      desc: function (amtStr, svcSentence) {
        return (
          'Builds out every applicable ASHRAE 36 sequence across every piece of equipment in the portfolio ' +
          'and adds building-wide automatic fault detection and diagnostics reporting; hardware is priced at ' +
          'full/standard spec rather than the Recommended tier’s cost-optimized substitutions. ' +
          (amtStr ? 'The estimated cost for this scope is <strong>' + amtStr + '</strong>. ' : '') +
          svcSentence +
          'This is the highest-cost of the three tiers, but it delivers full-portfolio coverage ' +
          'and the earliest access to automatic fault alerts, so equipment problems that waste energy or shorten ' +
          'equipment life are caught automatically instead of during periodic manual review.'
        );
      },
    },
  ];

  var anyPriced = tierDefs.some(function (t) {
    return tt[t.key] && _fmtUSD(tt[t.key].grand);
  });
  if (!anyPriced) return '';

  // Monthly Energy Management Service Agreement sentence — SAME guarded budget/config chain
  // rptPageASHRAE36ProposalPricing's svcBlock uses (en_pricing_budget_{projId}.amount,
  // en_pricing_config.hourlyRate). No new math: identical read, so a project with no configured
  // monthly allowance simply omits this sentence rather than showing a fabricated number.
  var svcSentence = '';
  try {
    if (typeof _pricingGetBudget === 'function' && typeof _pricingGetConfig === 'function') {
      var _svcBudget = _pricingGetBudget(d.project.id);
      var _svcCfg = _pricingGetConfig();
      if (_svcBudget && _svcBudget.amount != null && !isNaN(_svcBudget.amount) && Number(_svcBudget.amount) > 0) {
        var _svcRate =
          _svcCfg.hourlyRate || (typeof COST_LABOR_RATE_DEFAULT !== 'undefined' ? COST_LABOR_RATE_DEFAULT : 125);
        svcSentence =
          'Ongoing programming refinement and support draws on your existing Monthly Energy ' +
          'Management Service Agreement (' +
          _fmtUSD(Number(_svcBudget.amount)) +
          '/month allowance at $' +
          _svcRate +
          '/hr, not-to-exceed) rather than a separate invoice. ';
      }
    }
  } catch (e) {
    svcSentence = '';
  }

  var rows = tierDefs
    .map(function (t) {
      var g = tt[t.key] ? _fmtUSD(tt[t.key].grand) : null;
      var noCat = tt[t.key] && tt[t.key].noCatalog;
      var amtStr = g ? (noCat ? 'Labor: ' + g : g) : null;
      var headline =
        t.label + (t.isRec ? ' (Recommended)' : '') + (amtStr ? ': ' + amtStr : ': Available upon request');
      return (
        '<div style="margin-bottom:12px">' +
        // D-12 (2026-08-03): tier headline -> the 13pt section tier; the description directly
        // beneath it is 14px/10.5pt body, so at 11px this heading printed smaller than its own text.
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:700;color:var(--rpt-page-text);border-bottom:2px solid var(--rpt-rule);' +
        'padding-bottom:3px;margin-bottom:5px">' +
        _esc(headline) +
        '</div>' +
        '<div style="font-size:14px;color:var(--rpt-page-text);line-height:1.6">' +
        t.desc(amtStr, svcSentence) +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div style="margin-bottom:8px">' +
    '<div style="font-size:10px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;' +
    'letter-spacing:0.04em;margin-bottom:8px">Cost Summary</div>' +
    rows +
    '</div>'
  );
}

/**
 * _rptA36AssessmentFindingsData — pulls the client-facing pricing totals the Assessment Findings
 * section needs: the Compliance tier grand total (instrumentation + safety programming — the
 * mandatory first stage) and the Full Scope tier grand total (the complete Guideline 36 scope,
 * i.e. the ONE compliance total the client sees). Same _pricingGetEstimate /
 * _pricingComputeSummaryData chain every other pricing-derived number in this file uses — no new
 * pricing math. Returns fmt strings/raw numbers or null (never $0/NaN/undefined) so callers can
 * omit gracefully.
 *
 * 2026-07-27 (client review — "the page 1 above for my eyes still says the supply air temp, DCV
 * and similar sequences in ASHRAE 36?"): page 1 previously presented complianceFmt/fullScopeFmt
 * as two competing "levels" a client could choose between. That's wrong — instrumentation with no
 * sequences programmed is a prerequisite, not an alternative. Added `complianceGrand`/
 * `fullScopeGrand` (the raw numbers, not just the formatted strings) plus a third value,
 * `remainderFmt`/`remainderGrand` — the optimization-sequences-and-FDD portion — computed as
 * `fullScopeGrand - complianceGrand` from these SAME two live totals (never a separately-derived
 * or hardcoded figure), so the three numbers the proposal shows always reconcile by construction.
 * Guarded against a negative/NaN result (would indicate a pricing-data inconsistency upstream) —
 * `remainderFmt`/`remainderGrand` stay null rather than ever displaying a wrong number.
 */
function _rptA36AssessmentFindingsData(d) {
  var out = {
    complianceFmt: null,
    fullScopeFmt: null,
    remainderFmt: null,
    complianceGrand: null,
    fullScopeGrand: null,
    remainderGrand: null,
  };
  try {
    if (typeof _pricingGetEstimate === 'function' && typeof _pricingComputeSummaryData === 'function') {
      var estimateState = _pricingGetEstimate(d.project.id);
      var summaryData = _pricingComputeSummaryData(d.project.id, estimateState);
      var tt = summaryData && summaryData.tierTotals ? summaryData.tierTotals : null;
      function _fmtUSD(v) {
        if (v === null || v === undefined || isNaN(v)) return null;
        return '$' + Math.round(v).toLocaleString('en-US');
      }
      if (tt && tt.compliance && tt.compliance.grand != null && !isNaN(tt.compliance.grand)) {
        out.complianceGrand = Number(tt.compliance.grand);
        out.complianceFmt = _fmtUSD(out.complianceGrand);
      }
      if (tt && tt['full-scope'] && tt['full-scope'].grand != null && !isNaN(tt['full-scope'].grand)) {
        out.fullScopeGrand = Number(tt['full-scope'].grand);
        out.fullScopeFmt = _fmtUSD(out.fullScopeGrand);
      }
      if (out.complianceGrand != null && out.fullScopeGrand != null) {
        var remainder = out.fullScopeGrand - out.complianceGrand;
        if (!isNaN(remainder) && remainder >= 0) {
          out.remainderGrand = remainder;
          out.remainderFmt = _fmtUSD(remainder);
        }
      }
    }
  } catch (e) {
    /* leave everything null — caller renders the graceful fallback */
  }
  return out;
}

// US state full names + 2-letter postal abbreviations. Used ONLY by
// _rptProposalDisplayClientName below to recognize a trailing ", <State>" suffix on a stored
// client name. This is an explicit allow-list match, NOT a bare "split on the last comma" —
// a client legitimately named "Smith, Jones & Co." must render untouched. If you're tempted to
// simplify this later, re-read AI/_context/specs/joco-service-proposal-target-2026-07-23.md
// first: a bare comma-split is exactly the shortcut that would break that case.
var _RPT_US_STATE_NAMES = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
  'District of Columbia',
];
var _RPT_US_STATE_ABBR = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
];
var _RPT_US_STATE_NAME_SET = {};
_RPT_US_STATE_NAMES.forEach(function (s) {
  _RPT_US_STATE_NAME_SET[s.toLowerCase()] = true;
});
var _RPT_US_STATE_ABBR_SET = {};
_RPT_US_STATE_ABBR.forEach(function (s) {
  _RPT_US_STATE_ABBR_SET[s.toUpperCase()] = true;
});

/**
 * _rptProposalDisplayClientName — Service-Proposal-only prose display name. Strips a trailing
 * ", <US state>" suffix (full name OR 2-letter abbreviation, matched against the explicit lists
 * above) from a stored client name, e.g. "Johnson County, Kansas" -> "Johnson County". Does NOT
 * touch the stored project/client name anywhere else — this is purely a rendering choice for the
 * handful of mid-sentence prose lines in the Proposal (title, Executive Summary, Recommended
 * Energy Management Services, Long-Term Program Vision) that read awkwardly with the full legal name
 * inline. Falls back to the original string unchanged whenever the suffix after the last comma
 * is NOT a recognized state (e.g. "Smith, Jones & Co." stays untouched) or when there's no comma
 * at all. See joco-service-proposal-target-2026-07-23.md for the audit that found this bug.
 */
function _rptProposalDisplayClientName(fullName) {
  var name = String(fullName == null ? '' : fullName).trim();
  if (!name) return name;
  var lastComma = name.lastIndexOf(',');
  if (lastComma === -1) return name;
  var prefix = name.slice(0, lastComma).trim();
  var suffix = name.slice(lastComma + 1).trim();
  if (!prefix || !suffix) return name;
  var isState =
    _RPT_US_STATE_NAME_SET[suffix.toLowerCase()] === true || _RPT_US_STATE_ABBR_SET[suffix.toUpperCase()] === true;
  return isState ? prefix : name;
}

/**
 * rptPageASHRAE36ProposalCover — Page 1 of the rebuilt Service Proposal (2026-07-26 rebuild,
 * spec: AI/_context/specs/joco-service-proposal-target-2026-07-23.md). Matches Matt's hand-built
 * Word target page 1: Title block, Executive Summary, Assessment Findings (narrative paragraph
 * stating both dollar figures in prose + Matt's requested "what's included" clarification — Word
 * comment "Clarify what is included" on the Full Energy Scope of Work row), Recommended
 * Energy Management Services (paragraph + monthly allowance + 6 bullets), Why This Approach (5
 * bullets). Plain headings/tables only — zero shaded/filled bands, zero boxes/cards (hard
 * constraint, w:shd fill count = 0 in the target .docx). hero:true keeps the CSC letterhead.
 * 2026-07-29 (Matt: "all reports should always have page numbers"): this page (and every other
 * Proposal page) no longer passes noPageNum:true — page numbers now render here exactly like
 * every other report type.
 *
 * 2026-07-27: the 2-row "Assessment Findings Program Option / Estimated Cost" table that used to
 * sit between the narrative paragraph and the "what's included" paragraphs was removed at the
 * client's explicit direction ("Yes, remove the full table."). The narrative paragraph above still
 * states both dollar figures in prose and still draws them from _rptA36AssessmentFindingsData(d),
 * which remains the sole source for those two numbers on this page.
 *
 * The old 3-tier "Cost Summary" strip (_rptA36CoverPricingStrip) is NOT called from here
 * anymore — the target has no such block; it pivots straight from the findings narrative to the
 * monthly allowance. _rptA36CoverPricingStrip itself is left intact (unused) rather than deleted,
 * per the "do not destroy existing capability" constraint.
 *
 * 2026-07-27 (second pass, client review of the removed-table layout): "Page 1 makes no sense
 * from a readers standpoint... wildly different numbers and there is a ton of white space...
 * explain what each one gets you... put it in ROI terms." The Assessment Findings section was
 * rewritten so a reader who reads only its first paragraph understands both the scope and the
 * monthly-cost mechanism, followed by stacked (never side-by-side, never boxed) per-stage
 * explanations, then an ROI paragraph in Recommended Energy Management Services grounded in
 * _pricingComputeProgramCostModel (pricing-estimator.js) tying the monthly figure to the phased
 * program total.
 *
 * 2026-07-27 (THIRD pass, same day — client caught a second, more fundamental framing error):
 * "the page 1 above for my eyes still says the supply air temp, DCV and similar sequences in
 * ASHRAE 36? ... describing that level by the list of Guideline 36 sequences it fails to include
 * is backwards." The second pass above had already renamed the mislabeled tier but still
 * presented the two pricing totals as competing "levels" a client could choose between, and still
 * described the first by what it excludes. Both were wrong — instrumentation with no sequences
 * programmed is a prerequisite, not an alternative, and Guideline 36's optimization sequences are
 * not omissions from a package, they ARE Guideline 36. Reframed a third time as ONE compliance
 * total (af.fullScopeFmt) with a mandatory first stage (af.complianceFmt) and a completion stage
 * (af.remainderFmt, computed live as fullScopeGrand − complianceGrand in
 * _rptA36AssessmentFindingsData so the three figures always reconcile) — see the tierBlocks
 * comment inside the function body for the corrected stage-sequence framing.
 */
function rptPageASHRAE36ProposalCover(n, d) {
  var p = d.portfolio;
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  // Prose-only display name (e.g. "Johnson County, Kansas" -> "Johnson County") — see
  // _rptProposalDisplayClientName above. d.project.name (the stored client/project name) itself
  // is untouched; only the mid-sentence renders on this page use the shortened form.
  var displayClient = _rptProposalDisplayClientName(d.project.name);

  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }

  // Density pass (2026-07-26, page-1 clip fix): tightened from 12/5 margin, 1.55 line-height to
  // fit all 5 "Why This Approach" bullets above the wave footer without shrinking type past a
  // readable floor — see dashboardlogic.md 2026-07-26 entry for the before/after px-past-footer
  // measurements this was tuned against. NOTE (2026-07-28): BODY/UL below were bumped from
  // font-size:10.5px (rendered ~8.04pt in Word, a px/pt unit bug) to the correct font-size:14px
  // (=10.5pt) per the CSC Letterhead.docx spec — this pagination density tuning was measured
  // against the SMALLER pre-fix size and had not been re-verified at 14px.
  //
  // 2026-07-29 (re-verified at 14px, fix/report-typography-and-pagination-merge): headless
  // re-measurement against real JOCO data found this page 159.7px past the 1056px design height
  // with "Why This Approach" still on it. Moving that section to rptPageASHRAE36ProposalPhaseTable
  // (see that function + rptPageASHRAE36ProposalCover's own header comment) closed most of the
  // gap; the remaining ~35px is closed here by tightening HEAD margin (7/3 -> 5/2) and
  // BODY/UL line-height (1.38 -> 1.32, still above the 1.2x-ish "unreadably tight" floor the
  // 2026-07-26 comment above was written against and well above the original bug's ~8pt-equivalent
  // density) — spacing only, font-size untouched at 12px/14px. Re-measured after: 0px overflow
  // (see dashboardlogic.md 2026-07-29 entry for before/after numbers).
  // D-12 (2026-08-03): 12px (9pt printed, 10.005pt after the floor) -> the 13pt section tier.
  // This constant styles the Proposal's top-level section headings ("Executive Summary",
  // "Assessment Findings", "Recommended Energy Management Services", ...), every one of which
  // was measured printing SMALLER than the 10.5pt body text directly beneath it.
  var HEAD = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:5px 0 2px';
  var BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.32';
  var UL = 'margin:2px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.32';

  // ── Title block ─────────────────────────────────────────────────────────
  var title =
    '<div style="text-align:center;margin-bottom:6px">' +
    // D-12 (2026-08-03): 19px (14.25pt) -> the 18pt document-title tier, matching the Audit
    // cover. The second line (the programme line) goes 16px -> 19px (12pt -> 14.25pt) with it:
    // at 12pt it would have printed SMALLER than the 13pt "Executive Summary" heading further
    // down this same page, which is the same parent-smaller-than-child inversion being fixed.
    // Result on the cover: title 18pt > programme line 14.25pt > section headings 13pt > body
    // 10.5pt, with the "Service Proposal" kicker left where it is (a deliberate small-caps
    // eyebrow, already at the legal 10pt floor, not a heading over any body text).
    '<div style="font-size:' +
    RPT_DOC_TITLE_PX +
    'px;font-weight:700;color:var(--rpt-blue)">' +
    esc(displayClient) +
    ' Building Automation System</div>' +
    '<div style="font-size:19px;font-weight:700;color:var(--rpt-blue)">ASHRAE 36 Energy Management Services</div>' +
    // Document-type identifier (2026-07-29) -- the cover previously never said "Service
    // Proposal" anywhere, while the interior Cost Estimate headers and the modal/PDF filename
    // all call it that. Subordinate to both title lines above: smaller than the 16px program
    // line, lighter weight (600 vs 700), and var(--rpt-page-text) (near-black body-text token,
    // #000000) instead of var(--rpt-blue) so the hierarchy reads client -> program -> document
    // type without competing with either title line. Uppercase + letter-spacing follows this
    // file's own existing section-label convention (see "Portfolio Metrics" label ~line 1906:
    // font-size:11px; text-transform:uppercase; letter-spacing:0.5px) rather than introducing a
    // new pattern.
    '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px">Service Proposal</div>' +
    // 2026-08-03 (visual review V-25): the Proposal carried no date at all — its only date-like
    // strings were the "Aug 2026"-"Dec 2026" schedule column labels, so the quoted monthly figure
    // sat on an undated page. Same source as the export filename (_rptDocumentDateLong), so the
    // two can never disagree.
    '<div style="font-size:14px;color:var(--rpt-page-text);margin-top:3px">' +
    _rptDocumentDateLong() +
    '</div>' +
    '</div>';

  // ── Executive Summary ───────────────────────────────────────────────────
  var execSummary =
    '<div style="' +
    HEAD +
    '">Executive Summary</div>' +
    '<div style="' +
    BODY +
    '">Control Service Company completed an ASHRAE 36 readiness assessment across the ' +
    esc(displayClient) +
    ' building portfolio. The assessment identified an overall readiness score of ' +
    p.composite +
    '% across ' +
    rptCount(p.totalBuildings) +
    ' buildings and ' +
    rptCount(p.totalEquip) +
    ' equipment units. The assessment found significant opportunities to improve heating and cooling ' +
    'energy performance, ventilation control, occupant comfort, and overall building automation system ' +
    'operational consistency through targeted controls upgrades and optimization strategies.</div>';

  // ── Assessment Findings ─────────────────────────────────────────────────
  // 2026-07-27 (client review — page 1 redesign, verbatim: "Like those are wildly different
  // numbers and there is a ton of white space. Why not use all of that white space and explain
  // what each one gets you... Explain it as if they read that 1 paragraph they could understand
  // what the scope of work is and how the monthly cost works. Put it in ROI terms also."):
  // findingsPara below is the single-paragraph comprehension bar he set — it states the total
  // figure AND ties it to the monthly-allowance mechanism in one pass, so a reader who reads only
  // this paragraph already understands the scope and the funding model.
  //
  // 2026-07-27 SAME-DAY REVISION (second client pass, verbatim): "the page 1 above for my eyes
  // still says the supply air temp, DCV and similar sequences in ASHRAE 36? ... describing that
  // level by the list of Guideline 36 sequences it fails to include is backwards. Supply air
  // temperature reset, duct static pressure reset, demand-controlled ventilation, economizer
  // control and fault detection are not omissions from a package — they ARE Guideline 36."
  // The prior version of this section presented complianceFmt/fullScopeFmt as two competing
  // "levels" a client could pick between, and described the first by the sequences it excludes.
  // Both were wrong: instrumentation with no sequences programmed is a PREREQUISITE, not an
  // alternative, and there is nothing to "exclude" once the copy describes one total with a
  // first stage, not a menu. Reframed as ONE compliance total (af.fullScopeFmt) with its
  // mandatory first stage broken out (af.complianceFmt), and the remaining stage
  // (af.remainderFmt) computed live as fullScopeGrand - complianceGrand inside
  // _rptA36AssessmentFindingsData — never a separately-derived or hardcoded number, so the three
  // figures always reconcile by construction.
  // 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's approved spec — verbatim: "We do not
  // want to anchor a fixed total cost or timeline at all to them anywhere in anything we give
  // them for a monthly agreement. That is the whole point. Just have the Service Proposal talk
  // about what it would cost to get to ASHRAE 36 compliance and what that entails."): the prior
  // paragraph stated af.fullScopeFmt/af.complianceFmt/af.remainderFmt — whole-scope dollar totals
  // derived from _rptA36AssessmentFindingsData — deleted, not merely reworded, per that
  // instruction. This paragraph now describes WHAT reaching compliance entails (the two
  // categories of work, in sequence) using only the measured assessment facts already stated in
  // execSummary above (readiness score, building count, equipment count) — no capital total
  // anywhere on this page. _rptA36AssessmentFindingsData itself is left defined (unused) per this
  // file's "do not destroy existing capability" convention. A reader who wants more scope detail
  // than this one paragraph can enable the two new opt-in sections below (ASHRAE36_SECTIONS.proposal
  // 'complianceScope' / 'fullScope', rendered by rptPageASHRAE36ProposalComplianceScope /
  // ...FullScope near rptPageASHRAE36ProposalScope) — both still with no dollar total.
  var findingsPara =
    'Reaching full ASHRAE 36 compliance across the ' +
    esc(displayClient) +
    ' portfolio requires two categories of work, in sequence. The first is the instrumentation ' +
    'and safety programming every ASHRAE 36 sequence depends on (sensors, actuators, and ' +
    'safety-critical programming such as freeze protection), which must be in place before any ' +
    'optimization sequence can be programmed. The second is the ASHRAE 36 optimization ' +
    'sequences themselves, together with portfolio-wide automatic fault detection and diagnostics ' +
    'reporting: the work that delivers the energy, comfort, and compliance outcomes this service ' +
    'is built around. Rather than fund this as a single capital project, Control Service Company ' +
    'recommends delivering it through the Recommended Energy Management Services described below, a ' +
    'monthly service allowance that funds continuous, staged progress toward full compliance over ' +
    'time.';

  // Stage 1 / Stage 2 dollar-anchored blocks DELETED 2026-07-29 (fix/proposal-remove-fixed-
  // anchors) per Matt's approved spec above — headings, figures, and body paragraphs all removed,
  // not renamed and not kept minus the number. The same two categories of work are now covered at
  // the prose level in findingsPara above, and in full opt-in detail (still with no dollar total)
  // in the "ASHRAE 36 Compliance" / "Full Scope" sections a user can enable via the report modal.

  var assessmentFindings =
    '<div style="' + HEAD + '">Assessment Findings</div>' + '<div style="' + BODY + '">' + findingsPara + '</div>';

  // 2026-08-02 (fix/docx-proposal-pagination-orphans): "Recommended Energy Management Services" +
  // its 6-bullet list MOVED OFF this page onto its own page, rptPageASHRAE36ProposalRecommendedServicesCover
  // (below) -- this function now returns ONLY title/execSummary/assessmentFindings. Reason: the
  // 07-29 density pass above (and the 07-26 pass before it) both tuned this page's spacing to
  // "0px overflow" measured against the BROWSER PREVIEW (Chromium) render only. A real Word
  // export/render round-trip (verify-docx-proposal-merge, 2026-08-02) found the live 27-building
  // JOCO portfolio's real content actually needs the page's DESIGN height PLUS ~76px more than a
  // single physical Word page provides -- only 2 of the 6 "Recommended Energy Management Services"
  // bullets fit before Word's own pagination kicked in, orphaning the remaining 4 alone on an
  // otherwise-blank page 2. Root cause: Word's real per-line metrics for this Arial-rendered body
  // text do not match Chromium's -- e.g. the real Word bottom page margin measured from the
  // exported docx's own <w:pgMar> is 1872 twips (93.6pt/124.8px), well above the 72px --rpt-ftr-h
  // this budget was tuned against -- so a page tuned to "exactly fit" in Chromium can never
  // reliably fit in Word; any exact-fit tuning is fragile by construction and will keep breaking
  // as project data (building/equipment counts -> paragraph line-wrap counts) changes. Splitting
  // into two purpose-sized pages (this one; rptPageASHRAE36ProposalRecommendedServicesCover) removes the
  // exact-fit dependency entirely rather than re-tuning it a third time. Content is preserved
  // verbatim -- nothing shortened or removed, only relocated, same as the "Why This Approach"
  // move this same page's history already documents above.
  var bodyHTML = '<div style="padding:4px 48px 2px">' + title + execSummary + assessmentFindings + '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: true,
    data: fakeData,
    label: 'Page ' + n + ' — Proposal Summary',
  });
}

/**
 * rptPageASHRAE36ProposalRecommendedServicesCover -- "Recommended Energy Management Services"
 * heading, intro paragraph, monthly allowance line, and 6-bullet scope list. Extracted from
 * rptPageASHRAE36ProposalCover 2026-08-02 (fix/docx-proposal-pagination-orphans) -- see that
 * function's header comment for the real-Word-render measurement this split is based on.
 * hero:false/hideIntHdr:true matches every other page-2+ Proposal page (rptPageASHRAE36Proposal-
 * PhaseTable etc.) -- full CSC logo stays page-1-only, this page gets the plain wave footer band.
 */
function rptPageASHRAE36ProposalRecommendedServicesCover(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var displayClient = _rptProposalDisplayClientName(d.project.name);

  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }

  // D-12 (2026-08-03): 12px (9pt printed, 10.005pt after the floor) -> the 13pt section tier.
  // This constant styles the Proposal's top-level section headings ("Executive Summary",
  // "Assessment Findings", "Recommended Energy Management Services", ...), every one of which
  // was measured printing SMALLER than the 10.5pt body text directly beneath it.
  var HEAD = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:5px 0 2px';
  var BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.32';
  var UL = 'margin:2px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.32';

  // ── Recommended Energy Management Services (first heading) ───────────────────
  var budgetFmt = null;
  try {
    if (typeof _pricingGetBudget === 'function') {
      var _b = _pricingGetBudget(d.project.id);
      if (_b && _b.amount != null && !isNaN(_b.amount) && Number(_b.amount) > 0) {
        budgetFmt = '$' + Math.round(Number(_b.amount)).toLocaleString('en-US');
      }
    }
  } catch (e) {
    budgetFmt = null;
  }

  var monthlyAllowanceBlock = budgetFmt
    ? '<div style="' +
      BODY +
      ';font-weight:700;margin-top:5px">Monthly Allowance for the following: Parts, materials, ' +
      'and on-site labor hours</div>' +
      '<div style="' +
      BODY +
      '">' +
      budgetFmt +
      ' per Month</div>'
    : '';

  // 2026-07-29 (fix/proposal-remove-fixed-anchors): programCostModel/programTotalFmt/
  // programRangeFmt/programMonths DELETED. This paragraph used to state the phased-rollout dollar
  // total, month count, and Aug 2026 – Dec 2028-style date range computed from
  // _pricingComputeProgramCostModel (pricing-estimator.js). Matt's approved spec (quoted in the
  // Assessment Findings comment above) forbids anchoring a fixed total cost or timeline anywhere in
  // this document; the paragraph below states only the $6,250/month allowance mechanism, never a
  // total or an end date. _pricingComputeProgramCostModel itself is untouched — app/pricing-
  // estimator.js is out of scope for this change per the plan, and the function still has its own
  // other caller(s) inside that file.
  var recIntro;
  if (budgetFmt) {
    recIntro =
      'Rather than pursuing this scope of work as a single capital project, Control Service ' +
      'Company recommends a phased Energy Management Services approach funded through a predictable monthly ' +
      'service allowance of ' +
      budgetFmt +
      ' per month, implementing the highest-return measures first (see the phased schedule on the ' +
      'following page) while also covering ongoing energy management labor from the same monthly ' +
      'figure. Each phase is fully funded as it is completed, so ' +
      esc(displayClient) +
      ' is never asked to approve a large capital expenditure up front, and the allowance ' +
      'continues for as long as improvement opportunities remain. This turns a large one-time ' +
      'expense into a manageable, ongoing operating cost.';
  } else {
    recIntro =
      'Rather than pursuing a large one-time capital project, Control Service Company recommends a ' +
      'phased Energy Management Services approach focused on the highest-value opportunities first. This approach ' +
      'allows ' +
      esc(displayClient) +
      ' to improve building performance using a predictable monthly budget while continuously ' +
      'expanding optimization efforts over time.';
  }

  var recProgram1 =
    '<div style="' +
    HEAD +
    '">Recommended Energy Management Services</div>' +
    '<div style="' +
    BODY +
    '">' +
    recIntro +
    '</div>' +
    monthlyAllowanceBlock +
    '<ul style="' +
    UL +
    ';margin-top:4px">' +
    '<li>Ventilation that adjusts to occupancy</li>' +
    '<li>Supply air temperature optimization</li>' +
    '<li>Fan energy optimization</li>' +
    '<li>Supporting sensor infrastructure upgrades</li>' +
    '<li>Building automation system programming</li>' +
    '<li>Continuous operational improvement</li>' +
    '</ul>';

  // 2026-08-02 (fix/docx-proposal-pagination-orphans): this content used to be appended to
  // rptPageASHRAE36ProposalCover's title+execSummary+assessmentFindings on ONE page (see that
  // function's header comment for why it was split out) — now it is this standalone page's
  // entire body. hero:false/hideIntHdr:true (not hero:true) — this is a page-2+ Proposal page,
  // so it gets the plain wave footer band, not the full CSC letterhead logo.
  var bodyHTML = '<div style="padding:8px 48px 4px">' + recProgram1 + '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: false,
    hideIntHdr: true,
    data: fakeData,
    label: 'Page ' + n + ' — Recommended Energy Management Services',
  });
}

/**
 * _rptA36WhyThisApproachHTML — "Why This Approach" bullet list. Extracted from
 * rptPageASHRAE36ProposalCover (2026-07-29, see that function's header comment) so it can render
 * on rptPageASHRAE36ProposalPhaseTable instead, where there is spare room after the phase/vision
 * merge was reverted (see generateASHRAE36ProposalHTML). Content unchanged from the original
 * inline block — HEAD/UL styles come from the caller (same vars used throughout this file's ASHRAE
 * 36 Proposal pages).
 */
function _rptA36WhyThisApproachHTML(HEAD, UL) {
  return (
    '<div style="' +
    HEAD +
    '">Why This Approach</div>' +
    '<ul style="' +
    UL +
    '">' +
    '<li>Addresses the highest-priority opportunities identified during the assessment.</li>' +
    '<li>Improves comfort, ventilation, and energy performance.</li>' +
    '<li>Avoids the need for a large capital expenditure.</li>' +
    '<li>Allows implementation to align with budget planning cycles.</li>' +
    '<li>Creates a sustainable long-term optimization strategy.</li>' +
    '</ul>'
  );
}

/**
 * rptPageASHRAE36ProposalPhaseTable — Page 2 of the rebuilt Service Proposal. Matches the target's
 * second "Recommended Energy Management Services" heading + paragraph, then the transposed phase table
 * (rows = Included Improvements / Expected Results, columns = Phase 1/2/3). A third row,
 * "Facilities Included" (building names per phase, LIVE-DERIVED from
 * _pricingComputeRecommendedTimeline), was removed 2026-07-29 (Matt, verbatim: "why would you
 * put continues in phase x for every building? That is redundant... let's just remove the
 * buildings completely from that phase table since all buildings are included.") — see the
 * removal comment in _rptA36PhaseTableInnerHTML. Included Improvements and Expected Results
 * (2026-07-29 rewrite, Matt's own phase framing — see the PHASE_IMPROVEMENTS/EXPECTED_RESULTS
 * header comment in _rptA36PhaseTableInnerHTML) are fixed, generic phase-position narrative
 * (foundation -> expansion -> completion) that names no client-specific fact, matching the
 * target's own wording verbatim.
 * Returns '' content gracefully (a single "not yet available" page) if no priced timeline exists
 * yet for this project (i.e. pricing hasn't been configured) rather than showing empty cells.
 */
/**
 * _rptA36PhaseImprovementsText — "Included Improvements" bucket categorization (live-derived from
 * a phase's own priced rows — never hardcoded per-phase text). Buckets mirror the same measure
 * families the Executive Summary/Recommended-Program bullets already name (DCV, supply air
 * temperature optimization, fan energy optimization, sensor infrastructure, BAS programming).
 * Extracted 2026-07-27 (Matt's monthly-framing correction) so BOTH the Phase Table page
 * (rptPageASHRAE36ProposalPhaseTable) and the Cost Estimate page's phase timeline
 * (_rptA36RecommendedTimelineHTML) describe each phase's work with the SAME derivation — no
 * separate hardcoded copy that could drift between the two tables.
 * STALE as of 2026-08-02 (fix/costest-wording-and-rounding): neither caller uses this function's
 * OUTPUT for its primary text anymore — the Phase Table page was rebuilt 2026-07-31 to name literal
 * per-unit sequences (_rptA36PhaseTableDerive's unitRows) and _rptA36RecommendedTimelineHTML was
 * switched the same day as this comment to _rptA36PhaseSeqCategoryNames (also literal sequence
 * names) after the two tables were found to describe the identical priced rows in two unrelated
 * vocabularies (bucketed generic phrases here vs. literal names there) — see that call site's
 * comment. This function is left intact, unremoved, as a defensive fallback only (a phase with rows
 * but no phase===2 seqKey row, which should not occur for real term data). Do not add a new caller
 * expecting it to match either table's live wording — it no longer does.
 */
// Plain-language rewrite (no-abbreviations pass, 2026-07-31): dcv/bas VALUES were 'DCV
// sensors and programming'/'BAS programming' -- both opaque acronyms. Object property NAMES
// (dcv/sat/sensor/fan/bas) are matched by _rptA36PhaseImprovementsText below and are UNCHANGED.
var _RPT_A36_PHASE_VERBS = [
  {
    dcv: 'occupancy-based ventilation sensors and programming',
    sat: 'supply air temperature optimization',
    sensor: 'supporting sensor infrastructure upgrades',
    fan: 'fan energy optimization',
    bas: 'building automation system programming',
  },
  {
    dcv: 'expanded occupancy-based ventilation deployments',
    sat: 'expanded supply air temperature optimization',
    sensor: 'additional sensor deployments',
    fan: 'fan energy optimization',
    bas: 'building automation system programming',
  },
  {
    dcv: 'final occupancy-based ventilation sensor deployment',
    sat: 'remaining supply air temperature optimization',
    sensor: 'remaining sensor deployment',
    fan: 'remaining fan optimization',
    bas: 'ongoing building automation system programming',
  },
];
var _RPT_A36_DCV_SEQ = { demandCtrl: true, vav_dcv: true };
var _RPT_A36_FAN_SEQ = { ahu_dsp_reset: true, ahu_rf_control: true };

function _rptA36PhaseImprovementsText(rows, idx) {
  rows = rows || [];
  var verbs = _RPT_A36_PHASE_VERBS[idx] || _RPT_A36_PHASE_VERBS[0];
  var hasDCV = false,
    hasSAT = false,
    hasFan = false,
    hasSensor = false,
    hasBAS = false;
  rows.forEach(function (r) {
    if (r.phase === 1) {
      hasSensor = true;
      if (r._pointKey === 'co2') hasDCV = true;
    } else if (r.phase === 2) {
      hasBAS = true;
      if (r.seqKey && _RPT_A36_DCV_SEQ[r.seqKey]) hasDCV = true;
      else if (r.seqKey === 'ahu_sat_reset') hasSAT = true;
      else if (r.seqKey && _RPT_A36_FAN_SEQ[r.seqKey]) hasFan = true;
    }
  });
  var parts = [];
  if (hasDCV) parts.push(verbs.dcv);
  if (hasSAT) parts.push(verbs.sat);
  if (hasSensor) parts.push(verbs.sensor);
  if (hasFan) parts.push(verbs.fan);
  if (hasBAS) parts.push(verbs.bas);
  if (!parts.length) return 'Continued optimization of previously implemented measures.';
  var sentence = parts.join('; ') + '.';
  // Capitalization fix (fix/65ce578b, 2026-07-27): _RPT_A36_PHASE_VERBS' Phase 2/3 entries are
  // lowercase mid-sentence fragments (e.g. 'expanded DCV deployments', 'final DCV sensor
  // deployment') meant to be joined with others, but whichever bucket flag fires FIRST (in the
  // fixed dcv/sat/sensor/fan/bas check order above) becomes the sentence's actual first word --
  // for JOCO's real data that's almost always the dcv bucket, rendering "expanded DCV..."/"final
  // DCV..." lowercase at the start of the Phase 2/3 "Included Improvements" cell. Capitalizing
  // here (on the assembled sentence, not a hardcoded bucket string) fixes the first word
  // regardless of which bucket ends up first, so it can never regress if the bucket order above
  // changes later.
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// PRICING_PROPOSAL_TERM_PHASE_COUNT (2026-07-29, replacing PRICING_PROPOSAL_MAX_PHASES=3):
// _pricingComputeRecommendedTimeline's schedule is indefinite (today: 19 calendar phases, Aug
// 2026 -> Dec 2044). The OLD PRICING_PROPOSAL_MAX_PHASES=3 constant was independently re-applied
// via `tl.phases.slice(0, 3)` at three separate render sites (Phase Table page, Implementation
// Plan schedule, Cost Estimate page's Phased Implementation Schedule) — three independent slices
// that could silently disagree, and which rendered phases 1-3 while saying nothing anywhere about
// phases 4-19 (silent truncation; ~$96,032 of a much larger total shown, the rest invisible).
// Matt, verbatim (2026-07-29): "Would it be better to have the phases really just be the months
// through 2026 and then have a future section where it lists all of the future work?" / "Do it as
// months and then give me the ability to see the future work in the table or as a standalone
// section." This constant is now how many of the timeline's leading phases count as "the current
// term" shown to the client as calendar months — today that's exactly 1 (Phase 1, the fixed
// Aug-Dec 2026 program start defined in `_pricingPhaseDateRangeAt(0)`, pricing-estimator.js — NOT
// edited by this change). Every phase after the term is Future Work — see
// _pricingProposalTermAndFuture below, the ONE place phases are now split, so the term view and
// the Future Work population can never drift apart again.
var PRICING_PROPOSAL_TERM_PHASE_COUNT = 1;

/**
 * _pricingProposalTermAndFuture(projId) — THE single derivation of {tl, termPhases, futurePhases}
 * every Proposal-facing phase render site must use (replaces the three independent
 * `tl.phases.slice(0, PRICING_PROPOSAL_MAX_PHASES)` call sites this constant's own comment
 * describes). termPhases = the current PRICING_PROPOSAL_TERM_PHASE_COUNT leading phases (today:
 * just Phase 1, Aug-Dec 2026); futurePhases = every phase after that (today: 18 phases, 2027 ->
 * 2044). futurePhases carries the SAME row objects as the internal Cost Estimate tab's indefinite
 * timeline — including dollar fields (measuresTotal, allowanceTotal, ...) — this function does NOT
 * strip them; every Future Work render site must read ONLY category names
 * (_rptA36PhaseSeqCategoryNames) from futurePhases[i].rows, never a dollar field, to hold the
 * "Future Work carries zero dollars" rule.
 */
function _pricingProposalTermAndFuture(projId) {
  var tl = null;
  try {
    if (typeof _pricingComputeRecommendedTimeline === 'function') tl = _pricingComputeRecommendedTimeline(projId);
  } catch (e) {
    tl = null;
  }
  if (!tl || !tl.phases || !tl.phases.length) return { tl: tl, termPhases: [], futurePhases: [] };
  return {
    tl: tl,
    termPhases: tl.phases.slice(0, PRICING_PROPOSAL_TERM_PHASE_COUNT),
    futurePhases: tl.phases.slice(PRICING_PROPOSAL_TERM_PHASE_COUNT),
  };
}

/**
 * _pricingProposalTermMonthLabels(termPhases) — derives calendar month labels (e.g. "Aug 2026")
 * for the current term, from `_pricingPhaseDateRangeAt` + `_PRICING_MONTH_ABBR`
 * (pricing-estimator.js's own existing config/constants — read here, never re-typed as a new date
 * literal in this file, per the de-anchor spec's "no hardcoded calendar dates" rule).
 * KNOWN TENSION (flagged, not silently resolved — see this change's dashboardlogic.md entry): the
 * 2026-07-29 de-anchor pass (fix/proposal-remove-fixed-anchors, Matt: "We do not want to anchor a
 * fixed total cost or timeline at all to them anywhere") deliberately removed calendar-date
 * columns from these same render sites. Matt's later, more specific months instruction
 * reintroduces a timeline reference (named calendar months for the current 5-month term only —
 * still no dollar figure and no date beyond the term itself). Implemented as asked because it is
 * the later, more specific instruction; flagged here so it can be swapped for unanchored
 * "Month 1..N" labels with a one-line change (replace this function's return value) if Matt
 * prefers that instead.
 */
function _pricingProposalTermMonthLabels(termPhases) {
  var labels = [];
  if (typeof _pricingPhaseDateRangeAt !== 'function' || typeof _PRICING_MONTH_ABBR === 'undefined') return labels;
  (termPhases || []).forEach(function (p, idx) {
    var def = _pricingPhaseDateRangeAt(idx);
    if (!def || !def.start) return;
    var sy = def.start[0],
      sm = def.start[1];
    var count = p.months || 0;
    for (var i = 0; i < count; i++) {
      var totalM = sm - 1 + i;
      var yy = sy + Math.floor(totalM / 12);
      var mm = totalM % 12;
      labels.push(_PRICING_MONTH_ABBR[mm] + ' ' + yy);
    }
  });
  return labels;
}

/**
 * _rptA36PhaseSeqCategoryNames — client-readable names of every distinct priced sequence category
 * (ASHRAE 36 "measure family") actually assigned to a given phase's rows. Added 2026-07-29 (Matt,
 * verbatim: "Name the categories in the phase table. But make it look good.") — measured problem:
 * the Cost Estimate prices 14 distinct sequence categories across the full scope ($336,572 total),
 * but the Phase table's "Included Improvements" row previously only ever named DCV explicitly
 * (via the row.label ' (CO2/DCV Programming)' suffix elsewhere in pricing-estimator.js); every
 * other priced category was invisible to the client behind the generic PHASE_IMPROVEMENTS
 * narrative below.
 * Source of truth: EM_SEQUENCE_DEFS[*].label (equipment-matrix.js) — NEVER a hardcoded name list,
 * so a future sequence def addition/rename is picked up automatically here with zero changes.
 * Names are emitted in EM_SEQUENCE_DEFS' own declared order (AHU -> VAV -> HWP -> CHWP -> DCV),
 * which reads as a natural "system family" grouping rather than row/discovery order.
 * Collision fix: hwp_supply_reset/chwp_supply_reset, hwp_pump_dp_reset/chwp_pump_dp_reset, and
 * hwp_staging/chwp_staging each share an IDENTICAL label in EM_SEQUENCE_DEFS (e.g. both say
 * "Supply Temperature Reset") because the def only names the sequence, not which plant loop it
 * belongs to. Disambiguated by deriving the loop from the seqKey's own hwp_/chwp_ prefix (matching
 * the existing "Hot Water Plant"/"Chilled Water Plant" naming convention already used elsewhere in
 * this file, e.g. CAT_LABELS above) — NOT a hardcoded per-key lookup, so it can never drift out of
 * sync with EM_SEQUENCE_DEFS if a def's label wording changes later.
 * rows param: a phase's own tl.phases[i].rows (see _pricingComputeRecommendedTimeline) — filters
 * to r.phase === 2 (the PRICED-ROW "sequence/programming" sub-type, distinct from the table's own
 * Phase 1/2/3 columns) && r.seqKey, per the row-classification convention documented throughout
 * pricing-estimator.js (row.phase 1 = hardware, row.phase 2 = sequence programming).
 */
function _rptA36PhaseSeqCategoryNames(rows) {
  rows = rows || [];
  var seen = {};
  rows.forEach(function (r) {
    if (r.phase === 2 && r.seqKey) seen[r.seqKey] = true;
  });
  var names = [];
  if (typeof EM_SEQUENCE_DEFS !== 'undefined') {
    EM_SEQUENCE_DEFS.forEach(function (sd) {
      if (!seen[sd.key]) return;
      // Hot Water/Chilled Water/Boiler/Chiller disambiguation used to be added HERE (prepending
      // 'Hot Water '/'Chilled Water ' by key prefix) because hwp_*/chwp_* pairs shared identical
      // bare labels ('Supply Temperature Reset', 'Staging', ...) in EM_SEQUENCE_DEFS. Removed
      // 2026-07-31 (months-table content fix): the disambiguation is now baked directly into
      // sd.label at the source (equipment-matrix.js) -- 'Hot Water Supply Temperature Reset',
      // 'Boiler Staging', etc. -- so EVERY consumer of EM_SEQUENCE_DEFS gets it, not just this
      // function. Re-adding a prefix here would double it (e.g. 'Hot Water Boiler Staging').
      // V-11 (2026-08-03): through _a36SeqDisplayLabel so a sequence renamed for the client in one
      // client document is renamed in every one of them.
      names.push(_a36SeqDisplayLabel(sd));
    });
  }
  return names;
}

/**
 * _rptA36PhaseSeqCategoryDetails(rows) — SAME distinct-category derivation as
 * _rptA36PhaseSeqCategoryNames (same filter, same EM_SEQUENCE_DEFS order) but returns
 * {label, plain} pairs instead of bare label strings, pulling the plain-English one-line
 * description from `ASHRAE36_SEQUENCE_PLAIN` (existing, vetted, jargon-free copy already used by
 * the Audit's ASHRAE 36 Sequences glossary page — see that object's own header comment). Added
 * 2026-07-29 to give the term's Included Improvements cell real per-category detail (what each
 * sequence actually does) instead of a bare name list, per Matt's coordinator-relayed direction:
 * "expanding what each entails is real content, not padding." `plain` is '' (never
 * omitted/undefined) if a key has no entry in ASHRAE36_SEQUENCE_PLAIN, so callers can render the
 * label alone rather than crash.
 * hwp_/chwp_ disambiguation prefix REMOVED here 2026-07-31 (months-table content fix) — see
 * _rptA36PhaseSeqCategoryNames' comment immediately above; sd.label already carries it at the
 * source, so this function just reads it straight through.
 */
function _rptA36PhaseSeqCategoryDetails(rows) {
  rows = rows || [];
  var seen = {};
  rows.forEach(function (r) {
    if (r.phase === 2 && r.seqKey) seen[r.seqKey] = true;
  });
  var details = [];
  if (typeof EM_SEQUENCE_DEFS !== 'undefined') {
    EM_SEQUENCE_DEFS.forEach(function (sd) {
      if (!seen[sd.key]) return;
      var plain = (typeof ASHRAE36_SEQUENCE_PLAIN !== 'undefined' && ASHRAE36_SEQUENCE_PLAIN[sd.key]) || '';
      details.push({ label: _a36SeqDisplayLabel(sd), plain: plain }); // V-11: one client-facing name everywhere
    });
  }
  return details;
}
/**
 * _rptA36FutureWorkInnerHTML(futurePhases, headStyle, bodyStyle) — content-only builder for the
 * Future Work section (2026-07-29, replacing the silent PRICING_PROPOSAL_MAX_PHASES truncation —
 * see PRICING_PROPOSAL_TERM_PHASE_COUNT's header comment). Names every sequence category still to
 * come by reusing _rptA36PhaseSeqCategoryNames over ALL future-phase rows combined (deduped, same
 * EM_SEQUENCE_DEFS order the term table's per-unit category list already uses), so a category can
 * never be named here without real priced rows behind it in `futurePhases`.
 * Deliberately NOT truncated — this section's entire purpose is to stop hiding scope, so silently
 * capping this list would reintroduce a smaller copy of the exact defect this section closes.
 * (The 2026-07-30 per-month display cap SEQ_CAT_DISPLAY_CAP this comment used to reference was
 * removed 2026-07-31 along with the per-month category-list cell design it capped — the term
 * table's current rows-per-unit design shows every one of the term's units, uncapped, per plan
 * word-export-rebuild-2026-07-30.md Part F.)
 * Carries ZERO dollar figures — callers must pass this function `rows`, never a phase object with
 * measuresTotal/allowanceTotal/etc. fields left readable downstream.
 */
function _rptA36FutureWorkInnerHTML(futurePhases, headStyle, bodyStyle) {
  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }
  var allRows = [];
  (futurePhases || []).forEach(function (p) {
    if (p && p.rows) allRows = allRows.concat(p.rows);
  });
  if (!allRows.length) return '';
  var cats = _rptA36PhaseSeqCategoryNames(allRows);
  var narrative =
    'Beyond the initial term, this service continues to expand sensor installation across ' +
    'additional equipment and zones and to program the control sequences those sensors make ' +
    'possible, until every building has the same level of sensor coverage and automated control. ' +
    // R7 (2026-08-03): this sentence used to read "Future work is funded through the same monthly
    // service allowance as it is completed, with no fixed end date." A near-duplicate census over
    // the rendered PDF (every sentence pair scored with difflib) flagged it at 0.68 against the
    // Implementation Plan's "Each stage of the work is funded through the monthly service allowance
    // as it is completed, with no fixed end date; the service continues for as long as improvement
    // opportunities remain." The funding-and-no-end-date mechanism belongs to the Implementation
    // Plan, which is where a reader looks for it; all this block needs to say is that future work
    // is not a separate bill. Shortened to the part that is not said anywhere else.
    'Future work is included in the same monthly service allowance.';
  var catHTML = '';
  if (cats.length) {
    catHTML =
      '<div style="margin-top:4px">' +
      '<span style="font-weight:700">Sequence categories addressed in future work: </span>' +
      cats.map(esc).join(', ') +
      '</div>';
  }
  return (
    '<div style="' +
    headStyle +
    '">Future Work</div>' +
    '<div style="' +
    bodyStyle +
    '">' +
    narrative +
    '</div>' +
    catHTML
  );
}

/**
 * _RPT_A36_MONTH_CAT_PHRASE / _rptA36JoinList / _rptA36MonthLaborSentence — Proposal months-table
 * rebuild (2026-08-03, replacing the check-mark unit matrix — Matt, verbatim: "it's a check-mark
 * matrix that ... labels almost every row 'Occupancy-Based Ventilation' ... he wants the table to
 * say IN TEXT, month by month, what work is being done ... the Cost Estimate has all the
 * information to make this correct"). Turns _pricingComputeMonthlyLaborBreakdown's real,
 * already-computed category rows for one bucket month (Month 1/2/3/4+ steady state,
 * pricing-estimator.js ~L1018) into plain prose naming exactly those categories — never an
 * invented task. Phrase values below are 1:1 renames of the real category strings
 * _pricingComputeMonthlyLaborBreakdown emits (pricing-estimator.js ~L1134-1167); every key here
 * must stay in sync with that function's category strings, or a real category would silently drop
 * out of the sentence (guarded defensively in _rptA36MonthLaborSentence below — an unmapped
 * category is simply skipped, never renders as "undefined").
 */
var _RPT_A36_MONTH_CAT_PHRASE = {
  'Alarm Configuration': 'alarm configuration',
  'Report Setup': 'automated report setup',
  'Trend Setup & Configuration': 'BAS trend setup and configuration',
  'Audit Report Verification & Quality Review': 'verification and quality review',
  'Audit Report Final Formatting & Polish': 'final formatting and polish',
  'Ongoing Monitoring & Optimization': 'ongoing equipment monitoring and optimization',
  'Utility Bill Data Entry': 'utility bill data entry',
  'Monthly Client Review Meeting': 'the monthly client review meeting',
  'Utility Rebate Assistance': 'utility rebate assistance',
  'Staff Training & Documentation': 'staff training and documentation',
};

function _rptA36JoinList(arr) {
  if (!arr || !arr.length) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

/**
 * _rptA36MonthLaborSentence(monthRows, bucketIdx, esc) — builds the "Ongoing Energy Management
 * labor" lead sentence(s) for one calendar month row of the Proposal months table, from that
 * month's real bucket rows (bd.months[bucketIdx-1].rows — see caller). Three groups, in the order
 * Matt asked for ("starting from the Ongoing Energy Management labor and building up: early
 * months finish the ASHRAE 36 Audit Report, set up alarms and trending..."): recurring EM labor
 * (present every month), the Month-1-only Audit Report finishing work, then the ramping-down
 * setup work (alarm/report/trend). bucketIdx (1-4, same clamp _pricingRecurringEMLaborHoursForMonth
 * uses) only changes the setup sentence's verb tense (sets up vs. continues tapering) — never
 * invents a category that isn't in monthRows.
 */
function _rptA36MonthLaborSentence(monthRows, bucketIdx, esc) {
  monthRows = monthRows || [];
  var audit = [],
    setup = [],
    recurring = [];
  monthRows.forEach(function (r) {
    var phrase = _RPT_A36_MONTH_CAT_PHRASE[r.category];
    if (!phrase) return; // defensive -- every real category from the breakdown has an entry above
    if (r.category.indexOf('Audit Report') === 0) audit.push(phrase);
    else if (
      r.category === 'Alarm Configuration' ||
      r.category === 'Report Setup' ||
      r.category === 'Trend Setup & Configuration'
    )
      setup.push(phrase);
    else recurring.push(phrase);
  });
  var sentences = [];
  if (recurring.length) {
    sentences.push('Ongoing Energy Management labor this month covers ' + esc(_rptA36JoinList(recurring)) + '.');
  }
  if (audit.length) {
    sentences.push('This month also finishes the ASHRAE 36 Audit Report (' + esc(_rptA36JoinList(audit)) + ').');
  }
  if (setup.length) {
    var verb = bucketIdx === 1 ? 'sets up' : 'continues, at a reduced level as the initial setup tapers off,';
    sentences.push('This month also ' + verb + ' ' + esc(_rptA36JoinList(setup)) + '.');
  }
  return sentences.join(' ');
}

/**
 * _rptA36MonthSequenceGroups(items) — real sequence-programming rows for one calendar month of the
 * term (from _pricingComputeTermMonthlyAllocation's monthBuckets[mi].items), grouped by SEQUENCE
 * TYPE (seqKey, same EM_SEQUENCE_DEFS-ordered dedup _rptA36PhaseSeqCategoryNames already uses)
 * across every building scheduled that month — never one row/sentence per building (Matt,
 * 2026-08-03: "NEVER one near-identical sentence per building"). Returns
 * [{label, buildings:[name,...]}, ...] in EM_SEQUENCE_DEFS order, then any defensive fold-in items
 * with no seqKey (enabler/safety/null-impact rows — see _pricingComputeTermMonthlyAllocation's own
 * header comment on this safety net).
 */
function _rptA36MonthSequenceGroups(items) {
  items = items || [];
  var bySeq = {};
  var otherOrder = [];
  var otherMap = {};
  items.forEach(function (item) {
    var seqRow = null;
    (item.rows || []).forEach(function (r) {
      if (r.phase === 2 && r.seqKey) seqRow = r;
    });
    var bName = _a36DisplayName(item.building);
    if (seqRow) {
      if (!bySeq[seqRow.seqKey]) bySeq[seqRow.seqKey] = {};
      bySeq[seqRow.seqKey][bName] = true;
    } else {
      var r0 = (item.rows || [])[0] || {};
      var lbl = r0.item || 'Improvement';
      if (!otherMap[lbl]) {
        otherMap[lbl] = {};
        otherOrder.push(lbl);
      }
      otherMap[lbl][bName] = true;
    }
  });
  var groups = [];
  if (typeof EM_SEQUENCE_DEFS !== 'undefined') {
    EM_SEQUENCE_DEFS.forEach(function (sd) {
      if (!bySeq[sd.key]) return;
      groups.push({ label: _a36SeqDisplayLabel(sd), buildings: Object.keys(bySeq[sd.key]) });
    });
  }
  otherOrder.forEach(function (lbl) {
    groups.push({ label: lbl, buildings: Object.keys(otherMap[lbl]) });
  });
  return groups;
}

/**
 * _rptA36MonthSequenceSentence(groups, esc) — turns _rptA36MonthSequenceGroups' output into one
 * sentence naming each sequence type once, with the buildings it touches that month named in a
 * parenthetical (or, past BUILDING_LIST_MAX, just a count — "the list is long" case Matt's spec
 * calls out) rather than as a count-only "3 buildings" with no names, or a duplicated sentence per
 * building.
 */
function _rptA36MonthSequenceSentence(groups, esc) {
  if (!groups || !groups.length) return '';
  var BUILDING_LIST_MAX = 4;
  var parts = groups.map(function (g) {
    var n = g.buildings.length;
    if (n === 1) return esc(g.label) + ' programming at ' + esc(g.buildings[0]);
    if (n <= BUILDING_LIST_MAX)
      return esc(g.label) + ' programming across ' + n + ' buildings (' + g.buildings.map(esc).join(', ') + ')';
    return esc(g.label) + ' programming across ' + n + ' buildings';
  });
  var joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join('; ') + '; and ' + parts[parts.length - 1];
  return 'Sequence programming this month: ' + joined + '.';
}

/**
 * _rptA36PhaseTableInnerHTML — content-only builder for the Recommended Energy Management Services
 * intro paragraph + Phase table (extracted 2026-07-27, page-2/3 merge, so the standalone page
 * function below and the merged Phase+Vision page share IDENTICAL content-building logic rather
 * than two copies that could drift). Returns the same HTML rptPageASHRAE36ProposalPhaseTable used
 * to wrap in its own <div style="padding:8px 48px 4px">...</div> — callers supply their own
 * padding wrapper so this can sit inside a merged page's single padding container.
 * page-break-inside:avoid / break-inside:avoid on the <table> itself (2026-07-27, page 2/3 merge):
 * this table is the single most-scrutinized element in the document per explicit instruction —
 * belt-and-suspenders guarantee it is never split across a physical page break even if a future
 * content change pushes total page height right up against the print boundary.
 */
/**
 * _rptA36PhaseTableDerive — 2026-08-02 (months-table page-height fix, fix/monthstable-content):
 * extracted from _rptA36PhaseTableInnerHTML (renamed from that function; all derivation logic
 * below is UNCHANGED from the 2026-07-31 rows-as-term-units matrix rebuild -- see that dated
 * comment block right below for the full content rationale, still accurate). This function now
 * returns a STRUCTURED object (intro / colgroup / head row / one HTML string PER unit row / term
 * notes / standalone Future Work / a pre-joined singlePageHTML) instead of one concatenated
 * string, so the SAME derivation feeds two renderers without duplicating any of the row-building
 * logic:
 *   - _rptA36PhaseTableInnerHTML(d, opts) below -- thin wrapper, returns der.singlePageHTML
 *     unchanged, used only by the legacy (unused, intentionally kept) merged
 *     rptPageASHRAE36ProposalPhaseAndVision page.
 *   - rptPageASHRAE36ProposalPhaseTable(startN, d, opts) further below -- the LIVE default-path
 *     renderer, which paginates der.rowsHTMLArr across multiple .rpt-page elements via
 *     _rptPaginateTokens (the same shared paginator _buildItemizedPages() already uses) instead
 *     of forcing a variable 13-row (Johnson County) matrix onto one fixed-height page. See that
 *     function's own header comment for why: the un-paginated single page overflowed 1056px by
 *     roughly 30% under real JOCO data, corrupting the printed page count and page-number
 *     footers (measured via page.pdf() print-path render, not just the on-screen preview).
 */
function _rptA36PhaseTableDerive(d, opts) {
  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }

  // Density pass (2026-07-27, page-2/3 merge): margin/line-height tightened (spacing only, font
  // size unchanged) — see rptPageASHRAE36ProposalPhaseAndVision's header comment.
  //
  // R7 (2026-08-03, V-13 + V-14): this block used to open with a SECOND
  // "Recommended Energy Management Services" heading and a paragraph that made the same
  // recommendation rptPageASHRAE36ProposalRecommendedServicesCover already makes one page earlier,
  // in near-identical words ("...recommends a phased Energy Management Services approach funded
  // through a planned budget of approximately $6,250 per month..."). Two consequences, both
  // reported off the live 2026-08-02 export: the proposal recommended the same thing twice under
  // one heading (reads as a copy-paste error), and the price softened from the firm "$6,250 per
  // month" stated on the previous page to "approximately $6,250 per month" here, contradicting the
  // Agreement, which sets $6,250 as a MINIMUM monthly spend. The recommendation is now made ONCE,
  // on the page before this one; this is a plain lead-in to the schedule that follows and states
  // no price at all, so there is no second figure that can drift from the first. budgetFmt was
  // deleted with the sentence that used it (it had no other reader in this function).
  var intro =
    '<div style="font-size:14px;color:var(--rpt-page-text);line-height:1.38;margin-bottom:4px">' +
    'The schedule below lists the improvements included in the current term and the month each one ' +
    'is carried out.' +
    '</div>';

  // 2026-07-29 (months + Future Work rebuild, replacing the PRICING_PROPOSAL_MAX_PHASES=3 cap —
  // see PRICING_PROPOSAL_TERM_PHASE_COUNT's header comment): ONE derivation call feeds both this
  // table (the current term, shown as calendar months) and the Future Work section, so the two can
  // never disagree about which phase is which.
  var td = _pricingProposalTermAndFuture(d.project.id);
  var tl = td.tl;
  var termPhases = td.termPhases;
  var futurePhases = td.futurePhases;

  if (!tl || !termPhases.length) {
    var fallback =
      '<div style="font-size:14px;color:var(--rpt-page-text);padding:10px 0">' +
      'A phased facility rollout will populate here once pricing data has been imported and priced ' +
      'for this project.' +
      '</div>';
    // R7 (2026-08-03): intro is deliberately EMPTY here. It is now a lead-in that promises "the
    // schedule below" — in this branch there is no schedule below, only the "pricing not imported
    // yet" notice, and printing both would have the page contradict itself in one line. The old
    // intro was a self-contained recommendation paragraph, so it read fine ahead of the notice;
    // this one does not, and the notice already says everything this branch has to say.
    return { fallbackOnly: true, intro: '', fallbackHTML: fallback };
  }

  // monthLabels: one label per calendar month of the current term (e.g. "Aug 2026" .. "Dec 2026")
  // — see _pricingProposalTermMonthLabels' header comment for the derivation + the timeline-
  // anchoring tension it flags. Falls back to the phase's own label (e.g. "Phase 1") if month
  // labels can't be derived (defensive — should not happen when pricing-estimator.js is present).
  var monthLabels = _pricingProposalTermMonthLabels(termPhases);
  var headCols = monthLabels.length
    ? monthLabels
    : termPhases.map(function (p) {
        return p.label;
      });
  // termRows: every row across the term's phase(s) — feeds the single Included Improvements /
  // Expected Results cell below (colspan across all month columns, since the underlying data has
  // no finer-than-phase month assignment for individual rows — see this change's dashboardlogic.md
  // entry for why the term is rendered as ONE merged content block under real month headers rather
  // than fabricating a false per-month split of the same rows).
  var termRows = [];
  termPhases.forEach(function (p) {
    if (p && p.rows) termRows = termRows.concat(p.rows);
  });

  // Phase copy rewrite (2026-07-29, Matt, verbatim: "can we not expand more on the 3 phases in
  // the phases table and add more to the improvements and expected results, like phase 1 is
  // programming all sequences that do not require sensors to be installed and getting reporting
  // and alarms set up and if we have money to spare start installing sensors in high value
  // places. Phase 2 is expanding where we install sensors and add the sequences for them. Phase
  // 3 is remaining sensors and sequences. We need to make this more understandable to the
  // reader."). PHASE_IMPROVEMENTS/EXPECTED_RESULTS below are fixed, plain-language, phase-
  // POSITION copy (same convention EXPECTED_RESULTS already used — generic narrative, no
  // client-specific fact) written to match Matt's own framing directly, replacing the prior
  // live-derived _rptA36PhaseImprovementsText sentence for THIS table only. That helper is left
  // fully intact and unchanged — the Cost Estimate page's separate phase timeline
  // (_rptA36RecommendedTimelineHTML) still calls it, so its data-driven per-project wording is
  // unaffected by this rewrite.
  //
  // 2026-07-30 (contradiction fix, copy-only): the "if we have money to spare" framing above was
  // written to match Matt's literal 07-29 request, but it implies Phase 1 hardware is a budget
  // contingency. It never is: the shipped ranking (PRICING_NO_HW_SCORE_BONUS, pricing-estimator.js)
  // biases no-hardware units ahead of hardware units in the sort, so Phase 1 (the whole term —
  // PRICING_PROPOSAL_TERM_PHASE_COUNT=1) is 100% programming on equipment that already has the
  // sensors it needs, by construction, regardless of budget headroom. Confirmed against real JOCO
  // data (project 1779664753271) at render time: 0 of the term phase's rows carry a hardware
  // install; every row is a programming-only sequence. Rewritten below to say what actually
  // happens — sequencing driven by existing instrumentation, hardware following once programming
  // is done — instead of describing a contingency the algorithm never produces. The ranking itself
  // was NOT changed (that remains a separate true-ROI workstream, per Matt's explicit instruction
  // not to move client dollars via this fix). See dashboardlogic.md 2026-07-30 entry.
  // PHASE_IMPROVEMENTS[0]/EXPECTED_RESULTS[0] describe the current term (rendered below, under the
  // real month headers). Index 1/2 are no longer rendered as separate phase columns (the table now
  // shows only the term — everything past it is Future Work), but their content lives on,
  // paraphrased, inside _rptA36FutureWorkInnerHTML's narrative so the "expanding sensor
  // installation" / "remaining sensors" framing is not lost, only relocated.
  var PHASE_IMPROVEMENTS = [
    'Programs every control sequence that does not require a new sensor to be installed, and sets up automated ' +
      'reporting and alarms so problems are caught right away. Sequencing is prioritized by what can already be ' +
      'done with the sensors in place today; hardware installation for the remaining sequences follows once this ' +
      'programming work is complete.',
  ];

  var EXPECTED_RESULTS = [
    'Immediate visibility into how equipment is running through reporting and alarms, plus the efficiency and ' +
      'comfort improvements available from every sequence that does not require new hardware — the fastest, ' +
      'lowest-cost gains first.',
  ];

  var thStyle =
    'padding:8px 10px;font-size:14px;font-weight:700;color:var(--rpt-page-text);text-align:center;' +
    'border:1px solid var(--rpt-border)';
  var lblStyle =
    'padding:8px 10px;font-size:14px;font-weight:700;color:var(--rpt-page-text);text-align:center;' +
    'vertical-align:top;border:1px solid var(--rpt-border)';
  var cellStyle =
    'padding:8px 10px;font-size:9.5px;color:var(--rpt-page-text);text-align:center;vertical-align:top;' +
    'line-height:1.5;border:1px solid var(--rpt-border)';

  // headRow (2026-08-03 months-table-as-text rebuild — see rptPageASHRAE36ProposalPhaseTable's
  // header comment for the full "why"): two columns, Month | What We'll Be Doing, one ROW per
  // calendar month of the current term (e.g. Aug 2026 .. Dec 2026) instead of the old
  // one-check-mark-column-per-month matrix. See _pricingProposalTermMonthLabels' header comment for
  // the month-label derivation.
  var headRow = '<tr><th style="' + thStyle + '">Month</th><th style="' + thStyle + '">What We’ll Be Doing</th></tr>';

  // catListStyle: nested sub-block inside the Future Work cell naming the actual priced sequence
  // categories still to come (see _rptA36PhaseSeqCategoryNames' header comment above for the full
  // rationale). Left-aligned + smaller than the parent cell's centered narrative text so it reads
  // as a compact reference list, not competing prose; a top rule (var(--rpt-rule), the same token
  // the table's own borders use — no new hardcoded color) separates it from the narrative
  // sentence without introducing a box/card (standing rule: no boxes in reports).
  var catListStyle =
    'margin-top:6px;padding-top:5px;border-top:1px solid var(--rpt-rule);font-size:8.5px;' +
    'color:var(--rpt-page-text);text-align:left;line-height:1.4';

  // monthLblStyle/monthDescStyle: styles for the 2026-08-03 months-table-as-text rebuild (Matt,
  // verbatim: "he wants the table to say IN TEXT, month by month, what work is being done" —
  // replaces the 2026-07-31 rows-as-term-units check-mark matrix entirely; NO check marks, ONE ROW
  // PER CALENDAR MONTH, not per term unit). font-size 14px = RPT_BODY_PX, the same body-text tier
  // every other paragraph on this page uses — this is prose, not a dense matrix cell, so it reads
  // at the document's normal body size rather than the old 9.5px matrix-cell size.
  var monthLblStyle =
    'padding:8px 10px;font-size:14px;font-weight:700;color:var(--rpt-page-text);text-align:left;vertical-align:top;' +
    'line-height:1.4;border:1px solid var(--rpt-border);white-space:nowrap';
  var monthDescStyle =
    'padding:8px 10px;font-size:14px;color:var(--rpt-page-text);text-align:left;vertical-align:top;' +
    'line-height:1.42;border:1px solid var(--rpt-border)';

  var monthCount = headCols.length;
  var monthAlloc =
    typeof _pricingComputeTermMonthlyAllocation === 'function'
      ? _pricingComputeTermMonthlyAllocation(d.project.id, termRows, monthCount, tl.monthlyAllowance)
      : { months: [], envelope: 0 };
  var monthBuckets = monthAlloc.months || [];

  // bd: the real monthly labor breakdown (Alarm Configuration / Report Setup / Trend Setup &
  // Configuration / Audit Report finishing work / recurring EM labor —
  // _pricingComputeMonthlyLaborBreakdown, pricing-estimator.js ~L1018) — the SAME data
  // _pricingLaborBreakdownHTML renders in the interactive Cost Estimate tab, read here (never
  // re-derived) so the Proposal and the Cost Estimate can never disagree about what a month's labor
  // covers. Null only when no budget.amount is configured for this project (same
  // silent-until-configured convention as the rest of this feature) — guarded below.
  var bd =
    typeof _pricingComputeMonthlyLaborBreakdown === 'function'
      ? _pricingComputeMonthlyLaborBreakdown(d.project.id)
      : null;

  // Fallback copy — used only if a month somehow has neither labor-breakdown rows nor any
  // allocated sequence-programming unit (should not occur for a real, budget-configured project;
  // guards against a fully blank row rather than assuming it can never happen).
  var MONTH_EMPTY_TEXT = 'Ongoing Energy Management Services for this period.';

  // monthEntries: ONE ENTRY PER CALENDAR MONTH of the term (2026-08-03 rebuild, replacing the old
  // one-entry-per-term-unit check-mark matrix). Each entry's text JOINS two real data sources on
  // month index, per Matt's spec: (1) that month's labor-breakdown bucket (Month 1/2/3/4+ steady
  // state, clamped the SAME way _pricingRecurringEMLaborHoursForMonth clamps an absolute month
  // index — pricing-estimator.js ~L1258) for the "Ongoing Energy Management labor... finish the
  // Audit Report... set up alarms and trending" narrative, and (2) that month's own
  // _pricingComputeTermMonthlyAllocation bucket, summarized by sequence TYPE across buildings
  // (_rptA36MonthSequenceGroups/_rptA36MonthSequenceSentence above — never one sentence per
  // building), for the "then sequence programming rolls out" narrative. EVERY month renders
  // non-empty because source (1) alone is guaranteed non-empty for any budget-configured project
  // (Ongoing Monitoring & Optimization / Bill Entry / Meeting / Rebate / Training are present in
  // every bucket, including Month 4+ steady state) — MONTH_EMPTY_TEXT is a defensive fallback only.
  var monthEntries = headCols.map(function (m, mi) {
    var laborSentence = '';
    if (bd && bd.months && bd.months.length) {
      var bucketIdx = Math.min(Math.max(mi + 1, 1), 4); // same absolute-month clamp as _pricingRecurringEMLaborHoursForMonth
      laborSentence = _rptA36MonthLaborSentence(bd.months[bucketIdx - 1].rows, bucketIdx, esc);
    }
    var seqGroups = _rptA36MonthSequenceGroups((monthBuckets[mi] && monthBuckets[mi].items) || []);
    var seqSentence = _rptA36MonthSequenceSentence(seqGroups, esc);
    var text = (laborSentence + ' ' + seqSentence).trim() || esc(MONTH_EMPTY_TEXT);
    return { label: m, text: text };
  });

  function monthRowHTML(entry) {
    return (
      '<tr><td style="' +
      monthLblStyle +
      '">' +
      esc(entry.label) +
      '</td><td style="' +
      monthDescStyle +
      '">' +
      entry.text +
      '</td></tr>'
    );
  }

  // improvementsRowsArr (2026-08-02, months-table page-height fix — name kept from the prior
  // rebuild, see rptPageASHRAE36ProposalPhaseTable's header comment): one <tr> string per calendar
  // month (5 for the JOCO term), not per term unit as before. Pagination
  // (rptPageASHRAE36ProposalPhaseTable) still needs one row at a time to measure/chunk; the
  // single-page wrapper (_rptA36PhaseTableInnerHTML) still joins the same array.
  var improvementsRowsArr = monthEntries.length
    ? monthEntries.map(monthRowHTML)
    : [
        '<tr><td style="' +
          monthLblStyle +
          '" colspan="2"><span style="font-style:italic">' +
          esc(MONTH_EMPTY_TEXT) +
          '</span></td></tr>',
      ];
  var improvementsRows = improvementsRowsArr.join('');
  // improvementsRowLabelLens (2026-08-03): re-purposed from the old LABEL-cell char count to the
  // DESCRIPTION-cell char count — that column now holds the multi-sentence paragraph and is what
  // actually drives each row's rendered height; the Month cell is always one short line. See
  // PHASE_LABEL_CPL's own comment (rptPageASHRAE36ProposalPhaseTable) for the chars-per-line this
  // is divided by.
  var improvementsRowLabelLens = monthEntries.length
    ? monthEntries.map(function (e) {
        return e.text.length;
      })
    : [MONTH_EMPTY_TEXT.length];

  // Facilities Included row REMOVED (2026-07-29, Matt, verbatim: "why would you put continues in
  // phase x for every building? That is redundant. Also, let's just remove the buildings
  // completely from that phase table since all buildings are included."). Every building in the
  // priced scope is included across the phases by construction, so a per-phase buildings list
  // added no information. facilitiesText itself (pricing-estimator.js) is left intact/unchanged
  // — it still feeds the interactive Cost Estimate tab's own Recommended timeline table
  // (_pricingRecommendedTimelineHTML), Matt's internal planning view. The Cost Estimate PAGE's
  // phase timeline table (_rptA36RecommendedTimelineHTML) also carried a "Facilities Included"
  // column that hit the identical redundancy/overflow problem at 27-building portfolio scale
  // (~276px page overflow) and was removed the same day for the same reason — see that
  // function's own header comment.

  // Expected Results (2026-07-31 rebuild): ONE sentence for the whole term, derived from every
  // distinct sequence category actually priced across termRows (_rptA36PhaseSeqCategoryNames,
  // same helper the old per-month cell used) — replaces the old per-month benefit sentence, which
  // hit the identical empty-month problem the Improvements cell did (same MONTH_EMPTY_TEXT
  // fallback). A single term-level sentence never goes empty as long as any unit is priced.
  var allTermCatNames = _rptA36PhaseSeqCategoryNames(termRows);
  var expectedResultsText = '';
  if (allTermCatNames.length) {
    var namesText2 =
      allTermCatNames.length === 1
        ? allTermCatNames[0]
        : allTermCatNames.slice(0, -1).join(', ') + ' and ' + allTermCatNames[allTermCatNames.length - 1];
    expectedResultsText = 'Reporting, alarms, and efficiency/comfort gains from ' + esc(namesText2) + '.';
  }

  // futureRowHTML: the "fold into the table" rendering mode (opts.futureWorkInline === true) —
  // appends Future Work as one more row inside THIS table instead of the standalone section
  // _rptA36VisionInnerHTML renders by default. Same content either way
  // (_rptA36FutureWorkInnerHTML), never dollars, never a truncated category list.
  // colspan fixed at 1 (2026-08-03 months-table-as-text rebuild): this table now has exactly 2
  // columns (Month, What We'll Be Doing) instead of the old 1-label + N-month-columns matrix, so
  // there is only one content column left to span.
  var futureRowHTML = '';
  if (opts && opts.futureWorkInline === true && futurePhases.length) {
    var futureAllRows = [];
    futurePhases.forEach(function (p) {
      if (p && p.rows) futureAllRows = futureAllRows.concat(p.rows);
    });
    var futureCatNames = _rptA36PhaseSeqCategoryNames(futureAllRows);
    if (futureCatNames.length) {
      var futureListText = futureCatNames.map(esc).join(', ');
      futureRowHTML =
        '<tr><td style="' +
        lblStyle +
        '">Future Work</td>' +
        '<td style="' +
        cellStyle +
        '" colspan="1">' +
        'Beyond the initial term, this service continues to expand sensor installation and program the ' +
        'additional control sequences those sensors make possible, funded through the same monthly ' +
        'service allowance, with no fixed end date.' +
        '<div style="' +
        catListStyle +
        '"><span style="font-weight:700">Sequence categories addressed in future work: </span>' +
        futureListText +
        '</div>' +
        '</td></tr>';
    }
  }

  // colgroup (2026-08-03 months-table-as-text rebuild): a narrow Month column (just "Aug 2026"
  // etc., never wraps) plus one wide description column carrying the joined labor+sequence
  // paragraph — replaces the old label + one-column-per-month layout.
  var colgroup = '<colgroup><col style="width:14%"><col></colgroup>';

  var table =
    '<table style="width:100%;border-collapse:collapse;page-break-inside:avoid;break-inside:avoid">' +
    colgroup +
    '<thead>' +
    headRow +
    '</thead>' +
    '<tbody>' +
    improvementsRows +
    futureRowHTML +
    '</tbody>' +
    '</table>';

  // termNotesHTML: Expected Results (once, term-level) + the standing Ongoing Energy Management
  // Services description (once, term-level, and now stated CONCRETELY instead of the old bare
  // placeholder sentence that used to stand in as the entire cell content for an unallocated
  // month — 2026-07-31, Matt verbatim: "Really that's the best we can do? We can't say what
  // sequences or sensors to do?"). What follows is real, grounded, non-invented content: it names
  // the SAME ongoing activities (monitoring, alarms/trend review, verification) the term's own
  // PHASE_IMPROVEMENTS/EXPECTED_RESULTS narrative above already describes for this program
  // ("reporting and alarms so problems are caught right away" / "Immediate visibility... through
  // reporting and alarms") — never a per-month fabricated specific, since ongoing monitoring is
  // genuinely the same activity in every month of the term regardless of whether a new unit also
  // starts that month. Same body-text style literal `intro`'s own body div above uses (14px, no
  // new font size introduced).
  var _termNoteBody = 'font-size:14px;color:var(--rpt-page-text);line-height:1.38;margin-top:6px';
  var expectedResultsHTML = expectedResultsText
    ? '<div style="' +
      _termNoteBody +
      '"><span style="font-weight:700">Expected Results: </span>' +
      expectedResultsText +
      '</div>'
    : '';
  var ongoingServicesHTML =
    '<div style="' +
    _termNoteBody +
    '">' +
    'Every month of the term, whether or not a new item begins that month, Control Service Company also ' +
    'monitors equipment operation, reviews automated alarms and trend data, tunes sequences as conditions ' +
    'change, and verifies that previously implemented work continues to perform as designed.' +
    '</div>';
  var termNotesHTML = expectedResultsHTML + ongoingServicesHTML;

  // standaloneFutureWorkHTML: DEFAULT placement (2026-07-29, page-density fix, coordinator
  // direction — "bring Future Work onto that page as the default rather than a separate page...
  // fills the space with real content instead of filler"). Suppressed when opts.futureWorkInline
  // is true, since that mode already folded the identical content into futureRowHTML above (never
  // rendered twice). Previously defaulted to the Vision page (_rptA36VisionInnerHTML) — moved here
  // because the term and Future Work belong on the same page and the Phase table page had
  // significant unused space (~514px clearance measured pre-move) while the Vision page did not
  // need it. Same heading/body style literals rptPage 2's own `intro` block above uses, for visual
  // consistency within this page.
  var standaloneFutureWorkHTML = '';
  if (!(opts && opts.futureWorkInline === true)) {
    // D-12 (2026-08-03): "Future Work" heading -> the 13pt section tier.
    var _fwHead =
      'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:10px 0 4px';
    var _fwBody = 'font-size:14px;color:var(--rpt-page-text);line-height:1.38';
    standaloneFutureWorkHTML = _rptA36FutureWorkInnerHTML(futurePhases, _fwHead, _fwBody);
  }

  return {
    fallbackOnly: false,
    intro: intro,
    colgroupHTML: colgroup,
    headRowHTML: headRow,
    rowsHTMLArr: improvementsRowsArr,
    rowsLabelLenArr: improvementsRowLabelLens,
    futureRowHTML: futureRowHTML,
    termNotesHTML: termNotesHTML,
    standaloneFutureWorkHTML: standaloneFutureWorkHTML,
    // singlePageHTML: pre-joined exactly as the pre-2026-08-02 function used to return, byte-for-
    // byte -- consumed only by the thin _rptA36PhaseTableInnerHTML wrapper below so the legacy
    // (unused) merged Phase+Vision page keeps its exact prior output with zero behavior change.
    singlePageHTML: intro + table + termNotesHTML + standaloneFutureWorkHTML,
  };
}

/**
 * _rptA36PhaseTableInnerHTML — thin wrapper preserved for the legacy (unused, intentionally kept
 * per "never destroy existing capability") rptPageASHRAE36ProposalPhaseAndVision merged page. Not
 * on the default render path as of 2026-08-02 -- see _rptA36PhaseTableDerive's header comment.
 * Returns the exact same single, unpaginated HTML string this function always has.
 */
function _rptA36PhaseTableInnerHTML(d, opts) {
  var der = _rptA36PhaseTableDerive(d, opts);
  return der.fallbackOnly ? der.intro + der.fallbackHTML : der.singlePageHTML;
}

/**
 * rptPageASHRAE36ProposalPhaseTable — LIVE default-path renderer for the Recommended
 * Energy Management Services page (Page 2 of the rebuilt Service Proposal). Returns an ARRAY of page
 * HTML strings (2026-08-02, months-table page-height fix) instead of a single string -- mirrors
 * the Array-returning convention rptPageASHRAE36ProposalPricing already established (see
 * generateASHRAE36ProposalHTML's costEstimate branch: `.forEach(pg => { pages.push(...);
 * pageNum++ })`), so callers must spread/increment pageNum the same way.
 *
 * WHY THIS EXISTS (2026-08-02): the 2026-07-31 rows-as-term-units matrix rebuild replaced a fixed
 * 2-row table with a variable one-row-per-term-unit table (13 rows for Johnson County) but added
 * no page-height handling. Measured against real JOCO data (project 1779664753271) under the
 * app's DEFAULT proposal section selection: the unpaginated page's content stood 1366-1378px tall
 * against the fixed 1056px page box (roughly 30% overflow), and the real print path
 * (page.emulateMedia('print') + page.pdf(), the same mechanism exportReportToPDF()'s
 * window.print() uses) let the single overflowing `.rpt-page` grow past its footer, so the
 * footer/page-number graphic landed mid-page-3 overlapping cut-off "Sequence categories addressed
 * in future work:" text, while every footer still read "Page X of 3" (the page-numbering system
 * never knew a 4th physical page existed). See _rptA36PhaseTableDerive's header comment for the
 * shared-derivation architecture and dashboardlogic.md's 2026-08-02 entry for the full measurement.
 *
 * APPROACH: paginate der.rowsHTMLArr (one token per term unit) via _rptPaginateTokens -- the SAME
 * shared pixel-height paginator _buildItemizedPages() already uses successfully (see that
 * function's header comment) -- instead of inventing a new mechanism. Each resulting page is a
 * full rptPage() with its OWN header/footer, so _injectPageNumbers' total-page count (and every
 * "Page X of N" footer) automatically includes the added pages. Every continuation page repeats
 * the month-column header row (der.headRowHTML) so a reader on page 2 still knows which column is
 * which month -- required per this fix's own spec. The trailing term-notes/Future-Work content
 * (der.termNotesHTML + der.standaloneFutureWorkHTML) is appended as a final 'block' token so it
 * rides on whichever page it fits, never orphaned off the last row page.
 */
function rptPageASHRAE36ProposalPhaseTable(startN, d, opts) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  // fix/report-typography-and-pagination-merge (2026-07-29): "Why This Approach" prepended here —
  // see rptPageASHRAE36ProposalCover's header comment for why it moved off the cover page. Same
  // HEAD/UL literal style strings used throughout the ASHRAE 36 Proposal page family.
  // D-12 (2026-08-03): "Why This Approach" heading -> the 13pt section tier.
  var _whyHead = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:7px 0 3px';
  var _whyUl = 'margin:2px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.38';
  var whyHTML = _rptA36WhyThisApproachHTML(_whyHead, _whyUl);

  var der = _rptA36PhaseTableDerive(d, opts);

  function wrapPage(pageN, bodyInner, labelSuffix) {
    var bodyHTML = '<div style="padding:8px 48px 4px">' + bodyInner + '</div>';
    return rptPage(pageN, 'ASHRAE 36 Proposal', bodyHTML, {
      hero: false,
      hideIntHdr: true,
      data: fakeData,
      label: 'Page ' + pageN + ' — Recommended Energy Management Services' + (labelSuffix || ''),
    });
  }

  if (der.fallbackOnly) {
    return [wrapPage(startN, whyHTML + der.intro + der.fallbackHTML, '')];
  }

  // Pixel budgets, all derived from _rptContentBudget() per this file's "never a standalone
  // invented literal" rule (see RPT_GEOMETRY_DEFAULTS header comment). This page always renders
  // with hideIntHdr:true (the 'flush' header variant -- no .rpt-int-hdr title bar).
  //
  // ROW_H/THEAD_H/HEAD_CHROME_FIRST/TAIL_H measured via real headless render against JOCO
  // (project 1779664753271, 27-building portfolio, 13-unit current term): thead 38px; unit rows
  // 46px (1-line label) to 60px (2-line label, the common case); Why This Approach block 115px
  // (18px heading + 97px bullet list -- fixed generic copy, not data-driven, per
  // _rptA36WhyThisApproachHTML); Recommended Energy Management Services intro heading+paragraph 76px;
  // term notes (Expected Results + Ongoing Services, always rendered) 116px; standalone Future
  // Work block (heading + narrative + category list, suppressed when opts.futureWorkInline) an
  // additional ~200px. Each constant below carries the same kind of safety margin
  // _buildItemizedPages' own row-height constants do (that function's comment: "keep a safety
  // margin for longer item names ... that could wrap further") for a longer building/sequence
  // name or an extra future-work category than JOCO's own data happened to produce.
  // U2 / RC-A (2026-08-02, D-04 + D-05): every constant below was re-measured in a headless PRINT
  // render of the real JOCO Service Proposal AFTER the 10pt printed-text floor was applied, and
  // every one of them had been too small. The flat ROW_H = 66 was the worst: real rows measured
  // 77-157px, so the paginator put 9 rows on a page that holds 5 and the table ran 313px past the
  // bottom of the content area and straight through the footer wave band. THEAD_H rose because the
  // continuation page's narrower month columns wrap "Aug 2026" onto two lines (38px first page,
  // 59px continuation — 60 covers both). The trailing notes block (Expected Results + Ongoing
  // Services + standalone Future Work) measured 356px, over the old 340 reservation.
  var g = _rptContentBudget('flush');
  var THEAD_H = 60; // measured 38 first page / 59 continuation (wrapped month headers); 60 covers both
  var HEAD_CHROME_FIRST = 232; // measured 224 (Why This Approach block + intro heading/paragraph + gaps)
  var CONT_TITLE_CHROME = 30; // small "(continued)" heading on continuation pages only
  var PHASE_SAFETY_H = 40; // explicit page-level margin, same convention as the Audit pages
  var TAIL_H = opts && opts.futureWorkInline === true ? 150 : 370; // measured 356 in standalone mode
  // Per-row height from the description cell's character count — 2026-08-03 months-table-as-text
  // rebuild (replacing the old check-mark matrix's narrow-label chars-per-line model, which no
  // longer applies now that the description column is a wide, wrapping multi-sentence paragraph).
  // A chars-per-line/line-count model proved a poor fit here (real wrapped line lengths vary with
  // word-break points, parentheticals, and building-name lists far more than a flat CPL captures)
  // -- instead this is a direct linear fit against 5 REAL rows measured via headless render against
  // JOCO (project 1779664753271): (descLen, renderedHeight) = (708,215.75) (677,195.875)
  // (709,215.75) (325,116.375) (347,116.375) -> slope ~0.26px/char, intercept ~32px, every point
  // OVER-estimated by 9-21px by the formula below (PHASE_DESC_PX_PER_CHAR * len +
  // PHASE_ROW_BASE_H), matching this file's own "never below the real height" safety-margin
  // convention while staying tight enough that 2-3 month rows now share a page instead of one
  // check-mark-matrix-era's 321px/row flat overestimate leaving most of each page blank.
  var PHASE_DESC_PX_PER_CHAR = 0.26;
  var PHASE_ROW_BASE_H = 40;
  var _phaseLabelLens = der.rowsLabelLenArr || [];
  var tokens = der.rowsHTMLArr.map(function (html, i) {
    var len = _phaseLabelLens[i] || 0;
    return { type: 'row', estH: Math.ceil(len * PHASE_DESC_PX_PER_CHAR) + PHASE_ROW_BASE_H, html: html };
  });
  if (der.futureRowHTML) {
    // futureWorkInline mode folds Future Work into the table as one more <tr> (der.futureRowHTML)
    // -- narrower narrative + category sub-list makes this row taller than a plain unit row.
    // U2 (2026-08-02): 160 -> 214, the same 1.334x the 10pt floor applied to every other text
    // block on this page. Not directly measured (JOCO ships futureWorkInline off, so this row is
    // not in the default export) — scaled, and flagged as scaled rather than measured.
    tokens.push({ type: 'row', estH: 214, html: der.futureRowHTML });
  }
  // Always-present trailing block: term notes (+ standalone Future Work unless folded inline
  // above). Appended LAST so _rptPaginateTokens naturally pushes it onto a fresh page if it does
  // not fit after the final row chunk, instead of forcing a reserved-but-usually-wasted budget on
  // every page.
  tokens.push({ type: 'block', estH: TAIL_H, html: der.termNotesHTML + der.standaloneFutureWorkHTML });

  var firstBudget = g - HEAD_CHROME_FIRST - THEAD_H - PHASE_SAFETY_H;
  var contBudget = g - CONT_TITLE_CHROME - THEAD_H - PHASE_SAFETY_H;
  var chunks = _rptPaginateTokens(tokens, firstBudget, contBudget);
  var numChunks = chunks.length;

  var pages = [];
  chunks.forEach(function (chunk, idx) {
    var rowsHTML = '';
    var tailHTML = '';
    var hasRows = false;
    chunk.forEach(function (t) {
      if (t.type === 'block') tailHTML += t.html;
      else {
        rowsHTML += t.html;
        hasRows = true;
      }
    });
    // 2026-08-03 (months-table-as-text rebuild, empty-table fix): a chunk can legitimately be
    // TAIL-ONLY (the term notes + standalone Future Work block landing alone on the final page once
    // the description-cell text made every month row taller than the old check-mark cells) -- do
    // not render an empty <table> with only a header row and zero <tr>s in that case; a headed
    // table with nothing under it reads as a rendering bug, not real content.
    var table = hasRows
      ? '<table style="width:100%;border-collapse:collapse;page-break-inside:avoid;break-inside:avoid">' +
        der.colgroupHTML +
        '<thead>' +
        der.headRowHTML +
        '</thead>' +
        '<tbody>' +
        rowsHTML +
        '</tbody>' +
        '</table>'
      : '';
    var head;
    if (idx === 0) {
      head = whyHTML + der.intro;
    } else if (hasRows) {
      // Repeating header row (der.headRowHTML, above) plus this small continuation title -- so a
      // reader who reaches page 2 knows both which page this is AND which column is which month.
      head =
        // D-12 / V-18 (2026-08-03): 11px -> the 13pt section tier. This was the heading V-18
        // measured at 9.0pt on Proposal page 3 while the months table's own column headers on the
        // same page printed at 10.5pt, making a table header the largest text on the page.
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
        'text-transform:uppercase;letter-spacing:0.04em">Included Improvements (continued ' +
        (idx + 1) +
        ' of ' +
        numChunks +
        ')</div>';
    } else {
      // Tail-only continuation page: no table, so no "Included Improvements (continued...)" table
      // title either -- tailHTML (Expected Results / Ongoing Services / Future Work) carries its
      // own headings and reads fine starting straight into them.
      head = '';
    }
    var bodyInner = head + table + tailHTML;
    var labelSuffix =
      numChunks > 1
        ? idx === 0
          ? ' (1 of ' + numChunks + ')'
          : ' (continued ' + (idx + 1) + ' of ' + numChunks + ')'
        : '';
    pages.push(wrapPage(startN + idx, bodyInner, labelSuffix));
  });

  return pages;
}

/**
 * _rptA36VisionInnerHTML — content-only builder for Implementation Plan & Long-Term Vision
 * (Phase/Schedule table) + Long-Term Program Vision + Disclaimer (extracted 2026-07-27, page-2/3
 * merge — same reasoning as _rptA36PhaseTableInnerHTML above: one shared content builder instead
 * of two copies that could drift). Bullet/paragraph text is verbatim from the target spec — none
 * of it references a client-specific fact, so no live derivation is needed here beyond the
 * schedule table. page-break-inside:avoid / break-inside:avoid added to the schedule <table>
 * (2026-07-27, same belt-and-suspenders reasoning as the Phase table).
 *
 * 2026-07-27: the Expected Outcomes bullet-list section that used to sit between Long-Term
 * Program Vision and Disclaimer was removed at the client's explicit direction ("Just get rid of
 * the entire Expected Outcomes page. No questions.").
 */
function _rptA36VisionInnerHTML(d, opts) {
  // Prose-only display name — see _rptProposalDisplayClientName above rptPageASHRAE36ProposalCover.
  var displayClient = _rptProposalDisplayClientName(d.project.name);

  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }

  // Density pass (2026-07-27, page-2/3 merge — see rptPageASHRAE36ProposalPhaseAndVision's header
  // comment): tightened from 10px/5px heading margins and 1.55 line-height to the SAME 1.38
  // line-height page 1 (rptPageASHRAE36ProposalCover's BODY var) already established as this
  // site's readable floor — reusing an already-vetted value, not inventing a tighter one. Font
  // sizes themselves were UNCHANGED by this density pass (12px heading unchanged; body was
  // font-size:10.5px at the time, later corrected to font-size:14px on 2026-07-28 — see
  // rptPageASHRAE36ProposalCover's comment above) — only spacing tightened, so this is real
  // content packed more efficiently, not padding removed to fake fullness.
  // D-12 (2026-08-03): 12px -> the 13pt section tier (same reason as the margin:5px variant).
  var HEAD = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:4px 0 3px';
  var BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.38';
  var UL = 'margin:1px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.38';

  // 2026-07-29 (months + Future Work rebuild): SAME single derivation _rptA36PhaseTableInnerHTML
  // uses (see PRICING_PROPOSAL_TERM_PHASE_COUNT / _pricingProposalTermAndFuture header comments) —
  // this site and the Phase table page can never disagree about which phase is the term vs. Future
  // Work.
  var td = _pricingProposalTermAndFuture(d.project.id);
  var tl = td.tl;
  var termPhases = td.termPhases;
  var futurePhases = td.futurePhases;
  var monthLabels = _pricingProposalTermMonthLabels(termPhases);

  // phaseTableOn (2026-07-29, fix: Phase-Table-off silent-truncation gap — reviewer-caught):
  // proposalPhaseTable and proposalVision are two INDEPENDENT toggles a user can check/uncheck
  // separately (this function's own header comment has documented Phase-Table-off/Vision-on as a
  // supported combination since before this branch). Future Work normally renders on the Phase
  // Table page (_rptA36PhaseTableInnerHTML) — if that page did NOT run, this page must carry
  // Future Work itself, or the silent-truncation defect this branch closes comes right back for
  // this one toggle combination. Defaults to true (assume the Phase Table page rendered) when
  // `opts` doesn't say otherwise, so any call site that doesn't pass this flag keeps prior
  // behavior (no double-render risk from an unrelated caller).
  var phaseTableOn = !(opts && opts.proposalPhaseTableOn === false);

  var implTable = '';
  if (tl && termPhases.length) {
    // 2026-07-29 (months rebuild): the old per-phase "Phase | Sequence" mini-table (one row per
    // Phase 1/2/3 with an ordinal First/Second/Third priority column) is REMOVED — with only ONE
    // term phase now shown (see PRICING_PROPOSAL_TERM_PHASE_COUNT), that table would render a
    // single content-free row duplicating what the Recommended Energy Management Services table above
    // already shows under real month headers. Replaced with one sentence naming the term's actual
    // months (derived, never hardcoded — see _pricingProposalTermMonthLabels) and the same
    // no-fixed-end-date funding language the table used to carry.
    var termRangeLabel = monthLabels.length
      ? monthLabels.length > 1
        ? monthLabels[0] + ' – ' + monthLabels[monthLabels.length - 1]
        : monthLabels[0]
      : termPhases[0].label;
    // "the schedule earlier in this proposal" only makes sense when the Phase Table page actually
    // ran ahead of this one — when it's off, say what the term is without pointing at a table that
    // isn't in the document.
    //
    // R7 (2026-08-03, V-21): the cross-reference used to read "...is detailed in the Recommended
    // Energy Management Services table above." Two things were wrong with it. The table is not
    // captioned "Recommended Energy Management Services" — its caption/first column header reads
    // "Included Improvements" — so a reader hunting for that name finds nothing. And it is not
    // "above": it sits one to two pages BACK, because the schedule paginates across pages
    // (rptPageASHRAE36ProposalPhaseTable). The reference now names the real caption and points the
    // right direction.
    var termRangeIntro = phaseTableOn
      ? 'The current term (' +
        esc(termRangeLabel) +
        ') is set out in the Included Improvements schedule earlier in this proposal.'
      : 'The current term runs ' + esc(termRangeLabel) + '.';
    // R7 (2026-08-03, V-22): the second sentence used to assert "Phases are sequenced by expected
    // return on investment: the highest-return measures come first." Ranking by what the work
    // returns to the client IS the real rule and is NOT being dropped — but the schedule this
    // sentence points at carries no return, savings, cost, or priority column, so nothing the
    // client can see demonstrates the ranking, and stating it as a demonstrated property of the
    // table invites "then show me the numbers". Reworded to state it as the rule Control Service
    // Company applies when it builds the schedule (which the visible month ordering is the OUTPUT
    // of), rather than as something the table proves.
    //
    // R7 (2026-08-03, V-23): heading was "Implementation Plan &amp; Long-Term Vision" — the only
    // heading in the document using an ampersand where every other spells out "and", AND it named
    // "Long-Term Vision", which appears again as its own heading one paragraph below. Both are
    // fixed by naming this section for what it actually contains ("Implementation Plan"); the
    // Long-Term Vision heading below now owns that subject outright instead of sharing it.
    implTable =
      '<div style="' +
      HEAD +
      '">Implementation Plan</div>' +
      '<div style="' +
      BODY +
      '">' +
      termRangeIntro +
      ' Control Service Company orders the work by the return each ' +
      'improvement is expected to deliver to ' +
      esc(displayClient) +
      ', so the improvements expected to return the most are carried out first. Each stage of the ' +
      'work is funded through the monthly service allowance as it is completed, with no fixed end ' +
      'date; the service continues for as long as improvement opportunities remain.</div>';
  } else {
    // R7 (2026-08-03, V-23): same heading fix as the priced branch above — this
    // no-pricing-data fallback carried its own copy of the ampersand heading and would have
    // reintroduced it for any project that has not been priced yet.
    implTable =
      '<div style="' +
      HEAD +
      '">Implementation Plan</div>' +
      '<div style="' +
      BODY +
      '">A calendar-phase schedule will populate here once pricing data has been imported and ' +
      'priced for this project.</div>';
  }

  // futureWorkFallbackHTML (2026-07-29, fix: Phase-Table-off silent-truncation gap): Future Work
  // normally renders on the Phase Table page (_rptA36PhaseTableInnerHTML's
  // standaloneFutureWorkHTML / futureRowHTML) — directly under/inside the term table it belongs
  // with. When that page is OFF (phaseTableOn === false), this page is the only remaining place a
  // client would ever see it, so it falls back to rendering the SAME _rptA36FutureWorkInnerHTML
  // helper the Phase Table page uses — never a second copy of the Future Work markup, so the two
  // call sites can never disagree about content. When the Phase Table page IS on, this stays ''
  // so Future Work is never rendered twice.
  var futureWorkFallbackHTML = phaseTableOn ? '' : _rptA36FutureWorkInnerHTML(futurePhases, HEAD, BODY);

  var longTermVision =
    '<div style="' +
    HEAD +
    '">Long-Term Vision</div>' +
    '<div style="' +
    BODY +
    '">The objective of the Recommended Energy Management Services is not simply to complete a one-time ' +
    'project. The objective is to continuously improve heating and cooling system performance, increase energy ' +
    'efficiency, improve occupant comfort, and progressively increase ASHRAE 36 alignments across ' +
    'the ' +
    esc(displayClient) +
    ' portfolio.</div>' +
    '<div style="' +
    BODY +
    ';margin-top:4px">As buildings and systems are optimized, future opportunities may include:</div>' +
    '<ul style="' +
    UL +
    '">' +
    '<li>Additional ASHRAE 36 sequence implementation</li>' +
    '<li>Enhanced fault detection and diagnostics</li>' +
    '<li>Advanced energy optimization strategies</li>' +
    '<li>Additional sensor deployments</li>' +
    '<li>Extended analytics and performance reporting</li>' +
    '<li>Ongoing programming refinements</li>' +
    '</ul>' +
    '<div style="' +
    BODY +
    ';margin-top:4px">These future improvements can be prioritized and implemented as part of the ' +
    'ongoing Energy Management Services based on operational needs, budget priorities, and observed ' +
    'building performance.</div>';

  // Expected Outcomes section REMOVED 2026-07-27 (client review, verbatim: "Just get rid of the
  // entire Expected Outcomes page. No questions."). Was previously a bullet-list section inside
  // this page (rptPageASHRAE36ProposalVision), not a standalone page — the earlier standalone
  // rptPageASHRAE36ProposalOutcomes page function was already removed on 2026-07-22 (see the
  // header comment above rptPageASHRAE36ProposalPhaseTable). Not preserved as an opt-in section,
  // per the client's explicit instruction.

  // R7 (2026-08-03, V-20): the disclaimer used to read "Energy savings estimates are based on
  // published research studies and engineering calculations representing typical applications.
  // Actual savings depend on equipment condition, occupancy patterns, utility rates, weather
  // conditions, operational practices, and implementation quality." That caveats numbers this
  // document does not contain: there is NO savings estimate anywhere in the Service Proposal, by
  // Matt's explicit 2026-07-29 decision to anchor no fixed total, timeline, or savings figure in a
  // monthly-agreement deliverable. A caveat about figures that were never presented tells a county
  // attorney that content was removed and the boilerplate was not, and invites the one question
  // this document is deliberately built not to raise ("where are the savings numbers?"). Rewritten
  // to caveat only what the document actually says: the readiness findings it is built on, the
  // month-by-month schedule, and the allowance. No savings figure was added to close the gap — the
  // decision to keep dollar figures out of this document stands.
  var disclaimer =
    '<div style="' +
    HEAD +
    '">Disclaimer</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.35;font-style:italic">' +
    'The improvements listed in this proposal, and the month each one is scheduled for, reflect the ' +
    'conditions found during the ASHRAE 36 readiness assessment of the ' +
    esc(displayClient) +
    ' portfolio. Scheduling may be adjusted as equipment condition, building access, and operating ' +
    'priorities are confirmed in the field. Work is carried out under the monthly service allowance ' +
    'described in this proposal, which covers parts, materials, and on-site labor hours.' +
    '</div>';

  return implTable + futureWorkFallbackHTML + longTermVision + disclaimer;
}

/**
 * rptPageASHRAE36ProposalVision — standalone Implementation Plan & Long-Term Vision page. Kept as
 * an independent page-producing function for the case where a caller enables `proposalVision` but
 * disables `proposalPhaseTable` (or vice versa) via the section toggles — see
 * rptPageASHRAE36ProposalPhaseAndVision below for the merged-page path both flags default to.
 * proposalPhaseTable-off/proposalVision-on (2026-07-29, reviewer-caught fix): this combination is
 * real and independently selectable, so _rptA36VisionInnerHTML's `opts.proposalPhaseTableOn` flag
 * (threaded from generateASHRAE36ProposalHTML's `phaseOpts`) tells it whether the Phase Table page
 * ran; if not, it falls back to rendering Future Work itself (same _rptA36FutureWorkInnerHTML
 * helper the Phase Table page uses — never a duplicated copy) so this toggle combination can never
 * silently drop the future-phase category list again.
 */
function rptPageASHRAE36ProposalVision(n, d, opts) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var bodyHTML = '<div style="padding:8px 48px 4px">' + _rptA36VisionInnerHTML(d, opts) + '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: false,
    hideIntHdr: true,
    data: fakeData,
    label: 'Page ' + n + ' — Long-Term Vision',
  });
}

/**
 * rptPageASHRAE36ProposalPhaseAndVision — MERGED page 2 of the rebuilt Service Proposal
 * (2026-07-27, client review: "Rebalance pages 2 and 3... Seriously consider making this a
 * 2-page proposal... If page 3 holds only the Long-Term Program Vision and the Disclaimer,
 * merging that into page 2 is very likely the right answer."). Combines the Phase table content
 * (_rptA36PhaseTableInnerHTML) and the Implementation Plan/Long-Term Vision/Disclaimer content
 * (_rptA36VisionInnerHTML) onto ONE physical page, preserving the exact same narrative order the
 * two separate pages used. Both source functions' <table> elements carry
 * page-break-inside:avoid/break-inside:avoid so neither table can be split across a physical page
 * break even though this page's total content is taller than either original page alone. This is
 * the default path generateASHRAE36ProposalHTML takes whenever BOTH proposalPhaseTable and
 * proposalVision are selected (the default state) — rptPageASHRAE36ProposalPhaseTable and
 * rptPageASHRAE36ProposalVision remain as independent, still-callable standalone pages for the
 * (rare) case where only one of the two section toggles is enabled, so neither existing capability
 * is destroyed.
 */
function rptPageASHRAE36ProposalPhaseAndVision(n, d, opts) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  // Density pass (2026-07-27, page-2/3 merge): 2px/1px top/bottom padding (was 8px/4px) — the same
  // kind of spacing-only tightening _rptA36VisionInnerHTML's HEAD/BODY vars use, applied here to
  // the outermost wrapper. Real content packed more efficiently, not padding added to fake fullness.
  var bodyHTML =
    '<div style="padding:2px 48px 1px">' +
    _rptA36PhaseTableInnerHTML(d, opts) +
    _rptA36VisionInnerHTML(d, opts) +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: false,
    hideIntHdr: true,
    data: fakeData,
    label: 'Page ' + n + ' — Recommended Services & Long-Term Vision',
  });
}

// ─── rptPageASHRAE36ProposalComplianceScope / rptPageASHRAE36ProposalFullScope ────────────
/**
 * 2026-07-29 (fix/proposal-remove-fixed-anchors, Matt's approved spec, verbatim: "We do not want
 * to anchor a fixed total cost or timeline at all to them anywhere in anything we give them for a
 * monthly agreement... Just have the Service Proposal talk about what it would cost to get to
 * ASHRAE 36 compliance and what that entails."). Two NEW independent opt-in sections (both default
 * OFF — ASHRAE36_SECTIONS.proposal 'complianceScope' / 'fullScope'), replacing the deleted Cover-
 * page Stage 1/Stage 2 dollar-anchored blocks. Each describes the CATEGORIES of work its scope
 * entails and states it is funded through the monthly service allowance of $6,250/month — NEVER a
 * whole-scope dollar total. budgetFmt below follows the exact same _pricingGetBudget pattern
 * already used on rptPageASHRAE36ProposalCover / rptPageASHRAE36ProposalPhaseTable (copied, not
 * reinvented, per the companyhub-client-deliverables skill's "find it and copy it" instruction).
 */
function rptPageASHRAE36ProposalComplianceScope(n, d) {
  var displayClient = _rptProposalDisplayClientName(d.project.name);
  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  // D-12 (2026-08-03): 12px -> the 13pt section tier (same reason as the margin:5px variant).
  var HEAD = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:4px 0 3px';
  var BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.38';
  var UL = 'margin:2px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.38';

  var budgetFmt = null;
  try {
    if (typeof _pricingGetBudget === 'function') {
      var _b = _pricingGetBudget(d.project.id);
      if (_b && _b.amount != null && !isNaN(_b.amount) && Number(_b.amount) > 0) {
        budgetFmt = '$' + Math.round(Number(_b.amount)).toLocaleString('en-US');
      }
    }
  } catch (e) {
    budgetFmt = null;
  }

  // R7 (2026-08-03, V-15): this paragraph used to read "Before any ASHRAE 36 optimization sequence
  // can be programmed at Johnson County, the equipment it runs on needs the sensor and actuator
  // instrumentation that sequence depends on. This scope covers that instrumentation, along with
  // safety-critical programming such as freeze protection, the monitoring and safety foundation
  // every other measure in this service builds on." That is page 1's Assessment Findings sentence
  // restated almost verbatim ("The first is the instrumentation and safety programming every
  // ASHRAE 36 sequence depends on (sensors, actuators, and safety-critical programming such as
  // freeze protection), which must be in place before any optimization sequence can be
  // programmed."). Page 1 is where that point belongs — it is the argument the whole proposal
  // rests on and a reader who reads only the summary has to get it there. So the argument stays on
  // page 1 and is NOT repeated here; this section now does the one job page 1 does not, which is
  // to itemize what that first category of work actually covers. Nothing was deleted from the
  // document: the bullets and the funding sentence below are untouched, only the restatement above
  // them is gone.
  var bodyHTML =
    '<div style="padding:8px 48px 4px">' +
    '<div style="' +
    HEAD +
    '">ASHRAE 36 Compliance</div>' +
    '<div style="' +
    BODY +
    '">The first of the two categories of work named in the Assessment Findings covers the ' +
    'following across the ' +
    esc(displayClient) +
    ' portfolio:</div>' +
    '<ul style="' +
    UL +
    '">' +
    '<li>Sensor and actuator instrumentation required by ASHRAE 36 control sequences</li>' +
    '<li>Safety-critical programming, including freeze protection</li>' +
    '<li>Verification that each piece of equipment has the points it needs before sequence ' +
    'programming begins</li>' +
    '</ul>' +
    (budgetFmt
      ? '<div style="' +
        BODY +
        ';margin-top:6px">This work is funded through the same monthly service allowance of ' +
        budgetFmt +
        ' per month described earlier in this proposal. It is not billed as a separate project.' +
        '</div>'
      : '') +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: false,
    hideIntHdr: true,
    data: fakeData,
    label: 'Page ' + n + ' — ASHRAE 36 Compliance',
  });
}

function rptPageASHRAE36ProposalFullScope(n, d) {
  var displayClient = _rptProposalDisplayClientName(d.project.name);
  function esc(s) {
    return typeof _esc === 'function' ? _esc(s) : String(s == null ? '' : s);
  }
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  // D-12 (2026-08-03): 12px -> the 13pt section tier (same reason as the margin:5px variant).
  var HEAD = 'font-size:' + RPT_SECTION_HEAD_PX + 'px;font-weight:700;color:var(--rpt-page-text);margin:4px 0 3px';
  var BODY = 'font-size:14px;color:var(--rpt-page-text);line-height:1.38';
  var UL = 'margin:2px 0 0;padding-left:16px;font-size:14px;color:var(--rpt-page-text);line-height:1.38';

  var budgetFmt = null;
  try {
    if (typeof _pricingGetBudget === 'function') {
      var _b = _pricingGetBudget(d.project.id);
      if (_b && _b.amount != null && !isNaN(_b.amount) && Number(_b.amount) > 0) {
        budgetFmt = '$' + Math.round(Number(_b.amount)).toLocaleString('en-US');
      }
    }
  } catch (e) {
    budgetFmt = null;
  }

  var bodyHTML =
    '<div style="padding:8px 48px 4px">' +
    '<div style="' +
    HEAD +
    '">Full Scope</div>' +
    '<div style="' +
    BODY +
    '">Completing full ASHRAE 36 compliance across the ' +
    esc(displayClient) +
    ' portfolio means programming every applicable ASHRAE 36 optimization sequence on top of ' +
    'the instrumentation and safety programming above, and adding portfolio-wide reporting that ' +
    'continuously checks that every sequence keeps performing as intended.</div>' +
    '<ul style="' +
    UL +
    '">' +
    '<li>ASHRAE 36 optimization sequences: supply air temperature reset, duct static pressure ' +
    'reset, ventilation that adjusts to occupancy, economizer control, and the other sequences applicable ' +
    'to each piece of equipment</li>' +
    '<li>Portfolio-wide automatic fault detection and diagnostics reporting</li>' +
    '<li>Ongoing verification and tuning as sequences are commissioned</li>' +
    '</ul>' +
    (budgetFmt
      ? '<div style="' +
        BODY +
        ';margin-top:6px">This work is funded through the same monthly service allowance of ' +
        budgetFmt +
        ' per month described earlier in this proposal, phased in alongside the instrumentation ' +
        'work rather than billed as a separate project.</div>'
      : '') +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal', bodyHTML, {
    hero: false,
    hideIntHdr: true,
    data: fakeData,
    label: 'Page ' + n + ' — Full Scope',
  });
}

// ─── rptPageASHRAE36ProposalScope ─────────────────────────────────────────
/**
 * Phased scope of work auto-populated from audit findings.
 */
function rptPageASHRAE36ProposalScope(n, d) {
  var p = d.portfolio;
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // Phase 1: Hardware/sensor gaps; Phase 2: sequence programming gaps.
  // Derive the sequence key set from EM_SEQUENCE_DEFS (equipment-matrix.js)
  // so this list stays in sync with the actual sequence definitions.
  var SEQUENCE_KEYS =
    typeof EM_SEQUENCE_DEFS !== 'undefined' && Array.isArray(EM_SEQUENCE_DEFS)
      ? EM_SEQUENCE_DEFS.map(function (s) {
          return s.key;
        })
      : [];
  // Zone cooling/heating setpoint checks are locally controlled by the unit itself — this
  // proposal is monitoring-only, so a "point" implying CSC controls the setpoint is misleading.
  // Excluded here (proposal scope list only); not touched at the shared portfolio.topGaps source
  // so the Audit report's Recommendations page (which also reads topGaps) is unaffected.
  var SETPOINT_KEYS = ['zoneCoolSp', 'zoneHtgSp', 'coolSP', 'htgSP'];
  // Damper actuator points (OA/RA/zone/dual-duct) belong to the same physical control
  // measure per unit — a client-facing scope summary should show them as one combined line,
  // not one row per actuator. Consolidated below via _consolidateDamperGaps.
  var DAMPER_KEYS = ['oaDampCmd', 'raDampCmd', 'dampCmd', 'coldDampCmd', 'hotDampCmd'];

  function _consolidateDamperGaps(gaps) {
    var damperGaps = gaps.filter(function (g) {
      return DAMPER_KEYS.indexOf(g.key) !== -1;
    });
    if (damperGaps.length <= 1) return gaps; // nothing to consolidate
    var otherGaps = gaps.filter(function (g) {
      return DAMPER_KEYS.indexOf(g.key) === -1;
    });
    var totalCount = damperGaps.reduce(function (s, g) {
      return s + g.count;
    }, 0);
    var merged = {
      key: 'damperConsolidated',
      count: totalCount,
      desc: {
        short: 'Damper actuator control (outdoor air / return air / zone)',
        impact: 'Required for economizer and zone airflow control',
        plain:
          'Provides modulating damper control for outdoor air intake, return air balancing, and zone airflow ' +
          'delivery, which is required for economizer operation and to meet zone ventilation and temperature targets.',
      },
    };
    return otherGaps.concat([merged]);
  }

  var phase1Gaps = _consolidateDamperGaps(
    p.topGaps.filter(function (g) {
      return SEQUENCE_KEYS.indexOf(g.key) === -1 && SETPOINT_KEYS.indexOf(g.key) === -1;
    }),
  );
  var phase2Gaps = p.topGaps.filter(function (g) {
    return SEQUENCE_KEYS.indexOf(g.key) !== -1 && SETPOINT_KEYS.indexOf(g.key) === -1;
  });

  // DCV/CO2 scope row — populated from portfolio.dcv counts (excluded from topGaps).
  // Shown only when at least one AHU or zone is missing a CO2 sensor.
  var dcv = p.dcv || {};
  var _dcvAhuMissing = dcv.ahuMissingCO2 || 0;
  var _dcvZonesMissing = dcv.zonesMissingCO2 || 0;
  var _dcvTotalMissing = _dcvAhuMissing + _dcvZonesMissing;
  var dcvScopeRow = '';
  if (_dcvTotalMissing > 0) {
    var _dcvScopeParts = [];
    if (_dcvAhuMissing > 0) _dcvScopeParts.push(_dcvAhuMissing + ' air handler' + (_dcvAhuMissing > 1 ? 's' : ''));
    if (_dcvZonesMissing > 0) _dcvScopeParts.push(_dcvZonesMissing + ' zone' + (_dcvZonesMissing > 1 ? 's' : ''));
    var _dcvScopeStr = _dcvScopeParts.join(', ');
    dcvScopeRow =
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      'Carbon dioxide sensors for ventilation that adjusts to occupancy' +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      _dcvScopeStr +
      ' affected' +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border:1px solid var(--rpt-border)">' +
      'Avoids conditioning air for empty rooms' +
      '</td>' +
      '</tr>';
  }

  function scopeRow(gap) {
    var desc = gap.desc || {};
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      (desc.short || gap.key) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      gap.count +
      ' units affected</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border:1px solid var(--rpt-border)">' +
      (desc.impact || '—') +
      '</td>' +
      '</tr>'
    );
  }

  // Design-language pass (2026-07-26, fix/proposal-clientname-and-legacy-styling): these were
  // dark-blue filled header rows (color:#fff on background:var(--rpt-blue)) — the opt-in legacy
  // Scope/Pricing pages used a different table-header treatment than the rebuilt default pages
  // 1-3, so a document with all sections on looked like two reports stapled together. Restyled to
  // match pages 1-3's thPlain convention (rptPageASHRAE36ProposalCover): plain bold text, thin
  // var(--rpt-rule) border, no fill. Content/values unchanged — styling only.
  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)';

  var ph1HTML =
    phase1Gaps.length || dcvScopeRow
      ? '<table style="width:100%;border-collapse:collapse;margin-bottom:4px">' +
        '<thead><tr><th style="' +
        thStyle +
        '">Work Item</th><th style="' +
        thStyle +
        '">Scope</th><th style="' +
        thStyle +
        '">Typical Savings</th></tr></thead>' +
        '<tbody>' +
        // DCV/CO2 sensors lead the Phase 1 list — easy install, high-value data, per Matt's
        // decision (was appended last; now rendered first).
        dcvScopeRow +
        phase1Gaps.map(scopeRow).join('') +
        '</tbody></table>'
      : '<div style="font-size:11px;color:var(--rpt-green);padding:6px">No hardware gaps identified. All required sensors and actuators appear to be present.</div>';

  var ph2HTML = phase2Gaps.length
    ? '<table style="width:100%;border-collapse:collapse;margin-bottom:4px">' +
      '<thead><tr><th style="' +
      thStyle +
      '">Sequence</th><th style="' +
      thStyle +
      '">Scope</th><th style="' +
      thStyle +
      '">Typical Savings</th></tr></thead>' +
      '<tbody>' +
      phase2Gaps.map(scopeRow).join('') +
      '</tbody></table>'
    : '<div style="font-size:11px;color:var(--rpt-green);padding:6px">No sequence programming gaps identified. All key ASHRAE 36 sequences appear to be active.</div>';

  // Batch 3 item 4 (design-language pass extended to a flagged spot, per bolding-consistency-
  // audit.md finding #2): "more human / less colored fill" treatment — colored border + colored
  // title (var(--rpt-blue) and hardcoded #7c3aed purple) → var(--rpt-rule) border + black title.
  var bodyHTML =
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:' +
    RPT_SECTION_HEAD_PX +
    'px;font-weight:700;color:var(--rpt-page-text);margin-bottom:6px;border-bottom:2px solid var(--rpt-rule);padding-bottom:3px">Phase 1: Hardware &amp; Sensor Upgrades</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Installation of missing sensors and actuators required for ASHRAE 36 compliance. This phase establishes the hardware foundation for sequence programming.</div>' +
    ph1HTML +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:' +
    RPT_SECTION_HEAD_PX +
    'px;font-weight:700;color:var(--rpt-page-text);margin-bottom:6px;border-bottom:2px solid var(--rpt-rule);padding-bottom:3px">Phase 2: Building Automation System Sequence Programming</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Programming of ASHRAE 36 control sequences in the building automation system. Sequences are tested and verified with occupied building conditions.</div>' +
    ph2HTML +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal: Scope of Work', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Scope of Work',
  });
}

// ─── rptPageASHRAE36ProposalPricing ──────────────────────────────────────────
/**
 * Cost Estimate page for the Service Proposal (opt-in, default OFF — item ebfca114).
 *
 * Renders a three-column Recommended / Compliance / Full Scope comparison with the final
 * client-facing dollar total for each scope. The numbers come from the SAME call chain the
 * interactive Cost Estimate tab's Summary sub-tab uses:
 *   _pricingGetEstimate(projId)  ->  _pricingComputeSummaryData(projId, estimate)
 * (mirrors pricing-estimator.js _pricingRenderSummaryTab, which does the identical two calls),
 * so a byte-identical estimate produces byte-identical totals. NO new pricing math here.
 *
 * SAFETY (client PDF): prints ONLY the three final tier grand totals ($). It never prints any
 * internal cost build-up — no hourly labor rate, no contract/net multiplier, no savingsRationale,
 * no impact-tier tags. The three totals are INDEPENDENT numbers; no ordering between them is
 * asserted (Recommended is NOT guaranteed <= Compliance in the underlying code). The M&V /
 * savings disclaimer is attached wherever these estimates appear.
 *
 * Returns an ARRAY (always length 1 — 3 tiers x 1 total cannot overflow one 8.5x11 sheet) so the
 * call site can spread it the same way the Audit's page functions are spread.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data()
 * @returns {Array<string>} single-element array of rptPage() HTML
 */
// ─── Tier detail expand/collapse (Interactive preview + PDF all-expanded) ────────────────
/**
 * _rptToggleTierDetail — click handler for the per-tier "Install & Programming Detail"
 * affordance in the live #reportOverlay preview (rptPageASHRAE36ProposalPricing). Toggles the
 * matching detail panel's visibility and flips the button's chevron/aria-expanded state.
 * This interactivity lives ONLY in the live overlay DOM — the exported PDF is a flat
 * html2canvas raster (no click survives export), so exportReportToPDF() force-expands every
 * tier's panel before capture instead of relying on this function. See
 * _rptA36TierDetailPanelHTML / _rptA36TierDetailToggleHTML below.
 */
function _rptToggleTierDetail(tierKey) {
  var panel = document.getElementById('rpt-tier-detail-' + tierKey);
  var btn = document.getElementById('rpt-tier-toggle-' + tierKey);
  if (!panel) return;
  var isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (btn) {
    btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    var chev = btn.querySelector('.rpt-tier-chev');
    if (chev) chev.textContent = isOpen ? '▸' : '▾'; // ▸ collapsed / ▾ expanded
    var lbl = btn.querySelector('.rpt-tier-toggle-label');
    if (lbl) lbl.textContent = isOpen ? 'Install & Programming Detail' : 'Hide Install & Programming Detail';
  }
}
window._rptToggleTierDetail = _rptToggleTierDetail;

/**
 * _rptA36TierDetailToggleHTML — the clickable header affordance for one tier column.
 * Collapsed by default (aria-expanded="false"); PDF export forces the sibling panel open but
 * leaves this button's own label/chevron in their collapsed appearance since it is inert in the
 * exported document either way.
 * Design-language pass (report-export-fixes, 2026-07-22): dropped the bordered/border-radius/
 * white-fill button treatment (box styling banned in client reports, rule 4.3) — plain colored
 * text link, no box, matching every other inline affordance in this report.
 */
function _rptA36TierDetailToggleHTML(key) {
  return (
    '<div id="rpt-tier-toggle-' +
    key +
    '" role="button" tabindex="0" aria-expanded="false" ' +
    'onclick="_rptToggleTierDetail(\'' +
    key +
    '\')" ' +
    "onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();_rptToggleTierDetail('" +
    key +
    '\')}" ' +
    'style="cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;' +
    'padding:4px 0;' +
    'font-size:9px;font-weight:700;color:var(--rpt-blue);text-transform:uppercase;letter-spacing:0.04em">' +
    '<span class="rpt-tier-chev">▸</span>' +
    '<span class="rpt-tier-toggle-label">Install &amp; Programming Detail</span>' +
    '</div>'
  );
}

/**
 * _rptA36TierDetailAggByPhase — groups one tier's priced rows by distinct item name for a given
 * phase (1 = Hardware & Installation, 2 = Programming & Commissioning), summing qty/lineTotal
 * across every building carrying that same item. Mirrors the aggregation
 * rptPageASHRAE36ProposalPricing's own _buildItemizedPages() already uses (same dedupe-by-item,
 * same rowToggles respect) — NO new pricing math, this only reshapes the SAME rows.
 * unitPrice (2026-07-22, Task 1a) is DERIVED here (lineTotal/qty), never a separately tracked
 * field, so qty × unitPrice always foots exactly to lineTotal — added because Matt flagged
 * aggregated lines like "Supply Air Temp x46 $14,449" as reading like a mystery number with no
 * visible unit cost; _rptA36TierDetailPanelHTML below now prints the multiplication explicitly.
 */
function _rptA36TierDetailAggByPhase(rows, phaseNum, toggles) {
  var included = rows.filter(function (r) {
    var key = r._baseId || r.id;
    return r.phase === phaseNum && toggles[key] !== false;
  });
  var byItem = {};
  var order = [];
  included.forEach(function (r) {
    var key = r.item || '(unnamed)';
    if (!byItem[key]) {
      byItem[key] = { item: r.item, qty: 0, lineTotal: 0 };
      order.push(key);
    }
    byItem[key].qty += r.qty || 0;
    byItem[key].lineTotal += r.lineTotal || 0;
  });
  return order.map(function (k) {
    var it = byItem[k];
    it.unitPrice = it.qty > 0 ? it.lineTotal / it.qty : null;
    return it;
  });
}

/**
 * _RPT_A36_DEVICE_CLASS_LABEL — client-facing category names for the Hardware & Installation
 * device-class taxonomy already defined in pricing-estimator.js (POINT_KEY_INSTALL_CLASS /
 * INSTALL_HOURS_BY_DEVICE_CLASS_DEFAULT — Deliverable E, 2026-07-19). Reused here (not a new
 * taxonomy) purely to LABEL each existing class for a client reader; no new categorization logic,
 * no pricing math. Any pointKey not present in POINT_KEY_INSTALL_CLASS falls back to "Other
 * Hardware" in _rptA36HardwareCategoryAgg below (forward-compatible with future catalog entries).
 */
var _RPT_A36_DEVICE_CLASS_LABEL = {
  spaceZoneSensor: 'Zone Sensors (Temperature/Humidity/Carbon Dioxide)',
  ductTempRhSensor: 'Duct Temperature Sensors',
  ductStaticPressureSensor: 'Duct Static Pressure Sensors',
  immersionWellTempSensor: 'Hydronic Temperature Sensors',
  damperActuator: 'Outdoor/Return Air Damper Actuators',
  valveActuator: 'Valve Actuators',
  controlValveActuator: 'Control Valve Actuators',
  currentSwitchStatusRelay: 'Status Sensing Relays',
  diffPressureSwitch: 'Differential Pressure Sensors',
  unitaryDdcController: 'Zone Controllers',
  ahuPlantDdcController: 'Air Handler/Plant Controllers',
  flowBtuMeter: 'Flow Meters',
  vfdIntegration: 'Variable Frequency Drive Integration',
  networkRouterGateway: 'Network Gateways',
  thermostat: 'Thermostats',
};

/**
 * _rptA36HardwareCategoryAgg — condenses one tier's Phase 1 (Hardware & Installation) rows into a
 * short, client-readable list: one line per device CATEGORY (qty + dollar subtotal), plus a single
 * summary line for every existing-controller I/O point that needs only programming exposure (no
 * new hardware, $0 by definition — see the ioOnly flag set in buildCatalogRows/pricing-estimator.js).
 * Added 2026-07-27 (Matt, repeat complaint: "the Cost Estimate section still needs a lot of work...
 * too much detail" + "The Compliance and Full Scope is huge!") — replaces the prior one-bullet-per-
 * distinct-item-name list (still available via _rptA36TierDetailAggByPhase, used unchanged for the
 * Programming section, which was never the length complaint) with categories a client can act on:
 * "a client needs the scope and the total, not every row" (task spec). NO new pricing math — every
 * dollar figure here is a sum of the SAME row.lineTotal values the prior bullet list totaled, just
 * grouped by category instead of by item name.
 */
function _rptA36HardwareCategoryAgg(rows, toggles) {
  var included = rows.filter(function (r) {
    var key = r._baseId || r.id;
    return r.phase === 1 && toggles[key] !== false;
  });
  var byCat = {};
  var order = [];
  var ioOnlyQty = 0;
  var ioOnlyCount = 0;
  included.forEach(function (r) {
    if (r.ioOnly) {
      ioOnlyQty += r.qty || 0;
      ioOnlyCount++;
      return;
    }
    var cls = (typeof POINT_KEY_INSTALL_CLASS !== 'undefined' && POINT_KEY_INSTALL_CLASS[r._pointKey]) || null;
    var label = (cls && _RPT_A36_DEVICE_CLASS_LABEL[cls]) || 'Other Hardware';
    if (!byCat[label]) {
      byCat[label] = { label: label, qty: 0, lineTotal: 0 };
      order.push(label);
    }
    byCat[label].qty += r.qty || 0;
    byCat[label].lineTotal += r.lineTotal || 0;
  });
  var categories = order
    .map(function (k) {
      return byCat[k];
    })
    .sort(function (a, b) {
      return b.lineTotal - a.lineTotal;
    });
  return { categories: categories, ioOnlyQty: ioOnlyQty, ioOnlyCount: ioOnlyCount };
}

/**
 * _rptA36TierDetailPanelHTML — the collapsible content itself: a concise, HIGH-LEVEL breakdown
 * of one tier's Hardware & Installation and Programming & Commissioning content. The two
 * subtotal dollar figures are the SAME tt[key].phase1 / tt[key].phase2 values the phaseSplitRow
 * above already prints (so the detail can never disagree with the tier table) — no new pricing
 * math. Programming still lists one row per sequence (already category-level — a handful of rows,
 * never the length complaint). Hardware & Installation (2026-07-27 rework — Matt, repeat
 * complaint: "too much detail" + "The Compliance and Full Scope is huge!") now groups by DEVICE
 * CATEGORY via _rptA36HardwareCategoryAgg instead of one bullet per distinct item name — a
 * portfolio with 40+ distinct hardware line items previously produced 40+ bullets; it now produces
 * one line per category (a handful) plus one summary line for every existing-controller I/O point
 * needing only programming exposure. Starts hidden (display:none) — exportReportToPDF() forces
 * every tier's panel open before html2canvas so nothing is hidden in the flat PDF.
 */
function _rptA36TierDetailPanelHTML(key, tt, summaryData, estimateState, wantItemized, fmtUSD) {
  var rows = (summaryData && summaryData.perTier && summaryData.perTier[key]) || [];
  var toggles = (estimateState && estimateState.rowToggles) || {};
  var hwAgg = _rptA36HardwareCategoryAgg(rows, toggles);
  var lb = _rptA36TierDetailAggByPhase(rows, 2, toggles);
  // Recommended (2026-07-27, Matt's correction): never show a Hardware/Programming dollar
  // subtotal or per-item price for this tier — those numbers are subtotals of the same one-time
  // lump total the amount row above no longer prints for Recommended. Category/item names still
  // list (so a reader still sees WHAT is included), just never priced individually here.
  var noDollarTier = key === 'recommended';
  var noCat = !noDollarTier && !!(tt && tt[key] && tt[key].noCatalog);
  var p1 = !noDollarTier && tt && tt[key] ? fmtUSD(tt[key].phase1) : null;
  var p2 = !noDollarTier && tt && tt[key] ? fmtUSD(tt[key].phase2) : null;
  if (noDollarTier) wantItemized = false;

  function _sectionHTMLCategories(subtotalStr, noCatFlag, agg) {
    var subtotalHTML = noCatFlag
      ? ' <span style="font-weight:400;color:var(--rpt-page-text)">(CSV needed for pricing)</span>'
      : subtotalStr
        ? ': <span style="font-weight:700">' + subtotalStr + '</span>'
        : '';
    var catLines = agg.categories.map(function (c) {
      var priceStr = '';
      // Same no-bare-$0 rule as every other price cell in this report (fix/65ce578b, 2026-07-27):
      // a category whose only members are ioOnly/unpriced (null coerced to 0 when summed) must
      // read as "no additional cost", never a literal "$0".
      if (wantItemized && c.lineTotal === 0) {
        priceStr = ': ' + c.qty + ' units, no additional cost';
      } else if (wantItemized && c.lineTotal != null && fmtUSD(c.lineTotal)) {
        priceStr = ': ' + c.qty + ' units, ' + fmtUSD(c.lineTotal);
      } else if (c.qty > 1) {
        priceStr = ' (qty ' + c.qty + ')';
      }
      return '<li>' + _esc(c.label) + priceStr + '</li>';
    });
    // Single summary line for every existing-controller I/O point (ioOnly, real scope, $0
    // hardware — see buildCatalogRows) instead of enumerating each one separately.
    if (agg.ioOnlyCount > 0) {
      catLines.push(
        '<li>Existing control points requiring programming only: ' + agg.ioOnlyQty + ' points, no additional cost</li>',
      );
    }
    var listHTML = catLines.length
      ? '<ul style="margin:2px 0 0;padding-left:14px;font-size:8.5px;color:var(--rpt-page-text);line-height:1.6">' +
        catLines.join('') +
        '</ul>'
      : '<div style="font-size:8.5px;color:var(--rpt-page-text);margin-top:2px">No items in this scope.</div>';
    return (
      '<div style="margin-bottom:6px">' +
      '<div style="font-size:9px;font-weight:700;color:var(--rpt-page-text)">' +
      'Hardware &amp; Installation' +
      subtotalHTML +
      '</div>' +
      listHTML +
      '</div>'
    );
  }

  function _sectionHTML(title, subtotalStr, noCatFlag, items) {
    // Grey (#666) removed (report-standard rule: grey text is banned in client documents) —
    // de-emphasis now comes from font-weight/size only, same convention used elsewhere in this
    // report (e.g. the footnote below this table).
    var subtotalHTML = noCatFlag
      ? ' <span style="font-weight:400;color:var(--rpt-page-text)">(CSV needed for pricing)</span>'
      : subtotalStr
        ? ': <span style="font-weight:700">' + subtotalStr + '</span>'
        : '';
    var listHTML = items.length
      ? '<ul style="margin:2px 0 0;padding-left:14px;font-size:8.5px;color:var(--rpt-page-text);line-height:1.6">' +
        items
          .map(function (it) {
            var priceStr = '';
            // fix/65ce578b (2026-07-27): a real, computed $0 (ioOnly rows -- existing controller
            // I/O points that need no new hardware, see pricing-estimator.js's ioOnly branch)
            // was rendering as "N × $0 = $0" / a bare "$0" -- banned per the no-$0-in-client-
            // output rule. These are real scope the client should still see (Matt: "do not
            // silently drop scope"), so the row/item stays; only the misleading $0 math is
            // replaced with a plain-English "no additional cost" label.
            if (wantItemized && it.lineTotal === 0) {
              priceStr = it.qty > 1 ? ': ' + it.qty + ' units, no additional cost' : ': no additional cost';
            } else if (wantItemized && it.lineTotal != null && fmtUSD(it.lineTotal)) {
              priceStr =
                it.qty > 1 && it.unitPrice != null && fmtUSD(it.unitPrice)
                  ? ': ' + it.qty + ' × ' + fmtUSD(it.unitPrice) + ' = ' + fmtUSD(it.lineTotal)
                  : ': ' + fmtUSD(it.lineTotal);
            } else if (it.qty > 1) {
              priceStr = ' (qty ' + it.qty + ')';
            }
            return '<li>' + _esc(it.item || '') + priceStr + '</li>';
          })
          .join('') +
        '</ul>'
      : '<div style="font-size:8.5px;color:var(--rpt-page-text);margin-top:2px">No items in this scope.</div>';
    return (
      '<div style="margin-bottom:6px">' +
      '<div style="font-size:9px;font-weight:700;color:var(--rpt-page-text)">' +
      _esc(title) +
      subtotalHTML +
      '</div>' +
      listHTML +
      '</div>'
    );
  }

  // Design-language pass (report-export-fixes, 2026-07-22): dropped the bordered/rounded/
  // white-fill card treatment (box styling banned in client reports, rule 4.3) — plain spacing
  // with a single thin top divider, same "whitespace + thin border only" convention as
  // .rpt-a36-callout and the disclaimer block below this table.
  var recNote = noDollarTier
    ? '<div style="font-size:8.5px;color:var(--rpt-page-text);font-style:italic;margin-bottom:4px">' +
      'Delivered as part of the monthly service allowance shown above, not billed separately.' +
      '</div>'
    : '';

  return (
    '<div id="rpt-tier-detail-' +
    key +
    '" style="display:none;margin-top:6px;padding-top:6px;' +
    'border-top:1px solid var(--rpt-rule);text-align:left">' +
    recNote +
    _sectionHTMLCategories(p1, noCat, hwAgg) +
    _sectionHTML('Programming', p2, false, lb) +
    '</div>'
  );
}

/**
 * _rptA36RecommendedTimelineHTML — Task 2 (2026-07-22); rebuilt 2026-07-26 (fix/phase-cost-
 * budget-model); REFRAMED 2026-07-27 (Matt's correction: "stop thinking of the recommended as a
 * 1 time cost... here is the timeline through 2028 and what parts/programming will happen during
 * that time"). This table used to carry two dollar columns (Phase Service Allowance, Priced
 * Measures This Phase) that, read side by side, reconstructed the exact one-time lump-sum framing
 * Matt is rejecting — a reader could add them up into a project total again even after the amount
 * row above stopped showing one. Matt's own hand-built target document (spec:
 * AI/_context/specs/joco-service-proposal-target-2026-07-23.md, Table 2 and Table 3) carries NO
 * dollar figures anywhere in its phase tables — the $6,250/month figure is stated exactly once, in
 * the Recommended Energy Management Services paragraph. This rebuild follows that: a plain schedule of
 * WORK (Phase / Sequence / Included Improvements) — no boxes/cards, no dollars, no footer total.
 * ("Date Range" and "Facilities Included" were both later removed — see the dated notes below.)
 * "Included Improvements" originally reused the SAME _rptA36PhaseImprovementsText helper the
 * Phase Table page used, on the theory that sharing a helper would keep the two tables from
 * disagreeing. STALE as of 2026-08-02 (fix/costest-wording-and-rounding): by then the Phase Table
 * page (_rptA36PhaseTableDerive) had been rebuilt (2026-07-31 rows-as-term-units matrix rebuild)
 * to name literal per-unit sequence+building+equipment text instead of calling that helper at all,
 * so "sharing a helper" no longer meant "saying the same thing" — this table kept the old bucketed
 * generic phrasing ("fan energy optimization", "building automation system programming") while
 * page 2 named specific sequences ("Duct Static Pressure Reset", "Reheat Valve Control"), a real
 * client-visible mismatch (Matt's investigation finding: "it feels like what is in there does not
 * match the Cost Estimate at all"). Fixed by switching this cell to _rptA36PhaseSeqCategoryNames
 * (see that call site's own comment below) — the literal-name helper the Future Work row on THIS
 * SAME table already used, so all three (page 2, this term row, this table's own Future Work row)
 * now share one literal-name source. _rptA36PhaseImprovementsText itself is unchanged, kept only
 * as this call site's defensive fallback. Reuses _pricingComputeRecommendedTimeline
 * (app/pricing-estimator.js) — the SAME computation the interactive Cost Estimate tab's Recommended
 * view renders via _pricingRecommendedTimelineHTML (which is UNCHANGED — that tab is Matt's
 * internal planning tool and keeps its phase envelope/measures-total/labor breakdown columns).
 * Guarded/silent (returns '') when the computation isn't available or returns null (nothing priced
 * yet), same convention as discBlock/svcBlock.
 * "Facilities Included" column REMOVED (2026-07-29, overflow fix): on the real JOCO portfolio (27
 * buildings) this column's per-phase "(continues in Phase X, Y, Z...)" text pushed the table
 * ~276px past the page footer, cutting the Phase 3 row into the footer wave graphic. Same
 * treatment as commit 3062dcd, which removed the identical "Facilities Included" row from the
 * sibling Service Proposal phase table (_rptA36PhaseTableInnerHTML) for the same reason (Matt:
 * "why would you put continues in phase x for every building? That is redundant."). facilitiesText
 * itself (pricing-estimator.js) is untouched — it still feeds the interactive Cost Estimate tab's
 * own Recommended timeline table (_pricingRecommendedTimelineHTML), Matt's internal planning view,
 * which is unpaginated and keeps its "Facilities Included" column.
 */
function _rptA36RecommendedTimelineHTML(d) {
  if (typeof _pricingComputeRecommendedTimeline !== 'function') return '';
  // 2026-07-29 (months + Future Work rebuild): SAME single derivation the Phase table page and the
  // Vision page use — see PRICING_PROPOSAL_TERM_PHASE_COUNT / _pricingProposalTermAndFuture header
  // comments. This is the third of the three sites that used to independently
  // `tl.phases.slice(0, PRICING_PROPOSAL_MAX_PHASES)`.
  var td = _pricingProposalTermAndFuture(d.project.id);
  var tl = td.tl;
  var termPhases = td.termPhases;
  var futurePhases = td.futurePhases;
  if (!tl || !termPhases.length) return '';

  var colgroup = '<colgroup><col style="width:70px"><col style="width:110px"><col style="width:504px">' + '</colgroup>';
  // Design-language pass (2026-07-26, fix/proposal-clientname-and-legacy-styling): dropped the
  // filled dark-blue header (color:#fff on background:var(--rpt-blue)) to match pages 1-3's
  // plain/thin-bordered table convention — see the matching comment above rptPageASHRAE36ProposalScope's
  // thStyle. Styling only; no content/values changed.
  var thStyle =
    'padding:6px 8px;font-size:9px;font-weight:700;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)';
  var tdStyle =
    'padding:6px 8px;font-size:9px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);vertical-align:top';

  // 2026-07-29 (fix/proposal-remove-fixed-anchors): "Date Range" column (p.dateRange — a fixed
  // Aug 2026 – Dec 2028-style calendar range) DELETED per Matt's approved spec, same treatment
  // applied to the identical column in _rptA36VisionInnerHTML's implTable above. Replaced with a
  // "Sequence" column stating ordinal priority only (first/second/third) — order is preserved,
  // the fixed-date anchor is not. p.dateRange itself is untouched in pricing-estimator.js.
  var _RPT_A36_TIMELINE_ORDINALS = ['First priority', 'Second priority', 'Third priority'];
  // Included Improvements wording fix (2026-08-02, fix/costest-wording-and-rounding): this cell
  // used to call _rptA36PhaseImprovementsText, which buckets a phase's rows into 5 fixed generic
  // phrases (e.g. "fan energy optimization", "building automation system programming") that never
  // name a specific sequence -- "Duct Static Pressure Reset" and "Reheat Valve Control" were never
  // literally named here even though they are the term's real priced work, and page 2's months
  // table (_rptA36PhaseTableDerive's unitRows, same file) names those exact sequences per unit.
  // Matt (investigation finding, verbatim): "it feels like what is in there does not match the
  // Cost Estimate at all." Fixed by reusing _rptA36PhaseSeqCategoryNames(p.rows) -- the SAME
  // literal-sequence-name derivation the Future Work row directly below already uses on this same
  // table (see futureCatNames a few lines down) -- instead of the bucketed-verb helper, so the
  // term row and the Future Work row on this table, AND page 2's months table, all draw their
  // sequence names from one shared source and can never independently drift into different
  // vocabularies again. _rptA36PhaseImprovementsText itself is left intact/unchanged (still used
  // nowhere else after this change -- kept in case a future caller needs the generic phrasing) and
  // is used here only as the defensive fallback for a phase with rows but no phase===2 seqKey rows
  // (should not occur for real term data -- see PRICING_PROPOSAL_TERM_PHASE_COUNT's header comment
  // on why Phase 1 is 100% programming on already-sensored equipment by construction -- but kept so
  // an edge case never renders an empty cell).
  var rowsHTML = termPhases
    .map(function (p, idx) {
      var catNames = typeof _rptA36PhaseSeqCategoryNames === 'function' ? _rptA36PhaseSeqCategoryNames(p.rows) : [];
      var improvements = catNames.length
        ? catNames.join(', ') + '.'
        : typeof _rptA36PhaseImprovementsText === 'function'
          ? _rptA36PhaseImprovementsText(p.rows, idx)
          : '';
      return (
        '<tr>' +
        '<td style="' +
        tdStyle +
        ';font-weight:700">' +
        _esc(p.label) +
        '</td>' +
        '<td style="' +
        tdStyle +
        '">' +
        (_RPT_A36_TIMELINE_ORDINALS[idx] || 'Additional priority') +
        '</td>' +
        '<td style="' +
        tdStyle +
        '">' +
        _esc(improvements) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  // Future Work row (2026-07-29): names every sequence category priced beyond the term (zero
  // dollars) so this internal Cost Estimate page's own timeline table can never independently
  // truncate the schedule again — same category-name source (_rptA36PhaseSeqCategoryNames) the
  // Phase table page and the Vision page's standalone Future Work section use.
  var futureAllRows = [];
  futurePhases.forEach(function (p) {
    if (p && p.rows) futureAllRows = futureAllRows.concat(p.rows);
  });
  var futureCatNames = _rptA36PhaseSeqCategoryNames(futureAllRows);
  if (futureCatNames.length) {
    rowsHTML +=
      '<tr>' +
      '<td style="' +
      tdStyle +
      ';font-weight:700">Future Work</td>' +
      '<td style="' +
      tdStyle +
      '">—</td>' +
      '<td style="' +
      tdStyle +
      '">Beyond the initial term: ' +
      _esc(futureCatNames.join(', ')) +
      '.</td>' +
      '</tr>';
  }

  // Client-safe transparency note — no dollar figures (2026-07-27 reframe). Ongoing Energy
  // Management Services labor is delivered throughout the engagement in addition to the improvements
  // listed above; the monthly cost of the whole engagement is already stated once in the Recommended
  // Energy Management Services section above, so it is intentionally not repeated here.
  var laborNote =
    '<div style="font-size:8.5px;color:var(--rpt-page-text);margin-top:4px;font-style:italic">' +
    'Continuous Energy Management Services (alarm configuration, report setup, trend ' +
    'configuration, utility bill data entry, and ongoing monitoring) are provided throughout the ' +
    'term in addition to the improvements listed above.' +
    '</div>';

  return (
    '<div style="margin-top:12px">' +
    // D-12 (2026-08-03): 11px -> the 13pt section tier.
    '<div style="font-size:' +
    RPT_SECTION_HEAD_PX +
    'px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
    'text-transform:uppercase;letter-spacing:0.04em">Recommended Energy Management Services: Phased Implementation Sequence</div>' +
    '<table style="width:684px;max-width:684px;border-collapse:collapse;font-size:9px;table-layout:fixed">' +
    colgroup +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    '">Phase</th>' +
    '<th style="' +
    thStyle +
    '">Sequence</th>' +
    '<th style="' +
    thStyle +
    '">Included Improvements</th>' +
    '</tr></thead>' +
    '<tbody>' +
    rowsHTML +
    '</tbody>' +
    '</table>' +
    laborNote +
    '</div>'
  );
}

function rptPageASHRAE36ProposalPricing(n, d, opts) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // Selectable pricing-detail sub-options (independent flags, only reach this function because the
  // parent costEstimate section is on — buildingInfra precedent). All default-off here; the caller
  // decides. Each renders additional client-safe detail from the SAME summary chain below.
  var o = opts || {};
  var wantPhaseSplit = o.phaseSplit === true;
  // 'perBuilding' sub-option + _buildPerBuildingPages removed 2026-07-22 (Matt: "The Cost
  // Estimate per building I do not like and it honestly gives no information. Just remove
  // completely.") — see the removal note further down this function, at the former call site.
  var wantItemized = o.itemized === true;

  // Final client-facing dollar total only. null (no priced rows / no catalog) => caller shows a
  // client-safe fallback string instead of "$null"/"$NaN".
  function _fmtUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return null;
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  // Pull the priced tier totals the interactive Cost Estimate tab shows for this project. Reads
  // whatever estimate state is saved at en_pricing_estimate_{projId} (row toggles, manual prices,
  // labor/qty overrides) — identical to what the tool's Summary sub-tab reflects. If the user has
  // never opened the tab, _pricingGetEstimate returns the all-on default.
  var tt = null;
  var summaryData = null; // full { buildings, tierTotals, perTier } — used by per-building / itemized
  var estimateState = null; // row toggles etc. — used to keep the itemized list matched to the totals
  try {
    if (typeof _pricingGetEstimate === 'function' && typeof _pricingComputeSummaryData === 'function') {
      estimateState = _pricingGetEstimate(d.project.id);
      summaryData = _pricingComputeSummaryData(d.project.id, estimateState);
      tt = summaryData && summaryData.tierTotals ? summaryData.tierTotals : null;
    }
  } catch (e) {
    tt = null; // non-fatal — fall through to the unpriced fallback copy
    summaryData = null;
    estimateState = null;
  }

  // Monthly service allowance (Matt's correction, 2026-07-27: "stop thinking of the recommended
  // as a 1 time cost. This is our monthly ongoing cost"). Same _pricingGetBudget(projId) call the
  // Proposal cover page and svcBlock below already use — no new math, just read earlier so amtRow
  // can use it.
  var budgetFmt = null;
  try {
    if (typeof _pricingGetBudget === 'function') {
      var _pB = _pricingGetBudget(d.project.id);
      if (_pB && _pB.amount != null && !isNaN(_pB.amount) && Number(_pB.amount) > 0) {
        budgetFmt = '$' + Math.round(Number(_pB.amount)).toLocaleString('en-US');
      }
    }
  } catch (e) {
    budgetFmt = null;
  }

  // Column order Recommended | Compliance | Full Scope is a readability choice, NOT an assertion
  // that the dollar totals ascend/descend in that order. DRAFT tier descriptions (pending Matt's
  // review) — worded to be accurate regardless of whether a recurring budget is configured.
  //
  // NO_DOLLAR_TIER (2026-07-27, Matt's correction): Compliance and Full Scope are one-time capital
  // options — a single project total is the correct way to show them. Recommended is NOT a capital
  // option; it is the ongoing monthly service allowance program (matches Matt's hand-built target
  // doc, spec: AI/_context/specs/joco-service-proposal-target-2026-07-23.md, which states the
  // recommendation as "$6,250 per Month", never as a lump project total). Every place below that
  // would otherwise print a one-time dollar figure for the 'recommended' key is gated on this
  // constant instead, so the monthly framing can never drift out of sync across the amount row,
  // phase-split row, and detail panels.
  var NO_DOLLAR_TIER = 'recommended';
  var tierCols = [
    {
      key: 'recommended',
      label: 'Recommended',
      desc: 'An ongoing monthly service funding the highest-impact opportunities first, not a one-time project cost.',
    },
    { key: 'compliance', label: 'Compliance', desc: 'Scope required to meet ASHRAE 36.' },
    { key: 'full-scope', label: 'Full Scope', desc: 'All identified upgrades across the portfolio.' },
  ];

  var titleBlock =
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
    'text-transform:uppercase;letter-spacing:0.04em">Cost Estimate</div>';

  // Rewritten 2026-07-27 (coordinator review of the monthly-framing fix): the prior copy said
  // "Each figure is an independent estimate of the total cost for that scope... totals should be
  // compared on their own terms" — accurate when all three columns were one-time totals, but the
  // amount row above no longer prints a total for Recommended, so that language directly
  // contradicted what the table now shows. Rewritten to state the real distinction up front:
  // Compliance/Full Scope are one-time capital projects with a total cost; Recommended is an
  // ongoing monthly program with no total, delivered over the phased schedule below.
  var intro =
    '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:12px">' +
    'The options below present three ways to address the assessment findings. Compliance and Full ' +
    'Scope are one-time capital projects, and each shows a total project cost. Recommended is ' +
    'different: it is an ongoing monthly service, not a project with a total cost. Its scope is ' +
    'delivered over time. See the phased schedule below for what is included and when.' +
    '</div>';

  // Table: 3 fixed columns, total width 684px (3 x 228). table-layout:fixed, black text, no colored
  // fill boxes. Design-language pass (2026-07-26, fix/proposal-clientname-and-legacy-styling):
  // header row was previously filled dark-blue with white text — restyled to match pages 1-3's
  // plain/thin-bordered convention (rptPageASHRAE36ProposalCover's thPlain): no fill, page-text
  // color, thin var(--rpt-rule) border.
  var colgroup = '<colgroup><col style="width:228px"><col style="width:228px"><col style="width:228px"></colgroup>';

  var thStyle =
    'padding:8px 10px;font-size:11px;font-weight:700;color:var(--rpt-page-text);' +
    'text-align:center;border:1px solid var(--rpt-border)';
  var headRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        return '<th style="' + thStyle + '">' + _esc(c.label) + '</th>';
      })
      .join('') +
    '</tr>';

  var descStyle =
    'padding:8px 10px;font-size:10px;color:var(--rpt-page-text);line-height:1.5;text-align:center;' +
    'border:1px solid var(--rpt-border);vertical-align:top';
  var descRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        return '<td style="' + descStyle + '">' + _esc(c.desc) + '</td>';
      })
      .join('') +
    '</tr>';

  // Full grid on every cell (report-export-fixes, 2026-07-22): the border-bottom:none/
  // border-top:none omissions previously here merged Estimated Cost/amount/phase-split/
  // detail rows into one seamless block per tier column — exactly the ad-hoc partial-border
  // pattern banned elsewhere in this report (rule 2, "real bordered grid table, not ad-hoc
  // lines"). Every cell in this table now carries a full 1px border on all 4 sides.
  var lblStyle =
    'padding:10px 10px 2px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;' +
    'color:var(--rpt-page-text);text-align:center;border:1px solid var(--rpt-border)';
  var lblRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        return (
          '<td style="' +
          lblStyle +
          '">' +
          (c.key === NO_DOLLAR_TIER ? 'Monthly Allowance' : 'Estimated Cost') +
          '</td>'
        );
      })
      .join('') +
    '</tr>';

  // _tierPartsRounded — the SINGLE derivation both amtRow (below) and phaseSplitRow (further
  // below) read from, so the printed Estimated Cost ALWAYS equals the sum of the printed
  // Hardware/Programming parts (fix/tier-hardware-programming-rounding, 2026-07-30).
  //
  // 2026-07-30 CORRECTION (coordinator review): the first version of this function rounded
  // phase1/phase2 independently and had amtRow display THEIR sum as the total. That fixed the
  // within-page mismatch but pointed the fix the wrong direction — it moved the displayed Full
  // Scope total from $1,422,158 up to $1,422,159, which no longer matches tt[key].grand
  // (1422158.1999999993, truthfully rounds to $1,422,158) or the in-app Cost Estimate tab, which
  // reads that same unchanged grand. A within-page mismatch traded for a cross-surface one is
  // worse: the total is the number that appears elsewhere and is authoritative, so it must be
  // rounded truthfully (Math.round(grand)) and the PARTS must absorb the rounding residual, never
  // the reverse.
  //
  // Implementation: the largest-remainder method (a.k.a. Hamilton's method — the standard
  // apportionment answer to "N numbers must round to individually-sensible values AND sum to an
  // already-fixed rounded total"). Floor every part, then hand out the dollars still owed
  // (totalR - sum of floors) one at a time to the parts with the largest fractional remainder —
  // the parts closest to rounding UP on their own get the extra dollar first. For Full Scope:
  // floor(1084721.70)=1084721, floor(337436.50)=337436, sum=1422157, totalR=1422158, 1 dollar
  // owed; hardware's remainder (.70) beats programming's (.50), so hardware gets it:
  // 1,084,722 + 337,436 = 1,422,158. Ties broken deterministically by lower part-index (phase1
  // before phase2) — arbitrary but stable and reproducible, never a coin flip.
  //
  // Generic over any number of parts (not special-cased to Hardware/Programming or to Full
  // Scope's specific values) — extend the `parts` array below and this still produces a valid
  // allocation. `owed` is provably in [0, parts.length] whenever every part is >= 0 (floor never
  // exceeds the true value; Math.round never differs from the true sum by more than 0.5) — true
  // for every real dollar amount this report ever prices; the loop bound below is still clamped
  // defensively so a pathological negative input can never run past the ranked list.
  //
  // Returns null when the tier has nothing priced (grand null), matching the existing "Available
  // upon request" fallback path unchanged.
  function _tierPartsRounded(key) {
    var t = tt && tt[key];
    if (!t || t.grand === null || t.grand === undefined || isNaN(t.grand)) return null;
    var totalR = Math.round(t.grand); // the authoritative total — same number every other surface reads
    var parts = [t.phase1 || 0, t.phase2 || 0];
    var floors = parts.map(function (v) {
      return Math.floor(v);
    });
    var owed =
      totalR -
      floors.reduce(function (s, v) {
        return s + v;
      }, 0);
    var ranked = parts
      .map(function (v, i) {
        return { i: i, frac: v - floors[i] };
      })
      .sort(function (a, b) {
        return b.frac - a.frac || a.i - b.i; // largest fractional remainder first; ties -> lower index wins
      });
    var result = floors.slice();
    for (var k = 0; k < owed && k < ranked.length; k++) {
      result[ranked[k].i] += 1;
    }
    return { p1r: result[0], p2r: result[1], totalR: totalR, noCatalog: !!t.noCatalog };
  }

  var amtStyle =
    'padding:2px 10px 12px;font-size:18px;font-weight:700;color:var(--rpt-page-text);text-align:center;' +
    'border:1px solid var(--rpt-border)';
  var amtRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        // Recommended (2026-07-27, Matt's correction): never print the tier's grand total as a
        // one-time figure — show the monthly service allowance instead, same budgetFmt the
        // Proposal cover page's "$6,250 per Month" line and svcBlock below both read from
        // _pricingGetBudget. Compliance/Full Scope are unaffected — still their one-time grand
        // totals, unchanged math.
        if (c.key === NO_DOLLAR_TIER) {
          var recDisplay = budgetFmt ? budgetFmt + ' per Month' : 'Available upon request';
          return '<td style="' + amtStyle + '">' + recDisplay + '</td>';
        }
        // Estimated Cost = the SAME rounded Hardware + Programming parts phaseSplitRow prints
        // below (_tierPartsRounded) — not an independent rounding of tt[c.key].grand (see that
        // helper's comment; fix/tier-hardware-programming-rounding, 2026-07-30).
        var parts = _tierPartsRounded(c.key);
        var g = parts ? _fmtUSD(parts.totalR) : null;
        // noCatalog guard mirrors the interactive Cost Estimate tab's own footer
        // (app/pricing-estimator.js:6314-6317 / 6291-6293): when no pricing catalog is imported,
        // .grand is labor-only (Phase 2 only, hardware unpriced) — prefix "Labor: " so the total
        // is never shown as an unqualified full-scope dollar figure.
        var noCat = parts && parts.noCatalog;
        var display = g ? (noCat ? 'Labor: ' + g : g) : 'Available upon request';
        return '<td style="' + amtStyle + '">' + display + '</td>';
      })
      .join('') +
    '</tr>';

  // Phase split (sub-option costEstimatePhaseSplit) — folds Phase 1 (hardware/install) vs Phase 2
  // (programming/commissioning) dollar SUBTOTALS into the SAME tier table, 0 added pages. Values
  // come from the SAME _tierPartsRounded(c.key) helper amtRow above reads (fix/tier-hardware-
  // programming-rounding, 2026-07-30) — so these two parts always sum exactly to the Estimated
  // Cost printed above them. Dollar subtotals only — no hourly rate, no markup mechanics.
  var phaseSplitRow = '';
  if (wantPhaseSplit) {
    var phaseCellStyle =
      'padding:6px 10px 12px;font-size:9px;color:var(--rpt-page-text);text-align:center;line-height:1.7;' +
      'border:1px solid var(--rpt-border);vertical-align:top';
    phaseSplitRow =
      '<tr>' +
      tierCols
        .map(function (c) {
          // Recommended (2026-07-27, Matt's correction): a Hardware/Programming dollar split is
          // just the same one-time total broken into two numbers — printing it here would recreate
          // the exact lump-sum framing the amount row above was just fixed to avoid. Point the
          // reader at the phased schedule instead of any dollar figure.
          if (c.key === NO_DOLLAR_TIER) {
            return (
              '<td style="' +
              phaseCellStyle +
              '">' +
              '<div style="font-weight:400">Funded from the monthly service allowance above. See ' +
              'the phased implementation schedule below for what is delivered and when.</div>' +
              '</td>'
            );
          }
          // noCatalog guard mirrors the interactive Cost Estimate tab's own footer
          // (app/pricing-estimator.js:6301-6306 / 6263-6267): phase1 is unpriced (not legitimately
          // $0) whenever no pricing catalog is imported, so _fmtUSD(0) must never print here.
          var parts = _tierPartsRounded(c.key);
          var noCat = parts && parts.noCatalog;
          var p1 = noCat
            ? '<span style="color:var(--rpt-page-text);font-weight:400">CSV needed</span>'
            : parts
              ? _fmtUSD(parts.p1r) || '—'
              : '—';
          var p2 = parts ? _fmtUSD(parts.p2r) : null;
          return (
            '<td style="' +
            phaseCellStyle +
            '">' +
            '<div><span style="font-weight:700">Hardware &amp; Installation:</span> ' +
            p1 +
            '</div>' +
            '<div><span style="font-weight:700">Programming:</span> ' +
            (p2 || '—') +
            '</div>' +
            '</td>'
          );
        })
        .join('') +
      '</tr>';
  }

  // Interactive tier detail (fix/proposal-tier-option-chooser, 2026-07-19): a click-to-expand
  // "Install & Programming Detail" card per tier, collapsed by default in the live preview.
  // Always rendered (independent of wantPhaseSplit/wantItemized — those only affect what's
  // shown INSIDE the panel) whenever the tier totals were actually computed; if
  // _pricingComputeSummaryData threw above, summaryData is null and this row is omitted rather
  // than showing an empty/broken card. See _rptA36TierDetailPanelHTML /
  // _rptA36TierDetailToggleHTML / _rptToggleTierDetail above.
  //
  // OVERFLOW FIX (2026-07-22, Matt: "the text is running off all of the pages at the bottom" —
  // report-export-fixes task): this page previously rendered the detail panel INLINE in the
  // single-page 3-column table unconditionally, on the documented assumption ("3 tiers x 1
  // total cannot overflow one 8.5x11 sheet" — see this function's header comment) that predates
  // the 2026-07-19 click-to-expand panel and the 2026-07-22 itemized qty x unit price additions.
  // exportReportToPDF()/exportReportToWord() force EVERY tier's panel open (display:block)
  // before capture — for a large portfolio (e.g. JOCO's Full Scope tier: 80+ distinct
  // hardware/programming items) that blew the page's real height to several times 1056px.
  // .rpt-page itself never clips (min-height + overflow:visible), but exportReportToPDF()'s
  // html2canvas->jsPDF step draws one image per PDF page sized to the page's full scrollHeight
  // WITHOUT clamping that image's height to the physical page height — so once a page's real
  // content exceeds roughly one printable page's worth of height, the excess is hard-clipped at
  // the PDF page's physical bottom edge and lost. Fix: measure the worst-case tier's combined
  // Hardware+Programming bullet count BEFORE building the table; if it's small enough to safely
  // fit inline (the common case — unchanged behavior, same interactive toggle UX Matt asked for
  // 2026-07-19), keep the existing single-page 3-column row. Otherwise, replace the inline panel
  // with a one-line pointer and move ALL THREE tiers' full detail onto dedicated, auto-paginated
  // continuation pages built by _buildTierDetailPages() below (same _rptPaginateTokens
  // height-budget chunking this file's _buildItemizedPages() already uses successfully) — so the
  // .rpt-page count grows instead of any single page's content overflowing its own boundary.
  // 24 (raised from an initial conservative 16, 2026-07-22): empirically, the chrome ABOVE the
  // detail row (title/intro/tier table/phaseSplit/timeline/disclaimer/service-agreement block —
  // see the "after3" verification screenshot for a fully-loaded example) comfortably fits in the
  // TOP HALF of the 1056px page even with every optional block shown, leaving ~450-500px of
  // headroom; at ~14px/bullet + ~80px panel chrome, 24 combined items uses ~416px — safely
  // within that headroom, and far below the ~1197px scrollHeight where exportReportToPDF's
  // per-page image would actually start clipping against the physical PDF page edge (see the
  // comment above the detailRow/detailNoteRow branch below for that derivation). Small/medium
  // real portfolios (a handful of buildings) stay on the original interactive inline path;
  // large multi-building portfolios (JOCO's Full Scope tier: 80+ items) still correctly move to
  // _buildTierDetailPages() continuation pages.
  // 24 combined Hardware-category-rows + Programming-sequence-rows still considered safe inline.
  // Hardware now counts CATEGORIES (+1 for the ioOnly summary line when present), not one row per
  // distinct item name (2026-07-27 category-summarization rework, same branch as
  // _rptA36HardwareCategoryAgg) — a portfolio that used to need 40+ hardware bullets now needs a
  // handful of category rows, so real portfolios stay on the inline path far more often; the
  // continuation-page fallback below still exists for anything that doesn't fit.
  var DETAIL_INLINE_ROW_LIMIT = 24; // combined Hardware+Programming row count considered safe inline
  var detailFitsInline = true;
  if (summaryData && summaryData.perTier) {
    var _toggles0 = (estimateState && estimateState.rowToggles) || {};
    var _maxTierRows = 0;
    tierCols.forEach(function (c) {
      var _rows = summaryData.perTier[c.key] || [];
      var _hwAgg0 = _rptA36HardwareCategoryAgg(_rows, _toggles0);
      var _n =
        _hwAgg0.categories.length +
        (_hwAgg0.ioOnlyCount > 0 ? 1 : 0) +
        _rptA36TierDetailAggByPhase(_rows, 2, _toggles0).length;
      if (_n > _maxTierRows) _maxTierRows = _n;
    });
    detailFitsInline = _maxTierRows <= DETAIL_INLINE_ROW_LIMIT;
  }

  var detailRow = '';
  if (summaryData && summaryData.perTier && detailFitsInline) {
    var detailCellStyle = 'padding:8px 10px 12px;border:1px solid var(--rpt-border);vertical-align:top';
    detailRow =
      '<tr>' +
      tierCols
        .map(function (c) {
          return (
            '<td style="' +
            detailCellStyle +
            '">' +
            _rptA36TierDetailToggleHTML(c.key) +
            _rptA36TierDetailPanelHTML(c.key, tt, summaryData, estimateState, wantItemized, _fmtUSD) +
            '</td>'
          );
        })
        .join('') +
      '</tr>';
  } else if (summaryData && summaryData.perTier && !detailFitsInline) {
    var detailNoteStyle =
      'padding:10px;font-size:9px;color:var(--rpt-page-text);font-style:italic;border:1px solid var(--rpt-border);text-align:center';
    // Reworded 2026-07-27 (coordinator review): the bare "detail for each scope" line let a
    // reader assume all three tiers' continuation pages are the same kind of thing (priced
    // detail). Recommended's continuation pages (item 6/7 above, _buildTierDetailPages/
    // _buildItemizedPages) no longer carry any price — only scope/quantity — so this note now
    // says so explicitly instead of implying parity with Compliance/Full Scope's priced detail.
    detailRow =
      '<tr><td colspan="3" style="' +
      detailNoteStyle +
      '">Full Install &amp; Programming Detail for each scope is provided on the following pages. ' +
      'Compliance and Full Scope detail includes pricing; Recommended detail lists scope and ' +
      'quantities only, funded through the monthly service allowance.</td></tr>';
  }

  var table =
    '<table style="width:684px;max-width:684px;border-collapse:collapse;table-layout:fixed;margin-bottom:12px">' +
    colgroup +
    '<thead>' +
    headRow +
    '</thead><tbody>' +
    descRow +
    lblRow +
    amtRow +
    phaseSplitRow +
    detailRow +
    '</tbody></table>';

  // M&V / savings disclaimer — attached wherever estimates appear (verbatim SAVINGS_DISCLAIMER_TEXT).
  var disc =
    typeof SAVINGS_DISCLAIMER_TEXT !== 'undefined'
      ? SAVINGS_DISCLAIMER_TEXT
      : 'Estimates are not guarantees of performance. Post-installation measurement and verification (M&V) is required to confirm realized savings.';
  var discBlock =
    '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.5;margin-top:8px;padding-top:8px;' +
    'border-top:1px solid var(--rpt-rule)">' +
    '<span style="font-weight:700">Estimate &amp; Savings Disclaimer: </span>' +
    _esc(disc) +
    '</div>';

  // Monthly Energy Management Service Agreement (2026-07-20) — client-facing not-to-exceed line.
  // Sourced from the existing en_pricing_budget_{projId}.amount and the existing global
  // en_pricing_config.hourlyRate (never hardcoded here) — same collector-reads-everything
  // discipline as the tier totals above, just against the budget/config stores instead of the
  // row-toggle estimate. Deliberately NAMES the $/hr rate to the client: this is a monthly
  // allowance product, not a scoped tier total, so the tier-total-only convention (rate hidden,
  // see the savingsRationale/clientSummary split elsewhere in this file) does not apply here.
  // Guarded: renders nothing when no budget amount is configured for this project, so a project
  // that has never used the Monthly Service Agreement feature sees zero change to this page.
  var svcBlock = '';
  try {
    if (typeof _pricingGetBudget === 'function' && typeof _pricingGetConfig === 'function') {
      var _svcBudget = _pricingGetBudget(d.project.id);
      var _svcCfg = _pricingGetConfig();
      if (_svcBudget && _svcBudget.amount != null && !isNaN(_svcBudget.amount) && Number(_svcBudget.amount) > 0) {
        var _svcAllowanceStr = _fmtUSD(Number(_svcBudget.amount));
        var _svcRate =
          _svcCfg.hourlyRate || (typeof COST_LABOR_RATE_DEFAULT !== 'undefined' ? COST_LABOR_RATE_DEFAULT : 125);
        // Design-language pass (report-export-fixes, 2026-07-22): dropped the full bordered-
        // rectangle treatment (reads as a box/card, banned in client reports) — uses the same
        // .rpt-a36-callout "just spacing, no border" convention as every other explanatory
        // text block on this and the Audit Report's pages.
        svcBlock =
          '<div class="rpt-a36-callout" style="font-size:14px;color:var(--rpt-page-text);line-height:1.6;margin-top:12px">' +
          '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;' +
          'margin-bottom:4px">Monthly Energy Management Service Agreement</div>' +
          '<div>' +
          _svcAllowanceStr +
          '/month allowance at $' +
          _svcRate +
          '/hr (not-to-exceed)</div>' +
          '</div>';
      }
    }
  } catch (e) {
    svcBlock = ''; // non-fatal — page renders without this block, same as the tt fallback above
  }

  // Recommended-tier phased implementation timeline (Task 2, 2026-07-22) — Aug-Dec 2026 / CY2027 /
  // CY2028, allocated from (never added on top of) the Recommended tier's existing grand total.
  // Guarded/silent-until-priced, same as discBlock/svcBlock above.
  var timelineBlock = _rptA36RecommendedTimelineHTML(d);

  // fix/report-typography-and-pagination-merge (2026-07-29): discBlock (Estimate & Savings
  // Disclaimer) and svcBlock (Monthly Energy Management Service Agreement line) moved OFF this
  // page onto their own small continuation page. At the corrected 14px/10.5pt body size (svcBlock
  // sets font-size:14px explicitly — one of the individual sites the px/pt unit-bug fix touched),
  // this page measured 105px past the 1056px design height with titleBlock+intro+table+
  // timelineBlock+discBlock+svcBlock all on one unpaginated page. table/timelineBlock stay put
  // (the priced tier table and phased schedule are the page's primary content, not severable);
  // discBlock/svcBlock are the two smallest, least position-dependent blocks (a disclaimer and a
  // one-line budget callout), same "move the most severable block" approach used on
  // rptPageASHRAE36ProposalCover (see that function's comment). Content unchanged, not shrunk.
  var bodyHTML = titleBlock + intro + table + timelineBlock;
  var trailerHTML = discBlock + svcBlock;

  var resultPages = [
    rptPage(n, 'ASHRAE 36 Service Proposal: Cost Estimate', bodyHTML, {
      data: fakeData,
      label: 'Page ' + n + ' — Cost Estimate',
    }),
  ];
  var nextPageNum = n + 1;
  if (trailerHTML) {
    resultPages.push(
      rptPage(nextPageNum, 'ASHRAE 36 Service Proposal: Cost Estimate', titleBlock + trailerHTML, {
        data: fakeData,
        label: 'Page ' + nextPageNum + ' — Cost Estimate Disclaimer',
      }),
    );
    nextPageNum++;
  }

  // ── "Per-building pricing breakdown" (costEstimatePerBuilding) REMOVED 2026-07-22 ─────────────
  // Matt's explicit request: "The Cost Estimate per building I do not like and it honestly gives
  // no information. Just remove completely." Removed: the _buildPerBuildingPages function (one
  // row per building × 3 tier totals, no other context), its call site below, the wantPerBuilding
  // flag above, the costEstimatePerBuilding settings checkbox (ASHRAE36_SECTIONS.proposal), and
  // the perBuilding opt passed from generateASHRAE36ProposalHTML. The overall Cost Estimate page,
  // tier totals, and the new Recommended-tier timeline table above are unaffected.

  // ── Option 2: Itemized breakdown, SUMMARIZED across the portfolio (costEstimateItemized) ──────
  // One row PER DISTINCT MEASURE per tier — qty and lineTotal are aggregated (summed) across every
  // building carrying that same item, NOT one row per building-instance. This keeps the section to
  // a few pages instead of recreating the "looks like a scope document" complaint (2026-06-08 PDF
  // review Issue 6) with walls of near-duplicate rows. Each tier starts on its own fresh page and is
  // independently paginated with _rptPaginateTokens if it runs long. Only rows actually counted in
  // the grand total (rowToggles[key] !== false) are included, matching the totals shown above.
  // SAFETY: prints only row.item, summed qty, summed lineTotal, and row.clientSummary — never
  // unitPrice/listPrice/netPrice/contractPrice/sku/hrsPerUnit/savingsRationale.
  function _buildItemizedPages(startN) {
    if (!summaryData || !summaryData.perTier) return [];
    var toggles = (estimateState && estimateState.rowToggles) || {};
    var pages = [];
    var pageN = startN;

    tierCols.forEach(function (c) {
      var rows = summaryData.perTier[c.key] || [];
      var included = rows.filter(function (r) {
        var key = r._baseId || r.id;
        return toggles[key] !== false;
      });
      if (!included.length) return;

      // Hardware & Installation rows (phase 1) are CATEGORY-summarized here too (2026-07-27,
      // same rework as _rptA36HardwareCategoryAgg used by the Install & Programming Detail
      // pages above — Matt, repeat complaint: "too much detail" / "Compliance and Full Scope is
      // huge"). A category has no single clientSummary sentence (it can span several distinct
      // items with different savings rationale), so the category rows carry no sub-line here —
      // Programming (phase 2) rows below are UNCHANGED: still one row per sequence with its
      // clientSummary sentence, since that list was never the length complaint (a handful of
      // sequences, not dozens of hardware line items).
      var hwAgg = _rptA36HardwareCategoryAgg(rows, toggles);
      var hwCategoryRows = hwAgg.categories.map(function (cat) {
        return { item: cat.label, qty: cat.qty, lineTotal: cat.lineTotal, clientSummary: null, _isCategory: true };
      });
      if (hwAgg.ioOnlyCount > 0) {
        hwCategoryRows.push({
          item: 'Existing control points requiring programming only',
          qty: hwAgg.ioOnlyQty,
          lineTotal: 0,
          clientSummary: null,
          _isCategory: true,
        });
      }

      var byItem = {};
      var order = [];
      included
        .filter(function (r) {
          return r.phase === 2;
        })
        .forEach(function (r) {
          var key = r.item || '(unnamed)';
          if (!byItem[key]) {
            byItem[key] = { item: r.item, qty: 0, lineTotal: 0, clientSummary: r.clientSummary || null };
            order.push(key);
          }
          byItem[key].qty += r.qty || 0;
          byItem[key].lineTotal += r.lineTotal || 0;
        });
      var programmingRows = order.map(function (k) {
        return byItem[k];
      });

      var agg = hwCategoryRows.concat(programmingRows);
      if (!agg.length) return;

      // Recommended (2026-07-27, Matt's correction): a per-item "Price" column here is just the
      // same one-time lump total broken into rows — the amount row on the summary table above no
      // longer prints that total for Recommended, so this itemized page must not silently rebuild
      // it. Item + Qty still list what is included; no dollar column/col for this tier.
      var _isNoDollarCol = c.key === NO_DOLLAR_TIER;
      var itColgroup = _isNoDollarCol
        ? '<colgroup><col style="width:534px"><col style="width:150px"></colgroup>'
        : '<colgroup><col style="width:474px"><col style="width:100px"><col style="width:110px"></colgroup>';
      var itThStyle =
        'padding:6px 8px;font-size:9px;font-weight:700;color:var(--rpt-page-text);text-align:left;' +
        'border:1px solid var(--rpt-border)';
      var itThRight = itThStyle.replace('text-align:left', 'text-align:right');
      var itTableHead =
        '<table style="width:684px;max-width:684px;border-collapse:collapse;font-size:9px;table-layout:fixed;margin-bottom:12px">' +
        itColgroup +
        '<thead><tr>' +
        '<th style="' +
        itThStyle +
        '">Item</th>' +
        '<th style="' +
        itThRight +
        '">Total Qty</th>' +
        (_isNoDollarCol ? '' : '<th style="' + itThRight + '">Price</th>') +
        '</tr></thead>';

      function _itemRowHTML(row) {
        var td =
          'padding:5px 8px;font-size:9px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);vertical-align:top';
        var tdR = td + ';text-align:right';
        var nameHTML =
          '<div>' +
          _esc(row.item || '') +
          '</div>' +
          (row.clientSummary
            ? '<div style="font-size:8px;color:var(--rpt-page-text);margin-top:2px;line-height:1.4">' +
              _esc(row.clientSummary) +
              '</div>'
            : '');
        return (
          '<tr>' +
          '<td style="' +
          td +
          '">' +
          nameHTML +
          '</td>' +
          '<td style="' +
          tdR +
          '">' +
          (row.qty || 0).toLocaleString() +
          '</td>' +
          // fix/65ce578b (2026-07-27): a real, computed $0 (ioOnly rows -- existing controller
          // I/O points needing no new hardware) must not print as a bare "$0" (banned per the
          // no-$0-in-client-output rule). Row stays (real scope the client should see); only the
          // price cell's text changes to a plain-English label.
          (_isNoDollarCol
            ? ''
            : '<td style="' +
              tdR +
              '">' +
              (row.lineTotal === 0 ? 'No additional cost' : _fmtUSD(row.lineTotal) || '—') +
              '</td>') +
          '</tr>'
        );
      }

      // estH values measured via real headless render against JOCO (27-building portfolio): plain
      // item/qty/price rows averaged ~24.5px (not 20 — that 4.5px/row underestimate accumulated
      // across a 38-row Full Scope continuation page into an 86px page overflow), and rows with a
      // clientSummary sub-line averaged ~48.9px (not 34). 30 / 60 below keep a safety margin for
      // longer item names or multi-sentence clientSummary text that could wrap further. Both tiers'
      // FIRST and CONT budgets are now equal (780) — a tier's own first page has the exact same
      // chrome (title ~22.5px + thead ~25.5px + table margin-bottom ~12px ≈ 60px) as its
      // continuation pages, so there was never a reason for the two to differ.
      //
      // 2026-08-02 (fix/docx-proposal-pagination-orphans): clientSummary estH bumped 60 -> 68.
      // A real Word round-trip render of the live JOCO "Recommended" tier found the 60px estimate
      // still UNDER Word's real per-row height: a chunk of 8 plain + 9 clientSummary rows summed to
      // EXACTLY 780 (8*30 + 9*60) under this estimate — i.e. the old 60 left this chunk with ZERO
      // margin at the budget ceiling, so ANY understatement guaranteed overflow. Measuring the same
      // 16 rows' real bounding boxes in the exported PDF (word/document.xml row-top deltas) gave a
      // real clientSummary row height of ~46.35pt = ~61.8px-equivalent at 96dpi — already above the
      // old 60px estimate before any margin. 68 restores genuine headroom (68 vs 61.8 measured,
      // ~10% margin) instead of an exact-fit estimate that only happened to work for OTHER row
      // mixes. See docs/dashboardlogic.md 2026-08-02 entry for the full page/row measurement.
      var tokens = agg.map(function (row) {
        return { type: 'row', estH: row.clientSummary ? 68 : 30, html: _itemRowHTML(row) };
      });

      // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
      // the standalone flat literal 780 — ITEMIZED_BASE_ADJUSTMENT preserves this exact numeric
      // value (904 - 124 = 780), no visual/page-count change. FIRST and CONT stay equal per the
      // comment above (a tier's first page has the same chrome as its continuation pages).
      var ITEMIZED_BASE_ADJUSTMENT = 124; // title + thead + table margin-bottom (~60px chrome) + safety margin
      var _itemizedBudget = _rptContentBudget('standard') - ITEMIZED_BASE_ADJUSTMENT;
      // 2026-08-02 (fix/docx-proposal-pagination-orphans): greedy _rptPaginateTokens ->
      // _rptPaginateTokensBalanced, same reasoning as _buildTierDetailPages above — same minimum
      // page count K, but a short remainder chunk is redistributed instead of stranded alone on a
      // trailing page. w:cantSplit (docx-writer.js) still keeps each <tr> intact; this only changes
      // WHERE the chunk boundary falls, never within a row.
      var chunks = _rptPaginateTokensBalanced(tokens, _itemizedBudget);
      var numChunks = chunks.length;

      chunks.forEach(function (chunk, idx) {
        var rowsHTML = chunk
          .map(function (t) {
            return t.html;
          })
          .join('');
        var itTable = itTableHead + '<tbody>' + rowsHTML + '</tbody></table>';
        // 2026-07-29 fix (same "(1 of N) missing on page 1" asymmetry — see Building ASHRAE 36
        // Readiness above): page 1 gets its own "(1 of N)" instead of only continuation pages
        // carrying a fraction.
        var itTitle =
          '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
          'text-transform:uppercase;letter-spacing:0.04em">Cost Estimate: Itemized Measures, ' +
          _esc(c.label) +
          (numChunks > 1
            ? idx > 0
              ? ' (continued ' + (idx + 1) + ' of ' + numChunks + ')'
              : ' (1 of ' + numChunks + ')'
            : '') +
          '</div>';
        var body = itTitle + itTable + (idx === numChunks - 1 && c === tierCols[tierCols.length - 1] ? discBlock : '');
        pages.push(
          rptPage(pageN, 'ASHRAE 36 Service Proposal: Cost Estimate', body, {
            data: fakeData,
            label: 'Page ' + pageN + ' — Itemized Measures (' + c.label + ')',
          }),
        );
        pageN++;
      });
    });

    return pages;
  }

  // ── Overflow fix continuation pages (2026-07-22; category-summarized 2026-07-27) ──
  // _buildTierDetailPages() ── Built only when detailFitsInline (computed above, before the
  // table) is false. Mirrors _buildItemizedPages()'s proven _rptPaginateTokens chunking pattern,
  // but Hardware & Installation now groups by device CATEGORY (_rptA36HardwareCategoryAgg) instead
  // of one bullet per distinct item name — same rework as _rptA36TierDetailPanelHTML above, same
  // reasoning (Matt: "too much detail" / "Compliance and Full Scope is huge"). Programming still
  // lists one row per sequence (already category-level). wantItemized still controls whether each
  // hardware category shows its qty + dollar subtotal (same rule the inline panel uses).
  function _buildTierDetailPages(startN) {
    if (!summaryData || !summaryData.perTier) return [];
    var toggles = (estimateState && estimateState.rowToggles) || {};
    var pages = [];
    var pageN = startN;

    function categoryBulletHTML(c, showPrice) {
      var priceStr = '';
      // Same no-bare-$0 rule as _sectionHTMLCategories above.
      if (showPrice && wantItemized && c.lineTotal === 0) {
        priceStr = ': ' + c.qty + ' units, no additional cost';
      } else if (showPrice && wantItemized && c.lineTotal != null && _fmtUSD(c.lineTotal)) {
        priceStr = ': ' + c.qty + ' units, ' + _fmtUSD(c.lineTotal);
      } else if (c.qty > 1) {
        priceStr = ' (qty ' + c.qty + ')';
      }
      return (
        '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.7;padding-left:14px;position:relative">' +
        '<span style="position:absolute;left:0">&#8226;</span>' +
        _esc(c.label) +
        priceStr +
        '</div>'
      );
    }

    function ioOnlySummaryHTML(agg) {
      return (
        '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.7;padding-left:14px;position:relative">' +
        '<span style="position:absolute;left:0">&#8226;</span>' +
        'Existing control points requiring programming only: ' +
        agg.ioOnlyQty +
        ' points, no additional cost' +
        '</div>'
      );
    }

    function bulletHTML(it, showPrice) {
      var priceStr = '';
      // fix/65ce578b (2026-07-27): same $0/no-catalog-price fix as _rptA36TierDetailPanelHTML's
      // _sectionHTML above -- a real, computed $0 (ioOnly rows) must not render as "N × $0 = $0"
      // / a bare "$0". Row stays (real scope the client should see); only the price text changes.
      if (showPrice && wantItemized && it.lineTotal === 0) {
        priceStr = it.qty > 1 ? ': ' + it.qty + ' units, no additional cost' : ': no additional cost';
      } else if (showPrice && wantItemized && it.lineTotal != null && _fmtUSD(it.lineTotal)) {
        priceStr =
          it.qty > 1 && it.unitPrice != null && _fmtUSD(it.unitPrice)
            ? ': ' + it.qty + ' × ' + _fmtUSD(it.unitPrice) + ' = ' + _fmtUSD(it.lineTotal)
            : ': ' + _fmtUSD(it.lineTotal);
      } else if (it.qty > 1) {
        priceStr = ' (qty ' + it.qty + ')';
      }
      // Self-contained fragment (no wrapping <ul>/<table> required) so _rptPaginateTokens can
      // split the token stream at any row boundary without ever leaving an unclosed tag —
      // same "each token is one complete, independently valid HTML fragment" rule
      // _buildItemizedPages() above follows with its <tr>...</tr> rows.
      return (
        '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.7;padding-left:14px;position:relative">' +
        '<span style="position:absolute;left:0">&#8226;</span>' +
        _esc(it.item || '') +
        priceStr +
        '</div>'
      );
    }

    function sectionTitleHTML(title, subtotalStr, noCatFlag) {
      // Grey (#666) removed here too (report-standard rule: grey text is banned) — matches the
      // same fix already applied to _rptA36TierDetailPanelHTML's _sectionHTML above.
      var subtotalHTML = noCatFlag
        ? ' <span style="font-weight:400;color:var(--rpt-page-text)">(CSV needed for pricing)</span>'
        : subtotalStr
          ? ': <span style="font-weight:700">' + subtotalStr + '</span>'
          : '';
      return (
        '<div style="font-size:10px;font-weight:700;color:var(--rpt-page-text);margin:10px 0 3px">' +
        _esc(title) +
        subtotalHTML +
        '</div>'
      );
    }

    tierCols.forEach(function (c) {
      var rows = summaryData.perTier[c.key] || [];
      var hwAgg = _rptA36HardwareCategoryAgg(rows, toggles);
      var lb = _rptA36TierDetailAggByPhase(rows, 2, toggles);
      var hasHw = hwAgg.categories.length > 0 || hwAgg.ioOnlyCount > 0;
      if (!hasHw && !lb.length) return;

      // Recommended (2026-07-27, Matt's correction): same no-lump-sum rule as the inline panel
      // (_rptA36TierDetailPanelHTML) and the itemized pages above — never print a Hardware/
      // Programming subtotal or a per-item price for this tier.
      var noDollar = c.key === NO_DOLLAR_TIER;
      // UNRESOLVED DESIGN QUESTION (investigated 2026-08-02, fix/costest-wording-and-rounding --
      // NOT changed here, see that task's report): this page's Full Scope Programming subtotal
      // ($337,437, from tt[c.key].phase2 fmtUSD'd raw) disagrees by $1 with page 7's
      // phaseSplitRow Programming figure ($337,436, from _tierPartsRounded's largest-remainder
      // allocation -- fix/tier-hardware-programming-rounding, 2026-07-30). Tried pointing p1/p2
      // here at the SAME _tierPartsRounded(c.key) helper phaseSplitRow reads: that DOES make this
      // page's header agree with page 7, but this page's own itemized bullet rows below (each an
      // unrounded qty x unitPrice = lineTotal, never touched by _tierPartsRounded) independently
      // sum to $337,437 -- so the header would then disagree with its OWN itemized list on the
      // same page instead of with page 7. Every real dollar in the bullet list is correct; there
      // is no rounding tweak that makes the header agree with both page 7 AND its own bullets
      // simultaneously without fudging one bullet's true computed price by $1. Left AS-IS
      // (self-consistent with its own bullets, disagrees with page 7 by $1) pending a decision on
      // which of the two $1 disagreements is preferable -- do not silently pick one.
      var tt_ = !noDollar && tt && tt[c.key] ? tt[c.key] : null;
      var noCat = !!(tt_ && tt_.noCatalog);
      var p1 = tt_ ? _fmtUSD(tt_.phase1) : null;
      var p2 = tt_ ? _fmtUSD(tt_.phase2) : null;

      var tokens = [];
      if (noDollar) {
        tokens.push({
          type: 'row',
          estH: 20,
          html:
            '<div style="font-size:8.5px;color:var(--rpt-page-text);font-style:italic;margin:6px 0 4px">' +
            'Delivered as part of the monthly service allowance shown above, not billed separately.' +
            '</div>',
        });
      }
      // 2026-08-02 (fix/docx-proposal-pagination-orphans): bullet/section-title estH bumped
      // 15 -> 30 and 24 -> 30. A real Word round-trip render of the live JOCO "Full Scope" tier
      // found this WHOLE 28-token list (2 section titles + 26 bullets) estimated at only 438px
      // under the OLD 15/24 constants — comfortably under the 900px _scopeBudget, so
      // _rptPaginateTokens never even split it into multiple chunks (numChunks stayed 1). But the
      // real exported PDF (word/document.xml row-top deltas, "Install & Programming Detail — Full
      // Scope" page) measured a CONSISTENT ~20.05pt = ~26.7px-equivalent per bullet row and
      // ~20.7pt = ~27.6px-equivalent for the section-title-to-next-row gap — i.e. every token in
      // this list was underestimated by roughly HALF (15 vs 26.7 real, 24 vs 27.6 real). The real
      // total for those same 28 tokens is ~830px, close enough to the page's real available height
      // that the last bullet ("Sensor Investigation — Discharge Airflow") didn't fit and was
      // orphaned alone on the next page. 30 (both constants unified, matching the itemized table's
      // own plain-row value) covers the measured real heights with genuine margin instead of an
      // estimate that was never validated against Word. See docs/dashboardlogic.md 2026-08-02.
      if (hasHw) {
        tokens.push({ type: 'row', estH: 30, html: sectionTitleHTML('Hardware & Installation', p1, noCat) });
        hwAgg.categories.forEach(function (c2) {
          tokens.push({ type: 'row', estH: 30, html: categoryBulletHTML(c2, !noDollar) });
        });
        if (hwAgg.ioOnlyCount > 0) {
          tokens.push({ type: 'row', estH: 30, html: ioOnlySummaryHTML(hwAgg) });
        }
      }
      if (lb.length) {
        tokens.push({ type: 'row', estH: 30, html: sectionTitleHTML('Programming', p2, false) });
        lb.forEach(function (it) {
          tokens.push({ type: 'row', estH: 30, html: bulletHTML(it, !noDollar) });
        });
      }

      // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
      // the standalone flat literal 900 — SCOPE_BASE_ADJUSTMENT preserves this exact numeric
      // value (904 - 4 = 900), no visual/page-count change.
      //
      // 2026-08-02 (fix/docx-proposal-pagination-orphans): 4 -> 30. This adjustment is meant to
      // reserve room for the pageTitle div ("Install & Programming Detail — <tier>") itself, which
      // is prepended to rowsHTML OUTSIDE the token list below and so was never budgeted for at
      // all. Real Word measurement: pageTitle top (98.4pt) to first token top (120.3pt) = 21.9pt =
      // ~29.2px-equivalent. 4px reserved essentially nothing for it.
      var SCOPE_BASE_ADJUSTMENT = 30; // reserves the pageTitle div's own real Word-measured height
      var _scopeBudget = _rptContentBudget('standard') - SCOPE_BASE_ADJUSTMENT;
      // 2026-08-02 (fix/docx-proposal-pagination-orphans): _rptPaginateTokens (greedy) -->
      // _rptPaginateTokensBalanced. Even with the corrected estH above, a real Word round-trip on
      // the live "Full Scope" tier's 30-token list found greedy packing 29 tokens onto page 1
      // (right at the budget ceiling) and stranding the 30th ("Sensor Investigation — Discharge
      // Airflow") alone on page 2 — same single-orphan symptom, now caused by genuine content
      // length landing near a page boundary rather than by a bad estimate. _rptPaginateTokensBalanced
      // already exists in this file for exactly this shape of problem (see its own header comment,
      // "MedAct 53 Gardner alone on a ~20%-full page") — same minimum page count K (provably
      // optimal, unchanged), but distributes tokens evenly across the K pages instead of greedily
      // maximizing page 1, so a small remainder is never stranded alone.
      var chunks = _rptPaginateTokensBalanced(tokens, _scopeBudget);
      var numChunks = chunks.length;

      chunks.forEach(function (chunk, idx) {
        var rowsHTML = chunk
          .map(function (t) {
            return t.html;
          })
          .join('');
        // 2026-07-29 fix (same "(1 of N) missing on page 1" asymmetry — see Building ASHRAE 36
        // Readiness above): page 1 gets its own "(1 of N)" instead of only continuation pages
        // carrying a fraction.
        var pageTitle =
          '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
          'text-transform:uppercase;letter-spacing:0.04em">Install &amp; Programming Detail, ' +
          _esc(c.label) +
          (numChunks > 1
            ? idx > 0
              ? ' (continued ' + (idx + 1) + ' of ' + numChunks + ')'
              : ' (1 of ' + numChunks + ')'
            : '') +
          '</div>';
        pages.push(
          rptPage(pageN, 'ASHRAE 36 Service Proposal: Cost Estimate', pageTitle + rowsHTML, {
            data: fakeData,
            label: 'Page ' + pageN + ' — Install & Programming Detail (' + c.label + ')',
          }),
        );
        pageN++;
      });
    });

    return pages;
  }

  if (!detailFitsInline) {
    var tierDetailPages = _buildTierDetailPages(nextPageNum);
    tierDetailPages.forEach(function (pg) {
      resultPages.push(pg);
      nextPageNum++;
    });
  }

  if (wantItemized) {
    var itemizedPages = _buildItemizedPages(nextPageNum);
    itemizedPages.forEach(function (pg) {
      resultPages.push(pg);
      nextPageNum++;
    });
  }

  return resultPages;
}

// ─── rptPageASHRAE36PointInventory ───────────────────────────────────────────
/**
 * Point Inventory Completeness page.
 * Shows total ASHRAE-mapped points + other BAS points per building.
 * Informational — never affects Coverage % or compliance scoring.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data()
 * @returns {string}
 */
function rptPageASHRAE36PointInventory(n, d) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var inv = d.pointInventory || { totalASHRAE: 0, totalOther: 0, totalAll: 0, byBuilding: [] };

  // ── Summary header block ──────────────────────────────────────────────────
  var totalPct = inv.totalAll > 0 ? Math.round((inv.totalASHRAE / inv.totalAll) * 100) : 0;

  // Design-language pass (report-export-fixes, 2026-07-22): these were filled
  // background:var(--rpt-rule)/border-radius:6px stat "cards" — the same box/tile styling
  // banned everywhere else in this report (rule 4.3, no colored fill boxes). Rebuilt using the
  // SAME border-only, transparent-fill `.rpt-a36-stat-card` class the Audit Report cover page
  // already uses for its own stat row (rptPageASHRAE36Cover, ~line 12110), so this page matches
  // the report's one established stat-display convention instead of inventing a second one.
  // Density: gap 24->14, margin-bottom 20->12, card padding 14px 16px->8px 10px.
  var summaryBlock =
    '<div style="display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap">' +
    // Card 1: Total points inventoried
    '<div class="rpt-a36-stat-card" style="flex:1;min-width:120px;padding:8px 10px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-page-text)">' +
    inv.totalAll.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:3px">Total Building Automation System Points Inventoried</div>' +
    '</div>' +
    // Card 2: ASHRAE-mapped points
    '<div class="rpt-a36-stat-card" style="flex:1;min-width:120px;padding:8px 10px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    inv.totalASHRAE.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:3px">ASHRAE 36 Mapped Points</div>' +
    '</div>' +
    // Card 3: Other BAS points
    '<div class="rpt-a36-stat-card" style="flex:1;min-width:120px;padding:8px 10px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-page-text)">' +
    inv.totalOther.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:3px">Other Building Automation System Points Inventoried</div>' +
    '</div>' +
    // Card 4: ASHRAE coverage of total inventory
    '<div class="rpt-a36-stat-card" style="flex:1;min-width:120px;padding:8px 10px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    totalPct +
    '%' +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:3px">Points Mapped to ASHRAE 36</div>' +
    '</div>' +
    '</div>';

  // ── Narrative ─────────────────────────────────────────────────────────────
  var narrative =
    '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:12px">' +
    'This inventory covers every building automation system data object exported for this project. ' +
    'Of the ' +
    inv.totalAll.toLocaleString() +
    ' total points captured, ' +
    inv.totalASHRAE.toLocaleString() +
    ' map directly to ASHRAE 36 sensor and actuator categories and are evaluated in the compliance scoring above. ' +
    'The remaining ' +
    inv.totalOther.toLocaleString() +
    ' points are present in the building automation system export but do not correspond to a defined ASHRAE 36 category. These may include vendor-specific status objects, ' +
    'integration relay programs, setpoint offsets, or equipment not addressed by ASHRAE 36. ' +
    'All points are accounted for; none are discarded.' +
    '</div>';

  // ── Per-building table ────────────────────────────────────────────────────
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the filled dark-blue header, matching the
  // Proposal's plain/thin-bordered convention. Styling only.
  var thBase =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:var(--rpt-page-text);text-align:left;border:1px solid var(--rpt-border)';
  var thRight = thBase + ';text-align:right';

  var tableHead =
    '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:12px;table-layout:fixed">' +
    '<thead><tr>' +
    '<th style="' +
    thBase +
    '">Building</th>' +
    '<th style="' +
    thRight +
    '">Total Points</th>' +
    '<th style="' +
    thRight +
    '">ASHRAE 36 Points</th>' +
    '<th style="' +
    thRight +
    '">Other Building Automation System Points</th>' +
    '<th style="' +
    thRight +
    '">ASHRAE Coverage</th>' +
    '</tr></thead>';

  function _buildInvRowHTML(b) {
    var bTotal = b.ashrae + b.other;
    var bPct = bTotal > 0 ? Math.round((b.ashrae / bTotal) * 100) : 0;
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border)">' +
      _a36DisplayName(b) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:right">' +
      rptCount(bTotal) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-blue);font-weight:600;border:1px solid var(--rpt-border);text-align:right">' +
      rptCount(b.ashrae) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border:1px solid var(--rpt-border);text-align:right">' +
      rptCount(b.other) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-blue);font-weight:600;border:1px solid var(--rpt-border);text-align:right">' +
      bPct +
      '%' +
      '</td>' +
      '</tr>'
    );
  }

  // Totals row — pushed as the final token so it stays attached to the last building row
  // whenever possible (see pagination note below).
  // Full 1px grid border on every cell (matches every data row above it, per the full-grid
  // table standard) plus a 2px top accent — the same canonical totals-row treatment used by
  // rptPageASHRAE36Building's summaryRowHtml/.rpt-table tr.rpt-tot elsewhere in this file.
  // Destyle pass (fix/65ce578b, 2026-07-27): dropped the shaded total-row fill
  // (background:var(--rpt-rule)), matching the Proposal's convention of no shaded rows -- the
  // bold text + 2px top rule alone already signal "this is the total." Styling only.
  var totalsRowHTML =
    '<tr>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);border:1px solid var(--rpt-border);border-top:2px solid var(--rpt-border)">Total</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);text-align:right;border:1px solid var(--rpt-border);border-top:2px solid var(--rpt-border)">' +
    inv.totalAll.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-blue);text-align:right;border:1px solid var(--rpt-border);border-top:2px solid var(--rpt-border)">' +
    inv.totalASHRAE.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);text-align:right;border:1px solid var(--rpt-border);border-top:2px solid var(--rpt-border)">' +
    inv.totalOther.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-blue);text-align:right;border:1px solid var(--rpt-border);border-top:2px solid var(--rpt-border)">' +
    totalPct +
    '%' +
    '</td>' +
    '</tr>';

  // ── Footnote ──────────────────────────────────────────────────────────────
  // 2026-07-12 fix (item 0ade8f29 + a0c2152/c121b992): opacity:0.7 faded the text to grey
  // (banned site-wide — report-standard.md requires near-black, not faded) and border-top
  // added an outline on plain prose text (also banned — plain text gets no border). Both removed.
  var footnote =
    '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.5;padding-top:8px">' +
    'Note: "Other Building Automation System Points" counts are informational. They represent building automation system objects that have been captured and logged but ' +
    'do not correspond to any ASHRAE 36 sensor or actuator category. ' +
    'These points do not contribute to and do not reduce the ASHRAE 36 Coverage percentages shown in this report.' +
    '</div>';

  // ── Pagination (2026-06-30 report defect fix — Point Inventory ran under the footer with
  //   27 buildings because this page previously returned a single un-paginated string, unlike
  //   its ASHRAE-36 siblings which use _rptPaginateTokens. Converted to the same pattern used by
  //   rptPageASHRAE36SetpointReview: chrome estimated conservatively, rows tokenized, totals row
  //   appended as the final token so it rides along with the last chunk of building rows. ──
  //   First-page chrome: summaryBlock (~90px) + narrative (~106px) + thead (~32px) = ~228px;
  //   using a wide safety margin (260px consumed) since these are estimates, not DOM-measured.
  //   Continuation chrome: contHdr (~35px) + thead (~32px) + safety = ~91px, matching the
  //   Setpoint Programming Review budget.
  // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
  // standalone literals — INV_*_BASE_ADJUSTMENT constants preserve these exact numeric values
  // (904 - 274 = 630, 904 - 101 = 803), no visual/page-count change.
  // U2 / RC-A (2026-08-02): the chrome above was explicitly "estimates, not DOM-measured" — it is
  // measured now, in a headless print render at the 10pt printed-text floor: summary block 129px,
  // narrative 107px, table head 73px (five headers, all wrapping), footnote ~90px. The flat 30px
  // row estimate was the larger error: rows measure 31px, 51px or 71px depending purely on how
  // many lines the building name wraps to in the 144px name column, so the estimate below counts
  // those lines (17 chars per line, fitted against all 28 JOCO rows) instead of assuming one.
  var INV_SUMMARY_H = 129; // measured
  var INV_NARRATIVE_H = 107; // measured
  var INV_THEAD_H = 73; // measured
  var INV_FOOTNOTE_H = 90; // measured; reserved on every page (it rides the last chunk) for safety
  var INV_CONT_HDR_H = 40;
  var INV_SAFETY_H = 40;
  var INV_NAME_CPL = 17; // chars per line in the 144px Building column at the 13.34px floor
  var INV_ROW_PAD_H = 11; // measured: a 1-line row is 31px = one 20px line box + 11px
  var _invLineH = _rptTextLineH(1.5);
  function _invRowEstH(name) {
    var lines = Math.max(1, Math.ceil(String(name || '').length / INV_NAME_CPL));
    return INV_ROW_PAD_H + lines * _invLineH;
  }
  var ROWS_BUDGET_FIRST =
    _rptContentBudget('standard') - INV_SUMMARY_H - INV_NARRATIVE_H - INV_THEAD_H - INV_FOOTNOTE_H - INV_SAFETY_H;
  var ROWS_BUDGET_CONT = _rptContentBudget('standard') - INV_CONT_HDR_H - INV_THEAD_H - INV_FOOTNOTE_H - INV_SAFETY_H;

  var tokens = inv.byBuilding.map(function (b) {
    return { type: 'row', estH: _invRowEstH(_a36DisplayName(b)), html: _buildInvRowHTML(b) };
  });
  tokens.push({ type: 'row', estH: INV_ROW_PAD_H + 2 * _invLineH, html: totalsRowHTML });

  var chunks = _rptPaginateTokens(tokens, ROWS_BUDGET_FIRST, ROWS_BUDGET_CONT);
  var numChunks = chunks.length;
  var resultPages = [];

  chunks.forEach(function (chunk, chunkIndex) {
    var tbodyRows = chunk
      .map(function (tok) {
        return tok.html;
      })
      .join('');
    var table = tableHead + '<tbody>' + tbodyRows + '</tbody></table>';

    var pageN = n + chunkIndex;
    var bodyHTML;
    if (chunkIndex === 0) {
      bodyHTML = summaryBlock + narrative + table + (chunkIndex === numChunks - 1 ? footnote : '');
    } else {
      var contHdr =
        // D-12 (2026-08-03): continuation heading -> 13pt section tier, same as the "(1 of N)"
        // heading it continues. Three sections share this exact fragment (Building ASHRAE 36
        // Readiness, Per-Building Detail, Setpoint Programming Review).
        '<div style="font-size:' +
        RPT_SECTION_HEAD_PX +
        'px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        'Point Inventory Completeness (continued, ' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + table + (chunkIndex === numChunks - 1 ? footnote : '');
    }

    // 2026-07-29 fix (same "(1 of N) missing on page 1" asymmetry — see Building ASHRAE 36
    // Readiness above): append the fraction to the .rpt-int-hdr title bar for page 1 too.
    var _pointInvTitle =
      'ASHRAE 36 Audit Report: Point Inventory' +
      (numChunks > 1 ? ' (' + (chunkIndex + 1) + ' of ' + numChunks + ')' : '');
    resultPages.push(
      rptPage(pageN, _pointInvTitle, bodyHTML, {
        data: fakeData,
        label:
          'Page ' +
          pageN +
          ' — Point Inventory' +
          (numChunks > 1 ? ' (' + (chunkIndex + 1) + '/' + numChunks + ')' : ''),
      }),
    );
  });

  return resultPages; // always an Array (length >= 1)
}

// ─── generateASHRAE36AuditHTML ────────────────────────────────────────────
/**
 * Assembles all selected audit report pages into an HTML string.
 * @param {object} data - Output from collectASHRAE36Data()
 * @param {object} selectedSections - Which sections to include
 * @returns {string}
 */
function generateASHRAE36AuditHTML(data, selectedSections) {
  var pages = [];
  var pageNum = 1;
  var s = selectedSections || {};

  function _tagA36Section(html, key) {
    return html.replace(/<div class="rpt-page([^"]*)"/, '<div class="rpt-page$1" data-section="' + key + '"');
  }

  if (s.cover !== false)
    pages.push(_tagA36Section(rptPageASHRAE36Cover(pageNum++, data, s.building !== false), 'cover'));
  if (s.executive !== false) {
    var execPages = rptPageASHRAE36Executive(pageNum, data);
    execPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'executive'));
      pageNum++;
    });
  }

  // Phase 5 — Cost Estimate page (spec §10, 2026-06-18).
  // Inserted after executive summary, before per-building detail pages.
  // rptPageASHRAE36CostEstimate guards collectPricingEstimate with typeof check
  // and renders a fallback note when no pricing catalog is imported.
  if (s.costEstimate !== false) {
    // Returns Array (1 page when rationale fits; 2+ when paginated) — spread each page.
    var costPages = rptPageASHRAE36CostEstimate(pageNum, data);
    costPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'costEstimate'));
      pageNum++;
    });
  }

  if (s.building !== false) {
    // a0c2152: buildingInfra is an independent sub-flag (default unchecked) — only pass
    // showBuildingInfra=true when the user explicitly ticks it in the modal.
    var showBuildingInfra = s.buildingInfra === true;

    // Density fix (feat/audit-report-reframe-density, 2026-07-09), Finding 4: this used to be
    // `data.buildings.forEach` calling rptPageASHRAE36Building once per building, which forces
    // EVERY building onto its own full 1056px page regardless of content size — 26 of JOCO's
    // 39 total report pages, many holding a single equipment category row on an otherwise
    // blank page (see stages/joco-audit-density-2026-07-09/investigation.md Finding 4).
    // Now: each building becomes an atomic block token (_a36BuildingBlockToken); small
    // buildings pack multiple-per-page via the same _rptPaginateTokens paginator already used
    // for the Executive Summary table. A building whose own content is too tall for one page
    // (estH over the budget) falls back to rptPageASHRAE36Building's existing dedicated
    // multi-page treatment, unchanged, so no building's content is ever clipped.
    // Verified via headless render against live JOCO data (2026-07-09): 860px let a handful
    // of packed pages grow to ~1160-1224px actual scrollHeight (still auto-scaled to fit one
    // PDF page per Fix A2 above, not clipped, but denser than intended) — tightened to 700px
    // for a larger safety margin against the estH approximation in _a36BuildingBlockToken.
    // fix/report-content-pagination (2026-07-28): derived from _rptContentBudget() instead of
    // the standalone literal 750 — AUDIT_BUILDING_BASE_ADJUSTMENT preserves this exact numeric
    // value (904 - 154 = 750), no visual/page-count change.
    var AUDIT_BUILDING_BASE_ADJUSTMENT = 154; // safety margin against the estH approximation in _a36BuildingBlockToken, per comment above
    var BUILDING_PAGE_BUDGET = _rptContentBudget('standard') - AUDIT_BUILDING_BASE_ADJUSTMENT; // px — interior page body (~895px) minus safety margin
    var _bldgFakeData = { project: { client: data.project.name }, period: { label: '', reportDate: data.rawDate } };
    var _pendingBlocks = [];

    function _flushPendingBuildingBlocks() {
      if (!_pendingBlocks.length) return;
      // fix/65ce578b (2026-07-27): switched from the plain greedy _rptPaginateTokens to
      // _rptPaginateTokensBalanced (defined above) -- same page count, same hard per-page cap
      // (nothing can clip), but chooses breakpoints to avoid one page landing far sparser than
      // its neighbors (see that function's own comment for the full rationale/proof).
      var _chunks = _rptPaginateTokensBalanced(_pendingBlocks, BUILDING_PAGE_BUDGET);
      _chunks.forEach(function (chunk) {
        var bodyHTML = chunk
          .map(function (t) {
            return t.html;
          })
          .join('');
        var pg = rptPage(pageNum, 'ASHRAE 36 Audit Report: Per-Building Detail', bodyHTML, {
          data: _bldgFakeData,
          label: 'Page ' + pageNum + ' — Per-Building Detail',
        });
        pages.push(_tagA36Section(pg, 'building'));
        pageNum++;
      });
      _pendingBlocks = [];
    }

    data.buildings.forEach(function (b) {
      var blockTok = _a36BuildingBlockToken(data, b, showBuildingInfra);
      if (blockTok.estH <= BUILDING_PAGE_BUDGET) {
        _pendingBlocks.push(blockTok);
      } else {
        // Too tall to share a page — flush anything already queued (preserves building order
        // in the printed report) then give this one building its own dedicated page(s).
        _flushPendingBuildingBlocks();
        var bPages = rptPageASHRAE36Building(pageNum, data, b, showBuildingInfra);
        bPages.forEach(function (pg) {
          pages.push(_tagA36Section(pg, 'building'));
          pageNum++;
        });
      }
    });
    _flushPendingBuildingBlocks();
  }

  // Batch 3 item 6 / plan 3e Option A: Recommendations page deleted from the Audit report
  // (41pp -> 40pp) — see the ASHRAE36_SECTIONS.audit comment above for rationale.

  // Phase 5 — Setpoint Programming Review (appended after recommendations)
  // Returns an Array (like executive section) — spread each page individually.
  if (s.setpointReview !== false) {
    var spPages = rptPageASHRAE36SetpointReview(pageNum, data);
    spPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'setpointReview'));
      pageNum++;
    });
  }

  // Phase D-3 — Point Inventory Completeness page (after setpoint review)
  // Returns an Array (like setpointReview) — spread each page individually so pagination
  // (2026-06-30 fix) actually takes effect instead of collapsing back into one overflowing page.
  if (s.pointInventory !== false) {
    var invPages = rptPageASHRAE36PointInventory(pageNum, data);
    invPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'pointInventory'));
      pageNum++;
    });
  }

  // Rule 2.4 (Plan B): bake page numbers at generation time.
  return _injectPageNumbers(pages.join('\n'));
}

// ─── generateASHRAE36ProposalHTML ────────────────────────────────────────
/**
 * Assembles all selected proposal pages into an HTML string.
 * @param {object} data - Output from collectASHRAE36Data()
 * @param {object} selectedSections - Which sections to include
 * @returns {string}
 */
function generateASHRAE36ProposalHTML(data, selectedSections) {
  var pages = [];
  var pageNum = 1;
  var s = selectedSections || {};

  function _tagA36Section(html, key) {
    return html.replace(/<div class="rpt-page([^"]*)"/, '<div class="rpt-page$1" data-section="' + key + '"');
  }

  // 2026-07-26 rebuild: default 3-page shape (proposalCover=page1, proposalPhaseTable=page2,
  // proposalVision=page3) — see the ASHRAE36_SECTIONS.proposal comment above for rationale.
  //
  // 2026-07-27 (client review): with the findings-cost-table AND Expected Outcomes both removed
  // (see the dated entries above), pages 2-3 measured 38.6% / 49.1% empty — the same "reads as
  // unfinished" complaint that drove the page-1 redesign. Rendered measurement (not assumption)
  // confirmed the two pages' combined content comfortably fits one physical page, so
  // proposalPhaseTable + proposalVision briefly rendered as ONE merged page
  // (rptPageASHRAE36ProposalPhaseAndVision) whenever BOTH were selected.
  //
  // 2026-07-29 (merge reverted, fix/report-typography-and-pagination-merge): that "comfortably
  // fits one physical page" measurement was taken against body text rendered at ~8.04pt (the
  // px/pt unit bug fixed by fix/report-typography-standard). At the corrected 14px/10.5pt size the
  // merged page measured 125px past the 1056px design height. Reverted to the pre-merge two-page
  // shape (rptPageASHRAE36ProposalPhaseTable, now carrying "Why This Approach" moved off the cover
  // page — see that function's comment, then rptPageASHRAE36ProposalVision) rather than
  // re-tightening spacing again, since a second density pass on top of an already-tight one risks
  // the same "reads as unfinished"-adjacent readability floor the 2026-07-26 comment above was
  // written against. No content was removed — the "one merged page" arrangement was itself the
  // thing this size no longer supports, not any bullet, heading, or paragraph in it. If only ONE
  // of the two toggles is enabled (a rarer, non-default combination), each still renders as its
  // own standalone page via rptPageASHRAE36ProposalPhaseTable/rptPageASHRAE36ProposalVision —
  // neither existing capability was destroyed, only the default (both-on) rendering path changed
  // back. rptPageASHRAE36ProposalPhaseAndVision itself is left intact (unused) rather than
  // deleted, per the "do not destroy existing capability" constraint already established elsewhere
  // in this file.
  if (s.proposalCover !== false) {
    pages.push(_tagA36Section(rptPageASHRAE36ProposalCover(pageNum++, data), 'proposalCover'));
    // 2026-08-02 (fix/docx-proposal-pagination-orphans): "Recommended Energy Management Services" now
    // renders on its OWN page (see rptPageASHRAE36ProposalCover's header comment) — pushed under
    // the same 'proposalCover' section key so toggling that one checkbox still controls both.
    pages.push(_tagA36Section(rptPageASHRAE36ProposalRecommendedServicesCover(pageNum++, data), 'proposalCover'));
  }
  // phaseOpts (2026-07-29, months + Future Work rebuild): threaded into both the Phase table page
  // and the Vision page so they agree on whether Future Work renders inline (in the table) or as
  // the default standalone section — see the 'futureWorkInline' section def's header comment above.
  // proposalPhaseTableOn (2026-07-29, fix: Phase-Table-off silent-truncation gap — reviewer-caught):
  // proposalPhaseTable and proposalVision are two INDEPENDENT toggles (both default on, both
  // independently uncheckable — see rptPageASHRAE36ProposalVision's own header comment, which has
  // documented Phase-Table-off/Vision-on as a supported combination since before this branch).
  // Future Work rendered ONLY inside _rptA36PhaseTableInnerHTML, so unchecking Phase Table while
  // leaving Vision on reintroduced the exact silent truncation this branch closes — the program
  // would say "continues with no fixed end date" while naming none of the future categories.
  // proposalPhaseTableOn tells _rptA36VisionInnerHTML whether the Phase Table page ran; when it
  // did NOT, Vision falls back to rendering Future Work itself (see that function's own
  // futureWorkFallbackHTML). Both true (default) and Phase-Table-off cases below still call the
  // SAME _rptA36FutureWorkInnerHTML helper — never a second copy of the markup.
  var phaseOpts = {
    futureWorkInline: s.futureWorkInline === true,
    proposalPhaseTableOn: s.proposalPhaseTable !== false,
  };
  if (s.proposalPhaseTable !== false) {
    // rptPageASHRAE36ProposalPhaseTable now returns an Array (2026-08-02, months-table
    // page-height fix) -- same spread-and-advance-pageNum pattern the costEstimate branch below
    // already uses for rptPageASHRAE36ProposalPricing.
    var phaseTablePages = rptPageASHRAE36ProposalPhaseTable(pageNum, data, phaseOpts);
    phaseTablePages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'proposalPhaseTable'));
      pageNum++;
    });
  }
  // R7 (2026-08-03, D-16): the proposalVision page used to be pushed HERE, immediately after the
  // schedule and BEFORE the scope sections. Because that page ends with the Disclaimer, every
  // opt-in content section that followed it ("ASHRAE 36 Compliance", "Full Scope", "Scope of Work",
  // the priced Cost Estimate) printed AFTER the disclaimer that is supposed to close the document.
  // On the live 2026-08-02 Johnson County export that put a whole scope section on page 6, after
  // the page-5 disclaimer, where it reads as an appendix mistake. A disclaimer ends a document, so
  // this page is now pushed LAST (see below, after the costEstimate branch) — which also puts the
  // proposal in story order: what was assessed, what is recommended, when each improvement happens,
  // what the scope covers, then the plan and the closing caveat. Moving the push rather than
  // splitting the Disclaimer out of _rptA36VisionInnerHTML keeps the Implementation Plan /
  // Long-Term Vision / Disclaimer sequence intact as one closing block, and keeps the single
  // content builder both the standalone and the legacy merged page share.

  // 2026-07-29 (fix/proposal-remove-fixed-anchors): two NEW independent opt-in sections, both
  // default OFF (strict === true opt-in, matching the costEstimate/proposalScope precedent below)
  // — see ASHRAE36_SECTIONS.proposal and rptPageASHRAE36ProposalComplianceScope/...FullScope's
  // header comment.
  if (s.complianceScope === true)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalComplianceScope(pageNum++, data), 'complianceScope'));
  if (s.fullScope === true) pages.push(_tagA36Section(rptPageASHRAE36ProposalFullScope(pageNum++, data), 'fullScope'));

  // Legacy detailed Scope of Work page — now opt-in (default OFF), kept for capability parity.
  if (s.proposalScope === true)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalScope(pageNum++, data), 'proposalScope'));

  // ebfca114: opt-in priced Cost Estimate page (default OFF — strict === true opt-in, so an
  // undefined/false section flag never renders it). Positioned after Scope of Work ("what needs
  // to happen"), now the last Proposal page since Expected Outcomes was removed (2026-07-22).
  // Returns an Array — spread each page and advance pageNum so downstream numbering stays correct.
  if (s.costEstimate === true) {
    // Selectable pricing-detail sub-options — each only takes effect because costEstimate is on
    // here (independent-flag / parent-gates precedent, buildingInfra). Passed as a 3rd opts arg.
    var pricingOpts = {
      phaseSplit: s.costEstimatePhaseSplit === true,
      itemized: s.costEstimateItemized === true,
    };
    var pricingPages = rptPageASHRAE36ProposalPricing(pageNum, data, pricingOpts);
    pricingPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'costEstimate'));
      pageNum++;
    });
  }

  // Implementation Plan / Long-Term Vision / Disclaimer — LAST, always. See the R7 (2026-08-03,
  // D-16) comment above the complianceScope branch for why this moved down here: this page ends
  // with the Disclaimer, and nothing may print after a disclaimer.
  if (s.proposalVision !== false) {
    pages.push(_tagA36Section(rptPageASHRAE36ProposalVision(pageNum++, data, phaseOpts), 'proposalVision'));
  }

  // 2026-07-22: Expected Outcomes page removed entirely (rptPageASHRAE36ProposalOutcomes,
  // _proposalOutcomeCard, _timelineStep deleted, plus its 'proposalOutcomes' settings checkbox)
  // — not replaced with anything.

  // Rule 2.4 (Plan B): bake page numbers at generation time.
  return _injectPageNumbers(pages.join('\n'));
}

// ─── openASHRAE36ReportModal ──────────────────────────────────────────────
/**
 * Opens the ASHRAE 36 report/proposal generation modal.
 * @param {number|string} projId
 * @param {'audit'|'proposal'} type
 */
function openASHRAE36ReportModal(projId, type) {
  var modal = document.getElementById('ashrae36ReportModal');
  if (!modal) {
    showToast('ASHRAE 36 report modal not found', 'error');
    return;
  }

  var title = type === 'proposal' ? 'Generate ASHRAE 36 Service Proposal' : 'Generate ASHRAE 36 Audit Report';
  var titleEl = modal.querySelector('.modal-title');
  if (titleEl) titleEl.textContent = title;

  var sections = ASHRAE36_SECTIONS[type] || ASHRAE36_SECTIONS.audit;

  var bodyHTML =
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Report Date</div>' +
    '<input type="date" id="a36ReportDate" value="' +
    new Date().toISOString().slice(0, 10) +
    '" style="padding:6px 10px;border:1px solid var(--s3);border-radius:6px;background:var(--s1);color:var(--text);font-size:13px;width:180px">' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">Sections to Include</div>';

  var lastGroup = null;
  sections.forEach(function (sec) {
    if (sec.group !== lastGroup) {
      if (lastGroup !== null) bodyHTML += '</div>';
      bodyHTML +=
        '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;margin-top:8px">' +
        sec.group +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:3px">';
      lastGroup = sec.group;
    }
    bodyHTML +=
      '<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--s2);cursor:pointer' +
      (sec.indent ? ';margin-left:20px' : '') +
      '">' +
      '<input type="checkbox" ' +
      (sec.defaultOn !== false ? 'checked' : '') +
      ' class="a36SecCheck" data-key="' +
      sec.key +
      '" style="accent-color:var(--em);width:14px;height:14px">' +
      '<span style="font-size:12px;color:var(--text)">' +
      sec.label +
      '</span>' +
      '</label>';
  });
  bodyHTML += '</div></div>';

  var bodyEl = modal.querySelector('#ashrae36ReportModalBody');
  if (bodyEl) bodyEl.innerHTML = bodyHTML;

  // Store context for generate button
  modal._a36ProjId = projId;
  modal._a36Type = type;

  modal.classList.add('open');
}
window.openASHRAE36ReportModal = openASHRAE36ReportModal;

/**
 * generateASHRAE36Preview — called by the modal Generate button.
 */
function generateASHRAE36Preview() {
  var modal = document.getElementById('ashrae36ReportModal');
  if (!modal) return;
  var projId = modal._a36ProjId;
  var type = modal._a36Type;

  var dateInput = document.getElementById('a36ReportDate');
  var reportDate = dateInput && dateInput.value ? dateInput.value : null;
  var data = collectASHRAE36Data(projId, reportDate);
  if (!data) {
    showToast('No equipment matrix data found. Import a BAS point list on the Equipment tab first.', 'error');
    return;
  }
  if (data._noAuditableEquip) {
    showToast(
      'No auditable equipment found. Equipment must be classified as a known HVAC type (AHU, VAV, FPB, DOAS, FCU, Zone, Furnace, Heater, Exhaust Fan, etc.) — not "Other" — to generate a report.',
      'error',
    );
    return;
  }

  // Build selected sections object
  var selectedSections = {};
  var checks = modal.querySelectorAll('.a36SecCheck');
  checks.forEach(function (cb) {
    selectedSections[cb.dataset.key] = cb.checked;
  });

  var html =
    type === 'proposal'
      ? generateASHRAE36ProposalHTML(data, selectedSections)
      : generateASHRAE36AuditHTML(data, selectedSections);

  modal.classList.remove('open');
  var reportTitle =
    type === 'proposal'
      ? data.project.name + ' — ASHRAE 36 Service Proposal'
      : data.project.name + ' — ASHRAE 36 Audit Report';

  // Expose report data so exportReportToPDF() and saveReportToHistory() can use it.
  // Store the report type alongside so the filename builder can distinguish Audit vs Proposal.
  data._ashrae = { type: type, title: reportTitle };
  window._currentReportData = data;

  showReportOverlay(html, reportTitle);
  _updateOverlayPageNumbers();
}
window.generateASHRAE36Preview = generateASHRAE36Preview;
