// Stage 2 of ranking: the judgment call and the "why this fits" line.
//
// This drives whatever headless agent CLI you already have installed rather
// than calling a metered API — the same trick career-ops' rank-pipeline.mjs
// uses. On a Claude Pro subscription `claude -p` costs no API money; it draws
// on your existing plan usage. `gemini -p` and `codex exec` work the same way.
//
// Design rules that matter more than the prompt:
//
//   • Batched + concurrent. A bounded worker pool invokes the model; one
//     coordinator merges results so completion order cannot reshuffle digests.
//   • Every score carries a reason. Invalid, missing, or disagreeing duplicate
//     rows fall back to heuristic rank with an explicit rankStatus / failureReason.
//   • Failure is loud and non-fatal. If the CLI is missing, times out, or
//     returns junk, the digest still goes out and says so at the top.
//   • An overall ranking deadline bounds wall time separately from budget
//     overflow. Cache hits do not consume max_llm.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../lib/log.mjs';
import { buildPrompt } from './prompt.mjs';
import { mapBatchResults, isHeuristicStatus } from './validate.mjs';
import { rankCacheKey, readRankCache, writeRankCache, ensureRankCacheDir } from './cache.mjs';

// Headless invocation per CLI. Auto-detected in this order.
export const CLI_CANDIDATES = [
  { bin: 'claude', args: (p, model) => [...(model ? ['--model', model] : []), '-p', p] },
  { bin: 'gemini', args: (p, model) => [...(model ? ['-m', model] : []), '-p', p] },
  { bin: 'codex',  args: (p) => ['exec', p] },
  { bin: 'opencode', args: (p) => ['run', p] },
  { bin: 'cursor-agent', args: (p) => ['-p', p] },
];

const DETECT_CLI_TIMEOUT_MS = 5_000;
export const CLEANUP_ALLOWANCE_MS = 5_000;
const HEARTBEAT_MS = 30_000;

/** Detached CLI process-group leaders still running — killed on Ctrl-C / exit. */
const activeCliLeaders = new Set();
let cliSignalHooksInstalled = false;

function killCliLeader(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function killAllCliLeaders() {
  for (const pid of activeCliLeaders) killCliLeader(pid);
  activeCliLeaders.clear();
}

/** Ensure in-flight `claude -p` trees die when huntley is interrupted. */
export function installCliSignalHooks() {
  if (cliSignalHooksInstalled || process.platform === 'win32') return;
  cliSignalHooksInstalled = true;
  const onSignal = (sig) => {
    killAllCliLeaders();
    // A listener suppresses Node's default exit — re-exit with the usual code.
    const code = sig === 'SIGINT' ? 130 : 143;
    process.exit(code);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', killAllCliLeaders);
}

function which(bin, { timeoutMs = DETECT_CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      done(false);
    }, timeoutMs);
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0));
  });
}

/** Find the first installed CLI, honouring an explicit preference. */
export async function detectCli(preferred = null) {
  const ordered = preferred
    ? [...CLI_CANDIDATES.filter((c) => c.bin === preferred), ...CLI_CANDIDATES.filter((c) => c.bin !== preferred)]
    : CLI_CANDIDATES;

  for (const candidate of ordered) {
    if (await which(candidate.bin)) return candidate;
  }
  return null;
}

/**
 * Run one prompt against an already-detected CLI.
 * Resolves even when killed by timeout or external cancel, including when a
 * descendant process retains inherited stdout/stderr pipes.
 */
