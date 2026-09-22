// Per-unit coverage records. complete means the available API scope was
// exhausted, not that closed historical jobs exist.
export const UNIT_STATUSES = ['complete', 'partial', 'failed', 'unsupported'];

export function unitKey(kind, identity) {
  const id = String(identity ?? '').replace(/\/+$/, '').toLowerCase();
  return `${kind}:${id || 'unknown'}`;
}

export function coverageUnit({
  key,
  requestedSince = null,
  requestedUntil = null,
  coveredThrough = null,
  status = 'failed',
  pagesFetched = 0,
  recordsFetched = 0,
  continuation = null,
  limitations = [],
  errors = [],
} = {}) {
  if (!UNIT_STATUSES.includes(status)) {
    throw new Error(`unknown coverage status ${JSON.stringify(status)}`);
  }
  return {
    key: String(key),
    requestedSince: isoOrNull(requestedSince),
    requestedUntil: isoOrNull(requestedUntil),
    coveredThrough: isoOrNull(coveredThrough ?? (status === 'complete' ? requestedUntil : null)),
    status,
    pagesFetched: Number(pagesFetched) || 0,
    recordsFetched: Number(recordsFetched) || 0,
    continuation: continuation ?? null,
    limitations: [...(limitations ?? [])],
    errors: [...(errors ?? [])],
  };
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function postingTimeMs(postedAt) {
  if (postedAt == null || postedAt === '') return null;
  const raw = String(postedAt);
  // Date-only values are midnight UTC; treat them as the end of that UTC day
  // so a same-day card is not older than a noon window start.
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? Date.parse(`${raw}T23:59:59.999Z`)
    : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function canAdvanceCheckpoint(unit) {
  if (!unit) return false;
  if (unit.status === 'complete') return true;
  // Date-sorted partial results may advance to the oldest posting actually fetched.
  if (unit.status === 'partial' && unit.coveredThrough && !(unit.errors ?? []).length) return true;
  return false;
}

/** Identities (the part after `kind:`) for units of `kind` that completed. */
export function completeUnitIdentities(units, kind) {
  const prefix = `${kind}:`;
  return (units ?? [])
    .filter((u) => u?.status === 'complete' && String(u.key).startsWith(prefix))
    .map((u) => String(u.key).slice(prefix.length));
}

export function summarizeCoverage(units = []) {
  const counts = { complete: 0, partial: 0, failed: 0, unsupported: 0 };
  for (const unit of units) {
    if (counts[unit.status] != null) counts[unit.status]++;
    else counts.failed++;
  }
  const incomplete = units.filter((u) => u.status !== 'complete');
  return {
    total: units.length,
    ...counts,
    incomplete,
    retrievalComplete: units.length === 0 || incomplete.length === 0,
  };
}

/**
 * Lines to print after collection: a status tally, then up to `maxFailures`
 * failed/unsupported units with their first error. Callers pass `log` so this
 * module stays free of I/O.
 */
export function formatCoverageSummary(units = [], { maxFailures = 10 } = {}) {
  const summary = summarizeCoverage(units);
  const failing = (units ?? []).filter((u) => u.status === 'failed' || u.status === 'unsupported');
  const lines = [{
    level: 'info',
    message: `coverage ${summary.complete} complete · ${summary.partial} partial · ${summary.failed} failed · ${summary.unsupported} unsupported (${summary.total} units)`,
  }];
  for (const u of failing.slice(0, maxFailures)) {
    const err = (u.errors ?? [])[0] ?? u.status;
    lines.push({ level: 'error', message: `${u.key} — ${err}` });
  }
  if (failing.length > maxFailures) {
    lines.push({ level: 'error', message: `… ${failing.length - maxFailures} more failing unit(s)` });
  }
  return { summary, failing, lines };
}

export function logCoverageSummary(units, logger, opts = {}) {
  const { lines, summary } = formatCoverageSummary(units, opts);
  for (const line of lines) (logger[line.level] ?? logger.info)(line.message);
  return summary;
}

/** Keys that were `failed` in every one of the last `consecutive` unit lists. */
export function unitsFailedAcrossRuns(unitLists = [], { consecutive = 3 } = {}) {
  if (unitLists.length < consecutive) return [];
  const recent = unitLists.slice(-consecutive);
  const keys = new Set(
    (recent[0] ?? []).filter((u) => u?.status === 'failed').map((u) => u.key),
  );
  for (const units of recent.slice(1)) {
    const failed = new Set((units ?? []).filter((u) => u?.status === 'failed').map((u) => u.key));
    for (const key of [...keys]) if (!failed.has(key)) keys.delete(key);
  }
  return [...keys];
}

/** A `--no-scan` replay writes a manifest with no units; it is not a collection run. */
export function isCollectionManifest(manifest) {
  if (!manifest || manifest.replay) return false;
  const units = manifest.coverage?.units;
  return Array.isArray(units) && units.length > 0;
}

/** Unit lists from the last `consecutive` real collection runs, oldest first. */
export function collectionUnitLists(manifests = [], { consecutive = 3 } = {}) {
  return manifests
    .filter(isCollectionManifest)
    .slice(-consecutive)
    .map((m) => m.coverage.units);
}
