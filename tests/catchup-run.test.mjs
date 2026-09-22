import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const root = mkdtempSync(join(tmpdir(), 'huntley-catchup-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
process.env.PATH = `${join(REPO, 'tests', 'fixtures', 'bin')}:${process.env.PATH}`;
delete process.env.HUNTLEY_LINK_SECRET;
process.env.HUNTLEY_SHEET_CSV_URL = '';

mkdirSync(process.env.HUNTLEY_CONFIG_DIR, { recursive: true });
const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
ensureDirs();

writeFileSync(PATHS.huntleyConfig, `
identity: { name: "Test", email: "test@example.invalid" }
sources: { watchlist: { enabled: true } }
rank: { cli: claude, max_llm: 10, batch_size: 8, concurrency: 1, min_score: 3.0, max_per_company: 3, timeout_ms: 20000, total_timeout_ms: 60000 }
enrichment: { enabled: false }
digest: { send_on_zero_matches: false, max_rows: 40 }
email: { provider: console, from: "huntley@example.invalid", to: "test@example.invalid" }
sheet: { enabled: false }
collection: { mode: since_last_success, initial_lookback_days: 30, overlap_hours: 48 }
`);
writeFileSync(PATHS.preferences, `
targets:
  role_terms: ["engineer*"]
  title_keywords: ["research"]
background: { summary: "A test operator." }
location: { allow: ["California"], remote: accept }
`);
writeFileSync(PATHS.watchlist, 'tracked_companies: []\n');

const { toJob } = await import('../src/normalize.mjs');
const { jobId } = await import('../src/dedupe.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { runHuntley } = await import('../src/run.mjs');
const { crashPoints, pendingEmailQueue } = await import('../src/state/catchup.mjs');

function snapshot(n, { date = '2026-09-14', start = 1000 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const job = toJob({
      url: `https://boards.greenhouse.io/acme/jobs/${start + i}`,
      title: 'Research Engineer',
      company: i % 10 === 0 ? `Co${Math.floor(i / 10)}` : `Co${Math.floor(i / 10)}`,
      location: 'San Francisco, CA',
      source: 'ats_sweep',
      firstSeen: date,
      // Distinct per posting: the rank cache keys on what the model is asked,
      // not on the posting id, so rows identical in every scored field would
      // legitimately share one cached judgment.
      description: `Build evals for system ${start + i}.`,
    });
    return job ? { ...job, id: jobId(job) } : null;
  }).filter(Boolean);
}

test('120 eligible roles appear in the complete report even when email and model budgets cap', async () => {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(join(PATHS.runs, '2026-09-14-raw.json'), JSON.stringify(snapshot(120), null, 2));
  const result = await runHuntley(loadConfig(), { noScan: true, runId: '2026-09-14', dryRun: true });
  const report = readFileSync(result.reportPath, 'utf8');
  assert.match(report, /Research Engineer/);
  const exportRows = JSON.parse(readFileSync(join(result.runDir, 'roles.json'), 'utf8'));
  assert.ok(exportRows.length >= 120, `export has ${exportRows.length}`);
  assert.ok(result.shown.length <= 40, 'email summary is capped');
  assert.ok((result.unscored?.length ?? 0) > 0, 'budget-limited roles stay unscored');
  assert.ok(result.eligible.every((j) => j.rankStatus === 'model' || j.rankStatus === 'cache'), 'only model/cache scores are published');
  assert.equal(result.eligible.filter((j) => j.rankStatus === 'over_budget' || j.rankStatus === 'failed').length, 0);
  assert.match(report, /Unscored/);
  assert.doesNotMatch(report, /Add buttons are off/);
});

test('preview does not write durable progress or seen state', async () => {
  assert.ok(!existsSync(PATHS.seen));
  const progressBefore = existsSync(PATHS.progress) ? readFileSync(PATHS.progress, 'utf8') : '';
  await runHuntley(loadConfig(), { noScan: true, runId: '2026-09-14', dryRun: true });
  assert.ok(!existsSync(PATHS.seen));
  const progressAfter = existsSync(PATHS.progress) ? readFileSync(PATHS.progress, 'utf8') : '';
  assert.equal(progressAfter, progressBefore);
});

test('crash after collection still recovers captured roles on the next run', async () => {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(join(PATHS.runs, '2026-09-15-raw.json'), JSON.stringify(snapshot(3, { date: '2026-09-15' }), null, 2));
  crashPoints.next = 'after-ingest';
  await assert.rejects(() => runHuntley(loadConfig(), { noScan: true, runId: '2026-09-15' }), /crash-injected:after-ingest/);
  crashPoints.next = null;
  const roles = JSON.parse(readFileSync(PATHS.roles, 'utf8'));
  assert.ok(Object.keys(roles.roles).length >= 3, 'ingested roles survived the crash');
  const result = await runHuntley(loadConfig(), { noScan: true, runId: '2026-09-15' });
  assert.ok(result.eligible.length + result.unscored.length + result.stats.belowThreshold >= 3);
  assert.ok(existsSync(result.reportPath));
});

test('zero matches still commit a local summary when email-on-zero is disabled', async () => {
  writeFileSync(PATHS.roles, JSON.stringify({ schema: 1, roles: {}, aliases: {} }));
  writeFileSync(join(PATHS.runs, 'empty-raw.json'), '[]');
  const result = await runHuntley(loadConfig(), { noScan: true, runId: 'empty' });
  assert.equal(result.sent, false);
  assert.equal(result.delivery, 'skipped');
  assert.ok(existsSync(join(result.runDir, 'report.html')));
});

test('incompatible flags are refused before any work starts', async () => {
  await assert.rejects(
    () => runHuntley(loadConfig(), { fresh: true, noScan: true }),
    /refuse --fresh --no-scan/,
  );
  await assert.rejects(
    () => runHuntley(loadConfig(), { since: '2026-09-01', noScan: true }),
    /refuse --since --no-scan/,
  );
});

function resetLedger() {
  writeFileSync(PATHS.roles, JSON.stringify({ schema: 1, roles: {}, aliases: {} }));
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [], pendingEmails: [], pendingEmail: null, migration: { version: 1 },
  }));
}

