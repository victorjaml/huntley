// One-time import of legacy seen/shown/raw/shortlist state into the catch-up
// ledger. Automatic, versioned, idempotent, non-destructive. Never synthesizes
// unit checkpoints from runs.jsonl.
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import {
  loadProgress, saveProgress, loadRoles, saveRoles, ingestJobs,
  PROGRESS_SCHEMA,
} from './catchup.mjs';
import { jobId } from '../dedupe.mjs';
import { isHeuristicStatus, isModelScore } from '../rank/validate.mjs';

const MIGRATION_VERSION = 1;

function backupLegacy(backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const copied = [];
  for (const rel of ['seen.tsv', 'shortlist.jsonl', 'runs/runs.jsonl']) {
    const from = join(PATHS.data, rel);
    if (!existsSync(from)) continue;
    const to = join(backupDir, rel.replaceAll('/', '_'));
    copyFileSync(from, to);
    copied.push(rel);
  }
  if (existsSync(PATHS.runs)) {
    mkdirSync(join(backupDir, 'runs'), { recursive: true });
    for (const name of readdirSync(PATHS.runs)) {
      if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
      if (name === 'preview') continue;
      const from = join(PATHS.runs, name);
      try {
        copyFileSync(from, join(backupDir, 'runs', name));
        copied.push(`runs/${name}`);
      } catch { /* directories skipped */ }
    }
  }
  return copied;
}

