// Versioned rank-result cache.
//
// Keys are a deterministic hash of the exact candidate brief, rendered job
// input, CLI/provider+model, and prompt/schema version. Cache stores the base
// model score before the watchlist bonus. Heuristic fallbacks are never cached.
//
// Entries live under PATHS.cache/rank/ as content-addressed JSON files written
// via temp+rename so concurrent processes and interrupted runs cannot corrupt
// previously usable data.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { buildBrief, renderJob, PROMPT_VERSION } from './prompt.mjs';
import { sanitizeReason, REASON_MIN } from './validate.mjs';

export const CACHE_SCHEMA_VERSION = 1;

function rankCacheDir() {
  return join(PATHS.cache, 'rank');
}

export function ensureRankCacheDir() {
  mkdirSync(rankCacheDir(), { recursive: true });
}

/**
 * @param {object} job
 * @param {{prefs: object, cli: string, model: string|null|undefined}} ctx
 */
export function rankCacheKey(job, { prefs, cli, model }) {
  const brief = buildBrief(prefs);
  // The posting's id labels the rows the model echoes back; it does not change
  // the judgment, and the entry stores only the score and reason. Excluding it
  // lets the same role keep its score when a rerun assigns a different id.
  const rendered = renderJob(job).split('\n').filter((l) => !l.startsWith('id: ')).join('\n');
  const modelKey = model == null || model === '' ? '__default__' : String(model);
  const material = [
    `prompt:${PROMPT_VERSION}`,
    `schema:${CACHE_SCHEMA_VERSION}`,
    `cli:${cli}`,
    `model:${modelKey}`,
    'brief:',
    brief,
    'job:',
    rendered,
  ].join('\n');
  return createHash('sha256').update(material).digest('hex');
}

function entryPath(key) {
  return join(rankCacheDir(), `${key}.json`);
}

function isFresh(entry, ttlHours) {
  if (!entry?.createdAt) return false;
  const created = Date.parse(entry.createdAt);
  if (!Number.isFinite(created)) return false;
  return (Date.now() - created) <= ttlHours * 3_600_000;
}

function isValidCachedResult(entry) {
  if (!entry || entry.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (entry.promptVersion !== PROMPT_VERSION) return false;
  if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) return false;
  if (entry.score < 0 || entry.score > 5) return false;
  const why = sanitizeReason(entry.why);
  return why.length >= REASON_MIN;
}

/**
 * @returns {{score: number, why: string, evidenceLevel?: string, key: string}|null}
 */
export function readRankCache(key, { ttlHours = 168 } = {}) {
  const path = entryPath(key);
  if (!existsSync(path)) return null;
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isValidCachedResult(entry) || !isFresh(entry, ttlHours)) return null;
  return {
    score: entry.score,
    why: sanitizeReason(entry.why),
    evidenceLevel: entry.evidenceLevel ?? null,
    key,
    createdAt: entry.createdAt,
  };
}

/**
 * Persist a successful model result. Never call with heuristic fallbacks.
 */
export function writeRankCache(key, { score, why, evidenceLevel = null, cli, model }) {
  ensureRankCacheDir();
  const path = entryPath(key);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const entry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    score,
    why: sanitizeReason(why),
    evidenceLevel,
    cli,
    model: model ?? null,
    createdAt: new Date().toISOString(),
  };
  try {
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