test('a crash after publication still retries email on the next run', async () => {
  resetLedger();
  writeFileSync(join(PATHS.runs, 'mail-crash-raw.json'), JSON.stringify(snapshot(1), null, 2));
  const sent = [];
  const mailer = {
    send: async (msg) => {
      sent.push(msg.subject);
      return { ok: true, sent: true, id: 'msg-1' };
    },
  };
  const cfg = loadConfig();
  cfg.rank.min_score = 0;
  cfg.digest.send_on_zero_matches = false;
  crashPoints.next = 'after-publish';
  await assert.rejects(
    () => runHuntley(cfg, { noScan: true, runId: 'mail-crash', mailer }),
    /crash-injected:after-publish/,
  );
  crashPoints.next = null;
  assert.equal(sent.length, 0, 'send must not run before delivery intent is persisted');
  const queued = pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8')));
  assert.equal(queued.length, 1);
  const result = await runHuntley(cfg, { noScan: true, runId: 'mail-crash', mailer });
  assert.ok(sent.length >= 1, 'the persisted delivery is retried');
  assert.equal(pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8'))).length, 0);
  assert.equal(result.exitCode, 0);
});

test('a failed email retry is not overwritten by a later run', async () => {
  resetLedger();
  mkdirSync(join(PATHS.runs, 'old-mail'), { recursive: true });
  writeFileSync(join(PATHS.runs, 'old-mail', 'report.html'), '<p>old complete report with Unscored overflow</p>');
  writeFileSync(join(PATHS.runs, 'old-mail', 'report.txt'), 'old complete report');
  writeFileSync(join(PATHS.runs, 'old-mail', 'email.json'), JSON.stringify({
    subject: 'huntley · old', html: '<p>old summary</p>', text: 'old summary',
  }));
  writeFileSync(join(PATHS.runs, 'old-mail', 'commit.json'), JSON.stringify({ schema: 1, phase: 'email-pending', runId: 'old-mail' }));
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [],
    pendingEmails: [{ runId: 'old-mail', subject: 'huntley · old' }],
    pendingEmail: { runId: 'old-mail', subject: 'huntley · old' },
    migration: { version: 1 },
  }));
  writeFileSync(join(PATHS.runs, 'mail-new-raw.json'), JSON.stringify(snapshot(1), null, 2));
  const mailer = {
    send: async () => ({ ok: false, error: 'smtp down' }),
  };
  const cfg = loadConfig();
  cfg.rank.min_score = 0;
  cfg.digest.send_on_zero_matches = false;
  const result = await runHuntley(cfg, { noScan: true, runId: 'mail-new', mailer });
  assert.equal(result.exitCode, 1);
  const queued = pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8')));
  const ids = queued.map((e) => e.runId);
  assert.ok(ids.includes('old-mail'), 'previous pending delivery remains');
  assert.ok(ids.includes(result.runId), 'the new run is queued instead of replacing the old one');
});

