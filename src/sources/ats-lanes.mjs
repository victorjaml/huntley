// The ATS layer's two lanes: the downloaded dataset, and the active boards.

import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { prefilter } from '../rank/prefilter.mjs';
import { downloadDataset } from './ats-dataset.mjs';
import { resolveCompanyNames } from './board-names.mjs';
import { activeBoards } from './active-boards.mjs';
import { loadWatchlist } from './watchlist.mjs';
import { scanTracked, scanAtsSweep } from './board-collection.mjs';
import { boardHttp } from './boards/collect.mjs';
import { coverageUnit, unitKey } from '../state/coverage.mjs';
import { ageDaysCeil, windowForUnit, sourceHorizonMs } from '../state/window.mjs';

/** Merge structured fallback sweep results for runLanes health reporting. */
export function mergeFallbackSweeps(settled) {
  const jobs = [];
  const errors = [];
  const stats = {
    scanned: 0,
    boardsCompleted: 0,
    boardsFailed: 0,
    boardsAborted: 0,
    boardsIncomplete: 0,
    aborted: false,
    kept: 0,
  };
  for (const r of settled ?? []) {
    if (r.status !== 'fulfilled') {
      errors.push({
        board: 'fallback_sweep',
        type: 'lane_reject',
        message: String(r.reason?.message ?? r.reason ?? 'sweep rejected'),
      });
      stats.boardsFailed++;
      continue;
    }
    const v = r.value ?? {};
    jobs.push(...(Array.isArray(v.jobs) ? v.jobs : []));
    errors.push(...(Array.isArray(v.errors) ? v.errors : []));
    const s = v.stats ?? {};
    stats.scanned += Number(s.scanned ?? 0);
    stats.boardsCompleted += Number(s.boardsCompleted ?? 0);
    stats.boardsFailed += Number(s.boardsFailed ?? (Array.isArray(v.errors) ? v.errors.length : 0));
    stats.boardsAborted += Number(s.boardsAborted ?? 0);
    stats.boardsIncomplete = (stats.boardsIncomplete ?? 0) + Number(s.boardsIncomplete ?? 0);
    if (s.aborted) stats.aborted = true;
  }
  stats.kept = jobs.length;
  stats.errors = errors.length;
  return { jobs, errors, stats };
}

/**
 * Download the dataset, keep what passes the prefilter, and name its companies.
 * When the dataset is unreachable or stale, sweeps the fallback directories.
 */
