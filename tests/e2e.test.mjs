// Offline end-to-end test.
//
// The unit suites cover each piece; this covers the wiring between them —
// collect → dedupe → seen-ledger → prefilter → rank → threshold → render →
// send, the whole of runDaily(), in about a second and with no network.
//
// Three substitutions make that possible, all through seams that already exist
// for other reasons:
//
//   HUNTLEY_DATA_DIR / HUNTLEY_CONFIG_DIR   scratch state and config
//   --no-scan + a fixture snapshot           replaces every live source
//   tests/fixtures/bin on PATH               replaces the ranking CLI
//
// So there is no production code here that exists only for testing. The point
// is to be able to change the pipeline and know in a second whether it still
// works, instead of waiting five minutes for a live scan and two minutes for a
// real model. Run the live check before pushing; run this constantly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const root = mkdtempSync(join(tmpdir(), 'huntley-e2e-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
// The stub ranker shadows the real `claude` binary for this process only.
process.env.PATH = `${join(REPO, 'tests', 'fixtures', 'bin')}:${process.env.PATH}`;
delete process.env.HUNTLEY_LINK_SECRET;
// Set, not deleted: .env is loaded without overriding what is already set, so
// an empty value keeps a real sheet URL there from reaching this suite.
process.env.HUNTLEY_SHEET_CSV_URL = '';

mkdirSync(process.env.HUNTLEY_CONFIG_DIR, { recursive: true });

const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
assert.ok(PATHS.data.startsWith(root) && PATHS.config.startsWith(root),
  `refusing to run: PATHS still points outside the scratch directory (${PATHS.data})`);
ensureDirs();

// ── Fixtures ────────────────────────────────────────────────────────

const HUNTLEY_YML = `
identity:
  name: "Test Operator"
  email: "test@example.invalid"
sources:
  # --no-scan replaces collection with the fixture snapshot, so none of these
  # is ever invoked. One must be declared because config validation requires a
  # source to exist — a config with no sources at all is a user error, not a
  # legitimate test fixture.
  watchlist: { enabled: true }
  ats_sweep: { enabled: false }
  linkedin:  { enabled: false }
  freehire:  { enabled: false }
rank:
  cli: claude
  max_llm: 20
  batch_size: 8
  concurrency: 1
  min_score: 3.0
  timeout_ms: 20000
  total_timeout_ms: 60000
  cache:
    enabled: true
    ttl_hours: 168
enrichment:
  enabled: false
digest:
  send_on_zero_matches: true
  max_rows: 20
email:
  provider: console
  from: "huntley@example.invalid"
  to: "test@example.invalid"
sheet:
  enabled: false
`;

const PREFERENCES_YML = `
targets:
  role_terms: ["engineer*", "scientist*", "technical staff"]
  title_keywords: ["research", "machine learning", "evaluation*"]
  exclude_titles: ["intern", "account executive"]
background:
  summary: "A test operator."
location:
  base: "Los Angeles, CA"
  allow: ["California"]
  remote: rank_lower
filters:
  block_companies: ["BlockedCo"]
notes: []
`;

const WATCHLIST_YML = `
tracked_companies:
  - name: "Watched Lab"
    careers_url: "https://jobs.ashbyhq.com/watchedlab"
    enabled: true
portfolio_boards:
  - name: "Example Fund (portfolio)"
    careers_url: "https://jobs.examplefund.test/jobs"
    provider: getro
    enabled: true
`;

writeFileSync(PATHS.huntleyConfig, HUNTLEY_YML);
writeFileSync(PATHS.preferences, PREFERENCES_YML);
writeFileSync(PATHS.watchlist, WATCHLIST_YML);

