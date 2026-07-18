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
 * rptPage — wraps a single report page with header, body, and footer.
 * @param {number} pageNum - Page number for the data-page attribute
 * @param {string} title - Title shown in the interior page header
 * @param {string} bodyHTML - Inner HTML content for the page body
 * @param {object} options - { data, hero, label }
 */
function rptPage(pageNum, title, bodyHTML, options = {}) {
  const data = options.data;
  const isHero = options.hero === true;
  const pageLabel = options.label || 'Page ' + pageNum;

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
  const footerLabelHtml =
    data && data.period
      ? '<div style="text-align:center;font-size:10px;color:var(--rpt-page-text);padding:4px 0 2px;position:absolute;bottom:' +
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
      '<div class="rpt-pg-footer-pagenum" style="position:absolute;bottom:12px;right:20px;font-size:10px;color:var(--rpt-page-text)"></div>' +
      '</div>'
    );
  }

  return (
    '<div class="rpt-pl">' +
    pageLabel +
    '</div>' +
    '<div class="rpt-page" data-page="' +
    pageNum +
    '">' +
    '<div class="rpt-int-hdr">' +
    '<div class="rpt-pg-title">' +
    title +
    '</div>' +
    '<div class="rpt-info">' +
    (data ? data.project.client : '') +
    (interiorRangeHtml ? '<br>' + interiorRangeHtml : '') +
    '</div>' +
    '</div>' +
    '<div class="rpt-body">' +
    bodyHTML +
    '</div>' +
    footerTextHtml +
    footerLabelHtml +
    footerImgHtml +
    '<div class="rpt-pg-footer-pagenum" style="position:absolute;bottom:12px;right:20px;font-size:10px;color:var(--rpt-page-text)"></div>' +
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
  if (s.appendixA !== false)
    pages.push(_tagSection(rptPageAppendixNormalization(pageNum++, data, _nextAppLtr('norm')), 'appendixA'));
  if (s.appendixB !== false)
    pages.push(_tagSection(rptPageAppendixBaseline(pageNum++, data, _nextAppLtr('regr'), _appMap), 'appendixB'));
  if (s.appendixC !== false)
    pages.push(_tagSection(rptPageAppendixWeather(pageNum++, data, _nextAppLtr('weather')), 'appendixC'));
  if (s.appendixD !== false)
    pages.push(_tagSection(rptPageAppendixBills(pageNum++, data, _nextAppLtr('bills')), 'appendixD'));

  // Rule 2.4 (Plan B): bake page numbers into the HTML at generation time so they
  // appear on ALL paths including Board Summary (which never calls _updateOverlayPageNumbers).
  return _injectPageNumbers(pages.join('\n'));
}

/**
 * showReportOverlay — displays the report preview overlay with generated HTML.
 */
