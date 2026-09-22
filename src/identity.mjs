// One company, one identity — across every lane that found it.
//
// The same employer reaches huntley under different names depending on which
// lane saw it first. Reflection AI arrives as "Reflection AI" from the
// watchlist and as "Reflection" from LinkedIn, so keying on the display name
// splits one company into two. That is not cosmetic: it doubles the
// max_per_company cap, drops the watchlist bonus for whichever name does not
// match watchlist.yml, and leaves the same hole in block_companies.
//
// Identity is resolved from EVIDENCE, never from guessing that two similar
// names are the same company:
//
//   • a shared board URL — jobs.ashbyhq.com/reflectionai is one employer,
//     whatever a lane chose to call it. Taken from job.board, or read out of
//     the posting URL when the lane did not record one.
//   • an explicit alias list — companyAliases, written by board-name
//     resolution, which already knows "reflectionai" is "Reflection".
//   • a watchlist entry — its name and careers_url are the same company by
//     definition, and its name wins as the canonical spelling.
//
// Names alone never merge. "Scale" and "Scale AI" stay separate unless some
// posting ties them to one board, because suffix-stripping the other way
// round ("Glean" vs "Glean AI") would merge two real and different companies.

import { companyKey } from './normalize.mjs';
import { extractBoards } from './sources/funds/boards.mjs';

// A board linked to more than this many distinct names is an aggregator that
// slipped through, not an employer — merging on it would collapse unrelated
// companies into one. Real boards carry one name plus a slug and an alias or
// two; the last full run had a maximum of one name across 520 boards.
const MAX_NAMES_PER_BOARD = 8;

/** The vendor slug in a board URL — "anthropic" in job-boards.greenhouse.io/anthropic. */
function boardSlug(url) {
  const m = /^https?:\/\/[^/]+\/([^/?#]+)/.exec(url ?? '');
  return m ? companyKey(decodeURIComponent(m[1])) : null;
}

/** The board a posting belongs to, from the lane's record or from its URL. */
export function boardUrlFor(job) {
  const direct = job?.board?.careers_url
    ?? (typeof job?.board === 'string' ? job.board : null);
  const found = direct ?? extractBoards(job?.url ?? '')[0]?.careers_url ?? null;
  return found ? String(found).replace(/\/+$/, '').toLowerCase() : null;
}

/** Union-find over name and board nodes. */
function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    },
    nodes: () => parent.keys(),
  };
}

const nameNode = (key) => `name:${key}`;
const boardNode = (url) => `board:${url}`;

/**
 * Resolve every posting to one company identity.
 *
 * @param {object[]} jobs
 * @param {{watchlist?: {name?: string, careers_url?: string}[],
 *          boardNames?: Record<string, {name?: string|null, aliases?: string[]}>}} [opts]
 *   boardNames is the persistent board-name cache (careers_url → the name the
 *   board itself gives). Only boards some posting or watchlist entry sits on
 *   are used, so a stale entry for a board nobody saw this run adds nothing.
 * @returns {{keyFor: (job: object) => string, nameFor: (job: object) => string,
 *            apply: (jobs: object[]) => object[], merged: number}}
 */
