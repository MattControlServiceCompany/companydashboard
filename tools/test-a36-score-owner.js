// tools/test-a36-score-owner.js: the Audit Report score has ONE owner (a36ComputeScores in app/report-engine.js).
// The Audit Report portfolio gauges and the Equipment Matrix pills show the same numbers, and a row with 0 required
// points (lighting, monitoring) does not lower the score. SYNTHETIC rows only. (backlog 45e09ff0, 2026-11-16)
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-score-owner.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
(async () => {
  const ctx = await launchBrowser('a36-score-owner');
  let fails = 0;
  const ok = (c, m) => {
    if (!c) fails++;
    console.log((c ? 'PASS ' : 'FAIL ') + m);
  };
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app|localhost/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof a36ComputeScores === 'function' && typeof emUpdateStatsPillsForAudit === 'function', null, { timeout: 30000 });
    const r = await page.evaluate(() => {
      const PID = 'synthetic-score-owner';
      window._emActivePid = PID;
      const mk = (id, bld, name, cat, pts) => ({ id, building: bld, location: '', equipName: name, equipType: name, category: cat, subtype: '', points: Object.assign({}, pts), pointsRaw: Object.assign({}, pts), checks: {}, schema: 2 });
      const ahuPts = { 'Supply Air Temp': '55', 'Return Air Temp': '72', 'Supply Fan Status': 'On', 'Supply Fan Speed': '60' };
      const base = [
        mk('a1', 'Synthetic Hall', 'AHU-1', 'ahu', ahuPts),
        mk('a2', 'Synthetic Hall', 'AHU-2', 'ahu', { 'Supply Air Temp': '55' }),
        mk('v1', 'Synthetic Hall', 'VAV-1', 'vav', { 'Zone Temp': '70', 'Damper Position': '40' }),
        mk('a3', 'Synthetic Annex', 'AHU-3', 'ahu', ahuPts),
      ];
      const lights = [1, 2, 3, 4, 5, 6].map((i) => mk('l' + i, 'Synthetic Hall', 'Lighting Panel ' + i, 'lighting', {}));
      const store = { rows: base, importedAt: null, buildings: [] };
      const realLoad = emLoadMatrix;
      window.emLoadMatrix = (pid) => (pid === PID ? store : realLoad(pid));
      const out = {};
      out.without = a36ComputeScores(PID);
      store.rows = base.concat(lights);
      out.withLights = a36ComputeScores(PID);
      out.rep = collectASHRAE36Data(PID).portfolio;
      out.hall = a36ComputeScores(PID, ['Synthetic Hall']);
      out.hallRep = collectASHRAE36Data(PID, null, ['Synthetic Hall']).portfolio;
      // Matrix pills for all rows (lighting included) and for one building
      const bar = document.createElement('div');
      bar.id = 'em-stats-bar';
      document.body.appendChild(bar);
      const pillsText = () => bar.innerText.replace(/\s+/g, ' ');
      emUpdateStatsPillsForAudit(store.rows, store.rows);
      out.pills = pillsText();
      emUpdateStatsPillsForAudit(store.rows.filter((x) => x.building === 'Synthetic Hall'), store.rows);
      out.pillsHall = pillsText();
      out.stats = emComputeAuditStats(store.rows);
      // Column footer (Total row) and row cells
      const defs = emGetAuditColDefs(store.rows);
      const foot = (rows) => {
        const html = buildAuditFooterRow(emComputeAuditFooterTotals(rows, defs), defs, 'Total', true);
        const t = document.createElement('table');
        t.innerHTML = '<tbody>' + html + '</tbody>';
        const cells = Array.prototype.slice.call(t.querySelectorAll('td'));
        const at = (flag) => { const i = defs.findIndex((d) => d[flag]); return i < 0 ? null : cells[i].textContent.trim(); };
        return { cov: at('isAuditCoverage'), seq: at('isAuditSeqPct') };
      };
      out.foot = foot(store.rows);
      out.footHall = foot(store.rows.filter((x) => x.building === 'Synthetic Hall'));
      const cellText = (row) => {
        const comp = emComputeCompliance(row, emLoadEquipConfigFlags(PID, row.id), []);
        const seq = emComputeSequenceReadiness(row, comp);
        const t = document.createElement('table');
        const tr = document.createElement('tr');
        defs.forEach((d) => { if (d.isAuditCoverage || d.isAuditSeqPct) tr.innerHTML += emRenderAuditCell(row, d, comp, {}, {}, {}, seq, null); });
        t.appendChild(tr);
        return Array.prototype.map.call(tr.children, (c) => c.textContent.trim());
      };
      out.lightCells = cellText(lights[0]);
      out.ahuCells = cellText(base[0]);
      return out;
    });
    const w = r.without.portfolio, l = r.withLights.portfolio;
    ok(w.equipCount === 4 && l.equipCount === 4, 'lighting rows (0 required points) are not scored equipment: ' + w.equipCount + ' / ' + l.equipCount);
    ok(w.pointPct === l.pointPct && w.seqPct === l.seqPct && w.composite === l.composite, 'adding 6 lighting rows does not move the score: ' + JSON.stringify(w) + ' vs ' + JSON.stringify(l));
    ok(r.rep.composite === l.composite && r.rep.pointPct === l.pointPct && r.rep.seqPct === l.seqPct, 'Audit Report portfolio equals the owner: ' + r.rep.pointPct + '/' + r.rep.seqPct + '/' + r.rep.composite);
    ok(r.hallRep.composite === r.hall.portfolio.composite && r.hallRep.pointPct === r.hall.portfolio.pointPct && r.hallRep.seqPct === r.hall.portfolio.seqPct, 'one-building filter: Report equals the owner: ' + JSON.stringify(r.hall.portfolio));
    ok(l.pointPct > 0 && l.pointPct < 100 && l.composite > 0, 'synthetic data gives a mid-range score: ' + JSON.stringify(l));
    const pill = (txt, label) => { const m = new RegExp('(\\d+)%\\s*' + label, 'i').exec(txt); return m ? Number(m[1]) : null; };
    ok(pill(r.pills, 'Sensor Coverage') === l.pointPct && pill(r.pills, 'Sequence Readiness') === l.seqPct && pill(r.pills, 'Overall Score') === l.composite, 'Matrix pills equal the owner (all rows): ' + r.pills);
    const h = r.hall.portfolio;
    ok(pill(r.pillsHall, 'Sensor Coverage') === h.pointPct && pill(r.pillsHall, 'Sequence Readiness') === h.seqPct && pill(r.pillsHall, 'Overall Score') === h.composite, 'Matrix pills with a building filter equal the owner for that building: ' + r.pillsHall);
    const pc = (t) => Number(String(t).replace('%', ''));
    ok(pc(r.foot.cov) === l.pointPct && pc(r.foot.seq) === l.seqPct, 'Matrix footer equals the pills / owner (all rows): ' + JSON.stringify(r.foot));
    ok(pc(r.footHall.cov) === h.pointPct && pc(r.footHall.seq) === h.seqPct, 'Matrix footer with a building filter equals the owner: ' + JSON.stringify(r.footHall));
    ok(r.lightCells.every((t) => t === '—' || t === 'N/A') && r.lightCells.indexOf('0%') === -1, 'a row with 0 required points shows a dash, not 0%: ' + JSON.stringify(r.lightCells));
    ok(r.ahuCells.every((t) => /%$/.test(t)), 'a scored row still shows percentages: ' + JSON.stringify(r.ahuCells));
    ok(!('avgCoverage' in r.stats) && !('seqReadinessPct' in r.stats) && typeof r.stats.totalBASPoints === 'number', 'emComputeAuditStats keeps only the point count (no second percent formula)');
  } finally {
    await ctx.close();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e);
  process.exit(1);
});
