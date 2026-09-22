// Durable catch-up state: progress checkpoints, role ledger, run artifacts,
// and an idempotent commit journal replayed on startup.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PATHS } from '../lib/paths.mjs';
import { atomicWriteJson, atomicWriteFile, readJson, csvEscape } from './fs.mjs';
import { canAdvanceCheckpoint } from './coverage.mjs';
import { atsIdentity, jobId } from '../dedupe.mjs';
import { canonicalUrl, companyKey, titleKey } from '../normalize.mjs';

export const PROGRESS_SCHEMA = 1;
export const ROLES_SCHEMA = 1;
export const COMMIT_SCHEMA = 1;

export const crashPoints = { next: null };

export function crash(point) {
  if (crashPoints.next === point) {
    crashPoints.next = null;
    const err = new Error(`crash-injected:${point}`);
    err.injected = true;
    err.point = point;
    throw err;
  }
}

export function newCatchupRunId(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomUUID()}`;
}

export function runDirFor(runId, { dryRun = false } = {}) {
  return join(PATHS.runs, dryRun ? 'preview' : '', runId);
}

export function progressPath() { return join(PATHS.data, 'progress.json'); }
export function rolesPath() { return join(PATHS.data, 'roles.json'); }

function emptyProgress() {
  return {
    schema: PROGRESS_SCHEMA,
    units: {},
    committedRunIds: [],
    pendingEmail: null,
    pendingEmails: [],
    migration: null,
  };
}

function emptyRoles() {
  return { schema: ROLES_SCHEMA, roles: {}, aliases: {} };
}

export function loadProgress() {
  const path = progressPath();
  if (!existsSync(path)) return emptyProgress();
  const doc = readJson(path);
  if (doc?.schema !== PROGRESS_SCHEMA) {
    throw new Error(`Unsupported progress schema ${JSON.stringify(doc?.schema)} in ${path}. Refusing to reset history.`);
  }
  return {
    ...emptyProgress(),
    ...doc,
    units: doc.units ?? {},
    committedRunIds: doc.committedRunIds ?? [],
    pendingEmails: normalizePendingEmails(doc),
    pendingEmail: normalizePendingEmails(doc)[0] ?? null,
  };
}

function normalizePendingEmails(doc) {
  if (Array.isArray(doc?.pendingEmails)) {
    return doc.pendingEmails.filter((item) => item?.runId);
  }
  if (doc?.pendingEmail?.runId) return [doc.pendingEmail];
  return [];
}

export function pendingEmailQueue(progress) {
  return normalizePendingEmails(progress);
}

export function enqueuePendingEmail(progress, item) {
  const queue = pendingEmailQueue(progress);
  if (!item?.runId) return queue;
  if (queue.some((e) => e.runId === item.runId)) {
    progress.pendingEmails = queue;
    progress.pendingEmail = queue[0] ?? null;
    return queue;
  }
  queue.push(item);
  progress.pendingEmails = queue;
  progress.pendingEmail = queue[0] ?? null;
  return queue;
}

export function dequeuePendingEmail(progress, runId) {
  const queue = pendingEmailQueue(progress).filter((e) => e.runId !== runId);
  progress.pendingEmails = queue;
  progress.pendingEmail = queue[0] ?? null;
  return queue;
}

export function saveProgress(progress) {
  atomicWriteJson(progressPath(), progress);
}

export function loadRoles() {
  const path = rolesPath();
  if (!existsSync(path)) return emptyRoles();
  const doc = readJson(path);
  if (doc?.schema !== ROLES_SCHEMA) {
    throw new Error(`Unsupported roles schema ${JSON.stringify(doc?.schema)} in ${path}. Refusing to reset history.`);
  }
  const store = { ...emptyRoles(), ...doc, roles: doc.roles ?? {}, aliases: doc.aliases ?? {} };
  compactRoles(store);
  return store;
}

export function saveRoles(roles) {
  compactRoles(roles);
  atomicWriteJson(rolesPath(), roles);
}

export function preferencesFingerprint(prefs) {
  return createHash('sha256').update(JSON.stringify(prefs ?? {})).digest('hex').slice(0, 16);
}

export function identityKeys(job) {
  const keys = [];
  if (job?.id) keys.push(`id:${job.id}`);
  if (job?.url) keys.push(`u:${canonicalUrl(job.url)}`);
  const ats = job?.url ? atsIdentity(job.url) : null;
  if (ats) keys.push(`a:${ats}`);
  for (const url of job?.altUrls ?? []) keys.push(`u:${canonicalUrl(url)}`);
  for (const alias of job?.aliases ?? []) keys.push(String(alias));
  return [...new Set(keys.filter(Boolean))];
}

function lookupRole(store, job) {
  for (const key of identityKeys(job)) {
    const id = store.aliases[key];
    if (id && store.roles[id]) return store.roles[id];
  }
  return null;
}

function indexAliases(store, role) {
  for (const key of identityKeys(role.job ? { ...role.job, id: role.id, aliases: role.aliases } : role)) {
    store.aliases[key] = role.id;
  }
}

export function isOpenDecision(decision) {
  return decision === 'pending' || decision === 'unscored' || decision == null || decision === '';
}

/** Descriptions live in run raw.json; the ledger keeps them only while ranking may still run. */
export function stripJobDescription(job) {
  if (!job || (job.description == null && job.descriptionOrigin == null && job.descriptionFetchedAt == null)) return job;
  const { description, descriptionOrigin, descriptionFetchedAt, ...rest } = job;
  return rest;
}

export function compactRoles(store) {
  for (const role of Object.values(store?.roles ?? {})) {
    if (!isOpenDecision(role.decision) && role.job) role.job = stripJobDescription(role.job);
  }
  return store;
}

export function markRunsCommitted(progress, ids = []) {
  const list = progress.committedRunIds ?? [];
  for (const id of ids) {
    if (id && !list.includes(id)) list.push(id);
  }
  progress.committedRunIds = list;
  return list;
}

export function laterTimestamp(a, b) {
  const am = a != null && a !== '' ? Date.parse(a) : NaN;
  const bm = b != null && b !== '' ? Date.parse(b) : NaN;
  const aOk = Number.isFinite(am);
  const bOk = Number.isFinite(bm);
  if (aOk && bOk) return am >= bm ? a : b;
  if (bOk) return typeof b === 'string' ? b : new Date(bm).toISOString();
  if (aOk) return typeof a === 'string' ? a : new Date(am).toISOString();
  return b ?? a ?? null;
}

export function ingestJobs(store, jobs, { nowIso, runId } = {}) {
  const out = { new: 0, recovered: 0, updated: 0 };
  for (const job of jobs ?? []) {
    if (!job?.url || !job?.title) continue;
    const id = job.id || jobId(job);
    const incoming = { ...job, id };
    const existing = lookupRole(store, incoming) || store.roles[id];
    const aliases = [...new Set([
      ...(existing?.aliases ?? []),
      ...identityKeys(incoming),
      ...(incoming.altUrls ?? []).map((u) => `u:${canonicalUrl(u)}`),
    ])];
    if (!existing) {
      const decision = incoming.decision ?? 'pending';
      store.roles[id] = {
        id,
        aliases,
        sources: [incoming.source].filter(Boolean),
        firstObservedAt: incoming.firstObservedAt ?? nowIso,
        lastObservedAt: nowIso,
        postedAt: incoming.postedAt ?? null,
        firstSeenUpstream: incoming.firstSeenUpstream ?? incoming.firstSeen ?? null,
        job: isOpenDecision(decision) ? incoming : stripJobDescription(incoming),
        decision,
        reason: incoming.reason ?? null,
        rankStatus: incoming.rankStatus ?? null,
        score: incoming.score ?? null,
        publishedRunIds: incoming.publishedRunIds ?? [],
        emailedRunIds: incoming.emailedRunIds ?? [],
        preferencesFingerprint: incoming.preferencesFingerprint ?? null,
        provenance: incoming.timestampProvenance ?? null,
        collectedRunId: runId,
      };
      indexAliases(store, store.roles[id]);
      out.new++;
      continue;
    }
    const role = existing;
    role.aliases = aliases;
    role.sources = [...new Set([...(role.sources ?? []), incoming.source].filter(Boolean))];
    role.lastObservedAt = nowIso;
    role.postedAt = role.postedAt ?? incoming.postedAt ?? null;
    role.firstSeenUpstream = role.firstSeenUpstream ?? incoming.firstSeenUpstream ?? incoming.firstSeen ?? null;
    const merged = { ...role.job, ...incoming, id: role.id, altUrls: [...new Set([...(role.job?.altUrls ?? []), ...(incoming.altUrls ?? []), incoming.url === role.job?.url ? null : incoming.url].filter(Boolean))] };
    role.job = isOpenDecision(role.decision) ? merged : stripJobDescription(merged);
    if (role.decision === 'pending' || !role.decision) out.recovered++;
    else out.updated++;
    indexAliases(store, role);
  }
  return out;
}

/**
 * Apply a run's persisted publication decisions to the ledger. Idempotent.
 * Used when intent was saved before the ledger write, then the process died.
 */
export function applyRunDecisions(store, runDir, { runId } = {}) {
  const path = join(runDir, 'roles.json');
  if (!existsSync(path)) return false;
  let rows;
  try { rows = readJson(path); } catch { return false; }
  if (!Array.isArray(rows)) return false;
  let changed = false;
  for (const row of rows) {
    if (!row?.id) continue;
    const role = store.roles[row.id];
    if (!role) continue;
    if (row.decision === 'eligible' || row.decision === 'published') {
      const published = role.publishedRunIds ?? [];
      if (role.decision === 'published' && runId && published.includes(runId)) continue;
      role.decision = 'published';
      role.score = row.score ?? role.score;
      role.rankStatus = row.rankStatus ?? role.rankStatus;
      role.reason = row.reason ?? role.reason;
      if (runId) role.publishedRunIds = [...new Set([...published, runId])];
      if (role.job) role.job = stripJobDescription(role.job);
      changed = true;
    } else if (row.decision === 'below_threshold' || row.decision === 'rejected') {
      if (role.decision === 'pending' || role.decision === 'unscored' || !role.decision) {
        role.decision = row.decision;
        role.reason = row.reason ?? role.reason;
        role.score = row.score ?? role.score;
        role.rankStatus = row.rankStatus ?? role.rankStatus;
        if (role.job) role.job = stripJobDescription(role.job);
        changed = true;
      }
    }
  }
  return changed;
}

export function loadEmailPayload(runDir) {
  const path = join(runDir, 'email.json');
  if (!existsSync(path)) return null;
  try {
    const doc = readJson(path);
    if (!doc?.html) return null;
    return { subject: doc.subject, html: doc.html, text: doc.text ?? '' };
  } catch {
    return null;
  }
}

export function writeEmailPayload(runDir, { subject, html, text }) {
  atomicWriteJson(join(runDir, 'email.json'), { subject, html, text });
}

export function pendingRoles(store) {
  return Object.values(store.roles).filter((role) => {
    if (role.decision === 'legacy_processed' || role.decision === 'actioned') return false;
    if ((role.publishedRunIds ?? []).length) return false;
    if (role.decision === 'rejected' || role.decision === 'below_threshold') return false;
    return role.decision === 'pending' || role.decision === 'unscored' || !role.decision;
  });
}

export function applyCheckpoints(progress, units, runId) {
  const advanced = [];
  const held = [];
  for (const unit of units ?? []) {
    if (!unit?.key) continue;
    const prev = progress.units[unit.key] ?? {};
    if (canAdvanceCheckpoint(unit)) {
      progress.units[unit.key] = {
        ...prev,
        coveredThrough: laterTimestamp(prev.coveredThrough, unit.coveredThrough),
        status: unit.status,
        lastRunId: runId,
        limitations: unit.limitations ?? [],
      };
      advanced.push(unit.key);
    } else {
      const heldUnit = {
        ...prev,
        status: unit.status,
        lastRunId: runId,
        continuation: unit.continuation ?? prev.continuation ?? null,
        limitations: unit.limitations ?? prev.limitations ?? [],
        errors: unit.errors ?? [],
      };
      // Relevance-ranked freehire search cannot certify a time boundary.
      // Drop a leftover coveredThrough so the window cannot keep widening.
      if (unit.status === 'partial' && !unit.coveredThrough && String(unit.key).startsWith('freehire:') && !String(unit.key).startsWith('freehire_feed:')) {
        delete heldUnit.coveredThrough;
      }
      progress.units[unit.key] = heldUnit;
      held.push(unit.key);
    }
  }
  return { advanced, held };
}

export function writeCommit(runDir, intent) {
  atomicWriteJson(join(runDir, 'commit.json'), { schema: COMMIT_SCHEMA, ...intent });
}

export function readCommit(runDir) {
  const path = join(runDir, 'commit.json');
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function listRunDirs({ includePreview = false } = {}) {
  const dirs = [];
  if (!existsSync(PATHS.runs)) return dirs;
  const walk = (root, preview) => {
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch { continue; }
      if (name === 'preview') continue;
      if (existsSync(join(path, 'manifest.json')) || existsSync(join(path, 'raw.json')) || existsSync(join(path, 'commit.json'))) {
        dirs.push({ id: name, path, preview });
      }
    }
  };
  walk(PATHS.runs, false);
  if (includePreview) walk(join(PATHS.runs, 'preview'), true);
  return dirs.sort((a, b) => a.id.localeCompare(b.id));
}

export function replayUnfinishedCommits({ apply } = {}) {
  const unfinished = [];
  for (const run of listRunDirs()) {
    const commit = readCommit(run.path);
    if (!commit || commit.phase === 'done') continue;
    unfinished.push({ ...run, commit });
    apply?.(run, commit);
  }
  return unfinished;
}

export function writeManifest(runDir, manifest) {
  atomicWriteJson(join(runDir, 'manifest.json'), manifest);
}

export function writeRolesExport(runDir, rows) {
  atomicWriteJson(join(runDir, 'roles.json'), rows);
  const header = ['id', 'url', 'title', 'company', 'location', 'source', 'postedAt', 'decision', 'reason', 'score', 'rankStatus'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((key) => csvEscape(row[key])).join(','));
  }
  atomicWriteFile(join(runDir, 'roles.csv'), `${lines.join('\n')}\n`);
}

export function latestNonPreviewSnapshot() {
  const dirs = listRunDirs().filter((d) => existsSync(join(d.path, 'raw.json')));
  if (dirs.length) {
    const latest = dirs.at(-1);
    return {
      id: latest.id,
      path: join(latest.path, 'raw.json'),
      jobs: readJson(join(latest.path, 'raw.json')),
      manifest: existsSync(join(latest.path, 'manifest.json')) ? readJson(join(latest.path, 'manifest.json')) : null,
    };
  }
  if (!existsSync(PATHS.runs)) return null;
  const legacy = readdirSync(PATHS.runs)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-raw\.json$/.test(f))
    .sort();
  if (!legacy.length) return null;
  const file = legacy.at(-1);
  return {
    id: file.replace(/-raw\.json$/, ''),
    path: join(PATHS.runs, file),
    jobs: JSON.parse(readFileSync(join(PATHS.runs, file), 'utf8')),
    manifest: null,
    legacy: true,
  };
}

export function loadSnapshotById(runId) {
  if (!runId) return latestNonPreviewSnapshot();
  const dir = join(PATHS.runs, runId);
  if (existsSync(join(dir, 'raw.json'))) {
    return {
      id: runId,
      path: join(dir, 'raw.json'),
      jobs: readJson(join(dir, 'raw.json')),
      manifest: existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : null,
    };
  }
  const legacy = join(PATHS.runs, `${runId}-raw.json`);
  if (existsSync(legacy)) {
    return { id: runId, path: legacy, jobs: JSON.parse(readFileSync(legacy, 'utf8')), manifest: null, legacy: true };
  }
  const dateLegacy = join(PATHS.runs, `${runId}.json`);
  if (existsSync(dateLegacy)) {
    return { id: runId, path: dateLegacy, jobs: JSON.parse(readFileSync(dateLegacy, 'utf8')), manifest: null, legacy: true };
  }
  return null;
}

export function ensureRunDir(runId, { dryRun = false } = {}) {
  const path = runDirFor(runId, { dryRun });
  mkdirSync(path, { recursive: true });
  return path;
}

export { emptyProgress, emptyRoles };
