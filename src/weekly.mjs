// The weekly review: propose, never apply.
//
// It reads three things that the daily runs and your sheet have been
// accumulating, and asks one question of them:
//
//   what was shown   data/runs/*-shown.json — every role, its score, its why
//   what was added   the Inbox tab — the roles you said you wanted to apply to
//   what happened    the Applications tab — statuses and outcomes you recorded
//
// The signal is the gap between them. A filter that keeps rejecting roles you
// would have wanted is invisible in the digest and obvious here. A title
// keyword that only ever produces roles you ignore is costing you attention
// every morning. A company you add from repeatedly belongs on the watchlist.
//
// What it does NOT do: change anything. It writes a proposal to disk, emails
// you the diff with an APPROVE link, and stops. The change lands only after you
// click, and only on the next run, via the approvals tab. If there is too
// little evidence, it says so and proposes nothing — a pattern drawn from four
// data points is worse than no pattern, because it looks like knowledge.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, ensureDirs } from './lib/paths.mjs';
import { log } from './lib/log.mjs';
import { localToday } from './normalize.mjs';
import { createMailer } from './email/send.mjs';
import { actionUrl } from './sheet/links.mjs';
import { syncTracker, loadTrackerSnapshot, sheetDate, applyApprovals } from './sheet/sync.mjs';
import { validateProposal } from './memory/apply.mjs';
import { buildProposal } from './memory/propose.mjs';
import { renderProposalEmail } from './digest/proposal.mjs';

export async function runWeekly(config, opts = {}) {
  ensureDirs();
  const date = localToday();

  if (opts.apply) return applyByHand(config, opts);

  // Start by pulling the sheet, so the review reads what you actually did this
  // week rather than what huntley last happened to cache.
  // A dry run reads the sheet but neither rewrites the snapshot nor applies
  // an approval.
  try {
    await syncTracker(config, { dryRun: opts.dryRun });
  } catch (err) {
    log.warn(`could not refresh the tracker before reviewing: ${err.message}`);
  }

  const evidence = gatherEvidence(config);
  log.info(`evidence: ${evidence.shown.length} roles shown, ${evidence.added.length} added, ${evidence.outcomes.length} with a recorded outcome, over ${evidence.days} day(s)`);

  // ── The honesty gate ──────────────────────────────────────────────
  const thresholds = config.weekly ?? {};
  const tooThin = [];
  if (evidence.shown.length < (thresholds.min_shown ?? 40)) {
    tooThin.push(`only ${evidence.shown.length} roles have been shown (need ${thresholds.min_shown ?? 40})`);
  }
  if (evidence.added.length < (thresholds.min_added ?? 8)) {
    tooThin.push(`only ${evidence.added.length} roles have been added to the tracker (need ${thresholds.min_added ?? 8})`);
  }

  if (tooThin.length && !opts.force) {
    log.warn('not enough evidence to propose preference changes:');
    for (const reason of tooThin) log.warn(`  ${reason}`);
    log.info('nothing proposed. Run again after another week of digests, or pass --force to see what it would say.');
    await mailSkipNotice(config, { date, reasons: tooThin, evidence, dryRun: opts.dryRun });
    return 0;
  }

  // ── Build the proposal ────────────────────────────────────────────
  const proposal = await buildProposal(evidence, config);

  if (!proposal.changes.length) {
    log.ok('reviewed the week and found nothing worth changing — preferences are left alone');
    await mailSkipNotice(config, { date, reasons: ['reviewed the evidence and found no change worth proposing'], evidence, dryRun: opts.dryRun });
    return 0;
  }

  const problems = validateProposal(proposal);
  if (problems.length) {
    // A proposal that cannot be applied must not be mailed as if it could.
    log.error('the generated proposal is not applicable, so it will not be sent:');
    for (const p of problems) log.error(`  ${p}`);
    return 1;
  }

  // Persist BEFORE mailing. The APPROVE link refers to this file by id, and a
  // link whose proposal was never written is a dead link.
  writeFileSync(join(PATHS.proposals, `${proposal.id}.json`), JSON.stringify(proposal, null, 2));
  log.ok(`proposal ${proposal.id} written with ${proposal.changes.length} change(s)`);

  // ── Mail it with an APPROVE link ──────────────────────────────────
  let approveLink = null;
  try {
    if (config.sheet?.enabled) {
      approveLink = actionUrl({
        endpoint: config.sheet.webapp_url,
        secret: process.env.HUNTLEY_LINK_SECRET,
        action: 'approve',
        id: proposal.id,
        ttlDays: 90,
      });
    }
  } catch (err) {
    log.warn(`APPROVE link could not be built: ${err.message}`);
  }

  const { html, text } = renderProposalEmail({ proposal, evidence, date, approveLink, config });
  const subject = `${config.digest.subject_prefix ?? 'huntley'} · ${proposal.changes.length} proposed preference change${proposal.changes.length === 1 ? '' : 's'} · ${date}`;

  if (opts.dryRun) {
    const path = join(PATHS.digests, `${date}-proposal-dryrun.html`);
    writeFileSync(path, html);
    writeFileSync(join(PATHS.digests, `${date}-proposal-dryrun.txt`), text);
    log.ok(`dry run — proposal written to ${path} (not sent, not applied)`);
    process.stderr.write('\n' + text + '\n');
    return 0;
  }

  const res = await createMailer(config.email).send({ subject, html, text });
  if (!res.ok) throw new Error(`proposal email failed to send: ${res.error}`);

  log.ok(`proposal emailed. Nothing has changed — it applies only when you click APPROVE.`);
  return 0;
}

// ── Evidence ────────────────────────────────────────────────────────

