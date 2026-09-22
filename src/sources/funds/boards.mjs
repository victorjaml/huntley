// Recognising a company's job board from a link to it.
//
// A fund's portfolio page, a fund's job feed and a company's own careers page
// all say the same thing in the end: a link to jobs.ashbyhq.com/acme, or to
// acme.bamboohr.com. That link names the vendor and the board, and the vendor's
// public API does the rest — career-ops already has a provider for each.
//
// Every board is emitted as the exact careers_url shape its career-ops
// provider's detect() accepts, so a board found here scans with no further
// configuration. tests/funds.test.mjs holds each shape to that contract.
//
// Pure: no network, so it can be tested against saved pages.

// Percent-encoded octets are part of the slug (jobs.ashbyhq.com/Honey%20Homes),
// then decoded before we store it. `{0,80}` counts each octet as one unit.
const SLUG = '([A-Za-z0-9](?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){0,80})';
const SUB = '([a-z0-9][a-z0-9-]{0,62})';

// Path segments and subdomains that sit where a slug would but are not one.
const NOT_A_SLUG = new Set([
  'embed', 'jobs', 'job', 'v1', 'v0', 'api', 'www', 'app', 'apply', 'careers', 'career',
  'j', 'static', 'assets', 'cdn', 'images', 'img', 'help', 'support', 'blog', 'login',
  'signup', 'search', 'about', 'privacy', 'terms', 'en', 'posting-api', 'widget',
  'integrations', 'marketplace', 'partners', 'status', 'docs', 'my', 'secure', 'go',
]);

// Per-vendor hosts that look like a company slug. "na" is Teamtailor's North
// America load balancer, but would be a plausible slug on another ATS.
const VENDOR_NOT_A_SLUG = {
  teamtailor: new Set(['na', 'eu', 'app', 'www']),
};