export function askCli(candidate, prompt, { model, timeoutMs, cancelSignal, cleanupAllowanceMs = CLEANUP_ALLOWANCE_MS } = {}) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== 'win32';
    installCliSignalHooks();
    const child = spawn(candidate.bin, candidate.args(prompt, model), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      // Own process group so descendants that inherit pipes die with the leader.
      detached: useProcessGroup,
    });
    if (useProcessGroup && child.pid) activeCliLeaders.add(child.pid);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let cleanupTimer = null;

    const destroyPipes = () => {
      try { child.stdout.removeAllListeners('data'); child.stdout.destroy(); } catch { /* ignore */ }
      try { child.stderr.removeAllListeners('data'); child.stderr.destroy(); } catch { /* ignore */ }
    };

    const killTree = () => {
      if (useProcessGroup && child.pid) {
        activeCliLeaders.delete(child.pid);
        killCliLeader(child.pid);
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (child.pid) activeCliLeaders.delete(child.pid);
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cancelSignal?.removeEventListener?.('abort', onCancel);
      destroyPipes();
      resolve(result);
    };

    const failWithBound = (result) => {
      killTree();
      destroyPipes();
      // Do not wait forever for 'close' — a descendant may still hold the fd.
      // Bound cleanup so ranking's overall deadline remains meaningful.
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => finish(result), Math.max(0, cleanupAllowanceMs));
      cleanupTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      failWithBound({ ok: false, error: `timed out after ${timeoutMs}ms`, reason: 'timeout' });
    }, Math.max(1, timeoutMs));

    const onCancel = () => {
      cancelled = true;
      failWithBound({ ok: false, error: 'ranking deadline reached', reason: 'past_deadline' });
    };
    if (cancelSignal) {
      if (cancelSignal.aborted) onCancel();
      else cancelSignal.addEventListener('abort', onCancel, { once: true });
    }

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ ok: false, error: err.message, reason: 'cli_error' }));
    child.on('close', (code) => {
      if (cancelled) return finish({ ok: false, error: 'ranking deadline reached', reason: 'past_deadline' });
      if (timedOut) return finish({ ok: false, error: `timed out after ${timeoutMs}ms`, reason: 'timeout' });
      if (code !== 0) return finish({ ok: false, error: `exit ${code}: ${stderr.trim().slice(0, 300)}`, reason: 'cli_error' });
      finish({ ok: true, stdout });
    });
  });
}

/**
 * Pull the JSON array out of a CLI's reply. Agent CLIs wrap output in prose and
 * fenced blocks with cheerful inconsistency, so scan for the outermost array
 * rather than trusting any one shape.
 */
export function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean);

  for (const candidate of candidates) {
    const start = candidate.indexOf('[');
    if (start === -1) continue;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function heuristicFallback(job, { rankStatus, failureReason = null } = {}) {
  const status = rankStatus ?? 'failed';
  return {
    ...job,
    score: job.score ?? Math.round((job.heuristic ?? 40) / 20 * 10) / 10,
    why: job.why ?? null,
    heuristicOnly: isHeuristicStatus(status),
    rankStatus: status,
    ...(failureReason ? { failureReason } : {}),
  };
}

function emptyTelemetry(extra = {}) {
  return {
    statusCounts: { model: 0, cache: 0, over_budget: 0, past_deadline: 0, failed: 0 },
    failureReasons: {},
    cache: { hits: 0, misses: 0 },
    calls: 0,
    batches: [],
    promptChars: [],
    ...extra,
  };
}

function chunkJobs(jobs, batchSize) {
  const batches = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    batches.push({
      batchNumber: batches.length + 1,
      jobs: jobs.slice(i, i + batchSize),
    });
  }
  return batches;
}

/**
 * Score jobs and attach score + why + rankStatus.
 *
 * Job order from the caller is preserved through merging. Model completion
 * order must not affect digest ties or budget eligibility.
 *
 * @param {import('../normalize.mjs').Job[]} jobs   prefiltered, heuristic-sorted
 * @param {object} ctx  { prefs }
 * @param {object} opts
 * @returns {Promise<{jobs: object[], degraded: string|null, calls: number, telemetry: object}>}
 */
/**
 * The wall-clock ranking needs if every call runs to its timeout: how many
 * batches the submissions make, how many waves those batches make at the given
 * concurrency, and one per-call timeout per wave.
 */
