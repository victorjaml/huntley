// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, fetchResponse as defaultFetchResponse } from '../http/http.mjs';

// Consider provider — VC "talent network" portfolio boards on getconsider.com
// (Founderful, Creandum, Balderton, Lightspeed, Notion Capital, …). The board
// is a JS app, but its data comes from a same-origin JSON endpoint we can hit
// directly (discovered via a headless capture of the board's network calls):
//
//   POST {board_origin}/api-boards/search-jobs
//   body: {"meta":{"size":N},"board":{"id":"<board_id>","isParent":true},
//          "query":{"promoteFeatured":true}}
//   -> { jobs: [ {title,url,applyUrl,companyName,locations[],timeStamp,remote} ], total }
//
// `url` is the clean destination ATS link (dedups with the ashby/greenhouse
// providers); `companyName` is the portfolio company. The board id is NOT the
// host (Founderful's is "wingman"), so set it explicitly in portals.yml:
//
//   - name: Founderful (portfolio)
//     provider: consider
//     consider_board: wingman
//     careers_url: https://jobs.founderful.com/jobs
//     enabled: true
//
// `consider_size` (default 500) caps how many newest/featured jobs are pulled in
// the single request. Boards larger than that are truncated (rare for VC boards).

// Consider's `timeStamp` arrives as epoch ms on some boards and an ISO string
// on others, so both shapes are handled. Non-positive values are treated as
// missing rather than as 1970 — a 0/negative stamp is a board bug, and dating
// the posting to the epoch would make it permanently stale to the age filter.
function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Values below 1e12 are Unix seconds; at or above, already ms.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const ENDPOINT_PATH = '/api-boards/search-jobs';
const DEFAULT_SIZE = 500;
// Budget for the anonymous GET that seeds the session cookie and csrfToken.
// Shorter than the POST budget so a slow board page can't eat the full timeout.
const HANDSHAKE_TIMEOUT_MS = 15_000;
// The handshake is the whole board: Consider answers a POST without a valid
// session + token with 412 INVALID_CSRF, and unlike a paginated provider there
// is no partial result to keep. One retry, because a board sweep runs hundreds
// of these at once and a single slow page should not cost the entire board.
const HANDSHAKE_ATTEMPTS = 2;