export function buildCompanyIdentity(jobs, { watchlist = [], boardNames = null } = {}) {
  const uf = makeUnionFind();
  const namesPerBoard = new Map();
  const nameCounts = new Map();
  const watchlistNames = new Set();

  const noteName = (key, display) => {
    if (!key) return;
    if (!nameCounts.has(key)) nameCounts.set(key, new Map());
    const seen = nameCounts.get(key);
    if (display) seen.set(display, (seen.get(display) ?? 0) + 1);
  };

  // Primary names (what a lane actually called the company) may merge two
  // boards. Aliases may not: they include vendor path segments like Workday's
  // "ext", which is an alias on both autodesk.wd1/ext and fiserv.wd5/ext and
  // would otherwise fuse Autodesk into Fiserv. An alias only ever attaches a
  // name to one board, and is dropped outright if it reaches for a second.
  const aliasBoards = new Map();
  const link = (key, board) => {
    if (!key || !board) return;
    if (!namesPerBoard.has(board)) namesPerBoard.set(board, new Set());
    namesPerBoard.get(board).add(key);
  };
  const linkAlias = (key, board) => {
    if (!key || !board) return;
    if (!aliasBoards.has(key)) aliasBoards.set(key, new Set());
    aliasBoards.get(key).add(board);
  };

  // Evidence pass. Collect before merging so an aggregator board can be
  // rejected wholesale rather than after it has already joined two companies.
  for (const entry of watchlist ?? []) {
    const key = companyKey(entry?.name);
    if (!key) continue;
    watchlistNames.add(key);
    noteName(key, entry.name);
    const board = entry?.careers_url
      ? String(entry.careers_url).replace(/\/+$/, '').toLowerCase()
      : null;
    link(key, board);
  }

  for (const job of jobs ?? []) {
    const key = job.companyKey || companyKey(job.company);
    if (!key) continue;
    noteName(key, job.company);
    const board = boardUrlFor(job);
    link(key, board);
    for (const alias of job.companyAliases ?? []) linkAlias(companyKey(alias), board);
  }

  // What each board says its own employer is, remembered across runs. Evidence
  // from postings alone evaporates: on 2026-09-16 the rows tying LinkedIn's
  // "Reflection" to jobs.ashbyhq.com/reflectionai were one-off recovered
  // observations, and two days later nothing in the run joined the names, so
  // Reflection AI split in two again. The cache is where those rows got their
  // names in the first place.
  // Names a board declares for itself, via the cache. They rank with the slug:
  // 31 postings on adobe.wd5.myworkdayjobs.com arrive labelled "Frame.io", and
  // the board's own answer ("Adobe Inc.") must not lose to that row count.
  const declaredNames = new Set();
  if (boardNames) {
    const seenBoards = new Set(namesPerBoard.keys());
    for (const [url, hit] of Object.entries(boardNames)) {
      const board = String(url).replace(/\/+$/, '').toLowerCase();
      if (!seenBoards.has(board) || !hit?.name) continue;
      const key = companyKey(hit.name);
      noteName(key, null);
      link(key, board);
      declaredNames.add(key);
      for (const alias of hit.aliases ?? []) linkAlias(companyKey(alias), board);
    }
  }

  // An alias that points at exactly one board is real evidence about that
  // board; one pointing at several is a vendor path segment, not a company.
  const primaryNames = new Set([...namesPerBoard.values()].flatMap((s) => [...s]));
  for (const [key, boards] of aliasBoards) {
    if (boards.size !== 1) continue;
    if (primaryNames.has(key)) continue;
    link(key, [...boards][0]);
  }

  let merged = 0;
  for (const [board, keys] of namesPerBoard) {
    if (keys.size > MAX_NAMES_PER_BOARD) continue;
    for (const key of keys) {
      const before = uf.find(nameNode(key));
      uf.union(nameNode(key), boardNode(board));
      if (before !== uf.find(nameNode(key)) && keys.size > 1) merged++;
    }
  }

  // Which name a board's own slug spells — job-boards.greenhouse.io/anthropic
  // says the employer is Anthropic, however many of its postings a portfolio
  // feed mislabelled. Stronger evidence than a row count.
  const slugNames = new Set(declaredNames);
  for (const board of namesPerBoard.keys()) {
    const slug = boardSlug(board);
    if (slug && namesPerBoard.get(board).has(slug)) slugNames.add(slug);
  }

  // Canonical spelling per component, in order of how much the evidence is
  // worth: the watchlist name you chose, then the name the board slug spells,
  // then the most-seen display name, with length and alphabetical order as a
  // deterministic tiebreak.
  const canonicalKey = new Map();
  const canonicalName = new Map();
  const components = new Map();
  for (const node of [...uf.nodes()]) {
    if (!node.startsWith('name:')) continue;
    const root = uf.find(node);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(node.slice('name:'.length));
  }
  const rootCanonical = new Map();
  for (const [root, keys] of components) {
    const watchKeys = keys.filter((k) => watchlistNames.has(k)).sort();
    const slugKeys = keys.filter((k) => slugNames.has(k)).sort();
    const pick = watchKeys[0] ?? slugKeys[0] ?? [...keys].sort((a, b) => {
      const ca = [...(nameCounts.get(a)?.values() ?? [])].reduce((s, n) => s + n, 0);
      const cb = [...(nameCounts.get(b)?.values() ?? [])].reduce((s, n) => s + n, 0);
      return cb - ca || b.length - a.length || a.localeCompare(b);
    })[0];
    // The display name is chosen across the whole component, not just under
    // the winning key: that key can be a board slug ("crowdstrikecareers"),
    // which identifies the employer well and reads terribly. Prefer the
    // watchlist spelling, then a name that looks authored rather than
    // url-shaped, then the one most postings actually used.
    const authored = (n) => /[A-Z]/.test(n) || /[ .,&-]/.test(n);
    const candidates = [];
    for (const key of keys) {
      const isWatch = watchlistNames.has(key);
      // A name that spells the winning key is the one the board vouches for.
      // 566 postings on job-boards.greenhouse.io/anthropic calling themselves
      // "Cargo" do not outvote the board saying the employer is Anthropic.
      const spellsKey = key === pick;
      for (const [display, count] of nameCounts.get(key)?.entries() ?? []) {
        candidates.push({ display, count, isWatch, spellsKey });
      }
    }
    candidates.sort((a, b) =>
      (b.isWatch ? 1 : 0) - (a.isWatch ? 1 : 0)
      || (b.spellsKey ? 1 : 0) - (a.spellsKey ? 1 : 0)
      || (authored(b.display) ? 1 : 0) - (authored(a.display) ? 1 : 0)
      || b.count - a.count
      || a.display.length - b.display.length
      || a.display.localeCompare(b.display));
    const display = candidates[0]?.display ?? pick;
    for (const key of keys) {
      canonicalKey.set(key, pick);
      canonicalName.set(key, display);
    }
    rootCanonical.set(root, pick);
  }

  const resolve = (job) => {
    const key = job.companyKey || companyKey(job.company);
    const board = boardUrlFor(job);
    // Board first: it survives a lane renaming the company.
    if (board) {
      const viaBoard = rootCanonical.get(uf.find(boardNode(board)));
      if (viaBoard) return viaBoard;
    }
    return canonicalKey.get(key) ?? key;
  };

  return {
    merged,
    keyFor: resolve,
    nameFor: (job) => canonicalName.get(resolve(job)) ?? job.company,
    /** Rewrite every posting onto its canonical company, in place of the lane's guess. */
    apply(list) {
      return (list ?? []).map((job) => {
        const key = resolve(job);
        const name = canonicalName.get(key) ?? job.company;
        return key === job.companyKey && name === job.company
          ? job
          : { ...job, companyKey: key, company: name };
      });
    },
  };
}
