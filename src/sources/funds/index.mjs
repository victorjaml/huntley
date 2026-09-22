// VC fund portfolios: from a list of funds to job boards career-ops can scan.
//
//   1. list     each fund's adapter lists its companies (adapters.mjs). Cached
//               for a day per fund; a company stays on the list for 60 days
//               after it was last seen, so a fund page that shows only recent
//               jobs still accumulates the portfolio over time.
//   2. merge    one record per company across funds, remembering every fund.
//   3. resolve  a company's website → its board (resolve.mjs), cached for a
//               month when found and two weeks when not. Resolution runs
//               against a time budget: a first run with a thousand new
//               companies resolves what it can and carries on tomorrow, rather
//               than holding up the digest.
//   4. emit     boards become tracked_companies entries for a career-ops scan;
//               YC companies with no board of their own are fetched from YC's
//               job pages instead (yc-jobs.mjs).
//
// None of this reads a job. It only decides which boards to read.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ADAPTERS, fundProblem } from './adapters.mjs';
import { resolveWebsite, guessBoard, boardName, prettySlug, compactRejected, REJECTED_TTL_MS } from './resolve.mjs';
import { siteKey } from './boards.mjs';
import { companyKey } from '../../normalize.mjs';
import { log } from '../../lib/log.mjs';

const DAY = 86_400_000;
export const TTL = {
  list: 20 * 3_600_000,   // a fund's company list is refetched at most once a day
  keep: 60 * DAY,         // a company missing from its fund's page is kept this long
  found: 30 * DAY,        // a resolved board is rechecked monthly
  none: 14 * DAY,         // a website with no board is rechecked fortnightly
  dead_link: 14 * DAY,    // linked boards that 404; rechecked like none
  error: 2 * DAY,         // an unreachable website is retried soon
  name: 90 * DAY,
  rejected: REJECTED_TTL_MS, // a 404'd URL is skipped this long, then rechecked
};

export const fundId = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; }
}

function writeJson(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 1));
  renameSync(tmp, path);
}

/** Run fn over items with a concurrency limit, stopping new work past the deadline. */
async function pool(items, limit, deadline, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && Date.now() < deadline) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The key a company is merged and cached under: its site, else its board, else its name. */
function recordKey(c) {
  const site = c.website ? siteKey(c.website) : '';
  if (site) return `site:${site}`;
  if (c.board?.careers_url) return `board:${c.board.careers_url.toLowerCase()}`;
  return c.name ? `name:${companyKey(c.name)}` : null;
}

/**
 * Step 1: each fund's companies, from cache when fresh.
 * @returns {Promise<{fund: object, companies: object[], error?: string, fromCache: boolean}[]>}
 */
async function listFunds(funds, { http, dir, now }) {
  return Promise.all(funds.map(async (fund) => {
    const path = join(dir, 'lists', `${fundId(fund.name)}.json`);
    const cached = readJson(path, { fetchedAt: 0, companies: [] });
    if (now - cached.fetchedAt < TTL.list && cached.companies.length) {
      return { fund, companies: cached.companies, fromCache: true };
    }
    let listed, error;
    try {
      listed = await ADAPTERS[fund.kind].list(fund, http);
      if (!listed.length) error = 'listed no companies (page layout may have changed)';
    } catch (err) {
      error = err.message;
    }
    if (!listed?.length) {
      // Yesterday's list beats none; the error still reaches the digest.
      return { fund, companies: cached.companies, error, fromCache: true };
    }
    const byKey = new Map(cached.companies.filter((c) => now - (c.lastSeen ?? 0) < TTL.keep).map((c) => [recordKey(c), c]));
    for (const c of listed) {
      const key = recordKey(c);
      if (key) byKey.set(key, { ...byKey.get(key), ...c, lastSeen: now });
    }
    const companies = [...byKey.values()];
    writeJson(path, { fund: fund.name, fetchedAt: now, companies });
    return { fund, companies, fromCache: false };
  }));
}

/**
 * Decide which boards to scan for every configured fund.
 *
 * @param {object[]} funds     watchlist.yml fund_portfolios entries
 * @param {object}   opts
 * @param {object}   opts.http             {fetchText, fetchJson, fetchTextHead}
 * @param {string}   opts.dir              cache directory (data/funds)
 * @param {number}   [opts.budgetMs]       time allowed for resolving new companies
 * @param {number}   [opts.concurrency]
 * @param {Set<string>} [opts.skipBoards]  careers_urls (lowercased) scanned elsewhere
 * @param {number}   [opts.now]
 */
