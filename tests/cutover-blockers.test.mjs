// Regression coverage for the four cutover blockers.
// These scenarios are migration-critical; a green suite without them is not acceptance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'huntley-cutover-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
mkdirSync(join(root, 'config'), { recursive: true });

const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
ensureDirs();

const { scanBoards, recoverObservationJobs, DEFAULT_BOARD_LANE_TIMEOUT_MS } = await import('../src/sources/boards/collect.mjs');
const {
  writeBoardObservation,
  loadObservations,
  loadCheckpoint,
  sweepStatePaths,
  newRunId,
  observationBoardKey,
} = await import('../src/sources/boards/state.mjs');
const { scanDirectory } = await import('../src/sources/boards/sweeps/directory.mjs');
const { runLanes, normalizeLaneResult } = await import('../src/lib/lanes.mjs');
const { makeHttpCtx } = await import('../src/sources/boards/http/http.mjs');

function ghJobs(slug, n = 1) {
  return {
    jobs: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      title: 'Research Engineer',
      absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${i + 1}`,
      location: { name: 'San Francisco' },
      first_published: '2026-09-10T00:00:00.000Z',
    })),
  };
}

function waitForAbort(signal, ms = 5_000) {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) return fail();
    const t = setTimeout(fail, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      fail();
    }, { once: true });
  });
}

function httpFromHandlers(handlers) {
  const fetchJsonImpl = async (url, opts = {}) => {
    for (const h of handlers) {
      const out = await h(String(url), opts);
      if (out !== undefined) return out;
    }
    throw new Error(`unexpected fetchJson ${url}`);
  };
  return {
    fetchJson: fetchJsonImpl,
    fetchText: async () => '',
    fetchTextHead: async () => '',
    fetchResponse: async () => new Response(''),
  };
}

// ── 1. Sweep checkpoints ─────────────────────────────────────────────

test('sweep checkpoint resets after a completed directory so the next run rescans', async () => {
  const stateRoot = join(root, 'sweep-reset');
  mkdirSync(stateRoot, { recursive: true });
  const http = httpFromHandlers([
    async (url) => {
      if (url.includes('boards-api.greenhouse.io')) return ghJobs('solo');
      return undefined;
    },
  ]);

  const first = await scanDirectory({
    ats: 'greenhouse',
    companies: ['solo'],
    stateRoot,
    http,
    resume: true,
    prefs: {},
    concurrency: 1,
    timeoutMinutes: 5,
    today: '2026-09-14',
  });
  assert.equal(first.stats.scanned, 1);
  assert.equal(first.stats.complete, true);
  const paths = sweepStatePaths('greenhouse', stateRoot);
  assert.equal(existsSync(paths.checkpoint), false, 'completed sweep must clear checkpoint');

  const second = await scanDirectory({
    ats: 'greenhouse',
    companies: ['solo'],
    stateRoot,
    http,
    resume: true,
    prefs: {},
    concurrency: 1,
    timeoutMinutes: 5,
    today: '2026-09-14',
  });
  assert.equal(second.stats.scanned, 1, 'next invocation must not permanently skip the board');
});

test('sweep checkpoint advances only through boards that actually completed', async () => {
  const stateRoot = join(root, 'sweep-partial');
  mkdirSync(stateRoot, { recursive: true });
  let apiCalls = 0;
  const http = httpFromHandlers([
    async (url, opts) => {
      if (!url.includes('boards-api.greenhouse.io')) return undefined;
      const n = apiCalls++;
      if (n === 0) return ghJobs('co0');
      // Remaining boards hang until the collection deadline cancels them.
      await waitForAbort(opts.signal);
      return ghJobs(`co${n}`);
    },
  ]);

  const companies = Array.from({ length: 10 }, (_, i) => `co${i}`);
  const deadlineAt = Date.now() + 80;
  const result = await scanDirectory({
    ats: 'greenhouse',
    companies,
    stateRoot,
    http,
    resume: true,
    prefs: {},
    concurrency: 1,
    deadlineAt,
    today: '2026-09-14',
  });

  assert.ok(result.stats.scanned >= 1, `expected at least one dispatch, scanned ${result.stats.scanned}`);
  assert.ok(result.stats.scanned < 8, `must not treat the whole chunk as scanned (${result.stats.scanned})`);
  assert.equal(result.stats.complete, false);
  const cp = loadCheckpoint(sweepStatePaths('greenhouse', stateRoot).checkpoint);
  assert.ok(cp, 'partial sweep keeps a checkpoint');
  assert.equal(cp.index, 1, `must not skip untouched boards (saved index ${cp.index})`);
  assert.ok(cp.directoryFingerprint, 'checkpoint binds directory fingerprint');
});

test('sweep resume ignores checkpoints from a different directory fingerprint', async () => {
  const stateRoot = join(root, 'sweep-fp');
  mkdirSync(stateRoot, { recursive: true });
  const http = httpFromHandlers([
    async (url) => (url.includes('boards-api') ? ghJobs('a') : undefined),
  ]);

  await scanDirectory({
    ats: 'greenhouse',
    companies: ['a', 'b', 'c'],
    stateRoot,
    http: httpFromHandlers([
      async (url, opts) => {
        if (!url.includes('boards-api')) return undefined;
        if (url.includes('/a/')) return ghJobs('a');
        await waitForAbort(opts.signal);
        return ghJobs('x');
      },
    ]),
    concurrency: 1,
    deadlineAt: Date.now() + 60,
    today: '2026-09-14',
  });
  const mid = loadCheckpoint(sweepStatePaths('greenhouse', stateRoot).checkpoint);
  assert.equal(mid?.index, 1);

  // Directory changed — fingerprint mismatch must restart from 0.
  const restarted = await scanDirectory({
    ats: 'greenhouse',
    companies: ['z', 'a', 'b'],
    stateRoot,
    http,
    concurrency: 2,
    timeoutMinutes: 5,
    today: '2026-09-14',
  });
  assert.ok(restarted.stats.scanned >= 1);
  assert.notEqual(restarted.stats.startedAt, 1, 'must not resume stale index after directory change');
});

// ── 2. Observation identity / same-day retries ───────────────────────

test('same-day retry with a failed scan does not erase an earlier successful observation', async () => {
  const stateRoot = join(root, 'obs-retry');
  mkdirSync(stateRoot, { recursive: true });
  const entry = {
    name: 'Acme',
    careers_url: 'https://job-boards.greenhouse.io/acme',
    provider: 'greenhouse',
  };
  const okHttp = httpFromHandlers([
    async (url) => (url.includes('boards-api') ? ghJobs('acme') : undefined),
  ]);
  const failHttp = httpFromHandlers([
    async () => {
      const err = new Error('HTTP 500');
      err.status = 500;
      throw err;
    },
  ]);

  const day = '2026-09-14';
  const first = await scanBoards([entry], {
    lane: 'watchlist',
    stateRoot,
    http: okHttp,
    today: day,
    runId: newRunId(day),
    timeoutMs: null,
    prefs: {},
  });
  assert.equal(first.jobs.length, 1);

  const second = await scanBoards([entry], {
    lane: 'watchlist',
    stateRoot,
    http: failHttp,
    today: day,
    runId: newRunId(day),
    timeoutMs: null,
    prefs: {},
  });
  assert.equal(second.jobs.length, 0);
  assert.equal(second.errors.length, 1);

  const recovered = recoverObservationJobs({
    sinceDays: 2,
    today: day,
    root: stateRoot,
    watchlistKeys: new Set(['acme']),
  });
  assert.equal(recovered.jobs.length, 1, 'undelivered job must survive the failed retry');
  assert.match(recovered.jobs[0].url, /acme\/jobs\/1/);
});

test('newRunId is unique within a day and observationBoardKey is collision-resistant', () => {
  const a = newRunId('2026-09-14');
  const b = newRunId('2026-09-14');
  assert.notEqual(a, b);
  assert.match(a, /^2026-09-14_/);
  assert.notEqual(
    observationBoardKey('https://job-boards.greenhouse.io/acme'),
    observationBoardKey('https://job-boards.greenhouse.io/acme-extra'),
  );
  assert.equal(
    observationBoardKey('https://job-boards.greenhouse.io/acme/'),
    observationBoardKey('https://job-boards.greenhouse.io/acme'),
  );
});

test('writeBoardObservation refuses to overwrite a successful file with an empty failure', () => {
  const stateRoot = join(root, 'obs-preserve');
  const boardKey = 'https://job-boards.greenhouse.io/keep';
  writeBoardObservation({
    runId: 'same-run',
    lane: 'watchlist',
    boardKey,
    observedAt: '2026-09-14',
    jobs: [{ url: 'https://job-boards.greenhouse.io/keep/jobs/1', title: 'Engineer', company: 'Keep', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-14' }],
    outcome: { ok: true },
  }, { root: stateRoot });
  writeBoardObservation({
    runId: 'same-run',
    lane: 'watchlist',
    boardKey,
    observedAt: '2026-09-14',
    jobs: [],
    outcome: { ok: false, type: 'http_5xx' },
  }, { root: stateRoot });
  const rows = loadObservations({ sinceDate: '2026-09-14', root: stateRoot });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobs.length, 1);
});

// ── 3. Deadline cancellation ─────────────────────────────────────────

test('collection deadline cancels in-flight HTTP and returns within the budget', async () => {
  const stateRoot = join(root, 'deadline');
  mkdirSync(stateRoot, { recursive: true });
  const http = httpFromHandlers([
    async (url, opts) => {
      if (!url.includes('boards-api')) return undefined;
      await waitForAbort(opts.signal, 5_000);
      return ghJobs('slow');
    },
  ]);

  const t0 = Date.now();
  const result = await scanBoards([{
    name: 'Slow',
    careers_url: 'https://job-boards.greenhouse.io/slow',
    provider: 'greenhouse',
  }], {
    lane: 'watchlist',
    stateRoot,
    http,
    today: '2026-09-14',
    deadlineAt: Date.now() + 25,
    timeoutMs: null,
    prefs: {},
    concurrency: 1,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, `deadline must cancel in-flight work, took ${elapsed}ms`);
  assert.equal(result.stats.aborted, true);
});

test('completed boards are kept when a later board hits the deadline', async () => {
  const stateRoot = join(root, 'deadline-partial');
  mkdirSync(stateRoot, { recursive: true });
  let n = 0;
  const http = httpFromHandlers([
    async (url, opts) => {
      if (!url.includes('boards-api')) return undefined;
      const i = n++;
      if (i === 0) return ghJobs('fast');
      await waitForAbort(opts.signal, 5_000);
      return ghJobs('late');
    },
  ]);

  const result = await scanBoards([
    { name: 'Fast', careers_url: 'https://job-boards.greenhouse.io/fast', provider: 'greenhouse' },
    { name: 'Late', careers_url: 'https://job-boards.greenhouse.io/late', provider: 'greenhouse' },
  ], {
    lane: 'watchlist',
    stateRoot,
    http,
    today: '2026-09-14',
    deadlineAt: Date.now() + 40,
    timeoutMs: null,
    prefs: {},
    concurrency: 1,
  });

  assert.equal(result.jobs.length, 1);
  assert.match(result.jobs[0].url, /fast/);
  assert.equal(result.stats.aborted, true);
});

test('ordinary board lanes default to a finite collection deadline', () => {
  assert.ok(DEFAULT_BOARD_LANE_TIMEOUT_MS > 0);
  assert.equal(DEFAULT_BOARD_LANE_TIMEOUT_MS, 30 * 60_000);
});

test('makeHttpCtx fetchJson aborts when deadlineAt has already passed', async () => {
  const ctx = makeHttpCtx({ deadlineAt: Date.now() - 1 });
  await assert.rejects(() => ctx.fetchJson('https://example.invalid/x'), /deadline|AbortError|Aborted/i);
});

// ── 4. Structured errors → digest / run health ───────────────────────

test('runLanes records total board failure as failed + warning', async () => {
  const out = await runLanes([
    {
      name: 'watchlist',
      run: async () => ({
        jobs: [],
        errors: [
          { board: 'A', message: 'boom' },
          { board: 'B', message: 'boom' },
        ],
        stats: { scanned: 2, boardsCompleted: 0, boardsFailed: 2, kept: 0 },
      }),
    },
    { name: 'linkedin', run: async () => [{ id: 'li' }] },
  ]);
  assert.deepEqual(out.failed, ['watchlist']);
  assert.deepEqual(out.sources, ['linkedin']);
  assert.equal(out.jobs.length, 1);
  assert.match(out.warnings[0], /watchlist.*board error/);
});

test('runLanes records partial board failure as warning without failing the lane', async () => {
  const out = await runLanes([
    {
      name: 'watchlist',
      run: async () => ({
        jobs: [{ id: 'kept' }],
        errors: [{ board: 'Broken', message: '404' }],
        stats: { scanned: 2, boardsCompleted: 1, boardsFailed: 1, kept: 1 },
      }),
    },
  ]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.sources, ['watchlist']);
  assert.deepEqual(out.jobs, [{ id: 'kept' }]);
  assert.match(out.warnings[0], /Broken/);
});

test('empty successful board plus a failed board is partial, not total failure', async () => {
  const out = await runLanes([
    {
      name: 'watchlist',
      run: async () => ({
        jobs: [],
        errors: [{ board: 'Broken', message: '500' }],
        stats: { scanned: 2, boardsCompleted: 1, boardsFailed: 1, kept: 0 },
      }),
    },
  ]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.sources, ['watchlist']);
  assert.match(out.warnings.join(' '), /Broken/);
});

test('normalizeLaneResult still accepts plain job arrays', () => {
  assert.deepEqual(normalizeLaneResult([{ id: 1 }]).jobs, [{ id: 1 }]);
  assert.equal(normalizeLaneResult([{ id: 1 }]).totalFailure, false);
});

test('scanBoards surfaces structured errors alongside jobs', async () => {
  const stateRoot = join(root, 'errors');
  mkdirSync(stateRoot, { recursive: true });
  const result = await scanBoards([
    { name: 'Ok', careers_url: 'https://job-boards.greenhouse.io/ok', provider: 'greenhouse' },
    { name: 'Nope', careers_url: 'https://example.com/careers', provider: 'not-a-real-provider' },
  ], {
    lane: 'watchlist',
    stateRoot,
    http: httpFromHandlers([
      async (url) => (url.includes('/ok/') || url.includes('/ok?') || url.includes('boards/ok/') ? ghJobs('ok') : undefined),
    ]),
    today: '2026-09-14',
    timeoutMs: null,
    prefs: {},
    concurrency: 2,
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /unknown provider|not-a-real/);
  assert.ok(result.stats.scanned >= 2);
  assert.equal(result.stats.boardsCompleted, 1);
  assert.equal(result.stats.boardsFailed, 1);
});

// ── Composed paths (interaction of the pieces) ───────────────────────

test('retry backoff aborts before the next attempt when the deadline elapses', async () => {
  const { fetchJsonWithRetry } = await import('../src/sources/boards/http/http.mjs');
  let attempts = 0;
  const ctx = {
    deadlineAt: Date.now() + 20,
    fetchJson: async () => {
      attempts++;
      const err = new Error('HTTP 503');
      err.status = 503;
      throw err;
    },
  };
  const t0 = Date.now();
  await assert.rejects(
    () => fetchJsonWithRetry(ctx, 'https://example.invalid/x', {}, {
      retries: 5,
      baseDelayMs: 400,
      maxDelayMs: 800,
    }),
    /AbortError|deadline|Aborted/i,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150, `retry sleep must not overrun deadline, took ${elapsed}ms`);
  assert.ok(attempts <= 2, `must not keep issuing requests after deadline (attempts=${attempts})`);
});

test('deadline-aborted scanBoards is not reported healthy by runLanes', async () => {
  const stateRoot = join(root, 'abort-health');
  mkdirSync(stateRoot, { recursive: true });
  const http = httpFromHandlers([
    async (url, opts) => {
      if (!url.includes('boards-api')) return undefined;
      await waitForAbort(opts.signal, 5_000);
      return ghJobs('late');
    },
  ]);

  const scanned = await scanBoards([{
    name: 'Late',
    careers_url: 'https://job-boards.greenhouse.io/late',
    provider: 'greenhouse',
  }], {
    lane: 'watchlist',
    stateRoot,
    http,
    today: '2026-09-14',
    deadlineAt: Date.now() + 25,
    timeoutMs: null,
    prefs: {},
    concurrency: 1,
  });
  assert.equal(scanned.stats.aborted, true);
  assert.equal(scanned.stats.boardsCompleted, 0);

  const out = await runLanes([{ name: 'watchlist', run: async () => scanned }]);
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.failed, ['watchlist']);
  assert.ok(out.warnings.some((w) => /abort/i.test(w)));
});

test('partial deadline abort warns but keeps completed boards in sources', async () => {
  const stateRoot = join(root, 'abort-partial-health');
  mkdirSync(stateRoot, { recursive: true });
  let n = 0;
  const http = httpFromHandlers([
    async (url, opts) => {
      if (!url.includes('boards-api')) return undefined;
      const i = n++;
      if (i === 0) return ghJobs('fast');
      await waitForAbort(opts.signal, 5_000);
      return ghJobs('late');
    },
  ]);

  const scanned = await scanBoards([
    { name: 'Fast', careers_url: 'https://job-boards.greenhouse.io/fast', provider: 'greenhouse' },
    { name: 'Late', careers_url: 'https://job-boards.greenhouse.io/late', provider: 'greenhouse' },
  ], {
    lane: 'watchlist',
    stateRoot,
    http,
    today: '2026-09-14',
    deadlineAt: Date.now() + 40,
    timeoutMs: null,
    prefs: {},
    concurrency: 1,
  });

  const out = await runLanes([{ name: 'watchlist', run: async () => scanned }]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.sources, ['watchlist']);
  assert.equal(out.jobs.length, 1);
  assert.ok(out.warnings.some((w) => /abort/i.test(w)));
});

test('dataset fallback failures reach runLanes as structured errors', async () => {
  const { runDatasetLane } = await import('../src/sources/ats-lanes.mjs');
  const warnings = [];
  const out = await runLanes([{
    name: 'ats_dataset',
    run: () => runDatasetLane({
      prefs: {},
      warn: (w) => warnings.push(w),
      settings: { fallback_sweep: ['greenhouse', 'lever'] },
      downloadDatasetFn: async () => ({ error: 'network down' }),
      scanAtsSweepFn: async ({ ats }) => ({
        jobs: ats === 'greenhouse'
          ? [{ id: 'g1', url: 'https://job-boards.greenhouse.io/x/jobs/1', title: 'Engineer', company: 'X' }]
          : [],
        errors: ats === 'lever'
          ? [{ board: 'dead-co', message: 'HTTP 404', type: 'not_found' }]
          : [],
        stats: {
          scanned: 1,
          boardsCompleted: ats === 'greenhouse' ? 1 : 0,
          boardsFailed: ats === 'lever' ? 1 : 0,
          kept: ats === 'greenhouse' ? 1 : 0,
        },
      }),
    }),
  }]);

  assert.ok(warnings.some((w) => /ATS dataset/i.test(w)));
  assert.deepEqual(out.sources, ['ats_dataset']);
  assert.deepEqual(out.failed, []);
  assert.equal(out.jobs.length, 1);
  assert.ok(out.warnings.some((w) => /dead-co|board error/i.test(w)));
});

test('dataset fallback total board failure fails the lane', async () => {
  const { runDatasetLane } = await import('../src/sources/ats-lanes.mjs');
  const out = await runLanes([{
    name: 'ats_dataset',
    run: () => runDatasetLane({
      prefs: {},
      warn: () => {},
      settings: { fallback_sweep: ['greenhouse'] },
      downloadDatasetFn: async () => ({ error: 'gone' }),
      scanAtsSweepFn: async () => ({
        jobs: [],
        errors: [{ board: 'a', message: 'boom' }, { board: 'b', message: 'boom' }],
        stats: { scanned: 2, boardsCompleted: 0, boardsFailed: 2, kept: 0 },
      }),
    }),
  }]);
  assert.deepEqual(out.failed, ['ats_dataset']);
  assert.deepEqual(out.sources, []);
  assert.ok(out.warnings.some((w) => /board error/i.test(w)));
});

// ── Provider-swallowed cancellation / incomplete boards ──────────────

test('provider that returns partial jobs after abort is incomplete, not completed', async () => {
  const stateRoot = join(root, 'partial-abort');
  mkdirSync(stateRoot, { recursive: true });
  const providers = new Map([['partial', {
    id: 'partial',
    async fetch(_entry, ctx) {
      try {
        await waitForAbort(ctx.signal, 5_000);
      } catch {
        /* aborted mid-pagination — return pages already fetched */
      }
      return [{
        title: 'Research Engineer',
        url: 'https://jobs.example.com/partial/1',
        company: 'PartialCo',
        location: 'Remote',
      }];
    },
  }]]);

  const result = await scanBoards([{
    name: 'PartialCo',
    provider: 'partial',
    careers_url: 'https://jobs.example.com/partial',
  }], {
    lane: 'watchlist',
    stateRoot,
    providers,
    today: '2026-09-14',
    deadlineAt: Date.now() + 25,
    timeoutMs: null,
    prefs: {},
    concurrency: 1,
  });

  assert.equal(result.jobs.length, 1, 'partial jobs are preserved');
  assert.equal(result.stats.boardsCompleted, 0);
  assert.equal(result.stats.boardsAborted, 1);
  assert.equal(result.stats.aborted, true);

  const out = await runLanes([{ name: 'watchlist', run: async () => result }]);
  assert.deepEqual(out.failed, ['watchlist']);
  assert.deepEqual(out.sources, []);
  assert.ok(out.warnings.some((w) => /abort/i.test(w)));
});

test('provider incomplete marker keeps jobs but does not complete the board', async () => {
  const stateRoot = join(root, 'incomplete-flag');
  mkdirSync(stateRoot, { recursive: true });
  const providers = new Map([['trunc', {
    id: 'trunc',
    async fetch() {
      const jobs = [{
        title: 'Research Engineer',
        url: 'https://jobs.example.com/trunc/1',
        company: 'TruncCo',
        location: 'SF',
      }];
      jobs.incomplete = true;
      return jobs;
    },
  }]]);

  const result = await scanBoards([{
    name: 'TruncCo',
    provider: 'trunc',
    careers_url: 'https://jobs.example.com/trunc',
  }], {
    lane: 'watchlist',
    stateRoot,
    providers,
    today: '2026-09-14',
    timeoutMs: null,
    prefs: {},
  });

  assert.equal(result.jobs.length, 1);
  assert.equal(result.stats.boardsCompleted, 0);
  assert.equal(result.stats.boardsIncomplete, 1);
  assert.equal(result.errors[0]?.type, 'incomplete');

  const out = await runLanes([{ name: 'watchlist', run: async () => result }]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.sources, ['watchlist']);
  assert.ok(out.warnings.some((w) => /incomplete|board error/i.test(w)));
});

test('sweep checkpoint does not advance past an incomplete board', async () => {
  const stateRoot = join(root, 'sweep-incomplete');
  mkdirSync(stateRoot, { recursive: true });
  const providers = new Map([['greenhouse', {
    id: 'greenhouse',
    async fetch(entry) {
      const jobs = [{
        title: 'Research Engineer',
        url: `https://job-boards.greenhouse.io/${entry.name}/jobs/1`,
        company: entry.name,
        location: 'SF',
      }];
      if (entry.name === 'co0') jobs.incomplete = true;
      return jobs;
    },
  }]]);

  const done = [];
  await scanBoards(
    ['co0', 'co1'].map((name) => ({
      name,
      provider: 'greenhouse',
      careers_url: `https://job-boards.greenhouse.io/${name}`,
    })),
    {
      lane: 'ats_sweep_greenhouse',
      stateRoot,
      providers,
      today: '2026-09-14',
      timeoutMs: null,
      prefs: {},
      concurrency: 1,
      onBoardDone: (info) => done.push(info),
    },
  );

  assert.equal(done[0].completed, false);
  assert.equal(done[0].incomplete, true);
  assert.equal(done[1].completed, true);

  // Contiguous checkpoint: co0 incomplete means cursor must stay at 0.
  const finished = new Set();
  const companies = ['co0', 'co1'];
  let cursor = 0;
  for (const info of done) {
    if (info.completed) finished.add(info.entryIndex);
  }
  while (cursor < companies.length && finished.has(cursor)) cursor++;
  assert.equal(cursor, 0, 'incomplete board must block checkpoint advance');
});

