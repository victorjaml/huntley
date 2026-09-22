// Active boards: fetch directly the boards that have produced something worth
// showing.
//
// Relevant roles come from a small set of employers — one Workday sweep found
// roles passing your filters at 86 of 12,884 Workday boards. Those are worth
// reading every day, directly and same-day; the rest are reached through the
// downloaded dataset (ats-dataset.mjs), which also discovers new ones.
//
// The ledger learns from every run: each role that scores at or above the
// digest threshold marks its board as active (data/active-boards.json),
// whichever source found it. Scored, not merely past the prefilter — a keyword
// match at an unrelated employer would otherwise commit every future run to
// reading that employer's whole board. A board stays active for `within_days`
// after its last such role. Nothing is configured by hand, and a board that
// stops posting relevant roles ages out.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractBoards } from './funds/boards.mjs';

function load(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

/**
 * Mark the boards behind these jobs as active.
 * @param {object[]} jobs   jobs that scored at or above the threshold
 * @param {{path: string, date: string}} opts
 * @returns {number} boards newly added
 */
export function recordActiveBoards(jobs, { path, date }) {
  const ledger = load(path);
  let added = 0;
  for (const job of jobs) {
    if (job.heuristicOnly) continue;
    const board = job.board ?? extractBoards(job.url)[0];
    if (!board) continue;
    const prev = ledger[board.careers_url];
    if (!prev) added++;
    ledger[board.careers_url] = {
      vendor: board.vendor,
      // Set for systems that run on the employer's own domain, where career-ops
      // cannot tell the provider from the URL.
      ...(board.provider ? { provider: board.provider } : {}),
      // A slug name is kept only until a real one arrives.
      name: job.companySlug ? (prev?.name ?? job.company) : job.company,
      firstHit: prev?.firstHit ?? date,
      lastHit: date,
      lastScan: date,
      hits: (prev?.hits ?? 0) + (prev?.lastHit === date ? 0 : 1),
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(ledger, null, 1));
  renameSync(`${path}.tmp`, path);
  return added;
}

/**
 * Boards to fetch today.
 * @param {{path: string, withinDays?: number, today: string, exclude?: Set<string>}} opts
 * @returns {{name: string, careers_url: string, provider?: string}[]}
 */
export function activeBoards({ path, withinDays = 90, today, exclude = new Set() }) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - withinDays * 86_400_000;
  return Object.entries(load(path))
    .filter(([url]) => !exclude.has(url.toLowerCase()))
    .map(([careers_url, b]) => ({
      name: b.name,
      careers_url,
      ...(b.provider ? { provider: b.provider } : {}),
      overdue: Date.parse(`${b.lastHit}T00:00:00Z`) < cutoff,
    }));
}

/**
 * Stamp boards that were successfully scanned this run, even without a new hit.
 * Eviction uses the previous lastScan so one catch-up after a long gap does not
 * wipe every quiet board.
 */
export function markActiveBoardsScanned({ path, urls = [], date }) {
  const ledger = load(path);
  let n = 0;
  for (const url of urls) {
    const needle = String(url).replace(/\/+$/, '').toLowerCase();
    const key = Object.keys(ledger).find((u) => u.replace(/\/+$/, '').toLowerCase() === needle);
    if (!key) continue;
    ledger[key].lastScan = date;
    n++;
  }
  if (!n) return 0;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(ledger, null, 1));
  renameSync(`${path}.tmp`, path);
  return n;
}

/**
 * Remove boards past the activity TTL only after they have been scanned this run
 * and a prior scan already happened after they went quiet. Huntley downtime
 * does not count as board inactivity.
 */
export function evictInactiveBoards({ path, withinDays = 90, today, scanned = [] }) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - withinDays * 86_400_000;
  const scannedSet = new Set(scanned.map((u) => String(u).replace(/\/+$/, '').toLowerCase()));
  const ledger = load(path);
  let removed = 0;
  for (const [url, b] of Object.entries(ledger)) {
    if (Date.parse(`${b.lastHit}T00:00:00Z`) >= cutoff) continue;
    if (!scannedSet.has(url.replace(/\/+$/, '').toLowerCase())) continue;
    const prevScan = b.lastScan ?? null;
    if (!prevScan || prevScan >= today) continue;
    if (Date.parse(`${prevScan}T00:00:00Z`) < cutoff) continue;
    delete ledger[url];
    removed++;
  }
  if (!removed) return 0;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(ledger, null, 1));
  renameSync(`${path}.tmp`, path);
  return removed;
}