function wasPresented(job, record) {
  if (job.unscored || job.rankStatus === 'skipped' || job.decision === 'unscored') return false;
  if (job.inEmail === true) return true;
  if (job.publishedLocally === true && record.delivery !== 'email') return true;
  if (job.publishedLocally == null && job.inEmail !== false) return true;
  return false;
}

function gatherEvidence(config) {
  const lookback = config.weekly?.lookback_days ?? 28;
  const cutoff = new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);

  // What you were shown, from the daily run records. Only roles that were in
  // the email count: a role ranked below the threshold or trimmed by the row
  // limit was never in front of you, so not adding it says nothing about it.
  const shown = [];
  const rejected = [];
  if (existsSync(PATHS.runs)) {
    const files = readdirSync(PATHS.runs).filter((f) => f.endsWith('-shown.json')).sort();
    for (const file of files) {
      if (file.slice(0, 10) < cutoff) continue;
      try {
        const record = JSON.parse(readFileSync(join(PATHS.runs, file), 'utf8'));
        for (const job of record.shown ?? []) {
          if (wasPresented(job, record)) shown.push({ ...job, shownOn: record.date });
        }
        for (const r of record.rejected ?? []) rejected.push({ ...r, shownOn: record.date });
      } catch { /* a truncated record is skipped, not fatal */ }
    }
  }

  // What you did about it, from the sheet.
  const tracker = loadTrackerSnapshot();
  const added = (tracker.inbox ?? []).filter((r) => r.status === 'added' && (sheetDate(r.added_at) ?? '') >= cutoff);
  const ignoredExplicitly = (tracker.inbox ?? []).filter((r) => r.status === 'ignored');
  const applications = tracker.applications ?? [];
  const outcomes = applications.filter((a) => (a.outcome ?? '').trim());

  const addedIds = new Set(added.map((r) => r.job_id));
  const shownIds = new Set(shown.map((j) => j.id));

  return {
    days: lookback,
    shown,
    rejected,
    added,
    applications,
    outcomes,
    ignoredExplicitly,
    // The core comparison: shown-and-added vs shown-and-not-added.
    addedJobs: shown.filter((j) => addedIds.has(j.id)),
    ignoredJobs: shown.filter((j) => !addedIds.has(j.id)),
    // An added role huntley has no record of showing means it came from
    // somewhere else — worth knowing, never worth guessing about.
    addedElsewhere: added.filter((r) => !shownIds.has(r.job_id)),
  };
}

async function mailSkipNotice(config, { date, reasons, evidence, dryRun }) {
  // Even "nothing to propose" is mailed, for the same reason a zero-match
  // digest is: a silent inbox must only ever mean the job failed.
  const text = [
    `huntley weekly review — ${date}`,
    '',
    'No preference changes are being proposed this week.',
    '',
    ...reasons.map((r) => `  • ${r}`),
    '',
    `Over the last ${evidence.days} days: ${evidence.shown.length} roles shown, ${evidence.added.length} added, ${evidence.outcomes.length} with a recorded outcome.`,
    '',
    'Your preference memory is unchanged.',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fa;">
<div style="max-width:600px;margin:24px auto;padding:26px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16181d;">
<div style="font:600 11px/1 -apple-system,sans-serif;color:#9aa1ac;letter-spacing:.14em;text-transform:uppercase;">huntley · weekly review · ${date}</div>
<h1 style="font-size:20px;margin:14px 0 10px;">No changes proposed</h1>
<ul style="margin:0 0 16px;padding-left:20px;color:#4b5563;">${reasons.map((r) => `<li>${r.replace(/[<>&]/g, '')}</li>`).join('')}</ul>
<p style="color:#6b7280;font-size:14px;">Over the last ${evidence.days} days: ${evidence.shown.length} roles shown, ${evidence.added.length} added, ${evidence.outcomes.length} with a recorded outcome.</p>
<p style="color:#6b7280;font-size:14px;">Your preference memory is unchanged.</p>
</div></body></html>`;

  if (dryRun) { process.stderr.write('\n' + text + '\n'); return; }
  const res = await createMailer(config.email).send({
    subject: `${config.digest.subject_prefix ?? 'huntley'} · weekly review: no changes proposed · ${date}`,
    html, text,
  });
  if (!res.ok) log.warn(`weekly notice could not be sent: ${res.error}`);
}

/**
 * `huntley weekly --apply <id>`: apply a stored proposal without clicking
 * APPROVE. Running the command is the approval. It goes through the same path
 * as a click — the same ledger, the same refusal of a proposal huntley has no
 * record of, the same backup — so the two cannot diverge.
 */
async function applyByHand(config, opts) {
  const id = opts.positional?.[0];
  if (!id || !/^[\w.-]+$/.test(id)) {
    log.error('usage: huntley weekly --apply <proposal-id>  (the id is in the proposal email and data/proposals/)');
    return 2;
  }
  const proposalPath = join(PATHS.proposals, `${id}.json`);
  if (!existsSync(proposalPath)) {
    log.error(`no proposal "${id}" in ${PATHS.proposals}`);
    return 1;
  }
  const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
  const problems = validateProposal(proposal);
  if (problems.length) {
    log.error(`proposal "${id}" cannot be applied:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  if (opts.dryRun) {
    log.info(`dry run: would apply ${proposal.changes.length} change(s) from "${id}":`);
    for (const c of proposal.changes) log.info(`  ${c.op} ${c.path ?? 'notes'} ${JSON.stringify(c.value)}`);
    return 0;
  }
  const applied = await applyApprovals([{ status: 'approved', proposal_id: id, approved_at: new Date().toISOString() }], config);
  if (!applied) log.warn(`"${id}" was not applied — it is already in ${join(PATHS.proposals, 'applied.jsonl')}, or applying it failed (see above)`);
  return applied ? 0 : 1;
}

export { gatherEvidence };
