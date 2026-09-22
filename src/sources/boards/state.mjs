// Atomic collection observations under data/collection/.
// Board-level writes settle as each board finishes so a later lane crash
// cannot erase completed boards from the same run.
//
// Same-day retries use unique runIds so a later failed scan never overwrites
// an earlier successful observation for the same board.

import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { PATHS } from '../../lib/paths.mjs';
import { localToday } from '../../normalize.mjs';

export const COLLECTION_SCHEMA = 1;

export function collectionRoot(root = PATHS.collection) {
  return root;
}

export function observationsDir(root = PATHS.collection) {
  return join(collectionRoot(root), 'observations');
}

function safePart(s) {
  return String(s ?? 'x').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'x';
}

/** Stable collision-resistant board identity for filenames. */
export function observationBoardKey(entryOrKey) {
  const raw = (typeof entryOrKey === 'string'
    ? entryOrKey
    : String(entryOrKey?.careers_url || entryOrKey?.api || entryOrKey?.name || 'board'))
    .replace(/\/+$/, '')
    .toLowerCase();
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const hint = safePart(raw).slice(0, 40);
  return `${hint}_${hash}`;
}

/**
 * Unique collection invocation id. Never defaults to bare YYYY-MM-DD alone —
 * a same-day retry must not share a run directory with a prior attempt.
 */
