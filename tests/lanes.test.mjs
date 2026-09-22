import test from 'node:test';
import assert from 'node:assert/strict';
import { runLanes } from '../src/lib/lanes.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lanes run at the same time, so a run takes as long as the slowest lane', async () => {
  let inFlight = 0, peak = 0;
  const lane = (name, ms, jobs) => ({ name, run: async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight--;
    return jobs;
  } });

  const t0 = Date.now();
  const out = await runLanes([
    lane('watchlist', 120, [{ id: 'a' }]),
    lane('portfolio_boards', 120, []),
    lane('ats_sweep', 150, undefined),
    lane('linkedin', 120, [{ id: 'b' }, { id: 'c' }]),
    lane('freehire', 120, [{ id: 'd' }]),
  ]);
  const elapsed = Date.now() - t0;

  assert.equal(peak, 5, 'all five lanes were in flight together');
  assert.ok(elapsed < 400, `took ${elapsed}ms; one after another would be ~630ms`);
  assert.deepEqual(out.jobs.map((j) => j.id).sort(), ['a', 'b', 'c', 'd'], 'the merge collects every lane');
  assert.deepEqual(out.sources, ['watchlist', 'portfolio_boards', 'ats_sweep', 'linkedin', 'freehire']);
  assert.equal(Object.keys(out.timings).length, 5);
});

test('a failing lane is recorded and does not cost the others', async () => {
  const out = await runLanes([
    { name: 'freehire', run: async () => { throw new Error('API down'); } },
    { name: 'linkedin', run: async () => [{ id: 'x' }] },
  ]);
  assert.deepEqual(out.failed, ['freehire']);
  assert.deepEqual(out.sources, ['linkedin']);
  assert.deepEqual(out.jobs, [{ id: 'x' }]);
  assert.match(out.warnings[0], /source "freehire" failed: API down/);
});

test('a lane returning six figures of postings merges without overflowing the stack', async () => {
  const many = Array.from({ length: 300_000 }, (_, i) => ({ id: `j${i}` }));
  const out = await runLanes([
    { name: 'ats_dataset', run: async () => ({ jobs: many, units: many.map((_, i) => ({ key: `u${i}` })) }) },
    { name: 'linkedin', run: async () => [{ id: 'x' }] },
  ]);
  assert.equal(out.jobs.length, 300_001);
  assert.equal(out.units.length, 300_000);
  assert.deepEqual(out.failed, []);
});
