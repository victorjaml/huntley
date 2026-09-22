// freehire's whole recent feed, as a wide net and a board-discovery source.
//
// The keyword lane (freehire.mjs) asks freehire a handful of questions. This
// lane reads everything it first recorded in the last `open_within_days` for
// the chosen countries — about 9,000 US roles a day across 236 sources — and
// filters locally with your preferences, so the searches you did not think to
// write still reach you.
//
// Its second job matters more. freehire holds only part of each vendor's
// roles (a sample against boards read directly: roughly 60–80% for Gem, Lever,
// Ashby, BambooHR and Pinpoint, 35–40% for Rippling and Workable). So every
// role carries its board, and once one scores above the threshold,
// active-boards.mjs reads that board directly — all of that company's roles,
// same day.
// freehire finds the company; huntley reads the company.
//
// Sources the downloaded ATS dataset already covers completely are excluded by
// default, as are aggregators whose links lead to their own pages rather than
// an employer's.
//
// The API is public and asks callers to identify themselves and pace by its
// X-RateLimit headers (600 reads a minute). Paging is by offset, sorted by
// created_at ascending so rows arriving mid-run cannot shift earlier pages,
// and offset + limit may not exceed 10,000, so sources are grouped to keep each
// query under that.

import { setTimeout as sleep } from 'node:timers/promises';
import { toJob } from '../normalize.mjs';
import { log } from '../lib/log.mjs';
import { extractBoards, boardFor } from './funds/boards.mjs';

const BASE = () => (process.env.FREEHIRE_API_URL?.trim() || 'https://freehire.me').replace(/\/+$/, '');
const UA = 'victorjaml/huntley (+https://github.com/victorjaml/huntley)';
const PAGE = 100;
const OFFSET_CAP = 10_000;

export const DEFAULT_EXCLUDE = [
  // Read in full by the ATS dataset lane.
  'greenhouse', 'lever', 'ashby', 'workday', 'bamboohr', 'paylocity',
  // Read by their own lanes.
  'wellfound', 'workatastartup',
  // Aggregators: their links are their own pages, not an employer's posting.
  'adzuna', 'himalayas', 'remotedotcom', 'jobleads', 'whatjobs',
];

/**
 * The board a freehire row was posted on, for reading it directly later.
 * The URL decides when it links the board; otherwise freehire's `external_id`
 * ("<board>:<job id>") names it — Workable links /j/<code> with no board in it,
 * and Greenhouse roles are often served from the company's own domain.
 */
export function freehireBoard(row) {
  const source = String(row?.source ?? '').toLowerCase();
  const url = String(row?.url ?? '');
  const id = String(row?.external_id ?? '');
  const head = id.includes(':') ? id.slice(0, id.lastIndexOf(':')) : '';

  const linked = extractBoards(url)[0];
  if (linked && linked.vendor === source) return strip(linked);
  const named = boardFor(source, head);
  if (named) return strip(named);

  // Enterprise systems career-ops reads from a URL (verified 2026-09-14). They
  // name a provider explicitly because most run on the employer's own domain.
  const host = head.split('/')[0];
  const safeHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : null;
  switch (source) {
    case 'icims':
      return /^[a-z0-9-]+$/i.test(head) ? { vendor: 'icims', provider: 'icims', slug: head, careers_url: `https://careers-${head.toLowerCase()}.icims.com/jobs/search?ss=1&in_iframe=1` } : null;
    case 'avature':
      return safeHost ? { vendor: 'avature', provider: 'avature', slug: safeHost, careers_url: `https://${safeHost}/careers` } : null;
    case 'successfactors':
      return safeHost ? { vendor: 'successfactors', provider: 'successfactors', slug: safeHost, careers_url: `https://${safeHost}` } : null;
    case 'oracle': {
      const site = head.split('/')[1];
      return safeHost && /^[A-Za-z0-9_-]+$/.test(site ?? '')
        ? { vendor: 'oracle', provider: 'oraclecloud', slug: `${safeHost}/${site}`, careers_url: `https://${safeHost}/hcmUI/CandidateExperience/en/sites/${site}` }
        : null;
    }
    case 'phenom': {
      let locale = 'us/en';
      try { const [a, b] = new URL(url).pathname.split('/').filter(Boolean); if (/^[a-z]{2}$/.test(a) && /^[a-z]{2}$/.test(b)) locale = `${a}/${b}`; } catch { /* default */ }
      return safeHost ? { vendor: 'phenom', provider: 'phenom', slug: safeHost, careers_url: `https://${safeHost}/${locale}` } : null;
    }
    default:
      return null;
  }
}

const strip = ({ vendor, slug, careers_url }) => ({ vendor, slug, careers_url });

