import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWatchlistBonus } from '../src/rank/bonus.mjs';

const j = (o) => ({ id: o.id, watchlist: false, heuristicOnly: false, score: 3, ...o });

test('a model-scored watchlist role gains the bonus and keeps its model score', () => {
  const [w, other] = applyWatchlistBonus([j({ id: 'w', watchlist: true, score: 2.7 }), j({ id: 'o', score: 2.7 })], 0.5);
  assert.equal(w.score, 3.2);
  assert.equal(w.modelScore, 2.7);
  assert.equal(w.bonus, 0.5);
  assert.equal(other.score, 2.7, 'a role not on the watchlist is untouched');
  assert.equal(other.bonus, undefined);
});

test('the bonus caps at 5', () => {
  assert.equal(applyWatchlistBonus([j({ id: 'w', watchlist: true, score: 4.8 })], 0.5)[0].score, 5);
});

test('heuristic-only and unscored roles are not given the bonus twice', () => {
  const out = applyWatchlistBonus([
    j({ id: 'h', watchlist: true, score: 3, heuristicOnly: true }),
    j({ id: 'n', watchlist: true, score: null, heuristicOnly: true }),
  ], 0.5);
  assert.equal(out[0].score, 3);
  assert.equal(out[1].score, null);
});

test('a zero or missing bonus changes nothing', () => {
  const jobs = [j({ id: 'w', watchlist: true, score: 3 })];
  assert.equal(applyWatchlistBonus(jobs, 0), jobs);
  assert.equal(applyWatchlistBonus(jobs, undefined), jobs);
});