export async function runDatasetLane({
  prefs,
  settings = {},
  sweep = {},
  dryRun = false,
  warn,
  watchlistKeys = null,
  downloadDatasetFn = downloadDataset,
  scanAtsSweepFn = scanAtsSweep,
  now = Date.now(),
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
  runId = null,
} = {}) {
  let data;
  try {
    data = await downloadDatasetFn({
      sinceDays: settings.since_days ?? 3,
      sinceMs,
      untilMs,
      now,
      ats: settings.ats ?? null,
      maxAgeHours: settings.max_age_hours ?? 48,
    });
  } catch (err) {
    data = { error: err.message, units: [{
      key: 'ats_dataset:manifest',
      requestedSince: sinceMs ? new Date(sinceMs).toISOString() : null,
      requestedUntil: new Date(untilMs ?? now).toISOString(),
      coveredThrough: null,
      status: 'failed',
      pagesFetched: 0,
      recordsFetched: 0,
      continuation: null,
      limitations: [],
      errors: [err.message],
    }] };
  }

  if (data.error || data.stale) {
    const why = data.error ? `could not be downloaded (${data.error})` : `was last rebuilt ${Math.round(data.ageHours)}h ago`;
    const fallback = settings.fallback_sweep ?? ['greenhouse', 'lever', 'ashby'];
    warn(`the ATS dataset ${why}; swept ${fallback.join(', ') || 'nothing'} directly instead`);
    const coveredAts = new Set(fallback.map((a) => String(a).toLowerCase()));
    const requestedAts = (settings.ats ?? []).map((a) => String(a).toLowerCase());
    const uncovered = requestedAts.filter((a) => !coveredAts.has(a));
    const swept = await Promise.allSettled(fallback.map((ats) => scanAtsSweepFn({
      ats,
      sinceDays: sweep.since_days ?? 2,
      sinceMs,
      untilMs,
      now,
      progress,
      collection,
      explicitSinceMs,
      runId,
      limit: sweep.limit ?? null,
      timeoutMinutes: sweep.timeout_minutes ?? 30,
      dryRun,
      prefs,
      watchlistKeys,
    }).catch((e) => { warn(e.message); return { jobs: [], errors: [{ board: ats, message: e.message, type: 'sweep_throw' }], stats: { scanned: 0, boardsCompleted: 0, boardsFailed: 1 }, units: [] }; })));
    const merged = mergeFallbackSweeps(swept);
    const fallbackUnits = swept.flatMap((r) => (r.status === 'fulfilled' ? (r.value.units ?? []) : []));
    const datasetUnits = [
      ...(data.units ?? []),
      ...uncovered.map((ats) => ({
        key: `ats_dataset:${ats}`,
        requestedSince: sinceMs ? new Date(sinceMs).toISOString() : null,
        requestedUntil: new Date(untilMs ?? now).toISOString(),
        coveredThrough: null,
        status: 'failed',
        pagesFetched: 0,
        recordsFetched: 0,
        continuation: null,
        limitations: ['fallback sweep did not cover this dataset provider'],
        errors: [],
      })),
    ];
    if (data.error) return { ...merged, units: [...datasetUnits, ...fallbackUnits] };
    const { kept } = prefilter(data.jobs, prefs);
    const http = boardHttp();
    const names = await resolveCompanyNames(kept, {
      http: { fetchJson: http.fetchJson, fetchTextHead: http.fetchTextHead },
      cachePath: PATHS.boardNames,
      budgetMs: (settings.name_budget_seconds ?? 90) * 1000,
    });
    const named = prefilter(kept, prefs).kept;
    log.info(`  ATS dataset: stale path — ${named.length} named + ${merged.jobs.length} from fallback sweeps`
      + ` (${names.resolved} named, ${names.unresolved} still named by slug)`);
    return {
      jobs: [...named, ...merged.jobs],
      errors: merged.errors,
      stats: {
        ...merged.stats,
        kept: named.length + merged.jobs.length,
      },
      units: [...datasetUnits, ...fallbackUnits],
    };
  }

  const { kept } = prefilter(data.jobs, prefs);
  const http = boardHttp();
  const names = await resolveCompanyNames(kept, {
    http: { fetchJson: http.fetchJson, fetchTextHead: http.fetchTextHead },
    cachePath: PATHS.boardNames,
    budgetMs: (settings.name_budget_seconds ?? 90) * 1000,
  });
  const namedByUrl = new Map(prefilter(kept, prefs).kept.map((j) => [j.url, j]));
  // Only survivors leave the lane. The dataset is the one source big enough
  // (hundreds of thousands of rows) that handing the raw sweep downstream
  // would land every one of them in raw.json and the roles store.
  const jobs = [...namedByUrl.values()];
  log.info(`  ATS dataset: ${data.total} roles, ${data.jobs.length} first seen in window, `
    + `${namedByUrl.size} pass your filters (${names.resolved} named, ${names.unresolved} still named by slug; rebuilt ${data.ageHours.toFixed(0)}h ago)`);
  return { jobs, units: data.units ?? [] };
}

/** Fetch every active board directly. */
export async function runActiveBoardsLane({
  prefs, settings = {}, today, dryRun = false, watchlistKeys = null,
  now, sinceMs = null, untilMs = null, progress = null, collection = null, explicitSinceMs = null, runId = null,
}) {
  const doc = loadWatchlist();
  const exclude = new Set((doc.tracked_companies ?? [])
    .filter((c) => c?.enabled !== false && c.careers_url)
    .map((c) => String(c.careers_url).replace(/\/+$/, '').toLowerCase()));
  const entries = activeBoards({ path: PATHS.activeBoards, withinDays: settings.within_days ?? 90, today, exclude });
  if (!entries.length) {
    log.info('  active boards: none yet — boards are added as they produce roles that pass your filters');
    return [];
  }
  const overdue = entries.filter((e) => e.overdue).length;
  if (overdue) log.info(`  active boards: ${overdue} overdue (idle longer than within_days) — scanning before eviction`);
  return scanTracked({
    label: 'active boards',
    entries: entries.map(({ name, careers_url, provider }) => (provider ? { name, careers_url, provider } : { name, careers_url })),
    sinceDays: settings.since_days ?? 3,
    sinceMs,
    untilMs,
    now,
    freshness: 'inventory',
    unitKind: 'active_boards',
    progress,
    collection,
    explicitSinceMs,
    runId,
    dryRun,
    prefs,
    source: 'active_boards',
    watchlistKeys,
  });
}

/**
 * Plan one catch-up window per configured country. A leftover US checkpoint
 * must not bootstrap Canada, and Canada must not inherit a recent US cutoff.
 */
