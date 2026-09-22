// Fund adapters: turning a VC fund's public pages into a list of companies.
//
// Funds publish their portfolios in a handful of shapes, so an adapter is
// chosen per shape, not per fund. Adding a fund is a config entry naming the
// shape and its URL; adding a shape is one entry in ADAPTERS below.
//
//   yc             Y Combinator's company directory (the yc-oss mirror of YC's
//                  public API: one file instead of 250 pages).
//   ats_links      a page that links straight to job boards or postings on
//                  them — South Park Commons' and Greylock's job pages.
//   company_links  a portfolio page linking to each company's website —
//                  Work-Bench, Mythos.
//   wordpress      a WordPress portfolio post type served from wp-json — Pear.
//
// Funds with a Getro or Consider talent board do not need an adapter: that
// board already aggregates the portfolio's jobs, and lives under
// portfolio_boards in watchlist.yml.
//
// An adapter returns companies, each with a website to resolve, a board that is
// already known, or both. It never fetches jobs. The parsers are pure and
// exported for the tests; `list` does the fetching.

import { extractBoards, siteKey } from './boards.mjs';

const YC_ALL = 'https://yc-oss.github.io/api/companies/all.json';

/** Decode the entities a company name actually contains. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── yc ─────────────────────────────────────────────────────────────

/**
 * @param {unknown} payload  yc-oss all.json
 * @param {{hiringOnly?: boolean}} opts
 */
export function parseYc(payload, { hiringOnly = true } = {}) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .filter((c) => c.status !== 'Inactive' && c.status !== 'Acquired')
    .filter((c) => !hiringOnly || c.isHiring === true)
    .map((c) => ({
      name: c.name.trim(),
      website: typeof c.website === 'string' && /^https?:\/\//i.test(c.website) ? c.website.trim() : null,
      ycSlug: typeof c.slug === 'string' && /^[a-z0-9-]+$/i.test(c.slug) ? c.slug : null,
      detail: c.batch ? `YC ${c.batch}` : null,
    }));
}

// ── ats_links ──────────────────────────────────────────────────────

/** One company per board linked from the page; its name comes later, from the board. */
export function parseAtsLinks(html) {
  return extractBoards(html).map((b) => ({ name: null, website: null, board: { vendor: b.vendor, slug: b.slug, careers_url: b.careers_url } }));
}

// ── company_links ──────────────────────────────────────────────────

// Hosts a portfolio page links to that are never a portfolio company.
const NOT_A_COMPANY = [
  'google.com', 'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'google-analytics.com',
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'medium.com', 'substack.com', 'github.com', 'apple.com', 'spotify.com', 'tiktok.com',
  'website-files.com', 'webflow.com', 'webflow.io', 'squarespace.com', 'squarespace-cdn.com',
  'sqspcdn.com', 'wixstatic.com', 'wix.com', 'framer.com', 'framerusercontent.com',
  'notion.so', 'notion.site', 'typeform.com', 'calendly.com', 'hubspot.com', 'mailchimp.com',
  'cloudflare.com', 'jsdelivr.net', 'unpkg.com', 'vimeo.com', 'wordpress.com', 'wp.com',
  'crunchbase.com', 'techcrunch.com', 'bloomberg.com', 'forbes.com', 'wsj.com', 'nytimes.com',
  'indiegogo.com', 'kickstarter.com', 'openphilanthropy.org', 'clarity.ms', 'bit.ly',
];

const isInfra = (host) => NOT_A_COMPANY.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * The company name inside a portfolio card: its first piece of text, else its
 * logo's alt text. A card often holds name, blurb and sector as sibling
 * elements, and only the first of those is the name.
 */
function cardName(inner) {
  const chunks = String(inner).split(/<[^>]+>/).map(decodeEntities).filter(Boolean);
  const alt = String(inner).match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i)?.[1];
  const name = chunks[0] ?? (alt ? decodeEntities(alt).replace(/\s+logo$/i, '') : '');
  return name && name.length <= 60 ? name : null;
}

/**
 * External links on a portfolio page, one per company website.
 *
 * @param {string} html
 * @param {string} pageUrl  the portfolio page, whose own site is excluded
 */
export function parseCompanyLinks(html, pageUrl) {
  const fundSite = siteKey(pageUrl);
  const bySite = new Map();
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*?href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{0,4000}?)<\/a>/gi)) {
    const site = siteKey(m[1]);
    if (!site || site === fundSite || site.endsWith(`.${fundSite}`) || isInfra(site)) continue;
    if (extractBoards(m[1]).length) continue; // a job board link is not a website
    const text = cardName(m[2]);
    const prev = bySite.get(site);
    if (!prev) bySite.set(site, { name: text, website: `https://${site}` });
    else if (!prev.name && text) prev.name = text;
  }
  return [...bySite.values()];
}

// ── wordpress ──────────────────────────────────────────────────────

/** @param {unknown} items  one page of a wp-json/wp/v2/<type> response */
export function parseWordpress(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((p) => ({
      name: decodeEntities(p?.title?.rendered ?? ''),
      website: typeof p?.link === 'string' && siteKey(p.link) && !/[?&]p=\d+/.test(p.link) ? p.link : null,
    }))
    .filter((c) => c.name);
}

// ── Registry ───────────────────────────────────────────────────────

/**
 * @typedef {{name: string|null, website: string|null, board?: {vendor: string, slug: string, careers_url: string}, ycSlug?: string|null, detail?: string|null}} FundCompany
 * @typedef {{fetchText: (url: string, opts?: object) => Promise<string>, fetchJson: (url: string, opts?: object) => Promise<any>}} Http
 */

/** @type {Record<string, {needs: string[], list: (fund: object, http: Http) => Promise<FundCompany[]>}>} */
export const ADAPTERS = {
  yc: {
    needs: [],
    async list(fund, http) {
      return parseYc(await http.fetchJson(fund.url || YC_ALL, { timeoutMs: 60_000 }), { hiringOnly: fund.hiring_only !== false });
    },
  },
  ats_links: {
    needs: ['url'],
    async list(fund, http) {
      return parseAtsLinks(await http.fetchText(fund.url, { timeoutMs: 30_000 }));
    },
  },
  company_links: {
    needs: ['url'],
    async list(fund, http) {
      return parseCompanyLinks(await http.fetchText(fund.url, { timeoutMs: 30_000 }), fund.url);
    },
  },
  wordpress: {
    needs: ['url'],
    async list(fund, http) {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const sep = fund.url.includes('?') ? '&' : '?';
        let items;
        try {
          items = await http.fetchJson(`${fund.url}${sep}per_page=100&page=${page}`, { timeoutMs: 30_000 });
        } catch (err) {
          // WordPress answers a page past the end with HTTP 400.
          if (page > 1 && err.status === 400) break;
          throw err;
        }
        const parsed = parseWordpress(items);
        out.push(...parsed);
        if (!Array.isArray(items) || items.length < 100) break;
      }
      return out;
    },
  },
};

/** A config problem with one fund entry, or null. */
export function fundProblem(fund) {
  if (!fund || typeof fund !== 'object') return 'is not a mapping';
  if (!fund.name) return 'has no name';
  const adapter = ADAPTERS[fund.kind];
  if (!adapter) return `has unknown kind "${fund.kind}" (known: ${Object.keys(ADAPTERS).join(', ')})`;
  for (const key of adapter.needs) if (!fund[key]) return `(kind ${fund.kind}) needs ${key}`;
  return null;
}
