// Strict validation of model ranking rows.
//
// A usable result is a known expected id, a finite 0–5 score (no clamping), and
// a nonempty sanitized reason of at least 12 characters. Unknown ids, duplicate
// expected ids that disagree on score, null/string/out-of-range scores, and
// empty reasons are rejected without coercing. Duplicate expected ids that
// agree on score keep the first row. Valid siblings in a partial response are kept.

export const REASON_MIN = 12;
export const REASON_MAX = 220;

export const FAILURE_REASONS = Object.freeze([
  'timeout',
  'cli_unavailable',
  'cli_error',
  'parse_error',
  'not_returned',
  'id_mismatch',
  'duplicate_id',
  'score_not_number',
  'score_out_of_range',
  'reason_too_short',
]);

export const RANK_STATUSES = Object.freeze([
  'model',
  'cache',
  'over_budget',
  'past_deadline',
  'failed',
]);

export function sanitizeReason(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[|<>]/g, ' ')
    .trim()
    .slice(0, REASON_MAX);
}

/**
 * Validate one model row against the expected id set for its batch.
 * Duplicate detection is the caller's responsibility.
 * @returns {{ok: true, id: string, score: number, why: string}|{ok: false, id: string|null, failureReason: string}}
 */
export function validateModelRow(row, { expectedIds }) {
  const id = row?.id == null ? '' : String(row.id);
  if (!id || !expectedIds.has(id)) {
    return { ok: false, id: id || null, failureReason: 'not_returned' };
  }

  // Reject null, strings, and non-finite numbers — do not coerce.
  if (typeof row?.score !== 'number' || !Number.isFinite(row.score)) {
    return { ok: false, id, failureReason: 'score_not_number' };
  }
  if (row.score < 0 || row.score > 5) {
    return { ok: false, id, failureReason: 'score_out_of_range' };
  }

  const why = sanitizeReason(row?.why);
  if (why.length < REASON_MIN) {
    return { ok: false, id, failureReason: 'reason_too_short' };
  }

  return { ok: true, id, score: row.score, why };
}

/** Levenshtein distance, bailing out above `max` so a 16-char id is cheap. */
export function editDistance(a, b, max = 2) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  const n = left.length;
  const m = right.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[m];
}

/**
 * Map a batch of parsed rows onto expected job ids.
 * Unknown foreign ids are ignored for outcome accounting (they do not create
 * roles). Duplicate expected ids that disagree on score become failures;
 * copies that agree keep the first row and are counted as recovered. Missing
 * expected ids become failures.
 *
 * @param {unknown} parsed
 * @param {string[]} expectedIds
 * @returns {{byId: Map<string, {score: number, why: string}>, failures: Map<string, string>, recovered: Set<string>, parseFailed: boolean}}
 */
export function mapBatchResults(parsed, expectedIds) {
  const expected = new Set(expectedIds);
  const byId = new Map();
  const failures = new Map();
  const recovered = new Set();

  if (!Array.isArray(parsed)) {
    for (const id of expectedIds) failures.set(id, 'parse_error');
    return { byId, failures, recovered, parseFailed: true };
  }

  const seenIds = new Set();
  const foreignIds = [];
  for (const row of parsed) {
    const rawId = row?.id == null ? '' : String(row.id);
    // Foreign ids are rejected without creating outcomes, but kept so a
    // missing expected id that is a near-miss can be labelled id_mismatch.
    if (!rawId || !expected.has(rawId)) {
      if (rawId) foreignIds.push(rawId);
      continue;
    }

    if (seenIds.has(rawId)) {
      const existing = byId.get(rawId);
      const dup = validateModelRow(row, { expectedIds: expected });
      if (existing && dup.ok && existing.score === dup.score) {
        recovered.add(rawId);
        continue;
      }
      // A later copy after an invalid first overwrites that reason with
      // duplicate_id. Conservative: the role still fails.
      recovered.delete(rawId);
      byId.delete(rawId);
      failures.set(rawId, 'duplicate_id');
      continue;
    }
    seenIds.add(rawId);

    const result = validateModelRow(row, { expectedIds: expected });
    if (!result.ok) {
      failures.set(rawId, result.failureReason);
      continue;
    }
    failures.delete(rawId);
    byId.set(rawId, { score: result.score, why: result.why });
  }

  for (const id of expectedIds) {
    if (!byId.has(id) && !failures.has(id)) {
      const mismatch = foreignIds.some((f) => editDistance(f, id, 2) <= 2);
      failures.set(id, mismatch ? 'id_mismatch' : 'not_returned');
    }
  }

  return { byId, failures, recovered, parseFailed: false };
}

export function isHeuristicStatus(status) {
  return status === 'over_budget' || status === 'past_deadline' || status === 'failed';
}

/** Only model or cache scores may publish a role or mark it below threshold. */
export function isModelScore(status) {
  return status === 'model' || status === 'cache';
}
