// Huntley board-collection facade for daily/fund/ATS lanes.
// Lanes call scanTracked / scanAtsSweep and receive { jobs, errors, stats }.
// Observations are persisted as each board finishes under data/collection/.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS, ensureDirs } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { localToday } from '../normalize.mjs';
import { scanBoards, recoverObservationJobs } from './boards/collect.mjs';
import { scanDirectory, SWEEP_ATS } from './boards/sweeps/directory.mjs';
import { ensureCollectionDirs, clearPreview, pruneCommittedObservations } from './boards/state.mjs';
import {
  loadWatchlist,
  watchlistEntries,
  portfolioBoardEntries,
  watchlistCompanyKeys as watchlistKeysFn,
} from './watchlist.mjs';

export { SWEEP_ATS };
export { loadWatchlist, watchlistEntries, portfolioBoardEntries };

let preview = null;

export function scanState() {
  return preview ?? { root: PATHS.collection, preview: false };
}

function startPreview() {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-dry-run-'));
  return { dir, root: join(dir, 'collection'), preview: true };
}

export function endScan() {
  if (preview?.dir) {
    clearPreview(preview.dir);
    rmSync(preview.dir, { recursive: true, force: true });
  }
  preview = null;
}

export function prepareScan(_preferences = {}, { dryRun = false } = {}) {
  ensureDirs();
  ensureCollectionDirs();
  endScan();
  if (dryRun) {
    preview = startPreview();
    ensureCollectionDirs(preview.root);
    log.debug(`dry run: collection observations write to ${preview.root}`);
  }
  return {
    companies: { count: watchlistEntries().length },
    boards: { count: portfolioBoardEntries().length },
  };
}

export async function watchlistCompanyKeys() {
  const { companyKey } = await import('../normalize.mjs');
  return watchlistKeysFn(companyKey);
}

/**
 * Scan a list of board entries; returns { jobs, errors, stats }.
 */
export async function scanTracked({
  label,
  entries = null,
  count = null,
  sinceDays = null,
  sinceMs = null,
  untilMs = null,
  now = undefined,
  freshness = 'inventory',
  unitKind = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
  dryRun = false,
  prefs = {},
  source = 'watchlist',
  watchlistKeys = null,
  fundKeys = null,
  concurrency = 6,
  signal = null,
  deadlineAt = null,
  timeoutMs = undefined,
  runId = null,
} = {}) {
  if (dryRun && !preview) preview = startPreview();
  const list = entries ?? [];
  const n = count ?? list.length;
  if (!n) {
    log.info(`  ${label}: nothing enabled`);
    return { jobs: [], errors: [], stats: { scanned: 0, found: 0, kept: 0, errors: 0 }, units: [] };
  }
  log.step(`scanning ${n} ${label}`);
  const result = await scanBoards(list, {
    lane: String(label).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'watchlist',
    sinceDays,
    sinceMs,
    untilMs,
    now,
    freshness,
    unitKind: unitKind ?? source,
    progress,
    collection,
    explicitSinceMs,
    prefs,
    source,
    dryRun,
    previewRoot: preview?.root ?? null,
    watchlistKeys,
    fundKeys,
    concurrency,
    today: localToday(),
    signal,
    deadlineAt,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    runId,
  });
  if (result.errors.length) {
    log.info(`  ${label}: ${result.stats.kept} kept, ${result.errors.length} board error(s)`);
    for (const e of result.errors.slice(0, 20)) log.debug(`    ${e.board}: ${e.message}`);
  } else {
    log.info(`  ${label}: ${result.stats.scanned} scanned, ${result.stats.found} found, ${result.stats.kept} kept`);
  }
  return result;
}

export async function scanAtsSweep({
  ats = null,
  sinceDays = 2,
  seeds = [],
  limit = null,
  dryRun = false,
  timeoutMinutes = 30,
  prefs = {},
  watchlistKeys = null,
  fundKeys = null,
  companies = null,
  signal = null,
  deadlineAt = null,
  runId = null,
  resume = true,
  http = null,
  stateRoot = undefined,
  now = undefined,
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
} = {}) {
  if (dryRun && !preview) preview = startPreview();
  if (!ats) throw new Error('scanAtsSweep requires an ats vendor id');
  log.step(`ATS sweep: ${ats} (last ${sinceDays}d${seeds?.length ? `, seeds: ${seeds.join(',')}` : ''})`);
  return scanDirectory({
    ats,
    sinceDays,
    now,
    sinceMs,
    untilMs,
    progress,
    collection,
    explicitSinceMs,
    seeds,
    limit,
    timeoutMinutes,
    dryRun,
    previewRoot: preview?.root ?? null,
    prefs,
    watchlistKeys,
    fundKeys,
    companies,
    signal,
    deadlineAt,
    runId,
    resume,
    http,
    ...(stateRoot !== undefined ? { stateRoot } : {}),
  });
}

/**
 * Recover jobs from prior unconsumed observations (not legacy career-ops TSV).
 */
export function collectRecoveryJobs({
  date = null,
  today = null,
  sinceDays = null,
  watchlistKeys = new Set(),
  fundKeys = new Map(),
  excludeRunIds = [],
} = {}) {
  return recoverObservationJobs({
    sinceDays,
    today: date ?? today ?? localToday(),
    watchlistKeys,
    fundKeys,
    root: preview?.root ?? PATHS.collection,
    excludeRunIds,
  });
}

export { pruneCommittedObservations };
