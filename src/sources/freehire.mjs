// freehire.me — a public, unauthenticated aggregator that normalizes postings
// from ~50 ATS platforms into one schema.
//
// Ported to plain Node from the `freehire-search` skill in MadsLorentzen/
// ai-job-search (MIT). It earns its place in huntley for one reason the other
// layers cannot match: its search results carry the FULL job description. The
// ATS list APIs and the LinkedIn cards give titles only, so this is the layer
// that lets the ranker judge a posting on its actual contents rather than its
// title — and the layer that supplies the JD fingerprint dedupe uses to catch
// the same body reposted under another company.
//
// It also returns a `reality` block (repost count, mass-posting count, a
// fake-freshness flag), which we keep: a "posted today" that is actually the
// eleventh repost of a stale req is worth knowing about before you spend an
// evening on the application.
//
// Third-party hosted service, best effort, no SLA. Every failure here is a
// degraded lane, never a failed run. Self-hosters can point FREEHIRE_API_URL
// at their own instance.

import { toJob } from '../normalize.mjs';
import { log } from '../lib/log.mjs';
import { coverageUnit, unitKey } from '../state/coverage.mjs';
import { windowForUnit, sourceHorizonMs, clampRelevanceWindow, relevanceGapLimitation } from '../state/window.mjs';

const DEFAULT_BASE = 'https://freehire.me';
const SEARCH_PATH = '/api/v1/agent/jobs/search';
const UA = 'huntley/0.1 (personal job-search digest; +https://github.com/victorjaml/huntley)';

function baseUrl() {
  return (process.env.FREEHIRE_API_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, '');
}

/** GET a `{data, meta}` envelope, retrying only transient states. */
async function apiGet(path, { maxRetries = 3, fetcher = fetch } = {}) {
  const url = `${baseUrl()}${path}`;
  let delay = 600;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetcher(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`could not reach the freehire API (${err.message})`);
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) throw new Error(`freehire API ${res.status} ${res.statusText}`);
      await new Promise((r) => setTimeout(r, delay + Math.random() * 400));
      delay = Math.min(delay * 2, 6000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`freehire API ${res.status} ${res.statusText}`);
    return res.json();
  }
  return null;
}

/**
 * "acme-robotics" → "Acme Robotics". The API returns slugs, not display names.
 *
 * A trailing numeric segment is the aggregator's own disambiguator for two
 * companies that slugified the same ("asapp-2"), not part of anyone's name, so
 * it is dropped rather than rendered as "Asapp 2" in your digest.
 */