export function rankingDeadlineFor({ submissions, batchSize = 8, concurrency = 3, timeoutMs = 180_000 }) {
  const calls = Math.max(1, Math.ceil(Math.max(0, submissions) / Math.max(1, batchSize)));
  const waves = Math.max(1, Math.ceil(calls / Math.max(1, concurrency)));
  return waves * Math.max(1, timeoutMs);
}

export async function rankJobs(jobs, ctx, opts = {}) {
  const rankingStarted = Date.now();
  const {
    cli: preferredCli = 'claude',
    model = null,
    maxLlm = null,
    batchSize = 8,
    concurrency = 3,
    timeoutMs = 180_000,
    totalTimeoutMs = null,
    cache: cacheOpts = {},
    ask = askCli,
    detect = detectCli,
    runDir = null,
  } = opts;

  const cacheEnabled = cacheOpts.enabled !== false;
  const cacheTtlHours = cacheOpts.ttl_hours ?? cacheOpts.ttlHours ?? 168;
  // A flat overall deadline cannot know how many calls this run needs, so it
  // silently becomes wrong the moment max_llm or batch_size moves: 300000
  // against a 180000 per-call timeout could only ever finish one of the four
  // waves that max_llm 250 / batch_size 25 required, and every run lost three
  // quarters of its ranking to a constant. Derived, the budget simply fits.
  // An explicit number still wins, for a hard wall-clock cap.
  const deadlineBudget = totalTimeoutMs ?? rankingDeadlineFor({
    submissions: Math.min(maxLlm ?? jobs.length, jobs.length),
    batchSize, concurrency, timeoutMs,
  });
  const deadlineAt = rankingStarted + Math.max(1, deadlineBudget);
  const telemetry = emptyTelemetry({ startedAt: new Date(rankingStarted).toISOString() });

  if (jobs.length === 0) {
    return { jobs, degraded: null, calls: 0, telemetry };
  }

  // Preserve input order for all merges.
  const order = jobs.map((j) => j.id);
  const outcomes = new Map();

  const mark = (job, patch) => {
    const next = { ...job, ...patch };
    next.heuristicOnly = isHeuristicStatus(next.rankStatus);
    if (next.rankStatus !== 'failed') delete next.failureReason;
    outcomes.set(job.id, next);
  };

  const remainingMs = () => deadlineAt - Date.now();
  const pastDeadline = () => remainingMs() <= 0;

  if (cacheEnabled) ensureRankCacheDir();

  // Deadline covers CLI detection and cache work.
  const candidate = pastDeadline() ? null : await detect(preferredCli);
  const resolvedCli = candidate?.bin ?? preferredCli;

  if (pastDeadline() && !candidate) {
    for (const job of jobs) mark(job, heuristicFallback(job, { rankStatus: 'past_deadline' }));
    return finish(jobs, outcomes, order, telemetry, rankingStarted,
      'ranking deadline reached during CLI detection — ranked by heuristic only');
  }

  // Cache lookup for every role before budget slicing. Hits do not consume max_llm.
  const misses = [];
  for (const job of jobs) {
    if (!cacheEnabled) {
      misses.push(job);
      telemetry.cache.misses++;
      continue;
    }
    try {
      const key = rankCacheKey(job, { prefs: ctx.prefs, cli: resolvedCli, model });
      const hit = readRankCache(key, { ttlHours: cacheTtlHours });
      if (hit) {
        mark(job, {
          score: hit.score,
          why: hit.why,
          rankStatus: 'cache',
          cacheKey: key,
          heuristicOnly: false,
        });
        telemetry.cache.hits++;
        continue;
      }
    } catch {
      // Corrupt cache entries are misses.
    }
    misses.push(job);
    telemetry.cache.misses++;
  }

  // null = all misses eligible; 0 = no new submissions; N = at most N misses.
  let submit;
  let overflow;
  if (maxLlm == null) {
    submit = misses;
    overflow = [];
  } else {
    const budget = Math.max(0, Number(maxLlm) || 0);
    submit = misses.slice(0, budget);
    overflow = misses.slice(budget);
  }

  for (const job of overflow) {
    mark(job, heuristicFallback(job, { rankStatus: 'over_budget' }));
  }

  if (submit.length === 0) {
    return finish(jobs, outcomes, order, telemetry, rankingStarted, null);
  }

  if (!candidate) {
    const msg = `no agent CLI found (looked for ${CLI_CANDIDATES.map((c) => c.bin).join(', ')}) — ranked by heuristic only`;
    log.warn(msg);
    for (const job of submit) {
      mark(job, heuristicFallback(job, { rankStatus: 'failed', failureReason: 'cli_unavailable' }));
    }
    return finish(jobs, outcomes, order, telemetry, rankingStarted, msg);
  }

  if (pastDeadline()) {
    for (const job of submit) mark(job, heuristicFallback(job, { rankStatus: 'past_deadline' }));
    return finish(jobs, outcomes, order, telemetry, rankingStarted,
      'ranking deadline reached before model submission — remaining roles carry heuristic ranks');
  }

  const batches = chunkJobs(submit, Math.max(1, batchSize));
  log.step(`ranking ${submit.length} role(s) via ${candidate.bin}${model ? ` (${model})` : ''} in ${batches.length} batch(es), concurrency ${Math.max(1, Math.min(4, concurrency))}`);

  const cancelControllers = new Map();
  let stopDispatch = false;
  let deadlineHit = false;

  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    stopDispatch = true;
    for (const c of cancelControllers.values()) {
      try { c.abort(); } catch { /* ignore */ }
    }
  }, Math.max(1, remainingMs()));

  const heartbeat = setInterval(() => {
    const done = [...outcomes.values()].filter((j) => submit.some((s) => s.id === j.id)).length;
    log.info(`  ranking heartbeat: ${done}/${submit.length} submitted roles settled, ${telemetry.calls} call(s), ${Math.max(0, Math.round(remainingMs() / 1000))}s left`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const workerCount = Math.max(1, Math.min(4, Number(concurrency) || 1));
  let nextBatch = 0;

  async function runBatch(batch) {
    if (stopDispatch || pastDeadline()) {
      for (const job of batch.jobs) {
        if (!outcomes.has(job.id)) mark(job, heuristicFallback(job, { rankStatus: 'past_deadline' }));
      }
      return;
    }

    const prompt = buildPrompt(batch.jobs, ctx);
    const promptChars = prompt.length;
    telemetry.promptChars.push({ batch: batch.batchNumber, chars: promptChars });
    const callTimeout = Math.min(timeoutMs, Math.max(1, remainingMs()));
    const controller = new AbortController();
    cancelControllers.set(batch.batchNumber, controller);

    log.info(`  rank batch ${batch.batchNumber}/${batches.length} starting (${batch.jobs.length} role(s), ${promptChars} prompt chars)`);
    const started = Date.now();
    telemetry.calls++;
    const res = await ask(candidate, prompt, { model, timeoutMs: callTimeout, cancelSignal: controller.signal });
    cancelControllers.delete(batch.batchNumber);
    const durationMs = Date.now() - started;

    const expectedIds = batch.jobs.map((j) => j.id);
    let validCount = 0;
    let recoveredCount = 0;
    let outcome = 'ok';

    if (!res.ok) {
      // When the call timeout was shortened to the ranking deadline, the
      // per-call timer and the deadline abort race — treat a timeout as
      // past_deadline so telemetry does not mislabel deadline cuts.
      const hitDeadline = res.reason === 'past_deadline'
        || (res.reason === 'timeout' && callTimeout < timeoutMs);
      const status = hitDeadline ? 'past_deadline' : 'failed';
      const failureReason = hitDeadline ? null : (res.reason ?? 'cli_error');
      outcome = status === 'past_deadline' ? 'past_deadline' : (failureReason ?? 'cli_error');
      for (const job of batch.jobs) {
        if (outcomes.has(job.id)) continue;
        mark(job, heuristicFallback(job, {
          rankStatus: status,
          ...(failureReason ? { failureReason } : {}),
        }));
      }
      log.warn(`  rank batch ${batch.batchNumber} failed: ${res.error}`);
    } else {
      const parsed = extractJson(res.stdout);
      const mapped = mapBatchResults(parsed, expectedIds);
      validCount = mapped.byId.size;
      recoveredCount = mapped.recovered.size;
      if (mapped.parseFailed) outcome = 'parse_error';
      else if (mapped.failures.size) outcome = 'partial';
      if (mapped.parseFailed || mapped.failures.size) {
        saveRejectedBatch(runDir, batch.batchNumber, res.stdout);
      }

      for (const job of batch.jobs) {
        if (outcomes.has(job.id)) continue;
        const hit = mapped.byId.get(job.id);
        if (hit) {
          mark(job, {
            score: hit.score,
            why: hit.why,
            rankStatus: 'model',
            heuristicOnly: false,
          });
          if (cacheEnabled) {
            try {
              const key = rankCacheKey(job, { prefs: ctx.prefs, cli: resolvedCli, model });
              writeRankCache(key, {
                score: hit.score,
                why: hit.why,
                evidenceLevel: job.evidenceLevel ?? (job.description ? 'description' : 'metadata_only'),
                cli: resolvedCli,
                model,
              });
            } catch (err) {
              log.debug(`  rank cache write failed for ${job.id}: ${err.message}`);
            }
          }
        } else {
          const failureReason = mapped.failures.get(job.id) ?? 'not_returned';
          mark(job, heuristicFallback(job, { rankStatus: 'failed', failureReason }));
        }
      }
      log.info(`  rank batch ${batch.batchNumber} done in ${durationMs}ms — ${validCount}/${expectedIds.length} valid`
        + (recoveredCount ? ` (${recoveredCount} duplicate row${recoveredCount === 1 ? '' : 's'} recovered)` : ''));
    }

    telemetry.batches.push({
      batch: batch.batchNumber,
      durationMs,
      outcome,
      expectedCount: expectedIds.length,
      validCount,
      recoveredCount,
      promptChars,
    });
  }

  async function worker() {
    while (true) {
      if (stopDispatch || pastDeadline()) break;
      const index = nextBatch++;
      if (index >= batches.length) break;
      await runBatch(batches[index]);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(workerCount, batches.length) }, () => worker()));
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeat);
  }

  // Anything still unsettled after workers finish was past the deadline or never dispatched.
  for (const job of submit) {
    if (!outcomes.has(job.id)) {
      mark(job, heuristicFallback(job, { rankStatus: 'past_deadline' }));
    }
  }

  // Recount before composing the digest warning so deadline/failure totals are accurate.
  recountTelemetry(outcomes, order, telemetry);
  const degraded = buildDegradedMessage(telemetry, deadlineHit, candidate.bin);
  if (degraded) log.warn(degraded);
  telemetry.ms = Date.now() - rankingStarted;
  telemetry.cleanupAllowanceMs = CLEANUP_ALLOWANCE_MS;
  return finish(jobs, outcomes, order, telemetry, rankingStarted, degraded);
}

