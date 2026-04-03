// test_evergy_regex.js — Evergy OCR regex extraction tests
// Run: node test_evergy_regex.js
// All 24 fields must pass (per CLAUDE.md).
//
// This file copies the full _extractEvergy function and its dependencies
// from energy-department.html and tests against real bill text formats.
// Keep patterns in sync with the source.

'use strict';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; failures.push(msg); console.log(`  FAIL: ${msg}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PATTERNS & FUNCTIONS — copied from energy-department.html
//  These MUST stay in sync with the source.
// ═══════════════════════════════════════════════════════════════════════════════

const _EVG_BILLING_DETAILS = /B[il1]{2}[il1]ng\s+D[ec]t[ao][il1]{1,2}[s5]?\s*[-\u2013\u2014]\s*[s5]erv[il1]ce\s+from/i;
const _EVG_SERVICE_FROM = /[s5]erv[il1]ce\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i;
const _EVG_ACCT = /[Aa]ccount\s+(?:N[ou]mber\s*)?[:\s\u00a9\u00ae]\s*(\d[\d ]{4,18}\d)/m;
const _EVG_ADDR = /^(\d+\s+\w[\w\s,]{3,50}(?:KS|MO|KY|OK|NE|IA|AR|TX|CO|IL|IN|OH|MI|PA|NY|NJ|CT|MA|VA|NC|SC|GA|FL|TN|MS|AL|LA|NM|AZ|UT|ID|OR|WA|MT|WY|ND|SD|MN|WI|NV|CA))\s*$/m;

// ─── Full _extractEvergy (copied from source, keep in sync) ──────────────────
function _extractEvergy(t, acctOverride, addrOverride) {
  const sum = (t, re) => { const ms = [...t.matchAll(re)]; return ms.length ? ms.reduce((s, m) => s + parseFloat(m[1].replace(/,/g, '')), 0).toFixed(2) : null; };
  const chg = (re) => t.match(re)?.[1]?.replace(/,/g, '') || null;

  const CHG_STOP = /(?:Cust|Fac\S|Demand|Energy\s+C|ECA|EER|PTS|TDC|RkVA|Subtotal|Current\s+Charges)/i;
  const getAmt = (line) => {
    const ms = [...line.matchAll(/\$([\d,]+\.\d{2})/g)];
    let best = null;
    for (const m of ms) {
      const before = line.slice(Math.max(0, m.index - 4), m.index);
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
      if (/at\s*$/.test(before)) continue;
      if (/\s*[Pp][eo]r\s+k/i.test(after)) continue;
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val < 1 && /\.\d{3,}/.test(m[1])) continue;
      best = parseFloat(m[1].replace(/,/g, ''));
    }
    return best;
  };
  const xChg = (keyword, excludeRe) => {
    const lines = t.split('\n');
    let total = 0, found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(keyword, 'i').test(lines[i])) continue;
      if (excludeRe && excludeRe.test(lines[i])) continue;
      const a = getAmt(lines[i]);
      if (a !== null) { total += a; found = true; }
      else {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const l = lines[j];
          if (CHG_STOP.test(l) && !/per\s+k[Wh]/i.test(l) && !/^[\d,]+\.\d+\s+kWh\s+at/i.test(l)) break;
          const ja = getAmt(l);
          if (ja !== null) { total += ja; found = true; break; }
        }
      }
    }
    return found ? total.toFixed(2) : null;
  };

  const bpMatch = t.match(_EVG_SERVICE_FROM) || t.match(/service\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i);
  let numDays = null;
  if (bpMatch) {
    try {
      const s = new Date(bpMatch[1]), e = new Date(bpMatch[2]);
      numDays = String(Math.round((e - s) / (1000 * 60 * 60 * 24)));
    } catch (ex) {}
  }

  // ── Meter read table: single-row format ──
  const meterRow = t.match(/(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+\d+\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+[\d,]+\.?\d*\s+([\d,.]+)\s+[\d,]+\.?\d*\s+([\d.]+)\s+([\d.]+)/);

  // ── Meter read table: multi-line labeled format (fallback) ──
  // Real PDF text often has each field on its own labeled line:
  //   Start Read Date\n12/31\n...\nEnd Read (-)\n45,215.1026\n...
  const _mlMeter = (() => {
    if (meterRow) return null; // single-row matched, no need for fallback
    const startDateM = t.match(/Start\s+Read\s+Date\s*\n\s*(\d{2}\/\d{2})/i);
    const endDateM = t.match(/End\s+Read\s+Date\s*\n\s*(\d{2}\/\d{2})/i);
    const endReadM = t.match(/End\s+Read\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const startReadM = t.match(/Start\s+Read\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const multM = t.match(/Meter\s+Multiplier\s*\([^)]*\)\s*\n\s*([\d,]+\.\d+)/i);
    const kwUsedM = t.match(/KW\s+Used\s+([\d,]+\.\d+)/i);
    const rkvaUsedM = t.match(/RKVA\s+Used\s+([\d,]+\.\d+)/i);
    if (startDateM || endDateM || endReadM || startReadM) {
      return {
        startDate: startDateM?.[1] || null,
        endDate: endDateM?.[1] || null,
        endRead: endReadM?.[1]?.replace(/,/g, '') || null,
        startRead: startReadM?.[1]?.replace(/,/g, '') || null,
        multiplier: multM?.[1]?.replace(/,/g, '') || null,
        kwUsed: kwUsedM?.[1]?.replace(/,/g, '') || null,
        rkvaUsed: rkvaUsedM?.[1]?.replace(/,/g, '') || null,
      };
    }
    return null;
  })();

  // ── kWh Consumed: multi-source with cross-validation ──
  const _validKwh = v => {
    if (v > 10000 && v === Math.floor(v)) return false;
    return v > 0 && v < 2000000;
  };

  const meterKwh = (() => {
    if (!meterRow) return null;
    const endR = parseFloat((meterRow[3] || '').replace(/,/g, ''));
    const startR = parseFloat((meterRow[4] || '').replace(/,/g, ''));
    const mult = parseFloat((meterRow[5] || '').replace(/,/g, ''));
    if (endR > 0 && startR > 0 && mult > 0) {
      const calc = (endR - startR) * mult;
      if (_validKwh(calc)) return calc;
    }
    return null;
  })();

  const fromAdj = [...t.matchAll(/(?:ECA|EER|PTS)\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[\s\S]*?(?:for\s+)?([\d,]+\.\d+)\s*kWh/gi)]
    .map(m => parseFloat(m[1].replace(/,/g, '')))
    .filter(v => _validKwh(v));
  const adjKwhVal = fromAdj.length ? Math.max(...fromAdj) : null;

  const fromEnergy = [...t.matchAll(/Energy\s+(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])\s+(?:On\s+Pk\s+\w+\s+|Off\s+Pk\s+\w+\s+)?([\d,]+\.\d+)\s*kWh/gi)]
    .map(m => parseFloat(m[1].replace(/,/g, '')))
    .filter(v => v > 0);
  const tierKwh = fromEnergy.length ? fromEnergy.reduce((a, b) => a + b, 0) : null;

  const adjKwh = (() => {
    if (meterKwh && adjKwhVal) {
      return String(meterKwh);
    }
    if (meterKwh) return String(meterKwh);
    if (adjKwhVal) return String(adjKwhVal);
    if (tierKwh && _validKwh(tierKwh)) return String(tierKwh);
    const fallback = t.match(/kWh\s+(?:Used|Consumed)[^\d]*([\d,]+\.\d+)/i) || t.match(/([\d,]+\.\d+)\s*kWh\s+(?:Used|Consumed)/i);
    if (fallback) { const v = parseFloat(fallback[1].replace(/,/g, '')); if (_validKwh(v)) return String(v); }
    return null;
  })();

  const rateMatch = t.match(/[-\u2013]\s*([\dA-Z]{3,10})[^\n]*?\n?[^\n]*?Billing\s+Details/i) || t.match(/[-\u2013]\s*([\dA-Z]{3,10})\s+Billing\s+Details/i) || t.match(/LGS[^\n]*[-\u2013]\s*([\dA-Z]{3,10})\s*$/im) || t.match(/Rate\s*(?:Schedule|Code)?[\s:]*([A-Z0-9\-]{2,12})/i) || (() => {
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/Billing\s+Details/i.test(lines[i])) {
        for (let j = Math.max(0, i - 8); j < i; j++) {
          const line = lines[j].trim();
          const rm = line.match(/^([A-Z]{2,5}(?:-[A-Z0-9]{1,3})?)$/);
          if (rm) return rm;
          const rm2 = line.match(/\b([A-Z]{2,5})\s*[-\u2013]\s*([A-Z0-9]{1,5})\s*$/);
          if (rm2) return [null, rm2[1] + '-' + rm2[2]];
        }
        break;
      }
    }
    return null;
  })();

  // ── Charges ──
  const C = '(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[.:]?';
  const custChg = xChg('C[ua][s5][t1iI][o0][mM][eao][r1tT]\\s+' + C);
  const facKW = t.match(new RegExp('Fac\\S*\\s+' + C + '\\s+([\\d,.]+)\\s*[kK][Ww]', 'i'))?.[1]?.replace(/,/g, '') || null;
  const facChg = xChg('Fac\\S*\\s+' + C);
  const demKW = t.match(new RegExp('Demand\\s+' + C + '\\s+([\\d,.]+)\\s*[kK][Ww]', 'i'))?.[1]?.replace(/,/g, '') || null;
  const demChg = xChg('Demand\\s+' + C);
  // Date-aware: Kansas switched from 3-tier to On/Off Peak on 12/21/2023
  const _billDate = bpMatch ? new Date(bpMatch[1]) : null;
  const _isOnOffPeak = !_billDate || _billDate >= new Date('12/21/2023');
  const onPkChg = _isOnOffPeak ? xChg('Energy\\s+' + C + '\\s+On\\s+P[kK]') : null;
  const offPkChg = _isOnOffPeak ? xChg('Energy\\s+' + C + '\\s+Off\\s+P[kK]') : null;
  const tieredChg = !_isOnOffPeak ? xChg('Energy\\s+' + C, /On\s+P[kK]|Off\s+P[kK]/i) : null;
  const ecaChg = xChg('ECA\\s+' + C);
  const eerChg = xChg('EER\\s+' + C);
  const ptsChg = xChg('PTS\\s+' + C);
  const tdcKW = t.match(new RegExp('TDC\\s+' + C + '[\\s\\S]*?([\\d,.]+)\\s*[kK][Ww]\\s+at', 'i'))?.[1]?.replace(/,/g, '') || null;
  const tdcChg = xChg('TDC\\s+' + C);
  const rkvaChg = xChg('R[kK]VA\\s+' + C);
  const taxExempt = chg(/Tax\s+exempt[^$\n]*\$([\d,]+\.\d{2})/i);
  const billOffset = (() => {
    const m1 = t.match(/Bill\s+[0O]ff\w*[^\n]*?(-?\$[\d,]+\.\d{2}|-[\d,]+\.\d{2}|\$[\d,]+\.\d{2})/im);
    if (m1) return m1[1].replace(/\$/g, '');
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/Subtotal/i.test(lines[i])) {
        for (let j = Math.max(0, i - 3); j < i; j++) {
          const neg = lines[j].match(/-\$?([\d,]+\.\d{2})/);
          if (neg && !/Payment|Previously|Late/i.test(lines[j])) return '-' + neg[1].replace(/,/g, '');
        }
        break;
      }
    }
    return null;
  })();
  const franchise = chg(/Franch[il1]se\s+Fee[^$\n]*\$([\d,]+\.\d{2})/i);
  const totalDue = (() => {
    const lines = t.split('\n');
    let bestVal = null, bestDist = Infinity;
    let subtotalIdx = -1, bdIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/Subtotal/i.test(lines[i])) subtotalIdx = i;
      if (/Billing\s+Details/i.test(lines[i])) bdIdx = i;
    }
    for (let i = 0; i < lines.length; i++) {
      if (/Current\s+Charges/i.test(lines[i])) {
        const amt = getAmt(lines[i]);
        if (amt !== null) {
          const dist = subtotalIdx >= 0 ? Math.abs(i - subtotalIdx) : Infinity;
          if (dist < bestDist) { bestDist = dist; bestVal = amt; }
        }
        if (i + 1 < lines.length && /Utilit/i.test(lines[i + 1])) {
          const uAmt = getAmt(lines[i + 1]);
          if (uAmt !== null) {
            const dist = subtotalIdx >= 0 ? Math.abs(i + 1 - subtotalIdx) : 1;
            if (dist < bestDist) { bestDist = dist; bestVal = uAmt; }
          }
        }
      }
    }
    if (bestVal !== null) return bestVal.toFixed(2);
    const m2 = t.match(/Subtotal[\s\S]*?\$\s*([\d,]+\.\d{2})/i);
    if (m2) return m2[1].replace(/,/g, '');
    const pf = v => v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0;
    const sumVal = pf(custChg) + pf(facChg) + pf(demChg) + pf(onPkChg || tieredChg) + pf(offPkChg) + pf(ecaChg) + pf(eerChg) + pf(ptsChg) + pf(tdcChg) + pf(taxExempt) + pf(franchise);
    return sumVal > 0 ? sumVal.toFixed(2) : null;
  })();

  const result = {
    UtilityCompany: 'Evergy',
    CustomerName: t.match(/Customer\s*Name[^A-Za-z\n]*([A-Z][A-Z0-9 #]+?)(?=\s+Account|\n)/im)?.[1]?.trim()
      || t.match(/Customer\s*Name\s*:\s*\n\s*(?:Account[^\n]*\n\s*)?([A-Z][A-Z0-9 #]+)/im)?.[1]?.trim()
      || t.match(/Customer\s*Name\s*:\s*([A-Z][A-Z0-9 #]{2,})/im)?.[1]?.trim() || null,
    AccountNumber: acctOverride || t.match(/Account\s+(?:Number\s*)?[:\s\u00a9\u00ae]\s*(\d[\d ]{4,18}\d)/im)?.[1]?.replace(/\s/g, '') || null,
    ServiceAddress: addrOverride || null,
    RateSchedule: rateMatch?.[1] || null,
    BillingPeriodStart: bpMatch?.[1] || null,
    BillingPeriodEnd: bpMatch?.[2] || null,
    NumberOfDays: numDays,
    MeterReadStart: meterRow?.[1] || _mlMeter?.startDate || null,
    MeterReadEnd: meterRow?.[2] || _mlMeter?.endDate || null,
    StartRead: meterRow?.[4]?.replace(/,/g, '') || _mlMeter?.startRead || null,
    EndRead: meterRow?.[3]?.replace(/,/g, '') || _mlMeter?.endRead || null,
    MeterMultiplier: meterRow?.[5]?.replace(/,/g, '') || _mlMeter?.multiplier || null,
    kWhConsumed: adjKwh,
    ActualKW: meterRow?.[6] || _mlMeter?.kwUsed || null,
    ActualRKVA: meterRow?.[7] || _mlMeter?.rkvaUsed || null,
    CustomerCharge: custChg,
    FacilitiesKW: facKW,
    FacilitiesCharge: facChg,
    BilledKW: demKW,
    BilledKWCharge: demChg,
    EnergyOnPeakCharge: onPkChg || tieredChg,
    EnergyOffPeakCharge: offPkChg,
    ECACharge: ecaChg,
    EERCharge: eerChg,
    PTSCharge: ptsChg,
    TDCkW: tdcKW,
    TDCCharge: tdcChg,
    RkVACharge: rkvaChg,
    TaxExemptDelivery: taxExempt,
    BillOffset: billOffset,
    FranchiseFee: franchise,
    TotalCurrentCharges: totalDue,
    MeterNumber: null,
  };

  // ── METER NUMBER EXTRACTION ──
  if (!result.MeterNumber) {
    const meterNumMatch = t.match(/Meter\s*(?:Number|No|#|Num)[^A-Za-z0-9\n]*(\d[\d\-A-Z]{3,20})/im)
      || t.match(/Meter\s*:\s*(\d[\d\-A-Z]{3,20})/im);
    if (meterNumMatch) result.MeterNumber = meterNumMatch[1].trim();
  }

  // ── CHARGE RECONCILIATION ──
  const _pf = v => v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0;
  const _compSum = _pf(result.CustomerCharge) + _pf(result.FacilitiesCharge) + _pf(result.BilledKWCharge)
    + _pf(result.EnergyOnPeakCharge) + _pf(result.EnergyOffPeakCharge) + _pf(result.ECACharge)
    + _pf(result.EERCharge) + _pf(result.PTSCharge) + _pf(result.TDCCharge) + _pf(result.RkVACharge)
    + _pf(result.TaxExemptDelivery) + _pf(result.BillOffset) + _pf(result.FranchiseFee);
  const _total = _pf(result.TotalCurrentCharges);
  if (_total > 0 && Math.abs(_compSum - _total) > 1) {
    const bdIdx2 = t.search(/Billing\s+Details/i);
    const stIdx = t.search(/Subtotal/i);
    if (bdIdx2 >= 0 && stIdx > bdIdx2) {
      const section = t.substring(bdIdx2, stIdx);
      const allAmts = [];
      const lines2 = section.split('\n');
      for (const line of lines2) {
        const ms = [...line.matchAll(/\$([\d,]+\.\d{2})/g)];
        for (const m of ms) {
          const before = line.slice(Math.max(0, m.index - 4), m.index);
          const after = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
          if (/at\s*$/.test(before)) continue;
          if (/\s*[Pp][eo]r\s+k/i.test(after)) continue;
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val < 1 && /\.\d{3,}/.test(m[1])) continue;
          allAmts.push({ val, line: line.trim() });
        }
      }
      const capturedVals = Object.values(result).filter(v => v !== null && v !== '').map(v => _pf(v)).filter(v => v > 0);
      const uncaptured = allAmts.filter(a => !capturedVals.some(c => Math.abs(c - a.val) < 0.01) && Math.abs(a.val) > 0.5);
      for (const uc of uncaptured) {
        const lcLine = uc.line.toLowerCase();
        if (!result.CustomerCharge && /cust|custo/i.test(lcLine)) result.CustomerCharge = uc.val.toFixed(2);
        else if (!result.FacilitiesCharge && /fac/i.test(lcLine)) result.FacilitiesCharge = uc.val.toFixed(2);
        else if (!result.RkVACharge && /rkva|rkv/i.test(lcLine)) result.RkVACharge = uc.val.toFixed(2);
        if (!result.FacilitiesKW && /fac/i.test(lcLine)) {
          const kwM = uc.line.match(/([\d,.]+)\s*[kK][Ww]/);
          if (kwM) result.FacilitiesKW = kwM[1].replace(/,/g, '');
        }
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== Evergy Extraction Tests ===\n');

// ─── Test 1: Single-row meter table (existing format — regression) ───────────
console.log('--- Test 1: Single-row meter table (regression) ---');

const singleRowBill = `Customer Name : USD #416 Account Number : 2885731561

202 AQUATIC DR,NEW HS LOUISBURG KS
LGS Primary Voltage - 2LGSF

Billing Details - service from 06/28/2023 to 07/30/2023

Customer Chg $105.97
Facilities Chg 541.1520 kW at $2.577 per kW $1,394.55
Demand Chg 477.9840 kW at $6.497 per kW $3,105.46
Energy Chg 86,037.1200 kWh at $0.06407 per kWh $5,512.40
Energy Chg 66,453.7440 kWh at $0.04573 per kWh $3,038.93
RkVA Chg 147.8400 kW at $0.682 per kW $100.83
ECA Chg for 152,490.8640 kWh $2,186.15
EER Chg for 152,490.8640 kWh $5.91
PTS Chg for 152,490.8640 kWh $262.28
TDC Chg for 477.9840 kW at $2.51004 per kW $1,199.76
Subtotal $16,912.24
Current Charges $16,912.24

06/29 07/31 32 30735.2427 29782.1748 953.0679 160.0000 152490.8640 477.9840 386.8320`;

const r1 = _extractEvergy(singleRowBill, '2885731561', '202 AQUATIC DR,NEW HS LOUISBURG KS');
assert(r1.BillingPeriodStart === '06/28/2023', `T1 BillingPeriodStart (got ${r1.BillingPeriodStart})`);
assert(r1.BillingPeriodEnd === '07/30/2023', `T1 BillingPeriodEnd (got ${r1.BillingPeriodEnd})`);
assert(r1.NumberOfDays === '32', `T1 NumberOfDays (got ${r1.NumberOfDays})`);
assert(r1.MeterReadStart === '06/29', `T1 MeterReadStart (got ${r1.MeterReadStart})`);
assert(r1.MeterReadEnd === '07/31', `T1 MeterReadEnd (got ${r1.MeterReadEnd})`);
assert(r1.StartRead === '29782.1748', `T1 StartRead (got ${r1.StartRead})`);
assert(r1.EndRead === '30735.2427', `T1 EndRead (got ${r1.EndRead})`);
assert(r1.MeterMultiplier === '160.0000', `T1 MeterMultiplier (got ${r1.MeterMultiplier})`);
assert(r1.ActualKW === '477.9840', `T1 ActualKW (got ${r1.ActualKW})`);
assert(r1.ActualRKVA === '386.8320', `T1 ActualRKVA (got ${r1.ActualRKVA})`);
assert(r1.CustomerCharge === '105.97', `T1 CustomerCharge (got ${r1.CustomerCharge})`);
assert(r1.FacilitiesKW === '541.1520', `T1 FacilitiesKW (got ${r1.FacilitiesKW})`);
assert(r1.FacilitiesCharge === '1394.55', `T1 FacilitiesCharge (got ${r1.FacilitiesCharge})`);
assert(r1.BilledKW === '477.9840', `T1 BilledKW (got ${r1.BilledKW})`);
assert(r1.BilledKWCharge === '3105.46', `T1 BilledKWCharge (got ${r1.BilledKWCharge})`);
assert(r1.ECACharge === '2186.15', `T1 ECACharge (got ${r1.ECACharge})`);
assert(r1.TDCCharge === '1199.76', `T1 TDCCharge (got ${r1.TDCCharge})`);
assert(r1.RkVACharge === '100.83', `T1 RkVACharge (got ${r1.RkVACharge})`);
assert(r1.TotalCurrentCharges === '16912.24', `T1 TotalCurrentCharges (got ${r1.TotalCurrentCharges})`);
assert(r1.kWhConsumed !== null, `T1 kWhConsumed not null (got ${r1.kWhConsumed})`);
// Pre-12/21/2023: should use 3-tier energy (NOT On/Off Peak)
assert(r1.EnergyOnPeakCharge !== null, `T1 pre-2023 uses tiered energy as OnPeak (got ${r1.EnergyOnPeakCharge})`);
assert(r1.EnergyOffPeakCharge === null, `T1 pre-2023 no Off Peak (got ${r1.EnergyOffPeakCharge})`);

// ─── Test 2: Multi-line labeled meter table (real PDF format — THE BUG) ──────
console.log('\n--- Test 2: Multi-line meter table (real PDF layout — BUG) ---');

// This is the ACTUAL text layout from Bills LHS.pdf (12/30/2024 bill).
// The meter read data is in labeled multi-line format, NOT a single row.
const multiLineBill = `Customer Name : USD #416 Account Number : 2885731561

202 AQUATIC DR,NEW HS LOUISBURG KS
LGS Primary Voltage - 2LGSF

Page 2 of 2 Billing Date: 01/30/2025

Billing Details - service from 12/30/2024 to 01/29/2025

Customer Chg $102.86
Facilities Chg 545.1840 kW at $2.501 per kW $1,363.51
Demand Chg 292.4160 kW at $5.698 per kW $1,666.19
Energy Chg On Pk Win 13,377.6240 kWh at $0.03854 per kWh $515.57
Energy Chg Off Pk Win 91,348.9440 kWh at $0.03288 per kWh $3,003.55
RkVA Chg 84.9600 kW at $0.663 per kW $56.33
ECA Chg 12-31-2024-01-29-2025 for 101,235.6824 kWh at $0.02054 per kWh $2,079.38
ECA Chg 12-31-2024-12-31-2024 for 3,490.8856 kWh at $0.02074 per kWh $72.40
EER Chg 12-31-2024-01-29-2025 for 104,726.5680 kWh at $0.00 per kWh $0.00
PTS Chg 12-31-2024-01-29-2025 for 104,726.5680 kWh at $0.00228 per kWh $238.78
TDC Chg 12-31-2024-01-29-2025 for 292.4160 kW at $2.46781 per kW $721.63
Subtotal $9,820.20
Current Charges $9,820.20

Start Read Date
12/31

End Read Date
01/30

Days 30

End Read (-)
45,215.1026

Start Read (=)
44,560.5584

Read Difference (x)
654.5442

Meter Multiplier (=)
160.0000

kWh Used 104,727.0720

KW Used 292.4160

RKVA Used 231.1680`;

const r2 = _extractEvergy(multiLineBill, '2885731561', '202 AQUATIC DR,NEW HS LOUISBURG KS');

// Billing period — should already work
assert(r2.BillingPeriodStart === '12/30/2024', `T2 BillingPeriodStart (got ${r2.BillingPeriodStart})`);
assert(r2.BillingPeriodEnd === '01/29/2025', `T2 BillingPeriodEnd (got ${r2.BillingPeriodEnd})`);
assert(r2.NumberOfDays === '30', `T2 NumberOfDays (got ${r2.NumberOfDays})`);

// Charges — should already work
assert(r2.CustomerCharge === '102.86', `T2 CustomerCharge (got ${r2.CustomerCharge})`);
assert(r2.FacilitiesKW === '545.1840', `T2 FacilitiesKW (got ${r2.FacilitiesKW})`);
assert(r2.FacilitiesCharge === '1363.51', `T2 FacilitiesCharge (got ${r2.FacilitiesCharge})`);
assert(r2.BilledKW === '292.4160', `T2 BilledKW (got ${r2.BilledKW})`);
assert(r2.BilledKWCharge === '1666.19', `T2 BilledKWCharge (got ${r2.BilledKWCharge})`);
assert(r2.EnergyOnPeakCharge === '515.57', `T2 EnergyOnPeakCharge (got ${r2.EnergyOnPeakCharge})`);
assert(r2.EnergyOffPeakCharge === '3003.55', `T2 EnergyOffPeakCharge (got ${r2.EnergyOffPeakCharge})`);
assert(r2.TDCCharge === '721.63', `T2 TDCCharge (got ${r2.TDCCharge})`);
assert(r2.RkVACharge === '56.33', `T2 RkVACharge (got ${r2.RkVACharge})`);
assert(r2.TotalCurrentCharges === '9820.20', `T2 TotalCurrentCharges (got ${r2.TotalCurrentCharges})`);
assert(r2.kWhConsumed !== null, `T2 kWhConsumed not null (got ${r2.kWhConsumed})`);

// *** THESE ARE THE BUG — meter read fields from multi-line labeled format ***
assert(r2.MeterReadStart === '12/31', `T2 MeterReadStart (got ${r2.MeterReadStart})`);
assert(r2.MeterReadEnd === '01/30', `T2 MeterReadEnd (got ${r2.MeterReadEnd})`);
assert(r2.EndRead === '45215.1026', `T2 EndRead (got ${r2.EndRead})`);
assert(r2.StartRead === '44560.5584', `T2 StartRead (got ${r2.StartRead})`);
assert(r2.MeterMultiplier === '160.0000', `T2 MeterMultiplier (got ${r2.MeterMultiplier})`);
assert(r2.ActualKW === '292.4160', `T2 ActualKW (got ${r2.ActualKW})`);
assert(r2.ActualRKVA === '231.1680', `T2 ActualRKVA (got ${r2.ActualRKVA})`);

// ─── Test 3: Garbled Facilities prefix (from previous fix) ──────────────────
console.log('\n--- Test 3: Garbled Facilities prefix ---');

const garbledFacBill = multiLineBill.replace('Facilities Chg', 'Facriities Chg');
const r3 = _extractEvergy(garbledFacBill, '2885731561', '202 AQUATIC DR,NEW HS LOUISBURG KS');
assert(r3.FacilitiesCharge === '1363.51', `T3 Garbled Fac charge (got ${r3.FacilitiesCharge})`);
assert(r3.FacilitiesKW === '545.1840', `T3 Garbled Fac kW (got ${r3.FacilitiesKW})`);

const garbledFacBill2 = multiLineBill.replace('Facilities Chg', 'Facties Chg');
const r3b = _extractEvergy(garbledFacBill2, '2885731561', '202 AQUATIC DR,NEW HS LOUISBURG KS');
assert(r3b.FacilitiesCharge === '1363.51', `T3b Truncated Fac charge (got ${r3b.FacilitiesCharge})`);

// ─── Test 4: Multi-line meter with different bills (variation) ───────────────
console.log('\n--- Test 4: Multi-line meter variation ---');

// Another real format: "Note : This is an estimated read." before the table
const estimatedReadBill = `Billing Details - service from 04/29/2025 to 05/29/2025

Customer Chg $102.86
Facilities Chg 545.1840 kW at $2.501 per kW $1,363.51
Demand Chg 529.4400 kW at $5.698 per kW $3,016.75
Energy Chg On Pk Win 22,577.3760 kWh at $0.03854 per kWh $870.13
Energy Chg Off Pk Win 112,413.5760 kWh at $0.03288 per kWh $3,696.16
RkVA Chg 89.2320 kW at $0.663 per kW $59.16
ECA Chg for 134,990.9520 kWh $2,865.36
EER Chg for 134,990.9520 kWh $0.00
PTS Chg for 134,990.9520 kWh $114.74
TDC Chg for 529.4400 kW $1,418.88
Subtotal $13,507.55
Current Charges $13,507.55

Start Read Date
04/30

End Read Date
05/30

Days 30

Note : This is an estimated read.

End Read (-)
48,209.7332

Start Read (=)
47,366.0397

Read Difference (x)
843.6935

Meter Multiplier (=)
160.0000

kWh Used 134,990.9600

KW Used 529.4400

RKVA Used 353.9520`;

const r4 = _extractEvergy(estimatedReadBill, null, null);
assert(r4.MeterReadStart === '04/30', `T4 MeterReadStart with estimated note (got ${r4.MeterReadStart})`);
assert(r4.MeterReadEnd === '05/30', `T4 MeterReadEnd with estimated note (got ${r4.MeterReadEnd})`);
assert(r4.EndRead === '48209.7332', `T4 EndRead (got ${r4.EndRead})`);
assert(r4.StartRead === '47366.0397', `T4 StartRead (got ${r4.StartRead})`);
assert(r4.MeterMultiplier === '160.0000', `T4 MeterMultiplier (got ${r4.MeterMultiplier})`);
assert(r4.ActualKW === '529.4400', `T4 ActualKW (got ${r4.ActualKW})`);
assert(r4.ActualRKVA === '353.9520', `T4 ActualRKVA (got ${r4.ActualRKVA})`);

// ─── Test 5: False positive guards ──────────────────────────────────────────
console.log('\n--- Test 5: False positive guards ---');

const C_local = '(?:Ch[gaq9]|C[HhNn][Gg]|Gh[gq9])[.:]?';
function extractFacChgOnly(text) {
  // Inline version for isolated tests
  const lines = text.split('\n');
  let total = 0, found = false;
  const kw = 'Fac\\S*\\s+' + C_local;
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(kw, 'i').test(lines[i])) continue;
    const ms = [...lines[i].matchAll(/\$([\d,]+\.\d{2})/g)];
    for (const m of ms) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val >= 1) { total += val; found = true; }
    }
  }
  return found ? total.toFixed(2) : null;
}
assert(extractFacChgOnly('Factor analysis $500.00') === null, 'No false positive: "Factor analysis"');
assert(extractFacChgOnly('Fact sheet $200.00') === null, 'No false positive: "Fact sheet"');
assert(extractFacChgOnly('Facilities Chg $1,381.17') === '1381.17', 'True positive: clean Facilities');

// =============================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