export function prettifyCompany(slug) {
  return String(slug ?? '')
    .replace(/-\d{1,2}$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

export function freehireSearchCountries({ countries = [], locations = [] } = {}) {
  return [...new Set([
    ...countries,
    ...locations.filter((l) => /^[a-z]{2}$/i.test(l)).map((l) => l.toLowerCase()),
  ])];
}

export function freehireUnitKey(query, countries = []) {
  return unitKey('freehire', `${query}|${[].concat(countries).join(',')}`);
}

export function freehireUnitKeys({ queries = [], countries = [], locations = [] } = {}) {
  const resolved = freehireSearchCountries({ countries, locations });
  return queries.map((query) => freehireUnitKey(query, resolved));
}

/** The API's `description` is markdown/text with heavy rule lines; tidy it up. */
function tidyDescription(text) {
  return String(text ?? '')
    .replace(/^-{5,}$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildQuery({ query, limit, offset, sinceDays, countries, cities, remote, seniority, category }) {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  p.set('limit', String(limit));
  p.set('offset', String(offset));
  p.set('include_description', 'true');
  p.set('description_format', 'text');
  if (sinceDays > 0) p.set('posted_within_days', String(sinceDays));
  if (remote) p.set('work_mode', remote);
  for (const c of countries ?? []) p.append('countries', c);
  for (const c of cities ?? []) p.append('cities', c);
  for (const s of seniority ?? []) p.append('seniority', s);
  for (const c of category ?? []) p.append('category', c);
  return p;
}

/**
 * Search the aggregator.
 *
 * @param {object} opts
 * @param {string[]} opts.queries
 * @param {string[]} [opts.countries]  ISO-ish codes the API uses, e.g. ['us']
 * @param {string[]} [opts.cities]
 * @param {string}   [opts.remote]     remote | hybrid | onsite
 * @param {number}   [opts.sinceDays]
 * @param {number}   [opts.limit]      results per page
 * @param {number}   [opts.maxPages]   pages per query (default 1). Relevance-ranked; not catch-up.
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetcher]  for tests
 * @returns {Promise<import('../normalize.mjs').Job[]>}
 */
export async function searchFreehire({
  queries = [],
  countries = [],
  cities = [],
  locations = [],
  remote = null,
  seniority = [],
  category = [],
  sinceDays = 2,
  limit = 50,
  maxPages = 1,
  now = Date.now(),
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
  fetcher = fetch,
} = {}) {
  if (!queries.length) {
    log.warn('freehire source skipped: no queries configured');
    return { jobs: [], units: [] };
  }

  const resolvedCountries = freehireSearchCountries({ countries, locations });
  const resolvedCities = [...new Set([...cities, ...locations.filter((l) => !/^[a-z]{2}$/i.test(l))])];
  const pageSize = Math.max(1, Number(limit) || 50);
  const pages = Math.max(1, Number(maxPages) || 1);

  log.step(`freehire aggregator (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'})`);

  const jobs = [];
  let flagged = 0;
  const units = [];

  for (const query of queries) {
    const key = freehireUnitKey(query, resolvedCountries);
    const catchup = progress || collection
      ? windowForUnit(key, {
        progress: progress ?? {},
        runStartedAt: now,
        collection: collection ?? {},
        explicitSinceMs,
        sourceHorizonMs: sourceHorizonMs(sinceDays, now),
      })
      : { since: sinceMs ?? (now - sinceDays * 86_400_000), until: untilMs ?? now };
    const { fetchDays, gap } = clampRelevanceWindow(catchup, {
      configuredDays: sinceDays,
      untilMs: catchup.until ?? now,
    });
    const ageDays = fetchDays ?? sinceDays;
    const errors = [];
    const limitations = [];
    let pagesFetched = 0;
    let recordsFetched = 0;
    let exhausted = false;
    let total = null;

    try {
      for (let page = 1; page <= pages; page++) {
        const offset = (page - 1) * pageSize;
        const envelope = await apiGet(`${SEARCH_PATH}?${buildQuery({
          query, limit: pageSize, offset, sinceDays: ageDays,
          countries: resolvedCountries, cities: resolvedCities, remote, seniority, category,
        })}`, { fetcher });
        pagesFetched++;
        const rows = envelope?.data ?? [];
        total = Number(envelope?.meta?.total ?? offset + rows.length);
        log.trace(`  "${query}": ${offset + rows.length} of ${Number.isFinite(total) ? total : '?'} total`);

        for (const row of rows) {
          // The aggregator's own staleness detector. A req that is on its eleventh
          // repost with a freshened date is not a new posting, whatever it claims.
          const reality = row.reality ?? {};
          if (reality.fake_freshness) { flagged++; continue; }

          const job = toJob({
            url: row.url,
            title: row.title,
            company: prettifyCompany(row.company_slug ?? row.company),
            location: row.location,
            postedAt: row.posted_at,
            description: tidyDescription(row.description),
            source: 'freehire',
            sourceDetail: `freehire:${row.source ?? 'ats'}`,
          });
          if (!job) continue;

          job.repostCount = reality.repost_count ?? null;
          job.massPosting = (reality.mass_posting_count ?? 0) > 3;
          jobs.push(job);
          recordsFetched++;
        }

        if (rows.length < pageSize || offset + rows.length >= total) {
          exhausted = true;
          break;
        }
      }
    } catch (err) {
      log.warn(`  freehire "${query}": ${err.message}`);
      errors.push(err.message);
      units.push(coverageUnit({
        key,
        requestedSince: catchup.since,
        requestedUntil: catchup.until ?? now,
        status: pagesFetched > 0 ? 'partial' : 'failed',
        pagesFetched,
        recordsFetched,
        limitations: [relevanceGapLimitation(gap, { fetchDays })].filter(Boolean),
        errors,
      }));
      continue;
    }

    const truncated = !exhausted && !errors.length;
    const status = errors.length ? (pagesFetched > 0 ? 'partial' : 'failed')
      : (truncated || gap) ? 'partial'
        : 'complete';
    if (gap) limitations.push(relevanceGapLimitation(gap, { fetchDays }));
    if (truncated) {
      limitations.push(`top ${recordsFetched} of ${Number.isFinite(total) ? total : '?'} by relevance; freehire_feed covers the rest`);
    }

    units.push(coverageUnit({
      key,
      requestedSince: catchup.since,
      requestedUntil: catchup.until ?? now,
      status,
      pagesFetched,
      recordsFetched,
      limitations,
      errors,
    }));
  }

  if (flagged) log.info(`  freehire: ${flagged} posting(s) dropped as recycled reqs with a freshened date`);
  log.info(`  freehire: ${jobs.length} postings`);
  return { jobs, units };
}
