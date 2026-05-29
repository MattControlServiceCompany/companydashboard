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
function collectReportData(projId, buildingIds, reportDateStr, reportType) {
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
  const footerImgHtml = '<div class="rpt-footer"><img src="' + CSC_FOOTER_B64 + '" alt="CSC Footer"></div>';
  const footerTextHtml =
    '<div class="rpt-footer-text">' +
    '<span>' +
    (data ? data.project.client + (_fmtRptDate ? ' — ' + _fmtRptDate : ' — ' + data.period.label) : '') +
    '</span>' +
    '</div>';
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

  if (isHero) {
    return (
      '<div class="rpt-pl">' +
      pageLabel +
      '</div>' +
      '<div class="rpt-page" data-page="' +
      pageNum +
      '">' +
      '<img src="' +
      CSC_HEADER_B64 +
      '" alt="CSC Letterhead" style="width:100%;display:block">' +
      bodyHTML +
      footerTextHtml +
      '<div class="rpt-pg-footer-pagenum" style="position:absolute;bottom:12px;right:20px;font-size:10px;color:var(--rpt-page-text)"></div>' +
      footerLabelHtml +
      footerImgHtml +
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
    '<br>' +
    (data ? data.period.label : '') +
    '</div>' +
    '</div>' +
    '<div class="rpt-body">' +
    bodyHTML +
    '</div>' +
    footerTextHtml +
    '<div class="rpt-pg-footer-pagenum" style="position:absolute;bottom:12px;right:20px;font-size:10px;color:var(--rpt-page-text)"></div>' +
    footerLabelHtml +
    footerImgHtml +
    '</div>'
  );
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

  // Helper: inject data-section="key" into the first .rpt-page div in an HTML string
  function _tagSection(html, key) {
    return html.replace('<div class="rpt-page"', '<div class="rpt-page" data-section="' + key + '"');
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
  if (s.observations !== false) pages.push(_tagSection(rptPageObservations(pageNum++, data), 'observations'));
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
    return b.commodities && b.commodities.includes('Gas') && b.gas && b.gas.thermsBl > 0;
  });
  var _hasPropBldgs = data.buildings.some(function (b) {
    return b.commodities && b.commodities.includes('Propane') && b.propane && b.propane.galBl > 0;
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

  return pages.join('\n');
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
    gaugeSVG(pctOfTarget, '#27ae60', 'vs Target', pctOfTarget + '%') +
    gaugeSVG(energyRedPct, '#2e86c1', 'Energy Reduced', energyRedPct + '%') +
    gaugeSVG(Math.max(0, euiImpPct), '#1e8449', 'Site EUI Improved', euiImpPct + '%') +
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
    '<table class="rpt-table" contenteditable="false" style="font-size:10px;width:100%;table-layout:fixed">' +
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
    '<table class="rpt-table" contenteditable="false" style="font-size:10px;width:100%;table-layout:fixed">' +
    '<thead><tr style="text-align:center;white-space:normal;word-wrap:break-word;line-height:1.2">' +
    '<th style="width:8%">Quarter</th>' +
    '<th class="rpt-n" style="width:10%">Baseline<br>kWh</th>' +
    '<th class="rpt-n" style="width:10%">Actual<br>kWh</th>' +
    '<th class="rpt-n" style="width:10%">Baseline<br>Therms</th>' +
    '<th class="rpt-n" style="width:10%">Actual<br>Therms</th>' +
    '<th class="rpt-n" style="width:10%">Baseline<br>Gal</th>' +
    '<th class="rpt-n" style="width:10%">Actual<br>Gal</th>' +
    '<th class="rpt-n" style="width:10%">Baseline<br>Cost</th>' +
    '<th class="rpt-n" style="width:10%">Actual<br>Cost</th>' +
    '<th class="rpt-n" style="width:12%">' +
    qLabel +
    '<br>Actual Savings</th>' +
    '</tr></thead>' +
    '<tbody>' +
    qtrRow +
    '</tbody>' +
    '</table>';

  // -- Cumulative vs Projection SVG chart (quarterly) --
  const svgW = 700,
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
          '%;height:7px;background:#f39c12;border-radius:2px;min-width:1px"></div>' +
          '%;height:7px;background:var(--rpt-chart-orange);border-radius:2px;min-width:1px"></div>' +
          '<span style="font-size:8px;color:var(--rpt-page-text)">' +
          $c(moProj[ym]) +
          '</span>' +
          '</div>' +
          '<div style="display:flex;gap:2px;align-items:center;margin-top:1px">' +
          '<div style="width:' +
          actPct +
          '%;height:7px;background:#27ae60;border-radius:2px;min-width:1px"></div>' +
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
      '<span><span style="display:inline-block;width:10px;height:7px;background:#f39c12;border-radius:2px;vertical-align:middle"></span> Projected Baseline</span>' +
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

  const savPct = d.totals.blCost > 0 ? ((d.totals.blCost - d.totals.curCost) / d.totals.blCost) * 100 : 0;
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
        if (!_yoyByYear[yr]) _yoyByYear[yr] = { kwh: 0, kw: 0, therms: 0, gal: 0, cost: 0, kbtu: 0 };
        if (com === 'electric') {
          _yoyByYear[yr].kwh += mo.cur || 0;
          _yoyByYear[yr].kw += mo.kwCur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
          _yoyByYear[yr].kbtu += toKBtu(mo.cur || 0, 0, 0);
        } else if (com === 'gas') {
          _yoyByYear[yr].therms += mo.cur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
          _yoyByYear[yr].kbtu += toKBtu(0, mo.cur || 0, 0);
        } else {
          _yoyByYear[yr].gal += mo.cur || 0;
          _yoyByYear[yr].cost += mo.curCost || 0;
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
    var vsBl = d.totals.blCost > 0 ? ((d.totals.blCost - y.cost) / d.totals.blCost) * 100 : 0;
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
      const bSavPct = b.blCost > 0 ? ((b.blCost - b.curCost) / b.blCost) * 100 : 0;
      const blEUI = b.eui.baseline > 0 ? b.eui.baseline.toFixed(1) : '—';
      const curEUI = b.eui.current > 0 ? b.eui.current.toFixed(1) : '—';
      const euiChange =
        b.eui.baseline > 0 && b.eui.current > 0 ? ((b.eui.baseline - b.eui.current) / b.eui.baseline) * 100 : 0;
      var rowBg = bIdx % 2 === 1 ? 'background:var(--rpt-table-stripe);' : '';
      return (
        '<tr style="' +
        rowBg +
        '">' +
        '<td style="font-weight:600;vertical-align:middle;font-size:9px;' +
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
        '<td style="font-weight:600;vertical-align:middle;font-size:9px;' +
        rowBg +
        '" contenteditable="true">' +
        (b.name || '\u2014') +
        '</td>' +
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
              ? '<span style="color:#c0392b">&#9650;</span>'
              : '<span style="color:#000">&#9654;</span>'
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
    '<table class="rpt-table" contenteditable="true" style="font-size:10px">' +
    '<thead><tr>' +
    '<th>#</th>' +
    '<th>Building</th>' +
    '<th>Type</th>' +
    '<th class="rpt-n">Square Feet</th>' +
    '<th class="rpt-n">Baseline Site EUI</th>' +
    '<th class="rpt-n">Current Site EUI</th>' +
    '<th class="rpt-n">CBECS</th>' +
    '<th class="rpt-n">versus CBECS %</th>' +
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
        '<div style="width:140px;text-align:right;font-size:10px;color:#000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">' +
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
        '<div style="width:35px;font-size:9px;font-weight:600;color:#000000;flex-shrink:0">' +
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
    '<span><span style="display:inline-block;width:10px;height:7px;background:#27ae60;border-radius:2px;vertical-align:middle"></span> Below CBECS</span>' +
    '<span><span style="display:inline-block;width:10px;height:7px;background:#f39c12;border-radius:2px;vertical-align:middle"></span> Above CBECS</span>' +
    '<span><span style="display:inline-block;width:2px;height:10px;background:#c0392b;vertical-align:middle"></span> CBECS Median</span>' +
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
              ? '<span style="color:#c0392b">&#9650;</span>'
              : '<span style="color:#000">&#9654;</span>'
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
    polLine(pol.co2, 'pounds', 'CO2 (carbon dioxide)') +
    polLine(pol.ch4, 'pounds', 'CH4 (methane)') +
    polLine(pol.n2o, 'pounds', 'N2O (nitrous oxide)') +
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
    '<div style="font-size:16px;font-weight:700;color:#1a5276;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px;text-align:center">Environmental Impact — Pollution Reduction Credits</div>' +
    '<div style="font-size:12px;color:#000;margin-bottom:10px;text-align:center">Emission reductions resulting from energy savings achieved during the reporting period' +
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
    '<div style="margin-top:24px;font-size:10px;color:#000;padding-top:6px;text-align:center">' +
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

  // -- Per-building narrative --
  const bldgSections = (d.buildings || [])
    .map(function (b) {
      const statusColor =
        b.status === 'on_track'
          ? 'var(--rpt-green)'
          : b.status === 'near_target'
            ? 'var(--rpt-orange)'
            : 'var(--rpt-red)';
      const arrow = b.status === 'below_target' ? '?' : '?';
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
    })
    .join('');

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

  const bodyHTML =
    '<div class="rpt-body ob">' +
    '<h2 contenteditable="true">Building Performance</h2>' +
    '<div style="font-size:14px;line-height:1.6;margin-bottom:8px" contenteditable="true">' +
    summaryPara +
    '</div>' +
    bldgSections +
    '<h2 contenteditable="true">Weather</h2>' +
    weatherPara +
    '<h2 contenteditable="true">Next Quarter</h2>' +
    nextQPara +
    '</div>';

  return rptPage(n, 'Observations & Recommendations', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — Observations',
  });
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
    (ahead ? '?' : '?') +
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
  const svgW = 716,
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
  var _barGap = 2;
  var _barW = Math.max(3, cW / totalQtrs - _barGap);
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
    '<div class="rpt-body">' +
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
    '% annual utility rate escalation applied per contract terms.</p>' +
    '</div>';

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
    '<div class="rpt-body">' +
    '<p style="font-size:12px;color:var(--rpt-page-text);margin:0 0 8px">Baseline setpoints and operating schedules per building — from uploaded BAS exports (' +
    rptViewMode +
    ')</p>' +
    bodyContent +
    '<p style="font-size:11px;color:var(--rpt-page-text);margin-top:12px">Source: BAS export uploaded to Set Points &amp; Schedules tab.</p>' +
    '</div>';

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

    return (
      titleHtml +
      '<div style="display:flex;flex-wrap:nowrap;gap:2px;align-items:flex-end;padding:4px 0;overflow:hidden">' +
      bars +
      '</div>' +
      legend
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
      var euiChartH = 140;
      var euiMidLabel = (euiMax / 2).toFixed(1);
      var euiBars = euiMonthly
        .map(function (mo) {
          var blH = Math.max(1, Math.round((mo.bl / euiMax) * euiChartH));
          var curH = Math.max(1, Math.round((mo.cur / euiMax) * euiChartH));
          var moLbl = moLabel(mo.month);
          // Value labels: rendered below month label
          var blLabel = mo.bl > 0 ? '<span style="color:#e67e22">' + mo.bl.toFixed(1) + '</span>' : '';
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
            '<div style="display:flex;align-items:flex-end;gap:1px;height:' +
            euiChartH +
            'px">' +
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:' +
            euiChartH +
            'px">' +
            '<div style="width:15px;height:' +
            blH +
            'px;background:var(--rpt-orange);border-radius:1px 1px 0 0"></div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:' +
            euiChartH +
            'px">' +
            '<div style="width:15px;height:' +
            curH +
            'px;background:var(--rpt-green-dark);border-radius:1px 1px 0 0"></div>' +
            '</div>' +
            '</div>' +
            '<div style="font-size:9px;color:var(--rpt-page-text);text-align:center">' +
            moLbl +
            '</div>' +
            valLine +
            '</div>'
          );
        })
        .join('');
      var euiYMax = euiMax.toFixed(1);
      leftHTML +=
        '<div style="font-size:10px;font-weight:600;color:var(--rpt-page-text);margin:8px 0 3px">Monthly Site EUI (kBtu/ft²)</div>' +
        '<div style="position:relative;padding-left:36px">' +
        '<div style="position:absolute;left:0;top:0;bottom:16px;display:flex;flex-direction:column;justify-content:space-between;font-size:9px;color:var(--rpt-page-text);text-align:right;width:30px">' +
        '<span>' +
        euiYMax +
        '</span>' +
        '<span>' +
        euiMidLabel +
        '</span>' +
        '<span>0</span>' +
        '</div>' +
        '<div style="position:relative">' +
        '<div style="position:absolute;left:0;right:0;bottom:50%;border-top:1px dashed var(--rpt-divider);pointer-events:none"></div>' +
        '<div style="display:flex;align-items:flex-end;gap:1px">' +
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
      '<div style="font-size:11px;font-weight:600;color:#000;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:3px">Utility &amp; Building Notes</div>' +
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
    '<div style="font-size:14px;font-weight:700;color:#1a5276">Goals and Progression</div>' +
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

  // Electricity Consumption chart — reporting period only
  if (hasElec) {
    var elFullYear = buildFullYear(b.electric.monthly, _bm.elecByMo, 'kwh');
    var elDataMonths = filterToDataMonths(elFullYear);
    var elChart = buildBarChart(elDataMonths, 'var(--rpt-elec-bl)', 'var(--rpt-elec-cur)', 'kWh');
    rightHTML +=
      '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--rpt-blue);margin:6px 0 2px">' +
      'Electricity Consumption' +
      '</div>' +
      '<div style="display:flex;justify-content:center">' +
      elChart +
      '</div>';
  }

  // Natural Gas Consumption chart — reporting period only
  if (hasGas) {
    var gasFullYear = buildFullYear(b.gas.monthly, _bm.gasByMo, 'therms');
    var gasDataMonths = filterToDataMonths(gasFullYear);
    var gasChart = buildBarChart(gasDataMonths, 'var(--rpt-gas-bl)', 'var(--rpt-gas-cur)', 'Therms');
    rightHTML +=
      '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--rpt-gas-head);margin:6px 0 2px">' +
      'Natural Gas Consumption' +
      '</div>' +
      '<div style="display:flex;justify-content:center">' +
      gasChart +
      '</div>';
  }

  // Propane Consumption chart — reporting period only
  if (hasPropane) {
    var propFullYear = buildFullYear(b.propane.monthly, _bm.propaneByMo, 'gallons');
    var propDataMonths = filterToDataMonths(propFullYear);
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
    var hasData = kwh || therms || gal || water || totalCost;
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
    ? '<div style="margin-top:14px;width:100%;overflow-x:auto;border:1px solid var(--rpt-page-text)">' +
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
    '<div style="margin-top:10px;font-size:10px;color:#000;line-height:1.5">' +
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
    '</div>' +
    blDataTable;

  var result = rptPage(n, (b.name || 'Building') + ' — Building Summary', bodyHTML, {
    data: d,
    label: 'Page ' + n + ' — ' + (b.name || 'Building'),
  });

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
    '<table class="rpt-table" contenteditable="true" style="font-size:10px">' +
    '<thead><tr>' +
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
    '<p contenteditable="true" style="font-size:12px;color:#000;line-height:1.6;margin:0 0 8px">This page details electricity consumption across all buildings for the reporting period. The charts compare weather-normalized baseline usage against actual consumption by month. The table below breaks down kilowatt-hour (kWh) usage, peak demand (kW), and costs by building to identify where the greatest savings and opportunities exist.</p>' +
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
    '<p contenteditable="true" style="font-size:12px;color:#000;line-height:1.6;margin:0 0 8px">This page details natural gas consumption across all buildings for the reporting period. Gas usage is measured in therms and is primarily driven by heating loads. The chart compares baseline consumption against actual usage by month, while the per-building table identifies where gas savings or overages are occurring.</p>' +
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
    return b.commodities && b.commodities.includes('Propane') && b.propane && b.propane.galBl > 0;
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
    return b.commodities && b.commodities.includes('Propane') && b.propane && b.propane.galBl > 0;
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
    '<p contenteditable="true" style="font-size:11px;color:#000;line-height:1.5;margin:0 0 6px">This page details natural gas and propane consumption across all buildings for the reporting period.</p>' +
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
    '<div contenteditable="true" style="padding:10px 12px;font-size:11px;line-height:1.7;color:#000000;margin-bottom:12px">' +
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
    '<h2 style="font-size:13px;font-weight:700;color:var(--rpt-page-text);margin:0 0 8px">Appendix ' +
    appLetter +
    ': Normalization &amp; Meter Baseline</h2>' +
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
    '<div contenteditable="true" style="padding:10px 14px;font-size:11px;line-height:1.7;color:#000000;margin-bottom:12px">' +
    '<strong style="font-size:12px;color:#1a5276">Regression Model Overview</strong><br>' +
    'Weather-normalized savings use an OLS regression model: <span style="font-family:monospace;background:#fff;border:1px solid #ddd;padding:1px 4px;border-radius:2px">Usage = β₀ × Days + β₁ × HDD + β₂ × CDD</span><br>' +
    '<div contenteditable="true" style="padding:10px 14px;font-size:11px;line-height:1.7;color:var(--rpt-page-text);margin-bottom:12px">' +
    '<strong style="font-size:12px;color:var(--rpt-blue)">Regression Model Overview</strong><br>' +
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
            '<td style="font-family:monospace;font-size:9px;color:var(--rpt-page-text);white-space:nowrap">' +
            formulaParts +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
            $n(predicted) +
            '</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
            '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
            '<td class="rpt-n" style="color:#000000">—</td>' +
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
            '<td style="font-family:monospace;font-size:9px;color:var(--rpt-page-text);white-space:nowrap">' +
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
        '<table class="rpt-table" style="font-size:9px;margin-bottom:10px">' +
        '<thead><tr>' +
        '<th>Month</th><th class="rpt-n">Days</th><th class="rpt-n">HDD</th><th class="rpt-n">CDD</th>' +
        '<th>Calculation</th>' +
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
          ' <span style="font-size:8px;font-weight:700;color:#000000;background:#e8e8e8;border-radius:2px;padding:0 3px">BL</span></td>' +
          ' <span style="font-size:8px;font-weight:700;color:var(--rpt-page-text);background:var(--rpt-progress-bg);border-radius:2px;padding:0 3px">BL</span></td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          days +
          '</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          Math.round(wx.hddBl || 0).toLocaleString() +
          '</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">' +
          Math.round(wx.cddBl || 0).toLocaleString() +
          '</td>' +
          '<td style="font-size:9px;color:#000000">—</td>' +
          '<td style="font-size:9px;color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:var(--rpt-page-text)">—</td>' +
          '<td class="rpt-n" style="color:#000000">—</td>' +
          '<td class="rpt-n" style="color:#000000">—</td>' +
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
    '<h2 style="font-size:13px;font-weight:700;color:var(--rpt-page-text);margin:0 0 4px">Appendix ' +
    appLetter +
    ': Regression Model Methodology</h2>' +
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
    '<h2 style="font-size:13px;font-weight:700;color:var(--rpt-page-text);margin:0 0 4px">Appendix ' +
    appLetter +
    ': Weather Data</h2>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:10px">Combined HDD and CDD — Base 60°F per contract</div>' +
    weatherTable +
    '<h3 style="font-size:12px;font-weight:700;color:var(--rpt-page-text);margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.04em">Weather Impact Summary</h3>' +
    narrativeBox +
    hddCddParagraph +
    '<div style="margin-top:16px;padding:10px 12px;font-size:11px;color:#000000;line-height:1.5">' +
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
    '<h2 style="font-size:13px;font-weight:700;color:var(--rpt-page-text);margin:0 0 4px">Appendix ' +
    appLetter +
    ': Utility Bills</h2>' +
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
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId: String(data.project.id),
    projectName: data.project.client || data.project.name,
    period: data.period.label,
    type: data.period.type,
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

    const margin = { top: 10, bottom: 10, left: 10, right: 10 };
    const contentW = pageW - margin.left - margin.right;
    const contentH = pageH - margin.top - margin.bottom;

    for (let i = 0; i < pages.length; i++) {
      if (i > 0) doc.addPage();

      try {
        const canvas = await html2canvas(pages[i], {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
          width: 816,
          height: 1056,
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.92);
        doc.addImage(imgData, 'JPEG', margin.left, margin.top, contentW, contentH);
      } catch (e) {
        console.error('Failed to render page ' + (i + 1), e);
        doc.setFontSize(12);
        doc.text('Page ' + (i + 1) + ' failed to render', margin.left, margin.top + 20);
      }
    }

    // Generate filename
    const client = data.project.client || data.project.name || 'Report';
    const period = data.period.label || '';
    const typeLabel = data.period.type === 'quarterly' ? 'Quarterly' : 'Annual';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const filename = client + ' - ' + typeLabel + ' Savings Report ' + dateStr + '.pdf';

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
  var moNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var moMap = {};
  (d.buildings || []).forEach(function (b) {
    ((b.electric && b.electric.monthly) || []).forEach(function (mo) {
      var k = mo.ym || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
    ((b.gas && b.gas.monthly) || []).forEach(function (mo) {
      var k = mo.ym || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
    ((b.propane && b.propane.monthly) || []).forEach(function (mo) {
      var k = mo.ym || '';
      if (!k) return;
      moMap[k] = (moMap[k] || 0) + (mo.savings || 0);
    });
  });
  var sortedYMs = Object.keys(moMap).sort().slice(-12);
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
    '<div contenteditable="true" style="padding:4px 0">' +
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
      doc.addImage(CSC_FOOTER_B64, 'JPEG', 0, ph - 55, pw, 55);
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
      tab: window._activeProjTab || 'notes',
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
  fetch('site-ui.js')
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
      // Issue 066423b5: compare to last-seen version; if changed, save page state
      // so in-progress work survives any subsequent reload.
      const _CH_VER_KEY = 'ch_last_seen_version';
      const storedVer = localStorage.getItem(_CH_VER_KEY);
      if (storedVer && storedVer !== fetchedVer) {
        _savePageStateForVersionUpdate();
        showToast('Site updated to ' + fetchedVer + ' — your in-progress work has been preserved');
      }
      localStorage.setItem(_CH_VER_KEY, fetchedVer);
    })
    .catch(() => {});
  // Restore any state saved before a version-triggered page reload (issue 066423b5)
  _restorePageStateAfterVersionUpdate();
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
          detail: 'Advent Health baseline report is due in 2 days. Review M&V data before submitting.',
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
    impact: '3–8% heating & cooling savings',
    plain:
      'A supply air temperature sensor tells the system exactly how warm or cold the air leaving the air handler is. Without it, the system cannot reset temperature setpoints based on outside conditions — a key ASHRAE 36 energy-saving strategy.',
  },
  rat: {
    short: 'Return air temperature sensor',
    impact: '2–5% fan and cooling savings',
    plain:
      'The return air sensor measures the temperature of air coming back from the occupied spaces. Combined with supply air temperature, it lets the BAS calculate how effectively the system is conditioning the building and adjust accordingly.',
  },
  mat: {
    short: 'Mixed air temperature sensor',
    impact: '3–6% cooling savings',
    plain:
      'The mixed air sensor measures the blend of outdoor and return air before it reaches heating and cooling coils. It is essential for economizer control — the ability to use free outdoor air for cooling — which is one of the biggest energy-saving opportunities in commercial HVAC.',
  },
  oat: {
    short: 'Outdoor air temperature sensor',
    impact: '4–10% combined savings',
    plain:
      'Outdoor air temperature is used by nearly every ASHRAE 36 sequence: reset schedules, economizer control, warm-up/cool-down, and heating/cooling staging. Without a reliable OAT reading, the system cannot adapt its operation to changing weather.',
  },
  dsp: {
    short: 'Duct static pressure sensor',
    impact: '15–30% fan energy savings',
    plain:
      'Duct static pressure control is required for variable-speed fan drives. When static pressure is measured and reset based on actual zone needs, fan speed drops significantly during mild weather — often cutting fan energy use by 20–30%.',
  },
  sfVfd: {
    short: 'Supply fan VFD',
    impact: '20–40% fan energy savings',
    plain:
      'A variable frequency drive (VFD) on the supply fan allows fan speed to vary with actual building load. At 80% speed, a fan uses roughly half the energy it uses at full speed. This is one of the highest-return hardware investments in building controls.',
  },
  satReset: {
    short: 'Supply air temperature reset sequence',
    impact: '5–12% heating & cooling savings',
    plain:
      'Supply air temperature reset adjusts how warm or cold the air handler delivers air based on what zones actually need. In mild weather, the system delivers less extreme temperatures, reducing the energy needed to heat or cool the air.',
  },
  dspReset: {
    short: 'Duct static pressure reset sequence',
    impact: '10–25% fan energy savings',
    plain:
      'Static pressure reset lowers the duct pressure target when most zones have their dampers wide open — meaning the system can deliver the right amount of air at lower fan speed. This sequence alone can cut fan energy use by 15% or more.',
  },
  economizer: {
    short: 'Economizer control sequence',
    impact: '5–15% cooling savings',
    plain:
      'Economizer control uses outdoor air for free cooling whenever conditions allow — typically when outdoor air is cooler and drier than return air. Without a properly programmed economizer, mechanical cooling runs when it does not need to.',
  },
  demandCtrl: {
    short: 'CO2-based demand control ventilation',
    impact: '5–10% fan and cooling savings',
    plain:
      'Demand control ventilation uses CO2 sensors to bring in only as much outdoor air as occupancy actually requires. Without it, the system must heat and cool full design outdoor air even when rooms are nearly empty.',
  },
  optStart: {
    short: 'Optimal start/stop sequence',
    impact: '3–8% overall savings',
    plain:
      'Optimal start calculates the shortest warmup or cooldown period needed to reach comfort before occupancy, then delays startup accordingly. Without it, systems often start 1–2 hours earlier than necessary, wasting energy conditioning an empty building.',
  },
  hwReset: {
    short: 'Hot water supply temperature reset',
    impact: '5–15% boiler savings',
    plain:
      'Hot water reset lowers the boiler supply temperature setpoint when outdoor air is warmer, reducing heat loss and improving boiler efficiency. Modern condensing boilers can achieve efficiency gains of 3–5% for every 10°F reduction in return water temperature.',
  },
  chwReset: {
    short: 'Chilled water supply temperature reset',
    impact: '3–10% chiller savings',
    plain:
      'Chilled water reset raises the chilled water setpoint when the building load is light, allowing the chiller to operate more efficiently. Chillers are significantly more efficient at higher leaving water temperatures.',
  },
  leadLag: {
    short: 'Lead/lag equipment rotation',
    impact: '2–5% equipment life extension',
    plain:
      'Lead/lag rotation alternates which pump or boiler serves as the primary unit, distributing runtime evenly across equipment. This extends equipment life and ensures all units are exercised regularly to prevent seizing.',
  },
  zoneCoolSp: {
    short: 'Zone cooling setpoint',
    impact: 'Baseline requirement',
    plain:
      'Zone cooling setpoints define the target temperature for cooling in each space. Properly programmed setpoints with appropriate deadbands between heating and cooling are required for ASHRAE 36 compliance and prevent simultaneous heating and cooling.',
  },
  zoneHtgSp: {
    short: 'Zone heating setpoint',
    impact: 'Baseline requirement',
    plain:
      'Zone heating setpoints define the minimum temperature for each space. ASHRAE 36 requires setbacks during unoccupied periods and prohibits simultaneous heating and cooling within the deadband range.',
  },
  discFlow: {
    short: 'Discharge airflow measurement',
    impact: 'Required for VAV minimum ventilation',
    plain:
      'Airflow measurement at terminal units is required by ASHRAE 62.1 for minimum ventilation compliance and enables the static pressure reset sequences that cut fan energy. Without measured airflow, the system cannot verify that spaces are receiving adequate ventilation.',
  },
  hwSupTemp: {
    short: 'Hot water supply temperature sensor',
    impact: 'Required for HW reset',
    plain:
      'The hot water supply temperature sensor is essential for monitoring boiler output and enabling hot water temperature reset sequences. Without it, the system cannot verify that distribution temperatures are appropriate for building load conditions.',
  },
  hwRetTemp: {
    short: 'Hot water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Return temperature monitoring allows the BAS to calculate the temperature differential across the heating system. Low delta-T is a common source of inefficiency in hot water systems and can indicate pump, balancing, or coil issues.',
  },
  hwDiffPres: {
    short: 'Hot water differential pressure sensor',
    impact: '10–20% pump energy savings',
    plain:
      'Differential pressure measurement enables pump speed control: the pump slows when fewer zones call for heat. Without it, the pump runs at full speed regardless of load, wasting significant energy during partial-load conditions.',
  },
  chwSupTemp: {
    short: 'Chilled water supply temperature sensor',
    impact: 'Required for CHW reset',
    plain:
      'The chilled water supply temperature sensor verifies chiller output and enables the temperature reset sequences that improve chiller efficiency during mild weather.',
  },
  chwRetTemp: {
    short: 'Chilled water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Return temperature monitoring reveals chilled water delta-T, a key indicator of plant efficiency. Low delta-T on a chilled water system often signals coil or valve issues that cause the chiller to work harder than necessary.',
  },
  chwDiffPres: {
    short: 'Chilled water differential pressure sensor',
    impact: '10–20% pump energy savings',
    plain:
      'Chilled water differential pressure control allows pump speed to be reduced when building load is light. This is particularly valuable because chilled water pump energy scales with the cube of speed.',
  },
  cwst: {
    short: 'Condenser water supply temperature sensor',
    impact: '3–8% chiller savings',
    plain:
      'Condenser water supply temperature monitoring is required for optimal chiller and cooling tower operation, including condenser water temperature reset to improve chiller efficiency.',
  },
  ctFanSpeed: {
    short: 'Cooling tower fan speed control',
    impact: '30–50% tower fan savings',
    plain:
      'Variable-speed cooling tower fans can reduce tower fan energy by 30–50% during mild weather. Tower fans are required to deliver specific condenser water temperatures, and variable speed allows them to achieve this at the minimum possible energy input.',
  },
  // ── AHU point keys ──────────────────────────────────────────────────────
  sfStatus: {
    short: 'Supply fan status feedback',
    impact: 'Required for proof-of-operation',
    plain:
      'The supply fan status point confirms that the fan is actually running, not just commanded on. ASHRAE 36 requires fan proof-of-operation for alarm management and to prevent sequences from running without airflow — which can damage equipment and waste energy.',
  },
  sfSpeed: {
    short: 'Supply fan speed feedback',
    impact: 'Required for VFD verification',
    plain:
      'Supply fan speed feedback confirms the actual VFD output frequency. Without it, the BAS cannot verify that speed commands are being executed or detect VFD faults that would cause the fan to run at full speed regardless of load.',
  },
  sfEnable: {
    short: 'Supply fan enable command',
    impact: 'Required for scheduled operation',
    plain:
      'The fan enable point allows the BAS to start and stop the air handler according to occupancy schedules and optimal start/stop sequences. Without a verified enable command, the system cannot automate or verify equipment start/stop.',
  },
  sfSpeedCmd: {
    short: 'Supply fan speed command',
    impact: '20–40% fan energy savings',
    plain:
      'The fan speed command point is how the BAS sends a speed setpoint to the VFD. Without it, the VFD cannot be modulated by the control system and will run at a fixed speed, eliminating the energy savings that variable-speed operation provides.',
  },
  oaDampCmd: {
    short: 'OA damper position command',
    impact: 'Required for economizer control',
    plain:
      'The outdoor air damper command controls how much outdoor air the air handler brings in for ventilation and free cooling. Without it, the economizer sequence cannot operate and the system is limited to minimum fixed ventilation rates.',
  },
  raDampCmd: {
    short: 'Return air damper position command',
    impact: 'Required for economizer control',
    plain:
      'The return air damper works in concert with the outdoor air damper: as outdoor air increases for economizer cooling, the return air damper closes to maintain proper airflow balance. Without it, economizer operation causes pressure imbalance.',
  },
  clgValve: {
    short: 'Cooling coil valve command',
    impact: 'Required for mechanical cooling control',
    plain:
      'The cooling coil valve modulates chilled water flow through the coil to meet supply air temperature setpoints. Without a controlled valve, the system cannot perform supply air temperature reset or economizer sequencing with mechanical cooling.',
  },
  htgValve: {
    short: 'Heating coil valve command',
    impact: 'Required for preheat and morning warm-up',
    plain:
      'The heating coil valve controls hot water flow through the preheat or heating coil. It is essential for morning warm-up sequences, freeze protection, and supply air temperature reset during cold weather.',
  },
  freezeStat: {
    short: 'Freeze protection status',
    impact: 'Required for freeze protection safety',
    plain:
      'The freeze stat is a low-limit safety device that shuts down the air handler if coil temperatures approach freezing. ASHRAE 36 requires the BAS to monitor and respond to freeze stat trips to protect coils from damage.',
  },
  oaFlow: {
    short: 'Outdoor airflow measurement',
    impact: 'Required for ventilation compliance',
    plain:
      'A dedicated outdoor airflow station measures the actual volume of outside air entering the unit. Without measured OA flow, the system cannot verify that minimum ventilation rates required by ASHRAE 62.1 are being met.',
  },
  oaEnthalpy: {
    short: 'Outdoor air enthalpy sensor',
    impact: 'Required for differential enthalpy economizer',
    plain:
      'An enthalpy sensor measures both temperature and humidity of outdoor air. Combined with return air enthalpy, it enables differential enthalpy economizer control — the most accurate method for determining when outdoor air provides net cooling benefit.',
  },
  rfEnable: {
    short: 'Return fan enable command',
    impact: 'Required for building pressure control',
    plain:
      'The return fan enable command starts and stops the return fan in coordination with the supply fan. Proper return fan sequencing is required to maintain building pressurization and prevent over- or under-pressurization during economizer operation.',
  },
  rfSpeedCmd: {
    short: 'Return fan speed command',
    impact: 'Required for building pressure control',
    plain:
      'Return fan speed is modulated to track supply fan airflow and maintain the correct building pressure differential. Without speed control, the return fan runs at fixed speed and cannot adapt to the wide range of airflow conditions that ASHRAE 36 sequences create.',
  },
  bldgPressure: {
    short: 'Building static pressure sensor',
    impact: 'Required for relief fan/exhaust control',
    plain:
      'Building static pressure is used to modulate relief fans or exhaust systems to prevent the building from becoming over-pressurized during economizer operation. Uncontrolled pressure can cause door-opening problems, infiltration, and comfort complaints.',
  },
  co2: {
    short: 'CO2 sensor (return or zone)',
    impact: '5–10% fan and cooling savings',
    plain:
      'CO2 concentration is a proxy for occupancy: as more people occupy a space, CO2 rises. The BAS uses this signal to bring in only as much outdoor air as current occupancy requires, reducing the energy needed to condition excess ventilation air.',
  },
  // ── VAV / Terminal point keys ────────────────────────────────────────────
  zoneTemp: {
    short: 'Zone air temperature sensor',
    impact: 'Required for zone control',
    plain:
      'Zone temperature is the fundamental feedback signal for VAV control. Without it, the terminal unit cannot modulate airflow to meet heating or cooling setpoints, and the system has no way to verify that occupied spaces are comfortable.',
  },
  coolSP: {
    short: 'Zone cooling setpoint',
    impact: 'Baseline requirement',
    plain:
      'Zone cooling setpoints define the target temperature for cooling in each space. Properly programmed setpoints with appropriate deadbands between heating and cooling are required for ASHRAE 36 compliance and prevent simultaneous heating and cooling.',
  },
  htgSP: {
    short: 'Zone heating setpoint',
    impact: 'Baseline requirement',
    plain:
      'Zone heating setpoints define the minimum temperature for each space. ASHRAE 36 requires setbacks during unoccupied periods and prohibits simultaneous heating and cooling within the deadband range.',
  },
  dat: {
    short: 'Discharge air temperature sensor',
    impact: 'Required for reheat control',
    plain:
      'Discharge air temperature at the terminal unit is used to control reheat valve position and verify that the air delivered to the space is within acceptable limits. Without it, the BAS cannot prevent overcooling or verify reheat operation.',
  },
  fanStatus: {
    short: 'AHU supply fan status (at terminal)',
    impact: 'Required for terminal unit sequencing',
    plain:
      'Terminal units need to know whether the air handling unit is operating before opening their dampers. Without this signal, the VAV box may open fully when there is no primary airflow, or fail to open when the AHU is running.',
  },
  dampCmd: {
    short: 'Damper position command',
    impact: 'Required for zone airflow control',
    plain:
      'The VAV damper command controls how much conditioned air the terminal unit delivers to the zone. It is the primary actuator for meeting zone temperature setpoints and maintaining minimum ventilation rates — fundamental to all ASHRAE 36 terminal sequences.',
  },
  reheatValve: {
    short: 'Reheat valve command',
    impact: 'Required for zone heating',
    plain:
      'The reheat valve controls the flow of hot water through the terminal reheat coil. Without it, the BAS cannot provide zone heating through the VAV box, forcing all heating to come from the primary air system and significantly reducing system efficiency.',
  },
  primaryFlow: {
    short: 'Primary (cold deck) airflow',
    impact: 'Required for fan-powered box control',
    plain:
      'Primary airflow measurement on a fan-powered box tracks how much cold primary air the terminal is receiving from the air handler. This signal drives damper modulation and determines when the terminal fan should operate.',
  },
  termFanStatus: {
    short: 'Terminal fan status',
    impact: 'Required for fan-powered box proof',
    plain:
      'The terminal fan status confirms that the fan-powered box fan is actually running. ASHRAE 36 requires this proof-of-operation to enable proper sequencing and alarming when the fan fails to start.',
  },
  termFanEnable: {
    short: 'Terminal fan enable command',
    impact: 'Required for fan-powered box control',
    plain:
      'The terminal fan enable command starts and stops the fan in the fan-powered box according to the zone control sequence. Without it, the fan may run continuously (wasting energy) or never run (causing comfort and air quality problems).',
  },
  coldDampCmd: {
    short: 'Cold deck damper command (dual-duct)',
    impact: 'Required for dual-duct cooling control',
    plain:
      'The cold deck damper controls cool air delivery in a dual-duct system. Without a BAS-controlled cold deck damper, the system cannot modulate cooling to meet zone setpoints or coordinate cooling and heating to prevent simultaneous conditioning.',
  },
  hotDampCmd: {
    short: 'Hot deck damper command (dual-duct)',
    impact: 'Required for dual-duct heating control',
    plain:
      'The hot deck damper controls warm air delivery in a dual-duct system. Without control of both hot and cold deck dampers, the BAS cannot implement the ASHRAE 36 dual-duct sequences that prevent simultaneous heating and cooling.',
  },
  // ── HW Plant point keys ──────────────────────────────────────────────────
  hwst: {
    short: 'Hot water supply temperature sensor',
    impact: 'Required for HW reset sequences',
    plain:
      'The hot water supply temperature sensor is the primary feedback for boiler plant control and is required for hot water temperature reset sequences. Without it, the system cannot verify boiler output or reduce supply temperature during mild weather to save energy.',
  },
  hwrt: {
    short: 'Hot water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Return temperature monitoring allows the BAS to calculate the temperature differential across the heating system. Low delta-T is a common source of inefficiency in hot water systems and can indicate pump, balancing, or coil issues that increase operating costs.',
  },
  hwdp: {
    short: 'Hot water differential pressure sensor',
    impact: '10–20% pump energy savings',
    plain:
      'Differential pressure measurement enables variable-speed pump control: the pump slows when fewer zones call for heat, following the heating load rather than running at full speed. This directly reduces pump energy and extends pump life.',
  },
  boilerStatus: {
    short: 'Boiler status feedback',
    impact: 'Required for boiler staging',
    plain:
      'Boiler status confirms that each boiler is firing and not in fault. The BAS uses this feedback for lead/lag rotation, staging additional boilers when demand increases, and generating alarms when a boiler fails.',
  },
  boilerEnable: {
    short: 'Boiler enable command',
    impact: 'Required for boiler sequencing',
    plain:
      'The boiler enable point allows the BAS to start and stop individual boilers as part of staging and lead/lag sequences. Without it, the BAS cannot control which boilers run, preventing energy-efficient staging strategies.',
  },
  hwSetpoint: {
    short: 'HW supply temperature setpoint',
    impact: 'Required for outdoor air reset',
    plain:
      'The hot water supply setpoint command is how the BAS tells the boiler what temperature to target. Modulating this setpoint based on outdoor air temperature — hot water reset — is one of the most effective boiler plant efficiency strategies.',
  },
  hwPumpStatus: {
    short: 'Hot water pump status feedback',
    impact: 'Required for pump sequencing',
    plain:
      'Hot water pump status confirms that the pump is running and providing flow. Without this feedback, the BAS cannot verify that heating water is circulating, cannot implement lead/lag rotation, and cannot alarm on pump failures.',
  },
  hwPumpEnable: {
    short: 'Hot water pump enable command',
    impact: 'Required for pump staging',
    plain:
      'The pump enable command allows the BAS to start individual pumps as part of lead/lag and staging sequences. Without individual pump control, the plant cannot rotate equipment or respond to reduced demand by shutting down unnecessary pumps.',
  },
  hwPumpSpeed: {
    short: 'Hot water pump speed command',
    impact: '10–25% pump energy savings',
    plain:
      'Variable-speed pump control reduces pump energy when heating loads are low by slowing pump speed to maintain only the differential pressure needed by the most open zone valve. Without speed control, the pump runs at full design speed regardless of demand.',
  },
  // ── CHW Plant point keys ─────────────────────────────────────────────────
  chwst: {
    short: 'Chilled water supply temperature sensor',
    impact: 'Required for CHW reset sequences',
    plain:
      'The chilled water supply temperature sensor verifies chiller output and is required for chilled water temperature reset sequences. Raising the chilled water setpoint during mild weather allows the chiller to operate more efficiently.',
  },
  chwrt: {
    short: 'Chilled water return temperature sensor',
    impact: 'Required for delta-T monitoring',
    plain:
      'Return temperature monitoring reveals chilled water delta-T, a key indicator of plant efficiency. Low delta-T on a chilled water system — meaning the water is not being fully utilized — is a common cause of chiller over-cycling and excess energy use.',
  },
  chwdp: {
    short: 'Chilled water differential pressure sensor',
    impact: '10–20% pump energy savings',
    plain:
      'Chilled water differential pressure control allows pump speed to be reduced when building load is light. Pump energy scales with the cube of speed, so even modest speed reductions deliver large energy savings during the many hours of partial-load operation.',
  },
  // ── HWP additional point keys ───────────────────────────────────────────
  hwFlow: {
    short: 'Hot water flow meter',
    impact: 'Required for BTU metering and delta-T monitoring',
    plain:
      'A flow meter on the hot water loop allows the BAS to calculate actual heat delivered (BTUs), monitor system efficiency, and detect low delta-T conditions that signal pumping or coil problems.',
  },
  hwIsoValve: {
    short: 'Boiler isolation valve status',
    impact: 'Required for safe boiler staging',
    plain:
      'Isolation valve status feedback confirms that a boiler\'s inlet and outlet valves have opened before the boiler fires. Without it, the BAS cannot safely stage boilers — opening a boiler into a closed system risks pressure damage and failed starts.',
  },
  secHWPumpStatus: {
    short: 'Secondary hot water pump status feedback',
    impact: 'Required for secondary loop verification',
    plain:
      'Secondary pump status confirms that distribution pumps serving the building loop are running. Without this feedback, the BAS cannot verify that heat is being delivered to terminal units, cannot implement lead/lag rotation, and cannot alarm on pump failures.',
  },
  hwIsoValveCmd: {
    short: 'Boiler isolation valve command',
    impact: 'Required for boiler sequencing',
    plain:
      'The isolation valve command allows the BAS to open and close individual boiler ports as part of staging and lead/lag sequences. Without individual valve control, the plant cannot safely add or remove boilers from the loop without manual intervention.',
  },
  // ── CHWP additional point keys ─────────────────────────────────────────
  chillerEvapDP: {
    short: 'Chiller evaporator differential pressure sensor',
    impact: 'Required for minimum flow protection',
    plain:
      'The evaporator differential pressure sensor verifies that adequate chilled water flow is passing through the chiller barrel. Without it, the BAS cannot detect low-flow conditions that can freeze the evaporator and damage the chiller — one of the most expensive HVAC failures.',
  },
  chwFlow: {
    short: 'Chilled water flow meter',
    impact: 'Required for ton metering and delta-T monitoring',
    plain:
      'A chilled water flow meter allows the BAS to calculate actual cooling delivered in tons, monitor system efficiency, and detect low delta-T conditions. Low delta-T on a chilled water plant is a common cause of chiller over-cycling and excess energy use.',
  },
  chillerStatus: {
    short: 'Chiller run status feedback',
    impact: 'Required for chiller staging and alarming',
    plain:
      'Chiller status confirms that each chiller is running and not in fault. The BAS uses this feedback for lead/lag rotation, staging additional chillers when demand increases, and generating alarms when a chiller trips — the most critical plant equipment in the system.',
  },
  pchwpStatus: {
    short: 'Primary chilled water pump status feedback',
    impact: 'Required for pump sequencing and alarming',
    plain:
      'Primary pump status confirms that chilled water is circulating through the chiller barrel. Without this feedback, the BAS cannot verify that the chiller has flow before starting it, cannot implement lead/lag rotation, and cannot detect pump failures that would lead to chiller shutdown.',
  },
  schwpStatus: {
    short: 'Secondary chilled water pump status feedback',
    impact: 'Required for distribution loop verification',
    plain:
      'Secondary pump status confirms that chilled water is being distributed to the building loop. Without it, the BAS cannot verify that cooling is reaching terminal units, cannot alarm on distribution pump failures, and cannot implement lead/lag rotation across secondary pumps.',
  },
  schwpSpeed: {
    short: 'Secondary chilled water pump speed feedback',
    impact: 'Required for pump VFD verification',
    plain:
      'Secondary pump speed feedback confirms that the variable frequency drive is responding to speed commands. Without it, the BAS cannot verify that pump speed modulation is working or detect VFD faults that would cause the pump to run at full speed regardless of building load.',
  },
  chwIsoValveStatus: {
    short: 'Chiller CHW isolation valve status feedback',
    impact: 'Required for safe chiller staging',
    plain:
      'Chiller isolation valve status confirms that the evaporator-side valve has opened before the chiller is enabled. Without this feedback, the BAS cannot safely stage chillers — enabling a chiller without confirmed flow through the evaporator risks freeze damage and failed starts.',
  },
  chillerEnable: {
    short: 'Chiller enable command',
    impact: 'Required for chiller staging sequences',
    plain:
      'The chiller enable point allows the BAS to start and stop individual chillers as part of staging and lead/lag sequences. Without it, the BAS cannot control which chillers run, preventing energy-efficient staging strategies.',
  },
  chwSetpoint: {
    short: 'Chiller leaving water temperature setpoint command',
    impact: 'Required for CHW supply temperature reset',
    plain:
      'The chilled water setpoint command allows the BAS to tell the chiller what temperature to target. Raising this setpoint during mild weather — chilled water temperature reset — is one of the most effective chiller plant efficiency strategies and requires this writable point.',
  },
  pchwpEnable: {
    short: 'Primary chilled water pump enable command',
    impact: 'Required for pump staging sequences',
    plain:
      'The primary pump enable command allows the BAS to start individual pumps before enabling the chiller and as part of lead/lag sequences. Without individual pump control, the plant cannot safely stage chillers or rotate primary pumps to equalize runtime.',
  },
  schwpEnable: {
    short: 'Secondary chilled water pump enable command',
    impact: 'Required for distribution pump staging',
    plain:
      'The secondary pump enable command allows the BAS to start and stop distribution pumps in response to building load. Without it, secondary pumps must run continuously, wasting energy during periods of low cooling demand.',
  },
  chwIsoValveCmd: {
    short: 'CHW isolation valve command',
    impact: 'Required for chiller isolation during staging',
    plain:
      'The isolation valve command allows the BAS to open and close each chiller\'s evaporator-side port during staging and lead/lag sequences. Without individual valve control, chillers cannot be safely added to or removed from the loop without manual intervention.',
  },
  // ── CT (Cooling Tower) point keys ─────────────────────────────────────────
  cwrt: {
    short: 'Condenser water return temperature sensor',
    impact: 'Required for condenser delta-T monitoring',
    plain:
      'Condenser water return temperature allows the BAS to calculate the heat rejected through the cooling tower. Low condenser water delta-T can indicate tower, chiller, or pumping problems that reduce overall plant efficiency.',
  },
  oaWetBulb: {
    short: 'Outdoor air wet-bulb temperature sensor',
    impact: 'Required for cooling tower approach control',
    plain:
      'Wet-bulb temperature is the fundamental limit for cooling tower performance — a tower can only cool water to within a few degrees of the wet-bulb. Wet-bulb measurement is required for optimal condenser water setpoint reset, which improves chiller efficiency during mild weather.',
  },
  oaRH: {
    short: 'Outdoor air relative humidity sensor',
    impact: 'Supports wet-bulb calculation',
    plain:
      'Outdoor humidity combined with dry-bulb temperature allows the BAS to calculate wet-bulb temperature when a dedicated wet-bulb sensor is not available. This enables condenser water setpoint reset based on actual atmospheric conditions.',
  },
  ctFanStatus: {
    short: 'Cooling tower fan run status feedback',
    impact: 'Required for fan proof-of-operation',
    plain:
      'Cooling tower fan status confirms that the tower fan is running and providing evaporative cooling. Without this feedback, the BAS cannot verify fan operation, implement lead/lag across multiple tower cells, or alarm when a fan fails — which would allow condenser water temperatures to rise and reduce chiller efficiency.',
  },
  cwPumpStatus: {
    short: 'Condenser water pump run status feedback',
    impact: 'Required for pump proof-of-operation',
    plain:
      'Condenser pump status confirms that condenser water is circulating through the chiller and cooling tower. Without it, the BAS cannot verify that the chiller has condenser flow before starting, cannot detect pump failures, and cannot implement lead/lag pump rotation.',
  },
  sumpLevel: {
    short: 'Cooling tower sump/basin water level',
    impact: 'Required for freeze and overflow protection',
    plain:
      'The sump level sensor monitors the water level in the cooling tower basin. Low level triggers makeup water valves to prevent pump cavitation; high level indicates overflow or valve problems. Without sump monitoring, the BAS cannot prevent dry-running pumps or wasted water from an open makeup valve.',
  },
  cwIsoValveStatus: {
    short: 'Condenser water isolation valve status feedback',
    impact: 'Required for safe chiller staging',
    plain:
      'Condenser isolation valve status confirms that the condenser-side port has opened before the chiller is enabled. Without it, the BAS cannot safely stage chillers — enabling a chiller without confirmed condenser flow risks refrigerant-side damage and failed starts.',
  },
  ctFanEnable: {
    short: 'Cooling tower fan enable command',
    impact: 'Required for tower fan sequencing',
    plain:
      'The tower fan enable command allows the BAS to start and stop cooling tower fans in response to condenser water temperature. Without it, fans must run continuously or be controlled manually, eliminating the significant energy savings available from fan cycling and variable-speed control.',
  },
  cwPumpEnable: {
    short: 'Condenser water pump enable command',
    impact: 'Required for condenser pump staging',
    plain:
      'The condenser pump enable command allows the BAS to start pumps before enabling the chiller and as part of lead/lag sequences. Without individual pump control, the plant cannot safely stage chillers or rotate condenser pumps to equalize runtime.',
  },
  cwIsoValveCmd: {
    short: 'Condenser water isolation valve command',
    impact: 'Required for chiller staging sequences',
    plain:
      'The condenser isolation valve command allows the BAS to open and close each chiller\'s condenser-side port during staging and lead/lag sequences. Without it, chillers cannot be safely added to or removed from the condenser loop without manual intervention.',
  },
  makeupValveCmd: {
    short: 'Cooling tower makeup water valve command',
    impact: 'Required for basin level control',
    plain:
      'The makeup water valve command allows the BAS to automatically refill the cooling tower basin when the sump level drops. Without BAS control, the makeup valve must be set to a fixed position, risking overflow during low-load periods or pump cavitation when the basin empties.',
  },
};

/**
 * ASHRAE36_SECTIONS — defines available report sections for the audit and proposal.
 * Mirrors the REPORT_SECTIONS pattern.
 */
var ASHRAE36_SECTIONS = {
  audit: [
    { key: 'cover', label: 'Cover Page', group: 'Report', defaultOn: true },
    { key: 'executive', label: 'Executive Summary', group: 'Report', defaultOn: true },
    { key: 'building', label: 'Per-Building Detail', group: 'Report', defaultOn: true },
    { key: 'recommendations', label: 'Recommendations', group: 'Report', defaultOn: true },
  ],
  proposal: [
    { key: 'proposalCover', label: 'Cover Page', group: 'Proposal', defaultOn: true },
    { key: 'proposalScope', label: 'Scope of Work', group: 'Proposal', defaultOn: true },
    { key: 'proposalOutcomes', label: 'Expected Outcomes', group: 'Proposal', defaultOn: true },
  ],
};

// ─── collectASHRAE36Data ───────────────────────────────────────────────────
/**
 * Reads equipment matrix data and computes compliance scores for all buildings.
 * Returns a structured data object consumed by the page template functions.
 *
 * @param {number|string} projId
 * @returns {object|null}
 */
function collectASHRAE36Data(projId) {
  if (typeof emLoadMatrix !== 'function') return null;
  var matData = emLoadMatrix(projId);
  if (!matData || !matData.rows || !matData.rows.length) return null;

  var proj = (typeof projects !== 'undefined' ? projects : []).find(function (x) {
    return x.id === projId;
  });
  var projName = proj ? proj.client || proj.name || 'Project' : 'Project';
  var today = new Date();
  var dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Group rows by building
  var bldgMap = {};
  matData.rows.forEach(function (row) {
    var bName = row.building || 'Unknown Building';
    if (!bldgMap[bName]) bldgMap[bName] = [];
    bldgMap[bName].push(row);
  });

  // Auditable equipment categories (excludes 'other')
  var AUDITABLE = ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'ct'];
  var CAT_LABELS = {
    ahu: 'Air Handling Unit',
    vav: 'VAV Terminal',
    fpb: 'Fan-Powered Terminal',
    ddvav: 'Dual-Duct Terminal',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Tower',
  };

  // Compute per-building compliance
  var buildingsData = [];
  var portfolioGapCounts = {}; // key -> count across all buildings

  Object.keys(bldgMap).forEach(function (bName) {
    var rows = bldgMap[bName];
    var auditableRows = rows.filter(function (r) {
      return AUDITABLE.indexOf(r.category) !== -1;
    });

    if (!auditableRows.length) return;

    // Per-equipment compliance via emComputeCompliance
    var equipResults = [];
    var totalPointsRequired = 0;
    var totalPointsMatched = 0;
    var totalSeqRequired = 0;
    var totalSeqMatched = 0;
    var bldgGaps = {};

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
      if (typeof emComputeSequenceReadiness === 'function') {
        var seqReadiness = emComputeSequenceReadiness(row, result);
        for (var seqKey in seqReadiness) {
          if (!seqReadiness.hasOwnProperty(seqKey)) continue;
          var seqEntry = seqReadiness[seqKey];
          if (seqEntry.status === 'na') continue;
          totalSeqRequired++;
          if (seqEntry.status === 'ready') {
            totalSeqMatched++;
          } else {
            // 'blocked' or 'partial' — accumulate as a gap for proposals/recommendations
            portfolioGapCounts[seqKey] = (portfolioGapCounts[seqKey] || 0) + 1;
            bldgGaps[seqKey] = (bldgGaps[seqKey] || 0) + 1;
          }
        }
      }

      // Accumulate hardware point gap counts for portfolio summary
      result.missingPoints.forEach(function (mp) {
        portfolioGapCounts[mp.categoryKey] = (portfolioGapCounts[mp.categoryKey] || 0) + 1;
        bldgGaps[mp.categoryKey] = (bldgGaps[mp.categoryKey] || 0) + 1;
      });

      equipResults.push({
        id: row.id,
        name: row.equipName || row.name || 'Unknown',
        category: row.category,
        categoryLabel: CAT_LABELS[row.category] || row.category,
        location: row.location || '',
        compliance: result,
      });
    });

    // Calculate point and sequence coverage percentages
    var pointPct = totalPointsRequired > 0 ? Math.round((totalPointsMatched / totalPointsRequired) * 100) : 0;
    var seqPct = totalSeqRequired > 0 ? Math.round((totalSeqMatched / totalSeqRequired) * 100) : 0;
    var composite = Math.round(pointPct * 0.4 + seqPct * 0.6);

    // Status band
    var status = composite >= 75 ? 'green' : composite >= 50 ? 'amber' : 'red';
    var statusColor = composite >= 75 ? 'var(--rpt-green)' : composite >= 50 ? 'var(--rpt-orange)' : 'var(--rpt-red)';
    var statusLabel = composite >= 75 ? 'Good' : composite >= 50 ? 'Needs Attention' : 'Significant Gaps';

    // Top gaps for this building
    var topGaps = Object.keys(bldgGaps)
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
      topGaps: topGaps,
    });
  });

  if (!buildingsData.length) return { _noAuditableEquip: true };

  // Portfolio-level top gaps (most common missing checks across all buildings)
  var portfolioTopGaps = Object.keys(portfolioGapCounts)
    .sort(function (a, b) {
      return portfolioGapCounts[b] - portfolioGapCounts[a];
    })
    .slice(0, 8)
    .map(function (key) {
      return {
        key: key,
        count: portfolioGapCounts[key],
        buildingCount: buildingsData.filter(function (b) {
          return b.topGaps.some(function (g) {
            return g.key === key;
          });
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
  var portfolioSeqPct = buildingsData.length
    ? Math.round(
        buildingsData.reduce(function (s, b) {
          return s + b.seqPct;
        }, 0) / buildingsData.length,
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
  var portfolioStatus = portfolioComposite >= 75 ? 'green' : portfolioComposite >= 50 ? 'amber' : 'red';

  return {
    project: { name: projName, id: projId },
    date: dateStr,
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
    },
  };
}

// ─── Gauge ring SVG helper ─────────────────────────────────────────────────
function _a36GaugeSVG(pct, color, label, size) {
  size = size || 90;
  var r = size * 0.38;
  var cx = size / 2;
  var cy = size / 2;
  var circumference = 2 * Math.PI * r;
  var filled = (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  var empty = circumference - filled;
  return (
    '<svg width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    size +
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
    ' stroke-linecap="round" transform="rotate(-90 ' +
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
    '<text x="' +
    cx +
    '" y="' +
    (cy + size * 0.22) +
    '" text-anchor="middle" font-size="' +
    size * 0.115 +
    '" fill="var(--rpt-page-text)" font-family="Arial,sans-serif">' +
    label +
    '</text>' +
    '</svg>'
  );
}

// ─── Status chip helper ────────────────────────────────────────────────────
function _a36StatusChip(status) {
  var color = status === 'green' ? 'var(--rpt-green)' : status === 'amber' ? 'var(--rpt-orange)' : 'var(--rpt-red)';
  var bg = status === 'green' ? '#f0fdf4' : status === 'amber' ? '#fff7ed' : '#fef2f2';
  var label = status === 'green' ? 'Good' : status === 'amber' ? 'Needs Attention' : 'Significant Gaps';
  return (
    '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;color:' +
    color +
    ';background:' +
    bg +
    ';border:1px solid ' +
    color +
    '">' +
    label +
    '</span>'
  );
}

// ─── rptPageASHRAE36Cover ─────────────────────────────────────────────────
/**
 * Cover page: three gauge rings (overall/sensor/sequence), one-paragraph finding.
 * Hero page — no interior header, uses CSC letterhead.
 */
function rptPageASHRAE36Cover(n, d) {
  var p = d.portfolio;
  var color = p.composite >= 75 ? 'var(--rpt-green)' : p.composite >= 50 ? 'var(--rpt-orange)' : 'var(--rpt-red)';
  var statusWord = p.composite >= 75 ? 'strong' : p.composite >= 50 ? 'moderate' : 'limited';
  var readinessWord =
    p.composite >= 75 ? 'largely compliant' : p.composite >= 50 ? 'partially compliant' : 'not yet compliant';

  // One-paragraph finding
  var finding =
    'This ASHRAE Guideline 36 compliance audit evaluated <strong>' +
    p.totalEquip +
    ' pieces of HVAC equipment</strong> across <strong>' +
    p.totalBuildings +
    ' buildings</strong> at ' +
    d.project.name +
    '. ' +
    'The portfolio achieved an overall compliance score of <strong style="color:' +
    color +
    '">' +
    p.composite +
    '%</strong>, ' +
    'indicating <strong>' +
    statusWord +
    '</strong> readiness for Guideline 36 sequences. ' +
    'Point coverage (sensors and actuators) averaged <strong>' +
    p.pointPct +
    '%</strong> and ' +
    'sequence programming coverage averaged <strong>' +
    p.seqPct +
    '%</strong>. ' +
    'Of the ' +
    p.totalBuildings +
    ' buildings audited, ' +
    p.greenCount +
    ' are ' +
    readinessWord +
    ', ' +
    p.amberCount +
    ' have moderate gaps, and ' +
    p.redCount +
    ' have significant gaps requiring attention. ' +
    'The sections that follow detail findings by building and provide a prioritized list of recommended upgrades.';

  var gauges =
    '<div style="display:flex;justify-content:center;gap:36px;margin:24px 0 20px">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.composite, color, 'Overall', 110) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Composite Score</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.pointPct, 'var(--rpt-blue)', 'Points', 110) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sensor Coverage</div></div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(p.seqPct, '#7c3aed', 'Sequences', 110) +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-top:4px">Sequence Coverage</div></div>' +
    '</div>';

  var bodyHTML =
    '<div style="padding:20px 48px 16px">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">ASHRAE Guideline 36 Compliance Audit</div>' +
    '<div style="font-size:15px;color:var(--rpt-page-text);margin-bottom:2px">' +
    d.project.name +
    '</div>' +
    '<div style="font-size:12px;color:var(--rpt-page-text);margin-bottom:20px">' +
    d.date +
    '</div>' +
    gauges +
    '<div style="background:#f8fafc;border-left:3px solid ' +
    color +
    ';padding:12px 14px;border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;color:var(--rpt-page-text)">' +
    finding +
    '</div>' +
    '<div style="display:flex;gap:16px;margin-top:16px">' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-green)">' +
    p.greenCount +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Buildings — Good</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-orange)">' +
    p.amberCount +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Buildings — Needs Attention</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-red)">' +
    p.redCount +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Buildings — Significant Gaps</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:10px 12px;text-align:center">' +
    '<div style="font-size:20px;font-weight:700;color:var(--rpt-blue)">' +
    p.totalEquip +
    '</div>' +
    '<div style="font-size:10px;color:var(--rpt-page-text)">Equipment Units Audited</div>' +
    '</div>' +
    '</div>' +
    '</div>';

  // Use rptPage with a data-like object for footer formatting
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };
  return rptPage(n, 'ASHRAE 36 Audit — Cover', bodyHTML, {
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
  var p = d.portfolio;
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };

  // Building status table
  var tableRows = '';
  d.buildings.forEach(function (b) {
    var bar =
      '<div style="display:flex;align-items:center;gap:4px">' +
      '<div style="width:' +
      b.composite +
      'px;max-width:120px;height:8px;background:' +
      b.statusColor +
      ';border-radius:2px;min-width:2px"></div>' +
      '<span style="font-size:10px;color:var(--rpt-page-text)">' +
      b.composite +
      '%</span>' +
      '</div>';
    tableRows +=
      '<tr>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule)">' +
      b.name +
      '</td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);text-align:center">' +
      b.equipCount +
      '</td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);text-align:center">' +
      b.pointPct +
      '%</td>' +
      '<td style="padding:5px 8px;font-size:11px;color:var(--rpt-page-text);border-bottom:1px solid var(--rpt-rule);text-align:center">' +
      b.seqPct +
      '%</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid var(--rpt-rule)">' +
      bar +
      '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid var(--rpt-rule)">' +
      _a36StatusChip(b.status) +
      '</td>' +
      '</tr>';
  });

  var thStyle =
    'padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#fff;background:var(--rpt-blue);text-align:left';
  var table =
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<thead><tr>' +
    '<th style="' +
    thStyle +
    '">Building</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Equipment</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sensors</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center">Sequences</th>' +
    '<th style="' +
    thStyle +
    '">Score</th>' +
    '<th style="' +
    thStyle +
    '">Status</th>' +
    '</tr></thead>' +
    '<tbody>' +
    tableRows +
    '</tbody>' +
    '</table>';

  // Key finding callout
  var topGap = p.topGaps[0];
  var callout = '';
  if (topGap) {
    callout =
      '<div style="background:#fffbeb;border-left:3px solid var(--rpt-orange);padding:10px 12px;border-radius:0 4px 4px 0;margin-bottom:14px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-orange);margin-bottom:4px">Most Common Gap Across Portfolio</div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--rpt-page-text);margin-bottom:2px">' +
      (ASHRAE36_GAP_DESCRIPTIONS[topGap.key] ? ASHRAE36_GAP_DESCRIPTIONS[topGap.key].short : topGap.key) +
      '</div>' +
      '<div style="font-size:11px;color:var(--rpt-page-text)">' +
      (ASHRAE36_GAP_DESCRIPTIONS[topGap.key] ? ASHRAE36_GAP_DESCRIPTIONS[topGap.key].plain : '') +
      '</div>' +
      '</div>';
  }

  // Portfolio stat bar
  var statBar =
    '<div style="display:flex;gap:12px;margin-bottom:16px">' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:8px 10px;text-align:center;border:1px solid var(--rpt-rule)">' +
    '<div style="font-size:18px;font-weight:700;color:' +
    (p.composite >= 75 ? 'var(--rpt-green)' : p.composite >= 50 ? 'var(--rpt-orange)' : 'var(--rpt-red)') +
    '">' +
    p.composite +
    '%</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.04em">Portfolio Score</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:8px 10px;text-align:center;border:1px solid var(--rpt-rule)">' +
    '<div style="font-size:18px;font-weight:700;color:var(--rpt-blue)">' +
    p.pointPct +
    '%</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.04em">Sensor Coverage</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:8px 10px;text-align:center;border:1px solid var(--rpt-rule)">' +
    '<div style="font-size:18px;font-weight:700;color:#7c3aed">' +
    p.seqPct +
    '%</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.04em">Sequence Coverage</div>' +
    '</div>' +
    '<div style="flex:1;background:#f8fafc;border-radius:4px;padding:8px 10px;text-align:center;border:1px solid var(--rpt-rule)">' +
    '<div style="font-size:18px;font-weight:700;color:var(--rpt-page-text)">' +
    p.totalEquip +
    '</div>' +
    '<div style="font-size:9px;color:var(--rpt-page-text);text-transform:uppercase;letter-spacing:0.04em">Equipment Audited</div>' +
    '</div>' +
    '</div>';

  var bodyHTML = statBar + callout + table;
  return rptPage(n, 'ASHRAE 36 Audit — Executive Summary', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Executive Summary',
  });
}

// ─── rptPageASHRAE36Building ──────────────────────────────────────────────
/**
 * Per-building detail page: equipment overview, what's working, gaps with
 * plain-language explanations.
 * @param {number} n - Page number
 * @param {object} d - Data from collectASHRAE36Data
 * @param {object} building - Single building entry from d.buildings
 */
function rptPageASHRAE36Building(n, d, building) {
  var b = building;
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };

  // Equipment type breakdown
  var equipBreakdown = Object.keys(b.equipCounts)
    .map(function (cat) {
      var CAT_LABELS = {
        ahu: 'Air Handlers',
        vav: 'VAV Terminals',
        fpb: 'Fan-Powered Terminals',
        ddvav: 'Dual-Duct Terminals',
        hwp: 'Hot Water Plant',
        chwp: 'Chilled Water Plant',
        ct: 'Cooling Towers',
      };
      return (
        '<span style="font-size:10px;padding:2px 8px;background:#f1f5f9;border-radius:10px;color:var(--rpt-page-text);margin-right:4px">' +
        b.equipCounts[cat] +
        ' ' +
        (CAT_LABELS[cat] || cat) +
        '</span>'
      );
    })
    .join('');

  // Coverage gauges
  var gauges =
    '<div style="display:flex;gap:20px;margin-bottom:12px;align-items:center">' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.composite, b.statusColor, 'Overall', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.pointPct, 'var(--rpt-blue)', 'Sensors', 70) +
    '</div>' +
    '<div style="text-align:center">' +
    _a36GaugeSVG(b.seqPct, '#7c3aed', 'Sequences', 70) +
    '</div>' +
    '<div style="flex:1">' +
    '<div style="font-size:12px;font-weight:600;color:var(--rpt-page-text);margin-bottom:4px">' +
    b.name +
    '</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:6px">' +
    b.equipCount +
    ' equipment units audited</div>' +
    '<div style="margin-bottom:4px">' +
    equipBreakdown +
    '</div>' +
    _a36StatusChip(b.status) +
    '</div>' +
    '</div>';

  // What's working (covered points summary)
  var workingItems = [];
  b.equipResults.forEach(function (eq) {
    if (eq.compliance.coveredPoints && eq.compliance.coveredPoints.length) {
      eq.compliance.coveredPoints.forEach(function (cp) {
        if (workingItems.indexOf(cp.categoryLabel) === -1) workingItems.push(cp.categoryLabel);
      });
    }
  });
  var workingHTML = '';
  if (workingItems.length) {
    workingHTML =
      '<div style="margin-bottom:12px">' +
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-green);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em">What Is Working</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px">' +
      workingItems
        .map(function (w) {
          return (
            '<span style="font-size:10px;padding:2px 8px;background:#f0fdf4;border:1px solid var(--rpt-green);border-radius:10px;color:var(--rpt-green)">' +
            w +
            '</span>'
          );
        })
        .join('') +
      '</div></div>';
  }

  // Gaps section
  var gapsHTML = '';
  if (b.topGaps.length) {
    var gapRows = b.topGaps
      .map(function (gap) {
        var desc = gap.desc || {};
        return (
          '<div style="margin-bottom:10px;padding:8px 10px;background:#fef9f0;border-left:3px solid var(--rpt-orange);border-radius:0 4px 4px 0">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">' +
          '<span style="font-size:11px;font-weight:700;color:var(--rpt-page-text)">' +
          (desc.short || gap.key) +
          '</span>' +
          '<span style="font-size:10px;color:var(--rpt-orange)">' +
          (desc.impact || '') +
          '</span>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--rpt-page-text);line-height:1.5">' +
          (desc.plain || '') +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    gapsHTML =
      '<div>' +
      '<div style="font-size:11px;font-weight:700;color:var(--rpt-orange);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">Top Gaps — ' +
      b.name +
      '</div>' +
      gapRows +
      '</div>';
  } else {
    gapsHTML =
      '<div style="font-size:11px;color:var(--rpt-green);padding:8px">No significant gaps identified for this building.</div>';
  }

  var bodyHTML = gauges + workingHTML + gapsHTML;
  return rptPage(n, 'ASHRAE 36 Audit — ' + b.name, bodyHTML, { data: fakeData, label: 'Page ' + n + ' — ' + b.name });
}

// ─── rptPageASHRAE36Recommendations ──────────────────────────────────────
/**
 * Recommendations page: ranked gaps by impact, plain descriptions, next step.
 */
function rptPageASHRAE36Recommendations(n, d) {
  var p = d.portfolio;
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };

  var recRows = p.topGaps
    .map(function (gap, idx) {
      var desc = gap.desc || {};
      var affectedList = d.buildings
        .filter(function (b) {
          return b.topGaps.some(function (g) {
            return g.key === gap.key;
          });
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
        (affectedStr ? '<br><span style="color:var(--rpt-page-text);opacity:0.7">' + affectedStr + '</span>' : '') +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

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
    '</tbody>' +
    '</table>';

  var nextStep =
    '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:10px 12px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">What Happens Next</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6">' +
    'Control Service Company can provide a detailed scope of work and fixed-fee proposal to address these gaps through BAS programming and hardware upgrades. ' +
    'Typical projects are phased to minimize disruption and are designed to begin generating energy savings within the first 90 days. ' +
    'Contact your CSC representative to review these findings and discuss next steps.' +
    '</div>' +
    '</div>';

  var bodyHTML = table + nextStep;
  return rptPage(n, 'ASHRAE 36 Audit — Recommendations', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Recommendations',
  });
}

// ─── rptPageASHRAE36ProposalCover ─────────────────────────────────────────
/**
 * Proposal cover page with table of contents.
 */
function rptPageASHRAE36ProposalCover(n, d) {
  var p = d.portfolio;
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };
  var color = p.composite >= 75 ? 'var(--rpt-green)' : p.composite >= 50 ? 'var(--rpt-orange)' : 'var(--rpt-red)';

  var toc =
    '<div style="background:#f8fafc;border-radius:4px;padding:12px 16px;margin-bottom:16px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em">Contents</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:2">' +
    '<div>1. Executive Summary</div>' +
    '<div>2. Scope of Work — Phase 1: Critical Gaps</div>' +
    '<div>3. Scope of Work — Phase 2: Sequence Programming</div>' +
    '<div>4. Expected Outcomes &amp; Timeline</div>' +
    '<div>5. Next Steps</div>' +
    '</div>' +
    '</div>';

  var intro =
    '<div style="font-size:12px;color:var(--rpt-page-text);line-height:1.7;margin-bottom:16px">' +
    'Based on our ASHRAE Guideline 36 compliance audit of <strong>' +
    d.project.name +
    '</strong>, ' +
    'Control Service Company is pleased to present this service proposal. ' +
    'Our audit identified an overall compliance score of <strong style="color:' +
    color +
    '">' +
    p.composite +
    '%</strong> across ' +
    p.totalBuildings +
    ' buildings and ' +
    p.totalEquip +
    ' equipment units. ' +
    'This proposal outlines the programming and hardware upgrades needed to bring your facility to full Guideline 36 compliance, ' +
    'maximizing energy savings and occupant comfort.' +
    '</div>';

  var bodyHTML =
    '<div style="padding:16px 0">' +
    '<div style="font-size:22px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">ASHRAE Guideline 36</div>' +
    '<div style="font-size:17px;font-weight:600;color:var(--rpt-page-text);margin-bottom:4px">BAS Programming &amp; Upgrade Proposal</div>' +
    '<div style="font-size:13px;color:var(--rpt-page-text);margin-bottom:20px">' +
    d.project.name +
    ' &nbsp;|&nbsp; ' +
    d.date +
    '</div>' +
    '<div style="height:2px;background:var(--rpt-blue);margin-bottom:20px"></div>' +
    intro +
    toc +
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
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };

  // Phase 1: Hardware/sensor gaps (non-sequence keys)
  var SEQUENCE_KEYS = [
    'satReset',
    'dspReset',
    'economizer',
    'demandCtrl',
    'optStart',
    'hwReset',
    'chwReset',
    'leadLag',
  ];
  var phase1Gaps = p.topGaps.filter(function (g) {
    return SEQUENCE_KEYS.indexOf(g.key) === -1;
  });
  var phase2Gaps = p.topGaps.filter(function (g) {
    return SEQUENCE_KEYS.indexOf(g.key) !== -1;
  });

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

  var ph1HTML = phase1Gaps.length
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

  var bodyHTML =
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--rpt-blue);margin-bottom:6px;border-bottom:2px solid var(--rpt-blue);padding-bottom:3px">Phase 1 — Hardware &amp; Sensor Upgrades</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);margin-bottom:8px">Installation of missing sensors and actuators required for Guideline 36 compliance. This phase establishes the hardware foundation for sequence programming.</div>' +
    ph1HTML +
    '</div>' +
    '<div style="margin-bottom:14px">' +
    '<div style="font-size:12px;font-weight:700;color:#7c3aed;margin-bottom:6px;border-bottom:2px solid #7c3aed;padding-bottom:3px">Phase 2 — BAS Sequence Programming</div>' +
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
  var fakeData = { project: { client: d.project.name }, period: { label: d.date, reportDate: null } };

  var outcomes =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">' +
    _proposalOutcomeCard(
      'Energy Cost Reduction',
      'ASHRAE 36 sequences typically reduce HVAC energy use by 15–30% compared to conventional control strategies, primarily through fan speed optimization, temperature reset, and economizer improvements.',
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
    '<div style="background:#f8fafc;border-radius:4px;padding:12px 14px;margin-bottom:14px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em">Typical Implementation Timeline</div>' +
    '<div style="display:flex;gap:0">' +
    _timelineStep('Weeks 1–2', 'Site Assessment', 'Final point verification and hardware list confirmation') +
    _timelineStep(
      'Weeks 3–6',
      'Hardware Installation',
      'Sensor and actuator installation with minimal operational impact',
    ) +
    _timelineStep('Weeks 7–10', 'Programming', 'BAS sequence programming and initial testing') +
    _timelineStep(
      'Weeks 11–12',
      'Commissioning',
      'Functional testing and savings verification with occupied conditions',
    ) +
    '</div>' +
    '</div>';

  var nextStep =
    '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:12px 14px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--rpt-blue);margin-bottom:4px">Ready to Move Forward?</div>' +
    '<div style="font-size:11px;color:var(--rpt-page-text);line-height:1.6">' +
    'Contact your Control Service Company representative to schedule a pre-proposal walkthrough, finalize scope, and receive a fixed-fee project cost. ' +
    'We can typically begin hardware procurement within two weeks of contract execution.' +
    '</div>' +
    '</div>';

  var bodyHTML = outcomes + timeline + nextStep;
  return rptPage(n, 'ASHRAE 36 Proposal — Expected Outcomes', bodyHTML, {
    data: fakeData,
    label: 'Page ' + n + ' — Expected Outcomes',
  });
}

function _proposalOutcomeCard(title, body, color) {
  return (
    '<div style="background:#f8fafc;border-radius:4px;padding:10px 12px;border-top:3px solid ' +
    color +
    '">' +
    '<div style="font-size:11px;font-weight:700;color:' +
    color +
    ';margin-bottom:4px">' +
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
    return html.replace('<div class="rpt-page"', '<div class="rpt-page" data-section="' + key + '"');
  }

  if (s.cover !== false) pages.push(_tagA36Section(rptPageASHRAE36Cover(pageNum++, data), 'cover'));
  if (s.executive !== false) pages.push(_tagA36Section(rptPageASHRAE36Executive(pageNum++, data), 'executive'));

  if (s.building !== false) {
    data.buildings.forEach(function (b) {
      pages.push(_tagA36Section(rptPageASHRAE36Building(pageNum++, data, b), 'building'));
    });
  }

  if (s.recommendations !== false)
    pages.push(_tagA36Section(rptPageASHRAE36Recommendations(pageNum++, data), 'recommendations'));

  return pages.join('\n');
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
    return html.replace('<div class="rpt-page"', '<div class="rpt-page" data-section="' + key + '"');
  }

  if (s.proposalCover !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalCover(pageNum++, data), 'proposalCover'));
  if (s.proposalScope !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalScope(pageNum++, data), 'proposalScope'));
  if (s.proposalOutcomes !== false)
    pages.push(_tagA36Section(rptPageASHRAE36ProposalOutcomes(pageNum++, data), 'proposalOutcomes'));

  return pages.join('\n');
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
      '<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--s2);cursor:pointer">' +
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

  var data = collectASHRAE36Data(projId);
  if (!data) {
    showToast('No equipment matrix data found. Import a BAS point list on the Equipment tab first.', 'error');
    return;
  }
  if (data._noAuditableEquip) {
    showToast(
      'No auditable equipment found. Equipment must be classified as AHU, VAV, FPB, HWP, CHWP, or CT — not "Other" — to generate a report.',
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
  showReportOverlay(html, reportTitle);
}
window.generateASHRAE36Preview = generateASHRAE36Preview;
