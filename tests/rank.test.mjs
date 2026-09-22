import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBatchResults, validateModelRow, sanitizeReason } from '../src/rank/validate.mjs';
import { extractJson, rankJobs } from '../src/rank/llm.mjs';
import { excerptDescription } from '../src/rank/excerpt.mjs';
import { buildPrompt, renderJob, PROMPT_VERSION } from '../src/rank/prompt.mjs';

function job(id, overrides = {}) {
  return {
    id,
    url: `https://boards.greenhouse.io/acme/jobs/${id}`,
    title: 'Research Engineer',
    company: 'Acme',
    companyKey: 'acme',
    location: 'San Francisco, CA',
    workplace: 'office',
    source: 'ats_sweep',
    sourceDetail: 'greenhouse',
    postedAt: '2026-09-14',
    watchlist: false,
    heuristic: 60,
    titleKeywords: ['research'],
    ...overrides,
  };
}

test('validateModelRow rejects null, string, and out-of-range scores', () => {
  const expected = new Set(['a']);
  assert.equal(validateModelRow({ id: 'a', score: null, why: 'long enough reason' }, { expectedIds: expected }).ok, false);
  assert.equal(validateModelRow({ id: 'a', score: '4', why: 'long enough reason' }, { expectedIds: expected }).ok, false);
  assert.equal(validateModelRow({ id: 'a', score: 6, why: 'long enough reason' }, { expectedIds: expected }).ok, false);
  assert.equal(validateModelRow({ id: 'a', score: -1, why: 'long enough reason' }, { expectedIds: expected }).ok, false);
  assert.equal(validateModelRow({ id: 'a', score: 4.5, why: 'short' }, { expectedIds: expected }).ok, false);
  assert.equal(validateModelRow({ id: 'a', score: 4.5, why: 'long enough reason text' }, { expectedIds: expected }).ok, true);
});

test('a 25-role response with 24 valid rows yields one not_returned', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `id${i}`);
  const rows = ids.slice(0, 24).map((id) => ({ id, score: 4, why: 'long enough reason text' }));
  const mapped = mapBatchResults(rows, ids);
  assert.equal(mapped.byId.size, 24);
  assert.equal(mapped.failures.get('id24'), 'not_returned');
});

test('foreign ids are ignored; duplicate ids that disagree on score become duplicate_id', () => {
  const mapped = mapBatchResults([
    { id: 'a', score: 4, why: 'long enough reason text' },
    { id: 'foreign', score: 5, why: 'long enough reason text' },
    { id: 'a', score: 3, why: 'another long enough reason' },
    { id: 'b', score: 4, why: 'long enough reason text' },
  ], ['a', 'b']);
  assert.equal(mapped.byId.has('a'), false);
  assert.equal(mapped.failures.get('a'), 'duplicate_id');
  assert.equal(mapped.recovered.has('a'), false);
  assert.equal(mapped.byId.get('b').score, 4);
});

test('duplicate ids that agree on score keep the first row as recovered', () => {
  const mapped = mapBatchResults([
    { id: 'a', score: 1.5, why: 'first wording of the same judgement' },
    { id: 'a', score: 1.5, why: 'second wording of the same judgement' },
    { id: 'b', score: 4, why: 'long enough reason text' },
  ], ['a', 'b']);
  assert.equal(mapped.byId.get('a').score, 1.5);
  assert.equal(mapped.byId.get('a').why, 'first wording of the same judgement');
  assert.equal(mapped.failures.has('a'), false);
  assert.equal(mapped.recovered.has('a'), true);
  assert.equal(mapped.byId.get('b').score, 4);
});

test('a later disagreeing copy of a recovered id still fails', () => {
  const mapped = mapBatchResults([
    { id: 'a', score: 1.5, why: 'first wording of the same judgement' },
    { id: 'a', score: 1.5, why: 'second wording of the same judgement' },
    { id: 'a', score: 2, why: 'a genuinely different judgement' },
  ], ['a']);
  assert.equal(mapped.byId.has('a'), false);
  assert.equal(mapped.failures.get('a'), 'duplicate_id');
  assert.equal(mapped.recovered.has('a'), false);
});

test('validateModelRow names the check that failed', () => {
  const expected = new Set(['a']);
  assert.equal(validateModelRow({ id: 'a', score: null, why: 'long enough reason' }, { expectedIds: expected }).failureReason, 'score_not_number');
  assert.equal(validateModelRow({ id: 'a', score: 6, why: 'long enough reason' }, { expectedIds: expected }).failureReason, 'score_out_of_range');
  assert.equal(validateModelRow({ id: 'a', score: 4, why: 'short' }, { expectedIds: expected }).failureReason, 'reason_too_short');
});

