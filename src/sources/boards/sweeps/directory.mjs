// ATS directory sweeps (Greenhouse / Lever / Ashby / Workday / iCIMS).
// Returns jobs directly; persists checkpoints and dead-board state under data/collection/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHttpCtx, fetchJson, sleep } from '../http/http.mjs';
import { getProviders } from '../registry.mjs';
import { scanBoards } from '../collect.mjs';
import {
  ensureCollectionDirs,
  sweepStatePaths,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  directoryFingerprint,
  newRunId,
} from '../state.mjs';
import {
  loadDeadBoards, saveDeadBoards, shouldSkipDeadBoard, recordBoardResult, boardKey as deadBoardKey,
} from './dead-boards.mjs';
import { localToday } from '../../../normalize.mjs';
import { log } from '../../../lib/log.mjs';
import { PATHS } from '../../../lib/paths.mjs';

const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function entryOnHost(name, careersUrl, isCanonicalHost) {
  try {
    const host = new URL(careersUrl).hostname.toLowerCase();
    if (!isCanonicalHost(host)) return null;
  } catch {
    return null;
  }
  return { name: String(name), careers_url: careersUrl };
}

export const SWEEP_SOURCES = {
  greenhouse: {
    dataset: `${DATASET_BASE}/greenhouse_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, (h) => h === 'job-boards.greenhouse.io')
      : null,
  },
  lever: {
    dataset: `${DATASET_BASE}/lever_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, (h) => h === 'jobs.lever.co')
      : null,
  },
  ashby: {
    dataset: `${DATASET_BASE}/ashby_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, (h) => h === 'jobs.ashbyhq.com')
      : null,
  },
  workday: {
    dataset: `${DATASET_BASE}/workday_companies.json`,
    toEntry: (line) => {
      const [tenant, instance, site] = String(line).split('|');
      if (![tenant, instance, site].every((p) => p && SLUG_RE.test(p))) return null;
      return entryOnHost(
        tenant,
        `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
        (h) => h === `${tenant}.${instance}.myworkdayjobs.com` && h.endsWith('.myworkdayjobs.com'),
      );
    },
  },
  icims: {
    dataset: `${DATASET_BASE}/icims_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://careers-${slug}.icims.com/jobs/search?ss=1&in_iframe=1`, (h) => h === `careers-${String(slug).toLowerCase()}.icims.com`)
      : null,
  },
};

export const SWEEP_ATS = Object.keys(SWEEP_SOURCES);

function bindSweepHttp(http, signal, deadlineAt) {
  const budget = { signal, deadlineAt };
  return {
    ...http,
    signal,
    deadlineAt,
    sleep: (ms) => sleep(ms, budget),
    fetchJson: (url, opts = {}) => (http.fetchJson || fetchJson)(url, {
      ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
    }),
    fetchText: http.fetchText
      ? (url, opts = {}) => http.fetchText(url, {
        ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
      })
      : undefined,
    fetchTextHead: http.fetchTextHead
      ? (url, opts = {}) => http.fetchTextHead(url, {
        ...opts, signal: opts.signal ?? signal, deadlineAt: opts.deadlineAt ?? deadlineAt,
      })
      : undefined,
  };
}

