import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFreehire } from '../src/sources/freehire.mjs';
import { canAdvanceCheckpoint } from '../src/state/coverage.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function row(i, postedAt = '2026-10-19T00:00:00Z') {
  return {
    url: `https://jobs.ashbyhq.com/acme/${i}`,
    title: 'Research Engineer',
    company_slug: 'acme',
    location: 'San Francisco, CA',
    posted_at: postedAt,
    description: 'Build evals.',
    source: 'ashby',
    reality: {},
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
  };
}

test('freehire search stays on a bounded relevance page and does not advance when truncated', async () => {
  const offsets = [];
  const { jobs, units } = await searchFreehire({
    queries: ['engineer'],
    countries: ['us'],
    limit: 2,
    maxPages: 1,
    now: NOW,
    fetcher: async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      const data = [row(0, '2026-08-19T00:00:00Z'), row(1, '2026-10-19T00:00:00Z')];
      return jsonResponse({ data, meta: { total: 80 } });
    },
  });
  assert.deepEqual(offsets, [0]);
  assert.equal(jobs.length, 2);
  assert.equal(units[0].status, 'partial');
  assert.equal(units[0].coveredThrough, null);
  assert.equal(canAdvanceCheckpoint(units[0]), false);
  assert.match(units[0].limitations.join(' '), /relevance/);
});

test('an exhausted freehire page may complete', async () => {
  const { units, jobs } = await searchFreehire({
    queries: ['engineer'],
    countries: ['us'],
    limit: 40,
    maxPages: 1,
    now: NOW,
    fetcher: async () => jsonResponse({ data: [row(0), row(1)], meta: { total: 2 } }),
  });
  assert.equal(jobs.length, 2);
  assert.equal(units[0].status, 'complete');
  assert.equal(canAdvanceCheckpoint(units[0]), true);
});

test('catch-up bootstrap clamps posted_within_days to since_days and reports the uncovered tail', async () => {
  const seenDays = [];
  const { units } = await searchFreehire({
    queries: ['research engineer'],
    countries: ['us'],
    sinceDays: 2,
    limit: 40,
    maxPages: 1,
    now: NOW,
    collection: { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 },
    progress: { units: {} },
    fetcher: async (url) => {
      seenDays.push(Number(new URL(url).searchParams.get('posted_within_days')));
      return jsonResponse({ data: [row(0), row(1)], meta: { total: 2 } });
    },
  });
  assert.deepEqual(seenDays, [2], 'relevance search must not ask the API for the 32-day bootstrap');
  assert.equal(units[0].status, 'partial');
  assert.equal(units[0].coveredThrough, null);
  assert.equal(canAdvanceCheckpoint(units[0]), false);
  assert.ok(Date.parse(units[0].requestedSince) < NOW - 30 * 86_400_000);
  assert.match(units[0].limitations.join(' '), /uncovered/);
});