test('a returned id within two characters of a missing expected id is id_mismatch', () => {
  const mapped = mapBatchResults([
    { id: 'abcdef01abcdef03', score: 4, why: 'long enough reason text' },
  ], ['abcdef01abcdef02']);
  assert.equal(mapped.failures.get('abcdef01abcdef02'), 'id_mismatch');
  const missing = mapBatchResults([], ['abcdef01abcdef02']);
  assert.equal(missing.failures.get('abcdef01abcdef02'), 'not_returned');
});

test('malformed JSON marks every expected id parse_error', () => {
  const mapped = mapBatchResults(null, ['a', 'b']);
  assert.equal(mapped.parseFailed, true);
  assert.equal(mapped.failures.get('a'), 'parse_error');
  assert.equal(mapped.failures.get('b'), 'parse_error');
});

test('extractJson survives fenced prose wrappers', () => {
  const text = 'Sure!\n```json\n[{"id":"x","score":4,"why":"long enough reason text"}]\n```\n';
  assert.deepEqual(extractJson(text), [{ id: 'x', score: 4, why: 'long enough reason text' }]);
});

test('null max_llm submits all; explicit budget overflows; zero submits none', async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(`j${i}`));
  const calls = [];
  const ask = async (_c, prompt) => {
    calls.push(prompt);
    const ids = [...prompt.matchAll(/^id:\s*(\S+)$/gm)].map((m) => m[1]);
    return {
      ok: true,
      stdout: JSON.stringify(ids.map((id) => ({ id, score: 4, why: 'long enough reason text' }))),
    };
  };
  const detect = async () => ({ bin: 'stub', args: (p) => [p] });

  const all = await rankJobs(jobs, { prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'x' } } }, {
    maxLlm: null, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub',
  });
  assert.equal(all.telemetry.statusCounts.model, 10);
  assert.equal(all.telemetry.statusCounts.over_budget, 0);

  const capped = await rankJobs(jobs, { prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'x' } } }, {
    maxLlm: 7, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub',
  });
  assert.equal(capped.telemetry.statusCounts.model, 7);
  assert.equal(capped.telemetry.statusCounts.over_budget, 3);

  const none = await rankJobs(jobs, { prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'x' } } }, {
    maxLlm: 0, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub',
  });
  assert.equal(none.calls, 0);
  assert.equal(none.telemetry.statusCounts.over_budget, 10);
});

test('concurrency respects the configured worker limit and preserves order', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job(`c${i}`, { title: `Role ${i}` }));
  let inflight = 0;
  let maxInflight = 0;
  const ask = async (_c, prompt) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 40));
    inflight--;
    const ids = [...prompt.matchAll(/^id:\s*(\S+)$/gm)].map((m) => m[1]);
    // Reverse scores within the batch so completion order differs from input.
    return {
      ok: true,
      stdout: JSON.stringify([...ids].reverse().map((id, i) => ({
        id,
        score: 3 + (i % 3) * 0.5,
        why: `long enough reason for ${id}`,
      }))),
    };
  };
  const detect = async () => ({ bin: 'stub', args: (p) => [p] });
  const prefs = { targets: { role_terms: ['engineer'] }, background: { summary: 'x' } };

  const concurrent = await rankJobs(jobs, { prefs }, {
    maxLlm: null, batchSize: 2, concurrency: 3, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub',
  });
  assert.ok(maxInflight <= 3);
  assert.ok(maxInflight >= 2, 'concurrency > 1 should overlap');
  assert.deepEqual(concurrent.jobs.map((j) => j.id), jobs.map((j) => j.id));

  maxInflight = 0;
  const sequential = await rankJobs(jobs, { prefs }, {
    maxLlm: null, batchSize: 2, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub',
  });
  assert.deepEqual(
    concurrent.jobs.map((j) => ({ id: j.id, score: j.score, why: j.why })),
    sequential.jobs.map((j) => ({ id: j.id, score: j.score, why: j.why })),
  );
});

