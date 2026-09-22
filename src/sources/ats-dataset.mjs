// The ATS layer, downloaded instead of crawled.
//
// job-board-aggregator (github.com/Feashliaa/job-board-aggregator, MIT) crawls
// every known Greenhouse, Lever, Ashby, Workday, BambooHR, iCIMS and Paylocity
// board once a day and publishes every open role — about 1.4M — as ~58 gzip
// files of 25,000 jobs each. Downloading them takes seconds. Crawling the same
// boards ourselves took over an hour: 38,000 boards, a third to three quarters
// of them long dead, and Workday rate-limiting the rest.
//
// What it costs: the dataset is up to a day behind, it names companies by board
// slug ("ngc", not "Northrop Grumman"), and it is one person's project. So:
//   - roles here are refreshed same-day by the active-boards lane, which fetches
//     directly every board that has produced a role scoring above the threshold;
//   - company names are resolved from the boards themselves (board-names.mjs)
//     before any company rule runs, so a block list still works;
//   - a dataset that is stale or unreachable is reported in the digest, and
//     huntley falls back to sweeping Greenhouse, Lever and Ashby itself.
//
// A role counts as new when the dataset first saw it (`first_seen`): the
// dataset carries no posting date of its own.

import { gunzipSync } from 'node:zlib';
import { toJob } from '../normalize.mjs';
import { extractBoards } from './funds/boards.mjs';
import { log } from '../lib/log.mjs';

export const DATASET_BASE = 'https://feashliaa.github.io/job-board-data/data/chunks';

async function fetchWithTimeout(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'huntley (personal job search)' } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
  return res;
}

const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const BOARD_FROM_SLUG = {
  greenhouse: (s) => `https://job-boards.greenhouse.io/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
  bamboohr: (s) => `https://${s}.bamboohr.com/careers`,
};

/**
 * The board a dataset role was posted on. The dataset names the ATS and the
 * board slug, which is more reliable than the URL: a Greenhouse role can live
 * at wayve.firststage.co/jobs?gh_jid=… . Workday's board is in the URL.
 */
export function datasetBoard(row) {
  const ats = String(row?.ats ?? '').toLowerCase();
  const slug = String(row?.company ?? '');
  if (BOARD_FROM_SLUG[ats] && SLUG_OK.test(slug)) return { vendor: ats, slug, careers_url: BOARD_FROM_SLUG[ats](slug) };
  const fromUrl = extractBoards(row?.url ?? '')[0];
  return fromUrl ? { vendor: fromUrl.vendor, slug: fromUrl.slug, careers_url: fromUrl.careers_url } : null;
}

/**
 * Recent roles from one parsed chunk, as huntley Jobs.
 *
 * @param {object[]} rows       one chunk's jobs
 * @param {object}   opts
 * @param {number}   opts.since     epoch ms; roles first seen before this are skipped
 * @param {Set<string>} opts.ats    ATS names to keep, lowercased ("workday")
 */
export function datasetJobs(rows, { since, ats, until = Infinity }) {
  const out = [];
  for (const r of rows ?? []) {
    if (!r || typeof r.url !== 'string' || typeof r.title !== 'string') continue;
    if (ats && !ats.has(String(r.ats ?? '').toLowerCase())) continue;
    const firstSeen = Date.parse(r.first_seen ?? '');
    const undated = !Number.isFinite(firstSeen);
    if (!undated && firstSeen < since) continue;
    if (!undated && Number.isFinite(until) && firstSeen > until) continue;
    const job = toJob({
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      postedAt: undated ? null : r.first_seen,
      source: 'ats_sweep',
      sourceDetail: `${r.ats} · job-board-aggregator`,
    });
    if (job) {
      // Most ATSes give the dataset a board slug, not a name; board-names.mjs
      // replaces it. Paylocity's company field is already a name.
      if (String(r.ats).toLowerCase() !== 'paylocity') job.companySlug = true;
      job.board = datasetBoard(r);
      job.firstSeenUpstream = undated ? null : r.first_seen;
      job.timestampProvenance = {
        firstSeenUpstream: undated ? null : r.first_seen,
        postedAt: job.postedAt,
        uncertain: undated,
      };
      out.push(job);
    }
  }
  return out;
}

