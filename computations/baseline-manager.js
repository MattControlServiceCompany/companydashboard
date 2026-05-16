// computations/baseline-manager.js — Multi-baseline data model and migration (Phase 1)
// Depends on: normalization.js (getNormRows, buildMoMap, normMonth),
//             regression.js (computeMeterRegression, regressionBaseline),
//             savings.js (for backward-compat fallback path),
//             getWeatherForBuilding() (energy-department.html global),
//             saveUtilityData() (energy-department.html global)
//
// Phase 1 scope: data model + lazy migration only. No UI changes.
// The existing m.baseline field is NEVER removed — backward compatibility is preserved.

/* ─────────────────────────────────────────────────────────────
   Helper: advance a YYYY-MM string by one calendar month
───────────────────────────────────────────────────────────── */
function _blNextMonth(ym) {
  if (!ym) return null;
  const [y, mo] = ym.split('-').map(Number);
  if (mo === 12) return y + 1 + '-01';
  return y + '-' + String(mo + 1).padStart(2, '0');
}

/* ─────────────────────────────────────────────────────────────
   Helper: generate a unique baseline ID
───────────────────────────────────────────────────────────── */
function _blGenId() {
  return 'bl_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

/* ─────────────────────────────────────────────────────────────
   freezeBaseline(meter, options)
   Snapshots the current meter.baseline into an immutable object
   that can be pushed into meter.baselines[].

   options = {
     label:       string  — human label (optional)
     frozenBy:    string  — 'user' | 'migrated' | 'system' (default: 'user')
     notes:       string  — optional notes
     savingsWindowStart: YYYY-MM  — override window start (default: month after bl.end)
     id:          string  — override ID (used during migration to keep stable IDs)
   }

   Returns the frozen baseline object (does NOT push it onto the meter — caller does that).
   Returns null if meter.baseline is missing or has fewer than 3 months.
───────────────────────────────────────────────────────────── */
function freezeBaseline(meter, options) {
  options = options || {};
  const bl = meter.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return null;

  const sorted = bl.months.slice().sort();
  const start = bl.start || sorted[0];
  const end = bl.end || sorted[sorted.length - 1];
  const winStart = options.savingsWindowStart || _blNextMonth(end);

  const frozen = {
    id: options.id || _blGenId(),
    label: options.label || 'Baseline ' + start + ' – ' + end,
    frozenAt: options.frozenAt || new Date().toISOString(),
    frozenBy: options.frozenBy || 'user',
    immutable: true,

    start: start,
    end: end,
    months: sorted,

    reg: bl.reg ? JSON.parse(JSON.stringify(bl.reg)) : null,

    // weatherSnapshot: not captured in legacy format; populated as null.
    // New baselines created via addBaseline() can populate this when weather
    // data is available at freeze time.
    weatherSnapshot: options.weatherSnapshot || null,

    // normalizedMonths: pre-computed per-month values if supplied by caller.
    // For migrated baselines these start as null and are computed live.
    normalizedMonths: options.normalizedMonths || null,

    savingsWindow: {
      start: winStart,
      end: options.savingsWindowEnd || null,
    },

    overrides: bl.overrides ? JSON.parse(JSON.stringify(bl.overrides)) : {},
    costSavOverrides: bl.costSavOverrides ? JSON.parse(JSON.stringify(bl.costSavOverrides)) : {},
    notes: options.notes || '',
    billsUsed: options.billsUsed || [],
  };

  return frozen;
}

/* ─────────────────────────────────────────────────────────────
   migrateToMultiBaseline(meter)
   Wraps the existing meter.baseline into meter.baselines[0].
   Lazy — safe to call repeatedly; no-ops if already migrated
   or if there is no baseline to migrate.

   Does NOT call saveUtilityData() — caller is responsible for saving.
   Returns true if a migration was performed, false otherwise.
───────────────────────────────────────────────────────────── */
function migrateToMultiBaseline(meter) {
  // Already migrated
  if (meter.baselines && meter.baselines.length > 0) return false;
  // Nothing to migrate
  if (!meter.baseline || !meter.baseline.months || meter.baseline.months.length < 3) return false;

  const bl = meter.baseline;
  const sorted = bl.months.slice().sort();
  const end = bl.end || sorted[sorted.length - 1];

  const frozen = freezeBaseline(meter, {
    id: 'bl_migrated_' + Date.now(),
    label: 'Original Baseline',
    frozenAt: null, // unknown — predates audit trail
    frozenBy: 'migrated',
    savingsWindowStart: _blNextMonth(end),
    notes: 'Migrated from legacy single-baseline format. Weather snapshot not available.',
  });

  if (!frozen) return false;

  meter.baselines = [frozen];
  // The legacy meter.baseline is intentionally kept in place.
  // All existing code paths that read m.baseline will continue to work.
  return true;
}

/* ─────────────────────────────────────────────────────────────
   getActiveBaseline(meter, date)
   Given a YYYY-MM date string, returns the baseline object whose
   savingsWindow covers that month. Returns null if no baseline
   applies (e.g., the month is inside a baseline period, not a
   savings window, or the meter has no baselines array).
───────────────────────────────────────────────────────────── */
function getActiveBaseline(meter, date) {
  if (!meter.baselines || !meter.baselines.length || !date) return null;

  // Search newest-first so that overlapping windows resolve to the most recent baseline
  const sorted = meter.baselines.slice().sort((a, b) => {
    const aStart = (a.savingsWindow && a.savingsWindow.start) || a.start || '';
    const bStart = (b.savingsWindow && b.savingsWindow.start) || b.start || '';
    return bStart.localeCompare(aStart);
  });

  for (let i = 0; i < sorted.length; i++) {
    const bl = sorted[i];
    const winStart = bl.savingsWindow && bl.savingsWindow.start;
    const winEnd = bl.savingsWindow && bl.savingsWindow.end;
    if (!winStart) continue;
    if (date >= winStart && (!winEnd || date <= winEnd)) return bl;
  }

  return null;
}

/* ─────────────────────────────────────────────────────────────
   addBaseline(meter, baselineConfig)
   Creates and freezes a new baseline entry, appends it to
   meter.baselines, and updates the previous baseline's
   savingsWindow.end to close its window.

   baselineConfig = {
     label:    string   — human label
     notes:    string   — optional notes
     frozenBy: string   — 'user' | 'system'
     weatherSnapshot:  object | null
     normalizedMonths: object | null
     billsUsed:        array
   }

   Requires meter.baseline to have the months/reg already set
   (the caller sets up meter.baseline normally, then calls this
   to commit it as a frozen multi-baseline entry).

   Does NOT call saveUtilityData() — caller saves.
   Returns the new frozen baseline object, or null on failure.
───────────────────────────────────────────────────────────── */
function addBaseline(meter, baselineConfig) {
  baselineConfig = baselineConfig || {};
  const bl = meter.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return null;

  const sorted = bl.months.slice().sort();
  const end = bl.end || sorted[sorted.length - 1];
  const newWinStart = _blNextMonth(end);

  // Ensure baselines array exists
  if (!meter.baselines) meter.baselines = [];

  // Close the previous open baseline's savings window
  const prev = meter.baselines
    .slice()
    .sort((a, b) => {
      const as = (a.savingsWindow && a.savingsWindow.start) || '';
      const bs = (b.savingsWindow && b.savingsWindow.start) || '';
      return bs.localeCompare(as);
    })
    .find((b) => b.savingsWindow && b.savingsWindow.end === null);

  if (prev) {
    // The previous open window closes the month before the new savings window starts
    const [y, mo] = newWinStart.split('-').map(Number);
    const prevMo = mo === 1 ? 12 : mo - 1;
    const prevY = mo === 1 ? y - 1 : y;
    prev.savingsWindow.end = prevY + '-' + String(prevMo).padStart(2, '0');
  }

  const frozen = freezeBaseline(meter, {
    label: baselineConfig.label,
    frozenBy: baselineConfig.frozenBy || 'user',
    notes: baselineConfig.notes || '',
    savingsWindowStart: newWinStart,
    savingsWindowEnd: null,
    weatherSnapshot: baselineConfig.weatherSnapshot || null,
    normalizedMonths: baselineConfig.normalizedMonths || null,
    billsUsed: baselineConfig.billsUsed || [],
  });

  if (!frozen) return null;

  meter.baselines.push(frozen);
  return frozen;
}

/* ─────────────────────────────────────────────────────────────
   getBaselineHistory(meter)
   Returns an array of all baseline objects with their periods,
   sorted oldest-first. Each entry includes:
   {
     id, label, frozenAt, frozenBy, immutable,
     start, end,           — the period months
     savingsWindow,        — {start, end} — the savings window
     r2,                   — r² from the best regression fit
     regrType,             — 'HDD' | 'CDD' | 'dual' | null
     notes
   }
   Returns [] if no baselines array exists.
───────────────────────────────────────────────────────────── */
function getBaselineHistory(meter) {
  if (!meter.baselines || !meter.baselines.length) return [];

  return meter.baselines
    .slice()
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    .map((bl) => {
      // Determine best regression type and r²
      let r2 = null;
      let regrType = null;
      if (bl.reg) {
        const hR2 = bl.reg.hdd && bl.reg.hdd.r2 != null ? bl.reg.hdd.r2 : -1;
        const cR2 = bl.reg.cdd && bl.reg.cdd.r2 != null ? bl.reg.cdd.r2 : -1;
        const dR2 = bl.reg.dual && bl.reg.dual.r2 != null ? bl.reg.dual.r2 : -1;
        if (dR2 >= hR2 && dR2 >= cR2 && dR2 >= 0) {
          r2 = dR2;
          regrType = 'dual';
        } else if (cR2 >= hR2 && cR2 >= 0) {
          r2 = cR2;
          regrType = 'CDD';
        } else if (hR2 >= 0) {
          r2 = hR2;
          regrType = 'HDD';
        }
      }

      return {
        id: bl.id,
        label: bl.label || '',
        frozenAt: bl.frozenAt || null,
        frozenBy: bl.frozenBy || null,
        immutable: bl.immutable === true,
        start: bl.start || '',
        end: bl.end || '',
        months: (bl.months || []).length,
        savingsWindow: bl.savingsWindow || { start: null, end: null },
        r2: r2,
        regrType: regrType,
        notes: bl.notes || '',
      };
    });
}