export async function planFundScan(funds, { http, dir, budgetMs = 120_000, concurrency = 16, skipBoards = new Set(), now = Date.now() } = {}) {
  const warnings = [];
  const active = [];
  for (const fund of funds ?? []) {
    if (fund?.enabled === false) continue;
    const problem = fundProblem(fund);
    if (problem) warnings.push(`fund_portfolios: "${fund?.name ?? '?'}" ${problem}`);
    else active.push(fund);
  }

  // ── 1. list
  const lists = await listFunds(active, { http, dir, now });
  const perFund = {};
  for (const l of lists) {
    perFund[l.fund.name] = { companies: l.companies.length, boards: 0 };
    if (l.error) warnings.push(`fund "${l.fund.name}": ${l.error}${l.companies.length ? ' — using the last list' : ''}`);
  }

  // ── 2. merge
  const merged = new Map();
  for (const { fund, companies } of lists) {
    for (const c of companies) {
      const key = recordKey(c);
      if (!key) continue;
      const prev = merged.get(key);
      if (prev) {
        if (!prev.funds.includes(fund.name)) prev.funds.push(fund.name);
        prev.name ??= c.name; prev.website ??= c.website; prev.board ??= c.board; prev.ycSlug ??= c.ycSlug;
      } else {
        merged.set(key, { name: c.name, website: c.website ?? null, board: c.board ?? null, ycSlug: c.ycSlug ?? null, funds: [fund.name] });
      }
    }
  }

  // ── 3. resolve, against the budget
  const cachePath = join(dir, 'resolved.json');
  const cache = readJson(cachePath, { sites: {}, names: {} });
  cache.sites ??= {}; cache.names ??= {};
  const deadline = Date.now() + budgetMs;
  const fresh = (entry, ttl) => entry && now - entry.checkedAt < ttl;

  // Boards listed without a company name (a fund's job page links boards, not
  // companies) are named from the board first: there are few of them, and a
  // slug for a name would defeat company blocks and cross-source dedupe.
  const unnamed = [...merged.values()].filter((c) => c.board && !c.name && !fresh(cache.names[c.board.careers_url], TTL.name));
  await pool(unnamed, concurrency, deadline, async (c) => {
    cache.names[c.board.careers_url] = { name: await boardName(c.board, http), checkedAt: Date.now() };
  });

  const toResolve = [...merged.values()].filter((c) => {
    if (c.board || !c.website) return false;
    const hit = cache.sites[siteKey(c.website)];
    return !fresh(hit, TTL[hit?.status] ?? 0);
  });
  let resolvedNow = 0;
  await pool(toResolve, concurrency, deadline, async (c) => {
    const prev = cache.sites[siteKey(c.website)];
    let result = await resolveWebsite(c.website, http, {
      rejected: prev?.rejected ?? [],
      deadlineAt: deadline,
    });
    // A transient error is not "no board" — don't spend the leftover budget
    // guessing, and don't overwrite a timeout with a guessed miss.
    if (result.status !== 'found' && result.status !== 'error') {
      const guess = await guessBoard(c, http);
      if (guess.status === 'found') result = { ...guess, rejected: result.rejected ?? [] };
    }
    const next = applyResolvedSite(prev, result, Date.now());
    if (result.deadline) return;
    if (next !== undefined) cache.sites[siteKey(c.website)] = next;
    resolvedNow++;
  });

  for (const c of merged.values()) {
    if (!c.board && c.website) {
      const hit = cache.sites[siteKey(c.website)];
      if (hit?.status === 'found') { c.board = hit.board; c.name ??= hit.name ?? null; }
      c.resolution = hit?.status ?? 'pending';
    } else if (c.board) {
      c.resolution = 'found';
    } else {
      c.resolution = 'none';
    }
  }

  // Companies resolved from a website that never told us their name.
  const stillUnnamed = [...merged.values()].filter((c) => c.board && !c.name && !fresh(cache.names[c.board.careers_url], TTL.name));
  await pool(stillUnnamed, concurrency, deadline + 15_000, async (c) => {
    cache.names[c.board.careers_url] = { name: await boardName(c.board, http), checkedAt: Date.now() };
  });

  writeJson(cachePath, cache);

  // ── 4. emit
  const entries = [];
  const waas = [];
  const byCareersUrl = new Map();
  const counts = { companies: merged.size, found: 0, none: 0, dead_link: 0, error: 0, pending: 0, skipped: 0 };

  for (const c of merged.values()) {
    counts[c.resolution] = (counts[c.resolution] ?? 0) + 1;
    if (c.board) {
      const url = c.board.careers_url;
      if (skipBoards.has(url.toLowerCase())) { counts.skipped++; continue; }
      const name = c.name ?? cache.names[url]?.name ?? prettySlug(c.board.slug);
      const prev = byCareersUrl.get(url.toLowerCase());
      if (prev) { for (const f of c.funds) if (!prev.funds.includes(f)) prev.funds.push(f); continue; }
      const entry = { name, careers_url: url, provider: c.board.vendor, funds: [...c.funds] };
      byCareersUrl.set(url.toLowerCase(), entry);
      entries.push(entry);
      for (const f of c.funds) if (perFund[f]) perFund[f].boards++;
    } else if (c.ycSlug) {
      // No board of its own (or not resolved yet): read YC's page for it.
      waas.push({ name: c.name, ycSlug: c.ycSlug, funds: [...c.funds] });
    }
  }

  const stats = { ...counts, resolvedNow, pendingAfterBudget: toResolve.length - resolvedNow, boards: entries.length, ycPages: waas.length, perFund };
  if (stats.pendingAfterBudget > 0) {
    log.info(`  funds: ${stats.pendingAfterBudget} companies left to resolve on a later run (budget ${Math.round(budgetMs / 1000)}s)`);
  }
  return { entries, waas, stats, warnings };
}

