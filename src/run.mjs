// Ad hoc run with durable catch-up. `huntley daily` is a compatible alias.
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './lib/paths.mjs';
import { log } from './lib/log.mjs';
import { localToday } from './normalize.mjs';
import { dedupe } from './dedupe.mjs';
import { prefilter } from './rank/prefilter.mjs';
import { applyWatchlistBonus } from './rank/bonus.mjs';
import { capPerCompany } from './rank/per-company.mjs';
import { syncTracker } from './sheet/sync.mjs';
import { loadConfig } from './config.mjs';
import { rankJobs } from './rank/llm.mjs';
import { isModelScore } from './rank/validate.mjs';
import { renderDigest } from './digest/render.mjs';
import { createMailer } from './email/send.mjs';
import * as boardCollection from './sources/board-collection.mjs';
import { searchLinkedIn, linkedinUnitKeys } from './sources/linkedin.mjs';
import { searchWellfound, wellfoundUnitKeys } from './sources/wellfound.mjs';
import { searchFreehire, freehireUnitKeys } from './sources/freehire.mjs';
import { runLanes } from './lib/lanes.mjs';
import { runFundLane } from './sources/funds/lane.mjs';
import { runDatasetLane, runActiveBoardsLane, runFreehireFeedLane, runJobBoardLane, builtinBoards } from './sources/ats-lanes.mjs';
import { recordActiveBoards, evictInactiveBoards, markActiveBoardsScanned, activeBoards } from './sources/active-boards.mjs';
import { watchlistEntries, portfolioBoardEntries } from './sources/watchlist.mjs';
import { buildCompanyIdentity } from './identity.mjs';

/**
 * The board-name cache: what each board says its own employer is, kept across
 * runs. Identity evidence from this run's postings alone comes and goes with
 * whichever lanes happened to see a company; this does not. Missing or
 * unreadable is fine — identity just falls back to the postings.
 */
function loadBoardNames() {
  try {
    return existsSync(PATHS.boardNames) ? JSON.parse(readFileSync(PATHS.boardNames, 'utf8')) : null;
  } catch {
    return null;
  }
}
import { enrichDescriptions } from './sources/enrichment.mjs';
import { acquireLock } from './state/lock.mjs';
import {
  freezeClock, parseSinceInput, collectionSettings, planUnitWindow, sourceHorizonMs, planRunWindows,
} from './state/window.mjs';
import { summarizeCoverage, completeUnitIdentities, unitKey, logCoverageSummary } from './state/coverage.mjs';
import {
  newCatchupRunId, ensureRunDir, loadProgress, saveProgress, loadRoles, saveRoles,
  ingestJobs, applyCheckpoints, pendingRoles, writeCommit, writeManifest, writeRolesExport,
  loadSnapshotById, preferencesFingerprint, crash,
  listRunDirs, readCommit, enqueuePendingEmail, dequeuePendingEmail, pendingEmailQueue,
  applyRunDecisions, loadEmailPayload, writeEmailPayload, markRunsCommitted,
} from './state/catchup.mjs';
import { migrateLegacy } from './state/migrate.mjs';
import { atomicWriteFile, atomicWriteJson } from './state/fs.mjs';

const RUN_SUMMARY_SCHEMA = 2;

function validateRunOpts(opts) {
  if (opts.fresh && opts.noScan) throw new Error('refuse --fresh --no-scan: --fresh never clears history and --no-scan does not collect');
  if (opts.since && opts.noScan) throw new Error('refuse --since --no-scan: --since only applies to collection');
}