export function newRunId(today = localToday()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${today}_${stamp}_${randomBytes(4).toString('hex')}`;
}

/**
 * @param {{runId: string, lane: string, boardKey: string, observedAt: string, jobs: object[], outcome: object}} obs
 * @param {{root?: string, dryRun?: boolean, previewRoot?: string|null}} [opts]
 */
export function writeBoardObservation(obs, { root = PATHS.collection, dryRun = false, previewRoot = null } = {}) {
  const base = dryRun && previewRoot ? previewRoot : root;
  const dir = join(observationsDir(base), safePart(obs.runId), safePart(obs.lane));
  mkdirSync(dir, { recursive: true });
  const boardPart = observationBoardKey(obs.boardKey);
  const file = join(dir, `${boardPart}.json`);
  // Never let a same-path retry erase a successful observation with an empty failure.
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      const prevKept = prev?.outcome?.ok !== false && (prev.jobs?.length ?? 0) > 0;
      const nextKept = obs.outcome?.ok !== false && (obs.jobs?.length ?? 0) > 0;
      if (prevKept && !nextKept) return file;
    } catch {
      /* rewrite corrupt */
    }
  }
  // Unique temp name so concurrent writers (or a crash mid-rename) cannot
  // clobber another board's temp or leave a shared `.tmp` ambiguous.
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = {
    schema: COLLECTION_SCHEMA,
    runId: obs.runId,
    lane: obs.lane,
    boardKey: obs.boardKey,
    observedAt: obs.observedAt,
    outcome: obs.outcome ?? {},
    jobs: obs.jobs ?? [],
  };
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file);
  return file;
}

/**
 * YYYY-MM-DD prefix from a run directory name (`2026-09-14_…` or bare date).
 * @param {string} name
 * @returns {string|null}
 */
export function runIdDate(name) {
  const m = String(name ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Delete observation run directories older than sinceDate, by directory name
 * only — never open/parse files just to decide they are stale.
 * @returns {{removed: number, paths: string[]}}
 */
export function pruneObservations({ sinceDate, root = PATHS.collection } = {}) {
  const dir = observationsDir(root);
  if (!existsSync(dir) || !sinceDate) return { removed: 0, paths: [] };
  const paths = [];
  for (const run of readdirSync(dir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const date = runIdDate(run.name);
    if (!date || date >= sinceDate) continue;
    const path = join(dir, run.name);
    rmSync(path, { recursive: true, force: true });
    paths.push(path);
  }
  return { removed: paths.length, paths };
}

/**
 * Delete observation folders whose run IDs are already in progress.committedRunIds.
 * Observations use the same run ID; committed ones may be removed.
 */
export function pruneCommittedObservations({ committedRunIds = [], root = PATHS.collection } = {}) {
  const dir = observationsDir(root);
  if (!existsSync(dir) || !committedRunIds.length) return { removed: 0, paths: [] };
  const committed = new Set();
  for (const id of committedRunIds) {
    if (!id) continue;
    committed.add(String(id));
    committed.add(safePart(id));
  }
  const paths = [];
  for (const run of readdirSync(dir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    if (!committed.has(run.name)) continue;
    const path = join(dir, run.name);
    rmSync(path, { recursive: true, force: true });
    paths.push(path);
  }
  return { removed: paths.length, paths };
}

/**
 * Load unconsumed observations. When sinceDate is omitted, every observation
 * is recovered regardless of age. Date filtering is opt-in for callers that
 * already know a committed prefix they can skip.
 * @param {{sinceDate?: string|null, root?: string, prune?: boolean}} opts
 */
export function loadObservations({ sinceDate = null, root = PATHS.collection, prune = false, excludeRunIds = [] } = {}) {
  if (prune && sinceDate) pruneObservations({ sinceDate, root });
  const dir = observationsDir(root);
  if (!existsSync(dir)) return [];
  const exclude = new Set();
  for (const id of excludeRunIds ?? []) {
    if (!id) continue;
    exclude.add(String(id));
    exclude.add(safePart(id));
  }
  const out = [];
  for (const run of readdirSync(dir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    if (exclude.has(run.name)) continue;
    const date = runIdDate(run.name);
    if (date && sinceDate && date < sinceDate) continue;
    const runDir = join(dir, run.name);
    for (const lane of readdirSync(runDir, { withFileTypes: true })) {
      if (!lane.isDirectory()) continue;
      const laneDir = join(runDir, lane.name);
      for (const file of readdirSync(laneDir)) {
        if (!file.endsWith('.json') || file.includes('.tmp')) continue;
        const path = join(laneDir, file);
        let doc;
        try {
          doc = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        if (doc?.schema !== COLLECTION_SCHEMA) continue;
        if (doc.observedAt && sinceDate && doc.observedAt < sinceDate) continue;
        if (doc.runId && (exclude.has(String(doc.runId)) || exclude.has(safePart(doc.runId)))) continue;
        out.push({ ...doc, _path: path });
      }
    }
  }
  return out;
}

/** Remove a dry-run preview tree. */
export function clearPreview(previewRoot) {
  if (previewRoot && existsSync(previewRoot)) rmSync(previewRoot, { recursive: true, force: true });
}

export function ensureCollectionDirs(root = PATHS.collection) {
  mkdirSync(observationsDir(root), { recursive: true });
  mkdirSync(join(root, 'sweeps'), { recursive: true });
  mkdirSync(join(root, 'cache'), { recursive: true });
}

export function sweepStatePaths(ats, root = PATHS.collection) {
  const base = join(root, 'sweeps', safePart(ats || 'all'));
  return {
    root: base,
    checkpoint: join(base, 'checkpoint.json'),
    deadBoards: join(base, 'dead-boards.tsv'),
    companyCache: join(root, 'cache', 'ats-companies'),
  };
}

/** Fingerprint a company directory so checkpoint resume invalidates on change. */
export function directoryFingerprint(companies) {
  const h = createHash('sha256');
  h.update(String(companies?.length ?? 0));
  h.update('\n');
  for (const c of companies ?? []) h.update(String(c));
  h.update('\n');
  return h.digest('hex').slice(0, 24);
}

export function loadCheckpoint(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function saveCheckpoint(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc));
  renameSync(tmp, file);
}

/** Clear a completed sweep so the next run starts fresh. */
export function clearCheckpoint(file) {
  if (existsSync(file)) rmSync(file, { force: true });
}

export { dirname };
