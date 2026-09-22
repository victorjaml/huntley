// JazzHR provider — HTML scrape of *.applytojob.com/apply career pages.
// Canonical implementation for Huntley board collection.
//
// Unlike Greenhouse, Ashby or Lever, JazzHR publishes no JSON API and no RSS
// feed — `/apply/jobs/rss` 404s on every board. What it does publish is a
// server-rendered career page at `https://<org>.applytojob.com/apply` whose
// listing markup has been stable for years: one `<li class="list-group-item">`
// per role, an `<h3 class="list-group-item-heading">` holding the link and
// title, and a `<ul class="list-inline">` of location and department.
//
// That is a scrape, so it is written to fail quietly and never to guess: a
// block missing a link or a title is skipped rather than emitted half-formed,
// and a markup change produces zero results and a logged warning rather than
// rows full of nonsense.
//
// No posting dates. JazzHR's listing page does not carry them, so `postedAt`
// is null; freshness windows keep undated watchlist roles.

const HOST_RE = /^([a-z0-9-]+)\.applytojob\.com$/i;

/** Decode the handful of entities a job title actually contains. */
function decode(html) {
  return String(html ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Derive the board URL from a careers_url, or null if this is not JazzHR. */
export function detect(entry) {
  const raw = entry?.careers_url ?? entry?.url;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }

  const slug = HOST_RE.exec(u.hostname)?.[1];
  if (slug) return { url: `https://${slug}.applytojob.com/apply` };

  // An explicit `jazzhr_slug:` on the watchlist entry, for a company whose
  // branded careers page fronts a JazzHR board without revealing it.
  if (entry?.jazzhr_slug) return { url: `https://${entry.jazzhr_slug}.applytojob.com/apply` };
  return null;
}

/** Parse a JazzHR career page into rows. Exported so it can be tested offline. */
export function parseBoard(html, boardUrl) {
  const jobs = [];

  for (const [block] of String(html).matchAll(/<li[^>]*class="[^"]*list-group-item[^"]*"[\s\S]*?<\/li>\s*(?=<li|<\/ul)/g)) {
    const link = block.match(/<h3[^>]*list-group-item-heading[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = link[1].replace(/^http:/, 'https:');
    const title = decode(link[2]);
    // A block we cannot name or link to is not a job we can show anyone.
    if (!title || !/^https:\/\/[a-z0-9-]+\.applytojob\.com\/apply\/[^/]+/i.test(url)) continue;

    // The meta row is `<li><i class="fa fa-map-marker"></i>Chennai, India</li>`
    // followed by department and type. Only the marker one is location.
    const location = decode(block.match(/<i[^>]*fa-map-marker[^>]*><\/i>([\s\S]*?)<\/li>/i)?.[1] ?? '');

    jobs.push({ title, url, location, postedAt: null });
  }

  if (jobs.length === 0 && /list-group-item/.test(html)) {
    // Blocks are present but none parsed — the markup moved. Say so; a silent
    // zero here would look exactly like a company with no openings.
    throw new Error('jazzhr: found listing blocks but parsed no jobs — the career-page markup may have changed');
  }
  return jobs;
}

export default {
  id: 'jazzhr',
  detect,

  /**
   * @param {object} entry  the watchlist.yml entry, as career-ops passes it
   * @param {object} ctx    career-ops http context ({fetchText}/{fetchJson})
   */
  async fetch(entry, ctx) {
    const target = detect(entry);
    if (!target) throw new Error('jazzhr: cannot derive a board URL — set careers_url to the applytojob.com board, or add jazzhr_slug');

    const html = ctx?.fetchText
      ? await ctx.fetchText(target.url)
      : await (await fetch(target.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': ctx?.userAgent ?? 'huntley/0.1', Accept: 'text/html' },
        })).text();

    // JazzHR serves a 200 with a "404 Page Not Found" body for a slug that does
    // not exist, so status alone cannot be trusted.
    if (/<title>\s*404 Page Not Found/i.test(html)) {
      throw new Error(`jazzhr: no board at ${target.url}`);
    }

    return parseBoard(html, target.url).map((job) => ({
      ...job,
      company: entry.name ?? entry.company ?? '',
      source: 'jazzhr',
    }));
  },
};
