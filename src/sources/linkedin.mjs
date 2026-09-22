// LinkedIn public job search.
//
// Ported to plain Node from the `linkedin-search` skill in MadsLorentzen/
// ai-job-search (MIT) — same public `jobs-guest` endpoints, same card parsing,
// no Bun and no runtime dependency. career-ops deliberately excludes auth-gated
// sources, so this is the layer it does not cover.
//
// VOLUME IS DELIBERATELY LOW. This hits LinkedIn's public pages, which their
// ToS does not invite automation against, so the design is: one page per query
// by default, a real gap between requests, and a hard per-run request ceiling.
// It is a supplement to the ATS layers, not the primary source.

import { setTimeout as sleep } from 'node:timers/promises';
import { toJob } from '../normalize.mjs';
import { log } from '../lib/log.mjs';
import { coverageUnit, unitKey, postingTimeMs } from '../state/coverage.mjs';
import { ageDaysCeil, windowForUnit, sourceHorizonMs } from '../state/window.mjs';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
export const RESULTS_PER_PAGE = 10;

// A plain, honest desktop UA. Not rotated, not disguised — the politeness here
// is the low volume, not pretending to be someone else.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export function linkedinUnitKey(query, location, remote = '') {
  return unitKey('linkedin', `${query}|${location}|${remote ?? ''}`);
}

export function linkedinUnitKeys({ queries = [], locations = [], remote = '' } = {}) {
  const keys = [];
  for (const location of locations) {
    for (const query of queries) keys.push(linkedinUnitKey(query, location, remote));
  }
  return keys;
}
export function jobageToTPR(days) {
  if (!days || days <= 0) return null;
  return `r${Math.round(days * 86400)}`;
}

/** Workplace-type filter: 1 onsite, 2 remote, 3 hybrid. */
export function workTypeFlag(mode) {
  return { onsite: '1', remote: '2', hybrid: '3' }[String(mode ?? '').toLowerCase()] ?? null;
}

function buildUrl({ query, location, jobageDays, remote, page }) {
  const params = new URLSearchParams();
  if (query) params.set('keywords', query);
  if (location) params.set('location', location);
  const tpr = jobageToTPR(jobageDays);
  if (tpr) params.set('f_TPR', tpr);
  const wt = workTypeFlag(remote);
  if (wt) params.set('f_WT', wt);
  // Newest first so a 1-page cap still covers today's roles, and so we can
  // stop once cards fall outside the catch-up window.
  params.set('sortBy', 'DD');
  params.set('start', String((page - 1) * RESULTS_PER_PAGE));
  return `${SEARCH_URL}?${params}`;
}

// ── HTML parsing ────────────────────────────────────────────────────
// The guest endpoint returns a bare <li> list, not a full document, so a
// handful of targeted regexes beat pulling in a DOM parser.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', '#x27': "'", '#x2F': '/' };

