import test from 'node:test';
import assert from 'node:assert/strict';
import { capPerCompany } from '../src/rank/per-company.mjs';
import { renderDigest } from '../src/digest/render.mjs';

const job = (id, company, heuristic, o = {}) => ({ id, company, companyKey: company.toLowerCase(), title: `Role ${id}`, heuristic, url: `https://x.test/${id}`, ...o });

test('keeps the best three per company, in heuristic order, and counts the rest', () => {
  // prefilter hands jobs over best heuristic first
  const jobs = [
    job('c1', 'Cohere', 90, { watchlist: true }), job('n1', 'NVIDIA', 85), job('c2', 'Cohere', 80, { watchlist: true }),
    job('c3', 'Cohere', 70, { watchlist: true }), job('c4', 'Cohere', 60, { watchlist: true }), job('n2', 'NVIDIA', 55),
    job('c5', 'Cohere', 50, { watchlist: true }), job('a1', 'Acme', 40),
  ];
  const { kept, capped } = capPerCompany(jobs, 3);
  assert.deepEqual(kept.map((j) => j.id), ['c1', 'n1', 'c2', 'c3', 'n2', 'a1'], 'order is preserved');
  assert.deepEqual(capped.map((j) => j.id), ['c4', 'c5'], 'the watchlist gets the same cap');
  assert.deepEqual(kept.filter((j) => j.company === 'Cohere').map((j) => j.moreAtCompany), [2, 2, 2]);
  assert.equal(kept.find((j) => j.id === 'n1').moreAtCompany, undefined, 'nothing more to say when all fit');
});

test('companies are grouped by folded name', () => {
  const { capped } = capPerCompany([
    job('1', 'General Motors LLC', 9, { companyKey: 'general motors' }),
    job('2', 'General Motors', 8, { companyKey: 'general motors' }),
  ], 1);
  assert.deepEqual(capped.map((j) => j.id), ['2']);
});

test('a cap of 0 keeps everything', () => {
  const jobs = [job('1', 'A', 1), job('2', 'A', 1)];
  assert.equal(capPerCompany(jobs, 0).kept, jobs);
});

test('the digest says how many more roles matched at a company', () => {
  const stats = { raw: 10, scanned: 10, collapsed: 0, filtered: 2, cappedPerCompany: 4, maxPerCompany: 3, belowThreshold: 1, minScore: 3, sources: ['x'], failedSources: [], rejectionSample: [] };
  const jobs = [{ ...job('c1', 'Cohere', 90), score: 4.2, why: 'Research engineering on model behaviour.', location: 'NYC', source: 'x', moreAtCompany: 4 }];
  const { html, text } = renderDigest({ jobs, stats, date: '2026-09-15', config: { sheet: { enabled: false }, digest: {} } });
  assert.match(html, /\+4 more matching roles/);
  assert.match(text, /Cohere \(\+4 more matching roles\)/);
  assert.match(html, /4 beyond 3 per company/);
  assert.match(text, /4 beyond 3 per company/);
});