export async function runHuntley(config, opts = {}) {
  validateRunOpts(opts);
  ensureDirs();
  const clock = freezeClock(opts.now ?? Date.now());
  const date = localToday(new Date(clock.now));
  const started = clock.now;
  const dryRun = Boolean(opts.dryRun);
  const collection = collectionSettings(config);

  let explicitSinceMs = null;
  if (opts.since) {
    const parsed = parseSinceInput(opts.since, { now: clock.now });
    if (!parsed.ok) throw new Error(parsed.error);
    explicitSinceMs = parsed.ms;
  }

  const lock = acquireLock(PATHS.data);
  const warnings = [];
  const sources = [];
  const failedSources = [];
  let runId = newCatchupRunId(clock.now);
  let runDir = ensureRunDir(runId, { dryRun });
  let exitCode = 0;

  try {
    if (!dryRun) {
      for (const run of listRunDirs()) {
        const commit = readCommit(run.path);
        if (!commit || commit.phase === 'done' || commit.phase === 'published') continue;
        if (commit.phase === 'collected' && existsSync(join(run.path, 'raw.json'))) {
          log.info(`replaying unfinished collection ${run.id}`);
          const recovered = JSON.parse(readFileSync(join(run.path, 'raw.json'), 'utf8'));
          const store = loadRoles();
          ingestJobs(store, dedupe(recovered).jobs, { nowIso: clock.iso, runId: run.id });
          saveRoles(store);
          writeCommit(run.path, { phase: 'ingested', runId: run.id, at: new Date().toISOString() });
          const replayProgress = loadProgress();
          markRunsCommitted(replayProgress, [run.id]);
          saveProgress(replayProgress);
          boardCollection.pruneCommittedObservations({ committedRunIds: replayProgress.committedRunIds });
        }
      }
      const migration = migrateLegacy({ now: clock.now, minScore: config.rank?.min_score ?? 3 });
      if (migration.bootstrap) {
        warnings.push('catch-up bootstrap: unit checkpoints start from collection.initial_lookback_days (pass --since to widen)');
      }
    }

    if (config.sheet?.enabled) {
      try {
        const sync = await syncTracker(config, { dryRun });
        if (sync.degraded) warnings.push(sync.degraded);
        if (sync.applied) config = { ...config, preferences: loadConfig().preferences };
      } catch (err) {
        warnings.push(`tracker sync failed (${err.message}) — approvals were not applied`);
      }
    }

    const progress = loadProgress();
    let deferNewEmail = false;
    if (!dryRun) {
      recoverPublicationFromRuns();
      recoverPendingEmailsFromRuns(progress, { remote: emailDeliveryMode(config, opts) === 'remote' });
      if (pendingEmailQueue(progress).length) {
        const retried = await retryPendingEmails(config, progress, opts, warnings);
        if (retried === 'failed') {
          exitCode = 1;
          deferNewEmail = true;
        }
      }
    }

    const planned = plannedUnits(config, clock);
    const { summary: interval } = planRunWindows(planned, {
      progress, runStartedAt: clock.now, collection, explicitSinceMs,
    });
    const intervalSince = interval.since != null ? new Date(interval.since).toISOString() : 'unbounded';
    log.info(`interval ${intervalSince} → ${new Date(interval.until).toISOString()} (${collection.mode})`);

    let raw = [];
    let units = [];
    let replayMeta = null;
    let collectedRecoveredRunIds = [];

    if (opts.noScan) {
      const snap = loadSnapshotById(opts.runId);
      if (!snap) throw new Error(`--no-scan was passed but no snapshot exists${opts.runId ? ` for ${opts.runId}` : ''}`);
      raw = snap.jobs ?? [];
      replayMeta = { id: snap.id, interval: snap.manifest?.interval ?? null, legacy: Boolean(snap.legacy) };
      log.info(`replaying ${raw.length} posting(s) from snapshot ${snap.id}${snap.legacy ? ' (legacy date-keyed)' : ''}`);
      if (replayMeta.interval) log.info(`  original interval ${replayMeta.interval.since ?? '?'} → ${replayMeta.interval.until ?? '?'}`);
      sources.push('snapshot');
    } else {
      const collected = await collectAll(config, {
        warnings, sources, failedSources, dryRun, clock, progress, collection, explicitSinceMs, runId,
      });
      raw = collected.jobs;
      units = collected.units ?? [];
      collectedRecoveredRunIds = collected.recoveredRunIds ?? [];
      logCoverageSummary(units, log);
      atomicWriteJson(join(runDir, 'raw.json'), raw);
      if (!dryRun) writeFileSync(join(PATHS.runs, `${date}-raw.json`), JSON.stringify(raw, null, 2));
      writeCommit(runDir, { phase: 'collected', runId, at: clock.iso });
      crash('after-collected');
    }

    const { jobs: deduped, collapsed } = dedupe(raw);
    log.info(`${raw.length} posting(s) collected before dedupe`);
    log.info(`${deduped.length} unique after dedupe (${collapsed} collapsed)`);

    let store = loadRoles();
    if (!dryRun) {
      ingestJobs(store, deduped, { nowIso: clock.iso, runId });
      if (!opts.noScan) {
        applyCheckpoints(progress, units, runId);
        markRunsCommitted(progress, [runId, ...(collectedRecoveredRunIds ?? [])]);
        saveProgress(progress);
      }
      saveRoles(store);
      if (!opts.noScan) {
        boardCollection.pruneCommittedObservations({ committedRunIds: progress.committedRunIds });
      }
      writeCommit(runDir, { phase: 'ingested', runId, at: new Date().toISOString() });
      crash('after-ingest');
    } else {
      ingestJobs(store, deduped, { nowIso: clock.iso, runId });
    }

    const fp = preferencesFingerprint(config.preferences);
    const already = new Set();
    for (const role of Object.values(store.roles)) {
      // Published, actioned and legacy seen roles stay suppressed even when
      // preferences change. Re-evaluating rejected / below_threshold is explicit.
      if ((role.publishedRunIds ?? []).length) already.add(role.id);
      if (role.decision === 'legacy_processed' || role.decision === 'actioned') already.add(role.id);
      if (role.decision === 'rejected' || role.decision === 'below_threshold') already.add(role.id);
    }
    if (dryRun) {
      for (const id of loadSeen()) already.add(id);
    }
    const pending = dryRun ? deduped.filter((j) => !already.has(j.id)) : [
      ...pendingRoles(store).map((r) => r.job).filter((j) => j?.url && j?.title),
      ...deduped.filter((j) => !already.has(j.id)),
    ];
    // Resolve identity over the UNION, not just this run's haul: a role that
    // has been sitting in the store since an earlier run carries whatever name
    // its lane gave it then, and would otherwise dodge both the per-company cap
    // and the watchlist bonus that the fresh copies now get right.
    const pendingIdentity = buildCompanyIdentity(pending, { watchlist: watchlistEntries(), boardNames: loadBoardNames() });
    const pendingResolved = pendingIdentity.apply(pending);
    const watchKeys = await boardCollection.watchlistCompanyKeys();
    for (const job of pendingResolved) job.watchlist = job.watchlist || watchKeys.has(job.companyKey);

    const pendingDeduped = dedupe(pendingResolved).jobs.filter((j) => !already.has(j.id));
    if (deduped.length !== pendingDeduped.length) {
      log.info(`${deduped.length - pendingDeduped.length + (pending.length - deduped.length)} already processed`);
    }

    const filtered = prefilter(pendingDeduped, config.preferences);
    const { rejected } = filtered;
    log.info(`${filtered.kept.length} passed filters, ${rejected.length} filtered out`);

    const maxPerCompany = Number(config.rank.max_per_company ?? 0);
    const { kept, capped } = capPerCompany(filtered.kept, maxPerCompany);
    if (capped.length) log.info(`${capped.length} more role(s) at companies already represented ${maxPerCompany} time(s) — ranked later if budget remains`);

    let enrichTelemetry = null;
    const enrichStarted = Date.now();
    try {
      const enriched = await enrichDescriptions(kept, config.enrichment ?? {}, { maxLlm: config.rank.max_llm });
      kept.splice(0, kept.length, ...enriched.jobs);
      enrichTelemetry = enriched.telemetry;
    } catch (err) {
      warnings.push(`description enrichment failed (${err.message}) — ranking continues with available evidence`);
      enrichTelemetry = { error: err.message, ms: Date.now() - enrichStarted };
    }

    let ranked = kept;
    let rankCalls = 0;
    let rankTelemetry = null;
    const rankStarted = Date.now();
    if (kept.length > 0) {
      try {
        const result = await rankJobs(kept, { prefs: config.preferences }, {
          cli: config.rank.cli, model: config.rank.model, maxLlm: config.rank.max_llm,
          batchSize: config.rank.batch_size, concurrency: config.rank.concurrency,
          timeoutMs: config.rank.timeout_ms, totalTimeoutMs: config.rank.total_timeout_ms,
          cache: config.rank.cache, runDir,
        });
        ranked = result.jobs;
        rankCalls = result.calls;
        rankTelemetry = result.telemetry;
        if (result.degraded) warnings.push(result.degraded);
      } catch (err) {
        warnings.push(`ranking failed entirely (${err.message}) — roles are ordered by heuristic`);
        ranked = kept.map((j) => ({ ...j, score: null, heuristicOnly: true, rankStatus: 'failed', failureReason: 'cli_error' }));
      }
    }

    ranked = applyWatchlistBonus(ranked, config.rank.watchlist_bonus ?? 0.5);
    const minScore = config.rank.min_score ?? 0;
    const scored = ranked.filter((j) => isModelScore(j.rankStatus));
    const belowThreshold = scored.filter((j) => j.score != null && j.score < minScore);
    const eligible = scored.filter((j) => j.score != null && j.score >= minScore);
    const rankedUnscored = ranked.filter((j) => !isModelScore(j.rankStatus));
    const unscored = [...capped, ...rankedUnscored];
    eligible.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    if (!dryRun && !opts.noScan) {
      const added = recordActiveBoards(eligible.filter((j) => !j.heuristicOnly), { path: PATHS.activeBoards, date });
      if (added) log.info(`${added} board(s) added to the active boards`);
      if (config.sources.active_boards?.enabled) {
        const scanned = completeUnitIdentities(units, 'active_boards');
        const evicted = evictInactiveBoards({
          path: PATHS.activeBoards,
          withinDays: config.sources.active_boards?.within_days ?? 90,
          today: date,
          scanned,
        });
        if (evicted) log.info(`evicted ${evicted} inactive board(s) after verified catch-up scan`);
        markActiveBoardsScanned({ path: PATHS.activeBoards, urls: scanned, date });
      }
    }

    const emailJobs = eligible.slice(0, config.digest.max_rows ?? 40);
    if (eligible.length > emailJobs.length) {
      warnings.push(`${eligible.length - emailJobs.length} further match(es) above the threshold are in the complete local report (email capped by digest.max_rows)`);
    }

    const coverage = summarizeCoverage(units);
    const coverageNotes = coverage.incomplete.map((u) => `${u.key}: ${u.status}${(u.limitations ?? [])[0] ? ` (${u.limitations[0]})` : ''}`);
    if (!coverage.retrievalComplete) exitCode = Math.max(exitCode, 2);
    if (rankedUnscored.length) exitCode = Math.max(exitCode, 2);

    const stats = {
      schemaVersion: RUN_SUMMARY_SCHEMA,
      raw: raw.length, scanned: deduped.length, collapsed, filtered: rejected.length,
      cappedPerCompany: capped.length, maxPerCompany, belowThreshold: belowThreshold.length, minScore,
      sources, failedSources, rankCalls, ranking: rankTelemetry, enrichment: enrichTelemetry,
      descriptionCoverage: {
        eligible: kept.length,
        eligibleWithDescription: kept.filter((j) => j.description).length,
        rankedModelOrCache: ranked.filter((j) => j.rankStatus === 'model' || j.rankStatus === 'cache').length,
        rankedModelOrCacheWithDescription: ranked.filter((j) => (j.rankStatus === 'model' || j.rankStatus === 'cache') && j.description).length,
      },
      rejectionSample: rejected.slice(0, 4).map((r) => ({ title: `${r.job.title} @ ${r.job.company}`, reason: r.reason })),
      newCount: pendingDeduped.length,
      recovered: 0,
      pending: unscored.length,
    };

    const reportPath = join(runDir, 'report.html');
    const { html, text, headline } = renderDigest({
      jobs: eligible, stats, date, warnings, config, unscored, belowThreshold, reportPath, coverageNotes,
    });
    const emailRender = renderDigest({
      jobs: emailJobs, stats, date, warnings, config, unscored: [], reportPath, coverageNotes,
    });
    atomicWriteFile(join(runDir, 'report.html'), html);
    atomicWriteFile(join(runDir, 'report.txt'), text);
    writeRolesExport(runDir, [
      ...eligible.map((j) => ({ ...j, decision: 'eligible' })),
      ...unscored.map((j) => ({ ...j, decision: 'unscored', reason: j.reason ?? 'ranking budget or per-company cap' })),
      ...belowThreshold.map((j) => ({ ...j, decision: 'below_threshold' })),
      ...rejected.map((r) => ({ ...r.job, decision: 'rejected', reason: r.reason })),
    ]);
    crash('after-report');

    const subject = `${config.digest.subject_prefix ?? 'huntley'} · ${headline} · ${date}`;
    let sent = false;
    let delivery = dryRun ? 'preview' : 'skipped';
    const skipEmail = eligible.length === 0 && emailJobs.length === 0 && !config.digest.send_on_zero_matches;
    const remoteEmail = !dryRun && !skipEmail && emailDeliveryMode(config, opts) === 'remote';

    log.info(`new ${pendingDeduped.length} · filtered ${rejected.length} · eligible ${eligible.length} · unscored ${unscored.length}`);
    log.info(`complete report ${join(runDir, 'report.html')}`);
    log.info(`raw archive ${join(runDir, 'raw.json')}`);
    if (coverageNotes.length) log.info(`coverage gaps: ${coverageNotes.join('; ')}`);

    if (!dryRun && remoteEmail) {
      writeEmailPayload(runDir, {
        subject,
        html: emailRender.html,
        text: `${emailRender.text}\n\nComplete local report: ${reportPath}\n`,
      });
      enqueuePendingEmail(progress, { runId, subject, at: new Date().toISOString() });
      saveProgress(progress);
      writeCommit(runDir, { phase: 'email-pending', runId, at: new Date().toISOString(), email: true });
    }

    if (!dryRun) {
      store = loadRoles();
      const publish = (job, decision, extra = {}) => {
        const role = store.roles[job.id] ?? { id: job.id, aliases: [], sources: [], publishedRunIds: [], emailedRunIds: [], job };
        role.job = { ...role.job, ...job };
        role.decision = decision;
        role.reason = extra.reason ?? job.why ?? null;
        role.rankStatus = job.rankStatus ?? null;
        role.score = job.score ?? null;
        role.preferencesFingerprint = fp;
        if (decision === 'eligible' || decision === 'published') {
          role.publishedRunIds = [...new Set([...(role.publishedRunIds ?? []), runId])];
          role.decision = 'published';
        }
        store.roles[job.id] = role;
      };
      for (const job of eligible) publish(job, 'published');
      for (const job of belowThreshold) publish(job, 'below_threshold', { reason: `score ${job.score} below ${minScore}` });
      for (const r of rejected) publish(r.job, 'rejected', { reason: r.reason });
      for (const job of unscored) {
        const role = store.roles[job.id] ?? { id: job.id, aliases: [], publishedRunIds: [], emailedRunIds: [], job };
        role.job = { ...role.job, ...job };
        role.decision = 'unscored';
        role.rankStatus = job.rankStatus ?? 'skipped';
        store.roles[job.id] = role;
      }
      saveRoles(store);
      if (!remoteEmail) writeCommit(runDir, { phase: 'published', runId, at: new Date().toISOString(), email: false });
      crash('after-ledger');
    }
    crash('after-publish');

    if (dryRun) {
      writeFileSync(join(PATHS.digests, `${date}-dryrun.html`), html);
      writeFileSync(join(PATHS.digests, `${date}-dryrun.txt`), text);
      log.ok(`dry run — digest written to ${join(PATHS.digests, `${date}-dryrun.html`)} (not sent)`);
    } else if (skipEmail) {
      log.warn('zero matches and digest.send_on_zero_matches is false — not sending email; local summary committed');
    } else if (remoteEmail && deferNewEmail) {
      log.warn(`deferring email for ${runId} until the pending delivery succeeds`);
      exitCode = 1;
    } else {
      const mailer = opts.mailer ?? createMailer(config.email);
      const payload = loadEmailPayload(runDir) ?? {
        subject,
        html: emailRender.html,
        text: `${emailRender.text}\n\nComplete local report: ${reportPath}\n`,
      };
      let res;
      try {
        res = await mailer.send(payload);
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      if (res.ok) {
        sent = res.sent !== false;
        delivery = sent ? 'email' : 'console';
        if (sent) log.ok(`digest sent to ${config.email.to ?? config.identity.email}${res.id ? ` (${res.id})` : ''}`);
        else log.ok(`digest written locally (console transport)`);
        if (sent) {
          store = loadRoles();
          for (const job of emailJobs) {
            const role = store.roles[job.id];
            if (role) role.emailedRunIds = [...new Set([...(role.emailedRunIds ?? []), runId])];
          }
          saveRoles(store);
        }
        if (remoteEmail) {
          dequeuePendingEmail(progress, runId);
          saveProgress(progress);
        }
      } else {
        log.error(`digest NOT sent: ${res.error}`);
        enqueuePendingEmail(progress, { runId, subject, error: res.error, at: new Date().toISOString() });
        saveProgress(progress);
        exitCode = 1;
      }
    }

    // Capped roles were never sent to the model. Without an explicit status the
    // record defaulted them to rankStatus 'model' with unscored: false, so 78
    // held-back Google roles read as 78 model-scored ones.
    const cappedRecord = capped.map((job) => ({ ...job, rankStatus: 'capped', heuristicOnly: false }));
    writeShownRecord(date, [...ranked, ...cappedRecord], [...rejected, ...capped.map((job) => ({ job, reason: `more than ${maxPerCompany} roles at ${job.company}` }))], {
      reportIds: eligible.map((j) => j.id),
      emailIds: delivery === 'email' ? emailJobs.map((j) => j.id) : [],
      delivery,
      dryRun,
      runId,
    });
    writeRankTelemetry(date, rankTelemetry, { dryRun, runDir });
    if (!dryRun && (delivery === 'email' || delivery === 'console')) {
      markSeen([...eligible, ...belowThreshold], date);
    }

    const manifest = {
      runId, date, mode: collection.mode, dryRun,
      interval: {
        since: interval.since != null ? new Date(interval.since).toISOString() : null,
        until: new Date(interval.until).toISOString(),
      },
      coverage: { units, summary: coverage },
      status: exitCode === 0 ? 'ok' : exitCode === 2 ? 'partial' : 'failed',
      delivery, sent, reportPath, subject,
      replay: replayMeta,
    };
    writeManifest(runDir, manifest);
    writeCommit(runDir, { phase: 'done', runId, at: new Date().toISOString() });
    if (!dryRun) {
      appendFileSync(join(PATHS.runs, 'runs.jsonl'), `${JSON.stringify({ date, at: new Date().toISOString(), ...stats, sent, delivery, shown: emailJobs.length, eligible: eligible.length, ms: Date.now() - started, exitCode })}\n`);
    }

    stats.descriptionCoverage.displayed = emailJobs.length;
    stats.descriptionCoverage.displayedWithDescription = emailJobs.filter((j) => j.description).length;
    stats.descriptionCoverage.displayedMetadataOnly = emailJobs.filter((j) => !j.description).length;

    return {
      shown: emailJobs, eligible, unscored, stats, warnings, html, text, subject, sent, delivery,
      runId, runDir, reportPath, exitCode, coverage,
    };
  } finally {
    lock.release();
  }
}

async function retryPendingEmails(config, progress, opts = {}, warnings = []) {
  const queue = pendingEmailQueue(progress);
  if (!queue.length) return 'none';
  if (emailDeliveryMode(config, opts) !== 'remote') return 'none';
  const mailer = opts.mailer ?? createMailer(config.email);
  for (const pending of queue) {
    const dir = join(PATHS.runs, pending.runId);
    const payloadPath = join(dir, 'email.json');
    const payload = loadEmailPayload(dir);
    if (!payload) {
      const message = `pending email for ${pending.runId} is blocked: missing or unreadable payload at ${payloadPath}. Huntley will not retry report.html (that is the complete report, not the capped summary). Reconstruct email.json as {"subject","html","text"} for that run and re-run, or send the digest yourself and remove this pendingEmails entry from ${PATHS.progress}.`;
      log.error(message);
      warnings.push(message);
      return 'failed';
    }
    let res;
    try {
      res = await mailer.send({
        subject: payload.subject ?? pending.subject,
        html: payload.html,
        text: payload.text,
      });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res.ok) {
      log.error(`pending email retry failed for ${pending.runId}: ${res.error}`);
      return 'failed';
    }
    dequeuePendingEmail(progress, pending.runId);
    saveProgress(progress);
    writeCommit(dir, { phase: 'done', runId: pending.runId, at: new Date().toISOString(), delivery: 'email' });
    log.ok(`retried pending email for ${pending.runId}`);
  }
  return 'sent';
}

function recoverPublicationFromRuns() {
  for (const run of listRunDirs()) {
    const commit = readCommit(run.path);
    if (!commit || commit.phase === 'done' || commit.phase === 'collected') continue;
    const hasPayload = Boolean(loadEmailPayload(run.path));
    if (commit.phase === 'ingested' && !hasPayload) continue;
    if (commit.phase !== 'ingested' && commit.phase !== 'published' && commit.phase !== 'email-pending') continue;
    const store = loadRoles();
    if (applyRunDecisions(store, run.path, { runId: run.id })) saveRoles(store);
  }
}

function recoverPendingEmailsFromRuns(progress, { remote }) {
  if (!remote) return;
  let changed = false;
  for (const run of listRunDirs()) {
    const commit = readCommit(run.path);
    if (!commit || commit.phase === 'done' || commit.phase === 'collected') continue;
    const payload = loadEmailPayload(run.path);
    if (!payload) continue;
    if (commit.phase === 'published' && !commit.email) continue;
    if (commit.phase !== 'published' && commit.phase !== 'email-pending' && commit.phase !== 'ingested') continue;
    let manifest = null;
    try {
      if (existsSync(join(run.path, 'manifest.json'))) manifest = JSON.parse(readFileSync(join(run.path, 'manifest.json'), 'utf8'));
    } catch { manifest = null; }
    if (manifest?.delivery === 'email' || manifest?.delivery === 'console') continue;
    const before = pendingEmailQueue(progress).length;
    enqueuePendingEmail(progress, {
      runId: run.id,
      subject: payload.subject ?? manifest?.subject ?? `huntley · ${run.id}`,
      at: commit.at ?? new Date().toISOString(),
    });
    if (pendingEmailQueue(progress).length !== before) changed = true;
  }
  if (changed) saveProgress(progress);
}

function emailDeliveryMode(config, opts = {}) {
  if (opts.mailer) return 'remote';
  if (String(process.env.HUNTLEY_MOCK_EMAIL ?? '').toLowerCase() === 'true') return 'console';
  const provider = config.email?.provider ?? 'console';
  return provider === 'console' ? 'console' : 'remote';
}

function plannedUnits(config, clock) {
  const s = config.sources ?? {};
  const now = clock.now;
  const items = [];
  const boardHorizon = (days) => sourceHorizonMs(days ?? null, now);
  if (s.watchlist?.enabled) {
    for (const entry of watchlistEntries()) {
      items.push({ key: unitKey('watchlist', entry.careers_url), sourceHorizonMs: boardHorizon(s.watchlist.since_days) });
    }
  }
  if (s.portfolio_boards?.enabled) {
    for (const entry of portfolioBoardEntries()) {
      items.push({ key: unitKey('portfolio', entry.careers_url), sourceHorizonMs: boardHorizon(s.portfolio_boards.since_days) });
    }
  }
  if (s.active_boards?.enabled) {
    for (const board of activeBoards({ path: PATHS.activeBoards, today: localToday(new Date(now)), withinDays: s.active_boards.within_days ?? 90 })) {
      items.push({ key: unitKey('active_boards', board.careers_url), sourceHorizonMs: boardHorizon(s.active_boards.since_days ?? 3) });
    }
  }
  if (s.builtin?.enabled) {
    for (const board of builtinBoards(s.builtin)) {
      items.push({ key: unitKey('builtin', board.careers_url), sourceHorizonMs: boardHorizon(s.builtin.since_days ?? 7) });
    }
  }
  if (s.hackernews?.enabled) {
    items.push({ key: unitKey('hackernews', 'https://news.ycombinator.com/jobs'), sourceHorizonMs: null });
  }
  if (s.ats_dataset?.enabled) {
    items.push({ key: 'ats_dataset:manifest', sourceHorizonMs: sourceHorizonMs(s.ats_dataset.since_days ?? 3, now) });
  }
  if (s.freehire_feed?.enabled) {
    for (const country of s.freehire_feed.countries ?? ['us']) {
      items.push({ key: unitKey('freehire_feed', country), sourceHorizonMs: sourceHorizonMs(s.freehire_feed.open_within_days ?? 2, now) });
    }
  }
  if (s.linkedin?.enabled) {
    for (const key of linkedinUnitKeys(s.linkedin)) {
      items.push({ key, sourceHorizonMs: sourceHorizonMs(s.linkedin.jobage_days ?? 1, now) });
    }
  }
  if (s.wellfound?.enabled) {
    for (const key of wellfoundUnitKeys(s.wellfound)) {
      items.push({ key, sourceHorizonMs: sourceHorizonMs(s.wellfound.max_age_days ?? 14, now) });
    }
  }
  if (s.freehire?.enabled) {
    for (const key of freehireUnitKeys(s.freehire)) {
      items.push({ key, sourceHorizonMs: sourceHorizonMs(s.freehire.since_days ?? 2, now) });
    }
  }
  return items;
}

async function collectAll(config, { warnings, sources, failedSources, dryRun, clock, progress, collection, explicitSinceMs, runId }) {
  const s = config.sources;
  const now = clock.now;
  const catchup = { now, progress, collection, explicitSinceMs, runId };
  const watchlistKeys = await boardCollection.watchlistCompanyKeys();
  log.info(`watchlist: ${watchlistKeys.size} companies`);
  boardCollection.prepareScan(config.preferences, { dryRun });
  const wlEntries = watchlistEntries();
  const portfolioEntries = portfolioBoardEntries();
  const lanes = [];

  const boardOpts = (source, sinceDays, freshness = 'inventory') => ({
    sinceDays, sinceMs: null, untilMs: now, now, freshness, progress, collection, explicitSinceMs, runId, dryRun,
    prefs: config.preferences, source, watchlistKeys, unitKind: source,
  });

  if (s.watchlist?.enabled) {
    lanes.push({ name: 'watchlist', run: () => boardCollection.scanTracked({
      label: 'watchlist companies', entries: wlEntries, count: wlEntries.length, ...boardOpts('watchlist', s.watchlist.since_days ?? null),
    }) });
  }
  if (s.portfolio_boards?.enabled) {
    lanes.push({ name: 'portfolio_boards', run: () => boardCollection.scanTracked({
      label: 'VC portfolio boards', entries: portfolioEntries, count: portfolioEntries.length, ...boardOpts('portfolio', s.portfolio_boards.since_days ?? null),
    }) });
  }
  let fundMap = new Map();
  if (s.fund_portfolios?.enabled) {
    lanes.push({ name: 'fund_portfolios', run: () => runFundLane({
      prefs: config.preferences, settings: s.fund_portfolios, dryRun, watchlistKeys, ...catchup,
      onPlan: (plan) => { fundMap = plan.funds; warnings.push(...plan.warnings); },
    }) });
  }
  if (s.ats_dataset?.enabled) {
    const win = planUnitWindow({
      coveredThrough: progress.units?.['ats_dataset:manifest']?.coveredThrough,
      runStartedAt: now, initialLookbackDays: collection.initialLookbackDays, overlapHours: collection.overlapHours,
      explicitSinceMs, sourceHorizonMs: sourceHorizonMs(s.ats_dataset.since_days ?? 3, now), mode: collection.mode,
    });
    lanes.push({ name: 'ats_dataset', run: () => runDatasetLane({
      prefs: config.preferences, settings: s.ats_dataset, sweep: s.ats_sweep ?? {}, dryRun, watchlistKeys,
      warn: (w) => warnings.push(w), sinceMs: win.since, untilMs: win.until, ...catchup,
    }) });
  }
  if (s.freehire_feed?.enabled) {
    lanes.push({ name: 'freehire_feed', run: () => runFreehireFeedLane({
      prefs: config.preferences, settings: s.freehire_feed, now, untilMs: now, ...catchup,
    }) });
  }
  if (s.builtin?.enabled) {
    lanes.push({ name: 'builtin', run: () => runJobBoardLane({
      prefs: config.preferences, which: 'builtin', boards: builtinBoards(s.builtin), sinceDays: s.builtin.since_days ?? 7, dryRun, watchlistKeys, ...catchup,
    }) });
  }
  if (s.hackernews?.enabled) {
    lanes.push({ name: 'hackernews', run: () => runJobBoardLane({
      prefs: config.preferences, which: 'hackernews',
      boards: [{ name: 'Hacker News "Who is hiring?"', provider: 'hackernews', enabled: true, careers_url: 'https://news.ycombinator.com/jobs' }],
      sinceDays: null, dryRun, watchlistKeys, ...catchup,
    }) });
  }
  if (s.active_boards?.enabled) {
    lanes.push({ name: 'active_boards', run: () => runActiveBoardsLane({
      prefs: config.preferences, settings: s.active_boards, today: localToday(new Date(now)), dryRun, watchlistKeys, ...catchup,
    }) });
  }
  if (s.ats_sweep?.enabled) {
    const vendors = s.ats_sweep.ats ?? boardCollection.SWEEP_ATS;
    vendors.forEach((ats, i) => {
      lanes.push({ name: `ats_sweep:${ats}`, run: () => boardCollection.scanAtsSweep({
        ats, sinceDays: s.ats_sweep.since_days ?? 2, seeds: i === 0 ? (s.ats_sweep.seeds ?? []) : [],
        limit: s.ats_sweep.limit ?? null, timeoutMinutes: s.ats_sweep.timeout_minutes ?? 30,
        dryRun, prefs: config.preferences, watchlistKeys, ...catchup,
      }) });
    });
  }
  if (s.wellfound?.enabled) {
    lanes.push({ name: 'wellfound', run: async () => {
      const res = await searchWellfound({
        roles: s.wellfound.roles, locations: s.wellfound.locations,
        maxAgeDays: s.wellfound.max_age_days ?? 14, maxPages: s.wellfound.max_pages ?? 1,
        delayMs: s.wellfound.delay_ms ?? 6000, requestLimit: s.wellfound.request_limit ?? 100,
        today: localToday(new Date(now)), now, untilMs: now, ...catchup,
      });
      warnings.push(...(res.warnings ?? []));
      return res;
    } });
  }
  if (s.linkedin?.enabled) {
    lanes.push({ name: 'linkedin', run: () => searchLinkedIn({
      queries: s.linkedin.queries, locations: s.linkedin.locations, jobageDays: s.linkedin.jobage_days ?? 1,
      remote: s.linkedin.remote ?? null, maxPages: s.linkedin.max_pages ?? 1,
      delayMs: s.linkedin.delay_ms ?? 9000, requestLimit: s.linkedin.request_limit ?? 30,
      now, untilMs: now, ...catchup,
    }) });
  }
  if (s.freehire?.enabled) {
    lanes.push({ name: 'freehire', run: () => searchFreehire({
      queries: s.freehire.queries, locations: s.freehire.locations ?? [], remote: s.freehire.remote ?? null,
      sinceDays: s.freehire.since_days ?? 2, limit: s.freehire.limit ?? 50,
      maxPages: s.freehire.max_pages ?? 1,
      now, untilMs: now, ...catchup,
    }) });
  }

  log.step(`collecting from ${lanes.length} lane(s) at once: ${lanes.map((l) => l.name).join(', ')}`);
  const result = await runLanes(lanes);
  sources.push(...result.sources);
  failedSources.push(...result.failed);
  warnings.push(...result.warnings);
  const jobs = result.jobs;
  let recoveredRunIds = [];
  try {
    const recovered = boardCollection.collectRecoveryJobs({
      watchlistKeys, fundKeys: fundMap, sinceDays: null,
      excludeRunIds: progress.committedRunIds ?? [],
    });
    for (const job of recovered.jobs ?? recovered) jobs.push(job);
    recoveredRunIds = recovered.recoveredRunIds ?? [];
  } finally {
    boardCollection.endScan();
  }
  // One company, one identity, before anything counts companies. Lanes name
  // the same employer differently ("Reflection AI" from the watchlist,
  // "Reflection" from LinkedIn), which would otherwise multiply the
  // per-company cap and lose the watchlist bonus on whichever spelling does
  // not match watchlist.yml.
  const identity = buildCompanyIdentity(jobs, { watchlist: watchlistEntries(), boardNames: loadBoardNames() });
  const resolved = identity.apply(jobs);
  if (identity.merged) log.info(`  ${identity.merged} company name(s) merged onto the employer they belong to`);

  for (const job of resolved) job.watchlist = job.watchlist || watchlistKeys.has(job.companyKey);
  return { jobs: resolved, units: result.units ?? [], recoveredRunIds };
}

function writeRankTelemetry(date, telemetry, { dryRun = false, runDir = null } = {}) {
  if (!telemetry) return;
  const payload = {
    date, at: new Date().toISOString(),
    statusCounts: telemetry.statusCounts, failureReasons: telemetry.failureReasons,
    cache: telemetry.cache, calls: telemetry.calls, batches: telemetry.batches,
    promptChars: telemetry.promptChars, ms: telemetry.ms,
  };
  const suffix = dryRun ? '-rank.dryrun.json' : '-rank.json';
  writeFileSync(join(PATHS.runs, `${date}${suffix}`), JSON.stringify(payload, null, 2));
  if (runDir) atomicWriteJson(join(runDir, 'rank.json'), payload);
}

export function mergeShownRecords(previous, next) {
  const shown = new Map((previous.shown ?? []).map((j) => [j.id, j]));
  for (const j of next.shown ?? []) {
    const prior = shown.get(j.id);
    shown.set(j.id, (prior?.inEmail || prior?.publishedLocally) && !j.inEmail && !j.publishedLocally ? prior : j);
  }
  const rejected = new Map((previous.rejected ?? []).map((r) => [r.id, r]));
  for (const r of next.rejected ?? []) rejected.set(r.id, r);
  return { date: next.date, shown: [...shown.values()], rejected: [...rejected.values()], delivery: next.delivery ?? previous.delivery };
}

function writeShownRecord(date, ranked, rejected, { reportIds, emailIds, delivery, dryRun, runId = null }) {
  const inReport = new Set(reportIds);
  const inEmail = new Set(emailIds);
  const record = {
    date, delivery,
    shown: ranked.map((j) => ({
      runId,
      publishedLocally: inReport.has(j.id),
      inEmail: inEmail.has(j.id),
      inReport: inReport.has(j.id),
      id: j.id, url: j.url, title: j.title, company: j.company, companyKey: j.companyKey,
      location: j.location, workplace: j.workplace, source: j.source, sourceDetail: j.sourceDetail,
      postedAt: j.postedAt, watchlist: j.watchlist, score: j.score, modelScore: j.modelScore ?? j.score,
      bonus: j.bonus ?? 0, why: j.why, heuristicOnly: Boolean(j.heuristicOnly),
      rankStatus: j.rankStatus ?? (j.heuristicOnly ? 'failed' : 'model'),
      ...(j.failureReason ? { failureReason: j.failureReason } : {}),
      evidenceLevel: j.evidenceLevel ?? (j.description ? 'description' : 'metadata_only'),
      descriptionOrigin: j.descriptionOrigin ?? null,
      enrichmentOutcome: j.enrichmentOutcome ?? null,
      unscored: !isModelScore(j.rankStatus ?? (j.heuristicOnly ? 'failed' : 'model')),
    })),
    rejected: rejected.map((r) => ({
      runId, id: r.job.id, title: r.job.title, company: r.job.company, location: r.job.location, url: r.job.url, reason: r.reason,
    })),
  };
  if (dryRun) {
    writeFileSync(join(PATHS.runs, `${date}-shown.dryrun.json`), JSON.stringify(record, null, 2));
    return;
  }
  const path = join(PATHS.runs, `${date}-shown.json`);
  let previous = null;
  try { if (existsSync(path)) previous = JSON.parse(readFileSync(path, 'utf8')); } catch { previous = null; }
  writeFileSync(path, JSON.stringify(previous ? mergeShownRecords(previous, record) : record, null, 2));
}

function loadSeen() {
  if (!existsSync(PATHS.seen)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(PATHS.seen, 'utf8').split('\n')) {
    const id = line.split('\t')[0]?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function markSeen(jobs, date) {
  if (!jobs.length) return;
  const existing = loadSeen();
  const rows = jobs.filter((j) => j.id && !existing.has(j.id)).map((j) => `${j.id}\t${date}\t${j.company}\t${j.title}`);
  if (!rows.length) return;
  mkdirSync(PATHS.data, { recursive: true });
  appendFileSync(PATHS.seen, `${rows.join('\n')}\n`);
}

export async function runDaily(config, opts = {}) {
  return runHuntley(config, opts);
}

export { loadSeen };