function importShortlist(store, nowIso) {
  if (!existsSync(PATHS.shortlist)) return 0;
  let n = 0;
  for (const line of readFileSync(PATHS.shortlist, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const job = row.job ?? row;
    if (!job?.url && !job?.id) continue;
    const id = job.id || jobId(job);
    ingestJobs(store, [{ ...job, id, decision: 'actioned' }], { nowIso });
    if (store.roles[id]) store.roles[id].decision = 'actioned';
    n++;
  }
  return n;
}

function importSeen(store, nowIso) {
  if (!existsSync(PATHS.seen)) return { imported: 0, unresolved: 0 };
  let imported = 0;
  let unresolved = 0;
  for (const line of readFileSync(PATHS.seen, 'utf8').split('\n')) {
    const [id, date, company, title] = line.split('\t');
    if (!id?.trim()) continue;
    const key = id.trim();
    if (store.roles[key] || store.aliases[`id:${key}`]) {
      imported++;
      continue;
    }
    store.roles[key] = {
      id: key,
      aliases: [`id:${key}`],
      sources: [],
      firstObservedAt: date || nowIso,
      lastObservedAt: nowIso,
      postedAt: null,
      firstSeenUpstream: null,
      job: { id: key, url: null, title: title || '', company: company || '' },
      decision: 'legacy_processed',
      reason: 'imported from seen.tsv; original posting was not reconstructed',
      rankStatus: null,
      score: null,
      publishedRunIds: [],
      emailedRunIds: [],
      preferencesFingerprint: null,
      provenance: { seenDate: date || null },
    };
    store.aliases[`id:${key}`] = key;
    unresolved++;
    imported++;
  }
  return { imported, unresolved };
}

function hiddenByCap(job) {
  return job.rankStatus === 'skipped' || /capped|overflow|max_rows/i.test(String(job.reason ?? ''));
}

function shouldRequeue(job, minScore) {
  if (job?.inEmail === true) return false;
  if (hiddenByCap(job)) return true;
  if (job.heuristicOnly || isHeuristicStatus(job.rankStatus)) return true;
  const score = Number(job.score);
  if (Number.isFinite(score) && score >= minScore) return true;
  return false;
}

function belowThresholdDecision(job, minScore) {
  const score = Number(job.score);
  return isModelScore(job.rankStatus) && Number.isFinite(score) && score < minScore;
}

function importShown(store, nowIso, { minScore = 3 } = {}) {
  let queued = 0;
  if (!existsSync(PATHS.runs)) return queued;
  for (const name of readdirSync(PATHS.runs).filter((f) => f.endsWith('-shown.json')).sort()) {
    let record;
    try { record = JSON.parse(readFileSync(join(PATHS.runs, name), 'utf8')); } catch { continue; }
    const date = record.date || name.slice(0, 10);
    for (const job of record.shown ?? []) {
      if (!job?.id) continue;
      const existing = store.roles[job.id];
      const emailed = job.inEmail === true;
      const requeue = !emailed && shouldRequeue(job, minScore);
      if (!existing) {
        const decision = emailed
          ? 'published'
          : requeue
            ? 'pending'
            : (belowThresholdDecision(job, minScore) ? 'below_threshold' : 'legacy_processed');
        ingestJobs(store, [{ ...job, decision }], { nowIso });
        if (requeue) queued++;
      }
      const role = store.roles[job.id];
      if (!role) continue;
      if (emailed) {
        role.emailedRunIds = [...new Set([...(role.emailedRunIds ?? []), date])];
        role.publishedRunIds = [...new Set([...(role.publishedRunIds ?? []), date])];
        role.decision = role.decision === 'pending' ? 'published' : role.decision;
      } else if (requeue && role.decision !== 'published' && role.decision !== 'actioned') {
        if (job.url && job.title) {
          if (role.decision !== 'pending') queued++;
          role.decision = 'pending';
          role.job = { ...role.job, ...job };
          role.score = job.score ?? role.score;
          role.rankStatus = job.rankStatus ?? role.rankStatus;
        }
      } else if (belowThresholdDecision(job, minScore)
        && (role.decision === 'legacy_processed' || role.decision === 'pending' || !role.decision)) {
        role.decision = 'below_threshold';
        role.score = job.score ?? role.score;
        role.rankStatus = job.rankStatus ?? role.rankStatus;
        if (job.url && job.title) role.job = { ...role.job, ...job };
      }
    }
    for (const r of record.rejected ?? []) {
      if (!r?.id) continue;
      if (!store.roles[r.id]) {
        ingestJobs(store, [{ ...r.job, id: r.id, title: r.title, company: r.company, url: r.url, decision: 'rejected', reason: r.reason }], { nowIso });
      }
    }
  }
  return queued;
}

function importRawSnapshots(store, nowIso) {
  let n = 0;
  if (!existsSync(PATHS.runs)) return n;
  for (const name of readdirSync(PATHS.runs).filter((f) => f.endsWith('-raw.json') && !f.includes('dryrun')).sort()) {
    let jobs;
    try { jobs = JSON.parse(readFileSync(join(PATHS.runs, name), 'utf8')); } catch { continue; }
    if (!Array.isArray(jobs)) continue;
    const result = ingestJobs(store, jobs.map((j) => ({ ...j, decision: j.decision ?? 'pending' })), { nowIso });
    n += result.new + result.recovered;
  }
  return n;
}

/**
 * @returns {{ran: boolean, unresolvedSeen: number, queued: number, bootstrap: boolean}}
 */
export function migrateLegacy({ now = Date.now(), dryRun = false, minScore = 3 } = {}) {
  if (dryRun) return { ran: false, unresolvedSeen: 0, queued: 0, bootstrap: false };
  const progress = loadProgress();
  if (progress.migration?.version >= MIGRATION_VERSION) {
    return { ran: false, unresolvedSeen: progress.migration.unresolvedSeen ?? 0, queued: 0, bootstrap: false };
  }

  const nowIso = new Date(now).toISOString();
  const backupDir = join(PATHS.data, 'legacy-backup');
  const copied = backupLegacy(backupDir);
  const store = loadRoles();

  const shortlist = importShortlist(store, nowIso);
  const seen = importSeen(store, nowIso);
  const queued = importShown(store, nowIso, { minScore });
  const raw = importRawSnapshots(store, nowIso);

  saveRoles(store);
  progress.schema = PROGRESS_SCHEMA;
  progress.migration = {
    version: MIGRATION_VERSION,
    at: nowIso,
    backupDir,
    copied,
    shortlist,
    seenImported: seen.imported,
    unresolvedSeen: seen.unresolved,
    queuedFromCaps: queued,
    rawImported: raw,
    bootstrap: true,
  };
  saveProgress(progress);

  log.info(
    `catch-up bootstrap: imported ${seen.imported} seen identit${seen.imported === 1 ? 'y' : 'ies'} `
    + `(${seen.unresolved} without a surviving posting), ${queued} capped role(s) requeued. `
    + `Unit checkpoints start from collection.initial_lookback_days; pass --since to widen.`,
  );
  if (seen.unresolved) {
    log.warn(`${seen.unresolved} seen id(s) have no surviving decision/raw record and cannot be reconstructed; they stay suppressed.`);
  }
  return { ran: true, unresolvedSeen: seen.unresolved, queued, bootstrap: true };
}
