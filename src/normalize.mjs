// The one shape every source produces. Sources differ wildly — a Greenhouse
// JSON API, a LinkedIn guest HTML card, an aggregator's REST payload — so each
// adapter's only job is to land here. Everything downstream (dedupe, prefilter,
// rank, digest, sheet) reads this and nothing else.

/**
 * @typedef {object} Job
 * @property {string}  id            stable dedupe key (see dedupe.mjs)
 * @property {string}  url           canonical apply/posting URL
 * @property {string}  title
 * @property {string}  company
 * @property {string}  companyKey    folded company name for cross-source matching
 * @property {string}  location
 * @property {string}  source        'watchlist' | 'ats_sweep' | 'linkedin' | 'freehire'
 * @property {string}  sourceDetail  provider/board that produced it (e.g. 'greenhouse')
 * @property {string?} postedAt      ISO date (YYYY-MM-DD) or null
 * @property {string}  firstSeen     ISO date huntley first saw it
 * @property {boolean} watchlist     true when the company is on your watchlist
 * @property {string?} fingerprint   JD-body fingerprint when the source gave one
 * @property {string?} description   truncated JD text when available
 * @property {number?} score         set by the ranker
 * @property {string?} why           set by the ranker: the "why this fits" line
 */

const WHITESPACE = /\s+/g;

/** Bound stored description text; prompt excerpting happens later at render time. */
export const MAX_STORED_DESCRIPTION_CHARS = 50_000;

/** Preserve line breaks (section headings) while tidying horizontal whitespace. */
export function normalizeDescriptionText(text, { maxChars = MAX_STORED_DESCRIPTION_CHARS } = {}) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/** Fold a company name so "Acme, Inc." and "ACME Inc" are one company. */
export function companyKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|nv|sa|ag|plc|holdings|group|labs|technologies|technology)\b/g, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Collapse a title for comparison without destroying meaningful tokens. */
export function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(Remote)", "(L5)"
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * Canonicalize a posting URL for dedupe: drop tracking params, trailing slash,
 * and fragments. Two boards linking the same Greenhouse req must collapse.
 */
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return String(raw ?? '').trim(); }

  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = 'https:';

  const DROP = /^(utm_|ref$|source$|src$|gh_src$|lever-|trackingid$|refid$|trk$|trkinfo$|position$|pagenum$|originalsubdomain$|eblid$)/i;
  for (const key of [...u.searchParams.keys()]) {
    if (DROP.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce whatever a source calls a date into YYYY-MM-DD, or null. */
export function isoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (ISO_DATE.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Today in the local timezone, as YYYY-MM-DD (not UTC — a digest is a local day). */
export function localToday(now = new Date()) {
  const tzOffsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function clean(value) {
  return String(value ?? '').replace(WHITESPACE, ' ').trim();
}

/**
 * Build a normalized Job from a source's raw row.
 * @param {object} raw
 * @returns {Job|null} null when the row lacks the minimum to be actionable
 */
export function toJob(raw) {
  const url = canonicalUrl(raw.url);
  const title = clean(raw.title);
  const company = clean(raw.company);

  // A row with no URL is not actionable — you cannot apply to it — and a row
  // with no title cannot be ranked or explained. Drop rather than carry.
  if (!url || !/^https?:/i.test(url) || !title) return null;

  return {
    id: null,                      // assigned by dedupe.mjs
    url,
    title,
    company: company || 'Unknown',
    companyKey: companyKey(company),
    location: clean(raw.location),
    source: raw.source ?? 'unknown',
    sourceDetail: clean(raw.sourceDetail) || raw.source || '',
    postedAt: isoDate(raw.postedAt),
    firstSeen: raw.firstSeen ?? localToday(),
    watchlist: Boolean(raw.watchlist),
    fingerprint: raw.fingerprint || null,
    description: raw.description ? normalizeDescriptionText(raw.description) : null,
    score: null,
    why: null,
  };
}
