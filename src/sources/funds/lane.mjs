// The fund portfolio lane: plan which boards to read, then read them.
// Board scans return jobs in memory; YC WaaS pages are fetched in-process.

import { PATHS } from '../../lib/paths.mjs';
import { log } from '../../lib/log.mjs';
import { loadWatchlist } from '../watchlist.mjs';
import { scanTracked } from '../board-collection.mjs';
import { boardHttp } from '../boards/collect.mjs';
import { planFundScan, fundsByCompany, retireDeadFundBoards } from './index.mjs';
import { fetchYcJobs } from './yc-jobs.mjs';
import { coverageUnit, unitKey } from '../../state/coverage.mjs';
import { ageDaysCeil } from '../../state/window.mjs';

/**
 * @param {object} opts
 * @param {object} opts.prefs
 * @param {object} opts.settings
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.onPlan]
 * @returns {Promise<object[]>}
 */
export async function runFundLane({
  prefs, settings = {}, dryRun = false, onPlan = () => {}, watchlistKeys = null,
  now = Date.now(), sinceMs = null, untilMs = null, progress = null, collection = null, explicitSinceMs = null, runId = null,
}) {
  const doc = loadWatchlist();
  const funds = (doc.fund_portfolios ?? []).filter((f) => f && f.enabled !== false);
  if (!funds.length) {
    log.info('  fund portfolios: none enabled in config/watchlist.yml');
    return [];
  }

  const http = boardHttp();

  const skipBoards = new Set((doc.tracked_companies ?? [])
    .filter((c) => c?.enabled !== false && c.careers_url)
    .map((c) => String(c.careers_url).replace(/\/+$/, '').toLowerCase()));

  const started = now;
  const plan = await planFundScan(funds, {
    http,
    dir: PATHS.funds,
    budgetMs: (settings.resolve_budget_seconds ?? 120) * 1000,
    concurrency: settings.resolve_concurrency ?? 16,
    skipBoards,
  });
  for (const w of plan.warnings) log.warn(`  ${w}`);
  const s = plan.stats;
  log.info(`  fund portfolios: ${s.companies} companies → ${s.boards} boards, ${s.ycPages} YC pages`
    + ` (${s.none} with no board found, ${s.dead_link ?? 0} dead links, ${s.pending + s.pendingAfterBudget} not yet resolved) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const fundMap = fundsByCompany(plan.entries, plan.waas);
  onPlan({ funds: fundMap, warnings: plan.warnings, stats: s });

  const entries = plan.entries.map(({ name, careers_url, provider }) => (
    provider ? { name, careers_url, provider } : { name, careers_url }
  ));
  const ycPages = settings.yc_pages === false ? [] : plan.waas;

  const [boardResult, yc] = await Promise.all([
    scanTracked({
      label: 'fund portfolio boards',
      entries,
      count: entries.length,
      sinceDays: settings.since_days ?? 7,
      sinceMs,
      untilMs,
      now,
      freshness: 'inventory',
      unitKind: 'fund:board',
      progress,
      collection,
      explicitSinceMs,
      runId,
      dryRun,
      prefs,
      source: 'portfolio',
      watchlistKeys,
      fundKeys: fundMap,
    }),
    ycPages.length
      ? fetchYcJobs(ycPages, {
        http,
        concurrency: settings.yc_concurrency ?? 4,
        maxAgeDays: sinceMs != null ? ageDaysCeil(sinceMs, untilMs ?? now) : (settings.yc_max_age_days ?? 30),
        deadline: now + (settings.yc_budget_seconds ?? 300) * 1000,
        now,
      })
      : { jobs: [], fetched: 0, failed: 0, skipped: 0, failedSlugs: [], skippedSlugs: [] },
  ]);
  if (ycPages.length) {
    log.info(`  YC pages: ${yc.fetched} read, ${yc.jobs.length} roles${yc.failed ? `, ${yc.failed} failed` : ''}${yc.skipped ? `, ${yc.skipped} skipped (budget)` : ''}`);
  }
  const boardJobs = boardResult?.jobs ?? [];
  const boardErrors = boardResult?.errors ?? [];
  const jobs = [...boardJobs, ...yc.jobs];
  const pending = (s.pending ?? 0) + (s.pendingAfterBudget ?? 0);
  const units = [
    coverageUnit({
      key: 'fund:discovery',
      requestedSince: sinceMs,
      requestedUntil: untilMs ?? now,
      status: pending > 0 ? 'partial' : 'complete',
      recordsFetched: s.boards ?? 0,
      limitations: pending > 0 ? [`${pending} portfolio companies not resolved (budget)`] : [],
    }),
    ...(boardResult?.units ?? []),
    ...ycPages.map((c) => coverageUnit({
      key: unitKey('fund:yc', c.ycSlug),
      requestedSince: sinceMs,
      requestedUntil: untilMs ?? now,
      status: (yc.failedSlugs ?? []).includes(c.ycSlug) ? 'failed'
        : (yc.skippedSlugs ?? []).includes(c.ycSlug) ? 'partial'
          : 'complete',
      limitations: (yc.skippedSlugs ?? []).includes(c.ycSlug) ? ['YC page skipped (budget)'] : [],
    })),
  ];
  if (!dryRun) {
    const retired = retireDeadFundBoards(PATHS.funds, units, { now: Date.now() });
    if (retired) log.info(`  funds: retired ${retired} 404 board(s) as dead_link`);
  }
  return {
    jobs,
    errors: boardErrors,
    stats: {
      ...(boardResult?.stats ?? {}),
      scanned: boardResult?.stats?.scanned ?? 0,
      kept: jobs.length,
    },
    units,
  };
}