// SSRF guard. The POST target host is config-driven (built from the portals.yml
// careers_url), so pin it to a public HTTPS origin before fetching. Consider
// boards are always real registrable domains (jobs.founderful.com, …); reject
// non-HTTPS, IP-literal, and loopback/internal hosts so a malicious or
// misconfigured careers_url can't aim the POST at an internal target
// (127.0.0.1, 169.254.169.254 cloud-metadata, ::1, localhost, *.internal).
// Mirrors the hostname-pinning lever.mjs / weworkremotely.mjs already do; here
// the allowlist is structural (public domain) since the board host varies.
function resolveOrigin(entry) {
  let parsed;
  try {
    parsed = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // strip FQDN trailing dot
  if (host.startsWith('[') || host.includes(':')) return null;        // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;              // IPv4 literal (incl. metadata/private)
  if (host === 'localhost' || host === 'localhost.localdomain') return null;
  if (host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (!host.includes('.')) return null;                              // single-label / non-public
  return parsed.origin;
}

// Perform the anonymous GET /jobs handshake that Consider requires before
// accepting a POST. Returns { cookie, csrfToken }.
//
// This runs through ctx.fetchResponse rather than a bare fetch so it inherits
// the run's shared deadline, its abort signal and the standard retry/timeout
// handling — exactly like every other request a provider makes. Routing it
// outside that machinery is what cost six fund boards on 2026-09-15: under a
// 572-board sweep the private 8s budget lapsed, the failure was swallowed into
// {null, null}, and the POST went out anyway to be refused with 412.
//
// A handshake that yields no token now throws. There is nothing to salvage:
// Consider is a single POST, so a degraded request returns no jobs at all, and
// a named failure is worth far more than "HTTP 412 Precondition Failed".
async function acquireCsrfHandshake(origin, ctx = {}) {
  const fetchRes = ctx.fetchResponse ?? defaultFetchResponse;
  let lastError = null;

  for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS; attempt++) {
    try {
      // redirect:'error' blocks every redirect unconditionally. A redirect-to-
      // private-IP (169.254.169.254, ::1, ...) would otherwise bypass the host
      // guard in resolveOrigin() and make a request to an internal target.
      const res = await fetchRes(`${origin}/jobs`, {
        headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html,*/*' },
        redirect: 'error',
        timeoutMs: HANDSHAKE_TIMEOUT_MS,
        signal: ctx.signal ?? undefined,
        deadlineAt: ctx.deadlineAt ?? undefined,
      });
      const html = await res.text();

      // getSetCookie() returns each Set-Cookie header as its own string,
      // avoiding the comma-folding ambiguity of get('set-cookie') for values
      // that contain commas. Both cookies matter: Consider signs the session
      // holding the CSRF secret, and sending `session` without `session.sig`
      // is refused exactly like sending neither.
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/).filter(Boolean);

      const cookie = setCookies
        .map(c => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ') || null;

      // Consider embeds the CSRF token as `"csrfToken":"<value>"` inside a JSON
      // payload in a <script> tag on the board landing page. The 8-char lower
      // bound rules out placeholder strings and short error tokens.
      const m = html.match(/"csrfToken"\s*:\s*"([^"]{8,})"/);
      const csrfToken = m ? m[1] : null;

      if (cookie && csrfToken) return { cookie, csrfToken };
      lastError = new Error(
        `handshake returned no ${!cookie ? 'session cookie' : 'csrfToken'}`);
    } catch (err) {
      lastError = err;
      // A refused redirect or a lapsed deadline will not come good on a retry.
      if (err?.name === 'AbortError') break;
    }
    if (attempt + 1 < HANDSHAKE_ATTEMPTS && typeof ctx.sleep === 'function') {
      await ctx.sleep(500);
    }
  }

  throw new Error(
    `consider: CSRF handshake with ${origin} failed (${lastError?.message ?? 'unknown'}) `
    + '— the board rejects a search without one');
}


// Consider gives `locations` as an array of display strings and `remote` as a
// separate boolean, so a remote role reads "United States" with nothing saying
// it is remote. Append the marker the location classifier looks for, unless a
// location already says so.
function locationString(job) {
  const parts = Array.isArray(job?.locations)
    ? job.locations.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : [];
  if (job?.remote && !parts.some((l) => /remote/i.test(l))) parts.push('Remote');
  return parts.join(', ');
}

/** @type {Provider} */
export default {
  id: 'consider',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return entry.consider_board && origin ? { url: origin + ENDPOINT_PATH } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`consider: ${entry.name} needs an https careers_url on a public host`);
    if (!entry.consider_board) throw new Error(`consider: ${entry.name} needs a 'consider_board' id in portals.yml`);
    const size = Number.isInteger(entry.consider_size) && entry.consider_size > 0 ? entry.consider_size : DEFAULT_SIZE;

    // Perform the CSRF handshake before the POST. ctx._acquireHandshake is a
    // test seam: set it to a stub in unit tests so no real network call is made.
    const { cookie, csrfToken } = await (
      typeof ctx._acquireHandshake === 'function'
        ? ctx._acquireHandshake(origin, ctx)
        : acquireCsrfHandshake(origin, ctx)
    );
    if (!cookie || !csrfToken) {
      throw new Error(`consider: ${entry.name} handshake produced no CSRF credentials`);
    }

    const csrfHeaders = { cookie, 'x-csrf-token': csrfToken };

    const json = await ctx.fetchJson(origin + ENDPOINT_PATH, {
      method: 'POST',
      // redirect:'error' so a 3xx from the (config-driven) board host can't be
      // followed to a private/metadata IP — the host guard above pins the first hop.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        referer: origin + '/jobs',
        ...csrfHeaders,
      },
      body: JSON.stringify({
        meta: { size },
        board: { id: String(entry.consider_board), isParent: true },
        query: { promoteFeatured: true },
      }),
    });

    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs
      .map(j => {
        const rawUrl = j.url || j.applyUrl || '';
        if (!rawUrl) return null;
        // Normalize to an absolute URL so the dedup key matches what the
        // ashby/greenhouse providers emit (Consider returns absolute ATS links,
        // but resolve defensively in case a relative path ever appears).
        let url;
        try {
          url = new URL(rawUrl, origin).toString();
        } catch {
          return null;
        }
        return {
          title: j.title || '',
          url,
          company: j.companyName || entry.name,
          location: locationString(j),
          postedAt: toEpochMs(j.timeStamp),
        };
      })
      .filter(Boolean);
  },
};