function decode(html) {
  return String(html ?? '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (/^#/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(block, re) {
  const m = block.match(re);
  return m ? decode(m[1]) : '';
}

/** Parse the guest search response into raw cards. Exported for tests. */
export function parseJobCards(html) {
  const cards = [];
  for (const block of String(html).split(/<li[\s>]/).slice(1)) {
    const url = (block.match(/href="(https:\/\/[^"]*\/jobs\/view\/[^"]+)"/) ?? [])[1];
    if (!url) continue;

    const id = (url.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) ?? [])[1] ?? null;
    cards.push({
      id,
      url: decode(url).split('?')[0],
      title: pick(block, /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\//),
      company: pick(block, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/(?:h4|div|a)>/),
      location: pick(block, /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\//),
      postedAt: (block.match(/datetime="(\d{4}-\d{2}-\d{2})"/) ?? [])[1] ?? null,
    });
  }
  return cards;
}

// ── Fetch ───────────────────────────────────────────────────────────

async function fetchPage(url, { timeoutMs = 20_000, fetcher = null } = {}) {
  if (fetcher) return fetcher(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.status === 429) return { rateLimited: true, html: '' };
    if (!res.ok) return { error: `HTTP ${res.status}`, html: '' };
    return { html: await res.text() };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : err.message, html: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search LinkedIn's public job board.
 *
 * @param {object} opts
 * @param {string[]} opts.queries      keyword searches to run
 * @param {string[]} opts.locations    LinkedIn place strings
 * @param {number}  [opts.jobageDays]  only postings from the last N days
 * @param {string}  [opts.remote]      remote | hybrid | onsite
 * @param {number}  [opts.maxPages]    pages per query×location (default 1)
 * @param {number}  [opts.delayMs]     gap between requests (default 9s)
 * @param {number}  [opts.requestLimit] safety limit on requests this run; the plan is otherwise sent in full
 * @returns {Promise<import('../normalize.mjs').Job[]>}
 */
export async function searchLinkedIn({
  queries = [],
  locations = [],
  jobageDays = 1,
  remote = null,
  maxPages = 1,
  delayMs = 9_000,
  requestLimit = 30,
  now = Date.now(),
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
  fetcher = null,
} = {}) {
  if (!queries.length || !locations.length) {
    log.warn('LinkedIn source skipped: no queries or locations configured');
    return { jobs: [], units: [] };
  }

  const groups = [];
  for (const location of locations) {
    for (const query of queries) {
      groups.push({ query, location, key: linkedinUnitKey(query, location, remote) });
    }
  }

  log.step(`LinkedIn public search (${groups.length} quer${groups.length === 1 ? 'y' : 'ies'} × location, up to ${maxPages} page(s), ${Math.round(delayMs / 1000)}s apart)`);

  const jobs = [];
  const units = [];
  let requestsUsed = 0;
  let rateLimitedStop = false;

  for (const group of groups) {
    const win = progress || collection
      ? windowForUnit(group.key, {
        progress: progress ?? {},
        runStartedAt: now,
        collection: collection ?? {},
        explicitSinceMs,
        sourceHorizonMs: sourceHorizonMs(jobageDays, now),
      })
      : {
        since: sinceMs ?? (now - jobageDays * 86_400_000),
        until: untilMs ?? now,
      };
    const ageDays = ageDaysCeil(win.since, win.until ?? now) ?? jobageDays;
    const errors = [];
    const limitations = [];
    let pagesFetched = 0;
    let recordsFetched = 0;
    let exhausted = false;
    let lastCount = 0;
    let status = 'complete';
    let oldestFetched = null;
    let crossedWindow = false;

    if (rateLimitedStop) {
      units.push(coverageUnit({
        key: group.key,
        requestedSince: win.since,
        requestedUntil: win.until ?? now,
        status: 'partial',
        limitations: ['rate limited; not fetched this run'],
      }));
      continue;
    }

    for (let page = 1; page <= maxPages; page++) {
      if (requestsUsed >= requestLimit) {
        limitations.push(`request_limit ${requestLimit} stopped pagination`);
        status = 'partial';
        break;
      }
      if (requestsUsed > 0 && delayMs > 0) await sleep(delayMs + Math.floor(Math.random() * 2000));
      requestsUsed++;

      const url = buildUrl({ query: group.query, location: group.location, jobageDays: ageDays, remote, page });
      const { html, error, rateLimited } = await fetchPage(url, { fetcher });

      if (rateLimited) {
        log.warn('LinkedIn returned 429 — stopping this source for the run');
        rateLimitedStop = true;
        errors.push('HTTP 429');
        limitations.push('rate limited');
        status = pagesFetched > 0 ? 'partial' : 'failed';
        break;
      }
      if (error) {
        log.warn(`LinkedIn "${group.query}" @ ${group.location} p${page}: ${error}`);
        errors.push(error);
        status = pagesFetched > 0 ? 'partial' : 'failed';
        break;
      }

      const cards = parseJobCards(html);
      pagesFetched++;
      lastCount = cards.length;
      log.trace(`  "${group.query}" @ ${group.location} p${page}: ${cards.length} cards`);

      for (const card of cards) {
        const postedMs = postingTimeMs(card.postedAt);
        if (postedMs != null && (oldestFetched == null || postedMs < oldestFetched)) oldestFetched = postedMs;
        const job = toJob({
          ...card,
          source: 'linkedin',
          sourceDetail: `linkedin:${group.query}`,
        });
        if (job) {
          jobs.push(job);
          recordsFetched++;
        }
      }

      if (oldestFetched != null && win.since != null && oldestFetched < win.since) {
        crossedWindow = true;
        exhausted = true;
        break;
      }
      if (cards.length === 0 || cards.length < RESULTS_PER_PAGE) {
        exhausted = true;
        break;
      }
    }

    if (errors.length) {
      // keep failed/partial from the error path
    } else if (exhausted || crossedWindow) {
      status = 'complete';
    } else if (lastCount >= RESULTS_PER_PAGE) {
      status = 'partial';
      limitations.push(`max_pages ${maxPages} reached without exhausting results`);
    }

    const coveredThrough = status === 'complete'
      ? (win.until ?? now)
      : (status === 'partial' && !errors.length && oldestFetched != null)
        ? new Date(oldestFetched).toISOString()
        : null;

    units.push(coverageUnit({
      key: group.key,
      requestedSince: win.since,
      requestedUntil: win.until ?? now,
      coveredThrough,
      status,
      pagesFetched,
      recordsFetched,
      limitations,
      errors,
    }));
  }

  log.info(`  linkedin: ${jobs.length} cards`);
  return { jobs, units };
}
