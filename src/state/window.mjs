// Catch-up window planning. One frozen clock; adapters must not call Date.now()
// independently to compute cutoffs.
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const COLLECTION_MODES = ['since_last_success', 'fixed_window'];

/**
 * @param {unknown} value
 * @param {{now: number}} opts
 * @returns {{ok: true, ms: number} | {ok: false, error: string}}
 */
export function parseSinceInput(value, { now } = {}) {
  if (value == null || String(value).trim() === '') {
    return { ok: false, error: '--since requires an ISO date or timestamp' };
  }
  const text = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? Date.parse(`${text}T00:00:00Z`)
    : Date.parse(text);
  if (!Number.isFinite(ms)) return { ok: false, error: `invalid --since value: ${text}` };
  if (now != null && ms > now) return { ok: false, error: `--since ${text} is in the future` };
  return { ok: true, ms };
}

export function freezeClock(now = Date.now()) {
  const ms = Number(now);
  if (!Number.isFinite(ms)) throw new Error('clock must be a finite timestamp');
  return {
    now: ms,
    iso: new Date(ms).toISOString(),
    utcDate: new Date(ms).toISOString().slice(0, 10),
  };
}

export function toEpoch(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** Inclusive age in whole days, rounded up against the frozen clock. */
export function ageDaysCeil(sinceMs, untilMs) {
  if (sinceMs == null || untilMs == null) return null;
  return Math.max(1, Math.ceil((untilMs - sinceMs) / DAY_MS));
}

/**
 * Relevance-ranked, page-capped searches cannot cover a catch-up interval.
 * Fetch only the configured horizon; the older catch-up tail is a coverage gap.
 *
 * @returns {{fetchSince: number|null, fetchDays: number|null, until: number|null, gap: {uncoveredSince: number, uncoveredUntil: number}|null}}
 */
export function clampRelevanceWindow(win, { configuredDays, untilMs } = {}) {
  const until = win?.until ?? untilMs ?? null;
  const catchupSince = win?.since ?? null;
  const days = Number(configuredDays);
  const horizonSince = Number.isFinite(days) && days > 0 && until != null
    ? until - days * DAY_MS
    : catchupSince;
  const fetchSince = catchupSince != null && horizonSince != null
    ? Math.max(catchupSince, horizonSince)
    : (horizonSince ?? catchupSince);
  const fetchDays = ageDaysCeil(fetchSince, until);
  const gap = catchupSince != null && fetchSince != null && catchupSince < fetchSince
    ? { uncoveredSince: catchupSince, uncoveredUntil: fetchSince }
    : null;
  return { fetchSince, fetchDays, until, gap };
}

export function relevanceGapLimitation(gap, { fetchDays } = {}) {
  if (!gap) return null;
  const from = new Date(gap.uncoveredSince).toISOString();
  const until = new Date(gap.uncoveredUntil).toISOString();
  const days = fetchDays != null ? `last ${fetchDays} day(s)` : 'the configured horizon';
  return `fetched ${days}; catch-up ${from} → ${until} is uncovered`;
}

/**
 * Configured source age windows become a *minimum* fetch horizon in catch-up
 * mode (never an upper bound). Null stays unbounded.
 */
export function sourceHorizonMs(minDays, runStartedAt) {
  if (minDays == null || !(Number(minDays) > 0)) return null;
  return runStartedAt - Number(minDays) * DAY_MS;
}

/**
 * @param {object} input
 * @param {string|number|null} [input.coveredThrough]
 * @param {number} input.runStartedAt
 * @param {number} input.initialLookbackDays
 * @param {number} input.overlapHours
 * @param {number|null} [input.explicitSinceMs]
 * @param {number|null} [input.sourceHorizonMs]
 * @param {'since_last_success'|'fixed_window'} [input.mode]
 */
export function planUnitWindow({
  coveredThrough = null,
  runStartedAt,
  initialLookbackDays,
  overlapHours,
  explicitSinceMs = null,
  sourceHorizonMs: horizon = null,
  mode = 'since_last_success',
} = {}) {
  if (!Number.isFinite(runStartedAt)) throw new Error('runStartedAt must be a finite timestamp');

  if (mode === 'fixed_window') {
    const since = horizon;
    if (explicitSinceMs != null && since != null && explicitSinceMs > since) {
      throw new Error(
        `--since would skip outstanding coverage (computed lower bound is ${new Date(since).toISOString()})`,
      );
    }
    const effectiveSince = explicitSinceMs == null
      ? since
      : (since == null ? explicitSinceMs : Math.min(since, explicitSinceMs));
    return {
      since: effectiveSince,
      until: runStartedAt,
      unbounded: effectiveSince == null,
      bootstrap: coveredThrough == null,
      mode,
    };
  }

  const coveredMs = toEpoch(coveredThrough);
  const bootstrap = coveredMs == null;
  const base = coveredMs ?? (runStartedAt - initialLookbackDays * DAY_MS);
  const computedLower = base - overlapHours * HOUR_MS;

  if (explicitSinceMs != null && explicitSinceMs > computedLower) {
    throw new Error(
      `--since would skip outstanding coverage (computed lower bound is ${new Date(computedLower).toISOString()})`,
    );
  }

  let since = explicitSinceMs == null ? computedLower : Math.min(computedLower, explicitSinceMs);
  if (horizon != null && Number.isFinite(horizon)) since = Math.min(since, horizon);

  return {
    since,
    until: runStartedAt,
    unbounded: false,
    bootstrap,
    mode,
  };
}

export function validateCollection(collection = {}) {
  const problems = [];
  const mode = collection.mode ?? 'since_last_success';
  if (!COLLECTION_MODES.includes(mode)) {
    problems.push(`collection.mode must be ${COLLECTION_MODES.join(' or ')} (got ${JSON.stringify(mode)})`);
  }
  const lookback = collection.initial_lookback_days ?? 30;
  if (!(Number.isFinite(Number(lookback)) && Number(lookback) > 0)) {
    problems.push('collection.initial_lookback_days must be a finite positive number');
  }
  const overlap = collection.overlap_hours ?? 48;
  if (!(Number.isFinite(Number(overlap)) && Number(overlap) >= 0)) {
    problems.push('collection.overlap_hours must be a finite nonnegative number');
  }
  return problems;
}

export function collectionSettings(config = {}) {
  const raw = config.collection ?? {};
  return {
    mode: raw.mode ?? 'since_last_success',
    initialLookbackDays: Number(raw.initial_lookback_days ?? 30),
    overlapHours: Number(raw.overlap_hours ?? 48),
  };
}

/**
 * Plan one unit's window from the checkpoint stored under that unit's key.
 */
export function windowForUnit(key, {
  progress = {},
  runStartedAt,
  collection = {},
  explicitSinceMs = null,
  sourceHorizonMs: horizon = null,
} = {}) {
  return {
    key,
    ...planUnitWindow({
      coveredThrough: progress?.units?.[key]?.coveredThrough ?? null,
      runStartedAt,
      initialLookbackDays: collection.initialLookbackDays ?? collection.initial_lookback_days ?? 30,
      overlapHours: collection.overlapHours ?? collection.overlap_hours ?? 48,
      explicitSinceMs,
      sourceHorizonMs: horizon,
      mode: collection.mode ?? 'since_last_success',
    }),
  };
}

/**
 * Validate `--since` against the windows that will actually be fetched, and
 * return the summary interval (earliest since → run start). Only units in
 * `planned` participate; stored checkpoints for disabled or idle sources are
 * ignored.
 *
 * @param {{key: string, sourceHorizonMs?: number|null}[]} planned
 */
export function planRunWindows(planned, {
  progress = {},
  runStartedAt,
  collection = {},
  explicitSinceMs = null,
} = {}) {
  const byKey = new Map();
  for (const item of planned ?? []) {
    if (!item?.key || byKey.has(item.key)) continue;
    byKey.set(item.key, windowForUnit(item.key, {
      progress, runStartedAt, collection, explicitSinceMs,
      sourceHorizonMs: item.sourceHorizonMs ?? null,
    }));
  }
  if (byKey.size === 0) {
    return {
      windows: [],
      summary: {
        since: explicitSinceMs,
        until: runStartedAt,
        unbounded: explicitSinceMs == null,
      },
    };
  }
  const windows = [...byKey.values()];
  const dated = windows.filter((w) => w.since != null && Number.isFinite(w.since));
  return {
    windows,
    summary: {
      since: dated.length ? Math.min(...dated.map((w) => w.since)) : null,
      until: runStartedAt,
      unbounded: dated.length === 0,
    },
  };
}
