// Optional description enrichment after prefilter/company caps and before
// rank-cache lookup. Fetches at most max_jobs missing descriptions among
// model-budget-eligible roles. Existing descriptions are never overwritten
// with empty results. Failures leave the job eligible for metadata-only ranking.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { canonicalUrl, normalizeDescriptionText } from '../normalize.mjs';
import { ADAPTER_VERSION, fetchJobDescription, parseAtsTarget } from './enrichment/adapters.mjs';

const FAIL_TTL_MS = 3_600_000;

function enrichmentCacheDir() {
  return join(PATHS.cache, 'descriptions');
}

function cacheKey(job) {
  const target = parseAtsTarget(job);
  const basis = target
    ? `${target.vendor}:${target.org}:${target.req}:${ADAPTER_VERSION}`
    : `url:${canonicalUrl(job.url)}:${ADAPTER_VERSION}`;
  return createHash('sha256').update(basis).digest('hex');
}

function cachePath(key) {
  return join(enrichmentCacheDir(), `${key}.json`);
}

function readCache(key) {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, entry) {
  mkdirSync(enrichmentCacheDir(), { recursive: true });
  const path = cachePath(key);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function isFreshSuccess(entry, ttlHours) {
  if (!entry?.ok || !entry.description) return false;
  const at = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(at)) return false;
  return (Date.now() - at) <= ttlHours * 3_600_000;
}

function isFreshFailure(entry) {
  if (!entry || entry.ok !== false) return false;
  const at = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(at)) return false;
  return (Date.now() - at) <= FAIL_TTL_MS;
}

function attachEvidence(job, { description, origin, fetchedAt, enrichmentOutcome }) {
  const next = {
    ...job,
    description: normalizeDescriptionText(description),
    descriptionOrigin: origin,
    descriptionFetchedAt: fetchedAt,
    evidenceLevel: 'description',
    enrichmentOutcome,
  };
  return next;
}

function metadataOnly(job, enrichmentOutcome = null) {
  if (job.description) {
    return {
      ...job,
      evidenceLevel: job.evidenceLevel ?? 'description',
      descriptionOrigin: job.descriptionOrigin ?? 'collection',
      enrichmentOutcome: enrichmentOutcome ?? job.enrichmentOutcome ?? 'already_present',
    };
  }
  return {
    ...job,
    evidenceLevel: 'metadata_only',
    enrichmentOutcome: enrichmentOutcome ?? 'skipped_unsupported',
  };
}

/**
 * Enrich jobs that lack descriptions, within budgets.
 *
 * `max_llm` is applied by position in the same order ranking will see: the
 * first N roles are in scope (null = all). Roles already described or on
 * unsupported hosts still occupy those slots, so enrichment never fetches
 * past ranking's cutoff. Rank-cache hits are unknown here and may reduce
 * how many of those N actually need a model call later.
 *
 * @param {object[]} jobs  survivors of prefilter + company cap, heuristic order
 * @param {object} config  enrichment config block
 * @param {{maxLlm?: number|null, fetchImpl?: typeof fetch}} [opts]
 */
