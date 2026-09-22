// Turning a week of evidence into a proposed preference diff.
//
// Two stages, in this order on purpose:
//
//   1. Deterministic detectors. Countable patterns with stated thresholds —
//      a company you keep adding from, a keyword that only ever produces
//      roles you ignore, a location you have repeatedly accepted despite
//      blocking it. These come with their evidence attached, so you can check
//      the arithmetic rather than take the proposal's word for it.
//
//   2. An LLM pass, for the one thing counting cannot do: read the "why" lines
//      of what you added against what you ignored and write a durable note
//      about the difference. Its output is confined to `notes` — it can add a
//      sentence the ranker reads, and it cannot touch a filter. If the CLI is
//      missing or returns junk, stage 1 still produces a proposal.
//
// Every change carries a `reason` and an `evidence` field, because a diff you
// cannot audit is a diff you should not approve.

import { randomUUID } from 'node:crypto';
import { log } from '../lib/log.mjs';
import { matchTitle, keywordGroups } from '../rank/title-match.mjs';
import { detectCli, extractJson } from '../rank/llm.mjs';
import { spawn } from 'node:child_process';

// Thresholds. Stated here, quoted in the email, so a proposal is never a
// judgment call dressed up as a finding.
const T = {
  watchlistAdds: 2,          // adds from one company before suggesting the watchlist
  deadKeywordShown: 12,      // times a keyword must have been shown…
  deadKeywordAddRate: 0,     // …with this many adds, before suggesting removal
  blockedLocationAdds: 2,    // adds in a location you block before questioning the block
  rejectedTitleAdds: 2,      // adds of a title shape your excludes would have killed
  minNotesEvidence: 6,       // added roles needed before asking the model for a note
};

/**
 * @param {object} evidence  from weekly.mjs gatherEvidence()
 * @param {object} config
 */