function showReportOverlay(html, title) {
  document.getElementById('reportPages').innerHTML = html;
  document.getElementById('reportOverlayTitle').textContent = title || 'Report Preview';
  document.getElementById('reportOverlay').style.display = 'flex';
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
    '<p contenteditable="true" style="font-size:10px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page summarizes the financial performance of each building in the portfolio for the reporting period. Baseline costs represent the expected energy spend based on historical consumption adjusted for weather. Projected costs reflect the target spend based on the contracted savings percentage. Current costs are the actual utility charges during the period. The difference between baseline and current represents verified cost avoidance.</p>' +
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
    '<p contenteditable="true" style="font-size:12px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page compares projected energy savings against actual performance. The monthly chart shows weather-normalized baseline consumption (projected) versus actual consumption by month. The annual summary tables aggregate consumption, demand, and cost data across all commodities to show the portfolio\'s year-over-year performance trend.</p>' +
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
    '<p contenteditable="true" style="font-size:10px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">Site Energy Use Intensity (Site EUI) measures total energy consumption at the utility meter per square foot per year in kBtu/ft². Lower EUI values indicate more efficient buildings. Buildings are benchmarked against national CBECS (Commercial Buildings Energy Consumption Survey) median values for their building type. Buildings performing below the CBECS median are more efficient than the national average. The rolling 12-month Site EUI accounts for seasonal variation and provides a stable year-round performance indicator.</p>' +
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
      '<p contenteditable="true" style="font-size:12px;color:var(--rpt-page-text);margin-top:2px"><strong>Recommendation:</strong> ' +
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
  // Page body budget: 895px actual (1056px page - 12px top pad - 45px int-hdr - 12px body-top-pad
  //   - 80px body-bottom-pad - 12px page-bottom-pad = 895px)
  // Page 1: subtract heading (~30px) + summary para (~60px) = 805px for building sections
  // Continuation pages: subtract cont heading (~30px) = 865px for building sections
  // At ~150px per building section, budget accommodates 5 on page 1 and 5 on cont pages.
  var _obsTokens = bldgSectionItems.map(function (html) {
    return { type: 'block', html: html, estH: 150 };
  });
  var _obsChunks = _rptPaginateTokens(_obsTokens, 805, 865);

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
    '<p contenteditable="true" style="font-size:12px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page details electricity consumption across all buildings for the reporting period. The charts compare weather-normalized baseline usage against actual consumption by month. The table below breaks down kilowatt-hour (kWh) usage, peak demand (kW), and costs by building to identify where the greatest savings and opportunities exist.</p>' +
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
    '<p contenteditable="true" style="font-size:12px;color:var(--rpt-page-text);line-height:1.6;margin:0 0 8px">This page details natural gas consumption across all buildings for the reporting period. Gas usage is measured in therms and is primarily driven by heating loads. The chart compares baseline consumption against actual usage by month, while the per-building table identifies where gas savings or overages are occurring.</p>' +
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
    '<p contenteditable="true" style="font-size:11px;color:var(--rpt-page-text);line-height:1.5;margin:0 0 6px">This page details natural gas and propane consumption across all buildings for the reporting period.</p>' +
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
  var meterTables = '';
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
    meterTables +=
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);background:#e8f0f8;padding:4px 8px;border-radius:3px;margin:10px 0 4px">' +
      (b.name || 'Building') +
      '</div>' +
      '<table class="rpt-table" style="font-size:10px;margin-bottom:6px">' +
      '<thead><tr>' +
      '<th>Meter</th><th>Baseline Period</th><th>Regression</th><th class="rpt-n">R²</th>' +
      '<th class="rpt-n">HDD</th><th class="rpt-n">CDD</th><th class="rpt-n">Usage/Year</th><th class="rpt-n">Cost/Year</th>' +
      '</tr></thead><tbody>' +
      meterRows +
      '</tbody></table>';
  });

  if (!meterTables) {
    meterTables =
      '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No building meter data available.</p>';
  }

  var bodyHTML =
    methodBox +
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:0 0 6px;text-transform:uppercase;letter-spacing:0.04em">Per-Building Meter Detail</h3>' +
    meterTables;

  return rptPage(n, 'Appendix ' + appLetter + ': Normalization & Meter Baseline', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Appendix ' + appLetter,
  });
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

  // Build full calculation tables per building per commodity
  var calcHTML = '';
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

    calcHTML +=
      '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);background:#e8f0f8;padding:4px 8px;border-radius:3px;margin:10px 0 4px">' +
      (b.name || 'Building') +
      '</div>';

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

      calcHTML +=
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
            '<tr style="background:#f5f5f5;color:var(--rpt-page-text)">' +
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

      calcHTML +=
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
    });

    // Render baseline-only meters (have blMonths but no regression coefficients)
    metersWithBlOnly.forEach(function (md) {
      var unit = md.commodity === 'Electric' ? 'kWh' : md.commodity === 'Gas' ? 'Therms' : 'Gal';
      var blMonthsForMeter = md.blMonths || [];
      if (!blMonthsForMeter.length) return;

      calcHTML +=
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
          '<tr style="background:#f5f5f5;color:var(--rpt-page-text)">' +
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

      calcHTML +=
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
    });
  });

  if (!calcHTML) {
    calcHTML =
      '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No regression data available for calculation display.</p>';
  }

  var bodyHTML =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Weather-normalized baseline calculations per building and commodity</div>' +
    regressionExplainer +
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.04em">Monthly Baseline Calculations</h3>' +
    calcHTML;

  return rptPage(n, 'Appendix ' + appLetter + ': Regression Model Methodology', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Appendix ' + appLetter,
  });
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
    var rowStyle = ip ? '' : 'color:var(--rpt-page-text);background:#f8f8f8';
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

  var sections = '';
  var allBillImages = '';
  if (!periodYMs.length) {
    sections =
      '<p style="font-size:10px;color:var(--rpt-page-text);font-style:italic">No reporting period months configured.</p>';
  } else {
    periodYMs.forEach(function (ym) {
      var parts = ym.split('-');
      var moLabel = monthNames[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
      var bills = billsByMonth[ym] || [];
      var rows = '';
      if (!bills.length) {
        rows =
          '<tr><td colspan="9" style="color:var(--rpt-page-text);font-style:italic">No bills recorded for this month</td></tr>';
      } else {
        bills.forEach(function (bill) {
          var _kwh = bill.kwh || bill.kwhUsage || 0;
          var _kw = bill.kw || bill.kwDemand || 0;
          var _therms = bill.therms || 0;
          var _gal = bill.gallons || bill.propaneGal || 0;
          rows +=
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
        });
      }
      bills.forEach(function (bill) {
        if (bill.pdfImage) {
          allBillImages +=
            '<div style="display:inline-block;margin:4px 6px 4px 0;border:1px solid var(--rpt-divider);border-radius:3px;overflow:hidden"><img src="' +
            bill.pdfImage +
            '" style="height:120px;width:auto;display:block"><div style="font-size:9px;color:var(--rpt-page-text);padding:2px 4px;background:#f8f8f8;text-align:center">' +
            bill.building +
            ' · ' +
            bill.commodity +
            ' · ' +
            moLabel +
            '</div></div>';
        }
      });
      sections +=
        '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);background:#e8f0f8;padding:4px 8px;border-radius:3px;margin:10px 0 4px">' +
        moLabel +
        '</div>' +
        '<table class="rpt-table" style="font-size:10px;margin-bottom:6px">' +
        '<thead><tr>' +
        '<th>Building</th><th>Commodity</th><th>Provider</th><th class="rpt-n">kWh</th><th class="rpt-n">kW</th><th class="rpt-n">Therms</th><th class="rpt-n">Gallons</th><th class="rpt-n">Cost</th><th>Bill Date</th>' +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table>';
    });
  }

  var billImagesSection = allBillImages
    ? '<div style="margin-top:16px;border-top:1px solid var(--rpt-divider);padding-top:10px">' +
      '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px">Scanned Bill Images</div>' +
      '<div style="display:flex;flex-wrap:wrap">' +
      allBillImages +
      '</div></div>'
    : '';

  var _hasBillImages = allBillImages.length > 0;
  var footerNote =
    '<div style="margin-top:12px;font-size:10px;color:var(--rpt-page-text);font-style:italic;border-top:1px solid var(--rpt-divider);padding-top:6px">' +
    (_hasBillImages
      ? 'Bill thumbnails shown above are rendered from stored PDF files.'
      : 'No scanned bill images available. Upload PDFs in the Energy Department to include bill images in future reports.') +
    '</div>';

  var bodyHTML =
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px">Original utility bill PDFs for the reporting period</div>' +
    sections +
    billImagesSection +
    footerNote;

  return rptPage(n, 'Appendix ' + appLetter + ': Utility Bills', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Appendix ' + appLetter,
  });
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

  // Show loading state on button
  const toolbar = document.querySelector('.report-toolbar');
  const exportBtn = toolbar ? toolbar.querySelector('[onclick*="exportReportToPDF"]') : null;
  const originalBtnText = exportBtn ? exportBtn.textContent : '';
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = '? Generating...';
  }

  showToast('Generating PDF... this may take a moment');

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    const pageW = 612,
      pageH = 792; // Letter size in points

    const margin = { top: 36, bottom: 36, left: 36, right: 36 }; // 36pt = 0.5in (unit: pt per jsPDF config)
    const contentW = pageW - margin.left - margin.right;
    const contentH = pageH - margin.top - margin.bottom;

    // Track whether we've started the PDF (first page is pre-created by jsPDF constructor).
    let pdfStarted = false;

    for (let i = 0; i < pages.length; i++) {
      const pageEl = pages[i];

      try {
        // Fix A (2026-06-18, items 9f80ea0f/346e8add): one-HTML-page → one-PDF-page.
        // Each .rpt-page is captured at exactly 1056px (the design target height) and
        // placed as a single image on one PDF page.  The old canvas-slice loop is gone;
        // it was slicing through rows whenever a page's canvas exceeded the slice height.
        //
        // Fix A2 (2026-06-23, item 9f80ea0f): capture actual scrollHeight instead of
        // hardcoded 1056px so overflow pages are never silently clipped.
        // .rpt-page uses min-height:1056px + overflow:visible — content that extends past
        // 1056px is fully visible in the preview but was clipped in the PDF.
        // Solution: capture Math.max(1056, scrollHeight) and let imageH_pt scale it to
        // fit the PDF content width at the same aspect ratio.  Normal pages (<=1056px)
        // render identically to before.  Overflow pages are scaled to fit — no clipping.
        const captureH = Math.max(1056, pageEl.scrollHeight);
        if (captureH > 1056) {
          console.info(
            'rpt-page',
            i + 1,
            'scrollHeight',
            pageEl.scrollHeight,
            '> 1056 — capturing full height',
            captureH,
          );
        }

        const canvas = await html2canvas(pageEl, {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
          width: 816,
          height: captureH,
        });

        // One image per PDF page.  For a normal page: canvas = 1632 × 2112 px (at scale=2),
        // imageH_pt = (2112 / 1632) * 540 = 698.8 pt — fits within 720 pt content height.
        // For an overflow page: canvas is taller; imageH_pt scales proportionally beyond
        // 720 pt so all content is preserved (slight overflow of PDF content area is
        // acceptable — no data loss, paginator keeps pages within 1050-1100px in practice).
        const imgData = canvas.toDataURL('image/jpeg', 0.92);
        const imageH_pt = (canvas.height / canvas.width) * contentW;

        if (pdfStarted) {
          doc.addPage();
        } else {
          pdfStarted = true;
        }

        doc.addImage(imgData, 'JPEG', margin.left, margin.top, contentW, imageH_pt);

        // Dispose full canvas to release GPU memory between pages (prevents OOM on 70+ page exports)
        canvas.width = 0;
        canvas.height = 0;
        await new Promise(function (r) {
          setTimeout(r, 0);
        }); // yield one tick for GC/GPU reclaim
      } catch (e) {
        console.error('Failed to render page ' + (i + 1), e);
        if (pdfStarted) {
          doc.addPage();
        } else {
          pdfStarted = true;
        }
        doc.setFontSize(12);
        doc.text('Page ' + (i + 1) + ' failed to render', margin.left, margin.top + 20);
      }
    }

    // Generate filename
    const client = data.project.client || data.project.name || 'Report';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    let filename;
    if (data._ashrae) {
      // ASHRAE 36 reports: use report type to produce distinct, collision-free names
      if (data._ashrae.type === 'proposal') {
        filename = client + ' - Service Proposal ' + dateStr + '.pdf';
      } else {
        filename = client + ' - ASHRAE 36 Audit Report ' + dateStr + '.pdf';
      }
    } else {
      const period = (data.period && data.period.label) || '';
      const typeLabel = data.period && data.period.type === 'quarterly' ? 'Quarterly' : 'Annual';
      filename = client + ' - ' + typeLabel + ' Savings Report ' + dateStr + '.pdf';
    }

    doc.save(filename);
    showToast('Report exported to PDF ?');
  } catch (err) {
    console.error('PDF export failed:', err);
    showToast('PDF export failed: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    // Restore button state
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = originalBtnText || '📄 Export to PDF';
    }
  }
}

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
      const el = document.getElementById('en-sb-version');
      if (el) {
        // Bug f5b133dc: detect CDP/Playwright-opened tab and show indicator
        const _isCDP = !!(
          navigator.webdriver ||
          window.__playwright ||
          window.__pwInitScripts ||
          window._playwrightChannel
        );
        el.textContent = fetchedVer + (_isCDP ? ' [CDP]' : '');
      }
      // Issue e9f1157c: the badge above always shows fetchedVer (the LIVE server
      // version). That does NOT mean this tab is running that code — a tab left
      // open across a deploy keeps executing whatever it loaded originally. Compare
      // fetchedVer against loadedVer, the version actually baked into the code this
      // tab already has in memory (RELEASE_NOTES[0].v ships inside app/site-functions.js,
      // which loaded with this page's own cache-busted ?v= tag — see script tags near
      // the bottom of energy-department.html). Fall back to storedVer (localStorage,
      // shared across tabs) only if RELEASE_NOTES isn't available yet.
      const _CH_VER_KEY = 'ch_last_seen_version';
      const storedVer = localStorage.getItem(_CH_VER_KEY);
      const loadedVer = (typeof RELEASE_NOTES !== 'undefined' && RELEASE_NOTES[0] && RELEASE_NOTES[0].v) || storedVer;
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
    short: 'Supply fan VFD',
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
    short: 'CO2-based demand control ventilation',
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
    impact: 'Required for VAV minimum ventilation',
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
    short: 'CO2 sensor (return or zone)',
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
    short: 'AHU supply fan status (at terminal)',
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
    short: 'Supply air temperature reset sequence (AHU)',
    impact: 'Reduces conditioning energy in mild weather',
    plain:
      'Adjusts supply air temperature to match outdoor conditions and zone demand, cutting conditioning energy during partial loads.',
  },
  ahu_dsp_reset: {
    short: 'Duct static pressure reset sequence (AHU)',
    impact: 'Cuts fan energy when demand is low',
    plain:
      'Lowers duct pressure when zones have adequate airflow, so the fan stops working harder than the building needs.',
  },
  ahu_economizer: {
    short: 'Economizer control sequence (AHU)',
    impact: 'Reduces mechanical cooling run time',
    plain: 'Uses outdoor air for free cooling whenever conditions allow, reducing chiller run time.',
  },
  ahu_freeze_prot: {
    short: 'Freeze protection sequence (AHU)',
    impact: 'Required for coil safety',
    plain: 'Shuts down the air handler when freezing is detected, preventing costly water coil damage.',
  },
  ahu_min_oa: {
    short: 'Minimum outdoor air control sequence (AHU)',
    impact: 'Required for ventilation compliance',
    plain:
      'Coordinates the outdoor air damper with fan speed to maintain code-required minimum ventilation during part-load operation.',
  },
  ahu_rf_control: {
    short: 'Return fan control sequence (AHU)',
    impact: 'Required for building pressure control',
    plain:
      'Matches return fan speed to supply fan output to maintain pressurization; without it, economizer causes pressure swings.',
  },
  vav_zone_temp: {
    short: 'Zone temperature control sequence (VAV)',
    impact: 'Required for zone comfort and compliance',
    plain:
      'Modulates airflow to maintain zone temperature between setpoints; without it, temperatures drift and simultaneous heating and cooling is common.',
  },
  vav_damper_writeback: {
    short: 'Damper position write-back sequence (VAV)',
    impact: 'Required for position verification and diagnostics',
    plain:
      'Surfaces the damper command as a BACnet read-back point for fault detection; applicable to units that expose this point in the BAS export.',
  },
  vav_reheat: {
    short: 'Zone reheat sequence (VAV)',
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
    short: 'Demand-controlled ventilation (VAV zones)',
    impact: 'Avoids conditioning air for empty rooms',
    plain: 'Adjusts outdoor air per zone based on CO₂ readings, avoiding the energy cost of ventilating empty rooms.',
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
    short: 'Zone setpoint differs from GL36 §3.1.1.1 default',
    impact: 'Zero-hardware quick win',
    plain:
      'One or more zone setpoints differ from Guideline 36 defaults. Overrides are permitted — confirm these are intentional; corrections are a no-cost software change.',
  },
  spDeadbandTooNarrow: {
    short: 'Heating/cooling deadband below GL36 §3.1.1.1 minimum (1°F)',
    impact: 'Zero-hardware quick win',
    plain:
      'The occupied deadband is below the Guideline 36 minimum of 1°F, causing heating and cooling to compete. Widening to at least 2°F requires only a programming change.',
  },
  spCO2Deviation: {
    short: 'CO₂ demand-control setpoint differs from GL36 Table 3.1.1.3 default',
    impact: 'Zero-hardware quick win',
    plain:
      'Zone CO₂ setpoint differs from the Guideline 36 default; an incorrect value causes over-ventilation or under-ventilation. Correction is software-only.',
  },
  spNotScheduled: {
    short: 'Setpoint value not found in export — schedule status unknown',
    impact: 'Data completeness',
    plain:
      'The BAS export did not include a numeric value for this setpoint; the programmed value requires a direct BAS lookup to verify.',
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
    "Adjusts how warm or cool the air handler's output is based on what the building actually needs, instead of always running at one fixed setting. Saves energy during mild weather.",
  ahu_dsp_reset:
    "Lets the supply fan slow down when the building doesn't need full airflow, instead of always pushing air at full force. Cuts fan energy use.",
  ahu_economizer:
    "Uses outdoor air to cool the building for free when it's cool enough outside, so the cooling equipment doesn't have to run as much.",
  ahu_freeze_prot:
    'Automatically shuts the air handler down if coil temperatures get cold enough to risk a frozen, burst water coil.',
  ahu_min_oa:
    'Keeps a minimum amount of fresh outdoor air coming into the building at all times to meet ventilation requirements, even as fan speed changes.',
  ahu_rf_control:
    "Keeps the return fan's speed matched to the supply fan so the building doesn't develop pressure problems, like doors that are hard to open or drafts.",
  vav_zone_temp:
    'Keeps each room or zone at its target temperature by adjusting how much heated or cooled air is delivered to that space.',
  vav_damper_writeback:
    'Confirms the air damper in each zone is actually at the position the system commands, so a stuck or failed damper gets caught early instead of silently wasting energy or causing comfort complaints.',
  vav_reheat:
    "Adds a small amount of heat to already-cooled supply air at the zone level so a room doesn't overcool when it needs less airflow.",
  hwp_supply_reset:
    "Lowers the hot water temperature sent out to the building as the weather warms up, so the boiler doesn't heat water hotter than it needs to.",
  hwp_pump_dp_reset:
    'Lets the hot water pump slow down when fewer rooms are calling for heat, instead of always pumping at full speed.',
  hwp_staging:
    'Automatically brings a second boiler online only when the building actually needs the extra heat, and shuts it back off when demand drops, instead of running every boiler all the time.',
  chwp_supply_reset:
    "Raises the chilled water temperature sent out to the building when cooling loads are light, so the chiller doesn't have to work as hard as it does on a full-load day.",
  chwp_pump_dp_reset:
    'Lets the chilled water pump slow down when cooling demand is low, instead of always pumping at full speed.',
  chwp_staging:
    'Automatically brings a second chiller online only when the building actually needs the extra cooling, and shuts it back off when demand drops.',
  demandCtrl:
    'Uses a CO2 sensor to bring in only as much outdoor air as the number of people in the building actually calls for, instead of a fixed amount around the clock.',
  vav_dcv:
    'Uses a CO2 sensor at the zone level to adjust ventilation air based on how many people are actually in that specific room.',
};

