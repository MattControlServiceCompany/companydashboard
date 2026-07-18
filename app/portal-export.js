// app/portal-export.js — Client Portal export function
// Depends on: computations/savings.js (getProjectSavingsByYM, getMeterSavings)
//             computations/pollution.js (calculatePollutionCredits, EQUIV_PER_MT_CO2E)
//             app/csv-import.js (extractStateFromAddress)
//             app/utility-data.js (utilityData, getUDProj)
//             app/core.js (sget, sset, showToast, projects global)

/**
 * publishClientPortal(projId)
 *
 * Generates a sanitized JSON snapshot of project savings data and triggers
 * a browser download. Matt then uploads the file to GitHub at /portal-data/
 * so the permanent portal viewer URL becomes live.
 *
 * Excluded from JSON: account numbers, rate structures, regression params,
 * ECM details, contract penalties, other projects.
 */
function publishClientPortal(projId) {
  // ── 1. Resolve project metadata ──────────────────────────────
  const allProjects = sget('en_projects', []);
  const p = allProjects.find((x) => String(x.id) === String(projId));
  if (!p) {
    showToast('Project not found — cannot publish portal');
    return;
  }

  // ── 2. Generate or reuse portal token ───────────────────────
  if (!p.portalToken) {
    p.portalToken = crypto.randomUUID();
    p.portalEnabled = true;
  }
  p.portalPublishedAt = new Date().toISOString();

  // Save token back to project list
  const projIdx = allProjects.findIndex((x) => String(x.id) === String(projId));
  if (projIdx !== -1) {
    allProjects[projIdx] = p;
    sset('en_projects', allProjects);
  }

  // ── 3. Gather savings data via shared computation ────────────
  // getProjectSavingsByYM returns {YYYY-MM: totalCostSav} across all meters/buildings
  let savByYM = {};
  try {
    savByYM = getProjectSavingsByYM(String(projId)) || {};
  } catch (e) {
    console.warn('[portal-export] getProjectSavingsByYM failed:', e);
  }

  // Also gather unit totals (kWh, therms) for CO2 calculation
  let totalKwhSaved = 0;
  let totalThermsSaved = 0;
  let totalPropaneSaved = 0;

  try {
    const udProj = getUDProj(String(projId));
    if (udProj && udProj.buildings) {
      udProj.buildings.forEach((b) => {
        (b.meters || []).forEach((m) => {
          const bills = (m.bills || []).slice().sort((a, c) => {
            const da = a.start ? new Date(a.start).getTime() : 0;
            const dc = c.start ? new Date(c.start).getTime() : 0;
            return da - dc;
          });
          const incl = m.inclusive !== false;
          try {
            const savResult = getMeterSavings(m, bills, incl, String(projId), b.id);
            Object.values(savResult.unitsByYM || {}).forEach((u) => {
              totalKwhSaved += u.kwh || 0;
              totalThermsSaved += u.therms || 0;
              totalPropaneSaved += u.gallons || 0;
            });
          } catch (e2) {
            console.warn('[portal-export] getMeterSavings failed for meter', m.id, e2);
          }
        });
      });
    }
  } catch (e) {
    console.warn('[portal-export] unit accumulation failed:', e);
  }

  // ── 4. CO2 / environmental metrics ──────────────────────────
  let co2Data = { lbsAvoided: 0, treesEquiv: 0, carsRemoved: 0 };
  try {
    const stateCode = typeof extractStateFromAddress === 'function' ? extractStateFromAddress(p.addr || '') : 'KS';
    const pollution = calculatePollutionCredits(
      Math.max(0, totalKwhSaved),
      Math.max(0, totalThermsSaved),
      Math.max(0, totalPropaneSaved),
      stateCode,
      'mt',
    );
    const co2eMT = Math.abs(pollution.totalCO2 || 0);
    const co2Lbs = co2eMT * 2204.62; // metric tons → lbs
    const eq = EQUIV_PER_MT_CO2E;
    co2Data = {
      lbsAvoided: Math.round(co2Lbs),
      treesEquiv: Math.round(co2eMT * (eq.treeSeedlings || 0)),
      carsRemoved: Math.ceil(co2eMT * (eq.carsRemoved || 0)),
    };
  } catch (e) {
    console.warn('[portal-export] pollution calculation failed:', e);
  }

  // ── 5. Build monthly savings array ───────────────────────────
  const monthlySavings = Object.entries(savByYM)
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ym, savings]) => {
      const [yr, mo] = ym.split('-');
      const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      });
      return { month: ym, label, savingsDollars: Math.round(savings) };
    });

  // ── 6. Compute period label and contract info ────────────────
  const contractYears = p.contractYears || 3;
  const startDate = p.start ? new Date(p.start + 'T12:00:00') : null;
  let currentContractYear = 1;
  if (startDate) {
    const msPerYear = 365.25 * 24 * 3600 * 1000;
    currentContractYear = Math.min(
      contractYears,
      Math.max(1, Math.ceil((Date.now() - startDate.getTime()) / msPerYear)),
    );
  }

  // Period label: first and last month in savings data
  let periodLabel = '';
  const ymKeys = Object.keys(savByYM)
    .filter((k) => savByYM[k] !== 0)
    .sort();
  if (ymKeys.length >= 2) {
    const fmt = (ym) => {
      const [yr, mo] = ym.split('-');
      return new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    };
    periodLabel = fmt(ymKeys[0]) + ' – ' + fmt(ymKeys[ymKeys.length - 1]);
  } else if (ymKeys.length === 1) {
    const [yr, mo] = ymKeys[0].split('-');
    periodLabel = new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  }

  const totalSavings = monthlySavings.reduce((s, m) => s + m.savingsDollars, 0);

  // ── 7. Build sanitized JSON — explicitly exclude sensitive fields ──
  const snapshot = {
    meta: {
      token: p.portalToken,
      projectName: p.name || 'Energy Savings Portal',
      publishedAt: p.portalPublishedAt,
      reportingPeriodLabel: periodLabel,
      contractYears: contractYears,
      currentContractYear: currentContractYear,
      currency: 'USD',
    },
    summary: {
      totalSavingsDollars: totalSavings,
      contractProgressPct:
        p.contract && Number(p.contract) > 0
          ? Math.min(100, Math.round((totalSavings / Number(p.contract)) * 1000) / 10)
          : null,
      totalKwhSaved: Math.round(totalKwhSaved),
      totalThermsSaved: Math.round(totalThermsSaved),
      co2AvoidedLbs: co2Data.lbsAvoided,
      treesEquivalent: co2Data.treesEquiv,
      carsRemovedEquivalent: co2Data.carsRemoved,
    },
    monthly: monthlySavings,
    contact: {
      company: 'Control Service Company',
      name: 'Energy Services',
      email: 'contact@example.com',
    },
  };

  // ── 8. Trigger browser download of <token>.json ──────────────
  const filename = p.portalToken + '.json';
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // ── 9. Show toast with instructions and client URL ───────────
  // Derive the app base path from the running page's own location so the
  // link is correct whether served at root (Netlify) or under a subpath
  // (GitHub Pages: /companydashboard/). Same split('/') idiom used
  // elsewhere in the codebase for subpath-agnostic path handling
  // (site-ui.js, app/site-functions.js) — here we keep everything
  // EXCEPT the current page's own filename, rather than just the leaf.
  const pathParts = location.pathname.split('/');
  pathParts.pop(); // drop the current page's filename (e.g. energy-department.html)
  const basePath = pathParts.join('/') + '/'; // '/' at root, '/companydashboard/' on GH Pages
  const clientUrl = location.origin + basePath + 'portal/?p=' + p.portalToken;
  const githubUploadUrl = 'https://github.com/MattControlServiceCompany/companydashboard/upload/main/portal-data';

  // Guard: a client-facing URL only makes sense when this page itself is
  // being served over http(s). Under file:// (local testing) location.origin
  // / location.pathname produce a filesystem path, not a usable web link —
  // don't claim success or copy that broken value to the clipboard.
  const isWebProtocol = location.protocol === 'http:' || location.protocol === 'https:';

  if (!isWebProtocol) {
    showToast('Portal links only work on the live site — publish from the hosted app, not a local file.', 'warning');
  } else {
    const toastMsg =
      'Portal data downloaded as ' +
      filename +
      '. Upload to GitHub → portal-data/ to go live. Client URL copied to clipboard.';

    showToast(toastMsg);

    // Copy client URL to clipboard (best-effort)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(clientUrl).catch(() => {});
    }
  }

  // Refresh the project detail panel if visible to show the portal URL
  if (typeof refreshProjectPortalStatus === 'function') {
    refreshProjectPortalStatus(projId);
  }
}

window.publishClientPortal = publishClientPortal;
