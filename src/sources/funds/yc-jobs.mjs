// Y Combinator's own job listings, for YC companies with no board of their own.
//
// Many YC companies recruit only through Work at a Startup, YC's job board,
// so their roles never reach Greenhouse, Ashby or Lever. Each company's public
// page on ycombinator.com (/companies/<slug>/jobs) server-renders its open
// roles as JSON in the page's `data-page` attribute; no login is needed to read
// them, only to apply.
//
// Only fetched for YC companies whose website did not lead to a board: a
// company with a Greenhouse board is scanned there, where the listing is
// canonical and dated.
//
// Dates are fuzzy ("about 1 month", "over 2 years"), so postedAt is an
// estimate and a role older than max_age_days is dropped — the page keeps
// postings open for years.

import { toJob } from '../../normalize.mjs';
import { decodeEntities } from './adapters.mjs';

const YC = 'https://www.ycombinator.com';

// YC writes countries as ISO codes: "CA / Remote (CA)" is remote in Canada,
// not California. The location parser reads names, so the codes are spelled
// out before a role leaves this file.
const COUNTRIES = {
  US: 'United States', CA: 'Canada', MX: 'Mexico', GB: 'United Kingdom', UK: 'United Kingdom',
  IE: 'Ireland', DE: 'Germany', FR: 'France', NL: 'Netherlands', ES: 'Spain', PT: 'Portugal',
  IT: 'Italy', CH: 'Switzerland', SE: 'Sweden', PL: 'Poland', IN: 'India', SG: 'Singapore',
  JP: 'Japan', KR: 'South Korea', AU: 'Australia', NZ: 'New Zealand', BR: 'Brazil', AR: 'Argentina',
  CO: 'Colombia', CL: 'Chile', IL: 'Israel', AE: 'United Arab Emirates', NG: 'Nigeria', KE: 'Kenya',
  ZA: 'South Africa', PH: 'Philippines', ID: 'Indonesia', VN: 'Vietnam', PK: 'Pakistan', EG: 'Egypt',
  TR: 'Turkey', UA: 'Ukraine', RO: 'Romania', CZ: 'Czech Republic', HK: 'Hong Kong', TW: 'Taiwan',
  CN: 'China', DK: 'Denmark', NO: 'Norway', FI: 'Finland', BE: 'Belgium', AT: 'Austria', EE: 'Estonia',
};

/**
 * "CA / Remote (US; CA)" → "Canada / Remote (United States; Canada)".
 * "Toronto, ON, CA" → "Toronto, ON, Canada". Codes are only expanded where YC
 * puts a country — a whole segment, the third part of a place, or inside
 * Remote (…) — so "San Francisco, CA, US" and "San Francisco, CA" keep their CA.
 */
export function ycLocation(location) {
  const name = (code) => COUNTRIES[code] ?? code;
  return String(location ?? '').split(/\s+\/\s+/).map((seg) => {
    const t = seg.trim();
    if (/^[A-Z]{2}$/.test(t)) return name(t);
    const remote = t.match(/^Remote\s*\(([^)]*)\)$/i);
    if (remote) return `Remote (${remote[1].split(/\s*;\s*/).map((c) => (/^[A-Z]{2}$/.test(c) ? name(c) : c)).join('; ')})`;
    const parts = t.split(/\s*,\s*/);
    // "City, ST, CC" — only with three parts; "San Francisco, CA" is a state.
    if (parts.length >= 3 && /^[A-Z]{2}$/.test(parts.at(-1))) parts[parts.length - 1] = name(parts.at(-1));
    return parts.join(', ');
  }).join(' / ');
}

/** "about 1 month" → 30, "over 2 years" → 730, "3 days" → 3. null when unreadable. */
export function approxAgeDays(createdAt) {
  const s = String(createdAt ?? '').toLowerCase();
  if (!s) return null;
  if (/less than a minute|minutes?|hours?|just now|today/.test(s) && !/days?|months?|years?/.test(s)) return 0;
  const m = s.match(/(\d+|a|an)\s+(day|week|month|year)s?/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  return n * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
}

/**
 * The roles on one ycombinator.com/companies/<slug>/jobs page.
 * @param {string} html
 * @returns {{title: string, url: string, location: string, company: string, ageDays: number|null, type: string}[]}
 */
export function parseYcJobsPage(html) {
  const attr = String(html ?? '').match(/data-page="([^"]+)"/)?.[1];
  if (!attr) return [];
  let page;
  try {
    page = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } catch {
    return [];
  }
  const postings = page?.props?.jobPostings;
  if (!Array.isArray(postings)) return [];
  return postings
    .filter((p) => p && typeof p.title === 'string' && typeof p.url === 'string' && p.url.startsWith('/companies/'))
    .map((p) => ({
      title: decodeEntities(p.title),
      url: `${YC}${p.url}`,
      location: ycLocation(decodeEntities(p.location ?? '')),
      company: decodeEntities(p.companyName ?? page.props.company?.name ?? ''),
      ageDays: approxAgeDays(p.createdAt),
      type: p.type ?? '',
    }));
}

/**
 * @param {{name: string, ycSlug: string, funds?: string[]}[]} companies
 * @param {{http: object, concurrency?: number, maxAgeDays?: number, deadline?: number, now?: number}} opts
 * @returns {Promise<{jobs: object[], fetched: number, failed: number, skipped: number}>}
 */
export async function fetchYcJobs(companies, { http, concurrency = 4, maxAgeDays = 30, deadline = Infinity, now = Date.now() } = {}) {
  const jobs = [];
  const failedSlugs = [];
  const skippedSlugs = [];
  let fetched = 0, failed = 0, skipped = 0, i = 0;

  async function worker() {
    while (i < companies.length) {
      const c = companies[i++];
      if (Date.now() > deadline) { skipped++; skippedSlugs.push(c.ycSlug); continue; }
      let html;
      try {
        html = await http.fetchText(`${YC}/companies/${c.ycSlug}/jobs`, { timeoutMs: 15_000 });
        fetched++;
      } catch {
        failed++;
        failedSlugs.push(c.ycSlug);
        continue;
      }
      for (const p of parseYcJobsPage(html)) {
        if (p.ageDays == null || p.ageDays > maxAgeDays) continue;
        const job = toJob({
          url: p.url,
          title: p.title,
          company: p.company || c.name,
          location: p.location,
          postedAt: new Date(now - p.ageDays * 86_400_000).toISOString().slice(0, 10),
          source: 'portfolio',
          sourceDetail: `${(c.funds ?? ['Y Combinator']).join(', ')} · Work at a Startup`,
        });
        if (job) jobs.push(job);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));
  return { jobs, fetched, failed, skipped, failedSlugs, skippedSlugs };
}