/** The collected-postings snapshot runDaily replays under --no-scan. */
function snapshot(date) {
  const rows = [
    // On the watchlist, but names no role word — rejected like anyone else's.
    { url: 'https://jobs.ashbyhq.com/watchedlab/aaaa1111-2222-3333-4444-555566667777', title: 'Distributed Systems Wizard', company: 'Watched Lab', location: 'San Francisco, CA', watchlist: true },
    // Survives on merit.
    { url: 'https://boards.greenhouse.io/acme/jobs/1001', title: 'Research Engineer, Evaluations', company: 'Acme', location: 'San Francisco, CA', description: 'Build evals.' },
    // Same role as the next row, reached two ways — must collapse to one.
    { url: 'https://www.linkedin.com/jobs/view/9988776655', title: 'Member of Technical Staff', company: 'Acme, Inc.', location: 'San Francisco, CA', postedAt: date, source: 'linkedin' },
    { url: 'https://boards.greenhouse.io/acme/jobs/1002', title: 'Member of Technical Staff', company: 'Acme', location: 'San Francisco, CA', description: 'Train models.' },
    // Rejected on location.
    { url: 'https://boards.greenhouse.io/acme/jobs/1003', title: 'Research Engineer', company: 'Acme', location: 'London, England' },
    // Rejected on title.
    { url: 'https://boards.greenhouse.io/acme/jobs/1004', title: 'Account Executive, Enterprise', company: 'Acme', location: 'San Francisco, CA' },
    // Rejected on company.
    { url: 'https://boards.greenhouse.io/blockedco/jobs/1005', title: 'Research Engineer', company: 'BlockedCo', location: 'Remote' },
    // Rejected: names no target role.
    { url: 'https://boards.greenhouse.io/acme/jobs/1006', title: 'Warehouse Associate', company: 'Acme', location: 'Remote' },
  ];
  const { toJob } = jobModule;
  return rows.map((r) => toJob({ source: 'ats_sweep', sourceDetail: 'greenhouse', firstSeen: date, ...r })).filter(Boolean);
}

const jobModule = await import('../src/normalize.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { runDaily } = await import('../src/daily.mjs');
const today = jobModule.localToday();

function writeSnapshot() {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(join(PATHS.runs, `${today}-raw.json`), JSON.stringify(snapshot(today), null, 2));
}

// ── Tests ───────────────────────────────────────────────────────────

test('the whole pipeline runs offline and produces a digest', async () => {
  writeSnapshot();
  const { shown, stats, warnings } = await runDaily(loadConfig(), { noScan: true, dryRun: true });

  assert.equal(stats.raw, 8, 'all fixture rows are collected');
  assert.equal(stats.collapsed, 1, 'the LinkedIn card and the ATS posting for one role collapse');
  assert.equal(stats.scanned, 7, 'seven unique roles after dedupe');
  assert.equal(stats.filtered, 5, 'location, title, company, role-word and watchlist-no-exemption rejections all fire');
  assert.ok(shown.length >= 1, 'at least one role reaches the digest');
  assert.ok(!warnings.some((w) => /rank/i.test(w)), `ranking should not be degraded: ${warnings.join('; ')}`);
});

test('every shown role carries a score and a readable reason', async () => {
  const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.dryrun.json`), 'utf8'));
  const inReport = record.shown.filter((j) => j.publishedLocally || j.inReport);
  assert.ok(inReport.length > 0);
  for (const job of inReport) {
    assert.ok(Number.isFinite(job.score), `${job.title} has no score`);
    assert.ok(job.why && job.why.length >= 12, `${job.title} has no usable reason`);
    assert.equal(job.heuristicOnly, false, `${job.title} fell back to the heuristic`);
    assert.ok(['model', 'cache'].includes(job.rankStatus), `${job.title} missing rankStatus`);
  }
});

test('ranking telemetry accounts for every ranked role', async () => {
  const path = join(PATHS.runs, `${today}-rank.dryrun.json`);
  assert.ok(existsSync(path), 'dry-run rank telemetry is written');
  const telemetry = JSON.parse(readFileSync(path, 'utf8'));
  const total = Object.values(telemetry.statusCounts).reduce((a, b) => a + b, 0);
  const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.dryrun.json`), 'utf8'));
  assert.equal(total, record.shown.length, 'status counts sum to roles reaching ranking');
});