/** Split sources into groups whose combined count stays under the offset cap. */
export function groupSources(counts, cap = OFFSET_CAP - PAGE) {
  const groups = [];
  let current = [], total = 0;
  for (const [source, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    if (!n) continue;
    if (current.length && total + n > cap) { groups.push({ sources: current, total }); current = []; total = 0; }
    current.push(source);
    total += n;
  }
  if (current.length) groups.push({ sources: current, total });
  return groups;
}

/** One freehire row as a huntley Job, carrying its board. */
export function feedJob(row) {
  let url = row?.url;
  try { const u = new URL(url); u.searchParams.delete('utm_source'); url = u.toString(); } catch { /* toJob rejects it */ }
  const job = toJob({
    url,
    title: row?.title,
    company: row?.company,
    location: row?.location,
    postedAt: row?.posted_at ?? row?.created_at ?? null,
    description: row?.description ?? null,
    source: 'freehire_feed',
    sourceDetail: `freehire:${row?.source ?? '?'}`,
  });
  if (job) job.board = freehireBoard(row);
  return job;
}

async function getJson(path, { signal } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE()}${path}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(60_000) });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000 || 2000 * (attempt + 1);
      await sleep(Math.min(wait, 30_000));
      continue;
    }
    if (!res.ok) throw new Error(`freehire ${res.status} for ${path.split('?')[0]}`);
    // Pace before the budget runs out rather than meeting a 429. An absent
    // header means the budget is unknown, not exhausted — Number(null) is 0,
    // which would put a reset-length sleep after every single response.
    const header = res.headers.get('x-ratelimit-remaining');
    const remaining = header == null ? NaN : Number(header);
    if (Number.isFinite(remaining) && remaining < 20) await sleep(Number(res.headers.get('x-ratelimit-reset') ?? 1) * 1000);
    const body = await res.json();
    if (body?.meta?.ignored_params?.length) {
      throw new Error(`freehire ignored ${body.meta.ignored_params.map((p) => p.param).join(', ')} — the API changed`);
    }
    return body;
  }
  throw new Error(`freehire kept refusing ${path.split('?')[0]}`);
}

/**
 * Read freehire's recent feed.
 *
 * @param {object} opts
 * @param {string[]} [opts.countries]       e.g. ['us']
 * @param {number}   [opts.openWithinDays]  first recorded by freehire within this many days
 * @param {string[]} [opts.excludeSources]
 * @param {number}   [opts.concurrency]
 * @param {(jobs: object[]) => object[]} [opts.keep]  applied per page, so memory holds only what is kept
 * @returns {Promise<{jobs: object[], total: number, requests: number, sources: number}>}
 */
export async function readFreehireFeed({ countries = ['us'], openWithinDays = 2, excludeSources = DEFAULT_EXCLUDE, concurrency = 3, keep = (j) => j } = {}) {
  const base = new URLSearchParams({ open_within_days: String(openWithinDays) });
  for (const c of countries) base.append('countries', c);

  const facets = await getJson(`/api/v1/jobs/facets?${base}`);
  const raw = facets?.data?.facets?.source ?? {};
  const counts = Array.isArray(raw) ? Object.fromEntries(raw.map((x) => [x.value, x.count])) : { ...raw };
  const excluded = (s) => excludeSources.some((e) => s === e || s.startsWith(`${e}-`));
  for (const s of Object.keys(counts)) if (excluded(s)) delete counts[s];

  const tasks = [];
  const groups = groupSources(counts);
  groups.forEach((group, g) => {
    for (let offset = 0; offset < group.total; offset += PAGE) tasks.push({ sources: group.sources, offset, g });
  });

  // For a group cut off at the offset ceiling, how far its ascending read got.
  // Everything up to the newest created_at it returned was read in full, so
  // the earliest such point across capped groups is how far this run covered.
  // Without it a capped run could never checkpoint, and every run re-read the
  // 30-day bootstrap window: 185k rows, 1,864 requests, 14 minutes.
  const reachedByGroup = new Map();
  const cappedGroups = new Set();

  const jobs = [];
  let requests = 1, total = 0, i = 0, capped = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      const { sources, offset, g } = tasks[i++];
      // Past the API's offset ceiling the request is a 400, not an empty page.
      // Record the gap in coverage and stop asking rather than failing the lane.
      if (offset + PAGE > OFFSET_CAP) { capped = true; cappedGroups.add(g); continue; }
      const p = new URLSearchParams(base);
      for (const s of sources) p.append('source', s);
      p.set('sort', 'created_at');
      p.set('order', 'asc');
      p.set('limit', String(PAGE));
      p.set('offset', String(offset));
      const body = await getJson(`/api/v1/jobs/search?${p}`);
      requests++;
      const rows = Array.isArray(body?.data) ? body.data : [];
      total += rows.length;
      for (const row of rows) {
        const at = Date.parse(row?.created_at ?? '');
        if (Number.isFinite(at) && at > (reachedByGroup.get(g) ?? -Infinity)) reachedByGroup.set(g, at);
      }
      jobs.push(...keep(rows.map(feedJob).filter(Boolean)));
    }
  }));

  let coveredThrough = null;
  if (capped) {
    const reached = [...cappedGroups].map((g) => reachedByGroup.get(g));
    // A capped group that returned no dated row tells us nothing: stay unset.
    if (reached.length && reached.every(Number.isFinite)) {
      coveredThrough = new Date(Math.min(...reached)).toISOString();
    }
  }

  log.debug(`freehire feed: ${total} rows from ${Object.keys(counts).length} sources in ${requests} requests`);
  return { jobs, total, requests, sources: Object.keys(counts).length, capped, coveredThrough };
}
