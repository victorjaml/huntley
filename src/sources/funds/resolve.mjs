// Resolving a company to its job board.
//
// The company's own website is the authority: its careers page links to the
// board it actually uses. Guessing a slug instead (does greenhouse.io/streak
// exist?) finds boards that share a name with the company and belong to someone
// else, and probing eleven vendors per company is slower than reading one page.
//
// At most three pages per company: the homepage, then the careers links it
// offers (or /careers and /jobs when it offers none). The first board that
// actually exists wins. Results are cached — see index.mjs — so this runs
// once per company a month, not once per run.

import { extractBoards, careersLinks, siteKey } from './boards.mjs';
import { companyKey } from '../../normalize.mjs';

const MAX_PAGES = 3;
const MAX_CHECKS_PER_PAGE = 5;
// Ashby's posting-api sits on a ~10s latency floor; the Ashby provider
// allows 30s. The resolver used to use 8s, so a slow-but-live board looked
// missing and was cached as dead_link for a fortnight.
export const BOARD_CHECK_TIMEOUT_MS = 30_000;
export const REJECTED_TTL_MS = 90 * 86_400_000;
export const DEADLINE_ERROR = 'board check reached the resolve deadline';

function urlKey(url) {
  return String(url ?? '').replace(/\/+$/, '').toLowerCase();
}

function isDeadRejection(entry) {
  const s = entry?.status;
  return s === 404 || s === 410 || s === 'empty';
}

/**
 * Persist only proof-the-board-is-gone. Timeouts and 5xx are not carried
 * across runs (they would grow forever on a flaky URL). One entry per URL;
 * anything older than ~90 days is forgotten so a board that comes back is
 * eligible again.
 */
export function compactRejected(entries, { now = Date.now(), ttlMs = REJECTED_TTL_MS } = {}) {
  const byUrl = new Map();
  for (const e of entries ?? []) {
    if (!isDeadRejection(e)) continue;
    const key = urlKey(e.careers_url);
    if (!key) continue;
    const at = Number.isFinite(e.at) ? e.at : now;
    if (now - at > ttlMs) continue;
    const prev = byUrl.get(key);
    if (!prev || at >= (prev.at ?? 0)) {
      byUrl.set(key, { careers_url: e.careers_url, status: e.status, at });
    }
  }
  return [...byUrl.values()];
}

function rememberDead(rejected, careers_url, status, now) {
  if (!isDeadRejection({ status })) return;
  const key = urlKey(careers_url);
  if (!key) return;
  const entry = { careers_url, status, at: now };
  const i = rejected.findIndex((r) => urlKey(r.careers_url) === key);
  if (i >= 0) rejected[i] = entry;
  else rejected.push(entry);
}

function finish(status, extra = {}, rejected, now = Date.now()) {
  const kept = compactRejected(rejected, { now });
  return kept.length ? { status, rejected: kept, ...extra } : { status, ...extra };
}

/**
 * @param {string} website
 * @param {{fetchText: Function, fetchJson: Function}} http
 * @param {{rejected?: {careers_url: string, status?: unknown, at?: number}[], deadlineAt?: number|null}} [opts]
 * @returns {Promise<{status: 'found', board: object, via: string, rejected?: object[]} | {status: 'none', rejected?: object[]} | {status: 'dead_link', rejected: object[]} | {status: 'error', error: string, deadline?: true, rejected?: object[]}>}
 */
