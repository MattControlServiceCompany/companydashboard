// Tests for app/estimate-workbook-export.js - SYNTHETIC inputs only (no client names).
// Export -> reload with ExcelJS -> compare cached results to estimate-workbook.js compute().
// Optional: independent recalculation with LibreOffice (soffice) or python `formulas`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ExcelJS = require('exceljs');
const W = require('./app/estimate-workbook.js');
const X = require('./app/estimate-workbook-export.js');

let n = 0;
function eq(a, b, label) {
  n++;
  assert.deepStrictEqual(a, b, label + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}
function close(a, b, label) {
  n++;
  assert.ok(Math.abs(a - b) < 1e-9, label + ': got ' + a + ' expected ' + b);
}

const SHEETS = { Dash: 'Dash', MatEquip: 'Mat & Equip', LaborRates: 'Labor Rates' };
const isF = (v) => !!v && typeof v === 'object' && (v.formula != null || v.sharedFormula != null);
const META = {
  customer: 'Sample Customer',
  project: 'Sample Project Alpha',
  title: 'Sample Audit',
  date: '2026-10-01',
  preparedBy: 'Sample Preparer',
};

async function load(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

// Every formula cell the engine models: cached result == compute().
async function checkCached(label, input) {
  const calc = W.compute(input);
  const buf = await X.exportWorkbook(input, META);
  const wb = await load(buf);
  let formulaCells = 0,
    constCells = 0;
  Object.keys(calc.cells).forEach((key) => {
    const i = key.indexOf('!');
    const ws = wb.getWorksheet(SHEETS[key.slice(0, i)]);
    const cell = ws.getCell(key.slice(i + 1));
    const want = calc.cells[key];
    if (isF(cell.value)) {
      formulaCells++;
      const got = cell.result; // cell.value drops a 0 result (ExcelJS), cell.result keeps it
      if (want == null) eq(got, { error: '#DIV/0!' }, label + ' ' + key);
      else if (typeof want === 'number') close(got, want, label + ' ' + key);
      else eq(got, want, label + ' ' + key);
    } else if (typeof want === 'number' && typeof cell.value === 'number') {
      constCells++;
      close(cell.value, want, label + ' const ' + key);
    }
  });
  assert.ok(formulaCells > 100, 'too few formula cells matched: ' + formulaCells);
  return { calc, wb, buf, formulaCells, constCells };
}

(async () => {
  // 1. Baseline fixture (52 h PE, KS, no tax/bond/parts/subs): WP1 literals.
  const base = { hours: { PE: 52 }, ot: 'Not Applicable', state: 'Kansas', taxRate: 0, bond: false };
  const r = await checkCached('base', base);
  const dash = r.wb.getWorksheet('Dash');
  const res = (a) => dash.getCell(a).result;
  eq(res('G18'), 6335, 'labor G18');
  eq(res('G32'), 95, 'tools G32');
  eq(res('N26'), 6430, 'direct N26');
  eq(res('N27'), 643, 'overhead N27');
  eq(res('N28'), 2122, 'profit N28');
  eq(res('N36'), 9195, 'total N36');
  console.log(
    'base: formula cells with cached result checked: ' + r.formulaCells + ', constant cells: ' + r.constCells,
  );

  // 2. Inputs held in input cells.
  const full = {
    hours: { PE: 52, SE: 10.5, EI: 4 },
    ot: 'x1.5',
    state: 'Missouri',
    taxRate: 0.0875,
    bond: true,
    parts: [
      { qty: 3, unit: 100.5, partNo: 'PN-1', desc: 'Sample part', code: 'D-STD' },
      { qty: 2, unit: 12.17 },
    ],
    tools: [{ qty: 2, hrs: 3, rate: 7.25 }],
    vans: { qty: 2 },
    misc: [{ qty: 2, rate: 250.5 }],
    subs: [
      { amount: 1000, bondPct: 0.015 },
      { amount: 333.33, bondPct: 0 },
    ],
    pct: { warrantyFactor: 0.1, safety: 0.02, bond: 0.012 },
  };
  const f = await checkCached('full', full);
  const fw = f.wb;
  const d = fw.getWorksheet('Dash'),
    info = fw.getWorksheet('Info'),
    mat = fw.getWorksheet('Mat & Equip'),
    q = fw.getWorksheet('CSC Parts Quote');
  eq(d.getCell('E8').value, 52, 'E8');
  eq(d.getCell('E10').value, 10.5, 'E10 SE');
  eq(d.getCell('E14').value, 4, 'E14 EI');
  eq(d.getCell('E9').value, null, 'E9 DE blank');
  eq(d.getCell('L8').value, 1000, 'L8');
  eq(d.getCell('M8').value, 0.015, 'M8');
  eq(d.getCell('D27').value, 2, 'tool qty');
  eq(d.getCell('E27').value, 3, 'tool hrs');
  eq(d.getCell('F27').value, 7.25, 'tool rate');
  eq(d.getCell('E38').value, 2, 'vans');
  eq(d.getCell('E39').value, 2, 'misc qty');
  eq(d.getCell('F39').value, 250.5, 'misc rate');
  eq(d.getCell('D17').value, 0.1, 'warranty factor');
  eq(d.getCell('F37').value, 0.02, 'safety');
  eq(d.getCell('M35').value.formula, 'IF(Info!F15="Applicable",0.012,0)', 'bond rate formula');
  eq(info.getCell('C7').value, META.project, 'Info project');
  eq(info.getCell('C16').value, META.customer, 'Info customer');
  eq(info.getCell('C12').value, META.preparedBy, 'Info prepared by');
  eq(info.getCell('F13').value, 0.0875, 'tax');
  eq(info.getCell('F15').value, 'Applicable', 'bond flag');
  eq(info.getCell('F16').value, 'x1.5', 'OT');
  eq(info.getCell('F18').value, 'Missouri', 'state');
  eq(info.getCell('F7').value.toISOString().slice(0, 10), '2026-10-01', 'date requested');
  eq(info.getCell('F8').value.toISOString().slice(0, 10), '2026-10-01', 'date submitted is static (no TODAY)');
  eq(isF(info.getCell('F8').value), false, 'F8 not a formula');
  eq(mat.getCell('B8').value, 'PN-1', 'part no');
  eq(mat.getCell('C8').value, 'Sample part', 'desc');
  eq(mat.getCell('D8').value, 'D-STD', 'code');
  eq(mat.getCell('E8').value, 3, 'qty');
  eq(q.getCell('E11').value, 100.5, 'unit price');
  eq(q.getCell('E12').value, 12.17, 'unit price 2');
  eq(q.getCell('F11').result, 302, 'parts quote line cached (301.5 -> 302)');
  eq(q.getCell('F37').result, f.calc.cells['MatEquip!G33'], 'parts quote total cached');
  eq(fw.getWorksheet('Proposal').getCell('K43').result, f.calc.summary.total, 'Proposal amount = N36');
  eq(fw.getWorksheet('Proposal').getCell('I7').result, META.project, 'Proposal project mirror');

  // 3. Workbook-level checks.
  eq(
    fw.worksheets.map((w) => w.name),
    ['Info', 'Sheet1', 'Proposal', 'Dash', 'Mat & Equip', 'Labor Rates', 'CSC Parts Quote', 'NS'],
    'sheet order',
  );
  eq(d.getCell('G8').value.formula, 'ROUND(F8*E8,0)', 'formula kept, no _xlfn.SINGLE');
  eq(isF(d.getCell('N36').value), true, 'N36 formula kept');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(f.buf);
  const names = Object.keys(zip.files);
  eq(
    names.some((p) => /vbaProject|ctrlProps|customXml/.test(p)),
    false,
    'no macro / control parts',
  );
  let xml = '';
  for (const p of names) if (/\.(xml|rels|vml)$/.test(p)) xml += await zip.files[p].async('string');
  eq(/_xlfn\.SINGLE/.test(xml), false, 'no SINGLE wrapper in output');
  eq(/joco|johnson|librar|county/i.test(xml), false, 'no client strings in output');
  eq(
    /fullCalcOnLoad="1"/.test(await zip.files['xl/workbook.xml'].async('string')),
    true,
    'fullCalcOnLoad in workbook.xml',
  );

  // 4. Empty input.
  const e = await checkCached('empty', {});
  eq(e.wb.getWorksheet('Dash').getCell('N36').result, 0, 'empty total 0');
  eq(e.wb.getWorksheet('Dash').getCell('L43').result, { error: '#DIV/0!' }, 'empty blended = DIV/0');

  // 5. File name.
  eq(X.fileName(META), '2026-10-01-sample-project-alpha-estimate.xlsx', 'file name');
  eq(X.fileName({ project: '  A/B & C!! ', date: '2026-01-02' }), '2026-01-02-a-b-c-estimate.xlsx', 'slug');

  // 6. Independent recalculation: LibreOffice if present, else python `formulas`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'est-export-'));
  const files = { base: r.buf, full: f.buf };
  let recalcTool = null,
    recalcCompared = 0;
  const soffice = ['soffice', 'libreoffice'].find((c) => {
    try {
      cp.execSync(c + ' --version', { stdio: 'pipe' });
      return true;
    } catch (x) {
      return false;
    }
  });
  for (const k of Object.keys(files)) {
    const xp = path.join(tmp, k + '.xlsx'),
      jp = path.join(tmp, k + '.json');
    fs.writeFileSync(xp, Buffer.from(files[k]));
    let vals = null;
    if (soffice) {
      recalcTool = soffice;
      cp.execSync(soffice + ' --headless --convert-to xlsx --outdir "' + path.join(tmp, 'lo') + '" "' + xp + '"', {
        stdio: 'pipe',
        timeout: 180000,
      });
      const wb = await load(fs.readFileSync(path.join(tmp, 'lo', k + '.xlsx')));
      vals = {};
      Object.keys(SHEETS).forEach((p) =>
        wb.getWorksheet(SHEETS[p]).eachRow((row) =>
          row.eachCell((c) => {
            const v = isF(c.value) ? c.result : null;
            if (typeof v === 'number') vals[SHEETS[p].toUpperCase() + '!' + c.address] = v;
          }),
        ),
      );
    } else {
      try {
        cp.execFileSync('python', [path.join(__dirname, 'scripts', 'recalc-xlsx.py'), xp, jp], {
          stdio: 'pipe',
          timeout: 600000,
        });
        vals = JSON.parse(fs.readFileSync(jp, 'utf8'));
        recalcTool = 'python formulas';
      } catch (x) {
        recalcTool = null;
        break;
      }
    }
    const calc = W.compute(k === 'base' ? base : full);
    Object.keys(calc.cells).forEach((key) => {
      const i = key.indexOf('!'),
        sheet = SHEETS[key.slice(0, i)].toUpperCase(),
        a = key.slice(i + 1),
        want = calc.cells[key];
      const got = vals[sheet + '!' + a];
      if (typeof want !== 'number' || typeof got !== 'number') return; // blank input cells come back as 'empty'
      recalcCompared++;
      assert.ok(Math.abs(got - want) < 1e-6, k + ' recalc ' + key + ': got ' + got + ' expected ' + want);
    });
    n++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (recalcTool)
    console.log('recalculated with ' + recalcTool + ': ' + recalcCompared + ' numeric cells match compute()');
  else console.log('RECALC SKIPPED: neither soffice nor python formulas available');

  console.log('PASS: ' + n + ' assertions');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