test('a legacy pending email without email.json blocks new delivery', async () => {
  resetLedger();
  mkdirSync(join(PATHS.runs, 'legacy-mail'), { recursive: true });
  writeFileSync(join(PATHS.runs, 'legacy-mail', 'report.html'), '<p>UNSCORED complete report</p>');
  writeFileSync(join(PATHS.runs, 'legacy-mail', 'report.txt'), 'UNSCORED complete report');
  writeFileSync(join(PATHS.runs, 'legacy-mail', 'commit.json'), JSON.stringify({
    schema: 1, phase: 'email-pending', runId: 'legacy-mail',
  }));
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [],
    pendingEmails: [{ runId: 'legacy-mail', subject: 'huntley · legacy' }],
    pendingEmail: { runId: 'legacy-mail', subject: 'huntley · legacy' },
    migration: { version: 1 },
  }));
  writeFileSync(join(PATHS.runs, 'legacy-new-raw.json'), JSON.stringify(snapshot(1, { start: 8000 }), null, 2));
  const sent = [];
  const mailer = {
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, sent: true, id: 'should-not-send' };
    },
  };
  const cfg = loadConfig();
  cfg.rank.min_score = 0;
  cfg.digest.send_on_zero_matches = false;
  const result = await runHuntley(cfg, { noScan: true, runId: 'legacy-new', mailer });
  assert.equal(result.exitCode, 1);
  assert.equal(sent.length, 0, 'new delivery must wait until the blocked retry is resolved');
  const queued = pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8')));
  assert.ok(queued.some((e) => e.runId === 'legacy-mail'), 'legacy pending remains');
  assert.ok(queued.some((e) => e.runId === result.runId), 'the new run is queued instead of sent');
  assert.ok(result.warnings.some((w) => /legacy-mail/.test(w) && /email\.json/.test(w) && /pendingEmails/.test(w)));
});

test('a crash after the ledger write still delivers the persisted email', async () => {
  resetLedger();
  writeFileSync(join(PATHS.runs, 'mail-ledger-raw.json'), JSON.stringify(snapshot(1, { start: 9000 }), null, 2));
  const sent = [];
  const mailer = {
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, sent: true, id: 'msg-ledger' };
    },
  };
  const cfg = loadConfig();
  cfg.rank.min_score = 0;
  cfg.digest.send_on_zero_matches = false;
  crashPoints.next = 'after-ledger';
  await assert.rejects(
    () => runHuntley(cfg, { noScan: true, runId: 'mail-ledger', mailer }),
    /crash-injected:after-ledger/,
  );
  crashPoints.next = null;
  const queued = pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8')));
  const crashedId = queued.find((e) => existsSync(join(PATHS.runs, e.runId, 'email.json')))?.runId;
  assert.ok(crashedId, 'delivery intent must be queued against a real run directory');
  const payload = JSON.parse(readFileSync(join(PATHS.runs, crashedId, 'email.json'), 'utf8'));
  assert.ok(!sent.some((m) => m.html === payload.html), 'send must not run before the crash');
  const roles = JSON.parse(readFileSync(PATHS.roles, 'utf8'));
  assert.ok(Object.values(roles.roles).some((r) => r.decision === 'published' || (r.publishedRunIds ?? []).length), 'ledger already marked published');
  const commit = JSON.parse(readFileSync(join(PATHS.runs, crashedId, 'commit.json'), 'utf8'));
  assert.notEqual(commit.phase, 'ingested', 'publication/delivery intent must be committed before the ledger write');
  const result = await runHuntley(cfg, { noScan: true, runId: 'mail-ledger', mailer });
  assert.ok(sent.some((m) => m.html === payload.html), 'the persisted delivery is retried');
  assert.ok(!pendingEmailQueue(JSON.parse(readFileSync(PATHS.progress, 'utf8'))).some((e) => e.runId === crashedId));
  assert.equal(result.eligible.length, 0, 'already published roles stay suppressed');
});

