import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'huntley-test-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = root;

const { PATHS } = await import('../src/lib/paths.mjs');
assert.ok(PATHS.collection.startsWith(root), `PATHS.collection must be under scratch dir, got ${PATHS.collection}`);

const { writeBoardObservation, loadObservations, pruneObservations, pruneCommittedObservations, observationsDir, runIdDate } = await import('../src/sources/boards/state.mjs');
const { recoverObservationJobs } = await import('../src/sources/boards/collect.mjs');
const { watchlistCompanyKeys, prepareScan, scanState, endScan, collectRecoveryJobs } = await import('../src/sources/board-collection.mjs');

test('board observations persist atomically and load within lookback', () => {
  writeBoardObservation({
    runId: '2026-09-11',
    lane: 'watchlist',
    boardKey: 'https://boards.greenhouse.io/acme',
    observedAt: '2026-09-11',
    jobs: [{
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      title: 'Research Engineer',
      company: 'Acme',
      location: 'SF',
      source: 'watchlist',
      sourceDetail: 'greenhouse',
      firstSeen: '2026-09-11',
      watchlist: true,
    }],
    outcome: { ok: true },
  });
  writeBoardObservation({
    runId: '2026-09-10',
    lane: 'watchlist',
    boardKey: 'https://boards.greenhouse.io/acme',
    observedAt: '2026-09-10',
    jobs: [{
      url: 'https://boards.greenhouse.io/acme/jobs/2',
      title: 'Member of Technical Staff',
      company: 'Acme',
      source: 'watchlist',
      sourceDetail: 'greenhouse',
      firstSeen: '2026-09-10',
      watchlist: true,
    }],
    outcome: { ok: true },
  });
  writeBoardObservation({
    runId: '2026-09-08',
    lane: 'watchlist',
    boardKey: 'old',
    observedAt: '2026-09-08',
    jobs: [{ url: 'https://boards.greenhouse.io/acme/jobs/3', title: 'Research Scientist', company: 'Acme', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-08' }],
    outcome: { ok: true },
  });

  const windowed = loadObservations({ sinceDate: '2026-09-09' });
  assert.equal(windowed.reduce((n, r) => n + r.jobs.length, 0), 2);

  const recovered = recoverObservationJobs({ today: '2026-09-11', watchlistKeys: new Set(['acme']) });
  assert.equal(recovered.jobs.length, 3);
  assert.ok(recovered.jobs.every((j) => j.url && j.title));
});

test('only tracked_companies get watchlist treatment, not portfolio boards', async () => {
  writeFileSync(PATHS.watchlist, `
tracked_companies:
  - name: "Goodfire"
    careers_url: "https://job-boards.greenhouse.io/goodfire"
    enabled: true
  - name: "Dormant Co"
    careers_url: "https://dormant.example/careers"
    enabled: false
portfolio_boards:
  - name: "Sequoia Capital (portfolio)"
    careers_url: "https://jobs.sequoiacap.com/jobs"
    provider: consider
    enabled: true
`);
  const keys = await watchlistCompanyKeys();
  assert.deepEqual([...keys], ['goodfire']);
});

test('a missing or malformed watchlist yields an empty watchlist, not a crash', async () => {
  writeFileSync(PATHS.watchlist, 'tracked_companies: [this is: not, valid: yaml\n');
  assert.equal((await watchlistCompanyKeys()).size, 0);
});

test('a dry run writes observations to a temporary tree, not the real collection dir', async () => {
  writeFileSync(PATHS.watchlist, 'tracked_companies: []\nportfolio_boards: []\n');
  mkdirSync(PATHS.collection, { recursive: true });
  prepareScan({}, { dryRun: true });
  const state = scanState();
  assert.equal(state.preview, true);
  assert.ok(state.root !== PATHS.collection);

  writeBoardObservation({
    runId: 'dry',
    lane: 'watchlist',
    boardKey: 'https://example.com',
    observedAt: '2026-09-11',
    jobs: [{ url: 'https://example.com/j/1', title: 'Engineer', company: 'Ex', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-11' }],
    outcome: { ok: true },
  }, { dryRun: true, previewRoot: state.root });

  const fromPreview = collectRecoveryJobs({ sinceDays: 3, today: '2026-09-11' });
  assert.equal(fromPreview.jobs.length, 1);
  endScan();
  assert.equal(scanState().preview, false);
});

test('observation run directories older than the lookback are pruned by name without opening them', () => {
  assert.equal(runIdDate('2026-09-01_12-00-00-000Z_abcd'), '2026-09-01');
  const root = join(PATHS.collection, 'prune-fixture');
  writeBoardObservation({
    runId: '2026-09-01_old',
    lane: 'watchlist',
    boardKey: 'https://job-boards.greenhouse.io/old',
    observedAt: '2026-09-01',
    jobs: [{ url: 'https://job-boards.greenhouse.io/old/jobs/1', title: 'Engineer', company: 'Old', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-01' }],
    outcome: { ok: true },
  }, { root });
  writeBoardObservation({
    runId: '2026-09-10_new',
    lane: 'watchlist',
    boardKey: 'https://job-boards.greenhouse.io/new',
    observedAt: '2026-09-10',
    jobs: [{ url: 'https://job-boards.greenhouse.io/new/jobs/1', title: 'Engineer', company: 'New', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-10' }],
    outcome: { ok: true },
  }, { root });

  const pruned = pruneObservations({ sinceDate: '2026-09-09', root });
  assert.equal(pruned.removed, 1);
  const dir = observationsDir(root);
  assert.equal(existsSync(join(dir, '2026-09-01_old')), false);
  assert.equal(existsSync(join(dir, '2026-09-10_new')), true);

  const loaded = loadObservations({ sinceDate: '2026-09-09', root });
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].runId, /2026-09-10/);
});

test('committed observation folders are deleted and skipped on recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'huntley-obs-'));
  writeBoardObservation({
    runId: 'run-committed',
    lane: 'watchlist',
    boardKey: 'https://job-boards.greenhouse.io/old',
    observedAt: '2026-09-01',
    jobs: [{ url: 'https://job-boards.greenhouse.io/old/jobs/1', title: 'Engineer', company: 'Old', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-01' }],
    outcome: { ok: true },
  }, { root });
  writeBoardObservation({
    runId: 'run-open',
    lane: 'watchlist',
    boardKey: 'https://job-boards.greenhouse.io/open',
    observedAt: '2026-09-10',
    jobs: [{ url: 'https://job-boards.greenhouse.io/open/jobs/1', title: 'Engineer', company: 'Open', source: 'watchlist', sourceDetail: 'greenhouse', firstSeen: '2026-09-10' }],
    outcome: { ok: true },
  }, { root });

  const skipped = recoverObservationJobs({
    today: '2026-09-11',
    watchlistKeys: new Set(['old', 'open']),
    root,
    excludeRunIds: ['run-committed'],
  });
  assert.equal(skipped.jobs.length, 1);
  assert.match(skipped.jobs[0].url, /open/);

  const pruned = pruneCommittedObservations({ committedRunIds: ['run-committed'], root });
  assert.equal(pruned.removed, 1);
  const dir = observationsDir(root);
  assert.equal(existsSync(join(dir, 'run-committed')), false);
  assert.equal(existsSync(join(dir, 'run-open')), true);
});
