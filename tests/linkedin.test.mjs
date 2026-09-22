import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchLinkedIn, linkedinUnitKey, parseJobCards, RESULTS_PER_PAGE,
} from '../src/sources/linkedin.mjs';
import { canAdvanceCheckpoint } from '../src/state/coverage.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const COLLECTION = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };

function card(id, date = '2026-10-19') {
  return `<li>
    <a href="https://www.linkedin.com/jobs/view/${id}">x</a>
    <h3 class="base-search-card__title">Research Engineer</h3>
    <h4 class="base-search-card__subtitle">Acme</h4>
    <span class="job-search-card__location">San Francisco, CA</span>
    <time datetime="${date}">1 day ago</time>
  </li>`;
}

function page(n, date) {
  return `<ul>${Array.from({ length: n }, (_, i) => card(1000000 + i, date)).join('')}</ul>`;
}

test('parseJobCards reads a guest search list', () => {
  const cards = parseJobCards(page(2));
  assert.equal(cards.length, 2);
  assert.match(cards[0].url, /linkedin\.com\/jobs\/view\/1000000/);
});

test('checkpoints are read from query×location keys, not linkedin:lane', async () => {
  const key = linkedinUnitKey('engineer', 'San Francisco', '');
  const progress = {
    units: {
      'linkedin:lane': { coveredThrough: '2026-10-18T12:00:00.000Z' },
      [key]: { coveredThrough: '2026-09-14T12:00:00.000Z' },
    },
  };
  const urls = [];
  await searchLinkedIn({
    queries: ['engineer'], locations: ['San Francisco'], delayMs: 0, maxPages: 1, jobageDays: 1,
    now: NOW, progress, collection: COLLECTION,
    fetcher: async (url) => { urls.push(url); return { html: page(1) }; },
  });
  const tpr = Number(new URL(urls[0]).searchParams.get('f_TPR').slice(1));
  assert.equal(new URL(urls[0]).searchParams.get('sortBy'), 'DD');
  const laneWouldUse = Math.round(3 * 86400); // ~2 day overlap on a 1-day lane checkpoint is still far smaller
  assert.ok(tpr > 35 * 86400, `query checkpoint must fetch from September, got ${tpr / 86400}d`);
  assert.ok(tpr > laneWouldUse);
});

test('a fetch error does not advance the query checkpoint', async () => {
  const { units } = await searchLinkedIn({
    queries: ['engineer'], locations: ['SF'], delayMs: 0, maxPages: 2,
    now: NOW, fetcher: async () => ({ error: 'HTTP 500' }),
  });
  assert.equal(units.length, 1);
  assert.equal(units[0].status, 'failed');
  assert.equal(canAdvanceCheckpoint(units[0]), false);
  assert.match(units[0].errors[0], /HTTP 500/);
});

test('hitting maxPages on a full page is partial and advances to the oldest fetched posting', async () => {
  const { units, jobs } = await searchLinkedIn({
    queries: ['engineer'], locations: ['SF'], delayMs: 0, maxPages: 1,
    now: NOW, fetcher: async () => ({ html: page(RESULTS_PER_PAGE) }),
  });
  assert.equal(jobs.length, RESULTS_PER_PAGE);
  assert.equal(units[0].status, 'partial');
  assert.equal(canAdvanceCheckpoint(units[0]), true);
  assert.ok(units[0].coveredThrough);
  assert.match(units[0].limitations.join(' '), /max_pages/);
});

test('date-sorted results stop once cards fall outside the window', async () => {
  const urls = [];
  const { units, jobs } = await searchLinkedIn({
    queries: ['engineer'], locations: ['SF'], delayMs: 0, maxPages: 3, jobageDays: 1,
    now: NOW, fetcher: async (url) => {
      urls.push(url);
      return { html: page(RESULTS_PER_PAGE, '2026-09-01') };
    },
  });
  assert.equal(urls.length, 1, 'must stop after the first page whose oldest card is older than the window');
  assert.equal(jobs.length, RESULTS_PER_PAGE);
  assert.equal(units[0].status, 'complete');
  assert.equal(canAdvanceCheckpoint(units[0]), true);
});

test('a short last page exhausts the query and may complete', async () => {
  const { units } = await searchLinkedIn({
    queries: ['engineer'], locations: ['SF'], delayMs: 0, maxPages: 1,
    now: NOW, fetcher: async () => ({ html: page(3) }),
  });
  assert.equal(units[0].status, 'complete');
  assert.equal(canAdvanceCheckpoint(units[0]), true);
});