test('email retry sends the capped payload, not the complete report', async () => {
  resetLedger();
  mkdirSync(join(PATHS.runs, 'mail-cap'), { recursive: true });
  writeFileSync(join(PATHS.runs, 'mail-cap', 'report.html'), '<p>UNSCORED overflow and hundreds of rows</p>');
  writeFileSync(join(PATHS.runs, 'mail-cap', 'report.txt'), 'UNSCORED overflow');
  writeFileSync(join(PATHS.runs, 'mail-cap', 'email.json'), JSON.stringify({
    subject: 'huntley · capped', html: '<p>capped-summary</p>', text: 'capped-summary',
  }));
  writeFileSync(join(PATHS.runs, 'mail-cap', 'commit.json'), JSON.stringify({ schema: 1, phase: 'email-pending', runId: 'mail-cap', email: true }));
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [],
    pendingEmails: [{ runId: 'mail-cap', subject: 'huntley · capped' }],
    pendingEmail: { runId: 'mail-cap', subject: 'huntley · capped' },
    migration: { version: 1 },
  }));
  writeFileSync(join(PATHS.runs, 'empty-cap-raw.json'), '[]');
  const bodies = [];
  const mailer = {
    send: async (msg) => {
      bodies.push(msg.html);
      return { ok: true, sent: true, id: 'msg-cap' };
    },
  };
  await runHuntley(loadConfig(), { noScan: true, runId: 'empty-cap', mailer });
  assert.ok(bodies.includes('<p>capped-summary</p>'), 'retry must send the saved summary');
  assert.ok(bodies.every((html) => !String(html).includes('UNSCORED')), 'retry must not send the complete report');
});

function watchlistOnly(cfg) {
  for (const value of Object.values(cfg.sources ?? {})) {
    if (value && typeof value === 'object' && 'enabled' in value) value.enabled = false;
  }
  cfg.sources.watchlist = { enabled: true };
  return cfg;
}

test('--since is accepted when stored checkpoints already cover past the bootstrap floor', async () => {
  resetLedger();
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1,
    units: {
      'watchlist:https://jobs.ashbyhq.com/acme': { coveredThrough: '2026-09-14T12:00:00.000Z' },
      'linkedin:engineer|san francisco|': { coveredThrough: '2026-07-01T12:00:00.000Z' },
    },
    committedRunIds: [], pendingEmails: [], pendingEmail: null, migration: { version: 1 },
  }));
  const cfg = watchlistOnly(loadConfig());
  const result = await runHuntley(cfg, {
    since: '2026-09-01',
    dryRun: true,
    now: Date.parse('2026-11-01T12:00:00Z'),
  });
  assert.ok(result.runId);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(PATHS.runs, '2026-11-01-raw.json')), false, 'dry run must not write the date-keyed raw snapshot');
});

test('heuristic fallback scores are not published or marked below_threshold', async () => {
  resetLedger();
  writeFileSync(join(PATHS.runs, 'budget-raw.json'), JSON.stringify(snapshot(30, { start: 6100 }), null, 2));
  const cfg = loadConfig();
  cfg.rank.max_llm = 10;
  cfg.rank.max_per_company = 0;
  cfg.rank.min_score = 3;
  const result = await runHuntley(cfg, { noScan: true, runId: 'budget-raw' });
  assert.ok(result.eligible.every((j) => j.rankStatus === 'model' || j.rankStatus === 'cache'));
  assert.equal(result.eligible.filter((j) => j.heuristicOnly).length, 0);
  const roles = Object.values(JSON.parse(readFileSync(PATHS.roles, 'utf8')).roles);
  assert.equal(roles.filter((r) => r.decision === 'below_threshold' && r.rankStatus !== 'model' && r.rankStatus !== 'cache').length, 0);
  assert.ok(roles.some((r) => r.decision === 'unscored' && r.rankStatus === 'over_budget'));
  assert.ok(roles.filter((r) => r.decision === 'published' || r.decision === 'below_threshold').every((r) => !r.job?.description),
    'decided roles drop descriptions from the ledger');
  assert.ok(roles.some((r) => r.decision === 'unscored' && r.job?.description),
    'pending/unscored roles keep a description for ranking');
  assert.ok((result.unscored ?? []).some((j) => j.rankStatus === 'over_budget'));
  const again = await runHuntley(cfg, { noScan: true, runId: 'budget-raw' });
  assert.ok((again.unscored ?? []).some((j) => j.rankStatus === 'over_budget'), 'over-budget roles stay retryable');
});

