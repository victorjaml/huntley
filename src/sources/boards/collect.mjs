// Board collection: scanBoards returns jobs in memory and persists per-board
// observations as each board settles.

import { makeHttpCtx, fetchJson, fetchText, fetchTextHead, sleep } from './http/http.mjs';
import { getProviders, resolveProvider } from './registry.mjs';
import { writeBoardObservation, ensureCollectionDirs, loadObservations, pruneObservations, pruneCommittedObservations, newRunId, observationBoardKey } from './state.mjs';
import { titleFilterFromPrefs, withinSince, withinWindow, postedAtIso } from './filters.mjs';
import { toJob, localToday, normalizeDescriptionText, companyKey } from '../../normalize.mjs';
import { log } from '../../lib/log.mjs';
import { PATHS } from '../../lib/paths.mjs';
import { coverageUnit, unitKey } from '../../state/coverage.mjs';
import { planUnitWindow, sourceHorizonMs } from '../../state/window.mjs';

/** Default wall-clock budget for an ordinary board lane (watchlist, etc.). */
export const DEFAULT_BOARD_LANE_TIMEOUT_MS = 30 * 60_000;

function boardIdentity(entry) {
  return String(entry?.careers_url || entry?.api || entry?.name || 'board')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function classifyError(err) {
  const msg = String(err?.message ?? err ?? '');
  const status = err?.status;
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (/timeout|aborted|AbortError|deadline/i.test(msg) || err?.name === 'AbortError') return 'timeout';
  if (/cannot derive|unknown provider|unsupported/i.test(msg)) return 'unsupported';
  if (typeof status === 'number' && status >= 500) return 'http_5xx';
  if (typeof status === 'number') return `http_${status}`;
  return 'fetch_error';
}

function deadlineReached(deadlineAt, signal) {
  if (signal?.aborted) return true;
  return deadlineAt != null && Date.now() >= deadlineAt;
}

/** Providers may return a partial page set after a mid-board error/abort. */
function resultMarkedIncomplete(rawJobs) {
  if (!Array.isArray(rawJobs)) return false;
  return Boolean(
    rawJobs.incomplete
    || rawJobs.truncated
    || rawJobs.workdayTruncated,
  );
}

function bindHttpBudget(http, signal, deadlineAt) {
  const budget = { signal, deadlineAt };
  return {
    ...http,
    signal,
    deadlineAt,
    sleep: (ms) => sleep(ms, budget),
    fetchJson: (url, opts = {}) => (http.fetchJson || fetchJson)(url, {
      ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
    }),
    fetchText: (url, opts = {}) => (http.fetchText || fetchText)(url, {
      ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
    }),
    fetchTextHead: (url, opts = {}) => (http.fetchTextHead || fetchTextHead)(url, {
      ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
    }),
    fetchResponse: http.fetchResponse
      ? (url, opts = {}) => http.fetchResponse(url, {
        ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
      })
      : undefined,
  };
}

/**
 * Run providers over board entries with bounded concurrency.
 *
 * @param {object[]} entries
 * @param {object} opts
 * @returns {Promise<{jobs: object[], errors: object[], stats: object}>}
 */
export async function scanBoards(entries, {
  lane = 'boards',
  signal = null,
  deadlineAt = null,
  concurrency = 6,
  sinceDays = null,
  sinceMs = null,
  untilMs = null,
  now = Date.now(),
  freshness = 'window',
  unitKind = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
  today = localToday(),
  http = null,
  prefs = {},
  source = 'watchlist',
  sourceDetailPrefix = null,
  runId = null,
  dryRun = false,
  previewRoot = null,
  stateRoot = PATHS.collection,
  watchlistKeys = null,
  fundKeys = null,
  onBoardDone = null,
  timeoutMs = DEFAULT_BOARD_LANE_TIMEOUT_MS,
  /** Optional provider map override (tests). */
  providers: providersOverride = null,
} = {}) {
  ensureCollectionDirs(dryRun && previewRoot ? previewRoot : stateRoot);
  const invocationId = runId || newRunId(today);
  const providers = providersOverride ?? getProviders();
  const titleOk = titleFilterFromPrefs(prefs);
  const effectiveDeadline = deadlineAt ?? (timeoutMs != null ? now + timeoutMs : null);
  const coll = collection ?? { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const settings = {
    mode: coll.mode ?? 'since_last_success',
    initialLookbackDays: coll.initialLookbackDays ?? coll.initial_lookback_days ?? 30,
    overlapHours: coll.overlapHours ?? coll.overlap_hours ?? 48,
  };

  // Own abort controller linked to caller signal + deadline, so in-flight HTTP
  // cancels when the lane budget expires.
  const local = new AbortController();
  let deadlineTimer = null;
  if (effectiveDeadline != null) {
    const ms = Math.max(0, effectiveDeadline - now);
    deadlineTimer = setTimeout(() => local.abort(), ms);
  }
  const onExternalAbort = () => local.abort();
  if (signal) {
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const baseHttp = http
    ? bindHttpBudget(http, local.signal, effectiveDeadline)
    : makeHttpCtx({ signal: local.signal, deadlineAt: effectiveDeadline });

  const laneSinceMs = sinceMs ?? (sinceDays != null && sinceDays > 0 ? now - sinceDays * 86_400_000 : null);
  const laneUntilMs = untilMs ?? now;
  const ctx = { ...baseHttp, sinceMs: freshness === 'inventory' ? null : laneSinceMs, includeUndated: true, signal: local.signal, deadlineAt: effectiveDeadline, now };

  const jobs = [];
  const captured = [];
  const units = [];
  const errors = [];
  const stats = {
    scanned: 0, found: 0, kept: 0, filteredTitle: 0, filteredSince: 0,
    boardsCompleted: 0, boardsFailed: 0, boardsAborted: 0, boardsIncomplete: 0,
    errors: 0, aborted: false, runId: invocationId,
  };

  const list = [...(entries ?? [])];
  let idx = 0;
  const seenIndexes = new Set();

  function boardWindow(entry) {
    const kind = unitKind || source || lane;
    const key = unitKey(kind, boardIdentity(entry));
    const covered = progress?.units?.[key]?.coveredThrough ?? null;
    const horizon = sourceHorizonMs(sinceDays, now);
    try {
      return {
        key,
        ...planUnitWindow({
          coveredThrough: covered,
          runStartedAt: now,
          initialLookbackDays: settings.initialLookbackDays,
          overlapHours: settings.overlapHours,
          explicitSinceMs,
          sourceHorizonMs: horizon,
          mode: settings.mode,
        }),
      };
    } catch {
      return { key, since: laneSinceMs, until: laneUntilMs, unbounded: laneSinceMs == null };
    }
  }

  function recordBoardUnit(entry, { status, recordsFetched = 0, errors: unitErrors = [], limitations = [], providerId = null }) {
    const win = boardWindow(entry);
    const until = win.until ?? laneUntilMs;
    const extra = [];
    if ((providerId ?? entry.provider) === 'hackernews') {
      extra.push('hackernews: current monthly thread only; earlier threads in the requested interval are not enumerated');
    }
    units.push(coverageUnit({
      key: win.key,
      requestedSince: win.unbounded ? null : (win.since ?? laneSinceMs),
      requestedUntil: until,
      coveredThrough: status === 'complete' ? until : null,
      status,
      recordsFetched,
      limitations: [
        ...(freshness === 'inventory' ? ['current-inventory source: closed postings between runs are not recoverable'] : []),
        ...extra,
        ...limitations,
      ],
      errors: unitErrors,
    }));
  }

  async function one(entry, entryIndex) {
    if (deadlineReached(effectiveDeadline, local.signal)) {
      stats.aborted = true;
      return;
    }
    seenIndexes.add(entryIndex);

    stats.scanned++;
    const key = boardIdentity(entry);
    const resolved = resolveProvider(entry, providers);
    if (!resolved || resolved.error) {
      const err = {
        lane,
        board: entry.name ?? key,
        provider: entry.provider ?? null,
        type: 'unsupported',
        message: resolved?.error ?? `no provider for ${entry.name ?? key}`,
        entryIndex,
      };
      errors.push(err);
      stats.boardsFailed++;
      writeBoardObservation({
        runId: invocationId, lane, boardKey: key, observedAt: today,
        jobs: [],
        outcome: { ok: false, ...err },
      }, { root: stateRoot, dryRun, previewRoot });
      recordBoardUnit(entry, { status: 'unsupported', errors: [err.message] });
      onBoardDone?.({ ...err, entryIndex, completed: true });
      return;
    }

    const { provider } = resolved;
    let rawJobs = [];
    try {
      if (deadlineReached(effectiveDeadline, local.signal)) {
        stats.aborted = true;
        stats.boardsAborted++;
        recordBoardUnit(entry, { status: 'partial', errors: ['aborted at collection deadline'] });
        onBoardDone?.({ board: entry.name, entryIndex, completed: false, aborted: true });
        return;
      }
      rawJobs = await provider.fetch(entry, ctx);
      if (!Array.isArray(rawJobs)) throw new Error(`${provider.id}: fetch() did not return an array`);
    } catch (e) {
      const type = classifyError(e);
      // Deadline abort after dispatch: do not persist an empty failure that
      // would look like a completed board outcome for this invocation.
      if (type === 'timeout' && deadlineReached(effectiveDeadline, local.signal)) {
        stats.aborted = true;
        stats.boardsAborted++;
        recordBoardUnit(entry, { status: 'partial', errors: ['aborted at collection deadline'] });
        onBoardDone?.({ board: entry.name, entryIndex, completed: false, aborted: true });
        return;
      }
      const err = {
        lane,
        board: entry.name ?? key,
        provider: provider.id,
        type,
        message: String(e?.message ?? e).slice(0, 300),
        entryIndex,
      };
      errors.push(err);
      stats.boardsFailed++;
      writeBoardObservation({
        runId: invocationId, lane, boardKey: key, observedAt: today,
        jobs: [],
        outcome: { ok: false, status: e?.status ?? null, ...err },
      }, { root: stateRoot, dryRun, previewRoot });
      recordBoardUnit(entry, { status: 'failed', errors: [err.message] });
      onBoardDone?.({ ...err, entryIndex, completed: true });
      return;
    }

    // Providers (getro/workday/phenom/…) may swallow a mid-pagination abort or
    // error and return the pages already fetched. Keep those jobs, but never
    // treat the board as fully complete — checkpoints must not advance past it.
    const cancelledAfterFetch = deadlineReached(effectiveDeadline, local.signal);
    const incomplete = cancelledAfterFetch || resultMarkedIncomplete(rawJobs);

    stats.found += rawJobs.length;
    const kept = [];
    const win = boardWindow(entry);
    for (const raw of rawJobs) {
      if (!titleOk(raw.title || '')) {
        stats.filteredTitle++;
        captured.push({ ...raw, filterReason: 'title' });
        continue;
      }
      const inWindow = freshness === 'inventory' || win.unbounded
        || withinWindow(raw.postedAt, win.since ?? laneSinceMs, win.until ?? laneUntilMs)
        || withinSince(raw.postedAt, sinceDays, now);
      if (!inWindow) {
        stats.filteredSince++;
        captured.push({ ...raw, filterReason: 'window' });
        continue;
      }
      const company = raw.company || entry.name || '';
      const ck = companyKey(company);
      const onWatchlist = watchlistKeys?.has(ck) ?? false;
      const funds = fundKeys?.get(ck);
      const detail = sourceDetailPrefix
        ? `${sourceDetailPrefix} · ${provider.id}`
        : (funds ? `${[...funds].join(', ')} · ${provider.id}` : provider.id);
      const job = toJob({
        url: raw.url,
        title: raw.title,
        company,
        location: raw.location || '',
        postedAt: postedAtIso(raw.postedAt),
        fingerprint: raw.fingerprint || null,
        firstSeen: today,
        watchlist: onWatchlist,
        source: onWatchlist ? 'watchlist' : (funds ? 'portfolio' : source),
        sourceDetail: detail,
        description: raw.description ? normalizeDescriptionText(raw.description) : null,
      });
      if (!job) continue;
      if (raw.description) {
        job.descriptionOrigin = 'provider';
        job.evidenceLevel = 'description';
      }
      kept.push(job);
      captured.push(job);
    }

    stats.kept += kept.length;
    jobs.push(...kept);

    if (incomplete) {
      if (cancelledAfterFetch) {
        stats.aborted = true;
        stats.boardsAborted++;
      } else {
        stats.boardsIncomplete++;
        errors.push({
          lane,
          board: entry.name ?? key,
          provider: provider.id,
          type: 'incomplete',
          message: `${provider.id}: returned a partial board after an error`,
          entryIndex,
        });
      }
      writeBoardObservation({
        runId: invocationId, lane, boardKey: key, observedAt: today,
        jobs: kept,
        outcome: {
          ok: true,
          incomplete: true,
          aborted: cancelledAfterFetch,
          provider: provider.id,
          found: rawJobs.length,
          kept: kept.length,
        },
      }, { root: stateRoot, dryRun, previewRoot });
      recordBoardUnit(entry, {
        status: 'partial',
        recordsFetched: rawJobs.length,
        errors: [cancelledAfterFetch ? 'aborted at collection deadline' : 'provider returned a partial board'],
      });
      onBoardDone?.({
        board: entry.name,
        provider: provider.id,
        kept: kept.length,
        entryIndex,
        completed: false,
        aborted: cancelledAfterFetch,
        incomplete: true,
      });
      return;
    }

    stats.boardsCompleted++;
    writeBoardObservation({
      runId: invocationId, lane, boardKey: key, observedAt: today,
      jobs: kept,
      outcome: { ok: true, provider: provider.id, found: rawJobs.length, kept: kept.length },
    }, { root: stateRoot, dryRun, previewRoot });
    recordBoardUnit(entry, { status: 'complete', recordsFetched: rawJobs.length, providerId: provider.id });
    onBoardDone?.({ board: entry.name, provider: provider.id, kept: kept.length, entryIndex, completed: true });
  }

  try {
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, async () => {
      while (idx < list.length) {
        if (deadlineReached(effectiveDeadline, local.signal)) {
          stats.aborted = true;
          break;
        }
        const i = idx++;
        await one(list[i], i);
      }
    });
    await Promise.all(workers);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  for (let i = 0; i < list.length; i++) {
    if (seenIndexes.has(i)) continue;
    recordBoardUnit(list[i], { status: 'failed', errors: ['not scanned before collection deadline'] });
  }

  stats.errors = errors.length;
  return { jobs, errors, stats, units, captured };
}

/**
 * Merge prior unconsumed observations into a job list (recovery).
 * Across same-day retries, keep jobs from any successful observation; empty
 * failure outcomes do not erase earlier successes for the same URL.
 */
export function recoverObservationJobs({
  sinceDays = null,
  today = localToday(),
  root = PATHS.collection,
  watchlistKeys = new Set(),
  fundKeys = new Map(),
  excludeRunIds = [],
} = {}) {
  const sinceDate = sinceDays != null
    ? new Date(Date.parse(`${today}T12:00:00Z`) - sinceDays * 86_400_000).toISOString().slice(0, 10)
    : null;
  const rows = loadObservations({ sinceDate, root, prune: false, excludeRunIds });
  // Deduplicate by job URL: prefer newest observation that still has the job.
  const byUrl = new Map();
  for (const row of rows) {
    const success = row.outcome?.ok !== false;
    for (const j of row.jobs ?? []) {
      if (!j?.url || !j?.title) continue;
      if (!success && !(row.jobs?.length)) continue;
      const prev = byUrl.get(j.url);
      if (!prev || String(row.observedAt) >= String(prev.observedAt)) {
        byUrl.set(j.url, { job: j, observedAt: row.observedAt, lane: row.lane });
      }
    }
  }

  const jobs = [];
  for (const { job: j, observedAt, lane } of byUrl.values()) {
    const ck = j.companyKey || companyKey(j.company);
    const onWatchlist = watchlistKeys.has(ck) || j.watchlist;
    const funds = fundKeys.get(ck);
    const job = toJob({
      ...j,
      firstSeen: j.firstSeen || observedAt || today,
      watchlist: onWatchlist,
      source: j.source || (onWatchlist ? 'watchlist' : funds ? 'portfolio' : 'recovery'),
      sourceDetail: j.sourceDetail || (funds ? funds.join(', ') : lane),
    });
    if (job) {
      if (j.evidenceLevel) job.evidenceLevel = j.evidenceLevel;
      if (j.descriptionOrigin) job.descriptionOrigin = j.descriptionOrigin;
      jobs.push(job);
    }
  }
  const recoveredRunIds = [...new Set(rows.map((row) => row.runId).filter(Boolean))];
  if (jobs.length) log.info(`  recovery: ${jobs.length} job(s) from prior collection observations`);
  return { jobs, recoveredRunIds };
}

/** Shared HTTP surface for funds / board naming. */
export function boardHttp(opts = {}) {
  const ctx = makeHttpCtx(opts);
  return { fetchJson: ctx.fetchJson, fetchText: ctx.fetchText, fetchTextHead: ctx.fetchTextHead, ...ctx };
}

export { newRunId, observationBoardKey, pruneObservations, pruneCommittedObservations };