test('hanging stubs return by the ranking deadline', async () => {
  const jobs = [job('h1'), job('h2')];
  const ask = () => new Promise(() => { /* never resolves unless cancelled */ });
  // Wrap askCli-like cancel behaviour:
  const askCancelable = (_c, _p, { cancelSignal, timeoutMs }) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timed out', reason: 'timeout' }), timeoutMs);
    cancelSignal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'deadline', reason: 'past_deadline' });
    }, { once: true });
  });
  const detect = async () => ({ bin: 'stub', args: (p) => [p] });
  const started = Date.now();
  const result = await rankJobs(jobs, { prefs: { targets: { role_terms: ['e'] }, background: { summary: 'x' } } }, {
    maxLlm: null, batchSize: 1, concurrency: 2, timeoutMs: 60_000, totalTimeoutMs: 200,
    cache: { enabled: false }, ask: askCancelable, detect, cli: 'stub',
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6_000, `expected deadline return, took ${elapsed}ms`);
  assert.equal(result.telemetry.statusCounts.past_deadline, 2);
  assert.equal(result.telemetry.statusCounts.failed ?? 0, 0);
  assert.ok(result.jobs.every((j) => j.rankStatus === 'past_deadline'));
  void ask;
});

test('deadline-shortened call timeouts are labelled past_deadline', async () => {
  // Per-call timer wins the race with cancel — must still count as deadline.
  const jobs = [job('t1'), job('t2')];
  const askTimeoutOnly = (_c, _p, { timeoutMs }) => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, reason: 'timeout' }), timeoutMs);
  });
  const detect = async () => ({ bin: 'stub', args: (p) => [p] });
  const result = await rankJobs(jobs, { prefs: { targets: { role_terms: ['e'] }, background: { summary: 'x' } } }, {
    maxLlm: null, batchSize: 1, concurrency: 2, timeoutMs: 60_000, totalTimeoutMs: 80,
    cache: { enabled: false }, ask: askTimeoutOnly, detect, cli: 'stub',
  });
  assert.equal(result.telemetry.statusCounts.past_deadline, 2);
  assert.equal(result.telemetry.statusCounts.failed ?? 0, 0);
});

test('section-aware excerpt keeps qualifications after boilerplate', () => {
  const text = `${'About us. '.repeat(80)}\nQualifications\nMust know ranking systems and evaluation harnesses.\nCompensation\n$200k`;
  const excerpt = excerptDescription(text, { maxChars: 200 });
  assert.match(excerpt, /ranking systems/i);
  assert.ok(excerpt.length <= 200);
});

test('section headings do not swallow content lines that mention experience', async () => {
  const { isSectionHeading, splitDescriptionSections } = await import('../src/rank/excerpt.mjs');
  assert.equal(isSectionHeading('Experience', [/\b(experience|background|skills)\b/i]), true);
  assert.equal(isSectionHeading('Skills, Knowledge and Abilities', [/\b(experience|background|skills)\b/i]), true);
  assert.equal(isSectionHeading('5+ years experience with PyTorch', [/\b(experience|background|skills)\b/i]), false);
  assert.equal(isSectionHeading('Competitive pay and equity', [/\b(compensation|salary|pay|benefits|perks|total rewards)\b/i]), false);

  // The bug: a content line matching an alias became an empty section and was
  // dropped from body — so long intros lost "5+ years experience…" entirely.
  const text = `${'About us. We build products and care about people. '.repeat(100)}\n5+ years experience with PyTorch\nQualifications\nMust know ranking systems.\n`;
  assert.ok(text.length > 4000, `fixture must exceed excerpt budget (${text.length})`);
  const sections = splitDescriptionSections(text);
  assert.match(sections.body, /5\+ years experience with PyTorch/i);
  assert.equal(sections.experience, undefined);
  assert.match(sections.qualifications, /ranking systems/i);
});

test('prompt marks metadata-only jobs and includes PROMPT_VERSION', () => {
  assert.ok(PROMPT_VERSION);
  const prompt = buildPrompt([job('p1', { description: null })], {
    prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'Candidate brief' } },
  });
  assert.match(prompt, /metadata only/i);
  assert.match(renderJob(job('p1', { description: 'Owns evals and ranking quality end to end.' })), /Owns evals/);
  assert.equal(sanitizeReason('  a|b<c>  ').includes('|'), false);
});

