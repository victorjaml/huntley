// Dedupe across layers.
//
// The same role reaches you three ways: the company's Greenhouse board, a
// LinkedIn card that links to that same board, and an aggregator that scraped
// it. Collapsing them is the whole reason to scan more than one layer.
//
// Three passes, cheapest first:
//   1. canonical URL          — exact same posting, different tracking params
//   2. ATS req identity       — two hosts, one Greenhouse/Lever/Ashby req id
//   3. company + title        — the board copy and the ATS copy of one role
//
// When copies merge, the surviving record keeps the ATS URL (you want to apply
// on the company's own board, not through a board's redirect) and the union of
// what each copy knew — a LinkedIn card often carries a posted date the ATS
// API omitted, and the ATS copy usually carries the description.

import { canonicalUrl, companyKey, titleKey, isoDate } from './normalize.mjs';
import { createHash } from 'node:crypto';

// Source layers, best-to-worst as an *apply destination*. A tie in information
// is broken by preferring the URL you would actually rather open.
const SOURCE_RANK = { watchlist: 0, portfolio: 1, ats_sweep: 1, freehire: 2, freehire_feed: 2, linkedin: 3, wellfound: 3, unknown: 9 };

// Hosts that are a board's copy of someone else's posting, never the origin.
const AGGREGATOR_HOST = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|wellfound\.com|angel\.co|ziprecruiter\.com|simplyhired\.com|jobs\.google\.com|freehire\.me)$/i;

/**
 * Extract a vendor-stable requisition identity from an ATS URL, e.g.
 * greenhouse:acme:4012345. Returns null when the URL is not a known ATS.
 */
export function atsIdentity(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  const at = (vendor, org, req) => (org && req ? `${vendor}:${org.toLowerCase()}:${String(req).toLowerCase()}` : null);

  // Greenhouse: boards.greenhouse.io/org/jobs/123, job-boards.greenhouse.io/org/jobs/123
  if (/greenhouse\.io$/.test(host)) {
    const m = path.match(/^\/(?:embed\/job_app\/?)?([^/]+)\/jobs\/(\d+)/);
    if (m) return at('greenhouse', m[1], m[2]);
    const gh = u.searchParams.get('gh_jid');
    if (gh) return at('greenhouse', m?.[1] ?? host, gh);
  }
  // Lever: jobs.lever.co/org/<uuid>
  if (/lever\.co$/.test(host)) {
    const m = path.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
    if (m) return at('lever', m[1], m[2]);
  }
  // Ashby: jobs.ashbyhq.com/org/<uuid>
  if (/ashbyhq\.com$/.test(host)) {
    const m = path.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
    if (m) return at('ashby', m[1], m[2]);
  }
  // Workday: org.wdN.myworkdayjobs.com/<site>/job/<loc>/<slug>_R-12345
  if (/myworkdayjobs\.com$/.test(host)) {
    const req = path.match(/_(R-?\d+|JR-?\d+)\b/i)?.[1];
    const org = host.split('.')[0];
    if (req) return at('workday', org, req);
  }
  // SmartRecruiters / Workable / Recruitee / Breezy / Jobvite: last numeric-ish segment
  for (const [vendor, re] of [
    ['smartrecruiters', /smartrecruiters\.com$/],
    ['workable',        /workable\.com$/],
    ['recruitee',       /recruitee\.com$/],
    ['breezy',          /breezy\.hr$/],
    ['jobvite',         /jobvite\.com$/],
    ['bamboohr',        /bamboohr\.com$/],
  ]) {
    if (re.test(host)) {
      const org = host.split('.')[0];
      const req = path.split('/').filter(Boolean).pop();
      if (req && req.length > 3) return at(vendor, org, req);
    }
  }
  return null;
}