function recountTelemetry(outcomes, order, telemetry) {
  const statusCounts = { model: 0, cache: 0, over_budget: 0, past_deadline: 0, failed: 0 };
  const failureReasons = {};
  for (const id of order) {
    const row = outcomes.get(id);
    if (!row) continue;
    statusCounts[row.rankStatus] = (statusCounts[row.rankStatus] ?? 0) + 1;
    if (row.rankStatus === 'failed' && row.failureReason) {
      failureReasons[row.failureReason] = (failureReasons[row.failureReason] ?? 0) + 1;
    }
  }
  telemetry.statusCounts = statusCounts;
  telemetry.failureReasons = failureReasons;
}

// A real rank call takes minutes; `claude -p` exits 1 in a few seconds with an
// empty stderr when the account's usage limit is reached, so the run reports a
// bare "exit 1:" and looks like a provider fault. Two runs were read that way
// (2026-09-18, 2026-09-21) before anyone noticed the limit. Say it plainly.
export const RATE_LIMIT_HINT_MS = 15_000;

/** Every call failed instantly — the CLI never really ran. */
export function looksRateLimited(batches = [], { maxMs = RATE_LIMIT_HINT_MS } = {}) {
  const calls = (batches ?? []).filter((b) => b && b.outcome !== 'past_deadline');
  if (calls.length < 2) return false;
  return calls.every((b) => b.outcome === 'cli_error' && Number(b.durationMs) < maxMs);
}

