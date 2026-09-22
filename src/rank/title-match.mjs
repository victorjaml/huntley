// Title matching: one role term to get in, one point per keyword on top.
//
// A title is scored in three steps, all driven by config/preferences.yml:
//
//   exclude_titles  a title containing any of these is out. This is where
//                   compounds that share a role word with what you want but
//                   mean something else live: "mechanical engineer",
//                   "rocket scientist", "sales engineer".
//
//   exclude_exceptions
//                   per exclusion, words that cancel it when the title also
//                   contains one of them anywhere. `software engineer: [staff]`
//                   drops "Senior Software Engineer" and keeps "Senior Staff AI
//                   Software Engineer". Scoped to its own exclusion, so a
//                   "Staff Security Engineer" is still out. An entry written
//                   `@group` stands for every keyword in that group, so
//                   `software engineer: [staff, "@robotics"]` also keeps
//                   "Robotics Software Engineer III".
//
//   role_terms      a title must contain at least one — "engineer*",
//                   "scientist", "technical staff". This is what makes a
//                   posting the right KIND of job.
//
//   title_keywords  every one found in the title adds a point. "AI Safety
//                   Research Engineer" matches `ai safety` and `research` and
//                   scores 2; "Software Engineer, Notifications" matches none
//                   and scores 0. More specific is more relevant.
//
//                   Either a flat list, or keywords grouped by focus area:
//                     title_keywords:
//                       safety:   [alignment, interpretability, ...]
//                       robotics: [robotics, perception, ...]
//                   Groups score identically to a flat list. They exist so
//                   other rules can name a whole area instead of repeating its
//                   words — an exception can say "@robotics".
//
// Matching rules, chosen so the count means something:
//
//   • Word boundaries. `ml` must not match "HTML", `ai` must not match
//     "Maintenance", `rl` must not match "World". Every term is anchored at
//     both ends unless it says otherwise.
//   • A trailing `*` anchors only the start: `engineer*` matches "engineer",
//     "engineers" and "engineering", which is what lets "Engineering Manager"
//     through without a separate term.
//   • A space inside a term matches a space, hyphen, slash or underscore, so
//     `red team` matches "Red-Team" and `post training` matches "Post-Training".
//   • Overlapping keywords are counted once, longest first. With both `ai safety`
//     and `safety` configured, "AI Safety Engineer" scores 1, not 2 — otherwise
//     the score would reward having written the same idea twice in the config
//     rather than a title that is actually more specific.

const WORD = String.raw`[\p{L}\p{M}\p{N}]`;

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one configured term into a global, unicode-aware regex.
 * Exported so the career-ops filter derivation can mirror the same semantics.
 */
export function compileTerm(raw) {
  const term = String(raw ?? '').trim().toLowerCase();
  if (!term) return null;

  const stem = term.endsWith('*');
  const body = (stem ? term.slice(0, -1) : term).trim();
  if (!body) return null;

  const pattern = body
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .map(escape)
    .join(String.raw`[\s\-_/]+`);

  const tail = stem ? '' : `(?!${WORD})`;
  return { term, re: new RegExp(`(?<!${WORD})${pattern}${tail}`, 'giu'), length: body.length };
}

function compileList(list) {
  return (list ?? []).map(compileTerm).filter(Boolean);
}

/**
 * title_keywords as { group: [terms] }. A flat list is one group, "keywords",
 * so existing configs keep working unchanged.
 */
export function keywordGroups(titleKeywords) {
  if (Array.isArray(titleKeywords)) return { keywords: titleKeywords };
  if (titleKeywords && typeof titleKeywords === 'object') {
    return Object.fromEntries(Object.entries(titleKeywords).map(([g, terms]) => [g, [].concat(terms ?? [])]));
  }
  return {};
}

/** Every keyword across every group, in config order. */
export function allKeywords(titleKeywords) {
  return Object.values(keywordGroups(titleKeywords)).flat();
}

/** Expand `@group` references against the keyword groups. Unknown groups expand to nothing. */
export function expandGroupRefs(words, titleKeywords) {
  const groups = keywordGroups(titleKeywords);
  return [].concat(words ?? []).flatMap((w) => {
    const s = String(w).trim();
    return s.startsWith('@') ? (groups[s.slice(1)] ?? []) : [s];
  });
}

/** All non-overlapping matches of a term list, longest term winning each span. */
function findMatches(title, compiled) {
  const hits = [];
  for (const c of compiled) {
    c.re.lastIndex = 0;
    for (const m of title.matchAll(c.re)) {
      hits.push({ term: c.term, start: m.index, end: m.index + m[0].length, length: c.length });
    }
  }
  // Longest term first, then earliest, so `ai safety` claims its span before
  // `safety` can.
  hits.sort((a, b) => b.length - a.length || a.start - b.start);

  const taken = [];
  const kept = [];
  for (const h of hits) {
    if (taken.some(([s, e]) => h.start < e && s < h.end)) continue;
    taken.push([h.start, h.end]);
    kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Cache compiled lists per targets object — a run matches thousands of titles. */
const cache = new WeakMap();

function compiledTargets(targets) {
  let c = cache.get(targets);
  if (!c) {
    c = {
      role: compileList(targets.role_terms),
      keywords: compileList(allKeywords(targets.title_keywords)),
      groupOf: new Map(Object.entries(keywordGroups(targets.title_keywords))
        .flatMap(([g, terms]) => terms.map((t) => [String(t).trim().toLowerCase(), g]))),
      exclude: compileList(targets.exclude_titles),
      // { "software engineer": ["staff", "@robotics"] } → Map(exclusion term → compiled cancellers)
      exceptions: new Map(Object.entries(targets.exclude_exceptions ?? {})
        .map(([term, words]) => [String(term).trim().toLowerCase(), compileList(expandGroupRefs(words, targets.title_keywords))])),
    };
    cache.set(targets, c);
  }
  return c;
}

/**
 * Score a title against the operator's targets.
 *
 * @param {string} title
 * @param {{role_terms?: string[], title_keywords?: string[], exclude_titles?: string[], exclude_exceptions?: Record<string, string[]>}} targets
 * @returns {{
 *   excluded: string[],   exclusion terms found (non-empty means the title is out)
 *   roles: string[],      role terms found (empty means it is not a matching kind of job)
 *   keywords: string[],   distinct keywords found, in title order
 *   groups: string[],     the focus-area groups those keywords belong to
 *   score: number,        keywords.length
 * }}
 */
export function matchTitle(title, targets = {}) {
  const t = String(title ?? '').toLowerCase();
  const c = compiledTargets(targets);

  // An exclusion is cancelled when its own exception words appear anywhere in
  // the title — anywhere, because level words do not sit in fixed positions:
  // "Staff Software Engineer", "Senior Staff AI Software Engineer" and "Member
  // of Technical Staff - Research Software Engineer" all say "staff".
  const cancelled = (term) => {
    const words = c.exceptions.get(term);
    return Boolean(words?.some((w) => { w.re.lastIndex = 0; return w.re.test(t); }));
  };
  const excluded = [...new Set(findMatches(t, c.exclude).map((h) => h.term))].filter((term) => !cancelled(term));
  const roles = [...new Set(findMatches(t, c.role).map((h) => h.term))];
  const keywords = [...new Set(findMatches(t, c.keywords).map((h) => h.term))];
  const groups = [...new Set(keywords.map((k) => c.groupOf.get(k)).filter(Boolean))];

  return { excluded, roles, keywords, groups, score: keywords.length };
}