export async function enrichDescriptions(jobs, config = {}, opts = {}) {
  const started = Date.now();
  const enabled = config.enabled !== false;
  const maxJobs = Number(config.max_jobs ?? 100);
  const concurrency = Math.max(1, Math.min(8, Number(config.concurrency ?? 4) || 4));
  const requestTimeoutMs = Math.max(1, Number(config.request_timeout_ms ?? 10_000) || 10_000);
  const totalTimeoutMs = Math.max(1, Number(config.total_timeout_ms ?? 60_000) || 60_000);
  const ttlHours = Number(config.cache_ttl_hours ?? 24);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxLlm = opts.maxLlm;

  const telemetry = {
    enabled,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    cacheHits: 0,
    skippedExisting: 0,
    skippedUnsupported: 0,
    skippedBudget: 0,
    pastDeadline: 0,
    ashbyBoardsFetched: 0,
    beforeWithDescription: jobs.filter((j) => j.description).length,
    afterWithDescription: 0,
    ms: 0,
  };

  if (!enabled) {
    const out = jobs.map((j) => metadataOnly(j, 'disabled'));
    telemetry.afterWithDescription = out.filter((j) => j.description).length;
    telemetry.ms = Date.now() - started;
    return { jobs: out, telemetry };
  }

  const deadlineAt = started + totalTimeoutMs;
  const eligibleMissIndexes = [];
  // Same positional budget ranking uses before cache (null = unlimited).
  const budgetCap = maxLlm == null ? jobs.length : Math.max(0, Number(maxLlm) || 0);

  // Shared Ashby board payloads (or in-flight promises) for this run.
  const ashbyBoardCache = new Map();
  const boardCache = {
    has: (k) => ashbyBoardCache.has(k),
    get: (k) => ashbyBoardCache.get(k),
    set: (k, v) => {
      const prev = ashbyBoardCache.get(k);
      // Count a board fetch when the first Promise is stored.
      if (!prev && v && typeof v.then === 'function') telemetry.ashbyBoardsFetched++;
      ashbyBoardCache.set(k, v);
    },
  };

  const out = jobs.map((job, index) => {
    if (index >= budgetCap) {
      telemetry.skippedBudget++;
      return metadataOnly(job, 'over_enrichment_budget_scope');
    }
    if (job.description) {
      telemetry.skippedExisting++;
      return metadataOnly(job, 'already_present');
    }
    if (!parseAtsTarget(job)) {
      telemetry.skippedUnsupported++;
      return metadataOnly(job, 'unsupported_host');
    }
    eligibleMissIndexes.push(index);
    return null;
  });

  const toFetch = eligibleMissIndexes.slice(0, Math.max(0, maxJobs));
  const overflow = eligibleMissIndexes.slice(Math.max(0, maxJobs));
  for (const index of overflow) {
    telemetry.skippedBudget++;
    out[index] = metadataOnly(jobs[index], 'over_max_jobs');
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= toFetch.length) return;
      const index = toFetch[i];
      const job = jobs[index];

      if (Date.now() >= deadlineAt) {
        telemetry.pastDeadline++;
        out[index] = metadataOnly(job, 'past_deadline');
        continue;
      }

      const key = cacheKey(job);
      const cached = readCache(key);
      if (cached && isFreshSuccess(cached, ttlHours)) {
        telemetry.cacheHits++;
        telemetry.succeeded++;
        out[index] = attachEvidence(job, {
          description: cached.description,
          origin: cached.origin ?? `cache:${cached.vendor ?? 'ats'}`,
          fetchedAt: cached.fetchedAt,
          enrichmentOutcome: 'cache_hit',
        });
        continue;
      }
      if (cached && isFreshFailure(cached)) {
        telemetry.failed++;
        out[index] = metadataOnly(job, `cache_miss_recent_failure:${cached.error ?? 'error'}`);
        continue;
      }

      telemetry.attempted++;
      const remaining = Math.max(1, deadlineAt - Date.now());
      const result = await fetchJobDescription(job, {
        timeoutMs: Math.min(requestTimeoutMs, remaining),
        fetchImpl,
        boardCache,
      });

      if (result.ok) {
        const fetchedAt = new Date().toISOString();
        writeCache(key, {
          ok: true,
          description: result.description,
          vendor: result.vendor,
          adapterVersion: ADAPTER_VERSION,
          origin: `enrichment:${result.vendor}`,
          fetchedAt,
        });
        telemetry.succeeded++;
        out[index] = attachEvidence(job, {
          description: result.description,
          origin: `enrichment:${result.vendor}`,
          fetchedAt,
          enrichmentOutcome: 'fetched',
        });
      } else {
        writeCache(key, {
          ok: false,
          error: result.error,
          adapterVersion: ADAPTER_VERSION,
          fetchedAt: new Date().toISOString(),
        });
        telemetry.failed++;
        out[index] = metadataOnly(job, `fetch_failed:${result.error}`);
      }
    }
  }

  if (toFetch.length) {
    log.step(`enriching descriptions for up to ${toFetch.length} role(s) (concurrency ${concurrency})`);
    await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, () => worker()));
  }

  // Fill any worker gaps (should not happen).
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = metadataOnly(jobs[i], 'unsettled');
  }

  telemetry.afterWithDescription = out.filter((j) => j.description).length;
  telemetry.ms = Date.now() - started;
  log.info(`  enrichment: ${telemetry.beforeWithDescription}→${telemetry.afterWithDescription} with descriptions `
    + `(${telemetry.succeeded} ok, ${telemetry.failed} failed, ${telemetry.cacheHits} cache hits, ${telemetry.ms}ms)`);
  return { jobs: out, telemetry };
}
