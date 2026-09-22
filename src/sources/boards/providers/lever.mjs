// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — public postings API.
// Huntley overlay: concatenates descriptionPlain + structured lists (50k cap)
// so enrichment does not treat a nonempty intro stub as complete.

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

/** Fold `categories.location` together with any extra `categories.allLocations`
 *  into one string. Lever puts a SINGLE primary city in `location`, and exposes
 *  the full set on multi-location postings in `allLocations` — reading only the
 *  former silently hides every other eligible location from scan.mjs's
 *  location_filter (e.g. a req open in Barcelona AND Montevideo looks
 *  Barcelona-only). Mirrors resolveLocation() in providers/remotli.mjs.
 *  @param {any} categories */
function resolveLocation(categories) {
  const primary = typeof categories?.location === 'string' ? categories.location.trim() : '';
  const all = Array.isArray(categories?.allLocations)
    ? categories.allLocations.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim())
    : [];
  const merged = [];
  for (const l of [primary, ...all]) {
    if (l && !merged.some(m => m.toLowerCase() === l.toLowerCase())) merged.push(l);
  }
  return merged.join('; ');
}


/** Strip HTML while keeping heading/list newlines for section-aware consumers. */
function stripHtmlPreserveBreaks(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n')
    .replace(/<(?:[^>"']|"[^"]*"|\'[^\']*\')+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Lever list payloads ship descriptionPlain AND structured qualification lists.
 * Export both — introduction alone is incomplete for ranking.
 * @param {any} j
 * @returns {string}
 */
export function formatLeverDescription(j) {
  const parts = [];
  if (typeof j?.descriptionPlain === 'string' && j.descriptionPlain.trim()) {
    parts.push(j.descriptionPlain.trim());
  } else if (j?.description) {
    const intro = stripHtmlPreserveBreaks(j.description);
    if (intro) parts.push(intro);
  }
  if (Array.isArray(j?.lists) && j.lists.length) {
    const lists = j.lists.map(/** @param {any} l */ (l) => {
      const heading = typeof l?.text === 'string' ? l.text.trim() : '';
      const body = stripHtmlPreserveBreaks(l?.content ?? '');
      return [heading, body].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
    if (lists) parts.push(lists);
  }
  // Cap high enough that section-aware prompt excerpts can still see late
  // qualifications; huntley's sidecar/excerpter apply their own bounds.
  return parts.join('\n\n').slice(0, 50_000);
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertLeverUrl(apiUrl);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: resolveLocation(j.categories),
      // Lever's v0 postings list ships descriptionPlain AND structured lists
      // (qualifications, etc.). Concatenate both — introduction alone is
      // incomplete for content filters and huntley's description sidecar.
      description: formatLeverDescription(j),
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