export async function resolveWebsite(website, http, { rejected: priorRejected = [], deadlineAt = null } = {}) {
  const site = siteKey(website);
  if (!site) return { status: 'error', error: 'not a website URL' };
  const home = `https://${site}/`;
  const now = Date.now();
  const rejected = compactRejected(priorRejected, { now });
  const skip = new Set(rejected.map((r) => urlKey(r.careers_url)).filter(Boolean));
  let transient = null;

  let html;
  try {
    html = await http.fetchText(home, { timeoutMs: 12_000 });
  } catch (err) {
    return { status: 'error', error: err.message };
  }

  let found = await firstVerifiedBoard(html, http, { rejected, skip, deadlineAt, now });
  if (found.board) return finish('found', { board: strip(found.board), via: home }, rejected, now);
  if (found.timedOut) return finish('error', { error: DEADLINE_ERROR, deadline: true }, rejected, now);
  transient ??= found.transient;

  const next = careersLinks(html, home).slice(0, MAX_PAGES - 1);
  for (const fallback of [`https://${site}/careers`, `https://${site}/jobs`]) {
    if (next.length >= MAX_PAGES - 1) break;
    if (!next.some((u) => u.replace(/\/$/, '') === fallback)) next.push(fallback);
  }

  for (const url of next) {
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      return finish('error', { error: DEADLINE_ERROR, deadline: true }, rejected, now);
    }
    try {
      html = await http.fetchText(url, { timeoutMs: 12_000 });
    } catch {
      continue; // a missing /careers is an answer, not a failure
    }
    found = await firstVerifiedBoard(html, http, { rejected, skip, deadlineAt, now });
    if (found.board) return finish('found', { board: strip(found.board), via: url }, rejected, now);
    if (found.timedOut) return finish('error', { error: DEADLINE_ERROR, deadline: true }, rejected, now);
    transient ??= found.transient;
  }

  // A timeout/429/5xx is not proof the board is gone — retry in TTL.error,
  // not TTL.dead_link.
  if (transient) return finish('error', { error: transient }, rejected, now);
  const kept = compactRejected(rejected, { now });
  if (kept.length) return { status: 'dead_link', rejected: kept };
  return { status: 'none' };
}

const strip = ({ vendor, slug, careers_url }) => ({ vendor, slug, careers_url });

/** First extractBoards candidate that exists (API check) or has no public check. */
async function firstVerifiedBoard(html, http, { rejected, skip, deadlineAt, now = Date.now() }) {
  let checked = 0;
  let transient = null;
  for (const candidate of extractBoards(html)) {
    const key = urlKey(candidate.careers_url);
    if (!key || skip.has(key)) continue;
    if (deadlineAt != null && Date.now() >= deadlineAt) return { board: null, timedOut: true, transient };
    if (checked >= MAX_CHECKS_PER_PAGE) break;
    checked++;
    skip.add(key);
    const check = await boardExists(candidate, http);
    if (check.ok) return { board: candidate, timedOut: false, transient };
    if (check.transient) {
      transient ??= String(check.status ?? 'error');
      continue;
    }
    rememberDead(rejected, candidate.careers_url, check.status, now);
  }
  return { board: null, timedOut: false, transient };
}

/**
 * Greenhouse / Ashby / Lever expose a public board API; anything else is
 * accepted as linked. Shared by resolveWebsite and guessBoard.
 *
 * Only 404/410 (and an empty successful payload) mean the board is gone.
 * Timeouts, 429s and 5xx are transient — they must not become dead_link.
 */
export async function boardExists(board, http) {
  const vendor = BOARD_APIS.find((v) => v.vendor === board.vendor);
  if (!vendor) return { ok: true, status: 'unchecked' };
  try {
    const doc = await http.fetchJson(vendor.api(board.slug), { timeoutMs: BOARD_CHECK_TIMEOUT_MS });
    if (vendor.empty(doc)) return { ok: false, status: 'empty' };
    return { ok: true, status: 200 };
  } catch (err) {
    const status = err.status;
    if (status === 404 || status === 410) return { ok: false, status };
    return { ok: false, transient: true, status: status ?? err.message ?? 'error' };
  }
}

const compact = (s) => companyKey(s).replace(/ /g, '');

/**
 * Second chance for a company whose site did not link a board — usually
 * because its careers page renders the listing in the browser (stripe.com/jobs).
 *
 * Guesses the board slug from the domain and the name, and accepts a guess
 * only when the board names itself as this company. The check is the point:
 * greenhouse.io/streak exists whether or not it belongs to Streak.
 *
 * @param {{name: string|null, website: string|null}} company
 * @returns {Promise<{status: 'found', board: object, via: string} | {status: 'none'}>}
 */
