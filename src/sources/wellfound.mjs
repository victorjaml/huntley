// Wellfound (formerly AngelList Talent) public role pages.
//
// Wellfound publishes a search page per role and city — /role/l/<role>/<city>
// and /role/r/<role> for remote — for search engines, and its robots.txt allows
// them. Each server-renders its results as JSON in __NEXT_DATA__: up to 20
// startups per page, each with up to three roles carrying a title, locations,
// a start date, compensation and the full description. No login, no API key.
// Individual job pages and `?jobId=`-style URLs are disallowed; this lane never
// requests them.
//
// Many listings are auto-imported from the startup's ATS and will also arrive
// through the ATS layer; dedupe keeps the employer's own posting. What this
// lane adds is roles posted on Wellfound directly, and descriptions to rank on.
//
// VOLUME IS DELIBERATELY LOW, on the same terms as the LinkedIn lane: one page
// per role and city by default, a real gap between requests, and a stop at the
// first sign of a block. Every planned page is read each run; a safety limit
// catches a runaway config, and if it ever bites, the plan's rotation by date
// spreads the cut across days.
//
// Role and city slugs are Wellfound's own taxonomy. An unknown role slug does
// not 404 — the page silently falls back to every job in the city — so a page
// whose role Wellfound did not recognise is discarded with a warning rather than
// flooding the run with unrelated roles.

import { setTimeout as sleep } from 'node:timers/promises';
import { toJob } from '../normalize.mjs';
import { log } from '../lib/log.mjs';
import { coverageUnit, unitKey } from '../state/coverage.mjs';
import { windowForUnit, sourceHorizonMs, clampRelevanceWindow, relevanceGapLimitation } from '../state/window.mjs';

const BASE = 'https://wellfound.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';
const SLUG = /^[a-z0-9-]{1,80}$/;

export function wellfoundUnitKey(role, location) {
  return unitKey('wellfound', `${role}|${location}`);
}

export function wellfoundUnitKeys({ roles = [], locations = [] } = {}) {
  const keys = [];
  for (const location of locations) {
    for (const role of roles) keys.push(wellfoundUnitKey(role, location));
  }
  return keys;
}
export function pageUrl({ role, location, page = 1 }) {
  if (!SLUG.test(role) || !SLUG.test(location)) throw new Error(`wellfound: invalid slug "${role}" / "${location}"`);
  const path = location === 'remote' ? `/role/r/${role}` : `/role/l/${role}/${location}`;
  return `${BASE}${path}${page > 1 ? `?page=${page}` : ''}`;
}

/**
 * Read one role page.
 *
 * @param {string} html
 * @returns {{recognised: boolean, total: number, pageCount: number, jobs: object[]} | null}
 *          null when the page carries no search data at all (a changed layout or a block page)
 */