export function planFreehireFeedWindows(settings = {}, {
  now = Date.now(),
  progress = null,
  collection = null,
  explicitSinceMs = null,
  sinceMs = null,
  untilMs = null,
} = {}) {
  const countries = settings.countries ?? ['us'];
  const horizon = sourceHorizonMs(settings.open_within_days ?? 2, now);
  const overlapHours = settings.overlap_hours ?? collection?.overlapHours ?? collection?.overlap_hours ?? 48;
  const windows = countries.map((country) => {
    const key = unitKey('freehire_feed', country);
    if (progress || collection) {
      return windowForUnit(key, {
        progress: progress ?? {},
        runStartedAt: now,
        collection: { ...(collection ?? {}), overlapHours },
        explicitSinceMs,
        sourceHorizonMs: horizon,
      });
    }
    return { key, since: sinceMs ?? (now - (settings.open_within_days ?? 2) * 86_400_000), until: untilMs ?? now };
  });
  const dated = windows.map((w) => w.since).filter((ms) => ms != null && Number.isFinite(ms));
  return {
    countries,
    windows,
    fetchSince: dated.length ? Math.min(...dated) : (sinceMs ?? null),
    fetchUntil: untilMs ?? now,
  };
}

/**
 * freehire's whole recent feed, filtered locally.
 */
export async function runFreehireFeedLane({
  prefs, settings = {}, now = Date.now(), sinceMs = null, untilMs = null,
  progress = null, collection = null, explicitSinceMs = null,
}) {
  const { readFreehireFeed, DEFAULT_EXCLUDE } = await import('./freehire-feed.mjs');
  const planned = planFreehireFeedWindows(settings, {
    now, progress, collection, explicitSinceMs, sinceMs, untilMs,
  });
  let passed = 0;
  const openWithinDays = planned.fetchSince != null
    ? ageDaysCeil(planned.fetchSince, planned.fetchUntil)
    : (settings.open_within_days ?? 2);
  const res = await readFreehireFeed({
    countries: planned.countries,
    openWithinDays,
    excludeSources: settings.exclude_sources ?? DEFAULT_EXCLUDE,
    keep: (jobs) => { const { kept } = prefilter(jobs, prefs); passed += kept.length; return kept; },
  });
  const withBoard = res.jobs.filter((j) => j.board).length;
  log.info(`  freehire feed: ${res.total} roles from ${res.sources} sources in ${res.requests} requests; ${passed} pass your filters, ${withBoard} with a board to read directly`);
  const capped = Boolean(res.capped);
  return {
    jobs: res.jobs,
    units: planned.windows.map((win) => coverageUnit({
      key: win.key,
      requestedSince: win.since ?? planned.fetchSince,
      requestedUntil: win.until ?? planned.fetchUntil,
      status: capped ? 'partial' : 'complete',
      // Partial but date-sorted: the checkpoint may advance to where the
      // capped groups' ascending reads stopped, so the next run resumes from
      // there (less the overlap) instead of re-bootstrapping the whole window.
      coveredThrough: capped ? res.coveredThrough ?? null : null,
      recordsFetched: res.total,
      pagesFetched: res.requests,
      limitations: capped
        ? [`freehire offset ceiling reached; covered through ${res.coveredThrough ?? 'an unknown point'}`]
        : [],
    })),
  };
}

/**
 * Job boards that aggregate many employers: Built In and Hacker News.
 */
export async function runJobBoardLane({
  prefs, which, boards, sinceDays = null, dryRun = false, watchlistKeys = null,
  now, sinceMs = null, untilMs = null, progress = null, collection = null, explicitSinceMs = null, runId = null,
}) {
  if (!boards.length) return [];
  return scanTracked({
    label: which === 'builtin' ? 'Built In boards' : 'Hacker News "Who is hiring?"',
    entries: boards,
    sinceDays,
    sinceMs,
    untilMs,
    now,
    freshness: which === 'hackernews' ? 'inventory' : 'window',
    unitKind: which,
    progress,
    collection,
    explicitSinceMs,
    runId,
    dryRun,
    prefs,
    source: which,
    watchlistKeys,
  });
}

/** Built In entries: one per city site (provider needs nested builtin host/categories). */
export function builtinBoards(settings = {}) {
  const categories = settings.categories ?? ['dev-engineering'];
  const max_pages = settings.max_pages ?? 4;
  return (settings.markets ?? []).map((host) => ({
    name: `Built In (${String(host).replace(/^www\./, '')})`,
    provider: 'builtin',
    enabled: true,
    builtin: { host, categories, max_pages },
    // Stable board key for observation persistence
    careers_url: `https://${String(host).replace(/^https?:\/\//, '')}/jobs`,
  }));
}