test('a watchlist company gets no exemption from the title rules', async () => {
  const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.dryrun.json`), 'utf8'));
  const wizard = record.rejected.find((r) => r.title === 'Distributed Systems Wizard');
  assert.ok(wizard, 'a watchlist role with no role word is rejected like any other');
  assert.match(wizard.reason, /names no target role/);
});

test('each rejection is recorded with the reason that produced it', async () => {
  const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.dryrun.json`), 'utf8'));
  // Keyed by title AND company: two fixture rows are both "Research Engineer",
  // rejected for different reasons, and a title-only map would hide one.
  const reason = (title, company) =>
    record.rejected.find((r) => r.title === title && r.company === company)?.reason ?? '';

  assert.match(reason('Research Engineer', 'Acme'), /"London, England" is not a place you accept/);
  assert.match(reason('Research Engineer', 'BlockedCo'), /company on block list/);
  assert.match(reason('Account Executive, Enterprise', 'Acme'), /title excluded \(account executive\)/);
  assert.match(reason('Warehouse Associate', 'Acme'), /names no target role/);
  assert.equal(record.rejected.length, 5);
});

test('the merged role keeps the ATS link, not the board redirect', async () => {
  const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.dryrun.json`), 'utf8'));
  const mts = record.shown.find((j) => j.title === 'Member of Technical Staff');
  assert.ok(mts);
  assert.match(mts.url, /greenhouse/, 'apply through the company board');
});

test('a rendered digest is written and names what it filtered', async () => {
  const files = readdirSync(PATHS.digests);
  const html = files.find((f) => f.endsWith('-dryrun.html'));
  assert.ok(html, `expected a dry-run digest in ${PATHS.digests}, saw ${files.join(', ')}`);
  const body = readFileSync(join(PATHS.digests, html), 'utf8');
  assert.match(body, /never submits anything|no Add actions/);
  assert.match(body, /filtered out/);
  assert.doesNotMatch(body, /Add buttons are off/);
});

test('a dry run marks nothing seen, so the next real run still shows the roles', async () => {
  // The first test above was a dry run. A dry run that quietly consumed the
  // seen ledger would mean every --dry-run cost you a day of real matches.
  assert.ok(!existsSync(PATHS.seen), 'a dry run must not write the seen ledger');

  writeSnapshot();
  const { shown, sent, delivery } = await runDaily(loadConfig(), { noScan: true });
  assert.equal(sent, false, 'console output is not an email');
  assert.equal(delivery, 'console');
  const summary = JSON.parse(readFileSync(join(PATHS.runs, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(summary.sent, false);
  assert.equal(summary.delivery, 'console');
  assert.equal(shown.length, 2, 'the roles the dry run rendered are still deliverable');
});

test('the seen ledger holds every judged role, not just the shown ones', async () => {
  const lines = readFileSync(PATHS.seen, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'two roles passed the filters and were judged');
});

test('a repeat run finds nothing new and still sends a digest', async () => {
  // Proves the seen ledger closes, and that a zero-match day is not silence.
  writeSnapshot();
  const { shown, stats } = await runDaily(loadConfig(), { noScan: true });
  assert.equal(shown.length, 0, 'everything was judged on the previous run');
  assert.equal(stats.filtered, 0, 'terminal rejections are remembered, not recomputed as new');

  const latest = readdirSync(PATHS.digests).filter((f) => f.endsWith('.txt')).sort().pop();
  const body = readFileSync(join(PATHS.digests, latest), 'utf8');
  assert.match(body, /No new matches today/);
  assert.match(body, /proof the run happened/);
});

test('delivery history survives a later preview and a second real run the same day', async () => {
  // Two real runs above mailed two roles, then found nothing new.
  const path = join(PATHS.runs, `${today}-shown.json`);
  const mailed = (r) => r.shown.filter((j) => j.publishedLocally || j.inEmail).map((j) => j.id).sort();
  const before = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(mailed(before).length, 2, 'the repeat run did not erase the roles the earlier run mailed');

  writeSnapshot();
  await runDaily(loadConfig(), { noScan: true, dryRun: true });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before, 'a preview leaves the real record untouched');
  assert.ok(existsSync(join(PATHS.runs, `${today}-shown.dryrun.json`)), 'the preview writes its own record');
});

test('watchlist companies and portfolio boards are loaded separately for parallel lanes', async () => {
  const { watchlistEntries, portfolioBoardEntries, scannerTitleTerms } = await import('../src/sources/watchlist.mjs');
  const companies = watchlistEntries();
  const boards = portfolioBoardEntries();
  assert.equal(companies.length, 1);
  assert.equal(boards.length, 1);
  assert.equal(companies[0].name, 'Watched Lab');
  assert.equal(boards[0].name, 'Example Fund (portfolio)');
  const terms = scannerTitleTerms(loadConfig().preferences?.targets ?? {});
  assert.ok(terms.positive.length > 0, 'role words gate early collection');
});

test('equal scores keep their presort order — there is no separate ordering step', async () => {
  const src = readFileSync(new URL('../src/run.mjs', import.meta.url), 'utf8');
  assert.match(src, /eligible\.sort\(\(a, b\) => \(b\.score \?\? 0\) - \(a\.score \?\? 0\)\);/);
  assert.doesNotMatch(src, /remoteLast|Number\(b\.watchlist\)/);
});

test('an approval clicked since the last run is applied before ranking; a dry run leaves it pending', async () => {
  const { renameSync } = await import('node:fs');
  // The proposal excludes a title that otherwise reaches the digest.
  mkdirSync(PATHS.proposals, { recursive: true });
  writeFileSync(join(PATHS.proposals, 'p-e2e.json'), JSON.stringify({
    id: 'p-e2e', changes: [{ op: 'add_list_item', path: 'targets.exclude_titles', value: 'member of technical staff' }],
  }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('approved_at,proposal_id,status\n9/14/2026 09:00:00,p-e2e,approved\n', { status: 200 });
  process.env.HUNTLEY_SHEET_CSV_URL = 'https://sheet.test/pub?output=csv';
    // Start from a first run, so the fixture roles are judged again.
    if (existsSync(PATHS.seen)) renameSync(PATHS.seen, `${PATHS.seen}.before-approval-test`);
    if (existsSync(PATHS.roles)) renameSync(PATHS.roles, `${PATHS.roles}.before-approval-test`);
  try {
    // Approvals are read only from a tab named by its gid.
    const withGids = () => { const c = loadConfig(); return { ...c, sheet: { ...c.sheet, enabled: true, gids: { approvals: '3' } } }; };
    writeSnapshot();
    await runDaily(withGids(), { noScan: true, dryRun: true });
    assert.doesNotMatch(readFileSync(PATHS.preferences, 'utf8'), /member of technical staff/, 'a dry run applies nothing');

    writeSnapshot();
    await runDaily(withGids(), { noScan: true });
    assert.match(readFileSync(PATHS.preferences, 'utf8'), /member of technical staff/, 'the approval landed in preferences.yml');
    const record = JSON.parse(readFileSync(join(PATHS.runs, `${today}-shown.json`), 'utf8'));
    assert.ok(record.rejected.some((r) => r.title === 'Member of Technical Staff' && /title excluded \(member of technical staff\)/.test(r.reason)),
      'the same run already filtered with the approved preferences');
    assert.match(readFileSync(join(PATHS.proposals, 'applied.jsonl'), 'utf8'), /p-e2e/);
  } finally {
    globalThis.fetch = realFetch;
    process.env.HUNTLEY_SHEET_CSV_URL = '';
  }
});


test('skipping a zero-match digest does not record an email send', async () => {
  writeFileSync(join(PATHS.runs, `${today}-raw.json`), '[]');
  const cfg = loadConfig();
  cfg.digest.send_on_zero_matches = false;
  const result = await runDaily(cfg, { noScan: true });
  assert.equal(result.sent, false);
  assert.equal(result.delivery, 'skipped');
  const summary = JSON.parse(readFileSync(join(PATHS.runs, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(summary.sent, false);
  assert.equal(summary.delivery, 'skipped');
});