test('a preferences change does not republish already published roles', async () => {
  resetLedger();
  writeFileSync(join(PATHS.runs, 'fp-raw.json'), JSON.stringify(snapshot(3, { start: 5100 }), null, 2));
  const cfg = loadConfig();
  cfg.rank.max_llm = 50;
  cfg.rank.max_per_company = 0;
  cfg.rank.min_score = 0;
  const first = await runHuntley(cfg, { noScan: true, runId: 'fp-raw' });
  assert.ok(first.shown.length > 0);
  writeFileSync(PATHS.preferences, `
targets:
  role_terms: ["engineer*"]
  title_keywords: ["research", "newkeyword"]
background: { summary: "A test operator." }
location: { allow: ["California"], remote: accept }
`);
  const cfg2 = loadConfig();
  cfg2.rank.max_llm = 50;
  cfg2.rank.max_per_company = 0;
  cfg2.rank.min_score = 0;
  const second = await runHuntley(cfg2, { noScan: true, runId: 'fp-raw' });
  assert.equal(second.shown.length, 0);
  assert.equal(second.eligible.length, 0);
});

test('per-company caps do not force exit 2 when every ranked role has a model score', async () => {
  resetLedger();
  const jobs = Array.from({ length: 5 }, (_, i) => toJob({
    url: `https://boards.greenhouse.io/acme/jobs/${8200 + i}`,
    title: 'Research Engineer',
    company: i === 1 ? 'SoloCo0' : `SoloCo${i}`,
    location: 'San Francisco, CA',
    source: 'ats_sweep',
    firstSeen: '2026-09-14',
    description: 'Build evals.',
  })).filter(Boolean);
  writeFileSync(join(PATHS.runs, 'cap-exit-raw.json'), JSON.stringify(jobs, null, 2));
  const cfg = loadConfig();
  cfg.rank.max_llm = 50;
  cfg.rank.max_per_company = 1;
  cfg.rank.min_score = 0;
  const result = await runHuntley(cfg, { noScan: true, runId: 'cap-exit' });
  assert.ok((result.unscored?.length ?? 0) >= 1, 'the capped extra role is listed unscored');
  assert.equal(result.exitCode, 0);
});

test('dry run suppresses seen.tsv identities without migrating', async () => {
  resetLedger();
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [], pendingEmails: [], pendingEmail: null, migration: null,
  }));
  writeFileSync(PATHS.roles, JSON.stringify({ schema: 1, roles: {}, aliases: {} }));
  const jobs = snapshot(2, { start: 7100 });
  writeFileSync(PATHS.seen, `${jobs[0].id}\t2026-09-01\tAcme\tResearch Engineer\n`);
  writeFileSync(join(PATHS.runs, 'seen-dry-raw.json'), JSON.stringify(jobs, null, 2));
  const result = await runHuntley(loadConfig(), { noScan: true, runId: 'seen-dry', dryRun: true });
  assert.equal(result.stats.newCount, 1);
  assert.ok(!existsSync(PATHS.progress) || JSON.parse(readFileSync(PATHS.progress, 'utf8')).migration == null);
});

