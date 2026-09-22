#!/usr/bin/env node
// Live smoke check — `npm run test:live`.
//
// The unit suites and the offline e2e test never touch the network, which is
// what makes them fast enough to run on every save. But they also cannot catch
// the failure that actually happens in practice: a board changes its markup or
// its API, and huntley keeps running while quietly finding nothing.
//
// This hits every configured source once and asserts each returns plausible
// data. It does NOT rank (no model), does NOT send mail, and writes nothing to
// your real data directory. Takes about a minute. Run it before pushing, and
// when a digest looks thinner than it should.
//
// Exit 0 = every source is alive. Exit 1 = at least one is not, named.

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect state before anything reads PATHS: a smoke check must not write to
// the real scan history or seen ledger.
const scratch = mkdtempSync(join(tmpdir(), 'huntley-live-'));
process.env.HUNTLEY_DATA_DIR = scratch;

const { PATHS } = await import('../src/lib/paths.mjs');
if (!PATHS.data.startsWith(scratch)) {
  console.error(`refusing to run: PATHS.data is ${PATHS.data}, not the scratch directory`);
  process.exit(1);
}
mkdirSync(PATHS.collection, { recursive: true });

const { loadConfig } = await import('../src/config.mjs');
const { searchLinkedIn } = await import('../src/sources/linkedin.mjs');
const { searchFreehire } = await import('../src/sources/freehire.mjs');
const { loadWatchlist } = await import('../src/sources/watchlist.mjs');
const { detectCli } = await import('../src/rank/llm.mjs');

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); print(results.at(-1)); };
const print = (r) => console.log(`  ${r.ok === true ? 'ok  ' : r.ok === null ? 'skip' : 'FAIL'}  ${r.name.padEnd(34)} ${r.detail}`);

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`config did not load: ${err.message}`);
  process.exit(1);
}

console.log('huntley live smoke check — hits every configured source once\n');

// ── Watchlist boards, one fetch each ────────────────────────────────
// This is the check that matters most: a company whose board moved silently
// stops contributing, and nothing else in the system notices.

const { makeHttpCtx } = await import('../src/sources/boards/http/http.mjs');
const { getProviders, resolveProvider } = await import('../src/sources/boards/registry.mjs');
const providers = getProviders();
const ctx = makeHttpCtx();

const wl = loadWatchlist();
const companies = [...(wl.tracked_companies ?? []), ...(wl.portfolio_boards ?? [])].filter((c) => c && c.enabled !== false);
console.log(`watchlist (${companies.length} enabled)`);

let boardsOk = 0;
const deadBoards = [];

for (const entry of companies) {
  const resolved = resolveProvider(entry, providers);
  const provider = resolved?.provider;
  if (!provider) { deadBoards.push(`${entry.name}: no provider resolved`); print({ ok: false, name: entry.name, detail: 'no provider resolved' }); continue; }
  try {
    const jobs = await provider.fetch(entry, ctx);
    print({ ok: jobs.length > 0 ? true : null, name: entry.name, detail: `${jobs.length} roles via ${provider.id}` });
    boardsOk++;
  } catch (err) {
    deadBoards.push(`${entry.name}: ${err.message}`);
    print({ ok: false, name: entry.name, detail: err.message.slice(0, 80) });
  }
}
results.push({ name: 'watchlist boards', ok: deadBoards.length === 0, detail: `${boardsOk}/${companies.length} reachable` });

// ── The board layers ───────────────────────────────────────────────

console.log('\nboard layers');

if (config.sources.linkedin?.enabled) {
  const res = await searchLinkedIn({
    queries: [config.sources.linkedin.queries?.[0] ?? 'research engineer'],
    locations: [config.sources.linkedin.locations?.[0] ?? 'United States'],
    jobageDays: 7, maxPages: 1, delayMs: 0, requestLimit: 1,
  });
  const jobs = res.jobs ?? res;
  // A parser break shows up exactly here: HTTP 200, zero cards.
  record('linkedin', jobs.length > 0, jobs.length > 0
    ? `${jobs.length} cards parsed, e.g. "${jobs[0].title.slice(0, 40)}"`
    : 'fetched but parsed 0 cards — the guest-page markup may have changed');
} else {
  record('linkedin', null, 'disabled in config');
}

if (config.sources.freehire?.enabled) {
  try {
    const res = await searchFreehire({
      queries: [config.sources.freehire.queries?.[0] ?? 'research engineer'],
      locations: config.sources.freehire.locations ?? ['us'],
      sinceDays: 7, limit: 5,
    });
    const jobs = res.jobs ?? res;
    const withBody = jobs.filter((j) => j.description).length;
    record('freehire', jobs.length > 0,
      `${jobs.length} postings, ${withBody} with a description`);
  } catch (err) {
    record('freehire', false, err.message.slice(0, 80));
  }
} else {
  record('freehire', null, 'disabled in config');
}

// ── Local prerequisites ────────────────────────────────────────────

console.log('\nlocal');

const summary = String(config.preferences?.background?.summary ?? '').trim();
record('background', summary.length > 40,
  summary.length > 40
    ? `${summary.length} chars in preferences.background.summary`
    : 'preferences.background.summary looks empty — run: huntley setup --cv /path/to/resume');

const cli = await detectCli(config.rank?.cli);
record('ranking CLI', Boolean(cli), cli ? `${cli.bin} found` : 'none found — digests would be heuristic-only');

// ── Verdict ────────────────────────────────────────────────────────

const failed = results.filter((r) => r.ok === false);
console.log('');
if (failed.length === 0) {
  console.log(`All live sources healthy (${results.filter((r) => r.ok === true).length} checks passed).`);
  process.exit(0);
}
console.log(`${failed.length} live check(s) failed:`);
for (const f of failed) console.log(`  • ${f.name}: ${f.detail}`);
if (deadBoards.length) {
  console.log('\nA board that has moved is the failure this check exists to catch —');
  console.log('re-resolve it with:  node bin/huntley.mjs discover-board "<Company>" --summary');
}
process.exit(1);