export function parseRolePage(html) {
  const m = String(html ?? '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const state = data?.props?.pageProps?.apolloState?.data;
  const talent = state?.ROOT_QUERY?.talent;
  if (!talent) return null;

  const entries = Object.entries(talent);
  const results = entries.find(([k]) => k.startsWith('seoLandingPageJobSearchResults'))?.[1];
  if (!results) return null;
  // Present only when Wellfound knows the role: seoLandingPageRoleAndLocation or
  // seoLandingPageRoleRemote. A fallback page has seoLandingPageLocation instead.
  const recognised = entries.some(([k]) => /^seoLandingPageRole(AndLocation|Remote)\b/.test(k));

  const jobs = [];
  for (const ref of results.startups ?? []) {
    const startup = state[ref?.__ref];
    if (!startup?.name) continue;
    for (const jobRef of startup.highlightedJobListings ?? []) {
      const j = state[jobRef?.__ref];
      if (!j?.id || !j.title) continue;
      const places = Array.isArray(j.locationNames) ? j.locationNames.filter(Boolean) : [];
      const remote = j.remote
        ? [`Remote${j.acceptedRemoteLocationNames?.length ? ` (${j.acceptedRemoteLocationNames.join('; ')})` : ''}`]
        : [];
      jobs.push({
        id: String(j.id),
        url: `${BASE}/jobs/${j.id}${j.slug && SLUG.test(j.slug) ? `-${j.slug}` : ''}`,
        title: j.title,
        company: startup.name,
        location: [...places, ...remote].join(' / '),
        postedAt: Number.isFinite(j.liveStartAt) ? new Date(j.liveStartAt * 1000).toISOString() : null,
        description: typeof j.description === 'string' ? j.description : null,
        compensation: j.compensation ?? null,
        jobType: j.jobType ?? null,
      });
    }
  }
  return { recognised, total: results.totalJobCount ?? jobs.length, pageCount: results.pageCount ?? 1, jobs };
}

/**
 * The day's plan: every role × location, rotated by date so a capped run starts
 * somewhere different each day.
 */
export function planPages({ roles, locations, today }) {
  const combos = [];
  for (const location of locations) for (const role of roles) combos.push({ role, location });
  if (!combos.length) return combos;
  const day = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
  const start = ((day % combos.length) + combos.length) % combos.length;
  return [...combos.slice(start), ...combos.slice(0, start)];
}

async function fetchPage(url, { timeoutMs = 20_000 } = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    // 403 here is Cloudflare's challenge, not a missing page: treat it as a block.
    if (res.status === 429 || res.status === 403) return { blocked: `HTTP ${res.status}` };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

/**
 * Search Wellfound's public role pages.
 *
 * @param {object} opts
 * @param {string[]} opts.roles        Wellfound role slugs ("machine-learning-engineer")
 * @param {string[]} opts.locations    Wellfound city slugs ("los-angeles"), or "remote"
 * @param {number}  [opts.maxAgeDays]  drop roles that went live longer ago than this
 * @param {number}  [opts.maxPages]    pages per role × location
 * @param {number}  [opts.delayMs]     gap between requests
 * @param {number}  [opts.requestLimit] safety limit on requests this run; the plan is otherwise read in full
 * @param {string}  [opts.today]       YYYY-MM-DD, for rotation
 * @param {(url: string) => Promise<object>} [opts.fetcher]  for tests
 * @returns {Promise<{jobs: object[], warnings: string[]}>}
 */
export async function searchWellfound({
  roles = [],
  locations = [],
  maxAgeDays = 14,
  maxPages = 1,
  delayMs = 6_000,
  requestLimit = 100,
  today = new Date().toISOString().slice(0, 10),
  fetcher = fetchPage,
  now = Date.now(),
  sinceMs = null,
  untilMs = null,
  progress = null,
  collection = null,
  explicitSinceMs = null,
} = {}) {
  const warnings = [];
  const combos = planPages({ roles, locations, today });
  if (!combos.length) {
    log.warn('Wellfound source skipped: no roles or locations configured');
    return { jobs: [], warnings, units: [] };
  }

  // Every planned page is read: first pages for every role and city, then
  // further pages where they exist. requestLimit is a safety limit for a
  // mistyped config, not a budget; when it bites, the rotation above means a
  // different part of the plan is cut each day.
  const planned = combos.length * maxPages;
  if (planned > requestLimit) {
    warnings.push(`Wellfound: ${planned} pages planned but request_limit is ${requestLimit} — reading ${requestLimit}; the rest rotate across days`);
  }
  log.step(`Wellfound role pages (${combos.length} role × location, up to ${Math.min(planned, requestLimit)} requests, ${Math.round(delayMs / 1000)}s apart)`);
  const windows = new Map();
  for (const combo of combos) {
    const key = wellfoundUnitKey(combo.role, combo.location);
    const catchup = progress || collection
      ? windowForUnit(key, {
        progress: progress ?? {},
        runStartedAt: now,
        collection: collection ?? {},
        explicitSinceMs,
        sourceHorizonMs: sourceHorizonMs(maxAgeDays, now),
      })
      : { since: sinceMs ?? (now - maxAgeDays * 86_400_000), until: untilMs ?? now };
    const clamped = clampRelevanceWindow(catchup, {
      configuredDays: maxAgeDays,
      untilMs: catchup.until ?? now,
    });
    windows.set(key, { catchup, ...clamped });
  }
  const jobs = [];
  const seen = new Set();
  let requests = 0, read = 0, stopped = false, stopWhy = null;
  const states = new Map(combos.map((combo) => [wellfoundUnitKey(combo.role, combo.location), {
    combo,
    status: 'queued',
    pagesFetched: 0,
    recordsFetched: 0,
    pageCount: Infinity,
    errors: [],
    limitations: [],
  }]));

  for (let page = 1; page <= maxPages && !stopped; page++) {
    for (const combo of combos) {
      const key = wellfoundUnitKey(combo.role, combo.location);
      const st = states.get(key);
      if (st.status !== 'queued' && st.status !== 'active') continue;
      if (Number.isFinite(st.pageCount) && page > st.pageCount) {
        st.status = 'complete';
        continue;
      }
      if (requests >= requestLimit) {
        stopped = true;
        stopWhy = `request_limit ${requestLimit}`;
        break;
      }
      if (requests > 0) await sleep(delayMs + Math.floor(Math.random() * Math.min(2000, delayMs / 3)));
      requests++;
      st.status = 'active';

      const res = await fetcher(pageUrl({ ...combo, page }));
      if (res.blocked) {
        warnings.push(`Wellfound answered ${res.blocked} — stopped for this run`);
        st.errors.push(res.blocked);
        st.limitations.push('blocked');
        st.status = st.pagesFetched > 0 ? 'partial' : 'failed';
        stopped = true;
        stopWhy = 'blocked';
        break;
      }
      if (res.error) {
        log.warn(`Wellfound ${combo.role} @ ${combo.location} p${page}: ${res.error}`);
        st.errors.push(res.error);
        st.status = st.pagesFetched > 0 ? 'partial' : 'failed';
        continue;
      }

      const parsed = parseRolePage(res.html);
      if (!parsed) {
        warnings.push(`Wellfound ${combo.role} @ ${combo.location}: page had no search data (layout changed, or a challenge page)`);
        st.status = 'failed';
        st.limitations.push('no search data');
        continue;
      }
      if (!parsed.recognised) {
        warnings.push(`Wellfound does not recognise the role "${combo.role}" — check sources.wellfound.roles`);
        st.status = 'unsupported';
        st.limitations.push(`unrecognised role ${combo.role}`);
        continue;
      }
      read++;
      st.pagesFetched++;
      st.pageCount = parsed.pageCount ?? 1;
      let fresh = 0;
      for (const raw of parsed.jobs) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        const cutoff = windows.get(key)?.fetchSince;
        if (raw.postedAt && cutoff != null && Date.parse(raw.postedAt) < cutoff) continue;
        fresh++;
        const job = toJob({
          url: raw.url,
          title: raw.title,
          company: raw.company,
          location: raw.location,
          postedAt: raw.postedAt,
          description: raw.description,
          source: 'wellfound',
          sourceDetail: `wellfound:${combo.role}${combo.location === 'remote' ? ' (remote)' : ` @ ${combo.location}`}`,
        });
        if (job) jobs.push(job);
      }
      st.recordsFetched += fresh;
      log.trace(`  ${combo.role} @ ${combo.location} p${page}: ${parsed.jobs.length} roles, ${fresh} recent`);
      if (st.pagesFetched >= st.pageCount) st.status = 'complete';
      else if (page >= maxPages) {
        st.status = 'partial';
        st.limitations.push(`max_pages ${maxPages} reached; ${st.pageCount} pages available`);
      }
    }
  }

  for (const st of states.values()) {
    if (st.status === 'queued') {
      st.status = 'partial';
      st.limitations.push(stopWhy === 'blocked'
        ? 'blocked; not fetched this run'
        : stopWhy
          ? `${stopWhy}; not fetched this run`
          : 'not fetched this run');
    } else if (st.status === 'active') {
      st.status = 'partial';
      st.limitations.push(stopWhy || `max_pages ${maxPages} reached; ${st.pageCount} pages available`);
    }
  }

  log.info(`  wellfound: ${read} page(s) read in ${requests} request(s), ${jobs.length} recent roles`);
  const units = combos.map((combo) => {
    const key = wellfoundUnitKey(combo.role, combo.location);
    const win = windows.get(key);
    const st = states.get(key);
    const limitations = [...st.limitations];
    let status = st.status;
    if (win.gap) {
      const note = relevanceGapLimitation(win.gap, { fetchDays: win.fetchDays });
      if (note) limitations.push(note);
      if (status === 'complete') status = 'partial';
    }
    return coverageUnit({
      key,
      requestedSince: win.catchup.since,
      requestedUntil: win.catchup.until ?? win.until,
      status,
      pagesFetched: st.pagesFetched,
      recordsFetched: st.recordsFetched,
      limitations,
      errors: st.errors,
    });
  });
  return { jobs, warnings, requests, units };
}
