import test from 'node:test';
import assert from 'node:assert/strict';
import { prefilter } from '../src/rank/prefilter.mjs';
import { toJob } from '../src/normalize.mjs';

const prefs = {
  targets: {
    role_terms: ['engineer*', 'scientist*'],
    title_keywords: ['machine learning', 'research'],
    exclude_titles: ['sales', 'intern'],
    preferred_levels: ['senior', 'staff'],
  },
  location: {
    allow: ['California', 'Chicago, IL'],
  },
  filters: { exclude_seniority: ['junior'], block_companies: ['BadCo'], block_content: ['security clearance'] },
};

const j = (o) => toJob({ url: 'https://boards.greenhouse.io/x/jobs/1', ...o });
const reasons = (jobs) => prefilter(jobs, prefs).rejected.map((r) => r.reason);

test('a matching role passes', () => {
  const { kept } = prefilter([j({ title: 'Senior Machine Learning Engineer', company: 'Acme', location: 'Los Angeles, CA' })], prefs);
  assert.equal(kept.length, 1);
});

test('every rejection carries a reason rather than vanishing', () => {
  const { rejected } = prefilter([j({ title: 'Sales Engineer', company: 'Acme', location: 'Los Angeles, CA' })], prefs);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /title excluded \(sales\)/);
});

test('a multi-location posting survives on the place you accept', () => {
  const { kept } = prefilter([j({ url: 'https://x.test/2', title: 'Machine Learning Engineer', company: 'Acme', location: 'Seattle, WA or Los Angeles, CA' })], prefs);
  assert.equal(kept.length, 1);
});

test('a place you did not list is rejected, with no block list needed', () => {
  const { rejected } = prefilter([
    j({ url: 'https://x.test/b', title: 'Machine Learning Engineer', company: 'A', location: 'Bengaluru, India' }),
    j({ url: 'https://x.test/s', title: 'Machine Learning Engineer', company: 'B', location: 'Seattle, WA' }),
  ], prefs);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /is not a place you accept/);
});

test('watchlist companies get no exemption from the title rules', () => {
  // A chemical engineer role at a company you like is still not a role you want.
  const { rejected } = prefilter([j({ title: 'Chemical Process Lead', company: 'Watched', location: 'Los Angeles, CA', watchlist: true })], prefs);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /names no target role/);
});

test('watchlist companies get no exemption from location', () => {
  const { rejected } = prefilter([j({ title: 'ML Engineer', company: 'Watched', location: 'Bengaluru, India', watchlist: true })], prefs);
  assert.equal(rejected.length, 1);
});

test('a blocked company is rejected even on the watchlist', () => {
  const { rejected } = prefilter([j({ title: 'ML Engineer', company: 'BadCo', location: 'Los Angeles, CA', watchlist: true })], prefs);
  assert.match(rejected[0].reason, /block list/);
});

test('content filters only apply when the description is actually present', () => {
  assert.equal(reasons([j({ title: 'Machine Learning Engineer', company: 'A', location: 'Remote' })]).length, 0);
  const withText = reasons([j({ title: 'Machine Learning Engineer', company: 'A', location: 'Remote', description: 'Requires an active security clearance.' })]);
  assert.match(withText[0], /content blocked/);
});

test('watchlist roles presort above equally-matching board roles', () => {
  const { kept } = prefilter([
    j({ url: 'https://x.test/board', title: 'Machine Learning Engineer', company: 'Board', location: 'Los Angeles, CA' }),
    j({ url: 'https://x.test/watch', title: 'Machine Learning Engineer', company: 'Watch', location: 'Los Angeles, CA', watchlist: true }),
  ], prefs);
  assert.equal(kept[0].company, 'Watch');
});

// ── An empty allow-list means anywhere in the US ────────────────────
// Recognising places abroad is built in, so a profile with no allow-list still
// rejects them without anyone listing foreign cities.

const anywhereUS = { targets: { role_terms: ['engineer*', 'scientist*'] }, location: { allow: [] }, filters: {} };

test('with no allow-list, a US place is accepted and a foreign one is not', () => {
  const { kept, rejected } = prefilter([
    j({ url: 'https://x.test/1', title: 'Research Engineer', company: 'A', location: 'Ann Arbor, MI' }),
    j({ url: 'https://x.test/2', title: 'Research Engineer', company: 'B', location: 'London, England' }),
    j({ url: 'https://x.test/3', title: 'Research Engineer', company: 'C', location: 'Toronto, ON, CA' }),
    j({ url: 'https://x.test/4', title: 'Research Engineer', company: 'D', location: 'Remote - US' }),
  ], anywhereUS);
  assert.deepEqual(kept.map((k) => k.company).sort(), ['A', 'D']);
  assert.equal(rejected.length, 2);
});

// ── Role gate and keyword points ────────────────────────────────────

test('a title with no role word is rejected, and says why', () => {
  const { rejected } = prefilter([j({ title: 'Warehouse Associate', company: 'Acme', location: 'Remote' })], prefs);
  assert.match(rejected[0].reason, /names no target role/);
});

test('a role word with no keyword is kept, just scored lower', () => {
  const { kept } = prefilter([
    j({ url: 'https://x.test/plain', title: 'Software Engineer', company: 'A', location: 'Remote' }),
    j({ url: 'https://x.test/specific', title: 'Machine Learning Research Engineer', company: 'B', location: 'Remote' }),
  ], prefs);
  assert.equal(kept.length, 2, 'min_keyword_score defaults to 0, so neither is hidden');
  assert.equal(kept[0].company, 'B', 'the role with more keywords presorts first');
  assert.deepEqual(kept[0].titleKeywords, ['machine learning', 'research']);
  assert.equal(kept[0].keywordScore, 2);
  assert.equal(kept[1].keywordScore, 0);
});

test('min_keyword_score hides roles below the floor, with a reason', () => {
  const strict = { ...prefs, targets: { ...prefs.targets, min_keyword_score: 1 } };
  const { kept, rejected } = prefilter([j({ title: 'Software Engineer', company: 'A', location: 'Remote' })], strict);
  assert.equal(kept.length, 0);
  assert.match(rejected[0].reason, /matched 0 keyword\(s\), below the floor of 1/);
});

test('exclusions apply to watchlist companies too', () => {
  const { rejected } = prefilter([j({ title: 'Sales Engineer', company: 'Watched', location: 'Remote', watchlist: true })], prefs);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /title excluded \(sales\)/);
});