/** Hours since the dataset was last rebuilt, or Infinity when unreadable. */
export function datasetAgeHours(manifest, now = Date.now()) {
  const t = Date.parse(manifest?.last_updated ?? '');
  return Number.isFinite(t) ? (now - t) / 3_600_000 : Infinity;
}

/**
 * Download the dataset and return its recent roles.
 *
 * @param {object} opts
 * @param {number} [opts.sinceDays]      keep roles first seen within this many days
 * @param {number} [opts.sinceMs]        explicit lower bound (catch-up)
 * @param {number} [opts.untilMs]        explicit upper bound (frozen clock)
 * @param {string[]} [opts.ats]          ATS names to keep
 * @param {number} [opts.maxAgeHours]    older than this counts as stale
 * @param {number} [opts.concurrency]
 * @param {string} [opts.base]
 * @returns {Promise<{jobs: object[], lastUpdated: string, ageHours: number, total: number, stale: boolean, snapshotAt: number, units: object[]}>}
 */
export async function downloadDataset({
  sinceDays = 3,
  sinceMs = null,
  untilMs = null,
  ats = null,
  maxAgeHours = 48,
  concurrency = 8,
  base = DATASET_BASE,
  now = Date.now(),
} = {}) {
  const manifest = await (await fetchWithTimeout(`${base}/jobs_manifest.json?t=${now}`, 30_000)).json();
  if (!Array.isArray(manifest?.chunks) || !manifest.chunks.length) throw new Error('dataset manifest lists no chunks');
  const ageHours = datasetAgeHours(manifest, now);

  const keepAts = ats ? new Set(ats.map((a) => String(a).toLowerCase())) : null;
  const since = sinceMs ?? (now - sinceDays * 86_400_000);
  const until = untilMs ?? now;
  const snapshotAt = Date.parse(manifest.last_updated ?? '') || now;
  const jobs = [];
  let total = 0, i = 0;
  const v = encodeURIComponent(manifest.last_updated ?? '');

  // Parsed one chunk at a time and filtered on the spot: holding all 1.4M roles
  // at once would need several GB of heap for the few thousand that are recent.
  await Promise.all(Array.from({ length: Math.min(concurrency, manifest.chunks.length) }, async () => {
    while (i < manifest.chunks.length) {
      const name = manifest.chunks[i++];
      if (!/^[\w.-]+\.json\.gz$/.test(name)) throw new Error(`unexpected chunk name "${name}"`);
      const buf = Buffer.from(await (await fetchWithTimeout(`${base}/${name}?v=${v}`, 120_000)).arrayBuffer());
      const rows = JSON.parse(gunzipSync(buf));
      total += rows.length;
      for (const job of datasetJobs(rows, { since, until, ats: keepAts })) jobs.push(job);
    }
  }));

  const stale = ageHours > maxAgeHours;
  const snapshotMs = Math.min(snapshotAt, now);
  log.debug(`dataset: ${total} roles, ${jobs.length} first seen since ${new Date(since).toISOString()}, rebuilt ${ageHours.toFixed(1)}h ago`);
  return {
    jobs,
    lastUpdated: manifest.last_updated,
    ageHours,
    total,
    stale,
    snapshotAt: snapshotMs,
    units: [{
      key: 'ats_dataset:manifest',
      requestedSince: new Date(since).toISOString(),
      requestedUntil: new Date(until).toISOString(),
      coveredThrough: stale ? null : new Date(snapshotMs).toISOString(),
      status: stale ? 'partial' : 'complete',
      pagesFetched: manifest.chunks.length,
      recordsFetched: total,
      continuation: null,
      limitations: [
        `dataset snapshot time ${manifest.last_updated ?? 'unknown'}`,
        ...(stale ? [`dataset is ${ageHours.toFixed(1)}h old (max_age_hours ${maxAgeHours})`] : []),
      ],
      errors: [],
    }],
  };
}
