// Running independent collection lanes at the same time.
//
// Every source — watchlist companies, VC portfolio boards, the ATS sweep,
// LinkedIn, freehire — only waits on the network, and none depends on another. They
// run in parallel and the run is as slow as the slowest one.
//
// Each lane is independently fallible: one board having a bad morning must not
// cost the others, so a failure is recorded against its lane and the rest carry
// on. Nothing is merged until every lane has settled.
//
// Lane.run may return a job array (legacy) or { jobs, errors, stats }. Health is
// based on completed / failed / aborted board counts — not on how many jobs
// survive title/freshness filters.

import { log } from './log.mjs';

/**
 * @param {unknown} value
 * @returns {{jobs: object[], errors: object[], stats: object|null, partial: boolean, totalFailure: boolean, aborted: boolean}}
 */
export function normalizeLaneResult(value) {
  if (value == null || Array.isArray(value)) {
    return {
      jobs: value ?? [], errors: [], stats: null, units: [],
      partial: false, totalFailure: false, aborted: false,
    };
  }
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const units = Array.isArray(value.units) ? value.units : [];
  const stats = value.stats && typeof value.stats === 'object' ? value.stats : null;

  const failed = Number(
    stats?.boardsFailed
    ?? (stats && 'boardsFailed' in stats ? 0 : errors.length),
  );
  const abortedBoards = Number(stats?.boardsAborted ?? 0);
  const aborted = Boolean(stats?.aborted) || abortedBoards > 0;
  const incomplete = Number(stats?.boardsIncomplete ?? 0);

  let completed;
  if (stats && stats.boardsCompleted != null) {
    completed = Number(stats.boardsCompleted);
  } else if (stats && stats.scanned != null) {
    // Legacy shape: infer successful boards from scanned minus failures/aborts.
    completed = Math.max(0, Number(stats.scanned) - failed - abortedBoards - incomplete);
  } else {
    completed = 0;
  }

  // Independent of filtered job count: an empty successful board still counts.
  // Incomplete boards (provider truncated after error) are never "completed".
  const totalFailure = completed === 0 && incomplete === 0 && (failed > 0 || aborted);
  const partial = !totalFailure && (failed > 0 || aborted || incomplete > 0);

  const unitPartial = units.some((u) => u.status && u.status !== 'complete');
  return {
    jobs, errors, stats, units,
    partial: partial || unitPartial,
    totalFailure, aborted, completed, failed, incomplete,
  };
}

// `target.push(...items)` puts one argument on the stack per element, so a lane
// returning six figures of postings overflows it. Lane output is unbounded by
// nature — append one at a time.
function pushAll(target, items) {
  for (const item of items ?? []) target.push(item);
  return target;
}

function formatBoardErrors(name, errors) {
  const sample = errors.slice(0, 5).map((e) => e.board || e.message || 'board').join(', ');
  const more = errors.length > 5 ? ` (+${errors.length - 5} more)` : '';
  return `source "${name}" had ${errors.length} board error(s): ${sample}${more}`;
}

function formatAbort(name, { completed, totalFailure }) {
  if (totalFailure) {
    return `source "${name}" aborted at collection deadline with no completed boards`;
  }
  return `source "${name}" aborted at collection deadline after ${completed} completed board(s)`;
}

/**
 * @param {{name: string, run: () => Promise<object[]|{jobs?: object[], errors?: object[], stats?: object}|void>}[]} lanes
 * @returns {Promise<{jobs: object[], sources: string[], failed: string[], warnings: string[], timings: Record<string, number>}>}
 */
export async function runLanes(lanes) {
  const started = Date.now();
  const timings = {};

  const settled = await Promise.allSettled(lanes.map(async (lane) => {
    const t0 = Date.now();
    try {
      const raw = await lane.run();
      return { lane, ...normalizeLaneResult(raw) };
    } finally {
      timings[lane.name] = Date.now() - t0;
    }
  }));

  const out = { jobs: [], sources: [], failed: [], warnings: [], timings, units: [] };
  settled.forEach((result, i) => {
    const { name } = lanes[i];
    const secs = (timings[name] / 1000).toFixed(1);
    if (result.status === 'fulfilled') {
      const { jobs, errors, partial, totalFailure, aborted, completed, units } = result.value;
      pushAll(out.jobs, jobs);
      pushAll(out.units, units);
      if (totalFailure) {
        out.failed.push(name);
        if (errors.length) out.warnings.push(formatBoardErrors(name, errors));
        if (aborted) out.warnings.push(formatAbort(name, { completed, totalFailure: true }));
        if (!errors.length && !aborted) {
          out.warnings.push(`source "${name}" failed with no completed boards`);
        }
        log.error(`lane ${name} failed after ${secs}s`
          + (aborted ? ' (deadline abort)' : ` (all boards failed)`));
      } else {
        out.sources.push(name);
        if (errors.length) out.warnings.push(formatBoardErrors(name, errors));
        if (aborted) out.warnings.push(formatAbort(name, { completed, totalFailure: false }));
        if (partial) {
          log.info(`  lane ${name} finished in ${secs}s with ${jobs.length} postings`
            + `${errors.length ? `, ${errors.length} board error(s)` : ''}`
            + `${aborted ? ', aborted' : ''}`);
        } else {
          log.info(`  lane ${name} finished in ${secs}s${jobs.length ? `, ${jobs.length} postings` : ''}`);
        }
      }
    } else {
      out.failed.push(name);
      out.warnings.push(`source "${name}" failed: ${result.reason?.message ?? result.reason}`);
      log.error(`lane ${name} failed after ${secs}s: ${result.reason?.stack ?? result.reason}`);
    }
  });

  log.info(`  all lanes settled in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return out;
}
