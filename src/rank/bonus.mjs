// The watchlist reward.
//
// A role at a watchlist company is not shown in a section of its own; it
// competes on score like everything else, and being on the watchlist earns it
// fixed points on top of the model's score. The points are added here in code,
// not asked of the model, so the reward is exact, the same every day, and shown
// on the row. The model's own score is kept alongside for the run record.
//
// Heuristic-only scores are left alone: the presort already weighs the
// watchlist, so adding the bonus again would count it twice.

/**
 * @param {object[]} jobs    ranked jobs, each with score, watchlist, heuristicOnly
 * @param {number}   bonus   points to add (rank.watchlist_bonus)
 * @returns {object[]} new job objects; watchlist roles gain modelScore and bonus
 */
export function applyWatchlistBonus(jobs, bonus) {
  const points = Number(bonus);
  if (!Number.isFinite(points) || points === 0) return jobs;
  return jobs.map((j) => (j.watchlist && j.score != null && !j.heuristicOnly
    ? { ...j, modelScore: j.score, bonus: points, score: Math.min(5, Math.round((j.score + points) * 100) / 100) }
    : j));
}