function decodeSlug(raw) {
  let s = String(raw ?? '');
  try { s = decodeURIComponent(s); } catch { /* keep the raw path segment */ }
  // Encoded share/redirect wrappers decode to `acme?utm_source=…`. Cut there
  // so the slug is the board, not the tracking query.
  const cut = s.search(/[?#&=]/);
  if (cut !== -1) s = s.slice(0, cut);
  return s;
}

function encodePathSlug(slug) {
  return encodeURIComponent(slug);
}

function workdaySlug(match) {
  const tenant = String(match[1] ?? '').toLowerCase();
  const instance = String(match[2] ?? '').toLowerCase();
  const path = String(match[3] ?? '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  let site = parts[0];
  // en-US, or a bare two-letter locale like /es/, then the site is next.
  if (site && (/^[a-z]{2}-[A-Z]{2}$/.test(site) || /^[a-z]{2}$/.test(site))) {
    site = parts[1];
  }
  if (!site || !/^[A-Za-z0-9_-]{1,80}$/.test(site)) return null;
  return `${tenant}|${instance}|${site}`;
}

function isNotASlug(vendor, slug) {
  const key = String(slug ?? '').toLowerCase();
  return NOT_A_SLUG.has(key) || Boolean(VENDOR_NOT_A_SLUG[vendor]?.has(key));
}

const VENDORS = [
  {
    vendor: 'greenhouse',
    re: new RegExp(`(?:job-boards|boards)(?:\\.eu)?\\.greenhouse\\.io/(?:embed/job_board(?:/js)?\\?for=)?${SLUG}`, 'gi'),
    url: (s) => `https://job-boards.greenhouse.io/${encodePathSlug(s)}`,
  },
  {
    vendor: 'greenhouse',
    re: new RegExp(`boards-api\\.greenhouse\\.io/v1/boards/${SLUG}`, 'gi'),
    url: (s) => `https://job-boards.greenhouse.io/${encodePathSlug(s)}`,
  },
  { vendor: 'ashby', re: new RegExp(`jobs\\.ashbyhq\\.com/${SLUG}`, 'gi'), url: (s) => `https://jobs.ashbyhq.com/${encodePathSlug(s)}` },
  { vendor: 'lever', re: new RegExp(`jobs\\.lever\\.co/${SLUG}`, 'gi'), url: (s) => `https://jobs.lever.co/${encodePathSlug(s)}` },
  { vendor: 'workable', re: new RegExp(`apply\\.workable\\.com/${SLUG}`, 'gi'), url: (s) => `https://apply.workable.com/${encodePathSlug(s)}` },
  { vendor: 'gem', re: new RegExp(`jobs\\.gem\\.com/${SLUG}`, 'gi'), url: (s) => `https://jobs.gem.com/${encodePathSlug(s)}` },
  {
    vendor: 'rippling',
    // Rippling boards may carry a locale segment first: ats.rippling.com/en-GB/acme/jobs
    re: new RegExp(`ats\\.rippling\\.com/(?:[a-z]{2}-[A-Z]{2}/)?${SLUG}`, 'gi'),
    url: (s) => `https://ats.rippling.com/${encodePathSlug(s)}/jobs`,
  },
  { vendor: 'jobvite', re: new RegExp(`jobs\\.jobvite\\.com/${SLUG}`, 'gi'), url: (s) => `https://jobs.jobvite.com/${encodePathSlug(s)}` },
  {
    vendor: 'smartrecruiters',
    re: new RegExp(`(?:jobs|careers)\\.smartrecruiters\\.com/${SLUG}`, 'gi'),
    url: (s) => `https://jobs.smartrecruiters.com/${encodePathSlug(s)}`,
  },
  { vendor: 'bamboohr', re: new RegExp(`${SUB}\\.bamboohr\\.com`, 'gi'), url: (s) => `https://${s}.bamboohr.com/careers` },
  { vendor: 'breezy', re: new RegExp(`${SUB}\\.breezy\\.hr`, 'gi'), url: (s) => `https://${s}.breezy.hr` },
  { vendor: 'recruitee', re: new RegExp(`${SUB}\\.recruitee\\.com`, 'gi'), url: (s) => `https://${s}.recruitee.com` },
  { vendor: 'pinpoint', re: new RegExp(`${SUB}\\.pinpointhq\\.com`, 'gi'), url: (s) => `https://${s}.pinpointhq.com` },
  { vendor: 'teamtailor', re: new RegExp(`${SUB}\\.teamtailor\\.com`, 'gi'), url: (s) => `https://${s}.teamtailor.com/jobs` },
  { vendor: 'personio', re: new RegExp(`${SUB}\\.jobs\\.personio\\.(?:com|de)`, 'gi'), url: (s) => `https://${s}.jobs.personio.com` },
  { vendor: 'jazzhr', re: new RegExp(`${SUB}\\.applytojob\\.com`, 'gi'), url: (s) => `https://${s}.applytojob.com/apply` },
  {
    vendor: 'workday',
    re: /([a-z0-9-]{1,63})\.(wd\d{1,2})\.myworkdayjobs\.com\/([^\s"'<>]+)/gi,
    slug: workdaySlug,
    url: (s) => { const [t, i, site] = s.split('|'); return `https://${t}.${i}.myworkdayjobs.com/${site}`; },
  },
];

/**
 * The board for a vendor and slug, in the careers_url shape its career-ops
 * provider detects, or null for a vendor this module does not know. For sources
 * that name a board rather than link to one (freehire's `external_id`).
 */
export function boardFor(vendor, slug) {
  const v = VENDORS.find((x) => x.vendor === vendor && !x.slug);
  if (!v || !slug || isNotASlug(vendor, slug)) return null;
  const shape = SUBDOMAIN_VENDORS.has(vendor)
    ? /^[a-z0-9][a-z0-9-]{0,62}$/i
    : /^[A-Za-z0-9][A-Za-z0-9._ %-]{0,80}$/;
  return shape.test(slug) ? { vendor, slug, careers_url: v.url(slug) } : null;
}

const SUBDOMAIN_VENDORS = new Set(['bamboohr', 'breezy', 'recruitee', 'pinpoint', 'teamtailor', 'personio', 'jazzhr']);

/** Undo the escaping a link picks up inside embedded JSON or HTML attributes. */
function unescapeLinks(text) {
  return String(text ?? '')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&#x2[fF];|&#47;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/%2[fF]/g, '/');
}

/**
 * Every job board linked from a page, most-linked first.
 *
 * A careers page links its own board once per role, so the count separates the
 * company's board from a stray link to a partner's.
 *
 * @param {string} html
 * @returns {{vendor: string, slug: string, careers_url: string, count: number}[]}
 */
export function extractBoards(html) {
  const text = unescapeLinks(html);
  const found = new Map();
  for (const v of VENDORS) {
    for (const m of text.matchAll(v.re)) {
      const raw = v.slug ? v.slug(m) : m[1];
      if (!raw) continue;
      const slug = v.vendor === 'workday' ? raw : decodeSlug(raw).replace(/[._-]+$/, '');
      if (!slug || isNotASlug(v.vendor, slug)) continue;
      const careers_url = v.url(slug);
      const key = careers_url.toLowerCase();
      const prev = found.get(key);
      if (prev) prev.count++;
      else found.set(key, { vendor: v.vendor, slug, careers_url, count: 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

/** The board a company's own page points at, or null. */
export function primaryBoard(html) {
  return extractBoards(html)[0] ?? null;
}

/** Lowercased host without `www.`, or '' for anything that is not an http(s) URL. */
export function siteKey(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Is this host the same site as the company's (itself, or a subdomain of it)? */
function sameSite(host, site) {
  const h = host.replace(/^www\./, '');
  return h === site || h.endsWith(`.${site}`);
}

const CAREERS_WORDS = /\b(careers?|jobs?|join(?:[\s-]+(?:us|the[\s-]+team))?|hiring|work[\s-]+(?:with|at)[\s-]+us|open[\s-]+(?:roles|positions))\b/i;

/**
 * Links on a company's homepage that probably lead to its careers page:
 * same-site links whose path or text says careers, jobs, join us, hiring.
 * Returned in page order, without duplicates.
 *
 * @param {string} html
 * @param {string} pageUrl  the URL the html was fetched from, for relative links
 * @returns {string[]}
 */
export function careersLinks(html, pageUrl) {
  const site = siteKey(pageUrl);
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[1].replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url.hostname.toLowerCase(), site)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (!CAREERS_WORDS.test(url.pathname.replace(/[/_]/g, ' ')) && !CAREERS_WORDS.test(url.hostname.split('.')[0]) && !CAREERS_WORDS.test(text)) continue;
    const key = `${url.hostname}${url.pathname}`.replace(/\/$/, '').toLowerCase();
    if (seen.has(key) || key === site) continue;
    seen.add(key);
    out.push(url.href);
  }
  return out;
}