export async function buildProposal(evidence, config) {
  const prefs = config.preferences ?? {};
  const changes = [];

  changes.push(...detectWatchlistCandidates(evidence, prefs));
  changes.push(...detectDeadKeywords(evidence, prefs));
  changes.push(...detectOverEagerExcludes(evidence, prefs));

  // The model gets the last word only on `notes`, and only with enough to read.
  if (evidence.addedJobs.length >= T.minNotesEvidence) {
    changes.push(...await proposeNotes(evidence, config));
  }

  return {
    id: `prop-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    window: { days: evidence.days },
    summary: {
      shown: evidence.shown.length,
      added: evidence.added.length,
      ignored: evidence.ignoredJobs.length,
      outcomes: evidence.outcomes.length,
      filteredOut: evidence.rejected.length,
    },
    changes,
  };
}

// ── Detector 1: companies you keep adding from ──────────────────────

function detectWatchlistCandidates(evidence, prefs) {
  const counts = new Map();
  for (const job of evidence.addedJobs) {
    if (job.watchlist) continue;           // already watched
    counts.set(job.companyKey, [...(counts.get(job.companyKey) ?? []), job]);
  }

  const out = [];
  for (const [key, jobs] of counts) {
    if (jobs.length < T.watchlistAdds) continue;
    out.push({
      op: 'add_note',
      value: `Add ${jobs[0].company} to the watchlist — ${jobs.length} roles added from them and they are not being checked every run.`,
      reason: `You added ${jobs.length} roles from ${jobs[0].company} in the last ${evidence.days} days, but they are not on your watchlist, so huntley only sees them when a board happens to surface one.`,
      evidence: jobs.map((j) => `${j.title} (${j.shownOn})`),
      // Deliberately a note, not an automatic watchlist.yml edit: adding a company
      // to the watchlist needs its ATS board resolved, which is a step huntley
      // should not take silently on your behalf.
      followUp: `node bin/huntley.mjs discover-board "${jobs[0].company}" --write`,
    });
  }
  return out;
}

// ── Detector 2: keywords that only produce noise ────────────────────
//
// A keyword now adds a point rather than opening a gate, so the question is
// whether it is earning its point: has it been the ONLY keyword behind a run of
// shown roles, none of which you added? A keyword that always co-occurs with
// another one is not what put those roles in front of you, and is not blamed.

function detectDeadKeywords(evidence, prefs) {
  const targets = prefs?.targets ?? {};
  const grouped = Array.isArray(targets.title_keywords)
    ? [[null, targets.title_keywords]]
    : Object.entries(keywordGroups(targets.title_keywords));
  const keywords = grouped.flatMap(([group, terms]) => terms.map((term) => ({ group, term })));
  const addedIds = new Set(evidence.addedJobs.map((j) => j.id));
  const out = [];

  const matched = evidence.shown.map((j) => ({ job: j, kws: matchTitle(j.title, targets).keywords }));

  for (const { group, term: keyword } of keywords) {
    const k = String(keyword).trim().toLowerCase();
    if (k.replace(/\*$/, '').length < 2) continue;

    const soleMatches = matched.filter((m) => m.kws.length === 1 && m.kws[0] === k).map((m) => m.job);
    if (soleMatches.length < T.deadKeywordShown) continue;

    const adds = soleMatches.filter((j) => addedIds.has(j.id)).length;
    if (adds > T.deadKeywordAddRate) continue;

    out.push({
      op: 'remove_list_item',
      path: group ? `targets.title_keywords.${group}` : 'targets.title_keywords',
      value: keyword,
      reason: `"${keyword}" was the only keyword behind ${soleMatches.length} roles shown in ${evidence.days} days, and you added none of them.`,
      evidence: soleMatches.slice(0, 5).map((j) => `${j.title} @ ${j.company}`),
    });
  }
  return out;
}

// ── Detector 4: excludes that would have killed roles you wanted ─────
//
// Exclusions apply to every source, watchlist included, so a role you added
// can only contain an excluded term if the exclusion arrived after the role
// did. That is exactly the case worth catching: a new exclusion that is
// quietly hiding the kind of role you have been adding.

function detectOverEagerExcludes(evidence, prefs) {
  const targets = prefs?.targets ?? {};
  const out = [];

  for (const term of targets.exclude_titles ?? []) {
    const probe = { exclude_titles: [term] };
    const adds = evidence.addedJobs.filter((j) => matchTitle(j.title, probe).excluded.length > 0);
    if (adds.length < T.rejectedTitleAdds) continue;

    out.push({
      op: 'remove_list_item',
      path: 'targets.exclude_titles',
      value: term,
      reason: `You added ${adds.length} roles whose titles match "${term}", which your exclude list now hides everywhere.`,
      evidence: adds.map((j) => `${j.title} @ ${j.company}`),
    });
  }
  return out;
}

// ── The LLM pass: one durable note, confined to `notes` ─────────────

async function proposeNotes(evidence, config) {
  const candidate = await detectCli(config.rank?.cli);
  if (!candidate) {
    log.warn('no agent CLI available — the weekly proposal is from the deterministic detectors only');
    return [];
  }

  const sample = (jobs, n) => jobs.slice(0, n).map((j) =>
    `- ${j.title} @ ${j.company} (${j.location || 'no location'}) — scored ${j.score}${j.why ? `: ${j.why}` : ''}`
  ).join('\n');

  const prompt = `You are reviewing one person's job search to find a pattern worth writing down.

# Roles they saw and ADDED to their tracker (they want to apply)
${sample(evidence.addedJobs, 25) || '(none)'}

# Roles they saw and did NOT add
${sample(evidence.ignoredJobs.slice(0, 40), 40) || '(none)'}

${evidence.outcomes.length ? `# Applications with a recorded outcome
${evidence.outcomes.slice(0, 20).map((a) => `- ${a.title} @ ${a.company}: ${a.outcome}`).join('\n')}` : ''}

# Your task

Find at most TWO durable patterns that distinguish what they add from what they ignore, and write each as one instruction to a screener who reads every posting for them tomorrow.

Rules:
- A pattern must be supported by at least three roles on the added side. If nothing clears that bar, return an empty array. Returning nothing is the correct answer more often than not.
- Do not restate their stated preferences back at them. "They want ML roles" is not a finding; they wrote that themselves.
- Do not propose changes to filters, scores, or thresholds. You are writing a note the ranker reads, nothing else.
- Write about the postings, not about the person. No career advice.
- Each note must be under 200 characters and must be actionable when reading a single job posting.

Good:   "Roles that name a specific team and product in the title convert to adds; generic 'Software Engineer' reqs at large companies do not."
Bad:    "They prefer senior machine learning roles in Los Angeles."

# Output

ONLY a JSON array, no prose:
[{"note": "<one instruction>", "reason": "<what in the data supports it>", "supporting": ["<role>", "<role>", "<role>"]}]`;

  const output = await new Promise((resolve) => {
    const child = spawn(candidate.bin, candidate.args(prompt, config.rank?.model), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), config.rank?.timeout_ms ?? 180_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });

  if (!output) { log.warn('the note-writing pass failed — proposing detector findings only'); return []; }

  const parsed = extractJson(output);
  if (!Array.isArray(parsed)) { log.warn('could not parse the note-writing reply — proposing detector findings only'); return []; }

  return parsed
    .filter((r) => typeof r?.note === 'string' && r.note.trim().length >= 20 && Array.isArray(r.supporting) && r.supporting.length >= 3)
    .slice(0, 2)
    .map((r) => ({
      op: 'add_note',
      value: String(r.note).replace(/\s+/g, ' ').trim().slice(0, 240),
      reason: String(r.reason ?? 'no reason given').replace(/\s+/g, ' ').slice(0, 400),
      evidence: r.supporting.slice(0, 5).map(String),
      fromModel: true,
    }));
}

export { T as THRESHOLDS };