test('migration requeues cap/overflow and keyword scores, not below-threshold model scores', async () => {
  resetLedger();
  writeFileSync(PATHS.progress, JSON.stringify({
    schema: 1, units: {}, committedRunIds: [], pendingEmails: [], pendingEmail: null, migration: null,
  }));
  writeFileSync(PATHS.roles, JSON.stringify({ schema: 1, roles: {}, aliases: {} }));
  rmSync(PATHS.runs, { recursive: true, force: true });
  mkdirSync(PATHS.runs, { recursive: true });

  const overflow = toJob({
    url: 'https://boards.greenhouse.io/acme/jobs/9001',
    title: 'Research Engineer',
    company: 'Acme',
    location: 'San Francisco, CA',
    source: 'ats_sweep',
    firstSeen: '2026-09-14',
  });
  overflow.id = jobId(overflow);
  const keyword = toJob({
    url: 'https://boards.greenhouse.io/acme/jobs/9002',
    title: 'Research Engineer',
    company: 'Beta',
    location: 'San Francisco, CA',
    source: 'ats_sweep',
    firstSeen: '2026-09-14',
  });
  keyword.id = jobId(keyword);
  const below = toJob({
    url: 'https://boards.greenhouse.io/acme/jobs/9003',
    title: 'Research Engineer',
    company: 'Gamma',
    location: 'San Francisco, CA',
    source: 'ats_sweep',
    firstSeen: '2026-09-14',
  });
  below.id = jobId(below);
  writeFileSync(PATHS.seen, [overflow, keyword, below].map((j) => `${j.id}\t2026-09-14\t${j.company}\t${j.title}`).join('\n') + '\n');
  writeFileSync(join(PATHS.runs, '2026-09-14-shown.json'), JSON.stringify({
    date: '2026-09-14',
    shown: [
      { ...overflow, inEmail: false, score: 4.5, rankStatus: 'model', reason: 'digest max_rows overflow' },
      { ...keyword, inEmail: false, score: 4, rankStatus: 'over_budget', heuristicOnly: true },
      { ...below, inEmail: false, score: 2, rankStatus: 'model' },
    ],
  }));

  const { migrateLegacy } = await import('../src/state/migrate.mjs');
  const result = migrateLegacy({ now: Date.parse('2026-09-15T12:00:00Z'), minScore: 3 });
  assert.equal(result.ran, true);
  const roles = JSON.parse(readFileSync(PATHS.roles, 'utf8')).roles;
  assert.equal(roles[overflow.id].decision, 'pending');
  assert.equal(roles[keyword.id].decision, 'pending');
  assert.equal(roles[below.id].decision, 'below_threshold');
  assert.ok(result.queued >= 2);
});

test('replaying a collected snapshot commits that run and prunes its observations', async () => {
  resetLedger();
  const crashedId = '2026-09-10T12-00-00-000Z-deadbeef';
  mkdirSync(join(PATHS.runs, crashedId), { recursive: true });
  writeFileSync(join(PATHS.runs, crashedId, 'raw.json'), JSON.stringify(snapshot(1, { start: 9900 }), null, 2));
  writeFileSync(join(PATHS.runs, crashedId, 'commit.json'), JSON.stringify({ schema: 1, phase: 'collected', runId: crashedId }));
  const { writeBoardObservation, observationsDir } = await import('../src/sources/boards/state.mjs');
  writeBoardObservation({
    runId: crashedId,
    lane: 'watchlist',
    boardKey: 'https://boards.greenhouse.io/acme',
    observedAt: '2026-09-10',
    jobs: snapshot(1, { start: 9900 }),
    outcome: { ok: true },
  });
  const cfg = watchlistOnly(loadConfig());
  await runHuntley(cfg, { now: Date.parse('2026-09-15T12:00:00Z') });
  const progress = JSON.parse(readFileSync(PATHS.progress, 'utf8'));
  assert.ok(progress.committedRunIds.includes(crashedId), 'replayed collection is marked committed');
  assert.equal(existsSync(join(observationsDir(), crashedId)), false, 'committed observations are pruned after the ledger save');
});

test('recovered observations from a mid-collection crash are committed and pruned', async () => {
  resetLedger();
  const orphanId = '2026-09-11T08-00-00-000Z-orphan';
  const { writeBoardObservation, observationsDir } = await import('../src/sources/boards/state.mjs');
  writeBoardObservation({
    runId: orphanId,
    lane: 'watchlist',
    boardKey: 'https://boards.greenhouse.io/acme',
    observedAt: '2026-09-11',
    jobs: snapshot(1, { start: 9910 }),
    outcome: { ok: true },
  });
  const cfg = watchlistOnly(loadConfig());
  await runHuntley(cfg, { now: Date.parse('2026-09-15T12:00:00Z') });
  const progress = JSON.parse(readFileSync(PATHS.progress, 'utf8'));
  assert.ok(progress.committedRunIds.includes(orphanId), 'recovered observation runs are marked committed');
  assert.equal(existsSync(join(observationsDir(), orphanId)), false);
});