/** A stable id for a job, used as the dedupe key and in Add links. */
export function jobId(job) {
  const basis = atsIdentity(job.url) ?? `url:${canonicalUrl(job.url)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function isAggregatorUrl(url) {
  try { return AGGREGATOR_HOST.test(new URL(url).hostname); } catch { return false; }
}

/** Prefer the copy you would rather apply through, then the richer record. */
function preferred(a, b) {
  const aAgg = isAggregatorUrl(a.url), bAgg = isAggregatorUrl(b.url);
  if (aAgg !== bAgg) return aAgg ? b : a;

  const aRank = SOURCE_RANK[a.source] ?? 9, bRank = SOURCE_RANK[b.source] ?? 9;
  if (aRank !== bRank) return aRank < bRank ? a : b;

  const info = (j) => (j.description ? 2 : 0) + (j.postedAt ? 1 : 0);
  return info(a) >= info(b) ? a : b;
}

/** Merge the loser's knowledge into the winner without overwriting what it has. */
function merge(winner, loser) {
  const mergedSources = new Set([...(winner.mergedFrom ?? []), winner.source, loser.source, ...(loser.mergedFrom ?? [])]);
  mergedSources.delete(winner.source);
  const description = winner.description || loser.description || null;
  return {
    ...winner,
    postedAt: winner.postedAt ?? loser.postedAt,
    description,
    fingerprint: winner.fingerprint ?? loser.fingerprint,
    location: winner.location || loser.location,
    watchlist: winner.watchlist || loser.watchlist,
    // Earliest sighting wins: "new today" must mean new, not newly re-seen.
    firstSeen: [winner.firstSeen, loser.firstSeen].filter(Boolean).sort()[0],
    mergedFrom: [...mergedSources].filter(Boolean).sort(),
    altUrls: [...new Set([...(winner.altUrls ?? []), ...(loser.altUrls ?? []), loser.url])].filter((u) => u !== winner.url),
    // Never replace a nonempty description with empty; keep provenance from the
    // copy that supplied the surviving text.
    evidenceLevel: description
      ? (winner.description ? (winner.evidenceLevel ?? 'description') : (loser.evidenceLevel ?? 'description'))
      : (winner.evidenceLevel ?? loser.evidenceLevel ?? 'metadata_only'),
    descriptionOrigin: description
      ? (winner.description ? (winner.descriptionOrigin ?? null) : (loser.descriptionOrigin ?? null))
      : (winner.descriptionOrigin ?? loser.descriptionOrigin ?? null),
    // Keep board identity for enrichment (`?gh_jid=` company-domain Greenhouse).
    board: winner.board ?? loser.board ?? null,
  };
}

/**
 * Collapse a mixed-source job list into one deduped, id-assigned list.
 * @param {import('./normalize.mjs').Job[]} jobs
 * @returns {{jobs: import('./normalize.mjs').Job[], collapsed: number}}
 */
export function dedupe(jobs) {
  /** @type {Map<string, object>} */
  const byKey = new Map();   // every alias key -> canonical record holder
  /** @type {Map<string, object>} */
  const records = new Map(); // record id -> record

  let collapsed = 0;
  let seq = 0;

  const keysFor = (job) => {
    const keys = [`u:${canonicalUrl(job.url)}`];
    const ats = atsIdentity(job.url);
    if (ats) keys.push(`a:${ats}`);
    if (job.fingerprint) keys.push(`f:${job.companyKey}|${job.fingerprint}`);
    return keys;
  };

  const companyTitleCompatible = (a, b) => {
    if (!a.companyKey || !b.companyKey || a.companyKey !== b.companyKey) return false;
    if (titleKey(a.title) !== titleKey(b.title)) return false;
    const atsA = atsIdentity(a.url);
    const atsB = atsIdentity(b.url);
    if (atsA && atsB && atsA !== atsB) return false;
    const la = (a.location || '').trim().toLowerCase();
    const lb = (b.location || '').trim().toLowerCase();
    if (la && lb && la !== lb && !la.includes(lb) && !lb.includes(la)) return false;
    return true;
  };

  for (const job of jobs) {
    const keys = keysFor(job);
    const hitIds = [...new Set(keys.map((k) => byKey.get(k)).filter(Boolean))];

    if (hitIds.length === 0) {
      for (const [rid, rec] of records) {
        if (companyTitleCompatible(rec, job)) {
          hitIds.push(rid);
          break;
        }
      }
    }

    if (hitIds.length === 0) {
      const rid = `r${seq++}`;
      records.set(rid, { ...job });
      for (const k of keys) byKey.set(k, rid);
      continue;
    }

    // One or more existing records match. Fold them all together.
    let survivor = records.get(hitIds[0]);
    for (const rid of hitIds.slice(1)) {
      const other = records.get(rid);
      const win = preferred(survivor, other);
      survivor = merge(win, win === survivor ? other : survivor);
      records.delete(rid);
      collapsed++;
    }
    const win = preferred(survivor, job);
    survivor = merge(win, win === survivor ? job : survivor);
    collapsed++;

    const rid = hitIds[0];
    records.set(rid, survivor);
    for (const k of [...keys, ...keysFor(survivor)]) byKey.set(k, rid);
    // Re-point aliases of the records we just absorbed.
    for (const [k, v] of byKey) if (hitIds.includes(v)) byKey.set(k, rid);
  }

  const out = [...records.values()].map((job) => ({ ...job, id: jobId(job) }));
  return { jobs: out, collapsed };
}