async function loadCompanyList(ats, http, cacheDir) {
  const src = SWEEP_SOURCES[ats];
  if (!src) throw new Error(`unknown ATS sweep: ${ats}`);
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${ats}_companies.json`);
  if (existsSync(cacheFile)) {
    const st = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (st.fetchedAt && Date.now() - Date.parse(st.fetchedAt) < CACHE_TTL_MS && Array.isArray(st.companies)) {
      return st.companies;
    }
  }
  const companies = await http.fetchJson(src.dataset, { timeoutMs: 120_000 });
  const list = Array.isArray(companies) ? companies : (companies?.companies ?? []);
  writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), companies: list }));
  return list;
}

/**
 * Sweep one ATS public company directory.
 *
 * Checkpoint index advances only through a contiguous completed prefix.
 * A finished sweep clears the checkpoint. Resume is bound to directoryFingerprint.
 *
 * @returns {Promise<{jobs: object[], errors: object[], stats: object, checkpoint: object|null}>}
 */
export async function scanDirectory({
  ats,
  seeds = [],
  limit = null,
  sinceDays = 2,
  prefs = {},
  today = localToday(),
  concurrency = 4,
  signal = null,
  deadlineAt = null,
  dryRun = false,
  previewRoot = null,
  stateRoot = PATHS.collection,
  runId = null,
  resume = true,
  timeoutMinutes = 30,
  http = null,
  watchlistKeys = null,
  fundKeys = null,
  /** Inject a company list (tests); skips remote/cache dataset fetch. */
  companies: companiesOverride = null,
  now = Date.now(),
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
} = {}) {
  if (!ats || !SWEEP_SOURCES[ats]) throw new Error(`scanDirectory requires ats in ${SWEEP_ATS.join(', ')}`);
  ensureCollectionDirs(dryRun && previewRoot ? previewRoot : stateRoot);
  const paths = sweepStatePaths(ats, dryRun && previewRoot ? previewRoot : stateRoot);
  mkdirSync(paths.root, { recursive: true });

  // Start the sweep budget before the company-directory download so a slow
  // dataset fetch cannot silently consume the whole lane timeout.
  const laneDeadline = deadlineAt ?? (Date.now() + timeoutMinutes * 60_000);
  const sweepAbort = new AbortController();
  let deadlineTimer = null;
  if (laneDeadline != null) {
    deadlineTimer = setTimeout(() => sweepAbort.abort(), Math.max(0, laneDeadline - Date.now()));
  }
  const onExternalAbort = () => sweepAbort.abort();
  if (signal) {
    if (signal.aborted) sweepAbort.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const baseHttp = http
    ? bindSweepHttp(http, sweepAbort.signal, laneDeadline)
    : makeHttpCtx({ signal: sweepAbort.signal, deadlineAt: laneDeadline });

  void getProviders();

  const jobs = [];
  const units = [];
  const errors = [];
  const stats = {
    ats,
    companies: 0,
    scanned: 0,
    kept: 0,
    boardsCompleted: 0,
    boardsFailed: 0,
    boardsAborted: 0,
    boardsIncomplete: 0,
    aborted: false,
    startedAt: 0,
  };

  try {
    let companies;
    try {
      companies = companiesOverride != null
        ? [...companiesOverride]
        : await loadCompanyList(ats, baseHttp, paths.companyCache);
    } catch (err) {
      if (sweepAbort.signal.aborted || err?.name === 'AbortError' || /deadline|Aborted/i.test(String(err?.message ?? ''))) {
        stats.aborted = true;
        const checkpoint = dryRun ? null : loadCheckpoint(paths.checkpoint);
        log.info(`  ATS sweep ${ats}: aborted before board scan (${err?.message ?? err})`);
        return { jobs, errors, stats: { ...stats, cursor: 0, complete: false }, checkpoint };
      }
      throw err;
    }
    if (limit && Number.isFinite(limit)) companies = companies.slice(0, limit);

    for (const seed of seeds ?? []) {
      const entry = SWEEP_SOURCES[ats].toEntry(seed);
      if (entry) companies.push(seed);
    }

    stats.companies = companies.length;

    const fingerprint = directoryFingerprint(companies);
    let cursor = 0;
    const cp = resume ? loadCheckpoint(paths.checkpoint) : null;
    if (
      cp
      && cp.ats === ats
      && cp.directoryFingerprint === fingerprint
      && Number.isInteger(cp.index)
      && cp.index >= 0
      && cp.index < companies.length
    ) {
      cursor = cp.index;
    }
    stats.startedAt = cursor;

    const dead = loadDeadBoards(paths.deadBoards);
    const skipped = new Set();
    const entries = [];
    for (let i = cursor; i < companies.length; i++) {
      const raw = companies[i];
      const entry = SWEEP_SOURCES[ats].toEntry(raw);
      if (!entry) {
        skipped.add(i);
        continue;
      }
      entry.provider = ats;
      const bk = deadBoardKey(entry);
      if (shouldSkipDeadBoard(dead, ats, bk)) {
        skipped.add(i);
        continue;
      }
      entries.push({ entry, index: i, board: bk });
    }

    const invocationId = runId || newRunId(today);
    const finished = new Set();

    const advanceAndSave = () => {
      while (cursor < companies.length && (finished.has(cursor) || skipped.has(cursor))) cursor++;
      if (dryRun) return;
      if (cursor >= companies.length) {
        clearCheckpoint(paths.checkpoint);
        saveDeadBoards(paths.deadBoards, dead);
        return;
      }
      saveCheckpoint(paths.checkpoint, {
        ats,
        index: cursor,
        directoryFingerprint: fingerprint,
        updatedAt: new Date().toISOString(),
      });
      saveDeadBoards(paths.deadBoards, dead);
    };

    // Pre-advance over leading skipped indices so resume doesn't re-sit on them.
    advanceAndSave();

    if (sweepAbort.signal.aborted || Date.now() >= laneDeadline) {
      stats.aborted = true;
    }

    const chunkSize = Math.max(concurrency * 2, 8);
    for (let offset = 0; offset < entries.length; offset += chunkSize) {
      if (sweepAbort.signal.aborted || Date.now() >= laneDeadline) {
        stats.aborted = true;
        break;
      }
      const chunk = entries.slice(offset, offset + chunkSize);
      const result = await scanBoards(chunk.map((c) => c.entry), {
        lane: `ats_sweep_${ats}`,
        concurrency,
        sinceDays,
        sinceMs,
        untilMs,
        now,
        freshness: 'inventory',
        unitKind: `ats_sweep:${ats}`,
        progress,
        collection,
        explicitSinceMs,
        today,
        prefs,
        source: 'ats_sweep',
        runId: invocationId,
        dryRun,
        previewRoot,
        stateRoot,
        signal: sweepAbort.signal,
        deadlineAt: laneDeadline,
        timeoutMs: null, // laneDeadline owns the budget
        watchlistKeys,
        fundKeys,
        http: baseHttp,
        onBoardDone: (info) => {
          // Only fully completed boards advance the checkpoint. Incomplete /
          // aborted boards must be retried on the next sweep.
          if (info?.completed && Number.isInteger(info.entryIndex) && chunk[info.entryIndex]) {
            finished.add(chunk[info.entryIndex].index);
            advanceAndSave();
          }
          if (info?.type === 'not_found' && Number.isInteger(info.entryIndex) && chunk[info.entryIndex]) {
            recordBoardResult(dead, ats, chunk[info.entryIndex].board, 404);
          } else if (info?.completed && info?.kept != null && Number.isInteger(info.entryIndex) && chunk[info.entryIndex]) {
            recordBoardResult(dead, ats, chunk[info.entryIndex].board, 200);
          }
        },
      });
      jobs.push(...result.jobs);
      errors.push(...result.errors);
      units.push(...(result.units ?? []));
      stats.scanned += result.stats.scanned;
      stats.kept += result.stats.kept;
      stats.boardsCompleted += result.stats.boardsCompleted ?? 0;
      stats.boardsFailed += result.stats.boardsFailed ?? 0;
      stats.boardsAborted += result.stats.boardsAborted ?? 0;
      stats.boardsIncomplete += result.stats.boardsIncomplete ?? 0;
      if (result.stats.aborted) stats.aborted = true;
      advanceAndSave();
    }

    if (!stats.aborted && (sweepAbort.signal.aborted || Date.now() >= laneDeadline) && cursor < companies.length) {
      stats.aborted = true;
    }

    const complete = cursor >= companies.length;
    if (complete && !dryRun) clearCheckpoint(paths.checkpoint);

    const checkpoint = dryRun ? null : loadCheckpoint(paths.checkpoint);
    log.info(`  ATS sweep ${ats}: scanned ${stats.scanned}, kept ${stats.kept}, errors ${errors.length}`
      + (complete ? ' (complete)' : ` (resume at ${cursor})`)
      + (stats.aborted ? ', aborted' : ''));
    return { jobs, errors, stats: { ...stats, cursor, complete }, checkpoint, units };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