/**
 * ASHRAE36_SECTIONS — defines available report sections for the audit and proposal.
 * Mirrors the REPORT_SECTIONS pattern.
 */
var ASHRAE36_SECTIONS = {
  audit: [
    { key: 'cover', label: 'Cover Page', group: 'Report', defaultOn: true },
    { key: 'executive', label: 'Executive Summary', group: 'Report', defaultOn: true },
    { key: 'costEstimate', label: 'ASHRAE Guideline 36 Sequences', group: 'Report', defaultOn: true },
    { key: 'building', label: 'Per-Building Detail', group: 'Report', defaultOn: true },
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
    { key: 'setpointReview', label: 'Setpoint Programming Review', group: 'Report', defaultOn: true },
    // Phase D-3: Point inventory completeness — informational only, never affects Coverage %
    { key: 'pointInventory', label: 'Point Inventory Completeness', group: 'Report', defaultOn: true },
  ],
  proposal: [
    { key: 'proposalCover', label: 'Cover Page', group: 'Proposal', defaultOn: true },
    { key: 'proposalScope', label: 'Scope of Work', group: 'Proposal', defaultOn: true },
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
    {
      key: 'costEstimatePerBuilding',
      label: '  Per-Building Pricing',
      group: 'Proposal',
      defaultOn: false,
      indent: true,
    },
    { key: 'costEstimateItemized', label: '  Itemized Measures', group: 'Proposal', defaultOn: false, indent: true },
    { key: 'proposalOutcomes', label: 'Expected Outcomes', group: 'Proposal', defaultOn: true },
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
    vav: 'VAV Terminal',
    fpb: 'Fan-Powered Terminal',
    ddvav: 'Dual-Duct Terminal',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Tower',
    doas: 'DOAS',
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

      // Accumulate physical point coverage totals
      totalPointsRequired += result.totalRequired;
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

    // Status band
    var status =
      composite >= ASHRAE36_READINESS_HIGH_THRESHOLD
        ? 'green'
        : composite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
          ? 'amber'
          : 'red';
    var statusColor =
      composite >= ASHRAE36_READINESS_HIGH_THRESHOLD
        ? 'var(--rpt-green)'
        : composite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
          ? 'var(--rpt-orange)'
          : 'var(--rpt-red)';
    // Display-label rename (item ed465b3c, 2026-07-09; re-worded again fix/audit-report-scoring,
    // 2026-07-14, Matt's decision: ASHRAE 36 defines no composite score and no compliance
    // threshold, so "Compliant" wording next to genuine §5.x citations falsely implies the
    // standard blesses this bar. Matches _a36StatusChip's wording.
    // This field isn't rendered directly anywhere today (the chip helper independently
    // derives its word from `status`), kept in sync anyway so it can't drift if a future
    // caller starts reading it.
    var statusLabel =
      composite >= ASHRAE36_READINESS_HIGH_THRESHOLD
        ? 'High Readiness'
        : composite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
          ? 'Partial Readiness'
          : 'Low Readiness';
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
      name: bName,
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

  // Portfolio averages
  var portfolioComposite = buildingsData.length
    ? Math.round(
        buildingsData.reduce(function (s, b) {
          return s + b.composite;
        }, 0) / buildingsData.length,
      )
    : 0;
  var portfolioPointPct = buildingsData.length
    ? Math.round(
        buildingsData.reduce(function (s, b) {
          return s + b.pointPct;
        }, 0) / buildingsData.length,
      )
    : 0;
  // Exclude buildings with null seqPct (no applicable sequences) from the portfolio average.
  var _seqBuildings = buildingsData.filter(function (b) {
    return b.seqPct !== null;
  });
  var portfolioSeqPct = _seqBuildings.length
    ? Math.round(
        _seqBuildings.reduce(function (s, b) {
          return s + b.seqPct;
        }, 0) / _seqBuildings.length,
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
  var portfolioStatus =
    portfolioComposite >= ASHRAE36_READINESS_HIGH_THRESHOLD
      ? 'green'
      : portfolioComposite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
        ? 'amber'
        : 'red';

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
  var _invBuildingRows = Object.keys(_invByBuilding)
    .sort()
    .map(function (bName) {
      return { name: bName, ashrae: _invByBuilding[bName].ashrae, other: _invByBuilding[bName].other };
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
    ' stroke-linecap="round" transform="rotate(90 ' +
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
    '" font-weight="700" fill="' +
    color +
    '" font-family="Arial,sans-serif">' +
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
// status: 'green'|'amber'|'red'; inPlace/required: sensor counts (optional).
// Renders "High Readiness · 3/3 sensors" style label when counts are provided.
function _a36StatusChip(status, inPlace, required, seqNA) {
  // `color` is computed for the caller's colored status bar (data-viz, kept — see the
  // `.rpt-a36-*` executive-summary/building rows that render `color` alongside this chip's
  // word). Batch 3 item 3c ("make chip WORD black") was already satisfied at this line —
  // the word itself renders in var(--rpt-page-text) (#000000), not `color`; confirmed via
  // before/after render, no visual change on this element. Left as-is, not re-touched.
  var color = status === 'green' ? 'var(--rpt-green)' : status === 'amber' ? 'var(--rpt-orange)' : 'var(--rpt-red)';
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
  var word = status === 'green' ? 'High Readiness' : status === 'amber' ? 'Partial Readiness' : 'Low Readiness';
  // 2026-07-10 fix (audit-report-na-rationale, wording-decision.md item 1): when the caller
  // passes seqNA (true for a building whose seqPct is null -- zero equipment within Guideline
  // 36's sequence scope), `status`/`composite` are driven entirely by sensor coverage with no
  // sequence assessment behind them at all. "High Readiness" affirmatively (and falsely)
  // claims a verified sequence pass that never happened, so this word must not render for that
  // case. Neutral word only -- does not touch `status`, `color`, the composite score, or any
  // other caller's threshold logic for buildings that DO have applicable sequences.
  if (seqNA) word = 'Not Applicable';
  // Batch 3 item 2/3a: at 100% (inPlace === required, required > 0) the fraction is a
  // tautology ("High Readiness · 22/22 sensors" — 100% + a fraction that's obviously 1:1 tells
  // the reader nothing new, per Matt's flag) — drop it and show the word alone. Below 100%,
  // unchanged (e.g. "Partial Readiness · 178/261 sensors", "Low Readiness · 7/16 sensors").
  var isComplete = inPlace !== undefined && required !== undefined && required > 0 && inPlace === required;
  var label =
    inPlace !== undefined && required !== undefined && !isComplete
      ? word + ' · ' + inPlace + '/' + required + ' sensors'
      : word;
  return '<span style="font-size:10px;color:var(--rpt-page-text)">' + label + '</span>';
}

// ─── rptPageASHRAE36Cover ─────────────────────────────────────────────────
/**
 * Cover page: three gauge rings (overall/sensor/sequence), one-paragraph finding.
 * Hero page — no interior header, uses CSC letterhead.
 */
function rptPageASHRAE36Cover(n, d, perBuildingIncluded) {
  var p = d.portfolio;
  var color =
    p.composite >= ASHRAE36_READINESS_HIGH_THRESHOLD
      ? 'var(--rpt-green)'
      : p.composite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
        ? 'var(--rpt-orange)'
        : 'var(--rpt-red)';
  // One-paragraph finding
  var finding =
    'To meet ASHRAE Guideline 36, <strong>' +
    d.project.name +
    '</strong> needs <strong>' +
    p.totalMissingHardwarePoints +
    (p.totalMissingHardwarePoints === 1 ? ' sensor or actuator' : ' sensors and actuators') +
    ' installed</strong> and <strong>' +
    p.totalNotReadySequences +
    ' control sequence' +
    (p.totalNotReadySequences !== 1 ? 's' : '') +
    ' programmed</strong> across <strong>' +
    p.totalEquip +
    ' piece' +
    (p.totalEquip !== 1 ? 's' : '') +
    ' of HVAC equipment</strong> in <strong>' +
    p.totalBuildings +
    ' building' +
    (p.totalBuildings !== 1 ? 's' : '') +
    '</strong>. ' +
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
    '<div style="display:flex;justify-content:center;gap:36px;margin:24px 0 20px">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.composite, color, 'Overall', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Composite Score</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.pointPct, 'var(--rpt-blue)', 'Sensors', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sensor Coverage</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.seqPct, '#7c3aed', 'Sequences', 110, true) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sequence Readiness</div></div>' +
    '</div>';

  var bodyHTML =
    '<div style="padding:20px 48px 16px">' +
    '<div style="text-align:center;margin-bottom:0">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">ASHRAE 36 Audit Report</div>' +
    '<div style="font-size:15px;color:var(--rpt-page-text);margin-bottom:16px">' +
    d.project.name +
    '</div>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:8px">' +
    "This report evaluates the facility's building automation system against ASHRAE Guideline 36 — the industry standard for high-performance HVAC control. " +
    'It identifies the specific sensors to install and control sequences to program to bring the facility into full alignment with Guideline 36. ' +
    'Use it to scope and prioritize the recommended upgrades.' +
    '</div>' +
    gauges +
    '<div class="rpt-a36-callout" style="font-size:12px;line-height:1.6;color:var(--rpt-page-text)">' +
    finding +
    '</div>' +
    '<div style="display:flex;gap:16px;margin-top:16px">' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    p.totalMissingHardwarePoints +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Sensors to Install</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    p.totalNotReadySequences +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Sequences to Program</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    p.totalEquip +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">HVAC Systems Audited</div>' +
    '</div>' +
    '<div class="rpt-a36-stat-card" style="flex:1;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    p.totalBuildings +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Buildings Assessed</div>' +
    '</div>' +
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

  // Key finding callout (first page only)
  var topGap = p.topGaps[0];
  var callout = '';
  if (topGap) {
    callout =
      '<div class="rpt-a36-callout" style="margin-bottom:14px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px">Most Common Gap Across Portfolio</div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">' +
      (ASHRAE36_GAP_DESCRIPTIONS[topGap.key] ? ASHRAE36_GAP_DESCRIPTIONS[topGap.key].short : topGap.key) +
      '</div>' +
      '<div style="font-size:11px;color:var(--rpt-page-text)">' +
      (ASHRAE36_GAP_DESCRIPTIONS[topGap.key] ? ASHRAE36_GAP_DESCRIPTIONS[topGap.key].plain : '') +
      '</div>' +
      '</div>';
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
    var dcvSentence = dcvParts.join(' and ') + ' have no CO₂ sensor.';
    dcvCallout =
      '<div class="rpt-a36-callout" style="margin-bottom:14px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px">Demand Control Ventilation Readiness</div>' +
      '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6">' +
      dcvSentence +
      ' Without CO₂ sensing, these units ventilate at full design rates even when spaces are empty—wasting fan and cooling energy. ' +
      'Adding CO₂ sensors enables demand control ventilation, so equipment stops conditioning air for spaces that are empty.' +
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
  var _firstChromeH = 0;
  if (dcvCallout) _firstChromeH += 94; // measured ~86px; use 94 for slight overcount safety
  if (callout) _firstChromeH += 72; // measured ~68px; use 72 for safety
  _firstChromeH += 28; // tableTitle (~20px actual; 28 is safe overcount)
  _firstChromeH += 44; // thead — DOM-measured 42px (spec said 32, was wrong)
  _firstChromeH += 50; // tableFootnote — 3-line plain-language footnote, DOM-measured 45px actual; 50 for safety
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
  var ROWS_BUDGET_FIRST = 862 - _firstChromeH - 30; // 30px safety margin
  var ROWS_BUDGET_CONT = 717;

  // Shared table styles
  var tableTitle =
    '<div style="font-size:13px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">Building ASHRAE 36 Readiness</div>';
  var thStyle =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0;color:#fff;background:var(--rpt-blue);text-align:left;white-space:normal;line-height:1.25';
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
  // still ~13px above its 173px need), Score untouched (already has a small pre-existing
  // 3px overflow on the "100%" score-bar text, out of scope for this header-only fix — do not
  // shrink Score further or that pre-existing issue gets worse). +5% total went to
  // Equipment/Sensor/Sequence. Re-verified after rebalancing: 0 header overflow, 0 data-row
  // line-wrap regressions (see dashboardlogic entry for the exact before/after numbers).
  var colWidths = { building: 30, equipment: 10, sensor: 9, sequence: 9, score: 14, status: 28 };
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
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;table-layout:fixed">' +
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
    '<div style="font-size:10px;color:var(--rpt-page-text);margin-top:-10px;margin-bottom:16px;line-height:1.5">' +
    '<strong>Score</strong> is Control Service Company’s own readiness assessment, built on ASHRAE Guideline 36 requirements ' +
    'and weighted by how many apply to each equipment type — ASHRAE 36 itself defines no composite score or compliance threshold. ' +
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
    var barPx = Math.round(b.composite * 0.6);
    var bar =
      '<div style="display:flex;align-items:center;gap:4px">' +
      '<div style="width:' +
      barPx +
      'px;max-width:60px;height:8px;background:' +
      b.statusColor +
      ';border-radius:2px;min-width:2px"></div>' +
      '<span style="font-size:10px;color:var(--rpt-page-text)">' +
      b.composite +
      '%</span>' +
      '</div>';
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      b.name +
      '</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      b.equipCount +
      '</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      b.pointPct +
      '%</div></td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-border);text-align:center">' +
      '<div style="' +
      _rowBoxStyle +
      ';justify-content:center">' +
      (b.seqPct !== null ? b.seqPct + '%' : 'N/A') +
      '</div></td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      bar +
      '</div></td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid var(--rpt-border)">' +
      '<div style="' +
      _rowBoxStyle +
      '">' +
      _a36StatusChip(b.status, b.totalSensorsInPlace, b.totalSensorsRequired, b.seqPct === null) +
      '</div></td>' +
      '</tr>'
    );
  }

  // Build flat token list — one token per building row
  // estH: ROW_BOX_MIN_H (40px content box) + 10px td padding (5+5) = 50px per row, now uniform
  // for every row (1-line or 2-line building name) after the row-height fix above. Placeholder
  // value re-verified against real DOM-measured heights on JOCO data (see gate results).
  var allBuildings = d.buildings;
  var tokens = allBuildings.map(function (b) {
    return { type: 'row', estH: ROW_BOX_MIN_H + 10, html: _buildRowHTML(b) };
  });
  // Edge case: no buildings
  if (tokens.length === 0) {
    tokens.push({
      type: 'row',
      estH: ROW_BOX_MIN_H + 10,
      html: '<tr><td colspan="6" style="padding:8px;font-size:11px;color:var(--rpt-page-text)">No buildings in portfolio.</td></tr>',
    });
  }

  // Paginate using shared pixel-height paginator
  var chunks = _rptPaginateTokens(tokens, ROWS_BUDGET_FIRST, ROWS_BUDGET_CONT);

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

    var bodyHTML;
    if (chunkIndex === 0) {
      // First page: callouts + titled table + footnote
      bodyHTML = dcvCallout + callout + tableTitle + table + tableFootnote;
    } else {
      // Continuation page: minimal header + table + footnote
      var contHdr =
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        'Building ASHRAE 36 Readiness — continued (' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + table + tableFootnote;
    }

    resultPages.push(
      rptPage(pageN, 'ASHRAE 36 Audit Report — Executive Summary', bodyHTML, {
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

    var seqDefsList =
      typeof EM_SEQUENCE_DEFS !== 'undefined' && Array.isArray(EM_SEQUENCE_DEFS) ? EM_SEQUENCE_DEFS : [];
    seqDefsList.forEach(function (seq) {
      if (!seqApplicable[seq.key]) return; // not applicable to any equipment in this portfolio
      var plainDesc = (typeof ASHRAE36_SEQUENCE_PLAIN !== 'undefined' && ASHRAE36_SEQUENCE_PLAIN[seq.key]) || '';
      var rowHTML =
        '<tr>' +
        '<td style="padding:7px 10px;font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'border-bottom:1px solid var(--rpt-rule);vertical-align:top;width:26%">' +
        _esc(seq.label) +
        '</td>' +
        '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
        'border-bottom:1px solid var(--rpt-rule);vertical-align:top;width:16%;white-space:nowrap">' +
        'ASHRAE 36 ' +
        _esc(seq.ashrae36 || '') +
        '</td>' +
        '<td style="padding:7px 10px;font-size:11px;color:var(--rpt-page-text);' +
        'border-bottom:1px solid var(--rpt-rule);line-height:1.5;vertical-align:top">' +
        _esc(plainDesc) +
        '</td>' +
        '</tr>';
      // estH: DOM-measured 40–65px per row (avg ~55px); 60px for safety on wrapping text
      rationaleTokens.push({ type: 'row', html: rowHTML, estH: 60 });
    });
  } catch (e) {
    rationaleTokens = []; // non-fatal — omit block if anything throws
  }

  // ── Page assembly with sequence table pagination ───────────────────────────
  // Budget updated (2026-06-29): cost table removed; full body available for rows.
  //   Page 1 body ~808px; chrome = _ratTitle(~17px) + _ratThead(~27px) + div(~18px) = ~62px
  //   Row budget = 808 − 62 = ~746px; using 740 for safety margin.
  //   Cont pages: same calibrated value of 750px.
  var RATIONALE_BUDGET_FIRST = 740;
  var RATIONALE_BUDGET_CONT = 750;

  var SEQ_SECTION_TITLE = 'ASHRAE Guideline 36 Sequences';

  // Shared HTML fragments for the sequence table chrome
  var _ratTitle =
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:8px;' +
    'text-transform:uppercase;letter-spacing:0.04em">' +
    SEQ_SECTION_TITLE +
    '</div>';
  // Status column removed (2026-07-09, Matt's decision): this table is informational
  // reference only (what each sequence IS, not a per-project readiness rollup) — see the
  // rationaleTokens comment above. Widths redistributed across the remaining 3 columns.
  var _ratThead =
    '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left;width:26%">Sequence</th>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left;width:16%">ASHRAE 36 Spec</th>' +
    '<th style="padding:6px 10px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left">Description</th>' +
    '</tr></thead><tbody>';
  var _ratTclose = '</tbody></table>';

  var resultPages = [];
  var currentPageNum = n;

  if (rationaleTokens.length === 0) {
    // No sequence data (fallback path or no rows) — single page with simple note
    resultPages.push(
      rptPage(
        currentPageNum,
        'ASHRAE 36 Audit Report — ' + SEQ_SECTION_TITLE,
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
      var pageBody = '<div>' + _ratTitle + _ratThead + chunkRowsHTML + _ratTclose + '</div>';

      resultPages.push(
        rptPage(
          currentPageNum,
          isFirst
            ? 'ASHRAE 36 Audit Report — ' + SEQ_SECTION_TITLE
            : 'ASHRAE 36 Audit Report — ' + SEQ_SECTION_TITLE + ' (cont.)',
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
  var CAT_LABELS_PLURAL = {
    ahu: 'Air Handlers',
    vav: 'VAV Terminals',
    fpb: 'Fan-Powered Terminals',
    ddvav: 'Dual-Duct Terminals',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Towers',
    doas: 'DOAS Units',
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

  var gauges =
    '<div style="display:flex;gap:20px;margin-bottom:12px;align-items:center">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.composite, b.statusColor, 'Overall', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.pointPct, 'var(--rpt-blue)', 'Sensors', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    (b.seqPct !== null
      ? _a36GaugeSVG(b.seqPct, '#7c3aed', 'Sequences', 70)
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
    b.name +
    '</h2>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:6px">' +
    b.equipCount +
    ' equipment units audited</div>' +
    '<div style="margin-bottom:4px">' +
    equipBreakdown +
    '</div>' +
    _a36StatusChip(b.status, b.totalSensorsInPlace, b.totalSensorsRequired, b.seqPct === null) +
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

  // Compute building-level totals for summary line (last chunk only)
  var totalSensorsNeeded = 0;
  var totalSeqsNotReady = 0;
  sortedEquip.forEach(function (eq) {
    totalSensorsNeeded += (eq.compliance.missingPoints || []).length;
    var sr = eq.seqReadiness || {};
    for (var k in sr) {
      if (sr.hasOwnProperty(k) && (sr[k].status === 'blocked' || sr[k].status === 'partial')) {
        totalSeqsNotReady++;
      }
    }
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
  var colWidths = { equip: 24, units: 6, sensors: 34, seqs: 36 };
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
  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left;' +
    'border-bottom:2px solid var(--rpt-blue)';
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
    var rowBorder = 'border-bottom:1px solid var(--rpt-border)';
    var tdBase = 'padding:4px 8px;font-size:10px;vertical-align:top;' + rowBorder;

    // Pixel-height estimate for this row (used by chunk pagination below).
    // "Sensors Needed" column is ~200px wide at 10px font ≈ 30 chars/line.
    // "Sequences" column is ~180px wide ≈ 28 chars/line.
    // Each line is ~15px tall; base row padding (top+bottom 4px each) = 8px overhead.
    var sensorsText = mp.length === 0 ? '' : missingNames.join(', ');
    var seqsText = notReadySeqs.join(', ');
    var sensorLines = mp.length === 0 ? 1 : Math.max(1, Math.ceil(sensorsText.length / 30));
    var seqLines = notReadySeqs.length === 0 ? 1 : Math.max(1, Math.ceil(seqsText.length / 28));
    var rowEstH = 8 + Math.max(sensorLines, seqLines) * 15;

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
  // Counts use the same underlying data as the cover-page totals
  // (missingPoints.length for sensors; blocked/partial seqReadiness entries for sequences).
  function _pushCatSummaryRow(cat, catRows) {
    var unitCount = catRows.length;
    var sensorsSum = 0;
    var seqsSum = 0;
    // 2026-07-10 fix (audit-report-na-rationale): tracks whether ANY sequence in
    // EM_SEQUENCE_DEFS was ever applicable to this equipment category (status !== 'na'
    // for at least one entry across all rows). Categories like furnaces/heaters/zone
    // terminals have EVERY sequence hit status:'na' via the equipTypes scope check
    // (emComputeSequenceReadiness, app/equipment-matrix.js) -- Guideline 36 was never
    // checked against them at all, which is a different fact from "checked and passed."
    var hasApplicableSeq = false;
    // Frequency maps for top-type breakdown (Change B 2026-06-16)
    var mpFreq = {};
    var sqFreq = {};
    catRows.forEach(function (eq) {
      (eq.compliance.missingPoints || []).forEach(function (mp) {
        sensorsSum++;
        var lbl = _missingPointName(mp);
        mpFreq[lbl] = (mpFreq[lbl] || 0) + 1;
      });
      var sr = eq.seqReadiness || {};
      for (var sk in sr) {
        if (!sr.hasOwnProperty(sk)) continue;
        if (sr[sk].status !== 'na') hasApplicableSeq = true;
        if (sr[sk].status === 'blocked' || sr[sk].status === 'partial') {
          seqsSum++;
          var slbl = _seqLabel(sk, sr[sk]);
          sqFreq[slbl] = (sqFreq[slbl] || 0) + 1;
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

    var sensorsCell =
      sensorsSum === 0 ? '0 — Complete' : sensorsBreakdown ? sensorsSum + ' — ' + sensorsBreakdown : String(sensorsSum);
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
        ? '0 — Fully Compliant'
        : seqsBreakdown
          ? seqsSum + ' — ' + seqsBreakdown
          : String(seqsSum);

    // 2026-07-10 fix: near-black --rpt-border, same reasoning as _pushEquipRow's rowBorder above.
    var tdBase = 'padding:5px 8px;font-size:10px;vertical-align:middle;border-bottom:1px solid var(--rpt-border)';
    tokens.push({
      type: 'row',
      estH: sensorsSum > 0 || seqsSum > 0 ? 34 : 26,
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
  var summaryRowHtml =
    '<tfoot><tr style="background:var(--rpt-table-tot-bg)">' +
    '<td colspan="4" style="padding:6px 8px;font-size:11px;color:var(--rpt-page-text);' +
    'border-top:2px solid var(--rpt-table-tot-bdr)">' +
    '<strong>Total for ' +
    b.name +
    ':</strong> install ' +
    totalSensorsNeeded +
    ' sensor' +
    (totalSensorsNeeded !== 1 ? 's' : '') +
    ', program ' +
    totalSeqsNotReady +
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
    '<div style="font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.05em;color:var(--rpt-blue);margin-bottom:6px">Building Infrastructure (BAS Export)</div>' +
    '<div style="display:flex;gap:24px">' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">' +
    '<span style="font-weight:600">Dedicated BAS power monitoring:</span> ' +
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
    'The table below summarizes each equipment type — the number of units audited, sensors that must be added, ' +
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
  var ROWS_BUDGET_FIRST = 730; // px available for equipment rows on page 1
  var ROWS_BUDGET_CONT = 830; // px available for equipment rows on continuation pages

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
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        b.name +
        ' — continued (' +
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

    resultPages.push(
      rptPage(pageN, 'ASHRAE 36 Audit Report — ' + b.name, bodyHTML, {
        data: fakeData,
        label:
          'Page ' + pageN + ' — ' + b.name + (numChunks > 1 ? ' (' + (chunkIndex + 1) + '/' + numChunks + ')' : ''),
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
  var blockHTML = '<div style="margin-bottom:24px">' + innerHTML + '</div>';

  // estH: same chrome estimate used by rptPageASHRAE36Building's ROWS_BUDGET_FIRST derivation
  // (gauges ~100px + intro ~35px + thead ~30px) + summed row heights + summary line (~30px) +
  // optional infra callout (~50px) + this block's own separator chrome (~32px).
  var rowsH = c.tokens.reduce(function (s, t) {
    return s + (t.estH || 20);
  }, 0);
  var estH = 100 + 35 + 30 + rowsH + 30 + (showBuildingInfra ? 50 : 0) + 32;

  return { type: 'block', estH: estH, html: blockHTML, name: c.b.name };
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
          return b.name;
        });
      var affectedStr =
        affectedList.length > 3
          ? affectedList.slice(0, 3).join(', ') + ' + ' + (affectedList.length - 3) + ' more'
          : affectedList.join(', ');
      return (
        '<tr>' +
        '<td style="padding:6px 8px;font-size:11px;font-weight:700;color:var(--rpt-blue);border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
        (idx + 1) +
        '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">' +
        (desc.short || gap.key) +
        '</div>' +
        '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
        (desc.plain || '') +
        '</div>' +
        '</td>' +
        '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border-bottom:1px solid var(--rpt-rule);vertical-align:top;white-space:nowrap">' +
        (desc.impact || '—') +
        '</td>' +
        '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
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
      '<td style="padding:6px 8px;font-size:11px;font-weight:700;color:var(--rpt-blue);border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
      (recCount + 1) +
      '</td>' +
      '<td style="padding:6px 8px;border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
      '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">Add CO₂ sensors — enable demand control ventilation</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
      (dcvDesc.plain ||
        'CO₂ sensors measure occupancy indirectly and allow the BAS to reduce outdoor air intake when spaces are unoccupied. Without them, these units ventilate at full design rates around the clock.') +
      '</div>' +
      '</td>' +
      '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border-bottom:1px solid var(--rpt-rule);vertical-align:top;white-space:nowrap">' +
      (dcvDesc.impact || 'Avoids conditioning air for empty rooms') +
      '</td>' +
      '<td style="padding:6px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);vertical-align:top">' +
      dcvUnitStr +
      '</td>' +
      '</tr>';
  }

  var thStyle =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left';
  var table =
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
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
      '<div class="rpt-a36-callout" style="font-size:11px;color:var(--rpt-page-text);line-height:1.6">' +
      'No zone setpoint values were found in the equipment export for this project. ' +
      'Setpoint data is present when zones trend their occupied heating and cooling setpoints. ' +
      'Import an updated equipment matrix export to enable this analysis.' +
      '</div>';
    return [
      rptPage(n, 'ASHRAE 36 Audit Report — Setpoint Programming Review', emptyBody, {
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
      deviatorLabel = zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ' — no setpoint data';
    } else {
      deviatorLabel = zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ' match';
    }

    return {
      name: bName,
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
    if (a.name < b2.name) return -1;
    if (a.name > b2.name) return 1;
    return 0;
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
  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left;' +
    'white-space:normal;word-wrap:break-word;line-height:1.3';
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
    '">GL36 Default<br><span style="font-size:9px;font-weight:400;text-transform:none">Heat / Cool</span></th>' +
    '<th style="' +
    thStyleC +
    '">Avg Deadband</th>' +
    '<th style="' +
    thStyleC +
    '">Status</th>' +
    '</tr></thead>';

  var tdBase = 'padding:4px 8px;font-size:10px;vertical-align:middle;border-bottom:1px solid var(--rpt-rule)';
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
      row.name +
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
  if (matchesTotal > 0) summaryParts.push(matchesTotal + ' match GL36 defaults');

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
      '<div style="font-size:10px;font-weight:700;color:var(--rpt-blue);margin-bottom:3px">CO₂ Setpoint Data Not Found in Export</div>' +
      '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6">' +
      'DCV CO₂ setpoints (GL36 §3.1.1.3 / Table 3.1.1.3) were not present in the equipment matrix export for this project. ' +
      'CO₂ setpoint values are programmed set-points in the BAS controller — separate from the live CO₂ sensor readings shown in the equipment matrix. ' +
      'A direct BAS lookup or updated export with CO₂ setpoint points is needed to complete this check.' +
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
      'Only buildings with zone-level terminal equipment (VAV boxes, fan-powered boxes, fan coil units, and similar) are shown — these are the units ASHRAE Guideline 36’s zone setpoint standards apply to. ' +
      _excludedCount +
      ' of ' +
      _totalScoredBuildings +
      ' buildings are not included here because their HVAC equipment (rooftop units, heaters, exhaust fans, and similar) has no separate zone-level setpoints to review.' +
      '</div>' +
      '</div>';
  }

  // ── Preamble ──────────────────────────────────────────────────────────────
  var preamble =
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:10px">' +
    'ASHRAE Guideline 36 §3.1.1.1 and Table 3.1.1.1 define default occupied and unoccupied temperature setpoints for three zone types. ' +
    'These are starting points — designer overrides are explicitly permitted and may be intentional for specific spaces. ' +
    'Items marked Needs Review should be confirmed with the design engineer or facility staff to determine whether the deviation is intentional. ' +
    'Values shown are building averages across all zone equipment in the BAS export.' +
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
  var ROWS_BUDGET_FIRST = 758;
  var ROWS_BUDGET_CONT = 803;

  var tokens = buildingRows.map(function (row) {
    return { type: 'row', estH: 46, html: _buildBldgRowHTML(row) };
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
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        'Setpoint Programming Review — continued (' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + table + (chunkIndex === numChunks - 1 ? co2Note + exclusionNote : '');
    }

    resultPages.push(
      rptPage(pageN, 'ASHRAE 36 Audit Report — Setpoint Programming Review', bodyHTML, {
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
function rptPageASHRAE36ProposalCover(n, d) {
  var p = d.portfolio;
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };
  var color =
    p.composite >= ASHRAE36_READINESS_HIGH_THRESHOLD
      ? 'var(--rpt-green)'
      : p.composite >= ASHRAE36_READINESS_PARTIAL_THRESHOLD
        ? 'var(--rpt-orange)'
        : 'var(--rpt-red)';

  var intro =
    '<div style="font-size:12px;color:var(--rpt-page-text);line-height:1.7;margin-bottom:16px">' +
    // Wording (fix/audit-report-scoring, 2026-07-14, Matt's decision): "compliance audit" /
    // "compliance score" / "Guideline 36 compliance" reworded to "readiness" throughout --
    // ASHRAE 36 defines no compliance score of its own; this is CSC's own assessment.
    'Based on our ASHRAE Guideline 36 readiness assessment of <strong>' +
    d.project.name +
    '</strong>, ' +
    'Control Service Company is pleased to present this service proposal. ' +
    'Our assessment identified an overall readiness score of <strong style="color:' +
    color +
    '">' +
    p.composite +
    '%</strong> across ' +
    p.totalBuildings +
    ' buildings and ' +
    p.totalEquip +
    ' equipment units. ' +
    'This proposal outlines the programming and hardware upgrades needed to bring your facility into full alignment with Guideline 36, ' +
    'maximizing energy savings and occupant comfort.' +
    '</div>';

  var bodyHTML =
    '<div style="padding:16px 48px">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">ASHRAE Guideline 36</div>' +
    '<div style="font-size:17px;font-weight:600;color:var(--rpt-page-text);margin-bottom:4px">BAS Programming &amp; Upgrade Proposal</div>' +
    '<div style="font-size:13px;color:var(--rpt-page-text);margin-bottom:20px">' +
    d.project.name +
    ' &nbsp;|&nbsp; ' +
    d.date +
    '</div>' +
    '<div style="height:2px;background:var(--rpt-blue);margin-bottom:20px"></div>' +
    intro +
    '<div style="font-size:10px;color:var(--rpt-page-text);border-top:1px solid var(--rpt-rule);padding-top:8px">' +
    'Prepared by Control Service Company &nbsp;&bull;&nbsp; Building Automation &amp; Energy Services' +
    '</div>' +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal — Cover', bodyHTML, {
    hero: true,
    data: fakeData,
    label: 'Page ' + n + ' — Proposal Cover',
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
  var phase1Gaps = p.topGaps.filter(function (g) {
    return SEQUENCE_KEYS.indexOf(g.key) === -1;
  });
  var phase2Gaps = p.topGaps.filter(function (g) {
    return SEQUENCE_KEYS.indexOf(g.key) !== -1;
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
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      'Carbon Dioxide (CO₂) sensors for demand-controlled ventilation' +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      _dcvScopeStr +
      ' affected' +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border-bottom:1px solid var(--rpt-rule)">' +
      'Avoids conditioning air for empty rooms' +
      '</td>' +
      '</tr>';
  }

  function scopeRow(gap) {
    var desc = gap.desc || {};
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      (desc.short || gap.key) +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      gap.count +
      ' units affected</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-orange);font-weight:600;border-bottom:1px solid var(--rpt-rule)">' +
      (desc.impact || '—') +
      '</td>' +
      '</tr>'
    );
  }

  var thStyle =
    'padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left';

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
        phase1Gaps.map(scopeRow).join('') +
        dcvScopeRow +
        '</tbody></table>'
      : '<div style="font-size:11px;color:var(--rpt-green);padding:6px">No hardware gaps identified — all required sensors and actuators appear to be present.</div>';

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
    : '<div style="font-size:11px;color:var(--rpt-green);padding:6px">No sequence programming gaps identified — all key ASHRAE 36 sequences appear to be active.</div>';

  // Batch 3 item 4 (design-language pass extended to a flagged spot, per bolding-consistency-
  // audit.md finding #2): same "more human / less colored fill" treatment already applied to
  // _proposalOutcomeCard one page later in this same document — colored border + colored
  // title (var(--rpt-blue) and hardcoded #7c3aed purple) → var(--rpt-rule) border + black title.
  var bodyHTML =
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin-bottom:6px;border-bottom:2px solid var(--rpt-rule);padding-bottom:3px">Phase 1 — Hardware &amp; Sensor Upgrades</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Installation of missing sensors and actuators required for Guideline 36 compliance. This phase establishes the hardware foundation for sequence programming.</div>' +
    ph1HTML +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin-bottom:6px;border-bottom:2px solid var(--rpt-rule);padding-bottom:3px">Phase 2 — BAS Sequence Programming</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Programming and commissioning of ASHRAE Guideline 36 control sequences in the building automation system. Sequences are tested and verified with occupied building conditions.</div>' +
    ph2HTML +
    '</div>';

  return rptPage(n, 'ASHRAE 36 Proposal — Scope of Work', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Scope of Work',
  });
}

// ─── rptPageASHRAE36ProposalOutcomes ──────────────────────────────────────
/**
 * Benefits, timeline, and next step for the proposal.
 */
function rptPageASHRAE36ProposalOutcomes(n, d) {
  var p = d.portfolio;
  // Rule 2.3: reportDate drives the footer date; label is empty (no period range for ASHRAE reports).
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  var outcomes =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">' +
    _proposalOutcomeCard(
      'Energy Cost Reduction',
      'ASHRAE 36 sequences reduce HVAC energy use compared to conventional control strategies, primarily through fan speed optimization, temperature reset, and economizer improvements.',
      'var(--rpt-green)',
    ) +
    _proposalOutcomeCard(
      'Improved Occupant Comfort',
      'Reset sequences and demand control ventilation deliver the right conditions when spaces are occupied and reduce over-conditioning during unoccupied periods.',
      'var(--rpt-blue)',
    ) +
    _proposalOutcomeCard(
      'Longer Equipment Life',
      'Lead/lag rotation and demand-based staging reduce runtime on individual pieces of equipment, extending service life and reducing maintenance frequency.',
      '#7c3aed',
    ) +
    _proposalOutcomeCard(
      'Code Compliance',
      'ASHRAE Guideline 36 sequences support compliance with ASHRAE 90.1 and 62.1 requirements for energy efficiency and ventilation — increasingly required by local authorities.',
      'var(--rpt-orange)',
    ) +
    '</div>';

  var timeline =
    '<div class="rpt-a36-callout" style="margin-bottom:14px;border-top:1px solid var(--rpt-rule)">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em">Typical Implementation Timeline</div>' +
    '<div style="display:flex;gap:0">' +
    _timelineStep(
      'Weeks 1–4',
      'Hardware Installation',
      'Sensor and actuator installation with minimal operational impact',
    ) +
    _timelineStep('Weeks 5–8', 'Programming', 'BAS sequence programming and initial testing') +
    _timelineStep(
      'Weeks 9–10',
      'Commissioning',
      'Functional testing and savings verification with occupied conditions',
    ) +
    '</div>' +
    '</div>';

  var bodyHTML = outcomes + timeline;
  return rptPage(n, 'ASHRAE 36 Proposal — Expected Outcomes', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Expected Outcomes',
  });
}

function _proposalOutcomeCard(title, body, color) {
  // 2026-07 design-language pass (Batch 3 item 3c): uniform var(--rpt-rule) border on all
  // four sides (was a colored 3px top accent) + black bold title (was colored to match the
  // accent). `color` is still accepted/passed by call sites but intentionally unused here —
  // matches the same "keep the data, drop the color" pattern used by _a36StatusChip.
  return (
    '<div style="border:1px solid var(--rpt-rule);border-radius:4px;padding:10px 12px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-page-text);margin-bottom:4px">' +
    title +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
    body +
    '</div>' +
    '</div>'
  );
}

function _timelineStep(period, title, desc) {
  return (
    '<div style="flex:1;text-align:center;padding:6px 4px">' +
    '<div style="font-size:9px;color:var(--rpt-blue);font-weight:700;margin-bottom:2px">' +
    period +
    '</div>' +
    '<div style="font-size:10px;font-weight:700;color:var(--rpt-page-text);margin-bottom:2px">' +
    title +
    '</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);line-height:1.4">' +
    desc +
    '</div>' +
    '</div>'
  );
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
function rptPageASHRAE36ProposalPricing(n, d, opts) {
  var fakeData = { project: { client: d.project.name }, period: { label: '', reportDate: d.rawDate } };

  // Selectable pricing-detail sub-options (independent flags, only reach this function because the
  // parent costEstimate section is on — buildingInfra precedent). All default-off here; the caller
  // decides. Each renders additional client-safe detail from the SAME summary chain below.
  var o = opts || {};
  var wantPhaseSplit = o.phaseSplit === true;
  var wantPerBuilding = o.perBuilding === true;
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

  // Column order Recommended | Compliance | Full Scope is a readability choice, NOT an assertion
  // that the dollar totals ascend/descend in that order. DRAFT tier descriptions (pending Matt's
  // review) — worded to be accurate regardless of whether a recurring budget is configured.
  var tierCols = [
    {
      key: 'recommended',
      label: 'Recommended',
      desc: 'Highest-impact upgrades prioritized by return on investment.',
    },
    { key: 'compliance', label: 'Compliance', desc: 'Scope required to meet ASHRAE Guideline 36.' },
    { key: 'full-scope', label: 'Full Scope', desc: 'All identified upgrades across the portfolio.' },
  ];

  var titleBlock =
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
    'text-transform:uppercase;letter-spacing:0.04em">Cost Estimate</div>';

  var intro =
    '<div style="font-size:10px;color:#000;line-height:1.6;margin-bottom:16px">' +
    'The options below present three scopes of work for this portfolio. Each figure is an ' +
    'independent estimate of the total investment for that scope, provided to support planning and ' +
    'budgeting. The scopes are defined differently and are not simple subsets of one another, so the ' +
    'totals should be compared on their own terms rather than assumed to rank in any particular order.' +
    '</div>';

  // Table: 3 fixed columns, total width 684px (3 x 228). table-layout:fixed, black text, no colored
  // fill boxes. Blue column headers match every other table in the report (canonical table standard).
  var colgroup = '<colgroup><col style="width:228px"><col style="width:228px"><col style="width:228px"></colgroup>';

  var thStyle =
    'padding:8px 10px;font-size:11px;font-weight:700;color:#fff;background:var(--rpt-blue);' +
    'text-align:center;border:1px solid var(--rpt-blue)';
  var headRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        return '<th style="' + thStyle + '">' + _esc(c.label) + '</th>';
      })
      .join('') +
    '</tr>';

  var descStyle =
    'padding:8px 10px;font-size:10px;color:#000;line-height:1.5;text-align:center;' +
    'border:1px solid var(--rpt-rule);vertical-align:top';
  var descRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        return '<td style="' + descStyle + '">' + _esc(c.desc) + '</td>';
      })
      .join('') +
    '</tr>';

  var lblStyle =
    'padding:10px 10px 2px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;' +
    'color:#000;text-align:center;border:1px solid var(--rpt-rule);border-bottom:none';
  var lblRow =
    '<tr>' +
    tierCols
      .map(function () {
        return '<td style="' + lblStyle + '">Total Investment</td>';
      })
      .join('') +
    '</tr>';

  var amtStyle =
    'padding:2px 10px 12px;font-size:18px;font-weight:700;color:#000;text-align:center;' +
    'border:1px solid var(--rpt-rule);border-top:none';
  var amtRow =
    '<tr>' +
    tierCols
      .map(function (c) {
        var g = tt && tt[c.key] ? _fmtUSD(tt[c.key].grand) : null;
        // noCatalog guard mirrors the interactive Cost Estimate tab's own footer
        // (app/pricing-estimator.js:6314-6317 / 6291-6293): when no pricing catalog is imported,
        // .grand is labor-only (Phase 2 only, hardware unpriced) — prefix "Labor: " so the total
        // is never shown as an unqualified full-scope dollar figure.
        var noCat = tt && tt[c.key] && tt[c.key].noCatalog;
        var display = g ? (noCat ? 'Labor: ' + g : g) : 'Available upon request';
        return '<td style="' + amtStyle + '">' + display + '</td>';
      })
      .join('') +
    '</tr>';

  // Phase split (sub-option costEstimatePhaseSplit) — folds Phase 1 (hardware/install) vs Phase 2
  // (programming/commissioning) dollar SUBTOTALS into the SAME tier table, 0 added pages. Values
  // come straight from tt[tier].phase1 / .phase2 (already computed, no new math). Dollar subtotals
  // only — no hourly rate, no markup mechanics.
  var phaseSplitRow = '';
  if (wantPhaseSplit) {
    var phaseCellStyle =
      'padding:6px 10px 12px;font-size:9px;color:#000;text-align:center;line-height:1.7;' +
      'border:1px solid var(--rpt-rule);border-top:none;vertical-align:top';
    phaseSplitRow =
      '<tr>' +
      tierCols
        .map(function (c) {
          // noCatalog guard mirrors the interactive Cost Estimate tab's own footer
          // (app/pricing-estimator.js:6301-6306 / 6263-6267): phase1 is unpriced (not legitimately
          // $0) whenever no pricing catalog is imported, so _fmtUSD(0) must never print here.
          var noCat = tt && tt[c.key] && tt[c.key].noCatalog;
          var p1 = noCat
            ? '<span style="color:#666;font-weight:400">CSV needed</span>'
            : tt && tt[c.key]
              ? _fmtUSD(tt[c.key].phase1) || '—'
              : '—';
          var p2 = tt && tt[c.key] ? _fmtUSD(tt[c.key].phase2) : null;
          return (
            '<td style="' +
            phaseCellStyle +
            '">' +
            '<div><span style="font-weight:700">Hardware &amp; Installation:</span> ' +
            p1 +
            '</div>' +
            '<div><span style="font-weight:700">Programming &amp; Commissioning:</span> ' +
            (p2 || '—') +
            '</div>' +
            '</td>'
          );
        })
        .join('') +
      '</tr>';
  }

  var table =
    '<table style="width:684px;max-width:684px;border-collapse:collapse;table-layout:fixed;margin-bottom:16px">' +
    colgroup +
    '<thead>' +
    headRow +
    '</thead><tbody>' +
    descRow +
    lblRow +
    amtRow +
    phaseSplitRow +
    '</tbody></table>';

  // M&V / savings disclaimer — attached wherever estimates appear (verbatim SAVINGS_DISCLAIMER_TEXT).
  var disc =
    typeof SAVINGS_DISCLAIMER_TEXT !== 'undefined'
      ? SAVINGS_DISCLAIMER_TEXT
      : 'Estimates are not guarantees of performance. Post-installation measurement and verification (M&V) is required to confirm realized savings.';
  var discBlock =
    '<div style="font-size:9px;color:#000;line-height:1.5;margin-top:8px;padding-top:8px;' +
    'border-top:1px solid var(--rpt-rule)">' +
    '<span style="font-weight:700">Estimate &amp; Savings Disclaimer: </span>' +
    _esc(disc) +
    '</div>';

  var bodyHTML = titleBlock + intro + table + discBlock;

  var resultPages = [
    rptPage(n, 'ASHRAE 36 Service Proposal — Cost Estimate', bodyHTML, {
      data: fakeData,
      label: 'Page ' + n + ' — Cost Estimate',
    }),
  ];
  var nextPageNum = n + 1;

  // ── Option 3: Per-building pricing breakdown (costEstimatePerBuilding) ─────────────────────────
  // One row per building across the whole portfolio; each tier's building-level `total` already
  // respects rowToggles (computed inside _pricingComputeSummaryData's sumRows). Bounded page count
  // via _rptPaginateTokens (same pattern as rptPageASHRAE36PointInventory) — one row per building,
  // not per line item, so this stays 1-2 pages even for JOCO-scale (27+ building) portfolios.
  // SAFETY: prints only building name + the three tier dollar totals — no cost build-up.
  function _buildPerBuildingPages(startN) {
    var bld = (summaryData && summaryData.buildings) || [];
    if (!bld.length) return [];

    var pbColgroup =
      '<colgroup><col style="width:228px"><col style="width:152px"><col style="width:152px"><col style="width:152px"></colgroup>';
    var pbThStyle =
      'padding:6px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;' +
      'color:#fff;background:var(--rpt-blue);text-align:left';
    var pbThRight = pbThStyle.replace('text-align:left', 'text-align:right');
    var pbTableHead =
      '<table style="width:684px;max-width:684px;border-collapse:collapse;font-size:9px;table-layout:fixed;margin-bottom:12px">' +
      pbColgroup +
      '<thead><tr>' +
      '<th style="' +
      pbThStyle +
      '">Building</th>' +
      '<th style="' +
      pbThRight +
      '">Recommended</th>' +
      '<th style="' +
      pbThRight +
      '">Compliance</th>' +
      '<th style="' +
      pbThRight +
      '">Full Scope</th>' +
      '</tr></thead>';

    function _rowHTML(b) {
      var rec = b.tiers.recommended ? _fmtUSD(b.tiers.recommended.total) : null;
      var comp = b.tiers.compliance ? _fmtUSD(b.tiers.compliance.total) : null;
      var full = b.tiers['full-scope'] ? _fmtUSD(b.tiers['full-scope'].total) : null;
      var td = 'padding:5px 8px;font-size:9px;color:#000;border-bottom:1px solid var(--rpt-rule)';
      var tdR = td + ';text-align:right';
      return (
        '<tr>' +
        '<td style="' +
        td +
        '">' +
        _esc(b.building) +
        '</td>' +
        '<td style="' +
        tdR +
        '">' +
        (rec || '—') +
        '</td>' +
        '<td style="' +
        tdR +
        '">' +
        (comp || '—') +
        '</td>' +
        '<td style="' +
        tdR +
        '">' +
        (full || '—') +
        '</td>' +
        '</tr>'
      );
    }

    // estH 27: real headless-render measurement of this row shape (padding:5px 8px, font-size:9px,
    // single line) came back ~24.5px average (JOCO's 28-building portfolio) — 22 underestimated it
    // and produced an 86px page-9-style overflow risk on the itemized table below before this fix;
    // 27 keeps a safety margin for longer building names that may wrap.
    var tokens = bld.map(function (b) {
      return { type: 'row', estH: 27, html: _rowHTML(b) };
    });

    var chunks = _rptPaginateTokens(tokens, 700, 803);
    var numChunks = chunks.length;
    var pages = [];

    chunks.forEach(function (chunk, idx) {
      var rowsHTML = chunk
        .map(function (t) {
          return t.html;
        })
        .join('');
      var pbTable = pbTableHead + '<tbody>' + rowsHTML + '</tbody></table>';
      var pbTitle =
        '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
        'text-transform:uppercase;letter-spacing:0.04em">Cost Estimate — Per-Building Breakdown' +
        (idx > 0 ? ' (continued ' + (idx + 1) + ' of ' + numChunks + ')' : '') +
        '</div>';
      var body = pbTitle + pbTable + (idx === numChunks - 1 ? discBlock : '');
      var pageN = startN + idx;
      pages.push(
        rptPage(pageN, 'ASHRAE 36 Service Proposal — Cost Estimate', body, {
          data: fakeData,
          label: 'Page ' + pageN + ' — Cost Estimate (Per-Building)',
        }),
      );
    });

    return pages;
  }

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

      // Aggregate by item name: sum qty + lineTotal across every building/instance of that item.
      var byItem = {};
      var order = [];
      included.forEach(function (r) {
        var key = r.item || '(unnamed)';
        if (!byItem[key]) {
          byItem[key] = { item: r.item, qty: 0, lineTotal: 0, clientSummary: r.clientSummary || null };
          order.push(key);
        }
        byItem[key].qty += r.qty || 0;
        byItem[key].lineTotal += r.lineTotal || 0;
      });
      var agg = order.map(function (k) {
        return byItem[k];
      });

      var itColgroup =
        '<colgroup><col style="width:474px"><col style="width:100px"><col style="width:110px"></colgroup>';
      var itThStyle =
        'padding:6px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;' +
        'color:#fff;background:var(--rpt-blue);text-align:left';
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
        '<th style="' +
        itThRight +
        '">Price</th>' +
        '</tr></thead>';

      function _itemRowHTML(row) {
        var td = 'padding:5px 8px;font-size:9px;color:#000;border-bottom:1px solid var(--rpt-rule);vertical-align:top';
        var tdR = td + ';text-align:right';
        var nameHTML =
          '<div>' +
          _esc(row.item || '') +
          '</div>' +
          (row.clientSummary
            ? '<div style="font-size:8px;color:#333;margin-top:2px;line-height:1.4">' +
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
          '<td style="' +
          tdR +
          '">' +
          (_fmtUSD(row.lineTotal) || '—') +
          '</td>' +
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
      var tokens = agg.map(function (row) {
        return { type: 'row', estH: row.clientSummary ? 60 : 30, html: _itemRowHTML(row) };
      });

      var chunks = _rptPaginateTokens(tokens, 780, 780);
      var numChunks = chunks.length;

      chunks.forEach(function (chunk, idx) {
        var rowsHTML = chunk
          .map(function (t) {
            return t.html;
          })
          .join('');
        var itTable = itTableHead + '<tbody>' + rowsHTML + '</tbody></table>';
        var itTitle =
          '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;' +
          'text-transform:uppercase;letter-spacing:0.04em">Cost Estimate — Itemized Measures — ' +
          _esc(c.label) +
          (idx > 0 ? ' (continued ' + (idx + 1) + ' of ' + numChunks + ')' : '') +
          '</div>';
        var body = itTitle + itTable + (idx === numChunks - 1 && c === tierCols[tierCols.length - 1] ? discBlock : '');
        pages.push(
          rptPage(pageN, 'ASHRAE 36 Service Proposal — Cost Estimate', body, {
            data: fakeData,
            label: 'Page ' + pageN + ' — Itemized Measures (' + c.label + ')',
          }),
        );
        pageN++;
      });
    });

    return pages;
  }

  if (wantPerBuilding) {
    var perBuildingPages = _buildPerBuildingPages(nextPageNum);
    perBuildingPages.forEach(function (pg) {
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

  var summaryBlock =
    '<div style="display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap">' +
    // Card 1: Total points inventoried
    '<div style="flex:1;min-width:120px;background:var(--rpt-rule);border-radius:6px;padding:14px 16px;text-align:center">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-page-text)">' +
    inv.totalAll.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:4px">Total BAS Points Inventoried</div>' +
    '</div>' +
    // Card 2: ASHRAE-mapped points
    '<div style="flex:1;min-width:120px;background:var(--rpt-rule);border-radius:6px;padding:14px 16px;text-align:center">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue)">' +
    inv.totalASHRAE.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:4px">ASHRAE 36 Mapped Points</div>' +
    '</div>' +
    // Card 3: Other BAS points
    '<div style="flex:1;min-width:120px;background:var(--rpt-rule);border-radius:6px;padding:14px 16px;text-align:center">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-page-text)">' +
    inv.totalOther.toLocaleString() +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:4px">Other BAS Points Inventoried</div>' +
    '</div>' +
    // Card 4: ASHRAE coverage of total inventory
    '<div style="flex:1;min-width:120px;background:var(--rpt-rule);border-radius:6px;padding:14px 16px;text-align:center">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue)">' +
    totalPct +
    '%' +
    '</div>' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--rpt-page-text);margin-top:4px">Points Mapped to ASHRAE 36</div>' +
    '</div>' +
    '</div>';

  // ── Narrative ─────────────────────────────────────────────────────────────
  var narrative =
    '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.6;margin-bottom:16px">' +
    'This inventory covers every BAS data object exported from the building automation system for this project. ' +
    'Of the ' +
    inv.totalAll.toLocaleString() +
    ' total points captured, ' +
    inv.totalASHRAE.toLocaleString() +
    ' map directly to ASHRAE Guideline 36 sensor and actuator categories and are evaluated in the compliance scoring above. ' +
    'The remaining ' +
    inv.totalOther.toLocaleString() +
    ' points are present in the BAS export but do not correspond to a defined ASHRAE 36 category — these may include vendor-specific status objects, ' +
    'integration relay programs, setpoint offsets, or equipment not addressed by ASHRAE 36. ' +
    'All points are accounted for; none are discarded.' +
    '</div>';

  // ── Per-building table ────────────────────────────────────────────────────
  var thBase =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left';
  var thRight = thBase + ';text-align:right';

  var tableHead =
    '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:16px;table-layout:fixed">' +
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
    '">Other BAS Points</th>' +
    '<th style="' +
    thRight +
    '">ASHRAE Coverage</th>' +
    '</tr></thead>';

  function _buildInvRowHTML(b) {
    var bTotal = b.ashrae + b.other;
    var bPct = bTotal > 0 ? Math.round((b.ashrae / bTotal) * 100) : 0;
    return (
      '<tr>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      b.name +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);text-align:right">' +
      bTotal.toLocaleString() +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-blue);font-weight:600;border-bottom:1px solid var(--rpt-rule);text-align:right">' +
      b.ashrae.toLocaleString() +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);text-align:right">' +
      b.other.toLocaleString() +
      '</td>' +
      '<td style="padding:5px 8px;font-size:10px;color:var(--rpt-blue);font-weight:600;border-bottom:1px solid var(--rpt-rule);text-align:right">' +
      bPct +
      '%' +
      '</td>' +
      '</tr>'
    );
  }

  // Totals row — pushed as the final token so it stays attached to the last building row
  // whenever possible (see pagination note below).
  var totalsRowHTML =
    '<tr style="background:var(--rpt-rule)">' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text)">Total</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);text-align:right">' +
    inv.totalAll.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-blue);text-align:right">' +
    inv.totalASHRAE.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-page-text);text-align:right">' +
    inv.totalOther.toLocaleString() +
    '</td>' +
    '<td style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--rpt-blue);text-align:right">' +
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
    'Note: "Other BAS Points" counts are informational. They represent BAS objects that have been captured and logged but ' +
    'do not correspond to any ASHRAE Guideline 36 sensor or actuator category. ' +
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
  var ROWS_BUDGET_FIRST = 630;
  var ROWS_BUDGET_CONT = 803;

  var tokens = inv.byBuilding.map(function (b) {
    return { type: 'row', estH: 30, html: _buildInvRowHTML(b) };
  });
  tokens.push({ type: 'row', estH: 30, html: totalsRowHTML });

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
        '<div style="font-size:11px;font-weight:600;color:var(--rpt-page-text);' +
        'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--rpt-rule)">' +
        'Point Inventory Completeness — continued (' +
        (chunkIndex + 1) +
        ' of ' +
        numChunks +
        ')' +
        '</div>';
      bodyHTML = contHdr + table + (chunkIndex === numChunks - 1 ? footnote : '');
    }

    resultPages.push(
      rptPage(pageN, 'ASHRAE 36 Audit Report — Point Inventory', bodyHTML, {
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
    var BUILDING_PAGE_BUDGET = 750; // px — interior page body (~895px) minus safety margin
    var _bldgFakeData = { project: { client: data.project.name }, period: { label: '', reportDate: data.rawDate } };
    var _pendingBlocks = [];

    function _flushPendingBuildingBlocks() {
      if (!_pendingBlocks.length) return;
      var _chunks = _rptPaginateTokens(_pendingBlocks, BUILDING_PAGE_BUDGET, BUILDING_PAGE_BUDGET);
      _chunks.forEach(function (chunk) {
        var bodyHTML = chunk
          .map(function (t) {
            return t.html;
          })
          .join('');
        var pg = rptPage(pageNum, 'ASHRAE 36 Audit Report — Per-Building Detail', bodyHTML, {
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

  if (s.proposalCover !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalCover(pageNum++, data), 'proposalCover'));
  if (s.proposalScope !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalScope(pageNum++, data), 'proposalScope'));

  // ebfca114: opt-in priced Cost Estimate page (default OFF — strict === true opt-in, so an
  // undefined/false section flag never renders it). Positioned between Scope of Work ("what needs
  // to happen") and Expected Outcomes ("why it matters"). Returns an Array — spread each page and
  // advance pageNum so downstream numbering stays correct.
  if (s.costEstimate === true) {
    // Selectable pricing-detail sub-options — each only takes effect because costEstimate is on
    // here (independent-flag / parent-gates precedent, buildingInfra). Passed as a 3rd opts arg.
    var pricingOpts = {
      phaseSplit: s.costEstimatePhaseSplit === true,
      perBuilding: s.costEstimatePerBuilding === true,
      itemized: s.costEstimateItemized === true,
    };
    var pricingPages = rptPageASHRAE36ProposalPricing(pageNum, data, pricingOpts);
    pricingPages.forEach(function (pg) {
      pages.push(_tagA36Section(pg, 'costEstimate'));
      pageNum++;
    });
  }

  if (s.proposalOutcomes !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalOutcomes(pageNum++, data), 'proposalOutcomes'));

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