function buildDegradedMessage(telemetry, deadlineHit, cliBin) {
  const failed = telemetry.statusCounts.failed ?? 0;
  const past = telemetry.statusCounts.past_deadline ?? 0;
  const over = telemetry.statusCounts.over_budget ?? 0;
  const parts = [];
  if (failed > 0 && (telemetry.statusCounts.model ?? 0) === 0 && (telemetry.statusCounts.cache ?? 0) === 0 && past === 0) {
    parts.push(`every rank call failed (${cliBin}) — ranked by heuristic only`);
  } else if (failed > 0 || past > 0) {
    parts.push(
      `model ranking incomplete: ${failed} failed, ${past} past deadline`
      + (Object.keys(telemetry.failureReasons ?? {}).length
        ? ` (${summarizeFailures(telemetry.failureReasons)})`
        : ''),
    );
  } else if (deadlineHit) {
    parts.push('ranking deadline reached');
  }
  if (over > 0) {
    parts.push(`${over} role(s) outside the model submission budget (not a provider failure)`);
  }
  if (looksRateLimited(telemetry.batches)) {
    const calls = telemetry.batches.length;
    const slowest = Math.max(...telemetry.batches.map((b) => Number(b.durationMs) || 0));
    parts.unshift(
      `the ranking CLI looks rate-limited: all ${calls} call(s) to ${cliBin} exited within `
      + `${(slowest / 1000).toFixed(0)}s with no output. Nothing was scored; these roles stay `
      + 'pending and are ranked on the next run',
    );
  }
  return parts.length ? parts.join(' — ') : null;
}