/** companyKey → the funds it belongs to, for attributing scanned roles. */
export function fundsByCompany(entries, waas = []) {
  const map = new Map();
  for (const e of [...entries, ...waas]) {
    const key = companyKey(e.name);
    if (key) map.set(key, [...new Set([...(map.get(key) ?? []), ...e.funds])]);
  }
  return map;
}

/**
 * How a resolve result is written to the site cache.
 *
 * A deadline cut-off is not a result — leave the entry as it was so a
 * pending company resumes next run instead of waiting TTL.error, and a
 * found board stays in the scan.
 *
 * A transient error on a monthly re-check must not drop a live board: keep
 * the previous found entry and age checkedAt so it retries in TTL.error.
 */
export function applyResolvedSite(prev, result, now = Date.now()) {
  if (result?.deadline) return prev;
  if (result?.status === 'error' && prev?.status === 'found') {
    return { ...prev, checkedAt: now - (TTL.found - TTL.error) };
  }
  const entry = { ...result, checkedAt: now };
  delete entry.deadline;
  const rejected = compactRejected(entry.rejected, { now, ttlMs: TTL.rejected });
  if (rejected.length) entry.rejected = rejected;
  else delete entry.rejected;
  return entry;
}

function isHttp404(unit) {
  return (unit?.errors ?? []).some((e) => /\bHTTP 404\b/.test(String(e)));
}

/**
 * A `fund:board:*` unit that 404'd at scan time is not a live board — drop it
 * from the found cache so the next run re-resolves the company. Timeouts,
 * 5xx and aborts leave the entry as it was.
 *
 * checkedAt is set in the past so TTL.dead_link does not hold the re-resolve
 * for a fortnight: A1 already waits 14 days when *resolution* decides a
 * site is dead; here we only learned the cached URL is gone.
 */
export function retireDeadFundBoards(dir, units, { now = Date.now() } = {}) {
  const cachePath = join(dir, 'resolved.json');
  const cache = readJson(cachePath, { sites: {}, names: {} });
  cache.sites ??= {};
  const prefix = 'fund:board:';
  const deadUrls = new Set();
  for (const unit of units ?? []) {
    if (!String(unit?.key).startsWith(prefix)) continue;
    if (unit.status !== 'failed') continue;
    if (!isHttp404(unit)) continue;
    deadUrls.add(String(unit.key).slice(prefix.length));
  }
  if (!deadUrls.size) return 0;
  let n = 0;
  for (const [site, entry] of Object.entries(cache.sites)) {
    const url = String(entry?.board?.careers_url ?? '').replace(/\/+$/, '').toLowerCase();
    if (!url || !deadUrls.has(url)) continue;
    cache.sites[site] = {
      status: 'dead_link',
      checkedAt: now - TTL.dead_link,
      board: entry.board,
      rejected: compactRejected(
        [...(entry.rejected ?? []), { careers_url: entry.board?.careers_url, status: 404, at: now }],
        { now, ttlMs: TTL.rejected },
      ),
    };
    n++;
  }
  if (n) writeJson(cachePath, cache);
  return n;
}
