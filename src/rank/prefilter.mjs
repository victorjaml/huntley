// Stage 1 of ranking: zero-token.
//
// The LLM stage costs time and subscription usage, so nothing reaches it that a
// string comparison could have rejected. This stage does two jobs:
//
//   reject  — hard constraints you have already stated (location, excluded
//             titles, companies you have blocked). A reject is recorded with
//             its reason, not silently dropped, so a filter that is quietly
//             eating good roles is visible in the run log.
//   presort — a cheap heuristic score used only to choose WHICH survivors get
//             the LLM's attention when there are more than the budget allows.
//             It never appears in the digest; the LLM's score does.
//
// Every rule applies to every role, watchlist companies included. The watchlist
// changes how often a company is checked and where its matching roles appear,
// never whether an irrelevant role is shown.

import { matchTitle } from './title-match.mjs';
import { classifyLocation } from './places.mjs';

const lower = (s) => String(s ?? '').toLowerCase();

function anyMatch(haystack, needles) {
  const h = lower(haystack);
  return (needles ?? []).some((n) => n && h.includes(lower(n)));
}

// A blocked company matches as whole words ("xAI" blocks "xAI Corp", not
// "Maxaid Labs"), or — for names of five letters or more — with spacing
// removed, so "Scale AI" still blocks a board slug "scaleai" and "Northrop
// Grumman" blocks a career site "Northrop_Grumman_External_Site".
const compact = (s) => lower(s).replace(/[^a-z0-9]/g, '');
const words = (s) => ` ${lower(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;
function companyBlocked(company, blocked) {
  const w = words(company), c = compact(company);
  return (blocked ?? []).some((b) => {
    const bw = words(b).trim(), bc = compact(b);
    return (bw && w.includes(` ${bw} `)) || (bc.length >= 5 && c.includes(bc));
  });
}

function matchedTerms(haystack, needles) {
  const h = lower(haystack);
  return (needles ?? []).filter((n) => n && h.includes(lower(n)));
}

/**
 * Where the work is: office (in a place you accept), remote, unknown, or other.
 * The reading of the location string lives in places.mjs.
 */
export function classifyWorkplace(location, loc = {}) {
  return classifyLocation(location, loc);
}

/** How remote roles are treated: rank_lower (default), accept, or exclude. */
function remotePolicy(loc) {
  return loc.remote ?? 'rank_lower';
}

/**
 * @typedef {object} PrefilterResult
 * @property {import('../normalize.mjs').Job[]} kept
 * @property {{job: object, reason: string}[]} rejected
 */

/**
 * @param {import('../normalize.mjs').Job[]} jobs
 * @param {object} prefs  the preferences.yml document
 * @returns {PrefilterResult}
 */
export function prefilter(jobs, prefs) {
  const targets = prefs?.targets ?? {};
  const loc = prefs?.location ?? {};
  const filters = prefs?.filters ?? {};

  const kept = [];
  const rejected = [];

  for (const job of jobs) {
    const haystack = `${job.title} ${job.company} ${job.location} ${job.description ?? ''}`;
    const match = matchTitle(job.title, targets);
    const reason = rejectReason(job, { targets, loc, filters, haystack, match });

    if (reason) {
      rejected.push({ job, reason });
      continue;
    }
    const withMatch = { ...job, titleKeywords: match.keywords, keywordScore: match.score, workplace: classifyWorkplace(job.location, loc) };
    kept.push({ ...withMatch, heuristic: heuristicScore(withMatch, { targets, loc, filters }) });
  }

  kept.sort((a, b) => b.heuristic - a.heuristic);
  return { kept, rejected };
}

function rejectReason(job, { targets, loc, filters, haystack, match }) {
  // ── Hard location block. Applies to everyone, watchlist included: a role you
  // cannot take is not a match however much you like the company.
  // ── Companies you have explicitly blocked.
  const names = [job.company, ...(job.companyAliases ?? [])];
  if (names.some((n) => companyBlocked(n, filters.block_companies))) {
    return `company on block list`;
  }

  // ── Titles you never want to see, from anyone. Checked before the watchlist
  // bypass and before the role gate: an exclusion is the most specific
  // statement in the file — "Mechanical Engineer" contains a role word, and the
  // exclusion is what says it is the wrong kind of engineer. The career-ops
  // scanner applies the same list to watchlist companies, so applying it here
  // too keeps the two layers agreeing about the same posting.
  if (match.excluded.length) {
    return `title excluded (${match.excluded.join(', ')})`;
  }

  // ── Location, for everyone. A posting must be an office in a place you
  // accept, or remote (unless remote is excluded). You list only the places you
  // accept; recognising that "Toronto" or "Remote, UK" is somewhere else is
  // places.mjs's job, so there is no list of unwanted places to maintain.
  const workplace = classifyWorkplace(job.location, loc);
  if (workplace === 'other') {
    return `location "${job.location}" is not a place you accept`;
  }
  if (workplace === 'remote' && remotePolicy(loc) === 'exclude') {
    return `location "${job.location}" is remote, and remote roles are excluded`;
  }

  // The watchlist does not exempt a role from any rule. Being on it means the
  // company is checked every run and its matching roles earn a score bonus — a
  // chemical engineer role at a company you like is still not a role you want.

  // ── The role gate. A title must name a kind of role you do — engineer,
  // scientist, researcher, technical staff — before its keywords count for
  // anything. See src/rank/title-match.mjs for the matching rules.
  if (targets.role_terms?.length && match.roles.length === 0) {
    return `title names no target role (${targets.role_terms.slice(0, 4).join(', ')}…)`;
  }

  // ── An optional keyword floor. 0 by default: a role that passes the gate but
  // matches no keyword is still eligible, just ranked behind every role that
  // does. Raising this trades recall for volume, and a hidden role is invisible
  // in a way a low-ranked one is not.
  const minKeywords = Number(targets.min_keyword_score ?? 0);
  if (match.score < minKeywords) {
    return `matched ${match.score} keyword(s), below the floor of ${minKeywords}`;
  }

  // ── Seniority floor, expressed as words that should never appear.
  if (anyMatch(job.title, filters.exclude_seniority)) {
    return `seniority excluded (${matchedTerms(job.title, filters.exclude_seniority).join(', ')})`;
  }

  // ── Content terms that disqualify regardless of title (clearance, on-site
  // only in a city you cannot reach, and so on) — only when we have JD text.
  if (job.description && anyMatch(haystack, filters.block_content)) {
    return `content blocked (${matchedTerms(haystack, filters.block_content).join(', ')})`;
  }

  return null;
}

/**
 * A cheap 0–100 presort score. Only decides who the LLM looks at first when
 * more roles pass the filters than the ranking budget allows.
 * Not shown to you — the LLM's 0–5 is the score in the digest.
 */
export function heuristicScore(job, { targets, loc, filters }) {
  let score = 40;

  if (job.watchlist) score += 30;

  // Keyword count is the strongest cheap signal available: each keyword in the
  // title is a more specific statement that this is your kind of role. Ten
  // points apiece, so three keywords weigh as much as being on the watchlist.
  const keywordScore = job.keywordScore ?? matchTitle(job.title, targets).score;
  score += Math.min(30, keywordScore * 10);

  if (anyMatch(job.title, targets.preferred_levels)) score += 8;
  // An office in a place you named beats remote-with-no-office, which you
  // accept but rank lower because you prefer somewhere to go in to.
  const workplace = job.workplace ?? classifyWorkplace(job.location, loc);
  if (workplace === 'office') score += 8;
  if (workplace === 'remote' && remotePolicy(loc) === 'rank_lower') score -= 10;

  // Freshness: today's posting beats last week's for the same fit.
  if (job.postedAt) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(`${job.postedAt}T12:00:00Z`)) / 86_400_000);
    score += ageDays <= 1 ? 10 : ageDays <= 3 ? 6 : ageDays <= 7 ? 3 : 0;
  }

  // A posting we have the body of can be judged properly; prefer it marginally.
  if (job.description) score += 3;

  if (anyMatch(job.title, filters.deprioritize)) score -= 15;

  return Math.max(0, Math.min(100, score));
}