function summarizeFailures(reasons) {
  return Object.entries(reasons).map(([k, n]) => `${n} ${k}`).join(', ') || 'unspecified';
}

function finish(jobs, outcomes, order, telemetry, rankingStarted, degraded) {
  recountTelemetry(outcomes, order, telemetry);
  telemetry.ms = Date.now() - rankingStarted;

  const ranked = order.map((id) => {
    const hit = outcomes.get(id);
    if (hit) return hit;
    const job = jobs.find((j) => j.id === id);
    return heuristicFallback(job, { rankStatus: 'failed', failureReason: 'not_returned' });
  });

  return { jobs: ranked, degraded, calls: telemetry.calls, telemetry };
}

const REJECTED_BATCH_CAP = 1024 * 1024;

function saveRejectedBatch(runDir, batchNumber, stdout) {
  if (!runDir || stdout == null) return;
  try {
    const dir = join(runDir, 'rank');
    mkdirSync(dir, { recursive: true });
    const text = String(stdout);
    writeFileSync(join(dir, `batch-${batchNumber}.txt`), text.length > REJECTED_BATCH_CAP ? text.slice(0, REJECTED_BATCH_CAP) : text);
  } catch (err) {
    log.debug(`  rank batch ${batchNumber} stdout not saved: ${err.message}`);
  }
}

export { heuristicFallback };