test('a rejected batch writes raw stdout under the run dir', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const runDir = mkdtempSync(join(tmpdir(), 'huntley-rank-'));
  const jobs = [job('keep1'), job('drop1')];
  const stdout = JSON.stringify([{ id: 'keep1', score: 4, why: 'long enough reason text' }]);
  const ask = async () => ({ ok: true, stdout });
  const detect = async () => ({ bin: 'stub', args: (p) => [p] });
  const result = await rankJobs(jobs, { prefs: { targets: { role_terms: ['e'] }, background: { summary: 'x' } } }, {
    maxLlm: null, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false }, ask, detect, cli: 'stub', runDir,
  });
  assert.equal(result.telemetry.failureReasons.not_returned, 1);
  const saved = join(runDir, 'rank', 'batch-1.txt');
  assert.ok(existsSync(saved));
  assert.equal(readFileSync(saved, 'utf8'), stdout);
});

test('agreeing duplicate ids are counted on the batch as recovered', async () => {
  const jobs = [job('a'), job('b')];
  const stdout = JSON.stringify([
    { id: 'a', score: 1.5, why: 'first wording of the same judgement' },
    { id: 'a', score: 1.5, why: 'second wording of the same judgement' },
    { id: 'b', score: 4, why: 'long enough reason text' },
  ]);
  const result = await rankJobs(jobs, { prefs: { targets: { role_terms: ['e'] }, background: { summary: 'x' } } }, {
    maxLlm: null, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 30_000,
    cache: { enabled: false },
    ask: async () => ({ ok: true, stdout }),
    detect: async () => ({ bin: 'stub', args: (p) => [p] }),
    cli: 'stub',
  });
  assert.equal(result.jobs.find((j) => j.id === 'a').rankStatus, 'model');
  assert.equal(result.jobs.find((j) => j.id === 'a').score, 1.5);
  assert.equal(result.telemetry.batches[0].recoveredCount, 1);
  assert.equal(result.telemetry.failureReasons.duplicate_id, undefined);
});

// 2026-09-18 and 2026-09-21: every rank call exited 1 in ~4s with an empty
// stderr because the account's usage limit was reached, and the run reported
// "250 failed (250 cli_error)" — indistinguishable from the provider being
// broken. A real call takes minutes.
test('a run whose calls all exit instantly is reported as rate-limited', async () => {
  const { looksRateLimited } = await import('../src/rank/llm.mjs');
  const limited = [4020, 4132, 4145, 4066, 4289].map((durationMs) => ({ outcome: 'cli_error', durationMs }));
  assert.equal(looksRateLimited(limited), true);

  // Real work, including a batch that lost one row to a duplicate id.
  assert.equal(looksRateLimited([
    { outcome: 'ok', durationMs: 146_835 },
    { outcome: 'partial', durationMs: 156_992 },
    { outcome: 'ok', durationMs: 240_386 },
  ]), false);
  // A CLI that fails slowly is a different fault, and one call proves nothing.
  assert.equal(looksRateLimited([{ outcome: 'cli_error', durationMs: 200_000 }, { outcome: 'cli_error', durationMs: 190_000 }]), false);
  assert.equal(looksRateLimited([{ outcome: 'cli_error', durationMs: 4_000 }]), false);
  // If anything got through, the CLI is working.
  assert.equal(looksRateLimited([{ outcome: 'cli_error', durationMs: 4_000 }, { outcome: 'ok', durationMs: 150_000 }]), false);
  // Batches cut by the deadline never ran, so they don't count either way.
  assert.equal(looksRateLimited([
    { outcome: 'cli_error', durationMs: 4_000 },
    { outcome: 'cli_error', durationMs: 4_100 },
    { outcome: 'past_deadline', durationMs: 119_000 },
  ]), true);
});

test('the rate-limit hint reaches the run summary', async () => {
  const { rankJobs } = await import('../src/rank/llm.mjs');
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: `rl${i}`, url: `https://job-boards.greenhouse.io/acme/jobs/${i}`, title: 'Research Engineer',
    company: 'Acme', companyKey: 'acme', location: 'San Francisco, CA', workplace: 'office',
    description: `Ranking systems ${i}.`, heuristic: 50, titleKeywords: ['research'],
  }));
  const out = await rankJobs(jobs, { prefs: { targets: { role_terms: ['engineer'] } } }, {
    maxLlm: null, batchSize: 2, concurrency: 1, timeoutMs: 5_000, totalTimeoutMs: 60_000,
    cache: { enabled: false }, cli: 'claude',
    detect: async () => ({ bin: 'claude', args: (p) => [p] }),
    ask: async () => ({ ok: false, error: 'exit 1: ', reason: 'cli_error' }),
  });
  assert.match(out.degraded, /rate-limited/);
  assert.match(out.degraded, /stay pending/);
});
