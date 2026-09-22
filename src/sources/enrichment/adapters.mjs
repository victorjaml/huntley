// Detail adapters for public ATS job endpoints (Greenhouse, Lever, Ashby).
//
// Only these hosts are contacted. Redirects to other hosts are rejected.
// Responses are size-bounded while streaming and converted to plain text.

import { atsIdentity } from '../../dedupe.mjs';

export const ADAPTER_VERSION = 'detail-adapters-v2';
export const MAX_RESPONSE_BYTES = 500_000;
/** Ashby has no single-posting endpoint — whole boards commonly exceed 500 KB. */
export const MAX_ASHBY_BOARD_BYTES = 5_000_000;
export const MAX_REDIRECTS = 5;
/** Stored description bound before prompt excerpting. */
export const MAX_STORED_DESCRIPTION_CHARS = 50_000;

const ALLOWED_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.ashbyhq.com',
]);

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|\[::1\])/i;

/** Decode common HTML entities before tag stripping (Greenhouse escapes content). */
export function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&amp;/gi, '&');
}

export function htmlToPlain(html) {
  // Greenhouse's job API returns content HTML-escaped (`&lt;p&gt;…`). Decode
  // first so tag stripping and heading newlines actually apply; then tidy
  // without collapsing those breaks — section-aware excerpts need them.
  const decoded = decodeHtmlEntities(html);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h([1-6])>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Resolve vendor/org/req for enrichment. Prefer `board.slug` when the posting
 * URL is a company-domain Greenhouse embed (`?gh_jid=`) — atsIdentity alone
 * cannot invent the board token from the site hostname.
 *
 * @param {string|object} urlOrJob
 * @param {{board?: {vendor?: string, slug?: string}|null}} [opts]
 * @returns {{vendor: string, org: string, req: string}|null}
 */
export function parseAtsTarget(urlOrJob, opts = {}) {
  const job = urlOrJob && typeof urlOrJob === 'object' ? urlOrJob : null;
  const url = job ? job.url : urlOrJob;
  const board = opts.board ?? job?.board ?? null;

  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  const ghJid = u.searchParams.get('gh_jid');

  if (board?.vendor && String(board.vendor).toLowerCase() === 'greenhouse' && board?.slug && /^\d+$/.test(String(ghJid ?? ''))) {
    return { vendor: 'greenhouse', org: String(board.slug).toLowerCase(), req: String(ghJid) };
  }
  if (board?.vendor && String(board.vendor).toLowerCase() === 'greenhouse' && board?.slug) {
    const pathJob = u.pathname.match(/\/jobs\/(\d+)/);
    if (pathJob) {
      return { vendor: 'greenhouse', org: String(board.slug).toLowerCase(), req: pathJob[1] };
    }
  }

  const id = atsIdentity(url);
  if (!id) {
    // Company-domain Greenhouse embeds without a board hint stay unsupported.
    if (ghJid && /^\d+$/.test(ghJid) && board?.slug) {
      return { vendor: 'greenhouse', org: String(board.slug).toLowerCase(), req: ghJid };
    }
    return null;
  }
  const [vendor, org, req] = id.split(':');
  if (!vendor || !org || !req) return null;
  if (!['greenhouse', 'lever', 'ashby'].includes(vendor)) return null;

  const boardVendor = String(board?.vendor ?? '').toLowerCase();
  const boardSlug = board?.slug ? String(board.slug).toLowerCase() : null;

  // Prefer the known board slug when identity fell back to a hostname-like org
  // (legacy / edge greenhouse.io?gh_jid= paths), or whenever dataset/freehire
  // already named the token for a company-domain posting.
  if (vendor === 'greenhouse' && boardSlug && boardVendor === 'greenhouse') {
    return { vendor, org: boardSlug, req };
  }
  if (vendor === 'greenhouse' && boardSlug && (org.includes('.') || org === u.hostname.toLowerCase())) {
    return { vendor, org: boardSlug, req };
  }
  return { vendor, org, req };
}

export function detailUrlFor(target) {
  if (!target) return null;
  if (target.vendor === 'greenhouse') {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.org)}/jobs/${encodeURIComponent(target.req)}`;
  }
  if (target.vendor === 'lever') {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(target.org)}/${encodeURIComponent(target.req)}`;
  }
  if (target.vendor === 'ashby') {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.org)}?includeCompensation=true`;
  }
  return null;
}

function assertAllowedUrl(urlString) {
  let u;
  try { u = new URL(urlString); } catch { throw new Error('invalid detail URL'); }
  if (u.protocol !== 'https:') throw new Error('detail URL must be https');
  if (PRIVATE_HOST.test(u.hostname) || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`host not allowed for enrichment: ${u.hostname}`);
  }
  return u;
}

/** Read a response body with a hard byte ceiling while streaming. */
export async function readBoundedBody(res, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('response too large');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('response too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch JSON from an allowed host with a single overall deadline, redirect
 * cap, and streaming size limit.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, deadlineAt?: number, redirectsLeft?: number, maxBytes?: number, fetchImpl?: typeof fetch}} opts
 */
export async function fetchAllowedJson(url, {
  timeoutMs = 10_000,
  deadlineAt = null,
  redirectsLeft = MAX_REDIRECTS,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const absoluteDeadline = deadlineAt ?? (Date.now() + Math.max(1, timeoutMs));
  assertAllowedUrl(url);

  const remaining = absoluteDeadline - Date.now();
  if (remaining <= 0) throw new Error('request deadline exceeded');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (res.status >= 300 && res.status < 400) {
      if (redirectsLeft <= 0) throw new Error('too many redirects');
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location (${res.status})`);
      const next = new URL(loc, url).toString();
      assertAllowedUrl(next);
      // Carry the same absolute deadline; do not reset per hop.
      return fetchAllowedJson(next, {
        timeoutMs,
        deadlineAt: absoluteDeadline,
        redirectsLeft: redirectsLeft - 1,
        maxBytes,
        fetchImpl,
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await readBoundedBody(res, { maxBytes });
    return JSON.parse(buf.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a normalized description from a provider payload.
 */
export function extractDescription(vendor, payload, reqId) {
  if (vendor === 'greenhouse') {
    const html = payload?.content ?? payload?.job?.content;
    const text = htmlToPlain(html);
    return text || null;
  }
  if (vendor === 'lever') {
    // Concatenate introduction and qualification lists — preferring only
    // descriptionPlain previously dropped Lever's structured lists.
    const parts = [];
    if (typeof payload?.descriptionPlain === 'string' && payload.descriptionPlain.trim()) {
      parts.push(payload.descriptionPlain.trim());
    } else if (payload?.description) {
      const intro = htmlToPlain(payload.description);
      if (intro) parts.push(intro);
    }
    if (Array.isArray(payload?.lists) && payload.lists.length) {
      const lists = htmlToPlain(payload.lists.map((l) => `${l.text ?? ''}\n${l.content ?? ''}`).join('\n'));
      if (lists) parts.push(lists);
    }
    const text = parts.join('\n\n').trim();
    return text || null;
  }
  if (vendor === 'ashby') {
    const jobs = payload?.jobs ?? (Array.isArray(payload) ? payload : null);
    const job = Array.isArray(jobs)
      ? jobs.find((j) => String(j.id) === String(reqId) || String(j.jobId) === String(reqId))
      : payload;
    const text = job?.descriptionPlain || htmlToPlain(job?.descriptionHtml || job?.description);
    return text || null;
  }
  return null;
}

/**
 * Fetch and normalize one job's description.
 * Ashby boards are fetched once per org via `boardCache` (Map of payloads or
 * in-flight Promises) for the run.
 *
 * @returns {Promise<{ok: true, description: string, vendor: string, adapterVersion: string}|{ok: false, error: string}>}
 */
export async function fetchJobDescription(jobUrlOrJob, opts = {}) {
  const job = jobUrlOrJob && typeof jobUrlOrJob === 'object' ? jobUrlOrJob : null;
  const url = job ? job.url : jobUrlOrJob;
  const target = parseAtsTarget(job ?? url, { board: opts.board ?? job?.board });
  if (!target) return { ok: false, error: 'unsupported host' };
  const detailUrl = detailUrlFor(target);
  try {
    let payload;
    if (target.vendor === 'ashby') {
      const boardCache = opts.boardCache ?? null;
      const cacheKey = target.org;
      if (boardCache?.has(cacheKey)) {
        payload = await boardCache.get(cacheKey);
      } else {
        const pending = fetchAllowedJson(detailUrl, {
          ...opts,
          maxBytes: opts.maxBytes ?? MAX_ASHBY_BOARD_BYTES,
        }).then(
          (payload) => {
            boardCache?.set(cacheKey, payload);
            return payload;
          },
          (err) => {
            // Remember the failure for this run so later roles at the same
            // company do not re-download an oversized / failing board.
            const rejected = Promise.reject(err);
            rejected.catch(() => {}); // avoid unhandled rejection if unused
            boardCache?.set(cacheKey, rejected);
            throw err;
          },
        );
        boardCache?.set(cacheKey, pending);
        payload = await pending;
      }
    } else {
      payload = await fetchAllowedJson(detailUrl, opts);
    }
    const description = extractDescription(target.vendor, payload, target.req);
    if (!description) return { ok: false, error: 'empty description' };
    return {
      ok: true,
      description: description.slice(0, MAX_STORED_DESCRIPTION_CHARS),
      vendor: target.vendor,
      adapterVersion: ADAPTER_VERSION,
      providerJobId: `${target.vendor}:${target.org}:${target.req}`,
    };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}