test('sweep stopped before dispatch sets aborted health', async () => {
  const stateRoot = join(root, 'sweep-pre-dispatch');
  mkdirSync(stateRoot, { recursive: true });
  const result = await scanDirectory({
    ats: 'greenhouse',
    companies: ['a', 'b', 'c'],
    stateRoot,
    http: httpFromHandlers([]),
    resume: false,
    prefs: {},
    concurrency: 1,
    deadlineAt: Date.now() - 1, // already expired before any board dispatch
    today: '2026-09-14',
  });

  assert.equal(result.stats.aborted, true);
  assert.equal(result.stats.scanned, 0);
  assert.equal(result.stats.complete, false);

  const out = await runLanes([{ name: 'ats_sweep', run: async () => result }]);
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.failed, ['ats_sweep']);
  assert.ok(out.warnings.some((w) => /abort/i.test(w)));
});

test('sweep budget applies to the company-directory download', async () => {
  const stateRoot = join(root, 'sweep-dir-budget');
  mkdirSync(stateRoot, { recursive: true });
  let sawDeadline = false;
  const http = {
    fetchJson: async (_url, opts = {}) => {
      sawDeadline = opts.deadlineAt != null || opts.signal != null;
      await waitForAbort(opts.signal, 5_000);
      return ['solo'];
    },
  };

  const t0 = Date.now();
  const result = await scanDirectory({
    ats: 'greenhouse',
    stateRoot,
    http,
    resume: false,
    prefs: {},
    deadlineAt: Date.now() + 30,
    today: '2026-09-14',
  });
  const elapsed = Date.now() - t0;

  assert.ok(sawDeadline, 'directory fetch must receive the sweep signal/deadline');
  assert.ok(elapsed < 200, `directory download must honour deadline, took ${elapsed}ms`);
  assert.equal(result.stats.aborted, true);
});