export async function guessBoard(company, http) {
  // A guess from the domain is strong (juicebox.ai → ashby/juicebox named
  // "Juicebox"). A guess from the name alone is only as good as the name is
  // distinctive: "Scout" or "Raven" names a dozen companies, so a name-only
  // guess needs at least eight letters.
  const stem = siteKey(company.website ?? '').split('.')[0];
  const name = compact(company.name ?? '');
  const slugs = [...new Set([stem.length >= 3 ? stem : '', name.length >= 8 ? name : ''].filter((k) => /^[a-z0-9]+$/.test(k)))];
  if (!slugs.length) return { status: 'none' };

  for (const slug of slugs) {
    for (const vendor of BOARD_APIS) {
      let exists;
      try {
        exists = await http.fetchJson(vendor.api(slug), { timeoutMs: BOARD_CHECK_TIMEOUT_MS });
      } catch {
        continue; // 404 or a blip: try the next vendor
      }
      if (vendor.empty(exists)) continue;
      const board = { vendor: vendor.vendor, slug, careers_url: vendor.url(slug) };
      const named = vendor.nameFrom?.(exists) ?? await boardName(board, http);
      // The board must name itself as this company, by its name or its domain.
      if (named && (compact(named) === name || (slug === stem && compact(named) === stem))) {
        return { status: 'found', board, via: `guess:${vendor.vendor}`, name: named };
      }
    }
  }
  return { status: 'none' };
}

export const BOARD_APIS = [
  {
    vendor: 'greenhouse',
    api: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}`,
    url: (s) => `https://job-boards.greenhouse.io/${encodeURIComponent(s)}`,
    empty: (doc) => !doc?.name,
    nameFrom: (doc) => doc?.name ?? null,
  },
  {
    vendor: 'ashby',
    api: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    url: (s) => `https://jobs.ashbyhq.com/${encodeURIComponent(s)}`,
    empty: (doc) => !Array.isArray(doc?.jobs),
  },
  {
    vendor: 'lever',
    api: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?limit=1&mode=json`,
    url: (s) => `https://jobs.lever.co/${encodeURIComponent(s)}`,
    empty: (doc) => !Array.isArray(doc),
  },
];

/**
 * A readable company name for a board found without one (a fund's job page
 * links to jobs.lever.co/lyrahealth, not to "Lyra Health").
 *
 * Greenhouse says it in its API; the other vendors say it in the board page's
 * <title>. Falls back to the slug, which is ugly but never wrong.
 */
export async function boardName(board, http) {
  try {
    if (board.vendor === 'greenhouse') {
      const doc = await http.fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug)}`, { timeoutMs: 10_000 });
      if (doc?.name) return String(doc.name).trim();
    } else if (http.fetchTextHead) {
      const head = await http.fetchTextHead(board.careers_url, { timeoutMs: 10_000, maxBytes: 16_384 });
      const name = nameFromTitle(head.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]);
      if (name) return name;
    }
  } catch { /* fall through to the slug */ }
  return prettySlug(board.slug);
}

/** "Jobs at Lyra Health | Lever" → "Lyra Health". Exported for the tests. */
export function nameFromTitle(title) {
  if (!title) return null;
  let t = title.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  if (/\b(404|not found|page not found|error)\b/i.test(t)) return null;
  t = t.replace(/\s*[|·–—-]\s*(Lever|Ashby|Workable|Gem|Rippling|BambooHR|Breezy HR|Breezy|Jobvite|Recruitee|SmartRecruiters|Pinpoint|Teamtailor|Personio|JazzHR|Careers?|Jobs?|Current Openings|Open Positions|Job Board)\s*$/i, '');
  t = t.replace(/^(current\s+)?(job\s+)?(openings|jobs|careers|open positions|opportunities)\s+(at|with)\s+/i, '');
  t = t.replace(/\s+(jobs|careers|job board|careers page)$/i, '');
  t = t.trim();
  if (!t || t.length > 80 || /^(jobs|careers|home|job board)$/i.test(t)) return null;
  return t;
}

export function prettySlug(slug) {
  return String(slug ?? '').split('|')[0].replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
