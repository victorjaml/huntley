import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'huntley-cache-'));
process.env.HUNTLEY_DATA_DIR = root;
mkdirSync(join(root, 'cache'), { recursive: true });

const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
ensureDirs();
assert.ok(PATHS.cache.startsWith(root));

const { rankCacheKey, readRankCache, writeRankCache } = await import('../src/rank/cache.mjs');
const { rankJobs } = await import('../src/rank/llm.mjs');
const { applyWatchlistBonus } = await import('../src/rank/bonus.mjs');

const prefs = {
  targets: { role_terms: ['engineer'], title_keywords: ['research'] },
  background: { summary: 'A candidate who builds ranking systems.' },
  location: { base: 'LA', allow: ['California'], remote: 'rank_lower' },
};

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
    description: 'Build evals and ranking quality.',
    watchlist: false,
    heuristic: 70,
    titleKeywords: ['research'],
    ...overrides,
  };
}

test('the same posting under a new id, lane or date keeps its cached judgment', () => {
  const j = job('s1');
  const base = rankCacheKey(j, { prefs, cli: 'claude', model: null });
  // All three move between runs for one unchanged posting: LinkedIn reposts
  // under a fresh id, dedupe hands the row to whichever lane won, and a board
  // re-reads the date. None of them changes whether the job fits.
  for (const [what, changed] of [
    ['a new posting id', { id: 's2', url: 'https://boards.greenhouse.io/acme/jobs/s2' }],
    ['a different lane', { source: 'linkedin', sourceDetail: 'linkedin' }],
    ['a re-read date', { postedAt: '2026-09-15' }],
  ]) {
    assert.equal(rankCacheKey({ ...j, ...changed }, { prefs, cli: 'claude', model: null }), base, what);
  }
});

test('cache key changes when brief, evidence, model, or prompt identity changes', () => {
  const j = job('k1');
  const a = rankCacheKey(j, { prefs, cli: 'claude', model: null });
  const b = rankCacheKey(j, { prefs: { ...prefs, background: { summary: 'Different brief' } }, cli: 'claude', model: null });
  const c = rankCacheKey({ ...j, description: 'Different evidence text about systems.' }, { prefs, cli: 'claude', model: null });
  const d = rankCacheKey(j, { prefs, cli: 'claude', model: 'opus' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('valid cache hits skip model calls; corrupt entries miss', async () => {
  // Two genuinely different postings. Since the key stopped carrying the
  // posting id, two rows identical in every scored field share one entry —
  // which is the point (LinkedIn reposts the same role under a new id), but it
  // means this test needs postings the model would actually judge differently.
  const jobs = [job('c1'), job('c2', { title: 'Staff Research Engineer' })];
  let calls = 0;
  const ask = async (_cli, prompt) => {
    calls++;
    const ids = [...prompt.matchAll(/^id:\s*(\S+)$/gm)].map((m) => m[1]);
    return {
      ok: true,
      stdout: JSON.stringify(ids.map((id) => ({ id, score: 4.5, why: 'long enough cached-or-fresh reason' }))),
    };
  };
  const detect = async () => ({ bin: 'claude', args: (p) => [p] });

  const cold = await rankJobs(jobs, { prefs }, {
    maxLlm: null, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 20_000,
    cache: { enabled: true, ttl_hours: 168 }, ask, detect, cli: 'claude',
  });
  assert.equal(cold.calls, 1);
  assert.equal(cold.telemetry.statusCounts.model, 2);

  calls = 0;
  const warm = await rankJobs(jobs, { prefs }, {
    maxLlm: null, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 20_000,
    cache: { enabled: true, ttl_hours: 168 }, ask, detect, cli: 'claude',
  });
  assert.equal(calls, 0);
  assert.equal(warm.telemetry.statusCounts.cache, 2);
  assert.equal(warm.telemetry.cache.hits, 2);

  // Corrupt one entry.
  const key = rankCacheKey(jobs[0], { prefs, cli: 'claude', model: null });
  writeFileSync(join(PATHS.cache, 'rank', `${key}.json`), '{broken');
  calls = 0;
  const afterCorrupt = await rankJobs(jobs, { prefs }, {
    maxLlm: 1, batchSize: 8, concurrency: 1, timeoutMs: 5000, totalTimeoutMs: 20_000,
    cache: { enabled: true, ttl_hours: 168 }, ask, detect, cli: 'claude',
  });
  // One cache hit (c2), one miss submitted under max_llm 1.
  assert.equal(afterCorrupt.telemetry.cache.hits, 1);
  assert.equal(afterCorrupt.calls, 1);
  assert.equal(afterCorrupt.telemetry.statusCounts.over_budget, 0);
});

test('watchlist bonus applies once to cached base scores', async () => {
  const j = job('w1', { watchlist: true });
  const key = rankCacheKey(j, { prefs, cli: 'claude', model: null });
  writeRankCache(key, { score: 4, why: 'long enough base model reason', cli: 'claude', model: null });
  const hit = readRankCache(key, { ttlHours: 168 });
  assert.equal(hit.score, 4);

  const ranked = [{ ...j, score: hit.score, why: hit.why, rankStatus: 'cache', heuristicOnly: false }];
  const withBonus = applyWatchlistBonus(ranked, 0.5);
  assert.equal(withBonus[0].modelScore, 4);
  assert.equal(withBonus[0].bonus, 0.5);
  assert.equal(withBonus[0].score, 4.5);
});
